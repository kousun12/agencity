import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { serializeScratch, type ScratchCheckpointSource } from "../../src/console/index.ts";
import { ExecutionLeaseService, Supervisor } from "../../src/runtime/index.ts";
import { LibSqlScratchStore, LibSqlStorage } from "../../src/storage/libsql.ts";
import { SCRATCH_STORE_LIMITS } from "../../src/storage/scratch.ts";
import type {
  ProcessExecutionLeaseRecord,
  ProcessExecutionWriteFence,
} from "../../src/storage/index.ts";
import {
  fixtureAgentProfile,
  makeTempRuntime,
  removeTempRuntime,
  seedSession,
  type TempRuntime,
} from "../helpers.ts";

const temps: TempRuntime[] = [];
const closeables: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const closeable of closeables.splice(0).reverse()) closeable.close();
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

function fence(
  workspace: ProcessExecutionLeaseRecord,
  root: ProcessExecutionLeaseRecord,
): ProcessExecutionWriteFence {
  return { workspace: leaseProof(workspace), root: leaseProof(root) };
}

function leaseProof(lease: ProcessExecutionLeaseRecord) {
  return {
    scope: lease.scope,
    ownerDeviceId: lease.ownerDeviceId,
    ownerProcessId: lease.ownerProcessId,
    fenceToken: lease.fenceToken,
    now: new Date().toISOString(),
  };
}

async function commitCell(
  storage: LibSqlStorage,
  sessionId: string,
  branchId: string,
  cellId: string,
  writeFence: ProcessExecutionWriteFence,
): Promise<ScratchCheckpointSource> {
  const committed = await storage.appendEvents([{
    sessionId,
    branchId,
    type: "CellProposed",
    producer: "console",
    idempotencyKey: `proposed:${cellId}`,
    payload: { cellId, code: "null", dependencies: [] },
  }, {
    sessionId,
    branchId,
    type: "CellStarted",
    producer: "console",
    idempotencyKey: `started:${cellId}`,
    payload: { cellId, attempt: 1 },
  }, {
    sessionId,
    branchId,
    type: "CellCommitted",
    producer: "console",
    idempotencyKey: `committed:${cellId}`,
    payload: {
      cellId,
      result: null,
      logs: [],
      logStreams: [],
      durationMs: 1,
      exports: [],
    },
  }], writeFence);
  const event = committed.at(-1)!;
  return { cellId, eventId: event.id, cursor: event.cursor };
}

async function fixture(options: {
  now?: () => Date;
  maxBranches?: number;
  maxWorkspaceBytes?: number;
} = {}) {
  const temp = await makeTempRuntime("agencity-scratch-store-");
  temps.push(temp);
  const storage = new LibSqlStorage({ url: temp.databaseUrl, deviceId: "device-1" });
  closeables.push(storage);
  await storage.migrate();
  const session = await seedSession(storage, { workspaceId: "workspace-1" });
  const leases = new ExecutionLeaseService(storage, {
    ownerProcessId: "service-1",
    ownerDeviceId: "device-1",
    leaseMs: 30_000,
  });
  const workspace = await leases.claim({ kind: "workspace", workspaceId: "workspace-1" });
  const root = await leases.claim({ kind: "root", rootSessionId: session.sessionId });
  const writeFence = fence(workspace, root);
  const store = new LibSqlScratchStore({
    url: temp.databaseUrl,
    deviceId: "device-1",
    ...options,
  });
  closeables.push(store);
  return { temp, storage, store, leases, workspace, root, writeFence, ...session };
}

describe("file-local scratch store", () => {
  test("keeps the private cache file-local with fixed workspace quotas", () => {
    expect(SCRATCH_STORE_LIMITS).toEqual({
      ttlMs: 7 * 24 * 60 * 60 * 1_000,
      maxBranches: 64,
      maxWorkspaceBytes: 16 * 1024 * 1024,
    });
    expect(() => new LibSqlScratchStore({
      url: "libsql://remote.example.invalid/workspace",
      deviceId: "device-1",
    })).toThrow(/exact file:/i);
    expect(() => new LibSqlScratchStore({
      url: "file::memory:",
      deviceId: "device-1",
    })).toThrow(/exact file:/i);
    expect(() => new LibSqlScratchStore({
      url: "file://remote.example.invalid/workspace.db",
      deviceId: "device-1",
    })).toThrow(/exact file:/i);
  });

  test("explicit file-local managed composition restores exact branches", async () => {
    const temp = await makeTempRuntime("agencity-scratch-product-");
    temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      restartConsoleAfterCell: true,
      enableLocalScratchCheckpoints: true,
      recover: false,
      startWakeSchedulers: false,
      executionLease: {
        workspaceId: "workspace-managed",
        ownerProcessId: "scratch-product-service",
        leaseMs: 30_000,
        renewalIntervalMs: 10_000,
      },
    });
    try {
      const session = await supervisor.createSession({ workspaceId: "workspace-managed" });
      await supervisor.executeCell(
        session.sessionId,
        session.branchId,
        `scratch.index = { files: ["a.ts"] }; ({ saved: true })`,
      );
      const restored = await supervisor.executeCell(
        session.sessionId,
        session.branchId,
        `({ index: scratch.index, status: await sdk.scratch.status() })`,
      );
      expect(restored.result).toMatchObject({
        index: { files: ["a.ts"] },
        status: {
          temperature: "restored",
          cache: { available: true, status: "restored", lastWrite: null },
        },
      });
      const raw = createClient({ url: temp.databaseUrl });
      try {
        await raw.execute({
          sql: "UPDATE console_scratch_cache SET row_integrity_digest=? WHERE session_id=? AND branch_id=?",
          args: ["f".repeat(64), session.sessionId, session.branchId],
        });
      } finally {
        raw.close();
      }
      const corrupted = await supervisor.executeCell(
        session.sessionId,
        session.branchId,
        `({ hasIndex: "index" in scratch, status: await sdk.scratch.status() })`,
      );
      expect(corrupted.result).toMatchObject({
        hasIndex: false,
        status: {
          temperature: "cold",
          cache: { available: true, status: "corrupt", reason: "row_integrity" },
        },
      });

      const events = await supervisor.storage.loadEvents(session.sessionId, {
        branchId: session.branchId,
      });
      const fork = await supervisor.fork(
        session.sessionId,
        session.branchId,
        events.at(-1)!.cursor,
      );
      const forked = await supervisor.executeCell(
        session.sessionId,
        fork,
        `({ hasIndex: "index" in scratch, status: await sdk.scratch.status() })`,
      );
      expect(forked.result).toMatchObject({
        hasIndex: false,
        status: { temperature: "cold", cache: { status: "cold" } },
      });
    } finally {
      await supervisor.close();
    }
  });

  test("restores a same-device checkpoint after managed supervisor recovery without replay", async () => {
    const temp = await makeTempRuntime("agencity-scratch-recovery-");
    temps.push(temp);
    const options = {
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
      startWakeSchedulers: false,
      enableLocalScratchCheckpoints: true,
      executionLease: {
        workspaceId: "workspace-recovery",
        leaseMs: 30_000,
        renewalIntervalMs: 10_000,
      },
    } as const;
    const first = await Supervisor.open({
      ...options,
      executionLease: {
        ...options.executionLease,
        ownerProcessId: "scratch-recovery-first",
      },
    });
    const session = await first.createSession({ workspaceId: "workspace-recovery" });
    await first.executeCell(
      session.sessionId,
      session.branchId,
      `scratch.recovered = { from: "checkpoint" }; null`,
    );
    await first.close();

    const second = await Supervisor.open({
      ...options,
      executionLease: {
        ...options.executionLease,
        ownerProcessId: "scratch-recovery-second",
      },
    });
    try {
      const restored = await second.executeCell(
        session.sessionId,
        session.branchId,
        `({ recovered: scratch.recovered, status: await sdk.scratch.status() })`,
      );
      expect(restored.result).toMatchObject({
        recovered: { from: "checkpoint" },
        status: { temperature: "restored", cache: { status: "restored" } },
      });
      const events = await second.storage.loadEvents(session.sessionId, {
        branchId: session.branchId,
      });
      expect(events.filter((event) => event.type === "CellCommitted")).toHaveLength(2);
    } finally {
      await second.close();
    }
  });

  test("migrates idempotently and restores only an exact, intact source checkpoint", async () => {
    const value = await fixture();
    await value.storage.migrate();
    const source = await commitCell(
      value.storage,
      value.sessionId,
      value.branchId,
      "cell-1",
      value.writeFence,
    );
    const candidate = serializeScratch({ rows: [{ id: 1 }], count: 1 });
    expect(await value.store.write(
      value,
      candidate,
      source,
      value.writeFence,
    )).toEqual({ status: "stored", unchangedPayload: false });
    expect(await value.store.load(value, value.writeFence)).toMatchObject({
      status: "restored",
      restore: {
        candidate: {
          values: { count: 1, rows: [{ id: 1 }] },
          digest: candidate.digest,
        },
        sourceCellId: "cell-1",
      },
    });
    const source2 = await commitCell(
      value.storage,
      value.sessionId,
      value.branchId,
      "cell-2",
      value.writeFence,
    );
    expect(await value.store.write(
      value,
      candidate,
      source2,
      value.writeFence,
    )).toEqual({ status: "stored", unchangedPayload: true });
    await expect(value.storage.readonlyQuery({
      sql: "SELECT * FROM console_scratch_cache",
      args: [],
    })).rejects.toThrow(/private runtime table/i);
  });

  test("discards device-mismatched and corrupt rows with visible results", async () => {
    const value = await fixture();
    const source = await commitCell(
      value.storage,
      value.sessionId,
      value.branchId,
      "cell-integrity",
      value.writeFence,
    );
    await value.store.write(value, serializeScratch({ safe: true }), source, value.writeFence);
    const raw = createClient({ url: value.temp.databaseUrl });
    closeables.push(raw);
    await raw.execute({
      sql: "UPDATE console_scratch_cache SET device_id='other-device' WHERE session_id=?",
      args: [value.sessionId],
    });
    expect(await value.store.load(value, value.writeFence)).toEqual({
      status: "unavailable",
      reason: "device_mismatch",
    });
    expect((await raw.execute("SELECT count(*) AS count FROM console_scratch_cache")).rows[0]?.count)
      .toBe(0);

    expect(await value.store.write(
      value,
      serializeScratch({ stale: true }),
      source,
      value.writeFence,
    )).toEqual({ status: "stale" });
    const source2 = await commitCell(
      value.storage,
      value.sessionId,
      value.branchId,
      "cell-integrity-2",
      value.writeFence,
    );
    await value.store.write(
      value,
      serializeScratch({ safe: true }),
      source2,
      value.writeFence,
    );
    await raw.execute({
      sql: "UPDATE console_scratch_cache SET checkpoint_json='{}' WHERE session_id=?",
      args: [value.sessionId],
    });
    expect(await value.store.load(value, value.writeFence)).toEqual({
      status: "corrupt",
      reason: "row_integrity",
    });
    expect((await raw.execute("SELECT count(*) AS count FROM console_scratch_cache")).rows[0]?.count)
      .toBe(0);

    const source3 = await commitCell(
      value.storage,
      value.sessionId,
      value.branchId,
      "cell-integrity-3",
      value.writeFence,
    );
    const candidate = serializeScratch({ safe: true });
    await value.store.write(value, candidate, source3, value.writeFence);
    await raw.execute({
      sql: "UPDATE console_scratch_cache SET row_integrity_digest=? WHERE session_id=?",
      args: ["e".repeat(64), value.sessionId],
    });
    const source4 = await commitCell(
      value.storage,
      value.sessionId,
      value.branchId,
      "cell-integrity-4",
      value.writeFence,
    );
    expect(await value.store.write(
      value,
      candidate,
      source4,
      value.writeFence,
    )).toEqual({ status: "stored", unchangedPayload: false });
    expect((await value.store.load(value, value.writeFence)).status).toBe("restored");
  });

  test("rejects stale fences and non-latest sources transactionally", async () => {
    const value = await fixture();
    const source1 = await commitCell(
      value.storage,
      value.sessionId,
      value.branchId,
      "cell-1",
      value.writeFence,
    );
    await value.store.write(value, serializeScratch({ version: 1 }), source1, value.writeFence);
    const source2 = await commitCell(
      value.storage,
      value.sessionId,
      value.branchId,
      "cell-2",
      value.writeFence,
    );
    await expect(value.store.write(
      value,
      serializeScratch({ stale: true }),
      source1,
      value.writeFence,
    )).rejects.toThrow(/latest direct-branch/i);
    expect(await value.store.clear(value, source2, value.writeFence)).toEqual({
      status: "cleared",
    });
    expect(await value.store.write(
      value,
      serializeScratch({ resurrected: true }),
      source2,
      value.writeFence,
    )).toEqual({ status: "stale" });
    expect(await value.store.load(value, value.writeFence)).toEqual({ status: "cold" });

    const staleFence = {
      ...value.writeFence,
      root: { ...value.writeFence.root!, fenceToken: value.writeFence.root!.fenceToken + 1 },
    };
    await expect(value.store.load(value, staleFence)).rejects.toMatchObject({
      code: "EXECUTION_OWNERSHIP_CONFLICT",
    });
  });

  test("enforces expiry and branch-count LRU quotas", async () => {
    let clock = Date.now();
    const value = await fixture({ now: () => new Date(clock), maxBranches: 2 });
    const source1 = await commitCell(
      value.storage,
      value.sessionId,
      value.branchId,
      "cell-root",
      value.writeFence,
    );
    await value.store.write(value, serializeScratch({ owner: "root" }), source1, value.writeFence);

    const createCachedSession = async (suffix: string) => {
      const session = { sessionId: `session-${suffix}`, branchId: "main" };
      await value.storage.appendEvents([{
        id: `${session.sessionId}-created`,
        sessionId: session.sessionId,
        branchId: session.branchId,
        type: "SessionCreated",
        producer: "supervisor",
        idempotencyKey: `session:${session.sessionId}`,
        payload: {
          workspaceId: "workspace-1",
          initialBranchId: session.branchId,
          model: { provider: "echo", model: "echo-1", reasoningEffort: "provider-default" },
          budget: {},
          agentProfile: fixtureAgentProfile(session.sessionId),
        },
      }], { workspace: leaseProof(value.workspace) });
      const root = await value.leases.claim({ kind: "root", rootSessionId: session.sessionId });
      const scopedFence = fence(value.workspace, root);
      const source = await commitCell(
        value.storage,
        session.sessionId,
        session.branchId,
        `cell-${suffix}`,
        scopedFence,
      );
      clock += 1_000;
      await value.store.write(session, serializeScratch({ owner: suffix }), source, scopedFence);
      return { ...session, fence: scopedFence, source };
    };

    const second = await createCachedSession("second");
    clock += 1;
    await value.store.load(value, value.writeFence);
    clock += 1_000;
    const third = await createCachedSession("third");
    expect(await value.store.load(second, second.fence)).toEqual({ status: "cold" });
    expect(await value.store.write(
      second,
      serializeScratch({ resurrected: "lru" }),
      second.source,
      second.fence,
    )).toEqual({ status: "stale" });
    expect((await value.store.load(value, value.writeFence)).status).toBe("restored");
    expect((await value.store.load(third, third.fence)).status).toBe("restored");

    clock += 7 * 24 * 60 * 60 * 1_000 + 1;
    expect(await value.store.load(third, third.fence)).toEqual({ status: "cold" });
    expect(await value.store.write(
      third,
      serializeScratch({ resurrected: "expired" }),
      third.source,
      third.fence,
    )).toEqual({ status: "stale" });
  });

  test("rejects a row that cannot fit the workspace byte quota", async () => {
    const value = await fixture({ maxWorkspaceBytes: 128 });
    const source = await commitCell(
      value.storage,
      value.sessionId,
      value.branchId,
      "cell-byte-quota",
      value.writeFence,
    );
    await expect(value.store.write(
      value,
      serializeScratch({ payload: "x".repeat(256) }),
      source,
      value.writeFence,
    )).rejects.toThrow(/workspace cache quota/i);
    expect(await value.store.load(value, value.writeFence)).toEqual({ status: "cold" });
  });

  test("independent-session erasure removes exact scratch rows", async () => {
    const value = await fixture();
    const source = await commitCell(
      value.storage,
      value.sessionId,
      value.branchId,
      "cell-delete",
      value.writeFence,
    );
    await value.store.write(value, serializeScratch({ disposable: true }), source, value.writeFence);
    value.store.close();
    closeables.splice(closeables.indexOf(value.store), 1);
    const erased = await value.storage.eraseIndependentSession(value.sessionId);
    expect(erased.deletedRows.console_scratch_cache).toBe(1);
    const raw = createClient({ url: value.temp.databaseUrl });
    closeables.push(raw);
    expect((await raw.execute("SELECT count(*) AS count FROM console_scratch_cache")).rows[0]?.count)
      .toBe(0);
  });
});

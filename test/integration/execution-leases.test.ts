import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { LibSqlStorage } from "../../src/storage/index.ts";
import { ExecutionLeaseService, ManagedExecutionLeaseCoordinator, createFencedAgentStorage } from "../../src/runtime/execution-leases.ts";
import { AgentService } from "../../src/runtime/agents.ts";
import { fixtureAgentProfile, makeTempRuntime, removeTempRuntime, seedSession, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
const storages: LibSqlStorage[] = [];
afterEach(async () => {
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

async function temp(prefix: string): Promise<TempRuntime> {
  const value = await makeTempRuntime(prefix);
  temps.push(value);
  return value;
}

async function storage(value: TempRuntime, deviceId = "device-1"): Promise<LibSqlStorage> {
  const valueStorage = new LibSqlStorage({ url: value.databaseUrl, deviceId });
  await valueStorage.migrate();
  storages.push(valueStorage);
  return valueStorage;
}

describe("process execution lease migration and retention", () => {
  test("upgrades a version-7 database and retains released rows and fence tokens across reopen", async () => {
    const value = await temp("agencity-process-lease-migration-");
    const legacy = createClient({ url: value.databaseUrl });
    await legacy.execute("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
    for (let version = 1; version <= 7; version++) {
      const name = (await Array.fromAsync(new Bun.Glob(`${String(version).padStart(3, "0")}_*.sql`).scan("src/storage/migrations")))[0];
      if (!name) throw new Error(`Missing migration ${version}`);
      await legacy.executeMultiple(await Bun.file(`src/storage/migrations/${name}`).text());
      await legacy.execute({
        sql: "INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)",
        args: [version, name, "2026-08-01T00:00:00.000Z"],
      });
    }
    legacy.close();

    const first = await storage(value);
    expect(first.capabilities).toMatchObject({
      sameDeviceProcessFencing: true,
      distributedLeases: false,
    });
    let now = new Date("2026-08-06T00:00:00.000Z");
    const owner = new ExecutionLeaseService(first, {
      ownerProcessId: "process-a",
      now: () => new Date(now),
      leaseMs: 1_000,
    });
    const acquired = await owner.claim({ kind: "workspace", workspaceId: "workspace-1" });
    expect(acquired.fenceToken).toBe(1);
    const released = await owner.release(acquired);
    expect(released.releasedAt).toBe(now.toISOString());
    first.close();
    storages.splice(storages.indexOf(first), 1);

    const reopened = await storage(value);
    const retained = await reopened.getProcessExecutionLease({ kind: "workspace", workspaceId: "workspace-1" });
    expect(retained).toMatchObject({ fenceToken: 1, ownerProcessId: "process-a", releasedAt: now.toISOString() });
    now = new Date("2026-08-06T00:00:00.100Z");
    const nextOwner = new ExecutionLeaseService(reopened, {
      ownerProcessId: "process-b",
      now: () => new Date(now),
      leaseMs: 1_000,
    });
    expect((await nextOwner.claim({ kind: "workspace", workspaceId: "workspace-1" })).fenceToken).toBe(2);
    await reopened.migrate();
    expect((await reopened.getProcessExecutionLease({ kind: "workspace", workspaceId: "workspace-1" }))?.fenceToken).toBe(2);
  });
});

describe("transactional process execution fencing", () => {
  test("elects exactly one winner across independent LibSQL connections", async () => {
    const value = await temp("agencity-process-lease-concurrency-");
    const bootstrap = await storage(value);
    bootstrap.close();
    storages.splice(storages.indexOf(bootstrap), 1);

    const contenders = Array.from({ length: 8 }, (_, index) => {
      const contenderStorage = new LibSqlStorage({ url: value.databaseUrl, deviceId: "device-1" });
      storages.push(contenderStorage);
      return new ExecutionLeaseService(contenderStorage, {
        ownerProcessId: `process-${index}`,
        now: () => new Date("2026-08-06T01:00:00.000Z"),
        leaseMs: 10_000,
      });
    });
    const outcomes = await Promise.allSettled(
      contenders.map((contender) => contender.claim({ kind: "workspace", workspaceId: "workspace-1" })),
    );
    const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const losers = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    for (const loser of losers) {
      if (loser.status === "rejected") {
        expect(loser.reason).toMatchObject({ code: "EXECUTION_OWNERSHIP_CONFLICT" });
      }
    }
    if (winners[0]?.status === "fulfilled") expect(winners[0].value.fenceToken).toBe(1);
  });

  test("increments the token on expiry takeover and rejects every stale renew or release", async () => {
    const value = await temp("agencity-process-lease-takeover-");
    const store = await storage(value);
    let nowMs = Date.parse("2026-08-06T02:00:00.000Z");
    const clock = () => new Date(nowMs);
    const first = new ExecutionLeaseService(store, { ownerProcessId: "process-a", now: clock, leaseMs: 1_000 });
    const second = new ExecutionLeaseService(store, { ownerProcessId: "process-b", now: clock, leaseMs: 1_000 });
    const scope = { kind: "workspace" as const, workspaceId: "workspace-1" };

    const tokenOne = await first.claim(scope);
    await expect(second.claim(scope)).rejects.toMatchObject({
      code: "EXECUTION_OWNERSHIP_CONFLICT",
      details: { reason: "active_owner", currentFenceToken: 1 },
    });
    nowMs += 1_001;
    const tokenTwo = await second.claim(scope);
    expect(tokenTwo.fenceToken).toBe(2);
    await expect(first.renew(tokenOne)).rejects.toMatchObject({
      code: "EXECUTION_OWNERSHIP_CONFLICT",
      details: { reason: "stale_fence_owner_or_expiry", currentFenceToken: 2 },
    });
    await expect(first.release(tokenOne)).rejects.toMatchObject({ code: "EXECUTION_OWNERSHIP_CONFLICT" });

    const renewed = await second.renew(tokenTwo);
    expect(renewed).toMatchObject({ fenceToken: 2, ownerProcessId: "process-b", releasedAt: null });
    const released = await second.release(renewed);
    expect(released.fenceToken).toBe(2);
    await expect(second.release(renewed)).rejects.toMatchObject({ code: "EXECUTION_OWNERSHIP_CONFLICT" });
    const tokenThree = await first.claim(scope);
    expect(tokenThree.fenceToken).toBe(3);
  });

  test("enforces workspace/root overlap while allowing independently fenced roots", async () => {
    const value = await temp("agencity-process-lease-scopes-");
    const store = await storage(value);
    await seedSession(store, { sessionId: "root-a", workspaceId: "workspace-1" });
    await seedSession(store, { sessionId: "root-b", workspaceId: "workspace-1" });
    const now = () => new Date("2026-08-06T03:00:00.000Z");
    const first = new ExecutionLeaseService(store, { ownerProcessId: "process-a", now });
    const second = new ExecutionLeaseService(store, { ownerProcessId: "process-b", now });

    const rootA = await first.claim({ kind: "root", rootSessionId: "root-a" });
    const rootB = await second.claim({ kind: "root", rootSessionId: "root-b" });
    expect(rootA.workspaceId).toBe("workspace-1");
    expect(rootB.workspaceId).toBe("workspace-1");
    await expect(first.claim({ kind: "workspace", workspaceId: "workspace-1" })).rejects.toMatchObject({
      code: "EXECUTION_OWNERSHIP_CONFLICT",
      details: { reason: "overlapping_scope_owned" },
    });
    await first.release(rootA);
    await second.release(rootB);
    const workspace = await first.claim({ kind: "workspace", workspaceId: "workspace-1" });
    await expect(second.claim({ kind: "root", rootSessionId: "root-b" })).rejects.toMatchObject({
      code: "EXECUTION_OWNERSHIP_CONFLICT",
      details: { reason: "overlapping_scope_owned", currentFenceToken: workspace.fenceToken },
    });
  });

  test("refuses a root owned by a remote device without inventing failover", async () => {
    const value = await temp("agencity-process-lease-device-");
    const store = await storage(value, "local-device");
    await store.appendEvents([{
      id: "remote-root-created",
      sessionId: "remote-root",
      branchId: "main",
      type: "SessionCreated",
      producer: "sync",
      idempotencyKey: "remote-root-created",
      committedAt: "2026-08-06T04:00:00.000Z",
      originDeviceId: "remote-device",
      originSequence: 1,
      payload: {
        workspaceId: "workspace-1",
        initialBranchId: "main",
        model: { provider: "echo", model: "echo", reasoningEffort: "provider-default" },
        budget: {},
        agentProfile: fixtureAgentProfile("remote-root"),
      },
    }]);
    const service = new ExecutionLeaseService(store, {
      ownerDeviceId: "local-device",
      ownerProcessId: "local-process",
      now: () => new Date("2026-08-06T04:00:01.000Z"),
    });
    await expect(service.claim({ kind: "root", rootSessionId: "remote-root" })).rejects.toMatchObject({
      code: "EXECUTION_OWNERSHIP_CONFLICT",
      details: {
        reason: "device_owner_mismatch",
        requestedOwnerDeviceId: "local-device",
        currentOwnerDeviceId: "remote-device",
        distributedLeases: false,
      },
    });
    expect(await service.get({ kind: "root", rootSessionId: "remote-root" })).toBeNull();
  });

  test("fences one atomic child admission whose later events target the staged child session", async () => {
    const value = await temp("agencity-process-lease-staged-child-");
    const store = await storage(value);
    await seedSession(store, { sessionId: "root-staged", workspaceId: "workspace-1" });
    const coordinator = await ManagedExecutionLeaseCoordinator.open(store, {
      workspaceId: "workspace-1",
      ownerProcessId: "managed-staged-child",
      leaseMs: 10_000,
      renewalIntervalMs: 9_000,
    });
    try {
      const fenced = createFencedAgentStorage(store, coordinator);
      const child = await new AgentService(fenced).spawn("root-staged", "main", { task: "atomic child", name: "staged-child" });
      expect(coordinator.rootSessionIds).toEqual(["root-staged"]);
      expect(await store.getSession(child.sessionId)).toMatchObject({ rootSessionId: "root-staged", parentSessionId: "root-staged" });
      expect((await store.loadEvents(child.sessionId, { branchId: child.branchId })).map(event => event.type)).toEqual(["SessionCreated", "MessageAppended"]);
    } finally { await coordinator.close(); }
  });

  test("renews a near-expiry workspace lease synchronously before a fenced write", async () => {
    const value = await temp("agencity-process-lease-prewrite-renewal-");
    const store = await storage(value);
    await seedSession(store, {
      sessionId: "root-prewrite-renewal",
      workspaceId: "workspace-1",
    });
    const startedAt = new Date();
    let now = startedAt;
    const coordinator = await ManagedExecutionLeaseCoordinator.open(store, {
      workspaceId: "workspace-1",
      ownerProcessId: "managed-prewrite-renewal",
      leaseMs: 1_000,
      renewalIntervalMs: 900,
      now: () => now,
    });
    try {
      const fenced = createFencedAgentStorage(store, coordinator);
      now = new Date(startedAt.getTime() + 950);
      await fenced.appendEvents([{
        sessionId: "root-prewrite-renewal",
        branchId: "main",
        type: "MessageAppended",
        producer: "client",
        payload: {
          messageId: "message-prewrite-renewal",
          role: "user",
          content: "renew before committing",
        },
      }]);
      expect(await store.getProcessExecutionLease({
        kind: "workspace",
        workspaceId: "workspace-1",
      })).toMatchObject({
        ownerProcessId: "managed-prewrite-renewal",
        renewedAt: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + 1_000).toISOString(),
      });
    } finally {
      await coordinator.close();
    }
  });

  test("rejects malformed clocks, durations, scopes, and cross-owner handles", async () => {
    const value = await temp("agencity-process-lease-adversarial-");
    const store = await storage(value);
    const invalidClock = new ExecutionLeaseService(store, {
      ownerProcessId: "process-invalid-clock",
      now: () => new Date(Number.NaN),
    });
    expect(() => invalidClock.claim({ kind: "workspace", workspaceId: "workspace-1" })).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    const first = new ExecutionLeaseService(store, {
      ownerProcessId: "process-a",
      now: () => new Date("2026-08-06T05:00:00.000Z"),
    });
    expect(() => first.claim({ kind: "workspace", workspaceId: "workspace-1" }, 0)).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    await expect(first.claim({ kind: "workspace", workspaceId: "   " })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(store.readonlyQuery({ sql: "SELECT * FROM process_execution_leases", args: [] })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    const lease = await first.claim({ kind: "workspace", workspaceId: "workspace-1" });
    const second = new ExecutionLeaseService(store, {
      ownerProcessId: "process-b",
      now: () => new Date("2026-08-06T05:00:00.000Z"),
    });
    expect(() => second.renew(lease)).toThrow(expect.objectContaining({
      code: "EXECUTION_OWNERSHIP_CONFLICT",
      details: expect.objectContaining({ reason: "handle_owner_mismatch" }),
    }));
  });
});

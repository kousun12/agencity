import { afterEach, describe, expect, test } from "bun:test";
import { createClient, type Client, type Transaction } from "@libsql/client";
import { LibSqlStorage } from "../../src/storage/index.ts";
import { makeTempRuntime, removeTempRuntime, seedSession, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
const storages: LibSqlStorage[] = [];
const clients: Client[] = [];
const transactions: Transaction[] = [];

afterEach(async () => {
  for (const tx of transactions.splice(0)) {
    if (!tx.closed) await tx.rollback().catch(() => {});
    tx.close();
  }
  for (const client of clients.splice(0)) client.close();
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

async function setup(prefix: string): Promise<{ temp: TempRuntime; storage: LibSqlStorage }> {
  const temp = await makeTempRuntime(prefix);
  temps.push(temp);
  const storage = new LibSqlStorage({ url: temp.databaseUrl, deviceId: "contention-test-device" });
  storages.push(storage);
  await storage.migrate();
  return { temp, storage };
}

async function holdWriteLock(databaseUrl: string): Promise<Transaction> {
  const client = createClient({ url: databaseUrl });
  clients.push(client);
  await client.execute("PRAGMA busy_timeout=0");
  const tx = await client.transaction("write");
  transactions.push(tx);
  await tx.execute("UPDATE device_clocks SET next_sequence=next_sequence");
  return tx;
}

function message(index: string) {
  return {
    id: `event-${index}`,
    sessionId: "contention-root",
    branchId: "main",
    type: "MessageAppended" as const,
    producer: "test",
    idempotencyKey: `message-${index}`,
    committedAt: "2026-08-06T00:00:01.000Z",
    payload: { messageId: `message-${index}`, role: "user" as const, content: index },
  };
}

describe("LibSQL contention boundaries", () => {
  test("uses WAL and converges process-style concurrent appends without duplicates or raw LibSQL errors", async () => {
    const { temp, storage } = await setup("agencity-libsql-process-contention-");
    const pragma = createClient({ url: temp.databaseUrl });
    clients.push(pragma);
    expect(String((await pragma.execute("PRAGMA journal_mode")).rows[0]?.journal_mode).toLowerCase()).toBe("wal");

    // The bootstrap handle is intentionally open while independent Bun processes
    // create their own LibSQL connections to the same workspace database.
    const worker = String.raw`
      import { LibSqlStorage } from "./src/storage/index.ts";
      import { materializeInitialAgentProfile } from "./src/domain/index.ts";
      const databaseUrl = process.env.AGENCITY_CONTENTION_DATABASE_URL!;
      const workerId = process.env.AGENCITY_CONTENTION_WORKER!;
      const barrier = process.env.AGENCITY_CONTENTION_BARRIER!;
      while (!(await Bun.file(barrier).exists())) await Bun.sleep(1);
      const storage = new LibSqlStorage({ url: databaseUrl, deviceId: "worker-" + workerId });
      try {
        await storage.migrate();
        const root = await storage.appendEvents([{
          id: "contention-root-created", sessionId: "contention-root", branchId: "main",
          type: "SessionCreated", producer: "test", idempotencyKey: "contention-root-created",
          committedAt: "2026-08-06T00:00:00.000Z",
          payload: { workspaceId: "contention-workspace", initialBranchId: "main", model: { provider: "echo", model: "echo", reasoningEffort: "provider-default" }, budget: {}, agentProfile: materializeInitialAgentProfile({ role: "Test agent", purpose: "Exercise concurrent storage.", instructions: "- Append deterministic test events." }, { profileVersionId: "agent-profile-contention-root-v1", agentSessionId: "contention-root", createdBy: { kind: "system", componentId: "agencity.contention-test", version: 1 }, reason: "Concurrent test profile", createdAt: "2026-08-06T00:00:00.000Z" }) },
        }]);
        for (let index = 0; index < 12; index++) {
          const suffix = workerId + "-" + index;
          await storage.appendEvents([{
            id: "event-" + suffix, sessionId: "contention-root", branchId: "main",
            type: "MessageAppended", producer: "test", idempotencyKey: "message-" + suffix,
            committedAt: "2026-08-06T00:00:01.000Z",
            payload: { messageId: "message-" + suffix, role: "user", content: suffix },
          }]);
        }
        console.log(JSON.stringify({ ok: true, rootId: root[0]?.id }));
      } catch (error) {
        console.log(JSON.stringify({
          ok: false,
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
          code: typeof error === "object" && error !== null && "code" in error ? error.code : null,
        }));
        process.exitCode = 1;
      } finally {
        storage.close();
      }
    `;
    const barrier = `${temp.directory}/contention-start`;
    const processes = Array.from({ length: 4 }, (_, index) => Bun.spawn({
      cmd: [process.execPath, "-e", worker],
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENCITY_CONTENTION_DATABASE_URL: temp.databaseUrl,
        AGENCITY_CONTENTION_WORKER: String(index),
        AGENCITY_CONTENTION_BARRIER: barrier,
      },
      stdout: "pipe",
      stderr: "pipe",
    }));
    await Bun.write(barrier, "start");
    const outcomes = await Promise.all(processes.map(async (process) => {
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
    }));
    expect(outcomes).toEqual(outcomes.map(() => expect.objectContaining({ exitCode: 0, stderr: "" })));
    for (const outcome of outcomes) {
      expect(JSON.parse(outcome.stdout)).toEqual({ ok: true, rootId: "contention-root-created" });
      expect(outcome.stdout).not.toContain("LibsqlError");
    }

    const rows = await storage.readonlyQuery({
      sql: "SELECT count(*) AS total,count(DISTINCT id) AS distinct_ids,count(DISTINCT idempotency_key) AS distinct_keys FROM events WHERE session_id=?",
      args: ["contention-root"],
    });
    expect(rows).toEqual([{ total: 49, distinct_ids: 49, distinct_keys: 49 }]);
  }, 30_000);

  test("maps exhausted ordinary and lease lock contention to existing typed errors", async () => {
    const { temp, storage } = await setup("agencity-libsql-exhausted-contention-");
    await seedSession(storage, { sessionId: "contention-root", workspaceId: "contention-workspace" });

    const ordinaryLock = await holdWriteLock(temp.databaseUrl);
    let ordinary: unknown;
    try {
      await storage.appendEvents([message("ordinary")]);
    } catch (error) {
      ordinary = error;
    }
    expect(ordinary).toMatchObject({
      code: "DEPENDENCY_FAILURE",
      details: { reason: "sqlite_contention_exhausted", attempts: 12, operation: "append events" },
    });
    expect(ordinary?.constructor?.name).not.toBe("LibsqlError");
    await ordinaryLock.rollback();
    ordinaryLock.close();
    transactions.splice(transactions.indexOf(ordinaryLock), 1);
    expect((await storage.appendEvents([message("ordinary")]))[0]?.id).toBe("event-ordinary");

    const leaseLock = await holdWriteLock(temp.databaseUrl);
    let lease: unknown;
    try {
      await storage.claimProcessExecutionLease({
        scope: { kind: "workspace", workspaceId: "contention-workspace" },
        ownerDeviceId: storage.deviceId,
        ownerProcessId: "process-a",
        now: "2026-08-06T01:00:00.000Z",
        leaseMs: 5_000,
      });
    } catch (error) {
      lease = error;
    }
    expect(lease).toMatchObject({
      code: "EXECUTION_OWNERSHIP_CONFLICT",
      details: {
        reason: "sqlite_contention_exhausted",
        attempts: 12,
        action: "claim",
        scopeKind: "workspace",
        scopeId: "contention-workspace",
      },
    });
    expect(lease?.constructor?.name).not.toBe("LibsqlError");
    await leaseLock.rollback();
    leaseLock.close();
    transactions.splice(transactions.indexOf(leaseLock), 1);

    expect((await storage.claimProcessExecutionLease({
      scope: { kind: "workspace", workspaceId: "contention-workspace" },
      ownerDeviceId: storage.deviceId,
      ownerProcessId: "process-a",
      now: "2026-08-06T01:00:00.000Z",
      leaseMs: 5_000,
    })).fenceToken).toBe(1);
  }, 30_000);

  test("does not retry semantic ownership conflicts or other non-busy failures", async () => {
    const { storage } = await setup("agencity-libsql-nonbusy-");
    const scope = { kind: "workspace" as const, workspaceId: "contention-workspace" };
    await storage.claimProcessExecutionLease({
      scope,
      ownerDeviceId: storage.deviceId,
      ownerProcessId: "process-a",
      now: "2026-08-06T02:00:00.000Z",
      leaseMs: 5_000,
    });

    const originalRandom = Math.random;
    let jitterCalls = 0;
    Math.random = () => { jitterCalls++; return 0; };
    try {
      await expect(storage.claimProcessExecutionLease({
        scope,
        ownerDeviceId: storage.deviceId,
        ownerProcessId: "process-b",
        now: "2026-08-06T02:00:00.000Z",
        leaseMs: 5_000,
      })).rejects.toMatchObject({
        code: "EXECUTION_OWNERSHIP_CONFLICT",
        details: { reason: "active_owner" },
      });
      await expect(storage.appendEvents([{
        sessionId: "missing-session",
        branchId: "main",
        type: "MessageAppended",
        producer: "test",
        payload: { messageId: "missing", role: "user", content: "missing" },
      }])).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      Math.random = originalRandom;
    }
    expect(jitterCalls).toBe(0);
  });
});

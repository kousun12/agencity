import { afterEach, describe, expect, test } from "bun:test";
import { LibSqlStorage, type ProcessExecutionLeaseRecord, type ProcessExecutionWriteFence } from "../../src/storage/index.ts";
import { ExecutionLeaseService } from "../../src/runtime/index.ts";
import { makeTempRuntime, removeTempRuntime, seedSession, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
const storages: LibSqlStorage[] = [];
afterEach(async () => {
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

function proof(workspace: ProcessExecutionLeaseRecord, root?: ProcessExecutionLeaseRecord): ProcessExecutionWriteFence {
  const now = new Date().toISOString();
  const value = (lease: ProcessExecutionLeaseRecord) => ({
    scope: lease.scope, ownerDeviceId: lease.ownerDeviceId, ownerProcessId: lease.ownerProcessId,
    fenceToken: lease.fenceToken, now,
  });
  return { workspace: value(workspace), ...(root ? { root: value(root) } : {}) };
}

async function open(): Promise<{ temp: TempRuntime; storage: LibSqlStorage }> {
  const temp = await makeTempRuntime("agencity-managed-fence-");
  temps.push(temp);
  const storage = new LibSqlStorage({ url: temp.databaseUrl, deviceId: "device-1" });
  await storage.migrate();
  storages.push(storage);
  return { temp, storage };
}

describe("managed canonical and outbox fencing", () => {
  test("allows same-owner workspace+root nesting and atomically rejects a stale service after takeover", async () => {
    const { storage } = await open();
    const { sessionId, branchId } = await seedSession(storage);
    const first = new ExecutionLeaseService(storage, { ownerProcessId: "service-a", ownerDeviceId: "device-1", leaseMs: 40 });
    const workspaceA = await first.claim({ kind: "workspace", workspaceId: "workspace-1" });
    const rootA = await first.claim({ kind: "root", rootSessionId: sessionId });

    await storage.appendEvents([{
      sessionId, branchId, type: "MessageAppended", producer: "client", idempotencyKey: "fenced:a",
      payload: { messageId: "fenced-a", role: "user", content: "owned by a" },
    }], proof(workspaceA, rootA));

    await Bun.sleep(70);
    const second = new ExecutionLeaseService(storage, { ownerProcessId: "service-b", ownerDeviceId: "device-1", leaseMs: 5_000 });
    const workspaceB = await second.claim({ kind: "workspace", workspaceId: "workspace-1" });
    const rootB = await second.claim({ kind: "root", rootSessionId: sessionId });
    expect(workspaceB.fenceToken).toBe(workspaceA.fenceToken + 1);
    expect(rootB.fenceToken).toBe(rootA.fenceToken + 1);

    await expect(storage.appendEvents([{
      sessionId, branchId, type: "MessageAppended", producer: "client", idempotencyKey: "fenced:stale",
      payload: { messageId: "fenced-stale", role: "user", content: "must not commit" },
    }], proof(workspaceA, rootA))).rejects.toMatchObject({ code: "EXECUTION_OWNERSHIP_CONFLICT" });

    const effectId = "effect-fenced";
    await storage.appendEvents([{
      sessionId, branchId, type: "EffectRequested", producer: "supervisor", idempotencyKey: "effect:fenced",
      payload: { effectId, executor: "shell", operation: "run", input: { command: "printf fenced" }, origin: { kind: "runtime", requestId: "effect:fenced" }, idempotencyKey: "effect:fenced", idempotent: false },
    }], proof(workspaceB, rootB));
    await expect(storage.claimEffect(effectId, "stale-runner", 1_000, proof(workspaceA, rootA))).rejects.toMatchObject({ code: "EXECUTION_OWNERSHIP_CONFLICT" });
    expect((await storage.claimEffect(effectId, "winner", 1_000, proof(workspaceB, rootB)))?.owner).toBe("winner");
  });

  test("requires both the active workspace and matching root proof for existing-session writes", async () => {
    const { storage } = await open();
    const { sessionId, branchId } = await seedSession(storage);
    const owner = new ExecutionLeaseService(storage, { ownerProcessId: "service-a", ownerDeviceId: "device-1", leaseMs: 5_000 });
    const workspace = await owner.claim({ kind: "workspace", workspaceId: "workspace-1" });
    await expect(storage.appendEvents([{
      sessionId, branchId, type: "MessageAppended", producer: "client", idempotencyKey: "missing-root",
      payload: { messageId: "missing-root", role: "user", content: "blocked" },
    }], proof(workspace))).rejects.toMatchObject({ code: "EXECUTION_OWNERSHIP_CONFLICT" });
  });
});

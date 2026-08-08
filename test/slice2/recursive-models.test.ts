import { afterEach, describe, expect, test } from "bun:test";
import { Supervisor } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, waitFor, type TempRuntime } from "../helpers.ts";
import { BlockingProvider, RecordingProvider } from "./helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

async function open(temp: TempRuntime, provider: BlockingProvider | RecordingProvider, recover: boolean): Promise<Supervisor> {
  return Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover });
}

describe("Slice 2 recursive model concurrency, cancellation, and recovery", () => {
  test("the local runtime enforces a per-provider concurrency limit", async () => {
    const temp = await makeTempRuntime("agencity-slice2-provider-limit-"); temps.push(temp);
    const provider = new BlockingProvider("limited");
    const supervisor = await open(temp, provider, false);
    let handles: Awaited<ReturnType<typeof supervisor.models.startMany>> = [];
    try {
      const root = await supervisor.createSession({ workspaceId: "limit", model: { provider: provider.name, model: "blocked" } });
      handles = await supervisor.models.startMany(root.sessionId, root.branchId, ["first", "second", "third"]);
      await waitFor(() => provider.calls >= 1, "first provider call");
      await Bun.sleep(75);
      expect(provider.peakActive).toBe(1);
      expect(provider.calls).toBe(1);
    } finally {
      provider.unblock();
      if (handles.length) await waitFor(async () => {
        const statuses = await Promise.all(handles.map((handle) => supervisor.models.get(handle.handleId)));
        return statuses.every((handle) => ["completed", "failed", "cancelled"].includes(handle.status));
      }, "limited calls to drain");
      await Bun.sleep(30); // let detached model runners return after their terminal commit
      await supervisor.close();
    }
  });

  test("cancelling a queued provider call prevents it from ever reaching the provider", async () => {
    const temp = await makeTempRuntime("agencity-slice2-provider-queued-cancel-"); temps.push(temp);
    const provider = new BlockingProvider("queued");
    const supervisor = await open(temp, provider, false);
    const handleIds: string[] = [];
    try {
      const root = await supervisor.createSession({ workspaceId: "queue", model: { provider: provider.name, model: "blocked" } });
      const first = await supervisor.models.start(root.sessionId, root.branchId, "occupy provider");
      handleIds.push(first.handleId);
      await waitFor(() => provider.active === 1, "provider occupied");
      const queued = await supervisor.models.start(root.sessionId, root.branchId, "cancel before admission");
      handleIds.push(queued.handleId);
      await Bun.sleep(50);
      expect(provider.calls).toBe(1);
      expect((await supervisor.models.cancel(queued.handleId, "not needed")).status).toBe("cancelled");
      await Bun.sleep(30);
      expect(provider.calls).toBe(1);
      provider.unblock();
      await waitFor(async () => (await supervisor.models.get(first.handleId)).status === "completed", "first completion");
    } finally {
      provider.unblock();
      if (handleIds.length) await waitFor(async () => {
        const handles = await Promise.all(handleIds.map((id) => supervisor.models.get(id)));
        return handles.every((handle) => ["completed", "failed", "cancelled"].includes(handle.status));
      }, "queued-call cleanup");
      await Bun.sleep(30);
      await supervisor.close();
    }
  });

  test("cancelling an in-flight recursive model aborts the provider and commits one terminal outcome", async () => {
    const temp = await makeTempRuntime("agencity-slice2-provider-cancel-"); temps.push(temp);
    const provider = new BlockingProvider("abortable");
    const supervisor = await open(temp, provider, false);
    try {
      const root = await supervisor.createSession({ workspaceId: "cancel", model: { provider: provider.name, model: "blocked" } });
      const handle = await supervisor.models.start(root.sessionId, root.branchId, "wait forever");
      await waitFor(() => provider.active === 1, "inflight provider");
      expect((await supervisor.models.cancel(handle.handleId, "user cancelled")).status).toBe("cancelled");
      await waitFor(() => provider.aborted === 1 && provider.active === 0, "provider abort");
      const events = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      expect(events.filter((event) => event.type === "RecursiveModelStatusChanged" && (event.payload as { handleId?: string }).handleId === handle.handleId && (event.payload as { status?: string }).status === "cancelled")).toHaveLength(1);
      expect((await supervisor.models.get(handle.handleId)).status).toBe("cancelled");
    } finally { provider.unblock(); await Bun.sleep(30); await supervisor.close(); }
  });

  test("a lost non-idempotent provider outcome recovers as unknown without retry and terminates its durable handle", async () => {
    const temp = await makeTempRuntime("agencity-slice2-provider-unknown-"); temps.push(temp);
    const provider = new RecordingProvider("never-retry");
    const supervisor = await open(temp, provider, false);
    const root = await supervisor.createSession({ workspaceId: "unknown", model: { provider: provider.name, model: "model" } });
    const handle = await supervisor.models.start(root.sessionId, root.branchId, { prompt: "ambiguous call", run: false });
    const effectId = "lost-provider-effect";
    const callId = "lost-provider-call";
    const modelDispatch = supervisor.modelExecutor.resolveDispatch({ provider: provider.name, model: "model", reasoningEffort: "provider-default" });
    await supervisor.storage.appendEvents([{
      sessionId: root.sessionId, branchId: root.branchId, type: "RecursiveModelStatusChanged", producer: "supervisor",
      idempotencyKey: `test-running:${handle.handleId}`, payload: { handleId: handle.handleId, status: "running" },
    }, {
      sessionId: handle.childSessionId, branchId: handle.childBranchId, type: "ContextMaterialized", producer: "supervisor",
      idempotencyKey: "test-context:lost-context", payload: { contextId: "lost-context", records: [], contentHash: "0".repeat(64), context: {} },
    }, {
      sessionId: handle.childSessionId, branchId: handle.childBranchId, type: "ModelCallRequested", producer: "supervisor",
      idempotencyKey: `test-call:${callId}`, payload: { callId, contextId: "lost-context", effectId, modelDispatch },
    }, {
      sessionId: handle.childSessionId, branchId: handle.childBranchId, type: "EffectRequested", producer: "supervisor",
      idempotencyKey: `test-effect:${effectId}`, payload: {
        effectId, executor: "model", operation: "complete", input: { context: {}, callId, modelDispatch } as any,
        idempotencyKey: `test-effect:${effectId}`, idempotent: false,
      },
    }, {
      sessionId: handle.childSessionId, branchId: handle.childBranchId, type: "EffectAttemptStarted", producer: "executor",
      idempotencyKey: `test-attempt:${effectId}`, payload: { effectId, attempt: 1 },
    }]);
    await supervisor.close();

    const recovered = await open(temp, provider, true);
    try {
      expect(provider.calls).toBe(0);
      const childEvents = await recovered.storage.loadEvents(handle.childSessionId, { branchId: handle.childBranchId });
      expect(childEvents.some((event) => event.type === "EffectOutcomeRecorded" && (event.payload as { effectId?: string; outcome?: string }).effectId === effectId && (event.payload as { outcome?: string }).outcome === "unknown")).toBe(true);
      expect(childEvents.some((event) => event.type === "ModelCallTerminated" && (event.payload as { callId?: string; outcome?: string }).callId === callId && (event.payload as { outcome?: string }).outcome === "unknown")).toBe(true);
      const durable = await recovered.models.get(handle.handleId);
      expect(durable.status).toBe("failed");
      expect(durable.error?.toLowerCase()).toMatch(/unknown|lost.*outcome|ambiguous/);
      expect((await recovered.storage.getTask?.(handle.taskId))?.status).toBe("failed");
    } finally { await recovered.close(); }
  });
});

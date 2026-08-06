import { afterEach, describe, expect, test } from "bun:test";
import { LibSqlStorage, Supervisor, type JsonValue, type ModelConfiguration, type ModelProvider, type ModelResponse } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { while (temps.length) await removeTempRuntime(temps.pop()!); });

async function open(temp: TempRuntime, options: Record<string, unknown> = {}): Promise<Supervisor> {
  return Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover: false, heartbeatPollIntervalMs: 1_000, ...options });
}
async function waitFor<T>(load: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await load(); if (predicate(value)) return value; await Bun.sleep(5); }
  throw new Error("timed out waiting for durable state");
}

class UsageProvider implements ModelProvider {
  calls = 0;
  constructor(readonly name: string, readonly tokens = 2) {}
  async complete(_context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.calls++;
    return { text: "used", finishReason: "stop", usage: { inputTokens: this.tokens - 1, outputTokens: 1, costUsd: 0.25 } };
  }
}

class TwoSlotProvider implements ModelProvider {
  calls = 0; active = 0; peak = 0; blocked = true;
  readonly waiters = new Set<() => void>();
  constructor(readonly name: string) {}
  unblock(): void { this.blocked = false; for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  async complete(_context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    this.calls++; this.active++; this.peak = Math.max(this.peak, this.active);
    try {
      if (this.blocked) await new Promise<void>((resolve, reject) => {
        const done = () => { this.waiters.delete(done); resolve(); };
        this.waiters.add(done); signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      return { text: "done", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    } finally { this.active--; }
  }
}

describe("Slice 2 independent-review hardening", () => {
  test("startup finishes every crash prefix of a cancellation cascade leaf-first and preserves the first reason", async () => {
    const temp = await makeTempRuntime("agencity-review-cancel-"); temps.push(temp);
    let supervisor = await open(temp);
    const root = await supervisor.createSession({ workspaceId: "cancel" });
    const child = await supervisor.agents.spawn(root.sessionId, root.branchId, "child");
    const grandchild = await supervisor.agents.spawn(child.sessionId, child.branchId, "grandchild");
    await supervisor.storage.appendEvents([{
      sessionId: root.sessionId, branchId: root.branchId, type: "SubagentCancellationRequested", producer: "client",
      idempotencyKey: `task-cancel-request:${child.taskId}`, payload: { taskId: child.taskId, childSessionId: child.sessionId, reason: "original intent" },
    }]);
    await supervisor.close();

    supervisor = await open(temp, { recover: true });
    try {
      const childTask = await supervisor.storage.getTask?.(child.taskId);
      const grandchildTask = await supervisor.storage.getTask?.(grandchild.taskId);
      expect(childTask?.status).toBe("cancelled"); expect(grandchildTask?.status).toBe("cancelled");
      expect(childTask?.reason).toBe("original intent"); expect(grandchildTask?.reason).toBe("original intent");
      expect((await supervisor.agents.cancel(child.taskId, "different retry reason")).reason).toBe("original intent");
      const childEvents = await supervisor.storage.loadEvents(child.sessionId, { branchId: child.branchId });
      const grandchildEvents = await supervisor.storage.loadEvents(grandchild.sessionId, { branchId: grandchild.branchId });
      const childTerminal = childEvents.find((event) => event.type === "TaskTerminalNoticeSent")!;
      const leafTerminal = grandchildEvents.find((event) => event.type === "TaskTerminalNoticeSent")!;
      expect(BigInt(leafTerminal.cursor) < BigInt(childTerminal.cursor)).toBe(true);
    } finally { await supervisor.close(); }
  });

  test("goal recovery never promotes a succeeded gate whose durable workspace pin is stale", async () => {
    const temp = await makeTempRuntime("agencity-review-goal-pin-"); temps.push(temp);
    let supervisor = await open(temp);
    const root = await supervisor.createSession({ workspaceId: "pinned-workspace" });
    const goal = await supervisor.goals.create(root.sessionId, root.branchId, { description: "pin", gates: [{ name: "gate", executor: "shell", operation: "run", input: { command: "true" }, idempotent: false }] });
    const gate = goal.gates[0]!; const effectId = "recovered-succeeded-gate";
    const history = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
    const cursor = history.at(-1)!.cursor;
    await supervisor.storage.appendEvents([{
      sessionId: root.sessionId, branchId: root.branchId, type: "GoalCompletionRequested", producer: "client", idempotencyKey: "review-goal-request",
      payload: { goalId: goal.goalId, requestId: "review-request", workspaceId: "pinned-workspace", workspaceCursor: cursor },
    }, {
      sessionId: root.sessionId, branchId: root.branchId, type: "EffectRequested", producer: "supervisor", idempotencyKey: "review-gate-effect",
      payload: { effectId, executor: "shell", operation: "run", input: { command: "true" }, idempotencyKey: "review-gate-effect", idempotent: false },
    }, {
      sessionId: root.sessionId, branchId: root.branchId, type: "GoalGateStatusChanged", producer: "supervisor", idempotencyKey: "review-gate-running",
      payload: { goalId: goal.goalId, gateId: gate.gateId, status: "running", effectId },
    }, {
      sessionId: root.sessionId, branchId: root.branchId, type: "EffectAttemptStarted", producer: "executor", idempotencyKey: "review-gate-attempt",
      payload: { effectId, attempt: 1 },
    }, {
      sessionId: root.sessionId, branchId: root.branchId, type: "EffectOutcomeRecorded", producer: "executor", idempotencyKey: "review-gate-outcome",
      payload: { effectId, attempt: 1, outcome: "succeeded", output: { ok: true }, observedAt: new Date().toISOString() },
    }, {
      sessionId: root.sessionId, branchId: root.branchId, type: "MessageAppended", producer: "client", idempotencyKey: "review-workspace-change",
      payload: { messageId: "workspace-change", role: "user", content: "new workspace intent" },
    }]);
    await supervisor.close();

    supervisor = await open(temp, { recover: true });
    try {
      const recovered = await supervisor.storage.getGoal?.(goal.goalId);
      const gates = await supervisor.storage.listGoalGates?.(goal.goalId);
      expect(recovered?.completionWorkspaceId).toBe("pinned-workspace"); expect(recovered?.completionWorkspaceCursor).toBe(cursor);
      expect(recovered?.status).toBe("blocked"); expect(gates?.[0]?.status).toBe("failed");
      expect(gates?.[0]?.error).toContain("stale");
    } finally { await supervisor.close(); }
  });

  test("actual child model usage is attributed once to every ancestor and reduces later admission", async () => {
    const temp = await makeTempRuntime("agencity-review-budget-"); temps.push(temp);
    const provider = new UsageProvider("usage");
    const supervisor = await open(temp, { modelProviders: [provider] });
    try {
      const root = await supervisor.createSession({ workspaceId: "budget", model: { provider: provider.name, model: "m" }, budget: { tokenLimit: 10, costLimitUsd: 1, turnLimit: 5, wallTimeLimitMs: 10_000 } });
      const child = await supervisor.agents.spawn(root.sessionId, root.branchId, { task: "middle", budget: { tokenLimit: 10, costLimitUsd: 1, turnLimit: 5, wallTimeLimitMs: 10_000 } });
      const model = await supervisor.models.start(child.sessionId, child.branchId, { prompt: "use budget", budget: { tokenLimit: 8, costLimitUsd: 0.5, turnLimit: 2, wallTimeLimitMs: 5_000 }, idempotencyKey: "usage-once" });
      await waitFor(() => supervisor.models.get(model.handleId), (handle) => handle.status === "completed");
      await supervisor.agents.completeTask(child.taskId, { result: { ok: true } });
      const state = await supervisor.projections.getSnapshot(root.sessionId, root.branchId);
      expect(state.state.budget.tokens).toBe(2); expect(state.state.budget.costUsd).toBe(0.25); expect(state.state.budget.turns).toBe(1);
      expect((await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId })).filter((event) => event.type === "TaskUsageAttributed")).toHaveLength(2);
      expect((await supervisor.agents.completeTask(child.taskId, { result: { ignored: true } })).status).toBe("completed");
      expect((await supervisor.projections.getSnapshot(root.sessionId, root.branchId)).state.budget.tokens).toBe(2);
      await expect(supervisor.agents.spawn(root.sessionId, root.branchId, { task: "too large", budget: { tokenLimit: 9, costLimitUsd: 0.75, turnLimit: 4, wallTimeLimitMs: 9_000 } })).rejects.toThrow(/spent budget/i);
      const unused = await supervisor.agents.spawn(root.sessionId, root.branchId, { task: "unused reservation", budget: { tokenLimit: 8, costLimitUsd: 0.75, turnLimit: 4, wallTimeLimitMs: 9_000 } });
      await supervisor.agents.completeTask(unused.taskId, { result: null });
      expect((await supervisor.agents.spawn(root.sessionId, root.branchId, { task: "released reservation", budget: { tokenLimit: 8, costLimitUsd: 0.75, turnLimit: 4, wallTimeLimitMs: 9_000 } })).status).toBe("admitted");
    } finally { await supervisor.close(); }
  });

  test("unknown child model usage conservatively debits its remaining reservation", async () => {
    const temp = await makeTempRuntime("agencity-review-unknown-budget-"); temps.push(temp);
    const provider = new UsageProvider("unknown-usage");
    let supervisor = await open(temp, { modelProviders: [provider] });
    const root = await supervisor.createSession({ workspaceId: "unknown-budget", model: { provider: provider.name, model: "m" }, budget: { tokenLimit: 10, costLimitUsd: 1, turnLimit: 3, wallTimeLimitMs: 10_000 } });
    const handle = await supervisor.models.start(root.sessionId, root.branchId, { prompt: "ambiguous", run: false, idempotencyKey: "ambiguous", budget: { tokenLimit: 8, costLimitUsd: 0.75, turnLimit: 2, wallTimeLimitMs: 8_000 } });
    const effectId = "unknown-budget-effect"; const callId = "unknown-budget-call";
    await supervisor.storage.appendEvents([{
      sessionId: root.sessionId, branchId: root.branchId, type: "RecursiveModelStatusChanged", producer: "supervisor", idempotencyKey: "unknown-budget-running", payload: { handleId: handle.handleId, status: "running" },
    }, {
      sessionId: handle.childSessionId, branchId: handle.childBranchId, type: "ContextMaterialized", producer: "supervisor", idempotencyKey: "unknown-budget-context", payload: { contextId: "unknown-budget-context", records: [], contentHash: "0".repeat(64), context: {} },
    }, {
      sessionId: handle.childSessionId, branchId: handle.childBranchId, type: "ModelCallRequested", producer: "supervisor", idempotencyKey: "unknown-budget-call", payload: { callId, contextId: "unknown-budget-context", effectId, provider: provider.name, model: "m" },
    }, {
      sessionId: handle.childSessionId, branchId: handle.childBranchId, type: "EffectRequested", producer: "supervisor", idempotencyKey: "unknown-budget-effect", payload: { effectId, executor: "model", operation: "complete", input: { context: {}, configuration: { provider: provider.name, model: "m" } }, idempotencyKey: "unknown-budget-effect", idempotent: false },
    }, {
      sessionId: handle.childSessionId, branchId: handle.childBranchId, type: "EffectAttemptStarted", producer: "executor", idempotencyKey: "unknown-budget-attempt", payload: { effectId, attempt: 1 },
    }]);
    await supervisor.close();
    supervisor = await open(temp, { modelProviders: [provider], recover: true });
    try {
      const state = (await supervisor.projections.getSnapshot(root.sessionId, root.branchId)).state;
      expect(state.budget.tokens).toBe(8); expect(state.budget.costUsd).toBe(0.75);
      expect(state.budget.turns).toBe(2); expect(state.budget.wallTimeMs).toBe(8_000);
      const usage = (await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId })).find((event) => event.type === "TaskUsageAttributed");
      expect((usage?.payload as { conservative?: boolean } | undefined)?.conservative).toBe(true);
    } finally { await supervisor.close(); }
  });

  test("recursive model admission and handle creation share one append and stable retries create no orphan", async () => {
    const temp = await makeTempRuntime("agencity-review-model-atomic-"); temps.push(temp);
    const supervisor = await open(temp);
    try {
      const root = await supervisor.createSession({ workspaceId: "atomic" });
      await expect(supervisor.models.startMany(root.sessionId, root.branchId, [
        { prompt: "would be valid", run: false, idempotencyKey: "batch-valid" },
        { prompt: "", run: false, idempotencyKey: "batch-invalid" },
      ])).rejects.toThrow(/empty/i);
      expect(await supervisor.agents.listTasks(root.sessionId, root.branchId)).toHaveLength(0);
      const batches: string[][] = []; const unsubscribe = supervisor.storage.onCommitted((events) => batches.push(events.map((event) => event.type)));
      const first = await supervisor.models.start(root.sessionId, root.branchId, { prompt: "atomic prompt", run: false, idempotencyKey: "stable-start" });
      const second = await supervisor.models.start(root.sessionId, root.branchId, { prompt: "atomic prompt", run: false, idempotencyKey: "stable-start" });
      unsubscribe();
      expect(second.handleId).toBe(first.handleId); expect(second.taskId).toBe(first.taskId);
      const admission = batches.find((batch) => batch.includes("RecursiveModelStarted"))!;
      expect(admission).toContain("TaskCreated"); expect(admission).toContain("SessionCreated"); expect(admission).toContain("SubagentAdmitted"); expect(admission).toContain("MessageAppended");
      expect(batches.filter((batch) => batch.includes("RecursiveModelStarted"))).toHaveLength(1);
      expect((await supervisor.agents.listTasks(root.sessionId, root.branchId))).toHaveLength(1);
      await expect(supervisor.models.start(root.sessionId, root.branchId, { prompt: "changed", run: false, idempotencyKey: "stable-start" })).rejects.toThrow(/different request/i);
    } finally { await supervisor.close(); }
  });

  test("maxChildren counts active direct children and stable retries report durable terminal status", async () => {
    const temp = await makeTempRuntime("agencity-review-active-children-"); temps.push(temp);
    const supervisor = await open(temp, { maxChildrenPerSession: 1 });
    try {
      const root = await supervisor.createSession({ workspaceId: "children" });
      const first = await supervisor.agents.spawn(root.sessionId, root.branchId, { task: "first", idempotencyKey: "first" });
      await supervisor.agents.completeTask(first.taskId, { result: "done" });
      expect((await supervisor.agents.spawn(root.sessionId, root.branchId, { task: "first", idempotencyKey: "first" })).status).toBe("completed");
      expect((await supervisor.agents.spawn(root.sessionId, root.branchId, { task: "second", idempotencyKey: "second" })).status).toBe("admitted");
    } finally { await supervisor.close(); }
  });

  test("configured provider concurrency is shared by recursive model effects", async () => {
    const temp = await makeTempRuntime("agencity-review-provider-limit-"); temps.push(temp);
    const provider = new TwoSlotProvider("two-slot");
    const supervisor = await open(temp, { modelProviders: [provider], providerConcurrency: { [provider.name]: 2 } });
    try {
      const root = await supervisor.createSession({ workspaceId: "concurrency", model: { provider: provider.name, model: "m" } });
      const handles = await supervisor.models.startMany(root.sessionId, root.branchId, ["one", "two", "three"]);
      await waitFor(async () => provider.calls, (calls) => calls === 2);
      expect(provider.peak).toBe(2); expect(provider.calls).toBe(2);
      provider.unblock();
      await waitFor(async () => Promise.all(handles.map((handle) => supervisor.models.get(handle.handleId))), (current) => current.every((handle) => handle.status === "completed"));
      expect(provider.calls).toBe(3);
    } finally { provider.unblock(); await supervisor.close(); }
  });

  test("the live DB scheduler fires future heartbeats and close stops its polling loop", async () => {
    const temp = await makeTempRuntime("agencity-review-live-heartbeat-"); temps.push(temp);
    let supervisor = await open(temp, { heartbeatPollIntervalMs: 5 });
    const root = await supervisor.createSession({ workspaceId: "heartbeat" });
    const heartbeat = await supervisor.heartbeats.create(root.sessionId, root.branchId, { intervalMs: 10_000, nextTickAt: new Date(Date.now() + 25).toISOString() });
    await waitFor(() => supervisor.storage.getHeartbeat!(heartbeat.heartbeatId), (current) => current?.tick === 1);
    await supervisor.close();
    await Bun.sleep(30);
    const storage = new LibSqlStorage(temp.databaseUrl); await storage.migrate();
    try { expect((await storage.getHeartbeat(heartbeat.heartbeatId))?.tick).toBe(1); }
    finally { storage.close(); }
  });

  test("recovery reflects an out-of-band terminal task on its recursive handle", async () => {
    const temp = await makeTempRuntime("agencity-review-model-terminal-"); temps.push(temp);
    const first = await open(temp);
    const root = await first.createSession({ workspaceId: "model-terminal" });
    const handle = await first.models.start(root.sessionId, root.branchId, {
      prompt: "held call",
      idempotencyKey: "held-call",
      run: false,
    });
    await first.agents.completeTask(handle.childSessionId, handle.childBranchId, { result: { answer: 42 } });
    await first.close();

    const recovered = await open(temp, { recover: true });
    try {
      expect((await recovered.models.get(handle.handleId)).status).toBe("completed");
    } finally { await recovered.close(); }
  });
});

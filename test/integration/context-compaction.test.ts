import { afterEach, describe, expect, test } from "bun:test";
import { makeTempRuntime, openTempStorage, removeTempRuntime, seedSession } from "../helpers.ts";
import { ContextMaterializer, CompactionService, OutboxRunner, ProjectionService, Supervisor } from "../../src/runtime/index.ts";
import { EchoModelProvider, ModelExecutor, ModelProviderContextWindowOverflowError, type ModelProvider } from "../../src/executors/index.ts";
import { AGENT_ACTION_PROTOCOL, AGENT_ACTION_VERSION, type JsonValue } from "../../src/domain/index.ts";

const temps: Awaited<ReturnType<typeof makeTempRuntime>>[] = [];
afterEach(async () => { while (temps.length) await removeTempRuntime(temps.pop()!); });

async function fixture(provider: ModelProvider = new EchoModelProvider()) {
  const temp = await makeTempRuntime("agencity-compaction-"); temps.push(temp);
  const storage = await openTempStorage(temp);
  const root = await seedSession(storage, { model: { provider: provider.name, model: "test" } });
  const outbox = new OutboxRunner(storage, [new ModelExecutor([provider])]);
  return { temp, storage, root, outbox, service: new CompactionService(storage, outbox) };
}

async function messages(storage: any, sessionId: string, branchId: string, count = 28) {
  for (let index = 0; index < count; index++) await storage.appendEvents([{
    sessionId, branchId, type: "MessageAppended", producer: index % 2 ? "model" : "client",
    idempotencyKey: `long-message:${index}`,
    payload: { messageId: `long-message-${index}`, role: index % 2 ? "assistant" : "user", content: `${index}: ${"context narrative ".repeat(120)}` },
  }]);
}

describe("FU-019 durable context compaction", () => {
  test("freezes exact sources, retains canonical history, and materializes one effective summary beside uncovered narrative", async () => {
    const { storage, root, service } = await fixture();
    await messages(storage, root.sessionId, root.branchId);
    const before = await storage.loadEvents(root.sessionId, { branchId: root.branchId });
    const compacted = await service.compact(root.sessionId, root.branchId, { retainRecentMessages: 5, idempotencyKey: "manual-1" });
    expect(compacted.status).toBe("completed");
    expect(compacted.sourceEventIds).toHaveLength(23);
    const after = await storage.loadEvents(root.sessionId, { branchId: root.branchId });
    expect(after.filter((event) => event.type === "MessageAppended")).toHaveLength(28);
    expect(after.length).toBeGreaterThan(before.length);
    const request = after.find((event) => event.type === "ContextCompactionRequested")!;
    expect((request.payload as any).frozenSources).toHaveLength(23);
    expect((request.payload as any).frozenSources[0]).toMatchObject({ eventId: compacted.sourceEventIds[0], disposition: "compactable" });
    const context = await new ContextMaterializer(storage).materialize(root.sessionId, root.branchId);
    const value = context.context as Record<string, JsonValue>;
    expect(value.compactions).toHaveLength(1);
    expect(value.messages).toHaveLength(5);
    const dependent = context.event.payload.records;
    expect(dependent.some((record) => record.eventId === request.id && record.reason?.includes("manifest"))).toBe(true);
    expect(dependent.filter((record) => compacted.sourceEventIds.includes(record.eventId))).toHaveLength(23);
    const rebuilt = await new ProjectionService(storage).rebuild(root.sessionId, root.branchId);
    expect(rebuilt.compactions[compacted.compactionId]?.status).toBe("completed");
    expect(rebuilt.messages).toHaveLength(28);
    storage.close();
  });

  test("uses hierarchical outbox model effects, charges usage, and rematerializes identical sources under another strategy", async () => {
    const concise: ModelProvider = {
      name: "concise", capabilities: { streaming: false, contextWindowTokens: 32_000, contextCapacitySource: "provider-metadata" },
      async complete(context) {
        const text = `summary:${JSON.stringify(context).length}`;
        return { text, finishReason: "stop", usage: { inputTokens: 17, outputTokens: 3, costUsd: 0.01 } };
      },
    };
    const { storage, root, service } = await fixture(concise);
    await messages(storage, root.sessionId, root.branchId, 30);
    const first = await service.compact(root.sessionId, root.branchId, { strategy: "model-summary-v1", instructions: "Preserve file paths", retainRecentMessages: 4, idempotencyKey: "model-1" });
    expect(first.status).toBe("completed");
    expect(first.effectIds.length).toBeGreaterThan(0);
    expect(first.usage?.inputTokens).toBeGreaterThan(0);
    const second = await service.compact(root.sessionId, root.branchId, { strategy: "deterministic-extractive-v1", reason: "rematerialize", rematerializeFromContextId: first.contextId!, idempotencyKey: "rematerialize-1" });
    expect(second.status).toBe("completed");
    expect(second.sourceEventIds).toEqual(first.sourceEventIds);
    expect(second.sourceDigest).toBe(first.sourceDigest);
    expect(second.summary).not.toBe(first.summary);
    const events = await storage.loadEvents(root.sessionId, { branchId: root.branchId });
    expect(events.some((event) => event.type === "BudgetDebited" && String((event.payload as any).callId).startsWith("context-compaction:"))).toBe(true);
    expect(events.filter((event) => event.type === "MessageAppended")).toHaveLength(30);
    storage.close();
  });

  test("automatically compacts a long AgentRun at the provider threshold while preserving active durable state", async () => {
    const provider: ModelProvider = {
      name: "small-window", capabilities: { streaming: false, contextWindowTokens: 18_000, contextCapacitySource: "provider-metadata" },
      async complete() {
        const text = JSON.stringify({ protocol: AGENT_ACTION_PROTOCOL, version: AGENT_ACTION_VERSION, type: "final", content: "continued after compaction" });
        return { text, finishReason: "stop", usage: { inputTokens: 500, outputTokens: 20, costUsd: 0 } };
      },
    };
    const temp = await makeTempRuntime("agencity-auto-compaction-"); temps.push(temp);
    const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const root = await supervisor.createSession({ workspaceId: "auto-compaction", model: { provider: provider.name, model: "small" } });
    await messages(supervisor.storage, root.sessionId, root.branchId, 30);
    const heartbeat = await supervisor.heartbeats.create(root.sessionId, root.branchId, { intervalMs: 60_000, nextTickAt: new Date(Date.now() + 60_000).toISOString() });
    const schedule = await supervisor.schedules.create(root.sessionId, root.branchId, { prompt: "later", nextTickAt: new Date(Date.now() + 60_000).toISOString(), goalMode: "auto" });
    const result = await supervisor.runs.start(root.sessionId, root.branchId, { task: "finish long run", goalMode: "create" });
    expect(result.status).toBe("succeeded");
    const events = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
    const state = (await supervisor.projections.getSnapshot(root.sessionId, root.branchId)).state;
    expect(Object.values(state.compactions).some((item) => item.status === "completed" && item.reason === "automatic-threshold")).toBe(true);
    expect(state.heartbeats[heartbeat.heartbeatId]?.status).toBe("active");
    expect(state.schedules[schedule.scheduleId]?.status).toBe("active");
    expect(Object.values(state.goals).some((goal) => goal.status === "completed")).toBe(true);
    expect(events.filter((event) => event.type === "MessageAppended").length).toBeGreaterThanOrEqual(31);
    await supervisor.close();
  });

  test("retries only a typed provider overflow with a strictly smaller candidate and a new attributed run attempt", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "overflow-once", capabilities: { streaming: false },
      async complete(_context, configuration) {
        calls++;
        if (calls === 1) throw new ModelProviderContextWindowOverflowError("overflow-once", configuration.model);
        const text = JSON.stringify({ protocol: AGENT_ACTION_PROTOCOL, version: AGENT_ACTION_VERSION, type: "final", content: "retried safely" });
        return { text, finishReason: "stop", usage: { inputTokens: 100, outputTokens: 10, costUsd: 0 } };
      },
    };
    const temp = await makeTempRuntime("agencity-overflow-compaction-"); temps.push(temp);
    const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const root = await supervisor.createSession({ workspaceId: "overflow-compaction", model: { provider: provider.name, model: "overflow" } });
    await messages(supervisor.storage, root.sessionId, root.branchId, 30);
    const result = await supervisor.runs.start(root.sessionId, root.branchId, { task: "retry overflow", goalMode: "none" });
    expect(result.status).toBe("succeeded");
    expect(calls).toBe(2);
    const state = (await supervisor.projections.getSnapshot(root.sessionId, root.branchId)).state;
    const run = state.agentRuns[result.runId]!;
    expect(run.steps[0]?.modelAttempts).toHaveLength(2);
    expect(run.steps[0]?.modelAttempts[1]).toMatchObject({ attempt: 2, reason: "provider-overflow", retryOfCallId: run.steps[0]?.modelAttempts[0]?.callId });
    expect(run.steps[0]!.modelAttempts[1]!.estimatedInputTokens).toBeLessThan(run.steps[0]!.modelAttempts[0]!.estimatedInputTokens);
    expect(Object.values(state.compactions).some((item) => item.reason === "provider-overflow" && item.status === "completed")).toBe(true);
    await supervisor.close();
  });

});

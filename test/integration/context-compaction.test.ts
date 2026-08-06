import { afterEach, describe, expect, test } from "bun:test";
import { makeTempRuntime, openTempStorage, removeTempRuntime, seedSession } from "../helpers.ts";
import { ContextMaterializer, CompactionService, OutboxRunner, ProjectionService, Supervisor, stableEffectId } from "../../src/runtime/index.ts";
import { EchoModelProvider, ModelExecutor, ModelProviderContextWindowOverflowError, type ModelProvider } from "../../src/executors/index.ts";
import { AGENT_ACTION_PROTOCOL, AGENT_ACTION_VERSION, projectEvents, type AgentEvent, type JsonValue } from "../../src/domain/index.ts";
import { AgentClient, ProtocolServer } from "../../src/protocol/index.ts";
import { createExactSourceManifest, planCompactionSources } from "../../src/runtime/compaction-core.ts";

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

async function appendPendingModelRequest(storage: any, sessionId: string, branchId: string, compactionId: string) {
  const events = await storage.loadEvents(sessionId, { branchId }) as AgentEvent[];
  const throughCursor = BigInt(projectEvents(events).cursor).toString();
  const sources = events.filter((event) => event.type === "MessageAppended").slice(0, -4);
  const plan = planCompactionSources(sources.map((event) => ({ id: event.id, sessionId: event.sessionId, branchId: event.branchId, cursor: BigInt(event.cursor).toString(), type: event.type, schemaVersion: event.schemaVersion, payload: event.payload })), { sessionId, branchId, throughCursor });
  const manifest = createExactSourceManifest(plan.compactable, { sessionId, branchId, throughCursor });
  const [request] = await storage.appendEvents([{
    sessionId, branchId, type: "ContextCompactionRequested", producer: "supervisor",
    idempotencyKey: `context-compaction-request:${compactionId}`,
    payload: {
      compactionId, strategy: "model-summary-v1", reason: "user-request", requestedBy: "user", throughCursor,
      sourceEventIds: [...manifest.sourceEventIds], sourceDigest: manifest.sourceDigest,
      frozenSources: plan.compactable.map((source) => ({ eventId: source.eventId, sessionId: source.sessionId, branchId: source.branchId, cursor: source.cursor, type: source.type, schemaVersion: source.schemaVersion, payload: source.payload, disposition: "compactable", classificationReason: source.classificationReason, payloadUtf8Bytes: source.payloadUtf8Bytes })),
    },
  }]);
  return request as AgentEvent<"ContextCompactionRequested">;
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
    await expect(storage.appendEvents([{
      sessionId: root.sessionId, branchId: root.branchId, type: "ContextCompactionRequested", producer: "client", idempotencyKey: "tampered-compaction",
      payload: { ...(request.payload as any), compactionId: "tampered-compaction", sourceDigest: "0".repeat(64) },
    }])).rejects.toThrow("source digest");
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


  test("recovers request/effect crash boundaries and makes a lost model summary explicitly unknown", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: "recovery-summary", capabilities: { streaming: false },
      async complete() { calls++; return { text: "recovered concise summary", finishReason: "stop", usage: { inputTokens: 9, outputTokens: 3, costUsd: 0 } }; },
    };
    const first = await fixture(provider);
    await messages(first.storage, first.root.sessionId, first.root.branchId, 26);
    await appendPendingModelRequest(first.storage, first.root.sessionId, first.root.branchId, "crash-before-effect");
    expect(await first.service.recoverIncomplete()).toBe(1);
    expect(calls).toBe(1);
    expect((await first.service.inspect(first.root.sessionId, first.root.branchId)).compactions.find((item) => item.compactionId === "crash-before-effect")?.status).toBe("completed");
    expect(await first.service.recoverIncomplete()).toBe(0);
    first.storage.close();

    calls = 0;
    const second = await fixture(provider);
    await messages(second.storage, second.root.sessionId, second.root.branchId, 26);
    await appendPendingModelRequest(second.storage, second.root.sessionId, second.root.branchId, "crash-after-effect");
    const effectKey = "context-compaction-model:crash-after-effect:level:0:chunk:0";
    const effectId = await second.outbox.request({ sessionId: second.root.sessionId, branchId: second.root.branchId, executor: "model", operation: "complete", input: { context: { messages: [] }, configuration: { provider: provider.name, model: "test" } }, idempotencyKey: effectKey, idempotent: false });
    expect(await second.outbox.run(effectId)).toMatchObject({ outcome: "succeeded" });
    expect(calls).toBe(1);
    expect(await second.service.recoverIncomplete()).toBe(1);
    expect(calls).toBe(1);
    second.storage.close();

    calls = 0;
    const third = await fixture(provider);
    await messages(third.storage, third.root.sessionId, third.root.branchId, 26);
    const request = await appendPendingModelRequest(third.storage, third.root.sessionId, third.root.branchId, "crash-unknown");
    const unknownKey = "context-compaction-model:crash-unknown:level:0:chunk:0";
    const unknownEffectId = await third.outbox.request({ sessionId: third.root.sessionId, branchId: third.root.branchId, executor: "model", operation: "complete", input: { context: { messages: [] }, configuration: { provider: provider.name, model: "test" } }, idempotencyKey: unknownKey, idempotent: false });
    expect(unknownEffectId).toBe(stableEffectId(third.root.sessionId, unknownKey));
    await third.storage.appendEvents([{ sessionId: third.root.sessionId, branchId: third.root.branchId, type: "EffectAttemptStarted", producer: "executor", idempotencyKey: `effect-attempt:${unknownEffectId}:1`, payload: { effectId: unknownEffectId, attempt: 1 } }]);
    const recovered = await third.outbox.recover();
    expect(recovered.unknownEffectIds).toContain(unknownEffectId);
    expect(await third.service.recoverIncomplete()).toBe(1);
    const unknown = projectEvents(await third.storage.loadEvents(third.root.sessionId, { branchId: third.root.branchId })).compactions[request.payload.compactionId]!;
    expect(unknown.status).toBe("unknown");
    expect(calls).toBe(0);
    third.storage.close();
  });


  test("exposes inspect/compact through sdk and protocol and selects another strategy on a branch", async () => {
    const provider: ModelProvider = {
      name: "surface-summary", capabilities: { streaming: false },
      async complete() { return { text: "surface summary", finishReason: "stop", usage: { inputTokens: 8, outputTokens: 2, costUsd: 0 } }; },
    };
    const temp = await makeTempRuntime("agencity-compaction-surfaces-"); temps.push(temp);
    const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const root = await supervisor.createSession({ workspaceId: "surfaces", model: { provider: provider.name, model: "surface" } });
    await messages(supervisor.storage, root.sessionId, root.branchId, 26);
    const sdkCompaction = await supervisor.executeCell(root.sessionId, root.branchId, `return await sdk.context.compact({ strategy: "deterministic-extractive-v1", instructions: "preserve decisions", idempotencyKey: "sdk-surface" });`);
    expect(sdkCompaction.result).toMatchObject({ status: "completed", requestedBy: "agent", reason: "agent-request" });
    const sdkInspection = await supervisor.executeCell(root.sessionId, root.branchId, `return await sdk.context.inspect();`);
    expect(sdkInspection.result).toMatchObject({ messageCount: 26, effective: { strategy: "deterministic-extractive-v1" } });

    const protocol = new ProtocolServer(supervisor); const server = protocol.listen(0);
    const client = new AgentClient(`http://${server.hostname}:${server.port}`);
    try {
      const inspected = await client.inspectContext(root.sessionId, root.branchId);
      expect(inspected.effective?.strategy).toBe("deterministic-extractive-v1");
      expect(inspected.capacity).toMatchObject({ provider: provider.name, model: "surface", source: "unknown", contextWindowTokens: null });
      const guided = await client.compact(root.sessionId, root.branchId, { strategy: "model-summary-v1", instructions: "preserve protocol evidence", rematerializeFromContextId: (sdkCompaction.result as any).contextId, idempotencyKey: "protocol-surface" });
      expect(guided).toMatchObject({ status: "completed", strategy: "model-summary-v1" });
      const history = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      const childBranchId = await supervisor.fork(root.sessionId, root.branchId, history.at(-1)!.cursor, "extractive branch", "deterministic-extractive-v1");
      const child = await supervisor.inspectContext(root.sessionId, childBranchId);
      expect(child.effective).toMatchObject({ strategy: "deterministic-extractive-v1", reason: "rematerialize" });
      expect(child.effective?.sourceDigest).toBe(guided.sourceDigest);
    } finally { server.stop(true); }
    await supervisor.close();
  });

});

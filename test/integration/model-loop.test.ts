import { afterEach, describe, expect, test } from "bun:test";
import {
  ContextMaterializer,
  ModelLoop,
  OutboxRunner,
  Supervisor,
  ValidationError,
  projectEvents,
  type JsonValue,
  type ModelConfiguration,
  type ModelProvider,
  type ModelResponse,
} from "../../src/index.ts";
import {
  makeTempRuntime,
  openTempStorage,
  removeTempRuntime,
  seedSession,
  type TempRuntime,
} from "../helpers.ts";

class ScriptedProvider implements ModelProvider {
  readonly contexts: JsonValue[] = [];
  readonly configurations: ModelConfiguration[] = [];
  calls = 0;
  constructor(
    readonly name: string,
    readonly response: ModelResponse | ((call: number) => ModelResponse),
    readonly failure?: Error,
  ) {}
  async complete(
    context: JsonValue,
    configuration: ModelConfiguration,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.calls++;
    this.contexts.push(JSON.parse(JSON.stringify(context)) as JsonValue);
    this.configurations.push({ ...configuration });
    if (this.failure) throw this.failure;
    return typeof this.response === "function" ? this.response(this.calls) : this.response;
  }
}

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

async function openWithProvider(
  provider: ScriptedProvider,
  budget: { tokenLimit?: number; costLimitUsd?: number; turnLimit?: number; wallTimeLimitMs?: number } = {},
): Promise<{
  temp: TempRuntime;
  supervisor: Supervisor;
  sessionId: string;
  branchId: string;
}> {
  const temp = await makeTempRuntime("agencity-model-");
  temps.push(temp);
  const supervisor = await Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    modelProviders: [provider],
    recover: false,
  });
  const { sessionId, branchId } = await supervisor.createSession({
    workspaceId: "model-workspace",
    model: { provider: provider.name, model: "scripted-v1", temperature: 0 },
    budget,
  });
  return { temp, supervisor, sessionId, branchId };
}

function sha256(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

describe("context provenance and model loop", () => {
  test("traces a response to the exact immutable context record IDs and versions it received", async () => {
    const provider = new ScriptedProvider("scripted", {
      text: "deterministic answer",
      finishReason: "stop",
      usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.01 },
    });
    const { supervisor, sessionId, branchId } = await openWithProvider(provider, { tokenLimit: 100 });
    const userEvent = await supervisor.appendMessage(sessionId, branchId, "user", "Please inspect durable state");
    const cell = await supervisor.executeCell(sessionId, branchId, `
      await state.set("finding", { source: "test", count: 2 });
      return "checkpointed";
    `);
    const result = await supervisor.modelLoop.turn(sessionId, branchId);
    expect(result).toEqual({ outcome: "succeeded", message: "deterministic answer" });
    expect(provider.calls).toBe(1);

    const events = await supervisor.storage.loadEvents(sessionId, { branchId });
    const state = projectEvents(events);
    const contextEvent = events.find((event) => event.type === "ContextMaterialized");
    const callEvent = events.find((event) => event.type === "ModelCallRequested");
    const completion = events.find((event) => event.type === "ModelCallCompleted");
    expect(contextEvent).toBeDefined();
    expect(callEvent).toBeDefined();
    expect(completion).toBeDefined();
    const contextPayload = contextEvent!.payload as {
      contextId: string;
      records: Array<{ eventId: string; type: string; schemaVersion: number; reason?: string }>;
      contentHash: string;
      context: JsonValue;
    };
    expect((callEvent!.payload as { contextId: string }).contextId).toBe(contextPayload.contextId);
    expect(provider.contexts[0]).toEqual(contextPayload.context);
    expect(contextPayload.contentHash).toBe(sha256(JSON.stringify(contextPayload.context)));
    expect(contextPayload.records.length).toBeGreaterThanOrEqual(5);
    expect(contextPayload.records.map((record) => record.eventId)).toContain(userEvent.id);
    expect(contextPayload.records.some((record) =>
      record.type === "CellCommitted" &&
      (events.find((event) => event.id === record.eventId)?.payload as { cellId?: string }).cellId === cell.cellId))
      .toBe(true);
    for (const reference of contextPayload.records) {
      const source = events.find((event) => event.id === reference.eventId);
      expect(source, `missing provenance event ${reference.eventId}`).toBeDefined();
      expect(String(source!.type)).toBe(reference.type);
      expect(source!.schemaVersion).toBe(reference.schemaVersion);
      expect(BigInt(source!.cursor)).toBeLessThan(BigInt(contextEvent!.cursor));
      expect(reference.reason).toBeTruthy();
    }
    expect(new Set(contextPayload.records.map((record) => record.eventId)).size)
      .toBe(contextPayload.records.length);

    const persisted = await supervisor.storage.readonlyQuery({
      sql: "SELECT event_id, content_hash, records_json, context_json FROM context_records WHERE context_id=?",
      args: [contextPayload.contextId],
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ event_id: contextEvent!.id, content_hash: contextPayload.contentHash });
    expect(JSON.parse((persisted[0] as Record<string, string>).records_json!)).toEqual(contextPayload.records);
    expect(JSON.parse((persisted[0] as Record<string, string>).context_json!)).toEqual(contextPayload.context);

    const callId = (callEvent!.payload as { callId: string }).callId;
    expect(state.contexts[contextPayload.contextId]).not.toHaveProperty("context");
    expect(state.modelCalls[callId]).toMatchObject({
      contextId: contextPayload.contextId,
      status: "succeeded",
      chunks: ["deterministic answer"],
      usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.01 },
    });
    expect(state.messages.at(-1)).toMatchObject({
      role: "assistant", content: "deterministic answer", modelCallId: callId,
    });
    expect(state.budget).toMatchObject({ tokens: 10, costUsd: 0.01, turns: 1, exceeded: false });
    await supervisor.close();
  });

  test.each([
    [{ tokenLimit: 5 }, { inputTokens: 3, outputTokens: 2, costUsd: 0 }, "tokens"],
    [{ costLimitUsd: 0.25 }, { inputTokens: 1, outputTokens: 1, costUsd: 0.25 }, "cost"],
    [{ turnLimit: 1 }, { inputTokens: 1, outputTokens: 1, costUsd: 0 }, "turns"],
  ] as const)("stops at the %s budget boundary and makes no call beyond it", async (budget, usage, dimension) => {
    const provider = new ScriptedProvider(`budget-${dimension}`, {
      text: `${dimension} boundary`, finishReason: "stop", usage,
    });
    const { supervisor, sessionId, branchId } = await openWithProvider(provider, budget);
    await supervisor.appendMessage(sessionId, branchId, "user", "one bounded turn");
    expect((await supervisor.modelLoop.turn(sessionId, branchId)).outcome).toBe("succeeded");
    const state = projectEvents(await supervisor.storage.loadEvents(sessionId, { branchId }));
    expect(state.budget.exceeded).toBe(true);
    const exceeded = (await supervisor.storage.loadEvents(sessionId, { branchId }))
      .filter((event) => event.type === "BudgetExceeded");
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]!.payload).toMatchObject({ dimension });
    await expect(supervisor.modelLoop.turn(sessionId, branchId)).rejects.toBeInstanceOf(ValidationError);
    expect(provider.calls).toBe(1);
    expect((await supervisor.storage.loadEvents(sessionId, { branchId }))
      .filter((event) => event.type === "ContextMaterialized")).toHaveLength(1);
    await supervisor.close();
  });

  test("a failed model effect terminates visibly without fabricating a response or spending budget", async () => {
    const provider = new ScriptedProvider("failing", {
      text: "never", finishReason: "stop", usage: { inputTokens: 9, outputTokens: 9, costUsd: 9 },
    }, new Error("deterministic provider outage"));
    const { supervisor, sessionId, branchId } = await openWithProvider(provider, { tokenLimit: 100 });
    await supervisor.appendMessage(sessionId, branchId, "user", "trigger failure");
    expect(await supervisor.modelLoop.turn(sessionId, branchId)).toEqual({
      outcome: "failed", error: "deterministic provider outage",
    });
    const state = projectEvents(await supervisor.storage.loadEvents(sessionId, { branchId }));
    expect(state.budget).toMatchObject({ tokens: 0, costUsd: 0, turns: 0, exceeded: false });
    expect(state.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    expect(Object.values(state.modelCalls)).toHaveLength(1);
    expect(Object.values(state.modelCalls)[0]).toMatchObject({
      status: "failed", error: "deterministic provider outage",
    });
    expect(state.status).toBe("idle");
    await supervisor.close();
  });


  test("startup returns a session stuck running before model request creation to idle", async () => {
    const temp = await makeTempRuntime("agencity-running-recovery-");
    temps.push(temp);
    const storage = await openTempStorage(temp);
    const { sessionId, branchId } = await seedSession(storage);
    const [running] = await storage.appendEvents([{
      sessionId, branchId, type: "SessionStatusChanged", producer: "supervisor",
      idempotencyKey: "turn-running:crashed-before-context", payload: { status: "running" },
    }]);
    storage.close();

    const recovered = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
    });
    let events = await recovered.storage.loadEvents(sessionId, { branchId });
    expect(projectEvents(events).status).toBe("idle");
    const reconciled = events.filter((event) =>
      event.type === "SessionStatusChanged" && event.producer === "recovery");
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.idempotencyKey).toContain(running!.id);
    await recovered.close();

    const again = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
    });
    events = await again.storage.loadEvents(sessionId, { branchId });
    expect(events.filter((event) => event.type === "SessionStatusChanged" && event.producer === "recovery"))
      .toHaveLength(1);
    await again.close();
  });

  test("recovery finalizes a durable successful model effect exactly once without calling a provider", async () => {
    const temp = await makeTempRuntime("agencity-model-recovery-");
    temps.push(temp);
    const storage = await openTempStorage(temp);
    const { sessionId, branchId } = await seedSession(storage, {
      model: { provider: "not-installed", model: "durable-only" },
    });
    const context: JsonValue = { basePolicy: "test", messages: [] };
    await storage.appendEvents([{
      sessionId, branchId, type: "ContextMaterialized", producer: "supervisor",
      idempotencyKey: "context:recovery", payload: {
        contextId: "context-recovery", records: [], contentHash: sha256(JSON.stringify(context)), context,
      },
    }, {
      sessionId, branchId, type: "ModelCallRequested", producer: "supervisor",
      idempotencyKey: "model-call:recovery", payload: {
        callId: "call-recovery", contextId: "context-recovery", effectId: "effect-recovery",
        provider: "not-installed", model: "durable-only",
      },
    }, {
      sessionId, branchId, type: "EffectRequested", producer: "supervisor",
      idempotencyKey: "model:recovery", payload: {
        effectId: "effect-recovery", executor: "model", operation: "complete",
        input: { context, configuration: { provider: "not-installed", model: "durable-only" } },
        idempotencyKey: "model:recovery", idempotent: false,
      },
    }, {
      sessionId, branchId, type: "EffectAttemptStarted", producer: "executor",
      idempotencyKey: "effect-attempt:effect-recovery:1",
      payload: { effectId: "effect-recovery", attempt: 1 },
    }, {
      sessionId, branchId, type: "EffectOutcomeRecorded", producer: "executor",
      idempotencyKey: "effect-outcome:effect-recovery:1",
      payload: {
        effectId: "effect-recovery", attempt: 1, outcome: "succeeded",
        output: {
          text: "recovered response", finishReason: "stop",
          usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.02 },
        },
        observedAt: "2026-01-01T00:01:00.000Z",
      },
    }]);
    const loop = new ModelLoop(storage, new ContextMaterializer(storage), new OutboxRunner(storage, []));
    expect(await loop.recoverIncomplete()).toBe(1);
    expect(await loop.recoverIncomplete()).toBe(0);
    const events = await storage.loadEvents(sessionId, { branchId });
    expect(events.filter((event) => event.type === "ModelCallCompleted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "MessageAppended" &&
      (event.payload as { modelCallId?: string }).modelCallId === "call-recovery")).toHaveLength(1);
    expect(events.filter((event) => event.type === "BudgetDebited")).toHaveLength(1);
    expect(projectEvents(events).budget).toMatchObject({ tokens: 6, turns: 1, costUsd: 0.02 });
    storage.close();
  });
});

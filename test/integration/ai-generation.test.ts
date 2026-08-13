import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentClient,
  DECLARED_DATA_TOOL_NAME,
  InProcessProtocolTransport,
  ProtocolServer,
  Supervisor,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  createModelEffectOutputV2,
  stableEffectId,
  type JsonValue,
  type ModelConfiguration,
  type ModelDispatch,
  type ModelEffectOutputV2,
  type ModelProvider,
  type TextModelResponse,
} from "../../src/index.ts";
import { formalMissingToolOutput } from "../../src/executors/model-response.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

class TextGenerationProvider implements ModelProvider {
  calls = 0;
  readonly contexts: JsonValue[] = [];
  constructor(
    readonly name: string,
    readonly output: string = "generated text",
    readonly delayMs = 0,
  ) {}
  async complete(context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<TextModelResponse> {
    this.calls++;
    this.contexts.push(context);
    if (this.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    }
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return {
      text: this.output,
      finishReason: "stop",
      usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.01 },
    };
  }
}

class TimeoutRaceProvider implements ModelProvider {
  calls = 0;
  constructor(readonly name: string, readonly delayMs = 20) {}
  async complete(): Promise<TextModelResponse> {
    this.calls++;
    await Bun.sleep(this.delayMs);
    return {
      text: "late authoritative result",
      finishReason: "stop",
      usage: { inputTokens: 11, outputTokens: 5, costUsd: 0.02 },
    };
  }
}

class TimeoutCommitBarrierProvider implements ModelProvider {
  calls = 0;
  readonly #released: Promise<void>;
  #release!: () => void;
  constructor(readonly name: string) {
    this.#released = new Promise<void>((resolve) => { this.#release = resolve; });
  }
  release(): void { this.#release(); }
  async complete(): Promise<TextModelResponse> {
    this.calls++;
    await this.#released;
    return {
      text: "authoritative barrier result",
      finishReason: "stop",
      usage: { inputTokens: 13, outputTokens: 5, costUsd: 0.03 },
    };
  }
}

class KnownPricingProvider extends TextGenerationProvider {
  readonly productTransport = true;
  readonly capabilities = {
    streaming: false,
    reasoningControl: "none",
    requiredToolSet: {
      status: "provider-strict",
      requiredChoice: "provider-enforced",
      parallelCalls: "provider-disabled",
      streaming: true,
      adapter: "agencity.ai-generation-pricing-test.v1",
    },
  } as const;
}

class KnownPricingBarrierProvider extends KnownPricingProvider {
  readonly #releases: Array<() => void> = [];
  readonly #startWaiters: Array<{ count: number; resolve: () => void }> = [];
  #started = 0;
  releaseNext(): void { this.#releases.shift()?.(); }
  releaseAll(): void {
    for (const release of this.#releases.splice(0)) release();
  }
  waitForStarts(count: number): Promise<void> {
    if (this.#started >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#startWaiters.push({ count, resolve });
    });
  }
  override async complete(
    context: JsonValue,
    configuration: ModelConfiguration,
    signal: AbortSignal,
  ): Promise<TextModelResponse> {
    this.#started++;
    const released = new Promise<void>((resolve) => {
      this.#releases.push(resolve);
    });
    for (const waiter of [...this.#startWaiters]) {
      if (this.#started < waiter.count) continue;
      this.#startWaiters.splice(this.#startWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    await released;
    return super.complete(context, configuration, signal);
  }
}

class DeclaredObjectProvider implements ModelProvider {
  calls = 0;
  readonly contexts: JsonValue[] = [];
  readonly capabilities = {
    streaming: false,
    reasoningControl: "none",
    requiredToolSet: {
      status: "provider-strict",
      requiredChoice: "provider-enforced",
      parallelCalls: "provider-disabled",
      streaming: true,
      adapter: "agencity.ai-generation-test.v1",
    },
  } as const;
  constructor(readonly name: string, readonly value: JsonValue) {}
  async complete(): Promise<TextModelResponse> {
    throw new Error("Declared object generation must use the response-aware primitive");
  }
  async streamResponse(
    context: JsonValue,
    dispatch: ModelDispatch,
    signal: AbortSignal,
  ): Promise<ModelEffectOutputV2> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.calls++;
    this.contexts.push(context);
    if (dispatch.responseContract.kind !== "required-tool-set") throw new Error("missing structured contract");
    const input = { value: this.value };
    const inputDigest = canonicalJsonDigest(input);
    const inputBytes = canonicalJsonByteLength(input);
    const transport = { provider: this.name, adapter: this.capabilities.requiredToolSet.adapter };
    const termination = { kind: "tool-calls" as const, rawReason: "tool-calls" };
    const submission = {
      providerToolCallId: `declared-${this.calls}`,
      name: DECLARED_DATA_TOOL_NAME,
      input,
      inputDigest,
      inputBytes,
      responseContract: {
        contractId: dispatch.responseContract.contractId,
        version: dispatch.responseContract.version,
        contractDigest: dispatch.responseContract.contractDigest,
      },
      transport,
      termination,
    };
    return createModelEffectOutputV2({
      response: {
        kind: "complete",
        blocks: [{
          type: "tool-call",
          callId: submission.providerToolCallId,
          name: submission.name,
          inputDigest,
          inputBytes,
        }],
        termination,
        usage: { inputTokens: 9, outputTokens: 4, costUsd: 0.02 },
        warnings: [],
        transport,
      },
      result: { kind: "tool-submission", submission },
      responseContract: dispatch.responseContract,
      responseCapability: dispatch.responseCapability,
      configuredProvider: this.name,
    });
  }
}

class MissingDeclaredObjectProvider extends DeclaredObjectProvider {
  override async streamResponse(
    context: JsonValue,
    dispatch: ModelDispatch,
    signal: AbortSignal,
  ): Promise<ModelEffectOutputV2> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.calls++;
    this.contexts.push(context);
    return formalMissingToolOutput({
      dispatch,
      provider: this.name,
      adapter: this.capabilities.requiredToolSet.adapter,
      text: "missing declaration",
      usage: { inputTokens: 3, outputTokens: 2, costUsd: 0 },
    });
  }
}

async function open(
  temp: TempRuntime,
  providers: readonly ModelProvider[],
  modelCatalog?: { readonly fetch?: typeof fetch },
): Promise<Supervisor> {
  return Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    modelProviders: providers,
    ...(modelCatalog === undefined ? {} : { modelCatalog }),
    recover: false,
  });
}

describe("durable raw AI generation", () => {
  test("freezes only explicit context, debits once, deduplicates, and rebuilds without family records", async () => {
    const temp = await makeTempRuntime("agencity-ai-generation-text-"); temps.push(temp);
    const provider = new TextGenerationProvider("raw-text");
    const supervisor = await open(temp, [provider]);
    try {
      const root = await supervisor.createSession({
        workspaceId: "raw-text",
        model: { provider: provider.name, model: "fixture", maxOutputTokens: 32 },
        budget: { tokenLimit: 1_000, costLimitUsd: 1, turnLimit: 10, wallTimeLimitMs: 30_000 },
      });
      await supervisor.appendMessage(root.sessionId, root.branchId, "user", "AMBIENT-MUST-NOT-APPEAR");
      const explicit = await supervisor.appendMessage(root.sessionId, root.branchId, "user", "explicit source");
      const input = {
        prompt: "Use only the explicit source",
        context: [{ kind: "event" as const, eventId: explicit.id }],
        budget: { tokenLimit: 800, costLimitUsd: 0.1, turnLimit: 1, wallTimeLimitMs: 5_000 },
        idempotencyKey: "raw-text-v1",
      };
      const admitted = await supervisor.ai.admitText(root.sessionId, root.branchId, input);
      const result = await supervisor.ai.result(admitted.generationId, { wait: true, timeoutMs: 5_000 });
      expect(result).toMatchObject({ kind: "text", status: "succeeded", text: "generated text" });
      expect(provider.calls).toBe(1);
      expect(JSON.stringify(provider.contexts[0])).toContain("explicit source");
      expect(JSON.stringify(provider.contexts[0])).not.toContain("AMBIENT-MUST-NOT-APPEAR");
      expect((await supervisor.ai.admitText(root.sessionId, root.branchId, input)).generationId).toBe(admitted.generationId);
      expect(provider.calls).toBe(1);
      await expect(supervisor.ai.admitText(root.sessionId, root.branchId, {
        ...input,
        prompt: "different",
      })).rejects.toThrow(/different request/i);

      const events = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      expect(events.filter(event => event.type === "AiGenerationBudgetDebited")).toHaveLength(1);
      const generationOrder = events
        .filter(event =>
          event.type === "AiGenerationContextFrozen" ||
          event.type === "AiGenerationRequested" ||
          event.type === "EffectRequested")
        .map(event => event.type);
      expect(generationOrder).toEqual([
        "AiGenerationContextFrozen",
        "AiGenerationRequested",
        "EffectRequested",
      ]);
      expect(events.find(event => event.type === "EffectRequested")?.payload).toMatchObject({
        origin: { kind: "ai-generation", generationId: admitted.generationId },
      });
      expect(events.find(event => event.type === "AiGenerationRequested")?.payload)
        .toMatchObject({ reservation: { costUsd: 0.1 } });
      expect((await supervisor.agents.listTasks(root.sessionId))).toHaveLength(0);
      expect(await supervisor.agents.listChildren(root.sessionId)).toHaveLength(0);
      expect(await supervisor.ai.find(root.sessionId, root.branchId, "raw-text-v1")).toMatchObject({
        generationId: admitted.generationId,
        status: "succeeded",
      });
      const debit = events.find(event => event.type === "AiGenerationBudgetDebited")!;
      await expect(supervisor.storage.appendEvents([{
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "AiGenerationBudgetDebited",
        producer: "supervisor",
        idempotencyKey: "adversarial-duplicate-generation-debit",
        payload: debit.payload as any,
      }])).rejects.toThrow(/budget debit/i);
      await expect(supervisor.storage.appendEvents([{
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "AiGenerationStatusChanged",
        producer: "supervisor",
        idempotencyKey: "adversarial-deordered-generation-status",
        payload: {
          generationId: admitted.generationId,
          status: "running",
          effectId: result.provenance.effectId,
        },
      }])).rejects.toThrow(/transition/i);

      await supervisor.storage.rebuildOperationalProjections!();
      expect(await supervisor.ai.get(admitted.generationId)).toMatchObject({
        generationId: admitted.generationId,
        status: "succeeded",
      });
    } finally { await supervisor.close(); }
  });

  test("converts Zod in the worker and exposes immediate protocol admission plus lookup", async () => {
    const temp = await makeTempRuntime("agencity-ai-generation-object-"); temps.push(temp);
    const provider = new DeclaredObjectProvider("raw-object", { title: "Durable", count: 2 });
    const supervisor = await open(temp, [provider]);
    try {
      const root = await supervisor.createSession({
        workspaceId: "raw-object",
        model: { provider: provider.name, model: "fixture", maxOutputTokens: 16 },
      });
      const cell = await supervisor.executeCell(root.sessionId, root.branchId, `
        const { z } = await import("zod");
        return await ai.generateObject({
          prompt: "Return the object",
          schema: z.object({ title: z.string(), count: z.number().int().min(0) }),
          idempotencyKey: "worker-object-v1",
        });
      `);
      expect(cell.result).toMatchObject({
        kind: "object",
        status: "succeeded",
        object: { title: "Durable", count: 2 },
      });
      expect(provider.calls).toBe(1);

      const client = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
      const handle = await client.admitObjectGeneration(root.sessionId, root.branchId, {
        prompt: "Return another object",
        schema: {
          type: "object",
          properties: { title: { type: "string" }, count: { type: "integer" } },
          required: ["title", "count"],
          additionalProperties: false,
        },
        idempotencyKey: "protocol-object-v1",
      });
      expect(handle.status).toMatch(/pending|running|succeeded/);
      expect(await client.findGeneration(root.sessionId, root.branchId, "protocol-object-v1"))
        .toMatchObject({ generationId: handle.generationId });
      expect(await client.generateObject(root.sessionId, root.branchId, {
        prompt: "Return another object",
        schema: {
          type: "object",
          properties: { title: { type: "string" }, count: { type: "integer" } },
          required: ["title", "count"],
          additionalProperties: false,
        },
        idempotencyKey: "protocol-object-v1",
      })).toMatchObject({ status: "succeeded", object: { title: "Durable", count: 2 } });
      const stranger = await supervisor.createSession({ workspaceId: "raw-object-stranger" });
      await expect(client.generation(stranger.sessionId, stranger.branchId, handle.generationId))
        .rejects.toThrow(/not found/i);
      await expect(client.generationResult(stranger.sessionId, stranger.branchId, handle.generationId))
        .rejects.toThrow(/not found/i);
      await expect(client.cancelGeneration(stranger.sessionId, stranger.branchId, handle.generationId))
        .rejects.toThrow(/not found/i);
      expect(provider.calls).toBe(2);
    } finally { await supervisor.close(); }
  });

  test("rejects malformed scalar inputs and invalid client waits before admission", async () => {
    const temp = await makeTempRuntime("agencity-ai-generation-admission-validation-"); temps.push(temp);
    const provider = new TextGenerationProvider("admission-validation");
    const supervisor = await open(temp, [provider]);
    try {
      const root = await supervisor.createSession({
        workspaceId: "admission-validation",
        model: { provider: provider.name, model: "fixture", maxOutputTokens: 16 },
      });
      await expect(supervisor.ai.admitText(root.sessionId, root.branchId, {
        prompt: "invalid runtime key",
        idempotencyKey: 42,
      } as any)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(supervisor.agents.spawnRunnable(root.sessionId, root.branchId, {
        task: "invalid child key",
        idempotencyKey: 42,
      } as any)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(supervisor.agents.spawnRunnable(root.sessionId, root.branchId, {
        task: "invalid child name",
        name: 42,
      } as any)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(supervisor.agents.spawnManyRunnable(
        root.sessionId,
        root.branchId,
        42 as any,
      )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

      const client = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
      await expect(client.admitTextGeneration(root.sessionId, root.branchId, {
        prompt: "invalid protocol key",
        idempotencyKey: 42,
      } as any)).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
      await expect(client.generateText(root.sessionId, root.branchId, {
        prompt: "invalid negative wait",
      }, { timeoutMs: -1 })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
      await expect(client.generateObject(root.sessionId, root.branchId, {
        prompt: "invalid NaN wait",
        schema: { type: "string" },
      }, { timeoutMs: Number.NaN })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });

      expect(provider.calls).toBe(0);
      expect(await supervisor.agents.listTasks(root.sessionId)).toHaveLength(0);
      const events = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      expect(events.some(event =>
        event.type === "AiGenerationRequested" ||
        event.type === "EffectRequested")).toBe(false);
    } finally { await supervisor.close(); }
  });

  test("cancellation, timeout, and oversized inline output remain typed terminal failures", async () => {
    const temp = await makeTempRuntime("agencity-ai-generation-terminal-"); temps.push(temp);
    const slow = new TextGenerationProvider("slow-raw", "late", 1_000);
    const large = new TextGenerationProvider("large-raw", "X".repeat(1_000));
    const supervisor = await open(temp, [slow, large]);
    try {
      const slowRoot = await supervisor.createSession({
        workspaceId: "slow-raw",
        model: { provider: slow.name, model: "fixture" },
      });
      const cancelled = await supervisor.ai.admitText(slowRoot.sessionId, slowRoot.branchId, {
        prompt: "cancel",
        idempotencyKey: "cancel-v1",
      });
      await supervisor.ai.cancel(cancelled.generationId, "test cancellation");
      expect(await supervisor.ai.result(cancelled.generationId)).toMatchObject({ status: "cancelled" });

      const timed = await supervisor.ai.admitText(slowRoot.sessionId, slowRoot.branchId, {
        prompt: "timeout",
        budget: { wallTimeLimitMs: 10 },
        idempotencyKey: "timeout-v1",
      });
      expect(await supervisor.ai.result(timed.generationId, { wait: true, timeoutMs: 5_000 }))
        .toMatchObject({ status: "budget_exceeded" });
      const timedEvents = await supervisor.storage.loadEvents(slowRoot.sessionId, { branchId: slowRoot.branchId });
      expect(timedEvents.filter(event =>
        event.type === "AiGenerationBudgetDebited" &&
        (event.payload as any).generationId === timed.generationId)).toHaveLength(1);

      const largeRoot = await supervisor.createSession({
        workspaceId: "large-raw",
        model: { provider: large.name, model: "fixture" },
      });
      const oversized = await supervisor.ai.admitText(largeRoot.sessionId, largeRoot.branchId, {
        prompt: "too large",
        budget: { inlineResultByteLimit: 32 },
        idempotencyKey: "oversized-v1",
      });
      expect(await supervisor.ai.result(oversized.generationId, { wait: true, timeoutMs: 5_000 }))
        .toMatchObject({ status: "failed" });
      expect(await supervisor.ai.result(oversized.generationId)).not.toHaveProperty("text");
    } finally { await supervisor.close(); }
  });

  test("object generation fails closed on missing, schema-invalid, and secret output", async () => {
    const temp = await makeTempRuntime("agencity-ai-generation-invalid-object-"); temps.push(temp);
    const missing = new MissingDeclaredObjectProvider("missing-object", null);
    const invalid = new DeclaredObjectProvider("invalid-object", { count: "wrong" });
    const secret = new DeclaredObjectProvider("secret-object", { value: "sk-proj-generation-secret-123456789" });
    const supervisor = await open(temp, [missing, invalid, secret]);
    try {
      const schema: JsonValue = {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false,
      };
      const missingRoot = await supervisor.createSession({
        workspaceId: "missing-object", model: { provider: missing.name, model: "fixture" },
      });
      const missingHandle = await supervisor.ai.admitObject(missingRoot.sessionId, missingRoot.branchId, {
        prompt: "missing", schema, idempotencyKey: "missing-v1",
      });
      expect(await supervisor.ai.result(missingHandle.generationId, { wait: true, timeoutMs: 5_000 }))
        .toMatchObject({ status: "failed" });

      const invalidRoot = await supervisor.createSession({
        workspaceId: "invalid-object", model: { provider: invalid.name, model: "fixture" },
      });
      const invalidHandle = await supervisor.ai.admitObject(invalidRoot.sessionId, invalidRoot.branchId, {
        prompt: "invalid", schema, idempotencyKey: "invalid-v1",
      });
      expect(await supervisor.ai.result(invalidHandle.generationId, { wait: true, timeoutMs: 5_000 }))
        .toMatchObject({ status: "failed" });

      const secretRoot = await supervisor.createSession({
        workspaceId: "secret-object", model: { provider: secret.name, model: "fixture" },
      });
      const secretHandle = await supervisor.ai.admitObject(secretRoot.sessionId, secretRoot.branchId, {
        prompt: "secret",
        schema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        idempotencyKey: "secret-v1",
      });
      const secretResult = await supervisor.ai.result(secretHandle.generationId, { wait: true, timeoutMs: 5_000 });
      expect(secretResult).toMatchObject({ status: "failed" });
      expect(missing.calls).toBe(1);
      expect(invalid.calls).toBe(1);
      expect(secret.calls).toBe(1);
      const secretEvents = await supervisor.storage.loadEvents(secretRoot.sessionId, { branchId: secretRoot.branchId });
      expect(JSON.stringify(secretEvents)).not.toContain("sk-proj-generation-secret-123456789");
      expect(secretEvents.find(event =>
        event.type === "EffectOutcomeRecorded" &&
        (event.payload as any).effectId === secretResult.provenance.effectId)?.payload)
        .not.toHaveProperty("output");
    } finally { await supervisor.close(); }
  });

  test("rejects getters, cycles, excessive depth, and invalid UTF-8 while reporting bounded omissions", async () => {
    const temp = await makeTempRuntime("agencity-ai-generation-context-adversarial-"); temps.push(temp);
    const provider = new TextGenerationProvider("context-adversarial");
    const supervisor = await open(temp, [provider]);
    try {
      const root = await supervisor.createSession({
        workspaceId: "context-adversarial",
        model: { provider: provider.name, model: "fixture" },
      });
      let getterCalls = 0;
      const getterValue: Record<string, unknown> = {};
      Object.defineProperty(getterValue, "value", {
        enumerable: true,
        get() {
          getterCalls++;
          return "must not execute";
        },
      });
      await expect(supervisor.ai.admitText(root.sessionId, root.branchId, {
        prompt: "getter",
        context: [getterValue as any],
        idempotencyKey: "getter-context",
      })).rejects.toThrow(/accessor/i);
      expect(getterCalls).toBe(0);

      const cyclic: any = {};
      cyclic.self = cyclic;
      await expect(supervisor.ai.admitText(root.sessionId, root.branchId, {
        prompt: "cycle",
        context: [cyclic],
        idempotencyKey: "cyclic-context",
      })).rejects.toThrow(/circular/i);

      let deep: any = "leaf";
      for (let index = 0; index < 70; index++) deep = { nested: deep };
      await expect(supervisor.ai.admitText(root.sessionId, root.branchId, {
        prompt: "depth",
        context: [deep],
        idempotencyKey: "deep-context",
      })).rejects.toThrow(/depth/i);

      const invalid = await supervisor.artifacts.put(new Uint8Array([0xc3, 0x28]), {
        mediaType: "application/octet-stream",
      });
      await supervisor.storage.appendEvents([{
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "ArtifactRegistered",
        producer: "supervisor",
        idempotencyKey: "invalid-utf8-artifact",
        payload: invalid,
      }]);
      await expect(supervisor.ai.admitText(root.sessionId, root.branchId, {
        prompt: "invalid utf8",
        context: [{ kind: "artifact", artifactId: invalid.artifactId }],
        idempotencyKey: "invalid-utf8-context",
      })).rejects.toThrow(/valid UTF-8/i);

      const bounded = await supervisor.artifacts.put("abcdef", { mediaType: "text/plain" });
      await supervisor.storage.appendEvents([{
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "ArtifactRegistered",
        producer: "supervisor",
        idempotencyKey: "bounded-context-artifact",
        payload: bounded,
      }]);
      const admitted = await supervisor.ai.admitText(root.sessionId, root.branchId, {
        prompt: "bounded context",
        context: [{ kind: "artifact", artifactId: bounded.artifactId, start: 0, end: 3 }],
        idempotencyKey: "bounded-context",
      });
      expect(await supervisor.ai.result(admitted.generationId, { wait: true, timeoutMs: 5_000 }))
        .toMatchObject({ status: "succeeded" });
      const contextEvent = (await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId }))
        .find(event =>
          event.type === "AiGenerationContextFrozen" &&
          (event.payload as any).generationId === admitted.generationId)!;
      expect((contextEvent.payload as any).provenance).toMatchObject({
        complete: false,
        omissions: [{ position: 0, reason: "bounded-reference" }],
        sources: [{ complete: false, sourceBytes: 3 }],
      });
      expect(provider.calls).toBe(1);
    } finally { await supervisor.close(); }
  });

  test("settles a successful provider outcome that races timeout as exact budget exceeded", async () => {
    const temp = await makeTempRuntime("agencity-ai-generation-timeout-race-"); temps.push(temp);
    const provider = new TimeoutRaceProvider("timeout-race");
    const supervisor = await open(temp, [provider]);
    try {
      const root = await supervisor.createSession({
        workspaceId: "timeout-race",
        model: { provider: provider.name, model: "fixture", maxOutputTokens: 16 },
        budget: { tokenLimit: 10_000, costLimitUsd: 1, turnLimit: 10, wallTimeLimitMs: 10_000 },
      });
      const admitted = await supervisor.ai.admitText(root.sessionId, root.branchId, {
        prompt: "race timeout",
        budget: { wallTimeLimitMs: 10 },
        idempotencyKey: "timeout-race",
      });
      const result = await supervisor.ai.result(admitted.generationId, { wait: true, timeoutMs: 5_000 });
      expect(result).toMatchObject({ status: "budget_exceeded" });
      expect(result).not.toHaveProperty("text");
      const events = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      expect(events.find(event =>
        event.type === "EffectOutcomeRecorded" &&
        (event.payload as any).effectId === result.provenance.effectId)?.payload)
        .toMatchObject({ outcome: "succeeded" });
      const debits = events.filter(event =>
        event.type === "AiGenerationBudgetDebited" &&
        (event.payload as any).generationId === admitted.generationId);
      expect(debits).toHaveLength(1);
      expect(debits[0]!.payload).toMatchObject({
        tokens: 16,
        costUsd: 0.02,
        turns: 1,
        usageSource: "provider-reported",
      });
      const costLimited = await supervisor.ai.admitText(root.sessionId, root.branchId, {
        prompt: "exceed exact cost cap",
        budget: { costLimitUsd: 0.01, wallTimeLimitMs: 1_000 },
        idempotencyKey: "cost-race",
      });
      expect(await supervisor.ai.result(costLimited.generationId, { wait: true, timeoutMs: 5_000 }))
        .toMatchObject({ status: "budget_exceeded" });
      const costDebit = (await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId }))
        .find(event =>
          event.type === "AiGenerationBudgetDebited" &&
          (event.payload as any).generationId === costLimited.generationId);
      expect(costDebit?.payload).toMatchObject({
        tokens: 16,
        costUsd: 0.02,
        usageSource: "provider-reported",
      });
    } finally { await supervisor.close(); }
  });

  test("reconciles a terminal provider outcome committed at the timeout unknown boundary", async () => {
    const temp = await makeTempRuntime("agencity-ai-generation-timeout-commit-barrier-"); temps.push(temp);
    const provider = new TimeoutCommitBarrierProvider("timeout-commit-barrier");
    const supervisor = await open(temp, [provider]);
    const storage = supervisor.storage;
    const appendEvents = storage.appendEvents.bind(storage);
    const getOutbox = storage.getOutbox.bind(storage);
    let interceptedUnknown = 0;
    storage.appendEvents = async (events, fence) => {
      const forcedUnknown = events.find(event =>
        event.type === "EffectOutcomeRecorded" &&
        event.idempotencyKey?.startsWith("ai-generation-timeout-unknown:"));
      if (forcedUnknown) {
        interceptedUnknown++;
        provider.release();
        const effectId = (forcedUnknown.payload as any).effectId as string;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const retained = await getOutbox(effectId);
          if (retained && !["pending", "running"].includes(retained.status)) break;
          await Bun.sleep(1);
        }
      }
      return appendEvents(events, fence);
    };
    try {
      const root = await supervisor.createSession({
        workspaceId: "timeout-commit-barrier",
        model: { provider: provider.name, model: "fixture", maxOutputTokens: 16 },
        budget: { tokenLimit: 10_000, costLimitUsd: 1, turnLimit: 10, wallTimeLimitMs: 10_000 },
      });
      const admitted = await supervisor.ai.admitText(root.sessionId, root.branchId, {
        prompt: "commit exactly at unknown boundary",
        budget: { wallTimeLimitMs: 1 },
        idempotencyKey: "timeout-commit-barrier",
      });
      expect(await supervisor.ai.result(admitted.generationId, { wait: true, timeoutMs: 10_000 }))
        .toMatchObject({ status: "budget_exceeded" });
      const events = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      expect(interceptedUnknown).toBe(1);
      expect(events.find(event =>
        event.type === "EffectOutcomeRecorded" &&
        (event.payload as any).effectId === stableEffectId(
          root.sessionId,
          `ai-generation-effect:${admitted.generationId}`,
        ))?.payload).toMatchObject({ outcome: "succeeded" });
      expect(events.filter(event =>
        event.type === "AiGenerationBudgetDebited" &&
        (event.payload as any).generationId === admitted.generationId)).toHaveLength(1);
      expect(events.find(event =>
        event.type === "AiGenerationBudgetDebited" &&
        (event.payload as any).generationId === admitted.generationId)?.payload)
        .toMatchObject({
          tokens: 18,
          costUsd: 0.03,
          usageSource: "provider-reported",
        });
      expect(events.some(event =>
        event.type === "AiGenerationStatusChanged" &&
        (event.payload as any).generationId === admitted.generationId &&
        (event.payload as any).status === "failed")).toBe(false);
    } finally {
      storage.appendEvents = appendEvents;
      await supervisor.close();
    }
  });

  test("durably cancels an admitted pending effect before restart can execute it", async () => {
    const temp = await makeTempRuntime("agencity-ai-generation-pending-cancel-"); temps.push(temp);
    const provider = new TextGenerationProvider("pending-cancel");
    let supervisor: Supervisor | undefined = await open(temp, [provider]);
    try {
      const root = await supervisor.createSession({
        workspaceId: "pending-cancel",
        model: { provider: provider.name, model: "fixture", maxOutputTokens: 16 },
        budget: { tokenLimit: 10_000, turnLimit: 10, wallTimeLimitMs: 100_000 },
      });
      const template = await supervisor.ai.admitText(root.sessionId, root.branchId, {
        prompt: "template",
        idempotencyKey: "pending-cancel-template",
      });
      expect(await supervisor.ai.result(template.generationId, { wait: true, timeoutMs: 5_000 }))
        .toMatchObject({ status: "succeeded" });
      const templateEvents = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      const frozen = templateEvents.find(event =>
        event.type === "AiGenerationContextFrozen" &&
        (event.payload as any).generationId === template.generationId)!;
      const requested = templateEvents.find(event =>
        event.type === "AiGenerationRequested" &&
        (event.payload as any).generationId === template.generationId)!;
      const effect = templateEvents.find(event =>
        event.type === "EffectRequested" &&
        (event.payload as any).origin?.generationId === template.generationId)!;

      const generationId = "generation-pending-cancel-restart";
      const contextEventId = "generation-context-pending-cancel-restart";
      const idempotencyKey = "pending-cancel-restart";
      const effectKey = `ai-generation-effect:${generationId}`;
      const effectId = stableEffectId(root.sessionId, effectKey);
      await supervisor.storage.appendEvents([
        {
          id: contextEventId,
          sessionId: root.sessionId,
          branchId: root.branchId,
          type: "AiGenerationContextFrozen",
          producer: "supervisor",
          idempotencyKey: `ai-generation-context:${generationId}`,
          payload: { ...(frozen.payload as any), generationId },
        },
        {
          sessionId: root.sessionId,
          branchId: root.branchId,
          type: "AiGenerationRequested",
          producer: "supervisor",
          idempotencyKey: `ai-generation-request:${generationId}`,
          payload: {
            ...(requested.payload as any),
            generationId,
            effectId,
            idempotencyKey,
            requestDigest: canonicalJsonDigest({ generationId, idempotencyKey }),
            contextEventId,
            budget: { ...(requested.payload as any).budget, wallTimeLimitMs: 1_000 },
            reservation: { ...(requested.payload as any).reservation, wallTimeMs: 1_000 },
          },
        },
        {
          sessionId: root.sessionId,
          branchId: root.branchId,
          type: "EffectRequested",
          producer: "supervisor",
          idempotencyKey: effectKey,
          payload: {
            ...(effect.payload as any),
            effectId,
            input: { ...(effect.payload as any).input, generationId },
            origin: { kind: "ai-generation", generationId },
            idempotencyKey: effectKey,
          },
        },
      ]);
      expect(await supervisor.storage.getOutbox(effectId)).toMatchObject({ status: "pending", attempt: 0 });
      expect(await supervisor.ai.cancel(generationId, "cancel before restart")).toMatchObject({ status: "cancelled" });
      expect(await supervisor.storage.getOutbox(effectId)).toMatchObject({ status: "cancelled", attempt: 1 });
      await supervisor.close();
      supervisor = undefined;

      const afterRestart = new TextGenerationProvider("pending-cancel");
      supervisor = await open(temp, [afterRestart]);
      expect(await supervisor.outbox.recover()).toMatchObject({ unknownEffectIds: [] });
      expect(await supervisor.ai.recoverIncomplete()).toBe(0);
      expect(await supervisor.outbox.drain()).toBe(0);
      expect(await supervisor.ai.get(generationId)).toMatchObject({ status: "cancelled" });
      expect(afterRestart.calls).toBe(0);
    } finally {
      if (supervisor) await supervisor.close();
    }
  });

  test("enforces generation and child reservations across service instances and attributes child usage", async () => {
    const temp = await makeTempRuntime("agencity-ai-generation-cross-service-"); temps.push(temp);
    const provider = new TextGenerationProvider("cross-service", "done", 500);
    const first = await open(temp, [provider]);
    const second = await open(temp, [provider]);
    try {
      const root = await first.createSession({
        workspaceId: "cross-service",
        model: { provider: provider.name, model: "fixture", maxOutputTokens: 16 },
        budget: { tokenLimit: 100_000, costLimitUsd: 10, turnLimit: 4, wallTimeLimitMs: 100_000 },
      });
      const admitted = await Promise.all(Array.from({ length: 4 }, (_, index) =>
        (index % 2 === 0 ? first : second).ai.admitText(root.sessionId, root.branchId, {
          prompt: `cross-service ${index}`,
          budget: { costLimitUsd: 2, wallTimeLimitMs: 20_000 },
          idempotencyKey: `cross-service-${index}`,
        }, { cellId: "shared-cell" })));
      await expect(second.ai.admitText(root.sessionId, root.branchId, {
        prompt: "fifth",
        idempotencyKey: "cross-service-fifth",
      }, { cellId: "shared-cell" })).rejects.toThrow(/per-cell admission bound|turns reservation exceeds/i);
      await expect(second.agents.spawn(root.sessionId, root.branchId, {
        task: "cannot overlap raw reservations",
        budget: { tokenLimit: 10_000, costLimitUsd: 1, turnLimit: 1, wallTimeLimitMs: 10_000 },
      })).rejects.toThrow(/active child reservations exceed parent/i);
      await Promise.all(admitted.map(item => first.ai.cancel(item.generationId)));

      const parent = await first.createSession({
        workspaceId: "child-attribution",
        model: { provider: provider.name, model: "fixture", maxOutputTokens: 16 },
        budget: { tokenLimit: 100_000, costLimitUsd: 10, turnLimit: 10, wallTimeLimitMs: 100_000 },
      });
      const child = await first.agents.spawn(parent.sessionId, parent.branchId, {
        task: "raw generation child",
        budget: { tokenLimit: 10_000, costLimitUsd: 1, turnLimit: 5, wallTimeLimitMs: 10_000 },
      });
      const childGeneration = await second.ai.admitText(child.sessionId, child.branchId, {
        prompt: "child raw generation",
        idempotencyKey: "child-raw-generation",
      });
      expect(await second.ai.result(childGeneration.generationId, { wait: true, timeoutMs: 5_000 }))
        .toMatchObject({ status: "succeeded" });
      await first.agents.completeTask(child.sessionId, child.branchId, { result: "done" });
      const parentEvents = await first.storage.loadEvents(parent.sessionId, { branchId: parent.branchId });
      expect(parentEvents.find(event =>
        event.type === "TaskUsageAttributed" &&
        (event.payload as any).taskId === child.taskId)?.payload)
        .toMatchObject({ tokens: 10, costUsd: 0.01, turns: 1, conservative: false });
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
    }
  });

  test("uses exact catalog pricing for overlapping cost reservations across service instances", async () => {
    const temp = await makeTempRuntime("agencity-ai-generation-priced-reservations-"); temps.push(temp);
    const provider = new KnownPricingBarrierProvider("priced-raw", "done");
    const catalogFetch = (async () => Response.json({
      data: [{
        id: "creator/priced",
        name: "Priced fixture",
        type: "language",
        context_window: 100_000,
        max_tokens: 16,
        pricing: { input: "0.000001", output: "0.000002" },
      }],
    })) as unknown as typeof fetch;
    const first = await open(temp, [provider], { fetch: catalogFetch });
    const second = await open(temp, [provider], { fetch: catalogFetch });
    try {
      await first.modelCatalog.refresh();
      await second.modelCatalog.refresh();
      const unaffordable = await first.createSession({
        workspaceId: "priced-unaffordable",
        model: { provider: provider.name, model: "creator/priced", maxOutputTokens: 16 },
        budget: { tokenLimit: 100_000, costLimitUsd: 0.00002, turnLimit: 10, wallTimeLimitMs: 100_000 },
      });
      await expect(first.ai.admitText(unaffordable.sessionId, unaffordable.branchId, {
        prompt: "must fail before provider execution",
        idempotencyKey: "priced-unaffordable",
      })).rejects.toThrow(/catalog-priced reservation exceeds.*cost limit/i);
      expect(provider.calls).toBe(0);
      const unaffordableEvents = await first.storage.loadEvents(
        unaffordable.sessionId,
        { branchId: unaffordable.branchId },
      );
      expect(unaffordableEvents.some(event =>
        event.type === "AiGenerationRequested" ||
        event.type === "EffectRequested")).toBe(false);

      const root = await first.createSession({
        workspaceId: "priced-reservations",
        model: { provider: provider.name, model: "creator/priced", maxOutputTokens: 16 },
        budget: { tokenLimit: 100_000, costLimitUsd: 0.001, turnLimit: 10, wallTimeLimitMs: 100_000 },
      });
      const admitted: Awaited<ReturnType<typeof first.ai.admitText>>[] = [];
      for (let index = 0; index < 3; index++) {
        const handle = await (index % 2 === 0 ? first : second).ai.admitText(root.sessionId, root.branchId, {
          prompt: `priced generation ${index}`,
          budget: { costLimitUsd: 0.0004, wallTimeLimitMs: 20_000 },
          idempotencyKey: `priced-generation-${index}`,
        });
        admitted.push(handle);
        if (index < 2) await provider.waitForStarts(index + 1);
      }
      const events = await first.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      const requests = events.filter(event =>
        event.type === "AiGenerationRequested" &&
        admitted.some(item => item.generationId === (event.payload as any).generationId));
      expect(requests).toHaveLength(3);
      const reservations = requests.map(event => {
        const payload = event.payload as any;
        expect(payload.reservation.costUsd).toBeCloseTo(
          payload.estimatedInputTokens * 0.000001 + 16 * 0.000002,
          12,
        );
        expect(payload.reservation.costUsd).toBeLessThan(0.0004);
        return payload.reservation.costUsd as number;
      });
      expect(reservations.reduce((sum, value) => sum + value, 0)).toBeLessThan(0.001);
      for (const [index, item] of admitted.entries()) {
        await provider.waitForStarts(index + 1);
        provider.releaseNext();
        await first.ai.result(item.generationId, {
          wait: true,
          timeoutMs: 5_000,
        });
      }
    } finally {
      provider.releaseAll();
      await Promise.allSettled([first.close(), second.close()]);
    }
  });

  test("atomically coordinates reservations and enforces per-cell concurrency", async () => {
    const temp = await makeTempRuntime("agencity-ai-generation-reservations-"); temps.push(temp);
    const provider = new TextGenerationProvider("reservation-text", "done", 500);
    const supervisor = await open(temp, [provider]);
    try {
      const root = await supervisor.createSession({
        workspaceId: "reservations",
        model: { provider: provider.name, model: "fixture", maxOutputTokens: 16 },
        budget: { turnLimit: 1, tokenLimit: 10_000, wallTimeLimitMs: 10_000 },
      });
      const admitted = await supervisor.ai.admitText(root.sessionId, root.branchId, {
        prompt: "first", idempotencyKey: "reservation-first",
      });
      await expect(supervisor.ai.admitText(root.sessionId, root.branchId, {
        prompt: "second", idempotencyKey: "reservation-second",
      })).rejects.toThrow(/turns reservation exceeds/i);
      await expect(supervisor.agents.spawn(root.sessionId, root.branchId, {
        task: "cannot overlap reserved raw call",
        budget: { turnLimit: 1, tokenLimit: 10_000, wallTimeLimitMs: 10_000 },
      })).rejects.toThrow(/active child reservations exceed parent/i);
      await supervisor.ai.cancel(admitted.generationId);

      const childReservedRoot = await supervisor.createSession({
        workspaceId: "child-reservation",
        model: { provider: provider.name, model: "fixture", maxOutputTokens: 16 },
        budget: { turnLimit: 1, tokenLimit: 10_000, wallTimeLimitMs: 10_000 },
      });
      await supervisor.agents.spawn(childReservedRoot.sessionId, childReservedRoot.branchId, {
        task: "reserve the only turn",
        budget: { turnLimit: 1, tokenLimit: 10_000, wallTimeLimitMs: 10_000 },
      });
      await expect(supervisor.ai.admitText(childReservedRoot.sessionId, childReservedRoot.branchId, {
        prompt: "cannot overlap child", idempotencyKey: "child-overlap",
      })).rejects.toThrow(/reservation exceeds the caller budget/i);

      const cellRoot = await supervisor.createSession({
        workspaceId: "cell-concurrency",
        model: { provider: provider.name, model: "fixture", maxOutputTokens: 16 },
      });
      const firstFour = await Promise.all(Array.from({ length: 4 }, (_, index) =>
        supervisor.ai.admitText(cellRoot.sessionId, cellRoot.branchId, {
          prompt: `cell ${index}`, idempotencyKey: `cell-${index}`,
        }, { cellId: "cell-concurrency" })));
      await expect(supervisor.ai.admitText(cellRoot.sessionId, cellRoot.branchId, {
        prompt: "cell fifth", idempotencyKey: "cell-fifth",
      }, { cellId: "cell-concurrency" })).rejects.toThrow(/at most 4.*concurrently/i);
      await Promise.all(firstFour.map(item => supervisor.ai.cancel(item.generationId)));
    } finally { await supervisor.close(); }
  });
});

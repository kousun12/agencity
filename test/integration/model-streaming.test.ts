import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentClient,
  EchoModelProvider,
  ModelExecutor,
  OpenAICompatibleProvider,
  ProtocolServer,
  Supervisor,
  ValidationError,
  projectEvents,
  type EffectProgressNotification,
  type JsonValue,
  type ModelConfiguration,
  type ModelOutputDelta,
  type ModelProvider,
  type ModelResponse,
} from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

class ControlledStreamingProvider implements ModelProvider {
  readonly capabilities = { streaming: true } as const;
  readonly displayName: string;
  readonly firstDelta = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  calls = 0;

  constructor(readonly name: string, readonly failAfterFirst = false) {
    this.displayName = `${name} (streaming test)`;
  }

  async complete(): Promise<ModelResponse> {
    throw new Error("complete must not be used for a streaming provider");
  }

  async stream(
    _context: JsonValue,
    _configuration: ModelConfiguration,
    signal: AbortSignal,
    onDelta: (delta: ModelOutputDelta) => void,
  ): Promise<ModelResponse> {
    this.calls++;
    onDelta({ text: "partial-alpha " });
    this.firstDelta.resolve();
    await Promise.race([
      this.release.promise,
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })),
    ]);
    if (this.failAfterFirst) throw new Error("stream interrupted by provider");
    onDelta({ text: "authoritative-omega" });
    return {
      text: "partial-alpha authoritative-omega",
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 4, costUsd: 0.01 },
    };
  }
}

class NonStreamingProvider implements ModelProvider {
  readonly name = "non-streaming";
  async complete(): Promise<ModelResponse> {
    return { text: "one committed response", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2, costUsd: 0 } };
  }
}

class BurstStreamingProvider implements ModelProvider {
  readonly name = "burst-streaming";
  readonly capabilities = { streaming: true } as const;
  async complete(): Promise<ModelResponse> { throw new Error("complete must not be used"); }
  async stream(
    _context: JsonValue,
    _configuration: ModelConfiguration,
    _signal: AbortSignal,
    onDelta: (delta: ModelOutputDelta) => void,
  ): Promise<ModelResponse> {
    for (let index = 0; index < 2_100; index++) onDelta({ text: "x" });
    return { text: "x".repeat(2_100), finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2_100, costUsd: 0 } };
  }
}

class CrossDeltaSecretProvider implements ModelProvider {
  readonly name = "cross-delta-secret";
  readonly capabilities = { streaming: true } as const;
  readonly firstDelta = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();

  constructor(readonly secret: string) {}
  async complete(): Promise<ModelResponse> { throw new Error("complete must not be used"); }
  async stream(
    _context: JsonValue,
    _configuration: ModelConfiguration,
    _signal: AbortSignal,
    onDelta: (delta: ModelOutputDelta) => void,
  ): Promise<ModelResponse> {
    const split = Math.floor(this.secret.length / 2);
    const text = `visible-before:${this.secret}:visible-after`;
    onDelta({ text: `visible-before:${this.secret.slice(0, split)}` });
    this.firstDelta.resolve();
    await this.release.promise;
    onDelta({ text: `${this.secret.slice(split)}:visible-after` });
    return { text, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 3, costUsd: 0 } };
  }
}

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

async function openWith(provider: ModelProvider): Promise<{ supervisor: Supervisor; sessionId: string; branchId: string }> {
  const temp = await makeTempRuntime("agencity-streaming-");
  temps.push(temp);
  const supervisor = await Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    modelProviders: [provider],
    recover: false,
  });
  const { sessionId, branchId } = await supervisor.createSession({
    workspaceId: "streaming",
    model: { provider: provider.name, model: "stream-v1" },
  });
  await supervisor.appendMessage(sessionId, branchId, "user", "stream truthfully");
  return { supervisor, sessionId, branchId };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

describe("provider output streaming", () => {
  test("delivers non-authoritative progress before one atomic committed completion", async () => {
    const provider = new ControlledStreamingProvider("controlled-success");
    const { supervisor, sessionId, branchId } = await openWith(provider);
    const progress: EffectProgressNotification[] = [];
    const unsubscribe = supervisor.outbox.onProgress((item) => progress.push(item));
    const turn = supervisor.modelLoop.turn(sessionId, branchId);

    await provider.firstDelta.promise;
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({
      type: "effect-progress", executor: "model", sequence: 0, kind: "model-output-delta",
      value: { text: "partial-alpha ", provider: provider.name, model: "stream-v1" },
    });
    let events = await supervisor.storage.loadEvents(sessionId, { branchId });
    expect(events.some((event) => event.type === "EffectRequested")).toBe(true);
    expect(events.some((event) => event.type === "EffectAttemptStarted")).toBe(true);
    expect(events.filter((event) => event.type === "EffectOutcomeRecorded")).toHaveLength(0);
    expect(events.filter((event) => event.type === "ModelOutputChunk")).toHaveLength(0);
    expect(events.filter((event) => event.type === "MessageAppended" && (event.payload as { role?: string }).role === "assistant")).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain("partial-alpha");

    provider.release.resolve();
    expect(await turn).toEqual({ outcome: "succeeded", message: "partial-alpha authoritative-omega" });
    unsubscribe();
    events = await supervisor.storage.loadEvents(sessionId, { branchId });
    const state = projectEvents(events);
    expect(progress.map((item) => (item.value as { text: string }).text).join(""))
      .toBe("partial-alpha authoritative-omega");
    expect(events.filter((event) => event.type === "EffectOutcomeRecorded")).toHaveLength(1);
    expect(events.filter((event) => event.type === "ModelOutputChunk")).toHaveLength(1);
    expect(events.filter((event) => event.type === "MessageAppended" && (event.payload as { role?: string }).role === "assistant")).toHaveLength(1);
    expect(state.messages.at(-1)?.content).toBe("partial-alpha authoritative-omega");
    expect(Object.values(state.modelCalls)[0]?.chunks).toEqual(["partial-alpha authoritative-omega"]);
    await supervisor.close();
  });

  test("discards partial progress when a stream fails", async () => {
    const provider = new ControlledStreamingProvider("controlled-failure", true);
    const { supervisor, sessionId, branchId } = await openWith(provider);
    const progress: EffectProgressNotification[] = [];
    const unsubscribe = supervisor.outbox.onProgress((item) => progress.push(item));
    const turn = supervisor.modelLoop.turn(sessionId, branchId);
    await provider.firstDelta.promise;
    provider.release.resolve();
    expect(await turn).toEqual({ outcome: "failed", error: "stream interrupted by provider" });
    unsubscribe();

    const events = await supervisor.storage.loadEvents(sessionId, { branchId });
    const state = projectEvents(events);
    expect(progress).toHaveLength(1);
    expect(events.filter((event) => event.type === "EffectOutcomeRecorded")).toHaveLength(1);
    expect(events.filter((event) => event.type === "ModelOutputChunk")).toHaveLength(0);
    expect(state.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    expect(Object.values(state.modelCalls)[0]).toMatchObject({ status: "failed", error: "stream interrupted by provider" });
    expect(JSON.stringify(events)).not.toContain("partial-alpha");
    await supervisor.close();
  });

  test("cancellation records one terminal outcome and commits no streamed prefix", async () => {
    const provider = new ControlledStreamingProvider("controlled-cancel");
    const { supervisor, sessionId, branchId } = await openWith(provider);
    let progress: EffectProgressNotification | undefined;
    const unsubscribe = supervisor.outbox.onProgress((item) => { progress = item; });
    const turn = supervisor.modelLoop.turn(sessionId, branchId);
    await provider.firstDelta.promise;
    expect(progress).toBeDefined();
    expect(supervisor.outbox.cancel(progress!.effectId)).toBe(true);
    expect(await turn).toEqual({ outcome: "cancelled", error: "Model call cancelled" });
    unsubscribe();

    const events = await supervisor.storage.loadEvents(sessionId, { branchId });
    expect(events.filter((event) => event.type === "EffectOutcomeRecorded")).toHaveLength(1);
    expect(events.filter((event) => event.type === "ModelCallTerminated")).toHaveLength(1);
    expect(events.filter((event) => event.type === "ModelOutputChunk")).toHaveLength(0);
    expect(projectEvents(events).messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    await supervisor.close();
  });

  test("a supervisor process killed mid-stream recovers unknown without a partial message", async () => {
    const temp = await makeTempRuntime("agencity-stream-recovery-");
    temps.push(temp);
    const seedProvider = new ControlledStreamingProvider("kill-stream");
    const seeded = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [seedProvider],
      recover: false,
    });
    const { sessionId, branchId } = await seeded.createSession({
      workspaceId: "stream-kill",
      model: { provider: "kill-stream", model: "kill-v1" },
    });
    await seeded.appendMessage(sessionId, branchId, "user", "be interrupted");
    await seeded.close();

    const marker = `${temp.directory}/progress-seen`;
    const childPath = `${temp.directory}/stream-child.ts`;
    const runtimeUrl = new URL("../../src/index.ts", import.meta.url).href;
    await Bun.write(childPath, `
      import { Supervisor } from ${JSON.stringify(runtimeUrl)};
      class KillProvider {
        name = "kill-stream";
        capabilities = { streaming: true };
        async complete() { throw new Error("complete must not run"); }
        async stream(_context, _configuration, signal, onDelta) {
          onDelta({ text: "partial-before-kill" });
          await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
          throw new Error("unreachable");
        }
      }
      const supervisor = await Supervisor.open({
        databaseUrl: ${JSON.stringify(temp.databaseUrl)},
        artifactDirectory: ${JSON.stringify(temp.artifactDirectory)},
        workspaceRoot: ${JSON.stringify(temp.workspaceRoot)},
        modelProviders: [new KillProvider()],
        recover: false,
      });
      supervisor.outbox.onProgress(() => { void Bun.write(${JSON.stringify(marker)}, "seen"); });
      await supervisor.modelLoop.turn(${JSON.stringify(sessionId)}, ${JSON.stringify(branchId)});
    `);
    const child = Bun.spawn([process.execPath, childPath], { stdout: "ignore", stderr: "pipe" });
    try {
      await waitUntil(() => Bun.file(marker).exists(), 5_000);
    } catch (error) {
      child.kill(9);
      const stderr = await new Response(child.stderr).text();
      throw new Error(`${error instanceof Error ? error.message : String(error)}; child stderr: ${stderr}`);
    }
    child.kill(9);
    await child.exited;

    const recovered = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
    });
    const events = await recovered.storage.loadEvents(sessionId, { branchId });
    expect(events.filter((event) => event.type === "EffectOutcomeRecorded")).toHaveLength(1);
    expect(events.find((event) => event.type === "EffectOutcomeRecorded")?.payload).toMatchObject({ outcome: "unknown" });
    expect(events.filter((event) => event.type === "ModelCallTerminated")).toHaveLength(1);
    expect(events.filter((event) => event.type === "ModelOutputChunk")).toHaveLength(0);
    expect(projectEvents(events).messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain("partial-before-kill");
    await recovered.close();
  });

  test("redacts a known brokered secret split across provider deltas", async () => {
    const environmentKey = "AGENCITY_STREAM_TEST_SECRET";
    const previous = process.env[environmentKey];
    const secret = "brokered-cross-delta-value";
    process.env[environmentKey] = secret;
    const provider = new CrossDeltaSecretProvider(secret);
    const { supervisor, sessionId, branchId } = await openWith(provider);
    const progress: EffectProgressNotification[] = [];
    const unsubscribe = supervisor.outbox.onProgress((item) => progress.push(item));
    const turn = supervisor.modelLoop.turn(sessionId, branchId);
    try {
      await provider.firstDelta.promise;
      expect(progress.map((item) => (item.value as { text?: string }).text ?? "").join(""))
        .toBe("visible-before:");
      expect(JSON.stringify(progress)).not.toContain(secret);

      provider.release.resolve();
      expect(await turn).toEqual({
        outcome: "succeeded",
        message: "visible-before:[REDACTED]:visible-after",
      });
      const visibleText = progress
        .filter((item) => item.kind === "model-output-delta")
        .map((item) => (item.value as { text: string }).text)
        .join("");
      expect(visibleText).toBe("visible-before:[REDACTED]:visible-after");
      expect(JSON.stringify(progress)).not.toContain(secret);

      const events = await supervisor.storage.loadEvents(sessionId, { branchId });
      expect(projectEvents(events).messages.at(-1)?.content)
        .toBe("visible-before:[REDACTED]:visible-after");
      expect(JSON.stringify(events)).not.toContain(secret);
    } finally {
      provider.release.resolve();
      unsubscribe();
      await supervisor.close();
      if (previous === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = previous;
    }
  });

  test("bounds ephemeral progress without truncating the authoritative completion", async () => {
    const provider = new BurstStreamingProvider();
    const { supervisor, sessionId, branchId } = await openWith(provider);
    const progress: EffectProgressNotification[] = [];
    const unsubscribe = supervisor.outbox.onProgress((item) => progress.push(item));
    const result = await supervisor.modelLoop.turn(sessionId, branchId);
    unsubscribe();
    expect(progress).toHaveLength(2_048);
    expect(progress.at(-1)).toMatchObject({
      sequence: 2_047,
      kind: "progress-truncated",
      value: { reason: "notification-limit", suppressedKind: "model-output-delta" },
    });
    expect(progress.filter((item) => item.kind === "model-output-delta")).toHaveLength(2_047);
    expect(result).toEqual({ outcome: "succeeded", message: "x".repeat(2_100) });
    const state = projectEvents(await supervisor.storage.loadEvents(sessionId, { branchId }));
    expect(state.messages.at(-1)?.content).toHaveLength(2_100);
    await supervisor.close();
  });

  test("reports non-streaming capability and uses only the committed response", async () => {
    const provider = new NonStreamingProvider();
    const { supervisor, sessionId, branchId } = await openWith(provider);
    expect(supervisor.modelProviders.find((item) => item.name === provider.name)).toMatchObject({
      displayName: provider.name,
      capabilities: { streaming: false },
    });
    expect(supervisor.modelProviders.find((item) => item.name === "echo")).toMatchObject({
      displayName: "Echo (internal test fixture; non-streaming)",
      capabilities: { streaming: false },
    });
    const progress: EffectProgressNotification[] = [];
    const unsubscribe = supervisor.outbox.onProgress((item) => progress.push(item));
    expect(await supervisor.modelLoop.turn(sessionId, branchId)).toEqual({ outcome: "succeeded", message: "one committed response" });
    unsubscribe();
    expect(progress).toHaveLength(0);
    await supervisor.close();

    expect(() => new ModelExecutor([{
      name: "lying-provider",
      capabilities: { streaming: true },
      async complete() { return { text: "", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }; },
    }])).toThrow(ValidationError);
  });

  test("parses OpenAI-compatible SSE incrementally and requires a terminal marker", async () => {
    const requests: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push(await request.json() as Record<string, unknown>);
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"hello "},"finish_reason":null}]}\n`));
            controller.enqueue(encoder.encode(`\ndata: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n\n`));
            controller.enqueue(encoder.encode(`data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2},"cost_usd":0.02}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: `http://${server.hostname}:${server.port}/v1`, apiKey: () => "test-key", providerName: "openai-test" });
      const deltas: string[] = [];
      const response = await provider.stream!({}, { provider: provider.name, model: "gpt-test" }, new AbortController().signal, (delta) => deltas.push(delta.text));
      expect(requests[0]).toMatchObject({ model: "gpt-test", stream: true, stream_options: { include_usage: true } });
      expect(deltas).toEqual(["hello ", "world"]);
      expect(response).toEqual({ text: "hello world", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.02 } });
    } finally { server.stop(true); }

    const incomplete = Bun.serve({
      port: 0,
      fetch() { return new Response(`data: {"choices":[{"delta":{"content":"orphan"}}]}\n\n`, { headers: { "content-type": "text/event-stream" } }); },
    });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: `http://${incomplete.hostname}:${incomplete.port}`, apiKey: () => "test-key" });
      await expect(provider.stream!({}, { provider: "openai", model: "gpt-test" }, new AbortController().signal, () => {}))
        .rejects.toThrow("Model stream ended before [DONE]");
    } finally { incomplete.stop(true); }
  });

  test("explicitly disables OpenAI-compatible streaming without fallback", async () => {
    const requests: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push(await request.json() as Record<string, unknown>);
        return Response.json({
          choices: [{ message: { content: "non-streaming endpoint response" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        });
      },
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl: `http://${server.hostname}:${server.port}/v1`,
      apiKey: () => "test-key",
      providerName: "openai-no-stream",
      streaming: false,
    });
    let supervisor: Supervisor | undefined;
    try {
      const opened = await openWith(provider);
      supervisor = opened.supervisor;
      const { sessionId, branchId } = opened;
      expect(supervisor.modelProviders.find((item) => item.name === provider.name)).toMatchObject({
        displayName: "openai-no-stream (OpenAI-compatible; non-streaming)",
        capabilities: { streaming: false },
      });
      const progress: EffectProgressNotification[] = [];
      const unsubscribe = supervisor.outbox.onProgress((item) => progress.push(item));
      try {
        expect(await supervisor.modelLoop.turn(sessionId, branchId)).toEqual({
          outcome: "succeeded",
          message: "non-streaming endpoint response",
        });
      } finally { unsubscribe(); }
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty("stream");
      expect(progress).toHaveLength(0);
    } finally {
      await supervisor?.close();
      server.stop(true);
    }
  });

  test("SSE clients receive progress without a cursor and reconnect through committed history only", async () => {
    const provider = new ControlledStreamingProvider("protocol-stream");
    const { supervisor, sessionId, branchId } = await openWith(provider);
    const protocol = new ProtocolServer(supervisor);
    const server = protocol.listen(0);
    const base = `http://${server.hostname}:${server.port}`;
    const client = new AgentClient(base);
    try {
      expect(await client.modelProviders()).toContainEqual(expect.objectContaining({ name: provider.name, capabilities: { streaming: true } }));
      const snapshot = await client.snapshot(sessionId, branchId);
      const controller = new AbortController();
      const committed: string[] = [];
      const progress: EffectProgressNotification[] = [];
      const live = client.stream(sessionId, branchId, snapshot.cursor, {
        onEvent: (event) => committed.push(event.cursor),
        onProgress: (item) => progress.push(item),
      }, controller.signal);
      const rawRequest = fetch(`${base}/sessions/${sessionId}/stream?branch=${branchId}&after=${snapshot.cursor}`);
      await Bun.sleep(20);
      const turn = supervisor.modelLoop.turn(sessionId, branchId);
      await provider.firstDelta.promise;
      await waitUntil(() => progress.length === 1);
      expect(committed).not.toContain(progress[0]!.sequence.toString());

      const raw = await rawRequest;
      const reader = raw.body!.getReader();
      let rawFrames = "";
      while (!rawFrames.includes("event: progress")) {
        const { done, value } = await reader.read();
        if (done) throw new Error("SSE ended before progress");
        rawFrames += new TextDecoder().decode(value);
      }
      const progressFrame = rawFrames.split("\n\n").find((frame) => frame.includes("event: progress"));
      expect(progressFrame).toBeDefined();
      expect(progressFrame).not.toContain("id:");
      await reader.cancel();

      provider.release.resolve();
      expect((await turn).outcome).toBe("succeeded");
      await waitUntil(() => committed.length > 0);
      controller.abort();
      await live.catch((error) => { if (!(error instanceof DOMException && error.name === "AbortError")) throw error; });
      expect(committed.every((cursor, index) => index === 0 || BigInt(cursor) > BigInt(committed[index - 1]!))).toBe(true);

      // Reconnecting from the pre-turn cursor catches up only canonical events;
      // the earlier progress is not replayed and cannot advance the cursor.
      const reconnectController = new AbortController();
      const replayTypes: string[] = [];
      const replayProgress: EffectProgressNotification[] = [];
      const reconnect = client.stream(sessionId, branchId, snapshot.cursor, {
        onEvent: (event) => replayTypes.push(event.type),
        onProgress: (item) => replayProgress.push(item),
      }, reconnectController.signal);
      await waitUntil(() => replayTypes.includes("ModelCallCompleted"));
      reconnectController.abort();
      await reconnect.catch((error) => { if (!(error instanceof DOMException && error.name === "AbortError")) throw error; });
      expect(replayTypes).toContain("ModelOutputChunk");
      expect(replayTypes).toContain("ModelCallCompleted");
      expect(replayProgress).toHaveLength(0);
    } finally {
      protocol.stop();
      await supervisor.close();
    }
  });
});

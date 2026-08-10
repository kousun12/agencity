import { afterEach, describe, expect, test } from "bun:test";
import {
  ModelExecutor,
  PROVIDER_INPUT_ESTIMATOR_ID,
  buildProviderInputCandidate,
  createAnthropicModelProvider,
  createOpenAIModelProvider,
  createVercelModelProvider,
  nativeModelId,
} from "../../src/index.ts";
import { registerBrokeredSecret } from "../../src/security/index.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

describe("AI SDK product model providers", () => {
  test("uses the Anthropic AI SDK transport with a native model ID", async () => {
    let observed: { path: string; key: string | null; body: Record<string, unknown> } | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: async request => {
        observed = {
          path: new URL(request.url).pathname,
          key: request.headers.get("x-api-key"),
          body: await request.json() as Record<string, unknown>,
        };
        return Response.json({
          id: "message-test",
          type: "message",
          role: "assistant",
          model: "claude-fable-5",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 3 },
        });
      },
    });
    servers.push(server);
    const provider = createAnthropicModelProvider({
      origin: server.url.origin,
      apiKey: () => "anthropic-test-key",
    });
    const response = await provider.complete(
      { messages: [{ role: "system", content: "system rules" }, { role: "user", content: "hello" }] },
      { provider: "anthropic", model: "anthropic/claude.fable.5", reasoningEffort: "high" },
      new AbortController().signal,
    );
    expect(response).toMatchObject({ text: "done", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 3 } });
    expect(observed).toMatchObject({
      path: "/v1/messages",
      key: "anthropic-test-key",
      body: {
        model: "claude-fable-5",
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
        system: [{ type: "text", text: "system rules" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      },
    });
  });

  test("streams OpenAI AI SDK deltas and returns one authoritative response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response([
        `data: ${JSON.stringify({ id: "chunk-1", object: "chat.completion.chunk", created: 1, model: "gpt-5.4", choices: [{ index: 0, delta: { role: "assistant", content: "hello " }, finish_reason: null }] })}`,
        "",
        `data: ${JSON.stringify({ id: "chunk-1", object: "chat.completion.chunk", created: 1, model: "gpt-5.4", choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }] })}`,
        "",
        `data: ${JSON.stringify({ id: "chunk-1", object: "chat.completion.chunk", created: 1, model: "gpt-5.4", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
        "",
        `data: ${JSON.stringify({ id: "chunk-1", object: "chat.completion.chunk", created: 1, model: "gpt-5.4", choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } }),
    });
    servers.push(server);
    const provider = createOpenAIModelProvider({ origin: server.url.origin, apiKey: () => "openai-test-key" });
    const deltas: string[] = [];
    const response = await provider.stream!(
      { messages: [{ role: "user", content: "hello" }] },
      { provider: "openai", model: "openai/gpt-5.4", reasoningEffort: "provider-default" },
      new AbortController().signal,
      delta => deltas.push(delta.text),
    );
    expect(deltas.join("")).toBe("hello world");
    expect(response).toMatchObject({
      text: "hello world",
      finishReason: "stop",
      usage: { inputTokens: 4, outputTokens: 2 },
    });
  });

  test("rejects a cleanly truncated provider stream instead of committing partial text", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response([
        `data: ${JSON.stringify({ id: "chunk-truncated", object: "chat.completion.chunk", created: 1, model: "gpt-5.4", choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] })}`,
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } }),
    });
    servers.push(server);
    const provider = createOpenAIModelProvider({ origin: server.url.origin, apiKey: () => "openai-test-key" });
    await expect(provider.stream!(
      { messages: [{ role: "user", content: "hello" }] },
      { provider: "openai", model: "openai/gpt-5.4", reasoningEffort: "provider-default" },
      new AbortController().signal,
      () => {},
    )).rejects.toThrow("without a confirmed terminal provider outcome");
  });

  test("uses the OpenAI AI SDK transport and maps explicit reasoning", async () => {
    let observed: { path: string; authorization: string | null; body: Record<string, unknown> } | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: async request => {
        observed = {
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body: await request.json() as Record<string, unknown>,
        };
        return Response.json({
          id: "chat-test",
          object: "chat.completion",
          created: 1,
          model: "gpt-5.4",
          choices: [{ index: 0, message: { role: "assistant", content: "reasoned" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        });
      },
    });
    servers.push(server);
    const provider = createOpenAIModelProvider({ origin: server.url.origin, apiKey: () => "openai-test-key" });
    const response = await provider.complete(
      { messages: [{ role: "user", content: "hello" }] },
      { provider: "openai", model: "openai/gpt-5.4", reasoningEffort: "high", temperature: 0.5 },
      new AbortController().signal,
    );
    expect(response.text).toBe("reasoned");
    expect(response.warnings).toEqual([{
      kind: "unsupported",
      message: "temperature is not supported for reasoning models",
    }]);
    expect(observed).toMatchObject({
      path: "/v1/chat/completions",
      authorization: "Bearer openai-test-key",
      body: { model: "gpt-5.4", reasoning_effort: "high" },
    });
  });

  test("keeps gateway model IDs intact and classifies failed requests", async () => {
    let observedPath = "";
    const gatewayFetch = (async (input: string | URL | Request) => {
      observedPath = new URL(input instanceof Request ? input.url : input).pathname;
      return Response.json({ error: { message: "gateway rejected request" } }, { status: 401 });
    }) as typeof globalThis.fetch;
    const provider = createVercelModelProvider({
      origin: "https://gateway.example.test",
      apiKey: () => "gateway-test-key",
      fetch: gatewayFetch,
    });
    await expect(provider.complete(
      { messages: [{ role: "user", content: "hello" }] },
      { provider: "vercel", model: "openai/gpt-test", reasoningEffort: "provider-default" },
      new AbortController().signal,
    )).rejects.toThrow();
    expect(observedPath).toContain("/v4/ai");
    expect(nativeModelId("vercel", "openai/gpt-test")).toBe("openai/gpt-test");
  });

  test("uses the Gateway v4 model contract with normalized reasoning and retained cost", async () => {
    let observed: { path: string; model: string | null; body: Record<string, unknown> } | null = null;
    const provider = createVercelModelProvider({
      origin: "https://gateway.example.test",
      apiKey: () => "gateway-test-key",
      fetch: (async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        observed = {
          path: new URL(request.url).pathname,
          model: request.headers.get("ai-language-model-id"),
          body: await request.json() as Record<string, unknown>,
        };
        return Response.json({
          content: [{ type: "text", text: "gateway done" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 7, noCache: 7 },
            outputTokens: { total: 2, text: 2 },
          },
          providerMetadata: { gateway: { cost: "0.0042" } },
        });
      }) as typeof globalThis.fetch,
    });
    const response = await provider.complete(
      { messages: [{ role: "user", content: "hello" }] },
      { provider: "vercel", model: "anthropic/claude-sonnet-5", reasoningEffort: "high" },
      new AbortController().signal,
    );
    expect(observed).toMatchObject({
      path: "/v4/ai/language-model",
      model: "anthropic/claude-sonnet-5",
      body: { reasoning: "high" },
    });
    expect(response).toMatchObject({
      text: "gateway done",
      finishReason: "stop",
      usage: { inputTokens: 7, outputTokens: 2, costUsd: 0.0042 },
    });
  });

  test("does not classify output-token validation errors as context overflow", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: { message: "maximum output token limit exceeded" } }, { status: 400 }),
    });
    servers.push(server);
    const executor = new ModelExecutor([
      createOpenAIModelProvider({ origin: server.url.origin, apiKey: () => "openai-test-key" }),
    ]);
    const configuration = { provider: "openai", model: "openai/gpt-5.4", reasoningEffort: "provider-default" } as const;
    const dispatch = executor.resolveDispatch(configuration);
    const resolvedCapacity = executor.contextCapacity(dispatch.configuration);
    const providerInput = buildProviderInputCandidate({
      context: { messages: [{ role: "user", content: "hello" }] },
      modelDispatch: dispatch,
      capacity: {
        ...resolvedCapacity,
        outputReserveTokens: 0,
        estimatorId: PROVIDER_INPUT_ESTIMATOR_ID,
        triggerRatio: 0.8,
        targetRatio: 0.6,
      },
    });
    const execution = await executor.execute({
      effectId: "effect-output-limit",
      sessionId: "session",
      branchId: "branch",
      executor: "model",
      operation: "complete",
      input: { callId: "call-output-limit", providerInput, modelDispatch: dispatch } as any,
      idempotencyKey: "effect-output-limit",
      idempotent: false,
      attempt: 1,
    }, { signal: new AbortController().signal });
    expect(execution).toMatchObject({
      outcome: "failed",
      modelFailure: "provider-request-failed",
    });
  });

  test("redacts brokered credentials from retained provider warnings", async () => {
    const secret = "warning-secret-value";
    const release = registerBrokeredSecret(secret);
    try {
      const executor = new ModelExecutor([{
        name: "fixture",
        complete: async () => ({
          text: "done",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          warnings: [{ kind: "provider", message: `provider echoed ${secret}` }],
        }),
      }]);
      const configuration = { provider: "fixture", model: "fixture-model", reasoningEffort: "provider-default" } as const;
      const dispatch = executor.resolveDispatch(configuration);
      const resolvedCapacity = executor.contextCapacity(dispatch.configuration);
      const providerInput = buildProviderInputCandidate({
        context: {},
        modelDispatch: dispatch,
        capacity: {
          ...resolvedCapacity,
          outputReserveTokens: 0,
          estimatorId: PROVIDER_INPUT_ESTIMATOR_ID,
          triggerRatio: 0.8,
          targetRatio: 0.6,
        },
      });
      const execution = await executor.execute({
        effectId: "effect-warning-redaction",
        sessionId: "session",
        branchId: "branch",
        executor: "model",
        operation: "complete",
        input: { callId: "call-warning-redaction", providerInput, modelDispatch: dispatch } as any,
        idempotencyKey: "effect-warning-redaction",
        idempotent: false,
        attempt: 1,
      }, { signal: new AbortController().signal });
      expect(execution.outcome).toBe("succeeded");
      expect(JSON.stringify(execution.output)).toContain("[REDACTED]");
      expect(JSON.stringify(execution.output)).not.toContain(secret);
    } finally {
      release();
    }
  });

  test("validates canonical transport IDs and reports credential availability without secrets", () => {
    expect(nativeModelId("openai", "openai/gpt-test")).toBe("gpt-test");
    expect(nativeModelId("anthropic", "anthropic/claude.fable.5")).toBe("claude-fable-5");
    expect(() => nativeModelId("openai", "anthropic/claude-test")).toThrow();
    let key: string | undefined;
    const executor = new ModelExecutor([createAnthropicModelProvider({
      origin: "https://api.anthropic.com",
      apiKey: () => key,
      availability: () => ({
        usable: Boolean(key),
        credentialSource: key ? "stored" : "missing",
        ...(key ? {} : { remediation: "configure it" }),
      }),
    })]);
    expect(executor.providers()[0]).toMatchObject({ name: "anthropic", usable: false, credentialSource: "missing" });
    key = "secret-value";
    expect(executor.providers()[0]).toMatchObject({ name: "anthropic", usable: true, credentialSource: "stored" });
    expect(JSON.stringify(executor.providers())).not.toContain(key);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import {
  AnthropicCompatibleProvider,
  ModelExecutor,
} from "../../src/index.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

describe("built-in model provider protocols", () => {
  test("uses Anthropic Messages with short-name normalization", async () => {
    let observed: { path: string; key: string | null; body: any } | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: async request => {
        observed = {
          path: new URL(request.url).pathname,
          key: request.headers.get("x-api-key"),
          body: await request.json(),
        };
        return Response.json({
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 12, output_tokens: 3 },
        });
      },
    });
    servers.push(server);
    const provider = new AnthropicCompatibleProvider({
      baseUrl: `http://${server.hostname}:${server.port}`,
      apiKey: () => "anthropic-test-key",
      normalizeModel: model => model.startsWith("claude-") ? model : `claude-${model}`,
      streaming: false,
    });
    expect(provider.normalizeModel("fable-5")).toBe("claude-fable-5");
    const response = await provider.complete({
      messages: [
        { role: "system", content: "system rules" },
        { role: "user", content: "hello" },
      ],
    }, { provider: "anthropic", model: "claude-fable-5" }, new AbortController().signal);
    expect(response).toMatchObject({ text: "done", finishReason: "end_turn", usage: { inputTokens: 12, outputTokens: 3 } });
    expect(observed).toMatchObject({
      path: "/v1/messages",
      key: "anthropic-test-key",
      body: {
        model: "claude-fable-5",
        system: "system rules",
        messages: [{ role: "user", content: "hello" }],
      },
    });
  });

  test("streams Vercel AI Gateway model IDs containing slashes", async () => {
    let model = "";
    const server = Bun.serve({
      port: 0,
      fetch: async request => {
        model = String((await request.json() as { model?: string }).model ?? "");
        return new Response([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"gate"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"way"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(server);
    const provider = new AnthropicCompatibleProvider({
      baseUrl: `http://${server.hostname}:${server.port}`,
      apiKey: () => "gateway-test-key",
      providerName: "vercel",
    });
    const deltas: string[] = [];
    const response = await provider.stream!({
      messages: [{ role: "user", content: "hello" }],
    }, { provider: "vercel", model: "openai/gpt-5.6-sol" }, new AbortController().signal, delta => deltas.push(delta.text));
    expect(model).toBe("openai/gpt-5.6-sol");
    expect(deltas).toEqual(["gate", "way"]);
    expect(response).toMatchObject({ text: "gateway", finishReason: "end_turn", usage: { inputTokens: 7, outputTokens: 2 } });
  });

  test("retains Anthropic stream error details", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Provider is overloaded"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    });
    servers.push(server);
    const provider = new AnthropicCompatibleProvider({
      baseUrl: `http://${server.hostname}:${server.port}`,
      apiKey: () => "anthropic-test-key",
    });

    await expect(provider.stream!(
      { messages: [{ role: "user", content: "hello" }] },
      { provider: "anthropic", model: "claude-fable-5" },
      new AbortController().signal,
      () => {},
    )).rejects.toThrow("overloaded_error: Provider is overloaded");
  });

  test("reports credential availability without exposing key values", () => {
    let key: string | undefined;
    const executor = new ModelExecutor([new AnthropicCompatibleProvider({
      baseUrl: "https://example.invalid",
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

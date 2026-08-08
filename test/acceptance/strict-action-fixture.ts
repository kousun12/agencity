export interface FixtureProbe {
  readonly task: string | null;
  readonly step: number | null;
  readonly streaming: boolean;
  readonly model: string;
  readonly lastUserText: string;
}

type Reply = string | Record<string, unknown>;
type ReplyFactory = (probe: FixtureProbe) => Reply;

interface RequestLog extends FixtureProbe {
  readonly receivedAt: string;
  readonly authorization: string | null;
}

interface Gate {
  readonly promise: Promise<void>;
  release(): void;
}

export class StrictActionFixture {
  readonly requests: RequestLog[] = [];
  readonly server: ReturnType<typeof Bun.serve>;
  readonly scripts = new Map<string, readonly (Reply | ReplyFactory)[]>();
  readonly gates = new Map<string, Gate>();

  constructor() {
    this.server = Bun.serve({ port: 0, fetch: request => this.handle(request) });
  }

  get baseUrl(): string { return `http://127.0.0.1:${this.server.port}`; }

  environment(): Record<string, string> {
    return {
      OPENAI_API_KEY: "acceptance-fixture-key",
      OPENAI_BASE_URL: this.baseUrl,
      OPENAI_MODEL: "openai/fixture-v1",
      AI_GATEWAY_BASE_URL: this.baseUrl,
    };
  }

  script(task: string, replies: readonly (Reply | ReplyFactory)[]): void {
    this.scripts.set(task, replies);
  }

  hold(task: string, step = 1): void {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    this.gates.set(this.key(task, step), { promise, release });
  }

  release(task: string, step = 1): void {
    this.gates.get(this.key(task, step))?.release();
  }

  async waitFor(task: string, step = 1, timeoutMs = 10_000): Promise<RequestLog> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.requests.find(item => item.task === task && item.step === step);
      if (found) return found;
      await Bun.sleep(25);
    }
    throw new Error(`fixture did not receive ${task} step ${step}`);
  }

  count(task: string): number { return this.requests.filter(item => item.task === task).length; }

  close(): void {
    for (const gate of this.gates.values()) gate.release();
    this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({
        data: [{
          id: "openai/fixture-v1",
          name: "OpenAI fixture v1",
          type: "language",
          context_window: 128_000,
          max_tokens: 16_384,
          pricing: { input: "0", output: "0" },
          tags: ["reasoning"],
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
        }],
      });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const authorization = request.headers.get("authorization");
    if (authorization !== "Bearer acceptance-fixture-key") return new Response("unauthorized", { status: 401 });
    const body = await request.json() as { model?: unknown; stream?: unknown; messages?: Array<{ role?: unknown; content?: unknown }>; tools?: unknown };
    if (typeof body.model !== "string" || !Array.isArray(body.messages)) return new Response("invalid request", { status: 400 });
    const lastUser = [...body.messages].reverse().find(item => item.role === "user");
    const lastUserText = messageText(lastUser?.content);
    const durable = this.readDurableStep(lastUserText);
    const probe: FixtureProbe = {
      task: durable?.task ?? null,
      step: durable?.stepOrdinal ?? null,
      streaming: body.stream === true,
      model: body.model,
      lastUserText,
    };
    this.requests.push({ ...probe, receivedAt: new Date().toISOString(), authorization });
    const gate = durable ? this.gates.get(this.key(durable.task, durable.stepOrdinal)) : undefined;
    if (gate) await Promise.race([gate.promise, new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }))]);
    if (request.signal.aborted) return new Response(null, { status: 499 });

    const selected = durable ? this.scripts.get(durable.task)?.[durable.stepOrdinal - 1] : undefined;
    const reviewId = JSON.stringify(body.messages).match(/refinement-review-[a-f0-9]{32}/)?.[0];
    const fallback: Reply = durable
      ? action("final", `fixture completed: ${durable.task}`)
      : reviewId
        ? { protocol: "agencity.refinement-review", version: 1, reviewId, status: "no_change", reason: "The frozen trajectory does not justify an evidence-backed change.", evidenceEventIds: [] }
        : `fixture recursive response: ${lastUserText.slice(-200)}`;
    const reply = typeof selected === "function" ? selected(probe) : selected ?? fallback;
    const text = typeof reply === "string" ? reply : JSON.stringify(reply);
    const toolCall = Array.isArray(body.tools) && typeof reply !== "string" ? formalToolCall(reply) : null;
    if (body.stream !== true) return Response.json({
      id: "fixture-completion",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [{
        index: 0,
        message: toolCall
          ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: `fixture-tool-${durable?.stepOrdinal ?? 1}`, type: "function", function: toolCall }] }
          : { role: "assistant", content: text },
        finish_reason: toolCall ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: 7, completion_tokens: Math.ceil(text.length / 4), total_tokens: 7 + Math.ceil(text.length / 4) },
    });
    const chunks = split(toolCall?.arguments ?? text, 3);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const envelope = (choices: unknown[], usage?: unknown) => ({
          id: "fixture-chunk",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices,
          ...(usage === undefined ? {} : { usage }),
        });
        for (const [index, chunk] of chunks.entries()) {
          const delta = toolCall
            ? { tool_calls: [{ index: 0, ...(index === 0 ? { id: `fixture-tool-${durable?.stepOrdinal ?? 1}`, type: "function" } : {}), function: { ...(index === 0 ? { name: toolCall.name } : {}), arguments: chunk } }] }
            : { content: chunk };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope([{ index: 0, delta, finish_reason: null }]))}\n\n`));
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope([{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }]))}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope([], { prompt_tokens: 7, completion_tokens: Math.ceil(text.length / 4), total_tokens: 7 + Math.ceil(text.length / 4) }))}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });
  }

  private readDurableStep(text: string): { task: string; stepOrdinal: number } | null {
    const marker = "AGENCITY DURABLE RUN STEP\n";
    const offset = text.indexOf(marker);
    if (offset < 0) return null;
    try {
      const value = JSON.parse(text.slice(offset + marker.length)) as { task?: unknown; stepOrdinal?: unknown };
      return typeof value.task === "string" && typeof value.stepOrdinal === "number" ? { task: value.task, stepOrdinal: value.stepOrdinal } : null;
    } catch { return null; }
  }

  private key(task: string, step: number): string { return `${task}\0${step}`; }
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(part =>
    part && typeof part === "object" && !Array.isArray(part) &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : "",
  ).join("");
}

function split(text: string, parts: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / parts));
  const result: string[] = [];
  for (let index = 0; index < text.length; index += size) result.push(text.slice(index, index + size));
  return result.length ? result : [""];
}

function formalToolCall(reply: Record<string, unknown>): { name: "bun_console" | "finish"; arguments: string } | null {
  if ((reply.name === "bun_console" || reply.name === "finish") &&
      reply.input && typeof reply.input === "object" && !Array.isArray(reply.input)) {
    return { name: reply.name, arguments: JSON.stringify(reply.input) };
  }
  return null;
}

export function action(type: "final" | "failed" | "blocked" | "typescript", value: string): Record<string, unknown> {
  if (type === "typescript") return { name: "bun_console", input: { source: value } };
  if (type === "final") return { name: "finish", input: { outcome: { message: value } } };
  return { name: "finish", input: { outcome: { status: type, message: value } } };
}

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

  get baseUrl(): string { return `http://127.0.0.1:${this.server.port}/v1`; }

  environment(): Record<string, string> {
    return { OPENAI_API_KEY: "acceptance-fixture-key", OPENAI_BASE_URL: this.baseUrl, OPENAI_MODEL: "fixture-v1" };
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
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const authorization = request.headers.get("authorization");
    if (authorization !== "Bearer acceptance-fixture-key") return new Response("unauthorized", { status: 401 });
    const body = await request.json() as { model?: unknown; stream?: unknown; messages?: Array<{ role?: unknown; content?: unknown }> };
    if (typeof body.model !== "string" || !Array.isArray(body.messages)) return new Response("invalid request", { status: 400 });
    const lastUserText = [...body.messages].reverse().find(item => item.role === "user" && typeof item.content === "string")?.content as string | undefined ?? "";
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
      ? { protocol: "agencity.agent-action", version: 1, type: "final", content: `fixture completed: ${durable.task}` }
      : reviewId
        ? { protocol: "agencity.refinement-review", version: 1, reviewId, status: "no_change", reason: "The frozen trajectory does not justify an evidence-backed change.", evidenceEventIds: [] }
        : `fixture recursive response: ${lastUserText.slice(-200)}`;
    const reply = typeof selected === "function" ? selected(probe) : selected ?? fallback;
    const text = typeof reply === "string" ? reply : JSON.stringify(reply);
    if (body.stream !== true) return Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: Math.ceil(text.length / 4) } });
    const chunks = split(text, 3);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, finish_reason: null }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: Math.ceil(text.length / 4) } })}\n\n`));
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

function split(text: string, parts: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / parts));
  const result: string[] = [];
  for (let index = 0; index < text.length; index += size) result.push(text.slice(index, index + size));
  return result.length ? result : [""];
}

export function action(type: "final" | "failed" | "blocked" | "typescript", value: string): Record<string, unknown> {
  const base = { protocol: "agencity.agent-action", version: 1, type };
  if (type === "final") return { ...base, content: value };
  if (type === "failed") return { ...base, error: value };
  if (type === "blocked") return { ...base, reason: value };
  return { ...base, code: value };
}

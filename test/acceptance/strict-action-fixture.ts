export interface FixtureProbe {
  readonly task: string | null;
  readonly step: number | null;
  readonly governanceStep: number | null;
  readonly proposalId: string | null;
  readonly streaming: boolean;
  readonly model: string;
  readonly messageRoles: readonly string[];
  readonly allMessageText: string;
  readonly firstUserText: string;
  readonly lastUserText: string;
  readonly toolNames: readonly string[];
  readonly toolChoice: string | null;
  readonly parallelToolCalls: boolean | null;
}

export type FixtureCatalogMode = "normal" | "delayed" | "unavailable" | "hostile";

export interface FixtureCatalogRequestLog {
  readonly receivedAt: string;
  readonly authorization: string | null;
}

export interface StrictActionFixtureOptions {
  readonly catalogMode?: FixtureCatalogMode;
}

export const FIXTURE_CATALOG_MODELS = [
  {
    id: "openai/fixture-v1",
    name: "Fixture Reasoner",
    type: "language",
    context_window: 128_000,
    max_tokens: 16_384,
    pricing: { input: "0", output: "0" },
    tags: ["reasoning"],
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
  },
  {
    id: "openai/fixture-mini-v1",
    name: "Fixture Mini",
    type: "language",
    context_window: 64_000,
    max_tokens: 8_192,
    pricing: { input: "0", output: "0" },
    tags: [],
    reasoning_options: [],
  },
] as const;

const HOSTILE_FIXTURE_CATALOG_MODELS = [
  {
    ...FIXTURE_CATALOG_MODELS[0],
    name: "Fixture\n\u001b[31mScarlet\u001b[0m \u202eoverride\u2069 模型界🚀",
  },
  {
    ...FIXTURE_CATALOG_MODELS[1],
    name: "Mini\r\n\u001b[2J\u2066catalog\u2069 試験模型",
  },
] as const;

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
  readonly catalogRequests: FixtureCatalogRequestLog[] = [];
  readonly server: ReturnType<typeof Bun.serve>;
  readonly scripts = new Map<string, readonly (Reply | ReplyFactory)[]>();
  governanceScripts: readonly (Reply | ReplyFactory)[] = [];
  readonly gates = new Map<string, Gate>();
  private catalogGate: Gate | null = null;
  private currentCatalogMode: FixtureCatalogMode;

  constructor(options: StrictActionFixtureOptions = {}) {
    this.currentCatalogMode = options.catalogMode ?? "normal";
    if (this.currentCatalogMode === "delayed") this.catalogGate = this.createGate();
    this.server = Bun.serve({ port: 0, fetch: request => this.handle(request) });
  }

  get baseUrl(): string { return `http://127.0.0.1:${this.server.port}`; }
  get catalogMode(): FixtureCatalogMode { return this.currentCatalogMode; }

  environment(): Record<string, string> {
    return {
      OPENAI_API_KEY: "acceptance-fixture-key",
      OPENAI_BASE_URL: this.baseUrl,
      OPENAI_MODEL: "openai/fixture-v1",
      AI_GATEWAY_BASE_URL: this.baseUrl,
    };
  }

  firstRunEnvironment(): Record<string, string> {
    return {
      OPENAI_BASE_URL: this.baseUrl,
      AI_GATEWAY_BASE_URL: this.baseUrl,
    };
  }

  setCatalogMode(mode: FixtureCatalogMode): void {
    this.catalogGate?.release();
    this.currentCatalogMode = mode;
    this.catalogGate = mode === "delayed" ? this.createGate() : null;
  }

  releaseCatalog(): void {
    this.catalogGate?.release();
  }

  async waitForCatalog(count = 1, timeoutMs = 10_000): Promise<FixtureCatalogRequestLog> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.catalogRequests[count - 1];
      if (found) return found;
      await Bun.sleep(25);
    }
    throw new Error(`fixture did not receive catalog request ${count}`);
  }

  script(task: string, replies: readonly (Reply | ReplyFactory)[]): void {
    this.scripts.set(task, replies);
  }

  scriptGovernance(replies: readonly (Reply | ReplyFactory)[]): void {
    this.governanceScripts = replies;
  }

  hold(task: string, step = 1): void {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    this.gates.set(this.key(task, step), { promise, release });
  }

  release(task: string, step = 1): void {
    this.gates.get(this.key(task, step))?.release();
  }

  holdGovernance(step = 1): void {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    this.gates.set(this.governanceKey(step), { promise, release });
  }

  releaseGovernance(step = 1): void {
    this.gates.get(this.governanceKey(step))?.release();
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

  async waitForGovernance(step = 1, timeoutMs = 10_000): Promise<RequestLog> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.requests.find(item => item.governanceStep === step);
      if (found) return found;
      await Bun.sleep(25);
    }
    throw new Error(`fixture did not receive governance step ${step}`);
  }

  count(task: string): number { return this.requests.filter(item => item.task === task).length; }
  countGovernance(): number { return this.requests.filter(item => item.governanceStep !== null).length; }

  close(): void {
    for (const gate of this.gates.values()) gate.release();
    this.catalogGate?.release();
    this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/models") {
      this.catalogRequests.push({
        receivedAt: new Date().toISOString(),
        authorization: request.headers.get("authorization"),
      });
      if (this.currentCatalogMode === "delayed" && this.catalogGate) {
        await Promise.race([
          this.catalogGate.promise,
          new Promise<void>(resolve =>
            request.signal.addEventListener("abort", () => resolve(), { once: true })),
        ]);
      }
      if (request.signal.aborted) return new Response(null, { status: 499 });
      if (this.currentCatalogMode === "unavailable") {
        return Response.json(
          { error: { message: "fixture catalog unavailable", type: "fixture_error" } },
          { status: 503 },
        );
      }
      return Response.json({
        data: this.currentCatalogMode === "hostile"
          ? HOSTILE_FIXTURE_CATALOG_MODELS
          : FIXTURE_CATALOG_MODELS,
      });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const authorization = request.headers.get("authorization");
    if (authorization !== "Bearer acceptance-fixture-key") return new Response("unauthorized", { status: 401 });
    const body = await request.json() as {
      model?: unknown;
      stream?: unknown;
      messages?: Array<{ role?: unknown; content?: unknown }>;
      tools?: Array<{ function?: { name?: unknown } }>;
      tool_choice?: unknown;
      parallel_tool_calls?: unknown;
    };
    if (typeof body.model !== "string" || !Array.isArray(body.messages)) return new Response("invalid request", { status: 400 });
    const lastUser = [...body.messages].reverse().find(item => item.role === "user");
    const firstUser = body.messages.find(item => item.role === "user");
    const messageRoles = body.messages.map(item => String(item.role ?? ""));
    const allMessageText = body.messages.map(item =>
      messageText(item.content)
    ).join("\n");
    const firstUserText = messageText(firstUser?.content);
    const lastUserText = messageText(lastUser?.content);
    const durable = this.readDurableStep(lastUserText);
    const toolNames = Array.isArray(body.tools)
      ? body.tools.flatMap(tool =>
          typeof tool.function?.name === "string" ? [tool.function.name] : [])
      : [];
    const governance = toolNames.length === 1 &&
      toolNames[0] === "agencity_submit_refinement_governance_decision";
    const governanceStep = governance
      ? this.requests.filter(item => item.governanceStep !== null).length + 1
      : null;
    const proposalId = governance
      ? JSON.stringify(body.messages).match(
          /proposalId[^A-Za-z0-9]+(governed-refinement-proposal-[a-f0-9]{32}|[0-9A-HJKMNP-TV-Z]{26})/,
        )?.[1] ?? null
      : null;
    const probe: FixtureProbe = {
      task: durable?.task ?? null,
      step: durable?.stepOrdinal ?? null,
      governanceStep,
      proposalId,
      streaming: body.stream === true,
      model: body.model,
      messageRoles,
      allMessageText,
      firstUserText,
      lastUserText,
      toolNames,
      toolChoice: typeof body.tool_choice === "string" ? body.tool_choice : null,
      parallelToolCalls: typeof body.parallel_tool_calls === "boolean"
        ? body.parallel_tool_calls
        : null,
    };
    this.requests.push({ ...probe, receivedAt: new Date().toISOString(), authorization });
    const gate = durable
      ? this.gates.get(this.key(durable.task, durable.stepOrdinal))
      : governanceStep === null
        ? undefined
        : this.gates.get(this.governanceKey(governanceStep));
    if (gate) await Promise.race([gate.promise, new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }))]);
    if (request.signal.aborted) return new Response(null, { status: 499 });

    const rawStep = durable || governanceStep !== null
      ? null
      : this.requests.filter(item =>
          item.task === null &&
          item.governanceStep === null &&
          item.firstUserText === firstUserText
        ).length;
    const selected = durable
      ? this.scripts.get(durable.task)?.[durable.stepOrdinal - 1]
      : governanceStep === null
        ? this.scripts.get(firstUserText)?.[(rawStep ?? 1) - 1]
        : this.governanceScripts[governanceStep - 1];
    const reviewId = JSON.stringify(body.messages).match(/refinement-review-[a-f0-9]{32}/)?.[0];
    const fallback: Reply = durable
      ? action("final", `fixture completed: ${durable.task}`)
      : reviewId
        ? {
            name: "agencity_submit_refinement_review",
            input: {
              decision: {
                protocol: "agencity.refinement-review",
                version: 1,
                reviewId,
                status: "no_change",
                reason:
                  "The frozen trajectory does not justify an evidence-backed change.",
                evidenceEventIds: [],
              },
            },
          }
        : `fixture recursive response: ${lastUserText.slice(-200)}`;
    const reply = typeof selected === "function" ? selected(probe) : selected ?? fallback;
    const text = typeof reply === "string" ? reply : JSON.stringify(reply);
    const toolCall = Array.isArray(body.tools) && typeof reply !== "string" ? formalToolCall(reply) : null;
    const narration = typeof reply !== "string" && typeof reply.narration === "string"
      ? reply.narration
      : null;
    const truncatedArguments = typeof reply !== "string" && reply.truncated === true &&
      toolCall !== null
      ? toolCall.arguments.slice(0, -1)
      : toolCall?.arguments;
    if (body.stream !== true) return Response.json({
      id: "fixture-completion",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [{
        index: 0,
        message: toolCall
          ? { role: "assistant", content: narration, tool_calls: [{ index: 0, id: `fixture-tool-${durable?.stepOrdinal ?? 1}`, type: "function", function: { ...toolCall, arguments: truncatedArguments } }] }
          : { role: "assistant", content: text },
        finish_reason: toolCall ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: 7, completion_tokens: Math.ceil(text.length / 4), total_tokens: 7 + Math.ceil(text.length / 4) },
    });
    const chunks = split(truncatedArguments ?? text, 3);
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
        if (toolCall && narration) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope([{ index: 0, delta: { content: narration }, finish_reason: null }]))}\n\n`));
        }
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
      const value = JSON.parse(text.slice(offset + marker.length)) as {
        task?: unknown;
        stepOrdinal?: unknown;
        run?: { task?: unknown; stepOrdinal?: unknown };
      };
      const durableRun = value.run ?? value;
      return typeof durableRun.task === "string" &&
          typeof durableRun.stepOrdinal === "number"
        ? { task: durableRun.task, stepOrdinal: durableRun.stepOrdinal }
        : null;
    } catch { return null; }
  }

  private key(task: string, step: number): string { return `${task}\0${step}`; }
  private governanceKey(step: number): string { return `governance\0${step}`; }

  private createGate(): Gate {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  }
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

function formalToolCall(reply: Record<string, unknown>): { name: string; arguments: string } | null {
  if ((reply.name === "bun_console" || reply.name === "finish" ||
      reply.name === "agencity_submit_object" ||
      reply.name === "agencity_submit_refinement_review" ||
      reply.name === "agencity_submit_refinement_governance_decision") &&
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

export function governanceDecision(
  decision: "approve" | "reject",
  input: {
    readonly reason: string;
    readonly criteria: readonly string[];
    readonly residualRisks?: readonly string[];
    readonly revisionGuidance?: string;
  },
): ReplyFactory {
  return probe => {
    if (!probe.proposalId) throw new Error("Governance fixture reply requires a frozen proposal ID");
    return {
      name: "agencity_submit_refinement_governance_decision",
      input: decision === "approve"
        ? {
            decision,
            proposalId: probe.proposalId,
            reason: input.reason,
            satisfiedCriteria: input.criteria,
            residualRisks: input.residualRisks ?? [],
          }
        : {
            decision,
            proposalId: probe.proposalId,
            reason: input.reason,
            violatedCriteria: input.criteria,
            ...(input.revisionGuidance === undefined ? {} : {
              revisionGuidance: input.revisionGuidance,
            }),
          },
    };
  };
}

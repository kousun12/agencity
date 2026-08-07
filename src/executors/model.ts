import type { JsonValue } from "../domain/json.ts";
import { AGENT_ACTION_PROTOCOL, AGENT_ACTION_VERSION, ValidationError, type AgentAction, type ModelConfiguration, type Usage } from "../domain/index.ts";
import type { EffectExecutor, ExecutionResult } from "./contract.ts";
import { result } from "./contract.ts";

export interface ModelResponse { readonly text: string; readonly finishReason: string; readonly usage: Usage; }
export interface ModelOutputDelta { readonly text: string; }
export interface ModelProviderCapabilities {
  readonly streaming: boolean;
  readonly contextWindowTokens?: number;
  readonly contextCapacitySource?: "provider-metadata" | "model-catalog" | "operator-configuration";
}
export interface ModelProviderDescriptor {
  readonly name: string;
  readonly displayName: string;
  readonly capabilities: ModelProviderCapabilities;
  readonly usable: boolean;
  readonly credentialSource: "stored" | "environment" | "programmatic" | "missing";
  readonly remediation?: string;
}
export interface ModelProvider {
  readonly name: string;
  /** A missing declaration is deliberately treated as non-streaming. */
  readonly capabilities?: ModelProviderCapabilities;
  readonly displayName?: string;
  availability?(): Pick<ModelProviderDescriptor, "usable" | "credentialSource" | "remediation">;
  normalizeModel?(model: string): string;
  complete(context: JsonValue, configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse>;
  /**
   * Optional incremental completion. Implementations opt in only by declaring
   * capabilities.streaming=true; the returned response remains authoritative.
   */
  stream?(
    context: JsonValue,
    configuration: ModelConfiguration,
    signal: AbortSignal,
    onDelta: (delta: ModelOutputDelta) => void,
  ): Promise<ModelResponse>;
}

export class EchoModelProvider implements ModelProvider {
  readonly name = "echo";
  readonly displayName = "Echo (internal test fixture; non-streaming)";
  readonly capabilities = { streaming: false, contextWindowTokens: 128_000, contextCapacitySource: "model-catalog" } as const;
  availability() { return { usable: true, credentialSource: "programmatic" as const }; }
  async complete(context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    let text = "";
    if (context && typeof context === "object" && !Array.isArray(context)) {
      const messages = context.messages;
      if (Array.isArray(messages)) {
        const last = [...messages].reverse().find((message) => message && typeof message === "object" && !Array.isArray(message) && message.role === "user");
        if (last && typeof last === "object" && !Array.isArray(last) && typeof last.content === "string") text = `Echo: ${last.content}`;
      }
    }
    const runContext = context && typeof context === "object" && !Array.isArray(context) &&
      context.run && typeof context.run === "object" && !Array.isArray(context.run) ? context.run : undefined;
    const isAgentRun = runContext !== undefined;
    const runTask = typeof runContext?.task === "string" ? runContext.task : undefined;
    const output = isAgentRun
      ? JSON.stringify({ protocol: AGENT_ACTION_PROTOCOL, version: AGENT_ACTION_VERSION, type: "final", content: runTask ? `Echo: ${runTask}` : "Echo model completed." } satisfies AgentAction)
      : text || "Echo model completed.";
    return { text: output, finishReason: "stop", usage: { inputTokens: Math.ceil(JSON.stringify(context).length / 4), outputTokens: Math.ceil(output.length / 4), costUsd: 0 } };
  }
}

/** Deterministic structured-action fixture keyed by the durable run step ordinal in context. */
export class ScriptedAgentActionProvider implements ModelProvider {
  readonly name: string;
  readonly displayName: string;
  readonly capabilities = { streaming: false, contextWindowTokens: 128_000, contextCapacitySource: "model-catalog" } as const;
  constructor(
    readonly script: Readonly<Record<number, AgentAction | string>> | readonly (AgentAction | string)[],
    name = "structured-action",
  ) { this.name = name; this.displayName = `${name} (deterministic agent-action fixture)`; }
  async complete(context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const ordinal = context && typeof context === "object" && !Array.isArray(context) && context.run &&
      typeof context.run === "object" && !Array.isArray(context.run) && typeof context.run.stepOrdinal === "number"
      ? context.run.stepOrdinal : 1;
    const selected = Array.isArray(this.script) ? this.script[ordinal - 1] : this.script[ordinal];
    const fallback: AgentAction = { protocol: AGENT_ACTION_PROTOCOL, version: AGENT_ACTION_VERSION, type: "failed", error: `No scripted agent action for durable step ${ordinal}` };
    const text = typeof selected === "string" ? selected : JSON.stringify(selected ?? fallback);
    return { text, finishReason: "stop", usage: { inputTokens: Math.ceil(JSON.stringify(context).length / 4), outputTokens: Math.ceil(text.length / 4), costUsd: 0 } };
  }
}

export class ModelProviderContextWindowOverflowError extends Error {
  readonly code = "provider-confirmed-context-window-overflow" as const;
  constructor(readonly provider: string, readonly model: string) {
    super(`Provider ${provider}/${model} confirmed that the context window overflowed`);
    this.name = "ModelProviderContextWindowOverflowError";
  }
}

export interface OpenAICompatibleOptions {
  readonly baseUrl: string;
  readonly apiKey: () => string | undefined;
  readonly providerName?: string;
  readonly displayName?: string;
  readonly availability?: () => Pick<ModelProviderDescriptor, "usable" | "credentialSource" | "remediation">;
  /**
   * Explicitly disable streaming for compatible endpoints that do not support
   * SSE. Streaming defaults to true; a streaming failure is never retried as a
   * non-streaming request because that could duplicate a non-idempotent call.
   */
  readonly streaming?: boolean;
  /** Exact operator/provider metadata only; unknown capacity is represented by omission. */
  readonly contextWindowTokens?: number;
  readonly contextCapacitySource?: "provider-metadata" | "model-catalog" | "operator-configuration";
}
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly displayName: string;
  readonly capabilities: ModelProviderCapabilities;
  constructor(readonly options: OpenAICompatibleOptions) {
    this.name = options.providerName ?? "openai";
    const streaming = options.streaming ?? true;
    this.capabilities = {
      streaming,
      ...(options.contextWindowTokens === undefined ? {} : { contextWindowTokens: options.contextWindowTokens, contextCapacitySource: options.contextCapacitySource ?? "operator-configuration" }),
    };
    this.displayName = options.displayName ?? `${this.name} (OpenAI-compatible; ${streaming ? "streaming" : "non-streaming"})`;
  }
  availability() {
    return this.options.availability?.() ?? {
      usable: Boolean(this.options.apiKey()),
      credentialSource: this.options.apiKey() ? "programmatic" as const : "missing" as const,
    };
  }
  async complete(context: JsonValue, configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    const key = this.options.apiKey(); if (!key) throw new ValidationError(`Credential unavailable for ${this.name}`);
    const contextObject = context && typeof context === "object" && !Array.isArray(context) ? context : {};
    const messages = Array.isArray(contextObject.messages) ? contextObject.messages : [];
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: configuration.model, messages, temperature: configuration.temperature, max_tokens: configuration.maxOutputTokens }), signal,
    });
    if (!response.ok) {
      const body = await response.text();
      if ((response.status === 400 || response.status === 413 || response.status === 422) && /context(?:_| )?(?:length|window)|maximum context|too many tokens|token limit/i.test(body)) throw new ModelProviderContextWindowOverflowError(this.name, configuration.model);
      throw new Error(`Model HTTP ${response.status}: ${body}`);
    }
    const body = await response.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; cost_usd?: number };
    const choice = body.choices?.[0];
    return { text: choice?.message?.content ?? "", finishReason: choice?.finish_reason ?? "stop", usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0, costUsd: body.cost_usd ?? 0 } };
  }

  async stream(
    context: JsonValue,
    configuration: ModelConfiguration,
    signal: AbortSignal,
    onDelta: (delta: ModelOutputDelta) => void,
  ): Promise<ModelResponse> {
    const key = this.options.apiKey(); if (!key) throw new ValidationError(`Credential unavailable for ${this.name}`);
    const contextObject = context && typeof context === "object" && !Array.isArray(context) ? context : {};
    const messages = Array.isArray(contextObject.messages) ? contextObject.messages : [];
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: configuration.model,
        messages,
        temperature: configuration.temperature,
        max_tokens: configuration.maxOutputTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text();
      if ((response.status === 400 || response.status === 413 || response.status === 422) && /context(?:_| )?(?:length|window)|maximum context|too many tokens|token limit/i.test(body)) throw new ModelProviderContextWindowOverflowError(this.name, configuration.model);
      throw new Error(`Model HTTP ${response.status}: ${body}`);
    }
    if (!response.body) throw new Error("Model streaming response has no body");

    let text = "";
    let finishReason = "stop";
    let usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let completed = false;
    await readServerSentEvents(response.body, (data) => {
      if (data === "[DONE]") { completed = true; return; }
      let chunk: {
        choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        cost_usd?: number;
      };
      try { chunk = JSON.parse(data) as typeof chunk; }
      catch { throw new Error("Model stream returned invalid JSON"); }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        text += delta;
        onDelta({ text: delta });
      }
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? usage.inputTokens,
          outputTokens: chunk.usage.completion_tokens ?? usage.outputTokens,
          costUsd: chunk.cost_usd ?? usage.costUsd,
        };
      } else if (typeof chunk.cost_usd === "number") {
        usage = { ...usage, costUsd: chunk.cost_usd };
      }
    }, signal);
    if (!completed) throw new Error("Model stream ended before [DONE]");
    return { text, finishReason, usage };
  }
}

export interface AnthropicCompatibleOptions {
  readonly baseUrl: string;
  readonly apiKey: () => string | undefined;
  readonly providerName?: string;
  readonly displayName?: string;
  readonly streaming?: boolean;
  readonly normalizeModel?: (model: string) => string;
  readonly availability?: () => Pick<ModelProviderDescriptor, "usable" | "credentialSource" | "remediation">;
  readonly contextWindowTokens?: number;
  readonly contextCapacitySource?: "provider-metadata" | "model-catalog" | "operator-configuration";
}

export class AnthropicCompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly displayName: string;
  readonly capabilities: ModelProviderCapabilities;

  constructor(readonly options: AnthropicCompatibleOptions) {
    this.name = options.providerName ?? "anthropic";
    const streaming = options.streaming ?? true;
    this.capabilities = {
      streaming,
      ...(options.contextWindowTokens === undefined ? {} : {
        contextWindowTokens: options.contextWindowTokens,
        contextCapacitySource: options.contextCapacitySource ?? "operator-configuration",
      }),
    };
    this.displayName = options.displayName ?? `${this.name} (Anthropic-compatible; ${streaming ? "streaming" : "non-streaming"})`;
  }

  availability() {
    return this.options.availability?.() ?? {
      usable: Boolean(this.options.apiKey()),
      credentialSource: this.options.apiKey() ? "programmatic" as const : "missing" as const,
    };
  }

  normalizeModel(model: string): string {
    return this.options.normalizeModel?.(model) ?? model;
  }

  async complete(context: JsonValue, configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    const response = await this.#request(context, configuration, signal, false);
    const body = await response.json() as {
      content?: Array<{ type?: string; text?: string }>;
      stop_reason?: string | null;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = body.content?.filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text).join("") ?? "";
    return {
      text,
      finishReason: body.stop_reason ?? "stop",
      usage: {
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
        costUsd: 0,
      },
    };
  }

  async stream(
    context: JsonValue,
    configuration: ModelConfiguration,
    signal: AbortSignal,
    onDelta: (delta: ModelOutputDelta) => void,
  ): Promise<ModelResponse> {
    const response = await this.#request(context, configuration, signal, true);
    if (!response.body) throw new Error("Model streaming response has no body");
    let text = "";
    let finishReason = "stop";
    let usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let completed = false;
    await readServerSentEvents(response.body, (data) => {
      let event: {
        type?: string;
        message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        delta?: { type?: string; text?: string; stop_reason?: string | null };
        usage?: { input_tokens?: number; output_tokens?: number };
        error?: { type?: string; message?: string };
      };
      try { event = JSON.parse(data) as typeof event; }
      catch { throw new Error("Model stream returned invalid JSON"); }
      if (event.type === "error") {
        const kind = event.error?.type ? ` ${event.error.type}` : "";
        const message = event.error?.message ? `: ${event.error.message}` : "";
        throw new Error(`Model stream error${kind}${message}`);
      }
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        text += event.delta.text;
        onDelta({ text: event.delta.text });
      }
      if (event.type === "message_start" && event.message?.usage) {
        usage = {
          inputTokens: event.message.usage.input_tokens ?? usage.inputTokens,
          outputTokens: event.message.usage.output_tokens ?? usage.outputTokens,
          costUsd: 0,
        };
      }
      if (event.type === "message_delta") {
        if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
        if (event.usage) {
          usage = {
            inputTokens: event.usage.input_tokens ?? usage.inputTokens,
            outputTokens: event.usage.output_tokens ?? usage.outputTokens,
            costUsd: 0,
          };
        }
      }
      if (event.type === "message_stop") completed = true;
    }, signal);
    if (!completed) throw new Error("Model stream ended before message_stop");
    return { text, finishReason, usage };
  }

  async #request(
    context: JsonValue,
    configuration: ModelConfiguration,
    signal: AbortSignal,
    stream: boolean,
  ): Promise<Response> {
    const key = this.options.apiKey();
    if (!key) throw new ValidationError(`Credential unavailable for ${this.name}`);
    const prepared = anthropicContext(context);
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: configuration.model,
        messages: prepared.messages,
        ...(prepared.system ? { system: prepared.system } : {}),
        max_tokens: configuration.maxOutputTokens ?? 4_096,
        ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature }),
        stream,
      }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text();
      if ((response.status === 400 || response.status === 413 || response.status === 422) &&
          /context(?:_| )?(?:length|window)|maximum context|too many tokens|token limit/i.test(body)) {
        throw new ModelProviderContextWindowOverflowError(this.name, configuration.model);
      }
      throw new Error(`Model HTTP ${response.status}: ${body}`);
    }
    return response;
  }
}

function anthropicContext(context: JsonValue): {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const record = context && typeof context === "object" && !Array.isArray(context) ? context : {};
  const rawMessages = Array.isArray(record.messages) ? record.messages : [];
  const system: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.content !== "string") continue;
    if (raw.role === "system") {
      system.push(raw.content);
      continue;
    }
    const role = raw.role === "assistant" ? "assistant" : "user";
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content += `\n\n${raw.content}`;
    else messages.push({ role, content: raw.content });
  }
  return { system: system.join("\n\n"), messages };
}

async function readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  const dispatch = (): void => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n");
    dataLines = [];
    onData(data);
  };
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") dispatch();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (done) break;
    }
    if (buffer) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    dispatch();
  } finally {
    reader.releaseLock();
  }
}

function parse(input: JsonValue): { context: JsonValue; configuration: ModelConfiguration; callId?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("Model input must be an object");
  const context = input.context; const config = input.configuration;
  if (context === undefined || !config || typeof config !== "object" || Array.isArray(config) || typeof config.provider !== "string" || typeof config.model !== "string") throw new ValidationError("Model input requires context and configuration");
  return {
    context,
    configuration: config as unknown as ModelConfiguration,
    ...(typeof input.callId === "string" ? { callId: input.callId } : {}),
  };
}

export type ProviderConcurrency = number | Readonly<Record<string, number>>;
type Waiter = { readonly resolve: (release: () => void) => void; readonly reject: (error: unknown) => void; readonly signal: AbortSignal; readonly abort: () => void };

/** One process-wide limiter shared by every model effect (root, recursive, gate). */
class ProviderLimiter {
  readonly #active = new Map<string, number>();
  readonly #waiting = new Map<string, Waiter[]>();
  constructor(readonly configured: ProviderConcurrency = 1) {
    if (typeof configured === "number") this.#assertLimit(configured, "default");
    else for (const [provider, limit] of Object.entries(configured)) this.#assertLimit(limit, provider);
  }
  #assertLimit(limit: number, provider: string): void {
    if (!Number.isInteger(limit) || limit < 1) throw new ValidationError(`Provider concurrency for ${provider} must be a positive integer`);
  }
  #limit(provider: string): number { return typeof this.configured === "number" ? this.configured : this.configured[provider] ?? 1; }
  acquire(provider: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    const active = this.#active.get(provider) ?? 0;
    if (active < this.#limit(provider)) {
      this.#active.set(provider, active + 1);
      return Promise.resolve(this.#release(provider));
    }
    return new Promise<() => void>((resolve, reject) => {
      const abort = () => {
        const queue = this.#waiting.get(provider); const index = queue?.findIndex((item) => item.abort === abort) ?? -1;
        if (queue && index >= 0) queue.splice(index, 1);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const waiter: Waiter = { resolve, reject, signal, abort };
      signal.addEventListener("abort", abort, { once: true });
      const queue = this.#waiting.get(provider) ?? []; queue.push(waiter); this.#waiting.set(provider, queue);
    });
  }
  #release(provider: string): () => void {
    let released = false;
    return () => {
      if (released) return; released = true;
      const queue = this.#waiting.get(provider);
      while (queue?.length) {
        const next = queue.shift()!; next.signal.removeEventListener("abort", next.abort);
        if (next.signal.aborted) { next.reject(new DOMException("Aborted", "AbortError")); continue; }
        next.resolve(this.#release(provider)); return;
      }
      this.#active.set(provider, Math.max(0, (this.#active.get(provider) ?? 1) - 1));
      if (!queue?.length) this.#waiting.delete(provider);
    };
  }
}

export class ModelExecutor implements EffectExecutor {
  readonly name = "model";
  readonly #providers = new Map<string, ModelProvider>();
  readonly #limiter: ProviderLimiter;
  constructor(providers: readonly ModelProvider[], concurrency: ProviderConcurrency = 1) {
    for (const provider of providers) {
      if (provider.capabilities?.contextWindowTokens !== undefined && (!Number.isSafeInteger(provider.capabilities.contextWindowTokens) || provider.capabilities.contextWindowTokens < 2)) throw new ValidationError(`Model provider ${provider.name} context window must be an integer of at least 2 tokens`);
      if (provider.capabilities?.streaming === true && typeof provider.stream !== "function") {
        throw new ValidationError(`Model provider ${provider.name} declares streaming without a stream implementation`);
      }
      this.#providers.set(provider.name, provider);
    }
    this.#limiter = new ProviderLimiter(concurrency);
  }

  providers(): ModelProviderDescriptor[] {
    return [...this.#providers.values()].map((provider) => {
      const availability = provider.availability?.() ?? { usable: true, credentialSource: "programmatic" as const };
      return {
        name: provider.name,
        displayName: provider.displayName ?? provider.name,
        capabilities: {
          streaming: provider.capabilities?.streaming === true,
          ...(provider.capabilities?.contextWindowTokens === undefined ? {} : {
            contextWindowTokens: provider.capabilities.contextWindowTokens,
            contextCapacitySource: provider.capabilities.contextCapacitySource ?? "provider-metadata",
          }),
        },
        ...availability,
      };
    });
  }

  normalizeConfiguration(configuration: ModelConfiguration): ModelConfiguration {
    const normalized = this.#providers.get(configuration.provider)?.normalizeModel?.(configuration.model) ?? configuration.model;
    return normalized === configuration.model ? configuration : { ...configuration, model: normalized };
  }

  contextCapacity(configuration: ModelConfiguration): Readonly<{ provider: string; model: string; source: "provider-metadata" | "model-catalog" | "operator-configuration" | "unknown"; contextWindowTokens: number | null }> {
    const provider = this.#providers.get(configuration.provider);
    const capacity = provider?.capabilities?.contextWindowTokens;
    return Object.freeze({
      provider: configuration.provider,
      model: configuration.model,
      source: capacity === undefined ? "unknown" : provider?.capabilities?.contextCapacitySource ?? "provider-metadata",
      contextWindowTokens: capacity ?? null,
    });
  }

  async execute(request: Parameters<EffectExecutor["execute"]>[0], context: Parameters<EffectExecutor["execute"]>[1]): Promise<ExecutionResult> {
    if (request.operation !== "complete") return result("failed", undefined, `Unsupported model operation: ${request.operation}`);
    try {
      const { context: modelContext, configuration, callId } = parse(request.input);
      const provider = this.#providers.get(configuration.provider);
      if (!provider) return result("failed", undefined, `Unknown model provider: ${configuration.provider}`);
      const release = await this.#limiter.acquire(configuration.provider, context.signal);
      try {
        const useStreaming = provider.capabilities?.streaming === true;
        const response = useStreaming
          ? await provider.stream!(modelContext, configuration, context.signal, (delta) => {
              // Bound individual notifications before the outbox applies its
              // per-effect aggregate bound. The final response is unaffected.
              for (let offset = 0; offset < delta.text.length; offset += 4_096) {
                context.reportProgress?.({
                  kind: "model-output-delta",
                  value: {
                    text: delta.text.slice(offset, offset + 4_096),
                    provider: configuration.provider,
                    model: configuration.model,
                    ...(callId === undefined ? {} : { callId }),
                  },
                });
              }
            })
          : await provider.complete(modelContext, configuration, context.signal);
        return result("succeeded", response as unknown as JsonValue);
      } finally { release(); }
    } catch (error) {
      if (context.signal.aborted || error instanceof DOMException && error.name === "AbortError") return result("cancelled", undefined, "Model call cancelled");
      const classification = error instanceof ModelProviderContextWindowOverflowError
        ? { provider: error.provider, model: error.model, code: "provider-confirmed-context-window-overflow" }
        : { provider: request.input && typeof request.input === "object" && !Array.isArray(request.input) && request.input.configuration && typeof request.input.configuration === "object" && !Array.isArray(request.input.configuration) && typeof request.input.configuration.provider === "string" ? request.input.configuration.provider : "unknown", model: request.input && typeof request.input === "object" && !Array.isArray(request.input) && request.input.configuration && typeof request.input.configuration === "object" && !Array.isArray(request.input.configuration) && typeof request.input.configuration.model === "string" ? request.input.configuration.model : "unknown", code: "generic" };
      return result("failed", { errorClassification: classification }, error instanceof Error ? error.message : String(error));
    }
  }
}

import type { JsonValue } from "../domain/json.ts";
import { ValidationError, type ModelConfiguration, type Usage } from "../domain/index.ts";
import type { EffectExecutor, ExecutionResult } from "./contract.ts";
import { result } from "./contract.ts";

export interface ModelResponse { readonly text: string; readonly finishReason: string; readonly usage: Usage; }
export interface ModelProvider { readonly name: string; complete(context: JsonValue, configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse>; }

export class EchoModelProvider implements ModelProvider {
  readonly name = "echo";
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
    const output = text || "Echo model completed.";
    return { text: output, finishReason: "stop", usage: { inputTokens: Math.ceil(JSON.stringify(context).length / 4), outputTokens: Math.ceil(output.length / 4), costUsd: 0 } };
  }
}

export interface OpenAICompatibleOptions { readonly baseUrl: string; readonly apiKey: () => string | undefined; readonly providerName?: string; }
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  constructor(readonly options: OpenAICompatibleOptions) { this.name = options.providerName ?? "openai"; }
  async complete(context: JsonValue, configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    const key = this.options.apiKey(); if (!key) throw new ValidationError(`Credential unavailable for ${this.name}`);
    const contextObject = context && typeof context === "object" && !Array.isArray(context) ? context : {};
    const messages = Array.isArray(contextObject.messages) ? contextObject.messages : [];
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: configuration.model, messages, temperature: configuration.temperature, max_tokens: configuration.maxOutputTokens }), signal,
    });
    if (!response.ok) throw new Error(`Model HTTP ${response.status}: ${await response.text()}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; cost_usd?: number };
    const choice = body.choices?.[0];
    return { text: choice?.message?.content ?? "", finishReason: choice?.finish_reason ?? "stop", usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0, costUsd: body.cost_usd ?? 0 } };
  }
}

function parse(input: JsonValue): { context: JsonValue; configuration: ModelConfiguration } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("Model input must be an object");
  const context = input.context; const config = input.configuration;
  if (context === undefined || !config || typeof config !== "object" || Array.isArray(config) || typeof config.provider !== "string" || typeof config.model !== "string") throw new ValidationError("Model input requires context and configuration");
  return { context, configuration: config as unknown as ModelConfiguration };
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
    for (const provider of providers) this.#providers.set(provider.name, provider);
    this.#limiter = new ProviderLimiter(concurrency);
  }
  async execute(request: Parameters<EffectExecutor["execute"]>[0], context: Parameters<EffectExecutor["execute"]>[1]): Promise<ExecutionResult> {
    if (request.operation !== "complete") return result("failed", undefined, `Unsupported model operation: ${request.operation}`);
    try {
      const { context: modelContext, configuration } = parse(request.input);
      const provider = this.#providers.get(configuration.provider);
      if (!provider) return result("failed", undefined, `Unknown model provider: ${configuration.provider}`);
      const release = await this.#limiter.acquire(configuration.provider, context.signal);
      try {
        const response = await provider.complete(modelContext, configuration, context.signal);
        return result("succeeded", response as unknown as JsonValue);
      } finally { release(); }
    } catch (error) {
      if (context.signal.aborted || error instanceof DOMException && error.name === "AbortError") return result("cancelled", undefined, "Model call cancelled");
      return result("failed", undefined, error instanceof Error ? error.message : String(error));
    }
  }
}

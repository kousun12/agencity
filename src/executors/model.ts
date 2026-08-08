import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText, type LanguageModel, type ModelMessage } from "ai";
import type { JsonValue } from "../domain/json.ts";
import {
  AGENT_ACTION_PROTOCOL,
  AGENT_ACTION_VERSION,
  STANDARD_UNVERIFIED_REASONING_LEVELS,
  ValidationError,
  assertReasoningSelection,
  normalizeReasoningEffort,
  resolveModelDispatch,
  validateModelDispatch,
  type AgentAction,
  type ModelConfiguration,
  type ModelConfigurationInput,
  type ModelDescriptor,
  type ModelDispatch,
  type ModelReasoningCapability,
  type ModelWarning,
  type Usage,
} from "../domain/index.ts";
import type { EffectExecutor, ExecutionResult } from "./contract.ts";
import { result } from "./contract.ts";
import { scrubText } from "../security/index.ts";

// Agencity retains normalized warnings as attributable model-call provenance.
// Disable the SDK's process-global stderr duplicate, which is neither durable nor scrubbed.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

export interface ModelResponse {
  readonly text: string;
  readonly finishReason: string;
  readonly usage: Usage;
  readonly warnings?: readonly ModelWarning[];
}
export interface ModelOutputDelta { readonly text: string; }
export interface ModelProviderCapabilities {
  readonly streaming: boolean;
  readonly reasoningControl?: "none" | "normalized";
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
  readonly capabilities?: ModelProviderCapabilities;
  readonly displayName?: string;
  /** Present only on product transports whose origin is part of durable dispatch. */
  readonly executionEndpointId?: string;
  readonly executionOrigin?: string;
  readonly productTransport?: boolean;
  availability?(): Pick<ModelProviderDescriptor, "usable" | "credentialSource" | "remediation">;
  normalizeModel?(model: string): string;
  complete(context: JsonValue, configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse>;
  stream?(
    context: JsonValue,
    configuration: ModelConfiguration,
    signal: AbortSignal,
    onDelta: (delta: ModelOutputDelta) => void,
  ): Promise<ModelResponse>;
}

export interface ModelCatalogSnapshot {
  readonly endpointId: string;
  descriptor(model: string): ModelDescriptor;
}

export class EchoModelProvider implements ModelProvider {
  readonly name = "echo";
  readonly displayName = "Echo (internal test fixture; non-streaming)";
  readonly capabilities = {
    streaming: false,
    reasoningControl: "none",
    contextWindowTokens: 128_000,
    contextCapacitySource: "model-catalog",
  } as const;
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
  readonly capabilities = {
    streaming: false,
    reasoningControl: "none",
    contextWindowTokens: 128_000,
    contextCapacitySource: "model-catalog",
  } as const;
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

type AiSdkTransport = "vercel" | "openai" | "anthropic";
interface AiSdkModelProviderOptions {
  readonly transport: AiSdkTransport;
  readonly origin: string;
  readonly apiKey: () => string | undefined;
  readonly displayName: string;
  readonly availability?: () => Pick<ModelProviderDescriptor, "usable" | "credentialSource" | "remediation">;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Shared AI SDK implementation. Transport factories below supply only model
 * construction, endpoint identity, credentials, and native-ID derivation.
 */
class AiSdkModelProvider implements ModelProvider {
  readonly name: AiSdkTransport;
  readonly displayName: string;
  readonly productTransport = true;
  readonly capabilities = { streaming: true, reasoningControl: "normalized" } as const;
  readonly executionEndpointId: string;
  readonly executionOrigin: string;
  readonly #baseUrl: string;

  constructor(readonly options: AiSdkModelProviderOptions) {
    this.name = options.transport;
    this.displayName = options.displayName;
    this.#baseUrl = executionBaseUrl(options.transport, options.origin);
    this.executionOrigin = this.#baseUrl;
    this.executionEndpointId = digest(this.#baseUrl);
  }

  availability() {
    return this.options.availability?.() ?? {
      usable: Boolean(this.options.apiKey()),
      credentialSource: this.options.apiKey() ? "programmatic" as const : "missing" as const,
    };
  }

  normalizeModel(model: string): string {
    const canonical = model.trim();
    if (!canonical || /\s/.test(canonical) || !canonical.includes("/")) {
      throw new ValidationError("Product models must use the canonical creator/model catalog ID");
    }
    if (this.name === "openai" && !canonical.startsWith("openai/")) {
      throw new ValidationError("Direct OpenAI transport requires an openai/... canonical model ID");
    }
    if (this.name === "anthropic" && !canonical.startsWith("anthropic/")) {
      throw new ValidationError("Direct Anthropic transport requires an anthropic/... canonical model ID");
    }
    return canonical;
  }

  async complete(context: JsonValue, configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    const sdk = await generateText({
      ...this.#callOptions(context, configuration, signal),
      model: this.#model(configuration),
    });
    return this.#response(sdk.text, sdk.finishReason, sdk.usage, sdk.warnings, sdk.providerMetadata);
  }

  async stream(
    context: JsonValue,
    configuration: ModelConfiguration,
    signal: AbortSignal,
    onDelta: (delta: ModelOutputDelta) => void,
  ): Promise<ModelResponse> {
    const sdk = streamText({
      ...this.#callOptions(context, configuration, signal),
      model: this.#model(configuration),
      onError: () => {},
    });
    let streamed = "";
    for await (const part of sdk.fullStream) {
      if (part.type === "text-delta") {
        streamed += part.text;
        onDelta({ text: part.text });
      } else if (part.type === "error") {
        throw part.error;
      }
      // Reasoning and all non-text protocol parts are deliberately discarded.
    }
    const [text, finishReason, usage, warnings, metadata] = await Promise.all([
      sdk.text,
      sdk.finishReason,
      sdk.usage,
      sdk.warnings,
      sdk.providerMetadata,
    ]);
    if (text !== streamed) throw new Error("Model stream terminal text disagrees with emitted text");
    const terminalReason = normalizeFinishReason(finishReason);
    if (terminalReason === "other" || terminalReason === "unknown") {
      throw new Error("Model stream ended without a confirmed terminal provider outcome");
    }
    return this.#response(text, terminalReason, usage, warnings, metadata);
  }

  #callOptions(context: JsonValue, configuration: ModelConfiguration, signal: AbortSignal) {
    return {
      messages: modelMessages(context),
      allowSystemInMessages: true,
      maxRetries: 0,
      abortSignal: signal,
      ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature }),
      ...(configuration.maxOutputTokens === undefined ? {} : { maxOutputTokens: configuration.maxOutputTokens }),
      ...(configuration.reasoningEffort === "provider-default" ? {} : { reasoning: configuration.reasoningEffort }),
    };
  }

  #model(configuration: ModelConfiguration): LanguageModel {
    const key = this.options.apiKey();
    if (!key) throw new ValidationError(`Credential unavailable for ${this.name}`);
    const nativeId = nativeModelId(this.name, this.normalizeModel(configuration.model));
    if (this.name === "vercel") {
      return createGateway({
        apiKey: key,
        baseURL: this.#baseUrl,
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      })(configuration.model);
    }
    if (this.name === "openai") {
      return createOpenAI({
        apiKey: key,
        baseURL: this.#baseUrl,
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      }).chat(nativeId);
    }
    return createAnthropic({
      apiKey: key,
      baseURL: this.#baseUrl,
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
    })(nativeId);
  }

  #response(
    text: string,
    finishReason: unknown,
    usage: unknown,
    warnings: unknown,
    providerMetadata: unknown,
  ): ModelResponse {
    const mappedWarnings = normalizeWarnings(warnings);
    return {
      text,
      finishReason: normalizeFinishReason(finishReason),
      usage: normalizeUsage(usage, this.name === "vercel" ? gatewayCost(providerMetadata) : 0),
      ...(mappedWarnings.length ? { warnings: mappedWarnings } : {}),
    };
  }
}

export interface ProductModelProviderOptions {
  readonly origin: string;
  readonly apiKey: () => string | undefined;
  readonly availability?: () => Pick<ModelProviderDescriptor, "usable" | "credentialSource" | "remediation">;
  readonly fetch?: typeof globalThis.fetch;
}

export function createVercelModelProvider(options: ProductModelProviderOptions): ModelProvider {
  return new AiSdkModelProvider({ ...options, transport: "vercel", displayName: "Vercel AI Gateway" });
}
export function createOpenAIModelProvider(options: ProductModelProviderOptions): ModelProvider {
  return new AiSdkModelProvider({ ...options, transport: "openai", displayName: "OpenAI" });
}
export function createAnthropicModelProvider(options: ProductModelProviderOptions): ModelProvider {
  return new AiSdkModelProvider({ ...options, transport: "anthropic", displayName: "Anthropic" });
}

export function nativeModelId(transport: AiSdkTransport, canonicalModel: string): string {
  if (transport === "vercel") return canonicalModel;
  const slash = canonicalModel.indexOf("/");
  if (slash <= 0 || slash === canonicalModel.length - 1) throw new ValidationError("Canonical model ID must use creator/model form");
  const creator = canonicalModel.slice(0, slash);
  const suffix = canonicalModel.slice(slash + 1);
  if (creator !== transport) throw new ValidationError(`Direct ${transport} transport cannot execute ${creator} models`);
  return transport === "anthropic" ? suffix.replaceAll(".", "-") : suffix;
}

export function normalizeExecutionOrigin(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ValidationError(`${label} must be an absolute HTTP(S) origin`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new ValidationError(`${label} must be an origin without credentials, path, query, or fragment`);
  }
  return url.origin;
}

function executionBaseUrl(transport: AiSdkTransport, value: string): string {
  if (transport === "vercel") return `${normalizeExecutionOrigin(value, "Vercel AI Gateway origin")}/v4/ai`;
  return `${normalizeExecutionOrigin(value, `${transport.toUpperCase()}_BASE_URL`)}/v1`;
}

function modelMessages(context: JsonValue): ModelMessage[] {
  const record = context && typeof context === "object" && !Array.isArray(context) ? context : {};
  const raw = Array.isArray(record.messages) ? record.messages : [];
  const messages: ModelMessage[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.content !== "string") continue;
    if (value.role === "system") messages.push({ role: "system", content: value.content });
    else if (value.role === "assistant") messages.push({ role: "assistant", content: value.content });
    else if (value.role === "tool") messages.push({ role: "user", content: `[tool observation]\n${value.content}` });
    else messages.push({ role: "user", content: value.content });
  }
  if (!messages.length) messages.push({ role: "user", content: JSON.stringify(context) });
  return messages;
}

function normalizeUsage(value: unknown, costUsd: number): Usage {
  const usage = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    inputTokens: finiteTokenCount(usage.inputTokens),
    outputTokens: finiteTokenCount(usage.outputTokens),
    costUsd: Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : 0,
  };
}

function normalizeFinishReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value === "undefined" || value === "null") {
    throw new ValidationError("Model provider returned an invalid finish reason");
  }
  return value;
}

function finiteTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function gatewayCost(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const metadata = value as Record<string, unknown>;
  const gateway = metadata.gateway && typeof metadata.gateway === "object" && !Array.isArray(metadata.gateway)
    ? metadata.gateway as Record<string, unknown> : metadata;
  for (const candidate of [gateway.costUsd, gateway.costUSD, gateway.cost]) {
    const number = typeof candidate === "string" ? Number(candidate) : candidate;
    if (typeof number === "number" && Number.isFinite(number) && number >= 0) return number;
  }
  return 0;
}

function normalizeWarnings(value: unknown): ModelWarning[] {
  if (!Array.isArray(value)) return [];
  const warnings: ModelWarning[] = [];
  for (const warning of value.slice(0, 8)) {
    const record = warning && typeof warning === "object" && !Array.isArray(warning)
      ? warning as Record<string, unknown> : {};
    const rawType = typeof record.type === "string" ? record.type : "";
    const rawMessage = typeof record.message === "string" ? record.message
      : typeof record.details === "string" ? record.details
      : rawType || "Provider warning";
    const lower = `${rawType} ${rawMessage}`.toLowerCase();
    const kind: ModelWarning["kind"] = /coerc|compatib|adjust/.test(lower) ? "coerced"
      : /unsupported|ignored/.test(lower) ? "unsupported" : "provider";
    warnings.push({ kind, message: boundedText(scrubProviderText(rawMessage), 1_024) || "Provider warning" });
  }
  if (value.length > 8) {
    warnings[7] = { kind: "truncated", message: `Additional provider warnings were omitted (${value.length - 7} hidden)` };
  }
  return warnings;
}

function scrubProviderText(value: string): string {
  return scrubText(value)
    .replace(/(?:bearer|api[-_ ]?key|authorization|x-api-key)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function boundedText(value: string, maximum: number): string {
  let bounded = new TextDecoder().decode(new TextEncoder().encode(value).slice(0, maximum));
  while (new TextEncoder().encode(bounded).byteLength > maximum) bounded = bounded.slice(0, -1);
  return bounded;
}

function parse(input: JsonValue): { context: JsonValue; modelDispatch: ModelDispatch; callId?: string; compactionId?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("Model input must be an object");
  const context = input.context;
  const rawDispatch = input.modelDispatch;
  if (context === undefined || !rawDispatch || typeof rawDispatch !== "object" || Array.isArray(rawDispatch)) {
    throw new ValidationError("Model input requires context and a complete model dispatch");
  }
  const modelDispatch = rawDispatch as unknown as ModelDispatch;
  validateModelDispatch(modelDispatch);
  return {
    context,
    modelDispatch,
    ...(typeof input.callId === "string" ? { callId: input.callId } : {}),
    ...(typeof input.compactionId === "string" ? { compactionId: input.compactionId } : {}),
  };
}

export type ProviderConcurrency = number | Readonly<Record<string, number>>;
type Waiter = { readonly resolve: (release: () => void) => void; readonly reject: (error: unknown) => void; readonly signal: AbortSignal; readonly abort: () => void };

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
  #catalog: ModelCatalogSnapshot | undefined;

  constructor(
    providers: readonly ModelProvider[],
    concurrency: ProviderConcurrency = 1,
    catalog?: ModelCatalogSnapshot,
  ) {
    for (const provider of providers) {
      if (provider.capabilities?.contextWindowTokens !== undefined && (!Number.isSafeInteger(provider.capabilities.contextWindowTokens) || provider.capabilities.contextWindowTokens < 2)) throw new ValidationError(`Model provider ${provider.name} context window must be an integer of at least 2 tokens`);
      if (provider.capabilities?.streaming === true && typeof provider.stream !== "function") {
        throw new ValidationError(`Model provider ${provider.name} declares streaming without a stream implementation`);
      }
      if (this.#providers.has(provider.name)) throw new ValidationError(`Duplicate model provider: ${provider.name}`);
      this.#providers.set(provider.name, provider);
    }
    this.#limiter = new ProviderLimiter(concurrency);
    this.#catalog = catalog;
  }

  attachCatalog(catalog: ModelCatalogSnapshot): void { this.#catalog = catalog; }

  executionOrigins(): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(
      [...this.#providers.values()]
        .filter((provider): provider is ModelProvider & { executionOrigin: string } => provider.executionOrigin !== undefined)
        .map((provider) => [provider.name, provider.executionOrigin]),
    ));
  }

  isProductTransport(provider: string): boolean {
    return this.#providers.get(provider.trim().toLowerCase())?.productTransport === true;
  }

  providers(): ModelProviderDescriptor[] {
    return [...this.#providers.values()].map((provider) => {
      const availability = provider.availability?.() ?? { usable: true, credentialSource: "programmatic" as const };
      return {
        name: provider.name,
        displayName: provider.displayName ?? provider.name,
        capabilities: {
          streaming: provider.capabilities?.streaming === true,
          reasoningControl: provider.capabilities?.reasoningControl ?? "none",
          ...(provider.capabilities?.contextWindowTokens === undefined ? {} : {
            contextWindowTokens: provider.capabilities.contextWindowTokens,
            contextCapacitySource: provider.capabilities.contextCapacitySource ?? "provider-metadata",
          }),
        },
        ...availability,
      };
    });
  }

  normalizeConfiguration(configuration: ModelConfigurationInput): ModelConfiguration {
    const normalized = this.normalizeConfigurationIdentity(configuration);
    const provider = this.#providers.get(normalized.provider);
    assertReasoningSelection(normalized.reasoningEffort, this.#capability(provider, normalized.model));
    return normalized;
  }

  normalizeConfigurationIdentity(configuration: ModelConfigurationInput): ModelConfiguration {
    if (!configuration || typeof configuration.provider !== "string" || !configuration.provider.trim() ||
        typeof configuration.model !== "string" || !configuration.model.trim()) {
      throw new ValidationError("Model configuration requires provider and model");
    }
    if (configuration.temperature !== undefined && (!Number.isFinite(configuration.temperature) || configuration.temperature < 0 || configuration.temperature > 2)) {
      throw new ValidationError("Model temperature must be a finite value from 0 to 2");
    }
    if (configuration.maxOutputTokens !== undefined && (!Number.isSafeInteger(configuration.maxOutputTokens) || configuration.maxOutputTokens < 1)) {
      throw new ValidationError("Model maxOutputTokens must be a positive integer");
    }
    const providerName = configuration.provider.trim().toLowerCase();
    const provider = this.#providers.get(providerName);
    const model = provider?.normalizeModel?.(configuration.model) ?? configuration.model.trim();
    const normalized: ModelConfiguration = {
      provider: providerName,
      model,
      ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature }),
      ...(configuration.maxOutputTokens === undefined ? {} : { maxOutputTokens: configuration.maxOutputTokens }),
      reasoningEffort: normalizeReasoningEffort(configuration.reasoningEffort),
    };
    return Object.freeze(normalized);
  }

  resolveDispatch(configuration: ModelConfigurationInput): ModelDispatch {
    const normalized = this.normalizeConfiguration(configuration);
    const provider = this.#providers.get(normalized.provider);
    if (!provider) throw new ValidationError(`Unknown model provider: ${normalized.provider}`);
    const descriptor = provider.productTransport ? this.#catalog?.descriptor(normalized.model) : undefined;
    const capability = this.#capability(provider, normalized.model);
    const catalogDigest = descriptor?.catalogDigest ?? digest(JSON.stringify({
      provider: normalized.provider,
      model: normalized.model,
      reasoningControl: provider.capabilities?.reasoningControl ?? "none",
    }));
    return resolveModelDispatch({
      configuration: normalized,
      capability,
      catalogDigest,
      ...(provider.executionEndpointId === undefined ? {} : { executionEndpointId: provider.executionEndpointId }),
    });
  }

  contextCapacity(configuration: ModelConfiguration): Readonly<{ provider: string; model: string; source: "provider-metadata" | "model-catalog" | "operator-configuration" | "unknown"; contextWindowTokens: number | null }> {
    const provider = this.#providers.get(configuration.provider);
    if (provider?.productTransport) {
      const descriptor = this.#catalog?.descriptor(configuration.model);
      return Object.freeze({
        provider: configuration.provider,
        model: configuration.model,
        source: descriptor?.contextWindowTokens == null ? "unknown" : "model-catalog",
        contextWindowTokens: descriptor?.contextWindowTokens ?? null,
      });
    }
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
      const { context: modelContext, modelDispatch, callId } = parse(request.input);
      const configuration = modelDispatch.configuration;
      const provider = this.#providers.get(configuration.provider);
      if (!provider) return result("failed", undefined, `Unknown model provider: ${configuration.provider}`);
      if (provider.executionEndpointId !== modelDispatch.executionEndpointId) {
        return result("failed", { errorClassification: { provider: configuration.provider, model: configuration.model, code: "endpoint-drift" } }, "Retained model dispatch endpoint differs from the current configured transport origin");
      }
      const release = await this.#limiter.acquire(configuration.provider, context.signal);
      try {
        const useStreaming = provider.capabilities?.streaming === true;
        const response = useStreaming
          ? await provider.stream!(modelContext, configuration, context.signal, (delta) => {
              for (let offset = 0; offset < delta.text.length; offset += 4_096) {
                context.reportProgress?.({
                  kind: "model-output-delta",
                  value: {
                    text: delta.text.slice(offset, offset + 4_096),
                    provider: configuration.provider,
                    model: configuration.model,
                    reasoningEffort: configuration.reasoningEffort,
                    ...(callId === undefined ? {} : { callId }),
                  },
                });
              }
            })
          : await provider.complete(modelContext, configuration, context.signal);
        return result("succeeded", normalizeModelResponse(response) as unknown as JsonValue);
      } finally { release(); }
    } catch (error) {
      if (context.signal.aborted || error instanceof DOMException && error.name === "AbortError") return result("cancelled", undefined, "Model call cancelled");
      const retained = retainedModelIdentity(request.input);
      const classified = classifyProviderError(error, retained.provider, retained.model);
      return result("failed", { errorClassification: classified }, providerErrorMessage(classified.code));
    }
  }

  #capability(provider: ModelProvider | undefined, model: string): ModelReasoningCapability {
    if (provider?.productTransport) return this.#catalog?.descriptor(model).reasoning ?? {
      status: "unverified",
      levels: STANDARD_UNVERIFIED_REASONING_LEVELS,
    };
    if (provider?.capabilities?.reasoningControl === "normalized") return {
      status: "unverified",
      levels: STANDARD_UNVERIFIED_REASONING_LEVELS,
    };
    return { status: "unsupported", levels: [] };
  }
}

function normalizeModelResponse(value: ModelResponse): ModelResponse {
  if (!value || typeof value.text !== "string" || typeof value.finishReason !== "string") {
    throw new ValidationError("Model provider returned an invalid response");
  }
  const usage = value.usage;
  if (!usage || ![usage.inputTokens, usage.outputTokens, usage.costUsd].every(
    item => typeof item === "number" && Number.isFinite(item) && item >= 0,
  )) {
    throw new ValidationError("Model provider returned invalid usage");
  }
  const warnings = normalizeRetainedWarnings(value.warnings);
  return {
    text: value.text,
    finishReason: normalizeFinishReason(value.finishReason),
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd },
    ...(warnings.length ? { warnings } : {}),
  };
}

function normalizeRetainedWarnings(value: readonly ModelWarning[] | undefined): ModelWarning[] {
  if (!Array.isArray(value)) return [];
  const normalized = value.slice(0, 8).map((warning): ModelWarning => {
    const kind = warning && ["coerced", "unsupported", "provider", "truncated"].includes(warning.kind)
      ? warning.kind : "provider";
    const message = boundedText(scrubProviderText(typeof warning?.message === "string" ? warning.message : "Provider warning"), 1_024);
    return { kind, message: message || "Provider warning" };
  });
  if (value.length > 8) {
    normalized[7] = { kind: "truncated", message: `Additional provider warnings were omitted (${value.length - 7} hidden)` };
  }
  return normalized;
}

function retainedModelIdentity(input: JsonValue): { provider: string; model: string } {
  if (input && typeof input === "object" && !Array.isArray(input) &&
      input.modelDispatch && typeof input.modelDispatch === "object" && !Array.isArray(input.modelDispatch) &&
      input.modelDispatch.configuration && typeof input.modelDispatch.configuration === "object" && !Array.isArray(input.modelDispatch.configuration)) {
    const configuration = input.modelDispatch.configuration;
    return {
      provider: typeof configuration.provider === "string" ? configuration.provider : "unknown",
      model: typeof configuration.model === "string" ? configuration.model : "unknown",
    };
  }
  return { provider: "unknown", model: "unknown" };
}

function classifyProviderError(error: unknown, provider: string, model: string): { provider: string; model: string; code: string } {
  if (error instanceof ModelProviderContextWindowOverflowError) return { provider: error.provider, model: error.model, code: error.code };
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof record.statusCode === "number" ? record.statusCode : typeof record.status === "number" ? record.status : undefined;
  const text = `${typeof record.name === "string" ? record.name : ""} ${typeof record.message === "string" ? record.message : ""} ${typeof record.code === "string" ? record.code : ""}`;
  if ([400, 413, 422].includes(status ?? -1) &&
      /context(?:_| )?(?:length|window)|maximum context|prompt (?:is )?too long|too many input tokens/i.test(text)) {
    return { provider, model, code: "provider-confirmed-context-window-overflow" };
  }
  if (status === 401 || status === 403) return { provider, model, code: "authentication" };
  if (status === 429) return { provider, model, code: "rate-limit" };
  if (status === 404 || /no route|routing|model not found/i.test(text)) return { provider, model, code: "routing" };
  if (/parse|malformed|invalid (?:json|response)|response.*invalid/i.test(text)) return { provider, model, code: "malformed-response" };
  return { provider, model, code: "transport" };
}

function providerErrorMessage(code: string): string {
  if (code === "provider-confirmed-context-window-overflow") return "Model provider confirmed that the context window overflowed";
  if (code === "authentication") return "Model provider authentication failed";
  if (code === "rate-limit") return "Model provider rate limit was reached";
  if (code === "routing") return "Model provider could not route the configured model";
  if (code === "malformed-response") return "Model provider returned a malformed response";
  return "Model provider request failed";
}

function digest(value: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(value);
  return hash.digest("hex");
}

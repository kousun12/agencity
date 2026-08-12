import {
  STANDARD_UNVERIFIED_REASONING_LEVELS,
  ValidationError,
  isCanonicalProductModelId,
  type JsonValue,
  type ModelDescriptor,
  type RequestedReasoningEffort,
} from "../domain/index.ts";
import type { ProfileModelCatalogCacheRecord, ProfileStore } from "../storage/index.ts";

export const OFFICIAL_GATEWAY_ORIGIN = "https://ai-gateway.vercel.sh";
export const MODEL_CATALOG_CACHE_SCHEMA_VERSION = 1 as const;
export const MODEL_CATALOG_FRESHNESS_MS = 24 * 60 * 60 * 1_000;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_MODELS = 10_000;
const MAX_TEXT = 16_384;
const SELECTABLE = new Set<RequestedReasoningEffort>(STANDARD_UNVERIFIED_REASONING_LEVELS);
const UNKNOWN_REQUIRED_TOOL_SET = Object.freeze({
  status: "unknown" as const,
  strictSchema: "unknown" as const,
  requiredChoice: "unknown" as const,
});

export interface ModelCatalogRefreshResult {
  readonly status: "refreshed" | "cached-fallback" | "unavailable";
  readonly descriptors: readonly ModelDescriptor[];
  readonly error?: string;
}

export interface ModelCatalogOptions {
  readonly gatewayOrigin?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly freshnessMs?: number;
}

export class ModelCatalog {
  readonly gatewayOrigin: string;
  readonly catalogUrl: string;
  readonly gatewayModelApiBaseUrl: string;
  readonly endpointId: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #freshnessMs: number;
  #descriptors = new Map<string, ModelDescriptor>();
  #fetchedAt: string | null = null;
  #expiresAt: string | null = null;

  constructor(readonly profile: ProfileStore, options: ModelCatalogOptions = {}) {
    this.gatewayOrigin = normalizeOrigin(options.gatewayOrigin ?? OFFICIAL_GATEWAY_ORIGIN, "AI_GATEWAY_BASE_URL");
    this.catalogUrl = `${this.gatewayOrigin}/v1/models`;
    this.gatewayModelApiBaseUrl = `${this.gatewayOrigin}/v4/ai`;
    this.endpointId = sha256(this.gatewayOrigin);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#freshnessMs = options.freshnessMs ?? MODEL_CATALOG_FRESHNESS_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 120_000) {
      throw new ValidationError("Model catalog timeout must be from 1 to 120000 milliseconds");
    }
  }

  async hydrate(): Promise<void> {
    let cached: ProfileModelCatalogCacheRecord | null;
    try {
      cached = await this.profile.getModelCatalogCache(this.endpointId);
    } catch {
      await this.profile.deleteModelCatalogCache(this.endpointId);
      return;
    }
    if (!cached || cached.catalogOrigin !== this.gatewayOrigin) return;
    try {
      this.#install(cached.descriptors, cached.fetchedAt, cached.expiresAt);
    } catch {
      await this.profile.deleteModelCatalogCache(this.endpointId);
    }
  }

  list(options: { readonly creator?: string } = {}): readonly ModelDescriptor[] {
    const stale = this.#expiresAt === null || Date.now() >= Date.parse(this.#expiresAt);
    return Object.freeze([...this.#descriptors.values()]
      .filter((descriptor) => options.creator === undefined || descriptor.model.startsWith(`${options.creator}/`))
      .map((descriptor) => Object.freeze({ ...descriptor, stale }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.model.localeCompare(right.model)));
  }

  descriptor(model: string): ModelDescriptor {
    const existing = this.#descriptors.get(model);
    if (existing) {
      return Object.freeze({ ...existing, stale: this.#expiresAt === null || Date.now() >= Date.parse(this.#expiresAt) });
    }
    const synthesized = {
      model,
      displayName: model,
      contextWindowTokens: null,
      maxOutputTokens: null,
      pricing: null,
      reasoning: { status: "unverified" as const, levels: STANDARD_UNVERIFIED_REASONING_LEVELS },
      requiredToolSet: UNKNOWN_REQUIRED_TOOL_SET,
      catalogEndpointId: this.endpointId,
      stale: this.#expiresAt === null || Date.now() >= Date.parse(this.#expiresAt),
    };
    return Object.freeze({
      ...synthesized,
      catalogDigest: sha256(stableJson({ ...synthesized, stale: false })),
    });
  }

  async refresh(): Promise<ModelCatalogRefreshResult> {
    try {
      const descriptors = await this.#fetchAndNormalize();
      const fetchedAt = new Date().toISOString();
      const expiresAt = new Date(Date.parse(fetchedAt) + this.#freshnessMs).toISOString();
      const serialized = descriptors.map((descriptor) => ({ ...descriptor, stale: false })) as unknown as JsonValue;
      const record: ProfileModelCatalogCacheRecord = {
        endpointId: this.endpointId,
        catalogOrigin: this.gatewayOrigin,
        descriptors: serialized,
        revisionDigest: sha256(stableJson(serialized)),
        fetchedAt,
        expiresAt,
        schemaVersion: MODEL_CATALOG_CACHE_SCHEMA_VERSION,
      };
      await this.profile.putModelCatalogCache(record);
      this.#install(serialized, fetchedAt, expiresAt);
      return { status: "refreshed", descriptors: this.list() };
    } catch (error) {
      const message = boundedError(error);
      if (this.#fetchedAt !== null) {
        return { status: "cached-fallback", descriptors: this.list(), error: message };
      }
      return { status: "unavailable", descriptors: [], error: message };
    }
  }

  async ensureFresh(): Promise<ModelCatalogRefreshResult> {
    if (this.#fetchedAt !== null && this.#expiresAt !== null && Date.now() < Date.parse(this.#expiresAt)) {
      return { status: "refreshed", descriptors: this.list() };
    }
    return this.refresh();
  }

  async #fetchAndNormalize(): Promise<ModelDescriptor[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let bytes: Uint8Array;
    try {
      const response = await this.#fetch(this.catalogUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new ValidationError(`Model catalog request failed with HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) throw new ValidationError("Model catalog response exceeds its byte bound");
      bytes = await readBoundedBody(response.body, MAX_CATALOG_BYTES, controller.signal);
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ValidationError(controller.signal.aborted || error instanceof DOMException && error.name === "AbortError"
        ? "Model catalog request timed out"
        : "Model catalog request failed");
    } finally {
      clearTimeout(timeout);
    }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new ValidationError("Model catalog returned invalid JSON"); }
    const records = catalogRecords(body);
    if (records.length > MAX_CATALOG_MODELS) throw new ValidationError("Model catalog contains too many models");
    const ids = new Set<string>();
    const descriptors: ModelDescriptor[] = [];
    for (const record of records) {
      if (boundedString(record.type, "model type", 64) !== "language") continue;
      const descriptor = normalizeDescriptor(record, this.endpointId);
      if (ids.has(descriptor.model)) throw new ValidationError("Model catalog contains duplicate model IDs");
      ids.add(descriptor.model);
      descriptors.push(descriptor);
    }
    return descriptors;
  }

  #install(value: JsonValue, fetchedAt: string, expiresAt: string): void {
    if (!Array.isArray(value) || value.length > MAX_CATALOG_MODELS) throw new ValidationError("Cached model catalog is corrupt");
    const next = new Map<string, ModelDescriptor>();
    for (const item of value) {
      const descriptor = parseCachedDescriptor(item, this.endpointId);
      if (next.has(descriptor.model)) throw new ValidationError("Cached model catalog contains duplicate models");
      next.set(descriptor.model, descriptor);
    }
    this.#descriptors = next;
    this.#fetchedAt = fetchedAt;
    this.#expiresAt = expiresAt;
  }
}

export function normalizeOrigin(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ValidationError(`${label} must be an absolute HTTP(S) origin`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new ValidationError(`${label} must be an origin without credentials, path, query, or fragment`);
  }
  return url.origin;
}

export function executionEndpointId(origin: string): string {
  return sha256(origin);
}

function catalogRecords(value: unknown): Array<Record<string, unknown>> {
  const records = Array.isArray(value)
    ? value
    : value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : null;
  if (!records) throw new ValidationError("Model catalog response must contain a data array");
  return records.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ValidationError("Model catalog entry must be an object");
    return item as Record<string, unknown>;
  });
}

function normalizeDescriptor(record: Record<string, unknown>, endpointId: string): ModelDescriptor {
  const model = boundedString(record.id, "model ID", 512);
  if (!isCanonicalProductModelId(model)) {
    throw new ValidationError("Model catalog ID must use bounded canonical creator/model form");
  }
  const displayName = record.name === undefined ? model : boundedString(record.name, "model name", MAX_TEXT);
  const tags = boundedStringArray(record.tags, "model tags");
  const options = record.reasoning_options;
  const levels: RequestedReasoningEffort[] = [];
  const unsupported: string[] = [];
  let hasSelectableEffort = false;
  let hasToggle = false;
  let hasNonEffortReasoning = false;
  if (options !== null && options !== undefined) {
    if (!Array.isArray(options) || options.length > 32) throw new ValidationError("Model reasoning options are invalid");
    for (const raw of options) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("Model reasoning option is invalid");
      const option = raw as Record<string, unknown>;
      if (option.type === "toggle") {
        hasToggle = true;
        hasNonEffortReasoning = true;
      }
      if (option.type === "budget_tokens") hasNonEffortReasoning = true;
      if (option.type !== "effort") continue;
      if (!Array.isArray(option.values) || option.values.length > 32) throw new ValidationError("Model reasoning effort values are invalid");
      for (const value of option.values) {
        const level = boundedString(value, "reasoning effort", 64);
        if (SELECTABLE.has(level as RequestedReasoningEffort)) {
          hasSelectableEffort = true;
          if (!levels.includes(level as RequestedReasoningEffort)) levels.push(level as RequestedReasoningEffort);
        } else if (!unsupported.includes(level)) unsupported.push(level);
      }
    }
  }
  if (hasToggle && !levels.includes("none")) levels.unshift("none");
  const reasoning = hasSelectableEffort
    ? { status: "listed" as const, levels: Object.freeze(levels) }
    : tags.includes("reasoning") || hasNonEffortReasoning
      ? { status: "unverified" as const, levels: STANDARD_UNVERIFIED_REASONING_LEVELS }
      : { status: "unsupported" as const, levels: Object.freeze([]) };
  const normalized = {
    model,
    displayName,
    contextWindowTokens: boundedIntegerOrNull(record.context_window, "context window"),
    maxOutputTokens: boundedIntegerOrNull(record.max_tokens, "maximum output"),
    pricing: normalizePricing(record.pricing),
    reasoning,
    // The current Gateway catalog has no authoritative normalized formal-tool
    // fields. Unrecognized provider-specific keys must not imply support or
    // lack of support.
    requiredToolSet: UNKNOWN_REQUIRED_TOOL_SET,
    catalogEndpointId: endpointId,
    stale: false,
    ...(unsupported.length ? { unsupportedReasoningValues: Object.freeze(unsupported.slice(0, 16)) } : {}),
  };
  return Object.freeze({ ...normalized, catalogDigest: sha256(stableJson(normalized)) });
}

function parseCachedDescriptor(value: JsonValue, endpointId: string): ModelDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Cached model descriptor is invalid");
  const model = boundedString(value.model, "cached model ID", 512);
  if (!isCanonicalProductModelId(model)) {
    throw new ValidationError("Cached model ID must use bounded canonical creator/model form");
  }
  const displayName = boundedString(value.displayName, "cached model name", MAX_TEXT);
  const status = value.reasoning && typeof value.reasoning === "object" && !Array.isArray(value.reasoning)
    ? value.reasoning.status : undefined;
  const rawLevels = value.reasoning && typeof value.reasoning === "object" && !Array.isArray(value.reasoning)
    ? value.reasoning.levels : undefined;
  if (!["listed", "unverified", "unsupported"].includes(String(status)) || !Array.isArray(rawLevels) ||
      rawLevels.some((level) => typeof level !== "string" || !SELECTABLE.has(level as RequestedReasoningEffort))) {
    throw new ValidationError("Cached model reasoning capability is invalid");
  }
  if (value.catalogEndpointId !== endpointId || typeof value.catalogDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.catalogDigest)) {
    throw new ValidationError("Cached model descriptor endpoint provenance is invalid");
  }
  const pricing = value.pricing === null ? null : normalizePricing(value.pricing);
  const unsupportedReasoningValues = value.unsupportedReasoningValues === undefined
    ? undefined
    : boundedStringArray(value.unsupportedReasoningValues, "cached unsupported reasoning values").slice(0, 16);
  const normalized = {
    model,
    displayName,
    contextWindowTokens: boundedIntegerOrNull(value.contextWindowTokens, "cached context window"),
    maxOutputTokens: boundedIntegerOrNull(value.maxOutputTokens, "cached maximum output"),
    pricing,
    reasoning: { status: status as ModelDescriptor["reasoning"]["status"], levels: Object.freeze(rawLevels as RequestedReasoningEffort[]) },
    requiredToolSet: parseCachedRequiredToolSet(value.requiredToolSet),
    catalogEndpointId: endpointId,
    stale: false,
    ...(unsupportedReasoningValues?.length
      ? { unsupportedReasoningValues: Object.freeze(unsupportedReasoningValues) }
      : {}),
  };
  const catalogDigest = sha256(stableJson(normalized));
  if (value.catalogDigest !== catalogDigest) throw new ValidationError("Cached model descriptor digest is corrupt");
  return Object.freeze({ ...normalized, catalogDigest });
}

function parseCachedRequiredToolSet(
  value: JsonValue | undefined,
): NonNullable<ModelDescriptor["requiredToolSet"]> {
  if (value === undefined) return UNKNOWN_REQUIRED_TOOL_SET;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.status !== "unknown" || value.strictSchema !== "unknown" ||
      value.requiredChoice !== "unknown" || Object.keys(value).length !== 3) {
    throw new ValidationError("Cached model formal-tool capability is invalid");
  }
  return UNKNOWN_REQUIRED_TOOL_SET;
}

async function readBoundedBody(body: ReadableStream<Uint8Array> | null, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!body) throw new ValidationError("Model catalog response has no body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAbort!: (error: DOMException) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(new DOMException("Model catalog request timed out", "AbortError"));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel("Model catalog response exceeds its byte bound").catch(() => {});
        throw new ValidationError("Model catalog response exceeds its byte bound");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (signal.aborted) await reader.cancel("Model catalog request timed out").catch(() => {});
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function normalizePricing(value: unknown): ModelDescriptor["pricing"] {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Model pricing is invalid");
  const record = value as Record<string, unknown>;
  const rawInput = record.inputUsdPerToken ?? record.input;
  const rawOutput = record.outputUsdPerToken ?? record.output;
  // The Gateway catalog also lists free and non-token-priced language models
  // whose pricing object does not contain both token rates. Pricing is optional
  // descriptor metadata, so an incomplete pair means "unknown".
  if (rawInput === undefined || rawOutput === undefined) return null;
  const input = finiteNonnegative(rawInput, "input price");
  const output = finiteNonnegative(rawOutput, "output price");
  return Object.freeze({ inputUsdPerToken: input, outputUsdPerToken: output });
}

function finiteNonnegative(value: unknown, label: string): number {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000) {
    throw new ValidationError(`Model ${label} is invalid`);
  }
  return parsed;
}

function boundedIntegerOrNull(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) {
    throw new ValidationError(`Model ${label} is invalid`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).byteLength > maximum) {
    throw new ValidationError(`Model catalog ${label} is invalid`);
  }
  return value;
}

function boundedStringArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 128) throw new ValidationError(`Model catalog ${label} are invalid`);
  return value.map((item) => boundedString(item, label, 128));
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const bytes = new TextEncoder().encode(message);
  return new TextDecoder().decode(bytes.slice(0, 2_048));
}

function sha256(value: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(value);
  return hash.digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

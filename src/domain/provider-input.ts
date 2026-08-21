import { ValidationError } from "./errors.ts";
import {
  assertJsonValue,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  canonicalJsonStringify,
  type JsonValue,
  type Sha256Digest,
} from "./json.ts";
import {
  validateModelDispatch,
  type ModelDispatch,
  type ReasoningEffort,
} from "./model.ts";

export const PROVIDER_INPUT_VERSION = "agencity.provider-input.v2" as const;
export const PROVIDER_INPUT_ESTIMATOR_ID =
  "provider-input-utf8-bytes-per-4-tokens-v1" as const;
export const PROVIDER_INPUT_OPENAI_CACHE_TTL = "30m" as const;
export const UNKNOWN_CAPACITY_PROVIDER_INPUT_HARD_BYTES = 512 * 1024;
export const UNKNOWN_CAPACITY_PROVIDER_INPUT_TARGET_BYTES = 384 * 1024;

export class ProviderInputProductLimitError extends Error {
  readonly code = "provider-input-product-limit" as const;
  readonly hardLimitBytes = UNKNOWN_CAPACITY_PROVIDER_INPUT_HARD_BYTES;
  readonly targetBytes = UNKNOWN_CAPACITY_PROVIDER_INPUT_TARGET_BYTES;
  constructor(readonly candidateBytes: number) {
    super(
      `Unknown-capacity provider input is ${candidateBytes} bytes, above the ${UNKNOWN_CAPACITY_PROVIDER_INPUT_HARD_BYTES}-byte product ceiling`,
    );
    this.name = "ProviderInputProductLimitError";
  }
}

export interface ProviderInputTextMessage {
  readonly kind: "text";
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly cacheBreakpoint?: true;
}

export interface ProviderInputAssistantToolCallMessage {
  readonly kind: "assistant-tool-call";
  readonly callId: string;
  readonly name: string;
  readonly input: JsonValue;
}

export interface ProviderInputToolResultMessage {
  readonly kind: "tool-result";
  readonly callId: string;
  readonly name: string;
  readonly content: string;
  readonly cacheBreakpoint?: true;
}

export type ProviderInputMessage =
  | ProviderInputTextMessage
  | ProviderInputAssistantToolCallMessage
  | ProviderInputToolResultMessage;

export type ProviderInputCacheContract =
  | { readonly mode: "disabled" }
  | {
      readonly mode: "openai-explicit";
      readonly promptCacheKey: string;
      readonly ttl: typeof PROVIDER_INPUT_OPENAI_CACHE_TTL;
    };

export interface ProviderInputTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
  readonly schemaDigest: Sha256Digest;
  readonly strict: boolean;
}

export interface ProviderInputCapacityProvenance {
  readonly provider: string;
  readonly model: string;
  readonly source:
    | "provider-metadata"
    | "model-catalog"
    | "operator-configuration"
    | "unknown";
  readonly contextWindowTokens: number | null;
  readonly outputReserveTokens: number;
  readonly estimatorId: string;
  readonly triggerRatio: number;
  readonly targetRatio: number;
}

export interface ProviderInputCandidate {
  readonly version: typeof PROVIDER_INPUT_VERSION;
  readonly messages: readonly ProviderInputMessage[];
  readonly tools: readonly ProviderInputTool[];
  readonly cache: ProviderInputCacheContract;
  readonly policy: {
    readonly schemaEnforcement: "none" | "provider-strict" | "runtime-validated";
    readonly selection: "text" | "exactly-one-of";
    readonly toolChoice: "none" | "required";
    readonly parallelCalls:
      | "not-applicable"
      | "provider-disabled"
      | "runtime-rejected"
      | "unknown";
  };
  readonly options: {
    readonly temperature?: number;
    readonly maxOutputTokens?: number;
    readonly reasoningEffort?: Exclude<ReasoningEffort, "provider-default">;
    readonly outputReserveTokens: number;
  };
  readonly provenance: {
    readonly responseContract: {
      readonly kind: "text" | "required-tool-set";
      readonly version: number;
      readonly contractId: string | null;
      readonly contractDigest: Sha256Digest | null;
    };
    readonly dispatchVersion: ModelDispatch["dispatchVersion"];
    readonly dispatchDigest: Sha256Digest;
    readonly executionEndpointId: string | null;
    readonly provider: string;
    readonly model: string;
    readonly catalogDigest: string;
    readonly capacity: ProviderInputCapacityProvenance;
    readonly estimatorId: typeof PROVIDER_INPUT_ESTIMATOR_ID;
  };
  /** Digest of every candidate field except these two integrity fields. */
  readonly digest: Sha256Digest;
  /** Exact canonical UTF-8 bytes of the complete candidate, including integrity fields. */
  readonly exactUtf8Bytes: number;
}

export interface ProviderInputAdmission {
  readonly version: typeof PROVIDER_INPUT_VERSION;
  readonly digest: Sha256Digest;
  readonly modelDispatch: ModelDispatch;
  readonly capacity: ProviderInputCapacityProvenance;
}

type ProviderInputCandidateBody = Omit<
  ProviderInputCandidate,
  "digest" | "exactUtf8Bytes"
>;

/**
 * Builds the one provider-input object used by estimation and execution.
 * Retained context fields outside `messages` are deliberately unsent.
 */
export function buildProviderInputCandidate(input: {
  readonly context: JsonValue;
  readonly modelDispatch: ModelDispatch;
  readonly capacity: ProviderInputCapacityProvenance;
}): ProviderInputCandidate {
  validateModelDispatch(input.modelDispatch);
  validateCapacity(input.capacity, input.modelDispatch);
  const dispatch = input.modelDispatch;
  const contract = dispatch.responseContract;
  const capability = dispatch.responseCapability;
  const body: ProviderInputCandidateBody = {
    version: PROVIDER_INPUT_VERSION,
    messages: normalizeProviderMessages(input.context),
    tools: contract.kind === "required-tool-set"
      ? contract.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: cloneJson(tool.inputSchema),
          schemaDigest: tool.schemaDigest,
          strict: contract.schemaEnforcement === "provider-strict",
        }))
      : [],
    cache: deriveProviderInputCache(input.context, dispatch),
    policy: contract.kind === "required-tool-set"
      ? {
          schemaEnforcement: contract.schemaEnforcement,
          selection: contract.selection,
          toolChoice: "required",
          parallelCalls: capability.kind === "required-tool-set"
            ? normalizeParallelPolicy(capability.capability.parallelCalls)
            : "unknown",
        }
      : {
          schemaEnforcement: "none",
          selection: "text",
          toolChoice: "none",
          parallelCalls: "not-applicable",
        },
    options: {
      ...(dispatch.configuration.temperature === undefined
        ? {}
        : { temperature: dispatch.configuration.temperature }),
      ...(dispatch.configuration.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: dispatch.configuration.maxOutputTokens }),
      ...(dispatch.configuration.reasoningEffort === "provider-default"
        ? {}
        : { reasoningEffort: dispatch.configuration.reasoningEffort }),
      outputReserveTokens: input.capacity.outputReserveTokens,
    },
    provenance: {
      responseContract: contract.kind === "required-tool-set"
        ? {
            kind: contract.kind,
            version: contract.version,
            contractId: contract.contractId,
            contractDigest: contract.contractDigest,
          }
        : {
            kind: contract.kind,
            version: contract.version,
            contractId: null,
            contractDigest: null,
          },
      dispatchVersion: dispatch.dispatchVersion,
      dispatchDigest: canonicalJsonDigest(dispatch as unknown as JsonValue),
      executionEndpointId: dispatch.executionEndpointId ?? null,
      provider: dispatch.configuration.provider,
      model: dispatch.configuration.model,
      catalogDigest: dispatch.reasoning.capability.catalogDigest,
      capacity: cloneJson(input.capacity as unknown as JsonValue) as unknown as ProviderInputCapacityProvenance,
      estimatorId: PROVIDER_INPUT_ESTIMATOR_ID,
    },
  };
  const digest = canonicalJsonDigest(body as unknown as JsonValue);
  let exactUtf8Bytes = 0;
  for (;;) {
    const next = canonicalJsonByteLength({
      ...body,
      digest,
      exactUtf8Bytes,
    });
    if (next === exactUtf8Bytes) break;
    exactUtf8Bytes = next;
  }
  return deepFreeze({
    ...body,
    digest,
    exactUtf8Bytes,
  });
}

export function validateProviderInputCandidate(
  value: unknown,
  expected?: {
    readonly context: JsonValue;
    readonly modelDispatch: ModelDispatch;
    readonly capacity: ProviderInputCapacityProvenance;
  },
): ProviderInputCandidate {
  assertJsonValue(value);
  const record = value as unknown as Record<string, JsonValue>;
  const allowed = new Set([
    "version", "messages", "tools", "cache", "policy", "options", "provenance",
    "digest", "exactUtf8Bytes",
  ]);
  if (record.version !== PROVIDER_INPUT_VERSION ||
      Object.keys(record).some((key) => !allowed.has(key)) ||
      [...allowed].some((key) => !Object.hasOwn(record, key))) {
    throw new ValidationError("Unsupported or malformed provider-input candidate");
  }
  const candidate = value as unknown as ProviderInputCandidate;
  validateCandidateShape(candidate);
  const { digest: _digest, exactUtf8Bytes: _bytes, ...body } = candidate;
  if (canonicalJsonDigest(body as unknown as JsonValue) !== candidate.digest) {
    throw new ValidationError("Provider-input candidate digest does not match its body");
  }
  if (canonicalJsonByteLength(candidate as unknown as JsonValue) !== candidate.exactUtf8Bytes) {
    throw new ValidationError("Provider-input candidate byte count does not match its canonical encoding");
  }
  if (expected) {
    const rebuilt = buildProviderInputCandidate(expected);
    if (canonicalJsonStringify(rebuilt as unknown as JsonValue) !==
        canonicalJsonStringify(candidate as unknown as JsonValue)) {
      throw new ValidationError(
        "Retained provider-input candidate differs from reconstructed context, dispatch, or capacity",
      );
    }
  }
  return deepFreeze(cloneJson(candidate as unknown as JsonValue) as unknown as ProviderInputCandidate);
}

export function providerInputAdmission(
  candidate: ProviderInputCandidate,
  modelDispatch: ModelDispatch,
): ProviderInputAdmission {
  validateProviderInputCandidate(candidate);
  validateModelDispatch(modelDispatch);
  if (candidate.provenance.dispatchDigest !==
      canonicalJsonDigest(modelDispatch as unknown as JsonValue)) {
    throw new ValidationError(
      "Provider-input admission dispatch differs from its candidate",
    );
  }
  return deepFreeze({
    version: candidate.version,
    digest: candidate.digest,
    modelDispatch: cloneJson(modelDispatch as unknown as JsonValue) as unknown as ModelDispatch,
    capacity: cloneJson(candidate.provenance.capacity as unknown as JsonValue) as unknown as ProviderInputCapacityProvenance,
  });
}

export function reconstructProviderInputCandidate(
  context: JsonValue,
  value: unknown,
): ProviderInputCandidate {
  assertJsonValue(value);
  const admission = value as unknown as ProviderInputAdmission;
  assertExactKeys(
    admission as unknown as Record<string, unknown>,
    ["version", "digest", "modelDispatch", "capacity"],
    "Provider-input admission",
  );
  if (admission.version !== PROVIDER_INPUT_VERSION || !isDigest(admission.digest)) {
    throw new ValidationError("Provider-input admission identity is invalid");
  }
  validateModelDispatch(admission.modelDispatch);
  validateCapacity(admission.capacity, admission.modelDispatch);
  const candidate = buildProviderInputCandidate({
    context,
    modelDispatch: admission.modelDispatch,
    capacity: admission.capacity,
  });
  if (candidate.version !== admission.version ||
      candidate.digest !== admission.digest) {
    throw new ValidationError(
      "Reconstructed provider-input candidate differs from retained admission",
    );
  }
  return candidate;
}

/** Exact serialized request surface used by the deterministic estimator. */
export function serializedProviderInput(candidate: ProviderInputCandidate): JsonValue {
  validateProviderInputCandidate(candidate);
  return {
    messages: cloneJson(candidate.messages as unknown as JsonValue),
    tools: cloneJson(candidate.tools as unknown as JsonValue),
    cache: cloneJson(candidate.cache as unknown as JsonValue),
    policy: cloneJson(candidate.policy as unknown as JsonValue),
    options: cloneJson(candidate.options as unknown as JsonValue),
  };
}

export function estimateProviderInputCandidate(
  candidate: ProviderInputCandidate,
): { readonly estimatedTokens: number; readonly utf8Bytes: number } {
  const utf8Bytes = canonicalJsonByteLength(serializedProviderInput(candidate));
  return Object.freeze({
    estimatedTokens: Math.ceil(utf8Bytes / 4),
    utf8Bytes,
  });
}

export function assertProviderInputWithinProductLimit(
  candidate: ProviderInputCandidate,
): void {
  validateProviderInputCandidate(candidate);
  if (candidate.provenance.capacity.source === "unknown" &&
      candidate.exactUtf8Bytes > UNKNOWN_CAPACITY_PROVIDER_INPUT_HARD_BYTES) {
    throw new ProviderInputProductLimitError(candidate.exactUtf8Bytes);
  }
}

export function normalizeProviderMessages(context: JsonValue): readonly ProviderInputMessage[] {
  const record = context && typeof context === "object" && !Array.isArray(context)
    ? context
    : {};
  const raw = Array.isArray(record.messages) ? record.messages : [];
  const messages: ProviderInputMessage[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (value.role === "assistant" && Array.isArray(value.content)) {
      for (const part of value.content) {
        if (!part || typeof part !== "object" || Array.isArray(part) ||
            part.type !== "tool-call" ||
            typeof part.toolCallId !== "string" || !part.toolCallId ||
            typeof part.toolName !== "string" || !part.toolName ||
            !Object.hasOwn(part, "input")) {
          throw new ValidationError(
            "Provider-input assistant tool-call content is invalid",
          );
        }
        assertJsonValue(part.input);
        messages.push({
          kind: "assistant-tool-call",
          callId: part.toolCallId,
          name: part.toolName,
          input: cloneJson(part.input),
        });
      }
      continue;
    }
    if (value.role === "tool" && Array.isArray(value.content)) {
      for (const part of value.content) {
        if (!part || typeof part !== "object" || Array.isArray(part) ||
            part.type !== "tool-result" ||
            typeof part.toolCallId !== "string" || !part.toolCallId ||
            typeof part.toolName !== "string" || !part.toolName ||
            typeof part.output !== "string") {
          throw new ValidationError(
            "Provider-input tool-result content is invalid",
          );
        }
        messages.push({
          kind: "tool-result",
          callId: part.toolCallId,
          name: part.toolName,
          content: part.output,
          ...(normalizeCacheBreakpoint(value.cacheBreakpoint)
            ? { cacheBreakpoint: true }
            : {}),
        });
      }
      continue;
    }
    if (value.kind === "assistant-tool-call") {
      if (typeof value.callId !== "string" || !value.callId ||
          typeof value.name !== "string" || !value.name ||
          !Object.hasOwn(value, "input")) {
        throw new ValidationError("Provider-input assistant tool call is invalid");
      }
      assertJsonValue(value.input);
      messages.push({
        kind: "assistant-tool-call",
        callId: value.callId,
        name: value.name,
        input: cloneJson(value.input),
      });
      continue;
    }
    if (value.kind === "tool-result") {
      if (typeof value.callId !== "string" || !value.callId ||
          typeof value.name !== "string" || !value.name ||
          typeof value.content !== "string" ||
          normalizeCacheBreakpoint(value.cacheBreakpoint) === null) {
        throw new ValidationError("Provider-input tool result is invalid");
      }
      messages.push({
        kind: "tool-result",
        callId: value.callId,
        name: value.name,
        content: value.content,
        ...(normalizeCacheBreakpoint(value.cacheBreakpoint)
          ? { cacheBreakpoint: true }
          : {}),
      });
      continue;
    }
    if (typeof value.content !== "string") {
      if (value.kind !== undefined) {
        throw new ValidationError("Provider-input message kind is invalid");
      }
      continue;
    }
    const normalizedBreakpoint = normalizeCacheBreakpoint(
      value.cacheBreakpoint,
    );
    const cacheBreakpoint = normalizedBreakpoint === true
      ? { cacheBreakpoint: true as const }
      : {};
    if (normalizedBreakpoint === null) {
      throw new ValidationError("Provider-input cache breakpoint is invalid");
    }
    if (value.kind === "text" || value.kind === undefined) {
      if (value.role === "system") {
        messages.push({
          kind: "text", role: "system", content: value.content,
          ...cacheBreakpoint,
        });
      } else if (value.role === "assistant") {
        messages.push({
          kind: "text", role: "assistant", content: value.content,
          ...cacheBreakpoint,
        });
      } else if (value.role === "tool") {
        messages.push({
          kind: "text",
          role: "user",
          content: `[tool observation]\n${value.content}`,
          ...cacheBreakpoint,
        });
      } else {
        messages.push({
          kind: "text", role: "user", content: value.content,
          ...cacheBreakpoint,
        });
      }
      continue;
    }
    throw new ValidationError("Provider-input message kind is invalid");
  }
  if (!messages.length) {
    messages.push({
      kind: "text",
      role: "user",
      content: JSON.stringify(context),
    });
  }
  return Object.freeze(messages.map((message) => Object.freeze(message)));
}

function normalizeCacheBreakpoint(value: JsonValue | undefined):
  | boolean
  | null {
  if (value === undefined) return false;
  if (value === true) return true;
  if (value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      value.mode === "explicit") {
    return true;
  }
  return null;
}

function validateCapacity(
  capacity: ProviderInputCapacityProvenance,
  dispatch: ModelDispatch,
): void {
  assertJsonValue(capacity);
  assertExactKeys(
    capacity as unknown as Record<string, unknown>,
    [
      "provider", "model", "source", "contextWindowTokens",
      "outputReserveTokens", "estimatorId", "triggerRatio", "targetRatio",
    ],
    "Provider-input capacity provenance",
  );
  if (capacity.provider !== dispatch.configuration.provider ||
      capacity.model !== dispatch.configuration.model ||
      !["provider-metadata", "model-catalog", "operator-configuration", "unknown"]
        .includes(capacity.source) ||
      capacity.estimatorId !== PROVIDER_INPUT_ESTIMATOR_ID ||
      (capacity.source === "unknown") !== (capacity.contextWindowTokens === null) ||
      (capacity.contextWindowTokens !== null &&
        (!Number.isSafeInteger(capacity.contextWindowTokens) ||
          capacity.contextWindowTokens <= 0)) ||
      !Number.isSafeInteger(capacity.outputReserveTokens) ||
      capacity.outputReserveTokens < 0 ||
      (capacity.contextWindowTokens !== null &&
        capacity.outputReserveTokens >= capacity.contextWindowTokens) ||
      !Number.isFinite(capacity.triggerRatio) ||
      capacity.triggerRatio <= 0 ||
      capacity.triggerRatio > 1 ||
      !Number.isFinite(capacity.targetRatio) ||
      capacity.targetRatio <= 0 ||
      capacity.targetRatio >= capacity.triggerRatio) {
    throw new ValidationError("Provider-input capacity provenance is inconsistent");
  }
}

function validateCandidateShape(candidate: ProviderInputCandidate): void {
  if (!Array.isArray(candidate.messages) || !Array.isArray(candidate.tools)) {
    throw new ValidationError("Provider-input messages and tools must be arrays");
  }
  validateProviderInputMessages(candidate.messages);
  const toolNames = new Set<string>();
  for (const tool of candidate.tools) {
    assertExactKeys(
      tool as unknown as Record<string, unknown>,
      ["name", "description", "inputSchema", "schemaDigest", "strict"],
      "Provider-input tool",
    );
    if (typeof tool.name !== "string" || !tool.name ||
        typeof tool.description !== "string" ||
        typeof tool.strict !== "boolean" ||
        !isDigest(tool.schemaDigest) ||
        toolNames.has(tool.name)) {
      throw new ValidationError("Provider-input tool declaration is invalid");
    }
    toolNames.add(tool.name);
  }
  assertExactKeys(
    candidate.policy as unknown as Record<string, unknown>,
    ["schemaEnforcement", "selection", "toolChoice", "parallelCalls"],
    "Provider-input policy",
  );
  if (!["none", "provider-strict", "runtime-validated"]
        .includes(candidate.policy.schemaEnforcement) ||
      !["text", "exactly-one-of"].includes(candidate.policy.selection) ||
      !["none", "required"].includes(candidate.policy.toolChoice) ||
      !["not-applicable", "provider-disabled", "runtime-rejected", "unknown"]
        .includes(candidate.policy.parallelCalls)) {
    throw new ValidationError("Provider-input policy is invalid");
  }
  const requiredTools = candidate.policy.selection === "exactly-one-of";
  if (requiredTools !== (candidate.policy.toolChoice === "required") ||
      requiredTools !== (candidate.tools.length > 0) ||
      candidate.tools.some((tool) =>
        tool.strict !==
          (candidate.policy.schemaEnforcement === "provider-strict"))) {
    throw new ValidationError("Provider-input tools disagree with policy");
  }
  assertAllowedKeys(
    candidate.options as unknown as Record<string, unknown>,
    ["outputReserveTokens"],
    ["temperature", "maxOutputTokens", "reasoningEffort"],
    "Provider-input options",
  );
  if (!Number.isSafeInteger(candidate.options.outputReserveTokens) ||
      candidate.options.outputReserveTokens < 0 ||
      (candidate.options.temperature !== undefined &&
        (!Number.isFinite(candidate.options.temperature) ||
          candidate.options.temperature < 0 ||
          candidate.options.temperature > 2)) ||
      (candidate.options.maxOutputTokens !== undefined &&
        (!Number.isSafeInteger(candidate.options.maxOutputTokens) ||
          candidate.options.maxOutputTokens <= 0)) ||
      (candidate.options.reasoningEffort !== undefined &&
        !["none", "minimal", "low", "medium", "high", "xhigh"]
          .includes(candidate.options.reasoningEffort))) {
    throw new ValidationError("Provider-input options are invalid");
  }
  assertExactKeys(
    candidate.provenance as unknown as Record<string, unknown>,
    [
      "responseContract", "dispatchVersion", "dispatchDigest",
      "executionEndpointId", "provider", "model", "catalogDigest",
      "capacity", "estimatorId",
    ],
    "Provider-input provenance",
  );
  assertExactKeys(
    candidate.provenance.responseContract as unknown as Record<string, unknown>,
    ["kind", "version", "contractId", "contractDigest"],
    "Provider-input response-contract provenance",
  );
  const responseContract = candidate.provenance.responseContract;
  if (!["text", "required-tool-set"].includes(responseContract.kind) ||
      !Number.isSafeInteger(responseContract.version) ||
      responseContract.version <= 0 ||
      candidate.provenance.dispatchVersion !== "agencity.model-dispatch.v2" ||
      !isDigest(candidate.provenance.dispatchDigest) ||
      (candidate.provenance.executionEndpointId !== null &&
        (typeof candidate.provenance.executionEndpointId !== "string" ||
          !candidate.provenance.executionEndpointId)) ||
      typeof candidate.provenance.provider !== "string" ||
      !candidate.provenance.provider ||
      typeof candidate.provenance.model !== "string" ||
      !candidate.provenance.model ||
      !isDigest(candidate.provenance.catalogDigest) ||
      candidate.provenance.estimatorId !== PROVIDER_INPUT_ESTIMATOR_ID ||
      (responseContract.kind === "text"
        ? responseContract.contractId !== null ||
          responseContract.contractDigest !== null
        : typeof responseContract.contractId !== "string" ||
          !responseContract.contractId ||
          !isDigest(responseContract.contractDigest))) {
    throw new ValidationError("Provider-input provenance is invalid");
  }
  validateProviderInputCache(
    candidate.cache,
    candidate.provenance.provider,
    candidate.messages,
  );
  if (candidate.cache.mode === "disabled" &&
      candidate.messages.some((message) =>
        "cacheBreakpoint" in message &&
        message.cacheBreakpoint === true)) {
    throw new ValidationError(
      "Disabled provider-input caching cannot retain cache breakpoints",
    );
  }
  validateCapacity(
    candidate.provenance.capacity,
    {
      configuration: {
        provider: candidate.provenance.provider,
        model: candidate.provenance.model,
        reasoningEffort: "provider-default",
      },
    } as ModelDispatch,
  );
}

function deriveProviderInputCache(
  context: JsonValue,
  dispatch: ModelDispatch,
): ProviderInputCacheContract {
  if (dispatch.configuration.provider !== "openai" ||
      !context || typeof context !== "object" || Array.isArray(context) ||
      !normalizeProviderMessages(context).some((message) =>
        "cacheBreakpoint" in message && message.cacheBreakpoint === true
      ) ||
      !context.session || typeof context.session !== "object" ||
      Array.isArray(context.session) ||
      typeof context.session.id !== "string" || !context.session.id ||
      typeof context.session.branchId !== "string" ||
      !context.session.branchId) {
    return Object.freeze({ mode: "disabled" });
  }
  const digest = canonicalJsonDigest({
    kind: "agencity.openai-prompt-cache-key.v1",
    sessionId: context.session.id,
    branchId: context.session.branchId,
  });
  return Object.freeze({
    mode: "openai-explicit",
    promptCacheKey: digest.slice("sha256:".length),
    ttl: PROVIDER_INPUT_OPENAI_CACHE_TTL,
  });
}

function validateProviderInputMessages(
  messages: readonly ProviderInputMessage[],
): void {
  const calls = new Map<string, string>();
  const results = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new ValidationError("Provider-input message is invalid");
    }
    if (message.kind === "text") {
      assertAllowedKeys(
        message as unknown as Record<string, unknown>,
        ["kind", "role", "content"],
        ["cacheBreakpoint"],
        "Provider-input text message",
      );
      if (!["system", "user", "assistant"].includes(message.role) ||
          typeof message.content !== "string" ||
          (message.cacheBreakpoint !== undefined &&
            message.cacheBreakpoint !== true)) {
        throw new ValidationError("Provider-input text message is invalid");
      }
      continue;
    }
    if (message.kind === "assistant-tool-call") {
      assertExactKeys(
        message as unknown as Record<string, unknown>,
        ["kind", "callId", "name", "input"],
        "Provider-input assistant tool call",
      );
      if (typeof message.callId !== "string" || !message.callId ||
          typeof message.name !== "string" || !message.name ||
          calls.has(message.callId)) {
        throw new ValidationError(
          "Provider-input assistant tool call is invalid",
        );
      }
      assertJsonValue(message.input);
      calls.set(message.callId, message.name);
      continue;
    }
    if (message.kind === "tool-result") {
      assertAllowedKeys(
        message as unknown as Record<string, unknown>,
        ["kind", "callId", "name", "content"],
        ["cacheBreakpoint"],
        "Provider-input tool result",
      );
      if (typeof message.callId !== "string" || !message.callId ||
          typeof message.name !== "string" || !message.name ||
          typeof message.content !== "string" ||
          calls.get(message.callId) !== message.name ||
          results.has(message.callId) ||
          (message.cacheBreakpoint !== undefined &&
            message.cacheBreakpoint !== true)) {
        throw new ValidationError("Provider-input tool result is invalid");
      }
      results.add(message.callId);
      continue;
    }
    throw new ValidationError("Provider-input message kind is invalid");
  }
}

function validateProviderInputCache(
  cache: ProviderInputCacheContract,
  provider: string,
  messages: readonly ProviderInputMessage[],
): void {
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    throw new ValidationError("Provider-input cache contract is invalid");
  }
  if (cache.mode === "disabled") {
    assertExactKeys(
      cache as unknown as Record<string, unknown>,
      ["mode"],
      "Provider-input cache contract",
    );
    return;
  }
  assertExactKeys(
    cache as unknown as Record<string, unknown>,
    ["mode", "promptCacheKey", "ttl"],
    "Provider-input cache contract",
  );
  if (cache.mode !== "openai-explicit" || provider !== "openai" ||
      typeof cache.promptCacheKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(cache.promptCacheKey) ||
      cache.ttl !== PROVIDER_INPUT_OPENAI_CACHE_TTL ||
      !messages.some((message) =>
        "cacheBreakpoint" in message && message.cacheBreakpoint === true
      )) {
    throw new ValidationError("Provider-input cache contract is invalid");
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  assertAllowedKeys(value, keys, [], label);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) =>
        !required.includes(key) && !optional.includes(key))) {
    throw new ValidationError(`${label} has missing or unknown fields`);
  }
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === "string" &&
    /^(?:sha256:)?[a-f0-9]{64}$/.test(value);
}

function normalizeParallelPolicy(
  value: "provider-disabled" | "runtime-rejected" | "unknown" | "unsupported",
): ProviderInputCandidate["policy"]["parallelCalls"] {
  return value === "unsupported" ? "unknown" : value;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

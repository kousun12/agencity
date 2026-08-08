import { ValidationError } from "./errors.ts";
import { assertJsonValue, type JsonValue } from "./json.ts";
import {
  validateModelResponseContract,
  validateModelResponseContractCapability,
  type ModelResponseCapability,
  type ModelResponseContract,
  type RequiredToolSetCapability,
} from "./model-response.ts";

export const REASONING_EFFORTS = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type RequestedReasoningEffort = Exclude<ReasoningEffort, "provider-default">;

export interface ModelConfiguration {
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort: ReasoningEffort;
}

export type ModelConfigurationInput = Omit<ModelConfiguration, "reasoningEffort"> & {
  readonly reasoningEffort?: ReasoningEffort | "default" | "off";
};

export interface ModelWarning {
  readonly kind: "coerced" | "unsupported" | "provider" | "truncated";
  readonly message: string;
}

export interface ModelReasoningCapability {
  readonly status: "listed" | "unverified" | "unsupported";
  readonly levels: readonly RequestedReasoningEffort[];
}

/**
 * Transport-independent facts authoritatively normalized from the model
 * catalog. The current Gateway catalog does not expose these facts, so its
 * descriptors retain unknown rather than inferring unsupported.
 */
export interface ModelCatalogRequiredToolSetCapability {
  readonly status: "supported" | "unsupported" | "unknown";
  readonly strictSchema: "supported" | "unsupported" | "unknown";
  readonly requiredChoice: "supported" | "unsupported" | "unknown";
}

export interface ModelDescriptor {
  readonly model: string;
  readonly displayName: string;
  readonly contextWindowTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly pricing: {
    readonly inputUsdPerToken: number;
    readonly outputUsdPerToken: number;
  } | null;
  readonly reasoning: ModelReasoningCapability;
  readonly requiredToolSet?: ModelCatalogRequiredToolSetCapability;
  readonly catalogDigest: string;
  readonly catalogEndpointId: string;
  readonly stale: boolean;
  /** Bounded catalog-only values that are not selectable by this release. */
  readonly unsupportedReasoningValues?: readonly string[];
}

export interface ReasoningDispatch {
  readonly requestedEffort: ReasoningEffort;
  readonly mode: "omitted" | "requested";
  readonly capability: ModelReasoningCapability & {
    readonly catalogDigest: string;
  };
  readonly resolverId: "agencity.reasoning-dispatch.v1";
}

export interface ModelDispatchV1 {
  readonly configuration: ModelConfiguration;
  readonly reasoning: ReasoningDispatch;
  readonly executionEndpointId?: string;
  readonly dispatchVersion: "agencity.model-dispatch.v1";
}

/**
 * The live version-2 event writer retains ModelDispatchV1 until the atomic
 * workspace-schema cutover. New response-aware admission uses ModelDispatchV2.
 */
export type ModelDispatch = ModelDispatchV1;

export interface ModelDispatchV2 {
  readonly configuration: ModelConfiguration;
  readonly reasoning: ReasoningDispatch;
  readonly responseContract: ModelResponseContract;
  readonly responseCapability: ModelResponseCapability;
  readonly executionEndpointId?: string;
  readonly dispatchVersion: "agencity.model-dispatch.v2";
}

export interface RecursiveResponseAdmission {
  readonly responseContract: ModelResponseContract;
  readonly responseCapability: ModelResponseCapability;
}

export interface ResolvedModelExecutionDescriptor {
  readonly transport: string;
  readonly model: string;
  readonly catalog: ModelDescriptor;
  readonly requiredAgentToolSet: RequiredToolSetCapability;
}

export const STANDARD_UNVERIFIED_REASONING_LEVELS: readonly RequestedReasoningEffort[] =
  Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh"]);

export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  const normalized = value === undefined || value === "default"
    ? "provider-default"
    : value === "off" ? "none" : value;
  if (typeof normalized !== "string" ||
      !REASONING_EFFORTS.includes(normalized as ReasoningEffort)) {
    throw new ValidationError(
      `Unknown reasoning effort: ${String(value)}. Expected ${REASONING_EFFORTS.join(", ")}`,
    );
  }
  return normalized as ReasoningEffort;
}

export function effectiveReasoningEffort(
  configuration: Pick<ModelConfiguration, "reasoningEffort">,
): ReasoningEffort {
  return configuration.reasoningEffort;
}

export function assertReasoningSelection(
  effort: ReasoningEffort,
  capability: ModelReasoningCapability,
): void {
  if (effort === "provider-default") return;
  if (capability.status === "listed" && !capability.levels.includes(effort)) {
    throw new ValidationError(
      `Reasoning effort ${effort} is unavailable for this model. Available levels: provider-default${capability.levels.length ? `, ${capability.levels.join(", ")}` : ""}`,
    );
  }
  if (capability.status === "unsupported") {
    throw new ValidationError(
      "This model is cataloged without reasoning control. Use provider-default or refresh the model catalog.",
    );
  }
}

export function resolveModelDispatch(input: {
  readonly configuration: ModelConfiguration;
  readonly capability: ModelReasoningCapability;
  readonly catalogDigest: string;
  readonly executionEndpointId?: string;
}): ModelDispatch {
  assertReasoningSelection(input.configuration.reasoningEffort, input.capability);
  return Object.freeze({
    configuration: Object.freeze({ ...input.configuration }),
    reasoning: Object.freeze({
      requestedEffort: input.configuration.reasoningEffort,
      mode: input.configuration.reasoningEffort === "provider-default" ? "omitted" : "requested",
      capability: Object.freeze({
        status: input.capability.status,
        levels: Object.freeze([...input.capability.levels]),
        catalogDigest: input.catalogDigest,
      }),
      resolverId: "agencity.reasoning-dispatch.v1",
    }),
    ...(input.executionEndpointId === undefined
      ? {}
      : { executionEndpointId: input.executionEndpointId }),
    dispatchVersion: "agencity.model-dispatch.v1",
  });
}

export function resolveModelDispatchV2(input: {
  readonly configuration: ModelConfiguration;
  readonly capability: ModelReasoningCapability;
  readonly catalogDigest: string;
  readonly responseContract: ModelResponseContract;
  readonly responseCapability: ModelResponseCapability;
  readonly executionEndpointId?: string;
}): ModelDispatchV2 {
  const base = resolveModelDispatch(input);
  return responseAwareDispatchFromV1(base, {
    responseContract: input.responseContract,
    responseCapability: input.responseCapability,
  });
}

export function responseAwareDispatchFromV1(
  dispatch: ModelDispatchV1,
  responseAdmission: RecursiveResponseAdmission,
): ModelDispatchV2 {
  validateModelDispatch(dispatch);
  const responseContract = validateModelResponseContract(
    responseAdmission.responseContract,
  );
  validateModelResponseContractCapability(
    responseContract,
    responseAdmission.responseCapability,
  );
  const responseCapability = deepFreeze(
    JSON.parse(JSON.stringify(responseAdmission.responseCapability)) as
      ModelResponseCapability,
  );
  const resolved: ModelDispatchV2 = deepFreeze({
    configuration: dispatch.configuration,
    reasoning: dispatch.reasoning,
    responseContract,
    responseCapability,
    ...(dispatch.executionEndpointId === undefined
      ? {}
      : { executionEndpointId: dispatch.executionEndpointId }),
    dispatchVersion: "agencity.model-dispatch.v2",
  });
  validateModelDispatchV2(resolved);
  return resolved;
}

export function validateModelDispatch(dispatch: ModelDispatch): void {
  if (dispatch.dispatchVersion !== "agencity.model-dispatch.v1") {
    throw new ValidationError("Unsupported model dispatch version");
  }
  const effort = normalizeReasoningEffort(dispatch.configuration.reasoningEffort);
  if (effort !== dispatch.reasoning.requestedEffort) {
    throw new ValidationError("Model dispatch reasoning effort disagrees with its configuration");
  }
  if (dispatch.reasoning.resolverId !== "agencity.reasoning-dispatch.v1" ||
      dispatch.reasoning.mode !== (effort === "provider-default" ? "omitted" : "requested")) {
    throw new ValidationError("Model dispatch reasoning mode is invalid");
  }
  assertReasoningSelection(effort, dispatch.reasoning.capability);
}

export function validateModelDispatchV2(dispatch: ModelDispatchV2): void {
  assertJsonValue(dispatch);
  const record = dispatch as unknown as Record<string, JsonValue>;
  const required = new Set([
    "configuration",
    "reasoning",
    "responseContract",
    "responseCapability",
    "dispatchVersion",
  ]);
  const allowed = new Set([...required, "executionEndpointId"]);
  if (
    [...required].some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new ValidationError(
      "Response-aware model dispatch has missing or unknown fields",
    );
  }
  if (dispatch.dispatchVersion !== "agencity.model-dispatch.v2") {
    throw new ValidationError("Unsupported response-aware model dispatch version");
  }
  validateRetainedModelConfiguration(dispatch.configuration);
  validateRetainedReasoningDispatch(dispatch.reasoning);
  if (
    dispatch.executionEndpointId !== undefined &&
    (typeof dispatch.executionEndpointId !== "string" ||
      !dispatch.executionEndpointId ||
      new TextEncoder().encode(dispatch.executionEndpointId).byteLength > 1_024)
  ) {
    throw new ValidationError(
      "Response-aware model dispatch execution endpoint identity is invalid",
    );
  }
  const legacy: ModelDispatchV1 = {
    configuration: dispatch.configuration,
    reasoning: dispatch.reasoning,
    ...(dispatch.executionEndpointId === undefined
      ? {}
      : { executionEndpointId: dispatch.executionEndpointId }),
    dispatchVersion: "agencity.model-dispatch.v1",
  };
  validateModelDispatch(legacy);
  const contract = validateModelResponseContract(dispatch.responseContract);
  validateModelResponseContractCapability(
    contract,
    dispatch.responseCapability,
  );
  if (
    dispatch.responseCapability.kind === "required-tool-set" &&
    dispatch.responseCapability.capability.catalogDigest !==
      dispatch.reasoning.capability.catalogDigest
  ) {
    throw new ValidationError(
      "Model dispatch response and reasoning capabilities disagree on catalog provenance",
    );
  }
}

export function modelDispatchEquals(left: ModelDispatch, right: ModelDispatch): boolean {
  return Bun.deepEquals(left, right);
}

export function modelDispatchV2Equals(
  left: ModelDispatchV2,
  right: ModelDispatchV2,
): boolean {
  return Bun.deepEquals(left, right);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateRetainedModelConfiguration(
  configuration: ModelConfiguration,
): void {
  const record = configuration as unknown as Record<string, unknown>;
  assertExactRecordKeys(
    record,
    ["provider", "model", "reasoningEffort"],
    ["temperature", "maxOutputTokens"],
    "Model dispatch configuration",
  );
  if (
    typeof configuration.provider !== "string" ||
    !configuration.provider ||
    typeof configuration.model !== "string" ||
    !configuration.model ||
    new TextEncoder().encode(configuration.provider).byteLength > 256 ||
    new TextEncoder().encode(configuration.model).byteLength > 512
  ) {
    throw new ValidationError(
      "Model dispatch configuration identity is invalid",
    );
  }
  if (!REASONING_EFFORTS.includes(configuration.reasoningEffort)) {
    throw new ValidationError(
      "Model dispatch configuration reasoning effort is not canonical",
    );
  }
  if (
    configuration.temperature !== undefined &&
    (!Number.isFinite(configuration.temperature) ||
      configuration.temperature < 0 ||
      configuration.temperature > 2)
  ) {
    throw new ValidationError(
      "Model dispatch configuration temperature is invalid",
    );
  }
  if (
    configuration.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(configuration.maxOutputTokens) ||
      configuration.maxOutputTokens < 1)
  ) {
    throw new ValidationError(
      "Model dispatch configuration output limit is invalid",
    );
  }
}

function validateRetainedReasoningDispatch(
  reasoning: ReasoningDispatch,
): void {
  const record = reasoning as unknown as Record<string, unknown>;
  assertExactRecordKeys(
    record,
    ["requestedEffort", "mode", "capability", "resolverId"],
    [],
    "Model reasoning dispatch",
  );
  const capability = reasoning.capability as unknown as Record<string, unknown>;
  assertExactRecordKeys(
    capability,
    ["status", "levels", "catalogDigest"],
    [],
    "Model reasoning capability",
  );
  if (
    !["listed", "unverified", "unsupported"].includes(
      reasoning.capability.status,
    ) ||
    !Array.isArray(reasoning.capability.levels) ||
    reasoning.capability.levels.some(
      (level) => !STANDARD_UNVERIFIED_REASONING_LEVELS.includes(level),
    ) ||
    new Set(reasoning.capability.levels).size !==
      reasoning.capability.levels.length ||
    !/^[a-f0-9]{64}$/.test(reasoning.capability.catalogDigest)
  ) {
    throw new ValidationError(
      "Model reasoning capability provenance is invalid",
    );
  }
  if (
    reasoning.capability.status === "unsupported" &&
    reasoning.capability.levels.length !== 0
  ) {
    throw new ValidationError(
      "Unsupported model reasoning capability must list no levels",
    );
  }
}

function assertExactRecordKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new ValidationError(`${label} has missing or unknown fields`);
  }
}

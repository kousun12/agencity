import { ValidationError } from "./errors.ts";

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

export interface ModelDispatch {
  readonly configuration: ModelConfiguration;
  readonly reasoning: ReasoningDispatch;
  readonly executionEndpointId?: string;
  readonly dispatchVersion: "agencity.model-dispatch.v1";
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

export function modelDispatchEquals(left: ModelDispatch, right: ModelDispatch): boolean {
  return Bun.deepEquals(left, right);
}

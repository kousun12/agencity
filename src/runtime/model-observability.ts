import {
  AGENT_TOOL_CONTRACT,
  AGENT_TOOL_CONTRACT_ID,
  MAX_MODEL_PROVIDER_ID_BYTES,
  MODEL_RESPONSE_CONTRACT_SELECTION,
  MODEL_RESPONSE_CONTRACT_SUPPLEMENTAL_TEXT,
  MODEL_RESPONSE_CONTRACT_VERSION,
  REFINEMENT_GOVERNANCE_CONTRACT_ID,
  REFINEMENT_REVIEW_CONTRACT_ID,
  REFINEMENT_REVIEW_TOOL_NAME,
  ValidationError,
  validateModelEffectOutputV2,
  validateRefinementGovernanceRecursiveResult,
  validateRefinementReviewRecursiveResult,
  type AgentState,
  type ModelConfiguration,
  type ModelContractViolation,
  type ModelContractViolationCode,
  type ModelDescriptor,
  type RequiredToolSetCapability,
} from "../domain/index.ts";
import type {
  ModelExecutor,
  ModelProviderDescriptor,
  ModelProviderRequiredToolSetCapabilities,
} from "../executors/index.ts";
import { scrubText } from "../security/index.ts";

export const MODEL_CONTRACT_DIAGNOSTIC_OUTCOME_LIMIT = 32 as const;

/** Mirrors the durable model-dispatch configuration identity bound. */
const MAX_SELECTED_MODEL_ID_BYTES = 512;

export type AgentToolCapabilityState =
  | "provider-strict"
  | "runtime-validated"
  | "unknown"
  | "unavailable";

export interface AgentToolTransportCapabilityView {
  readonly provider: string;
  readonly displayName: string;
  readonly state: AgentToolCapabilityState;
  readonly admission: "allowed" | "rejected";
  readonly canRun: boolean;
  readonly credential: ModelProviderDescriptor["credentialSource"];
  readonly requiredChoice: "provider-enforced" | "unknown" | "unsupported";
  readonly parallelCalls:
    | "provider-disabled"
    | "runtime-rejected"
    | "unknown"
    | "unsupported";
  readonly boundedToolInputStreaming: boolean;
  readonly adapter: string;
  readonly reason?: string;
  readonly provenance: {
    readonly kind: "transport";
    readonly reportedStatus:
      | ModelProviderRequiredToolSetCapabilities["status"]
      | "absent";
  };
}

export interface SelectedAgentToolCapabilityView {
  readonly provider: string;
  readonly model: string;
  readonly state: AgentToolCapabilityState;
  readonly admission: "allowed" | "rejected";
  readonly canRun: boolean;
  readonly reason?: string;
  readonly capabilityReason?: string;
  readonly transport: AgentToolTransportCapabilityView;
  readonly modelCatalog: {
    readonly status: "supported" | "unsupported" | "unknown";
    readonly strictSchema: "supported" | "unsupported" | "unknown";
    readonly requiredChoice: "supported" | "unsupported" | "unknown";
    readonly digest: string;
    readonly endpointId: string;
    readonly stale: boolean;
  } | null;
}

export interface AgentToolContractCapabilityView {
  readonly protocol: "agencity.agent-tool-capability";
  readonly version: 1;
  readonly contract: {
    readonly contractId: typeof AGENT_TOOL_CONTRACT_ID;
    readonly contractVersion: 1;
    readonly responseContractVersion: typeof MODEL_RESPONSE_CONTRACT_VERSION;
    readonly contractDigest: string;
    readonly tools: readonly ["bun_console", "finish"];
    readonly selection: typeof MODEL_RESPONSE_CONTRACT_SELECTION;
    readonly supplementalText: typeof MODEL_RESPONSE_CONTRACT_SUPPLEMENTAL_TEXT;
  };
  readonly transports: readonly AgentToolTransportCapabilityView[];
  readonly selected?: SelectedAgentToolCapabilityView;
}

const MODEL_CONTRACT_VIOLATION_CODES = Object.freeze([
  "required-tool-missing",
  "multiple-tool-calls",
  "unexpected-tool",
  "invalid-tool-input",
  "truncated-tool-input",
  "oversized-tool-input",
  "oversized-provider-response",
  "incomplete-provider-response",
  "provider-refusal",
] as const satisfies readonly ModelContractViolationCode[]);

export interface ModelContractSubmissionCount {
  readonly contractId:
    | typeof AGENT_TOOL_CONTRACT_ID
    | typeof REFINEMENT_REVIEW_CONTRACT_ID;
  readonly tool: "bun_console" | "finish" | typeof REFINEMENT_REVIEW_TOOL_NAME;
  readonly count: number;
}

export interface ModelContractViolationCount {
  readonly code: ModelContractViolationCode;
  readonly count: number;
}

export type ModelContractDiagnosticOutcome =
  | {
      readonly kind: "formal-submission";
      readonly contractId: string;
      readonly contractVersion: number;
      readonly tool: string;
      readonly schemaEnforcement: "provider-strict" | "runtime-validated";
      readonly source: "model-call" | "retained-recursive-result";
    }
  | {
      readonly kind: "contract-violation";
      readonly contractId: string;
      readonly contractVersion: number;
      readonly code: ModelContractViolationCode;
      readonly message: string;
      readonly schemaEnforcement: "provider-strict" | "runtime-validated";
      readonly evidence: {
        readonly termination: string;
        readonly toolCallCount: number;
        readonly toolNames: readonly string[];
        readonly inputBytes: number;
        readonly omittedBlockCount: number;
        readonly supplementalTextBytes: number;
      };
    };

export interface ModelContractDiagnosticsView {
  readonly protocol: "agencity.model-contract-diagnostics";
  readonly version: 1;
  readonly scope: "branch-projection-and-retained-recursive-results";
  readonly counters: {
    readonly submissions: readonly ModelContractSubmissionCount[];
    readonly violations: readonly ModelContractViolationCount[];
    readonly unclassifiedSubmissions: number;
  };
  readonly recentOutcomes: readonly ModelContractDiagnosticOutcome[];
  readonly omittedOutcomeCount: number;
}

export function describeAgentToolCapabilities(
  executor: ModelExecutor,
  selected?: Pick<ModelConfiguration, "provider" | "model">,
): AgentToolContractCapabilityView {
  if (selected !== undefined) assertSelectedQueryIdentity(selected);
  const providers = executor.providers();
  const transports = providers.map(transportCapability);
  return Object.freeze({
    protocol: "agencity.agent-tool-capability",
    version: 1,
    contract: Object.freeze({
      contractId: AGENT_TOOL_CONTRACT.contractId,
      contractVersion: AGENT_TOOL_CONTRACT.version,
      responseContractVersion: MODEL_RESPONSE_CONTRACT_VERSION,
      contractDigest: AGENT_TOOL_CONTRACT.contractDigest,
      tools: Object.freeze(["bun_console", "finish"] as const),
      selection: MODEL_RESPONSE_CONTRACT_SELECTION,
      supplementalText: MODEL_RESPONSE_CONTRACT_SUPPLEMENTAL_TEXT,
    }),
    transports: Object.freeze(transports),
    ...(selected === undefined
      ? {}
      : {
          selected: selectedCapability(
            executor,
            providers,
            transports,
            selected,
          ),
        }),
  });
}

/**
 * Coarse transport-level state shared by `/capabilities` transports and the
 * product model picker. The executor resolves any transport without proven
 * bounded tool-input streaming to `unsupported` for every model, so the view
 * must not report a capability state that no resolved model can reach.
 */
export function describeTransportAgentToolState(
  capability: ModelProviderRequiredToolSetCapabilities | undefined,
): AgentToolCapabilityState {
  return capability !== undefined && !capability.streaming
    ? "unavailable"
    : capabilityState(capability?.status);
}

export function describeCatalogAgentToolState(
  provider: ModelProviderDescriptor | undefined,
  descriptor: ModelDescriptor,
): AgentToolCapabilityState {
  const transport = provider?.capabilities.requiredToolSet;
  if (!transport || transport.status === "unsupported" || !transport.streaming ||
      descriptor.requiredToolSet?.status === "unsupported") {
    return "unavailable";
  }
  if ((descriptor.requiredToolSet?.status ?? "unknown") === "unknown") {
    return "unknown";
  }
  if (descriptor.requiredToolSet?.strictSchema === "unsupported") {
    return "runtime-validated";
  }
  return transport.status === "provider-strict" ||
    transport.status === "runtime-validated"
    ? transport.status
    : "unknown";
}

export function deriveModelContractDiagnostics(
  state: AgentState,
): ModelContractDiagnosticsView {
  const submissionCounts = new Map<string, number>();
  const violationCounts = new Map<ModelContractViolationCode, number>(
    MODEL_CONTRACT_VIOLATION_CODES.map((code) => [code, 0]),
  );
  const outcomes: ModelContractDiagnosticOutcome[] = [];
  let unclassifiedSubmissions = 0;

  const countSubmission = (contractId: string, tool: string): void => {
    const key = `${contractId}\u0000${tool}`;
    if (!SUBMISSION_COUNTER_KEYS.has(key)) {
      unclassifiedSubmissions++;
      return;
    }
    submissionCounts.set(key, (submissionCounts.get(key) ?? 0) + 1);
  };

  for (const call of Object.values(state.modelCalls)) {
    const outcome = deriveModelContractCallDiagnostic(state, call.id);
    if (!outcome) continue;
    outcomes.push(outcome);
    if (outcome.kind === "formal-submission") {
      countSubmission(outcome.contractId, outcome.tool);
    } else {
      violationCounts.set(
        outcome.code,
        (violationCounts.get(outcome.code) ?? 0) + 1,
      );
    }
  }

  for (const recursive of Object.values(state.recursiveModels)) {
    const contract = recursive.responseAdmission.responseContract;
    if (contract.kind !== "required-tool-set" ||
        recursive.status !== "completed" || recursive.result === undefined) {
      continue;
    }
    try {
      const result = contract.contractId === REFINEMENT_GOVERNANCE_CONTRACT_ID
        ? validateRefinementGovernanceRecursiveResult(recursive.result, {
            contractDigest: contract.contractDigest,
          })
        : validateRefinementReviewRecursiveResult(recursive.result, {
            contractDigest: contract.contractDigest,
          });
      countSubmission(result.contractId, result.toolName);
      outcomes.push({
        kind: "formal-submission",
        contractId: result.contractId,
        contractVersion: result.contractVersion,
        tool: result.toolName,
        schemaEnforcement: contract.schemaEnforcement,
        source: "retained-recursive-result",
      });
    } catch {
      // Invalid retained state is rejected by projection/storage. A diagnostic
      // view remains total when handed an independently constructed test value.
    }
  }

  const recentOutcomes = outcomes.slice(-MODEL_CONTRACT_DIAGNOSTIC_OUTCOME_LIMIT);
  return Object.freeze({
    protocol: "agencity.model-contract-diagnostics",
    version: 1,
    scope: "branch-projection-and-retained-recursive-results",
    counters: Object.freeze({
      submissions: Object.freeze(SUBMISSION_COUNTERS.map(({ contractId, tool }) =>
        Object.freeze({
          contractId,
          tool,
          count: submissionCounts.get(`${contractId}\u0000${tool}`) ?? 0,
        }))),
      violations: Object.freeze(MODEL_CONTRACT_VIOLATION_CODES.map((code) =>
        Object.freeze({ code, count: violationCounts.get(code) ?? 0 }))),
      unclassifiedSubmissions,
    }),
    recentOutcomes: Object.freeze(recentOutcomes),
    omittedOutcomeCount: outcomes.length - recentOutcomes.length,
  });
}

export function deriveModelContractCallDiagnostic(
  state: AgentState,
  callId: string,
): ModelContractDiagnosticOutcome | null {
  const call = state.modelCalls[callId];
  const contract = call?.modelDispatch.responseContract;
  if (!call || contract?.kind !== "required-tool-set" ||
      call.status !== "succeeded" || call.result === undefined) {
    return null;
  }
  if (call.result.kind === "tool-submission") {
    return Object.freeze({
      kind: "formal-submission",
      contractId: contract.contractId,
      contractVersion: contract.version,
      tool: call.result.name,
      schemaEnforcement: contract.schemaEnforcement,
      source: "model-call",
    });
  }
  if (call.result.kind !== "contract-violation") return null;
  const violation = retainedViolation(state, call.id);
  return Object.freeze({
    kind: "contract-violation",
    contractId: contract.contractId,
    contractVersion: contract.version,
    code: call.result.code,
    message: boundedDiagnosticText(
      violation?.message ?? rejectionForModelCall(state, call.id) ??
        "The formal model response violated its required tool contract.",
      512,
    ),
    schemaEnforcement: contract.schemaEnforcement,
    evidence: violationEvidenceSummary(violation),
  });
}

const SUBMISSION_COUNTERS = Object.freeze([
  { contractId: AGENT_TOOL_CONTRACT_ID, tool: "bun_console" as const },
  { contractId: AGENT_TOOL_CONTRACT_ID, tool: "finish" as const },
  {
    contractId: REFINEMENT_REVIEW_CONTRACT_ID,
    tool: REFINEMENT_REVIEW_TOOL_NAME,
  },
] as const);

const SUBMISSION_COUNTER_KEYS = new Set(
  SUBMISSION_COUNTERS.map(
    ({ contractId, tool }) => `${contractId}\u0000${tool}`,
  ),
);

function transportCapability(
  provider: ModelProviderDescriptor,
): AgentToolTransportCapabilityView {
  const capability = provider.capabilities.requiredToolSet;
  const state = describeTransportAgentToolState(capability);
  const admission = requiredToolAdmission(capability);
  const credentialReason = provider.usable
    ? undefined
    : provider.remediation ??
      `Configure ${provider.displayName} credentials before starting a run.`;
  const reason = credentialReason ?? capability?.reason;
  return Object.freeze({
    provider: provider.name,
    displayName: provider.displayName,
    state,
    admission,
    canRun: provider.usable && admission === "allowed",
    credential: provider.credentialSource,
    requiredChoice: capability?.requiredChoice ?? "unsupported",
    parallelCalls: capability?.parallelCalls ?? "unsupported",
    boundedToolInputStreaming: capability?.streaming ?? false,
    adapter: capability?.adapter ?? "agencity.model-provider.text.v1",
    ...(reason === undefined
      ? {}
      : { reason: boundedDiagnosticText(reason, 512) }),
    provenance: Object.freeze({
      kind: "transport",
      reportedStatus: capability?.status ?? "absent",
    }),
  });
}

function selectedCapability(
  executor: ModelExecutor,
  providers: readonly ModelProviderDescriptor[],
  transports: readonly AgentToolTransportCapabilityView[],
  selected: Pick<ModelConfiguration, "provider" | "model">,
): SelectedAgentToolCapabilityView {
  // Identity is validated at the public entrypoint; echoes of an unknown
  // selection are additionally scrubbed before they can enter a response.
  const providerEcho = scrubText(selected.provider);
  const modelEcho = scrubText(selected.model);
  const provider = providers.find((item) => item.name === selected.provider);
  const transport = transports.find((item) => item.provider === selected.provider) ??
    unavailableTransport(providerEcho);
  if (!provider) {
    return Object.freeze({
      provider: providerEcho,
      model: modelEcho,
      state: "unavailable",
      admission: "rejected",
      canRun: false,
      reason: boundedDiagnosticText(
        `The selected provider ${providerEcho} is not installed.`,
        512,
      ),
      transport,
      modelCatalog: null,
    });
  }
  try {
    const execution = executor.resolveExecutionDescriptor({
      provider: selected.provider,
      model: selected.model,
      reasoningEffort: "provider-default",
    });
    const capability = execution.requiredAgentToolSet;
    const admission = resolvedAdmission(capability);
    const state = capabilityState(capability.status);
    const availabilityReason = provider.usable
      ? undefined
      : provider.remediation ??
        `Configure ${provider.displayName} credentials before starting a run.`;
    const capabilityReason = capability.reason === undefined
      ? undefined
      : boundedDiagnosticText(capability.reason, 512);
    const reason = (availabilityReason === undefined
      ? undefined
      : boundedDiagnosticText(availabilityReason, 512)) ??
      (admission === "rejected"
        ? capabilityReason ??
          "The selected provider/model combination cannot run the fixed agent tool contract."
        : capabilityReason);
    const catalog = execution.catalog.requiredToolSet;
    return Object.freeze({
      provider: execution.transport,
      model: execution.model,
      state,
      admission,
      canRun: provider.usable && admission === "allowed",
      ...(reason === undefined ? {} : { reason }),
      ...(capabilityReason === undefined ? {} : { capabilityReason }),
      transport,
      modelCatalog: Object.freeze({
        status: catalog?.status ?? "unknown",
        strictSchema: catalog?.strictSchema ?? "unknown",
        requiredChoice: catalog?.requiredChoice ?? "unknown",
        digest: execution.catalog.catalogDigest,
        endpointId: execution.catalog.catalogEndpointId,
        stale: execution.catalog.stale,
      }),
    });
  } catch (error) {
    return Object.freeze({
      provider: providerEcho,
      model: modelEcho,
      state: "unavailable",
      admission: "rejected",
      canRun: false,
      reason: boundedDiagnosticText(
        error instanceof Error ? error.message : String(error),
        512,
      ),
      transport,
      modelCatalog: null,
    });
  }
}

function assertSelectedQueryIdentity(
  selected: Pick<ModelConfiguration, "provider" | "model">,
): void {
  const encoder = new TextEncoder();
  if (
    typeof selected.provider !== "string" || !selected.provider.trim() ||
    typeof selected.model !== "string" || !selected.model.trim() ||
    encoder.encode(selected.provider).byteLength > MAX_MODEL_PROVIDER_ID_BYTES ||
    encoder.encode(selected.model).byteLength > MAX_SELECTED_MODEL_ID_BYTES
  ) {
    throw new ValidationError(
      "Selected agent-tool capability requires a non-blank provider up to " +
        `${MAX_MODEL_PROVIDER_ID_BYTES} bytes and model up to ` +
        `${MAX_SELECTED_MODEL_ID_BYTES} bytes`,
    );
  }
}

function capabilityState(
  status:
    | RequiredToolSetCapability["status"]
    | ModelProviderRequiredToolSetCapabilities["status"]
    | undefined,
): AgentToolCapabilityState {
  return status === "unsupported" || status === undefined
    ? "unavailable"
    : status;
}

function requiredToolAdmission(
  capability: ModelProviderRequiredToolSetCapabilities | undefined,
): "allowed" | "rejected" {
  return capability &&
    capability.status !== "unsupported" &&
    capability.requiredChoice !== "unsupported" &&
    capability.parallelCalls !== "unsupported" &&
    capability.streaming
    ? "allowed"
    : "rejected";
}

function resolvedAdmission(
  capability: RequiredToolSetCapability,
): "allowed" | "rejected" {
  return capability.status !== "unsupported" &&
    capability.requiredChoice !== "unsupported" &&
    capability.parallelCalls !== "unsupported" &&
    capability.streaming
    ? "allowed"
    : "rejected";
}

function unavailableTransport(provider: string): AgentToolTransportCapabilityView {
  return Object.freeze({
    provider,
    displayName: provider,
    state: "unavailable",
    admission: "rejected",
    canRun: false,
    credential: "missing",
    requiredChoice: "unsupported",
    parallelCalls: "unsupported",
    boundedToolInputStreaming: false,
    adapter: "agencity.model-provider.unavailable.v1",
    reason: boundedDiagnosticText(
      `The selected provider ${provider} is not installed.`,
      512,
    ),
    provenance: Object.freeze({
      kind: "transport",
      reportedStatus: "absent",
    }),
  });
}

function retainedViolation(
  state: AgentState,
  callId: string,
): ModelContractViolation | undefined {
  const call = state.modelCalls[callId];
  if (!call) return undefined;
  const effect = state.effects[call.effectId];
  if (!effect || effect.status !== "succeeded" || effect.output === undefined) {
    return undefined;
  }
  try {
    const output = validateModelEffectOutputV2(effect.output, {
      responseContract: call.modelDispatch.responseContract,
      responseCapability: call.modelDispatch.responseCapability,
      configuredProvider: call.modelDispatch.configuration.provider,
    });
    return output.result.kind === "contract-violation"
      ? output.result.violation
      : undefined;
  } catch {
    return undefined;
  }
}

function rejectionForModelCall(
  state: AgentState,
  callId: string,
): string | undefined {
  for (const run of Object.values(state.agentRuns)) {
    const step = run.steps.find(
      (candidate) => candidate.actionSource?.modelCallId === callId,
    );
    if (step?.rejection) return step.rejection;
  }
  return undefined;
}

function violationEvidenceSummary(
  violation: ModelContractViolation | undefined,
): Extract<
  ModelContractDiagnosticOutcome,
  { kind: "contract-violation" }
>["evidence"] {
  if (!violation) {
    return Object.freeze({
      termination: "unknown",
      toolCallCount: 0,
      toolNames: Object.freeze([]),
      inputBytes: 0,
      omittedBlockCount: 0,
      supplementalTextBytes: 0,
    });
  }
  const names = violation.evidence.toolCalls
    .flatMap((call) => call.name ? [boundedDiagnosticText(call.name, 128)] : [])
    .slice(0, 4);
  return Object.freeze({
    termination: violation.termination.kind,
    toolCallCount: violation.evidence.toolCalls.length,
    toolNames: Object.freeze(names),
    inputBytes: violation.evidence.toolCalls.reduce(
      (total, call) => total + call.inputBytes,
      0,
    ),
    omittedBlockCount: violation.evidence.omittedBlockCount,
    supplementalTextBytes: violation.evidence.supplementalTextBytes,
  });
}

/**
 * Scrubs, collapses whitespace, and enforces an exact UTF-8 byte cap. When
 * truncation is required, the cut retreats to a code-point boundary so partial
 * multibyte sequences never decode into replacement characters that would push
 * the ellipsis-terminated result past the cap.
 */
export function boundedDiagnosticText(value: string, maximum: number): string {
  const safe = scrubText(value).replace(/\s+/g, " ").trim();
  const encoded = new TextEncoder().encode(safe);
  if (encoded.byteLength <= maximum) return safe;
  let end = Math.max(0, maximum - 3);
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end--;
  return `${new TextDecoder().decode(encoded.subarray(0, end))}…`;
}

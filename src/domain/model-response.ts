import {
  AGENT_TOOL_CONTRACT_ID,
  AGENT_TOOL_CONTRACT_VERSION,
  AGENT_TOOL_SET,
  AGENT_TYPED_TOOL_CONTRACT_ID,
  AGENT_TYPED_TOOL_CONTRACT_VERSION,
  MAX_AGENT_TOOL_INPUT_BYTES,
  resolveAgentTypedToolContract,
  validateAgentToolSubmissionValue,
  validateTypedAgentToolSubmissionValue,
} from "./agent-tool-contract.ts";
import {
  REFINEMENT_REVIEW_CONTRACT_ID,
  REFINEMENT_REVIEW_CONTRACT_VERSION,
  REFINEMENT_REVIEW_TOOL_SET,
  normalizeRefinementReviewTransportValue,
} from "./refinement-review-contract.ts";
import { MAX_REFINEMENT_REVIEW_BYTES } from "./refinement-review.ts";
import {
  MAX_REFINEMENT_GOVERNANCE_OUTPUT_BYTES,
  REFINEMENT_GOVERNANCE_CONTRACT_ID,
  REFINEMENT_GOVERNANCE_CONTRACT_VERSION,
  REFINEMENT_GOVERNANCE_TOOL_SET,
  validateRefinementGovernanceDecision,
} from "./refinement-governance.ts";
import { MAX_AGENT_ACTION_BYTES } from "./agent-action.ts";
import { CapabilityUnavailableError, ValidationError } from "./errors.ts";
import {
  DECLARED_SCHEMA_VALIDATOR_ID,
  MAX_DECLARED_INLINE_RESULT_BYTES,
  resolveDeclaredSchema,
  validateDeclaredSchemaValue,
  type ResolvedDeclaredSchema,
} from "./declared-schema.ts";
import {
  assertJsonValue,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  canonicalJsonStringify,
  type JsonValue,
  type Sha256Digest,
} from "./json.ts";
import type { ModelWarning } from "./model.ts";
import type { Usage } from "./events.ts";

export const MODEL_RESPONSE_CONTRACT_VERSION = 1 as const;
export const MODEL_RESPONSE_CONTRACT_SELECTION = "exactly-one-of" as const;
export const MODEL_RESPONSE_CONTRACT_SUPPLEMENTAL_TEXT = "diagnostic-only" as const;
export const RESERVED_MODEL_DISPATCH_INPUT_FIELDS = Object.freeze([
  "modelDispatch",
  "responseAdmission",
  "responseContract",
  "responseCapability",
  "tools",
  "toolSchemas",
  "toolChoice",
  "schemaEnforcement",
] as const);

export type BuiltInStructuredContractId =
  | typeof AGENT_TOOL_CONTRACT_ID
  | typeof REFINEMENT_REVIEW_CONTRACT_ID
  | typeof REFINEMENT_GOVERNANCE_CONTRACT_ID;
export type RegisteredBuiltInStructuredContractId =
  | typeof AGENT_TOOL_CONTRACT_ID
  | typeof REFINEMENT_REVIEW_CONTRACT_ID
  | typeof REFINEMENT_GOVERNANCE_CONTRACT_ID;
export const DECLARED_DATA_CONTRACT_ID = "agencity.declared-data.v1" as const;
export const DECLARED_DATA_CONTRACT_FAMILY =
  "agencity.declared-data" as const;
export const DECLARED_DATA_CONTRACT_VERSION = 1 as const;
export const DECLARED_DATA_TOOL_NAME = "agencity_submit_object" as const;
export const DECLARED_DATA_TOOL_DESCRIPTION =
  "Submit exactly one JSON value matching the host-pinned declared schema.";
export type ModelStructuredContractId =
  | BuiltInStructuredContractId
  | typeof DECLARED_DATA_CONTRACT_ID
  | typeof AGENT_TYPED_TOOL_CONTRACT_ID;
export type ModelSchemaEnforcement = "provider-strict" | "runtime-validated";

export interface TextModelResponseContract {
  readonly kind: "text";
  readonly version: typeof MODEL_RESPONSE_CONTRACT_VERSION;
}

export interface ModelResponseToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
  readonly schemaDigest: Sha256Digest;
}

interface RequiredToolSetModelResponseContractBase {
  readonly kind: "required-tool-set";
  readonly version: typeof MODEL_RESPONSE_CONTRACT_VERSION;
  readonly tools: readonly ModelResponseToolDefinition[];
  readonly schemaEnforcement: ModelSchemaEnforcement;
  readonly selection: typeof MODEL_RESPONSE_CONTRACT_SELECTION;
  readonly supplementalText: typeof MODEL_RESPONSE_CONTRACT_SUPPLEMENTAL_TEXT;
  readonly contractDigest: Sha256Digest;
}

export interface BuiltInRequiredToolSetModelResponseContract
  extends RequiredToolSetModelResponseContractBase {
  readonly contractId: BuiltInStructuredContractId;
}

export interface DeclaredDataModelResponseContract
  extends RequiredToolSetModelResponseContractBase {
  readonly contractId: typeof DECLARED_DATA_CONTRACT_ID;
  readonly contractFamily: typeof DECLARED_DATA_CONTRACT_FAMILY;
  readonly familyVersion: typeof DECLARED_DATA_CONTRACT_VERSION;
  readonly declaredSchema: ResolvedDeclaredSchema;
  readonly validatorId: typeof DECLARED_SCHEMA_VALIDATOR_ID;
  readonly inlineResultByteLimit: typeof MAX_DECLARED_INLINE_RESULT_BYTES;
}

export interface TypedAgentModelResponseContract
  extends RequiredToolSetModelResponseContractBase {
  readonly contractId: typeof AGENT_TYPED_TOOL_CONTRACT_ID;
  readonly familyVersion: typeof AGENT_TYPED_TOOL_CONTRACT_VERSION;
  readonly declaredSchema: ResolvedDeclaredSchema;
  readonly validatorId: typeof DECLARED_SCHEMA_VALIDATOR_ID;
  readonly inlineResultByteLimit: typeof MAX_DECLARED_INLINE_RESULT_BYTES;
}

export type RequiredToolSetModelResponseContract =
  | BuiltInRequiredToolSetModelResponseContract
  | DeclaredDataModelResponseContract
  | TypedAgentModelResponseContract;

export type ModelResponseContract =
  | TextModelResponseContract
  | RequiredToolSetModelResponseContract;

export interface RequiredToolSetCapability {
  readonly status:
    | "provider-strict"
    | "runtime-validated"
    | "unsupported"
    | "unknown";
  readonly requiredChoice: "provider-enforced" | "unknown" | "unsupported";
  readonly parallelCalls:
    | "provider-disabled"
    | "runtime-rejected"
    | "unknown"
    | "unsupported";
  readonly streaming: boolean;
  readonly catalogDigest: string;
  readonly adapter: string;
  readonly reason?: string;
}

export type ModelResponseCapability =
  | { readonly kind: "text" }
  | {
      readonly kind: "required-tool-set";
      readonly capability: RequiredToolSetCapability;
    };

export const TEXT_MODEL_RESPONSE_CONTRACT: TextModelResponseContract =
  deepFreeze({
    kind: "text",
    version: MODEL_RESPONSE_CONTRACT_VERSION,
  });

interface StructuredContractTemplate {
  readonly contractId: RegisteredBuiltInStructuredContractId;
  readonly version: 1;
  readonly tools: readonly ModelResponseToolDefinition[];
}

const AGENT_STRUCTURED_CONTRACT_TEMPLATE: StructuredContractTemplate =
  deepFreeze({
    contractId: AGENT_TOOL_CONTRACT_ID,
    version: AGENT_TOOL_CONTRACT_VERSION,
    tools: AGENT_TOOL_SET.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      schemaDigest: tool.schemaDigest,
    })),
  });

const REFINEMENT_STRUCTURED_CONTRACT_TEMPLATE: StructuredContractTemplate =
  deepFreeze({
    contractId: REFINEMENT_REVIEW_CONTRACT_ID,
    version: REFINEMENT_REVIEW_CONTRACT_VERSION,
    tools: REFINEMENT_REVIEW_TOOL_SET.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      schemaDigest: tool.schemaDigest,
    })),
  });

const REFINEMENT_GOVERNANCE_STRUCTURED_CONTRACT_TEMPLATE:
  StructuredContractTemplate = deepFreeze({
    contractId: REFINEMENT_GOVERNANCE_CONTRACT_ID,
    version: REFINEMENT_GOVERNANCE_CONTRACT_VERSION,
    tools: REFINEMENT_GOVERNANCE_TOOL_SET.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      schemaDigest: tool.schemaDigest,
    })),
  });

const STRUCTURED_CONTRACT_REGISTRY: Readonly<
  Record<RegisteredBuiltInStructuredContractId, StructuredContractTemplate>
> = deepFreeze({
  [AGENT_TOOL_CONTRACT_ID]: AGENT_STRUCTURED_CONTRACT_TEMPLATE,
  [REFINEMENT_REVIEW_CONTRACT_ID]: REFINEMENT_STRUCTURED_CONTRACT_TEMPLATE,
  [REFINEMENT_GOVERNANCE_CONTRACT_ID]:
    REFINEMENT_GOVERNANCE_STRUCTURED_CONTRACT_TEMPLATE,
});

export const REGISTERED_BUILT_IN_STRUCTURED_CONTRACT_IDS:
  readonly RegisteredBuiltInStructuredContractId[] =
    Object.freeze([
      AGENT_TOOL_CONTRACT_ID,
      REFINEMENT_REVIEW_CONTRACT_ID,
      REFINEMENT_GOVERNANCE_CONTRACT_ID,
    ]);

const RESOLVED_STRUCTURED_CONTRACT_REGISTRY = deepFreeze({
  [AGENT_TOOL_CONTRACT_ID]: {
    "provider-strict": buildStructuredContract(
      AGENT_STRUCTURED_CONTRACT_TEMPLATE,
      "provider-strict",
    ),
    "runtime-validated": buildStructuredContract(
      AGENT_STRUCTURED_CONTRACT_TEMPLATE,
      "runtime-validated",
    ),
  },
  [REFINEMENT_REVIEW_CONTRACT_ID]: {
    "provider-strict": buildStructuredContract(
      REFINEMENT_STRUCTURED_CONTRACT_TEMPLATE,
      "provider-strict",
    ),
    "runtime-validated": buildStructuredContract(
      REFINEMENT_STRUCTURED_CONTRACT_TEMPLATE,
      "runtime-validated",
    ),
  },
  [REFINEMENT_GOVERNANCE_CONTRACT_ID]: {
    "provider-strict": buildStructuredContract(
      REFINEMENT_GOVERNANCE_STRUCTURED_CONTRACT_TEMPLATE,
      "provider-strict",
    ),
    "runtime-validated": buildStructuredContract(
      REFINEMENT_GOVERNANCE_STRUCTURED_CONTRACT_TEMPLATE,
      "runtime-validated",
    ),
  },
});

export function resolveBuiltInModelResponseContract(
  contractId: BuiltInStructuredContractId,
  schemaEnforcement: ModelSchemaEnforcement,
): BuiltInRequiredToolSetModelResponseContract {
  const template = (
    STRUCTURED_CONTRACT_REGISTRY as Partial<
      Record<BuiltInStructuredContractId, StructuredContractTemplate>
    >
  )[contractId];
  if (!template) {
    throw new CapabilityUnavailableError(
      `built-in model response contract ${contractId}`,
      "the current sealed contract registry",
    );
  }
  return RESOLVED_STRUCTURED_CONTRACT_REGISTRY[template.contractId][
    schemaEnforcement
  ];
}

export function resolveDeclaredDataModelResponseContract(
  schema: unknown,
  schemaEnforcement: ModelSchemaEnforcement,
): DeclaredDataModelResponseContract {
  if (
    schemaEnforcement !== "provider-strict" &&
    schemaEnforcement !== "runtime-validated"
  ) {
    throw new ValidationError(
      "Declared-data response contract has invalid schema enforcement",
    );
  }
  const declaredSchema = resolveDeclaredSchema(schema);
  const root = declaredSchema.schema as Record<string, JsonValue>;
  const {
    $schema: _draft,
    $defs,
    ...valueSchema
  } = root;
  const envelope = resolveDeclaredSchema({
    type: "object",
    properties: { value: valueSchema },
    required: ["value"],
    additionalProperties: false,
    ...($defs === undefined ? {} : { $defs }),
  });
  const toolDefinition: ModelResponseToolDefinition = deepFreeze({
    name: DECLARED_DATA_TOOL_NAME,
    description: DECLARED_DATA_TOOL_DESCRIPTION,
    inputSchema: envelope.schema,
    schemaDigest: envelope.schemaDigest,
  });
  const body = {
    kind: "required-tool-set" as const,
    version: MODEL_RESPONSE_CONTRACT_VERSION,
    contractId: DECLARED_DATA_CONTRACT_ID,
    contractFamily: DECLARED_DATA_CONTRACT_FAMILY,
    familyVersion: DECLARED_DATA_CONTRACT_VERSION,
    tools: [toolDefinition] as const,
    schemaEnforcement,
    selection: MODEL_RESPONSE_CONTRACT_SELECTION,
    supplementalText: MODEL_RESPONSE_CONTRACT_SUPPLEMENTAL_TEXT,
    declaredSchema,
    validatorId: DECLARED_SCHEMA_VALIDATOR_ID,
    inlineResultByteLimit: MAX_DECLARED_INLINE_RESULT_BYTES,
  };
  return deepFreeze({
    ...body,
    contractDigest: canonicalJsonDigest(body),
  });
}

export function resolveTypedAgentModelResponseContract(
  schema: unknown,
  schemaEnforcement: ModelSchemaEnforcement,
): TypedAgentModelResponseContract {
  if (
    schemaEnforcement !== "provider-strict" &&
    schemaEnforcement !== "runtime-validated"
  ) {
    throw new ValidationError(
      "Typed agent response contract has invalid schema enforcement",
    );
  }
  const typed = resolveAgentTypedToolContract(schema);
  const body = {
    kind: "required-tool-set" as const,
    version: MODEL_RESPONSE_CONTRACT_VERSION,
    contractId: AGENT_TYPED_TOOL_CONTRACT_ID,
    familyVersion: AGENT_TYPED_TOOL_CONTRACT_VERSION,
    tools: typed.tools,
    schemaEnforcement,
    selection: MODEL_RESPONSE_CONTRACT_SELECTION,
    supplementalText: MODEL_RESPONSE_CONTRACT_SUPPLEMENTAL_TEXT,
    declaredSchema: typed.declaredSchema,
    validatorId: DECLARED_SCHEMA_VALIDATOR_ID,
    inlineResultByteLimit: MAX_DECLARED_INLINE_RESULT_BYTES,
  };
  return deepFreeze({
    ...body,
    contractDigest: canonicalJsonDigest(body),
  });
}

export function validateModelResponseContract(
  value: unknown,
): ModelResponseContract {
  assertJsonValue(value);
  const record = asRecord(value, "Model response contract");
  if (record.kind === "text") {
    if (
      canonicalJsonStringify(record) !==
        canonicalJsonStringify(TEXT_MODEL_RESPONSE_CONTRACT)
    ) {
      throw new ValidationError(
        "Text model response contract does not match its sealed definition",
      );
    }
    return TEXT_MODEL_RESPONSE_CONTRACT;
  }
  if (record.kind !== "required-tool-set") {
    throw new ValidationError("Unknown model response contract kind");
  }
  const contractId = record.contractId;
  const schemaEnforcement = record.schemaEnforcement;
  if (contractId === AGENT_TYPED_TOOL_CONTRACT_ID) {
    if (
      schemaEnforcement !== "provider-strict" &&
      schemaEnforcement !== "runtime-validated"
    ) {
      throw new ValidationError(
        "Typed agent response contract has invalid schema enforcement",
      );
    }
    const digest = record.contractDigest;
    assertSha256Digest(digest, "Model response contract digest");
    const { contractDigest: _digest, ...body } = record;
    if (canonicalJsonDigest(body) !== digest) {
      throw new ValidationError(
        "Model response contract digest does not match its definition",
      );
    }
    const declaredSchema = asRecord(
      record.declaredSchema,
      "Typed agent response schema",
    );
    const expected = resolveTypedAgentModelResponseContract(
      declaredSchema.schema,
      schemaEnforcement,
    );
    if (canonicalJsonStringify(record) !== canonicalJsonStringify(expected)) {
      throw new ValidationError(
        "Model response contract does not match its typed agent family",
      );
    }
    return expected;
  }
  if (contractId === DECLARED_DATA_CONTRACT_ID) {
    if (
      schemaEnforcement !== "provider-strict" &&
      schemaEnforcement !== "runtime-validated"
    ) {
      throw new ValidationError(
        "Declared-data response contract has invalid schema enforcement",
      );
    }
    const digest = record.contractDigest;
    assertSha256Digest(digest, "Model response contract digest");
    const { contractDigest: _digest, ...body } = record;
    if (canonicalJsonDigest(body) !== digest) {
      throw new ValidationError(
        "Model response contract digest does not match its definition",
      );
    }
    const declaredSchema = asRecord(
      record.declaredSchema,
      "Declared-data response schema",
    );
    const expected = resolveDeclaredDataModelResponseContract(
      declaredSchema.schema,
      schemaEnforcement,
    );
    if (
      canonicalJsonStringify(record) !== canonicalJsonStringify(expected)
    ) {
      throw new ValidationError(
        "Model response contract does not match its declared-data family",
      );
    }
    return expected;
  }
  if (
    typeof contractId !== "string" ||
    !isBuiltInStructuredContractId(contractId)
  ) {
    throw new ValidationError(
      "Model response contract is not a known built-in contract",
    );
  }
  if (
    schemaEnforcement !== "provider-strict" &&
    schemaEnforcement !== "runtime-validated"
  ) {
    throw new ValidationError(
      "Model response contract has invalid schema enforcement",
    );
  }
  const digest = record.contractDigest;
  assertSha256Digest(digest, "Model response contract digest");
  const { contractDigest: _digest, ...body } = record;
  if (canonicalJsonDigest(body) !== digest) {
    throw new ValidationError(
      "Model response contract digest does not match its definition",
    );
  }
  const expected = resolveBuiltInModelResponseContract(
    contractId,
    schemaEnforcement,
  );
  if (
    canonicalJsonStringify(record) !== canonicalJsonStringify(expected)
  ) {
    throw new ValidationError(
      `Model response contract does not match ${contractId}`,
    );
  }
  return expected;
}

export function assertNoReservedModelDispatchInputFields(
  value: unknown,
  label: string,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const key of RESERVED_MODEL_DISPATCH_INPUT_FIELDS) {
    if (Object.hasOwn(record, key)) {
      throw new ValidationError(
        `${label} cannot set reserved dispatch field ${key}`,
      );
    }
  }
}

export function validateRequiredToolSetCapability(
  value: unknown,
): RequiredToolSetCapability {
  assertJsonValue(value);
  const record = asRecord(value, "Required-tool-set capability");
  assertExactKeys(
    record,
    [
      "status",
      "requiredChoice",
      "parallelCalls",
      "streaming",
      "catalogDigest",
      "adapter",
    ],
    ["reason"],
    "Required-tool-set capability",
  );
  if (
    ![
      "provider-strict",
      "runtime-validated",
      "unsupported",
      "unknown",
    ].includes(String(record.status))
  ) {
    throw new ValidationError("Required-tool-set capability status is invalid");
  }
  if (
    !["provider-enforced", "unknown", "unsupported"].includes(
      String(record.requiredChoice),
    )
  ) {
    throw new ValidationError(
      "Required-tool-set required-choice capability is invalid",
    );
  }
  if (
    ![
      "provider-disabled",
      "runtime-rejected",
      "unknown",
      "unsupported",
    ].includes(String(record.parallelCalls))
  ) {
    throw new ValidationError(
      "Required-tool-set parallel-call capability is invalid",
    );
  }
  if (typeof record.streaming !== "boolean") {
    throw new ValidationError(
      "Required-tool-set streaming capability must be boolean",
    );
  }
  if (
    typeof record.catalogDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.catalogDigest)
  ) {
    throw new ValidationError(
      "Required-tool-set capability catalog digest is invalid",
    );
  }
  assertBoundedNonEmptyString(
    record.adapter,
    MAX_MODEL_ADAPTER_ID_BYTES,
    "Required-tool-set adapter identity",
  );
  if (
    record.reason !== undefined &&
    (typeof record.reason !== "string" ||
      utf8Bytes(record.reason) > MAX_MODEL_CAPABILITY_REASON_BYTES)
  ) {
    throw new ValidationError(
      `Required-tool-set capability reason exceeds ${MAX_MODEL_CAPABILITY_REASON_BYTES} bytes`,
    );
  }
  if (
    record.status === "unsupported" &&
    (record.streaming !== false ||
      record.requiredChoice !== "unsupported" ||
      record.parallelCalls !== "unsupported")
  ) {
    throw new ValidationError(
      "Unsupported required-tool-set capability must reject every formal primitive",
    );
  }
  if (
    (record.status === "provider-strict" ||
      record.status === "runtime-validated") &&
    (!record.streaming ||
      record.requiredChoice !== "provider-enforced" ||
      !["provider-disabled", "runtime-rejected"].includes(
        String(record.parallelCalls),
      ))
  ) {
    throw new ValidationError(
      "Supported required-tool-set capability lacks a required bounded primitive",
    );
  }
  return value as unknown as RequiredToolSetCapability;
}

export function validateModelResponseContractCapability(
  contract: ModelResponseContract,
  responseCapability: ModelResponseCapability,
): void {
  const retained = validateModelResponseContract(contract);
  if (retained.kind === "text") {
    const record = responseCapability as unknown;
    assertJsonValue(record);
    if (canonicalJsonStringify(record) !== '{"kind":"text"}') {
      throw new ValidationError(
        "Text response contract requires the text response capability",
      );
    }
    return;
  }
  if (
    !responseCapability ||
    responseCapability.kind !== "required-tool-set"
  ) {
    throw new ValidationError(
      "Required-tool-set contract requires a required-tool-set capability",
    );
  }
  const capability = validateRequiredToolSetCapability(
    responseCapability.capability,
  );
  if (
    capability.status === "unsupported" ||
    !capability.streaming ||
    capability.requiredChoice === "unsupported" ||
    capability.parallelCalls === "unsupported"
  ) {
    throw new ValidationError(
      "Required-tool-set contract cannot use an unsupported execution capability",
    );
  }
  if (
    retained.schemaEnforcement === "provider-strict" &&
    capability.status !== "provider-strict"
  ) {
    throw new ValidationError(
      "Provider-strict schema enforcement lacks matching capability provenance",
    );
  }
  if (
    retained.schemaEnforcement === "runtime-validated" &&
    !["runtime-validated", "unknown"].includes(capability.status)
  ) {
    throw new ValidationError(
      "Runtime-validated schema enforcement disagrees with capability provenance",
    );
  }
}

export const MAX_MODEL_RESPONSE_BLOCKS = 16;
export const MAX_MODEL_TOOL_CALL_SUMMARIES = 4;
export const MAX_MODEL_TOOL_CALL_ID_BYTES = 1_024;
export const MAX_MODEL_TOOL_NAME_BYTES = 256;
export const MAX_MODEL_TERMINATION_REASON_BYTES = 256;
export const MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES = 16 * 1_024;
export const MAX_MODEL_CONTRACT_EVIDENCE_BYTES = 64 * 1_024;
export const MAX_MODEL_FORMAL_RESPONSE_BYTES =
  MAX_AGENT_ACTION_BYTES + MAX_MODEL_CONTRACT_EVIDENCE_BYTES;
export const MAX_MODEL_CAPABILITY_REASON_BYTES = 2_048;
export const MAX_MODEL_PROVIDER_ID_BYTES = 256;
export const MAX_MODEL_ADAPTER_ID_BYTES = 256;
export const MAX_MODEL_WARNING_COUNT = 8;
export const MAX_MODEL_WARNING_MESSAGE_BYTES = 1_024;

export function assertModelFormalResponseByteCount(value: number): void {
  assertBoundedByteCount(
    value,
    MAX_MODEL_FORMAL_RESPONSE_BYTES,
    "Model formal response",
  );
}

export function assertModelContractEvidenceByteCount(value: number): void {
  assertBoundedByteCount(
    value,
    MAX_MODEL_CONTRACT_EVIDENCE_BYTES,
    "Model contract evidence",
  );
}

export type ModelTerminationKind =
  | "text-stop"
  | "tool-calls"
  | "output-limit"
  | "content-filter"
  | "refusal"
  | "other";
export type ModelAdapterGuardCode =
  | "multiple-tool-calls"
  | "unexpected-tool"
  | "oversized-tool-input"
  | "oversized-provider-response";

export interface CompleteModelResponse {
  readonly kind: "complete";
  readonly blocks: readonly ModelResponseBlock[];
  readonly termination: {
    readonly kind: ModelTerminationKind;
    readonly rawReason?: string;
  };
  readonly usage: Usage;
  readonly warnings: readonly ModelWarning[];
  readonly transport: ModelResponseTransport;
}

export interface GuardAbortedModelResponse {
  readonly kind: "guard-aborted";
  readonly blocks: readonly ModelResponseBlock[];
  readonly termination: {
    readonly kind: "adapter-guard";
    readonly code: ModelAdapterGuardCode;
  };
  readonly usage: null;
  readonly warnings: readonly ModelWarning[];
  readonly transport: ModelResponseTransport;
}

export type ModelResponse =
  | CompleteModelResponse
  | GuardAbortedModelResponse;

export interface ModelResponseTransport {
  readonly provider: string;
  readonly adapter: string;
}

export type InvalidToolCallCode =
  | "malformed-arguments"
  | "truncated-arguments"
  | "oversized-arguments";

export type ModelResponseBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly inputDigest: Sha256Digest;
      readonly inputBytes: number;
    }
  | {
      readonly type: "invalid-tool-call";
      readonly callId?: string;
      readonly name?: string;
      readonly inputDigest?: Sha256Digest;
      readonly inputBytes: number;
      readonly code: InvalidToolCallCode;
    };

export type SupplementalTextEvidence =
  | {
      readonly kind: "content";
      readonly text: string;
      readonly textDigest: Sha256Digest;
      readonly textBytes: number;
    }
  | {
      readonly kind: "digest";
      readonly textDigest: Sha256Digest;
      readonly textBytes: number;
    };

export interface ModelToolSubmission {
  readonly providerToolCallId: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly inputDigest: Sha256Digest;
  /**
   * Exact stable canonical-JSON byte length of the accepted input. Raw
   * streamed argument accumulation is a transient guard measurement and is
   * never durable accepted-input provenance.
   */
  readonly inputBytes: number;
  readonly responseContract: {
    readonly contractId: ModelStructuredContractId;
    readonly version: number;
    readonly contractDigest: Sha256Digest;
  };
  readonly transport: ModelResponseTransport;
  readonly termination: {
    readonly kind: "tool-calls";
    readonly rawReason?: string;
  };
  readonly supplementalText?: SupplementalTextEvidence;
}

export type ModelContractViolationCode =
  | "required-tool-missing"
  | "multiple-tool-calls"
  | "unexpected-tool"
  | "invalid-tool-input"
  | "truncated-tool-input"
  | "oversized-tool-input"
  | "oversized-provider-response"
  | "incomplete-provider-response"
  | "provider-refusal";

export interface ModelToolCallSummary {
  readonly callId?: string;
  readonly name?: string;
  readonly inputDigest?: Sha256Digest;
  readonly inputBytes: number;
  readonly invalidCode?: InvalidToolCallCode;
}

export interface ModelContractViolationEvidence {
  readonly toolCalls: readonly ModelToolCallSummary[];
  readonly omittedBlockCount: number;
  readonly supplementalTextDigest?: Sha256Digest;
  readonly supplementalTextBytes: number;
}

export interface ModelContractViolation {
  readonly code: ModelContractViolationCode;
  readonly message: string;
  readonly termination: ModelResponse["termination"];
  readonly evidence: ModelContractViolationEvidence;
  readonly evidenceDigest: Sha256Digest;
}

export type ModelEffectFailureCode =
  | "unsupported-response-contract"
  | "provider-context-window-overflow"
  | "provider-request-failed"
  | "transport-failed"
  | "stream-failed"
  | "incomplete-provider-response";

export const MODEL_EFFECT_FAILURE_CODES: readonly ModelEffectFailureCode[] =
  Object.freeze([
    "unsupported-response-contract",
    "provider-context-window-overflow",
    "provider-request-failed",
    "transport-failed",
    "stream-failed",
    "incomplete-provider-response",
  ]);

export function validateModelEffectFailureCode(
  value: unknown,
): ModelEffectFailureCode {
  if (
    typeof value !== "string" ||
    !MODEL_EFFECT_FAILURE_CODES.includes(value as ModelEffectFailureCode)
  ) {
    throw new ValidationError("Unknown model effect failure code");
  }
  return value as ModelEffectFailureCode;
}

export type ModelEffectResult =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly textDigest: Sha256Digest;
    }
  | {
      readonly kind: "tool-submission";
      readonly submission: ModelToolSubmission;
    }
  | {
      readonly kind: "contract-violation";
      readonly violation: ModelContractViolation;
    };

export interface ModelEffectOutputV2 {
  readonly kind: "agencity.model-effect-output.v2";
  readonly response: ModelResponse;
  readonly result: ModelEffectResult;
  readonly resultDigest: Sha256Digest;
}

export type ProviderNeutralModelOutputDelta =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool-call-start";
      readonly callId: string;
      readonly name: string;
    }
  | {
      readonly kind: "tool-input-delta";
      readonly callId: string;
      readonly bytes: number;
    };

export function modelEffectResultDigest(
  result: ModelEffectResult,
): Sha256Digest {
  return canonicalJsonDigest(result);
}

export function validateModelResponse(value: unknown): ModelResponse {
  assertJsonValue(value);
  const record = asRecord(value, "Model response");
  assertExactKeys(
    record,
    ["kind", "blocks", "termination", "usage", "warnings", "transport"],
    [],
    "Model response",
  );
  if (
    !Array.isArray(record.blocks) ||
    record.blocks.length > MAX_MODEL_RESPONSE_BLOCKS
  ) {
    throw new ValidationError(
      `Model response exceeds ${MAX_MODEL_RESPONSE_BLOCKS} blocks`,
    );
  }
  for (const block of record.blocks) validateModelResponseBlock(block);
  if (
    !Array.isArray(record.warnings) ||
    record.warnings.length > MAX_MODEL_WARNING_COUNT
  ) {
    throw new ValidationError(
      `Model response warnings exceed ${MAX_MODEL_WARNING_COUNT}`,
    );
  }
  for (const warning of record.warnings) validateWarning(warning);
  validateTransport(record.transport);
  if (record.kind === "complete") {
    validateCompleteTermination(record.termination);
    validateUsage(record.usage);
    return value as unknown as CompleteModelResponse;
  }
  if (record.kind === "guard-aborted") {
    validateGuardTermination(record.termination);
    if (record.usage !== null) {
      throw new ValidationError(
        "Guard-aborted model response must retain null usage",
      );
    }
    return value as unknown as GuardAbortedModelResponse;
  }
  throw new ValidationError("Unknown normalized model response kind");
}

export function validateModelToolSubmission(
  value: unknown,
  contract: RequiredToolSetModelResponseContract,
): ModelToolSubmission {
  assertJsonValue(value);
  const record = asRecord(value, "Model tool submission");
  assertExactKeys(
    record,
    [
      "providerToolCallId",
      "name",
      "input",
      "inputDigest",
      "inputBytes",
      "responseContract",
      "transport",
      "termination",
    ],
    ["supplementalText"],
    "Model tool submission",
  );
  assertBoundedNonEmptyString(
    record.providerToolCallId,
    MAX_MODEL_TOOL_CALL_ID_BYTES,
    "Provider tool call ID",
  );
  assertBoundedNonEmptyString(
    record.name,
    MAX_MODEL_TOOL_NAME_BYTES,
    "Model tool name",
  );
  assertSha256Digest(record.inputDigest, "Model tool input digest");
  assertNonnegativeSafeInteger(record.inputBytes, "Model tool input bytes");
  assertJsonValue(record.input);
  if (canonicalJsonDigest(record.input) !== record.inputDigest) {
    throw new ValidationError(
      "Model tool input digest does not match the accepted input",
    );
  }
  if (record.inputBytes !== canonicalJsonByteLength(record.input)) {
    throw new ValidationError(
      "Model tool input byte count must equal its canonical JSON encoding",
    );
  }
  const selected = contract.tools.find((tool) => tool.name === record.name);
  if (!selected) {
    throw new ValidationError(
      "Model tool submission is not allowed by its response contract",
    );
  }
  if (contract.contractId === AGENT_TOOL_CONTRACT_ID) {
    validateAgentToolSubmissionValue(
      { name: record.name, input: record.input },
      { encodedBytes: record.inputBytes as number },
    );
  } else if (contract.contractId === AGENT_TYPED_TOOL_CONTRACT_ID) {
    validateTypedAgentToolSubmissionValue(
      { name: record.name, input: record.input },
      contract.declaredSchema,
      { encodedBytes: record.inputBytes as number },
    );
  } else if (contract.contractId === REFINEMENT_REVIEW_CONTRACT_ID) {
    if (record.name !== REFINEMENT_REVIEW_TOOL_SET[0].name) {
      throw new ValidationError(
        "Refinement review submission has the wrong tool name",
      );
    }
    normalizeRefinementReviewTransportValue(record.input, {
      encodedBytes: record.inputBytes as number,
    });
  } else if (contract.contractId === REFINEMENT_GOVERNANCE_CONTRACT_ID) {
    if (record.name !== REFINEMENT_GOVERNANCE_TOOL_SET[0]!.name) {
      throw new ValidationError(
        "Refinement governance submission has the wrong tool name",
      );
    }
    validateRefinementGovernanceDecision(record.input);
  } else if (contract.contractId === DECLARED_DATA_CONTRACT_ID) {
    validateDeclaredDataSubmissionInput(contract, record.name, record.input);
  } else {
    throw new CapabilityUnavailableError(
      `tool submission validation for ${contract.contractId}`,
      "the current sealed contract registry",
    );
  }
  validateResponseContractReference(record.responseContract, contract);
  validateTransport(record.transport);
  const termination = validateCompleteTermination(record.termination);
  if (termination.kind !== "tool-calls") {
    throw new ValidationError(
      "Model tool submission requires complete tool-call termination",
    );
  }
  if (record.supplementalText !== undefined) {
    validateSupplementalTextEvidence(record.supplementalText);
  }
  if (canonicalJsonByteLength(record) > MAX_MODEL_FORMAL_RESPONSE_BYTES) {
    throw new ValidationError(
      `Model tool submission exceeds ${MAX_MODEL_FORMAL_RESPONSE_BYTES} bytes`,
    );
  }
  return value as unknown as ModelToolSubmission;
}

export function modelResponseContractInputByteLimit(
  contract: RequiredToolSetModelResponseContract,
): number {
  if (contract.contractId === AGENT_TOOL_CONTRACT_ID) {
    return MAX_AGENT_TOOL_INPUT_BYTES;
  }
  if (contract.contractId === AGENT_TYPED_TOOL_CONTRACT_ID) {
    return MAX_AGENT_TOOL_INPUT_BYTES;
  }
  if (contract.contractId === REFINEMENT_REVIEW_CONTRACT_ID) {
    return MAX_REFINEMENT_REVIEW_BYTES;
  }
  if (contract.contractId === REFINEMENT_GOVERNANCE_CONTRACT_ID) {
    return MAX_REFINEMENT_GOVERNANCE_OUTPUT_BYTES;
  }
  if (contract.contractId === DECLARED_DATA_CONTRACT_ID) {
    return MAX_DECLARED_INLINE_RESULT_BYTES + 64;
  }
  throw new CapabilityUnavailableError(
    `tool input limit for ${contract.contractId}`,
    "the current sealed contract registry",
  );
}

export function validateDeclaredDataSubmissionInput(
  contract: DeclaredDataModelResponseContract,
  name: unknown,
  input: unknown,
): JsonValue {
  if (name !== DECLARED_DATA_TOOL_NAME) {
    throw new ValidationError(
      "Declared-data submission has the wrong host-owned tool name",
    );
  }
  assertJsonValue(input);
  const record = asRecord(input, "Declared-data submission");
  assertExactKeys(record, ["value"], [], "Declared-data submission");
  return validateDeclaredSchemaValue(contract.declaredSchema, record.value);
}

export function validateModelContractViolation(
  value: unknown,
): ModelContractViolation {
  assertJsonValue(value);
  const record = asRecord(value, "Model contract violation");
  assertExactKeys(
    record,
    ["code", "message", "termination", "evidence", "evidenceDigest"],
    [],
    "Model contract violation",
  );
  if (
    ![
      "required-tool-missing",
      "multiple-tool-calls",
      "unexpected-tool",
      "invalid-tool-input",
      "truncated-tool-input",
      "oversized-tool-input",
      "oversized-provider-response",
      "incomplete-provider-response",
      "provider-refusal",
    ].includes(String(record.code))
  ) {
    throw new ValidationError("Model contract violation code is invalid");
  }
  if (typeof record.message !== "string" || !record.message) {
    throw new ValidationError("Model contract violation message is empty");
  }
  validateAnyTermination(record.termination);
  const evidence = validateViolationEvidence(record.evidence);
  if (
    record.code === "required-tool-missing" &&
    (evidence.toolCalls.length > 0 || evidence.omittedBlockCount > 0)
  ) {
    throw new ValidationError(
      "Required-tool-missing violation cannot retain tool-call evidence",
    );
  }
  if (
    record.code === "multiple-tool-calls" &&
    evidence.toolCalls.length + evidence.omittedBlockCount < 2
  ) {
    throw new ValidationError(
      "Multiple-tool-call violation requires evidence of at least two calls",
    );
  }
  assertSha256Digest(
    record.evidenceDigest,
    "Model contract violation evidence digest",
  );
  if (canonicalJsonDigest(evidence) !== record.evidenceDigest) {
    throw new ValidationError(
      "Model contract violation evidence digest does not match its evidence",
    );
  }
  if (canonicalJsonByteLength(record) > MAX_MODEL_CONTRACT_EVIDENCE_BYTES) {
    throw new ValidationError(
      `Model contract violation exceeds ${MAX_MODEL_CONTRACT_EVIDENCE_BYTES} bytes`,
    );
  }
  return value as unknown as ModelContractViolation;
}

export function validateModelEffectOutputV2(
  value: unknown,
  options: {
    readonly responseContract: ModelResponseContract;
    readonly responseCapability: ModelResponseCapability;
    readonly configuredProvider?: string;
  },
): ModelEffectOutputV2 {
  assertJsonValue(value);
  const record = asRecord(value, "Model effect output");
  assertExactKeys(
    record,
    ["kind", "response", "result", "resultDigest"],
    [],
    "Model effect output",
  );
  if (record.kind !== "agencity.model-effect-output.v2") {
    throw new ValidationError("Unsupported model effect output version");
  }
  const response = validateModelResponse(record.response);
  const result = asRecord(record.result, "Model effect result");
  assertSha256Digest(record.resultDigest, "Model effect result digest");
  if (canonicalJsonDigest(result) !== record.resultDigest) {
    throw new ValidationError(
      "Model effect result digest does not match its result",
    );
  }
  const contract = validateModelResponseContract(options.responseContract);
  validateModelResponseContractCapability(
    contract,
    options.responseCapability,
  );
  if (
    options.configuredProvider !== undefined &&
    response.transport.provider !== options.configuredProvider
  ) {
    throw new ValidationError(
      "Model response transport disagrees with the configured provider",
    );
  }
  if (
    options.responseCapability.kind === "required-tool-set" &&
    response.transport.adapter !==
      options.responseCapability.capability.adapter
  ) {
    throw new ValidationError(
      "Model response adapter disagrees with the retained execution capability",
    );
  }

  if (result.kind === "text") {
    assertExactKeys(
      result,
      ["kind", "text", "textDigest"],
      [],
      "Text model effect result",
    );
    if (typeof result.text !== "string") {
      throw new ValidationError("Text model effect result text is invalid");
    }
    assertSha256Digest(result.textDigest, "Text model effect result digest");
    if (canonicalJsonDigest(result.text) !== result.textDigest) {
      throw new ValidationError(
        "Text model effect digest does not match its text",
      );
    }
    if (response.kind !== "complete") {
      throw new ValidationError(
        "Text model effect result requires a complete response",
      );
    }
    const textBlocks = response.blocks.filter(
      (block): block is Extract<ModelResponseBlock, { type: "text" }> =>
        block.type === "text",
    );
    if (
      textBlocks.length !== response.blocks.length ||
      textBlocks.map((block) => block.text).join("") !== result.text
    ) {
      throw new ValidationError(
        "Text model effect result disagrees with normalized text blocks",
      );
    }
    if (contract.kind !== "text") {
      throw new ValidationError(
        "Required-tool-set response contract cannot produce a text result",
      );
    }
    return value as unknown as ModelEffectOutputV2;
  }

  if (contract.kind !== "required-tool-set") {
    throw new ValidationError(
      "Structured model effect result requires its retained required-tool-set contract",
    );
  }
  assertStructuredSupplementalTextBound(response);
  if (canonicalJsonByteLength(record) > MAX_MODEL_FORMAL_RESPONSE_BYTES) {
    throw new ValidationError(
      `Model effect output exceeds ${MAX_MODEL_FORMAL_RESPONSE_BYTES} bytes`,
    );
  }

  if (result.kind === "tool-submission") {
    assertExactKeys(
      result,
      ["kind", "submission"],
      [],
      "Tool-submission model effect result",
    );
    if (response.kind !== "complete" || response.termination.kind !== "tool-calls") {
      throw new ValidationError(
        "Model tool submission requires complete tool-call response termination",
      );
    }
    const submission = validateModelToolSubmission(
      result.submission,
      contract,
    );
    if (!Bun.deepEquals(submission.transport, response.transport)) {
      throw new ValidationError(
        "Model tool submission transport disagrees with normalized response",
      );
    }
    if (!Bun.deepEquals(submission.termination, response.termination)) {
      throw new ValidationError(
        "Model tool submission termination disagrees with normalized response",
      );
    }
    const callBlocks = response.blocks.filter(
      (block): block is Extract<ModelResponseBlock, { type: "tool-call" }> =>
        block.type === "tool-call",
    );
    if (
      callBlocks.length !== 1 ||
      response.blocks.some((block) => block.type === "invalid-tool-call")
    ) {
      throw new ValidationError(
        "Accepted model tool submission requires exactly one valid evidence block",
      );
    }
    const block = callBlocks[0]!;
    if (
      block.callId !== submission.providerToolCallId ||
      block.name !== submission.name ||
      block.inputDigest !== submission.inputDigest ||
      block.inputBytes !== submission.inputBytes
    ) {
      throw new ValidationError(
        "Model tool submission disagrees with its evidence-only response block",
      );
    }
    validateSubmissionSupplementalText(submission, response);
    return value as unknown as ModelEffectOutputV2;
  }

  if (result.kind === "contract-violation") {
    assertExactKeys(
      result,
      ["kind", "violation"],
      [],
      "Contract-violation model effect result",
    );
    const violation = validateModelContractViolation(result.violation);
    if (!Bun.deepEquals(violation.termination, response.termination)) {
      throw new ValidationError(
        "Model contract violation termination disagrees with normalized response",
      );
    }
    if (
      response.kind === "guard-aborted" &&
      violation.code !== response.termination.code
    ) {
      throw new ValidationError(
        "Guard-aborted response code disagrees with its contract violation",
      );
    }
    validateViolationEvidenceRelation(violation.evidence, response);
    if (response.kind === "complete") {
      validateCompleteViolationCodeRelation(violation, response, contract);
    }
    if (response.kind === "guard-aborted" && response.usage !== null) {
      throw new ValidationError(
        "Guard-aborted contract violation must retain null usage",
      );
    }
    return value as unknown as ModelEffectOutputV2;
  }

  throw new ValidationError("Unknown model effect result kind");
}

export function createModelEffectOutputV2(input: {
  readonly response: ModelResponse;
  readonly result: ModelEffectResult;
  readonly responseContract: ModelResponseContract;
  readonly responseCapability: ModelResponseCapability;
  readonly configuredProvider?: string;
}): ModelEffectOutputV2 {
  const output = {
    kind: "agencity.model-effect-output.v2" as const,
    response: input.response,
    result: input.result,
    resultDigest: modelEffectResultDigest(input.result),
  };
  validateModelEffectOutputV2(output, {
    responseContract: input.responseContract,
    responseCapability: input.responseCapability,
    ...(input.configuredProvider === undefined
      ? {}
      : { configuredProvider: input.configuredProvider }),
  });
  return deepFreeze(output);
}

function validateModelResponseBlock(value: unknown): void {
  const record = asRecord(value, "Model response block");
  if (record.type === "text") {
    assertExactKeys(record, ["type", "text"], [], "Text response block");
    if (typeof record.text !== "string") {
      throw new ValidationError("Model response text block is invalid");
    }
    return;
  }
  if (record.type === "tool-call") {
    assertExactKeys(
      record,
      ["type", "callId", "name", "inputDigest", "inputBytes"],
      [],
      "Tool-call response block",
    );
    assertBoundedNonEmptyString(
      record.callId,
      MAX_MODEL_TOOL_CALL_ID_BYTES,
      "Provider tool call ID",
    );
    assertBoundedNonEmptyString(
      record.name,
      MAX_MODEL_TOOL_NAME_BYTES,
      "Model tool name",
    );
    assertSha256Digest(record.inputDigest, "Model tool input digest");
    assertNonnegativeSafeInteger(record.inputBytes, "Model tool input bytes");
    return;
  }
  if (record.type === "invalid-tool-call") {
    assertExactKeys(
      record,
      ["type", "inputBytes", "code"],
      ["callId", "name", "inputDigest"],
      "Invalid-tool-call response block",
    );
    if (record.callId !== undefined) {
      assertBoundedNonEmptyString(
        record.callId,
        MAX_MODEL_TOOL_CALL_ID_BYTES,
        "Provider tool call ID",
      );
    }
    if (record.name !== undefined) {
      assertBoundedNonEmptyString(
        record.name,
        MAX_MODEL_TOOL_NAME_BYTES,
        "Model tool name",
      );
    }
    if (record.inputDigest !== undefined) {
      assertSha256Digest(record.inputDigest, "Model tool input digest");
    }
    assertNonnegativeSafeInteger(record.inputBytes, "Model tool input bytes");
    if (
      ![
        "malformed-arguments",
        "truncated-arguments",
        "oversized-arguments",
      ].includes(String(record.code))
    ) {
      throw new ValidationError("Invalid tool-call code is invalid");
    }
    return;
  }
  throw new ValidationError("Unknown model response block type");
}

function validateAnyTermination(
  value: unknown,
): ModelResponse["termination"] {
  const record = asRecord(value, "Model response termination");
  return record.kind === "adapter-guard"
    ? validateGuardTermination(record)
    : validateCompleteTermination(record);
}

function validateCompleteTermination(
  value: unknown,
): CompleteModelResponse["termination"] {
  const record = asRecord(value, "Complete model response termination");
  assertExactKeys(
    record,
    ["kind"],
    ["rawReason"],
    "Complete model response termination",
  );
  if (
    ![
      "text-stop",
      "tool-calls",
      "output-limit",
      "content-filter",
      "refusal",
      "other",
    ].includes(String(record.kind))
  ) {
    throw new ValidationError(
      "Complete model response termination kind is invalid",
    );
  }
  if (
    record.rawReason !== undefined &&
    (typeof record.rawReason !== "string" ||
      utf8Bytes(record.rawReason) > MAX_MODEL_TERMINATION_REASON_BYTES)
  ) {
    throw new ValidationError(
      `Model termination reason exceeds ${MAX_MODEL_TERMINATION_REASON_BYTES} bytes`,
    );
  }
  return value as CompleteModelResponse["termination"];
}

function validateGuardTermination(
  value: unknown,
): GuardAbortedModelResponse["termination"] {
  const record = asRecord(value, "Guard-aborted model response termination");
  assertExactKeys(
    record,
    ["kind", "code"],
    [],
    "Guard-aborted model response termination",
  );
  if (
    record.kind !== "adapter-guard" ||
    ![
      "multiple-tool-calls",
      "unexpected-tool",
      "oversized-tool-input",
      "oversized-provider-response",
    ].includes(String(record.code))
  ) {
    throw new ValidationError(
      "Guard-aborted model response termination is invalid",
    );
  }
  return value as GuardAbortedModelResponse["termination"];
}

function validateUsage(value: unknown): void {
  const record = asRecord(value, "Model usage");
  assertExactKeys(
    record,
    ["inputTokens", "outputTokens", "costUsd"],
    ["cacheReadTokens", "cacheWriteTokens"],
    "Model usage",
  );
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
      throw new ValidationError(`Model usage ${key} is invalid`);
    }
  }
}

function validateWarning(value: unknown): void {
  const record = asRecord(value, "Model warning");
  assertExactKeys(record, ["kind", "message"], [], "Model warning");
  if (
    !["coerced", "unsupported", "provider", "truncated"].includes(
      String(record.kind),
    )
  ) {
    throw new ValidationError("Model warning kind is invalid");
  }
  assertBoundedNonEmptyString(
    record.message,
    MAX_MODEL_WARNING_MESSAGE_BYTES,
    "Model warning message",
  );
}

function validateTransport(value: unknown): ModelResponseTransport {
  const record = asRecord(value, "Model response transport");
  assertExactKeys(
    record,
    ["provider", "adapter"],
    [],
    "Model response transport",
  );
  assertBoundedNonEmptyString(
    record.provider,
    MAX_MODEL_PROVIDER_ID_BYTES,
    "Model response provider",
  );
  assertBoundedNonEmptyString(
    record.adapter,
    MAX_MODEL_ADAPTER_ID_BYTES,
    "Model response adapter",
  );
  return value as ModelResponseTransport;
}

function validateResponseContractReference(
  value: unknown,
  contract: RequiredToolSetModelResponseContract,
): void {
  const record = asRecord(value, "Model response contract reference");
  assertExactKeys(
    record,
    ["contractId", "version", "contractDigest"],
    [],
    "Model response contract reference",
  );
  if (
    record.contractId !== contract.contractId ||
    record.version !== contract.version ||
    record.contractDigest !== contract.contractDigest
  ) {
    throw new ValidationError(
      "Model tool submission response-contract reference is invalid",
    );
  }
}

function validateSupplementalTextEvidence(value: unknown): void {
  const record = asRecord(value, "Supplemental-text evidence");
  assertSha256Digest(
    record.textDigest,
    "Supplemental-text evidence digest",
  );
  assertNonnegativeSafeInteger(
    record.textBytes,
    "Supplemental-text evidence bytes",
  );
  if (record.kind === "content") {
    assertExactKeys(
      record,
      ["kind", "text", "textDigest", "textBytes"],
      [],
      "Supplemental-text content evidence",
    );
    if (typeof record.text !== "string") {
      throw new ValidationError("Supplemental-text content is invalid");
    }
    const bytes = utf8Bytes(record.text);
    if (bytes > MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES) {
      throw new ValidationError(
        `Supplemental text exceeds ${MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES} bytes`,
      );
    }
    if (
      record.textBytes !== bytes ||
      record.textDigest !== canonicalJsonDigest(record.text)
    ) {
      throw new ValidationError(
        "Supplemental-text content evidence digest or byte count is invalid",
      );
    }
    return;
  }
  if (record.kind === "digest") {
    assertExactKeys(
      record,
      ["kind", "textDigest", "textBytes"],
      [],
      "Supplemental-text digest evidence",
    );
    return;
  }
  throw new ValidationError("Supplemental-text evidence kind is invalid");
}

function validateViolationEvidence(
  value: unknown,
): ModelContractViolationEvidence {
  const record = asRecord(value, "Model contract violation evidence");
  assertExactKeys(
    record,
    ["toolCalls", "omittedBlockCount", "supplementalTextBytes"],
    ["supplementalTextDigest"],
    "Model contract violation evidence",
  );
  if (
    !Array.isArray(record.toolCalls) ||
    record.toolCalls.length > MAX_MODEL_TOOL_CALL_SUMMARIES
  ) {
    throw new ValidationError(
      `Model contract violation exceeds ${MAX_MODEL_TOOL_CALL_SUMMARIES} tool-call summaries`,
    );
  }
  for (const summary of record.toolCalls) validateToolCallSummary(summary);
  assertNonnegativeSafeInteger(
    record.omittedBlockCount,
    "Model contract violation omitted block count",
  );
  assertNonnegativeSafeInteger(
    record.supplementalTextBytes,
    "Model contract violation supplemental-text bytes",
  );
  if (record.supplementalTextBytes === 0) {
    if (record.supplementalTextDigest !== undefined) {
      throw new ValidationError(
        "Empty supplemental-text evidence must omit its digest",
      );
    }
  } else {
    assertSha256Digest(
      record.supplementalTextDigest,
      "Model contract violation supplemental-text digest",
    );
  }
  return value as ModelContractViolationEvidence;
}

function validateToolCallSummary(value: unknown): void {
  const record = asRecord(value, "Model tool-call summary");
  assertExactKeys(
    record,
    ["inputBytes"],
    ["callId", "name", "inputDigest", "invalidCode"],
    "Model tool-call summary",
  );
  if (record.callId !== undefined) {
    assertBoundedNonEmptyString(
      record.callId,
      MAX_MODEL_TOOL_CALL_ID_BYTES,
      "Provider tool call ID",
    );
  }
  if (record.name !== undefined) {
    assertBoundedNonEmptyString(
      record.name,
      MAX_MODEL_TOOL_NAME_BYTES,
      "Model tool name",
    );
  }
  if (record.inputDigest !== undefined) {
    assertSha256Digest(record.inputDigest, "Model tool input digest");
  }
  assertNonnegativeSafeInteger(record.inputBytes, "Model tool input bytes");
  if (
    record.invalidCode !== undefined &&
    ![
      "malformed-arguments",
      "truncated-arguments",
      "oversized-arguments",
    ].includes(String(record.invalidCode))
  ) {
    throw new ValidationError("Model tool-call summary invalid code is invalid");
  }
}

function assertStructuredSupplementalTextBound(
  response: ModelResponse,
): void {
  const bytes = utf8Bytes(
    response.blocks
      .filter(
        (block): block is Extract<ModelResponseBlock, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join(""),
  );
  if (bytes > MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES) {
    throw new ValidationError(
      `Supplemental text exceeds ${MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES} bytes`,
    );
  }
}

function validateSubmissionSupplementalText(
  submission: ModelToolSubmission,
  response: CompleteModelResponse,
): void {
  const text = response.blocks
    .filter(
      (block): block is Extract<ModelResponseBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
  if (!text) {
    if (submission.supplementalText !== undefined) {
      throw new ValidationError(
        "Model tool submission retains supplemental evidence without normalized text",
      );
    }
    return;
  }
  if (!submission.supplementalText) {
    throw new ValidationError(
      "Model tool submission is missing supplemental-text evidence",
    );
  }
  const bytes = utf8Bytes(text);
  const digest = canonicalJsonDigest(text);
  if (
    submission.supplementalText.textBytes !== bytes ||
    submission.supplementalText.textDigest !== digest ||
    (submission.supplementalText.kind === "content" &&
      submission.supplementalText.text !== text)
  ) {
    throw new ValidationError(
      "Model tool submission supplemental-text evidence disagrees with normalized response",
    );
  }
}

function validateViolationEvidenceRelation(
  evidence: ModelContractViolationEvidence,
  response: ModelResponse,
): void {
  const calls = response.blocks.filter(
    (
      block,
    ): block is Exclude<ModelResponseBlock, { type: "text" }> =>
      block.type !== "text",
  );
  const retained = calls.slice(0, MAX_MODEL_TOOL_CALL_SUMMARIES).map(
    (block): ModelToolCallSummary => block.type === "tool-call"
      ? {
          callId: block.callId,
          name: block.name,
          inputDigest: block.inputDigest,
          inputBytes: block.inputBytes,
        }
      : {
          ...(block.callId === undefined ? {} : { callId: block.callId }),
          ...(block.name === undefined ? {} : { name: block.name }),
          ...(block.inputDigest === undefined
            ? {}
            : { inputDigest: block.inputDigest }),
          inputBytes: block.inputBytes,
          invalidCode: block.code,
        },
  );
  if (!Bun.deepEquals(evidence.toolCalls, retained)) {
    throw new ValidationError(
      "Model contract violation evidence disagrees with normalized tool-call blocks",
    );
  }
  if (
    evidence.omittedBlockCount <
      Math.max(0, calls.length - MAX_MODEL_TOOL_CALL_SUMMARIES)
  ) {
    throw new ValidationError(
      "Model contract violation omitted-block count is understated",
    );
  }
  const text = response.blocks
    .filter(
      (block): block is Extract<ModelResponseBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
  const textBytes = utf8Bytes(text);
  if (evidence.supplementalTextBytes < textBytes) {
    throw new ValidationError(
      "Model contract violation supplemental-text byte count is understated",
    );
  }
  if (
    textBytes === evidence.supplementalTextBytes &&
    textBytes > 0 &&
    evidence.supplementalTextDigest !== canonicalJsonDigest(text)
  ) {
    throw new ValidationError(
      "Model contract violation supplemental-text digest disagrees with normalized response",
    );
  }
}

/**
 * A non-guard violation must be provable from its completed termination and
 * evidence-only blocks under the retained required-tool-set contract. Guard
 * codes are validated separately through exact guard-code equality.
 */
function validateCompleteViolationCodeRelation(
  violation: ModelContractViolation,
  response: CompleteModelResponse,
  contract: RequiredToolSetModelResponseContract,
): void {
  const termination = response.termination.kind;
  const calls = response.blocks.filter(
    (block): block is Exclude<ModelResponseBlock, { type: "text" }> =>
      block.type !== "text",
  );
  const contractNames = new Set(contract.tools.map((tool) => tool.name));
  const reject = (reason: string): never => {
    throw new ValidationError(
      `Model contract violation ${violation.code} ${reason}`,
    );
  };
  if (
    (termination === "content-filter" || termination === "refusal") &&
    violation.code !== "provider-refusal"
  ) {
    reject("cannot describe a content-filter or refusal termination");
  }
  switch (violation.code) {
    case "required-tool-missing":
      if (termination !== "text-stop" || calls.length !== 0) {
        reject("requires completed text-stop with no tool call");
      }
      return;
    case "multiple-tool-calls":
      if (calls.length < 2) {
        reject("requires at least two retained tool-call blocks");
      }
      return;
    case "unexpected-tool":
      if (
        !calls.some(
          (block) =>
            block.name !== undefined && !contractNames.has(block.name),
        )
      ) {
        reject("requires a retained call outside the response contract");
      }
      return;
    case "invalid-tool-input":
      if (
        !calls.some(
          (block) =>
            (block.type === "invalid-tool-call" &&
              block.code === "malformed-arguments") ||
            (block.name !== undefined && contractNames.has(block.name)),
        )
      ) {
        reject("requires a retained rejected call for a contract tool");
      }
      return;
    case "truncated-tool-input":
      if (
        termination !== "output-limit" ||
        !calls.some(
          (block) =>
            block.type === "invalid-tool-call" &&
            block.code === "truncated-arguments",
        )
      ) {
        reject(
          "requires output-limit termination with truncated call evidence",
        );
      }
      return;
    case "oversized-tool-input":
      if (
        !calls.some(
          (block) =>
            block.type === "invalid-tool-call" &&
            block.code === "oversized-arguments",
        )
      ) {
        reject("requires oversized call-argument evidence");
      }
      return;
    case "oversized-provider-response": {
      const retainedTextBytes = utf8Bytes(
        response.blocks
          .filter(
            (block): block is Extract<ModelResponseBlock, { type: "text" }> =>
              block.type === "text",
          )
          .map((block) => block.text)
          .join(""),
      );
      if (
        !calls.some(
          (block) =>
            block.type === "invalid-tool-call" &&
            block.code === "oversized-arguments",
        ) &&
        violation.evidence.omittedBlockCount <=
          Math.max(0, calls.length - MAX_MODEL_TOOL_CALL_SUMMARIES) &&
        violation.evidence.supplementalTextBytes <= retainedTextBytes
      ) {
        reject("requires omitted or oversized response evidence");
      }
      return;
    }
    case "provider-refusal":
      if (termination !== "content-filter" && termination !== "refusal") {
        reject("requires content-filter or refusal termination");
      }
      return;
    case "incomplete-provider-response":
      if (termination === "text-stop" && calls.length === 0) {
        reject("cannot describe a completed text-stop with no tool call");
      }
      return;
  }
}

function isBuiltInStructuredContractId(
  value: string,
): value is BuiltInStructuredContractId {
  return value === AGENT_TOOL_CONTRACT_ID ||
    value === REFINEMENT_REVIEW_CONTRACT_ID ||
    value === REFINEMENT_GOVERNANCE_CONTRACT_ID;
}

function buildStructuredContract(
  template: StructuredContractTemplate,
  schemaEnforcement: ModelSchemaEnforcement,
): BuiltInRequiredToolSetModelResponseContract {
  const body = {
    kind: "required-tool-set" as const,
    version: MODEL_RESPONSE_CONTRACT_VERSION,
    contractId: template.contractId,
    tools: template.tools,
    schemaEnforcement,
    selection: MODEL_RESPONSE_CONTRACT_SELECTION,
    supplementalText: MODEL_RESPONSE_CONTRACT_SUPPLEMENTAL_TEXT,
  };
  return deepFreeze({
    ...body,
    contractDigest: canonicalJsonDigest(body),
  });
}

function asRecord(
  value: unknown,
  label: string,
): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function assertExactKeys(
  record: Record<string, JsonValue>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new ValidationError(`${label} has missing or unknown fields`);
  }
}

function assertSha256Digest(
  value: unknown,
  label: string,
): asserts value is Sha256Digest {
  if (
    typeof value !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value)
  ) {
    throw new ValidationError(`${label} is invalid`);
  }
}

function assertBoundedNonEmptyString(
  value: unknown,
  maximum: number,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !value) {
    throw new ValidationError(`${label} cannot be empty`);
  }
  if (utf8Bytes(value) > maximum) {
    throw new ValidationError(`${label} exceeds ${maximum} bytes`);
  }
}

function assertNonnegativeSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ValidationError(
      `${label} must be a non-negative safe integer`,
    );
  }
}

function assertBoundedByteCount(
  value: number,
  maximum: number,
  label: string,
): void {
  assertNonnegativeSafeInteger(value, `${label} byte count`);
  if (value > maximum) {
    throw new ValidationError(`${label} exceeds ${maximum} bytes`);
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

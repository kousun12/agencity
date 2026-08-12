import {
  AGENT_PROFILE_PROMPT_CONTRACT_ID,
  agentProfilePin,
  type AgentInvocationProfilePin,
  type AgentProfileVersion,
} from "./agent-profile.ts";
import type { BudgetLimits } from "./events.ts";
import {
  validateRetainedModelConfiguration,
  type ModelConfiguration,
} from "./model.ts";
import {
  MAX_DECLARED_INLINE_RESULT_BYTES,
  resolveDeclaredSchema,
  validateDeclaredSchemaValue,
  validateResolvedDeclaredSchema,
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
import { ValidationError } from "./errors.ts";

export const AGENT_INVOCATION_CONTRACT_PROTOCOL =
  "agencity.agent-invocation-contract" as const;
export const AGENT_INVOCATION_CONTRACT_VERSION = 1 as const;
export const AGENT_RESULT_REFERENCE_PROTOCOL =
  "agencity.agent-run-result-reference" as const;
export const AGENT_RESULT_REFERENCE_VERSION = 1 as const;

export type AgentInvocationOutputContract =
  | { readonly kind: "text" }
  | {
      readonly kind: "object";
      readonly declaredSchema: ResolvedDeclaredSchema;
    };

export interface AgentInvocationContract {
  readonly protocol: typeof AGENT_INVOCATION_CONTRACT_PROTOCOL;
  readonly version: typeof AGENT_INVOCATION_CONTRACT_VERSION;
  readonly runId: string;
  readonly taskId: string | null;
  readonly output: AgentInvocationOutputContract;
  readonly model: ModelConfiguration;
  readonly profilePin: AgentInvocationProfilePin;
  readonly budget: BudgetLimits;
  readonly resultPolicy: {
    readonly storage: "inline";
    readonly inlineByteLimit: typeof MAX_DECLARED_INLINE_RESULT_BYTES;
  };
  readonly contractDigest: Sha256Digest;
}

export interface AgentRunResultReference {
  readonly protocol: typeof AGENT_RESULT_REFERENCE_PROTOCOL;
  readonly version: typeof AGENT_RESULT_REFERENCE_VERSION;
  readonly runId: string;
  readonly resultEventId: string;
  readonly finishEventId: string;
  readonly messageId: string;
  readonly kind: "text" | "object";
  readonly valueDigest: Sha256Digest;
  readonly schemaDigest?: Sha256Digest;
}

export function createAgentInvocationContract(input: {
  readonly runId: string;
  readonly taskId?: string | null;
  readonly output?: { readonly kind?: "text" } | {
    readonly kind: "object";
    readonly schema: unknown;
  };
  readonly model: ModelConfiguration;
  readonly profile: AgentProfileVersion;
  readonly budget: BudgetLimits;
}): AgentInvocationContract {
  validateRetainedModelConfiguration(input.model);
  validateBudgetLimits(input.budget);
  const output: AgentInvocationOutputContract =
    input.output?.kind === "object"
      ? {
          kind: "object",
          declaredSchema: resolveDeclaredSchema(input.output.schema),
        }
      : { kind: "text" };
  const body = {
    protocol: AGENT_INVOCATION_CONTRACT_PROTOCOL,
    version: AGENT_INVOCATION_CONTRACT_VERSION,
    runId: requiredId(input.runId, "Agent invocation run ID"),
    taskId: input.taskId == null
      ? null
      : requiredId(input.taskId, "Agent invocation task ID"),
    output,
    model: { ...input.model },
    profilePin: agentProfilePin(input.profile),
    budget: { ...input.budget },
    resultPolicy: {
      storage: "inline" as const,
      inlineByteLimit: MAX_DECLARED_INLINE_RESULT_BYTES,
    },
  };
  assertJsonValue(body as unknown);
  const contract = deepFreeze({
    ...body,
    contractDigest: canonicalJsonDigest(body),
  });
  validateAgentInvocationContract(contract);
  return contract;
}

export function validateAgentInvocationContract(
  value: unknown,
): AgentInvocationContract {
  assertJsonValue(value);
  if (!isRecord(value)) {
    throw new ValidationError("Agent invocation contract must be an object");
  }
  const record = value as Record<string, any>;
  const required = [
    "protocol", "version", "runId", "taskId", "output", "model", "profilePin",
    "budget", "resultPolicy", "contractDigest",
  ];
  if (
    Object.keys(record).length !== required.length ||
    required.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new ValidationError("Agent invocation contract has invalid fields");
  }
  const digest = record.contractDigest;
  if (typeof digest !== "string") {
    throw new ValidationError("Agent invocation contract digest is missing");
  }
  const { contractDigest: _digest, ...body } = record;
  if (canonicalJsonDigest(body) !== digest) {
    throw new ValidationError(
      "Agent invocation contract digest does not match its definition",
    );
  }
  if (
    record.protocol !== AGENT_INVOCATION_CONTRACT_PROTOCOL ||
    record.version !== AGENT_INVOCATION_CONTRACT_VERSION ||
    typeof record.runId !== "string" ||
    !record.runId ||
    (record.taskId !== null &&
      (typeof record.taskId !== "string" || !record.taskId)) ||
    !isRecord(record.output) ||
    !isRecord(record.model) ||
    !isRecord(record.profilePin) ||
    !isRecord(record.budget) ||
    !isRecord(record.resultPolicy) ||
    record.resultPolicy.storage !== "inline" ||
    record.resultPolicy.inlineByteLimit !== MAX_DECLARED_INLINE_RESULT_BYTES
  ) {
    throw new ValidationError("Agent invocation contract is invalid");
  }
  assertExactKeys(
    record.resultPolicy,
    ["storage", "inlineByteLimit"],
    "Agent invocation result policy",
  );
  validateRetainedModelConfiguration(record.model as ModelConfiguration);
  validateBudgetLimits(record.budget);
  assertExactKeys(
    record.profilePin,
    ["profileVersionId", "agentPromptDigest", "promptContractId"],
    "Agent invocation profile pin",
  );
  if (
    typeof record.profilePin.profileVersionId !== "string" ||
    !record.profilePin.profileVersionId.trim() ||
    typeof record.profilePin.agentPromptDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.profilePin.agentPromptDigest) ||
    record.profilePin.promptContractId !== AGENT_PROFILE_PROMPT_CONTRACT_ID
  ) {
    throw new ValidationError("Agent invocation profile pin is invalid");
  }
  if (record.output.kind === "object") {
    assertExactKeys(
      record.output,
      ["kind", "declaredSchema"],
      "Agent invocation object output contract",
    );
    validateResolvedDeclaredSchema(record.output.declaredSchema);
  } else if (
    record.output.kind !== "text" ||
    canonicalJsonStringify(record.output) !== '{"kind":"text"}'
  ) {
    throw new ValidationError("Agent invocation output contract is invalid");
  }
  return value as unknown as AgentInvocationContract;
}

export function validateAgentInvocationResult(
  contract: AgentInvocationContract,
  kind: "text" | "object",
  value: unknown,
): JsonValue {
  const retained = validateAgentInvocationContract(contract);
  if (kind !== retained.output.kind) {
    throw new ValidationError(
      "Agent run result kind does not match its pinned invocation contract",
    );
  }
  if (kind === "object") {
    return validateDeclaredSchemaValue(
      (retained.output as Extract<AgentInvocationOutputContract, {
        kind: "object";
      }>).declaredSchema,
      value,
    );
  }
  if (typeof value !== "string" || !value) {
    throw new ValidationError("Text agent run result must be a non-empty string");
  }
  assertJsonValue(value);
  if (canonicalJsonByteLength(value) > retained.resultPolicy.inlineByteLimit) {
    throw new ValidationError(
      `Agent run result exceeds ${retained.resultPolicy.inlineByteLimit} bytes`,
    );
  }
  return value;
}

export function validateAgentRunResultReference(
  value: unknown,
): AgentRunResultReference {
  assertJsonValue(value);
  if (!isRecord(value)) {
    throw new ValidationError("Agent run result reference must be an object");
  }
  const record = value as Record<string, any>;
  const required = [
    "protocol", "version", "runId", "resultEventId", "finishEventId",
    "messageId", "kind", "valueDigest",
  ];
  const allowed = [...required, "schemaDigest"];
  if (
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(record, key)) ||
    record.protocol !== AGENT_RESULT_REFERENCE_PROTOCOL ||
    record.version !== AGENT_RESULT_REFERENCE_VERSION ||
    typeof record.runId !== "string" ||
    !record.runId ||
    typeof record.resultEventId !== "string" ||
    !record.resultEventId ||
    typeof record.finishEventId !== "string" ||
    !record.finishEventId ||
    typeof record.messageId !== "string" ||
    !record.messageId ||
    !["text", "object"].includes(String(record.kind)) ||
    typeof record.valueDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(record.valueDigest) ||
    (record.kind === "object") !==
      (Object.hasOwn(record, "schemaDigest") &&
        typeof record.schemaDigest === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(record.schemaDigest))
  ) {
    throw new ValidationError("Agent run result reference is invalid");
  }
  return value as unknown as AgentRunResultReference;
}

function requiredId(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new ValidationError(`${label} has invalid fields`);
  }
}

function validateBudgetLimits(value: BudgetLimits): void {
  if (!isRecord(value)) {
    throw new ValidationError("Agent invocation budget must be an object");
  }
  const allowed = [
    "tokenLimit",
    "costLimitUsd",
    "turnLimit",
    "wallTimeLimitMs",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ValidationError("Agent invocation budget has invalid fields");
  }
  for (const key of allowed) {
    const limit = value[key as keyof BudgetLimits];
    if (limit !== undefined &&
        (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0)) {
      throw new ValidationError(`Agent invocation budget ${key} is invalid`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

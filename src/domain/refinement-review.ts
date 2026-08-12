import { z } from "zod";
import { ValidationError } from "./errors.ts";
import type { HarnessContent, HarnessEdit, HarnessKind, HarnessScope, ObjectiveEvaluation } from "./harness.ts";
import { assertJsonValue, canonicalJsonByteLength, type JsonValue } from "./json.ts";

/** Authoritative provider response protocol for trajectory refinement reviews. */
export const REFINEMENT_REVIEW_PROTOCOL = "agencity.refinement-review" as const;
export const REFINEMENT_REVIEW_VERSION = 1 as const;

export const refinementReviewModes = ["manual", "automatic", "skill_creation"] as const;
export type RefinementReviewMode = (typeof refinementReviewModes)[number];
export const refinementReviewStatuses = ["no_change", "propose"] as const;
export type RefinementReviewStatus = (typeof refinementReviewStatuses)[number];
export const refinementTriggerKinds = [
  "manual",
  "repeated_effect_failure",
  "repeated_cell_failure",
  "repeated_gate_failure",
  "explicit_user_correction",
  "repeated_success",
  "stale_memory",
  "unproductive_delegation",
  "skill_creation",
] as const;
export type RefinementTriggerKind = (typeof refinementTriggerKinds)[number];

export const MAX_REFINEMENT_REVIEW_BYTES = 256 * 1024;
export const MAX_REFINEMENT_INSTRUCTIONS_BYTES = 8 * 1024;
export const MAX_REFINEMENT_TRIGGER_BYTES = 4 * 1024;
export const MAX_REFINEMENT_PREDICTED_EFFECT_BYTES = 4 * 1024;
export const MAX_REFINEMENT_REASON_BYTES = 4 * 1024;
export const MAX_REFINEMENT_EDIT_BYTES = 96 * 1024;
export const MAX_REFINEMENT_EDITS = 8;
export const MAX_REFINEMENT_EVIDENCE_IDS = 64;
export const MAX_REFINEMENT_SOURCE_EVENT_IDS = 256;
export const MAX_REFINEMENT_EDITABLE_TARGETS = 128;
export const MAX_REFINEMENT_TAGS = 16;
export const MAX_REFINEMENT_SKILL_TESTS = 32;
export const MAX_REFINEMENT_TEXT_BYTES = 64 * 1024;

const encoder = new TextEncoder();
const harnessKinds = ["memory", "prompt_note", "skill", "subagent_spec"] as const;
const harnessScopes = ["local", "workspace", "user", "global"] as const;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const forbiddenPermission = /^(?:admin|root|policy|permission|\*)$/i;
const immutablePolicy = /^(?:base(?:[-_ ]policy)?|system(?:[-_ ]prompt)?|permission(?:[-_ ]boundary)?|safety(?:[-_ ]policy)?)$/i;
const policyEscalation = /\b(?:ignore|override|disable|weaken|expand|change)\b.{0,40}\b(?:base policy|permission boundary|safety policy|permissions)\b/i;

const boundedId = z.string().min(1).max(256).regex(idPattern);
const boundedName = z.string().min(1).max(128).refine(nonBlank, "must not be blank");
const boundedTag = z.string().min(1).max(64).refine(nonBlank, "must not be blank");
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

const stringList = (maximum: number) => z.array(boundedId).max(maximum).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "duplicate identifiers are not allowed" });
});
const optionalEditMetadata = {
  tags: z.array(boundedTag).max(MAX_REFINEMENT_TAGS).superRefine((values, context) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "duplicate tags are not allowed" });
  }).optional(),
  confidence: z.number().finite().min(0).max(1).optional(),
  evidenceEventIds: stringList(MAX_REFINEMENT_EVIDENCE_IDS).optional(),
  conflictEntryIds: stringList(MAX_REFINEMENT_EDITABLE_TARGETS).optional(),
};

const memoryContentSchema = z.object({
  kind: z.literal("memory"),
  memoryKind: z.enum(["claim", "preference", "decision", "observation", "constraint"]),
  text: z.string().min(1).max(MAX_REFINEMENT_TEXT_BYTES).refine(nonBlank, "must not be blank"),
}).strict();
const promptNoteContentSchema = z.object({
  kind: z.literal("prompt_note"),
  text: z.string().min(1).max(MAX_REFINEMENT_TEXT_BYTES).refine(nonBlank, "must not be blank"),
}).strict();
const skillTestSchema = z.object({
  name: boundedName,
  input: jsonValueSchema,
  expected: jsonValueSchema.optional(),
  expectedError: z.string().min(1).max(2048).refine(nonBlank, "must not be blank").optional(),
}).strict().superRefine((test, context) => {
  if (test.expected === undefined && test.expectedError === undefined) {
    context.addIssue({ code: "custom", message: "a skill test requires expected or expectedError" });
  }
});
const skillContentSchema = z.object({
  kind: z.literal("skill"),
  description: z.string().min(1).max(4096).refine(nonBlank, "must not be blank"),
  source: z.string().min(1).max(MAX_REFINEMENT_TEXT_BYTES).refine(nonBlank, "must not be blank"),
  inputSchema: jsonValueSchema.optional(),
  permissions: z.array(z.string().min(1).max(128).refine(nonBlank, "must not be blank")).max(32),
  tests: z.array(skillTestSchema).min(1).max(MAX_REFINEMENT_SKILL_TESTS),
  runtime: z.literal("bun"),
  compatibility: z.string().min(1).max(256).refine(nonBlank, "must not be blank").optional(),
}).strict().superRefine((skill, context) => {
  if (skill.permissions.some((permission) => forbiddenPermission.test(permission))) {
    context.addIssue({ code: "custom", message: "a skill cannot expand immutable permission or safety policy", path: ["permissions"] });
  }
  if (new Set(skill.permissions).size !== skill.permissions.length) {
    context.addIssue({ code: "custom", message: "duplicate permissions are not allowed", path: ["permissions"] });
  }
  if (skill.inputSchema !== undefined) {
    for (const issue of jsonSchemaIssues(skill.inputSchema, "inputSchema")) context.addIssue({ code: "custom", message: issue, path: ["inputSchema"] });
  }
});
const modelConfigurationSchema = z.object({
  provider: z.string().min(1).max(128).refine(nonBlank, "must not be blank"),
  model: z.string().min(1).max(256).refine(nonBlank, "must not be blank"),
  temperature: z.number().finite().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().max(10_000_000).optional(),
  reasoningEffort: z.enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"]),
}).strict();
const budgetLimitsSchema = z.object({
  tokenLimit: z.number().finite().nonnegative().optional(),
  costLimitUsd: z.number().finite().nonnegative().optional(),
  turnLimit: z.number().finite().nonnegative().optional(),
  wallTimeLimitMs: z.number().finite().nonnegative().optional(),
}).strict();
const subagentSpecContentSchema = z.object({
  kind: z.literal("subagent_spec"),
  role: z.string().min(1).max(4096).refine(nonBlank, "must not be blank"),
  invocationCriteria: z.string().min(1).max(4096).refine(nonBlank, "must not be blank"),
  expectedArtifact: z.string().min(1).max(4096).refine(nonBlank, "must not be blank"),
  prompt: z.string().min(1).max(MAX_REFINEMENT_TEXT_BYTES).refine(nonBlank, "must not be blank"),
  model: modelConfigurationSchema.optional(),
  budget: budgetLimitsSchema.optional(),
  completionCriteria: z.string().min(1).max(4096).refine(nonBlank, "must not be blank").optional(),
}).strict();
const harnessContentSchema = z.discriminatedUnion("kind", [
  memoryContentSchema,
  promptNoteContentSchema,
  skillContentSchema,
  subagentSpecContentSchema,
]);

const createEditSchema = z.object({
  operation: z.literal("create"),
  kind: z.enum(harnessKinds),
  scope: z.enum(harnessScopes),
  scopeKey: boundedId.optional(),
  name: boundedName,
  content: harnessContentSchema,
  ...optionalEditMetadata,
}).strict().superRefine((edit, context) => {
  if (edit.kind !== edit.content.kind) context.addIssue({ code: "custom", message: "content kind must match edit kind", path: ["content", "kind"] });
});
const replaceEditSchema = z.object({
  operation: z.literal("replace"),
  entryId: boundedId,
  expectedVersionId: boundedId,
  name: boundedName.optional(),
  content: harnessContentSchema,
  ...optionalEditMetadata,
}).strict();
const retireEditSchema = z.object({
  operation: z.literal("retire"),
  entryId: boundedId,
  expectedVersionId: boundedId,
  evidenceEventIds: stringList(MAX_REFINEMENT_EVIDENCE_IDS).optional(),
  reason: z.string().min(1).max(MAX_REFINEMENT_REASON_BYTES).refine(nonBlank, "must not be blank").optional(),
}).strict();
const harnessEditSchema = z.union([createEditSchema, replaceEditSchema, retireEditSchema]);

export const objectiveEvaluationSchema = z.object({
  kind: z.literal("objective"),
  name: boundedName,
  metric: z.string().min(1).max(512).refine(nonBlank, "must not be blank"),
  target: jsonValueSchema,
  baseline: jsonValueSchema.optional(),
  testCommand: z.string().min(1).max(4096).refine(nonBlank, "must not be blank").optional(),
}).strict();

const responseHeader = {
  protocol: z.literal(REFINEMENT_REVIEW_PROTOCOL),
  version: z.literal(REFINEMENT_REVIEW_VERSION),
  reviewId: boundedId,
};
const noChangeSchema = z.object({
  ...responseHeader,
  status: z.literal("no_change"),
  reason: z.string().min(1).max(MAX_REFINEMENT_REASON_BYTES).refine(nonBlank, "must not be blank"),
  evidenceEventIds: stringList(MAX_REFINEMENT_EVIDENCE_IDS),
}).strict();
const proposeSchema = z.object({
  ...responseHeader,
  status: z.literal("propose"),
  trigger: z.string().min(1).max(MAX_REFINEMENT_TRIGGER_BYTES).refine(nonBlank, "must not be blank"),
  predictedEffect: z.string().min(1).max(MAX_REFINEMENT_PREDICTED_EFFECT_BYTES).refine(nonBlank, "must not be blank"),
  edits: z.array(harnessEditSchema).min(1).max(MAX_REFINEMENT_EDITS),
  evidenceEventIds: stringList(MAX_REFINEMENT_EVIDENCE_IDS).min(1),
  evaluation: objectiveEvaluationSchema,
}).strict();

/** Strict authoritative-response schema. It deliberately admits one decision only. */
export const refinementReviewResponseSchema = z.union([noChangeSchema, proposeSchema]);

export interface RefinementTriggerSeed {
  readonly kind: RefinementTriggerKind;
  readonly summary: string;
  readonly evidenceEventIds: readonly string[];
}
export interface RefinementReviewTrigger extends RefinementTriggerSeed {
  readonly triggerId: string;
  readonly fingerprint: string;
}
export interface RefinementEditableTarget {
  readonly entryId: string;
  readonly currentVersionId: string;
  readonly kind: HarnessKind;
  readonly scope: HarnessScope;
  readonly scopeKey: string;
  readonly name: string;
}
export interface CreateRefinementReviewRequest {
  readonly mode: RefinementReviewMode;
  readonly sessionId: string;
  readonly branchId: string;
  readonly requestedScope: HarnessScope;
  readonly requestedScopeKey?: string;
  readonly allowedKinds: readonly HarnessKind[];
  readonly visibleSourceEventIds: readonly string[];
  readonly editableTargets: readonly RefinementEditableTarget[];
  readonly trigger: RefinementTriggerSeed;
  readonly instructions?: string;
}
export interface RefinementReviewRequest extends Omit<CreateRefinementReviewRequest, "trigger"> {
  readonly protocol: typeof REFINEMENT_REVIEW_PROTOCOL;
  readonly version: typeof REFINEMENT_REVIEW_VERSION;
  readonly reviewId: string;
  readonly fingerprint: string;
  readonly trigger: RefinementReviewTrigger;
}

export interface RefinementReviewNoChange {
  readonly protocol: typeof REFINEMENT_REVIEW_PROTOCOL;
  readonly version: typeof REFINEMENT_REVIEW_VERSION;
  readonly reviewId: string;
  readonly status: "no_change";
  readonly reason: string;
  readonly evidenceEventIds: readonly string[];
}
export interface RefinementReviewPropose {
  readonly protocol: typeof REFINEMENT_REVIEW_PROTOCOL;
  readonly version: typeof REFINEMENT_REVIEW_VERSION;
  readonly reviewId: string;
  readonly status: "propose";
  readonly trigger: string;
  readonly predictedEffect: string;
  readonly edits: readonly HarnessEdit[];
  readonly evidenceEventIds: readonly string[];
  readonly evaluation: ObjectiveEvaluation;
}
export type RefinementReviewDecision = RefinementReviewNoChange | RefinementReviewPropose;
export type ValidatedRefinementReview =
  | (RefinementReviewNoChange & { readonly decisionFingerprint: string })
  | (RefinementReviewPropose & { readonly decisionFingerprint: string; readonly proposalId: string; readonly proposalFingerprint: string });

export interface RefinementSensitiveValues {
  /** Exact credential values brokered outside model-visible state. Values shorter than four bytes are ignored. */
  readonly brokeredCredentialValues?: readonly string[];
}

export const REFINEMENT_REVIEW_POLICY = [
  "Call the required refinement-review submission tool exactly once.",
  `Submit one decision matching ${REFINEMENT_REVIEW_PROTOCOL} version ${REFINEMENT_REVIEW_VERSION}.`,
  "Submit status=no_change or one status=propose decision; never submit multiple proposals.",
  "Follow the tool schema's explicit presence and lossless JSON-value encodings exactly.",
  "A proposal must cite only source event IDs visible in the review request and must remain within requestedScope and allowedKinds.",
  "Address the exact retained trigger and manual instructions; do not substitute a smaller but neighboring problem merely because it is easier to encode.",
  "Choose the harness artifact by mechanism: memory retains a durable fact, preference, decision, observation, or constraint; prompt_note corrects a repeated behavioral tendency; skill packages a reusable deterministic operation with executable tests; subagent_spec packages a recurring delegated role with bounded completion criteria.",
  "Repository-specific source organization, maintainability, or product behavior belongs in ordinary repository work, not a behavioral harness artifact. A new runtime primitive or unavailable dependency requires ordinary runtime implementation. Return no_change with that boundary when no allowed harness kind directly implements the requested improvement.",
  "For repeated failures, propose a bounded investment only when the evidence supports a recurring mechanism; do not silently broaden the user's original task or turn one incidental error into standing behavior.",
  "The trigger, predicted effect, selected kind, content, evidence, and objective evaluation must form one direct causal chain. A generic instruction to try harder, follow through, or avoid mistakes is not a substitute for the capability or behavior identified by the evidence.",
  "Replace or retire only an editable target and use its exact currentVersionId as expectedVersionId.",
  "Never include credentials, brokered secret values, or instructions that change the immutable base policy or permission boundary.",
].join(" ");

/**
 * Constructs the canonical bounded review request and derives a stable identity.
 * Brokered credential values are scrubbed before anything can become model-visible.
 */
export function createRefinementReviewRequest(
  input: CreateRefinementReviewRequest,
  sensitive: RefinementSensitiveValues = {},
): RefinementReviewRequest {
  assertRequestCollectionBounds(input);
  const scrub = (value: string) => scrubRefinementReviewText(value, sensitive.brokeredCredentialValues ?? []);
  const canonicalInput: CreateRefinementReviewRequest = {
    mode: input.mode,
    sessionId: input.sessionId,
    branchId: input.branchId,
    requestedScope: input.requestedScope,
    ...(input.requestedScopeKey === undefined ? {} : { requestedScopeKey: input.requestedScopeKey }),
    allowedKinds: sortedUnique(input.allowedKinds),
    visibleSourceEventIds: sortedUnique(input.visibleSourceEventIds),
    editableTargets: input.editableTargets.map((target) => ({
      entryId: target.entryId,
      currentVersionId: target.currentVersionId,
      kind: target.kind,
      scope: target.scope,
      scopeKey: target.scopeKey,
      name: target.name,
    })).sort((left, right) => left.entryId.localeCompare(right.entryId)),
    trigger: {
      kind: input.trigger.kind,
      summary: scrub(input.trigger.summary),
      evidenceEventIds: sortedUnique(input.trigger.evidenceEventIds),
    },
    ...(input.instructions === undefined ? {} : { instructions: scrub(input.instructions) }),
  };
  assertRequest(canonicalInput, sensitive);
  const trigger = createRefinementReviewTrigger(canonicalInput.trigger);
  const fingerprint = refinementReviewFingerprint({ ...canonicalInput, trigger });
  return {
    protocol: REFINEMENT_REVIEW_PROTOCOL,
    version: REFINEMENT_REVIEW_VERSION,
    reviewId: refinementReviewId({ ...canonicalInput, trigger }),
    fingerprint,
    ...canonicalInput,
    trigger,
  };
}

export function createRefinementReviewTrigger(seed: RefinementTriggerSeed): RefinementReviewTrigger {
  assertTrigger(seed);
  const normalized: RefinementTriggerSeed = {
    kind: seed.kind,
    summary: seed.summary,
    evidenceEventIds: sortedUnique(seed.evidenceEventIds),
  };
  const fingerprint = refinementTriggerFingerprint(normalized);
  return { ...normalized, triggerId: refinementTriggerId(normalized), fingerprint };
}

export function refinementTriggerFingerprint(seed: RefinementTriggerSeed): string {
  return fingerprintOf({ kind: seed.kind, summary: seed.summary, evidenceEventIds: sortedUnique(seed.evidenceEventIds) });
}

export function refinementTriggerId(seed: RefinementTriggerSeed): string {
  return idFromFingerprint("refinement-trigger", refinementTriggerFingerprint(seed));
}

export function refinementReviewFingerprint(
  request: CreateRefinementReviewRequest | Omit<RefinementReviewRequest, "protocol" | "version" | "reviewId" | "fingerprint">,
): string {
  return fingerprintOf({
    mode: request.mode,
    sessionId: request.sessionId,
    branchId: request.branchId,
    requestedScope: request.requestedScope,
    ...(request.requestedScopeKey === undefined ? {} : { requestedScopeKey: request.requestedScopeKey }),
    allowedKinds: sortedUnique(request.allowedKinds),
    visibleSourceEventIds: sortedUnique(request.visibleSourceEventIds),
    editableTargets: [...request.editableTargets].sort((left, right) => left.entryId.localeCompare(right.entryId)),
    trigger: {
      kind: request.trigger.kind,
      summary: request.trigger.summary,
      evidenceEventIds: sortedUnique(request.trigger.evidenceEventIds),
    },
    ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
  } as unknown as JsonValue);
}

export function refinementReviewId(
  request: CreateRefinementReviewRequest | Omit<RefinementReviewRequest, "protocol" | "version" | "reviewId" | "fingerprint">,
): string {
  return idFromFingerprint("refinement-review", refinementReviewFingerprint(request));
}

export function refinementProposalFingerprint(request: RefinementReviewRequest, proposal: RefinementReviewPropose): string {
  return fingerprintOf({
    reviewId: request.reviewId,
    trigger: proposal.trigger,
    predictedEffect: proposal.predictedEffect,
    edits: proposal.edits.map(canonicalEdit),
    evidenceEventIds: sortedUnique(proposal.evidenceEventIds),
    evaluation: proposal.evaluation,
  } as unknown as JsonValue);
}

export function refinementProposalId(request: RefinementReviewRequest, proposal: RefinementReviewPropose): string {
  return idFromFingerprint("refinement-proposal", refinementProposalFingerprint(request, proposal));
}

/** Validates a reconstructed request, including all derived identities. */
export function validateRefinementReviewRequest(
  request: unknown,
  sensitive: RefinementSensitiveValues = {},
): RefinementReviewRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new ValidationError("Refinement review request must be an object");
  assertCanonicalRequest(request as RefinementReviewRequest, sensitive);
  return request as RefinementReviewRequest;
}

/** Validates one already-decoded formal refinement submission. */
export function validateRefinementReviewValue(
  value: unknown,
  request: RefinementReviewRequest,
  sensitive: RefinementSensitiveValues,
  encodedBytes: number,
): ValidatedRefinementReview {
  if (!Number.isSafeInteger(encodedBytes) || encodedBytes < 1) {
    throw new ValidationError("Refinement review encoded byte count must be a positive safe integer");
  }
  if (encodedBytes > MAX_REFINEMENT_REVIEW_BYTES) {
    throw new ValidationError(`Refinement review exceeds ${MAX_REFINEMENT_REVIEW_BYTES} bytes`);
  }
  validateRefinementReviewRequest(request, sensitive);
  assertJsonValue(value);
  const parsed = refinementReviewResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(`Refinement review does not match ${REFINEMENT_REVIEW_PROTOCOL} v${REFINEMENT_REVIEW_VERSION}`, {
      issues: parsed.error.issues,
    });
  }
  const decision = parsed.data as RefinementReviewDecision;
  if (canonicalJsonByteLength(decision as unknown as JsonValue) > encodedBytes) {
    throw new ValidationError("Refinement review encoded byte count is smaller than its canonical JSON encoding");
  }
  if (decision.reviewId !== request.reviewId) throw new ValidationError("Refinement review does not match its request reviewId");
  assertDecisionByteBounds(decision);
  assertNoCredentialMaterial(decision as unknown as JsonValue, sensitive.brokeredCredentialValues ?? [], "Refinement review");
  assertEvidenceVisible(decision.evidenceEventIds, request, "decision evidenceEventIds");
  if (decision.status === "propose") validateProposalAgainstRequest(decision, request);
  const decisionFingerprint = fingerprintOf((decision.status === "no_change"
    ? { ...decision, evidenceEventIds: sortedUnique(decision.evidenceEventIds) }
    : { ...decision, edits: decision.edits.map(canonicalEdit), evidenceEventIds: sortedUnique(decision.evidenceEventIds) }) as unknown as JsonValue);
  if (decision.status === "no_change") return { ...decision, decisionFingerprint };
  const proposalFingerprint = refinementProposalFingerprint(request, decision);
  return {
    ...decision,
    decisionFingerprint,
    proposalFingerprint,
    proposalId: idFromFingerprint("refinement-proposal", proposalFingerprint),
  };
}

/** Shared strict validator for post-activation objective evaluation intent. */
export function validateObjectiveEvaluation(value: unknown): ObjectiveEvaluation {
  assertJsonValue(value);
  const parsed = objectiveEvaluationSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError("Objective evaluation does not match its strict contract", {
      issues: parsed.error.issues,
    });
  }
  if (byteLength(canonicalJson(parsed.data.target)) > MAX_REFINEMENT_TEXT_BYTES) {
    throw new ValidationError(`Evaluation target exceeds ${MAX_REFINEMENT_TEXT_BYTES} bytes`);
  }
  if (parsed.data.baseline !== undefined &&
      byteLength(canonicalJson(parsed.data.baseline)) > MAX_REFINEMENT_TEXT_BYTES) {
    throw new ValidationError(`Evaluation baseline exceeds ${MAX_REFINEMENT_TEXT_BYTES} bytes`);
  }
  return {
    kind: parsed.data.kind,
    name: parsed.data.name,
    metric: parsed.data.metric,
    target: parsed.data.target,
    ...(parsed.data.baseline === undefined
      ? {}
      : { baseline: parsed.data.baseline }),
    ...(parsed.data.testCommand === undefined
      ? {}
      : { testCommand: parsed.data.testCommand }),
  };
}

/**
 * Pure compare-and-swap/authority validation for an individual edit. It does
 * not read storage and therefore must be given the exact visible target set.
 */
export function validateRefinementEditableTarget(
  edit: HarnessEdit,
  request: RefinementReviewRequest,
): RefinementEditableTarget | null {
  if (edit.operation === "create") return null;
  const target = request.editableTargets.find((candidate) => candidate.entryId === edit.entryId);
  if (!target) throw new ValidationError(`Harness entry is not an editable target: ${edit.entryId}`);
  if (target.currentVersionId !== edit.expectedVersionId) {
    throw new ValidationError(`Stale expectedVersionId for editable target ${edit.entryId}`);
  }
  if (target.scope !== request.requestedScope || (request.requestedScopeKey !== undefined && target.scopeKey !== request.requestedScopeKey)) {
    throw new ValidationError(`Editable target ${edit.entryId} is outside requested scope`);
  }
  if (!request.allowedKinds.includes(target.kind)) throw new ValidationError(`Editable target kind is not allowed: ${target.kind}`);
  if (edit.operation === "replace" && edit.content.kind !== target.kind) {
    throw new ValidationError(`Replacement content kind does not match editable target ${edit.entryId}`);
  }
  return target;
}

/** Deterministic longest-first exact-value scrubbing for brokered credentials. */
export function scrubRefinementReviewText(text: string, brokeredCredentialValues: readonly string[]): string {
  let result = text;
  const values = sortedUnique(brokeredCredentialValues.filter((value) => byteLength(value) >= 4))
    .sort((left, right) => byteLength(right) - byteLength(left) || left.localeCompare(right));
  for (const value of values) result = result.split(value).join("[REDACTED]");
  return result;
}

function canonicalEdit(edit: HarnessEdit): JsonValue {
  if (edit.operation === "retire") {
    return {
      operation: edit.operation,
      entryId: edit.entryId,
      expectedVersionId: edit.expectedVersionId,
      ...(edit.evidenceEventIds === undefined ? {} : { evidenceEventIds: sortedUnique(edit.evidenceEventIds) }),
      ...(edit.reason === undefined ? {} : { reason: edit.reason }),
    };
  }
  return {
    ...edit,
    ...(edit.tags === undefined ? {} : { tags: sortedUnique(edit.tags) }),
    ...(edit.evidenceEventIds === undefined ? {} : { evidenceEventIds: sortedUnique(edit.evidenceEventIds) }),
    ...(edit.conflictEntryIds === undefined ? {} : { conflictEntryIds: sortedUnique(edit.conflictEntryIds) }),
  } as unknown as JsonValue;
}

function assertDecisionByteBounds(decision: RefinementReviewDecision): void {
  if (decision.status === "no_change") {
    assertByteBound(decision.reason, MAX_REFINEMENT_REASON_BYTES, "No-change reason");
    return;
  }
  assertByteBound(decision.trigger, MAX_REFINEMENT_TRIGGER_BYTES, "Proposal trigger");
  assertByteBound(decision.predictedEffect, MAX_REFINEMENT_PREDICTED_EFFECT_BYTES, "Proposal predicted effect");
  for (const edit of decision.edits) {
    if (edit.operation === "retire") {
      if (edit.reason !== undefined) assertByteBound(edit.reason, MAX_REFINEMENT_REASON_BYTES, "Retirement reason");
      continue;
    }
    const content = edit.content;
    if (content.kind === "memory" || content.kind === "prompt_note") {
      assertByteBound(content.text, MAX_REFINEMENT_TEXT_BYTES, `${content.kind} text`);
    } else if (content.kind === "skill") {
      assertByteBound(content.source, MAX_REFINEMENT_TEXT_BYTES, "Skill source");
    } else {
      assertByteBound(content.prompt, MAX_REFINEMENT_TEXT_BYTES, "Subagent prompt");
    }
  }
}

function assertByteBound(value: string, maximum: number, label: string): void {
  if (byteLength(value) > maximum) throw new ValidationError(`${label} exceeds ${maximum} bytes`);
}

function assertRequestCollectionBounds(input: CreateRefinementReviewRequest): void {
  if (!Array.isArray(input.allowedKinds) || input.allowedKinds.length > harnessKinds.length) {
    throw new ValidationError("Refinement review allowedKinds are malformed or over the count bound");
  }
  if (!Array.isArray(input.visibleSourceEventIds) || input.visibleSourceEventIds.length > MAX_REFINEMENT_SOURCE_EVENT_IDS) {
    throw new ValidationError(`visibleSourceEventIds exceeds ${MAX_REFINEMENT_SOURCE_EVENT_IDS}`);
  }
  if (!Array.isArray(input.editableTargets) || input.editableTargets.length > MAX_REFINEMENT_EDITABLE_TARGETS) {
    throw new ValidationError(`editableTargets exceeds ${MAX_REFINEMENT_EDITABLE_TARGETS}`);
  }
  if (!input.trigger || !Array.isArray(input.trigger.evidenceEventIds) || input.trigger.evidenceEventIds.length > MAX_REFINEMENT_EVIDENCE_IDS) {
    throw new ValidationError(`trigger.evidenceEventIds exceeds ${MAX_REFINEMENT_EVIDENCE_IDS}`);
  }
}

function validateProposalAgainstRequest(proposal: RefinementReviewPropose, request: RefinementReviewRequest): void {
  assertEvidenceVisible(proposal.evidenceEventIds, request, "proposal evidenceEventIds");
  const proposalEvidence = new Set(proposal.evidenceEventIds);
  for (const triggerEvidenceId of request.trigger.evidenceEventIds) {
    if (!proposalEvidence.has(triggerEvidenceId)) throw new ValidationError(`Proposal omits trigger evidence event ${triggerEvidenceId}`);
  }
  const touched = new Set<string>();
  const createNames = new Set<string>();
  for (const edit of proposal.edits) {
    if (byteLength(canonicalJson(edit as unknown as JsonValue)) > MAX_REFINEMENT_EDIT_BYTES) {
      throw new ValidationError(`Refinement edit exceeds ${MAX_REFINEMENT_EDIT_BYTES} bytes`);
    }
    for (const eventId of edit.evidenceEventIds ?? []) {
      if (!proposalEvidence.has(eventId)) throw new ValidationError(`Edit evidence event is absent from proposal evidence: ${eventId}`);
    }
    assertEvidenceVisible(edit.evidenceEventIds ?? [], request, "edit evidenceEventIds");
    if (edit.operation === "create") {
      if (edit.scope !== request.requestedScope) throw new ValidationError(`Create edit is outside requested scope: ${edit.scope}`);
      if (edit.scopeKey !== request.requestedScopeKey) {
        throw new ValidationError("Create edit scopeKey does not match requested scope");
      }
      if (!request.allowedKinds.includes(edit.kind)) throw new ValidationError(`Create edit kind is not allowed: ${edit.kind}`);
      const key = `${edit.kind}:${edit.name}`;
      if (createNames.has(key)) throw new ValidationError(`Duplicate create edit name: ${edit.name}`);
      createNames.add(key);
      if (immutablePolicy.test(edit.name.trim())) throw new ValidationError("The immutable base policy and permission boundary cannot be edited");
    } else {
      if (touched.has(edit.entryId)) throw new ValidationError(`Multiple edits target ${edit.entryId}`);
      touched.add(edit.entryId);
      validateRefinementEditableTarget(edit, request);
      if (edit.operation === "replace" && edit.name !== undefined && immutablePolicy.test(edit.name.trim())) {
        throw new ValidationError("The immutable base policy and permission boundary cannot be edited");
      }
    }
    if (edit.operation !== "retire") {
      assertContentPolicy(edit.content);
      for (const conflictId of edit.conflictEntryIds ?? []) {
        if (!request.editableTargets.some((target) => target.entryId === conflictId)) {
          throw new ValidationError(`Conflict entry is not visible in editable targets: ${conflictId}`);
        }
      }
    }
  }
  validateObjectiveEvaluation(proposal.evaluation);
}

function assertRequest(input: CreateRefinementReviewRequest, sensitive: RefinementSensitiveValues): void {
  if (!refinementReviewModes.includes(input.mode)) throw new ValidationError("Refinement review mode is invalid");
  assertId(input.sessionId, "sessionId");
  assertId(input.branchId, "branchId");
  if (!harnessScopes.includes(input.requestedScope)) throw new ValidationError("Requested refinement scope is invalid");
  if (input.requestedScopeKey !== undefined) assertId(input.requestedScopeKey, "requestedScopeKey");
  if (input.requestedScope === "user" && input.requestedScopeKey === undefined) throw new ValidationError("User-scoped refinement requires requestedScopeKey");
  if (!Array.isArray(input.allowedKinds) || input.allowedKinds.length === 0 || input.allowedKinds.length > harnessKinds.length) {
    throw new ValidationError("A refinement review requires 1-4 allowed kinds");
  }
  if (new Set(input.allowedKinds).size !== input.allowedKinds.length || input.allowedKinds.some((kind) => !harnessKinds.includes(kind))) {
    throw new ValidationError("Refinement review allowedKinds are invalid or duplicated");
  }
  if (input.mode === "skill_creation" && (input.allowedKinds.length !== 1 || input.allowedKinds[0] !== "skill")) {
    throw new ValidationError("skill_creation reviews may only propose skills");
  }
  if (input.mode === "automatic" && (input.requestedScope === "user" || input.requestedScope === "global")) {
    throw new ValidationError("Automatic refinement cannot request user or global scope");
  }
  assertIdList(input.visibleSourceEventIds, MAX_REFINEMENT_SOURCE_EVENT_IDS, "visibleSourceEventIds");
  if (input.visibleSourceEventIds.length === 0) throw new ValidationError("A refinement review requires visible durable source events");
  if (!Array.isArray(input.editableTargets) || input.editableTargets.length > MAX_REFINEMENT_EDITABLE_TARGETS) {
    throw new ValidationError(`editableTargets exceeds ${MAX_REFINEMENT_EDITABLE_TARGETS}`);
  }
  const targetIds = new Set<string>();
  for (const target of input.editableTargets) {
    assertId(target.entryId, "editableTargets.entryId");
    assertId(target.currentVersionId, "editableTargets.currentVersionId");
    assertId(target.scopeKey, "editableTargets.scopeKey");
    if (!harnessKinds.includes(target.kind) || !harnessScopes.includes(target.scope) || !nonBlank(target.name) || byteLength(target.name) > 128) {
      throw new ValidationError("Editable target is malformed");
    }
    if (targetIds.has(target.entryId)) throw new ValidationError(`Duplicate editable target: ${target.entryId}`);
    targetIds.add(target.entryId);
    if (!input.allowedKinds.includes(target.kind)) throw new ValidationError(`Editable target kind is not allowed: ${target.kind}`);
    if (target.scope !== input.requestedScope || (input.requestedScopeKey !== undefined && target.scopeKey !== input.requestedScopeKey)) {
      throw new ValidationError(`Editable target ${target.entryId} is outside requested scope`);
    }
  }
  assertTrigger(input.trigger);
  assertEvidenceSubset(input.trigger.evidenceEventIds, input.visibleSourceEventIds, "Trigger evidence");
  if (input.mode === "manual" && input.trigger.kind !== "manual") throw new ValidationError("Manual reviews require a manual trigger");
  if (input.mode === "skill_creation" && input.trigger.kind !== "skill_creation") throw new ValidationError("skill_creation reviews require a skill_creation trigger");
  if (input.mode === "automatic" && ["manual", "skill_creation"].includes(input.trigger.kind)) throw new ValidationError("Automatic reviews require a durable automatic trigger kind");
  if (input.mode === "automatic" && input.trigger.evidenceEventIds.length === 0) throw new ValidationError("Automatic refinement requires durable trigger evidence");
  if (input.instructions !== undefined && (!nonBlank(input.instructions) || byteLength(input.instructions) > MAX_REFINEMENT_INSTRUCTIONS_BYTES)) {
    throw new ValidationError(`Refinement instructions must be non-blank and at most ${MAX_REFINEMENT_INSTRUCTIONS_BYTES} bytes`);
  }
  assertNoCredentialMaterial(input as unknown as JsonValue, sensitive.brokeredCredentialValues ?? [], "Refinement review request");
}

function assertCanonicalRequest(request: RefinementReviewRequest, sensitive: RefinementSensitiveValues): void {
  if (!request.trigger || typeof request.trigger !== "object" || !Array.isArray(request.editableTargets)) {
    throw new ValidationError("Refinement review request is missing its trigger or editable target set");
  }
  assertOnlyKeys(request as unknown as Record<string, unknown>, [
    "protocol", "version", "reviewId", "fingerprint", "mode", "sessionId", "branchId", "requestedScope",
    "requestedScopeKey", "allowedKinds", "visibleSourceEventIds", "editableTargets", "trigger", "instructions",
  ], "Refinement review request");
  assertOnlyKeys(request.trigger as unknown as Record<string, unknown>, ["kind", "summary", "evidenceEventIds", "triggerId", "fingerprint"], "Refinement trigger");
  for (const target of request.editableTargets) assertOnlyKeys(target as unknown as Record<string, unknown>, ["entryId", "currentVersionId", "kind", "scope", "scopeKey", "name"], "Editable target");
  if (request.protocol !== REFINEMENT_REVIEW_PROTOCOL || request.version !== REFINEMENT_REVIEW_VERSION) {
    throw new ValidationError(`Refinement review request must use ${REFINEMENT_REVIEW_PROTOCOL} v${REFINEMENT_REVIEW_VERSION}`);
  }
  assertRequest(request, sensitive);
  const triggerFingerprint = refinementTriggerFingerprint(request.trigger);
  if (request.trigger.fingerprint !== triggerFingerprint || request.trigger.triggerId !== refinementTriggerId(request.trigger)) {
    throw new ValidationError("Refinement trigger identity does not match its content");
  }
  const fingerprint = refinementReviewFingerprint(request);
  if (request.fingerprint !== fingerprint || request.reviewId !== refinementReviewId(request)) {
    throw new ValidationError("Refinement review identity does not match its content");
  }
}

function assertTrigger(seed: RefinementTriggerSeed): void {
  if (!refinementTriggerKinds.includes(seed.kind)) throw new ValidationError("Refinement trigger kind is invalid");
  if (!nonBlank(seed.summary) || byteLength(seed.summary) > MAX_REFINEMENT_TRIGGER_BYTES) {
    throw new ValidationError(`Refinement trigger must be non-blank and at most ${MAX_REFINEMENT_TRIGGER_BYTES} bytes`);
  }
  assertIdList(seed.evidenceEventIds, MAX_REFINEMENT_EVIDENCE_IDS, "trigger.evidenceEventIds");
}

function assertEvidenceVisible(ids: readonly string[], request: RefinementReviewRequest, label: string): void {
  assertEvidenceSubset(ids, request.visibleSourceEventIds, label);
}

function assertEvidenceSubset(ids: readonly string[], visibleIds: readonly string[], label: string): void {
  const visible = new Set(visibleIds);
  for (const id of ids) if (!visible.has(id)) throw new ValidationError(`${label} references a source event that was not visible: ${id}`);
}

function assertContentPolicy(content: HarnessContent): void {
  const policyText = content.kind === "memory" || content.kind === "prompt_note"
    ? content.text
    : content.kind === "subagent_spec" ? content.prompt : "";
  if (policyEscalation.test(policyText)) throw new ValidationError("Harness content cannot modify immutable permission, safety, or base policy");
}

function assertNoCredentialMaterial(value: JsonValue, brokeredCredentialValues: readonly string[], label: string): void {
  const secrets = brokeredCredentialValues.filter((secret) => byteLength(secret) >= 4);
  for (const text of stringLeaves(value)) {
    if (secrets.some((secret) => text.includes(secret))) {
      throw new ValidationError(`${label} contains a brokered secret value`);
    }
  }
}

function* stringLeaves(value: JsonValue): Generator<string> {
  if (typeof value === "string") { yield value; return; }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) yield* stringLeaves(item); return; }
  for (const item of Object.values(value)) yield* stringLeaves(item);
}

function jsonSchemaIssues(value: JsonValue, path: string): string[] {
  const issues: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path} must be a JSON Schema object`];
  const schema = value as Record<string, JsonValue>;
  const allowedTypes = ["object", "array", "string", "number", "integer", "boolean", "null"];
  if (schema.type !== undefined && (typeof schema.type !== "string" || !allowedTypes.includes(schema.type))) issues.push(`${path}.type is not supported`);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string"))) issues.push(`${path}.required must be string[]`);
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) issues.push(`${path}.properties must be an object`);
    else for (const [key, child] of Object.entries(schema.properties)) issues.push(...jsonSchemaIssues(child, `${path}.properties.${key}`));
  }
  if (schema.items !== undefined) issues.push(...jsonSchemaIssues(schema.items, `${path}.items`));
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) issues.push(`${path}.enum must be an array`);
  return issues;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw new ValidationError(`${label} contains unknown fields: ${unknown.sort().join(", ")}`);
}

function assertId(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || !idPattern.test(value)) throw new ValidationError(`${label} is not a bounded identifier`);
}

function assertIdList(values: readonly string[], maximum: number, label: string): void {
  if (!Array.isArray(values) || values.length > maximum) throw new ValidationError(`${label} exceeds ${maximum}`);
  const unique = new Set<string>();
  for (const value of values) {
    assertId(value, label);
    if (unique.has(value)) throw new ValidationError(`${label} contains duplicate identifiers`);
    unique.add(value);
  }
}

function nonBlank(value: string): boolean { return value.trim().length > 0; }
function byteLength(value: string): number { return encoder.encode(value).byteLength; }
function sortedUnique<T extends string>(values: readonly T[]): T[] { return [...new Set(values)].sort() as T[]; }
function idFromFingerprint(prefix: string, fingerprint: string): string { return `${prefix}-${fingerprint.slice("sha256:".length, "sha256:".length + 32)}`; }
function fingerprintOf(value: JsonValue): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonicalJson(value));
  return `sha256:${hasher.digest("hex")}`;
}
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

import { ulid } from "ulid";
import { z } from "zod";
import type { JsonValue } from "./json.ts";
import { assertJsonValue } from "./json.ts";
import { ValidationError } from "./errors.ts";
import { agentActionSchema, type AgentAction } from "./agent-action.ts";
import type { ModelConfiguration, ModelDispatch, ModelWarning } from "./model.ts";

export const EVENT_SCHEMA_VERSION = 2 as const;
export const eventTypes = [
  "SessionCreated", "BranchCreated", "SessionNamed", "BranchNamed", "SessionStatusChanged", "SessionModelChanged", "MessageAppended",
  "CellProposed", "CellStarted", "CellCommitted", "CellFailed", "CellAbandoned",
  "WorkingValueSet", "ArtifactRegistered", "EffectRequested", "EffectAttemptStarted",
  "EffectOutcomeRecorded", "EffectReconciliationRecorded", "ContextCompactionRequested", "ContextCompactionFailed",
  "ContextMaterialized", "ModelCallRequested", "ModelOutputChunk",
  "ModelCallCompleted", "ModelCallTerminated", "BudgetDebited", "BudgetExceeded", "RecoveryPerformed",
  "TaskCreated", "SubagentAdmitted", "TaskStatusChanged", "SubagentCancellationRequested", "TaskUsageAttributed",
  "MailboxMessageSent", "MailboxMessageDelivered", "MailboxMessageContextDelivered", "MailboxMessageDeliveryFailed", "MailboxMessageAcknowledged",
  "TaskTerminalNoticeSent", "TaskTerminalNoticeDelivered",
  "DocumentImported", "DocumentChunkAdded", "InputSetCreated",
  "GoalCreated", "GoalCompletionRequested", "GoalGateAdded", "GoalGateStatusChanged", "GoalGateEvaluationRecorded", "GoalStatusChanged",
  "HeartbeatCreated", "HeartbeatTicked", "HeartbeatStatusChanged",
  "ScheduleCreated", "ScheduleTicked", "ScheduleStatusChanged", "WakeQueued", "WakeClaimed", "WakeDelivered", "WakeDeliveryUnknown",
  "RecursiveModelStarted", "RecursiveModelStatusChanged",
  "HarnessVersionCreated", "HarnessVersionStatusChanged",
  "UserCorrection", "RefinementReviewRequested", "RefinementReviewChildLinked", "RefinementReviewStatusChanged", "RefinementTriggerConsumed",
  "RefinementProposed", "RefinementValidated", "RefinementCandidateActivated",
  "RefinementCandidateAllocated", "RefinementCandidateExposed", "RefinementObservationRecorded",
  "RefinementDecided", "RefinementApproved", "RefinementRollbackApproved", "RefinementRolledBack",
  "SkillImported", "SkillAvailabilityChanged", "SkillInvocationRecorded", "SkillTestRecorded", "SubagentSpecInvoked", "SyncConflictResolved",
  "AgentRunRequested", "AgentRunStepStarted", "AgentRunModelAttemptStarted", "AgentRunActionCommitted", "AgentRunActionRejected", "AgentRunGoalCheckRecorded",
  "AgentRunUserInputRequested", "AgentRunUserInputReceived", "AgentRunCancellationRequested", "AgentRunStatusChanged",
] as const;
export type EventType = (typeof eventTypes)[number];
export type Producer = "supervisor" | "console" | "model" | "executor" | "client" | "recovery" | "scheduler" | string;
export type SessionStatus = "idle" | "running" | "stopped" | "failed" | "archived";
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type EffectOutcome = "succeeded" | "failed" | "cancelled" | "unknown";
export type TaskStatus = "pending" | "admitted" | "running" | "completed" | "failed" | "cancelled";
export type MailboxMessageKind = "message" | "task_completed" | "task_failed" | "task_cancelled";
export type MailboxReceiptStatus = "queued" | "delivered_to_context" | "acknowledged" | "rejected" | "failed";
export type FamilyRelationship = "parent" | "child" | "sibling";
export type GoalStatus = "active" | "paused" | "completion_requested" | "completed" | "blocked" | "failed" | "cancelled";
export type GoalGateStatus = "pending" | "running" | "passed" | "failed" | "cancelled" | "unknown";
export type GoalGateTerminalStatus = Exclude<GoalGateStatus, "pending" | "running">;
export type HeartbeatStatus = "active" | "paused" | "cancelled";
export type AutonomyOwner = "user" | "agent";
export type ScheduleStatus = "active" | "paused" | "completed" | "cancelled";
export type WakeStatus = "queued" | "claimed" | "delivered" | "unknown";
export type AgentRunGoalMode = "none" | "auto" | "current" | "create";
export type RecursiveModelStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type RecursiveModelOutcome = "succeeded" | "failed" | "cancelled" | "budget-exceeded" | "unknown";
export type AgentRunStatus = "queued" | "running" | "waiting_for_user" | "succeeded" | "blocked" | "failed" | "cancelled" | "budget_exceeded" | "unknown";
export type AgentRunInputKind = "clarification" | "permission";
export type RefinementReviewLifecycleStatus = "requested" | "running" | "no_change" | "candidate" | "revision_required" | "failed" | "cancelled" | "unknown";
export type ContextCompactionStrategy = "deterministic-extractive-v1" | "model-summary-v1";
export type ContextCompactionReason = "user-request" | "agent-request" | "automatic-threshold" | "provider-overflow" | "rematerialize";
export type ContextCompactionRequester = "user" | "agent" | "supervisor";
export type ContextCapacitySource = "provider-metadata" | "model-catalog" | "operator-configuration" | "unknown";

export interface BudgetLimits { readonly tokenLimit?: number; readonly costLimitUsd?: number; readonly turnLimit?: number; readonly wallTimeLimitMs?: number; }
export interface Usage { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number; }
export interface ArtifactReference { readonly artifactId: string; readonly digest: string; readonly mediaType: string; readonly size: number; }
export type WorkingValue = { readonly kind: "json"; readonly value: JsonValue } | { readonly kind: "artifact"; readonly artifactId: string };
export interface ContextRecordReference { readonly eventId: string; readonly type: EventType; readonly schemaVersion: number; readonly reason?: string; }
export interface ContextCapacityProvenance {
  readonly provider: string; readonly model: string; readonly source: ContextCapacitySource;
  readonly contextWindowTokens: number | null; readonly outputReserveTokens: number;
  readonly estimatorId: string; readonly triggerRatio: number; readonly targetRatio: number;
}
export interface FrozenContextCompactionSource {
  readonly eventId: string; readonly sessionId: string; readonly branchId: string; readonly cursor: string; readonly type: "MessageAppended"; readonly schemaVersion: number;
  readonly payload: JsonValue; readonly disposition: "compactable"; readonly classificationReason: string;
  readonly payloadUtf8Bytes: number;
}
export interface ContextCompactionDerivation {
  readonly kind: "compaction"; readonly compactionId: string; readonly requestEventId: string;
  readonly strategy: ContextCompactionStrategy; readonly reason: ContextCompactionReason;
  readonly requestedBy: ContextCompactionRequester; readonly instructions?: string;
  readonly throughCursor: string; readonly sourceEventIds: string[]; readonly sourceDigest: string;
  readonly leafEventIds: string[]; readonly leafDigest: string; readonly generation: number;
  readonly summary: string; readonly effectIds?: string[]; readonly usage?: Usage;
  readonly capacity?: ContextCapacityProvenance; readonly rematerializedFromContextId?: string;
}

export interface EventPayloads {
  SessionCreated: { workspaceId: string; initialBranchId: string; model: ModelConfiguration; budget: BudgetLimits; sessionName?: string; initialBranchName?: string; parentSessionId?: string; parentBranchId?: string; rootSessionId?: string; depth?: number; taskId?: string };
  BranchCreated: { branchId: string; parentBranchId: string; forkCursor: string; name?: string };
  SessionNamed: { name: string };
  BranchNamed: { name: string };
  SessionStatusChanged: { status: SessionStatus; reason?: string };
  SessionModelChanged: { previousModel: ModelConfiguration; model: ModelConfiguration; selectedBy: "user" };
  MessageAppended: { messageId: string; role: MessageRole; content: string; modelCallId?: string; mailbox?: { mailboxMessageId: string; fromSessionId: string; relationship: FamilyRelationship; taskId?: string; artifactIds?: string[]; receiptEventId: string } };
  CellProposed: { cellId: string; code: string; dependencies: string[] };
  CellStarted: { cellId: string; attempt: number };
  CellCommitted: { cellId: string; result: JsonValue; logs: string[]; durationMs: number; exports: string[] };
  CellFailed: { cellId: string; error: string; logs: string[]; durationMs: number };
  CellAbandoned: { cellId: string; reason: string };
  WorkingValueSet: { name: string; version: number; value: WorkingValue };
  ArtifactRegistered: ArtifactReference & { sourceEventId?: string };
  EffectRequested: { effectId: string; executor: string; operation: string; input: JsonValue; idempotencyKey: string; idempotent: boolean };
  EffectAttemptStarted: { effectId: string; attempt: number };
  EffectOutcomeRecorded: { effectId: string; attempt: number; outcome: EffectOutcome; output?: JsonValue; error?: string; observedAt: string };
  EffectReconciliationRecorded: { reconciliationId: string; effectId: string; assessment: "succeeded" | "failed" | "no_effect" | "still_unknown"; summary: string; evidence?: JsonValue; recordedBy: string; recordedAt: string };
  ContextCompactionRequested: {
    compactionId: string; strategy: ContextCompactionStrategy; reason: ContextCompactionReason;
    requestedBy: ContextCompactionRequester; instructions?: string; throughCursor: string;
    sourceEventIds: string[]; sourceDigest: string; frozenSources: FrozenContextCompactionSource[];
    capacity?: ContextCapacityProvenance; ancestorContextId?: string; rematerializedFromContextId?: string;
    modelDispatch?: ModelDispatch;
  };
  ContextCompactionFailed: {
    compactionId: string; requestEventId: string; strategy: ContextCompactionStrategy;
    outcome: "failed" | "unknown" | "protected-only" | "no-progress"; error: string; effectId?: string;
  };
  ContextMaterialized: { contextId: string; records: ContextRecordReference[]; contentHash: string; context: JsonValue; harnessProvenance?: JsonValue; derivation?: ContextCompactionDerivation };
  ModelCallRequested: { callId: string; contextId: string; effectId: string; modelDispatch: ModelDispatch; attempt?: number; retryOfCallId?: string; contextWindow?: ContextCapacityProvenance };
  ModelOutputChunk: { callId: string; sequence: number; text: string };
  ModelCallCompleted: { callId: string; responseMessageId?: string; finishReason: string; usage: Usage; warnings?: ModelWarning[] };
  ModelCallTerminated: { callId: string; outcome: Exclude<EffectOutcome, "succeeded">; error?: string };
  BudgetDebited: { callId: string; tokens: number; costUsd: number; turns: number; wallTimeMs: number };
  BudgetExceeded: { dimension: "tokens" | "cost" | "turns" | "wallTime"; limit: number; spent: number };
  RecoveryPerformed: { abandonedCellIds: string[]; unknownEffectIds: string[]; retriedEffectIds: string[] };
  TaskCreated: { taskId: string; parentSessionId: string; parentBranchId: string; childSessionId: string; childBranchId: string; task: string; completionCriteria?: string; model: ModelConfiguration; budget: BudgetLimits };
  SubagentAdmitted: { taskId: string; childSessionId: string; childBranchId: string; admittedAt: string };
  TaskStatusChanged: { taskId: string; status: Exclude<TaskStatus, "pending">; result?: JsonValue; artifactIds?: string[]; error?: string; reason?: string };
  SubagentCancellationRequested: { taskId: string; childSessionId: string; reason?: string };
  TaskUsageAttributed: { taskId: string; childSessionId: string; tokens: number; costUsd: number; turns: number; wallTimeMs: number; conservative: boolean };
  MailboxMessageSent: { mailboxMessageId: string; fromSessionId: string; fromBranchId: string; toSessionId: string; toBranchId: string; kind: MailboxMessageKind; content: string; taskId?: string; artifactIds?: string[]; intentKey?: string; followUp?: boolean; replyToMessageId?: string };
  MailboxMessageDelivered: { mailboxMessageId: string; sentEventId: string; fromSessionId: string; fromBranchId: string; toSessionId: string; toBranchId: string; kind: MailboxMessageKind; content: string; taskId?: string; artifactIds?: string[]; intentKey?: string; followUp?: boolean; replyToMessageId?: string; senderRelationship?: FamilyRelationship };
  MailboxMessageContextDelivered: { mailboxMessageId: string; messageEventId: string; deliveredAt: string; relationship: FamilyRelationship; runId?: string };
  MailboxMessageDeliveryFailed: { mailboxMessageId: string; failedAt: string; error: string };
  MailboxMessageAcknowledged: { mailboxMessageId: string; acknowledgedBySessionId: string; acknowledgedAt: string };
  TaskTerminalNoticeSent: { noticeId: string; taskId: string; parentSessionId: string; childSessionId: string; status: "completed" | "failed" | "cancelled"; result?: JsonValue; artifactIds?: string[]; error?: string; reason?: string };
  TaskTerminalNoticeDelivered: { noticeId: string; sentEventId: string; taskId: string; parentSessionId: string; childSessionId: string; status: "completed" | "failed" | "cancelled"; result?: JsonValue; artifactIds?: string[]; error?: string; reason?: string };
  DocumentImported: { documentId: string; name: string; mediaType: string; size: number; digest: string; chunkCount: number };
  DocumentChunkAdded: { documentId: string; chunkId: string; ordinal: number; content: string; size: number; digest: string };
  InputSetCreated: { inputSetId: string; name?: string; chunkIds: string[]; metadata?: JsonValue };
  GoalCreated: { goalId: string; description: string; completionCriteria?: string; maxTurns?: number; owner?: "user" };
  GoalCompletionRequested: { goalId: string; requestId: string; workspaceId?: string; workspaceCursor?: string | null; materialVersion?: string; materialEventIds?: string[] };
  GoalGateAdded: { goalId: string; gateId: string; name: string; executor: string; operation: string; input: JsonValue; idempotent: boolean; required: boolean };
  GoalGateStatusChanged: { goalId: string; gateId: string; status: GoalGateStatus; effectId?: string; output?: JsonValue; error?: string };
  GoalGateEvaluationRecorded: { evaluationId: string; goalId: string; gateId: string; requestId: string; definitionHash: string; materialVersion: string; materialEventIds: string[]; status: GoalGateTerminalStatus; effectId?: string; output?: JsonValue; error?: string; cachedFromEvaluationId?: string };
  GoalStatusChanged: { goalId: string; status: GoalStatus; reason?: string };
  HeartbeatCreated: { heartbeatId: string; intervalMs: number; nextTickAt: string; goalId?: string; prompt?: string; payload?: JsonValue; owner?: AutonomyOwner };
  HeartbeatTicked: { heartbeatId: string; tick: number; scheduledAt: string; firedAt: string; nextTickAt: string; missedIntervals?: number; wakeId?: string };
  HeartbeatStatusChanged: { heartbeatId: string; status: HeartbeatStatus; nextTickAt?: string; reason?: string };
  ScheduleCreated: { scheduleId: string; kind: "once" | "interval"; prompt: string; nextTickAt: string; intervalMs?: number; owner: AutonomyOwner; goalMode: Exclude<AgentRunGoalMode, "none"> };
  ScheduleTicked: { scheduleId: string; tick: number; scheduledAt: string; firedAt: string; nextTickAt: string | null; missedIntervals: number; wakeId: string };
  ScheduleStatusChanged: { scheduleId: string; status: ScheduleStatus; nextTickAt?: string; reason?: string };
  WakeQueued: { wakeId: string; sourceType: "heartbeat" | "schedule"; sourceId: string; tick: number; scheduledAt: string; firedAt: string; prompt: string; goalId?: string; goalMode: AgentRunGoalMode };
  WakeClaimed: { wakeId: string; claimId: string; claimedAt: string };
  WakeDelivered: { wakeId: string; claimId: string; runId: string; deliveredAt: string };
  WakeDeliveryUnknown: { wakeId: string; claimId: string; reason: string; observedAt: string };
  RecursiveModelStarted: { handleId: string; taskId: string; parentSessionId: string; parentBranchId: string; childSessionId: string; childBranchId: string; model: ModelConfiguration; inputSetId?: string; input?: JsonValue; inputProvenance?: JsonValue; inputHash?: string };
  RecursiveModelStatusChanged: { handleId: string; status: Exclude<RecursiveModelStatus, "pending">; outcome?: RecursiveModelOutcome; resultMessageId?: string; result?: JsonValue; resultArtifactId?: string; error?: string };
  HarnessVersionCreated: { entryId: string; versionId: string; version: number; kind: "memory" | "prompt_note" | "skill" | "subagent_spec"; scope: "local" | "workspace" | "user" | "global"; scopeKey: string; name: string; content: JsonValue; tags: string[]; confidence: number; status: "candidate" | "active" | "retired" | "rejected" | "rolled_back"; evidenceEventIds: string[]; conflictEntryIds: string[]; supersedesVersionId?: string; proposalId?: string; createdBy: string; lastConfirmedAt: string };
  HarnessVersionStatusChanged: { entryId: string; versionId: string; status: "candidate" | "active" | "retired" | "rejected" | "rolled_back"; reason: string; proposalId?: string };
  UserCorrection: { correctionId: string; correctedEventIds: string[]; correction: string };
  RefinementReviewRequested: { reviewId: string; fingerprint: string; mode: "manual" | "automatic" | "skill_creation"; requestedScope: "local" | "workspace" | "user" | "global"; requestedScopeKey: string; allowedKinds: ("memory" | "prompt_note" | "skill" | "subagent_spec")[]; triggerId: string; triggerKind: "manual" | "repeated_effect_failure" | "repeated_gate_failure" | "explicit_user_correction" | "repeated_success" | "stale_memory" | "unproductive_delegation" | "skill_creation"; triggerFingerprint: string; triggerKey?: string; nonterminalKey?: string; triggerEvidenceThroughCursor?: string; evidenceEventIds: string[]; sourceEventIds: string[]; sourceSnapshotHash: string; sourceThroughCursor: string; instructions?: string; request: JsonValue; snapshot?: JsonValue };
  RefinementReviewChildLinked: { reviewId: string; handleId: string; childSessionId: string; childBranchId: string };
  RefinementReviewStatusChanged: { reviewId: string; status: Exclude<RefinementReviewLifecycleStatus, "requested">; expectedStatus: RefinementReviewLifecycleStatus; decisionFingerprint?: string; proposalId?: string; reason?: string };
  RefinementTriggerConsumed: { reviewId: string; triggerKey: string; evidenceThroughCursor: string };
  RefinementProposed: { proposalId: string; trigger: string; predictedEffect: string; edits: JsonValue; evidenceEventIds: string[]; evaluation: JsonValue; authority: "agent" | "user" | "system"; sourceReviewId?: string; proposalFingerprint?: string };
  RefinementValidated: { proposalId: string; valid: boolean; validation: JsonValue; expectedProposalStatus: "proposed" };
  RefinementCandidateActivated: { proposalId: string; candidateId: string; versionIds: string[]; allocationLimit: number; exposureLimit: number };
  RefinementCandidateAllocated: { proposalId: string; candidateId: string; allocationId: string; targetSessionId: string; targetBranchId: string; taskId?: string; ordinal: number };
  RefinementCandidateExposed: { proposalId: string; candidateId: string; allocationId: string; exposedVersionIds: string[] };
  RefinementObservationRecorded: { proposalId: string; candidateId: string; allocationId: string; observationId: string; evaluator: string; objective: boolean; success: boolean; metric: JsonValue; baseline?: JsonValue; evidenceEventIds: string[]; notes?: string };
  RefinementDecided: { proposalId: string; candidateId: string; decisionId: string; decision: "promote" | "revise" | "reject"; rule: string; evaluator: string; baseline?: JsonValue; observationIds: string[] };
  RefinementApproved: { proposalId: string; approvedBy: string; scope: "user" | "global"; note?: string };
  RefinementRollbackApproved: { proposalId: string; approvedBy: string; role: "owner" | "admin"; note?: string };
  RefinementRolledBack: { proposalId: string; candidateId: string; rollbackId: string; versionIds: string[]; restoredVersionIds: string[]; reason: string };
  SkillImported: { entryId: string; versionId: string; digest: string; scope: "workspace"; origin: { kind: "local-directory"; reference: string; manifestDigest: string; sourceDigest: string }; installedBy: string };
  SkillAvailabilityChanged: { entryId: string; versionId: string; digest: string; availability: "enabled" | "disabled" | "removed"; reason: string; expectedAvailability?: "enabled" | "disabled" | "removed"; expectedPreviousActionSequence?: number | null };
  SkillInvocationRecorded: { entryId: string; versionId: string; effectId: string; input: JsonValue };
  SkillTestRecorded: { entryId: string; versionId: string; effectId: string; passed: boolean; report: JsonValue };
  SubagentSpecInvoked: { entryId: string; versionId: string; taskId: string; childSessionId: string; childBranchId: string };
  SyncConflictResolved: { conflictId: string; action: "keep-branches" | "choose-claim" | "cancel-duplicate" | "acknowledge"; resolvedBy: string; chosenEventId?: string; note?: string; resolvedAt: string };
  AgentRunRequested: { runId: string; task: string; requestKey: string; goalId?: string; goalMode?: AgentRunGoalMode; wakeId?: string };
  AgentRunStepStarted: { runId: string; stepId: string; ordinal: number; contextId: string; callId: string; effectId: string; actionId: string; observationEventIds: string[] };
  AgentRunModelAttemptStarted: { runId: string; stepId: string; ordinal: number; attempt: number; contextId: string; callId: string; effectId: string; reason: "initial" | "proactive-compaction" | "provider-overflow"; estimatedInputTokens: number; contextWindow: ContextCapacityProvenance; retryOfCallId?: string };
  AgentRunActionCommitted: { runId: string; stepId: string; ordinal: number; actionId: string; callId: string; raw: string; action: AgentAction };
  AgentRunActionRejected: { runId: string; stepId: string; ordinal: number; actionId: string; callId: string; raw: string; error: string };
  AgentRunGoalCheckRecorded: { runId: string; actionId: string; goalId: string; requestId: string; status: "passed" | "failed" | "unknown"; summary: string; gateEvaluationEventIds: string[] };
  AgentRunUserInputRequested: { runId: string; requestId: string; actionId: string; kind: AgentRunInputKind; question: string; permission?: string };
  AgentRunUserInputReceived: { runId: string; requestId: string; response: string; approved?: boolean };
  AgentRunCancellationRequested: { runId: string; reason?: string };
  AgentRunStatusChanged: { runId: string; status: Exclude<AgentRunStatus, "queued" | "running">; reason?: string; finalMessageId?: string };
}

export interface AgentEvent<T extends EventType = EventType> {
  readonly cursor: string; readonly id: string; readonly sessionId: string; readonly branchId: string;
  readonly causationId: string | null; readonly correlationId: string | null; readonly type: T;
  readonly schemaVersion: number; readonly committedAt: string; readonly producer: Producer;
  readonly idempotencyKey: string | null; readonly payload: EventPayloads[T];
  /** Globally stable writer identity and monotonic writer sequence used by replication. */
  readonly originDeviceId: string;
  readonly originSequence: number;
  /** Previous event in the writer's source branch, independent of this database's cursor. */
  readonly streamParentId: string | null;
}
export interface NewAgentEvent<T extends EventType = EventType> {
  readonly id?: string; readonly sessionId: string; readonly branchId: string;
  readonly causationId?: string | null; readonly correlationId?: string | null; readonly type: T;
  readonly schemaVersion?: number; readonly committedAt?: string; readonly producer: Producer;
  readonly idempotencyKey?: string | null; readonly payload: EventPayloads[T];
  /** Reserved for verified replicated-envelope ingestion. Ordinary commands omit these fields. */
  readonly originDeviceId?: string;
  readonly originSequence?: number;
  readonly streamParentId?: string | null;
}
const headerSchema = z.object({ sessionId: z.string().min(1), branchId: z.string().min(1), type: z.enum(eventTypes), producer: z.string().min(1), schemaVersion: z.number().int().positive().optional() });
const id = z.string().min(1);
const nonnegative = z.number().finite().nonnegative();
const positiveInteger = z.number().int().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const dateTime = z.string().datetime();
const jsonValueSchema = z.custom<JsonValue>((value) => { try { assertJsonValue(value); return true; } catch { return false; } }, "Expected a JSON value");
const budgetSchema = z.object({ tokenLimit: nonnegative.optional(), costLimitUsd: nonnegative.optional(), turnLimit: nonnegative.optional(), wallTimeLimitMs: nonnegative.optional() });
const reasoningEffortSchema = z.enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"]);
const modelSchema = z.object({ provider: id, model: id, temperature: z.number().finite().optional(), maxOutputTokens: nonnegative.optional(), reasoningEffort: reasoningEffortSchema }).strict();
const reasoningLevelSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
const modelReasoningCapabilitySchema = z.object({
  status: z.enum(["listed", "unverified", "unsupported"]),
  levels: z.array(reasoningLevelSchema).max(6),
  catalogDigest: digest,
}).strict();
const modelDispatchSchema = z.object({
  configuration: modelSchema,
  reasoning: z.object({
    requestedEffort: reasoningEffortSchema,
    mode: z.enum(["omitted", "requested"]),
    capability: modelReasoningCapabilitySchema,
    resolverId: z.literal("agencity.reasoning-dispatch.v1"),
  }).strict(),
  executionEndpointId: digest.optional(),
  dispatchVersion: z.literal("agencity.model-dispatch.v1"),
}).strict().superRefine((value, context) => {
  if (value.configuration.reasoningEffort !== value.reasoning.requestedEffort) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "dispatch effort must match configuration" });
  }
  const expectedMode = value.configuration.reasoningEffort === "provider-default" ? "omitted" : "requested";
  if (value.reasoning.mode !== expectedMode) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "dispatch mode must match requested effort" });
  }
  if (value.reasoning.capability.status === "unsupported" && value.configuration.reasoningEffort !== "provider-default") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "unsupported models permit only provider-default" });
  }
  if (value.reasoning.capability.status === "listed" &&
      value.configuration.reasoningEffort !== "provider-default" &&
      !value.reasoning.capability.levels.includes(value.configuration.reasoningEffort)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "requested effort is not listed for this model" });
  }
});
const boundedWarningMessage = z.string().min(1).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 1_024,
  "warning message exceeds 1024 UTF-8 bytes",
);
const modelWarningSchema = z.object({
  kind: z.enum(["coerced", "unsupported", "provider", "truncated"]),
  message: boundedWarningMessage,
}).strict();
const usageSchema = z.object({ inputTokens: nonnegative, outputTokens: nonnegative, costUsd: nonnegative });
const artifactSchema = z.object({ artifactId: id, digest, mediaType: id, size: nonnegative });
const workingValueSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("json"), value: jsonValueSchema }), z.object({ kind: z.literal("artifact"), artifactId: id })]);
const taskTerminalSchema = z.object({ noticeId: id, taskId: id, parentSessionId: id, childSessionId: id, status: z.enum(["completed", "failed", "cancelled"]), result: jsonValueSchema.optional(), artifactIds: z.array(id).optional(), error: z.string().optional(), reason: z.string().optional() });
const mailboxBaseSchema = z.object({ mailboxMessageId: id, fromSessionId: id, fromBranchId: id, toSessionId: id, toBranchId: id, kind: z.enum(["message", "task_completed", "task_failed", "task_cancelled"]), content: z.string(), taskId: id.optional(), artifactIds: z.array(id).max(8).optional(), intentKey: id.optional(), followUp: z.boolean().optional(), replyToMessageId: id.optional() });
const compactionStrategySchema = z.enum(["deterministic-extractive-v1", "model-summary-v1"]);
const compactionReasonSchema = z.enum(["user-request", "agent-request", "automatic-threshold", "provider-overflow", "rematerialize"]);
const capacityProvenanceSchema = z.object({
  provider: id, model: id, source: z.enum(["provider-metadata", "model-catalog", "operator-configuration", "unknown"]),
  contextWindowTokens: positiveInteger.nullable(), outputReserveTokens: z.number().int().nonnegative(),
  estimatorId: id, triggerRatio: z.number().finite().positive().max(1), targetRatio: z.number().finite().nonnegative().max(1),
}).strict().refine((value) => value.targetRatio < value.triggerRatio, "targetRatio must be below triggerRatio")
  .refine((value) => value.contextWindowTokens === null || value.outputReserveTokens < value.contextWindowTokens, "output reserve must be below capacity");
const frozenCompactionSourceSchema = z.object({
  eventId: id, sessionId: id, branchId: id, cursor: z.string().regex(/^(?:0|[1-9][0-9]*)$/), type: z.literal("MessageAppended"), schemaVersion: positiveInteger,
  payload: z.object({ messageId: id, role: z.enum(["system", "user", "assistant", "tool"]), content: z.string(), modelCallId: id.optional(), mailbox: z.object({ mailboxMessageId: id, fromSessionId: id, relationship: z.enum(["parent", "child", "sibling"]), taskId: id.optional(), artifactIds: z.array(id).optional(), receiptEventId: id }).optional() }).strict(), disposition: z.literal("compactable"), classificationReason: z.string().min(1),
  payloadUtf8Bytes: z.number().int().nonnegative(),
}).strict();
const compactionDerivationSchema = z.object({
  kind: z.literal("compaction"), compactionId: id, requestEventId: id, strategy: compactionStrategySchema,
  reason: compactionReasonSchema, requestedBy: z.enum(["user", "agent", "supervisor"]), instructions: z.string().max(8192).optional(),
  throughCursor: z.string().regex(/^(?:0|[1-9][0-9]*)$/), sourceEventIds: z.array(id).min(1), sourceDigest: digest,
  leafEventIds: z.array(id).min(1), leafDigest: digest, generation: positiveInteger, summary: z.string().min(1).max(1048576),
  effectIds: z.array(id).optional(), usage: usageSchema.optional(), capacity: capacityProvenanceSchema.optional(), rematerializedFromContextId: id.optional(),
}).strict();
const payloadSchemas: Record<EventType, z.ZodType> = {
  SessionCreated: z.object({ workspaceId: id, initialBranchId: id, model: modelSchema, budget: budgetSchema, sessionName: z.string().min(1).optional(), initialBranchName: z.string().min(1).optional(), parentSessionId: id.optional(), parentBranchId: id.optional(), rootSessionId: id.optional(), depth: z.number().int().nonnegative().optional(), taskId: id.optional() }),
  BranchCreated: z.object({ branchId: id, parentBranchId: id, forkCursor: z.string().regex(/^\d+$/), name: z.string().optional() }),
  SessionNamed: z.object({ name: z.string().min(1) }),
  BranchNamed: z.object({ name: z.string().min(1) }),
  SessionStatusChanged: z.object({ status: z.enum(["idle", "running", "stopped", "failed", "archived"]), reason: z.string().optional() }),
  SessionModelChanged: z.object({ previousModel: modelSchema, model: modelSchema, selectedBy: z.literal("user") }).strict(),
  MessageAppended: z.object({ messageId: id, role: z.enum(["system", "user", "assistant", "tool"]), content: z.string(), modelCallId: id.optional(), mailbox: z.object({ mailboxMessageId: id, fromSessionId: id, relationship: z.enum(["parent", "child", "sibling"]), taskId: id.optional(), artifactIds: z.array(id).max(8).optional(), receiptEventId: id }).optional() }),
  CellProposed: z.object({ cellId: id, code: z.string(), dependencies: z.array(id) }),
  CellStarted: z.object({ cellId: id, attempt: positiveInteger }),
  CellCommitted: z.object({ cellId: id, result: jsonValueSchema, logs: z.array(z.string()), durationMs: nonnegative, exports: z.array(z.string()) }),
  CellFailed: z.object({ cellId: id, error: z.string(), logs: z.array(z.string()), durationMs: nonnegative }),
  CellAbandoned: z.object({ cellId: id, reason: z.string() }),
  WorkingValueSet: z.object({ name: id, version: positiveInteger, value: workingValueSchema }),
  ArtifactRegistered: artifactSchema.extend({ sourceEventId: id.optional() }),
  EffectRequested: z.object({ effectId: id, executor: id, operation: id, input: jsonValueSchema, idempotencyKey: id, idempotent: z.boolean() }),
  EffectAttemptStarted: z.object({ effectId: id, attempt: positiveInteger }),
  EffectOutcomeRecorded: z.object({ effectId: id, attempt: positiveInteger, outcome: z.enum(["succeeded", "failed", "cancelled", "unknown"]), output: jsonValueSchema.optional(), error: z.string().optional(), observedAt: dateTime }),
  EffectReconciliationRecorded: z.object({ reconciliationId: id, effectId: id, assessment: z.enum(["succeeded", "failed", "no_effect", "still_unknown"]), summary: z.string().min(1).max(16384), evidence: jsonValueSchema.optional(), recordedBy: id, recordedAt: dateTime }).strict(),
  ContextCompactionRequested: z.object({
    compactionId: id, strategy: compactionStrategySchema, reason: compactionReasonSchema,
    requestedBy: z.enum(["user", "agent", "supervisor"]), instructions: z.string().max(8192).optional(), throughCursor: z.string().regex(/^\d+$/),
    sourceEventIds: z.array(id), sourceDigest: digest, frozenSources: z.array(frozenCompactionSourceSchema),
    capacity: capacityProvenanceSchema.optional(), ancestorContextId: id.optional(), rematerializedFromContextId: id.optional(),
    modelDispatch: modelDispatchSchema.optional(),
  }).strict().superRefine((value, context) => {
    const frozenIds = value.frozenSources.map((source) => source.eventId);
    if (new Set(frozenIds).size !== frozenIds.length || frozenIds.length !== value.sourceEventIds.length || frozenIds.some((sourceId, index) => sourceId !== value.sourceEventIds[index])) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "frozen sources must exactly match sourceEventIds" });
    }
    if ((value.strategy === "model-summary-v1") !== (value.modelDispatch !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "model-summary compaction requires one pinned dispatch and deterministic compaction must omit it" });
    }
  }),
  ContextCompactionFailed: z.object({
    compactionId: id, requestEventId: id, strategy: compactionStrategySchema,
    outcome: z.enum(["failed", "unknown", "protected-only", "no-progress"]), error: z.string().min(1), effectId: id.optional(),
  }).strict(),
  ContextMaterialized: z.object({ contextId: id, records: z.array(z.object({ eventId: id, type: z.enum(eventTypes), schemaVersion: positiveInteger, reason: z.string().optional() })), contentHash: digest, context: jsonValueSchema, harnessProvenance: jsonValueSchema.optional(), derivation: compactionDerivationSchema.optional() }),
  ModelCallRequested: z.object({ callId: id, contextId: id, effectId: id, modelDispatch: modelDispatchSchema, attempt: positiveInteger.optional(), retryOfCallId: id.optional(), contextWindow: capacityProvenanceSchema.optional() }).strict(),
  ModelOutputChunk: z.object({ callId: id, sequence: z.number().int().nonnegative(), text: z.string() }),
  ModelCallCompleted: z.object({ callId: id, responseMessageId: id.optional(), finishReason: z.string(), usage: usageSchema, warnings: z.array(modelWarningSchema).max(8).optional() }).strict(),
  ModelCallTerminated: z.object({ callId: id, outcome: z.enum(["failed", "cancelled", "unknown"]), error: z.string().optional() }),
  BudgetDebited: z.object({ callId: id, tokens: nonnegative, costUsd: nonnegative, turns: nonnegative, wallTimeMs: nonnegative }),
  BudgetExceeded: z.object({ dimension: z.enum(["tokens", "cost", "turns", "wallTime"]), limit: nonnegative, spent: nonnegative }),
  RecoveryPerformed: z.object({ abandonedCellIds: z.array(id), unknownEffectIds: z.array(id), retriedEffectIds: z.array(id) }),
  TaskCreated: z.object({ taskId: id, parentSessionId: id, parentBranchId: id, childSessionId: id, childBranchId: id, task: z.string().min(1), completionCriteria: z.string().optional(), model: modelSchema, budget: budgetSchema }),
  SubagentAdmitted: z.object({ taskId: id, childSessionId: id, childBranchId: id, admittedAt: dateTime }),
  TaskStatusChanged: z.object({ taskId: id, status: z.enum(["admitted", "running", "completed", "failed", "cancelled"]), result: jsonValueSchema.optional(), artifactIds: z.array(id).optional(), error: z.string().optional(), reason: z.string().optional() }),
  SubagentCancellationRequested: z.object({ taskId: id, childSessionId: id, reason: z.string().optional() }),
  TaskUsageAttributed: z.object({ taskId: id, childSessionId: id, tokens: nonnegative, costUsd: nonnegative, turns: nonnegative, wallTimeMs: nonnegative, conservative: z.boolean() }),
  MailboxMessageSent: mailboxBaseSchema,
  MailboxMessageDelivered: mailboxBaseSchema.extend({ sentEventId: id, senderRelationship: z.enum(["parent", "child", "sibling"]).optional() }),
  MailboxMessageContextDelivered: z.object({ mailboxMessageId: id, messageEventId: id, deliveredAt: dateTime, relationship: z.enum(["parent", "child", "sibling"]), runId: id.optional() }),
  MailboxMessageDeliveryFailed: z.object({ mailboxMessageId: id, failedAt: dateTime, error: z.string().min(1) }),
  MailboxMessageAcknowledged: z.object({ mailboxMessageId: id, acknowledgedBySessionId: id, acknowledgedAt: dateTime }),
  TaskTerminalNoticeSent: taskTerminalSchema,
  TaskTerminalNoticeDelivered: taskTerminalSchema.extend({ sentEventId: id }),
  DocumentImported: z.object({ documentId: id, name: z.string().min(1), mediaType: id, size: nonnegative, digest, chunkCount: z.number().int().nonnegative() }),
  DocumentChunkAdded: z.object({ documentId: id, chunkId: id, ordinal: z.number().int().nonnegative(), content: z.string(), size: nonnegative, digest }),
  InputSetCreated: z.object({ inputSetId: id, name: z.string().optional(), chunkIds: z.array(id), metadata: jsonValueSchema.optional() }),
  GoalCreated: z.object({ goalId: id, description: z.string().min(1), completionCriteria: z.string().optional(), maxTurns: positiveInteger.optional(), owner: z.literal("user").optional() }),
  GoalCompletionRequested: z.object({ goalId: id, requestId: id, workspaceId: id.optional(), workspaceCursor: z.string().regex(/^\d+$/).nullable().optional(), materialVersion: digest.optional(), materialEventIds: z.array(id).optional() }),
  GoalGateAdded: z.object({ goalId: id, gateId: id, name: z.string().min(1), executor: id, operation: id, input: jsonValueSchema, idempotent: z.boolean(), required: z.boolean() }),
  GoalGateStatusChanged: z.object({ goalId: id, gateId: id, status: z.enum(["pending", "running", "passed", "failed", "cancelled", "unknown"]), effectId: id.optional(), output: jsonValueSchema.optional(), error: z.string().optional() }),
  GoalGateEvaluationRecorded: z.object({ evaluationId: id, goalId: id, gateId: id, requestId: id, definitionHash: digest, materialVersion: digest, materialEventIds: z.array(id), status: z.enum(["passed", "failed", "cancelled", "unknown"]), effectId: id.optional(), output: jsonValueSchema.optional(), error: z.string().optional(), cachedFromEvaluationId: id.optional() }).strict(),
  GoalStatusChanged: z.object({ goalId: id, status: z.enum(["active", "paused", "completion_requested", "completed", "blocked", "failed", "cancelled"]), reason: z.string().optional() }),
  HeartbeatCreated: z.object({ heartbeatId: id, intervalMs: positiveInteger, nextTickAt: dateTime, goalId: id.optional(), prompt: z.string().min(1).optional(), payload: jsonValueSchema.optional(), owner: z.enum(["user", "agent"]).optional() }),
  HeartbeatTicked: z.object({ heartbeatId: id, tick: positiveInteger, scheduledAt: dateTime, firedAt: dateTime, nextTickAt: dateTime, missedIntervals: z.number().int().nonnegative().optional(), wakeId: id.optional() }),
  HeartbeatStatusChanged: z.object({ heartbeatId: id, status: z.enum(["active", "paused", "cancelled"]), nextTickAt: dateTime.optional(), reason: z.string().optional() }),
  ScheduleCreated: z.object({ scheduleId: id, kind: z.enum(["once", "interval"]), prompt: z.string().min(1), nextTickAt: dateTime, intervalMs: positiveInteger.optional(), owner: z.enum(["user", "agent"]), goalMode: z.enum(["auto", "current", "create"]) }).strict(),
  ScheduleTicked: z.object({ scheduleId: id, tick: positiveInteger, scheduledAt: dateTime, firedAt: dateTime, nextTickAt: dateTime.nullable(), missedIntervals: z.number().int().nonnegative(), wakeId: id }).strict(),
  ScheduleStatusChanged: z.object({ scheduleId: id, status: z.enum(["active", "paused", "completed", "cancelled"]), nextTickAt: dateTime.optional(), reason: z.string().optional() }).strict(),
  WakeQueued: z.object({ wakeId: id, sourceType: z.enum(["heartbeat", "schedule"]), sourceId: id, tick: positiveInteger, scheduledAt: dateTime, firedAt: dateTime, prompt: z.string().min(1), goalId: id.optional(), goalMode: z.enum(["none", "auto", "current", "create"]) }).strict(),
  WakeClaimed: z.object({ wakeId: id, claimId: id, claimedAt: dateTime }).strict(),
  WakeDelivered: z.object({ wakeId: id, claimId: id, runId: id, deliveredAt: dateTime }).strict(),
  WakeDeliveryUnknown: z.object({ wakeId: id, claimId: id, reason: z.string().min(1), observedAt: dateTime }).strict(),
  RecursiveModelStarted: z.object({ handleId: id, taskId: id, parentSessionId: id, parentBranchId: id, childSessionId: id, childBranchId: id, model: modelSchema, inputSetId: id.optional(), input: jsonValueSchema.optional(), inputProvenance: jsonValueSchema.optional(), inputHash: digest.optional() }),
  RecursiveModelStatusChanged: z.object({ handleId: id, status: z.enum(["running", "completed", "failed", "cancelled"]), outcome: z.enum(["succeeded", "failed", "cancelled", "budget-exceeded", "unknown"]).optional(), resultMessageId: id.optional(), result: jsonValueSchema.optional(), resultArtifactId: id.optional(), error: z.string().optional() }),
  HarnessVersionCreated: z.object({ entryId: id, versionId: id, version: positiveInteger, kind: z.enum(["memory", "prompt_note", "skill", "subagent_spec"]), scope: z.enum(["local", "workspace", "user", "global"]), scopeKey: id, name: z.string().min(1), content: jsonValueSchema, tags: z.array(z.string()), confidence: z.number().finite().min(0).max(1), status: z.enum(["candidate", "active", "retired", "rejected", "rolled_back"]), evidenceEventIds: z.array(id), conflictEntryIds: z.array(id), supersedesVersionId: id.optional(), proposalId: id.optional(), createdBy: id, lastConfirmedAt: dateTime }),
  HarnessVersionStatusChanged: z.object({ entryId: id, versionId: id, status: z.enum(["candidate", "active", "retired", "rejected", "rolled_back"]), reason: z.string().min(1), proposalId: id.optional() }),
  UserCorrection: z.object({ correctionId: id, correctedEventIds: z.array(id).min(1).max(64), correction: z.string().min(1).max(8192) }).strict(),
  RefinementReviewRequested: z.object({ reviewId: id, fingerprint, mode: z.enum(["manual", "automatic", "skill_creation"]), requestedScope: z.enum(["local", "workspace", "user", "global"]), requestedScopeKey: id, allowedKinds: z.array(z.enum(["memory", "prompt_note", "skill", "subagent_spec"])).min(1).max(4), triggerId: id, triggerKind: z.enum(["manual", "repeated_effect_failure", "repeated_gate_failure", "explicit_user_correction", "repeated_success", "stale_memory", "unproductive_delegation", "skill_creation"]), triggerFingerprint: fingerprint, triggerKey: id.optional(), nonterminalKey: id.optional(), triggerEvidenceThroughCursor: z.string().regex(/^\d+$/).optional(), evidenceEventIds: z.array(id).max(64), sourceEventIds: z.array(id).min(1).max(256), sourceSnapshotHash: fingerprint, sourceThroughCursor: z.string().regex(/^\d+$/), instructions: z.string().max(8192).optional(), request: jsonValueSchema, snapshot: jsonValueSchema.optional() }).strict(),
  RefinementReviewChildLinked: z.object({ reviewId: id, handleId: id, childSessionId: id, childBranchId: id }).strict(),
  RefinementReviewStatusChanged: z.object({ reviewId: id, status: z.enum(["running", "no_change", "candidate", "revision_required", "failed", "cancelled", "unknown"]), expectedStatus: z.enum(["requested", "running", "no_change", "candidate", "revision_required", "failed", "cancelled", "unknown"]), decisionFingerprint: fingerprint.optional(), proposalId: id.optional(), reason: z.string().max(16384).optional() }).strict(),
  RefinementTriggerConsumed: z.object({ reviewId: id, triggerKey: id, evidenceThroughCursor: z.string().regex(/^\d+$/) }).strict(),
  RefinementProposed: z.object({ proposalId: id, trigger: z.string().min(1), predictedEffect: z.string().min(1), edits: jsonValueSchema, evidenceEventIds: z.array(id), evaluation: jsonValueSchema, authority: z.enum(["agent", "user", "system"]), sourceReviewId: id.optional(), proposalFingerprint: fingerprint.optional() }),
  RefinementValidated: z.object({ proposalId: id, valid: z.boolean(), validation: jsonValueSchema, expectedProposalStatus: z.literal("proposed") }),
  RefinementCandidateActivated: z.object({ proposalId: id, candidateId: id, versionIds: z.array(id), allocationLimit: positiveInteger, exposureLimit: positiveInteger }),
  RefinementCandidateAllocated: z.object({ proposalId: id, candidateId: id, allocationId: id, targetSessionId: id, targetBranchId: id, taskId: id.optional(), ordinal: positiveInteger }),
  RefinementCandidateExposed: z.object({ proposalId: id, candidateId: id, allocationId: id, exposedVersionIds: z.array(id) }),
  RefinementObservationRecorded: z.object({ proposalId: id, candidateId: id, allocationId: id, observationId: id, evaluator: id, objective: z.boolean(), success: z.boolean(), metric: jsonValueSchema, baseline: jsonValueSchema.optional(), evidenceEventIds: z.array(id), notes: z.string().optional() }),
  RefinementDecided: z.object({ proposalId: id, candidateId: id, decisionId: id, decision: z.enum(["promote", "revise", "reject"]), rule: z.string().min(1), evaluator: id, baseline: jsonValueSchema.optional(), observationIds: z.array(id) }),
  RefinementApproved: z.object({ proposalId: id, approvedBy: id, scope: z.enum(["user", "global"]), note: z.string().optional() }),
  RefinementRollbackApproved: z.object({ proposalId: id, approvedBy: id, role: z.enum(["owner", "admin"]), note: z.string().optional() }),
  RefinementRolledBack: z.object({ proposalId: id, candidateId: id, rollbackId: id, versionIds: z.array(id), restoredVersionIds: z.array(id), reason: z.string().min(1) }),
  SkillImported: z.object({ entryId: id, versionId: id, digest, scope: z.literal("workspace"), origin: z.object({ kind: z.literal("local-directory"), reference: z.string().min(1).max(4096), manifestDigest: digest, sourceDigest: digest }).strict(), installedBy: id }).strict(),
  SkillAvailabilityChanged: z.object({ entryId: id, versionId: id, digest, availability: z.enum(["enabled", "disabled", "removed"]), reason: z.string().min(1).max(4096), expectedAvailability: z.enum(["enabled", "disabled", "removed"]).optional(), expectedPreviousActionSequence: positiveInteger.nullable().optional() }).strict(),
  SkillInvocationRecorded: z.object({ entryId: id, versionId: id, effectId: id, input: jsonValueSchema }),
  SkillTestRecorded: z.object({ entryId: id, versionId: id, effectId: id, passed: z.boolean(), report: jsonValueSchema }),
  SubagentSpecInvoked: z.object({ entryId: id, versionId: id, taskId: id, childSessionId: id, childBranchId: id }),
  SyncConflictResolved: z.object({ conflictId: id, action: z.enum(["keep-branches", "choose-claim", "cancel-duplicate", "acknowledge"]), resolvedBy: id, chosenEventId: id.optional(), note: z.string().optional(), resolvedAt: dateTime }),
  AgentRunRequested: z.object({ runId: id, task: z.string().min(1), requestKey: id, goalId: id.optional(), goalMode: z.enum(["none", "auto", "current", "create"]).optional(), wakeId: id.optional() }).strict(),
  AgentRunStepStarted: z.object({ runId: id, stepId: id, ordinal: positiveInteger, contextId: id, callId: id, effectId: id, actionId: id, observationEventIds: z.array(id) }).strict(),
  AgentRunModelAttemptStarted: z.object({ runId: id, stepId: id, ordinal: positiveInteger, attempt: positiveInteger, contextId: id, callId: id, effectId: id, reason: z.enum(["initial", "proactive-compaction", "provider-overflow"]), estimatedInputTokens: z.number().int().nonnegative(), contextWindow: capacityProvenanceSchema, retryOfCallId: id.optional() }).strict(),
  AgentRunActionCommitted: z.object({ runId: id, stepId: id, ordinal: positiveInteger, actionId: id, callId: id, raw: z.string(), action: agentActionSchema }).strict(),
  AgentRunActionRejected: z.object({ runId: id, stepId: id, ordinal: positiveInteger, actionId: id, callId: id, raw: z.string(), error: z.string().min(1) }).strict(),
  AgentRunGoalCheckRecorded: z.object({ runId: id, actionId: id, goalId: id, requestId: id, status: z.enum(["passed", "failed", "unknown"]), summary: z.string().min(1).max(65536), gateEvaluationEventIds: z.array(id) }).strict(),
  AgentRunUserInputRequested: z.object({ runId: id, requestId: id, actionId: id, kind: z.enum(["clarification", "permission"]), question: z.string().min(1), permission: z.string().min(1).optional() }).strict(),
  AgentRunUserInputReceived: z.object({ runId: id, requestId: id, response: z.string(), approved: z.boolean().optional() }).strict(),
  AgentRunCancellationRequested: z.object({ runId: id, reason: z.string().optional() }).strict(),
  AgentRunStatusChanged: z.object({ runId: id, status: z.enum(["waiting_for_user", "succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"]), reason: z.string().optional(), finalMessageId: id.optional() }).strict(),
};

export function validateNewEvent<T extends EventType>(event: NewAgentEvent<T>): void {
  const parsed = headerSchema.safeParse(event);
  if (!parsed.success) throw new ValidationError("Invalid event header", { issues: parsed.error.issues });
  if ((event.schemaVersion ?? EVENT_SCHEMA_VERSION) !== EVENT_SCHEMA_VERSION) throw new ValidationError(`Unsupported ${event.type} schema version: ${event.schemaVersion}`);
  assertJsonValue(event.payload);
  const payload = payloadSchemas[event.type].safeParse(event.payload);
  if (!payload.success) throw new ValidationError(`Invalid ${event.type} payload`, { issues: payload.error.issues });
  if (event.type === "ContextCompactionRequested") validateCompactionRequestIntegrity(event.payload as unknown as EventPayloads["ContextCompactionRequested"]);
}

function validateCompactionRequestIntegrity(payload: EventPayloads["ContextCompactionRequested"]): void {
  const ordered = [...payload.frozenSources].sort((left, right) => {
    const cursor = BigInt(left.cursor) < BigInt(right.cursor) ? -1 : BigInt(left.cursor) > BigInt(right.cursor) ? 1 : 0;
    return cursor || (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0);
  });
  if (ordered.some((source, index) => source.eventId !== payload.sourceEventIds[index] || source.eventId !== payload.frozenSources[index]?.eventId || BigInt(source.cursor) > BigInt(payload.throughCursor))) {
    throw new ValidationError("Context compaction frozen sources must be canonically ordered at or before throughCursor");
  }
  const sourceEnvelope = {
    format: "agencity-compaction-sources-v1",
    sources: ordered.map((source) => ({ eventId: source.eventId, sessionId: source.sessionId, branchId: source.branchId, cursor: source.cursor, type: source.type, schemaVersion: source.schemaVersion, payload: source.payload })),
  };
  const hasher = new Bun.CryptoHasher("sha256"); hasher.update(canonicalEventJson(sourceEnvelope));
  if (hasher.digest("hex") !== payload.sourceDigest) throw new ValidationError("Context compaction source digest does not match its frozen sources");
}

function canonicalEventJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalEventJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalEventJson(record[key])}`).join(",")}}`;
}

export function newId(): string { return ulid(); }

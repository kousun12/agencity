import { ulid } from "ulid";
import { z } from "zod";
import type { JsonValue, Sha256Digest } from "./json.ts";
import {
  assertJsonValue,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  canonicalJsonStringify,
} from "./json.ts";
import { ValidationError } from "./errors.ts";
import { agentActionSchema, type AgentAction } from "./agent-action.ts";
import {
  validateModelDispatch,
  type ModelConfiguration,
  type ModelDispatch,
  type ModelWarning,
  type RecursiveResponseAdmission,
} from "./model.ts";
import {
  MODEL_EFFECT_FAILURE_CODES,
  validateModelResponseContract,
  validateModelResponseContractCapability,
  type ModelAdapterGuardCode,
  type ModelContractViolationCode,
  type ModelEffectFailureCode,
  type ModelTerminationKind,
} from "./model-response.ts";
import {
  validateAgentProfileVersion,
  sha256,
  type AgentInvocationProfilePin,
  type AgentProfileVersion,
  type InvocationPromptProvenance,
} from "./agent-profile.ts";
import {
  PROVIDER_INPUT_VERSION,
  estimateProviderInputCandidate,
  reconstructProviderInputCandidate,
  validateProviderInputCandidate,
  type ProviderInputAdmission,
  type ProviderInputCandidate,
} from "./provider-input.ts";
import { assertBoundedOutputs } from "./bounded-output.ts";
import {
  REPOSITORY_INSTRUCTION_LIMITS,
  REPOSITORY_INSTRUCTIONS_PROTOCOL,
  type RepositoryInstructionDiscovery,
  type RepositoryInstructionOmission,
} from "./repository-instructions.ts";
import {
  validateAgentInvocationContract,
  type AgentInvocationContract,
  type AgentRunResultReference,
} from "./agent-invocation-contract.ts";
import {
  objectiveEvaluationSchema,
  validateObjectiveEvaluation,
} from "./refinement-review.ts";
import {
  MAX_REFINEMENT_GOVERNANCE_EVIDENCE_EXCERPT_BYTES,
} from "./refinement-governance.ts";
import {
  REPL_EPOCH_CHANGED,
  replNamespaceStatusSchema,
  type ReplNamespaceStatus,
} from "./repl-namespace.ts";
import {
  SESSION_TITLE_FIELD_LIMITS,
  SESSION_TITLE_MAX_WORDS,
  validateSessionTitleFields,
} from "./session-title.ts";

export const EVENT_SCHEMA_VERSION = 6 as const;
export const eventTypes = [
  "SessionCreated", "AgentProfileVersionCreated", "AgentProfileActivated", "BranchCreated", "SessionNamed", "SessionTitleRequested", "SessionTitleResolved", "SessionTitleModeChanged", "BranchNamed", "SessionStatusChanged", "SessionModelChanged", "MessageAppended",
  "CellProposed", "CellStarted", "CellCommitted", "CellFailed", "CellAbandoned",
  "WorkingValueSet", "ArtifactRegistered", "EffectRequested", "EffectAttemptStarted",
  "EffectOutcomeRecorded", "EffectReconciliationRecorded", "ManagedProcessRegistered", "ManagedProcessStarted", "ManagedProcessStopFailed",
  "ContextCompactionRequested", "ContextCompactionFailed",
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
  "AiGenerationContextFrozen", "AiGenerationRequested", "AiGenerationStatusChanged",
  "AiGenerationResultCommitted", "AiGenerationBudgetDebited",
  "HarnessVersionCreated", "HarnessVersionStatusChanged",
  "UserCorrection", "RefinementReviewRequested", "RefinementReviewChildLinked", "RefinementReviewStatusChanged", "RefinementTriggerConsumed",
  "RefinementProposed", "RefinementValidated", "RefinementCandidateActivated",
  "RefinementCandidateAllocated", "RefinementCandidateExposed", "RefinementObservationRecorded",
  "RefinementDecided", "RefinementApproved", "RefinementRollbackApproved", "RefinementRolledBack",
  "GovernedRefinementProposed", "GovernedRefinementValidated",
  "RefinementGovernanceReviewRequested", "RefinementGovernanceReviewChildLinked",
  "RefinementGovernanceReviewDecided", "GovernedRefinementApplied",
  "RefinementProposalTerminalNoticeDelivered", "RefinementRollbackApplied",
  "GovernedRefinementRollbackApplied",
  "SkillImported", "SkillAvailabilityChanged", "SkillInvocationRecorded", "SkillTestRecorded", "SubagentSpecInvoked", "SyncConflictResolved",
  "AgentRunRequested", "AgentInvocationContractPinned", "AgentRunStepStarted", "AgentRunModelAttemptStarted", "AgentRunActionCommitted", "AgentRunActionRejected",
  "AgentRunTypedFinishCommitted", "AgentRunTypedActionViolationCommitted", "AgentRunResultCommitted", "AgentRunGoalCheckRecorded",
  "AgentRunCancellationRequested", "AgentRunStatusChanged",
] as const;
export type EventType = (typeof eventTypes)[number];
export type Producer = "supervisor" | "console" | "model" | "executor" | "client" | "recovery" | "scheduler" | string;
export type CellLogStream = "stdout" | "stderr";
export type SessionStatus = "idle" | "running" | "stopped" | "failed" | "archived";
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type EffectOutcome = "succeeded" | "failed" | "cancelled" | "unknown";
export type ManagedProcessStatus = "queued" | "running" | EffectOutcome;
export type GovernedRefinementRollbackAction =
  | {
      readonly operation: "restore";
      readonly editIndex: number;
      readonly targetKind: "memory" | "prompt_note" | "skill" | "subagent_spec";
      readonly targetId: string;
      readonly appliedVersionId: string;
      readonly restoreSourceVersionId: string;
      readonly restorationVersionId: string;
      readonly restorationRollbackId: string;
    }
  | {
      readonly operation: "deactivate";
      readonly editIndex: number;
      readonly targetKind: "memory" | "prompt_note" | "skill" | "subagent_spec";
      readonly targetId: string;
      readonly appliedVersionId: string;
    }
  | {
      readonly operation: "reactivate";
      readonly editIndex: number;
      readonly targetKind: "memory" | "prompt_note" | "skill" | "subagent_spec";
      readonly targetId: string;
      readonly reactivatedVersionId: string;
    };
export type EffectOrigin =
  | { readonly kind: "cell"; readonly cellId: string }
  | { readonly kind: "model-call"; readonly callId: string }
  | { readonly kind: "ai-generation"; readonly generationId: string }
  | { readonly kind: "session-title"; readonly requestId: string }
  | { readonly kind: "context-compaction"; readonly compactionId: string }
  | { readonly kind: "goal-gate"; readonly goalId: string; readonly gateId: string; readonly requestId: string }
  | { readonly kind: "skill-invocation"; readonly entryId: string; readonly versionId: string }
  | { readonly kind: "skill-test"; readonly entryId: string; readonly versionId: string }
  | { readonly kind: "runtime"; readonly requestId: string };
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
export type AiGenerationKind = "text" | "object";
export type AiGenerationStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unknown" | "budget_exceeded";
export const MAX_AI_GENERATIONS_PER_CELL = 16;
export const MAX_CONCURRENT_AI_GENERATIONS_PER_CELL = 4;
export const AI_GENERATION_SYSTEM_INSTRUCTION = "Perform exactly one bounded generation using only the explicit messages and context below. Do not assume branch conversation, files, tools, memory, profile, skills, or repository instructions.";
export interface AiGenerationBudgetLimits extends BudgetLimits {
  readonly inputTokenLimit?: number;
  readonly outputTokenLimit?: number;
  readonly inlineResultByteLimit: number;
}
export type AgentRunStatus = "queued" | "running" | "succeeded" | "blocked" | "failed" | "cancelled" | "budget_exceeded" | "unknown";
export type RefinementReviewLifecycleStatus = "requested" | "running" | "no_change" | "candidate" | "revision_required" | "failed" | "cancelled" | "unknown";
export type ContextCompactionStrategy = "deterministic-extractive-v1" | "model-summary-v1";
export type ContextCompactionReason = "user-request" | "agent-request" | "automatic-threshold" | "provider-overflow" | "rematerialize";
export type ContextCompactionRequester = "user" | "agent" | "supervisor";
export type ContextCapacitySource = "provider-metadata" | "model-catalog" | "operator-configuration" | "unknown";

export interface BudgetLimits { readonly tokenLimit?: number; readonly costLimitUsd?: number; readonly turnLimit?: number; readonly wallTimeLimitMs?: number; }
export interface AgentRunDeadline {
  /** External authoritative start anchor, which may precede run admission. */
  readonly startedAt: string;
  /** Absolute UTC deadline. Elapsed time is never derived from budget wall time. */
  readonly deadlineAt: string;
}
export interface AgentRunRefinementPolicy {
  /** Maximum explicit review requests admitted while this run is active. */
  readonly manualReviewLimit: number;
  /** Minimum distinct canonical evidence records each explicit request must cite. */
  readonly requiredEvidenceEventCount: number;
}
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}
export type ModelUsageSource = "provider-reported" | "conservative-guard-estimate";
export type ModelCallTermination =
  | { readonly kind: ModelTerminationKind; readonly rawReason?: string }
  | { readonly kind: "adapter-guard"; readonly code: ModelAdapterGuardCode };
export type ModelCallResult =
  | { readonly kind: "text"; readonly textDigest: Sha256Digest }
  | { readonly kind: "tool-submission"; readonly providerToolCallId: string; readonly name: string; readonly inputDigest: Sha256Digest }
  | { readonly kind: "contract-violation"; readonly code: ModelContractViolationCode; readonly evidenceDigest: Sha256Digest; readonly providerToolCallId?: string };
export type AgentRunActionSource =
  | { readonly kind: "tool-submission"; readonly modelCallId: string; readonly providerToolCallId: string; readonly resultDigest: Sha256Digest }
  | { readonly kind: "contract-violation"; readonly modelCallId: string; readonly providerToolCallId?: string; readonly resultDigest: Sha256Digest };
export type AgentRunTypedFinishOutcome =
  | { readonly status: "succeeded"; readonly message: string; readonly value: JsonValue }
  | { readonly status: "blocked" | "failed"; readonly message: string };
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
  SessionCreated: { workspaceId: string; initialBranchId: string; model: ModelConfiguration; budget: BudgetLimits; agentProfile: AgentProfileVersion; sessionName?: string; initialBranchName?: string; parentSessionId?: string; parentBranchId?: string; rootSessionId?: string; depth?: number; taskId?: string };
  AgentProfileVersionCreated: { agentProfile: AgentProfileVersion; expectedActiveProfileVersionId: string };
  AgentProfileActivated: { profileVersionId: string; expectedActiveProfileVersionId: string; reason: string };
  BranchCreated: { branchId: string; parentBranchId: string; forkCursor: string; name?: string };
  SessionNamed: { name: string };
  SessionTitleRequested: {
    requestId: string; sourceMessageEventId: string; sourceMessageCursor: string;
    sourceMessageEventIds: string[]; mode: "model" | "fallback";
    effectId?: string; modelDispatch?: ModelDispatch; providerInput?: ProviderInputCandidate;
    estimatedInputTokens?: number; fallbackReason?: string;
  };
  SessionTitleResolved: {
    requestId: string; sourceMessageEventId: string; sourceMessageCursor: string;
    sourceMessageEventIds: string[]; sourceBranchId: string; method: "model" | "fallback";
    title: string; verb: string; subject: string; intentSummary: string;
    sourceOutcomeEventId?: string; usage?: Usage; warnings?: ModelWarning[];
    usageSource?: ModelUsageSource; fallbackReason?: string;
  };
  SessionTitleModeChanged: { mode: "automatic"; reason: string };
  BranchNamed: { name: string };
  SessionStatusChanged: { status: SessionStatus; reason?: string };
  SessionModelChanged: { previousModel: ModelConfiguration; model: ModelConfiguration; selectedBy: "user" };
  MessageAppended: { messageId: string; role: MessageRole; content: string; modelCallId?: string; mailbox?: { mailboxMessageId: string; fromSessionId: string; relationship: FamilyRelationship; taskId?: string; artifactIds?: string[]; receiptEventId: string }; learningScan?: { version: 1; category: "scan_unavailable" | "validation_failed"; durationMs?: number } };
  CellProposed: { cellId: string; code: string; dependencies: string[] };
  CellStarted: { cellId: string; attempt: number };
  CellCommitted: { cellId: string; result: JsonValue; logs: string[]; logStreams?: CellLogStream[]; durationMs: number; exports: string[]; repositoryInstructions?: RepositoryInstructionDiscovery[]; repositoryInstructionOmission?: RepositoryInstructionOmission };
  CellFailed: {
    cellId: string;
    error: string;
    logs: string[];
    logStreams?: CellLogStream[];
    durationMs: number;
    causalEffectOutcomeEventIds?: string[];
    failure?: {
      code: typeof REPL_EPOCH_CHANGED;
      expected: ReplNamespaceStatus | null;
      current: ReplNamespaceStatus;
      guidance: string;
    };
  };
  CellAbandoned: { cellId: string; reason: string };
  WorkingValueSet: { name: string; version: number; value: WorkingValue };
  ArtifactRegistered: ArtifactReference & { sourceEventId?: string };
  EffectRequested: { effectId: string; executor: string; operation: string; input: JsonValue; origin: EffectOrigin; idempotencyKey: string; idempotent: boolean };
  EffectAttemptStarted: { effectId: string; attempt: number };
  EffectOutcomeRecorded: { effectId: string; attempt: number; outcome: EffectOutcome; output?: JsonValue; error?: string; modelFailure?: { code: ModelEffectFailureCode }; observedAt: string };
  EffectReconciliationRecorded: { reconciliationId: string; effectId: string; assessment: "succeeded" | "failed" | "no_effect" | "still_unknown"; summary: string; evidence?: JsonValue; recordedBy: string; recordedAt: string };
  ManagedProcessRegistered: {
    processId: string; effectId: string; workspaceId: string; runId?: string; cellId: string;
    command: string; cwd?: string; identityToken: string; requestedAt: string;
  };
  ManagedProcessStarted: {
    processId: string; effectId: string; identityToken: string; pid: number;
    processGroupId: number; startedAt: string;
  };
  ManagedProcessStopFailed: {
    processId: string; effectId: string; attempt: number; reason: string;
    error: string; processGroupIds: number[]; survivingProcessGroupIds: number[];
    attemptedAt: string;
  };
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
  ContextMaterialized: { contextId: string; records: ContextRecordReference[]; contentHash: string; context: JsonValue; harnessProvenance?: JsonValue; promptProvenance?: InvocationPromptProvenance; providerInputAdmission?: ProviderInputAdmission; derivation?: ContextCompactionDerivation };
  ModelCallRequested: { callId: string; contextId: string; effectId: string; modelDispatch: ModelDispatch; providerInput: ProviderInputCandidate; estimatedInputTokens: number; promptProvenance: InvocationPromptProvenance; attempt?: number; retryOfCallId?: string; contextWindow?: ContextCapacityProvenance };
  ModelOutputChunk: { callId: string; sequence: number; text: string };
  ModelCallCompleted: { callId: string; responseMessageId?: string; result: ModelCallResult; resultDigest: Sha256Digest; termination: ModelCallTermination; usage: Usage | null; warnings: ModelWarning[]; usageSource: ModelUsageSource };
  ModelCallTerminated: { callId: string; outcome: Exclude<EffectOutcome, "succeeded">; error?: string; failureCode?: ModelEffectFailureCode };
  BudgetDebited: { callId: string; tokens: number; costUsd: number; turns: number; wallTimeMs: number; usageSource: ModelUsageSource };
  BudgetExceeded: { dimension: "tokens" | "cost" | "turns" | "wallTime"; limit: number; spent: number };
  RecoveryPerformed: { abandonedCellIds: string[]; unknownEffectIds: string[]; retriedEffectIds: string[] };
  TaskCreated: { taskId: string; parentSessionId: string; parentBranchId: string; childSessionId: string; childBranchId: string; task: string; completionCriteria?: string; model: ModelConfiguration; budget: BudgetLimits };
  SubagentAdmitted: { taskId: string; childSessionId: string; childBranchId: string; admittedAt: string };
  TaskStatusChanged: { taskId: string; status: Exclude<TaskStatus, "pending">; result?: JsonValue; artifactIds?: string[]; error?: string; reason?: string };
  SubagentCancellationRequested: { taskId: string; childSessionId: string; reason?: string };
  TaskUsageAttributed: { taskId: string; childSessionId: string; tokens: number; costUsd: number; turns: number; wallTimeMs: number; conservative: boolean };
  MailboxMessageSent: { mailboxMessageId: string; fromSessionId: string; fromBranchId: string; toSessionId: string; toBranchId: string; kind: MailboxMessageKind; content: string; taskId?: string; artifactIds?: string[]; intentKey?: string; mode?: "steer" | "queue"; followUp?: boolean; replyToMessageId?: string };
  MailboxMessageDelivered: { mailboxMessageId: string; sentEventId: string; fromSessionId: string; fromBranchId: string; toSessionId: string; toBranchId: string; kind: MailboxMessageKind; content: string; taskId?: string; artifactIds?: string[]; intentKey?: string; mode?: "steer" | "queue"; followUp?: boolean; replyToMessageId?: string; senderRelationship?: FamilyRelationship };
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
  RecursiveModelStarted: { handleId: string; taskId: string; parentSessionId: string; parentBranchId: string; childSessionId: string; childBranchId: string; model: ModelConfiguration; responseAdmission: RecursiveResponseAdmission; profilePin: AgentInvocationProfilePin; inputSetId?: string; input?: JsonValue; inputProvenance?: JsonValue; inputHash?: string };
  RecursiveModelStatusChanged: { handleId: string; status: Exclude<RecursiveModelStatus, "pending">; outcome?: RecursiveModelOutcome; resultMessageId?: string; result?: JsonValue; resultArtifactId?: string; error?: string };
  AiGenerationContextFrozen: { generationId: string; context: JsonValue; provenance: JsonValue; contextDigest: Sha256Digest; exactUtf8Bytes: number };
  AiGenerationRequested: {
    generationId: string; kind: AiGenerationKind; effectId: string; idempotencyKey: string; requestDigest: Sha256Digest;
    cellId?: string; runId?: string; taskId?: string; ancestorTaskIds: string[];
    modelDispatch: ModelDispatch; providerInput: ProviderInputCandidate; estimatedInputTokens: number;
    contextEventId: string; contextDigest: Sha256Digest;
    budget: AiGenerationBudgetLimits;
    reservation: { tokens: number; costUsd: number; turns: 1; wallTimeMs: number };
  };
  AiGenerationStatusChanged: { generationId: string; status: "running" | "failed" | "cancelled" | "unknown" | "budget_exceeded"; effectId: string; error?: string };
  AiGenerationResultCommitted: {
    generationId: string; effectId: string; sourceOutcomeEventId: string;
    kind: AiGenerationKind; value: JsonValue; resultDigest: Sha256Digest; resultBytes: number;
    finishReason: string; usage: Usage; warnings: ModelWarning[]; usageSource: ModelUsageSource;
  };
  AiGenerationBudgetDebited: {
    generationId: string; sessionId: string; branchId: string; runId?: string; taskId?: string; ancestorTaskIds: string[];
    tokens: number; costUsd: number; turns: number; wallTimeMs: number; usageSource: ModelUsageSource;
    sourceResultEventId: string;
  };
  HarnessVersionCreated: { entryId: string; versionId: string; version: number; kind: "memory" | "prompt_note" | "skill" | "subagent_spec"; scope: "local" | "workspace" | "user" | "global"; scopeKey: string; name: string; content: JsonValue; tags: string[]; confidence: number; status: "candidate" | "active" | "retired" | "rejected" | "rolled_back"; evidenceEventIds: string[]; conflictEntryIds: string[]; supersedesVersionId?: string; proposalId?: string; createdBy: string; lastConfirmedAt: string };
  HarnessVersionStatusChanged: { entryId: string; versionId: string; status: "candidate" | "active" | "retired" | "rejected" | "rolled_back"; reason: string; proposalId?: string };
  UserCorrection: { correctionId: string; correctedEventIds: string[]; correction: string };
  RefinementReviewRequested: { reviewId: string; fingerprint: string; mode: "manual" | "automatic" | "skill_creation"; waitForGovernance: boolean; requestedScope: "local" | "workspace" | "user" | "global"; requestedScopeKey: string; allowedKinds: ("memory" | "prompt_note" | "skill" | "subagent_spec")[]; triggerId: string; triggerKind: "manual" | "repeated_effect_failure" | "repeated_cell_failure" | "repeated_gate_failure" | "explicit_user_correction" | "repeated_success" | "stale_memory" | "unproductive_delegation" | "skill_creation"; triggerFingerprint: string; triggerKey?: string; nonterminalKey?: string; triggerEvidenceThroughCursor?: string; evidenceEventIds: string[]; sourceEventIds: string[]; sourceSnapshotHash: string; sourceThroughCursor: string; instructions?: string; request: JsonValue; snapshot?: JsonValue };
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
  GovernedRefinementProposed: { proposalId: string; proposalFingerprint: string; proposal: JsonValue };
  GovernedRefinementValidated: { proposalId: string; valid: boolean; validation: JsonValue; expectedStatus: "proposed" };
  RefinementGovernanceReviewRequested: { proposalId: string; reviewId: string; frozenInput: JsonValue; frozenInputDigest: string; expectedStatus: "validated" };
  RefinementGovernanceReviewChildLinked: { proposalId: string; reviewId: string; handleId: string; childSessionId: string; childBranchId: string; expectedStatus: "validated" };
  RefinementGovernanceReviewDecided: { proposalId: string; reviewId: string; decisionId: string; status: "reviewed_rejected" | "review_failed" | "review_unknown" | "reviewed_approved"; decision?: JsonValue; reason: string; expectedStatus: "validated" | "reviewing" };
  GovernedRefinementApplied: { proposalId: string; decisionId: string; status: "applied" | "apply_conflict" | "apply_failed"; appliedVersionIds: string[]; evaluation?: JsonValue; reason: string; expectedStatus: "reviewed_approved" };
  RefinementProposalTerminalNoticeDelivered: { proposalId: string; noticeId: string; originSessionId: string; originBranchId: string; status: "deterministically_rejected" | "reviewed_rejected" | "review_failed" | "review_unknown" | "apply_conflict" | "apply_failed" | "applied"; result: JsonValue };
  RefinementRollbackApplied: { rollbackId: string; targetKind: "agent_profile" | "memory" | "prompt_note" | "skill" | "subagent_spec"; targetId: string; previousVersionId: string; restoreSourceVersionId: string; restorationVersionId: string; actor: JsonValue; reason: string; evidenceEventIds: string[] };
  GovernedRefinementRollbackApplied: { proposalId: string; rollbackId: string; actions: GovernedRefinementRollbackAction[]; actor: JsonValue; reason: string; evidenceEventIds: string[] };
  SkillImported: { entryId: string; versionId: string; digest: string; scope: "workspace"; origin: { kind: "local-directory"; reference: string; manifestDigest: string; sourceDigest: string }; installedBy: string };
  SkillAvailabilityChanged: { entryId: string; versionId: string; digest: string; availability: "enabled" | "disabled" | "removed"; reason: string; expectedAvailability?: "enabled" | "disabled" | "removed"; expectedPreviousActionSequence?: number | null };
  SkillInvocationRecorded: { entryId: string; versionId: string; effectId: string; input: JsonValue };
  SkillTestRecorded: { entryId: string; versionId: string; effectId: string; passed: boolean; report: JsonValue };
  SubagentSpecInvoked: { entryId: string; versionId: string; taskId: string; childSessionId: string; childBranchId: string };
  SyncConflictResolved: { conflictId: string; action: "keep-branches" | "choose-claim" | "cancel-duplicate" | "acknowledge"; resolvedBy: string; chosenEventId?: string; note?: string; resolvedAt: string };
  AgentRunRequested: {
    runId: string; task: string; requestKey: string; profilePin: AgentInvocationProfilePin;
    goalId?: string; goalMode?: AgentRunGoalMode; wakeId?: string;
    deadline?: AgentRunDeadline;
    refinementPolicy?: AgentRunRefinementPolicy;
  };
  AgentInvocationContractPinned: { runId: string; contract: AgentInvocationContract };
  AgentRunStepStarted: { runId: string; stepId: string; ordinal: number; contextId: string; callId: string; effectId: string; actionId: string; observationEventIds: string[] };
  AgentRunModelAttemptStarted: { runId: string; stepId: string; ordinal: number; attempt: number; contextId: string; callId: string; effectId: string; reason: "initial" | "proactive-compaction" | "provider-overflow"; providerInputVersion: typeof PROVIDER_INPUT_VERSION; providerInputDigest: Sha256Digest; estimatedInputTokens: number; contextWindow: ContextCapacityProvenance; replNamespace?: ReplNamespaceStatus; retryOfCallId?: string };
  AgentRunActionCommitted: { runId: string; stepId: string; ordinal: number; actionId: string; source: Extract<AgentRunActionSource, { kind: "tool-submission" }>; action: AgentAction };
  AgentRunActionRejected: { runId: string; stepId: string; ordinal: number; actionId: string; source: Extract<AgentRunActionSource, { kind: "contract-violation" }>; error: string };
  AgentRunTypedFinishCommitted: { runId: string; stepId: string; ordinal: number; actionId: string; source: Extract<AgentRunActionSource, { kind: "tool-submission" }>; outcome: AgentRunTypedFinishOutcome };
  AgentRunTypedActionViolationCommitted: { runId: string; stepId: string; ordinal: number; actionId: string; source: AgentRunActionSource; error: string };
  AgentRunResultCommitted: {
    runId: string; finishEventId: string; messageId: string; kind: "text" | "object";
    value: JsonValue; valueDigest: Sha256Digest; resultBytes: number; schemaDigest?: Sha256Digest;
    reference: AgentRunResultReference;
  };
  AgentRunGoalCheckRecorded: { runId: string; actionId: string; goalId: string; requestId: string; status: "passed" | "failed" | "unknown"; summary: string; gateEvaluationEventIds: string[] };
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
const modelDispatchSchema = z.custom<ModelDispatch>((value) => {
  try {
    validateModelDispatch(value as ModelDispatch);
    return true;
  } catch {
    return false;
  }
}, "Expected one canonical response-aware model dispatch");
const boundedWarningMessage = z.string().min(1).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 1_024,
  "warning message exceeds 1024 UTF-8 bytes",
);
const modelWarningSchema = z.object({
  kind: z.enum(["coerced", "unsupported", "provider", "truncated"]),
  message: boundedWarningMessage,
}).strict();
const usageSchema = z.object({
  inputTokens: nonnegative,
  outputTokens: nonnegative,
  costUsd: nonnegative,
  cacheReadTokens: nonnegative.optional(),
  cacheWriteTokens: nonnegative.optional(),
}).strict();
const modelFailureCodeSchema = z.enum(MODEL_EFFECT_FAILURE_CODES as [ModelEffectFailureCode, ...ModelEffectFailureCode[]]);
const usageSourceSchema = z.enum(["provider-reported", "conservative-guard-estimate"]);
const terminationSchema = z.union([
  z.object({ kind: z.enum(["text-stop", "tool-calls", "output-limit", "content-filter", "refusal", "other"]), rawReason: z.string().optional() }).strict(),
  z.object({ kind: z.literal("adapter-guard"), code: z.enum(["multiple-tool-calls", "unexpected-tool", "oversized-tool-input", "oversized-provider-response"]) }).strict(),
]);
const modelCallResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), textDigest: fingerprint }).strict(),
  z.object({ kind: z.literal("tool-submission"), providerToolCallId: id, name: id, inputDigest: fingerprint }).strict(),
  z.object({ kind: z.literal("contract-violation"), code: z.enum(["required-tool-missing", "multiple-tool-calls", "unexpected-tool", "invalid-tool-input", "truncated-tool-input", "oversized-tool-input", "oversized-provider-response", "incomplete-provider-response", "provider-refusal"]), evidenceDigest: fingerprint, providerToolCallId: id.optional() }).strict(),
]);
const actionSourceSubmissionSchema = z.object({ kind: z.literal("tool-submission"), modelCallId: id, providerToolCallId: id, resultDigest: fingerprint }).strict();
const actionSourceViolationSchema = z.object({ kind: z.literal("contract-violation"), modelCallId: id, providerToolCallId: id.optional(), resultDigest: fingerprint }).strict();
const responseAdmissionSchema = z.object({ responseContract: jsonValueSchema, responseCapability: jsonValueSchema }).strict();
const agentProfileSchema = z.custom<AgentProfileVersion>((value) => {
  try {
    validateAgentProfileVersion(value as AgentProfileVersion);
    return true;
  } catch {
    return false;
  }
}, "Expected one valid immutable agent profile version");
const profilePinSchema = z.object({
  profileVersionId: id,
  agentPromptDigest: digest,
  promptContractId: z.literal("agencity.agent-profile.v1"),
}).strict();
const refinementPrincipalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner"), profileId: id }).strict(),
  z.object({ kind: z.literal("agent"), sessionId: id, branchId: id }).strict(),
  z.object({
    kind: z.literal("automatic_refiner"),
    componentId: z.literal("agencity.trajectory-refiner"),
    version: z.literal(1),
    sessionId: id,
    branchId: id,
  }).strict(),
]);
const refinementOriginSchema = z.object({
  sessionId: id,
  branchId: id,
  runId: id.optional(),
  taskId: id.optional(),
  triggerId: id.optional(),
  clientRequestId: id.optional(),
}).strict();
const agentProfileInputSchema = z.object({
  role: z.string().min(1),
  purpose: z.string().min(1),
  instructions: z.string().min(1),
}).strict();
const refinementTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent_profile"),
    agentSessionId: id,
    expectedProfileVersionId: id,
    replacement: agentProfileInputSchema,
  }).strict(),
  z.object({
    kind: z.literal("harness"),
    harnessKind: z.enum(["memory", "prompt_note", "skill", "subagent_spec"]),
    edits: z.array(jsonValueSchema).min(1).max(16),
  }).strict(),
]);
const governedRefinementProposalSchema = z.object({
  proposalId: id,
  target: refinementTargetSchema,
  principal: refinementPrincipalSchema,
  origin: refinementOriginSchema,
  reason: z.string().min(1).max(16_384),
  predictedEffect: z.string().min(1).max(16_384),
  evidenceEventIds: z.array(id).max(32),
  evaluation: objectiveEvaluationSchema.optional(),
  revisesProposalId: id.optional(),
}).strict();
const reviewerLimitsSchema = z.object({
  tokenLimit: z.number().int().positive(),
  costLimitUsd: z.number().finite().positive(),
  turnLimit: z.number().int().positive(),
  wallTimeLimitMs: z.number().int().positive(),
}).strict();
const frozenGovernanceGroundingSchema = z.object({
  reviewId: id,
  sourceSnapshotHash: fingerprint,
  allowedKinds: z.array(z.enum(["memory", "prompt_note", "skill", "subagent_spec"])).min(1).max(4),
  trigger: jsonValueSchema,
  evidence: z.array(z.object({
    eventId: id,
    cursor: z.string().regex(/^\d+$/),
    type: id,
    payload: jsonValueSchema,
    payloadDigest: fingerprint,
    truncated: z.boolean(),
    redacted: z.boolean(),
  }).strict()).max(32).optional(),
}).strict();
const frozenGovernanceEvidencePayloadsSchema = z.object({
  maximumBytes: z.literal(MAX_REFINEMENT_GOVERNANCE_EVIDENCE_EXCERPT_BYTES),
  usedBytes: z.number().int().nonnegative().max(
    MAX_REFINEMENT_GOVERNANCE_EVIDENCE_EXCERPT_BYTES,
  ),
  excerpts: z.array(z.object({
    eventId: id,
    canonicalPayloadDigest: fingerprint,
    canonicalPayloadBytes: z.number().int().nonnegative(),
    redactedPayloadDigest: fingerprint,
    redactedPayloadBytes: z.number().int().nonnegative(),
    excerpt: z.string(),
    excerptDigest: fingerprint,
    excerptBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    redactions: z.array(z.enum(["credentials", "repository_instructions"])).max(2),
  }).strict()).max(32),
}).strict();
const frozenGovernanceInputSchema = z.object({
  protocol: z.literal("agencity.refinement-governance-input"),
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  proposal: governedRefinementProposalSchema,
  currentTarget: jsonValueSchema,
  renderedReplacement: jsonValueSchema,
  evidence: z.array(z.object({
    eventId: id,
    sessionId: id,
    branchId: id,
    cursor: z.string().regex(/^\d+$/),
    type: id,
    payloadDigest: fingerprint,
  }).strict()).max(32),
  evidencePayloads: frozenGovernanceEvidencePayloadsSchema.optional(),
  refinementGrounding: frozenGovernanceGroundingSchema.optional(),
  proposerRelationship: z.enum(["self", "direct_parent", "workspace_owner", "automatic_refiner"]),
  targetScope: jsonValueSchema,
  runtimeBoundaries: z.array(z.string().min(1)).min(1).max(32),
  constraints: jsonValueSchema,
  visibleHarnessContext: jsonValueSchema,
  constitution: z.object({ componentId: id, version: positiveInteger, digest, text: z.string().min(1) }).strict(),
  reviewPolicy: z.object({ componentId: id, version: positiveInteger, digest, text: z.string().min(1) }).strict(),
  reviewerDispatch: jsonValueSchema,
  reviewerLimits: reviewerLimitsSchema,
  canonicalDigest: fingerprint,
}).strict().superRefine((value, context) => {
  const { canonicalDigest, ...body } = value;
  if (canonicalJsonDigest(body as unknown as JsonValue) !== canonicalDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "frozen governance input digest does not match" });
  }
  if (value.version === 1 && value.refinementGrounding !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "governance input v1 cannot contain refinement grounding" });
  }
  if (value.version < 3 && value.evidencePayloads !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "governance input v1/v2 cannot contain v3 evidence payloads" });
  }
  if (value.version === 2 && value.refinementGrounding !== undefined &&
      value.refinementGrounding.evidence === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "governance input v2 grounding requires evidence excerpts" });
  }
  if (value.version === 3) {
    if (value.evidencePayloads === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "governance input v3 requires bounded evidence payloads" });
      return;
    }
    if (value.refinementGrounding?.evidence !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "governance input v3 grounding cannot duplicate evidence payloads" });
    }
    const evidenceIds = value.evidence.map((item) => item.eventId);
    const excerptIds = value.evidencePayloads.excerpts.map((item) => item.eventId);
    if (!Bun.deepEquals(evidenceIds, value.proposal.evidenceEventIds) ||
        !Bun.deepEquals(excerptIds, value.proposal.evidenceEventIds)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "governance input v3 evidence order must match the proposal" });
    }
    const usedBytes = value.evidencePayloads.excerpts.reduce(
      (total, item) => total + item.excerptBytes,
      0,
    );
    if (usedBytes !== value.evidencePayloads.usedBytes) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "governance input v3 aggregate excerpt bytes do not match" });
    }
    for (const [index, item] of value.evidencePayloads.excerpts.entries()) {
      const excerptBytes = new TextEncoder().encode(item.excerpt).byteLength;
      if (item.excerptBytes !== excerptBytes ||
          item.excerptDigest !== canonicalJsonDigest(item.excerpt) ||
          item.excerptBytes > item.redactedPayloadBytes ||
          item.truncated !== (item.excerptBytes < item.redactedPayloadBytes) ||
          new Set(item.redactions).size !== item.redactions.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `governance input v3 excerpt provenance does not match for ${item.eventId}` });
      }
      if (value.evidence[index]?.payloadDigest !==
          item.canonicalPayloadDigest) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `governance input v3 canonical evidence digest does not match for ${item.eventId}` });
      }
      if (item.redactions.length === 0 &&
          (item.canonicalPayloadDigest !== item.redactedPayloadDigest ||
            item.canonicalPayloadBytes !== item.redactedPayloadBytes)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `governance input v3 unredacted payload provenance does not match for ${item.eventId}` });
      }
      if (item.redactions.length > 0 &&
          item.canonicalPayloadDigest === item.redactedPayloadDigest) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `governance input v3 redaction provenance does not change the payload for ${item.eventId}` });
      }
      if (!item.truncated) {
        try {
          const parsedExcerpt = JSON.parse(item.excerpt) as JsonValue;
          if (canonicalJsonStringify(parsedExcerpt) !== item.excerpt ||
              canonicalJsonDigest(parsedExcerpt) !== item.redactedPayloadDigest ||
              canonicalJsonByteLength(parsedExcerpt) !== item.redactedPayloadBytes) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: `governance input v3 complete redacted payload does not match for ${item.eventId}` });
          }
        } catch {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `governance input v3 complete excerpt is not canonical JSON for ${item.eventId}` });
        }
      }
    }
  }
});
const immutablePromptComponentSchema = z.object({
  componentId: id,
  version: positiveInteger,
  digest,
}).strict();
const promptProvenanceSchema = z.object({
  invocationKind: z.enum(["agent-run", "recursive-model"]),
  invocationId: id,
  profileVersionId: id,
  agentPromptDigest: digest,
  effectiveSystemPromptDigest: digest,
  systemPromptContractId: z.literal("agencity.system-prompt.v1"),
  components: z.object({
    basePolicy: immutablePromptComponentSchema,
    agentProfile: immutablePromptComponentSchema,
    responseContract: immutablePromptComponentSchema,
    executionGuidance: immutablePromptComponentSchema,
  }).strict(),
}).strict();
const artifactSchema = z.object({ artifactId: id, digest, mediaType: id, size: nonnegative });
const workingValueSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("json"), value: jsonValueSchema }), z.object({ kind: z.literal("artifact"), artifactId: id })]);
const effectOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cell"), cellId: id }).strict(),
  z.object({ kind: z.literal("model-call"), callId: id }).strict(),
  z.object({ kind: z.literal("ai-generation"), generationId: id }).strict(),
  z.object({ kind: z.literal("session-title"), requestId: id }).strict(),
  z.object({ kind: z.literal("context-compaction"), compactionId: id }).strict(),
  z.object({ kind: z.literal("goal-gate"), goalId: id, gateId: id, requestId: id }).strict(),
  z.object({ kind: z.literal("skill-invocation"), entryId: id, versionId: id }).strict(),
  z.object({ kind: z.literal("skill-test"), entryId: id, versionId: id }).strict(),
  z.object({ kind: z.literal("runtime"), requestId: id }).strict(),
]);
export function validateEffectOrigin(value: unknown): EffectOrigin {
  const parsed = effectOriginSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError("Invalid projected effect origin", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}
const taskTerminalSchema = z.object({ noticeId: id, taskId: id, parentSessionId: id, childSessionId: id, status: z.enum(["completed", "failed", "cancelled"]), result: jsonValueSchema.optional(), artifactIds: z.array(id).optional(), error: z.string().optional(), reason: z.string().optional() });
const mailboxBaseSchema = z.object({ mailboxMessageId: id, fromSessionId: id, fromBranchId: id, toSessionId: id, toBranchId: id, kind: z.enum(["message", "task_completed", "task_failed", "task_cancelled"]), content: z.string(), taskId: id.optional(), artifactIds: z.array(id).max(8).optional(), intentKey: id.optional(), mode: z.enum(["steer", "queue"]).optional(), followUp: z.boolean().optional(), replyToMessageId: id.optional() });
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
const repositoryPathSchema = z.string().min(1).max(4096).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") &&
  !value.split("/").some((part) => part === ".." || part === ""), "repository path must be normalized and workspace-relative");
const repositoryInstructionRecordSchema = z.object({
  protocol: z.literal(REPOSITORY_INSTRUCTIONS_PROTOCOL),
  path: repositoryPathSchema,
  directory: repositoryPathSchema,
  scope: z.enum(["workspace", "directory"]),
  precedence: z.number().int().nonnegative(),
  sha256: digest.nullable(),
  size: nonnegative.nullable(),
  completeness: z.enum(["inline", "reference", "unavailable"]),
  content: z.string().optional(),
  redacted: z.boolean().optional(),
  reason: z.string().min(1).max(1024).optional(),
  guidance: z.string().min(1).max(4096).optional(),
}).strict().superRefine((value, context) => {
  if ((value.scope === "workspace") !== (value.precedence === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "workspace instructions must have precedence zero and directory instructions must be deeper" });
  }
  if (value.completeness === "inline") {
    if (value.sha256 === null || value.size === null || value.content === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "inline repository instructions require digest, size, and content" });
    } else if (new TextEncoder().encode(value.content).byteLength > REPOSITORY_INSTRUCTION_LIMITS.nestedFileBytes) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "inline repository instructions exceed the byte limit" });
    }
  } else if (value.content !== undefined || value.redacted !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "non-inline repository instructions must omit content and redaction metadata" });
  }
  if (value.completeness === "reference" && (value.sha256 === null || value.size === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "referenced repository instructions require digest and size" });
  }
});
const repositoryInstructionDiscoverySchema = z.object({
  protocol: z.literal(REPOSITORY_INSTRUCTIONS_PROTOCOL),
  targetPath: repositoryPathSchema,
  precedence: z.literal("root-to-nearest-directory"),
  instructions: z.array(repositoryInstructionRecordSchema).max(REPOSITORY_INSTRUCTION_LIMITS.nestedFilesPerRead),
  omittedInstructionPaths: z.array(repositoryPathSchema).max(REPOSITORY_INSTRUCTION_LIMITS.omittedPaths).optional(),
  omittedInstructionCount: z.number().int().positive().optional(),
  unscannedAncestorDirectoryPaths: z.array(repositoryPathSchema).max(REPOSITORY_INSTRUCTION_LIMITS.omittedPaths).optional(),
  unscannedAncestorDirectoryCount: z.number().int().positive().optional(),
  unidentifiedInstructionOmissionOccurrences: z.number().int().positive().optional(),
  unidentifiedAncestorScanOmissionOccurrences: z.number().int().positive().optional(),
}).strict().superRefine((value, context) => {
  const paths = value.instructions.map((item) => item.path);
  if (new Set(paths).size !== paths.length ||
      value.instructions.some((item) => item.scope !== "directory") ||
      value.instructions.some((item, index) => index > 0 && item.precedence < value.instructions[index - 1]!.precedence)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "nested repository instructions must be unique directory records in root-to-nearest order" });
  }
  const omittedCount = value.omittedInstructionCount ?? 0;
  const omittedPaths = value.omittedInstructionPaths ?? [];
  const unscannedCount = value.unscannedAncestorDirectoryCount ?? 0;
  const unscannedPaths = value.unscannedAncestorDirectoryPaths ?? [];
  if (value.instructions.length === 0 && omittedCount === 0 && unscannedCount === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "repository instruction discovery must retain content or an explicit omission" });
  }
  if (omittedCount < omittedPaths.length ||
      (omittedCount === 0) !== (value.omittedInstructionPaths === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "repository instruction omission count must cover every retained omitted path" });
  }
  if (unscannedCount < unscannedPaths.length ||
      (unscannedCount === 0) !== (value.unscannedAncestorDirectoryPaths === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "unscanned ancestor count must cover every retained directory path" });
  }
});
const repositoryInstructionOmissionSchema = z.object({
  protocol: z.literal(REPOSITORY_INSTRUCTIONS_PROTOCOL),
  targetPaths: z.array(repositoryPathSchema).max(REPOSITORY_INSTRUCTION_LIMITS.omittedPaths),
  instructionPaths: z.array(repositoryPathSchema).max(REPOSITORY_INSTRUCTION_LIMITS.omittedPaths),
  omittedInstructionCount: z.number().int().nonnegative(),
  omittedReadTargetCount: z.number().int().positive(),
  unidentifiedInstructionOmissionOccurrences: z.number().int().positive().optional(),
  unidentifiedReadTargetOmissionOccurrences: z.number().int().positive().optional(),
  unidentifiedAncestorScanOmissionOccurrences: z.number().int().positive().optional(),
}).strict().superRefine((value, context) => {
  if (value.omittedInstructionCount < value.instructionPaths.length ||
      value.omittedReadTargetCount < value.targetPaths.length ||
      new Set(value.targetPaths).size !== value.targetPaths.length ||
      new Set(value.instructionPaths).size !== value.instructionPaths.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "cell repository instruction omissions must be bounded, unique, and counted" });
  }
});
const payloadSchemas: Record<EventType, z.ZodType> = {
  SessionCreated: z.object({ workspaceId: id, initialBranchId: id, model: modelSchema, budget: budgetSchema, agentProfile: agentProfileSchema, sessionName: z.string().min(1).optional(), initialBranchName: z.string().min(1).optional(), parentSessionId: id.optional(), parentBranchId: id.optional(), rootSessionId: id.optional(), depth: z.number().int().nonnegative().optional(), taskId: id.optional() }).strict(),
  AgentProfileVersionCreated: z.object({ agentProfile: agentProfileSchema, expectedActiveProfileVersionId: id }).strict(),
  AgentProfileActivated: z.object({ profileVersionId: id, expectedActiveProfileVersionId: id, reason: z.string().min(1).max(1024) }).strict(),
  BranchCreated: z.object({ branchId: id, parentBranchId: id, forkCursor: z.string().regex(/^\d+$/), name: z.string().optional() }),
  SessionNamed: z.object({ name: z.string().min(1) }),
  SessionTitleRequested: z.object({
    requestId: id,
    sourceMessageEventId: id,
    sourceMessageCursor: z.string().regex(/^\d+$/),
    sourceMessageEventIds: z.array(id).min(1),
    mode: z.enum(["model", "fallback"]),
    effectId: id.optional(),
    modelDispatch: modelDispatchSchema.optional(),
    providerInput: z.custom<ProviderInputCandidate>((value) => {
      try { validateProviderInputCandidate(value); return true; } catch { return false; }
    }).optional(),
    estimatedInputTokens: z.number().int().nonnegative().optional(),
    fallbackReason: z.string().min(1).max(1024).optional(),
  }).strict().superRefine((value, context) => {
    const modelFields = [
      value.effectId,
      value.modelDispatch,
      value.providerInput,
      value.estimatedInputTokens,
    ];
    if (value.sourceMessageEventIds.at(-1) !== value.sourceMessageEventId ||
        new Set(value.sourceMessageEventIds).size !== value.sourceMessageEventIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Session title source frontier is invalid" });
    }
    if (value.mode === "model" &&
        (modelFields.some((item) => item === undefined) || value.fallbackReason !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Model title requests require complete model provenance" });
    }
    if (value.mode === "fallback" &&
        (modelFields.some((item) => item !== undefined) || value.fallbackReason === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Fallback title requests must omit model provenance and retain a reason" });
    }
  }),
  SessionTitleResolved: z.object({
    requestId: id,
    sourceMessageEventId: id,
    sourceMessageCursor: z.string().regex(/^\d+$/),
    sourceMessageEventIds: z.array(id).min(1),
    sourceBranchId: id,
    method: z.enum(["model", "fallback"]),
    title: z.string().min(1).max(SESSION_TITLE_FIELD_LIMITS.title),
    verb: z.string().min(1).max(SESSION_TITLE_FIELD_LIMITS.verb),
    subject: z.string().min(1).max(SESSION_TITLE_FIELD_LIMITS.subject),
    intentSummary: z.string().min(1).max(SESSION_TITLE_FIELD_LIMITS.intentSummary),
    sourceOutcomeEventId: id.optional(),
    usage: usageSchema.optional(),
    warnings: z.array(modelWarningSchema).max(8).optional(),
    usageSource: usageSourceSchema.optional(),
    fallbackReason: z.string().min(1).max(1024).optional(),
  }).strict().superRefine((value, context) => {
    try {
      const checked = validateSessionTitleFields({
        verb: value.verb,
        subject: value.subject,
        intentSummary: value.intentSummary,
      });
      if (checked.title !== value.title ||
          value.title.trim().split(/\s+/).length > SESSION_TITLE_MAX_WORDS) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Session title does not match its structured fields" });
      }
    } catch (error) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "Invalid session title fields" });
    }
    if (value.sourceMessageEventIds.at(-1) !== value.sourceMessageEventId ||
        new Set(value.sourceMessageEventIds).size !== value.sourceMessageEventIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Session title result source frontier is invalid" });
    }
    if (value.method === "model" &&
        (value.sourceOutcomeEventId === undefined || value.usage === undefined ||
          value.usageSource === undefined || value.fallbackReason !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Model title results require exact outcome and usage provenance" });
    }
    if (value.method === "fallback" && value.fallbackReason === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Fallback title results require a reason" });
    }
  }),
  SessionTitleModeChanged: z.object({
    mode: z.literal("automatic"),
    reason: z.string().min(1).max(1024),
  }).strict(),
  BranchNamed: z.object({ name: z.string().min(1) }),
  SessionStatusChanged: z.object({ status: z.enum(["idle", "running", "stopped", "failed", "archived"]), reason: z.string().optional() }),
  SessionModelChanged: z.object({ previousModel: modelSchema, model: modelSchema, selectedBy: z.literal("user") }).strict(),
  MessageAppended: z.object({ messageId: id, role: z.enum(["system", "user", "assistant", "tool"]), content: z.string(), modelCallId: id.optional(), mailbox: z.object({ mailboxMessageId: id, fromSessionId: id, relationship: z.enum(["parent", "child", "sibling"]), taskId: id.optional(), artifactIds: z.array(id).max(8).optional(), receiptEventId: id }).optional(), learningScan: z.object({ version: z.literal(1), category: z.enum(["scan_unavailable", "validation_failed"]), durationMs: z.number().int().nonnegative().max(86_400_000).optional() }).strict().optional() }),
  CellProposed: z.object({ cellId: id, code: z.string(), dependencies: z.array(id) }),
  CellStarted: z.object({ cellId: id, attempt: positiveInteger }),
  CellCommitted: z.object({
    cellId: id,
    result: jsonValueSchema,
    logs: z.array(z.string()),
    logStreams: z.array(z.enum(["stdout", "stderr"])).optional(),
    durationMs: nonnegative,
    exports: z.array(z.string()),
    repositoryInstructions: z.array(repositoryInstructionDiscoverySchema).max(REPOSITORY_INSTRUCTION_LIMITS.discoveriesPerCell).optional(),
    repositoryInstructionOmission: repositoryInstructionOmissionSchema.optional(),
  }).superRefine((payload, context) => {
    if (payload.logStreams && payload.logStreams.length !== payload.logs.length) {
      context.addIssue({ code: "custom", message: "Cell log stream metadata must align with logs", path: ["logStreams"] });
    }
  }),
  CellFailed: z.object({
    cellId: id,
    error: z.string(),
    logs: z.array(z.string()),
    logStreams: z.array(z.enum(["stdout", "stderr"])).optional(),
    durationMs: nonnegative,
    causalEffectOutcomeEventIds: z.array(id).max(16).optional(),
    failure: z.object({
      code: z.literal(REPL_EPOCH_CHANGED),
      expected: replNamespaceStatusSchema.nullable(),
      current: replNamespaceStatusSchema,
      guidance: z.string().min(1),
    }).strict().optional(),
  }).superRefine((payload, context) => {
    if (payload.logStreams && payload.logStreams.length !== payload.logs.length) {
      context.addIssue({ code: "custom", message: "Cell log stream metadata must align with logs", path: ["logStreams"] });
    }
    if (payload.causalEffectOutcomeEventIds &&
        new Set(payload.causalEffectOutcomeEventIds).size !==
          payload.causalEffectOutcomeEventIds.length) {
      context.addIssue({
        code: "custom",
        message: "Cell failure causal effect outcome IDs must be unique",
        path: ["causalEffectOutcomeEventIds"],
      });
    }
  }),
  CellAbandoned: z.object({ cellId: id, reason: z.string() }),
  WorkingValueSet: z.object({ name: id, version: positiveInteger, value: workingValueSchema }),
  ArtifactRegistered: artifactSchema.extend({ sourceEventId: id.optional() }),
  EffectRequested: z.object({ effectId: id, executor: id, operation: id, input: jsonValueSchema, origin: effectOriginSchema, idempotencyKey: id, idempotent: z.boolean() }).strict(),
  EffectAttemptStarted: z.object({ effectId: id, attempt: positiveInteger }),
  EffectOutcomeRecorded: z.object({ effectId: id, attempt: positiveInteger, outcome: z.enum(["succeeded", "failed", "cancelled", "unknown"]), output: jsonValueSchema.optional(), error: z.string().optional(), modelFailure: z.object({ code: modelFailureCodeSchema }).strict().optional(), observedAt: dateTime }).strict(),
  EffectReconciliationRecorded: z.object({ reconciliationId: id, effectId: id, assessment: z.enum(["succeeded", "failed", "no_effect", "still_unknown"]), summary: z.string().min(1).max(16384), evidence: jsonValueSchema.optional(), recordedBy: id, recordedAt: dateTime }).strict(),
  ManagedProcessRegistered: z.object({
    processId: id, effectId: id, workspaceId: id, runId: id.optional(), cellId: id,
    command: z.string().min(1).max(1024 * 1024), cwd: z.string().min(1).max(4096).optional(),
    identityToken: z.string().regex(/^[a-f0-9]{64}$/), requestedAt: dateTime,
  }).strict(),
  ManagedProcessStarted: z.object({
    processId: id, effectId: id, identityToken: z.string().regex(/^[a-f0-9]{64}$/),
    pid: positiveInteger, processGroupId: positiveInteger, startedAt: dateTime,
  }).strict(),
  ManagedProcessStopFailed: z.object({
    processId: id, effectId: id, attempt: positiveInteger,
    reason: z.string().min(1).max(16384), error: z.string().min(1).max(16384),
    processGroupIds: z.array(positiveInteger).max(1024),
    survivingProcessGroupIds: z.array(positiveInteger).max(1024),
    attemptedAt: dateTime,
  }).strict(),
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
  ContextMaterialized: z.object({ contextId: id, records: z.array(z.object({ eventId: id, type: z.enum(eventTypes), schemaVersion: positiveInteger, reason: z.string().optional() })), contentHash: digest, context: jsonValueSchema, harnessProvenance: jsonValueSchema.optional(), promptProvenance: promptProvenanceSchema.optional(), providerInputAdmission: jsonValueSchema.optional(), derivation: compactionDerivationSchema.optional() }).strict(),
  ModelCallRequested: z.object({ callId: id, contextId: id, effectId: id, modelDispatch: modelDispatchSchema, providerInput: jsonValueSchema, estimatedInputTokens: z.number().int().nonnegative(), promptProvenance: promptProvenanceSchema, attempt: positiveInteger.optional(), retryOfCallId: id.optional(), contextWindow: capacityProvenanceSchema.optional() }).strict(),
  ModelOutputChunk: z.object({ callId: id, sequence: z.number().int().nonnegative(), text: z.string() }),
  ModelCallCompleted: z.object({ callId: id, responseMessageId: id.optional(), result: modelCallResultSchema, resultDigest: fingerprint, termination: terminationSchema, usage: usageSchema.nullable(), warnings: z.array(modelWarningSchema).max(8), usageSource: usageSourceSchema }).strict(),
  ModelCallTerminated: z.object({ callId: id, outcome: z.enum(["failed", "cancelled", "unknown"]), error: z.string().optional(), failureCode: modelFailureCodeSchema.optional() }).strict().superRefine((value, context) => {
    if ((value.outcome === "failed") !== (value.failureCode !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "failed model termination requires exactly one failureCode" });
  }),
  BudgetDebited: z.object({ callId: id, tokens: nonnegative, costUsd: nonnegative, turns: nonnegative, wallTimeMs: nonnegative, usageSource: usageSourceSchema }).strict(),
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
  RecursiveModelStarted: z.object({ handleId: id, taskId: id, parentSessionId: id, parentBranchId: id, childSessionId: id, childBranchId: id, model: modelSchema, responseAdmission: responseAdmissionSchema, profilePin: profilePinSchema, inputSetId: id.optional(), input: jsonValueSchema.optional(), inputProvenance: jsonValueSchema.optional(), inputHash: digest.optional() }).strict(),
  RecursiveModelStatusChanged: z.object({ handleId: id, status: z.enum(["running", "completed", "failed", "cancelled"]), outcome: z.enum(["succeeded", "failed", "cancelled", "budget-exceeded", "unknown"]).optional(), resultMessageId: id.optional(), result: jsonValueSchema.optional(), resultArtifactId: id.optional(), error: z.string().optional() }),
  AiGenerationContextFrozen: z.object({ generationId: id, context: jsonValueSchema, provenance: jsonValueSchema, contextDigest: fingerprint, exactUtf8Bytes: z.number().int().nonnegative() }).strict(),
  AiGenerationRequested: z.object({
    generationId: id, kind: z.enum(["text", "object"]), effectId: id, idempotencyKey: id, requestDigest: fingerprint,
    cellId: id.optional(), runId: id.optional(), taskId: id.optional(), ancestorTaskIds: z.array(id).max(32),
    modelDispatch: modelDispatchSchema, providerInput: z.custom<ProviderInputCandidate>((value) => {
      try { validateProviderInputCandidate(value); return true; } catch { return false; }
    }), estimatedInputTokens: z.number().int().nonnegative(),
    contextEventId: id, contextDigest: fingerprint,
    budget: budgetSchema.extend({
      inputTokenLimit: positiveInteger.optional(),
      outputTokenLimit: positiveInteger.optional(),
      inlineResultByteLimit: positiveInteger,
    }).strict(),
    reservation: z.object({ tokens: nonnegative, costUsd: nonnegative, turns: z.literal(1), wallTimeMs: nonnegative }).strict(),
  }).strict(),
  AiGenerationStatusChanged: z.object({
    generationId: id, status: z.enum(["running", "failed", "cancelled", "unknown", "budget_exceeded"]),
    effectId: id, error: z.string().optional(),
  }).strict(),
  AiGenerationResultCommitted: z.object({
    generationId: id, effectId: id, sourceOutcomeEventId: id, kind: z.enum(["text", "object"]),
    value: jsonValueSchema, resultDigest: fingerprint, resultBytes: z.number().int().nonnegative(),
    finishReason: z.string().min(1).max(256), usage: usageSchema, warnings: z.array(modelWarningSchema).max(8),
    usageSource: usageSourceSchema,
  }).strict(),
  AiGenerationBudgetDebited: z.object({
    generationId: id, sessionId: id, branchId: id, runId: id.optional(), taskId: id.optional(),
    ancestorTaskIds: z.array(id).max(32), tokens: nonnegative, costUsd: nonnegative,
    turns: nonnegative, wallTimeMs: nonnegative, usageSource: usageSourceSchema,
    sourceResultEventId: id,
  }).strict(),
  HarnessVersionCreated: z.object({ entryId: id, versionId: id, version: positiveInteger, kind: z.enum(["memory", "prompt_note", "skill", "subagent_spec"]), scope: z.enum(["local", "workspace", "user", "global"]), scopeKey: id, name: z.string().min(1), content: jsonValueSchema, tags: z.array(z.string()), confidence: z.number().finite().min(0).max(1), status: z.enum(["candidate", "active", "retired", "rejected", "rolled_back"]), evidenceEventIds: z.array(id), conflictEntryIds: z.array(id), supersedesVersionId: id.optional(), proposalId: id.optional(), createdBy: id, lastConfirmedAt: dateTime }),
  HarnessVersionStatusChanged: z.object({ entryId: id, versionId: id, status: z.enum(["candidate", "active", "retired", "rejected", "rolled_back"]), reason: z.string().min(1), proposalId: id.optional() }),
  UserCorrection: z.object({ correctionId: id, correctedEventIds: z.array(id).min(1).max(64), correction: z.string().min(1).max(8192) }).strict(),
  RefinementReviewRequested: z.object({ reviewId: id, fingerprint, mode: z.enum(["manual", "automatic", "skill_creation"]), waitForGovernance: z.boolean(), requestedScope: z.enum(["local", "workspace", "user", "global"]), requestedScopeKey: id, allowedKinds: z.array(z.enum(["memory", "prompt_note", "skill", "subagent_spec"])).min(1).max(4), triggerId: id, triggerKind: z.enum(["manual", "repeated_effect_failure", "repeated_cell_failure", "repeated_gate_failure", "explicit_user_correction", "repeated_success", "stale_memory", "unproductive_delegation", "skill_creation"]), triggerFingerprint: fingerprint, triggerKey: id.optional(), nonterminalKey: id.optional(), triggerEvidenceThroughCursor: z.string().regex(/^\d+$/).optional(), evidenceEventIds: z.array(id).max(64), sourceEventIds: z.array(id).min(1).max(256), sourceSnapshotHash: fingerprint, sourceThroughCursor: z.string().regex(/^\d+$/), instructions: z.string().max(8192).optional(), request: jsonValueSchema, snapshot: jsonValueSchema.optional() }).strict(),
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
  GovernedRefinementProposed: z.object({ proposalId: id, proposalFingerprint: fingerprint, proposal: governedRefinementProposalSchema }).strict().superRefine((value, context) => {
    if (value.proposalId !== value.proposal.proposalId ||
        value.proposalFingerprint !== canonicalJsonDigest(value.proposal as unknown as JsonValue)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "governed proposal identity or fingerprint does not match" });
    }
    if (value.proposal.evaluation !== undefined) {
      try {
        validateObjectiveEvaluation(value.proposal.evaluation);
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error
            ? error.message
            : "governed proposal objective evaluation is invalid",
        });
      }
    }
  }),
  GovernedRefinementValidated: z.object({ proposalId: id, valid: z.boolean(), validation: jsonValueSchema, expectedStatus: z.literal("proposed") }).strict(),
  RefinementGovernanceReviewRequested: z.object({ proposalId: id, reviewId: id, frozenInput: frozenGovernanceInputSchema, frozenInputDigest: fingerprint, expectedStatus: z.literal("validated") }).strict().superRefine((value, context) => {
    if (value.frozenInput.proposal.proposalId !== value.proposalId ||
        value.frozenInput.canonicalDigest !== value.frozenInputDigest) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "frozen governance proposal identity or digest does not match" });
    }
  }),
  RefinementGovernanceReviewChildLinked: z.object({ proposalId: id, reviewId: id, handleId: id, childSessionId: id, childBranchId: id, expectedStatus: z.literal("validated") }).strict(),
  RefinementGovernanceReviewDecided: z.object({ proposalId: id, reviewId: id, decisionId: id, status: z.enum(["reviewed_rejected", "review_failed", "review_unknown", "reviewed_approved"]), decision: jsonValueSchema.optional(), reason: z.string().min(1).max(16384), expectedStatus: z.enum(["validated", "reviewing"]) }).strict().superRefine((value, context) => {
    const needsDecision = value.status === "reviewed_rejected" || value.status === "reviewed_approved";
    if (needsDecision !== (value.decision !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "governance decision presence does not match status" });
    }
    if (value.expectedStatus === "validated" && value.status !== "review_failed") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "validated governance failure must terminate as review_failed" });
    }
  }),
  GovernedRefinementApplied: z.object({ proposalId: id, decisionId: id, status: z.enum(["applied", "apply_conflict", "apply_failed"]), appliedVersionIds: z.array(id), evaluation: objectiveEvaluationSchema.optional(), reason: z.string().min(1).max(16384), expectedStatus: z.literal("reviewed_approved") }).strict(),
  RefinementProposalTerminalNoticeDelivered: z.object({ proposalId: id, noticeId: id, originSessionId: id, originBranchId: id, status: z.enum(["deterministically_rejected", "reviewed_rejected", "review_failed", "review_unknown", "apply_conflict", "apply_failed", "applied"]), result: jsonValueSchema }).strict(),
  RefinementRollbackApplied: z.object({ rollbackId: id, targetKind: z.enum(["agent_profile", "memory", "prompt_note", "skill", "subagent_spec"]), targetId: id, previousVersionId: id, restoreSourceVersionId: id, restorationVersionId: id, actor: jsonValueSchema, reason: z.string().min(1).max(1024), evidenceEventIds: z.array(id).max(32) }).strict(),
  GovernedRefinementRollbackApplied: z.object({
    proposalId: id,
    rollbackId: id,
    actions: z.array(z.discriminatedUnion("operation", [
      z.object({
        operation: z.literal("restore"),
        editIndex: z.number().int().nonnegative(),
        targetKind: z.enum(["memory", "prompt_note", "skill", "subagent_spec"]),
        targetId: id,
        appliedVersionId: id,
        restoreSourceVersionId: id,
        restorationVersionId: id,
        restorationRollbackId: id,
      }).strict(),
      z.object({
        operation: z.literal("deactivate"),
        editIndex: z.number().int().nonnegative(),
        targetKind: z.enum(["memory", "prompt_note", "skill", "subagent_spec"]),
        targetId: id,
        appliedVersionId: id,
      }).strict(),
      z.object({
        operation: z.literal("reactivate"),
        editIndex: z.number().int().nonnegative(),
        targetKind: z.enum(["memory", "prompt_note", "skill", "subagent_spec"]),
        targetId: id,
        reactivatedVersionId: id,
      }).strict(),
    ])).min(1).max(16),
    actor: jsonValueSchema,
    reason: z.string().min(1).max(1024),
    evidenceEventIds: z.array(id).max(32),
  }).strict(),
  SkillImported: z.object({ entryId: id, versionId: id, digest, scope: z.literal("workspace"), origin: z.object({ kind: z.literal("local-directory"), reference: z.string().min(1).max(4096), manifestDigest: digest, sourceDigest: digest }).strict(), installedBy: id }).strict(),
  SkillAvailabilityChanged: z.object({ entryId: id, versionId: id, digest, availability: z.enum(["enabled", "disabled", "removed"]), reason: z.string().min(1).max(4096), expectedAvailability: z.enum(["enabled", "disabled", "removed"]).optional(), expectedPreviousActionSequence: positiveInteger.nullable().optional() }).strict(),
  SkillInvocationRecorded: z.object({ entryId: id, versionId: id, effectId: id, input: jsonValueSchema }),
  SkillTestRecorded: z.object({ entryId: id, versionId: id, effectId: id, passed: z.boolean(), report: jsonValueSchema }),
  SubagentSpecInvoked: z.object({ entryId: id, versionId: id, taskId: id, childSessionId: id, childBranchId: id }),
  SyncConflictResolved: z.object({ conflictId: id, action: z.enum(["keep-branches", "choose-claim", "cancel-duplicate", "acknowledge"]), resolvedBy: id, chosenEventId: id.optional(), note: z.string().optional(), resolvedAt: dateTime }),
  AgentRunRequested: z.object({
    runId: id,
    task: z.string().min(1),
    requestKey: id,
    profilePin: profilePinSchema,
    goalId: id.optional(),
    goalMode: z.enum(["none", "auto", "current", "create"]).optional(),
    wakeId: id.optional(),
    deadline: z.object({
      startedAt: dateTime,
      deadlineAt: dateTime,
    }).strict().refine(
      (value) => Date.parse(value.deadlineAt) > Date.parse(value.startedAt),
      "Agent run deadline must be after its start",
    ).optional(),
    refinementPolicy: z.object({
      manualReviewLimit: z.number().int().min(0).max(64),
      requiredEvidenceEventCount: z.number().int().min(0).max(64),
    }).strict().refine(
      (value) => value.requiredEvidenceEventCount === 0 ||
        value.manualReviewLimit > 0,
      "Required refinement evidence needs a positive manual review limit",
    ).optional(),
  }).strict(),
  AgentInvocationContractPinned: z.object({
    runId: id,
    contract: z.custom<AgentInvocationContract>((value) => {
      try { validateAgentInvocationContract(value); return true; } catch { return false; }
    }),
  }).strict(),
  AgentRunStepStarted: z.object({ runId: id, stepId: id, ordinal: positiveInteger, contextId: id, callId: id, effectId: id, actionId: id, observationEventIds: z.array(id) }).strict(),
  AgentRunModelAttemptStarted: z.object({ runId: id, stepId: id, ordinal: positiveInteger, attempt: positiveInteger, contextId: id, callId: id, effectId: id, reason: z.enum(["initial", "proactive-compaction", "provider-overflow"]), providerInputVersion: z.literal(PROVIDER_INPUT_VERSION), providerInputDigest: fingerprint, estimatedInputTokens: z.number().int().nonnegative(), contextWindow: capacityProvenanceSchema, replNamespace: replNamespaceStatusSchema.optional(), retryOfCallId: id.optional() }).strict(),
  AgentRunActionCommitted: z.object({ runId: id, stepId: id, ordinal: positiveInteger, actionId: id, source: actionSourceSubmissionSchema, action: agentActionSchema }).strict(),
  AgentRunActionRejected: z.object({ runId: id, stepId: id, ordinal: positiveInteger, actionId: id, source: actionSourceViolationSchema, error: z.string().min(1) }).strict(),
  AgentRunTypedFinishCommitted: z.object({
    runId: id, stepId: id, ordinal: positiveInteger, actionId: id,
    source: actionSourceSubmissionSchema,
    outcome: z.union([
      z.object({ status: z.literal("succeeded"), message: z.string().min(1), value: jsonValueSchema }).strict(),
      z.object({ status: z.enum(["blocked", "failed"]), message: z.string().min(1) }).strict(),
    ]),
  }).strict(),
  AgentRunTypedActionViolationCommitted: z.object({
    runId: id, stepId: id, ordinal: positiveInteger, actionId: id,
    source: z.union([actionSourceSubmissionSchema, actionSourceViolationSchema]),
    error: z.string().min(1),
  }).strict(),
  AgentRunResultCommitted: z.object({
    runId: id, finishEventId: id, messageId: id, kind: z.enum(["text", "object"]),
    value: jsonValueSchema, valueDigest: fingerprint, resultBytes: z.number().int().nonnegative(),
    schemaDigest: fingerprint.optional(),
    reference: jsonValueSchema,
  }).strict(),
  AgentRunGoalCheckRecorded: z.object({ runId: id, actionId: id, goalId: id, requestId: id, status: z.enum(["passed", "failed", "unknown"]), summary: z.string().min(1).max(65536), gateEvaluationEventIds: z.array(id) }).strict(),
  AgentRunCancellationRequested: z.object({ runId: id, reason: z.string().optional() }).strict(),
  AgentRunStatusChanged: z.object({ runId: id, status: z.enum(["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"]), reason: z.string().optional(), finalMessageId: id.optional() }).strict(),
};

export function validateNewEvent<T extends EventType>(event: NewAgentEvent<T>): void {
  const parsed = headerSchema.safeParse(event);
  if (!parsed.success) throw new ValidationError("Invalid event header", { issues: parsed.error.issues });
  if ((event.schemaVersion ?? EVENT_SCHEMA_VERSION) !== EVENT_SCHEMA_VERSION) {
    throw new ValidationError(
      `Unsupported ${event.type} event schema version ${event.schemaVersion}. Reset local Agencity state before using schema version ${EVENT_SCHEMA_VERSION}; no legacy event is projected or executed.`,
    );
  }
  assertJsonValue(event.payload);
  const payload = payloadSchemas[event.type].safeParse(event.payload);
  if (!payload.success) throw new ValidationError(`Invalid ${event.type} payload`, { issues: payload.error.issues });
  if (event.type === "SessionCreated" &&
      (event.payload as unknown as EventPayloads["SessionCreated"]).agentProfile.agentSessionId !== event.sessionId) {
    throw new ValidationError("Initial agent profile must belong to the created session");
  }
  if (event.type === "AgentProfileVersionCreated" &&
      (event.payload as unknown as EventPayloads["AgentProfileVersionCreated"]).agentProfile.agentSessionId !== event.sessionId) {
    throw new ValidationError("Agent profile version must belong to its event session");
  }
  if (event.type === "ContextMaterialized") {
    const context = event.payload as unknown as EventPayloads["ContextMaterialized"];
    if (context.promptProvenance) validateContextPromptProvenance(context);
    if (context.providerInputAdmission) {
      reconstructProviderInputCandidate(
        context.context,
        context.providerInputAdmission,
      );
    }
  }
  if (event.type === "ModelCallRequested") {
    const modelCall = event.payload as unknown as EventPayloads["ModelCallRequested"];
    validatePromptProvenance(modelCall.promptProvenance);
    const providerInput = validateProviderInputCandidate(modelCall.providerInput);
    if (!Bun.deepEquals(providerInput.provenance.capacity, modelCall.contextWindow) ||
        providerInput.provenance.dispatchDigest !== canonicalJsonDigest(modelCall.modelDispatch as unknown as JsonValue) ||
        estimateProviderInputCandidate(providerInput).estimatedTokens !== modelCall.estimatedInputTokens) {
      throw new ValidationError("Model call provider input disagrees with retained dispatch, capacity, or estimate");
    }
  }
  if (event.type === "SessionTitleRequested") {
    const request = event.payload as unknown as EventPayloads["SessionTitleRequested"];
    if (request.mode === "model") {
      const providerInput = validateProviderInputCandidate(request.providerInput!);
      if (providerInput.provenance.dispatchDigest !==
            canonicalJsonDigest(request.modelDispatch! as unknown as JsonValue) ||
          estimateProviderInputCandidate(providerInput).estimatedTokens !==
            request.estimatedInputTokens) {
        throw new ValidationError("Session title provider input disagrees with its retained dispatch or estimate");
      }
    }
  }
  if (event.type === "ContextCompactionRequested") validateCompactionRequestIntegrity(event.payload as unknown as EventPayloads["ContextCompactionRequested"]);
  if (event.type === "RecursiveModelStarted") {
    const admission = (event.payload as unknown as EventPayloads["RecursiveModelStarted"]).responseAdmission;
    const contract = validateModelResponseContract(admission.responseContract);
    validateModelResponseContractCapability(contract, admission.responseCapability);
  }
  if (event.type === "EffectOutcomeRecorded") {
    const effect = event.payload as unknown as EventPayloads["EffectOutcomeRecorded"];
    if (effect.modelFailure !== undefined && effect.outcome !== "failed") {
      throw new ValidationError("Only failed model effects may retain modelFailure");
    }
    if (effect.output !== undefined) assertBoundedOutputs(effect.output);
  }
  if (event.type === "CellCommitted") {
    assertBoundedOutputs((event.payload as unknown as EventPayloads["CellCommitted"]).result);
  }
  if (event.type === "AgentInvocationContractPinned") {
    const payload = event.payload as unknown as EventPayloads["AgentInvocationContractPinned"];
    const contract = validateAgentInvocationContract(payload.contract);
    if (contract.runId !== payload.runId) {
      throw new ValidationError("Pinned agent invocation contract run ID disagrees with its event");
    }
  }
}

function validateContextPromptProvenance(payload: EventPayloads["ContextMaterialized"]): void {
  const provenance = payload.promptProvenance!;
  validatePromptProvenance(provenance);
  if (!payload.context || typeof payload.context !== "object" || Array.isArray(payload.context) ||
      !Array.isArray(payload.context.messages)) {
    throw new ValidationError("Invocation context must retain its provider-facing system message");
  }
  const systemMessages = payload.context.messages.filter((message) =>
    message && typeof message === "object" && !Array.isArray(message) &&
    message.role === "system" && typeof message.content === "string");
  const first = payload.context.messages[0];
  if (systemMessages.length !== 1 || first !== systemMessages[0]) {
    throw new ValidationError("Invocation context must retain exactly one leading provider-facing system message");
  }
  const content = (systemMessages[0] as { readonly content: string }).content;
  if (sha256(content) !== provenance.effectiveSystemPromptDigest) {
    throw new ValidationError("Effective system prompt digest does not match retained provider-facing bytes");
  }
}

function validatePromptProvenance(provenance: InvocationPromptProvenance): void {
  if (provenance.profileVersionId !== provenance.components.agentProfile.componentId ||
      provenance.agentPromptDigest !== provenance.components.agentProfile.digest) {
    throw new ValidationError("Prompt provenance profile component does not match its invocation pin");
  }
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

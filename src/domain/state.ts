import type {
  AgentRunActionSource, AgentRunGoalMode, AgentRunInputKind, AgentRunStatus, ArtifactReference, AutonomyOwner, BudgetLimits, ContextCompactionDerivation, ContextCompactionReason, ContextCompactionRequester, ContextCompactionStrategy, ContextCapacityProvenance, ContextRecordReference, EffectOutcome, FrozenContextCompactionSource, GoalGateStatus,
  FamilyRelationship, GoalStatus, HeartbeatStatus, MailboxMessageKind, MailboxReceiptStatus, RecursiveModelOutcome, RecursiveModelStatus,
  RefinementReviewLifecycleStatus, ScheduleStatus, SessionStatus, TaskStatus, ModelCallResult, ModelCallTermination, ModelUsageSource, Usage, WakeStatus, WorkingValue,
} from "./events.ts";
import type { ModelConfiguration, ModelDispatch, ModelWarning, RecursiveResponseAdmission } from "./model.ts";
import type { ModelEffectFailureCode } from "./model-response.ts";
import type { AgentAction } from "./agent-action.ts";
import type { JsonValue } from "./json.ts";

export const REDUCER_VERSION = 9 as const;

export interface BranchState { readonly id: string; readonly parentBranchId: string | null; readonly forkCursor: string | null; readonly name: string | null; }
export interface MessageState { readonly id: string; readonly role: "system" | "user" | "assistant" | "tool"; readonly content: string; readonly eventId: string; readonly eventCursor: string; readonly schemaVersion: number; readonly modelCallId: string | null; readonly mailbox?: { readonly mailboxMessageId: string; readonly fromSessionId: string; readonly relationship: FamilyRelationship; readonly taskId?: string; readonly artifactIds?: string[]; readonly receiptEventId: string }; }
export interface CellState { readonly id: string; readonly code: string; readonly status: "proposed" | "running" | "committed" | "failed" | "abandoned"; readonly attempts: number; readonly result?: JsonValue; readonly logs: string[]; readonly error?: string; readonly eventId: string; }
export interface WorkingValueState { readonly name: string; readonly version: number; readonly value: WorkingValue; readonly eventId: string; }
export interface EffectState { readonly id: string; readonly executor: string; readonly operation: string; readonly input: JsonValue; readonly idempotencyKey: string; readonly idempotent: boolean; readonly attempts: number; readonly status: "requested" | "started" | EffectOutcome; readonly output?: JsonValue; readonly error?: string; readonly modelFailure?: ModelEffectFailureCode; readonly eventId: string; }
export interface EffectReconciliationState { readonly id: string; readonly effectId: string; readonly assessment: "succeeded" | "failed" | "no_effect" | "still_unknown"; readonly summary: string; readonly evidence?: JsonValue; readonly recordedBy: string; readonly recordedAt: string; readonly eventId: string; }
export interface ModelCallState { readonly id: string; readonly contextId: string; readonly effectId: string; readonly modelDispatch: ModelDispatch; readonly estimatedInputTokens: number; readonly attempt: number; readonly retryOfCallId?: string; readonly contextWindow?: ContextCapacityProvenance; readonly chunks: string[]; readonly status: "requested" | EffectOutcome; readonly responseMessageId?: string; readonly result?: ModelCallResult; readonly resultDigest?: string; readonly termination?: ModelCallTermination; readonly usage?: Usage | null; readonly usageSource?: ModelUsageSource; readonly warnings?: ModelWarning[]; readonly budgetDebited?: { readonly tokens: number; readonly costUsd: number; readonly turns: number; readonly wallTimeMs: number; readonly usageSource: ModelUsageSource; readonly eventId: string }; readonly failureCode?: ModelEffectFailureCode; readonly error?: string; readonly eventId: string; }
export interface ContextState { readonly id: string; readonly records: ContextRecordReference[]; readonly contentHash: string; readonly derivation?: ContextCompactionDerivation; readonly eventId: string; }
export interface ContextCompactionState {
  readonly id: string; readonly strategy: ContextCompactionStrategy; readonly reason: ContextCompactionReason;
  readonly requestedBy: ContextCompactionRequester; readonly instructions?: string; readonly throughCursor: string;
  readonly sourceEventIds: string[]; readonly sourceDigest: string; readonly frozenSources: FrozenContextCompactionSource[];
  readonly capacity?: ContextCapacityProvenance; readonly ancestorContextId?: string; readonly rematerializedFromContextId?: string;
  readonly modelDispatch?: ModelDispatch;
  readonly status: "requested" | "completed" | "failed" | "unknown" | "protected-only" | "no-progress";
  readonly requestEventId: string; readonly contextId?: string; readonly effectIds?: string[]; readonly error?: string; readonly eventId: string;
}
export interface BudgetState { readonly limits: BudgetLimits; readonly tokens: number; readonly costUsd: number; readonly turns: number; readonly wallTimeMs: number; readonly exceeded: boolean; }

export interface TaskState {
  readonly id: string; readonly parentSessionId: string; readonly parentBranchId: string;
  readonly childSessionId: string; readonly childBranchId: string; readonly task: string;
  readonly completionCriteria: string | null; readonly model: ModelConfiguration; readonly budget: BudgetLimits;
  readonly status: TaskStatus; readonly cancellationRequested: boolean; readonly result?: JsonValue;
  readonly artifactIds: string[]; readonly error?: string; readonly reason?: string; readonly eventId: string;
}
export interface MailboxMessageState {
  readonly id: string; readonly fromSessionId: string; readonly fromBranchId: string;
  readonly toSessionId: string; readonly toBranchId: string; readonly kind: MailboxMessageKind;
  readonly content: string; readonly taskId: string | null; readonly artifactIds: string[]; readonly direction: "inbound" | "outbound";
  readonly intentKey: string | null; readonly followUp: boolean; readonly replyToMessageId: string | null;
  readonly senderRelationship: FamilyRelationship | null; readonly receiptStatus: MailboxReceiptStatus;
  readonly delivered: boolean; readonly deliveredToContext: boolean; readonly acknowledged: boolean;
  readonly followUpRunId: string | null; readonly error: string | null; readonly eventId: string;
}
export interface TerminalNoticeState {
  readonly id: string; readonly taskId: string; readonly parentSessionId: string; readonly childSessionId: string;
  readonly status: "completed" | "failed" | "cancelled"; readonly direction: "inbound" | "outbound";
  readonly result?: JsonValue; readonly artifactIds: string[]; readonly error?: string; readonly reason?: string;
  readonly delivered: boolean; readonly eventId: string;
}
export interface DocumentChunkState { readonly id: string; readonly documentId: string; readonly ordinal: number; readonly content: string; readonly size: number; readonly digest: string; readonly eventId: string; }
export interface DocumentState { readonly id: string; readonly name: string; readonly mediaType: string; readonly size: number; readonly digest: string; readonly chunkCount: number; readonly chunks: Record<string, DocumentChunkState>; readonly eventId: string; }
export interface InputSetState { readonly id: string; readonly name: string | null; readonly chunkIds: string[]; readonly metadata?: JsonValue; readonly eventId: string; }
export interface GoalGateEvaluationState { readonly id: string; readonly requestId: string; readonly definitionHash: string; readonly materialVersion: string; readonly materialEventIds: string[]; readonly status: Exclude<GoalGateStatus, "pending" | "running">; readonly effectId?: string; readonly output?: JsonValue; readonly error?: string; readonly cachedFromEvaluationId?: string; readonly eventId: string; }
export interface GoalGateState { readonly id: string; readonly name: string; readonly executor: string; readonly operation: string; readonly input: JsonValue; readonly idempotent: boolean; readonly required: boolean; readonly status: GoalGateStatus; readonly effectId?: string; readonly output?: JsonValue; readonly error?: string; readonly currentEvaluationId?: string; readonly evaluations: GoalGateEvaluationState[]; readonly eventId: string; }
export interface GoalState { readonly id: string; readonly description: string; readonly completionCriteria: string | null; readonly maxTurns: number | null; readonly status: GoalStatus; readonly completionRequestId: string | null; readonly completionWorkspaceId: string | null; readonly completionWorkspaceCursor: string | null; readonly completionMaterialVersion: string | null; readonly completionMaterialEventIds: string[]; readonly completionPinRecorded: boolean; readonly gates: Record<string, GoalGateState>; readonly reason?: string; readonly eventId: string; }
export interface HeartbeatState { readonly id: string; readonly intervalMs: number; readonly nextTickAt: string; readonly goalId: string | null; readonly prompt: string | null; readonly payload?: JsonValue; readonly owner: AutonomyOwner; readonly status: HeartbeatStatus; readonly tick: number; readonly lastFiredAt: string | null; readonly eventId: string; }
export interface ScheduleState { readonly id: string; readonly kind: "once" | "interval"; readonly prompt: string; readonly intervalMs: number | null; readonly nextTickAt: string; readonly owner: AutonomyOwner; readonly goalMode: Exclude<AgentRunGoalMode, "none">; readonly status: ScheduleStatus; readonly tick: number; readonly lastFiredAt: string | null; readonly reason?: string; readonly eventId: string; }
export interface WakeState { readonly id: string; readonly sourceType: "heartbeat" | "schedule"; readonly sourceId: string; readonly tick: number; readonly scheduledAt: string; readonly firedAt: string; readonly prompt: string; readonly goalId: string | null; readonly goalMode: AgentRunGoalMode; readonly status: WakeStatus; readonly claimId: string | null; readonly claimedAt: string | null; readonly runId: string | null; readonly deliveredAt: string | null; readonly reason?: string; readonly eventId: string; }
export interface RecursiveModelState { readonly id: string; readonly taskId: string; readonly parentSessionId: string; readonly parentBranchId: string; readonly childSessionId: string; readonly childBranchId: string; readonly model: ModelConfiguration; readonly responseAdmission: RecursiveResponseAdmission; readonly inputSetId: string | null; readonly input?: JsonValue; readonly inputProvenance?: JsonValue; readonly inputHash?: string; readonly status: RecursiveModelStatus; readonly outcome?: RecursiveModelOutcome; readonly resultMessageId?: string; readonly result?: JsonValue; readonly resultArtifactId?: string; readonly error?: string; readonly eventId: string; }


export interface UserCorrectionState { readonly id: string; readonly correctedEventIds: string[]; readonly correction: string; readonly eventId: string; }
export interface RefinementReviewState {
  readonly id: string; readonly fingerprint: string; readonly mode: "manual" | "automatic" | "skill_creation";
  readonly requestedScope: "local" | "workspace" | "user" | "global"; readonly requestedScopeKey: string;
  readonly allowedKinds: ("memory" | "prompt_note" | "skill" | "subagent_spec")[];
  readonly triggerId: string; readonly triggerKind: string; readonly triggerFingerprint: string;
  readonly triggerKey?: string; readonly nonterminalKey?: string; readonly triggerEvidenceThroughCursor?: string; readonly evidenceEventIds: string[];
  readonly sourceEventIds: string[]; readonly sourceSnapshotHash: string; readonly sourceThroughCursor: string;
  readonly instructions?: string; readonly status: RefinementReviewLifecycleStatus; readonly handleId?: string;
  readonly childSessionId?: string; readonly childBranchId?: string; readonly decisionFingerprint?: string;
  readonly proposalId?: string; readonly reason?: string; readonly requestEventId: string; readonly eventId: string;
}
export interface RefinementTriggerConsumptionState { readonly triggerKey: string; readonly lastConsumedEvidenceCursor: string; readonly reviewId: string; readonly eventId: string; }

export interface AgentRunModelAttemptState {
  readonly attempt: number; readonly contextId: string; readonly callId: string; readonly effectId: string;
  readonly reason: "initial" | "proactive-compaction" | "provider-overflow"; readonly estimatedInputTokens: number;
  readonly contextWindow: ContextCapacityProvenance; readonly retryOfCallId?: string; readonly eventId: string;
}
export interface AgentRunStepState {
  readonly id: string; readonly ordinal: number; readonly contextId: string; readonly callId: string;
  readonly effectId: string; readonly actionId: string; readonly observationEventIds: string[]; readonly modelAttempts: AgentRunModelAttemptState[];
  readonly action?: AgentAction; readonly actionSource?: AgentRunActionSource; readonly rejection?: string; readonly eventId: string;
}
export interface AgentRunInputRequestState {
  readonly id: string; readonly actionId: string; readonly kind: AgentRunInputKind; readonly question: string;
  readonly permission?: string; readonly response?: string; readonly approved?: boolean; readonly requestedEventId: string;
  readonly receivedEventId?: string;
}
export interface AgentRunGoalCheckState { readonly actionId: string; readonly goalId: string; readonly requestId: string; readonly status: "passed" | "failed" | "unknown"; readonly summary: string; readonly gateEvaluationEventIds: string[]; readonly eventId: string; }
export interface AgentRunState {
  readonly id: string; readonly task: string; readonly requestKey: string; readonly goalId: string | null; readonly goalMode: AgentRunGoalMode; readonly wakeId: string | null;
  readonly status: AgentRunStatus; readonly steps: AgentRunStepState[]; readonly inputRequests: Record<string, AgentRunInputRequestState>; readonly goalChecks: Record<string, AgentRunGoalCheckState>;
  readonly cancellationRequested: boolean; readonly cancellationReason?: string; readonly reason?: string;
  readonly finalMessageId?: string; readonly requestEventId: string; readonly eventId: string;
}

export interface AgentState {
  readonly reducerVersion: typeof REDUCER_VERSION; readonly sessionId: string; readonly workspaceId: string; readonly sessionName?: string | null; readonly branch: BranchState;
  readonly parentSessionId: string | null; readonly parentBranchId: string | null; readonly rootSessionId: string;
  readonly depth: number; readonly taskId: string | null;
  readonly model: ModelConfiguration; readonly status: SessionStatus; readonly cursor: string; readonly appliedEventIds: string[];
  readonly messages: MessageState[]; readonly cells: Record<string, CellState>; readonly workingValues: Record<string, WorkingValueState>;
  readonly artifacts: Record<string, ArtifactReference>; readonly effects: Record<string, EffectState>; readonly effectReconciliations: Record<string, EffectReconciliationState>; readonly contexts: Record<string, ContextState>; readonly compactions: Record<string, ContextCompactionState>;
  readonly modelCalls: Record<string, ModelCallState>; readonly budget: BudgetState;
  readonly tasks: Record<string, TaskState>; readonly mailbox: Record<string, MailboxMessageState>;
  readonly terminalNotices: Record<string, TerminalNoticeState>; readonly documents: Record<string, DocumentState>;
  readonly inputSets: Record<string, InputSetState>; readonly goals: Record<string, GoalState>;
  readonly heartbeats: Record<string, HeartbeatState>; readonly schedules: Record<string, ScheduleState>; readonly wakes: Record<string, WakeState>; readonly recursiveModels: Record<string, RecursiveModelState>;
  readonly agentRuns: Record<string, AgentRunState>; readonly userCorrections: Record<string, UserCorrectionState>; readonly refinementReviews: Record<string, RefinementReviewState>; readonly refinementTriggerConsumptions: Record<string, RefinementTriggerConsumptionState>;
}

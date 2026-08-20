import type {
  AgentRunActionSource, AgentRunDeadline, AgentRunGoalMode, AgentRunRefinementPolicy, AgentRunStatus, AgentRunTypedFinishOutcome, ArtifactReference, AutonomyOwner, BudgetLimits, ContextCompactionDerivation, ContextCompactionReason, ContextCompactionRequester, ContextCompactionStrategy, ContextCapacityProvenance, ContextRecordReference, EffectOrigin, EffectOutcome, FrozenContextCompactionSource, GoalGateStatus,
  AiGenerationBudgetLimits, AiGenerationKind, AiGenerationStatus, CellLogStream, FamilyRelationship, GoalStatus, HeartbeatStatus, MailboxMessageKind, MailboxReceiptStatus, RecursiveModelOutcome, RecursiveModelStatus,
  ManagedProcessStatus, RefinementReviewLifecycleStatus, ScheduleStatus, SessionStatus, TaskStatus, ModelCallResult, ModelCallTermination, ModelUsageSource, Usage, WakeStatus, WorkingValue,
} from "./events.ts";
import type { ModelConfiguration, ModelDispatch, ModelWarning, RecursiveResponseAdmission } from "./model.ts";
import type { ModelEffectFailureCode } from "./model-response.ts";
import type { ProviderInputAdmission, ProviderInputCandidate } from "./provider-input.ts";
import type { AgentAction } from "./agent-action.ts";
import type { AgentInvocationProfilePin, AgentProfileVersion, InvocationPromptProvenance } from "./agent-profile.ts";
import type { JsonValue } from "./json.ts";
import type { AgentInvocationContract, AgentRunResultReference } from "./agent-invocation-contract.ts";
import type { ReplNamespaceStatus } from "./repl-namespace.ts";

export const REDUCER_VERSION = 21 as const;

export interface BranchState { readonly id: string; readonly parentBranchId: string | null; readonly forkCursor: string | null; readonly name: string | null; }
export interface MessageState { readonly id: string; readonly role: "system" | "user" | "assistant" | "tool"; readonly content: string; readonly eventId: string; readonly eventCursor: string; readonly schemaVersion: number; readonly modelCallId: string | null; readonly mailbox?: { readonly mailboxMessageId: string; readonly fromSessionId: string; readonly relationship: FamilyRelationship; readonly taskId?: string; readonly artifactIds?: string[]; readonly receiptEventId: string }; }
export interface CellState { readonly id: string; readonly code: string; readonly status: "proposed" | "running" | "committed" | "failed" | "abandoned"; readonly attempts: number; readonly result?: JsonValue; readonly logs: string[]; readonly logStreams: CellLogStream[]; readonly error?: string; readonly causalEffectOutcomeEventIds?: string[]; readonly eventId: string; }
export interface WorkingValueState { readonly name: string; readonly version: number; readonly value: WorkingValue; readonly eventId: string; }
export interface EffectState { readonly id: string; readonly executor: string; readonly operation: string; readonly input: JsonValue; readonly origin: EffectOrigin; readonly idempotencyKey: string; readonly idempotent: boolean; readonly attempts: number; readonly status: "requested" | "started" | EffectOutcome; readonly output?: JsonValue; readonly error?: string; readonly modelFailure?: ModelEffectFailureCode; readonly eventId: string; }
export interface EffectReconciliationState { readonly id: string; readonly effectId: string; readonly assessment: "succeeded" | "failed" | "no_effect" | "still_unknown"; readonly summary: string; readonly evidence?: JsonValue; readonly recordedBy: string; readonly recordedAt: string; readonly eventId: string; }
export interface ManagedProcessState {
  readonly id: string; readonly effectId: string; readonly workspaceId: string;
  readonly sessionId: string; readonly branchId: string; readonly runId: string | null;
  readonly cellId: string; readonly command: string; readonly cwd: string | null;
  readonly identityToken: string; readonly status: ManagedProcessStatus;
  readonly pid: number | null; readonly processGroupId: number | null;
  readonly requestedAt: string; readonly startedAt: string | null;
  readonly output?: JsonValue; readonly error?: string; readonly eventId: string;
}
export interface ModelCallState { readonly id: string; readonly contextId: string; readonly effectId: string; readonly modelDispatch: ModelDispatch; readonly providerInput: ProviderInputCandidate; readonly estimatedInputTokens: number; readonly promptProvenance: InvocationPromptProvenance; readonly attempt: number; readonly retryOfCallId?: string; readonly contextWindow?: ContextCapacityProvenance; readonly chunks: string[]; readonly status: "requested" | EffectOutcome; readonly responseMessageId?: string; readonly result?: ModelCallResult; readonly resultDigest?: string; readonly termination?: ModelCallTermination; readonly usage?: Usage | null; readonly usageSource?: ModelUsageSource; readonly warnings?: ModelWarning[]; readonly budgetDebited?: { readonly tokens: number; readonly costUsd: number; readonly turns: number; readonly wallTimeMs: number; readonly usageSource: ModelUsageSource; readonly eventId: string }; readonly failureCode?: ModelEffectFailureCode; readonly error?: string; readonly eventId: string; }
export interface ContextState { readonly id: string; readonly records: ContextRecordReference[]; readonly contentHash: string; readonly promptProvenance?: InvocationPromptProvenance; readonly providerInputAdmission?: ProviderInputAdmission; readonly derivation?: ContextCompactionDerivation; readonly eventId: string; }
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
  readonly intentKey: string | null; readonly mode: "steer" | "queue"; readonly replyToMessageId: string | null;
  readonly senderRelationship: FamilyRelationship | null; readonly receiptStatus: MailboxReceiptStatus;
  readonly delivered: boolean; readonly deliveredToContext: boolean; readonly acknowledged: boolean;
  readonly contextRunId: string | null; readonly error: string | null; readonly eventId: string;
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
export interface RecursiveModelState { readonly id: string; readonly taskId: string; readonly parentSessionId: string; readonly parentBranchId: string; readonly childSessionId: string; readonly childBranchId: string; readonly model: ModelConfiguration; readonly responseAdmission: RecursiveResponseAdmission; readonly profilePin: AgentInvocationProfilePin; readonly inputSetId: string | null; readonly input?: JsonValue; readonly inputProvenance?: JsonValue; readonly inputHash?: string; readonly status: RecursiveModelStatus; readonly outcome?: RecursiveModelOutcome; readonly resultMessageId?: string; readonly result?: JsonValue; readonly resultArtifactId?: string; readonly error?: string; readonly eventId: string; }
export interface AiGenerationState {
  readonly id: string; readonly kind?: AiGenerationKind; readonly status: AiGenerationStatus;
  readonly context?: JsonValue; readonly contextProvenance?: JsonValue; readonly contextDigest?: string; readonly contextBytes?: number;
  readonly effectId?: string; readonly idempotencyKey?: string; readonly requestDigest?: string; readonly cellId?: string; readonly runId?: string; readonly taskId?: string;
  readonly ancestorTaskIds: string[]; readonly modelDispatch?: ModelDispatch; readonly providerInput?: ProviderInputCandidate;
  readonly estimatedInputTokens?: number; readonly budget?: AiGenerationBudgetLimits;
  readonly reservation?: { readonly tokens: number; readonly costUsd: number; readonly turns: 1; readonly wallTimeMs: number };
  readonly value?: JsonValue; readonly resultDigest?: string; readonly resultBytes?: number; readonly finishReason?: string;
  readonly usage?: Usage; readonly warnings?: ModelWarning[]; readonly usageSource?: ModelUsageSource;
  readonly budgetDebited?: { readonly tokens: number; readonly costUsd: number; readonly turns: number; readonly wallTimeMs: number; readonly usageSource: ModelUsageSource; readonly eventId: string };
  readonly error?: string; readonly requestEventId?: string; readonly resultEventId?: string; readonly eventId: string;
}


export interface UserCorrectionState { readonly id: string; readonly correctedEventIds: string[]; readonly correction: string; readonly eventId: string; }
export interface RefinementReviewState {
  readonly id: string; readonly fingerprint: string; readonly mode: "manual" | "automatic" | "skill_creation";
  readonly waitForGovernance: boolean;
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
  readonly providerInputVersion: string; readonly providerInputDigest: string;
  readonly contextWindow: ContextCapacityProvenance; readonly replNamespace?: ReplNamespaceStatus;
  readonly retryOfCallId?: string; readonly eventId: string;
}
export interface AgentRunStepState {
  readonly id: string; readonly ordinal: number; readonly contextId: string; readonly callId: string;
  readonly effectId: string; readonly actionId: string; readonly observationEventIds: string[]; readonly modelAttempts: AgentRunModelAttemptState[];
  readonly action?: AgentAction; readonly typedFinish?: AgentRunTypedFinishOutcome;
  readonly typedFinishEventId?: string; readonly actionSource?: AgentRunActionSource;
  readonly rejection?: string; readonly startedEventId?: string; readonly eventId: string;
}
export interface AgentRunGoalCheckState { readonly actionId: string; readonly goalId: string; readonly requestId: string; readonly status: "passed" | "failed" | "unknown"; readonly summary: string; readonly gateEvaluationEventIds: string[]; readonly eventId: string; }
export interface AgentRunState {
  readonly id: string; readonly task: string; readonly requestKey: string; readonly profilePin: AgentInvocationProfilePin; readonly goalId: string | null; readonly goalMode: AgentRunGoalMode; readonly wakeId: string | null;
  readonly deadline?: AgentRunDeadline | null;
  readonly refinementPolicy?: AgentRunRefinementPolicy | null;
  readonly status: AgentRunStatus; readonly steps: AgentRunStepState[]; readonly goalChecks: Record<string, AgentRunGoalCheckState>;
  readonly cancellationRequested: boolean; readonly cancellationReason?: string; readonly reason?: string;
  readonly invocationContract?: AgentInvocationContract;
  readonly result?: {
    readonly kind: "text" | "object"; readonly value: JsonValue; readonly valueDigest: string;
    readonly resultBytes: number; readonly schemaDigest?: string; readonly finishEventId: string;
    readonly messageId: string; readonly reference: AgentRunResultReference; readonly eventId: string;
  };
  readonly finalMessageId?: string; readonly requestEventId: string; readonly eventId: string;
}

export interface AgentState {
  readonly reducerVersion: typeof REDUCER_VERSION; readonly sessionId: string; readonly workspaceId: string; readonly sessionName?: string | null; readonly branch: BranchState;
  readonly parentSessionId: string | null; readonly parentBranchId: string | null; readonly rootSessionId: string;
  readonly depth: number; readonly taskId: string | null;
  readonly agentProfiles: Record<string, AgentProfileVersion>; readonly activeAgentProfileVersionId: string;
  readonly model: ModelConfiguration; readonly status: SessionStatus; readonly cursor: string; readonly appliedEventIds: string[];
  readonly messages: MessageState[]; readonly cells: Record<string, CellState>; readonly workingValues: Record<string, WorkingValueState>;
  readonly artifacts: Record<string, ArtifactReference>; readonly effects: Record<string, EffectState>; readonly effectReconciliations: Record<string, EffectReconciliationState>; readonly managedProcesses: Record<string, ManagedProcessState>; readonly contexts: Record<string, ContextState>; readonly compactions: Record<string, ContextCompactionState>;
  readonly modelCalls: Record<string, ModelCallState>; readonly budget: BudgetState;
  readonly tasks: Record<string, TaskState>; readonly mailbox: Record<string, MailboxMessageState>;
  readonly taskUsageAttributions: Record<string, string>;
  readonly terminalNotices: Record<string, TerminalNoticeState>; readonly documents: Record<string, DocumentState>;
  readonly inputSets: Record<string, InputSetState>; readonly goals: Record<string, GoalState>;
  readonly heartbeats: Record<string, HeartbeatState>; readonly schedules: Record<string, ScheduleState>; readonly wakes: Record<string, WakeState>; readonly recursiveModels: Record<string, RecursiveModelState>; readonly aiGenerations: Record<string, AiGenerationState>;
  readonly agentRuns: Record<string, AgentRunState>; readonly userCorrections: Record<string, UserCorrectionState>; readonly refinementReviews: Record<string, RefinementReviewState>; readonly refinementTriggerConsumptions: Record<string, RefinementTriggerConsumptionState>;
}

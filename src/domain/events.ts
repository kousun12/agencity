import { ulid } from "ulid";
import { z } from "zod";
import type { JsonValue } from "./json.ts";
import { assertJsonValue } from "./json.ts";
import { ValidationError } from "./errors.ts";
import { agentActionSchema, type AgentAction } from "./agent-action.ts";

export const EVENT_SCHEMA_VERSION = 1 as const;
export const eventTypes = [
  "SessionCreated", "BranchCreated", "SessionNamed", "BranchNamed", "SessionStatusChanged", "MessageAppended",
  "CellProposed", "CellStarted", "CellCommitted", "CellFailed", "CellAbandoned",
  "WorkingValueSet", "ArtifactRegistered", "EffectRequested", "EffectAttemptStarted",
  "EffectOutcomeRecorded", "ContextMaterialized", "ModelCallRequested", "ModelOutputChunk",
  "ModelCallCompleted", "ModelCallTerminated", "BudgetDebited", "BudgetExceeded", "RecoveryPerformed",
  "TaskCreated", "SubagentAdmitted", "TaskStatusChanged", "SubagentCancellationRequested", "TaskUsageAttributed",
  "MailboxMessageSent", "MailboxMessageDelivered", "MailboxMessageAcknowledged",
  "TaskTerminalNoticeSent", "TaskTerminalNoticeDelivered",
  "DocumentImported", "DocumentChunkAdded", "InputSetCreated",
  "GoalCreated", "GoalCompletionRequested", "GoalGateAdded", "GoalGateStatusChanged", "GoalStatusChanged",
  "HeartbeatCreated", "HeartbeatTicked", "HeartbeatStatusChanged",
  "RecursiveModelStarted", "RecursiveModelStatusChanged",
  "HarnessVersionCreated", "HarnessVersionStatusChanged",
  "RefinementProposed", "RefinementValidated", "RefinementCandidateActivated",
  "RefinementCandidateAllocated", "RefinementCandidateExposed", "RefinementObservationRecorded",
  "RefinementDecided", "RefinementApproved", "RefinementRollbackApproved", "RefinementRolledBack",
  "SkillInvocationRecorded", "SkillTestRecorded", "SubagentSpecInvoked", "SyncConflictResolved",
  "AgentRunRequested", "AgentRunStepStarted", "AgentRunActionCommitted", "AgentRunActionRejected",
  "AgentRunUserInputRequested", "AgentRunUserInputReceived", "AgentRunCancellationRequested", "AgentRunStatusChanged",
] as const;
export type EventType = (typeof eventTypes)[number];
export type Producer = "supervisor" | "console" | "model" | "executor" | "client" | "recovery" | "scheduler" | string;
export type SessionStatus = "idle" | "running" | "stopped" | "failed" | "archived";
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type EffectOutcome = "succeeded" | "failed" | "cancelled" | "unknown";
export type TaskStatus = "pending" | "admitted" | "running" | "completed" | "failed" | "cancelled";
export type MailboxMessageKind = "message" | "task_completed" | "task_failed" | "task_cancelled";
export type GoalStatus = "active" | "completion_requested" | "completed" | "blocked" | "failed" | "cancelled";
export type GoalGateStatus = "pending" | "running" | "passed" | "failed" | "cancelled" | "unknown";
export type HeartbeatStatus = "active" | "paused" | "cancelled";
export type RecursiveModelStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type RecursiveModelOutcome = "succeeded" | "failed" | "cancelled" | "budget-exceeded" | "unknown";
export type AgentRunStatus = "queued" | "running" | "waiting_for_user" | "succeeded" | "blocked" | "failed" | "cancelled" | "budget_exceeded" | "unknown";
export type AgentRunInputKind = "clarification" | "permission";

export interface BudgetLimits { readonly tokenLimit?: number; readonly costLimitUsd?: number; readonly turnLimit?: number; readonly wallTimeLimitMs?: number; }
export interface ModelConfiguration { readonly provider: string; readonly model: string; readonly temperature?: number; readonly maxOutputTokens?: number; }
export interface Usage { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number; }
export interface ArtifactReference { readonly artifactId: string; readonly digest: string; readonly mediaType: string; readonly size: number; }
export type WorkingValue = { readonly kind: "json"; readonly value: JsonValue } | { readonly kind: "artifact"; readonly artifactId: string };
export interface ContextRecordReference { readonly eventId: string; readonly type: EventType; readonly schemaVersion: number; readonly reason?: string; }

export interface EventPayloads {
  SessionCreated: { workspaceId: string; initialBranchId: string; model: ModelConfiguration; budget: BudgetLimits; sessionName?: string; initialBranchName?: string; parentSessionId?: string; parentBranchId?: string; rootSessionId?: string; depth?: number; taskId?: string };
  BranchCreated: { branchId: string; parentBranchId: string; forkCursor: string; name?: string };
  SessionNamed: { name: string };
  BranchNamed: { name: string };
  SessionStatusChanged: { status: SessionStatus; reason?: string };
  MessageAppended: { messageId: string; role: MessageRole; content: string; modelCallId?: string };
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
  ContextMaterialized: { contextId: string; records: ContextRecordReference[]; contentHash: string; context: JsonValue; harnessProvenance?: JsonValue };
  ModelCallRequested: { callId: string; contextId: string; effectId: string; provider: string; model: string };
  ModelOutputChunk: { callId: string; sequence: number; text: string };
  ModelCallCompleted: { callId: string; responseMessageId: string; finishReason: string; usage: Usage };
  ModelCallTerminated: { callId: string; outcome: Exclude<EffectOutcome, "succeeded">; error?: string };
  BudgetDebited: { callId: string; tokens: number; costUsd: number; turns: number; wallTimeMs: number };
  BudgetExceeded: { dimension: "tokens" | "cost" | "turns" | "wallTime"; limit: number; spent: number };
  RecoveryPerformed: { abandonedCellIds: string[]; unknownEffectIds: string[]; retriedEffectIds: string[] };
  TaskCreated: { taskId: string; parentSessionId: string; parentBranchId: string; childSessionId: string; childBranchId: string; task: string; completionCriteria?: string; model: ModelConfiguration; budget: BudgetLimits };
  SubagentAdmitted: { taskId: string; childSessionId: string; childBranchId: string; admittedAt: string };
  TaskStatusChanged: { taskId: string; status: Exclude<TaskStatus, "pending">; result?: JsonValue; artifactIds?: string[]; error?: string; reason?: string };
  SubagentCancellationRequested: { taskId: string; childSessionId: string; reason?: string };
  TaskUsageAttributed: { taskId: string; childSessionId: string; tokens: number; costUsd: number; turns: number; wallTimeMs: number; conservative: boolean };
  MailboxMessageSent: { mailboxMessageId: string; fromSessionId: string; fromBranchId: string; toSessionId: string; toBranchId: string; kind: MailboxMessageKind; content: string; taskId?: string };
  MailboxMessageDelivered: { mailboxMessageId: string; sentEventId: string; fromSessionId: string; fromBranchId: string; toSessionId: string; toBranchId: string; kind: MailboxMessageKind; content: string; taskId?: string };
  MailboxMessageAcknowledged: { mailboxMessageId: string; acknowledgedBySessionId: string; acknowledgedAt: string };
  TaskTerminalNoticeSent: { noticeId: string; taskId: string; parentSessionId: string; childSessionId: string; status: "completed" | "failed" | "cancelled"; result?: JsonValue; artifactIds?: string[]; error?: string; reason?: string };
  TaskTerminalNoticeDelivered: { noticeId: string; sentEventId: string; taskId: string; parentSessionId: string; childSessionId: string; status: "completed" | "failed" | "cancelled"; result?: JsonValue; artifactIds?: string[]; error?: string; reason?: string };
  DocumentImported: { documentId: string; name: string; mediaType: string; size: number; digest: string; chunkCount: number };
  DocumentChunkAdded: { documentId: string; chunkId: string; ordinal: number; content: string; size: number; digest: string };
  InputSetCreated: { inputSetId: string; name?: string; chunkIds: string[]; metadata?: JsonValue };
  GoalCreated: { goalId: string; description: string; completionCriteria?: string; maxTurns?: number };
  GoalCompletionRequested: { goalId: string; requestId: string; workspaceId?: string; workspaceCursor?: string | null };
  GoalGateAdded: { goalId: string; gateId: string; name: string; executor: string; operation: string; input: JsonValue; idempotent: boolean; required: boolean };
  GoalGateStatusChanged: { goalId: string; gateId: string; status: GoalGateStatus; effectId?: string; output?: JsonValue; error?: string };
  GoalStatusChanged: { goalId: string; status: GoalStatus; reason?: string };
  HeartbeatCreated: { heartbeatId: string; intervalMs: number; nextTickAt: string; goalId?: string; payload?: JsonValue };
  HeartbeatTicked: { heartbeatId: string; tick: number; scheduledAt: string; firedAt: string; nextTickAt: string };
  HeartbeatStatusChanged: { heartbeatId: string; status: HeartbeatStatus; nextTickAt?: string; reason?: string };
  RecursiveModelStarted: { handleId: string; taskId: string; parentSessionId: string; parentBranchId: string; childSessionId: string; childBranchId: string; model: ModelConfiguration; inputSetId?: string; input?: JsonValue; inputProvenance?: JsonValue; inputHash?: string };
  RecursiveModelStatusChanged: { handleId: string; status: Exclude<RecursiveModelStatus, "pending">; outcome?: RecursiveModelOutcome; resultMessageId?: string; result?: JsonValue; resultArtifactId?: string; error?: string };
  HarnessVersionCreated: { entryId: string; versionId: string; version: number; kind: "memory" | "prompt_note" | "skill" | "subagent_spec"; scope: "local" | "workspace" | "user" | "global"; scopeKey: string; name: string; content: JsonValue; tags: string[]; confidence: number; status: "candidate" | "active" | "retired" | "rejected" | "rolled_back"; evidenceEventIds: string[]; conflictEntryIds: string[]; supersedesVersionId?: string; proposalId?: string; createdBy: string; lastConfirmedAt: string };
  HarnessVersionStatusChanged: { entryId: string; versionId: string; status: "candidate" | "active" | "retired" | "rejected" | "rolled_back"; reason: string; proposalId?: string };
  RefinementProposed: { proposalId: string; trigger: string; predictedEffect: string; edits: JsonValue; evidenceEventIds: string[]; evaluation: JsonValue; authority: "agent" | "user" | "system" };
  RefinementValidated: { proposalId: string; valid: boolean; validation: JsonValue; expectedProposalStatus: "proposed" };
  RefinementCandidateActivated: { proposalId: string; candidateId: string; versionIds: string[]; allocationLimit: number; exposureLimit: number };
  RefinementCandidateAllocated: { proposalId: string; candidateId: string; allocationId: string; targetSessionId: string; targetBranchId: string; taskId?: string; ordinal: number };
  RefinementCandidateExposed: { proposalId: string; candidateId: string; allocationId: string; exposedVersionIds: string[] };
  RefinementObservationRecorded: { proposalId: string; candidateId: string; allocationId: string; observationId: string; evaluator: string; objective: boolean; success: boolean; metric: JsonValue; baseline?: JsonValue; evidenceEventIds: string[]; notes?: string };
  RefinementDecided: { proposalId: string; candidateId: string; decisionId: string; decision: "promote" | "revise" | "reject"; rule: string; evaluator: string; baseline?: JsonValue; observationIds: string[] };
  RefinementApproved: { proposalId: string; approvedBy: string; scope: "user" | "global"; note?: string };
  RefinementRollbackApproved: { proposalId: string; approvedBy: string; role: "owner" | "admin"; note?: string };
  RefinementRolledBack: { proposalId: string; candidateId: string; rollbackId: string; versionIds: string[]; restoredVersionIds: string[]; reason: string };
  SkillInvocationRecorded: { entryId: string; versionId: string; effectId: string; input: JsonValue };
  SkillTestRecorded: { entryId: string; versionId: string; effectId: string; passed: boolean; report: JsonValue };
  SubagentSpecInvoked: { entryId: string; versionId: string; taskId: string; childSessionId: string; childBranchId: string };
  SyncConflictResolved: { conflictId: string; action: "keep-branches" | "choose-claim" | "cancel-duplicate" | "acknowledge"; resolvedBy: string; chosenEventId?: string; note?: string; resolvedAt: string };
  AgentRunRequested: { runId: string; task: string; requestKey: string; goalId?: string };
  AgentRunStepStarted: { runId: string; stepId: string; ordinal: number; contextId: string; callId: string; effectId: string; actionId: string; observationEventIds: string[] };
  AgentRunActionCommitted: { runId: string; stepId: string; ordinal: number; actionId: string; callId: string; raw: string; action: AgentAction };
  AgentRunActionRejected: { runId: string; stepId: string; ordinal: number; actionId: string; callId: string; raw: string; error: string };
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
const dateTime = z.string().datetime();
const jsonValueSchema = z.custom<JsonValue>((value) => { try { assertJsonValue(value); return true; } catch { return false; } }, "Expected a JSON value");
const budgetSchema = z.object({ tokenLimit: nonnegative.optional(), costLimitUsd: nonnegative.optional(), turnLimit: nonnegative.optional(), wallTimeLimitMs: nonnegative.optional() });
const modelSchema = z.object({ provider: id, model: id, temperature: z.number().finite().optional(), maxOutputTokens: nonnegative.optional() });
const usageSchema = z.object({ inputTokens: nonnegative, outputTokens: nonnegative, costUsd: nonnegative });
const artifactSchema = z.object({ artifactId: id, digest, mediaType: id, size: nonnegative });
const workingValueSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("json"), value: jsonValueSchema }), z.object({ kind: z.literal("artifact"), artifactId: id })]);
const taskTerminalSchema = z.object({ noticeId: id, taskId: id, parentSessionId: id, childSessionId: id, status: z.enum(["completed", "failed", "cancelled"]), result: jsonValueSchema.optional(), artifactIds: z.array(id).optional(), error: z.string().optional(), reason: z.string().optional() });
const mailboxBaseSchema = z.object({ mailboxMessageId: id, fromSessionId: id, fromBranchId: id, toSessionId: id, toBranchId: id, kind: z.enum(["message", "task_completed", "task_failed", "task_cancelled"]), content: z.string(), taskId: id.optional() });
const payloadSchemas: Record<EventType, z.ZodType> = {
  SessionCreated: z.object({ workspaceId: id, initialBranchId: id, model: modelSchema, budget: budgetSchema, sessionName: z.string().min(1).optional(), initialBranchName: z.string().min(1).optional(), parentSessionId: id.optional(), parentBranchId: id.optional(), rootSessionId: id.optional(), depth: z.number().int().nonnegative().optional(), taskId: id.optional() }),
  BranchCreated: z.object({ branchId: id, parentBranchId: id, forkCursor: z.string().regex(/^\d+$/), name: z.string().optional() }),
  SessionNamed: z.object({ name: z.string().min(1) }),
  BranchNamed: z.object({ name: z.string().min(1) }),
  SessionStatusChanged: z.object({ status: z.enum(["idle", "running", "stopped", "failed", "archived"]), reason: z.string().optional() }),
  MessageAppended: z.object({ messageId: id, role: z.enum(["system", "user", "assistant", "tool"]), content: z.string(), modelCallId: id.optional() }),
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
  ContextMaterialized: z.object({ contextId: id, records: z.array(z.object({ eventId: id, type: z.enum(eventTypes), schemaVersion: positiveInteger, reason: z.string().optional() })), contentHash: digest, context: jsonValueSchema, harnessProvenance: jsonValueSchema.optional() }),
  ModelCallRequested: z.object({ callId: id, contextId: id, effectId: id, provider: id, model: id }),
  ModelOutputChunk: z.object({ callId: id, sequence: z.number().int().nonnegative(), text: z.string() }),
  ModelCallCompleted: z.object({ callId: id, responseMessageId: id, finishReason: z.string(), usage: usageSchema }),
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
  MailboxMessageDelivered: mailboxBaseSchema.extend({ sentEventId: id }),
  MailboxMessageAcknowledged: z.object({ mailboxMessageId: id, acknowledgedBySessionId: id, acknowledgedAt: dateTime }),
  TaskTerminalNoticeSent: taskTerminalSchema,
  TaskTerminalNoticeDelivered: taskTerminalSchema.extend({ sentEventId: id }),
  DocumentImported: z.object({ documentId: id, name: z.string().min(1), mediaType: id, size: nonnegative, digest, chunkCount: z.number().int().nonnegative() }),
  DocumentChunkAdded: z.object({ documentId: id, chunkId: id, ordinal: z.number().int().nonnegative(), content: z.string(), size: nonnegative, digest }),
  InputSetCreated: z.object({ inputSetId: id, name: z.string().optional(), chunkIds: z.array(id), metadata: jsonValueSchema.optional() }),
  GoalCreated: z.object({ goalId: id, description: z.string().min(1), completionCriteria: z.string().optional(), maxTurns: positiveInteger.optional() }),
  GoalCompletionRequested: z.object({ goalId: id, requestId: id, workspaceId: id.optional(), workspaceCursor: z.string().regex(/^\d+$/).nullable().optional() }),
  GoalGateAdded: z.object({ goalId: id, gateId: id, name: z.string().min(1), executor: id, operation: id, input: jsonValueSchema, idempotent: z.boolean(), required: z.boolean() }),
  GoalGateStatusChanged: z.object({ goalId: id, gateId: id, status: z.enum(["pending", "running", "passed", "failed", "cancelled", "unknown"]), effectId: id.optional(), output: jsonValueSchema.optional(), error: z.string().optional() }),
  GoalStatusChanged: z.object({ goalId: id, status: z.enum(["active", "completion_requested", "completed", "blocked", "failed", "cancelled"]), reason: z.string().optional() }),
  HeartbeatCreated: z.object({ heartbeatId: id, intervalMs: positiveInteger, nextTickAt: dateTime, goalId: id.optional(), payload: jsonValueSchema.optional() }),
  HeartbeatTicked: z.object({ heartbeatId: id, tick: positiveInteger, scheduledAt: dateTime, firedAt: dateTime, nextTickAt: dateTime }),
  HeartbeatStatusChanged: z.object({ heartbeatId: id, status: z.enum(["active", "paused", "cancelled"]), nextTickAt: dateTime.optional(), reason: z.string().optional() }),
  RecursiveModelStarted: z.object({ handleId: id, taskId: id, parentSessionId: id, parentBranchId: id, childSessionId: id, childBranchId: id, model: modelSchema, inputSetId: id.optional(), input: jsonValueSchema.optional(), inputProvenance: jsonValueSchema.optional(), inputHash: digest.optional() }),
  RecursiveModelStatusChanged: z.object({ handleId: id, status: z.enum(["running", "completed", "failed", "cancelled"]), outcome: z.enum(["succeeded", "failed", "cancelled", "budget-exceeded", "unknown"]).optional(), resultMessageId: id.optional(), result: jsonValueSchema.optional(), resultArtifactId: id.optional(), error: z.string().optional() }),
  HarnessVersionCreated: z.object({ entryId: id, versionId: id, version: positiveInteger, kind: z.enum(["memory", "prompt_note", "skill", "subagent_spec"]), scope: z.enum(["local", "workspace", "user", "global"]), scopeKey: id, name: z.string().min(1), content: jsonValueSchema, tags: z.array(z.string()), confidence: z.number().finite().min(0).max(1), status: z.enum(["candidate", "active", "retired", "rejected", "rolled_back"]), evidenceEventIds: z.array(id), conflictEntryIds: z.array(id), supersedesVersionId: id.optional(), proposalId: id.optional(), createdBy: id, lastConfirmedAt: dateTime }),
  HarnessVersionStatusChanged: z.object({ entryId: id, versionId: id, status: z.enum(["candidate", "active", "retired", "rejected", "rolled_back"]), reason: z.string().min(1), proposalId: id.optional() }),
  RefinementProposed: z.object({ proposalId: id, trigger: z.string().min(1), predictedEffect: z.string().min(1), edits: jsonValueSchema, evidenceEventIds: z.array(id), evaluation: jsonValueSchema, authority: z.enum(["agent", "user", "system"]) }),
  RefinementValidated: z.object({ proposalId: id, valid: z.boolean(), validation: jsonValueSchema, expectedProposalStatus: z.literal("proposed") }),
  RefinementCandidateActivated: z.object({ proposalId: id, candidateId: id, versionIds: z.array(id), allocationLimit: positiveInteger, exposureLimit: positiveInteger }),
  RefinementCandidateAllocated: z.object({ proposalId: id, candidateId: id, allocationId: id, targetSessionId: id, targetBranchId: id, taskId: id.optional(), ordinal: positiveInteger }),
  RefinementCandidateExposed: z.object({ proposalId: id, candidateId: id, allocationId: id, exposedVersionIds: z.array(id) }),
  RefinementObservationRecorded: z.object({ proposalId: id, candidateId: id, allocationId: id, observationId: id, evaluator: id, objective: z.boolean(), success: z.boolean(), metric: jsonValueSchema, baseline: jsonValueSchema.optional(), evidenceEventIds: z.array(id), notes: z.string().optional() }),
  RefinementDecided: z.object({ proposalId: id, candidateId: id, decisionId: id, decision: z.enum(["promote", "revise", "reject"]), rule: z.string().min(1), evaluator: id, baseline: jsonValueSchema.optional(), observationIds: z.array(id) }),
  RefinementApproved: z.object({ proposalId: id, approvedBy: id, scope: z.enum(["user", "global"]), note: z.string().optional() }),
  RefinementRollbackApproved: z.object({ proposalId: id, approvedBy: id, role: z.enum(["owner", "admin"]), note: z.string().optional() }),
  RefinementRolledBack: z.object({ proposalId: id, candidateId: id, rollbackId: id, versionIds: z.array(id), restoredVersionIds: z.array(id), reason: z.string().min(1) }),
  SkillInvocationRecorded: z.object({ entryId: id, versionId: id, effectId: id, input: jsonValueSchema }),
  SkillTestRecorded: z.object({ entryId: id, versionId: id, effectId: id, passed: z.boolean(), report: jsonValueSchema }),
  SubagentSpecInvoked: z.object({ entryId: id, versionId: id, taskId: id, childSessionId: id, childBranchId: id }),
  SyncConflictResolved: z.object({ conflictId: id, action: z.enum(["keep-branches", "choose-claim", "cancel-duplicate", "acknowledge"]), resolvedBy: id, chosenEventId: id.optional(), note: z.string().optional(), resolvedAt: dateTime }),
  AgentRunRequested: z.object({ runId: id, task: z.string().min(1), requestKey: id, goalId: id.optional() }).strict(),
  AgentRunStepStarted: z.object({ runId: id, stepId: id, ordinal: positiveInteger, contextId: id, callId: id, effectId: id, actionId: id, observationEventIds: z.array(id) }).strict(),
  AgentRunActionCommitted: z.object({ runId: id, stepId: id, ordinal: positiveInteger, actionId: id, callId: id, raw: z.string(), action: agentActionSchema }).strict(),
  AgentRunActionRejected: z.object({ runId: id, stepId: id, ordinal: positiveInteger, actionId: id, callId: id, raw: z.string(), error: z.string().min(1) }).strict(),
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
}

export function newId(): string { return ulid(); }

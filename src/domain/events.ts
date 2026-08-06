import { ulid } from "ulid";
import { z } from "zod";
import type { JsonValue } from "./json.ts";
import { assertJsonValue } from "./json.ts";
import { ValidationError } from "./errors.ts";

export const EVENT_SCHEMA_VERSION = 1 as const;
export const eventTypes = [
  "SessionCreated", "BranchCreated", "SessionStatusChanged", "MessageAppended",
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

export interface BudgetLimits { readonly tokenLimit?: number; readonly costLimitUsd?: number; readonly turnLimit?: number; readonly wallTimeLimitMs?: number; }
export interface ModelConfiguration { readonly provider: string; readonly model: string; readonly temperature?: number; readonly maxOutputTokens?: number; }
export interface Usage { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number; }
export interface ArtifactReference { readonly artifactId: string; readonly digest: string; readonly mediaType: string; readonly size: number; }
export type WorkingValue = { readonly kind: "json"; readonly value: JsonValue } | { readonly kind: "artifact"; readonly artifactId: string };
export interface ContextRecordReference { readonly eventId: string; readonly type: EventType; readonly schemaVersion: number; readonly reason?: string; }

export interface EventPayloads {
  SessionCreated: { workspaceId: string; initialBranchId: string; model: ModelConfiguration; budget: BudgetLimits; parentSessionId?: string; parentBranchId?: string; rootSessionId?: string; depth?: number; taskId?: string };
  BranchCreated: { branchId: string; parentBranchId: string; forkCursor: string; name?: string };
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
  ContextMaterialized: { contextId: string; records: ContextRecordReference[]; contentHash: string; context: JsonValue };
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
  RecursiveModelStarted: { handleId: string; taskId: string; parentSessionId: string; parentBranchId: string; childSessionId: string; childBranchId: string; model: ModelConfiguration; inputSetId?: string };
  RecursiveModelStatusChanged: { handleId: string; status: Exclude<RecursiveModelStatus, "pending">; resultMessageId?: string; error?: string };
}

export interface AgentEvent<T extends EventType = EventType> {
  readonly cursor: string; readonly id: string; readonly sessionId: string; readonly branchId: string;
  readonly causationId: string | null; readonly correlationId: string | null; readonly type: T;
  readonly schemaVersion: number; readonly committedAt: string; readonly producer: Producer;
  readonly idempotencyKey: string | null; readonly payload: EventPayloads[T];
}
export interface NewAgentEvent<T extends EventType = EventType> {
  readonly id?: string; readonly sessionId: string; readonly branchId: string;
  readonly causationId?: string | null; readonly correlationId?: string | null; readonly type: T;
  readonly schemaVersion?: number; readonly committedAt?: string; readonly producer: Producer;
  readonly idempotencyKey?: string | null; readonly payload: EventPayloads[T];
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
  SessionCreated: z.object({ workspaceId: id, initialBranchId: id, model: modelSchema, budget: budgetSchema, parentSessionId: id.optional(), parentBranchId: id.optional(), rootSessionId: id.optional(), depth: z.number().int().nonnegative().optional(), taskId: id.optional() }),
  BranchCreated: z.object({ branchId: id, parentBranchId: id, forkCursor: z.string().regex(/^\d+$/), name: z.string().optional() }),
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
  ContextMaterialized: z.object({ contextId: id, records: z.array(z.object({ eventId: id, type: z.enum(eventTypes), schemaVersion: positiveInteger, reason: z.string().optional() })), contentHash: digest, context: jsonValueSchema }),
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
  RecursiveModelStarted: z.object({ handleId: id, taskId: id, parentSessionId: id, parentBranchId: id, childSessionId: id, childBranchId: id, model: modelSchema, inputSetId: id.optional() }),
  RecursiveModelStatusChanged: z.object({ handleId: id, status: z.enum(["running", "completed", "failed", "cancelled"]), resultMessageId: id.optional(), error: z.string().optional() }),
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

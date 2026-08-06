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
] as const;
export type EventType = (typeof eventTypes)[number];
export type Producer = "supervisor" | "console" | "model" | "executor" | "client" | "recovery" | string;
export type SessionStatus = "idle" | "running" | "stopped" | "failed" | "archived";
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type EffectOutcome = "succeeded" | "failed" | "cancelled" | "unknown";

export interface BudgetLimits { readonly tokenLimit?: number; readonly costLimitUsd?: number; readonly turnLimit?: number; readonly wallTimeLimitMs?: number; }
export interface ModelConfiguration { readonly provider: string; readonly model: string; readonly temperature?: number; readonly maxOutputTokens?: number; }
export interface Usage { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number; }
export interface ArtifactReference { readonly artifactId: string; readonly digest: string; readonly mediaType: string; readonly size: number; }
export type WorkingValue = { readonly kind: "json"; readonly value: JsonValue } | { readonly kind: "artifact"; readonly artifactId: string };
export interface ContextRecordReference { readonly eventId: string; readonly type: EventType; readonly schemaVersion: number; readonly reason?: string; }

export interface EventPayloads {
  SessionCreated: { workspaceId: string; initialBranchId: string; model: ModelConfiguration; budget: BudgetLimits };
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
const headerSchema = z.object({
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  type: z.enum(eventTypes),
  producer: z.string().min(1),
  schemaVersion: z.number().int().positive().optional(),
});
const id = z.string().min(1);
const nonnegative = z.number().finite().nonnegative();
const jsonValueSchema = z.custom<JsonValue>((value) => {
  try { assertJsonValue(value); return true; } catch { return false; }
}, "Expected a JSON value");
const budgetSchema = z.object({
  tokenLimit: nonnegative.optional(), costLimitUsd: nonnegative.optional(),
  turnLimit: nonnegative.optional(), wallTimeLimitMs: nonnegative.optional(),
});
const modelSchema = z.object({
  provider: id, model: id, temperature: z.number().finite().optional(), maxOutputTokens: nonnegative.optional(),
});
const usageSchema = z.object({ inputTokens: nonnegative, outputTokens: nonnegative, costUsd: nonnegative });
const artifactSchema = z.object({
  artifactId: id, digest: z.string().regex(/^[a-f0-9]{64}$/), mediaType: id, size: nonnegative,
});
const workingValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("json"), value: jsonValueSchema }),
  z.object({ kind: z.literal("artifact"), artifactId: id }),
]);
const payloadSchemas: Record<EventType, z.ZodType> = {
  SessionCreated: z.object({ workspaceId: id, initialBranchId: id, model: modelSchema, budget: budgetSchema }),
  BranchCreated: z.object({ branchId: id, parentBranchId: id, forkCursor: z.string().regex(/^\d+$/), name: z.string().optional() }),
  SessionStatusChanged: z.object({ status: z.enum(["idle", "running", "stopped", "failed", "archived"]), reason: z.string().optional() }),
  MessageAppended: z.object({ messageId: id, role: z.enum(["system", "user", "assistant", "tool"]), content: z.string(), modelCallId: id.optional() }),
  CellProposed: z.object({ cellId: id, code: z.string(), dependencies: z.array(id) }),
  CellStarted: z.object({ cellId: id, attempt: z.number().int().positive() }),
  CellCommitted: z.object({ cellId: id, result: jsonValueSchema, logs: z.array(z.string()), durationMs: nonnegative, exports: z.array(z.string()) }),
  CellFailed: z.object({ cellId: id, error: z.string(), logs: z.array(z.string()), durationMs: nonnegative }),
  CellAbandoned: z.object({ cellId: id, reason: z.string() }),
  WorkingValueSet: z.object({ name: id, version: z.number().int().positive(), value: workingValueSchema }),
  ArtifactRegistered: artifactSchema.extend({ sourceEventId: id.optional() }),
  EffectRequested: z.object({ effectId: id, executor: id, operation: id, input: jsonValueSchema, idempotencyKey: id, idempotent: z.boolean() }),
  EffectAttemptStarted: z.object({ effectId: id, attempt: z.number().int().positive() }),
  EffectOutcomeRecorded: z.object({ effectId: id, attempt: z.number().int().positive(), outcome: z.enum(["succeeded", "failed", "cancelled", "unknown"]), output: jsonValueSchema.optional(), error: z.string().optional(), observedAt: z.string().datetime() }),
  ContextMaterialized: z.object({
    contextId: id,
    records: z.array(z.object({ eventId: id, type: z.enum(eventTypes), schemaVersion: z.number().int().positive(), reason: z.string().optional() })),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/), context: jsonValueSchema,
  }),
  ModelCallRequested: z.object({ callId: id, contextId: id, effectId: id, provider: id, model: id }),
  ModelOutputChunk: z.object({ callId: id, sequence: z.number().int().nonnegative(), text: z.string() }),
  ModelCallCompleted: z.object({ callId: id, responseMessageId: id, finishReason: z.string(), usage: usageSchema }),
  ModelCallTerminated: z.object({ callId: id, outcome: z.enum(["failed", "cancelled", "unknown"]), error: z.string().optional() }),
  BudgetDebited: z.object({ callId: id, tokens: nonnegative, costUsd: nonnegative, turns: nonnegative, wallTimeMs: nonnegative }),
  BudgetExceeded: z.object({ dimension: z.enum(["tokens", "cost", "turns", "wallTime"]), limit: nonnegative, spent: nonnegative }),
  RecoveryPerformed: z.object({ abandonedCellIds: z.array(id), unknownEffectIds: z.array(id), retriedEffectIds: z.array(id) }),
};

export function validateNewEvent<T extends EventType>(event: NewAgentEvent<T>): void {
  const parsed = headerSchema.safeParse(event);
  if (!parsed.success) throw new ValidationError("Invalid event header", { issues: parsed.error.issues });
  if ((event.schemaVersion ?? EVENT_SCHEMA_VERSION) !== EVENT_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported ${event.type} schema version: ${event.schemaVersion}`);
  }
  assertJsonValue(event.payload);
  const payload = payloadSchemas[event.type].safeParse(event.payload);
  if (!payload.success) throw new ValidationError(`Invalid ${event.type} payload`, { issues: payload.error.issues });
}

export function newId(): string { return ulid(); }

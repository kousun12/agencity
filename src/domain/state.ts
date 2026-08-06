import type { ArtifactReference, BudgetLimits, ContextRecordReference, EffectOutcome, ModelConfiguration, SessionStatus, Usage, WorkingValue } from "./events.ts";
import type { JsonValue } from "./json.ts";
export interface BranchState { readonly id: string; readonly parentBranchId: string | null; readonly forkCursor: string | null; readonly name: string | null; }
export interface MessageState { readonly id: string; readonly role: "system" | "user" | "assistant" | "tool"; readonly content: string; readonly eventId: string; readonly modelCallId: string | null; }
export interface CellState { readonly id: string; readonly code: string; readonly status: "proposed" | "running" | "committed" | "failed" | "abandoned"; readonly attempts: number; readonly result?: JsonValue; readonly logs: string[]; readonly error?: string; readonly eventId: string; }
export interface WorkingValueState { readonly name: string; readonly version: number; readonly value: WorkingValue; readonly eventId: string; }
export interface EffectState { readonly id: string; readonly executor: string; readonly operation: string; readonly input: JsonValue; readonly idempotencyKey: string; readonly idempotent: boolean; readonly attempts: number; readonly status: "requested" | "started" | EffectOutcome; readonly output?: JsonValue; readonly error?: string; readonly eventId: string; }
export interface ModelCallState { readonly id: string; readonly contextId: string; readonly effectId: string; readonly provider: string; readonly model: string; readonly chunks: string[]; readonly status: "requested" | EffectOutcome; readonly responseMessageId?: string; readonly finishReason?: string; readonly usage?: Usage; readonly error?: string; readonly eventId: string; }
export interface ContextState { readonly id: string; readonly records: ContextRecordReference[]; readonly contentHash: string; readonly eventId: string; }
export interface BudgetState { readonly limits: BudgetLimits; readonly tokens: number; readonly costUsd: number; readonly turns: number; readonly wallTimeMs: number; readonly exceeded: boolean; }
export interface AgentState {
  readonly reducerVersion: 1; readonly sessionId: string; readonly workspaceId: string; readonly branch: BranchState;
  readonly model: ModelConfiguration; readonly status: SessionStatus; readonly cursor: string; readonly appliedEventIds: string[];
  readonly messages: MessageState[]; readonly cells: Record<string, CellState>; readonly workingValues: Record<string, WorkingValueState>;
  readonly artifacts: Record<string, ArtifactReference>; readonly effects: Record<string, EffectState>; readonly contexts: Record<string, ContextState>;
  readonly modelCalls: Record<string, ModelCallState>; readonly budget: BudgetState;
}

import type { AgentEvent, AgentState, EffectOutcome, NewAgentEvent } from "../domain/index.ts";
import type { JsonValue } from "../domain/json.ts";
export interface StorageCapabilities { readonly offlineWrites: boolean; readonly distributedLeases: boolean; readonly analyticalSql: boolean; readonly notifications: boolean; }
export interface EventQuery { readonly branchId?: string; readonly afterCursor?: string; readonly untilCursor?: string; }
export interface OutboxRecord { readonly effectId: string; readonly sessionId: string; readonly branchId: string; readonly executor: string; readonly operation: string; readonly input: JsonValue; readonly idempotencyKey: string; readonly idempotent: boolean; readonly status: "pending"|"running"|EffectOutcome; readonly attempt: number; readonly owner: string | null; readonly leaseExpiresAt: string | null; }
export interface ReadonlyStatement { readonly sql: string; readonly args: readonly (string|number|bigint|null|Uint8Array)[]; }
export interface AgentStorage {
 readonly name: string; readonly capabilities: StorageCapabilities;
 migrate(): Promise<void>; close(): void;
 appendEvents(events: readonly NewAgentEvent[]): Promise<AgentEvent[]>;
 loadEvents(sessionId: string, query?: EventQuery): Promise<AgentEvent[]>;
 getEvent(eventId: string): Promise<AgentEvent | null>;
 getLatestCursor(sessionId: string, branchId: string): Promise<string | null>;
 listBranches(): Promise<Array<{sessionId:string;branchId:string}>>;
 saveSnapshot(state: AgentState): Promise<void>;
 loadSnapshot(sessionId: string, branchId: string): Promise<AgentState | null>;
 deleteSnapshots(sessionId?: string): Promise<void>;
 claimOutbox(owner: string, limit?: number, leaseMs?: number): Promise<OutboxRecord[]>;
 claimEffect(effectId: string, owner: string, leaseMs?: number): Promise<OutboxRecord | null>;
 getOutbox(effectId: string): Promise<OutboxRecord | null>;
 listOutbox(statuses?: readonly OutboxRecord["status"][]): Promise<OutboxRecord[]>;
 resetOutbox(effectId: string): Promise<void>;
 readonlyQuery(statement: ReadonlyStatement): Promise<JsonValue[]>;
 onCommitted(listener: (events: readonly AgentEvent[]) => void): () => void;
}

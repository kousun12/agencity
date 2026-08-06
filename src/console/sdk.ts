import type { ArtifactReference, BudgetLimits, ModelConfiguration, WorkingValue } from "../domain/index.ts";
import type { JsonValue } from "../domain/json.ts";
import type { InspectOptions, InspectPreview } from "./inspect.ts";

export interface ConsoleSession { readonly id: string; readonly branchId: string }

export interface EventProvenance {
  readonly eventId: string;
  readonly cursor: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly committedAt: string;
  readonly producer: string;
  readonly originDeviceId: string;
  readonly originSequence: number;
}

export interface StateListEntry {
  readonly name: string;
  readonly version: number;
  readonly value: WorkingValue;
  readonly status: "committed" | "staged";
  readonly provenance: EventProvenance | null;
}

export interface StateSdk {
  readonly restored: Readonly<Record<string, WorkingValue>>;
  get(name: string): Promise<WorkingValue | null>;
  set(name: string, value: JsonValue): Promise<WorkingValue>;
  /** Lists the current working-value view without resolving artifact contents. */
  list(): Promise<StateListEntry[]>;
}

export type CellHistoryStatus = "proposed" | "running" | "committed" | "failed" | "abandoned";
export interface CellHistoryEntry {
  readonly cellId: string;
  readonly source: string;
  readonly status: CellHistoryStatus;
  readonly dependencies: string[];
  readonly attempts: number;
  readonly observation: JsonValue | null;
  readonly logs: string[];
  readonly durationMs: number | null;
  readonly exports: string[];
  readonly error: string | null;
  readonly provenance: {
    readonly proposed: EventProvenance;
    readonly starts: EventProvenance[];
    readonly terminal: EventProvenance | null;
  };
}
export interface CellListOptions {
  readonly limit?: number;
  readonly status?: CellHistoryStatus | readonly CellHistoryStatus[];
  /** Return entries whose terminal/latest event cursor sorts before this cursor. */
  readonly beforeCursor?: string;
}
export interface CellListResult {
  readonly items: CellHistoryEntry[];
  readonly nextCursor: string | null;
}
export interface CellsSdk {
  list(options?: CellListOptions): Promise<CellListResult>;
  get(cellId: string): Promise<CellHistoryEntry | null>;
}

export interface ArtifactsSdk {
  put(content: string, mediaType?: string): Promise<ArtifactReference>;
  get(artifactId: string): Promise<string>;
}
export interface ToolsSdk {
  request(executor: string, operation: string, input: JsonValue, options?: { idempotencyKey?: string; idempotent?: boolean }): Promise<{ outcome: "succeeded" | "failed" | "cancelled" | "unknown"; output?: JsonValue; error?: string }>;
  shell(command: string, options?: { cwd?: string; timeoutMs?: number; idempotencyKey?: string }): Promise<JsonValue>;
  readFile(path: string): Promise<JsonValue>;
  writeFile(path: string, content: string, expectedSha256?: string): Promise<JsonValue>;
}
export interface MemorySdk { search(query: string, options?: JsonValue): Promise<JsonValue>; create(input: JsonValue | string): Promise<JsonValue>; list(options?: JsonValue): Promise<JsonValue> }
export interface HarnessSdk { propose(input: JsonValue): Promise<JsonValue>; list(options?: JsonValue): Promise<JsonValue>; history(entryId: string): Promise<JsonValue> }
export interface SkillsSdk { invoke(entryId: string, input: JsonValue, options?: JsonValue): Promise<JsonValue>; test(entryId: string, versionId?: string): Promise<JsonValue> }
export interface SpecsSdk { spawn(entryId: string, input?: JsonValue): Promise<JsonValue> }

export interface ConsoleAgentSpawnInput {
  readonly task: string; readonly completionCriteria?: string; readonly name?: string;
  readonly model?: ModelConfiguration; readonly budget?: BudgetLimits; readonly run?: boolean; readonly idempotencyKey?: string;
}
export interface ConsoleAgentSendInput {
  readonly target: string; readonly content: string; readonly taskId?: string; readonly artifactIds?: readonly string[];
  readonly intentKey?: string; readonly replyToMessageId?: string;
}
export interface ConsoleAgentMessageOptions { readonly direction?: "inbound" | "outbound" | "all"; readonly limit?: number; readonly before?: string; readonly pendingOnly?: boolean; }
export interface AgentsSdk {
  spawn(input: ConsoleAgentSpawnInput | string): Promise<JsonValue>;
  list(): Promise<JsonValue>;
  send(input: ConsoleAgentSendInput | string, content?: string): Promise<JsonValue>;
  messages(options?: ConsoleAgentMessageOptions): Promise<JsonValue>;
  acknowledge(messageId: string): Promise<JsonValue>;
  cancel(target: string, reason?: string): Promise<JsonValue>;
  followUp(target: string, content: string, options?: Omit<ConsoleAgentSendInput, "target" | "content">): Promise<JsonValue>;
}

export type ConsoleRlmInputReference =
  | { readonly kind: "artifact"; readonly artifactId: string; readonly start?: number; readonly end?: number }
  | { readonly kind: "document-range"; readonly documentId: string; readonly start?: number; readonly limit?: number; readonly chunkIds?: readonly string[] }
  | { readonly kind: "event"; readonly eventId: string }
  | { readonly kind: "memory"; readonly entryId: string; readonly versionId?: string }
  | { readonly kind: "sql-row"; readonly query: string; readonly args?: readonly (string | number | boolean | null)[]; readonly row?: number }
  | { readonly kind: "sql-rows"; readonly query: string; readonly args?: readonly (string | number | boolean | null)[]; readonly limit?: number };
export type ConsoleRlmInput = JsonValue | ConsoleRlmInputReference;
export interface ConsoleRlmStartInput {
  readonly prompt?: string;
  readonly task?: string;
  readonly input?: ConsoleRlmInput;
  readonly inputs?: readonly ConsoleRlmInput[];
  readonly inputSetId?: string;
  readonly model?: ModelConfiguration;
  readonly budget?: BudgetLimits;
  readonly run?: boolean;
  readonly idempotencyKey?: string;
}
export type ConsoleRlmOutcome = "succeeded" | "failed" | "cancelled" | "budget-exceeded" | "unknown";
export interface ConsoleRlmResult {
  readonly handleId: string;
  readonly taskId: string;
  readonly status: "pending" | "running" | ConsoleRlmOutcome;
  readonly outcome?: ConsoleRlmOutcome;
  readonly value?: JsonValue;
  readonly resultMessageId?: string;
  readonly resultArtifactId?: string;
  readonly error?: string;
  readonly provenance: JsonValue;
}
export interface ConsoleRlmHandle {
  readonly handleId: string;
  readonly taskId: string;
  readonly parentSessionId: string;
  readonly parentBranchId: string;
  readonly childSessionId: string;
  readonly childBranchId: string;
  readonly model: ModelConfiguration;
  readonly inputSetId: string | null;
  readonly input?: JsonValue;
  readonly inputProvenance?: JsonValue;
  readonly inputHash?: string;
  readonly status: "pending" | "running" | "completed" | "failed" | "cancelled";
  readonly outcome?: ConsoleRlmOutcome;
  readonly resultMessageId?: string;
  readonly resultArtifactId?: string;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Convenience method; functions are omitted when the durable handle is serialized. */
  result(options?: { readonly wait?: boolean; readonly timeoutMs?: number }): Promise<ConsoleRlmResult>;
  cancel(reason?: string): Promise<ConsoleRlmHandle>;
  refresh(): Promise<ConsoleRlmHandle>;
}
export interface RlmSdk {
  start(input: ConsoleRlmStartInput | string): Promise<ConsoleRlmHandle>;
  startMany(inputs: readonly (ConsoleRlmStartInput | string)[]): Promise<ConsoleRlmHandle[]>;
  get(handle: string | Pick<ConsoleRlmHandle, "handleId">): Promise<ConsoleRlmHandle>;
  result(handle: string | Pick<ConsoleRlmHandle, "handleId">, options?: { readonly wait?: boolean; readonly timeoutMs?: number }): Promise<ConsoleRlmResult>;
  cancel(handle: string | Pick<ConsoleRlmHandle, "handleId">, reason?: string): Promise<ConsoleRlmHandle>;
}
export interface ConsoleSdk {
  readonly state: StateSdk;
  readonly cells: CellsSdk;
  readonly artifacts: ArtifactsSdk;
  readonly tools: ToolsSdk;
  readonly memory: MemorySdk;
  readonly harness: HarnessSdk;
  readonly skills: SkillsSdk;
  readonly specs: SpecsSdk;
  readonly agents: AgentsSdk;
  readonly rlm: RlmSdk;
  inspect(value: unknown, options?: InspectOptions): InspectPreview;
}
export type SqlTag = (strings: TemplateStringsArray, ...values: Array<string | number | boolean | null>) => Promise<JsonValue[]>;

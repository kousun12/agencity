import type { AgentInvocationContract, AgentProfileInput, AgentRunResultReference, AgentRunStatus, ArtifactReference, BoundedOutputV1, BudgetLimits, ContextCompactionStrategy, HarnessKind, HarnessScope, ModelConfigurationInput, WorkingValue } from "../domain/index.ts";
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
  readonly causalEffectOutcomeEventIds?: string[];
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
  readRange(artifactId: string, start: number, end: number): Promise<{
    readonly protocol: "agencity.bounded-output.v1";
    readonly completeness: "inline";
    readonly byteLength: number;
    readonly value: {
      readonly bytes: Uint8Array;
      readonly start: number;
      readonly end: number;
      readonly size: number;
      readonly nextStart: number | null;
    };
  }>;
}
export type ShellOutputValue = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
export type ShellOutputPreview = {
  readonly exitCode: number;
  readonly stdout: {
    readonly head: string;
    readonly tail: string;
    readonly byteLength: number;
    readonly retainedByteLength: number;
  };
  readonly stderr: {
    readonly head: string;
    readonly tail: string;
    readonly byteLength: number;
    readonly retainedByteLength: number;
  };
};
export type ShellBoundedOutput = BoundedOutputV1<ShellOutputValue, ShellOutputPreview> & {
  readonly layout?: {
    readonly stdout: { readonly start: number; readonly end: number };
    readonly stderr: { readonly start: number; readonly end: number };
  };
};
export type FilePageValue = {
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly nextLine: number | null;
  readonly sha256: string;
  readonly size: number;
};
export type FilePageBoundedOutput = BoundedOutputV1<FilePageValue>;
export interface ToolsSdk {
  request(executor: string, operation: string, input: JsonValue, options?: { idempotencyKey?: string; idempotent?: boolean }): Promise<{ outcome: "succeeded" | "failed" | "cancelled" | "unknown"; output?: JsonValue; error?: string }>;
  shell(command: string, options?: { cwd?: string; timeoutMs?: number; idempotencyKey?: string }): Promise<ShellBoundedOutput>;
  readFile(path: string, options?: {
    readonly startLine?: number;
    readonly endLine?: number;
    readonly expectedSha256?: string;
  }): Promise<FilePageBoundedOutput>;
  writeFile(path: string, content: string, expectedSha256?: string): Promise<JsonValue>;
}
export interface ConsoleManagedProcessStartInput {
  readonly command: string;
  readonly cwd?: string;
  readonly idempotencyKey?: string;
}
export interface ConsoleManagedProcessHandle {
  readonly processId: string;
  readonly effectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly runId: string | null;
  readonly cellId: string;
  readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
}
export interface ConsoleManagedProcessInspection
  extends ConsoleManagedProcessHandle {
  readonly command: string;
  readonly cwd: string | null;
  readonly pid: number | null;
  readonly processGroupId: number | null;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly stopFailureCount: number;
  readonly stopFailure?: {
    readonly attempt: number;
    readonly reason: string;
    readonly error: string;
    readonly processGroupIds: number[];
    readonly survivingProcessGroupIds: number[];
    readonly attemptedAt: string;
  };
  readonly output?: JsonValue;
  readonly error?: string;
}
export interface ProcessesSdk {
  start(input: string | ConsoleManagedProcessStartInput): Promise<ConsoleManagedProcessHandle>;
  inspect(target: string | Pick<ConsoleManagedProcessHandle, "processId">): Promise<ConsoleManagedProcessInspection>;
  readLogs(target: string | Pick<ConsoleManagedProcessHandle, "processId">): Promise<JsonValue>;
  stop(target: string | Pick<ConsoleManagedProcessHandle, "processId">, reason?: string): Promise<ConsoleManagedProcessInspection>;
  list(): Promise<ConsoleManagedProcessInspection[]>;
}
export interface MemorySdk { search(query: string, options?: JsonValue): Promise<JsonValue>; create(input: JsonValue | string): Promise<JsonValue>; list(options?: JsonValue): Promise<JsonValue> }
export interface HarnessReviewInput {
  readonly instructions?: string;
  readonly requestedScope?: HarnessScope;
  readonly allowedKinds?: readonly HarnessKind[];
  readonly wait?: boolean;
  readonly evidenceEventIds?: readonly string[];
}
export interface HarnessSdk { review(input?: string | HarnessReviewInput): Promise<JsonValue>; reviews(options?: JsonValue): Promise<JsonValue>; propose(input: JsonValue): Promise<JsonValue>; list(options?: JsonValue): Promise<JsonValue>; history(entryId: string): Promise<JsonValue> }
export interface SkillsSdk {
  list(options?: { readonly includeUnavailable?: boolean }): Promise<JsonValue>;
  get(nameOrId: string): Promise<JsonValue>;
  invoke(nameOrId: string, input: JsonValue, options?: JsonValue): Promise<JsonValue>;
  test(nameOrId: string): Promise<JsonValue>;
  propose(instructions: string, scope?: "local" | "workspace"): Promise<JsonValue>;
}
export interface SpecsSdk { spawn(entryId: string, input?: JsonValue): Promise<JsonValue> }

export interface ConsoleAgentSpawnInput {
  readonly task: string; readonly completionCriteria?: string; readonly name?: string;
  readonly model?: string | ModelConfigurationInput; readonly budget?: BudgetLimits; readonly idempotencyKey?: string;
  readonly output?: { readonly schema: unknown };
}
export interface ConsoleAgentResultOptions {
  readonly wait?: boolean;
  readonly timeoutMs?: number;
}
export interface ConsoleAgentHandleIdentity<I = ConsoleAgentSpawnInput | string> {
  readonly taskId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly parentSessionId: string;
  readonly parentBranchId: string;
  readonly rootSessionId: string;
  readonly depth: number;
  readonly status: string;
  readonly name?: string;
  /** Type-only carrier for the invocation input; never serialized. */
  readonly __input?: I;
}
export interface ConsoleAgentHandle<I = ConsoleAgentSpawnInput | string>
  extends ConsoleAgentHandleIdentity<I> {
  /**
   * Worker-local convenience for retained result lookup. The method is
   * non-enumerable and is not part of the durable or JSON-serialized handle.
   */
  result(options?: ConsoleAgentResultOptions): Promise<ConsoleAgentRunResult<I>>;
}
export type ConsoleAgentRunOutput<I> =
  I extends { readonly output: { readonly schema: infer S } }
    ? { readonly kind: "object"; readonly object: InferConsoleSchema<S> }
    : { readonly kind: "text"; readonly text: string };
export interface ConsoleAgentRunResultBase {
  readonly taskId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly steps: number;
  readonly reason?: string;
  readonly final?: string;
  readonly invocationContract?: JsonValue;
}
export type ConsoleAgentRunResult<I = ConsoleAgentSpawnInput | string> =
  | ConsoleAgentRunResultBase & {
      readonly status: "succeeded";
      readonly final: string;
      readonly output: ConsoleAgentRunOutput<I>;
      readonly resultReference: JsonValue;
    }
  | ConsoleAgentRunResultBase & {
      readonly status: "queued" | "running" | "blocked" | "failed" | "cancelled" | "budget_exceeded" | "unknown";
      readonly output?: never;
      readonly resultReference?: never;
    };
export interface ConsoleAgentSendInput {
  readonly target: string; readonly content: string; readonly taskId?: string; readonly artifactIds?: readonly string[];
  readonly intentKey?: string; readonly replyToMessageId?: string; readonly mode?: "steer" | "queue";
}
export interface ConsoleMailboxMessageHandle {
  readonly mailboxMessageId: string;
  readonly fromSessionId: string;
  readonly fromBranchId: string;
  readonly toSessionId: string;
  readonly toBranchId: string;
  readonly delivered: boolean;
  readonly mode: "steer" | "queue";
  readonly receiptStatus: string;
  readonly queued: boolean;
  readonly existing: boolean;
  readonly runId?: string;
  readonly error?: string;
}
export type ConsoleMailboxMessageResult =
  | {
      readonly mailboxMessageId: string;
      readonly runId: string;
      readonly sessionId: string;
      readonly branchId: string;
      readonly status: "queued" | "failed";
      readonly steps: 0;
      readonly admitted: false;
      readonly reason?: string;
    }
  | {
      readonly mailboxMessageId: string;
      readonly admitted: true;
      readonly runId: string;
      readonly sessionId: string;
      readonly branchId: string;
      readonly status: AgentRunStatus;
      readonly steps: number;
      readonly reason?: string;
      readonly final?: string;
      readonly finalMessageId?: string;
      readonly output?: {
        readonly kind: "text";
        readonly text: string;
      } | {
        readonly kind: "object";
        readonly object: JsonValue;
      };
      readonly resultReference?: AgentRunResultReference;
      readonly invocationContract?: AgentInvocationContract;
    };
export interface ConsoleAgentMessageOptions { readonly direction?: "inbound" | "outbound" | "all"; readonly limit?: number; readonly before?: string; readonly pendingOnly?: boolean; }
export interface AgentsSdk {
  spawn<I extends ConsoleAgentSpawnInput | string>(input: I): Promise<ConsoleAgentHandle<I>>;
  spawnMany<I extends readonly (ConsoleAgentSpawnInput | string)[]>(inputs: I): Promise<{
    readonly [K in keyof I]: ConsoleAgentHandle<I[K]>;
  }>;
  run<I extends ConsoleAgentSpawnInput | string>(input: I): Promise<ConsoleAgentRunResult<I>>;
  runMany<I extends readonly (ConsoleAgentSpawnInput | string)[]>(inputs: I): Promise<{
    readonly [K in keyof I]: ConsoleAgentRunResult<I[K]>;
  }>;
  result<I extends ConsoleAgentSpawnInput | string>(
    handle: string | ConsoleAgentHandleIdentity<I>,
    options?: ConsoleAgentResultOptions,
  ): Promise<ConsoleAgentRunResult<I>>;
  get(target?: string): Promise<JsonValue>;
  proposeProfileUpdate(target: string | undefined, input: {
    readonly expectedProfileVersionId: string;
    readonly replacement: AgentProfileInput;
    readonly reason: string;
    readonly predictedEffect: string;
    readonly evidenceEventIds: readonly string[];
    readonly revisesProposalId?: string;
  }, options?: { readonly wait?: boolean }): Promise<JsonValue>;
  rollbackProfile(target: string | undefined, input: {
    readonly expectedCurrentVersionId: string;
    readonly restoreVersionId: string;
    readonly reason: string;
    readonly evidenceEventIds: readonly string[];
  }): Promise<JsonValue>;
  list(): Promise<JsonValue>;
  send(input: ConsoleAgentSendInput): Promise<ConsoleMailboxMessageHandle>;
  send(target: string, content: string, options?: Omit<ConsoleAgentSendInput, "target" | "content">): Promise<ConsoleMailboxMessageHandle>;
  messageResult(
    message: string | Pick<ConsoleMailboxMessageHandle, "mailboxMessageId">,
    options?: ConsoleAgentResultOptions,
  ): Promise<ConsoleMailboxMessageResult>;
  messages(options?: ConsoleAgentMessageOptions): Promise<JsonValue>;
  acknowledge(messageId: string): Promise<JsonValue>;
  cancel(target: string, reason?: string): Promise<JsonValue>;
}

export type ConsoleAiContextReference =
  | { readonly kind: "artifact"; readonly artifactId: string; readonly start?: number; readonly end?: number }
  | { readonly kind: "document-range"; readonly documentId: string; readonly start?: number; readonly limit?: number; readonly chunkIds?: readonly string[] }
  | { readonly kind: "event"; readonly eventId: string }
  | { readonly kind: "memory"; readonly entryId: string; readonly versionId?: string }
  | { readonly kind: "sql-row"; readonly query: string; readonly args?: readonly (string | number | boolean | null)[]; readonly row?: number }
  | { readonly kind: "sql-rows"; readonly query: string; readonly args?: readonly (string | number | boolean | null)[]; readonly limit?: number };
export type ConsoleAiContext = JsonValue | ConsoleAiContextReference;
export interface ConsoleAiBudget extends BudgetLimits {
  readonly inputTokenLimit?: number;
  readonly outputTokenLimit?: number;
  readonly inlineResultByteLimit?: number;
}
export interface ConsoleAiGenerationInput {
  readonly prompt?: string;
  readonly messages?: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  readonly context?: readonly ConsoleAiContext[];
  readonly model?: string | ModelConfigurationInput;
  readonly budget?: ConsoleAiBudget;
  readonly idempotencyKey?: string;
}
export interface ConsoleAiGenerationResultBase {
  readonly generationId: string;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unknown" | "budget_exceeded";
  readonly error?: string;
  readonly finishReason?: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number };
  readonly warnings?: readonly { readonly kind: string; readonly message: string }[];
  readonly provenance: JsonValue;
}
export interface ConsoleAiTextResult extends ConsoleAiGenerationResultBase {
  readonly kind: "text";
  readonly text?: string;
}
export interface ConsoleAiObjectResult<T = JsonValue> extends ConsoleAiGenerationResultBase {
  readonly kind: "object";
  readonly object?: T;
}
export type InferConsoleSchema<S> =
  S extends { readonly _zod: { readonly output: infer Output } } ? Output :
  S extends { readonly "~standard": { readonly types?: { readonly output: infer Output } } } ? Output :
  JsonValue;
export interface AiSdk {
  generateText(input: ConsoleAiGenerationInput): Promise<ConsoleAiTextResult>;
  generateObject<S>(input: ConsoleAiGenerationInput & { readonly schema: S }): Promise<ConsoleAiObjectResult<InferConsoleSchema<S>>>;
}
export interface GoalsSdk {
  current(): Promise<JsonValue>;
  list(): Promise<JsonValue>;
  get(goalId: string): Promise<JsonValue>;
  evaluations(goalId: string, gateId?: string): Promise<JsonValue>;
}
export interface ConsoleHeartbeatInput { readonly intervalMs: number; readonly nextTickAt?: string; readonly goalId?: string; readonly prompt?: string; readonly payload?: JsonValue; }
export interface HeartbeatsSdk {
  create(input: ConsoleHeartbeatInput | number): Promise<JsonValue>;
  list(): Promise<JsonValue>;
  pause(heartbeatId: string, reason?: string): Promise<JsonValue>;
  resume(heartbeatId: string, nextTickAt?: string): Promise<JsonValue>;
  clear(heartbeatId: string, reason?: string): Promise<JsonValue>;
}
export interface ConsoleScheduleInput { readonly prompt: string; readonly at?: string; readonly nextTickAt?: string; readonly intervalMs?: number; readonly goalMode?: "auto" | "current" | "create"; }
export interface SchedulesSdk {
  create(input: ConsoleScheduleInput): Promise<JsonValue>;
  list(): Promise<JsonValue>;
  wakes(statuses?: readonly ("queued" | "claimed" | "delivered" | "unknown")[]): Promise<JsonValue>;
  pause(scheduleId: string, reason?: string): Promise<JsonValue>;
  resume(scheduleId: string, nextTickAt?: string): Promise<JsonValue>;
  clear(scheduleId: string, reason?: string): Promise<JsonValue>;
}

export interface ContextSdk {
  inspect(): Promise<JsonValue>;
  compact(options?: { readonly strategy?: ContextCompactionStrategy; readonly instructions?: string; readonly idempotencyKey?: string; readonly rematerializeFromContextId?: string }): Promise<JsonValue>;
}

export interface ConsoleSdk {
  readonly state: StateSdk;
  readonly cells: CellsSdk;
  readonly artifacts: ArtifactsSdk;
  readonly tools: ToolsSdk;
  readonly processes: ProcessesSdk;
  readonly memory: MemorySdk;
  readonly harness: HarnessSdk;
  readonly skills: SkillsSdk;
  readonly specs: SpecsSdk;
  readonly agents: AgentsSdk;
  readonly goals: GoalsSdk;
  readonly heartbeats: HeartbeatsSdk;
  readonly schedules: SchedulesSdk;
  readonly context: ContextSdk;
  readonly ai: AiSdk;
  inspect(value: unknown, options?: InspectOptions): InspectPreview;
}
export type SqlTag = (strings: TemplateStringsArray, ...values: Array<string | number | boolean | null>) => Promise<JsonValue[]>;

import {
  FamilyReachError, NotFoundError, ValidationError, assertJsonValue, assertNoReservedModelDispatchInputFields, canonicalJsonStringify, createAgentInvocationContract, newId, projectEvents,
  SEALED_TASK_SPECIALIST_PROFILE, agentProfilePin, sameAgentProfileAdmissionMeaning,
  type AgentInvocationContract, type AgentProfileInput, type AgentProfileVersion, type AgentRunResultReference, type AgentRunState, type AgentState, type BudgetLimits, type EventPayloads, type FamilyRelationship, type JsonValue, type MailboxReceiptStatus, type ModelConfiguration, type ModelConfigurationInput, type NewAgentEvent, type TaskStatus,
} from "../domain/index.ts";
import {
  requireRecursiveStorage, type AgentStorage, type MailboxRecord, type SessionRecord, type TaskRecord,
} from "../storage/index.ts";
import {
  containsBrokeredSecret,
  containsCredentialMaterial,
} from "../security/index.ts";
import type { OutboxRunner } from "./outbox.ts";
import type { AgentRunResult, AgentRunService } from "./agent-runs.ts";
import { ProjectionService } from "./projection.ts";
import { AgentProfileService } from "./agent-profiles.ts";
import type { ModelSelectionInput } from "./model-selection.ts";

export const MAX_AGENT_INVOCATION_BATCH_SIZE = 16;
export const MAX_AGENT_INVOCATION_WAIT_MS = 86_400_000;

export interface SpawnAgentInput {
  readonly task: string;
  readonly completionCriteria?: string;
  readonly model?: ModelSelectionInput;
  readonly budget?: BudgetLimits;
  readonly profile?: AgentProfileInput;
  /** Stable command identity. Reusing it with the same request returns the original handle. */
  readonly idempotencyKey?: string;
  readonly sessionId?: string;
  readonly branchId?: string;
  /** Stable, human-readable family address. Names need not be unique. */
  readonly name?: string;
  /** Compact host-validated programmatic output. Omit for normal text. */
  readonly output?: { readonly schema: JsonValue };
}
export interface SubagentHandle {
  readonly taskId: string; readonly sessionId: string; readonly branchId: string;
  readonly parentSessionId: string; readonly parentBranchId: string; readonly rootSessionId: string;
  readonly depth: number; readonly status: TaskStatus; readonly name?: string;
  readonly runId?: string;
}
export interface AgentInvocationResult extends AgentRunResult {
  readonly taskId: string;
}
export interface SpawnAdmissionItem { readonly input: SpawnAgentInput; readonly handle: SubagentHandle; readonly model: ModelConfiguration; readonly budget: BudgetLimits; readonly profile: AgentProfileVersion; readonly existing: boolean; }
export interface SendMessageInput {
  /** Model-facing target: session ID, exact family name, or the literal "parent". */
  readonly target?: string;
  /** Retained diagnostic compatibility aliases. */
  readonly toSessionId?: string;
  readonly toBranchId?: string;
  readonly recipientSessionId?: string;
  readonly recipientBranchId?: string;
  readonly content?: string;
  readonly message?: string;
  readonly taskId?: string;
  readonly artifactIds?: readonly string[];
  readonly intentKey?: string;
  readonly idempotencyKey?: string;
  readonly followUp?: boolean;
  readonly replyToMessageId?: string;
}
export interface MailboxMessageHandle {
  readonly mailboxMessageId: string; readonly fromSessionId: string; readonly fromBranchId: string;
  readonly toSessionId: string; readonly toBranchId: string; readonly delivered: boolean;
  readonly receiptStatus: MailboxReceiptStatus; readonly queued: boolean; readonly existing: boolean;
  readonly error?: string;
}
export interface FamilyAgentRecord {
  readonly sessionId: string; readonly branchId: string; readonly name: string | null;
  readonly relationship: FamilyRelationship; readonly depth: number; readonly status: string;
  readonly taskId: string | null; readonly taskStatus: TaskStatus | null;
  readonly task: string | null; readonly model: ModelConfiguration | null; readonly cancellationRequested: boolean;
  readonly activity: FamilyAgentActivity; readonly activityReason: FamilyAgentActivityReason;
}
export type FamilyAgentActivity = "working" | "idle" | "attention" | "ended" | "unavailable";
export type FamilyAgentActivityReason =
  | "blocked" | "failed" | "budget_exceeded"
  | "unknown" | "cancellation_pending" | "cancelled" | "archived" | "missing_state" | null;
export interface FamilyListResult { readonly items: FamilyAgentRecord[]; }
export interface MailboxListOptions {
  readonly direction?: "inbound" | "outbound" | "all";
  readonly limit?: number;
  readonly before?: string;
  readonly pendingOnly?: boolean;
}
/** Rendering-only relationship for retained mailbox rows. `legacy` never grants family reach. */
export type FamilyMessageRelationship = FamilyRelationship | "legacy";
export interface FamilyMessageRecord extends MailboxRecord {
  readonly relationship: FamilyMessageRelationship;
  readonly senderName: string | null;
  readonly recipientName: string | null;
}
export interface MailboxListResult { readonly items: FamilyMessageRecord[]; readonly nextCursor: string | null; }
export interface CompleteTaskInput { readonly taskId?: string; readonly result?: JsonValue; readonly artifactIds?: readonly string[]; }
export interface FailTaskInput { readonly taskId?: string; readonly error: string; readonly artifactIds?: readonly string[]; }

class AdmissionQueue {
  readonly #tails = new Map<string, Promise<void>>();
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve(); let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; }); const tail = previous.catch(() => {}).then(() => current); this.#tails.set(key, tail);
    await previous.catch(() => {}); try { return await operation(); } finally { release(); if (this.#tails.get(key) === tail) this.#tails.delete(key); }
  }
}

export class AgentService {
  readonly #recursive;
  readonly #projections: ProjectionService;
  readonly profiles: AgentProfileService;
  readonly #admissions = new AdmissionQueue();
  readonly #deliveries = new AdmissionQueue();
  #runs: AgentRunService | null = null;
  readonly maxMessageBytes = 32 * 1024;
  readonly maxPendingMessages = 100;
  readonly maxMessagesPerMinute = 60;
  constructor(
    readonly storage: AgentStorage,
    readonly outbox?: OutboxRunner,
    readonly maxDepth = 8,
    readonly maxChildren = 32,
    readonly normalizeModel: (model: ModelConfigurationInput) => ModelConfiguration = (model) => ({
      ...model,
      reasoningEffort: model.reasoningEffort === "default" || model.reasoningEffort === undefined
        ? "provider-default"
        : model.reasoningEffort === "off" ? "none" : model.reasoningEffort,
    }),
    readonly normalizeModelIdentity: (model: ModelConfigurationInput) => ModelConfiguration = normalizeModel,
    readonly assertRunnableModel: (model: ModelConfiguration) => void = () => {},
    readonly selectModel: (
      caller: ModelConfiguration,
      selection: ModelSelectionInput,
      mode: "admit" | "identity",
    ) => Promise<ModelConfiguration> = async (caller, selection, mode) => {
      const normalize = mode === "identity"
        ? normalizeModelIdentity
        : normalizeModel;
      const model = typeof selection === "string"
        ? normalize({ ...caller, model: selection })
        : normalize(selection);
      if (
        model.provider !== caller.provider ||
        model.model !== caller.model
      ) {
        throw new ValidationError(
          "Child model provider/model must remain within the parent model policy",
        );
      }
      return model;
    },
  ) {
    this.#recursive = requireRecursiveStorage(storage);
    this.#projections = new ProjectionService(storage);
    this.profiles = new AgentProfileService(storage);
  }

  attachRunService(runs: AgentRunService): void {
    this.#runs = runs;
    runs.setTerminalObserver((result) => this.onRunTerminal(result));
  }

  spawn(parentSessionId: string, parentBranchId: string, input: SpawnAgentInput | string): Promise<SubagentHandle> {
    return this.spawnMany(parentSessionId, parentBranchId, [input]).then((handles) => handles[0]!);
  }

  spawnMany(parentSessionId: string, parentBranchId: string, rawInputs: readonly (SpawnAgentInput | string)[]): Promise<SubagentHandle[]> {
    return this.spawnManyWithEvents(parentSessionId, parentBranchId, rawInputs, () => []);
  }

  /**
   * Atomically admits a child and its initial autonomous run. The queued
   * `advance` is only a latency optimization: recovery can advance the durable
   * AgentRunRequested event if this process exits immediately after admission.
   */
  async spawnRunnable(parentSessionId: string, parentBranchId: string, input: SpawnAgentInput | string): Promise<SubagentHandle> {
    const [handle] = await this.spawnManyRunnable(parentSessionId, parentBranchId, [input]);
    return handle!;
  }

  async spawnManyRunnable(
    parentSessionId: string,
    parentBranchId: string,
    inputs: readonly (SpawnAgentInput | string)[],
    options: {
      readonly beforeAdmission?: (
        items: readonly SpawnAdmissionItem[],
      ) => Promise<void>;
    } = {},
  ): Promise<SubagentHandle[]> {
    assertInvocationBatchSize(inputs);
    const contracts = new Map<string, AgentInvocationContract>();
    const handles = await this.spawnManyWithEvents(parentSessionId, parentBranchId, inputs, (items) => items
      .filter((item) => !item.existing)
      .flatMap((item): NewAgentEvent[] => {
        const runId = spawnRunId(item.handle.taskId);
        const contract = contracts.get(item.handle.taskId);
        if (!contract) {
          throw new ValidationError(
            "Agent invocation contract was not prepared before admission",
          );
        }
        return [{
          sessionId: item.handle.sessionId,
          branchId: item.handle.branchId,
          type: "AgentRunRequested",
          producer: "client",
          idempotencyKey: `agent-run-request:${runId}`,
          payload: {
            runId,
            task: item.input.task.trim(),
            requestKey: `agent-spawn:${item.handle.taskId}`,
            profilePin: agentProfilePin(item.profile),
          },
        }, {
          sessionId: item.handle.sessionId,
          branchId: item.handle.branchId,
          type: "AgentInvocationContractPinned",
          producer: "client",
          idempotencyKey: `agent-invocation-contract:${runId}`,
          payload: { runId, contract },
        }];
      }), {
        requireAgentToolSet: true,
        validateItems: async (items) => {
          for (const item of items) {
            const runId = spawnRunId(item.handle.taskId);
            const expected = createAgentInvocationContract({
              runId,
              taskId: item.handle.taskId,
              output: item.input.output === undefined
                ? { kind: "text" }
                : { kind: "object", schema: item.input.output.schema },
              model: item.model,
              profile: item.profile,
              budget: item.budget,
            });
            assertInvocationContractSecretFree(expected);
            contracts.set(item.handle.taskId, expected);
            if (!item.existing) continue;
            const state = projectEvents(await this.storage.loadEvents(
              item.handle.sessionId,
              { branchId: item.handle.branchId },
            ));
            const retained =
              state.agentRuns[runId]?.invocationContract;
            if (!retained) {
              if (item.input.output === undefined) continue;
              throw new ValidationError(
                "Subagent idempotency key names a legacy text run without an object output contract",
              );
            }
            if (retained.contractDigest !== expected.contractDigest) {
              throw new ValidationError(
                "Subagent idempotency key was reused with a different invocation contract",
              );
            }
          }
          await options.beforeAdmission?.(items);
        },
      });
    for (const handle of handles) this.#scheduleSpawnAdvance(handle);
    return handles.map((handle) => ({ ...handle, runId: spawnRunId(handle.taskId) }));
  }

  /** Compatibility spelling for callers that prefer an explicit action name. */
  spawnAndRun(parentSessionId: string, parentBranchId: string, input: SpawnAgentInput | string): Promise<SubagentHandle> {
    return this.spawnRunnable(parentSessionId, parentBranchId, input);
  }

  async run(
    parentSessionId: string,
    parentBranchId: string,
    input: SpawnAgentInput | string,
  ): Promise<AgentInvocationResult> {
    const handle = await this.spawnRunnable(parentSessionId, parentBranchId, input);
    return this.result(parentSessionId, parentBranchId, handle.taskId, {
      wait: true,
    });
  }

  async runMany(
    parentSessionId: string,
    parentBranchId: string,
    inputs: readonly (SpawnAgentInput | string)[],
  ): Promise<AgentInvocationResult[]> {
    const handles = await this.spawnManyRunnable(
      parentSessionId,
      parentBranchId,
      inputs,
    );
    return Promise.all(handles.map((handle) =>
      this.result(parentSessionId, parentBranchId, handle.taskId, { wait: true })
    ));
  }

  /**
   * Extends the admission transaction with events whose identities are derived
   * from the same durable child handles. Runtime services use this to avoid a
   * crash boundary between child admission and their own handle creation.
   */
  async spawnManyWithEvents(
    parentSessionId: string,
    parentBranchId: string,
    rawInputs: readonly (SpawnAgentInput | string)[],
    extend: (items: readonly SpawnAdmissionItem[]) => readonly NewAgentEvent[],
    options: {
      readonly requireAgentToolSet?: boolean;
      readonly profileSources?: readonly ({ readonly entryId: string; readonly versionId: string } | null)[];
      readonly validateItems?: (
        items: readonly SpawnAdmissionItem[],
      ) => Promise<void>;
    } = {},
  ): Promise<SubagentHandle[]> {
    return this.#admissions.run(`${parentSessionId}/${parentBranchId}`, async () => {
      if (!Array.isArray(rawInputs)) {
        throw new ValidationError("Subagent inputs must be an array");
      }
      const inputs = rawInputs.map((input): SpawnAgentInput => {
        if (typeof input === "string") return { task: input };
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new ValidationError("Subagent input must be a task string or object");
        }
        return input;
      });
      if (inputs.length === 0) return [];
      for (const input of inputs) {
        assertNoReservedModelDispatchInputFields(
          input,
          "Public subagent input",
        );
        if (Object.hasOwn(input, "run")) {
          throw new ValidationError(
            "Subagent input no longer accepts run; spawn is always detached-running",
          );
        }
        assertNoReservedModelDispatchInputFields(
          input.model,
          "Public model configuration",
        );
        if (typeof input.task !== "string" || !input.task.trim()) {
          throw new ValidationError("Subagent task must be a non-empty string");
        }
        if (input.idempotencyKey !== undefined &&
            (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim())) {
          throw new ValidationError("Subagent idempotencyKey must be a non-empty string");
        }
        if (input.name !== undefined &&
            (typeof input.name !== "string" || !input.name.trim() ||
              new TextEncoder().encode(input.name).byteLength > 128)) {
          throw new ValidationError("Subagent name must be 1 to 128 UTF-8 bytes");
        }
        if (input.profile !== undefined && (!input.profile || typeof input.profile !== "object" || Array.isArray(input.profile))) throw new ValidationError("Subagent profile must be an object");
        if (input.output !== undefined) {
          if (!input.output || typeof input.output !== "object" ||
              Array.isArray(input.output) ||
              Object.keys(input.output).length !== 1 ||
              !Object.hasOwn(input.output, "schema")) {
            throw new ValidationError(
              "Subagent output must contain only the declared schema",
            );
          }
        }
      }
      if (options.profileSources !== undefined && options.profileSources.length !== inputs.length) {
        throw new ValidationError("Subagent profile source count must match admissions");
      }
      const parent = await this.#recursive.getSession(parentSessionId);
      if (!parent) throw new NotFoundError("parent session", parentSessionId);
      const parentEvents = await this.storage.loadEvents(parentSessionId, { branchId: parentBranchId });
      if (!parentEvents.length) throw new NotFoundError("parent branch", `${parentSessionId}/${parentBranchId}`);
      const parentState = projectEvents(parentEvents);
      if (parent.depth + 1 > this.maxDepth) throw new ValidationError(`Maximum session depth ${this.maxDepth} exceeded`);
      const inheritedBudget = remainingBudget(parentState.budget.limits, parentState.budget);

      const now = new Date().toISOString();
      const prepared = inputs.map((input, index) => {
        const stable = input.idempotencyKey === undefined ? undefined : stableId(`${parentSessionId}/${parentBranchId}/${input.idempotencyKey}`);
        const taskId = stable === undefined ? newId() : `task-${stable}`;
        const childSessionId = input.sessionId ?? (stable === undefined ? newId() : `session-${stable}`);
        const childBranchId = input.branchId ?? (stable === undefined ? newId() : `branch-${stable}`);
        const model = parentState.model;
        const budget = input.budget ?? inheritedBudget;
        const source = options.profileSources?.[index] ?? null;
        const profileInput = input.profile ?? SEALED_TASK_SPECIALIST_PROFILE;
        const profileMetadata = {
          profileVersionId: `agent-profile-${childSessionId}-v1`,
          agentSessionId: childSessionId,
          createdBy: { kind: "agent" as const, sessionId: parentSessionId, branchId: parentBranchId },
          sourceSpecEntryId: source?.entryId ?? null,
          sourceSpecVersionId: source?.versionId ?? null,
          reason: source ? "Materialized from an invoked subagent specification"
            : input.profile ? "Initial profile supplied by the creating agent"
            : "Sealed task-specialist admission profile",
          createdAt: now,
        };
        const profile = this.profiles.materializeInitial(profileInput, profileMetadata);
        return { input, taskId, childSessionId, childBranchId, model, budget, profile, profileInput, profileMetadata };
      });
      if (new Set(prepared.map((item) => item.taskId)).size !== prepared.length ||
          new Set(prepared.map((item) => item.childSessionId)).size !== prepared.length) {
        throw new ValidationError("Duplicate subagent admission identity in one batch");
      }

      const existing = await Promise.all(prepared.map((item) => this.#recursive.getTask(item.taskId)));
      // Omitted defaults are part of the original durable command. A later
      // retry must not reinterpret them against a now-smaller remaining budget.
      for (let index = 0; index < existing.length; index++) {
        const task = existing[index]; const item = prepared[index]!;
        if (task && item.input.model !== undefined) {
          const selected = await this.selectModel(
            // String selections inherit route and token options. Reconstruct
            // those omitted fields from the original durable task so a retry
            // is not reinterpreted after the parent changes models.
            task.model,
            item.input.model,
            "identity",
          );
          if (!Bun.deepEquals(selected, task.model)) {
            throw new ValidationError("Subagent idempotency key was reused with a different model configuration");
          }
          item.model = task.model;
        } else if (task) item.model = task.model;
        else if (item.input.model !== undefined) {
          item.model = await this.selectModel(
            parentState.model,
            item.input.model,
            "admit",
          );
        }
        if (task && item.input.budget === undefined) item.budget = task.budget;
      }
      for (let index = 0; index < existing.length; index++) {
        const task = existing[index]; const item = prepared[index]!;
        if (!task) continue;
        if (task.parentSessionId !== parentSessionId || task.parentBranchId !== parentBranchId ||
            task.childSessionId !== item.childSessionId || task.childBranchId !== item.childBranchId ||
            task.task !== item.input.task || task.completionCriteria !== (item.input.completionCriteria ?? null) ||
            !Bun.deepEquals(task.model, item.model) || !Bun.deepEquals(task.budget, item.budget)) {
          throw new ValidationError("Subagent idempotency key was reused with a different request");
        }
      }
      for (let index = 0; index < existing.length; index++) {
        if (!existing[index]) continue;
        const item = prepared[index]!;
        const childEvents = await this.storage.loadEvents(item.childSessionId, { branchId: item.childBranchId });
        const created = childEvents.find((event) => event.type === "SessionCreated");
        const originalName = (created?.payload as EventPayloads["SessionCreated"] | undefined)?.sessionName;
        if ((originalName ?? undefined) !== (item.input.name?.trim() || undefined)) {
          throw new ValidationError("Subagent idempotency key was reused with a different name");
        }
        const originalProfile = (created?.payload as EventPayloads["SessionCreated"] | undefined)?.agentProfile;
        if (!originalProfile || !sameAgentProfileAdmissionMeaning(originalProfile, item.profileInput, item.profileMetadata)) {
          throw new ValidationError("Subagent idempotency key was reused with a different agent profile");
        }
        item.profile = originalProfile;
      }
      const novel = prepared.filter((_item, index) => !existing[index]);
      const directTasks = await this.#recursive.listTasks(parentSessionId);
      const activeDirect = directTasks.filter((task) => !["completed", "failed", "cancelled"].includes(task.status));
      if (activeDirect.length + novel.length > this.maxChildren) throw new ValidationError(`Maximum active child count ${this.maxChildren} exceeded`);

      for (const item of novel) {
        assertChildLimits(
          parentState.model,
          parentState.budget.limits,
          item.model,
          item.budget,
        );
      }
      if (options.requireAgentToolSet) {
        for (const item of novel) this.assertRunnableModel(item.model);
      }
      const activeTasks = directTasks.filter((task) => task.parentBranchId === parentBranchId && !["completed", "failed", "cancelled"].includes(task.status));
      const activeReservations = await Promise.all(activeTasks.map((task) => this.#remainingTaskReservation(task)));
      const activeGenerationReservations = Object.values(parentState.aiGenerations)
        .filter((generation) => ["pending", "running"].includes(generation.status) && generation.reservation)
        .map((generation): BudgetLimits => ({
          tokenLimit: generation.reservation!.tokens,
          costLimitUsd: generation.reservation!.costUsd,
          turnLimit: generation.reservation!.turns,
          wallTimeLimitMs: generation.reservation!.wallTimeMs,
        }));
      assertBudgetReservations(parentState.budget.limits, parentState.budget, [
        ...activeReservations,
        ...activeGenerationReservations,
        ...novel.map((item) => item.budget),
      ]);

      const rootSessionId = parent.rootSessionId; const depth = parent.depth + 1;
      const handles = prepared.map((item, index): SubagentHandle => ({
        taskId: item.taskId, sessionId: item.childSessionId, branchId: item.childBranchId,
        parentSessionId, parentBranchId, rootSessionId, depth, status: existing[index]?.status ?? "admitted",
        ...(prepared[index]!.input.name === undefined ? {} : { name: prepared[index]!.input.name!.trim() }),
      }));
      const admissionItems = prepared.map((item, index): SpawnAdmissionItem => ({ input: item.input, handle: handles[index]!, model: item.model, budget: item.budget, profile: item.profile, existing: existing[index] !== null }));
      await options.validateItems?.(admissionItems);
      const events: NewAgentEvent[] = [];
      for (let index = 0; index < prepared.length; index++) {
        if (existing[index]) continue;
        const item = prepared[index]!;
        const { input, taskId, childSessionId, childBranchId, model, budget } = item;
        events.push({
          sessionId: parentSessionId, branchId: parentBranchId, type: "TaskCreated", producer: "supervisor",
          idempotencyKey: `task:${taskId}`, payload: { taskId, parentSessionId, parentBranchId, childSessionId, childBranchId, task: input.task, ...(input.completionCriteria === undefined ? {} : { completionCriteria: input.completionCriteria }), model, budget },
        }, {
          sessionId: childSessionId, branchId: childBranchId, type: "SessionCreated", producer: "supervisor",
          idempotencyKey: `session:${childSessionId}`, payload: { workspaceId: parent.workspaceId, initialBranchId: childBranchId, model, budget, agentProfile: item.profile, parentSessionId, parentBranchId, rootSessionId, depth, taskId, ...(input.name === undefined ? {} : { sessionName: input.name.trim() }) },
        }, {
          sessionId: childSessionId, branchId: childBranchId, type: "MessageAppended", producer: "supervisor",
          idempotencyKey: `task-prompt:${taskId}`, payload: { messageId: `prompt-${taskId}`, role: "user", content: input.task },
        }, {
          sessionId: parentSessionId, branchId: parentBranchId, type: "SubagentAdmitted", producer: "supervisor",
          idempotencyKey: `subagent-admitted:${taskId}`, payload: { taskId, childSessionId, childBranchId, admittedAt: now },
        });
      }
      // Extension builders must return events only for `existing === false`;
      // a fully idempotent retry therefore performs no append.
      events.push(...extend(admissionItems));
      if (events.length) await this.storage.appendEvents(events);
      return handles;
    });
  }

  async sendMessage(fromSessionId: string, fromBranchId: string, input: SendMessageInput): Promise<MailboxMessageHandle>;
  async sendMessage(fromSessionId: string, fromBranchId: string, toSessionId: string, content: string): Promise<MailboxMessageHandle>;
  async sendMessage(fromSessionId: string, fromBranchId: string, inputOrTarget: SendMessageInput | string, rawContent?: string): Promise<MailboxMessageHandle> {
    const input: SendMessageInput = typeof inputOrTarget === "string" ? { toSessionId: inputOrTarget, content: rawContent ?? "" } : inputOrTarget;
    return this.#deliveries.run(`${fromSessionId}/${fromBranchId}`, async () => {
      const source = await this.#recursive.getSession(fromSessionId);
      if (!source) throw new NotFoundError("sender session", fromSessionId);
      if (!(await this.storage.loadEvents(fromSessionId, { branchId: fromBranchId })).length) {
        throw new NotFoundError("sender branch", `${fromSessionId}/${fromBranchId}`);
      }
      const targetAliases = [input.target, input.toSessionId, input.recipientSessionId].filter((value): value is string => value !== undefined);
      if (!targetAliases.length || targetAliases.some((value) => typeof value !== "string" || !value.trim())) throw new ValidationError("Family message target must be a non-empty session ID or name");
      if (new Set(targetAliases).size !== 1) throw new ValidationError("Family message target aliases disagree");
      const rawTarget = targetAliases[0]!;
      const resolved = await this.#resolveFamilyTarget(source, rawTarget.trim());
      const branchAliases = [input.toBranchId, input.recipientBranchId].filter((value): value is string => value !== undefined);
      if (branchAliases.some((value) => typeof value !== "string" || !value.trim()) || new Set(branchAliases).size > 1) throw new ValidationError("Family message target branch aliases disagree or are empty");
      const toBranchId = branchAliases[0] ?? resolved.branchId;
      if (!(await this.storage.loadEvents(resolved.session.sessionId, { branchId: toBranchId })).length) {
        throw new NotFoundError("mailbox target branch", `${resolved.session.sessionId}/${toBranchId}`);
      }
      if (input.content !== undefined && input.message !== undefined && input.content !== input.message) throw new ValidationError("Family message content aliases disagree");
      const content = input.content ?? input.message;
      if (typeof content !== "string" || !content.trim()) throw new ValidationError("Family message content cannot be empty");
      if (input.taskId !== undefined && (typeof input.taskId !== "string" || !input.taskId.trim())) throw new ValidationError("Family message taskId must be a non-empty string");
      if (input.replyToMessageId !== undefined && (typeof input.replyToMessageId !== "string" || !input.replyToMessageId.trim())) throw new ValidationError("Family message replyToMessageId must be a non-empty string");
      if (input.followUp !== undefined && typeof input.followUp !== "boolean") throw new ValidationError("Family message followUp must be boolean");
      const contentBytes = new TextEncoder().encode(content).byteLength;
      if (contentBytes > this.maxMessageBytes) throw new ValidationError(`Family message exceeds ${this.maxMessageBytes} UTF-8 bytes`);
      const artifactIds = input.artifactIds === undefined ? [] : [...input.artifactIds];
      if (artifactIds.length > 8 || new Set(artifactIds).size !== artifactIds.length || artifactIds.some((id) => typeof id !== "string" || !id.trim())) {
        throw new ValidationError("Family messages may link at most 8 distinct artifact IDs");
      }
      const sourceState = projectEvents(await this.storage.loadEvents(fromSessionId, { branchId: fromBranchId }));
      for (const artifactId of artifactIds) if (!sourceState.artifacts[artifactId]) {
        throw new ValidationError(`Family message artifact is not registered on the sender branch: ${artifactId}`);
      }
      if (input.taskId !== undefined) await this.#assertTaskLink(input.taskId, source, resolved.session);
      if (input.replyToMessageId !== undefined) {
        const original = await this.#recursive.getMailboxMessage(input.replyToMessageId);
        if (!original || original.fromSessionId !== resolved.session.sessionId || original.toSessionId !== fromSessionId) {
          throw new ValidationError("Family message replyToMessageId does not name an inbound message from the target");
        }
      }
      if (input.intentKey !== undefined && input.idempotencyKey !== undefined && input.intentKey !== input.idempotencyKey) throw new ValidationError("Family message intent aliases disagree");
      const intentKey = input.intentKey ?? input.idempotencyKey ?? `message-${newId()}`;
      if (typeof intentKey !== "string" || !intentKey.trim() || new TextEncoder().encode(intentKey).byteLength > 256) {
        throw new ValidationError("Family message intentKey must be 1 to 256 UTF-8 bytes");
      }
      const mailboxMessageId = `mailbox-${stableId(`${fromSessionId}/${fromBranchId}/${intentKey}`)}`;
      const existing = await this.#recursive.getMailboxMessage(mailboxMessageId);
      const common = {
        mailboxMessageId, fromSessionId, fromBranchId, toSessionId: resolved.session.sessionId, toBranchId,
        kind: "message" as const, content,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(artifactIds.length ? { artifactIds } : {}),
        intentKey,
        ...(input.followUp ? { followUp: true } : {}),
        ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
      };
      if (existing) {
        if (!sameMailboxMeaning(existing, common)) throw new ValidationError("Family message intentKey was reused with different durable meaning");
        let recovered = existing;
        if (existing.receiptStatus === "queued" && !existing.delivered) recovered = await this.#recoverAcceptedDelivery(existing);
        if (recovered.receiptStatus === "queued") await this.#routeAcceptedMessage(recovered);
        const updated = await this.#recursive.getMailboxMessage(mailboxMessageId);
        return this.#messageHandle(updated ?? recovered, true);
      }
      const outbound = await this.#recursive.listMailboxMessages(fromSessionId, "outbound");
      const minuteAgo = Date.now() - 60_000;
      if (outbound.filter((message) => Date.parse(message.sentAt) >= minuteAgo).length >= this.maxMessagesPerMinute) {
        throw new ValidationError(`Family message rate limit of ${this.maxMessagesPerMinute} per minute exceeded`);
      }
      const targetMessages = await this.#recursive.listMailboxMessages(resolved.session.sessionId, "inbound");
      if (targetMessages.filter((message) => message.receiptStatus === "queued").length >= this.maxPendingMessages) {
        throw new ValidationError(`Family target pending queue limit of ${this.maxPendingMessages} exceeded`);
      }
      const sentEventId = `mailbox-sent-${stableId(mailboxMessageId)}`;
      const targetState = projectEvents(await this.storage.loadEvents(resolved.session.sessionId, { branchId: toBranchId }));
      if (["archived", "failed"].includes(targetState.status)) {
        const error = `Target session is ${targetState.status} and unavailable for family delivery`;
        await this.storage.appendEvents([{
          id: sentEventId, sessionId: fromSessionId, branchId: fromBranchId, type: "MailboxMessageSent", producer: "client",
          idempotencyKey: `mailbox-sent:${mailboxMessageId}`, payload: common,
        }, {
          sessionId: fromSessionId, branchId: fromBranchId, type: "MailboxMessageDeliveryFailed", producer: "supervisor",
          idempotencyKey: `mailbox-failed:${mailboxMessageId}`, payload: { mailboxMessageId, failedAt: new Date().toISOString(), error },
        }]);
        const failed = await this.#recursive.getMailboxMessage(mailboxMessageId);
        if (!failed) throw new Error("Failed family delivery receipt was not projected");
        return this.#messageHandle(failed, false);
      }
      await this.storage.appendEvents([{
        id: sentEventId, sessionId: fromSessionId, branchId: fromBranchId, type: "MailboxMessageSent", producer: "client",
        idempotencyKey: `mailbox-sent:${mailboxMessageId}`, payload: common,
      }, {
        sessionId: resolved.session.sessionId, branchId: toBranchId, type: "MailboxMessageDelivered", producer: "supervisor",
        idempotencyKey: `mailbox-delivered:${mailboxMessageId}`, payload: { ...common, sentEventId, senderRelationship: inverseRelationship(resolved.relationship) },
      }]);
      const accepted = await this.#recursive.getMailboxMessage(mailboxMessageId);
      if (!accepted) throw new Error("Accepted family message was not projected");
      await this.#routeAcceptedMessage(accepted);
      const updated = await this.#recursive.getMailboxMessage(mailboxMessageId);
      return this.#messageHandle(updated ?? accepted, false);
    });
  }

  /** Explicit retained-child follow-up. The send returns at the durable queue boundary. */
  followUp(sessionId: string, branchId: string, target: string, content: string, options: Omit<SendMessageInput, "target" | "content" | "followUp"> = {}): Promise<MailboxMessageHandle> {
    return this.sendMessage(sessionId, branchId, { ...options, target, content, followUp: true });
  }

  async listFamily(sessionId: string, branchId: string): Promise<FamilyListResult> {
    const source = await this.#recursive.getSession(sessionId);
    if (!source) throw new NotFoundError("session", sessionId);
    const sourceState = (await this.#projections.getSnapshot(sessionId, branchId)).state;
    const candidates: FamilyCandidate[] = [];
    if (source.parentSessionId && source.parentBranchId) {
      const parent = await this.#recursive.getSession(source.parentSessionId);
      candidates.push({
        session: parent,
        sessionId: source.parentSessionId,
        branchId: source.parentBranchId,
        relationship: "parent",
        depth: Math.max(0, source.depth - 1),
        taskId: source.taskId,
        taskFallback: null,
        taskShapesActivity: false,
      });
      const parentState = await this.#familyState(source.parentSessionId, source.parentBranchId);
      if (parentState) {
        for (const siblingTask of Object.values(parentState.tasks)) {
          if (siblingTask.childSessionId === source.sessionId || siblingTask.parentBranchId !== source.parentBranchId) continue;
          const sibling = await this.#recursive.getSession(siblingTask.childSessionId);
          candidates.push(candidateFromTask(sibling, siblingTask, "sibling", source.depth));
        }
      }
    }
    for (const childTask of Object.values(sourceState.tasks)) {
      if (childTask.parentSessionId !== sessionId || childTask.parentBranchId !== branchId) continue;
      const child = await this.#recursive.getSession(childTask.childSessionId);
      candidates.push(candidateFromTask(child, childTask, "child", source.depth + 1));
    }
    const items = await Promise.all(candidates.map(async (candidate): Promise<FamilyAgentRecord> => {
      const task = candidate.taskId ? await this.#recursive.getTask(candidate.taskId) : null;
      const state = candidate.session
        ? await this.#familyState(candidate.sessionId, candidate.branchId)
        : null;
      const activity = deriveFamilyAgentActivity(
        state,
        candidate.taskShapesActivity ? task : null,
        candidate.taskShapesActivity && candidate.taskId !== null,
      );
      return {
        sessionId: candidate.sessionId,
        branchId: candidate.branchId,
        name: state?.sessionName ?? null,
        relationship: candidate.relationship,
        depth: candidate.session?.depth ?? candidate.depth,
        status: state?.status ?? "unavailable",
        taskId: candidate.taskId,
        taskStatus: task?.status ?? null,
        task: task?.task ?? candidate.taskFallback,
        model: state?.model ?? task?.model ?? null,
        cancellationRequested: task?.cancellationRequested ?? false,
        ...activity,
      };
    }));
    items.sort((left, right) => relationshipRank(left.relationship) - relationshipRank(right.relationship) || (left.name ?? left.sessionId).localeCompare(right.name ?? right.sessionId) || left.sessionId.localeCompare(right.sessionId));
    return { items };
  }

  async #familyState(sessionId: string, branchId: string): Promise<AgentState | null> {
    try {
      return (await this.#projections.getSnapshot(sessionId, branchId)).state;
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async messages(sessionId: string, branchId: string, rawOptions: MailboxListOptions = {}): Promise<MailboxListResult> {
    if (!(await this.storage.loadEvents(sessionId, { branchId })).length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const direction = rawOptions.direction ?? "all";
    if (!["inbound", "outbound", "all"].includes(direction)) throw new ValidationError("Invalid family message direction");
    const limit = rawOptions.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ValidationError("Family message limit must be an integer from 1 to 100");
    let records = await this.#recursive.listMailboxMessages(sessionId, direction);
    if (rawOptions.pendingOnly) records = records.filter((message) => message.receiptStatus === "queued");
    records.sort((left, right) => right.sentAt.localeCompare(left.sentAt) || right.mailboxMessageId.localeCompare(left.mailboxMessageId));
    if (rawOptions.before !== undefined) {
      const before = decodeMessageCursor(rawOptions.before);
      records = records.filter((message) => message.sentAt < before.sentAt || message.sentAt === before.sentAt && message.mailboxMessageId < before.id);
    }
    const page = records.slice(0, limit);
    const items = await Promise.all(page.map((message) => this.#publicMessage(sessionId, message)));
    return { items, nextCursor: records.length > page.length && page.length ? encodeMessageCursor(page.at(-1)!) : null };
  }

  /** Delivers queued steering inputs at an AgentRun durable step boundary. */
  async deliverQueuedAtBoundary(sessionId: string, branchId: string, runId: string): Promise<number> {
    const messages = (await this.#recursive.listMailboxMessages(sessionId, "inbound"))
      .filter((message) => message.toBranchId === branchId && message.receiptStatus === "queued");
    for (const message of messages) await this.#deliverToContext(message, runId);
    return messages.length;
  }

  /** Completes crash prefixes between durable acceptance, context delivery, and follow-up run admission. */
  async recoverDeliveries(): Promise<number> {
    const seen = new Set<string>(); let recovered = 0;
    for (const branch of await this.storage.listBranches()) {
      for (const message of await this.#recursive.listMailboxMessages(branch.sessionId, "inbound")) {
        if (seen.has(message.mailboxMessageId)) continue;
        seen.add(message.mailboxMessageId);
        if (message.receiptStatus === "queued") {
          const accepted = message.delivered ? message : await this.#recoverAcceptedDelivery(message);
          if (accepted.receiptStatus === "queued") await this.#routeAcceptedMessage(accepted);
          recovered++;
          continue;
        }
        if (message.followUp && message.deliveredToContext && message.followUpRunId) {
          const state = projectEvents(await this.storage.loadEvents(message.toSessionId, { branchId: message.toBranchId }));
          if (!state.agentRuns[message.followUpRunId]) { this.#scheduleRetainedRun(message, message.followUpRunId); recovered++; }
        }
      }
    }
    if (this.#runs) {
      for (const branch of await this.storage.listBranches()) {
        const state = projectEvents(await this.storage.loadEvents(branch.sessionId, { branchId: branch.branchId }));
        for (const run of Object.values(state.agentRuns)) {
          if (!["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status)) continue;
          await this.onRunTerminal(await this.#runs.get(branch.sessionId, branch.branchId, run.id));
        }
      }
    }
    return recovered;
  }

  async onRunTerminal(result: AgentRunResult): Promise<void> {
    if (!["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(result.status)) return;
    const state = projectEvents(await this.storage.loadEvents(result.sessionId, { branchId: result.branchId }));
    const run = state.agentRuns[result.runId];
    if (!run) return;
    const task = await this.#recursive.findTaskByChild(result.sessionId);
    if (task && run.requestKey === `agent-spawn:${task.taskId}`) {
      if (result.status === "succeeded") {
        if (!result.resultReference && result.invocationContract) {
          throw new ValidationError(
            "Successful agent invocation is missing its retained result reference",
          );
        }
        await this.completeTask(task.taskId, {
          result: (result.resultReference ?? result.final ?? "") as unknown as JsonValue,
        });
      } else if (result.status === "cancelled") {
        if (task.status === "cancelled") {
          await this.#terminal(task, "cancelled", {
            ...(result.reason === undefined ? {} : { reason: result.reason }),
          });
        } else {
          await this.cancel(task.taskId, result.reason);
        }
      } else {
        await this.failTask(
          task.taskId,
          result.reason ?? `Child run ${result.status}`,
        );
      }
      const reply = result.status === "succeeded" ? result.final ?? "Child task completed." : `Child task ${result.status}: ${result.reason ?? "no reason supplied"}`;
      await this.sendMessage(result.sessionId, result.branchId, { toSessionId: task.parentSessionId, toBranchId: task.parentBranchId, content: reply, taskId: task.taskId, intentKey: `automatic-task-reply:${task.taskId}:${result.runId}` });
    }
    const inbound = (await this.#recursive.listMailboxMessages(result.sessionId, "inbound"))
      .filter((message) => message.followUpRunId === result.runId && message.followUp && !message.replyToMessageId);
    for (const message of inbound) {
      const outbound = await this.#recursive.listMailboxMessages(result.sessionId, "outbound");
      if (outbound.some((candidate) => candidate.replyToMessageId === message.mailboxMessageId)) continue;
      const content = result.status === "succeeded" ? result.final ?? "Follow-up completed." : `Follow-up ${result.status}: ${result.reason ?? "no reason supplied"}`;
      await this.sendMessage(result.sessionId, result.branchId, {
        toSessionId: message.fromSessionId, toBranchId: message.fromBranchId, content,
        ...(message.taskId === null ? {} : { taskId: message.taskId }),
        intentKey: `automatic-reply:${message.mailboxMessageId}:${result.runId}`, replyToMessageId: message.mailboxMessageId,
      });
    }
    // Messages accepted while the provider was busy become context at this
    // terminal boundary. Follow-ups then create a new retained run; ordinary
    // steering remains available in the next future context.
    const queued = (await this.#recursive.listMailboxMessages(result.sessionId, "inbound"))
      .filter((message) => message.toBranchId === result.branchId && message.receiptStatus === "queued");
    for (const message of queued) await this.#routeAcceptedMessage(message);
  }

  /** Starts a newly admitted child through the ordinary autonomous run engine. */
  scheduleSpawn(handle: SubagentHandle, task: string): void {
    if (!this.#runs) throw new ValidationError("Agent run service is unavailable");
    const runs = this.#runs;
    queueMicrotask(() => { void runs.start(handle.sessionId, handle.branchId, { task, requestKey: `agent-spawn:${handle.taskId}`, requestedRunId: spawnRunId(handle.taskId), suppressTaskMessage: true }).catch(() => {}); });
  }

  #scheduleSpawnAdvance(handle: SubagentHandle): void {
    if (!this.#runs) return;
    const runs = this.#runs;
    queueMicrotask(() => { void runs.advance(handle.sessionId, handle.branchId, spawnRunId(handle.taskId)).catch(() => {}); });
  }

  async result(
    parentSessionId: string,
    parentBranchId: string,
    taskId: string,
    options: { readonly wait?: boolean; readonly timeoutMs?: number } = {},
  ): Promise<AgentInvocationResult> {
    if (!this.#runs) throw new ValidationError("Agent run service is unavailable");
    if (options.wait !== undefined && typeof options.wait !== "boolean") {
      throw new ValidationError("Agent invocation result wait must be boolean");
    }
    if (options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0 ||
          options.timeoutMs > MAX_AGENT_INVOCATION_WAIT_MS)) {
      throw new ValidationError(
        `Agent invocation wait timeout must be from 0 to ${MAX_AGENT_INVOCATION_WAIT_MS}ms`,
      );
    }
    const task = await this.#recursive.getTask(taskId);
    if (!task || task.parentSessionId !== parentSessionId ||
        task.parentBranchId !== parentBranchId) {
      throw new NotFoundError("agent invocation", taskId);
    }
    const runId = spawnRunId(task.taskId);
    const deadline = options.timeoutMs === undefined
      ? Number.POSITIVE_INFINITY
      : Date.now() + options.timeoutMs;
    for (;;) {
      const result = await this.#runs.get(
        task.childSessionId,
        task.childBranchId,
        runId,
      );
      if (!options.wait ||
          ["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(result.status) ||
          Date.now() >= deadline) {
        return { ...result, taskId: task.taskId };
      }
      await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }

  async invocationContract(
    parentSessionId: string,
    parentBranchId: string,
    taskId: string,
  ) {
    const result = await this.result(parentSessionId, parentBranchId, taskId, {
      wait: false,
    });
    if (!result.invocationContract) {
      throw new ValidationError("Agent invocation has no pinned contract");
    }
    return result.invocationContract;
  }

  async findInvocation(
    parentSessionId: string,
    parentBranchId: string,
    idempotencyKey: string,
  ): Promise<SubagentHandle | null> {
    if (!idempotencyKey.trim()) {
      throw new ValidationError("Agent invocation idempotencyKey cannot be empty");
    }
    const taskId = `task-${stableId(`${parentSessionId}/${parentBranchId}/${idempotencyKey}`)}`;
    const task = await this.#recursive.getTask(taskId);
    if (!task || task.parentSessionId !== parentSessionId ||
        task.parentBranchId !== parentBranchId) return null;
    const child = await this.#recursive.getSession(task.childSessionId);
    return {
      taskId: task.taskId,
      sessionId: task.childSessionId,
      branchId: task.childBranchId,
      parentSessionId,
      parentBranchId,
      rootSessionId: child?.rootSessionId ?? parentSessionId,
      depth: child?.depth ?? 0,
      status: task.status,
      runId: spawnRunId(task.taskId),
    };
  }

  async cancelFamilyTarget(sessionId: string, branchId: string, target: string, reason?: string): Promise<TaskRecord | AgentRunResult> {
    const source = await this.#recursive.getSession(sessionId); if (!source) throw new NotFoundError("session", sessionId);
    const resolved = await this.#resolveFamilyTarget(source, target);
    if (resolved.relationship !== "child") throw new FamilyReachError("Only a direct child can be cancelled", { sessionId, targetSessionId: resolved.session.sessionId });
    const task = await this.#recursive.findTaskByChild(resolved.session.sessionId);
    if (task && !["completed", "failed", "cancelled"].includes(task.status)) return this.cancel(sessionId, branchId, task.taskId, reason);
    const childState = projectEvents(await this.storage.loadEvents(resolved.session.sessionId, { branchId: resolved.branchId }));
    const active = Object.values(childState.agentRuns).find((run) => !["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status));
    if (!active || !this.#runs) throw new ValidationError("Direct child has no cancellable task or follow-up run");
    return this.#runs.cancel(resolved.session.sessionId, resolved.branchId, active.id, reason);
  }

  async #recoverAcceptedDelivery(message: MailboxRecord): Promise<MailboxRecord> {
    const targetState = projectEvents(await this.storage.loadEvents(message.toSessionId, { branchId: message.toBranchId }));
    if (["archived", "failed"].includes(targetState.status)) {
      const error = `Target session is ${targetState.status} and unavailable for family delivery`;
      await this.storage.appendEvents([{
        sessionId: message.fromSessionId, branchId: message.fromBranchId, type: "MailboxMessageDeliveryFailed", producer: "recovery",
        idempotencyKey: `mailbox-failed:${message.mailboxMessageId}`, payload: { mailboxMessageId: message.mailboxMessageId, failedAt: new Date().toISOString(), error },
      }]);
    } else {
      const sent = (await this.storage.loadEvents(message.fromSessionId, { branchId: message.fromBranchId }))
        .find((event) => event.type === "MailboxMessageSent" && (event.payload as EventPayloads["MailboxMessageSent"]).mailboxMessageId === message.mailboxMessageId);
      if (!sent) throw new ValidationError(`Queued family message ${message.mailboxMessageId} has no canonical send event`);
      const common = sent.payload as EventPayloads["MailboxMessageSent"];
      if (!sameMailboxMeaning(message, common)) throw new ValidationError(`Queued family message ${message.mailboxMessageId} disagrees with its canonical send event`);
      const relationship = await this.#relationshipFromTarget(message);
      await this.storage.appendEvents([{
        sessionId: message.toSessionId, branchId: message.toBranchId, type: "MailboxMessageDelivered", producer: "recovery",
        idempotencyKey: `mailbox-delivered:${message.mailboxMessageId}`, payload: { ...common, sentEventId: sent.id, senderRelationship: relationship },
      }]);
    }
    const updated = await this.#recursive.getMailboxMessage(message.mailboxMessageId);
    if (!updated) throw new NotFoundError("mailbox message", message.mailboxMessageId);
    return updated;
  }

  async #routeAcceptedMessage(message: MailboxRecord): Promise<void> {
    const state = projectEvents(await this.storage.loadEvents(message.toSessionId, { branchId: message.toBranchId }));
    const active = Object.values(state.agentRuns).find((run) => !["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status));
    if (active) return; // AgentRunService claims it at its next durable step boundary.
    const runId = message.followUp ? `agent-follow-up-run-${stableId(message.mailboxMessageId)}` : undefined;
    await this.#deliverToContext(message, runId);
    if (message.followUp && runId) this.#scheduleRetainedRun(message, runId);
  }

  async #deliverToContext(message: MailboxRecord, runId?: string): Promise<void> {
    const current = await this.#recursive.getMailboxMessage(message.mailboxMessageId);
    if (!current || current.receiptStatus !== "queued") return;
    const relationship = current.senderRelationship ?? await this.#relationshipFromTarget(current);
    const messageEventId = `family-context-message-${stableId(current.mailboxMessageId)}`;
    const deliveredAt = new Date().toISOString();
    const payload = { mailboxMessageId: current.mailboxMessageId, messageEventId, deliveredAt, relationship, ...(runId === undefined ? {} : { runId }) };
    const senderState = projectEvents(await this.storage.loadEvents(current.fromSessionId, { branchId: current.fromBranchId }));
    const targetState = projectEvents(await this.storage.loadEvents(current.toSessionId, { branchId: current.toBranchId }));
    const artifactEvents: NewAgentEvent[] = current.artifactIds.flatMap((artifactId) => {
      const artifact = senderState.artifacts[artifactId];
      if (!artifact) throw new ValidationError(`Family message artifact disappeared from the sender branch: ${artifactId}`);
      const alreadyLinked = targetState.artifacts[artifactId];
      if (alreadyLinked) {
        if (!Bun.deepEquals(alreadyLinked, artifact)) throw new ValidationError(`Family message artifact identity conflicts on the target branch: ${artifactId}`);
        return [];
      }
      return [{
        sessionId: current.toSessionId, branchId: current.toBranchId, type: "ArtifactRegistered" as const, producer: "supervisor" as const,
        idempotencyKey: `family-artifact:${current.mailboxMessageId}:${artifactId}`,
        payload: { artifactId: artifact.artifactId, digest: artifact.digest, mediaType: artifact.mediaType, size: artifact.size },
      }];
    });
    await this.storage.appendEvents([...artifactEvents, {
      id: messageEventId, sessionId: current.toSessionId, branchId: current.toBranchId, type: "MessageAppended", producer: "supervisor",
      idempotencyKey: `family-context-message:${current.mailboxMessageId}`, payload: {
        messageId: `family-${current.mailboxMessageId}`, role: "user", content: current.content,
        mailbox: { mailboxMessageId: current.mailboxMessageId, fromSessionId: current.fromSessionId, relationship, ...(current.taskId === null ? {} : { taskId: current.taskId }), ...(current.artifactIds.length ? { artifactIds: current.artifactIds } : {}), receiptEventId: `family-context-target-${stableId(current.mailboxMessageId)}` },
      },
    }, {
      id: `family-context-target-${stableId(current.mailboxMessageId)}`, sessionId: current.toSessionId, branchId: current.toBranchId, type: "MailboxMessageContextDelivered", producer: "supervisor",
      idempotencyKey: `mailbox-context-target:${current.mailboxMessageId}`, payload,
    }, {
      sessionId: current.fromSessionId, branchId: current.fromBranchId, type: "MailboxMessageContextDelivered", producer: "supervisor",
      idempotencyKey: `mailbox-context-sender:${current.mailboxMessageId}`, payload,
    }]);
  }

  #scheduleRetainedRun(message: MailboxRecord, runId: string): void {
    if (!this.#runs) return;
    const runs = this.#runs;
    queueMicrotask(() => { void runs.start(message.toSessionId, message.toBranchId, { task: message.content, requestKey: `agent-follow-up:${message.mailboxMessageId}`, requestedRunId: runId, suppressTaskMessage: true }).catch(() => {}); });
  }

  async #resolveFamilyTarget(source: SessionRecord, rawTarget: string): Promise<{ session: SessionRecord; branchId: string; relationship: FamilyRelationship }> {
    const family = await this.listFamily(source.sessionId, source.initialBranchId);
    let matches = family.items.filter((item) => item.sessionId === rawTarget);
    if (rawTarget === "parent") matches = family.items.filter((item) => item.relationship === "parent");
    if (!matches.length) matches = family.items.filter((item) => item.name === rawTarget);
    if (matches.length > 1) throw new ValidationError(`Ambiguous family target name: ${rawTarget}`, { candidates: matches.map((item) => item.sessionId) });
    const match = matches[0];
    if (!match) throw new FamilyReachError("Nuclear family target is not the parent, a direct child, or a sibling of the executing session", { sourceSessionId: source.sessionId, target: rawTarget });
    const session = await this.#recursive.getSession(match.sessionId);
    if (!session) throw new NotFoundError("family session", match.sessionId);
    return { session, branchId: match.branchId, relationship: match.relationship };
  }

  async #assertTaskLink(taskId: string, source: SessionRecord, target: SessionRecord): Promise<void> {
    const task = await this.#recursive.getTask(taskId);
    if (!task) throw new ValidationError("Family message taskId does not name a durable task");
    const endpoints = new Set([source.sessionId, target.sessionId]);
    if (!endpoints.has(task.parentSessionId) && !endpoints.has(task.childSessionId)) throw new ValidationError("Family message taskId is not authorized for either endpoint");
    const taskParent = await this.#recursive.getSession(task.parentSessionId);
    if (taskParent?.rootSessionId !== source.rootSessionId) throw new ValidationError("Family message taskId cannot link another family");
  }

  async #relationshipFromTarget(message: MailboxRecord): Promise<FamilyRelationship> {
    const target = await this.#recursive.getSession(message.toSessionId);
    if (!target) throw new NotFoundError("family target", message.toSessionId);
    const sender = await this.#resolveFamilyTarget(target, message.fromSessionId);
    return sender.relationship;
  }

  #messageHandle(message: MailboxRecord, existing: boolean): MailboxMessageHandle {
    return { mailboxMessageId: message.mailboxMessageId, fromSessionId: message.fromSessionId, fromBranchId: message.fromBranchId, toSessionId: message.toSessionId, toBranchId: message.toBranchId, delivered: message.delivered, receiptStatus: message.receiptStatus, queued: message.receiptStatus === "queued", existing, ...(message.error === null ? {} : { error: message.error }) };
  }

  async #publicMessage(viewerSessionId: string, message: MailboxRecord): Promise<FamilyMessageRecord> {
    const sender = await this.#recursive.getSession(message.fromSessionId); const recipient = await this.#recursive.getSession(message.toSessionId);
    if (!sender || !recipient) throw new ValidationError("Family message endpoint projection is missing");
    if (viewerSessionId !== sender.sessionId && viewerSessionId !== recipient.sessionId) {
      throw new ValidationError("Only a family message endpoint can view the retained message");
    }
    const viewer = viewerSessionId === sender.sessionId ? sender : recipient;
    const other = viewerSessionId === sender.sessionId ? recipient : sender;
    let relationship: FamilyMessageRelationship;
    try {
      relationship = (await this.#resolveFamilyTarget(viewer, other.sessionId)).relationship;
    } catch (error) {
      // Pre-FU-012 events allowed same-root communication beyond the nuclear
      // family. Preserve those rows for endpoint inspection only. Keeping this
      // fallback here (rather than in target resolution) prevents retained
      // history from authorizing sends, follow-ups, or cancellation.
      const retainedShape = message.intentKey === null || message.intentKey === undefined;
      if (!(error instanceof FamilyReachError) || !retainedShape || sender.rootSessionId !== recipient.rootSessionId) throw error;
      relationship = "legacy";
    }
    const senderEvents = await this.storage.loadEvents(sender.sessionId, { branchId: sender.initialBranchId });
    const recipientEvents = await this.storage.loadEvents(recipient.sessionId, { branchId: recipient.initialBranchId });
    return { ...message, relationship, senderName: senderEvents.length ? projectEvents(senderEvents).sessionName ?? null : null, recipientName: recipientEvents.length ? projectEvents(recipientEvents).sessionName ?? null : null };
  }

  async acknowledgeMessage(sessionId: string, branchId: string, messageId: string): Promise<MailboxRecord>;
  async acknowledgeMessage(sessionId: string, messageId: string): Promise<MailboxRecord>;
  async acknowledgeMessage(sessionId: string, branchOrMessageId: string, rawMessageId?: string): Promise<MailboxRecord> {
    const messageId = rawMessageId ?? branchOrMessageId;
    const message = await this.#recursive.getMailboxMessage(messageId); if (!message) throw new NotFoundError("mailbox message", messageId);
    const branchId = rawMessageId === undefined ? message.toBranchId : branchOrMessageId;
    if (message.toSessionId !== sessionId || message.toBranchId !== branchId) throw new ValidationError("Only the mailbox recipient can acknowledge a message");
    if (!message.deliveredToContext) throw new ValidationError("A family message cannot be acknowledged before context delivery");
    if (message.acknowledged) return message;
    const acknowledgedAt = new Date().toISOString(); const common = { mailboxMessageId: messageId, acknowledgedBySessionId: sessionId, acknowledgedAt };
    await this.storage.appendEvents([{
      sessionId, branchId, type: "MailboxMessageAcknowledged", producer: "client", idempotencyKey: `mailbox-ack-recipient:${messageId}`, payload: common,
    }, {
      sessionId: message.fromSessionId, branchId: message.fromBranchId, type: "MailboxMessageAcknowledged", producer: "supervisor", idempotencyKey: `mailbox-ack-sender:${messageId}`, payload: common,
    }]);
    const updated = await this.#recursive.getMailboxMessage(messageId); if (!updated) throw new NotFoundError("mailbox message", messageId); return updated;
  }

  async completeTask(childSessionId: string, childBranchId: string, input?: CompleteTaskInput): Promise<TaskRecord>;
  async completeTask(taskId: string, input?: CompleteTaskInput | JsonValue): Promise<TaskRecord>;
  async completeTask(first: string, second: string | CompleteTaskInput | JsonValue = {}, third: CompleteTaskInput = {}): Promise<TaskRecord> {
    if (typeof second === "string") {
      if (arguments.length < 3) {
        const direct = await this.#recursive.getTask(first);
        if (direct) return this.#terminal(direct, "completed", { result: second });
      }
      const task = await this.#recursive.findTaskByChild(first); if (!task) throw new NotFoundError("task for child", first);
      if (task.childBranchId !== second) throw new ValidationError("Task child branch does not match");
      if (third.result !== undefined) assertJsonValue(third.result);
      return this.#terminal(task, "completed", { ...(third.result === undefined ? {} : { result: third.result }), ...(third.artifactIds === undefined ? {} : { artifactIds: [...third.artifactIds] }) });
    }
    const looksLikeOptions = second !== null && !Array.isArray(second) && typeof second === "object" && ("result" in second || "artifactIds" in second || "taskId" in second);
    const input: CompleteTaskInput = looksLikeOptions ? second as CompleteTaskInput : { result: second as JsonValue };
    const task = await this.#recursive.getTask(input.taskId ?? first); if (!task) throw new NotFoundError("task", input.taskId ?? first);
    if (input.result !== undefined) assertJsonValue(input.result);
    return this.#terminal(task, "completed", { ...(input.result === undefined ? {} : { result: input.result }), ...(input.artifactIds === undefined ? {} : { artifactIds: [...input.artifactIds] }) });
  }

  async failTask(childSessionId: string, childBranchId: string, input: FailTaskInput): Promise<TaskRecord>;
  async failTask(taskId: string, input: FailTaskInput | string): Promise<TaskRecord>;
  async failTask(first: string, second: string | FailTaskInput, third?: FailTaskInput): Promise<TaskRecord> {
    if (typeof second === "string" && third === undefined) {
      const direct = await this.#recursive.getTask(first); if (!direct) throw new NotFoundError("task", first);
      return this.#terminal(direct, "failed", { error: second });
    }
    const byChild = typeof second === "string"; const input = byChild ? third : second;
    if (!input) throw new ValidationError("Task failure requires an error");
    const task = byChild ? await this.#recursive.findTaskByChild(first) : await this.#recursive.getTask(input.taskId ?? first);
    if (!task) throw new NotFoundError("task", input.taskId ?? first);
    if (byChild && task.childBranchId !== second) throw new ValidationError("Task child branch does not match");
    return this.#terminal(task, "failed", { error: input.error, ...(input.artifactIds === undefined ? {} : { artifactIds: [...input.artifactIds] }) });
  }

  async cancel(parentSessionId: string, parentBranchId: string, taskId: string, reason?: string): Promise<TaskRecord>;
  async cancel(taskId: string, reason?: string): Promise<TaskRecord>;
  async cancel(first: string, second?: string, third?: string, fourth?: string): Promise<TaskRecord> {
    const scoped = third !== undefined; const taskId = scoped ? third : first; const requestedReason = scoped ? fourth : second;
    const task = await this.#recursive.getTask(taskId); if (!task) throw new NotFoundError("task", taskId);
    if (scoped && (task.parentSessionId !== first || task.parentBranchId !== second)) throw new ValidationError("Task does not belong to the supplied parent branch");
    if (["completed", "failed", "cancelled"].includes(task.status)) return task;

    // Once intent is canonical, its original reason is authoritative. Retrying
    // with a missing or different reason must continue the cascade rather than
    // reuse the idempotency key with a conflicting payload.
    const cascadeReason = task.cancellationRequested ? task.reason : requestedReason;
    const cascade: TaskRecord[] = [];
    const visit = async (current: TaskRecord): Promise<void> => {
      cascade.push(current);
      for (const descendant of await this.#recursive.listTasks(current.childSessionId)) {
        if (!["completed", "failed", "cancelled"].includes(descendant.status)) await visit(descendant);
      }
    };
    await visit(task);
    for (const snapshot of cascade) {
      const current = await this.#recursive.getTask(snapshot.taskId);
      if (!current || ["completed", "failed", "cancelled"].includes(current.status)) continue;
      if (!current.cancellationRequested) {
        await this.storage.appendEvents([{
          sessionId: current.parentSessionId, branchId: current.parentBranchId, type: "SubagentCancellationRequested", producer: "client",
          idempotencyKey: `task-cancel-request:${current.taskId}`, payload: { taskId: current.taskId, childSessionId: current.childSessionId, ...(cascadeReason === undefined ? {} : { reason: cascadeReason }) },
        }]);
      }
      if (this.#runs) {
        const child = projectEvents(await this.storage.loadEvents(current.childSessionId, { branchId: current.childBranchId }));
        const activeRun = Object.values(child.agentRuns).find((run) => !["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status));
        if (activeRun) await this.#runs.cancel(current.childSessionId, current.childBranchId, activeRun.id, cascadeReason);
      }
      if (this.outbox) {
        const child = projectEvents(await this.storage.loadEvents(current.childSessionId, { branchId: current.childBranchId }));
        for (const effect of Object.values(child.effects)) {
          if (!["requested", "started"].includes(effect.status)) continue;
          const aborted = this.outbox.cancel(effect.id);
          if (!aborted) {
            const durable = await this.storage.getOutbox(effect.id);
            // A pending row has no current executor owner. Cancellation can win
            // durably before startup drain; a running row remains ambiguous and
            // is reconciled by ordinary outbox recovery instead.
            if (durable?.status === "pending") await this.storage.appendEvents([{
              sessionId: current.childSessionId, branchId: current.childBranchId, type: "EffectOutcomeRecorded", producer: "recovery",
              idempotencyKey: `task-cancel-effect:${current.taskId}:${effect.id}`, payload: { effectId: effect.id, attempt: Math.max(1, durable.attempt), outcome: "cancelled", error: "Task cancellation won before queued effect execution", observedAt: new Date().toISOString() },
            }]);
          }
        }
      }
    }
    for (const snapshot of [...cascade].reverse()) {
      const current = await this.#recursive.getTask(snapshot.taskId);
      if (!current || ["completed", "failed", "cancelled"].includes(current.status)) continue;
      const recordedReason = current.cancellationRequested ? current.reason : cascadeReason;
      await this.#terminal(current, "cancelled", { ...(recordedReason === undefined ? {} : { reason: recordedReason }) });
    }
    const updated = await this.#recursive.getTask(taskId); if (!updated) throw new NotFoundError("task", taskId); return updated;
  }

  /** Completes durable cancellation intents left by any crash prefix. */
  async recoverCancellations(): Promise<number> {
    const pending = new Map<string, TaskRecord>();
    for (const branch of await this.storage.listBranches()) {
      const events = await this.storage.loadEvents(branch.sessionId, { branchId: branch.branchId });
      if (!events.length) continue;
      for (const task of Object.values(projectEvents(events).tasks)) {
        if (!task.cancellationRequested || ["completed", "failed", "cancelled"].includes(task.status)) continue;
        const record = await this.#recursive.getTask(task.id);
        if (record) pending.set(record.taskId, record);
      }
    }
    const ordered = await Promise.all([...pending.values()].map(async (task) => ({ task, depth: (await this.#recursive.getSession(task.childSessionId))?.depth ?? Number.MAX_SAFE_INTEGER })));
    ordered.sort((left, right) => left.depth - right.depth || left.task.taskId.localeCompare(right.task.taskId));
    for (const { task } of ordered) {
      const current = await this.#recursive.getTask(task.taskId);
      if (current && !["completed", "failed", "cancelled"].includes(current.status)) await this.cancel(current.taskId, current.reason);
    }
    return pending.size;
  }

  listTasks(parentSessionId: string, parentBranchId?: string): Promise<TaskRecord[]> { return this.#recursive.listTasks(parentSessionId, parentBranchId); }
  listChildren(parentSessionId: string): Promise<SessionRecord[]> { return this.#recursive.listChildren(parentSessionId); }

  async #remainingTaskReservation(task: TaskRecord): Promise<BudgetLimits> {
    const events = await this.storage.loadEvents(task.childSessionId, { branchId: task.childBranchId });
    const descendant = { tokens: 0, costUsd: 0, turns: 0, wallTimeMs: 0 };
    for (const event of events) {
      if (event.type !== "TaskUsageAttributed") continue;
      const usage = event.payload as EventPayloads["TaskUsageAttributed"];
      descendant.tokens += usage.tokens; descendant.costUsd += usage.costUsd;
      descendant.turns += usage.turns; descendant.wallTimeMs += usage.wallTimeMs;
    }
    const result: { tokenLimit?: number; costLimitUsd?: number; turnLimit?: number; wallTimeLimitMs?: number } = {};
    if (task.budget.tokenLimit !== undefined) result.tokenLimit = Math.max(0, task.budget.tokenLimit - descendant.tokens);
    if (task.budget.costLimitUsd !== undefined) result.costLimitUsd = Math.max(0, task.budget.costLimitUsd - descendant.costUsd);
    if (task.budget.turnLimit !== undefined) result.turnLimit = Math.max(0, task.budget.turnLimit - descendant.turns);
    if (task.budget.wallTimeLimitMs !== undefined) result.wallTimeLimitMs = Math.max(0, task.budget.wallTimeLimitMs - descendant.wallTimeMs);
    return result;
  }

  async #terminal(task: TaskRecord, status: "completed" | "failed" | "cancelled", detail: { result?: JsonValue; artifactIds?: string[]; error?: string; reason?: string }): Promise<TaskRecord> {
    let terminalDetail = detail;
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      if (task.status === status) {
        // Re-append the stable terminal transaction so recovery can complete a
        // child/parent delivery prefix. Existing events are true idempotent
        // no-ops; any missing suffix is committed exactly once.
        const retained = (await this.storage.loadEvents(task.parentSessionId, {
          branchId: task.parentBranchId,
        })).filter((event) =>
          event.type === "TaskStatusChanged" &&
          (event.payload as EventPayloads["TaskStatusChanged"]).taskId ===
            task.taskId &&
          (event.payload as EventPayloads["TaskStatusChanged"]).status === status
        ).at(-1);
        if (retained) {
          const payload =
            retained.payload as EventPayloads["TaskStatusChanged"];
          terminalDetail = {
            ...(payload.result === undefined ? {} : { result: payload.result }),
            ...(payload.artifactIds === undefined
              ? {}
              : { artifactIds: [...payload.artifactIds] }),
            ...(payload.error === undefined ? {} : { error: payload.error }),
            ...(payload.reason === undefined ? {} : { reason: payload.reason }),
          };
        }
      } else {
        throw new ValidationError(`Task is already ${task.status}`);
      }
    }
    const noticeId = `notice-${task.taskId}`; const sentEventId = `terminal-sent-${task.taskId}`;
    const terminal = { noticeId, taskId: task.taskId, parentSessionId: task.parentSessionId, childSessionId: task.childSessionId, status, ...terminalDetail };
    const change = { taskId: task.taskId, status, ...terminalDetail };
    const events: NewAgentEvent[] = [{
      id: sentEventId, sessionId: task.childSessionId, branchId: task.childBranchId, type: "TaskTerminalNoticeSent", producer: "supervisor", idempotencyKey: `task-terminal-sent:${task.taskId}`, payload: terminal,
    }, {
      sessionId: task.parentSessionId, branchId: task.parentBranchId, type: "TaskStatusChanged", producer: "supervisor", idempotencyKey: `task-terminal-status:${task.taskId}`, payload: change,
    }, {
      sessionId: task.parentSessionId, branchId: task.parentBranchId, type: "TaskTerminalNoticeDelivered", producer: "supervisor", idempotencyKey: `task-terminal-delivered:${task.taskId}`, payload: { ...terminal, sentEventId },
    }, {
      sessionId: task.childSessionId, branchId: task.childBranchId, type: "SessionStatusChanged", producer: "supervisor", idempotencyKey: `task-terminal-session:${task.taskId}`, payload: { status: status === "failed" ? "failed" : "stopped", reason: `Task ${status}` },
    }];
    events.push(...await this.#usageAttributionEvents(task));
    // Terminal status, notice delivery, child stop, and tree-budget attribution
    // are one append transaction. Therefore retry can never double-debit.
    await this.storage.appendEvents(events);
    const updated = await this.#recursive.getTask(task.taskId); if (!updated) throw new NotFoundError("task", task.taskId); return updated;
  }

  async #usageAttributionEvents(task: TaskRecord): Promise<NewAgentEvent[]> {
    const childEvents = await this.storage.loadEvents(task.childSessionId, { branchId: task.childBranchId });
    const child = projectEvents(childEvents);
    const ownCalls = new Set(Object.keys(child.modelCalls));
    const ownGenerations = new Set(Object.keys(child.aiGenerations));
    let tokens = 0; let costUsd = 0; let turns = 0; let wallTimeMs = 0;
    for (const event of childEvents) {
      if (event.type === "BudgetDebited") {
        const payload = event.payload as EventPayloads["BudgetDebited"];
        if (!ownCalls.has(payload.callId)) continue;
        tokens += payload.tokens; costUsd += payload.costUsd; turns += payload.turns; wallTimeMs += payload.wallTimeMs;
      } else if (event.type === "AiGenerationBudgetDebited") {
        const payload = event.payload as EventPayloads["AiGenerationBudgetDebited"];
        if (!ownGenerations.has(payload.generationId)) continue;
        tokens += payload.tokens; costUsd += payload.costUsd; turns += payload.turns; wallTimeMs += payload.wallTimeMs;
      }
    }
    const descendant = { tokens: 0, costUsd: 0, turns: 0, wallTimeMs: 0 };
    for (const event of childEvents) {
      if (event.type !== "TaskUsageAttributed") continue;
      const payload = event.payload as EventPayloads["TaskUsageAttributed"];
      descendant.tokens += payload.tokens; descendant.costUsd += payload.costUsd;
      descendant.turns += payload.turns; descendant.wallTimeMs += payload.wallTimeMs;
    }
    let conservative =
      Object.values(child.modelCalls).some((call) => call.status === "unknown") ||
      Object.values(child.aiGenerations).some((generation) =>
        generation.budgetDebited?.usageSource === "conservative-guard-estimate");
    if (conservative) {
      tokens = Math.max(tokens, task.budget.tokenLimit === undefined ? tokens : Math.max(0, task.budget.tokenLimit - descendant.tokens));
      costUsd = Math.max(costUsd, task.budget.costLimitUsd === undefined ? costUsd : Math.max(0, task.budget.costLimitUsd - descendant.costUsd));
      turns = Math.max(turns, task.budget.turnLimit === undefined ? turns : Math.max(0, task.budget.turnLimit - descendant.turns));
      wallTimeMs = Math.max(wallTimeMs, task.budget.wallTimeLimitMs === undefined ? wallTimeMs : Math.max(0, task.budget.wallTimeLimitMs - descendant.wallTimeMs));
    }
    const retainedUsage = (await this.storage.loadEvents(task.parentSessionId, {
      branchId: task.parentBranchId,
    })).filter((event) =>
      event.type === "TaskUsageAttributed" &&
      (event.payload as EventPayloads["TaskUsageAttributed"]).taskId ===
        task.taskId
    ).at(-1)?.payload as EventPayloads["TaskUsageAttributed"] | undefined;
    if (retainedUsage) {
      tokens = retainedUsage.tokens;
      costUsd = retainedUsage.costUsd;
      turns = retainedUsage.turns;
      wallTimeMs = retainedUsage.wallTimeMs;
      conservative = retainedUsage.conservative;
    }
    const usage = { taskId: task.taskId, childSessionId: task.childSessionId, tokens, costUsd, turns, wallTimeMs, conservative };
    const result: NewAgentEvent[] = [];
    let sessionId: string | null = task.parentSessionId;
    let branchId: string | null = task.parentBranchId;
    while (sessionId && branchId) {
      const ancestorEvents = await this.storage.loadEvents(sessionId, { branchId });
      if (!ancestorEvents.length) throw new NotFoundError("ancestor branch", `${sessionId}/${branchId}`);
      const ancestor = projectEvents(ancestorEvents);
      const existingAttribution = ancestorEvents.find((event) =>
        event.type === "TaskUsageAttributed" &&
        (event.payload as EventPayloads["TaskUsageAttributed"]).taskId ===
          task.taskId
      );
      if (existingAttribution) {
        if (!Bun.deepEquals(existingAttribution.payload, usage)) {
          throw new ValidationError(
            `Task usage attribution disagrees across ancestors for ${task.taskId}`,
          );
        }
      } else {
        result.push({
          sessionId, branchId, type: "TaskUsageAttributed", producer: "supervisor",
          idempotencyKey: `task-usage:${task.taskId}`, payload: usage,
        });
        const exceeded = budgetReached(ancestor.budget.limits, {
          tokens: ancestor.budget.tokens + tokens, costUsd: ancestor.budget.costUsd + costUsd,
          turns: ancestor.budget.turns + turns, wallTimeMs: ancestor.budget.wallTimeMs + wallTimeMs,
        });
        if (exceeded) result.push({
          sessionId, branchId, type: "BudgetExceeded", producer: "supervisor",
          idempotencyKey: `task-usage-exceeded:${task.taskId}:${exceeded.dimension}`, payload: exceeded,
        });
      }
      const record = await this.#recursive.getSession(sessionId);
      sessionId = record?.parentSessionId ?? null;
      branchId = record?.parentBranchId ?? null;
    }
    return result;
  }

}

function assertInvocationBatchSize(
  inputs: readonly (SpawnAgentInput | string)[],
): void {
  if (!Array.isArray(inputs)) {
    throw new ValidationError("Agent invocation inputs must be an array");
  }
  if (inputs.length < 1 || inputs.length > MAX_AGENT_INVOCATION_BATCH_SIZE) {
    throw new ValidationError(
      `Agent invocation batch requires 1-${MAX_AGENT_INVOCATION_BATCH_SIZE} inputs`,
    );
  }
}

function assertInvocationContractSecretFree(
  contract: AgentInvocationContract,
): void {
  if (contract.output.kind !== "object") return;
  const schema = contract.output.declaredSchema.schema;
  if (
    containsBrokeredSecret(schema) ||
    containsCredentialMaterial(canonicalJsonStringify(schema))
  ) {
    throw new ValidationError(
      "Declared JSON Schema contains credential material",
    );
  }
}

interface FamilyCandidate {
  readonly session: SessionRecord | null;
  readonly sessionId: string;
  readonly branchId: string;
  readonly relationship: FamilyRelationship;
  readonly depth: number;
  readonly taskId: string | null;
  readonly taskFallback: string | null;
  readonly taskShapesActivity: boolean;
}

function candidateFromTask(
  session: SessionRecord | null,
  task: AgentState["tasks"][string],
  relationship: "child" | "sibling",
  depth: number,
): FamilyCandidate {
  return {
    session,
    sessionId: task.childSessionId,
    branchId: task.childBranchId,
    relationship,
    depth,
    taskId: task.id,
    taskFallback: task.task,
    taskShapesActivity: true,
  };
}

function latestAgentRun(state: AgentState): AgentRunState | null {
  let selected: AgentRunState | null = null;
  let selectedOrder = -1;
  const order = new Map(state.appliedEventIds.map((eventId, index) => [eventId, index]));
  for (const run of Object.values(state.agentRuns)) {
    const runOrder = order.get(run.eventId) ?? -1;
    if (runOrder > selectedOrder || runOrder === selectedOrder && run.id.localeCompare(selected?.id ?? "") > 0) {
      selected = run;
      selectedOrder = runOrder;
    }
  }
  return selected;
}

export function deriveFamilyAgentActivity(
  state: AgentState | null,
  task: TaskRecord | null,
  taskExpected = task !== null,
): { readonly activity: FamilyAgentActivity; readonly activityReason: FamilyAgentActivityReason } {
  if (!state || taskExpected && !task) return { activity: "unavailable", activityReason: "missing_state" };
  const latestRun = latestAgentRun(state);
  const unknownEffect = Object.values(state.effects).some(effect => effect.status === "unknown");
  if (task?.cancellationRequested && !["completed", "failed", "cancelled"].includes(task.status) ||
      latestRun?.cancellationRequested && latestRun.status !== "cancelled") {
    return { activity: "attention", activityReason: "cancellation_pending" };
  }
  if (unknownEffect) return { activity: "attention", activityReason: "unknown" };
  if (state.budget.exceeded || latestRun?.status === "budget_exceeded") {
    return { activity: "attention", activityReason: "budget_exceeded" };
  }
  if (task?.status === "failed" || state.status === "failed" || latestRun?.status === "failed") {
    return { activity: "attention", activityReason: "failed" };
  }
  if (latestRun?.status === "blocked") return { activity: "attention", activityReason: "blocked" };
  if (latestRun?.status === "unknown") return { activity: "attention", activityReason: "unknown" };
  if (task?.status === "cancelled" || latestRun?.status === "cancelled") {
    return { activity: "ended", activityReason: "cancelled" };
  }
  if (state.status === "archived") return { activity: "ended", activityReason: "archived" };
  if (task?.status === "running" ||
      latestRun && ["queued", "running"].includes(latestRun.status) ||
      state.status === "running") {
    return { activity: "working", activityReason: null };
  }
  return { activity: "idle", activityReason: null };
}


function sameMailboxMeaning(record: MailboxRecord, value: EventPayloads["MailboxMessageSent"]): boolean {
  return record.fromSessionId === value.fromSessionId && record.fromBranchId === value.fromBranchId &&
    record.toSessionId === value.toSessionId && record.toBranchId === value.toBranchId &&
    record.kind === value.kind && record.content === value.content && record.taskId === (value.taskId ?? null) &&
    Bun.deepEquals(record.artifactIds, value.artifactIds ?? []) && record.intentKey === (value.intentKey ?? null) &&
    record.followUp === (value.followUp ?? false) && record.replyToMessageId === (value.replyToMessageId ?? null);
}

function inverseRelationship(relationship: FamilyRelationship): FamilyRelationship {
  return relationship === "parent" ? "child" : relationship === "child" ? "parent" : "sibling";
}
function relationshipRank(relationship: FamilyRelationship): number { return relationship === "parent" ? 0 : relationship === "child" ? 1 : 2; }
function encodeMessageCursor(message: Pick<MailboxRecord, "sentAt" | "mailboxMessageId">): string {
  return Buffer.from(JSON.stringify({ sentAt: message.sentAt, id: message.mailboxMessageId }), "utf8").toString("base64url");
}
function decodeMessageCursor(cursor: string): { sentAt: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof value.sentAt !== "string" || !Number.isFinite(Date.parse(value.sentAt)) || typeof value.id !== "string" || !value.id) throw new Error();
    return { sentAt: value.sentAt, id: value.id };
  } catch { throw new ValidationError("Invalid family message pagination cursor"); }
}

function spawnRunId(taskId: string): string { return `agent-spawn-run-${stableId(taskId)}`; }
function stableId(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256"); hasher.update(value); return hasher.digest("hex").slice(0, 32);
}

function assertChildLimits(parentModel: ModelConfiguration, parentBudget: BudgetLimits, model: ModelConfiguration, budget: BudgetLimits): void {
  if (parentModel.maxOutputTokens !== undefined && (model.maxOutputTokens ?? parentModel.maxOutputTokens) > parentModel.maxOutputTokens) {
    throw new ValidationError("Child model output limit cannot exceed the parent model limit");
  }
  for (const key of ["tokenLimit", "costLimitUsd", "turnLimit", "wallTimeLimitMs"] as const) {
    const parent = parentBudget[key]; const child = budget[key];
    if (parent !== undefined && child !== undefined && child > parent) throw new ValidationError(`Child budget ${key} exceeds parent limit`);
    if (parent !== undefined && child === undefined) throw new ValidationError(`Child budget ${key} cannot remove a parent limit`);
  }
}

type BudgetSpent = { readonly tokens: number; readonly costUsd: number; readonly turns: number; readonly wallTimeMs: number };
const budgetDimension = {
  tokenLimit: "tokens", costLimitUsd: "costUsd", turnLimit: "turns", wallTimeLimitMs: "wallTimeMs",
} as const;

function remainingBudget(parent: BudgetLimits, spent: BudgetSpent): BudgetLimits {
  const result: { tokenLimit?: number; costLimitUsd?: number; turnLimit?: number; wallTimeLimitMs?: number } = {};
  for (const key of ["tokenLimit", "costLimitUsd", "turnLimit", "wallTimeLimitMs"] as const) {
    const limit = parent[key];
    if (limit !== undefined) result[key] = Math.max(0, limit - spent[budgetDimension[key]]);
  }
  return result;
}

function assertBudgetReservations(parent: BudgetLimits, spent: BudgetSpent, reservations: readonly BudgetLimits[]): void {
  for (const key of ["tokenLimit", "costLimitUsd", "turnLimit", "wallTimeLimitMs"] as const) {
    const limit = parent[key]; if (limit === undefined) continue;
    const used = spent[budgetDimension[key]];
    const total = used + reservations.reduce((sum, budget) => sum + (budget[key] ?? Math.max(0, limit - used)), 0);
    if (total > limit) throw new ValidationError(`Spent budget plus active child reservations exceed parent ${key} limit`);
  }
}

function budgetReached(limits: BudgetLimits, spent: BudgetSpent): EventPayloads["BudgetExceeded"] | null {
  if (limits.tokenLimit !== undefined && spent.tokens >= limits.tokenLimit) return { dimension: "tokens", limit: limits.tokenLimit, spent: spent.tokens };
  if (limits.costLimitUsd !== undefined && spent.costUsd >= limits.costLimitUsd) return { dimension: "cost", limit: limits.costLimitUsd, spent: spent.costUsd };
  if (limits.turnLimit !== undefined && spent.turns >= limits.turnLimit) return { dimension: "turns", limit: limits.turnLimit, spent: spent.turns };
  if (limits.wallTimeLimitMs !== undefined && spent.wallTimeMs >= limits.wallTimeLimitMs) return { dimension: "wallTime", limit: limits.wallTimeLimitMs, spent: spent.wallTimeMs };
  return null;
}

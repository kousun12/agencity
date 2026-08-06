import {
  NotFoundError, ValidationError, assertJsonValue, newId, projectEvents,
  type BudgetLimits, type EventPayloads, type JsonValue, type ModelConfiguration, type NewAgentEvent, type TaskStatus,
} from "../domain/index.ts";
import {
  requireRecursiveStorage, type AgentStorage, type MailboxRecord, type SessionRecord, type TaskRecord,
} from "../storage/index.ts";
import type { OutboxRunner } from "./outbox.ts";

export interface SpawnAgentInput {
  readonly task: string;
  readonly completionCriteria?: string;
  readonly model?: ModelConfiguration;
  readonly budget?: BudgetLimits;
  /** Stable command identity. Reusing it with the same request returns the original handle. */
  readonly idempotencyKey?: string;
  readonly sessionId?: string;
  readonly branchId?: string;
}
export interface SubagentHandle {
  readonly taskId: string; readonly sessionId: string; readonly branchId: string;
  readonly parentSessionId: string; readonly parentBranchId: string; readonly rootSessionId: string;
  readonly depth: number; readonly status: TaskStatus;
}
export interface SpawnAdmissionItem { readonly input: SpawnAgentInput; readonly handle: SubagentHandle; readonly existing: boolean; }
export type SendMessageInput =
  | { readonly toSessionId: string; readonly toBranchId?: string; readonly content: string; readonly taskId?: string }
  | { readonly recipientSessionId: string; readonly recipientBranchId?: string; readonly message: string; readonly taskId?: string };
export interface MailboxMessageHandle { readonly mailboxMessageId: string; readonly fromSessionId: string; readonly fromBranchId: string; readonly toSessionId: string; readonly toBranchId: string; readonly delivered: true; }
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
  readonly #admissions = new AdmissionQueue();
  constructor(readonly storage: AgentStorage, readonly outbox?: OutboxRunner, readonly maxDepth = 8, readonly maxChildren = 32) {
    this.#recursive = requireRecursiveStorage(storage);
  }

  spawn(parentSessionId: string, parentBranchId: string, input: SpawnAgentInput | string): Promise<SubagentHandle> {
    return this.spawnMany(parentSessionId, parentBranchId, [input]).then((handles) => handles[0]!);
  }

  spawnMany(parentSessionId: string, parentBranchId: string, rawInputs: readonly (SpawnAgentInput | string)[]): Promise<SubagentHandle[]> {
    return this.spawnManyWithEvents(parentSessionId, parentBranchId, rawInputs, () => []);
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
  ): Promise<SubagentHandle[]> {
    return this.#admissions.run(`${parentSessionId}/${parentBranchId}`, async () => {
      const inputs = rawInputs.map((input): SpawnAgentInput => typeof input === "string" ? { task: input } : input);
      if (inputs.length === 0) return [];
      for (const input of inputs) {
        if (!input.task.trim()) throw new ValidationError("Subagent task cannot be empty");
        if (input.idempotencyKey !== undefined && !input.idempotencyKey.trim()) throw new ValidationError("Subagent idempotencyKey cannot be empty");
      }
      const parent = await this.#recursive.getSession(parentSessionId);
      if (!parent) throw new NotFoundError("parent session", parentSessionId);
      const parentEvents = await this.storage.loadEvents(parentSessionId, { branchId: parentBranchId });
      if (!parentEvents.length) throw new NotFoundError("parent branch", `${parentSessionId}/${parentBranchId}`);
      const parentState = projectEvents(parentEvents);
      if (parent.depth + 1 > this.maxDepth) throw new ValidationError(`Maximum session depth ${this.maxDepth} exceeded`);
      const inheritedBudget = remainingBudget(parentState.budget.limits, parentState.budget);

      const prepared = inputs.map((input) => {
        const stable = input.idempotencyKey === undefined ? undefined : stableId(`${parentSessionId}/${parentBranchId}/${input.idempotencyKey}`);
        const taskId = stable === undefined ? newId() : `task-${stable}`;
        const childSessionId = input.sessionId ?? (stable === undefined ? newId() : `session-${stable}`);
        const childBranchId = input.branchId ?? (stable === undefined ? newId() : `branch-${stable}`);
        const model = input.model ?? parentState.model;
        const budget = input.budget ?? inheritedBudget;
        return { input, taskId, childSessionId, childBranchId, model, budget };
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
        if (task && item.input.model === undefined) item.model = task.model;
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
      const novel = prepared.filter((_item, index) => !existing[index]);
      const directTasks = await this.#recursive.listTasks(parentSessionId);
      const activeDirect = directTasks.filter((task) => !["completed", "failed", "cancelled"].includes(task.status));
      if (activeDirect.length + novel.length > this.maxChildren) throw new ValidationError(`Maximum active child count ${this.maxChildren} exceeded`);

      for (const item of novel) assertChildPolicy(parentState.model, parentState.budget.limits, item.model, item.budget);
      const activeTasks = directTasks.filter((task) => task.parentBranchId === parentBranchId && !["completed", "failed", "cancelled"].includes(task.status));
      const activeReservations = await Promise.all(activeTasks.map((task) => this.#remainingTaskReservation(task)));
      assertBudgetReservations(parentState.budget.limits, parentState.budget, [...activeReservations, ...novel.map((item) => item.budget)]);

      const rootSessionId = parent.rootSessionId; const depth = parent.depth + 1;
      const handles = prepared.map((item, index): SubagentHandle => ({
        taskId: item.taskId, sessionId: item.childSessionId, branchId: item.childBranchId,
        parentSessionId, parentBranchId, rootSessionId, depth, status: existing[index]?.status ?? "admitted",
      }));
      const admissionItems = prepared.map((item, index): SpawnAdmissionItem => ({ input: item.input, handle: handles[index]!, existing: existing[index] !== null }));
      const now = new Date().toISOString(); const events: NewAgentEvent[] = [];
      for (let index = 0; index < prepared.length; index++) {
        if (existing[index]) continue;
        const item = prepared[index]!;
        const { input, taskId, childSessionId, childBranchId, model, budget } = item;
        events.push({
          sessionId: parentSessionId, branchId: parentBranchId, type: "TaskCreated", producer: "supervisor",
          idempotencyKey: `task:${taskId}`, payload: { taskId, parentSessionId, parentBranchId, childSessionId, childBranchId, task: input.task, ...(input.completionCriteria === undefined ? {} : { completionCriteria: input.completionCriteria }), model, budget },
        }, {
          sessionId: childSessionId, branchId: childBranchId, type: "SessionCreated", producer: "supervisor",
          idempotencyKey: `session:${childSessionId}`, payload: { workspaceId: parent.workspaceId, initialBranchId: childBranchId, model, budget, parentSessionId, parentBranchId, rootSessionId, depth, taskId },
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
    const toSessionId = "toSessionId" in input ? input.toSessionId : input.recipientSessionId;
    const requestedBranch = "toSessionId" in input ? input.toBranchId : input.recipientBranchId;
    const content = "toSessionId" in input ? input.content : input.message;
    const source = await this.#recursive.getSession(fromSessionId); if (!source) throw new NotFoundError("sender session", fromSessionId);
    const target = await this.#recursive.getSession(toSessionId); if (!target) throw new NotFoundError("recipient session", toSessionId);
    const toBranchId = requestedBranch ?? target.initialBranchId;
    if (source.sessionId === target.sessionId) throw new ValidationError("Use conversation messages for communication within one session");
    if (source.rootSessionId !== target.rootSessionId) throw new ValidationError("Mailbox communication is restricted to one related session family");
    if (!(await this.storage.loadEvents(fromSessionId, { branchId: fromBranchId })).length ||
        !(await this.storage.loadEvents(toSessionId, { branchId: toBranchId })).length) {
      throw new NotFoundError("mailbox branch", `${fromSessionId}/${fromBranchId} -> ${toSessionId}/${toBranchId}`);
    }
    if (input.taskId !== undefined) {
      const task = await this.#recursive.getTask(input.taskId);
      if (!task) throw new ValidationError("Mailbox taskId does not name a durable family task");
      const taskParent = await this.#recursive.getSession(task.parentSessionId);
      const taskChild = await this.#recursive.getSession(task.childSessionId);
      if (taskParent?.rootSessionId !== source.rootSessionId || taskChild?.rootSessionId !== source.rootSessionId) {
        throw new ValidationError("Mailbox taskId cannot spoof an unrelated task family");
      }
      if (![fromSessionId, target.sessionId].includes(task.parentSessionId) && ![fromSessionId, target.sessionId].includes(task.childSessionId)) {
        throw new ValidationError("Mailbox taskId is not authorized for either endpoint");
      }
    }
    const mailboxMessageId = newId(); const sentEventId = newId();
    const common = { mailboxMessageId, fromSessionId, fromBranchId, toSessionId: target.sessionId, toBranchId, kind: "message" as const, content, ...(input.taskId === undefined ? {} : { taskId: input.taskId }) };
    await this.storage.appendEvents([{
      id: sentEventId, sessionId: fromSessionId, branchId: fromBranchId, type: "MailboxMessageSent", producer: "client", idempotencyKey: `mailbox-sent:${mailboxMessageId}`, payload: common,
    }, {
      sessionId: target.sessionId, branchId: toBranchId, type: "MailboxMessageDelivered", producer: "supervisor", idempotencyKey: `mailbox-delivered:${mailboxMessageId}`, payload: { ...common, sentEventId },
    }]);
    return { mailboxMessageId, fromSessionId, fromBranchId, toSessionId: target.sessionId, toBranchId, delivered: true };
  }

  async acknowledgeMessage(sessionId: string, branchId: string, messageId: string): Promise<MailboxRecord>;
  async acknowledgeMessage(sessionId: string, messageId: string): Promise<MailboxRecord>;
  async acknowledgeMessage(sessionId: string, branchOrMessageId: string, rawMessageId?: string): Promise<MailboxRecord> {
    const messageId = rawMessageId ?? branchOrMessageId;
    const message = await this.#recursive.getMailboxMessage(messageId); if (!message) throw new NotFoundError("mailbox message", messageId);
    const branchId = rawMessageId === undefined ? message.toBranchId : branchOrMessageId;
    if (message.toSessionId !== sessionId || message.toBranchId !== branchId) throw new ValidationError("Only the mailbox recipient can acknowledge a message");
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
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      if (task.status === status) return task;
      throw new ValidationError(`Task is already ${task.status}`);
    }
    const noticeId = `notice-${task.taskId}`; const sentEventId = `terminal-sent-${task.taskId}`;
    const terminal = { noticeId, taskId: task.taskId, parentSessionId: task.parentSessionId, childSessionId: task.childSessionId, status, ...detail };
    const change = { taskId: task.taskId, status, ...detail };
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
    let tokens = 0; let costUsd = 0; let turns = 0; let wallTimeMs = 0;
    for (const event of childEvents) {
      if (event.type !== "BudgetDebited") continue;
      const payload = event.payload as EventPayloads["BudgetDebited"];
      if (!ownCalls.has(payload.callId)) continue;
      tokens += payload.tokens; costUsd += payload.costUsd; turns += payload.turns; wallTimeMs += payload.wallTimeMs;
    }
    const descendant = { tokens: 0, costUsd: 0, turns: 0, wallTimeMs: 0 };
    for (const event of childEvents) {
      if (event.type !== "TaskUsageAttributed") continue;
      const payload = event.payload as EventPayloads["TaskUsageAttributed"];
      descendant.tokens += payload.tokens; descendant.costUsd += payload.costUsd;
      descendant.turns += payload.turns; descendant.wallTimeMs += payload.wallTimeMs;
    }
    const conservative = Object.values(child.modelCalls).some((call) => call.status === "unknown");
    if (conservative) {
      tokens = Math.max(tokens, task.budget.tokenLimit === undefined ? tokens : Math.max(0, task.budget.tokenLimit - descendant.tokens));
      costUsd = Math.max(costUsd, task.budget.costLimitUsd === undefined ? costUsd : Math.max(0, task.budget.costLimitUsd - descendant.costUsd));
      turns = Math.max(turns, task.budget.turnLimit === undefined ? turns : Math.max(0, task.budget.turnLimit - descendant.turns));
      wallTimeMs = Math.max(wallTimeMs, task.budget.wallTimeLimitMs === undefined ? wallTimeMs : Math.max(0, task.budget.wallTimeLimitMs - descendant.wallTimeMs));
    }
    const usage = { taskId: task.taskId, childSessionId: task.childSessionId, tokens, costUsd, turns, wallTimeMs, conservative };
    const result: NewAgentEvent[] = [];
    let sessionId: string | null = task.parentSessionId;
    let branchId: string | null = task.parentBranchId;
    while (sessionId && branchId) {
      const ancestorEvents = await this.storage.loadEvents(sessionId, { branchId });
      if (!ancestorEvents.length) throw new NotFoundError("ancestor branch", `${sessionId}/${branchId}`);
      const ancestor = projectEvents(ancestorEvents);
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
      const record = await this.#recursive.getSession(sessionId);
      sessionId = record?.parentSessionId ?? null;
      branchId = record?.parentBranchId ?? null;
    }
    return result;
  }

}


function stableId(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256"); hasher.update(value); return hasher.digest("hex").slice(0, 32);
}

function assertChildPolicy(parentModel: ModelConfiguration, parentBudget: BudgetLimits, model: ModelConfiguration, budget: BudgetLimits): void {
  if (model.provider !== parentModel.provider || model.model !== parentModel.model) {
    throw new ValidationError("Child model provider/model must remain within the parent model policy");
  }
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

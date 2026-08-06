import { NotFoundError, ValidationError, newId, projectEvents, type BudgetLimits, type ModelConfiguration, type NewAgentEvent } from "../domain/index.ts";
import { requireRecursiveStorage, type AgentStorage, type RecursiveModelRecord } from "../storage/index.ts";
import type { AgentService } from "./agents.ts";
import type { ModelLoop } from "./model-loop.ts";
import type { OutboxRunner } from "./outbox.ts";

export interface StartRecursiveModelInput { readonly prompt?: string; readonly task?: string; readonly inputSetId?: string; readonly model?: ModelConfiguration; readonly budget?: BudgetLimits; readonly run?: boolean; /** Stable command identity for crash-safe retry. */ readonly idempotencyKey?: string; }
export interface RecursiveModelHandle extends RecursiveModelRecord {}

export class RecursiveModelService {
  readonly #recursive;
  readonly #runs = new Set<Promise<void>>();
  readonly #runningHandles = new Set<string>();
  constructor(readonly storage: AgentStorage, readonly agents: AgentService, readonly modelLoop: ModelLoop, readonly outbox: OutboxRunner) { this.#recursive = requireRecursiveStorage(storage); }

  start(parentSessionId: string, parentBranchId: string, input: StartRecursiveModelInput | string): Promise<RecursiveModelHandle> {
    return this.startMany(parentSessionId, parentBranchId, [input]).then((handles) => handles[0]!);
  }

  async startMany(parentSessionId: string, parentBranchId: string, rawInputs: readonly (StartRecursiveModelInput | string)[]): Promise<RecursiveModelHandle[]> {
    if (rawInputs.length === 0) return [];
    const parentEvents = await this.storage.loadEvents(parentSessionId, { branchId: parentBranchId });
    if (!parentEvents.length) throw new NotFoundError("parent branch", `${parentSessionId}/${parentBranchId}`);
    const parent = projectEvents(parentEvents);
    const plans: Array<{ normalized: StartRecursiveModelInput; prompt: string; inputSetId?: string; selectedInput?: Array<{ chunkId: string; documentId: string; ordinal: number; content: string }>; admissionKey: string }> = [];
    for (const raw of rawInputs) {
      const normalized: StartRecursiveModelInput = typeof raw === "string" ? { prompt: raw } : raw;
      const prompt = normalized.prompt ?? normalized.task;
      if (!prompt?.trim()) throw new ValidationError("Recursive model prompt cannot be empty");
      if (normalized.idempotencyKey !== undefined && !normalized.idempotencyKey.trim()) throw new ValidationError("Recursive model idempotencyKey cannot be empty");
      let selectedInput: Array<{ chunkId: string; documentId: string; ordinal: number; content: string }> | undefined;
      if (normalized.inputSetId) {
        const inputSet = await this.#recursive.getInputSet(normalized.inputSetId);
        if (!inputSet) throw new NotFoundError("input set", normalized.inputSetId);
        const inputOwner = await this.#recursive.getSession(inputSet.sessionId);
        if (!inputOwner || inputOwner.rootSessionId !== parent.rootSessionId) throw new ValidationError("Recursive input set is outside the parent session family scope");
        selectedInput = [];
        for (const chunkId of inputSet.chunkIds) {
          const chunk = await this.#recursive.getDocumentChunk(chunkId);
          if (!chunk) throw new NotFoundError("document chunk", chunkId);
          selectedInput.push({ chunkId: chunk.chunkId, documentId: chunk.documentId, ordinal: chunk.ordinal, content: chunk.content });
        }
      }
      const commandKey = normalized.idempotencyKey ?? newId();
      plans.push({ normalized, prompt, ...(normalized.inputSetId === undefined ? {} : { inputSetId: normalized.inputSetId }), ...(selectedInput === undefined ? {} : { selectedInput }), admissionKey: `recursive-model:${commandKey}` });
    }
    const children = await this.agents.spawnManyWithEvents(parentSessionId, parentBranchId, plans.map((plan) => ({
      task: plan.prompt, idempotencyKey: plan.admissionKey,
      ...(plan.normalized.model === undefined ? {} : { model: plan.normalized.model }),
      ...(plan.normalized.budget === undefined ? {} : { budget: plan.normalized.budget }),
    })), (items) => {
      const events: NewAgentEvent[] = [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!; if (item.existing) continue;
        const plan = plans[index]!; const child = item.handle; const handleId = `model-${child.taskId}`;
        const model = plan.normalized.model ?? parent.model;
        events.push({
          sessionId: parentSessionId, branchId: parentBranchId, type: "RecursiveModelStarted", producer: "supervisor", idempotencyKey: `recursive-model:${handleId}`,
          payload: { handleId, taskId: child.taskId, parentSessionId, parentBranchId, childSessionId: child.sessionId, childBranchId: child.branchId, model, ...(plan.inputSetId === undefined ? {} : { inputSetId: plan.inputSetId }) },
        });
        if (plan.inputSetId !== undefined) events.push({
          sessionId: child.sessionId, branchId: child.branchId, type: "MessageAppended", producer: "supervisor", idempotencyKey: `recursive-model-input:${handleId}`,
          payload: { messageId: `input-${handleId}`, role: "system", content: `Exact ordered recursive input set ${plan.inputSetId}: ${JSON.stringify(plan.selectedInput)}. Only these chunks are authorized for this call.` },
        });
      }
      return events;
    });
    const committed: RecursiveModelHandle[] = [];
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!; const plan = plans[index]!;
      const handle = await this.#load(`model-${child.taskId}`);
      const expectedModel = plan.normalized.model ?? parent.model;
      if (handle.parentSessionId !== parentSessionId || handle.parentBranchId !== parentBranchId || handle.childSessionId !== child.sessionId ||
          handle.childBranchId !== child.branchId || handle.inputSetId !== (plan.inputSetId ?? null) || !Bun.deepEquals(handle.model, expectedModel)) {
        throw new ValidationError("Recursive model idempotency key was reused with a different request");
      }
      committed.push(handle);
    }
    for (let index = 0; index < committed.length; index++) {
      if (plans[index]!.normalized.run !== false && !["completed", "failed", "cancelled"].includes(committed[index]!.status)) this.#launch(committed[index]!);
    }
    return committed;
  }

  get(handleId: string): Promise<RecursiveModelHandle> { return this.#load(handleId); }

  async cancel(handleId: string, reason = "Recursive model cancelled"): Promise<RecursiveModelHandle> {
    const handle = await this.#load(handleId); if (["completed", "failed", "cancelled"].includes(handle.status)) return handle;
    const state = projectEvents(await this.storage.loadEvents(handle.childSessionId, { branchId: handle.childBranchId }));
    for (const effect of Object.values(state.effects)) if (["requested", "started"].includes(effect.status)) this.outbox.cancel(effect.id);
    await this.agents.cancel(handle.taskId, reason);
    const current = await this.#load(handleId);
    if (!["completed", "failed", "cancelled"].includes(current.status)) await this.storage.appendEvents([{ sessionId: handle.parentSessionId, branchId: handle.parentBranchId, type: "RecursiveModelStatusChanged", producer: "client", idempotencyKey: `recursive-model-cancelled:${handleId}`, payload: { handleId, status: "cancelled", error: reason } }]);
    return this.#load(handleId);
  }

  /** Resumes/finalizes committed recursive handles without creating a second call. */
  async recoverIncomplete(): Promise<number> {
    const handles = await this.#recursive.listRecursiveModels(["pending", "running"]); let recovered = 0;
    for (const handle of handles) {
      const task = await this.#recursive.getTask(handle.taskId);
      if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled")) {
        const status: "completed" | "failed" | "cancelled" = task.status;
        await this.storage.appendEvents([{
          sessionId: handle.parentSessionId,
          branchId: handle.parentBranchId,
          type: "RecursiveModelStatusChanged",
          producer: "recovery",
          idempotencyKey: `recursive-model-${status}:${handle.handleId}`,
          payload: {
            handleId: handle.handleId,
            status,
            ...(task.error === undefined && task.reason === undefined ? {} : { error: task.error ?? task.reason }),
          },
        }]);
        recovered++;
        continue;
      }
      const child = projectEvents(await this.storage.loadEvents(handle.childSessionId, { branchId: handle.childBranchId }));
      const latest = Object.values(child.modelCalls).at(-1);
      if (handle.status === "running" && latest && ["succeeded", "failed", "cancelled", "unknown"].includes(latest.status)) {
        if (latest.status === "succeeded") {
          const response = child.messages.find((message) => message.id === latest.responseMessageId);
          await this.#finish(handle, { outcome: "succeeded", ...(response === undefined ? {} : { message: response.content }) });
        } else if (latest.status === "failed" || latest.status === "cancelled" || latest.status === "unknown") {
          await this.#finish(handle, { outcome: latest.status, ...(latest.error === undefined ? {} : { error: latest.error }) });
        }
      } else {
        this.#launch(handle, handle.status === "running", handle.status === "pending" ? 10 : 0);
      }
      recovered++;
    }
    return recovered;
  }

  #launch(handle: RecursiveModelHandle, alreadyRunning = false, delayMs = 0): void {
    if (this.#runningHandles.has(handle.handleId)) return;
    this.#runningHandles.add(handle.handleId);
    let running!: Promise<void>;
    running = (async () => {
      if (delayMs > 0) await Bun.sleep(delayMs);
      const current = await this.#recursive.getRecursiveModel(handle.handleId);
      if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return;
      await this.#run(current, alreadyRunning && current.status === "running");
    })().catch(() => { /* #run commits durable failure when storage is available */ }).finally(() => {
      this.#runningHandles.delete(handle.handleId); this.#runs.delete(running);
    });
    this.#runs.add(running);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#runs]);
  }

  async #run(handle: RecursiveModelHandle, alreadyRunning = false): Promise<void> {
    try {
      if (!alreadyRunning) await this.storage.appendEvents([{
        sessionId: handle.parentSessionId, branchId: handle.parentBranchId, type: "RecursiveModelStatusChanged", producer: "supervisor", idempotencyKey: `recursive-model-running:${handle.handleId}`, payload: { handleId: handle.handleId, status: "running" },
      }, {
        sessionId: handle.parentSessionId, branchId: handle.parentBranchId, type: "TaskStatusChanged", producer: "supervisor", idempotencyKey: `recursive-model-task-running:${handle.handleId}`, payload: { taskId: handle.taskId, status: "running" },
      }]);
      const current = await this.#recursive.getRecursiveModel(handle.handleId);
      const task = await this.#recursive.getTask(handle.taskId);
      if (!current || !task || ["completed", "failed", "cancelled"].includes(current.status) || ["completed", "failed", "cancelled"].includes(task.status)) return;
      await this.#finish(handle, await this.modelLoop.turn(handle.childSessionId, handle.childBranchId));
    } catch (error) {
      const current = await this.#recursive.getRecursiveModel(handle.handleId);
      if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return;
      const message = error instanceof Error ? error.message : String(error);
      try { await this.agents.failTask(handle.taskId, { error: message }); } catch { /* a concurrent cancellation owns the terminal task */ }
      const after = await this.#recursive.getRecursiveModel(handle.handleId);
      if (after && !["completed", "failed", "cancelled"].includes(after.status)) await this.storage.appendEvents([{ sessionId: handle.parentSessionId, branchId: handle.parentBranchId, type: "RecursiveModelStatusChanged", producer: "supervisor", idempotencyKey: `recursive-model-failed:${handle.handleId}`, payload: { handleId: handle.handleId, status: "failed", error: message } }]);
    }
  }

  async #finish(handle: RecursiveModelHandle, result: { outcome: "succeeded" | "failed" | "cancelled" | "unknown"; message?: string; error?: string }): Promise<void> {
    const current = await this.#load(handle.handleId); if (["completed", "failed", "cancelled"].includes(current.status)) return;
    if (result.outcome === "succeeded") {
      const childState = projectEvents(await this.storage.loadEvents(handle.childSessionId, { branchId: handle.childBranchId }));
      const response = [...childState.messages].reverse().find((message) => message.role === "assistant");
      await this.agents.completeTask(handle.taskId, { result: { message: result.message ?? response?.content ?? "", ...(response ? { messageId: response.id } : {}) } });
      await this.storage.appendEvents([{ sessionId: handle.parentSessionId, branchId: handle.parentBranchId, type: "RecursiveModelStatusChanged", producer: "supervisor", idempotencyKey: `recursive-model-completed:${handle.handleId}`, payload: { handleId: handle.handleId, status: "completed", ...(response ? { resultMessageId: response.id } : {}) } }]);
    } else {
      const error = result.error ?? `Model ${result.outcome}`;
      if (result.outcome === "cancelled") await this.agents.cancel(handle.taskId, error); else await this.agents.failTask(handle.taskId, { error });
      const after = await this.#load(handle.handleId); if (["completed", "failed", "cancelled"].includes(after.status)) return;
      await this.storage.appendEvents([{ sessionId: handle.parentSessionId, branchId: handle.parentBranchId, type: "RecursiveModelStatusChanged", producer: "supervisor", idempotencyKey: `recursive-model-${result.outcome === "cancelled" ? "cancelled" : "failed"}:${handle.handleId}`, payload: { handleId: handle.handleId, status: result.outcome === "cancelled" ? "cancelled" : "failed", error } }]);
    }
  }

  async #load(id: string): Promise<RecursiveModelHandle> { const result = await this.#recursive.getRecursiveModel(id); if (!result) throw new NotFoundError("recursive model", id); return result; }
}

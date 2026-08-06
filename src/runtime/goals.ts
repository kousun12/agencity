import { NotFoundError, ValidationError, newId, projectEvents, type JsonValue } from "../domain/index.ts";
import { requireRecursiveStorage, type AgentStorage, type GoalGateRecord, type GoalRecord } from "../storage/index.ts";
import type { ModelLoop } from "./model-loop.ts";
import type { OutboxRunner } from "./outbox.ts";

export interface CompletionGateInput { readonly name: string; readonly executor: string; readonly operation: string; readonly input: JsonValue; readonly idempotent?: boolean; readonly required?: boolean; }
export interface CreateGoalInput { readonly description?: string; readonly goal?: string; readonly completionCriteria?: string; readonly maxTurns?: number; readonly gates?: readonly CompletionGateInput[]; readonly completionGates?: readonly CompletionGateInput[]; }
export interface GoalHandle extends GoalRecord { readonly gates: readonly GoalGateRecord[]; }
export interface RunContinuationInput { readonly maxTurns?: number; }

export class GoalService {
  readonly #recursive;
  constructor(readonly storage: AgentStorage, readonly outbox: OutboxRunner, readonly modelLoop: ModelLoop) { this.#recursive = requireRecursiveStorage(storage); }

  async create(sessionId: string, branchId: string, rawInput: CreateGoalInput | string): Promise<GoalHandle> {
    const input: CreateGoalInput = typeof rawInput === "string" ? { description: rawInput } : rawInput;
    const description = input.description ?? input.goal;
    if (!description?.trim()) throw new ValidationError("Goal description cannot be empty");
    if (!(await this.#recursive.getSession(sessionId))) throw new NotFoundError("session", sessionId);
    const goalId = newId(); const gates = input.gates ?? input.completionGates ?? [];
    await this.storage.appendEvents([{
      sessionId, branchId, type: "GoalCreated", producer: "client", idempotencyKey: `goal:${goalId}`,
      payload: { goalId, description, ...(input.completionCriteria === undefined ? {} : { completionCriteria: input.completionCriteria }), ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }) },
    }, ...gates.map((gate) => ({
      sessionId, branchId, type: "GoalGateAdded" as const, producer: "client", idempotencyKey: `goal-gate:${goalId}:${newId()}`,
      payload: { goalId, gateId: newId(), name: gate.name, executor: gate.executor, operation: gate.operation, input: gate.input, idempotent: gate.idempotent ?? false, required: gate.required ?? true },
    }))]);
    return this.#load(goalId);
  }

  async requestCompletion(sessionId: string, branchId: string, goalId: string): Promise<GoalHandle> {
    let goal = await this.#recursive.getGoal(goalId); if (!goal) throw new NotFoundError("goal", goalId);
    if (goal.sessionId !== sessionId || goal.branchId !== branchId) throw new ValidationError("Goal does not belong to the supplied session branch");
    if (["completed", "failed", "cancelled"].includes(goal.status)) return this.#load(goalId);
    if (goal.status === "active") {
      const requestId = newId();
      const pin = await this.#workspacePin(sessionId, branchId);
      await this.storage.appendEvents([{ sessionId, branchId, type: "GoalCompletionRequested", producer: "client", idempotencyKey: `goal-completion:${goalId}:${requestId}`, payload: { goalId, requestId, workspaceId: pin.workspaceId, workspaceCursor: pin.cursor } }]);
      goal = (await this.#recursive.getGoal(goalId))!;
    }
    if (goal.status === "blocked") throw new ValidationError("Blocked goal must be continued before completion is requested again");
    const requestId = goal.completionRequestId;
    if (!requestId) throw new ValidationError("Goal completion request is missing its durable ID");
    if (!goal.completionPinRecorded || !goal.completionWorkspaceId) throw new ValidationError("Goal completion request is missing its durable workspace pin");
    const gates = await this.#recursive.listGoalGates(goalId);
    for (const gate of gates) {
      // Every completion request re-evaluates every gate. A result from an older
      // workspace version is evidence, not authorization for the current one.
      const key = `goal-gate-effect:${goalId}:${gate.gateId}:${requestId}`;
      const effectId = await this.outbox.request({ sessionId, branchId, executor: gate.executor, operation: gate.operation, input: gate.input, idempotencyKey: key, idempotent: gate.idempotent });
      await this.storage.appendEvents([{ sessionId, branchId, type: "GoalGateStatusChanged", producer: "supervisor", idempotencyKey: `goal-gate-running:${gate.gateId}:${requestId}`, payload: { goalId, gateId: gate.gateId, status: "running", effectId } }]);
      const execution = await this.outbox.run(effectId);
      const currentPin = await this.#workspacePin(sessionId, branchId);
      const staleError = this.#stalePinError(goal, currentPin);
      const status = staleError ? "failed" as const : execution.outcome === "succeeded" ? "passed" as const : execution.outcome === "cancelled" ? "cancelled" as const : execution.outcome === "unknown" ? "unknown" as const : "failed" as const;
      const error = staleError ?? execution.error;
      await this.storage.appendEvents([{ sessionId, branchId, type: "GoalGateStatusChanged", producer: "supervisor", idempotencyKey: `goal-gate-terminal:${gate.gateId}:${requestId}`, payload: { goalId, gateId: gate.gateId, status, effectId, ...(execution.output === undefined ? {} : { output: execution.output }), ...(error === undefined ? {} : { error }) } }]);
    }
    const evaluated = await this.#recursive.listGoalGates(goalId);
    const failed = evaluated.filter((gate) => gate.required && gate.status !== "passed");
    const stale = failed.find((gate) => /stale|cursor|workspace|version/i.test(gate.error ?? ""));
    await this.storage.appendEvents([{
      sessionId, branchId, type: "GoalStatusChanged", producer: "supervisor", idempotencyKey: `goal-completion-outcome:${goalId}:${requestId}`,
      payload: failed.length ? { goalId, status: "blocked", reason: stale?.error ?? `Required completion gates did not pass: ${failed.map((gate) => gate.name).join(", ")}` } : { goalId, status: "completed" },
    }]);
    return this.#load(goalId);
  }

  async runContinuation(sessionId: string, branchId: string, goalId: string, options: RunContinuationInput | number = {}): Promise<GoalHandle> {
    const goal = await this.#recursive.getGoal(goalId); if (!goal) throw new NotFoundError("goal", goalId);
    if (goal.sessionId !== sessionId || goal.branchId !== branchId) throw new ValidationError("Goal does not belong to the supplied session branch");
    const requested = typeof options === "number" ? options : options.maxTurns;
    const maxTurns = requested ?? goal.maxTurns ?? 1;
    if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new ValidationError("Continuation maxTurns must be positive");
    for (let index = 0; index < maxTurns; index++) {
      const current = await this.#recursive.getGoal(goalId);
      if (!current || ["completed", "failed", "cancelled", "completion_requested"].includes(current.status)) break;
      if (current.status === "blocked") {
        const resumeId = newId();
        await this.storage.appendEvents([{ sessionId, branchId, type: "GoalStatusChanged", producer: "client", idempotencyKey: `goal-resume:${goalId}:${resumeId}`, payload: { goalId, status: "active", reason: "Continuation requested after a failed gate" } }]);
      }
      const turn = await this.modelLoop.turn(sessionId, branchId);
      if (turn.outcome !== "succeeded") break;
    }
    return this.#load(goalId);
  }

  /** Reconciles gate effects and resumes active autonomous goals at startup. */
  async recoverIncomplete(): Promise<number> {
    let recovered = 0;
    const reconciledGoals = new Set<string>();
    for (const branch of await this.storage.listBranches()) {
      const state = await this.storage.loadEvents(branch.sessionId, { branchId: branch.branchId });
      if (!state.length) continue;
      const projected = projectEvents(state);
      for (const candidate of Object.values(projected.goals)) {
        if (reconciledGoals.has(candidate.id)) continue;
        reconciledGoals.add(candidate.id);
        const goal = await this.#recursive.getGoal(candidate.id); if (!goal) continue;
        if (goal.status === "completion_requested") {
          let gates = await this.#recursive.listGoalGates(goal.goalId);
          const currentPin = await this.#workspacePin(goal.sessionId, goal.branchId);
          const staleError = this.#stalePinError(goal, currentPin);
          for (const gate of gates.filter((item) => item.status === "running")) {
            const effect = gate.effectId ? await this.storage.getOutbox(gate.effectId) : null;
            const status = effect?.status === "succeeded" ? (staleError ? "failed" as const : "passed" as const) : effect?.status === "cancelled" ? "cancelled" as const : effect?.status === "failed" ? "failed" as const : "unknown" as const;
            const error = effect?.status === "succeeded" ? staleError : status === "unknown" ? "Gate outcome is unknown because executor ownership was lost before a durable result" : undefined;
            await this.storage.appendEvents([{ sessionId: goal.sessionId, branchId: goal.branchId, type: "GoalGateStatusChanged", producer: "recovery", idempotencyKey: `goal-gate-recovery:${goal.goalId}:${gate.gateId}:${goal.completionRequestId}`, payload: { goalId: goal.goalId, gateId: gate.gateId, status, ...(gate.effectId === undefined ? {} : { effectId: gate.effectId }), ...(error === undefined ? {} : { error }) } }]);
          }
          gates = await this.#recursive.listGoalGates(goal.goalId);
          const failed = gates.filter((gate) => gate.required && ["failed", "cancelled", "unknown"].includes(gate.status));
          if (staleError || failed.length) {
            await this.storage.appendEvents([{ sessionId: goal.sessionId, branchId: goal.branchId, type: "GoalStatusChanged", producer: "recovery", idempotencyKey: `goal-gate-recovery-blocked:${goal.goalId}:${goal.completionRequestId}`, payload: { goalId: goal.goalId, status: "blocked", reason: staleError ?? `Required completion gate outcome is ${failed[0]!.status}: ${failed[0]!.error ?? failed[0]!.name}` } }]);
          } else if (gates.every((gate) => !gate.required || gate.status === "passed")) {
            await this.storage.appendEvents([{ sessionId: goal.sessionId, branchId: goal.branchId, type: "GoalStatusChanged", producer: "recovery", idempotencyKey: `goal-gate-recovery-completed:${goal.goalId}:${goal.completionRequestId}`, payload: { goalId: goal.goalId, status: "completed" } }]);
          } else {
            await this.requestCompletion(goal.sessionId, goal.branchId, goal.goalId);
          }
          recovered++;
        }
      }
    }
    // Re-read after gate reconciliation. Running continuations are awaited so a
    // caller never observes startup recovery racing storage shutdown.
    const resumedGoals = new Set<string>();
    for (const branch of await this.storage.listBranches()) {
      const events = await this.storage.loadEvents(branch.sessionId, { branchId: branch.branchId });
      if (!events.length) continue;
      const projected = projectEvents(events);
      for (const candidate of Object.values(projected.goals)) {
        if (resumedGoals.has(candidate.id)) continue;
        resumedGoals.add(candidate.id);
        const goal = await this.#recursive.getGoal(candidate.id);
        const ownedByAgentRun = Object.values(projected.agentRuns).some((run) => run.goalId === candidate.id && !["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status));
        if (goal?.status === "active" && !ownedByAgentRun) { await this.runContinuation(goal.sessionId, goal.branchId, goal.goalId, { maxTurns: goal.maxTurns ?? 1 }); recovered++; }
      }
    }
    return recovered;
  }

  async #workspacePin(sessionId: string, branchId: string): Promise<{ workspaceId: string; cursor: string | null }> {
    const ignored = new Set(["GoalCompletionRequested", "GoalGateStatusChanged", "GoalStatusChanged", "EffectRequested", "EffectAttemptStarted", "EffectOutcomeRecorded", "RecoveryPerformed", "TaskUsageAttributed"]);
    const events = await this.storage.loadEvents(sessionId, { branchId });
    if (!events.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const state = projectEvents(events);
    return { workspaceId: state.workspaceId, cursor: [...events].reverse().find((event) => !ignored.has(event.type))?.cursor ?? null };
  }

  #stalePinError(goal: GoalRecord, current: { workspaceId: string; cursor: string | null }): string | undefined {
    if (!goal.completionPinRecorded || !goal.completionWorkspaceId) return "Gate result is stale: completion request has no durable workspace pin";
    if (goal.completionWorkspaceId !== current.workspaceId) return `Gate result is stale: workspace changed from ${goal.completionWorkspaceId} to ${current.workspaceId}`;
    if (goal.completionWorkspaceCursor !== current.cursor) return `Gate result is stale: workspace cursor changed from ${goal.completionWorkspaceCursor ?? "empty"} to ${current.cursor ?? "empty"}`;
    return undefined;
  }

  async #load(goalId: string): Promise<GoalHandle> { const goal = await this.#recursive.getGoal(goalId); if (!goal) throw new NotFoundError("goal", goalId); return { ...goal, gates: await this.#recursive.listGoalGates(goalId) }; }
}

import {
  NotFoundError,
  ValidationError,
  gateDefinitionHash,
  newId,
  projectEvents,
  workspaceMaterialPin,
  type AgentEvent,
  type JsonValue,
  type NewAgentEvent,
} from "../domain/index.ts";
import {
  requireRecursiveStorage,
  type AgentStorage,
  type GoalGateEvaluationRecord,
  type GoalGateRecord,
  type GoalRecord,
} from "../storage/index.ts";
import type { OutboxRunner } from "./outbox.ts";
import { ProjectionService, type CurrentBranchProjection } from "./projection.ts";

export interface CompletionGateInput {
  readonly name: string;
  readonly executor: string;
  readonly operation: string;
  readonly input: JsonValue;
  readonly idempotent?: boolean;
  readonly required?: boolean;
}
export interface CreateGoalInput {
  readonly description?: string;
  readonly goal?: string;
  readonly completionCriteria?: string;
  readonly maxTurns?: number;
  readonly gates?: readonly CompletionGateInput[];
  readonly completionGates?: readonly CompletionGateInput[];
}
export interface GoalGateHandle extends GoalGateRecord {
  readonly evaluations: readonly GoalGateEvaluationRecord[];
  readonly currentStale: boolean;
  readonly currentStaleReason?: string;
}
export interface GoalHandle extends GoalRecord { readonly gates: readonly GoalGateHandle[]; }
export interface RunContinuationInput { readonly maxTurns?: number; }

interface MaterialPin {
  readonly workspaceId: string;
  readonly cursor: string | null;
  readonly version: string;
  readonly eventIds: string[];
}

/** User-authoritative durable goals and completion-gate evaluation. */
export class GoalService {
  readonly #recursive;
  constructor(readonly storage: AgentStorage, readonly outbox: OutboxRunner) {
    this.#recursive = requireRecursiveStorage(storage);
  }

  async create(sessionId: string, branchId: string, rawInput: CreateGoalInput | string): Promise<GoalHandle> {
    const goalId = newId();
    const events = await this.prepareCreateEvents(sessionId, branchId, rawInput, goalId, "client");
    await this.storage.appendEvents(events);
    return this.#load(goalId);
  }

  /** Builds stable goal events so a product run can commit goal+run atomically. */
  async prepareCreateEvents(
    sessionId: string,
    branchId: string,
    rawInput: CreateGoalInput | string,
    goalId: string,
    producer: string = "client",
  ): Promise<NewAgentEvent[]> {
    const input: CreateGoalInput = typeof rawInput === "string" ? { description: rawInput } : rawInput;
    const description = input.description ?? input.goal;
    if (!description?.trim()) throw new ValidationError("Goal description cannot be empty");
    if (input.maxTurns !== undefined && (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1)) {
      throw new ValidationError("Goal maxTurns must be a positive integer");
    }
    if (!(await this.#recursive.getSession(sessionId))) throw new NotFoundError("session", sessionId);
    const gates = input.gates ?? input.completionGates ?? [];
    return [{
      sessionId, branchId, type: "GoalCreated", producer, idempotencyKey: `goal:${goalId}`,
      payload: {
        goalId, description: description.trim(), owner: "user",
        ...(input.completionCriteria === undefined ? {} : { completionCriteria: input.completionCriteria }),
        ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
      },
    }, ...gates.map((gate, index) => {
      if (!gate.name?.trim() || !gate.executor?.trim() || !gate.operation?.trim()) {
        throw new ValidationError("Completion gates require name, executor, and operation");
      }
      if (gate.executor === "model") {
        throw new ValidationError("Completion gates cannot invoke the model executor directly; use a typed recursive model or agent task");
      }
      const gateId = `${goalId}-gate-${index + 1}`;
      return {
        sessionId, branchId, type: "GoalGateAdded" as const, producer,
        idempotencyKey: `goal-gate:${goalId}:${index + 1}`,
        payload: {
          goalId, gateId, name: gate.name.trim(), executor: gate.executor, operation: gate.operation,
          input: gate.input, idempotent: gate.idempotent ?? false, required: gate.required ?? true,
        },
      };
    })];
  }

  async current(sessionId: string, branchId: string): Promise<GoalHandle | null> {
    const state = projectEvents(await this.storage.loadEvents(sessionId, { branchId }));
    const goal = Object.values(state.goals).find((item) => !["completed", "failed", "cancelled"].includes(item.status));
    return goal ? this.#load(goal.id) : null;
  }

  async list(sessionId: string, branchId: string): Promise<GoalHandle[]> {
    const state = projectEvents(await this.storage.loadEvents(sessionId, { branchId }));
    return Promise.all(Object.values(state.goals).map((goal) => this.#load(goal.id)));
  }

  async get(sessionId: string, branchId: string, goalId: string): Promise<GoalHandle> {
    const goal = await this.#load(goalId);
    this.#assertScope(goal, sessionId, branchId);
    return goal;
  }

  async requestCompletion(sessionId: string, branchId: string, goalId: string): Promise<GoalHandle> {
    let goal = await this.#recursive.getGoal(goalId);
    if (!goal) throw new NotFoundError("goal", goalId);
    this.#assertScope(goal, sessionId, branchId);
    if (["completed", "failed", "cancelled"].includes(goal.status)) return this.#load(goalId);
    if (goal.status === "paused") throw new ValidationError("Paused goal must be resumed before completion is requested");
    if (goal.status === "blocked") return this.#load(goalId);

    if (goal.status === "active") {
      const requestId = newId();
      const pin = await this.#workspacePin(sessionId, branchId);
      await this.storage.appendEvents([{
        sessionId, branchId, type: "GoalCompletionRequested", producer: "supervisor",
        idempotencyKey: `goal-completion:${goalId}:${requestId}`,
        payload: {
          goalId, requestId, workspaceId: pin.workspaceId, workspaceCursor: pin.cursor,
          materialVersion: pin.version, materialEventIds: pin.eventIds,
        },
      }]);
      goal = (await this.#recursive.getGoal(goalId))!;
    }

    const requestId = goal.completionRequestId;
    if (!requestId) throw new ValidationError("Goal completion request is missing its durable ID");
    const requestPin = await this.#requestPin(goal);
    let gates = await this.#recursive.listGoalGates(goalId);
    for (const gate of gates) {
      const evaluations = await this.#recursive.listGoalGateEvaluations(goalId, gate.gateId);
      if (evaluations.some((evaluation) => evaluation.requestId === requestId)) continue;
      const definitionHash = gateDefinitionHash(gate);
      const cached = [...evaluations].reverse().find((evaluation) =>
        evaluation.definitionHash === definitionHash && evaluation.materialVersion === requestPin.version);
      const evaluationId = `goal-gate-evaluation:${goalId}:${gate.gateId}:${requestId}`;
      if (cached) {
        await this.storage.appendEvents([{
          sessionId, branchId, type: "GoalGateEvaluationRecorded", producer: "supervisor",
          idempotencyKey: `goal-gate-evaluation:${evaluationId}`,
          payload: {
            evaluationId, goalId, gateId: gate.gateId, requestId, definitionHash,
            materialVersion: requestPin.version, materialEventIds: requestPin.eventIds,
            status: cached.status, cachedFromEvaluationId: cached.evaluationId,
            ...(cached.effectId === undefined ? {} : { effectId: cached.effectId }),
            ...(cached.output === undefined ? {} : { output: cached.output }),
            ...(cached.error === undefined ? {} : { error: cached.error }),
          },
        }]);
        continue;
      }

      let effectId = gate.status === "running" ? gate.effectId : undefined;
      if (!effectId) {
        const key = `goal-gate-effect:${goalId}:${gate.gateId}:${requestId}`;
        effectId = await this.outbox.request({
          sessionId, branchId, executor: gate.executor, operation: gate.operation, input: gate.input,
          origin: { kind: "goal-gate", goalId, gateId: gate.gateId, requestId },
          idempotencyKey: key, idempotent: gate.idempotent,
        });
        await this.storage.appendEvents([{
          sessionId, branchId, type: "GoalGateStatusChanged", producer: "supervisor",
          idempotencyKey: `goal-gate-running:${gate.gateId}:${requestId}`,
          payload: { goalId, gateId: gate.gateId, status: "running", effectId },
        }]);
      }
      const execution = await this.outbox.run(effectId);
      const currentPin = await this.#workspacePin(sessionId, branchId);
      const staleError = currentPin.version === requestPin.version
        ? undefined
        : `Gate result is stale: workspace material changed from ${requestPin.version} to ${currentPin.version}`;
      const status = staleError ? "failed" as const
        : execution.outcome === "succeeded" ? "passed" as const
        : execution.outcome === "cancelled" ? "cancelled" as const
        : execution.outcome === "unknown" ? "unknown" as const
        : "failed" as const;
      const error = staleError ?? (execution.outcome === "unknown" ? `Unknown gate outcome: ${execution.error ?? "executor ownership was lost"}` : execution.error);
      await this.storage.appendEvents([{
        sessionId, branchId, type: "GoalGateEvaluationRecorded", producer: "supervisor",
        idempotencyKey: `goal-gate-evaluation:${evaluationId}`,
        payload: {
          evaluationId, goalId, gateId: gate.gateId, requestId, definitionHash,
          materialVersion: requestPin.version, materialEventIds: requestPin.eventIds, status, effectId,
          ...(execution.output === undefined ? {} : { output: execution.output }),
          ...(error === undefined ? {} : { error }),
        },
      }]);
    }

    gates = await this.#recursive.listGoalGates(goalId);
    const failed = gates.filter((gate) => gate.required && gate.status !== "passed");
    const unknown = failed.find((gate) => gate.status === "unknown");
    const currentPin = await this.#workspacePin(sessionId, branchId);
    const materialMoved = currentPin.version !== requestPin.version;
    const cachedIds = new Set((await this.#recursive.listGoalGateEvaluations(goalId))
      .filter((evaluation) => evaluation.requestId === requestId && evaluation.cachedFromEvaluationId)
      .map((evaluation) => evaluation.gateId));
    const reason = unknown
      ? `Required completion gate outcome is unknown: ${unknown.error ?? unknown.name}`
      : materialMoved
        ? `Required completion evidence is stale because workspace material changed from ${requestPin.version} to ${currentPin.version}`
        : failed.length
          ? `Required completion gates did not pass${failed.some((gate) => cachedIds.has(gate.gateId)) ? " on unchanged workspace material (cached)" : ""}: ${failed.map((gate) => gate.name).join(", ")}`
          : undefined;
    await this.storage.appendEvents([{
      sessionId, branchId, type: "GoalStatusChanged", producer: "supervisor",
      idempotencyKey: `goal-completion-outcome:${goalId}:${requestId}`,
      payload: failed.length || materialMoved
        ? { goalId, status: "blocked", reason: reason! }
        : { goalId, status: "completed" },
    }]);
    return this.#load(goalId);
  }

  /** Legacy name retained as a user-authoritative unblock; it never starts a second model loop. */
  async runContinuation(sessionId: string, branchId: string, goalId: string, _options: RunContinuationInput | number = {}): Promise<GoalHandle> {
    const goal = await this.#recursive.getGoal(goalId);
    if (!goal) throw new NotFoundError("goal", goalId);
    this.#assertScope(goal, sessionId, branchId);
    if (goal.status === "blocked") {
      await this.storage.appendEvents([{
        sessionId, branchId, type: "GoalStatusChanged", producer: "client",
        idempotencyKey: `goal-resume:${goalId}:${newId()}`,
        payload: { goalId, status: "active", reason: "User continued goal after completion gates did not pass" },
      }]);
    }
    return this.#load(goalId);
  }

  async pause(sessionId: string, branchId: string, goalId: string, reason?: string): Promise<GoalHandle> {
    const goal = await this.get(sessionId, branchId, goalId);
    if (goal.status === "paused") return goal;
    if (!["active", "blocked"].includes(goal.status)) throw new ValidationError(`Cannot pause a ${goal.status} goal`);
    await this.storage.appendEvents([{ sessionId, branchId, type: "GoalStatusChanged", producer: "client", idempotencyKey: `goal-pause:${goalId}:${newId()}`, payload: { goalId, status: "paused", ...(reason === undefined ? {} : { reason }) } }]);
    return this.#load(goalId);
  }

  async resume(sessionId: string, branchId: string, goalId: string, reason?: string): Promise<GoalHandle> {
    const goal = await this.get(sessionId, branchId, goalId);
    if (goal.status === "active") return goal;
    if (!["paused", "blocked"].includes(goal.status)) throw new ValidationError(`Cannot resume a ${goal.status} goal`);
    await this.storage.appendEvents([{ sessionId, branchId, type: "GoalStatusChanged", producer: "client", idempotencyKey: `goal-resume:${goalId}:${newId()}`, payload: { goalId, status: "active", ...(reason === undefined ? {} : { reason }) } }]);
    return this.#load(goalId);
  }

  async clear(sessionId: string, branchId: string, goalId: string, reason?: string): Promise<GoalHandle> {
    const goal = await this.get(sessionId, branchId, goalId);
    if (goal.status === "cancelled") return goal;
    if (["completed", "failed"].includes(goal.status)) throw new ValidationError(`Cannot clear a ${goal.status} goal`);
    await this.storage.appendEvents([{ sessionId, branchId, type: "GoalStatusChanged", producer: "client", idempotencyKey: `goal-clear:${goalId}`, payload: { goalId, status: "cancelled", reason: reason ?? "User cleared goal" } }]);
    return this.#load(goalId);
  }

  /** Reconciles completion requests only. Active goals are owned by AgentRunService. */
  async recoverIncomplete(
    currentBranches?: readonly CurrentBranchProjection[],
  ): Promise<number> {
    let recovered = 0;
    const seen = new Set<string>();
    const branches = currentBranches ??
      await new ProjectionService(this.storage).currentBranches();
    for (const branch of branches) {
      for (const candidate of Object.values(branch.state.goals)) {
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        const goal = await this.#recursive.getGoal(candidate.id);
        if (goal?.status !== "completion_requested") continue;
        await this.requestCompletion(goal.sessionId, goal.branchId, goal.goalId);
        recovered++;
      }
    }
    return recovered;
  }

  async completionEvaluationEventIds(goalId: string, requestId: string): Promise<string[]> {
    return (await this.#recursive.listGoalGateEvaluations(goalId))
      .filter((evaluation) => evaluation.requestId === requestId)
      .map((evaluation) => evaluation.eventId);
  }

  async #requestPin(goal: GoalRecord): Promise<MaterialPin> {
    if (goal.completionMaterialVersion) {
      return {
        workspaceId: goal.completionWorkspaceId ?? "legacy",
        cursor: goal.completionWorkspaceCursor,
        version: goal.completionMaterialVersion,
        eventIds: [...goal.completionMaterialEventIds],
      };
    }
    // Legacy completion requests retained only a workspace cursor. Translate
    // that historical prefix through the same exhaustive material classifier
    // so later material changes remain stale during recovery.
    if (goal.completionPinRecorded && goal.completionWorkspaceId) {
      const events = await this.storage.loadEvents(goal.sessionId, { branchId: goal.branchId });
      const prefix = goal.completionWorkspaceCursor === null ? [] : events.filter((event) => BigInt(event.cursor) <= BigInt(goal.completionWorkspaceCursor!));
      const pin = workspaceMaterialPin(prefix);
      return { workspaceId: goal.completionWorkspaceId, cursor: goal.completionWorkspaceCursor, version: pin.version, eventIds: pin.eventIds };
    }
    return this.#workspacePin(goal.sessionId, goal.branchId);
  }

  async #workspacePin(sessionId: string, branchId: string): Promise<MaterialPin> {
    const events = await this.storage.loadEvents(sessionId, { branchId });
    if (!events.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const state = projectEvents(events);
    const pin = workspaceMaterialPin(events);
    const cursorById = new Map(events.map((event) => [event.id, event.cursor]));
    const cursor = pin.eventIds.length ? cursorById.get(pin.eventIds.at(-1)!) ?? null : null;
    return { workspaceId: state.workspaceId, cursor, version: pin.version, eventIds: pin.eventIds };
  }

  async #load(goalId: string): Promise<GoalHandle> {
    const goal = await this.#recursive.getGoal(goalId);
    if (!goal) throw new NotFoundError("goal", goalId);
    const currentPin = await this.#workspacePin(goal.sessionId, goal.branchId);
    const gates = await this.#recursive.listGoalGates(goalId);
    const evaluations = await this.#recursive.listGoalGateEvaluations(goalId);
    return {
      ...goal,
      gates: gates.map((gate) => {
        const history = evaluations.filter((evaluation) => evaluation.gateId === gate.gateId);
        const current = history.find((evaluation) => evaluation.evaluationId === gate.currentEvaluationId) ?? history.at(-1);
        const currentStale = current !== undefined && current.materialVersion !== currentPin.version;
        return {
          ...gate, evaluations: history, currentStale,
          ...(currentStale ? { currentStaleReason: `Gate evidence is stale: evaluated ${current!.materialVersion}, current workspace material is ${currentPin.version}` } : {}),
        };
      }),
    };
  }

  #assertScope(goal: Pick<GoalRecord, "sessionId" | "branchId">, sessionId: string, branchId: string): void {
    if (goal.sessionId !== sessionId || goal.branchId !== branchId) throw new ValidationError("Goal does not belong to the supplied session branch");
  }
}

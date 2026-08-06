import { ValidationError, newId, projectEvents, type EffectOutcome } from "../domain/index.ts";
import type { JsonValue } from "../domain/json.ts";
import type { EffectExecutor, ExecutionResult } from "../executors/contract.ts";
import { result } from "../executors/contract.ts";
import type { AgentStorage, OutboxRecord } from "../storage/index.ts";
import { containsBrokeredSecret, scrubJson, scrubText } from "../security/index.ts";

export interface EffectRequest {
  readonly sessionId: string;
  readonly branchId: string;
  readonly executor: string;
  readonly operation: string;
  readonly input: JsonValue;
  readonly idempotencyKey: string;
  readonly idempotent: boolean;
}

export class OutboxRunner {
  readonly #executors = new Map<string, EffectExecutor>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #inflight = new Map<string, Promise<ExecutionResult>>();
  #claimAdmissions = 0;
  #deletionQuiesced = false;
  readonly owner = `runner-${newId()}`;

  constructor(readonly storage: AgentStorage, executors: readonly EffectExecutor[]) {
    for (const executor of executors) this.#executors.set(executor.name, executor);
  }

  async request(request: EffectRequest): Promise<string> {
    if (this.#deletionQuiesced) throw new ValidationError("Outbox is quiesced for physical deletion");
    if (!request.idempotencyKey) throw new ValidationError("Effect requests require an idempotency key");
    if (containsBrokeredSecret(request.input)) throw new ValidationError("Brokered credentials cannot be stored in effect requests");
    // The durable handle is a pure function of the idempotency scope. A retry must
    // propose byte-identical event payload, while changed intent still conflicts.
    const effectId = stableEffectId(request.sessionId, request.idempotencyKey);
    const [event] = await this.storage.appendEvents([{
      sessionId: request.sessionId,
      branchId: request.branchId,
      type: "EffectRequested",
      producer: "supervisor",
      idempotencyKey: request.idempotencyKey,
      payload: {
        effectId,
        executor: request.executor,
        operation: request.operation,
        input: request.input,
        idempotencyKey: request.idempotencyKey,
        idempotent: request.idempotent,
      },
    }]);
    if (!event) throw new Error("Effect request was not committed");
    return (event.payload as { effectId: string }).effectId;
  }

  run(effectId: string): Promise<ExecutionResult> {
    if (this.#deletionQuiesced) throw new ValidationError("Outbox is quiesced for physical deletion");
    const inflight = this.#inflight.get(effectId);
    if (inflight) return inflight;
    // Publish the promise before the first storage await so concurrent callers in
    // this process cannot race each other for SQLite's write claim.
    const promise = this.#claimAndExecute(effectId).finally(() => this.#inflight.delete(effectId));
    this.#inflight.set(effectId, promise);
    return promise;
  }

  async #claimAndExecute(effectId: string): Promise<ExecutionResult> {
    const existing = await this.storage.getOutbox(effectId);
    if (!existing) return result("failed", undefined, "Effect does not exist");
    if (!["pending", "running"].includes(existing.status)) return this.#loadTerminal(existing);
    if (existing.status === "running") return this.#waitForOwner(existing);
    const claimed = await this.storage.claimEffect(effectId, this.owner);
    if (claimed) return this.#execute(claimed);

    // Another local runner may have won the claim between our read and update.
    // That is coordination, not an unknown external outcome: wait for its
    // durable terminal event until the recorded lease expires.
    const current = await this.storage.getOutbox(effectId);
    if (!current) return result("failed", undefined, "Effect does not exist");
    if (!["pending", "running"].includes(current.status)) return this.#loadTerminal(current);
    return current.status === "running"
      ? this.#waitForOwner(current)
      : result("unknown", undefined, "Effect claim could not be established");
  }

  async #waitForOwner(record: OutboxRecord): Promise<ExecutionResult> {
    const parsedExpiry = record.leaseExpiresAt === null ? Number.NaN : Date.parse(record.leaseExpiresAt);
    const deadline = Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 30_000;
    while (Date.now() <= deadline) {
      const current = await this.storage.getOutbox(record.effectId);
      if (!current) return result("failed", undefined, "Effect does not exist");
      if (!["pending", "running"].includes(current.status)) return this.#loadTerminal(current);
      if (current.status === "pending") return this.#claimAndExecute(record.effectId);
      await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    const final = await this.storage.getOutbox(record.effectId);
    if (final && !["pending", "running"].includes(final.status)) return this.#loadTerminal(final);
    return result("unknown", undefined, "Effect owner lease expired before a durable outcome");
  }

  async drain(limit = 100): Promise<number> {
    if (this.#deletionQuiesced) throw new ValidationError("Outbox is quiesced for physical deletion");
    let count = 0;
    while (count < limit) {
      this.#claimAdmissions++;
      let record: OutboxRecord | undefined;
      try { [record] = await this.storage.claimOutbox(this.owner, 1); }
      finally { this.#claimAdmissions--; }
      if (!record) break;
      if (this.#deletionQuiesced) {
        // The claim has attempt=0 and no executor was admitted. Returning it to
        // pending is safe even for a non-idempotent request.
        await this.storage.resetOutbox(record.effectId);
        throw new ValidationError("Outbox was quiesced before the claimed effect started");
      }
      await this.#startExecution(record);
      count++;
    }
    return count;
  }

  /** Stops new effects and fails closed if an effect could still touch physical data. */
  async quiesceForDeletion(): Promise<void> {
    this.#deletionQuiesced = true;
    const running = await this.storage.listOutbox(["running"]);
    if (this.#claimAdmissions || this.#inflight.size || running.length) {
      this.#deletionQuiesced = false;
      throw new ValidationError("Physical deletion refused while outbox effects are running or being admitted", {
        claimAdmissions: this.#claimAdmissions,
        inFlightEffectIds: [...this.#inflight.keys()].sort(),
        runningEffectIds: running.map((row) => row.effectId).sort(),
      });
    }
  }

  cancel(effectId: string): boolean {
    const controller = this.#controllers.get(effectId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  #startExecution(record: OutboxRecord): Promise<ExecutionResult> {
    if (this.#deletionQuiesced) return Promise.reject(new ValidationError("Outbox is quiesced for physical deletion"));
    const existing = this.#inflight.get(record.effectId);
    if (existing) return existing;
    const promise = this.#execute(record).finally(() => this.#inflight.delete(record.effectId));
    this.#inflight.set(record.effectId, promise);
    return promise;
  }

  async #execute(record: OutboxRecord): Promise<ExecutionResult> {
    const attempt = record.attempt + 1;
    await this.storage.appendEvents([{
      sessionId: record.sessionId,
      branchId: record.branchId,
      type: "EffectAttemptStarted",
      producer: "executor",
      idempotencyKey: `effect-attempt:${record.effectId}:${attempt}`,
      payload: { effectId: record.effectId, attempt },
    }]);
    const executor = this.#executors.get(record.executor);
    const controller = new AbortController();
    this.#controllers.set(record.effectId, controller);
    let execution: ExecutionResult;
    try {
      execution = executor
        ? await executor.execute({ ...record, attempt }, { signal: controller.signal })
        : result("failed", undefined, `Executor unavailable: ${record.executor}`);
    } catch (error) {
      execution = result(
        controller.signal.aborted ? "cancelled" : "failed",
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.#controllers.delete(record.effectId);
    }
    const safeExecution = result(
      execution.outcome,
      execution.output === undefined ? undefined : scrubJson(execution.output),
      execution.error === undefined ? undefined : scrubText(execution.error),
    );
    await this.storage.appendEvents([{
      sessionId: record.sessionId,
      branchId: record.branchId,
      type: "EffectOutcomeRecorded",
      producer: "executor",
      idempotencyKey: `effect-outcome:${record.effectId}:${attempt}`,
      payload: {
        effectId: record.effectId,
        attempt,
        outcome: safeExecution.outcome,
        ...(safeExecution.output === undefined ? {} : { output: safeExecution.output }),
        ...(safeExecution.error === undefined ? {} : { error: safeExecution.error }),
        observedAt: new Date().toISOString(),
      },
    }]);
    return safeExecution;
  }

  async #loadTerminal(record: OutboxRecord): Promise<ExecutionResult> {
    const events = await this.storage.loadEvents(record.sessionId, { branchId: record.branchId });
    const outcome = [...events].reverse().find(
      (event) => event.type === "EffectOutcomeRecorded" &&
        (event.payload as { effectId: string }).effectId === record.effectId,
    );
    if (!outcome) return result(record.status as EffectOutcome, undefined, "Terminal outbox row has no outcome event");
    const payload = outcome.payload as { outcome: EffectOutcome; output?: JsonValue; error?: string };
    return result(payload.outcome, payload.output, payload.error);
  }

  /**
   * Reconciles effects whose owner disappeared. Idempotent effects become pending
   * with their attempt counter retained; non-idempotent effects become unknown.
   */
  async recover(): Promise<{ abandonedCellIds: string[]; unknownEffectIds: string[]; retriedEffectIds: string[] }> {
    const unknownEffectIds: string[] = [];
    const retriedEffectIds: string[] = [];
    for (const record of await this.storage.listOutbox(["pending", "running"])) {
      // A pending first attempt has never been claimed locally and remains safe
      // to drain. A pending non-idempotent row with a retained attempt is an
      // anomalous/ambiguous recovery state and must never be replayed.
      if (record.status === "pending" && (record.idempotent || record.attempt === 0)) continue;
      if (record.idempotent) {
        await this.storage.resetOutbox(record.effectId);
        retriedEffectIds.push(record.effectId);
      } else {
        const attempt = Math.max(1, record.attempt);
        await this.storage.appendEvents([{
          sessionId: record.sessionId,
          branchId: record.branchId,
          type: "EffectOutcomeRecorded",
          producer: "recovery",
          idempotencyKey: `effect-recovery-unknown:${record.effectId}`,
          payload: {
            effectId: record.effectId,
            attempt,
            outcome: "unknown",
            error: "Executor ownership was lost before a durable outcome",
            observedAt: new Date().toISOString(),
          },
        }]);
        unknownEffectIds.push(record.effectId);
      }
    }

    const unknownSet = new Set(unknownEffectIds);
    const retrySet = new Set(retriedEffectIds);
    const abandonedCellIds: string[] = [];
    for (const branch of await this.storage.listBranches()) {
      const events = await this.storage.loadEvents(branch.sessionId, { branchId: branch.branchId });
      if (events.length === 0) continue;
      const state = projectEvents(events);
      const pendingCells = Object.values(state.cells).filter(
        (cell) => cell.status === "proposed" || cell.status === "running",
      );
      for (const cell of pendingCells) {
        await this.storage.appendEvents([{
          sessionId: branch.sessionId,
          branchId: branch.branchId,
          type: "CellAbandoned",
          producer: "recovery",
          idempotencyKey: `cell-recovery-abandoned:${branch.branchId}:${cell.id}`,
          payload: { cellId: cell.id, reason: "Console process ended before the cell committed" },
        }]);
        if (!abandonedCellIds.includes(cell.id)) abandonedCellIds.push(cell.id);
      }
      const branchUnknown = Object.keys(state.effects).filter((id) => unknownSet.has(id));
      const branchRetried = Object.keys(state.effects).filter((id) => retrySet.has(id));
      if (pendingCells.length || branchUnknown.length || branchRetried.length) {
        await this.storage.appendEvents([{
          sessionId: branch.sessionId,
          branchId: branch.branchId,
          type: "RecoveryPerformed",
          producer: "recovery",
          idempotencyKey: `recovery:${branch.branchId}:${[
            ...pendingCells.map((cell) => cell.id),
            ...branchUnknown,
            ...branchRetried,
          ].sort().join(",")}`,
          payload: {
            abandonedCellIds: pendingCells.map((cell) => cell.id),
            unknownEffectIds: branchUnknown,
            retriedEffectIds: branchRetried,
          },
        }]);
      }
    }
    return { abandonedCellIds, unknownEffectIds, retriedEffectIds };
  }
}

function stableEffectId(sessionId: string, idempotencyKey: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(sessionId);
  hasher.update("\0");
  hasher.update(idempotencyKey);
  return `effect-${hasher.digest("hex")}`;
}

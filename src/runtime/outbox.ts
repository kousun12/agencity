import {
  ValidationError,
  assertArtifactReference,
  assertBoundedOutputs,
  boundedOutputArtifactReferences,
  newId,
  projectEvents,
  type EffectOrigin,
  type EffectOutcome,
  type NewAgentEvent,
} from "../domain/index.ts";
import type { JsonValue } from "../domain/json.ts";
import type { EffectExecutionProgress, EffectExecutor, ExecutionResult } from "../executors/contract.ts";
import { result } from "../executors/contract.ts";
import type { AgentStorage, OutboxRecord } from "../storage/index.ts";
import { containsBrokeredSecret, scrubJson, scrubText } from "../security/index.ts";
import { brokeredSecretValues } from "../security/secret-registry.ts";
import { ProjectionService, type CurrentBranchProjection } from "./projection.ts";

export interface EffectRequest {
  readonly sessionId: string;
  readonly branchId: string;
  readonly executor: string;
  readonly operation: string;
  readonly input: JsonValue;
  readonly origin: EffectOrigin;
  readonly idempotencyKey: string;
  readonly idempotent: boolean;
}

/** Best-effort process-local progress. It has no durable cursor and is not replayed. */
export interface EffectProgressNotification {
  readonly type: "effect-progress";
  readonly effectId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly executor: string;
  readonly operation: string;
  readonly attempt: number;
  readonly sequence: number;
  readonly kind: string;
  readonly value: JsonValue;
  readonly observedAt: string;
}

const MAX_PROGRESS_NOTIFICATIONS_PER_EFFECT = 2_048;
const MAX_PROGRESS_BYTES_PER_EFFECT = 1_048_576;
const MAX_PROGRESS_BYTES_PER_NOTIFICATION = 32_768;
// Normal progress always leaves room for one visible terminal truncation marker.
const MAX_PROGRESS_TRUNCATION_MARKER_BYTES = 1_024;

export class OutboxRunner {
  readonly #executors = new Map<string, EffectExecutor>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #inflight = new Map<string, Promise<ExecutionResult>>();
  readonly #progressListeners = new Set<(notification: EffectProgressNotification) => void>();
  readonly #projections: ProjectionService;
  #claimAdmissions = 0;
  #deletionQuiesced = false;
  readonly owner = `runner-${newId()}`;

  constructor(readonly storage: AgentStorage, executors: readonly EffectExecutor[]) {
    for (const executor of executors) this.#executors.set(executor.name, executor);
    this.#projections = new ProjectionService(storage);
  }

  onProgress(listener: (notification: EffectProgressNotification) => void): () => void {
    this.#progressListeners.add(listener);
    return () => this.#progressListeners.delete(listener);
  }

  async request(request: EffectRequest): Promise<string> {
    const event = this.requestEvent(request);
    const [committed] = await this.storage.appendEvents([event]);
    if (!committed) throw new Error("Effect request was not committed");
    return (committed.payload as { effectId: string }).effectId;
  }

  /**
   * Builds a validated EffectRequested event for a larger atomic admission
   * batch. The caller must append the returned event before any execution.
   */
  requestEvent(request: EffectRequest): NewAgentEvent {
    if (this.#deletionQuiesced) throw new ValidationError("Outbox is quiesced for physical deletion");
    if (!request.idempotencyKey) throw new ValidationError("Effect requests require an idempotency key");
    if (containsBrokeredSecret(request.input)) throw new ValidationError("Brokered credentials cannot be stored in effect requests");
    // The durable handle is a pure function of the idempotency scope. A retry must
    // propose byte-identical event payload, while changed intent still conflicts.
    const effectId = stableEffectId(request.sessionId, request.idempotencyKey);
    return {
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
        origin: request.origin,
        idempotencyKey: request.idempotencyKey,
        idempotent: request.idempotent,
      },
    };
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
    await this.#projections.waitForTerminal(
      record.sessionId,
      record.branchId,
      (state) => {
        const effect = state.effects[record.effectId];
        return effect !== undefined &&
          !["requested", "started"].includes(effect.status);
      },
      { timeoutMs: Math.max(0, deadline - Date.now()) },
    );
    const final = await this.storage.getOutbox(record.effectId);
    if (!final) return result("failed", undefined, "Effect does not exist");
    if (final && !["pending", "running"].includes(final.status)) return this.#loadTerminal(final);
    if (final.status === "pending") return this.#claimAndExecute(record.effectId);
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
    acceptanceCrashAfterEffectStart(record.executor);
    const executor = this.#executors.get(record.executor);
    const controller = new AbortController();
    this.#controllers.set(record.effectId, controller);
    let progressOpen = true;
    let progressBoundReached = false;
    let progressSequence = 0;
    let progressBytes = 0;
    const progressSecrets = brokeredSecretsForProgress();
    let pendingModelText = "";
    let pendingModelMetadata: Readonly<Record<string, JsonValue>> | undefined;

    const publishProgress = (kind: string, value: JsonValue, encodedBytes: number): void => {
      const notification: EffectProgressNotification = {
        type: "effect-progress",
        effectId: record.effectId,
        sessionId: record.sessionId,
        branchId: record.branchId,
        executor: record.executor,
        operation: record.operation,
        attempt,
        sequence: progressSequence++,
        kind,
        value,
        observedAt: new Date().toISOString(),
      };
      progressBytes += encodedBytes;
      for (const listener of this.#progressListeners) {
        try { listener(notification); } catch { /* progress consumers cannot affect the effect */ }
      }
    };
    const truncateProgress = (
      reason: "notification-limit" | "byte-limit" | "notification-size-limit",
      suppressedKind: string,
    ): void => {
      if (progressBoundReached) return;
      progressBoundReached = true;
      const kind = "progress-truncated";
      const value = { reason, suppressedKind };
      const encodedBytes = progressJsonBytes(kind, value);
      // Normal notifications reserve both a sequence and enough aggregate bytes
      // for this marker, so the first suppressed notification is always visible.
      if (
        progressSequence < MAX_PROGRESS_NOTIFICATIONS_PER_EFFECT &&
        encodedBytes <= MAX_PROGRESS_BYTES_PER_NOTIFICATION &&
        progressBytes + encodedBytes <= MAX_PROGRESS_BYTES_PER_EFFECT
      ) publishProgress(kind, value, encodedBytes);
    };
    const emitBoundedProgress = (progress: EffectExecutionProgress): void => {
      if (!progressOpen || progressBoundReached || !progress.kind) return;
      const kind = scrubText(progress.kind).slice(0, 128);
      const value = scrubJson(progress.value);
      const encodedBytes = progressJsonBytes(kind, value);
      if (encodedBytes > MAX_PROGRESS_BYTES_PER_NOTIFICATION) {
        truncateProgress("notification-size-limit", kind);
        return;
      }
      if (progressSequence >= MAX_PROGRESS_NOTIFICATIONS_PER_EFFECT - 1) {
        truncateProgress("notification-limit", kind);
        return;
      }
      if (
        progressBytes + encodedBytes + MAX_PROGRESS_TRUNCATION_MARKER_BYTES >
        MAX_PROGRESS_BYTES_PER_EFFECT
      ) {
        truncateProgress("byte-limit", kind);
        return;
      }
      publishProgress(kind, value, encodedBytes);
    };
    const drainModelProgress = (final: boolean): void => {
      if (!pendingModelText || !pendingModelMetadata) return;
      for (const secret of brokeredSecretsForProgress()) {
        if (!progressSecrets.includes(secret)) progressSecrets.push(secret);
      }
      progressSecrets.sort((left, right) => right.length - left.length);
      const heldCharacters = final ? 0 : secretPrefixSuffixLength(pendingModelText, progressSecrets);
      const safeEnd = pendingModelText.length - heldCharacters;
      const safeText = scrubProgressText(pendingModelText.slice(0, safeEnd), progressSecrets);
      pendingModelText = pendingModelText.slice(safeEnd);
      if (safeText) {
        emitBoundedProgress({
          kind: "model-output-delta",
          value: { ...pendingModelMetadata, text: safeText },
        });
      }
    };
    const reportProgress = (progress: EffectExecutionProgress): void => {
      if (!progressOpen || progressBoundReached || !progress.kind) return;
      if (
        record.executor === "model" &&
        progress.kind === "model-output-delta" &&
        progress.value !== null &&
        typeof progress.value === "object" &&
        !Array.isArray(progress.value) &&
        typeof progress.value.text === "string"
      ) {
        const { text, ...metadata } = progress.value;
        pendingModelMetadata ??= scrubJson(metadata) as Readonly<Record<string, JsonValue>>;
        pendingModelText += text;
        drainModelProgress(false);
        return;
      }
      emitBoundedProgress(progress);
    };
    let execution: ExecutionResult;
    try {
      execution = executor
        ? await executor.execute({ ...record, attempt }, { signal: controller.signal, reportProgress })
        : result("failed", undefined, `Executor unavailable: ${record.executor}`, record.executor === "model" ? "provider-request-failed" : undefined);
    } catch (error) {
      execution = result(
        controller.signal.aborted ? "cancelled" : "failed",
        undefined,
        error instanceof Error ? error.message : String(error),
        !controller.signal.aborted && record.executor === "model" ? "transport-failed" : undefined,
      );
    } finally {
      // A suffix matching the beginning of a known secret is withheld until a
      // later delta proves it safe. Flush that suffix only when the executor is
      // terminal, after which it cannot join with another provider delta.
      drainModelProgress(true);
      progressOpen = false;
      this.#controllers.delete(record.effectId);
    }
    if (record.executor === "model" && execution.outcome === "failed" && execution.modelFailure === undefined) {
      execution = result("failed", execution.output, execution.error ?? "Model execution failed without a typed failure", "provider-request-failed");
    }
    if (record.executor === "model" && execution.outcome !== "failed" && execution.modelFailure !== undefined) {
      execution = result("failed", undefined, "Model executor returned failure provenance for a non-failed outcome", "provider-request-failed");
    }
    if (record.executor === "model" && execution.output !== undefined && containsBrokeredSecret(execution.output)) {
      execution = result("failed", undefined, "Model output contained a registered credential value", "stream-failed");
    }
    if (record.executor !== "model") {
      try {
        for (const artifact of execution.artifacts ?? []) assertArtifactReference(artifact);
        if (execution.output !== undefined) assertBoundedOutputs(execution.output);
        const declared = new Map(
          (execution.artifacts ?? []).map((artifact) => [artifact.artifactId, artifact]),
        );
        for (const reference of execution.output === undefined
          ? []
          : boundedOutputArtifactReferences(execution.output)) {
          const artifact = declared.get(reference.artifactId);
          if (!artifact || !Bun.deepEquals(artifact, reference)) {
            throw new ValidationError("Spilled output does not exactly match a declared executor artifact");
          }
        }
      } catch {
        execution = result(
          "failed",
          undefined,
          "Executor returned an invalid bounded-output or artifact completeness claim",
        );
      }
    }
    const safeExecution = result(
      execution.outcome,
      execution.output === undefined
        ? undefined
        : record.executor === "model" ? execution.output : scrubJson(execution.output),
      execution.error === undefined ? undefined : scrubText(execution.error),
      execution.modelFailure,
      execution.artifacts,
    );
    await this.storage.appendEvents([
      ...(safeExecution.artifacts ?? []).map((artifact) => ({
        sessionId: record.sessionId,
        branchId: record.branchId,
        type: "ArtifactRegistered" as const,
        producer: "executor",
        idempotencyKey: `effect-artifact:${record.effectId}:${attempt}:${artifact.artifactId}`,
        payload: artifact,
      })),
      {
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
          ...(safeExecution.modelFailure === undefined ? {} : { modelFailure: { code: safeExecution.modelFailure } }),
          observedAt: new Date().toISOString(),
        },
      },
    ]);
    return safeExecution;
  }

  async #loadTerminal(record: OutboxRecord): Promise<ExecutionResult> {
    const events = await this.storage.loadEvents(record.sessionId, { branchId: record.branchId });
    const outcome = [...events].reverse().find(
      (event) => event.type === "EffectOutcomeRecorded" &&
        (event.payload as { effectId: string }).effectId === record.effectId,
    );
    if (!outcome) return result(record.status as EffectOutcome, undefined, "Terminal outbox row has no outcome event");
    const payload = outcome.payload as { outcome: EffectOutcome; output?: JsonValue; error?: string; modelFailure?: { code: NonNullable<ExecutionResult["modelFailure"]> } };
    return result(payload.outcome, payload.output, payload.error, payload.modelFailure?.code);
  }

  /**
   * Reconciles effects whose owner disappeared. Idempotent effects become pending
   * with their attempt counter retained; non-idempotent effects become unknown.
   */
  async recover(
    currentBranches?: readonly CurrentBranchProjection[],
  ): Promise<{ abandonedCellIds: string[]; unknownEffectIds: string[]; retriedEffectIds: string[] }> {
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
    const branches = currentBranches ?? await this.#projections.currentBranches();
    for (const branch of branches) {
      const state = branch.state;
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

function acceptanceCrashAfterEffectStart(executor: string): void {
  if (process.env.AGENCITY_ACCEPTANCE !== "1") return;
  if (process.env.AGENCITY_ACCEPTANCE_FAILPOINT !== `outbox-started:${executor}`) return;
  process.stderr.write(`[agencity acceptance failpoint] committed EffectAttemptStarted for ${executor}; exiting service before executor entry\n`);
  process.exit(86);
}

export function stableEffectId(sessionId: string, idempotencyKey: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(sessionId);
  hasher.update("\0");
  hasher.update(idempotencyKey);
  return `effect-${hasher.digest("hex")}`;
}

function progressJsonBytes(kind: string, value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify({ kind, value })).byteLength;
}

function brokeredSecretsForProgress(): string[] {
  return brokeredSecretValues();
}

function scrubProgressText(text: string, retainedSecrets: readonly string[]): string {
  // scrubText covers credentials currently brokered by the supervisor. Retain
  // the effect-start snapshot too, so rotating an environment value during an
  // in-flight call cannot make an earlier credential observable.
  let scrubbed = scrubText(text);
  for (const secret of retainedSecrets) scrubbed = scrubbed.split(secret).join("[REDACTED]");
  return scrubbed;
}

function secretPrefixSuffixLength(text: string, secrets: readonly string[]): number {
  let held = 0;
  for (const secret of secrets) {
    // Hold a complete match at the current boundary too. It may also be the
    // prefix of a longer known secret, and the next delta decides which scrub
    // replacement the authoritative accumulated text receives.
    const longest = Math.min(text.length, secret.length);
    for (let length = longest; length > held; length--) {
      if (text.endsWith(secret.slice(0, length))) {
        held = length;
        break;
      }
    }
  }
  return held;
}

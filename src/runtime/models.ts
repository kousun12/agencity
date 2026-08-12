import {
  NotFoundError,
  REFINEMENT_GOVERNANCE_CONTRACT_ID,
  REFINEMENT_REVIEW_CONTRACT_ID,
  RESERVED_MODEL_DISPATCH_INPUT_FIELDS,
  TEXT_MODEL_RESPONSE_CONTRACT,
  ValidationError,
  assertNoReservedModelDispatchInputFields,
  assertJsonValue,
  createRefinementGovernanceRecursiveResult,
  createRefinementReviewRecursiveResult,
  jsonBytes,
  newId,
  projectEvents,
  validateModelEffectOutputV2,
  type ArtifactReference,
  type AgentProfileInput,
  type BudgetLimits,
  type EventPayloads,
  type JsonValue,
  type ModelConfiguration,
  type ModelConfigurationInput,
  type NewAgentEvent,
  type ModelEffectOutputV2,
  type RecursiveModelOutcome,
  type RecursiveResponseAdmission,
} from "../domain/index.ts";
import type { ArtifactStore } from "../artifacts/index.ts";
import { containsBrokeredSecret, scrubJson, scrubText } from "../security/index.ts";
import { requireRecursiveStorage, type AgentStorage, type RecursiveModelRecord } from "../storage/index.ts";
import type { AgentService } from "./agents.ts";
import type { MemoryService } from "./memory.ts";
import type { ModelLoop } from "./model-loop.ts";
import {
  registerRefinementGovernanceStarter,
  registerRefinementReviewStarter,
  type StructuredModelTurnRunner,
} from "./internal.ts";
import type { ModelEffectAdmissionService } from "./model-effect-admission.ts";
import type { OutboxRunner } from "./outbox.ts";
import { ExplicitContextMaterializer } from "./explicit-context.ts";

export const MAX_RECURSIVE_INPUT_BYTES = 256 * 1024;
export const MAX_RECURSIVE_RESULT_BYTES = 64 * 1024;
export const MAX_RECURSIVE_SQL_ROWS = 100;
export const RESERVED_PUBLIC_MODEL_DISPATCH_FIELDS =
  RESERVED_MODEL_DISPATCH_INPUT_FIELDS;

export type RecursiveModelInputReference =
  | { readonly kind: "artifact"; readonly artifactId: string; readonly start?: number; readonly end?: number }
  | { readonly kind: "document-range"; readonly documentId: string; readonly start?: number; readonly limit?: number; readonly chunkIds?: readonly string[] }
  | { readonly kind: "event"; readonly eventId: string }
  | { readonly kind: "memory"; readonly entryId: string; readonly versionId?: string }
  | { readonly kind: "sql-row"; readonly query: string; readonly args?: readonly (string | number | boolean | null)[]; readonly row?: number }
  | { readonly kind: "sql-rows"; readonly query: string; readonly args?: readonly (string | number | boolean | null)[]; readonly limit?: number };

export type RecursiveModelInput = JsonValue | RecursiveModelInputReference;

export interface StartRecursiveModelInput {
  readonly prompt?: string;
  readonly task?: string;
  /** A bounded inline JSON value or a typed durable reference. */
  readonly input?: RecursiveModelInput;
  /** Stable ordered multi-part input. Each part is independently attributed. */
  readonly inputs?: readonly RecursiveModelInput[];
  /** Backwards-compatible exact ordered document chunk set. */
  readonly inputSetId?: string;
  readonly model?: ModelConfigurationInput;
  readonly budget?: BudgetLimits;
  readonly profile?: AgentProfileInput;
  readonly run?: boolean;
  /** Stable command identity for crash-safe retry. */
  readonly idempotencyKey?: string;
}

export interface RecursiveModelHandle extends RecursiveModelRecord {}

export interface RecursiveModelResult {
  readonly handleId: string;
  readonly taskId: string;
  readonly status: "pending" | "running" | RecursiveModelOutcome;
  readonly outcome?: RecursiveModelOutcome;
  readonly value?: JsonValue;
  readonly resultMessageId?: string;
  readonly resultArtifactId?: string;
  readonly error?: string;
  readonly provenance: {
    readonly parentSessionId: string;
    readonly parentBranchId: string;
    readonly childSessionId: string;
    readonly childBranchId: string;
    readonly inputHash?: string;
    readonly inputProvenance?: JsonValue;
    readonly model: ModelConfiguration;
    readonly profileVersionId: string;
    readonly agentPromptDigest: string;
    readonly contextIds: readonly string[];
    readonly modelCallIds: readonly string[];
    readonly providerAttemptEffectIds: readonly string[];
    readonly harnessVersions: readonly string[];
    readonly usage: { readonly tokens: number; readonly costUsd: number; readonly turns: number; readonly wallTimeMs: number };
  };
}

export interface PublicRecursiveModelService {
  start(
    parentSessionId: string,
    parentBranchId: string,
    input: StartRecursiveModelInput | string,
  ): Promise<RecursiveModelHandle>;
  startMany(
    parentSessionId: string,
    parentBranchId: string,
    inputs: readonly (StartRecursiveModelInput | string)[],
  ): Promise<RecursiveModelHandle[]>;
  get(handleId: string): Promise<RecursiveModelHandle>;
  result(
    handleId: string,
    options?: { readonly wait?: boolean; readonly timeoutMs?: number },
  ): Promise<RecursiveModelResult>;
  cancel(handleId: string, reason?: string): Promise<RecursiveModelHandle>;
}

interface MaterializedInput {
  readonly value?: JsonValue;
  readonly provenance?: JsonValue;
  readonly hash?: string;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const PUBLIC_RECURSIVE_RESPONSE_ADMISSION: RecursiveResponseAdmission = Object.freeze({
  responseContract: TEXT_MODEL_RESPONSE_CONTRACT,
  responseCapability: Object.freeze({ kind: "text" as const }),
});

export class RecursiveModelService {
  readonly #recursive;
  readonly #explicitContext;
  readonly #runs = new Set<Promise<void>>();
  readonly #runningHandles = new Set<string>();

  constructor(
    readonly storage: AgentStorage,
    readonly agents: AgentService,
    readonly modelLoop: ModelLoop,
    readonly runStructuredModelTurn: StructuredModelTurnRunner,
    readonly modelEffectAdmission: ModelEffectAdmissionService,
    readonly outbox: OutboxRunner,
    readonly artifacts?: ArtifactStore,
    readonly memory?: MemoryService,
  ) {
    this.#recursive = requireRecursiveStorage(storage);
    this.#explicitContext = new ExplicitContextMaterializer(storage, artifacts, memory);
    // Supervisor-only structured refinement start stays behind the non-barrel
    // internal capability registry; see src/runtime/internal.ts.
    registerRefinementReviewStarter(this, (parentSessionId, parentBranchId, input) =>
      this.#startRefinementReview(parentSessionId, parentBranchId, input));
    registerRefinementGovernanceStarter(this, (parentSessionId, parentBranchId, input) =>
      this.#startSealedStructured(
        parentSessionId,
        parentBranchId,
        input,
        REFINEMENT_GOVERNANCE_CONTRACT_ID,
      ));
  }

  start(parentSessionId: string, parentBranchId: string, input: StartRecursiveModelInput | string): Promise<RecursiveModelHandle> {
    return this.startMany(parentSessionId, parentBranchId, [input]).then((handles) => handles[0]!);
  }

  async startMany(parentSessionId: string, parentBranchId: string, rawInputs: readonly (StartRecursiveModelInput | string)[]): Promise<RecursiveModelHandle[]> {
    return this.#startManyWithAdmissions(
      parentSessionId,
      parentBranchId,
      rawInputs,
      rawInputs.map(() => PUBLIC_RECURSIVE_RESPONSE_ADMISSION),
    );
  }

  /**
   * Sealed supervisor operation reachable only through the registered
   * `internalRefinementReviewStarter` capability. Public recursive inputs never
   * select response contracts or provider tools.
   */
  async #startRefinementReview(
    parentSessionId: string,
    parentBranchId: string,
    input: StartRecursiveModelInput,
  ): Promise<RecursiveModelHandle> {
    return this.#startSealedStructured(
      parentSessionId,
      parentBranchId,
      input,
      REFINEMENT_REVIEW_CONTRACT_ID,
    );
  }

  async #startSealedStructured(
    parentSessionId: string,
    parentBranchId: string,
    input: StartRecursiveModelInput,
    contractId:
      | typeof REFINEMENT_REVIEW_CONTRACT_ID
      | typeof REFINEMENT_GOVERNANCE_CONTRACT_ID,
  ): Promise<RecursiveModelHandle> {
    if (!input.idempotencyKey?.trim()) {
      throw new ValidationError(
        "Structured refinement operation requires a stable idempotency key",
      );
    }
    const existing = await this.#recursive.getRecursiveModel(
      stableRecursiveHandleId(
        parentSessionId,
        parentBranchId,
        input.idempotencyKey,
      ),
    );
    let responseAdmission: RecursiveResponseAdmission;
    if (existing) {
      if (existing.responseAdmission.responseContract.kind !==
          "required-tool-set" ||
          existing.responseAdmission.responseContract.contractId !==
            contractId) {
        throw new ValidationError(
          "Structured refinement idempotency key belongs to another response contract",
        );
      }
      responseAdmission = existing.responseAdmission;
    } else {
      const events = await this.storage.loadEvents(parentSessionId, {
        branchId: parentBranchId,
      });
      if (!events.length) {
        throw new NotFoundError(
          "parent branch",
          `${parentSessionId}/${parentBranchId}`,
        );
      }
      const parent = projectEvents(events);
      const admitted = this.modelEffectAdmission.requestBuiltInStructured(
        contractId,
        input.model ?? parent.model,
      ).modelDispatch;
      responseAdmission = Object.freeze({
        responseContract: admitted.responseContract,
        responseCapability: admitted.responseCapability,
      });
    }
    const [handle] = await this.#startManyWithAdmissions(
      parentSessionId,
      parentBranchId,
      [input],
      [responseAdmission],
    );
    return handle!;
  }

  async #startManyWithAdmissions(
    parentSessionId: string,
    parentBranchId: string,
    rawInputs: readonly (StartRecursiveModelInput | string)[],
    responseAdmissions: readonly RecursiveResponseAdmission[],
  ): Promise<RecursiveModelHandle[]> {
    if (rawInputs.length === 0) return [];
    if (responseAdmissions.length !== rawInputs.length) {
      throw new ValidationError(
        "Recursive model response admission count does not match inputs",
      );
    }
    const parentEvents = await this.storage.loadEvents(parentSessionId, { branchId: parentBranchId });
    if (!parentEvents.length) throw new NotFoundError("parent branch", `${parentSessionId}/${parentBranchId}`);
    const parent = projectEvents(parentEvents);
    const parentRecord = await this.#recursive.getSession(parentSessionId);
    if (!parentRecord) throw new NotFoundError("parent session", parentSessionId);

    const plans: Array<{
      normalized: StartRecursiveModelInput;
      prompt: string;
      materialized: MaterializedInput;
      admissionKey: string;
      responseAdmission: RecursiveResponseAdmission;
    }> = [];
    for (let inputIndex = 0; inputIndex < rawInputs.length; inputIndex++) {
      const raw = rawInputs[inputIndex]!;
      assertNoReservedPublicModelDispatchFields(raw);
      const normalized: StartRecursiveModelInput = typeof raw === "string" ? { prompt: raw } : raw;
      const prompt = normalized.prompt ?? normalized.task;
      if (!prompt?.trim()) throw new ValidationError("Recursive model prompt cannot be empty");
      if (new TextEncoder().encode(prompt).byteLength > 64 * 1024) throw new ValidationError("Recursive model prompt exceeds 65536 bytes");
      if (containsBrokeredSecret(prompt)) throw new ValidationError("Brokered credentials cannot enter a recursive model prompt");
      if (normalized.idempotencyKey !== undefined && !normalized.idempotencyKey.trim()) throw new ValidationError("Recursive model idempotencyKey cannot be empty");
      if (normalized.inputSetId !== undefined && (normalized.input !== undefined || normalized.inputs !== undefined)) {
        throw new ValidationError("Recursive model inputSetId cannot be combined with input or inputs");
      }
      if (normalized.input !== undefined && normalized.inputs !== undefined) {
        throw new ValidationError("Recursive model input and inputs are mutually exclusive");
      }
      let materialized: MaterializedInput;
      if (normalized.idempotencyKey !== undefined) {
        const existing = await this.#recursive.getRecursiveModel(stableRecursiveHandleId(parentSessionId, parentBranchId, normalized.idempotencyKey));
        if (existing) {
          const expectedIntentHash = inputIntentHash(normalized);
          const recordedIntentHash = existing.inputProvenance && typeof existing.inputProvenance === "object" && !Array.isArray(existing.inputProvenance) && typeof existing.inputProvenance.intentHash === "string"
            ? existing.inputProvenance.intentHash
            : undefined;
          if (expectedIntentHash !== recordedIntentHash) throw new ValidationError("Recursive model idempotency key was reused with a different request");
          materialized = {
            ...(existing.input === undefined ? {} : { value: existing.input }),
            ...(existing.inputProvenance === undefined ? {} : { provenance: existing.inputProvenance }),
            ...(existing.inputHash === undefined ? {} : { hash: existing.inputHash }),
          };
        } else materialized = await this.#materializeInput(parentSessionId, parentBranchId, parentRecord.rootSessionId, normalized);
      } else materialized = await this.#materializeInput(parentSessionId, parentBranchId, parentRecord.rootSessionId, normalized);
      const commandKey = normalized.idempotencyKey ?? newId();
      plans.push({
        normalized,
        prompt: prompt.trim(),
        materialized,
        admissionKey: `recursive-model:${commandKey}`,
        responseAdmission: responseAdmissions[inputIndex]!,
      });
    }

    const children = await this.agents.spawnManyWithEvents(parentSessionId, parentBranchId, plans.map((plan) => ({
      task: plan.prompt,
      idempotencyKey: plan.admissionKey,
      ...(plan.normalized.model === undefined ? {} : { model: plan.normalized.model }),
      ...(plan.normalized.budget === undefined ? {} : { budget: plan.normalized.budget }),
      ...(plan.normalized.profile === undefined ? {} : { profile: plan.normalized.profile }),
    })), (items) => {
      const events: NewAgentEvent[] = [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!;
        if (item.existing) continue;
        const plan = plans[index]!;
        const child = item.handle;
        const handleId = `model-${child.taskId}`;
        const model = item.model;
        events.push({
          sessionId: parentSessionId,
          branchId: parentBranchId,
          type: "RecursiveModelStarted",
          producer: "supervisor",
          idempotencyKey: `recursive-model:${handleId}`,
          payload: {
            handleId,
            taskId: child.taskId,
            parentSessionId,
            parentBranchId,
            childSessionId: child.sessionId,
            childBranchId: child.branchId,
            model,
            responseAdmission: plan.responseAdmission,
            profilePin: {
              profileVersionId: item.profile.profileVersionId,
              agentPromptDigest: item.profile.promptDigest,
              promptContractId: item.profile.promptContractId,
            },
            ...(plan.normalized.inputSetId === undefined ? {} : { inputSetId: plan.normalized.inputSetId }),
            ...(plan.materialized.value === undefined ? {} : { input: plan.materialized.value }),
            ...(plan.materialized.provenance === undefined ? {} : { inputProvenance: plan.materialized.provenance }),
            ...(plan.materialized.hash === undefined ? {} : { inputHash: plan.materialized.hash }),
          },
        });
        if (plan.materialized.value !== undefined) events.push({
          sessionId: child.sessionId,
          branchId: child.branchId,
          type: "MessageAppended",
          producer: "supervisor",
          idempotencyKey: `recursive-model-input:${handleId}`,
          payload: {
            messageId: `input-${handleId}`,
            role: "system",
            content: `Exact authorized recursive input (sha256:${plan.materialized.hash}): ${JSON.stringify({ value: plan.materialized.value, provenance: plan.materialized.provenance ?? null })}`,
          },
        });
      }
      return events;
    });

    const committed: RecursiveModelHandle[] = [];
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      const plan = plans[index]!;
      const handle = await this.#load(`model-${child.taskId}`);
      const childEvents = await this.storage.loadEvents(child.sessionId, { branchId: child.branchId });
      const created = childEvents.find((event) => event.type === "SessionCreated");
      if (!created) throw new ValidationError("Recursive model child has no retained admission");
      const admission = created.payload as EventPayloads["SessionCreated"];
      if (handle.parentSessionId !== parentSessionId || handle.parentBranchId !== parentBranchId ||
          handle.childSessionId !== child.sessionId || handle.childBranchId !== child.branchId ||
          handle.inputSetId !== (plan.normalized.inputSetId ?? null) ||
          handle.inputHash !== plan.materialized.hash ||
          !Bun.deepEquals(handle.input, plan.materialized.value) ||
          !Bun.deepEquals(handle.inputProvenance, plan.materialized.provenance) ||
          !Bun.deepEquals(handle.model, admission.model) ||
          !Bun.deepEquals(handle.profilePin, {
            profileVersionId: admission.agentProfile.profileVersionId,
            agentPromptDigest: admission.agentProfile.promptDigest,
            promptContractId: admission.agentProfile.promptContractId,
          }) ||
          !Bun.deepEquals(handle.responseAdmission, plan.responseAdmission)) {
        throw new ValidationError("Recursive model idempotency key was reused with a different request");
      }
      committed.push(handle);
    }
    for (let index = 0; index < committed.length; index++) {
      if (plans[index]!.normalized.run !== false && !TERMINAL.has(committed[index]!.status)) this.#launch(committed[index]!);
    }
    return committed;
  }

  get(handleId: string): Promise<RecursiveModelHandle> { return this.#load(handleId); }

  async result(handleId: string, options: { readonly wait?: boolean; readonly timeoutMs?: number } = {}): Promise<RecursiveModelResult> {
    const wait = options.wait ?? true;
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 24 * 60 * 60 * 1_000)) {
      throw new ValidationError("Recursive model result timeoutMs must be an integer from 0 to 86400000");
    }
    const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
    let handle = await this.#load(handleId);
    while (wait && !TERMINAL.has(handle.status) && Date.now() < deadline) {
      await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
      handle = await this.#load(handleId);
    }
    return this.#resultRecord(handle);
  }

  async cancel(handleId: string, reason = "Recursive model cancelled"): Promise<RecursiveModelHandle> {
    const handle = await this.#load(handleId);
    if (TERMINAL.has(handle.status)) return handle;
    const state = projectEvents(await this.storage.loadEvents(handle.childSessionId, { branchId: handle.childBranchId }));
    for (const effect of Object.values(state.effects)) if (["requested", "started"].includes(effect.status)) this.outbox.cancel(effect.id);
    await this.agents.cancel(handle.taskId, reason);
    const current = await this.#load(handleId);
    if (!TERMINAL.has(current.status)) await this.storage.appendEvents([{
      sessionId: handle.parentSessionId,
      branchId: handle.parentBranchId,
      type: "RecursiveModelStatusChanged",
      producer: "client",
      idempotencyKey: `recursive-model-cancelled:${handleId}`,
      payload: { handleId, status: "cancelled", outcome: "cancelled", error: reason },
    }]);
    return this.#load(handleId);
  }

  /** Resumes/finalizes committed recursive handles without creating a second call. */
  async recoverIncomplete(): Promise<number> {
    const handles = await this.#recursive.listRecursiveModels(["pending", "running"]);
    let recovered = 0;
    for (const handle of handles) {
      const task = await this.#recursive.getTask(handle.taskId);
      if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled")) {
        const outcome = taskOutcome(task.status, task.error);
        // A structured typed result is valid only on a successful completion.
        // Recovery of a failed or cancelled task must not attach the recreated
        // child submission, or the terminal event would be rejected.
        const result = isStructuredHandle(handle) && outcome !== "succeeded"
          ? undefined
          : task.result ?? await this.#resultFromChild(handle);
        const artifactId = resultArtifactId(result);
        const terminalError = task.error ?? task.reason;
        await this.storage.appendEvents([{
          sessionId: handle.parentSessionId,
          branchId: handle.parentBranchId,
          type: "RecursiveModelStatusChanged",
          producer: "recovery",
          idempotencyKey: `recursive-model-${outcome}:${handle.handleId}`,
          payload: {
            handleId: handle.handleId,
            status: outcome === "succeeded" ? "completed" : outcome === "cancelled" ? "cancelled" : "failed",
            outcome,
            ...(result === undefined ? {} : { result }),
            ...(artifactId === undefined ? {} : { resultArtifactId: artifactId }),
            ...(terminalError === undefined ? {} : { error: terminalError }),
          },
        }]);
        recovered++;
        continue;
      }
      const child = projectEvents(await this.storage.loadEvents(handle.childSessionId, { branchId: handle.childBranchId }));
      const latest = Object.values(child.modelCalls).at(-1);
      if (handle.status === "running" && latest && ["succeeded", "failed", "cancelled", "unknown"].includes(latest.status)) {
        if (latest.status === "succeeded") {
          if (isStructuredHandle(handle)) {
            await this.#finishStructuredCompletion(handle, latest.id);
          } else {
            const response = child.messages.find((message) => message.id === latest.responseMessageId);
            await this.#finish(handle, { outcome: "succeeded", ...(response === undefined ? {} : { message: response.content }) });
          }
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
      if (!current || TERMINAL.has(current.status)) return;
      await this.#run(current, alreadyRunning && current.status === "running");
    })().catch(() => { /* #run commits durable failure when storage is available */ }).finally(() => {
      this.#runningHandles.delete(handle.handleId);
      this.#runs.delete(running);
    });
    this.#runs.add(running);
  }

  async close(): Promise<void> { await Promise.allSettled([...this.#runs]); }

  async #run(handle: RecursiveModelHandle, alreadyRunning = false): Promise<void> {
    try {
      if (!alreadyRunning) await this.storage.appendEvents([{
        sessionId: handle.parentSessionId,
        branchId: handle.parentBranchId,
        type: "RecursiveModelStatusChanged",
        producer: "supervisor",
        idempotencyKey: `recursive-model-running:${handle.handleId}`,
        payload: { handleId: handle.handleId, status: "running" },
      }, {
        sessionId: handle.parentSessionId,
        branchId: handle.parentBranchId,
        type: "TaskStatusChanged",
        producer: "supervisor",
        idempotencyKey: `recursive-model-task-running:${handle.handleId}`,
        payload: { taskId: handle.taskId, status: "running" },
      }]);
      const current = await this.#recursive.getRecursiveModel(handle.handleId);
      const task = await this.#recursive.getTask(handle.taskId);
      if (!current || !task || TERMINAL.has(current.status) || ["completed", "failed", "cancelled"].includes(task.status)) return;
      const elapsed = Math.max(0, Date.now() - Date.parse(task.createdAt));
      const remaining = task.budget.wallTimeLimitMs === undefined ? undefined : Math.max(0, task.budget.wallTimeLimitMs - elapsed);
      if (remaining === 0) {
        await this.#finish(handle, { outcome: "budget-exceeded", error: "Recursive model wall-time budget exceeded before execution" });
        return;
      }
      if (isStructuredHandle(handle)) {
        await this.#runStructuredTurn(handle, remaining);
        return;
      }
      const turn = this.modelLoop.turn(handle.childSessionId, handle.childBranchId, {
        invocationId: handle.handleId,
        profilePin: handle.profilePin,
      });
      if (remaining === undefined) {
        await this.#finish(handle, await turn);
        return;
      }
      const timed = await Promise.race([
        turn.then((result) => ({ kind: "result" as const, result })),
        Bun.sleep(remaining).then(() => ({ kind: "timeout" as const })),
      ]);
      if (timed.kind === "result") await this.#finish(handle, timed.result);
      else {
        const child = projectEvents(await this.storage.loadEvents(handle.childSessionId, { branchId: handle.childBranchId }));
        for (const effect of Object.values(child.effects)) if (["requested", "started"].includes(effect.status)) this.outbox.cancel(effect.id);
        await this.#finish(handle, { outcome: "budget-exceeded", error: `Recursive model wall-time budget ${task.budget.wallTimeLimitMs}ms exceeded` });
      }
    } catch (error) {
      const current = await this.#recursive.getRecursiveModel(handle.handleId);
      if (!current || TERMINAL.has(current.status)) return;
      const message = error instanceof Error ? error.message : String(error);
      const child = projectEvents(await this.storage.loadEvents(handle.childSessionId, { branchId: handle.childBranchId }));
      await this.#finish(handle, {
        outcome: child.budget.exceeded || /budget (?:is )?exhausted|budget.*exceeded/i.test(message) ? "budget-exceeded" : "failed",
        error: message,
      });
    }
  }

  async #runStructuredTurn(
    handle: RecursiveModelHandle,
    remaining: number | undefined,
  ): Promise<void> {
    const turn = this.runStructuredModelTurn(
      handle.childSessionId,
      handle.childBranchId,
      handle.responseAdmission,
      { invocationId: handle.handleId, profilePin: handle.profilePin },
    );
    const timed = remaining === undefined
      ? { kind: "result" as const, result: await turn }
      : await Promise.race([
          turn.then((result) => ({ kind: "result" as const, result })),
          Bun.sleep(remaining).then(() => ({ kind: "timeout" as const })),
        ]);
    if (timed.kind === "timeout") {
      const child = projectEvents(await this.storage.loadEvents(
        handle.childSessionId,
        { branchId: handle.childBranchId },
      ));
      for (const effect of Object.values(child.effects)) {
        if (["requested", "started"].includes(effect.status)) {
          this.outbox.cancel(effect.id);
        }
      }
      const task = await this.#recursive.getTask(handle.taskId);
      await this.#finish(handle, {
        outcome: "budget-exceeded",
        error: `Recursive model wall-time budget ${task?.budget.wallTimeLimitMs ?? remaining}ms exceeded`,
      });
      return;
    }
    const result = timed.result;
    if (result.outcome !== "succeeded") {
      await this.#finish(handle, {
        outcome: result.outcome,
        ...(result.error === undefined ? {} : { error: result.error }),
      });
      return;
    }
    if (!result.output || !result.modelCallId) {
      await this.#finish(handle, {
        outcome: "failed",
        error: "Structured model turn completed without durable result provenance",
      });
      return;
    }
    await this.#finishStructuredCompletion(handle, result.modelCallId);
  }

  async #finish(handle: RecursiveModelHandle, value: { outcome: "succeeded" | "failed" | "cancelled" | "unknown" | "budget-exceeded"; message?: string; error?: string }): Promise<void> {
    const current = await this.#load(handle.handleId);
    if (TERMINAL.has(current.status)) return;
    if (value.outcome === "succeeded") {
      const childState = projectEvents(await this.storage.loadEvents(handle.childSessionId, { branchId: handle.childBranchId }));
      const response = [...childState.messages].reverse().find((message) => message.role === "assistant");
      const message = value.message ?? response?.content ?? "";
      const result = await this.#boundedResult(handle, message, response?.id);
      const artifactId = resultArtifactId(result);
      const budgetExceeded = childState.budget.exceeded;
      if (budgetExceeded) {
        const error = "[budget-exceeded] Recursive model completed after exhausting its delegated budget";
        try { await this.agents.failTask(handle.taskId, { error, ...(artifactId === undefined ? {} : { artifactIds: [artifactId] }) }); }
        catch { /* concurrent cancellation owns the terminal task */ }
        const after = await this.#load(handle.handleId);
        if (!TERMINAL.has(after.status)) await this.storage.appendEvents([{
          sessionId: handle.parentSessionId,
          branchId: handle.parentBranchId,
          type: "RecursiveModelStatusChanged",
          producer: "supervisor",
          idempotencyKey: `recursive-model-budget-exceeded:${handle.handleId}`,
          payload: { handleId: handle.handleId, status: "failed", outcome: "budget-exceeded", result, ...(response ? { resultMessageId: response.id } : {}), ...(artifactId === undefined ? {} : { resultArtifactId: artifactId }), error },
        }]);
        return;
      }
      await this.agents.completeTask(handle.taskId, {
        result,
        ...(artifactId === undefined ? {} : { artifactIds: [artifactId] }),
      });
      await this.storage.appendEvents([{
        sessionId: handle.parentSessionId,
        branchId: handle.parentBranchId,
        type: "RecursiveModelStatusChanged",
        producer: "supervisor",
        idempotencyKey: `recursive-model-completed:${handle.handleId}`,
        payload: { handleId: handle.handleId, status: "completed", outcome: "succeeded", result, ...(response ? { resultMessageId: response.id } : {}), ...(artifactId === undefined ? {} : { resultArtifactId: artifactId }) },
      }]);
      return;
    }

    const error = value.error ?? `Model ${value.outcome}`;
    if (value.outcome === "cancelled") await this.agents.cancel(handle.taskId, error);
    else {
      const tagged = value.outcome === "unknown" ? `[unknown] ${error}` : value.outcome === "budget-exceeded" ? `[budget-exceeded] ${error}` : error;
      try { await this.agents.failTask(handle.taskId, { error: tagged }); }
      catch { /* concurrent cancellation owns the terminal task */ }
    }
    const after = await this.#load(handle.handleId);
    if (TERMINAL.has(after.status)) return;
    const outcome: RecursiveModelOutcome = value.outcome;
    await this.storage.appendEvents([{
      sessionId: handle.parentSessionId,
      branchId: handle.parentBranchId,
      type: "RecursiveModelStatusChanged",
      producer: "supervisor",
      idempotencyKey: `recursive-model-${outcome}:${handle.handleId}`,
      payload: { handleId: handle.handleId, status: outcome === "cancelled" ? "cancelled" : "failed", outcome, error },
    }]);
  }

  async #finishStructured(
    handle: RecursiveModelHandle,
    modelCallId: string,
  ): Promise<void> {
    const current = await this.#load(handle.handleId);
    if (TERMINAL.has(current.status)) return;
    if (!isStructuredHandle(current)) {
      throw new ValidationError(
        "Text recursive model cannot complete with a structured result",
      );
    }
    const childState = projectEvents(await this.storage.loadEvents(
      current.childSessionId,
      { branchId: current.childBranchId },
    ));
    const call = childState.modelCalls[modelCallId];
    if (!call || call.status !== "succeeded" ||
        call.modelDispatch.responseContract.kind !== "required-tool-set" ||
        !Bun.deepEquals(
          {
            responseContract: call.modelDispatch.responseContract,
            responseCapability: call.modelDispatch.responseCapability,
          },
          current.responseAdmission,
        )) {
      throw new ValidationError(
        "Structured recursive result does not match its admitted child model call",
      );
    }
    const effect = childState.effects[call.effectId];
    if (!effect || effect.status !== "succeeded" || effect.output === undefined) {
      throw new ValidationError(
        "Structured recursive result is missing its successful model effect",
      );
    }
    const output = validateModelEffectOutputV2(effect.output, {
      responseContract: call.modelDispatch.responseContract,
      responseCapability: call.modelDispatch.responseCapability,
      configuredProvider: call.modelDispatch.configuration.provider,
    });
    if (output.result.kind !== "tool-submission") {
      throw new ValidationError(
        "Structured recursive child did not produce a tool submission",
      );
    }
    const submission = output.result.submission;
    const result = call.modelDispatch.responseContract.contractId ===
        REFINEMENT_GOVERNANCE_CONTRACT_ID
      ? createRefinementGovernanceRecursiveResult({
          contractDigest: call.modelDispatch.responseContract.contractDigest,
          modelCallId,
          providerToolCallId: submission.providerToolCallId,
          modelResultDigest: output.resultDigest,
          transportInput: submission.input,
          transportInputDigest: submission.inputDigest,
          transportInputBytes: submission.inputBytes,
        })
      : createRefinementReviewRecursiveResult({
      contractDigest: call.modelDispatch.responseContract.contractDigest,
      modelCallId,
      providerToolCallId: submission.providerToolCallId,
      modelResultDigest: output.resultDigest,
      transportInput: submission.input,
      transportInputDigest: submission.inputDigest,
      transportInputBytes: submission.inputBytes,
      });
    if (childState.budget.exceeded) {
      const error =
        "[budget-exceeded] Structured recursive model completed after exhausting its delegated budget";
      try {
        await this.agents.failTask(handle.taskId, { error });
      } catch {
        // Concurrent cancellation owns the terminal task.
      }
      const after = await this.#load(handle.handleId);
      if (!TERMINAL.has(after.status)) {
        await this.storage.appendEvents([{
          sessionId: handle.parentSessionId,
          branchId: handle.parentBranchId,
          type: "RecursiveModelStatusChanged",
          producer: "supervisor",
          idempotencyKey: `recursive-model-budget-exceeded:${handle.handleId}`,
          payload: {
            handleId: handle.handleId,
            status: "failed",
            outcome: "budget-exceeded",
            error,
          },
        }]);
      }
      return;
    }
    await this.agents.completeTask(handle.taskId, {});
    await this.storage.appendEvents([{
      sessionId: handle.parentSessionId,
      branchId: handle.parentBranchId,
      type: "RecursiveModelStatusChanged",
      producer: "supervisor",
      idempotencyKey: `recursive-model-completed:${handle.handleId}`,
      payload: {
        handleId: handle.handleId,
        status: "completed",
        outcome: "succeeded",
        result: result as unknown as JsonValue,
      },
    }]);
  }

  async #finishStructuredCompletion(
    handle: RecursiveModelHandle,
    modelCallId: string,
  ): Promise<void> {
    const child = projectEvents(await this.storage.loadEvents(
      handle.childSessionId,
      { branchId: handle.childBranchId },
    ));
    const call = child.modelCalls[modelCallId];
    const effect = call ? child.effects[call.effectId] : undefined;
    if (!call || call.status !== "succeeded" ||
        !effect || effect.status !== "succeeded" ||
        effect.output === undefined) {
      throw new ValidationError(
        "Structured recursive completion is missing durable model provenance",
      );
    }
    const output = validateModelEffectOutputV2(effect.output, {
      responseContract: call.modelDispatch.responseContract,
      responseCapability: call.modelDispatch.responseCapability,
      configuredProvider: call.modelDispatch.configuration.provider,
    });
    if (output.result.kind === "tool-submission") {
      await this.#finishStructured(handle, modelCallId);
      return;
    }
    await this.#finish(handle, {
      outcome: "failed",
      error: output.result.kind === "contract-violation"
        ? output.result.violation.message
        : "Structured model turn returned text",
    });
  }

  async #boundedResult(handle: RecursiveModelHandle, raw: string, messageId?: string): Promise<JsonValue> {
    const text = scrubText(raw);
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength <= MAX_RECURSIVE_RESULT_BYTES) return { kind: "text", text, byteLength: bytes.byteLength, ...(messageId === undefined ? {} : { messageId }) };
    if (!this.artifacts) throw new ValidationError("Recursive result exceeds the inline bound and artifact storage is unavailable");
    const artifact = await this.artifacts.put(text, { mediaType: "text/plain" });
    await this.storage.appendEvents([{
      sessionId: handle.childSessionId,
      branchId: handle.childBranchId,
      type: "ArtifactRegistered",
      producer: "supervisor",
      idempotencyKey: `recursive-model-result-artifact:${handle.handleId}:${artifact.artifactId}`,
      payload: { ...artifact, ...(messageId === undefined ? {} : { sourceEventId: messageId }) },
    }]);
    return validatedJson({
      kind: "artifact",
      artifact,
      byteLength: bytes.byteLength,
      preview: text.slice(0, 2_048),
      ...(messageId === undefined ? {} : { messageId }),
    });
  }

  async #resultRecord(handle: RecursiveModelHandle): Promise<RecursiveModelResult> {
    const outcome = handle.outcome ?? (handle.status === "completed" ? "succeeded" : handle.status === "cancelled" ? "cancelled" : handle.status === "failed" ? inferOutcome(handle.error) : undefined);
    const childEvents = await this.storage.loadEvents(handle.childSessionId, { branchId: handle.childBranchId });
    const child = projectEvents(childEvents);
    const value = handle.result ??
      (isStructuredHandle(handle)
        ? undefined
        : await this.#resultFromChild(handle));
    const contextIds = Object.keys(child.contexts);
    const modelCallIds = Object.keys(child.modelCalls);
    const providerAttemptEffectIds = [...new Set(childEvents.filter((event) => event.type === "EffectAttemptStarted").map((event) => (event.payload as { effectId: string }).effectId))];
    const harnessVersions = new Set<string>();
    for (const event of childEvents) {
      if (event.type !== "ContextMaterialized") continue;
      const provenance = (event.payload as { harnessProvenance?: JsonValue }).harnessProvenance;
      const selections = provenance && typeof provenance === "object" && !Array.isArray(provenance)
        ? (provenance as Record<string, JsonValue>).selections
        : undefined;
      if (Array.isArray(selections)) for (const selection of selections) {
        if (selection && typeof selection === "object" && !Array.isArray(selection) && typeof selection.versionId === "string") harnessVersions.add(selection.versionId);
      }
    }
    const publicStatus: RecursiveModelResult["status"] = outcome ?? (handle.status === "pending" ? "pending" : "running");
    return {
      handleId: handle.handleId,
      taskId: handle.taskId,
      status: publicStatus,
      ...(outcome === undefined ? {} : { outcome }),
      ...(value === undefined ? {} : { value }),
      ...(handle.resultMessageId === undefined ? {} : { resultMessageId: handle.resultMessageId }),
      ...(handle.resultArtifactId === undefined ? {} : { resultArtifactId: handle.resultArtifactId }),
      ...(handle.error === undefined ? {} : { error: handle.error }),
      provenance: {
        parentSessionId: handle.parentSessionId,
        parentBranchId: handle.parentBranchId,
        childSessionId: handle.childSessionId,
        childBranchId: handle.childBranchId,
        ...(handle.inputHash === undefined ? {} : { inputHash: handle.inputHash }),
        ...(handle.inputProvenance === undefined ? {} : { inputProvenance: handle.inputProvenance }),
        model: handle.model,
        profileVersionId: handle.profilePin.profileVersionId,
        agentPromptDigest: handle.profilePin.agentPromptDigest,
        contextIds,
        modelCallIds,
        providerAttemptEffectIds,
        harnessVersions: [...harnessVersions].sort(),
        usage: { tokens: child.budget.tokens, costUsd: child.budget.costUsd, turns: child.budget.turns, wallTimeMs: child.budget.wallTimeMs },
      },
    };
  }

  async #resultFromChild(handle: RecursiveModelRecord): Promise<JsonValue | undefined> {
    const child = projectEvents(await this.storage.loadEvents(handle.childSessionId, { branchId: handle.childBranchId }));
    if (isStructuredHandle(handle)) {
      const call = Object.values(child.modelCalls).reverse()
        .find((candidate) => candidate.status === "succeeded");
      if (!call || call.modelDispatch.responseContract.kind !==
          "required-tool-set" ||
          !Bun.deepEquals({
            responseContract: call.modelDispatch.responseContract,
            responseCapability: call.modelDispatch.responseCapability,
          }, handle.responseAdmission)) {
        return undefined;
      }
      const effect = child.effects[call.effectId];
      if (!effect || effect.status !== "succeeded" ||
          effect.output === undefined) {
        return undefined;
      }
      const output = validateModelEffectOutputV2(effect.output, {
        responseContract: call.modelDispatch.responseContract,
        responseCapability: call.modelDispatch.responseCapability,
        configuredProvider: call.modelDispatch.configuration.provider,
      });
      if (output.result.kind !== "tool-submission") return undefined;
      const submission = output.result.submission;
      return (call.modelDispatch.responseContract.contractId ===
          REFINEMENT_GOVERNANCE_CONTRACT_ID
        ? createRefinementGovernanceRecursiveResult({
            contractDigest: call.modelDispatch.responseContract.contractDigest,
            modelCallId: call.id,
            providerToolCallId: submission.providerToolCallId,
            modelResultDigest: output.resultDigest,
            transportInput: submission.input,
            transportInputDigest: submission.inputDigest,
            transportInputBytes: submission.inputBytes,
          })
        : createRefinementReviewRecursiveResult({
            contractDigest: call.modelDispatch.responseContract.contractDigest,
            modelCallId: call.id,
            providerToolCallId: submission.providerToolCallId,
            modelResultDigest: output.resultDigest,
            transportInput: submission.input,
            transportInputDigest: submission.inputDigest,
            transportInputBytes: submission.inputBytes,
          })) as unknown as JsonValue;
    }
    const response = [...child.messages].reverse().find((message) => message.role === "assistant");
    if (!response) return undefined;
    return this.#boundedResult(handle, response.content, response.id);
  }

  async #materializeInput(parentSessionId: string, parentBranchId: string, rootSessionId: string, input: StartRecursiveModelInput): Promise<MaterializedInput> {
    let parts: readonly RecursiveModelInput[] | undefined;
    if (input.inputs !== undefined) {
      if (!Array.isArray(input.inputs)) throw new ValidationError("Recursive model inputs must be an array");
      parts = input.inputs;
    } else if (input.input !== undefined) parts = [input.input];

    const values: JsonValue[] = [];
    const provenance: JsonValue[] = [];
    if (input.inputSetId !== undefined) {
      const inputSet = await this.#recursive.getInputSet(input.inputSetId);
      if (!inputSet) throw new NotFoundError("input set", input.inputSetId);
      const inputOwner = await this.#recursive.getSession(inputSet.sessionId);
      if (!inputOwner || inputOwner.rootSessionId !== rootSessionId) throw new ValidationError("Recursive input set is outside the parent session family scope");
      const chunks: JsonValue[] = [];
      for (const chunkId of inputSet.chunkIds) {
        const chunk = await this.#recursive.getDocumentChunk(chunkId);
        if (!chunk) throw new NotFoundError("document chunk", chunkId);
        chunks.push({ chunkId: chunk.chunkId, documentId: chunk.documentId, ordinal: chunk.ordinal, content: chunk.content, digest: chunk.digest, size: chunk.size });
      }
      values.push(chunks);
      provenance.push({ kind: "input-set", inputSetId: input.inputSetId, chunkIds: [...inputSet.chunkIds] });
    } else if (parts !== undefined) {
      const frozen = await this.#explicitContext.materialize(
        parentSessionId,
        parentBranchId,
        rootSessionId,
        parts,
      );
      const frozenValues = frozen.value as JsonValue[];
      values.push(...frozenValues);
      const frozenProvenance = frozen.provenance as Record<string, JsonValue>;
      if (Array.isArray(frozenProvenance.sources)) provenance.push(...frozenProvenance.sources);
    }
    if (values.length === 0 && input.input === undefined && input.inputs === undefined && input.inputSetId === undefined) return {};
    const value: JsonValue = input.inputs !== undefined || input.inputSetId !== undefined ? values : values[0]!;
    assertJsonValue(value);
    if (containsBrokeredSecret(value)) throw new ValidationError("Brokered credentials cannot enter recursive model input");
    const scrubbed = scrubJson(value);
    if (jsonBytes(scrubbed) > MAX_RECURSIVE_INPUT_BYTES) throw new ValidationError(`Recursive model materialized input exceeds ${MAX_RECURSIVE_INPUT_BYTES} bytes`);
    const intentHash = inputIntentHash(input);
    const inputProvenance = scrubJson({ ...(intentHash === undefined ? {} : { intentHash }), ordered: input.inputs !== undefined || input.inputSetId !== undefined, sources: provenance });
    const hash = sha256(JSON.stringify(scrubbed));
    return { value: scrubbed, provenance: inputProvenance, hash };
  }

  async #resolvePart(parentSessionId: string, parentBranchId: string, rootSessionId: string, raw: unknown): Promise<{ value: JsonValue; provenance: Record<string, JsonValue> }> {
    assertJsonValue(raw);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.kind !== "string" ||
        !["artifact", "document-range", "event", "memory", "sql-row", "sql-rows"].includes(raw.kind)) {
      return { value: scrubJson(raw), provenance: { kind: "inline-json", hash: sha256(JSON.stringify(raw)) } };
    }
    const reference = raw as Record<string, JsonValue>;
    if (reference.kind === "artifact") {
      if (typeof reference.artifactId !== "string") throw new ValidationError("Artifact input requires artifactId");
      if (!this.artifacts) throw new ValidationError("Artifact input resolution is unavailable");
      const found = await this.#familyArtifact(rootSessionId, reference.artifactId);
      if (!found) throw new NotFoundError("family artifact", reference.artifactId);
      const start = reference.start === undefined ? 0 : Number(reference.start);
      const end = reference.end === undefined ? found.size : Number(reference.end);
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start || end > found.size) throw new ValidationError("Invalid recursive artifact range");
      const bytes = await this.artifacts.readRange(found, start, end);
      return { value: new TextDecoder().decode(bytes), provenance: { kind: "artifact", artifactId: found.artifactId, digest: found.digest, mediaType: found.mediaType, size: found.size, start, end } };
    }
    if (reference.kind === "document-range") {
      if (typeof reference.documentId !== "string") throw new ValidationError("Document range input requires documentId");
      const document = await this.#recursive.getDocument(reference.documentId);
      if (!document) throw new NotFoundError("document", reference.documentId);
      const owner = await this.#recursive.getSession(document.sessionId);
      if (!owner || owner.rootSessionId !== rootSessionId) throw new ValidationError("Recursive document input is outside the parent session family scope");
      const start = reference.start === undefined ? 0 : Number(reference.start);
      const limit = reference.limit === undefined ? 20 : Number(reference.limit);
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ValidationError("Document range start/limit is invalid");
      const chunkIds = reference.chunkIds === undefined ? undefined : asStringArray(reference.chunkIds, "document range chunkIds");
      const chunks = await this.#recursive.readDocumentChunks(reference.documentId, { start, limit, ...(chunkIds === undefined ? {} : { chunkIds }) });
      return {
        value: chunks.map((chunk) => ({ chunkId: chunk.chunkId, documentId: chunk.documentId, ordinal: chunk.ordinal, content: chunk.content, digest: chunk.digest, size: chunk.size })),
        provenance: { kind: "document-range", documentId: document.documentId, documentDigest: document.digest, start, limit, chunkIds: chunks.map((chunk) => chunk.chunkId) },
      };
    }
    if (reference.kind === "event") {
      if (typeof reference.eventId !== "string") throw new ValidationError("Event input requires eventId");
      const event = await this.storage.getEvent(reference.eventId);
      if (!event) throw new NotFoundError("event", reference.eventId);
      const owner = await this.#recursive.getSession(event.sessionId);
      if (!owner || owner.rootSessionId !== rootSessionId) throw new ValidationError("Recursive event input is outside the parent session family scope");
      return {
        value: validatedJson({ eventId: event.id, sessionId: event.sessionId, branchId: event.branchId, cursor: event.cursor, type: event.type, schemaVersion: event.schemaVersion, committedAt: event.committedAt, payload: event.payload }),
        provenance: { kind: "event", eventId: event.id, sessionId: event.sessionId, branchId: event.branchId, cursor: event.cursor, schemaVersion: event.schemaVersion },
      };
    }
    if (reference.kind === "memory") {
      if (typeof reference.entryId !== "string") throw new ValidationError("Memory input requires entryId");
      if (!this.memory) throw new ValidationError("Policy-checked memory input resolution is unavailable");
      const result = await this.memory.search(parentSessionId, parentBranchId, "", { linkedEntryIds: [reference.entryId], statuses: ["active"], limit: 500 });
      const item = result.items.find((candidate) => candidate.record.entryId === reference.entryId);
      if (!item || reference.versionId !== undefined && (typeof reference.versionId !== "string" || item.record.current.versionId !== reference.versionId)) {
        throw new ValidationError("Recursive memory input is not active and visible in the parent policy scope");
      }
      const record = item.record;
      return {
        value: validatedJson({ entryId: record.entryId, versionId: record.current.versionId, name: record.name, scope: record.scope, content: record.current.content, tags: record.current.tags, confidence: record.current.confidence, evidenceEventIds: record.current.evidenceEventIds }),
        provenance: { kind: "memory", entryId: record.entryId, versionId: record.current.versionId, scope: record.scope, scopeKey: record.scopeKey, createdEventId: record.current.createdEventId },
      };
    }
    if (reference.kind === "sql-row" || reference.kind === "sql-rows") {
      if (typeof reference.query !== "string" || !reference.query.trim()) throw new ValidationError("SQL row input requires a read-only query");
      const args = sqlArgs(reference.args);
      const limit = reference.kind === "sql-row" ? Math.max(1, Number(reference.row ?? 0) + 1) : Number(reference.limit ?? MAX_RECURSIVE_SQL_ROWS);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECURSIVE_SQL_ROWS) throw new ValidationError(`Recursive SQL input limit must be from 1 to ${MAX_RECURSIVE_SQL_ROWS}`);
      const rows = await this.storage.readonlyQuery({ sql: `SELECT * FROM (${reference.query}) AS recursive_input LIMIT ?`, args: [...args, limit] });
      if (reference.kind === "sql-row") {
        const row = Number(reference.row ?? 0);
        if (!Number.isSafeInteger(row) || row < 0 || row >= MAX_RECURSIVE_SQL_ROWS) throw new ValidationError("Recursive SQL row index is invalid");
        if (rows[row] === undefined) throw new NotFoundError("SQL row", String(row));
        return { value: rows[row]!, provenance: { kind: "sql-row", query: reference.query, args, row, resultHash: sha256(JSON.stringify(rows[row])) } };
      }
      return { value: rows, provenance: { kind: "sql-rows", query: reference.query, args, limit, rowCount: rows.length, resultHash: sha256(JSON.stringify(rows)) } };
    }
    throw new ValidationError("Unsupported recursive model input reference");
  }

  async #familyArtifact(rootSessionId: string, artifactId: string): Promise<ArtifactReference | null> {
    for (const branch of await this.storage.listBranches()) {
      const session = await this.#recursive.getSession(branch.sessionId);
      if (!session || session.rootSessionId !== rootSessionId) continue;
      const events = await this.storage.loadEvents(branch.sessionId, { branchId: branch.branchId });
      if (!events.length) continue;
      const artifact = projectEvents(events).artifacts[artifactId];
      if (artifact) return artifact;
    }
    return null;
  }

  async #load(id: string): Promise<RecursiveModelHandle> {
    const result = await this.#recursive.getRecursiveModel(id);
    if (!result) throw new NotFoundError("recursive model", id);
    return result;
  }
}

export function assertNoReservedPublicModelDispatchFields(
  value: StartRecursiveModelInput | string | unknown,
): void {
  assertNoReservedModelDispatchInputFields(
    value,
    "Public recursive model input",
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const model = record.model;
  assertNoReservedModelDispatchInputFields(
    model,
    "Public model configuration",
  );
}

function inputIntentHash(input: StartRecursiveModelInput): string | undefined {
  if (input.inputSetId === undefined && input.input === undefined && input.inputs === undefined) return undefined;
  const identity = validatedJson({
    ...(input.inputSetId === undefined ? {} : { inputSetId: input.inputSetId }),
    ...(input.input === undefined ? {} : { input: input.input }),
    ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
  });
  return sha256(JSON.stringify(identity));
}

function stableRecursiveHandleId(parentSessionId: string, parentBranchId: string, key: string): string {
  const stable = sha256(`${parentSessionId}/${parentBranchId}/recursive-model:${key}`).slice(0, 32);
  return `model-task-${stable}`;
}

function validatedJson(value: unknown): JsonValue {
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  assertJsonValue(normalized);
  return normalized;
}

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function inferOutcome(error?: string): Exclude<RecursiveModelOutcome, "succeeded" | "cancelled"> {
  if (/\[unknown\]|unknown|ambiguous|lost.*outcome/i.test(error ?? "")) return "unknown";
  if (/\[budget-exceeded\]|budget.*(?:exhausted|exceeded)/i.test(error ?? "")) return "budget-exceeded";
  return "failed";
}

function taskOutcome(status: "completed" | "failed" | "cancelled", error?: string): RecursiveModelOutcome {
  return status === "completed" ? "succeeded" : status === "cancelled" ? "cancelled" : inferOutcome(error);
}

function resultArtifactId(result: JsonValue | undefined): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result) || result.kind !== "artifact") return undefined;
  const artifact = result.artifact;
  return artifact && typeof artifact === "object" && !Array.isArray(artifact) && typeof artifact.artifactId === "string" ? artifact.artifactId : undefined;
}

function isStructuredHandle(
  handle: Pick<RecursiveModelRecord, "responseAdmission">,
): boolean {
  return handle.responseAdmission.responseContract.kind ===
    "required-tool-set";
}

function asStringArray(value: JsonValue, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new ValidationError(`${label} must be an array of strings`);
  return value;
}

function sqlArgs(value: JsonValue | undefined): Array<string | number | null> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError("Recursive SQL input args must be an array");
  return value.map((item) => {
    if (item === null || typeof item === "string" || typeof item === "number") return item;
    if (typeof item === "boolean") return item ? 1 : 0;
    throw new ValidationError("Recursive SQL input arguments must be JSON scalars");
  });
}

import {
  REFINEMENT_REVIEW_POLICY,
  ValidationError,
  createRefinementReviewRequest,
  parseRefinementReview,
  projectEvents,
  type HarnessKind,
  type HarnessScope,
  type JsonValue,
  type RefinementReviewLifecycleStatus,
  type RefinementReviewRequest,
  type RefinementTriggerSeed,
} from "../domain/index.ts";
import { containsBrokeredSecret, isSensitiveEnvironmentKey, scrubText } from "../security/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import type { ProfileDatabase } from "../sync/index.ts";
import type { HarnessService } from "./harness.ts";
import type { RecursiveModelService, RecursiveModelResult } from "./models.ts";
import {
  buildRefinementTrajectorySnapshot,
  type RefinementEvaluationCandidateStatus,
  type RefinementEvaluationHistoryInput,
  type RefinementMemoryInput,
  type RefinementTrajectorySnapshot,
  type RefinementTrajectoryTriggerInput,
  type RefinementVisibleHarnessVersionInput,
} from "./refinement-context.ts";
import {
  DEFAULT_REFINEMENT_TRIGGER_POLICY_V1,
  scanRefinementTriggers,
  type RefinementDetectedTrigger,
  type RefinementTriggerPolicyV1,
} from "./refinement-triggers.ts";

export const REFINEMENT_TRIGGER_POLICY_PREFERENCE = "refinement.trigger-policy.v1" as const;
const TERMINAL_REVIEW = new Set<RefinementReviewLifecycleStatus>(["no_change", "candidate", "revision_required", "failed", "cancelled", "unknown"]);
const REVIEW_STATUSES = new Set<RefinementReviewLifecycleStatus>(["requested", "running", ...TERMINAL_REVIEW]);
const ALLOWED_KINDS: readonly HarnessKind[] = ["memory", "prompt_note", "skill", "subagent_spec"];
const ALLOWED_KIND_SET = new Set<HarnessKind>(ALLOWED_KINDS);
const ALLOWED_SCOPE_SET = new Set<HarnessScope>(["local", "workspace", "user", "global"]);

export interface StartRefinementReviewInput {
  readonly instructions?: string;
  readonly requestedScope?: HarnessScope;
  readonly allowedKinds?: readonly HarnessKind[];
  readonly wait?: boolean;
}

interface InternalReviewInput extends StartRefinementReviewInput {
  readonly mode: "manual" | "automatic" | "skill_creation";
  readonly trigger: RefinementTriggerSeed;
  readonly trajectoryTrigger: RefinementTrajectoryTriggerInput;
  readonly triggerKey?: string;
  readonly nonterminalKey?: string;
  readonly triggerEvidenceThroughCursor?: string;
}

export interface RefinementReviewRecord {
  readonly reviewId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly fingerprint: string;
  readonly mode: "manual" | "automatic" | "skill_creation";
  readonly requestedScope: HarnessScope;
  readonly requestedScopeKey: string;
  readonly allowedKinds: HarnessKind[];
  readonly triggerId: string;
  readonly triggerKind: string;
  readonly triggerFingerprint: string;
  readonly triggerKey: string | null;
  readonly nonterminalKey: string | null;
  readonly triggerEvidenceThroughCursor: string | null;
  readonly evidenceEventIds: string[];
  readonly sourceEventIds: string[];
  readonly sourceSnapshotHash: string;
  readonly sourceThroughCursor: string;
  readonly instructions: string | null;
  readonly status: RefinementReviewLifecycleStatus;
  readonly handleId: string | null;
  readonly childSessionId: string | null;
  readonly childBranchId: string | null;
  readonly decisionFingerprint: string | null;
  readonly proposalId: string | null;
  readonly reason: string | null;
  readonly createdEventId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

class ReviewQueue {
  readonly #tails = new Map<string, Promise<void>>();
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#tails.get(key) ?? Promise.resolve(); let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.catch(() => {}).then(() => current); this.#tails.set(key, tail); await prior.catch(() => {});
    try { return await operation(); }
    finally { release(); if (this.#tails.get(key) === tail) this.#tails.delete(key); }
  }
}

/** Durable trajectory-to-governed-proposal orchestration. */
export class RefinerService {
  readonly #queue = new ReviewQueue();
  readonly #jobs = new Map<string, Promise<void>>();

  constructor(
    readonly storage: AgentStorage,
    readonly models: RecursiveModelService,
    readonly harness: HarnessService,
    readonly profile: ProfileDatabase,
    readonly userScopeKey = "default-user",
  ) {}

  async request(sessionId: string, branchId: string, rawInput: StartRefinementReviewInput = {}): Promise<RefinementReviewRecord> {
    const input = normalizeReviewInput(rawInput);
    const internal: InternalReviewInput = {
      ...input,
      mode: "manual",
      trigger: { kind: "manual", summary: input.instructions?.trim() || "Manual review of the retained trajectory", evidenceEventIds: [] },
      trajectoryTrigger: { kind: "manual" },
    };
    return this.#admit(sessionId, branchId, internal);
  }

  /** Constrained agent skill-creation review; the child may propose only a skill edit in the requested scope. */
  async createSkill(sessionId: string, branchId: string, rawInput: Pick<StartRefinementReviewInput, "instructions" | "requestedScope"> = {}): Promise<RefinementReviewRecord> {
    const input = normalizeReviewInput({ ...rawInput, allowedKinds: ["skill"] });
    const internal: InternalReviewInput = {
      ...input,
      mode: "skill_creation",
      allowedKinds: ["skill"],
      trigger: { kind: "skill_creation", summary: input.instructions?.trim() || "Package a recurring workflow as one tested TypeScript skill", evidenceEventIds: [] },
      trajectoryTrigger: { kind: "manual" },
    };
    return this.#admit(sessionId, branchId, internal);
  }

  /** Canonical user correction; prose messages alone never enter automatic correction policy. */
  async correct(sessionId: string, branchId: string, correction: string, correctedEventIds: readonly string[]): Promise<string> {
    if (!correction.trim()) throw new ValidationError("User correction text is required");
    if (new TextEncoder().encode(correction).byteLength > 8 * 1024) throw new ValidationError("User correction exceeds 8192 bytes");
    if (containsBrokeredSecret(correction)) throw new ValidationError("Brokered credentials cannot enter user corrections");
    if (!Array.isArray(correctedEventIds) || correctedEventIds.length === 0 || correctedEventIds.length > 64 || new Set(correctedEventIds).size !== correctedEventIds.length) throw new ValidationError("User correction requires 1-64 distinct corrected event IDs");
    const events = await this.storage.loadEvents(sessionId, { branchId });
    const visible = new Set(events.map((event) => event.id));
    if (correctedEventIds.some((id) => !visible.has(id))) throw new ValidationError("User correction can cite only earlier events in this branch trajectory");
    const correctionId = stableId("user-correction", { sessionId, branchId, correction: correction.trim(), correctedEventIds: [...correctedEventIds].sort() });
    await this.storage.appendEvents([{
      sessionId, branchId, type: "UserCorrection", producer: "client", idempotencyKey: `user-correction:${correctionId}`,
      payload: { correctionId, correctedEventIds: [...correctedEventIds], correction: correction.trim() },
    }]);
    return correctionId;
  }

  async automaticPolicy(): Promise<RefinementTriggerPolicyV1> {
    const stored = await this.profile.getPreference(REFINEMENT_TRIGGER_POLICY_PREFERENCE);
    if (stored === null) return DEFAULT_REFINEMENT_TRIGGER_POLICY_V1;
    if (typeof stored.value === "boolean") return { ...DEFAULT_REFINEMENT_TRIGGER_POLICY_V1, automatic: stored.value };
    if (!stored.value || typeof stored.value !== "object" || Array.isArray(stored.value)) throw new ValidationError("Stored refinement trigger policy is malformed");
    const policy = stored.value as unknown as RefinementTriggerPolicyV1;
    try {
      // The pure scanner is the authoritative strict policy validator.
      scanRefinementTriggers({ sessionId: "policy-check", branchId: "policy-check", records: [], policy });
    } catch (error) {
      throw new ValidationError(`Stored refinement trigger policy is malformed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return policy;
  }

  async setAutomatic(enabled: boolean): Promise<RefinementTriggerPolicyV1> {
    if (typeof enabled !== "boolean") throw new ValidationError("Automatic refinement preference must be boolean");
    const policy = { ...await this.automaticPolicy(), automatic: enabled } as RefinementTriggerPolicyV1;
    await this.profile.setPreference(REFINEMENT_TRIGGER_POLICY_PREFERENCE, policy as unknown as JsonValue);
    return policy;
  }

  /** Called only at committed AgentRun boundaries. It never blocks the next model step on review completion. */
  async scanBoundary(sessionId: string, branchId: string): Promise<readonly RefinementReviewRecord[]> {
    const policy = await this.automaticPolicy();
    if (!policy.automatic) return [];
    const events = await this.storage.loadEvents(sessionId, { branchId });
    if (!events.length) return [];
    const rows = await this.storage.readonlyQuery({ sql: "SELECT trigger_key,last_consumed_evidence_cursor FROM refinement_trigger_consumptions WHERE session_id=? AND branch_id=? ORDER BY trigger_key", args: [sessionId,branchId] });
    const pending = await this.storage.readonlyQuery({ sql: "SELECT nonterminal_key FROM refinement_reviews WHERE session_id=? AND branch_id=? AND status IN ('requested','running') AND nonterminal_key IS NOT NULL ORDER BY nonterminal_key", args: [sessionId,branchId] });
    const detected = scanRefinementTriggers({
      sessionId, branchId, policy,
      records: events.map((event) => ({ id: event.id, sessionId: event.sessionId, branchId: event.branchId, cursor: canonicalCursor(event.cursor), type: event.type, payload: event.payload })),
      consumptions: (rows as any[]).map((row) => ({ triggerKey: String(row.trigger_key), lastConsumedEvidenceCursor: canonicalCursor(String(row.last_consumed_evidence_cursor)) })),
      nonterminalKeys: (pending as any[]).map((row) => String(row.nonterminal_key)),
      brokeredCredentialValues: knownSecretValues(),
    });
    const admitted: RefinementReviewRecord[] = [];
    for (const trigger of detected) admitted.push(await this.#admitAutomatic(trigger));
    return admitted;
  }

  async get(reviewId: string): Promise<RefinementReviewRecord> {
    if (typeof reviewId !== "string" || !reviewId) throw new ValidationError("Refinement review ID is required");
    const rows = await this.storage.readonlyQuery({ sql: "SELECT * FROM refinement_reviews WHERE review_id=?", args: [reviewId] });
    if (!rows[0]) throw new ValidationError(`Refinement review not found: ${reviewId}`);
    return rowToReview(rows[0] as Record<string, unknown>);
  }

  async getForBranch(sessionId: string, branchId: string, reviewId: string): Promise<RefinementReviewRecord> {
    const review = await this.get(reviewId);
    if (review.sessionId !== sessionId || review.branchId !== branchId) throw new ValidationError("Refinement review belongs to another session branch");
    return review;
  }

  async list(input: { readonly sessionId?: string; readonly branchId?: string; readonly status?: RefinementReviewLifecycleStatus } = {}): Promise<RefinementReviewRecord[]> {
    if (input.branchId !== undefined && input.sessionId === undefined) throw new ValidationError("A refinement review branch filter requires sessionId");
    if (input.status !== undefined && !REVIEW_STATUSES.has(input.status)) throw new ValidationError(`Unknown refinement review status: ${String(input.status)}`);
    const where: string[] = []; const args: string[] = [];
    if (input.sessionId !== undefined) { where.push("session_id=?"); args.push(input.sessionId); }
    if (input.branchId !== undefined) { where.push("branch_id=?"); args.push(input.branchId); }
    if (input.status !== undefined) { where.push("status=?"); args.push(input.status); }
    const rows = await this.storage.readonlyQuery({ sql: `SELECT * FROM refinement_reviews${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at,review_id`, args });
    return rows.map((row) => rowToReview(row as Record<string, unknown>));
  }

  /** Resumes exact retained boundaries in background. Unknown child outcomes are terminal and never retried. */
  async recoverIncomplete(): Promise<number> {
    const records = await this.list(); let count = 0;
    for (const record of records) {
      if (TERMINAL_REVIEW.has(record.status)) continue;
      this.#launch(record.reviewId); count++;
    }
    return count;
  }

  async close(): Promise<void> { await Promise.allSettled([...this.#jobs.values()]); }

  async #admitAutomatic(trigger: RefinementDetectedTrigger): Promise<RefinementReviewRecord> {
    return this.#queue.run(`trigger:${trigger.nonterminalKey}`, async () => {
      const trajectoryTrigger: RefinementTrajectoryTriggerInput = trigger.kind === "repeated_effect_failure"
        ? { kind: trigger.kind, failureEventIds: trigger.evidenceEventIds }
        : trigger.kind === "repeated_gate_failure"
          ? { kind: trigger.kind, failureEventIds: trigger.evidenceEventIds }
          : { kind: trigger.kind, correctionEventIds: trigger.evidenceEventIds };
      return this.#admit(trigger.sessionId, trigger.branchId, {
        mode: "automatic", wait: false, requestedScope: "local", allowedKinds: ALLOWED_KINDS,
        trigger: { kind: trigger.kind, summary: trigger.summary, evidenceEventIds: trigger.evidenceEventIds }, trajectoryTrigger,
        triggerKey: trigger.key, nonterminalKey: trigger.nonterminalKey, triggerEvidenceThroughCursor: trigger.evidenceThroughCursor,
      });
    });
  }

  async #admit(sessionId: string, branchId: string, input: InternalReviewInput): Promise<RefinementReviewRecord> {
    const events = await this.storage.loadEvents(sessionId, { branchId });
    if (!events.length) throw new ValidationError("Cannot refine a missing session branch");
    const state = projectEvents(events);
    const requestedScope = input.mode === "automatic" ? "local" : input.requestedScope ?? "local";
    const requestedScopeKey = scopeKey(requestedScope, state.workspaceId, sessionId, this.userScopeKey);
    const allowedKinds = [...new Set(input.allowedKinds ?? ALLOWED_KINDS)];
    let snapshot: RefinementTrajectorySnapshot;
    try {
      snapshot = await this.#snapshot(state.workspaceId, sessionId, branchId, events.at(-1)!.cursor, requestedScope, requestedScopeKey, allowedKinds, input.trajectoryTrigger);
    } catch (error) {
      throw error instanceof ValidationError ? error : new ValidationError(error instanceof Error ? error.message : String(error));
    }
    const request = createRefinementReviewRequest({
      mode: input.mode, sessionId, branchId, requestedScope, requestedScopeKey, allowedKinds,
      visibleSourceEventIds: snapshot.sourceEventIds, editableTargets: snapshot.editableTargets,
      trigger: input.trigger, ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    }, { brokeredCredentialValues: knownSecretValues() });
    const existingRows = await this.storage.readonlyQuery({
      sql: `SELECT * FROM refinement_reviews WHERE review_id=?${input.nonterminalKey === undefined ? "" : " OR (session_id=? AND branch_id=? AND nonterminal_key=? AND status IN ('requested','running'))"} ORDER BY CASE WHEN review_id=? THEN 0 ELSE 1 END LIMIT 1`,
      args: input.nonterminalKey === undefined ? [request.reviewId, request.reviewId] : [request.reviewId, sessionId, branchId, input.nonterminalKey, request.reviewId],
    });
    if (!existingRows[0]) await this.storage.appendEvents([{
      sessionId, branchId, type: "RefinementReviewRequested", producer: input.mode === "manual" ? "client" : "supervisor",
      idempotencyKey: `refinement-review-requested:${request.reviewId}`,
      payload: {
        reviewId: request.reviewId, fingerprint: request.fingerprint, mode: request.mode, requestedScope: request.requestedScope,
        requestedScopeKey, allowedKinds: [...request.allowedKinds], triggerId: request.trigger.triggerId, triggerKind: request.trigger.kind,
        triggerFingerprint: request.trigger.fingerprint, ...(input.triggerKey === undefined ? {} : { triggerKey: input.triggerKey }),
        ...(input.nonterminalKey === undefined ? {} : { nonterminalKey: input.nonterminalKey }),
        ...(input.triggerEvidenceThroughCursor === undefined ? {} : { triggerEvidenceThroughCursor: input.triggerEvidenceThroughCursor }),
        evidenceEventIds: [...request.trigger.evidenceEventIds], sourceEventIds: [...request.visibleSourceEventIds], sourceSnapshotHash: snapshot.canonicalHash,
        sourceThroughCursor: snapshot.throughCursor, ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
        request: request as unknown as JsonValue, snapshot: snapshot as unknown as JsonValue,
      },
    }]);
    const admittedReviewId = existingRows[0] ? String((existingRows[0] as Record<string, unknown>).review_id) : request.reviewId;
    const record = await this.get(admittedReviewId);
    if (!TERMINAL_REVIEW.has(record.status)) {
      if (input.wait === false) this.#launch(record.reviewId);
      else await this.#queue.run(record.reviewId, () => this.#advance(record.reviewId));
    }
    return this.get(record.reviewId);
  }

  #launch(reviewId: string): void {
    if (this.#jobs.has(reviewId)) return;
    const job = this.#queue.run(reviewId, () => this.#advance(reviewId)).catch(() => {}).finally(() => this.#jobs.delete(reviewId));
    this.#jobs.set(reviewId, job);
  }

  async #advance(reviewId: string): Promise<void> {
    let record = await this.get(reviewId);
    if (TERMINAL_REVIEW.has(record.status)) return;
    try {
      if (record.handleId === null) {
        const source = await this.#requestEvent(record);
        const request = source.request as unknown as RefinementReviewRequest;
        const handle = await this.models.start(record.sessionId, record.branchId, {
          prompt: refinerPrompt(request), input: { request: source.request, snapshot: source.snapshot },
          idempotencyKey: `refinement-review:${record.reviewId}`, run: true,
        });
        await this.storage.appendEvents([{
          sessionId: record.sessionId, branchId: record.branchId, type: "RefinementReviewChildLinked", producer: "supervisor",
          idempotencyKey: `refinement-review-child:${record.reviewId}`,
          payload: { reviewId: record.reviewId, handleId: handle.handleId, childSessionId: handle.childSessionId, childBranchId: handle.childBranchId },
        }]);
        record = await this.get(reviewId);
      }
      if (record.handleId === null) throw new ValidationError("Refinement review has no durable recursive child link");
      // Recheck exact recursive input attribution on both first execution and restart.
      const linkedSource = await this.#requestEvent(record);
      const linkedSnapshot = linkedSource.snapshot as unknown as RefinementTrajectorySnapshot;
      const linkedHandle = await this.models.get(record.handleId);
      if (linkedHandle.parentSessionId !== record.sessionId || linkedHandle.parentBranchId !== record.branchId ||
          linkedHandle.childSessionId !== record.childSessionId || linkedHandle.childBranchId !== record.childBranchId ||
          linkedHandle.inputHash !== sha256Text(JSON.stringify({ request: linkedSource.request, snapshot: linkedSource.snapshot })) ||
          linkedSnapshot.canonicalHash !== record.sourceSnapshotHash) {
        throw new ValidationError("Refinement recursive input attribution does not match its frozen snapshot");
      }
      if (record.status === "requested") {
        await this.#status(record, "running", { expectedStatus: "requested" }); record = await this.get(reviewId);
      }
      if (record.status !== "running" || record.handleId === null) return;
      const result = await this.models.result(record.handleId, { wait: true });
      if (result.status === "pending" || result.status === "running") return;
      if (result.outcome !== "succeeded") {
        const status = result.outcome === "unknown" ? "unknown" : result.outcome === "cancelled" ? "cancelled" : "failed";
        await this.#terminal(record, status, { reason: result.error ?? `Refiner child ended ${result.outcome}` }); return;
      }
      const raw = await this.#rawResult(result);
      const request = (await this.#requestEvent(record)).request as unknown as RefinementReviewRequest;
      const decision = parseRefinementReview(raw, request, { brokeredCredentialValues: knownSecretValues() });
      if (decision.status === "no_change") {
        await this.#terminal(record, "no_change", { decisionFingerprint: decision.decisionFingerprint, reason: decision.reason }); return;
      }
      let proposal = await this.harness.propose(record.sessionId, record.branchId, {
        proposalId: decision.proposalId, sourceReviewId: record.reviewId, proposalFingerprint: decision.proposalFingerprint,
        trigger: decision.trigger, predictedEffect: decision.predictedEffect, edits: decision.edits,
        evidenceEventIds: decision.evidenceEventIds, evaluation: decision.evaluation, authority: "agent",
      });
      if (proposal.status === "proposed") proposal = await this.harness.validate(record.sessionId, record.branchId, proposal.proposalId);
      if (proposal.status === "validated") proposal = await this.harness.activate(record.sessionId, record.branchId, proposal.proposalId, { allocationLimit: 3, exposureLimit: 3 });
      if (proposal.candidateId && ["candidate", "promoted", "rejected", "rolled_back"].includes(proposal.status)) {
        if (proposal.status === "candidate") {
          const allocations = await this.harness.allocations(proposal.candidateId);
          if (!allocations.some((item) => item.sessionId === record.sessionId && item.branchId === record.branchId && item.taskId === null)) await this.harness.allocate(record.sessionId, record.branchId, proposal.proposalId);
        }
        await this.#terminal(record, "candidate", { proposalId: proposal.proposalId, decisionFingerprint: decision.decisionFingerprint });
      } else {
        await this.#terminal(record, "revision_required", { proposalId: proposal.proposalId, decisionFingerprint: decision.decisionFingerprint, reason: "Refiner proposal failed strict harness validation" });
      }
    } catch (error) {
      record = await this.get(reviewId);
      if (TERMINAL_REVIEW.has(record.status)) return;
      // Domain/input failures are deterministic and become visible terminal outcomes.
      // Infrastructure failures leave the last committed boundary nonterminal so
      // restart recovery can resume it without inventing or duplicating work.
      if (error instanceof ValidationError) {
        await this.#terminal(record, "failed", { reason: error.message });
        return;
      }
      throw error;
    }
  }

  async #terminal(record: RefinementReviewRecord, status: Exclude<RefinementReviewLifecycleStatus, "requested" | "running">, details: { reason?: string; decisionFingerprint?: string; proposalId?: string }): Promise<void> {
    const safeDetails = { ...details, ...(details.reason === undefined ? {} : { reason: boundedUtf8(scrubText(details.reason), 16 * 1024) }) };
    const events: any[] = [{
      sessionId: record.sessionId, branchId: record.branchId, type: "RefinementReviewStatusChanged", producer: "supervisor",
      idempotencyKey: `refinement-review-terminal:${record.reviewId}`,
      payload: { reviewId: record.reviewId, status, expectedStatus: record.status, ...safeDetails },
    }];
    if (record.triggerKey !== null && record.triggerEvidenceThroughCursor !== null) events.push({
      sessionId: record.sessionId, branchId: record.branchId, type: "RefinementTriggerConsumed", producer: "supervisor",
      idempotencyKey: `refinement-trigger-consumed:${record.reviewId}`,
      payload: { reviewId: record.reviewId, triggerKey: record.triggerKey, evidenceThroughCursor: record.triggerEvidenceThroughCursor },
    });
    await this.storage.appendEvents(events);
  }

  async #status(record: RefinementReviewRecord, status: "running", details: { expectedStatus: "requested" }): Promise<void> {
    await this.storage.appendEvents([{
      sessionId: record.sessionId, branchId: record.branchId, type: "RefinementReviewStatusChanged", producer: "supervisor",
      idempotencyKey: `refinement-review-running:${record.reviewId}`,
      payload: { reviewId: record.reviewId, status, ...details },
    }]);
  }

  async #requestEvent(record: RefinementReviewRecord): Promise<{ request: JsonValue; snapshot: JsonValue }> {
    const event = await this.storage.getEvent(record.createdEventId);
    if (!event || event.type !== "RefinementReviewRequested") throw new ValidationError("Refinement review request event is unavailable");
    const payload = event.payload as { request: JsonValue; snapshot?: JsonValue };
    if (payload.snapshot === undefined) throw new ValidationError("Refinement review has no retained trajectory snapshot and cannot be resumed safely");
    return { request: payload.request, snapshot: payload.snapshot };
  }

  async #rawResult(result: RecursiveModelResult): Promise<string> {
    if (result.resultMessageId !== undefined) {
      const events = await this.storage.loadEvents(result.provenance.childSessionId, { branchId: result.provenance.childBranchId });
      const event = events.find((item) => item.type === "MessageAppended" && (item.payload as { messageId?: string }).messageId === result.resultMessageId);
      if (event) return String((event.payload as { content: string }).content);
    }
    const value = result.value;
    if (value && typeof value === "object" && !Array.isArray(value) && value.kind === "text" && typeof value.text === "string") return value.text;
    throw new ValidationError("Refinement result has no attributable textual response");
  }

  async #snapshot(workspaceId: string, sessionId: string, branchId: string, throughCursor: string, requestedScope: HarnessScope, requestedScopeKey: string, allowedKinds: readonly HarnessKind[], trigger: RefinementTrajectoryTriggerInput): Promise<RefinementTrajectorySnapshot> {
    const events = await this.storage.loadEvents(sessionId, { branchId, untilCursor: throughCursor });
    const exposures = await this.storage.readonlyQuery({ sql: "SELECT proposal_id,session_id,branch_id FROM candidate_allocations WHERE exposed_at IS NOT NULL ORDER BY proposal_id,session_id,branch_id LIMIT 2048", args: [] });
    const exposed = new Map<string, Array<{ sessionId: string; branchId: string }>>();
    for (const row of exposures as any[]) { const key = String(row.proposal_id); const list = exposed.get(key) ?? []; list.push({ sessionId: String(row.session_id), branchId: String(row.branch_id) }); exposed.set(key, list); }
    const versions = await this.storage.readonlyQuery({ sql: "SELECT v.*,e.current_version_id FROM harness_versions v JOIN harness_entries e ON e.entry_id=v.entry_id WHERE v.status IN ('active','candidate') ORDER BY v.version_id LIMIT 512", args: [] });
    const visibleHarnessVersions: RefinementVisibleHarnessVersionInput[] = versions.map((row: any) => ({
      entryId: String(row.entry_id), versionId: String(row.version_id), currentVersionId: String(row.current_version_id), kind: String(row.kind) as HarnessKind,
      scope: String(row.scope) as HarnessScope, scopeKey: String(row.scope_key), name: String(row.name), status: String(row.status) as any,
      content: parseJson(row.content_json, null), ...(row.proposal_id === null ? {} : { exposedTo: exposed.get(String(row.proposal_id)) ?? [] }),
    }));
    const memory: RefinementMemoryInput[] = visibleHarnessVersions.filter((item) => item.kind === "memory" && item.content && typeof item.content === "object" && !Array.isArray(item.content)).map((item, rank) => {
      const content = item.content as { memoryKind?: string; text?: string };
      return { entryId: item.entryId, versionId: item.versionId, currentVersionId: item.currentVersionId, scope: item.scope, scopeKey: item.scopeKey, name: item.name, status: item.status, memoryKind: content.memoryKind as any, text: content.text ?? "", reason: "current policy-visible harness memory", rank, ...(item.exposedTo === undefined ? {} : { exposedTo: item.exposedTo }) };
    });
    const observationRows = await this.storage.readonlyQuery({ sql: "SELECT o.*,p.status AS candidate_status,a.session_id,a.branch_id,a.exposed_at,s.workspace_id FROM refinement_observations o JOIN refinement_proposals p ON p.proposal_id=o.proposal_id JOIN candidate_allocations a ON a.allocation_id=o.allocation_id JOIN sessions s ON s.session_id=a.session_id ORDER BY o.created_at,o.observation_id LIMIT 512", args: [] });
    const evaluationHistory: RefinementEvaluationHistoryInput[] = observationRows.map((row: any) => ({
      observationId: String(row.observation_id), proposalId: String(row.proposal_id), candidateId: String(row.candidate_id), workspaceId: String(row.workspace_id), sessionId: String(row.session_id), branchId: String(row.branch_id),
      candidateStatus: evaluationStatus(String(row.candidate_status)), evaluator: String(row.evaluator), objective: Number(row.objective) === 1, success: Number(row.success) === 1,
      metric: parseJson(row.metric_json, null), ...(row.baseline_json === null ? {} : { baseline: parseJson(row.baseline_json, null) }), evidenceEventIds: parseJson(row.evidence_event_ids_json, []), ...(row.notes === null ? {} : { notes: String(row.notes) }), createdAt: String(row.created_at),
      ...(row.exposed_at === null ? {} : { exposedTo: [{ sessionId: String(row.session_id), branchId: String(row.branch_id) }] }),
    }));
    return buildRefinementTrajectorySnapshot({
      workspaceId, sessionId, branchId, throughCursor, userScopeKey: this.userScopeKey,
      events: events.map((event) => ({ id: event.id, sessionId: event.sessionId, branchId: event.branchId, cursor: event.cursor, type: event.type, payload: event.payload })),
      trigger, visibleHarnessVersions, memory, evaluationHistory, requestedScope, requestedScopeKey, allowedKinds,
    }, { brokeredCredentialValues: knownSecretValues() });
  }
}

function normalizeReviewInput(input: StartRefinementReviewInput): StartRefinementReviewInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("Refinement review input must be an object");
  if (input.instructions !== undefined && typeof input.instructions !== "string") throw new ValidationError("Refinement instructions must be a string");
  if (input.requestedScope !== undefined && !ALLOWED_SCOPE_SET.has(input.requestedScope)) throw new ValidationError("Requested refinement scope is invalid");
  if (input.wait !== undefined && typeof input.wait !== "boolean") throw new ValidationError("Refinement wait must be boolean");
  if (input.allowedKinds !== undefined) {
    if (!Array.isArray(input.allowedKinds) || input.allowedKinds.length === 0 || input.allowedKinds.length > ALLOWED_KINDS.length || new Set(input.allowedKinds).size !== input.allowedKinds.length || input.allowedKinds.some((kind) => !ALLOWED_KIND_SET.has(kind))) {
      throw new ValidationError("Refinement allowedKinds must contain 1-4 distinct supported harness kinds");
    }
  }
  return input;
}

function canonicalCursor(cursor: string): string { return BigInt(cursor).toString(); }
function scopeKey(scope: HarnessScope, workspaceId: string, sessionId: string, userScopeKey: string): string {
  return scope === "local" ? sessionId : scope === "workspace" ? workspaceId : scope === "user" ? userScopeKey : "global";
}
function evaluationStatus(status: string): RefinementEvaluationCandidateStatus {
  if (status === "candidate" || status === "promoted" || status === "rejected" || status === "revision_required" || status === "rolled_back") return status;
  return "revision_required";
}
function parseJson<T>(value: unknown, fallback: T): T { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)) as T; } catch { return fallback; } }
function knownSecretValues(): string[] {
  const encoder = new TextEncoder();
  const candidates = Object.entries(process.env)
    .filter(([key, value]) => isSensitiveEnvironmentKey(key) && typeof value === "string" && encoder.encode(value).byteLength >= 4)
    .map(([, value]) => value!)
    .sort((a, b) => encoder.encode(b).byteLength - encoder.encode(a).byteLength || a.localeCompare(b));
  const values: string[] = []; let bytes = 0;
  for (const value of candidates) {
    const size = encoder.encode(value).byteLength;
    if (values.length >= 64 || bytes + size > 64 * 1024) continue;
    values.push(value); bytes += size;
  }
  return values;
}
function boundedUtf8(value: string, maximum: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximum) return value;
  let low = 0; let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= maximum) low = middle;
    else high = middle - 1;
  }
  const bounded = value.slice(0, low);
  return bounded.length > 0 && /[\uD800-\uDBFF]/.test(bounded.at(-1)!) ? bounded.slice(0, -1) : bounded;
}
function stableId(prefix: string, value: unknown): string { return `${prefix}-${stableSha256(value).slice(0,32)}`; }
function sha256Text(value: string): string { const hash = new Bun.CryptoHasher("sha256"); hash.update(value); return hash.digest("hex"); }
function stableSha256(value: unknown): string { const hash = new Bun.CryptoHasher("sha256"); hash.update(canonicalJson(value)); return hash.digest("hex"); }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record=value as Record<string,unknown>; return `{${Object.keys(record).sort().map((key)=>`${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`; }
function refinerPrompt(request: RefinementReviewRequest): string {
  return [
    "Review the authorized retained trajectory snapshot supplied as exact recursive input.",
    REFINEMENT_REVIEW_POLICY,
    `The required reviewId is ${request.reviewId}.`,
    "Make the smallest evidence-backed edit. Return no_change when durable evidence does not justify a safe proposal.",
    "Do not claim an evaluator succeeded; only define the objective evaluation that the existing governance pipeline must later run.",
  ].join(" ");
}
function rowToReview(row: Record<string, unknown>): RefinementReviewRecord {
  return {
    reviewId: String(row.review_id), sessionId: String(row.session_id), branchId: String(row.branch_id), fingerprint: String(row.fingerprint), mode: String(row.mode) as RefinementReviewRecord["mode"], requestedScope: String(row.requested_scope) as HarnessScope, requestedScopeKey: String(row.requested_scope_key), allowedKinds: parseJson(row.allowed_kinds_json, []), triggerId: String(row.trigger_id), triggerKind: String(row.trigger_kind), triggerFingerprint: String(row.trigger_fingerprint), triggerKey: row.trigger_key === null ? null : String(row.trigger_key), nonterminalKey: row.nonterminal_key === null ? null : String(row.nonterminal_key), triggerEvidenceThroughCursor: row.trigger_evidence_through_cursor === null ? null : String(row.trigger_evidence_through_cursor), evidenceEventIds: parseJson(row.evidence_event_ids_json, []), sourceEventIds: parseJson(row.source_event_ids_json, []), sourceSnapshotHash: String(row.source_snapshot_hash), sourceThroughCursor: String(row.source_through_cursor), instructions: row.instructions === null ? null : String(row.instructions), status: String(row.status) as RefinementReviewLifecycleStatus, handleId: row.handle_id === null ? null : String(row.handle_id), childSessionId: row.child_session_id === null ? null : String(row.child_session_id), childBranchId: row.child_branch_id === null ? null : String(row.child_branch_id), decisionFingerprint: row.decision_fingerprint === null ? null : String(row.decision_fingerprint), proposalId: row.proposal_id === null ? null : String(row.proposal_id), reason: row.reason === null ? null : String(row.reason), createdEventId: String(row.created_event_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

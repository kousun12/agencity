import {
  REFINEMENT_REVIEW_POLICY,
  ValidationError,
  createRefinementReviewRequest,
  projectEvents,
  validateRefinementReviewRecursiveResult,
  validateRefinementReviewValue,
  type HarnessKind,
  type HarnessScope,
  type GovernedRefinementRecord,
  type GovernedRefinementRollbackRecord,
  type GovernedRefinementStatus,
  type JsonValue,
  type RefinementGovernanceDecision,
  type RefinementReviewLifecycleStatus,
  type RefinementReviewRequest,
  type RefinementTriggerSeed,
} from "../domain/index.ts";
import {
  containsBrokeredSecret,
  refinementVisibleEventPayload,
  scrubText,
} from "../security/index.ts";
import { brokeredSecretValues } from "../security/secret-registry.ts";
import type { AgentStorage } from "../storage/index.ts";
import type { ProfileDatabase, ProfilePreference } from "../sync/index.ts";
import type { HarnessService } from "./harness.ts";
import type { RefinementGovernanceService } from "./refinement-governance.ts";
import type { PublicRecursiveModelService } from "./models.ts";
import type { StructuredRefinementReviewStarter } from "./internal.ts";
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
const LEARNING_HISTORY_MAX_BYTES = 256 * 1024;
const LEARNING_HISTORY_SOURCE_IDS = 32;

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
  readonly automaticPolicyGeneration?: string;
}

class AutomaticAdmissionSuppressed extends Error {}

export interface RefinementReviewRecord {
  readonly reviewId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly fingerprint: string;
  readonly mode: "manual" | "automatic" | "skill_creation";
  readonly waitForGovernance: boolean;
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
  readonly governedStatus: GovernedRefinementStatus | null;
  readonly governedResult: JsonValue | null;
  readonly createdEventId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LearningGovernanceSummary {
  readonly proposalId: string;
  readonly status: GovernedRefinementStatus;
  readonly targetKind: "agent_profile" | "harness";
  readonly harnessKind: HarnessKind | null;
  readonly editCount: number;
  readonly decision: RefinementGovernanceDecision | null;
  readonly appliedVersionIds: readonly string[];
  readonly terminalReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LearningReviewSummary extends Omit<
  RefinementReviewRecord,
  "sourceEventIds" | "instructions" | "reason" | "governedResult"
> {
  readonly sourceEventIds: readonly string[];
  readonly sourceEventCount: number;
  readonly sourceEventIdsTruncated: boolean;
  readonly instructions: string | null;
  readonly reason: string | null;
}

export interface LearningReviewActivity {
  readonly kind: "review";
  readonly activityId: string;
  readonly effectiveStatus:
    | RefinementReviewLifecycleStatus
    | GovernedRefinementStatus
    | "rolled_back";
  readonly review: LearningReviewSummary;
  readonly governance: LearningGovernanceSummary | null;
  readonly rollback: GovernedRefinementRollbackRecord | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LearningScanActivity {
  readonly kind: "scan_observation";
  readonly activityId: string;
  readonly effectiveStatus: "scan_unavailable" | "validation_failed";
  readonly sessionId: string;
  readonly branchId: string;
  readonly message: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type LearningActivity = LearningReviewActivity | LearningScanActivity;

export interface LearningStatusView {
  readonly automaticLearning: "enabled" | "paused" | "unavailable";
  readonly automaticPolicy: RefinementTriggerPolicyV1 | null;
  readonly policyError: "validation_failed" | null;
  readonly pendingActivityCount: number;
  readonly latestActivity: LearningActivity | null;
}

export interface LearningHistoryView {
  readonly automaticLearning: "enabled" | "paused" | "unavailable";
  readonly automaticPolicy: RefinementTriggerPolicyV1 | null;
  readonly policyError: "validation_failed" | null;
  readonly activities: readonly LearningActivity[];
  readonly byteLimit: number;
  readonly truncated: boolean;
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
  #governance: RefinementGovernanceService | null = null;

  constructor(
    readonly storage: AgentStorage,
    private readonly models: PublicRecursiveModelService,
    private readonly startStructuredRefinementModel:
      StructuredRefinementReviewStarter,
    readonly harness: HarnessService,
    readonly profile: ProfileDatabase,
    readonly userScopeKey = "default-user",
  ) {}

  attachGovernance(service: RefinementGovernanceService): void {
    if (this.#governance && this.#governance !== service) {
      throw new ValidationError("Refiner governance service is already attached");
    }
    this.#governance = service;
  }

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
    return (await this.#automaticPolicyState()).policy;
  }

  async #automaticPolicyState(): Promise<{
    readonly policy: RefinementTriggerPolicyV1;
    readonly generation: string;
  }> {
    const stored = await this.profile.getPreference(REFINEMENT_TRIGGER_POLICY_PREFERENCE);
    return this.#automaticPolicyStateFrom(stored);
  }

  #automaticPolicyStateFrom(stored: ProfilePreference | null): {
    readonly policy: RefinementTriggerPolicyV1;
    readonly generation: string;
  } {
    if (stored === null) {
      return {
        policy: DEFAULT_REFINEMENT_TRIGGER_POLICY_V1,
        generation: "default",
      };
    }
    if (typeof stored.value === "boolean") {
      return {
        policy: { ...DEFAULT_REFINEMENT_TRIGGER_POLICY_V1, automatic: stored.value },
        generation: stableSha256({ value: stored.value, updatedAt: stored.updatedAt }),
      };
    }
    if (!stored.value || typeof stored.value !== "object" || Array.isArray(stored.value)) throw new ValidationError("Stored refinement trigger policy is malformed");
    const retained = stored.value as unknown as Partial<RefinementTriggerPolicyV1>;
    const policy = {
      ...retained,
      cellFailure: retained.cellFailure ??
        DEFAULT_REFINEMENT_TRIGGER_POLICY_V1.cellFailure,
      repeatedSuccess: retained.repeatedSuccess ??
        DEFAULT_REFINEMENT_TRIGGER_POLICY_V1.repeatedSuccess,
    } as RefinementTriggerPolicyV1;
    try {
      // The pure scanner is the authoritative strict policy validator.
      scanRefinementTriggers({ sessionId: "policy-check", branchId: "policy-check", records: [], policy });
    } catch (error) {
      throw new ValidationError(`Stored refinement trigger policy is malformed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      policy,
      generation: stableSha256({ value: stored.value, updatedAt: stored.updatedAt }),
    };
  }

  async setAutomatic(enabled: boolean): Promise<RefinementTriggerPolicyV1> {
    if (typeof enabled !== "boolean") throw new ValidationError("Automatic refinement preference must be boolean");
    return this.#queue.run("automatic-policy", () =>
      this.profile.withPreferenceLock(
        REFINEMENT_TRIGGER_POLICY_PREFERENCE,
        async (_stored, setValue) => {
          await setValue(enabled);
          return {
            ...DEFAULT_REFINEMENT_TRIGGER_POLICY_V1,
            automatic: enabled,
          };
        },
      ));
  }

  /**
   * Called only at committed AgentRun boundaries. Review completion is always
   * background work, and malformed retained policy/evidence is a non-fatal
   * observation rather than authority to wedge the owning run or recovery.
   */
  async scanBoundary(sessionId: string, branchId: string, boundaryKey?: string): Promise<readonly RefinementReviewRecord[]> {
    void boundaryKey;
    return this.#queue.run("automatic-policy", () =>
      this.profile.withPreferenceLock(
        REFINEMENT_TRIGGER_POLICY_PREFERENCE,
        async (stored, _setValue, assertOwner) => {
          try {
            const policyState = this.#automaticPolicyStateFrom(stored);
            if (!policyState.policy.automatic) return [];
            const events = await this.storage.loadEvents(sessionId, { branchId });
            if (!events.length) return [];
            const rows = await this.storage.readonlyQuery({ sql: "SELECT trigger_key,last_consumed_evidence_cursor FROM refinement_trigger_consumptions WHERE session_id=? AND branch_id=? ORDER BY trigger_key", args: [sessionId,branchId] });
            const pending = await this.storage.readonlyQuery({ sql: "SELECT nonterminal_key FROM refinement_reviews WHERE session_id=? AND branch_id=? AND status IN ('requested','running') AND nonterminal_key IS NOT NULL ORDER BY nonterminal_key", args: [sessionId,branchId] });
            const detected = scanRefinementTriggers({
              sessionId, branchId, policy: policyState.policy,
              records: events.map((event) => ({ id: event.id, sessionId: event.sessionId, branchId: event.branchId, cursor: canonicalCursor(event.cursor), type: event.type, payload: event.payload })),
              consumptions: (rows as any[]).map((row) => ({ triggerKey: String(row.trigger_key), lastConsumedEvidenceCursor: canonicalCursor(String(row.last_consumed_evidence_cursor)) })),
              nonterminalKeys: (pending as any[]).map((row) => String(row.nonterminal_key)),
              brokeredCredentialValues: knownSecretValues(),
            });
            const admitted: RefinementReviewRecord[] = [];
            // A committed-boundary scan may discover several eligible trigger
            // tranches, but admits only the first deterministic result. The others
            // remain unconsumed and are reconsidered by a later scan.
            for (const trigger of detected.slice(0, 1)) {
              await assertOwner();
              const review = await this.#admitAutomatic(trigger, policyState.generation);
              if (review) admitted.push(review);
            }
            return admitted;
          } catch (error) {
            // The observation is deliberately fixed-shape: malformed retained policy
            // values or error text are never copied into history.
            await this.#recordBoundaryScanFailure(sessionId, branchId, error).catch(() => {});
            return [];
          }
        },
      ));
  }

  async #recordBoundaryScanFailure(sessionId: string, branchId: string, error: unknown): Promise<void> {
    const category = error instanceof ValidationError ? "validation_failed" : "scan_unavailable";
    const fingerprint = stableSha256({ sessionId, branchId, category }).slice(0, 32);
    await this.storage.appendEvents([{
      id: `refinement-scan-observation-${fingerprint}`,
      sessionId, branchId, type: "MessageAppended", producer: "supervisor",
      idempotencyKey: `refinement-scan-observation:${fingerprint}`,
      payload: {
        messageId: `refinement-scan-observation-${fingerprint}`,
        role: "tool",
        content: `Automatic learning scan skipped at a committed boundary (${category}); task execution remains available and no learning result is implied.`,
        learningScan: { version: 1, category },
      },
    }]);
  }

  async get(reviewId: string): Promise<RefinementReviewRecord> {
    if (typeof reviewId !== "string" || !reviewId) throw new ValidationError("Refinement review ID is required");
    const rows = await this.storage.readonlyQuery({ sql: "SELECT * FROM refinement_reviews WHERE review_id=?", args: [reviewId] });
    if (!rows[0]) throw new ValidationError(`Refinement review not found: ${reviewId}`);
    return this.#withGovernedResult(rowToReview(rows[0] as Record<string, unknown>));
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
    return Promise.all(rows.map((row) =>
      this.#withGovernedResult(rowToReview(row as Record<string, unknown>))));
  }

  async learningStatus(
    sessionId: string,
    branchId: string,
  ): Promise<LearningStatusView> {
    await this.#assertSessionBranch(sessionId, branchId);
    const policy = await this.#learningPolicyView();
    const [counts, history] = await Promise.all([
      this.storage.readonlyQuery({
        sql: `SELECT count(*) AS pending
          FROM refinement_reviews r
          LEFT JOIN governed_refinement_proposals g
            ON g.proposal_id=r.proposal_id
          WHERE r.session_id=?
            AND (
              r.status IN ('requested','running')
              OR g.status IN ('proposed','validated','reviewing','reviewed_approved')
            )`,
        args: [sessionId],
      }),
      this.learningHistory(sessionId, branchId, 1, policy),
    ]);
    return {
      ...policy,
      pendingActivityCount: Number((counts[0] as any)?.pending ?? 0),
      latestActivity: history.activities[0] ?? null,
    };
  }

  async learningHistory(
    sessionId: string,
    branchId: string,
    limit = 50,
    knownPolicy?: Pick<
      LearningHistoryView,
      "automaticLearning" | "automaticPolicy" | "policyError"
    >,
  ): Promise<LearningHistoryView> {
    await this.#assertSessionBranch(sessionId, branchId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidationError("Learning history limit must be 1-100");
    }
    const [policy, reviewRows, scanRows] = await Promise.all([
      knownPolicy ?? this.#learningPolicyView(),
      this.storage.readonlyQuery({
        sql: `SELECT r.* FROM refinement_reviews r
          LEFT JOIN governed_refinement_proposals g
            ON g.proposal_id=r.proposal_id
          LEFT JOIN events rb
            ON rb.type='GovernedRefinementRollbackApplied'
            AND json_extract(rb.payload_json,'$.proposalId')=r.proposal_id
          WHERE r.session_id=?
          ORDER BY COALESCE(rb.committed_at,g.updated_at,r.updated_at) DESC,
            r.review_id DESC LIMIT ?`,
        args: [sessionId, limit + 1],
      }),
      this.storage.readonlyQuery({
        sql: `SELECT id,session_id,branch_id,payload_json,committed_at
          FROM events
          WHERE session_id=? AND type='MessageAppended'
            AND id LIKE 'refinement-scan-observation-%'
            AND json_extract(payload_json,'$.learningScan.version')=1
          ORDER BY sequence DESC LIMIT ?`,
        args: [sessionId, limit + 1],
      }),
    ]);
    const reviews = await Promise.all(reviewRows.map((row) =>
      this.#learningReview(rowToReview(row as Record<string, unknown>))));
    const scans = scanRows.map((row) =>
      learningScanActivity(row as Record<string, unknown>));
    const ordered = [...reviews, ...scans]
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.activityId.localeCompare(left.activityId));
    const activities: LearningActivity[] = [];
    for (const activity of ordered) {
      if (activities.length >= limit) break;
      const candidate: LearningHistoryView = {
        ...policy,
        activities: [...activities, activity],
        byteLimit: LEARNING_HISTORY_MAX_BYTES,
        truncated: false,
      };
      if (jsonUtf8Bytes(candidate) > LEARNING_HISTORY_MAX_BYTES) break;
      activities.push(activity);
    }
    const truncated = activities.length < ordered.length;
    return {
      ...policy,
      activities,
      byteLimit: LEARNING_HISTORY_MAX_BYTES,
      truncated,
    };
  }

  async #learningPolicyView(): Promise<Pick<
    LearningHistoryView,
    "automaticLearning" | "automaticPolicy" | "policyError"
  >> {
    try {
      const automaticPolicy = await this.automaticPolicy();
      return {
        automaticLearning: automaticPolicy.automatic ? "enabled" : "paused",
        automaticPolicy,
        policyError: null,
      };
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return {
        automaticLearning: "unavailable",
        automaticPolicy: null,
        policyError: "validation_failed",
      };
    }
  }

  async learningActivity(
    sessionId: string,
    branchId: string,
    activityId: string,
  ): Promise<LearningActivity> {
    await this.#assertSessionBranch(sessionId, branchId);
    if (!activityId) throw new ValidationError("Learning activity ID is required");
    if (activityId.startsWith("refinement-scan-observation-")) {
      const rows = await this.storage.readonlyQuery({
        sql: `SELECT id,session_id,branch_id,payload_json,committed_at
          FROM events
          WHERE id=? AND session_id=?
            AND type='MessageAppended'
            AND json_extract(payload_json,'$.learningScan.version')=1`,
        args: [activityId, sessionId],
      });
      if (!rows[0]) throw new ValidationError(`Learning activity not found: ${activityId}`);
      return learningScanActivity(rows[0] as Record<string, unknown>);
    }
    const review = await this.get(activityId);
    if (review.sessionId !== sessionId) {
      throw new ValidationError("Learning activity belongs to another session");
    }
    return this.#learningReview(review);
  }

  async #assertSessionBranch(sessionId: string, branchId: string): Promise<void> {
    const rows = await this.storage.readonlyQuery({
      sql: "SELECT 1 FROM branches WHERE session_id=? AND branch_id=? LIMIT 1",
      args: [sessionId, branchId],
    });
    if (!rows[0]) {
      throw new ValidationError("Learning route requires an existing session branch");
    }
  }

  async #learningReview(
    review: RefinementReviewRecord,
  ): Promise<LearningReviewActivity> {
    let governed: GovernedRefinementRecord | null = null;
    let rollback: GovernedRefinementRollbackRecord | null = null;
    if (review.proposalId && this.#governance) {
      governed = await this.#governance.get(review.proposalId);
      rollback = await this.#governance.governedRollback(review.proposalId);
    }
    const governance = governed ? learningGovernanceSummary(governed) : null;
    return {
      kind: "review",
      activityId: review.reviewId,
      effectiveStatus: rollback
        ? "rolled_back"
        : governed?.status ?? review.status,
      review: learningReviewSummary(review, governed?.status ?? null),
      governance,
      rollback,
      createdAt: review.createdAt,
      updatedAt: rollback?.createdAt ?? governed?.updatedAt ?? review.updatedAt,
    };
  }

  async #withGovernedResult(record: RefinementReviewRecord): Promise<RefinementReviewRecord> {
    if (!record.proposalId || !this.#governance) return record;
    try {
      const governed = await this.#governance.get(record.proposalId);
      return {
        ...record,
        governedStatus: governed.status,
        governedResult: {
          proposalId: governed.proposalId,
          status: governed.status,
          reviewDecisionId: governed.reviewDecisionId,
          reason: governed.terminalReason,
          appliedVersionIds: [...governed.appliedVersionIds],
          ...(governed.decision === null ? {} : { decision: governed.decision as unknown as JsonValue }),
        },
      };
    } catch {
      return record;
    }
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

  async #admitAutomatic(
    trigger: RefinementDetectedTrigger,
    automaticPolicyGeneration: string,
  ): Promise<RefinementReviewRecord | null> {
    return this.#queue.run(`trigger:${trigger.nonterminalKey}`, async () => {
      const existing = await this.#existingAutomaticReview(
        trigger.sessionId,
        trigger.branchId,
        trigger.key,
        trigger.nonterminalKey,
        trigger.evidenceThroughCursor,
      );
      if (existing) return existing;
      const trajectoryTrigger: RefinementTrajectoryTriggerInput =
        trigger.kind === "repeated_effect_failure" ||
          trigger.kind === "repeated_cell_failure" ||
          trigger.kind === "repeated_gate_failure"
          ? { kind: trigger.kind, failureEventIds: trigger.evidenceEventIds }
          : trigger.kind === "repeated_success"
            ? { kind: trigger.kind, successEventIds: trigger.evidenceEventIds }
          : { kind: trigger.kind, correctionEventIds: trigger.evidenceEventIds };
      try {
        return await this.#admit(trigger.sessionId, trigger.branchId, {
          mode: "automatic", wait: false, requestedScope: "local", allowedKinds: ALLOWED_KINDS,
          trigger: { kind: trigger.kind, summary: trigger.summary, evidenceEventIds: trigger.evidenceEventIds }, trajectoryTrigger,
          triggerKey: trigger.key, nonterminalKey: trigger.nonterminalKey, triggerEvidenceThroughCursor: trigger.evidenceThroughCursor,
          automaticPolicyGeneration,
        });
      } catch (error) {
        if (error instanceof AutomaticAdmissionSuppressed) return null;
        const retained = await this.#existingAutomaticReview(
          trigger.sessionId,
          trigger.branchId,
          trigger.key,
          trigger.nonterminalKey,
          trigger.evidenceThroughCursor,
        );
        if (retained) return retained;
        throw error;
      }
    });
  }

  async #existingAutomaticReview(
    sessionId: string,
    branchId: string,
    triggerKey: string,
    nonterminalKey: string,
    evidenceThroughCursor: string,
  ): Promise<RefinementReviewRecord | null> {
    const rows = await this.storage.readonlyQuery({
      sql: `SELECT review_id FROM refinement_reviews
        WHERE session_id=? AND branch_id=? AND nonterminal_key=?
          AND status IN ('requested','running')
        UNION ALL
        SELECT review_id FROM refinement_trigger_consumptions
        WHERE session_id=? AND branch_id=? AND trigger_key=?
          AND CAST(last_consumed_evidence_cursor AS INTEGER)>=CAST(? AS INTEGER)
        LIMIT 1`,
      args: [
        sessionId,
        branchId,
        nonterminalKey,
        sessionId,
        branchId,
        triggerKey,
        evidenceThroughCursor,
      ],
    });
    return rows[0] ? this.get(String((rows[0] as Record<string, unknown>).review_id)) : null;
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
    const waitForGovernance = input.mode !== "automatic" && input.wait !== false;
    const existingRows = await this.storage.readonlyQuery({
      sql: `SELECT * FROM refinement_reviews WHERE review_id=?${input.nonterminalKey === undefined ? "" : " OR (session_id=? AND branch_id=? AND nonterminal_key=? AND status IN ('requested','running'))"} ORDER BY CASE WHEN review_id=? THEN 0 ELSE 1 END LIMIT 1`,
      args: input.nonterminalKey === undefined ? [request.reviewId, request.reviewId] : [request.reviewId, sessionId, branchId, input.nonterminalKey, request.reviewId],
    });
    if (!existingRows[0] && input.automaticPolicyGeneration !== undefined) {
      const current = await this.#automaticPolicyState();
      if (!current.policy.automatic ||
          current.generation !== input.automaticPolicyGeneration) {
        throw new AutomaticAdmissionSuppressed();
      }
    }
    if (!existingRows[0]) await this.storage.appendEvents([{
      sessionId, branchId, type: "RefinementReviewRequested", producer: input.mode === "manual" ? "client" : "supervisor",
      idempotencyKey: `refinement-review-requested:${request.reviewId}`,
      payload: {
        reviewId: request.reviewId, fingerprint: request.fingerprint, mode: request.mode, waitForGovernance, requestedScope: request.requestedScope,
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
        const handle = await this.startStructuredRefinementModel(
          record.sessionId,
          record.branchId,
          {
          prompt: refinerPrompt(request), input: { request: source.request, snapshot: source.snapshot },
          idempotencyKey: `refinement-review:${record.reviewId}`, run: true,
          },
        );
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
      const request = (await this.#requestEvent(record)).request as unknown as RefinementReviewRequest;
      const structured = validateRefinementReviewRecursiveResult(result.value);
      const decision = validateRefinementReviewValue(
        structured.submission,
        request,
        { brokeredCredentialValues: knownSecretValues() },
        structured.transportInputBytes,
      );
      if (decision.status === "no_change") {
        await this.#terminal(record, "no_change", { decisionFingerprint: decision.decisionFingerprint, reason: decision.reason }); return;
      }
      if (!this.#governance) throw new ValidationError("Automated refinement governance is unavailable");
      const targetKind = decision.edits[0]!.operation === "create"
        ? decision.edits[0]!.kind
        : (await this.harness.get(decision.edits[0]!.entryId))?.kind;
      if (!targetKind || decision.edits.some((edit) =>
        edit.operation === "create" ? edit.kind !== targetKind : false)) {
        throw new ValidationError("Trajectory proposal must target one harness kind");
      }
      const governanceInput = {
        target: { kind: "harness" as const, harnessKind: targetKind, edits: decision.edits },
        reason: decision.trigger,
        predictedEffect: decision.predictedEffect,
        evidenceEventIds: decision.evidenceEventIds,
        evaluation: decision.evaluation,
        triggerId: record.triggerId,
        clientRequestId: record.reviewId,
        wait: record.waitForGovernance,
      };
      const governed = record.mode === "automatic"
        ? await this.#governance.proposeAutomatic(
            record.sessionId,
            record.branchId,
            governanceInput,
          )
        : await this.#governance.proposeAgent(
            record.sessionId,
            record.branchId,
            governanceInput,
          );
      await this.#terminal(record, "candidate", {
        proposalId: governed.proposalId,
        decisionFingerprint: decision.decisionFingerprint,
        reason: `Governed proposal ${governed.status}: ${governed.terminalReason ?? "separate sealed review retained"}`,
      });
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
      events: events.map((event) => ({
        id: event.id,
        sessionId: event.sessionId,
        branchId: event.branchId,
        cursor: event.cursor,
        type: event.type,
        payload: refinementVisibleEventPayload(
          event.type,
          event.payload as unknown as JsonValue,
        ),
      })),
      trigger, visibleHarnessVersions, memory, evaluationHistory, requestedScope, requestedScopeKey, allowedKinds,
    }, { brokeredCredentialValues: knownSecretValues() });
  }
}

function normalizeReviewInput(input: StartRefinementReviewInput): StartRefinementReviewInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("Refinement review input must be an object");
  const allowedFields = new Set(["instructions", "requestedScope", "allowedKinds", "wait"]);
  const unknownFields = Object.keys(input).filter((field) => !allowedFields.has(field));
  if (unknownFields.length > 0) throw new ValidationError(`Refinement review input contains unknown fields: ${unknownFields.sort().join(", ")}`);
  if (input.instructions !== undefined && typeof input.instructions !== "string") throw new ValidationError("Refinement instructions must be a string");
  if (input.requestedScope !== undefined && !ALLOWED_SCOPE_SET.has(input.requestedScope)) throw new ValidationError("Requested refinement scope is invalid");
  if (input.wait !== undefined && typeof input.wait !== "boolean") throw new ValidationError("Refinement wait must be boolean");
  if (input.allowedKinds !== undefined) {
    if (!Array.isArray(input.allowedKinds) || input.allowedKinds.length === 0 || input.allowedKinds.length > ALLOWED_KINDS.length || new Set(input.allowedKinds).size !== input.allowedKinds.length || input.allowedKinds.some((kind) => !ALLOWED_KIND_SET.has(kind))) {
      throw new ValidationError("Refinement allowedKinds must contain 1-4 distinct supported harness kinds");
    }
  }
  return {
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.requestedScope === undefined ? {} : { requestedScope: input.requestedScope }),
    ...(input.allowedKinds === undefined ? {} : { allowedKinds: [...input.allowedKinds] }),
    ...(input.wait === undefined ? {} : { wait: input.wait }),
  };
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
  const candidates = brokeredSecretValues()
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
    reviewId: String(row.review_id), sessionId: String(row.session_id), branchId: String(row.branch_id), fingerprint: String(row.fingerprint), mode: String(row.mode) as RefinementReviewRecord["mode"], waitForGovernance: Number(row.governance_wait ?? 1) === 1, requestedScope: String(row.requested_scope) as HarnessScope, requestedScopeKey: String(row.requested_scope_key), allowedKinds: parseJson(row.allowed_kinds_json, []), triggerId: String(row.trigger_id), triggerKind: String(row.trigger_kind), triggerFingerprint: String(row.trigger_fingerprint), triggerKey: row.trigger_key === null ? null : String(row.trigger_key), nonterminalKey: row.nonterminal_key === null ? null : String(row.nonterminal_key), triggerEvidenceThroughCursor: row.trigger_evidence_through_cursor === null ? null : String(row.trigger_evidence_through_cursor), evidenceEventIds: parseJson(row.evidence_event_ids_json, []), sourceEventIds: parseJson(row.source_event_ids_json, []), sourceSnapshotHash: String(row.source_snapshot_hash), sourceThroughCursor: String(row.source_through_cursor), instructions: row.instructions === null ? null : String(row.instructions), status: String(row.status) as RefinementReviewLifecycleStatus, handleId: row.handle_id === null ? null : String(row.handle_id), childSessionId: row.child_session_id === null ? null : String(row.child_session_id), childBranchId: row.child_branch_id === null ? null : String(row.child_branch_id), decisionFingerprint: row.decision_fingerprint === null ? null : String(row.decision_fingerprint), proposalId: row.proposal_id === null ? null : String(row.proposal_id), reason: row.reason === null ? null : String(row.reason), governedStatus: null, governedResult: null, createdEventId: String(row.created_event_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function learningGovernanceSummary(
  record: GovernedRefinementRecord,
): LearningGovernanceSummary {
  return {
    proposalId: record.proposalId,
    status: record.status,
    targetKind: record.proposal.target.kind,
    harnessKind: record.proposal.target.kind === "harness"
      ? record.proposal.target.harnessKind
      : null,
    editCount: record.proposal.target.kind === "harness"
      ? record.proposal.target.edits.length
      : 1,
    decision: learningDecisionSummary(record.decision),
    appliedVersionIds: [...record.appliedVersionIds],
    terminalReason: record.terminalReason === null
      ? null
      : boundedUtf8(record.terminalReason, 4096),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function learningDecisionSummary(
  decision: RefinementGovernanceDecision | null,
): RefinementGovernanceDecision | null {
  if (decision === null) return null;
  if (decision.decision === "approve") {
    return {
      decision: "approve",
      proposalId: decision.proposalId,
      reason: boundedUtf8(decision.reason, 2048),
      satisfiedCriteria: decision.satisfiedCriteria.slice(0, 8)
        .map((value) => boundedUtf8(value, 256)),
      residualRisks: decision.residualRisks.slice(0, 8)
        .map((value) => boundedUtf8(value, 256)),
    };
  }
  return {
    decision: "reject",
    proposalId: decision.proposalId,
    reason: boundedUtf8(decision.reason, 2048),
    violatedCriteria: decision.violatedCriteria.slice(0, 8)
      .map((value) => boundedUtf8(value, 256)),
    ...(decision.revisionGuidance === undefined
      ? {}
      : { revisionGuidance: boundedUtf8(decision.revisionGuidance, 2048) }),
  };
}

function learningReviewSummary(
  review: RefinementReviewRecord,
  governedStatus: GovernedRefinementStatus | null,
): LearningReviewSummary {
  const {
    sourceEventIds,
    governedResult: _governedResult,
    instructions,
    reason,
    ...rest
  } = review;
  return {
    ...rest,
    governedStatus,
    sourceEventIds: sourceEventIds.slice(0, LEARNING_HISTORY_SOURCE_IDS),
    sourceEventCount: sourceEventIds.length,
    sourceEventIdsTruncated: sourceEventIds.length >
      LEARNING_HISTORY_SOURCE_IDS,
    instructions: instructions === null ? null : boundedUtf8(instructions, 2048),
    reason: reason === null ? null : boundedUtf8(reason, 4096),
  };
}

function learningScanActivity(
  row: Record<string, unknown>,
): LearningScanActivity {
  const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
  const message = String(payload.content ?? "");
  const learningScan = payload.learningScan as
    | { version?: unknown; category?: unknown }
    | undefined;
  if (learningScan?.version !== 1 ||
      (learningScan.category !== "validation_failed" &&
        learningScan.category !== "scan_unavailable")) {
    throw new ValidationError("Learning scan observation payload is malformed");
  }
  const category = learningScan.category;
  const createdAt = String(row.committed_at);
  return {
    kind: "scan_observation",
    activityId: String(row.id),
    effectiveStatus: category,
    sessionId: String(row.session_id),
    branchId: String(row.branch_id),
    message,
    createdAt,
    updatedAt: createdAt,
  };
}

function jsonUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

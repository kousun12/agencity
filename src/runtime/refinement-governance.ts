import {
  PRODUCT_CONSTITUTION,
  PRODUCT_CONSTITUTION_REFERENCE,
  REFINEMENT_GOVERNANCE_CONTRACT_ID,
  REFINEMENT_GOVERNANCE_POLICY,
  REFINEMENT_GOVERNANCE_POLICY_REFERENCE,
  SEALED_GOVERNANCE_REVIEWER_PROFILE,
  SEALED_GOVERNANCE_REVIEWER_LIMITS,
  SEALED_GOVERNANCE_REVIEW_WAIT_TIMEOUT_MS,
  ConflictError,
  ValidationError,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  newId,
  normalizeAgentProfileInput,
  projectEvents,
  refinementPrincipalToAgentPrincipal,
  renderExactAgentPrompt,
  validateRefinementGovernanceRecursiveResult,
  type GovernedRefinementProposal,
  type GovernedRefinementRecord,
  type GovernedRefinementStatus,
  type JsonValue,
  type RefinementGovernanceDecision,
  type RefinementProposalPrincipal,
  type RefinementRollbackResult,
  type RefinementTarget,
  type RollbackRefinementInput,
} from "../domain/index.ts";
import { containsBrokeredSecret, scrubJson, scrubText } from "../security/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import type { AgentProfileService } from "./agent-profiles.ts";
import type { HarnessService } from "./harness.ts";
import {
  internalGovernedAgentProfilePreparer,
  type GovernedAgentProfilePreparer,
  type StructuredRefinementGovernanceStarter,
} from "./internal.ts";
import type { ModelEffectAdmissionService } from "./model-effect-admission.ts";
import type { PublicRecursiveModelService } from "./models.ts";

const TERMINAL = new Set<GovernedRefinementStatus>([
  "deterministically_rejected", "reviewed_rejected", "review_failed",
  "review_unknown", "apply_conflict", "apply_failed", "applied",
]);
const MAX_REASON_BYTES = 4 * 1024;
const MAX_EVIDENCE = 32;
const MAX_PENDING_PER_SESSION = 4;
const MAX_PROPOSALS_PER_HOUR = 12;
const RECOVERY_PAGE_SIZE = 200;

export interface SubmitGovernedRefinementInput {
  readonly target: RefinementTarget;
  readonly reason: string;
  readonly predictedEffect: string;
  readonly evidenceEventIds: readonly string[];
  readonly revisesProposalId?: string;
  readonly originRunId?: string;
  readonly originTaskId?: string;
  readonly triggerId?: string;
  readonly clientRequestId?: string;
  readonly wait?: boolean;
}

class GovernanceQueue {
  readonly #tails = new Map<string, Promise<void>>();
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.catch(() => {}).then(() => current);
    this.#tails.set(key, tail);
    await prior.catch(() => {});
    try { return await operation(); }
    finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

export class RefinementGovernanceService {
  readonly #queue = new GovernanceQueue();
  readonly #jobs = new Map<string, Promise<void>>();
  readonly #prepareApprovedProfile: GovernedAgentProfilePreparer;

  constructor(
    readonly storage: AgentStorage,
    private readonly models: PublicRecursiveModelService,
    private readonly startGovernanceModel: StructuredRefinementGovernanceStarter,
    readonly profiles: AgentProfileService,
    readonly harness: HarnessService,
    readonly modelAdmission: ModelEffectAdmissionService,
    readonly ownerProfileId: string,
  ) {
    this.#prepareApprovedProfile = internalGovernedAgentProfilePreparer(profiles);
  }

  proposeOwner(
    originSessionId: string,
    originBranchId: string,
    input: SubmitGovernedRefinementInput,
  ): Promise<GovernedRefinementRecord> {
    return this.#admit(
      originSessionId,
      originBranchId,
      { kind: "owner", profileId: this.ownerProfileId },
      input,
    );
  }

  proposeAgent(
    originSessionId: string,
    originBranchId: string,
    input: SubmitGovernedRefinementInput,
  ): Promise<GovernedRefinementRecord> {
    return this.#admit(
      originSessionId,
      originBranchId,
      { kind: "agent", sessionId: originSessionId, branchId: originBranchId },
      input,
    );
  }

  proposeAutomatic(
    originSessionId: string,
    originBranchId: string,
    input: SubmitGovernedRefinementInput,
  ): Promise<GovernedRefinementRecord> {
    return this.#admit(originSessionId, originBranchId, {
      kind: "automatic_refiner",
      componentId: "agencity.trajectory-refiner",
      version: 1,
      sessionId: originSessionId,
      branchId: originBranchId,
    }, { ...input, wait: false });
  }

  async get(proposalId: string): Promise<GovernedRefinementRecord> {
    const rows = await this.storage.readonlyQuery({
      sql: "SELECT * FROM governed_refinement_proposals WHERE proposal_id=?",
      args: [proposalId],
    });
    if (!rows[0]) throw new ValidationError(`Governed refinement not found: ${proposalId}`);
    return rowToRecord(rows[0] as Record<string, unknown>);
  }

  async list(input: {
    readonly sessionId?: string;
    readonly branchId?: string;
    readonly status?: GovernedRefinementStatus;
    readonly limit?: number;
  } = {}): Promise<GovernedRefinementRecord[]> {
    if (input.branchId !== undefined && input.sessionId === undefined) {
      throw new ValidationError("A branch filter requires sessionId");
    }
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new ValidationError("Refinement history limit must be 1-200");
    }
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (input.sessionId) { where.push("session_id=?"); args.push(input.sessionId); }
    if (input.branchId) { where.push("branch_id=?"); args.push(input.branchId); }
    if (input.status) { where.push("status=?"); args.push(input.status); }
    args.push(limit);
    return (await this.storage.readonlyQuery({
      sql: `SELECT * FROM governed_refinement_proposals${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC,proposal_id DESC LIMIT ?`,
      args,
    })).map((row) => rowToRecord(row as Record<string, unknown>));
  }

  async wait(proposalId: string): Promise<GovernedRefinementRecord> {
    await this.#queue.run(proposalId, () => this.#advance(proposalId));
    return this.get(proposalId);
  }

  async recoverIncomplete(): Promise<number> {
    let count = 0;
    let afterCreatedAt = "";
    let afterProposalId = "";
    while (true) {
      const rows = await this.storage.readonlyQuery({
        sql: `SELECT * FROM governed_refinement_proposals
          WHERE (
            status IN ('proposed','validated','reviewing','reviewed_approved')
            OR (terminal_notice_event_id IS NULL AND status IN (
              'deterministically_rejected','reviewed_rejected','review_failed',
              'review_unknown','apply_conflict','apply_failed','applied'
            ))
          )
          AND (created_at>? OR (created_at=? AND proposal_id>?))
          ORDER BY created_at,proposal_id LIMIT ?`,
        args: [afterCreatedAt, afterCreatedAt, afterProposalId, RECOVERY_PAGE_SIZE],
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        const record = rowToRecord(row as Record<string, unknown>);
        if (!TERMINAL.has(record.status)) {
          this.#launch(record.proposalId);
          count++;
        } else if (!record.noticeDelivered) {
          await this.#deliver(record);
        }
        afterCreatedAt = record.createdAt;
        afterProposalId = record.proposalId;
      }
      if (rows.length < RECOVERY_PAGE_SIZE) break;
    }
    return count;
  }

  async rollbackOwner(
    originSessionId: string,
    originBranchId: string,
    input: RollbackRefinementInput,
  ): Promise<RefinementRollbackResult> {
    return this.#rollback(
      originSessionId,
      originBranchId,
      { kind: "owner", profileId: this.ownerProfileId },
      input,
    );
  }

  async rollbackAgent(
    originSessionId: string,
    originBranchId: string,
    input: RollbackRefinementInput,
  ): Promise<RefinementRollbackResult> {
    return this.#rollback(
      originSessionId,
      originBranchId,
      { kind: "agent", sessionId: originSessionId, branchId: originBranchId },
      input,
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#jobs.values()]);
  }

  async #admit(
    originSessionId: string,
    originBranchId: string,
    principal: RefinementProposalPrincipal,
    input: SubmitGovernedRefinementInput,
  ): Promise<GovernedRefinementRecord> {
    if (input.clientRequestId !== undefined) {
      normalizeBounded(input.clientRequestId, "Refinement clientRequestId", 256);
    }
    const stableRequestKey = input.clientRequestId !== undefined
      ? `client:${input.clientRequestId}`
      : input.triggerId !== undefined
        ? `trigger:${input.triggerId}`
        : null;
    const proposalId = stableRequestKey === null
      ? newId()
      : stableId("governed-refinement-proposal", canonicalJsonDigest({
          principal,
          originSessionId,
          originBranchId,
          stableRequestKey,
          revisesProposalId: input.revisesProposalId ?? null,
        } as unknown as JsonValue));
    const rawProposal: GovernedRefinementProposal = {
      proposalId,
      target: input.target,
      principal,
      origin: {
        sessionId: originSessionId,
        branchId: originBranchId,
        ...(input.originRunId ? { runId: input.originRunId } : {}),
        ...(input.originTaskId ? { taskId: input.originTaskId } : {}),
        ...(input.triggerId ? { triggerId: input.triggerId } : {}),
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      },
      reason: normalizeBounded(input.reason, "Refinement reason", MAX_REASON_BYTES),
      predictedEffect: normalizeBounded(input.predictedEffect, "Predicted effect", MAX_REASON_BYTES),
      evidenceEventIds: [...new Set(input.evidenceEventIds)],
      ...(input.revisesProposalId ? { revisesProposalId: input.revisesProposalId } : {}),
    };
    const secretRejected = containsBrokeredSecret(rawProposal as unknown as JsonValue);
    const proposal = (secretRejected
      ? scrubJson(rawProposal as unknown as JsonValue)
      : rawProposal) as unknown as GovernedRefinementProposal;
    const fingerprint = canonicalJsonDigest(proposal as unknown as JsonValue);
    const existingRows = await this.storage.readonlyQuery({
      sql: "SELECT * FROM governed_refinement_proposals WHERE proposal_id=?",
      args: [proposalId],
    });
    if (existingRows[0]) {
      const existing = rowToRecord(existingRows[0] as Record<string, unknown>);
      if (canonicalJsonDigest(existing.proposal as unknown as JsonValue) !== fingerprint) {
        throw new ConflictError("Stable refinement proposal identity was reused with different meaning");
      }
      if (input.wait === false || TERMINAL.has(existing.status)) return existing;
      if (existing.status === "proposed") {
        const admitted = await this.#waitForAdmission(proposalId);
        if (TERMINAL.has(admitted.status)) return admitted;
      }
      return this.wait(proposalId);
    }
    await this.storage.appendEvents([{
      sessionId: originSessionId,
      branchId: originBranchId,
      type: "GovernedRefinementProposed",
      producer: principal.kind === "owner" ? "client" : "supervisor",
      idempotencyKey: `governed-refinement-proposed:${proposalId}`,
      payload: {
        proposalId,
        proposalFingerprint: fingerprint,
        proposal: proposal as unknown as JsonValue,
      },
    }]);
    const retained = await this.get(proposalId);
    if (canonicalJsonDigest(retained.proposal as unknown as JsonValue) !== fingerprint) {
      throw new ConflictError("Stable refinement proposal identity was reused with different meaning");
    }
    const validation = secretRejected ? {
      valid: false as const,
      reason: "Brokered credentials cannot enter a refinement proposal",
      checks: ["known-secret-rejection"],
    } : await this.#validate(proposal).catch((error) => ({
      valid: false,
      reason: scrubText(error instanceof Error ? error.message : String(error)),
      checks: ["deterministic-validation-failed"],
    }));
    await this.storage.appendEvents([{
      sessionId: originSessionId,
      branchId: originBranchId,
      type: "GovernedRefinementValidated",
      producer: "supervisor",
      idempotencyKey: `governed-refinement-validated:${proposalId}`,
      payload: {
        proposalId,
        valid: validation.valid,
        validation: validation as unknown as JsonValue,
        expectedStatus: "proposed",
      },
    }]);
    let record = await this.get(proposalId);
    if (!validation.valid) {
      await this.#deliver(record);
      return this.get(proposalId);
    }
    if (input.wait === false) this.#launch(proposalId);
    else await this.#queue.run(proposalId, () => this.#advance(proposalId));
    record = await this.get(proposalId);
    return record;
  }

  async #validate(proposal: GovernedRefinementProposal): Promise<{
    valid: true;
    reason: string;
    checks: string[];
  }> {
    if (proposal.evidenceEventIds.length > MAX_EVIDENCE) {
      throw new ValidationError(`Refinement evidence exceeds ${MAX_EVIDENCE} events`);
    }
    if (containsBrokeredSecret(proposal as unknown as JsonValue)) {
      throw new ValidationError("Brokered credentials cannot enter a refinement proposal");
    }
    const events = await this.storage.loadEvents(proposal.origin.sessionId, {
      branchId: proposal.origin.branchId,
    });
    if (!events.length) throw new ValidationError("Refinement origin route does not exist");
    const visible = new Set(events.map((event) => event.id));
    for (const eventId of proposal.evidenceEventIds) {
      if (!visible.has(eventId)) throw new ValidationError("Refinement evidence is outside the proposer-visible route");
    }
    await this.#assertRateBounds(proposal.origin.sessionId);
    const relationship = await this.#relationship(proposal);
    if (proposal.target.kind === "agent_profile") {
      assertExactKeys(
        proposal.target as unknown as Record<string, unknown>,
        ["kind", "agentSessionId", "expectedProfileVersionId", "replacement"],
        "Agent profile refinement target",
      );
      assertExactKeys(
        proposal.target.replacement as unknown as Record<string, unknown>,
        ["role", "purpose", "instructions"],
        "Agent profile replacement",
      );
      normalizeAgentProfileInput(proposal.target.replacement);
      renderExactAgentPrompt(proposal.target.replacement);
      if (/\b(?:ignore|override|disable|weaken|expand|change)\b.{0,80}\b(?:base policy|product constitution|review policy|permission boundary|safety policy|runtime authority|review contract)\b/i.test(
        `${proposal.target.replacement.role}\n${proposal.target.replacement.purpose}\n${proposal.target.replacement.instructions}`,
      )) {
        throw new ValidationError("Agent profile content cannot modify immutable policy or runtime authority");
      }
      const active = await this.profiles.active(proposal.target.agentSessionId);
      if (active.profileVersionId !== proposal.target.expectedProfileVersionId) {
        throw new ValidationError("Stale expected active agent profile version");
      }
      if (active.role === proposal.target.replacement.role.trim() &&
          active.purpose === proposal.target.replacement.purpose.trim() &&
          active.instructions === proposal.target.replacement.instructions.trim()) {
        throw new ValidationError("Profile proposal must make a substantive change");
      }
    } else {
      const target = proposal.target;
      if (!target.edits.length || target.edits.length > 16 ||
          target.edits.some((edit) =>
            edit.operation === "create"
              ? edit.kind !== target.harnessKind
              : false)) {
        throw new ValidationError("Harness proposal target is malformed or over-broad");
      }
      for (const [editIndex, edit] of target.edits.entries()) {
        if (edit.operation === "create") continue;
        const entry = await this.harness.get(edit.entryId);
        if (!entry) throw new ValidationError(`Missing harness entry ${edit.entryId}`);
        if (entry.kind !== target.harnessKind) {
          throw new ValidationError(`Harness target kind mismatch for ${edit.entryId}`);
        }
        const stagedVersion = await this.harness.getVersion(
          stableId("version", `governed:${proposal.proposalId}:${editIndex}`),
        );
        const recognizedStage = stagedVersion?.proposalId === proposal.proposalId &&
          stagedVersion.entryId === edit.entryId &&
          stagedVersion.kind === target.harnessKind;
        if (entry.currentVersionId !== edit.expectedVersionId && !recognizedStage) {
          throw new ValidationError(`Stale expectedVersionId for ${edit.entryId}`);
        }
      }
      if (proposal.principal.kind === "automatic_refiner") {
        for (const edit of target.edits) {
          if (edit.operation === "create") {
            if (edit.scope !== "local" ||
                (edit.scopeKey !== undefined && edit.scopeKey !== proposal.origin.sessionId)) {
              throw new ValidationError("Automatic refiner harness targets must remain local to the origin session");
            }
          } else {
            const entry = await this.harness.get(edit.entryId);
            if (!entry || entry.scope !== "local" ||
                entry.scopeKey !== proposal.origin.sessionId) {
              throw new ValidationError("Automatic refiner harness targets must remain local to the origin session");
            }
          }
        }
      }
    }
    if (proposal.revisesProposalId) {
      const previous = await this.get(proposal.revisesProposalId);
      if (!["deterministically_rejected", "reviewed_rejected"].includes(previous.status)) {
        throw new ValidationError("A revised proposal must reference a rejected proposal");
      }
      if (previous.proposal.revisesProposalId !== undefined) {
        throw new ValidationError("A revised proposal must reference the original rejected proposal");
      }
      if (!Bun.deepEquals(previous.proposal.principal, proposal.principal) ||
          !sameRevisionOrigin(previous.proposal, proposal) ||
          !Bun.deepEquals(refinementTargetIdentity(previous.proposal.target), refinementTargetIdentity(proposal.target))) {
        throw new ValidationError("A revised proposal must remain in the original principal, trigger, and target chain");
      }
      const priorComparable = {
        target: previous.proposal.target,
        evidenceEventIds: previous.proposal.evidenceEventIds,
        reason: previous.proposal.reason,
        predictedEffect: previous.proposal.predictedEffect,
      };
      const nextComparable = {
        target: proposal.target,
        evidenceEventIds: proposal.evidenceEventIds,
        reason: proposal.reason,
        predictedEffect: proposal.predictedEffect,
      };
      if (canonicalJsonDigest(priorComparable as unknown as JsonValue) ===
          canonicalJsonDigest(nextComparable as unknown as JsonValue)) {
        throw new ValidationError("A revised proposal requires substantive content or evidence change");
      }
      if (proposal.principal.kind === "automatic_refiner") {
        const rows = await this.storage.readonlyQuery({
          sql: "SELECT count(*) AS count FROM governed_refinement_proposals WHERE json_extract(proposal_json,'$.revisesProposalId')=?",
          args: [proposal.revisesProposalId],
        });
        if (Number((rows[0] as any)?.count ?? 0) > 1) {
          throw new ValidationError("Automatic reproposal limit is exhausted");
        }
      }
    }
    return {
      valid: true,
      reason: "Deterministic schema, authority, evidence, scope, secret, rendering, CAS, and bound checks passed",
      checks: [
        relationship, "schema", "utf8-bounds", "known-secret-rejection",
        "evidence-visibility", "compare-and-swap", "runtime-boundaries",
        "substantive-change", "rate-and-concurrency-bounds",
      ],
    };
  }

  async #waitForAdmission(proposalId: string): Promise<GovernedRefinementRecord> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const record = await this.get(proposalId);
      if (record.status !== "proposed") return record;
      await Bun.sleep(5);
    }
    throw new ConflictError("Stable refinement proposal admission did not reach validation");
  }

  async #advance(proposalId: string): Promise<void> {
    let record = await this.get(proposalId);
    if (TERMINAL.has(record.status)) {
      if (!record.noticeDelivered) await this.#deliver(record);
      return;
    }
    if (record.status === "reviewed_approved") {
      if (!record.reviewDecisionId) {
        throw new ValidationError("Approved governed refinement is missing its decision identity");
      }
      try {
        await this.#apply(record, record.reviewDecisionId);
      } catch (error) {
        if (!(error instanceof ValidationError) && !(error instanceof ConflictError)) throw error;
        await this.#terminalApply(
          record,
          applicationFailureStatus(error),
          [],
          scrubText(error.message),
        );
      }
      await this.#deliver(await this.get(proposalId));
      return;
    }
    try {
      if (record.status === "validated") {
        const frozen = await this.#freeze(record.proposal);
        const reviewId = stableId("refinement-governance-review", record.proposalId);
        if (record.frozenInput === null) {
          await this.storage.appendEvents([{
            sessionId: record.sessionId,
            branchId: record.branchId,
            type: "RefinementGovernanceReviewRequested",
            producer: "supervisor",
            idempotencyKey: `refinement-governance-review-requested:${proposalId}`,
            payload: {
              proposalId,
              reviewId,
              frozenInput: frozen as unknown as JsonValue,
              frozenInputDigest: frozen.canonicalDigest,
              expectedStatus: "validated",
            },
          }]);
          record = await this.get(proposalId);
        }
        if (record.reviewHandleId === null) {
          let handle;
          try {
            handle = await this.startGovernanceModel(record.sessionId, record.branchId, {
              prompt: governancePrompt(record.proposalId),
              input: record.frozenInput as unknown as JsonValue,
              model: (record.frozenInput!.reviewerDispatch as any).configuration,
              profile: SEALED_GOVERNANCE_REVIEWER_PROFILE,
              budget: SEALED_GOVERNANCE_REVIEWER_LIMITS,
              idempotencyKey: `refinement-governance:${proposalId}`,
              run: true,
            });
          } catch (error) {
            await this.#decideFailure(
              record,
              "review_failed",
              scrubText(error instanceof Error ? error.message : String(error)),
            );
            await this.#deliver(await this.get(proposalId));
            return;
          }
          await this.storage.appendEvents([{
            sessionId: record.sessionId,
            branchId: record.branchId,
            type: "RefinementGovernanceReviewChildLinked",
            producer: "supervisor",
            idempotencyKey: `refinement-governance-review-child:${proposalId}`,
            payload: {
              proposalId,
              reviewId,
              handleId: handle.handleId,
              childSessionId: handle.childSessionId,
              childBranchId: handle.childBranchId,
              expectedStatus: "validated",
            },
          }]);
          record = await this.get(proposalId);
        }
      }
      if (record.status !== "reviewing" || record.reviewHandleId === null) return;
      let result = await this.models.result(record.reviewHandleId, {
        wait: true,
        timeoutMs: SEALED_GOVERNANCE_REVIEW_WAIT_TIMEOUT_MS,
      });
      if (result.status === "pending" || result.status === "running") {
        await this.models.cancel(
          record.reviewHandleId,
          `Sealed governance reviewer exceeded ${SEALED_GOVERNANCE_REVIEW_WAIT_TIMEOUT_MS}ms`,
        );
        result = await this.models.result(record.reviewHandleId, { wait: false });
      }
      if (result.outcome !== "succeeded") {
        const status = result.outcome === "unknown" ? "review_unknown" : "review_failed";
        await this.#decideFailure(record, status, result.error ?? `Reviewer ended ${result.outcome}`);
        await this.#deliver(await this.get(proposalId));
        return;
      }
      const structured = validateRefinementGovernanceRecursiveResult(result.value, {
        proposalId,
      });
      const decision = structured.submission;
      const decisionId = stableId("refinement-governance-decision", `${proposalId}:${structured.submissionDigest}`);
      if (decision.decision === "reject") {
        await this.storage.appendEvents([{
          sessionId: record.sessionId,
          branchId: record.branchId,
          type: "RefinementGovernanceReviewDecided",
          producer: "supervisor",
          idempotencyKey: `refinement-governance-decision:${proposalId}`,
          payload: {
            proposalId,
            reviewId: stableId("refinement-governance-review", proposalId),
            decisionId,
            status: "reviewed_rejected",
            decision: decision as unknown as JsonValue,
            reason: decision.reason,
            expectedStatus: "reviewing",
          },
        }]);
        await this.#deliver(await this.get(proposalId));
        return;
      }
      const approvalEvent = {
        sessionId: record.sessionId,
        branchId: record.branchId,
        type: "RefinementGovernanceReviewDecided",
        producer: "supervisor",
        idempotencyKey: `refinement-governance-decision:${proposalId}`,
        payload: {
          proposalId,
          reviewId: stableId("refinement-governance-review", proposalId),
          decisionId,
          status: "reviewed_approved",
          decision: decision as unknown as JsonValue,
          reason: decision.reason,
          expectedStatus: "reviewing",
        },
      } as const;
      if (record.proposal.target.kind === "agent_profile") {
        let prepared;
        try {
          await this.#validate(record.proposal);
          const targetSessionId = record.proposal.target.agentSessionId;
          prepared = await this.#prepareApprovedProfile({
            targetSessionId,
            eventBranchId: await this.#initialBranch(targetSessionId),
            originSessionId: record.proposal.origin.sessionId,
            originBranchId: record.proposal.origin.branchId,
            expectedActiveProfileVersionId: record.proposal.target.expectedProfileVersionId,
            replacement: record.proposal.target.replacement,
            createdBy: refinementPrincipalToAgentPrincipal(record.proposal.principal),
            reason: record.proposal.reason,
            evidenceEventIds: record.proposal.evidenceEventIds,
            proposalId: record.proposalId,
            reviewDecisionId: decisionId,
          });
        } catch (error) {
          await this.#commitApprovalFailure(record, approvalEvent, decisionId, error);
          await this.#deliver(await this.get(proposalId));
          return;
        }
        try {
          await this.storage.appendEvents([
            approvalEvent,
            ...prepared.events,
            this.#applicationEvent(
              record,
              decisionId,
              "applied",
              [prepared.profile.profileVersionId],
              "Approved profile applied atomically after application-time revalidation",
            ),
          ]);
        } catch (error) {
          const after = await this.get(proposalId);
          if (!TERMINAL.has(after.status)) {
            await this.#commitApprovalFailure(record, approvalEvent, decisionId, error);
          }
        }
        await this.#deliver(await this.get(proposalId));
        return;
      }
      let prepared;
      try {
        await this.#validate(record.proposal);
        prepared = await this.harness.prepareGoverned(
          record.sessionId,
          record.branchId,
          record.proposalId,
          record.proposal.target.harnessKind,
          record.proposal.target.edits,
          record.proposal.evidenceEventIds,
          principalLabel(record.proposal.principal),
        );
      } catch (error) {
        await this.#commitApprovalFailure(record, approvalEvent, decisionId, error);
        await this.#deliver(await this.get(proposalId));
        return;
      }
      if (prepared.skillVersionIds.length === 0) {
        try {
          await this.storage.appendEvents([
            approvalEvent,
            ...prepared.creationEvents,
            ...prepared.finalEvents,
            this.#applicationEvent(
              record,
              decisionId,
              "applied",
              [...prepared.versionIds],
              "Approved harness proposal applied atomically after application-time revalidation",
            ),
          ]);
        } catch (error) {
          const after = await this.get(proposalId);
          if (!TERMINAL.has(after.status)) {
            await this.#commitApprovalFailure(record, approvalEvent, decisionId, error);
          }
        }
        await this.#deliver(await this.get(proposalId));
        return;
      }
      await this.storage.appendEvents([approvalEvent, ...prepared.creationEvents]);
      record = await this.get(proposalId);
      await this.#resumeSkillApplication(record);
      await this.#deliver(await this.get(proposalId));
    } catch (error) {
      record = await this.get(proposalId);
      if (TERMINAL.has(record.status)) {
        if (!record.noticeDelivered) await this.#deliver(record);
        return;
      }
      if (record.status === "reviewing") {
        await this.#decideFailure(
          record,
          "review_failed",
          scrubText(error instanceof Error ? error.message : String(error)),
        );
        await this.#deliver(await this.get(proposalId));
        return;
      }
      if (record.status === "validated") {
        if (record.frozenInput !== null) throw error;
        await this.#decideFailure(
          record,
          "review_failed",
          scrubText(error instanceof Error ? error.message : String(error)),
        );
        await this.#deliver(await this.get(proposalId));
        return;
      }
      if (record.status === "reviewed_approved") {
        if (record.proposal.target.kind === "harness" &&
            record.proposal.target.harnessKind === "skill" &&
            !(error instanceof ValidationError) &&
            !(error instanceof ConflictError)) {
          throw error;
        }
        const message = scrubText(error instanceof Error ? error.message : String(error));
        await this.#terminalApply(
          record,
          applicationFailureStatus(error),
          [],
          message,
        );
        await this.#deliver(await this.get(proposalId));
        return;
      }
      throw error;
    }
  }

  async #apply(record: GovernedRefinementRecord, decisionId: string): Promise<void> {
    await this.#validate(record.proposal);
    if (record.proposal.target.kind === "agent_profile") {
      throw new ValidationError("Profile application must use the atomic approval path");
    }
    const prepared = await this.harness.prepareGoverned(
      record.sessionId,
      record.branchId,
      record.proposalId,
      record.proposal.target.harnessKind,
      record.proposal.target.edits,
      record.proposal.evidenceEventIds,
      principalLabel(record.proposal.principal),
    );
    if (prepared.skillVersionIds.length === 0) {
      throw new ValidationError("Non-skill governed application cannot remain nonterminal after its atomic commit");
    }
    if (prepared.creationEvents.length > 0) {
      throw new ValidationError("Staged skill application is missing its atomically-created candidate version");
    }
    await this.#resumeSkillApplication(record);
  }

  async #resumeSkillApplication(record: GovernedRefinementRecord): Promise<void> {
    if (record.proposal.target.kind !== "harness" ||
        record.proposal.target.harnessKind !== "skill") {
      throw new ValidationError("Only governed skills use staged application recovery");
    }
    let prepared = await this.harness.prepareGoverned(
      record.sessionId,
      record.branchId,
      record.proposalId,
      record.proposal.target.harnessKind,
      record.proposal.target.edits,
      record.proposal.evidenceEventIds,
      principalLabel(record.proposal.principal),
    );
    if (prepared.creationEvents.length > 0) {
      throw new ValidationError("Staged skill application is missing its candidate boundary");
    }
    for (const versionId of prepared.skillVersionIds) {
      await this.harness.testGovernedSkill(
        record.sessionId,
        record.branchId,
        record.proposalId,
        versionId,
      );
    }
    prepared = await this.harness.prepareGoverned(
      record.sessionId,
      record.branchId,
      record.proposalId,
      record.proposal.target.harnessKind,
      record.proposal.target.edits,
      record.proposal.evidenceEventIds,
      principalLabel(record.proposal.principal),
    );
    if (prepared.finalEvents.length > 0) {
      await this.storage.appendEvents(prepared.finalEvents);
    }
    const refreshed = await this.harness.prepareGoverned(
      record.sessionId,
      record.branchId,
      record.proposalId,
      record.proposal.target.harnessKind,
      record.proposal.target.edits,
      record.proposal.evidenceEventIds,
      principalLabel(record.proposal.principal),
    );
    if (refreshed.creationEvents.length > 0 || refreshed.finalEvents.length > 0) {
      throw new ValidationError("Staged skill application did not converge after activation");
    }
    await this.#terminalApply(
      record,
      "applied",
      [...refreshed.versionIds],
      "Approved governed skills passed durable tests and activated",
    );
  }

  async #terminalApply(
    record: GovernedRefinementRecord,
    status: "applied" | "apply_conflict" | "apply_failed",
    versionIds: string[],
    reason: string,
  ): Promise<void> {
    await this.storage.appendEvents([{
      sessionId: record.sessionId,
      branchId: record.branchId,
      type: "GovernedRefinementApplied",
      producer: "supervisor",
      idempotencyKey: `governed-refinement-applied:${record.proposalId}`,
      payload: {
        proposalId: record.proposalId,
        decisionId: record.reviewDecisionId!,
        status,
        appliedVersionIds: versionIds,
        reason: bounded(reason, 16 * 1024),
        expectedStatus: "reviewed_approved",
      },
    }]);
  }

  #applicationEvent(
    record: GovernedRefinementRecord,
    decisionId: string,
    status: "applied" | "apply_conflict" | "apply_failed",
    versionIds: string[],
    reason: string,
  ) {
    return {
      sessionId: record.sessionId,
      branchId: record.branchId,
      type: "GovernedRefinementApplied" as const,
      producer: "supervisor",
      idempotencyKey: `governed-refinement-applied:${record.proposalId}`,
      payload: {
        proposalId: record.proposalId,
        decisionId,
        status,
        appliedVersionIds: versionIds,
        reason: bounded(reason, 16 * 1024),
        expectedStatus: "reviewed_approved" as const,
      },
    };
  }

  async #commitApprovalFailure(
    record: GovernedRefinementRecord,
    approvalEvent: any,
    decisionId: string,
    error: unknown,
  ): Promise<void> {
    await this.storage.appendEvents([
      approvalEvent,
      this.#applicationEvent(
        record,
        decisionId,
        applicationFailureStatus(error),
        [],
        scrubText(error instanceof Error ? error.message : String(error)),
      ),
    ]);
  }

  async #decideFailure(
    record: GovernedRefinementRecord,
    status: "review_failed" | "review_unknown",
    reason: string,
  ): Promise<void> {
    const decisionId = stableId("refinement-governance-decision", `${record.proposalId}:${status}`);
    await this.storage.appendEvents([{
      sessionId: record.sessionId,
      branchId: record.branchId,
      type: "RefinementGovernanceReviewDecided",
      producer: "supervisor",
      idempotencyKey: `refinement-governance-decision:${record.proposalId}`,
      payload: {
        proposalId: record.proposalId,
        reviewId: stableId("refinement-governance-review", record.proposalId),
        decisionId,
        status,
        reason: bounded(reason, 16 * 1024),
        expectedStatus: record.status === "validated" ? "validated" : "reviewing",
      },
    }]);
  }

  async #deliver(record: GovernedRefinementRecord): Promise<void> {
    if (record.noticeDelivered || !TERMINAL.has(record.status)) return;
    const result: JsonValue = {
      proposalId: record.proposalId,
      status: record.status,
      reviewDecisionId: record.reviewDecisionId,
      reason: record.terminalReason,
      appliedVersionIds: [...record.appliedVersionIds],
      ...(record.decision === null ? {} : { decision: record.decision as unknown as JsonValue }),
    };
    const noticeId = stableId("refinement-terminal-notice", record.proposalId);
    const events: any[] = [{
      sessionId: record.sessionId,
      branchId: record.branchId,
      type: "RefinementProposalTerminalNoticeDelivered",
      producer: "supervisor",
      idempotencyKey: `refinement-terminal-notice:${record.proposalId}`,
      payload: {
        proposalId: record.proposalId,
        noticeId,
        originSessionId: record.proposal.origin.sessionId,
        originBranchId: record.proposal.origin.branchId,
        status: record.status,
        result,
      },
    }];
    if (record.proposal.principal.kind !== "owner") {
      events.push({
        sessionId: record.proposal.origin.sessionId,
        branchId: record.proposal.origin.branchId,
        type: "MessageAppended",
        producer: "supervisor",
        idempotencyKey: `refinement-terminal-message:${record.proposalId}`,
        payload: {
          messageId: noticeId,
          role: "tool",
          content: `Refinement ${record.proposalId} ended ${record.status}: ${record.terminalReason ?? "no additional reason"}`,
        },
      });
    }
    await this.storage.appendEvents(events);
  }

  async #freeze(proposal: GovernedRefinementProposal): Promise<any> {
    const relationship = await this.#relationship(proposal);
    const currentTarget = proposal.target.kind === "agent_profile"
      ? await this.profiles.getVersion(
          proposal.target.agentSessionId,
          proposal.target.expectedProfileVersionId,
        ) as unknown as JsonValue
      : {
          kind: "harness",
          targets: await Promise.all(proposal.target.edits.flatMap((edit) =>
            edit.operation === "create" ? [] : [this.harness.get(edit.entryId)])),
        } as unknown as JsonValue;
    const renderedReplacement = proposal.target.kind === "agent_profile"
      ? {
          ...proposal.target.replacement,
          exactAgentPrompt: renderExactAgentPrompt(proposal.target.replacement),
        } as unknown as JsonValue
      : proposal.target.edits as unknown as JsonValue;
    const evidence = [];
    for (const eventId of proposal.evidenceEventIds) {
      const event = await this.storage.getEvent(eventId);
      if (!event) throw new ValidationError("Frozen governance evidence is unavailable");
      evidence.push({
        eventId,
        sessionId: event.sessionId,
        branchId: event.branchId,
        cursor: event.cursor,
        type: event.type,
        payloadDigest: canonicalJsonDigest(event.payload as unknown as JsonValue),
      });
    }
    const origin = await this.storage.readonlyQuery({
      sql: "SELECT workspace_id FROM sessions WHERE session_id=?",
      args: [proposal.origin.sessionId],
    });
    const modelRows = await this.storage.loadEvents(proposal.origin.sessionId, {
      branchId: proposal.origin.branchId,
    });
    if (!modelRows.length) throw new ValidationError("Governance origin session is unavailable");
    const configuration = projectEvents(modelRows).model;
    const reviewerDispatch = this.modelAdmission.requestBuiltInStructured(
      REFINEMENT_GOVERNANCE_CONTRACT_ID,
      configuration,
    ).modelDispatch;
    const harnessContext = await this.harness.modelList(
      proposal.origin.sessionId,
      proposal.origin.branchId,
    );
    const body = {
      protocol: "agencity.refinement-governance-input",
      version: 1,
      proposal,
      currentTarget,
      renderedReplacement,
      evidence,
      proposerRelationship: relationship,
      targetScope: proposal.target.kind === "agent_profile"
        ? { kind: "session", agentSessionId: proposal.target.agentSessionId }
        : { kind: "harness", workspaceId: String((origin[0] as any).workspace_id), harnessKind: proposal.target.harnessKind },
      runtimeBoundaries: [
        "no credential changes", "no model or provider changes", "no budget changes",
        "no SDK or effect-policy changes", "no OS authority changes",
        "no immutable policy changes", "no routing or assignment changes",
      ],
      constraints: { workspaceCharter: null, userConstraints: null },
      visibleHarnessContext: harnessContext.map((entry) => ({
        entryId: entry.entryId,
        versionId: entry.current.versionId,
        kind: entry.kind,
        scope: entry.scope,
        name: entry.name,
        status: entry.status,
      })) as unknown as JsonValue,
      constitution: { ...PRODUCT_CONSTITUTION_REFERENCE, text: PRODUCT_CONSTITUTION.text },
      reviewPolicy: { ...REFINEMENT_GOVERNANCE_POLICY_REFERENCE, text: REFINEMENT_GOVERNANCE_POLICY.text },
      reviewerDispatch: reviewerDispatch as unknown as JsonValue,
      reviewerLimits: SEALED_GOVERNANCE_REVIEWER_LIMITS,
    };
    if (canonicalJsonByteLength(body as unknown as JsonValue) > 256 * 1024) {
      throw new ValidationError("Frozen governance reviewer input exceeds 262144 bytes");
    }
    return Object.freeze({
      ...body,
      canonicalDigest: canonicalJsonDigest(body as unknown as JsonValue),
    });
  }

  async #relationship(
    proposal: GovernedRefinementProposal,
  ): Promise<"self" | "direct_parent" | "workspace_owner" | "automatic_refiner"> {
    const targetSessionId = proposal.target.kind === "agent_profile"
      ? proposal.target.agentSessionId
      : proposal.origin.sessionId;
    const originRows = await this.storage.readonlyQuery({
      sql: "SELECT workspace_id FROM sessions WHERE session_id=?",
      args: [proposal.origin.sessionId],
    });
    const targetRows = await this.storage.readonlyQuery({
      sql: "SELECT workspace_id,parent_session_id,parent_branch_id FROM sessions WHERE session_id=?",
      args: [targetSessionId],
    });
    if (!originRows[0] || !targetRows[0] ||
        String((originRows[0] as any).workspace_id) !== String((targetRows[0] as any).workspace_id)) {
      throw new ValidationError("Refinement target is outside the origin workspace");
    }
    if (proposal.principal.kind === "owner") {
      if (proposal.principal.profileId !== this.ownerProfileId) {
        throw new ValidationError("Workspace owner identity does not match");
      }
      return "workspace_owner";
    }
    if (proposal.principal.kind === "automatic_refiner") {
      if (targetSessionId !== proposal.origin.sessionId ||
          proposal.principal.sessionId !== proposal.origin.sessionId) {
        throw new ValidationError("Automatic refiner target is outside its configured local scope");
      }
      return "automatic_refiner";
    }
    if (proposal.principal.sessionId !== proposal.origin.sessionId ||
        proposal.principal.branchId !== proposal.origin.branchId) {
      throw new ValidationError("Agent principal must be derived from the executing route");
    }
    if (targetSessionId === proposal.origin.sessionId) return "self";
    if (String((targetRows[0] as any).parent_session_id ?? "") === proposal.origin.sessionId &&
        String((targetRows[0] as any).parent_branch_id ?? "") === proposal.origin.branchId) {
      return "direct_parent";
    }
    throw new ValidationError("Agents may refine only themselves or an active direct child");
  }

  async #assertRateBounds(sessionId: string): Promise<void> {
    const rows = await this.storage.readonlyQuery({
      sql: `SELECT
        sum(CASE WHEN status IN ('validated','reviewing','reviewed_approved') THEN 1 ELSE 0 END) AS pending,
        sum(CASE WHEN created_at >= datetime('now','-1 hour') THEN 1 ELSE 0 END) AS recent
        FROM governed_refinement_proposals WHERE session_id=?`,
      args: [sessionId],
    });
    if (Number((rows[0] as any)?.pending ?? 0) >= MAX_PENDING_PER_SESSION) {
      throw new ValidationError("Concurrent governance review bound is exhausted");
    }
    if (Number((rows[0] as any)?.recent ?? 0) > MAX_PROPOSALS_PER_HOUR) {
      throw new ValidationError("Profile revision rate bound is exhausted");
    }
  }

  async #rollback(
    originSessionId: string,
    originBranchId: string,
    principal: RefinementProposalPrincipal,
    input: RollbackRefinementInput,
  ): Promise<RefinementRollbackResult> {
    normalizeBounded(input.reason, "Rollback reason", 1024);
    if (input.evidenceEventIds.length > MAX_EVIDENCE) throw new ValidationError("Rollback evidence exceeds 32 events");
    const normalizedReason = normalizeBounded(input.reason, "Rollback reason", 1024);
    const normalizedEvidence = [...new Set(input.evidenceEventIds)].sort();
    const rollbackMeaning = {
      principal,
      originSessionId,
      originBranchId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      expectedCurrentVersionId: input.expectedCurrentVersionId,
      restoreVersionId: input.restoreVersionId,
      reason: normalizedReason,
      evidenceEventIds: normalizedEvidence,
    };
    const rollbackId = stableId(
      "refinement-restoration",
      canonicalJsonDigest(rollbackMeaning as unknown as JsonValue),
    );
    return this.#queue.run(`rollback:${rollbackId}`, async () => {
    const existing = await this.storage.readonlyQuery({
      sql: "SELECT * FROM refinement_restorations WHERE rollback_id=?",
      args: [rollbackId],
    });
    if (existing[0]) {
      const row = existing[0] as any;
      const same = String(row.target_kind) === input.targetKind &&
        String(row.target_id) === input.targetId &&
        String(row.previous_version_id) === input.expectedCurrentVersionId &&
        String(row.restore_source_version_id) === input.restoreVersionId &&
        String(row.reason) === normalizedReason &&
        Bun.deepEquals(parseJson(row.actor_json, null), principal) &&
        Bun.deepEquals(parseJson(row.evidence_event_ids_json, []), normalizedEvidence);
      if (!same) throw new ConflictError("Rollback identity was reused with different meaning");
      return {
        rollbackId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        previousVersionId: input.expectedCurrentVersionId,
        restoreSourceVersionId: input.restoreVersionId,
        restorationVersionId: String(row.restoration_version_id),
      };
    }
    const target: RefinementTarget = input.targetKind === "agent_profile"
      ? {
          kind: "agent_profile",
          agentSessionId: input.targetId,
          expectedProfileVersionId: input.expectedCurrentVersionId,
          replacement: await this.#profileInput(input.targetId, input.restoreVersionId),
        }
      : {
          kind: "harness",
          harnessKind: input.targetKind,
          edits: [],
        };
    await this.#relationship({
      proposalId: rollbackId,
      target,
      principal,
      origin: { sessionId: originSessionId, branchId: originBranchId },
      reason: normalizedReason,
      predictedEffect: "Restore exact earlier approved content",
      evidenceEventIds: normalizedEvidence,
    });
    let restorationEvents;
    let restorationVersionId: string;
    if (input.targetKind === "agent_profile") {
      const prepared = await this.profiles.prepareRestore({
        targetSessionId: input.targetId,
        eventBranchId: await this.#initialBranch(input.targetId),
        originSessionId,
        originBranchId,
        evidenceAuthority: principal.kind === "owner" ? "workspace_owner" : "origin_lineage",
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        restoreVersionId: input.restoreVersionId,
        createdBy: refinementPrincipalToAgentPrincipal(principal),
        reason: normalizedReason,
        evidenceEventIds: normalizedEvidence,
        rollbackId,
      });
      restorationVersionId = prepared.profile.profileVersionId;
      restorationEvents = prepared.events;
    } else {
      const prepared = await this.harness.prepareRestoreGoverned(originSessionId, originBranchId, {
        targetId: input.targetId,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        restoreVersionId: input.restoreVersionId,
        rollbackId,
        reason: normalizedReason,
        evidenceEventIds: normalizedEvidence,
        createdBy: principalLabel(principal),
        evidenceAuthority: principal.kind === "owner" ? "workspace_owner" : "origin_lineage",
      });
      if (prepared.version.kind !== input.targetKind) {
        throw new ValidationError("Rollback target kind does not match the harness entry");
      }
      restorationVersionId = prepared.version.versionId;
      restorationEvents = prepared.events;
    }
    await this.storage.appendEvents([...restorationEvents, {
      sessionId: originSessionId,
      branchId: originBranchId,
      type: "RefinementRollbackApplied",
      producer: principal.kind === "owner" ? "client" : "supervisor",
      idempotencyKey: `refinement-restoration:${rollbackId}`,
      payload: {
        rollbackId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        previousVersionId: input.expectedCurrentVersionId,
        restoreSourceVersionId: input.restoreVersionId,
        restorationVersionId,
        actor: principal as unknown as JsonValue,
        reason: normalizedReason,
        evidenceEventIds: normalizedEvidence,
      },
    }]);
    return {
      rollbackId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      previousVersionId: input.expectedCurrentVersionId,
      restoreSourceVersionId: input.restoreVersionId,
      restorationVersionId,
    };
    });
  }

  async #profileInput(sessionId: string, versionId: string) {
    const version = await this.profiles.getVersion(sessionId, versionId);
    return { role: version.role, purpose: version.purpose, instructions: version.instructions };
  }

  async #initialBranch(sessionId: string): Promise<string> {
    const rows = await this.storage.readonlyQuery({
      sql: "SELECT initial_branch_id FROM sessions WHERE session_id=?",
      args: [sessionId],
    });
    if (!rows[0]) throw new ValidationError("Target agent session does not exist");
    return String((rows[0] as any).initial_branch_id);
  }

  #launch(proposalId: string): void {
    if (this.#jobs.has(proposalId)) return;
    const job = this.#queue.run(proposalId, () => this.#advance(proposalId))
      .catch(() => {})
      .finally(() => this.#jobs.delete(proposalId));
    this.#jobs.set(proposalId, job);
  }
}

function rowToRecord(row: Record<string, unknown>): GovernedRefinementRecord {
  return {
    proposalId: String(row.proposal_id),
    sessionId: String(row.session_id),
    branchId: String(row.branch_id),
    status: String(row.status) as GovernedRefinementStatus,
    proposal: parseJson(row.proposal_json, null) as unknown as GovernedRefinementProposal,
    validation: parseJson(row.validation_json, null),
    frozenInput: parseJson(row.frozen_input_json, null) as any,
    reviewHandleId: row.review_handle_id === null ? null : String(row.review_handle_id),
    reviewerSessionId: row.reviewer_session_id === null ? null : String(row.reviewer_session_id),
    reviewerBranchId: row.reviewer_branch_id === null ? null : String(row.reviewer_branch_id),
    reviewDecisionId: row.review_decision_id === null ? null : String(row.review_decision_id),
    decision: parseJson(row.decision_json, null) as RefinementGovernanceDecision | null,
    appliedVersionIds: parseJson(row.applied_version_ids_json, []),
    terminalReason: row.terminal_reason === null ? null : String(row.terminal_reason),
    noticeDelivered: row.terminal_notice_event_id !== null,
    createdEventId: String(row.created_event_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  return JSON.parse(String(value)) as T;
}

function normalizeBounded(value: string, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${label} is required`);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (new TextEncoder().encode(normalized).byteLength > maxBytes) {
    throw new ValidationError(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return normalized;
}

function bounded(value: string, maxBytes: number): string {
  const encoded = new TextEncoder();
  if (encoded.encode(value).byteLength <= maxBytes) return value;
  let output = "";
  for (const character of value) {
    if (encoded.encode(output + character).byteLength > maxBytes) break;
    output += character;
  }
  return output || "Governance operation failed";
}

function stableId(prefix: string, value: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(value);
  return `${prefix}-${hash.digest("hex").slice(0, 32)}`;
}

function principalLabel(principal: RefinementProposalPrincipal): string {
  return principal.kind === "owner"
    ? `owner:${principal.profileId}`
    : principal.kind === "agent"
      ? `agent:${principal.sessionId}`
      : `${principal.componentId}:v${principal.version}`;
}

function sameRevisionOrigin(
  previous: GovernedRefinementProposal,
  next: GovernedRefinementProposal,
): boolean {
  const comparable = (proposal: GovernedRefinementProposal) => ({
    sessionId: proposal.origin.sessionId,
    branchId: proposal.origin.branchId,
    runId: proposal.origin.runId ?? null,
    taskId: proposal.origin.taskId ?? null,
    triggerId: proposal.origin.triggerId ?? null,
  });
  return Bun.deepEquals(comparable(previous), comparable(next));
}

function refinementTargetIdentity(target: RefinementTarget): JsonValue {
  if (target.kind === "agent_profile") {
    return {
      kind: target.kind,
      agentSessionId: target.agentSessionId,
      expectedProfileVersionId: target.expectedProfileVersionId,
    };
  }
  return {
    kind: target.kind,
    harnessKind: target.harnessKind,
    edits: target.edits.map((edit) => edit.operation === "create"
      ? {
          operation: edit.operation,
          kind: edit.kind,
          scope: edit.scope,
          scopeKey: edit.scopeKey ?? null,
          name: edit.name,
        }
      : {
          operation: edit.operation,
          entryId: edit.entryId,
          expectedVersionId: edit.expectedVersionId,
        }),
  } as unknown as JsonValue;
}

function applicationFailureStatus(error: unknown): "apply_conflict" | "apply_failed" {
  if (error instanceof ConflictError) return "apply_conflict";
  if (error instanceof ValidationError &&
      /(?:compare-and-swap|stale expected|name is already active|conflicting active harness name)/i.test(error.message)) {
    return "apply_conflict";
  }
  return "apply_failed";
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length ||
      actual.some((key, index) => key !== wanted[index])) {
    throw new ValidationError(`${label} has missing or unknown fields`);
  }
}

function governancePrompt(proposalId: string): string {
  return [
    REFINEMENT_GOVERNANCE_POLICY.text,
    `Review only proposal ${proposalId}.`,
    "The structured recursive input is the complete frozen review record.",
    "Return exactly one required governance decision tool call.",
  ].join("\n");
}

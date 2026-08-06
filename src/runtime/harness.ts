import {
  newId, NotFoundError, ValidationError, type AgentEvent, type CandidateAllocationRecord,
  type EvaluationObservationRecord, type HarnessContent, type HarnessEdit, type HarnessKind,
  type HarnessRecord, type HarnessScope, type HarnessVersionRecord, type HarnessVersionStatus,
  type JsonValue, type ObjectiveEvaluation, type RefinementDecisionRecord, type RefinementProposalRecord,
} from "../domain/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import type { SkillService } from "./skills.ts";

export interface ProposeRefinementInput {
  readonly trigger: string;
  readonly predictedEffect: string;
  readonly edits: readonly HarnessEdit[];
  readonly evidenceEventIds?: readonly string[];
  readonly evaluation: ObjectiveEvaluation;
  readonly authority?: "agent" | "user" | "system";
  /** Stable identities are reserved for strict refiner integration. */
  readonly proposalId?: string;
  readonly sourceReviewId?: string;
  readonly proposalFingerprint?: string;
}
export interface ActivateCandidateInput { readonly allocationLimit?: number; readonly exposureLimit?: number; }
export interface AllocateCandidateInput { readonly sessionId: string; readonly branchId: string; readonly taskId?: string; }
export interface RecordObservationInput {
  readonly allocationId: string; readonly evaluator: string; readonly objective: boolean; readonly success: boolean;
  readonly metric: JsonValue; readonly baseline?: JsonValue; readonly evidenceEventIds?: readonly string[]; readonly notes?: string;
}
export interface DecideRefinementInput { readonly decision?: "promote" | "revise" | "reject"; readonly evaluator?: string; readonly rule?: string; }
export interface ApproveRollbackInput { readonly approvedBy?: string; readonly role?: "owner" | "admin"; readonly note?: string; }

const MAX_EDITS = 16;
const MAX_ALLOCATIONS = 100;
const MAX_EXPOSURES = 100;

class CandidateQueue { readonly #tails=new Map<string,Promise<void>>(); async run<T>(key:string,operation:()=>Promise<T>):Promise<T>{const previous=this.#tails.get(key)??Promise.resolve();let release!:()=>void;const current=new Promise<void>((resolve)=>{release=resolve});const tail=previous.catch(()=>{}).then(()=>current);this.#tails.set(key,tail);await previous.catch(()=>{});try{return await operation();}finally{release();if(this.#tails.get(key)===tail)this.#tails.delete(key);}} }

export class HarnessService {
  readonly #candidateQueue=new CandidateQueue();
  constructor(readonly storage: AgentStorage, readonly skills?: SkillService, readonly userScopeKey = "default-user") {}

  async propose(sessionId: string, branchId: string, input: ProposeRefinementInput): Promise<RefinementProposalRecord> {
    await this.#session(sessionId, branchId);
    if (!input.trigger?.trim() || !input.predictedEffect?.trim()) throw new ValidationError("A refinement requires a trigger and predicted effect");
    if (!Array.isArray(input.edits) || input.edits.length === 0 || input.edits.length > MAX_EDITS) throw new ValidationError(`A refinement requires 1-${MAX_EDITS} typed edits`);
    if (!input.evaluation || input.evaluation.kind !== "objective" || typeof input.evaluation.name !== "string" || !input.evaluation.name.trim() || typeof input.evaluation.metric !== "string" || !input.evaluation.metric.trim()) throw new ValidationError("A refinement requires an objective evaluation");
    if (input.evidenceEventIds !== undefined && (!Array.isArray(input.evidenceEventIds) || input.evidenceEventIds.some((id) => typeof id !== "string" || !id))) throw new ValidationError("Refinement evidence IDs must be non-empty strings");
    for (const edit of input.edits) assertEditShape(edit);
    const evidenceEventIds = unique([...(input.evidenceEventIds ?? []), ...input.edits.flatMap((edit) => [...(edit.evidenceEventIds ?? [])])]);
    const proposalId = input.proposalId ?? newId();
    const existing = await this.storage.readonlyQuery({ sql: "SELECT * FROM refinement_proposals WHERE proposal_id=?", args: [proposalId] });
    if (existing[0]) {
      const record = rowToProposal(existing[0] as any);
      const same = record.sessionId === sessionId && record.branchId === branchId && record.trigger === input.trigger.trim() && record.predictedEffect === input.predictedEffect.trim() && Bun.deepEquals(record.edits, input.edits) && Bun.deepEquals(record.evidenceEventIds, evidenceEventIds) && Bun.deepEquals(record.evaluation, input.evaluation) && record.authority === (input.authority ?? "agent") && record.sourceReviewId === input.sourceReviewId && record.proposalFingerprint === input.proposalFingerprint;
      if (!same) throw new ValidationError("Stable refinement proposal identity was reused with different intent");
      return record;
    }
    if ((input.sourceReviewId === undefined) !== (input.proposalFingerprint === undefined)) throw new ValidationError("Refiner proposals require both sourceReviewId and proposalFingerprint");
    await this.storage.appendEvents([{
      sessionId, branchId, type: "RefinementProposed", producer: input.authority === "user" ? "client" : "supervisor",
      idempotencyKey: `refinement-proposed:${proposalId}`,
      payload: { proposalId, trigger: input.trigger.trim(), predictedEffect: input.predictedEffect.trim(), edits: input.edits as unknown as JsonValue, evidenceEventIds, evaluation: input.evaluation as unknown as JsonValue, authority: input.authority ?? "agent", ...(input.sourceReviewId === undefined ? {} : { sourceReviewId: input.sourceReviewId, proposalFingerprint: input.proposalFingerprint! }) },
    }]);
    return this.#proposal(proposalId);
  }

  async validate(sessionId: string, branchId: string, proposalId: string): Promise<RefinementProposalRecord> {
    const proposal = await this.#proposal(proposalId);
    assertOwner(proposal, sessionId, branchId);
    if (proposal.status !== "proposed") throw new ValidationError(`Proposal must be proposed, not ${proposal.status}`);
    const errors: string[] = [];
    const trajectoryIds=new Set((await this.storage.loadEvents(sessionId,{branchId})).map((event)=>event.id));
    const cas: Record<string, JsonValue> = {};
    if (proposal.authority !== "user" && proposal.evidenceEventIds.length === 0) errors.push("Agent/system refinement requires durable source evidence");
    const touchedEntries = new Set<string>(); const proposedNames = new Set<string>();
    for (const evidenceId of proposal.evidenceEventIds) { if (!await this.storage.getEvent(evidenceId)) errors.push(`Missing evidence event ${evidenceId}`); else if(!trajectoryIds.has(evidenceId)) errors.push(`Evidence event ${evidenceId} is outside the proposal source trajectory`); }
    const intendedScopes=new Set<HarnessScope>();
    for (const edit of proposal.edits) {
      if (edit.operation !== "create") { if (touchedEntries.has(edit.entryId)) errors.push(`Multiple edits target ${edit.entryId}`); touchedEntries.add(edit.entryId); }
      if (edit.operation === "create") {
        intendedScopes.add(edit.scope);
        if (edit.scopeKey !== undefined && (typeof edit.scopeKey !== "string" || !edit.scopeKey.trim())) errors.push("scopeKey cannot be empty");
        if (edit.scope === "user" && edit.scopeKey === undefined) errors.push("User scope requires an explicit authority scopeKey");
        validateContent(edit.kind, edit.content, errors);
        if (edit.kind === "skill") this.#validateSkillPermissions(edit.content, errors);
        if (isImmutablePolicyName(edit.name)) errors.push("The immutable base policy and permission boundary cannot be edited");
        try {
          const scopeKey = await this.#scopeKey(sessionId,edit.scope,edit.scopeKey);
          const nameKey=`${edit.kind}:${edit.scope}:${scopeKey}:${edit.name}`; if(proposedNames.has(nameKey)) errors.push(`Conflicting proposal harness name ${edit.name}`); proposedNames.add(nameKey);
          const duplicate = await this.storage.readonlyQuery({sql:"SELECT entry_id FROM harness_entries WHERE kind=? AND scope=? AND scope_key=? AND name=? AND status IN ('active','candidate')",args:[edit.kind,edit.scope,scopeKey,edit.name]});
          if (duplicate.length) errors.push(`Conflicting active harness name ${edit.name}`);
        } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      } else {
        const entry = await this.get(edit.entryId);
        if (!entry) { errors.push(`Missing harness entry ${edit.entryId}`); continue; }
        intendedScopes.add(entry.scope);
        try { await this.#assertEntryScopeAuthority(sessionId, entry); }
        catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
        cas[edit.entryId] = { expectedVersionId: edit.expectedVersionId, actualVersionId: entry.currentVersionId };
        if (entry.currentVersionId !== edit.expectedVersionId) errors.push(`Stale expectedVersionId for ${edit.entryId}`);
        if (edit.operation === "replace") {
          validateContent(entry.kind, edit.content, errors);
          if (entry.kind === "skill") this.#validateSkillPermissions(edit.content, errors);
          if (edit.name !== undefined && isImmutablePolicyName(edit.name)) errors.push("The immutable base policy and permission boundary cannot be edited");
          if (edit.name !== undefined) {
            const duplicate = await this.storage.readonlyQuery({ sql: "SELECT entry_id FROM harness_entries WHERE kind=? AND scope=? AND scope_key=? AND name=? AND status IN ('active','candidate') AND entry_id<>?", args: [entry.kind,entry.scope,entry.scopeKey,edit.name,entry.entryId] });
            if (duplicate.length) errors.push(`Conflicting active harness name ${edit.name}`);
          }
        }
      }
    }
    if(intendedScopes.size>1) errors.push(`Mixed-scope proposal is over-broad: ${[...intendedScopes].join(",")}`);
    const validation: JsonValue = { valid: errors.length === 0, errors, cas, evidenceEventIds: proposal.evidenceEventIds, authority: proposal.authority, immutableBasePolicy: true };
    await this.storage.appendEvents([{
      sessionId, branchId, type: "RefinementValidated", producer: "supervisor", idempotencyKey: `refinement-validated:${proposalId}`,
      payload: { proposalId, valid: errors.length === 0, validation, expectedProposalStatus: "proposed" },
    }]);
    return this.#proposal(proposalId);
  }

  async activate(sessionId: string, branchId: string, proposalId: string, input: ActivateCandidateInput = {}): Promise<RefinementProposalRecord> {
    return this.#candidateQueue.run(proposalId,async()=> {
    const proposal = await this.#proposal(proposalId); assertOwner(proposal, sessionId, branchId);
    if (proposal.status === "candidate") {
      const rows=await this.storage.readonlyQuery({sql:"SELECT allocation_limit,exposure_limit FROM refinement_proposals WHERE proposal_id=?",args:[proposalId]}); const row=rows[0] as any;
      if (input.allocationLimit !== undefined && input.allocationLimit !== Number(row.allocation_limit) || input.exposureLimit !== undefined && input.exposureLimit !== Number(row.exposure_limit)) throw new ValidationError("Candidate activation retry changed its bounds");
      return proposal;
    }
    if (proposal.status !== "validated") throw new ValidationError(`Only a validated proposal can activate; current status is ${proposal.status}`);
    const allocationLimit = bounded(input.allocationLimit ?? 3, "allocationLimit", MAX_ALLOCATIONS);
    const exposureLimit = bounded(input.exposureLimit ?? allocationLimit, "exposureLimit", Math.min(MAX_EXPOSURES, allocationLimit));

    // Recheck every ownership, CAS, name, and permission boundary before any
    // candidate version is appended. appendEvents performs the same name/CAS
    // checks transactionally, covering activation races across proposals.
    for (const [editIndex,edit] of proposal.edits.entries()) {
      if (edit.operation === "create") {
        const scopeKey = await this.#scopeKey(sessionId, edit.scope, edit.scopeKey);
        if (edit.kind === "skill") this.#assertSkillPermissions(edit.content);
        const expectedEntryId = `entry-${stableId(`${proposalId}:${editIndex}`)}`;
        const duplicate = await this.storage.readonlyQuery({ sql: "SELECT entry_id FROM harness_entries WHERE kind=? AND scope=? AND scope_key=? AND name=? AND status IN ('active','candidate') AND entry_id<>?", args: [edit.kind,edit.scope,scopeKey,edit.name,expectedEntryId] });
        if (duplicate.length) throw new ValidationError(`Conflicting active harness name ${edit.name}`);
        continue;
      }
      const entry = await this.get(edit.entryId);
      if (!entry) throw new NotFoundError("harness entry", edit.entryId);
      await this.#assertEntryScopeAuthority(sessionId, entry);
      if (entry.currentVersionId !== edit.expectedVersionId) throw new ValidationError(`Harness compare-and-swap failed for ${edit.entryId}`);
      if (edit.operation === "replace") {
        if (entry.kind === "skill") this.#assertSkillPermissions(edit.content);
        const name = edit.name ?? entry.name;
        const duplicate = await this.storage.readonlyQuery({ sql: "SELECT entry_id FROM harness_entries WHERE kind=? AND scope=? AND scope_key=? AND name=? AND status IN ('active','candidate') AND entry_id<>?", args: [entry.kind,entry.scope,entry.scopeKey,name,entry.entryId] });
        if (duplicate.length) throw new ValidationError(`Conflicting active harness name ${name}`);
      }
    }

    const candidateId = `candidate-${stableId(proposalId)}`; const versionIds: string[] = []; const createEvents: any[] = [];
    for (const [editIndex,edit] of proposal.edits.entries()) {
      if (edit.operation === "retire") continue;
      const entryId = edit.operation === "create" ? `entry-${stableId(`${proposalId}:${editIndex}`)}` : edit.entryId;
      const versionId = `version-${stableId(`${proposalId}:${editIndex}`)}`; versionIds.push(versionId);
      const existingVersion = await this.getVersion(versionId);
      if (existingVersion) {
        if (existingVersion.proposalId !== proposalId || existingVersion.entryId !== entryId) throw new ValidationError("Candidate version identity collision");
        if (existingVersion.status === "rejected") throw new ValidationError(`Generated skill ${versionId} failed compile/runtime tests`);
        continue;
      }
      const previous = edit.operation === "replace" ? await this.get(edit.entryId) : null;
      if (edit.operation === "replace" && (!previous || previous.currentVersionId !== edit.expectedVersionId)) throw new ValidationError(`Harness compare-and-swap failed for ${edit.entryId}`);
      const scope = edit.operation === "create" ? edit.scope : previous!.scope;
      const scopeKey = edit.operation === "create" ? await this.#scopeKey(sessionId, scope, edit.scopeKey) : previous!.scopeKey;
      const evidence = unique([...(proposal.evidenceEventIds), ...(edit.evidenceEventIds ?? [])]);
      createEvents.push({
        sessionId, branchId, type: "HarnessVersionCreated", producer: "supervisor", idempotencyKey: `harness-version:${versionId}`,
        payload: {
          entryId, versionId, version: edit.operation === "create" ? 1 : previous!.current.version + 1,
          kind: edit.operation === "create" ? edit.kind : previous!.kind, scope, scopeKey,
          name: edit.operation === "create" ? edit.name : edit.name ?? previous!.name,
          content: edit.content as unknown as JsonValue, tags: unique([...(edit.tags ?? previous?.current.tags ?? [])]),
          confidence: edit.confidence ?? previous?.current.confidence ?? 0.5, status: "candidate",
          evidenceEventIds: evidence, conflictEntryIds: unique([...(edit.conflictEntryIds ?? previous?.current.conflictEntryIds ?? [])]),
          ...(previous ? { supersedesVersionId: previous.currentVersionId } : {}), proposalId, createdBy: proposal.authority,
          lastConfirmedAt: new Date().toISOString(),
        },
      });
    }
    if (createEvents.length) await this.storage.appendEvents(createEvents);

    // Generated TypeScript must compile and pass every declared runtime test as
    // a durable effect before its candidate can be exposed.
    if (this.skills) for (const versionId of versionIds) {
      const version = await this.getVersion(versionId);
      if (version?.kind !== "skill") continue;
      const report = await this.skills.test(sessionId, branchId, version.entryId, versionId);
      if (report.outcome !== "succeeded" || !report.compiled || report.failed > 0) {
        await this.storage.appendEvents([{
          sessionId, branchId, type: "HarnessVersionStatusChanged", producer: "supervisor", idempotencyKey: `skill-candidate-rejected:${versionId}`,
          payload: { entryId: version.entryId, versionId, status: "rejected", reason: "Generated skill compile/runtime tests failed", proposalId },
        }]);
        throw new ValidationError(`Generated skill ${versionId} failed compile/runtime tests`);
      }
    }
    await this.storage.appendEvents([{
      sessionId, branchId, type: "RefinementCandidateActivated", producer: "supervisor", idempotencyKey: `refinement-candidate:${proposalId}`,
      payload: { proposalId, candidateId, versionIds, allocationLimit, exposureLimit },
    }]);
    return this.#proposal(proposalId);

    });
  }

  async allocate(sessionId: string, branchId: string, proposalId: string, input?: Partial<AllocateCandidateInput>): Promise<CandidateAllocationRecord> {
    return this.#candidateQueue.run(proposalId,async()=> {
    const proposal = await this.#proposal(proposalId); assertOwner(proposal, sessionId, branchId);
    if (proposal.status !== "candidate" || !proposal.candidateId) throw new ValidationError("Only an active candidate can be allocated");
    const targetSessionId = input?.sessionId ?? sessionId; const targetBranchId = input?.branchId ?? branchId;
    await this.#session(targetSessionId, targetBranchId);
    const targetRows=await this.storage.readonlyQuery({sql:"SELECT workspace_id FROM sessions WHERE session_id=?",args:[targetSessionId]}); const targetWorkspace=String((targetRows[0] as any).workspace_id);
    if(input?.taskId!==undefined){ if(!this.storage.getTask) throw new ValidationError("Storage cannot validate task-bound candidate allocation"); const task=await this.storage.getTask(input.taskId); if(!task) throw new ValidationError(`Candidate allocation task does not exist: ${input.taskId}`); if(task.childSessionId!==targetSessionId||task.childBranchId!==targetBranchId) throw new ValidationError("Candidate allocation task does not match its child target session/branch"); if(["completed","failed","cancelled"].includes(task.status)) throw new ValidationError("Candidate allocation task is already terminal"); }
    const scoped=await this.storage.readonlyQuery({sql:"SELECT scope,scope_key FROM harness_versions WHERE proposal_id=?",args:[proposalId]});
    for(const row of scoped as any[]) { const scope=String(row.scope),key=String(row.scope_key); if(scope==="local"&&key!==targetSessionId||scope==="workspace"&&key!==targetWorkspace) throw new ValidationError("Candidate allocation target is outside the proposed harness scope"); }
    for(const edit of proposal.edits) if(edit.operation==="retire"){const entry=await this.get(edit.entryId);if(entry&&(entry.scope==="local"&&entry.scopeKey!==targetSessionId||entry.scope==="workspace"&&entry.scopeKey!==targetWorkspace))throw new ValidationError("Candidate allocation target is outside the proposed retirement scope");}
    const rows = await this.storage.readonlyQuery({ sql: "SELECT * FROM candidate_allocations WHERE candidate_id=? ORDER BY ordinal", args: [proposal.candidateId] });
    const details = await this.storage.readonlyQuery({ sql: "SELECT allocation_limit FROM refinement_proposals WHERE proposal_id=?", args: [proposalId] });
    const limit = Number((details[0] as any)?.allocation_limit ?? 0);
    if (rows.length >= limit) throw new ValidationError(`Candidate allocation limit ${limit} exhausted`);
    const duplicate = rows.find((row: any) => row.session_id === targetSessionId && row.branch_id === targetBranchId && (row.task_id ?? null) === (input?.taskId ?? null));
    if (duplicate) return rowToAllocation(duplicate);
    const allocationId = `allocation-${stableId(`${proposal.candidateId}:${targetSessionId}:${targetBranchId}:${input?.taskId ?? "session"}`)}`; const ordinal = rows.length + 1;
    await this.storage.appendEvents([{
      sessionId, branchId, type: "RefinementCandidateAllocated", producer: "supervisor", idempotencyKey: `candidate-allocation:${allocationId}`,
      payload: { proposalId, candidateId: proposal.candidateId, allocationId, targetSessionId, targetBranchId, ...(input?.taskId === undefined ? {} : { taskId: input.taskId }), ordinal },
    }]);
    return this.#allocation(allocationId);
    });
  }
  /** Marks an allocated candidate as actually materialized into context. */
  async expose(sessionId: string, branchId: string, proposalId: string, allocationId: string): Promise<CandidateAllocationRecord> {
    return this.#candidateQueue.run(proposalId, async () => {
      const exposed = await this.#exposeUnlocked(sessionId, branchId, proposalId, allocationId, true);
      if (!exposed) throw new ValidationError("Candidate exposure is unavailable");
      return exposed;
    });
  }

  /**
   * Context materialization uses a non-throwing exposure claim. An allocation
   * beyond the experiment's exposure bound is a valid control allocation, not
   * a session failure; it remains durable, usable, and invisible.
   */
  async exposeIfAvailable(sessionId: string, branchId: string, proposalId: string, allocationId: string): Promise<CandidateAllocationRecord | null> {
    return this.#candidateQueue.run(proposalId, () =>
      this.#exposeUnlocked(sessionId, branchId, proposalId, allocationId, false));
  }

  async #exposeUnlocked(sessionId: string, branchId: string, proposalId: string, allocationId: string, strict: boolean): Promise<CandidateAllocationRecord | null> {
    const proposal = await this.#proposal(proposalId);
    if (proposal.status !== "candidate" || !proposal.candidateId) {
      if (!strict) return null;
      throw new ValidationError("Only an active candidate can be exposed");
    }
    const allocation = await this.#allocation(allocationId);
    if (allocation.candidateId !== proposal.candidateId || allocation.sessionId !== sessionId || allocation.branchId !== branchId) {
      if (!strict) return null;
      throw new ValidationError("Candidate allocation does not match this context");
    }
    if (allocation.exposedAt) return allocation;
    const rows = await this.storage.readonlyQuery({ sql: "SELECT count(*) AS count FROM candidate_allocations WHERE candidate_id=? AND exposed_at IS NOT NULL", args: [proposal.candidateId] });
    const details = await this.storage.readonlyQuery({ sql: "SELECT exposure_limit FROM refinement_proposals WHERE proposal_id=?", args: [proposalId] });
    const count = Number((rows[0] as any)?.count ?? 0), limit = Number((details[0] as any)?.exposure_limit ?? 0);
    if (count >= limit) {
      if (!strict) return null;
      throw new ValidationError(`Candidate exposure limit ${limit} exhausted`);
    }
    const versions = await this.storage.readonlyQuery({ sql: "SELECT version_id FROM harness_versions WHERE proposal_id=? ORDER BY version_id", args: [proposalId] });
    await this.storage.appendEvents([{
      sessionId, branchId, type: "RefinementCandidateExposed", producer: "supervisor", idempotencyKey: `candidate-exposure:${allocationId}`,
      payload: { proposalId, candidateId: proposal.candidateId, allocationId, exposedVersionIds: versions.map((row: any) => String(row.version_id)) },
    }]);
    return this.#allocation(allocationId);
  }

  async recordObservation(sessionId: string, branchId: string, proposalId: string, input: RecordObservationInput): Promise<EvaluationObservationRecord> {
    const proposal = await this.#proposal(proposalId); assertOwner(proposal, sessionId, branchId);
    if (proposal.status !== "candidate" || !proposal.candidateId) throw new ValidationError("Observations require an active candidate");
    const allocation = await this.#allocation(input.allocationId);
    if (allocation.candidateId !== proposal.candidateId || allocation.proposalId !== proposal.proposalId || !allocation.exposedAt) throw new ValidationError("Observation allocation must be exposed for this candidate");
    const evidenceEventIds = unique([...(input.evidenceEventIds ?? [])]);
    const evidenceEvents:AgentEvent[]=[];
    for (const id of evidenceEventIds) {
      const found=await this.storage.getEvent(id);
      if (!found) throw new ValidationError(`Observation evidence event does not exist: ${id}`);
      evidenceEvents.push(found);
    }
    if (!input.evaluator?.trim()) throw new ValidationError("Observation evaluator is required");
    if (input.objective) await this.#assertObjectiveObservation(proposal, allocation, input.metric, input.success, input.baseline, evidenceEvents);
    const observationId = newId();
    await this.storage.appendEvents([{
      sessionId, branchId, type: "RefinementObservationRecorded", producer: "supervisor", idempotencyKey: `refinement-observation:${observationId}`,
      payload: { proposalId, candidateId: proposal.candidateId, allocationId: input.allocationId, observationId, evaluator: input.evaluator, objective: input.objective, success: input.success, metric: input.metric, ...(input.baseline === undefined ? {} : { baseline: input.baseline }), evidenceEventIds, ...(input.notes === undefined ? {} : { notes: input.notes }) },
    }]);
    const rows = await this.storage.readonlyQuery({ sql: "SELECT * FROM refinement_observations WHERE observation_id=?", args: [observationId] });
    return rowToObservation(rows[0] as any);
  }

  async approve(sessionId: string, branchId: string, proposalId: string, scopeOrInput: "user" | "global" | { readonly scope: "user"|"global"; readonly approvedBy?: string; readonly note?: string }, rawApprovedBy = "user", rawNote?: string): Promise<RefinementProposalRecord> {
    const proposal = await this.#proposal(proposalId); assertOwner(proposal, sessionId, branchId);
    const scope=typeof scopeOrInput === "string" ? scopeOrInput : scopeOrInput.scope; const approvedBy=typeof scopeOrInput === "string" ? rawApprovedBy : scopeOrInput.approvedBy ?? "user"; const note=typeof scopeOrInput === "string" ? rawNote : scopeOrInput.note;
    if (!approvedBy.trim()) throw new ValidationError("Approval must identify the user authority");
    await this.storage.appendEvents([{
      sessionId, branchId, type: "RefinementApproved", producer: "client", idempotencyKey: `refinement-approval:${proposalId}:${scope}`,
      payload: { proposalId, approvedBy, scope, ...(note === undefined ? {} : { note }) },
    }]);
    return this.#proposal(proposalId);
  }

  async approveRollback(sessionId: string, branchId: string, proposalId: string, input: ApproveRollbackInput = {}): Promise<RefinementProposalRecord> {
    const proposal = await this.#proposal(proposalId); assertOwner(proposal, sessionId, branchId);
    if (proposal.status !== "promoted") throw new ValidationError("Rollback approval requires an already promoted proposal");
    const scopes = await this.#proposalScopes(proposal);
    if (!scopes.some((scope) => scope === "user" || scope === "global")) throw new ValidationError("Local/workspace rollback does not require owner/admin approval");
    const approvedBy = input.approvedBy ?? this.userScopeKey;
    const role = input.role ?? "owner";
    if (!approvedBy.trim()) throw new ValidationError("Rollback approval must identify its authority");
    if (role === "owner" && approvedBy !== this.userScopeKey) throw new ValidationError("Rollback owner approval must come from the configured user authority");
    await this.storage.appendEvents([{
      sessionId, branchId, type: "RefinementRollbackApproved", producer: "client", idempotencyKey: `refinement-rollback-approval:${proposalId}`,
      payload: { proposalId, approvedBy, role, ...(input.note === undefined ? {} : { note: input.note }) },
    }]);
    return this.#proposal(proposalId);
  }

  async decide(sessionId: string, branchId: string, proposalId: string, input: DecideRefinementInput = {}): Promise<RefinementDecisionRecord> {
    return this.#candidateQueue.run(proposalId,async()=> {
    const proposal = await this.#proposal(proposalId); assertOwner(proposal, sessionId, branchId);
    if (proposal.status !== "candidate" || !proposal.candidateId) throw new ValidationError("Only an active candidate can be decided");
    const observations = (await this.storage.readonlyQuery({ sql: "SELECT * FROM refinement_observations WHERE candidate_id=? ORDER BY created_at,observation_id", args: [proposal.candidateId] })).map((row: any) => rowToObservation(row));
    const decision = input.decision ?? "promote";
    if (decision === "promote") await this.#assertPromotion(proposal, observations);
    else if (observations.length === 0) throw new ValidationError(`${decision} requires an observed candidate outcome`);
    const evaluator = input.evaluator ?? (decision === "promote" ? "scope-sensitive-promotion-policy-v1" : "refinement-evaluator");
    const rule = input.rule ?? promotionRule(proposal, decision);
    const decisionId = newId(); const events: any[] = [{
      sessionId, branchId, type: "RefinementDecided", producer: "supervisor", idempotencyKey: `refinement-decision:${proposalId}:${decisionId}`,
      payload: { proposalId, candidateId: proposal.candidateId, decisionId, decision, rule, evaluator, baseline: proposal.evaluation.baseline ?? observations.find((item) => item.baseline !== undefined)?.baseline ?? null, observationIds: observations.map((item) => item.observationId) },
    }];
    const candidateVersions = await this.storage.readonlyQuery({ sql: "SELECT entry_id,version_id FROM harness_versions WHERE proposal_id=? ORDER BY version_id", args: [proposalId] });
    if (decision === "promote") {
      for (const row of candidateVersions as any[]) events.push({ sessionId, branchId, type: "HarnessVersionStatusChanged", producer: "supervisor", idempotencyKey: `candidate-promoted:${String(row.version_id)}`, payload: { entryId: String(row.entry_id), versionId: String(row.version_id), status: "active", reason: rule, proposalId } });
      for (const edit of proposal.edits) if (edit.operation === "retire") events.push({ sessionId, branchId, type: "HarnessVersionStatusChanged", producer: "supervisor", idempotencyKey: `candidate-retired:${edit.entryId}:${proposalId}`, payload: { entryId: edit.entryId, versionId: edit.expectedVersionId, status: "retired", reason: rule, proposalId } });
    } else {
      // Both reject and revise terminalize the old candidate versions. Keeping
      // a revision-required version in candidate status strands create names
      // behind the partial unique index and prevents the revised proposal.
      for (const row of candidateVersions as any[]) events.push({ sessionId, branchId, type: "HarnessVersionStatusChanged", producer: "supervisor", idempotencyKey: `candidate-${decision === "revise" ? "revision" : "rejected"}:${String(row.version_id)}`, payload: { entryId: String(row.entry_id), versionId: String(row.version_id), status: "rejected", reason: rule, proposalId } });
    }
    await this.storage.appendEvents(events);
    const rows = await this.storage.readonlyQuery({ sql: "SELECT * FROM refinement_decisions WHERE decision_id=?", args: [decisionId] });
    return rowToDecision(rows[0] as any);

    });
  }

  async rollback(sessionId: string, branchId: string, proposalId: string, reasonOrInput: string | { readonly reason: string }): Promise<RefinementProposalRecord> {
    return this.#candidateQueue.run(proposalId,async()=> {
    const reason=typeof reasonOrInput === "string" ? reasonOrInput : reasonOrInput.reason;
    const proposal = await this.#proposal(proposalId); assertOwner(proposal, sessionId, branchId);
    if (proposal.status !== "promoted" || !proposal.candidateId) throw new ValidationError("Only a promoted candidate can be rolled back");
    if (!reason.trim()) throw new ValidationError("Rollback reason is required");
    const scopes = await this.#proposalScopes(proposal);
    if (scopes.some((scope) => scope === "user" || scope === "global")) {
      const approvals = await this.storage.readonlyQuery({ sql: "SELECT approved_by,role FROM refinement_rollback_approvals WHERE proposal_id=?", args: [proposalId] });
      const authorized = approvals.some((row:any) => String(row.role) === "admin" || String(row.role) === "owner" && String(row.approved_by) === this.userScopeKey);
      if (!authorized) throw new ValidationError("User/global rollback requires separate explicit owner/admin rollback approval");
    }
    const rows = await this.storage.readonlyQuery({ sql: "SELECT entry_id,version_id,supersedes_version_id FROM harness_versions WHERE proposal_id=? ORDER BY version_id", args: [proposalId] });
    const restoredVersionIds = (rows as any[]).flatMap((row) => row.supersedes_version_id ? [String(row.supersedes_version_id)] : []);
    const rollbackId = newId(); const events: any[] = [{
      sessionId, branchId, type: "RefinementRolledBack", producer: "supervisor", idempotencyKey: `refinement-rollback:${proposalId}`,
      payload: { proposalId, candidateId: proposal.candidateId, rollbackId, versionIds: (rows as any[]).map((row) => String(row.version_id)), restoredVersionIds, reason },
    }];
    for (const row of rows as any[]) events.push({ sessionId, branchId, type: "HarnessVersionStatusChanged", producer: "supervisor", idempotencyKey: `candidate-rolled-back:${String(row.version_id)}`, payload: { entryId: String(row.entry_id), versionId: String(row.version_id), status: "rolled_back", reason, proposalId } });
    for (const edit of proposal.edits) if (edit.operation === "retire") events.push({ sessionId, branchId, type: "HarnessVersionStatusChanged", producer: "supervisor", idempotencyKey: `retirement-rolled-back:${edit.entryId}:${proposalId}`, payload: { entryId: edit.entryId, versionId: edit.expectedVersionId, status: "active", reason, proposalId } });
    await this.storage.appendEvents(events);
    return this.#proposal(proposalId);

    });
  }

  async list(options: { kind?: HarnessKind; scope?: HarnessScope; scopeKey?: string; status?: HarnessVersionStatus } = {}): Promise<HarnessRecord[]> {
    const conditions: string[] = []; const args: Array<string> = [];
    if (options.kind) { conditions.push("e.kind=?"); args.push(options.kind); }
    if (options.scope) { conditions.push("e.scope=?"); args.push(options.scope); }
    if (options.scopeKey) { conditions.push("e.scope_key=?"); args.push(options.scopeKey); }
    if (options.status) { conditions.push("v.status=?"); args.push(options.status); }
    const versionPointer = options.status === "active" ? "e.active_version_id" : "e.current_version_id";
    const sql = `SELECT e.*,v.* FROM harness_entries e JOIN harness_versions v ON v.version_id=${versionPointer} ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY e.scope,e.kind,e.name,e.entry_id`;
    return (await this.storage.readonlyQuery({ sql, args })).map((row: any) => rowToHarness(row));
  }

  async history(entryId: string): Promise<HarnessVersionRecord[]> {
    return (await this.storage.readonlyQuery({ sql: "SELECT * FROM harness_versions WHERE entry_id=? ORDER BY version", args: [entryId] })).map((row: any) => rowToVersion(row));
  }
  /** Model-facing view: scoped active entries plus only this branch's exact exposed candidates. */
  async modelList(sessionId: string, branchId: string, options: { kind?: HarnessKind; scope?: HarnessScope; scopeKey?: string; status?: HarnessVersionStatus } = {}): Promise<HarnessRecord[]> {
    await this.#session(sessionId, branchId);
    const sessionRows = await this.storage.readonlyQuery({ sql: "SELECT workspace_id FROM sessions WHERE session_id=?", args: [sessionId] });
    const workspaceId = String((sessionRows[0] as any).workspace_id);
    const scopeSql = "((e.scope='local' AND e.scope_key=?) OR (e.scope='workspace' AND e.scope_key=?) OR (e.scope='user' AND e.scope_key=?) OR (e.scope='global' AND e.scope_key='global'))";
    const activeRows = await this.storage.readonlyQuery({
      sql: `SELECT v.*,e.current_version_id,e.active_version_id,e.status AS entry_status,e.created_at AS entry_created_at,e.updated_at AS entry_updated_at FROM harness_entries e JOIN harness_versions v ON v.version_id=e.active_version_id WHERE ${scopeSql} ORDER BY e.scope,e.kind,e.name,e.entry_id`,
      args: [sessionId,workspaceId,this.userScopeKey],
    });
    const candidateRows = await this.storage.readonlyQuery({
      sql: `SELECT DISTINCT v.*,e.current_version_id,e.active_version_id,e.status AS entry_status,e.created_at AS entry_created_at,e.updated_at AS entry_updated_at FROM candidate_allocations a JOIN refinement_proposals p ON p.proposal_id=a.proposal_id JOIN harness_versions v ON v.proposal_id=a.proposal_id JOIN harness_entries e ON e.entry_id=v.entry_id WHERE a.session_id=? AND a.branch_id=? AND a.exposed_at IS NOT NULL AND p.status='candidate' AND v.status='candidate' AND ${scopeSql} ORDER BY e.scope,e.kind,e.name,e.entry_id`,
      args: [sessionId,branchId,sessionId,workspaceId,this.userScopeKey],
    });
    const exposedProposals = await this.storage.readonlyQuery({ sql: "SELECT DISTINCT p.proposal_id,p.edits_json FROM candidate_allocations a JOIN refinement_proposals p ON p.proposal_id=a.proposal_id WHERE a.session_id=? AND a.branch_id=? AND a.exposed_at IS NOT NULL AND p.status='candidate'", args: [sessionId,branchId] });
    const retired = new Set<string>();
    for (const row of exposedProposals as any[]) for (const edit of parseJson<any[]>(row.edits_json, [])) if (edit.operation === "retire") retired.add(String(edit.entryId));
    const visible = new Map<string,HarnessRecord>();
    for (const row of activeRows as any[]) {
      const record = modelRowToHarness(row);
      if (!retired.has(record.entryId)) visible.set(record.entryId, record);
    }
    for (const row of candidateRows as any[]) {
      const record = modelRowToHarness(row);
      visible.set(record.entryId, record);
    }
    return [...visible.values()].filter((record) =>
      (!options.kind || record.kind === options.kind) &&
      (!options.scope || record.scope === options.scope) &&
      (!options.scopeKey || record.scopeKey === options.scopeKey) &&
      (!options.status || record.current.status === options.status)
    ).sort((left,right) => left.scope.localeCompare(right.scope) || left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name) || left.entryId.localeCompare(right.entryId));
  }

  /** Model history never includes an unexposed current candidate or another workspace. */
  async modelHistory(sessionId: string, branchId: string, entryId: string): Promise<HarnessVersionRecord[]> {
    await this.#session(sessionId, branchId);
    const sessionRows = await this.storage.readonlyQuery({ sql: "SELECT workspace_id FROM sessions WHERE session_id=?", args: [sessionId] });
    const workspaceId = String((sessionRows[0] as any).workspace_id);
    const rows = await this.storage.readonlyQuery({
      sql: `SELECT DISTINCT v.* FROM harness_versions v JOIN harness_entries e ON e.entry_id=v.entry_id LEFT JOIN candidate_allocations a ON a.proposal_id=v.proposal_id AND a.session_id=? AND a.branch_id=? AND a.exposed_at IS NOT NULL LEFT JOIN refinement_proposals p ON p.proposal_id=a.proposal_id WHERE v.entry_id=? AND ((e.scope='local' AND e.scope_key=?) OR (e.scope='workspace' AND e.scope_key=?) OR (e.scope='user' AND e.scope_key=?) OR (e.scope='global' AND e.scope_key='global')) AND (v.version_id=e.active_version_id OR (v.status='candidate' AND a.allocation_id IS NOT NULL AND p.status='candidate')) ORDER BY v.version`,
      args: [sessionId,branchId,entryId,sessionId,workspaceId,this.userScopeKey],
    });
    return rows.map((row:any) => rowToVersion(row));
  }

  async get(entryId: string): Promise<HarnessRecord | null> {
    const rows = await this.storage.readonlyQuery({ sql: "SELECT e.*,v.* FROM harness_entries e JOIN harness_versions v ON v.version_id=e.current_version_id WHERE e.entry_id=?", args: [entryId] });
    return rows[0] ? rowToHarness(rows[0] as any) : null;
  }
  async getActive(entryId: string): Promise<HarnessRecord | null> {
    const rows = await this.storage.readonlyQuery({ sql: "SELECT e.*,v.* FROM harness_entries e JOIN harness_versions v ON v.version_id=e.active_version_id WHERE e.entry_id=?", args: [entryId] });
    return rows[0] ? rowToHarness(rows[0] as any) : null;
  }
  async getVersion(versionId: string): Promise<HarnessVersionRecord | null> {
    const rows = await this.storage.readonlyQuery({ sql: "SELECT * FROM harness_versions WHERE version_id=?", args: [versionId] });
    return rows[0] ? rowToVersion(rows[0] as any) : null;
  }
  async proposals(status?: RefinementProposalRecord["status"]): Promise<RefinementProposalRecord[]> {
    const rows = await this.storage.readonlyQuery({ sql: `SELECT * FROM refinement_proposals${status ? " WHERE status=?" : ""} ORDER BY created_at,proposal_id`, args: status ? [status] : [] });
    return rows.map((row: any) => rowToProposal(row));
  }
  async allocations(candidateId: string): Promise<CandidateAllocationRecord[]> { return (await this.storage.readonlyQuery({ sql: "SELECT * FROM candidate_allocations WHERE candidate_id=? ORDER BY ordinal", args: [candidateId] })).map((row: any) => rowToAllocation(row)); }

  async #assertEntryScopeAuthority(sessionId: string, entry: HarnessRecord): Promise<void> {
    const rows = await this.storage.readonlyQuery({ sql: "SELECT workspace_id FROM sessions WHERE session_id=?", args: [sessionId] });
    if (!rows[0]) throw new NotFoundError("session", sessionId);
    const workspaceId = String((rows[0] as any).workspace_id);
    const allowed = entry.scope === "local" ? entry.scopeKey === sessionId
      : entry.scope === "workspace" ? entry.scopeKey === workspaceId
      : entry.scope === "user" ? entry.scopeKey === this.userScopeKey
      : entry.scopeKey === "global";
    if (!allowed) throw new ValidationError(`Harness entry ${entry.entryId} belongs to another ${entry.scope} scope`);
  }

  #validateSkillPermissions(content: HarnessContent, errors: string[]): void {
    if (content.kind !== "skill" || !this.skills) return;
    try { this.skills.assertPermissionsAllowed(content.permissions); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }

  #assertSkillPermissions(content: HarnessContent): void {
    if (content.kind === "skill" && this.skills) this.skills.assertPermissionsAllowed(content.permissions);
  }

  async #proposalScopes(proposal: RefinementProposalRecord): Promise<HarnessScope[]> {
    const scopes: HarnessScope[] = [];
    for (const edit of proposal.edits) {
      if (edit.operation === "create") { if (!scopes.includes(edit.scope)) scopes.push(edit.scope); continue; }
      const entry = await this.get(edit.entryId);
      if (!entry) throw new NotFoundError("harness entry", edit.entryId);
      await this.#assertEntryScopeAuthority(proposal.sessionId, entry);
      if (!scopes.includes(entry.scope)) scopes.push(entry.scope);
    }
    return scopes;
  }

  async #assertObjectiveObservation(
    proposal: RefinementProposalRecord,
    allocation: CandidateAllocationRecord,
    metric: JsonValue,
    success: boolean,
    baseline: JsonValue | undefined,
    evidenceEvents: AgentEvent[],
  ): Promise<void> {
    if (proposal.evaluation.kind !== "objective") throw new ValidationError("Observation does not match the predeclared evaluation kind");
    const metricName = proposal.evaluation.metric.trim();
    let measured: JsonValue = metric;
    if (metric && typeof metric === "object" && !Array.isArray(metric)) {
      if (!Object.prototype.hasOwnProperty.call(metric, metricName)) throw new ValidationError(`Objective observation must report the predeclared metric ${metricName}`);
      measured = (metric as Record<string,JsonValue>)[metricName]!;
    }
    if (success && !Bun.deepEquals(measured, proposal.evaluation.target)) throw new ValidationError(`Successful objective observation does not meet the predeclared ${metricName} target`);
    if (baseline !== undefined && proposal.evaluation.baseline !== undefined && !Bun.deepEquals(baseline, proposal.evaluation.baseline)) throw new ValidationError("Objective observation baseline does not match the predeclared evaluation baseline");

    const sessionRows = await this.storage.readonlyQuery({ sql: "SELECT task_id FROM sessions WHERE session_id=?", args: [allocation.sessionId] });
    const sessionTaskId = (sessionRows[0] as any)?.task_id === null || (sessionRows[0] as any)?.task_id === undefined ? null : String((sessionRows[0] as any).task_id);
    if (allocation.taskId !== null && sessionTaskId !== allocation.taskId) throw new ValidationError("Objective evidence does not belong to the allocation task");
    const exposureRows = await this.storage.readonlyQuery({
      sql: "SELECT exposed_event_id FROM candidate_allocations WHERE allocation_id=?",
      args: [allocation.allocationId],
    });
    const exposureEventId = (exposureRows[0] as any)?.exposed_event_id;
    const exposureEvent = typeof exposureEventId === "string" ? await this.storage.getEvent(exposureEventId) : null;
    if (!exposureEvent) throw new ValidationError("Objective evidence requires a durable candidate exposure event");
    for (const event of evidenceEvents) {
      if (event.sessionId !== allocation.sessionId || event.branchId !== allocation.branchId) {
        throw new ValidationError("Objective evidence must belong to the exact allocation session and branch");
      }
      if (BigInt(event.cursor) <= BigInt(exposureEvent.cursor)) {
        throw new ValidationError("Objective evidence must be observed after the candidate exposure");
      }
    }

    const objectiveEvents = evidenceEvents.filter(isObjectiveEvidence);
    if (!objectiveEvents.length) throw new ValidationError("An objective observation requires a successful durable effect, passing gate, or passing skill test");
    if (proposal.evaluation.testCommand !== undefined) {
      let commandMatched = false;
      for (const event of objectiveEvents) {
        if (event.type !== "EffectOutcomeRecorded") continue;
        const effectId = String((event.payload as any).effectId ?? "");
        const trajectory = await this.storage.loadEvents(allocation.sessionId, { branchId: allocation.branchId });
        const requested = trajectory.find((item) => item.sessionId === allocation.sessionId && item.branchId === allocation.branchId && item.type === "EffectRequested" && String((item.payload as any).effectId) === effectId);
        const payload = requested?.payload as any;
        if (payload?.executor === "shell" && payload?.operation === "run" && payload?.input?.command === proposal.evaluation.testCommand) commandMatched = true;
      }
      if (!commandMatched) throw new ValidationError("Objective evidence does not match the predeclared test command");
    }
    for (const event of objectiveEvents) if (event.type === "GoalGateStatusChanged") {
      const gateId = String((event.payload as any).gateId ?? "");
      const rows = await this.storage.readonlyQuery({ sql: "SELECT name FROM goal_gates WHERE gate_id=?", args: [gateId] });
      if (rows[0] && String((rows[0] as any).name) !== proposal.evaluation.name) throw new ValidationError("Passing gate evidence does not match the predeclared evaluation name");
    }
  }

  async #assertPromotion(proposal: RefinementProposalRecord, observations: EvaluationObservationRecord[]): Promise<void> {
    const scopes = await this.#proposalScopes(proposal);
    const successes = observations.filter((item) => item.success);
    if (scopes.includes("local") && successes.filter((item) => item.evidenceEventIds.length > 0).length < 1) throw new ValidationError("Local promotion requires one supported successful observation with durable evidence");
    if (scopes.includes("workspace")) { const successful=observations.filter((item)=>item.success&&item.objective&&item.evidenceEventIds.length>0); if(new Set(successful.map((item)=>item.allocationId)).size<2 || new Set(successful.flatMap((item)=>item.evidenceEventIds)).size<2) throw new ValidationError("Workspace promotion requires repeated objective successes in distinct allocations with distinct durable evidence"); }
    if (scopes.includes("user") || scopes.includes("global")) {
      const rows = await this.storage.readonlyQuery({ sql: "SELECT scope,approved_by FROM refinement_approvals WHERE proposal_id=?", args: [proposal.proposalId] });
      const approved = new Set(rows.filter((row:any)=>String(row.approved_by)===this.userScopeKey).map((row: any) => String(row.scope)));
      if (scopes.includes("user") && !approved.has("user")) throw new ValidationError("User-scope promotion requires explicit user approval from the requested authority");
      if (scopes.includes("global") && !approved.has("global")) throw new ValidationError("Global promotion requires explicit user approval from the current authority");
    }
  }
  async #proposal(proposalId: string): Promise<RefinementProposalRecord> {
    const rows = await this.storage.readonlyQuery({ sql: "SELECT * FROM refinement_proposals WHERE proposal_id=?", args: [proposalId] });
    if (!rows[0]) throw new NotFoundError("refinement proposal", proposalId); return rowToProposal(rows[0] as any);
  }
  async #allocation(allocationId: string): Promise<CandidateAllocationRecord> {
    const rows = await this.storage.readonlyQuery({ sql: "SELECT * FROM candidate_allocations WHERE allocation_id=?", args: [allocationId] });
    if (!rows[0]) throw new NotFoundError("candidate allocation", allocationId); return rowToAllocation(rows[0] as any);
  }
  async #session(sessionId: string, branchId: string) {
    const events = await this.storage.loadEvents(sessionId, { branchId }); if (!events.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`); return events[0]!;
  }
  async #scopeKey(sessionId: string, scope: HarnessScope, requested?: string): Promise<string> {
    const rows = await this.storage.readonlyQuery({ sql: "SELECT workspace_id FROM sessions WHERE session_id=?", args: [sessionId] });
    if (!rows[0]) throw new NotFoundError("session", sessionId);
    if(scope === "user" && requested === undefined) throw new ValidationError("User scope requires an explicit authority scopeKey");
    const authoritative = scope === "local" ? sessionId : scope === "workspace" ? String((rows[0] as any).workspace_id) : scope === "global" ? "global" : this.userScopeKey;
    if (requested !== undefined && requested !== authoritative) throw new ValidationError(`scopeKey is runtime-owned for ${scope} scope`);
    return authoritative;
  }
}

function assertOwner(proposal: RefinementProposalRecord, sessionId: string, branchId: string): void { if (proposal.sessionId !== sessionId || proposal.branchId !== branchId) throw new ValidationError("Refinement proposal belongs to another session branch"); }
function bounded(value: number, name: string, max: number): number { if (!Number.isInteger(value) || value < 1 || value > max) throw new ValidationError(`${name} must be an integer from 1 to ${max}`); return value; }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function isImmutablePolicyName(name: string): boolean { return /(?:base[-_ ]?policy|permissions?(?:[-_ ]?policy)?|safety[-_ ]?policy)/i.test(name.trim()); }
function assertEditShape(edit: HarnessEdit): void {
  if (!edit || !["create","replace","retire"].includes(edit.operation)) throw new ValidationError("Refinement edit must be typed create, replace, or retire");
  if (edit.operation === "create" && (typeof edit.name !== "string" || !edit.name.trim())) throw new ValidationError("Create edit requires a name");
  if (edit.operation !== "create" && (!edit.entryId?.trim() || !edit.expectedVersionId?.trim())) throw new ValidationError("Replace/retire edits require entryId and expectedVersionId");
  if (edit.operation === "replace" && !edit.content) throw new ValidationError("Replace edit requires content");
  if ("confidence" in edit && edit.confidence !== undefined && (!Number.isFinite(edit.confidence) || edit.confidence < 0 || edit.confidence > 1)) throw new ValidationError("Harness confidence must be between zero and one");
}
function validateContent(kind: HarnessKind, content: HarnessContent, errors: string[]): void {
  if (!content || typeof content !== "object" || content.kind !== kind) { errors.push(`Content kind does not match ${kind}`); return; }
  if ((kind === "memory" || kind === "prompt_note") && (typeof (content as any).text !== "string" || !(content as any).text.trim())) errors.push(`${kind} text cannot be empty`);
  if (kind === "memory" && !["claim","preference","decision","observation","constraint"].includes(String((content as any).memoryKind))) errors.push("Memory kind is invalid");
  const policyText = kind === "memory" || kind === "prompt_note" ? String((content as any).text ?? "") : kind === "subagent_spec" ? String((content as any).prompt ?? "") : "";
  if (/\b(ignore|override|disable|weaken|expand|change)\b.{0,40}\b(base policy|permission boundary|safety policy|permissions)\b/i.test(policyText)) errors.push("Harness content cannot modify immutable permission, safety, or base policy");
  if (kind === "skill") {
    const skill = content as Extract<HarnessContent,{kind:"skill"}>;
    if (typeof skill.description!=="string" || !skill.description.trim() || typeof skill.source!=="string" || !skill.source.trim() || skill.runtime !== "bun") errors.push("A skill requires description, TypeScript source, and Bun runtime compatibility");
    if (!Array.isArray(skill.tests) || skill.tests.length === 0 || skill.tests.some((test:any)=>!test||typeof test.name!=="string"||!("input" in test)||(!("expected" in test)&&typeof test.expectedError!=="string"))) errors.push("Generated skills require named compile/runtime tests with an expected value or error");
    if (!Array.isArray(skill.permissions) || skill.permissions.some((permission) => typeof permission!=="string" || !permission.trim() || /^(admin|root|policy|permission|\*)$/i.test(permission))) errors.push("A skill cannot expand immutable permission or safety policy");
    if(skill.inputSchema!==undefined) validateSchemaDefinition(skill.inputSchema,"inputSchema",errors);
  }
  if (kind === "subagent_spec") {
    const spec = content as Extract<HarnessContent,{kind:"subagent_spec"}>;
    if (typeof spec.role!=="string" || !spec.role.trim() || typeof spec.invocationCriteria!=="string" || !spec.invocationCriteria.trim() || typeof spec.expectedArtifact!=="string" || !spec.expectedArtifact.trim() || typeof spec.prompt!=="string" || !spec.prompt.trim()) errors.push("A subagent specification requires role, invocation criteria, expected artifact, and prompt");
    if(spec.model!==undefined && (typeof spec.model!=="object" || typeof (spec.model as any).provider!=="string" || typeof (spec.model as any).model!=="string")) errors.push("Subagent specification model policy is malformed");
    if(spec.budget!==undefined && (typeof spec.budget!=="object" || Object.values(spec.budget).some((value)=>typeof value!=="number"||!Number.isFinite(value)||value<0))) errors.push("Subagent specification budget is malformed");
  }
}
function validateSchemaDefinition(schema:JsonValue,path:string,errors:string[]):void { if(!schema||typeof schema!=="object"||Array.isArray(schema)){errors.push(`${path} must be a JSON Schema object`);return;}const rule=schema as Record<string,JsonValue>;const allowed=["object","array","string","number","integer","boolean","null"];if(rule.type!==undefined&&(typeof rule.type!=="string"||!allowed.includes(rule.type)))errors.push(`${path}.type is not supported`);if(rule.required!==undefined&&(!Array.isArray(rule.required)||rule.required.some((item)=>typeof item!=="string")))errors.push(`${path}.required must be string[]`);if(rule.properties!==undefined){if(!rule.properties||typeof rule.properties!=="object"||Array.isArray(rule.properties))errors.push(`${path}.properties must be an object`);else for(const [key,value]of Object.entries(rule.properties))validateSchemaDefinition(value,`${path}.properties.${key}`,errors);}if(rule.items!==undefined)validateSchemaDefinition(rule.items,`${path}.items`,errors);if(rule.enum!==undefined&&!Array.isArray(rule.enum))errors.push(`${path}.enum must be an array`);}
function parseJson<T>(value: unknown, fallback: T): T { if (value === null || value === undefined) return fallback; return JSON.parse(String(value)) as T; }
export function rowToVersion(row: any): HarnessVersionRecord {
  return { versionId: String(row.version_id), entryId: String(row.entry_id), version: Number(row.version), kind: String(row.kind) as HarnessKind, scope: String(row.scope) as HarnessScope, scopeKey: String(row.scope_key), name: String(row.name), content: parseJson(row.content_json, null) as unknown as HarnessContent, tags: parseJson(row.tags_json, []), confidence: Number(row.confidence), status: String(row.status) as HarnessVersionStatus, evidenceEventIds: parseJson(row.evidence_event_ids_json, []), conflictEntryIds: parseJson(row.conflict_entry_ids_json, []), supersedesVersionId: row.supersedes_version_id === null ? null : String(row.supersedes_version_id), proposalId: row.proposal_id === null ? null : String(row.proposal_id), createdBy: String(row.created_by), createdEventId: String(row.created_event_id), createdAt: String(row.created_at), lastConfirmedAt: String(row.last_confirmed_at) };
}
export function rowToHarness(row: any): HarnessRecord {
  const current = rowToVersion(row); return { entryId: String(row.entry_id), kind: String(row.kind) as HarnessKind, scope: String(row.scope) as HarnessScope, scopeKey: String(row.scope_key), name: String(row.name), currentVersionId: String(row.current_version_id), activeVersionId: row.active_version_id === null ? null : String(row.active_version_id), status: String(row.status) as HarnessVersionStatus, createdAt: String(row.created_at), updatedAt: String(row.updated_at), current };
}
function modelRowToHarness(row:any):HarnessRecord {
  const record = rowToHarness(row);
  // Do not leak an unexposed candidate pointer through currentVersionId when
  // returning an active baseline view.
  return { ...record, currentVersionId: record.current.versionId, status: record.current.status,
    createdAt: String(row.entry_created_at ?? row.created_at), updatedAt: String(row.entry_updated_at ?? row.updated_at) };
}
function rowToProposal(row: any): RefinementProposalRecord { return { proposalId: String(row.proposal_id), sessionId: String(row.session_id), branchId: String(row.branch_id), status: String(row.status) as RefinementProposalRecord["status"], trigger: String(row.trigger_text), predictedEffect: String(row.predicted_effect), edits: parseJson(row.edits_json, []), evidenceEventIds: parseJson(row.evidence_event_ids_json, []), evaluation: parseJson(row.evaluation_json, null) as unknown as ObjectiveEvaluation, authority: String(row.authority) as RefinementProposalRecord["authority"], ...(row.source_review_id === null || row.source_review_id === undefined ? {} : { sourceReviewId: String(row.source_review_id) }), ...(row.proposal_fingerprint === null || row.proposal_fingerprint === undefined ? {} : { proposalFingerprint: String(row.proposal_fingerprint) }), ...(row.validation_json === null ? {} : { validation: parseJson(row.validation_json, null) as JsonValue }), candidateId: row.candidate_id === null ? null : String(row.candidate_id), createdEventId: String(row.created_event_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function rowToAllocation(row: any): CandidateAllocationRecord { return { allocationId: String(row.allocation_id), candidateId: String(row.candidate_id), proposalId: String(row.proposal_id), sessionId: String(row.session_id), branchId: String(row.branch_id), taskId: row.task_id === null ? null : String(row.task_id), ordinal: Number(row.ordinal), exposedAt: row.exposed_at === null ? null : String(row.exposed_at), createdAt: String(row.created_at) }; }
function rowToObservation(row: any): EvaluationObservationRecord { return { observationId: String(row.observation_id), candidateId: String(row.candidate_id), allocationId: String(row.allocation_id), evaluator: String(row.evaluator), objective: Number(row.objective) === 1, success: Number(row.success) === 1, metric: parseJson(row.metric_json, null) as JsonValue, ...(row.baseline_json === null ? {} : { baseline: parseJson(row.baseline_json, null) as JsonValue }), evidenceEventIds: parseJson(row.evidence_event_ids_json, []), ...(row.notes === null ? {} : { notes: String(row.notes) }), createdAt: String(row.created_at) }; }
function rowToDecision(row: any): RefinementDecisionRecord { return { decisionId: String(row.decision_id), proposalId: String(row.proposal_id), candidateId: String(row.candidate_id), decision: String(row.decision) as RefinementDecisionRecord["decision"], rule: String(row.rule), evaluator: String(row.evaluator), ...(row.baseline_json === null ? {} : { baseline: parseJson(row.baseline_json, null) as JsonValue }), observationIds: parseJson(row.observation_ids_json, []), createdAt: String(row.created_at) }; }
function isObjectiveEvidence(event:AgentEvent):boolean { if(event.type==="EffectOutcomeRecorded") return (event.payload as any).outcome==="succeeded"; if(event.type==="GoalGateStatusChanged") return (event.payload as any).status==="passed"; if(event.type==="SkillTestRecorded") return (event.payload as any).passed===true; return false; }
function stableId(value:string):string { const hasher=new Bun.CryptoHasher("sha256");hasher.update(value);return hasher.digest("hex").slice(0,32); }
function promotionRule(proposal: RefinementProposalRecord, decision: string): string { return decision === "promote" ? `scope-sensitive-v1: ${proposal.evaluation.metric}` : `${decision}: observed candidate outcome`; }

import {
  newId, NotFoundError, projectEvents, type AgentEvent, type ContextRecordReference, type EventPayloads, type EventType,
  type HarnessRecord, type JsonValue,
} from "../domain/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import type { MemoryService } from "./memory.ts";
import type { HarnessService } from "./harness.ts";
import type { ProfileDatabase } from "../sync/index.ts";
import { rowToHarness } from "./harness.ts";
import type { SkillManagementService, SkillManagementView } from "./skill-management.ts";
import { effectiveCompaction } from "./context-compaction.ts";

export const BASE_POLICY = "You are a durable coding agent running in trusted local mode. Use the TypeScript console and typed SDK for mutation. SQL is read-only. Raw SQL is a trusted diagnostic channel over shared, non-confidential projections; candidate exposure is behavioral isolation, not a confidentiality boundary. Persist every value needed after a cell boundary. Never infer success for an unknown external effect. The worker is process-isolated, not a security sandbox.";
export const IMMUTABLE_BASE_POLICY = Object.freeze({ id: "agencity-base-policy", version: 1, text: BASE_POLICY });
function hash(value: string): string { const hasher = new Bun.CryptoHasher("sha256"); hasher.update(value); return hasher.digest("hex"); }

export interface ContextMaterializeOptions {
  /** Stable runtime-derived identity used by recoverable agent-run steps. */
  readonly contextId?: string;
  readonly idempotencyKey?: string;
  /** Additional canonical evidence which must be present in the context provenance. */
  readonly additionalRecordIds?: readonly string[];
  /** Builds the exact provider-facing context while preserving normal harness selection/provenance. */
  readonly transform?: (context: JsonValue) => JsonValue;
}

export class ContextMaterializer {
  #skillCatalog: SkillManagementService | null = null;
  constructor(readonly storage: AgentStorage, readonly memory?: MemoryService, readonly harness?: HarnessService, readonly maxRecentRecords = 30, readonly userScopeKey = "default-user", readonly profile?: ProfileDatabase) {}
  attachSkillCatalog(catalog: SkillManagementService): void { this.#skillCatalog = catalog; }

  async materialize(sessionId: string, branchId: string, options: ContextMaterializeOptions = {}): Promise<{ contextId: string; context: JsonValue; event: AgentEvent<"ContextMaterialized"> }> {
    let events = await this.storage.loadEvents(sessionId, { branchId });
    if (!events.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    let state = projectEvents(events);

    // Allocation and actual exposure are distinct durable facts. Materializing
    // an allocated candidate consumes its bounded exposure exactly once.
    const candidateProvenance: JsonValue[] = [];
    if (this.harness) {
      const allocations = await this.storage.readonlyQuery({ sql: "SELECT a.*,p.status FROM candidate_allocations a JOIN refinement_proposals p ON p.proposal_id=a.proposal_id WHERE a.session_id=? AND a.branch_id=? AND p.status='candidate' ORDER BY a.ordinal,a.allocation_id", args: [sessionId,branchId] });
      let newlyExposed = false;
      for (const row of allocations as any[]) {
        const exposed = row.exposed_at === null
          ? await this.harness.exposeIfAvailable(sessionId,branchId,String(row.proposal_id),String(row.allocation_id))
          : row;
        // A valid control allocation can outnumber the exposure budget. It is
        // deliberately omitted from both context and model-visible provenance.
        if (!exposed) continue;
        newlyExposed ||= row.exposed_at === null;
        candidateProvenance.push({ allocationId: String(row.allocation_id), candidateId: String(row.candidate_id), proposalId: String(row.proposal_id), exposedAt: (exposed as any).exposedAt ?? String(row.exposed_at) });
      }
      if (newlyExposed) { events = await this.storage.loadEvents(sessionId,{branchId}); state = projectEvents(events); }
    }

    const effective = effectiveCompaction(state, events);
    const effectiveContext = effective?.contextId ? state.contexts[effective.contextId] : undefined;
    const legacyEvent = effective ? undefined : [...events].reverse().find((event) => event.type === "ContextMaterialized" && (event.payload as EventPayloads["ContextMaterialized"]).context && typeof (event.payload as EventPayloads["ContextMaterialized"]).context === "object" && !Array.isArray((event.payload as EventPayloads["ContextMaterialized"]).context) && ((event.payload as EventPayloads["ContextMaterialized"]).context as Record<string,JsonValue>).kind === "compaction");
    const legacyContext = legacyEvent ? (legacyEvent.payload as EventPayloads["ContextMaterialized"]).context as Record<string,JsonValue> : undefined;
    const coveredMessageIds = new Set<string>(effective?.sourceEventIds ?? (Array.isArray(legacyContext?.sourceEventIds) ? legacyContext.sourceEventIds.filter((value): value is string => typeof value === "string") : []));
    const messages = state.messages.filter((message) => !coveredMessageIds.has(message.eventId));
    const compactions: JsonValue[] = effective && effectiveContext?.derivation
      ? [{ eventId: effectiveContext.eventId, contextId: effectiveContext.id, ...effectiveContext.derivation } as unknown as JsonValue]
      : legacyEvent && legacyContext ? [{ eventId: legacyEvent.id, ...legacyContext } as JsonValue] : [];
    const selected = new Map<string, { event: AgentEvent; reason: string }>();
    const add = (event: AgentEvent | undefined | null, reason: string) => { if (event) selected.set(event.id,{event,reason}); };
    add(events.find((event) => event.type === "SessionCreated"), "session model, workspace, and budget policy");
    add([...events].reverse().find((event) => event.type === "BranchCreated"), "active branch ancestry");
    add([...events].reverse().find((event) => event.type === "SessionStatusChanged"), "current session status");
    if (effective && effectiveContext?.derivation) {
      add(events.find((event) => event.id === effectiveContext.eventId), `effective context compaction ${effective.strategy}`);
      add(events.find((event) => event.id === effective.requestEventId), "typed compaction request and exact frozen source manifest");
      for (const eventId of effective.sourceEventIds) add(events.find((event) => event.id === eventId), `narrative source covered by effective ${effective.strategy} summary`);
    } else if (legacyEvent) add(legacyEvent, "legacy version-1 compaction derivation");
    for (const message of messages) add(events.find((event) => event.id === message.eventId), "uncovered conversation narrative");
    for (const value of Object.values(state.workingValues)) add(events.find((event) => event.id === value.eventId), "active working value");
    for (const artifact of Object.values(state.artifacts)) add([...events].reverse().find((event) => event.type === "ArtifactRegistered" && (event.payload as {artifactId?:string}).artifactId === artifact.artifactId), "active artifact reference");
    for (const event of events) if (["BudgetDebited","TaskUsageAttributed","BudgetExceeded"].includes(event.type)) add(event,"current budget projection");
    for (const task of Object.values(state.tasks)) add(events.find((event) => event.id === task.eventId),"current child task");
    for (const message of Object.values(state.mailbox)) add(events.find((event) => event.id === message.eventId),"session mailbox");
    for (const notice of Object.values(state.terminalNotices)) add(events.find((event) => event.id === notice.eventId),"child terminal notice");
    for (const goal of Object.values(state.goals)) add(events.find((event) => event.id === goal.eventId),"current autonomous goal");
    for (const heartbeat of Object.values(state.heartbeats)) add(events.find((event) => event.id === heartbeat.eventId),"scheduled heartbeat");
    for (const schedule of Object.values(state.schedules)) add(events.find((event) => event.id === schedule.eventId),"scheduled autonomous work");
    for (const wake of Object.values(state.wakes)) add(events.find((event) => event.id === wake.eventId),"durable wake delivery state");
    for (const run of Object.values(state.agentRuns)) if (!["succeeded","blocked","failed","cancelled","budget_exceeded","unknown"].includes(run.status)) add(events.find((event) => event.id === run.eventId),"active agent run control state");
    for (const handle of Object.values(state.recursiveModels)) add(events.find((event) => event.id === handle.eventId),"recursive model handle");
    const activity = events.filter((event) => ["EffectOutcomeRecorded","EffectReconciliationRecorded","CellCommitted","CellFailed","TaskStatusChanged","GoalGateStatusChanged","RefinementObservationRecorded","RefinementDecided"].includes(event.type)).slice(-this.maxRecentRecords);
    for (const event of activity) add(event,"recent durable activity");

    const latestPrompt = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const memoryResult = this.memory ? await this.memory.search(sessionId,branchId,latestPrompt,{limit:12,statuses:["active"]}) : {items:[],provenance:{query:latestPrompt,normalizedQuery:"",index:"fts5",filters:{},generatedCandidateVersionIds:[],candidates:[],rejections:[],conflicts:[],selections:[]}};
    const harnessRows = await this.#activeHarness(state.workspaceId,sessionId);
    const candidateRows = await this.#candidateHarness(candidateProvenance,state.workspaceId,sessionId);
    const retiredByCandidate = new Set<string>();
    for (const candidate of candidateProvenance as any[]) {
      const proposals = await this.storage.readonlyQuery({sql:"SELECT edits_json FROM refinement_proposals WHERE proposal_id=?",args:[String(candidate.proposalId)]});
      for (const edit of proposals[0] ? JSON.parse(String((proposals[0] as any).edits_json)) as any[] : []) if (edit.operation === "retire") retiredByCandidate.add(String(edit.entryId));
    }
    const exact = new Map<string,HarnessRecord>();
    for (const record of harnessRows) if (!retiredByCandidate.has(record.entryId)) exact.set(record.entryId,record);
    for (const record of candidateRows) exact.set(record.entryId,record);
    // Memory search is the authoritative task-specific active-memory selection;
    // candidate memories are explicit allocation overlays.
    const candidateMemories = [...exact.values()].filter((record) => record.kind === "memory" && record.current.status === "candidate");
    const candidateMemoryIds=new Set(candidateMemories.map((item)=>item.entryId));
    const memories = [...memoryResult.items.map((item:any) => item.record).filter((item:HarnessRecord)=>!candidateMemoryIds.has(item.entryId)&&!retiredByCandidate.has(item.entryId)),...candidateMemories];
    const promptNotes = [...exact.values()].filter((record) => record.kind === "prompt_note");
    const managedSkills = this.#skillCatalog ? await this.#skillCatalog.contextSkills(sessionId,branchId) : [];
    const managedHarnessIds = new Set(managedSkills.filter((item) => item.source === "harness").map((item) => `${item.entryId}:${item.versionId}`));
    const skills = [...exact.values()].filter((record) => record.kind === "skill" && (!this.#skillCatalog || managedHarnessIds.has(`${record.entryId}:${record.current.versionId}`)));
    const profileSkillSelections = managedSkills.filter((item) => item.source === "profile");
    const specs = [...exact.values()].filter((record) => record.kind === "subagent_spec");
    for (const record of [...memories,...promptNotes,...skills,...specs]) add(await this.storage.getEvent(record.current.createdEventId),`exact harness ${record.kind} ${record.entryId}@${record.current.versionId}`);
    for (const eventId of options.additionalRecordIds ?? []) add(events.find((event) => event.id === eventId) ?? await this.storage.getEvent(eventId), "agent-run exact dependent evidence");

    const ordered = [...selected.values()].sort((left,right) => BigInt(left.event.cursor) < BigInt(right.event.cursor) ? -1 : BigInt(left.event.cursor) > BigInt(right.event.cursor) ? 1 : left.event.id.localeCompare(right.event.id));
    const references: ContextRecordReference[] = ordered.map(({event,reason}) => ({eventId:event.id,type:event.type as EventType,schemaVersion:event.schemaVersion,reason}));
    const harnessProvenance = JSON.parse(JSON.stringify({
      basePolicy: { id: IMMUTABLE_BASE_POLICY.id, version: IMMUTABLE_BASE_POLICY.version, digest: hash(BASE_POLICY), mutable: false },
      retrieval: { ...memoryResult.provenance, candidateOverlay: { replacements: candidateMemories.map((item)=>({entryId:item.entryId,versionId:item.current.versionId})), retirements: [...retiredByCandidate].sort(), finalSelections: memories.map((item,index)=>({entryId:item.entryId,versionId:item.current.versionId,rank:index+1})) } },
      candidates: candidateProvenance,
      selections: [
        ...[...memories,...promptNotes,...skills,...specs].map((record) => ({entryId:record.entryId,versionId:record.current.versionId,kind:record.kind,scope:record.scope,status:record.current.status,createdEventId:record.current.createdEventId})),
        ...profileSkillSelections.map((record) => ({entryId:record.entryId,versionId:record.versionId,kind:"skill",scope:"global",status:"active",source:"profile",digest:record.digest,provenance:record.provenance})),
      ],
      candidateRetirements: [...retiredByCandidate].sort(),
    })) as JsonValue;
    const profilePreferences = this.profile ? await this.profile.listPreferences() : [];
    // Compatibility rows are retained in profile history and management views,
    // but never enter ordinary executable context until reinstalled and tested.
    const profileSkills = profileSkillSelections.map(publicManagedSkill);
    const providerConfigurations = this.profile ? (await this.profile.listCredentialReferences()).map(({reference,provider,label,metadata})=>({reference,provider,label,metadata})) : [];
    const baseContext: JsonValue = JSON.parse(JSON.stringify({
      basePolicy: BASE_POLICY,
      basePolicyRecord: { id: IMMUTABLE_BASE_POLICY.id, version: IMMUTABLE_BASE_POLICY.version, digest: hash(BASE_POLICY), mutable: false },
      runtime: { mode:"trusted-local",workerIsSecuritySandbox:false,rawSql:{readOnly:true,scope:"shared-non-confidential-diagnostics",candidateIsolationIsConfidentialityBoundary:false} },
      profile: { preferences: profilePreferences, globalSkills: profileSkills, providerConfigurations },
      session: { id:sessionId,branchId,status:state.status,model:state.model,parentSessionId:state.parentSessionId,parentBranchId:state.parentBranchId,rootSessionId:state.rootSessionId,depth:state.depth,taskId:state.taskId },
      budget: state.budget,
      goal: Object.values(state.goals).find((goal) => !["completed","failed","cancelled"].includes(goal.status)) ?? null,
      tasks:Object.values(state.tasks),mailbox:Object.values(state.mailbox),terminalNotices:Object.values(state.terminalNotices),recursiveModels:Object.values(state.recursiveModels),
      unknownEffectReconciliations:Object.values(state.effectReconciliations),
      documents:Object.values(state.documents).map((document)=>({id:document.id,name:document.name,mediaType:document.mediaType,size:document.size,digest:document.digest,chunkCount:document.chunkCount})),
      inputSets:Object.values(state.inputSets),heartbeats:Object.values(state.heartbeats),schedules:Object.values(state.schedules),wakes:Object.values(state.wakes),
      activeRuns:Object.values(state.agentRuns).filter((run)=>!["succeeded","blocked","failed","cancelled","budget_exceeded","unknown"].includes(run.status)),
      harness: {
        promptNotes: promptNotes.map(publicHarness),
        memories: memories.map(publicHarness),
        skills: [...skills.map(publicSkill),...profileSkillSelections.map(publicManagedSkill)],
        subagentSpecs: specs.map(publicSpec),
      },
      compactions,
      messages:messages.map((message)=>({role:message.role,content:message.content,eventId:message.eventId,...(message.mailbox === undefined ? {} : { mailbox: message.mailbox })})),
      workingValues:Object.values(state.workingValues).map((value)=>({name:value.name,version:value.version,value:value.value,eventId:value.eventId})),artifacts:Object.values(state.artifacts),
      recentActivity:activity.map((event)=>({eventId:event.id,type:event.type,payload:event.payload})),
      queryHints:{history:"SELECT type, committed_at, payload_json FROM events WHERE session_id = ? ORDER BY sequence",largeRecords:"Resolve artifact references through sdk.artifacts.get",documents:"SELECT chunk_id, ordinal, content FROM document_chunks WHERE document_id = ? ORDER BY ordinal",mailbox:"SELECT * FROM mailbox_messages WHERE to_session_id = ? ORDER BY sent_at",memory:"Use Supervisor.memory.search; candidate generation is FTS5 and scope/status policy remains authoritative"},
    })) as JsonValue;
    const context = options.transform ? options.transform(baseContext) : baseContext;
    const contextId=options.contextId ?? newId(); const [event]=await this.storage.appendEvents([{sessionId,branchId,type:"ContextMaterialized",producer:"supervisor",idempotencyKey:options.idempotencyKey ?? `context:${contextId}`,payload:{contextId,records:references,contentHash:hash(JSON.stringify(context)),context,harnessProvenance}}]);
    if (!event) throw new Error("Context was not committed"); return {contextId,context,event:event as AgentEvent<"ContextMaterialized">};
  }

  async #activeHarness(workspaceId:string,sessionId:string):Promise<HarnessRecord[]> {
    const rows=await this.storage.readonlyQuery({sql:"SELECT v.*,e.current_version_id,e.active_version_id,e.status AS entry_status,e.created_at AS entry_created_at,e.updated_at AS entry_updated_at FROM harness_entries e JOIN harness_versions v ON v.version_id=e.active_version_id WHERE (e.scope='local' AND e.scope_key=?) OR (e.scope='workspace' AND e.scope_key=?) OR (e.scope='user' AND e.scope_key=?) OR e.scope='global' ORDER BY e.scope,e.kind,e.name,e.entry_id",args:[sessionId,workspaceId,this.userScopeKey]});
    return rows.map((row:any)=>rowToHarnessWithEntry(row));
  }
  async #candidateHarness(candidateProvenance:JsonValue[],workspaceId:string,sessionId:string):Promise<HarnessRecord[]> {
    const result:HarnessRecord[]=[];
    for (const candidate of candidateProvenance as any[]) {
      const rows=await this.storage.readonlyQuery({sql:"SELECT v.*,e.current_version_id,e.active_version_id,e.status AS entry_status,e.created_at AS entry_created_at,e.updated_at AS entry_updated_at FROM harness_versions v JOIN harness_entries e ON e.entry_id=v.entry_id WHERE v.proposal_id=? AND v.status='candidate' ORDER BY v.version_id",args:[String(candidate.proposalId)]});
      result.push(...rows.map((row:any)=>rowToHarnessWithEntry(row)).filter((record)=>record.scope==="local" ? record.scopeKey===sessionId : record.scope==="workspace" ? record.scopeKey===workspaceId : record.scope==="user" ? record.scopeKey===this.userScopeKey : true));
    }
    return result;
  }
}
function rowToHarnessWithEntry(row:any):HarnessRecord { const record=rowToHarness(row); return {...record,status:String(row.entry_status ?? row.status) as any,createdAt:String(row.entry_created_at ?? row.created_at),updatedAt:String(row.entry_updated_at ?? row.updated_at)}; }
function publicHarness(record:HarnessRecord) { return {entryId:record.entryId,versionId:record.current.versionId,name:record.name,kind:record.kind,scope:record.scope,scopeKey:record.scopeKey,status:record.current.status,confidence:record.current.confidence,tags:record.current.tags,content:record.current.content,evidenceEventIds:record.current.evidenceEventIds,conflictEntryIds:record.current.conflictEntryIds}; }

function publicSkill(record:HarnessRecord) { const content=record.current.content.kind==="skill" ? record.current.content : null; return {entryId:record.entryId,versionId:record.current.versionId,name:record.name,scope:record.scope,status:record.current.status,confidence:record.current.confidence,tags:record.current.tags,description:content?.description ?? "",inputSchema:content?.inputSchema ?? null,permissions:content?.permissions ?? [],runtime:content?.runtime ?? "bun"}; }
function publicManagedSkill(record:SkillManagementView) { return {entryId:record.entryId,versionId:record.versionId,name:record.name,scope:record.scope,status:record.availability,source:record.source,digest:record.digest,description:record.description,inputSchema:record.inputSchema,permissions:record.permissions,provenance:record.provenance,runtime:record.runtime}; }
function publicSpec(record:HarnessRecord) { const content=record.current.content.kind==="subagent_spec" ? record.current.content : null; return {entryId:record.entryId,versionId:record.current.versionId,name:record.name,scope:record.scope,status:record.current.status,confidence:record.current.confidence,tags:record.current.tags,role:content?.role ?? "",invocationCriteria:content?.invocationCriteria ?? "",expectedArtifact:content?.expectedArtifact ?? ""}; }

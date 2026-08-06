import {
  SkillResolutionError,
  ValidationError,
  newId,
  canonicalSkillDigest,
  isSkillContextEligible,
  resolveSkillCatalog,
  type HarnessVersionRecord,
  type JsonValue,
  type SkillAvailability,
  type SkillCandidateExposure,
  type SkillCatalogRecord,
  type SkillResolutionPolicy,
  type SkillTestReport,
  type TypeScriptSkillDefinition,
} from "../domain/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import type { ProfileDatabase, ProfileGlobalSkillRecord, ProfileGlobalSkillVersion } from "../sync/index.ts";
import { parseSkillImportBundle, type SkillImportBundle } from "./skill-import.ts";
import type { HarnessService } from "./harness.ts";
import type { RefinerService, RefinementReviewRecord } from "./refiner.ts";
import type { ExecutableSkillCatalog, ResolvedExecutableSkill, SkillService } from "./skills.ts";

export type SkillInstallScope = "workspace" | "profile";
export interface SkillManagementView {
  readonly entryId: string;
  readonly versionId: string;
  readonly name: string;
  readonly source: "harness" | "profile";
  readonly scope: "local" | "workspace" | "user" | "global";
  readonly availability: SkillAvailability;
  readonly digest: string;
  readonly provenance: JsonValue;
  readonly latestTest: JsonValue | null;
  readonly permissions: readonly string[];
  readonly description: string;
  readonly inputSchema: JsonValue | null;
  readonly runtime: "bun";
  readonly legacy: boolean;
}
export interface SkillImportPreview { readonly name: string; readonly confirmationDigest: string; readonly bundle: SkillImportBundle; }
export interface InstallLocalSkillInput { readonly directory: string; readonly scope: SkillInstallScope; readonly confirmationDigest: string; readonly installedBy?: string; }

interface CatalogDefinition { readonly record: SkillCatalogRecord; readonly definition: TypeScriptSkillDefinition; readonly viewProvenance?: JsonValue; }

/** Unified product catalog over canonical workspace harness history and the separate profile-global store. */
export class SkillManagementService implements ExecutableSkillCatalog {
  constructor(
    readonly storage: AgentStorage,
    readonly profile: ProfileDatabase,
    readonly harness: HarnessService,
    readonly skills: SkillService,
    readonly refiner: RefinerService,
    readonly userScopeKey = "default-user",
    readonly profileScopeKey = "default-profile",
  ) {}

  async previewImport(directory: string): Promise<SkillImportPreview> {
    const bundle = await parseSkillImportBundle(directory, { permissionAllowlist: [...this.skills.permissionAllowlist] });
    return { name: bundle.name, confirmationDigest: bundle.provenance.source.sha256, bundle };
  }

  async installLocal(sessionId: string, branchId: string, input: InstallLocalSkillInput): Promise<SkillManagementView> {
    if (input.scope !== "workspace" && input.scope !== "profile") throw new ValidationError("Skill install scope must be workspace or profile");
    const preview = await this.previewImport(input.directory);
    if (!input.confirmationDigest || input.confirmationDigest !== preview.confirmationDigest) {
      throw new ValidationError(`Explicit confirmation must exactly match inspected source digest ${preview.confirmationDigest}`);
    }
    const installedBy = input.installedBy?.trim() || this.userScopeKey;
    if (input.scope === "profile") return this.#installProfile(sessionId, branchId, preview.bundle, installedBy);
    return this.#installWorkspace(sessionId, branchId, preview.bundle, installedBy);
  }

  /** Agent-driven creation remains a constrained ordinary Refiner review, never a direct active write. */
  async propose(sessionId: string, branchId: string, instructions: string, scope: "local" | "workspace" = "workspace"): Promise<RefinementReviewRecord> {
    return this.refiner.createSkill(sessionId, branchId, { instructions, requestedScope: scope });
  }

  async list(sessionId: string, branchId: string, options: { readonly includeUnavailable?: boolean } = {}): Promise<SkillManagementView[]> {
    const policy = await this.#policy(sessionId, branchId);
    const catalog = await this.#catalog();
    const visible = options.includeUnavailable ? catalog : catalog.filter(({ record }) => isSkillContextEligible(record, policy));
    const views = visible.map(item => view(item));
    if (options.includeUnavailable) {
      for (const item of await this.profile.listGlobalSkillCatalog({ includeUnavailable: true })) {
        if (item.definitionFormat !== "legacy") continue;
        views.push({ entryId:item.skillId,versionId:item.versionId,name:item.name,source:"profile",scope:"global",availability:"disabled",digest:item.digest,provenance:item.provenance as unknown as JsonValue,latestTest:null,permissions:[],description:"Legacy profile row retained but quarantined from execution until reinstalled as a tested TypeScript skill.",inputSchema:null,runtime:"bun",legacy:true });
      }
    }
    return views.sort((a,b)=>a.name.localeCompare(b.name)||a.scope.localeCompare(b.scope)||a.entryId.localeCompare(b.entryId));
  }

  async get(sessionId: string, branchId: string, reference: string): Promise<SkillManagementView> {
    const item = await this.#managementResolve(sessionId, branchId, reference);
    if (item) return view(item);
    const legacy = (await this.profile.listGlobalSkillCatalog({includeUnavailable:true})).filter(row=>row.definitionFormat==="legacy"&&(row.skillId===reference||row.versionId===reference||row.name===reference));
    if (legacy.length > 1) throw new SkillResolutionError("AMBIGUOUS", "Legacy skill management reference is ambiguous", legacy.map(item=>`profile:${item.skillId}:${item.versionId}`));
    if (legacy[0]) return { entryId:legacy[0].skillId,versionId:legacy[0].versionId,name:legacy[0].name,source:"profile",scope:"global",availability:"disabled",digest:legacy[0].digest,provenance:legacy[0].provenance as unknown as JsonValue,latestTest:null,permissions:[],description:"Legacy profile row retained but quarantined from execution until reinstalled as a tested TypeScript skill.",inputSchema:null,runtime:"bun",legacy:true };
    throw new SkillResolutionError("NOT_FOUND", "Skill was not found");
  }

  async test(sessionId: string, branchId: string, reference: string): Promise<SkillTestReport> {
    const item = await this.#managementResolve(sessionId,branchId,reference);
    if (!item) throw new SkillResolutionError("NOT_FOUND","Skill was not found");
    if (item.record.availability === "candidate") return this.skills.testModelVisible(sessionId,branchId,item.record.entryId,item.record.versionId,`skill-management-test:${item.record.source}:${item.record.versionId}:${Date.now()}`);
    return this.skills.testDefinition(sessionId,branchId,item.record.entryId,item.record.versionId,item.definition,`skill-management-test:${item.record.source}:${item.record.versionId}:${Date.now()}`);
  }

  async enable(sessionId:string,branchId:string,reference:string):Promise<SkillManagementView>{return this.#availability(sessionId,branchId,reference,"enabled");}
  async disable(sessionId:string,branchId:string,reference:string):Promise<SkillManagementView>{return this.#availability(sessionId,branchId,reference,"disabled");}
  async remove(sessionId:string,branchId:string,reference:string):Promise<SkillManagementView>{return this.#availability(sessionId,branchId,reference,"removed");}

  async resolveExecutable(sessionId: string, branchId: string, reference: string, options: { readonly versionId?: string; readonly allowCandidate?: boolean } = {}): Promise<ResolvedExecutableSkill> {
    const items = await this.#catalog();
    const records = items.map(item=>item.record).filter(record=>options.allowCandidate!==false||record.availability!=="candidate");
    const policy = await this.#policy(sessionId,branchId);
    const resolution = resolveSkillCatalog(records, options.versionId ?? reference, policy);
    if (options.versionId && resolution.record.entryId !== reference && resolution.record.name !== reference) throw new SkillResolutionError("NOT_FOUND","Pinned skill version does not belong to the requested skill");
    const item=items.find(candidate=>candidate.record.source===resolution.record.source&&candidate.record.entryId===resolution.record.entryId&&candidate.record.versionId===resolution.record.versionId)!;
    return {entryId:item.record.entryId,versionId:item.record.versionId,definition:item.definition,candidate:item.record.availability==="candidate"};
  }

  async contextSkills(sessionId:string,branchId:string):Promise<SkillManagementView[]>{return this.list(sessionId,branchId);}

  async #availability(sessionId:string,branchId:string,reference:string,target:"enabled"|"disabled"|"removed"):Promise<SkillManagementView>{
    const item=await this.#managementResolve(sessionId,branchId,reference);if(!item)throw new SkillResolutionError("NOT_FOUND","Skill was not found");
    const record=item.record;
    if(record.availability==="removed")throw new ValidationError("Removed skills retain immutable history and cannot be re-enabled");
    if(target==="enabled"&&record.latestTest?.outcome!=="passed")throw new ValidationError("A passing same-version test is required before enabling a skill");
    if(record.source==="profile"){
      const changed=await this.profile.setGlobalSkillAvailability({skillId:record.entryId,availability:target,expectedVersionId:record.versionId,expectedDigest:record.digest,idempotencyKey:`skill-${target}:${record.entryId}:${record.versionId}`});
      const mapped=await this.#profileCatalog(changed);if(!mapped)throw new ValidationError("Legacy profile skills cannot be enabled through the typed catalog");return view(mapped);
    }
    if(record.availability!==target)await this.storage.appendEvents([{sessionId,branchId,type:"SkillAvailabilityChanged",producer:"client",idempotencyKey:`skill-${target}:${record.entryId}:${record.versionId}`,payload:{entryId:record.entryId,versionId:record.versionId,digest:record.digest,availability:target,reason:`User requested skill ${target}`}}]);
    return this.get(sessionId,branchId,record.entryId);
  }

  async #installProfile(sessionId:string,branchId:string,bundle:SkillImportBundle,installedBy:string):Promise<SkillManagementView>{
    const definition=bundle.definition;const digest=canonicalSkillDigest(definition as unknown as JsonValue);const skillId=`profile-skill-${bundle.name}`;const versionId=`profile-version-${digest.slice(0,40)}`;
    const report=await this.skills.testDefinition(sessionId,branchId,skillId,versionId,definition,`profile-skill-stage-test:${versionId}`);const passed=passedReport(report);const current=await this.profile.getGlobalSkill(skillId,{includeUnavailable:true});
    const staged=await this.profile.stageGlobalSkill({skillId,versionId,name:bundle.name,definition,provenance:{source:"local-directory",reference:bundle.provenance.directory,manifestDigest:bundle.provenance.manifest.sha256,sourceDigest:bundle.provenance.source.sha256,installedBy},testReport:{testId:report.effectId,testedAt:new Date().toISOString(),compiled:report.compiled,passed:report.passed,failed:report.failed,outcome:passed?"passed":"failed"},effectRef:report.effectId,availability:passed?"enabled":"disabled",idempotencyKey:`stage:${versionId}`,...(current?{expectedCurrentVersionId:current.versionId,expectedCurrentDigest:current.digest}:{expectedCurrentVersionId:null,expectedCurrentDigest:null})});
    const mapped=await this.#profileCatalog(staged);if(!mapped)throw new Error("Staged TypeScript profile skill was not catalogued");return view(mapped);
  }

  async #installWorkspace(sessionId:string,branchId:string,bundle:SkillImportBundle,installedBy:string):Promise<SkillManagementView>{
    const proposed=await this.harness.propose(sessionId,branchId,{trigger:`Install inspected local skill ${bundle.name}`,predictedEffect:`Make ${bundle.name} available in this workspace`,authority:"user",edits:[{operation:"create",kind:"skill",scope:"workspace",name:bundle.name,content:{kind:"skill",...bundle.definition},tags:["local-import"],confidence:1}],evaluation:{kind:"objective",name:`${bundle.name} tests`,metric:"skillTestsPassed",target:true,baseline:false}});
    await this.harness.validate(sessionId,branchId,proposed.proposalId);await this.harness.activate(sessionId,branchId,proposed.proposalId,{allocationLimit:2,exposureLimit:2});
    const versions=(await this.storage.readonlyQuery({sql:"SELECT entry_id,version_id FROM harness_versions WHERE proposal_id=? AND kind='skill'",args:[proposed.proposalId]}));const entryId=String((versions[0] as any).entry_id),versionId=String((versions[0] as any).version_id);
    for(let index=0;index<2;index++){
      let targetBranchId=branchId;
      if(index>0){const history=await this.storage.loadEvents(sessionId,{branchId});const fork=history.at(-1);if(!fork)throw new ValidationError("Cannot create a skill evaluation branch without retained history");targetBranchId=newId();await this.storage.appendEvents([{sessionId,branchId:targetBranchId,type:"BranchCreated",producer:"supervisor",idempotencyKey:`skill-evaluation-branch:${proposed.proposalId}`,payload:{branchId:targetBranchId,parentBranchId:branchId,forkCursor:fork.cursor,name:`skill-evaluation-${bundle.name}`}}]);}
      const allocation=await this.harness.allocate(sessionId,branchId,proposed.proposalId,{sessionId,branchId:targetBranchId});await this.harness.expose(sessionId,targetBranchId,proposed.proposalId,allocation.allocationId);const report=await this.skills.testModelVisible(sessionId,targetBranchId,entryId,versionId,`skill-import-exposed-test:${versionId}:${allocation.allocationId}`);const events=await this.storage.readonlyQuery({sql:"SELECT event_id FROM skill_executions WHERE version_id=? AND effect_id=? AND execution_kind='test'",args:[versionId,report.effectId]});const evidenceEventId=String((events[0] as any).event_id);await this.harness.recordObservation(sessionId,branchId,proposed.proposalId,{allocationId:allocation.allocationId,evaluator:"skill-import-tests-v1",objective:true,success:passedReport(report),metric:{skillTestsPassed:passedReport(report)},baseline:false,evidenceEventIds:[evidenceEventId]});
    }
    await this.harness.decide(sessionId,branchId,proposed.proposalId,{decision:"promote",evaluator:"skill-import-tests-v1"});
    const digest=canonicalSkillDigest(({kind:"skill",...bundle.definition}) as unknown as JsonValue);
    await this.storage.appendEvents([{sessionId,branchId,type:"SkillImported",producer:"client",idempotencyKey:`skill-imported:${versionId}`,payload:{entryId,versionId,digest,scope:"workspace",origin:{kind:"local-directory",reference:bundle.provenance.directory,manifestDigest:bundle.provenance.manifest.sha256,sourceDigest:bundle.provenance.source.sha256},installedBy}}]);
    return this.get(sessionId,branchId,entryId);
  }

  async #managementResolve(sessionId:string,branchId:string,reference:string):Promise<CatalogDefinition|null>{
    if(typeof reference!=="string"||!reference.trim())throw new ValidationError("Skill reference is required");
    const items=await this.#catalog();const policy=await this.#policy(sessionId,branchId);
    const versions=items.filter(item=>item.record.versionId===reference&&scopeAllowed(item.record,policy));
    if(versions.length===1)return versions[0]!;
    const entries=items.filter(item=>item.record.entryId===reference&&scopeAllowed(item.record,policy));
    if(entries.length)return currentManagementVersion(entries);
    const named=items.filter(item=>item.record.name===reference&&scopeAllowed(item.record,policy));
    const byEntry=new Map<string,CatalogDefinition[]>();for(const item of named){const key=`${item.record.source}:${item.record.entryId}`;byEntry.set(key,[...(byEntry.get(key)??[]),item]);}
    const considered=[...byEntry.values()].map(currentManagementVersion);
    if(considered.length>1)throw new SkillResolutionError("AMBIGUOUS","Skill management reference is ambiguous",considered.map(item=>`${item.record.source}:${item.record.entryId}:${item.record.versionId}`));
    return considered[0]??null;
  }

  async #catalog():Promise<CatalogDefinition[]>{
    const harnessRows=await this.storage.readonlyQuery({sql:"SELECT DISTINCT v.* FROM harness_entries e JOIN harness_versions v ON v.entry_id=e.entry_id AND (v.version_id=e.current_version_id OR v.version_id=e.active_version_id) WHERE v.kind='skill' ORDER BY v.created_at,v.version_id",args:[]});const result:CatalogDefinition[]=[];
    for(const row of harnessRows as any[]){
      const definition=harnessDefinition(row);const digest=canonicalSkillDigest(({kind:"skill",...definition}) as unknown as JsonValue);const versionId=String(row.version_id),entryId=String(row.entry_id);
      const test=await this.#latestHarnessTest(versionId,digest);const actionRows=await this.storage.readonlyQuery({sql:"SELECT availability FROM skill_availability_actions WHERE entry_id=? AND version_id=? ORDER BY created_at DESC,event_id DESC LIMIT 1",args:[entryId,versionId]});
      const status=String(row.status);let availability:SkillAvailability=status==="candidate"?"candidate":status==="rejected"||status==="rolled_back"?"rejected":status==="active"?"enabled":"disabled";if(actionRows[0])availability=String((actionRows[0] as any).availability) as SkillAvailability;if((availability==="enabled"||availability==="candidate")&&test?.outcome!=="passed")availability="disabled";
      const provenance={kind:"harness-version" as const,entryId,versionId,contentDigest:digest,createdEventId:String(row.created_event_id),createdBy:String(row.created_by),createdAt:String(row.created_at),proposalId:row.proposal_id===null?null:String(row.proposal_id),evidenceEventIds:(JSON.parse(String(row.evidence_event_ids_json)) as string[]).sort()};
      const imports=await this.storage.readonlyQuery({sql:"SELECT payload_json,committed_at FROM events WHERE type='SkillImported' AND json_extract(payload_json,'$.entryId')=? AND json_extract(payload_json,'$.versionId')=? ORDER BY sequence DESC LIMIT 1",args:[entryId,versionId]});
      const imported=imports[0]?JSON.parse(String((imports[0] as any).payload_json)) as any:null;
      result.push({definition,record:{schemaVersion:1,source:"harness",entryId,versionId,digest,name:String(row.name),scope:String(row.scope) as any,scopeKey:String(row.scope_key),availability,provenance,permissions:[...definition.permissions].sort(),latestTest:test},...(imported?{viewProvenance:{...provenance,installation:{installedBy:String(imported.installedBy),installedAt:String((imports[0] as any).committed_at),scope:String(imported.scope),origin:imported.origin}} as unknown as JsonValue}:{})});
    }
    for(const item of await this.profile.listGlobalSkillCatalog({includeUnavailable:true})){const mapped=await this.#profileCatalog(item);if(mapped)result.push(mapped);}return result;
  }

  async #profileCatalog(item:ProfileGlobalSkillRecord):Promise<CatalogDefinition|null>{if(item.definitionFormat!=="typescript-v1")return null;const definition=item.definition as unknown as TypeScriptSkillDefinition;const p=item.provenance;let origin:any;if(p.source==="local-directory")origin={kind:"local-directory",reference:p.reference,manifestDigest:p.manifestDigest,sourceDigest:p.sourceDigest};else if(p.source==="harness-version")origin={kind:"harness-version",entryId:p.entryId,versionId:p.versionId,digest:p.digest};else if(p.source==="profile-api")origin={kind:"profile-api",reference:p.reference};else return null;const installedBy="installedBy" in p?p.installedBy:this.userScopeKey;return{definition,record:{schemaVersion:1,source:"profile",entryId:item.skillId,versionId:item.versionId,digest:item.digest,name:item.name,scope:"global",scopeKey:this.profileScopeKey,availability:item.availability,provenance:{kind:"profile-install",entryId:item.skillId,versionId:item.versionId,contentDigest:item.digest,installationId:`install-${item.versionId}`,installedBy,installedAt:item.createdAt,origin},permissions:[...definition.permissions].sort(),latestTest:item.testReport?{testId:item.testReport.testId,versionId:item.versionId,digest:item.digest,testedAt:item.testReport.testedAt,compiled:item.testReport.compiled,passed:item.testReport.passed,failed:item.testReport.failed,outcome:item.testReport.outcome}:null}};}

  async #latestHarnessTest(versionId:string,digest:string):Promise<SkillCatalogRecord["latestTest"]>{const rows=await this.storage.readonlyQuery({sql:"SELECT event_id,report_json,created_at,passed FROM skill_executions WHERE version_id=? AND execution_kind='test' ORDER BY created_at DESC,event_id DESC LIMIT 1",args:[versionId]});if(!rows[0])return null;const row=rows[0] as any,report=JSON.parse(String(row.report_json)) as any;const passed=Number(row.passed)===1;return{testId:String(row.event_id),versionId,digest,testedAt:String(row.created_at),compiled:report.compiled===true,passed:Number(report.passed??0),failed:Number(report.failed??0),outcome:passed?"passed":"failed"};}

  async #policy(sessionId:string,branchId:string):Promise<SkillResolutionPolicy>{const sessions=await this.storage.readonlyQuery({sql:"SELECT workspace_id FROM sessions WHERE session_id=?",args:[sessionId]});if(!sessions[0])throw new ValidationError(`Session not found: ${sessionId}`);const exposures=await this.storage.readonlyQuery({sql:"SELECT a.allocation_id,a.session_id,a.branch_id,a.exposed_at,v.entry_id,v.version_id,v.content_json FROM candidate_allocations a JOIN harness_versions v ON v.proposal_id=a.proposal_id JOIN refinement_proposals p ON p.proposal_id=a.proposal_id WHERE a.session_id=? AND a.branch_id=? AND a.exposed_at IS NOT NULL AND p.status='candidate' AND v.kind='skill'",args:[sessionId,branchId]});return{sessionId,branchId,workspaceId:String((sessions[0] as any).workspace_id),userScopeKey:this.userScopeKey,profileScopeKey:this.profileScopeKey,permissionAllowlist:[...this.skills.permissionAllowlist].sort(),candidateExposures:(exposures as any[]).map(row=>({exposureId:String(row.allocation_id),entryId:String(row.entry_id),versionId:String(row.version_id),digest:canonicalSkillDigest(JSON.parse(String(row.content_json)) as JsonValue),sessionId:String(row.session_id),branchId:String(row.branch_id),exposedAt:String(row.exposed_at)})).sort((a,b)=>a.exposureId.localeCompare(b.exposureId))};}
}

function harnessDefinition(row:any):TypeScriptSkillDefinition{const content=JSON.parse(String(row.content_json)) as any;if(content.kind!=="skill")throw new ValidationError("Harness skill content is malformed");const {kind,...definition}=content;return definition as TypeScriptSkillDefinition;}
function passedReport(report:SkillTestReport):boolean{return report.outcome==="succeeded"&&report.compiled&&report.failed===0&&report.passed>0;}
function scopeAllowed(record:SkillCatalogRecord,policy:SkillResolutionPolicy):boolean{return record.source==="profile"?record.scopeKey===policy.profileScopeKey:record.scope==="local"?record.scopeKey===policy.sessionId:record.scope==="workspace"?record.scopeKey===policy.workspaceId:record.scope==="user"?record.scopeKey===policy.userScopeKey:record.scopeKey==="global";}
function currentManagementVersion(items:CatalogDefinition[]):CatalogDefinition{return [...items].sort((left,right)=>managementRank(left.record.availability)-managementRank(right.record.availability)||right.record.versionId.localeCompare(left.record.versionId))[0]!;}
function managementRank(availability:SkillAvailability):number{return availability==="candidate"?0:availability==="enabled"?1:availability==="disabled"?2:availability==="removed"?3:4;}
function view(item:CatalogDefinition):SkillManagementView{const {record,definition}=item;return{entryId:record.entryId,versionId:record.versionId,name:record.name,source:record.source,scope:record.scope,availability:record.availability,digest:record.digest,provenance:item.viewProvenance??record.provenance as unknown as JsonValue,latestTest:record.latestTest as unknown as JsonValue|null,permissions:record.permissions,description:definition.description,inputSchema:definition.inputSchema ?? null,runtime:"bun",legacy:false};}

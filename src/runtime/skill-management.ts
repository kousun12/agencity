import {
  SkillResolutionError,
  ValidationError,
  canonicalSkillDigest,
  isSkillContextEligible,
  isValidSkillName,
  resolveSkillCatalog,
  type EffectOrigin,
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

interface CatalogDefinition { readonly record: SkillCatalogRecord; readonly definition: TypeScriptSkillDefinition; readonly viewProvenance?: JsonValue; readonly quarantinedReason?: string; }

class InstallQueue {
  readonly #tails=new Map<string,Promise<void>>();
  async run<T>(key:string,operation:()=>Promise<T>):Promise<T>{const previous=this.#tails.get(key)??Promise.resolve();let release!:()=>void;const current=new Promise<void>((resolve)=>{release=resolve});const tail=previous.catch(()=>{}).then(()=>current);this.#tails.set(key,tail);await previous.catch(()=>{});try{return await operation();}finally{release();if(this.#tails.get(key)===tail)this.#tails.delete(key);}}
}

/** Unified product catalog over canonical workspace harness history and the separate profile-global store. */
export class SkillManagementService implements ExecutableSkillCatalog {
  readonly #installQueue=new InstallQueue();
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
    const requestKey=stableSkillId(`${sessionId}:${branchId}:${input.scope}:${preview.bundle.provenance.manifest.sha256}:${preview.confirmationDigest}:${installedBy}`);
    return this.#installQueue.run(requestKey,()=>input.scope === "profile"
      ? this.#installProfile(sessionId, branchId, preview.bundle, installedBy, requestKey)
      : this.#installWorkspace(sessionId, branchId, preview.bundle, installedBy, requestKey));
  }

  /** Agent-driven creation remains a constrained ordinary Refiner review, never a direct active write. */
  async propose(sessionId: string, branchId: string, instructions: string, scope: "local" | "workspace" = "workspace"): Promise<RefinementReviewRecord> {
    return this.refiner.createSkill(sessionId, branchId, { instructions, requestedScope: scope });
  }

  async list(sessionId: string, branchId: string, options: { readonly includeUnavailable?: boolean } = {}): Promise<SkillManagementView[]> {
    const policy = await this.#policy(sessionId, branchId);
    const catalog = await this.#catalog();
    const visible = options.includeUnavailable ? catalog : catalog.filter(item => !item.quarantinedReason && isSkillContextEligible(item.record, policy));
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

  async test(sessionId: string, branchId: string, reference: string, effectOrigin?: EffectOrigin): Promise<SkillTestReport> {
    const item = await this.#managementResolve(sessionId,branchId,reference);
    if (!item) throw new SkillResolutionError("NOT_FOUND","Skill was not found");
    if (item.quarantinedReason) throw new ValidationError(item.quarantinedReason);
    if (item.record.availability === "candidate") return this.skills.testModelVisible(sessionId,branchId,item.record.entryId,item.record.versionId,`skill-management-test:${item.record.source}:${item.record.versionId}:${Date.now()}`,effectOrigin);
    return this.skills.testDefinition(sessionId,branchId,item.record.entryId,item.record.versionId,item.definition,`skill-management-test:${item.record.source}:${item.record.versionId}:${Date.now()}`,effectOrigin);
  }

  async enable(sessionId:string,branchId:string,reference:string):Promise<SkillManagementView>{return this.#availability(sessionId,branchId,reference,"enabled");}
  async disable(sessionId:string,branchId:string,reference:string):Promise<SkillManagementView>{return this.#availability(sessionId,branchId,reference,"disabled");}
  async remove(sessionId:string,branchId:string,reference:string):Promise<SkillManagementView>{return this.#availability(sessionId,branchId,reference,"removed");}

  async resolveExecutable(sessionId: string, branchId: string, reference: string, options: { readonly versionId?: string; readonly allowCandidate?: boolean } = {}): Promise<ResolvedExecutableSkill> {
    const items = await this.#catalog();
    const records = items.filter(item=>!item.quarantinedReason).map(item=>item.record).filter(record=>options.allowCandidate!==false||record.availability!=="candidate");
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
    if(item.quarantinedReason&&target!=="removed")throw new ValidationError(item.quarantinedReason);
    if(target==="enabled"&&record.latestTest?.outcome!=="passed")throw new ValidationError("A passing same-version test is required before enabling a skill");
    if(record.source==="profile"){
      const history=await this.profile.getGlobalSkillHistory(record.entryId);const current=history?.current;const previous=history?.actions.at(-1);
      if(!current||!previous||current.versionId!==record.versionId||current.digest!==record.digest||previous.versionId!==record.versionId||previous.digest!==record.digest)throw new ValidationError("Profile skill changed while resolving the requested action");
      if(current.availability==="removed")throw new ValidationError("Removed skills retain immutable history and cannot be re-enabled");
      const currentItem=await this.#profileCatalog(current);if(!currentItem)throw new ValidationError("Legacy profile skills cannot be enabled through the typed catalog");
      if(current.availability===target)return view(currentItem);
      const changed=await this.profile.setGlobalSkillAvailability({skillId:record.entryId,availability:target,expectedVersionId:record.versionId,expectedDigest:record.digest,expectedAvailability:current.availability,expectedActionSequence:previous.sequence,idempotencyKey:`skill-${target}:${record.entryId}:${record.versionId}:after-${previous.sequence}`});
      const mapped=await this.#profileCatalog(changed);if(!mapped)throw new ValidationError("Legacy profile skills cannot be enabled through the typed catalog");return view(mapped);
    }
    const state=await this.#workspaceAvailabilityState(record.entryId,record.versionId);
    if(state.availability==="removed")throw new ValidationError("Removed skills retain immutable history and cannot be re-enabled");
    const currentItem:CatalogDefinition={...item,record:{...record,availability:state.availability}};
    if(state.availability===target)return view(currentItem);
    const after=state.actionSequence===null?`created-${state.createdSequence}`:String(state.actionSequence);
    await this.storage.appendEvents([{sessionId,branchId,type:"SkillAvailabilityChanged",producer:"client",idempotencyKey:`skill-${target}:${record.entryId}:${record.versionId}:after-${after}`,payload:{entryId:record.entryId,versionId:record.versionId,digest:record.digest,availability:target,reason:`User requested skill ${target}`,expectedAvailability:state.availability,expectedPreviousActionSequence:state.actionSequence}}]);
    return view({...item,record:{...record,availability:target}});
  }

  async #workspaceAvailabilityState(entryId:string,versionId:string):Promise<{availability:"enabled"|"disabled"|"removed";actionSequence:number|null;createdSequence:number}>{
    const rows=await this.storage.readonlyQuery({sql:"SELECT ce.sequence AS created_sequence,ae.sequence AS action_sequence,a.availability FROM harness_versions v JOIN events ce ON ce.id=v.created_event_id LEFT JOIN skill_availability_actions a ON a.event_id=(SELECT a2.event_id FROM skill_availability_actions a2 JOIN events e2 ON e2.id=a2.event_id WHERE a2.entry_id=v.entry_id AND a2.version_id=v.version_id ORDER BY e2.sequence DESC LIMIT 1) LEFT JOIN events ae ON ae.id=a.event_id WHERE v.entry_id=? AND v.version_id=?",args:[entryId,versionId]});
    const row=rows[0] as any;if(!row)throw new ValidationError("Workspace skill version is missing");
    const createdSequence=Number(row.created_sequence),actionSequence=row.action_sequence===null||row.action_sequence===undefined?null:Number(row.action_sequence);if(!Number.isSafeInteger(createdSequence)||createdSequence<1||actionSequence!==null&&(!Number.isSafeInteger(actionSequence)||actionSequence<1))throw new ValidationError("Workspace skill availability sequence is corrupt");
    const availability=String(row.availability??"enabled");if(availability!=="enabled"&&availability!=="disabled"&&availability!=="removed")throw new ValidationError("Workspace skill availability is corrupt");return{availability,actionSequence,createdSequence};
  }

  async #installProfile(sessionId:string,branchId:string,bundle:SkillImportBundle,installedBy:string,requestKey:string):Promise<SkillManagementView>{
    const definition=bundle.definition;const digest=canonicalSkillDigest(definition as unknown as JsonValue);const skillId=`profile-skill-${bundle.name}`;const versionId=`profile-version-${digest.slice(0,40)}`;
    const provenance={source:"local-directory" as const,reference:bundle.provenance.directory,manifestDigest:bundle.provenance.manifest.sha256,sourceDigest:bundle.provenance.source.sha256,installedBy};
    const current=await this.profile.getGlobalSkill(skillId,{includeUnavailable:true});
    if(current?.versionId===versionId){
      if(current.digest!==digest||current.name!==bundle.name||current.definitionFormat!=="typescript-v1"||!Bun.deepEquals(current.definition,definition)||!Bun.deepEquals(current.provenance,provenance))throw new ValidationError("Stable profile skill install identity conflicts with retained immutable provenance");
      const mapped=await this.#profileCatalog(current);if(!mapped)throw new Error("Installed TypeScript profile skill was not catalogued");return view(mapped);
    }
    const report=await this.skills.testDefinition(sessionId,branchId,skillId,versionId,definition,`profile-skill-stage-test:${versionId}`);const passed=passedReport(report);
    const testRows=await this.storage.readonlyQuery({sql:"SELECT created_at FROM skill_executions WHERE version_id=? AND effect_id=? AND execution_kind='test' ORDER BY rowid LIMIT 1",args:[versionId,report.effectId]});const testedAt=String((testRows[0] as any)?.created_at??"");if(!testedAt)throw new ValidationError("Profile skill test evidence is missing");
    const staged=await this.profile.stageGlobalSkill({skillId,versionId,name:bundle.name,definition,provenance,testReport:{testId:report.effectId,testedAt,compiled:report.compiled,passed:report.passed,failed:report.failed,outcome:passed?"passed":"failed"},effectRef:report.effectId,availability:passed?"enabled":"disabled",idempotencyKey:`skill-install-profile:${requestKey}`,...(current?{expectedCurrentVersionId:current.versionId,expectedCurrentDigest:current.digest}:{expectedCurrentVersionId:null,expectedCurrentDigest:null})});
    const mapped=await this.#profileCatalog(staged);if(!mapped)throw new Error("Staged TypeScript profile skill was not catalogued");return view(mapped);
  }

  async #installWorkspace(sessionId:string,branchId:string,bundle:SkillImportBundle,installedBy:string,requestKey:string):Promise<SkillManagementView>{
    const proposalId=`skill-install-${requestKey}`;
    let proposed=await this.harness.propose(sessionId,branchId,{proposalId,trigger:`Install inspected local skill ${bundle.name}`,predictedEffect:`Make ${bundle.name} available in this workspace`,authority:"user",edits:[{operation:"create",kind:"skill",scope:"workspace",name:bundle.name,content:{kind:"skill",...bundle.definition},tags:["local-import"],confidence:1}],evaluation:{kind:"objective",name:`${bundle.name} tests`,metric:"skillTestsPassed",target:true,baseline:false}});
    if(proposed.status==="proposed")proposed=await this.harness.validate(sessionId,branchId,proposed.proposalId);
    if(proposed.status==="validated")proposed=await this.harness.activate(sessionId,branchId,proposed.proposalId,{allocationLimit:2,exposureLimit:2});
    if(proposed.status!=="candidate"&&proposed.status!=="promoted")throw new ValidationError(`Stable workspace skill install cannot resume from ${proposed.status}`);
    const versions=(await this.storage.readonlyQuery({sql:"SELECT entry_id,version_id FROM harness_versions WHERE proposal_id=? AND kind='skill'",args:[proposed.proposalId]}));if(!versions[0])throw new ValidationError("Workspace skill install version is missing");const entryId=String((versions[0] as any).entry_id),versionId=String((versions[0] as any).version_id);
    if(proposed.status==="candidate"){
      for(let index=0;index<2;index++){
        let targetBranchId=branchId;
        if(index>0){
          targetBranchId=`skill-evaluation-${stableSkillId(`${requestKey}:${index}`)}`;
          const existing=await this.storage.readonlyQuery({sql:"SELECT branch_id FROM branches WHERE session_id=? AND branch_id=?",args:[sessionId,targetBranchId]});
          if(!existing[0]){const history=await this.storage.loadEvents(sessionId,{branchId});const fork=history.at(-1);if(!fork)throw new ValidationError("Cannot create a skill evaluation branch without retained history");await this.storage.appendEvents([{sessionId,branchId:targetBranchId,type:"BranchCreated",producer:"supervisor",idempotencyKey:`skill-evaluation-branch:${proposed.proposalId}:${index}`,payload:{branchId:targetBranchId,parentBranchId:branchId,forkCursor:fork.cursor,name:`skill-evaluation-${bundle.name}`}}]);}
        }
        const allocation=await this.harness.allocate(sessionId,branchId,proposed.proposalId,{sessionId,branchId:targetBranchId});await this.harness.expose(sessionId,targetBranchId,proposed.proposalId,allocation.allocationId);
        const observed=await this.storage.readonlyQuery({sql:"SELECT observation_id FROM refinement_observations WHERE proposal_id=? AND allocation_id=? AND evaluator='skill-import-tests-v1' ORDER BY rowid LIMIT 1",args:[proposed.proposalId,allocation.allocationId]});
        if(!observed[0]){const report=await this.skills.testModelVisible(sessionId,targetBranchId,entryId,versionId,`skill-import-exposed-test:${versionId}:${allocation.allocationId}`);const events=await this.storage.readonlyQuery({sql:"SELECT event_id FROM skill_executions WHERE version_id=? AND effect_id=? AND execution_kind='test'",args:[versionId,report.effectId]});const evidenceEventId=String((events[0] as any)?.event_id??"");if(!evidenceEventId)throw new ValidationError("Workspace skill import test evidence is missing");await this.harness.recordObservation(sessionId,branchId,proposed.proposalId,{allocationId:allocation.allocationId,evaluator:"skill-import-tests-v1",objective:true,success:passedReport(report),metric:{skillTestsPassed:passedReport(report)},baseline:false,evidenceEventIds:[evidenceEventId]});}
      }
      await this.harness.decide(sessionId,branchId,proposed.proposalId,{decision:"promote",evaluator:"skill-import-tests-v1"});
    }
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
      const test=await this.#latestHarnessTest(versionId,digest);const actionRows=await this.storage.readonlyQuery({sql:"SELECT a.availability,e.sequence FROM skill_availability_actions a JOIN events e ON e.id=a.event_id WHERE a.entry_id=? AND a.version_id=? ORDER BY e.sequence DESC LIMIT 1",args:[entryId,versionId]});
      const status=String(row.status);const quarantinedReason=isValidSkillName(String(row.name))?undefined:"Retained legacy harness skill is quarantined because its name is not bounded lower-kebab-case; it may only be removed or rolled back.";let availability:SkillAvailability=status==="candidate"?"candidate":status==="rejected"||status==="rolled_back"?"rejected":status==="active"?"enabled":"disabled";if(actionRows[0])availability=String((actionRows[0] as any).availability) as SkillAvailability;if((availability==="enabled"||availability==="candidate")&&test?.outcome!=="passed")availability="disabled";if(quarantinedReason&&(availability==="enabled"||availability==="candidate"))availability="disabled";
      const provenance={kind:"harness-version" as const,entryId,versionId,contentDigest:digest,createdEventId:String(row.created_event_id),createdBy:String(row.created_by),createdAt:String(row.created_at),proposalId:row.proposal_id===null?null:String(row.proposal_id),evidenceEventIds:(JSON.parse(String(row.evidence_event_ids_json)) as string[]).sort()};
      const imports=await this.storage.readonlyQuery({sql:"SELECT payload_json,committed_at FROM events WHERE type='SkillImported' AND json_extract(payload_json,'$.entryId')=? AND json_extract(payload_json,'$.versionId')=? ORDER BY sequence DESC LIMIT 1",args:[entryId,versionId]});
      const imported=imports[0]?JSON.parse(String((imports[0] as any).payload_json)) as any:null;
      result.push({definition,record:{schemaVersion:1,source:"harness",entryId,versionId,digest,name:String(row.name),scope:String(row.scope) as any,scopeKey:String(row.scope_key),availability,provenance,permissions:[...definition.permissions].sort(),latestTest:test},...(quarantinedReason?{quarantinedReason}:{}),...(imported?{viewProvenance:{...provenance,installation:{installedBy:String(imported.installedBy),installedAt:String((imports[0] as any).committed_at),scope:String(imported.scope),origin:imported.origin}} as unknown as JsonValue}:{})});
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
function view(item:CatalogDefinition):SkillManagementView{const {record,definition}=item;return{entryId:record.entryId,versionId:record.versionId,name:record.name,source:record.source,scope:record.scope,availability:record.availability,digest:record.digest,provenance:item.viewProvenance??record.provenance as unknown as JsonValue,latestTest:record.latestTest as unknown as JsonValue|null,permissions:record.permissions,description:item.quarantinedReason??definition.description,inputSchema:definition.inputSchema ?? null,runtime:"bun",legacy:item.quarantinedReason!==undefined};}
function stableSkillId(value:string):string{const hasher=new Bun.CryptoHasher("sha256");hasher.update(value);return hasher.digest("hex").slice(0,32);}

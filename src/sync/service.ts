import { copyFile, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapabilityUnavailableError, ConflictError, ValidationError, newId, validateNewEvent,
  type AgentEvent, type EventPayloads, type JsonValue, type NewAgentEvent,
} from "../domain/index.ts";
import type {
  AgentStorage, DataManifestRecord, SyncBranchMappingRecord, SyncConflictRecord,
  SyncOriginWatermarkRecord, SyncQuarantineRecord, SyncStorageOperations, WorkspaceReplicaStatusRecord,
} from "../storage/index.ts";
import type { ProfileDatabase } from "./profile.ts";
import {
  deterministicId, envelopeDigest, replicatedEnvelopeId, sha256Text, stableJson,
  type DeviceIdentity, type ReplicatedEnvelope, type ReplicatedEventBody, type ResolveConflictInput,
  type SyncCheckpointResult, type SyncCycleResult, type SyncPullResult, type SyncPushResult,
  type DeleteOwnedDataInput, type ManagedReplicaDeletionAdmin, type PhysicalDeletionReceipt,
  type SyncServiceCapabilities, type SyncStatusView, type SyncTransportStats,
  type SyncTransport, type SyncTrigger, type WorkspaceAnnouncement, type WorkspaceCatalogEntry,
} from "./types.ts";

export interface SyncServiceOptions {
  readonly storage: AgentStorage & SyncStorageOperations;
  readonly profile?: ProfileDatabase;
  readonly device: DeviceIdentity;
  readonly workspaceId: string;
  readonly workspaceName?: string;
  readonly databaseUrl: string;
  readonly artifactDirectory?: string;
  /** Owner-only model credential file managed with whole-profile deletion. */
  readonly profileCredentialPath?: string;
  /** Required assertion before whole-directory workspace artifact erasure. */
  readonly artifactDirectoryOwnership?: "exclusive" | "shared";
  readonly syncUrl?: string;
  readonly replicaUrl?: string;
  readonly credentialReference?: string;
  readonly transport?: SyncTransport;
  /** Credentialed control-plane deletion, deliberately separate from sync data-plane auth. */
  readonly remoteDeletionAdmin?: ManagedReplicaDeletionAdmin;
  readonly intervalMs?: number;
  readonly now?: () => Date;
}

export class SyncService {
  readonly storage:AgentStorage&SyncStorageOperations;
  readonly profile:ProfileDatabase|undefined;
  readonly device:DeviceIdentity;
  readonly workspaceId:string;
  readonly workspaceName:string;
  readonly databaseUrl:string;
  readonly artifactDirectory:string|undefined;
  readonly profileCredentialPath:string|undefined;
  readonly artifactDirectoryOwnership:"exclusive"|"shared";
  readonly replicaUrl:string|undefined;
  readonly transport:SyncTransport|null;
  readonly remoteDeletionAdmin:ManagedReplicaDeletionAdmin|null;
  readonly intervalMs:number;
  readonly replicaId:string;
  readonly capabilities:SyncServiceCapabilities;
  readonly #now:()=>Date;
  #timer:ReturnType<typeof setInterval>|null=null;
  #active:Promise<SyncCycleResult>|null=null;
  #status:WorkspaceReplicaStatusRecord;
  #erased=false;

  constructor(options:SyncServiceOptions){
    this.storage=options.storage;this.profile=options.profile;this.device=options.device;
    this.workspaceId=required(options.workspaceId,"workspaceId");this.workspaceName=options.workspaceName??this.workspaceId;
    this.databaseUrl=options.databaseUrl;this.artifactDirectory=options.artifactDirectory;this.profileCredentialPath=options.profileCredentialPath;this.artifactDirectoryOwnership=options.artifactDirectoryOwnership??"shared";this.replicaUrl=options.replicaUrl;
    this.transport=options.transport??null;this.remoteDeletionAdmin=options.remoteDeletionAdmin??null;this.intervalMs=options.intervalMs??30_000;this.#now=options.now??(()=>new Date());
    if(!Number.isSafeInteger(this.intervalMs)||this.intervalMs<0)throw new ValidationError("Sync interval must be a nonnegative safe integer");
    this.replicaId=this.transport?.id??`local:${this.workspaceId}:${this.device.deviceId}`;
    const directional=this.transport?.capabilities.networkExchange==="directional"&&typeof this.transport.push==="function"&&typeof this.transport.pull==="function";
    this.capabilities={configured:this.transport!==null,localWrites:true,offlineFirst:true,logicalStage:true,logicalIngest:true,networkSync:this.transport!==null,directionalNetworkPush:directional,directionalNetworkPull:directional,networkCheckpoint:directional&&typeof this.transport?.checkpoint==="function",networkStats:directional&&typeof this.transport?.stats==="function",distributedLeases:false,automaticOwnershipFailover:false,conflictPolicy:"surface-and-require-explicit-resolution",transport:this.transport?.capabilities??null};
    const now=this.#iso();
    this.#status={replicaId:this.replicaId,replicaIncarnation:null,workspaceId:this.workspaceId,deviceId:this.device.deviceId,replicaUrl:options.replicaUrl??null,syncUrl:options.syncUrl??null,credentialReference:options.credentialReference??null,lifecycle:this.transport?"offline":"local_only",lastAttemptAt:null,lastSuccessAt:null,lastError:null,lastStats:null,stagedEnvelopes:0,ingestedEnvelopes:0,quarantinedEnvelopes:0,updatedAt:now};
  }

  async start(runStartup=true):Promise<void>{
    const configured=this.#status;const saved=await this.storage.getReplicaStatus(this.replicaId);
    if(saved)this.#status={...saved,replicaUrl:configured.replicaUrl??saved.replicaUrl,syncUrl:configured.syncUrl??saved.syncUrl,credentialReference:configured.credentialReference??saved.credentialReference};
    if(this.transport){
      await this.transport.initialize();
      const incarnation=await this.transport.replicaIncarnation(saved?.replicaIncarnation??undefined);
      if(saved&&saved.replicaIncarnation!==incarnation){await this.storage.resetSyncStaging(this.replicaId);this.#status={...this.#status,stagedEnvelopes:0};}
      await this.#save({replicaIncarnation:incarnation,lifecycle:"offline"});
    }else if(!saved)await this.storage.putReplicaStatus(this.#status);
    await this.#catalog();
    if(this.transport&&runStartup){try{await this.sync("startup");}catch{/* Offline-first startup retains the explicit error status. */}}
    if(this.transport&&this.intervalMs>0&&!this.#timer)this.#timer=setInterval(()=>{void this.sync("interval").catch(()=>{});},this.intervalMs);
  }
  async stop():Promise<void>{if(this.#timer){clearInterval(this.#timer);this.#timer=null;}await this.#active?.catch(()=>{});if(this.#erased)return;await this.transport?.close();await this.#save({lifecycle:"closed"});}
  async reconnect():Promise<SyncCycleResult>{if(!this.transport)throw unavailable("reconnect");await this.transport.reconnect?.();return this.sync("reconnect");}
  async sync(trigger:SyncTrigger="manual"):Promise<SyncCycleResult>{if(!this.transport)throw unavailable("sync");if(this.#active)return this.#active.then(result=>({...result,trigger}));this.#active=this.#cycle(trigger).finally(()=>{this.#active=null;});return this.#active;}
  /** Logical local staging; it performs no network call. */
  async stage():Promise<number>{
    if(!this.transport)throw unavailable("stage");
    const watermarks=await this.storage.listSyncOriginWatermarks(this.replicaId);const old=watermarks.find(x=>x.originDeviceId===this.device.deviceId);const after=old?.stagedSequence??0;
    const scanned=await this.storage.listOriginEvents(this.device.deviceId,after);const envelopes:ReplicatedEnvelope[]=[];
    for(const event of scanned){if(event.producer==="sync-derived")continue;const session=await this.storage.getSession?.(event.sessionId);if(session?.workspaceId!==this.workspaceId)continue;envelopes.push(await this.#envelope(event));}
    const staged=await this.transport.putEnvelopes(envelopes);const announcement:WorkspaceAnnouncement={announcementId:deterministicId("workspace",this.workspaceId,this.device.deviceId),workspaceId:this.workspaceId,name:this.workspaceName,ownerProfileId:this.device.profileId,deviceId:this.device.deviceId,updatedAt:this.#iso()};await this.transport.putWorkspaceAnnouncement(announcement);
    const scannedThrough=scanned.reduce((maximum,event)=>Math.max(maximum,event.originSequence),after);if(scannedThrough>after)await this.storage.putSyncOriginWatermark({replicaId:this.replicaId,originDeviceId:this.device.deviceId,stagedSequence:scannedThrough,ingestedSequence:old?.ingestedSequence??0,updatedAt:this.#iso()});
    if(staged)await this.#save({stagedEnvelopes:this.#status.stagedEnvelopes+staged});return staged;
  }
  /** Logical local ingestion of envelopes already present in the replica file. */
  async ingest():Promise<{ingested:number;duplicates:number;quarantined:number;conflicts:number}>{if(!this.transport)throw unavailable("ingest");const watermarks=await this.storage.listSyncOriginWatermarks(this.replicaId);const after=Object.fromEntries(watermarks.map(x=>[x.originDeviceId,x.ingestedSequence]));const raw=await this.transport.listEnvelopes(this.workspaceId,after);return this.#ingest(raw,watermarks);}
  /** Stages local envelopes, then invokes the official directional push. */
  async push():Promise<SyncPushResult>{
    const transport=this.#directional("push");await this.#save({lifecycle:"syncing",lastAttemptAt:this.#iso(),lastError:null});
    try{const staged=await this.stage();await transport.push();const stats=await transport.stats();await this.#networkSucceeded(stats);return{staged,stats,status:this.#status};}
    catch(error){await this.#networkFailed(error);throw error;}
  }
  /** Pulls official conflict-resolved state, then ingests its immutable envelopes. */
  async pull():Promise<SyncPullResult>{
    const transport=this.#directional("pull");await this.#save({lifecycle:"syncing",lastAttemptAt:this.#iso(),lastError:null});
    try{const changed=await transport.pull();const result=await this.ingest();const stats=await transport.stats();await this.#networkSucceeded(stats,{ingestedEnvelopes:this.#status.ingestedEnvelopes+result.ingested,quarantinedEnvelopes:this.#status.quarantinedEnvelopes+result.quarantined});return{changed,...result,stats,status:this.#status};}
    catch(error){await this.#networkFailed(error);throw error;}
  }
  async checkpoint():Promise<SyncCheckpointResult>{const transport=this.#directional("checkpoint");await transport.checkpoint();const stats=await transport.stats();await this.#save({lastStats:stats});return{stats,status:this.#status};}
  async stats():Promise<SyncTransportStats>{const transport=this.#directional("stats");const stats=await transport.stats();await this.#save({lastStats:stats});return stats;}
  async status():Promise<SyncStatusView>{const stored=await this.storage.getReplicaStatus(this.replicaId);if(stored)this.#status=stored;return{capabilities:this.capabilities,replica:this.#status,conflicts:await this.storage.listSyncConflicts("unresolved"),quarantineCount:(await this.storage.listSyncQuarantine()).filter(x=>x.status!=="released").length};}
  conflicts(status?:"unresolved"|"resolved"):Promise<SyncConflictRecord[]>{return this.storage.listSyncConflicts(status);}
  async resolveConflict(conflictId:string,input:ResolveConflictInput):Promise<SyncConflictRecord>{
    required(input.resolvedBy,"resolvedBy");const found=(await this.storage.listSyncConflicts()).find(x=>x.conflictId===conflictId);if(!found)throw new ValidationError(`Unknown sync conflict: ${conflictId}`);
    if(input.action==="choose-claim"&&(!input.chosenEventId||!found.eventIds.includes(input.chosenEventId)))throw new ValidationError("choose-claim requires an event ID belonging to the conflict");
    const anchorEvents=await Promise.all(found.eventIds.map(id=>this.storage.getEvent(id)));const retained=anchorEvents.filter((x):x is AgentEvent=>x!==null);const anchor=retained.find(x=>x.originDeviceId===this.device.deviceId)??retained[0];const session=found.sessionId?await this.storage.getSession?.(found.sessionId):null;
    if(!found.sessionId||(!anchor&&!session))throw new ValidationError("Conflict has no retained session anchor for a durable resolution event");
    const resolvedAt=this.#iso();await this.storage.appendEvents([{sessionId:found.sessionId,branchId:anchor?.branchId??session!.initialBranchId,type:"SyncConflictResolved",producer:"client",idempotencyKey:`sync-resolution:${conflictId}`,payload:{conflictId,action:input.action,resolvedBy:input.resolvedBy,...(input.chosenEventId?{chosenEventId:input.chosenEventId}:{}),...(input.note?{note:input.note}:{}),resolvedAt}}]);
    const resolved=(await this.storage.listSyncConflicts("resolved")).find(x=>x.conflictId===conflictId);if(!resolved)throw new ConflictError("Conflict resolution event did not update the local reconciliation",{conflictId});return resolved;
  }
  async discoverCloudWorkspaces(refresh=false):Promise<WorkspaceAnnouncement[]>{if(!this.transport)throw unavailable("cloud workspace discovery");if(refresh){if(this.capabilities.directionalNetworkPull)await this.pull();else if(this.transport.sync)await this.transport.sync();else throw unavailable("cloud workspace refresh");}const rows=await this.transport.discoverWorkspaces();const latest=new Map<string,WorkspaceAnnouncement>();for(const row of rows){const old=latest.get(row.workspaceId);if(!old||compareAnnouncement(row,old)<0)latest.set(row.workspaceId,row);}return[...latest.values()].sort((a,b)=>a.workspaceId.localeCompare(b.workspaceId));}

  async exportBundle(destination:string,scopeKind:"workspace"|"session"|"profile",scopeId:string,requestedBy:string):Promise<DataManifestRecord>{
    required(destination,"destination");const manifest=await this.createManifest("export",scopeKind,scopeId,requestedBy);if(!manifest.owned)return manifest;await mkdir(destination,{recursive:true});
    const sessionIds:string[]=[];if(scopeKind==="session")sessionIds.push(scopeId);else if(scopeKind==="workspace"){const branches=await this.storage.listBranches();for(const sessionId of new Set(branches.map(x=>x.sessionId))){const session=await this.storage.getSession?.(sessionId);if(session?.workspaceId===scopeId)sessionIds.push(sessionId);}}
    const events=(await Promise.all(sessionIds.sort().map(id=>this.storage.loadEvents(id)))).flat().sort((a,b)=>BigInt(a.cursor)<BigInt(b.cursor)?-1:BigInt(a.cursor)>BigInt(b.cursor)?1:a.id.localeCompare(b.id));
    await Bun.write(join(destination,"events.jsonl"),events.map(event=>JSON.stringify(event)).join("\n")+(events.length?"\n":""));
    const profileExport={device:this.device,preferences:this.profile?await this.profile.listPreferences():[],globalSkills:this.profile?await this.profile.listGlobalSkills():[],credentialReferences:this.profile?await this.profile.listCredentialReferences():[],workspaces:this.profile?await this.profile.listWorkspaces(true):[]};await Bun.write(join(destination,"profile.json"),JSON.stringify(profileExport,null,2)+"\n");
    const replicas=this.transport?await this.transport.listEnvelopes(this.workspaceId):[];await Bun.write(join(destination,"replica-envelopes.jsonl"),replicas.map(row=>stableJson(row)).join("\n")+(replicas.length?"\n":""));
    const artifacts=events.filter(e=>e.type==="ArtifactRegistered").map(e=>e.payload as EventPayloads["ArtifactRegistered"]);const seen=new Set<string>();const missing:string[]=[];let artifactCount=0;
    for(const artifact of artifacts){if(seen.has(artifact.digest))continue;seen.add(artifact.digest);if(!this.artifactDirectory){missing.push(artifact.artifactId);continue;}const source=join(this.artifactDirectory,artifact.digest.slice(0,2),artifact.digest.slice(2));const file=Bun.file(source);if(!await file.exists()){missing.push(artifact.artifactId);continue;}const bytes=new Uint8Array(await file.arrayBuffer());const hasher=new Bun.CryptoHasher("sha256");hasher.update(bytes);if(bytes.byteLength!==artifact.size||hasher.digest("hex")!==artifact.digest){missing.push(artifact.artifactId);continue;}await mkdir(join(destination,"artifacts"),{recursive:true});await copyFile(source,join(destination,"artifacts",artifact.digest));artifactCount++;}
    const audit=auditExportCompleteness(events,missing);await Bun.write(join(destination,"export-audit.json"),JSON.stringify(audit,null,2)+"\n");
    const resources={...(manifest.resources as Record<string,JsonValue>),bundlePath:destination,eventCount:events.length,artifactCount,missingArtifacts:missing,replicaEnvelopeCount:replicas.length,exportAudit:audit as unknown as JsonValue} as JsonValue;const completed=await this.storage.completeDataManifest(manifest.manifestId,audit.complete?"completed":"partial",resources,this.#iso());await Bun.write(join(destination,"manifest.json"),JSON.stringify(completed,null,2)+"\n");return completed;
  }

  async createManifest(operation:"export"|"delete",scopeKind:"workspace"|"session"|"profile",scopeId:string,requestedBy:string):Promise<DataManifestRecord>{
    if(operation!=="export"&&operation!=="delete")throw new ValidationError("Unsupported data-manifest operation");
    if(scopeKind!=="workspace"&&scopeKind!=="session"&&scopeKind!=="profile")throw new ValidationError("Unsupported data-manifest scope");
    required(scopeId,"scopeId");required(requestedBy,"requestedBy");
    const owned=await this.#owns(scopeKind,scopeId);const evidence=await this.#durableReplicaEvidence();
    const syncUrls=new Set(evidence.syncUrls);const unaddressable=new Set(evidence.unaddressableManagedReplicas);let remoteManaged=evidence.remoteManaged;
    const profileCatalog=scopeKind==="profile"?await this.profile?.listWorkspaces(true)??[]:evidence.catalog?[evidence.catalog]:[];
    if(scopeKind==="profile")for(const row of profileCatalog){
      if(row.workspaceId===this.workspaceId||row.ownerProfileId!==this.device.profileId||row.deletedAt!==null)continue;
      const managed=catalogIsManaged(row);if(!managed)continue;remoteManaged=true;
      if(row.syncUrl)syncUrls.add(row.syncUrl);else unaddressable.add(`catalog:${row.workspaceId}`);
    }
    const authenticatedRemoteDeletion=this.remoteDeletionAdmin?.capabilities.authenticatedAdministration===true&&this.remoteDeletionAdmin.capabilities.deleteWorkspaceReplica;
    const remoteDeletionSupported=scopeKind==="workspace"&&authenticatedRemoteDeletion&&remoteManaged&&syncUrls.size>0&&unaddressable.size===0;
    const resources:JsonValue={
      workspaceDatabase:this.databaseUrl,profileDatabase:this.profile?.url??null,profileCredentialFile:this.profileCredentialPath??null,
      artifactDirectory:this.artifactDirectory??null,artifactDirectoryOwnership:this.artifactDirectoryOwnership,
      replicaFile:evidence.localReplicaUrls[0]??null,replicaFiles:evidence.localReplicaUrls,
      replicaTransport:this.transport?.id??null,workspaceCatalog:profileCatalog as unknown as JsonValue,
      syncWatermarks:evidence.watermarks as unknown as JsonValue,managedSyncUrls:[...syncUrls].sort(),
      unaddressableManagedReplicas:[...unaddressable].sort(),
      canonical:"events",derivedIndexes:["operational projections","memory_fts","snapshots","context records"],
      retainedGovernance:[
        "initial and historical agent profiles","invocation profile and effective-prompt pins",
        "governed proposals and frozen review inputs","reviewer child and model dispatch",
        "review decisions and terminal notices","restoration provenance and evidence links",
      ],
      scope:{kind:scopeKind,id:scopeId},remoteManaged,remoteDeletionSupported,
      remoteDeletionAdapter:remoteDeletionSupported?this.remoteDeletionAdmin!.name:null,
    };
    const remoteBlocked=operation==="delete"&&remoteManaged&&(!remoteDeletionSupported||scopeKind!=="workspace");
    const status:DataManifestRecord["status"]=!owned||remoteBlocked?"blocked":"planned";
    const record:DataManifestRecord={manifestId:newId(),operation,scopeKind,scopeId,requestedBy,owned,resources,replicaStatus:evidence.statuses as unknown as JsonValue,status,createdAt:this.#iso(),completedAt:null};
    await this.storage.putDataManifest(record);return record;
  }

  /**
   * Explicit destructive workflow. The caller must quiesce supervisor workers
   * first (Supervisor.deleteOwnedData does so). Workspace/profile deletion is
   * terminal for that supervisor and records its final result outside the
   * database being removed.
   */
  async deleteOwnedData(input:DeleteOwnedDataInput):Promise<PhysicalDeletionReceipt>{
    required(input.scopeId,"scopeId");required(input.requestedBy,"requestedBy");
    const expected=`DELETE ${input.scopeKind} ${input.scopeId}`;
    if(input.confirmation!==expected)throw new ValidationError(`Physical deletion requires exact confirmation: ${expected}`);
    const manifest=await this.createManifest("delete",input.scopeKind,input.scopeId,input.requestedBy);
    if(!manifest.owned)throw new ValidationError("Deletion refused: selected scope is not owned by this profile",{scopeKind:input.scopeKind,scopeId:input.scopeId,profileId:this.device.profileId});
    const manifestResources=manifest.resources as Record<string,JsonValue>;
    if(manifest.status==="blocked"){
      if(manifestResources.remoteManaged===true)throw new CapabilityUnavailableError(input.scopeKind==="workspace"?"authenticated deletion of every durable managed replica":"managed-replica deletion at selected granularity",this.transport?.id??"durable replica evidence");
      throw new CapabilityUnavailableError(`physical deletion of ${input.scopeKind} scope`,this.storage.name);
    }
    if(input.scopeKind==="session"&&(typeof this.storage.assertIndependentSessionErasable!=="function"||typeof this.storage.eraseIndependentSession!=="function"))throw new CapabilityUnavailableError("physical deletion of independent session scope",this.storage.name);
    const receiptDirectory=input.receiptDirectory?resolve(input.receiptDirectory):null;
    if((input.scopeKind==="workspace"||input.scopeKind==="profile")&&!receiptDirectory)throw new ValidationError("Workspace/profile deletion requires an external receipt directory");
    if(receiptDirectory&&this.artifactDirectory&&inside(resolve(this.artifactDirectory),receiptDirectory))throw new ValidationError("Deletion receipt directory must be outside the managed artifact directory");
    const receiptPath=receiptDirectory?join(receiptDirectory,`${manifest.manifestId}.json`):null;
    const createdAt=this.#iso();
    const removed={databaseFiles:[] as string[],replicaFiles:[] as string[],artifactFiles:[] as string[],credentialFiles:[] as string[],rows:{} as Record<string,number>};
    const retainedSharedArtifacts:string[]=[];const remoteAdminReceipts:PhysicalDeletionReceipt["remoteAdminReceipts"][number][]=[];
    const build=(status:PhysicalDeletionReceipt["status"],error:string|null,completedAt:string|null):PhysicalDeletionReceipt=>({
      version:1,manifestId:manifest.manifestId,scopeKind:input.scopeKind,scopeId:input.scopeId,requestedBy:input.requestedBy,
      ownerProfileId:this.device.profileId,status,createdAt,completedAt,receiptPath,removed,retainedSharedArtifacts,
      remoteAdminReceipt:remoteAdminReceipts[0]?{adapter:remoteAdminReceipts[0].adapter,receiptId:remoteAdminReceipts[0].receiptId,deletedAt:remoteAdminReceipts[0].deletedAt}:null,
      remoteAdminReceipts,error,
    });
    if(receiptPath)await writeDeletionReceipt(receiptPath,build("executing",null,null));
    try{
      const scopeEvents=await this.#scopeEvents(input.scopeKind,input.scopeId);
      const artifactReferences=this.#artifactReferences(scopeEvents);
      let retainedEvents:AgentEvent[]=[];
      if(input.scopeKind==="session"){
        const otherSessionIds=await this.#workspaceSessionIds();
        retainedEvents=(await Promise.all(otherSessionIds.filter(id=>id!==input.scopeId).map(id=>this.storage.loadEvents(id)))).flat();
      }
      const deletableArtifacts=[] as EventPayloads["ArtifactRegistered"][];
      for(const reference of artifactReferences){
        const retained=retainedEvents.some(event=>stableJson(event.payload).includes(reference.artifactId)||stableJson(event.payload).includes(reference.digest));
        if(retained){retainedSharedArtifacts.push(reference.artifactId);continue;}deletableArtifacts.push(reference);
      }
      if(input.scopeKind==="workspace"){
        if(this.artifactDirectoryOwnership!=="exclusive")throw new CapabilityUnavailableError("whole-workspace deletion without exclusive managed artifact-directory ownership",this.storage.name);
        const syncUrls=jsonStringArray(manifestResources.managedSyncUrls);
        if(manifestResources.remoteManaged===true){
          const admin=this.remoteDeletionAdmin;
          if(!admin||!admin.capabilities.authenticatedAdministration||!admin.capabilities.deleteWorkspaceReplica||!syncUrls.length)throw new CapabilityUnavailableError("authenticated managed-replica deletion",this.transport?.id??"durable replica evidence");
          for(const syncUrl of syncUrls){
            const idempotencyKey=deterministicId("delete-owned-data",input.scopeKind,input.scopeId,input.confirmation,this.device.profileId,syncUrl);
            const result=await admin.deleteWorkspaceReplica({workspaceId:this.workspaceId,syncUrl,requestedBy:input.requestedBy,idempotencyKey});
            remoteAdminReceipts.push({adapter:admin.name,syncUrl,receiptId:required(result.receiptId,"remote deletion receipt ID"),deletedAt:required(result.deletedAt,"remote deletion timestamp")});
          }
        }
        await this.stop();this.storage.close();this.#erased=true;
        const replicaPaths=jsonStringArray(manifestResources.replicaFiles);
        for(const replicaPath of replicaPaths)await removeManagedDatabase(replicaPath,removed.replicaFiles,true);
        if(this.artifactDirectory)await removeTreeAndRecord(resolve(this.artifactDirectory),removed.artifactFiles);
        await removeManagedDatabase(localFilePath(this.databaseUrl,"workspace database"),removed.databaseFiles);
        // Ownership remains live throughout every fallible removal, making a
        // partial deletion reopenable and retryable. Tombstoning is the commit.
        if(this.profile)await this.profile.markWorkspaceDeleted(this.workspaceId,this.#iso());
      }else if(input.scopeKind==="profile"){
        const foreign=(await this.profile?.listWorkspaces(true)??[]).filter(row=>row.ownerProfileId!==this.device.profileId);
        if(foreign.length)throw new ValidationError("Profile database contains foreign-owned workspace catalog rows; refusing whole-file deletion");
        await this.stop();this.profile?.close();
        if(this.profileCredentialPath)await removeFileAndRecord(resolve(this.profileCredentialPath),removed.credentialFiles);
        await removeManagedDatabase(localFilePath(this.profile!.url,"profile database"),removed.databaseFiles);
        const resources={...manifestResources,receiptPath,removed} as JsonValue;
        await this.storage.completeDataManifest(manifest.manifestId,"completed",resources,this.#iso());
        this.storage.close();this.#erased=true;
      }else{
        // Refusal checks precede the CAS pass and are repeated transactionally
        // by eraseIndependentSession after the filesystem work.
        await this.storage.assertIndependentSessionErasable!(input.scopeId);
        await this.#removeArtifacts(deletableArtifacts,removed.artifactFiles);
        const result=await this.storage.eraseIndependentSession!(input.scopeId);Object.assign(removed.rows,result.deletedRows);
        const resources={...manifestResources,receiptPath,removed,retainedSharedArtifacts} as JsonValue;
        await this.storage.completeDataManifest(manifest.manifestId,"completed",resources,this.#iso());
      }
      const completed=build("completed",null,this.#iso());if(receiptPath)await writeDeletionReceipt(receiptPath,completed);return completed;
    }catch(error){
      const completedAt=this.#iso();const partial=build("partial",message(error),completedAt);
      if(input.scopeKind==="session")await this.storage.completeDataManifest(manifest.manifestId,"partial",{...manifestResources,receiptPath,removed,retainedSharedArtifacts,error:message(error)} as JsonValue,completedAt).catch(()=>{});
      if(receiptPath)await writeDeletionReceipt(receiptPath,partial).catch(()=>{});throw error;
    }
  }

  async #owns(scopeKind:"workspace"|"session"|"profile",scopeId:string):Promise<boolean>{
    if(scopeKind==="profile")return scopeId===this.device.profileId;
    const catalog=await this.profile?.getWorkspace(this.workspaceId);
    const workspaceOwned=!!catalog&&catalog.ownerProfileId===this.device.profileId&&catalog.deletedAt===null;
    if(scopeKind==="workspace")return scopeId===this.workspaceId&&workspaceOwned;
    const session=await this.storage.getSession?.(scopeId);return workspaceOwned&&session?.workspaceId===this.workspaceId;
  }
  async #durableReplicaEvidence():Promise<DurableReplicaEvidence>{
    const catalog=await this.profile?.getWorkspace(this.workspaceId)??null;
    const statuses=await this.storage.listReplicaStatuses(this.workspaceId);
    const watermarks=(await Promise.all(statuses.map(status=>this.storage.listSyncOriginWatermarks(status.replicaId)))).flat();
    const byReplica=new Map<string,SyncOriginWatermarkRecord[]>();
    for(const watermark of watermarks){const rows=byReplica.get(watermark.replicaId)??[];rows.push(watermark);byReplica.set(watermark.replicaId,rows);}
    const syncUrls=new Set<string>();const localReplicaUrls=new Set<string>();const unaddressableManagedReplicas=new Set<string>();let remoteManaged=this.transport!==null;
    const addLocal=(value:string|null|undefined)=>{const path=localReplicaPlacement(value);if(path)localReplicaUrls.add(path);};
    addLocal(this.replicaUrl);addLocal(catalog?.replicaUrl);
    for(const status of statuses){
      addLocal(status.replicaUrl);if(status.syncUrl)syncUrls.add(status.syncUrl);
      const managed=statusIsManaged(status,byReplica.get(status.replicaId)??[]);if(!managed)continue;remoteManaged=true;
      if(!status.syncUrl)unaddressableManagedReplicas.add(status.replicaId);
    }
    if(catalogIsManaged(catalog)){
      remoteManaged=true;
      if(catalog!.syncUrl)syncUrls.add(catalog!.syncUrl);
      else if(!statuses.some(status=>status.replicaId===catalog!.replicaUrl&&status.syncUrl))unaddressableManagedReplicas.add(`catalog:${catalog!.workspaceId}`);
    }
    // Migration-005 did not retain replica_url. A managed status plus no other
    // local placement means Supervisor's historical adjacent default remains a
    // known candidate and must be enumerated rather than forgotten.
    if(remoteManaged&&syncUrls.size>0&&localReplicaUrls.size===0){try{localReplicaUrls.add(localFilePath(`${this.databaseUrl}.sync-replica.db`,"legacy default replica database"));}catch{}}
    return{catalog,statuses,watermarks:watermarks.sort((a,b)=>a.replicaId.localeCompare(b.replicaId)||a.originDeviceId.localeCompare(b.originDeviceId)),syncUrls:[...syncUrls].sort(),localReplicaUrls:[...localReplicaUrls].sort(),unaddressableManagedReplicas:[...unaddressableManagedReplicas].sort(),remoteManaged};
  }
  async #workspaceSessionIds():Promise<string[]>{const ids=new Set<string>();for(const branch of await this.storage.listBranches()){const session=await this.storage.getSession?.(branch.sessionId);if(session?.workspaceId===this.workspaceId)ids.add(branch.sessionId);}return[...ids].sort();}
  async #scopeEvents(scopeKind:"workspace"|"session"|"profile",scopeId:string):Promise<AgentEvent[]>{if(scopeKind==="profile")return[];const ids=scopeKind==="session"?[scopeId]:await this.#workspaceSessionIds();return(await Promise.all(ids.map(id=>this.storage.loadEvents(id)))).flat();}
  #artifactReferences(events:readonly AgentEvent[]):EventPayloads["ArtifactRegistered"][]{const seen=new Set<string>();const result:EventPayloads["ArtifactRegistered"][]=[];for(const event of events){if(event.type!=="ArtifactRegistered")continue;const reference=event.payload as EventPayloads["ArtifactRegistered"];if(seen.has(reference.digest))continue;seen.add(reference.digest);result.push(reference);}return result;}
  async #removeArtifacts(references:readonly EventPayloads["ArtifactRegistered"][],removed:string[]):Promise<void>{
    if(!this.artifactDirectory&&references.length)throw new CapabilityUnavailableError("managed artifact deletion without a local artifact placement",this.storage.name);
    for(const reference of references){const file=join(this.artifactDirectory!,reference.digest.slice(0,2),reference.digest.slice(2));await removeFileAndRecord(file,removed);await rm(dirname(file),{recursive:false}).catch(()=>{});}
  }

  async #cycle(trigger:SyncTrigger):Promise<SyncCycleResult>{
    await this.#save({lifecycle:"syncing",lastAttemptAt:this.#iso(),lastError:null});
    try{
      const staged=await this.stage();let native:SyncCycleResult["native"];
      if(this.capabilities.directionalNetworkPush){
        const transport=this.#directional("sync");const before=await transport.stats();let pullChanged=false;
        // A known remote revision makes a pre-pull useful. A brand-new replica
        // pushes its local CDC first, so first-launch work cannot be bootstrapped away.
        if(before.revision!==null||before.lastPullUnixTime!==null)pullChanged=await transport.pull();
        await transport.push();pullChanged=await transport.pull()||pullChanged;
        await transport.checkpoint();const stats=await transport.stats();
        native={mode:"directional",pullChanged,checkpointed:true,stats,bidirectional:null};
      }else{
        if(!this.transport?.sync)throw unavailable("network sync");const progress=await this.transport.sync();
        native={mode:"bidirectional",pullChanged:null,checkpointed:false,stats:null,bidirectional:progress};
      }
      const result=await this.ingest();await this.#networkSucceeded(native.stats,{ingestedEnvelopes:this.#status.ingestedEnvelopes+result.ingested,quarantinedEnvelopes:this.#status.quarantinedEnvelopes+result.quarantined});return{trigger,staged,...result,native,status:this.#status};
    }catch(error){await this.#networkFailed(error);throw error;}
  }

  async #envelope(event:AgentEvent):Promise<ReplicatedEnvelope>{
    const crossSessionDependencies:string[]=[];
    if(event.type==="RecursiveModelStatusChanged"){
      const payload=event.payload as EventPayloads["RecursiveModelStatusChanged"];
      const result=payload.result&&typeof payload.result==="object"&&!Array.isArray(payload.result)
        ? payload.result as Record<string,JsonValue>
        : undefined;
      if(payload.status==="completed"&&result?.kind==="tool-submission"&&typeof result.modelCallId==="string"){
        const parent=await this.storage.loadEvents(event.sessionId,{branchId:event.branchId});
        const started=[...parent].reverse().find(candidate=>candidate.type==="RecursiveModelStarted"&&(candidate.payload as EventPayloads["RecursiveModelStarted"]).handleId===payload.handleId);
        const admission=started?.payload as EventPayloads["RecursiveModelStarted"]|undefined;
        if(admission){
          const child=await this.storage.loadEvents(admission.childSessionId,{branchId:admission.childBranchId});
          const completion=child.find(candidate=>candidate.type==="ModelCallCompleted"&&(candidate.payload as EventPayloads["ModelCallCompleted"]).callId===result.modelCallId);
          if(completion)crossSessionDependencies.push(completion.id);
        }
      }
    }
    const dependencies=[...new Set([event.streamParentId,event.causationId,...crossSessionDependencies].filter((x):x is string=>x!==null))].sort();const body={id:event.id,sessionId:event.sessionId,branchId:event.branchId,causationId:event.causationId,correlationId:event.correlationId,type:event.type,schemaVersion:event.schemaVersion,committedAt:event.committedAt,producer:event.producer,idempotencyKey:event.idempotencyKey,payload:event.payload as JsonValue,streamParentId:event.streamParentId};
    // Event IDs are logical identity, not physical row identity. Including the
    // origin tuple and content digest lets two writers retain colliding raw
    // claims for reconciliation instead of wedging the append-only transport.
    const identity={workspaceId:this.workspaceId,originDeviceId:event.originDeviceId,originSequence:event.originSequence,entityKind:"event" as const,entityId:event.id,dependencies,body};const envelopeId=replicatedEnvelopeId(identity);
    const withoutDigest:Omit<ReplicatedEnvelope,"digest">={protocolVersion:1,envelopeId,...identity,createdAt:event.committedAt};return{...withoutDigest,digest:envelopeDigest(withoutDigest)};
  }

  async #ingest(raw:readonly ReplicatedEnvelope[],watermarks:readonly SyncOriginWatermarkRecord[]):Promise<{ingested:number;duplicates:number;quarantined:number;conflicts:number}>{
    let ingested=0,duplicates=0,quarantined=0,conflicts=0;const valid:ReplicatedEnvelope[]=[];const retry=new Set<string>();const quarantineCache=new Map<string,SyncQuarantineRecord|null>();
    const oldQuarantine=async(envelopeId:string):Promise<SyncQuarantineRecord|undefined>=>{if(!quarantineCache.has(envelopeId))quarantineCache.set(envelopeId,await this.storage.getSyncQuarantine(envelopeId));return quarantineCache.get(envelopeId)??undefined;};
    for(const envelope of raw){try{this.#validateEnvelope(envelope);valid.push(envelope);}catch(error){quarantined++;await this.#quarantine(envelope,"INVALID_ENVELOPE",message(error),"quarantined",await oldQuarantine(String((envelope as any)?.envelopeId)));}}
    valid.sort(compareEnvelope);const pending=[...valid];let progressed=true;
    while(pending.length&&progressed){progressed=false;for(let i=0;i<pending.length;){const envelope=pending[i]!;const receipt=await this.storage.getSyncReceipt(envelope.envelopeId);
        if(receipt){if(receipt.digest!==envelope.digest){await this.#quarantine(envelope,"ENVELOPE_COLLISION","Previously ingested physical envelope identity has a different digest","quarantined",await oldQuarantine(envelope.envelopeId));await this.#recordConflict("duplicate_event",envelope,[receipt.eventId,envelope.body.id],{sameContent:false,reason:"physical envelope digest collision",retainedDigest:receipt.digest,incomingDigest:envelope.digest},"unresolved",null,[envelope.envelopeId,envelope.digest]);quarantined++;conflicts++;}else duplicates++;pending.splice(i,1);progressed=true;continue;}
        if(!await this.#dependenciesReady(envelope)){i++;continue;}
        try{const outcome=await this.#ingestOne(envelope);ingested+=outcome.ingested;duplicates+=outcome.duplicate;conflicts+=outcome.conflicts;if(outcome.quarantine){await this.#quarantine(envelope,outcome.quarantine.code,outcome.quarantine.reason,"quarantined",await oldQuarantine(envelope.envelopeId));quarantined++;}else if(await oldQuarantine(envelope.envelopeId))await this.#quarantine(envelope,"RELEASED","Dependencies and validation now pass","released",await oldQuarantine(envelope.envelopeId));pending.splice(i,1);progressed=true;}
        catch(error){const code=(error as any)?.code;if(code==="NOT_FOUND"||code==="INVALID_TRANSITION"){i++;continue;}await this.#quarantine(envelope,"REJECTED_MUTATION",message(error),"quarantined",await oldQuarantine(envelope.envelopeId));await this.#recordConflict("rejected_mutation",envelope,[envelope.body.id],{error:message(error),envelopeId:envelope.envelopeId},"unresolved",null,[envelope.envelopeId]);conflicts++;quarantined++;pending.splice(i,1);progressed=true;}
      }}
    for(const envelope of pending){retry.add(envelope.envelopeId);await this.#quarantine(envelope,"MISSING_CAUSAL_DEPENDENCY",`Missing dependency for ${envelope.dependencies.join(", ")||envelope.body.streamParentId||"branch"}`,"pending_dependency",await oldQuarantine(envelope.envelopeId));quarantined++;}
    await this.#advanceIngestWatermarks(raw,retry,watermarks);return{ingested,duplicates,quarantined,conflicts};
  }

  async #advanceIngestWatermarks(raw:readonly ReplicatedEnvelope[],retry:ReadonlySet<string>,oldRows:readonly SyncOriginWatermarkRecord[]):Promise<void>{
    const old=new Map(oldRows.map(row=>[row.originDeviceId,row]));const grouped=new Map<string,ReplicatedEnvelope[]>();for(const envelope of raw){if(typeof (envelope as any)?.originDeviceId!=="string"||!Number.isSafeInteger((envelope as any)?.originSequence)||(envelope as any).originSequence<1)continue;const rows=grouped.get(envelope.originDeviceId)??[];rows.push(envelope);grouped.set(envelope.originDeviceId,rows);}
    for(const [origin,rows] of grouped){const previous=old.get(origin);const retrySequences=rows.filter(row=>retry.has(row.envelopeId)).map(row=>row.originSequence);const firstRetry=retrySequences.length?Math.min(...retrySequences):Number.POSITIVE_INFINITY;const handled=rows.filter(row=>!retry.has(row.envelopeId)&&row.originSequence<firstRetry).map(row=>row.originSequence);const ingestedSequence=Math.max(previous?.ingestedSequence??0,...handled);if(ingestedSequence>(previous?.ingestedSequence??0))await this.storage.putSyncOriginWatermark({replicaId:this.replicaId,originDeviceId:origin,stagedSequence:previous?.stagedSequence??0,ingestedSequence,updatedAt:this.#iso()});}
  }

  async #dependenciesReady(envelope:ReplicatedEnvelope):Promise<boolean>{for(const id of envelope.dependencies){if(await this.storage.getEvent(id))continue;const other=await this.storage.getSyncReceiptForEvent(id);if(!other)return false;}return true;}
  async #ingestOne(envelope:ReplicatedEnvelope):Promise<{ingested:number;duplicate:number;conflicts:number;quarantine?:{code:string;reason:string}}>{
    const body=envelope.body;const incomingClaimDigest=eventClaimDigest(envelope.originDeviceId,envelope.originSequence,body);const byId=await this.storage.getEvent(body.id);
    if(byId){const retainedClaimDigest=eventClaimDigest(byId.originDeviceId,byId.originSequence,eventBody(byId));const sameContent=retainedClaimDigest===incomingClaimDigest;if(!sameContent){await this.#recordConflict("duplicate_event",envelope,[body.id],{sameContent:false,retainedClaimDigest,incomingClaimDigest,retainedOriginDeviceId:byId.originDeviceId,retainedOriginSequence:byId.originSequence,incomingOriginDeviceId:envelope.originDeviceId,incomingOriginSequence:envelope.originSequence,envelopeId:envelope.envelopeId},"unresolved",null,[body.id,...[retainedClaimDigest,incomingClaimDigest].sort()]);return{ingested:0,duplicate:0,conflicts:1,quarantine:{code:"DIVERGENT_DUPLICATE_EVENT",reason:`Event ID ${body.id} is already retained with different content or origin identity`}};}await this.#receipt(envelope,body.branchId,byId.branchId);await this.#recordConflict("duplicate_event",envelope,[body.id],{sameContent:true,retainedClaimDigest,incomingClaimDigest,action:"content-verified deduplication"},"resolved",null,[body.id,incomingClaimDigest]);return{ingested:0,duplicate:1,conflicts:0};}
    const byOrigin=await this.storage.findEventByOriginSequence(envelope.originDeviceId,envelope.originSequence);if(byOrigin){const retainedClaimDigest=eventClaimDigest(byOrigin.originDeviceId,byOrigin.originSequence,eventBody(byOrigin));await this.#recordConflict("rejected_mutation",envelope,[byOrigin.id,body.id],{reason:"origin sequence collision",retainedClaimDigest,incomingClaimDigest,originDeviceId:envelope.originDeviceId,originSequence:envelope.originSequence,envelopeId:envelope.envelopeId},"unresolved",null,[envelope.originDeviceId,String(envelope.originSequence),...[retainedClaimDigest,incomingClaimDigest].sort()]);return{ingested:0,duplicate:0,conflicts:1,quarantine:{code:"ORIGIN_SEQUENCE_COLLISION",reason:`Origin ${envelope.originDeviceId} sequence ${envelope.originSequence} already identifies a different event`}};}
    if(body.idempotencyKey){const existing=await this.storage.findEventByIntent(body.sessionId,body.type,body.idempotencyKey);if(existing){await this.#recordConflict("duplicate_intent",envelope,[existing.id,body.id],{samePayload:stableJson(existing.payload)===stableJson(body.payload),retainedClaimDigest:eventClaimDigest(existing.originDeviceId,existing.originSequence,eventBody(existing)),incomingClaimDigest});await this.#receipt(envelope,body.branchId,existing.branchId);return{ingested:0,duplicate:1,conflicts:1};}}
    let branchId=body.branchId;let payload=body.payload;let mapping:SyncBranchMappingRecord|null=null;let conflictCount=0;
    if(body.type!=="SessionCreated"&&body.type!=="BranchCreated"){
      if(!body.streamParentId)throw new ValidationError("A non-root replicated event requires a stream parent");
      mapping=await this.storage.getBranchMapping(envelope.originDeviceId,body.sessionId,body.branchId,body.streamParentId);
      if(mapping)branchId=mapping.derivedBranchId;
      else {const tip=await this.storage.getDirectBranchTip(body.sessionId,body.branchId);if(!tip)throw new ValidationError("Source branch is unavailable");if(tip.id!==body.streamParentId){const forkCursor=await this.storage.getEventCursor(body.streamParentId);if(!forkCursor)throw new ValidationError("Stream parent is unavailable");const derivedBranchId=deterministicId("sync-branch",envelope.originDeviceId,body.sessionId,body.branchId,body.streamParentId);const mappingId=deterministicId("mapping",envelope.originDeviceId,body.sessionId,body.branchId,body.streamParentId);await this.storage.appendEvents([{id:deterministicId("sync-fork",mappingId),sessionId:body.sessionId,branchId:derivedBranchId,type:"BranchCreated",producer:"sync-derived",idempotencyKey:`sync-fork:${mappingId}`,payload:{branchId:derivedBranchId,parentBranchId:body.branchId,forkCursor,name:`offline ${envelope.originDeviceId.slice(-8)}`}}]);mapping={mappingId,originDeviceId:envelope.originDeviceId,sessionId:body.sessionId,sourceBranchId:body.branchId,forkEventId:body.streamParentId,derivedBranchId,lastSourceEventId:body.streamParentId,createdAt:this.#iso()};await this.storage.putBranchMapping(mapping);branchId=derivedBranchId;const divergentOrigins=[tip.originDeviceId,envelope.originDeviceId].sort();const profileControl=body.type==="AgentProfileVersionCreated"||body.type==="AgentProfileActivated";await this.#recordConflict("divergent_session",envelope,[tip.id,body.id],{sourceBranchId:body.branchId,derivedBranchId,forkEventId:body.streamParentId,originDeviceIds:divergentOrigins,profileControl,policy:profileControl?"preserve both branches and refuse ambiguous runnable profile lookup":"preserve both branches"},"unresolved",null,[this.workspaceId,body.sessionId,body.branchId,body.streamParentId,...divergentOrigins]);conflictCount++;}}
      if(branchId!==body.branchId)payload=remapPayload(body.type,payload,body.branchId,branchId);
    }
    if(body.type==="TaskStatusChanged"&&(payload as any).status==="running"){const taskId=String((payload as any).taskId);const claims=await this.storage.findTaskClaimEvents(taskId);const others=claims.filter(x=>x.originDeviceId!==envelope.originDeviceId);if(others.length){await this.#recordConflict("task_claim",envelope,[...others.map(x=>x.id),body.id],{taskId,policy:"no automatic winner"},"unresolved",taskId);conflictCount++;}}
    const candidate:NewAgentEvent={id:body.id,sessionId:body.sessionId,branchId,causationId:body.causationId,correlationId:body.correlationId,type:body.type,schemaVersion:body.schemaVersion,committedAt:body.committedAt,producer:body.producer,idempotencyKey:body.idempotencyKey,payload:payload as never,originDeviceId:envelope.originDeviceId,originSequence:envelope.originSequence,streamParentId:body.streamParentId};
    await this.storage.appendReplicatedEvent(candidate);if(mapping)await this.storage.advanceBranchMapping(mapping.mappingId,body.id);await this.#receipt(envelope,body.branchId,branchId);return{ingested:1,duplicate:0,conflicts:conflictCount};
  }

  #validateEnvelope(value:ReplicatedEnvelope):void{
    if(!value||typeof value!=="object"||value.protocolVersion!==1||value.entityKind!=="event")throw new ValidationError("Unsupported replicated envelope");
    for(const field of [value.envelopeId,value.workspaceId,value.originDeviceId,value.entityId,value.digest,value.createdAt])required(field,"envelope field");
    if(value.workspaceId!==this.workspaceId)throw new ValidationError("Envelope belongs to a different workspace");if(!Number.isFinite(Date.parse(value.createdAt))||!Number.isFinite(Date.parse(value.body?.committedAt)))throw new ValidationError("Envelope timestamps must be ISO-compatible datetimes");if(!Number.isSafeInteger(value.originSequence)||value.originSequence<1)throw new ValidationError("Invalid origin sequence");if(!Array.isArray(value.dependencies)||value.dependencies.some(x=>typeof x!=="string"))throw new ValidationError("Invalid dependency list");if(value.entityId!==value.body?.id)throw new ValidationError("Envelope entity ID does not match body");if(replicatedEnvelopeId(value)!==value.envelopeId)throw new ValidationError("Envelope physical identity is not content-and-origin keyed");const{digest,...rest}=value;if(envelopeDigest(rest)!==digest)throw new ValidationError("Envelope digest mismatch");const candidate:NewAgentEvent={id:value.body.id,sessionId:value.body.sessionId,branchId:value.body.branchId,causationId:value.body.causationId,correlationId:value.body.correlationId,type:value.body.type,schemaVersion:value.body.schemaVersion,committedAt:value.body.committedAt,producer:value.body.producer,idempotencyKey:value.body.idempotencyKey,payload:value.body.payload as never,originDeviceId:value.originDeviceId,originSequence:value.originSequence,streamParentId:value.body.streamParentId};validateNewEvent(candidate);
  }
  async #receipt(e:ReplicatedEnvelope,sourceBranchId:string,mappedBranchId:string):Promise<void>{await this.storage.putSyncReceipt({envelopeId:e.envelopeId,digest:e.digest,originDeviceId:e.originDeviceId,originSequence:e.originSequence,eventId:e.body.id,sourceBranchId,mappedBranchId,ingestedAt:this.#iso()});}
  async #quarantine(e:any,reasonCode:string,reason:string,status:SyncQuarantineRecord["status"],old?:SyncQuarantineRecord):Promise<void>{const now=this.#iso();const record:SyncQuarantineRecord={envelopeId:typeof e?.envelopeId==="string"?e.envelopeId:deterministicId("invalid",stableJson(e)),workspaceId:typeof e?.workspaceId==="string"?e.workspaceId:this.workspaceId,originDeviceId:typeof e?.originDeviceId==="string"?e.originDeviceId:null,originSequence:Number.isSafeInteger(e?.originSequence)?e.originSequence:null,reasonCode,reason,envelope:jsonSafe(e),digest:typeof e?.digest==="string"?e.digest:null,status,firstSeenAt:old?.firstSeenAt??now,lastSeenAt:now};await this.storage.putSyncQuarantine(record);}
  async #recordConflict(kind:SyncConflictRecord["kind"],e:ReplicatedEnvelope,eventIds:string[],details:JsonValue,status:SyncConflictRecord["status"]="unresolved",taskId:string|null=null,identityParts?:readonly string[]):Promise<void>{const ids=[...new Set(eventIds)].sort();const origins=[...new Set([e.originDeviceId,...(await Promise.all(ids.map(id=>this.storage.getEvent(id)))).filter((x):x is AgentEvent=>x!==null).map(x=>x.originDeviceId)])].sort();const conflictId=deterministicId("sync-conflict",kind,...(identityParts??ids));await this.storage.putSyncConflict({conflictId,kind,workspaceId:this.workspaceId,sessionId:e.body.sessionId,taskId,eventIds:ids,originDeviceIds:origins,details,status,...(status==="resolved"?{resolution:details}:{}),detectedAt:this.#iso(),resolvedAt:status==="resolved"?this.#iso():null});}
  #directional(operation:string):DirectionalTransport{const transport=this.transport;if(!transport||transport.capabilities.networkExchange!=="directional"||!transport.push||!transport.pull||!transport.checkpoint||!transport.stats)throw new CapabilityUnavailableError(`directional network ${operation}`,transport?.capabilities.nativeMethod??"local-only sync service");return transport as DirectionalTransport;}
  async #networkSucceeded(stats:SyncTransportStats|null,patch:Partial<WorkspaceReplicaStatusRecord>={}):Promise<void>{await this.#save({...patch,lifecycle:"online",lastSuccessAt:this.#iso(),lastError:null,...(stats?{lastStats:stats}:{})});}
  async #networkFailed(error:unknown):Promise<void>{await this.#save({lifecycle:"error",lastError:message(error)});}
  async #save(patch:Partial<WorkspaceReplicaStatusRecord>):Promise<void>{this.#status={...this.#status,...patch,updatedAt:this.#iso()};await this.storage.putReplicaStatus(this.#status);}
  async #catalog():Promise<void>{
    if(!this.profile)return;const old=await this.profile.getWorkspace(this.workspaceId);
    if(old&&old.ownerProfileId!==this.device.profileId)throw new ValidationError("Configured workspace is owned by another profile",{workspaceId:this.workspaceId,ownerProfileId:old.ownerProfileId,profileId:this.device.profileId});
    if(old?.deletedAt)throw new ValidationError("Configured workspace is tombstoned and cannot be silently reclaimed",{workspaceId:this.workspaceId,deletedAt:old.deletedAt});
    const now=this.#iso();await this.profile.putWorkspace({workspaceId:this.workspaceId,name:this.workspaceName,databaseUrl:this.databaseUrl,
      replicaUrl:this.replicaUrl??old?.replicaUrl??(this.transport?this.transport.id:null),syncUrl:this.#status.syncUrl??old?.syncUrl??null,
      credentialReference:this.#status.credentialReference??old?.credentialReference??null,ownerProfileId:this.device.profileId,
      createdAt:old?.createdAt??now,updatedAt:now,deletedAt:null});
  }
  #iso():string{return this.#now().toISOString();}
}

interface DurableReplicaEvidence {
  readonly catalog:WorkspaceCatalogEntry|null;
  readonly statuses:WorkspaceReplicaStatusRecord[];
  readonly watermarks:SyncOriginWatermarkRecord[];
  readonly syncUrls:string[];
  readonly localReplicaUrls:string[];
  readonly unaddressableManagedReplicas:string[];
  readonly remoteManaged:boolean;
}
function inside(root:string,candidate:string):boolean{const rel=relative(root,candidate);return rel===""||(!rel.startsWith("..")&&!isAbsolute(rel));}
function localFilePath(value:string,label:string):string{
  try{if(value.startsWith("file:"))return resolve(fileURLToPath(new URL(value)));}catch{throw new CapabilityUnavailableError(`physical deletion of non-local ${label}`,value);}
  if(isAbsolute(value))return resolve(value);
  throw new CapabilityUnavailableError(`physical deletion of non-local ${label}`,value);
}
function localReplicaPlacement(value:string|null|undefined):string|null{if(!value)return null;try{return localFilePath(value,"replica database");}catch{return null;}}
function catalogIsManaged(row:WorkspaceCatalogEntry|null):boolean{return !!row&&(!!row.syncUrl||!!row.credentialReference||!!row.replicaUrl&&!localReplicaPlacement(row.replicaUrl));}
function statusIsManaged(status:WorkspaceReplicaStatusRecord,watermarks:readonly SyncOriginWatermarkRecord[]):boolean{
  return !!status.syncUrl||!!status.credentialReference||!!status.replicaIncarnation||status.lastAttemptAt!==null||status.lastSuccessAt!==null||status.lastStats!==null||
    status.stagedEnvelopes>0||status.ingestedEnvelopes>0||status.quarantinedEnvelopes>0||watermarks.some(row=>row.stagedSequence>0||row.ingestedSequence>0)||!status.replicaId.startsWith("local:");
}
function jsonStringArray(value:JsonValue|undefined):string[]{return Array.isArray(value)?[...new Set(value.filter((item):item is string=>typeof item==="string"&&item.length>0))].sort():[];}
const LOCAL_SQLITE_SUFFIXES=["","-wal","-shm","-journal"] as const;
const TURSO_SYNC_SUFFIXES=["-info","-changes","-wal-revert","-replace-base-apply"] as const;
async function managedDatabaseFiles(databasePath:string,syncEngine=false):Promise<string[]>{
  const directory=dirname(databasePath),name=basename(databasePath);let entries:string[];
  try{entries=await readdir(directory);}catch(error){if(missingPathError(error))return[];throw error;}
  const suffixes=syncEngine?[...LOCAL_SQLITE_SUFFIXES,...TURSO_SYNC_SUFFIXES]:LOCAL_SQLITE_SUFFIXES;
  const owned=new Set(suffixes.map(suffix=>`${name}${suffix}`));
  if(syncEngine)owned.add(`${basename(name,extname(name))}.db-log`);
  const backupNames=new Set(["main-db","main-wal","main-log","revert-wal","metadata"].map(part=>`${name}-replace-base-apply-${part}.backup`));
  const selected=entries.filter(entry=>owned.has(entry)||(syncEngine&&backupNames.has(entry)));
  // The primary SQLite file is the ownership/identity anchor. Sidecars are
  // removed first so a failed pass remains reopenable with the original data.
  return selected.sort((a,b)=>(a===name?1:0)-(b===name?1:0)||a.localeCompare(b)).map(entry=>join(directory,entry));
}
async function removeManagedDatabase(databasePath:string,removed:string[],syncEngine=false):Promise<void>{for(const file of await managedDatabaseFiles(databasePath,syncEngine))await removeFileAndRecord(file,removed);}
function missingPathError(error:unknown):boolean{return !!error&&typeof error==="object"&&"code" in error&&((error as {code?:unknown}).code==="ENOENT"||(error as {code?:unknown}).code==="ENOTDIR");}
async function pathExists(path:string):Promise<boolean>{try{await lstat(path);return true;}catch(error){return !missingPathError(error);}}
async function removeFileAndRecord(path:string,removed:string[]):Promise<void>{
  let stat;try{stat=await lstat(path);}catch(error){if(missingPathError(error))return;throw error;}
  try{await rm(path,{force:true,recursive:stat.isDirectory()});}
  catch(error){if(!await pathExists(path)&&!removed.includes(path))removed.push(path);throw error;}
  if(!await pathExists(path)&&!removed.includes(path))removed.push(path);
}
async function listFilesRecursively(root:string):Promise<string[]>{
  let entries;try{entries=await readdir(root,{withFileTypes:true});}catch(error){if(missingPathError(error))return[];throw error;}const result:string[]=[];
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){const path=join(root,entry.name);if(entry.isDirectory())result.push(...await listFilesRecursively(path));else result.push(path);}return result;
}
async function removeTreeAndRecord(root:string,removed:string[]):Promise<void>{
  const before=await listFilesRecursively(root);let failure:unknown;
  try{await rm(root,{recursive:true,force:true});}catch(error){failure=error;}
  for(const file of before)if(!await pathExists(file)&&!removed.includes(file))removed.push(file);
  if(failure!==undefined)throw failure;
}
async function writeDeletionReceipt(path:string,receipt:PhysicalDeletionReceipt):Promise<void>{
  await mkdir(dirname(path),{recursive:true});const temporary=`${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary,JSON.stringify(receipt,null,2)+"\n");await rename(temporary,path);
}

type DirectionalTransport=SyncTransport&Required<Pick<SyncTransport,"push"|"pull"|"checkpoint"|"stats">>;
function compareEnvelope(a:ReplicatedEnvelope,b:ReplicatedEnvelope):number{return a.createdAt.localeCompare(b.createdAt)||a.originSequence-b.originSequence||a.originDeviceId.localeCompare(b.originDeviceId)||a.envelopeId.localeCompare(b.envelopeId);}
function compareAnnouncement(a:WorkspaceAnnouncement,b:WorkspaceAnnouncement):number{return b.updatedAt.localeCompare(a.updatedAt)||a.deviceId.localeCompare(b.deviceId);}
function required(value:string|undefined,name:string):string{if(!value?.trim())throw new ValidationError(`${name} is required`);return value;}
function message(error:unknown):string{return error instanceof Error?error.message:String(error);}
function unavailable(operation:string):CapabilityUnavailableError{return new CapabilityUnavailableError(operation, "local-only sync service");}
function jsonSafe(value:unknown):JsonValue{try{return JSON.parse(JSON.stringify(value??null)) as JsonValue;}catch{return String(value);}}

function eventBody(event:AgentEvent):ReplicatedEventBody{return{id:event.id,sessionId:event.sessionId,branchId:event.branchId,causationId:event.causationId,correlationId:event.correlationId,type:event.type,schemaVersion:event.schemaVersion,committedAt:event.committedAt,producer:event.producer,idempotencyKey:event.idempotencyKey,payload:event.payload as JsonValue,streamParentId:event.streamParentId};}
function eventClaimDigest(originDeviceId:string,originSequence:number,body:ReplicatedEventBody):string{return sha256Text(stableJson({originDeviceId,originSequence,body}));}
function remapPayload(type:string,payload:JsonValue,source:string,target:string):JsonValue{if(!payload||typeof payload!=="object"||Array.isArray(payload))return payload;const copy={...payload} as Record<string,JsonValue>;for(const key of ["parentBranchId","fromBranchId","toBranchId","targetBranchId"]){if(copy[key]===source)copy[key]=target;}if(type==="BranchCreated"&&copy.branchId===source)copy.branchId=target;return copy;}

interface ExportCompletenessAudit {
  readonly version:1;
  readonly complete:boolean;
  readonly eventCount:number;
  readonly profileVersionCount:number;
  readonly governedProposalCount:number;
  readonly reviewRequestCount:number;
  readonly decisionCount:number;
  readonly missing:string[];
}
function auditExportCompleteness(events:readonly AgentEvent[],missingArtifacts:readonly string[]):ExportCompletenessAudit{
  const eventIds=new Set(events.map(event=>event.id));
  const sessionIds=new Set(events.filter(event=>event.type==="SessionCreated").map(event=>event.sessionId));
  const profiles=new Map<string,{digest:string;eventId:string}>();
  const versions=new Set<string>();
  const proposals=new Set<string>();
  const reviewRequests=new Map<string,string>();
  const reviewChildren=new Map<string,{handleId:string;childSessionId:string}>();
  const decisions=new Map<string,string>();
  const modelRequestsBySession=new Set<string>();
  const recursiveHandles=new Set<string>();
  const issues=new Set<string>();
  const missing=(kind:string,id:string)=>issues.add(`${kind}:${id}`);
  for(const event of events){
    const payload=event.payload as any;
    if(event.type==="SessionCreated"){
      const profile=payload.agentProfile;profiles.set(profile.profileVersionId,{digest:profile.promptDigest,eventId:event.id});versions.add(profile.profileVersionId);
    }else if(event.type==="AgentProfileVersionCreated"){
      const profile=payload.agentProfile;profiles.set(profile.profileVersionId,{digest:profile.promptDigest,eventId:event.id});versions.add(profile.profileVersionId);
    }else if(event.type==="HarnessVersionCreated")versions.add(payload.versionId);
    else if(event.type==="GovernedRefinementProposed")proposals.add(payload.proposalId);
    else if(event.type==="RefinementGovernanceReviewRequested")reviewRequests.set(payload.reviewId,payload.proposalId);
    else if(event.type==="RefinementGovernanceReviewChildLinked")reviewChildren.set(payload.reviewId,{handleId:payload.handleId,childSessionId:payload.childSessionId});
    else if(event.type==="RefinementGovernanceReviewDecided")decisions.set(payload.decisionId,payload.proposalId);
    else if(event.type==="RecursiveModelStarted")recursiveHandles.add(payload.handleId);
    else if(event.type==="ModelCallRequested")modelRequestsBySession.add(event.sessionId);
  }
  for(const event of events){
    const payload=event.payload as any;
    if(event.type==="SessionCreated"||event.type==="AgentProfileVersionCreated"){
      const profile=payload.agentProfile;
      if(profile.supersedesProfileVersionId&&!profiles.has(profile.supersedesProfileVersionId))missing("profile-version",profile.supersedesProfileVersionId);
      if(profile.restoresProfileVersionId&&!profiles.has(profile.restoresProfileVersionId))missing("restored-profile-version",profile.restoresProfileVersionId);
      if(profile.sourceProposalId&&!proposals.has(profile.sourceProposalId))missing("governed-proposal",profile.sourceProposalId);
      if(profile.reviewDecisionId&&!decisions.has(profile.reviewDecisionId))missing("governance-decision",profile.reviewDecisionId);
      if(profile.sourceSpecVersionId&&!versions.has(profile.sourceSpecVersionId))missing("source-spec-version",profile.sourceSpecVersionId);
      for(const evidenceId of profile.evidenceEventIds??[])if(!eventIds.has(evidenceId))missing("evidence-event",evidenceId);
    }
    if(event.type==="AgentRunRequested"||event.type==="RecursiveModelStarted"){
      const pin=payload.profilePin;const profile=profiles.get(pin.profileVersionId);
      if(!profile)missing("invocation-profile",pin.profileVersionId);
      else if(profile.digest!==pin.agentPromptDigest)missing("invocation-profile-digest",pin.profileVersionId);
    }
    if((event.type==="ContextMaterialized"||event.type==="ModelCallRequested")&&payload.promptProvenance){
      const pin=payload.promptProvenance;const profile=profiles.get(pin.profileVersionId);
      if(!profile)missing("prompt-profile",pin.profileVersionId);
      else if(profile.digest!==pin.agentPromptDigest)missing("prompt-profile-digest",pin.profileVersionId);
    }
    if(event.type==="GovernedRefinementProposed"){
      const proposal=payload.proposal;
      for(const evidenceId of proposal?.evidenceEventIds??[])if(!eventIds.has(evidenceId))missing("proposal-evidence-event",evidenceId);
      if(proposal?.target?.kind==="agent_profile"&&!profiles.has(proposal.target.expectedProfileVersionId))missing("proposal-target-profile",proposal.target.expectedProfileVersionId);
    }
    if(event.type==="RefinementGovernanceReviewRequested"){
      if(!proposals.has(payload.proposalId))missing("governed-proposal",payload.proposalId);
      if(!payload.frozenInput?.reviewerDispatch?.configuration)missing("frozen-reviewer-dispatch",payload.reviewId);
    }
    if(event.type==="RefinementGovernanceReviewChildLinked"){
      if(reviewRequests.get(payload.reviewId)!==payload.proposalId)missing("frozen-review-input",payload.reviewId);
      if(!sessionIds.has(payload.childSessionId))missing("reviewer-child-session",payload.childSessionId);
      if(!recursiveHandles.has(payload.handleId))missing("reviewer-recursive-handle",payload.handleId);
    }
    if(event.type==="RefinementGovernanceReviewDecided"){
      if(reviewRequests.get(payload.reviewId)!==payload.proposalId)missing("frozen-review-input",payload.reviewId);
      const child=reviewChildren.get(payload.reviewId);
      if(!child)missing("reviewer-child-link",payload.reviewId);
      else if(!modelRequestsBySession.has(child.childSessionId))missing("reviewer-model-dispatch",child.childSessionId);
    }
    if(event.type==="GovernedRefinementApplied"){
      if(decisions.get(payload.decisionId)!==payload.proposalId)missing("governance-decision",payload.decisionId);
      for(const versionId of payload.appliedVersionIds??[])if(!versions.has(versionId))missing("applied-version",versionId);
    }
    if(event.type==="RefinementProposalTerminalNoticeDelivered"){
      if(!proposals.has(payload.proposalId))missing("governed-proposal",payload.proposalId);
      if(payload.result?.reviewDecisionId&&!decisions.has(payload.result.reviewDecisionId))missing("governance-decision",payload.result.reviewDecisionId);
    }
    if(event.type==="RefinementRollbackApplied"){
      for(const versionId of [payload.previousVersionId,payload.restoreSourceVersionId,payload.restorationVersionId])if(!versions.has(versionId))missing("restoration-version",versionId);
      for(const evidenceId of payload.evidenceEventIds??[])if(!eventIds.has(evidenceId))missing("restoration-evidence-event",evidenceId);
    }
    if(event.type==="GovernedRefinementRollbackApplied"){
      if(!proposals.has(payload.proposalId))missing("governed-proposal",payload.proposalId);
      for(const action of payload.actions??[]){
        if(action.operation==="restore"){
          for(const versionId of [action.appliedVersionId,action.restoreSourceVersionId,action.restorationVersionId])if(!versions.has(versionId))missing("governed-rollback-version",versionId);
        }else if(action.operation==="deactivate"){
          if(!versions.has(action.appliedVersionId))missing("governed-rollback-version",action.appliedVersionId);
        }else if(!versions.has(action.reactivatedVersionId))missing("governed-rollback-version",action.reactivatedVersionId);
      }
      for(const evidenceId of payload.evidenceEventIds??[])if(!eventIds.has(evidenceId))missing("governed-rollback-evidence-event",evidenceId);
    }
  }
  for(const artifactId of missingArtifacts)missing("artifact",artifactId);
  return{version:1,complete:issues.size===0,eventCount:events.length,profileVersionCount:profiles.size,governedProposalCount:proposals.size,reviewRequestCount:reviewRequests.size,decisionCount:decisions.size,missing:[...issues].sort()};
}

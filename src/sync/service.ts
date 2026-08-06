import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
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
  type SyncServiceCapabilities, type SyncStatusView, type SyncTransportStats,
  type SyncTransport, type SyncTrigger, type WorkspaceAnnouncement,
} from "./types.ts";

export interface SyncServiceOptions {
  readonly storage: AgentStorage & SyncStorageOperations;
  readonly profile?: ProfileDatabase;
  readonly device: DeviceIdentity;
  readonly workspaceId: string;
  readonly workspaceName?: string;
  readonly databaseUrl: string;
  readonly artifactDirectory?: string;
  readonly syncUrl?: string;
  readonly replicaUrl?: string;
  readonly credentialReference?: string;
  readonly transport?: SyncTransport;
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
  readonly transport:SyncTransport|null;
  readonly intervalMs:number;
  readonly replicaId:string;
  readonly capabilities:SyncServiceCapabilities;
  readonly #now:()=>Date;
  #timer:ReturnType<typeof setInterval>|null=null;
  #active:Promise<SyncCycleResult>|null=null;
  #status:WorkspaceReplicaStatusRecord;

  constructor(options:SyncServiceOptions){
    this.storage=options.storage;this.profile=options.profile;this.device=options.device;
    this.workspaceId=required(options.workspaceId,"workspaceId");this.workspaceName=options.workspaceName??this.workspaceId;
    this.databaseUrl=options.databaseUrl;this.artifactDirectory=options.artifactDirectory;
    this.transport=options.transport??null;this.intervalMs=options.intervalMs??30_000;this.#now=options.now??(()=>new Date());
    if(!Number.isSafeInteger(this.intervalMs)||this.intervalMs<0)throw new ValidationError("Sync interval must be a nonnegative safe integer");
    this.replicaId=this.transport?.id??`local:${this.workspaceId}:${this.device.deviceId}`;
    const directional=this.transport?.capabilities.networkExchange==="directional"&&typeof this.transport.push==="function"&&typeof this.transport.pull==="function";
    this.capabilities={configured:this.transport!==null,localWrites:true,offlineFirst:true,logicalStage:true,logicalIngest:true,networkSync:this.transport!==null,directionalNetworkPush:directional,directionalNetworkPull:directional,networkCheckpoint:directional&&typeof this.transport?.checkpoint==="function",networkStats:directional&&typeof this.transport?.stats==="function",distributedLeases:false,automaticOwnershipFailover:false,conflictPolicy:"surface-and-require-explicit-resolution",transport:this.transport?.capabilities??null};
    const now=this.#iso();
    this.#status={replicaId:this.replicaId,replicaIncarnation:null,workspaceId:this.workspaceId,deviceId:this.device.deviceId,syncUrl:options.syncUrl??null,credentialReference:options.credentialReference??null,lifecycle:this.transport?"offline":"local_only",lastAttemptAt:null,lastSuccessAt:null,lastError:null,lastStats:null,stagedEnvelopes:0,ingestedEnvelopes:0,quarantinedEnvelopes:0,updatedAt:now};
  }

  async start(runStartup=true):Promise<void>{
    const saved=await this.storage.getReplicaStatus(this.replicaId);if(saved)this.#status=saved;
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
  async stop():Promise<void>{if(this.#timer){clearInterval(this.#timer);this.#timer=null;}await this.#active?.catch(()=>{});await this.transport?.close();await this.#save({lifecycle:"closed"});}
  async reconnect():Promise<SyncCycleResult>{if(!this.transport)throw unavailable("reconnect");await this.transport.reconnect?.();return this.sync("reconnect");}
  async sync(trigger:SyncTrigger="manual"):Promise<SyncCycleResult>{if(!this.transport)throw unavailable("sync");if(this.#active)return this.#active.then(result=>({...result,trigger}));this.#active=this.#cycle(trigger).finally(()=>{this.#active=null;});return this.#active;}
  /** Logical local staging; it performs no network call. */
  async stage():Promise<number>{
    if(!this.transport)throw unavailable("stage");
    const watermarks=await this.storage.listSyncOriginWatermarks(this.replicaId);const old=watermarks.find(x=>x.originDeviceId===this.device.deviceId);const after=old?.stagedSequence??0;
    const scanned=await this.storage.listOriginEvents(this.device.deviceId,after);const envelopes:ReplicatedEnvelope[]=[];
    for(const event of scanned){if(event.producer==="sync-derived")continue;const session=await this.storage.getSession?.(event.sessionId);if(session?.workspaceId!==this.workspaceId)continue;envelopes.push(this.#envelope(event));}
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
    const resources={...(manifest.resources as Record<string,JsonValue>),bundlePath:destination,eventCount:events.length,artifactCount,missingArtifacts:missing,replicaEnvelopeCount:replicas.length} as JsonValue;const completed=await this.storage.completeDataManifest(manifest.manifestId,missing.length?"partial":"completed",resources,this.#iso());await Bun.write(join(destination,"manifest.json"),JSON.stringify(completed,null,2)+"\n");return completed;
  }

  async createManifest(operation:"export"|"delete",scopeKind:"workspace"|"session"|"profile",scopeId:string,requestedBy:string):Promise<DataManifestRecord>{
    required(scopeId,"scopeId");required(requestedBy,"requestedBy");let owned=false;
    if(scopeKind==="profile")owned=scopeId===this.device.profileId;
    else if(scopeKind==="workspace")owned=scopeId===this.workspaceId;
    else {const session=await this.storage.getSession?.(scopeId);owned=session?.workspaceId===this.workspaceId;}
    const replicas=[this.#status];const remoteManaged=this.transport!==null;
    const resources:JsonValue={workspaceDatabase:this.databaseUrl,profileDatabase:this.profile?.url??null,artifactDirectory:this.artifactDirectory??null,replicaTransport:this.transport?.id??null,indexes:"rebuildable",scope:{kind:scopeKind,id:scopeId},remoteDeletionSupported:false};
    const status:DataManifestRecord["status"]=!owned?"blocked":operation==="delete"&&remoteManaged?"blocked":"planned";
    const record:DataManifestRecord={manifestId:newId(),operation,scopeKind,scopeId,requestedBy,owned,resources,replicaStatus:replicas as unknown as JsonValue,status,createdAt:this.#iso(),completedAt:null};await this.storage.putDataManifest(record);return record;
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

  #envelope(event:AgentEvent):ReplicatedEnvelope{
    const dependencies=[...new Set([event.streamParentId,event.causationId].filter((x):x is string=>x!==null))].sort();const body={id:event.id,sessionId:event.sessionId,branchId:event.branchId,causationId:event.causationId,correlationId:event.correlationId,type:event.type,schemaVersion:event.schemaVersion,committedAt:event.committedAt,producer:event.producer,idempotencyKey:event.idempotencyKey,payload:event.payload as JsonValue,streamParentId:event.streamParentId};
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
      else {const tip=await this.storage.getDirectBranchTip(body.sessionId,body.branchId);if(!tip)throw new ValidationError("Source branch is unavailable");if(tip.id!==body.streamParentId){const forkCursor=await this.storage.getEventCursor(body.streamParentId);if(!forkCursor)throw new ValidationError("Stream parent is unavailable");const derivedBranchId=deterministicId("sync-branch",envelope.originDeviceId,body.sessionId,body.branchId,body.streamParentId);const mappingId=deterministicId("mapping",envelope.originDeviceId,body.sessionId,body.branchId,body.streamParentId);await this.storage.appendEvents([{id:deterministicId("sync-fork",mappingId),sessionId:body.sessionId,branchId:derivedBranchId,type:"BranchCreated",producer:"sync-derived",idempotencyKey:`sync-fork:${mappingId}`,payload:{branchId:derivedBranchId,parentBranchId:body.branchId,forkCursor,name:`offline ${envelope.originDeviceId.slice(-8)}`}}]);mapping={mappingId,originDeviceId:envelope.originDeviceId,sessionId:body.sessionId,sourceBranchId:body.branchId,forkEventId:body.streamParentId,derivedBranchId,lastSourceEventId:body.streamParentId,createdAt:this.#iso()};await this.storage.putBranchMapping(mapping);branchId=derivedBranchId;const divergentOrigins=[tip.originDeviceId,envelope.originDeviceId].sort();await this.#recordConflict("divergent_session",envelope,[tip.id,body.id],{sourceBranchId:body.branchId,derivedBranchId,forkEventId:body.streamParentId,originDeviceIds:divergentOrigins,policy:"preserve both branches"},"unresolved",null,[this.workspaceId,body.sessionId,body.branchId,body.streamParentId,...divergentOrigins]);conflictCount++;}}
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
  async #catalog():Promise<void>{if(!this.profile)return;const old=await this.profile.getWorkspace(this.workspaceId);const now=this.#iso();await this.profile.putWorkspace({workspaceId:this.workspaceId,name:this.workspaceName,databaseUrl:this.databaseUrl,replicaUrl:this.transport?this.transport.id:null,syncUrl:this.#status.syncUrl,credentialReference:this.#status.credentialReference,ownerProfileId:this.device.profileId,createdAt:old?.createdAt??now,updatedAt:now,deletedAt:old?.deletedAt??null});}
  #iso():string{return this.#now().toISOString();}
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

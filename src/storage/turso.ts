import { createClient, type Client, type Row } from "@libsql/client";
import { connect, type Database as TursoDatabase } from "@tursodatabase/sync";
import { fileURLToPath } from "node:url";
import { ConflictError, ValidationError, newId, type JsonValue } from "../domain/index.ts";
import type { ProfileDatabase } from "../sync/profile.ts";
import {
  envelopeDigest, replicatedEnvelopeId, stableJson,
  type CredentialReference, type DeviceIdentity, type ProfileInstalledSkill, type ProfilePreference,
  type ReplicatedEnvelope, type SyncTransport, type SyncTransportStats,
  type WorkspaceAnnouncement, type WorkspaceCatalogEntry,
} from "../sync/types.ts";

const PROFILE_SCHEMA = `
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS profile_identity(profile_id TEXT PRIMARY KEY,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices(device_id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,display_name TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS credential_references(reference TEXT PRIMARY KEY,provider TEXT NOT NULL,label TEXT NOT NULL,metadata_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profile_skill_versions(version_id TEXT PRIMARY KEY,skill_id TEXT NOT NULL,name TEXT NOT NULL,definition_json TEXT NOT NULL,digest TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profile_skills(skill_id TEXT PRIMARY KEY,current_version_id TEXT NOT NULL,name TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_catalog(workspace_id TEXT PRIMARY KEY,name TEXT NOT NULL,database_url TEXT NOT NULL,replica_url TEXT,sync_url TEXT,credential_reference TEXT,owner_profile_id TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
`;
const TRANSPORT_SCHEMA = `
CREATE TABLE IF NOT EXISTS replicated_envelopes(
 envelope_id TEXT PRIMARY KEY,
 protocol_version INTEGER NOT NULL,
 workspace_id TEXT NOT NULL,
 origin_device_id TEXT NOT NULL,
 origin_sequence INTEGER NOT NULL,
 entity_kind TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 digest TEXT NOT NULL,
 envelope_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS replicated_envelopes_workspace ON replicated_envelopes(workspace_id,origin_device_id,origin_sequence);
CREATE INDEX IF NOT EXISTS replicated_envelopes_entity ON replicated_envelopes(entity_kind,entity_id);
CREATE TRIGGER IF NOT EXISTS replicated_envelopes_no_update BEFORE UPDATE ON replicated_envelopes BEGIN SELECT RAISE(ABORT,'replicated envelopes are append-only'); END;
CREATE TRIGGER IF NOT EXISTS replicated_envelopes_no_delete BEFORE DELETE ON replicated_envelopes BEGIN SELECT RAISE(ABORT,'replicated envelopes are append-only'); END;
CREATE TABLE IF NOT EXISTS workspace_announcements(
 announcement_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 name TEXT NOT NULL,
 owner_profile_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(workspace_id,device_id)
);
CREATE TABLE IF NOT EXISTS replica_incarnations(
 incarnation_id TEXT PRIMARY KEY,
 created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS replica_incarnations_no_update BEFORE UPDATE ON replica_incarnations BEGIN SELECT RAISE(ABORT,'replica incarnations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS replica_incarnations_no_delete BEFORE DELETE ON replica_incarnations BEGIN SELECT RAISE(ABORT,'replica incarnations are append-only'); END;
`;

function parseJson(value: unknown): JsonValue { return JSON.parse(String(value)) as JsonValue; }
function assertSafeRemoteUrl(value:string):void{let url:URL;try{url=new URL(value);}catch{throw new ValidationError("Sync URL is invalid");}for(const key of url.searchParams.keys())if(/token|secret|password|key/i.test(key))throw new ValidationError("Sync URL cannot contain credential query parameters; pass authToken in memory");if(url.username||url.password)throw new ValidationError("Sync URL cannot contain credentials");}
const SENSITIVE_METADATA_KEY = /pass(word)?|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|credential/i;
const OPAQUE_REFERENCE_KEY = /(?:reference|ref|handle|identifier|_id)$/i;
function looksLikeOpaqueReference(value:unknown):boolean{return typeof value==="string"&&value.length>0&&value.length<=512&&!/[\s\0]/.test(value)&&(/^[a-z][a-z0-9+.-]*:[^?#]+$/i.test(value)||/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value));}
function credentialValue(value:string):boolean{
  const text=value.trim();
  if(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)||/^(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+$/i.test(text))return true;
  if(/^(?:sk-(?:live|test|proj)?[-_]?|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|AIza)[A-Za-z0-9_\-]{8,}$/.test(text))return true;
  if(/^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(text))return true;
  try{const url=new URL(text);if(url.username||url.password)return true;for(const key of url.searchParams.keys())if(SENSITIVE_METADATA_KEY.test(key))return true;}catch{}
  return /(?:password|secret|auth[_-]?token|api[_-]?key)\s*[:=]\s*[^\s,;]+/i.test(text);
}
function opaqueReferenceDescriptor(value:unknown):boolean{if(!value||typeof value!=="object"||Array.isArray(value))return false;const entries=Object.entries(value as Record<string,unknown>);if(!entries.length||entries.some(([key,item])=>!/^(?:reference|ref|handle|identifier|id|provider|label)$/i.test(key)||typeof item!=="string"))return false;const handle=entries.find(([key])=>/^(?:reference|ref|handle|identifier|id)$/i.test(key))?.[1];return looksLikeOpaqueReference(handle);}
function credentialMaterial(value: unknown, key = "", sensitiveContainer=false): boolean {
  const sensitiveKey=SENSITIVE_METADATA_KEY.test(key);
  if(sensitiveKey&&(OPAQUE_REFERENCE_KEY.test(key)&&looksLikeOpaqueReference(value)||opaqueReferenceDescriptor(value)))return false;
  if(sensitiveKey)return true;
  if(typeof value==="string")return credentialValue(value)||(sensitiveContainer&&/^(?:value|material|plaintext|contents?)$/i.test(key));
  if(value===null||typeof value==="number"||typeof value==="boolean")return false;
  if(!value||typeof value!=="object")return true;
  if(Array.isArray(value))return value.some((item)=>credentialMaterial(item,"",sensitiveContainer));
  const entries=Object.entries(value as Record<string,unknown>);
  return entries.some(([childKey,child])=>credentialMaterial(child,childKey,sensitiveContainer||SENSITIVE_METADATA_KEY.test(key)));
}
function rowToWorkspace(row: Row): WorkspaceCatalogEntry { return {
  workspaceId:String(row.workspace_id),name:String(row.name),databaseUrl:String(row.database_url),replicaUrl:row.replica_url===null?null:String(row.replica_url),syncUrl:row.sync_url===null?null:String(row.sync_url),credentialReference:row.credential_reference===null?null:String(row.credential_reference),ownerProfileId:String(row.owner_profile_id),createdAt:String(row.created_at),updatedAt:String(row.updated_at),deletedAt:row.deleted_at===null?null:String(row.deleted_at),
}; }

/** LibSQL-backed profile DB. It stores opaque credential references, never credential values. */
export class ProfileStore implements ProfileDatabase {
  readonly #client: Client;
  #closed = false;
  constructor(readonly url: string) { this.#client=createClient({url}); }
  static async open(url: string): Promise<ProfileStore> { const value=new ProfileStore(url);await value.migrate();return value; }
  async migrate():Promise<void>{await this.#client.executeMultiple(PROFILE_SCHEMA);}
  async getOrCreateDeviceIdentity(displayName=`${process.platform}-${process.arch}`):Promise<DeviceIdentity>{
    const now=new Date().toISOString();
    const profileRow=(await this.#client.execute("SELECT * FROM profile_identity ORDER BY created_at LIMIT 1")).rows[0];
    const profileId=profileRow?String(profileRow.profile_id):newId();
    const profileCreatedAt=profileRow?String(profileRow.created_at):now;
    if(!profileRow)await this.#client.execute({sql:"INSERT INTO profile_identity(profile_id,created_at) VALUES(?,?)",args:[profileId,profileCreatedAt]});
    const deviceRow=(await this.#client.execute("SELECT * FROM devices ORDER BY created_at LIMIT 1")).rows[0];
    const deviceId=deviceRow?String(deviceRow.device_id):newId();
    const createdAt=deviceRow?String(deviceRow.created_at):now;
    const name=deviceRow?String(deviceRow.display_name):displayName;
    if(!deviceRow)await this.#client.execute({sql:"INSERT INTO devices(device_id,profile_id,display_name,created_at) VALUES(?,?,?,?)",args:[deviceId,profileId,name,createdAt]});
    return {deviceId,profileId,displayName:name,createdAt};
  }
  async getPreference(key:string):Promise<ProfilePreference|null>{const r=await this.#client.execute({sql:"SELECT * FROM preferences WHERE key=?",args:[key]});const row=r.rows[0];return row?{key:String(row.key),value:parseJson(row.value_json),updatedAt:String(row.updated_at)}:null;}
  async setPreference(key:string,value:JsonValue):Promise<ProfilePreference>{if(!key.trim())throw new ValidationError("Preference key is required");const updatedAt=new Date().toISOString();await this.#client.execute({sql:"INSERT INTO preferences(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",args:[key,JSON.stringify(value),updatedAt]});return{key,value,updatedAt};}
  async listPreferences():Promise<ProfilePreference[]>{const r=await this.#client.execute("SELECT * FROM preferences ORDER BY key");return r.rows.map(row=>({key:String(row.key),value:parseJson(row.value_json),updatedAt:String(row.updated_at)}));}
  async putCredentialReference(input:Omit<CredentialReference,"createdAt"|"updatedAt">):Promise<CredentialReference>{if(!input.reference.trim()||!input.provider.trim()||!input.label.trim())throw new ValidationError("Credential reference fields are required");if(credentialMaterial(input.metadata))throw new ValidationError("Credential metadata may describe a handle but cannot contain credential material");const old=await this.getCredentialReference(input.reference);const now=new Date().toISOString();const result={...input,createdAt:old?.createdAt??now,updatedAt:now};await this.#client.execute({sql:"INSERT INTO credential_references(reference,provider,label,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(reference) DO UPDATE SET provider=excluded.provider,label=excluded.label,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at",args:[result.reference,result.provider,result.label,JSON.stringify(result.metadata),result.createdAt,result.updatedAt]});return result;}
  async getCredentialReference(reference:string):Promise<CredentialReference|null>{const r=await this.#client.execute({sql:"SELECT * FROM credential_references WHERE reference=?",args:[reference]});const row=r.rows[0];return row?{reference:String(row.reference),provider:String(row.provider),label:String(row.label),metadata:parseJson(row.metadata_json),createdAt:String(row.created_at),updatedAt:String(row.updated_at)}:null;}
  async listCredentialReferences():Promise<CredentialReference[]>{const r=await this.#client.execute("SELECT * FROM credential_references ORDER BY reference");return r.rows.map(row=>({reference:String(row.reference),provider:String(row.provider),label:String(row.label),metadata:parseJson(row.metadata_json),createdAt:String(row.created_at),updatedAt:String(row.updated_at)}));}
  async installGlobalSkill(input:Omit<ProfileInstalledSkill,"versionId"|"digest"|"createdAt">&{readonly versionId?:string}):Promise<ProfileInstalledSkill>{if(!input.skillId.trim()||!input.name.trim())throw new ValidationError("Global skill identity and name are required");if(credentialMaterial(input.definition))throw new ValidationError("Global skill definitions cannot contain credential material");const versionId=input.versionId??newId();const definitionJson=stableJson(input.definition);const hash=new Bun.CryptoHasher("sha256");hash.update(definitionJson);const digest=hash.digest("hex");const createdAt=new Date().toISOString();const existing=await this.#client.execute({sql:"SELECT digest FROM profile_skill_versions WHERE version_id=?",args:[versionId]});if(existing.rows[0]&&String(existing.rows[0].digest)!==digest)throw new ConflictError("Global skill version ID collision",{versionId});if(!existing.rows[0])await this.#client.execute({sql:"INSERT INTO profile_skill_versions(version_id,skill_id,name,definition_json,digest,created_at) VALUES(?,?,?,?,?,?)",args:[versionId,input.skillId,input.name,definitionJson,digest,createdAt]});await this.#client.execute({sql:"INSERT INTO profile_skills(skill_id,current_version_id,name,updated_at) VALUES(?,?,?,?) ON CONFLICT(skill_id) DO UPDATE SET current_version_id=excluded.current_version_id,name=excluded.name,updated_at=excluded.updated_at",args:[input.skillId,versionId,input.name,createdAt]});return{skillId:input.skillId,versionId,name:input.name,definition:input.definition,digest,createdAt};}
  async listGlobalSkills():Promise<ProfileInstalledSkill[]>{const r=await this.#client.execute("SELECT v.* FROM profile_skills s JOIN profile_skill_versions v ON v.version_id=s.current_version_id ORDER BY s.name,s.skill_id");return r.rows.map(row=>({skillId:String(row.skill_id),versionId:String(row.version_id),name:String(row.name),definition:parseJson(row.definition_json),digest:String(row.digest),createdAt:String(row.created_at)}));}
  async putWorkspace(x:WorkspaceCatalogEntry):Promise<void>{if(x.syncUrl)assertSafeRemoteUrl(x.syncUrl);await this.#client.execute({sql:"INSERT INTO workspace_catalog(workspace_id,name,database_url,replica_url,sync_url,credential_reference,owner_profile_id,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET name=excluded.name,database_url=excluded.database_url,replica_url=excluded.replica_url,sync_url=excluded.sync_url,credential_reference=excluded.credential_reference,owner_profile_id=excluded.owner_profile_id,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at",args:[x.workspaceId,x.name,x.databaseUrl,x.replicaUrl,x.syncUrl,x.credentialReference,x.ownerProfileId,x.createdAt,x.updatedAt,x.deletedAt]});}
  async getWorkspace(workspaceId:string):Promise<WorkspaceCatalogEntry|null>{const r=await this.#client.execute({sql:"SELECT * FROM workspace_catalog WHERE workspace_id=?",args:[workspaceId]});return r.rows[0]?rowToWorkspace(r.rows[0]):null;}
  async listWorkspaces(includeDeleted=false):Promise<WorkspaceCatalogEntry[]>{const r=await this.#client.execute(`SELECT * FROM workspace_catalog${includeDeleted?"":" WHERE deleted_at IS NULL"} ORDER BY workspace_id`);return r.rows.map(rowToWorkspace);}
  async markWorkspaceDeleted(workspaceId:string,deletedAt:string):Promise<void>{const r=await this.#client.execute({sql:"UPDATE workspace_catalog SET name='',database_url='',replica_url=NULL,sync_url=NULL,credential_reference=NULL,deleted_at=?,updated_at=? WHERE workspace_id=? AND deleted_at IS NULL",args:[deletedAt,deletedAt,workspaceId]});if(r.rowsAffected!==1)throw new ConflictError("Workspace is missing or already deleted",{workspaceId});}
  close():void{if(this.#closed)return;this.#closed=true;this.#client.close();}
}

export interface TursoSyncTransportOptions {
  /** Local database path, or the legacy CLI's local file: URL spelling. */
  readonly path?: string;
  readonly replicaUrl?: string;
  readonly syncUrl: string;
  readonly authToken?: string | (() => Promise<string>);
  readonly clientName?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly id?: string;
}

/**
 * Official @tursodatabase/sync adapter. connect() receives a deferred URL
 * callback that returns null until an explicit network primitive is running,
 * so initialize(), schema creation, local staging, reads, and stats never
 * bootstrap from or contact Cloud. A rejected push/pull leaves the same local
 * database handle and its unsent CDC operations usable.
 */
export class TursoSyncTransport implements SyncTransport {
  readonly id:string;
  readonly capabilities={
    adapter:"turso-sync",nativeMethod:"push-pull-checkpoint-stats",networkExchange:"directional",
    offlineEnvelopeWrites:true,directionalPush:true,directionalPull:true,checkpoint:true,statistics:true,
    distributedCoordination:false,
  } as const;
  readonly #path:string;
  #database:TursoDatabase|null=null;
  #networkEnabled=false;
  #networkTail:Promise<void>=Promise.resolve();
  #initialized=false;
  #closed=false;

  constructor(readonly options:TursoSyncTransportOptions){
    const local=options.path??options.replicaUrl;
    if(!local?.trim())throw new ValidationError("Turso Sync local replica path is required");
    if(options.path===undefined&&!local.startsWith("file:"))throw new ValidationError("Turso Sync replica URL must be a local file: URL");
    this.#path=local.startsWith("file:")?localPath(local):local;
    assertSafeRemoteUrl(options.syncUrl);
    this.id=options.id??`turso:${options.syncUrl}`;
  }

  async initialize():Promise<void>{
    if(this.#closed)throw new Error("Transport is closed");
    if(this.#initialized&&this.#database)return;
    const database=await connect({
      path:this.#path,
      // @tursodatabase/sync@0.7.2's deferred URL is the installed equivalent
      // of bootstrapIfEmpty:false: connect sees null, explicit network calls
      // temporarily arm the callback with the configured URL.
      url:()=>this.#networkEnabled?this.options.syncUrl:null,
      ...(this.options.authToken===undefined?{}:{authToken:this.options.authToken}),
      ...(this.options.clientName===undefined?{}:{clientName:this.options.clientName}),
      ...(this.options.fetch===undefined?{}:{fetch:this.options.fetch}),
    });
    try{
      await database.exec(TRANSPORT_SCHEMA);
      this.#database=database;
      this.#initialized=true;
    }catch(error){await database.close().catch(()=>{});throw error;}
  }

  async replicaIncarnation(previous?:string):Promise<string>{
    await this.initialize();
    if(previous){const retained=await this.#get("SELECT incarnation_id FROM replica_incarnations WHERE incarnation_id=?",previous);if(retained)return previous;}
    if(!previous){const retained=await this.#get("SELECT incarnation_id FROM replica_incarnations ORDER BY created_at,incarnation_id LIMIT 1");if(retained)return String(retained.incarnation_id);}
    const incarnation=newId();
    await this.#run("INSERT INTO replica_incarnations(incarnation_id,created_at) VALUES(?,?)",incarnation,new Date().toISOString());
    return incarnation;
  }

  async putEnvelopes(envelopes:readonly ReplicatedEnvelope[]):Promise<number>{
    await this.initialize();let inserted=0;
    for(const envelope of envelopes){
      const expected=envelopeDigest(stripDigest(envelope));
      if(expected!==envelope.digest)throw new ValidationError("Cannot stage an envelope with an invalid digest");
      if(replicatedEnvelopeId(envelope)!==envelope.envelopeId)throw new ValidationError("Cannot stage an envelope without a content-and-origin physical identity");
      const result=await this.#run("INSERT INTO replicated_envelopes(envelope_id,protocol_version,workspace_id,origin_device_id,origin_sequence,entity_kind,entity_id,digest,envelope_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(envelope_id) DO NOTHING",envelope.envelopeId,envelope.protocolVersion,envelope.workspaceId,envelope.originDeviceId,envelope.originSequence,envelope.entityKind,envelope.entityId,envelope.digest,stableJson(envelope),envelope.createdAt);
      inserted+=result.changes;
      const existing=await this.#get("SELECT digest FROM replicated_envelopes WHERE envelope_id=?",envelope.envelopeId);
      if(String(existing?.digest)!==envelope.digest)throw new ConflictError("Physical envelope identity collision",{envelopeId:envelope.envelopeId});
    }
    return inserted;
  }

  async listEnvelopes(workspaceId?:string,afterByOrigin?:Readonly<Record<string,number>>):Promise<ReplicatedEnvelope[]>{
    await this.initialize();const predicates:string[]=[];const args:Array<string|number>=[];
    if(workspaceId!==undefined){predicates.push("workspace_id=?");args.push(workspaceId);}
    const origins=Object.entries(afterByOrigin??{}).filter((entry)=>Number.isSafeInteger(entry[1])&&entry[1]>=0).sort(([a],[b])=>a.localeCompare(b));
    if(origins.length){const placeholders=origins.map(()=>"?").join(",");const newer=origins.map(()=>"(origin_device_id=? AND origin_sequence>=CASE WHEN ?>0 THEN ? ELSE 1 END)").join(" OR ");predicates.push(`(origin_device_id NOT IN (${placeholders}) OR ${newer})`);for(const [origin] of origins)args.push(origin);for(const [origin,sequence] of origins)args.push(origin,sequence,sequence);}
    const where=predicates.length?` WHERE ${predicates.join(" AND ")}`:"";
    const rows=await this.#all(`SELECT envelope_json FROM replicated_envelopes${where} ORDER BY created_at,origin_sequence,origin_device_id,envelope_id`,...args);
    return rows.map(row=>JSON.parse(String(row.envelope_json)) as ReplicatedEnvelope);
  }

  async putWorkspaceAnnouncement(x:WorkspaceAnnouncement):Promise<void>{
    await this.initialize();
    await this.#run("INSERT INTO workspace_announcements(announcement_id,workspace_id,name,owner_profile_id,device_id,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,device_id) DO UPDATE SET name=excluded.name,owner_profile_id=excluded.owner_profile_id,updated_at=excluded.updated_at",x.announcementId,x.workspaceId,x.name,x.ownerProfileId,x.deviceId,x.updatedAt);
  }
  async discoverWorkspaces():Promise<WorkspaceAnnouncement[]>{
    await this.initialize();const rows=await this.#all("SELECT * FROM workspace_announcements ORDER BY workspace_id,updated_at DESC,device_id");
    return rows.map(row=>({announcementId:String(row.announcement_id),workspaceId:String(row.workspace_id),name:String(row.name),ownerProfileId:String(row.owner_profile_id),deviceId:String(row.device_id),updatedAt:String(row.updated_at)}));
  }

  async push():Promise<void>{await this.#withNetwork(async database=>{await database.push();});}
  async pull():Promise<boolean>{return this.#withNetwork(database=>database.pull());}
  async checkpoint():Promise<void>{await this.initialize();await this.#database!.checkpoint();}
  async stats():Promise<SyncTransportStats>{await this.initialize();return normalizeStats(await this.#database!.stats());}
  async reconnect():Promise<void>{await this.initialize();}
  async close():Promise<void>{
    if(this.#closed)return;this.#closed=true;
    await this.#networkTail.catch(()=>{});
    const database=this.#database;this.#database=null;this.#initialized=false;
    if(database)await database.close();
  }

  async #withNetwork<T>(operation:(database:TursoDatabase)=>Promise<T>):Promise<T>{
    if(this.#closed)throw new Error("Transport is closed");
    const previous=this.#networkTail;let release!:()=>void;
    this.#networkTail=new Promise<void>(resolve=>{release=resolve;});
    await previous.catch(()=>{});
    try{await this.initialize();this.#networkEnabled=true;return await operation(this.#database!);}
    finally{this.#networkEnabled=false;release();}
  }
  async #run(sql:string,...args:unknown[]):Promise<{changes:number}>{await this.initialize();const statement=await this.#database!.prepare(sql);try{return await statement.run(...args);}finally{statement.close();}}
  async #get(sql:string,...args:unknown[]):Promise<Record<string,unknown>|undefined>{await this.initialize();const statement=await this.#database!.prepare(sql);try{return await statement.get(...args) as Record<string,unknown>|undefined;}finally{statement.close();}}
  async #all(sql:string,...args:unknown[]):Promise<Array<Record<string,unknown>>>{await this.initialize();const statement=await this.#database!.prepare(sql);try{return await statement.all(...args) as Array<Record<string,unknown>>;}finally{statement.close();}}
}

function stripDigest(envelope:ReplicatedEnvelope):Omit<ReplicatedEnvelope,"digest">{const{digest:_,...rest}=envelope;return rest;}
function localPath(value:string):string{try{return fileURLToPath(value);}catch{throw new ValidationError("Turso Sync replica URL must be a valid local file: URL");}}
function normalizeStats(value:Awaited<ReturnType<TursoDatabase["stats"]>>):SyncTransportStats{
  const raw=value as typeof value&Partial<Record<"lastPullUnixTime"|"lastPushUnixTime"|"revision",unknown>>;
  const finite=(item:unknown):number|null=>typeof item==="number"&&Number.isFinite(item)?item:null;
  return{cdcOperations:Number(value.cdcOperations??0),mainWalSize:Number(value.mainWalSize??0),revertWalSize:Number(value.revertWalSize??0),lastPullUnixTime:finite(raw.lastPullUnixTime),lastPushUnixTime:finite(raw.lastPushUnixTime),revision:typeof raw.revision==="string"?raw.revision:null,networkSentBytes:Number(value.networkSentBytes??0),networkReceivedBytes:Number(value.networkReceivedBytes??0)};
}

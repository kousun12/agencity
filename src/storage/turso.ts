import { createClient, type Client, type Row } from "@libsql/client";
import { connect, type Database as TursoDatabase } from "@tursodatabase/sync";
import { fileURLToPath } from "node:url";
import { ConflictError, ValidationError, newId, type JsonValue } from "../domain/index.ts";
import { containsCredentialMaterial } from "../security/index.ts";
import type {
  ProfileDatabase, ProfileGlobalSkillAction, ProfileGlobalSkillAvailability, ProfileGlobalSkillHistory,
  ProfileGlobalSkillProvenance, ProfileGlobalSkillReadOptions, ProfileGlobalSkillRecord,
  ProfileGlobalSkillTestReport, ProfileGlobalSkillVersion, SetGlobalSkillAvailabilityInput,
  SetGlobalSkillStatusInput, StageGlobalSkillInput,
} from "../sync/profile.ts";
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
CREATE TABLE IF NOT EXISTS profile_skill_versions(
 version_id TEXT PRIMARY KEY,
 skill_id TEXT NOT NULL,
 name TEXT NOT NULL,
 definition_json TEXT NOT NULL,
 digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 definition_format TEXT NOT NULL DEFAULT 'legacy' CHECK(definition_format IN ('legacy','typescript-v1')),
 provenance_json TEXT,
 test_report_json TEXT,
 effect_ref TEXT
);
CREATE INDEX IF NOT EXISTS profile_skill_versions_skill ON profile_skill_versions(skill_id,created_at,version_id);
CREATE TABLE IF NOT EXISTS profile_skills(
 skill_id TEXT PRIMARY KEY,
 current_version_id TEXT NOT NULL,
 name TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 availability TEXT NOT NULL DEFAULT 'enabled' CHECK(availability IN ('enabled','disabled','removed')),
 FOREIGN KEY(current_version_id) REFERENCES profile_skill_versions(version_id)
);
CREATE TABLE IF NOT EXISTS profile_skill_actions(
 action_id TEXT PRIMARY KEY,
 skill_id TEXT NOT NULL,
 version_id TEXT NOT NULL,
 digest TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('legacy-installed','staged','status-changed')),
 previous_availability TEXT CHECK(previous_availability IS NULL OR previous_availability IN ('enabled','disabled','removed')),
 availability TEXT NOT NULL CHECK(availability IN ('enabled','disabled','removed')),
 effect_ref TEXT,
 idempotency_key TEXT NOT NULL UNIQUE,
 request_digest TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS profile_skill_actions_history ON profile_skill_actions(skill_id,created_at,action_id);
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
function credentialValue(value:string):boolean{return containsCredentialMaterial(value);}
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
const PROFILE_SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROFILE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROFILE_SKILL_DIGEST = /^[a-f0-9]{64}$/;
const PROFILE_SKILL_PERMISSION = /^[a-z][a-z0-9]*(?:[.:-][a-z0-9]+)*$/;
const PROFILE_SKILL_AVAILABILITIES = new Set<ProfileGlobalSkillAvailability>(["enabled","disabled","removed"]);
const PROFILE_SKILL_DEFINITION_FIELDS = new Set(["description","source","inputSchema","permissions","tests","runtime","compatibility"]);
const PROFILE_SKILL_TEST_FIELDS = new Set(["name","input","expected","expectedError"]);
const PROFILE_SKILL_REPORT_FIELDS = new Set(["testId","versionId","digest","testedAt","compiled","passed","failed","outcome"]);

function profileSkillDigest(value:JsonValue):string{const hash=new Bun.CryptoHasher("sha256");hash.update(stableJson(value));return hash.digest("hex");}
function assertProfileSkillId(value:unknown,label:string):asserts value is string{if(typeof value!=="string"||!PROFILE_SKILL_ID.test(value))throw new ValidationError(`${label} is invalid`);}
function assertProfileSkillName(value:unknown):asserts value is string{if(typeof value!=="string"||value.length>64||!PROFILE_SKILL_NAME.test(value))throw new ValidationError("Global skill name must use bounded lower-kebab-case");}
function assertProfileSkillDigest(value:unknown,label="Global skill digest"):asserts value is string{if(typeof value!=="string"||!PROFILE_SKILL_DIGEST.test(value))throw new ValidationError(`${label} is invalid`);}
function assertProfileSkillTimestamp(value:unknown,label:string):asserts value is string{if(typeof value!=="string"||value.length!==24||!Number.isFinite(Date.parse(value))||new Date(Date.parse(value)).toISOString()!==value)throw new ValidationError(`${label} must be a canonical timestamp`);}
function assertProfileSkillAvailability(value:unknown):asserts value is ProfileGlobalSkillAvailability{if(typeof value!=="string"||!PROFILE_SKILL_AVAILABILITIES.has(value as ProfileGlobalSkillAvailability))throw new ValidationError("Global skill availability is invalid");}
function assertProfileSkillEffectRef(value:unknown):asserts value is string|null{if(value===null)return;if(typeof value!=="string"||value!==value.trim()||!value||value.length>512||value.includes("\0")||credentialMaterial(value,"effectRef"))throw new ValidationError("Global skill effect reference must be a non-secret opaque reference");}
function profileSkillObject(value:unknown,label:string,allowed:ReadonlySet<string>,required:readonly string[]):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))throw new ValidationError(`${label} must be an object`);const result=value as Record<string,unknown>;if(Object.keys(result).some(key=>!allowed.has(key))||required.some(key=>!Object.prototype.hasOwnProperty.call(result,key)))throw new ValidationError(`${label} fields do not match the strict schema`);return result;}
function assertProfileJson(value:unknown,label:string,depth=0,state={nodes:0}):asserts value is JsonValue{state.nodes++;if(depth>24||state.nodes>32768)throw new ValidationError(`${label} is too deep or complex`);if(value===null||typeof value==="string"||typeof value==="boolean")return;if(typeof value==="number"){if(!Number.isFinite(value))throw new ValidationError(`${label} contains a non-finite number`);return;}if(Array.isArray(value)){for(const item of value)assertProfileJson(item,label,depth+1,state);return;}if(!value||typeof value!=="object"||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))throw new ValidationError(`${label} must contain JSON values only`);for(const [key,item]of Object.entries(value)){if(!key||key.length>4096)throw new ValidationError(`${label} contains an invalid key`);assertProfileJson(item,label,depth+1,state);}}
function validateProfileSkillDefinition(value:unknown):JsonValue{
  if(credentialMaterial(value))throw new ValidationError("Global skill definitions cannot contain credential material");
  const input=profileSkillObject(value,"Global skill definition",PROFILE_SKILL_DEFINITION_FIELDS,["description","source","permissions","tests","runtime"]);
  if(typeof input.description!=="string"||!input.description.trim()||input.description.length>16384)throw new ValidationError("Global skill description is invalid");
  if(typeof input.source!=="string"||!input.source.trim()||new TextEncoder().encode(input.source).byteLength>512*1024)throw new ValidationError("Global skill TypeScript source is invalid");
  if(input.runtime!=="bun")throw new ValidationError("Global skills require Bun runtime compatibility");
  if(input.compatibility!==undefined&&(typeof input.compatibility!=="string"||!input.compatibility.trim()||input.compatibility.length>512))throw new ValidationError("Global skill compatibility is invalid");
  if(!Array.isArray(input.permissions)||input.permissions.length>32)throw new ValidationError("Global skill permissions are invalid");
  const permissions=input.permissions.map((permission,index)=>{if(typeof permission!=="string"||permission.length>128||!PROFILE_SKILL_PERMISSION.test(permission)||/^(?:admin|root|policy|permission|\*)$/i.test(permission))throw new ValidationError(`Global skill permission at index ${index} is invalid`);return permission;});
  if(new Set(permissions).size!==permissions.length)throw new ValidationError("Global skill permissions must be unique");
  if(!Array.isArray(input.tests)||input.tests.length<1||input.tests.length>64)throw new ValidationError("Global skills require 1-64 tests");
  const names=new Set<string>();
  for(const [index,value]of input.tests.entries()){
    const test=profileSkillObject(value,`Global skill test ${index}`,PROFILE_SKILL_TEST_FIELDS,["name","input"]);
    if(typeof test.name!=="string"||!test.name.trim()||test.name.length>128||names.has(test.name))throw new ValidationError("Global skill test names must be non-empty and unique");names.add(test.name);
    const hasExpected=Object.prototype.hasOwnProperty.call(test,"expected");const hasError=Object.prototype.hasOwnProperty.call(test,"expectedError");
    if(hasExpected===hasError)throw new ValidationError("Each global skill test requires exactly one expected value or error");
    assertProfileJson(test.input,"Global skill test input");
    if(hasExpected)assertProfileJson(test.expected,"Global skill test expected value");
    if(hasError&&(typeof test.expectedError!=="string"||!test.expectedError.trim()||test.expectedError.length>4096))throw new ValidationError("Global skill expected error is invalid");
  }
  if(input.inputSchema!==undefined){assertProfileJson(input.inputSchema,"Global skill input schema");if(!input.inputSchema||typeof input.inputSchema!=="object"||Array.isArray(input.inputSchema))throw new ValidationError("Global skill input schema must be an object");}
  assertProfileJson(value,"Global skill definition");
  const definition=value as JsonValue;if(new TextEncoder().encode(stableJson(definition)).byteLength>768*1024)throw new ValidationError("Global skill definition exceeds the byte bound");
  return definition;
}
function validateProfileSkillProvenance(value:unknown,allowLegacy=false):ProfileGlobalSkillProvenance{
  if(credentialMaterial(value))throw new ValidationError("Global skill provenance cannot contain credential material");
  if(!value||typeof value!=="object"||Array.isArray(value))throw new ValidationError("Global skill provenance must be an object");
  const source=(value as Record<string,unknown>).source;
  const reference=(item:unknown,label:string)=>{if(typeof item!=="string"||item!==item.trim()||!item||item.length>4096||item.includes("\0"))throw new ValidationError(`${label} is invalid`);return item;};
  if(source==="legacy"){
    const input=profileSkillObject(value,"Legacy global skill provenance",new Set(["source"]),["source"]);if(!allowLegacy||input.source!=="legacy")throw new ValidationError("Legacy provenance is reserved for compatibility rows");return{source:"legacy"};
  }
  if(source==="profile-api"){
    const input=profileSkillObject(value,"Profile API skill provenance",new Set(["source","reference","installedBy"]),["source","reference","installedBy"]);return{source:"profile-api",reference:reference(input.reference,"Profile API provenance reference"),installedBy:reference(input.installedBy,"Profile API installer")};
  }
  if(source==="local-directory"){
    const input=profileSkillObject(value,"Local directory skill provenance",new Set(["source","reference","manifestDigest","sourceDigest","installedBy"]),["source","reference","manifestDigest","sourceDigest","installedBy"]);assertProfileSkillDigest(input.manifestDigest,"Manifest digest");assertProfileSkillDigest(input.sourceDigest,"Source digest");return{source:"local-directory",reference:reference(input.reference,"Local directory reference"),manifestDigest:input.manifestDigest,sourceDigest:input.sourceDigest,installedBy:reference(input.installedBy,"Local directory installer")};
  }
  if(source==="harness-version"){
    const input=profileSkillObject(value,"Harness version skill provenance",new Set(["source","entryId","versionId","digest","installedBy"]),["source","entryId","versionId","digest","installedBy"]);assertProfileSkillId(input.entryId,"Harness entry ID");assertProfileSkillId(input.versionId,"Harness version ID");assertProfileSkillDigest(input.digest,"Harness digest");return{source:"harness-version",entryId:input.entryId,versionId:input.versionId,digest:input.digest,installedBy:reference(input.installedBy,"Harness installer")};
  }
  throw new ValidationError("Global skill provenance source is invalid");
}
function validateProfileSkillTestReport(value:unknown,versionId:string,digest:string):ProfileGlobalSkillTestReport{
  const input=profileSkillObject(value,"Global skill test report",PROFILE_SKILL_REPORT_FIELDS,[...PROFILE_SKILL_REPORT_FIELDS]);
  assertProfileSkillId(input.testId,"Global skill test ID");assertProfileSkillId(input.versionId,"Global skill test version ID");assertProfileSkillDigest(input.digest,"Global skill test digest");assertProfileSkillTimestamp(input.testedAt,"Global skill testedAt");
  if(input.versionId!==versionId||input.digest!==digest)throw new ValidationError("Global skill test report does not match the immutable version");
  if(typeof input.compiled!=="boolean"||typeof input.passed!=="number"||!Number.isSafeInteger(input.passed)||input.passed<0||typeof input.failed!=="number"||!Number.isSafeInteger(input.failed)||input.failed<0||input.passed+input.failed<1||input.passed+input.failed>64)throw new ValidationError("Global skill test report counts are invalid");
  if(input.outcome!=="passed"&&input.outcome!=="failed")throw new ValidationError("Global skill test outcome is invalid");const passed=input.compiled&&input.failed===0&&input.passed>0;if((input.outcome==="passed")!==passed)throw new ValidationError("Global skill test outcome contradicts its counts");
  return{testId:input.testId,versionId:input.versionId,digest:input.digest,testedAt:input.testedAt,compiled:input.compiled,passed:input.passed,failed:input.failed,outcome:input.outcome};
}
function parseProfileSkillJson(value:unknown,label:string):unknown{try{return JSON.parse(String(value));}catch{throw new ValidationError(`${label} is corrupt`);}}
function rowToProfileGlobalSkillVersion(row:Row):ProfileGlobalSkillVersion{
  const skillId=String(row.skill_id),versionId=String(row.version_id),name=String(row.name),digest=String(row.digest),createdAt=String(row.created_at);assertProfileSkillId(skillId,"Global skill ID");assertProfileSkillId(versionId,"Global skill version ID");assertProfileSkillName(name);assertProfileSkillDigest(digest);assertProfileSkillTimestamp(createdAt,"Global skill createdAt");
  const definition=parseProfileSkillJson(row.definition_json,"Global skill definition") as JsonValue;assertProfileJson(definition,"Global skill definition");if(profileSkillDigest(definition)!==digest)throw new ValidationError("Global skill definition digest is corrupt");
  const definitionFormat=String(row.definition_format??"legacy");if(definitionFormat!=="legacy"&&definitionFormat!=="typescript-v1")throw new ValidationError("Global skill definition format is invalid");
  const provenance=validateProfileSkillProvenance(row.provenance_json===null||row.provenance_json===undefined?{source:"legacy"}:parseProfileSkillJson(row.provenance_json,"Global skill provenance"),definitionFormat==="legacy");
  const effectRef=row.effect_ref===null||row.effect_ref===undefined?null:String(row.effect_ref);assertProfileSkillEffectRef(effectRef);
  if(definitionFormat==="legacy")return{skillId,versionId,name,definition,definitionFormat,digest,provenance,testReport:null,effectRef,createdAt};
  validateProfileSkillDefinition(definition);const rawReport=row.test_report_json===null||row.test_report_json===undefined?null:parseProfileSkillJson(row.test_report_json,"Global skill test report");if(rawReport===null)throw new ValidationError("Strict global skill version lacks a test report");const testReport=validateProfileSkillTestReport(rawReport,versionId,digest);
  return{skillId,versionId,name,definition,definitionFormat,digest,provenance,testReport,effectRef,createdAt};
}
function rowToProfileGlobalSkillRecord(row:Row):ProfileGlobalSkillRecord{const version=rowToProfileGlobalSkillVersion(row);const availability=String(row.availability);assertProfileSkillAvailability(availability);const updatedAt=String(row.skill_updated_at??row.updated_at);assertProfileSkillTimestamp(updatedAt,"Global skill updatedAt");return{...version,availability,status:availability,updatedAt};}
function rowToProfileGlobalSkillAction(row:Row):ProfileGlobalSkillAction{const availability=String(row.availability);assertProfileSkillAvailability(availability);const previous=row.previous_availability===null?null:String(row.previous_availability);if(previous!==null)assertProfileSkillAvailability(previous);const action=String(row.action);if(action!=="legacy-installed"&&action!=="staged"&&action!=="status-changed")throw new ValidationError("Global skill action is invalid");const effectRef=row.effect_ref===null?null:String(row.effect_ref);assertProfileSkillEffectRef(effectRef);const result:ProfileGlobalSkillAction={actionId:String(row.action_id),skillId:String(row.skill_id),versionId:String(row.version_id),digest:String(row.digest),action,previousAvailability:previous,availability,effectRef,idempotencyKey:String(row.idempotency_key),requestDigest:String(row.request_digest),createdAt:String(row.created_at)};assertProfileSkillId(result.actionId,"Global skill action ID");assertProfileSkillId(result.skillId,"Global skill ID");assertProfileSkillId(result.versionId,"Global skill version ID");assertProfileSkillDigest(result.digest);assertProfileSkillId(result.idempotencyKey,"Global skill idempotency key");assertProfileSkillDigest(result.requestDigest,"Global skill request digest");assertProfileSkillTimestamp(result.createdAt,"Global skill action createdAt");return result;}
function profileSkillRequestDigest(value:JsonValue):string{return profileSkillDigest(value);}
function assertProfileSkillTransition(previous:ProfileGlobalSkillAvailability,next:ProfileGlobalSkillAvailability,version:ProfileGlobalSkillVersion):void{if(previous==="removed"&&next!=="removed")throw new ConflictError("Removed global skills cannot be restored",{skillId:version.skillId});if(previous==="enabled"&&next!=="enabled"&&next!=="disabled"&&next!=="removed")throw new ValidationError("Global skill availability transition is invalid");if(previous==="disabled"&&next!=="disabled"&&next!=="enabled"&&next!=="removed")throw new ValidationError("Global skill availability transition is invalid");if(next==="enabled"&&version.definitionFormat==="typescript-v1"&&version.testReport?.outcome!=="passed")throw new ValidationError("A passing same-digest test report is required before enabling a global skill");}

function rowToWorkspace(row: Row): WorkspaceCatalogEntry { return {
  workspaceId:String(row.workspace_id),name:String(row.name),databaseUrl:String(row.database_url),replicaUrl:row.replica_url===null?null:String(row.replica_url),syncUrl:row.sync_url===null?null:String(row.sync_url),credentialReference:row.credential_reference===null?null:String(row.credential_reference),ownerProfileId:String(row.owner_profile_id),createdAt:String(row.created_at),updatedAt:String(row.updated_at),deletedAt:row.deleted_at===null?null:String(row.deleted_at),
}; }

/** LibSQL-backed profile DB. It stores opaque credential references, never credential values. */
export class ProfileStore implements ProfileDatabase {
  readonly #client: Client;
  #closed = false;
  constructor(readonly url: string) { this.#client=createClient({url}); }
  static async open(url: string): Promise<ProfileStore> { const value=new ProfileStore(url);await value.migrate();return value; }
  async migrate():Promise<void>{
    await this.#client.executeMultiple(PROFILE_SCHEMA);
    const versionColumns=new Set((await this.#client.execute("PRAGMA table_info(profile_skill_versions)")).rows.map(row=>String(row.name)));
    if(!versionColumns.has("definition_format"))await this.#client.execute("ALTER TABLE profile_skill_versions ADD COLUMN definition_format TEXT NOT NULL DEFAULT 'legacy'");
    if(!versionColumns.has("provenance_json"))await this.#client.execute("ALTER TABLE profile_skill_versions ADD COLUMN provenance_json TEXT");
    if(!versionColumns.has("test_report_json"))await this.#client.execute("ALTER TABLE profile_skill_versions ADD COLUMN test_report_json TEXT");
    if(!versionColumns.has("effect_ref"))await this.#client.execute("ALTER TABLE profile_skill_versions ADD COLUMN effect_ref TEXT");
    const skillColumns=new Set((await this.#client.execute("PRAGMA table_info(profile_skills)")).rows.map(row=>String(row.name)));
    if(!skillColumns.has("availability"))await this.#client.execute("ALTER TABLE profile_skills ADD COLUMN availability TEXT NOT NULL DEFAULT 'enabled'");
    await this.#client.execute({sql:"UPDATE profile_skill_versions SET definition_format='legacy',provenance_json=? WHERE provenance_json IS NULL",args:[stableJson({source:"legacy"})]});
    await this.#client.execute("UPDATE profile_skills SET availability='enabled' WHERE availability IS NULL");
    const legacy=(await this.#client.execute("SELECT s.skill_id,s.current_version_id,s.availability,s.updated_at,v.digest FROM profile_skills s JOIN profile_skill_versions v ON v.version_id=s.current_version_id WHERE NOT EXISTS (SELECT 1 FROM profile_skill_actions a WHERE a.skill_id=s.skill_id)")).rows;
    for(const row of legacy){
      const idempotencyKey=`legacy-migration:${String(row.skill_id)}:${String(row.current_version_id)}`;
      const requestDigest=profileSkillRequestDigest({action:"legacy-installed",skillId:String(row.skill_id),versionId:String(row.current_version_id),digest:String(row.digest),availability:String(row.availability)});
      await this.#client.execute({sql:"INSERT OR IGNORE INTO profile_skill_actions(action_id,skill_id,version_id,digest,action,previous_availability,availability,effect_ref,idempotency_key,request_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",args:[newId(),String(row.skill_id),String(row.current_version_id),String(row.digest),"legacy-installed",null,String(row.availability),null,idempotencyKey,requestDigest,String(row.updated_at)]});
    }
    await this.#client.executeMultiple(`
CREATE TRIGGER IF NOT EXISTS profile_skill_versions_no_update BEFORE UPDATE ON profile_skill_versions BEGIN SELECT RAISE(ABORT,'profile skill versions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS profile_skill_versions_no_delete BEFORE DELETE ON profile_skill_versions BEGIN SELECT RAISE(ABORT,'profile skill versions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS profile_skill_actions_no_update BEFORE UPDATE ON profile_skill_actions BEGIN SELECT RAISE(ABORT,'profile skill actions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS profile_skill_actions_no_delete BEFORE DELETE ON profile_skill_actions BEGIN SELECT RAISE(ABORT,'profile skill actions are append-only'); END;
`);
  }
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
  async putCredentialReference(input:Omit<CredentialReference,"createdAt"|"updatedAt">):Promise<CredentialReference>{if(!input.reference.trim()||!input.provider.trim()||!input.label.trim())throw new ValidationError("Credential reference fields are required");if(containsCredentialMaterial(input.reference)||containsCredentialMaterial(input.label))throw new ValidationError("Credential references and labels must be non-secret opaque identifiers");if(credentialMaterial(input.metadata))throw new ValidationError("Credential metadata may describe a handle but cannot contain credential material");const old=await this.getCredentialReference(input.reference);const now=new Date().toISOString();const result={...input,createdAt:old?.createdAt??now,updatedAt:now};await this.#client.execute({sql:"INSERT INTO credential_references(reference,provider,label,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(reference) DO UPDATE SET provider=excluded.provider,label=excluded.label,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at",args:[result.reference,result.provider,result.label,JSON.stringify(result.metadata),result.createdAt,result.updatedAt]});return result;}
  async getCredentialReference(reference:string):Promise<CredentialReference|null>{const r=await this.#client.execute({sql:"SELECT * FROM credential_references WHERE reference=?",args:[reference]});const row=r.rows[0];return row?{reference:String(row.reference),provider:String(row.provider),label:String(row.label),metadata:parseJson(row.metadata_json),createdAt:String(row.created_at),updatedAt:String(row.updated_at)}:null;}
  async listCredentialReferences():Promise<CredentialReference[]>{const r=await this.#client.execute("SELECT * FROM credential_references ORDER BY reference");return r.rows.map(row=>({reference:String(row.reference),provider:String(row.provider),label:String(row.label),metadata:parseJson(row.metadata_json),createdAt:String(row.created_at),updatedAt:String(row.updated_at)}));}
  async #profileSkillActionSnapshot(action:ProfileGlobalSkillAction):Promise<ProfileGlobalSkillRecord>{const version=await this.getGlobalSkillVersion(action.versionId);if(!version||version.skillId!==action.skillId||version.digest!==action.digest)throw new ValidationError("Global skill action references a missing immutable version");return{...version,availability:action.availability,status:action.availability,updatedAt:action.createdAt};}
  async installGlobalSkill(input:Omit<ProfileInstalledSkill,"versionId"|"digest"|"createdAt">&{readonly versionId?:string}):Promise<ProfileInstalledSkill>{
    if(!input.skillId.trim()||!input.name.trim())throw new ValidationError("Global skill identity and name are required");
    if(credentialMaterial(input.definition))throw new ValidationError("Global skill definitions cannot contain credential material");
    assertProfileJson(input.definition,"Global skill definition");
    const versionId=input.versionId??newId(),definitionJson=stableJson(input.definition),digest=profileSkillDigest(input.definition),now=new Date().toISOString(),provenanceJson=stableJson({source:"legacy"});
    const tx=await this.#client.transaction("write");let createdAt=now;
    try{
      const existing=(await tx.execute({sql:"SELECT * FROM profile_skill_versions WHERE version_id=?",args:[versionId]})).rows[0];
      if(existing){
        const format=String(existing.definition_format??"legacy");
        if(String(existing.digest)!==digest||String(existing.skill_id)!==input.skillId||String(existing.name)!==input.name||String(existing.definition_json)!==definitionJson||format!=="legacy")throw new ConflictError("Global skill version ID collision",{versionId});
        createdAt=String(existing.created_at);
      }else await tx.execute({sql:"INSERT INTO profile_skill_versions(version_id,skill_id,name,definition_json,digest,created_at,definition_format,provenance_json,test_report_json,effect_ref) VALUES(?,?,?,?,?,?,?,?,?,?)",args:[versionId,input.skillId,input.name,definitionJson,digest,createdAt,"legacy",provenanceJson,null,null]});
      const previous=(await tx.execute({sql:"SELECT availability FROM profile_skills WHERE skill_id=?",args:[input.skillId]})).rows[0];
      await tx.execute({sql:"INSERT INTO profile_skills(skill_id,current_version_id,name,updated_at,availability) VALUES(?,?,?,?,?) ON CONFLICT(skill_id) DO UPDATE SET current_version_id=excluded.current_version_id,name=excluded.name,updated_at=excluded.updated_at,availability=excluded.availability",args:[input.skillId,versionId,input.name,now,"enabled"]});
      const idempotencyKey=`legacy-install:${input.skillId}:${versionId}`,requestDigest=profileSkillRequestDigest({action:"legacy-installed",skillId:input.skillId,versionId,digest,name:input.name,definition:input.definition});
      await tx.execute({sql:"INSERT OR IGNORE INTO profile_skill_actions(action_id,skill_id,version_id,digest,action,previous_availability,availability,effect_ref,idempotency_key,request_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",args:[newId(),input.skillId,versionId,digest,"legacy-installed",previous?String(previous.availability):null,"enabled",null,idempotencyKey,requestDigest,now]});
      await tx.commit();
    }catch(error){if(!tx.closed)await tx.rollback();throw error;}finally{tx.close();}
    return{skillId:input.skillId,versionId,name:input.name,definition:input.definition,digest,createdAt};
  }
  async listGlobalSkills():Promise<ProfileInstalledSkill[]>{const r=await this.#client.execute("SELECT v.* FROM profile_skills s JOIN profile_skill_versions v ON v.version_id=s.current_version_id ORDER BY s.name,s.skill_id");return r.rows.map(row=>({skillId:String(row.skill_id),versionId:String(row.version_id),name:String(row.name),definition:parseJson(row.definition_json),digest:String(row.digest),createdAt:String(row.created_at)}));}
  async stageGlobalSkill(input:StageGlobalSkillInput):Promise<ProfileGlobalSkillRecord>{
    assertProfileSkillId(input.skillId,"Global skill ID");assertProfileSkillName(input.name);
    const versionId=input.versionId??newId();assertProfileSkillId(versionId,"Global skill version ID");
    const definition=validateProfileSkillDefinition(input.definition),digest=profileSkillDigest(definition),provenance=validateProfileSkillProvenance(input.provenance);
    const report=validateProfileSkillTestReport({...input.testReport,versionId,digest},versionId,digest);
    const effectRef=input.effectRef??null;assertProfileSkillEffectRef(effectRef);
    const availability:ProfileGlobalSkillAvailability=(input.availability as ProfileGlobalSkillAvailability|undefined)??(report.outcome==="passed"?"enabled":"disabled");assertProfileSkillAvailability(availability);if(availability==="removed")throw new ValidationError("A staged global skill cannot begin removed");if(availability==="enabled"&&report.outcome!=="passed")throw new ValidationError("A passing same-digest test report is required before enabling a global skill");
    const idempotencyKey=input.idempotencyKey??`stage:${versionId}`;assertProfileSkillId(idempotencyKey,"Global skill idempotency key");
    const hasExpectedVersion=input.expectedCurrentVersionId!==undefined,hasExpectedDigest=input.expectedCurrentDigest!==undefined;if(hasExpectedVersion!==hasExpectedDigest)throw new ValidationError("Global skill staging CAS requires both expected version and digest");if(typeof input.expectedCurrentVersionId==="string")assertProfileSkillId(input.expectedCurrentVersionId,"Expected global skill version ID");if(typeof input.expectedCurrentDigest==="string")assertProfileSkillDigest(input.expectedCurrentDigest,"Expected global skill digest");if(input.expectedCurrentVersionId===null&&input.expectedCurrentDigest!==null&&hasExpectedDigest)throw new ValidationError("Missing global skill CAS must expect null version and digest");
    const request:JsonValue={action:"staged",skillId:input.skillId,versionId,name:input.name,definition,provenance:provenance as unknown as JsonValue,testReport:report as unknown as JsonValue,effectRef,availability,expectedCurrentVersionId:input.expectedCurrentVersionId??null,expectedCurrentDigest:input.expectedCurrentDigest??null};
    const requestDigest=profileSkillRequestDigest(request),now=new Date().toISOString();let action!:ProfileGlobalSkillAction;
    const tx=await this.#client.transaction("write");
    try{
      const prior=(await tx.execute({sql:"SELECT * FROM profile_skill_actions WHERE idempotency_key=?",args:[idempotencyKey]})).rows[0];
      if(prior){action=rowToProfileGlobalSkillAction(prior);if(action.requestDigest!==requestDigest)throw new ConflictError("Global skill action idempotency key was reused with different meaning",{idempotencyKey});}
      else{
        const currentRow=(await tx.execute({sql:"SELECT v.*,s.availability,s.updated_at AS skill_updated_at FROM profile_skills s JOIN profile_skill_versions v ON v.version_id=s.current_version_id WHERE s.skill_id=?",args:[input.skillId]})).rows[0];
        const current=currentRow?rowToProfileGlobalSkillRecord(currentRow):null;
        if(current&&!hasExpectedVersion)throw new ConflictError("Replacing a global skill requires an explicit current-version compare-and-swap",{skillId:input.skillId});
        if(hasExpectedVersion&&(current?.versionId??null)!==(input.expectedCurrentVersionId??null)||hasExpectedDigest&&(current?.digest??null)!==(input.expectedCurrentDigest??null))throw new ConflictError("Global skill staging compare-and-swap failed",{skillId:input.skillId});
        const existing=(await tx.execute({sql:"SELECT * FROM profile_skill_versions WHERE version_id=?",args:[versionId]})).rows[0];
        if(existing){
          const stored=rowToProfileGlobalSkillVersion(existing);const immutable=(value:ProfileGlobalSkillVersion)=>stableJson({skillId:value.skillId,versionId:value.versionId,name:value.name,definition:value.definition,definitionFormat:value.definitionFormat,digest:value.digest,provenance:value.provenance,testReport:value.testReport,effectRef:value.effectRef,createdAt:value.createdAt});
          const candidate:ProfileGlobalSkillVersion={skillId:input.skillId,versionId,name:input.name,definition,definitionFormat:"typescript-v1",digest,provenance,testReport:report,effectRef,createdAt:stored.createdAt};if(immutable(stored)!==immutable(candidate))throw new ConflictError("Global skill version ID collision",{versionId});
        }else await tx.execute({sql:"INSERT INTO profile_skill_versions(version_id,skill_id,name,definition_json,digest,created_at,definition_format,provenance_json,test_report_json,effect_ref) VALUES(?,?,?,?,?,?,?,?,?,?)",args:[versionId,input.skillId,input.name,stableJson(definition),digest,now,"typescript-v1",stableJson(provenance),stableJson(report),effectRef]});
        await tx.execute({sql:"INSERT INTO profile_skills(skill_id,current_version_id,name,updated_at,availability) VALUES(?,?,?,?,?) ON CONFLICT(skill_id) DO UPDATE SET current_version_id=excluded.current_version_id,name=excluded.name,updated_at=excluded.updated_at,availability=excluded.availability",args:[input.skillId,versionId,input.name,now,availability]});
        action={actionId:newId(),skillId:input.skillId,versionId,digest,action:"staged",previousAvailability:current?.availability??null,availability,effectRef,idempotencyKey,requestDigest,createdAt:now};
        await tx.execute({sql:"INSERT INTO profile_skill_actions(action_id,skill_id,version_id,digest,action,previous_availability,availability,effect_ref,idempotency_key,request_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",args:[action.actionId,action.skillId,action.versionId,action.digest,action.action,action.previousAvailability,action.availability,action.effectRef,action.idempotencyKey,action.requestDigest,action.createdAt]});
      }
      await tx.commit();
    }catch(error){if(!tx.closed)await tx.rollback();throw error;}finally{tx.close();}
    return this.#profileSkillActionSnapshot(action);
  }
  async getGlobalSkill(skillId:string,options:ProfileGlobalSkillReadOptions={}):Promise<ProfileGlobalSkillRecord|null>{assertProfileSkillId(skillId,"Global skill ID");const filter=options.includeUnavailable?"":" AND s.availability='enabled'";const row=(await this.#client.execute({sql:`SELECT v.*,s.availability,s.updated_at AS skill_updated_at FROM profile_skills s JOIN profile_skill_versions v ON v.version_id=s.current_version_id WHERE s.skill_id=?${filter}`,args:[skillId]})).rows[0];return row?rowToProfileGlobalSkillRecord(row):null;}
  async getGlobalSkillStatus(skillId:string,options:ProfileGlobalSkillReadOptions={}):Promise<ProfileGlobalSkillRecord|null>{return this.getGlobalSkill(skillId,options);}
  async getGlobalSkillVersion(versionId:string):Promise<ProfileGlobalSkillVersion|null>{assertProfileSkillId(versionId,"Global skill version ID");const row=(await this.#client.execute({sql:"SELECT * FROM profile_skill_versions WHERE version_id=?",args:[versionId]})).rows[0];return row?rowToProfileGlobalSkillVersion(row):null;}
  async listGlobalSkillCatalog(options:ProfileGlobalSkillReadOptions={}):Promise<ProfileGlobalSkillRecord[]>{const filter=options.includeUnavailable?"":" WHERE s.availability='enabled'";const rows=(await this.#client.execute(`SELECT v.*,s.availability,s.updated_at AS skill_updated_at FROM profile_skills s JOIN profile_skill_versions v ON v.version_id=s.current_version_id${filter} ORDER BY s.name,s.skill_id`)).rows;return rows.map(rowToProfileGlobalSkillRecord);}
  async listGlobalSkillStatuses(options:ProfileGlobalSkillReadOptions={}):Promise<ProfileGlobalSkillRecord[]>{return this.listGlobalSkillCatalog(options);}
  async getGlobalSkillHistory(skillId:string):Promise<ProfileGlobalSkillHistory|null>{assertProfileSkillId(skillId,"Global skill ID");const versionRows=(await this.#client.execute({sql:"SELECT * FROM profile_skill_versions WHERE skill_id=? ORDER BY created_at,rowid",args:[skillId]})).rows;if(!versionRows.length)return null;const current=await this.getGlobalSkill(skillId,{includeUnavailable:true});const actions=(await this.#client.execute({sql:"SELECT * FROM profile_skill_actions WHERE skill_id=? ORDER BY created_at,rowid",args:[skillId]})).rows.map(rowToProfileGlobalSkillAction);return{skillId,current,versions:versionRows.map(rowToProfileGlobalSkillVersion),actions};}
  async listGlobalSkillHistory(skillId:string):Promise<ProfileGlobalSkillHistory|null>{return this.getGlobalSkillHistory(skillId);}
  async setGlobalSkillStatus(input:SetGlobalSkillStatusInput):Promise<ProfileGlobalSkillRecord>{assertProfileSkillAvailability(input.status);return this.#setGlobalSkillAvailability({...input,availability:input.status});}
  async setGlobalSkillAvailability(input:SetGlobalSkillAvailabilityInput):Promise<ProfileGlobalSkillRecord>{assertProfileSkillAvailability(input.availability);return this.#setGlobalSkillAvailability(input);}
  async #setGlobalSkillAvailability(input:SetGlobalSkillAvailabilityInput):Promise<ProfileGlobalSkillRecord>{
    assertProfileSkillId(input.skillId,"Global skill ID");assertProfileSkillId(input.expectedVersionId,"Expected global skill version ID");assertProfileSkillDigest(input.expectedDigest,"Expected global skill digest");assertProfileSkillId(input.idempotencyKey,"Global skill idempotency key");const effectRef=input.effectRef??null;assertProfileSkillEffectRef(effectRef);
    const requestDigest=profileSkillRequestDigest({action:"status-changed",skillId:input.skillId,availability:input.availability,expectedVersionId:input.expectedVersionId,expectedDigest:input.expectedDigest,effectRef}),now=new Date().toISOString();let action!:ProfileGlobalSkillAction;
    const tx=await this.#client.transaction("write");
    try{
      const prior=(await tx.execute({sql:"SELECT * FROM profile_skill_actions WHERE idempotency_key=?",args:[input.idempotencyKey]})).rows[0];
      if(prior){action=rowToProfileGlobalSkillAction(prior);if(action.requestDigest!==requestDigest)throw new ConflictError("Global skill action idempotency key was reused with different meaning",{idempotencyKey:input.idempotencyKey});}
      else{
        const row=(await tx.execute({sql:"SELECT v.*,s.availability,s.updated_at AS skill_updated_at FROM profile_skills s JOIN profile_skill_versions v ON v.version_id=s.current_version_id WHERE s.skill_id=?",args:[input.skillId]})).rows[0];if(!row)throw new ConflictError("Global skill is missing",{skillId:input.skillId});const current=rowToProfileGlobalSkillRecord(row);
        if(current.versionId!==input.expectedVersionId||current.digest!==input.expectedDigest)throw new ConflictError("Global skill status compare-and-swap failed",{skillId:input.skillId});assertProfileSkillTransition(current.availability,input.availability,current);
        const changed=await tx.execute({sql:"UPDATE profile_skills SET availability=?,updated_at=? WHERE skill_id=? AND current_version_id=? AND availability=?",args:[input.availability,now,input.skillId,input.expectedVersionId,current.availability]});if(changed.rowsAffected!==1)throw new ConflictError("Global skill status compare-and-swap failed",{skillId:input.skillId});
        action={actionId:newId(),skillId:input.skillId,versionId:current.versionId,digest:current.digest,action:"status-changed",previousAvailability:current.availability,availability:input.availability,effectRef,idempotencyKey:input.idempotencyKey,requestDigest,createdAt:now};
        await tx.execute({sql:"INSERT INTO profile_skill_actions(action_id,skill_id,version_id,digest,action,previous_availability,availability,effect_ref,idempotency_key,request_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",args:[action.actionId,action.skillId,action.versionId,action.digest,action.action,action.previousAvailability,action.availability,action.effectRef,action.idempotencyKey,action.requestDigest,action.createdAt]});
      }
      await tx.commit();
    }catch(error){if(!tx.closed)await tx.rollback();throw error;}finally{tx.close();}
    return this.#profileSkillActionSnapshot(action);
  }
  async putWorkspace(x:WorkspaceCatalogEntry):Promise<void>{if(x.syncUrl)assertSafeRemoteUrl(x.syncUrl);if(x.credentialReference&&containsCredentialMaterial(x.credentialReference))throw new ValidationError("Workspace credential references must be non-secret opaque identifiers");await this.#client.execute({sql:"INSERT INTO workspace_catalog(workspace_id,name,database_url,replica_url,sync_url,credential_reference,owner_profile_id,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET name=excluded.name,database_url=excluded.database_url,replica_url=excluded.replica_url,sync_url=excluded.sync_url,credential_reference=excluded.credential_reference,owner_profile_id=excluded.owner_profile_id,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at",args:[x.workspaceId,x.name,x.databaseUrl,x.replicaUrl,x.syncUrl,x.credentialReference,x.ownerProfileId,x.createdAt,x.updatedAt,x.deletedAt]});}
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

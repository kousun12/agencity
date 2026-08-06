import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TursoSyncTransport, ProfileStore, ValidationError } from "../../src/index.ts";

let directory:string|undefined;let profile:ProfileStore|undefined;
afterEach(async()=>{profile?.close();profile=undefined;if(directory)await rm(directory,{recursive:true,force:true});directory=undefined;});
describe("Slice 4 profile and official adapter boundaries",()=>{
 test("keeps device identity, preferences, credential references, and workspace catalog in a separate database",async()=>{directory=await mkdtemp(join(tmpdir(),"ag-profile-"));const url=`file:${directory}/profile.db`;profile=await ProfileStore.open(url);const first=await profile.getOrCreateDeviceIdentity("laptop");await profile.setPreference("theme",{name:"dark"});const ref=await profile.putCredentialReference({reference:"credential:turso-main",provider:"turso",label:"main",metadata:{organization:"example",apiKeyReference:"keychain:turso-main",credential:{reference:"vault:turso-main",provider:"vault"}}});expect(ref.reference).toBe("credential:turso-main");await expect(profile.putCredentialReference({reference:"bad",provider:"x",label:"x",metadata:{authToken:"secret"}})).rejects.toBeInstanceOf(ValidationError);await expect(profile.putCredentialReference({reference:"bad-value",provider:"x",label:"x",metadata:{note:"sk-live-1234567890abcdef"}})).rejects.toBeInstanceOf(ValidationError);await expect(profile.putCredentialReference({reference:"bad-url",provider:"x",label:"x",metadata:{endpoint:"https://example.invalid/path?authToken=secret"}})).rejects.toBeInstanceOf(ValidationError);const now=new Date().toISOString();await profile.putWorkspace({workspaceId:"w",name:"W",databaseUrl:"file:w.db",replicaUrl:null,syncUrl:"libsql://example",credentialReference:ref.reference,ownerProfileId:first.profileId,createdAt:now,updatedAt:now,deletedAt:null});profile.close();profile=await ProfileStore.open(url);expect((await profile.getOrCreateDeviceIdentity()).deviceId).toBe(first.deviceId);expect((await profile.getPreference("theme"))?.value).toEqual({name:"dark"});expect((await profile.listCredentialReferences()).map(x=>x.reference)).toEqual([ref.reference]);const installed=await profile.installGlobalSkill({skillId:"skill:formatter",name:"formatter",definition:{runtime:"bun",source:"export default () => null"}});expect(installed.digest).toHaveLength(64);expect((await profile.listGlobalSkills()).map(x=>x.skillId)).toEqual(["skill:formatter"]);expect((await profile.listWorkspaces()).map(x=>x.workspaceId)).toEqual(["w"]);});
 test("rejects known expanded secrets and credential-shaped reference or label fields before database binding",async()=>{
  directory=await mkdtemp(join(tmpdir(),"ag-profile-secret-"));
  profile=await ProfileStore.open(`file:${directory}/profile.db`);
  const previous=process.env.OPENAI_API_KEY;
  const expandedSecret="known-shell-expanded-value-4815162342";
  const shapedReference="sk-live-CREDENTIALSHAPED0123456789";
  const shapedLabel="Bearer credentialshapedlabel123456";
  process.env.OPENAI_API_KEY=expandedSecret;
  try {
   const cases=[
    {reference:expandedSecret,label:"safe label",rejected:expandedSecret},
    {reference:"env:OPENAI_API_KEY",label:expandedSecret,rejected:expandedSecret},
    {reference:shapedReference,label:"safe label",rejected:shapedReference},
    {reference:"env:OPENAI_API_KEY",label:shapedLabel,rejected:shapedLabel},
   ];
   for(const candidate of cases){
    let rejected:unknown;
    try{await profile.putCredentialReference({reference:candidate.reference,provider:"openai",label:candidate.label,metadata:{kind:"opaque-handle"}});}catch(error){rejected=error;}
    expect(rejected).toBeInstanceOf(ValidationError);
    expect(String(rejected)).not.toContain(candidate.rejected);
   }
   expect(await profile.listCredentialReferences()).toEqual([]);
  } finally {
   if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;
  }
  profile.close();profile=undefined;
  let bytes="";
  for(const entry of await readdir(directory))bytes+=(await readFile(join(directory,entry))).toString("latin1");
  for(const rejected of [expandedSecret,shapedReference,shapedLabel])expect(bytes).not.toContain(rejected);
 });
 test("advertises the installed official directional primitives without a legacy sync() envelope",()=>{expect(()=>new TursoSyncTransport({replicaUrl:"https://not-local",syncUrl:"libsql://example"})).toThrow("local file");expect(()=>new TursoSyncTransport({replicaUrl:"file:/tmp/x",syncUrl:"libsql://example?authToken=secret"})).toThrow("credential query");expect(TursoSyncTransport.prototype.push).toBeFunction();expect(TursoSyncTransport.prototype.pull).toBeFunction();expect(TursoSyncTransport.prototype.checkpoint).toBeFunction();expect(TursoSyncTransport.prototype.stats).toBeFunction();expect((TursoSyncTransport.prototype as any).sync).toBeUndefined();});
});

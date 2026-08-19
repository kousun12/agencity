import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TursoSyncTransport, ProfileStore, ValidationError, registerBrokeredSecret } from "../../src/index.ts";

let directory:string|undefined;let profile:ProfileStore|undefined;
afterEach(async()=>{profile?.close();profile=undefined;if(directory)await rm(directory,{recursive:true,force:true});directory=undefined;});
describe("Slice 4 profile and official adapter boundaries",()=>{
 test("keeps device identity, preferences, credential references, and workspace catalog in a separate database",async()=>{directory=await mkdtemp(join(tmpdir(),"ag-profile-"));const url=`file:${directory}/profile.db`;profile=await ProfileStore.open(url);const first=await profile.getOrCreateDeviceIdentity("laptop");await profile.setPreference("theme",{name:"dark"});const ref=await profile.putCredentialReference({reference:"credential:turso-main",provider:"turso",label:"main",metadata:{organization:"example",apiKeyReference:"keychain:turso-main",credential:{reference:"vault:turso-main",provider:"vault"}}});expect(ref.reference).toBe("credential:turso-main");const descriptive=await profile.putCredentialReference({reference:"credential:descriptive",provider:"x",label:"Bearer-shaped label",metadata:{authToken:"ordinary-value",note:"sk-live-placeholder",endpoint:"https://example.invalid/path?authToken=page-2"}});expect(descriptive.metadata).toEqual({authToken:"ordinary-value",note:"sk-live-placeholder",endpoint:"https://example.invalid/path?authToken=page-2"});await expect(profile.putCredentialReference({reference:"not-an-opaque-handle",provider:"x",label:"x",metadata:{}})).rejects.toBeInstanceOf(ValidationError);const now=new Date().toISOString();await profile.putWorkspace({workspaceId:"w",name:"W",databaseUrl:"file:w.db",replicaUrl:null,syncUrl:"libsql://example?authToken=ordinary-value",credentialReference:ref.reference,ownerProfileId:first.profileId,createdAt:now,updatedAt:now,deletedAt:null});profile.close();profile=await ProfileStore.open(url);expect((await profile.getOrCreateDeviceIdentity()).deviceId).toBe(first.deviceId);expect((await profile.getPreference("theme"))?.value).toEqual({name:"dark"});expect((await profile.listCredentialReferences()).map(x=>x.reference)).toEqual([descriptive.reference,ref.reference]);const installed=await profile.installGlobalSkill({skillId:"skill:formatter",name:"formatter",definition:{runtime:"bun",source:"export default () => ({ token: 'ordinary' })"}});expect(installed.digest).toHaveLength(64);expect((await profile.listGlobalSkills()).map(x=>x.skillId)).toEqual(["skill:formatter"]);expect((await profile.listWorkspaces()).map(x=>x.workspaceId)).toEqual(["w"]);});
 test("rejects malformed handles and explicitly registered values without guessing from shapes",async()=>{
  directory=await mkdtemp(join(tmpdir(),"ag-profile-secret-"));
  profile=await ProfileStore.open(`file:${directory}/profile.db`);
  const expandedSecret="vault:known-shell-expanded-value-4815162342";
  const shapedReference="sk-live-CREDENTIALSHAPED0123456789";
  const shapedLabel="Bearer credentialshapedlabel123456";
  const release=registerBrokeredSecret(expandedSecret);
  try {
   const cases=[
    {reference:expandedSecret,label:"safe label",rejected:expandedSecret},
    {reference:"env:OPENAI_API_KEY",label:expandedSecret,rejected:expandedSecret},
    {reference:shapedReference,label:"safe label",rejected:null},
   ];
   for(const candidate of cases){
    let rejected:unknown;
    try{await profile.putCredentialReference({reference:candidate.reference,provider:"openai",label:candidate.label,metadata:{kind:"opaque-handle"}});}catch(error){rejected=error;}
    expect(rejected).toBeInstanceOf(ValidationError);
    if(candidate.rejected)expect(String(rejected)).not.toContain(candidate.rejected);
   }
   await profile.putCredentialReference({reference:"env:OPENAI_API_KEY",provider:"openai",label:shapedLabel,metadata:{token:"pagination-cursor"}});
   expect((await profile.listCredentialReferences()).map(item=>item.label)).toEqual([shapedLabel]);
  } finally {
   release();
  }
  profile.close();profile=undefined;
  let bytes="";
  for(const entry of await readdir(directory))bytes+=(await readFile(join(directory,entry))).toString("latin1");
  expect(bytes).not.toContain(expandedSecret);
  expect(bytes).toContain(shapedLabel);
 });
 test("advertises the installed official directional primitives without a legacy sync() envelope",()=>{expect(()=>new TursoSyncTransport({replicaUrl:"https://not-local",syncUrl:"libsql://example"})).toThrow("local file");expect(()=>new TursoSyncTransport({replicaUrl:"file:/tmp/x",syncUrl:"libsql://user:password@example"})).toThrow("embedded credentials");expect(()=>new TursoSyncTransport({replicaUrl:"file:/tmp/x",syncUrl:"libsql://example?authToken=ordinary-value"})).not.toThrow();expect(TursoSyncTransport.prototype.push).toBeFunction();expect(TursoSyncTransport.prototype.pull).toBeFunction();expect(TursoSyncTransport.prototype.checkpoint).toBeFunction();expect(TursoSyncTransport.prototype.stats).toBeFunction();expect((TursoSyncTransport.prototype as any).sync).toBeUndefined();});
});

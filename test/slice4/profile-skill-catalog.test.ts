import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConflictError, ProfileStore, ValidationError, registerBrokeredSecret } from "../../src/index.ts";

let directory:string|undefined;let profile:ProfileStore|undefined;
afterEach(async()=>{profile?.close();profile=undefined;if(directory)await rm(directory,{recursive:true,force:true});directory=undefined;});
const definition={
 description:"Formats one value deterministically",
 source:"export default async (input: unknown) => ({ value: input });",
 inputSchema:{type:"object",properties:{value:{type:"string"}}},
 permissions:["state.read"],
 tests:[{name:"wraps",input:{value:"x"},expected:{value:{value:"x"}}}],
 runtime:"bun" as const,
 compatibility:"agencity-v1",
};
const report=(outcome:"passed"|"failed"="passed")=>outcome==="passed"
 ? {testId:"test-profile-format",testedAt:"2026-08-06T00:00:00.000Z",compiled:true,passed:1,failed:0,outcome} as const
 : {testId:"test-profile-format-failed",testedAt:"2026-08-06T00:00:00.000Z",compiled:false,passed:0,failed:1,outcome} as const;
const provenance={source:"profile-api" as const,reference:"test-fixture",installedBy:"test-runner"};

async function open(){directory=await mkdtemp(join(tmpdir(),"ag-profile-skills-"));profile=await ProfileStore.open(`file:${directory}/profile.db`);return profile;}

describe("profile global skill catalog storage",()=>{
 test("keeps legacy installs visible and explicitly tagged without treating their loose definition as strict",async()=>{
  const store=await open();
  const legacy=await store.installGlobalSkill({skillId:"skill:legacy",versionId:"version:legacy",name:"legacy",definition:{runtime:"bun",source:"export default () => 'ok'"}});
  expect((await store.listGlobalSkills()).map(item=>item.versionId)).toEqual([legacy.versionId]);
  const catalog=await store.listGlobalSkillCatalog();
  expect(catalog).toHaveLength(1);expect(catalog[0]?.definitionFormat).toBe("legacy");expect(catalog[0]?.provenance).toEqual({source:"legacy"});expect(catalog[0]?.availability).toBe("enabled");
  store.close();profile=await ProfileStore.open(store.url);
  expect((await profile.listGlobalSkills())[0]?.definition).toEqual({runtime:"bun",source:"export default () => 'ok'"});
  const reopened=await profile.getGlobalSkill("skill:legacy");expect(reopened?.provenance).toEqual({source:"legacy"});expect(reopened?.status).toBe("enabled");
  expect((await profile.getGlobalSkillHistory("skill:legacy"))?.versions).toHaveLength(1);
 });

 test("stages only validated immutable definitions with digest-bound provenance, tests, effects, and stable actions",async()=>{
  const store=await open();
  const staged=await store.stageGlobalSkill({skillId:"skill:format",versionId:"version:format:1",name:"format-value",definition,provenance,testReport:report(),effectRef:"effect:skill-test:1",idempotencyKey:"stage:format:1",expectedCurrentVersionId:null,expectedCurrentDigest:null});
  expect(staged.digest).toHaveLength(64);expect(staged.definitionFormat).toBe("typescript-v1");expect(staged.testReport?.digest).toBe(staged.digest);expect(staged.availability).toBe("enabled");expect(staged.effectRef).toBe("effect:skill-test:1");
  const retry=await store.stageGlobalSkill({skillId:"skill:format",versionId:"version:format:1",name:"format-value",definition,provenance,testReport:report(),effectRef:"effect:skill-test:1",idempotencyKey:"stage:format:1",expectedCurrentVersionId:null,expectedCurrentDigest:null});
  expect(retry).toEqual(staged);
  const history=await store.getGlobalSkillHistory("skill:format");expect(history?.versions).toHaveLength(1);expect(history?.actions).toHaveLength(1);expect(history?.actions[0]?.effectRef).toBe("effect:skill-test:1");
  expect((await store.getGlobalSkillVersion(staged.versionId))?.provenance).toEqual(provenance);
  const nextDefinition={...definition,source:`${definition.source}\n// version 2`};
  await expect(store.stageGlobalSkill({skillId:"skill:format",versionId:"version:format:2",name:"format-value",definition:nextDefinition,provenance,testReport:report(),idempotencyKey:"stage:format:2:no-cas"})).rejects.toBeInstanceOf(ConflictError);
  const next=await store.stageGlobalSkill({skillId:"skill:format",versionId:"version:format:2",name:"format-value",definition:nextDefinition,provenance,testReport:report(),idempotencyKey:"stage:format:2",expectedCurrentVersionId:staged.versionId,expectedCurrentDigest:staged.digest});
  expect(next.versionId).toBe("version:format:2");expect((await store.getGlobalSkillHistory("skill:format"))?.versions).toHaveLength(2);
  await expect(store.stageGlobalSkill({skillId:"skill:bad",name:"bad",definition:{...definition,runtime:"node" as any},provenance,testReport:report(),idempotencyKey:"stage:bad"})).rejects.toBeInstanceOf(ValidationError);
  const release=registerBrokeredSecret("sk-live-CREDENTIALSHAPED0123456789");
  try{await expect(store.stageGlobalSkill({skillId:"skill:secret",name:"secret",definition:{...definition,source:"const token = 'sk-live-CREDENTIALSHAPED0123456789';"},provenance,testReport:report(),idempotencyKey:"stage:secret"})).rejects.toBeInstanceOf(ValidationError);}finally{release();}
  await expect(store.stageGlobalSkill({skillId:"skill:failed",name:"failed",definition,provenance,testReport:report("failed"),availability:"enabled",idempotencyKey:"stage:failed"})).rejects.toBeInstanceOf(ValidationError);
  expect((await store.listGlobalSkillCatalog()).map(item=>item.skillId)).toEqual(["skill:format"]);
 });

 test("uses CAS lifecycle actions, hides unavailable pointers by default, and retains removed history",async()=>{
  const store=await open();
  const staged=await store.stageGlobalSkill({skillId:"skill:lifecycle",versionId:"version:lifecycle:1",name:"lifecycle",definition,provenance,testReport:report(),idempotencyKey:"stage:lifecycle"});
  const stagedAction=(await store.getGlobalSkillHistory(staged.skillId))!.actions.at(-1)!;
  const disableInput={skillId:staged.skillId,status:"disabled" as const,expectedVersionId:staged.versionId,expectedDigest:staged.digest,expectedAvailability:"enabled" as const,expectedActionSequence:stagedAction.sequence,idempotencyKey:"status:lifecycle:disable",effectRef:"effect:disable:1"};
  const [disabled,concurrentRetry]=await Promise.all([store.setGlobalSkillStatus(disableInput),store.setGlobalSkillStatus(disableInput)]);
  expect(concurrentRetry).toEqual(disabled);expect(disabled.status).toBe("disabled");expect(await store.getGlobalSkill(staged.skillId)).toBeNull();expect(await store.listGlobalSkillCatalog()).toEqual([]);expect((await store.listGlobalSkillStatuses({includeUnavailable:true}))[0]?.availability).toBe("disabled");
  const retry=await store.setGlobalSkillStatus(disableInput);expect(retry).toEqual(disabled);
  await expect(store.setGlobalSkillStatus({...disableInput,status:"removed"})).rejects.toBeInstanceOf(ConflictError);
  const disabledAction=(await store.getGlobalSkillHistory(staged.skillId))!.actions.at(-1)!;
  await expect(store.setGlobalSkillStatus({skillId:staged.skillId,status:"enabled",expectedVersionId:"version:stale",expectedDigest:staged.digest,expectedAvailability:"disabled",expectedActionSequence:disabledAction.sequence,idempotencyKey:"status:lifecycle:stale"})).rejects.toBeInstanceOf(ConflictError);
  const enabled=await store.setGlobalSkillAvailability({skillId:staged.skillId,availability:"enabled",expectedVersionId:staged.versionId,expectedDigest:staged.digest,expectedAvailability:"disabled",expectedActionSequence:disabledAction.sequence,idempotencyKey:"status:lifecycle:enable"});expect(enabled.versionId).toBe(staged.versionId);expect((await store.getGlobalSkill(staged.skillId))?.digest).toBe(staged.digest);
  const enabledAction=(await store.getGlobalSkillHistory(staged.skillId))!.actions.at(-1)!;
  const disabledAgain=await store.setGlobalSkillStatus({skillId:staged.skillId,status:"disabled",expectedVersionId:staged.versionId,expectedDigest:staged.digest,expectedAvailability:"enabled",expectedActionSequence:enabledAction.sequence,idempotencyKey:"status:lifecycle:disable:2"});expect(disabledAgain.availability).toBe("disabled");
  const disabledAgainAction=(await store.getGlobalSkillHistory(staged.skillId))!.actions.at(-1)!;
  await store.setGlobalSkillStatus({skillId:staged.skillId,status:"enabled",expectedVersionId:staged.versionId,expectedDigest:staged.digest,expectedAvailability:"disabled",expectedActionSequence:disabledAgainAction.sequence,idempotencyKey:"status:lifecycle:enable:2"});
  const reenabledAction=(await store.getGlobalSkillHistory(staged.skillId))!.actions.at(-1)!;
  const raceBase={skillId:staged.skillId,expectedVersionId:staged.versionId,expectedDigest:staged.digest,expectedAvailability:"enabled" as const,expectedActionSequence:reenabledAction.sequence};const raced=await Promise.allSettled([store.setGlobalSkillStatus({...raceBase,status:"disabled",idempotencyKey:"status:lifecycle:race-disable"}),store.setGlobalSkillStatus({...raceBase,status:"removed",idempotencyKey:"status:lifecycle:race-remove"})]);expect(raced.map(result=>result.status).sort()).toEqual(["fulfilled","rejected"]);expect(raced.find(result=>result.status==="rejected")).toMatchObject({reason:expect.any(ConflictError)});
  let removed=await store.getGlobalSkill(staged.skillId,{includeUnavailable:true});if(removed?.availability!=="removed"){const latest=(await store.getGlobalSkillHistory(staged.skillId))!.actions.at(-1)!;removed=await store.setGlobalSkillStatus({skillId:staged.skillId,status:"removed",expectedVersionId:staged.versionId,expectedDigest:staged.digest,expectedAvailability:"disabled",expectedActionSequence:latest.sequence,idempotencyKey:"status:lifecycle:remove"});}expect(removed?.availability).toBe("removed");expect(await store.getGlobalSkill(staged.skillId)).toBeNull();expect(await store.getGlobalSkillVersion(staged.versionId)).not.toBeNull();
  const removedAction=(await store.getGlobalSkillHistory(staged.skillId))!.actions.at(-1)!;
  await expect(store.setGlobalSkillStatus({skillId:staged.skillId,status:"enabled",expectedVersionId:staged.versionId,expectedDigest:staged.digest,expectedAvailability:"removed",expectedActionSequence:removedAction.sequence,idempotencyKey:"status:lifecycle:restore"})).rejects.toBeInstanceOf(ConflictError);
  const history=await store.listGlobalSkillHistory(staged.skillId);expect(history?.versions).toHaveLength(1);expect(history?.actions.map(item=>item.availability).slice(0,5)).toEqual(["enabled","disabled","enabled","disabled","enabled"]);expect(history?.actions.at(-1)?.availability).toBe("removed");expect(history?.actions.map(item=>item.sequence)).toEqual([...history!.actions.map(item=>item.sequence)].sort((a,b)=>a-b));
  const raw=createClient({url:store.url});await expect(raw.execute("UPDATE profile_skill_versions SET name='rewritten'")).rejects.toThrow("append-only");await expect(raw.execute("DELETE FROM profile_skill_actions")).rejects.toThrow("append-only");raw.close();
 });

 test("rejects a pre-cutover profile without rewriting or losing its rows",async()=>{
  directory=await mkdtemp(join(tmpdir(),"ag-profile-skills-old-"));const url=`file:${directory}/profile.db`,raw=createClient({url});
  await raw.executeMultiple("CREATE TABLE profile_skill_versions(version_id TEXT PRIMARY KEY,skill_id TEXT NOT NULL,name TEXT NOT NULL,definition_json TEXT NOT NULL,digest TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE profile_skills(skill_id TEXT PRIMARY KEY,current_version_id TEXT NOT NULL,name TEXT NOT NULL,updated_at TEXT NOT NULL);");
  const legacyDefinition={runtime:"bun",source:"export default () => null"},json=JSON.stringify(legacyDefinition);const hasher=new Bun.CryptoHasher("sha256");hasher.update(json);const digest=hasher.digest("hex"),at="2026-08-06T00:00:00.000Z";
  await raw.execute({sql:"INSERT INTO profile_skill_versions VALUES(?,?,?,?,?,?)",args:["version:old","skill:old","old",json,digest,at]});await raw.execute({sql:"INSERT INTO profile_skills VALUES(?,?,?,?)",args:["skill:old","version:old","old",at]});raw.close();
  await expect(ProfileStore.open(url)).rejects.toThrow("predates the reasoning/model-capability schema cutover");
  const retained=createClient({url});const rows=await retained.execute("SELECT version_id,definition_json FROM profile_skill_versions");expect(rows.rows.map(row=>({version_id:String(row.version_id),definition_json:String(row.definition_json)}))).toEqual([{version_id:"version:old",definition_json:json}]);retained.close();
 });
});

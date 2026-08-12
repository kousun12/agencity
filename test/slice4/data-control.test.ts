import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeterministicSyncHub, ProfileStore, Supervisor } from "../../src/index.ts";
import {
  ApprovingGovernanceProvider,
  approveProfileRevision,
} from "../governance-provider.ts";

async function exists(path:string):Promise<boolean>{return Bun.file(path).exists();}

function options(directory:string,workspaceId="workspace"){
  return {databaseUrl:`file:${directory}/workspace.db`,profileDatabaseUrl:`file:${directory}/profile.db`,artifactDirectory:join(directory,"artifacts"),workspaceRoot:directory,recover:false,sync:{workspaceId,startup:false,intervalMs:0}} as const;
}

describe("ownership-aware physical data control",()=>{
  test("exports complete governed profile provenance and marks missing artifact bytes partial",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"agencity-export-incomplete-"));let supervisor:Supervisor|undefined;
    try{
      const provider=new ApprovingGovernanceProvider("export-governance");
      supervisor=await Supervisor.open({...options(directory),modelProviders:[provider]});
      const session=await supervisor.createSession({workspaceId:"workspace",model:{provider:provider.name,model:"fixture"}});
      await approveProfileRevision(supervisor,session.sessionId,session.branchId,"Retain complete governed export evidence.","export-profile");
      const generation=await supervisor.ai.admitText(session.sessionId,session.branchId,{prompt:"export generation",idempotencyKey:"export-generation"});
      expect(await supervisor.ai.result(generation.generationId,{wait:true,timeoutMs:5000})).toMatchObject({status:"succeeded"});
      const artifact=await supervisor.artifacts.put("missing export bytes",{mediaType:"text/plain"});
      await supervisor.storage.appendEvents([{sessionId:session.sessionId,branchId:session.branchId,type:"ArtifactRegistered",producer:"supervisor",idempotencyKey:"missing-export-artifact",payload:artifact}]);
      await rm(join(directory,"artifacts",artifact.digest.slice(0,2),artifact.digest.slice(2)));
      const destination=join(directory,"export");
      const exported=await supervisor.sync.exportBundle(destination,"workspace","workspace","owner");
      expect(exported.status).toBe("partial");
      const events=(await Bun.file(join(destination,"events.jsonl")).text()).trim().split("\n").map(line=>JSON.parse(line));
      expect(events.filter(event=>event.type==="AgentProfileVersionCreated")).toHaveLength(1);
      expect(events.filter(event=>event.type==="AiGenerationResultCommitted")).toHaveLength(1);
      const audit=JSON.parse(await Bun.file(join(destination,"export-audit.json")).text());
      expect(audit.complete).toBe(false);
      expect(audit.missing.some((item:string)=>item.startsWith("governed-proposal:"))).toBe(false);
      expect(audit.missing.some((item:string)=>item.startsWith("governance-decision:"))).toBe(false);
      expect(audit.missing).toContain(`artifact:${artifact.artifactId}`);
      expect(JSON.parse(await Bun.file(join(destination,"manifest.json")).text())).toMatchObject({status:"partial",resources:{exportAudit:{complete:false}}});
    }finally{await supervisor?.close();await rm(directory,{recursive:true,force:true});}
  });

  test("physically erases an independent session and its derived rows without deleting shared CAS content",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"agencity-delete-session-"));let supervisor:Supervisor|undefined;
    try{
      supervisor=await Supervisor.open(options(directory));
      const doomed=await supervisor.createSession({workspaceId:"workspace"});const retained=await supervisor.createSession({workspaceId:"workspace"});
      await supervisor.appendMessage(doomed.sessionId,doomed.branchId,"user","delete me");await supervisor.appendMessage(retained.sessionId,retained.branchId,"user","retain me");
      const generation=await supervisor.ai.admitText(doomed.sessionId,doomed.branchId,{prompt:"deletion projection",idempotencyKey:"delete-generation"});
      expect(await supervisor.ai.result(generation.generationId,{wait:true,timeoutMs:5000})).toMatchObject({status:"succeeded"});
      await supervisor.contexts.materialize(doomed.sessionId,doomed.branchId);await supervisor.projections.rebuild(doomed.sessionId,doomed.branchId);
      const shared=await supervisor.artifacts.put("shared bytes",{mediaType:"text/plain"});const unique=await supervisor.artifacts.put("doomed bytes",{mediaType:"text/plain"});
      await supervisor.storage.appendEvents([
        {sessionId:doomed.sessionId,branchId:doomed.branchId,type:"ArtifactRegistered",producer:"supervisor",idempotencyKey:"doomed-shared",payload:shared},
        {sessionId:doomed.sessionId,branchId:doomed.branchId,type:"ArtifactRegistered",producer:"supervisor",idempotencyKey:"doomed-unique",payload:unique},
        {sessionId:retained.sessionId,branchId:retained.branchId,type:"ArtifactRegistered",producer:"supervisor",idempotencyKey:"retained-shared",payload:shared},
      ]);
      const receipt=await supervisor.deleteOwnedData({scopeKind:"session",scopeId:doomed.sessionId,requestedBy:"owner",confirmation:`DELETE session ${doomed.sessionId}`,receiptDirectory:join(directory,"receipts")});supervisor=undefined;
      expect(receipt.status).toBe("completed");expect(receipt.removed.rows.events).toBeGreaterThan(0);expect(receipt.removed.rows.ai_generations).toBe(1);expect(receipt.retainedSharedArtifacts).toEqual([shared.artifactId]);
      expect(await exists(join(directory,"artifacts",shared.digest.slice(0,2),shared.digest.slice(2)))).toBe(true);
      expect(await exists(join(directory,"artifacts",unique.digest.slice(0,2),unique.digest.slice(2)))).toBe(false);
      const client=createClient({url:`file:${directory}/workspace.db`});
      try{
        expect(Number((await client.execute({sql:"SELECT count(*) AS n FROM events WHERE session_id=?",args:[doomed.sessionId]})).rows[0]!.n)).toBe(0);
        expect(Number((await client.execute({sql:"SELECT count(*) AS n FROM sessions WHERE session_id=?",args:[doomed.sessionId]})).rows[0]!.n)).toBe(0);
        expect(Number((await client.execute({sql:"SELECT count(*) AS n FROM context_records WHERE session_id=?",args:[doomed.sessionId]})).rows[0]!.n)).toBe(0);
        const retainedEvent=(await client.execute({sql:"SELECT id FROM events WHERE session_id=? LIMIT 1",args:[retained.sessionId]})).rows[0]!.id;
        await expect(client.execute({sql:"DELETE FROM events WHERE id=?",args:[retainedEvent as string]})).rejects.toThrow("append-only");
      }finally{client.close();}
    }finally{await supervisor?.close();await rm(directory,{recursive:true,force:true});}
  });

  test("plans governance retention and refuses session erasure that would dangle review, restoration, family, notice, or invocation provenance",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"agencity-delete-governance-"));let supervisor:Supervisor|undefined;
    try{
      const provider=new ApprovingGovernanceProvider("deletion-governance");
      supervisor=await Supervisor.open({...options(directory),modelProviders:[provider]});const session=await supervisor.createSession({workspaceId:"workspace",model:{provider:provider.name,model:"fixture"}});const initial=await supervisor.agentProfiles.active(session.sessionId);
      const evidence=await supervisor.appendMessage(session.sessionId,session.branchId,"user","Retain governance deletion evidence");
      const revised=await approveProfileRevision(supervisor,session.sessionId,session.branchId,"Temporary deletion-plan revision.","deletion-profile");
      await supervisor.refinementGovernance.rollbackOwner(session.sessionId,session.branchId,{targetKind:"agent_profile",targetId:session.sessionId,expectedCurrentVersionId:revised.profileVersionId,restoreVersionId:initial.profileVersionId,reason:"Create deletion-plan restoration provenance",evidenceEventIds:[evidence.id]});
      expect((await supervisor.runs.start(session.sessionId,session.branchId,{task:"Pin the restored profile before deletion planning",goalMode:"none"})).status).toBe("succeeded");
      const [governed]=await supervisor.refinementGovernance.list({sessionId:session.sessionId,branchId:session.branchId,limit:1});
      const proposalId=governed!.proposalId;
      const manifest=await supervisor.sync.createManifest("delete","session",session.sessionId,"owner");
      expect((manifest.resources as any).retainedGovernance).toEqual([
        "initial and historical agent profiles","invocation profile and effective-prompt pins",
        "governed proposals and frozen review inputs","reviewer child and model dispatch",
        "review decisions and terminal notices","restoration provenance and evidence links",
      ]);
      await expect(supervisor.deleteOwnedData({scopeKind:"session",scopeId:session.sessionId,requestedBy:"owner",confirmation:`DELETE session ${session.sessionId}`})).rejects.toMatchObject({code:"CAPABILITY_UNAVAILABLE"});supervisor=undefined;
      const client=createClient({url:`file:${directory}/workspace.db`});try{
        expect(Number((await client.execute({sql:"SELECT count(*) AS n FROM events WHERE session_id=?",args:[session.sessionId]})).rows[0]!.n)).toBeGreaterThan(0);
        expect(Number((await client.execute({sql:"SELECT count(*) AS n FROM agent_profile_versions WHERE agent_session_id=?",args:[session.sessionId]})).rows[0]!.n)).toBe(3);
        expect(Number((await client.execute({sql:"SELECT count(*) AS n FROM governed_refinement_proposals WHERE proposal_id=?",args:[proposalId]})).rows[0]!.n)).toBe(1);
        expect(Number((await client.execute({sql:"SELECT count(*) AS n FROM refinement_restorations WHERE target_id=?",args:[session.sessionId]})).rows[0]!.n)).toBe(1);
      }finally{client.close();}
    }finally{await supervisor?.close();await rm(directory,{recursive:true,force:true});}
  });

  test("removes owned workspace database, modern replica sidecars, and owned artifacts with an external receipt",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"agencity-delete-workspace-"));let supervisor:Supervisor|undefined;
    const replica=join(directory,"replica.db"),receiptDirectory=join(directory,"receipts");
    try{
      const provider=new ApprovingGovernanceProvider("workspace-delete-governance");
      supervisor=await Supervisor.open({...options(directory),modelProviders:[provider],artifactDirectoryOwnership:"exclusive",sync:{workspaceId:"workspace",replicaUrl:`file:${replica}`,startup:false,intervalMs:0}});
      const session=await supervisor.createSession({workspaceId:"workspace",model:{provider:provider.name,model:"fixture"}});const evidence=await supervisor.appendMessage(session.sessionId,session.branchId,"user","Workspace deletion owns all governance history");const initial=await supervisor.agentProfiles.active(session.sessionId);
      const revised=await approveProfileRevision(supervisor,session.sessionId,session.branchId,"Temporary whole-workspace deletion revision.","workspace-delete-profile");
      await supervisor.refinementGovernance.rollbackOwner(session.sessionId,session.branchId,{targetKind:"agent_profile",targetId:session.sessionId,expectedCurrentVersionId:revised.profileVersionId,restoreVersionId:initial.profileVersionId,reason:"Exercise whole-workspace restoration deletion",evidenceEventIds:[evidence.id]});
      const artifact=await supervisor.artifacts.put("owned",{mediaType:"text/plain"});await supervisor.storage.appendEvents([{sessionId:session.sessionId,branchId:session.branchId,type:"ArtifactRegistered",producer:"supervisor",idempotencyKey:"owned-artifact",payload:artifact}]);
      const scratchClient=createClient({url:`file:${directory}/workspace.db`});try{const now=new Date().toISOString();await scratchClient.execute({sql:"INSERT INTO console_scratch_cache(session_id,branch_id,workspace_id,device_id,schema_version,checkpoint_json,content_digest,row_integrity_digest,checkpoint_byte_length,encoded_row_bytes,source_cell_id,source_event_id,source_cursor,saved_names_json,skipped_json,created_at,updated_at,accessed_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",args:[session.sessionId,session.branchId,"workspace",supervisor.device.deviceId,1,"{}","0".repeat(64),"1".repeat(64),2,512,"deletion-fixture","deletion-fixture-event",1,"[]","[]",now,now,now,new Date(Date.now()+60_000).toISOString()]});expect(Number((await scratchClient.execute("SELECT count(*) AS n FROM console_scratch_cache")).rows[0]!.n)).toBe(1);}finally{scratchClient.close();}
      for(const suffix of ["","-wal","-wal-revert","-changes","-info","-replace-base-apply","-replace-base-apply-main-db.backup"])await Bun.write(`${replica}${suffix}`,suffix||"replica");
      const engineLog=join(directory,"replica.db-log");await Bun.write(engineLog,"official engine log");
      await Bun.write(`${replica}-notes`,`unrelated sentinel`);await Bun.write(`${replica}-replace-base-apply-user.txt`,`unrelated patterned sentinel`);await Bun.write(`${replica}-replace-base-apply-generation.backup`,`unrelated backup sentinel`);await Bun.write(join(directory,"artifacts","unregistered-garbage"),"also owned by the exclusive CAS root");
      const receipt=await supervisor.deleteOwnedData({scopeKind:"workspace",scopeId:"workspace",requestedBy:"owner",confirmation:"DELETE workspace workspace",receiptDirectory});supervisor=undefined;
      expect(receipt.status).toBe("completed");expect(await exists(join(receiptDirectory,`${receipt.manifestId}.json`))).toBe(true);
      expect(await exists(join(directory,"workspace.db"))).toBe(false);for(const suffix of ["","-wal","-wal-revert","-changes","-info","-replace-base-apply","-replace-base-apply-main-db.backup"])expect(await exists(`${replica}${suffix}`)).toBe(false);
      expect(await exists(engineLog)).toBe(false);expect(await Bun.file(`${replica}-notes`).text()).toBe("unrelated sentinel");expect(await Bun.file(`${replica}-replace-base-apply-user.txt`).text()).toBe("unrelated patterned sentinel");expect(await Bun.file(`${replica}-replace-base-apply-generation.backup`).text()).toBe("unrelated backup sentinel");
      expect(await exists(join(directory,"artifacts"))).toBe(false);expect(receipt.removed.artifactFiles.some(path=>path.endsWith("unregistered-garbage"))).toBe(true);
      const profile=await ProfileStore.open(`file:${directory}/profile.db`);try{const tombstone=await profile.getWorkspace("workspace");expect(tombstone?.deletedAt).not.toBeNull();expect(tombstone).toMatchObject({name:"",databaseUrl:"",replicaUrl:null,syncUrl:null,credentialReference:null});}finally{profile.close();}
      for(let attempt=0;attempt<2;attempt++){await expect(Supervisor.open(options(directory))).rejects.toThrow("tombstoned");expect(await exists(join(directory,"workspace.db"))).toBe(false);expect(await exists(join(directory,"artifacts"))).toBe(false);}
    }finally{await supervisor?.close();await rm(directory,{recursive:true,force:true});}
  });

  test("physically erases the owned profile database while retaining the independently scoped workspace",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"agencity-delete-profile-"));let supervisor:Supervisor|undefined;
    try{
      supervisor=await Supervisor.open(options(directory));const profileId=supervisor.device.profileId;await supervisor.profile.setPreference("private.preference",{remove:true});await supervisor.credentials.set("openai","profile-owned-secret-123456");await supervisor.createSession({workspaceId:"workspace"});
      const receipt=await supervisor.deleteOwnedData({scopeKind:"profile",scopeId:profileId,requestedBy:"owner",confirmation:`DELETE profile ${profileId}`,receiptDirectory:join(directory,"receipts")});supervisor=undefined;
      expect(receipt.status).toBe("completed");expect(await exists(join(directory,"profile.db"))).toBe(false);expect(await exists(join(directory,"auth.json"))).toBe(false);expect(receipt.removed.credentialFiles).toContain(join(directory,"auth.json"));expect(await exists(join(directory,"workspace.db"))).toBe(true);expect(await exists(receipt.receiptPath!)).toBe(true);
    }finally{await supervisor?.close();await rm(directory,{recursive:true,force:true});}
  });

  test("uses a separately authenticated cloud-admin adapter before deleting a remote-managed workspace",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"agencity-delete-admin-"));let supervisor:Supervisor|undefined;const calls:any[]=[];
    try{
      supervisor=await Supervisor.open({...options(directory),artifactDirectoryOwnership:"exclusive",sync:{workspaceId:"workspace",syncUrl:"https://sync.example.invalid",transport:new DeterministicSyncHub().connect("admin"),remoteDeletionAdmin:{name:"test-cloud-admin",capabilities:{authenticatedAdministration:true,deleteWorkspaceReplica:true},async deleteWorkspaceReplica(input){calls.push(input);return{receiptId:"cloud-receipt-1",deletedAt:"2026-01-01T00:00:00.000Z"};}},startup:false,intervalMs:0}});await supervisor.createSession({workspaceId:"workspace"});
      const planned=await supervisor.sync.createManifest("delete","workspace","workspace","owner");expect(planned.status).toBe("planned");expect((planned.resources as any).remoteDeletionSupported).toBe(true);
      const receipt=await supervisor.deleteOwnedData({scopeKind:"workspace",scopeId:"workspace",requestedBy:"owner",confirmation:"DELETE workspace workspace",receiptDirectory:join(directory,"receipts")});supervisor=undefined;
      expect(calls).toHaveLength(1);expect(receipt.remoteAdminReceipt).toMatchObject({adapter:"test-cloud-admin",receiptId:"cloud-receipt-1"});expect(await exists(join(directory,"workspace.db"))).toBe(false);
    }finally{await supervisor?.close();await rm(directory,{recursive:true,force:true});}
  });

  test("refuses foreign ownership, remote-managed deletion without an admin adapter, and linked-session granularity",async()=>{
    const foreignDirectory=await mkdtemp(join(tmpdir(),"agencity-delete-foreign-"));let foreign:Supervisor|undefined;
    try{
      foreign=await Supervisor.open(options(foreignDirectory));const row=(await foreign.profile.getWorkspace("workspace"))!;await foreign.profile.putWorkspace({...row,ownerProfileId:"foreign-profile"});
      await expect(foreign.deleteOwnedData({scopeKind:"workspace",scopeId:"workspace",requestedBy:"intruder",confirmation:"DELETE workspace workspace",receiptDirectory:join(foreignDirectory,"receipts")})).rejects.toMatchObject({code:"VALIDATION_ERROR"});foreign=undefined;
      expect(await exists(join(foreignDirectory,"workspace.db"))).toBe(true);
    }finally{await foreign?.close();await rm(foreignDirectory,{recursive:true,force:true});}

    const remoteDirectory=await mkdtemp(join(tmpdir(),"agencity-delete-remote-"));let remote:Supervisor|undefined;
    try{
      remote=await Supervisor.open({...options(remoteDirectory),artifactDirectoryOwnership:"exclusive",sync:{workspaceId:"workspace",transport:new DeterministicSyncHub().connect("remote"),startup:false,intervalMs:0}});await remote.createSession({workspaceId:"workspace"});
      await expect(remote.deleteOwnedData({scopeKind:"workspace",scopeId:"workspace",requestedBy:"owner",confirmation:"DELETE workspace workspace",receiptDirectory:join(remoteDirectory,"receipts")})).rejects.toMatchObject({code:"CAPABILITY_UNAVAILABLE"});remote=undefined;
      const adminCalls:any[]=[];remote=await Supervisor.open({...options(remoteDirectory),artifactDirectoryOwnership:"exclusive",sync:{workspaceId:"workspace",remoteDeletionAdmin:{name:"admin",capabilities:{authenticatedAdministration:true,deleteWorkspaceReplica:true},async deleteWorkspaceReplica(input){adminCalls.push(input);return{receiptId:"should-not-run",deletedAt:new Date().toISOString()};}},startup:false,intervalMs:0}});
      await expect(remote.deleteOwnedData({scopeKind:"workspace",scopeId:"workspace",requestedBy:"owner",confirmation:"DELETE workspace workspace",receiptDirectory:join(remoteDirectory,"receipts")})).rejects.toMatchObject({code:"CAPABILITY_UNAVAILABLE"});remote=undefined;expect(adminCalls).toHaveLength(0);
      expect(await exists(join(remoteDirectory,"workspace.db"))).toBe(true);
    }finally{await remote?.close();await rm(remoteDirectory,{recursive:true,force:true});}

    const linkedDirectory=await mkdtemp(join(tmpdir(),"agencity-delete-linked-"));let linked:Supervisor|undefined;
    try{
      linked=await Supervisor.open(options(linkedDirectory));const session=await linked.createSession({workspaceId:"workspace"});await linked.agents.spawn(session.sessionId,session.branchId,{task:"linked child"});
      await expect(linked.deleteOwnedData({scopeKind:"session",scopeId:session.sessionId,requestedBy:"owner",confirmation:`DELETE session ${session.sessionId}`})).rejects.toMatchObject({code:"CAPABILITY_UNAVAILABLE"});linked=undefined;
      expect(await exists(join(linkedDirectory,"workspace.db"))).toBe(true);
    }finally{await linked?.close();await rm(linkedDirectory,{recursive:true,force:true});}

    const referencedDirectory=await mkdtemp(join(tmpdir(),"agencity-delete-referenced-"));let referenced:Supervisor|undefined;
    try{
      referenced=await Supervisor.open(options(referencedDirectory));const doomed=await referenced.createSession({workspaceId:"workspace"});const retained=await referenced.createSession({workspaceId:"workspace"});const anchor=await referenced.appendMessage(doomed.sessionId,doomed.branchId,"user","evidence must not dangle");
      const unique=await referenced.artifacts.put("must survive refusal",{mediaType:"text/plain"});await referenced.storage.appendEvents([{sessionId:doomed.sessionId,branchId:doomed.branchId,type:"ArtifactRegistered",producer:"supervisor",idempotencyKey:"refusal-artifact",payload:unique}]);
      await referenced.storage.appendEvents([{sessionId:retained.sessionId,branchId:retained.branchId,causationId:anchor.id,type:"MessageAppended",producer:"client",idempotencyKey:"retained-cross-reference",payload:{messageId:"retained-cross-reference",role:"user",content:"refers to selected evidence"}}]);
      await expect(referenced.deleteOwnedData({scopeKind:"session",scopeId:doomed.sessionId,requestedBy:"owner",confirmation:`DELETE session ${doomed.sessionId}`})).rejects.toMatchObject({code:"CAPABILITY_UNAVAILABLE"});
      expect(await exists(join(referencedDirectory,"artifacts",unique.digest.slice(0,2),unique.digest.slice(2)))).toBe(true);referenced=undefined;
      const client=createClient({url:`file:${referencedDirectory}/workspace.db`});try{expect(Number((await client.execute({sql:"SELECT count(*) AS n FROM events WHERE session_id=?",args:[doomed.sessionId]})).rows[0]!.n)).toBeGreaterThan(0);}finally{client.close();}
    }finally{await referenced?.close();await rm(referencedDirectory,{recursive:true,force:true});}

    const sharedDirectory=await mkdtemp(join(tmpdir(),"agencity-delete-shared-cas-"));let shared:Supervisor|undefined;
    try{
      shared=await Supervisor.open(options(sharedDirectory));await shared.createSession({workspaceId:"workspace"});
      await expect(shared.deleteOwnedData({scopeKind:"workspace",scopeId:"workspace",requestedBy:"owner",confirmation:"DELETE workspace workspace",receiptDirectory:join(sharedDirectory,"receipts")})).rejects.toMatchObject({code:"CAPABILITY_UNAVAILABLE"});shared=undefined;
      expect(await exists(join(sharedDirectory,"workspace.db"))).toBe(true);
    }finally{await shared?.close();await rm(sharedDirectory,{recursive:true,force:true});}
  });

  test("retains durable remote evidence across an unconfigured reopen and blocks every destructive scope",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"agencity-delete-durable-evidence-"));let supervisor:Supervisor|undefined;
    const replica=join(directory,"workspace.db.sync-replica.db"),syncUrl="https://prior-sync.example.invalid";
    try{
      supervisor=await Supervisor.open({...options(directory),artifactDirectoryOwnership:"exclusive",sync:{workspaceId:"workspace",syncUrl,transport:new DeterministicSyncHub().connect("prior-in-process"),startup:false,intervalMs:0}});
      const session=await supervisor.createSession({workspaceId:"workspace"});await supervisor.appendMessage(session.sessionId,session.branchId,"user","durable data");await supervisor.sync.sync("manual");
      await Bun.write(replica,"known local replica");await supervisor.close();supervisor=undefined;

      supervisor=await Supervisor.open({...options(directory),artifactDirectoryOwnership:"exclusive"});
      const catalog=(await supervisor.profile.getWorkspace("workspace"))!;
      expect(catalog.syncUrl).toBe(syncUrl);expect(catalog.replicaUrl).toBe(`file:${replica}`);
      const statuses=await (supervisor.storage as any).listReplicaStatuses("workspace");expect(statuses.length).toBeGreaterThanOrEqual(2);expect(statuses.some((row:any)=>row.syncUrl===syncUrl&&row.replicaUrl===`file:${replica}`)).toBe(true);
      expect((await supervisor.sync.createManifest("delete","session",session.sessionId,"owner")).status).toBe("blocked");
      expect((await supervisor.sync.createManifest("delete","profile",supervisor.device.profileId,"owner")).status).toBe("blocked");
      await expect(supervisor.deleteOwnedData({scopeKind:"workspace",scopeId:"workspace",requestedBy:"owner",confirmation:"DELETE workspace workspace",receiptDirectory:join(directory,"receipts")})).rejects.toMatchObject({code:"CAPABILITY_UNAVAILABLE"});supervisor=undefined;
      expect(await exists(join(directory,"workspace.db"))).toBe(true);expect(await exists(replica)).toBe(true);
      const client=createClient({url:`file:${directory}/workspace.db`});try{const manifests=await client.execute("SELECT status FROM data_manifests WHERE operation='delete'");expect(manifests.rows.some(row=>String(row.status)==="completed")).toBe(false);}finally{client.close();}
    }finally{await supervisor?.close();await rm(directory,{recursive:true,force:true});}
  });

  test("retries partial workspace filesystem deletion with stable multi-replica admin idempotency and accurate receipts",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"agencity-delete-retry-"));let supervisor:Supervisor|undefined;
    const hub=new DeterministicSyncHub(),replica=join(directory,"replica.db"),casParent=join(directory,"cas"),artifactDirectory=join(casParent,"artifacts"),receiptDirectory=join(directory,"receipts");
    const urls=["https://one.example.invalid","https://two.example.invalid"];const calls:Array<{syncUrl:string;idempotencyKey:string}>=[];
    const admin={name:"retry-admin",capabilities:{authenticatedAdministration:true as const,deleteWorkspaceReplica:true},async deleteWorkspaceReplica(input:any){calls.push({syncUrl:input.syncUrl,idempotencyKey:input.idempotencyKey});return{receiptId:`receipt-${input.syncUrl}`,deletedAt:"2026-01-01T00:00:00.000Z"};}};
    try{
      supervisor=await Supervisor.open({...options(directory),artifactDirectory,artifactDirectoryOwnership:"exclusive",sync:{workspaceId:"workspace",syncUrl:urls[0]!,replicaUrl:`file:${replica}`,transport:hub.connect("replica-one"),startup:false,intervalMs:0}});
      const session=await supervisor.createSession({workspaceId:"workspace"});await supervisor.appendMessage(session.sessionId,session.branchId,"user","retain through partial deletion");await supervisor.sync.sync();await supervisor.close();supervisor=undefined;
      supervisor=await Supervisor.open({...options(directory),artifactDirectory,artifactDirectoryOwnership:"exclusive",sync:{workspaceId:"workspace",syncUrl:urls[1]!,replicaUrl:`file:${replica}`,transport:hub.connect("replica-two"),startup:false,intervalMs:0}});
      const artifact=await supervisor.artifacts.put("partially removable CAS",{mediaType:"text/plain"});await supervisor.storage.appendEvents([{sessionId:session.sessionId,branchId:session.branchId,type:"ArtifactRegistered",producer:"supervisor",idempotencyKey:"partial-cas",payload:artifact}]);await supervisor.sync.sync();await supervisor.close();supervisor=undefined;
      await Bun.write(replica,"replica");await chmod(casParent,0o500);

      supervisor=await Supervisor.open({...options(directory),artifactDirectory,artifactDirectoryOwnership:"exclusive",sync:{workspaceId:"workspace",remoteDeletionAdmin:admin,startup:false,intervalMs:0}});
      await expect(supervisor.deleteOwnedData({scopeKind:"workspace",scopeId:"workspace",requestedBy:"owner",confirmation:"DELETE workspace workspace",receiptDirectory})).rejects.toThrow();supervisor=undefined;
      const [partialName]=(await readdir(receiptDirectory)).filter(name=>name.endsWith(".json"));const partial=JSON.parse(await Bun.file(join(receiptDirectory,partialName!)).text());expect(partial.status).toBe("partial");
      for(const kind of ["databaseFiles","replicaFiles","artifactFiles"] as const)for(const path of partial.removed[kind])expect(await exists(path)).toBe(false);
      const artifactPath=join(artifactDirectory,artifact.digest.slice(0,2),artifact.digest.slice(2));expect(partial.removed.artifactFiles.includes(artifactPath)).toBe(!(await exists(artifactPath)));
      const profile=await ProfileStore.open(`file:${directory}/profile.db`);try{expect((await profile.getWorkspace("workspace"))?.deletedAt).toBeNull();}finally{profile.close();}
      expect(await exists(join(directory,"workspace.db"))).toBe(true);expect(calls.map(call=>call.syncUrl).sort()).toEqual(urls);

      await chmod(casParent,0o700);
      supervisor=await Supervisor.open({...options(directory),artifactDirectory,artifactDirectoryOwnership:"exclusive",sync:{workspaceId:"workspace",remoteDeletionAdmin:admin,startup:false,intervalMs:0}});
      const completed=await supervisor.deleteOwnedData({scopeKind:"workspace",scopeId:"workspace",requestedBy:"owner",confirmation:"DELETE workspace workspace",receiptDirectory});supervisor=undefined;
      expect(completed.status).toBe("completed");expect(completed.remoteAdminReceipts.map(row=>row.syncUrl).sort()).toEqual(urls);
      for(const url of urls){const keys=calls.filter(call=>call.syncUrl===url).map(call=>call.idempotencyKey);expect(keys).toHaveLength(2);expect(new Set(keys).size).toBe(1);}
      expect(await exists(join(directory,"workspace.db"))).toBe(false);
    }finally{await chmod(casParent,0o700).catch(()=>{});await supervisor?.close();await rm(directory,{recursive:true,force:true});}
  });

  test("preflights session links, reports only removed CAS paths on failure, and permits a retry",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"agencity-delete-session-retry-"));let supervisor:Supervisor|undefined;let prefix:string|undefined;
    const receiptDirectory=join(directory,"receipts");
    try{
      supervisor=await Supervisor.open(options(directory));const session=await supervisor.createSession({workspaceId:"workspace"});const artifact=await supervisor.artifacts.put("retry CAS",{mediaType:"text/plain"});await supervisor.storage.appendEvents([{sessionId:session.sessionId,branchId:session.branchId,type:"ArtifactRegistered",producer:"supervisor",idempotencyKey:"retry-cas",payload:artifact}]);
      const artifactPath=join(directory,"artifacts",artifact.digest.slice(0,2),artifact.digest.slice(2));prefix=join(directory,"artifacts",artifact.digest.slice(0,2));await chmod(prefix,0o500);
      await expect(supervisor.deleteOwnedData({scopeKind:"session",scopeId:session.sessionId,requestedBy:"owner",confirmation:`DELETE session ${session.sessionId}`,receiptDirectory})).rejects.toThrow();supervisor=undefined;
      const [partialName]=(await readdir(receiptDirectory)).filter(name=>name.endsWith(".json"));const partial=JSON.parse(await Bun.file(join(receiptDirectory,partialName!)).text());expect(partial.status).toBe("partial");expect(partial.removed.artifactFiles.includes(artifactPath)).toBe(!(await exists(artifactPath)));
      const client=createClient({url:`file:${directory}/workspace.db`});try{expect(Number((await client.execute({sql:"SELECT count(*) AS n FROM events WHERE session_id=?",args:[session.sessionId]})).rows[0]!.n)).toBeGreaterThan(0);}finally{client.close();}
      await chmod(prefix,0o700);supervisor=await Supervisor.open(options(directory));const completed=await supervisor.deleteOwnedData({scopeKind:"session",scopeId:session.sessionId,requestedBy:"owner",confirmation:`DELETE session ${session.sessionId}`,receiptDirectory});supervisor=undefined;expect(completed.status).toBe("completed");
      const check=createClient({url:`file:${directory}/workspace.db`});try{expect(Number((await check.execute({sql:"SELECT count(*) AS n FROM events WHERE session_id=?",args:[session.sessionId]})).rows[0]!.n)).toBe(0);}finally{check.close();}
    }finally{if(prefix)await chmod(prefix,0o700).catch(()=>{});await supervisor?.close();await rm(directory,{recursive:true,force:true});}
  });

  test("blocks hidden quarantine references and cleans selected-session quarantine rows",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"agencity-delete-quarantine-"));let supervisor:Supervisor|undefined;
    try{
      supervisor=await Supervisor.open(options(directory));const doomed=await supervisor.createSession({workspaceId:"workspace"});const retained=await supervisor.createSession({workspaceId:"workspace"});
      const client=createClient({url:`file:${directory}/workspace.db`});try{
        const now=new Date().toISOString();
        await client.execute({sql:"INSERT INTO sync_quarantine(envelope_id,workspace_id,origin_device_id,origin_sequence,reason_code,reason,envelope_json,digest,status,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",args:["owned-quarantine","workspace",null,null,"invalid","selected",JSON.stringify({body:{sessionId:doomed.sessionId}}),null,"quarantined",now,now]});
        await client.execute({sql:"INSERT INTO sync_quarantine(envelope_id,workspace_id,origin_device_id,origin_sequence,reason_code,reason,envelope_json,digest,status,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",args:["hidden-quarantine","workspace",null,null,"invalid","retained mentions selected",JSON.stringify({body:{sessionId:retained.sessionId},metadata:{targetSessionId:doomed.sessionId}}),null,"quarantined",now,now]});
      }finally{client.close();}
      await expect(supervisor.deleteOwnedData({scopeKind:"session",scopeId:doomed.sessionId,requestedBy:"owner",confirmation:`DELETE session ${doomed.sessionId}`})).rejects.toMatchObject({code:"CAPABILITY_UNAVAILABLE"});supervisor=undefined;
      const cleanup=createClient({url:`file:${directory}/workspace.db`});try{await cleanup.execute("DELETE FROM sync_quarantine WHERE envelope_id='hidden-quarantine'");}finally{cleanup.close();}
      supervisor=await Supervisor.open(options(directory));const receipt=await supervisor.deleteOwnedData({scopeKind:"session",scopeId:doomed.sessionId,requestedBy:"owner",confirmation:`DELETE session ${doomed.sessionId}`});supervisor=undefined;expect(receipt.removed.rows.sync_quarantine).toBe(1);
      const check=createClient({url:`file:${directory}/workspace.db`});try{expect(Number((await check.execute("SELECT count(*) AS n FROM sync_quarantine WHERE envelope_id='owned-quarantine'")).rows[0]!.n)).toBe(0);}finally{check.close();}
    }finally{await supervisor?.close();await rm(directory,{recursive:true,force:true});}
  });

  test("derives and removes the historical adjacent replica when migration-005 lacks replica_url",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"agencity-delete-legacy-replica-"));let supervisor:Supervisor|undefined;const calls:any[]=[];
    const syncUrl="https://legacy.example.invalid",replica=join(directory,"workspace.db.sync-replica.db"),transportId=`turso:${syncUrl}`;
    const admin={name:"legacy-admin",capabilities:{authenticatedAdministration:true as const,deleteWorkspaceReplica:true},async deleteWorkspaceReplica(input:any){calls.push(input);return{receiptId:"legacy-deleted",deletedAt:"2026-01-01T00:00:00.000Z"};}};
    try{
      supervisor=await Supervisor.open({...options(directory),artifactDirectoryOwnership:"exclusive",sync:{workspaceId:"workspace",syncUrl,transport:new DeterministicSyncHub().connect(transportId),startup:false,intervalMs:0}});await supervisor.createSession({workspaceId:"workspace"});await supervisor.close();supervisor=undefined;
      await Bun.write(replica,"legacy replica");await Bun.write(`${replica}-info`,"metadata");
      const workspace=createClient({url:`file:${directory}/workspace.db`});try{await workspace.execute("UPDATE workspace_replica_status SET replica_url=NULL");}finally{workspace.close();}
      const profile=await ProfileStore.open(`file:${directory}/profile.db`);try{const row=(await profile.getWorkspace("workspace"))!;await profile.putWorkspace({...row,replicaUrl:transportId,syncUrl:null});}finally{profile.close();}
      supervisor=await Supervisor.open({...options(directory),artifactDirectoryOwnership:"exclusive",sync:{workspaceId:"workspace",remoteDeletionAdmin:admin,startup:false,intervalMs:0}});
      const manifest=await supervisor.sync.createManifest("delete","workspace","workspace","owner");expect((manifest.resources as any).replicaFiles).toContain(replica);expect(manifest.status).toBe("planned");
      const receipt=await supervisor.deleteOwnedData({scopeKind:"workspace",scopeId:"workspace",requestedBy:"owner",confirmation:"DELETE workspace workspace",receiptDirectory:join(directory,"receipts")});supervisor=undefined;
      expect(receipt.status).toBe("completed");expect(calls).toHaveLength(1);expect(await exists(replica)).toBe(false);expect(await exists(`${replica}-info`)).toBe(false);
    }finally{await supervisor?.close();await rm(directory,{recursive:true,force:true});}
  });

  test("refuses deletion while an outbox effect is running",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"agencity-delete-outbox-"));let supervisor:Supervisor|undefined;
    try{
      supervisor=await Supervisor.open(options(directory));const session=await supervisor.createSession({workspaceId:"workspace"});const effectId=await supervisor.outbox.request({sessionId:session.sessionId,branchId:session.branchId,executor:"shell",operation:"run",input:{command:"sleep 0.4"},origin:{kind:"runtime",requestId:"slow-delete-race"},idempotencyKey:"slow-delete-race",idempotent:true});const running=supervisor.outbox.run(effectId);
      for(let attempt=0;attempt<100&&(await supervisor.storage.getOutbox(effectId))?.status!=="running";attempt++)await Bun.sleep(5);
      await expect(supervisor.deleteOwnedData({scopeKind:"session",scopeId:session.sessionId,requestedBy:"owner",confirmation:`DELETE session ${session.sessionId}`})).rejects.toThrow("outbox effects are running");
      await running;const receipt=await supervisor.deleteOwnedData({scopeKind:"session",scopeId:session.sessionId,requestedBy:"owner",confirmation:`DELETE session ${session.sessionId}`});supervisor=undefined;expect(receipt.status).toBe("completed");
    }finally{await supervisor?.close();await rm(directory,{recursive:true,force:true});}
  });
});

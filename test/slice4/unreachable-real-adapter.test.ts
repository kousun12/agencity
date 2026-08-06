import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Supervisor } from "../../src/index.ts";

test("official Turso Sync adapter first launch stays locally usable when Cloud is unreachable and no credentials exist",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"agencity-real-offline-"));let supervisor:Supervisor|undefined;
  try{
    supervisor=await Supervisor.open({databaseUrl:`file:${directory}/workspace.db`,profileDatabaseUrl:`file:${directory}/profile.db`,artifactDirectory:join(directory,"artifacts"),workspaceRoot:directory,recover:false,sync:{workspaceId:"offline-workspace",replicaUrl:`file:${directory}/replica.db`,syncUrl:"http://127.0.0.1:1",intervalMs:0}});
    const failed=await supervisor.sync.status();expect(failed.replica.lifecycle).toBe("error");expect(failed.replica.lastSuccessAt).toBeNull();expect(failed.replica.lastError).not.toBeNull();expect(failed.capabilities.directionalNetworkPush).toBe(true);expect(failed.capabilities.directionalNetworkPull).toBe(true);expect(failed.capabilities.networkCheckpoint).toBe(true);expect(failed.capabilities.networkStats).toBe(true);
    const session=await supervisor.createSession({workspaceId:"offline-workspace"});const message=await supervisor.appendMessage(session.sessionId,session.branchId,"user","offline remains local");const cell=await supervisor.executeCell(session.sessionId,session.branchId,"return { usable: true }");expect((cell.result as any).usable).toBe(true);expect((await supervisor.storage.loadEvents(session.sessionId)).map(event=>event.id)).toContain(message.id);expect(await supervisor.sync.stage()).toBeGreaterThan(0);
    await expect(supervisor.sync.reconnect()).rejects.toThrow();const retried=await supervisor.sync.status();expect(retried.replica.lifecycle).toBe("error");expect(retried.replica.lastError).not.toBeNull();expect((await supervisor.storage.loadEvents(session.sessionId)).some(event=>event.type==="CellCommitted")).toBe(true);
  }finally{await supervisor?.close();await rm(directory,{recursive:true,force:true});}
});


test("a replaced modern replica incarnation invalidates the staging frontier and restages local history",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"agencity-replica-incarnation-"));let supervisor:Supervisor|undefined;
  const open=()=>Supervisor.open({databaseUrl:`file:${directory}/workspace.db`,profileDatabaseUrl:`file:${directory}/profile.db`,artifactDirectory:join(directory,"artifacts"),workspaceRoot:directory,recover:false,sync:{workspaceId:"offline-workspace",replicaUrl:`file:${directory}/replica.db`,syncUrl:"http://127.0.0.1:1",startup:false,intervalMs:0}});
  try{
    supervisor=await open();const session=await supervisor.createSession({workspaceId:"offline-workspace"});await supervisor.appendMessage(session.sessionId,session.branchId,"user","must be restaged");expect(await supervisor.sync.stage()).toBe(2);const first=(await supervisor.sync.status()).replica.replicaIncarnation;expect(first).not.toBeNull();await supervisor.close();supervisor=undefined;
    for(const name of await readdir(directory))if(name.startsWith("replica.db"))await rm(join(directory,name),{recursive:true,force:true});
    supervisor=await open();const second=(await supervisor.sync.status()).replica.replicaIncarnation;expect(second).not.toBe(first);expect(await supervisor.sync.stage()).toBe(2);
  }finally{await supervisor?.close();await rm(directory,{recursive:true,force:true});}
});

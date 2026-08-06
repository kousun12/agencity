import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Supervisor, TursoSyncTransport } from "../../src/index.ts";

const binary=process.env.TURSO_SYNC_SERVER_BIN;

async function unusedPort():Promise<number>{const server=createServer();await new Promise<void>((resolve,reject)=>server.once("error",reject).listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("Failed to allocate sync-server port");await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return address.port;}
async function waitForServer(url:string,process:ChildProcess,logs:()=>string):Promise<void>{for(let attempt=0;attempt<100;attempt++){if(process.exitCode!==null)throw new Error(`tursodb exited before readiness (${process.exitCode}): ${logs()}`);try{const response=await fetch(url);if(response.status===404)return;}catch{}await Bun.sleep(50);}throw new Error(`Timed out waiting for tursodb sync server: ${logs()}`);}
async function stopProcess(process:ChildProcess):Promise<void>{if(process.exitCode!==null)return;process.kill("SIGTERM");await Promise.race([new Promise<void>(resolve=>process.once("exit",()=>resolve())),Bun.sleep(2_000)]);if(process.exitCode===null)process.kill("SIGKILL");}

function configuration(directory:string,name:string,syncUrl:string,transport:TursoSyncTransport){return{databaseUrl:`file:${directory}/${name}/workspace.db`,profileDatabaseUrl:`file:${directory}/${name}/profile.db`,artifactDirectory:join(directory,name,"artifacts"),artifactDirectoryOwnership:"exclusive" as const,workspaceRoot:join(directory,name),recover:false,sync:{workspaceId:"official-workspace",workspaceName:"Official server conformance",syncUrl,replicaUrl:`file:${directory}/${name}/replica.db`,transport,startup:false,intervalMs:0}};}

test.skipIf(!binary)("official tursodb 0.7.2 sync-server preserves concurrent envelopes and conflict surfaces",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"agencity-official-sync-"));const port=await unusedPort();const syncUrl=`http://127.0.0.1:${port}`;let output="";let server:ChildProcess|undefined;let a:Supervisor|undefined,b:Supervisor|undefined;
  try{
    const version=new TextDecoder().decode(Bun.spawnSync([binary!,"--version"]).stdout);expect(version.trim()).toBe("Turso 0.7.2");
    const process=spawn(binary!,[join(directory,"server.db"),"--sync-server",`127.0.0.1:${port}`],{stdio:["ignore","pipe","pipe"]});server=process;process.stdout?.on("data",chunk=>{output+=String(chunk)});process.stderr?.on("data",chunk=>{output+=String(chunk)});await waitForServer(syncUrl,process,()=>output);
    const transportA=new TursoSyncTransport({path:join(directory,"a","replica.db"),syncUrl,id:"official-a"});const transportB=new TursoSyncTransport({path:join(directory,"b","replica.db"),syncUrl,id:"official-b"});
    a=await Supervisor.open(configuration(directory,"a",syncUrl,transportA));const session=await a.createSession({workspaceId:"official-workspace"});await a.sync.sync();
    b=await Supervisor.open(configuration(directory,"b",syncUrl,transportB));await b.sync.sync();await a.sync.sync();expect(await b.storage.getSession?.(session.sessionId)).not.toBeNull();
    const task=await a.agents.spawn(session.sessionId,session.branchId,{task:"surface concurrent claims"});await a.sync.sync();await b.sync.sync();await a.sync.sync();expect(await b.storage.getTask?.(task.taskId)).not.toBeNull();

    // Both supervisors are now offline in the product sense: all four writes
    // commit to local workspace databases before either transport is invoked.
    await Promise.all([
      a.appendMessage(session.sessionId,session.branchId,"user","offline conversation from A"),
      b.appendMessage(session.sessionId,session.branchId,"user","offline conversation from B"),
      a.storage.appendEvents([{sessionId:session.sessionId,branchId:session.branchId,type:"TaskStatusChanged",producer:"scheduler",idempotencyKey:"official-claim-a",payload:{taskId:task.taskId,status:"running"}}]),
      b.storage.appendEvents([{sessionId:session.sessionId,branchId:session.branchId,type:"TaskStatusChanged",producer:"scheduler",idempotencyKey:"official-claim-b",payload:{taskId:task.taskId,status:"running"}}]),
    ]);
    const expectedIds=new Set([...(await a.storage.loadEvents(session.sessionId)).map(event=>event.id),...(await b.storage.loadEvents(session.sessionId)).map(event=>event.id)]);

    await Promise.all([a.sync.reconnect(),b.sync.reconnect()]);
    for(let pass=0;pass<4;pass++){await a.sync.sync();await b.sync.sync();}
    for(const replica of [a,b]){
      for(const id of expectedIds)expect(await replica.storage.getEvent(id)).not.toBeNull();
      const histories=await Promise.all((await replica.storage.listBranches()).filter(row=>row.sessionId===session.sessionId).map(row=>replica.storage.loadEvents(row.sessionId,{branchId:row.branchId})));
      const messages=histories.flatMap(events=>events.filter(event=>event.type==="MessageAppended").map(event=>(event.payload as any).content));expect(messages).toContain("offline conversation from A");expect(messages).toContain("offline conversation from B");
      const conflict=(await replica.sync.conflicts("unresolved")).find(row=>row.kind==="task_claim");expect(conflict).toBeDefined();expect(conflict!.originDeviceIds).toHaveLength(2);expect((conflict!.details as any).policy).toBe("no automatic winner");
      const status=await replica.sync.status();expect(status.replica.lifecycle).toBe("online");expect(status.replica.lastSuccessAt).not.toBeNull();expect(status.replica.lastStats?.revision).not.toBeNull();expect((status.replica.lastStats?.networkSentBytes??0)+(status.replica.lastStats?.networkReceivedBytes??0)).toBeGreaterThan(0);
    }
    const envelopesA=await transportA.listEnvelopes("official-workspace"),envelopesB=await transportB.listEnvelopes("official-workspace");expect(envelopesA.map(row=>row.envelopeId).sort()).toEqual(envelopesB.map(row=>row.envelopeId).sort());const replicatedEntityIds=new Set(envelopesA.map(row=>row.entityId));for(const id of expectedIds)expect(replicatedEntityIds.has(id)).toBe(true);
    const beforeReconnect=await a.sync.stats();const reconnected=await a.sync.reconnect();expect(reconnected.status.lifecycle).toBe("online");const afterReconnect=(await a.sync.status()).replica.lastStats!;expect(afterReconnect.revision).not.toBeNull();expect(afterReconnect.networkSentBytes+afterReconnect.networkReceivedBytes).toBeGreaterThanOrEqual(beforeReconnect.networkSentBytes+beforeReconnect.networkReceivedBytes);
  }finally{await a?.close().catch(()=>{});await b?.close().catch(()=>{});if(server)await stopProcess(server);await rm(directory,{recursive:true,force:true});}
},90_000);

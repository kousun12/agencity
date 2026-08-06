import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentClient, ProtocolServer, Supervisor } from "../../src/index.ts";

test("compaction is an immutable source-linked derivation and never replaces retained messages",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"agencity-compaction-"));let supervisor:Supervisor|undefined;let protocol:ProtocolServer|undefined;
  try{
    supervisor=await Supervisor.open({databaseUrl:`file:${directory}/workspace.db`,profileDatabaseUrl:`file:${directory}/profile.db`,artifactDirectory:join(directory,"artifacts"),workspaceRoot:directory,recover:false,sync:{workspaceId:"workspace",startup:false,intervalMs:0}});const session=await supervisor.createSession({workspaceId:"workspace"});
    for(let index=0;index<23;index++)await supervisor.appendMessage(session.sessionId,session.branchId,"user",`message-${index}`);
    const before=(await supervisor.storage.loadEvents(session.sessionId,{branchId:session.branchId})).filter(event=>event.type==="MessageAppended");protocol=new ProtocolServer(supervisor);const server=protocol.listen();const client=new AgentClient(`http://${server.hostname}:${server.port}`);const compacted=await client.compact(session.sessionId,session.branchId);
    expect(compacted.sourceEventIds).toEqual(before.slice(0,3).map(event=>event.id));expect(compacted.summary).toContain("message-0");
    const after=await supervisor.storage.loadEvents(session.sessionId,{branchId:session.branchId});expect(after.filter(event=>event.type==="MessageAppended").map(event=>event.id)).toEqual(before.map(event=>event.id));
    const derived=after.find(event=>event.type==="ContextMaterialized"&&(event.payload as any).context?.kind==="compaction");expect((derived?.payload as any).records.map((record:any)=>record.eventId)).toEqual(compacted.sourceEventIds);
    const materialized=await supervisor.contexts.materialize(session.sessionId,session.branchId);expect((materialized.context as any).compactions[0].sourceEventIds).toEqual(compacted.sourceEventIds);
    const resumed=await client.resume(session.sessionId,session.branchId);expect(resumed.cursor).toBe((await supervisor.storage.getLatestCursor(session.sessionId,session.branchId))!);expect((await supervisor.storage.loadEvents(session.sessionId,{branchId:session.branchId})).filter(event=>event.type==="MessageAppended")).toHaveLength(23);
  }finally{protocol?.stop();await supervisor?.close();await rm(directory,{recursive:true,force:true});}
});

import { afterEach, describe, expect, test } from "bun:test";
import { DeterministicSyncHub, EVENT_SCHEMA_VERSION, envelopeDigest, replicatedEnvelopeId, TursoSyncTransport, type ReplicatedEnvelope } from "../../src/index.ts";
import { closeAll, makeRoot, openReplica, seedBoth, type Replica } from "./helpers.ts";
import { fixtureAgentProfile } from "../helpers.ts";

let root:string;let a:Replica|undefined,b:Replica|undefined;
afterEach(async()=>{if(root)await closeAll(root,a,b);a=b=undefined;});

function rootEnvelope(originDeviceId:string,content:string):ReplicatedEnvelope{
  const createdAt=originDeviceId==="device-a"?"2026-01-01T00:00:00.000Z":"2026-01-01T00:00:01.000Z";
  const body={id:"colliding-event",sessionId:"colliding-session",branchId:"colliding-branch",causationId:null,correlationId:null,type:"SessionCreated" as const,schemaVersion:EVENT_SCHEMA_VERSION,committedAt:createdAt,producer:"supervisor",idempotencyKey:`session:${originDeviceId}`,payload:{workspaceId:"workspace",initialBranchId:"colliding-branch",model:{provider:"echo",model:content,reasoningEffort:"provider-default" as const},budget:{},agentProfile:JSON.parse(JSON.stringify(fixtureAgentProfile("colliding-session")))},streamParentId:null};
  const identity={workspaceId:"workspace",originDeviceId,originSequence:1,entityKind:"event" as const,entityId:body.id,dependencies:[],body};const envelopeId=replicatedEnvelopeId(identity);
  const without={protocolVersion:1 as const,envelopeId,...identity,createdAt};return{...without,digest:envelopeDigest(without)};
}

describe("Slice 4 independent-review reconciliation and incrementality",()=>{
  test("the real local replica schema retains logical event-ID collisions without a network call",async()=>{
    root=await makeRoot();const transport=new TursoSyncTransport({replicaUrl:`file:${root}/physical-replica.db`,syncUrl:"http://127.0.0.1:1"});try{await transport.initialize();const rows=[rootEnvelope("device-a","one"),rootEnvelope("device-b","two")];expect(await transport.putEnvelopes(rows)).toBe(2);expect((await transport.listEnvelopes("workspace")).map(row=>row.envelopeId).sort()).toEqual(rows.map(row=>row.envelopeId).sort());}finally{await transport.close();}
  });

  test("deferred initialization is network-free and a failed official pull retains local CDC and rows",async()=>{
    root=await makeRoot();let requests=0;const transport=new TursoSyncTransport({replicaUrl:`file:${root}/deferred-replica.db`,syncUrl:"https://unreachable.invalid",fetch:(async()=>{requests++;throw new Error("deliberately unreachable");}) as unknown as typeof fetch});
    try{await transport.initialize();await transport.replicaIncarnation();const row=rootEnvelope("device-a","offline");expect(await transport.putEnvelopes([row])).toBe(1);expect(requests).toBe(0);const before=await transport.stats();expect(before.cdcOperations).toBeGreaterThan(0);await expect(transport.pull()).rejects.toThrow();expect(requests).toBeGreaterThan(0);expect((await transport.listEnvelopes("workspace")).map(value=>value.envelopeId)).toEqual([row.envelopeId]);expect((await transport.stats()).cdcOperations).toBe(before.cdcOperations);await transport.checkpoint();}finally{await transport.close();}
  });

  test("preserves colliding raw event claims, compares content, and leaves divergence unresolved",async()=>{
    root=await makeRoot();const hub=new DeterministicSyncHub();a=await openReplica(root,"a",hub);const first=rootEnvelope("device-a","one");const second=rootEnvelope("device-b","two");
    expect(first.envelopeId).not.toBe(second.envelopeId);expect(await a.transport.putEnvelopes([first,second])).toBe(2);expect(await a.transport.listEnvelopes("workspace")).toHaveLength(2);
    const result=await a.supervisor.sync.ingest();expect(result.ingested).toBe(1);expect(result.quarantined).toBe(1);expect(await a.supervisor.storage.getEvent("colliding-event")).not.toBeNull();expect(await a.transport.listEnvelopes("workspace")).toHaveLength(2);
    const conflict=(await a.supervisor.sync.conflicts("unresolved")).find(row=>row.kind==="duplicate_event");expect(conflict).toBeDefined();expect((conflict!.details as any).sameContent).toBe(false);expect((conflict!.details as any).retainedClaimDigest).not.toBe((conflict!.details as any).incomingClaimDigest);
    const quarantine=(await (a.supervisor.storage as any).listSyncQuarantine()).find((row:any)=>row.envelopeId===second.envelopeId);expect(quarantine?.reasonCode).toBe("DIVERGENT_DUPLICATE_EVENT");
  });

  test("persists staging and ingest frontiers across restart and incrementally catches up",async()=>{
    root=await makeRoot();const hub=new DeterministicSyncHub();a=await openReplica(root,"a",hub);const session=await a.supervisor.createSession({workspaceId:"workspace"});await a.supervisor.appendMessage(session.sessionId,session.branchId,"user","before restart");await a.supervisor.sync.sync();
    const before=await (a.supervisor.storage as any).listSyncOriginWatermarks(a.supervisor.sync.replicaId);const ownBefore=before.find((row:any)=>row.originDeviceId===a!.supervisor.device.deviceId);expect(ownBefore.stagedSequence).toBeGreaterThan(0);expect(ownBefore.ingestedSequence).toBeGreaterThan(0);const deviceId=a.supervisor.device.deviceId;
    await a.supervisor.close();a=undefined;a=await openReplica(root,"a",hub);expect(a.supervisor.device.deviceId).toBe(deviceId);expect(await a.supervisor.sync.stage()).toBeGreaterThan(0);
    await a.supervisor.appendMessage(session.sessionId,session.branchId,"user","after restart");expect(await a.supervisor.sync.stage()).toBe(1);await a.supervisor.sync.sync();b=await openReplica(root,"b",hub);await b.supervisor.sync.sync();expect((await b.supervisor.storage.loadEvents(session.sessionId)).some(event=>(event.payload as any).content==="after restart")).toBe(true);
    const after=await (a.supervisor.storage as any).listSyncOriginWatermarks(a.supervisor.sync.replicaId);expect(after.find((row:any)=>row.originDeviceId===deviceId).stagedSequence).toBeGreaterThan(ownBefore.stagedSequence);
  });

  test("uses a symmetric divergence identity and applies a replicated resolution",async()=>{
    root=await makeRoot();const hub=new DeterministicSyncHub();a=await openReplica(root,"a",hub);b=await openReplica(root,"b",hub);const session=await seedBoth(a,b);
    for(const text of ["a-one","a-two"])await a.supervisor.appendMessage(session.sessionId,session.branchId,"user",text);for(const text of ["b-one","b-two"])await b.supervisor.appendMessage(session.sessionId,session.branchId,"user",text);
    await Promise.all([a.supervisor.sync.sync(),b.supervisor.sync.sync()]);await Promise.all([a.supervisor.sync.sync(),b.supervisor.sync.sync()]);const ca=(await a.supervisor.sync.conflicts("unresolved")).find(row=>row.kind==="divergent_session")!;const cb=(await b.supervisor.sync.conflicts("unresolved")).find(row=>row.kind==="divergent_session")!;expect(ca.conflictId).toBe(cb.conflictId);
    await a.supervisor.sync.resolveConflict(ca.conflictId,{action:"keep-branches",resolvedBy:"owner"});await a.supervisor.sync.sync();await b.supervisor.sync.sync();expect((await b.supervisor.sync.conflicts("resolved")).some(row=>row.conflictId===ca.conflictId)).toBe(true);
  });

  test("reports each caller's requested trigger when a cycle is coalesced",async()=>{
    root=await makeRoot();const hub=new DeterministicSyncHub();a=await openReplica(root,"a",hub);const interval=a.supervisor.sync.sync("interval");const manual=a.supervisor.sync.sync("manual");expect((await interval).trigger).toBe("interval");expect((await manual).trigger).toBe("manual");
  });

  test("treats a non-owner request as a trusted command executed only by the owner",async()=>{
    root=await makeRoot();const hub=new DeterministicSyncHub();a=await openReplica(root,"a",hub);b=await openReplica(root,"b",hub);const session=await seedBoth(a,b);const effectId="cross-device-effect";
    await b.supervisor.storage.appendEvents([{sessionId:session.sessionId,branchId:session.branchId,type:"EffectRequested",producer:"client",idempotencyKey:"cross-device-effect",payload:{effectId,executor:"shell",operation:"run",input:{command:"printf cross-device"},origin:{kind:"runtime",requestId:"cross-device-effect"},idempotencyKey:"cross-device-effect",idempotent:true}}]);expect(await b.supervisor.storage.getOutbox(effectId)).toBeNull();await b.supervisor.sync.sync();await a.supervisor.sync.sync();expect((await a.supervisor.storage.getOutbox(effectId))?.status).toBe("pending");await a.supervisor.outbox.drain();expect((await a.supervisor.storage.getOutbox(effectId))?.status).toBe("succeeded");await b.supervisor.sync.sync();expect(await b.supervisor.storage.getOutbox(effectId)).toBeNull();
  });
});

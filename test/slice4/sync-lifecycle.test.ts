import { afterEach, describe, expect, test } from "bun:test";
import {
  CapabilityUnavailableError,
  DeterministicSyncHub,
  REFINEMENT_GOVERNANCE_CONTRACT_ID,
  REFINEMENT_REVIEW_CONTRACT_ID,
  encodeRefinementReviewTransportValue,
  projectEvents,
  type JsonValue,
  type ModelConfiguration,
  type ModelDispatch,
  type ModelEffectOutputV2,
  type ModelProvider,
  type TextModelResponse,
} from "../../src/index.ts";
import {
  formalOutputFromRefinementGovernanceDecision,
  formalOutputFromRefinementReviewSubmission,
} from "../../src/executors/model-response.ts";
import { closeAll, makeRoot, openReplica, seedBoth, type Replica } from "./helpers.ts";
import { waitFor } from "../helpers.ts";
let root:string;let a:Replica|undefined,b:Replica|undefined;
afterEach(async()=>{if(root)await closeAll(root,a,b);a=b=undefined;});

class SyncReviewProvider implements ModelProvider {
  readonly name = "sync-refinement";
  readonly capabilities = {
    streaming: false,
    requiredToolSet: {
      status: "provider-strict",
      requiredChoice: "provider-enforced",
      parallelCalls: "provider-disabled",
      streaming: true,
      adapter: "agencity.sync-refinement-fixture.v1",
    },
  } as const;
  async complete(
    _context: JsonValue,
    _configuration: ModelConfiguration,
    _signal: AbortSignal,
  ): Promise<TextModelResponse> {
    return {
      text: "text",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    };
  }
  async streamResponse(
    context: JsonValue,
    dispatch: ModelDispatch,
    _signal: AbortSignal,
  ): Promise<ModelEffectOutputV2> {
    if (dispatch.responseContract.kind === "required-tool-set" &&
        dispatch.responseContract.contractId === REFINEMENT_GOVERNANCE_CONTRACT_ID) {
      const proposalId = JSON.stringify(context).match(
        /proposalId[^A-Za-z0-9]+(governed-refinement-proposal-[a-f0-9]{32}|[0-9A-HJKMNP-TV-Z]{26})/,
      )?.[1];
      if (!proposalId) throw new Error("missing governed proposal ID");
      return formalOutputFromRefinementGovernanceDecision({
        decision: {
          decision: "approve",
          proposalId,
          reason: "The synchronized proposal is bounded.",
          satisfiedCriteria: ["scope", "evidence"],
          residualRisks: ["Outcome remains unproven."],
        },
        dispatch,
        providerToolCallId: `sync-governance-${proposalId}`,
        provider: this.name,
        adapter: this.capabilities.requiredToolSet.adapter,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      });
    }
    if (dispatch.responseContract.kind !== "required-tool-set" ||
        dispatch.responseContract.contractId !== REFINEMENT_REVIEW_CONTRACT_ID) {
      throw new Error("unexpected contract");
    }
    const reviewId = JSON.stringify(context)
      .match(/refinement-review-[a-f0-9]{32}/)?.[0];
    if (!reviewId) throw new Error("missing review ID");
    return formalOutputFromRefinementReviewSubmission({
      transportInput: encodeRefinementReviewTransportValue({
        protocol: "agencity.refinement-review",
        version: 1,
        reviewId,
        status: "no_change",
        reason: "No synchronized change is justified.",
        evidenceEventIds: [],
      }),
      dispatch,
      providerToolCallId: "sync-review-call",
      provider: this.name,
      adapter: this.capabilities.requiredToolSet.adapter,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    });
  }
}

class GatedSyncReviewProvider extends SyncReviewProvider {
  active = false;
  #release!: () => void;
  readonly #gate = new Promise<void>((resolve) => { this.#release = resolve; });
  release(): void { this.#release(); }
  override async streamResponse(
    context: JsonValue,
    dispatch: ModelDispatch,
    signal: AbortSignal,
  ): Promise<ModelEffectOutputV2> {
    if (dispatch.responseContract.kind === "required-tool-set" &&
        dispatch.responseContract.contractId === REFINEMENT_REVIEW_CONTRACT_ID) {
      this.active = true;
      await this.#gate;
    }
    return super.streamResponse(context, dispatch, signal);
  }
}

describe("Slice 4 offline-first synchronization lifecycle",()=>{
 test("keeps working offline, reports failure honestly, and catches up on reconnect",async()=>{root=await makeRoot();const hub=new DeterministicSyncHub();a=await openReplica(root,"a",hub);b=await openReplica(root,"b",hub);const session=await seedBoth(a,b);b.transport.setOnline(false);await b.supervisor.appendMessage(session.sessionId,session.branchId,"user","offline B");await expect(b.supervisor.sync.sync()).rejects.toThrow("offline");const failed=await b.supervisor.sync.status();expect(failed.replica.lifecycle).toBe("error");expect(failed.replica.lastSuccessAt).not.toBeNull();expect(failed.replica.lastError).toContain("offline");expect((await b.supervisor.storage.loadEvents(session.sessionId,{branchId:session.branchId})).some(e=>(e.payload as any).content==="offline B")).toBe(true);b.transport.setOnline(true);await b.supervisor.sync.reconnect();await a.supervisor.sync.sync();expect((await a.supervisor.storage.loadEvents(session.sessionId)).some(e=>(e.payload as any).content==="offline B")).toBe(true);});
 test("preserves concurrent offline advancement as derived branches without losing either writer",async()=>{root=await makeRoot();const hub=new DeterministicSyncHub();a=await openReplica(root,"a",hub);b=await openReplica(root,"b",hub);const session=await seedBoth(a,b);await a.supervisor.appendMessage(session.sessionId,session.branchId,"user","from A");await b.supervisor.appendMessage(session.sessionId,session.branchId,"user","from B");await a.supervisor.sync.sync();await b.supervisor.sync.sync();await a.supervisor.sync.sync();const branches=await a.supervisor.storage.listBranches();expect(branches.length).toBe(2);const histories=await Promise.all(branches.map(x=>a!.supervisor.storage.loadEvents(x.sessionId,{branchId:x.branchId})));const texts=histories.flatMap(events=>events.filter(e=>e.type==="MessageAppended").map(e=>(e.payload as any).content));expect(new Set(texts)).toEqual(new Set(["from A","from B"]));expect(histories.some(events=>events.some(e=>e.type==="BranchCreated"&&e.producer==="sync-derived"))).toBe(true);expect((await a.supervisor.sync.conflicts("unresolved")).some(x=>x.kind==="divergent_session")).toBe(true);});
 test("synchronizes one complete governed owner profile revision without quarantine",async()=>{
  root=await makeRoot();const hub=new DeterministicSyncHub();const providerA=new SyncReviewProvider();const providerB=new SyncReviewProvider();a=await openReplica(root,"a",hub,{modelProviders:[providerA]});b=await openReplica(root,"b",hub,{modelProviders:[providerB]});const session=await seedBoth(a,b,{provider:providerA.name,model:"fixture"});
  const initial=await a.supervisor.agentProfiles.active(session.sessionId);
  const evidenceA=await a.supervisor.appendMessage(session.sessionId,session.branchId,"user","Replica A profile evidence");
  const appliedA=await a.supervisor.refinementGovernance.proposeOwner(session.sessionId,session.branchId,{clientRequestId:"offline-profile-a",target:{kind:"agent_profile",agentSessionId:session.sessionId,expectedProfileVersionId:initial.profileVersionId,replacement:{role:initial.role,purpose:initial.purpose,instructions:"Prefer replica A evidence."}},reason:"Offline A revision",predictedEffect:"Exercise A divergence.",evidenceEventIds:[evidenceA.id],wait:true});
  expect(appliedA.status).toBe("applied");const profileA=appliedA.appliedVersionIds[0]!;
  await a.supervisor.sync.sync();await b.supervisor.sync.sync();await a.supervisor.sync.sync();
  const events=await a.supervisor.storage.loadEvents(session.sessionId);
  expect(events.filter(event=>event.type==="AgentProfileVersionCreated")).toHaveLength(1);
  expect((events.find(event=>event.type==="AgentProfileVersionCreated")!.payload as any).agentProfile.profileVersionId).toBe(profileA);
  expect((await a.supervisor.sync.status()).quarantineCount).toBe(0);
  expect((await a.supervisor.agentProfiles.active(session.sessionId)).profileVersionId).toBe(profileA);
  await a.supervisor.storage.rebuildOperationalProjections?.();await a.supervisor.storage.rebuildOperationalProjections?.();
  expect((await a.supervisor.agentProfiles.active(session.sessionId)).profileVersionId).toBe(profileA);
  await a.supervisor.close();a=await openReplica(root,"a",hub);await a.supervisor.sync.sync();
  expect((await a.supervisor.agentProfiles.active(session.sessionId)).profileVersionId).toBe(profileA);
  expect((await a.supervisor.storage.loadEvents(session.sessionId)).filter(event=>event.type==="AgentProfileVersionCreated")).toHaveLength(1);
 });
 test("preserves concurrent offline rollback claims without selecting either restoration",async()=>{
  root=await makeRoot();const hub=new DeterministicSyncHub();const providerA=new SyncReviewProvider();const providerB=new SyncReviewProvider();a=await openReplica(root,"a",hub,{modelProviders:[providerA]});b=await openReplica(root,"b",hub,{modelProviders:[providerB]});const session=await seedBoth(a,b,{provider:providerA.name,model:"fixture"});
  const initial=await a.supervisor.agentProfiles.active(session.sessionId);
  const evidence=await a.supervisor.appendMessage(session.sessionId,session.branchId,"user","Shared profile revision evidence");const revised=await a.supervisor.refinementGovernance.proposeOwner(session.sessionId,session.branchId,{clientRequestId:"shared-profile-revision",target:{kind:"agent_profile",agentSessionId:session.sessionId,expectedProfileVersionId:initial.profileVersionId,replacement:{role:initial.role,purpose:initial.purpose,instructions:"Shared approved revision."}},reason:"Shared revision",predictedEffect:"Exercise rollback divergence.",evidenceEventIds:[evidence.id],wait:true});expect(revised.status).toBe("applied");const revisedVersionId=revised.appliedVersionIds[0]!;
  await a.supervisor.sync.sync();await b.supervisor.sync.sync();
  expect((await b.supervisor.sync.status()).quarantineCount).toBe(0);
  expect((await a.supervisor.agentProfiles.active(session.sessionId)).profileVersionId).toBe(revisedVersionId);
  expect((await b.supervisor.agentProfiles.active(session.sessionId)).profileVersionId).toBe(revisedVersionId);
  const rollbackA=await a.supervisor.refinementGovernance.rollbackOwner(session.sessionId,session.branchId,{targetKind:"agent_profile",targetId:session.sessionId,expectedCurrentVersionId:revisedVersionId,restoreVersionId:initial.profileVersionId,reason:"Replica A rollback",evidenceEventIds:[]});
  const rollbackB=await b.supervisor.refinementGovernance.rollbackOwner(session.sessionId,session.branchId,{targetKind:"agent_profile",targetId:session.sessionId,expectedCurrentVersionId:revisedVersionId,restoreVersionId:initial.profileVersionId,reason:"Replica B rollback",evidenceEventIds:[]});
  expect(rollbackA.restorationVersionId).not.toBe(rollbackB.restorationVersionId);
  await a.supervisor.sync.sync();await b.supervisor.sync.sync();await a.supervisor.sync.sync();
  const events=await a.supervisor.storage.loadEvents(session.sessionId);
  expect(events.filter(event=>event.type==="RefinementRollbackApplied")).toHaveLength(2);
  expect(events.filter(event=>event.type==="AgentProfileVersionCreated")).toHaveLength(3);
  await expect(a.supervisor.agentProfiles.active(session.sessionId)).rejects.toMatchObject({code:"CONFLICT"});
  await a.supervisor.storage.rebuildOperationalProjections?.();
  await a.supervisor.close();a=await openReplica(root,"a",hub);
  await expect(a.supervisor.agentProfiles.active(session.sessionId)).rejects.toMatchObject({code:"CONFLICT"});
  expect((await a.supervisor.storage.loadEvents(session.sessionId)).filter(event=>event.type==="RefinementRollbackApplied")).toHaveLength(2);
 });
 test("does not turn a remote owner's effect request into locally executable outbox work",async()=>{root=await makeRoot();const hub=new DeterministicSyncHub();a=await openReplica(root,"a",hub);b=await openReplica(root,"b",hub);const session=await seedBoth(a,b);const effectId=await a.supervisor.outbox.request({sessionId:session.sessionId,branchId:session.branchId,executor:"shell",operation:"run",input:{command:"printf owner-only"},origin:{kind:"runtime",requestId:"owner-only-effect"},idempotencyKey:"owner-only-effect",idempotent:true});await a.supervisor.sync.sync();await b.supervisor.sync.sync();expect((await b.supervisor.storage.loadEvents(session.sessionId)).some(e=>e.type==="EffectRequested"&&(e.payload as any).effectId===effectId)).toBe(true);expect(await b.supervisor.storage.getOutbox(effectId)).toBeNull();expect((await b.supervisor.storage.getSession?.(session.sessionId))?.executionOwnerDeviceId).toBe(a.supervisor.device.deviceId);await expect(b.supervisor.modelLoop.turn(session.sessionId,session.branchId)).rejects.toMatchObject({code:"CAPABILITY_UNAVAILABLE"});});
 test("replicates a structured refinement result with exact child provenance",async()=>{
  root=await makeRoot();const hub=new DeterministicSyncHub();const providerA=new SyncReviewProvider();const providerB=new SyncReviewProvider();
  a=await openReplica(root,"a",hub,{modelProviders:[providerA]});b=await openReplica(root,"b",hub,{modelProviders:[providerB]});
  const session=await a.supervisor.createSession({workspaceId:"workspace",model:{provider:providerA.name,model:"fixture"}});
  await a.supervisor.sync.sync();await b.supervisor.sync.sync();
  await a.supervisor.appendMessage(session.sessionId,session.branchId,"user","synchronized refinement evidence");
  const review=await a.supervisor.refiner.request(session.sessionId,session.branchId);expect(review.status).toBe("no_change");
  await a.supervisor.sync.sync();await b.supervisor.sync.sync();
  const syncStatus=await b.supervisor.sync.status();
  expect(syncStatus.quarantineCount).toBe(0);
  const parentBranches=(await b.supervisor.storage.listBranches()).filter(branch=>branch.sessionId===session.sessionId);
  const parentStates=await Promise.all(parentBranches.map(async branch=>projectEvents(await b!.supervisor.storage.loadEvents(branch.sessionId,{branchId:branch.branchId}))));
  const handle=parentStates.map(state=>state.recursiveModels[review.handleId!]).find(Boolean);
  expect(handle?.status).toBe("completed");
  expect(handle?.result).toMatchObject({kind:"tool-submission",contractId:REFINEMENT_REVIEW_CONTRACT_ID,submission:{reviewId:review.reviewId,status:"no_change"}});
  const childBranches=(await b.supervisor.storage.listBranches()).filter(branch=>branch.sessionId===handle!.childSessionId);
  const childStates=await Promise.all(childBranches.map(async branch=>projectEvents(await b!.supervisor.storage.loadEvents(branch.sessionId,{branchId:branch.branchId}))));
  const child=childStates.find(state=>Object.values(state.modelCalls).some(call=>call.status==="succeeded"))!;
  expect(Object.values(child.modelCalls).at(-1)).toMatchObject({status:"succeeded",result:{kind:"tool-submission",name:"agencity_submit_refinement_review"}});
  expect(child.messages.some(message=>message.role==="assistant")).toBe(false);
 });
  test("resolves a structured refinement result against a divergent synced child branch",async()=>{
  root=await makeRoot();const hub=new DeterministicSyncHub();
  const providerA=new GatedSyncReviewProvider();const providerB=new GatedSyncReviewProvider();
  a=await openReplica(root,"a",hub,{modelProviders:[providerA]});b=await openReplica(root,"b",hub,{modelProviders:[providerB]});
  const session=await a.supervisor.createSession({workspaceId:"workspace",model:{provider:providerA.name,model:"fixture"}});
  await a.supervisor.appendMessage(session.sessionId,session.branchId,"user","divergent refinement evidence");
  const admitted=await a.supervisor.refiner.request(session.sessionId,session.branchId,{wait:false});
  await waitFor(async()=>providerA.active&&(await a!.supervisor.refiner.get(admitted.reviewId)).handleId!==null,"gated refinement child admission");
  const linked=await a.supervisor.refiner.get(admitted.reviewId);
  // Replicate the shared child-branch prefix, then write to it offline on B so
  // A's later completion events physically land on a sync-derived branch at B.
  await a.supervisor.sync.sync();await b.supervisor.sync.sync();
  await b.supervisor.appendMessage(linked.childSessionId!,linked.childBranchId!,"user","offline divergent child note");
  providerA.release();
  await waitFor(async()=>(await a!.supervisor.refiner.get(admitted.reviewId)).status==="no_change","structured refinement completion",10_000);
  await b.supervisor.sync.sync();await a.supervisor.sync.sync();await b.supervisor.sync.sync();
  const status=await b.supervisor.sync.status();
  expect(status.quarantineCount).toBe(0);
  expect((await b.supervisor.sync.conflicts("unresolved")).some(conflict=>conflict.kind==="divergent_session")).toBe(true);
  const parentState=projectEvents(await b.supervisor.storage.loadEvents(session.sessionId,{branchId:session.branchId}));
  const handle=parentState.recursiveModels[linked.handleId!];
  expect(handle?.status).toBe("completed");
  expect(handle?.result).toMatchObject({kind:"tool-submission",contractId:REFINEMENT_REVIEW_CONTRACT_ID,submission:{reviewId:admitted.reviewId,status:"no_change"}});
  // The child's canonical completion is preserved on a sync-derived branch on
  // B rather than rewritten onto the divergent local branch.
  const childBranches=(await b.supervisor.storage.listBranches()).filter(branch=>branch.sessionId===linked.childSessionId);
  expect(childBranches.length).toBeGreaterThan(1);
  const derived=childBranches.find(branch=>branch.branchId!==linked.childBranchId)!;
  const derivedEvents=await b.supervisor.storage.loadEvents(linked.childSessionId!,{branchId:derived.branchId});
  expect(derivedEvents.some(event=>event.type==="ModelCallCompleted")).toBe(true);
  // Restart/replay: reopen replica B from its durable file and replay sync.
  await b.supervisor.close();
  b=await openReplica(root,"b",hub,{modelProviders:[providerB]});
  await b.supervisor.sync.sync();
  const replayed=await b.supervisor.sync.status();
  expect(replayed.quarantineCount).toBe(0);
  const reopened=projectEvents(await b.supervisor.storage.loadEvents(session.sessionId,{branchId:session.branchId}));
  expect(reopened.recursiveModels[linked.handleId!]?.result).toEqual(handle!.result!);
 });
 test("keeps the bidirectional-only in-process hub honest about unsupported directional calls",async()=>{root=await makeRoot();const hub=new DeterministicSyncHub();a=await openReplica(root,"a",hub);await a.supervisor.createSession({workspaceId:"workspace"});expect(await a.supervisor.sync.stage()).toBe(1);expect((await a.supervisor.sync.status()).capabilities.directionalNetworkPush).toBe(false);await expect(a.supervisor.sync.push()).rejects.toBeInstanceOf(CapabilityUnavailableError);await expect(a.supervisor.sync.pull()).rejects.toBeInstanceOf(CapabilityUnavailableError);});
 test("discovers cloud workspaces from replicated announcements",async()=>{root=await makeRoot();const hub=new DeterministicSyncHub();a=await openReplica(root,"a",hub);b=await openReplica(root,"b",hub);await a.supervisor.sync.sync();await b.supervisor.sync.sync();const discovered=await b.supervisor.sync.discoverCloudWorkspaces();expect(discovered).toHaveLength(1);expect(discovered[0]?.workspaceId).toBe("workspace");expect(discovered[0]?.name).toBe("Shared workspace");});
});

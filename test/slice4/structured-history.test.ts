import { afterEach, describe, expect, test } from "bun:test";
import { DeterministicSyncHub, ScriptedAgentActionProvider, projectEvents } from "../../src/index.ts";
import { closeAll, makeRoot, openReplica, type Replica } from "./helpers.ts";

let root: string | undefined;
let a: Replica | undefined, b: Replica | undefined;
afterEach(async () => { if (root) await closeAll(root, a, b); root = undefined; a = b = undefined; });

describe("Slice 4 structured version-3 history boundaries", () => {
  test("a formal agent-run history forks, rebuilds, and synchronizes with exact structured provenance", async () => {
    root = await makeRoot();
    const hub = new DeterministicSyncHub();
    const provider = new ScriptedAgentActionProvider([{
      protocol: "agencity.agent-action", version: 1, type: "final", content: "Structured history replicated.",
    }], "structured-sync-actions");
    a = await openReplica(root, "a", hub, { modelProviders: [provider] });
    b = await openReplica(root, "b", hub);
    const session = await a.supervisor.createSession({
      workspaceId: "workspace",
      model: { provider: provider.name, model: "structured-v1" },
    });
    const result = await a.supervisor.runs.start(session.sessionId, session.branchId, "Replicate structured provenance");
    expect(result).toMatchObject({ status: "succeeded", final: "Structured history replicated." });

    const sourceEvents = await a.supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    const source = projectEvents(sourceEvents);
    const call = Object.values(source.modelCalls)[0]!;
    const run = Object.values(source.agentRuns)[0]!;
    expect(call.modelDispatch.responseContract.kind).toBe("required-tool-set");
    expect(call.result).toMatchObject({ kind: "tool-submission", name: "finish" });
    expect(call.usageSource).toBe("provider-reported");
    expect(run.steps[0]?.actionSource).toMatchObject({ kind: "tool-submission", modelCallId: call.id });
    expect((source.effects[call.effectId]?.output as { kind?: string } | undefined)?.kind)
      .toBe("agencity.model-effect-output.v2");

    // A branch forked at the committed head projects the identical structured history.
    const forkedBranchId = await a.supervisor.fork(session.sessionId, session.branchId, sourceEvents.at(-1)!.cursor);
    const forked = projectEvents(await a.supervisor.storage.loadEvents(session.sessionId, { branchId: forkedBranchId }));
    expect(forked.modelCalls).toEqual(source.modelCalls);
    expect(forked.agentRuns[run.id]?.steps).toEqual(run.steps);

    // A deleted-snapshot rebuild reproduces the same structured state deterministically.
    const rebuilt = await a.supervisor.projections.rebuild(session.sessionId, session.branchId);
    expect(rebuilt.modelCalls).toEqual(source.modelCalls);
    expect(rebuilt.agentRuns[run.id]?.steps).toEqual(run.steps);
    expect(rebuilt.agentRuns[run.id]?.finalMessageId).toBe(run.finalMessageId!);

    // Actual sync ingestion on another replica preserves every schema-3 structured field.
    await a.supervisor.sync.sync();
    await b.supervisor.sync.sync();
    const replicated = projectEvents(await b.supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
    expect(replicated.modelCalls).toEqual(source.modelCalls);
    expect(replicated.effects[call.effectId]?.output).toEqual(source.effects[call.effectId]?.output);
    expect(replicated.agentRuns[run.id]?.steps).toEqual(run.steps);
    expect(replicated.agentRuns[run.id]).toMatchObject({ status: "succeeded", finalMessageId: run.finalMessageId! });
    expect((await b.supervisor.sync.status()).quarantineCount).toBe(0);
  });
});

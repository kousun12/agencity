import { afterEach, describe, expect, test } from "bun:test";
import { type Supervisor } from "../../src/index.ts";
import type { TempRuntime } from "../helpers.ts";
import { closeAdversarial, evidence, objectiveEvidence, openAdversarial, validatedProposal } from "./helpers.ts";

let current: { supervisor: Supervisor; temp: TempRuntime } | undefined;
afterEach(async () => { await closeAdversarial(current); current = undefined; });

async function promptCandidate(s: Supervisor, sessionId: string, branchId: string, scope: "local" | "workspace" = "local") {
  const ev = await evidence(s, sessionId, branchId, `candidate evidence ${scope}`);
  let p = await validatedProposal(s, sessionId, branchId, [{
    operation: "create", kind: "prompt_note", scope, name: `candidate-${scope}-${ev.id}`,
    content: { kind: "prompt_note", text: `allocated ${scope} candidate only` },
  }], [ev.id]);
  if (p.status !== "validated") throw new Error(JSON.stringify(p.validation));
  p = await s.harness.activate(sessionId, branchId, p.proposalId, { allocationLimit: 4, exposureLimit: 4 });
  return { proposal: p, evidence: ev };
}

describe("Slice 3 candidate allocation, exposure, and observations", () => {
  test("candidate memory is absent from context and retrieval until its exact allocation is exposed", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "w" });
    const sibling = await s.createSession({ workspaceId: "w" });
    const ev = await evidence(s, owner.sessionId, owner.branchId, "quasar candidate evidence");
    let p = await validatedProposal(s, owner.sessionId, owner.branchId, [{
      operation: "create", kind: "memory", scope: "workspace", name: "quasar-candidate",
      content: { kind: "memory", memoryKind: "claim", text: "quasar candidate must not leak" },
    }], [ev.id]);
    p = await s.harness.activate(owner.sessionId, owner.branchId, p.proposalId, { allocationLimit: 1, exposureLimit: 1 });

    const beforeOwner = await s.contexts.materialize(owner.sessionId, owner.branchId);
    const beforeSibling = await s.contexts.materialize(sibling.sessionId, sibling.branchId);
    expect((beforeOwner.context as any).harness.memories).toEqual([]);
    expect((beforeSibling.context as any).harness.memories).toEqual([]);
    const retrievalLeak = await s.memory.search(sibling.sessionId, sibling.branchId, "quasar", { statuses: ["candidate"] });
    expect(retrievalLeak.items).toEqual([]);

    const allocation = await s.harness.allocate(owner.sessionId, owner.branchId, p.proposalId);
    const exposed = await s.contexts.materialize(owner.sessionId, owner.branchId);
    expect((exposed.context as any).harness.memories.map((item: any) => item.name)).toContain("quasar-candidate");
    const stillHidden = await s.contexts.materialize(sibling.sessionId, sibling.branchId);
    expect((stillHidden.context as any).harness.memories.map((item: any) => item.name)).not.toContain("quasar-candidate");
    expect((exposed.event.payload as any).harnessProvenance.candidates[0].allocationId).toBe(allocation.allocationId);
  });

  test("the public memory command cannot create free-floating candidates outside refinement", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const session = await s.createSession({ workspaceId: "w" });
    await expect(s.memory.create(session.sessionId, session.branchId, {
      text: "unallocated free candidate", scope: "local", status: "candidate",
    })).rejects.toThrow(/refinement|proposal|allocation/i);
    await expect(s.executeCell(session.sessionId, session.branchId, `
      await sdk.memory.create({ text: "console free candidate", scope: "local", status: "candidate" });
      return null;
    `)).rejects.toThrow(/refinement|proposal|allocation/i);
    const rows = await s.storage.readonlyQuery({ sql: "SELECT entry_id FROM harness_entries WHERE status='candidate'", args: [] });
    expect(rows).toEqual([]);
  });

  test("scope policy is enforced before allocating a candidate to a different workspace", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "workspace-a" });
    const foreign = await s.createSession({ workspaceId: "workspace-b" });
    const { proposal } = await promptCandidate(s, owner.sessionId, owner.branchId, "workspace");
    await expect(s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId, {
      sessionId: foreign.sessionId, branchId: foreign.branchId,
    })).rejects.toThrow(/scope|workspace|allocation/i);
    const context = await s.contexts.materialize(foreign.sessionId, foreign.branchId);
    expect((context.context as any).harness.promptNotes).toEqual([]);
  });

  test("allocations naming a task validate that exact admitted task unit and target branch", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "w" });
    const child = (await s.agents.spawnMany(owner.sessionId, owner.branchId, [{ task: "real allocated task" }]))[0]!;
    const other = await s.createSession({ workspaceId: "w" });
    const { proposal } = await promptCandidate(s, owner.sessionId, owner.branchId, "workspace");

    await expect(s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId, {
      sessionId: owner.sessionId, branchId: owner.branchId, taskId: "fabricated-task-a",
    })).rejects.toThrow(/task|allocation/i);
    await expect(s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId, {
      sessionId: other.sessionId, branchId: other.branchId, taskId: child.taskId,
    })).rejects.toThrow(/task|child|target|allocation/i);

    const valid = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId, {
      sessionId: child.sessionId, branchId: child.branchId, taskId: child.taskId,
    });
    expect(valid.taskId).toBe(child.taskId);
  });

  test("model-generated console code cannot certify an objective observation", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const session = await s.createSession({ workspaceId: "w" });
    const { proposal, evidence: ev } = await promptCandidate(s, session.sessionId, session.branchId);
    const allocation = await s.harness.allocate(session.sessionId, session.branchId, proposal.proposalId);
    await s.contexts.materialize(session.sessionId, session.branchId);

    let error: unknown;
    try {
      await s.executeCell(session.sessionId, session.branchId, `
        await sdk.harness.recordObservation(${JSON.stringify(proposal.proposalId)}, {
          allocationId: ${JSON.stringify(allocation.allocationId)}, evaluator: "model-self-report",
          objective: true, success: true, metric: true, evidenceEventIds: [${JSON.stringify(ev.id)}]
        });
        return "fabricated";
      `);
    } catch (caught) { error = caught; }
    const observations = await s.storage.readonlyQuery({ sql: "SELECT observation_id FROM refinement_observations WHERE proposal_id=?", args: [proposal.proposalId] });
    expect({ rejected: error instanceof Error, observations: observations.length }).toEqual({ rejected: true, observations: 0 });
  });

  test("a user/model message is not objective evaluator evidence", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const session = await s.createSession({ workspaceId: "w" });
    const { proposal, evidence: message } = await promptCandidate(s, session.sessionId, session.branchId);
    const allocation = await s.harness.allocate(session.sessionId, session.branchId, proposal.proposalId);
    await s.contexts.materialize(session.sessionId, session.branchId);
    await expect(s.harness.recordObservation(session.sessionId, session.branchId, proposal.proposalId, {
      allocationId: allocation.allocationId,
      evaluator: "claimed-objective",
      objective: true,
      success: true,
      metric: true,
      evidenceEventIds: [message.id],
    })).rejects.toThrow(/objective|evaluator|evidence|producer/i);
  });

  test("workspace promotion needs repeated objective successes in distinct real allocated units", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "w" });
    const second = await s.createSession({ workspaceId: "w" });
    const { proposal } = await promptCandidate(s, owner.sessionId, owner.branchId, "workspace");
    const firstAllocation = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId);
    const secondAllocation = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId, {
      sessionId: second.sessionId, branchId: second.branchId,
    });
    await s.contexts.materialize(owner.sessionId, owner.branchId);
    await s.contexts.materialize(second.sessionId, second.branchId);
    const firstEvidence = await objectiveEvidence(s, owner.sessionId, owner.branchId, "workspace-first");
    const secondEvidence = await objectiveEvidence(s, second.sessionId, second.branchId, "workspace-second");
    await s.harness.recordObservation(owner.sessionId, owner.branchId, proposal.proposalId, {
      allocationId: firstAllocation.allocationId, evaluator: "executor-outcome", objective: true,
      success: true, metric: true, evidenceEventIds: [firstEvidence.id],
    });
    await expect(s.harness.decide(owner.sessionId, owner.branchId, proposal.proposalId)).rejects.toThrow(/repeated|distinct|workspace/i);
    await s.harness.recordObservation(owner.sessionId, owner.branchId, proposal.proposalId, {
      allocationId: secondAllocation.allocationId, evaluator: "executor-outcome", objective: true,
      success: true, metric: true, evidenceEventIds: [secondEvidence.id],
    });
    expect((await s.harness.decide(owner.sessionId, owner.branchId, proposal.proposalId)).decision).toBe("promote");
  });
});

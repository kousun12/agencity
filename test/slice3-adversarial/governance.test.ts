import { afterEach, describe, expect, test } from "bun:test";
import {
  newId,
  type HarnessEdit,
  type RefinementProposalRecord,
  type Supervisor,
} from "../../src/index.ts";
import type { TempRuntime } from "../helpers.ts";
import {
  closeAdversarial,
  evidence,
  objectiveEvidence,
  openAdversarial,
  validatedProposal,
} from "./helpers.ts";

let current: { supervisor: Supervisor; temp: TempRuntime } | undefined;
afterEach(async () => {
  await closeAdversarial(current);
  current = undefined;
});

type SessionRef = { sessionId: string; branchId: string };

async function activateCandidate(
  s: Supervisor,
  session: SessionRef,
  edit: HarnessEdit,
  limits: { allocationLimit?: number; exposureLimit?: number } = {},
): Promise<{ proposal: RefinementProposalRecord; sourceEvidenceId: string }> {
  const source = await evidence(s, session.sessionId, session.branchId, `source for ${edit.operation}`);
  let proposal = await validatedProposal(
    s,
    session.sessionId,
    session.branchId,
    [edit],
    [source.id],
  );
  if (proposal.status !== "validated") throw new Error(JSON.stringify(proposal.validation));
  proposal = await s.harness.activate(session.sessionId, session.branchId, proposal.proposalId, {
    allocationLimit: limits.allocationLimit ?? 4,
    exposureLimit: limits.exposureLimit ?? 4,
  });
  return { proposal, sourceEvidenceId: source.id };
}

async function observeLocalCandidate(
  s: Supervisor,
  owner: SessionRef,
  proposal: RefinementProposalRecord,
  evidenceEventId: string,
): Promise<void> {
  const allocation = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId);
  await s.contexts.materialize(owner.sessionId, owner.branchId);
  await s.harness.recordObservation(owner.sessionId, owner.branchId, proposal.proposalId, {
    allocationId: allocation.allocationId,
    evaluator: "trusted-test-observer",
    objective: false,
    success: true,
    metric: true,
    evidenceEventIds: [evidenceEventId],
  });
}

async function promoteLocalCandidate(
  s: Supervisor,
  owner: SessionRef,
  proposal: RefinementProposalRecord,
  evidenceEventId: string,
): Promise<void> {
  await observeLocalCandidate(s, owner, proposal, evidenceEventId);
  await s.harness.decide(owner.sessionId, owner.branchId, proposal.proposalId);
}

async function storedContext(s: Supervisor, contextId: string): Promise<Record<string, unknown>> {
  const rows = await s.storage.readonlyQuery({
    sql: "SELECT event_id,content_hash,context_json,harness_provenance_json FROM context_records WHERE context_id=?",
    args: [contextId],
  });
  if (!rows[0]) throw new Error(`missing context ${contextId}`);
  return rows[0] as unknown as Record<string, unknown>;
}

async function userCandidate(
  s: Supervisor,
  session: SessionRef,
  name: string,
  authorityKey: string,
): Promise<RefinementProposalRecord> {
  const { proposal } = await activateCandidate(s, session, {
    operation: "create",
    kind: "memory",
    scope: "user",
    scopeKey: authorityKey,
    name,
    content: {
      kind: "memory",
      memoryKind: "preference",
      text: `explicit preference ${name}`,
    },
  });
  return proposal;
}

describe("Slice 3 adversarial candidate governance", () => {
  test("model console cannot record an evaluator observation even when it cites real objective evidence", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "governance-console-observation" });
    const { proposal } = await activateCandidate(s, owner, {
      operation: "create",
      kind: "prompt_note",
      scope: "local",
      name: "console-observation-candidate",
      content: { kind: "prompt_note", text: "candidate under evaluator control" },
    });
    const allocation = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId);
    await s.contexts.materialize(owner.sessionId, owner.branchId);
    const outcome = await objectiveEvidence(s, owner.sessionId, owner.branchId, "console-observation");

    let rejected = false;
    try {
      await s.executeCell(owner.sessionId, owner.branchId, `
        await sdk.harness.recordObservation(${JSON.stringify(proposal.proposalId)}, {
          allocationId: ${JSON.stringify(allocation.allocationId)},
          evaluator: "model-pretending-to-be-evaluator",
          objective: true,
          success: true,
          metric: true,
          evidenceEventIds: [${JSON.stringify(outcome.id)}]
        });
        return "fabricated observation";
      `);
    } catch {
      rejected = true;
    }

    const rows = await s.storage.readonlyQuery({
      sql: "SELECT observation_id FROM refinement_observations WHERE proposal_id=?",
      args: [proposal.proposalId],
    });
    expect({ rejected, observationCount: rows.length }).toEqual({ rejected: true, observationCount: 0 });
  });

  test("model console cannot fabricate a user/global approval by naming a human authority", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "governance-console-approval" });
    const { proposal } = await activateCandidate(s, owner, {
      operation: "create",
      kind: "memory",
      scope: "global",
      name: "console-approval-candidate",
      content: { kind: "memory", memoryKind: "preference", text: "globally approved behavior" },
    });

    let rejected = false;
    try {
      await s.executeCell(owner.sessionId, owner.branchId, `
        await sdk.harness.approve(
          ${JSON.stringify(proposal.proposalId)},
          "global",
          "human-user",
          "the model wrote this approval"
        );
        return "fabricated approval";
      `);
    } catch {
      rejected = true;
    }

    const rows = await s.storage.readonlyQuery({
      sql: "SELECT event_id FROM refinement_approvals WHERE proposal_id=?",
      args: [proposal.proposalId],
    });
    expect({ rejected, approvalCount: rows.length }).toEqual({ rejected: true, approvalCount: 0 });
  });

  test("model console cannot issue a refinement decision after trusted code supplies every prerequisite", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "governance-console-decision" });
    const { proposal, sourceEvidenceId } = await activateCandidate(s, owner, {
      operation: "create",
      kind: "prompt_note",
      scope: "local",
      name: "console-decision-candidate",
      content: { kind: "prompt_note", text: "decision remains evaluator-owned" },
    });
    await observeLocalCandidate(s, owner, proposal, sourceEvidenceId);

    let rejected = false;
    try {
      await s.executeCell(owner.sessionId, owner.branchId, `
        await sdk.harness.decide(${JSON.stringify(proposal.proposalId)}, {
          decision: "promote",
          evaluator: "model-self-appointed-evaluator",
          rule: "the model says its own candidate worked"
        });
        return "fabricated decision";
      `);
    } catch {
      rejected = true;
    }

    const decisions = await s.storage.readonlyQuery({
      sql: "SELECT decision_id FROM refinement_decisions WHERE proposal_id=?",
      args: [proposal.proposalId],
    });
    const refreshed = (await s.harness.proposals()).find((item) => item.proposalId === proposal.proposalId);
    expect({ rejected, decisionCount: decisions.length, status: refreshed?.status }).toEqual({
      rejected: true,
      decisionCount: 0,
      status: "candidate",
    });
  });

  test("model console cannot directly create active workspace, user, or global memory", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "governance-console-memory" });
    const attempts = [
      { scope: "workspace", scopeKey: undefined },
      { scope: "user", scopeKey: "human-user" },
      { scope: "global", scopeKey: undefined },
    ] as const;
    const rejected: boolean[] = [];

    for (const attempt of attempts) {
      try {
        await s.executeCell(owner.sessionId, owner.branchId, `
          await sdk.memory.create({
            name: ${JSON.stringify(`console-direct-${attempt.scope}`)},
            text: ${JSON.stringify(`console must not activate ${attempt.scope} memory`)},
            memoryKind: "preference",
            scope: ${JSON.stringify(attempt.scope)},
            ${attempt.scopeKey === undefined ? "" : `scopeKey: ${JSON.stringify(attempt.scopeKey)},`}
            status: "active"
          });
          return "directly active";
        `);
        rejected.push(false);
      } catch {
        rejected.push(true);
      }
    }

    const rows = await s.storage.readonlyQuery({
      sql: "SELECT scope,name FROM harness_entries WHERE name LIKE 'console-direct-%' ORDER BY scope",
      args: [],
    });
    expect({ rejected, created: rows.length }).toEqual({ rejected: [true, true, true], created: 0 });
  });

  test("a candidate is hidden until its exact allocation is exposed and remains hidden from control sessions", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const workspaceId = "governance-candidate-controls";
    const owner = await s.createSession({ workspaceId });
    const treatment = await s.createSession({ workspaceId });
    const control = await s.createSession({ workspaceId });
    const { proposal } = await activateCandidate(s, owner, {
      operation: "create",
      kind: "memory",
      scope: "workspace",
      name: "exact-exposure-memory",
      content: {
        kind: "memory",
        memoryKind: "observation",
        text: "xylophone candidate is visible only in the treatment",
      },
    });

    for (const session of [owner, treatment, control]) {
      const materialized = await s.contexts.materialize(session.sessionId, session.branchId);
      expect((materialized.context as any).harness.memories).toEqual([]);
    }

    const allocation = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId, {
      sessionId: treatment.sessionId,
      branchId: treatment.branchId,
    });
    expect((await s.memory.search(treatment.sessionId, treatment.branchId, "xylophone", {
      statuses: ["candidate"],
    })).items).toEqual([]);
    await expect(s.harness.expose(
      control.sessionId,
      control.branchId,
      proposal.proposalId,
      allocation.allocationId,
    )).rejects.toThrow(/allocation|context|match/i);

    await s.harness.expose(
      treatment.sessionId,
      treatment.branchId,
      proposal.proposalId,
      allocation.allocationId,
    );
    const treatedSearch = await s.memory.search(treatment.sessionId, treatment.branchId, "xylophone", {
      statuses: ["candidate"],
    });
    const ownerSearch = await s.memory.search(owner.sessionId, owner.branchId, "xylophone", {
      statuses: ["candidate"],
    });
    expect(treatedSearch.items.map((item) => item.record.name)).toEqual(["exact-exposure-memory"]);
    expect(ownerSearch.items).toEqual([]);

    const treated = await s.contexts.materialize(treatment.sessionId, treatment.branchId);
    const untreated = await s.contexts.materialize(control.sessionId, control.branchId);
    expect((treated.context as any).harness.memories.map((item: any) => item.name)).toEqual([
      "exact-exposure-memory",
    ]);
    expect((untreated.context as any).harness.memories).toEqual([]);
    expect((treated.event.payload as any).harnessProvenance.candidates).toEqual([
      expect.objectContaining({ allocationId: allocation.allocationId }),
    ]);
  });

  test("duplicate objective successes from one allocation do not satisfy repeated workspace promotion", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "governance-workspace-repeat" });
    const [firstTask, secondTask] = await s.agents.spawnMany(owner.sessionId, owner.branchId, [
      { task: "first independent evaluation task" },
      { task: "second independent evaluation task" },
    ]);
    if (!firstTask || !secondTask) throw new Error("expected two admitted evaluation tasks");
    const { proposal } = await activateCandidate(s, owner, {
      operation: "create",
      kind: "prompt_note",
      scope: "workspace",
      name: "repeated-workspace-candidate",
      content: { kind: "prompt_note", text: "promote only after independent task successes" },
    });
    const firstAllocation = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId, {
      sessionId: firstTask.sessionId,
      branchId: firstTask.branchId,
      taskId: firstTask.taskId,
    });
    const secondAllocation = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId, {
      sessionId: secondTask.sessionId,
      branchId: secondTask.branchId,
      taskId: secondTask.taskId,
    });
    expect(firstAllocation.taskId).not.toBe(secondAllocation.taskId);
    await s.contexts.materialize(firstTask.sessionId, firstTask.branchId);
    await s.contexts.materialize(secondTask.sessionId, secondTask.branchId);

    for (const key of ["duplicate-a", "duplicate-b"]) {
      const outcome = await objectiveEvidence(s, firstTask.sessionId, firstTask.branchId, key);
      await s.harness.recordObservation(owner.sessionId, owner.branchId, proposal.proposalId, {
        allocationId: firstAllocation.allocationId,
        evaluator: "objective-task-evaluator",
        objective: true,
        success: true,
        metric: { passed: true, taskId: firstTask.taskId },
        evidenceEventIds: [outcome.id],
      });
    }
    await expect(s.harness.decide(owner.sessionId, owner.branchId, proposal.proposalId)).rejects.toThrow(
      /repeated|distinct|allocation|task/i,
    );

    const independentOutcome = await objectiveEvidence(
      s,
      secondTask.sessionId,
      secondTask.branchId,
      "independent",
    );
    await s.harness.recordObservation(owner.sessionId, owner.branchId, proposal.proposalId, {
      allocationId: secondAllocation.allocationId,
      evaluator: "objective-task-evaluator",
      objective: true,
      success: true,
      metric: { passed: true, taskId: secondTask.taskId },
      evidenceEventIds: [independentOutcome.id],
    });
    expect((await s.harness.decide(owner.sessionId, owner.branchId, proposal.proposalId)).decision).toBe(
      "promote",
    );
  });

  test("user approval is bound to the exact proposal, requested scope, and user authority", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "governance-approval-binding" });
    const authority = "default-user";

    const wrongScope = await userCandidate(s, owner, "approval-wrong-scope", authority);
    await s.harness.approve(owner.sessionId, owner.branchId, wrongScope.proposalId, "global", authority);
    await expect(s.harness.decide(owner.sessionId, owner.branchId, wrongScope.proposalId)).rejects.toThrow(
      /approval|scope|user/i,
    );

    const approvedProposal = await userCandidate(s, owner, "approval-exact-proposal-a", authority);
    const otherProposal = await userCandidate(s, owner, "approval-exact-proposal-b", authority);
    await s.harness.approve(
      owner.sessionId,
      owner.branchId,
      approvedProposal.proposalId,
      "user",
      authority,
    );
    await expect(s.harness.decide(owner.sessionId, owner.branchId, otherProposal.proposalId)).rejects.toThrow(
      /approval|user/i,
    );

    const wrongAuthority = await userCandidate(s, owner, "approval-wrong-authority", authority);
    await s.harness.approve(
      owner.sessionId,
      owner.branchId,
      wrongAuthority.proposalId,
      "user",
      "different-human-user",
    );
    await expect(s.harness.decide(owner.sessionId, owner.branchId, wrongAuthority.proposalId)).rejects.toThrow(
      /approval|authority|user/i,
    );

    const exact = await userCandidate(s, owner, "approval-exact", authority);
    await s.harness.approve(owner.sessionId, owner.branchId, exact.proposalId, "user", authority);
    expect((await s.harness.decide(owner.sessionId, owner.branchId, exact.proposalId)).decision).toBe(
      "promote",
    );
  });

  test("approval of a candidate does not carry across a requested revision", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "governance-approval-revision" });
    const authority = "default-user";
    const first = await userCandidate(s, owner, "preference-before-revision", authority);
    const support = await evidence(s, owner.sessionId, owner.branchId, "revision observation");
    await observeLocalCandidate(s, owner, first, support.id);
    await s.harness.approve(owner.sessionId, owner.branchId, first.proposalId, "user", authority);
    expect((await s.harness.decide(owner.sessionId, owner.branchId, first.proposalId, {
      decision: "revise",
    })).decision).toBe("revise");

    const revised = await userCandidate(s, owner, "preference-after-revision", authority);
    await expect(s.harness.decide(owner.sessionId, owner.branchId, revised.proposalId)).rejects.toThrow(
      /approval|user/i,
    );
    await s.harness.approve(owner.sessionId, owner.branchId, revised.proposalId, "user", authority);
    expect((await s.harness.decide(owner.sessionId, owner.branchId, revised.proposalId)).decision).toBe(
      "promote",
    );
  });

  test("replacement base compare-and-swap is rechecked at decision after a concurrent active change", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "governance-decision-cas" });
    const base = await s.memory.create(owner.sessionId, owner.branchId, {
      name: "decision-cas-memory",
      text: "base active value",
      memoryKind: "claim",
      scope: "local",
    });
    const { proposal, sourceEvidenceId } = await activateCandidate(s, owner, {
      operation: "replace",
      entryId: base.entryId,
      expectedVersionId: base.activeVersionId!,
      content: { kind: "memory", memoryKind: "claim", text: "candidate replacement" },
    });
    const candidateRows = await s.storage.readonlyQuery({
      sql: "SELECT version_id,version FROM harness_versions WHERE proposal_id=?",
      args: [proposal.proposalId],
    });
    const candidateVersionId = String((candidateRows[0] as any).version_id);
    const concurrentVersionId = newId();
    await s.storage.appendEvents([{
      sessionId: owner.sessionId,
      branchId: owner.branchId,
      type: "HarnessVersionCreated",
      producer: "client",
      idempotencyKey: `concurrent-active:${concurrentVersionId}`,
      payload: {
        entryId: base.entryId,
        versionId: concurrentVersionId,
        version: Number((candidateRows[0] as any).version) + 1,
        kind: "memory",
        scope: "local",
        scopeKey: owner.sessionId,
        name: "decision-cas-memory",
        content: { kind: "memory", memoryKind: "claim", text: "concurrent active value" },
        tags: [],
        confidence: 1,
        status: "active",
        evidenceEventIds: [sourceEvidenceId],
        conflictEntryIds: [],
        supersedesVersionId: candidateVersionId,
        createdBy: "user",
        lastConfirmedAt: new Date().toISOString(),
      },
    }]);
    await observeLocalCandidate(s, owner, proposal, sourceEvidenceId);

    await expect(s.harness.decide(owner.sessionId, owner.branchId, proposal.proposalId)).rejects.toThrow(
      /compare-and-swap|base|current|stale|version/i,
    );
    const active = await s.harness.getActive(base.entryId);
    const decisions = await s.storage.readonlyQuery({
      sql: "SELECT decision_id FROM refinement_decisions WHERE proposal_id=?",
      args: [proposal.proposalId],
    });
    expect({ activeVersionId: active?.current.versionId, decisions: decisions.length }).toEqual({
      activeVersionId: concurrentVersionId,
      decisions: 0,
    });
  });

  test("rollback of create restores a null prior active pointer and preserves historical context", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "governance-rollback-create" });
    const { proposal, sourceEvidenceId } = await activateCandidate(s, owner, {
      operation: "create",
      kind: "prompt_note",
      scope: "local",
      name: "rollback-created-note",
      content: { kind: "prompt_note", text: "created candidate content" },
    });
    const candidateRow = (await s.storage.readonlyQuery({
      sql: "SELECT entry_id FROM harness_versions WHERE proposal_id=?",
      args: [proposal.proposalId],
    }))[0] as any;
    const entryId = String(candidateRow.entry_id);
    expect((await s.harness.get(entryId))?.activeVersionId).toBeNull();
    await promoteLocalCandidate(s, owner, proposal, sourceEvidenceId);
    const historical = await s.contexts.materialize(owner.sessionId, owner.branchId);
    const before = await storedContext(s, historical.contextId);

    await s.harness.rollback(owner.sessionId, owner.branchId, proposal.proposalId, "undo create");
    expect(await s.harness.getActive(entryId)).toBeNull();
    expect(await storedContext(s, historical.contextId)).toEqual(before);
    expect((JSON.parse(String(before.context_json)) as any).harness.promptNotes[0].name).toBe(
      "rollback-created-note",
    );
  });

  test("rollback of replace restores the exact prior active pointer and preserves historical context", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "governance-rollback-replace" });
    const original = await s.memory.create(owner.sessionId, owner.branchId, {
      name: "rollback-replaced-memory",
      text: "original active content",
      memoryKind: "claim",
      scope: "local",
    });
    const priorActive = original.activeVersionId;
    const { proposal, sourceEvidenceId } = await activateCandidate(s, owner, {
      operation: "replace",
      entryId: original.entryId,
      expectedVersionId: original.currentVersionId,
      content: { kind: "memory", memoryKind: "claim", text: "replacement active content" },
    });
    await promoteLocalCandidate(s, owner, proposal, sourceEvidenceId);
    const promoted = await s.harness.getActive(original.entryId);
    expect(promoted?.current.versionId).not.toBe(priorActive);
    await s.appendMessage(
      owner.sessionId,
      owner.branchId,
      "user",
      "Show the replacement active content",
    );
    const historical = await s.contexts.materialize(owner.sessionId, owner.branchId);
    const before = await storedContext(s, historical.contextId);

    await s.harness.rollback(owner.sessionId, owner.branchId, proposal.proposalId, "undo replacement");
    expect((await s.harness.getActive(original.entryId))?.current.versionId ?? null).toBe(priorActive);
    expect(await storedContext(s, historical.contextId)).toEqual(before);
    expect((JSON.parse(String(before.context_json)) as any).harness.memories[0].content.text).toBe(
      "replacement active content",
    );
  });

  test("rollback of retire restores the exact prior active pointer and preserves historical context", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "governance-rollback-retire" });
    const original = await s.memory.create(owner.sessionId, owner.branchId, {
      name: "rollback-retired-memory",
      text: "must return after rollback",
      memoryKind: "claim",
      scope: "local",
    });
    const priorActive = original.activeVersionId;
    const { proposal, sourceEvidenceId } = await activateCandidate(s, owner, {
      operation: "retire",
      entryId: original.entryId,
      expectedVersionId: original.currentVersionId,
      reason: "candidate retirement",
    });
    await promoteLocalCandidate(s, owner, proposal, sourceEvidenceId);
    expect(await s.harness.getActive(original.entryId)).toBeNull();
    const historical = await s.contexts.materialize(owner.sessionId, owner.branchId);
    const before = await storedContext(s, historical.contextId);
    expect((historical.context as any).harness.memories).toEqual([]);

    await s.harness.rollback(owner.sessionId, owner.branchId, proposal.proposalId, "undo retirement");
    expect((await s.harness.getActive(original.entryId))?.current.versionId ?? null).toBe(priorActive);
    expect(await storedContext(s, historical.contextId)).toEqual(before);
  });

  test("conflicts stay attributable while an explicit global preference suppresses a lower inferred one", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const workspaceId = "governance-conflict-authority";
    const owner = await s.createSession({ workspaceId });
    const second = await s.createSession({ workspaceId });
    const { proposal } = await activateCandidate(s, owner, {
      operation: "create",
      kind: "memory",
      scope: "workspace",
      name: "inferred-workspace-preference",
      content: {
        kind: "memory",
        memoryKind: "preference",
        text: "formatter output preference is verbose",
      },
    });
    const firstAllocation = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId);
    const secondAllocation = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId, {
      sessionId: second.sessionId,
      branchId: second.branchId,
    });
    await s.contexts.materialize(owner.sessionId, owner.branchId);
    await s.contexts.materialize(second.sessionId, second.branchId);
    for (const [allocation, session, key] of [
      [firstAllocation, owner, "conflict-first"],
      [secondAllocation, second, "conflict-second"],
    ] as const) {
      const outcome = await objectiveEvidence(s, session.sessionId, session.branchId, key);
      await s.harness.recordObservation(owner.sessionId, owner.branchId, proposal.proposalId, {
        allocationId: allocation.allocationId,
        evaluator: "objective-conflict-setup",
        objective: true,
        success: true,
        metric: true,
        evidenceEventIds: [outcome.id],
      });
    }
    await s.harness.decide(owner.sessionId, owner.branchId, proposal.proposalId);
    const lowerRow = (await s.storage.readonlyQuery({
      sql: "SELECT entry_id FROM harness_versions WHERE proposal_id=?",
      args: [proposal.proposalId],
    }))[0] as any;
    const lowerEntryId = String(lowerRow.entry_id);

    const higher = await s.memory.create(owner.sessionId, owner.branchId, {
      name: "explicit-global-preference",
      text: "formatter output preference is concise",
      memoryKind: "preference",
      scope: "global",
      conflictEntryIds: [lowerEntryId],
      confidence: 1,
    });
    await s.appendMessage(
      owner.sessionId,
      owner.branchId,
      "user",
      "Which formatter output preference applies?",
    );

    const result = await s.memory.search(owner.sessionId, owner.branchId, "formatter output preference");
    expect(result.items.map((item) => item.record.name)).toEqual(["explicit-global-preference"]);
    const suppressed = result.provenance.rejections.find((item) => item.entryId === lowerEntryId);
    expect(suppressed?.reasons.some((reason) => /conflict|authority|suppress/i.test(reason))).toBe(true);

    const context = await s.contexts.materialize(owner.sessionId, owner.branchId);
    expect((context.context as any).harness.memories.map((item: any) => item.name)).toEqual([
      "explicit-global-preference",
    ]);
    expect(higher.current.conflictEntryIds).toContain(lowerEntryId);
    expect(await s.harness.history(lowerEntryId)).toHaveLength(1);
  });
});

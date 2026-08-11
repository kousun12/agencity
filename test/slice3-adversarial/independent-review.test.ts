import { afterEach, describe, expect, test } from "bun:test";
import { AgentRuntimeError, Supervisor, type HarnessEdit } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";
import {
  closeAdversarial,
  evidence,
  objectiveEvidence,
  openAdversarial,
  validatedProposal,
} from "./helpers.ts";

let current: { supervisor: Supervisor; temp: TempRuntime } | undefined;
afterEach(async () => { await closeAdversarial(current); current = undefined; });

type Session = { sessionId: string; branchId: string };

async function activate(
  supervisor: Supervisor,
  owner: Session,
  edit: HarnessEdit,
  limits: { allocationLimit: number; exposureLimit: number } = { allocationLimit: 3, exposureLimit: 3 },
) {
  const source = await evidence(supervisor, owner.sessionId, owner.branchId, `review source ${edit.operation}`);
  let proposal = await validatedProposal(supervisor, owner.sessionId, owner.branchId, [edit], [source.id]);
  if (proposal.status !== "validated") throw new Error(JSON.stringify(proposal.validation));
  proposal = await supervisor.harness.activate(owner.sessionId, owner.branchId, proposal.proposalId, limits);
  return { proposal, source };
}

async function effect(
  supervisor: Supervisor,
  session: Session,
  key: string,
  command: string,
) {
  const effectId = await supervisor.outbox.request({
    sessionId: session.sessionId,
    branchId: session.branchId,
    executor: "shell",
    operation: "run",
    input: { command },
    origin: { kind: "runtime", requestId: `independent-review:${key}` },
    idempotencyKey: `independent-review:${key}`,
    idempotent: true,
  });
  const result = await supervisor.outbox.run(effectId);
  if (result.outcome !== "succeeded") {
    throw new Error(`Objective evidence effect failed: ${JSON.stringify(result)}`);
  }
  return (await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }))
    .findLast((event) => event.type === "EffectOutcomeRecorded" && (event.payload as any).effectId === effectId)!;
}

describe("Slice 3 independent-review regressions", () => {
  test("A: control allocations beyond exposureLimit never deny materialization and remain hidden", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "review-a" });
    const treatment = await s.createSession({ workspaceId: "review-a" });
    const control = await s.createSession({ workspaceId: "review-a" });
    const { proposal } = await activate(s, owner, {
      operation: "create", kind: "prompt_note", scope: "workspace", name: "bounded-treatment",
      content: { kind: "prompt_note", text: "visible only to one treatment allocation" },
    }, { allocationLimit: 2, exposureLimit: 1 });
    const treatedAllocation = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId, treatment);
    const controlAllocation = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId, control);

    const treated = await s.contexts.materialize(treatment.sessionId, treatment.branchId);
    const untreated = await s.contexts.materialize(control.sessionId, control.branchId);
    expect((treated.context as any).harness.promptNotes.map((item:any) => item.name)).toEqual(["bounded-treatment"]);
    expect((untreated.context as any).harness.promptNotes).toEqual([]);
    expect((untreated.event.payload as any).harnessProvenance.candidates).toEqual([]);
    const allocations = await s.harness.allocations(proposal.candidateId!);
    expect(allocations.find((item) => item.allocationId === treatedAllocation.allocationId)?.exposedAt).not.toBeNull();
    expect(allocations.find((item) => item.allocationId === controlAllocation.allocationId)?.exposedAt).toBeNull();
  });

  test("B: console harness views are scope/exposure filtered while raw SQL is explicitly non-confidential", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const local = await s.createSession({ workspaceId: "review-b-local" });
    const foreign = await s.createSession({ workspaceId: "review-b-foreign" });
    const foreignEntry = await s.memory.create(foreign.sessionId, foreign.branchId, {
      name: "foreign-private-view", text: "foreign workspace content", scope: "local",
    });
    const { proposal } = await activate(s, local, {
      operation: "create", kind: "prompt_note", scope: "local", name: "unexposed-local-candidate",
      content: { kind: "prompt_note", text: "not visible before exact exposure" },
    }, { allocationLimit: 1, exposureLimit: 1 });
    const candidate = (await s.harness.list({ status: "candidate" })).find((item) => item.name === "unexposed-local-candidate")!;

    const before = await s.executeCell(local.sessionId, local.branchId, `
      const list = await sdk.harness.list();
      const foreignHistory = await sdk.harness.history(${JSON.stringify(foreignEntry.entryId)});
      const candidateHistory = await sdk.harness.history(${JSON.stringify(candidate.entryId)});
      return { names: list.map(x => x.name), foreignHistory, candidateHistory };
    `);
    expect((before.result as any).names).not.toContain("foreign-private-view");
    expect((before.result as any).names).not.toContain("unexposed-local-candidate");
    expect((before.result as any).foreignHistory).toEqual([]);
    expect((before.result as any).candidateHistory).toEqual([]);

    await s.harness.allocate(local.sessionId, local.branchId, proposal.proposalId);
    await s.contexts.materialize(local.sessionId, local.branchId);
    const after = await s.executeCell(local.sessionId, local.branchId, `return await sdk.harness.list();`);
    expect((after.result as any[]).map((item) => item.name)).toContain("unexposed-local-candidate");

    const diagnostic = await s.executeCell(local.sessionId, local.branchId, `
      const foreignId = ${JSON.stringify(foreignEntry.entryId)};
      const rows = await sql\`SELECT name FROM harness_entries WHERE entry_id = \${foreignId}\`;
      return rows;
    `);
    expect((diagnostic.result as any)[0].name).toBe("foreign-private-view");
    const context = await s.contexts.materialize(local.sessionId, local.branchId);
    expect((context.context as any).runtime.rawSql).toEqual({
      readOnly: true,
      scope: "shared-non-confidential-diagnostics",
      candidateIsolationIsConfidentialityBoundary: false,
    });
  });

  test("C: explicit global preference wins a symmetric conflict declared only by lower inferred memory", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "review-c" });
    const second = await s.createSession({ workspaceId: "review-c" });
    const higher = await s.memory.create(owner.sessionId, owner.branchId, {
      name: "explicit-global-format", text: "review formatter preference concise", memoryKind: "preference", scope: "global",
    });
    const { proposal } = await activate(s, owner, {
      operation: "create", kind: "memory", scope: "workspace", name: "inferred-workspace-format",
      content: { kind: "memory", memoryKind: "preference", text: "review formatter preference verbose" },
      conflictEntryIds: [higher.entryId],
    });
    const allocations = [
      await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId),
      await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId, second),
    ];
    for (const [index, session] of [owner, second].entries()) {
      await s.contexts.materialize(session.sessionId, session.branchId);
      const outcome = await objectiveEvidence(s, session.sessionId, session.branchId, `review-c-${index}`);
      await s.harness.recordObservation(owner.sessionId, owner.branchId, proposal.proposalId, {
        allocationId: allocations[index]!.allocationId, evaluator: "review-c-evaluator", objective: true,
        success: true, metric: { passed: true }, evidenceEventIds: [outcome.id],
      });
    }
    await s.harness.decide(owner.sessionId, owner.branchId, proposal.proposalId);
    const result = await s.memory.search(owner.sessionId, owner.branchId, "review formatter preference");
    expect(result.items.map((item) => item.record.entryId)).toEqual([higher.entryId]);
    expect(result.provenance.conflicts).toEqual([expect.objectContaining({
      declaredByEntryIds: [expect.any(String)], winnerEntryId: higher.entryId,
      suppressedEntryId: expect.any(String),
    })]);
    expect(result.provenance.conflicts[0]!.declaredByEntryIds).not.toContain(higher.entryId);
  });

  test("D: objective evidence and declared metric/command are bound to the exact allocation", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "review-d" });
    const treatment = await s.createSession({ workspaceId: "review-d" });
    const source = await evidence(s, owner.sessionId, owner.branchId, "review-d source");
    let proposal = await s.harness.propose(owner.sessionId, owner.branchId, {
      trigger: "objective binding", predictedEffect: "exact allocated command passes", evidenceEventIds: [source.id],
      evaluation: { kind: "objective", name: "allocated command", metric: "passed", target: true, testCommand: "printf allocated" },
      edits: [{ operation: "create", kind: "prompt_note", scope: "workspace", name: "objective-binding", content: { kind: "prompt_note", text: "measure exact allocation" } }],
    });
    proposal = await s.harness.validate(owner.sessionId, owner.branchId, proposal.proposalId);
    proposal = await s.harness.activate(owner.sessionId, owner.branchId, proposal.proposalId, { allocationLimit: 1, exposureLimit: 1 });
    const allocation = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId, treatment);
    await s.contexts.materialize(treatment.sessionId, treatment.branchId);
    const ownerOutcome = await effect(s, owner, "wrong-session", "printf allocated");
    await expect(s.harness.recordObservation(owner.sessionId, owner.branchId, proposal.proposalId, {
      allocationId: allocation.allocationId, evaluator: "review-d", objective: true, success: true,
      metric: { passed: true }, evidenceEventIds: [ownerOutcome.id],
    })).rejects.toThrow(/exact allocation|session|branch/i);
    const unrelated = await effect(s, treatment, "wrong-command", "true");
    await expect(s.harness.recordObservation(owner.sessionId, owner.branchId, proposal.proposalId, {
      allocationId: allocation.allocationId, evaluator: "review-d", objective: true, success: true,
      metric: { passed: true }, evidenceEventIds: [unrelated.id],
    })).rejects.toThrow(/test command|predeclared/i);
    const exact = await effect(s, treatment, "exact", "printf allocated");
    await expect(s.harness.recordObservation(owner.sessionId, owner.branchId, proposal.proposalId, {
      allocationId: allocation.allocationId, evaluator: "review-d", objective: true, success: true,
      metric: { latency: 1 } as any, evidenceEventIds: [exact.id],
    })).rejects.toThrow(/metric|passed/i);
    const observed = await s.harness.recordObservation(owner.sessionId, owner.branchId, proposal.proposalId, {
      allocationId: allocation.allocationId, evaluator: "review-d", objective: true, success: true,
      metric: { passed: true }, evidenceEventIds: [exact.id],
    });
    expect(observed.success).toBe(true);
  });

  test("F: revise rejects candidate versions and immediately frees a create name", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "review-f" });
    const first = await activate(s, owner, {
      operation: "create", kind: "prompt_note", scope: "local", name: "revisable-name",
      content: { kind: "prompt_note", text: "first revision" },
    }, { allocationLimit: 1, exposureLimit: 1 });
    const allocation = await s.harness.allocate(owner.sessionId, owner.branchId, first.proposal.proposalId);
    await s.contexts.materialize(owner.sessionId, owner.branchId);
    await s.harness.recordObservation(owner.sessionId, owner.branchId, first.proposal.proposalId, {
      allocationId: allocation.allocationId, evaluator: "review-f", objective: false,
      success: false, metric: false, evidenceEventIds: [first.source.id],
    });
    await s.harness.decide(owner.sessionId, owner.branchId, first.proposal.proposalId, { decision: "revise" });
    const oldVersions = await s.storage.readonlyQuery({ sql: "SELECT status FROM harness_versions WHERE proposal_id=?", args: [first.proposal.proposalId] });
    expect(oldVersions.map((row:any) => row.status)).toEqual(["rejected"]);

    const nextSource = await evidence(s, owner.sessionId, owner.branchId, "revised source");
    const revised = await validatedProposal(s, owner.sessionId, owner.branchId, [{
      operation: "create", kind: "prompt_note", scope: "local", name: "revisable-name",
      content: { kind: "prompt_note", text: "second revision" },
    }], [nextSource.id]);
    expect(revised.status).toBe("validated");
    expect((await s.harness.activate(owner.sessionId, owner.branchId, revised.proposalId)).status).toBe("candidate");
  });

  test("G: concurrent duplicate-name activation is typed and atomic", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "review-g" });
    const source = await evidence(s, owner.sessionId, owner.branchId, "duplicate activation source");
    const edit: HarnessEdit = { operation: "create", kind: "prompt_note", scope: "local", name: "one-concurrent-name", content: { kind: "prompt_note", text: "same candidate name" } };
    const proposals = await Promise.all([
      validatedProposal(s, owner.sessionId, owner.branchId, [edit], [source.id]),
      validatedProposal(s, owner.sessionId, owner.branchId, [edit], [source.id]),
    ]);
    const settled = await Promise.allSettled(proposals.map((proposal) => s.harness.activate(owner.sessionId, owner.branchId, proposal.proposalId)));
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejection = settled.find((item) => item.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(AgentRuntimeError);
    expect(["CONFLICT", "VALIDATION_ERROR"]).toContain(rejection.reason.code);
    const rows = await s.storage.readonlyQuery({ sql: "SELECT version_id FROM harness_versions WHERE proposal_id IN (?,?)", args: proposals.map((proposal) => proposal.proposalId) });
    expect(rows).toHaveLength(1);
  });

  test("H: foreign local/workspace replacement and retirement fail validation and activation recheck", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const a = await s.createSession({ workspaceId: "review-h-a" });
    const b = await s.createSession({ workspaceId: "review-h-b" });
    const foreign = await s.memory.create(b.sessionId, b.branchId, { name: "foreign-owned", text: "owned by B", scope: "workspace" });
    const source = await evidence(s, a.sessionId, a.branchId, "foreign edit attempt");
    for (const edit of [
      { operation: "replace", entryId: foreign.entryId, expectedVersionId: foreign.currentVersionId, content: { kind: "memory", memoryKind: "claim", text: "stolen" } },
      { operation: "retire", entryId: foreign.entryId, expectedVersionId: foreign.currentVersionId, reason: "stolen retirement" },
    ] as HarnessEdit[]) {
      const proposed = await s.harness.propose(a.sessionId, a.branchId, {
        trigger: "foreign scope attempt", predictedEffect: "must fail", evidenceEventIds: [source.id],
        evaluation: { kind: "objective", name: "denied", metric: "passed", target: true }, edits: [edit],
      });
      const validated = await s.harness.validate(a.sessionId, a.branchId, proposed.proposalId);
      expect(validated.status).toBe("revision_required");
    }

    const forged = await s.harness.propose(a.sessionId, a.branchId, {
      trigger: "activation scope recheck", predictedEffect: "must fail", evidenceEventIds: [source.id],
      evaluation: { kind: "objective", name: "denied", metric: "passed", target: true },
      edits: [{ operation: "replace", entryId: foreign.entryId, expectedVersionId: foreign.currentVersionId, content: { kind: "memory", memoryKind: "claim", text: "still stolen" } }],
    });
    await s.storage.appendEvents([{
      sessionId: a.sessionId, branchId: a.branchId, type: "RefinementValidated", producer: "supervisor",
      idempotencyKey: `forged-validation:${forged.proposalId}`,
      payload: { proposalId: forged.proposalId, valid: true, validation: { forged: true }, expectedProposalStatus: "proposed" },
    }]);
    await expect(s.harness.activate(a.sessionId, a.branchId, forged.proposalId)).rejects.toThrow(/another|scope|workspace/i);
    expect(await s.storage.readonlyQuery({ sql: "SELECT version_id FROM harness_versions WHERE proposal_id=?", args: [forged.proposalId] })).toEqual([]);
  });

  test("user/global rollback needs separate owner/admin approval, not promotion approval", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "review-rollback" });
    const { proposal } = await activate(s, owner, {
      operation: "create", kind: "memory", scope: "global", name: "global-rollback-approval",
      content: { kind: "memory", memoryKind: "preference", text: "global rollback approval" },
    }, { allocationLimit: 1, exposureLimit: 1 });
    await s.harness.approve(owner.sessionId, owner.branchId, proposal.proposalId, "global", "default-user");
    await s.harness.decide(owner.sessionId, owner.branchId, proposal.proposalId);
    await expect(s.harness.rollback(owner.sessionId, owner.branchId, proposal.proposalId, "regression")).rejects.toThrow(/separate|rollback approval|owner|admin/i);
    await s.harness.approveRollback(owner.sessionId, owner.branchId, proposal.proposalId, { approvedBy: "default-user", role: "owner" });
    expect((await s.harness.rollback(owner.sessionId, owner.branchId, proposal.proposalId, "regression")).status).toBe("rolled_back");
  });

  test("configured skill permission allowlist is rechecked at activation and invocation", async () => {
    const temp = await makeTempRuntime("agencity-review-skill-permissions-");
    const open = (allowlist: string[]) => Supervisor.open({
      databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot,
      recover: false, skillPermissionAllowlist: allowlist,
    });
    let s = await open(["filesystem"]);
    try {
      const owner = await s.createSession({ workspaceId: "review-skill-permission" });
      const source = await evidence(s, owner.sessionId, owner.branchId, "permission source");
      let proposal = await validatedProposal(s, owner.sessionId, owner.branchId, [{
        operation: "create", kind: "skill", scope: "local", name: "allowed-filesystem-skill",
        content: { kind: "skill", description: "permission pin", source: "export default (input: unknown) => input", permissions: ["filesystem"], runtime: "bun", tests: [{ name: "identity", input: "ok", expected: "ok" }] },
      }], [source.id]);
      expect(proposal.status).toBe("validated");
      await s.close();
      s = await open([]);
      await expect(s.harness.activate(owner.sessionId, owner.branchId, proposal.proposalId)).rejects.toThrow(/permission|allow/i);
      expect(await s.storage.readonlyQuery({ sql: "SELECT version_id FROM harness_versions WHERE proposal_id=?", args: [proposal.proposalId] })).toEqual([]);

      await s.close();
      s = await open(["filesystem"]);
      proposal = await s.harness.activate(owner.sessionId, owner.branchId, proposal.proposalId, { allocationLimit: 1, exposureLimit: 1 });
      const allocation = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId);
      await s.contexts.materialize(owner.sessionId, owner.branchId);
      await s.harness.recordObservation(owner.sessionId, owner.branchId, proposal.proposalId, {
        allocationId: allocation.allocationId, evaluator: "permission evaluator", objective: false,
        success: true, metric: true, evidenceEventIds: [source.id],
      });
      await s.harness.decide(owner.sessionId, owner.branchId, proposal.proposalId);
      const skill = (await s.harness.list({ kind: "skill", status: "active" }))[0]!;
      await s.close();
      s = await open([]);
      await expect(s.skills.invoke(owner.sessionId, owner.branchId, skill.entryId, "blocked")).rejects.toThrow(/permission|allow/i);
    } finally {
      await s.close();
      await removeTempRuntime(temp);
    }
  });

  test("objective evidence must be observed after its candidate exposure", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "post-exposure" });
    const second = await s.createSession({ workspaceId: "post-exposure" });
    const { proposal } = await activate(s, owner, {
      operation: "create",
      kind: "prompt_note",
      scope: "workspace",
      name: "post-exposure-note",
      content: { kind: "prompt_note", text: "Only post-exposure outcomes count." },
    }, { allocationLimit: 2, exposureLimit: 2 });
    const ownerAllocation = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId);
    const secondAllocation = await s.harness.allocate(owner.sessionId, owner.branchId, proposal.proposalId, {
      sessionId: second.sessionId,
      branchId: second.branchId,
    });
    const staleEvidence = await effect(s, second, "pre-exposure", "true");
    await s.contexts.materialize(owner.sessionId, owner.branchId);
    await s.contexts.materialize(second.sessionId, second.branchId);
    const currentEvidence = await effect(s, owner, "post-exposure", "true");
    await s.harness.recordObservation(owner.sessionId, owner.branchId, proposal.proposalId, {
      allocationId: ownerAllocation.allocationId,
      evaluator: "post-exposure evaluator",
      objective: true,
      success: true,
      metric: { passed: true },
      evidenceEventIds: [currentEvidence.id],
    });
    await expect(s.harness.recordObservation(owner.sessionId, owner.branchId, proposal.proposalId, {
      allocationId: secondAllocation.allocationId,
      evaluator: "pre-exposure evaluator",
      objective: true,
      success: true,
      metric: { passed: true },
      evidenceEventIds: [staleEvidence.id],
    })).rejects.toThrow(/after.*exposure|post-exposure/i);
  });
});

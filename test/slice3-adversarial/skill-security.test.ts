import { afterEach, describe, expect, test } from "bun:test";
import {
  MemoryService,
  type HarnessContent,
  type MemoryCandidateIndex,
  type Supervisor,
} from "../../src/index.ts";
import type { TempRuntime } from "../helpers.ts";
import {
  activeLocalEntry,
  closeAdversarial,
  evidence,
  openAdversarial,
  reopenAdversarial,
  validatedProposal,
  waitFor,
} from "./helpers.ts";

let current: { supervisor: Supervisor; temp: TempRuntime } | undefined;
const originalBrokeredSecret = process.env.AGENCITY_SKILL_TEST_API_KEY;
const originalDatabaseHandle = process.env.AGENCITY_CANONICAL_DB_HANDLE;

afterEach(async () => {
  if (originalBrokeredSecret === undefined) delete process.env.AGENCITY_SKILL_TEST_API_KEY;
  else process.env.AGENCITY_SKILL_TEST_API_KEY = originalBrokeredSecret;
  if (originalDatabaseHandle === undefined) delete process.env.AGENCITY_CANONICAL_DB_HANDLE;
  else process.env.AGENCITY_CANONICAL_DB_HANDLE = originalDatabaseHandle;
  await closeAdversarial(current);
  current = undefined;
});

function skill(
  source: string,
  tests: Extract<HarnessContent, { kind: "skill" }>["tests"],
  inputSchema?: Extract<HarnessContent, { kind: "skill" }>["inputSchema"],
): Extract<HarnessContent, { kind: "skill" }> {
  return {
    kind: "skill",
    description: "adversarial generated skill",
    source,
    ...(inputSchema === undefined ? {} : { inputSchema }),
    permissions: [],
    runtime: "bun",
    tests,
  };
}

async function promoteCandidate(
  supervisor: Supervisor,
  sessionId: string,
  branchId: string,
  proposalId: string,
  evidenceEventId: string,
): Promise<void> {
  const allocation = await supervisor.harness.allocate(sessionId, branchId, proposalId);
  await supervisor.contexts.materialize(sessionId, branchId);
  await supervisor.harness.recordObservation(sessionId, branchId, proposalId, {
    allocationId: allocation.allocationId,
    evaluator: "adversarial-skill-observer",
    objective: false,
    success: true,
    metric: true,
    evidenceEventIds: [evidenceEventId],
  });
  await supervisor.harness.decide(sessionId, branchId, proposalId);
}

async function replacementSkillProposal(
  supervisor: Supervisor,
  sessionId: string,
  branchId: string,
  entryId: string,
  expectedVersionId: string,
  content: Extract<HarnessContent, { kind: "skill" }>,
  evidenceEventId: string,
) {
  return validatedProposal(supervisor, sessionId, branchId, [{
    operation: "replace",
    entryId,
    expectedVersionId,
    content,
  }], [evidenceEventId]);
}

function eventCount(events: Awaited<ReturnType<Supervisor["storage"]["loadEvents"]>>, type: string): number {
  return events.filter((event) => event.type === type).length;
}

describe("Slice 3 generated skill security and durable execution", () => {
  test("candidate skill code receives neither brokered environment secrets nor the canonical database handle", async () => {
    const secret = "candidate-brokered-secret-4e1d";
    current = await openAdversarial();
    process.env.AGENCITY_SKILL_TEST_API_KEY = secret;
    process.env.AGENCITY_CANONICAL_DB_HANDLE = current.temp.databaseUrl;
    const s = current.supervisor;
    const session = await s.createSession({ workspaceId: "w" });

    const entry = await activeLocalEntry(
      s,
      session.sessionId,
      session.branchId,
      "skill",
      "environment-probe",
      skill(`
        export default () => ({
          secret: process.env.AGENCITY_SKILL_TEST_API_KEY ?? null,
          databaseHandle: process.env.AGENCITY_CANONICAL_DB_HANDLE ?? null,
          injectedDatabase: (globalThis as any).__AGENCITY_DATABASE__ === undefined ? null : "present",
          injectedStorage: (globalThis as any).__AGENCITY_STORAGE__ === undefined ? null : "present",
        });
      `, [{
        name: "generated candidate has no privileged handles",
        input: null,
        expected: { secret: null, databaseHandle: null, injectedDatabase: null, injectedStorage: null },
      }]),
    );

    const rows = await s.storage.readonlyQuery({
      sql: "SELECT version_id,passed,report_json FROM skill_executions WHERE entry_id=? AND execution_kind='test'",
      args: [entry.entryId],
    });
    // Activation and the exact exposed allocation each retain a distinct test boundary.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ version_id: entry.current.versionId, passed: 1 });
    const durable = JSON.stringify(await s.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
    expect(durable).not.toContain(secret);
    expect(durable).not.toContain(current.temp.databaseUrl);
  });

  test("missing tests and compile, runtime, or schema failures all block candidate activation", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const session = await s.createSession({ workspaceId: "w" });
    const ev = await evidence(s, session.sessionId, session.branchId, "generated-skill gate evidence");

    const rejectedAtValidation = [
      {
        name: "missing-tests",
        content: skill("export default () => null;", []),
      },
      {
        name: "invalid-schema",
        content: skill(
          "export default () => null;",
          [{ name: "would otherwise pass", input: null, expected: null }],
          { type: "not-a-json-schema-type" },
        ),
      },
    ];
    for (const item of rejectedAtValidation) {
      const proposal = await validatedProposal(s, session.sessionId, session.branchId, [{
        operation: "create",
        kind: "skill",
        scope: "local",
        name: item.name,
        content: item.content,
      }], [ev.id]);
      expect(proposal.status).toBe("revision_required");
      await expect(s.harness.activate(session.sessionId, session.branchId, proposal.proposalId))
        .rejects.toThrow(/validated|test|schema|runtime/i);
    }

    const rejectedAtExecution = [
      {
        name: "compile-failure",
        content: skill("export default (", [{ name: "compile", input: null, expected: null }]),
      },
      {
        name: "runtime-failure",
        content: skill(
          'export default () => { throw new Error("runtime exploded"); };',
          [{ name: "must return", input: null, expected: null }],
        ),
      },
    ];
    for (const item of rejectedAtExecution) {
      let proposal = await validatedProposal(s, session.sessionId, session.branchId, [{
        operation: "create",
        kind: "skill",
        scope: "local",
        name: item.name,
        content: item.content,
      }], [ev.id]);
      expect(proposal.status).toBe("validated");
      await expect(s.harness.activate(session.sessionId, session.branchId, proposal.proposalId))
        .rejects.toThrow(/compile|runtime|test/i);
      proposal = (await s.harness.proposals()).find((candidate) => candidate.proposalId === proposal.proposalId)!;
      expect(proposal.status).not.toBe("candidate");
      const versions = await s.storage.readonlyQuery({
        sql: "SELECT status FROM harness_versions WHERE proposal_id=?",
        args: [proposal.proposalId],
      });
      expect(versions).toEqual([{ status: "rejected" }]);
    }

    const events = await s.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    expect(eventCount(events, "RefinementCandidateActivated")).toBe(0);
  });

  test("test requests and outcomes are pinned to immutable source versions and changed source must pass again", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const session = await s.createSession({ workspaceId: "w" });
    const sourceV1 = "export default (input:{n:number}) => ({n:input.n+1});";
    const sourceV2 = "export default (input:{n:number}) => ({n:input.n+100});";
    const entry = await activeLocalEntry(
      s,
      session.sessionId,
      session.branchId,
      "skill",
      "source-pinning",
      skill(sourceV1, [{ name: "increment", input: { n: 1 }, expected: { n: 2 } }], {
        type: "object",
        required: ["n"],
      }),
    );
    const versionV1 = entry.current.versionId;
    const ev = await evidence(s, session.sessionId, session.branchId, "changed skill source");
    const replacement = await replacementSkillProposal(
      s,
      session.sessionId,
      session.branchId,
      entry.entryId,
      versionV1,
      skill(sourceV2, [{ name: "increment", input: { n: 1 }, expected: { n: 2 } }], {
        type: "object",
        required: ["n"],
      }),
      ev.id,
    );
    expect(replacement.status).toBe("validated");
    await expect(s.harness.activate(session.sessionId, session.branchId, replacement.proposalId))
      .rejects.toThrow(/compile|runtime|test/i);

    const versions = await s.harness.history(entry.entryId);
    expect(versions).toHaveLength(2);
    const versionV2 = versions.find((version) => version.versionId !== versionV1)!;
    expect(versionV2.content).toMatchObject({ kind: "skill", source: sourceV2 });
    expect(versionV2.status).toBe("rejected");
    expect((await s.harness.getActive(entry.entryId))?.current.versionId).toBe(versionV1);

    const executions = await s.storage.readonlyQuery({
      sql: "SELECT version_id,effect_id,passed FROM skill_executions WHERE entry_id=? AND execution_kind='test' ORDER BY created_at,event_id",
      args: [entry.entryId],
    }) as Array<{ version_id: string; effect_id: string; passed: number }>;
    expect(executions.map((row) => [row.version_id, row.passed])).toEqual([
      [versionV1, 1],
      [versionV1, 1], // required post-exposure same-version retest
      [versionV2.versionId, 0],
    ]);

    const requests = (await s.storage.loadEvents(session.sessionId, { branchId: session.branchId }))
      .filter((event) => event.type === "EffectRequested" && (event.payload as any).executor === "skill" && (event.payload as any).operation === "test");
    expect(requests).toHaveLength(3); // v1 activation + exposed retest, then v2 activation
    const requestByVersion = new Map(requests.map((event) => [
      String((event.payload as any).input.versionId),
      (event.payload as any).input,
    ]));
    expect(requestByVersion.get(versionV1)).toMatchObject({ versionId: versionV1, source: sourceV1 });
    expect(requestByVersion.get(versionV2.versionId)).toMatchObject({ versionId: versionV2.versionId, source: sourceV2 });
  });

  test("invocation resolves only the exact active version before and after replacement promotion", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const session = await s.createSession({ workspaceId: "w" });
    const entry = await activeLocalEntry(
      s,
      session.sessionId,
      session.branchId,
      "skill",
      "active-version-only",
      skill(
        "export default (input:{n:number}) => ({n:input.n+1});",
        [{ name: "v1", input: { n: 1 }, expected: { n: 2 } }],
        { type: "object", required: ["n"] },
      ),
    );
    const v1 = entry.current.versionId;
    const ev = await evidence(s, session.sessionId, session.branchId, "v2 source evidence");
    let replacement = await replacementSkillProposal(
      s,
      session.sessionId,
      session.branchId,
      entry.entryId,
      v1,
      skill(
        "export default (input:{n:number}) => ({n:input.n+2});",
        [{ name: "v2", input: { n: 1 }, expected: { n: 3 } }],
        { type: "object", required: ["n"] },
      ),
      ev.id,
    );
    replacement = await s.harness.activate(session.sessionId, session.branchId, replacement.proposalId);
    const candidate = (await s.harness.history(entry.entryId)).find((version) => version.versionId !== v1)!;

    const before = await s.skills.invoke(session.sessionId, session.branchId, entry.entryId, { n: 5 });
    expect(before).toMatchObject({
      versionId: v1,
      outcome: "succeeded",
      output: { compiled: true, versionId: v1, value: { n: 6 } },
    });
    await expect(s.skills.invoke(session.sessionId, session.branchId, entry.entryId, { n: 5 }, {
      versionId: candidate.versionId,
    })).rejects.toThrow(/candidate|active|invocable/i);

    await promoteCandidate(s, session.sessionId, session.branchId, replacement.proposalId, ev.id);
    const after = await s.skills.invoke(session.sessionId, session.branchId, entry.entryId, { n: 5 });
    expect(after).toMatchObject({
      versionId: candidate.versionId,
      outcome: "succeeded",
      output: { compiled: true, versionId: candidate.versionId, value: { n: 7 } },
    });
    await expect(s.skills.invoke(session.sessionId, session.branchId, entry.entryId, { n: 5 }, { versionId: v1 }))
      .rejects.toThrow(/retired|active|invocable/i);
  });

  test("cancelled and lease-timeout unknown skill effects are durable and never blindly retried", async () => {
    current = await openAdversarial();
    let s = current.supervisor;
    const session = await s.createSession({ workspaceId: "w" });
    const source = `
      export default async (input:{mode:string}) => {
        if (input.mode === "block") await Bun.sleep(60_000);
        return {mode: input.mode};
      };
    `;
    const entry = await activeLocalEntry(
      s,
      session.sessionId,
      session.branchId,
      "skill",
      "cancel-and-unknown",
      skill(source, [{ name: "quick", input: { mode: "quick" }, expected: { mode: "quick" } }], {
        type: "object",
        required: ["mode"],
      }),
    );

    const cancelledPromise = s.skills.invoke(
      session.sessionId,
      session.branchId,
      entry.entryId,
      { mode: "block" },
      { versionId: entry.current.versionId, idempotencyKey: "cancelled-skill-invocation" },
    );
    let cancelledEffectId = "";
    await waitFor(async () => {
      const record = (await s.storage.listOutbox()).find((item) => item.idempotencyKey === "cancelled-skill-invocation");
      if (!record) return false;
      cancelledEffectId = record.effectId;
      return s.outbox.cancel(record.effectId);
    }, "skill executor to become cancellable", 5_000);
    const cancelled = await cancelledPromise;
    expect(cancelled).toMatchObject({ effectId: cancelledEffectId, outcome: "cancelled" });
    const cancelledAgain = await s.skills.invoke(
      session.sessionId,
      session.branchId,
      entry.entryId,
      { mode: "block" },
      { versionId: entry.current.versionId, idempotencyKey: "cancelled-skill-invocation" },
    );
    expect(cancelledAgain).toMatchObject({ effectId: cancelledEffectId, outcome: "cancelled" });

    const ambiguousKey = "lease-timeout-skill-invocation";
    const ambiguousInput = {
      entryId: entry.entryId,
      versionId: entry.current.versionId,
      source,
      input: { mode: "quick" },
    } as const;
    const unknownEffectId = await s.outbox.request({
      sessionId: session.sessionId,
      branchId: session.branchId,
      executor: "skill",
      operation: "invoke",
      input: ambiguousInput,
      idempotencyKey: ambiguousKey,
      idempotent: false,
    });
    await s.storage.appendEvents([{
      sessionId: session.sessionId,
      branchId: session.branchId,
      type: "SkillInvocationRecorded",
      producer: "supervisor",
      idempotencyKey: `skill-invocation:${unknownEffectId}`,
      payload: {
        entryId: entry.entryId,
        versionId: entry.current.versionId,
        effectId: unknownEffectId,
        input: { mode: "quick" },
      },
    }]);
    const claimed = await s.storage.claimEffect(unknownEffectId, "dead-skill-owner", 1);
    expect(claimed?.status).toBe("running");
    await s.storage.appendEvents([{
      sessionId: session.sessionId,
      branchId: session.branchId,
      type: "EffectAttemptStarted",
      producer: "executor",
      idempotencyKey: `effect-attempt:${unknownEffectId}:1`,
      payload: { effectId: unknownEffectId, attempt: 1 },
    }]);
    await Bun.sleep(5);

    current = await reopenAdversarial(current, true);
    s = current.supervisor;
    expect(await s.storage.getOutbox(unknownEffectId)).toMatchObject({ status: "unknown", attempt: 1 });
    expect(await s.outbox.run(unknownEffectId)).toMatchObject({ outcome: "unknown" });
    const sameUnknownEffectId = await s.outbox.request({
      sessionId: session.sessionId,
      branchId: session.branchId,
      executor: "skill",
      operation: "invoke",
      input: ambiguousInput,
      idempotencyKey: ambiguousKey,
      idempotent: false,
    });
    expect(sameUnknownEffectId).toBe(unknownEffectId);
    expect(await s.outbox.run(sameUnknownEffectId)).toMatchObject({ outcome: "unknown" });

    const events = await s.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    const attempts = events.filter((event) => event.type === "EffectAttemptStarted");
    const outcomes = events.filter((event) => event.type === "EffectOutcomeRecorded");
    expect(attempts.filter((event) => (event.payload as any).effectId === cancelledEffectId)).toHaveLength(1);
    expect(outcomes.filter((event) => (event.payload as any).effectId === cancelledEffectId)).toHaveLength(1);
    expect(attempts.filter((event) => (event.payload as any).effectId === unknownEffectId)).toHaveLength(1);
    expect(outcomes.filter((event) => (event.payload as any).effectId === unknownEffectId)).toHaveLength(1);
  });
});

describe("Slice 3 subagent specification invocation identity", () => {
  test("implicit invocations create distinct durable tasks while an explicit stable key deduplicates", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const session = await s.createSession({ workspaceId: "w" });
    const spec = await activeLocalEntry(
      s,
      session.sessionId,
      session.branchId,
      "subagent_spec",
      "independent-reviewer",
      {
        kind: "subagent_spec",
        role: "reviewer",
        invocationCriteria: "a review is requested",
        expectedArtifact: "review report",
        prompt: "Review independently.",
        completionCriteria: "report delivered",
      },
    );

    const first = await s.specs.spawn(session.sessionId, session.branchId, spec.entryId, {
      versionId: spec.current.versionId,
      task: "Review the same patch",
    });
    const second = await s.specs.spawn(session.sessionId, session.branchId, spec.entryId, {
      versionId: spec.current.versionId,
      task: "Review the same patch",
    });
    expect(second.taskId).not.toBe(first.taskId);
    expect(second.sessionId).not.toBe(first.sessionId);

    const stableFirst = await s.specs.spawn(session.sessionId, session.branchId, spec.entryId, {
      versionId: spec.current.versionId,
      task: "Review the stable work item",
      idempotencyKey: "stable-review-work-item",
    });
    const stableAgain = await s.specs.spawn(session.sessionId, session.branchId, spec.entryId, {
      versionId: spec.current.versionId,
      task: "Review the stable work item",
      idempotencyKey: "stable-review-work-item",
    });
    expect(stableAgain.taskId).toBe(stableFirst.taskId);
    expect(stableAgain.sessionId).toBe(stableFirst.sessionId);
    const materializedProfile = await s.agentProfiles.active(stableFirst.sessionId);
    expect(materializedProfile.sourceSpecEntryId).toBe(spec.entryId);
    expect(materializedProfile.sourceSpecVersionId).toBe(spec.current.versionId);
    expect(materializedProfile.role).toBe("reviewer");

    const invocations = await s.storage.readonlyQuery({
      sql: "SELECT version_id,task_id FROM subagent_spec_invocations WHERE entry_id=? ORDER BY task_id",
      args: [spec.entryId],
    });
    expect(invocations).toHaveLength(3);
    expect(new Set(invocations.map((row: any) => row.task_id)).size).toBe(3);
    expect(invocations.every((row: any) => row.version_id === spec.current.versionId)).toBe(true);
  });
});

describe("Slice 3 candidate-index adversarial conformance", () => {
  test("FTS metacharacters are escaped, ties are stable, and rebuild preserves identities and order", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const session = await s.createSession({ workspaceId: "w" });
    const lastConfirmedAt = "2026-08-05T12:00:00.000Z";
    await s.storage.appendEvents(["a", "b"].map((suffix) => ({
      id: `event-fts-tie-${suffix}`,
      sessionId: session.sessionId,
      branchId: session.branchId,
      type: "HarnessVersionCreated" as const,
      producer: "client" as const,
      idempotencyKey: `memory:entry-fts-tie-${suffix}`,
      payload: {
        entryId: `entry-fts-tie-${suffix}`,
        versionId: `version-fts-tie-${suffix}`,
        version: 1,
        kind: "memory" as const,
        scope: "local" as const,
        scopeKey: session.sessionId,
        name: `fts-tie-${suffix}`,
        content: { kind: "memory", memoryKind: "observation", text: "needle identical ranking text" },
        tags: ["tie"],
        confidence: 0.5,
        status: "active" as const,
        evidenceEventIds: [],
        conflictEntryIds: [],
        createdBy: "user",
        lastConfirmedAt,
      },
    })));

    const hostileQuery = String.raw`needle" OR * -()[]{} + ^ : NEAR/3`;
    const first = await s.memory.search(session.sessionId, session.branchId, hostileQuery, { tags: ["tie"] });
    expect(first.items.map((item) => item.record.current.versionId)).toEqual([
      "version-fts-tie-a",
      "version-fts-tie-b",
    ]);
    expect(first.provenance.normalizedQuery).toBe("needle or near 3");

    const repeated = await s.memory.search(session.sessionId, session.branchId, hostileQuery, { tags: ["tie"] });
    expect(repeated.provenance.selections).toEqual(first.provenance.selections);
    await s.memory.index.rebuild();
    const rebuilt = await s.memory.search(session.sessionId, session.branchId, hostileQuery, { tags: ["tie"] });
    expect(rebuilt.provenance.selections).toEqual(first.provenance.selections);
    expect(rebuilt.items.map((item) => item.record.entryId)).toEqual([
      "entry-fts-tie-a",
      "entry-fts-tie-b",
    ]);
  });

  test("a remote candidate-index fake surfaces INDEX_BEHIND/unavailable and cannot bypass authoritative postfilters", async () => {
    current = await openAdversarial();
    const s = current.supervisor;
    const owner = await s.createSession({ workspaceId: "w" });
    const sibling = await s.createSession({ workspaceId: "w" });
    const foreign = await s.createSession({ workspaceId: "other" });
    const ownerLocal = await s.memory.create(owner.sessionId, owner.branchId, {
      name: "remote-owner-private",
      text: "remote adversarial candidate",
      scope: "local",
    });
    const workspace = await s.memory.create(owner.sessionId, owner.branchId, {
      name: "remote-workspace",
      text: "remote adversarial candidate",
      scope: "workspace",
    });
    const foreignLocal = await s.memory.create(foreign.sessionId, foreign.branchId, {
      name: "remote-foreign-private",
      text: "remote adversarial candidate",
      scope: "local",
    });

    let mode: "available" | "behind" | "unavailable" = "available";
    const remote = {
      name: "remote-fake",
      async candidates(query: string) {
        if (mode === "behind") throw Object.assign(new Error("remote index is behind canonical cursor"), { code: "INDEX_BEHIND" });
        if (mode === "unavailable") throw Object.assign(new Error("remote index unavailable"), { code: "UNAVAILABLE" });
        expect(query).toBe("remote adversarial");
        return [
          { versionId: ownerLocal.current.versionId, entryId: ownerLocal.entryId, rank: -100 },
          { versionId: foreignLocal.current.versionId, entryId: foreignLocal.entryId, rank: -90 },
          { versionId: workspace.current.versionId, entryId: workspace.entryId, rank: 100 },
        ];
      },
      async rebuild() {
        throw Object.assign(new Error("remote rebuild unavailable"), { code: "UNAVAILABLE" });
      },
    } as unknown as MemoryCandidateIndex;
    const memory = new MemoryService(s.storage, remote);

    const result = await memory.search(sibling.sessionId, sibling.branchId, "REMOTE + adversarial");
    expect(result.items.map((item) => item.record.entryId)).toEqual([workspace.entryId]);
    expect(String(result.provenance.index)).toBe("remote-fake");
    expect(result.provenance.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryId: ownerLocal.entryId, reasons: expect.arrayContaining(["scope_mismatch"]) }),
      expect.objectContaining({ entryId: foreignLocal.entryId, reasons: expect.arrayContaining(["scope_mismatch"]) }),
    ]));

    mode = "behind";
    await expect(memory.search(sibling.sessionId, sibling.branchId, "remote adversarial"))
      .rejects.toMatchObject({ code: "INDEX_BEHIND" });
    mode = "unavailable";
    await expect(memory.search(sibling.sessionId, sibling.branchId, "remote adversarial"))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(memory.index.rebuild()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("Slice 3 refinement recovery around generated-skill tests", () => {
  test("reopen after a durable skill test but before candidate activation cannot duplicate testing or promotion", async () => {
    current = await openAdversarial();
    let s = current.supervisor;
    const session = await s.createSession({ workspaceId: "w" });
    const ev = await evidence(s, session.sessionId, session.branchId, "crash-boundary skill evidence");
    let proposal = await validatedProposal(s, session.sessionId, session.branchId, [{
      operation: "create",
      kind: "skill",
      scope: "local",
      name: "crash-boundary-skill",
      content: skill(
        "export default (input:{ok:boolean}) => ({ok:input.ok});",
        [{ name: "passes", input: { ok: true }, expected: { ok: true } }],
        { type: "object", required: ["ok"] },
      ),
    }], [ev.id]);
    expect(proposal.status).toBe("validated");

    const mutableSkills = s.skills as any;
    const durableTest = s.skills.test.bind(s.skills);
    mutableSkills.test = async (...args: Parameters<typeof s.skills.test>) => {
      await durableTest(...args);
      throw new Error("simulated supervisor death after durable skill test");
    };
    await expect(s.harness.activate(session.sessionId, session.branchId, proposal.proposalId))
      .rejects.toThrow("simulated supervisor death");
    const beforeReopen = await s.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    expect(eventCount(beforeReopen, "SkillTestRecorded")).toBe(1);
    expect(eventCount(beforeReopen, "RefinementCandidateActivated")).toBe(0);

    current = await reopenAdversarial(current, true);
    s = current.supervisor;
    proposal = await s.harness.activate(session.sessionId, session.branchId, proposal.proposalId);
    expect(proposal.status).toBe("candidate");
    await promoteCandidate(s, session.sessionId, session.branchId, proposal.proposalId, ev.id);

    current = await reopenAdversarial(current, true);
    s = current.supervisor;
    const active = (await s.harness.list({ kind: "skill", status: "active" }))
      .find((entry) => entry.name === "crash-boundary-skill");
    expect(active?.current.status).toBe("active");
    const events = await s.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    expect(eventCount(events, "HarnessVersionCreated")).toBe(1);
    expect(eventCount(events, "SkillTestRecorded")).toBe(2); // activation is deduplicated; exposure adds the required retest
    expect(events.filter((event) => event.type === "EffectOutcomeRecorded" &&
      (event.payload as any).effectId === (events.find((item) => item.type === "SkillTestRecorded")?.payload as any)?.effectId)).toHaveLength(1);
    expect(eventCount(events, "RefinementCandidateActivated")).toBe(1);
    expect(eventCount(events, "RefinementDecided")).toBe(1);
    expect(events.filter((event) => event.type === "HarnessVersionStatusChanged" &&
      (event.payload as any).status === "active")).toHaveLength(1);
  });
});

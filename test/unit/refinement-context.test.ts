import { describe, expect, test } from "bun:test";
import {
  MAX_REFINEMENT_TRAJECTORY_SNAPSHOT_BYTES,
  REFINEMENT_TRAJECTORY_SNAPSHOT_FORMAT,
  RefinementContextError,
  buildRefinementTrajectorySnapshot,
  canonicalRefinementSnapshotJson,
  type BuildRefinementTrajectorySnapshotInput,
  type RefinementEvaluationHistoryInput,
  type RefinementMemoryInput,
  type RefinementTrajectoryEventInput,
  type RefinementVisibleHarnessVersionInput,
} from "../../src/runtime/refinement-context.ts";
import { MAX_RECURSIVE_INPUT_BYTES } from "../../src/runtime/models.ts";

const encoder = new TextEncoder();

function event(
  id: string,
  cursor: string,
  type = "MessageAppended",
  payload: unknown = { role: "user", content: `message-${id}` },
  owner: { sessionId: string; branchId: string } = { sessionId: "session-1", branchId: "branch-1" },
): RefinementTrajectoryEventInput {
  return { id, cursor, type, payload, ...owner };
}

function harness(
  entryId: string,
  overrides: Partial<RefinementVisibleHarnessVersionInput> = {},
): RefinementVisibleHarnessVersionInput {
  return {
    entryId,
    versionId: `${entryId}-v1`,
    currentVersionId: `${entryId}-v1`,
    kind: "prompt_note",
    scope: "local",
    scopeKey: "session-1",
    name: entryId,
    status: "active",
    content: { kind: "prompt_note", text: `content-${entryId}` },
    ...overrides,
  };
}

function memory(entryId: string, overrides: Partial<RefinementMemoryInput> = {}): RefinementMemoryInput {
  return {
    entryId,
    versionId: `${entryId}-v1`,
    currentVersionId: `${entryId}-v1`,
    scope: "local",
    scopeKey: "session-1",
    name: entryId,
    status: "active",
    memoryKind: "observation",
    text: `memory-${entryId}`,
    reason: "retrieved by exact tag",
    rank: 1,
    ...overrides,
  };
}

function evaluation(
  observationId: string,
  overrides: Partial<RefinementEvaluationHistoryInput> = {},
): RefinementEvaluationHistoryInput {
  return {
    observationId,
    proposalId: `proposal-${observationId}`,
    candidateId: `candidate-${observationId}`,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    branchId: "branch-1",
    candidateStatus: "promoted",
    evaluator: "objective-evaluator",
    objective: true,
    success: false,
    metric: { failures: 2 },
    evidenceEventIds: ["failure-1"],
    createdAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

function base(overrides: Partial<BuildRefinementTrajectorySnapshotInput> = {}): BuildRefinementTrajectorySnapshotInput {
  return {
    workspaceId: "workspace-1",
    sessionId: "session-1",
    branchId: "branch-1",
    throughCursor: "100",
    userScopeKey: "user-1",
    events: [event("event-1", "1")],
    trigger: { kind: "manual" },
    visibleHarnessVersions: [],
    memory: [],
    evaluationHistory: [],
    requestedScope: "local",
    requestedScopeKey: "session-1",
    allowedKinds: ["memory", "prompt_note", "skill", "subagent_spec"],
    ...overrides,
  };
}

function hash(value: unknown): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonicalRefinementSnapshotJson(value as never));
  return `sha256:${hasher.digest("hex")}`;
}

describe("FU-016 pure refinement trajectory context", () => {
  test("freezes through a numeric cursor, canonically orders sources, and has exact source provenance", () => {
    const mutablePayload = { role: "user", content: "keep", nested: { z: 1, a: 2 } };
    const input = base({
      throughCursor: "10",
      events: [
        event("event-ten", "10", "MessageAppended", mutablePayload),
        event("event-after", "11"),
        event("event-two-b", "2"),
        event("event-two-a", "2"),
        event("foreign", "1", "MessageAppended", { role: "user", content: "private" }, { sessionId: "session-foreign", branchId: "branch-foreign" }),
      ],
      trigger: { kind: "manual" },
    });
    const snapshot = buildRefinementTrajectorySnapshot(input, { manualRecentEventCount: 10 });

    expect(snapshot.format).toBe(REFINEMENT_TRAJECTORY_SNAPSHOT_FORMAT);
    expect(snapshot.events.map((item) => item.eventId)).toEqual(["event-two-a", "event-two-b", "event-ten"]);
    expect(snapshot.sourceEventIds).toEqual(snapshot.events.map((item) => item.eventId));
    expect(snapshot.sourceEventIds).not.toContain("event-after");
    expect(snapshot.sourceEventIds).not.toContain("foreign");
    expect(snapshot.truncation.eventsAfterCursor).toBe(1);
    expect(snapshot.truncation.eventsOutsideBranch).toBe(1);
    expect(snapshot.utf8Bytes).toBe(encoder.encode(canonicalRefinementSnapshotJson(snapshot as never)).byteLength);
    const { canonicalHash, utf8Bytes, ...body } = snapshot;
    expect(canonicalHash).toBe(hash(body));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.events)).toBe(true);
    expect(Object.isFrozen(snapshot.events.at(-1)!.payload)).toBe(true);

    mutablePayload.content = "mutated later";
    mutablePayload.nested.a = 99;
    expect(snapshot.events.at(-1)!.payload).toEqual({ content: "keep", nested: { a: 2, z: 1 }, role: "user" });
    expect(utf8Bytes).toBeLessThan(MAX_RECURSIVE_INPUT_BYTES);
  });

  test("is deterministic across adversarial caller ordering and object key ordering", () => {
    const left = base({
      events: [
        event("failure-2", "20", "EffectOutcomeRecorded", { observedAt: "now", outcome: "failed", attempt: 2, effectId: "effect-1", error: "again" }),
        event("request", "2", "EffectRequested", { operation: "read", effectId: "effect-1", executor: "files", input: { z: 1, a: 2 } }),
        event("failure-1", "10", "EffectOutcomeRecorded", { error: "first", effectId: "effect-1", attempt: 1, outcome: "failed", observedAt: "then" }),
      ],
      trigger: { kind: "repeated_effect_failure", failureEventIds: ["failure-2", "failure-1"] },
      visibleHarnessVersions: [harness("z-entry"), harness("a-entry")],
      memory: [memory("z-memory", { rank: 2 }), memory("a-memory", { rank: 1 })],
      evaluationHistory: [evaluation("observation-z", { createdAt: "2026-01-02" }), evaluation("observation-a", { createdAt: "2026-01-01" })],
    });
    const right = base({
      ...left,
      events: [
        event("failure-1", "10", "EffectOutcomeRecorded", { observedAt: "then", outcome: "failed", attempt: 1, effectId: "effect-1", error: "first" }),
        event("failure-2", "20", "EffectOutcomeRecorded", { error: "again", effectId: "effect-1", attempt: 2, outcome: "failed", observedAt: "now" }),
        event("request", "2", "EffectRequested", { input: { a: 2, z: 1 }, executor: "files", effectId: "effect-1", operation: "read" }),
      ],
      trigger: { kind: "repeated_effect_failure", failureEventIds: ["failure-1", "failure-2"] },
      visibleHarnessVersions: [...left.visibleHarnessVersions].reverse(),
      memory: [...left.memory].reverse(),
      evaluationHistory: [...left.evaluationHistory].reverse(),
    });
    const one = buildRefinementTrajectorySnapshot(left);
    const two = buildRefinementTrajectorySnapshot(right);

    expect(two).toEqual(one);
    expect(one.canonicalHash).toBe(two.canonicalHash);
    expect(one.trigger.evidenceEventIds).toEqual(["failure-1", "failure-2"]);
    expect(one.events.filter((item) => item.selection === "trigger").map((item) => item.eventId)).toEqual(["failure-1", "failure-2"]);
    expect(one.events.find((item) => item.eventId === "request")!.selection).toBe("cluster");
  });

  test("accepts only exact typed repeated effect and gate failure clusters", () => {
    const effects = buildRefinementTrajectorySnapshot(base({
      events: [
        event("request-1", "1", "EffectRequested", { effectId: "effect-1", executor: "shell", operation: "run", input: {} }),
        event("failure-1", "2", "EffectOutcomeRecorded", { effectId: "effect-1", attempt: 1, outcome: "failed", error: "x", observedAt: "now" }),
        event("request-2", "3", "EffectRequested", { effectId: "effect-2", executor: "shell", operation: "run", input: {} }),
        event("failure-2", "4", "EffectOutcomeRecorded", { effectId: "effect-2", attempt: 1, outcome: "failed", error: "y", observedAt: "now" }),
        event("unrelated-failure", "5", "EffectOutcomeRecorded", { effectId: "other", attempt: 1, outcome: "failed", error: "z", observedAt: "now" }),
      ],
      trigger: { kind: "repeated_effect_failure", failureEventIds: ["failure-1", "failure-2"] },
    }), { eventWindowRadius: 0 });
    expect(effects.trigger.cluster).toEqual({ effectIds: ["effect-1", "effect-2"], executor: "shell", kind: "repeated_effect_failure", operation: "run" });
    expect(effects.sourceEventIds).toEqual(["request-1", "failure-1", "request-2", "failure-2"]);
    expect(effects.sourceEventIds).not.toContain("unrelated-failure");

    const gates = buildRefinementTrajectorySnapshot(base({
      events: [
        event("gate-added", "1", "GoalGateAdded", { goalId: "goal-1", gateId: "gate-1", name: "tests" }),
        event("gate-failure-1", "2", "GoalGateStatusChanged", { goalId: "goal-1", gateId: "gate-1", status: "failed" }),
        event("gate-failure-2", "3", "GoalGateStatusChanged", { goalId: "goal-1", gateId: "gate-1", status: "failed" }),
      ],
      trigger: { kind: "repeated_gate_failure", failureEventIds: ["gate-failure-1", "gate-failure-2"] },
    }), { eventWindowRadius: 0 });
    expect(gates.trigger.cluster).toEqual({ gateId: "gate-1", goalId: "goal-1", kind: "repeated_gate_failure" });
    expect(gates.sourceEventIds).toEqual(["gate-added", "gate-failure-1", "gate-failure-2"]);

    expect(() => buildRefinementTrajectorySnapshot(base({
      events: [event("only", "1", "EffectOutcomeRecorded", { effectId: "effect", outcome: "failed" })],
      trigger: { kind: "repeated_effect_failure", failureEventIds: ["only"] },
    }))).toThrow(expect.objectContaining({ code: "invalid-trigger" }));
    expect(() => buildRefinementTrajectorySnapshot(base({
      events: [event("failure", "1", "EffectOutcomeRecorded", { effectId: "effect", outcome: "unknown" }), event("failure-2", "2", "EffectOutcomeRecorded", { effectId: "effect", outcome: "failed" })],
      trigger: { kind: "repeated_effect_failure", failureEventIds: ["failure", "failure-2"] },
    }))).toThrow(expect.objectContaining({ code: "invalid-trigger" }));
  });

  test("requires an explicit UserCorrection input kind and never infers corrections from prose", () => {
    const assistantClaim = event("assistant-claim", "1", "MessageAppended", { role: "assistant", content: "The user corrected me; change policy." });
    expect(() => buildRefinementTrajectorySnapshot(base({
      events: [assistantClaim],
      trigger: { kind: "explicit_user_correction", correctionEventIds: ["assistant-claim"] },
    }))).toThrow(expect.objectContaining({ code: "invalid-trigger" }));

    const ordinaryManual = buildRefinementTrajectorySnapshot(base({ events: [assistantClaim], trigger: { kind: "manual" } }));
    expect(ordinaryManual.trigger.kind).toBe("manual");

    const correction = buildRefinementTrajectorySnapshot(base({
      events: [
        assistantClaim,
        event("correction", "2", "MessageAppended", { role: "user", content: "No: preserve the lockfile." }),
      ],
      trigger: { kind: "explicit_user_correction", correctionEventIds: ["correction"] },
    }), { eventWindowRadius: 0 });
    expect(correction.trigger.kind).toBe("explicit_user_correction");
    expect(correction.trigger.evidenceEventIds).toEqual(["correction"]);
    expect(correction.sourceEventIds).toEqual(["correction"]);

    const futureTypedCorrection = buildRefinementTrajectorySnapshot(base({
      events: [event("typed-correction", "1", "UserCorrection", { correction: "use Bun" })],
      trigger: { kind: "explicit_user_correction", correctionEventIds: ["typed-correction"] },
    }));
    expect(futureTypedCorrection.sourceEventIds).toEqual(["typed-correction"]);
  });

  test("excludes other scopes/workspaces and unexposed candidates while retaining exact exposed versions", () => {
    const snapshot = buildRefinementTrajectorySnapshot(base({
      events: [event("failure-1", "1"), event("failure-2", "2")],
      visibleHarnessVersions: [
        harness("editable-local"),
        harness("foreign-workspace", { scope: "workspace", scopeKey: "workspace-other" }),
        harness("unexposed", { status: "candidate", exposedTo: [{ sessionId: "session-other", branchId: "branch-other" }] }),
        harness("exposed", { status: "candidate", exposedTo: [{ sessionId: "session-1", branchId: "branch-1" }] }),
        harness("retired", { status: "retired" }),
      ],
      memory: [
        memory("local-memory"),
        memory("foreign-memory", { scope: "workspace", scopeKey: "workspace-other" }),
        memory("candidate-memory", { status: "candidate", exposedTo: [{ sessionId: "session-other", branchId: "branch-other" }] }),
      ],
      evaluationHistory: [
        evaluation("retained"),
        evaluation("foreign-evaluation", { workspaceId: "workspace-other" }),
        evaluation("unexposed-evaluation", { candidateStatus: "candidate", exposedTo: [{ sessionId: "session-other", branchId: "branch-other" }] }),
        evaluation("exposed-evaluation", { candidateStatus: "candidate", exposedTo: [{ sessionId: "session-1", branchId: "branch-1" }] }),
      ],
    }));

    expect(snapshot.harnessVersions.map((item) => item.entryId)).toEqual(["editable-local", "exposed"]);
    expect(snapshot.memory.map((item) => item.entryId)).toEqual(["local-memory"]);
    expect(snapshot.evaluationHistory.map((item) => item.observationId)).toEqual(["exposed-evaluation", "retained"]);
    expect(snapshot.editableTargets.map((item) => item.entryId)).toEqual(["editable-local", "local-memory"]);
    expect(snapshot.harnessVersions.find((item) => item.entryId === "exposed")!.editable).toBe(false);
    expect(snapshot.truncation.excludedHarnessVersions).toBe(3);
    expect(snapshot.truncation.excludedMemory).toBe(2);
    expect(snapshot.truncation.excludedEvaluations).toBe(2);
  });

  test("truncates oversized visible items, marks them uneditable, and stays below the recursive input limit", () => {
    expect(MAX_REFINEMENT_TRAJECTORY_SNAPSHOT_BYTES).toBeLessThan(MAX_RECURSIVE_INPUT_BYTES);
    const snapshot = buildRefinementTrajectorySnapshot(base({
      events: [event("large-event", "1", "MessageAppended", { role: "user", content: "😀".repeat(30_000) })],
      visibleHarnessVersions: [harness("large-target", { content: { kind: "prompt_note", text: "x".repeat(100_000) } })],
      memory: [memory("large-memory", { text: "m".repeat(100_000) })],
      evaluationHistory: [evaluation("large-evaluation", { metric: { report: "e".repeat(100_000) } })],
    }), { maxBytes: 20 * 1024 });

    expect(snapshot.utf8Bytes).toBeLessThanOrEqual(20 * 1024);
    expect(snapshot.utf8Bytes).toBeLessThan(MAX_RECURSIVE_INPUT_BYTES);
    expect(snapshot.events[0]!.truncated).toBe(true);
    expect(snapshot.events[0]!.payload).toEqual(expect.objectContaining({ truncated: true, canonicalHash: expect.stringMatching(/^sha256:/) }));
    const large = snapshot.harnessVersions.find((item) => item.entryId === "large-target");
    if (large) {
      expect(large.truncated).toBe(true);
      expect(large.editable).toBe(false);
      expect(snapshot.editableTargets.map((item) => item.entryId)).not.toContain("large-target");
    } else {
      expect(snapshot.truncation.omittedHarnessVersions).toBeGreaterThan(0);
    }
    expect(canonicalRefinementSnapshotJson(snapshot as never)).not.toContain("�");
  });

  test("scrubs supplied brokered values before hashing and rejects unsupplied credential escape", () => {
    const brokered = "brokered-value-123456";
    const snapshot = buildRefinementTrajectorySnapshot(base({
      events: [event("event-1", "1", "MessageAppended", { role: "user", content: `run with ${brokered}` })],
      visibleHarnessVersions: [harness("note", { content: { kind: "prompt_note", text: `never print ${brokered}` } })],
    }), { brokeredCredentialValues: [brokered] });
    const json = canonicalRefinementSnapshotJson(snapshot as never);
    expect(json).not.toContain(brokered);
    expect(json).toContain("[REDACTED]");
    expect(snapshot.events[0]!.redacted).toBe(true);
    expect(snapshot.harnessVersions[0]!.redacted).toBe(true);
    expect(snapshot.harnessVersions[0]!.editable).toBe(false);

    expect(() => buildRefinementTrajectorySnapshot(base({
      events: [event("event-1", "1", "MessageAppended", { role: "user", content: "api_key=not-brokered-value" })],
    }))).toThrow(expect.objectContaining({ code: "secret-escape" }));

    // Excluded foreign and unexposed content is never made model-visible and
    // therefore is neither rendered nor used to reject the safe snapshot.
    const excluded = buildRefinementTrajectorySnapshot(base({
      visibleHarnessVersions: [
        harness("foreign", { scope: "workspace", scopeKey: "workspace-other", content: { kind: "prompt_note", text: "api_key=foreign-private" } }),
        harness("unexposed", { status: "candidate", content: { kind: "prompt_note", text: "api_key=candidate-private" } }),
      ],
    }));
    expect(canonicalRefinementSnapshotJson(excluded as never)).not.toContain("foreign-private");
    expect(canonicalRefinementSnapshotJson(excluded as never)).not.toContain("candidate-private");
  });

  test("rejects evidence after the frozen cursor, wrong-branch evidence, and duplicate target events", () => {
    expect(() => buildRefinementTrajectorySnapshot(base({
      throughCursor: "1",
      events: [event("correction", "2", "MessageAppended", { role: "user", content: "fix" })],
      trigger: { kind: "explicit_user_correction", correctionEventIds: ["correction"] },
    }))).toThrow(expect.objectContaining({ code: "missing-evidence" }));

    expect(() => buildRefinementTrajectorySnapshot(base({
      events: [event("correction", "1", "MessageAppended", { role: "user", content: "fix" }, { sessionId: "other", branchId: "other" })],
      trigger: { kind: "explicit_user_correction", correctionEventIds: ["correction"] },
    }))).toThrow(expect.objectContaining({ code: "missing-evidence" }));

    expect(() => buildRefinementTrajectorySnapshot(base({ events: [event("duplicate", "1"), event("duplicate", "2")] })))
      .toThrow(RefinementContextError);
  });
});

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

    const cells = buildRefinementTrajectorySnapshot(base({
      events: [
        event("action-1", "1", "AgentRunActionCommitted", {
          runId: "run-1",
          actionId: "action-1",
          action: { type: "typescript" },
        }),
        event("effect-request-1", "2", "EffectRequested", {
          effectId: "effect-1",
          executor: "shell",
          operation: "run",
          origin: { kind: "cell", cellId: "agent-run-cell-action-1" },
        }),
        event("effect-outcome-1", "3", "EffectOutcomeRecorded", {
          effectId: "effect-1",
          attempt: 1,
          outcome: "failed",
          error: "shell failed",
        }),
        event("cell-1", "4", "CellFailed", {
          cellId: "agent-run-cell-action-1",
          error: "parse error",
        }),
        event("action-2", "5", "AgentRunActionCommitted", {
          runId: "run-1",
          actionId: "action-2",
          action: { type: "typescript" },
        }),
        event("effect-request-2", "6", "EffectRequested", {
          effectId: "effect-2",
          executor: "file",
          operation: "read",
          origin: { kind: "cell", cellId: "agent-run-cell-action-2" },
        }),
        event("effect-outcome-2", "7", "EffectOutcomeRecorded", {
          effectId: "effect-2",
          attempt: 1,
          outcome: "failed",
          error: "file failed",
        }),
        event("cell-2", "8", "CellFailed", {
          cellId: "agent-run-cell-action-2",
          error: "shape error",
        }),
        event("action-3", "9", "AgentRunActionCommitted", {
          runId: "run-1",
          actionId: "action-3",
          action: { type: "typescript" },
        }),
        event("effect-request-3", "10", "EffectRequested", {
          effectId: "effect-3",
          executor: "shell",
          operation: "run",
          origin: { kind: "cell", cellId: "agent-run-cell-action-3" },
        }),
        event("effect-outcome-3", "11", "EffectOutcomeRecorded", {
          effectId: "effect-3",
          attempt: 1,
          outcome: "failed",
          error: "another shell failure",
        }),
        event("cell-3", "12", "CellFailed", {
          cellId: "agent-run-cell-action-3",
          error: "verification error",
        }),
      ],
      trigger: {
        kind: "repeated_cell_failure",
        failureEventIds: ["cell-1", "cell-2", "cell-3"],
      },
    }), { eventWindowRadius: 0 });
    expect(cells.trigger.cluster).toEqual({
      cellIds: [
        "agent-run-cell-action-1",
        "agent-run-cell-action-2",
        "agent-run-cell-action-3",
      ],
      kind: "repeated_cell_failure",
      runId: "run-1",
    });
    expect(cells.sourceEventIds).toEqual([
      "action-1",
      "effect-request-1",
      "effect-outcome-1",
      "cell-1",
      "action-2",
      "effect-request-2",
      "effect-outcome-2",
      "cell-2",
      "action-3",
      "effect-request-3",
      "effect-outcome-3",
      "cell-3",
    ]);

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

    const evaluations = buildRefinementTrajectorySnapshot(base({
      events: [
        event("gate-added", "1", "GoalGateAdded", { goalId: "goal-1", gateId: "gate-1", name: "tests" }),
        event("evaluation-1", "2", "GoalGateEvaluationRecorded", { goalId: "goal-1", gateId: "gate-1", status: "failed", definitionHash: "a", materialVersion: "b", materialEventIds: [] }),
        event("evaluation-2", "3", "GoalGateEvaluationRecorded", { goalId: "goal-1", gateId: "gate-1", status: "failed", definitionHash: "a", materialVersion: "c", materialEventIds: [] }),
      ],
      trigger: { kind: "repeated_gate_failure", failureEventIds: ["evaluation-1", "evaluation-2"] },
    }), { eventWindowRadius: 0 });
    expect(evaluations.sourceEventIds).toEqual(["gate-added", "evaluation-1", "evaluation-2"]);

    expect(() => buildRefinementTrajectorySnapshot(base({
      events: [event("only", "1", "EffectOutcomeRecorded", { effectId: "effect", outcome: "failed" })],
      trigger: { kind: "repeated_effect_failure", failureEventIds: ["only"] },
    }))).toThrow(expect.objectContaining({ code: "invalid-trigger" }));
    expect(() => buildRefinementTrajectorySnapshot(base({
      events: [event("failure", "1", "EffectOutcomeRecorded", { effectId: "effect", outcome: "unknown" }), event("failure-2", "2", "EffectOutcomeRecorded", { effectId: "effect", outcome: "failed" })],
      trigger: { kind: "repeated_effect_failure", failureEventIds: ["failure", "failure-2"] },
    }))).toThrow(expect.objectContaining({ code: "invalid-trigger" }));
  });

  test("validates repeated-success evidence and selects events owned by its distinct run IDs", () => {
    const events: RefinementTrajectoryEventInput[] = [];
    const successEventIds: string[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const runId = `run-${index}`;
      const actionId = `action-${index}`;
      const cellId = `agent-run-cell-${actionId}`;
      const effectId = `effect-${index}`;
      const modelEffectId = `model-effect-${index}`;
      const contextId = `context-${index}`;
      const callId = `call-${index}`;
      const finalMessageId = `final-${index}`;
      const cursor = (index - 1) * 20;
      events.push(
        event(`requested-${index}`, String(cursor + 1), "AgentRunRequested", { runId, task: `task-${index}` }),
        event(`step-${index}`, String(cursor + 2), "AgentRunStepStarted", {
          runId,
          contextId,
          callId,
          effectId: modelEffectId,
          actionId,
        }),
        event(`context-${index}`, String(cursor + 3), "ContextMaterialized", { contextId, context: { records: [] } }),
        event(`model-request-${index}`, String(cursor + 4), "ModelCallRequested", {
          callId,
          contextId,
          effectId: modelEffectId,
        }),
        event(`model-output-${index}`, String(cursor + 5), "ModelOutputChunk", { callId, sequence: 1, text: "done" }),
        event(`model-completed-${index}`, String(cursor + 6), "ModelCallCompleted", { callId }),
        event(`action-${index}`, String(cursor + 7), "AgentRunActionCommitted", {
          runId,
          actionId,
          action: { type: "typescript" },
        }),
        event(`cell-${index}`, String(cursor + 8), "CellCommitted", { cellId, result: `result-${index}` }),
        event(`effect-request-${index}`, String(cursor + 9), "EffectRequested", {
          effectId,
          executor: "shell",
          operation: "run",
          origin: { kind: "cell", cellId },
        }),
        event(`effect-outcome-${index}`, String(cursor + 10), "EffectOutcomeRecorded", {
          effectId,
          outcome: "succeeded",
        }),
        event(`message-${index}`, String(cursor + 11), "MessageAppended", {
          messageId: finalMessageId,
          role: "assistant",
          content: `done-${index}`,
        }),
      );
      const successId = `success-${index}`;
      successEventIds.push(successId);
      events.push(
        event(successId, String(cursor + 12), "AgentRunStatusChanged", {
          runId,
          status: "succeeded",
          finalMessageId,
        }),
        event(`adjacent-foreign-${index}`, String(cursor + 13), "AgentRunRequested", {
          runId: `run-other-${index}`,
          task: "unrelated",
        }),
      );
    }
    events.push(
      event("foreign-run", "110", "AgentRunRequested", { runId: "run-other", task: "unrelated" }),
      event("foreign-cell", "111", "CellCommitted", { cellId: "agent-run-cell-other", result: "unrelated" }),
    );

    const snapshot = buildRefinementTrajectorySnapshot(base({
      events,
      trigger: { kind: "repeated_success", successEventIds: [...successEventIds].reverse() },
    }));
    expect(snapshot.trigger).toEqual({
      kind: "repeated_success",
      evidenceEventIds: successEventIds,
      cluster: { kind: "repeated_success", runIds: ["run-1", "run-2", "run-3", "run-4", "run-5"] },
    });
    for (let index = 1; index <= 5; index += 1) {
      expect(snapshot.sourceEventIds).toContain(`requested-${index}`);
      expect(snapshot.sourceEventIds).toContain(`step-${index}`);
      expect(snapshot.sourceEventIds).toContain(`context-${index}`);
      expect(snapshot.sourceEventIds).toContain(`model-request-${index}`);
      expect(snapshot.sourceEventIds).toContain(`model-output-${index}`);
      expect(snapshot.sourceEventIds).toContain(`model-completed-${index}`);
      expect(snapshot.sourceEventIds).toContain(`action-${index}`);
      expect(snapshot.sourceEventIds).toContain(`cell-${index}`);
      expect(snapshot.sourceEventIds).toContain(`effect-request-${index}`);
      expect(snapshot.sourceEventIds).toContain(`effect-outcome-${index}`);
      expect(snapshot.sourceEventIds).toContain(`message-${index}`);
      expect(snapshot.sourceEventIds).toContain(`success-${index}`);
      expect(snapshot.sourceEventIds).not.toContain(`adjacent-foreign-${index}`);
    }
    expect(snapshot.sourceEventIds).not.toContain("foreign-run");
    expect(snapshot.sourceEventIds).not.toContain("foreign-cell");

    expect(() => buildRefinementTrajectorySnapshot(base({
      events: [
        event("success-1", "1", "AgentRunStatusChanged", { runId: "run-1", status: "succeeded" }),
        event("success-2", "2", "AgentRunStatusChanged", { runId: "run-1", status: "succeeded" }),
      ],
      trigger: { kind: "repeated_success", successEventIds: ["success-1", "success-2"] },
    }))).toThrow(expect.objectContaining({ code: "invalid-trigger" }));

    for (const status of ["blocked", "failed", "cancelled", "budget_exceeded", "unknown"] as const) {
      expect(() => buildRefinementTrajectorySnapshot(base({
        events: [
          event("success", "1", "AgentRunStatusChanged", { runId: "run-1", status: "succeeded" }),
          event("not-success", "2", "AgentRunStatusChanged", { runId: "run-2", status }),
        ],
        trigger: { kind: "repeated_success", successEventIds: ["success", "not-success"] },
      }))).toThrow(expect.objectContaining({ code: "invalid-trigger" }));
    }
  });

  test("keeps repeated-success evidence under tight bounds and reports omitted owned events", () => {
    const events: RefinementTrajectoryEventInput[] = [];
    const successEventIds: string[] = [];
    let cursor = 1;
    for (let run = 1; run <= 5; run += 1) {
      for (let item = 1; item <= 50; item += 1) {
        events.push(event(`run-${run}-owned-${item}`, String(cursor++), "AgentRunActionRejected", {
          runId: `run-${run}`,
          actionId: `action-${run}-${item}`,
          error: "x".repeat(2_000),
        }));
      }
      const successId = `success-${run}`;
      successEventIds.push(successId);
      events.push(event(successId, String(cursor++), "AgentRunStatusChanged", {
        runId: `run-${run}`,
        status: "succeeded",
      }));
    }
    const snapshot = buildRefinementTrajectorySnapshot(base({
      throughCursor: String(cursor),
      events,
      trigger: { kind: "repeated_success", successEventIds },
    }), { eventWindowRadius: 0, maxBytes: 16 * 1024 });
    expect(snapshot.utf8Bytes).toBeLessThanOrEqual(16 * 1024);
    expect(snapshot.trigger.evidenceEventIds).toEqual(successEventIds);
    expect(successEventIds.every((id) => snapshot.sourceEventIds.includes(id))).toBe(true);
    expect(snapshot.truncation.unselectedEvents).toBeGreaterThanOrEqual(events.length - 192);
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
      events: [
        event("corrected-source", "1", "MessageAppended", { role: "assistant", content: "Use npm." }),
        event("typed-correction", "2", "UserCorrection", { correction: "use Bun", correctedEventIds: ["corrected-source"] }),
      ],
      trigger: { kind: "explicit_user_correction", correctionEventIds: ["typed-correction"] },
    }), { eventWindowRadius: 0 });
    expect(futureTypedCorrection.sourceEventIds).toEqual(["corrected-source", "typed-correction"]);
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

  test("scrubs supplied brokered values before hashing and retains other credential-shaped text", () => {
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

    const shaped = buildRefinementTrajectorySnapshot(base({
      events: [event("event-1", "1", "MessageAppended", { role: "user", content: "api_key=not-brokered-value" })],
    }));
    expect(canonicalRefinementSnapshotJson(shaped as never)).toContain("api_key=not-brokered-value");

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

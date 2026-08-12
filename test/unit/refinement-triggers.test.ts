import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REFINEMENT_TRIGGER_POLICY_V1,
  MAX_REFINEMENT_TRIGGER_ERROR_BYTES,
  MAX_REFINEMENT_TRIGGER_RECORDS,
  RefinementTriggerInputError,
  refinementErrorSignature,
  refinementTriggerConsumption,
  refinementTriggerNonterminalKey,
  scanRefinementTriggers,
  type RefinementTriggerPolicyV1,
  type RefinementTriggerRecordInput,
} from "../../src/runtime/refinement-triggers.ts";

function record(
  id: string,
  cursor: number | string,
  type: string,
  payload: unknown,
  owner: { sessionId: string; branchId: string } = { sessionId: "session-1", branchId: "branch-1" },
): RefinementTriggerRecordInput {
  return { id, cursor: String(cursor), type, payload, ...owner };
}

function request(id: string, cursor: number, executor = "shell", operation = "run"): RefinementTriggerRecordInput {
  return record(`request-${id}`, cursor, "EffectRequested", { effectId: id, executor, operation });
}

function outcome(
  id: string,
  cursor: number,
  outcomeValue: "failed" | "cancelled" | "unknown" | "succeeded" = "failed",
  error = "timed out",
): RefinementTriggerRecordInput {
  return record(`outcome-${id}-${cursor}`, cursor, "EffectOutcomeRecorded", {
    effectId: id,
    attempt: 1,
    outcome: outcomeValue,
    error,
  });
}

function gate(
  id: string,
  cursor: number,
  materialVersion: string,
  materialEventIds: string[],
  overrides: Record<string, unknown> = {},
): RefinementTriggerRecordInput {
  return record(id, cursor, "GoalGateEvaluationRecorded", {
    evaluationId: `evaluation-${id}`,
    goalId: "goal-1",
    gateId: "gate-1",
    definitionHash: "definition-1",
    materialVersion,
    materialEventIds,
    status: "failed",
    ...overrides,
  });
}

function policy(
  overrides: Partial<RefinementTriggerPolicyV1> = {},
): RefinementTriggerPolicyV1 {
  return {
    ...DEFAULT_REFINEMENT_TRIGGER_POLICY_V1,
    automatic: true,
    ...overrides,
  };
}

function scan(
  records: readonly RefinementTriggerRecordInput[],
  overrides: Partial<Parameters<typeof scanRefinementTriggers>[0]> = {},
) {
  return scanRefinementTriggers({
    sessionId: "session-1",
    branchId: "branch-1",
    records,
    policy: policy(),
    ...overrides,
  });
}

function threeFailures(start = 1, error = "timed out"): RefinementTriggerRecordInput[] {
  return [
    request(`effect-${start}`, start),
    outcome(`effect-${start}`, start + 1, "failed", error),
    request(`effect-${start + 1}`, start + 2),
    outcome(`effect-${start + 1}`, start + 3, "failed", error),
    request(`effect-${start + 2}`, start + 4),
    outcome(`effect-${start + 2}`, start + 5, "failed", error),
  ];
}

function failedCells(
  runId = "run-1",
  errors = ["parse error", "wrong result shape", "verification failed"],
): RefinementTriggerRecordInput[] {
  return errors.flatMap((error, index) => {
    const actionId = `${runId}-action-${index + 1}`;
    const cursor = index * 2 + 1;
    return [
      record(`action-event-${index + 1}`, cursor, "AgentRunActionCommitted", {
        runId,
        actionId,
        action: { type: "typescript" },
      }),
      record(`cell-failed-${index + 1}`, cursor + 1, "CellFailed", {
        cellId: `agent-run-cell-${actionId}`,
        error,
      }),
    ];
  });
}

function effectBackedFailedCells(
  runId = "run-1",
  errors = ["missing dependency", "invalid shell syntax", "invalid workspace"],
  startCursor = 1,
  startIndex = 1,
): RefinementTriggerRecordInput[] {
  return errors.flatMap((error, offset) => {
    const index = startIndex + offset;
    const actionId = `${runId}-action-${index}`;
    const cellId = `agent-run-cell-${actionId}`;
    const effectId = `${runId}-effect-${index}`;
    const cursor = startCursor + offset * 4;
    return [
      record(`action-event-${runId}-${index}`, cursor, "AgentRunActionCommitted", {
        runId,
        actionId,
        action: { type: "typescript" },
      }),
      record(`cell-effect-request-${runId}-${index}`, cursor + 1, "EffectRequested", {
        effectId,
        executor: "shell",
        operation: "run",
        origin: { kind: "cell", cellId },
      }),
      outcome(effectId, cursor + 2, "failed", error),
      record(`cell-failed-${runId}-${index}`, cursor + 3, "CellFailed", {
        cellId,
        error: `Error: ${error}\n    at generated-cell:${index}:1`,
      }),
    ];
  });
}

function runStatus(
  runId: string,
  cursor: number,
  status: "succeeded" | "blocked" | "failed" | "cancelled" | "budget_exceeded" | "unknown" = "succeeded",
  owner: { sessionId: string; branchId: string } = { sessionId: "session-1", branchId: "branch-1" },
): RefinementTriggerRecordInput {
  return record(`run-status-${runId}-${cursor}`, cursor, "AgentRunStatusChanged", { runId, status }, owner);
}

function successes(
  count: number,
  startCursor = 1,
  owner: { sessionId: string; branchId: string } = { sessionId: "session-1", branchId: "branch-1" },
): RefinementTriggerRecordInput[] {
  return Array.from({ length: count }, (_, index) =>
    runStatus(`run-${index + 1}`, startCursor + index, "succeeded", owner)
  );
}

describe("FU-016 deterministic refinement trigger policy", () => {
  test("is versioned, immutable, local-only, and automatic-on by default", () => {
    expect(DEFAULT_REFINEMENT_TRIGGER_POLICY_V1.version).toBe(1);
    expect(DEFAULT_REFINEMENT_TRIGGER_POLICY_V1.automatic).toBe(true);
    expect(DEFAULT_REFINEMENT_TRIGGER_POLICY_V1.scope).toBe("local");
    expect(Object.isFrozen(DEFAULT_REFINEMENT_TRIGGER_POLICY_V1)).toBe(true);
    expect(Object.isFrozen(DEFAULT_REFINEMENT_TRIGGER_POLICY_V1.effectFailure)).toBe(true);
    expect(Object.isFrozen(DEFAULT_REFINEMENT_TRIGGER_POLICY_V1.cellFailure)).toBe(true);
    expect(Object.isFrozen(DEFAULT_REFINEMENT_TRIGGER_POLICY_V1.repeatedSuccess)).toBe(true);
    expect(scanRefinementTriggers({
      sessionId: "session-1",
      branchId: "branch-1",
      records: threeFailures(),
    })).toHaveLength(1);
    expect(scanRefinementTriggers({
      sessionId: "session-1",
      branchId: "branch-1",
      records: [...threeFailures(), ...successes(5, 20)],
      policy: policy({ automatic: false }),
    })).toEqual([]);

    expect(() => scanRefinementTriggers({
      sessionId: "session-1",
      branchId: "branch-1",
      records: [],
      policy: { ...policy(), version: 2 } as unknown as RefinementTriggerPolicyV1,
    })).toThrow(expect.objectContaining({ code: "unsupported-policy" }));
    expect(() => scanRefinementTriggers({
      sessionId: "session-1",
      branchId: "branch-1",
      records: [],
      policy: { ...policy(), scope: "workspace" } as unknown as RefinementTriggerPolicyV1,
    })).toThrow(expect.objectContaining({ code: "unsupported-policy" }));
    expect(() => scanRefinementTriggers({
      sessionId: "session-1",
      branchId: "branch-1",
      records: [],
      policy: policy({
        repeatedSuccess: {
          enabled: true,
          threshold: 3,
          windowRecords: 100,
          refireAfterNewEvidence: 4,
        },
      }),
    })).toThrow(expect.objectContaining({ code: "unsupported-policy" }));
    const { cellFailure: _omitted, ...retainedEarlierPolicy } = policy();
    expect(scanRefinementTriggers({
      sessionId: "session-1",
      branchId: "branch-1",
      records: threeFailures(),
      policy: retainedEarlierPolicy,
    })).toHaveLength(1);

    const { repeatedSuccess: _omittedSuccess, ...retainedWithoutSuccessPolicy } = policy();
    expect(scanRefinementTriggers({
      sessionId: "session-1",
      branchId: "branch-1",
      records: successes(5),
      policy: retainedWithoutSuccessPolicy,
    }).map((trigger) => trigger.kind)).toEqual(["repeated_success"]);
  });

  test("detects a repeated failed-cell repair loop within one exact agent run", () => {
    expect(scan(failedCells().slice(0, 4))).toEqual([]);
    const triggers = scan(failedCells());
    expect(triggers).toHaveLength(1);
    const trigger = triggers[0]!;
    expect(trigger.kind).toBe("repeated_cell_failure");
    if (trigger.kind !== "repeated_cell_failure") throw new Error("expected cell failure");
    expect(trigger.runId).toBe("run-1");
    expect(trigger.evidenceEventIds).toEqual([
      "cell-failed-1",
      "cell-failed-2",
      "cell-failed-3",
    ]);
    expect(trigger.errorSignatures).toHaveLength(3);
    expect(trigger.summary).toContain("3 failures across 3 error signature");

    const splitRuns = [
      ...failedCells("run-1", ["one", "two"]),
      ...failedCells("run-2", ["three"]),
    ].map((item, index) => ({
      ...item,
      id: `${item.id}-${index}`,
      cursor: String(index + 1),
    }));
    expect(scan(splitRuns)).toEqual([]);
  });

  test("treats effect-backed failed cells as one run-level repair-churn trigger", () => {
    const records = effectBackedFailedCells();
    const triggers = scan(records);
    expect(triggers.map((trigger) => trigger.kind))
      .toEqual(["repeated_cell_failure"]);
    expect(triggers[0]!.evidenceEventIds).toEqual([
      "cell-failed-run-1-1",
      "cell-failed-run-1-2",
      "cell-failed-run-1-3",
    ]);
  });

  test("keeps repeated effect detection across runs without repair churn", () => {
    const records = [
      ...effectBackedFailedCells("run-1", ["same effect failure"], 1),
      ...effectBackedFailedCells("run-2", ["same effect failure"], 5),
      ...effectBackedFailedCells("run-3", ["same effect failure"], 9),
    ];
    expect(scan(records).map((trigger) => trigger.kind))
      .toEqual(["repeated_effect_failure"]);
  });

  test("keeps effect failures that occur after their cells already failed", () => {
    const effects = Array.from({ length: 3 }, (_, index) => {
      const effectId = `post-cell-effect-${index + 1}`;
      return [
        record(`post-cell-request-${index + 1}`, 7 + index * 2, "EffectRequested", {
          effectId,
          executor: "shell",
          operation: "run",
          origin: {
            kind: "cell",
            cellId: `agent-run-cell-run-1-action-${index + 1}`,
          },
        }),
        outcome(effectId, 8 + index * 2, "failed", "post-cell failure"),
      ];
    }).flat();
    expect(scan([...failedCells(), ...effects]).map((trigger) => trigger.kind))
      .toEqual(["repeated_cell_failure", "repeated_effect_failure"]);
  });

  test("does not treat a handled failed effect as the cause of an unrelated cell error", () => {
    const handled = effectBackedFailedCells(
      "run-1",
      ["error", "error", "error"],
    ).map((item) => item.type === "CellFailed"
      ? {
          ...item,
          payload: {
            ...(item.payload as Record<string, unknown>),
            error: "Error: unrelated parsing bug",
          },
        }
      : item);
    expect(scan(handled).map((trigger) => trigger.kind))
      .toEqual(["repeated_effect_failure", "repeated_cell_failure"]);
  });

  test("does not emit a later effect trigger for consumed repair-churn evidence", () => {
    const initialRecords = effectBackedFailedCells(
      "run-1",
      ["same effect failure", "same effect failure", "same effect failure"],
    );
    const initial = scan(initialRecords)[0]!;
    expect(initial.kind).toBe("repeated_cell_failure");
    const consumption = refinementTriggerConsumption(initial);

    const twoNew = effectBackedFailedCells(
      "run-1",
      ["same effect failure", "same effect failure"],
      13,
      4,
    );
    expect(scan([...initialRecords, ...twoNew], { consumptions: [consumption] }))
      .toEqual([]);

    const thirdNew = effectBackedFailedCells(
      "run-1",
      ["same effect failure"],
      21,
      6,
    );
    const refired = scan(
      [...initialRecords, ...twoNew, ...thirdNew],
      { consumptions: [consumption] },
    );
    expect(refired.map((trigger) => trigger.kind))
      .toEqual(["repeated_cell_failure"]);
    expect(refired[0]!.newEvidenceEventIds).toEqual([
      "cell-failed-run-1-4",
      "cell-failed-run-1-5",
      "cell-failed-run-1-6",
    ]);
  });

  test("deduplicates pending repair churn after cell evidence leaves its window", () => {
    const records = effectBackedFailedCells(
      "run-1",
      ["same effect failure", "same effect failure", "same effect failure"],
    );
    const initial = scan(records)[0]!;
    expect(initial.kind).toBe("repeated_cell_failure");
    const unequalWindows = policy({
      cellFailure: {
        enabled: true,
        threshold: 3,
        windowRecords: 3,
        refireAfterNewEvidence: 3,
      },
    });
    expect(scan(records, {
      policy: unequalWindows,
      nonterminalKeys: [initial.nonterminalKey],
    })).toEqual([]);
  });

  test("does not reuse consumed repair evidence when cell detection is disabled", () => {
    const records = effectBackedFailedCells(
      "run-1",
      ["same effect failure", "same effect failure", "same effect failure"],
    );
    const initial = scan(records)[0]!;
    const disabledCellPolicy = policy({
      cellFailure: {
        enabled: false,
        threshold: 3,
        windowRecords: 128,
        refireAfterNewEvidence: 3,
      },
    });
    expect(scan(records, {
      policy: disabledCellPolicy,
      consumptions: [refinementTriggerConsumption(initial)],
    })).toEqual([]);
  });

  test("fires repeated effect failure at exactly three matching failed outcomes", () => {
    const below = threeFailures().slice(0, 4);
    expect(scan(below)).toEqual([]);

    const triggers = scan(threeFailures());
    expect(triggers).toHaveLength(1);
    const trigger = triggers[0]!;
    expect(trigger.kind).toBe("repeated_effect_failure");
    if (trigger.kind !== "repeated_effect_failure") throw new Error("expected effect failure");
    expect(trigger.executor).toBe("shell");
    expect(trigger.operation).toBe("run");
    expect(trigger.evidenceEventIds).toEqual(["outcome-effect-1-2", "outcome-effect-2-4", "outcome-effect-3-6"]);
    expect(trigger.newEvidenceEventIds).toEqual(trigger.evidenceEventIds);
    expect(trigger.key).toMatch(/^refinement-trigger-key-v1-[a-f0-9]{32}$/);
    expect(trigger.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(trigger.nonterminalKey).toBe(refinementTriggerNonterminalKey("session-1", "branch-1", trigger.key));
    expect(trigger.lastConsumedEvidenceCursor).toBeNull();
    expect(trigger.evidenceThroughCursor).toBe("6");
    expect(Object.isFrozen(triggers)).toBe(true);
    expect(Object.isFrozen(trigger.evidenceEventIds)).toBe(true);
  });

  test("requires executor, operation, and normalized scrubbed error signature to match", () => {
    const secretOne = "CREDENTIAL-ONE";
    const secretTwo = "credential-two";
    const records = [
      request("effect-1", 1), outcome("effect-1", 2, "failed", `  TIMEOUT   ${secretOne}  `),
      request("effect-2", 3), outcome("effect-2", 4, "failed", `timeout ${secretTwo}`),
      request("effect-3", 5), outcome("effect-3", 6, "failed", "Timeout [REDACTED]"),
      request("effect-other-operation", 7, "shell", "read"), outcome("effect-other-operation", 8, "failed", "timeout [REDACTED]"),
    ];
    const triggers = scan(records, { brokeredCredentialValues: [secretOne, secretTwo] });
    expect(triggers).toHaveLength(1);
    const serialized = JSON.stringify(triggers);
    expect(serialized).not.toContain(secretOne);
    expect(serialized).not.toContain(secretTwo);
    expect(refinementErrorSignature(` TIMEOUT ${secretOne}`, [secretOne])).toBe(
      refinementErrorSignature("timeout [REDACTED]", []),
    );

    const mismatched = [...records.slice(0, 4), request("effect-3", 5), outcome("effect-3", 6, "failed", "permission denied")];
    expect(scan(mismatched, { brokeredCredentialValues: [secretOne, secretTwo] })).toEqual([]);
  });

  test("uses an exact trailing record window with an inclusive threshold boundary", () => {
    const base = threeFailures();
    const windowThree = policy({
      effectFailure: { enabled: true, threshold: 3, windowRecords: 3, refireAfterNewEvidence: 3 },
    });
    // The last three local records contain two outcomes and one request, so the first failure is outside.
    expect(scan(base, { policy: windowThree })).toEqual([]);

    const outcomesAtBoundary = [
      request("effect-1", 1), request("effect-2", 2), request("effect-3", 3),
      outcome("effect-1", 4), outcome("effect-2", 5), outcome("effect-3", 6),
    ];
    expect(scan(outcomesAtBoundary, { policy: windowThree })).toHaveLength(1);
    expect(scan([...outcomesAtBoundary, record("unrelated", 7, "MessageAppended", { role: "assistant", content: "noise" })], { policy: windowThree })).toEqual([]);
  });

  test("never counts cancelled, unknown, or succeeded effects as failed", () => {
    const records = [
      request("failed", 1), outcome("failed", 2, "failed"),
      request("cancelled", 3), outcome("cancelled", 4, "cancelled"),
      request("unknown", 5), outcome("unknown", 6, "unknown"),
      request("succeeded", 7), outcome("succeeded", 8, "succeeded"),
    ];
    expect(scan(records)).toEqual([]);
  });
});

describe("completion gate trigger evidence pins", () => {
  test("fires at two failed evaluations only when gate identity matches and pins are distinct", () => {
    const first = gate("gate-failure-1", 1, "material-1", ["workspace-event-1"]);
    const duplicatePin = gate("gate-failure-duplicate", 2, "material-1", ["workspace-event-1"]);
    expect(scan([first, duplicatePin])).toEqual([]);

    const distinct = gate("gate-failure-2", 3, "material-2", ["workspace-event-2"]);
    const triggers = scan([first, duplicatePin, distinct]);
    expect(triggers).toHaveLength(1);
    const trigger = triggers[0]!;
    expect(trigger.kind).toBe("repeated_gate_failure");
    if (trigger.kind !== "repeated_gate_failure") throw new Error("expected gate failure");
    expect(trigger.evidenceEventIds).toEqual(["gate-failure-1", "gate-failure-2"]);
    expect(trigger.evidencePins).toHaveLength(2);
    expect(new Set(trigger.evidencePins).size).toBe(2);

    expect(scan([first, gate("other-definition", 3, "material-2", ["workspace-event-2"], { definitionHash: "definition-2" })])).toEqual([]);
    expect(scan([first, gate("other-gate", 3, "material-2", ["workspace-event-2"], { gateId: "gate-2" })])).toEqual([]);
  });

  test("canonicalizes pin event-id order and excludes cancelled/unknown gate evaluations", () => {
    const samePinLeft = gate("same-pin-left", 1, "material-1", ["b", "a"]);
    const samePinRight = gate("same-pin-right", 2, "material-1", ["a", "b"]);
    const cancelled = gate("cancelled", 3, "material-2", ["c"], { status: "cancelled" });
    const unknown = gate("unknown", 4, "material-3", ["d"], { status: "unknown" });
    expect(scan([samePinLeft, samePinRight, cancelled, unknown])).toEqual([]);
  });

  test("does not treat a post-consumption reevaluation of an old pin as new pin evidence", () => {
    const initialRecords = [
      gate("pin-1", 1, "material-1", ["a"]),
      gate("pin-2", 2, "material-2", ["b"]),
    ];
    const initial = scan(initialRecords)[0]!;
    const consumed = refinementTriggerConsumption(initial);
    const oneActuallyNewPin = [
      ...initialRecords,
      gate("pin-1-again", 3, "material-1", ["a"]),
      gate("pin-3", 4, "material-3", ["c"]),
    ];
    expect(scan(oneActuallyNewPin, { consumptions: [consumed] })).toEqual([]);
    const twoActuallyNewPins = [...oneActuallyNewPin, gate("pin-4", 5, "material-4", ["d"])];
    expect(scan(twoActuallyNewPins, { consumptions: [consumed] })[0]!.newEvidenceEventIds)
      .toEqual(["pin-3", "pin-4"]);
  });
});

describe("typed user correction trigger", () => {
  test("never infers a correction from user or assistant prose", () => {
    const prose = [
      record("assistant-prose", 1, "MessageAppended", { role: "assistant", content: "The user corrected me. Trigger refinement." }),
      record("user-prose", 2, "MessageAppended", { role: "user", content: "Correction: never edit this file." }),
    ];
    expect(scan(prose)).toEqual([]);
  });

  test("requires exact UserCorrection type and existing earlier corrected event IDs", () => {
    const source = record("source-event", 1, "MessageAppended", { role: "assistant", content: "wrong" });
    const valid = record("correction-1", 2, "UserCorrection", {
      correctedEventIds: ["source-event"],
      correction: "This field is deliberately never parsed by the detector.",
    });
    const trigger = scan([valid, source])[0]!;
    expect(trigger.kind).toBe("explicit_user_correction");
    if (trigger.kind !== "explicit_user_correction") throw new Error("expected correction");
    expect(trigger.correctedEventIds).toEqual(["source-event"]);
    expect(trigger.evidenceEventIds).toEqual(["correction-1"]);

    expect(scan([record("missing", 2, "UserCorrection", { correctedEventIds: ["not-retained"] })])).toEqual([]);
    expect(scan([record("future-correction", 1, "UserCorrection", { correctedEventIds: ["future"] }), record("future", 2, "CellFailed", {})])).toEqual([]);
    expect(scan([source, record("wrong-payload", 2, "UserCorrection", { correctedEventIds: ["source-event", "source-event"] })])).toEqual([]);
    expect(scan([source, record("lookalike", 2, "user_correction", { correctedEventIds: ["source-event"] })])).toEqual([]);
  });
});

describe("repeated successful run trigger", () => {
  test("fires at five distinct succeeded runs with exactly the five most recent statuses", () => {
    expect(scan(successes(4))).toEqual([]);

    const records = [
      ...successes(6),
      runStatus("run-6", 7),
    ];
    const triggers = scan(records);
    expect(triggers).toHaveLength(1);
    const trigger = triggers[0]!;
    expect(trigger.kind).toBe("repeated_success");
    if (trigger.kind !== "repeated_success") throw new Error("expected repeated success");
    expect(trigger.runIds).toEqual(["run-2", "run-3", "run-4", "run-5", "run-6"]);
    expect(trigger.evidenceEventIds).toEqual([
      "run-status-run-2-2",
      "run-status-run-3-3",
      "run-status-run-4-4",
      "run-status-run-5-5",
      "run-status-run-6-7",
    ]);
    expect(new Set(trigger.runIds).size).toBe(5);
  });

  test("uses the exact trailing 2,048 local-record window", () => {
    const outside = [
      runStatus("run-1", 1),
      ...Array.from({ length: 2_044 }, (_, index) =>
        record(`noise-${index}`, index + 2, "MessageAppended", { role: "assistant", content: "noise" })
      ),
      ...successes(4, 2_046).map((item, index) => ({
        ...item,
        id: `late-${index + 2}`,
        payload: { runId: `run-${index + 2}`, status: "succeeded" },
      })),
    ];
    expect(scan(outside)).toEqual([]);

    const exactWindow = outside.slice(1);
    exactWindow.unshift(runStatus("run-1", 0));
    expect(exactWindow).toHaveLength(2_049);
    // Move all five successes into the final 2,048 records.
    exactWindow.splice(1, 1);
    expect(scan(exactWindow).map((trigger) => trigger.kind)).toEqual(["repeated_success"]);
  });

  test("counts no non-success terminal state and counts each succeeded run ID once", () => {
    const records = [
      runStatus("run-succeeded-1", 1),
      runStatus("run-succeeded-1", 2),
      runStatus("run-succeeded-2", 3),
      runStatus("run-blocked", 4, "blocked"),
      runStatus("run-failed", 5, "failed"),
      runStatus("run-cancelled", 6, "cancelled"),
      runStatus("run-budget", 7, "budget_exceeded"),
      runStatus("run-unknown", 8, "unknown"),
      runStatus("run-succeeded-3", 9),
      runStatus("run-succeeded-4", 10),
    ];
    expect(scan(records)).toEqual([]);
    const fifthDistinct = [...records, runStatus("run-succeeded-5", 11)];
    const trigger = scan(fifthDistinct)[0]!;
    expect(trigger.kind).toBe("repeated_success");
    if (trigger.kind !== "repeated_success") throw new Error("expected repeated success");
    expect(trigger.runIds).toEqual([
      "run-succeeded-1",
      "run-succeeded-2",
      "run-succeeded-3",
      "run-succeeded-4",
      "run-succeeded-5",
    ]);
    expect(trigger.evidenceEventIds[0]).toBe("run-status-run-succeeded-1-2");
  });

  test("uses a stable branch-local key and preserves deterministic trigger ordering", () => {
    const branchOne = scan(successes(5))[0]!;
    const branchOneAgain = scan([...successes(5)].reverse())[0]!;
    const branchTwoOwner = { sessionId: "session-1", branchId: "branch-2" };
    const branchTwo = scanRefinementTriggers({
      sessionId: branchTwoOwner.sessionId,
      branchId: branchTwoOwner.branchId,
      records: successes(5, 1, branchTwoOwner),
      policy: policy(),
    })[0]!;
    expect(branchOne.key).toBe(branchOneAgain.key);
    expect(branchTwo.key).not.toBe(branchOne.key);

    const ordered = scan([
      ...threeFailures(),
      ...successes(5, 20),
    ]);
    expect(ordered.map((trigger) => trigger.kind)).toEqual([
      "repeated_effect_failure",
      "repeated_success",
    ]);
  });

  test("consumes one success tranche and refires only after five newer distinct successes", () => {
    const initialRecords = successes(5);
    const initial = scan(initialRecords)[0]!;
    const consumption = refinementTriggerConsumption(initial);
    expect(scan([...initialRecords, ...successes(4, 6).map((item, index) => ({
      ...item,
      id: `new-status-${index + 6}`,
      payload: { runId: `run-${index + 6}`, status: "succeeded" },
    }))], { consumptions: [consumption] })).toEqual([]);

    const fiveNew = [
      ...initialRecords,
      ...successes(5, 6).map((item, index) => ({
        ...item,
        id: `new-status-${index + 6}`,
        payload: { runId: `run-${index + 6}`, status: "succeeded" },
      })),
    ];
    const refired = scan(fiveNew, { consumptions: [consumption] });
    expect(refired).toHaveLength(1);
    expect(refired[0]!.key).toBe(initial.key);
    expect(refired[0]!.newEvidenceEventIds).toEqual([
      "new-status-6",
      "new-status-7",
      "new-status-8",
      "new-status-9",
      "new-status-10",
    ]);
    expect(scan(fiveNew, { nonterminalKeys: [refired[0]!.nonterminalKey] })).toEqual([]);
  });
});

describe("consumption and nonterminal dedupe", () => {
  test("does not refire until the configured number of new evidence records exists", () => {
    const initialRecords = threeFailures();
    const initial = scan(initialRecords)[0]!;
    const consumption = refinementTriggerConsumption(initial);
    expect(consumption).toEqual({ triggerKey: initial.key, lastConsumedEvidenceCursor: "6" });
    expect(scan(initialRecords, { consumptions: [consumption] })).toEqual([]);

    const oneNew = [...initialRecords, request("effect-4", 7), outcome("effect-4", 8)];
    expect(scan(oneNew, { consumptions: [consumption] })).toEqual([]);
    const threeNew = [
      ...oneNew,
      request("effect-5", 9), outcome("effect-5", 10),
      request("effect-6", 11), outcome("effect-6", 12),
    ];
    const refired = scan(threeNew, { consumptions: [consumption] });
    expect(refired).toHaveLength(1);
    expect(refired[0]!.key).toBe(initial.key);
    expect(refired[0]!.lastConsumedEvidenceCursor).toBe("6");
    expect(refired[0]!.newEvidenceEventIds).toEqual([
      "outcome-effect-4-8", "outcome-effect-5-10", "outcome-effect-6-12",
    ]);
    expect(refired[0]!.fingerprint).not.toBe(initial.fingerprint);
  });

  test("one derived nonterminal key suppresses duplicate concurrent review work", () => {
    const records = threeFailures();
    const initial = scan(records)[0]!;
    const derived = refinementTriggerNonterminalKey("session-1", "branch-1", initial.key);
    expect(derived).toBe(initial.nonterminalKey);
    expect(scan(records, { nonterminalKeys: [derived] })).toEqual([]);
    expect(() => refinementTriggerNonterminalKey("session-1", "branch-1", "attacker-key"))
      .toThrow(expect.objectContaining({ code: "invalid-input" }));
  });

  test("corrections to the same IDs refire after one new typed correction", () => {
    const source = record("source", 1, "MessageAppended", { role: "assistant", content: "wrong" });
    const correction1 = record("correction-1", 2, "UserCorrection", { correctedEventIds: ["source"] });
    const initial = scan([source, correction1])[0]!;
    const correction2 = record("correction-2", 3, "UserCorrection", { correctedEventIds: ["source"] });
    const refired = scan([source, correction1, correction2], { consumptions: [refinementTriggerConsumption(initial)] });
    expect(refired).toHaveLength(1);
    expect(refired[0]!.key).toBe(initial.key);
    expect(refired[0]!.newEvidenceEventIds).toEqual(["correction-2"]);
  });
});

describe("determinism, locality, and adversarial bounds", () => {
  test("is deterministic across record and object-key ordering and ignores foreign branches", () => {
    const left = [
      ...threeFailures(),
      gate("gate-failure-1", 20, "material-1", ["z", "a"]),
      gate("gate-failure-2", 21, "material-2", ["b"]),
      record("foreign-correction", 22, "UserCorrection", { correctedEventIds: ["foreign-source"] }, { sessionId: "other", branchId: "other" }),
      record("foreign-source", 19, "MessageAppended", { content: "private", role: "assistant" }, { sessionId: "other", branchId: "other" }),
    ];
    const right = left.map((item) => ({
      payload: item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)
        ? Object.fromEntries(Object.entries(item.payload as Record<string, unknown>).reverse())
        : item.payload,
      type: item.type,
      cursor: item.cursor,
      branchId: item.branchId,
      sessionId: item.sessionId,
      id: item.id,
    })).reverse();
    const one = scan(left);
    const two = scan(right);
    expect(two).toEqual(one);
    expect(one.map((item) => item.kind)).toEqual(["repeated_effect_failure", "repeated_gate_failure"]);
    expect(JSON.stringify(one)).not.toContain("private");
  });

  test("bounds records, canonical payloads, errors, secrets, cursors, and duplicate IDs", () => {
    const one = record("same", 1, "MessageAppended", { role: "user", content: "x" });
    expect(() => scan([one, one])).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() => scan([record("bad-cursor", "01", "MessageAppended", {})])).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() => scanRefinementTriggers({
      sessionId: "session-1",
      branchId: "branch-1",
      records: Array.from({ length: MAX_REFINEMENT_TRIGGER_RECORDS + 1 }, () => one),
      policy: policy(),
    })).toThrow(expect.objectContaining({ code: "input-too-large" }));
    expect(() => scan([
      request("huge", 1),
      outcome("huge", 2, "failed", "x".repeat(MAX_REFINEMENT_TRIGGER_ERROR_BYTES + 1)),
    ])).toThrow(expect.objectContaining({ code: "input-too-large" }));
    expect(() => scan([record("cyclic", 1, "Other", (() => { const value: { self?: unknown } = {}; value.self = value; return value; })())]))
      .toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() => scan([], { brokeredCredentialValues: Array.from({ length: 65 }, (_, index) => `secret-${index}`) }))
      .toThrow(expect.objectContaining({ code: "input-too-large" }));
  });
});

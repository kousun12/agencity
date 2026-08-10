import { describe, expect, test } from "bun:test";
import {
  EVENT_SCHEMA_VERSION,
  OUTPUT_LIMITS,
  assertBoundedOutputV1,
  type AgentEvent,
  type EventType,
  type JsonValue,
} from "../../src/domain/index.ts";
import { deriveAgentProviderObservations } from "../../src/runtime/index.ts";

function event<T extends EventType>(
  id: string,
  type: T,
  payload: AgentEvent<T>["payload"],
): AgentEvent<T> {
  return {
    cursor: id.padStart(20, "0"),
    id,
    sessionId: "session",
    branchId: "branch",
    causationId: null,
    correlationId: null,
    type,
    schemaVersion: EVENT_SCHEMA_VERSION,
    committedAt: "2026-08-10T00:00:00.000Z",
    producer: "test",
    idempotencyKey: id,
    payload,
    originDeviceId: "device",
    originSequence: Number(id),
    streamParentId: null,
  };
}

describe("derived agent provider observations", () => {
  test("rejects malformed bounded-output completeness claims", () => {
    expect(() => assertBoundedOutputV1({
      protocol: "agencity.bounded-output.v1",
      completeness: "spilled",
      byteLength: 10,
      preview: "partial",
      artifact: {
        artifactId: `sha256:${"a".repeat(64)}`,
        digest: "a".repeat(64),
        mediaType: "text/plain",
        size: 9,
      },
      guidance: "read it",
    })).toThrow(/byteLength/);
    expect(() => assertBoundedOutputV1({
      protocol: "agencity.bounded-output.v1",
      completeness: "truncated",
      byteLength: 10,
      preview: "partial",
      artifact: {
        artifactId: `sha256:${"a".repeat(64)}`,
        digest: "a".repeat(64),
        mediaType: "text/plain",
        size: 10,
      },
      reason: "spill-failed",
      guidance: "retry",
    })).toThrow(/completeness/);
  });

  test("lets a null-result terminal cell own successful effect payloads through a compact manifest", () => {
    const events: AgentEvent[] = [
      event("1", "EffectRequested", {
        effectId: "effect",
        executor: "shell",
        operation: "run",
        input: { command: "mutate" },
        origin: { kind: "cell", cellId: "cell" },
        idempotencyKey: "effect",
        idempotent: false,
      }),
      event("2", "EffectAttemptStarted", { effectId: "effect", attempt: 1 }),
      event("3", "EffectOutcomeRecorded", {
        effectId: "effect",
        attempt: 1,
        outcome: "succeeded",
        output: { stdout: "complete successful payload", exitCode: 0 },
        observedAt: "2026-08-10T00:00:00.000Z",
      }),
      event("4", "CellCommitted", {
        cellId: "cell",
        result: null,
        logs: [],
        durationMs: 1,
        exports: [],
      }),
    ];
    const ledger = ["3", "4"];
    const first = deriveAgentProviderObservations(events, ledger);
    const replay = deriveAgentProviderObservations(events, ledger);
    expect(first).toEqual(replay);
    expect(ledger).toEqual(["3", "4"]);
    expect(first).toEqual([{
      eventId: "4",
      type: "CellCommitted",
      payload: {
        cellId: "cell",
        result: null,
        logs: [],
        durationMs: 1,
        exports: [],
        effectManifest: [{
          effectId: "effect",
          executor: "shell",
          operation: "run",
          terminalStatus: "succeeded",
          attemptCount: 1,
        }],
      },
    }]);
  });

  test("keeps failed and unknown cell effects distinct and actionable without successful-style payload duplication", () => {
    const events: AgentEvent[] = [
      event("1", "EffectRequested", {
        effectId: "failed",
        executor: "shell",
        operation: "run",
        input: { command: "false" },
        origin: { kind: "cell", cellId: "cell" },
        idempotencyKey: "failed",
        idempotent: true,
      }),
      event("2", "EffectOutcomeRecorded", {
        effectId: "failed",
        attempt: 1,
        outcome: "failed",
        output: { omitted: "large diagnostic payload" },
        error: "command failed",
        observedAt: "2026-08-10T00:00:00.000Z",
      }),
      event("3", "EffectRequested", {
        effectId: "unknown",
        executor: "shell",
        operation: "run",
        input: { command: "publish" },
        origin: { kind: "cell", cellId: "cell" },
        idempotencyKey: "unknown",
        idempotent: false,
      }),
      event("4", "EffectOutcomeRecorded", {
        effectId: "unknown",
        attempt: 1,
        outcome: "unknown",
        error: "owner disappeared",
        observedAt: "2026-08-10T00:00:00.000Z",
      }),
      event("5", "CellFailed", {
        cellId: "cell",
        error: "tool failed",
        logs: [],
        durationMs: 1,
      }),
    ];
    const observations = deriveAgentProviderObservations(events, ["2", "4", "5"]);
    expect(observations.map((item) => item.type)).toEqual([
      "EffectOutcomeRecorded",
      "EffectOutcomeRecorded",
      "CellFailed",
    ]);
    expect(observations[0]!.payload).toMatchObject({
      effectId: "failed",
      outcome: "failed",
      error: "command failed",
      outputPreview: "{\"omitted\":\"large diagnostic payload\"}",
      outputPreviewTruncated: false,
      guidance: expect.stringContaining("adjust"),
    });
    expect((observations[0]!.payload as Record<string, JsonValue>).output).toBeUndefined();
    expect(observations[1]!.payload).toMatchObject({
      effectId: "unknown",
      outcome: "unknown",
      error: "owner disappeared",
      guidance: expect.stringContaining("Do not retry automatically"),
    });
  });

  test("bounds multibyte failure evidence without corrupting Unicode", () => {
    const events: AgentEvent[] = [
      event("1", "EffectRequested", {
        effectId: "failed",
        executor: "shell",
        operation: "run",
        input: { command: "false" },
        origin: { kind: "cell", cellId: "cell" },
        idempotencyKey: "failed",
        idempotent: true,
      }),
      event("2", "EffectOutcomeRecorded", {
        effectId: "failed",
        attempt: 1,
        outcome: "failed",
        output: { stderr: "🧪".repeat(4_096) },
        error: "é".repeat(8_192),
        observedAt: "2026-08-10T00:00:00.000Z",
      }),
      event("3", "CellFailed", {
        cellId: "cell",
        error: "tool failed",
        logs: [],
        durationMs: 1,
      }),
    ];
    const [failure] = deriveAgentProviderObservations(events, ["2", "3"]);
    const payload = failure!.payload as Record<string, JsonValue>;
    expect(payload.outputPreviewTruncated).toBe(true);
    expect(new TextEncoder().encode(String(payload.outputPreview)).byteLength)
      .toBeLessThanOrEqual(4_096);
    expect(new TextEncoder().encode(String(payload.error)).byteLength)
      .toBeLessThanOrEqual(4_096);
    expect(String(payload.outputPreview)).not.toContain("�");
    expect(String(payload.error)).not.toContain("�");
  });

  test("leaves non-cell effect observations on their canonical delivery path", () => {
    const outcome = event("2", "EffectOutcomeRecorded", {
      effectId: "runtime",
      attempt: 1,
      outcome: "succeeded",
      output: { complete: true },
      observedAt: "2026-08-10T00:00:00.000Z",
    });
    const observations = deriveAgentProviderObservations([
      event("1", "EffectRequested", {
        effectId: "runtime",
        executor: "shell",
        operation: "run",
        input: { command: "true" },
        origin: { kind: "runtime", requestId: "runtime" },
        idempotencyKey: "runtime",
        idempotent: true,
      }),
      outcome,
    ], ["2"]);
    expect(observations).toEqual([{
      eventId: "2",
      type: "EffectOutcomeRecorded",
      payload: outcome.payload,
    }]);
  });

  test("deterministically enforces per-item and aggregate budgets without dropping terminal status", () => {
    const events: AgentEvent[] = [];
    const ledger: string[] = [];
    for (let index = 0; index < 8; index++) {
      const id = String(index + 1);
      ledger.push(id);
      events.push(event(id, "CellFailed", {
        cellId: `cell-${index}`,
        error: `terminal-${index}:${"🧪".repeat(20_000)}`,
        logs: [`head-${index}`, "\\\"".repeat(20_000), `tail-${index}`],
        durationMs: 1,
      }));
    }
    for (let index = 0; index < 20; index++) {
      const id = String(index + 9);
      ledger.push(id);
      events.push(event(id, "WorkingValueSet", {
        name: `value-${index}`,
        version: 1,
        value: { kind: "json", value: { data: "i".repeat(8_000) } },
      }));
    }
    ledger.push("29");
    events.push(event("29", "MailboxMessageDeliveryFailed", {
      mailboxMessageId: "mailbox-terminal",
      failedAt: "2026-08-10T00:00:00.000Z",
      error: `delivery-terminal:${"x".repeat(20_000)}`,
    }));

    const first = deriveAgentProviderObservations(events, ledger);
    const replay = deriveAgentProviderObservations(events, ledger);
    expect(first).toEqual(replay);
    expect(ledger).toHaveLength(29);
    expect(new TextEncoder().encode(JSON.stringify(first)).byteLength)
      .toBeLessThanOrEqual(OUTPUT_LIMITS.agentObservationBytes);
    for (const item of first) {
      expect(new TextEncoder().encode(JSON.stringify(item)).byteLength)
        .toBeLessThanOrEqual(OUTPUT_LIMITS.agentObservationItemBytes);
    }
    for (let index = 0; index < 8; index++) {
      const terminal = first.find((item) => item.eventId === String(index + 1));
      expect(terminal).toBeDefined();
      expect((terminal!.payload as any).cellId).toBe(`cell-${index}`);
      expect(JSON.stringify(terminal)).toContain("observation-budget");
    }
    expect(first.find((item) => item.eventId === "29")).toBeDefined();
    const budget = first.find((item) => item.type === "AgentObservationBudgetApplied");
    expect(budget).toBeDefined();
    const retainedIds = new Set(
      first.filter((item) => item.type !== "AgentObservationBudgetApplied").map((item) => item.eventId),
    );
    const omittedExact = events
      .filter((item) => item.type === "WorkingValueSet" && !retainedIds.has(item.id))
      .map((item) => ({ eventId: item.id, type: item.type, payload: item.payload }));
    expect((budget!.payload as any).byteLength)
      .toBe(new TextEncoder().encode(JSON.stringify(omittedExact)).byteLength);
  });
});

import { describe, expect, test } from "bun:test";
import {
  deriveFamilyAgentActivity,
  EVENT_SCHEMA_VERSION,
  reduceAgentState,
  type AgentEvent,
  type AgentRunState,
  type AgentState,
  type TaskRecord,
} from "../../src/index.ts";
import { terminalAttentionState } from "../../src/tui/view-model.ts";
import { fixtureAgentProfile } from "../helpers.ts";

const model = { provider: "fixture", model: "test", reasoningEffort: "provider-default" as const };
const profile = fixtureAgentProfile("child");

function state(overrides: Partial<AgentState> = {}): AgentState {
  const created: AgentEvent = {
    id: "created",
    sessionId: "child",
    branchId: "child-main",
    causationId: null,
    correlationId: null,
    type: "SessionCreated",
    schemaVersion: EVENT_SCHEMA_VERSION,
    producer: "supervisor",
    idempotencyKey: "created",
    committedAt: "2026-08-07T00:00:00.000Z",
    cursor: "0001",
    originDeviceId: "device",
    originSequence: 1,
    streamParentId: null,
    payload: {
      workspaceId: "workspace",
      initialBranchId: "child-main",
      model,
      budget: {},
      agentProfile: profile,
      parentSessionId: "parent",
      parentBranchId: "parent-main",
      rootSessionId: "parent",
      depth: 1,
      taskId: "task",
    },
  };
  return { ...reduceAgentState(undefined, created), ...overrides };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task",
    parentSessionId: "parent",
    parentBranchId: "parent-main",
    childSessionId: "child",
    childBranchId: "child-main",
    task: "Do retained work",
    completionCriteria: null,
    model,
    budget: {},
    status: "admitted",
    cancellationRequested: false,
    artifactIds: [],
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

function run(status: AgentRunState["status"], overrides: Partial<AgentRunState> = {}): AgentRunState {
  return {
    id: "run",
    task: "Do retained work",
    requestKey: "request",
    profilePin: {
      profileVersionId: profile.profileVersionId,
      agentPromptDigest: profile.promptDigest,
      promptContractId: profile.promptContractId,
    },
    goalId: null,
    goalMode: "none",
    wakeId: null,
    status,
    steps: [],
    goalChecks: {},
    cancellationRequested: false,
    requestEventId: "run-request",
    eventId: "run-event",
    ...overrides,
  };
}

describe("family activity projection", () => {
  test("keeps missing required state unavailable", () => {
    expect(deriveFamilyAgentActivity(null, task())).toEqual({ activity: "unavailable", activityReason: "missing_state" });
    expect(deriveFamilyAgentActivity(state(), null, true)).toEqual({ activity: "unavailable", activityReason: "missing_state" });
  });

  test("derives working, idle, and ended states", () => {
    expect(deriveFamilyAgentActivity(state(), task())).toEqual({ activity: "idle", activityReason: null });
    expect(deriveFamilyAgentActivity(state(), task({ status: "running" })))
      .toEqual({ activity: "working", activityReason: null });
    expect(deriveFamilyAgentActivity(state({ status: "stopped" }), task({ status: "completed" })))
      .toEqual({ activity: "idle", activityReason: null });
    expect(deriveFamilyAgentActivity(state({ status: "stopped" }), task({ status: "cancelled" })))
      .toEqual({ activity: "ended", activityReason: "cancelled" });
    expect(deriveFamilyAgentActivity(state({ status: "archived" }), null, false))
      .toEqual({ activity: "ended", activityReason: "archived" });
  });

  test("keeps explicit unresolved outcomes in attention", () => {
    expect(deriveFamilyAgentActivity(state(), task({ cancellationRequested: true })))
      .toEqual({ activity: "attention", activityReason: "cancellation_pending" });
    expect(deriveFamilyAgentActivity(state({ budget: { limits: {}, tokens: 1, costUsd: 0, turns: 1, wallTimeMs: 0, exceeded: true } }), task()))
      .toEqual({ activity: "attention", activityReason: "budget_exceeded" });
    expect(deriveFamilyAgentActivity(state({ status: "failed" }), task({ status: "failed" })))
      .toEqual({ activity: "attention", activityReason: "failed" });
    expect(deriveFamilyAgentActivity(state({
      appliedEventIds: ["created", "run-event"],
      agentRuns: { run: run("blocked") },
    }), task({ status: "completed" }))).toEqual({ activity: "attention", activityReason: "blocked" });
    expect(deriveFamilyAgentActivity(state({
      effects: {
        effect: {
          id: "effect",
          executor: "shell",
          operation: "run",
          input: {},
          origin: { kind: "runtime", requestId: "effect" },
          idempotencyKey: "effect",
          idempotent: false,
          attempts: 1,
          status: "unknown",
          eventId: "effect-event",
        },
      },
    }), task({ status: "completed" }))).toEqual({ activity: "attention", activityReason: "unknown" });
  });

  test("keeps background title uncertainty out of family attention", () => {
    expect(deriveFamilyAgentActivity(state({
      status: "stopped",
      effects: {
        title: {
          id: "title",
          executor: "model",
          operation: "complete",
          input: {},
          origin: { kind: "session-title", requestId: "title-request" },
          idempotencyKey: "title",
          idempotent: false,
          attempts: 1,
          status: "unknown",
          eventId: "title-event",
        },
      },
    }), task({ status: "completed" }))).toEqual({
      activity: "idle",
      activityReason: null,
    });
  });

  test("does not label healthy active effects as recovery work", () => {
    const pending = {
      id: "effect",
      executor: "model",
      operation: "complete",
      input: {},
      origin: { kind: "model-call" as const, callId: "call" },
      idempotencyKey: "effect",
      idempotent: false,
      attempts: 1,
      status: "started" as const,
      eventId: "effect-event",
    };
    expect(terminalAttentionState(state({
      appliedEventIds: ["created", "run-event"],
      effects: { effect: pending },
      agentRuns: { run: run("running") },
    }))).toEqual({ attentionCount: 0, recoveryCount: 0 });
    expect(terminalAttentionState(state({
      effects: { effect: pending },
    }))).toEqual({ attentionCount: 0, recoveryCount: 1 });
  });

  test("uses the latest run by canonical event order", () => {
    const older = run("failed", { id: "older", eventId: "older-event" });
    const newer = run("succeeded", { id: "newer", eventId: "newer-event" });
    expect(deriveFamilyAgentActivity(state({
      status: "stopped",
      appliedEventIds: ["created", "older-event", "newer-event"],
      agentRuns: { newer, older },
    }), task({ status: "completed" }))).toEqual({ activity: "idle", activityReason: null });
  });
});

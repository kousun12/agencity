import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Supervisor } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, waitFor, type TempRuntime } from "../helpers.ts";
import { RecordingProvider } from "./helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

async function open(temp: TempRuntime, providers: readonly RecordingProvider[] = [], recover = false): Promise<Supervisor> {
  return Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: providers, recover });
}

describe("Slice 2 current-version goal gates and autonomous recovery", () => {
  test("a gate result is stale when the branch/workspace cursor changes during evaluation", async () => {
    const temp = await makeTempRuntime("agencity-slice2-goal-stale-"); temps.push(temp);
    const supervisor = await open(temp);
    try {
      const root = await supervisor.createSession({ workspaceId: "stale" });
      const goal = await supervisor.goals.create(root.sessionId, root.branchId, {
        description: "validated against exact version",
        gates: [{
          name: "concurrent gate", executor: "shell", operation: "run", idempotent: false,
          input: { command: "sleep 0.1" },
        }],
      });
      const completion = supervisor.goals.requestCompletion(root.sessionId, root.branchId, goal.goalId);
      await waitFor(async () => (await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId }))
        .some(event => event.type === "GoalGateStatusChanged" && (event.payload as { status?: string }).status === "running"));
      await supervisor.appendMessage(root.sessionId, root.branchId, "user", "workspace changed while gate ran");
      const evaluated = await completion;
      expect(evaluated.status).toBe("blocked");
      expect(evaluated.reason?.toLowerCase()).toMatch(/stale|cursor|workspace|version/);
      expect(evaluated.gates[0]?.status).not.toBe("passed");
    } finally { await supervisor.close(); }
  });

  test("a failed required gate can be retried after the workspace changes", async () => {
    const temp = await makeTempRuntime("agencity-slice2-goal-retry-"); temps.push(temp);
    const supervisor = await open(temp);
    try {
      const root = await supervisor.createSession({ workspaceId: "retry" });
      const marker = join(temp.workspaceRoot, "gate-ready");
      const goal = await supervisor.goals.create(root.sessionId, root.branchId, {
        description: "eventually pass",
        gates: [{ name: "marker exists", executor: "shell", operation: "run", input: { command: "test -f gate-ready" }, idempotent: true }],
      });
      const failed = await supervisor.goals.requestCompletion(root.sessionId, root.branchId, goal.goalId);
      expect(failed.status).toBe("blocked");
      expect(failed.gates[0]?.status).toBe("failed");

      await writeFile(marker, "ready");
      await supervisor.appendMessage(root.sessionId, root.branchId, "user", "fixed gate input");
      await supervisor.goals.runContinuation(root.sessionId, root.branchId, goal.goalId, { maxTurns: 1 });
      const retried = await supervisor.goals.requestCompletion(root.sessionId, root.branchId, goal.goalId);
      expect(retried.status).toBe("completed");
      expect(retried.gates[0]?.status).toBe("passed");
    } finally { await supervisor.close(); }
  });

  test("recovery surfaces an ambiguous non-idempotent gate as unknown and blocks completion", async () => {
    const temp = await makeTempRuntime("agencity-slice2-goal-unknown-"); temps.push(temp);
    const supervisor = await open(temp);
    const root = await supervisor.createSession({ workspaceId: "unknown" });
    const goal = await supervisor.goals.create(root.sessionId, root.branchId, {
      description: "never infer gate success",
      gates: [{ name: "external publish", executor: "shell", operation: "run", input: { command: "echo publish" }, idempotent: false }],
    });
    const gate = goal.gates[0]!;
    const effectId = "ambiguous-goal-effect";
    await supervisor.storage.appendEvents([{
      sessionId: root.sessionId, branchId: root.branchId, type: "GoalCompletionRequested", producer: "client",
      idempotencyKey: `test-goal-completion:${goal.goalId}`, payload: { goalId: goal.goalId, requestId: "ambiguous-request" },
    }, {
      sessionId: root.sessionId, branchId: root.branchId, type: "EffectRequested", producer: "supervisor",
      idempotencyKey: `test-goal-effect:${effectId}`, payload: {
        effectId, executor: "shell", operation: "run", input: { command: "echo publish" },
        origin: { kind: "goal-gate", goalId: goal.goalId, gateId: gate.gateId, requestId: "ambiguous-request" },
        idempotencyKey: `test-goal-effect:${effectId}`, idempotent: false,
      },
    }, {
      sessionId: root.sessionId, branchId: root.branchId, type: "GoalGateStatusChanged", producer: "supervisor",
      idempotencyKey: `test-goal-running:${gate.gateId}`, payload: { goalId: goal.goalId, gateId: gate.gateId, status: "running", effectId },
    }, {
      sessionId: root.sessionId, branchId: root.branchId, type: "EffectAttemptStarted", producer: "executor",
      idempotencyKey: `test-goal-attempt:${effectId}`, payload: { effectId, attempt: 1 },
    }]);
    await supervisor.close();

    const recovered = await open(temp, [], true);
    try {
      const durable = await recovered.storage.getGoal?.(goal.goalId);
      const gates = await recovered.storage.listGoalGates?.(goal.goalId);
      expect(durable?.status).toBe("blocked");
      expect((gates?.[0] as { status?: string } | undefined)?.status).toBe("unknown");
      expect(gates?.[0]?.error?.toLowerCase()).toContain("unknown");
      const outbox = await recovered.storage.getOutbox(effectId);
      expect(outbox?.status).toBe("unknown");
    } finally { await recovered.close(); }
  });

  test("a session cannot carry two competing current goals", async () => {
    const temp = await makeTempRuntime("agencity-slice2-current-goal-"); temps.push(temp);
    const supervisor = await open(temp);
    try {
      const root = await supervisor.createSession({ workspaceId: "current" });
      const currentGoal = await supervisor.goals.create(root.sessionId, root.branchId, { description: "current" });
      await expect(supervisor.goals.create(root.sessionId, root.branchId, { description: "competing" }))
        .rejects.toThrow(/current|active|goal|transition/i);
      expect((await supervisor.goals.requestCompletion(root.sessionId, root.branchId, currentGoal.goalId)).status).toBe("completed");
    } finally { await supervisor.close(); }
  });

  test("an active autonomous goal resumes model turns after supervisor restart", async () => {
    const temp = await makeTempRuntime("agencity-slice2-goal-resume-"); temps.push(temp);
    const provider = new RecordingProvider("autonomous");
    const supervisor = await open(temp, [provider]);
    const root = await supervisor.createSession({ workspaceId: "autonomous", model: { provider: provider.name, model: "resume" } });
    await supervisor.goals.create(root.sessionId, root.branchId, { description: "continue without an attached UI", maxTurns: 2 });
    const callsBeforeRestart = provider.calls;
    await supervisor.close();

    const resumed = await open(temp, [provider], true);
    try {
      await waitFor(() => provider.calls > callsBeforeRestart, "autonomous continuation after restart", 500);
      const state = await resumed.projections.getSnapshot(root.sessionId, root.branchId);
      expect(state.state.budget.turns).toBeGreaterThan(0);
    } finally { await resumed.close(); }
  });
});

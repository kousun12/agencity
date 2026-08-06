import { afterEach, describe, expect, test } from "bun:test";
import {
  AGENT_ACTION_PROTOCOL,
  AGENT_ACTION_VERSION,
  AgentClient,
  ProtocolServer,
  ScriptedAgentActionProvider,
  Supervisor,
  eventTypes,
  projectEvents,
  WORKSPACE_MATERIAL_EVENT_CLASS,
  type AgentAction,
  type JsonValue,
  type ModelConfiguration,
  type ModelResponse,
} from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });
const action = <T extends Omit<AgentAction, "protocol" | "version">>(value: T): AgentAction => ({ protocol: AGENT_ACTION_PROTOCOL, version: AGENT_ACTION_VERSION, ...value } as unknown as AgentAction);

class RecordingActions extends ScriptedAgentActionProvider {
  readonly contexts: JsonValue[] = [];
  calls = 0;
  override async complete(context: JsonValue, configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    this.contexts.push(context); this.calls++;
    return super.complete(context, configuration, signal);
  }
}

async function open(temp: TempRuntime, provider?: RecordingActions, recover = false): Promise<Supervisor> {
  return Supervisor.open({
    databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot, recover,
    ...(provider ? { modelProviders: [provider] } : {}),
  });
}

function observations(context: JsonValue): Array<{ eventId: string; type: string; payload: JsonValue }> {
  if (!context || typeof context !== "object" || Array.isArray(context) || !context.run || typeof context.run !== "object" || Array.isArray(context.run) || !Array.isArray(context.run.observations)) return [];
  return context.run.observations as Array<{ eventId: string; type: string; payload: JsonValue }>;
}

describe("FU-014 product autonomy", () => {
  test("goalMode auto atomically creates a goal and run, then failed gate feedback is observed exactly once and repaired", async () => {
    const temp = await makeTempRuntime("agencity-fu014-repair-"); temps.push(temp);
    const provider = new RecordingActions([
      action({ type: "final", content: "provisional" }),
      action({ type: "typescript", code: 'await tools.writeFile("gate-ready", "yes")' }),
      action({ type: "final", content: "verified" }),
    ], "fu014-repair");
    const supervisor = await open(temp, provider);
    try {
      const session = await supervisor.createSession({ workspaceId: "fu014", model: { provider: provider.name, model: "actions" } });
      const batches: string[][] = [];
      const stop = supervisor.storage.onCommitted(events => batches.push(events.map(event => event.type)));
      const result = await supervisor.runs.start(session.sessionId, session.branchId, {
        task: "repair until verified", goalMode: "auto",
        goal: { description: "repair", gates: [{ name: "marker", executor: "shell", operation: "run", input: { command: "test -f gate-ready" }, idempotent: true }] },
      });
      stop();
      expect(result.status).toBe("succeeded");
      expect(result.final).toBe("verified");
      expect(batches.some(batch => batch.includes("GoalCreated") && batch.includes("GoalGateAdded") && batch.includes("AgentRunRequested"))).toBe(true);
      const checkObservations = provider.contexts.flatMap(observations).filter(item => item.type === "AgentRunGoalCheckRecorded");
      expect(checkObservations).toHaveLength(1);
      expect(JSON.stringify(checkObservations[0]?.payload)).toContain('"status":"failed"');
      const state = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      const goal = state.goals[state.agentRuns[result.runId]!.goalId!]!;
      expect(goal.status).toBe("completed");
      expect(goal.gates[Object.keys(goal.gates)[0]!]!.evaluations).toHaveLength(2);
    } finally { await supervisor.close(); }
  });

  test("gate cache reuses unchanged terminal evidence and material cell/state changes invalidate it", async () => {
    const temp = await makeTempRuntime("agencity-fu014-cache-"); temps.push(temp);
    const supervisor = await open(temp);
    try {
      const session = await supervisor.createSession({ workspaceId: "cache" });
      const goal = await supervisor.goals.create(session.sessionId, session.branchId, {
        description: "cached gate", gates: [{ name: "fails", executor: "shell", operation: "run", input: { command: "exit 9" }, idempotent: true }],
      });
      await supervisor.goals.requestCompletion(session.sessionId, session.branchId, goal.goalId);
      await supervisor.goals.runContinuation(session.sessionId, session.branchId, goal.goalId);
      const cached = await supervisor.goals.requestCompletion(session.sessionId, session.branchId, goal.goalId);
      expect(cached.status).toBe("blocked");
      expect(cached.reason).toContain("unchanged workspace material (cached)");
      let events = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      expect(events.filter(event => event.type === "EffectRequested" && (event.payload as { executor?: string }).executor === "shell")).toHaveLength(1);
      expect((await supervisor.storage.listGoalGateEvaluations!(goal.goalId))[1]?.cachedFromEvaluationId).toBeDefined();

      await supervisor.goals.runContinuation(session.sessionId, session.branchId, goal.goalId);
      await supervisor.executeCell(session.sessionId, session.branchId, 'await state.set("material-repair", { attempt: 1 })');
      const stale = await supervisor.goals.get(session.sessionId, session.branchId, goal.goalId);
      expect(stale.gates[0]?.currentStale).toBe(true);
      await supervisor.goals.requestCompletion(session.sessionId, session.branchId, goal.goalId);
      events = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      expect(events.filter(event => event.type === "EffectRequested" && (event.payload as { executor?: string }).executor === "shell")).toHaveLength(2);
      expect(await supervisor.storage.listGoalGateEvaluations!(goal.goalId)).toHaveLength(3);
    } finally { await supervisor.close(); }
  });

  test("one-time schedule survives restart, coalesces through the durable wake queue, and delivers one AgentRun", async () => {
    const temp = await makeTempRuntime("agencity-fu014-schedule-"); temps.push(temp);
    const due = "2099-01-01T00:00:00.000Z";
    let supervisor = await open(temp);
    const session = await supervisor.createSession({ workspaceId: "schedule", model: { provider: "fu014-wake", model: "actions" } });
    const schedule = await supervisor.schedules.create(session.sessionId, session.branchId, { at: due, prompt: "scheduled work", goalMode: "auto" });
    await supervisor.close();

    const provider = new RecordingActions([action({ type: "final", content: "woke once" })], "fu014-wake");
    supervisor = await open(temp, provider, true);
    try {
      const recovered = await supervisor.schedules.recover(due);
      expect(recovered.ticks).toBe(1);
      expect(recovered.delivered).toBe(1);
      expect(provider.calls).toBe(1);
      expect((await supervisor.storage.getSchedule!(schedule.scheduleId))?.status).toBe("completed");
      const wakes = await supervisor.schedules.wakes(session.sessionId, session.branchId);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.status).toBe("delivered");
      expect(wakes[0]?.runId).toBe(`autonomy-wake-run:${wakes[0]?.wakeId}`);
      expect(await supervisor.schedules.deliverQueued()).toBe(0);
      expect(provider.calls).toBe(1);
      const history = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      expect(history.filter(event => event.type === "WakeClaimed")).toHaveLength(1);
      expect(history.filter(event => event.type === "WakeDelivered")).toHaveLength(1);
    } finally { await supervisor.close(); }
  });

  test("console goals are read-only and agent heartbeat/schedule ownership cannot override user records", async () => {
    const temp = await makeTempRuntime("agencity-fu014-sdk-"); temps.push(temp);
    const supervisor = await open(temp);
    try {
      const session = await supervisor.createSession({ workspaceId: "sdk" });
      const goal = await supervisor.goals.create(session.sessionId, session.branchId, "user goal");
      const observed = await supervisor.executeCell(session.sessionId, session.branchId, "return await sdk.goals.current()") as { result: { goalId?: string } };
      expect(observed.result.goalId).toBe(goal.goalId);
      const userHeartbeat = await supervisor.heartbeats.create(session.sessionId, session.branchId, { intervalMs: 60_000, nextTickAt: "2099-01-01T00:00:00.000Z" });
      await expect(supervisor.executeCell(session.sessionId, session.branchId, `await sdk.heartbeats.pause(${JSON.stringify(userHeartbeat.heartbeatId)})`)).rejects.toThrow(/user-owned/i);
      expect((await supervisor.storage.getHeartbeat!(userHeartbeat.heartbeatId))?.status).toBe("active");
      await supervisor.executeCell(session.sessionId, session.branchId, 'return await sdk.heartbeats.create({ intervalMs: 60000, nextTickAt: "2099-01-01T00:00:00.000Z", prompt: "agent wake" })');
      await supervisor.executeCell(session.sessionId, session.branchId, 'return await sdk.schedules.create({ at: "2099-01-02T00:00:00.000Z", prompt: "agent schedule" })');
      expect((await supervisor.heartbeats.list(session.sessionId, session.branchId)).filter(item => item.owner === "agent")).toHaveLength(1);
      expect((await supervisor.schedules.list(session.sessionId, session.branchId)).filter(item => item.owner === "agent")).toHaveLength(1);
    } finally { await supervisor.close(); }
  });


  test("protocol/client lifecycle surfaces and projection rebuild retain schedules, wakes, owners, and gate evaluation history", async () => {
    const temp = await makeTempRuntime("agencity-fu014-protocol-"); temps.push(temp);
    const supervisor = await open(temp);
    const server = new ProtocolServer(supervisor).listen(0);
    const client = new AgentClient(`http://${server.hostname}:${server.port}`);
    try {
      const session = await supervisor.createSession({ workspaceId: "protocol" });
      const goal = await client.createGoal(session.sessionId, session.branchId, { description: "protocol goal", gates: [{ name: "ok", executor: "shell", operation: "run", input: { command: "true" }, idempotent: true }] });
      expect((await client.currentGoal(session.sessionId, session.branchId))?.goalId).toBe(goal.goalId);
      expect((await client.requestGoalCompletion(session.sessionId, session.branchId, goal.goalId)).status).toBe("completed");
      expect(await client.goalEvaluations(session.sessionId, session.branchId, goal.goalId)).toHaveLength(1);
      const heartbeat = await client.createHeartbeat(session.sessionId, session.branchId, { intervalMs: 60_000, nextTickAt: "2099-03-01T00:00:00.000Z", prompt: "protocol heartbeat" });
      expect((await client.heartbeats(session.sessionId, session.branchId))[0]?.owner).toBe("user");
      await client.pauseHeartbeat(heartbeat.heartbeatId);
      await client.resumeHeartbeat(heartbeat.heartbeatId, "2099-03-01T00:01:00.000Z");
      const schedule = await client.createSchedule(session.sessionId, session.branchId, { at: "2099-03-02T00:00:00.000Z", prompt: "protocol schedule" });
      await client.tickSchedule(schedule.scheduleId, "2099-03-02T00:00:00.000Z");
      expect(await client.wakes(session.sessionId, session.branchId, ["queued"])).toHaveLength(1);

      await supervisor.storage.rebuildOperationalProjections!();
      expect(await supervisor.storage.listGoalGateEvaluations!(goal.goalId)).toHaveLength(1);
      expect((await supervisor.storage.getHeartbeat!(heartbeat.heartbeatId))?.owner).toBe("user");
      expect((await supervisor.storage.getSchedule!(schedule.scheduleId))?.status).toBe("completed");
      expect(await supervisor.storage.listWakes!(session.sessionId, session.branchId)).toHaveLength(1);
    } finally { server.stop(); await supervisor.close(); }
  });

  test("interval schedules coalesce missed ticks and claimed wake recovery reuses the stable run identity", async () => {
    const temp = await makeTempRuntime("agencity-fu014-claimed-"); temps.push(temp);
    const due = "2099-04-01T00:00:00.000Z";
    const provider = new RecordingActions([action({ type: "final", content: "claimed recovered" })], "fu014-claimed");
    let supervisor = await open(temp, provider);
    const session = await supervisor.createSession({ workspaceId: "claimed", model: { provider: provider.name, model: "actions" } });
    const schedule = await supervisor.schedules.create(session.sessionId, session.branchId, { at: due, intervalMs: 1_000, prompt: "coalesced work", goalMode: "auto" });
    await supervisor.schedules.tick(schedule.scheduleId, "2099-04-01T00:00:03.500Z");
    const wake = (await supervisor.schedules.wakes(session.sessionId, session.branchId))[0]!;
    await supervisor.storage.appendEvents([{ sessionId: session.sessionId, branchId: session.branchId, type: "WakeClaimed", producer: "scheduler", idempotencyKey: `test-claim:${wake.wakeId}`, payload: { wakeId: wake.wakeId, claimId: `wake-claim:${wake.wakeId}`, claimedAt: "2099-04-01T00:00:03.500Z" } }]);
    await supervisor.close();

    supervisor = await open(temp, provider, true);
    try {
      expect(provider.calls).toBe(1);
      const recovered = (await supervisor.schedules.wakes(session.sessionId, session.branchId))[0]!;
      expect(recovered.status).toBe("delivered");
      expect(recovered.runId).toBe(`autonomy-wake-run:${wake.wakeId}`);
      const durable = await supervisor.storage.getSchedule!(schedule.scheduleId);
      expect(durable?.nextTickAt).toBe("2099-04-01T00:00:04.000Z");
      const history = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      const tick = history.find(event => event.type === "ScheduleTicked")?.payload as { missedIntervals?: number };
      expect(tick.missedIntervals).toBe(3);
      expect(history.filter(event => event.type === "AgentRunRequested")).toHaveLength(1);
    } finally { await supervisor.close(); }
  });

  test("workspace material classifier is exhaustive for the released event contract", () => {
    expect(Object.keys(WORKSPACE_MATERIAL_EVENT_CLASS).sort()).toEqual([...eventTypes].sort());
    expect(WORKSPACE_MATERIAL_EVENT_CLASS.CellCommitted).toBe("material");
    expect(WORKSPACE_MATERIAL_EVENT_CLASS.WorkingValueSet).toBe("material");
    expect(WORKSPACE_MATERIAL_EVENT_CLASS.EffectOutcomeRecorded).toBe("file-effect");
    expect(WORKSPACE_MATERIAL_EVENT_CLASS.GoalGateEvaluationRecorded).toBe("non-material");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { Supervisor, type AgentEvent } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, waitFor, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

async function open(temp: TempRuntime, recover: boolean): Promise<Supervisor> {
  return Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover });
}

describe("Slice 2 durable heartbeat scheduling", () => {
  test("a tick, its wake-up message, and next schedule commit atomically", async () => {
    const temp = await makeTempRuntime("agencity-slice2-heartbeat-atomic-"); temps.push(temp);
    const supervisor = await open(temp, false);
    try {
      const root = await supervisor.createSession({ workspaceId: "heartbeat" });
      const due = "2026-01-01T00:00:00.000Z";
      const heartbeat = await supervisor.heartbeats.create(root.sessionId, root.branchId, { intervalMs: 1_000, nextTickAt: due, payload: { wake: "inspect queue" } });
      const batches: readonly AgentEvent[][] = [];
      const mutableBatches = batches as AgentEvent[][];
      const stop = supervisor.storage.onCommitted((events) => mutableBatches.push([...events]));
      const ticked = await supervisor.heartbeats.tick(heartbeat.heartbeatId, due);
      stop();

      const tickBatch = mutableBatches.find((events) => events.some((event) => event.type === "HeartbeatTicked"));
      expect(tickBatch?.filter((event) => event.type === "HeartbeatTicked")).toHaveLength(1);
      expect(tickBatch?.filter((event) => event.type === "MessageAppended")).toHaveLength(1);
      const wake = tickBatch?.find((event) => event.type === "MessageAppended");
      expect(JSON.stringify(wake?.payload)).toContain("inspect queue");
      expect(ticked.nextTickAt).toBe("2026-01-01T00:00:01.000Z");
    } finally { await supervisor.close(); }
  });

  test("early ticks are rejected and do not advance schedule or messages", async () => {
    const temp = await makeTempRuntime("agencity-slice2-heartbeat-early-"); temps.push(temp);
    const supervisor = await open(temp, false);
    try {
      const root = await supervisor.createSession({ workspaceId: "early" });
      const heartbeat = await supervisor.heartbeats.create(root.sessionId, root.branchId, { intervalMs: 1_000, nextTickAt: "2026-01-01T00:00:10.000Z" });
      await expect(supervisor.heartbeats.tick(heartbeat.heartbeatId, "2026-01-01T00:00:09.999Z"))
        .rejects.toThrow(/due|early|schedule/i);
      const durable = await supervisor.storage.getHeartbeat?.(heartbeat.heartbeatId);
      expect(durable).toMatchObject({ tick: 0, nextTickAt: "2026-01-01T00:00:10.000Z" });
      const events = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      expect(events.filter((event) => event.type === "MessageAppended")).toHaveLength(0);
    } finally { await supervisor.close(); }
  });

  test("missed intervals coalesce into one wake-up and preserve schedule alignment", async () => {
    const temp = await makeTempRuntime("agencity-slice2-heartbeat-coalesce-"); temps.push(temp);
    const supervisor = await open(temp, false);
    try {
      const root = await supervisor.createSession({ workspaceId: "coalesce" });
      const heartbeat = await supervisor.heartbeats.create(root.sessionId, root.branchId, { intervalMs: 1_000, nextTickAt: "2026-01-01T00:00:00.000Z", payload: { reason: "overdue" } });
      const [left, right] = await Promise.all([
        supervisor.heartbeats.tick(heartbeat.heartbeatId, "2026-01-01T00:00:03.500Z"),
        supervisor.heartbeats.tick(heartbeat.heartbeatId, "2026-01-01T00:00:03.750Z"),
      ]);
      expect(left.tick).toBe(1);
      expect(right.tick).toBe(1);
      expect(left.nextTickAt).toBe("2026-01-01T00:00:04.000Z");
      expect(right.nextTickAt).toBe(left.nextTickAt);
      const events = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      expect(events.filter((event) => event.type === "HeartbeatTicked")).toHaveLength(1);
      expect(events.filter((event) => event.type === "MessageAppended")).toHaveLength(1);
    } finally { await supervisor.close(); }
  });

  test("due active heartbeats recover and fire after restart without an in-memory timer", async () => {
    const temp = await makeTempRuntime("agencity-slice2-heartbeat-recover-"); temps.push(temp);
    const supervisor = await open(temp, false);
    const root = await supervisor.createSession({ workspaceId: "recover" });
    const heartbeat = await supervisor.heartbeats.create(root.sessionId, root.branchId, {
      intervalMs: 60_000,
      nextTickAt: new Date(Date.now() - 60_000).toISOString(),
      payload: { wake: "after restart" },
    });
    await supervisor.close();

    const recovered = await open(temp, true);
    try {
      await waitFor(async () => (await recovered.storage.getHeartbeat?.(heartbeat.heartbeatId))?.tick === 1, "recovered heartbeat", 500);
      const durable = await recovered.storage.getHeartbeat?.(heartbeat.heartbeatId);
      expect(durable?.tick).toBe(1);
      expect(Date.parse(durable!.nextTickAt)).toBeGreaterThan(Date.now());
      const events = await recovered.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      expect(events.some((event) => event.type === "MessageAppended" && JSON.stringify(event.payload).includes("after restart"))).toBe(true);
    } finally { await recovered.close(); }
  });

  test("paused and cancelled schedules are never recovered as due", async () => {
    const temp = await makeTempRuntime("agencity-slice2-heartbeat-terminal-"); temps.push(temp);
    const supervisor = await open(temp, false);
    const root = await supervisor.createSession({ workspaceId: "terminal" });
    const due = new Date(Date.now() - 1_000).toISOString();
    const paused = await supervisor.heartbeats.create(root.sessionId, root.branchId, { intervalMs: 1_000, nextTickAt: due });
    const cancelled = await supervisor.heartbeats.create(root.sessionId, root.branchId, { intervalMs: 1_000, nextTickAt: due });
    await supervisor.heartbeats.pause(paused.heartbeatId);
    await supervisor.heartbeats.cancel(cancelled.heartbeatId);
    await supervisor.close();

    const recovered = await open(temp, true);
    try {
      await Bun.sleep(75);
      expect((await recovered.storage.getHeartbeat?.(paused.heartbeatId))?.tick).toBe(0);
      expect((await recovered.storage.getHeartbeat?.(cancelled.heartbeatId))?.tick).toBe(0);
    } finally { await recovered.close(); }
  });
});

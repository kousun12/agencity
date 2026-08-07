import { afterEach, expect, test } from "bun:test";
import { AgentService, Supervisor, type AgentEvent, type AgentStorage } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

function committedEventSet(events: readonly AgentEvent[], eventCount: number): AgentEvent[] {
  if (!events.length || events.length >= eventCount) return [...events];
  const lastCursor = BigInt(events.at(-1)!.cursor);
  const seed = events[0]!;
  return [
    ...events,
    ...Array.from({ length: eventCount - events.length }, (_, index): AgentEvent => ({
      id: `family-refresh-benchmark-${seed.sessionId}-${seed.branchId}-${index}`,
      sessionId: seed.sessionId,
      branchId: seed.branchId,
      causationId: null,
      correlationId: null,
      type: "MessageAppended",
      schemaVersion: 1,
      committedAt: "2026-08-07T00:00:00.000Z",
      producer: "benchmark",
      idempotencyKey: `family-refresh-benchmark:${seed.sessionId}:${seed.branchId}:${index}`,
      payload: {
        messageId: `family-refresh-message-${seed.sessionId}-${seed.branchId}-${index}`,
        role: "tool",
        content: `bounded family refresh benchmark event ${index}`,
      },
      cursor: (lastCursor + BigInt(index + 1)).toString().padStart(20, "0"),
      originDeviceId: "family-refresh-benchmark",
      originSequence: index + 1,
      streamParentId: null,
    })),
  ];
}

test("family refresh benchmark reuses projections for 25 relatives with 5,000 events per branch", async () => {
  const temp = await makeTempRuntime("agencity-family-refresh-benchmark-"); temps.push(temp);
  const supervisor = await Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    recover: false,
  });
  try {
    const root = await supervisor.createSession({
      workspaceId: "family-refresh-benchmark",
      sessionName: "Benchmark root",
    });
    await supervisor.agents.spawnMany(
      root.sessionId,
      root.branchId,
      Array.from({ length: 25 }, (_, index) => ({
        task: `Benchmark child task ${index}`,
        name: `benchmark-child-${String(index).padStart(2, "0")}`,
        run: false,
      })),
    );
    const work = {
      getLatestCursorCalls: 0,
      loadSnapshotCalls: 0,
      loadEventsCalls: 0,
      loadedEvents: 0,
      saveSnapshotCalls: 0,
      getSessionCalls: 0,
      getTaskCalls: 0,
    };
    const instrumented = new Proxy(supervisor.storage, {
      get(target, property) {
        if (property === "getLatestCursor") return async (sessionId: string, branchId: string) => {
          work.getLatestCursorCalls++;
          const events = await target.loadEvents(sessionId, { branchId });
          if (!events.length) return null;
          const missing = Math.max(0, 5_000 - events.length);
          return (BigInt(events.at(-1)!.cursor) + BigInt(missing)).toString().padStart(20, "0");
        };
        if (property === "loadSnapshot") return async (...args: Parameters<AgentStorage["loadSnapshot"]>) => {
          work.loadSnapshotCalls++;
          return target.loadSnapshot(...args);
        };
        if (property === "loadEvents") return async (...args: Parameters<AgentStorage["loadEvents"]>) => {
          work.loadEventsCalls++;
          const events = committedEventSet(await target.loadEvents(...args), 5_000);
          work.loadedEvents += events.length;
          return events;
        };
        if (property === "saveSnapshot") return async (...args: Parameters<AgentStorage["saveSnapshot"]>) => {
          work.saveSnapshotCalls++;
          return target.saveSnapshot(...args);
        };
        if (property === "getSession") return async (...args: [string]) => {
          work.getSessionCalls++;
          return target.getSession!(...args);
        };
        if (property === "getTask") return async (...args: [string]) => {
          work.getTaskCalls++;
          return target.getTask!(...args);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentStorage;
    const service = new AgentService(instrumented);
    const coldStartedAt = performance.now();
    const family = await service.listFamily(root.sessionId, root.branchId);
    const coldLatencyMs = Math.round((performance.now() - coldStartedAt) * 100) / 100;
    const coldWork = { ...work };

    for (const key of Object.keys(work) as Array<keyof typeof work>) work[key] = 0;
    const warmStartedAt = performance.now();
    const refreshed = await service.listFamily(root.sessionId, root.branchId);
    const warmLatencyMs = Math.round((performance.now() - warmStartedAt) * 100) / 100;

    console.info("[family refresh benchmark]", {
      relatives: family.items.length,
      eventsPerBranch: 5_000,
      coldLatencyMs,
      warmLatencyMs,
      coldWork,
      warmWork: work,
    });
    expect(family.items).toHaveLength(25);
    expect(refreshed.items).toEqual(family.items);
    expect(coldWork).toEqual({
      getLatestCursorCalls: 26,
      loadSnapshotCalls: 26,
      loadEventsCalls: 26,
      loadedEvents: 130_000,
      saveSnapshotCalls: 26,
      getSessionCalls: 26,
      getTaskCalls: 25,
    });
    expect(work).toEqual({
      getLatestCursorCalls: 26,
      loadSnapshotCalls: 26,
      loadEventsCalls: 0,
      loadedEvents: 0,
      saveSnapshotCalls: 0,
      getSessionCalls: 26,
      getTaskCalls: 25,
    });
  } finally {
    await supervisor.close();
  }
}, 45_000);

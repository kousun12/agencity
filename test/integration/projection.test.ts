import { afterEach, describe, expect, test } from "bun:test";
import {
  OutboxRunner,
  ProjectionService,
  reduceAgentState,
  result,
  type AgentEvent,
  type AgentState,
  type AgentStorage,
  type EffectExecutor,
  type EventQuery,
  type NewAgentEvent,
  type OutboxRecord,
  type ReadonlyStatement,
} from "../../src/index.ts";
import {
  appendMessage,
  makeTempRuntime,
  openTempStorage,
  removeTempRuntime,
  seedSession,
  waitFor,
  type TempRuntime,
} from "../helpers.ts";

/** Simulates an at-least-once notification transport without duplicating durable rows. */
class DuplicateNotificationStorage implements AgentStorage {
  readonly name: string;
  readonly capabilities;
  constructor(readonly inner: AgentStorage) {
    this.name = `duplicate-notifications(${inner.name})`;
    this.capabilities = inner.capabilities;
  }
  migrate() { return this.inner.migrate(); }
  close() { this.inner.close(); }
  appendEvents(events: readonly NewAgentEvent[]) { return this.inner.appendEvents(events); }
  loadEvents(sessionId: string, query?: EventQuery) { return this.inner.loadEvents(sessionId, query); }
  getEvent(eventId: string) { return this.inner.getEvent(eventId); }
  getLatestCursor(sessionId: string, branchId: string) { return this.inner.getLatestCursor(sessionId, branchId); }
  listBranches() { return this.inner.listBranches(); }
  saveSnapshot(state: AgentState) { return this.inner.saveSnapshot(state); }
  loadSnapshot(sessionId: string, branchId: string) { return this.inner.loadSnapshot(sessionId, branchId); }
  deleteSnapshots(sessionId?: string) { return this.inner.deleteSnapshots(sessionId); }
  claimOutbox(owner: string, limit?: number, leaseMs?: number) {
    return this.inner.claimOutbox(owner, limit, leaseMs);
  }
  claimEffect(effectId: string, owner: string, leaseMs?: number) {
    return this.inner.claimEffect(effectId, owner, leaseMs);
  }
  getOutbox(effectId: string) { return this.inner.getOutbox(effectId); }
  listOutbox(statuses?: readonly OutboxRecord["status"][]) { return this.inner.listOutbox(statuses); }
  resetOutbox(effectId: string) { return this.inner.resetOutbox(effectId); }
  readonlyQuery(statement: ReadonlyStatement) { return this.inner.readonlyQuery(statement); }
  onCommitted(listener: (events: readonly AgentEvent[]) => void): () => void {
    return this.inner.onCommitted((events) => {
      listener(events);
      listener(events);
    });
  }
}

class CountingExecutor implements EffectExecutor {
  readonly name = "counting";
  calls = 0;
  async execute(request: OutboxRecord) {
    this.calls++;
    return result("succeeded", { call: this.calls, effectId: request.effectId });
  }
}

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

describe("reactive snapshots and resumable subscriptions", () => {
  test("current branch recovery projection reuses current snapshots and catches up only stale routes", async () => {
    const temp = await makeTempRuntime("agencity-current-branch-projection-");
    temps.push(temp);
    const storage = await openTempStorage(temp);
    const first = await seedSession(storage, {
      sessionId: "current-branch-first",
      branchId: "main",
    });
    const second = await seedSession(storage, {
      sessionId: "current-branch-second",
      branchId: "main",
    });
    const initial = new ProjectionService(storage);
    await initial.getSnapshot(first.sessionId, first.branchId);
    await initial.getSnapshot(second.sessionId, second.branchId);

    let historyLoads = 0;
    const observed = new Proxy(storage, {
      get(target, property) {
        if (property === "loadEvents") {
          return async (...args: Parameters<AgentStorage["loadEvents"]>) => {
            historyLoads++;
            return target.loadEvents(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentStorage;
    const projection = new ProjectionService(observed);
    expect(await projection.currentBranches()).toHaveLength(2);
    expect(historyLoads).toBe(0);

    await appendMessage(
      storage,
      first.sessionId,
      first.branchId,
      "catch up one stale route",
    );
    const current = await projection.currentBranches();
    expect(historyLoads).toBe(1);
    expect(current.find((branch) =>
      branch.sessionId === first.sessionId)?.state.messages.at(-1)?.content)
      .toBe("catch up one stale route");
  });

  test("terminal waiter covers pre-snapshot, snapshot-subscribe, live, timeout, and cancellation races", async () => {
    const temp = await makeTempRuntime("agencity-terminal-waiter-");
    temps.push(temp);
    const storage = await openTempStorage(temp);
    const first = await seedSession(storage, {
      sessionId: "terminal-before-snapshot",
      branchId: "main",
    });
    await storage.appendEvents([{
      sessionId: first.sessionId,
      branchId: first.branchId,
      type: "SessionStatusChanged",
      producer: "supervisor",
      idempotencyKey: "terminal-before-snapshot",
      payload: { status: "stopped" },
    }]);
    const projection = new ProjectionService(storage);
    expect(await projection.waitForTerminal(
      first.sessionId,
      first.branchId,
      (state) => state.status === "stopped",
      { timeoutMs: 100 },
    )).toMatchObject({ reason: "terminal", mode: "notifications" });

    const between = await seedSession(storage, {
      sessionId: "terminal-between-snapshot-subscribe",
      branchId: "main",
    });
    let injected = false;
    const raceStorage = new Proxy(storage, {
      get(target, property) {
        if (property === "saveSnapshot") {
          return async (state: AgentState) => {
            await target.saveSnapshot(state);
            if (!injected && state.sessionId === between.sessionId) {
              injected = true;
              await target.appendEvents([{
                sessionId: between.sessionId,
                branchId: between.branchId,
                type: "SessionStatusChanged",
                producer: "supervisor",
                idempotencyKey: "terminal-between-snapshot-subscribe",
                payload: { status: "stopped" },
              }]);
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentStorage;
    expect(await new ProjectionService(raceStorage).waitForTerminal(
      between.sessionId,
      between.branchId,
      (state) => state.status === "stopped",
      { timeoutMs: 500 },
    )).toMatchObject({ reason: "terminal", mode: "notifications" });

    const live = await seedSession(storage, {
      sessionId: "terminal-live",
      branchId: "main",
    });
    const liveWait = projection.waitForTerminal(
      live.sessionId,
      live.branchId,
      (state) => state.status === "stopped",
      { timeoutMs: 500 },
    );
    await Bun.sleep(10);
    await storage.appendEvents([{
      sessionId: live.sessionId,
      branchId: live.branchId,
      type: "SessionStatusChanged",
      producer: "supervisor",
      idempotencyKey: "terminal-live",
      payload: { status: "stopped" },
    }]);
    expect(await liveWait).toMatchObject({ reason: "terminal" });

    const bounded = await seedSession(storage, {
      sessionId: "terminal-bounded",
      branchId: "main",
    });
    expect(await projection.waitForTerminal(
      bounded.sessionId,
      bounded.branchId,
      (state) => state.status === "stopped",
      { timeoutMs: 5 },
    )).toMatchObject({ reason: "timeout", state: { status: "idle" } });
    let activeSubscriptions = 0;
    const cleanupStorage = new Proxy(storage, {
      get(target, property) {
        if (property === "onCommitted") {
          return (listener: (events: readonly AgentEvent[]) => void) => {
            activeSubscriptions++;
            const unsubscribe = target.onCommitted(listener);
            let active = true;
            return () => {
              if (active) {
                active = false;
                activeSubscriptions--;
              }
              unsubscribe();
            };
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentStorage;
    const controller = new AbortController();
    const cancelled = new ProjectionService(cleanupStorage).waitForTerminal(
      bounded.sessionId,
      bounded.branchId,
      (state) => state.status === "stopped",
      { signal: controller.signal },
    );
    controller.abort();
    expect(await cancelled).toMatchObject({ reason: "cancelled" });
    expect(activeSubscriptions).toBe(0);

    const finalRead = await seedSession(storage, {
      sessionId: "terminal-final-read",
      branchId: "main",
    });
    let latestCursorReads = 0;
    const finalReadStorage = new Proxy(storage, {
      get(target, property) {
        if (property === "getLatestCursor") {
          return async (sessionId: string, branchId: string) => {
            latestCursorReads++;
            if (sessionId === finalRead.sessionId && latestCursorReads === 2) {
              await target.appendEvents([{
                sessionId,
                branchId,
                type: "SessionStatusChanged",
                producer: "supervisor",
                idempotencyKey: "terminal-final-read",
                payload: { status: "stopped" },
              }]);
            }
            return target.getLatestCursor(sessionId, branchId);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentStorage;
    expect(await new ProjectionService(finalReadStorage).waitForTerminal(
      finalRead.sessionId,
      finalRead.branchId,
      (state) => state.status === "stopped",
      { timeoutMs: 0 },
    )).toMatchObject({
      reason: "terminal",
      state: { status: "stopped" },
    });
    storage.close();
  });

  test("terminal waiter uses the explicit fallback only without notification capability", async () => {
    const temp = await makeTempRuntime("agencity-terminal-waiter-fallback-");
    temps.push(temp);
    const inner = await openTempStorage(temp);
    const { sessionId, branchId } = await seedSession(inner);
    let notificationAttempted = false;
    const storage = new Proxy(inner, {
      get(target, property) {
        if (property === "capabilities") {
          return { ...target.capabilities, notifications: false };
        }
        if (property === "onCommitted") {
          return () => {
            notificationAttempted = true;
            throw new Error("notification fallback must not subscribe");
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentStorage;
    const waiting = new ProjectionService(storage).waitForTerminal(
      sessionId,
      branchId,
      (state) => state.status === "stopped",
      { timeoutMs: 500, pollingFallbackIntervalMs: 5 },
    );
    await Bun.sleep(10);
    await inner.appendEvents([{
      sessionId,
      branchId,
      type: "SessionStatusChanged",
      producer: "supervisor",
      idempotencyKey: "fallback-terminal",
      payload: { status: "stopped" },
    }]);
    expect(await waiting).toMatchObject({
      reason: "terminal",
      mode: "polling-fallback",
    });
    expect(notificationAttempted).toBe(false);
    storage.close();
  });

  test("advances a current-version snapshot from its cursor without replaying retained history", async () => {
    const temp = await makeTempRuntime("agencity-snapshot-catch-up-");
    temps.push(temp);
    const inner = await openTempStorage(temp);
    const { sessionId, branchId } = await seedSession(inner);
    const first = await appendMessage(inner, sessionId, branchId, "01", "before snapshot");
    const queries: EventQuery[] = [];
    const storage = new Proxy(inner, {
      get(target, property) {
        if (property === "loadEvents") return async (targetSessionId: string, query: EventQuery = {}) => {
          queries.push(query);
          return target.loadEvents(targetSessionId, query);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentStorage;
    const projections = new ProjectionService(storage);
    const initial = await projections.getSnapshot(sessionId, branchId);
    expect(initial.cursor).toBe(first.cursor);

    queries.length = 0;
    const second = await appendMessage(inner, sessionId, branchId, "02", "after snapshot");
    const advanced = await projections.getSnapshot(sessionId, branchId);
    expect(advanced.cursor).toBe(second.cursor);
    expect(advanced.state.messages.map(message => message.content)).toEqual(["before snapshot", "after snapshot"]);
    expect(queries).toEqual([{ branchId, afterCursor: first.cursor }]);
    storage.close();
  });

  test("closes snapshot/catch-up races, ignores duplicate notifications, disconnects, and resumes", async () => {
    const temp = await makeTempRuntime("agencity-subscribe-");
    temps.push(temp);
    const inner = await openTempStorage(temp);
    const { sessionId, branchId } = await seedSession(inner);
    const first = await appendMessage(inner, sessionId, branchId, "01", "in snapshot");
    const storage = new DuplicateNotificationStorage(inner);
    const projections = new ProjectionService(storage);
    const snapshot = await projections.getSnapshot(sessionId, branchId);
    expect(snapshot.cursor).toBe(first.cursor);
    expect(snapshot.state.messages.map((message) => message.content)).toEqual(["in snapshot"]);

    // This commit occurs after the snapshot but before subscribe: it must be pulled.
    const missedNotification = await appendMessage(inner, sessionId, branchId, "02", "catch me up");
    const delivered: AgentEvent[] = [];
    let clientState = snapshot.state;
    const unsubscribe = projections.subscribe(sessionId, branchId, snapshot.cursor, (event) => {
      delivered.push(event);
      clientState = reduceAgentState(clientState, event);
    });
    await waitFor(() => delivered.some((event) => event.id === missedNotification.id), "catch-up event");

    const live = await appendMessage(inner, sessionId, branchId, "03", "live event");
    await waitFor(() => delivered.some((event) => event.id === live.id), "live event");
    expect(delivered.map((event) => event.id)).toEqual([missedNotification.id, live.id]);
    expect(new Set(delivered.map((event) => event.id))).toHaveLength(delivered.length);
    expect(clientState.messages.map((message) => message.content)).toEqual([
      "in snapshot", "catch me up", "live event",
    ]);

    unsubscribe();
    const whileDisconnected = await appendMessage(inner, sessionId, branchId, "04", "during disconnect");
    await Bun.sleep(40);
    expect(delivered.map((event) => event.id)).not.toContain(whileDisconnected.id);

    const resumed: AgentEvent[] = [];
    const stopResumed = projections.subscribe(sessionId, branchId, live.cursor, (event) => resumed.push(event));
    await waitFor(() => resumed.some((event) => event.id === whileDisconnected.id), "resumed event");
    expect(resumed.map((event) => event.id)).toEqual([whileDisconnected.id]);
    stopResumed();
    storage.close();
  });

  test("keeps sessions and branches isolated while pumping notifications", async () => {
    const temp = await makeTempRuntime("agencity-subscribe-isolation-");
    temps.push(temp);
    const storage = await openTempStorage(temp);
    const root = await seedSession(storage, { sessionId: "root", branchId: "main" });
    await seedSession(storage, { sessionId: "other", branchId: "main" });
    const projections = new ProjectionService(storage);
    const received: AgentEvent[] = [];
    const stop = projections.subscribe(root.sessionId, root.branchId, root.created.cursor, (event) => received.push(event));
    await appendMessage(storage, "other", "main", "01", "wrong session");
    await storage.appendEvents([{
      sessionId: "root", branchId: "child", type: "BranchCreated", producer: "client",
      idempotencyKey: "branch:child", payload: {
        branchId: "child", parentBranchId: "main", forkCursor: root.created.cursor,
      },
    }]);
    await appendMessage(storage, "root", "child", "02", "wrong branch");
    await Bun.sleep(40);
    expect(received).toEqual([]);
    const right = await appendMessage(storage, "root", "main", "03", "right stream");
    await waitFor(() => received.length === 1, "isolated event");
    expect(received[0]?.id).toBe(right.id);
    stop();
    storage.close();
  });

  test("async stream catches up and terminates cleanly on abort", async () => {
    const temp = await makeTempRuntime("agencity-async-events-");
    temps.push(temp);
    const storage = await openTempStorage(temp);
    const { sessionId, branchId, created } = await seedSession(storage);
    const queued = await appendMessage(storage, sessionId, branchId, "01", "queued");
    const projection = new ProjectionService(storage);
    const controller = new AbortController();
    const iterator = projection.events(sessionId, branchId, created.cursor, controller.signal);
    expect((await iterator.next()).value?.id).toBe(queued.id);
    const next = iterator.next();
    controller.abort();
    expect(await next).toMatchObject({ done: true });
    storage.close();
  });
});

describe("historical projection is effect-free", () => {
  test("time travel and return to live state never repeat an external effect", async () => {
    const temp = await makeTempRuntime("agencity-time-travel-");
    temps.push(temp);
    const storage = await openTempStorage(temp);
    const { sessionId, branchId } = await seedSession(storage);
    const before = await appendMessage(storage, sessionId, branchId, "01", "before effect");
    const executor = new CountingExecutor();
    const outbox = new OutboxRunner(storage, [executor]);
    const effectId = await outbox.request({
      sessionId,
      branchId,
      executor: "counting",
      operation: "increment",
      input: { amount: 1 },
      origin: { kind: "runtime", requestId: "one-visible-effect" },
      idempotencyKey: "one-visible-effect",
      idempotent: false,
    });
    expect((await outbox.run(effectId)).outcome).toBe("succeeded");
    const after = await appendMessage(storage, sessionId, branchId, "02", "after effect");
    expect(executor.calls).toBe(1);

    const projections = new ProjectionService(storage);
    const historicalA = await projections.atCursor(sessionId, branchId, before.cursor);
    const liveA = (await projections.getSnapshot(sessionId, branchId)).state;
    const historicalB = await projections.atCursor(sessionId, branchId, before.cursor);
    const rebuiltLive = await projections.rebuild(sessionId, branchId);
    const liveB = await projections.atCursor(sessionId, branchId, after.cursor);

    expect(historicalA).toEqual(historicalB);
    expect(historicalA.messages.map((message) => message.content)).toEqual(["before effect"]);
    expect(historicalA.effects[effectId]).toBeUndefined();
    expect(liveA.effects[effectId]?.status).toBe("succeeded");
    expect(liveA.messages.map((message) => message.content)).toEqual(["before effect", "after effect"]);
    expect(rebuiltLive).toEqual(liveA);
    expect(liveB).toEqual(liveA);
    expect(executor.calls).toBe(1);
    storage.close();
  });
});

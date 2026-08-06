import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import {
  ConflictError,
  LibSqlStorage,
  ProjectionService,
  projectEvents,
  reduceAgentState,
  type AgentEvent,
} from "../../src/index.ts";
import {
  appendMessage,
  makeTempRuntime,
  openTempStorage,
  removeTempRuntime,
  seedSession,
  type TempRuntime,
} from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

async function setup(): Promise<{ temp: TempRuntime; storage: LibSqlStorage; sessionId: string; branchId: string }> {
  const temp = await makeTempRuntime("agencity-events-");
  temps.push(temp);
  const storage = await openTempStorage(temp);
  const { sessionId, branchId } = await seedSession(storage);
  return { temp, storage, sessionId, branchId };
}

describe("canonical event storage", () => {
  test("is physically append-only even through a separate administrative connection", async () => {
    const { temp, storage, sessionId } = await setup();
    const message = await appendMessage(storage, sessionId, "main", "01", "immutable");
    const raw = createClient({ url: temp.databaseUrl });
    try {
      await expect(raw.execute({
        sql: "UPDATE events SET payload_json=? WHERE id=?",
        args: [JSON.stringify({ content: "tampered" }), message.id],
      })).rejects.toThrow(/append-only/i);
      await expect(raw.execute({ sql: "DELETE FROM events WHERE id=?", args: [message.id] }))
        .rejects.toThrow(/append-only/i);
      const retained = await storage.getEvent(message.id);
      expect(retained?.payload).toEqual(message.payload);
      expect((await storage.loadEvents(sessionId)).map((event) => event.id)).toContain(message.id);
    } finally {
      raw.close();
      storage.close();
    }
  });

  test("deduplicates exact idempotent appends and rejects key reuse with any changed durable meaning", async () => {
    const { storage, sessionId, branchId } = await setup();
    const candidate = {
      id: "fixed-message-event",
      sessionId,
      branchId,
      type: "MessageAppended" as const,
      producer: "client",
      idempotencyKey: "fixed-key",
      committedAt: "2026-01-01T01:00:00.000Z",
      payload: { messageId: "fixed-message", role: "user" as const, content: "same" },
    };
    const [first] = await storage.appendEvents([candidate]);
    const [duplicate] = await storage.appendEvents([{ ...candidate, id: "ignored-on-dedup" }]);
    expect(duplicate).toEqual(first);
    expect((await storage.loadEvents(sessionId)).filter((event) => event.idempotencyKey === "fixed-key"))
      .toHaveLength(1);

    await expect(storage.appendEvents([{
      ...candidate,
      id: "changed-payload",
      payload: { ...candidate.payload, content: "different" },
    }])).rejects.toBeInstanceOf(ConflictError);
    await expect(storage.appendEvents([{
      ...candidate,
      id: "changed-branch",
      branchId: "another-branch",
    }])).rejects.toBeInstanceOf(ConflictError);
    expect((await storage.loadEvents(sessionId)).filter((event) => event.idempotencyKey === "fixed-key"))
      .toHaveLength(1);
    storage.close();
  });

  test("rolls back the entire append batch when an operational projection write fails", async () => {
    const { storage, sessionId } = await setup();
    const before = await storage.loadEvents(sessionId);
    const branch = {
      sessionId,
      branchId: "duplicate-child",
      type: "BranchCreated" as const,
      producer: "client",
      payload: { branchId: "duplicate-child", parentBranchId: "main", forkCursor: before[0]!.cursor },
    };
    await expect(storage.appendEvents([
      { ...branch, id: "branch-event-a", idempotencyKey: "branch-a" },
      { ...branch, id: "branch-event-b", idempotencyKey: "branch-b" },
    ])).rejects.toThrow();
    expect(await storage.loadEvents(sessionId)).toEqual(before);
    expect(await storage.listBranches()).toEqual([{ sessionId, branchId: "main" }]);
    storage.close();
  });

  test("loads branch lineage only through the exact fork cursor", async () => {
    const { storage, sessionId, branchId } = await setup();
    const beforeFork = await appendMessage(storage, sessionId, branchId, "01", "shared");
    const [fork] = await storage.appendEvents([{
      id: "fork-event",
      sessionId,
      branchId: "child",
      type: "BranchCreated",
      producer: "client",
      idempotencyKey: "branch:child",
      payload: {
        branchId: "child",
        parentBranchId: branchId,
        forkCursor: beforeFork.cursor,
        name: "experiment",
      },
    }]);
    expect(fork).toBeDefined();
    const parentLate = await appendMessage(storage, sessionId, branchId, "02", "parent-only");
    const childOnly = await appendMessage(storage, sessionId, "child", "03", "child-only");

    const child = await storage.loadEvents(sessionId, { branchId: "child" });
    expect(child.map((event) => event.id)).toEqual([
      `${sessionId}-created`, beforeFork.id, fork!.id, childOnly.id,
    ]);
    expect(child.map((event) => event.id)).not.toContain(parentLate.id);
    expect((await storage.loadEvents(sessionId, { branchId })).map((event) => event.id))
      .toEqual([`${sessionId}-created`, beforeFork.id, parentLate.id]);
    expect((await storage.loadEvents(sessionId, {
      branchId: "child",
      untilCursor: fork!.cursor,
    })).at(-1)?.id).toBe(fork!.id);
    storage.close();
  });


  test("clamps every ancestor to the earliest descendant fork cursor", async () => {
    const { storage, sessionId, branchId } = await setup();
    const early = await appendMessage(storage, sessionId, branchId, "01", "ancestor-visible");
    const tooNew = await appendMessage(storage, sessionId, branchId, "02", "ancestor-too-new");
    await storage.appendEvents([{
      id: "child-branch-event",
      sessionId,
      branchId: "child",
      type: "BranchCreated",
      producer: "client",
      idempotencyKey: "branch:child-nested",
      payload: { branchId: "child", parentBranchId: branchId, forkCursor: tooNew.cursor },
    }]);
    const childOnly = await appendMessage(storage, sessionId, "child", "03", "child-too-new");
    const [grandchild] = await storage.appendEvents([{
      id: "grandchild-branch-event",
      sessionId,
      branchId: "grandchild",
      type: "BranchCreated",
      producer: "client",
      idempotencyKey: "branch:grandchild",
      payload: { branchId: "grandchild", parentBranchId: "child", forkCursor: early.cursor },
    }]);

    const history = await storage.loadEvents(sessionId, { branchId: "grandchild" });
    expect(history.map((event) => event.id)).toEqual([
      `${sessionId}-created`, early.id, grandchild!.id,
    ]);
    expect(history.map((event) => event.id)).not.toContain(tooNew.id);
    expect(history.map((event) => event.id)).not.toContain(childOnly.id);
    expect(projectEvents(history).messages.map((message) => message.content)).toEqual(["ancestor-visible"]);
    storage.close();
  });

  test("rejects missing targets and invalid transitions before canonical commit", async () => {
    const { storage, sessionId, branchId } = await setup();
    await expect(storage.appendEvents([{
      sessionId: "missing-session", branchId: "main", type: "MessageAppended", producer: "client",
      payload: { messageId: "missing", role: "user", content: "must not commit" },
    }])).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(storage.appendEvents([{
      sessionId, branchId: "missing-branch", type: "MessageAppended", producer: "client",
      payload: { messageId: "missing-branch", role: "user", content: "must not commit" },
    }])).rejects.toMatchObject({ code: "NOT_FOUND" });

    const before = await storage.loadEvents(sessionId);
    await expect(storage.appendEvents([{
      sessionId, branchId, type: "CellProposed", producer: "console",
      idempotencyKey: "poison-proposed", payload: { cellId: "poison", code: "return 1", dependencies: [] },
    }, {
      sessionId, branchId, type: "CellCommitted", producer: "console",
      idempotencyKey: "poison-commit", payload: {
        cellId: "poison", result: 1, logs: [], durationMs: 1, exports: [],
      },
    }])).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(await storage.loadEvents(sessionId)).toEqual(before);
    storage.close();
  });

  test("rebuilds deterministically from events and ignores disposable snapshot corruption", async () => {
    const { storage, sessionId, branchId } = await setup();
    await appendMessage(storage, sessionId, branchId, "01", "hello");
    const projection = new ProjectionService(storage);
    const initial = await projection.getSnapshot(sessionId, branchId);
    await storage.saveSnapshot({
      ...initial.state,
      status: "archived",
      messages: [],
    });
    // A current-cursor cache is allowed to be wrong operationally, but rebuild must
    // always discard it and use the canonical stream.
    const rebuilt = await projection.rebuild(sessionId, branchId);
    const replayed = projectEvents(await storage.loadEvents(sessionId, { branchId }));
    expect(rebuilt).toEqual(replayed);
    expect(rebuilt.status).toBe("idle");
    expect(rebuilt.messages.map((message) => message.content)).toEqual(["hello"]);

    storage.close();
    const reopened = new LibSqlStorage((await Promise.resolve(temps.at(-1)!)).databaseUrl);
    await reopened.migrate();
    expect(await new ProjectionService(reopened).rebuild(sessionId, branchId)).toEqual(rebuilt);
    reopened.close();
  });

  test("applying a duplicate event is a true no-op, including cursor and arrays", async () => {
    const { storage, sessionId, branchId } = await setup();
    const event = await appendMessage(storage, sessionId, branchId, "01", "once");
    const events = await storage.loadEvents(sessionId, { branchId });
    const state = projectEvents(events);
    const duplicated = reduceAgentState(state, event as AgentEvent);
    expect(duplicated).toBe(state);
    expect(duplicated.messages).toHaveLength(1);
    expect(duplicated.appliedEventIds.filter((id) => id === event.id)).toHaveLength(1);
    storage.close();
  });
});

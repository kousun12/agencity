import { afterEach, describe, expect, test } from "bun:test";
import { projectEvents } from "../../src/index.ts";
import { IncrementalBranchHistory } from "../../src/runtime/branch-history.ts";
import {
  makeTempRuntime,
  removeTempRuntime,
  type TempRuntime,
} from "../helpers.ts";
import { Supervisor } from "../../src/runtime/supervisor.ts";

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

describe("incremental branch history", () => {
  test("advances from the cached cursor and remains equivalent to full replay", async () => {
    const temp = await makeTempRuntime("agencity-branch-history-");
    temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    try {
      const session = await supervisor.createSession({
        workspaceId: "branch-history",
        model: { provider: "echo", model: "echo-v1" },
      });
      const history = new IncrementalBranchHistory(supervisor.storage);
      const first = await history.load(session.sessionId, session.branchId);
      expect(first.newEvents.length).toBe(first.events.length);

      for (let index = 0; index < 64; index++) {
        await supervisor.appendMessage(
          session.sessionId,
          session.branchId,
          "user",
          `message-${index}`,
        );
      }
      const second = await history.load(session.sessionId, session.branchId);
      expect(second.newEvents).toHaveLength(64);
      const full = await supervisor.storage.loadEvents(session.sessionId, {
        branchId: session.branchId,
      });
      expect(second.state).toEqual(projectEvents(full));

      const calls: Record<string, unknown>[] = [];
      const original = supervisor.storage.loadEvents.bind(supervisor.storage);
      (supervisor.storage as any).loadEvents = async (
        sessionId: string,
        options: Record<string, unknown>,
      ) => {
        calls.push(options);
        return original(sessionId, options as any);
      };
      await supervisor.appendMessage(
        session.sessionId,
        session.branchId,
        "user",
        "incremental-only",
      );
      const third = await history.load(session.sessionId, session.branchId);
      expect(third.newEvents).toHaveLength(1);
      expect(calls.some((options) =>
        typeof options.afterCursor === "string"
      )).toBe(true);
      expect(third.state).toEqual(projectEvents(await original(
        session.sessionId,
        { branchId: session.branchId },
      )));

      await supervisor.appendMessage(
        session.sessionId,
        session.branchId,
        "user",
        "concurrent-refresh",
      );
      const concurrent = await Promise.all([
        history.load(session.sessionId, session.branchId),
        history.load(session.sessionId, session.branchId),
      ]);
      const expected = projectEvents(await original(session.sessionId, {
        branchId: session.branchId,
      }));
      expect(concurrent[0]!.state).toEqual(expected);
      expect(concurrent[1]!.state).toEqual(expected);
    } finally {
      await supervisor.close();
    }
  });
});

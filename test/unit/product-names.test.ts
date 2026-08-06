import { afterEach, describe, expect, test } from "bun:test";
import { projectEvents } from "../../src/domain/index.ts";
import { makeTempRuntime, openTempStorage, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

describe("durable product display names", () => {
  test("validates, projects, persists, and rebuilds session and branch naming events", async () => {
    const temp = await makeTempRuntime("agencity-product-names-"); temps.push(temp);
    const storage = await openTempStorage(temp);
    const [created] = await storage.appendEvents([{
      sessionId: "named-session", branchId: "main", type: "SessionCreated", producer: "supervisor",
      idempotencyKey: "session:named-session",
      payload: {
        workspaceId: "workspace", initialBranchId: "main",
        model: { provider: "echo", model: "echo-1" }, budget: {},
        sessionName: "Initial task", initialBranchName: "main",
      },
    }]);
    expect(created).toBeDefined();
    await storage.appendEvents([
      { sessionId: "named-session", branchId: "main", type: "SessionNamed", producer: "client", idempotencyKey: "session-name:1", payload: { name: "Renamed session" } },
      { sessionId: "named-session", branchId: "main", type: "BranchNamed", producer: "client", idempotencyKey: "branch-name:1", payload: { name: "verified-main" } },
    ]);
    const state = projectEvents(await storage.loadEvents("named-session", { branchId: "main" }));
    expect(state.sessionName).toBe("Renamed session");
    expect(state.branch.name).toBe("verified-main");
    expect(await storage.readonlyQuery({ sql: "SELECT name FROM branches WHERE session_id=? AND branch_id=?", args: ["named-session", "main"] })).toEqual([{ name: "verified-main" }]);
    await storage.rebuildOperationalProjections?.();
    expect(await storage.readonlyQuery({ sql: "SELECT name FROM branches WHERE session_id=? AND branch_id=?", args: ["named-session", "main"] })).toEqual([{ name: "verified-main" }]);
    storage.close();
  });
});

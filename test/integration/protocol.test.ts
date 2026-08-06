import { afterEach, describe, expect, test } from "bun:test";
import { InvalidTransitionError, ProtocolServer, Supervisor } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

describe("HTTP domain error mapping", () => {
  test("maps missing domain targets to 404 and validation failures to 400", async () => {
    const temp = await makeTempRuntime("agencity-protocol-");
    temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    const session = await supervisor.createSession({ workspaceId: "protocol" });
    const protocol = new ProtocolServer(supervisor);
    const server = protocol.listen(0);
    const base = `http://${server.hostname}:${server.port}`;
    try {
      const missing = await fetch(`${base}/sessions/missing/messages?branch=missing`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "no target" }),
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        error: { code: "NOT_FOUND", message: "session not found: missing" },
      });

      const invalid = await fetch(
        `${base}/sessions/${session.sessionId}/branches?branch=${session.branchId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cursor: "999999" }),
        },
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

      const route = await fetch(`${base}/does-not-exist`);
      expect(route.status).toBe(404);
      expect(await route.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    } finally {
      protocol.stop();
      await supervisor.close();
    }
  });

  test("maps typed transition conflicts to 409", async () => {
    const supervisor = {
      appendMessage: async () => {
        throw new InvalidTransitionError("cell", "committed", "running");
      },
    } as unknown as Supervisor;
    const protocol = new ProtocolServer(supervisor);
    const server = protocol.listen(0);
    try {
      const response = await fetch(`http://${server.hostname}:${server.port}/sessions/s/messages?branch=b`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "test" }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_TRANSITION" } });
    } finally {
      protocol.stop();
    }
  });

});

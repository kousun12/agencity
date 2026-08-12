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
        error: { code: "NOT_FOUND", message: "session not found: missing", details: { kind: "session", id: "missing" } },
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

  test("rejects malformed public admission scalars and batches as validation errors", async () => {
    const temp = await makeTempRuntime("agencity-protocol-admission-validation-");
    temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    const session = await supervisor.createSession({ workspaceId: "protocol-admission-validation" });
    const protocol = new ProtocolServer(supervisor);
    const server = protocol.listen(0);
    const base = `http://${server.hostname}:${server.port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    try {
      const responses = await Promise.all([
        post(`/sessions/${session.sessionId}/ai/generations?branch=${session.branchId}`, {
          kind: "text",
          prompt: "invalid numeric generation key",
          idempotencyKey: 42,
        }),
        post(`/sessions/${session.sessionId}/agent-invocations?branch=${session.branchId}`, {
          task: "invalid numeric invocation key",
          idempotencyKey: 42,
        }),
        post(`/sessions/${session.sessionId}/agent-invocations/batch?branch=${session.branchId}`, {
          inputs: "not-an-array",
        }),
        post(`/sessions/${session.sessionId}/agents/batch?branch=${session.branchId}`, []),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { code: "VALIDATION_ERROR" },
        });
      }
      expect(await supervisor.agents.listTasks(session.sessionId)).toHaveLength(0);
      const events = await supervisor.storage.loadEvents(
        session.sessionId,
        { branchId: session.branchId },
      );
      expect(events.some(event =>
        event.type === "AiGenerationRequested" ||
        event.type === "EffectRequested")).toBe(false);
    } finally {
      protocol.stop();
      await supervisor.close();
    }
  });

  test("scrubs known credentials from protocol error responses", async () => {
    const prior = process.env.REVIEW_API_KEY;
    process.env.REVIEW_API_KEY = "protocol-secret-value";
    const supervisor = {
      appendMessage: async () => {
        throw new Error(`provider returned ${process.env.REVIEW_API_KEY}`);
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
      const body = await response.text();
      expect(response.status).toBe(500);
      expect(body).toContain("[REDACTED]");
      expect(body).not.toContain("protocol-secret-value");
    } finally {
      protocol.stop();
      if (prior === undefined) delete process.env.REVIEW_API_KEY;
      else process.env.REVIEW_API_KEY = prior;
    }
  });

});

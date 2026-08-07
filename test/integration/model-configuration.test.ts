import { afterEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Supervisor, projectEvents } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

describe("durable model configuration", () => {
  test("persists provider auth separately and records explicit branch model changes", async () => {
    const temp = await makeTempRuntime("agencity-model-configuration-");
    temps.push(temp);
    const authPath = join(temp.directory, "auth.json");
    const secret = "openai-provider-secret-123456";
    let supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelCredentialPath: authPath,
      recover: false,
    });
    try {
      expect(supervisor.modelProviders.find(provider => provider.name === "openai")).toMatchObject({
        usable: false,
        credentialSource: "missing",
      });
      await supervisor.credentials.set("openai", secret);
      expect(supervisor.modelProviders.find(provider => provider.name === "openai")).toMatchObject({
        usable: true,
        credentialSource: "stored",
      });
      expect((await stat(authPath)).mode & 0o077).toBe(0);

      const session = await supervisor.createSession({
        workspaceId: "models",
        model: { provider: "echo", model: "echo-1" },
      });
      const selected = await supervisor.selectModel(session.sessionId, session.branchId, {
        provider: "openai",
        model: "gpt-5.6-sol",
      });
      expect(selected.changed).toBe(true);
      const events = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      expect(events.filter(event => event.type === "SessionModelChanged")).toHaveLength(1);
      expect(projectEvents(events).model).toEqual({ provider: "openai", model: "gpt-5.6-sol" });
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(await Bun.file(temp.databaseUrl.slice("file:".length)).text()).not.toContain(secret);
    } finally { await supervisor.close(); }

    supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelCredentialPath: authPath,
      recover: false,
    });
    try {
      expect(supervisor.modelProviders.find(provider => provider.name === "openai")).toMatchObject({
        usable: true,
        credentialSource: "stored",
      });
    } finally { await supervisor.close(); }
  });

  test("refuses unavailable providers and model changes during active work", async () => {
    const temp = await makeTempRuntime("agencity-model-configuration-active-");
    temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelCredentialPath: join(temp.directory, "auth.json"),
      recover: false,
    });
    try {
      const session = await supervisor.createSession({ workspaceId: "models" });
      await expect(supervisor.selectModel(session.sessionId, session.branchId, {
        provider: "anthropic",
        model: "fable-5",
      })).rejects.toThrow("/model login anthropic");

      await supervisor.credentials.set("anthropic", "anthropic-provider-secret-123456");
      await supervisor.runs.admit(session.sessionId, session.branchId, { task: "queued work", goalMode: "none" });
      await expect(supervisor.selectModel(session.sessionId, session.branchId, {
        provider: "anthropic",
        model: "fable-5",
      })).rejects.toThrow("model work is active");
    } finally { await supervisor.close(); }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  EchoModelProvider,
  ModelExecutor,
  Supervisor,
  createAnthropicModelProvider,
  createOpenAIModelProvider,
  createVercelModelProvider,
  projectEvents,
} from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

describe("durable model configuration", () => {
  test("applies canonical grammar only to configured product transports", () => {
    const executor = new ModelExecutor([
      new EchoModelProvider(),
      createOpenAIModelProvider({
        origin: "https://api.openai.test",
        apiKey: () => "unused",
      }),
      createAnthropicModelProvider({
        origin: "https://api.anthropic.test",
        apiKey: () => "unused",
      }),
      createVercelModelProvider({
        origin: "https://gateway.test",
        apiKey: () => "unused",
      }),
      {
        name: "custom",
        normalizeModel: model => `custom:${model}`,
        async complete() {
          return {
            text: "ok",
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          };
        },
      },
    ]);

    expect(executor.normalizeConfigurationIdentity({
      provider: "echo",
      model: "echo model without slash",
    }).model).toBe("echo model without slash");
    expect(executor.normalizeConfigurationIdentity({
      provider: "custom",
      model: "provider-specific identity",
    }).model).toBe("custom:provider-specific identity");
    expect(executor.normalizeConfigurationIdentity({
      provider: "vercel",
      model: "meta/private/model",
    }).model).toBe("meta/private/model");
    expect(() => executor.normalizeConfigurationIdentity({
      provider: "openai",
      model: "anthropic/claude",
    })).toThrow("Direct OpenAI");
    expect(() => executor.normalizeConfigurationIdentity({
      provider: "anthropic",
      model: "anthropic/claude\u202e",
    })).toThrow("bounded canonical");
    expect(() => executor.normalizeConfigurationIdentity({
      provider: "vercel",
      model: `a/${"x".repeat(511)}`,
    })).toThrow("bounded canonical");
  });

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
        model: "openai/gpt-5.6-sol",
      });
      expect(selected.changed).toBe(true);
      const events = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      expect(events.filter(event => event.type === "SessionModelChanged")).toHaveLength(1);
      expect(projectEvents(events).model).toEqual({ provider: "openai", model: "openai/gpt-5.6-sol", reasoningEffort: "provider-default" });
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
        model: "anthropic/claude.fable.5",
      })).rejects.toThrow("/model login anthropic");

      await supervisor.credentials.set("anthropic", "anthropic-provider-secret-123456");
      await supervisor.runs.admit(session.sessionId, session.branchId, { task: "queued work", goalMode: "none" });
      await expect(supervisor.selectModel(session.sessionId, session.branchId, {
        provider: "anthropic",
        model: "anthropic/claude.fable.5",
      })).rejects.toThrow("model work is active");
    } finally { await supervisor.close(); }
  });
});

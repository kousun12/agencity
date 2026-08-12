import { describe, expect, test } from "bun:test";
import {
  DELEGATED_MODEL_ALLOWLIST_PREFERENCE,
  ModelExecutor,
  ModelSelectionService,
  canonicalModelId,
  validateDelegatedModelAllowlist,
  type JsonValue,
  type ModelConfiguration,
  type ModelProvider,
  type ProfilePreference,
} from "../../src/index.ts";

class MemoryPreferences {
  readonly values = new Map<string, ProfilePreference>();

  async getPreference(key: string): Promise<ProfilePreference | null> {
    return this.values.get(key) ?? null;
  }

  async setPreference(
    key: string,
    value: JsonValue,
  ): Promise<ProfilePreference> {
    const retained = {
      key,
      value,
      updatedAt: "2026-08-11T00:00:00.000Z",
    };
    this.values.set(key, retained);
    return retained;
  }
}

const caller: ModelConfiguration = {
  provider: "gateway",
  model: "openai/original",
  reasoningEffort: "high",
  temperature: 0.25,
  maxOutputTokens: 2_048,
};

describe("shared model selection and delegated-model policy", () => {
  test("inherits omission exactly and keeps strings on the caller route", async () => {
    const service = createService().service;
    expect(await service.admit(caller)).toEqual(caller);
    const selected = await service.admit(caller, "anthropic/claude-test")
      .catch((error) => error);
    expect(selected).toMatchObject({
      message: expect.stringContaining("owner-managed"),
    });

    await service.setAllowlist([{
      provider: "gateway",
      model: "anthropic/claude-test",
    }]);
    expect(await service.admit(caller, "anthropic/claude-test")).toEqual({
      provider: "gateway",
      model: "anthropic/claude-test",
      reasoningEffort: "high",
      temperature: 0.25,
      maxOutputTokens: 2_048,
    });
  });

  test("preserves explicit configuration controls and admits exact allowlist identities", async () => {
    const { service } = createService();
    await service.setAllowlist([
      { provider: "direct", model: "openai/alternate" },
    ]);
    const selected = await service.admit(caller, {
      provider: "direct",
      model: "openai/alternate",
      reasoningEffort: "low",
      temperature: 0.8,
      maxOutputTokens: 512,
    });
    expect(selected).toEqual({
      provider: "direct",
      model: "openai/alternate",
      reasoningEffort: "low",
      temperature: 0.8,
      maxOutputTokens: 512,
    });
    expect(await service.getAllowlist()).toEqual({
      version: 1,
      models: [{ provider: "direct", model: "openai/alternate" }],
    });
  });

  test("rejects unknown routes, reserved dispatch fields, and malformed IDs", async () => {
    const { service } = createService();
    await service.setAllowlist([
      { provider: "missing", model: "openai/alternate" },
      { provider: "gateway", model: "openai/alternate" },
    ]);
    await expect(service.admit(caller, {
      provider: "missing",
      model: "openai/alternate",
    })).rejects.toThrow("Unknown model provider");
    await expect(service.admit(caller, {
      provider: "gateway",
      model: "openai/alternate",
      responseContract: {},
    } as any)).rejects.toThrow("reserved dispatch field responseContract");
    await expect(service.admit(caller, {
      provider: "gateway",
      model: "openai/alternate",
      contractDigest: "sha256:caller-controlled",
    } as any)).rejects.toThrow("unknown or reserved field");
    expect(() => service.normalizeIdentity(caller, {
      provider: "gateway",
      model: "openai/alternate",
      capability: { status: "provider-strict" },
    } as any)).toThrow("unknown or reserved field");
    expect(() => canonicalModelId("not-canonical")).toThrow("creator/model");
    expect(() => canonicalModelId("creator/model/extra"))
      .toThrow("creator/model");
  });

  test("normalizes idempotent identity checks without consulting changed policy", async () => {
    const { service, preferences } = createService();
    const identity = service.normalizeIdentity(caller, {
      provider: "direct",
      model: "openai/alternate",
      reasoningEffort: "medium",
    });
    expect(identity).toMatchObject({
      provider: "direct",
      model: "openai/alternate",
      reasoningEffort: "medium",
    });
    expect(preferences.values.size).toBe(0);
  });

  test("validates versioned bounded owner preferences", () => {
    expect(validateDelegatedModelAllowlist({
      version: 1,
      models: [{ provider: "GATEWAY", model: "openai/model" }],
    })).toEqual({
      version: 1,
      models: [{ provider: "gateway", model: "openai/model" }],
    });
    expect(() => validateDelegatedModelAllowlist({
      version: 2,
      models: [],
    })).toThrow("unsupported version");
    expect(() => validateDelegatedModelAllowlist({
      version: 1,
      models: [
        { provider: "gateway", model: "openai/model" },
        { provider: "gateway", model: "openai/model" },
      ],
    })).toThrow("duplicates");
  });

  test("persists only the dedicated owner preference", async () => {
    const { service, preferences } = createService();
    await service.setAllowlist([
      { provider: "gateway", model: "openai/allowed" },
    ]);
    expect([...preferences.values.keys()])
      .toEqual([DELEGATED_MODEL_ALLOWLIST_PREFERENCE]);
  });
});

function createService(): {
  service: ModelSelectionService;
  preferences: MemoryPreferences;
} {
  const preferences = new MemoryPreferences();
  const executor = new ModelExecutor([
    provider("gateway"),
    provider("direct"),
  ]);
  return {
    service: new ModelSelectionService(executor, preferences),
    preferences,
  };
}

function provider(name: string): ModelProvider {
  return {
    name,
    capabilities: {
      streaming: false,
      reasoningControl: "normalized",
    },
    complete: async () => ({
      text: "unused",
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    }),
  };
}

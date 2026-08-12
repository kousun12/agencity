import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../../src/cli-args.ts";
import {
  chooseManagedModel,
  normalizeSelectedManagedModel,
} from "../../src/product/managed-model-selection.ts";
import type { ModelProviderDescriptor } from "../../src/executors/index.ts";

function provider(
  name: string,
  displayName: string,
): ModelProviderDescriptor {
  return {
    name,
    displayName,
    usable: true,
    credentialSource: "programmatic",
    capabilities: {
      streaming: true,
      requiredToolSet: {
        status: "unknown",
        requiredChoice: "provider-enforced",
        parallelCalls: "runtime-rejected",
        streaming: true,
        adapter: "fake",
      },
    },
  };
}

function capability(
  providerName: string,
  model: string,
  admission: "allowed" | "rejected",
  state: "unknown" | "unavailable" = admission === "allowed"
    ? "unknown"
    : "unavailable",
) {
  return {
    selected: {
      provider: providerName,
      model,
      admission,
      state,
      canRun: admission === "allowed",
      ...(admission === "rejected"
        ? { reason: "Fake capability truthfully rejects required tools" }
        : {}),
    },
  };
}

async function withoutModelEnvironment<T>(
  names: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const retained = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    return await operation();
  } finally {
    for (const [name, value] of retained) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("managed model selection orchestration", () => {
  test("applies canonical validation only to product transports", () => {
    expect(normalizeSelectedManagedModel({
      provider: "custom",
      model: "provider-specific::model",
      reasoningEffort: "provider-default",
    })).toEqual({
      provider: "custom",
      model: "provider-specific::model",
      reasoningEffort: "provider-default",
    });
    expect(() => normalizeSelectedManagedModel({
      provider: "openai",
      model: "provider-specific::model",
      reasoningEffort: "provider-default",
    })).toThrow("canonical creator/model");
  });

  test("warns and replaces a retained known-unsupported default interactively", async () => {
    const writes: string[] = [];
    const selectedModels: string[] = [];
    let modelPickerCalls = 0;
    let catalogCalls = 0;
    const client = {
      modelProviders: async () => [provider("openai", "OpenAI")],
      productConfig: async () => ({
        defaultModel: "openai:openai/unsupported",
        selectedModelEffortPreference: null,
      }),
      modelCatalog: async () => {
        catalogCalls += 1;
        return { status: "refreshed" as const, descriptors: [] };
      },
      agentToolCapability: async (model: { provider: string; model: string }) =>
        capability(
          model.provider,
          model.model,
          model.model === "openai/unsupported" ? "rejected" : "allowed",
        ),
      productSetModel: async (model: string) => {
        selectedModels.push(model);
        return { defaultModel: model };
      },
      productSetProviderKey: async () => ({}),
    };
    const prompter = {
      secret: async () => "",
      selectProvider: async () => provider("openai", "OpenAI"),
      selectModel: async () => {
        modelPickerCalls += 1;
        return "openai/replacement";
      },
      selectCustomModel: async () => {
        throw new Error("custom picker should not run");
      },
    };
    const originalWrite = process.stderr.write;
    process.stderr.write = ((value: string | Uint8Array) => {
      writes.push(String(value));
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = await withoutModelEnvironment(
        ["OPENAI_MODEL"],
        () => chooseManagedModel(
          client as any,
          parseCliArgs(["new"]),
          true,
          prompter as any,
        ),
      );
      expect(result).toMatchObject({
        provider: "openai",
        model: "openai/replacement",
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(writes.join("")).toContain(
      "Stored workspace model preference cannot run",
    );
    expect(writes.join("")).toContain("remains available for diagnostics");
    expect(modelPickerCalls).toBe(1);
    expect(catalogCalls).toBe(1);
    expect(selectedModels).toEqual(["openai:openai/replacement"]);
  });

  test("fails a retained known-unsupported default noninteractively without writing", async () => {
    const selectedModels: string[] = [];
    const client = {
      modelProviders: async () => [provider("openai", "OpenAI")],
      productConfig: async () => ({
        defaultModel: "openai:openai/unsupported",
        selectedModelEffortPreference: null,
      }),
      modelCatalog: async () => ({
        status: "refreshed" as const,
        descriptors: [],
      }),
      agentToolCapability: async (model: { provider: string; model: string }) =>
        capability(model.provider, model.model, "rejected"),
      productSetModel: async (model: string) => {
        selectedModels.push(model);
        return { defaultModel: model };
      },
      productSetProviderKey: async () => ({}),
    };
    await expect(withoutModelEnvironment(
      ["OPENAI_MODEL"],
      () => chooseManagedModel(
        client as any,
        parseCliArgs(["new"]),
        false,
        {} as any,
      ),
    )).rejects.toThrow("Configure a supported model with --model");
    expect(selectedModels).toEqual([]);
  });

  test("admits an unknown retained default and does not rewrite it", async () => {
    let writes = 0;
    const client = {
      modelProviders: async () => [provider("openai", "OpenAI")],
      productConfig: async () => ({
        defaultModel: "openai:openai/private-preview",
        selectedModelEffortPreference: null,
      }),
      modelCatalog: async () => ({
        status: "unavailable" as const,
        descriptors: [],
      }),
      agentToolCapability: async (model: { provider: string; model: string }) =>
        capability(model.provider, model.model, "allowed", "unknown"),
      productSetModel: async () => {
        writes += 1;
        return {};
      },
      productSetProviderKey: async () => ({}),
    };
    const result = await withoutModelEnvironment(
      ["OPENAI_MODEL"],
      () => chooseManagedModel(
        client as any,
        parseCliArgs(["new"]),
        false,
        {} as any,
      ),
    );
    expect(result.model).toBe("openai/private-preview");
    expect(writes).toBe(0);
  });

  test("manual model fallback survives a rejected catalog request", async () => {
    const writes: string[] = [];
    const openai = provider("openai", "OpenAI");
    const client = {
      modelProviders: async () => [openai],
      productConfig: async () => ({
        defaultModel: null,
        selectedModelEffortPreference: null,
      }),
      modelCatalog: async () => {
        throw new Error("fixture catalog transport rejected");
      },
      agentToolCapability: async (model: { provider: string; model: string }) =>
        capability(model.provider, model.model, "allowed"),
      productSetModel: async (model: string) => {
        writes.push(model);
        return { defaultModel: model };
      },
      productSetProviderKey: async () => ({}),
    };
    const prompter = {
      secret: async () => "",
      selectProvider: async () => openai,
      selectModel: async (
        _provider: ModelProviderDescriptor,
        catalog: Promise<unknown>,
      ) => {
        await expect(catalog).rejects.toThrow("transport rejected");
        return "openai/private-preview";
      },
      selectCustomModel: async () => {
        throw new Error("custom picker should not run");
      },
    };
    const result = await withoutModelEnvironment(
      ["OPENAI_MODEL"],
      () => chooseManagedModel(
        client as any,
        parseCliArgs(["new"]),
        true,
        prompter as any,
      ),
    );
    expect(result.model).toBe("openai/private-preview");
    expect(writes).toEqual(["openai:openai/private-preview"]);
  });

  test("uses bounded provider-specific input and server normalization for custom providers", async () => {
    let catalogCalls = 0;
    let productPickerCalls = 0;
    let customPickerCalls = 0;
    let capabilityCalls = 0;
    const writes: string[] = [];
    const custom = provider("custom", "Embedded Custom");
    const client = {
      modelProviders: async () => [custom],
      productConfig: async () => ({
        defaultModel: null,
        selectedModelEffortPreference: null,
      }),
      modelCatalog: async () => {
        catalogCalls += 1;
        return { status: "refreshed" as const, descriptors: [] };
      },
      agentToolCapability: async (model: { provider: string; model: string }) => {
        capabilityCalls += 1;
        return capability(model.provider, model.model, "rejected");
      },
      productSetModel: async (model: string) => {
        writes.push(model);
        return {
          defaultModel: "custom:normalized-provider-specific::model",
        };
      },
      productSetProviderKey: async () => ({}),
    };
    const prompter = {
      secret: async () => "",
      selectProvider: async () => custom,
      selectModel: async () => {
        productPickerCalls += 1;
        return "wrong";
      },
      selectCustomModel: async () => {
        customPickerCalls += 1;
        return "provider-specific::model";
      },
    };
    const result = await withoutModelEnvironment(
      ["CUSTOM_MODEL"],
      () => chooseManagedModel(
        client as any,
        parseCliArgs(["new"]),
        true,
        prompter as any,
      ),
    );
    expect(result.model).toBe("normalized-provider-specific::model");
    expect(writes).toEqual(["custom:provider-specific::model"]);
    expect(customPickerCalls).toBe(1);
    expect(productPickerCalls).toBe(0);
    expect(catalogCalls).toBe(0);
    expect(capabilityCalls).toBe(0);
  });
});

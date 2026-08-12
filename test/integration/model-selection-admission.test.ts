import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  projectEvents,
  validateCanonicalProductModelId,
  type JsonValue,
  type ModelConfiguration,
} from "../../src/domain/index.ts";
import type {
  ModelProvider,
  ModelProviderCapabilities,
  TextModelResponse,
} from "../../src/executors/model.ts";
import {
  ManagedWorkspaceService,
  connectManagedService,
  type ManagedServiceConfiguration,
} from "../../src/product/service.ts";
import { resolveWorkspace, workspacePreferenceKey } from "../../src/product/workspace.ts";
import { AgentClient, type ProtocolTransport } from "../../src/protocol/index.ts";
import { Supervisor } from "../../src/runtime/supervisor.ts";
import {
  makeTempRuntime,
  removeTempRuntime,
  type TempRuntime,
} from "../helpers.ts";

const temps: TempRuntime[] = [];
const services: ManagedWorkspaceService[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

class FixtureProvider implements ModelProvider {
  readonly displayName: string;
  readonly productTransport: boolean;
  capabilities: ModelProviderCapabilities;
  enforceCanonicalIdentity = false;

  constructor(
    readonly name: string,
    options: {
      readonly productTransport?: boolean;
      readonly admission?: "unknown" | "unsupported";
    } = {},
  ) {
    this.displayName = `Fixture ${name}`;
    this.productTransport = options.productTransport === true;
    this.capabilities = options.admission === undefined
      ? { streaming: false }
      : {
          streaming: false,
          reasoningControl: "normalized",
          requiredToolSet: options.admission === "unknown"
            ? {
                status: "unknown",
                requiredChoice: "provider-enforced",
                parallelCalls: "provider-disabled",
                streaming: true,
                adapter: "agencity.fixture.unknown.v1",
              }
            : {
                status: "unsupported",
                requiredChoice: "unsupported",
                parallelCalls: "unsupported",
                streaming: false,
                adapter: "agencity.fixture.unsupported.v1",
                reason: "Fixture model cannot execute the required agent tools.",
              },
        };
  }

  normalizeModel(model: string): string {
    const normalized = model.trim();
    return this.enforceCanonicalIdentity
      ? validateCanonicalProductModelId(normalized)
      : normalized;
  }

  async complete(
    _context: JsonValue,
    _configuration: ModelConfiguration,
    _signal: AbortSignal,
  ): Promise<TextModelResponse> {
    return {
      text: "unused",
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }

  markUnsupported(): void {
    this.capabilities = {
      streaming: false,
      reasoningControl: "normalized",
      requiredToolSet: {
        status: "unsupported",
        requiredChoice: "unsupported",
        parallelCalls: "unsupported",
        streaming: false,
        adapter: "agencity.fixture.unsupported.v1",
        reason: "Fixture model became known unsupported.",
      },
    };
  }
}

async function managedFixture(
  prefix: string,
  modelProviders: readonly ModelProvider[],
): Promise<{
  readonly service: ManagedWorkspaceService;
  readonly configuration: ManagedServiceConfiguration;
}> {
  const temp = await makeTempRuntime(prefix);
  temps.push(temp);
  const workspace = await resolveWorkspace({
    override: temp.directory,
    stateDirectory: join(temp.directory, ".agencity"),
  });
  const configuration: ManagedServiceConfiguration = {
    workspace,
    databasePath: join(workspace.stateDirectory, "agent.db"),
    artifactDirectory: join(workspace.stateDirectory, "artifacts"),
    profileDatabasePath: join(workspace.stateDirectory, "profile.db"),
  };
  const service = await ManagedWorkspaceService.open(configuration, "0.1.0-test", {
    modelProviders,
    modelCatalog: {
      fetch: (async () => Response.json({ data: [] })) as unknown as typeof fetch,
    },
  });
  services.push(service);
  return { service, configuration };
}

async function directFixture(
  prefix: string,
  modelProviders: readonly ModelProvider[],
): Promise<Supervisor> {
  const temp = await makeTempRuntime(prefix);
  temps.push(temp);
  return Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    profileDatabaseUrl: `file:${join(temp.directory, "profile.db")}`,
    modelCredentialPath: join(temp.directory, "auth.json"),
    modelProviders,
    modelCatalog: {
      fetch: (async () => Response.json({ data: [] })) as unknown as typeof fetch,
    },
    recover: false,
    startWakeSchedulers: false,
  });
}

describe("new product model selection admission", () => {
  test("known-unsupported product models write no preference, root, or model change", async () => {
    const unsupported = new FixtureProvider("openai", {
      productTransport: true,
      admission: "unsupported",
    });
    const embedded = new FixtureProvider("embedded");
    const { service, configuration } = await managedFixture(
      "agencity-model-selection-unsupported-",
      [unsupported, embedded],
    );
    const client = (await connectManagedService(configuration, { spawn: false })).client;
    const preferenceKey = workspacePreferenceKey(configuration.workspace.workspaceId, "model");

    await expect(client.productSetModel("openai:openai/no-tools")).rejects.toThrow(
      "Fixture model cannot execute the required agent tools",
    );
    expect(await service.supervisor.profile.getPreference(preferenceKey)).toBeNull();

    await expect(service.supervisor.createSession({
      workspaceId: configuration.workspace.workspaceId,
      sessionId: "rejected-product-root",
      branchId: "rejected-product-branch",
      model: { provider: "openai", model: "openai/no-tools" },
    })).rejects.toThrow("Fixture model cannot execute the required agent tools");
    expect(await service.supervisor.storage.loadEvents("rejected-product-root")).toEqual([]);

    const echo = await service.supervisor.createSession({
      workspaceId: configuration.workspace.workspaceId,
      model: { provider: "echo", model: "echo-1" },
    });
    await expect(service.supervisor.selectModel(echo.sessionId, echo.branchId, {
      provider: "openai",
      model: "openai/no-tools",
    })).rejects.toThrow("Fixture model cannot execute the required agent tools");
    expect((await service.supervisor.storage.loadEvents(echo.sessionId, {
      branchId: echo.branchId,
    })).filter((event) => event.type === "SessionModelChanged")).toEqual([]);

    const custom = await service.supervisor.createSession({
      workspaceId: configuration.workspace.workspaceId,
      model: { provider: "embedded", model: "embedded-model-without-product-grammar" },
    });
    expect(custom.sessionId).toBeTruthy();
  });

  test("unknown product capability remains admissible for preferences, roots, and model changes", async () => {
    const unknown = new FixtureProvider("openai", {
      productTransport: true,
      admission: "unknown",
    });
    const { service, configuration } = await managedFixture(
      "agencity-model-selection-unknown-",
      [unknown],
    );
    const client = (await connectManagedService(configuration, { spawn: false })).client;
    const preferenceKey = workspacePreferenceKey(configuration.workspace.workspaceId, "model");

    await expect(client.productSetModel("openai:openai/private-preview")).resolves.toEqual({
      defaultModel: "openai:openai/private-preview",
    });
    expect((await service.supervisor.profile.getPreference(preferenceKey))?.value).toBe(
      "openai:openai/private-preview",
    );

    const product = await service.supervisor.createSession({
      workspaceId: configuration.workspace.workspaceId,
      model: { provider: "openai", model: "openai/private-preview" },
    });
    expect((await service.supervisor.storage.loadEvents(product.sessionId)).filter(
      (event) => event.type === "SessionCreated",
    )).toHaveLength(1);

    const echo = await service.supervisor.createSession({
      workspaceId: configuration.workspace.workspaceId,
      model: { provider: "echo", model: "echo-1" },
    });
    const selected = await service.supervisor.selectModel(echo.sessionId, echo.branchId, {
      provider: "openai",
      model: "openai/private-preview",
    });
    expect(selected.changed).toBe(true);
  });

  test("deferred custom providers keep provider-specific session admission", async () => {
    const supervisor = await directFixture(
      "agencity-model-selection-custom-admission-",
      [],
    );
    try {
      const deferred = await supervisor.createSession({
        workspaceId: "custom-admission-workspace",
        model: {
          provider: "deferred-custom",
          model: "provider-specific identity",
          reasoningEffort: "provider-default",
        },
      });
      expect(
        projectEvents(await supervisor.storage.loadEvents(
          deferred.sessionId,
          { branchId: deferred.branchId },
        )).model,
      ).toEqual({
        provider: "deferred-custom",
        model: "provider-specific identity",
        reasoningEffort: "provider-default",
      });
    } finally {
      await supervisor.close();
    }
  });

  test("keeps a confirmed default when a later root request is definitely rejected", async () => {
    const provider = new FixtureProvider("openai", {
      productTransport: true,
      admission: "unknown",
    });
    const { service, configuration } = await managedFixture(
      "agencity-model-selection-partial-root-",
      [provider],
    );
    const client = (await connectManagedService(configuration, {
      spawn: false,
    })).client;
    const preferenceKey = workspacePreferenceKey(
      configuration.workspace.workspaceId,
      "model",
    );

    await client.productSetModel("openai:openai/confirmed-default");
    provider.markUnsupported();

    await expect(client.createSession(configuration.workspace.workspaceId, {
      model: {
        provider: "openai",
        model: "openai/confirmed-default",
        reasoningEffort: "provider-default",
      },
    })).rejects.toThrow("Fixture model became known unsupported");
    expect(
      (await service.supervisor.profile.getPreference(preferenceKey))?.value,
    ).toBe("openai:openai/confirmed-default");
    expect(await client.productSessions()).toEqual([]);
  });

  test("keeps the confirmed default and reconciles a root after its response is lost", async () => {
    const provider = new FixtureProvider("openai", {
      productTransport: true,
      admission: "unknown",
    });
    const { service, configuration } = await managedFixture(
      "agencity-model-selection-unconfirmed-root-",
      [provider],
    );
    const connection = await connectManagedService(configuration, {
      spawn: false,
    });
    const client = connection.client;
    const preferenceKey = workspacePreferenceKey(
      configuration.workspace.workspaceId,
      "model",
    );
    await client.productSetModel("openai:openai/confirmed-default");

    const lostResponseTransport: ProtocolTransport = {
      kind: client.transport.kind,
      request: async (path, init) => {
        const response = await client.transport.request(path, init);
        if (path === "/sessions" && init?.method === "POST" && response.ok) {
          throw new Error("fixture connection lost after request dispatch");
        }
        return response;
      },
    };
    const uncertainClient = new AgentClient(lostResponseTransport);
    await expect(
      uncertainClient.createSession(configuration.workspace.workspaceId, {
        model: {
          provider: "openai",
          model: "openai/confirmed-default",
        },
      }),
    ).rejects.toThrow("connection lost after request dispatch");

    expect(
      (await service.supervisor.profile.getPreference(preferenceKey))?.value,
    ).toBe("openai:openai/confirmed-default");
    expect(await client.productSessions()).toHaveLength(1);
  });

  test("later capability checks do not rewrite or invalidate a retained branch", async () => {
    const provider = new FixtureProvider("openai", {
      productTransport: true,
      admission: "unknown",
    });
    const supervisor = await directFixture(
      "agencity-model-selection-retained-",
      [provider],
    );
    try {
      const model = {
        provider: "openai",
        model: "openai/retained-model",
        reasoningEffort: "provider-default" as const,
      };
      const created = await supervisor.createSession({
        workspaceId: "retained-model-workspace",
        sessionId: "retained-product-root",
        branchId: "retained-product-branch",
        model,
      });

      provider.markUnsupported();
      await expect(supervisor.normalizeSelectedModelAdmission(model)).rejects.toThrow(
        "Fixture model became known unsupported",
      );
      await expect(supervisor.createSession({
        workspaceId: "retained-model-workspace",
        sessionId: created.sessionId,
        branchId: created.branchId,
        model,
      })).resolves.toEqual(created);
      await expect(supervisor.selectModel(created.sessionId, created.branchId, model)).resolves.toMatchObject({
        changed: false,
        model,
      });

      const events = await supervisor.storage.loadEvents(created.sessionId, {
        branchId: created.branchId,
      });
      expect(events.filter((event) => event.type === "SessionCreated")).toHaveLength(1);
      expect(events.filter((event) => event.type === "SessionModelChanged")).toEqual([]);
    } finally {
      await supervisor.close();
    }
  });

  test("stricter product grammar does not reject exact retained idempotent access", async () => {
    const provider = new FixtureProvider("openai", {
      productTransport: true,
      admission: "unknown",
    });
    const supervisor = await directFixture(
      "agencity-model-selection-retained-grammar-",
      [provider],
    );
    try {
      const legacyModel = {
        provider: "openai",
        model: ".legacy/model",
        reasoningEffort: "provider-default" as const,
      };
      const created = await supervisor.createSession({
        workspaceId: "retained-grammar-workspace",
        sessionId: "retained-grammar-root",
        branchId: "retained-grammar-branch",
        model: legacyModel,
      });

      provider.enforceCanonicalIdentity = true;
      await expect(supervisor.createSession({
        workspaceId: "retained-grammar-workspace",
        sessionId: created.sessionId,
        branchId: created.branchId,
        model: legacyModel,
      })).resolves.toEqual(created);
      await expect(
        supervisor.selectModel(created.sessionId, created.branchId, legacyModel),
      ).resolves.toMatchObject({
        changed: false,
        model: legacyModel,
      });
      await expect(supervisor.createSession({
        workspaceId: "retained-grammar-workspace",
        sessionId: "new-invalid-grammar-root",
        model: legacyModel,
      })).rejects.toThrow("bounded canonical");
    } finally {
      await supervisor.close();
    }
  });
});

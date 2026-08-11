import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog } from "../../src/runtime/index.ts";
import { ModelExecutor, createVercelModelProvider } from "../../src/executors/index.ts";
import { ProfileStore } from "../../src/storage/index.ts";
import { stableJson } from "../../src/sync/index.ts";

let directory: string | undefined;
let profile: ProfileStore | undefined;

afterEach(async () => {
  profile?.close();
  profile = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function catalogBody() {
  return {
    data: [
      {
        id: "openai/gpt-5.2",
        name: "GPT 5.2",
        type: "language",
        context_window: 400_000,
        max_tokens: 128_000,
        pricing: { input: "0.00000175", output: "0.000014" },
        tags: ["reasoning"],
        supports_tools: false,
        tool_calling: false,
        strict_tools: true,
        reasoning_options: [
          { type: "toggle" },
          { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
        ],
      },
      {
        id: "anthropic/claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        type: "language",
        context_window: 200_000,
        max_tokens: 64_000,
        pricing: { input: "0.000003", output: "0.000015" },
        reasoning_options: null,
      },
      {
        id: "meta/unknown",
        name: "Unknown",
        type: "language",
        context_window: null,
        max_tokens: null,
        pricing: null,
        tags: ["reasoning"],
      },
      {
        id: "cohere/toggle-only",
        name: "Toggle only",
        type: "language",
        reasoning_options: [{ type: "toggle" }],
      },
      { id: "openai/embedding", type: "embedding" },
    ],
  };
}

describe("Vercel AI Gateway model catalog", () => {
  test("normalizes language models, caches by endpoint, and falls back visibly when stale", async () => {
    directory = await mkdtemp(join(tmpdir(), "ag-model-catalog-"));
    profile = await ProfileStore.open(`file:${directory}/profile.db`);
    let online = true;
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      if (!online) throw new Error("temporary credential-shaped-secret outage");
      return Response.json(catalogBody());
    }) as unknown as typeof fetch;
    const catalog = new ModelCatalog(profile, {
      gatewayOrigin: "https://gateway.ai.cloudflare.test/",
      fetch: fetchImpl,
      freshnessMs: 1,
    });

    const refreshed = await catalog.refresh();
    expect(refreshed.status).toBe("refreshed");
    expect((await profile.getModelCatalogCache(catalog.endpointId))?.schemaVersion)
      .toBe(1);
    expect(catalog.gatewayOrigin).toBe("https://gateway.ai.cloudflare.test");
    expect(refreshed.descriptors.map(item => item.model)).toEqual([
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5.2",
      "cohere/toggle-only",
      "meta/unknown",
    ]);
    expect(refreshed.descriptors[0]?.reasoning).toEqual({ status: "unsupported", levels: [] });
    expect(refreshed.descriptors[1]?.reasoning).toEqual({
      status: "listed",
      levels: ["none", "low", "medium", "high", "xhigh"],
    });
    expect(refreshed.descriptors[1]?.unsupportedReasoningValues).toEqual(["max"]);
    expect(refreshed.descriptors[1]?.requiredToolSet).toEqual({
      status: "unknown",
      strictSchema: "unknown",
      requiredChoice: "unknown",
    });
    expect(refreshed.descriptors[2]?.reasoning).toEqual({
      status: "unverified",
      levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
    });
    expect(refreshed.descriptors[3]?.reasoning.status).toBe("unverified");
    expect(refreshed.descriptors[3]?.contextWindowTokens).toBeNull();
    const executor = new ModelExecutor([
      createVercelModelProvider({
        origin: "https://gateway.ai.cloudflare.test",
        apiKey: () => "unused",
      }),
    ], 1, catalog);
    expect(executor.contextCapacity({
      provider: "vercel",
      model: "openai/gpt-5.2",
      reasoningEffort: "provider-default",
    })).toMatchObject({ source: "model-catalog", contextWindowTokens: 400_000 });
    expect(executor.contextCapacity({
      provider: "vercel",
      model: "anthropic/claude-sonnet-4.5",
      reasoningEffort: "provider-default",
    })).toMatchObject({ source: "model-catalog", contextWindowTokens: 200_000 });
    expect(() => executor.resolveDispatch({
      provider: "vercel",
      model: "anthropic/claude-sonnet-4.5",
      reasoningEffort: "high",
    })).toThrow("without reasoning control");
    expect(executor.resolveDispatch({
      provider: "vercel",
      model: "cohere/toggle-only",
      reasoningEffort: "none",
    }).reasoning.capability).toMatchObject({
      status: "unverified",
      levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
    });

    await Bun.sleep(5);
    online = false;
    const fallback = await catalog.refresh();
    expect(fallback.status).toBe("cached-fallback");
    expect(fallback.descriptors.every(item => item.stale)).toBe(true);
    expect(fallback.error).toBe("Model catalog request failed");
    expect(JSON.stringify(fallback)).not.toContain("credential-shaped-secret");
    expect(requests).toBe(2);

    const restored = new ModelCatalog(profile, {
      gatewayOrigin: "https://gateway.ai.cloudflare.test",
      fetch: fetchImpl,
    });
    await restored.hydrate();
    expect(restored.list().every(item => item.stale)).toBe(true);
  });

  test("isolates cache entries for different normalized gateway origins", async () => {
    directory = await mkdtemp(join(tmpdir(), "ag-model-catalog-origin-"));
    profile = await ProfileStore.open(`file:${directory}/profile.db`);
    const first = new ModelCatalog(profile, {
      gatewayOrigin: "https://gateway-one.example/",
      fetch: (async () => Response.json(catalogBody())) as unknown as typeof fetch,
    });
    await first.refresh();

    const second = new ModelCatalog(profile, {
      gatewayOrigin: "https://gateway-two.example",
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    await second.hydrate();
    expect(second.list()).toHaveLength(0);
    const unavailable = await second.refresh();
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.error).toBe("Model catalog request failed");
    expect(() => new ModelCatalog(profile!, {
      gatewayOrigin: "https://gateway-two.example/not-an-origin",
    })).toThrow("must be an origin");
  });

  test("rejects malformed and duplicate catalog records atomically", async () => {
    directory = await mkdtemp(join(tmpdir(), "ag-model-catalog-malformed-"));
    profile = await ProfileStore.open(`file:${directory}/profile.db`);
    const catalog = new ModelCatalog(profile, {
      fetch: (async () =>
        Response.json({
          data: [
            ...catalogBody().data,
            { ...catalogBody().data[0], name: "duplicate" },
          ],
        })) as unknown as typeof fetch,
    });
    const unavailable = await catalog.refresh();
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.error).toBe("Model catalog contains duplicate model IDs");
    expect(unavailable.error).not.toContain("openai/gpt-5.2");
    expect(catalog.list()).toHaveLength(0);
  });

  test("treats budget-only reasoning metadata as unverified rather than unsupported", async () => {
    directory = await mkdtemp(join(tmpdir(), "ag-model-catalog-budget-reasoning-"));
    profile = await ProfileStore.open(`file:${directory}/profile.db`);
    const catalog = new ModelCatalog(profile, {
      fetch: (async () => Response.json({
        data: [{
          id: "provider/budget-reasoner",
          name: "Budget Reasoner",
          type: "language",
          tags: [],
          context_window: 100_000,
          max_tokens: 10_000,
          pricing: { input: "0.000001", output: "0.000002" },
          reasoning_options: [{ type: "budget_tokens", min: 100, max: 8_000 }],
        }],
      })) as unknown as typeof fetch,
    });
    const refreshed = await catalog.refresh();
    expect(refreshed.descriptors[0]?.reasoning).toEqual({
      status: "unverified",
      levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
    });
  });

  test("discards a cache row whose retained descriptor bytes fail the revision digest", async () => {
    directory = await mkdtemp(join(tmpdir(), "ag-model-catalog-corrupt-"));
    const url = `file:${directory}/profile.db`;
    profile = await ProfileStore.open(url);
    const catalog = new ModelCatalog(profile, {
      fetch: (async () => Response.json(catalogBody())) as unknown as typeof fetch,
    });
    await catalog.refresh();
    const raw = createClient({ url });
    await raw.execute({
      sql: "UPDATE model_catalog_cache SET descriptors_json=? WHERE endpoint_id=?",
      args: ["[]", catalog.endpointId],
    });
    raw.close();

    const restored = new ModelCatalog(profile);
    await restored.hydrate();
    expect(restored.list()).toHaveLength(0);
    expect(await profile.getModelCatalogCache(catalog.endpointId)).toBeNull();
  });

  test("bounds catalog response time and bytes while reading the body", async () => {
    directory = await mkdtemp(join(tmpdir(), "ag-model-catalog-bounds-"));
    profile = await ProfileStore.open(`file:${directory}/profile.db`);
    const slow = new ModelCatalog(profile, {
      timeoutMs: 20,
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":['));
        },
      }))) as unknown as typeof fetch,
    });
    const timedOut = await slow.refresh();
    expect(timedOut).toMatchObject({ status: "unavailable", error: "Model catalog request timed out" });

    const oversized = new ModelCatalog(profile, {
      gatewayOrigin: "https://oversized.example",
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < 9; index++) controller.enqueue(new Uint8Array(1024 * 1024));
          controller.close();
        },
      }))) as unknown as typeof fetch,
    });
    const rejected = await oversized.refresh();
    expect(rejected).toMatchObject({ status: "unavailable", error: "Model catalog response exceeds its byte bound" });
  });

  test("rejects false descriptor provenance even when the outer cache digest matches", async () => {
    directory = await mkdtemp(join(tmpdir(), "ag-model-catalog-descriptor-digest-"));
    const url = `file:${directory}/profile.db`;
    profile = await ProfileStore.open(url);
    const catalog = new ModelCatalog(profile, {
      fetch: (async () => Response.json(catalogBody())) as unknown as typeof fetch,
    });
    await catalog.refresh();
    const raw = createClient({ url });
    const row = (await raw.execute({
      sql: "SELECT descriptors_json FROM model_catalog_cache WHERE endpoint_id=?",
      args: [catalog.endpointId],
    })).rows[0]!;
    const descriptors = JSON.parse(String(row.descriptors_json)) as Array<Record<string, unknown>>;
    descriptors[0]!.catalogDigest = "f".repeat(64);
    const descriptorsJson = stableJson(descriptors);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(descriptorsJson);
    await raw.execute({
      sql: "UPDATE model_catalog_cache SET descriptors_json=?,revision_digest=? WHERE endpoint_id=?",
      args: [descriptorsJson, hasher.digest("hex"), catalog.endpointId],
    });
    raw.close();

    const restored = new ModelCatalog(profile);
    await restored.hydrate();
    expect(restored.list()).toHaveLength(0);
    expect(await profile.getModelCatalogCache(catalog.endpointId)).toBeNull();
  });

  test("rejects cache origins with credentials or mismatched endpoint identities", async () => {
    directory = await mkdtemp(join(tmpdir(), "ag-model-catalog-cache-origin-"));
    profile = await ProfileStore.open(`file:${directory}/profile.db`);
    const catalog = new ModelCatalog(profile, {
      fetch: (async () => Response.json(catalogBody())) as unknown as typeof fetch,
    });
    await catalog.refresh();
    const retained = (await profile.getModelCatalogCache(catalog.endpointId))!;
    await expect(profile.putModelCatalogCache({
      ...retained,
      catalogOrigin: "https://user:secret@gateway.example",
    })).rejects.toThrow("must not contain credentials");
    await expect(profile.putModelCatalogCache({
      ...retained,
      catalogOrigin: "https://another-gateway.example",
    })).rejects.toThrow("endpoint does not match");
  });

  test("rejects unknown profile migration versions", async () => {
    directory = await mkdtemp(join(tmpdir(), "ag-profile-future-migration-"));
    const url = `file:${directory}/profile.db`;
    profile = await ProfileStore.open(url);
    profile.close();
    profile = undefined;
    const raw = createClient({ url });
    await raw.execute({
      sql: "INSERT INTO profile_schema_migrations(version,name,source_digest,applied_at) VALUES(99,'future',?,?)",
      args: ["f".repeat(64), new Date().toISOString()],
    });
    raw.close();
    await expect(ProfileStore.open(url)).rejects.toThrow("unknown or non-contiguous");
  });

  test("opens one fresh profile concurrently without a partial migration ledger", async () => {
    directory = await mkdtemp(join(tmpdir(), "ag-profile-concurrent-migration-"));
    const url = `file:${directory}/profile.db`;
    const [first, second] = await Promise.all([ProfileStore.open(url), ProfileStore.open(url)]);
    first.close();
    second.close();
    const raw = createClient({ url });
    const versions = (await raw.execute("SELECT version FROM profile_schema_migrations ORDER BY version"))
      .rows.map(row => Number(row.version));
    raw.close();
    expect(versions).toEqual([1, 2, 3]);
  });

  test("serializes fresh profile migration across independent processes", async () => {
    directory = await mkdtemp(join(tmpdir(), "ag-profile-process-migration-"));
    const url = `file:${directory}/profile.db`;
    const script = `import { ProfileStore } from "./src/storage/turso.ts"; const profile = await ProfileStore.open(${JSON.stringify(url)}); profile.close();`;
    const children = Array.from({ length: 4 }, () => Bun.spawn({
      cmd: [process.execPath, "-e", script],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    }));
    const codes = await Promise.all(children.map(child => child.exited));
    if (codes.some(code => code !== 0)) {
      const errors = await Promise.all(children.map(child => new Response(child.stderr).text()));
      throw new Error(errors.join("\n"));
    }
    const raw = createClient({ url });
    const versions = (await raw.execute("SELECT version FROM profile_schema_migrations ORDER BY version"))
      .rows.map(row => Number(row.version));
    raw.close();
    expect(versions).toEqual([1, 2, 3]);
  });
});

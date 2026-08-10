import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import {
  Fts5MemoryCandidateIndex,
  HttpMemoryCandidateIndex,
  HttpRelationalStateStore,
  LibSqlStorage,
  LocalArtifactStore,
  MemoryService,
  RemoteSandboxExecutor,
  S3CompatibleArtifactStore,
  ShellExecutor,
  TrustedLocalExecutor,
  createCandidateIndexRpcHandler,
  createExecutorRpcHandler,
  createRelationalStateRpcHandler,
  localCandidateIndexDescriptor,
  localObjectCasDescriptor,
  localRelationalState,
  type AgentStorage,
  type ArtifactReference,
  type MemoryCandidateIndex,
} from "../../src/index.ts";
import { fixtureAgentProfile, makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";
import { artifactStoreConformance, candidateIndexConformance, executorConformance, relationalStateConformance } from "./conformance.ts";

type Stoppable = { stop(closeActiveConnections?: boolean): void | Promise<void> };
const temps: TempRuntime[] = [], servers: Stoppable[] = [], storages: AgentStorage[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});
async function temp(prefix: string): Promise<TempRuntime> { const value = await makeTempRuntime(prefix); temps.push(value); return value; }
function serve(handler: (request: Request) => Response | Promise<Response>): { endpoint: string; server: Stoppable } {
  const server = Bun.serve({ port: 0, fetch: handler }); servers.push(server);
  return { endpoint: server.url.origin, server };
}
async function database(value: TempRuntime): Promise<LibSqlStorage> { const store = new LibSqlStorage(value.databaseUrl); await store.migrate(); storages.push(store); return store; }

async function seedCandidateData(storage: AgentStorage): Promise<void> {
  await storage.appendEvents([{
    id: "candidate-session-created", sessionId: "candidate-session", branchId: "main", type: "SessionCreated",
    producer: "supervisor", idempotencyKey: "candidate-session", committedAt: "2026-08-05T00:00:00.000Z",
    payload: { workspaceId: "candidate-workspace", initialBranchId: "main", model: { provider: "echo", model: "echo", reasoningEffort: "provider-default" }, budget: {}, agentProfile: fixtureAgentProfile("candidate-session") },
  }, {
    id: "candidate-memory-allowed", sessionId: "candidate-session", branchId: "main", type: "HarnessVersionCreated",
    producer: "client", idempotencyKey: "candidate-memory-allowed", committedAt: "2026-08-05T00:00:01.000Z",
    payload: {
      entryId: "entry-allowed", versionId: "version-allowed", version: 1, kind: "memory", scope: "workspace", scopeKey: "candidate-workspace",
      name: "allowed", content: { kind: "memory", memoryKind: "observation", text: "placement sentinel is authoritative" }, tags: ["placement"],
      confidence: 0.9, status: "active", evidenceEventIds: [], conflictEntryIds: [], createdBy: "user", lastConfirmedAt: "2026-08-05T00:00:01.000Z",
    },
  }, {
    id: "candidate-memory-blocked", sessionId: "candidate-session", branchId: "main", type: "HarnessVersionCreated",
    producer: "client", idempotencyKey: "candidate-memory-blocked", committedAt: "2026-08-05T00:00:02.000Z",
    payload: {
      entryId: "entry-blocked", versionId: "version-blocked", version: 1, kind: "memory", scope: "local", scopeKey: "some-other-session",
      name: "blocked", content: { kind: "memory", memoryKind: "observation", text: "placement sentinel must not cross scope" }, tags: ["placement"],
      confidence: 0.8, status: "active", evidenceEventIds: [], conflictEntryIds: [], createdBy: "agent", lastConfirmedAt: "2026-08-05T00:00:02.000Z",
    },
  }]);
}

describe("relational placement conformance", () => {
  test("the same suite passes process-local LibSQL and a real HTTP/RPC server-owned store", async () => {
    const localStore = await database(await temp("placement-relational-local-"));
    const local = localRelationalState(localStore);
    expect(local.descriptor).toMatchObject({ placement: "local", transport: "in-process", capabilities: { offlineWrites: true, sameDeviceProcessFencing: true, distributedLeases: false, analyticalSql: true } });
    await relationalStateConformance(local.storage, "local");

    const serverStore = await database(await temp("placement-relational-server-"));
    const { endpoint } = serve(createRelationalStateRpcHandler(serverStore, { analyticalSql: true }));
    const remote = await HttpRelationalStateStore.connect({ endpoint });
    expect(remote.placement).toMatchObject({ placement: "remote", transport: "http", protocol: "agencity-relational-rpc-v1", capabilities: { offlineWrites: false, sameDeviceProcessFencing: false, distributedLeases: false, notifications: false } });
    await relationalStateConformance(remote, "remote");
    expect(() => remote.onCommitted(() => {})).toThrow(expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }));
    await expect(remote.migrate()).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    remote.close();
  });

  test("remote transport loss is an explicit dependency failure, never local delegation", async () => {
    const serverStore = await database(await temp("placement-relational-loss-"));
    const running = serve(createRelationalStateRpcHandler(serverStore));
    const remote = await HttpRelationalStateStore.connect({ endpoint: running.endpoint, requestTimeoutMs: 500 });
    await running.server.stop(true);
    servers.splice(servers.indexOf(running.server), 1);
    await expect(remote.listBranches()).rejects.toMatchObject({ code: "DEPENDENCY_FAILURE" });
    remote.close();
  });
});

class ObjectProtocolServer {
  readonly objects = new Map<string, Uint8Array>();
  readonly requests: Array<{ method: string; path: string; checksum: string | null }> = [];
  handler = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    this.requests.push({ method: request.method, path: pathname, checksum: request.headers.get("x-amz-checksum-sha256") });
    if (request.method === "PUT") {
      if (this.objects.has(pathname) && request.headers.get("if-none-match") === "*") return new Response(null, { status: 412 });
      this.objects.set(pathname, new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    if (request.method === "GET") {
      const bytes = this.objects.get(pathname);
      if (!bytes) return new Response("missing", { status: 404 });
      const metadata = {
        "x-amz-meta-sha256": pathname.split("/").at(-1)!,
      };
      const range = request.headers.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
      if (range) {
        const start = Number(range[1]), end = Number(range[2]) + 1;
        if (bytes.byteLength === 0) {
          return new Response(null, {
            status: 416,
            headers: { ...metadata, "content-range": "bytes */0" },
          });
        }
        return new Response(bytes.slice(start, end), {
          status: 206,
          headers: {
            "content-range": `bytes ${start}-${end - 1}/${bytes.byteLength}`,
            ...metadata,
          },
        });
      }
      return new Response(new Uint8Array(bytes).buffer as ArrayBuffer, {
        status: 200,
        headers: { ...metadata, "content-length": String(bytes.byteLength) },
      });
    }
    if (request.method === "DELETE") { this.objects.delete(pathname); return new Response(null, { status: 204 }); }
    return new Response("unsupported", { status: 405 });
  };
  corrupt(reference: ArtifactReference): void {
    const match = [...this.objects.keys()].find((key) => key.endsWith(reference.digest));
    if (!match) throw new Error("object not found for corruption test");
    this.objects.set(match, new TextEncoder().encode("server-corrupted-content"));
  }
}

describe("content-addressed artifact placement conformance", () => {
  test("the same CAS suite passes local files and a real S3/R2-style HTTP object protocol", async () => {
    const value = await temp("placement-cas-");
    const local = new LocalArtifactStore(value.artifactDirectory);
    expect(localObjectCasDescriptor(local)).toMatchObject({ placement: "local", protocol: "local-filesystem-cas-v1", capabilities: { stableSha256Identity: true, integrityVerification: true } });
    await artifactStoreConformance(local, value.directory);

    const objectServer = new ObjectProtocolServer();
    const { endpoint } = serve(objectServer.handler);
    const remote = new S3CompatibleArtifactStore({ endpoint, bucket: "placement-bucket", prefix: "cas" });
    await artifactStoreConformance(remote, value.directory);
    expect(objectServer.requests.some((request) => request.method === "PUT" && request.path.includes("/placement-bucket/cas/sha256/"))).toBe(true);
    expect(objectServer.requests.find((request) => request.method === "PUT")?.checksum).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(new Set(objectServer.requests.map((request) => request.method)).has("GET")).toBe(true);
    expect(new Set(objectServer.requests.map((request) => request.method)).has("DELETE")).toBe(true);

    const large = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);
    const largeReference = await remote.put(large);
    expect(await remote.readRange(largeReference, 65_000, 65_100)).toEqual(large.slice(65_000, 65_100));
  });

  test("remote corruption, missing content, and transport loss are dependency failures", async () => {
    const objectServer = new ObjectProtocolServer();
    const running = serve(objectServer.handler);
    const remote = new S3CompatibleArtifactStore({ endpoint: running.endpoint, bucket: "dependency-bucket", requestTimeoutMs: 500 });
    const reference = await remote.put("uncorrupted bytes");
    objectServer.corrupt(reference);
    expect(await remote.verify(reference)).toBe(false);
    await expect(remote.resolve(reference)).rejects.toMatchObject({ code: "DEPENDENCY_FAILURE", details: { artifactId: reference.artifactId } });
    const healthy = await remote.put("transport will disappear");
    await running.server.stop(true); servers.splice(servers.indexOf(running.server), 1);
    await expect(remote.resolve(healthy)).rejects.toMatchObject({ code: "DEPENDENCY_FAILURE" });
  });

  test("remote empty ranges verify object existence and bytes without whole-object buffering", async () => {
    const objectServer = new ObjectProtocolServer();
    const { endpoint } = serve(objectServer.handler);
    const remote = new S3CompatibleArtifactStore({ endpoint, bucket: "empty-range-bucket" });

    const nonempty = await remote.put(Uint8Array.from({ length: 70_000 }, (_, index) => index % 251));
    expect(await remote.readRange(nonempty, 40_000, 40_000)).toEqual(new Uint8Array());
    const zero = await remote.put(new Uint8Array());
    expect(await remote.readRange(zero, 0, 0)).toEqual(new Uint8Array());

    objectServer.corrupt(nonempty);
    await expect(remote.readRange(nonempty, 10, 10)).rejects.toMatchObject({
      code: "DEPENDENCY_FAILURE",
    });
    objectServer.corrupt(zero);
    await expect(remote.readRange(zero, 0, 0)).rejects.toMatchObject({
      code: "DEPENDENCY_FAILURE",
    });

    const missing = await remote.put("delete-before-empty-range");
    await remote.delete(missing);
    await expect(remote.readRange(missing, 0, 0)).rejects.toMatchObject({
      code: "DEPENDENCY_FAILURE",
    });
  });
});

describe("candidate-index placement conformance", () => {
  test("the same suite passes local FTS5 and an independent FTS5 store reached over HTTP", async () => {
    const authoritative = await database(await temp("placement-candidate-local-"));
    await seedCandidateData(authoritative);
    const local = new Fts5MemoryCandidateIndex(authoritative);
    expect(localCandidateIndexDescriptor(local)).toMatchObject({ placement: "local", capabilities: { candidateGenerationOnly: true, authoritativePolicyFiltering: false } });
    await candidateIndexConformance(local);

    const serverStore = await database(await temp("placement-candidate-server-"));
    await seedCandidateData(serverStore);
    const running = serve(createCandidateIndexRpcHandler(new Fts5MemoryCandidateIndex(serverStore), { rebuild: true }));
    const remote = await HttpMemoryCandidateIndex.connect({ endpoint: running.endpoint });
    await candidateIndexConformance(remote);
    expect(remote.placement).toMatchObject({ placement: "remote", transport: "http", capabilities: { candidateGenerationOnly: true, authoritativePolicyFiltering: false } });

    const selected = await new MemoryService(authoritative, remote).search("candidate-session", "main", "placement sentinel", { scopes: ["local", "workspace"], statuses: ["active"] });
    expect(selected.items.map((item) => item.record.entryId)).toEqual(["entry-allowed"]);
    expect(selected.provenance.rejections).toContainEqual({ versionId: "version-blocked", entryId: "entry-blocked", reasons: ["scope_mismatch"] });
    expect(selected.provenance.index).toBe(remote.name);

    await running.server.stop(true); servers.splice(servers.indexOf(running.server), 1);
    await expect(remote.candidates("placement")).rejects.toMatchObject({ code: "DEPENDENCY_FAILURE" });
  });

  test("an administrative rebuild not advertised by the remote service throws CAPABILITY_UNAVAILABLE", async () => {
    const serverStore = await database(await temp("placement-candidate-no-rebuild-")); await seedCandidateData(serverStore);
    const { endpoint } = serve(createCandidateIndexRpcHandler(new Fts5MemoryCandidateIndex(serverStore), { rebuild: false }));
    const remote = await HttpMemoryCandidateIndex.connect({ endpoint });
    await expect(remote.rebuild()).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });
});

describe("executor placement conformance", () => {
  test("the same typed-outcome suite passes trusted local execution and sandbox RPC", async () => {
    const localTemp = await temp("placement-executor-local-"); await mkdir(localTemp.workspaceRoot, { recursive: true });
    const local = new TrustedLocalExecutor(new ShellExecutor(localTemp.workspaceRoot), { operations: ["run"] });
    expect(local.placement.capabilities).toMatchObject({ isolation: "trusted-local-process", isolatedFromHost: false, filesystem: "host-workspace" });
    await executorConformance(local, "local");

    const remoteTemp = await temp("placement-executor-server-"); await mkdir(remoteTemp.workspaceRoot, { recursive: true });
    const running = serve(createExecutorRpcHandler(new ShellExecutor(remoteTemp.workspaceRoot), {
      isolatedFromHost: true, operations: ["run"], filesystem: "sandbox", network: "none", name: "sandbox-shell",
    }));
    const remote = await RemoteSandboxExecutor.connect({ endpoint: running.endpoint });
    expect(remote.placement.capabilities).toMatchObject({ isolation: "managed-remote-sandbox", isolatedFromHost: true, filesystem: "sandbox", network: "none" });
    await executorConformance(remote, "remote");

    await running.server.stop(true); servers.splice(servers.indexOf(running.server), 1);
    const unknown = await remote.execute({ effectId: "lost", sessionId: "s", branchId: "main", executor: remote.name, operation: "run", input: { command: "true" }, idempotencyKey: "lost", idempotent: false, attempt: 1 }, { signal: new AbortController().signal });
    expect(unknown).toMatchObject({ outcome: "unknown" });
    expect(unknown.error).toContain("transport failure");
  });

  test("does not register remote artifact references without a transfer capability", async () => {
    const digest = "a".repeat(64);
    const reference: ArtifactReference = {
      artifactId: `sha256:${digest}`,
      digest,
      mediaType: "text/plain",
      size: 30_000,
    };
    const executor = {
      name: "remote-spill",
      async execute() {
        return {
          outcome: "succeeded" as const,
          output: {
            protocol: "agencity.bounded-output.v1",
            completeness: "spilled",
            byteLength: reference.size,
            preview: { head: "bounded", tail: "bounded" },
            artifact: reference,
            guidance: "fixture",
          },
          artifacts: [reference],
        };
      },
    };
    const running = serve(createExecutorRpcHandler(executor as any, {
      isolatedFromHost: true,
      operations: ["run"],
      filesystem: "sandbox",
      network: "none",
    }));
    const remote = await RemoteSandboxExecutor.connect({ endpoint: running.endpoint });
    const execution = await remote.execute({
      effectId: "remote-spill",
      sessionId: "session",
      branchId: "main",
      executor: remote.name,
      operation: "run",
      input: {},
      idempotencyKey: "remote-spill",
      idempotent: true,
      attempt: 1,
    }, { signal: new AbortController().signal });
    expect(execution).toMatchObject({
      outcome: "unknown",
      error: expect.stringContaining("artifact"),
    });
    expect(execution.artifacts).toBeUndefined();
  });
});

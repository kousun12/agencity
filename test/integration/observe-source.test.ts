import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServiceManifest } from "../../src/product/service-discovery.ts";
import { agentClientObserverSourceFactory } from "../../src/observe/source-adapter.ts";

const temporaryDirectories: string[] = [];
const servers: Bun.Server<unknown>[] = [];
const workspaceId = "workspace-observe-source-0001";

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agencity-observe-source-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, ".agencity", "service"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".agencity", "workspace-id"), `${workspaceId}\n`, { mode: 0o600 });
  return root;
}

async function manifest(root: string, input: {
  readonly url: string;
  readonly instanceId?: string;
  readonly protocolMin?: number;
  readonly protocolMax?: number;
  readonly bearerToken?: string;
}): Promise<void> {
  const bearerToken = input.bearerToken;
  const value = createServiceManifest({
    workspaceId,
    deviceId: "device-observe-source",
    instanceId: input.instanceId ?? "instance-observe-source",
    url: input.url,
    appVersion: "test",
    protocolMin: input.protocolMin ?? 4,
    protocolMax: input.protocolMax ?? 4,
    configHash: "a".repeat(64),
    ...(bearerToken === undefined
      ? {}
      : { randomToken: () => Buffer.from(bearerToken, "base64url") }),
  });
  await writeFile(
    join(root, ".agencity", "service", "manifest.json"),
    JSON.stringify(value),
    { mode: 0o600 },
  );
}

function protocolServer(input: {
  readonly health?: Record<string, unknown>;
  readonly capabilities?: Record<string, unknown>;
  readonly token?: string;
  readonly paths?: string[];
  readonly roots?: unknown;
  readonly healthAbort?: { aborted: boolean };
} = {}): Bun.Server<unknown> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      input.paths?.push(url.pathname);
      if (request.headers.get("authorization") !== `Bearer ${input.token ?? "managed-token"}`) {
        return Response.json({ error: { code: "UNAUTHORIZED", message: "no" } }, { status: 401 });
      }
      if (url.pathname === "/health") {
        if (input.healthAbort) {
          return new Promise<Response>(resolve => {
            request.signal.addEventListener("abort", () => {
              input.healthAbort!.aborted = true;
              resolve(Response.json({ error: "aborted" }, { status: 499 }));
            }, { once: true });
          });
        }
        return Response.json({
          ok: true,
          authenticated: true,
          ready: true,
          workspaceId,
          instanceId: "instance-observe-source",
          appVersion: "test",
          protocolMin: 4,
          protocolMax: 4,
          ...input.health,
        });
      }
      if (url.pathname === "/capabilities") {
        return Response.json({
          managedService: true,
          productCatalog: true,
          snapshotCursorResume: true,
          committedEventDeduplication: true,
          cursorlessProgress: true,
          ...input.capabilities,
        });
      }
      if (url.pathname === "/service/agents") {
        return Response.json(input.roots ?? [{
          sessionId: "root",
          branchId: "main",
          name: "Root",
          status: "idle",
          worker: "idle",
          unresolvedWork: 0,
        }]);
      }
      if (url.pathname === "/sessions/root/snapshot") {
        return Response.json({ cursor: "1", state: {} });
      }
      if (url.pathname === "/sessions/root/stream") {
        return new Response(": connected\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return Response.json({ error: { code: "NOT_FOUND", message: "no" } }, { status: 404 });
    },
  });
  servers.push(server);
  return server;
}

describe("AgentClient observer source adapter", () => {
  test("classifies stopped, stale, conflicting, and incompatible service discovery", async () => {
    const root = await workspace();
    expect((await agentClientObserverSourceFactory.connect({
      workspaceRoot: root,
      workspaceId,
    })).kind).toBe("service_stopped");

    await manifest(root, { url: "http://127.0.0.1:9" });
    expect((await agentClientObserverSourceFactory.connect({
      workspaceRoot: root,
      workspaceId,
    })).kind).toBe("service_stale");

    const conflictToken = Buffer.alloc(32, 1).toString("base64url");
    const conflict = protocolServer({
      health: { instanceId: "different-instance" },
      token: conflictToken,
    });
    await manifest(root, {
      url: `http://127.0.0.1:${conflict.port}`,
      bearerToken: conflictToken,
    });
    expect((await agentClientObserverSourceFactory.connect({
      workspaceRoot: root,
      workspaceId,
    })).kind).toBe("service_conflict");

    const incompatibleToken = Buffer.alloc(32, 2).toString("base64url");
    const incompatible = protocolServer({
      capabilities: { cursorlessProgress: false },
      token: incompatibleToken,
    });
    await manifest(root, {
      url: `http://127.0.0.1:${incompatible.port}`,
      bearerToken: incompatibleToken,
    });
    expect((await agentClientObserverSourceFactory.connect({
      workspaceRoot: root,
      workspaceId,
    })).kind).toBe("service_incompatible");
  });

  test("uses only health, capabilities, service agents, snapshots, and branch streams", async () => {
    const root = await workspace();
    const paths: string[] = [];
    const rawToken = Buffer.alloc(32, 3).toString("base64url");
    const server = protocolServer({ token: rawToken, paths });
    await manifest(root, {
      url: `http://127.0.0.1:${server.port}`,
      bearerToken: rawToken,
    });
    const connected = await agentClientObserverSourceFactory.connect({
      workspaceRoot: root,
      workspaceId,
    });
    expect(connected.kind).toBe("connected");
    if (connected.kind !== "connected") return;
    const roots = await connected.source.roots();
    expect(roots).toHaveLength(1);
    await expect(connected.source.loadRouteSnapshot({
      sessionId: "root",
      branchId: "main",
    })).rejects.toThrow("snapshot identity is invalid");
    const streamAbort = new AbortController();
    await connected.source.streamRoute(
      { sessionId: "root", branchId: "main" },
      "1",
      { onComment() {}, onEvent() {}, onProgress() {} },
      streamAbort.signal,
    );
    expect(paths).toEqual([
      "/health",
      "/capabilities",
      "/service/agents",
      "/sessions/root/snapshot",
      "/sessions/root/stream",
    ]);
    expect(paths).not.toContain("/product/sessions");
    connected.source.close();
  });

  test("rejects malformed managed root rows", async () => {
    const root = await workspace();
    const rawToken = Buffer.alloc(32, 5).toString("base64url");
    const server = protocolServer({
      token: rawToken,
      roots: [{
        sessionId: "root",
        branchId: "main",
        name: "Root",
        status: "idle",
        worker: "idle",
        unresolvedWork: -1,
      }],
    });
    await manifest(root, {
      url: `http://127.0.0.1:${server.port}`,
      bearerToken: rawToken,
    });
    const connected = await agentClientObserverSourceFactory.connect({
      workspaceRoot: root,
      workspaceId,
    });
    expect(connected.kind).toBe("connected");
    if (connected.kind !== "connected") return;
    await expect(connected.source.roots()).rejects.toThrow("Managed root row is invalid");
    connected.source.close();
  });

  test("cancels a pending managed read when its caller times out", async () => {
    const root = await workspace();
    const rawToken = Buffer.alloc(32, 6).toString("base64url");
    const healthAbort = { aborted: false };
    const server = protocolServer({ token: rawToken, healthAbort });
    await manifest(root, {
      url: `http://127.0.0.1:${server.port}`,
      bearerToken: rawToken,
    });
    const started = Date.now();
    const connected = await agentClientObserverSourceFactory.connect({
      workspaceRoot: root,
      workspaceId,
      signal: AbortSignal.timeout(25),
    });
    expect(connected.kind).toBe("service_stale");
    expect(Date.now() - started).toBeLessThan(1_000);
    const abortDeadline = Date.now() + 500;
    while (!healthAbort.aborted && Date.now() < abortDeadline) await Bun.sleep(5);
    expect(healthAbort.aborted).toBe(true);
  });

  test("rejects malformed managed snapshot projections before family derivation", async () => {
    const root = await workspace();
    const rawToken = Buffer.alloc(32, 4).toString("base64url");
    const server = protocolServer({ token: rawToken });
    await manifest(root, {
      url: `http://127.0.0.1:${server.port}`,
      bearerToken: rawToken,
    });
    const connected = await agentClientObserverSourceFactory.connect({
      workspaceRoot: root,
      workspaceId,
    });
    expect(connected.kind).toBe("connected");
    if (connected.kind !== "connected") return;
    await expect(connected.source.loadRouteSnapshot({
      sessionId: "root",
      branchId: "main",
    })).rejects.toThrow("snapshot identity is invalid");
    connected.source.close();
  });
});

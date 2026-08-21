import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EVENT_SCHEMA_VERSION,
  reduceAgentState,
  type AgentEvent,
  type AgentState,
} from "../../src/domain/index.ts";
import {
  OBSERVER_PROTOCOL,
  ObserverController,
  ObserverControllerError,
  startObserverServer,
  type ObserverRootRoute,
  type ObserverRoute,
  type ObserverSource,
  type ObserverSourceFactory,
  type ObserverSourceStreamHandlers,
} from "../../src/observe/index.ts";
import { fixtureAgentProfile } from "../helpers.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function workspace(initialized: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agencity-observe-"));
  temporaryDirectories.push(root);
  if (initialized) {
    await mkdir(join(root, ".agencity"), { mode: 0o700 });
    await writeFile(
      join(root, ".agencity", "workspace-id"),
      "workspace-observe-test-0001\n",
      { mode: 0o600 },
    );
  }
  return root;
}

function routeState(route: ObserverRoute): AgentState {
  const created: AgentEvent<"SessionCreated"> = {
    id: `created-${route.sessionId}`,
    sessionId: route.sessionId,
    branchId: route.branchId,
    causationId: null,
    correlationId: null,
    type: "SessionCreated",
    schemaVersion: EVENT_SCHEMA_VERSION,
    producer: "supervisor",
    idempotencyKey: `created-${route.sessionId}`,
    committedAt: "2026-08-21T00:00:00.000Z",
    cursor: "1",
    originDeviceId: "device",
    originSequence: 1,
    streamParentId: null,
    payload: {
      workspaceId: "workspace-observe-test-0001",
      initialBranchId: route.branchId,
      initialBranchName: "main",
      sessionName: `<script>${route.sessionId}`,
      model: { provider: "fixture", model: "fixture-v1", reasoningEffort: "provider-default" },
      budget: {},
      agentProfile: fixtureAgentProfile(route.sessionId),
    },
  };
  return reduceAgentState(undefined, created);
}

function fakeFactory(routes: readonly ObserverRoute[], counters: {
  connects: number;
  closes: number;
  streams: number;
}): ObserverSourceFactory {
  return {
    async connect(): Promise<{ readonly kind: "connected"; readonly source: ObserverSource }> {
      counters.connects += 1;
      const source: ObserverSource = {
        workspaceId: "workspace-observe-test-0001",
        instanceId: "instance-observe-test",
        applicationVersion: "test",
        async roots(): Promise<readonly ObserverRootRoute[]> {
          return routes.map((route, index) => ({
            route,
            name: `Root ${index + 1}`,
            status: "idle",
            worker: "idle",
            unresolvedWork: 0,
          }));
        },
        async loadRouteSnapshot(route): Promise<{ cursor: string; state: AgentState }> {
          const state = routeState(route);
          return { cursor: state.cursor, state };
        },
        async streamRoute(_route, _after, _handlers, signal): Promise<void> {
          counters.streams += 1;
          await new Promise<void>(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        close(): void {
          counters.closes += 1;
        },
      };
      return { kind: "connected", source };
    },
  };
}

function sameOriginHeaders(origin: string): HeadersInit {
  return {
    "Sec-Fetch-Site": "same-origin",
    Origin: origin,
  };
}

async function establish(
  server: Awaited<ReturnType<typeof startObserverServer>>,
): Promise<string> {
  const origin = `http://127.0.0.1:${server.port}`;
  const response = await fetch(`${origin}/api/session`, {
    method: "POST",
    headers: {
      ...sameOriginHeaders(origin),
      "X-Agencity-Observe-Bootstrap": server.bootstrapToken,
    },
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie")!;
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain("Path=/api");
  return setCookie.split(";", 1)[0]!;
}

describe("observer authenticated server", () => {
  test("serves hardened assets and a bounded authenticated snapshot without secrets or AgentState", async () => {
    const root = await workspace(true);
    const counters = { connects: 0, closes: 0, streams: 0 };
    const controller = new ObserverController({
      workspaceRoot: root,
      sourceFactory: fakeFactory([{ sessionId: "root", branchId: "main" }], counters),
    });
    await controller.start();
    const server = await startObserverServer({ controller, port: 0 });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const html = await fetch(`${origin}/`);
      expect(html.status).toBe(200);
      expect(html.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(html.headers.get("x-frame-options")).toBe("DENY");
      expect(html.headers.get("cache-control")).toBe("no-store, private");
      expect(html.headers.get("pragma")).toBe("no-cache");

      const crossSite = await fetch(`${origin}/api/bootstrap`);
      expect(crossSite.status).toBe(403);
      const bad = await fetch(`${origin}/api/session`, {
        method: "POST",
        headers: {
          ...sameOriginHeaders(origin),
          "X-Agencity-Observe-Bootstrap": "wrong",
        },
      });
      expect(bad.status).toBe(401);
      expect(await bad.text()).not.toContain(server.bootstrapToken);

      const cookie = await establish(server);
      const bootstrap = await fetch(`${origin}/api/bootstrap?rootsLimit=100`, {
        headers: { "Sec-Fetch-Site": "same-origin", Cookie: cookie },
      });
      expect(bootstrap.status).toBe(200);
      const text = await bootstrap.text();
      const bootstrapEnvelope = JSON.parse(text) as {
        readonly data: { readonly generation: string; readonly sequence: number };
      };
      expect(text).toContain(OBSERVER_PROTOCOL);
      expect(text).toContain("<script>");
      expect(text).not.toContain(server.bootstrapToken);
      expect(text).not.toContain("appliedEventIds");
      expect(text).not.toContain("bearerToken");
      expect(controller.attachmentCount).toBe(0);

      const unknown = await fetch(`${origin}/api/proxy`, {
        headers: { "Sec-Fetch-Site": "same-origin", Cookie: cookie },
      });
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get("access-control-allow-origin")).toBeNull();

      const stream = await fetch(
        `${origin}/api/family/stream?generation=${encodeURIComponent(bootstrapEnvelope.data.generation)}&after=${bootstrapEnvelope.data.sequence}`,
        { headers: { "Sec-Fetch-Site": "same-origin", Cookie: cookie } },
      );
      expect(stream.status).toBe(200);
      const reader = stream.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
      expect(controller.attachmentCount).toBe(1);
      await reader.cancel();
    } finally {
      await server.stop();
    }
    expect(controller.attachmentCount).toBe(0);
    expect(counters.connects).toBeGreaterThanOrEqual(1);
    expect(counters.closes).toBeGreaterThanOrEqual(counters.connects);
  });

  test("rejects hostile Host and cross-origin state changes", async () => {
    const root = await workspace(false);
    const controller = new ObserverController({
      workspaceRoot: root,
      sourceFactory: { async connect() { return { kind: "service_stopped", reason: "stopped" }; } },
    });
    await controller.start();
    const server = await startObserverServer({ controller, port: 0 });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const hostileHost = await fetch(`${origin}/`, { headers: { Host: "localhost:1" } });
      expect(hostileHost.status).toBe(400);
      const cookie = await establish(server);
      const rejected = await fetch(`${origin}/api/family/select`, {
        method: "POST",
        headers: {
          "Sec-Fetch-Site": "same-origin",
          Origin: "http://127.0.0.1:1",
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(rejected.status).toBe(403);
    } finally {
      await server.stop();
    }
  });

});

describe("observer shared family lifecycle", () => {
  test("auto-selects one root, aborts streams on detach, and rejects stale shared selection", async () => {
    const root = await workspace(true);
    const counters = { connects: 0, closes: 0, streams: 0 };
    const sole = new ObserverController({
      workspaceRoot: root,
      sourceFactory: fakeFactory([{ sessionId: "one", branchId: "main" }], counters),
    });
    await sole.start();
    const release = await sole.attach();
    expect(sole.snapshot().selectedRoot).toEqual({ sessionId: "one", branchId: "main" });
    expect(counters.streams).toBe(1);
    release();
    await Bun.sleep(0);
    expect(sole.attachmentCount).toBe(0);
    expect(counters.closes).toBe(1);
    await sole.stop();

    const multiple = new ObserverController({
      workspaceRoot: root,
      sourceFactory: fakeFactory([
        { sessionId: "one", branchId: "main" },
        { sessionId: "two", branchId: "main" },
      ], counters),
    });
    await multiple.start();
    const releaseMultiple = await multiple.attach();
    const generation = multiple.snapshot().generation;
    await multiple.selectRoot({ sessionId: "one", branchId: "main" }, generation);
    await expect(multiple.selectRoot(
      { sessionId: "two", branchId: "main" },
      generation,
    )).rejects.toBeInstanceOf(ObserverControllerError);
    releaseMultiple();
    const reattach = await multiple.attach();
    expect(multiple.snapshot().selectedRoot).toEqual({ sessionId: "one", branchId: "main" });
    reattach();
    await multiple.stop();
  });

  test("replaces the managed instance generation after passive manifest replacement", async () => {
    const root = await workspace(true);
    let connects = 0;
    let abortedStreams = 0;
    const route = { sessionId: "root", branchId: "main" };
    const factory: ObserverSourceFactory = {
      async connect() {
        connects += 1;
        const instanceId = `instance-${connects}`;
        const source: ObserverSource = {
          workspaceId: "workspace-observe-test-0001",
          instanceId,
          applicationVersion: "test",
          async roots() {
            return [{
              route,
              name: "Root",
              status: "idle",
              worker: "idle" as const,
              unresolvedWork: 0,
            }];
          },
          async loadRouteSnapshot() {
            const state = routeState(route);
            return { cursor: state.cursor, state };
          },
          async streamRoute(_route, _after, _handlers, signal) {
            await new Promise<void>(resolve => {
              signal.addEventListener("abort", () => {
                abortedStreams += 1;
                resolve();
              }, { once: true });
            });
          },
          close() {},
        };
        return { kind: "connected" as const, source };
      },
    };
    const controller = new ObserverController({
      workspaceRoot: root,
      sourceFactory: factory,
      passivePollIntervalMs: 10,
      rediscoveryMs: 10,
    });
    await controller.start();
    const release = await controller.attach();
    const initial = controller.snapshot();
    await mkdir(join(root, ".agencity", "service"), { mode: 0o700 });
    await writeFile(join(root, ".agencity", "service", "manifest.json"), "replacement", { mode: 0o600 });
    const deadline = Date.now() + 2_000;
    while (connects < 2 && Date.now() < deadline) await Bun.sleep(10);
    const replacement = controller.snapshot();
    expect(connects).toBeGreaterThanOrEqual(2);
    expect(replacement.managedInstanceId).not.toBe(initial.managedInstanceId);
    expect(replacement.generation).not.toBe(initial.generation);
    expect(abortedStreams).toBeGreaterThanOrEqual(1);
    release();
    await controller.stop();
  });

  test("loads a newly committed child route into the live family", async () => {
    const root = await workspace(true);
    const rootRoute = { sessionId: "root", branchId: "main" };
    const childRoute = { sessionId: "child", branchId: "main" };
    let currentRoot = routeState(rootRoute);
    const rootStream: { current: ObserverSourceStreamHandlers | null } = { current: null };
    const source: ObserverSource = {
      workspaceId: "workspace-observe-test-0001",
      instanceId: "instance-child-live",
      applicationVersion: "test",
      async roots() {
        return [{
          route: rootRoute,
          name: "Root",
          status: "running",
          worker: "running" as const,
          unresolvedWork: 1,
        }];
      },
      async loadRouteSnapshot(route) {
        const state = route.sessionId === "root" ? currentRoot : routeState(childRoute);
        return { cursor: state.cursor, state };
      },
      async streamRoute(route, _after, handlers, signal) {
        if (route.sessionId === "root") rootStream.current = handlers;
        await new Promise<void>(resolve => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      close() {},
    };
    const controller = new ObserverController({
      workspaceRoot: root,
      sourceFactory: { async connect() { return { kind: "connected", source }; } },
    });
    await controller.start();
    const release = await controller.attach();
    expect(controller.snapshot().family?.nodes).toHaveLength(1);
    const admitted: AgentEvent<"TaskCreated"> = {
      id: "task-created",
      sessionId: "root",
      branchId: "main",
      causationId: null,
      correlationId: null,
      type: "TaskCreated",
      schemaVersion: EVENT_SCHEMA_VERSION,
      producer: "supervisor",
      idempotencyKey: "task-created",
      committedAt: "2026-08-21T00:00:01.000Z",
      cursor: "2",
      originDeviceId: "device",
      originSequence: 2,
      streamParentId: "created-root",
      payload: {
        taskId: "task-child",
        parentSessionId: "root",
        parentBranchId: "main",
        childSessionId: "child",
        childBranchId: "main",
        task: "Inspect child work",
        model: { provider: "fixture", model: "fixture-v1", reasoningEffort: "provider-default" },
        budget: {},
      },
    };
    currentRoot = reduceAgentState(currentRoot, admitted);
    const handlers = rootStream.current;
    if (!handlers) throw new Error("root stream did not attach");
    await handlers.onEvent(admitted);
    const deadline = Date.now() + 2_000;
    while ((controller.snapshot().family?.nodes.length ?? 0) < 2 && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(controller.snapshot().family?.nodes.map(node => node.route.sessionId)).toEqual(["root", "child"]);
    release();
    await controller.stop();
  });
});

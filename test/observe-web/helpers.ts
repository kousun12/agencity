import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENT_SCHEMA_VERSION,
  reduceAgentState,
  type AgentEvent,
  type AgentState,
  type EventPayloads,
  type EventType,
} from "../../src/domain/index.ts";
import { createServiceManifest } from "../../src/product/service-discovery.ts";
import { fixtureAgentProfile } from "../helpers.ts";

export const OBSERVE_WEB_WORKSPACE_ID = "workspace-observe-web-0001";
export const ROOT_ALPHA = { sessionId: "root-alpha", branchId: "main" } as const;
export const ROOT_BETA = { sessionId: "root-beta", branchId: "main" } as const;
export const CHILD_ROUTE = { sessionId: "child-live", branchId: "main" } as const;
export const HOSTILE_DETAIL_TEXT =
  `<img src="https://observer-should-not-request.invalid/pixel" onerror="globalThis.__agencityHostile=true">` +
  `<script>globalThis.__agencityHostile=true</script>` +
  `<svg onload="globalThis.__agencityHostile=true"><a href="javascript:alert(1)">hostile</a></svg>`;

const encoder = new TextEncoder();

interface FixtureStream {
  readonly routeKey: string;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  readonly heartbeat: ReturnType<typeof setInterval>;
  closed: boolean;
}

function routeKey(sessionId: string, branchId: string): string {
  return `${sessionId}\u0000${branchId}`;
}

function sessionCreated(input: {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly parent?: typeof ROOT_ALPHA;
  readonly taskId?: string;
}): AgentEvent<"SessionCreated"> {
  return {
    id: `created-${input.sessionId}`,
    sessionId: input.sessionId,
    branchId: "main",
    causationId: null,
    correlationId: null,
    type: "SessionCreated",
    schemaVersion: EVENT_SCHEMA_VERSION,
    producer: "supervisor",
    idempotencyKey: `created-${input.sessionId}`,
    committedAt: "2026-08-21T00:00:00.000Z",
    cursor: "1",
    originDeviceId: "observe-web-fixture",
    originSequence: 1,
    streamParentId: null,
    payload: {
      workspaceId: OBSERVE_WEB_WORKSPACE_ID,
      initialBranchId: "main",
      initialBranchName: "main",
      sessionName: input.sessionName,
      model: {
        provider: "fixture",
        model: "fixture-v1",
        reasoningEffort: "provider-default",
      },
      budget: {},
      agentProfile: fixtureAgentProfile(input.sessionId),
      ...(input.parent === undefined
        ? {}
        : {
            parentSessionId: input.parent.sessionId,
            parentBranchId: input.parent.branchId,
            rootSessionId: input.parent.sessionId,
            depth: 1,
            taskId: input.taskId,
          }),
    },
  };
}

function nextEvent<T extends EventType>(
  state: AgentState,
  type: T,
  payload: EventPayloads[T],
  producer: AgentEvent<T>["producer"],
): AgentEvent<T> {
  const cursor = String(BigInt(state.cursor) + 1n);
  return {
    id: `${state.sessionId}-${cursor}-${type}`,
    sessionId: state.sessionId,
    branchId: state.branch.id,
    causationId: null,
    correlationId: null,
    type,
    schemaVersion: EVENT_SCHEMA_VERSION,
    producer,
    idempotencyKey: `observe-web:${state.sessionId}:${cursor}:${type}`,
    committedAt: `2026-08-21T00:00:${cursor.padStart(2, "0")}.000Z`,
    cursor,
    originDeviceId: "observe-web-fixture",
    originSequence: Number(cursor),
    streamParentId: state.appliedEventIds.at(-1) ?? null,
    payload,
  } as AgentEvent<T>;
}

function initialStates(): AgentState[] {
  let alpha = reduceAgentState(undefined, sessionCreated({
    sessionId: ROOT_ALPHA.sessionId,
    sessionName: "Root Alpha",
  }));
  const proposed = nextEvent(alpha, "CellProposed", {
    cellId: "hostile-cell",
    code: HOSTILE_DETAIL_TEXT,
    dependencies: [],
  }, "console");
  alpha = reduceAgentState(alpha, proposed);
  const started = nextEvent(alpha, "CellStarted", {
    cellId: "hostile-cell",
    attempt: 1,
  }, "console");
  alpha = reduceAgentState(alpha, started);
  const committed = nextEvent(alpha, "CellCommitted", {
    cellId: "hostile-cell",
    result: { renderedAs: "text", hostile: HOSTILE_DETAIL_TEXT },
    logs: [HOSTILE_DETAIL_TEXT],
    durationMs: 1,
    exports: [],
  }, "console");
  alpha = reduceAgentState(alpha, committed);

  const beta = reduceAgentState(undefined, sessionCreated({
    sessionId: ROOT_BETA.sessionId,
    sessionName: "Root Beta",
  }));
  const child = reduceAgentState(undefined, sessionCreated({
    sessionId: CHILD_ROUTE.sessionId,
    sessionName: "Live Child",
    parent: ROOT_ALPHA,
    taskId: "task-live-child",
  }));
  return [alpha, beta, child];
}

export class ObserveProtocolFixture {
  readonly bearerToken: string;
  readonly server: Bun.Server<unknown>;
  readonly #states = new Map<string, AgentState>();
  readonly #streams = new Set<FixtureStream>();
  totalStreams = 0;
  cancelledStreams = 0;

  constructor(
    readonly instanceId: string,
    states: readonly AgentState[] = initialStates(),
  ) {
    this.bearerToken = Buffer.alloc(32, instanceId === "instance-one" ? 11 : 12)
      .toString("base64url");
    for (const state of states) {
      this.#states.set(routeKey(state.sessionId, state.branch.id), state);
    }
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: request => this.#fetch(request),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  get activeStreams(): number {
    return this.#streams.size;
  }

  exportStates(): AgentState[] {
    return [...this.#states.values()];
  }

  admitChild(): AgentEvent<"TaskCreated"> {
    const state = this.#state(ROOT_ALPHA.sessionId, ROOT_ALPHA.branchId);
    const event = nextEvent(state, "TaskCreated", {
      taskId: "task-live-child",
      parentSessionId: ROOT_ALPHA.sessionId,
      parentBranchId: ROOT_ALPHA.branchId,
      childSessionId: CHILD_ROUTE.sessionId,
      childBranchId: CHILD_ROUTE.branchId,
      task: "Inspect live child work",
      model: {
        provider: "fixture",
        model: "fixture-v1",
        reasoningEffort: "provider-default",
      },
      budget: {},
    }, "supervisor");
    this.#commit(event);
    return event;
  }

  sendMailboxMessage(): AgentEvent<"MailboxMessageSent"> {
    const state = this.#state(ROOT_ALPHA.sessionId, ROOT_ALPHA.branchId);
    const event = nextEvent(state, "MailboxMessageSent", {
      mailboxMessageId: "message-live-child",
      fromSessionId: ROOT_ALPHA.sessionId,
      fromBranchId: ROOT_ALPHA.branchId,
      toSessionId: CHILD_ROUTE.sessionId,
      toBranchId: CHILD_ROUTE.branchId,
      kind: "message",
      content: "Live fixture mailbox update",
      taskId: "task-live-child",
      intentKey: "observe-web-live-message",
      mode: "queue",
    }, "client");
    this.#commit(event);
    return event;
  }

  stop(): void {
    for (const stream of [...this.#streams]) this.#closeStream(stream);
    this.server.stop(true);
  }

  #state(sessionId: string, branchId: string): AgentState {
    const state = this.#states.get(routeKey(sessionId, branchId));
    if (!state) throw new Error(`Fixture route is unavailable: ${sessionId}/${branchId}`);
    return state;
  }

  #commit(event: AgentEvent): void {
    const key = routeKey(event.sessionId, event.branchId);
    this.#states.set(key, reduceAgentState(this.#state(event.sessionId, event.branchId), event));
    const payload = encoder.encode(`event: committed\ndata: ${JSON.stringify(event)}\n\n`);
    for (const stream of [...this.#streams]) {
      if (stream.routeKey !== key || stream.closed) continue;
      try {
        stream.controller.enqueue(payload);
      } catch {
        this.#closeStream(stream);
      }
    }
  }

  #fetch(request: Request): Response {
    if (request.headers.get("authorization") !== `Bearer ${this.bearerToken}`) {
      return Response.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        authenticated: true,
        ready: true,
        workspaceId: OBSERVE_WEB_WORKSPACE_ID,
        instanceId: this.instanceId,
        appVersion: "observe-web-fixture",
        protocolMin: 4,
        protocolMax: 4,
      });
    }
    if (url.pathname === "/capabilities") {
      return Response.json({
        protocol: "agencity.protocol",
        version: 1,
        mode: "trusted-local",
        trustedLocal: true,
        hostileCodeSandbox: false,
        managedService: true,
        productCatalog: true,
        snapshotCursorResume: true,
        committedEventDeduplication: true,
        cursorlessProgress: true,
        historicalProjection: false,
        sync: {},
        providers: [],
        agentTools: {},
      });
    }
    if (url.pathname === "/service/agents") {
      return Response.json([
        {
          ...ROOT_ALPHA,
          name: "Root Alpha",
          status: "running",
          worker: "running",
          unresolvedWork: 1,
        },
        {
          ...ROOT_BETA,
          name: "Root Beta",
          status: "idle",
          worker: "idle",
          unresolvedWork: 0,
        },
      ]);
    }
    const match = url.pathname.match(/^\/sessions\/([^/]+)\/(snapshot|stream)$/);
    if (!match) {
      return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
    }
    const sessionId = decodeURIComponent(match[1]!);
    const branchId = url.searchParams.get("branch") ?? "";
    const state = this.#states.get(routeKey(sessionId, branchId));
    if (!state) {
      return Response.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, { status: 404 });
    }
    if (match[2] === "snapshot") {
      return Response.json({ cursor: state.cursor, state });
    }
    return this.#streamResponse(request, routeKey(sessionId, branchId));
  }

  #streamResponse(request: Request, key: string): Response {
    let close = (): void => {};
    const body = new ReadableStream<Uint8Array>({
      start: controller => {
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": fixture-heartbeat\n\n"));
          } catch {
            close();
          }
        }, 1_000);
        const stream: FixtureStream = {
          routeKey: key,
          controller,
          heartbeat,
          closed: false,
        };
        close = () => this.#closeStream(stream);
        this.#streams.add(stream);
        this.totalStreams += 1;
        controller.enqueue(encoder.encode(": connected\n\n"));
        request.signal.addEventListener("abort", close, { once: true });
      },
      cancel: () => close(),
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  #closeStream(stream: FixtureStream): void {
    if (stream.closed) return;
    stream.closed = true;
    clearInterval(stream.heartbeat);
    this.#streams.delete(stream);
    this.cancelledStreams += 1;
    try {
      stream.controller.close();
    } catch {}
  }
}

export async function freshObserveWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agencity-observe-web-"));
  const initialized = Bun.spawn(["git", "init", "--quiet", root], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const gitError = new Response(initialized.stderr).text();
  if (await initialized.exited !== 0) {
    throw new Error(`Could not initialize fixture repository: ${await gitError}`);
  }
  await mkdir(join(root, ".agencity", "service"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, ".agencity", "workspace-id"),
    `${OBSERVE_WEB_WORKSPACE_ID}\n`,
    { mode: 0o600 },
  );
  return root;
}

export async function publishFixtureManifest(
  workspaceRoot: string,
  fixture: ObserveProtocolFixture,
): Promise<void> {
  const manifest = createServiceManifest({
    workspaceId: OBSERVE_WEB_WORKSPACE_ID,
    deviceId: "device-observe-web",
    instanceId: fixture.instanceId,
    url: fixture.url,
    appVersion: "observe-web-fixture",
    protocolMin: 4,
    protocolMax: 4,
    configHash: "a".repeat(64),
    randomToken: () => Buffer.from(fixture.bearerToken, "base64url"),
  });
  const directory = join(workspaceRoot, ".agencity", "service");
  const path = join(directory, "manifest.json");
  const temporary = join(directory, `.manifest-${fixture.instanceId}-${process.pid}.json`);
  await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600 });
  await rename(temporary, path);
}

import { describe, expect, test } from "bun:test";
import {
  EVENT_SCHEMA_VERSION,
  reduceAgentState,
  type AgentEvent,
  type AgentRunState,
  type AgentState,
  type CellState,
  type MailboxMessageState,
  type TaskState,
} from "../../src/domain/index.ts";
import {
  OBSERVER_BOUNDS,
  aggregateObserverMailbox,
  applyObserverCommittedEvent,
  boundText,
  createObserverGeneration,
  deriveObserverDetailPage,
  deriveObserverFamilyOverview,
  deriveObserverRouteStatus,
  discoverObserverFamily,
  observerRouteKey,
  recordObserverProgress,
  replayObserverEnvelopes,
  serializedUtf8Bytes,
  utf8Bytes,
  type InternalObserverFamily,
  type InternalObserverRouteSnapshot,
  type ObserverRoute,
  type ObserverSnapshotSource,
} from "../../src/observe/index.ts";
import { fixtureAgentProfile } from "../helpers.ts";

const model = {
  provider: "fixture",
  model: "fixture-v1",
  reasoningEffort: "provider-default" as const,
};

function state(
  sessionId: string,
  branchId: string,
  overrides: Partial<AgentState> = {},
): AgentState {
  const created: AgentEvent<"SessionCreated"> = {
    id: `created-${sessionId}`,
    sessionId,
    branchId,
    causationId: null,
    correlationId: null,
    type: "SessionCreated",
    schemaVersion: EVENT_SCHEMA_VERSION,
    producer: "supervisor",
    idempotencyKey: `created-${sessionId}`,
    committedAt: "2026-08-20T00:00:00.000Z",
    cursor: "1",
    originDeviceId: "device",
    originSequence: 1,
    streamParentId: null,
    payload: {
      workspaceId: "workspace",
      initialBranchId: branchId,
      initialBranchName: "main",
      model,
      budget: {},
      agentProfile: fixtureAgentProfile(sessionId),
    },
  };
  return { ...reduceAgentState(undefined, created), ...overrides };
}

function task(
  id: string,
  parent: ObserverRoute,
  child: ObserverRoute,
  overrides: Partial<TaskState> = {},
): TaskState {
  return {
    id,
    parentSessionId: parent.sessionId,
    parentBranchId: parent.branchId,
    childSessionId: child.sessionId,
    childBranchId: child.branchId,
    task: `Task ${id}`,
    completionCriteria: null,
    model,
    budget: {},
    status: "admitted",
    cancellationRequested: false,
    artifactIds: [],
    eventId: `event-${id}`,
    ...overrides,
  };
}

function mailbox(
  id: string,
  from: ObserverRoute,
  to: ObserverRoute,
  overrides: Partial<MailboxMessageState> = {},
): MailboxMessageState {
  return {
    id,
    fromSessionId: from.sessionId,
    fromBranchId: from.branchId,
    toSessionId: to.sessionId,
    toBranchId: to.branchId,
    kind: "message",
    content: "hello",
    taskId: null,
    artifactIds: [],
    direction: "outbound",
    intentKey: null,
    mode: "queue",
    replyToMessageId: null,
    senderRelationship: null,
    receiptStatus: "queued",
    delivered: false,
    deliveredToContext: false,
    acknowledged: false,
    contextRunId: null,
    error: null,
    eventId: `mail-${id}-sent`,
    ...overrides,
  };
}

function routeSnapshot(route: ObserverRoute, value: AgentState): InternalObserverRouteSnapshot {
  return {
    route,
    state: value,
    cursor: value.cursor,
    availability: "available",
    unavailableReason: null,
  };
}

describe("observer bounds", () => {
  test("caps UTF-8 text without splitting code points", () => {
    const prefix = boundText("😀😀😀", { maximumBytes: 5 });
    expect(prefix.kind).toBe("prefix");
    if (prefix.kind !== "prefix") throw new Error("expected prefix");
    expect(prefix.prefix).toBe("😀");
    expect(prefix.visibleUtf8Bytes).toBe(4);
    expect(prefix.originalUtf8Bytes).toBe(12);

    const headTail = boundText("😀alpha😀omega😀", { maximumBytes: 12, mode: "head_tail" });
    expect(headTail.kind).toBe("head_tail");
    expect(headTail.visibleUtf8Bytes).toBeLessThanOrEqual(12);
    if (headTail.kind === "head_tail") {
      expect(utf8Bytes(headTail.head) + utf8Bytes(headTail.tail)).toBe(headTail.visibleUtf8Bytes);
    }
  });

  test("paginates detail items and stays inside item and byte caps", () => {
    const route = { sessionId: "root", branchId: "main" };
    const cells: Record<string, CellState> = {};
    const appliedEventIds = ["created-root"];
    for (let index = 0; index < 60; index += 1) {
      const id = `cell-${index.toString().padStart(2, "0")}`;
      const eventId = `cell-event-${index}`;
      appliedEventIds.push(eventId);
      cells[id] = {
        id,
        code: "😀".repeat(20_000),
        status: "committed",
        attempts: 1,
        logs: ["x".repeat(20_000)],
        logStreams: ["stdout"],
        result: { ok: true },
        eventId,
      };
    }
    const value = state("root", "main", { cells, appliedEventIds });
    const first = deriveObserverDetailPage(routeSnapshot(route, value), "cells", { limit: 50 });
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThanOrEqual(50);
    expect(first.pagination.nextCursor).not.toBeNull();
    expect(serializedUtf8Bytes(first)).toBeLessThanOrEqual(OBSERVER_BOUNDS.detailPageBytes);
    expect(first.items[0]!.provenance.exactEventCursor).toBeNull();
    const second = deriveObserverDetailPage(routeSnapshot(route, value), "cells", {
      limit: 50,
      cursor: first.pagination.nextCursor,
    });
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    const exact = deriveObserverDetailPage(routeSnapshot(route, value), "cells", {
      itemId: "cell-17",
    });
    expect(exact.items.map(item => item.id)).toEqual(["cell-17"]);
  });

  test("advances past a single detail item that exceeds the page byte bound", () => {
    const route = { sessionId: "root", branchId: "main" };
    const oversizedTask = task("oversized", route, { sessionId: "child", branchId: "main" }, {
      artifactIds: Array.from({ length: 40_000 }, (_, index) => `artifact-${index}`),
    });
    const value = state("root", "main", {
      tasks: { [oversizedTask.id]: oversizedTask },
      appliedEventIds: ["created-root", oversizedTask.eventId],
    });
    const page = deriveObserverDetailPage(routeSnapshot(route, value), "tasks");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.data).toMatchObject({
      omitted: true,
      reason: "item_exceeded_page_byte_limit",
    });
    expect(page.pagination.nextCursor).toBeNull();
    expect(page.truncation.byteLimit).toBe(true);
    expect(serializedUtf8Bytes(page)).toBeLessThanOrEqual(OBSERVER_BOUNDS.detailPageBytes);
  });

  test("returns the latest conversation page in chronological order and pages backward", () => {
    const route = { sessionId: "root", branchId: "main" };
    const messages = Array.from({ length: 8 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `Message ${index}`,
      eventId: `message-event-${index}`,
      eventCursor: String(index + 2),
      schemaVersion: EVENT_SCHEMA_VERSION,
      modelCallId: index % 2 === 0 ? null : `call-${index}`,
    }));
    const value = state("root", "main", {
      messages,
      appliedEventIds: ["created-root", ...messages.map(message => message.eventId)],
    });
    const snapshot = routeSnapshot(route, value);

    const latest = deriveObserverDetailPage(snapshot, "conversation", { limit: 3 });
    expect(latest.items.map(item => item.id)).toEqual([
      "message:message-5",
      "message:message-6",
      "message:message-7",
    ]);
    expect(latest.items.map(item => item.data.content)).toEqual([
      expect.objectContaining({ text: "Message 5" }),
      expect.objectContaining({ text: "Message 6" }),
      expect.objectContaining({ text: "Message 7" }),
    ]);
    expect(latest.items[0]?.provenance.exactEventCursor).toBe("7");
    expect(latest.pagination.nextCursor).not.toBeNull();

    const earlier = deriveObserverDetailPage(snapshot, "conversation", {
      limit: 3,
      cursor: latest.pagination.nextCursor,
    });
    expect(earlier.items.map(item => item.id)).toEqual([
      "message:message-2",
      "message:message-3",
      "message:message-4",
    ]);
    expect(serializedUtf8Bytes(latest)).toBeLessThanOrEqual(OBSERVER_BOUNDS.detailPageBytes);
  });

  test("interleaves model actions with messages and includes bounded cell effects", () => {
    const route = { sessionId: "root", branchId: "main" };
    const profile = fixtureAgentProfile("root");
    const value = state("root", "main", {
      messages: [{
        id: "user-message",
        role: "user",
        content: "Inspect the repository",
        eventId: "user-message-event",
        eventCursor: "2",
        schemaVersion: EVENT_SCHEMA_VERSION,
        modelCallId: null,
      }, {
        id: "assistant-message",
        role: "assistant",
        content: "Inspection complete",
        eventId: "assistant-message-event",
        eventCursor: "6",
        schemaVersion: EVENT_SCHEMA_VERSION,
        modelCallId: "call",
      }],
      agentRuns: {
        run: {
          id: "run",
          task: "Inspect the repository",
          requestKey: "request",
          profilePin: {
            profileVersionId: profile.profileVersionId,
            agentPromptDigest: profile.promptDigest,
            promptContractId: profile.promptContractId,
          },
          goalId: null,
          goalMode: "none",
          wakeId: null,
          status: "succeeded",
          steps: [{
            id: "step",
            ordinal: 1,
            contextId: "context",
            callId: "call",
            effectId: "model-effect",
            actionId: "action",
            observationEventIds: [],
            modelAttempts: [],
            action: {
              protocol: "agencity.agent-action",
              version: 1,
              type: "typescript",
              code: "const result = await sdk.shell.run('pwd');",
            },
            eventId: "action-event",
          }],
          goalChecks: {},
          cancellationRequested: false,
          requestEventId: "run-request-event",
          eventId: "run-event",
        },
      },
      cells: {
        "agent-run-cell-action": {
          id: "agent-run-cell-action",
          code: "const result = await sdk.shell.run('pwd');",
          status: "committed",
          attempts: 1,
          result: { cwd: "/workspace" },
          logs: ["done"],
          logStreams: ["stdout"],
          eventId: "cell-event",
        },
      },
      effects: {
        "shell-effect": {
          id: "shell-effect",
          executor: "shell",
          operation: "run",
          input: { command: "pwd" },
          origin: { kind: "cell", cellId: "agent-run-cell-action" },
          idempotencyKey: "shell-effect",
          idempotent: true,
          attempts: 1,
          status: "succeeded",
          output: { stdout: "/workspace" },
          eventId: "shell-effect-event",
        },
      },
      appliedEventIds: [
        "created-root",
        "user-message-event",
        "run-request-event",
        "action-event",
        "cell-event",
        "shell-effect-event",
        "assistant-message-event",
        "run-event",
      ],
    });

    const page = deriveObserverDetailPage(routeSnapshot(route, value), "conversation");
    expect(page.items.map(item => item.id)).toEqual([
      "message:user-message",
      "action:run:step",
      "message:assistant-message",
    ]);
    expect(page.items[1]?.data).toMatchObject({
      entryType: "action",
      tool: "bun_console",
      actionType: "typescript",
      status: "committed",
      cell: {
        id: "agent-run-cell-action",
        status: "committed",
      },
      effects: [{
        id: "shell-effect",
        executor: "shell",
        operation: "run",
        status: "succeeded",
      }],
    });
  });
});

describe("observer family discovery", () => {
  test("loads breadth-first with bounded concurrency and truthful placeholders", async () => {
    const root = { sessionId: "root", branchId: "main" };
    const childRoutes = Array.from({ length: 10 }, (_, index) => ({
      sessionId: `child-${index}`,
      branchId: "main",
    }));
    const rootTasks = Object.fromEntries(
      childRoutes.map((child, index) => {
        const value = task(`task-${index}`, root, child);
        return [value.id, value];
      }),
    );
    const states = new Map<string, AgentState>([
      [observerRouteKey(root), state("root", "main", {
        tasks: rootTasks,
        appliedEventIds: ["created-root", ...Object.values(rootTasks).map((value) => value.eventId)],
      })],
      ...childRoutes.map((route) => [
        observerRouteKey(route),
        state(route.sessionId, route.branchId),
      ] as const),
    ]);
    let active = 0;
    let maximumActive = 0;
    const source: ObserverSnapshotSource = {
      async loadRouteSnapshot(route) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep(2);
        active -= 1;
        if (route.sessionId === "child-2") throw new Error("unavailable");
        const value = states.get(observerRouteKey(route));
        if (!value) throw new Error("missing");
        return { cursor: value.cursor, state: value };
      },
    };
    const family = await discoverObserverFamily(root, source, {
      maximumRoutes: 8,
      maximumConcurrency: 4,
    });
    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(family.routes.size).toBe(8);
    expect(family.truncated).toBe(true);
    expect(family.routes.get(observerRouteKey(childRoutes[2]!))?.availability).toBe("route_unavailable");
    expect(family.routes.get(observerRouteKey(childRoutes[2]!))?.unavailableReason).toBe("snapshot_unavailable");
  });

  test("stops at 64 routes without inventing an omitted-route count", async () => {
    const root = { sessionId: "root", branchId: "main" };
    const children = Array.from({ length: 70 }, (_, index) => ({
      sessionId: `child-${index.toString().padStart(2, "0")}`,
      branchId: "main",
    }));
    const tasks = Object.fromEntries(children.map((child, index) => {
      const value = task(`task-${index}`, root, child);
      return [value.id, value];
    }));
    const source: ObserverSnapshotSource = {
      async loadRouteSnapshot(route) {
        const value = route.sessionId === "root"
          ? state("root", "main", {
              tasks,
              appliedEventIds: ["created-root", ...Object.values(tasks).map(value => value.eventId)],
            })
          : state(route.sessionId, route.branchId);
        return { cursor: value.cursor, state: value };
      },
    };

    const family = await discoverObserverFamily(root, source);
    expect(family.routes.size).toBe(OBSERVER_BOUNDS.familyRoutes);
    expect(family.truncated).toBe(true);
    const overview = deriveObserverFamilyOverview(family);
    expect(overview.nodes).toHaveLength(OBSERVER_BOUNDS.familyRoutes);
    expect(overview.truncation).toMatchObject({
      familyRoutes: true,
      exactOmittedRouteCount: null,
    });
  });
});

describe("observer projections", () => {
  test("aggregates one exact-route mailbox lifecycle and filters sibling traffic", () => {
    const root = { sessionId: "root", branchId: "main" };
    const child = { sessionId: "child", branchId: "main" };
    const siblingBranch = { sessionId: "root", branchId: "other" };
    const rootState = state("root", "main", {
      mailbox: {
        message: mailbox("message", root, child),
        stray: mailbox("stray", siblingBranch, child),
      },
    });
    const childState = state("child", "main", {
      mailbox: {
        message: mailbox("message", root, child, {
          direction: "inbound",
          delivered: true,
          deliveredToContext: true,
          acknowledged: true,
          receiptStatus: "acknowledged",
          eventId: "mail-message-ack",
        }),
      },
    });
    const family: InternalObserverFamily = {
      root,
      routes: new Map([
        [observerRouteKey(root), routeSnapshot(root, rootState)],
        [observerRouteKey(child), routeSnapshot(child, childState)],
      ]),
      edges: [],
      truncated: false,
      edgesTruncated: false,
    };
    expect(aggregateObserverMailbox(family)).toEqual([{
      mailboxMessageId: "message",
      from: root,
      to: child,
      taskId: null,
      kind: "message",
      lifecycle: "acknowledged",
      stages: ["sent", "delivered", "delivered_to_context", "acknowledged"],
      conflict: false,
      itemEventIds: ["mail-message-sent", "mail-message-ack"],
      itemEventIdsTruncated: false,
      omittedItemEventIdCount: 0,
    }]);
    const detail = deriveObserverDetailPage(routeSnapshot(root, rootState), "mailbox");
    expect(detail.items.map((value) => value.id)).toEqual(["message"]);
  });

  test("retains failed mailbox provenance and reports conflicting copies", () => {
    const root = { sessionId: "root", branchId: "main" };
    const child = { sessionId: "child", branchId: "main" };
    const unrelated = { sessionId: "other", branchId: "main" };
    const rootState = state("root", "main", {
      mailbox: {
        failed: mailbox("failed", root, child),
        unrelated: mailbox("unrelated", unrelated, child),
      },
    });
    const childState = state("child", "main", {
      mailbox: {
        failed: mailbox("failed", root, child, {
          direction: "inbound",
          content: "conflicting retained copy",
          delivered: true,
          receiptStatus: "failed",
          error: "delivery failed",
          eventId: "mail-failed-outcome",
        }),
      },
    });
    const family: InternalObserverFamily = {
      root,
      routes: new Map([
        [observerRouteKey(root), routeSnapshot(root, rootState)],
        [observerRouteKey(child), routeSnapshot(child, childState)],
      ]),
      edges: [],
      truncated: false,
      edgesTruncated: false,
    };

    expect(aggregateObserverMailbox(family)).toEqual([{
      mailboxMessageId: "failed",
      from: root,
      to: child,
      taskId: null,
      kind: "message",
      lifecycle: "failed",
      stages: ["sent", "delivered", "failed"],
      conflict: true,
      itemEventIds: ["mail-failed-sent", "mail-failed-outcome"],
      itemEventIdsTruncated: false,
      omittedItemEventIdCount: 0,
    }]);
  });

  test("derives bounded overview and explicit attention states", () => {
    const root = { sessionId: "root", branchId: "main" };
    const value = state("root", "main", {
      sessionName: "Repair checkout retries",
      sessionTitle: {
        mode: "automatic",
        latestRequestedSourceMessageCursor: "7",
        appliedSourceMessageCursor: "7",
        requests: {},
        resolutions: {
          title: {
            requestId: "title",
            sourceMessageEventId: "message-7",
            sourceMessageCursor: "7",
            sourceMessageEventIds: ["message-7"],
            sourceBranchId: "main",
            method: "model",
            title: "Repair checkout retries",
            verb: "Repair",
            subject: "checkout retries",
            intentSummary: "Repair checkout retries without changing successful payment behavior.",
            eventId: "title-event",
          },
        },
      },
      budget: { limits: {}, tokens: 1, costUsd: 0, turns: 1, wallTimeMs: 0, exceeded: true },
    });
    expect(deriveObserverRouteStatus(value)).toEqual({
      activity: "attention",
      activityReason: "budget_exceeded",
    });
    expect(deriveObserverRouteStatus(null)).toEqual({
      activity: "unavailable",
      activityReason: "missing_state",
    });
    const profile = fixtureAgentProfile("root");
    const run = (status: AgentRunState["status"]): AgentRunState => ({
      id: "run",
      task: "work",
      requestKey: "request",
      profilePin: {
        profileVersionId: profile.profileVersionId,
        agentPromptDigest: profile.promptDigest,
        promptContractId: profile.promptContractId,
      },
      goalId: null,
      goalMode: "none",
      wakeId: null,
      status,
      steps: [],
      goalChecks: {},
      cancellationRequested: false,
      requestEventId: "run-request",
      eventId: "run-event",
    });
    expect(deriveObserverRouteStatus(state("root", "main", {
      agentRuns: { run: run("blocked") },
      appliedEventIds: ["created-root", "run-event"],
    }))).toEqual({ activity: "attention", activityReason: "blocked" });
    expect(deriveObserverRouteStatus(state("root", "main", {
      agentRuns: { run: run("running") },
      appliedEventIds: ["created-root", "run-event"],
    }))).toEqual({ activity: "working", activityReason: null });
    const overview = deriveObserverFamilyOverview({
      root,
      routes: new Map([[observerRouteKey(root), routeSnapshot(root, value)]]),
      edges: [],
      truncated: false,
      edgesTruncated: false,
    });
    expect(overview.nodes[0]?.activityReason).toBe("budget_exceeded");
    expect(overview.nodes[0]?.sessionTitle).toMatchObject({
      source: "model",
      sourceMessageCursor: "7",
      text: { kind: "complete", text: "Repair checkout retries" },
      intentSummary: {
        kind: "complete",
        text: "Repair checkout retries without changing successful payment behavior.",
      },
    });
    expect(overview.nodes[0]?.taskSummary).toMatchObject({
      text: "Repair checkout retries without changing successful payment behavior.",
    });
    expect(deriveObserverDetailPage(
      routeSnapshot(root, value),
      "identity",
    ).items[0]?.data.sessionTitle).toMatchObject({
      source: "model",
      sourceMessageCursor: "7",
    });
    expect(serializedUtf8Bytes(overview)).toBeLessThanOrEqual(OBSERVER_BOUNDS.familySnapshotBytes);

    const active = state("root", "main", {
      agentRuns: { run: run("running") },
      appliedEventIds: ["created-root", "run-event"],
      budget: { limits: {}, tokens: 1_250, costUsd: 0.12, turns: 3, wallTimeMs: 4_000, exceeded: false },
    });
    const activeOverview = deriveObserverFamilyOverview({
      root,
      routes: new Map([[observerRouteKey(root), routeSnapshot(root, active)]]),
      edges: [],
      truncated: false,
      edgesTruncated: false,
    });
    expect(activeOverview.nodes[0]?.latestRun).toMatchObject({
      id: "run",
      status: "running",
      stepCount: 0,
      currentAction: "awaiting_model",
    });
    expect(activeOverview.nodes[0]?.budget).toMatchObject({
      tokens: 1_250,
      turns: 3,
      wallTimeMs: 4_000,
      exceeded: false,
    });

    const terminal = state("root", "main", {
      agentRuns: {
        run: {
          ...run("succeeded"),
          steps: [{
            id: "step",
            ordinal: 1,
            contextId: "context",
            callId: "call",
            effectId: "effect",
            actionId: "action",
            observationEventIds: [],
            modelAttempts: [],
            action: {
              protocol: "agencity.agent-action",
              version: 1,
              type: "final",
              content: "done",
            },
            eventId: "step-event",
          }],
        },
      },
      appliedEventIds: ["created-root", "run-event"],
    });
    const terminalOverview = deriveObserverFamilyOverview({
      root,
      routes: new Map([[observerRouteKey(root), routeSnapshot(root, terminal)]]),
      edges: [],
      truncated: false,
      edgesTruncated: false,
    });
    expect(terminalOverview.nodes[0]?.latestRun?.currentAction).toBeNull();
  });

  test("derives fallback titles from durable user messages", () => {
    const root = { sessionId: "root", branchId: "main" };
    const value = state("root", "main", {
      messages: [
        {
          id: "message-1",
          role: "user",
          content: "Inspect the initial state",
          eventId: "message-event-1",
          eventCursor: "2",
          schemaVersion: EVENT_SCHEMA_VERSION,
          modelCallId: null,
          producer: "client",
          idempotencyKey: "message-1",
        },
        {
          id: "message-2",
          role: "user",
          content: "Repair the latest state",
          eventId: "message-event-2",
          eventCursor: "3",
          schemaVersion: EVENT_SCHEMA_VERSION,
          modelCallId: null,
          producer: "client",
          idempotencyKey: "message-2",
        },
      ],
      appliedEventIds: ["created-root", "message-event-1", "message-event-2"],
    });
    const snapshot = routeSnapshot(root, value);
    const overview = deriveObserverFamilyOverview({
      root,
      routes: new Map([[observerRouteKey(root), snapshot]]),
      edges: [],
      truncated: false,
      edgesTruncated: false,
    });

    expect(overview.nodes[0]?.sessionTitle).toMatchObject({
      source: "deterministic_fallback",
      text: { kind: "complete", text: "Repair the latest state" },
      intentSummary: { kind: "complete", text: "Repair the latest state" },
    });
    expect(deriveObserverDetailPage(snapshot, "identity").items[0]?.data.sessionTitle)
      .toMatchObject({
        source: "deterministic_fallback",
        text: { kind: "complete", text: "Repair the latest state" },
      });
  });

  test("distinguishes working, idle, attention, ended, and unavailable activity", () => {
    expect(deriveObserverRouteStatus(state("idle", "main"))).toEqual({
      activity: "idle",
      activityReason: null,
    });
    expect(deriveObserverRouteStatus(state("working", "main", { status: "running" }))).toEqual({
      activity: "working",
      activityReason: null,
    });
    expect(deriveObserverRouteStatus(state("attention", "main", {
      budget: { limits: {}, tokens: 0, costUsd: 0, turns: 0, wallTimeMs: 0, exceeded: true },
    }))).toEqual({
      activity: "attention",
      activityReason: "budget_exceeded",
    });
    expect(deriveObserverRouteStatus(state("ended", "main", { status: "archived" }))).toEqual({
      activity: "ended",
      activityReason: "archived",
    });
    expect(deriveObserverRouteStatus(null)).toEqual({
      activity: "unavailable",
      activityReason: "missing_state",
    });
  });

  test("keeps raw content out of overview and bounds every lazy inspector section", () => {
    const route = { sessionId: "root", branchId: "main" };
    const rawCode = "RAW_CODE_SENTINEL";
    const rawEffect = "RAW_EFFECT_SENTINEL";
    const rawMessage = `${"message-content ".repeat(40)}RAW_MESSAGE_SENTINEL`;
    const rawArtifactBytes = "RAW_ARTIFACT_BYTES_SENTINEL";
    const value = state("root", "main", {
      messages: [{
        id: "message",
        role: "user",
        content: rawMessage,
        eventId: "message-event",
        eventCursor: "2",
        schemaVersion: EVENT_SCHEMA_VERSION,
        modelCallId: null,
      }],
      cells: {
        cell: {
          id: "cell",
          code: rawCode,
          status: "committed",
          attempts: 1,
          logs: ["RAW_LOG_SENTINEL"],
          logStreams: ["stdout"],
          result: null,
          eventId: "cell-event",
        },
      },
      effects: {
        effect: {
          id: "effect",
          executor: "shell",
          operation: "run",
          input: { secret: rawEffect },
          origin: { kind: "runtime", requestId: "request" },
          idempotencyKey: "effect",
          idempotent: true,
          attempts: 1,
          status: "succeeded",
          output: { hidden: rawArtifactBytes },
          eventId: "effect-event",
        },
      },
      mailbox: {
        mailbox: mailbox("mailbox", route, route, { content: rawMessage }),
      },
      artifacts: {
        artifact: {
          artifactId: "artifact",
          digest: "a".repeat(64),
          mediaType: "application/octet-stream",
          size: rawArtifactBytes.length,
        },
      },
      appliedEventIds: [
        "created-root",
        "message-event",
        "cell-event",
        "effect-event",
        "mail-mailbox-sent",
      ],
    });
    const snapshot = routeSnapshot(route, value);
    const family: InternalObserverFamily = {
      root: route,
      routes: new Map([[observerRouteKey(route), snapshot]]),
      edges: [],
      truncated: false,
      edgesTruncated: false,
    };
    const overviewText = JSON.stringify(deriveObserverFamilyOverview(family));
    for (const sentinel of [rawCode, rawEffect, rawMessage, rawArtifactBytes, "RAW_LOG_SENTINEL"]) {
      expect(overviewText).not.toContain(sentinel);
    }

    const sections = [
      "conversation", "identity", "runs", "model_attempts", "cells", "effects", "tasks",
      "mailbox", "budget", "goals", "gates", "artifacts", "terminal_outcomes",
    ] as const;
    for (const section of sections) {
      const page = deriveObserverDetailPage(snapshot, section);
      expect(page.items.length).toBeLessThanOrEqual(OBSERVER_BOUNDS.detailItems);
      expect(serializedUtf8Bytes(page)).toBeLessThanOrEqual(OBSERVER_BOUNDS.detailPageBytes);
    }
    const artifacts = deriveObserverDetailPage(snapshot, "artifacts");
    expect(artifacts.items[0]?.data).toEqual({
      digest: "a".repeat(64),
      mediaType: expect.any(Object),
      size: rawArtifactBytes.length,
      bytesAvailable: false,
    });
    expect(JSON.stringify(artifacts)).not.toContain(rawArtifactBytes);
  });
});

describe("observer generations", () => {
  const route = { sessionId: "root", branchId: "main" };

  function statusEvent(id: string, cursor: string): AgentEvent<"SessionStatusChanged"> {
    return {
      id,
      sessionId: route.sessionId,
      branchId: route.branchId,
      causationId: null,
      correlationId: null,
      type: "SessionStatusChanged",
      schemaVersion: EVENT_SCHEMA_VERSION,
      producer: "supervisor",
      idempotencyKey: id,
      committedAt: "2026-08-20T00:00:01.000Z",
      cursor,
      originDeviceId: "device",
      originSequence: Number(cursor),
      streamParentId: "created-root",
      payload: { status: "running" },
    };
  }

  test("rejects stale generations and deduplicates committed events", () => {
    const value = state("root", "main");
    const initial = createObserverGeneration({
      generation: "generation-1",
      managedInstanceId: "instance-1",
      routes: [{ route, state: value, cursor: value.cursor }],
    });
    const stale = applyObserverCommittedEvent(initial, {
      generation: "old",
      managedInstanceId: "instance-1",
      route,
      event: statusEvent("status-2", "2"),
    });
    expect(stale.kind).toBe("stale_generation");
    expect(stale.state).toBe(initial);
    const staleInstance = applyObserverCommittedEvent(initial, {
      generation: "generation-1",
      managedInstanceId: "old-instance",
      route,
      event: statusEvent("status-2", "2"),
    });
    expect(staleInstance.kind).toBe("stale_generation");
    expect(staleInstance.state).toBe(initial);

    const applied = applyObserverCommittedEvent(initial, {
      generation: "generation-1",
      managedInstanceId: "instance-1",
      route,
      event: statusEvent("status-2", "2"),
    });
    expect(applied.kind).toBe("applied");
    const duplicate = applyObserverCommittedEvent(applied.state, {
      generation: "generation-1",
      managedInstanceId: "instance-1",
      route,
      event: statusEvent("status-2", "2"),
    });
    expect(duplicate.kind).toBe("ignored_duplicate");
    expect(duplicate.state.sequence).toBe(1);
    const old = applyObserverCommittedEvent(applied.state, {
      generation: "generation-1",
      managedInstanceId: "instance-1",
      route,
      event: statusEvent("different", "1"),
    });
    expect(old.kind).toBe("ignored_old_cursor");
  });

  test("applies session-wide profile events delivered to another watched branch", () => {
    const value = state("root", "main");
    const current = value.agentProfiles[value.activeAgentProfileVersionId]!;
    const nextProfile = {
      ...current,
      profileVersionId: "profile-v2",
      revision: current.revision + 1,
      instructions: "- Updated session-wide behavior.",
      promptDigest: "b".repeat(64),
      supersedesProfileVersionId: current.profileVersionId,
    };
    const initial = createObserverGeneration({
      generation: "generation-1",
      managedInstanceId: "instance-1",
      routes: [{ route, state: value, cursor: value.cursor }],
    });
    const created: AgentEvent<"AgentProfileVersionCreated"> = {
      ...statusEvent("profile-created", "2"),
      branchId: "other-branch",
      type: "AgentProfileVersionCreated",
      payload: {
        agentProfile: nextProfile,
        expectedActiveProfileVersionId: current.profileVersionId,
      },
    };
    const applied = applyObserverCommittedEvent(initial, {
      generation: "generation-1",
      managedInstanceId: "instance-1",
      route,
      event: created,
    });
    expect(applied.kind).toBe("applied");
    expect(applied.state.routes.get(observerRouteKey(route))?.state.agentProfiles["profile-v2"]).toEqual(nextProfile);
  });

  test("cleans provisional progress on a committed effect outcome", () => {
    const value = state("root", "main", {
      effects: {
        effect: {
          id: "effect",
          executor: "shell",
          operation: "run",
          input: {},
          origin: { kind: "runtime", requestId: "request" },
          idempotencyKey: "effect",
          idempotent: true,
          attempts: 1,
          status: "started",
          eventId: "effect-started",
        },
      },
    });
    const initial = createObserverGeneration({
      generation: "generation-1",
      managedInstanceId: "instance-1",
      routes: [{ route, state: value, cursor: value.cursor }],
    });
    const progressed = recordObserverProgress(initial, {
      generation: "generation-1",
      managedInstanceId: "instance-1",
      route,
      progress: { effectId: "effect", stage: "running", message: "partial" },
    });
    expect(progressed.kind).toBe("applied");
    expect(progressed.state.progress.size).toBe(1);
    const outcome: AgentEvent<"EffectOutcomeRecorded"> = {
      id: "effect-outcome",
      sessionId: route.sessionId,
      branchId: route.branchId,
      causationId: null,
      correlationId: null,
      type: "EffectOutcomeRecorded",
      schemaVersion: EVENT_SCHEMA_VERSION,
      producer: "executor",
      idempotencyKey: "effect-outcome",
      committedAt: "2026-08-20T00:00:02.000Z",
      cursor: "2",
      originDeviceId: "device",
      originSequence: 2,
      streamParentId: "created-root",
      payload: {
        effectId: "effect",
        attempt: 1,
        outcome: "succeeded",
        output: {},
        observedAt: "2026-08-20T00:00:02.000Z",
      },
    };
    const committed = applyObserverCommittedEvent(progressed.state, {
      generation: "generation-1",
      managedInstanceId: "instance-1",
      route,
      event: outcome,
    });
    expect(committed.kind).toBe("applied");
    expect(committed.state.progress.size).toBe(0);
    expect(committed.state.replay.at(-1)?.payload.kind).toBe("progress_cleared");
  });

  test("bounds replay and requires resync after overflow", () => {
    const value = state("root", "main");
    let current = createObserverGeneration({
      generation: "generation-1",
      managedInstanceId: "instance-1",
      routes: [{ route, state: value, cursor: value.cursor }],
    });
    for (let index = 0; index <= OBSERVER_BOUNDS.replayEnvelopes; index += 1) {
      const next = recordObserverProgress(current, {
        generation: "generation-1",
        managedInstanceId: "instance-1",
        route,
        progress: { effectId: "effect", stage: `stage-${index}` },
      });
      if (next.kind !== "applied") throw new Error(next.kind);
      current = next.state;
    }
    expect(current.replay.length).toBe(1);
    expect(current.replay[0]?.payload.kind).toBe("resync_required");
    expect(current.progress.size).toBe(0);
    expect(replayObserverEnvelopes(current, "generation-1", 0)).toEqual({
      kind: "resync_required",
      reason: "replay_unavailable",
    });
    expect(replayObserverEnvelopes(current, "wrong", current.sequence)).toEqual({
      kind: "resync_required",
      reason: "generation_mismatch",
    });
  });

  test("bounds the durable activity rail", () => {
    const value = state("root", "main");
    let current = createObserverGeneration({
      generation: "generation-1",
      managedInstanceId: "instance-1",
      routes: [{ route, state: value, cursor: value.cursor }],
    });
    for (let cursor = 2; cursor <= OBSERVER_BOUNDS.activityItems + 2; cursor += 1) {
      const applied = applyObserverCommittedEvent(current, {
        generation: "generation-1",
        managedInstanceId: "instance-1",
        route,
        event: statusEvent(`status-${cursor}`, String(cursor)),
      });
      if (applied.kind !== "applied") throw new Error(applied.kind);
      current = applied.state;
    }
    expect(current.activity.length).toBe(OBSERVER_BOUNDS.activityItems);
    expect(current.activity[0]?.cursor).toBe("3");
    expect(current.activityBytes).toBeLessThanOrEqual(OBSERVER_BOUNDS.activityBytes);
  });
});

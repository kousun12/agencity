import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import {
  AgentClient,
  InProcessProtocolTransport,
  ProtocolClientError,
  ProtocolServer,
  Supervisor,
  EVENT_SCHEMA_VERSION,
  agentProfilePin,
  type AgentEvent,
  type BranchWatchHandlers,
  type EffectProgressNotification,
} from "../../src/index.ts";
import { TERMINAL_COMMAND_REGISTRY, TerminalInterruptPolicy, TerminalUI, renderEvent, renderTerminalError } from "../../src/tui/index.ts";
import type { ProductBranchSummary } from "../../src/product/index.ts";
import { makeTempRuntime, removeTempRuntime, waitFor, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

function event(type: AgentEvent["type"], payload: Record<string, unknown>, cursor = "42"): AgentEvent {
  return {
    cursor,
    id: `event-${cursor}`,
    sessionId: "session-internal-id",
    branchId: "branch-internal-id",
    causationId: null,
    correlationId: null,
    type,
    schemaVersion: EVENT_SCHEMA_VERSION,
    committedAt: "2026-08-07T00:00:00.000Z",
    producer: "supervisor",
    idempotencyKey: null,
    payload,
    originDeviceId: "device-internal-id",
    originSequence: Number(cursor),
    streamParentId: null,
  } as unknown as AgentEvent;
}

function progress(effectId: string, text: string, sequence = 0): EffectProgressNotification {
  return {
    type: "effect-progress",
    effectId,
    sessionId: "session-internal-id",
    branchId: "branch-internal-id",
    executor: "model",
    operation: "complete",
    attempt: 1,
    sequence,
    kind: "model-output-delta",
    value: { text },
    observedAt: "2026-08-07T00:00:00.000Z",
  };
}

describe("FU-005 protocol-backed terminal UI", () => {
  test("the public command registry covers product, live/history, status, autonomy, and operations", () => {
    const names = new Set(TERMINAL_COMMAND_REGISTRY.flatMap((item) => [item.name, ...item.aliases]));
    for (const required of [
      "/new", "/sessions", "/run", "/stop", "/quit", "/info", "/status", "/model", "/budget", "/agents", "/tree",
      "/goal", "/heartbeat", "/schedule", "/history", "/live", "/cell", "/branch", "/resume", "/compact",
      "/memory", "/skills", "/profile", "/refine", "/sync", "/conflicts", "/unknown", "/reconcile",
    ]) expect(names.has(required), required).toBe(true);
    expect(new Set(TERMINAL_COMMAND_REGISTRY.map((item) => item.name)).size).toBe(TERMINAL_COMMAND_REGISTRY.length);
  });

  test("live events are a concise product projection while internal action JSON stays audit-only", () => {
    const rawAction = JSON.stringify({
      protocol: "agencity.agent-action",
      version: 1,
      type: "typescript",
      code: "await sdk.shell.run({ command: 'secret-internal-command' })",
    });
    expect(renderEvent(event("AgentRunActionCommitted", {
      runId: "run-internal-id",
      stepId: "step-internal-id",
      ordinal: 1,
      actionId: "action-internal-id",
      callId: "call-internal-id",
      raw: rawAction,
      action: JSON.parse(rawAction),
    }))).toBeNull();
    expect(renderEvent(event("ModelOutputChunk", { callId: "call-internal-id", sequence: 0, text: rawAction }))).toBeNull();
    expect(renderEvent(event("EffectRequested", { effectId: "effect-internal-id" }))).toBeNull();
    expect(renderEvent(event("MessageAppended", { messageId: "message-internal-id", role: "user", content: "duplicate prompt" }))).toBeNull();

    const visible = [
      renderEvent(event("MessageAppended", { messageId: "message-internal-id", role: "assistant", content: "Validated answer" })),
      renderEvent(event("CellCommitted", { cellId: "cell-internal-id", result: { summary: "tests passed" } })),
      renderEvent(event("CellFailed", { cellId: "cell-internal-id", error: "typecheck failed" })),
      renderEvent(event("AgentRunStatusChanged", { runId: "run-internal-id", status: "unknown", reason: "The external operation may have completed" })),
      renderEvent(event("EffectOutcomeRecorded", { effectId: "effect-internal-id", outcome: "unknown" })),
    ];
    expect(visible).toEqual([
      "assistant: Validated answer",
      "[cell complete] {\"summary\":\"tests passed\"}",
      "[cell failed] typecheck failed",
      "[run outcome unknown] — The external operation may have completed",
      "[operation outcome unknown] Inspect with /unknown before retrying.",
    ]);
    expect(visible.join("\n")).not.toMatch(/internal-id|cursor=|agencity\.agent-action|secret-internal-command/);
  });

  test("the TUI imports only public client/domain contracts, not Supervisor or storage", async () => {
    const source = await readFile(new URL("../../src/tui/index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/import[^;]+Supervisor/);
    expect(source).not.toMatch(/from ["'][^"']*storage/);
    expect(source).toContain("TerminalAgentClient");
    expect(source).toContain("watchBranch");
    expect(source).not.toContain("#json(");
  });

  test("loads a protocol snapshot, reports recovery/trust truthfully, and switches history/live without effects", async () => {
    const temp = await makeTempRuntime("agencity-terminal-ui-"); temps.push(temp);
    const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover: false });
    const session = await supervisor.createSession({ workspaceId: "terminal", sessionName: "Terminal test", branchName: "main" });
    await supervisor.appendMessage(session.sessionId, session.branchId, "user", "retained message");
    const protocol = new ProtocolServer(supervisor);
    const client = new AgentClient(new InProcessProtocolTransport(protocol));
    let output = "";
    const ui = new TerminalUI(client, { interactive: false, output: { write(value: string | Uint8Array) { output += String(value); return true; } } });
    await ui.run(session.sessionId, session.branchId);
    expect(output).toContain("Agencity trusted-local TUI (protocol-backed terminal client)");
    expect(output).toContain("TRUSTED-LOCAL");
    expect(output).toContain("not sandboxed");
    expect(output).toContain("Recovery: 0 pending effects, 0 unknown");
    expect(output).toContain("Detached. Session identity and durable work remain owned by the service.");

    const cursor = (await client.snapshot(session.sessionId, session.branchId)).cursor;
    await ui.execute(`/history ${cursor}`);
    expect(output).toContain(`Historical projection at ${cursor}`);
    await ui.execute("/live");
    expect(output).toContain("Returned to live state.");
    await ui.execute("/history");
    expect(output).toContain(`Message Appended — cursor ${cursor}`);
    expect(output).not.toContain('"messageId"');
    await ui.execute("/raw");
    expect(output).toContain('"type": "MessageAppended"');
    expect(output).toContain("retained message");
    expect((await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId })).filter((event) => event.type === "EffectRequested")).toHaveLength(0);
    await supervisor.close();
  });

  test("publishes replacing structured details and reserves raw payloads for /raw", async () => {
    const temp = await makeTempRuntime("agencity-terminal-details-"); temps.push(temp);
    const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover: false });
    const session = await supervisor.createSession({ workspaceId: "terminal-details", sessionName: "Structured details", branchName: "main" });
    await supervisor.appendMessage(session.sessionId, session.branchId, "user", "retained detail evidence");
    const client = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    const details: Array<{ kind: string; title: string; raw: unknown }> = [];
    let dismissals = 0;
    let transcript = "";
    const ui = new TerminalUI(client, {
      interactive: false,
      manageSignals: false,
      onOutput: value => { transcript += value; },
      onDetail: detail => { if (detail) details.push(detail); else dismissals++; },
    });
    await ui.attach(session.sessionId, session.branchId, false);
    await ui.execute("/budget");
    await ui.execute("/snapshot");
    await ui.execute("/history");
    expect(details.map(detail => [detail.kind, detail.title])).toEqual([
      ["inspection", "Budget"],
      ["inspection", "Workspace snapshot"],
      ["inspection", "History"],
    ]);
    expect(transcript).not.toContain('"sessionId"');
    await ui.execute("/raw");
    expect(details.at(-1)).toMatchObject({ kind: "raw", title: "History · raw diagnostics" });
    await ui.execute("/new Switched work");
    expect(dismissals).toBe(1);
    await ui.execute("/raw");
    expect(details.at(-1)).toMatchObject({
      kind: "raw",
      title: "Branch · raw diagnostics",
      raw: {
        modelContracts: {
          protocol: "agencity.model-contract-diagnostics",
          version: 1,
        },
      },
    });
    await ui.detach(false);
    await supervisor.close();
  });

  test("redacts a submitted provider key from protocol failures before plain or full-screen rendering", async () => {
    const temp = await makeTempRuntime("agencity-terminal-key-error-"); temps.push(temp);
    const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover: false });
    const session = await supervisor.createSession({ workspaceId: "terminal-key-error" });
    const base = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    const client = new Proxy(base, {
      get(target, property) {
        if (property === "productSetProviderKey") {
          return async (_provider: string, apiKey: string) => {
            throw new ProtocolClientError("PROVIDER_KEY_REJECTED", `Provider rejected ${apiKey}`, 400);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let output = "";
    const ui = new TerminalUI(client, {
      interactive: false,
      manageSignals: false,
      output: { write(value: string | Uint8Array) { output += String(value); return true; } },
    });
    await ui.attach(session.sessionId, session.branchId, false);
    await ui.execute("/model login openai");
    const secret = "provider-key-not-known-to-the-redactor";
    let rejected: unknown;
    try {
      await ui.execute(secret);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(ProtocolClientError);
    expect(renderTerminalError(rejected)).toContain("PROVIDER_KEY_REJECTED");
    expect(renderTerminalError(rejected)).toContain("[REDACTED]");
    expect(renderTerminalError(rejected)).not.toContain(secret);
    expect(output).not.toContain(secret);
    await ui.detach(false);
    await supervisor.close();
  });

  test("an interactive command failure is rendered as a scrubbed typed error and the next command still runs", async () => {
    const temp = await makeTempRuntime("agencity-terminal-errors-"); temps.push(temp);
    const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover: false });
    const session = await supervisor.createSession({ workspaceId: "terminal-errors", sessionName: "Error loop", branchName: "main" });
    const client = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    const input = new PassThrough();
    let output = "";
    const ui = new TerminalUI(client, {
      interactive: true,
      input,
      output: { write(value: string | Uint8Array) { output += String(value); return true; } },
    });

    const running = ui.run(session.sessionId, session.branchId);
    await waitFor(() => output.includes("/help opens the command palette"), "TUI prompt");
    input.write("/unknown missing-effect\n");
    await waitFor(() => output.includes("[command error:NOT_FOUND status=404]"), "typed command error");
    input.write("/info\n");
    await waitFor(() => output.includes("WORKSPACE STATUS"), "next command after failure");
    input.end("/quit\n");
    await running;

    expect(output).toContain("effect not found: missing-effect");
    expect(output).toContain("Detached. Session identity and durable work remain owned by the service.");
    await supervisor.close();
  });
  test("structured AgentRun deltas stay internal while legacy progress and real discards remain visible", async () => {
    const temp = await makeTempRuntime("agencity-terminal-progress-"); temps.push(temp);
    const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover: false });
    const session = await supervisor.createSession({ workspaceId: "terminal-progress", sessionName: "Progress test", branchName: "main" });
    const runId = "run-internal-id";
    const stepId = "step-internal-id";
    const initialEffectId = "agent-effect-internal-id";
    const retryEffectId = "agent-retry-effect-internal-id";
    const contextWindow = {
      provider: "fixture",
      model: "fixture-model",
      source: "model-catalog" as const,
      contextWindowTokens: 8_192,
      outputReserveTokens: 512,
      estimatorId: "fixture-estimator",
      triggerRatio: 0.8,
      targetRatio: 0.6,
    };
    await supervisor.storage.appendEvents([{
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunRequested", producer: "supervisor", idempotencyKey: "progress-run",
      payload: { runId, task: "exercise structured progress", requestKey: "progress-run", profilePin: agentProfilePin(await supervisor.agentProfiles.active(session.sessionId)), goalMode: "none" },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunStepStarted", producer: "supervisor", idempotencyKey: "progress-step",
      payload: { runId, stepId, ordinal: 1, contextId: "context-internal-id", callId: "call-internal-id", effectId: initialEffectId, actionId: "action-internal-id", observationEventIds: [] },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunModelAttemptStarted", producer: "supervisor", idempotencyKey: "progress-attempt-1",
      payload: { runId, stepId, ordinal: 1, attempt: 1, contextId: "context-internal-id", callId: "call-internal-id", effectId: initialEffectId, reason: "initial", estimatedInputTokens: 20, contextWindow },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunModelAttemptStarted", producer: "supervisor", idempotencyKey: "progress-attempt-2",
      payload: { runId, stepId, ordinal: 1, attempt: 2, contextId: "retry-context-internal-id", callId: "retry-call-internal-id", effectId: retryEffectId, reason: "provider-overflow", estimatedInputTokens: 10, contextWindow, retryOfCallId: "call-internal-id" },
    }]);

    const base = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    let handlers: BranchWatchHandlers | undefined;
    const watchBranch: AgentClient["watchBranch"] = async (sessionId, branchId, next, options = {}) => {
      handlers = next;
      await next.onSnapshot(await base.snapshot(sessionId, branchId));
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    const client = new Proxy(base, {
      get(target, property) {
        if (property === "watchBranch") return watchBranch;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const input = new PassThrough();
    let output = "";
    const ui = new TerminalUI(client, {
      interactive: true,
      input,
      output: { write(value: string | Uint8Array) { output += String(value); return true; } },
    });
    const running = ui.run(session.sessionId, session.branchId);
    await waitFor(() => handlers !== undefined && output.includes("/main> "), "progress TUI prompt");
    const transcriptStart = output.length;
    const rawPrefix = '{"protocol":"agencity.agent-action","version":1,';
    const rawSuffix = '"type":"typescript","code":"secret-internal-command"}';

    await handlers!.onProgress?.(progress(initialEffectId, rawPrefix));
    await handlers!.onProgressDiscard?.([initialEffectId], "disconnect");
    const beforeReconnect = output;
    await handlers!.onReconnect?.(2, "00000000000000000042");
    expect(output).toBe(beforeReconnect);
    await handlers!.onProgress?.(progress(retryEffectId, rawSuffix));
    await handlers!.onProgressDiscard?.([retryEffectId], "committed");
    expect(output.slice(transcriptStart).match(/\[agent working…\]/g)).toHaveLength(1);
    expect(output.slice(transcriptStart)).not.toContain(rawPrefix);
    expect(output.slice(transcriptStart)).not.toContain(rawSuffix);

    const legacyEffectId = "legacy-visible-effect-internal-id";
    await handlers!.onProgress?.(progress(legacyEffectId, "Visible legacy answer"));
    expect(output.slice(transcriptStart)).toContain("Visible legacy answer");
    await handlers!.onProgressDiscard?.([legacyEffectId], "disconnect");
    const transcript = output.slice(transcriptStart);
    expect(transcript).toContain("[provisional progress discarded after connection loss]");
    expect(transcript).not.toMatch(/protocol reconnected|00000000000000000042|agent-effect-internal-id|legacy-visible-effect-internal-id|secret-internal-command/);

    await ui.execute("/quit");
    await running;
    await supervisor.close();
  });

  test("navigates exact retained family routes without changing product selection or overlapping watches", async () => {
    const temp = await makeTempRuntime("agencity-terminal-family-navigation-"); temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    const root = await supervisor.createSession({
      workspaceId: "terminal-family-navigation",
      sessionName: "Root agent",
      branchName: "main",
    });
    const child = await supervisor.agents.spawn(root.sessionId, root.branchId, {
      task: "Review the implementation",
      name: "Reviewer",
      run: false,
    });
    await supervisor.agents.spawn(child.sessionId, child.branchId, {
      task: "Verify the review",
      name: "Verifier",
      run: false,
    });
    const base = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    let productSelections = 0;
    let activeWatches = 0;
    let maximumActiveWatches = 0;
    const client = new Proxy(base, {
      get(target, property) {
        if (property === "productSelect") return async (...args: Parameters<AgentClient["productSelect"]>) => {
          productSelections++;
          return base.productSelect(...args);
        };
        if (property === "watchBranch") return async (...args: Parameters<AgentClient["watchBranch"]>) => {
          activeWatches++;
          maximumActiveWatches = Math.max(maximumActiveWatches, activeWatches);
          try {
            return await base.watchBranch(...args);
          } finally {
            activeWatches--;
          }
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ui = new TerminalUI(client, { interactive: false, manageSignals: false });
    try {
      await ui.attach(root.sessionId, root.branchId, false);
      expect(ui.presentation.family).toMatchObject({
        route: { sessionId: root.sessionId, branchId: root.branchId },
        parent: null,
        refresh: "current",
        ancestry: ["Root agent"],
      });
      expect(ui.presentation.family.children).toHaveLength(1);
      expect(ui.presentation.family.children[0]?.sessionId).toBe(child.sessionId);
      expect(ui.presentation.family.children[0]?.branchId).toBe(child.branchId);
      expect(ui.presentation.family.children[0]?.relationship).toBe("child");
      expect(ui.presentation.family.children[0]?.task).toBe("Review the implementation");
      expect(ui.presentation.family.children[0]?.activity).toBe("idle");

      await ui.openFamilyChild(child.sessionId, child.branchId);
      expect(ui.presentation.state.sessionName).toBe("Reviewer");
      expect(ui.presentation.family.route).toEqual({ sessionId: child.sessionId, branchId: child.branchId });
      expect(ui.presentation.family.parent?.sessionId).toBe(root.sessionId);
      expect(ui.presentation.family.parent?.branchId).toBe(root.branchId);
      expect(ui.presentation.family.ancestry).toEqual(["Root agent", "Reviewer"]);
      expect(ui.presentation.family.children.map(item => [item.name, item.relationship]))
        .toEqual([["Verifier", "child"]]);

      await ui.openFamilyParent();
      expect(ui.presentation.state.sessionId).toBe(root.sessionId);
      expect(ui.presentation.family.route).toEqual({ sessionId: root.sessionId, branchId: root.branchId });
      expect(productSelections).toBe(0);
      expect(maximumActiveWatches).toBe(1);
      expect(activeWatches).toBe(1);
    } finally {
      await ui.detach(false);
      expect(activeWatches).toBe(0);
      await supervisor.close();
    }
  });

  test("opens root work through exact product selection while retaining failed and archived catalog rows", async () => {
    const temp = await makeTempRuntime("agencity-terminal-workspace-agents-"); temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    const first = await supervisor.createSession({
      workspaceId: "terminal-workspace-agents",
      sessionName: "First root",
      branchName: "main",
    });
    const second = await supervisor.createSession({
      workspaceId: "terminal-workspace-agents",
      sessionName: "Second root",
      branchName: "main",
    });
    const child = await supervisor.agents.spawn(first.sessionId, first.branchId, {
      task: "Child is excluded from the workspace view",
      name: "Nested child",
      run: false,
    });
    const row = (
      sessionId: string,
      branchId: string,
      sessionName: string,
      status: ProductBranchSummary["status"],
      root = true,
    ): ProductBranchSummary => ({
      sessionId,
      branchId,
      sessionName,
      branchName: "main",
      model: { provider: "echo", model: "echo-1", reasoningEffort: "provider-default" },
      status,
      taskSummary: `${sessionName} task`,
      activeGoals: 0,
      unresolvedWork: 0,
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
      root,
      initialBranch: true,
    });
    const rows = [
      row(first.sessionId, first.branchId, "First root", "idle"),
      row(second.sessionId, second.branchId, "Second root", "stopped"),
      row(child.sessionId, child.branchId, "Nested child", "idle", false),
      row("failed-session", "failed-branch", "Failed root", "failed"),
      row("archived-session", "archived-branch", "Archived root", "archived"),
    ];
    const base = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    const selections: Array<[string | undefined, string | undefined]> = [];
    let catalogCalls = 0;
    let activeWatches = 0;
    let maximumActiveWatches = 0;
    let selectionError: Error | null = null;
    let transitionError: Error | null = null;
    let familyError = false;
    const client = new Proxy(base, {
      get(target, property) {
        if (property === "capabilities") return async () => ({
          ...await base.capabilities(),
          productCatalog: true,
        });
        if (property === "productSessions") return async () => {
          catalogCalls++;
          return rows;
        };
        if (property === "productSelect") return async (sessionId?: string, branchId?: string) => {
          if (selectionError) throw selectionError;
          selections.push([sessionId, branchId]);
          return { sessionId: sessionId!, branchId: branchId! };
        };
        if (property === "snapshot") return async (sessionId: string, branchId: string) => {
          if (transitionError && sessionId === second.sessionId && branchId === second.branchId) {
            throw transitionError;
          }
          return base.snapshot(sessionId, branchId);
        };
        if (property === "agents") return async (sessionId: string, branchId: string) => {
          if (familyError && sessionId === second.sessionId && branchId === second.branchId) {
            throw new ProtocolClientError("UNAVAILABLE", "Family projection unavailable", 503);
          }
          return base.agents(sessionId, branchId);
        };
        if (property === "watchBranch") return async (...args: Parameters<AgentClient["watchBranch"]>) => {
          activeWatches++;
          maximumActiveWatches = Math.max(maximumActiveWatches, activeWatches);
          try {
            return await base.watchBranch(...args);
          } finally {
            activeWatches--;
          }
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ui = new TerminalUI(client, { interactive: false, manageSignals: false });
    try {
      await ui.attach(first.sessionId, first.branchId, false);
      expect(ui.presentation.family.root).toBe(true);
      await ui.openWorkspaceAgents();
      expect(selections).toEqual([]);
      expect(ui.presentation.workspaceAgents).toMatchObject({
        open: true,
        returnRoute: { sessionId: first.sessionId, branchId: first.branchId },
        refresh: "current",
      });
      expect(ui.presentation.workspaceAgents.rows).toHaveLength(5);
      await expect(ui.openWorkspaceAgent("failed-session", "failed-branch")).rejects.toThrow(/failed and cannot be opened/);
      await expect(ui.openWorkspaceAgent("archived-session", "archived-branch")).rejects.toThrow(/archived and cannot be opened/);
      expect(selections).toEqual([]);

      transitionError = new Error(`Session or branch not found: ${second.sessionId}/${second.branchId}`);
      const failedTransition = await ui.openWorkspaceAgent(second.sessionId, second.branchId).catch(error => error);
      expect(failedTransition).toBeInstanceOf(Error);
      expect((failedTransition as Error).message).toBe("Could not open Second root. Refresh Agents and try again.");
      expect((failedTransition as Error).message).not.toContain(second.sessionId);
      expect((failedTransition as Error).message).not.toContain(second.branchId);
      expect(selections).toEqual([]);
      expect(ui.presentation.state.sessionId).toBe(first.sessionId);
      expect(ui.presentation.workspaceAgents.open).toBe(true);
      transitionError = null;
      familyError = true;

      await ui.openWorkspaceAgent(second.sessionId, second.branchId);
      expect(selections).toEqual([[second.sessionId, second.branchId]]);
      expect(ui.presentation.state.sessionId).toBe(second.sessionId);
      expect(ui.presentation.workspaceAgents.open).toBe(false);
      expect(ui.presentation.family).toMatchObject({ root: true, refresh: "unavailable" });
      expect(catalogCalls).toBe(2);
      expect(maximumActiveWatches).toBe(1);
      expect(activeWatches).toBe(1);

      await ui.openWorkspaceAgents();
      selectionError = new Error(`Session or branch not found: ${first.sessionId}/${first.branchId}`);
      const failedSelection = await ui.openWorkspaceAgent(first.sessionId, first.branchId).catch(error => error);
      expect(failedSelection).toBeInstanceOf(Error);
      expect((failedSelection as Error).message)
        .toBe("First root is open, but could not be selected for resume. Reopen Agents and try again.");
      expect((failedSelection as Error).message).not.toContain(first.sessionId);
      expect((failedSelection as Error).message).not.toContain(first.branchId);
      expect(selections).toEqual([[second.sessionId, second.branchId]]);
      expect(ui.presentation.state.sessionId).toBe(first.sessionId);
      expect(ui.presentation.workspaceAgents.open).toBe(false);
    } finally {
      await ui.detach(false);
      await supervisor.close();
    }
  });

  test("keeps stale workspace rows, ignores superseded refreshes, and rejects historical /agents", async () => {
    const temp = await makeTempRuntime("agencity-terminal-workspace-agents-refresh-"); temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    const root = await supervisor.createSession({
      workspaceId: "terminal-workspace-agents-refresh",
      sessionName: "Stable root",
      branchName: "main",
    });
    const catalogRow = (sessionName: string): ProductBranchSummary => ({
      sessionId: root.sessionId,
      branchId: root.branchId,
      sessionName,
      branchName: "main",
      model: { provider: "echo", model: "echo-1", reasoningEffort: "provider-default" },
      status: "idle",
      taskSummary: "Retained task",
      activeGoals: 0,
      unresolvedWork: 0,
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
      root: true,
      initialBranch: true,
    });
    const base = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    const responses: Array<() => Promise<ProductBranchSummary[]>> = [
      async () => [catalogRow("Stable root")],
    ];
    const client = new Proxy(base, {
      get(target, property) {
        if (property === "capabilities") return async () => ({
          ...await base.capabilities(),
          productCatalog: true,
        });
        if (property === "productSessions") return () => {
          const response = responses.shift();
          if (!response) throw new Error("No catalog response was queued");
          return response();
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ui = new TerminalUI(client, { interactive: false, manageSignals: false });
    try {
      await ui.attach(root.sessionId, root.branchId, false);
      await ui.openWorkspaceAgents();
      responses.push(async () => { throw new Error("catalog unavailable"); });
      await ui.refreshWorkspaceAgents();
      expect(ui.presentation.workspaceAgents.refresh).toBe("stale");
      expect(ui.presentation.workspaceAgents.rows[0]?.sessionName).toBe("Stable root");

      let resolveOld!: (rows: ProductBranchSummary[]) => void;
      let resolveCurrent!: (rows: ProductBranchSummary[]) => void;
      responses.push(
        () => new Promise(resolve => { resolveOld = resolve; }),
        () => new Promise(resolve => { resolveCurrent = resolve; }),
      );
      const oldRefresh = ui.refreshWorkspaceAgents();
      const currentRefresh = ui.refreshWorkspaceAgents();
      resolveCurrent([catalogRow("Current root")]);
      await currentRefresh;
      resolveOld([catalogRow("Superseded root")]);
      await oldRefresh;
      expect(ui.presentation.workspaceAgents.rows[0]?.sessionName).toBe("Current root");

      ui.closeWorkspaceAgents();
      const cursor = ui.presentation.state.cursor;
      await ui.execute(`/history ${cursor}`);
      await expect(ui.execute("/agents")).rejects.toThrow("Return to live with /live before opening Agents");
      expect(ui.presentation.workspaceAgents.open).toBe(false);
    } finally {
      await ui.detach(false);
      await supervisor.close();
    }
  });

  test("keeps the current route attached when family loading fails and rejects historical opening", async () => {
    const temp = await makeTempRuntime("agencity-terminal-family-failure-"); temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    const root = await supervisor.createSession({
      workspaceId: "terminal-family-failure",
      sessionName: "Stable root",
      branchName: "main",
    });
    const child = await supervisor.agents.spawn(root.sessionId, root.branchId, {
      task: "Unreachable child",
      name: "Child",
      run: false,
    });
    const base = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    let rejectChildSnapshot = false;
    const client = new Proxy(base, {
      get(target, property) {
        if (property === "snapshot") return async (sessionId: string, branchId: string) => {
          if (rejectChildSnapshot && sessionId === child.sessionId && branchId === child.branchId) {
            throw new ProtocolClientError("NOT_FOUND", "Child branch unavailable", 404);
          }
          return base.snapshot(sessionId, branchId);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ui = new TerminalUI(client, { interactive: false, manageSignals: false });
    try {
      await ui.attach(root.sessionId, root.branchId, false);
      rejectChildSnapshot = true;
      await expect(ui.openFamilyChild(child.sessionId, child.branchId)).rejects.toThrow(/unavailable/i);
      expect(ui.presentation.state.sessionId).toBe(root.sessionId);
      await supervisor.appendMessage(root.sessionId, root.branchId, "assistant", "Old route still receives events");
      await waitFor(() => ui.presentation.state.messages.some(message => message.content === "Old route still receives events"), "old route watch");

      const cursor = ui.presentation.state.cursor;
      await ui.execute(`/history ${cursor}`);
      await expect(ui.openFamilyChild(child.sessionId, child.branchId)).rejects.toThrow(/Return to live/i);
      expect(ui.presentation.state.sessionId).toBe(root.sessionId);
    } finally {
      await ui.detach(false);
      await supervisor.close();
    }
  });

  test("coalesces injected family refreshes, preserves stale rows, and stops timers on detach", async () => {
    const temp = await makeTempRuntime("agencity-terminal-family-refresh-"); temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    const root = await supervisor.createSession({ workspaceId: "terminal-family-refresh", sessionName: "Refresh root" });
    await supervisor.agents.spawn(root.sessionId, root.branchId, {
      task: "Remain refreshable",
      name: "Refresh child",
      run: false,
    });
    const base = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    let block = false;
    let fail = false;
    let calls = 0;
    let concurrent = 0;
    let maximumConcurrent = 0;
    const releases: Array<() => void> = [];
    const client = new Proxy(base, {
      get(target, property) {
        if (property === "agents") return async (sessionId: string, branchId: string) => {
          calls++;
          concurrent++;
          maximumConcurrent = Math.max(maximumConcurrent, concurrent);
          try {
            if (block) await new Promise<void>(resolve => { releases.push(resolve); });
            if (fail) throw new ProtocolClientError("UNAVAILABLE", "Family projection unavailable", 503);
            return await base.agents(sessionId, branchId);
          } finally {
            concurrent--;
          }
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const timers = new Set<{ callback: () => void; milliseconds: number }>();
    const scheduler = {
      setTimeout(callback: () => void, milliseconds: number) {
        const handle = { callback, milliseconds };
        timers.add(handle);
        return handle;
      },
      clearTimeout(handle: unknown) {
        timers.delete(handle as { callback: () => void; milliseconds: number });
      },
    };
    const ui = new TerminalUI(client, {
      interactive: false,
      manageSignals: false,
      familyRefreshIntervalMs: 5_000,
      familyRefreshScheduler: scheduler,
    });
    try {
      await ui.attach(root.sessionId, root.branchId, false);
      await waitFor(() => ui.presentation.family.refresh === "current", "initial family refresh");
      expect(timers.size).toBe(0);
      const baseline = calls;
      block = true;
      ui.setFamilyBrowserOpen(true);
      ui.setFamilyBrowserOpen(true);
      ui.setFamilyBrowserOpen(true);
      await waitFor(() => releases.length === 1, "coalesced refresh start");
      releases.shift()!();
      await waitFor(() => releases.length === 1, "single queued refresh");
      releases.shift()!();
      block = false;
      await waitFor(() => ui.presentation.family.refresh === "current" && concurrent === 0, "coalesced refresh completion");
      expect(calls - baseline).toBe(2);
      expect(maximumConcurrent).toBe(1);
      expect([...timers][0]?.milliseconds).toBe(5_000);

      fail = true;
      ui.setFamilyBrowserOpen(true);
      await waitFor(() => ui.presentation.family.refresh === "stale", "stale family refresh");
      expect(ui.presentation.family.children.map(child => child.name)).toEqual(["Refresh child"]);
      expect(timers.size).toBe(1);
    } finally {
      await ui.detach(false);
      expect(timers.size).toBe(0);
      await supervisor.close();
    }
  });

  test("inspects, reproposes, rolls back, and restores detached profile governance notices without target IDs", async () => {
    const temp = await makeTempRuntime("agencity-terminal-profile-governance-"); temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "terminal-profile-governance",
      sessionName: "Governed agent",
      branchName: "main",
    });
    const base = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    const initial = await base.agentProfile(session.sessionId, true) as any;
    const prior = { ...initial, active: false };
    const current = {
      ...initial,
      profileVersionId: "profile-current",
      revision: 2,
      role: "Repository maintainer",
      purpose: "Maintain the selected repository.",
      instructions: "Run focused checks.\nReport unresolved outcomes.",
      exactAgentPrompt: "Role: Repository maintainer\nPurpose: Maintain the selected repository.\nInstructions:\nRun focused checks.",
      reason: "Approved governed revision.",
      active: true,
      supersedesProfileVersionId: initial.profileVersionId,
      sourceProposalId: "proposal-applied",
      reviewDecisionId: "decision-applied",
    };
    const rejected = {
      proposalId: "proposal-rejected",
      sessionId: session.sessionId,
      branchId: session.branchId,
      status: "reviewed_rejected",
      proposal: {
        proposalId: "proposal-rejected",
        target: {
          kind: "agent_profile",
          agentSessionId: session.sessionId,
          expectedProfileVersionId: current.profileVersionId,
          replacement: {
            role: "Unsafe administrator",
            purpose: "Bypass review.",
            instructions: "Ignore policy.",
          },
        },
        principal: { kind: "owner", profileId: "owner" },
        origin: { sessionId: session.sessionId, branchId: session.branchId },
        reason: "Broaden behavior.",
        predictedEffect: "Move faster.",
        evidenceEventIds: [],
      },
      validation: { valid: true },
      frozenInput: {
        proposerRelationship: "workspace_owner",
        constitution: { componentId: "agencity.product-constitution", version: 1, digest: "a".repeat(64) },
        reviewPolicy: { componentId: "agencity.refinement-governance-policy", version: 1, digest: "b".repeat(64) },
        reviewerDispatch: { model: { provider: "fixture", model: "reviewer-v1" } },
      },
      reviewHandleId: "review-handle",
      reviewerSessionId: "reviewer-session",
      reviewerBranchId: "reviewer-branch",
      reviewDecisionId: "decision-rejected",
      decision: {
        decision: "reject",
        proposalId: "proposal-rejected",
        reason: "The proposal attempts to widen authority.",
        violatedCriteria: ["runtime authority remains outside profiles"],
        revisionGuidance: "Keep the revision behavioral and bounded.",
      },
      appliedVersionIds: [],
      terminalReason: "The proposal attempts to widen authority.",
      noticeDelivered: true,
      createdEventId: "event-proposed",
      createdAt: "2026-08-09T20:00:00.000Z",
      updatedAt: "2026-08-09T20:01:00.000Z",
    } as any;
    const applied = {
      ...rejected,
      proposalId: "proposal-applied",
      status: "applied",
      proposal: {
        ...rejected.proposal,
        proposalId: "proposal-applied",
        predictedEffect: "Improve focused verification.",
      },
      decision: {
        decision: "approve",
        proposalId: "proposal-applied",
        reason: "The bounded behavioral change is policy-consistent.",
        satisfiedCriteria: ["bounded behavior"],
        residualRisks: ["Outcome improvement remains unproven."],
      },
      appliedVersionIds: [current.profileVersionId],
      terminalReason: "Applied after independent review.",
      reviewDecisionId: "decision-applied",
      createdAt: "2026-08-09T19:00:00.000Z",
    } as any;
    const proposals = [rejected, applied];
    const proposalInputs: any[] = [];
    const rollbackInputs: any[] = [];
    const client = new Proxy(base, {
      get(target, property) {
        if (property === "agentProfile") return async () => current;
        if (property === "agentProfiles") return async () => ({
          activeProfileVersionId: current.profileVersionId,
          items: [current, prior],
        });
        if (property === "governedRefinements") return async () => proposals;
        if (property === "proposeProfileUpdate") return async (_sessionId: string, _branchId: string, input: any) => {
          proposalInputs.push(input);
          return { ...applied, proposalId: `proposal-new-${proposalInputs.length}` };
        };
        if (property === "rollbackRefinement") return async (_sessionId: string, _branchId: string, input: any) => {
          rollbackInputs.push(input);
          return {
            rollbackId: "rollback-new",
            targetKind: "agent_profile",
            targetId: session.sessionId,
            previousVersionId: current.profileVersionId,
            restoreSourceVersionId: prior.profileVersionId,
            restorationVersionId: "profile-restored",
          };
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let output = "";
    const details: any[] = [];
    const ui = new TerminalUI(client, {
      interactive: false,
      manageSignals: false,
      onOutput: value => { output += value; },
      onDetail: detail => { if (detail) details.push(detail); },
    });
    try {
      await ui.attach(session.sessionId, session.branchId);
      expect(output).toContain("[profile governance: reviewer rejected]");
      expect(output).toContain("The proposal attempts to widen authority.");
      expect(output).toContain("Keep the revision behavioral and bounded.");

      await ui.execute("/profile");
      await ui.execute("/profile history");
      await ui.execute("/profile proposals");
      expect(proposalInputs).toHaveLength(0);
      expect(rollbackInputs).toHaveLength(0);
      const history = details.find(detail => detail.command === "/profile-history");
      expect(history.sections[0].rows.map((row: any) => row.value)).toEqual(["ACTIVE", "historical"]);
      expect(JSON.stringify(history)).toContain("agencity.product-constitution");
      expect(JSON.stringify(history)).toContain("reviewer-v1");
      expect(JSON.stringify(details.find(detail => detail.command === "/profile"))).toContain("Run focused checks.");

      const proposal = JSON.stringify({
        replacement: {
          role: "Repository maintainer",
          purpose: "Maintain the selected repository safely.",
          instructions: "Run focused checks and report uncertainty.",
        },
        reason: "Tighten verification.",
        predictedEffect: "Reduce incomplete verification.",
        evidenceEventIds: [],
      });
      await ui.execute(`/history ${ui.presentation.state.cursor}`);
      await ui.execute("/profile");
      await expect(ui.execute(`/profile propose ${proposal}`))
        .rejects.toThrow("Return to live with /live before changing the agent profile");
      expect(proposalInputs).toHaveLength(0);
      await ui.execute("/live");
      await ui.execute(`/profile propose ${proposal}`);
      await ui.execute(`/profile repropose latest ${proposal}`);
      expect(proposalInputs[0]).toMatchObject({
        expectedProfileVersionId: current.profileVersionId,
        wait: true,
      });
      expect(proposalInputs[0]).not.toHaveProperty("revisesProposalId");
      expect(proposalInputs[1]).toMatchObject({
        expectedProfileVersionId: current.profileVersionId,
        revisesProposalId: rejected.proposalId,
        wait: true,
      });

      await ui.execute('/profile rollback 1 {"reason":"Restore the exact baseline.","evidenceEventIds":[]}');
      expect(rollbackInputs).toEqual([{
        targetKind: "agent_profile",
        targetId: session.sessionId,
        expectedCurrentVersionId: current.profileVersionId,
        restoreVersionId: prior.profileVersionId,
        reason: "Restore the exact baseline.",
        evidenceEventIds: [],
      }]);
      expect(JSON.stringify(details.at(-1))).toContain("New restoration version");
    } finally {
      await ui.detach(false);
      await supervisor.close();
    }
  });

});

describe("FU-006 terminal interrupt semantics", () => {
  test("first interrupt requests cancellation and second only detaches with an uncertainty warning", () => {
    const policy = new TerminalInterruptPolicy();
    expect(policy.decide("run-1")).toEqual({ action: "cancel", runId: "run-1" });
    expect(policy.decide("run-1")).toEqual({ action: "detach", warning: expect.stringContaining("may outlive this client") });
    policy.reset();
    expect(policy.decide("run-1")).toEqual({ action: "cancel", runId: "run-1" });
    expect(policy.decide(null)).toEqual({ action: "detach", warning: expect.stringContaining("Durable work") });
  });

  test("an idle interrupt aborts a pending Bun readline question and detaches exactly once", async () => {
    const temp = await makeTempRuntime("agencity-terminal-idle-interrupt-"); temps.push(temp);
    const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover: false });
    const session = await supervisor.createSession({ workspaceId: "terminal-idle", sessionName: "Idle interrupt", branchName: "main" });
    const client = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    const input = new PassThrough();
    let output = "";
    const ui = new TerminalUI(client, {
      interactive: true,
      input,
      output: { write(value: string | Uint8Array) { output += String(value); return true; } },
    });
    const initialSigintListeners = process.listeners("SIGINT");
    const running = ui.run(session.sessionId, session.branchId);
    await waitFor(
      () => output.includes("/main> ") && process.listenerCount("SIGINT") === initialSigintListeners.length + 1,
      "pending readline question",
    );
    const installedHandler = process.listeners("SIGINT").find((listener) => !initialSigintListeners.includes(listener));
    expect(installedHandler).toBeDefined();

    (installedHandler as () => void)();
    await Promise.race([
      running,
      Bun.sleep(1_000).then(() => { throw new Error("idle interrupt did not release the pending readline question"); }),
    ]);
    expect(process.listeners("SIGINT")).toEqual(initialSigintListeners);
    expect(output.match(/Detaching\. Durable work/g)).toHaveLength(1);
    expect(output.match(/Detached\. Session identity/g)).toHaveLength(1);

    const afterDetach = output;
    await ui.handleInterrupt();
    expect(output).toBe(afterDetach);
    await supervisor.close();
  });

  test.each(["/quit", "/exit"])("%s aborts pending interactive input without process.exit", async (command) => {
    const temp = await makeTempRuntime("agencity-terminal-quit-"); temps.push(temp);
    const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover: false });
    const session = await supervisor.createSession({ workspaceId: "terminal-quit", sessionName: "Quit command", branchName: "main" });
    const client = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    const input = new PassThrough();
    let output = "";
    const ui = new TerminalUI(client, {
      interactive: true,
      input,
      output: { write(value: string | Uint8Array) { output += String(value); return true; } },
    });
    const running = ui.run(session.sessionId, session.branchId);
    await waitFor(() => output.includes("Quit command/main> "), "pending quit readline question");

    await expect(ui.execute(command)).resolves.toBe("detach");
    await Promise.race([
      running,
      Bun.sleep(1_000).then(() => { throw new Error(`${command} did not release the pending readline question`); }),
    ]);
    expect(output).toContain("Detached. Session identity and durable work remain owned by the service.");
    await supervisor.close();
  });

  test("SIGINT cancellation rejection is scrubbed and observed before a second interrupt detaches", async () => {
    const temp = await makeTempRuntime("agencity-terminal-interrupt-error-"); temps.push(temp);
    const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover: false });
    const session = await supervisor.createSession({ workspaceId: "terminal-interrupt" });
    await supervisor.storage.appendEvents([{
      sessionId: session.sessionId,
      branchId: session.branchId,
      type: "AgentRunRequested",
      producer: "supervisor",
      idempotencyKey: "terminal:active-run",
      payload: { runId: "run-active", task: "keep running", requestKey: "terminal:active-run", profilePin: agentProfilePin(await supervisor.agentProfiles.active(session.sessionId)), goalMode: "none" },
    }]);
    const base = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    const secret = "sk-test-TERMINAL-INTERRUPT-1234567890";
    const client = new Proxy(base, {
      get(target, property) {
        if (property === "cancelRun") return async () => { throw new ProtocolClientError("CANCEL_FAILED", `provider rejected ${secret}`, 503); };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let output = "";
    const ui = new TerminalUI(client, {
      interactive: false,
      output: { write(value: string | Uint8Array) { output += String(value); return true; } },
    });
    await ui.run(session.sessionId, session.branchId);

    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = secret;
    const unhandled: unknown[] = [];
    const capture = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", capture);
    try {
      await expect(ui.handleInterrupt()).resolves.toEqual({ action: "cancel", runId: "run-active" });
      expect(output).toContain("[interrupt error:CANCEL_FAILED status=503]");
      expect(output).toContain("Cancellation was not confirmed");
      expect(output).not.toContain("run-active was not confirmed");
      expect(output).not.toContain(secret);
      await expect(ui.handleInterrupt()).resolves.toEqual({ action: "detach", warning: expect.stringContaining("may outlive this client") });
      await Bun.sleep(0);
      expect(unhandled).toEqual([]);
      expect(output).toContain("Detaching after a cancellation request");
    } finally {
      process.off("unhandledRejection", capture);
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
      await supervisor.close();
    }
  });
});

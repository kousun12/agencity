import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import {
  AgentClient,
  InProcessProtocolTransport,
  ProtocolClientError,
  ProtocolServer,
  Supervisor,
  type AgentEvent,
  type BranchWatchHandlers,
  type EffectProgressNotification,
} from "../../src/index.ts";
import { TERMINAL_COMMAND_REGISTRY, TerminalInterruptPolicy, TerminalUI, renderEvent } from "../../src/tui/index.ts";
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
    schemaVersion: 1,
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
      "/memory", "/skills", "/refine", "/sync", "/conflicts", "/unknown", "/reconcile",
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
      renderEvent(event("AgentRunUserInputRequested", { runId: "run-internal-id", requestId: "request-internal-id", actionId: "action-internal-id", kind: "clarification", question: "Which package?" })),
      renderEvent(event("AgentRunStatusChanged", { runId: "run-internal-id", status: "unknown", reason: "The external operation may have completed" })),
      renderEvent(event("EffectOutcomeRecorded", { effectId: "effect-internal-id", outcome: "unknown" })),
    ];
    expect(visible).toEqual([
      "assistant: Validated answer",
      "[cell complete] {\"summary\":\"tests passed\"}",
      "[cell failed] typecheck failed",
      "[input needed] Which package?",
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
    expect(output).toContain(`${cursor} MessageAppended`);
    expect(output).toContain("retained message");
    expect((await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId })).filter((event) => event.type === "EffectRequested")).toHaveLength(0);
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
    await waitFor(() => (output.match(/Agencity trusted-local TUI/g)?.length ?? 0) === 2, "next command after failure");
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
      payload: { runId, task: "exercise structured progress", requestKey: "progress-run", goalMode: "none" },
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
      payload: { runId: "run-active", task: "keep running", requestKey: "terminal:active-run", goalMode: "none" },
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

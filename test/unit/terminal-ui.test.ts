import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { AgentClient, InProcessProtocolTransport, ProtocolClientError, ProtocolServer, Supervisor } from "../../src/index.ts";
import { TERMINAL_COMMAND_REGISTRY, TerminalInterruptPolicy, TerminalUI } from "../../src/tui/index.ts";
import { makeTempRuntime, removeTempRuntime, waitFor, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

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
    expect(output).toContain(`Returned to live cursor ${cursor}`);
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
      expect(output).toContain("Cancellation for run run-active was not confirmed");
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

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { AgentClient, InProcessProtocolTransport, ProtocolServer, Supervisor } from "../../src/index.ts";
import { TERMINAL_COMMAND_REGISTRY, TerminalInterruptPolicy, TerminalUI } from "../../src/tui/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

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
});

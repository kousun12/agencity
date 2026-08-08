import { afterEach, describe, expect, test } from "bun:test";
import {
  AGENT_ACTION_PROTOCOL,
  AGENT_ACTION_VERSION,
  AgentClient,
  InProcessProtocolTransport,
  ProtocolServer,
  ScriptedAgentActionProvider,
  Supervisor,
  TerminalUI,
  type ModelProvider,
} from "../../src/index.ts";
import { buildTerminalScreen } from "../../src/tui/view-model.ts";
import {
  makeTempRuntime,
  removeTempRuntime,
  type TempRuntime,
} from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

describe("formal model observability protocol", () => {
  test("reports the fixed contract, selected capability, and derived counters", async () => {
    const temp = await makeTempRuntime("agencity-observability-protocol-");
    temps.push(temp);
    const provider = new ScriptedAgentActionProvider([
      "provider raw rejected arguments",
      {
        protocol: AGENT_ACTION_PROTOCOL,
        version: AGENT_ACTION_VERSION,
        type: "final",
        content: "protocol diagnostics complete",
      },
    ], "protocol-formal");
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const server = new ProtocolServer(supervisor);
    const client = new AgentClient(new InProcessProtocolTransport(server));
    try {
      const session = await client.createSession("protocol-observability", {
        model: { provider: provider.name, model: "fixture/model" },
      });
      const capability = await client.agentToolCapability({
        provider: provider.name,
        model: "fixture/model",
      });
      expect(capability).toMatchObject({
        protocol: "agencity.agent-tool-capability",
        version: 1,
        contract: {
          contractId: "agencity.agent-tools.v1",
          tools: ["bun_console", "finish"],
          selection: "exactly-one-of",
        },
        selected: {
          state: "provider-strict",
          admission: "allowed",
          canRun: true,
        },
      });

      expect((await client.startRun(
        session.sessionId,
        session.branchId,
        "complete through finish",
      )).status).toBe("succeeded");
      const diagnostics = await client.modelContractDiagnostics(
        session.sessionId,
        session.branchId,
      );
      expect(diagnostics).toMatchObject({
        protocol: "agencity.model-contract-diagnostics",
        version: 1,
        counters: {
          submissions: [
            { tool: "bun_console", count: 0 },
            { tool: "finish", count: 1 },
            { tool: "agencity_submit_refinement_review", count: 0 },
          ],
        },
      });
      expect(diagnostics.counters.violations.find(
        item => item.code === "required-tool-missing",
      )?.count).toBe(1);
      expect(diagnostics.recentOutcomes).toEqual([
        expect.objectContaining({
          kind: "contract-violation",
          code: "required-tool-missing",
          message: expect.any(String),
          evidence: expect.objectContaining({ toolCallCount: 0 }),
        }),
        expect.objectContaining({
          kind: "formal-submission",
          tool: "finish",
        }),
      ]);
      let terminalOutput = "";
      const terminal = new TerminalUI(client, {
        interactive: false,
        manageSignals: false,
        output: {
          write(value: string | Uint8Array) {
            terminalOutput += String(value);
            return true;
          },
        },
      });
      await terminal.attach(session.sessionId, session.branchId, false);
      const retainedSteps = buildTerminalScreen(terminal.presentation)
        .runs.at(-1)?.steps;
      expect(retainedSteps?.[0]).toMatchObject({
        label: "Formal contract violation · required-tool-missing",
        formalOutcome: {
          kind: "contract-violation",
          code: "required-tool-missing",
          message: expect.any(String),
          evidence: expect.objectContaining({ toolCallCount: 0 }),
        },
      });
      expect(retainedSteps?.[1]).toMatchObject({
        label: "Formal finish submission · response committed",
        formalOutcome: {
          kind: "formal-submission",
          tool: "finish",
        },
      });
      await terminal.execute("/raw");
      await terminal.detach(false);
      expect(terminalOutput).toContain('"kind": "contract-violation"');
      expect(terminalOutput).toContain('"code": "required-tool-missing"');
      expect(terminalOutput).toContain('"evidence"');
      expect(terminalOutput).toContain('"kind": "formal-submission"');
      expect(terminalOutput).toContain('"tool": "finish"');
      expect(terminalOutput).not.toContain("provider raw rejected arguments");
      expect(terminalOutput).not.toContain('"arguments"');
    } finally {
      await supervisor.close();
    }
  });

  test("serves selected capability across both transports with auth, fresh queries, and bounded rejection", async () => {
    const temp = await makeTempRuntime("agencity-observability-transports-");
    temps.push(temp);
    const provider = new ScriptedAgentActionProvider([], "transport-parity");
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const protocol = new ProtocolServer(supervisor, { bearerToken: "owner-token" });
    const listener = protocol.listen(0);
    try {
      const http = new AgentClient(`http://127.0.0.1:${listener.port}`, "owner-token");
      const inProcess = new AgentClient(
        new InProcessProtocolTransport(protocol, "owner-token"),
      );
      // The cached unselected capabilities snapshot carries no selected view,
      // so it can never satisfy a selected query.
      for (const client of [http, inProcess]) {
        expect((await client.capabilities()).agentTools.selected).toBeUndefined();
      }
      const selected = { provider: provider.name, model: "fixture/model" };
      const fromHttp = await http.agentToolCapability(selected);
      const fromInProcess = await inProcess.agentToolCapability(selected);
      expect(fromHttp).toEqual(fromInProcess);
      expect(fromHttp.selected).toMatchObject({
        state: "provider-strict",
        admission: "allowed",
        canRun: true,
      });
      // The unselected snapshot remains cached and unselected afterwards.
      expect((await http.capabilities()).agentTools.selected).toBeUndefined();
      for (const unauthorized of [
        new AgentClient(`http://127.0.0.1:${listener.port}`, "wrong-token"),
        new AgentClient(new InProcessProtocolTransport(protocol, "wrong-token")),
      ]) {
        await expect(unauthorized.agentToolCapability(selected)).rejects.toMatchObject({
          code: "UNAUTHORIZED",
          status: 401,
        });
      }
      // Absurd query identity is a typed 400 before response construction and
      // never echoes the oversized value.
      for (const client of [http, inProcess]) {
        const rejected = client.agentToolCapability({
          provider: "p".repeat(4_096),
          model: "fixture/model",
        });
        await expect(rejected).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
          status: 400,
        });
        await rejected.catch((error) => {
          expect(String(error)).not.toContain("p".repeat(300));
        });
      }
      // Unknown-but-bounded identity returns a bounded truthful view.
      const ghost = await http.agentToolCapability({
        provider: "ghost",
        model: "fixture/model",
      });
      expect(ghost.selected).toMatchObject({
        state: "unavailable",
        admission: "rejected",
        canRun: false,
      });
      expect(new TextEncoder().encode(ghost.selected!.reason ?? "").byteLength)
        .toBeLessThanOrEqual(512);
    } finally {
      await protocol.stop();
      await supervisor.close();
    }
  });

  test("keeps known unsupported capability actionable and rejects before run admission", async () => {
    let providerCalls = 0;
    const provider: ModelProvider = {
      name: "text-only",
      capabilities: {
        streaming: false,
        requiredToolSet: {
          status: "unsupported",
          requiredChoice: "unsupported",
          parallelCalls: "unsupported",
          streaming: false,
          adapter: "fixture.text-only.v1",
          reason: "Choose a model transport with bounded required-tool streaming.",
        },
      },
      async complete() {
        providerCalls++;
        return {
          text: "must not run",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        };
      },
    };
    const temp = await makeTempRuntime("agencity-observability-unavailable-");
    temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const client = new AgentClient(
      new InProcessProtocolTransport(new ProtocolServer(supervisor)),
    );
    try {
      const session = await client.createSession("protocol-unavailable", {
        model: { provider: provider.name, model: "fixture/model" },
      });
      const capability = await client.agentToolCapability({
        provider: provider.name,
        model: "fixture/model",
      });
      expect(capability.selected).toMatchObject({
        state: "unavailable",
        admission: "rejected",
        canRun: false,
        reason: "Choose a model transport with bounded required-tool streaming.",
      });
      await expect(client.startRun(
        session.sessionId,
        session.branchId,
        "must reject before admission",
      )).rejects.toMatchObject({
        code: "MODEL_RESPONSE_CONTRACT_UNAVAILABLE",
        details: expect.objectContaining({ status: "unsupported" }),
      });
      expect(providerCalls).toBe(0);
      const state = (await client.snapshot(
        session.sessionId,
        session.branchId,
      )).state;
      expect(state.messages).toEqual([]);
      expect(state.agentRuns).toEqual({});
      expect(state.effects).toEqual({});
    } finally {
      await supervisor.close();
    }
  });
});

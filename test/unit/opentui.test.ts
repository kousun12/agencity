import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
  AgentClient,
  InProcessProtocolTransport,
  ProtocolServer,
  Supervisor,
} from "../../src/index.ts";
import { OpenTuiApp, formatManagedDetach, type OpenTuiController } from "../../src/tui/opentui.ts";
import { TerminalUI } from "../../src/tui/index.ts";
import { buildTerminalScreen } from "../../src/tui/view-model.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

describe("OpenTUI interactive terminal", () => {
  test("renders a stable workspace, preserves input during protocol updates, responds to resize, and detaches", async () => {
    const temp = await makeTempRuntime("agencity-opentui-"); temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "terminal",
      sessionName: "OpenTUI test",
      branchName: "main",
      model: { provider: "echo", model: "echo-1" },
    });
    await supervisor.appendMessage(session.sessionId, session.branchId, "user", "Inspect the workspace");
    const client = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    let app: OpenTuiApp | null = null;
    const controller = new TerminalUI(client, {
      interactive: false,
      manageSignals: false,
      onOutput: value => app?.showOutput(value),
    });
    await controller.attach(session.sessionId, session.branchId, false);
    const proposedFinal = buildTerminalScreen({
      ...controller.presentation,
      state: {
        ...controller.presentation.state,
        agentRuns: {
          "gated-run": {
            id: "gated-run",
            task: "Try gated completion",
            requestKey: "gated-run",
            goalId: "goal",
            goalMode: "current",
            wakeId: null,
            status: "running",
            steps: [{
              id: "gated-step",
              ordinal: 1,
              contextId: "context",
              callId: "call",
              effectId: "effect",
              actionId: "action",
              observationEventIds: [],
              modelAttempts: [],
              action: { protocol: "agencity.agent-action", version: 1, type: "final", content: "Unaccepted gated text" },
              eventId: "event",
            }],
            inputRequests: {},
            goalChecks: {},
            cancellationRequested: false,
            requestEventId: "request",
            eventId: "event",
          },
        },
      },
    });
    expect(proposedFinal.runs[0]?.steps[0]).toMatchObject({ label: "Completion proposed", detail: null });
    const waitingForUser = buildTerminalScreen({
      ...controller.presentation,
      state: {
        ...controller.presentation.state,
        agentRuns: {
          "waiting-run": {
            id: "waiting-run",
            task: "Need a choice",
            status: "waiting_for_user",
            steps: [],
            inputRequests: {
              "choice-request": { question: "Which option?", response: undefined },
            },
            cancellationRequested: false,
          } as any,
        },
      },
    });
    expect(waitingForUser).toMatchObject({
      attentionCount: 1,
      composerPlaceholder: "Answer the pending request…",
    });
    const setup = await createTestRenderer({ width: 112, height: 30 });
    let releaseSlowCommand = (): void => {};
    let slowCommandAborted = false;
    const slowCommand = new Promise<void>(resolve => { releaseSlowCommand = resolve; });
    const appController: OpenTuiController = {
      get presentation() { return controller.presentation; },
      get detached() { return controller.detached; },
      subscribePresentation: listener => controller.subscribePresentation(listener),
      execute: async line => {
        if (line === "slow command") {
          await slowCommand;
          return "continue";
        }
        return controller.execute(line);
      },
      handleInterrupt: () => controller.handleInterrupt(),
      abortPendingOperations: () => {
        slowCommandAborted = true;
        releaseSlowCommand();
      },
    };
    try {
      app = new OpenTuiApp(setup.renderer, appController);
      let frame = await setup.waitForFrame(value => value.includes("OpenTUI test / main") && value.includes("Inspect the workspace"));
      expect(frame).toContain("TRUSTED-LOCAL");
      expect(frame).toContain("Ask Agencity");
      expect(frame).toContain("RECOVERY");

      await setup.mockInput.typeText("draft response");
      frame = await setup.waitForFrame(value => value.includes("draft response"));
      expect(frame).toContain("draft response");
      await supervisor.appendMessage(session.sessionId, session.branchId, "assistant", "A committed update arrived");
      frame = await setup.waitForFrame(value => value.includes("A committed update arrived") && value.includes("draft response"));
      expect(frame).toContain("A committed update arrived");

      setup.mockInput.pressKey("u", { ctrl: true });
      await setup.mockInput.typeText("/info");
      setup.mockInput.pressEnter();
      frame = await setup.waitForFrame(value => value.includes("Agencity trusted-local TUI"));
      expect(frame).not.toContain(" /info ");

      app.showProvisional("temporary-effect", "temporary provider prefix");
      frame = await setup.waitForFrame(value => value.includes("temporary provider prefix"));
      expect(frame).toContain("PROVISIONAL OUTPUT");
      app.discardProvisional(["temporary-effect"], "committed");
      frame = await setup.waitForFrame(value => !value.includes("temporary provider prefix"));
      expect(frame).not.toContain("temporary provider prefix");

      setup.mockInput.pressKey("p", { ctrl: true });
      frame = await setup.waitForFrame(value => value.includes("/help") && value.includes("OpenTUI test / main"));
      expect(frame).toContain("Ctrl-P commands");

      setup.resize(78, 22);
      frame = await setup.waitForFrame(value => value.includes("/help") && value.includes("OpenTUI test / main"));
      expect(frame).toContain("Ctrl-P commands");
      setup.mockInput.pressEscape();
      setup.mockInput.pressKey("u", { ctrl: true });
      await setup.mockInput.typeText("/info");
      setup.mockInput.pressEnter();
      frame = await setup.waitForFrame(value => value.includes("Agencity trusted-local TUI"));
      expect(frame).toContain("TRUSTED-LOCAL");

      await setup.mockInput.typeText("slow command");
      setup.mockInput.pressEnter();
      await setup.waitForFrame(value => value.includes("Working"));
      const done = app.run();
      setup.mockInput.pressKey("d", { ctrl: true });
      await Promise.race([
        done,
        Bun.sleep(1_000).then(() => { throw new Error("OpenTUI did not detach after Ctrl-D"); }),
      ]);
      expect(await app.settle(100)).toBe(true);
      expect(slowCommandAborted).toBe(true);
    } finally {
      releaseSlowCommand();
      app?.destroy();
      await controller.detach(false);
      setup.renderer.destroy();
      await supervisor.close();
    }
  });

  test("reports whether the resident service will idle or remain active", () => {
    expect(formatManagedDetach({
      lifecycle: "running",
      idleShutdownAt: "2026-08-07T03:00:00.000Z",
      keepAliveReasons: [],
    })).toContain("will stop automatically");
    expect(formatManagedDetach({
      lifecycle: "running",
      keepAliveReasons: [{ kind: "active_schedules", count: 1, summary: "1 active schedule" }],
    })).toBe("Detached. Service remains active: 1 active schedule.");
  });

  test("masks provider API keys before sending them to the controller", async () => {
    const temp = await makeTempRuntime("agencity-opentui-secret-"); temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "terminal",
      sessionName: "Secret input",
      branchName: "main",
    });
    const client = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    const terminal = new TerminalUI(client, { interactive: false, manageSignals: false });
    await terminal.attach(session.sessionId, session.branchId, false);
    const setup = await createTestRenderer({ width: 90, height: 24 });
    const secret = "hidden-provider-key-123456";
    let received = "";
    let pending = true;
    const controller: OpenTuiController = {
      get presentation() { return terminal.presentation; },
      get detached() { return terminal.detached; },
      get pendingSecretInput() { return pending; },
      subscribePresentation: listener => terminal.subscribePresentation(listener),
      execute: async value => {
        received = value;
        pending = false;
        return "continue";
      },
      handleInterrupt: () => terminal.handleInterrupt(),
    };
    const app = new OpenTuiApp(setup.renderer, controller);
    try {
      await setup.mockInput.pasteBracketedText(secret);
      const masked = await setup.waitForFrame(frame => frame.includes("•".repeat(secret.length)));
      expect(masked).not.toContain(secret);
      setup.mockInput.pressEnter();
      expect(await app.settle()).toBe(true);
      expect(received).toBe(secret);
      expect((await setup.captureCharFrame()).toString()).not.toContain(secret);
    } finally {
      app.destroy();
      setup.renderer.destroy();
      await terminal.detach(false);
      await supervisor.close();
    }
  });
});


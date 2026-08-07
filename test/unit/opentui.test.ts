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
      onDetail: detail => app?.showDetail(detail),
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
      for (let index = 1; index <= 28; index++) {
        await supervisor.appendMessage(session.sessionId, session.branchId, "assistant", `Long timeline update ${index}`);
      }
      frame = await setup.waitForFrame(value => value.includes("Long timeline update 28") && value.includes("draft response"));
      expect(frame).toContain("Long timeline update 28");

      setup.mockInput.pressKey("a", { ctrl: true });
      setup.mockInput.pressKey("k", { ctrl: true });
      await setup.mockInput.typeText("/info");
      setup.mockInput.pressEnter();
      frame = await setup.waitForFrame(value => value.includes("WORKSPACE STATUS"));
      expect(frame).toContain("Snapshot resume");
      expect(frame).not.toContain('"snapshotCursorResume"');
      expect(frame).not.toContain(" /info ");
      setup.mockInput.pressKey("r", { shift: true });
      frame = await setup.waitForFrame(value => value.includes("WORKSPACE STATUS · RAW") && value.includes('"reducerVersion"'));
      expect(frame).toContain("WORKSPACE STATUS · RAW");
      setup.mockInput.pressKey("r", { shift: true });
      frame = await setup.waitForFrame(value => value.includes("WORKSPACE STATUS") && !value.includes('"snapshotCursorResume"'));

      await Bun.sleep(20);
      setup.mockInput.pressKey("\u001b[6~");
      frame = await setup.waitForFrame(value => value.includes("Esc close") && !value.includes("WORKSPACE STATUS"));
      await Bun.sleep(20);
      setup.mockInput.pressKey("\u001b[5~");
      frame = await setup.waitForFrame(value => value.includes("WORKSPACE STATUS"));

      app.showOutput("First obsolete command notice");
      app.showOutput("Selected branch model: openai:gpt-test.");
      frame = await setup.waitForFrame(value => value.includes("Selected branch model"));
      expect(frame).not.toContain("First obsolete command notice");

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
      setup.mockInput.pressKey("a", { ctrl: true });
      setup.mockInput.pressKey("k", { ctrl: true });
      await setup.mockInput.typeText("/info");
      setup.mockInput.pressEnter();
      frame = await setup.waitForFrame(value => value.includes("WORKSPACE STATUS"));
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

  test("uses /model as a keyboard-driven provider picker with hidden login, durable selection, logout, and responsive dismissal", async () => {
    const temp = await makeTempRuntime("agencity-opentui-model-"); temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "terminal-model",
      sessionName: "Model picker",
      branchName: "main",
      model: { provider: "echo", model: "echo-1" },
    });
    const base = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    let storedOpenAi = false;
    let defaultModel: string | null = null;
    let selectedModel = { provider: "echo", model: "echo-1" };
    const submittedKeys: Array<string | null> = [];
    const providers = () => [
      {
        name: "openai",
        displayName: "OpenAI",
        capabilities: { streaming: true },
        usable: storedOpenAi,
        credentialSource: storedOpenAi ? "stored" as const : "missing" as const,
        ...(storedOpenAi ? {} : { remediation: "Log in to OpenAI." }),
      },
      {
        name: "anthropic",
        displayName: "Anthropic",
        capabilities: { streaming: true },
        usable: false,
        credentialSource: "missing" as const,
        remediation: "Log in to Anthropic.",
      },
      {
        name: "vercel",
        displayName: "Vercel AI Gateway",
        capabilities: { streaming: true },
        usable: false,
        credentialSource: "missing" as const,
        remediation: "Log in to Vercel AI Gateway.",
      },
      {
        name: "echo",
        displayName: "Echo (internal test fixture; non-streaming)",
        capabilities: { streaming: false },
        usable: true,
        credentialSource: "programmatic" as const,
      },
    ];
    const client = new Proxy(base, {
      get(target, property) {
        if (property === "modelProviders") return async () => providers();
        if (property === "capabilities") return async () => ({ ...(await base.capabilities()), providers: providers() });
        if (property === "productConfig") return async () => ({ defaultModel, credentialReferences: [] });
        if (property === "productSetProviderKey") return async (provider: string, apiKey: string | null) => {
          expect(provider).toBe("openai");
          submittedKeys.push(apiKey);
          storedOpenAi = apiKey !== null;
          return { provider, configured: storedOpenAi, source: storedOpenAi ? "stored" : "missing" };
        };
        if (property === "selectModel") return async (_sessionId: string, _branchId: string, value: typeof selectedModel) => {
          selectedModel = value;
          return { changed: true, model: value };
        };
        if (property === "productSetModel") return async (value: string | null) => {
          defaultModel = value;
          return { defaultModel };
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let app: OpenTuiApp | null = null;
    const terminal = new TerminalUI(client, {
      interactive: false,
      manageSignals: false,
      onOutput: value => app?.showOutput(value),
      onDetail: detail => app?.showDetail(detail),
    });
    await terminal.attach(session.sessionId, session.branchId, false);
    const setup = await createTestRenderer({ width: 118, height: 32 });
    app = new OpenTuiApp(setup.renderer, terminal);
    const secret = "hidden-openai-provider-key-123456";
    try {
      await setup.mockInput.typeText("/model");
      setup.mockInput.pressEnter();
      expect(await app.settle()).toBe(true);
      let frame = await setup.waitForFrame(value => value.includes("MODEL") && value.includes("Workspace default"));
      expect(frame).not.toContain("Echo");
      expect(frame).not.toContain('"credentialSource"');
      setup.mockInput.pressEscape();
      frame = await setup.waitForFrame(value => value.includes("Ask Agencity") && !value.includes("Providers"));
      expect(frame).not.toContain("Workspace default");
      await setup.mockInput.typeText("/model");
      setup.mockInput.pressEnter();
      expect(await app.settle()).toBe(true);
      await setup.waitForFrame(value => value.includes("MODEL") && value.includes("Workspace default"));

      frame = await setup.waitForFrame(value => value.includes("> ○ OpenAI"));
      expect(frame).toContain("not configured");

      setup.mockInput.pressKey("l");
      expect(await app.settle()).toBe(true);
      frame = await setup.waitForFrame(value => value.includes("PROVIDER LOGIN") && value.includes("OpenAI"));
      expect(frame).toContain("input is hidden");

      await setup.mockInput.typeText(secret.slice(0, 12));
      await setup.mockInput.pasteBracketedText(secret.slice(12));
      frame = await setup.waitForFrame(value => value.includes("•".repeat(secret.length)));
      expect(frame).not.toContain(secret);
      setup.mockInput.pressEnter();
      expect(await app.settle()).toBe(true);
      frame = await setup.waitForFrame(value => value.includes("> ✓ OpenAI") && value.includes("saved"));
      expect(submittedKeys).toEqual([secret]);
      expect(frame).not.toContain(secret);

      setup.mockInput.pressEnter();
      frame = await setup.waitForFrame(value => value.includes("Choose model") && value.includes("Model ID for openai"));
      await setup.mockInput.typeText("gpt-inspector-test");
      setup.mockInput.pressEnter();
      expect(await app.settle()).toBe(true);
      frame = await setup.waitForFrame(value => value.includes("gpt-inspector-test") && value.includes("openai:gpt-inspector-test"));
      expect(selectedModel).toEqual({ provider: "openai", model: "gpt-inspector-test" });
      expect(String(defaultModel)).toBe("openai:gpt-inspector-test");
      expect(frame).not.toContain(secret);

      setup.resize(78, 24);
      frame = await setup.waitForFrame(value => value.includes("MODEL") && value.includes("gpt-inspector-test"));
      expect(frame).toContain("Providers");

      setup.mockInput.pressKey("x");
      expect(await app.settle()).toBe(true);
      frame = await setup.waitForFrame(value => value.includes("> ○ OpenAI") && value.includes("not configured"));
      expect(submittedKeys).toEqual([secret, null]);
      expect(frame).not.toContain(secret);
    } finally {
      app.destroy();
      setup.renderer.destroy();
      await terminal.detach(false);
      await supervisor.close();
    }
  });

  test("focuses, browses, and opens exact parent-child routes without overriding drafts", async () => {
    const temp = await makeTempRuntime("agencity-opentui-family-"); temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    const root = await supervisor.createSession({
      workspaceId: "terminal-family",
      sessionName: "Root agent",
      branchName: "main",
      model: { provider: "echo", model: "echo-1" },
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
    const branchesBefore = (await supervisor.storage.listBranches()).length;
    const client = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    let app: OpenTuiApp | null = null;
    const terminal = new TerminalUI(client, {
      interactive: false,
      manageSignals: false,
      onOutput: value => app?.showOutput(value),
      onDetail: detail => app?.showDetail(detail),
    });
    await terminal.attach(root.sessionId, root.branchId, false);
    const setup = await createTestRenderer({ width: 112, height: 28 });
    app = new OpenTuiApp(setup.renderer, terminal);
    try {
      let frame = await setup.waitForFrame(value => value.includes("Root agent / main") && value.includes("1 agent: 1 working"));
      expect(frame).not.toContain("\nAGENTS\n");
      expect(frame).toContain("↓ agents");

      await setup.mockInput.typeText("draft stays");
      setup.mockInput.pressKey("\u001b[B");
      setup.mockInput.pressKey("\u001b[D");
      frame = await setup.waitForFrame(value => value.includes("draft stays"));
      expect(frame).toContain("Root agent / main");
      expect(frame).not.toContain("AGENT FAMILY");

      setup.mockInput.pressKey("a", { ctrl: true });
      setup.mockInput.pressKey("k", { ctrl: true });
      setup.mockInput.pressKey("\u001b[B");
      frame = await setup.waitForFrame(value => value.includes("> 1 agent: 1 working"));
      expect(frame).toContain("Enter/→ agents");
      await setup.mockInput.typeText("x");
      frame = await setup.waitForFrame(value => value.includes("x") && value.includes("↓ agents"));
      expect(frame).not.toContain("AGENT FAMILY");

      setup.mockInput.pressKey("u", { ctrl: true });
      setup.mockInput.pressKey("\u001b[B");
      setup.mockInput.pressEnter();
      frame = await setup.waitForFrame(value => value.includes("AGENT FAMILY") && value.includes("> ● Reviewer — working"));
      expect(frame).toContain("Review the implementation");

      setup.resize(72, 16);
      frame = await setup.waitForFrame(value => value.includes("AGENT FAMILY") && value.includes("TRUSTED-LOCAL"));
      expect(frame).toContain("Reviewer");
      expect(frame).toContain("Ask Agencity");
      setup.resize(52, 9);
      frame = await setup.waitForFrame(value => value.includes("Reviewer") && value.includes("TRUSTED-LOCAL"));
      expect(frame).toContain("Enter/→ open");

      setup.mockInput.pressKey("\u001b[C");
      expect(await app.settle()).toBe(true);
      frame = await setup.waitForFrame(value => value.includes("Root agent › Reviewer / unnamed branch"));
      expect(frame).toContain("1 agent: 1 working");
      expect(frame).toContain("← parent");
      expect(frame).not.toContain("AGENT FAMILY");

      await setup.mockInput.typeText("child draft");
      setup.mockInput.pressKey("\u001b[D");
      frame = await setup.waitForFrame(value => value.includes("child draft") && value.includes("Root agent › Reviewer"));
      expect(frame).toContain("Reviewer");
      setup.mockInput.pressKey("a", { ctrl: true });
      setup.mockInput.pressKey("k", { ctrl: true });
      setup.mockInput.pressKey("\u001b[D");
      expect(await app.settle()).toBe(true);
      frame = await setup.waitForFrame(value => value.includes("Root agent / main") && !value.includes("Root agent › Reviewer"));
      expect(frame).toContain("↓ agents");

      const task = await supervisor.storage.getTask?.(child.taskId);
      expect(task?.status).toBe("admitted");
      expect(task?.cancellationRequested).toBe(false);
      expect((await supervisor.storage.listBranches()).length).toBe(branchesBefore);
    } finally {
      app.destroy();
      setup.renderer.destroy();
      await terminal.detach(false);
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

  test("masks provider API keys and redacts a rejected value echoed by the controller", async () => {
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
        if (value === "/cancel") {
          pending = false;
          return "continue";
        }
        received = value;
        throw new Error(`Provider rejected ${value}`);
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
      const rejected = await setup.waitForFrame(frame => frame.includes("Provider rejected [REDACTED]"));
      expect(rejected).not.toContain(secret);
      setup.mockInput.pressEscape();
      await Bun.sleep(0);
      expect((await setup.captureCharFrame()).toString()).not.toContain(secret);
    } finally {
      app.destroy();
      setup.renderer.destroy();
      await terminal.detach(false);
      await supervisor.close();
    }
  });
});


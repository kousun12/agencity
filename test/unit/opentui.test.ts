import { afterEach, describe, expect, test } from "bun:test";
import {
  BoxRenderable,
  CodeRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  TextareaRenderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
  AgentClient,
  InProcessProtocolTransport,
  ProtocolServer,
  Supervisor,
  projectEvents,
  type AgentRunState,
  type ModelConfiguration,
} from "../../src/index.ts";
import {
  OpenTuiApp,
  alternateScrollDelta,
  familyBrowserLines,
  familyRefreshSuffix,
  formatManagedDetach,
  toggleAllRunDetails,
  workspaceAgentsLines,
  type OpenTuiController,
} from "../../src/tui/opentui.ts";
import { TerminalUI } from "../../src/tui/index.ts";
import type { ProductBranchSummary } from "../../src/product/index.ts";
import { TerminalTranscript } from "../../src/tui/transcript.ts";
import { createTerminalSyntaxStyle } from "../../src/tui/theme.ts";
import { buildTerminalScreen, type TerminalScreenView } from "../../src/tui/view-model.ts";
import { fixtureAgentProfile, makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

describe("OpenTUI interactive terminal", () => {
  test("renders the family browser as bounded, visually distinct option rows", () => {
    const view = {
      sessionName: "Root agent",
      familyRefresh: "current",
      familyChildren: [
        {
          key: "selected",
          displayName: "Selected reviewer",
          task: "Review a deliberately long implementation description without wrapping across the panel.",
          activity: "working",
          activityLabel: "working",
          model: "vercel:openai/gpt-5.6-sol",
          cancellationRequested: false,
          activityReasonLabel: null,
        },
        {
          key: "other",
          displayName: "Other reviewer",
          task: "Check another deliberately long task that must remain on one line.",
          activity: "idle",
          activityLabel: "idle",
          model: "vercel:openai/gpt-5.6-sol",
          cancellationRequested: false,
          activityReasonLabel: null,
        },
      ],
    } as unknown as TerminalScreenView;
    const lines = familyBrowserLines(view, "selected", false, true, 36);

    expect(lines.find(line => line.tone === "selected")?.text).toBe("› ● Selected reviewer · working");
    expect(lines.some(line => line.tone === "selected-detail" && line.text.endsWith("…"))).toBe(true);
    expect(lines.find(line => line.tone === "option")?.text.endsWith("…")).toBe(true);
    expect(lines.every(line => line.text.length <= 36)).toBe(true);
  });

  test("keeps routine family refreshes invisible while retaining degraded states", () => {
    expect(familyRefreshSuffix("current")).toBe("");
    expect(familyRefreshSuffix("refreshing")).toBe("");
    expect(familyRefreshSuffix("stale")).toBe(" · stale");
    expect(familyRefreshSuffix("unavailable")).toBe(" · unavailable");
  });

  test("renders bounded workspace agent sections with explicit degraded and non-resumable states", () => {
    const failed = {
      key: "failed-key",
      sessionId: "hidden-session-id",
      branchId: "hidden-branch-id",
      sessionName: "Failed root",
      branchName: "main",
      displayName: "Failed root",
      model: "openai:gpt-test",
      status: "failed",
      task: "Inspect a deliberately long failure summary for responsive rendering.",
      unresolvedWork: 2,
      activeGoals: 1,
      createdAt: "2026-08-08T11:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
      resumable: false,
    } as const;
    const lines = workspaceAgentsLines({
      open: true,
      returnRoute: { sessionId: "return", branchId: "return" },
      rows: [failed],
      sections: [{ status: "failed", title: "Failed", rows: [failed] }],
      selectedKey: failed.key,
      query: "",
      refresh: "stale",
      fetchedAt: "2026-08-08T12:00:00.000Z",
    }, 44, Date.parse("2026-08-08T12:05:00.000Z"));

    expect(lines.map(line => line.text).join("\n")).toContain("Catalog stale");
    expect(lines.map(line => line.text).join("\n")).toContain("FAILED");
    expect(lines.map(line => line.text).join("\n")).toContain("cannot open");
    expect(lines.every(line => line.text.length <= 44)).toBe(true);
    expect(lines.map(line => line.text).join("\n")).not.toMatch(/hidden-session-id|hidden-branch-id/);
  });

  test("maps alternate-scroll wheel input without consuming physical Kitty arrow keys", () => {
    expect(alternateScrollDelta("\u001bOA")).toBe(-3);
    expect(alternateScrollDelta("\u001bOB")).toBe(3);
    expect(alternateScrollDelta("\u001b[A")).toBeNull();
    expect(alternateScrollDelta("\u001b[B")).toBeNull();
    expect(alternateScrollDelta("\u001b[C")).toBeNull();
    expect(alternateScrollDelta("\u001b[D")).toBeNull();
    expect(alternateScrollDelta("\u001b[1;1A")).toBeNull();
    expect(alternateScrollDelta("\u001b[57352u")).toBeNull();
  });

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
    const structuredReview = buildTerminalScreen({
      ...controller.presentation,
      state: {
        ...controller.presentation.state,
        modelCalls: {
          "review-call": {
            id: "review-call",
            status: "succeeded",
            modelDispatch: {
              responseContract: {
                kind: "required-tool-set",
                contractId: "agencity.refinement-review.v1",
              },
            },
            result: {
              kind: "tool-submission",
              name: "agencity_submit_refinement_review",
            },
          },
        } as any,
      },
    });
    expect(structuredReview.conversation.at(-1)).toEqual({
      id: "structured-result:review-call",
      role: "runtime",
      content: "Structured trajectory review submitted agencity_submit_refinement_review. The decision is retained on the parent session.",
    });
    const displayProfile = fixtureAgentProfile(session.sessionId);
    const proposedFinal = buildTerminalScreen({
      ...controller.presentation,
      state: {
        ...controller.presentation.state,
        agentRuns: {
          "gated-run": {
            id: "gated-run",
            task: "Try gated completion",
            requestKey: "gated-run",
            profilePin: { profileVersionId: displayProfile.profileVersionId, agentPromptDigest: displayProfile.promptDigest, promptContractId: displayProfile.promptContractId },
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
            goalChecks: {},
            cancellationRequested: false,
            requestEventId: "request",
            eventId: "event",
          },
        },
      },
    });
    expect(proposedFinal.runs[0]).toMatchObject({
      taskMessageId: "agent-run-task-gated-run",
      finalMessageId: null,
      steps: [expect.objectContaining({
        label: "Checking completion…",
        detail: null,
      })],
    });
    const typescriptCode = "const rows = await sql.query('select 1');\nreturn rows;";
    const typescriptRun: AgentRunState = {
      id: "typescript-run",
      task: "Inspect with TypeScript",
      requestKey: "typescript-run",
      profilePin: { profileVersionId: displayProfile.profileVersionId, agentPromptDigest: displayProfile.promptDigest, promptContractId: displayProfile.promptContractId },
      goalId: null,
      goalMode: "none",
      wakeId: null,
      status: "running",
      steps: [{
        id: "typescript-step",
        ordinal: 1,
        contextId: "context",
        callId: "call",
        effectId: "effect",
        actionId: "typescript-action",
        observationEventIds: [],
        modelAttempts: [],
        action: {
          protocol: "agencity.agent-action",
          version: 1,
          type: "typescript",
          code: typescriptCode,
        },
        eventId: "event",
      }],
      goalChecks: {},
      cancellationRequested: false,
      requestEventId: "request",
      eventId: "event",
    };
    const projectedCell = buildTerminalScreen({
      ...controller.presentation,
      state: {
        ...controller.presentation.state,
        agentRuns: { [typescriptRun.id]: typescriptRun },
        cells: {
          "agent-run-cell-typescript-action": {
            id: "agent-run-cell-typescript-action",
            code: typescriptCode,
            status: "running",
            attempts: 2,
            logs: ["first", "second"],
            logStreams: ["stdout", "stderr"],
            eventId: "cell-event",
          },
          "agent-run-cell-another-action": {
            id: "agent-run-cell-another-action",
            code: "throw new Error('wrong cell')",
            status: "failed",
            attempts: 1,
            logs: [],
            logStreams: [],
            error: "wrong",
            eventId: "other-cell-event",
          },
        },
      },
    });
    expect(projectedCell.runs[0]?.steps[0]?.cell).toEqual({
      id: "agent-run-cell-typescript-action",
      language: "typescript",
      code: typescriptCode,
      status: "running",
      attempts: 2,
      logs: ["first", "second"],
      logStreams: ["stdout", "stderr"],
      result: null,
      error: null,
    });
    const waitingRun: AgentRunState = {
      ...typescriptRun,
      id: "waiting-run",
      requestKey: "waiting-run",
      steps: [{
        id: "waiting-step",
        ordinal: 1,
        contextId: "waiting-context",
        callId: "waiting-call",
        effectId: "waiting-effect",
        actionId: "waiting-action",
        observationEventIds: [],
        modelAttempts: [],
        eventId: "waiting-event",
      }],
    };
    const waitingForModel = buildTerminalScreen({
      ...controller.presentation,
      state: {
        ...controller.presentation.state,
        agentRuns: { [waitingRun.id]: waitingRun },
      },
    });
    expect(waitingForModel.runs[0]).toMatchObject({
      actionPending: true,
      steps: [],
    });
    const absentActiveCell = buildTerminalScreen({
      ...controller.presentation,
      state: { ...controller.presentation.state, agentRuns: { [typescriptRun.id]: typescriptRun }, cells: {} },
    });
    expect(absentActiveCell.runs[0]?.steps[0]?.cell?.status).toBe("pending");
    const absentTerminalCell = buildTerminalScreen({
      ...controller.presentation,
      state: {
        ...controller.presentation.state,
        agentRuns: { [typescriptRun.id]: { ...typescriptRun, status: "unknown" } },
        cells: {},
      },
    });
    expect(absentTerminalCell.runs[0]?.steps[0]?.cell?.status).toBe("missing");
    const setup = await createTestRenderer({ width: 112, height: 30, kittyKeyboard: true });
    let releaseSlowCommand = (): void => {};
    let slowCommandAborted = false;
    let interruptCalls = 0;
    const executedLines: string[] = [];
    const slowCommand = new Promise<void>(resolve => { releaseSlowCommand = resolve; });
    const appController: OpenTuiController = {
      get presentation() { return controller.presentation; },
      get detached() { return controller.detached; },
      subscribePresentation: listener => controller.subscribePresentation(listener),
      execute: async line => {
        executedLines.push(line);
        if (line.startsWith("pasted first line")) return "continue";
        if (line === "slow command") {
          await slowCommand;
          return "continue";
        }
        return controller.execute(line);
      },
      handleInterrupt: () => {
        interruptCalls++;
        return controller.handleInterrupt();
      },
      abortPendingOperations: () => {
        slowCommandAborted = true;
        releaseSlowCommand();
      },
    };
    try {
      app = new OpenTuiApp(setup.renderer, appController);
      let frame = await setup.waitForFrame(
        value => value.includes("OpenTUI test / main") && value.includes("Inspect the workspace"),
        { maxPasses: 100 },
      );
      const initialMessageId = controller.presentation.state.messages.find(message => message.content === "Inspect the workspace")!.id;
      const initialMessageBody = setup.renderer.root.findDescendantById(
        `agencity-transcript-message-body-${initialMessageId}`,
      );
      expect(initialMessageBody).toBeInstanceOf(MarkdownRenderable);
      expect(frame).toContain("TRUSTED-LOCAL");
      expect(frame).toContain("Ask Agencity");
      expect(frame).not.toContain("SESSION");
      expect(frame).not.toContain("RECOVERY");
      const initialLines = frame.split("\n");
      const composerLine = initialLines.findIndex(line => line.includes("› Ask Agencity"));
      expect(initialLines[composerLine - 1]?.trim()).toBe("");
      expect(initialLines[composerLine + 1]?.trim()).toBe("");
      const composer = setup.renderer.root.findDescendantById("agencity-composer") as TextareaRenderable;

      await setup.mockInput.pasteBracketedText("pasted first line\npasted second line\npasted third line");
      frame = await setup.waitForFrame(value =>
        value.includes("pasted first line")
        && value.includes("pasted second line")
        && value.includes("pasted third line"),
      );
      expect(composer.plainText).toBe("pasted first line\npasted second line\npasted third line");
      expect(executedLines).toEqual([]);
      setup.mockInput.pressEnter();
      expect(await app.settle()).toBe(true);
      expect(executedLines).toEqual(["pasted first line\npasted second line\npasted third line"]);
      expect(composer.plainText).toBe("");

      await setup.mockInput.typeText("shift first line");
      setup.mockInput.pressEnter({ shift: true });
      await setup.mockInput.typeText("shift second line");
      frame = await setup.waitForFrame(value =>
        value.includes("shift first line") && value.includes("shift second line"),
      );
      expect(composer.plainText).toBe("shift first line\nshift second line");
      expect(executedLines).toEqual(["pasted first line\npasted second line\npasted third line"]);
      composer.clear();

      await setup.mockInput.typeText("linefeed first line");
      expect(app.handleTerminalLinefeedInput("\n")).toBe(true);
      await setup.mockInput.typeText("linefeed second line");
      frame = await setup.waitForFrame(value =>
        value.includes("linefeed first line") && value.includes("linefeed second line"),
      );
      expect(composer.plainText).toBe("linefeed first line\nlinefeed second line");
      expect(executedLines).toEqual(["pasted first line\npasted second line\npasted third line"]);
      composer.clear();

      await setup.mockInput.typeText("draft response");
      frame = await setup.waitForFrame(value => value.includes("draft response"));
      expect(frame).toContain("draft response");
      const committedMarkdown = "## A committed update arrived\n\n- retained item\n\n```typescript\nconst answer = 42;\n```\n\n```unsupported-language\nplain fallback\n```";
      await supervisor.appendMessage(session.sessionId, session.branchId, "assistant", committedMarkdown);
      frame = await setup.waitForFrame(value =>
        value.includes("A committed update arrived")
        && value.includes("const answer")
        && value.includes("plain fallback")
        && value.includes("draft response"),
      );
      expect(frame).toContain("A committed update arrived");
      expect(frame).not.toContain("## A committed update arrived");
      expect(setup.renderer.root.findDescendantById(`agencity-transcript-message-body-${initialMessageId}`))
        .toBe(initialMessageBody);
      const markdownMessageId = controller.presentation.state.messages.find(message => message.content === committedMarkdown)!.id;
      const markdownBody = setup.renderer.root.findDescendantById(
        `agencity-transcript-message-body-${markdownMessageId}`,
      ) as MarkdownRenderable;
      expect(markdownBody.content).toBe(committedMarkdown);
      for (let index = 1; index <= 28; index++) {
        await supervisor.appendMessage(session.sessionId, session.branchId, "assistant", `Long timeline update ${index}`);
      }
      frame = await setup.waitForFrame(value => value.includes("Long timeline update 28") && value.includes("draft response"));
      expect(frame).toContain("Long timeline update 28");
      expect(app.handleAlternateScrollInput("\u001bOA")).toBe(true);
      expect(app.handleAlternateScrollInput("\u001b[A")).toBe(false);
      await Bun.sleep(20);
      await supervisor.appendMessage(session.sessionId, session.branchId, "assistant", "Update while alternate-scroll is away");
      await Bun.sleep(20);
      frame = (await setup.captureCharFrame()).toString();
      expect(frame).not.toContain("Update while alternate-scroll is away");
      expect(app.handleAlternateScrollInput("\u001bOB")).toBe(true);
      frame = await setup.waitForFrame(value => value.includes("Update while alternate-scroll is away"));
      setup.mockInput.pressKey("\u001b[5~");
      await Bun.sleep(20);
      await supervisor.appendMessage(session.sessionId, session.branchId, "assistant", "Update while timeline is scrolled away");
      await Bun.sleep(20);
      frame = (await setup.captureCharFrame()).toString();
      expect(frame).not.toContain("Update while timeline is scrolled away");
      setup.mockInput.pressKey("\u001b[6~");
      frame = await setup.waitForFrame(value => value.includes("Update while timeline is scrolled away"));

      app.showOutput("First obsolete command notice");
      app.showOutput("Selected branch model: openai:gpt-test.");
      frame = await setup.waitForFrame(value => value.includes("Selected branch model"));
      expect(frame).not.toContain("First obsolete command notice");
      setup.mockInput.pressEscape();
      frame = await setup.waitForFrame(value =>
        value.includes("Update while timeline is scrolled away")
        && !value.includes("Selected branch model"),
      );
      expect(frame).not.toContain("Selected branch model");

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

      setup.mockInput.pressEscape();
      await setup.mockInput.typeText("/profile");
      setup.mockInput.pressEnter();
      frame = await setup.waitForFrame(value =>
        value.includes("AGENT PROFILE") && value.includes("Behavioral instructions only"));
      expect(frame).toContain("Behavioral instructions only");
      expect(frame).toContain("TRUSTED-LOCAL");
      setup.mockInput.pressKey("\u001b[6~");
      frame = await setup.waitForFrame(value => value.includes("Exact active agent prompt"));
      expect(frame).toContain("Role: Repository agent");
      setup.resize(78, 22);
      frame = await setup.waitForFrame(value =>
        value.includes("AGENT PROFILE") && value.includes("Behavioral instructions only"));
      expect(frame).toContain("not sandboxed");
      setup.resize(112, 30);
      await setup.waitForFrame(value => value.includes("AGENT PROFILE"));
      setup.mockInput.pressEscape();
      await setup.mockInput.typeText("/info");
      setup.mockInput.pressEnter();
      await setup.waitForFrame(value => value.includes("WORKSPACE STATUS"));

      await Bun.sleep(20);
      setup.mockInput.pressKey("\u001b[6~");
      frame = await setup.waitForFrame(value => value.includes("Esc close") && !value.includes("WORKSPACE STATUS"));
      await Bun.sleep(20);
      setup.mockInput.pressKey("\u001b[5~");
      frame = await setup.waitForFrame(value => value.includes("WORKSPACE STATUS"));

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
      setup.mockInput.pressKey("c", { ctrl: true });
      await Promise.race([
        done,
        Bun.sleep(1_000).then(() => { throw new Error("OpenTUI did not interrupt a busy command"); }),
      ]);
      expect(await app.settle(100)).toBe(true);
      expect(interruptCalls).toBe(1);
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
    let selectedModel: ModelConfiguration = { provider: "echo", model: "echo-1", reasoningEffort: "provider-default" };
    let effortPreference: ModelConfiguration["reasoningEffort"] | null = null;
    const submittedKeys: Array<string | null> = [];
    const formalCapability = {
      status: "provider-strict" as const,
      requiredChoice: "provider-enforced" as const,
      parallelCalls: "provider-disabled" as const,
      streaming: true,
      adapter: "fixture.formal.v1",
    };
    const providers = () => [
      {
        name: "openai",
        displayName: "OpenAI",
        capabilities: { streaming: true, requiredToolSet: formalCapability },
        usable: storedOpenAi,
        credentialSource: storedOpenAi ? "stored" as const : "missing" as const,
        ...(storedOpenAi ? {} : { remediation: "Log in to OpenAI." }),
      },
      {
        name: "anthropic",
        displayName: "Anthropic",
        capabilities: { streaming: true, requiredToolSet: formalCapability },
        usable: false,
        credentialSource: "missing" as const,
        remediation: "Log in to Anthropic.",
      },
      {
        name: "vercel",
        displayName: "Vercel AI Gateway",
        capabilities: { streaming: true, requiredToolSet: formalCapability },
        usable: false,
        credentialSource: "missing" as const,
        remediation: "Log in to Vercel AI Gateway.",
      },
      {
        name: "echo",
        displayName: "Echo (internal test fixture; non-streaming)",
        capabilities: { streaming: false, requiredToolSet: formalCapability },
        usable: true,
        credentialSource: "programmatic" as const,
      },
    ];
    const client = new Proxy(base, {
      get(target, property) {
        if (property === "modelProviders") return async () => providers();
        if (property === "capabilities") return async () => ({ ...(await base.capabilities()), providers: providers() });
        if (property === "agentToolCapability") return async (model: ModelConfiguration) => {
          const global = (await base.capabilities()).agentTools;
          const descriptor = providers().find(item => item.name === model.provider);
          const usable = descriptor?.usable === true;
          const remediation = descriptor && "remediation" in descriptor
            ? descriptor.remediation
            : undefined;
          const transport = {
            provider: model.provider,
            displayName: descriptor?.displayName ?? model.provider,
            state: "provider-strict" as const,
            admission: "allowed" as const,
            canRun: usable,
            credential: descriptor?.credentialSource ?? "missing",
            requiredChoice: "provider-enforced" as const,
            parallelCalls: "provider-disabled" as const,
            boundedToolInputStreaming: true,
            adapter: "fixture.formal.v1",
            ...(usable ? {} : { reason: remediation ?? "Provider unavailable." }),
            provenance: { kind: "transport" as const, reportedStatus: "provider-strict" as const },
          };
          return {
            ...global,
            selected: {
              provider: model.provider,
              model: model.model,
              state: "provider-strict" as const,
              admission: "allowed" as const,
              canRun: usable,
              ...(usable ? {} : { reason: remediation ?? "Provider unavailable." }),
              transport,
              modelCatalog: null,
            },
          };
        };
        if (property === "productConfig") return async () => ({
          defaultModel,
          selectedModelEffortPreference: effortPreference,
          credentialReferences: [],
        });
        if (property === "modelCatalog") return async () => ({
          endpointId: "a".repeat(64),
          origin: "https://ai-gateway.vercel.sh",
          descriptors: [{
            model: "openai/gpt-inspector-test",
            displayName: "GPT Inspector Test",
            contextWindowTokens: 100_000,
            maxOutputTokens: 10_000,
            pricing: null,
            reasoning: { status: "listed", levels: ["low", "high"] },
            catalogDigest: "b".repeat(64),
            catalogEndpointId: "a".repeat(64),
            stale: false,
          }],
        });
        if (property === "productSetReasoningEffort") return async (_model: string, effort: ModelConfiguration["reasoningEffort"] | null) => {
          effortPreference = effort;
          return { effort };
        };
        if (property === "productSetProviderKey") return async (provider: string, apiKey: string | null) => {
          expect(provider).toBe("openai");
          submittedKeys.push(apiKey);
          storedOpenAi = apiKey !== null;
          return { provider, configured: storedOpenAi, source: storedOpenAi ? "stored" : "missing" };
        };
        if (property === "selectModel") return async (_sessionId: string, _branchId: string, value: typeof selectedModel) => {
          const previousModel = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId })).model;
          selectedModel = value;
          await supervisor.storage.appendEvents([{
            sessionId: session.sessionId,
            branchId: session.branchId,
            type: "SessionModelChanged",
            producer: "client",
            payload: { previousModel, model: value, selectedBy: "user" },
          }]);
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
      await setup.mockInput.typeText("Inspector");
      await setup.waitForFrame(value => value.includes("> GPT Inspector Test"));
      setup.mockInput.pressEnter();
      expect(await app.settle()).toBe(true);
      frame = await setup.waitForFrame(value => value.includes("gpt-inspector-test") && value.includes("openai:openai/gpt-inspector-test"));
      expect(selectedModel as unknown).toEqual({ provider: "openai", model: "openai/gpt-inspector-test", reasoningEffort: "provider-default" });
      expect(String(defaultModel)).toBe("openai:openai/gpt-inspector-test");
      expect(frame).not.toContain(secret);

      setup.mockInput.pressEscape();
      await Bun.sleep(50);
      await setup.waitForFrame(value => !value.includes("MODEL"));
      await setup.mockInput.typeText("/effort");
      setup.mockInput.pressEnter();
      expect(await app.settle()).toBe(true);
      frame = await setup.waitForFrame(value => value.includes("REASONING EFFORT") && value.includes("> provider-default"));
      expect(frame).toContain("Capability: listed");
      setup.mockInput.pressArrow("down");
      frame = await setup.waitForFrame(value => value.includes("> low"));
      setup.mockInput.pressEnter();
      expect(await app.settle()).toBe(true);
      frame = await setup.waitForFrame(value => value.includes("REASONING EFFORT") && value.includes("> low"));
      expect(String(effortPreference)).toBe("low");
      expect((selectedModel as unknown as { reasoningEffort: string }).reasoningEffort).toBe("low");

      setup.mockInput.pressEscape();
      await Bun.sleep(50);
      await setup.mockInput.typeText("/model");
      setup.mockInput.pressEnter();
      expect(await app.settle()).toBe(true);
      await setup.waitForFrame(value => value.includes("MODEL") && value.includes("OpenAI"));
      setup.mockInput.pressKey("x");
      expect(await app.settle()).toBe(true);
      frame = await setup.waitForFrame(value => value.includes("> ○ OpenAI") && value.includes("not configured"));
      expect(submittedKeys).toEqual([secret, null]);
      expect(frame).not.toContain(secret);

      setup.resize(78, 24);
      frame = await setup.waitForFrame(value => value.includes("MODEL") && value.includes("gpt-inspector-test"));
      expect(frame).toContain("Providers");
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
      let frame = await setup.waitForFrame(value => value.includes("Root agent / main") && value.includes("1 agent: 1 idle"));
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
      frame = await setup.waitForFrame(value => value.includes("> 1 agent: 1 idle"));
      expect(frame).toContain("Enter/→ agents");
      await setup.mockInput.typeText("x");
      frame = await setup.waitForFrame(value => value.includes("x") && value.includes("↓ agents"));
      expect(frame).not.toContain("AGENT FAMILY");

      setup.mockInput.pressKey("u", { ctrl: true });
      setup.mockInput.pressKey("\u001b[B");
      setup.mockInput.pressEnter();
      frame = await setup.waitForFrame(value => value.includes("AGENT FAMILY") && value.includes("› ○ Reviewer · idle"));
      expect(frame).toContain("Review the implementation");
      expect(frame).toContain("echo:echo-1");
      app.showOutput("Switched to Root agent/main.");
      frame = await setup.waitForFrame(value =>
        value.includes("Switched to Root agent/main.")
        && value.includes("› ○ Reviewer · idle"));
      const familyList = setup.renderer.root.findDescendantById("agencity-details-text") as TextRenderable;
      const selectedChild = familyList.chunks.find(chunk =>
        chunk.text.includes("Reviewer") && chunk.bg?.toInts().slice(0, 3).join(",") === "38,79,120");
      expect(selectedChild).toBeDefined();

      setup.resize(72, 16);
      frame = await setup.waitForFrame(value => value.includes("AGENT FAMILY") && value.includes("TRUSTED-LOCAL"));
      expect(frame).toContain("Reviewer");
      expect(frame).toContain("Ask Agencity");
      setup.resize(52, 9);
      frame = await setup.waitForFrame(value => value.includes("Reviewer") && value.includes("TRUSTED-LOCAL"));
      expect(frame).toContain("Enter/→ open");
      setup.resize(52, 6);
      frame = await setup.waitForFrame(value => value.includes("AGENT FAMILY") && value.includes("TRUSTED-LOCAL"));
      expect(frame).toContain("Ask Agencity");
      expect(frame).not.toContain("1 agent: 1 working");
      setup.resize(52, 9);
      await setup.waitForFrame(value => value.includes("Reviewer") && value.includes("Enter/→ open"));

      setup.mockInput.pressKey("\u001b[C");
      expect(await app.settle()).toBe(true);
      frame = await setup.waitForFrame(value => value.includes("Root agent › Reviewer / unnamed branch"));
      expect(frame).toContain("1 agent: 1 idle");
      expect(frame).toContain("Esc close");
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
      expect(frame).toContain("Enter or → to open");

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

  test("opens, searches, refreshes, and selects workspace roots without exposing route IDs", async () => {
    const temp = await makeTempRuntime("agencity-opentui-workspace-agents-"); temps.push(temp);
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
      model: { provider: "echo", model: "echo-1" },
    });
    const second = await supervisor.createSession({
      workspaceId: "terminal-workspace-agents",
      sessionName: "Second root",
      branchName: "main",
      model: { provider: "echo", model: "echo-1" },
    });
    const child = await supervisor.agents.spawn(first.sessionId, first.branchId, {
      task: "Nested route command entry",
      name: "Nested child",
      run: false,
    });
    const catalogRow = (
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
      taskSummary: `${sessionName} retained task`,
      activeGoals: sessionName === "First root" ? 1 : 0,
      unresolvedWork: sessionName === "First root" ? 2 : 0,
      createdAt: "2026-08-08T11:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
      root,
      initialBranch: true,
    });
    const catalogRows = [
      catalogRow(first.sessionId, first.branchId, "First root", "idle"),
      catalogRow(second.sessionId, second.branchId, "Second root", "stopped"),
      catalogRow(child.sessionId, child.branchId, "Nested child", "idle", false),
      catalogRow("failed-internal-session", "failed-internal-branch", "Failed root", "failed"),
      catalogRow("archived-internal-session", "archived-internal-branch", "Archived root", "archived"),
    ];
    const base = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
    const selections: Array<[string | undefined, string | undefined]> = [];
    let catalogCalls = 0;
    const client = new Proxy(base, {
      get(target, property) {
        if (property === "capabilities") return async () => ({
          ...await base.capabilities(),
          productCatalog: true,
        });
        if (property === "productSessions") return async () => {
          catalogCalls++;
          return catalogRows;
        };
        if (property === "productSelect") return async (sessionId?: string, branchId?: string) => {
          selections.push([sessionId, branchId]);
          return { sessionId: sessionId!, branchId: branchId! };
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let app: OpenTuiApp | null = null;
    const terminal = new TerminalUI(client, {
      workspaceLabel: "Fixture workspace",
      interactive: false,
      manageSignals: false,
      onOutput: value => app?.showOutput(value),
      onDetail: detail => app?.showDetail(detail),
    });
    await terminal.attach(first.sessionId, first.branchId, false);
    const setup = await createTestRenderer({ width: 112, height: 28, kittyKeyboard: true });
    app = new OpenTuiApp(setup.renderer, terminal);
    try {
      let frame = await setup.waitForFrame(value => value.includes("First root / main") && value.includes("← agents"));
      const composer = setup.renderer.root.findDescendantById("agencity-composer") as TextareaRenderable;

      await setup.mockInput.typeText("draft stays");
      setup.mockInput.pressKey("\u001b[D");
      frame = await setup.waitForFrame(value => value.includes("draft stays") && value.includes("First root / main"));
      expect(frame).not.toContain("Catalog current");
      setup.mockInput.pressKey("a", { ctrl: true });
      setup.mockInput.pressKey("k", { ctrl: true });

      setup.mockInput.pressKey("\u001b[D");
      expect(await app.settle()).toBe(true);
      frame = await setup.waitForFrame(value =>
        value.includes("Agents")
        && value.includes("First root")
        && value.includes("Second root")
        && value.includes("Failed root")
        && value.includes("Archived root")
        && value.includes("Search retained root work"));
      expect(frame).toContain("Fixture workspace");
      expect(frame).not.toContain("terminal-workspace-agents");
      expect(frame).toContain("cannot open");
      expect(frame).toContain("Ctrl-N new");
      expect(frame).toContain("TRUSTED-LOCAL");
      expect(frame).not.toMatch(/failed-internal-session|failed-internal-branch|Nested child/);
      expect(selections).toEqual([]);
      app.showOutput("Switched to First root/main.");
      frame = await setup.waitForFrame(value =>
        value.includes("Switched to First root/main.")
        && value.includes("First root")
        && value.includes("Second root"));
      const notice = setup.renderer.root.findDescendantById("agencity-notice") as TextRenderable;
      const agentsList = setup.renderer.root.findDescendantById("agencity-details-text") as TextRenderable;
      const selectedAgent = agentsList.chunks.find(chunk =>
        chunk.text.includes("First root") && chunk.bg?.toInts().slice(0, 3).join(",") === "38,79,120");
      expect(notice.visible).toBe(true);
      expect(notice.fg?.toInts().slice(0, 3)).toEqual([63, 185, 80]);
      expect(selectedAgent).toBeDefined();
      expect(agentsList.fg?.toInts().slice(0, 3)).toEqual([139, 148, 158]);
      setup.mockInput.pressKey("p", { ctrl: true });
      frame = await setup.waitForFrame(value => value.includes("Close Agents before opening commands."));
      expect(frame).toContain("Agents");
      expect(frame).not.toContain("COMMANDS");
      setup.mockInput.pressEscape();
      frame = await setup.waitForFrame(value => value.includes("First root / main"));
      expect(frame).not.toContain("COMMANDS");

      setup.mockInput.pressKey("\u001b[D");
      expect(await app.settle()).toBe(true);
      await setup.waitForFrame(value => value.includes("Agents") && value.includes("First root"));
      setup.mockInput.pressKey("\u001b[6~");
      frame = await setup.waitForFrame(value => value.includes("› Archived root"));
      expect(frame).toContain("cannot open");
      setup.mockInput.pressKey("\u001b[5~");
      await setup.waitForFrame(value => value.includes("› First root"));

      await setup.mockInput.typeText("failed");
      frame = await setup.waitForFrame(value => value.includes("Failed root") && !value.includes("Second root"));
      setup.mockInput.pressEnter();
      frame = await setup.waitForFrame(value => value.includes("Failed root is failed and cannot be opened"));
      expect(selections).toEqual([]);
      setup.mockInput.pressEscape();
      frame = await setup.waitForFrame(value => value.includes("Second root") && composer.plainText === "");
      expect(frame).toContain("Agents");
      setup.mockInput.pressKey("\u001b[D");
      frame = await setup.waitForFrame(value => value.includes("Agents") && value.includes("Second root"));
      expect(terminal.presentation.workspaceAgents.open).toBe(true);
      setup.mockInput.pressEscape();
      frame = await setup.waitForFrame(value => value.includes("First root / main") && !value.includes("Catalog current"));

      await terminal.openFamilyChild(child.sessionId, child.branchId);
      await setup.waitForFrame(value => value.includes("First root › Nested child"));
      await setup.mockInput.typeText("/agents");
      setup.mockInput.pressEnter();
      expect(await app.settle()).toBe(true);
      frame = await setup.waitForFrame(value => value.includes("Agents") && value.includes("Second root"));
      expect(terminal.presentation.workspaceAgents.returnRoute).toEqual({
        sessionId: child.sessionId,
        branchId: child.branchId,
      });
      setup.mockInput.pressEscape();
      await setup.waitForFrame(value => value.includes("First root › Nested child"));
      await terminal.openFamilyParent();
      await setup.waitForFrame(value => value.includes("First root / main"));

      setup.mockInput.pressKey("\u001b[D");
      expect(await app.settle()).toBe(true);
      await setup.waitForFrame(value => value.includes("Agents") && value.includes("Second root"));
      setup.mockInput.pressKey("\u001b[B");
      setup.mockInput.pressKey("\u001b[C");
      expect(await app.settle()).toBe(true);
      frame = await setup.waitForFrame(value => value.includes("Second root / main") && value.includes("← agents"));
      expect(selections).toEqual([[second.sessionId, second.branchId]]);
      expect(catalogCalls).toBe(5);

      setup.mockInput.pressKey("\u001b[D");
      expect(await app.settle()).toBe(true);
      const beforeRefresh = catalogCalls;
      setup.mockInput.pressKey("r", { ctrl: true });
      expect(await app.settle()).toBe(true);
      expect(catalogCalls).toBe(beforeRefresh + 1);
      setup.resize(58, 9);
      frame = await setup.waitForFrame(value =>
        value.includes("Agents") && value.includes("Second root") && value.includes("TRUSTED-LOCAL"));
      expect(frame).toContain("Search retained root work");
      setup.resize(48, 6);
      frame = await setup.waitForFrame(value =>
        value.includes("AGENTS") && value.includes("Second root") && value.includes("TRUSTED-LOCAL"));
      expect(frame).toContain("Esc back");
      expect(frame).toContain("Ctrl-N new");
      setup.mockInput.pressKey("\u001b[6~");
      frame = await setup.waitForFrame(value => value.includes("AGENTS") && value.includes("Failed root"));
      expect(frame).toContain("cannot open");
      const previousSessionId = terminal.presentation.state.sessionId;
      setup.mockInput.pressKey("n", { ctrl: true });
      expect(await app.settle()).toBe(true);
      expect(terminal.presentation.state.sessionId).not.toBe(previousSessionId);
      expect(terminal.presentation.workspaceAgents.open).toBe(false);
      expect(selections.at(-1)).toEqual([
        terminal.presentation.state.sessionId,
        terminal.presentation.state.branch.id,
      ]);
    } finally {
      app.destroy();
      setup.renderer.destroy();
      await terminal.detach(false);
      await supervisor.close();
    }
  });

  test("retains committed message and cell renderables across unrelated updates", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const host = new ScrollBoxRenderable(setup.renderer, {
      id: "transcript-identity-host",
      width: "100%",
      height: "100%",
      scrollY: true,
      scrollX: false,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    setup.renderer.root.add(host);
    const syntaxStyle = createTerminalSyntaxStyle();
    const view: TerminalScreenView = {
      workspaceId: "workspace",
      workspaceLabel: "Workspace",
      sessionName: "Transcript",
      branchName: "main",
      model: "fixture:model",
      providerMode: "committed",
      connection: "connected",
      historicalCursor: null,
      ancestry: ["Transcript"],
      conversation: [
        {
          id: "agent-run-task-run-1",
          role: "user",
          content: "Inspect retained output",
        },
        {
          id: "message-1",
          role: "assistant",
          content: "# Result\n\nA **structured** answer.\n\n```typescript\nconst value = 42;\n```",
        },
      ],
      runs: [{
        id: "run-1",
        task: "Inspect retained output",
        taskMessageId: "agent-run-task-run-1",
        finalMessageId: "message-1",
        status: "succeeded",
        statusLabel: "succeeded",
        active: false,
        actionPending: false,
        provisional: false,
        cancellationRequested: false,
        reason: null,
        steps: [{
          id: "step-1",
          ordinal: 1,
          label: "TypeScript cell",
          detail: "const value = 42;",
          attempts: 2,
          formalOutcome: {
            kind: "formal-submission",
            contractId: "agencity.agent-tools.v1",
            contractVersion: 1,
            tool: "bun_console",
            schemaEnforcement: "provider-strict",
            source: "model-call",
          },
          cell: {
            id: "agent-run-cell-action-1",
            language: "typescript",
            code: "const value = 42;\nreturn { value };",
            status: "committed",
            attempts: 1,
            logs: ["computed log", "failed log"],
            logStreams: ["stdout", "stderr"],
            result: { exitCode: 0, stdout: "command output", stderr: "command warning" },
            error: null,
          },
        }],
      }],
      familyChildren: [],
      familyParent: null,
      familySummary: null,
      familyRoot: true,
      familyRefresh: "current",
      workspaceAgents: {
        open: false,
        returnRoute: { sessionId: "session", branchId: "branch" },
        rows: [],
        sections: [],
        selectedKey: null,
        query: "",
        refresh: "unavailable",
        fetchedAt: null,
      },
      runState: "succeeded",
      composerPlaceholder: "Ask Agencity…",
      attentionCount: 0,
      recoveryLabel: "recovery healthy",
      budgetLabel: "2 turns · 20 tokens",
      trustLabel: "TRUSTED-LOCAL",
    };
    try {
      const transcript = new TerminalTranscript(setup.renderer, host, syntaxStyle);
      transcript.reconcile(view, new Set(["run-1"]));
      await setup.waitForFrame(value =>
        value.includes("const value = 42;")
        && value.includes("computed log")
        && value.includes("command output"),
      );
      const message = setup.renderer.root.findDescendantById(
        "agencity-transcript-message-body-message-1",
      ) as MarkdownRenderable;
      const source = setup.renderer.root.findDescendantById(
        "agencity-transcript-cell-source-agent-run-cell-action-1",
      ) as CodeRenderable;
      const compactSource = setup.renderer.root.findDescendantById(
        "agencity-transcript-cell-compact-source-agent-run-cell-action-1",
      ) as CodeRenderable;
      const details = setup.renderer.root.findDescendantById(
        "agencity-transcript-cell-details-agent-run-cell-action-1",
      ) as BoxRenderable;
      const cellRoot = setup.renderer.root.findDescendantById(
        "agencity-transcript-step-step-1",
      ) as BoxRenderable;
      expect(message).toBeInstanceOf(MarkdownRenderable);
      expect(source).toBeInstanceOf(CodeRenderable);
      expect(compactSource).toBeInstanceOf(CodeRenderable);
      expect(details).toBeInstanceOf(BoxRenderable);
      expect(details.border).toBe(true);
      expect(details.borderStyle).toBe("rounded");
      expect(details.screenX).toBeGreaterThan(cellRoot.screenX);
      expect((await setup.captureCharFrame()).toString()).toContain("╭");
      expect(compactSource.filetype).toBe("typescript");
      expect(compactSource.content).toEndWith("…");
      expect(message.content).toBe(view.conversation[1]!.content);
      expect(source.content).toBe(view.runs[0]!.steps[0]!.cell!.code);
      expect(host.getChildren().map(child => child.id)).toEqual([
        "agencity-transcript-message-agent-run-task-run-1",
        "agencity-transcript-run-run-1",
        "agencity-transcript-message-message-1",
      ]);
      expect(setup.renderer.root.findDescendantById("agencity-transcript-activity-heading")).toBeUndefined();
      const logs = setup.renderer.root.findDescendantById(
        "agencity-transcript-cell-logs-agent-run-cell-action-1",
      ) as TextRenderable;
      const stdoutNode = logs.textNode.children.find(child =>
        typeof child !== "string" && child.children.join("").includes("computed log"));
      const stderrNode = logs.textNode.children.find(child =>
        typeof child !== "string" && child.children.join("").includes("failed log"));
      expect(typeof stdoutNode === "string" ? 0 : (stdoutNode?.attributes ?? 0) & TextAttributes.DIM)
        .toBe(TextAttributes.DIM);
      expect(typeof stderrNode === "string" ? 0 : (stderrNode?.attributes ?? 0) & TextAttributes.DIM)
        .toBe(TextAttributes.DIM);
      expect(typeof stdoutNode === "string" ? null : stdoutNode?.fg?.toInts().slice(0, 3))
        .toEqual([63, 185, 80]);
      expect(typeof stderrNode === "string" ? null : stderrNode?.fg?.toInts().slice(0, 3))
        .toEqual([248, 81, 73]);
      const output = setup.renderer.root.findDescendantById(
        "agencity-transcript-cell-output-agent-run-cell-action-1",
      ) as TextRenderable;
      expect(output.textNode.children.some(child =>
        typeof child !== "string" && child.children.join("").includes("command output"))).toBe(true);
      expect(output.textNode.children.some(child =>
        typeof child !== "string" && child.children.join("").includes("command warning"))).toBe(true);
      const frame = (await setup.captureCharFrame()).toString();
      expect(frame).toContain("OUTPUT");
      expect(frame).not.toContain("exitCode");
      expect(frame).not.toContain("\"stdout\"");
      setup.renderer.startSelection(source, source.screenX, source.screenY);
      setup.renderer.updateSelection(
        logs,
        logs.screenX + Math.max(1, logs.width - 1),
        logs.screenY + Math.max(0, logs.height - 1),
        { finishDragging: true },
      );
      const selected = setup.renderer.getSelection()?.getSelectedText() ?? "";
      expect(selected).toContain(source.content);
      expect(selected).toContain("computed log");
      setup.renderer.clearSelection();

      const activeView: TerminalScreenView = {
        ...view,
        runs: [{
          ...view.runs[0]!,
          finalMessageId: null,
          status: "running",
          statusLabel: "running",
          active: true,
          actionPending: true,
          steps: [view.runs[0]!.steps[0]!],
        }],
      };
      transcript.reconcile(activeView, new Set());
      await setup.waitForFrame(value =>
        value.includes("running")
        && value.includes("const value = 42;")
        && !value.includes("return { value };"),
      );
      expect((await setup.captureCharFrame()).toString()).not.toContain("Waiting for model response");
      expect(setup.renderer.root.findDescendantById("agencity-transcript-cell-details-agent-run-cell-action-1")?.visible)
        .toBe(false);

      transcript.reconcile(view, new Set());
      await setup.waitForFrame(value => value.includes("Ctrl-O to expand latest") && !value.includes("return { value };"));
      const latestSummary = setup.renderer.root.findDescendantById(
        "agencity-transcript-run-summary-run-1",
      ) as TextRenderable;
      const latestHint = latestSummary.textNode.children.find(child =>
        typeof child !== "string" && child.children.join("").includes("Ctrl-O to expand latest"));
      expect(typeof latestHint === "string" ? 0 : (latestHint?.attributes ?? 0) & TextAttributes.DIM)
        .toBe(TextAttributes.DIM);

      const previousRun = {
        ...view.runs[0]!,
        id: "run-0",
        taskMessageId: "missing-task-message",
        finalMessageId: null,
      };
      transcript.reconcile({ ...view, runs: [previousRun, view.runs[0]!] }, new Set());
      await setup.waitForFrame(value =>
        value.includes("Ctrl-L to expand all") && value.includes("Ctrl-O to expand latest"));
      const previousSummary = setup.renderer.root.findDescendantById(
        "agencity-transcript-run-summary-run-0",
      ) as TextRenderable;
      const previousHint = previousSummary.textNode.children.find(child =>
        typeof child !== "string" && child.children.join("").includes("Ctrl-L to expand all"));
      expect(typeof previousHint === "string" ? 0 : (previousHint?.attributes ?? 0) & TextAttributes.DIM)
        .toBe(TextAttributes.DIM);

      transcript.reconcile(view, new Set());
      expect(setup.renderer.root.findDescendantById("agencity-transcript-cell-source-agent-run-cell-action-1"))
        .toBe(source);
      transcript.reconcile(view, new Set(["run-1"]));
      await setup.waitForFrame(value => value.includes("return { value };"));

      transcript.reconcile({ ...view, connection: "reconnecting", familyRefresh: "refreshing" }, new Set(["run-1"]));
      expect(setup.renderer.root.findDescendantById("agencity-transcript-message-body-message-1"))
        .toBe(message);
      expect(setup.renderer.root.findDescendantById("agencity-transcript-cell-source-agent-run-cell-action-1"))
        .toBe(source);
      await source.highlightingDone;
      await Bun.sleep(25);
    } finally {
      host.destroyRecursively();
      syntaxStyle.destroy();
      setup.renderer.destroy();
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

  test("toggles every completed run while leaving active work alone", () => {
    const expanded = new Set<string>();
    const runs = [
      { id: "older", active: false, steps: [{}] },
      { id: "newer", active: false, steps: [{}] },
      { id: "active", active: true, steps: [{}] },
    ] as unknown as TerminalScreenView["runs"];
    expect(toggleAllRunDetails(runs, expanded)).toBe(true);
    expect([...expanded].sort()).toEqual(["newer", "older"]);
    expect(toggleAllRunDetails(runs, expanded)).toBe(true);
    expect([...expanded]).toEqual([]);
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


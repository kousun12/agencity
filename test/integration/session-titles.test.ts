import { afterEach, describe, expect, test } from "bun:test";
import {
  DECLARED_DATA_CONTRACT_ID,
  LibSqlStorage,
  SESSION_TITLE_MODEL,
  SESSION_TITLE_SYSTEM_INSTRUCTION,
  Supervisor,
  nativeModelId,
  projectEvents,
  resolveSessionTitlePresentation,
  validateNewEvent,
  type JsonValue,
  type ModelConfiguration,
  type ModelDispatch,
  type ModelEffectOutputV2,
  type ModelProvider,
  type TextModelResponse,
} from "../../src/index.ts";
import { ProductCatalog } from "../../src/product/index.ts";
import {
  formalMissingToolOutput,
  formalOutputFromDeclaredData,
} from "../../src/executors/model-response.ts";
import {
  makeTempRuntime,
  removeTempRuntime,
  waitFor,
  type TempRuntime,
} from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

class TitleProvider implements ModelProvider {
  readonly displayName: string;
  readonly contexts: JsonValue[] = [];
  readonly dispatches: ModelDispatch[] = [];
  readonly capabilities = {
    streaming: false,
    reasoningControl: "none",
    requiredToolSet: {
      status: "provider-strict",
      requiredChoice: "provider-enforced",
      parallelCalls: "provider-disabled",
      streaming: true,
      adapter: "agencity.session-title.fixture.v1",
    },
    contextWindowTokens: 128_000,
    contextCapacitySource: "model-catalog",
  } as const;

  constructor(
    readonly name: "openai" | "vercel",
    readonly output: "valid" | "invalid" = "valid",
  ) {
    this.displayName = `${name} title fixture`;
  }

  async complete(
    _context: JsonValue,
    _configuration: ModelConfiguration,
    _signal: AbortSignal,
  ): Promise<TextModelResponse> {
    throw new Error("Title fixture requires structured streaming");
  }

  async streamResponse(
    context: JsonValue,
    dispatch: ModelDispatch,
    signal: AbortSignal,
  ): Promise<ModelEffectOutputV2> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.contexts.push(context);
    this.dispatches.push(dispatch);
    if (this.output === "invalid") {
      return formalMissingToolOutput({
        dispatch,
        provider: this.name,
        adapter: this.capabilities.requiredToolSet.adapter,
        text: "not structured",
        usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.001 },
      });
    }
    return formalOutputFromDeclaredData({
      value: {
        verb: "Fix",
        subject: "flaky payment integration tests",
        intentSummary: "Fix the flaky payment integration tests without changing unrelated behavior.",
      },
      dispatch,
      providerToolCallId: `title-${this.dispatches.length}`,
      provider: this.name,
      adapter: this.capabilities.requiredToolSet.adapter,
      usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.001 },
    });
  }
}

class DeferredTitleProvider extends TitleProvider {
  readonly releases: Array<() => void> = [];

  override async streamResponse(
    context: JsonValue,
    dispatch: ModelDispatch,
    signal: AbortSignal,
  ): Promise<ModelEffectOutputV2> {
    const ordinal = this.dispatches.length + 1;
    this.contexts.push(context);
    this.dispatches.push(dispatch);
    await new Promise<void>((resolve, reject) => {
      this.releases.push(resolve);
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    return formalOutputFromDeclaredData({
      value: ordinal === 1
        ? { verb: "Fix", subject: "stale request", intentSummary: "The stale title result." }
        : { verb: "Repair", subject: "latest request", intentSummary: "The latest title result." },
      dispatch,
      providerToolCallId: `deferred-title-${ordinal}`,
      provider: this.name,
      adapter: this.capabilities.requiredToolSet.adapter,
      usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.001 },
    });
  }
}

async function open(provider: ModelProvider, recover = false): Promise<{
  temp: TempRuntime;
  supervisor: Supervisor;
}> {
  const temp = await makeTempRuntime("agencity-session-title-");
  temps.push(temp);
  const supervisor = await Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    modelProviders: [provider],
    providerConcurrency: 2,
    recover,
  });
  return { temp, supervisor };
}

async function titleState(
  supervisor: Supervisor,
  sessionId: string,
  branchId: string,
) {
  return projectEvents(await supervisor.storage.loadEvents(sessionId, { branchId }));
}

describe("automatic maintained session titles", () => {
  test("rejects title results that disagree with structured fields", () => {
    expect(() => validateNewEvent({
      sessionId: "title-validation",
      branchId: "main",
      type: "SessionTitleResolved",
      producer: "supervisor",
      payload: {
        requestId: "title-request",
        sourceMessageEventId: "user-message",
        sourceMessageCursor: "00000000000000000002",
        sourceMessageEventIds: ["user-message"],
        sourceBranchId: "main",
        method: "fallback",
        title: "Wrong title",
        verb: "Fix",
        subject: "checkout retries",
        intentSummary: "Fix checkout retries.",
        fallbackReason: "test",
      },
    })).toThrow("Invalid SessionTitleResolved payload");
  });

  test.each(["vercel", "openai"] as const)(
    "routes %s title calls through Luna with user-only context",
    async (route) => {
      const provider = new TitleProvider(route);
      const { supervisor } = await open(provider);
      try {
        const session = await supervisor.createSession({
          workspaceId: `title-${route}`,
          model: { provider: route, model: route === "openai" ? "openai/gpt-5.6-sol" : "anthropic/claude-fable-5" },
        });
        await supervisor.appendMessage(session.sessionId, session.branchId, "user", "Fix flaky payment tests");
        await supervisor.appendMessage(session.sessionId, session.branchId, "assistant", "Assistant content must stay out");
        await supervisor.appendMessage(session.sessionId, session.branchId, "tool", "Tool content must stay out");
        await supervisor.appendMessage(session.sessionId, session.branchId, "user", "Keep the change focused");
        await waitFor(async () =>
          Object.keys((await titleState(supervisor, session.sessionId, session.branchId))
            .sessionTitle.resolutions).length === 2, "two title results");

        const state = await titleState(supervisor, session.sessionId, session.branchId);
        expect(state.sessionName).toBe("Fix flaky payment integration tests");
        expect(provider.dispatches.at(-1)?.configuration).toMatchObject({
          provider: route,
          model: SESSION_TITLE_MODEL,
        });
        expect(nativeModelId(
          route,
          provider.dispatches.at(-1)!.configuration.model,
        )).toBe(route === "openai" ? "gpt-5.6-luna" : SESSION_TITLE_MODEL);
        expect(provider.dispatches.at(-1)?.responseContract).toMatchObject({
          contractId: DECLARED_DATA_CONTRACT_ID,
        });
        const messages = (provider.contexts.at(-1) as any).messages;
        expect(messages.map((message: any) => [message.role, message.content])).toEqual([
          ["system", SESSION_TITLE_SYSTEM_INSTRUCTION],
          ["user", "Fix flaky payment tests"],
          ["user", "Keep the change focused"],
        ]);
        expect(state.budget).toMatchObject({ tokens: 0, costUsd: 0, turns: 0 });
        const summary = (await new ProductCatalog(
          supervisor,
          `title-${route}`,
        ).list())[0]!;
        expect(summary.sessionTitle).toEqual({
          text: state.sessionName!,
          source: "model",
          verb: "Fix",
          subject: "flaky payment integration tests",
          intentSummary: "Fix the flaky payment integration tests without changing unrelated behavior.",
          sourceMessageCursor: state.sessionTitle.appliedSourceMessageCursor,
        });
        const requested = Object.values(state.sessionTitle.requests).at(-1)!;
        expect(requested.providerInput?.messages.map((message) => message.kind === "text"
          ? [message.role, message.content]
          : [message.kind])).toEqual([
          ["system", SESSION_TITLE_SYSTEM_INSTRUCTION],
          ["user", "Fix flaky payment tests"],
          ["user", "Keep the change focused"],
        ]);
      } finally {
        await supervisor.close();
      }
    },
  );

  test("the latest user-message frontier wins out-of-order settlements", async () => {
    const provider = new DeferredTitleProvider("openai");
    const { supervisor } = await open(provider);
    try {
      const session = await supervisor.createSession({
        workspaceId: "latest-title",
        model: { provider: "openai", model: "openai/gpt-5.6-sol" },
      });
      await supervisor.appendMessage(session.sessionId, session.branchId, "user", "Fix the first request");
      await waitFor(() => provider.dispatches.length === 1, "first title dispatch");
      await supervisor.appendMessage(session.sessionId, session.branchId, "user", "Repair the latest request");
      await waitFor(() => provider.dispatches.length === 2, "second title dispatch");

      provider.releases[1]!();
      await waitFor(async () => (await titleState(
        supervisor, session.sessionId, session.branchId,
      )).sessionName === "Repair latest request", "latest title settlement");
      provider.releases[0]!();
      await waitFor(async () => Object.keys((await titleState(
        supervisor, session.sessionId, session.branchId,
      )).sessionTitle.resolutions).length === 2, "stale title settlement");

      const state = await titleState(supervisor, session.sessionId, session.branchId);
      expect(state.sessionName).toBe("Repair latest request");
      expect(state.sessionTitle.appliedSourceMessageCursor)
        .toBe(state.sessionTitle.latestRequestedSourceMessageCursor);
    } finally {
      for (const release of provider.releases) release();
      await supervisor.close();
    }
  });

  test("uses a deterministic bounded fallback for invalid structured output", async () => {
    const provider = new TitleProvider("openai", "invalid");
    const { supervisor } = await open(provider);
    try {
      const session = await supervisor.createSession({
        workspaceId: "invalid-title",
        model: { provider: "openai", model: "openai/gpt-5.6-sol" },
      });
      await supervisor.appendMessage(session.sessionId, session.branchId, "user", "Investigate malformed checkout responses");
      await waitFor(async () =>
        Object.keys((await titleState(supervisor, session.sessionId, session.branchId))
          .sessionTitle.resolutions).length === 1, "fallback title");
      const state = await titleState(supervisor, session.sessionId, session.branchId);
      expect(state.sessionName).toBe("Investigate malformed checkout responses");
      expect(Object.values(state.sessionTitle.resolutions)[0]).toMatchObject({
        method: "fallback",
        verb: "Investigate",
      });
      expect(state.sessionName!.trim().split(/\s+/).length).toBeLessThanOrEqual(6);
    } finally {
      await supervisor.close();
    }
  });

  test("manual names outrank later automatic results until re-enabled", async () => {
    const provider = new TitleProvider("openai");
    const { supervisor } = await open(provider);
    try {
      const session = await supervisor.createSession({
        workspaceId: "manual-title",
        model: { provider: "openai", model: "openai/gpt-5.6-sol" },
      });
      await supervisor.appendMessage(session.sessionId, session.branchId, "user", "Fix first issue");
      await waitFor(async () => (await titleState(
        supervisor, session.sessionId, session.branchId,
      )).sessionName !== null, "initial title");
      await supervisor.nameSession(session.sessionId, session.branchId, "Manual checkout audit");
      await supervisor.appendMessage(session.sessionId, session.branchId, "user", "Also repair retries");
      await waitFor(async () => Object.keys((await titleState(
        supervisor, session.sessionId, session.branchId,
      )).sessionTitle.resolutions).length === 2, "post-manual title result");
      expect((await titleState(supervisor, session.sessionId, session.branchId))
        .sessionName).toBe("Manual checkout audit");
      expect((await new ProductCatalog(supervisor, "manual-title").list())[0]?.sessionTitle)
        .toEqual({
          text: "Manual checkout audit",
          source: "explicit",
          verb: null,
          subject: null,
          intentSummary: null,
          sourceMessageCursor: null,
        });

      await supervisor.sessionTitles.enableAutomatic(
        session.sessionId,
        session.branchId,
      );
      await waitFor(async () => (await titleState(
        supervisor, session.sessionId, session.branchId,
      )).sessionTitle.mode === "automatic" &&
        (await titleState(supervisor, session.sessionId, session.branchId))
          .sessionName === "Fix flaky payment integration tests", "re-enabled title");
      expect((await new ProductCatalog(supervisor, "manual-title").list())[0]?.sessionTitle)
        .toMatchObject({
          text: "Fix flaky payment integration tests",
          source: "model",
        });
    } finally {
      await supervisor.close();
    }
  });

  test("unsupported providers derive a fallback without a model effect", async () => {
    const temp = await makeTempRuntime("agencity-session-title-fallback-");
    temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    try {
      const session = await supervisor.createSession({ workspaceId: "echo-title" });
      await supervisor.appendMessage(session.sessionId, session.branchId, "user", "Inspect local state");
      const state = await titleState(supervisor, session.sessionId, session.branchId);
      expect(resolveSessionTitlePresentation(state, "Start new session", true))
        .toMatchObject({
          text: "Inspect local state",
          source: "deterministic_fallback",
          verb: "Inspect",
        });
      expect(Object.keys(state.sessionTitle.resolutions)).toHaveLength(0);
      expect(Object.keys(state.effects)).toHaveLength(0);
    } finally {
      await supervisor.close();
    }
  });

  test("applies one resolved title across every session branch", async () => {
    const temp = await makeTempRuntime("agencity-session-title-branches-");
    temps.push(temp);
    const provider = new TitleProvider("openai");
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    try {
      const session = await supervisor.createSession({
        workspaceId: "branch-title",
        model: { provider: "openai", model: "openai/gpt-5.6-sol" },
      });
      const beforeFork = (await supervisor.storage.loadEvents(
        session.sessionId,
        { branchId: session.branchId },
      )).at(-1)!;
      await supervisor.storage.appendEvents([{
        sessionId: session.sessionId,
        branchId: "child",
        type: "BranchCreated",
        producer: "client",
        idempotencyKey: "branch:child-title",
        payload: {
          branchId: "child",
          parentBranchId: session.branchId,
          forkCursor: beforeFork.cursor,
        },
      }]);
      await supervisor.appendMessage(
        session.sessionId,
        session.branchId,
        "user",
        "Inspect branch naming",
      );
      await waitFor(async () => {
        const parent = await titleState(supervisor, session.sessionId, session.branchId);
        const child = await titleState(supervisor, session.sessionId, "child");
        return parent.sessionName === "Fix flaky payment integration tests" &&
          child.sessionName === parent.sessionName;
      }, "session-wide branch title");
    } finally {
      await supervisor.close();
    }
  });

  test("recovery admits a title for a committed user message", async () => {
    const temp = await makeTempRuntime("agencity-session-title-recovery-");
    temps.push(temp);
    const provider = new TitleProvider("openai");
    const first = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const seeded = await first.createSession({
      workspaceId: "recover-title",
      model: {
        provider: "openai",
        model: "openai/gpt-5.6-sol",
      },
    });
    const deviceId = first.device.deviceId;
    await first.close();

    const storage = new LibSqlStorage({ url: temp.databaseUrl, deviceId });
    await storage.migrate();
    await storage.appendEvents([{
      sessionId: seeded.sessionId,
      branchId: seeded.branchId,
      type: "MessageAppended",
      producer: "client",
      idempotencyKey: "recover-title-message",
      payload: {
        messageId: "recover-title-message",
        role: "user",
        content: "Recover title generation",
      },
    }]);
    storage.close();

    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: true,
    });
    try {
      await waitFor(async () => (await titleState(
        supervisor, seeded.sessionId, seeded.branchId,
      )).sessionName === "Fix flaky payment integration tests", "recovered title");
      expect(provider.dispatches).toHaveLength(1);
    } finally {
      await supervisor.close();
    }
  });
});

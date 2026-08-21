import { afterEach, describe, expect, test } from "bun:test";
import {
  AGENT_ACTION_PROTOCOL,
  AGENT_ACTION_VERSION,
  AGENT_TOOL_CONTRACT_ID,
  PROVIDER_INPUT_ESTIMATOR_ID,
  MAX_AGENT_TOOL_INPUT_BYTES,
  AgentClient,
  ProtocolServer,
  ScriptedAgentActionProvider,
  ModelEffectAdmissionService,
  Supervisor,
  agentProfilePin,
  buildProviderInputCandidate,
  estimateProviderInputCandidate,
  newId,
  projectEvents,
  providerInputAdmission,
  stableEffectId,
  type AgentAction,
  type EventPayloads,
  type JsonValue,
  type ModelConfiguration,
  type ModelDispatch,
  type ModelEffectOutputV2,
  type ModelProvider,
  type StartAgentRunInput,
  type TextModelResponse,
} from "../../src/index.ts";
import {
  consumeRequiredToolStream,
  formalOutputFromAgentAction,
  ModelProviderResponseFailureError,
  ModelResponseGuard,
} from "../../src/executors/model-response.ts";
import { FIXTURE_EFFECTIVE_SYSTEM_PROMPT, fixturePromptProvenanceForPin, makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

const action = <T extends Omit<AgentAction, "protocol" | "version">>(value: T): AgentAction => ({
  protocol: AGENT_ACTION_PROTOCOL,
  version: AGENT_ACTION_VERSION,
  ...value,
} as unknown as AgentAction);

const currentProfilePin = async (supervisor: Supervisor, sessionId: string) =>
  agentProfilePin(await supervisor.agentProfiles.active(sessionId));
const iso = (milliseconds: number): string =>
  new Date(milliseconds).toISOString();

class RecordingActions extends ScriptedAgentActionProvider {
  readonly contexts: JsonValue[] = [];
  calls = 0;
  override async complete(context: JsonValue, configuration: ModelConfiguration, signal: AbortSignal): Promise<TextModelResponse> {
    this.contexts.push(context);
    this.calls++;
    return super.complete(context, configuration, signal);
  }
}

class ContextSensitiveActions implements ModelProvider {
  readonly name = "context-sensitive-actions";
  readonly capabilities = {
    streaming: false,
    reasoningControl: "none",
    requiredToolSet: {
      status: "provider-strict",
      requiredChoice: "provider-enforced",
      parallelCalls: "provider-disabled",
      streaming: true,
      adapter: "agencity.context-sensitive.fixture.v1",
    },
    contextWindowTokens: 128_000,
    contextCapacitySource: "model-catalog",
  } as const;
  readonly contexts: JsonValue[] = [];
  readonly decisions: AgentAction[] = [];
  calls = 0;

  async complete(): Promise<TextModelResponse> {
    throw new Error("Context-sensitive fixture requires formal streaming");
  }

  async streamResponse(
    context: JsonValue,
    dispatch: ModelDispatch,
    signal: AbortSignal,
  ): Promise<ModelEffectOutputV2> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.calls++;
    this.contexts.push(JSON.parse(JSON.stringify(context)) as JsonValue);
    const run = this.#runFromProviderMessages(context);
    const selected = this.#decide(run);
    this.decisions.push(selected);
    return formalOutputFromAgentAction({
      action: selected,
      dispatch,
      providerToolCallId: `context-decision-${this.calls}`,
      provider: this.name,
      adapter: this.capabilities.requiredToolSet.adapter,
      usage: {
        inputTokens: Math.ceil(JSON.stringify(context).length / 4),
        outputTokens: Math.ceil(JSON.stringify(selected).length / 4),
        costUsd: 0,
      },
    });
  }

  #runFromProviderMessages(context: JsonValue): Record<string, JsonValue> {
    if (!context || typeof context !== "object" || Array.isArray(context) ||
        !Array.isArray(context.messages)) {
      throw new Error("Context-sensitive fixture requires normalized provider messages");
    }
    const message = [...context.messages].reverse().find((item) =>
      item && typeof item === "object" && !Array.isArray(item) &&
      item.role === "user" && typeof item.content === "string" &&
      item.content.startsWith("AGENCITY DURABLE RUN STEP\n"));
    if (!message || typeof message !== "object" || Array.isArray(message) ||
        typeof message.content !== "string") {
      throw new Error("Context-sensitive fixture did not receive the durable run step");
    }
    const envelope = JSON.parse(
      message.content.slice("AGENCITY DURABLE RUN STEP\n".length),
    ) as JsonValue;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
        !envelope.run || typeof envelope.run !== "object" ||
        Array.isArray(envelope.run)) {
      throw new Error("Context-sensitive fixture received a malformed run envelope");
    }
    return envelope.run as Record<string, JsonValue>;
  }

  #decide(run: Record<string, JsonValue>): AgentAction {
    if (run.task !== "Build the artifact-backed answer in two durable cells.") {
      throw new Error(`Context-sensitive fixture received an unexpected task: ${run.task}`);
    }
    const observations = Array.isArray(run.observations)
      ? run.observations.filter((item): item is Record<string, JsonValue> =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)))
      : [];
    const committed = [...observations].reverse().find((item) =>
      item.type === "CellCommitted");
    if (!committed) {
      return action({
        type: "typescript",
        code: `
          // Purpose: prepare one durable artifact-backed input.
          const write = await tools.writeFile("context-stage.txt", "prepared-once");
          const artifact = await artifacts.put("context-sensitive-payload", "text/plain");
          return { phase: "prepared", artifact, writeSha256: write.sha256 };
        `,
      });
    }
    const payload = committed.payload && typeof committed.payload === "object" &&
      !Array.isArray(committed.payload)
      ? committed.payload as Record<string, JsonValue>
      : {};
    const result = payload.result && typeof payload.result === "object" &&
      !Array.isArray(payload.result)
      ? payload.result as Record<string, JsonValue>
      : {};
    if (result.phase === "verified") {
      return action({
        type: "final",
        content: "Verified the artifact-backed answer from durable context.",
      });
    }
    const artifact = result.artifact && typeof result.artifact === "object" &&
      !Array.isArray(result.artifact)
      ? result.artifact as Record<string, JsonValue>
      : {};
    if (result.phase !== "prepared" || typeof artifact.artifactId !== "string" ||
        typeof artifact.size !== "number") {
      throw new Error("Reduced provider input omitted the prepared artifact reference");
    }
    return action({
      type: "typescript",
      code: `
        // Purpose: verify the retained artifact and complete the requested file.
        const range = await artifacts.readRange(${JSON.stringify(artifact.artifactId)}, 0, ${artifact.size});
        const content = new TextDecoder().decode(range.value.bytes);
        if (content !== "context-sensitive-payload") throw new Error("artifact content mismatch");
        const write = await tools.writeFile("context-answer.txt", content);
        return { phase: "verified", artifactId: ${JSON.stringify(artifact.artifactId)}, writeSha256: write.sha256 };
      `,
    });
  }
}

class SlowActions extends ScriptedAgentActionProvider {
  readonly delayMs: number;
  calls = 0;
  constructor(script: readonly (AgentAction | string)[], delayMs = 20) {
    super(script, "slow-actions");
    this.delayMs = delayMs;
  }
  override async complete(context: JsonValue, configuration: ModelConfiguration, signal: AbortSignal): Promise<TextModelResponse> {
    this.calls++;
    await Bun.sleep(this.delayMs);
    return super.complete(context, configuration, signal);
  }
}

class HoldingActions extends ScriptedAgentActionProvider {
  calls = 0;
  readonly contexts: JsonValue[] = [];
  readonly entered: Promise<void>;
  #markEntered!: () => void;
  constructor() {
    super([action({ type: "final", content: "Must be cancelled." })], "holding-actions");
    this.entered = new Promise(resolve => { this.#markEntered = resolve; });
  }
  override async complete(context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<TextModelResponse> {
    this.calls++;
    this.contexts.push(context);
    this.#markEntered();
    return new Promise<TextModelResponse>((_resolve, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }
}

class GuardAbortActions {
  readonly name: string = "guard-abort-actions";
  readonly capabilities = {
    streaming: false,
    contextWindowTokens: 128_000,
    contextCapacitySource: "provider-metadata",
    requiredToolSet: {
      status: "runtime-validated",
      requiredChoice: "provider-enforced",
      parallelCalls: "runtime-rejected",
      streaming: true,
      adapter: "agencity.guard-abort.fixture.v1",
    },
  } as const;
  calls = 0;
  async complete(): Promise<TextModelResponse> {
    throw new Error("text completion is not used");
  }
  async streamResponse(
    _context: JsonValue,
    dispatch: ModelDispatch,
    signal: AbortSignal,
    onDelta: (delta: any) => void,
  ): Promise<ModelEffectOutputV2> {
    this.calls++;
    const guard = new ModelResponseGuard(signal);
    return consumeRequiredToolStream({
      dispatch,
      guard,
      onDelta,
      gatewayCost: () => 0,
      stream: {
        fullStream: (async function* () {
          yield { type: "tool-input-start", id: "guard-call", toolName: "bun_console" };
          yield { type: "tool-input-delta", id: "guard-call", delta: "x".repeat(MAX_AGENT_TOOL_INPUT_BYTES + 1) };
        })(),
      },
    });
  }
}

class FailingFormalActions extends GuardAbortActions {
  override readonly name: string = "failing-formal-actions";
  override calls = 0;
  override async streamResponse(): Promise<ModelEffectOutputV2> {
    this.calls++;
    throw new ModelProviderResponseFailureError(
      "stream-failed",
      this.name,
      "failure-v1",
      "Fixture stream failed",
    );
  }
}

class TypedFinishActions implements ModelProvider {
  readonly name = "typed-finish-actions";
  readonly capabilities = {
    streaming: false,
    contextWindowTokens: 128_000,
    contextCapacitySource: "provider-metadata",
    requiredToolSet: {
      status: "provider-strict",
      requiredChoice: "provider-enforced",
      parallelCalls: "provider-disabled",
      streaming: true,
      adapter: "agencity.typed-finish.fixture.v1",
    },
  } as const;
  readonly contexts: JsonValue[] = [];
  readonly dispatches: ModelDispatch[] = [];
  #index = 0;
  constructor(readonly script: readonly JsonValue[]) {}
  async complete(): Promise<TextModelResponse> {
    throw new Error("Typed finish fixture requires formal streaming");
  }
  async streamResponse(
    context: JsonValue,
    dispatch: ModelDispatch,
    signal: AbortSignal,
    onDelta: (delta: any) => void,
  ): Promise<ModelEffectOutputV2> {
    this.contexts.push(context);
    this.dispatches.push(dispatch);
    const input = this.script[this.#index++] ?? {
      outcome: { status: "failed", message: "Typed fixture exhausted" },
    };
    const callId = `typed-finish-${this.#index}`;
    const encoded = JSON.stringify(input);
    const guard = new ModelResponseGuard(signal);
    return consumeRequiredToolStream({
      dispatch,
      guard,
      onDelta,
      gatewayCost: () => 0,
      stream: {
        fullStream: (async function* () {
          yield { type: "tool-input-start", id: callId, toolName: "finish" };
          yield { type: "tool-input-delta", id: callId, delta: encoded };
          yield { type: "tool-input-end", id: callId };
          yield {
            type: "tool-call",
            toolCallId: callId,
            toolName: "finish",
            input,
            dynamic: false,
            invalid: false,
          };
          const usage = { inputTokens: 1, outputTokens: 1 };
          yield {
            type: "finish-step",
            finishReason: "tool-calls",
            rawFinishReason: "tool_calls",
            usage,
          };
          yield {
            type: "finish",
            finishReason: "tool-calls",
            rawFinishReason: "tool_calls",
            totalUsage: usage,
          };
        })(),
      },
    });
  }
}

function textOnlyProvider(name = "text-only-agent-run"): ModelProvider {
  return {
    name,
    capabilities: { streaming: false, reasoningControl: "none" },
    async complete(): Promise<TextModelResponse> {
      return {
        text: "text-only response",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      };
    },
  };
}

async function fixture(script: readonly (AgentAction | string)[], budget: Record<string, number> = {}) {
  const temp = await makeTempRuntime("agencity-agent-run-"); temps.push(temp);
  const provider = new RecordingActions(script, "run-fixture");
  const supervisor = await Supervisor.open({
    databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot, restartConsoleAfterCell: true,
    modelProviders: [provider], recover: false,
  });
  const session = await supervisor.createSession({
    workspaceId: "agent-run", model: { provider: provider.name, model: "scripted-v1" }, budget,
  });
  return { temp, provider, supervisor, ...session };
}

function fixtureContextWindow(provider: string, model: string) {
  return {
    provider, model, source: "model-catalog" as const,
    contextWindowTokens: 128_000, outputReserveTokens: 4_096,
    estimatorId: PROVIDER_INPUT_ESTIMATOR_ID, triggerRatio: 0.8, targetRatio: 0.6,
  };
}

function providerObservations(context: JsonValue): Array<{ eventId: string; type: string; payload: JsonValue }> {
  if (!context || typeof context !== "object" || Array.isArray(context) ||
      !context.run || typeof context.run !== "object" || Array.isArray(context.run) ||
      !Array.isArray(context.run.observations)) return [];
  return context.run.observations as Array<{ eventId: string; type: string; payload: JsonValue }>;
}

function crashAfterNextActionCommit(supervisor: Supervisor): () => void {
  const appendEvents = supervisor.storage.appendEvents.bind(supervisor.storage);
  let crashed = false;
  Object.defineProperty(supervisor.storage, "appendEvents", {
    configurable: true,
    value: async (events: Parameters<typeof appendEvents>[0]) => {
      const appended = await appendEvents(events);
      if (!crashed && events.some(event => event.type === "AgentRunActionCommitted")) {
        crashed = true;
        throw new Error("simulated crash after AgentRunActionCommitted");
      }
      return appended;
    },
  });
  return () => Object.defineProperty(supervisor.storage, "appendEvents", { configurable: true, value: appendEvents });
}

function crashAfterActionRejection(supervisor: Supervisor, occurrence = 1): () => void {
  const appendEvents = supervisor.storage.appendEvents.bind(supervisor.storage);
  let rejections = 0;
  Object.defineProperty(supervisor.storage, "appendEvents", {
    configurable: true,
    value: async (events: Parameters<typeof appendEvents>[0]) => {
      const appended = await appendEvents(events);
      if (events.some(event => event.type === "AgentRunActionRejected") && ++rejections === occurrence) {
        throw new Error("simulated crash after AgentRunActionRejected");
      }
      return appended;
    },
  });
  return () => Object.defineProperty(supervisor.storage, "appendEvents", { configurable: true, value: appendEvents });
}

function crashAfterGoalCheck(supervisor: Supervisor): () => void {
  const appendEvents = supervisor.storage.appendEvents.bind(supervisor.storage);
  let crashed = false;
  Object.defineProperty(supervisor.storage, "appendEvents", {
    configurable: true,
    value: async (events: Parameters<typeof appendEvents>[0]) => {
      const appended = await appendEvents(events);
      if (!crashed && events.some(event => event.type === "AgentRunGoalCheckRecorded")) {
        crashed = true;
        throw new Error("simulated crash after AgentRunGoalCheckRecorded");
      }
      return appended;
    },
  });
  return () => Object.defineProperty(supervisor.storage, "appendEvents", { configurable: true, value: appendEvents });
}

async function runContextSensitiveScenario(
  recoverAfterFirstCell: boolean,
): Promise<{
  readonly nextActionSource: string;
  readonly providerCalls: number;
  readonly cellCount: number;
  readonly fileEffectCount: number;
  readonly modelEffectCount: number;
  readonly stablePrefixMessages: number;
}> {
  const temp = await makeTempRuntime(
    recoverAfterFirstCell
      ? "agencity-context-decision-recovery-"
      : "agencity-context-decision-normal-",
  );
  temps.push(temp);
  const provider = new ContextSensitiveActions();
  let supervisor = await Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    restartConsoleAfterCell: true,
    modelProviders: [provider],
    recover: false,
  });
  const session = await supervisor.createSession({
    workspaceId: "context-decision",
    model: { provider: provider.name, model: "context-v1" },
  });
  if (recoverAfterFirstCell) {
    let interrupted = false;
    supervisor.runs.setBoundaryObserver(async () => {
      if (interrupted) return;
      const events = await supervisor.storage.loadEvents(session.sessionId, {
        branchId: session.branchId,
      });
      if (events.filter((item) => item.type === "CellCommitted").length === 1) {
        interrupted = true;
        throw new Error("simulated service loss after CellCommitted");
      }
    });
    await expect(supervisor.runs.start(session.sessionId, session.branchId, {
      task: "Build the artifact-backed answer in two durable cells.",
      requestKey: "context-sensitive-recovery",
    })).rejects.toThrow("simulated service loss after CellCommitted");
    expect(provider.calls).toBe(1);
    const interruptedEvents = await supervisor.storage.loadEvents(
      session.sessionId,
      { branchId: session.branchId },
    );
    expect(interruptedEvents.filter((item) => item.type === "CellCommitted"))
      .toHaveLength(1);
    await supervisor.close();
    supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      restartConsoleAfterCell: true,
      modelProviders: [provider],
      recover: true,
    });
  } else {
    await expect(supervisor.runs.start(session.sessionId, session.branchId, {
      task: "Build the artifact-backed answer in two durable cells.",
      requestKey: "context-sensitive-normal",
    })).resolves.toMatchObject({
      status: "succeeded",
      steps: 3,
      final: "Verified the artifact-backed answer from durable context.",
    });
  }

  const history = await supervisor.storage.loadEvents(session.sessionId, {
    branchId: session.branchId,
  });
  const state = projectEvents(history);
  const run = Object.values(state.agentRuns)[0]!;
  expect(run).toMatchObject({
    status: "succeeded",
    result: {
      kind: "text",
      value: "Verified the artifact-backed answer from durable context.",
    },
  });
  expect(provider.calls).toBe(3);
  expect(provider.contexts).toHaveLength(3);
  expect(provider.contexts.every((context) =>
    context && typeof context === "object" && !Array.isArray(context) &&
    Array.isArray(context.messages))).toBe(true);
  const providerMessages = provider.contexts.map((context) =>
    (context as { messages: JsonValue[] }).messages);
  const firstDynamicIndex = providerMessages[0]!.findIndex((message) =>
    message && typeof message === "object" && !Array.isArray(message) &&
    message.role === "user" && typeof message.content === "string" &&
    message.content.startsWith("AGENCITY DURABLE RUN STEP\n"));
  expect(firstDynamicIndex).toBeGreaterThan(0);
  const stablePrefix = providerMessages[0]!.slice(0, firstDynamicIndex);
  const dynamicStepContents: string[] = [];
  for (const messages of providerMessages) {
    const dynamicIndex = messages.findIndex((message) =>
      message && typeof message === "object" && !Array.isArray(message) &&
      message.role === "user" && typeof message.content === "string" &&
      message.content.startsWith("AGENCITY DURABLE RUN STEP\n"));
    expect(dynamicIndex).toBe(firstDynamicIndex);
    expect(messages.slice(0, dynamicIndex)).toEqual(stablePrefix);
    const dynamic = messages[dynamicIndex] as { content: string };
    expect(dynamic.content).toStartWith(
      'AGENCITY DURABLE RUN STEP\n{"durableContext":',
    );
    dynamicStepContents.push(dynamic.content);
  }
  const reusableDynamicPrefixBytes = [...dynamicStepContents[0]!]
    .findIndex((_, index) =>
      dynamicStepContents.some((value) =>
        value.codePointAt(index) !== dynamicStepContents[0]!.codePointAt(index)));
  expect(reusableDynamicPrefixBytes).toBeGreaterThan(1_500);
  const firstEnvelope = JSON.parse(
    dynamicStepContents[0]!.slice("AGENCITY DURABLE RUN STEP\n".length),
  ) as { durableContext: Record<string, JsonValue> };
  const durableKeys = Object.keys(firstEnvelope.durableContext);
  expect(durableKeys.indexOf("harness")).toBeLessThan(
    durableKeys.indexOf("budget"),
  );
  expect(durableKeys.indexOf("messages")).toBeLessThan(
    durableKeys.indexOf("budget"),
  );
  expect(provider.decisions.map((item) => item.type))
    .toEqual(["typescript", "typescript", "final"]);
  expect(await Bun.file(`${temp.workspaceRoot}/context-stage.txt`).text())
    .toBe("prepared-once");
  expect(await Bun.file(`${temp.workspaceRoot}/context-answer.txt`).text())
    .toBe("context-sensitive-payload");
  expect(history.filter((item) => item.type === "AgentRunStepStarted"))
    .toHaveLength(3);
  expect(history.filter((item) => item.type === "AgentRunActionCommitted"))
    .toHaveLength(3);
  expect(history.filter((item) => item.type === "CellProposed")).toHaveLength(2);
  expect(history.filter((item) => item.type === "CellCommitted")).toHaveLength(2);
  const requestedEffects = history.filter((item) => item.type === "EffectRequested")
    .map((item) => item.payload as EventPayloads["EffectRequested"]);
  const fileEffects = requestedEffects.filter((item) => item.executor === "file");
  const modelEffects = requestedEffects.filter((item) => item.executor === "model");
  expect(fileEffects).toHaveLength(2);
  expect(modelEffects).toHaveLength(3);
  const nextAction = provider.decisions[1];
  if (nextAction?.type !== "typescript") {
    throw new Error("Context-sensitive fixture did not select its continuation cell");
  }
  const result = {
    nextActionSource: nextAction.code,
    providerCalls: provider.calls,
    cellCount: history.filter((item) => item.type === "CellCommitted").length,
    fileEffectCount: fileEffects.length,
    modelEffectCount: modelEffects.length,
    stablePrefixMessages: stablePrefix.length,
  };
  await supervisor.close();
  return result;
}

describe("autonomous durable agent runs", () => {
  test("has no implicit production step limit", async () => {
    const { supervisor } = await fixture([]);
    try {
      expect(supervisor.runs.maxSteps).toBeUndefined();
    } finally {
      await supervisor.close();
    }
  });

  test("keeps a compact working-value checkpoint after its source step leaves recent trajectory", async () => {
    const script: AgentAction[] = [
      action({
        type: "typescript",
        code: `
          // Purpose: retain the task progress that later steps still need.
          await state.set("task.progress", {
            phase: "productive",
            metric: { before: 0, after: 25, delta: 25 },
            lastFailure: null,
          });
          return { checkpointed: true };
        `,
      }),
      ...Array.from({ length: 9 }, (_, index) =>
        action({
          type: "typescript",
          code: `// Purpose: advance independent step ${index + 2}.\nreturn { step: ${index + 2} };`,
        })),
      action({ type: "final", content: "Completed with durable progress evidence." }),
    ];
    const { supervisor, provider, sessionId, branchId } = await fixture(script);
    await expect(supervisor.runs.start(sessionId, branchId, {
      task: "Complete a long task while retaining compact progress.",
      requestKey: "sticky-progress",
    })).resolves.toMatchObject({
      status: "succeeded",
      steps: 11,
    });

    const context = provider.contexts.at(-1);
    if (!context || typeof context !== "object" || Array.isArray(context) ||
        !Array.isArray(context.messages)) {
      throw new Error("Final provider input is missing normalized messages");
    }
    const message = [...context.messages].reverse().find((item) =>
      item && typeof item === "object" && !Array.isArray(item) &&
      item.role === "user" && typeof item.content === "string" &&
      item.content.startsWith("AGENCITY DURABLE RUN STEP\n"));
    if (!message || typeof message !== "object" || Array.isArray(message) ||
        typeof message.content !== "string") {
      throw new Error("Final provider input is missing its durable run step");
    }
    const envelope = JSON.parse(
      message.content.slice("AGENCITY DURABLE RUN STEP\n".length),
    ) as {
      durableContext: {
        workingValues: Array<{
          name: string;
          version: number;
          value: JsonValue;
          eventId: string;
        }>;
      };
      run: {
        recentTrajectory: Array<{ ordinal: number }>;
      };
    };
    expect(envelope.run.recentTrajectory).toHaveLength(8);
    expect(envelope.run.recentTrajectory.map((item) => item.ordinal))
      .not.toContain(1);
    expect(envelope.durableContext.workingValues).toContainEqual({
      name: "task.progress",
      version: 1,
      value: {
        kind: "json",
        value: {
          phase: "productive",
          metric: { before: 0, after: 25, delta: 25 },
          lastFailure: null,
        },
      },
      eventId: expect.any(String),
    });
  });

  test("derives the same next action across recovery and keeps the provider prefix stable", async () => {
    const normal = await runContextSensitiveScenario(false);
    const recovered = await runContextSensitiveScenario(true);
    expect(recovered.nextActionSource).toBe(normal.nextActionSource);
    expect(normal).toMatchObject({
      providerCalls: 3,
      cellCount: 2,
      fileEffectCount: 2,
      modelEffectCount: 3,
      stablePrefixMessages: 2,
    });
    expect(recovered).toMatchObject({
      providerCalls: 3,
      cellCount: 2,
      fileEffectCount: 2,
      modelEffectCount: 3,
    });
  });

  test("rejects a known unsupported root run before task, goal, run, model, or effect events", async () => {
    const temp = await makeTempRuntime("agencity-agent-unsupported-root-"); temps.push(temp);
    const provider = textOnlyProvider();
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "unsupported-root",
      model: { provider: provider.name, model: "text-v1" },
    });
    try {
      const before = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      await expect(supervisor.runs.admit(session.sessionId, session.branchId, {
        task: "Must not become durable",
        requestKey: "unsupported-root-run",
        goalMode: "create",
      })).rejects.toMatchObject({ code: "MODEL_RESPONSE_CONTRACT_UNAVAILABLE" });
      const after = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      expect(after.map(event => event.id)).toEqual(before.map(event => event.id));
      expect(after.some(event => [
        "MessageAppended", "GoalCreated", "AgentRunRequested", "ModelCallRequested",
        "EffectRequested",
      ].includes(event.type))).toBe(false);
    } finally { await supervisor.close(); }
  });

  test("rejects a known unsupported runnable child before task, session, message, or run events", async () => {
    const temp = await makeTempRuntime("agencity-agent-unsupported-child-"); temps.push(temp);
    const provider = textOnlyProvider("text-only-child");
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const root = await supervisor.createSession({
      workspaceId: "unsupported-child",
      model: { provider: provider.name, model: "text-v1" },
    });
    try {
      const before = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      const branchesBefore = await supervisor.storage.listBranches();
      await expect(supervisor.agents.spawnRunnable(root.sessionId, root.branchId, {
        task: "Must not create a runnable child",
        idempotencyKey: "unsupported-runnable-child",
      })).rejects.toMatchObject({ code: "MODEL_RESPONSE_CONTRACT_UNAVAILABLE" });
      const after = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      expect(after.map(event => event.id)).toEqual(before.map(event => event.id));
      expect((await supervisor.storage.listBranches()).map(branch => `${branch.sessionId}/${branch.branchId}`))
        .toEqual(branchesBefore.map(branch => `${branch.sessionId}/${branch.branchId}`));
      expect(after.some(event => ["TaskCreated", "SubagentAdmitted", "AgentRunRequested"].includes(event.type))).toBe(false);

      const recursive = await supervisor.models.start(root.sessionId, root.branchId, {
        prompt: "Text recursive work remains admissible",
        idempotencyKey: "text-recursive-still-admissible",
        run: false,
      });
      expect(recursive).toMatchObject({
        status: "pending",
        responseAdmission: {
          responseContract: { kind: "text" },
          responseCapability: { kind: "text" },
        },
      });
    } finally { await supervisor.close(); }
  });

  test("rechecks formal capability drift before committing a model effect", async () => {
    const temp = await makeTempRuntime("agencity-agent-capability-drift-"); temps.push(temp);
    const provider = new RecordingActions([
      action({ type: "final", content: "Must not be called." }),
    ], "capability-drift-actions");
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "capability-drift",
      model: { provider: provider.name, model: "v1" },
    });
    try {
      const admitted = await supervisor.runs.admit(session.sessionId, session.branchId, "Do not execute after drift");
      (provider as any).capabilities.requiredToolSet = {
        status: "unsupported",
        requiredChoice: "unsupported",
        parallelCalls: "unsupported",
        streaming: false,
        adapter: "agencity.capability-drift.unsupported.v1",
      };
      await expect(supervisor.runs.advance(session.sessionId, session.branchId, admitted.runId))
        .rejects.toMatchObject({ code: "MODEL_RESPONSE_CONTRACT_UNAVAILABLE" });
      const history = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      expect(provider.calls).toBe(0);
      expect(history.some(event => event.type === "ModelCallRequested" || event.type === "EffectRequested")).toBe(false);
    } finally { await supervisor.close(); }
  });

  test("stops an unknown-capacity oversized candidate before provider execution", async () => {
    const temp = await makeTempRuntime("agencity-agent-product-limit-");
    temps.push(temp);
    const provider = new GuardAbortActions();
    Object.defineProperty(provider, "capabilities", {
      value: {
        streaming: false,
        requiredToolSet: {
          status: "runtime-validated",
          requiredChoice: "provider-enforced",
          parallelCalls: "runtime-rejected",
          streaming: true,
          adapter: "agencity.product-limit.fixture.v1",
        },
      },
    });
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    try {
      const session = await supervisor.createSession({
        workspaceId: "product-limit",
        model: { provider: provider.name, model: "unknown-capacity" },
      });
      const result = await supervisor.runs.start(
        session.sessionId,
        session.branchId,
        `Oversized protected task ${"x".repeat(530 * 1024)}`,
      );
      expect(result).toMatchObject({
        status: "failed",
        reason: expect.stringContaining("provider-input-product-limit"),
      });
      expect(provider.calls).toBe(0);
      const events = await supervisor.storage.loadEvents(session.sessionId, {
        branchId: session.branchId,
      });
      expect(events.some((event) =>
        event.type === "EffectRequested" &&
        (event.payload as any).executor === "model")).toBe(false);
      expect(events.find((event) => event.type === "ContextCompactionRequested"))
        .toMatchObject({ payload: { capacity: { source: "unknown", contextWindowTokens: null } } });
    } finally {
      await supervisor.close();
    }
  });

  test("executes typed TypeScript actions and delivers every cell observation once to the dependent context", async () => {
    const value = await fixture([
      action({ type: "typescript", code: `
        // Purpose: create and verify the requested answer file.
        const write = await tools.writeFile("answer.txt", "durable-agent-run");
        const gate = await tools.shell("test -f answer.txt && cat answer.txt");
        if (gate.completeness !== "inline") throw new Error(gate.guidance);
        await state.set("verified", { exitCode: gate.value.exitCode, sha256: write.sha256 });
        console.log("verified", gate.value.stdout);
        return { exitCode: gate.value.exitCode, content: gate.value.stdout.trim(), sha256: write.sha256 };
      ` }),
      action({ type: "final", content: "Created answer.txt and verified its contents." }),
    ]);
    try {
      const result = await value.supervisor.runs.start(value.sessionId, value.branchId, {
        task: "Create answer.txt and verify it.", requestKey: "typed-run",
      });
      expect(result).toMatchObject({ status: "succeeded", steps: 2, final: "Created answer.txt and verified its contents." });
      expect(await Bun.file(`${value.temp.workspaceRoot}/answer.txt`).text()).toBe("durable-agent-run");
      expect(value.provider.calls).toBe(2);
      const firstContext = JSON.stringify(value.provider.contexts[0]);
      expect(firstContext).toContain("complete one-based line pages");
      expect(firstContext).toContain("the option is timeoutMs, not timeout");
      expect(firstContext).toContain("agencity.bounded-output.v1");
      expect(firstContext).toContain("artifacts.readRange");
      expect(firstContext).toContain("Keep large read, search, and tool results local while transforming them");
      expect(firstContext).toContain("Return only a focused summary");
      expect(firstContext).toContain("Treat every model step as a decision boundary");
      expect(firstContext).toContain("do not query notebook history to reconstruct the active run");
      expect(firstContext).toContain("about 20 lines on each side");
      expect(firstContext).toContain("do not reread the whole file");
      expect(firstContext).not.toContain("Use cells.list/get for retained notebook history");
      const secondContext = value.provider.contexts[1] as any;
      expect(secondContext.run.instruction).toContain("If the evidence is sufficient, call finish now");
      expect(secondContext.run.instruction).not.toContain("Continue from these");
      expect(secondContext.run.recentTrajectory).toHaveLength(1);
      expect(secondContext.run.recentTrajectory[0]).toMatchObject({
        ordinal: 1,
        action: {
          type: "bun_console",
          declaredPurpose: {
            text: "create and verify the requested answer file.",
            truncated: false,
          },
          source: {
            originalByteLength: expect.any(Number),
            sha256: expect.any(String),
          },
        },
        outcome: {
          status: "committed",
          details: "run.observations",
        },
      });

      const observations = value.provider.contexts.flatMap(providerObservations);
      const cells = observations.filter(item => item.type === "CellCommitted");
      expect(cells).toHaveLength(1);
      expect(cells[0]!.payload).toMatchObject({
        logs: ["verified durable-agent-run"],
        exports: ["verified"],
        effectManifest: [
          { executor: "file", operation: "write", terminalStatus: "succeeded", attemptCount: 1 },
          { executor: "shell", operation: "run", terminalStatus: "succeeded", attemptCount: 1 },
        ],
      });
      expect(observations.filter(item => item.eventId === cells[0]!.eventId)).toHaveLength(1);
      expect(providerObservations(value.provider.contexts[0]!)).toEqual([]);
      expect(providerObservations(value.provider.contexts[1]!).some(item => item.type === "EffectOutcomeRecorded")).toBe(false);

      const state = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      expect(Object.values(state.cells)).toHaveLength(1);
      expect(Object.values(state.cells)[0]).toMatchObject({ status: "committed" });
      expect(Object.values(state.effects).filter(effect => effect.executor !== "model").every(effect =>
        effect.origin.kind === "cell" && effect.origin.cellId === Object.values(state.cells)[0]!.id)).toBe(true);
      expect(state.workingValues.verified?.version).toBe(1);
      expect(state.agentRuns[result.runId]?.steps[1]?.observationEventIds).toContain(cells[0]!.eventId);
      expect(state.messages.map(message => ({ role: message.role, content: message.content }))).toEqual([
        { role: "user", content: "Create answer.txt and verify it." },
        { role: "assistant", content: "Created answer.txt and verified its contents." },
      ]);
      expect(Object.values(state.modelCalls).every(call => call.responseMessageId === undefined)).toBe(true);
      const responseContract = Object.values(state.modelCalls)[0]!.modelDispatch.responseContract;
      expect(responseContract.kind).toBe("required-tool-set");
      expect((value.provider.contexts[0] as any).responseContract).toMatchObject({
        contractId: AGENT_TOOL_CONTRACT_ID,
        contractDigest: responseContract.kind === "required-tool-set" ? responseContract.contractDigest : "unreachable",
        selection: "exactly-one-of",
      });
      const history = await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId });
      const contexts = history.filter(event => event.type === "ContextMaterialized");
      expect((contexts[1]!.payload as any).records.some((record: any) => record.eventId === cells[0]!.eventId)).toBe(true);
      const actionEvents = history.filter(event => event.type === "AgentRunActionCommitted");
      expect(actionEvents).toHaveLength(2);
      expect(actionEvents.every(event => (event.payload as any).source.kind === "tool-submission")).toBe(true);
      expect(actionEvents.every(event => !Object.hasOwn(event.payload, "raw"))).toBe(true);
    } finally { await value.supervisor.close(); }
  });

  test("delivers a rejected action once and accepts one bounded correction without executing rejected code", async () => {
    const value = await fixture([
      "```json\n{\"type\":\"typescript\",\"code\":\"await tools.writeFile('owned','bad')\"}\n```",
      action({ type: "final", content: "Recovered with one valid action." }),
    ]);
    try {
      const result = await value.supervisor.runs.start(value.sessionId, value.branchId, "Do not execute malformed output");
      expect(result).toMatchObject({ status: "succeeded", steps: 2, final: "Recovered with one valid action." });
      expect(value.provider.calls).toBe(2);
      expect(await Bun.file(`${value.temp.workspaceRoot}/owned`).exists()).toBe(false);
      const state = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      expect(Object.values(state.cells)).toEqual([]);
      expect(state.agentRuns[result.runId]?.steps[0]?.rejection).toContain("without calling a required tool");
      const correctionObservations = providerObservations(value.provider.contexts[1]!)
        .filter(item => item.type === "AgentRunActionRejected");
      expect(correctionObservations).toHaveLength(1);
      expect((value.provider.contexts[1] as any).run.instruction)
        .toContain("call exactly one provided tool");
      expect(correctionObservations[0]?.payload).toMatchObject({
        runId: result.runId,
        error: expect.stringContaining("without calling a required tool"),
      });
      expect(value.provider.contexts.flatMap(providerObservations)
        .filter(item => item.eventId === correctionObservations[0]!.eventId)).toHaveLength(1);
    } finally { await value.supervisor.close(); }
  });

  test("binds committed action provenance to the retained submission and rejects tampering", async () => {
    const value = await fixture([action({ type: "final", content: "Bound action." })]);
    const append = value.supervisor.storage.appendEvents.bind(value.supervisor.storage);
    let captured: any;
    (value.supervisor.storage as any).appendEvents = async (events: any[], ...rest: any[]) => {
      const actionEvent = events.find(event => event.type === "AgentRunActionCommitted");
      if (actionEvent && !captured) {
        captured = actionEvent;
        throw new Error("capture action boundary");
      }
      return (append as any)(events, ...rest);
    };
    try {
      await expect(value.supervisor.runs.start(value.sessionId, value.branchId, "Bind the retained action"))
        .rejects.toThrow("capture action boundary");
      (value.supervisor.storage as any).appendEvents = append;
      expect(captured).toBeDefined();
      const variants = [
        { ...captured.payload, source: { ...captured.payload.source, resultDigest: `sha256:${"0".repeat(64)}` } },
        { ...captured.payload, source: { ...captured.payload.source, providerToolCallId: "tampered-provider-call" } },
        { ...captured.payload, action: action({ type: "final", content: "Tampered action." }) },
      ];
      for (const [index, payload] of variants.entries()) {
        await expect(append([{ ...captured, idempotencyKey: `tampered-action:${index}`, payload }]))
          .rejects.toThrow();
      }
      await append([captured]);
      await append([captured]);
      const retained = await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId });
      const budget = retained.find(event => event.type === "BudgetDebited")!;
      await expect(append([{ ...budget, id: undefined, idempotencyKey: "duplicate-budget-with-new-intent" } as any]))
        .rejects.toThrow();
      const state = projectEvents(retained);
      const run = Object.values(state.agentRuns)[0]!;
      expect(run.steps).toHaveLength(1);
      expect(run.steps[0]?.actionSource).toEqual(captured.payload.source);
      const completed = await value.supervisor.runs.advance(value.sessionId, value.branchId, run.id);
      expect(completed).toMatchObject({ status: "succeeded", final: "Bound action." });
      expect(value.provider.calls).toBe(1);
    } finally {
      (value.supervisor.storage as any).appendEvents = append;
      await value.supervisor.close();
    }
  });

  test("binds rejection provenance to the retained violation and rejects tampering", async () => {
    const value = await fixture(["JSON-looking text is not a formal call"]);
    const append = value.supervisor.storage.appendEvents.bind(value.supervisor.storage);
    let captured: any;
    (value.supervisor.storage as any).appendEvents = async (events: any[], ...rest: any[]) => {
      const rejection = events.find(event => event.type === "AgentRunActionRejected");
      if (rejection && !captured) {
        captured = rejection;
        throw new Error("capture rejection boundary");
      }
      return (append as any)(events, ...rest);
    };
    try {
      await expect(value.supervisor.runs.start(value.sessionId, value.branchId, "Reject text transport"))
        .rejects.toThrow("capture rejection boundary");
      (value.supervisor.storage as any).appendEvents = append;
      const variants = [
        { ...captured.payload, error: "tampered violation" },
        { ...captured.payload, source: { ...captured.payload.source, resultDigest: `sha256:${"f".repeat(64)}` } },
        { ...captured.payload, source: { ...captured.payload.source, providerToolCallId: "fabricated-call" } },
      ];
      for (const [index, payload] of variants.entries()) {
        await expect(append([{ ...captured, idempotencyKey: `tampered-rejection:${index}`, payload }]))
          .rejects.toThrow();
      }
      await append([captured]);
      const history = await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId });
      expect(history.filter(event => event.type === "AgentRunActionRejected")).toHaveLength(1);
      const state = projectEvents(history);
      expect(Object.values(state.agentRuns)[0]?.steps[0]?.actionSource).toEqual(captured.payload.source);
    } finally {
      (value.supervisor.storage as any).appendEvents = append;
      await value.supervisor.close();
    }
  });

  test("binds model completion and budget debit to the retained effect output and rejects tampering", async () => {
    const value = await fixture([action({ type: "final", content: "Bound completion." })]);
    const append = value.supervisor.storage.appendEvents.bind(value.supervisor.storage);
    let captured: any[] | undefined;
    (value.supervisor.storage as any).appendEvents = async (events: any[], ...rest: any[]) => {
      if (!captured && events.some(event => event.type === "ModelCallCompleted")) {
        captured = events;
        throw new Error("capture completion boundary");
      }
      return (append as any)(events, ...rest);
    };
    try {
      await expect(value.supervisor.runs.start(value.sessionId, value.branchId, "Bind the retained completion"))
        .rejects.toThrow("capture completion boundary");
      (value.supervisor.storage as any).appendEvents = append;
      const completion = captured!.find(event => event.type === "ModelCallCompleted")!;
      const budget = captured!.find(event => event.type === "BudgetDebited")!;
      const completionVariants = [
        { ...completion.payload, termination: { kind: "text-stop" } },
        { ...completion.payload, warnings: [{ kind: "provider", message: "fabricated warning" }] },
        { ...completion.payload, usage: { ...completion.payload.usage, inputTokens: completion.payload.usage.inputTokens + 1 } },
        { ...completion.payload, usageSource: "conservative-guard-estimate" },
      ];
      for (const [index, payload] of completionVariants.entries()) {
        await expect(append([{ ...completion, idempotencyKey: `tampered-completion:${index}`, payload }]))
          .rejects.toThrow("does not match its authoritative retained effect output");
      }
      await append([completion]);
      const budgetVariants = [
        { ...budget.payload, tokens: budget.payload.tokens + 1 },
        { ...budget.payload, costUsd: budget.payload.costUsd + 0.5 },
        { ...budget.payload, turns: 2 },
        { ...budget.payload, usageSource: "conservative-guard-estimate" },
      ];
      for (const [index, payload] of budgetVariants.entries()) {
        await expect(append([{ ...budget, idempotencyKey: `tampered-budget:${index}`, payload }]))
          .rejects.toThrow();
      }
      await append([budget]);
      const state = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      const call = Object.values(state.modelCalls)[0]!;
      expect(call).toMatchObject({ status: "succeeded", usageSource: "provider-reported" });
      expect(call.budgetDebited).toMatchObject({ tokens: budget.payload.tokens, turns: 1, usageSource: "provider-reported" });
    } finally {
      (value.supervisor.storage as any).appendEvents = append;
      await value.supervisor.close();
    }
  });

  test("fails after the bounded action-correction attempt is also malformed", async () => {
    const malformed = "```json\n{\"type\":\"typescript\",\"code\":\"await tools.writeFile('owned','bad')\"}\n```";
    const value = await fixture([malformed, malformed]);
    try {
      const result = await value.supervisor.runs.start(value.sessionId, value.branchId, "Do not execute malformed output");
      expect(result).toMatchObject({ status: "failed", steps: 2 });
      expect(result.reason).toContain("Rejected model action");
      expect(value.provider.calls).toBe(2);
      expect(await Bun.file(`${value.temp.workspaceRoot}/owned`).exists()).toBe(false);
      const state = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      expect(Object.values(state.cells)).toEqual([]);
      expect(state.messages.map(message => message.role)).toEqual(["user"]);
      expect(state.agentRuns[result.runId]?.finalMessageId).toBeUndefined();
      expect(state.agentRuns[result.runId]?.steps.map(step => step.rejection)).toEqual([
        expect.stringContaining("without calling a required tool"),
        expect.stringContaining("without calling a required tool"),
      ]);
    } finally { await value.supervisor.close(); }
  });

  test("does not admit an action-correction call after the durable turn budget is exhausted", async () => {
    const value = await fixture([
      "not an action",
      action({ type: "final", content: "Must not be requested." }),
    ], { turnLimit: 1 });
    try {
      const result = await value.supervisor.runs.start(value.sessionId, value.branchId, "Respect correction bounds");
      expect(result).toMatchObject({ status: "budget_exceeded", steps: 1 });
      expect(value.provider.calls).toBe(1);
      const state = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      expect(state.agentRuns[result.runId]?.steps[0]?.rejection).toContain("without calling a required tool");
      expect(state.messages.map(message => message.role)).toEqual(["user"]);
      expect(state.agentRuns[result.runId]?.finalMessageId).toBeUndefined();
    } finally { await value.supervisor.close(); }
  });

  test("charges guard-aborted responses from retained estimates without inventing provider usage", async () => {
    const temp = await makeTempRuntime("agencity-agent-guard-budget-"); temps.push(temp);
    const provider = new GuardAbortActions();
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    try {
      const session = await supervisor.createSession({
        workspaceId: "guard-budget",
        model: { provider: provider.name, model: "guard-v1", maxOutputTokens: 64 },
        budget: { turnLimit: 1 },
      });
      const result = await supervisor.runs.start(session.sessionId, session.branchId, "Trigger the formal guard");
      expect(result).toMatchObject({ status: "budget_exceeded", steps: 1 });
      expect(provider.calls).toBe(1);
      const state = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      const call = Object.values(state.modelCalls)[0]!;
      expect(call).toMatchObject({
        status: "succeeded",
        usage: null,
        usageSource: "conservative-guard-estimate",
        result: { kind: "contract-violation", code: "oversized-tool-input" },
      });
      expect(state.budget.tokens).toBe(call.estimatedInputTokens + 64);
      expect(state.budget.costUsd).toBe(0);
    } finally { await supervisor.close(); }
  });

  test("resumes the bounded correction after a crash committed the rejection", async () => {
    const value = await fixture([
      "not an action",
      action({ type: "final", content: "Recovered after restart." }),
    ]);
    let restore = () => {};
    try {
      const admitted = await value.supervisor.runs.admit(
        value.sessionId,
        value.branchId,
        "Recover a rejected action",
      );
      restore = crashAfterActionRejection(value.supervisor);
      await expect(value.supervisor.runs.advance(value.sessionId, value.branchId, admitted.runId))
        .rejects.toThrow("simulated crash after AgentRunActionRejected");
      restore();
      restore = () => {};

      const recovered = await value.supervisor.runs.advance(value.sessionId, value.branchId, admitted.runId);
      expect(recovered).toMatchObject({ status: "succeeded", steps: 2, final: "Recovered after restart." });
      expect(value.provider.calls).toBe(2);
      const history = await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId });
      expect(history.filter(event => event.type === "AgentRunActionRejected")).toHaveLength(1);
      expect(value.provider.contexts.flatMap(providerObservations)
        .filter(observation => observation.type === "AgentRunActionRejected")).toHaveLength(1);
    } finally {
      restore();
      await value.supervisor.close();
    }
  });

  test("does not exceed the correction bound after a crash committed the second rejection", async () => {
    const value = await fixture([
      "not an action",
      "also not an action",
      action({ type: "final", content: "Must not be requested." }),
    ]);
    let restore = () => {};
    try {
      const admitted = await value.supervisor.runs.admit(
        value.sessionId,
        value.branchId,
        "Stop after the bounded correction",
      );
      restore = crashAfterActionRejection(value.supervisor, 2);
      await expect(value.supervisor.runs.advance(value.sessionId, value.branchId, admitted.runId))
        .rejects.toThrow("simulated crash after AgentRunActionRejected");
      restore();
      restore = () => {};

      const recovered = await value.supervisor.runs.advance(value.sessionId, value.branchId, admitted.runId);
      expect(recovered).toMatchObject({ status: "failed", steps: 2 });
      expect(recovered.reason).toContain("Rejected model action");
      expect(value.provider.calls).toBe(2);
      const history = await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId });
      expect(history.filter(event => event.type === "AgentRunActionRejected")).toHaveLength(2);
    } finally {
      restore();
      await value.supervisor.close();
    }
  });

  test("deduplicates stable run requests and rejects changed intent", async () => {
    const value = await fixture([action({ type: "final", content: "Exactly once." })]);
    try {
      const first = await value.supervisor.runs.start(value.sessionId, value.branchId, {
        task: "Stable task", requestKey: "stable-run-request",
      });
      const retried = await value.supervisor.runs.start(value.sessionId, value.branchId, {
        task: "Stable task", requestKey: "stable-run-request",
      });
      expect(retried).toEqual(first);
      expect(value.provider.calls).toBe(1);
      await expect(value.supervisor.runs.start(value.sessionId, value.branchId, {
        task: "Changed task", requestKey: "stable-run-request",
      })).rejects.toThrow("different durable meaning");
      const state = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      expect(Object.values(state.agentRuns)).toHaveLength(1);
      expect(state.messages.map(message => message.content)).toEqual(["Stable task", "Exactly once."]);
    } finally { await value.supervisor.close(); }
  });

  test("expires an absolute deadline before provider admission and retains it across duplicate replay", async () => {
    const value = await fixture([
      action({ type: "final", content: "Must not execute." }),
    ]);
    const deadline = {
      startedAt: iso(Date.now() - 2_000),
      deadlineAt: iso(Date.now() - 1_000),
    };
    try {
      const first = await value.supervisor.runs.start(
        value.sessionId,
        value.branchId,
        {
          task: "Stop at the canonical deadline",
          requestKey: "expired-run",
          deadline,
        },
      );
      expect(first).toMatchObject({
        status: "budget_exceeded",
        steps: 0,
        reason: expect.stringContaining("absolute deadline"),
        deadline: {
          startedAt: deadline.startedAt,
          deadlineAt: deadline.deadlineAt,
          expired: true,
          remainingMs: 0,
        },
      });
      const replay = await value.supervisor.runs.start(
        value.sessionId,
        value.branchId,
        {
          task: "Stop at the canonical deadline",
          requestKey: "expired-run",
          deadline,
        },
      );
      expect(replay).toMatchObject({
        runId: first.runId,
        status: "budget_exceeded",
        steps: 0,
        deadline: {
          startedAt: deadline.startedAt,
          deadlineAt: deadline.deadlineAt,
          expired: true,
        },
      });
      expect(value.provider.calls).toBe(0);
      await expect(value.supervisor.runs.start(
        value.sessionId,
        value.branchId,
        {
          task: "Stop at the canonical deadline",
          requestKey: "expired-run",
          deadline: {
            ...deadline,
            deadlineAt: iso(Date.parse(deadline.deadlineAt) + 1),
          },
        },
      )).rejects.toThrow("different durable meaning");
    } finally {
      await value.supervisor.close();
    }
  });

  test("aborts an admitted provider call at the absolute deadline and exposes accurate step time", async () => {
    const temp = await makeTempRuntime("agencity-agent-deadline-call-");
    temps.push(temp);
    const provider = new HoldingActions();
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "deadline-call",
      model: { provider: provider.name, model: "holding-v1" },
    });
    const startedAt = Date.now() - 50;
    const deadlineAt = Date.now() + 150;
    try {
      const result = await supervisor.runs.start(
        session.sessionId,
        session.branchId,
        {
          task: "Do not outlive the horizon",
          deadline: {
            startedAt: iso(startedAt),
            deadlineAt: iso(deadlineAt),
          },
        },
      );
      expect(result).toMatchObject({
        status: "budget_exceeded",
        steps: 1,
        deadline: { expired: true, remainingMs: 0 },
      });
      expect(provider.calls).toBe(1);
      const context = provider.contexts[0] as Record<string, JsonValue>;
      const run = context.run as Record<string, JsonValue>;
      const timing = run.deadline as Record<string, JsonValue>;
      expect(timing.startedAt).toBe(iso(startedAt));
      expect(timing.deadlineAt).toBe(iso(deadlineAt));
      expect(Number(timing.elapsedMs)).toBeGreaterThanOrEqual(50);
      expect(Number(timing.remainingMs)).toBeGreaterThan(0);
    } finally {
      await supervisor.close();
    }
  });

  test("recycles an overlong cell at the absolute deadline and commits a typed terminal", async () => {
    const value = await fixture([
      action({
        type: "typescript",
        code: "// Purpose: prove the cell horizon is enforced.\nwhile (true) {}",
      }),
    ]);
    try {
      const result = await value.supervisor.runs.start(
        value.sessionId,
        value.branchId,
        {
          task: "Bound the generated cell",
          deadline: {
            startedAt: iso(Date.now()),
            deadlineAt: iso(Date.now() + 300),
          },
        },
      );
      expect(result).toMatchObject({
        status: "budget_exceeded",
        steps: 1,
        deadline: { expired: true, remainingMs: 0 },
      });
      const state = projectEvents(await value.supervisor.storage.loadEvents(
        value.sessionId,
        { branchId: value.branchId },
      ));
      expect(Object.values(state.cells)).toHaveLength(1);
      expect(Object.values(state.cells)[0]).toMatchObject({ status: "failed" });
    } finally {
      await value.supervisor.close();
    }
  });

  test("recovers an expired queued run without calling the provider", async () => {
    const temp = await makeTempRuntime("agencity-agent-deadline-recovery-");
    temps.push(temp);
    const provider = new RecordingActions([
      action({ type: "final", content: "Must not execute after restart." }),
    ], "deadline-recovery");
    let supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "deadline-recovery",
      model: { provider: provider.name, model: "v1" },
    });
    const admitted = await supervisor.runs.admit(
      session.sessionId,
      session.branchId,
      {
        task: "Expire while the service is down",
        deadline: {
          startedAt: iso(Date.now()),
          deadlineAt: iso(Date.now() + 40),
        },
      },
    );
    await supervisor.close();
    await Bun.sleep(60);
    supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: true,
    });
    try {
      const result = await supervisor.runs.get(
        session.sessionId,
        session.branchId,
        admitted.runId,
      );
      expect(result).toMatchObject({
        status: "budget_exceeded",
        steps: 0,
        deadline: { expired: true },
      });
      expect(provider.calls).toBe(0);
    } finally {
      await supervisor.close();
    }
  });

  test("materializes a blocked finish exactly and accepts a later instruction as a new run", async () => {
    const value = await fixture([
      action({ type: "blocked", reason: "Which filename should I create?" }),
    ]);
    try {
      const result = await value.supervisor.runs.start(value.sessionId, value.branchId, "Create the requested file");
      expect(result).toMatchObject({
        status: "blocked",
        final: "Which filename should I create?",
        finalMessageId: `agent-run-final-${result.runId}`,
      });
      const history = await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId });
      const run = projectEvents(history).agentRuns[result.runId]!;
      expect("inputRequests" in run).toBe(false);
      expect("respond" in value.supervisor.runs).toBe(false);
      expect(history.some(event => event.type.startsWith("AgentRunUserInput"))).toBe(false);
      const finalMessage = history.find(event => event.type === "MessageAppended" &&
        (event.payload as { messageId?: string }).messageId === `agent-run-final-${result.runId}`)!;
      const terminal = history.find(event => event.type === "AgentRunStatusChanged" &&
        (event.payload as { runId?: string }).runId === result.runId)!;
      expect(BigInt(terminal.cursor) - BigInt(finalMessage.cursor)).toBe(1n);

      const next = await value.supervisor.runs.admit(value.sessionId, value.branchId, {
        task: "Use chosen.txt",
        requestKey: "ordinary-follow-up",
      });
      expect(next.status).toBe("queued");
      const after = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      expect(after.messages.at(-1)).toMatchObject({ role: "user", content: "Use chosen.txt" });
    } finally { await value.supervisor.close(); }
  });

  test("rejects tampered non-success terminal message, status, and source combinations", async () => {
    const value = await fixture([
      action({ type: "blocked", reason: "Exact blocked response." }),
    ]);
    const restore = crashAfterNextActionCommit(value.supervisor);
    try {
      await expect(value.supervisor.runs.start(value.sessionId, value.branchId, "Retain the blocked finish"))
        .rejects.toThrow("simulated crash after AgentRunActionCommitted");
      restore();
      const state = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      const run = Object.values(state.agentRuns)[0]!;
      expect(run.status).toBe("running");

      for (const status of ["blocked", "failed"] as const) {
        await expect(value.supervisor.storage.appendEvents([{
          sessionId: value.sessionId,
          branchId: value.branchId,
          type: "AgentRunStatusChanged",
          producer: "supervisor",
          idempotencyKey: `tampered-${status}-without-message`,
          payload: { runId: run.id, status, reason: "Exact blocked response." },
        }])).rejects.toThrow();
      }

      for (const [label, content, status] of [
        ["wrong-content", "Altered blocked response.", "blocked"],
        ["wrong-status", "Exact blocked response.", "failed"],
      ] as const) {
        const messageId = `agent-run-final-${run.id}`;
        await expect(value.supervisor.storage.appendEvents([{
          sessionId: value.sessionId,
          branchId: value.branchId,
          type: "MessageAppended",
          producer: "supervisor",
          idempotencyKey: `tampered-${label}-message`,
          payload: { messageId, role: "assistant", content },
        }, {
          sessionId: value.sessionId,
          branchId: value.branchId,
          type: "AgentRunStatusChanged",
          producer: "supervisor",
          idempotencyKey: `tampered-${label}-status`,
          payload: { runId: run.id, status, reason: content, finalMessageId: messageId },
        }])).rejects.toThrow();
      }

      const recovered = await value.supervisor.runs.advance(value.sessionId, value.branchId, run.id);
      expect(recovered).toMatchObject({
        status: "blocked",
        final: "Exact blocked response.",
        finalMessageId: `agent-run-final-${run.id}`,
      });
    } finally { restore(); await value.supervisor.close(); }
  });

  test("rejects a forged status-only terminal while a successful finish has a failed required gate", async () => {
    const value = await fixture([
      action({ type: "final", content: "Claimed complete" }),
      action({ type: "failed", error: "I could not repair the required gate." }),
    ]);
    const restore = crashAfterGoalCheck(value.supervisor);
    try {
      const goal = await value.supervisor.goals.create(value.sessionId, value.branchId, {
        description: "Pass the required gate",
        gates: [{ name: "always fails", executor: "shell", operation: "run", input: { command: "exit 7" }, idempotent: true, required: true }],
      });
      await expect(value.supervisor.runs.start(value.sessionId, value.branchId, {
        task: "Finish safely", goalId: goal.goalId, requestKey: "forged-terminal-after-failed-gate",
      })).rejects.toThrow("simulated crash after AgentRunGoalCheckRecorded");
      restore();

      const state = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      const run = Object.values(state.agentRuns)[0]!;
      expect(run.status).toBe("running");
      expect(run.steps.at(-1)?.action?.type).toBe("final");
      expect(Object.values(run.goalChecks).at(-1)?.status).toBe("failed");
      expect(state.goals[goal.goalId]?.status).toBe("active");

      for (const status of ["failed", "blocked"] as const) {
        await expect(value.supervisor.storage.appendEvents([{
          sessionId: value.sessionId,
          branchId: value.branchId,
          type: "AgentRunStatusChanged",
          producer: "supervisor",
          idempotencyKey: `forged-${status}-after-failed-gate`,
          payload: { runId: run.id, status, reason: "Forged terminal without gate repair" },
        }])).rejects.toThrow();
      }
      const unforged = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      expect(unforged.agentRuns[run.id]?.status).toBe("running");
      expect(unforged.goals[goal.goalId]?.status).toBe("active");

      const recovered = await value.supervisor.runs.advance(value.sessionId, value.branchId, run.id);
      expect(recovered).toMatchObject({
        status: "blocked",
        final: "I could not repair the required gate.",
        finalMessageId: `agent-run-final-${run.id}`,
      });
      expect(recovered.reason).toContain("Goal repair stopped after a failed required gate");
      const terminalState = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      expect(terminalState.goals[goal.goalId]?.status).toBe("blocked");
    } finally { restore(); await value.supervisor.close(); }
  });

  test("stops new effect admission at the durable turn-budget boundary but accepts an already-generated final", async () => {
    const blocked = await fixture([
      action({ type: "typescript", code: `return await tools.writeFile("over-budget", "bad");` }),
    ], { turnLimit: 1 });
    try {
      const result = await blocked.supervisor.runs.start(blocked.sessionId, blocked.branchId, "Respect budget");
      expect(result.status).toBe("budget_exceeded");
      expect(await Bun.file(`${blocked.temp.workspaceRoot}/over-budget`).exists()).toBe(false);
      expect(blocked.provider.calls).toBe(1);
    } finally { await blocked.supervisor.close(); }

    const final = await fixture([action({ type: "final", content: "No execution needed." })], { turnLimit: 1 });
    try {
      expect(await final.supervisor.runs.start(final.sessionId, final.branchId, "Answer only"))
        .toMatchObject({ status: "succeeded", final: "No execution needed." });
    } finally { await final.supervisor.close(); }
  });

  test("accounts durable model wall time and blocks an effectful action at that exact budget boundary", async () => {
    const temp = await makeTempRuntime("agencity-agent-wall-budget-"); temps.push(temp);
    const provider = new SlowActions([
      action({ type: "typescript", code: `return await tools.writeFile("wall-over-budget", "bad");` }),
    ]);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "wall-budget", model: { provider: provider.name, model: "v1" },
      budget: { wallTimeLimitMs: 1 },
    });
    try {
      const result = await supervisor.runs.start(session.sessionId, session.branchId, "Respect wall time");
      expect(result.status).toBe("budget_exceeded");
      expect(provider.calls).toBe(1);
      expect(await Bun.file(`${temp.workspaceRoot}/wall-over-budget`).exists()).toBe(false);
      const state = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      expect(state.budget.wallTimeMs).toBeGreaterThanOrEqual(1);
      expect(state.budget.exceeded).toBe(true);
    } finally { await supervisor.close(); }
  });

  test("commits cancellation intent, aborts the in-flight run call, and leaves unrelated effects alone", async () => {
    const temp = await makeTempRuntime("agencity-agent-cancel-"); temps.push(temp);
    const provider = new HoldingActions();
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "cancel", model: { provider: provider.name, model: "v1" },
    });
    const unrelatedId = await supervisor.outbox.request({
      sessionId: session.sessionId, branchId: session.branchId,
      executor: "shell", operation: "run", input: { command: "printf unrelated" },
      origin: { kind: "runtime", requestId: "unrelated-before-run" },
      idempotencyKey: "unrelated-before-run", idempotent: true,
    });
    try {
      const started = supervisor.runs.start(session.sessionId, session.branchId, {
        task: "Wait until cancelled", requestKey: "cancel-run",
      });
      await provider.entered;
      const cancelled = await supervisor.runs.cancel(session.sessionId, session.branchId, (await (async () => {
        while (true) {
          const snapshot = await supervisor.projections.getSnapshot(session.sessionId, session.branchId);
          const active = Object.values(snapshot.state.agentRuns)[0];
          if (active) return active.id;
          await Bun.sleep(1);
        }
      })()), "stop now");
      expect(cancelled).toMatchObject({ status: "cancelled", reason: "stop now" });
      expect(await started).toMatchObject({ status: "cancelled", reason: "stop now" });
      expect(provider.calls).toBe(1);
      expect(await supervisor.outbox.run(unrelatedId)).toMatchObject({ outcome: "succeeded" });
      const state = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      const run = state.agentRuns[cancelled.runId]!;
      expect(run.cancellationRequested).toBe(true);
      expect(run.cancellationReason).toBe("stop now");
      expect(state.messages.map(message => message.role)).toEqual(["user"]);
      expect(Object.values(state.modelCalls)).toHaveLength(1);
      expect(Object.values(state.modelCalls)[0]?.status).toBe("cancelled");
    } finally { await supervisor.close(); }
  });

  test("a failed finish after an unresolved required gate becomes goal-derived blocked", async () => {
    const value = await fixture([
      action({ type: "final", content: "Claimed complete" }),
      action({ type: "failed", error: "I could not repair the required gate." }),
    ]);
    try {
      const goal = await value.supervisor.goals.create(value.sessionId, value.branchId, {
        description: "Pass the required gate",
        gates: [{ name: "always fails", executor: "shell", operation: "run", input: { command: "exit 7" }, idempotent: true, required: true }],
      });
      const result = await value.supervisor.runs.start(value.sessionId, value.branchId, { task: "Finish safely", goalId: goal.goalId });
      expect(result.status).toBe("blocked");
      expect(result.final).toBe("I could not repair the required gate.");
      expect(result.reason).toContain("Goal repair stopped after a failed required gate");
      const state = projectEvents(await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }));
      expect(state.goals[goal.goalId]?.status).toBe("blocked");
      expect(state.agentRuns[result.runId]?.finalMessageId).toBe(`agent-run-final-${result.runId}`);
      expect(state.messages.some(message => message.content === "Claimed complete")).toBe(false);
    } finally { await value.supervisor.close(); }
  });

  test("a blocked finish bypasses required completion gates", async () => {
    const value = await fixture([
      action({ type: "blocked", reason: "A required external credential is missing." }),
    ]);
    try {
      const goal = await value.supervisor.goals.create(value.sessionId, value.branchId, {
        description: "Do not evaluate while externally blocked",
        gates: [{
          name: "must not run",
          executor: "shell",
          operation: "run",
          input: { command: "printf ran > blocked-gate-ran" },
          idempotent: true,
          required: true,
        }],
      });
      const result = await value.supervisor.runs.start(value.sessionId, value.branchId, {
        task: "Stop for the external requirement",
        goalId: goal.goalId,
      });
      expect(result).toMatchObject({
        status: "blocked",
        final: "A required external credential is missing.",
      });
      expect(await Bun.file(`${value.temp.workspaceRoot}/blocked-gate-ran`).exists()).toBe(false);
      const history = await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId });
      expect(history.some(event => event.type === "GoalCompletionRequested" ||
        event.type === "GoalGateEvaluationRecorded")).toBe(false);
      expect(projectEvents(history).goals[goal.goalId]?.status).toBe("active");
    } finally { await value.supervisor.close(); }
  });

  test("reconciles an unapplied TypeScript action committed before a crash without dropping or duplicating its stable cell", async () => {
    const temp = await makeTempRuntime("agencity-agent-action-recovery-"); temps.push(temp);
    const provider = new RecordingActions([
      action({ type: "typescript", code: `return await tools.writeFile("recovered-action.txt", "applied-once");` }),
      action({ type: "final", content: "Recovered the retained action." }),
    ], "action-recover-actions");
    let supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const session = await supervisor.createSession({ workspaceId: "action-recovery", model: { provider: provider.name, model: "v1" } });
    const restore = crashAfterNextActionCommit(supervisor);
    try {
      await expect(supervisor.runs.start(session.sessionId, session.branchId, {
        task: "Apply the retained TypeScript action", requestKey: "recover-retained-typescript",
      })).rejects.toThrow("simulated crash after AgentRunActionCommitted");
      restore();
      expect(provider.calls).toBe(1);
      const crashed = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      expect(Object.values(crashed.cells)).toHaveLength(0);
      expect(Object.values(crashed.agentRuns)[0]?.steps[0]?.action?.type).toBe("typescript");
      await supervisor.close();

      supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
      const recovered = Object.values((await supervisor.projections.getSnapshot(session.sessionId, session.branchId)).state.agentRuns)[0]!;
      expect(await supervisor.runs.get(session.sessionId, session.branchId, recovered.id))
        .toMatchObject({ status: "succeeded", steps: 2, final: "Recovered the retained action." });
      expect(provider.calls).toBe(2);
      expect(await Bun.file(`${temp.workspaceRoot}/recovered-action.txt`).text()).toBe("applied-once");
      const history = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      expect(history.filter(event => event.type === "CellProposed")).toHaveLength(1);
      expect(history.filter(event => event.type === "CellCommitted")).toHaveLength(1);
      expect(projectEvents(history).cells[Object.keys(projectEvents(history).cells)[0]!]!.attempts).toBe(1);
    } finally { restore(); await supervisor.close(); }
  });

  test("applies a retained final action whose step consumed a prior CellCommitted observation without another provider call", async () => {
    const temp = await makeTempRuntime("agencity-agent-observed-action-recovery-"); temps.push(temp);
    const provider = new RecordingActions([
      action({ type: "final", content: "Used the committed observation." }),
    ], "observed-action-recover-actions");
    let supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const session = await supervisor.createSession({ workspaceId: "observed-action-recovery", model: { provider: provider.name, model: "v1" } });
    const runId = newId();
    await supervisor.storage.appendEvents([{
      sessionId: session.sessionId, branchId: session.branchId, type: "MessageAppended", producer: "client", idempotencyKey: `agent-run-task-message:${runId}`,
      payload: { messageId: `agent-run-task-${runId}`, role: "user", content: "Use the prior observation" },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunRequested", producer: "client", idempotencyKey: `agent-run-request:${runId}`,
      payload: { runId, task: "Use the prior observation", requestKey: "observed-action-recovery", profilePin: await currentProfilePin(supervisor, session.sessionId) },
    }]);
    const priorCell = await supervisor.executeCell(session.sessionId, session.branchId, `return { retained: true };`, [], "prior-observation-cell");
    const before = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
    const observation = before.find(event => event.type === "CellCommitted" && (event.payload as { cellId: string }).cellId === priorCell.cellId)!;
    const restore = crashAfterNextActionCommit(supervisor);
    try {
      await expect(supervisor.runs.advance(session.sessionId, session.branchId, runId))
        .rejects.toThrow("simulated crash after AgentRunActionCommitted");
      restore();
      expect(provider.calls).toBe(1);
      const crashed = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      expect(crashed.agentRuns[runId]?.steps).toHaveLength(1);
      expect(crashed.agentRuns[runId]?.steps[0]?.observationEventIds).toContain(observation.id);
      expect(crashed.agentRuns[runId]?.steps[0]?.action).toMatchObject({ type: "final", content: "Used the committed observation." });
      expect(crashed.agentRuns[runId]?.status).toBe("running");
      await supervisor.close();

      supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
      expect(await supervisor.runs.get(session.sessionId, session.branchId, runId))
        .toMatchObject({ status: "succeeded", steps: 1, final: "Used the committed observation." });
      expect(provider.calls).toBe(1);
      const history = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      expect(history.filter(event => event.type === "AgentRunActionCommitted")).toHaveLength(1);
      expect(history.filter(event => event.type === "MessageAppended" && event.producer === "supervisor")).toHaveLength(1);
    } finally { restore(); await supervisor.close(); }
  });

  test("recovers a committed failed finish with one exact message and no repeated model call", async () => {
    const temp = await makeTempRuntime("agencity-agent-input-action-recovery-"); temps.push(temp);
    const provider = new RecordingActions([
      action({ type: "failed", error: "The retained attempt failed safely." }),
    ], "input-action-recover-actions");
    let supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const session = await supervisor.createSession({ workspaceId: "input-action-recovery", model: { provider: provider.name, model: "v1" } });
    const restore = crashAfterNextActionCommit(supervisor);
    try {
      await expect(supervisor.runs.start(session.sessionId, session.branchId, "Fail without fabricating success"))
        .rejects.toThrow("simulated crash after AgentRunActionCommitted");
      restore();
      expect(provider.calls).toBe(1);
      await supervisor.close();
      supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
      const history = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      const run = Object.values(projectEvents(history).agentRuns)[0]!;
      expect(run).toMatchObject({ status: "failed", finalMessageId: `agent-run-final-${run.id}` });
      expect(provider.calls).toBe(1);
      expect(history.filter(event => event.type === "MessageAppended" &&
        (event.payload as { messageId?: string }).messageId === `agent-run-final-${run.id}`)).toHaveLength(1);
      expect(history.filter(event => event.type === "AgentRunStatusChanged")).toHaveLength(1);
    } finally { restore(); await supervisor.close(); }
  });

  test("recovers context-bound provider admission without consulting changed live capability state", async () => {
    const temp = await makeTempRuntime("agencity-agent-context-admission-");
    temps.push(temp);
    const provider = new RecordingActions([
      action({ type: "final", content: "Recovered retained admission." }),
    ], "context-admission-actions");
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "context-admission",
      model: { provider: provider.name, model: "v1" },
    });
    const append = supervisor.storage.appendEvents.bind(supervisor.storage);
    let interrupted = false;
    (supervisor.storage as any).appendEvents =
      async (events: any[], ...rest: any[]) => {
        if (!interrupted &&
            events.some((event) =>
              event.type === "AgentRunModelAttemptStarted")) {
          interrupted = true;
          throw new Error("crash after context admission");
        }
        return (append as any)(events, ...rest);
      };
    try {
      await expect(supervisor.runs.start(
        session.sessionId,
        session.branchId,
        "Recover the exact context admission",
      )).rejects.toThrow("crash after context admission");
      (supervisor.storage as any).appendEvents = append;
      const interruptedEvents = await supervisor.storage.loadEvents(
        session.sessionId,
        { branchId: session.branchId },
      );
      const contextEvent = interruptedEvents.find((event) =>
        event.type === "ContextMaterialized") as
        | import("../../src/index.ts").AgentEvent<"ContextMaterialized">
        | undefined;
      expect(contextEvent?.payload.providerInputAdmission).toBeDefined();
      expect(interruptedEvents.some((event) =>
        event.type === "AgentRunModelAttemptStarted")).toBe(false);

      Object.defineProperty(provider, "capabilities", {
        configurable: true,
        value: {
          ...provider.capabilities,
          requiredToolSet: {
            ...provider.capabilities.requiredToolSet,
            status: "runtime-validated",
            requiredChoice: "unknown",
            parallelCalls: "runtime-rejected",
          },
        },
      });
      const interruptedState = projectEvents(interruptedEvents);
      const run = Object.values(interruptedState.agentRuns)[0]!;
      expect(await supervisor.runs.advance(
        session.sessionId,
        session.branchId,
        run.id,
      )).toMatchObject({
        status: "succeeded",
        final: "Recovered retained admission.",
      });
      expect(provider.calls).toBe(1);
      const recoveredEvents = await supervisor.storage.loadEvents(
        session.sessionId,
        { branchId: session.branchId },
      );
      const call = recoveredEvents.find((event) =>
        event.type === "ModelCallRequested") as
        | import("../../src/index.ts").AgentEvent<"ModelCallRequested">
        | undefined;
      expect(call?.payload.modelDispatch.responseContract).toMatchObject({
        schemaEnforcement: "provider-strict",
      });
      expect(call?.payload.providerInput.digest)
        .toBe(contextEvent?.payload.providerInputAdmission?.digest);
    } finally {
      (supervisor.storage as any).appendEvents = append;
      await supervisor.close();
    }
  });

  test("marks a stable cell interrupted after action commit as unknown and never replays it or calls the provider", async () => {
    const temp = await makeTempRuntime("agencity-agent-cell-interruption-"); temps.push(temp);
    const code = `return await tools.writeFile("must-not-replay.txt", "unsafe");`;
    const provider = new RecordingActions([
      action({ type: "typescript", code }),
      action({ type: "final", content: "must not be requested" }),
    ], "cell-interruption-actions");
    let supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const session = await supervisor.createSession({ workspaceId: "cell-interruption", model: { provider: provider.name, model: "v1" } });
    const restore = crashAfterNextActionCommit(supervisor);
    let runId = "";
    let cellId = "";
    try {
      await expect(supervisor.runs.start(session.sessionId, session.branchId, "Do not replay an interrupted action"))
        .rejects.toThrow("simulated crash after AgentRunActionCommitted");
      restore();
      const crashed = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      const run = Object.values(crashed.agentRuns)[0]!;
      runId = run.id;
      cellId = `agent-run-cell-${run.steps[0]!.actionId}`;
      await supervisor.storage.appendEvents([{
        sessionId: session.sessionId, branchId: session.branchId, type: "CellProposed", producer: "console",
        idempotencyKey: `cell-proposed:${cellId}`, payload: { cellId, code, dependencies: [] },
      }, {
        sessionId: session.sessionId, branchId: session.branchId, type: "CellStarted", producer: "console",
        idempotencyKey: `cell-started:${cellId}:1`, payload: { cellId, attempt: 1 },
      }]);
      expect(provider.calls).toBe(1);
      await supervisor.close();

      supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
      expect(await supervisor.runs.get(session.sessionId, session.branchId, runId))
        .toMatchObject({ status: "unknown", steps: 1, reason: expect.stringContaining("did not reach a committed terminal boundary") });
      expect(provider.calls).toBe(1);
      expect(await Bun.file(`${temp.workspaceRoot}/must-not-replay.txt`).exists()).toBe(false);
      const history = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      expect(history.filter(event => event.type === "CellProposed" && (event.payload as { cellId: string }).cellId === cellId)).toHaveLength(1);
      expect(history.filter(event => event.type === "CellStarted" && (event.payload as { cellId: string }).cellId === cellId)).toHaveLength(1);
      expect(history.filter(event => event.type === "CellAbandoned" && (event.payload as { cellId: string }).cellId === cellId)).toHaveLength(1);
      expect(history.some(event => ["CellCommitted", "CellFailed"].includes(event.type) && (event.payload as { cellId: string }).cellId === cellId)).toBe(false);
    } finally { restore(); await supervisor.close(); }
  });

  test("recovers a succeeded stable model effect without calling the provider twice", async () => {
    const temp = await makeTempRuntime("agencity-agent-recovery-"); temps.push(temp);
    const provider = new RecordingActions([action({ type: "final", content: "Recovered exactly once." })], "recover-actions");
    let supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const session = await supervisor.createSession({ workspaceId: "recovery", model: { provider: provider.name, model: "v1" } });
    const runId = newId(); const stepId = `agent-run-${runId}-step-1`; const contextId = `${stepId}-context`; const callId = `${stepId}-call`; const actionId = `${stepId}-action`;
    const effectKey = `agent-run-model:${runId}:1`; const effectId = stableEffectId(session.sessionId, effectKey);
    const modelDispatch = new ModelEffectAdmissionService(supervisor.modelExecutor)
      .requestBuiltInStructured(AGENT_TOOL_CONTRACT_ID, { provider: provider.name, model: "v1", reasoningEffort: "provider-default" }).modelDispatch;
    const pin = await currentProfilePin(supervisor, session.sessionId);
    const promptProvenance = fixturePromptProvenanceForPin(pin, runId, "agent-run");
    const retainedContext = { run: { stepOrdinal: 1 }, messages: [{ role: "system", content: FIXTURE_EFFECTIVE_SYSTEM_PROMPT }] };
    const contextWindow = fixtureContextWindow(provider.name, "v1");
    const providerInput = buildProviderInputCandidate({ context: retainedContext, modelDispatch, capacity: contextWindow });
    const estimatedInputTokens = estimateProviderInputCandidate(providerInput).estimatedTokens;
    await supervisor.storage.appendEvents([{
      sessionId: session.sessionId, branchId: session.branchId, type: "MessageAppended", producer: "client", idempotencyKey: `agent-run-task-message:${runId}`,
      payload: { messageId: `agent-run-task-${runId}`, role: "user", content: "Recover this run" },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunRequested", producer: "client", idempotencyKey: `agent-run-request:${runId}`,
      payload: { runId, task: "Recover this run", requestKey: "recover-request", profilePin: pin },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunStepStarted", producer: "supervisor", idempotencyKey: `agent-run-step:${runId}:1`,
      payload: { runId, stepId, ordinal: 1, contextId, callId, effectId, actionId, observationEventIds: [] },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "ContextMaterialized", producer: "supervisor", idempotencyKey: `agent-run-context:${runId}:1`,
      payload: { contextId, records: [], contentHash: "a".repeat(64), context: retainedContext, promptProvenance, providerInputAdmission: providerInputAdmission(providerInput, modelDispatch) },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunModelAttemptStarted", producer: "supervisor", idempotencyKey: `agent-run-model-attempt:${runId}:1:1`,
      payload: { runId, stepId, ordinal: 1, attempt: 1, contextId, callId, effectId, reason: "initial", providerInputVersion: providerInput.version, providerInputDigest: providerInput.digest, estimatedInputTokens, contextWindow },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "ModelCallRequested", producer: "supervisor", idempotencyKey: `agent-run-model-call:${callId}`,
      payload: { callId, contextId, effectId, modelDispatch, providerInput, estimatedInputTokens, promptProvenance, attempt: 1, contextWindow },
    }]);
    await supervisor.outbox.request({ sessionId: session.sessionId, branchId: session.branchId, executor: "model", operation: "complete", input: { callId, providerInput, modelDispatch, promptProvenance } as unknown as JsonValue, origin: { kind: "model-call", callId }, idempotencyKey: effectKey, idempotent: false });
    expect((await supervisor.outbox.run(effectId)).outcome).toBe("succeeded");
    expect(provider.calls).toBe(1);
    const rawAction = JSON.stringify(action({ type: "final", content: "Recovered exactly once." }));
    await expect(supervisor.storage.appendEvents([{
      sessionId: session.sessionId, branchId: session.branchId, type: "MessageAppended", producer: "model",
      idempotencyKey: `forbidden-agent-run-message:${callId}`,
      payload: { messageId: `forbidden-${callId}`, role: "assistant", content: rawAction, modelCallId: callId },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "ModelCallCompleted", producer: "supervisor",
      idempotencyKey: `forbidden-agent-run-complete:${callId}`,
      payload: { callId, responseMessageId: `forbidden-${callId}`, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } } as any,
    }])).rejects.toThrow();
    expect(projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId })).messages.map(message => message.content))
      .toEqual(["Recover this run"]);
    await supervisor.close();

    supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
    try {
      expect(await supervisor.runs.get(session.sessionId, session.branchId, runId)).toMatchObject({ status: "succeeded", final: "Recovered exactly once." });
      expect(provider.calls).toBe(1);
      const history = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      const state = projectEvents(history);
      expect(Object.values(state.modelCalls)).toHaveLength(1);
      expect(Object.values(state.agentRuns[runId]!.steps)).toHaveLength(1);
      expect(state.messages.map(message => ({ role: message.role, content: message.content }))).toEqual([
        { role: "user", content: "Recover this run" },
        { role: "assistant", content: "Recovered exactly once." },
      ]);
      expect(Object.values(state.modelCalls)[0]?.responseMessageId).toBeUndefined();
      expect(history.filter(event => event.type === "MessageAppended")).toHaveLength(2);
      expect(history.filter(event => event.type === "AgentRunActionCommitted")).toHaveLength(1);
    } finally { await supervisor.close(); }
  });

  test("recovers the exact typed model failure without repeating the provider call", async () => {
    const temp = await makeTempRuntime("agencity-agent-failure-recovery-"); temps.push(temp);
    const provider = new FailingFormalActions();
    let supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "failure-recovery",
      model: { provider: provider.name, model: "failure-v1" },
    });
    const interceptedStorage = supervisor.storage;
    const append = interceptedStorage.appendEvents.bind(interceptedStorage);
    let intercepted = false;
    (interceptedStorage as any).appendEvents = async (events: any[], ...rest: any[]) => {
      if (!intercepted && events.some(event => event.type === "ModelCallTerminated")) {
        intercepted = true;
        throw new Error("crash before typed model termination");
      }
      return (append as any)(events, ...rest);
    };
    try {
      await expect(supervisor.runs.start(session.sessionId, session.branchId, "Fail once"))
        .rejects.toThrow("crash before typed model termination");
      (interceptedStorage as any).appendEvents = append;
      const retainedEvents = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      const outcomeEvent = retainedEvents.find(event => event.type === "EffectOutcomeRecorded")!;
      expect((outcomeEvent.payload as any).modelFailure).toEqual({ code: "stream-failed" });
      await expect(append([{
        sessionId: session.sessionId, branchId: session.branchId, type: "EffectOutcomeRecorded", producer: "executor",
        idempotencyKey: "bare-model-failure-shape",
        payload: { ...(outcomeEvent.payload as any), effectId: "shape-probe", modelFailure: "stream-failed" },
      }])).rejects.toThrow("Invalid EffectOutcomeRecorded payload");
      await expect(append([{
        sessionId: session.sessionId, branchId: session.branchId, type: "EffectOutcomeRecorded", producer: "executor",
        idempotencyKey: "succeeded-model-failure-shape",
        payload: { ...(outcomeEvent.payload as any), effectId: "shape-probe", outcome: "succeeded", modelFailure: { code: "stream-failed" } },
      }])).rejects.toThrow("Only failed model effects may retain modelFailure");
      const before = projectEvents(retainedEvents);
      expect(Object.values(before.effects)[0]).toMatchObject({ status: "failed", modelFailure: "stream-failed" });
      expect(Object.values(before.modelCalls)[0]).toMatchObject({ status: "requested" });
      await supervisor.close();

      supervisor = await Supervisor.open({
        databaseUrl: temp.databaseUrl,
        artifactDirectory: temp.artifactDirectory,
        workspaceRoot: temp.workspaceRoot,
        modelProviders: [provider],
        recover: true,
      });
      const after = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      expect(Object.values(after.modelCalls)[0]).toMatchObject({ status: "failed", failureCode: "stream-failed" });
      expect(Object.values(after.agentRuns)[0]).toMatchObject({ status: "failed" });
      expect(provider.calls).toBe(1);
    } finally {
      (interceptedStorage as any).appendEvents = append;
      await supervisor.close();
    }
  });

  test("recovery drains an unclaimed stable model request exactly once", async () => {
    const temp = await makeTempRuntime("agencity-agent-pending-recovery-"); temps.push(temp);
    const provider = new RecordingActions([action({ type: "final", content: "Pending recovered once." })], "pending-recover-actions");
    let supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const session = await supervisor.createSession({ workspaceId: "pending-recovery", model: { provider: provider.name, model: "v1" } });
    const runId = newId(); const stepId = `agent-run-${runId}-step-1`; const contextId = `${stepId}-context`; const callId = `${stepId}-call`; const actionId = `${stepId}-action`;
    const effectKey = `agent-run-model:${runId}:1`; const effectId = stableEffectId(session.sessionId, effectKey);
    const modelDispatch = new ModelEffectAdmissionService(supervisor.modelExecutor)
      .requestBuiltInStructured(AGENT_TOOL_CONTRACT_ID, { provider: provider.name, model: "v1", reasoningEffort: "provider-default" }).modelDispatch;
    const context = { run: { stepOrdinal: 1 }, messages: [{ role: "system", content: FIXTURE_EFFECTIVE_SYSTEM_PROMPT }] };
    const pin = await currentProfilePin(supervisor, session.sessionId);
    const promptProvenance = fixturePromptProvenanceForPin(pin, runId, "agent-run");
    const contextWindow = fixtureContextWindow(provider.name, "v1");
    const providerInput = buildProviderInputCandidate({ context, modelDispatch, capacity: contextWindow });
    const estimatedInputTokens = estimateProviderInputCandidate(providerInput).estimatedTokens;
    await supervisor.storage.appendEvents([{
      sessionId: session.sessionId, branchId: session.branchId, type: "MessageAppended", producer: "client", idempotencyKey: `agent-run-task-message:${runId}`,
      payload: { messageId: `agent-run-task-${runId}`, role: "user", content: "Recover pending request" },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunRequested", producer: "client", idempotencyKey: `agent-run-request:${runId}`,
      payload: { runId, task: "Recover pending request", requestKey: "pending-recover-request", profilePin: pin },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunStepStarted", producer: "supervisor", idempotencyKey: `agent-run-step:${runId}:1`,
      payload: { runId, stepId, ordinal: 1, contextId, callId, effectId, actionId, observationEventIds: [] },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "ContextMaterialized", producer: "supervisor", idempotencyKey: `agent-run-context:${runId}:1`,
      payload: { contextId, records: [], contentHash: "b".repeat(64), context, promptProvenance, providerInputAdmission: providerInputAdmission(providerInput, modelDispatch) },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunModelAttemptStarted", producer: "supervisor", idempotencyKey: `agent-run-model-attempt:${runId}:1:1`,
      payload: { runId, stepId, ordinal: 1, attempt: 1, contextId, callId, effectId, reason: "initial", providerInputVersion: providerInput.version, providerInputDigest: providerInput.digest, estimatedInputTokens, contextWindow },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "ModelCallRequested", producer: "supervisor", idempotencyKey: `agent-run-model-call:${callId}`,
      payload: { callId, contextId, effectId, modelDispatch, providerInput, estimatedInputTokens, promptProvenance, attempt: 1, contextWindow },
    }]);
    await supervisor.outbox.request({ sessionId: session.sessionId, branchId: session.branchId, executor: "model", operation: "complete", input: { callId, providerInput, modelDispatch, promptProvenance } as unknown as JsonValue, origin: { kind: "model-call", callId }, idempotencyKey: effectKey, idempotent: false });
    expect(provider.calls).toBe(0);
    await supervisor.close();

    supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
    try {
      expect(await supervisor.runs.get(session.sessionId, session.branchId, runId)).toMatchObject({ status: "succeeded", final: "Pending recovered once." });
      expect(provider.calls).toBe(1);
      const state = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      expect(state.effects[effectId]?.attempts).toBe(1);
      expect(state.messages.map(message => message.content)).toEqual(["Recover pending request", "Pending recovered once."]);
      expect(state.agentRuns[runId]?.invocationContract).toBeUndefined();
      expect(state.agentRuns[runId]?.result).toBeUndefined();
    } finally { await supervisor.close(); }
  });

  test("pins default text results without changing retained legacy text runs", async () => {
    const value = await fixture([
      action({ type: "final", content: "Pinned text result." }),
    ]);
    try {
      const result = await value.supervisor.runs.start(
        value.sessionId,
        value.branchId,
        { task: "Return text", requestKey: "pinned-text" },
      );
      expect(result).toMatchObject({
        status: "succeeded",
        final: "Pinned text result.",
        output: { kind: "text", text: "Pinned text result." },
        invocationContract: {
          protocol: "agencity.agent-invocation-contract",
          version: 1,
          output: { kind: "text" },
          resultPolicy: { storage: "inline", inlineByteLimit: 65_536 },
        },
        resultReference: {
          protocol: "agencity.agent-run-result-reference",
          version: 1,
          kind: "text",
        },
      });
      const events = await value.supervisor.storage.loadEvents(value.sessionId, {
        branchId: value.branchId,
      });
      expect(events.filter(event => event.type === "AgentInvocationContractPinned")).toHaveLength(1);
      expect(events.filter(event => event.type === "AgentRunResultCommitted")).toHaveLength(1);
    } finally {
      await value.supervisor.close();
    }
  });

  test("rejects an oversized pinned text result before successful persistence and accepts one repair", async () => {
    const value = await fixture([
      action({ type: "final", content: "x".repeat(70_000) }),
      action({ type: "final", content: "Bounded repair." }),
    ]);
    try {
      const result = await value.supervisor.runs.start(
        value.sessionId,
        value.branchId,
        { task: "Return bounded text", requestKey: "bounded-text" },
      );
      expect(result).toMatchObject({
        status: "succeeded",
        steps: 2,
        output: { kind: "text", text: "Bounded repair." },
      });
      expect(providerObservations(value.provider.contexts[1]!)).toEqual([
        expect.objectContaining({
          type: "AgentRunTypedActionViolationCommitted",
        }),
      ]);
      const events = await value.supervisor.storage.loadEvents(value.sessionId, {
        branchId: value.branchId,
      });
      expect(events.filter(event =>
        event.type === "AgentRunTypedActionViolationCommitted"
      )).toHaveLength(1);
      expect(events.filter(event => event.type === "AgentRunResultCommitted"))
        .toHaveLength(1);
      expect(events.filter(event =>
        event.type === "MessageAppended" &&
        (event.payload as any).role === "assistant"
      )).toHaveLength(1);
    } finally {
      await value.supervisor.close();
    }
  });

  test("repairs a typed object violation and atomically commits the validated result", async () => {
    const temp = await makeTempRuntime("agencity-typed-agent-run-"); temps.push(temp);
    const provider = new TypedFinishActions([{
      outcome: {
        status: "succeeded",
        message: "Missing the required count.",
        value: { summary: "incomplete" },
      },
    }, {
      outcome: {
        status: "succeeded",
        message: "Structured work complete.",
        value: { summary: "complete", count: 2 },
      },
    }]);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "typed-agent-run",
      model: { provider: provider.name, model: "typed-v1" },
    });
    try {
      const request: StartAgentRunInput = {
        task: "Return structured work",
        requestKey: "typed-object",
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["summary", "count"],
            properties: {
              summary: { type: "string" },
              count: { type: "integer", minimum: 0 },
            },
          },
        },
      };
      const result = await supervisor.runs.start(
        session.sessionId,
        session.branchId,
        request,
      );
      expect(result).toMatchObject({
        status: "succeeded",
        final: "Structured work complete.",
        steps: 2,
        output: {
          kind: "object",
          object: { summary: "complete", count: 2 },
        },
        resultReference: { kind: "object" },
      });
      expect(provider.dispatches).toHaveLength(2);
      for (const dispatch of provider.dispatches) {
        expect(dispatch.responseContract.kind).toBe("required-tool-set");
        if (dispatch.responseContract.kind !== "required-tool-set") continue;
        expect(dispatch.responseContract.tools.map(tool => tool.name)).toEqual([
          "bun_console",
          "finish",
        ]);
      }
      expect(providerObservations(provider.contexts[1]!)).toEqual([
        expect.objectContaining({ type: "AgentRunTypedActionViolationCommitted" }),
      ]);

      const events = await supervisor.storage.loadEvents(session.sessionId, {
        branchId: session.branchId,
      });
      expect(events.filter(event => event.type === "AgentRunTypedActionViolationCommitted")).toHaveLength(1);
      const terminalTypes = events
        .slice(events.findIndex(event => event.type === "AgentRunTypedFinishCommitted"))
        .filter(event => [
          "AgentRunTypedFinishCommitted",
          "MessageAppended",
          "AgentRunResultCommitted",
          "AgentRunStatusChanged",
        ].includes(event.type))
        .map(event => event.type);
      expect(terminalTypes).toEqual([
        "AgentRunTypedFinishCommitted",
        "MessageAppended",
        "AgentRunResultCommitted",
        "AgentRunStatusChanged",
      ]);
      expect(projectEvents(events).agentRuns[result.runId]?.result?.value).toEqual({
        summary: "complete",
        count: 2,
      });
      const resultIndex = events.findIndex(event =>
        event.type === "AgentRunResultCommitted"
      );
      const messageIndex = resultIndex - 1;
      const finishIndex = events.findIndex(event =>
        event.type === "AgentRunTypedFinishCommitted" &&
        (event.payload as any).outcome.status === "succeeded"
      );
      expect(() => projectEvents(events.filter((_, index) =>
        index !== messageIndex
      ))).toThrow();
      const reordered = [...events];
      [reordered[messageIndex], reordered[resultIndex]] = [
        reordered[resultIndex]!,
        reordered[messageIndex]!,
      ];
      expect(() => projectEvents(reordered)).toThrow();
      expect(() => projectEvents([
        ...events.slice(0, finishIndex + 1),
        {
          ...events[finishIndex]!,
          id: "sync-injected-duplicate-typed-finish",
          idempotencyKey: "sync-injected-duplicate-typed-finish",
        },
        ...events.slice(finishIndex + 1),
      ])).toThrow();
      expect(() => projectEvents(events.map((event, index) =>
        index === resultIndex
          ? {
              ...event,
              payload: {
                ...(event.payload as any),
                value: { summary: "tampered", count: 2 },
              },
            } as any
          : event
      ))).toThrow();
      expect(await supervisor.runs.admit(
        session.sessionId,
        session.branchId,
        request,
      )).toMatchObject({
        runId: result.runId,
        output: { kind: "object", object: { summary: "complete", count: 2 } },
      });
      await expect(supervisor.runs.admit(
        session.sessionId,
        session.branchId,
        {
          ...request,
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["different"],
              properties: { different: { type: "boolean" } },
            },
          },
        },
      )).rejects.toThrow(/different output schema/i);
    } finally {
      await supervisor.close();
    }
  });

  test("typed blocked output commits no fabricated programmatic result", async () => {
    const temp = await makeTempRuntime("agencity-typed-agent-blocked-"); temps.push(temp);
    const provider = new TypedFinishActions([{
      outcome: {
        status: "blocked",
        message: "Required source data is unavailable.",
      },
    }]);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "typed-agent-blocked",
      model: { provider: provider.name, model: "typed-v1" },
    });
    try {
      const result = await supervisor.runs.start(session.sessionId, session.branchId, {
        task: "Return a blocked structured result",
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["answer"],
            properties: { answer: { type: "string" } },
          },
        },
      });
      expect(result).toMatchObject({
        status: "blocked",
        final: "Required source data is unavailable.",
      });
      expect(result.output).toBeUndefined();
      expect(result.resultReference).toBeUndefined();
      const events = await supervisor.storage.loadEvents(session.sessionId, {
        branchId: session.branchId,
      });
      expect(events.filter(event => event.type === "AgentRunTypedFinishCommitted")).toHaveLength(1);
      expect(events.filter(event => event.type === "AgentRunResultCommitted")).toHaveLength(0);
    } finally {
      await supervisor.close();
    }
  });

  test("schema-constrained completion preserves goal gates and goal-derived failure parity", async () => {
    const temp = await makeTempRuntime("agencity-typed-agent-goal-"); temps.push(temp);
    const provider = new TypedFinishActions([{
      outcome: {
        status: "succeeded",
        message: "Claimed structured completion.",
        value: { ready: true },
      },
    }, {
      outcome: {
        status: "failed",
        message: "Could not repair the required gate.",
      },
    }]);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "typed-agent-goal",
      model: { provider: provider.name, model: "typed-v1" },
    });
    try {
      const goal = await supervisor.goals.create(session.sessionId, session.branchId, {
        description: "Pass the required gate before structured completion",
        gates: [{
          name: "always fails",
          executor: "shell",
          operation: "run",
          input: { command: "exit 7" },
          idempotent: true,
          required: true,
        }],
      });
      const result = await supervisor.runs.start(
        session.sessionId,
        session.branchId,
        {
          task: "Return a gated structured decision",
          goalId: goal.goalId,
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["ready"],
              properties: { ready: { type: "boolean" } },
            },
          },
        },
      );
      expect(result).toMatchObject({
        status: "blocked",
        final: "Could not repair the required gate.",
        reason: expect.stringContaining(
          "Goal repair stopped after a failed required gate",
        ),
      });
      expect(result.output).toBeUndefined();
      expect(result.resultReference).toBeUndefined();
      const events = await supervisor.storage.loadEvents(session.sessionId, {
        branchId: session.branchId,
      });
      expect(events.filter(event =>
        event.type === "AgentRunTypedFinishCommitted"
      )).toHaveLength(2);
      expect(events.filter(event =>
        event.type === "AgentRunGoalCheckRecorded"
      )).toHaveLength(1);
      expect(events.filter(event =>
        event.type === "AgentRunResultCommitted"
      )).toHaveLength(0);
      expect(projectEvents(events).goals[goal.goalId]?.status).toBe("blocked");
    } finally {
      await supervisor.close();
    }
  });

  test("schema-constrained completion commits its result only after required gates pass", async () => {
    const temp = await makeTempRuntime("agencity-typed-agent-passing-goal-"); temps.push(temp);
    const provider = new TypedFinishActions([{
      outcome: {
        status: "succeeded",
        message: "Gated structured completion.",
        value: { ready: true },
      },
    }]);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "typed-agent-passing-goal",
      model: { provider: provider.name, model: "typed-v1" },
    });
    try {
      const goal = await supervisor.goals.create(session.sessionId, session.branchId, {
        description: "Pass before structured completion",
        gates: [{
          name: "passes",
          executor: "shell",
          operation: "run",
          input: { command: "exit 0" },
          idempotent: true,
          required: true,
        }],
      });
      const result = await supervisor.runs.start(
        session.sessionId,
        session.branchId,
        {
          task: "Return a gated structured decision",
          goalId: goal.goalId,
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["ready"],
              properties: { ready: { type: "boolean" } },
            },
          },
        },
      );
      expect(result).toMatchObject({
        status: "succeeded",
        output: { kind: "object", object: { ready: true } },
        resultReference: { kind: "object" },
      });
      const events = await supervisor.storage.loadEvents(session.sessionId, {
        branchId: session.branchId,
      });
      const finish = events.findIndex(event =>
        event.type === "AgentRunTypedFinishCommitted"
      );
      const check = events.findIndex(event =>
        event.type === "AgentRunGoalCheckRecorded"
      );
      const message = events.findIndex((event, index) =>
        index > check && event.type === "MessageAppended" &&
        (event.payload as any).role === "assistant"
      );
      const committed = events.findIndex(event =>
        event.type === "AgentRunResultCommitted"
      );
      const status = events.findIndex((event, index) =>
        index > committed && event.type === "AgentRunStatusChanged"
      );
      expect(finish).toBeLessThan(check);
      expect(check).toBeLessThan(message);
      expect(message).toBeLessThan(committed);
      expect(committed).toBeLessThan(status);
    } finally {
      await supervisor.close();
    }
  });

  test("sdk.agents.run returns a schema-validated object result", async () => {
    const temp = await makeTempRuntime("agencity-typed-agent-sdk-"); temps.push(temp);
    const provider = new TypedFinishActions([{
      outcome: {
        status: "succeeded",
        message: "SDK structured result.",
        value: { ready: true, checks: 3 },
      },
    }]);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const session = await supervisor.createSession({
      workspaceId: "typed-agent-sdk",
      model: { provider: provider.name, model: "typed-v1" },
    });
    try {
      const cell = await supervisor.executeCell(
        session.sessionId,
        session.branchId,
        `return sdk.agents.run({
          task: "Return SDK structured output",
          idempotencyKey: "sdk-structured-output",
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["ready", "checks"],
              properties: {
                ready: { type: "boolean" },
                checks: { type: "integer", minimum: 0 },
              },
            },
          },
        });`,
      );
      expect(cell.result).toMatchObject({
        status: "succeeded",
        final: "SDK structured result.",
        output: { kind: "object", object: { ready: true, checks: 3 } },
        resultReference: { kind: "object" },
      });
      const tasks = await supervisor.agents.listTasks(
        session.sessionId,
        session.branchId,
      );
      expect(tasks[0]?.result).toMatchObject({
        protocol: "agencity.agent-run-result-reference",
        kind: "object",
      });
    } finally {
      await supervisor.close();
    }
  });

  test("recovery makes a lost non-idempotent effect an unknown run terminal without a model call", async () => {
    const temp = await makeTempRuntime("agencity-agent-unknown-"); temps.push(temp);
    const provider = new RecordingActions([action({ type: "final", content: "must not run" })], "unknown-actions");
    let supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
    const session = await supervisor.createSession({ workspaceId: "unknown", model: { provider: provider.name, model: "v1" } });
    const runId = newId();
    await supervisor.storage.appendEvents([{
      sessionId: session.sessionId, branchId: session.branchId, type: "MessageAppended", producer: "client", idempotencyKey: `agent-run-task-message:${runId}`,
      payload: { messageId: `agent-run-task-${runId}`, role: "user", content: "Unknown must block" },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "AgentRunRequested", producer: "client", idempotencyKey: `agent-run-request:${runId}`,
      payload: { runId, task: "Unknown must block", requestKey: "unknown-request", profilePin: await currentProfilePin(supervisor, session.sessionId) },
    }]);
    const effectId = await supervisor.outbox.request({ sessionId: session.sessionId, branchId: session.branchId, executor: "shell", operation: "run", input: { command: "printf ambiguous" }, origin: { kind: "runtime", requestId: "ambiguous-side-effect" }, idempotencyKey: "ambiguous-side-effect", idempotent: false });
    expect(await supervisor.storage.claimEffect(effectId, "dead-owner")).not.toBeNull();
    await supervisor.close();

    supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
    try {
      expect(await supervisor.runs.get(session.sessionId, session.branchId, runId)).toMatchObject({ status: "unknown" });
      expect(provider.calls).toBe(0);
      const state = projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }));
      expect(state.messages.map(message => message.role)).toEqual(["user"]);
      expect(state.agentRuns[runId]?.finalMessageId).toBeUndefined();
    } finally { await supervisor.close(); }
  });

  test("exposes formal runs without a run-input client method or route", async () => {
    const value = await fixture([
      action({ type: "blocked", reason: "A required external decision is missing." }),
    ]);
    const protocol = new ProtocolServer(value.supervisor); const server = protocol.listen(0);
    const client = new AgentClient(`http://${server.hostname}:${server.port}`);
    try {
      const blocked = await client.startRun(value.sessionId, value.branchId, "Protocol task");
      expect(await client.run(value.sessionId, value.branchId, blocked.runId)).toMatchObject({ status: "blocked" });
      expect("respondToRun" in client).toBe(false);
      const removedRoute = await fetch(
        `http://${server.hostname}:${server.port}/sessions/${value.sessionId}/runs/${blocked.runId}/input/unreachable?branch=${value.branchId}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response: "continue" }) },
      );
      expect(removedRoute.status).toBe(404);
      // The compatibility route remains callable, but model work now passes
      // through the same canonical invocation boundary as ordinary runs.
      (value.provider.script as AgentAction[])[0] = action({ type: "final", content: "Diagnostic complete." });
      const beforeDiagnostic = await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId });
      const legacy = await client.turn(value.sessionId, value.branchId) as { outcome: string; runId: string };
      expect(legacy.outcome).toBe("succeeded");
      const diagnosticEvents = (await value.supervisor.storage.loadEvents(value.sessionId, { branchId: value.branchId }))
        .slice(beforeDiagnostic.length);
      const requestedIndex = diagnosticEvents.findIndex((event) => event.type === "AgentRunRequested" &&
        (event.payload as EventPayloads["AgentRunRequested"]).runId === legacy.runId);
      const callIndex = diagnosticEvents.findIndex((event) => event.type === "ModelCallRequested");
      expect(requestedIndex).toBeGreaterThanOrEqual(0);
      expect(callIndex).toBeGreaterThan(requestedIndex);
      const request = diagnosticEvents[requestedIndex]!.payload as EventPayloads["AgentRunRequested"];
      expect(request.profilePin).toEqual(agentProfilePin(await value.supervisor.agentProfiles.active(value.sessionId)));
    } finally { protocol.stop(); await value.supervisor.close(); }
  });
});

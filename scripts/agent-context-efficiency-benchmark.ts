import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_ACTION_PROTOCOL,
  AGENT_ACTION_VERSION,
  AGENT_TOOL_CONTRACT_ID,
  OUTPUT_LIMITS,
  PROVIDER_INPUT_ESTIMATOR_ID,
  buildProviderInputCandidate,
  canonicalJsonByteLength,
  estimateProviderInputCandidate,
  resolveBuiltInModelResponseContract,
  resolveModelDispatch,
  type AgentEvent,
  type AgentAction,
  type AgentRunState,
  type JsonValue,
  type ModelDispatch,
  type ProviderInputCandidate,
  type ProviderInputCapacityProvenance,
} from "../src/domain/index.ts";
import { LocalArtifactStore } from "../src/artifacts/index.ts";
import { ShellExecutor } from "../src/executors/index.ts";
import { formalOutputFromAgentAction } from "../src/executors/model-response.ts";
import {
  agentProviderContext,
  boundedActiveRunProjection,
  deriveAgentProviderObservations,
} from "../src/runtime/index.ts";

const TASK = "Build and verify a five-step HTML page.";
const SYSTEM_PROMPT = "You are the deterministic Agencity context-efficiency benchmark.";
const encoder = new TextEncoder();

const capacity: ProviderInputCapacityProvenance = {
  provider: "fixture",
  model: "fixture/context-efficiency",
  source: "provider-metadata",
  contextWindowTokens: 128_000,
  outputReserveTokens: 2_048,
  estimatorId: PROVIDER_INPUT_ESTIMATOR_ID,
  triggerRatio: 0.8,
  targetRatio: 0.6,
};

function dispatch(): ModelDispatch {
  const responseContract = resolveBuiltInModelResponseContract(
    AGENT_TOOL_CONTRACT_ID,
    "provider-strict",
  );
  return resolveModelDispatch({
    configuration: {
      provider: capacity.provider,
      model: capacity.model,
      maxOutputTokens: capacity.outputReserveTokens,
      reasoningEffort: "high",
    },
    capability: {
      status: "unverified",
      levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
    },
    catalogDigest: "b".repeat(64),
    responseContract,
    responseCapability: {
      kind: "required-tool-set",
      capability: {
        status: "provider-strict",
        requiredChoice: "provider-enforced",
        parallelCalls: "provider-disabled",
        streaming: true,
        catalogDigest: "b".repeat(64),
        adapter: "fixture.context-efficiency.v1",
      },
    },
  });
}

function benchmarkRun(completedSources: readonly string[]): AgentRunState {
  return {
    id: "benchmark-run",
    task: TASK,
    requestKey: "benchmark",
    profilePin: {
      profileVersionId: "benchmark-profile",
      agentPromptDigest: "a".repeat(64),
      promptContractId: "agencity.agent-profile.v1",
    },
    goalId: null,
    goalMode: "none",
    wakeId: null,
    status: "running",
    steps: completedSources.map((code, index) => ({
      id: `step-${index + 1}`,
      ordinal: index + 1,
      contextId: `context-${index + 1}`,
      callId: `call-${index + 1}`,
      effectId: `model-effect-${index + 1}`,
      actionId: `action-${index + 1}`,
      observationEventIds: [],
      modelAttempts: [],
      action: {
        protocol: "agencity.agent-action",
        version: 1,
        type: "typescript",
        code,
      },
      eventId: `action-event-${index + 1}`,
    })),
    goalChecks: {},
    cancellationRequested: false,
    requestEventId: "run-request-event",
    eventId: "run-event",
  };
}

function event(
  id: string,
  type: AgentEvent["type"],
  payload: JsonValue,
  index: number,
): AgentEvent {
  return {
    cursor: String(index).padStart(20, "0"),
    id,
    sessionId: "benchmark-session",
    branchId: "benchmark-branch",
    causationId: null,
    correlationId: null,
    type,
    schemaVersion: 6,
    committedAt: "2026-08-10T00:00:00.000Z",
    producer: "benchmark",
    idempotencyKey: null,
    payload,
    originDeviceId: "benchmark-device",
    originSequence: index,
    streamParentId: index === 1 ? null : `event-${index - 1}`,
  } as AgentEvent;
}

async function largeShellEnvelope(): Promise<JsonValue> {
  const root = await mkdtemp(join(tmpdir(), "agencity-context-benchmark-"));
  try {
    const artifacts = new LocalArtifactStore(join(root, "artifacts"));
    await artifacts.cleanupStaging();
    const execution = await new ShellExecutor(root, artifacts).execute({
      effectId: "benchmark-shell-effect",
      sessionId: "benchmark-session",
      branchId: "benchmark-branch",
      executor: "shell",
      operation: "run",
      input: {
        command: "awk 'BEGIN { for (i = 0; i < 30000; i++) printf \"x\"; printf \"TAIL-MARKER\\\\n\" }'",
      },
      idempotencyKey: "benchmark-shell",
      idempotent: false,
      attempt: 1,
    }, { signal: new AbortController().signal });
    if (execution.outcome !== "succeeded" || !execution.output ||
        typeof execution.output !== "object" || Array.isArray(execution.output) ||
        execution.output.completeness !== "spilled") {
      throw new Error("Deterministic shell fixture did not produce a spilled bounded output");
    }
    return execution.output;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const RUN_TRANSCRIPT_PREFIX = "AGENCITY DURABLE RUN TRANSCRIPT\n";
const RUN_STEP_PREFIX = "AGENCITY NEXT ACTION\n";
const STATE_DELTA_PREFIX = "AGENCITY DURABLE STATE DELTA\n";
const HISTORICAL_CACHE_PLATEAU_TOKENS = 2_496;
const REQUIRED_REUSED_INPUT_RATIO = 0.90;
const LONG_RUN_COUNT = 3;
const LONG_RUN_STEPS = 24;
const LONG_SYSTEM_PROMPT = `${SYSTEM_PROMPT}\n${
  "Retain attributable evidence, use one formal action, and verify measured progress. ".repeat(190)
}`;

type DerivedObservations = ReturnType<typeof deriveAgentProviderObservations>;
type TranscriptFrame = {
  readonly candidate: ProviderInputCandidate;
  readonly context: Record<string, JsonValue>;
  readonly output: ReturnType<typeof formalOutputFromAgentAction>;
  readonly actionId: string;
  readonly stepOrdinal: number;
};
type FormalDecision = {
  readonly tool: "bun_console" | "finish";
  readonly reason: "initial" | "inspect-artifact" | "repair-failure" | "verified";
  readonly artifact?: {
    readonly artifactId: string;
    readonly digest: string;
    readonly size: number;
  };
};

function record(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function requireCheck(
  condition: unknown,
  label: string,
  checks?: string[],
): asserts condition {
  if (!condition) throw new Error(`Context-efficiency check failed: ${label}`);
  checks?.push(label);
}

function parseTextMessage(
  candidate: ProviderInputCandidate,
  prefix: string,
  position: "first" | "last" = "last",
): Record<string, JsonValue> {
  const ordered = position === "last"
    ? [...candidate.messages].reverse()
    : [...candidate.messages];
  const message = ordered.find((item) =>
    item.kind === "text" && item.content.startsWith(prefix));
  if (!message || message.kind !== "text") {
    throw new Error(`Provider input omitted ${prefix.trim()}`);
  }
  return record(JSON.parse(message.content.slice(prefix.length)) as JsonValue);
}

function providerStep(candidate: ProviderInputCandidate): Record<string, JsonValue> {
  const step = parseTextMessage(candidate, RUN_STEP_PREFIX);
  if (typeof step.stepOrdinal !== "number") {
    throw new Error("Provider input next-action message is malformed");
  }
  return step;
}

function transcriptBoundary(candidate: ProviderInputCandidate): Record<string, JsonValue> {
  return parseTextMessage(candidate, RUN_TRANSCRIPT_PREFIX, "first");
}

function stateDeltas(candidate: ProviderInputCandidate): Record<string, JsonValue>[] {
  return candidate.messages.flatMap((message) =>
    message.kind === "text" && message.content.startsWith(STATE_DELTA_PREFIX)
      ? [record(JSON.parse(message.content.slice(STATE_DELTA_PREFIX.length)) as JsonValue)]
      : []);
}

function toolCalls(candidate: ProviderInputCandidate): Array<{
  readonly callId: string;
  readonly name: string;
  readonly input: JsonValue;
}> {
  return candidate.messages.flatMap((message) =>
    message.kind === "assistant-tool-call"
      ? [{ callId: message.callId, name: message.name, input: message.input }]
      : []);
}

function toolObservationGroups(candidate: ProviderInputCandidate): Array<{
  readonly completedStepOrdinal: number;
  readonly actionId: string;
  readonly observations: Record<string, JsonValue>[];
}> {
  return candidate.messages.flatMap((message) => {
    if (message.kind !== "tool-result") return [];
    const value = record(JSON.parse(message.content) as JsonValue);
    return [{
      completedStepOrdinal: Number(value.completedStepOrdinal),
      actionId: String(value.actionId),
      observations: Array.isArray(value.observations)
        ? value.observations.map(record)
        : [],
    }];
  });
}

function artifactReference(value: JsonValue): FormalDecision["artifact"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = artifactReference(item);
      if (found) return found;
    }
    return undefined;
  }
  const candidate = value as Record<string, JsonValue>;
  if (typeof candidate.artifactId === "string" &&
      typeof candidate.digest === "string" &&
      typeof candidate.size === "number") {
    return {
      artifactId: candidate.artifactId,
      digest: candidate.digest,
      size: candidate.size,
    };
  }
  for (const item of Object.values(candidate)) {
    const found = artifactReference(item);
    if (found) return found;
  }
  return undefined;
}

/**
 * This deterministic reader uses only normalized provider messages. It checks
 * discoverability of formal decision facts; it does not simulate model quality.
 */
function nextFormalAction(candidate: ProviderInputCandidate): FormalDecision {
  const latest = toolObservationGroups(candidate).at(-1);
  if (!latest) return { tool: "bun_console", reason: "initial" };
  const failed = latest.observations.some((observation) => {
    const payload = record(observation.payload);
    return observation.type === "CellFailed" ||
      (observation.type === "EffectOutcomeRecorded" && payload.outcome === "failed");
  });
  if (failed) return { tool: "bun_console", reason: "repair-failure" };
  const committed = [...latest.observations].reverse().find((observation) =>
    observation.type === "CellCommitted");
  const result = record(record(committed?.payload).result);
  if (result.phase === "verified") return { tool: "finish", reason: "verified" };
  const artifact = artifactReference(result);
  return artifact
    ? { tool: "bun_console", reason: "inspect-artifact", artifact }
    : { tool: "bun_console", reason: "initial" };
}

function semanticCellObservations(input: {
  readonly step: number;
  readonly terminal: "CellCommitted" | "CellFailed";
  readonly result?: JsonValue;
  readonly error?: string;
  readonly effect?: {
    readonly executor: string;
    readonly operation: string;
    readonly outcome: "succeeded" | "failed";
    readonly output?: JsonValue;
    readonly error?: string;
  };
}): DerivedObservations {
  const actionId = `action-${input.step}`;
  const cellId = `agent-run-cell-${actionId}`;
  const events: AgentEvent[] = [];
  const selectedIds: string[] = [];
  if (input.effect) {
    const effectId = `semantic-effect-${input.step}`;
    events.push(
      event(`semantic-request-${input.step}`, "EffectRequested", {
        effectId,
        executor: input.effect.executor,
        operation: input.effect.operation,
        input: { target: `semantic-step-${input.step}` },
        origin: { kind: "cell", cellId },
        idempotencyKey: `semantic-effect-${input.step}`,
        idempotent: false,
      }, events.length + 1),
      event(`semantic-attempt-${input.step}`, "EffectAttemptStarted", {
        effectId,
        attempt: 1,
      }, events.length + 2),
      event(`semantic-outcome-${input.step}`, "EffectOutcomeRecorded", {
        effectId,
        attempt: 1,
        outcome: input.effect.outcome,
        ...(input.effect.output === undefined ? {} : { output: input.effect.output }),
        ...(input.effect.error === undefined ? {} : { error: input.effect.error }),
        observedAt: "2026-08-10T00:00:00.000Z",
      }, events.length + 3),
    );
    selectedIds.push(`semantic-outcome-${input.step}`);
  }
  const terminalId = `semantic-cell-${input.step}`;
  events.push(event(
    terminalId,
    input.terminal,
    input.terminal === "CellCommitted"
      ? {
          cellId,
          result: input.result ?? null,
          logs: [],
          durationMs: 1,
          exports: [],
        }
      : {
          cellId,
          error: input.error ?? "semantic fixture failed",
          logs: [],
          durationMs: 1,
          exports: [],
        },
    events.length + 1,
  ));
  selectedIds.push(terminalId);
  return deriveAgentProviderObservations(events, selectedIds);
}

function actionForStep(step: number, source?: string): AgentAction {
  return {
    protocol: AGENT_ACTION_PROTOCOL,
    version: AGENT_ACTION_VERSION,
    type: "typescript",
    code: source ??
      `// Purpose: retain measured sample ${step}.\nreturn { sample: ${step}, xpPerMinute: ${40 + step}, accepted: true };`,
  };
}

function semanticFrame(input: {
  readonly run: AgentRunState;
  readonly step: number;
  readonly observations: DerivedObservations;
  readonly action?: AgentAction;
  readonly previous?: TranscriptFrame;
  readonly resetReason?: string;
  readonly systemPrompt?: string;
  readonly base?: Record<string, JsonValue>;
}): TranscriptFrame {
  const action = input.action ?? actionForStep(input.step);
  const context = agentProviderContext(
    {
      activeRuns: [boundedActiveRunProjection(input.run)],
      messages: [{ role: "user", content: input.run.task }],
      ...(input.base ?? {}),
    },
    input.run,
    input.step,
    input.observations,
    modelDispatch,
    input.systemPrompt ?? SYSTEM_PROMPT,
    undefined,
    Date.parse("2026-08-20T12:00:00.000Z") + input.step * 1_000,
    input.resetReason === undefined
      ? input.previous === undefined
        ? {}
        : {
            previousTranscript: {
              candidate: input.previous.candidate,
              context: input.previous.context,
              output: input.previous.output,
              actionId: input.previous.actionId,
              stepOrdinal: input.previous.stepOrdinal,
              observationEventIds: input.observations.map((item) => item.eventId),
              recordIds: [],
            },
          }
      : { resetReason: input.resetReason },
  ) as Record<string, JsonValue>;
  const candidate = buildProviderInputCandidate({
    context,
    modelDispatch,
    capacity,
  });
  return {
    candidate,
    context,
    output: formalOutputFromAgentAction({
      action,
      dispatch: modelDispatch,
      providerToolCallId: `benchmark-tool-call-${input.run.id}-${input.step}`,
      provider: capacity.provider,
      adapter: "fixture.context-efficiency.v1",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    }),
    actionId: `action-${input.step}`,
    stepOrdinal: input.step,
  };
}

function strictMessagePrefix(
  previous: ProviderInputCandidate,
  current: ProviderInputCandidate,
): boolean {
  if (current.messages.length <= previous.messages.length) return false;
  return JSON.stringify(current.messages.slice(0, previous.messages.length)) ===
    JSON.stringify(previous.messages);
}

function messageBytes(candidate: ProviderInputCandidate): number {
  return encoder.encode(JSON.stringify(candidate.messages)).byteLength;
}

function verifyDecisionContract(shellOutput: JsonValue) {
  const checks: string[] = [];
  const requiredTools = ["bun_console", "finish"];
  const prepareSource =
    "// Purpose: inspect the retained spill before deciding completion.\nreturn { prepared: true };";
  const initial = semanticFrame({
    run: benchmarkRun([]),
    step: 1,
    observations: [],
    action: actionForStep(1, prepareSource),
    base: { workingValues: { strategy: { version: 1, phase: "prepare" } } },
  });
  const continuationObservations = semanticCellObservations({
    step: 1,
    terminal: "CellCommitted",
    result: shellOutput,
    effect: {
      executor: "shell",
      operation: "run",
      outcome: "succeeded",
      output: shellOutput,
    },
  });
  const failedSource =
    "// Purpose: repair the exact source location reported by validation.\nthrow new Error('fixture');";
  const continuation = semanticFrame({
    run: benchmarkRun([prepareSource]),
    step: 2,
    observations: continuationObservations,
    previous: initial,
    action: actionForStep(2, failedSource),
    base: { workingValues: { strategy: { version: 2, phase: "inspect-spill" } } },
  });
  const boundary = transcriptBoundary(continuation.candidate);
  const continuationStep = providerStep(continuation.candidate);
  const continuationCalls = toolCalls(continuation.candidate);
  const continuationGroups = toolObservationGroups(continuation.candidate);
  const continuationGroup = continuationGroups.at(-1)!;
  const continuationCell = continuationGroup.observations.find((item) =>
    item.type === "CellCommitted");
  const continuationManifest = Array.isArray(record(continuationCell?.payload).effectManifest)
    ? (record(continuationCell?.payload).effectManifest as JsonValue[]).map(record)
    : [];
  const continuationDecision = nextFormalAction(continuation.candidate);
  requireCheck(strictMessagePrefix(initial.candidate, continuation.candidate),
    "continuation messages retain an exact strict prefix", checks);
  requireCheck(boundary.protocol === "agencity.provider-transcript.v1" &&
    boundary.runId === "benchmark-run" &&
    record(boundary.durableContext).activeRuns !== undefined,
  "initial transcript retains attributable run and durable context", checks);
  requireCheck(continuationStep.runId === "benchmark-run" &&
    continuationStep.task === TASK &&
    continuationStep.stepOrdinal === 2 &&
    Array.isArray(continuationStep.observationEventIds),
  "next-action message retains run, task, ordinal, and observation ids", checks);
  requireCheck(continuationCalls.length === 1 &&
    continuationCalls[0]?.name === "bun_console" &&
    String(record(continuationCalls[0]?.input).source).includes("inspect the retained spill"),
  "assistant tool call retains the exact formal action", checks);
  requireCheck(continuationGroup.completedStepOrdinal === 1 &&
    continuationGroup.actionId === "action-1" &&
    continuationGroup.observations.some((item) => item.type === "CellCommitted"),
  "tool result retains exact completed-step observations", checks);
  requireCheck(stateDeltas(continuation.candidate).some((delta) =>
    record(delta.changed).workingValues !== undefined),
  "changed durable state is appended as a state delta", checks);
  requireCheck(continuation.candidate.tools.map((tool) => tool.name).join(",") ===
    requiredTools.join(",") &&
    initial.candidate.tools.map((tool) => tool.name).join(",") === requiredTools.join(","),
  "formal tool set and order remain bun_console then finish", checks);
  requireCheck(continuationManifest.length === 1 &&
    continuationManifest[0]?.executor === "shell" &&
    continuationManifest[0]?.operation === "run" &&
    continuationManifest[0]?.terminalStatus === "succeeded" &&
    continuationManifest[0]?.attemptCount === 1,
  "cell owns the successful effect manifest", checks);
  requireCheck(!continuationGroup.observations.some((item) =>
    item.type === "EffectOutcomeRecorded"),
  "successful effect payload is not duplicated", checks);
  requireCheck(continuationDecision.tool === "bun_console" &&
    continuationDecision.reason === "inspect-artifact" &&
    continuationDecision.artifact?.artifactId ===
      record(record(shellOutput).artifact).artifactId,
  "artifact evidence selects bun_console continuation", checks);

  const failedError = "src/page.ts:42:7 validation failed";
  const failureObservations = semanticCellObservations({
    step: 2,
    terminal: "CellFailed",
    error: failedError,
    effect: {
      executor: "file",
      operation: "read",
      outcome: "failed",
      error: failedError,
    },
  });
  const recovery = semanticFrame({
    run: benchmarkRun([prepareSource, failedSource]),
    step: 3,
    observations: failureObservations,
    previous: continuation,
    action: actionForStep(3),
    base: { workingValues: { strategy: { version: 3, phase: "repair" } } },
  });
  const recoveryCalls = toolCalls(recovery.candidate);
  const recoveryGroup = toolObservationGroups(recovery.candidate).at(-1)!;
  const failedEffect = recoveryGroup.observations.find((item) =>
    item.type === "EffectOutcomeRecorded");
  const recoveryStep = providerStep(recovery.candidate);
  const recoveryDecision = nextFormalAction(recovery.candidate);
  requireCheck(strictMessagePrefix(continuation.candidate, recovery.candidate),
    "recovery messages retain the prior candidate as an exact strict prefix", checks);
  requireCheck(recoveryCalls.length === 2 &&
    String(record(recoveryCalls[1]?.input).source).includes("repair the exact source location"),
  "appended assistant calls preserve formal action order", checks);
  requireCheck(String(record(failedEffect?.payload).error).includes("src/page.ts:42:7") &&
    String(record(failedEffect?.payload).guidance).includes("adjust the next action"),
  "failed tool result retains actionable bounded diagnostics", checks);
  requireCheck(String(recoveryStep.instruction).includes("small surrounding range") &&
    String(recoveryStep.instruction).includes("Call bun_console"),
  "next-action message retains bounded repair guidance", checks);
  requireCheck(recoveryDecision.tool === "bun_console" &&
    recoveryDecision.reason === "repair-failure",
  "failure evidence selects bun_console repair", checks);

  const completionInitial = semanticFrame({
    run: benchmarkRun([]),
    step: 1,
    observations: [],
    action: actionForStep(
      1,
      "// Purpose: verify the artifact-backed result.\nreturn { phase: 'verified' };",
    ),
  });
  const completion = semanticFrame({
    run: benchmarkRun([
      "// Purpose: verify the artifact-backed result.\nreturn { phase: 'verified' };",
    ]),
    step: 2,
    observations: semanticCellObservations({
      step: 1,
      terminal: "CellCommitted",
      result: {
        phase: "verified",
        artifactId: continuationDecision.artifact!.artifactId,
      },
    }),
    previous: completionInitial,
  });
  const completionDecision = nextFormalAction(completion.candidate);
  requireCheck(completionDecision.tool === "finish" &&
    completionDecision.reason === "verified",
  "verified tool result selects finish", checks);

  return {
    protocol: "agencity.context-efficiency-decision-contract.v2",
    checks,
    scenarios: [
      {
        name: "artifact-backed-continuation",
        expected: "bun_console",
        actual: continuationDecision.tool,
        artifactId: continuationDecision.artifact!.artifactId,
      },
      {
        name: "failed-cell-recovery",
        expected: "bun_console",
        actual: recoveryDecision.tool,
      },
      {
        name: "verified-completion",
        expected: "finish",
        actual: completionDecision.tool,
      },
    ],
    passed: true as const,
    limitation:
      "Deterministic message-fact discoverability is not live-model semantic equivalence.",
  };
}

function measureLongRuns() {
  const runs: Array<Record<string, JsonValue>> = [];
  let aggregateReusedTokens = 0;
  let aggregateInputTokens = 0;
  let aggregateColdStartInputTokens = 0;
  let prefixTransitions = 0;
  let firstReusableBytes = 0;
  let lastReusableBytes = 0;
  let firstReusableTokens = 0;
  let lastReusableTokens = 0;

  for (let runIndex = 0; runIndex < LONG_RUN_COUNT; runIndex++) {
    const completedSources: string[] = [];
    let previous: TranscriptFrame | undefined;
    const reusableBytes: number[] = [];
    const reusableTokens: number[] = [];
    const inputTokens: number[] = [];
    for (let step = 1; step <= LONG_RUN_STEPS; step++) {
      const source =
        `// Purpose: measure training sample ${step} for run ${runIndex + 1}.\n` +
        `const evidence = ${JSON.stringify("accepted-progress ".repeat(18))};\n` +
        `return { sample: ${step}, xpPerMinute: ${40 + step}, accepted: true, evidence };`;
      const observations = step === 1
        ? []
        : semanticCellObservations({
            step: step - 1,
            terminal: "CellCommitted",
            result: {
              sample: step - 1,
              xpPerMinute: 39 + step,
              accepted: true,
              summary: "measured progress ".repeat(12),
            },
          });
      const run = {
        ...benchmarkRun(completedSources),
        id: `long-run-${runIndex + 1}`,
        task: `Sustain measured deterministic training run ${runIndex + 1}.`,
      };
      const frame = semanticFrame({
        run,
        step,
        observations,
        ...(previous === undefined ? {} : { previous }),
        action: actionForStep(step, source),
        systemPrompt: LONG_SYSTEM_PROMPT,
        base: {
          workingValues: {
            strategy: {
              sample: step,
              latestRate: 40 + step,
              target: "sustain confirmed progress",
            },
          },
        },
      });
      const estimate = estimateProviderInputCandidate(frame.candidate);
      inputTokens.push(estimate.estimatedTokens);
      if (previous === undefined) {
        aggregateColdStartInputTokens += estimate.estimatedTokens;
      } else {
        requireCheck(
          strictMessagePrefix(previous.candidate, frame.candidate),
          `long run ${runIndex + 1} step ${step} is not a strict prefix extension`,
        );
        requireCheck(
          JSON.stringify(previous.candidate.tools) === JSON.stringify(frame.candidate.tools),
          `long run ${runIndex + 1} step ${step} changed fixed tools`,
        );
        const reusablePrefixBytes = messageBytes(previous.candidate);
        const conservativeReusedTokens = Math.floor(reusablePrefixBytes / 4);
        reusableBytes.push(reusablePrefixBytes);
        reusableTokens.push(conservativeReusedTokens);
        aggregateReusedTokens += conservativeReusedTokens;
        aggregateInputTokens += estimate.estimatedTokens;
        prefixTransitions++;
      }
      previous = frame;
      completedSources.push(source);
    }
    requireCheck(reusableTokens.every((value, index) =>
      index === 0 || value > reusableTokens[index - 1]!),
    `long run ${runIndex + 1} reusable prefix did not grow monotonically`);
    firstReusableBytes ||= reusableBytes[0]!;
    lastReusableBytes = reusableBytes.at(-1)!;
    firstReusableTokens ||= reusableTokens[0]!;
    lastReusableTokens = reusableTokens.at(-1)!;
    runs.push({
      run: runIndex + 1,
      steps: LONG_RUN_STEPS,
      coldStartInputTokens: inputTokens[0]!,
      firstReusablePrefixBytes: reusableBytes[0]!,
      lastReusablePrefixBytes: reusableBytes.at(-1)!,
      firstReusablePrefixTokens: reusableTokens[0]!,
      lastReusablePrefixTokens: reusableTokens.at(-1)!,
      lastInputTokens: inputTokens.at(-1)!,
      strictPrefixTransitions: reusableTokens.length,
    });
  }
  const reusedInputRatio = aggregateReusedTokens / aggregateInputTokens;
  requireCheck(lastReusableTokens > HISTORICAL_CACHE_PLATEAU_TOKENS,
    "cacheable prefix did not grow beyond the historical 2,496-token plateau");
  requireCheck(reusedInputRatio > REQUIRED_REUSED_INPUT_RATIO,
    `aggregate reused/input ratio ${(reusedInputRatio * 100).toFixed(2)}% is not above 90%`);
  return {
    runs,
    aggregate: {
      coldStarts: LONG_RUN_COUNT,
      coldStartInputTokens: aggregateColdStartInputTokens,
      coldStartsIncludedInRatio: false,
      resetCallsIncludedInRatio: false,
      strictPrefixTransitions: prefixTransitions,
      conservativeReusedTokens: aggregateReusedTokens,
      estimatedInputTokens: aggregateInputTokens,
      reusedInputRatio: Number(reusedInputRatio.toFixed(6)),
      reusedInputPercent: Number((reusedInputRatio * 100).toFixed(2)),
      requiredReusedInputPercentExclusive: REQUIRED_REUSED_INPUT_RATIO * 100,
      firstReusablePrefixBytes: firstReusableBytes,
      lastReusablePrefixBytes: lastReusableBytes,
      firstReusablePrefixTokens: firstReusableTokens,
      lastReusablePrefixTokens: lastReusableTokens,
      historicalPlateauTokens: HISTORICAL_CACHE_PLATEAU_TOKENS,
      passed: true,
    },
  };
}

function verifySegmentReset() {
  const source1 = "// Purpose: establish the first segment.\nreturn { segment: 1 };";
  const source2 = "// Purpose: continue the first segment.\nreturn { segment: 1, step: 2 };";
  const source3 =
    "// Purpose: retain measured sample 3.\nreturn { sample: 3, xpPerMinute: 43, accepted: true };";
  const initial = semanticFrame({
    run: benchmarkRun([]),
    step: 1,
    observations: [],
    action: actionForStep(1, source1),
  });
  const beforeReset = semanticFrame({
    run: benchmarkRun([source1]),
    step: 2,
    observations: semanticCellObservations({
      step: 1,
      terminal: "CellCommitted",
      result: { segment: 1 },
    }),
    previous: initial,
    action: actionForStep(2, source2),
  });
  const resetReason = "context-efficiency-deliberate-reset";
  const reset = semanticFrame({
    run: benchmarkRun([source1, source2]),
    step: 3,
    observations: semanticCellObservations({
      step: 2,
      terminal: "CellCommitted",
      result: { segment: 1, step: 2 },
    }),
    resetReason,
    action: actionForStep(3),
  });
  const afterReset = semanticFrame({
    run: benchmarkRun([source1, source2, source3]),
    step: 4,
    observations: semanticCellObservations({
      step: 3,
      terminal: "CellCommitted",
      result: { segment: 2, step: 1 },
    }),
    previous: reset,
    action: actionForStep(4),
  });
  requireCheck(strictMessagePrefix(initial.candidate, beforeReset.candidate),
    "pre-reset candidate is not a strict prefix extension");
  requireCheck(!strictMessagePrefix(beforeReset.candidate, reset.candidate),
    "reset candidate unexpectedly prefixes the prior segment");
  requireCheck(strictMessagePrefix(reset.candidate, afterReset.candidate),
    "post-reset candidate does not prefix the reset segment");
  requireCheck(transcriptBoundary(reset.candidate).resetReason === resetReason,
    "reset candidate omitted its attributable reset reason");
  requireCheck(JSON.stringify(beforeReset.candidate.tools) ===
    JSON.stringify(reset.candidate.tools) &&
    JSON.stringify(reset.candidate.tools) === JSON.stringify(afterReset.candidate.tools),
  "segment reset changed fixed formal tools");
  return {
    protocol: "agencity.context-efficiency-segment-reset.v1",
    resetReason,
    transitions: [
      { from: 1, to: 2, classification: "strict-prefix" },
      { from: 2, to: 3, classification: "deliberate-reset-excluded" },
      { from: 3, to: 4, classification: "strict-prefix-after-reset" },
    ],
    priorSegmentMessageBytes: messageBytes(beforeReset.candidate),
    resetSegmentMessageBytes: messageBytes(reset.candidate),
    nextSegmentMessageBytes: messageBytes(afterReset.candidate),
    passed: true,
  };
}

const modelDispatch = dispatch();
const shellOutput = await largeShellEnvelope();
const semanticPreservation = verifyDecisionContract(shellOutput);
const cacheability = measureLongRuns();
const segmentReset = verifySegmentReset();
const spilled = shellOutput as Record<string, JsonValue>;
const report = {
  protocol: "agencity.context-efficiency-benchmark.v2",
  contract: "append-only-provider-transcript",
  deterministic: true,
  cacheability,
  segmentReset,
  semanticPreservation,
  boundedContext: {
    successfulCellEffectOwnership: "checked",
    duplicateSuccessfulEffectPayload: false,
    shellOutputCompleteness: spilled.completeness,
    shellArtifactBytes: (spilled.artifact as Record<string, JsonValue>).size,
    shellPreviewBytes: canonicalJsonByteLength(spilled.preview!),
    previewLimitBytesPerStream: OUTPUT_LIMITS.shellPreviewBytesPerStream,
    artifactRangeLimitBytes: OUTPUT_LIMITS.artifactRangeBytes,
  },
  providerReportedInputTokens: {
    status: "not-measured",
    reason: "This benchmark uses deterministic fake outputs and makes no external calls.",
  },
  limitations: [
    "Estimated tokens use the repository's deterministic UTF-8-bytes-per-four estimator.",
    "Reused tokens count only the prior candidate's byte-identical message array.",
    "Cold starts and deliberate reset calls are labeled and excluded from the reused/input ratio.",
    "The benchmark does not simulate provider cache behavior, model quality, paid performance, or live-provider semantics.",
  ],
};

console.log(JSON.stringify(report, null, 2));

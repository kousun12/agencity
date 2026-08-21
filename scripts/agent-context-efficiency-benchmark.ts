import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_TOOL_CONTRACT_ID,
  OUTPUT_LIMITS,
  PROVIDER_INPUT_ESTIMATOR_ID,
  buildProviderInputCandidate,
  canonicalJsonByteLength,
  estimateProviderInputCandidate,
  resolveBuiltInModelResponseContract,
  resolveModelDispatch,
  type AgentEvent,
  type AgentRunState,
  type JsonValue,
  type ModelDispatch,
  type ProviderInputCapacityProvenance,
} from "../src/domain/index.ts";
import { LocalArtifactStore } from "../src/artifacts/index.ts";
import { ShellExecutor } from "../src/executors/index.ts";
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
    schemaVersion: 5,
    committedAt: "2026-08-10T00:00:00.000Z",
    producer: "benchmark",
    idempotencyKey: null,
    payload,
    originDeviceId: "benchmark-device",
    originSequence: index,
    streamParentId: index === 1 ? null : `event-${index - 1}`,
  } as AgentEvent;
}

function observationsForStep(
  step: number,
  shellOutput: JsonValue,
): {
  derived: ReturnType<typeof deriveAgentProviderObservations>;
  raw: JsonValue[];
} {
  if (step === 1) return { derived: [], raw: [] };
  const cellId = `cell-${step - 1}`;
  const effectId = `shell-effect-${step - 1}`;
  const events = [
    event(`request-${step}`, "EffectRequested", {
      effectId,
      executor: "shell",
      operation: "run",
      input: { command: "produce deterministic large output" },
      origin: { kind: "cell", cellId },
      idempotencyKey: `shell-${step}`,
      idempotent: false,
    }, 1),
    event(`attempt-${step}`, "EffectAttemptStarted", { effectId, attempt: 1 }, 2),
    event(`outcome-${step}`, "EffectOutcomeRecorded", {
      effectId,
      attempt: 1,
      outcome: "succeeded",
      output: shellOutput,
      observedAt: "2026-08-10T00:00:00.000Z",
    }, 3),
    event(`cell-${step}`, "CellCommitted", {
      cellId,
      result: shellOutput,
      logs: [],
      durationMs: 1,
      exports: [],
    }, 4),
  ];
  const selected = events.filter((item) =>
    item.type === "EffectOutcomeRecorded" || item.type === "CellCommitted");
  const observationIds = selected.map((item) => item.id);
  return {
    derived: deriveAgentProviderObservations(events, observationIds),
    raw: selected.map((item) => JSON.parse(JSON.stringify({
      eventId: item.id,
      type: item.type,
      payload: item.payload,
    })) as JsonValue),
  };
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

const RUN_STEP_PREFIX = "AGENCITY NEXT ACTION\n";

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

function providerStep(
  candidate: ReturnType<typeof buildProviderInputCandidate>,
): Record<string, JsonValue> {
  const message = [...candidate.messages].reverse().find((item) =>
    item.kind === "text" &&
    item.role === "user" &&
    item.content.startsWith(RUN_STEP_PREFIX));
  if (!message || message.kind !== "text") {
    throw new Error("Provider input omitted the durable run step");
  }
  const parsed = JSON.parse(message.content.slice(RUN_STEP_PREFIX.length)) as JsonValue;
  const step = record(parsed);
  if (typeof step.stepOrdinal !== "number") {
    throw new Error("Provider input durable run step is malformed");
  }
  return step;
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
 * This intentionally small contract decides only from the exact normalized
 * provider messages. It fails if context reduction removes a fact required for
 * the next formal action; it is not a model-quality simulation.
 */
function nextFormalAction(
  candidate: ReturnType<typeof buildProviderInputCandidate>,
): FormalDecision {
  const run = providerStep(candidate);
  const observations = Array.isArray(run.observations)
    ? run.observations.map(record)
    : [];
  const failed = observations.some((observation) => {
    const payload = record(observation.payload);
    return observation.type === "CellFailed" ||
      (observation.type === "EffectOutcomeRecorded" &&
        payload.outcome === "failed");
  });
  if (failed) return { tool: "bun_console", reason: "repair-failure" };

  const committed = [...observations].reverse().find((observation) =>
    observation.type === "CellCommitted");
  const result = record(record(committed?.payload).result);
  if (result.phase === "verified") return { tool: "finish", reason: "verified" };
  const artifact = artifactReference(result as JsonValue);
  if (artifact) {
    return { tool: "bun_console", reason: "inspect-artifact", artifact };
  }
  return { tool: "bun_console", reason: "initial" };
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
}): {
  readonly events: AgentEvent[];
  readonly derived: ReturnType<typeof deriveAgentProviderObservations>;
} {
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
  return {
    events,
    derived: deriveAgentProviderObservations(events, selectedIds),
  };
}

function semanticCandidate(input: {
  readonly run: AgentRunState;
  readonly step: number;
  readonly observations: ReturnType<typeof deriveAgentProviderObservations>;
  readonly recentActivity?: readonly JsonValue[];
}): ReturnType<typeof buildProviderInputCandidate> {
  const context = agentProviderContext(
    {
      activeRuns: [boundedActiveRunProjection(input.run)],
      messages: [{ role: "user", content: TASK }],
      recentActivity: [...(input.recentActivity ?? [])],
    },
    input.run,
    input.step,
    input.observations,
    modelDispatch,
    SYSTEM_PROMPT,
    undefined,
    undefined,
    input.step === 1
      ? {}
      : { resetReason: `context-efficiency-benchmark-step-${input.step}` },
  );
  return buildProviderInputCandidate({
    context,
    modelDispatch,
    capacity,
  });
}

function verifyDecisionContract(shellOutput: JsonValue): {
  readonly protocol: string;
  readonly checks: readonly string[];
  readonly scenarios: readonly Record<string, JsonValue>[];
  readonly passed: true;
  readonly limitation: string;
} {
  const checks: string[] = [];
  const require = (condition: unknown, label: string): void => {
    if (!condition) throw new Error(`Semantic preservation check failed: ${label}`);
    checks.push(label);
  };
  const requiredTools = ["bun_console", "finish"];

  const prepareSource =
    "// Purpose: inspect the retained spill before deciding completion.\nreturn { prepared: true };";
  const continuationRun = benchmarkRun([prepareSource]);
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
  const continuation = semanticCandidate({
    run: continuationRun,
    step: 2,
    observations: continuationObservations.derived,
  });
  const continuationStep = providerStep(continuation);
  const continuationTrajectory = Array.isArray(continuationStep.recentTrajectory)
    ? continuationStep.recentTrajectory.map(record)
    : [];
  const continuationObservation = (Array.isArray(continuationStep.observations)
    ? continuationStep.observations.map(record)
    : []).find((item) => item.type === "CellCommitted");
  const continuationPayload = record(continuationObservation?.payload);
  const continuationManifest = Array.isArray(continuationPayload.effectManifest)
    ? continuationPayload.effectManifest.map(record)
    : [];
  const continuationDecision = nextFormalAction(continuation);
  require(continuation.tools.map((tool) => tool.name).join(",") === requiredTools.join(","),
    "formal tool set is bun_console then finish");
  require(continuationStep.runId === "benchmark-run" &&
    continuationStep.task === TASK && continuationStep.stepOrdinal === 2,
  "continuation preserves run, task, and step identity");
  require(continuationTrajectory.map((item) => item.ordinal).join(",") === "1",
    "continuation preserves trajectory order");
  require(typeof record(record(continuationTrajectory[0]?.action).source).sha256 === "string" &&
    record(continuationTrajectory[0]?.outcome).status === "committed",
  "continuation preserves compact action and outcome facts");
  require(continuationManifest.length === 1 &&
    continuationManifest[0]?.executor === "shell" &&
    continuationManifest[0]?.operation === "run" &&
    continuationManifest[0]?.terminalStatus === "succeeded" &&
    continuationManifest[0]?.attemptCount === 1,
  "cell owns the successful effect manifest");
  require(!(Array.isArray(continuationStep.observations)
    ? continuationStep.observations.map(record)
    : []).some((item) => item.type === "EffectOutcomeRecorded"),
  "successful effect output is not duplicated");
  require(continuationDecision.tool === "bun_console" &&
    continuationDecision.reason === "inspect-artifact" &&
    continuationDecision.artifact?.artifactId ===
      record(record(shellOutput).artifact).artifactId,
  "artifact reference selects bun_console continuation");

  const failedSource =
    "// Purpose: repair the exact source location reported by validation.\nthrow new Error('fixture');";
  const recoveryRun = benchmarkRun([prepareSource, failedSource]);
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
  const recovery = semanticCandidate({
    run: recoveryRun,
    step: 3,
    observations: failureObservations.derived,
    recentActivity: continuationObservations.derived as unknown as JsonValue[],
  });
  const recoveryStep = providerStep(recovery);
  const recoveryTrajectory = Array.isArray(recoveryStep.recentTrajectory)
    ? recoveryStep.recentTrajectory.map(record)
    : [];
  const recoveryObservations = Array.isArray(recoveryStep.observations)
    ? recoveryStep.observations.map(record)
    : [];
  const failedEffect = recoveryObservations.find((item) =>
    item.type === "EffectOutcomeRecorded");
  const recoveryDecision = nextFormalAction(recovery);
  require(recoveryStep.runId === "benchmark-run" &&
    recoveryStep.task === TASK && recoveryStep.stepOrdinal === 3,
  "recovery preserves run, task, and step identity");
  require(recoveryTrajectory.map((item) => item.ordinal).join(",") === "1,2",
    "recovery preserves action order");
  require(typeof record(record(recoveryTrajectory[0]?.action).source).sha256 === "string" &&
    Array.isArray(record(recoveryTrajectory[0]?.outcome).effects),
  "recovery preserves prior compact action, result, and effect facts");
  require(String(record(record(recoveryTrajectory[1]?.action).source).text)
    .includes("repair the exact source location") &&
    record(recoveryTrajectory[1]?.outcome).status === "failed",
  "recovery preserves latest failed action and outcome");
  require(String(record(failedEffect?.payload).error).includes("src/page.ts:42:7") &&
    String(record(failedEffect?.payload).guidance).includes("adjust the next action"),
  "recovery preserves actionable failure and effect guidance");
  require(String(recoveryStep.instruction).includes("small surrounding range") &&
    String(recoveryStep.instruction).includes("Call bun_console"),
  "recovery preserves bounded repair guidance");
  require(recoveryDecision.tool === "bun_console" &&
    recoveryDecision.reason === "repair-failure",
  "failure selects bun_console repair");

  const completionRun = benchmarkRun([
    "// Purpose: verify the artifact-backed result.\nreturn { phase: 'verified' };",
  ]);
  const completionObservations = semanticCellObservations({
    step: 1,
    terminal: "CellCommitted",
    result: {
      phase: "verified",
      artifactId: continuationDecision.artifact!.artifactId,
    },
  });
  const completion = semanticCandidate({
    run: completionRun,
    step: 2,
    observations: completionObservations.derived,
  });
  const completionStep = providerStep(completion);
  const completionDecision = nextFormalAction(completion);
  require(completionStep.task === TASK && completionStep.stepOrdinal === 2,
    "completion preserves task and step identity");
  require(completionDecision.tool === "finish" &&
    completionDecision.reason === "verified",
  "verified evidence selects finish");

  return {
    protocol: "agencity.context-efficiency-decision-contract.v1",
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
    passed: true,
    limitation:
      "Deterministic decision-contract equivalence is not live-model semantic equivalence.",
  };
}

const modelDispatch = dispatch();
const shellOutput = await largeShellEnvelope();
const completedSources: string[] = [];
const steps: Array<Record<string, unknown>> = [];
let baselineMessagesTotal = 0;
let providerMessagesTotal = 0;

for (let step = 1; step <= 5; step++) {
  if (step > 1) {
    completedSources.push(
      `const page${step - 1} = ${JSON.stringify("<html>".repeat(1_500))}; return page${step - 1};`,
    );
  }
  const run = benchmarkRun(completedSources);
  const observations = observationsForStep(step, shellOutput);
  const context = agentProviderContext(
    {
      activeRuns: [boundedActiveRunProjection(run)],
      messages: [{ role: "user", content: TASK }],
    },
    run,
    step,
    observations.derived,
    modelDispatch,
    SYSTEM_PROMPT,
    undefined,
    undefined,
    step === 1
      ? {}
      : { resetReason: `context-efficiency-measurement-step-${step}` },
  );
  const candidate = buildProviderInputCandidate({
    context,
    modelDispatch,
    capacity,
  });
  const estimate = estimateProviderInputCandidate(candidate);

  // Captured pre-change shape: completed action source accumulated in
  // activeRuns and successful effect output was delivered beside the cell.
  const baselineStep = {
    runId: run.id,
    task: TASK,
    stepOrdinal: step,
    status: "running",
    observations: observations.raw,
    durableContext: {
      activeRuns: [{
        id: run.id,
        task: TASK,
        status: "running",
        steps: completedSources.map((code, index) => ({
          ordinal: index + 1,
          action: { type: "typescript", code },
        })),
      }],
    },
  };
  const baselineMessages: JsonValue = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: TASK },
    {
      role: "user",
      content: `AGENCITY DURABLE RUN STEP\n${JSON.stringify(baselineStep)}`,
    },
  ];
  const baselineMessageBytes = canonicalJsonByteLength(baselineMessages);
  const providerMessageBytes = canonicalJsonByteLength(
    candidate.messages as unknown as JsonValue,
  );
  baselineMessagesTotal += baselineMessageBytes;
  providerMessagesTotal += providerMessageBytes;

  const automaticObservationBytesByEventType: Record<string, number> = {};
  for (const observation of observations.derived) {
    automaticObservationBytesByEventType[observation.type] =
      (automaticObservationBytesByEventType[observation.type] ?? 0) +
      encoder.encode(JSON.stringify(observation)).byteLength;
  }
  steps.push({
    step,
    completeProviderInputCandidateBytes: candidate.exactUtf8Bytes,
    serializedProviderMessageBytes: providerMessageBytes,
    serializedProviderRequestBytes: estimate.utf8Bytes,
    estimatedInputTokens: estimate.estimatedTokens,
    baselineProviderMessageBytes: baselineMessageBytes,
    automaticObservationBytesByEventType,
    compaction: {
      status: "not-required",
      capacity,
    },
  });
}

const reductionPercent =
  Number(((1 - providerMessagesTotal / baselineMessagesTotal) * 100).toFixed(2));
if (reductionPercent < 30) {
  throw new Error(
    `Provider-message reduction ${reductionPercent}% is below the required 30%`,
  );
}

const semanticPreservation = verifyDecisionContract(shellOutput);
const spilled = shellOutput as Record<string, JsonValue>;
const report = {
  protocol: "agencity.context-efficiency-benchmark.v1",
  scenario: {
    steps: 5,
    baseline:
      "Captured pre-change provider-message shape with accumulated completed action source and duplicate successful effect/cell observations.",
  },
  steps,
  cumulative: {
    baselineProviderMessageBytes: baselineMessagesTotal,
    providerMessageBytes: providerMessagesTotal,
    reductionPercent,
    requiredReductionPercent: 30,
    passed: true,
  },
  semanticPreservation,
  spill: {
    completeness: spilled.completeness,
    artifactBytes: (spilled.artifact as Record<string, JsonValue>).size,
    previewBytes: canonicalJsonByteLength(spilled.preview!),
    previewLimitBytesPerStream: OUTPUT_LIMITS.shellPreviewBytesPerStream,
    artifactRangeLimitBytes: OUTPUT_LIMITS.artifactRangeBytes,
  },
  providerReportedInputTokens: {
    status: "skipped",
    reason: "credential-gated live-provider verification was not enabled",
  },
};

console.log(JSON.stringify(report, null, 2));

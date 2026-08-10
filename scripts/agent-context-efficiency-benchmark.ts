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

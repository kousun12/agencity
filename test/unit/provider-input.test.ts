import { describe, expect, test } from "bun:test";
import {
  AGENT_TOOL_CONTRACT_ID,
  PROVIDER_INPUT_ESTIMATOR_ID,
  PROVIDER_INPUT_VERSION,
  buildProviderInputCandidate,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  estimateProviderInputCandidate,
  resolveBuiltInModelResponseContract,
  resolveModelDispatch,
  serializedProviderInput,
  validateProviderInputCandidate,
  type JsonValue,
  type ModelDispatch,
} from "../../src/domain/index.ts";
import { agentProviderContext } from "../../src/runtime/agent-runs.ts";
import { boundedActiveRunProjection } from "../../src/runtime/context.ts";

const capacity = {
  provider: "fixture",
  model: "fixture/model",
  source: "unknown" as const,
  contextWindowTokens: null,
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
      temperature: 0.25,
      maxOutputTokens: 2_048,
      reasoningEffort: "high",
    },
    capability: {
      status: "unverified",
      levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
    },
    catalogDigest: "a".repeat(64),
    responseContract,
    responseCapability: {
      kind: "required-tool-set",
      capability: {
        status: "provider-strict",
        requiredChoice: "provider-enforced",
        parallelCalls: "provider-disabled",
        streaming: true,
        catalogDigest: "a".repeat(64),
        adapter: "fixture.provider-input.v1",
      },
    },
  });
}

describe("versioned provider input", () => {
  test("seals exact normalized messages, tools, policies, options, provenance, digest, and bytes", () => {
    const modelDispatch = dispatch();
    const candidate = buildProviderInputCandidate({
      context: {
        ignoredRetainedField: "not sent",
        messages: [
          { role: "system", content: "system" },
          { role: "tool", content: "tool output" },
          { role: "assistant", content: "assistant" },
        ],
      },
      modelDispatch,
      capacity,
    });

    expect(candidate.version).toBe(PROVIDER_INPUT_VERSION);
    expect(candidate.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "[tool observation]\ntool output" },
      { role: "assistant", content: "assistant" },
    ]);
    expect(candidate.tools.map((tool) => ({
      name: tool.name,
      strict: tool.strict,
      schemaDigest: tool.schemaDigest,
    }))).toEqual(modelDispatch.responseContract.kind === "required-tool-set"
      ? modelDispatch.responseContract.tools.map((tool) => ({
          name: tool.name,
          strict: true,
          schemaDigest: tool.schemaDigest,
        }))
      : []);
    expect(candidate.policy).toEqual({
      schemaEnforcement: "provider-strict",
      selection: "exactly-one-of",
      toolChoice: "required",
      parallelCalls: "provider-disabled",
    });
    expect(candidate.options).toEqual({
      temperature: 0.25,
      maxOutputTokens: 2_048,
      reasoningEffort: "high",
      outputReserveTokens: 2_048,
    });
    expect(candidate.provenance).toMatchObject({
      provider: capacity.provider,
      model: capacity.model,
      capacity,
      estimatorId: PROVIDER_INPUT_ESTIMATOR_ID,
      responseContract: {
        contractId: AGENT_TOOL_CONTRACT_ID,
        contractDigest: modelDispatch.responseContract.kind === "required-tool-set"
          ? modelDispatch.responseContract.contractDigest
          : null,
      },
    });
    expect(candidate.exactUtf8Bytes)
      .toBe(canonicalJsonByteLength(candidate as unknown as JsonValue));
    expect(estimateProviderInputCandidate(candidate).utf8Bytes)
      .toBe(canonicalJsonByteLength(serializedProviderInput(candidate)));
    expect(validateProviderInputCandidate(candidate)).toEqual(candidate);
  });

  test("ignores unsent retained-context fields in candidate identity and estimates", () => {
    const modelDispatch = dispatch();
    const first = buildProviderInputCandidate({
      context: {
        messages: [{ role: "user", content: "same provider input" }],
        activeRuns: [{ code: "large old source" }],
        providerConfigurations: [{ reference: "routing-only" }],
      },
      modelDispatch,
      capacity,
    });
    const second = buildProviderInputCandidate({
      context: {
        messages: [{ role: "user", content: "same provider input" }],
        activeRuns: [{ code: "different retained source".repeat(10_000) }],
        unrelatedWorkspaceSession: "other",
      },
      modelDispatch,
      capacity,
    });
    expect(second).toEqual(first);
    expect(estimateProviderInputCandidate(second))
      .toEqual(estimateProviderInputCandidate(first));
  });

  test("keeps active-run control projection bounded as completed source grows", () => {
    const run = (count: number) => ({
      id: "run",
      task: "bounded task",
      requestKey: "request",
      profilePin: {
        profileVersionId: "profile",
        agentPromptDigest: "a".repeat(64),
        promptContractId: "agencity.agent-profile.v1",
      },
      goalId: null,
      goalMode: "none",
      wakeId: null,
      status: "running",
      steps: Array.from({ length: count }, (_, index) => ({
        id: `step-${index}`,
        ordinal: index + 1,
        contextId: `context-${index}`,
        callId: `call-${index}`,
        effectId: `effect-${index}`,
        actionId: `action-${index}`,
        observationEventIds: [],
        modelAttempts: [],
        action: {
          protocol: "agencity.agent-action",
          version: 1,
          type: "typescript",
          code: `SECRET-SOURCE-${index}-${"x".repeat(8_000)}`,
        },
        eventId: `event-${index}`,
      })),
      goalChecks: {},
      cancellationRequested: false,
      requestEventId: "request-event",
      eventId: "run-event",
    });
    const one = boundedActiveRunProjection(run(1) as any);
    const many = boundedActiveRunProjection(run(100) as any);
    expect(JSON.stringify(many)).not.toContain("SECRET-SOURCE");
    expect(canonicalJsonByteLength(many))
      .toBeLessThan(canonicalJsonByteLength(one) + 8);
  });

  test("rejects digest, byte-count, and reconstruction tampering", () => {
    const modelDispatch = dispatch();
    const context: JsonValue = {
      messages: [{ role: "user", content: "original" }],
    };
    const candidate = buildProviderInputCandidate({
      context,
      modelDispatch,
      capacity,
    });
    const digestTamper = JSON.parse(JSON.stringify(candidate));
    digestTamper.messages[0].content = "tampered";
    expect(() => validateProviderInputCandidate(digestTamper))
      .toThrow("digest");

    const byteTamper = JSON.parse(JSON.stringify(candidate));
    byteTamper.exactUtf8Bytes++;
    expect(() => validateProviderInputCandidate(byteTamper))
      .toThrow("byte count");

    const different = buildProviderInputCandidate({
      context: { messages: [{ role: "user", content: "different" }] },
      modelDispatch,
      capacity,
    });
    expect(() => validateProviderInputCandidate(different, {
      context,
      modelDispatch,
      capacity,
    })).toThrow("differs from reconstructed");

    const resealedMalformed = JSON.parse(JSON.stringify(candidate));
    resealedMalformed.messages[0].unexpected = true;
    reseal(resealedMalformed);
    expect(() => validateProviderInputCandidate(resealedMalformed))
      .toThrow("missing or unknown fields");
  });

  test("retains only a bounded recent action trajectory for the next decision", () => {
    const modelDispatch = dispatch();
    const steps = Array.from({ length: 12 }, (_, index) => ({
      id: `step-${index + 1}`,
      ordinal: index + 1,
      contextId: `context-${index + 1}`,
      callId: `call-${index + 1}`,
      effectId: `effect-${index + 1}`,
      actionId: `action-${index + 1}`,
      observationEventIds: [],
      modelAttempts: [],
      action: {
        protocol: "agencity.agent-action",
        version: 1,
        type: "typescript",
        code: `// Purpose: complete step ${index + 1}\n${"x".repeat(4_000)}`,
      },
      eventId: `event-${index + 1}`,
    }));
    const context = agentProviderContext(
      {
        messages: [{ role: "user", content: "Complete the task." }],
        recentActivity: [{
          eventId: "cell-terminal-12",
          type: "CellCommitted",
          payload: {
            cellId: "agent-run-cell-action-12",
            result: { content: "r".repeat(8_000) },
            effectManifest: [
              {
                effectId: "read-1",
                executor: "file",
                operation: "read",
                terminalStatus: "succeeded",
                attemptCount: 1,
              },
              {
                effectId: "read-2",
                executor: "file",
                operation: "read",
                terminalStatus: "succeeded",
                attemptCount: 2,
              },
            ],
          },
        }],
      },
      {
        id: "run",
        task: "Complete the task.",
        status: "running",
        steps,
        goalChecks: {},
      } as any,
      13,
      [],
      modelDispatch,
      "system prompt",
    ) as any;

    expect(context.run.recentTrajectory.map((item: any) => item.ordinal))
      .toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(context.run.recentTrajectory.every((item: any) =>
      item.action.source.text === undefined &&
      item.action.source.originalByteLength > 2_048 &&
      typeof item.action.source.sha256 === "string" &&
      item.action.declaredPurpose.text.startsWith("complete step "))).toBe(true);
    expect(context.run.recentTrajectory.at(-1).outcome).toMatchObject({
      status: "committed",
      eventId: "cell-terminal-12",
      result: {
        originalByteLength: expect.any(Number),
        sha256: expect.any(String),
      },
      effects: [{
        executor: "file",
        operation: "read",
        terminalStatus: "succeeded",
        count: 2,
        maxAttemptCount: 2,
      }],
    });
    expect(JSON.stringify(context.run.recentTrajectory)).not.toContain("rrrrrrrr");
    expect(context.run.instruction).toContain("If the evidence is sufficient, call finish now");
    expect(context.run.instruction).not.toContain("Continue from these");
  });

  test("retains detailed source only for the latest failed action and gives focused recovery guidance", () => {
    const modelDispatch = dispatch();
    const source = `// Purpose: repair the reported syntax error\n${"x".repeat(4_000)}`;
    const context = agentProviderContext(
      { messages: [{ role: "user", content: "Repair the file." }] },
      {
        id: "run",
        task: "Repair the file.",
        status: "running",
        steps: [{
          id: "step-1",
          ordinal: 1,
          contextId: "context-1",
          callId: "call-1",
          effectId: "effect-1",
          actionId: "action-1",
          observationEventIds: [],
          modelAttempts: [],
          action: {
            protocol: "agencity.agent-action",
            version: 1,
            type: "typescript",
            code: source,
          },
          eventId: "event-1",
        }],
        goalChecks: {},
      } as any,
      2,
      [{
        eventId: "cell-failed-1",
        type: "CellFailed",
        payload: {
          cellId: "agent-run-cell-action-1",
          error: "SyntaxError: unexpected token at index.html:42:7",
        },
      }],
      modelDispatch,
      "system prompt",
    ) as any;

    expect(context.run.recentTrajectory[0]).toMatchObject({
      action: {
        type: "bun_console",
        declaredPurpose: { text: "repair the reported syntax error" },
        source: {
          text: expect.stringContaining("// Purpose: repair the reported syntax error"),
          truncated: true,
        },
      },
      outcome: {
        status: "failed",
        eventId: "cell-failed-1",
        details: "run.observations",
      },
    });
    expect(context.run.instruction).toContain("about 20 lines on each side");
    expect(context.run.instruction).toContain("Do not reread the whole file");
  });

  test("reduces the deterministic five-step serialized-message benchmark by at least 30 percent", () => {
    const modelDispatch = dispatch();
    const oldBytes: number[] = [];
    const newBytes: number[] = [];
    const completedSources: string[] = [];
    for (let step = 1; step <= 5; step++) {
      if (step > 1) {
        completedSources.push(
          `const page${step - 1} = ${JSON.stringify("<html>".repeat(1_500))}; return page${step - 1};`,
        );
      }
      const conversation = [
        { role: "system", content: "system prompt" },
        { role: "user", content: "Build and verify a five-step HTML page." },
      ];
      const oldStep = {
        runId: "run",
        task: "Build and verify a five-step HTML page.",
        stepOrdinal: step,
        status: "running",
        observations: [],
        durableContext: {
          activeRuns: [{
            id: "run",
            task: "Build and verify a five-step HTML page.",
            status: "running",
            steps: completedSources.map((code, index) => ({
              ordinal: index + 1,
              action: { type: "typescript", code },
            })),
          }],
        },
      };
      const run = {
        id: "run",
        task: "Build and verify a five-step HTML page.",
        requestKey: "benchmark",
        profilePin: {
          profileVersionId: "profile",
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
          effectId: `effect-${index + 1}`,
          actionId: `action-${index + 1}`,
          observationEventIds: [],
          modelAttempts: [],
          action: {
            protocol: "agencity.agent-action",
            version: 1,
            type: "typescript",
            code,
          },
          eventId: `event-${index + 1}`,
        })),
        goalChecks: {},
        cancellationRequested: false,
        requestEventId: "request-event",
        eventId: "run-event",
      };
      const providerContext = agentProviderContext(
        {
          activeRuns: [boundedActiveRunProjection(run as any)],
          messages: [
            { role: "user", content: "Build and verify a five-step HTML page." },
          ],
        },
        run as any,
        step,
        [],
        modelDispatch,
        "system prompt",
      );
      const candidate = buildProviderInputCandidate({
        context: providerContext,
        modelDispatch,
        capacity,
      });
      oldBytes.push(canonicalJsonByteLength([
        ...conversation,
        { role: "user", content: `AGENCITY DURABLE RUN STEP\n${JSON.stringify(oldStep)}` },
      ]));
      newBytes.push(canonicalJsonByteLength(
        candidate.messages as unknown as JsonValue,
      ));
    }
    const baseline = oldBytes.reduce((sum, value) => sum + value, 0);
    const optimized = newBytes.reduce((sum, value) => sum + value, 0);
    expect(optimized).toBeLessThanOrEqual(Math.floor(baseline * 0.7));
  });
});

function reseal(candidate: Record<string, any>): void {
  const { digest: _digest, exactUtf8Bytes: _bytes, ...body } = candidate;
  candidate.digest = canonicalJsonDigest(body as JsonValue);
  candidate.exactUtf8Bytes = 0;
  for (;;) {
    const next = canonicalJsonByteLength(candidate as JsonValue);
    if (next === candidate.exactUtf8Bytes) return;
    candidate.exactUtf8Bytes = next;
  }
}

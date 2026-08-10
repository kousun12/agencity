import { describe, expect, test } from "bun:test";
import {
  AGENT_TOOL_CONTRACT_ID,
  ModelEffectAdmissionService,
  ModelExecutor,
  PROVIDER_INPUT_ESTIMATOR_ID,
  assertNoReservedPublicModelDispatchFields,
  buildProviderInputCandidate,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  createModelEffectOutputV2,
  type ModelDescriptor,
  type ModelDispatch,
  type ModelProvider,
  type ModelProviderRequiredToolSetCapabilities,
} from "../../src/index.ts";

describe("model effect response-contract admission", () => {
  test("keeps text explicit while rejecting structured work on text-only providers", () => {
    const executor = new ModelExecutor([textProvider("text-only")]);
    const admission = new ModelEffectAdmissionService(executor);
    const text = admission.requestText(configuration("text-only"));
    expect(text.modelDispatch).toMatchObject({
      dispatchVersion: "agencity.model-dispatch.v2",
      responseContract: { kind: "text", version: 1 },
      responseCapability: { kind: "text" },
      configuration: { provider: "text-only", model: "fixture/model" },
    });
    expect(text.execution.requiredAgentToolSet).toMatchObject({
      status: "unsupported",
      requiredChoice: "unsupported",
      parallelCalls: "unsupported",
      streaming: false,
    });
    expect(() =>
      admission.requestBuiltInStructured(
        AGENT_TOOL_CONTRACT_ID,
        configuration("text-only"),
      )
    ).toThrow(expect.objectContaining({
      code: "MODEL_RESPONSE_CONTRACT_UNAVAILABLE",
    }));
  });

  test("resolves strict custom-provider admission with reasoning and endpoint provenance", () => {
    const requiredToolSet = formalCapability("provider-strict");
    const provider = textProvider("strict-fixture", {
      requiredToolSet,
      executionEndpointId: "e".repeat(64),
    });
    const executor = new ModelExecutor([provider]);
    const admitted = new ModelEffectAdmissionService(executor)
      .requestBuiltInStructured(AGENT_TOOL_CONTRACT_ID, {
        ...configuration(provider.name),
        reasoningEffort: "provider-default",
      });
    expect(admitted.execution.requiredAgentToolSet).toMatchObject({
      status: "provider-strict",
      requiredChoice: "provider-enforced",
      parallelCalls: "provider-disabled",
      streaming: true,
    });
    expect(admitted.modelDispatch).toMatchObject({
      dispatchVersion: "agencity.model-dispatch.v2",
      executionEndpointId: "e".repeat(64),
      reasoning: {
        requestedEffort: "provider-default",
        mode: "omitted",
      },
      responseContract: {
        kind: "required-tool-set",
        contractId: AGENT_TOOL_CONTRACT_ID,
        schemaEnforcement: "provider-strict",
      },
      responseCapability: {
        kind: "required-tool-set",
        capability: { status: "provider-strict" },
      },
    });
  });

  test("retains unknown exact-model support when catalog evidence is absent", () => {
    const provider = textProvider("vercel", {
      productTransport: true,
      requiredToolSet: formalCapability("runtime-validated", {
        parallelCalls: "runtime-rejected",
      }),
      executionEndpointId: "c".repeat(64),
    });
    const descriptor = catalogDescriptor({
      requiredToolSet: {
        status: "unknown",
        strictSchema: "unknown",
        requiredChoice: "unknown",
      },
    });
    const executor = new ModelExecutor([provider], 1, {
      endpointId: descriptor.catalogEndpointId,
      descriptor: () => descriptor,
    });
    const admitted = new ModelEffectAdmissionService(executor)
      .requestBuiltInStructured(
        AGENT_TOOL_CONTRACT_ID,
        configuration("vercel"),
      );
    expect(admitted.execution.requiredAgentToolSet).toMatchObject({
      status: "unknown",
      requiredChoice: "provider-enforced",
      parallelCalls: "runtime-rejected",
      streaming: true,
      catalogDigest: descriptor.catalogDigest,
    });
    expect(admitted.modelDispatch.responseContract).toMatchObject({
      schemaEnforcement: "runtime-validated",
    });
    expect(admitted.modelDispatch.reasoning.capability.catalogDigest)
      .toBe(admitted.execution.catalog.catalogDigest);
    expect(admitted.modelDispatch.responseCapability).toMatchObject({
      capability: { catalogDigest: admitted.execution.catalog.catalogDigest },
    });
  });

  test("rejects authoritative unsupported catalog combinations before execution", () => {
    const provider = textProvider("vercel", {
      productTransport: true,
      requiredToolSet: formalCapability("runtime-validated"),
    });
    const descriptor = catalogDescriptor({
      requiredToolSet: {
        status: "unsupported",
        strictSchema: "unsupported",
        requiredChoice: "unsupported",
      },
    });
    const executor = new ModelExecutor([provider], 1, {
      endpointId: descriptor.catalogEndpointId,
      descriptor: () => descriptor,
    });
    expect(() =>
      new ModelEffectAdmissionService(executor).requestBuiltInStructured(
        AGENT_TOOL_CONTRACT_ID,
        configuration("vercel"),
      )
    ).toThrow(expect.objectContaining({
      code: "MODEL_RESPONSE_CONTRACT_UNAVAILABLE",
      details: expect.objectContaining({ status: "unsupported" }),
    }));
  });

  test("rejects unproven streaming and contradictory provider declarations", () => {
    const executor = new ModelExecutor([textProvider("unknown-stream", {
      requiredToolSet: formalCapability("unknown", { streaming: false }),
    })]);
    expect(() =>
      new ModelEffectAdmissionService(executor).requestBuiltInStructured(
        AGENT_TOOL_CONTRACT_ID,
        configuration("unknown-stream"),
      )
    ).toThrow(expect.objectContaining({
      code: "MODEL_RESPONSE_CONTRACT_UNAVAILABLE",
    }));

    expect(() =>
      new ModelExecutor([textProvider("contradictory", {
        requiredToolSet: {
          status: "unsupported",
          requiredChoice: "provider-enforced",
          parallelCalls: "provider-disabled",
          streaming: true,
          adapter: "bad",
        },
      })])
    ).toThrow("contradictory");

    expect(() =>
      new ModelExecutor([textProvider("unproven-primitives", {
        requiredToolSet: formalCapability("provider-strict", {
          requiredChoice: "unknown",
        }),
      })])
    ).toThrow("contradictory");
    expect(() =>
      new ModelExecutor([textProvider("unproven-stream", {
        requiredToolSet: formalCapability("runtime-validated", {
          streaming: false,
        }),
      })])
    ).toThrow("contradictory");
  });

  test("combines every reasoning level with structured admission without changing it", () => {
    const levels = [
      "provider-default",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ] as const;
    for (const transport of ["vercel", "openai", "anthropic"] as const) {
      const executor = new ModelExecutor([textProvider(transport, {
        productTransport: true,
        requiredToolSet: formalCapability("runtime-validated", {
          parallelCalls: transport === "vercel"
            ? "runtime-rejected"
            : "provider-disabled",
        }),
      })]);
      const service = new ModelEffectAdmissionService(executor);
      for (const reasoningEffort of levels) {
        const admitted = service.requestBuiltInStructured(
          AGENT_TOOL_CONTRACT_ID,
          {
            provider: transport,
            model: `${transport}/fixture`,
            reasoningEffort,
          },
        );
        expect(admitted.modelDispatch.reasoning.requestedEffort)
          .toBe(reasoningEffort);
        expect(admitted.modelDispatch.configuration.reasoningEffort)
          .toBe(reasoningEffort);
      }
    }
  });

  test("executes response-aware text through the compatible live provider primitive", async () => {
    const executor = new ModelExecutor([textProvider("fixture")]);
    const dispatch = new ModelEffectAdmissionService(executor)
      .requestText(configuration("fixture")).modelDispatch;
    const deltas: string[] = [];
    const output = await executor.executeResponseAware(
      { messages: [{ role: "user", content: "hello" }] },
      dispatch,
      new AbortController().signal,
      (delta) => {
        if (delta.kind === "text") deltas.push(delta.text);
      },
    );
    expect(deltas).toEqual([]);
    expect(output).toMatchObject({
      kind: "agencity.model-effect-output.v2",
      response: {
        kind: "complete",
        termination: { kind: "text-stop" },
        usage: { inputTokens: 2, outputTokens: 1, costUsd: 0 },
      },
      result: { kind: "text", text: "fixture response" },
    });
  });

  test("accepts a custom provider's normalized structured stream primitive", async () => {
    const requiredToolSet = formalCapability("runtime-validated");
    const provider: ModelProvider = {
      ...textProvider("formal-fixture", { requiredToolSet }),
      streamResponse: async (
        _context,
        dispatch,
        _signal,
        onDelta,
      ) => {
        const responseContract = dispatch.responseContract;
        if (responseContract.kind !== "required-tool-set") {
          throw new Error("expected required tools");
        }
        const input = { outcome: { message: "Done." } };
        const inputDigest = canonicalJsonDigest(input);
        const inputBytes = canonicalJsonByteLength(input);
        const termination = {
          kind: "tool-calls" as const,
          rawReason: "tool_calls",
        };
        onDelta({
          kind: "tool-call-start",
          callId: "call-finish",
          name: "finish",
        });
        onDelta({
          kind: "tool-input-delta",
          callId: "call-finish",
          bytes: inputBytes,
        });
        return createModelEffectOutputV2({
          response: {
            kind: "complete",
            blocks: [{
              type: "tool-call",
              callId: "call-finish",
              name: "finish",
              inputDigest,
              inputBytes,
            }],
            termination,
            usage: { inputTokens: 3, outputTokens: 2, costUsd: 0 },
            warnings: [],
            transport: {
              provider: dispatch.configuration.provider,
              adapter: requiredToolSet.adapter,
            },
          },
          result: {
            kind: "tool-submission",
            submission: {
              providerToolCallId: "call-finish",
              name: "finish",
              input,
              inputDigest,
              inputBytes,
              responseContract: {
                contractId: responseContract.contractId,
                version: responseContract.version,
                contractDigest: responseContract.contractDigest,
              },
              transport: {
                provider: dispatch.configuration.provider,
                adapter: requiredToolSet.adapter,
              },
              termination,
            },
          },
          responseContract,
          responseCapability: dispatch.responseCapability,
          configuredProvider: dispatch.configuration.provider,
        });
      },
    };
    const executor = new ModelExecutor([provider]);
    const dispatch = new ModelEffectAdmissionService(executor)
      .requestBuiltInStructured(
        AGENT_TOOL_CONTRACT_ID,
        configuration(provider.name),
      ).modelDispatch;
    const deltas: string[] = [];
    const output = await executor.executeResponseAware(
      {},
      dispatch,
      new AbortController().signal,
      (delta) => deltas.push(delta.kind),
    );
    expect(deltas).toEqual(["tool-call-start", "tool-input-delta"]);
    expect(output.result).toMatchObject({
      kind: "tool-submission",
      submission: { name: "finish", input: { outcome: { message: "Done." } } },
    });
    const resolvedCapacity = executor.contextCapacity(dispatch.configuration);
    const providerInput = buildProviderInputCandidate({
      context: {},
      modelDispatch: dispatch,
      capacity: {
        ...resolvedCapacity,
        outputReserveTokens: 0,
        estimatorId: PROVIDER_INPUT_ESTIMATOR_ID,
        triggerRatio: 0.8,
        targetRatio: 0.6,
      },
    });
    const progress: Array<{ kind: string; value: unknown }> = [];
    const executed = await executor.execute({
      effectId: "formal-progress",
      sessionId: "session",
      branchId: "branch",
      executor: "model",
      operation: "complete",
      input: { providerInput, modelDispatch: dispatch } as any,
      idempotencyKey: "formal-progress",
      idempotent: false,
      attempt: 1,
    }, {
      signal: new AbortController().signal,
      reportProgress: notification => progress.push(notification),
    });
    expect(executed.outcome).toBe("succeeded");
    expect(progress).toEqual([
      {
        kind: "model-tool-progress",
        value: {
          phase: "tool-call-start",
          name: "finish",
        },
      },
      {
        kind: "model-tool-progress",
        value: {
          phase: "tool-input-delta",
          bytes: canonicalJsonByteLength({ outcome: { message: "Done." } }),
        },
      },
    ]);
    expect(JSON.stringify(progress)).not.toContain("Done.");
    expect(JSON.stringify(progress)).not.toContain('"input":');
    expect(JSON.stringify(progress)).not.toContain('"arguments":');
  });

  test.each([
    "modelDispatch",
    "responseAdmission",
    "responseContract",
    "responseCapability",
    "tools",
    "toolSchemas",
    "toolChoice",
    "schemaEnforcement",
  ])("rejects public recursive input reserved field %s", (field) => {
    expect(() =>
      assertNoReservedPublicModelDispatchFields({
        prompt: "attempt",
        [field]: {},
      })
    ).toThrow(`reserved dispatch field ${field}`);
    expect(() =>
      assertNoReservedPublicModelDispatchFields({
        prompt: "attempt",
        model: {
          provider: "fixture",
          model: "fixture/model",
          [field]: {},
        },
      })
    ).toThrow(`reserved dispatch field ${field}`);
  });

  test("rejects reserved fields on every normalized public model configuration", () => {
    const executor = new ModelExecutor([textProvider("fixture")]);
    expect(() => executor.normalizeConfigurationIdentity({
      ...configuration("fixture"),
      responseContract: { kind: "text", version: 1 },
    } as any)).toThrow("Public model configuration cannot set reserved dispatch field responseContract");
  });
});

function configuration(provider: string) {
  return {
    provider,
    model: "fixture/model",
    reasoningEffort: "provider-default" as const,
  };
}

function formalCapability(
  status: ModelProviderRequiredToolSetCapabilities["status"],
  overrides: Partial<ModelProviderRequiredToolSetCapabilities> = {},
): ModelProviderRequiredToolSetCapabilities {
  return {
    status,
    requiredChoice: "provider-enforced",
    parallelCalls: "provider-disabled",
    streaming: true,
    adapter: "fixture.formal-provider.v1",
    ...overrides,
  };
}

function textProvider(
  name: string,
  options: {
    readonly requiredToolSet?: ModelProviderRequiredToolSetCapabilities;
    readonly productTransport?: boolean;
    readonly executionEndpointId?: string;
  } = {},
): ModelProvider {
  return {
    name,
    ...(options.productTransport === undefined
      ? {}
      : { productTransport: options.productTransport }),
    ...(options.executionEndpointId === undefined
      ? {}
      : { executionEndpointId: options.executionEndpointId }),
    capabilities: {
      streaming: false,
      reasoningControl: "normalized",
      ...(options.requiredToolSet === undefined
        ? {}
        : { requiredToolSet: options.requiredToolSet }),
    },
    complete: async () => ({
      text: "fixture response",
      finishReason: "stop",
      usage: { inputTokens: 2, outputTokens: 1, costUsd: 0 },
    }),
  };
}

function catalogDescriptor(
  overrides: Partial<ModelDescriptor> = {},
): ModelDescriptor {
  return {
    model: "fixture/model",
    displayName: "Fixture",
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_000,
    pricing: null,
    reasoning: {
      status: "unverified",
      levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
    },
    requiredToolSet: {
      status: "unknown",
      strictSchema: "unknown",
      requiredChoice: "unknown",
    },
    catalogDigest: "d".repeat(64),
    catalogEndpointId: "c".repeat(64),
    stale: false,
    ...overrides,
  };
}

import { describe, expect, test } from "bun:test";
import {
  AGENT_TOOL_CONTRACT_ID,
  REFINEMENT_REVIEW_CONTRACT_ID,
  REFINEMENT_REVIEW_TOOL_NAME,
  MAX_AGENT_TOOL_INPUT_BYTES,
  MAX_MODEL_FORMAL_RESPONSE_BYTES,
  MAX_MODEL_RESPONSE_BLOCKS,
  MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES,
  MAX_MODEL_TERMINATION_REASON_BYTES,
  MAX_MODEL_TOOL_CALL_ID_BYTES,
  MAX_MODEL_TOOL_NAME_BYTES,
  ModelEffectAdmissionService,
  ModelExecutor,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  createAnthropicModelProvider,
  createModelEffectOutputV2,
  createOpenAIModelProvider,
  createVercelModelProvider,
  encodeRefinementReviewTransportValue,
  registerBrokeredSecret,
  resolveBuiltInModelResponseContract,
  modelDispatchWithResponseAdmission,
  type JsonValue,
  type ModelDispatch,
  type ModelProvider,
} from "../../src/index.ts";
import {
  ModelResponseGuard,
  compileRequiredToolSet,
  consumeRequiredToolStream,
  requiredToolGenerationOptions,
  type RequiredToolStreamPart,
} from "../../src/executors/model-response.ts";

const efforts = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

describe("formal AI SDK model responses", () => {
  test("compiles retained schemas as validated declaration-only AI SDK tools", async () => {
    const contract = resolveBuiltInModelResponseContract(
      AGENT_TOOL_CONTRACT_ID,
      "provider-strict",
    );
    const tools = compileRequiredToolSet(contract);
    expect(Object.keys(tools)).toEqual(["bun_console", "finish"]);
    for (const name of Object.keys(tools)) {
      const declaration = tools[name] as any;
      expect(declaration.description).toBe(
        contract.tools.find((item) => item.name === name)!.description,
      );
      expect(declaration.strict).toBe(true);
      expect(Object.hasOwn(declaration, "execute")).toBe(false);
      expect(declaration.outputSchema).toBeDefined();
      expect(typeof declaration.inputSchema.validate).toBe("function");
      expect(await declaration.inputSchema.validate(
        name === "bun_console"
          ? { source: "return 1;" }
          : { outcome: { message: "Done." } },
      )).toMatchObject({ success: true });
    }
    const runtimeTools = compileRequiredToolSet(
      resolveBuiltInModelResponseContract(
        AGENT_TOOL_CONTRACT_ID,
        "runtime-validated",
      ),
    );
    expect(Object.values(runtimeTools).every(
      (item) => !Object.hasOwn(item as object, "strict"),
    )).toBe(true);
    // The pinned SDK already stops after one generation step; the plan
    // forbids stopWhen, loop, and continuation options on formal requests.
    expect(Object.keys(requiredToolGenerationOptions(contract)))
      .toEqual(["tools", "toolChoice"]);
  });

  test("compiles the sealed refinement schema in strict and runtime-validated modes", async () => {
    const decision = {
      protocol: "agencity.refinement-review",
      version: 1,
      reviewId: "refinement-review-fixture",
      status: "no_change",
      reason: "No attributable change is justified.",
      evidenceEventIds: [],
    } as const;
    const transportInput = encodeRefinementReviewTransportValue(decision);
    for (const mode of ["provider-strict", "runtime-validated"] as const) {
      const contract = resolveBuiltInModelResponseContract(
        REFINEMENT_REVIEW_CONTRACT_ID,
        mode,
      );
      const tools = compileRequiredToolSet(contract);
      expect(Object.keys(tools)).toEqual([REFINEMENT_REVIEW_TOOL_NAME]);
      const declaration = tools[REFINEMENT_REVIEW_TOOL_NAME] as any;
      expect(declaration.strict).toBe(
        mode === "provider-strict" ? true : undefined,
      );
      expect(await declaration.inputSchema.validate(transportInput))
        .toMatchObject({ success: true });
      expect(await declaration.inputSchema.validate({
        ...(transportInput as Record<string, JsonValue>),
        extra: true,
      })).toMatchObject({ success: false });
    }
  });

  test("sends exactly one refinement tool through every pinned transport without changing reasoning", async () => {
    for (const transport of ["vercel", "openai", "anthropic"] as const) {
      let body: Record<string, any> | undefined;
      const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        body = await request.json() as Record<string, any>;
        return Response.json(
          { error: { message: "fixture request rejected" } },
          { status: 500 },
        );
      }) as typeof globalThis.fetch;
      const provider = transport === "vercel"
        ? createVercelModelProvider({
            origin: "https://gateway.example.test",
            apiKey: () => "key-gateway",
            fetch,
          })
        : transport === "openai"
          ? createOpenAIModelProvider({
              origin: "https://openai.example.test",
              apiKey: () => "key-openai",
              fetch,
            })
          : createAnthropicModelProvider({
              origin: "https://anthropic.example.test",
              apiKey: () => "key-anthropic",
              fetch,
            });
      const executor = new ModelExecutor([provider]);
      const model = transport === "anthropic"
        ? "anthropic/claude-fable-5"
        : transport === "openai"
          ? "openai/gpt-5.4"
          : "openai/gpt-5.6-sol";
      const dispatch = new ModelEffectAdmissionService(executor)
        .requestBuiltInStructured(REFINEMENT_REVIEW_CONTRACT_ID, {
          provider: transport,
          model,
          reasoningEffort: "high",
        }).modelDispatch;
      await executor.executeResponseAware(
        { messages: [{ role: "user", content: "review" }] },
        dispatch,
        new AbortController().signal,
      ).catch(() => {});
      const tools = transport === "openai"
        ? body!.tools.map((item: any) => item.function)
        : body!.tools;
      expect(tools.map((item: any) => item.name)).toEqual([
        REFINEMENT_REVIEW_TOOL_NAME,
      ]);
      if (transport === "vercel") expect(body!.reasoning).toBe("high");
      else if (transport === "openai") {
        expect(body!.reasoning_effort).toBe("high");
        expect(body!.parallel_tool_calls).toBe(false);
      } else {
        expect(body!.thinking).toEqual({
          type: "adaptive",
          display: "summarized",
        });
        expect(body!.output_config?.effort).toBe("high");
        expect(body!.tool_choice).toEqual({
          type: "any",
          disable_parallel_tool_use: true,
        });
      }
    }
  });

  test("sends declaration-only required tools through direct OpenAI and accepts one completed call", async () => {
    let body: Record<string, any> | undefined;
    let requestCount = 0;
    const provider = createOpenAIModelProvider({
      origin: "https://openai.example.test",
      apiKey: () => "openai-test-key",
      fetch: (async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestCount++;
        body = await request.json() as Record<string, any>;
        return openAiToolStream([
          { arguments: '{"outcome":{"message":"Done.' },
          { arguments: '"}}' },
        ]);
      }) as typeof fetch,
    });
    const executor = new ModelExecutor([provider]);
    const dispatch = admittedDispatch(executor, "openai", "openai/gpt-5.4");
    const privateDeltas: string[] = [];
    const output = await executor.executeResponseAware(
      { messages: [{ role: "user", content: "finish" }] },
      dispatch,
      new AbortController().signal,
      (delta) => privateDeltas.push(delta.kind),
    );

    expect(output.result).toMatchObject({
      kind: "tool-submission",
      submission: {
        providerToolCallId: "call-finish",
        name: "finish",
        input: { outcome: { message: "Done." } },
        inputBytes: canonicalJsonByteLength({ outcome: { message: "Done." } }),
      },
    });
    expect(output.response.blocks).toEqual([
      expect.objectContaining({
        type: "tool-call",
        callId: "call-finish",
        name: "finish",
      }),
    ]);
    expect(JSON.stringify(output).match(/Done\./g)).toHaveLength(1);
    expect(privateDeltas).toContain("tool-call-start");
    expect(privateDeltas).toContain("tool-input-delta");
    expect(body).toMatchObject({
      model: "gpt-5.4",
      stream: true,
      tool_choice: "required",
      parallel_tool_calls: false,
      tools: [
        { type: "function", function: { name: "bun_console" } },
        { type: "function", function: { name: "finish" } },
      ],
    });
    expect(body!.tools.every((item: any) => item.function.strict === undefined))
      .toBe(true);
    expect(requestCount).toBe(1);
  });

  test("normalizes a Gateway formal stream with retained cost and canonical model identity", async () => {
    let modelHeader: string | null = null;
    const provider = createVercelModelProvider({
      origin: "https://gateway.example.test",
      apiKey: () => "gateway-test-key",
      fetch: (async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        modelHeader = request.headers.get("ai-language-model-id");
        return gatewayToolStream();
      }) as typeof fetch,
    });
    const executor = new ModelExecutor([provider]);
    const dispatch = admittedDispatch(
      executor,
      "vercel",
      "anthropic/claude-sonnet-5",
    );
    const output = await executor.executeResponseAware(
      { messages: [{ role: "user", content: "finish" }] },
      dispatch,
      new AbortController().signal,
    );
    expect(modelHeader as string | null).toBe("anthropic/claude-sonnet-5");
    expect(output).toMatchObject({
      response: {
        usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.0125 },
      },
      result: {
        kind: "tool-submission",
        submission: {
          name: "finish",
          termination: { kind: "tool-calls", rawReason: "tool_use" },
        },
      },
    });
  });

  test("normalizes a direct Anthropic formal stream with native identity and parallel suppression", async () => {
    let body: Record<string, any> | undefined;
    const provider = createAnthropicModelProvider({
      origin: "https://anthropic.example.test",
      apiKey: () => "anthropic-test-key",
      fetch: (async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        body = await request.json() as Record<string, any>;
        return anthropicToolStream();
      }) as typeof fetch,
    });
    const executor = new ModelExecutor([provider]);
    const dispatch = admittedDispatch(
      executor,
      "anthropic",
      "anthropic/claude-fable-5",
      "high",
    );
    const output = await executor.executeResponseAware(
      { messages: [{ role: "user", content: "finish" }] },
      dispatch,
      new AbortController().signal,
    );
    expect(body).toMatchObject({
      model: "claude-fable-5",
      tool_choice: {
        type: "any",
        disable_parallel_tool_use: true,
      },
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
    expect(output).toMatchObject({
      response: {
        termination: { kind: "tool-calls", rawReason: "tool_use" },
        usage: { inputTokens: 7, outputTokens: 3, costUsd: 0 },
      },
      result: {
        kind: "tool-submission",
        submission: {
          name: "finish",
          input: { outcome: { message: "Anthropic done." } },
        },
      },
    });
  });

  test("pins structured options, native IDs, reasoning, and parallel suppression on every transport, effort, and sealed contract", async () => {
    for (const transport of ["vercel", "openai", "anthropic"] as const) {
      for (const effort of efforts) {
      for (const contractId of [
        AGENT_TOOL_CONTRACT_ID,
        REFINEMENT_REVIEW_CONTRACT_ID,
      ] as const) {
        let body: Record<string, any> | undefined;
        let modelHeader: string | null = null;
        const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          body = await request.json() as Record<string, any>;
          modelHeader = request.headers.get("ai-language-model-id");
          return Response.json(
            { error: { message: "fixture request rejected" } },
            { status: 500 },
          );
        }) as typeof globalThis.fetch;
        const provider = transport === "vercel"
          ? createVercelModelProvider({
              origin: "https://gateway.example.test",
              apiKey: () => "gateway-test-key",
              fetch,
            })
          : transport === "openai"
            ? createOpenAIModelProvider({
                origin: "https://openai.example.test",
                apiKey: () => "openai-test-key",
                fetch,
              })
            : createAnthropicModelProvider({
                origin: "https://anthropic.example.test",
                apiKey: () => "anthropic-test-key",
                fetch,
              });
        const executor = new ModelExecutor([provider]);
        const model = transport === "anthropic"
          ? "anthropic/claude-fable-5"
          : transport === "openai"
            ? "openai/gpt-5.4"
            : "openai/gpt-5.6-sol";
        const dispatch = admittedDispatch(executor, transport, model, effort, contractId);
        await executor.executeResponseAware(
          { messages: [{ role: "user", content: "test options" }] },
          dispatch,
          new AbortController().signal,
        ).catch(() => {});

        expect(body).toBeDefined();
        const expectedToolNames = contractId === AGENT_TOOL_CONTRACT_ID
          ? ["bun_console", "finish"]
          : [REFINEMENT_REVIEW_TOOL_NAME];
        const sentTools = transport === "openai"
          ? body!.tools.map((item: any) => item.function)
          : body!.tools;
        expect(sentTools.map((item: any) => item.name)).toEqual(expectedToolNames);
        if (transport === "vercel") {
          expect(modelHeader as string | null).toBe(model);
          expect(body).toMatchObject({
            toolChoice: { type: "required" },
            tools: expectedToolNames.map((name) => ({ type: "function", name })),
          });
          expect(body!.providerOptions).toBeUndefined();
          expect(body!.reasoning).toBe(
            effort === "provider-default" ? undefined : effort,
          );
        } else if (transport === "openai") {
          expect(body).toMatchObject({
            model: "gpt-5.4",
            tool_choice: "required",
            parallel_tool_calls: false,
          });
          expect(body!.reasoning_effort).toBe(
            effort === "provider-default" ? undefined : effort,
          );
        } else {
          expect(body).toMatchObject({
            model: "claude-fable-5",
            tool_choice: {
              type: "any",
              disable_parallel_tool_use: true,
            },
          });
          expect(body!.thinking).toEqual(
            effort === "provider-default"
              ? undefined
              : effort === "none"
                ? { type: "disabled" }
                : { type: "adaptive", display: "summarized" },
          );
          expect(body!.output_config?.effort).toBe(
            effort === "provider-default" || effort === "none"
              ? undefined
              : effort === "minimal"
                ? "low"
                : effort,
          );
        }
        expect(JSON.stringify(body)).not.toContain('"execute"');
        expect(JSON.stringify(body)).not.toContain("tool-result");
      }
      }
    }
  });

  test("emits strict only for retained provider-strict contracts", async () => {
    for (const transport of ["vercel", "openai", "anthropic"] as const) {
      let body: Record<string, any> | undefined;
      const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        body = await request.json() as Record<string, any>;
        return Response.json({ error: { message: "fixture" } }, { status: 500 });
      }) as typeof globalThis.fetch;
      const provider = transport === "vercel"
        ? createVercelModelProvider({
            origin: "https://gateway.example.test",
            apiKey: () => "key-gateway",
            fetch,
          })
        : transport === "openai"
          ? createOpenAIModelProvider({
              origin: "https://openai.example.test",
              apiKey: () => "key-openai",
              fetch,
            })
          : createAnthropicModelProvider({
              origin: "https://anthropic.example.test",
              apiKey: () => "key-anthropic",
              fetch,
            });
      const executor = new ModelExecutor([provider]);
      const model = transport === "anthropic"
        ? "anthropic/claude-fable-5"
        : transport === "openai"
          ? "openai/gpt-5.4"
          : "openai/gpt-5.6-sol";
      const dispatch = strictDispatch(executor, transport, model);
      await executor.executeResponseAware(
        { messages: [{ role: "user", content: "strict" }] },
        dispatch,
        new AbortController().signal,
      ).catch(() => {});
      const tools = transport === "openai"
        ? body!.tools.map((item: any) => item.function)
        : body!.tools;
      expect(tools.map((item: any) => item.strict)).toEqual([true, true]);
    }
  });

  test.each([
    ["a registered secret in the submitted tool input", true, "input"],
    ["an unregistered credential in termination.rawReason", false, "raw-reason"],
    ["an unregistered credential in a provider warning", false, "warning"],
    ["an unregistered credential in supplemental text", false, "supplemental"],
  ] as const)(
    "a custom provider cannot hand structured output with %s to executor callers",
    async (_label, registered, placement) => {
    const secret = "sk-live-Section31DeepCover0042";
    const release = registered ? registerBrokeredSecret(secret) : undefined;
    try {
      const provider: ModelProvider = {
        name: "secret-fixture",
        capabilities: {
          streaming: false,
          requiredToolSet: {
            status: "provider-strict",
            requiredChoice: "provider-enforced",
            parallelCalls: "provider-disabled",
            streaming: true,
            adapter: "fixture.ai-sdk.v7",
          },
        },
        complete: async () => ({
          text: "",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        }),
        streamResponse: async (_context, dispatch) =>
          secretPlacementOutput(dispatch, secret, placement),
      };
      const executor = new ModelExecutor([provider]);
      const dispatch = new ModelEffectAdmissionService(executor)
        .requestBuiltInStructured(REFINEMENT_REVIEW_CONTRACT_ID, {
          provider: "secret-fixture",
          model: "fixture/model",
        }).modelDispatch;
      const rejection = await executor.executeResponseAware(
        { messages: [{ role: "user", content: "review" }] },
        dispatch,
        new AbortController().signal,
      ).then(
        () => { throw new Error("secret-bearing structured output must not be returned"); },
        (error: unknown) => error as { code?: string; message?: string },
      );
      expect(rejection.code).toBe("stream-failed");
      expect(rejection.message ?? "").not.toContain(secret);
    } finally {
      release?.();
    }
  });

  test("a retained structured dispatch fails visibly when the configured transport endpoint changed", async () => {
    const calls = { count: 0 };
    const makeProvider = (endpoint: string): ModelProvider => ({
      name: "endpoint-fixture",
      executionEndpointId: endpoint,
      capabilities: {
        streaming: false,
        requiredToolSet: {
          status: "provider-strict",
          requiredChoice: "provider-enforced",
          parallelCalls: "provider-disabled",
          streaming: true,
          adapter: "fixture.ai-sdk.v7",
        },
      },
      complete: async () => ({
        text: "",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      }),
      streamResponse: async () => {
        calls.count++;
        throw new Error("a drifted endpoint must never execute");
      },
    });
    const admitted = new ModelEffectAdmissionService(
      new ModelExecutor([makeProvider("endpoint-original")]),
    ).requestBuiltInStructured(REFINEMENT_REVIEW_CONTRACT_ID, {
      provider: "endpoint-fixture",
      model: "fixture/model",
    }).modelDispatch;
    const drifted = new ModelExecutor([makeProvider("endpoint-drifted")]);
    await expect(drifted.executeResponseAware(
      { messages: [{ role: "user", content: "endpoint" }] },
      admitted,
      new AbortController().signal,
    )).rejects.toThrow(/Retained model dispatch endpoint differs/);
    expect(calls.count).toBe(0);
  });

  test("classifies a provider rejection of strict tools without a text downgrade", async () => {
    const provider = createOpenAIModelProvider({
      origin: "https://openai.example.test",
      apiKey: () => "openai-test-key",
      fetch: (async () => Response.json({
        error: {
          message: "Strict tool schemas are not supported for this model",
        },
      }, { status: 400 })) as unknown as typeof fetch,
    });
    const executor = new ModelExecutor([provider]);
    const dispatch = strictDispatch(executor, "openai", "openai/gpt-5.4");
    await expect(executor.executeResponseAware(
      { messages: [{ role: "user", content: "strict" }] },
      dispatch,
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({
      code: "unsupported-response-contract",
      provider: "openai",
      model: "openai/gpt-5.4",
    }));
  });

  test("preserves provider-request, transport, and context-overflow failure classes", async () => {
    const cases = [
      {
        name: "provider request",
        fetch: (async () =>
          Response.json(
            { error: { message: "ordinary rejection" } },
            { status: 400 },
          )) as unknown as typeof fetch,
        code: "provider-request-failed",
      },
      {
        name: "transport",
        fetch: (async () => {
          throw new TypeError("network unavailable");
        }) as unknown as typeof fetch,
        code: "transport-failed",
      },
    ] as const;
    for (const item of cases) {
      const provider = createOpenAIModelProvider({
        origin: "https://openai.example.test",
        apiKey: () => "openai-test-key",
        fetch: item.fetch,
      });
      const executor = new ModelExecutor([provider]);
      const dispatch = admittedDispatch(
        executor,
        "openai",
        "openai/gpt-5.4",
      );
      await expect(executor.executeResponseAware(
        { messages: [{ role: "user", content: item.name }] },
        dispatch,
        new AbortController().signal,
      )).rejects.toEqual(expect.objectContaining({ code: item.code }));
    }

    const overflowProvider = createOpenAIModelProvider({
      origin: "https://openai.example.test",
      apiKey: () => "openai-test-key",
      fetch: (async () =>
        Response.json(
          { error: { message: "maximum context window exceeded" } },
          { status: 400 },
        )) as unknown as typeof fetch,
    });
    const overflowExecutor = new ModelExecutor([overflowProvider]);
    const overflowDispatch = admittedDispatch(
      overflowExecutor,
      "openai",
      "openai/gpt-5.4",
    );
    await expect(overflowExecutor.executeResponseAware(
      { messages: [{ role: "user", content: "overflow" }] },
      overflowDispatch,
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({
      code: "provider-confirmed-context-window-overflow",
      provider: "openai",
      model: "openai/gpt-5.4",
    }));
  });

  test.each([
    ["narration plus call", [
      part("text-start", { id: "text-1" }),
      part("text-delta", { id: "text-1", text: "Working. " }),
      ...formalCall("call-1", "finish", '{"outcome":{"message":"Done."}}'),
      ...finishParts("tool-calls", "tool_calls"),
    ], "tool-submission"],
    ["JSON-looking narration without call", [
      part("text-start", { id: "text-1" }),
      part("text-delta", {
        id: "text-1",
        text: '{"name":"finish","input":{"outcome":{"message":"fake"}}}',
      }),
      ...finishParts("stop", "stop"),
    ], "contract-violation"],
    ["zero calls with tool termination", [
      ...finishParts("tool-calls", "tool_calls"),
    ], "contract-violation"],
    ["output-limited complete call", [
      ...formalCall("call-1", "finish", '{"outcome":{"message":"Done."}}'),
      ...finishParts("length", "length"),
    ], "contract-violation"],
    ["provider refusal", [
      ...finishParts("content-filter", "refusal"),
    ], "contract-violation"],
  ] as const)("%s normalizes without parsing text", async (
    _name,
    parts,
    resultKind,
  ) => {
    const output = await consume(parts);
    expect(output.result.kind).toBe(resultKind);
  });

  test("accepts one refinement submission and rejects text, wrong, multiple, and malformed calls without fallback", async () => {
    const transportInput = encodeRefinementReviewTransportValue({
      protocol: "agencity.refinement-review",
      version: 1,
      reviewId: "refinement-review-fixture",
      status: "no_change",
      reason: "No attributable change is justified.",
      evidenceEventIds: [],
    });
    const dispatch = refinementFixtureDispatch();
    const valid = await consumeWithDispatch([
      ...formalCall(
        "review-call",
        REFINEMENT_REVIEW_TOOL_NAME,
        JSON.stringify(transportInput),
      ),
      ...finishParts("tool-calls", "tool_calls"),
    ], dispatch);
    expect(valid.result).toMatchObject({
      kind: "tool-submission",
      submission: {
        name: REFINEMENT_REVIEW_TOOL_NAME,
        input: transportInput,
      },
    });

    const textOnly = await consumeWithDispatch([
      part("text-start", { id: "text" }),
      part("text-delta", {
        id: "text",
        text: JSON.stringify(transportInput),
      }),
      ...finishParts("stop", "stop"),
    ], dispatch);
    expect(textOnly.result).toMatchObject({
      kind: "contract-violation",
      violation: { code: "required-tool-missing" },
    });

    const wrong = await consumeWithDispatch([
      part("tool-input-start", { id: "wrong", toolName: "finish" }),
    ], dispatch);
    expect(wrong.result).toMatchObject({
      violation: { code: "unexpected-tool" },
    });

    const multiple = await consumeWithDispatch([
      part("tool-input-start", {
        id: "one",
        toolName: REFINEMENT_REVIEW_TOOL_NAME,
      }),
      part("tool-input-start", {
        id: "two",
        toolName: REFINEMENT_REVIEW_TOOL_NAME,
      }),
    ], dispatch);
    expect(multiple.result).toMatchObject({
      violation: { code: "multiple-tool-calls" },
    });

    const malformed = await consumeWithDispatch([
      ...formalCall(
        "malformed",
        REFINEMENT_REVIEW_TOOL_NAME,
        JSON.stringify({
          ...(transportInput as Record<string, JsonValue>),
          extra: true,
        }),
      ),
      ...finishParts("tool-calls", "tool_calls"),
    ], dispatch);
    expect(malformed.result).toMatchObject({
      violation: { code: "invalid-tool-input" },
    });
  });

  test("rejects wrong, multiple, malformed, truncated, and oversized calls without retaining arguments", async () => {
    const wrong = await consume([
      part("tool-input-start", { id: "wrong-id", toolName: "shell" }),
    ]);
    expect(wrong).toMatchObject({
      response: {
        kind: "guard-aborted",
        termination: { code: "unexpected-tool" },
      },
      result: {
        violation: { code: "unexpected-tool" },
      },
    });

    const multiple = await consume([
      part("tool-input-start", { id: "one", toolName: "finish" }),
      part("tool-input-start", { id: "two", toolName: "bun_console" }),
    ]);
    expect(multiple).toMatchObject({
      response: {
        kind: "guard-aborted",
        termination: { code: "multiple-tool-calls" },
      },
    });

    const malformedSecret = "malformed-private-secret-value";
    const release = registerBrokeredSecret(malformedSecret);
    try {
      const malformed = await consume([
        part("tool-input-start", { id: "bad", toolName: "finish" }),
        part("tool-input-delta", {
          id: "bad",
          delta: `{"outcome":{"message":"${malformedSecret}"`,
        }),
        part("tool-call", {
          toolCallId: "bad",
          toolName: "finish",
          input: undefined,
          dynamic: true,
          invalid: true,
        }),
        ...finishParts("tool-calls", "tool_calls"),
      ]);
      expect(malformed).toMatchObject({
        result: {
          violation: {
            code: "invalid-tool-input",
            evidence: {
              toolCalls: [{ invalidCode: "malformed-arguments" }],
            },
          },
        },
      });
      expect(JSON.stringify(malformed)).not.toContain(malformedSecret);

      const rejectedSecretInput = await consume([
        ...formalCall(
          "secret-input",
          "finish",
          JSON.stringify({ outcome: { message: malformedSecret } }),
        ),
        ...finishParts("tool-calls", "tool_calls"),
      ]);
      expect(rejectedSecretInput).toMatchObject({
        result: { violation: { code: "invalid-tool-input" } },
      });
      expect(JSON.stringify(rejectedSecretInput)).not.toContain(malformedSecret);

      const scrubbedSupplemental = await consume([
        part("text-start", { id: "secret-text" }),
        part("text-delta", {
          id: "secret-text",
          text: `diagnostic ${malformedSecret}`,
        }),
        ...formalCall(
          "safe-call",
          "finish",
          '{"outcome":{"message":"Done."}}',
        ),
        ...finishParts("tool-calls", "tool_calls"),
      ]);
      expect(scrubbedSupplemental.result.kind).toBe("tool-submission");
      expect(JSON.stringify(scrubbedSupplemental)).toContain("[REDACTED]");
      expect(JSON.stringify(scrubbedSupplemental)).not.toContain(
        malformedSecret,
      );
    } finally {
      release();
    }

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicInput = await consume([
      part("tool-input-start", { id: "cyclic", toolName: "finish" }),
      part("tool-call", { toolCallId: "cyclic", toolName: "finish", input: cyclic }),
      ...finishParts("tool-calls", "tool_calls"),
    ]);
    expect(cyclicInput).toMatchObject({
      result: {
        violation: {
          code: "invalid-tool-input",
          evidence: { toolCalls: [{ invalidCode: "malformed-arguments" }] },
        },
      },
    });

    const nonPlainInput = await consume([
      part("tool-input-start", { id: "date", toolName: "finish" }),
      part("tool-call", {
        toolCallId: "date",
        toolName: "finish",
        input: { outcome: { message: new Date() } },
      }),
      ...finishParts("tool-calls", "tool_calls"),
    ]);
    expect(nonPlainInput).toMatchObject({
      result: {
        violation: {
          code: "invalid-tool-input",
          evidence: { toolCalls: [{ invalidCode: "malformed-arguments" }] },
        },
      },
    });

    const truncated = await consume([
      part("tool-input-start", { id: "cut", toolName: "finish" }),
      part("tool-input-delta", { id: "cut", delta: '{"outcome":' }),
      ...finishParts("length", "length"),
    ]);
    expect(truncated).toMatchObject({
      result: { violation: { code: "truncated-tool-input" } },
    });

    const oversized = await consume([
      part("tool-input-start", { id: "large", toolName: "bun_console" }),
      part("tool-input-delta", {
        id: "large",
        delta: "x".repeat(MAX_AGENT_TOOL_INPUT_BYTES + 1),
      }),
    ]);
    expect(oversized).toMatchObject({
      response: {
        kind: "guard-aborted",
        usage: null,
        termination: { code: "oversized-tool-input" },
      },
      result: { violation: { code: "oversized-tool-input" } },
    });
  });

  test("enforces exact supplemental limit and keeps structured text private", async () => {
    const deltas: string[] = [];
    const accepted = await consume([
      part("text-start", { id: "text" }),
      part("text-delta", {
        id: "text",
        text: "x".repeat(MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES),
      }),
      ...formalCall("call", "finish", '{"outcome":{"message":"Done."}}'),
      ...finishParts("tool-calls", "tool_calls"),
    ], deltas);
    expect(accepted.result.kind).toBe("tool-submission");
    expect(deltas).not.toContain("text");
    const rejected = await consume([
      part("text-start", { id: "text" }),
      part("text-delta", {
        id: "text",
        text: "x".repeat(MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES + 1),
      }),
    ]);
    expect(rejected).toMatchObject({
      response: {
        kind: "guard-aborted",
        termination: { code: "oversized-provider-response" },
      },
    });
  });

  test("enforces exact tool-input, call-ID, name, block, and termination boundaries", async () => {
    const sourceOverhead = canonicalJsonByteLength({ source: "" });
    const exactInput = { source: "x".repeat(MAX_AGENT_TOOL_INPUT_BYTES - sourceOverhead) };
    const exactInputJson = JSON.stringify(exactInput);
    expect(new TextEncoder().encode(exactInputJson)).toHaveLength(
      MAX_AGENT_TOOL_INPUT_BYTES,
    );
    expect((await consume([
      ...formalCall("input-exact", "bun_console", exactInputJson),
      ...finishParts("tool-calls", "tool_calls"),
    ])).result.kind).toBe("tool-submission");
    expect(await consume([
      part("tool-input-start", { id: "input-over", toolName: "bun_console" }),
      part("tool-input-delta", { id: "input-over", delta: `${exactInputJson} ` }),
    ])).toMatchObject({
      response: { termination: { code: "oversized-tool-input" } },
    });

    const exactId = "i".repeat(MAX_MODEL_TOOL_CALL_ID_BYTES);
    expect((await consume([
      ...formalCall(exactId, "finish", '{"outcome":{"message":"Done."}}'),
      ...finishParts("tool-calls", "tool_calls"),
    ])).result.kind).toBe("tool-submission");
    expect(await consume([
      part("tool-input-start", {
        id: `${exactId}i`,
        toolName: "finish",
      }),
    ])).toMatchObject({
      response: { termination: { code: "oversized-provider-response" } },
    });

    expect(await consume([
      part("tool-input-start", {
        id: "name-exact",
        toolName: "x".repeat(MAX_MODEL_TOOL_NAME_BYTES),
      }),
    ])).toMatchObject({
      response: { termination: { code: "unexpected-tool" } },
    });
    expect(await consume([
      part("tool-input-start", {
        id: "name-over",
        toolName: "x".repeat(MAX_MODEL_TOOL_NAME_BYTES + 1),
      }),
    ])).toMatchObject({
      response: { termination: { code: "oversized-provider-response" } },
    });

    const exactBlocks = Array.from(
      { length: MAX_MODEL_RESPONSE_BLOCKS - 1 },
      (_, index) => part("text-start", { id: `text-${index}` }),
    );
    expect((await consume([
      ...exactBlocks,
      ...formalCall("block-exact", "finish", '{"outcome":{"message":"Done."}}'),
      ...finishParts("tool-calls", "tool_calls"),
    ])).result.kind).toBe("tool-submission");
    expect(await consume([
      ...exactBlocks,
      part("text-start", { id: "text-last" }),
      part("tool-input-start", { id: "block-over", toolName: "finish" }),
    ])).toMatchObject({
      response: { termination: { code: "oversized-provider-response" } },
    });

    const exactReason = "r".repeat(MAX_MODEL_TERMINATION_REASON_BYTES);
    expect((await consume([
      ...formalCall("reason-exact", "finish", '{"outcome":{"message":"Done."}}'),
      ...finishParts("tool-calls", exactReason),
    ])).result.kind).toBe("tool-submission");
    expect(await consume([
      ...formalCall("reason-over", "finish", '{"outcome":{"message":"Done."}}'),
      ...finishParts("tool-calls", `${exactReason}r`),
    ])).toMatchObject({
      response: { termination: { code: "oversized-provider-response" } },
    });
  });

  test("distinguishes guard abort, external cancellation, incomplete terminal state, stream failure, and unsupported contracts", async () => {
    const external = new AbortController();
    external.abort();
    await expect(consume([], [], external.signal)).rejects.toThrow("Aborted");

    await expect(consume([
      ...finishParts("other"),
    ])).rejects.toEqual(expect.objectContaining({
      code: "incomplete-provider-response",
    }));
    await expect(consume([
      part("error", { error: new Error("stream exploded") }),
    ])).rejects.toEqual(expect.objectContaining({
      code: "stream-failed",
    }));
    await expect(consume([
      part("start-step", {
        warnings: [{
          type: "unsupported",
          feature: "strict tools",
          details: "strict tool enforcement is ignored",
        }],
      }),
    ])).rejects.toEqual(expect.objectContaining({
      code: "unsupported-response-contract",
    }));
    await expect(consume([
      part("finish-step", {
        finishReason: "tool-calls",
        rawFinishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ])).rejects.toEqual(expect.objectContaining({
      code: "incomplete-provider-response",
    }));
  });

  test("preserves the first abort source when guard and external cancellation race", async () => {
    const dispatch = fixtureDispatch();
    const externalAfter = new AbortController();
    const guardFirst = new ModelResponseGuard(externalAfter.signal);
    guardFirst.guard("oversized-provider-response");
    externalAfter.abort();
    const guarded = await consumeRequiredToolStream({
      stream: { fullStream: (async function* () {})() },
      dispatch,
      guard: guardFirst,
      onDelta: () => {},
      gatewayCost: () => 0,
    });
    expect(guarded).toMatchObject({
      response: {
        kind: "guard-aborted",
        termination: { code: "oversized-provider-response" },
      },
    });

    const externalFirst = new AbortController();
    const cancelled = new ModelResponseGuard(externalFirst.signal);
    externalFirst.abort();
    cancelled.guard("oversized-provider-response");
    await expect(consumeRequiredToolStream({
      stream: { fullStream: (async function* () {})() },
      dispatch,
      guard: cancelled,
      onDelta: () => {},
      gatewayCost: () => 0,
    })).rejects.toThrow("Aborted");
  });

  test("retains bounded ordinary warnings and normalized usage while ignoring reasoning parts", async () => {
    const output = await consume([
      part("start-step", {
        warnings: Array.from({ length: 9 }, (_, index) => ({
          type: "compatibility",
          feature: `feature-${index}`,
          details: "adjusted",
        })),
      }),
      part("reasoning-start", { id: "reasoning" }),
      part("reasoning-delta", { id: "reasoning", text: "private reasoning" }),
      ...formalCall("warnings", "finish", '{"outcome":{"message":"Done."}}'),
      ...finishParts("tool-calls", "tool_calls"),
    ]);
    expect(output.response).toMatchObject({
      usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.0125 },
      warnings: [
        { kind: "coerced" },
        { kind: "coerced" },
        { kind: "coerced" },
        { kind: "coerced" },
        { kind: "coerced" },
        { kind: "coerced" },
        { kind: "coerced" },
        { kind: "truncated" },
      ],
    });
    expect(JSON.stringify(output)).not.toContain("private reasoning");

    const oversizedReasoning = await consume([
      part("reasoning-start", { id: "reasoning" }),
      part("reasoning-delta", {
        id: "reasoning",
        text: "r".repeat(MAX_MODEL_FORMAL_RESPONSE_BYTES + 1),
      }),
    ]);
    expect(oversizedReasoning).toMatchObject({
      response: {
        kind: "guard-aborted",
        termination: { code: "oversized-provider-response" },
      },
    });
    expect(JSON.stringify(oversizedReasoning)).not.toContain("rrrrrrrr");
  });

  test("Echo and scripted fixtures produce formal submissions without textual action JSON", async () => {
    const action = {
      protocol: "agencity.agent-action",
      version: 1,
      type: "typescript",
      code: "return 1;",
    } as const;
    const { EchoModelProvider, ScriptedAgentActionProvider } =
      await import("../../src/index.ts");
    for (const provider of [
      new EchoModelProvider(),
      new ScriptedAgentActionProvider([action]),
    ] satisfies ModelProvider[]) {
      const executor = new ModelExecutor([provider]);
      const dispatch = new ModelEffectAdmissionService(executor)
        .requestBuiltInStructured(AGENT_TOOL_CONTRACT_ID, {
          provider: provider.name,
          model: "fixture/model",
        }).modelDispatch;
      const output = await executor.executeResponseAware(
        { run: { stepOrdinal: 1, task: "fixture" } },
        dispatch,
        new AbortController().signal,
      );
      expect(output.result.kind).toBe("tool-submission");
      const text = (await provider.complete(
        { run: { stepOrdinal: 1, task: "fixture" } },
        { provider: provider.name, model: "fixture/model", reasoningEffort: "provider-default" },
        new AbortController().signal,
      )).text;
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("agencity.agent-action");
    }
  });
});

function admittedDispatch(
  executor: ModelExecutor,
  provider: string,
  model: string,
  reasoningEffort: typeof efforts[number] = "provider-default",
  contractId:
    | typeof AGENT_TOOL_CONTRACT_ID
    | typeof REFINEMENT_REVIEW_CONTRACT_ID = AGENT_TOOL_CONTRACT_ID,
): ModelDispatch {
  return new ModelEffectAdmissionService(executor)
    .requestBuiltInStructured(contractId, {
      provider,
      model,
      reasoningEffort,
    }).modelDispatch;
}

function strictDispatch(
  executor: ModelExecutor,
  provider: string,
  model: string,
): ModelDispatch {
  const base = executor.resolveDispatch({
    provider,
    model,
    reasoningEffort: "high",
  });
  const contract = resolveBuiltInModelResponseContract(
    AGENT_TOOL_CONTRACT_ID,
    "provider-strict",
  );
  return modelDispatchWithResponseAdmission(base, {
    responseContract: contract,
    responseCapability: {
      kind: "required-tool-set",
      capability: {
        status: "provider-strict",
        requiredChoice: "provider-enforced",
        parallelCalls: provider === "vercel"
          ? "runtime-rejected"
          : "provider-disabled",
        streaming: true,
        catalogDigest: base.reasoning.capability.catalogDigest,
        adapter: "agencity.vercel-ai-sdk.v7",
      },
    },
  });
}

async function consume(
  parts: readonly RequiredToolStreamPart[],
  deltas: string[] = [],
  signal = new AbortController().signal,
) {
  const dispatch = fixtureDispatch();
  const guard = new ModelResponseGuard(signal);
  return consumeRequiredToolStream({
    stream: {
      fullStream: (async function* () {
        for (const item of parts) {
          if (guard.signal.aborted) throw new DOMException("Aborted", "AbortError");
          yield item;
        }
      })(),
    },
    dispatch,
    guard,
    onDelta: (delta) => deltas.push(delta.kind),
    gatewayCost: () => 0.0125,
  });
}

async function consumeWithDispatch(
  parts: readonly RequiredToolStreamPart[],
  dispatch: ModelDispatch,
) {
  const guard = new ModelResponseGuard(new AbortController().signal);
  return consumeRequiredToolStream({
    stream: {
      fullStream: (async function* () {
        for (const item of parts) {
          if (guard.signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          yield item;
        }
      })(),
    },
    dispatch,
    guard,
    onDelta: () => {},
    gatewayCost: () => 0,
  });
}

/** Structurally valid refinement output carrying a credential in one retained field. */
function secretPlacementOutput(
  dispatch: ModelDispatch,
  secret: string,
  placement: "input" | "raw-reason" | "warning" | "supplemental",
) {
  const contract = dispatch.responseContract;
  if (contract.kind !== "required-tool-set") throw new Error("unexpected contract");
  const input = encodeRefinementReviewTransportValue({
    protocol: "agencity.refinement-review",
    version: 1,
    reviewId: "refinement-review-secret",
    status: "no_change",
    reason: placement === "input"
      ? `Continue with credential ${secret} attached.`
      : "No attributable change is justified.",
    evidenceEventIds: [],
  });
  const inputDigest = canonicalJsonDigest(input);
  const inputBytes = canonicalJsonByteLength(input);
  const termination = {
    kind: "tool-calls" as const,
    rawReason: placement === "raw-reason" ? `stop:${secret}` : "tool_calls",
  };
  const transport = { provider: "secret-fixture", adapter: "fixture.ai-sdk.v7" };
  const text = placement === "supplemental"
    ? `Applying ${secret} for the caller.`
    : "";
  return createModelEffectOutputV2({
    response: {
      kind: "complete",
      blocks: [
        ...(text ? [{ type: "text" as const, text }] : []),
        {
          type: "tool-call",
          callId: "secret-call-1",
          name: REFINEMENT_REVIEW_TOOL_NAME,
          inputDigest,
          inputBytes,
        },
      ],
      termination,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      warnings: placement === "warning"
        ? [{ kind: "provider", message: `provider notice ${secret}` }]
        : [],
      transport,
    },
    result: {
      kind: "tool-submission",
      submission: {
        providerToolCallId: "secret-call-1",
        name: REFINEMENT_REVIEW_TOOL_NAME,
        input,
        inputDigest,
        inputBytes,
        responseContract: {
          contractId: contract.contractId,
          version: contract.version,
          contractDigest: contract.contractDigest,
        },
        transport,
        termination,
        ...(text
          ? {
              supplementalText: {
                kind: "content" as const,
                text,
                textDigest: canonicalJsonDigest(text),
                textBytes: new TextEncoder().encode(text).byteLength,
              },
            }
          : {}),
      },
    },
    responseContract: contract,
    responseCapability: dispatch.responseCapability,
    configuredProvider: "secret-fixture",
  });
}

function fixtureDispatch(): ModelDispatch {
  const provider: ModelProvider = {
    name: "fixture",
    executionEndpointId: "endpoint",
    capabilities: {
      streaming: false,
      requiredToolSet: {
        status: "provider-strict",
        requiredChoice: "provider-enforced",
        parallelCalls: "provider-disabled",
        streaming: true,
        adapter: "fixture.ai-sdk.v7",
      },
    },
    complete: async () => ({
      text: "",
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    }),
  };
  const executor = new ModelExecutor([provider]);
  return new ModelEffectAdmissionService(executor)
    .requestBuiltInStructured(AGENT_TOOL_CONTRACT_ID, {
      provider: "fixture",
      model: "fixture/model",
    }).modelDispatch;
}

function refinementFixtureDispatch(): ModelDispatch {
  const provider: ModelProvider = {
    name: "refinement-fixture",
    executionEndpointId: "endpoint",
    capabilities: {
      streaming: false,
      requiredToolSet: {
        status: "provider-strict",
        requiredChoice: "provider-enforced",
        parallelCalls: "provider-disabled",
        streaming: true,
        adapter: "fixture.ai-sdk.v7",
      },
    },
    complete: async () => ({
      text: "",
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    }),
  };
  const executor = new ModelExecutor([provider]);
  return new ModelEffectAdmissionService(executor)
    .requestBuiltInStructured(REFINEMENT_REVIEW_CONTRACT_ID, {
      provider: provider.name,
      model: "fixture/model",
    }).modelDispatch;
}

function part(
  type: string,
  value: Record<string, unknown> = {},
): RequiredToolStreamPart {
  return { type, ...value };
}

function formalCall(
  id: string,
  toolName: string,
  input: string,
): RequiredToolStreamPart[] {
  return [
    part("tool-input-start", { id, toolName }),
    part("tool-input-delta", { id, delta: input }),
    part("tool-input-end", { id }),
    part("tool-call", {
      toolCallId: id,
      toolName,
      input: JSON.parse(input),
      dynamic: false,
      invalid: false,
    }),
  ];
}

function finishParts(
  finishReason: string,
  rawFinishReason?: string,
): RequiredToolStreamPart[] {
  const usage = { inputTokens: 7, outputTokens: 3 };
  return [
    part("finish-step", {
      finishReason,
      rawFinishReason,
      usage,
      providerMetadata: { gateway: { cost: "0.0125" } },
    }),
    part("finish", {
      finishReason,
      rawFinishReason,
      totalUsage: usage,
    }),
  ];
}

function openAiToolStream(
  argumentDeltas: readonly { arguments: string }[],
): Response {
  const chunks = argumentDeltas.map((delta, index) => ({
    id: "chat-formal",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-5.4",
    choices: [{
      index: 0,
      delta: {
        ...(index === 0 ? { role: "assistant" } : {}),
        tool_calls: [{
          index: 0,
          ...(index === 0
            ? {
                id: "call-finish",
                type: "function",
                function: { name: "finish", arguments: delta.arguments },
              }
            : { function: { arguments: delta.arguments } }),
        }],
      },
      finish_reason: null,
    }],
  }));
  chunks.push({
    id: "chat-formal",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-5.4",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  } as any);
  chunks.push({
    id: "chat-formal",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-5.4",
    choices: [],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  } as any);
  return new Response([
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n`),
    "data: [DONE]\n",
  ].join("\n"), {
    headers: { "content-type": "text/event-stream" },
  });
}

function gatewayToolStream(): Response {
  const input = { outcome: { message: "Gateway done." } };
  const parts = [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "gateway-call", toolName: "finish" },
    {
      type: "tool-input-delta",
      id: "gateway-call",
      delta: JSON.stringify(input),
    },
    { type: "tool-input-end", id: "gateway-call" },
    {
      type: "tool-call",
      toolCallId: "gateway-call",
      toolName: "finish",
      input: JSON.stringify(input),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_use" },
      usage: {
        inputTokens: { total: 7, noCache: 7 },
        outputTokens: { total: 3, text: 0, reasoning: 0 },
      },
      providerMetadata: { gateway: { cost: "0.0125" } },
    },
  ];
  return new Response(
    parts.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function anthropicToolStream(): Response {
  const input = JSON.stringify({ outcome: { message: "Anthropic done." } });
  const events = [
    {
      type: "message_start",
      message: {
        id: "message-formal",
        model: "claude-fable-5",
        role: "assistant",
        usage: { input_tokens: 7 },
        content: [],
        stop_reason: null,
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "anthropic-call",
        name: "finish",
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: input },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: {
        stop_reason: "tool_use",
        stop_sequence: null,
      },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((item) =>
      `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`
    ).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

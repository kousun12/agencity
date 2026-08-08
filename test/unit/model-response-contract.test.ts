import { describe, expect, test } from "bun:test";
import {
  AGENT_TOOL_CONTRACT_ID,
  MAX_MODEL_CONTRACT_EVIDENCE_BYTES,
  MAX_MODEL_FORMAL_RESPONSE_BYTES,
  MAX_MODEL_RESPONSE_BLOCKS,
  MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES,
  MAX_MODEL_TERMINATION_REASON_BYTES,
  MAX_MODEL_TOOL_CALL_ID_BYTES,
  MAX_MODEL_TOOL_CALL_SUMMARIES,
  MODEL_EFFECT_FAILURE_CODES,
  TEXT_MODEL_RESPONSE_CONTRACT,
  assertModelContractEvidenceByteCount,
  assertModelFormalResponseByteCount,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  createModelEffectOutputV2,
  resolveBuiltInModelResponseContract,
  resolveModelDispatchV2,
  validateModelContractViolation,
  validateModelDispatchV2,
  validateModelEffectOutputV2,
  validateModelEffectFailureCode,
  validateModelResponse,
  validateModelResponseContract,
  validateModelResponseContractCapability,
  type CompleteModelResponse,
  type ModelContractViolation,
  type ModelContractViolationCode,
  type ModelEffectOutputV2,
  type ModelResponseCapability,
  type ModelToolSubmission,
  type RequiredToolSetCapability,
} from "../../src/index.ts";

const runtimeCapability: RequiredToolSetCapability = {
  status: "unknown",
  requiredChoice: "provider-enforced",
  parallelCalls: "runtime-rejected",
  streaming: true,
  catalogDigest: "a".repeat(64),
  adapter: "agencity.vercel-ai-sdk.v7",
  reason: "Transport proven; exact model support is unknown.",
};
const responseCapability: ModelResponseCapability = {
  kind: "required-tool-set",
  capability: runtimeCapability,
};
const contract = resolveBuiltInModelResponseContract(
  AGENT_TOOL_CONTRACT_ID,
  "runtime-validated",
);
const transport = {
  provider: "vercel",
  adapter: "agencity.vercel-ai-sdk.v7",
} as const;

describe("provider-neutral model response contracts", () => {
  test("pins explicit text and both sealed agent contract definitions", () => {
    expect(TEXT_MODEL_RESPONSE_CONTRACT).toEqual({ kind: "text", version: 1 });
    expect(Object.isFrozen(TEXT_MODEL_RESPONSE_CONTRACT)).toBe(true);
    expect(contract.tools.map((tool) => tool.name)).toEqual([
      "bun_console",
      "finish",
    ]);
    expect(contract.contractDigest).toBe(
      "sha256:9de8715e22b2f2fcf96246c2488d5f4be2be797750fdfe6508b11dff6a745f0a",
    );
    expect(
      resolveBuiltInModelResponseContract(
        AGENT_TOOL_CONTRACT_ID,
        "provider-strict",
      ).contractDigest,
    ).toBe(
      "sha256:32b4cad28750cdb44dadd3f3c2e68ccb5e0eb39d9adeff39955d66d5fcb386f5",
    );
    expect(validateModelResponseContract(contract)).toBe(contract);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.tools)).toBe(true);
    expect(() =>
      resolveBuiltInModelResponseContract(
        "agencity.refinement-review.v1",
        "runtime-validated",
      )
    ).toThrow("does not provide");
  });

  test.each([
    ["tool name", (value: any) => { value.tools[0].name = "typescript"; }],
    ["description", (value: any) => { value.tools[0].description += " drift"; }],
    [
      "schema",
      (value: any) => { value.tools[0].inputSchema.properties.source.type = "number"; },
    ],
    [
      "schema digest",
      (value: any) => { value.tools[0].schemaDigest = value.tools[1].schemaDigest; },
    ],
    ["tool order", (value: any) => { value.tools.reverse(); }],
    ["selection", (value: any) => { value.selection = "any"; }],
    ["supplemental text", (value: any) => { value.supplementalText = "assistant"; }],
    ["version", (value: any) => { value.version = 2; }],
    ["unknown field", (value: any) => { value.arbitrarySchema = {}; }],
  ])("rejects registry tampering in %s even after re-signing", (_name, mutate) => {
    const value = structuredClone(contract) as any;
    mutate(value);
    const { contractDigest: _digest, ...body } = value;
    value.contractDigest = canonicalJsonDigest(body);
    expect(() => validateModelResponseContract(value)).toThrow();
  });

  test("rejects digest and strictness tampering", () => {
    const digest = structuredClone(contract) as any;
    digest.contractDigest = `sha256:${"0".repeat(64)}`;
    expect(() => validateModelResponseContract(digest)).toThrow(
      "digest does not match",
    );
    const enforcement = structuredClone(contract) as any;
    enforcement.schemaEnforcement = "provider-strict";
    expect(() => validateModelResponseContract(enforcement)).toThrow(
      "digest does not match",
    );
    expect(() =>
      validateModelResponseContract({
        ...TEXT_MODEL_RESPONSE_CONTRACT,
        tools: [],
      })
    ).toThrow("sealed definition");
  });

  test("rejects every response contract and capability kind/strictness mismatch", () => {
    const strictContract = resolveBuiltInModelResponseContract(
      AGENT_TOOL_CONTRACT_ID,
      "provider-strict",
    );
    const strictCapability: RequiredToolSetCapability = {
      ...runtimeCapability,
      status: "provider-strict",
      parallelCalls: "provider-disabled",
    };
    expect(() =>
      validateModelResponseContractCapability(
        TEXT_MODEL_RESPONSE_CONTRACT,
        responseCapability,
      )
    ).toThrow("text response capability");
    expect(() =>
      validateModelResponseContractCapability(
        contract,
        { kind: "text" },
      )
    ).toThrow("required-tool-set capability");
    expect(() =>
      validateModelResponseContractCapability(
        strictContract,
        responseCapability,
      )
    ).toThrow("lacks matching capability");
    expect(() =>
      validateModelResponseContractCapability(
        contract,
        {
          kind: "required-tool-set",
          capability: strictCapability,
        },
      )
    ).toThrow("disagrees with capability provenance");
    expect(() =>
      validateModelResponseContractCapability(
        contract,
        {
          kind: "required-tool-set",
          capability: {
            ...runtimeCapability,
            status: "unsupported",
            requiredChoice: "unsupported",
            parallelCalls: "unsupported",
            streaming: false,
          },
        },
      )
    ).toThrow("unsupported execution capability");
    expect(() =>
      validateModelResponseContractCapability(
        contract,
        {
          kind: "required-tool-set",
          capability: { ...runtimeCapability, requiredChoice: "unsupported" },
        },
      )
    ).toThrow("unsupported execution capability");
    expect(() =>
      validateModelResponseContractCapability(
        contract,
        {
          kind: "required-tool-set",
          capability: { ...runtimeCapability, parallelCalls: "unsupported" },
        },
      )
    ).toThrow("unsupported execution capability");
    expect(() =>
      validateModelResponseContractCapability(
        contract,
        {
          kind: "required-tool-set",
          capability: {
            ...runtimeCapability,
            catalogDigest: `sha256:${"a".repeat(64)}`,
          },
        },
      )
    ).toThrow("catalog digest is invalid");
  });

  test("retains one accepted tool-input copy and stable result provenance", () => {
    const output = validSubmissionOutput("const value = 1;\nvalue;", "Working.");
    expect(validateModelEffectOutputV2(output, {
      responseContract: contract,
      responseCapability,
      configuredProvider: "vercel",
    })).toEqual(output);
    expect(output.resultDigest).toBe(canonicalJsonDigest(output.result));
    const encoded = JSON.stringify(output);
    expect(encoded.match(/const value = 1;\\nvalue;/g)).toHaveLength(1);
    expect((output.response.blocks.find((block) => block.type === "tool-call") as any).input)
      .toBeUndefined();
  });

  test("requires durable accepted-input bytes to equal the canonical encoding", () => {
    const value = structuredClone(validSubmissionOutput("return 1;")) as any;
    value.result.submission.inputBytes += 1;
    const block = value.response.blocks.find(
      (item: any) => item.type === "tool-call",
    );
    block.inputBytes += 1;
    resignResult(value);
    expect(() => validateModelEffectOutputV2(value, {
      responseContract: contract,
      responseCapability,
      configuredProvider: "vercel",
    })).toThrow("canonical JSON encoding");
  });

  test("rejects result, input, response evidence, and transport tampering", () => {
    const mutations: Array<(value: any) => void> = [
      (value) => { value.resultDigest = `sha256:${"0".repeat(64)}`; },
      (value) => { value.result.submission.input.source += " changed"; resignResult(value); },
      (value) => { value.response.blocks[1].inputBytes += 1; resignResult(value); },
      (value) => {
        value.result.submission.transport = {
          ...value.result.submission.transport,
          adapter: "other",
        };
        resignResult(value);
      },
      (value) => {
        value.response.transport = {
          ...value.response.transport,
          adapter: "other",
        };
        value.result.submission.transport = {
          ...value.result.submission.transport,
          adapter: "other",
        };
        resignResult(value);
      },
      (value) => { value.result.submission.responseContract.version = 2; resignResult(value); },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(validSubmissionOutput("return 1;", "Working.")) as any;
      mutate(value);
      expect(() => validateModelEffectOutputV2(value, {
        responseContract: contract,
        responseCapability,
        configuredProvider: "vercel",
      })).toThrow();
    }
  });

  test("validates complete and guard-aborted violation outputs", () => {
    const missing = validViolationOutput(
      "required-tool-missing",
      completeResponse([], { kind: "text-stop", rawReason: "stop" }),
    );
    expect(validateModelEffectOutputV2(missing, {
      responseContract: contract,
      responseCapability,
      configuredProvider: "vercel",
    })).toEqual(missing);

    const guardedResponse = {
      kind: "guard-aborted",
      blocks: [],
      termination: {
        kind: "adapter-guard",
        code: "oversized-tool-input",
      },
      usage: null,
      warnings: [],
      transport,
    } as const;
    const guarded = validViolationOutput(
      "oversized-tool-input",
      guardedResponse,
    );
    expect(validateModelEffectOutputV2(guarded, {
      responseContract: contract,
      responseCapability,
      configuredProvider: "vercel",
    }).response.usage).toBeNull();
  });

  test("rejects every invalid contract/result/termination pairing", () => {
    const textResponse = completeResponse(
      [{ type: "text", text: "done" }],
      { kind: "text-stop", rawReason: "stop" },
    );
    const textOutput = createModelEffectOutputV2({
      response: textResponse,
      result: {
        kind: "text",
        text: "done",
        textDigest: canonicalJsonDigest("done"),
      },
      responseContract: TEXT_MODEL_RESPONSE_CONTRACT,
      responseCapability: { kind: "text" },
      configuredProvider: "vercel",
    });
    expect(() => validateModelEffectOutputV2(textOutput, {
      responseContract: contract,
      responseCapability,
    })).toThrow("cannot produce a text result");

    const guardWithText = structuredClone(textOutput) as any;
    guardWithText.response = {
      kind: "guard-aborted",
      blocks: [],
      termination: { kind: "adapter-guard", code: "multiple-tool-calls" },
      usage: null,
      warnings: [],
      transport,
    };
    resignResult(guardWithText);
    expect(() => validateModelEffectOutputV2(guardWithText, {
      responseContract: TEXT_MODEL_RESPONSE_CONTRACT,
      responseCapability: { kind: "text" },
    })).toThrow("complete response");

    const submission = structuredClone(validSubmissionOutput("return 1;")) as any;
    submission.response.kind = "guard-aborted";
    submission.response.termination = {
      kind: "adapter-guard",
      code: "multiple-tool-calls",
    };
    submission.response.usage = null;
    expect(() => validateModelEffectOutputV2(submission, {
      responseContract: contract,
      responseCapability,
    })).toThrow("complete tool-call");

    const duplicate = structuredClone(validSubmissionOutput("return 1;")) as any;
    duplicate.response.blocks.push({ ...duplicate.response.blocks[0], callId: "second" });
    expect(() => validateModelEffectOutputV2(duplicate, {
      responseContract: contract,
      responseCapability,
    })).toThrow("exactly one");

    const guardMismatch = structuredClone(validViolationOutput(
      "oversized-tool-input",
      {
        kind: "guard-aborted",
        blocks: [],
        termination: {
          kind: "adapter-guard",
          code: "oversized-tool-input",
        },
        usage: null,
        warnings: [],
        transport,
      },
    )) as any;
    guardMismatch.result.violation.code = "unexpected-tool";
    resignResult(guardMismatch);
    expect(() => validateModelEffectOutputV2(guardMismatch, {
      responseContract: contract,
      responseCapability,
    })).toThrow("code disagrees");
  });

  test("enforces block, call-ID, termination, and supplemental-text bounds", () => {
    const blocks = Array.from(
      { length: MAX_MODEL_RESPONSE_BLOCKS },
      () => ({ type: "text" as const, text: "" }),
    );
    expect(() => validateModelResponse(completeResponse(blocks))).not.toThrow();
    expect(() =>
      validateModelResponse(completeResponse([
        ...blocks,
        { type: "text", text: "" },
      ]))
    ).toThrow(`exceeds ${MAX_MODEL_RESPONSE_BLOCKS} blocks`);

    expect(() =>
      validateModelResponse(completeResponse([{
        type: "tool-call",
        callId: "x".repeat(MAX_MODEL_TOOL_CALL_ID_BYTES),
        name: "bun_console",
        inputDigest: canonicalJsonDigest({ source: "x" }),
        inputBytes: canonicalJsonByteLength({ source: "x" }),
      }], { kind: "tool-calls" }))
    ).not.toThrow();
    expect(() =>
      validateModelResponse(completeResponse([{
        type: "tool-call",
        callId: "x".repeat(MAX_MODEL_TOOL_CALL_ID_BYTES + 1),
        name: "bun_console",
        inputDigest: canonicalJsonDigest({ source: "x" }),
        inputBytes: canonicalJsonByteLength({ source: "x" }),
      }], { kind: "tool-calls" }))
    ).toThrow(`exceeds ${MAX_MODEL_TOOL_CALL_ID_BYTES} bytes`);

    expect(() =>
      validateModelResponse(completeResponse([], {
        kind: "other",
        rawReason: "x".repeat(MAX_MODEL_TERMINATION_REASON_BYTES),
      }))
    ).not.toThrow();
    expect(() =>
      validateModelResponse(completeResponse([], {
        kind: "other",
        rawReason: "x".repeat(MAX_MODEL_TERMINATION_REASON_BYTES + 1),
      }))
    ).toThrow(`exceeds ${MAX_MODEL_TERMINATION_REASON_BYTES} bytes`);

    expect(() =>
      validateModelEffectOutputV2(
        validSubmissionOutput("return 1;", "x".repeat(MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES)),
        { responseContract: contract, responseCapability },
      )
    ).not.toThrow();
    expect(() =>
      validSubmissionOutput(
        "return 1;",
        "x".repeat(MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES + 1),
      )
    ).toThrow(`exceeds ${MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES} bytes`);
  });

  test("binds each non-guard violation code to its completed response evidence", () => {
    const emptyTextStop = completeResponse(
      [],
      { kind: "text-stop", rawReason: "stop" },
    );
    expect(() => validViolationOutput("unexpected-tool", emptyTextStop))
      .toThrow("outside the response contract");
    expect(() => validViolationOutput("invalid-tool-input", emptyTextStop))
      .toThrow("rejected call for a contract tool");
    expect(() => validViolationOutput("truncated-tool-input", emptyTextStop))
      .toThrow("output-limit termination");
    expect(() => validViolationOutput("oversized-tool-input", emptyTextStop))
      .toThrow("oversized call-argument evidence");
    expect(() =>
      validViolationOutput("oversized-provider-response", emptyTextStop)
    ).toThrow("omitted or oversized response evidence");
    expect(() => validViolationOutput("provider-refusal", emptyTextStop))
      .toThrow("refusal termination");
    expect(() =>
      validViolationOutput("incomplete-provider-response", emptyTextStop)
    ).toThrow("no tool call");
    expect(() =>
      validViolationOutput(
        "required-tool-missing",
        completeResponse([], { kind: "other" }),
      )
    ).toThrow("requires completed text-stop");
    expect(() =>
      validViolationOutput(
        "required-tool-missing",
        completeResponse([], { kind: "refusal" }),
      )
    ).toThrow("content-filter or refusal termination");

    const rogueCall = {
      type: "tool-call" as const,
      callId: "rogue-1",
      name: "rogue_tool",
      inputDigest: canonicalJsonDigest({}),
      inputBytes: canonicalJsonByteLength({}),
    };
    expect(() =>
      validViolationOutput(
        "unexpected-tool",
        completeResponse([rogueCall], { kind: "tool-calls" }),
      )
    ).not.toThrow();
    expect(() =>
      validViolationOutput(
        "invalid-tool-input",
        completeResponse([rogueCall], { kind: "tool-calls" }),
      )
    ).toThrow("contract tool");

    const malformed = {
      type: "invalid-tool-call" as const,
      callId: "bad-1",
      inputBytes: 7,
      code: "malformed-arguments" as const,
    };
    expect(() =>
      validViolationOutput(
        "invalid-tool-input",
        completeResponse([malformed], { kind: "tool-calls" }),
      )
    ).not.toThrow();

    const truncated = {
      type: "invalid-tool-call" as const,
      callId: "cut-1",
      name: "bun_console",
      inputBytes: 3,
      code: "truncated-arguments" as const,
    };
    expect(() =>
      validViolationOutput(
        "truncated-tool-input",
        completeResponse([truncated], { kind: "output-limit", rawReason: "length" }),
      )
    ).not.toThrow();
    expect(() =>
      validViolationOutput(
        "truncated-tool-input",
        completeResponse([truncated], { kind: "text-stop" }),
      )
    ).toThrow("output-limit termination");

    expect(() =>
      validViolationOutput(
        "provider-refusal",
        completeResponse([], { kind: "content-filter" }),
      )
    ).not.toThrow();
    expect(() =>
      validViolationOutput(
        "incomplete-provider-response",
        completeResponse([], { kind: "other" }),
      )
    ).not.toThrow();

    const single = {
      type: "tool-call" as const,
      callId: "only-1",
      name: "bun_console",
      inputDigest: canonicalJsonDigest({ source: "1;" }),
      inputBytes: canonicalJsonByteLength({ source: "1;" }),
    };
    const overstated = violation("multiple-tool-calls", {
      toolCalls: [{
        callId: single.callId,
        name: single.name,
        inputDigest: single.inputDigest,
        inputBytes: single.inputBytes,
      }],
      omittedBlockCount: 1,
      supplementalTextBytes: 0,
    }, { kind: "tool-calls" });
    expect(() =>
      createModelEffectOutputV2({
        response: completeResponse([single], { kind: "tool-calls" }),
        result: { kind: "contract-violation", violation: overstated },
        responseContract: contract,
        responseCapability,
        configuredProvider: "vercel",
      })
    ).toThrow("at least two retained tool-call blocks");
  });

  test("requires violation evidence to prove missing and multiple calls", () => {
    const summary = {
      callId: "call",
      name: "bun_console",
      inputDigest: canonicalJsonDigest({}),
      inputBytes: 2,
    };
    expect(() =>
      validateModelContractViolation(violation("required-tool-missing", {
        toolCalls: [summary],
        omittedBlockCount: 0,
        supplementalTextBytes: 0,
      }))
    ).toThrow("cannot retain tool-call evidence");
    expect(() =>
      validateModelContractViolation(violation("required-tool-missing", {
        toolCalls: [],
        omittedBlockCount: 1,
        supplementalTextBytes: 0,
      }))
    ).toThrow("cannot retain tool-call evidence");
    expect(() =>
      validateModelContractViolation(violation("multiple-tool-calls", {
        toolCalls: [summary],
        omittedBlockCount: 0,
        supplementalTextBytes: 0,
      }))
    ).toThrow("at least two calls");
    expect(() =>
      validateModelContractViolation(violation("multiple-tool-calls", {
        toolCalls: [summary, { ...summary, callId: "second" }],
        omittedBlockCount: 0,
        supplementalTextBytes: 0,
      }, { kind: "tool-calls" }))
    ).not.toThrow();
  });

  test("enforces call-summary, evidence, and formal aggregate bounds", () => {
    const summary = {
      callId: "call",
      name: "bad",
      inputDigest: canonicalJsonDigest({}),
      inputBytes: 2,
      invalidCode: "malformed-arguments" as const,
    };
    const exactSummaries = violation("invalid-tool-input", {
      toolCalls: Array.from(
        { length: MAX_MODEL_TOOL_CALL_SUMMARIES },
        () => summary,
      ),
      omittedBlockCount: 0,
      supplementalTextBytes: 0,
    });
    expect(() => validateModelContractViolation(exactSummaries)).not.toThrow();
    const excessSummaries = structuredClone(exactSummaries) as any;
    excessSummaries.evidence.toolCalls.push(summary);
    excessSummaries.evidenceDigest = canonicalJsonDigest(excessSummaries.evidence);
    expect(() => validateModelContractViolation(excessSummaries))
      .toThrow(`exceeds ${MAX_MODEL_TOOL_CALL_SUMMARIES} tool-call summaries`);

    const seed = {
      ...violation("required-tool-missing"),
      message: "x",
    };
    const overhead = canonicalJsonByteLength(seed) - 1;
    const exactEvidence = {
      ...seed,
      message: "x".repeat(MAX_MODEL_CONTRACT_EVIDENCE_BYTES - overhead),
    };
    expect(canonicalJsonByteLength(exactEvidence))
      .toBe(MAX_MODEL_CONTRACT_EVIDENCE_BYTES);
    expect(() => validateModelContractViolation(exactEvidence)).not.toThrow();
    expect(() =>
      validateModelContractViolation({
        ...exactEvidence,
        message: `${exactEvidence.message}x`,
      })
    ).toThrow(`exceeds ${MAX_MODEL_CONTRACT_EVIDENCE_BYTES} bytes`);

    expect(() =>
      assertModelContractEvidenceByteCount(
        MAX_MODEL_CONTRACT_EVIDENCE_BYTES,
      )
    ).not.toThrow();
    expect(() =>
      assertModelContractEvidenceByteCount(
        MAX_MODEL_CONTRACT_EVIDENCE_BYTES + 1,
      )
    ).toThrow();
    expect(() =>
      assertModelFormalResponseByteCount(MAX_MODEL_FORMAL_RESPONSE_BYTES)
    ).not.toThrow();
    expect(() =>
      assertModelFormalResponseByteCount(MAX_MODEL_FORMAL_RESPONSE_BYTES + 1)
    ).toThrow();
  });

  test("pins closed model-effect failure codes", () => {
    expect(MODEL_EFFECT_FAILURE_CODES).toEqual([
      "unsupported-response-contract",
      "provider-context-window-overflow",
      "provider-request-failed",
      "transport-failed",
      "stream-failed",
      "incomplete-provider-response",
    ]);
    expect(Object.isFrozen(MODEL_EFFECT_FAILURE_CODES)).toBe(true);
    expect(validateModelEffectFailureCode("stream-failed"))
      .toBe("stream-failed");
    expect(() => validateModelEffectFailureCode("cancelled")).toThrow(
      "Unknown model effect failure code",
    );
  });

  test("builds one response-aware dispatch and rejects relation tampering", () => {
    const dispatch = resolveModelDispatchV2({
      configuration: {
        provider: "vercel",
        model: "openai/gpt-test",
        reasoningEffort: "high",
      },
      capability: {
        status: "listed",
        levels: ["low", "medium", "high"],
      },
      catalogDigest: "a".repeat(64),
      responseContract: contract,
      responseCapability,
      executionEndpointId: "b".repeat(64),
    });
    expect(dispatch).toMatchObject({
      dispatchVersion: "agencity.model-dispatch.v2",
      responseContract: { contractId: AGENT_TOOL_CONTRACT_ID },
      responseCapability: {
        kind: "required-tool-set",
        capability: { status: "unknown", streaming: true },
      },
      reasoning: {
        requestedEffort: "high",
        mode: "requested",
      },
    });
    expect(Object.isFrozen(dispatch)).toBe(true);
    expect(() => validateModelDispatchV2(dispatch)).not.toThrow();

    const strict = structuredClone(dispatch) as any;
    strict.responseContract = resolveBuiltInModelResponseContract(
      AGENT_TOOL_CONTRACT_ID,
      "provider-strict",
    );
    expect(() => validateModelDispatchV2(strict))
      .toThrow("lacks matching capability");

    const extra = { ...dispatch, tools: [] } as any;
    expect(() => validateModelDispatchV2(extra))
      .toThrow("missing or unknown fields");

    const configurationExtra = structuredClone(dispatch) as any;
    configurationExtra.configuration.responseContract = {};
    expect(() => validateModelDispatchV2(configurationExtra))
      .toThrow("configuration has missing or unknown fields");

    const reasoningExtra = structuredClone(dispatch) as any;
    reasoningExtra.reasoning.capability.source = "caller";
    expect(() => validateModelDispatchV2(reasoningExtra))
      .toThrow("capability has missing or unknown fields");

    const mismatched = structuredClone(dispatch) as any;
    mismatched.reasoning.requestedEffort = "low";
    expect(() => validateModelDispatchV2(mismatched))
      .toThrow("disagrees with its configuration");

    const catalog = structuredClone(dispatch) as any;
    catalog.responseCapability.capability.catalogDigest = "c".repeat(64);
    expect(() => validateModelDispatchV2(catalog))
      .toThrow("disagree on catalog provenance");
  });
});

function validSubmissionOutput(
  source: string,
  supplementalText = "",
): ModelEffectOutputV2 {
  const input = { source };
  const inputDigest = canonicalJsonDigest(input);
  const inputBytes = canonicalJsonByteLength(input);
  const termination = { kind: "tool-calls" as const, rawReason: "tool_calls" };
  const submission: ModelToolSubmission = {
    providerToolCallId: "provider-call-1",
    name: "bun_console",
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
    ...(supplementalText
      ? {
          supplementalText: {
            kind: "content" as const,
            text: supplementalText,
            textDigest: canonicalJsonDigest(supplementalText),
            textBytes: new TextEncoder().encode(supplementalText).byteLength,
          },
        }
      : {}),
  };
  const response = completeResponse([
    ...(supplementalText
      ? [{ type: "text" as const, text: supplementalText }]
      : []),
    {
      type: "tool-call",
      callId: submission.providerToolCallId,
      name: submission.name,
      inputDigest,
      inputBytes,
    },
  ], termination);
  return createModelEffectOutputV2({
    response,
    result: { kind: "tool-submission", submission },
    responseContract: contract,
    responseCapability,
    configuredProvider: "vercel",
  });
}

function completeResponse(
  blocks: CompleteModelResponse["blocks"] = [],
  termination: CompleteModelResponse["termination"] = {
    kind: "text-stop",
    rawReason: "stop",
  },
): CompleteModelResponse {
  return {
    kind: "complete",
    blocks,
    termination,
    usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.01 },
    warnings: [],
    transport,
  };
}

function violation(
  code: ModelContractViolationCode,
  evidence: ModelContractViolation["evidence"] = {
    toolCalls: [],
    omittedBlockCount: 0,
    supplementalTextBytes: 0,
  },
  termination: ModelContractViolation["termination"] = {
    kind: "text-stop",
    rawReason: "stop",
  },
): ModelContractViolation {
  return {
    code,
    message: "The provider response did not satisfy the required tool contract.",
    termination,
    evidence,
    evidenceDigest: canonicalJsonDigest(evidence),
  };
}

function validViolationOutput(
  code: ModelContractViolationCode,
  response: ModelEffectOutputV2["response"],
): ModelEffectOutputV2 {
  const toolCalls = response.blocks
    .filter((block) => block.type !== "text")
    .slice(0, MAX_MODEL_TOOL_CALL_SUMMARIES)
    .map((block) => block.type === "tool-call"
      ? {
          callId: block.callId,
          name: block.name,
          inputDigest: block.inputDigest,
          inputBytes: block.inputBytes,
        }
      : {
          ...(block.callId === undefined ? {} : { callId: block.callId }),
          ...(block.name === undefined ? {} : { name: block.name }),
          ...(block.inputDigest === undefined ? {} : { inputDigest: block.inputDigest }),
          inputBytes: block.inputBytes,
          invalidCode: block.code,
        });
  const text = response.blocks
    .filter((block): block is Extract<(typeof response.blocks)[number], { type: "text" }> =>
      block.type === "text")
    .map((block) => block.text)
    .join("");
  const evidence = {
    toolCalls,
    omittedBlockCount: Math.max(
      0,
      response.blocks.filter((block) => block.type !== "text").length -
        MAX_MODEL_TOOL_CALL_SUMMARIES,
    ),
    ...(text ? { supplementalTextDigest: canonicalJsonDigest(text) } : {}),
    supplementalTextBytes: new TextEncoder().encode(text).byteLength,
  };
  return createModelEffectOutputV2({
    response,
    result: {
      kind: "contract-violation",
      violation: violation(code, evidence, response.termination),
    },
    responseContract: contract,
    responseCapability,
    configuredProvider: "vercel",
  });
}

function resignResult(value: any): void {
  value.resultDigest = canonicalJsonDigest(value.result);
}

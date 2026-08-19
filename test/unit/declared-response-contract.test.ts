import { describe, expect, test } from "bun:test";
import {
  DECLARED_DATA_CONTRACT_FAMILY,
  DECLARED_DATA_CONTRACT_ID,
  DECLARED_DATA_TOOL_NAME,
  DECLARED_SCHEMA_VALIDATOR_ID,
  MAX_DECLARED_INLINE_RESULT_BYTES,
  ModelEffectAdmissionService,
  ModelExecutor,
  REGISTERED_BUILT_IN_STRUCTURED_CONTRACT_IDS,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  registerBrokeredSecret,
  resolveBuiltInModelResponseContract,
  resolveDeclaredDataModelResponseContract,
  validateModelResponseContract,
  validateModelToolSubmission,
  type ModelProvider,
  type ModelToolSubmission,
} from "../../src/index.ts";
import { requiredToolGenerationOptions } from "../../src/executors/model-response.ts";

describe("declared-data response contracts", () => {
  test("keeps every executable contract field host-owned", () => {
    const contract = resolveDeclaredDataModelResponseContract({
      type: "object",
      properties: {
        ready: { type: "boolean" },
        reasons: { type: "array", items: { type: "string" } },
      },
      required: ["ready", "reasons"],
    }, "runtime-validated");
    expect(contract).toMatchObject({
      kind: "required-tool-set",
      contractId: DECLARED_DATA_CONTRACT_ID,
      contractFamily: DECLARED_DATA_CONTRACT_FAMILY,
      familyVersion: 1,
      validatorId: DECLARED_SCHEMA_VALIDATOR_ID,
      inlineResultByteLimit: MAX_DECLARED_INLINE_RESULT_BYTES,
      selection: "exactly-one-of",
      supplementalText: "diagnostic-only",
      tools: [{ name: DECLARED_DATA_TOOL_NAME }],
    });
    expect(contract.tools).toHaveLength(1);
    expect(contract.tools[0]!.schemaDigest)
      .toBe(canonicalJsonDigest(contract.tools[0]!.inputSchema));
    const validated = validateModelResponseContract(structuredClone(contract));
    expect(validated.kind).toBe("required-tool-set");
    if (validated.kind !== "required-tool-set") {
      throw new Error("expected declared required-tool-set contract");
    }
    expect(validated.contractDigest).toBe(contract.contractDigest);
    expect(REGISTERED_BUILT_IN_STRUCTURED_CONTRACT_IDS)
      .not.toContain(DECLARED_DATA_CONTRACT_ID as never);
    expect(() =>
      resolveBuiltInModelResponseContract(
        DECLARED_DATA_CONTRACT_ID as never,
        "runtime-validated",
      )
    ).toThrow("sealed contract registry");
    const options = requiredToolGenerationOptions(contract);
    expect(options.toolChoice).toBe("required");
    expect(Object.keys(options.tools)).toEqual([DECLARED_DATA_TOOL_NAME]);
  });

  test("validates one declaration through existing submission machinery", () => {
    const contract = resolveDeclaredDataModelResponseContract({
      type: "object",
      properties: { ready: { type: "boolean" } },
      required: ["ready"],
    }, "runtime-validated");
    const input = { value: { ready: true } };
    const submission: ModelToolSubmission = {
      providerToolCallId: "declared-call-1",
      name: DECLARED_DATA_TOOL_NAME,
      input,
      inputDigest: canonicalJsonDigest(input),
      inputBytes: canonicalJsonByteLength(input),
      responseContract: {
        contractId: contract.contractId,
        version: contract.version,
        contractDigest: contract.contractDigest,
      },
      transport: {
        provider: "fixture",
        adapter: "fixture.formal.v1",
      },
      termination: { kind: "tool-calls", rawReason: "tool_calls" },
    };
    expect(validateModelToolSubmission(submission, contract).input)
      .toEqual(input);
    expect(() =>
      validateModelToolSubmission({
        ...submission,
        name: "caller_selected_tool",
      }, contract)
    ).toThrow("not allowed");
    expect(() =>
      validateModelToolSubmission({
        ...submission,
        input: { value: { ready: "yes" } },
        inputDigest: canonicalJsonDigest({ value: { ready: "yes" } }),
        inputBytes: canonicalJsonByteLength({ value: { ready: "yes" } }),
      }, contract)
    ).toThrow("does not satisfy schema");
  });

  test("rejects contract tampering even when the outer digest is recomputed", () => {
    const original = resolveDeclaredDataModelResponseContract(
      { type: "string" },
      "runtime-validated",
    );
    const tampered = structuredClone(original) as any;
    tampered.tools[0].name = "caller_tool";
    const { contractDigest: _digest, ...body } = tampered;
    tampered.contractDigest = canonicalJsonDigest(body);
    expect(() => validateModelResponseContract(tampered))
      .toThrow("declared-data family");
  });

  test("admits declared data with the same capability-pinned dispatcher", () => {
    const provider: ModelProvider = {
      name: "fixture",
      capabilities: {
        streaming: false,
        reasoningControl: "none",
        requiredToolSet: {
          status: "provider-strict",
          requiredChoice: "provider-enforced",
          parallelCalls: "provider-disabled",
          streaming: true,
          adapter: "fixture.formal.v1",
        },
      },
      complete: async () => ({
        text: "unused",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      }),
    };
    const admission = new ModelEffectAdmissionService(
      new ModelExecutor([provider]),
    ).requestDeclaredData(
      { type: "boolean" },
      { provider: "fixture", model: "fixture/model" },
    );
    expect(admission.modelDispatch).toMatchObject({
      configuration: { provider: "fixture", model: "fixture/model" },
      responseContract: {
        contractId: DECLARED_DATA_CONTRACT_ID,
        schemaEnforcement: "provider-strict",
      },
      responseCapability: {
        kind: "required-tool-set",
        capability: {
          status: "provider-strict",
          adapter: "fixture.formal.v1",
        },
      },
    });
  });

  test("rejects secret-bearing schemas at supervisor admission", () => {
    const secret = "sk-proj-declared-admission-secret-123456";
    const release = registerBrokeredSecret(secret);
    try {
      const provider: ModelProvider = {
        name: "fixture",
        capabilities: {
          streaming: false,
          reasoningControl: "none",
          requiredToolSet: {
            status: "runtime-validated",
            requiredChoice: "provider-enforced",
            parallelCalls: "provider-disabled",
            streaming: true,
            adapter: "fixture.formal.v1",
          },
        },
        complete: async () => ({
          text: "unused",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        }),
      };
      const service = new ModelEffectAdmissionService(
        new ModelExecutor([provider]),
      );
      expect(() =>
        service.requestDeclaredData({
          type: "string",
          description: secret,
        }, {
          provider: "fixture",
          model: "fixture/model",
        })
      ).toThrow("contains a registered credential value");
    } finally {
      release();
    }
  });
});

import {
  jsonSchema,
  tool,
  type JSONSchema7,
  type ToolSet,
} from "ai";
import {
  AGENT_TOOL_CONTRACT_ID,
  AGENT_TYPED_TOOL_CONTRACT_ID,
  DECLARED_DATA_CONTRACT_ID,
  MAX_MODEL_FORMAL_RESPONSE_BYTES,
  MAX_MODEL_RESPONSE_BLOCKS,
  MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES,
  MAX_MODEL_TERMINATION_REASON_BYTES,
  MAX_MODEL_TOOL_CALL_ID_BYTES,
  MAX_MODEL_TOOL_CALL_SUMMARIES,
  MAX_MODEL_TOOL_NAME_BYTES,
  assertJsonValue,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  canonicalJsonStringify,
  createModelEffectOutputV2,
  modelResponseContractInputByteLimit,
  normalizeRefinementReviewTransportValue,
  REFINEMENT_REVIEW_CONTRACT_ID,
  REFINEMENT_REVIEW_TOOL_NAME,
  REFINEMENT_GOVERNANCE_CONTRACT_ID,
  REFINEMENT_GOVERNANCE_TOOL_NAME,
  validateRefinementGovernanceDecision,
  validateDeclaredDataSubmissionInput,
  validateAgentToolSubmissionValue,
  validateTypedAgentToolSubmissionValue,
  type AgentAction,
  type CompleteModelResponse,
  type InvalidToolCallCode,
  type JsonValue,
  type ModelAdapterGuardCode,
  type ModelContractViolation,
  type ModelContractViolationCode,
  type ModelDispatch,
  type ModelEffectFailureCode,
  type ModelEffectOutputV2,
  type ModelResponseBlock,
  type ModelResponseToolDefinition,
  type ProviderInputTool,
  type ModelToolCallSummary,
  type ModelToolSubmission,
  type ModelWarning,
  type ModelResponse,
  type ProviderNeutralModelOutputDelta,
  type RequiredToolSetModelResponseContract,
  type Usage,
} from "../domain/index.ts";
import {
  containsCredentialMaterial,
  scrubText,
} from "../security/index.ts";

const encoder = new TextEncoder();
const INERT_TOOL_OUTPUT_SCHEMA: JSONSchema7 = Object.freeze({
  type: "null",
});

export class ModelProviderResponseFailureError extends Error {
  constructor(
    readonly code: ModelEffectFailureCode,
    readonly provider: string,
    readonly model: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelProviderResponseFailureError";
  }
}

export interface RequiredToolStreamPart {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface RequiredToolStreamResult {
  readonly fullStream: AsyncIterable<RequiredToolStreamPart>;
}

type AbortSource =
  | { readonly kind: "external" }
  | { readonly kind: "guard"; readonly code: ModelAdapterGuardCode }
  | { readonly kind: "unsupported" };

export class ModelResponseGuard {
  readonly controller = new AbortController();
  #source: AbortSource | undefined;
  readonly #external: AbortSignal;
  readonly #onExternalAbort: () => void;

  constructor(external: AbortSignal) {
    this.#external = external;
    this.#onExternalAbort = () => this.#abort({ kind: "external" });
    if (external.aborted) this.#onExternalAbort();
    else external.addEventListener("abort", this.#onExternalAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get source(): AbortSource | undefined {
    return this.#source;
  }

  guard(code: ModelAdapterGuardCode): void {
    this.#abort({ kind: "guard", code });
  }

  unsupported(): void {
    this.#abort({ kind: "unsupported" });
  }

  close(): void {
    this.#external.removeEventListener("abort", this.#onExternalAbort);
  }

  #abort(source: AbortSource): void {
    if (this.#source) return;
    this.#source = source;
    this.controller.abort(source);
  }
}

export function compileRequiredToolSet(
  contract: RequiredToolSetModelResponseContract,
  resolvedTools: readonly (ModelResponseToolDefinition | ProviderInputTool)[] =
    contract.tools,
): ToolSet {
  const entries = resolvedTools.map((definition) => [
    definition.name,
    tool({
      description: definition.description,
      inputSchema: jsonSchema<JsonValue>(
        definition.inputSchema as JSONSchema7,
        {
          validate: (value) =>
            validateToolInput(contract, definition, value),
        },
      ),
      outputSchema: jsonSchema<null>(INERT_TOOL_OUTPUT_SCHEMA, {
        validate: (value) =>
          value === null
            ? { success: true, value: null }
            : {
                success: false,
                error: new Error("Declaration-only tool output is inert"),
              },
      }),
      ...(("strict" in definition
            ? definition.strict
            : contract.schemaEnforcement === "provider-strict")
        ? { strict: true }
        : {}),
    }),
  ] as const);
  return Object.fromEntries(entries);
}

/**
 * One-step generation options. The pinned AI SDK performs exactly one
 * generation step by default, and declaration-only tools produce no tool
 * results that could continue a provider-managed loop, so no `stopWhen`,
 * loop, or continuation option is ever supplied.
 */
export function requiredToolGenerationOptions(
  contract: RequiredToolSetModelResponseContract,
  resolvedTools: readonly (ModelResponseToolDefinition | ProviderInputTool)[] =
    contract.tools,
  toolChoice: "required" = "required",
): {
  readonly tools: ToolSet;
  readonly toolChoice: "required";
} {
  return {
    tools: compileRequiredToolSet(contract, resolvedTools),
    toolChoice,
  };
}

export async function consumeRequiredToolStream(input: {
  readonly stream: RequiredToolStreamResult;
  readonly dispatch: ModelDispatch;
  readonly guard: ModelResponseGuard;
  readonly onDelta: (delta: ProviderNeutralModelOutputDelta) => void;
  readonly gatewayCost: (metadata: unknown) => number;
}): Promise<ModelEffectOutputV2> {
  const contract = requiredContract(input.dispatch);
  const capability = requiredCapability(input.dispatch);
  const transport = {
    provider: input.dispatch.configuration.provider,
    adapter: capability.adapter,
  };
  const state = new FormalStreamState(
    contract,
    transport,
    input.guard,
    input.onDelta,
  );

  try {
    try {
      for await (const part of input.stream.fullStream) {
        state.observe(part);
        if (input.guard.source) break;
      }
    } catch (error) {
      if (!input.guard.source) {
        throw classifyStreamFailure(
          error,
          input.dispatch.configuration.provider,
          input.dispatch.configuration.model,
          state.observedPart,
        );
      }
    }

    if (input.guard.source?.kind === "external") {
      throw new DOMException("Aborted", "AbortError");
    }
    if (input.guard.source?.kind === "unsupported") {
      throw unsupportedContractFailure(input.dispatch);
    }
    if (input.guard.source?.kind === "guard") {
      return state.guardOutput(input.guard.source.code, input.dispatch);
    }
    return state.completeOutput(input.dispatch, input.gatewayCost);
  } finally {
    input.guard.close();
  }
}

export function formalOutputFromAgentAction(input: {
  readonly action: AgentAction;
  readonly dispatch: ModelDispatch;
  readonly providerToolCallId: string;
  readonly provider: string;
  readonly adapter: string;
  readonly usage: Usage;
}): ModelEffectOutputV2 {
  const contract = requiredContract(input.dispatch);
  const submission = toolSubmissionFromAction(input.action);
  if (!submission) {
    return formalMissingToolOutput({
      dispatch: input.dispatch,
      provider: input.provider,
      adapter: input.adapter,
      text: JSON.stringify(input.action),
      usage: input.usage,
    });
  }
  return acceptedSubmissionOutput({
    dispatch: input.dispatch,
    contract,
    provider: input.provider,
    adapter: input.adapter,
    callId: input.providerToolCallId,
    name: submission.name,
    value: submission.input,
    usage: input.usage,
    warnings: [],
  });
}

/** Deterministic provider-fixture helper for the sealed refinement contract. */
export function formalOutputFromRefinementReviewSubmission(input: {
  readonly transportInput: JsonValue;
  readonly dispatch: ModelDispatch;
  readonly providerToolCallId: string;
  readonly provider: string;
  readonly adapter: string;
  readonly usage: Usage;
}): ModelEffectOutputV2 {
  const contract = requiredContract(input.dispatch);
  if (contract.contractId !== REFINEMENT_REVIEW_CONTRACT_ID) {
    throw new Error("Refinement review output requires its sealed response contract");
  }
  return acceptedSubmissionOutput({
    dispatch: input.dispatch,
    contract,
    provider: input.provider,
    adapter: input.adapter,
    callId: input.providerToolCallId,
    name: REFINEMENT_REVIEW_TOOL_NAME,
    value: input.transportInput,
    usage: input.usage,
    warnings: [],
  });
}

/** Deterministic provider-fixture helper for the sealed governance contract. */
export function formalOutputFromRefinementGovernanceDecision(input: {
  readonly decision: JsonValue;
  readonly dispatch: ModelDispatch;
  readonly providerToolCallId: string;
  readonly provider: string;
  readonly adapter: string;
  readonly usage: Usage;
}): ModelEffectOutputV2 {
  const contract = requiredContract(input.dispatch);
  if (contract.contractId !== REFINEMENT_GOVERNANCE_CONTRACT_ID) {
    throw new Error("Refinement governance output requires its sealed response contract");
  }
  return acceptedSubmissionOutput({
    dispatch: input.dispatch,
    contract,
    provider: input.provider,
    adapter: input.adapter,
    callId: input.providerToolCallId,
    name: REFINEMENT_GOVERNANCE_TOOL_NAME,
    value: input.decision,
    usage: input.usage,
    warnings: [],
  });
}

export function formalMissingToolOutput(input: {
  readonly dispatch: ModelDispatch;
  readonly provider: string;
  readonly adapter: string;
  readonly text?: string;
  readonly usage: Usage;
}): ModelEffectOutputV2 {
  const text = boundedScrubbedText(
    input.text ?? "",
    MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES,
  );
  const response: CompleteModelResponse = {
    kind: "complete",
    blocks: text ? [{ type: "text", text }] : [],
    termination: { kind: "text-stop", rawReason: "stop" },
    usage: input.usage,
    warnings: [],
    transport: { provider: input.provider, adapter: input.adapter },
  };
  return violationOutput(
    input.dispatch,
    response,
    "required-tool-missing",
    "The model completed without calling a required tool.",
    {
      supplementalObservedBytes: byteLength(text),
      omittedBlockCount: 0,
    },
  );
}

interface CallObservation {
  rawId: string;
  rawName: string;
  readonly safeId?: string;
  safeName?: string;
  rawInput: string;
  rawInputBytes: number;
  completed: boolean;
  input?: JsonValue;
  invalid?: InvalidToolCallCode;
}

class FormalStreamState {
  readonly #calls: CallObservation[] = [];
  readonly #textParts: string[] = [];
  readonly #warnings: ModelWarning[] = [];
  readonly #contractNames: Set<string>;
  #observedBlocks = 0;
  #observedResponseBytes = 0;
  #completedCallParts = 0;
  #supplementalBytes = 0;
  #omittedBlockCount = 0;
  #terminal:
    | {
        readonly finishReason: string;
        readonly rawFinishReason?: string;
        readonly usage: Usage;
        readonly providerMetadata?: unknown;
      }
    | undefined;
  #finished = false;
  #abortPart = false;
  observedPart = false;

  constructor(
    readonly contract: RequiredToolSetModelResponseContract,
    readonly transport: { readonly provider: string; readonly adapter: string },
    readonly guard: ModelResponseGuard,
    readonly onDelta: (delta: ProviderNeutralModelOutputDelta) => void,
  ) {
    this.#contractNames = new Set(contract.tools.map((item) => item.name));
  }

  observe(part: RequiredToolStreamPart): void {
    this.observedPart = true;
    switch (part.type) {
      case "start-step":
        this.#observeWarnings(part.warnings);
        return;
      case "text-start":
        this.#observeBlock();
        return;
      case "text-delta":
        this.#observeText(typeof part.text === "string" ? part.text : "");
        return;
      case "reasoning-delta":
        this.#observeResponseBytes(
          typeof part.text === "string" ? byteLength(part.text) : 0,
        );
        return;
      case "tool-input-start":
        this.#observeToolStart(part);
        return;
      case "tool-input-delta":
        this.#observeToolDelta(part);
        return;
      case "tool-input-end":
        return;
      case "tool-call":
        this.#observeCompletedCall(part);
        return;
      case "finish-step":
        this.#observeFinishStep(part);
        return;
      case "finish":
        this.#observeFinish(part);
        return;
      case "abort":
        this.#abortPart = true;
        return;
      case "error":
        throw part.error;
      default:
        // Reasoning, sources, files, and provider details are intentionally
        // outside the formal result. They never become executable input.
        return;
    }
  }

  guardOutput(
    code: ModelAdapterGuardCode,
    dispatch: ModelDispatch,
  ): ModelEffectOutputV2 {
    const blocks = this.#evidenceBlocks(code);
    const response: ModelResponse = {
      kind: "guard-aborted",
      blocks,
      termination: { kind: "adapter-guard", code },
      usage: null,
      warnings: this.#warnings,
      transport: this.transport,
    };
    return violationOutput(
      dispatch,
      response,
      code,
      guardViolationMessage(code),
      {
        supplementalObservedBytes: this.#supplementalBytes,
        omittedBlockCount: this.#omittedBlockCount,
      },
    );
  }

  completeOutput(
    dispatch: ModelDispatch,
    gatewayCost: (metadata: unknown) => number,
  ): ModelEffectOutputV2 {
    if (this.#abortPart || !this.#terminal || !this.#finished) {
      throw new ModelProviderResponseFailureError(
        "incomplete-provider-response",
        dispatch.configuration.provider,
        dispatch.configuration.model,
        "Model provider stream ended without a complete terminal response",
      );
    }
    const rawReason = boundedScrubbedText(
      this.#terminal.rawFinishReason ?? "",
      MAX_MODEL_TERMINATION_REASON_BYTES,
    );
    const termination: CompleteModelResponse["termination"] = {
      kind: normalizeTermination(this.#terminal.finishReason),
      ...(rawReason ? { rawReason } : {}),
    };
    if (termination.kind === "other" && !termination.rawReason) {
      throw new ModelProviderResponseFailureError(
        "incomplete-provider-response",
        dispatch.configuration.provider,
        dispatch.configuration.model,
        "Model provider returned an incomplete terminal reason",
      );
    }

    this.#markTruncatedCalls(termination.kind);
    const blocks = this.#completedBlocks();
    const response: CompleteModelResponse = {
      kind: "complete",
      blocks,
      termination,
      usage: {
        ...this.#terminal.usage,
        costUsd: gatewayCost(this.#terminal.providerMetadata),
      },
      warnings: this.#warnings,
      transport: this.transport,
    };
    const unsupported = this.#warnings.some(isUnsupportedContractWarning);
    if (unsupported) throw unsupportedContractFailure(dispatch);

    const validCalls = this.#calls.filter(
      (call) => call.completed && !call.invalid && call.input !== undefined,
    );
    const invalidCalls = this.#calls.filter((call) => call.invalid);
    if (
      termination.kind === "tool-calls" &&
      this.#calls.length === 1 &&
      validCalls.length === 1 &&
      invalidCalls.length === 0
    ) {
      const call = validCalls[0]!;
      return acceptedSubmissionOutput({
        dispatch,
        contract: this.contract,
        provider: this.transport.provider,
        adapter: this.transport.adapter,
        callId: call.safeId!,
        name: call.safeName!,
        value: call.input!,
        usage: response.usage,
        warnings: response.warnings,
        text: this.#supplementalText(),
        termination: {
          kind: "tool-calls",
          ...(termination.rawReason === undefined
            ? {}
            : { rawReason: termination.rawReason }),
        },
      });
    }

    const violation = completedViolationCode(
      termination.kind,
      this.#calls,
    );
    return violationOutput(
      dispatch,
      response,
      violation,
      completeViolationMessage(violation),
      {
        supplementalObservedBytes: this.#supplementalBytes,
        omittedBlockCount: this.#omittedBlockCount,
      },
    );
  }

  #observeWarnings(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      const warning = normalizeWarning(item);
      this.#observeResponseBytes(byteLength(warning.message));
      if (this.#warnings.length < 8) this.#warnings.push(warning);
      if (isUnsupportedContractWarning(warning)) this.guard.unsupported();
    }
    if (value.length > 8) {
      this.#warnings[7] = {
        kind: "truncated",
        message: `Additional provider warnings were omitted (${value.length - 7} hidden)`,
      };
    }
  }

  #observeText(value: string): void {
    const bytes = byteLength(value);
    this.#supplementalBytes += bytes;
    this.#observeResponseBytes(bytes);
    if (this.#supplementalBytes > MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES) {
      this.guard.guard("oversized-provider-response");
      return;
    }
    this.#textParts.push(value);
  }

  #observeToolStart(part: RequiredToolStreamPart): void {
    this.#observeBlock();
    const rawId = typeof part.id === "string" ? part.id : "";
    const rawName = typeof part.toolName === "string" ? part.toolName : "";
    this.#observeResponseBytes(byteLength(rawId) + byteLength(rawName));
    const call = this.#newCall(rawId, rawName);
    this.#calls.push(call);
    if (this.#calls.length > 1) {
      this.guard.guard("multiple-tool-calls");
      return;
    }
    if (
      byteLength(rawId) > MAX_MODEL_TOOL_CALL_ID_BYTES ||
      byteLength(rawName) > MAX_MODEL_TOOL_NAME_BYTES ||
      !rawId ||
      !rawName
    ) {
      this.guard.guard("oversized-provider-response");
      return;
    }
    if (!this.#contractNames.has(rawName)) {
      this.guard.guard("unexpected-tool");
      return;
    }
    this.onDelta({
      kind: "tool-call-start",
      callId: call.safeId!,
      name: call.safeName!,
    });
  }

  #observeToolDelta(part: RequiredToolStreamPart): void {
    const rawId = typeof part.id === "string" ? part.id : "";
    const delta = typeof part.delta === "string" ? part.delta : "";
    let call = [...this.#calls].reverse().find((item) => item.rawId === rawId);
    if (!call) {
      call = this.#newCall(rawId, "");
      this.#calls.push(call);
      this.#observeBlock();
      if (this.#calls.length > 1) {
        this.guard.guard("multiple-tool-calls");
        return;
      }
      if (!rawId || byteLength(rawId) > MAX_MODEL_TOOL_CALL_ID_BYTES) {
        this.guard.guard("oversized-provider-response");
        return;
      }
    }
    const bytes = byteLength(delta);
    call.rawInputBytes += bytes;
    this.#observeResponseBytes(bytes);
    if (call.rawInputBytes > modelResponseContractInputByteLimit(this.contract)) {
      call.invalid = "oversized-arguments";
      this.guard.guard("oversized-tool-input");
      return;
    }
    call.rawInput += delta;
    if (call.safeId) {
      this.onDelta({
        kind: "tool-input-delta",
        callId: call.safeId,
        bytes,
      });
    }
  }

  #observeCompletedCall(part: RequiredToolStreamPart): void {
    this.#completedCallParts++;
    if (this.#completedCallParts > 1) {
      this.guard.guard("multiple-tool-calls");
      return;
    }
    const rawId = typeof part.toolCallId === "string" ? part.toolCallId : "";
    const rawName = typeof part.toolName === "string" ? part.toolName : "";
    let call = [...this.#calls].reverse().find((item) => item.rawId === rawId);
    if (!call) {
      this.#observeBlock();
      call = this.#newCall(rawId, rawName);
      this.#calls.push(call);
    }
    if (this.#calls.length > 1) {
      this.guard.guard("multiple-tool-calls");
      return;
    }
    if (call.rawName && call.rawName !== rawName) {
      this.guard.guard("unexpected-tool");
      return;
    }
    if (
      byteLength(rawId) > MAX_MODEL_TOOL_CALL_ID_BYTES ||
      byteLength(rawName) > MAX_MODEL_TOOL_NAME_BYTES ||
      !rawId ||
      !rawName
    ) {
      this.guard.guard("oversized-provider-response");
      return;
    }
    if (!this.#contractNames.has(rawName)) {
      this.guard.guard("unexpected-tool");
      return;
    }
    if (!call.rawName) {
      call.rawName = rawName;
      call.safeName = boundedScrubbedText(
        rawName,
        MAX_MODEL_TOOL_NAME_BYTES,
      );
    }
    call.completed = true;
    const rawInput = part.input;
    if (call.rawInputBytes === 0 && rawInput !== undefined) {
      try {
        const canonicalBytes = canonicalJsonByteLength(rawInput);
        call.rawInputBytes = canonicalBytes;
        this.#observeResponseBytes(canonicalBytes);
      } catch {
        // Invalid provider values are represented by metadata only below.
      }
    }
    if (
      part.invalid === true ||
      part.dynamic === true ||
      !isJsonValue(rawInput)
    ) {
      call.invalid = call.rawInputBytes > modelResponseContractInputByteLimit(this.contract)
        ? "oversized-arguments"
        : "malformed-arguments";
      return;
    }
    let canonicalBytes: number;
    try {
      canonicalBytes = canonicalJsonByteLength(rawInput);
    } catch {
      // Depth overflow while encoding an otherwise-plain value stays a
      // closed argument rejection rather than an unclassified stream error.
      call.invalid = "malformed-arguments";
      return;
    }
    if (canonicalBytes > modelResponseContractInputByteLimit(this.contract)) {
      call.rawInputBytes = canonicalBytes;
      call.invalid = "oversized-arguments";
      this.guard.guard("oversized-tool-input");
      return;
    }
    try {
      const validated = validateToolInputValue(
        this.contract,
        rawName,
        rawInput,
      );
      call.input = validated;
      call.rawInputBytes = canonicalBytes;
    } catch {
      call.invalid = "malformed-arguments";
    }
  }

  #observeFinishStep(part: RequiredToolStreamPart): void {
    const rawReason = typeof part.rawFinishReason === "string"
      ? part.rawFinishReason
      : undefined;
    if (
      rawReason !== undefined &&
      byteLength(rawReason) > MAX_MODEL_TERMINATION_REASON_BYTES
    ) {
      this.guard.guard("oversized-provider-response");
      return;
    }
    this.#observeResponseBytes(rawReason ? byteLength(rawReason) : 0);
    this.#terminal = {
      finishReason: typeof part.finishReason === "string"
        ? part.finishReason
        : "other",
      ...(rawReason === undefined ? {} : { rawFinishReason: rawReason }),
      usage: normalizeUsage(part.usage),
      ...(part.providerMetadata === undefined
        ? {}
        : { providerMetadata: part.providerMetadata }),
    };
  }

  #observeFinish(part: RequiredToolStreamPart): void {
    const rawReason = typeof part.rawFinishReason === "string"
      ? part.rawFinishReason
      : this.#terminal?.rawFinishReason;
    if (
      rawReason !== undefined &&
      byteLength(rawReason) > MAX_MODEL_TERMINATION_REASON_BYTES
    ) {
      this.guard.guard("oversized-provider-response");
      return;
    }
    this.#terminal = {
      finishReason: typeof part.finishReason === "string"
        ? part.finishReason
        : this.#terminal?.finishReason ?? "other",
      ...(rawReason === undefined ? {} : { rawFinishReason: rawReason }),
      usage: normalizeUsage(part.totalUsage ?? this.#terminal?.usage),
      ...(this.#terminal?.providerMetadata === undefined
        ? {}
        : { providerMetadata: this.#terminal.providerMetadata }),
    };
    this.#finished = true;
  }

  #observeBlock(): void {
    this.#observedBlocks++;
    if (this.#observedBlocks > MAX_MODEL_RESPONSE_BLOCKS) {
      this.#omittedBlockCount++;
      this.guard.guard("oversized-provider-response");
    }
  }

  #observeResponseBytes(bytes: number): void {
    this.#observedResponseBytes += bytes;
    if (this.#observedResponseBytes > MAX_MODEL_FORMAL_RESPONSE_BYTES) {
      this.guard.guard("oversized-provider-response");
    }
  }

  #newCall(rawId: string, rawName: string): CallObservation {
    const safeId = boundedScrubbedText(rawId, MAX_MODEL_TOOL_CALL_ID_BYTES);
    const safeName = boundedScrubbedText(rawName, MAX_MODEL_TOOL_NAME_BYTES);
    return {
      rawId,
      rawName,
      ...(safeId ? { safeId } : {}),
      ...(safeName ? { safeName } : {}),
      rawInput: "",
      rawInputBytes: 0,
      completed: false,
    };
  }

  #markTruncatedCalls(termination: CompleteModelResponse["termination"]["kind"]): void {
    if (termination !== "output-limit") return;
    for (const call of this.#calls) {
      if (!call.completed) call.invalid = "truncated-arguments";
    }
  }

  #completedBlocks(): ModelResponseBlock[] {
    const blocks: ModelResponseBlock[] = [];
    const text = this.#supplementalText();
    if (text) blocks.push({ type: "text", text });
    for (const call of this.#calls) {
      if (blocks.length >= MAX_MODEL_RESPONSE_BLOCKS) {
        this.#omittedBlockCount++;
        continue;
      }
      blocks.push(callBlock(call));
    }
    return blocks;
  }

  #evidenceBlocks(code: ModelAdapterGuardCode): ModelResponseBlock[] {
    const blocks = this.#completedBlocks();
    if (code === "multiple-tool-calls") {
      while (
        blocks.filter((block) => block.type !== "text").length < 2 &&
        blocks.length < MAX_MODEL_RESPONSE_BLOCKS
      ) {
        blocks.push({
          type: "invalid-tool-call",
          inputBytes: 0,
          code: "truncated-arguments",
        });
      }
    }
    return blocks;
  }

  #supplementalText(): string {
    return boundedScrubbedText(
      this.#textParts.join(""),
      MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES,
    );
  }
}

function validateToolInput(
  contract: RequiredToolSetModelResponseContract,
  definition: ModelResponseToolDefinition,
  value: unknown,
):
  | { readonly success: true; readonly value: JsonValue }
  | { readonly success: false; readonly error: Error } {
  try {
    return {
      success: true,
      value: validateToolInputValue(contract, definition.name, value),
    };
  } catch {
    return {
      success: false,
      error: new Error("Model tool input failed retained contract validation"),
    };
  }
}

function validateToolInputValue(
  contract: RequiredToolSetModelResponseContract,
  name: string,
  value: unknown,
): JsonValue {
  if (!isJsonValue(value)) {
    throw new Error("Tool input is not JSON");
  }
  const encoded = canonicalJsonStringify(value);
  if (containsCredentialMaterial(encoded)) {
    throw new Error("Tool input contains credential material");
  }
  const inputBytes = byteLength(encoded);
  if (contract.contractId === AGENT_TOOL_CONTRACT_ID) {
    return validateAgentToolSubmissionValue(
      { name, input: value },
      { encodedBytes: inputBytes },
    ).input as unknown as JsonValue;
  }
  if (contract.contractId === AGENT_TYPED_TOOL_CONTRACT_ID) {
    return validateTypedAgentToolSubmissionValue(
      { name, input: value },
      contract.declaredSchema,
      { encodedBytes: inputBytes },
    ).input as unknown as JsonValue;
  }
  if (contract.contractId === REFINEMENT_REVIEW_CONTRACT_ID) {
    normalizeRefinementReviewTransportValue(value, { encodedBytes: inputBytes });
    return value;
  }
  if (contract.contractId === REFINEMENT_GOVERNANCE_CONTRACT_ID) {
    validateRefinementGovernanceDecision(value);
    return value;
  }
  if (contract.contractId === DECLARED_DATA_CONTRACT_ID) {
    validateDeclaredDataSubmissionInput(contract, name, value);
    return value;
  }
  throw new Error(`No runtime validator for ${contract.contractId}`);
}

function acceptedSubmissionOutput(input: {
  readonly dispatch: ModelDispatch;
  readonly contract: RequiredToolSetModelResponseContract;
  readonly provider: string;
  readonly adapter: string;
  readonly callId: string;
  readonly name: string;
  readonly value: JsonValue;
  readonly usage: Usage;
  readonly warnings: readonly ModelWarning[];
  readonly text?: string;
  readonly termination?: ModelToolSubmission["termination"];
}): ModelEffectOutputV2 {
  const value = validateToolInputValue(input.contract, input.name, input.value);
  const inputBytes = canonicalJsonByteLength(value);
  const inputDigest = canonicalJsonDigest(value);
  const text = boundedScrubbedText(
    input.text ?? "",
    MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES,
  );
  const termination = input.termination ?? {
    kind: "tool-calls" as const,
    rawReason: "tool_calls",
  };
  const transport = { provider: input.provider, adapter: input.adapter };
  const response: CompleteModelResponse = {
    kind: "complete",
    blocks: [
      ...(text ? [{ type: "text" as const, text }] : []),
      {
        type: "tool-call",
        callId: boundedScrubbedText(
          input.callId,
          MAX_MODEL_TOOL_CALL_ID_BYTES,
        ),
        name: input.name,
        inputDigest,
        inputBytes,
      },
    ],
    termination,
    usage: input.usage,
    warnings: input.warnings,
    transport,
  };
  const submission: ModelToolSubmission = {
    providerToolCallId: response.blocks.find(
      (block) => block.type === "tool-call",
    )!.callId,
    name: input.name,
    input: value,
    inputDigest,
    inputBytes,
    responseContract: {
      contractId: input.contract.contractId,
      version: input.contract.version,
      contractDigest: input.contract.contractDigest,
    },
    transport,
    termination,
    ...(text
      ? {
          supplementalText: {
            kind: "content" as const,
            text,
            textDigest: canonicalJsonDigest(text),
            textBytes: byteLength(text),
          },
        }
      : {}),
  };
  return createModelEffectOutputV2({
    response,
    result: { kind: "tool-submission", submission },
    responseContract: input.contract,
    responseCapability: input.dispatch.responseCapability,
    configuredProvider: input.provider,
  });
}

function violationOutput(
  dispatch: ModelDispatch,
  response: ModelResponse,
  code: ModelContractViolationCode,
  message: string,
  observed: {
    readonly supplementalObservedBytes: number;
    readonly omittedBlockCount: number;
  },
): ModelEffectOutputV2 {
  const toolCalls = response.blocks
    .filter(
      (block): block is Exclude<ModelResponseBlock, { type: "text" }> =>
        block.type !== "text",
    )
    .slice(0, MAX_MODEL_TOOL_CALL_SUMMARIES)
    .map(toolCallSummary);
  const text = response.blocks
    .filter(
      (block): block is Extract<ModelResponseBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
  const supplementalTextBytes = Math.max(
    observed.supplementalObservedBytes,
    byteLength(text),
  );
  const evidence = {
    toolCalls,
    omittedBlockCount: Math.max(
      observed.omittedBlockCount,
      response.blocks.filter((block) => block.type !== "text").length -
        MAX_MODEL_TOOL_CALL_SUMMARIES,
    ),
    ...(supplementalTextBytes
      ? {
          supplementalTextDigest: canonicalJsonDigest(
            supplementalTextBytes === byteLength(text) ? text : `${text}\0truncated`,
          ),
        }
      : {}),
    supplementalTextBytes,
  };
  const violation: ModelContractViolation = {
    code,
    message,
    termination: response.termination,
    evidence,
    evidenceDigest: canonicalJsonDigest(evidence),
  };
  return createModelEffectOutputV2({
    response,
    result: { kind: "contract-violation", violation },
    responseContract: dispatch.responseContract,
    responseCapability: dispatch.responseCapability,
    configuredProvider: dispatch.configuration.provider,
  });
}

function toolCallSummary(
  block: Exclude<ModelResponseBlock, { type: "text" }>,
): ModelToolCallSummary {
  return block.type === "tool-call"
    ? {
        callId: block.callId,
        name: block.name,
        inputDigest: block.inputDigest,
        inputBytes: block.inputBytes,
      }
    : {
        ...(block.callId === undefined ? {} : { callId: block.callId }),
        ...(block.name === undefined ? {} : { name: block.name }),
        ...(block.inputDigest === undefined
          ? {}
          : { inputDigest: block.inputDigest }),
        inputBytes: block.inputBytes,
        invalidCode: block.code,
      };
}

function callBlock(call: CallObservation): Exclude<
  ModelResponseBlock,
  { type: "text" }
> {
  if (
    call.completed &&
    !call.invalid &&
    call.input !== undefined &&
    call.safeId &&
    call.safeName
  ) {
    return {
      type: "tool-call",
      callId: call.safeId,
      name: call.safeName,
      inputDigest: canonicalJsonDigest(call.input),
      inputBytes: canonicalJsonByteLength(call.input),
    };
  }
  const digestSource = scrubText(call.rawInput);
  return {
    type: "invalid-tool-call",
    ...(call.safeId ? { callId: call.safeId } : {}),
    ...(call.safeName ? { name: call.safeName } : {}),
    ...(digestSource ? { inputDigest: canonicalJsonDigest(digestSource) } : {}),
    inputBytes: call.rawInputBytes,
    code: call.invalid ?? "truncated-arguments",
  };
}

function completedViolationCode(
  termination: CompleteModelResponse["termination"]["kind"],
  calls: readonly CallObservation[],
): ModelContractViolationCode {
  if (termination === "content-filter" || termination === "refusal") {
    return "provider-refusal";
  }
  if (calls.length > 1) return "multiple-tool-calls";
  if (calls.some((call) => !call.safeName)) return "incomplete-provider-response";
  if (calls.some((call) => call.invalid === "oversized-arguments")) {
    return "oversized-tool-input";
  }
  if (
    termination === "output-limit" &&
    calls.some((call) => call.invalid === "truncated-arguments")
  ) {
    return "truncated-tool-input";
  }
  if (calls.some((call) => call.invalid)) return "invalid-tool-input";
  if (termination === "text-stop" && calls.length === 0) {
    return "required-tool-missing";
  }
  return "incomplete-provider-response";
}

function normalizeTermination(
  value: string,
): CompleteModelResponse["termination"]["kind"] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "stop") return "text-stop";
  if (normalized === "tool-calls") return "tool-calls";
  if (normalized === "length") return "output-limit";
  if (normalized === "content-filter") return "content-filter";
  if (normalized === "refusal") return "refusal";
  return "other";
}

function normalizeUsage(value: unknown): Usage {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    inputTokens: finiteCount(record.inputTokens),
    outputTokens: finiteCount(record.outputTokens),
    costUsd: 0,
  };
}

function normalizeWarning(item: unknown): ModelWarning {
  const record = item && typeof item === "object" && !Array.isArray(item)
    ? item as Record<string, unknown>
    : {};
  const type = typeof record.type === "string" ? record.type : "";
  const feature = typeof record.feature === "string" ? record.feature : "";
  const details = typeof record.details === "string"
    ? record.details
    : typeof record.message === "string"
      ? record.message
      : "";
  const message = boundedScrubbedText(
    [feature, details].filter(Boolean).join(": ") || type || "Provider warning",
    1_024,
  );
  return {
    kind: /unsupported|ignored/i.test(`${type} ${message}`)
      ? "unsupported"
      : /compatib|coerc|adjust/i.test(`${type} ${message}`)
        ? "coerced"
        : "provider",
    message,
  };
}

function isUnsupportedContractWarning(warning: ModelWarning): boolean {
  return warning.kind === "unsupported" &&
    responseContractUnsupportedText(warning.message);
}

function responseContractUnsupportedText(value: string): boolean {
  return /(?:tool|function|strict|parallel).{0,100}(?:unsupported|not supported|ignored|unavailable|invalid)|(?:unsupported|not supported|ignored|unavailable).{0,100}(?:tool|function|strict|parallel)|tool[_ -]?choice|required tool/i
    .test(value);
}

function classifyStreamFailure(
  error: unknown,
  provider: string,
  model: string,
  observedPart: boolean,
): Error {
  if (responseContractUnsupportedText(errorSearchText(error))) {
    return new ModelProviderResponseFailureError(
      "unsupported-response-contract",
      provider,
      model,
      "Model provider does not support the retained response contract",
    );
  }
  if (isContextOverflow(error)) return error as Error;
  const status = errorStatus(error);
  const transportFailure = error instanceof TypeError ||
    /\b(?:fetch|network|socket|connection|dns|econn)\b/i.test(
      errorSearchText(error),
    );
  const code: ModelEffectFailureCode = status !== undefined
    ? "provider-request-failed"
    : transportFailure
      ? "transport-failed"
      : observedPart
        ? "stream-failed"
        : "transport-failed";
  return new ModelProviderResponseFailureError(
    code,
    provider,
    model,
    code === "provider-request-failed"
      ? "Model provider request failed"
      : code === "transport-failed"
        ? "Model provider transport failed"
        : "Model provider stream failed",
  );
}

function unsupportedContractFailure(
  dispatch: ModelDispatch,
): ModelProviderResponseFailureError {
  return new ModelProviderResponseFailureError(
    "unsupported-response-contract",
    dispatch.configuration.provider,
    dispatch.configuration.model,
    "Model provider does not support the retained response contract",
  );
}

function errorSearchText(error: unknown, depth = 0): string {
  if (depth > 3 || error === null || error === undefined) return "";
  if (typeof error === "string") return error.slice(0, 8_192);
  if (typeof error !== "object") return String(error);
  const record = error as Record<string, unknown>;
  return [
    record.name,
    record.message,
    record.code,
    record.responseBody,
    record.data,
    record.cause,
  ].map((item) => errorSearchText(item, depth + 1)).join(" ").slice(0, 16_384);
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  return typeof record.statusCode === "number"
    ? record.statusCode
    : typeof record.status === "number"
      ? record.status
      : undefined;
}

function isContextOverflow(error: unknown): boolean {
  const status = errorStatus(error);
  return [400, 413, 422].includes(status ?? -1) &&
    /context(?:_| )?(?:length|window)|maximum context|prompt (?:is )?too long|too many input tokens/i
      .test(errorSearchText(error));
}

function requiredContract(
  dispatch: ModelDispatch,
): RequiredToolSetModelResponseContract {
  if (dispatch.responseContract.kind !== "required-tool-set") {
    throw new Error("Formal response execution requires a required-tool-set contract");
  }
  return dispatch.responseContract;
}

function requiredCapability(dispatch: ModelDispatch) {
  if (dispatch.responseCapability.kind !== "required-tool-set") {
    throw new Error("Formal response execution requires required-tool-set capability");
  }
  return dispatch.responseCapability.capability;
}

function toolSubmissionFromAction(
  action: AgentAction,
): { readonly name: string; readonly input: JsonValue } | undefined {
  if (action.type === "typescript") {
    return { name: "bun_console", input: { source: action.code } };
  }
  if (action.type === "final") {
    return {
      name: "finish",
      input: { outcome: { message: action.content } },
    };
  }
  if (action.type === "blocked") {
    return {
      name: "finish",
      input: { outcome: { status: "blocked", message: action.reason } },
    };
  }
  if (action.type === "failed") {
    return {
      name: "finish",
      input: { outcome: { status: "failed", message: action.error } },
    };
  }
  return undefined;
}

function guardViolationMessage(code: ModelAdapterGuardCode): string {
  switch (code) {
    case "multiple-tool-calls":
      return "The model started more than one tool call.";
    case "unexpected-tool":
      return "The model selected a tool outside the retained response contract.";
    case "oversized-tool-input":
      return "The model tool input exceeded the retained byte limit.";
    case "oversized-provider-response":
      return "The model response exceeded a retained adapter bound.";
  }
}

function completeViolationMessage(code: ModelContractViolationCode): string {
  switch (code) {
    case "required-tool-missing":
      return "The model completed without calling a required tool.";
    case "multiple-tool-calls":
      return "The model returned more than one tool call.";
    case "unexpected-tool":
      return "The model returned a tool outside the retained response contract.";
    case "invalid-tool-input":
      return "The model returned invalid tool input.";
    case "truncated-tool-input":
      return "The provider output limit truncated the model tool input.";
    case "oversized-tool-input":
      return "The model tool input exceeded the retained byte limit.";
    case "oversized-provider-response":
      return "The model response exceeded a retained adapter bound.";
    case "incomplete-provider-response":
      return "The provider completed without one compatible formal tool call.";
    case "provider-refusal":
      return "The provider refused or filtered the formal response.";
  }
}

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function boundedScrubbedText(value: string, maximum: number): string {
  let bytes = encoder.encode(scrubText(value));
  if (bytes.byteLength <= maximum) return new TextDecoder().decode(bytes);
  bytes = bytes.slice(0, maximum);
  let bounded = new TextDecoder().decode(bytes);
  while (byteLength(bounded) > maximum) bounded = bounded.slice(0, -1);
  return bounded;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/**
 * Custom in-process providers can hand the adapter arbitrary values, so this
 * uses the domain assertion, whose seen-set terminates on cyclic references
 * and whose prototype check rejects non-plain objects such as Date.
 */
function isJsonValue(value: unknown): value is JsonValue {
  try {
    assertJsonValue(value);
    return true;
  } catch {
    return false;
  }
}

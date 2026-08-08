# Formal model tool contracts plan

**Status:** Ready for implementation  
**Date:** August 7, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Prerequisite:** [Reasoning effort and model capabilities](./2026-08-07-reasoning-effort-and-model-capabilities-plan.md) must be complete and merged before this plan begins
**Related plan:** [Follow-up implementation plan](./2026-08-06-prime-agent-typescript-turso-rewrite-follow-up-plan.md)

## Summary

Agencity's ordinary autonomous loop currently asks a model to serialize one `agencity.agent-action` JSON object into assistant text. The runtime concatenates the returned text, calls `JSON.parse`, validates the resulting object, and only then executes an admitted TypeScript action. This preserves a strict execution boundary, but it uses free-form assistant text as a transport for a protocol that model providers already support as formal tool calling.

This plan replaces that transport with a small fixed provider-native tool set on every new autonomous `AgentRun` model call:

```text
bun_console
finish
```

The model must call exactly one of these tools on every step. `bun_console` proposes one multiline Bun notebook cell and exposes the existing SDK for shell, files, SQL, models, subagents, memory, skills, artifacts, and other programmatic work. `finish` ends model-directed work. Omitting its status means success; `blocked` and `failed` retain distinct terminal outcomes. If missing user information prevents progress, a blocked `finish` asks the necessary question in its final message.

The provider's formal tool-call channel and selected tool name, not assistant prose, identify the action. Agencity still validates and durably commits the submission before executing or applying anything. Assistant text is never searched for JSON, JavaScript, or an implied action.

The same provider-neutral response-contract mechanism also replaces the remaining structured model response that is parsed from text: trajectory refinement decisions. Text remains a valid model result for operations whose result is actually text, such as diagnostic turns and model-summary compaction. The rule is:

> If Agencity consumes a model result as structured data, the request declares a bounded formal provider tool set and the response must contain exactly one permitted tool call. Agencity never asks for structured JSON in assistant text.

There is no prompt-JSON fallback for new calls. A provider or model that cannot use the required formal tool contract is unavailable for that structured operation.

This plan begins from the completed reasoning-effort and model-capabilities architecture. The implementation baseline therefore already has one shared Vercel AI SDK adapter core, `vercel`, `openai`, and `anthropic` transport factories, canonical gateway-catalog model IDs, the cached gateway model catalog, normalized top-level reasoning dispatch, and an immutable version-1 `ModelDispatch` copied into model-call and outbox records. Formal tool contracts extend those mechanisms. They do not add provider-native HTTP adapters, a second model catalog, a dedicated gateway wire surface, or another model-effect admission path.

## Motivation

### The current transport is not the intended programming model

Agencity's product architecture defines one general generated-execution surface: the Bun TypeScript console. The current implementation preserves that surface at execution time, but the provider-facing request does not expose a formal console/action tool. `AgentRunService` instead:

1. inserts `AGENT_ACTION_POLICY` and `AGENT_ACTION_JSON_SCHEMA` into the system prompt;
2. asks the model to return one JSON object with no surrounding prose;
3. stores the provider's text as `ModelOutputChunk`;
4. parses the concatenated text with `parseAgentAction`;
5. commits `AgentRunActionCommitted` or `AgentRunActionRejected`.

The shared `AiSdkModelProvider` sends messages, sampling configuration, and the retained reasoning decision through `generateText` or `streamText`. Its shared options builder does not yet compile a response contract into AI SDK `tools`, `toolChoice`, per-tool `strict`, or parallel-call controls, and its result normalization still assumes text. The `vercel`, `openai`, and `anthropic` factories differ only in credential, endpoint, model construction, and native-ID derivation; this plan must preserve that boundary.

The `tools`, `sdk`, `sql`, `state`, `artifacts`, `rlm`, and related names described in the model prompt are Bun console bindings. They are not model-provider tools. The two layers are therefore:

- a free-form textual JSON action envelope at the provider boundary; and
- the typed TypeScript SDK after the envelope is accepted.

This plan makes the first layer formal while preserving the second.

### Observed failure pattern

A real Vercel AI Gateway session using `openai/gpt-5.6-sol` exposed the cost of prompt-only framing:

- 33 completed model calls produced 24 committed actions and 9 rejected actions;
- 8 rejected responses contained a valid action JSON object preceded by narration such as “I’ll inspect…”;
- 1 rejected response began with the action object but ended at the provider's 4,096-token output limit;
- one 11-call run spent 5 calls on rejected action formatting at ordinals 1, 3, 5, 7, and 9;
- the bounded correction step usually returned the same action without narration, creating an alternating reject/correct pattern.

No rejected code executed, so the safety boundary worked. The frequency is nevertheless a product defect: calls, latency, budget, and run reliability were spent repairing a transport format that the provider API can represent directly.

## Goals

- Give every new autonomous model step a fixed, minimal set of formal provider-native tools and require exactly one call.
- Make `bun_console` the only executable provider tool.
- Describe the actual execution flavor: multiline JavaScript or TypeScript syntax transpiled for Bun and evaluated as an async notebook cell.
- Keep shell, files, SQL, state, artifacts, subagents, recursive calls, skills, memory, and refinement inside the Bun console SDK.
- Make successful completion a distinct `finish` tool rather than one branch of a generic action envelope.
- Use blocked `finish` messages for questions that prevent further progress.
- Fold model-declared blocked and failed outcomes into uncommon explicit variants of `finish`.
- Require one-of-tool-set choice and exactly-one-call behavior for every structured operation.
- Use strict provider-side schema enforcement where supported, followed by Agencity domain validation in every case.
- Treat the provider tool-call channel as authoritative and all accompanying text as non-authoritative.
- Commit the model request contract, normalized tool submission, action, usage, and provenance before executing the action.
- Preserve current outbox, budget, cancellation, context-window, unknown-effect, gate, and cell-recovery semantics.
- Remove prompt instructions that ask for raw action JSON.
- Remove all new runtime dependence on parsing structured model data from assistant text.
- Migrate trajectory refinement from textual JSON to a formal typed submission.
- Preserve retained version-1 histories and safely recover model effects committed before the change.
- Make unsupported tool calling visible instead of silently falling back to text.
- Extend the existing shared AI SDK options builder and response normalizer once for gateway and direct transports.
- Preserve the exact reasoning dispatch, endpoint identity, warning, usage, cost, error, and recovery semantics delivered by the predecessor plan.

## Non-goals

- Exposing shell, file, SQL, browser, model, subagent, memory, skill, or artifact operations as separate provider tools.
- Letting the provider execute the submitted action.
- Treating provider schema enforcement as sufficient authorization or validation.
- Executing partial streamed tool arguments.
- Parsing JavaScript, TypeScript, or JSON from assistant narration as a fallback.
- Automatically retrying an unknown model effect.
- Changing the trusted-local authority of generated TypeScript.
- Adding model-facing clarification, permission, approval, or input-request tools.
- Requiring a formal tool for genuinely textual model operations.
- Adding provider-hosted code execution.
- Introducing browser execution.
- Reintroducing hand-written OpenAI, Anthropic, or gateway request/stream parsers.
- Selecting an OpenAI-compatible versus Anthropic-compatible wire surface for gateway execution.
- Adding a second model catalog, a hand-maintained per-model tool-support table, or automatic transport fallback.

## Terms

- **Provider tool:** An AI SDK function-tool declaration that the active transport sends through its provider's formal tool-call channel.
- **Agent tool set:** The two provider tools `bun_console` and `finish` supplied together to an autonomous model step.
- **Bun console:** A disposable async notebook cell that accepts normal JavaScript plus TypeScript syntax and exposes the injected Agencity SDK.
- **Console SDK:** The APIs available inside an admitted Bun console cell. These are not provider tools.
- **Response contract:** A durable declaration of whether a model call expects text or exactly one call from one bounded provider-tool set.
- **Tool submission:** A normalized provider tool call containing its provider call ID, name, structured input, and attributable transport metadata.
- **AI SDK adapter core:** The single `AiSdkModelProvider` request and response implementation shared by the gateway, direct OpenAI, and direct Anthropic factories.
- **Transport:** The durable `ModelConfiguration.provider` value (`vercel`, `openai`, or `anthropic` for product execution), not a provider-native HTTP surface.
- **Supplemental text:** Text blocks returned beside a formal tool call. They are never an action or a committed assistant answer.
- **Contract violation:** A completed provider response that does not satisfy the requested response contract, such as no tool call, multiple calls, the wrong tool, invalid input, or truncated arguments.
- **Legacy text action:** An action encoded as assistant JSON text by a model effect committed before this feature.

## Chosen architecture

### Two provider tools, one executable surface

Every new `AgentRun` model request supplies the same two provider tools:

```text
bun_console
finish
```

The provider is required to return exactly one call from this set and parallel calls are disabled. The names make the state transition visible before input parsing:

- `bun_console` proposes one executable Bun cell and continues the run;
- `finish` ends model-directed work with success, blocked, or failed status.

The supervisor:

1. receives the provider's formal tool-call block;
2. normalizes it inside the provider adapter;
3. verifies exactly one allowed tool and validates that tool's input;
4. converts the tool name and input into the existing canonical `AgentAction`;
5. commits the model completion and canonical action;
6. only then applies the action through existing runtime services.

Only `bun_console` is executable. Shell, files, SQL, model calls, agents, recursive calls, skills, memory, state, artifacts, and refinement remain SDK operations inside its source. `finish` is a typed supervisor control signal, not another execution surface.

### No inline provider-managed tool loop

The two tools are one-way submission boundaries, not a conventional provider-managed tool loop. Agencity does not execute a submitted cell immediately from the network callback, append a provider `tool_result`, and ask the same in-flight interaction to continue.

Each model call ends after one tool submission. Agencity commits and applies the submission through durable action, cell, goal, and outbox boundaries. The resulting canonical observations enter a later model call. This preserves one recoverable model decision per run step and prevents an attached provider conversation from becoming the owner of agent state.

### `finish` is the end-of-run signal

`finish` is separate because successful completion is special:

- its message is the proposed user-facing final response;
- required completion gates run before success is accepted;
- a failed gate returns an attributable observation and the run continues for repair;
- only a passed successful completion commits the success message and marks the run succeeded.

The common call omits `status` and means success. Rare blocked and failed variants include an explicit status:

- `blocked` means a concrete external requirement prevents further progress;
- `failed` means reasonable recovery attempts ended without a safe completion.

For blocked or failed, the supervisor commits the exact submitted message as the final assistant message together with the non-success run status. No success is claimed and completion gates do not run. Runtime-originated `cancelled`, `budget_exceeded`, and `unknown` outcomes remain separate because the model cannot safely declare them.

If required user information cannot be inferred and no more useful execution is possible, the model uses `finish` with `status: "blocked"` and asks the question in `message`. The question appears as the final assistant response and the run ends as blocked. A later user response is an ordinary new instruction on the same durable branch, not a reply to a special pending-input protocol.

Existing goal precedence remains explicit:

- a successful `finish` checks every required gate;
- a failed gate commits one repair observation and continues the run;
- an unknown gate terminates the run as `unknown`;
- a later `finish` with `status: "failed"` while the latest required gate remains failed terminates as `blocked` with the attributable gate summary, matching the existing goal-repair rule;
- otherwise model-declared `blocked` and `failed` statuses retain their selected outcome.

### Why the executable tool is `bun_console`

The provider-facing tool is not named `typescript` or `es2026`:

- ordinary JavaScript without type annotations is expected and valid;
- Bun's TypeScript loader also accepts TypeScript syntax;
- the source targets the configured Bun runtime rather than one exact ECMAScript edition;
- the cell is an async notebook-function body, not an ES module or arbitrary Bun process.

`bun_console` identifies the actual environment. Its `source`:

- may be multiline and must not use Markdown fences;
- is transpiled with Bun's TypeScript loader and target;
- runs inside an async function, so top-level `await` is supported;
- returns its last top-level expression as the bounded observation unless a cell-level `return` is present;
- observes `null` when it ends in a declaration;
- cannot rely on lexical bindings, module instances, closures, handles, or `globalThis` changes after the committed cell boundary;
- uses `state` or artifacts for values needed by later cells.

The canonical action may retain the internal type name `typescript` for version-1 event compatibility. That internal name is not shown to new models.

## Agent tool interface

### Provider inputs

```ts
interface BunConsoleInput {
  source: string;
}

type FinishInput = {
  outcome:
    | {
        message: string;
      }
    | {
        status: "blocked" | "failed";
        message: string;
      };
};
```

The nested `outcome` property permits a strict portable union. OpenAI requires each strict tool's root to be an object rather than a root-level `anyOf`, and every property in each strict object variant must be required. The successful `finish` branch therefore genuinely omits `status`; the model does not need to emit `status: null` or repeat `status: "success"` on the common path.

Every object sets `additionalProperties: false`. The provider schemas omit string-length keywords that are not portable across strict-schema subsets. Agencity still enforces non-empty values, known variants, unknown-field rejection, and byte limits after provider validation.

### Tool definitions

The immutable built-in definitions are conceptually:

```ts
const AGENT_TOOL_SET = [
  {
    name: "bun_console",
    description:
      "Propose one durable Agencity Bun console cell and continue the run. " +
      "Pass multiline JavaScript or TypeScript source without Markdown fences. " +
      "Use the injected SDK for every repository, shell, file, SQL, model, " +
      "agent, memory, skill, state, and artifact operation. The cell is an " +
      "async notebook body: top-level await is supported and the final " +
      "expression or explicit return becomes its bounded observation.",
    inputSchema: BUN_CONSOLE_INPUT_SCHEMA,
  },
  {
    name: "finish",
    description:
      "End model-directed work. Omit status for normal successful completion, " +
      "and provide the final user-facing message. Use blocked only when a " +
      "specific external requirement or missing user information prevents " +
      "progress; ask any necessary question in the message. Use failed only " +
      "after reasonable recovery attempts have failed. Successful completion " +
      "remains subject to required Agencity completion gates.",
    inputSchema: FINISH_INPUT_SCHEMA,
  },
] as const;
```

Each name, description, schema, schema digest, tool-set order, action protocol, and version is immutable contract meaning. The shared adapter compiles the retained ordered definitions into AI SDK `tool(...)` values with no `execute` callback: provider submission ends the model effect, and Agencity applies the accepted action only after durable commit. It passes `strict: true` only when the retained contract says `provider-strict`; otherwise strictness is omitted and the same Agencity schema and domain validation remain authoritative.

### Canonical conversion and bounds

Extract a shared object validator from the current text parser:

```ts
function validateAgentActionValue(
  value: unknown,
  options: { encodedBytes: number },
): AgentAction;
```

`agentActionFromToolSubmission` performs the pure compatibility conversion:

```ts
type AgentToolSubmission =
  | { name: "bun_console"; input: BunConsoleInput }
  | { name: "finish"; input: FinishInput };

function agentActionFromToolSubmission(
  submission: AgentToolSubmission,
): AgentAction {
  if (submission.name === "bun_console") {
    return action({ type: "typescript", code: submission.input.source });
  }
  if (
    "status" in submission.input.outcome &&
    submission.input.outcome.status === "blocked"
  ) {
    return action({
      type: "blocked",
      reason: submission.input.outcome.message,
    });
  }
  if (
    "status" in submission.input.outcome &&
    submission.input.outcome.status === "failed"
  ) {
    return action({
      type: "failed",
      error: submission.input.outcome.message,
    });
  }
  return action({
    type: "final",
    content: submission.input.outcome.message,
  });
}
```

The existing version-1 `clarification` and `permission` action variants remain readable only for retained histories and already-committed legacy text effects. No new formal response contract can generate them, and new autonomous runs never enter `waiting_for_user`.

Both compatibility paths use the same domain validator:

- `parseAgentAction(raw)` measures the exact legacy UTF-8 response bytes, parses JSON, and delegates to the object validator;
- formal submission bounds the provider's official argument encoding, validates the selected tool input, converts it to `AgentAction`, measures the UTF-8 stable canonical-JSON encoding of that canonical action, and delegates to the object validator.

The shared adapter core rejects an argument stream above `MAX_AGENT_ACTION_BYTES` before unbounded accumulation. Required-tool-set calls always use `streamText` internally, even when the caller does not request user-visible streaming, so the core can count AI SDK `tool-input-delta` bytes and abort an oversized input before retaining it. The shared validator separately enforces the existing 256 KiB bound on the converted canonical action, so transport differences cannot bypass or accidentally redefine the domain limit. The model does not provide `protocol` or `version`; the retained tool-set contract identifies `agencity.agent-action` version 1, and the supervisor injects those host-owned fields.

## Provider-neutral model contract

### Request contract

Replace the implicit assumption that every model effect returns text with an explicit response contract:

```ts
type ModelResponseContract =
  | {
      kind: "text";
      version: 1;
    }
  | {
      kind: "required-tool-set";
      version: 1;
      contractId: string;
      tools: readonly {
        name: string;
        description: string;
        inputSchema: JsonValue;
        schemaDigest: `sha256:${string}`;
      }[];
      schemaEnforcement: "provider-strict" | "runtime-validated";
      selection: "exactly-one-of";
      supplementalText: "diagnostic-only";
      contractDigest: `sha256:${string}`;
    };
```

`schemaDigest` is SHA-256 over the UTF-8 stable canonical-JSON encoding of `inputSchema`. `contractDigest` is SHA-256 over the same canonical encoding of every response-contract field except `contractDigest` itself. The canonical encoder sorts object keys, preserves array order and JSON scalar values, and rejects non-`JsonValue` input. Digest fixtures pin both encodings.

The predecessor plan's immutable `ModelDispatch` version 1 contains model configuration, reasoning dispatch, and execution-endpoint identity. This plan evolves that envelope instead of adding an independent sibling field that could disagree:

```ts
interface ModelDispatchV2 {
  readonly configuration: ModelConfiguration;
  readonly reasoning: ReasoningDispatch;
  readonly responseContract: ModelResponseContract;
  readonly responseCapability:
    | { readonly kind: "text" }
    | {
        readonly kind: "required-tool-set";
        readonly capability: RequiredToolSetCapability;
      };
  readonly executionEndpointId?: string;
  readonly dispatchVersion: "agencity.model-dispatch.v2";
}

type ModelDispatch = ModelDispatchV1 | ModelDispatchV2;
```

Retained `agencity.model-dispatch.v1` values keep their exact predecessor meaning: the provider expects text, and recovery does not synthesize a new contract. Every newly admitted model call uses version 2, including genuinely textual operations, so new behavior is never inferred from an absent field. A required-tool-set contract can appear only in version 2.

The complete version-2 dispatch is committed in `ModelCallRequested.modelDispatch` and copied byte-for-byte into `EffectRequested.input`. Existing `ModelCallRequested.provider`/`model` fields and any legacy effect-input configuration remain compatibility mirrors and must equal `modelDispatch.configuration` exactly. New effect inputs have one authoritative `modelDispatch`; the executor reads model, reasoning, endpoint, and response behavior only from it. Any mirror mismatch fails relation validation before network access and conflicts under idempotency.

Provider execution uses only the retained effect input. Recovery never reconstructs a contract from current source constants or newer catalog data. `schemaEnforcement` and response-capability provenance are part of dispatch and idempotency agreement: the adapter sets AI SDK tool `strict: true` only for `provider-strict`; `runtime-validated` uses the provider's formal call channel without claiming provider schema enforcement.

For version 2, `text` is explicit rather than implied. Diagnostic `ModelLoop` turns and model-summary compaction use `text`. Agent runs use the two-tool `required-tool-set`; internal refinement uses a one-tool `required-tool-set`.

### Contract authority

Arbitrary tool definitions are not a public input. `StartRecursiveModelInput`, `rlm.start`, `sdk.agents`, HTTP routes, public protocol clients, model-backed goal definitions, and console `tools.request` do not gain a `responseContract` field.

Supervisor-owned structured operations select from a sealed built-in registry:

```ts
type BuiltInStructuredContractId =
  | "agencity.agent-tools.v1"
  | "agencity.refinement-review.v1";
```

The registry is append-only by contract ID and version. Event and reducer validation accepts a structured contract only when every retained name, description, schema, schema digest, tool order, selection rule, and supplemental-text rule exactly matches the historical template for that ID/version. `schemaEnforcement` is a resolved dispatch property: `provider-strict` requires matching strict capability provenance, while `runtime-validated` is used for runtime-validated or admitted unknown capability. Validation recomputes the final contract digest over the exact template plus resolved mode. Released templates are never edited or removed; an unknown future contract version is unavailable or quarantined rather than executed. Recovery uses the exact accepted retained contract and never substitutes the registry's latest version.

Recursive work retains the response side of future dispatch before child launch:

```ts
interface RecursiveResponseAdmission {
  readonly responseContract: ModelResponseContract;
  readonly responseCapability: ModelDispatchV2["responseCapability"];
}
```

The registry resolves an ID and the transport-keyed capability only before the owning durable request is committed. `RecursiveModelStarted.responseAdmission` stores that complete seed, projects it through `RecursiveModelRecord`/`RecursiveModelState`, and includes it in exact idempotency comparison. Internal structured work stores the sealed structured contract and resolved capability; admitted public recursive calls store the built-in text contract and `{ kind: "text" }`. Retained starts without this field preserve legacy text behavior. `RecursiveModelService` exposes an internal supervisor method for starting structured work; generated cells and public clients cannot call it or define arbitrary provider tools.

Recovery of a recursive child before its first `ModelCallRequested` reads the exact response admission from `RecursiveModelStarted`. Dispatch resolution combines that seed with the retained child model configuration, reasoning dispatch, and endpoint identity; it does not re-resolve the response contract or capability. For structured work, the currently registered transport capability ID must still match the retained seed or admission fails typed-unavailable. Recovery never consults a newer registry definition or silently adopts a newer adapter capability.

Extend the predecessor's centralized model-dispatch resolution with one supervisor-owned `ModelEffectAdmissionService` exposing two code paths:

- `requestText(...)` resolves and commits a version-2 dispatch containing the immutable built-in text contract;
- `requestBuiltInStructured(contractId, ...)` resolves and commits a version-2 dispatch containing one sealed built-in structured contract.

Both paths reuse the committed branch configuration, catalog-backed reasoning resolver, execution-endpoint identity, and call/effect relation checks already delivered by the predecessor. They do not create a second model-effect admission system. Ordinary `AgentRun` and internal refinement use the structured path. Diagnostic turns, admitted public recursive calls, model-summary compaction, and current model-backed gates use the text path. Current gates treat model output as effect evidence and do not parse it as an agent action.

The predecessor's reservation of the generic `model` executor remains in force: console `tools.request("model", ...)` is rejected before `EffectRequested`. Generated code reaches text models only through admitted `rlm` and child-session services. Console RPC and goal-effect admission reject reserved model dispatch fields, including `responseContract`, instead of forwarding arbitrary model input directly to the outbox. If a future gate needs structured model data, it must add a reviewed sealed built-in contract rather than accepting a caller-defined schema.

Model-summary compaction has no `ModelCallRequested` event, but the predecessor already pins a complete dispatch in `ContextCompactionRequested.modelDispatch`. New compactions pin one version-2 text dispatch there, and every hierarchy chunk copies it into `EffectRequested.input`. A retained compaction with a version-1 dispatch continues under its legacy text semantics.

### Normalized provider response

Providers normalize their native response into content blocks:

```ts
interface ModelResponse {
  readonly blocks: readonly ModelResponseBlock[];
  readonly termination: {
    readonly kind:
      | "text-stop"
      | "tool-calls"
      | "output-limit"
      | "content-filter"
      | "refusal"
      | "other";
    readonly rawReason: string;
  };
  readonly usage: Usage;
  readonly warnings: readonly ModelWarning[];
  readonly transport: {
    readonly provider: string;
    readonly adapter: string;
  };
}

type ModelResponseBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: "invalid-tool-call";
      readonly callId?: string;
      readonly name?: string;
      readonly code:
        | "malformed-arguments"
        | "truncated-arguments"
        | "oversized-arguments";
      readonly boundedArguments?: string;
    };
```

The shared adapter consumes only documented AI SDK results and `fullStream` parts. The pinned provider packages own native HTTP payloads, SSE framing, provider argument decoding, and finish-reason mapping. Agencity consumes AI SDK `text`, `tool-input-start`, `tool-input-delta`, `tool-call`, `finish`, `error`, and `abort` information; it never searches text for an action and never parses OpenAI or Anthropic wire envelopes itself.

The shared adapter normalizes the AI SDK's completed finish reason to `termination.kind`. A required-tool-set response is never accepted unless the completed SDK result reports tool-call termination and exactly one validated `tool-call` part. Output limits, content filters, refusals, SDK errors, aborts, interrupted streams, missing terminal completion, and other stop reasons follow the closed terminal classification below; none can commit an action accidentally.

Formal responses use explicit total bounds:

```ts
const MAX_MODEL_RESPONSE_BLOCKS = 16;
const MAX_MODEL_TOOL_CALL_SUMMARIES = 4;
const MAX_MODEL_TOOL_CALL_ID_BYTES = 1_024;
const MAX_MODEL_TERMINATION_REASON_BYTES = 256;
const MAX_MODEL_SUPPLEMENTAL_TEXT_BYTES = 16 * 1_024;
const MAX_MODEL_CONTRACT_EVIDENCE_BYTES = 64 * 1_024;
const MAX_MODEL_FORMAL_RESPONSE_BYTES =
  MAX_AGENT_ACTION_BYTES + MAX_MODEL_CONTRACT_EVIDENCE_BYTES;
```

The adapter enforces these limits while consuming `streamText.fullStream`. Once a second call, unknown tool name, argument overflow, metadata overflow, or block overflow proves a violation, it aborts the SDK request, stops accumulating argument bodies, and retains only scrubbed bounded summaries. Tool names must match retained bounded names; call IDs and raw stop reasons are scrubbed and truncated; supplemental text retains bounded content or a digest plus byte count. The complete normalized submission, metadata, and formal event encoding must fit `MAX_MODEL_FORMAL_RESPONSE_BYTES`. These transport limits do not replace the separate 256 KiB canonical action limit.

The model executor validates the normalized blocks against the retained response contract:

- exactly one valid tool call must be present;
- its name must match one retained tool definition;
- its input must satisfy the selected tool's schema and the domain validator;
- termination must be the provider-normalized complete tool-call state;
- zero, multiple, unknown, invalid, or truncated calls are contract violations;
- supplemental text is retained only as bounded diagnostic provenance and is never parsed, appended as a final answer, or executed.

### Contract violations

Use stable typed codes:

```ts
type ModelContractViolationCode =
  | "required-tool-missing"
  | "multiple-tool-calls"
  | "unexpected-tool"
  | "invalid-tool-input"
  | "truncated-tool-input"
  | "oversized-tool-input"
  | "oversized-provider-response"
  | "incomplete-provider-response"
  | "provider-refusal";
```

The retained violation is itself bounded and replayable:

```ts
type InvalidToolCallCode =
  | "malformed-arguments"
  | "truncated-arguments"
  | "oversized-arguments";

interface ModelContractViolation {
  readonly code: ModelContractViolationCode;
  readonly message: string;
  readonly termination: ModelResponse["termination"];
  readonly evidence: {
    readonly toolCalls: readonly {
      readonly callId?: string;
      readonly name?: string;
      readonly inputDigest?: `sha256:${string}`;
      readonly invalidCode?: InvalidToolCallCode;
    }[];
    readonly omittedBlockCount: number;
    readonly supplementalTextDigest?: `sha256:${string}`;
    readonly supplementalTextBytes: number;
  };
  readonly evidenceDigest: `sha256:${string}`;
}
```

Evidence includes at most `MAX_MODEL_TOOL_CALL_SUMMARIES` scrubbed summaries and never stores malformed or rejected raw argument bodies. `message`, termination metadata, evidence, and their stable canonical encoding must fit `MAX_MODEL_CONTRACT_EVIDENCE_BYTES`.

Failures that prevent a completed formal response use a separate durable classification:

```ts
type ModelEffectFailureCode =
  | "unsupported-response-contract"
  | "execution-endpoint-drift"
  | "provider-context-window-overflow"
  | "provider-request-failed"
  | "transport-failed"
  | "stream-failed"
  | "incomplete-provider-response";
```

`EffectOutcomeRecorded` gains optional bounded `modelFailure: { code: ModelEffectFailureCode }`, valid only for failed model effects. `ModelCallTerminated` gains optional `failureCode`; it is required for a failed version-2 call and must equal the effect's retained model-failure code. Retained legacy failures, cancellations, and unknown outcomes do not synthesize one.

Terminal classification is deterministic:

- a known unsupported response contract fails admission with a typed unavailable error before `ModelCallRequested`;
- a retained execution endpoint that no longer matches the configured transport fails before network access with `execution-endpoint-drift`;
- an SDK/API rejection specifically identifying unsupported submitted tools records failed effect code `unsupported-response-contract`;
- a positively classified provider context-window overflow records `provider-context-window-overflow` and enters the predecessor's bounded compaction/overflow-retry path with the complete dispatch preserved;
- any other SDK/API request rejection records `provider-request-failed`; a transport failure records `transport-failed`; a stream `error` records `stream-failed`; and a stream ending without terminal completion records `incomplete-provider-response`;
- those failures are copied from `EffectOutcomeRecorded.modelFailure` to `ModelCallTerminated.failureCode` and never become action rejections;
- explicit cancellation or SDK `abort` follows the existing cancelled-effect path;
- process loss after a non-idempotent model effect starts and before a durable outcome remains `unknown`;
- a completed tool-call termination with exactly one valid retained tool input records a tool submission;
- completed text-stop with no tool records `required-tool-missing`; multiple calls record `multiple-tool-calls`; an unknown name records `unexpected-tool`; malformed or schema-invalid input records `invalid-tool-input`; oversized input or total response records `oversized-tool-input` or `oversized-provider-response`; output-limit termination during tool input records `truncated-tool-input`; content filtering or a completed provider refusal records `provider-refusal`; and any other completed but structurally incomplete formal response records `incomplete-provider-response`.

For an `AgentRun`, a completed provider response with a `ModelContractViolation` records `AgentRunActionRejected` and receives the existing one bounded correction step when budget permits. The correction request contains the exact typed violation and again requires exactly one call from the same retained tool set. It never asks for corrected JSON text. Failed, cancelled, or unknown effects do not consume the format-correction allowance.

A second consecutive rejection retains the current failed-run behavior. A provider HTTP/API failure remains a failed model effect rather than an action rejection. A lost started model effect remains `unknown`.

## Shared AI SDK execution

### One compiled request path

The existing `AiSdkModelProvider` shared options builder gains one response-contract branch. Given a retained version-2 dispatch, it:

1. preserves the predecessor's model, temperature, maximum output, top-level reasoning, endpoint, and credential behavior;
2. compiles each retained tool definition to an AI SDK `tool(...)` value with its description and JSON `inputSchema`, no `execute` callback, and `strict: true` only for a retained `provider-strict` contract;
3. sets top-level `toolChoice: "required"` for a required-tool-set contract;
4. applies only documented non-reasoning provider options needed to suppress parallel calls when the canonical model creator has such a control;
5. consumes exactly one AI SDK generation step and never uses `ToolLoopAgent`, `stopWhen`, a tool-result continuation, or provider-hosted execution.

The AI SDK's `toolChoice: "required"` requires tool use but does not by itself prove exactly one call. The shared core always performs final cardinality validation. It also requests the documented parallel-call suppression for creators supported by this release:

- canonical `openai/...` models use `providerOptions.openai.parallelToolCalls: false`;
- canonical `anthropic/...` models use `providerOptions.anthropic.disableParallelToolUse: true`;
- the gateway transport uses the same underlying creator namespace because AI SDK gateway execution forwards provider-specific options under the creator key.

These provider options contain no reasoning setting and therefore cannot override the predecessor's top-level `reasoning` dispatch. The options merger rejects duplicate or reasoning-related fields rather than allowing one feature to silently replace another. For a creator whose pinned AI SDK package exposes no parallel-call control, the contract may be `runtime-validated`: multiple calls remain a typed contract violation, not an execution path or text fallback.

Required-tool-set calls always run through `streamText` internally. This is true even for internal callers that do not request visible streaming, because `tool-input-delta` is the bounded input-framing surface. Only true text deltas from text contracts may reach the existing provisional-output callback. Tool-input and reasoning parts are consumed privately, bounded, and discarded or normalized as specified.

### Gateway and direct transports

The three product transport factories from the predecessor remain unchanged in responsibility:

- `vercel` constructs the gateway model from the canonical `creator/model` ID and the configured gateway origin;
- `openai` derives the native OpenAI ID and constructs the direct OpenAI model;
- `anthropic` derives the native Anthropic ID and constructs the direct Anthropic model.

All three pass the resulting AI SDK language model to the same response-contract-aware adapter core. No Agencity code constructs provider-native tool payloads, parses native SSE frames, selects a gateway OpenAI-versus-Anthropic wire surface, or retries through another transport. A failed or unknown request retains its configured transport, endpoint identity, model, effort, and response contract.

Exact native wire fixtures remain required as dependency-conformance evidence: they prove what the pinned AI SDK packages send for `tools`, strictness, required choice, parallel suppression, model IDs, and reasoning. They do not become production request builders.

### Programmatic and custom providers

`ModelProvider` gains explicit response-contract primitives in addition to the predecessor's reasoning-control declaration. A custom provider that implements text completion only remains usable for explicit text operations but is unavailable for `AgentRun`. A provider cannot claim action support by returning JSON in `ModelResponse` text blocks; it must return normalized formal tool-call blocks.

The internal Echo and scripted fixtures implement normalized formal tool submissions directly. Echo remains unavailable in the product model picker.

## Capability and admission behavior

### Model and transport capability

Keep the predecessor's catalog-backed `ModelDescriptor` transport-independent. Extend its normalized catalog facts only with fields that the gateway catalog authoritatively reports about model-level formal-tool support. Resolve those facts against the selected transport and pinned AI SDK capability in a separate execution descriptor:

```ts
interface RequiredToolSetCapability {
  readonly status:
    | "provider-strict"
    | "runtime-validated"
    | "unsupported"
    | "unknown";
  readonly requiredChoice: "provider-enforced" | "unknown" | "unsupported";
  readonly parallelCalls:
    | "provider-disabled"
    | "runtime-rejected"
    | "unknown"
    | "unsupported";
  readonly streaming: boolean;
  readonly catalogDigest: string;
  readonly transportCapabilityId: string;
}

interface ResolvedModelExecutionDescriptor {
  readonly transport: string;
  readonly model: string;
  readonly catalog: ModelDescriptor;
  readonly requiredAgentToolSet: RequiredToolSetCapability;
}
```

At implementation start, re-verify which gateway catalog fields authoritatively describe formal function tools, required tool choice, and strict schema support. Normalize only documented fields. If the catalog omits or ambiguously describes a tool capability, the model is `unknown`; absence is not converted into `unsupported` without an authoritative catalog contract. Strict support is claimed only when the model/catalog evidence and pinned-package fixture establish it. Otherwise a formal tool channel uses Agencity's runtime validation.

The pinned AI SDK packages and focused fixtures establish transport primitives: formal function tools, `toolChoice: "required"`, streaming tool-input parts, strict-option forwarding, and any creator-specific parallel-call control. Product transports use a stable capability ID that identifies this reviewed adapter contract and its pinned dependency fixture set; registered custom providers supply their own immutable capability ID. This transport capability record is code/dependency provenance, not a second source of model metadata. The effective resolver is keyed by transport plus canonical model ID, combines the exact catalog entry with the verified transport primitive, and stores the resolved response contract and capability provenance in the version-2 dispatch before the model effect is committed.

Reasoning and response-contract compatibility are resolved together. The implementation matrix must exercise every selectable reasoning level with required tools on gateway, direct OpenAI, and direct Anthropic fixtures. A documented known incompatibility is rejected before network access. An unknown model combination may be attempted only when the transport has proven formal streaming support, because bounded `tool-input-delta` handling is mandatory for every structured call. Provider rejection is retained as a failed effect. Agencity never disables reasoning, changes effort, changes `toolChoice`, reroutes transport, or returns to text JSON to make a combination work.

### Product behavior

The public model descriptor adds:

```ts
requiredAgentToolSet: {
  status: "provider-strict" | "runtime-validated" | "unsupported" | "unknown";
  requiredChoice: "provider-enforced" | "unknown" | "unsupported";
  parallelCalls: "provider-disabled" | "runtime-rejected" | "unknown" | "unsupported";
  reason?: string;
}
```

Known unsupported models cannot start new autonomous work. Unknown catalog or manually entered models may be attempted only when the selected transport implements proven formal AI SDK tool streaming with bounded input deltas; a provider rejection is retained as a failed effect and does not trigger a text fallback.

The product model picker and setup flow distinguish:

- **strict agent tools** — provider-constrained schemas, required tool choice, and exactly-one runtime validation;
- **validated agent tools** — a required formal call with Agencity schema and cardinality validation;
- **agent tools unavailable** — cannot run autonomous work through this transport;
- **unknown model support** — the transport supports the formal channel, but this exact model has not been verified.

Capability checks are performed before committing a new model effect when the answer is known. A resumed branch retains its model identity. If that model cannot satisfy the new action contract, the branch remains inspectable and reports a typed capability error; it is never migrated to another model silently.

The catalog, cache, capability resolver, canonical model IDs, and transport factories are completed predecessor infrastructure. This plan extends the catalog facts and adds a transport-keyed resolved execution view; it does not make the base catalog descriptor transport-dependent. Provider-wide `/capabilities` may expose only coarse transport availability; it must not be presented as proof that every model on the provider supports the agent contract.

## Prompt and context changes

`agentProviderContext` stops placing the raw action JSON schema and “Return exactly one JSON object” policy in the system message.

The action-selection portion of the system message becomes:

```text
On every step, call exactly one provided tool.

Use bun_console for all repository work, shell commands, file operations,
SQL queries, model calls, delegation, memory, skills, and other execution.
Do not request additional provider tools.

bun_console source may contain multiline Bun JavaScript or TypeScript syntax.
Do not wrap source in Markdown fences or JSON. The source runs as an async
notebook cell, so top-level await is supported. Its final expression becomes
the observation unless it explicitly returns. Lexical variables do not survive
the committed cell boundary; use state or artifacts for durable values.

Use finish only when no further execution is required:
- omit status for successful completion;
- use blocked when an external requirement or missing user information
  prevents further progress;
- use failed only after reasonable recovery attempts have failed.

When missing information blocks progress, ask the necessary question in the
finish message.
A successfully completed run always ends with finish.
A successful finish is provisional until required completion gates pass.
A completed cell is not by itself task completion. Inspect results, repair
failures, and verify work before finishing.
```

This block is combined with the current task, authority, safety, budget, context, and SDK instructions. It does not replace them. Tool descriptions carry field-level guidance, while the system message explains selection and lifecycle semantics.

Prompt and tool fixtures include the uncommon terminal cases:

- a missing credential or required external decision that Agencity cannot obtain is `finish` with `status: "blocked"`;
- missing user information is `finish` with `status: "blocked"` and the necessary question in `message`;
- a repairable command, test, or cell error leads to another `bun_console` call, not `finish`;
- an error becomes `finish` with `status: "failed"` only after reasonable bounded recovery attempts cannot produce a safe completion.

The full formal schema is sent through the provider tool declaration, not duplicated as escaped prompt text. The context retains bounded response-contract identity and schema-digest provenance so a later inspector can explain what the model was required to call.

Correction instructions change from “return exactly one corrected action JSON object” to “call exactly one provided tool with valid input.” They include the selected tool name and exact typed validation failure when one was present.

Raw legacy action JSON is never appended to conversation messages. New provider tool submissions likewise remain internal action history rather than assistant conversation.

## Durable events and projections

### Model request provenance

Extend `ModelCallRequested.modelDispatch` to accept the version-2 dispatch. Do not add a second top-level `responseContract`. A retained request with no dispatch or a version-1 dispatch retains its exact legacy text-response meaning. Every new agent-run call includes a version-2 dispatch with the complete required-tool-set contract and digest.

The byte-identical dispatch is part of the outbox effect input and idempotency agreement. Reuse with another model configuration, reasoning decision, endpoint identity, tool-set name, order, description, schema, strictness mode, selection rule, or digest conflicts.

### Model completion provenance

Extend `ModelCallCompleted` with one compatibility-optional normalized result:

```ts
type ModelCallResult =
  | { kind: "text"; textDigest: string }
  | { kind: "tool-submission"; submission: ModelToolSubmission }
  | { kind: "contract-violation"; violation: ModelContractViolation };
```

`ModelToolSubmission` retains:

- provider tool-call ID;
- tool name;
- validated structured input;
- input digest;
- response-contract ID, version, and digest;
- configured transport and AI SDK adapter identity;
- normalized complete tool-call termination;
- bounded supplemental-text digest or content when present.

Call IDs, tool input, termination metadata, supplemental text, and the complete canonical submission obey the formal-response bounds. `ModelOutputChunk` remains the committed text-output event for true text responses. Tool input is not a text chunk and does not enter `chunks`.

The field is optional only for retained calls with no dispatch or a version-1 dispatch. Reducer and command validation are conditional:

- a version-2 `text` contract requires `result.kind: "text"`, a digest equal to the ordered committed text chunks, and the existing assistant response message bound to that same text;
- a version-2 `required-tool-set` contract requires exactly one `tool-submission` or `contract-violation` result and forbids `responseMessageId`;
- a tool submission or violation must match the response contract, response capability, configured transport, and adapter identity in the retained version-2 dispatch;
- a retained legacy call preserves its existing completion shape without a synthesized result.

No assistant message is appended merely because the provider returned a tool call.

### Agent action events

Keep the existing `AgentRunActionCommitted` and `AgentRunActionRejected` meanings. Add an optional discriminated formal source while retaining the required legacy `raw` string for version-1 compatibility:

```ts
type AgentRunFormalActionSource =
  | {
      kind: "tool-submission";
      submission: ModelToolSubmission;
    }
  | {
      kind: "contract-violation";
      violation: ModelContractViolation;
    };
```

- for legacy actions, `raw` remains the exact assistant text action encoding and no formal source is present;
- for a committed formal action, `raw` is stable canonical JSON for the one bounded normalized tool submission and the source is `tool-submission`;
- for a formal rejection, including no call, multiple calls, refusal, or incomplete termination, `raw` is stable canonical JSON for `{ kind: "contract-violation", violation }` and the source is `contract-violation`;
- violation `raw` never contains rejected raw argument bodies and must fit `MAX_MODEL_CONTRACT_EVIDENCE_BYTES`;
- reducers validate each formal source against the matching `ModelCallCompleted.result` and the response contract in the retained version-2 dispatch rather than `call.chunks.join("")`;
- for formal writes, `raw` is a derived compatibility encoding that reducers recompute byte-for-byte from `formalSource`; it cannot independently disagree;
- formal rejection `error` is the stable bounded message derived from the typed violation and is checked against it; the free-form legacy meaning remains only for old events;
- the committed canonical `AgentAction` must equal the pure conversion of the submitted tool name and input.

`AgentRunStepState` retains legacy `rawAction` and adds formal action-source provenance. Increment `REDUCER_VERSION`; stale snapshots rebuild from events.

### Version-1 event compatibility and mixed-version sync

The current runtime continues to emit event schema version 1 with reviewed additive fields and union variants; retained payloads are never rewritten. Within the new validator:

- `ModelCallRequested.modelDispatch` accepts no dispatch, predecessor dispatch version 1, or dispatch version 2;
- `ModelCallCompleted.result` is optional for legacy calls and conditionally required for version-2 calls;
- `RecursiveModelStarted.responseAdmission`, `AgentRunActionCommitted.formalSource`, and `AgentRunActionRejected.formalSource` are optional only for retained compatibility;
- `EffectOutcomeRecorded.modelFailure` and `ModelCallTerminated.failureCode` are optional for retained failures and conditionally required for failed version-2 model effects;
- `ContextCompactionRequested.modelDispatch` accepts predecessor version 1 or version 2;
- `AgentRunModelAttemptStarted.reason` adds `response-contract-upgrade`.

Compatibility with the completed predecessor's validator is explicit rather than assumed. Permissive predecessor schemas must retain unknown optional fields byte-for-byte because validation never stores Zod's stripped parse result. Strict predecessor schemas or closed enums—including `ContextCompactionRequested`, `AgentRunActionCommitted`, `AgentRunActionRejected`, and the old model-attempt reason vocabulary—must quarantine new envelopes they cannot validate. Frozen predecessor-validator fixtures cover each changed event, exact-byte retention, explicit quarantine, unchanged envelope digests, mixed-history projection, branch import, and sync ingestion. No compatibility path strips a field, changes a digest, or rewrites an old event.

For legacy actions, `raw` remains the authoritative assistant text. For formal actions, `formalSource` is authoritative and `raw` is its exact derived compatibility encoding.

Every terminally accepted `finish` uses the stable message ID `agent-run-final-${run.id}`. Successful finish commits that message only after required gates pass. A failed or unknown success gate does not append the proposed success message. Blocked and failed finish atomically commit `MessageAppended` with the submitted message and `AgentRunStatusChanged` with the effective non-success status and `finalMessageId`. A failed status may still become goal-derived blocked under the existing precedence rule; the assistant message remains the model's exact submitted response while the status reason retains the attributable gate summary. Runtime-originated terminal outcomes without an accepted `finish` do not fabricate an assistant message.

### Exact recovery boundaries

Recovery preserves these cases:

- **Effect requested but not started:** execute the exact retained model dispatch once.
- **Effect started with no outcome:** retain the current non-idempotent `unknown` behavior.
- **Effect succeeded before model finalization:** normalize and finalize the retained effect output without another provider call.
- **Model completion committed before action event:** derive and commit the action or rejection from the retained normalized result.
- **Action committed before cell execution:** apply the retained action through the existing stable cell identity.
- **Blocked or failed finish committed before terminal application:** atomically append the stable final assistant message and non-success status exactly once.
- **Terminal finish transaction committed before process exit:** replay observes both the final message and status and appends neither again.
- **Cell interrupted before a committed terminal boundary:** retain the current explicit unknown outcome and do not replay it.

Context-window overflow retries copy the complete version-2 dispatch byte-for-byte, including model configuration, reasoning, endpoint identity, and response contract. Compaction can change context, not any dispatch field.

### Legacy in-flight calls

`parseAgentAction(raw)` remains only for retained model effects and events whose committed `ModelCallRequested` has no dispatch or has a version-1 dispatch. No version-2 request may enter the legacy parser.

Upgrade recovery follows the committed boundary:

- a pre-feature `EffectRequested` or `ModelCallRequested` with no dispatch or a version-1 dispatch finishes under its retained legacy text contract;
- a step with no committed model request never reuses a context containing the legacy raw-JSON policy;
- completed legacy actions continue to replay and project unchanged.

The upgrade reconciler uses deterministic replacement identities:

- the replacement context ID is always `${step.contextId}-response-contract-v1`, with a context-materialization idempotency key derived from the run and step;
- when no `AgentRunModelAttemptStarted` exists, commit attempt 1 against the original stable call/effect identities, point that attempt at the replacement context, and use `reason: "response-contract-upgrade"`;
- when a prior attempt exists but none of the step's call IDs has a committed `ModelCallRequested`, append exactly one replacement attempt using call ID `${step.id}-call-response-contract-v1`, effect ID `${step.id}-effect-response-contract-v1`, `retryOfCallId` equal to the prior attempt's call, and an idempotency key derived from the run, step, and `response-contract-v1`;
- add `response-contract-upgrade` to the model-attempt reason vocabulary so the replacement remains attributable;
- build the replacement context through the current formal-tool transform and retain the same observation event IDs;
- never abandon or replace a call after `ModelCallRequested` exists.

Recovery always selects the latest retained attempt. A crash after replacement context materialization reuses that context; a crash after the replacement attempt but before its model request reuses the same attempt, call, and effect IDs; a crash after `ModelCallRequested` follows ordinary dispatch recovery. Replay never creates a third upgrade attempt, selects the stale raw-JSON context, or treats the superseded unrequested attempt as executed.

This exact pre-call crash boundary requires replay and restart tests. It is safe to replace because no provider effect was committed or executed.

After all supported retained histories remain readable, the legacy parser stays as a compatibility decoder, not an admission path.

## Streaming and terminal behavior

AI SDK tool-input deltas are protocol framing, not user-facing text. They must not be rendered as assistant prose or committed before validation.

Replace the text-only model delta with a discriminated internal stream:

```ts
type ModelOutputDelta =
  | { kind: "text"; text: string }
  | { kind: "tool-call-start"; callId: string; name: string }
  | { kind: "tool-input-delta"; callId: string; bytes: number };
```

Only true text operations emit user-visible provisional text. For an active `AgentRun`, the TUI continues to show compact working state. It may report a generic “preparing action” indicator, but it does not render partial tool arguments.

After `AgentRunActionCommitted`, the current retained TypeScript action and cell views show exact source, logs, result, and errors. A valid formal tool call accompanied by supplemental narration does not produce a rejection and does not add that narration to the conversation.

`/raw` may show scrubbed, bounded tool-call provenance after completion. It must distinguish:

- formal action submission;
- provider contract violation;
- retained legacy text action.

## Migrating other structured model output

The runtime has one other model path that asks for JSON in text and parses it: trajectory refinement.

Introduce a formal required tool:

```text
agencity_submit_refinement_review
```

Its input schema is derived from the existing strict `RefinementReviewDecision` domain contract. Extract `validateRefinementReviewValue(value, request, sensitive, encodedBytes)` from `parseRefinementReview`. Both legacy text parsing and formal tool input must use the same object validator, preserving:

- review-ID binding;
- response and nested field byte bounds;
- brokered-secret rejection;
- visible-evidence authorization;
- editable-target and scope validation;
- proposal and decision fingerprint derivation.

`RefinerService` starts the child through the internal sealed `agencity.refinement-review.v1` contract. The complete response admission is committed in `RecursiveModelStarted` before child launch. A structured recursive completion writes `RecursiveModelStatusChanged.result` as a bounded typed JSON object containing `kind: "tool-submission"`, the contract ID/version/digest, child call ID, normalized submission, and submission digest; it forbids `resultMessageId`. Command validation binds that result to `RecursiveModelStarted.responseAdmission` and the child's matching `ModelCallCompleted.result`.

`RecursiveModelService` branches result recovery by the retained response admission. Text children preserve the existing assistant-message result path. Structured children recover from the retained child model completion, recreate the same typed recursive result idempotently when needed, and never search child messages. Public `result` APIs return that typed JSON value. `RefinerService` consumes it through `validateRefinementReviewValue` and stops calling `parseRefinementReview` or `#rawResult` for new formal reviews.

The refinement provider request contains only this one tool and requires one call. This is a specialized internal model operation, not an additional tool exposed beside the two ordinary agent tools.

If the existing refinement schema exceeds a provider's strict-schema subset, simplify only its transport shape and preserve the current domain validator and authority checks. Do not fall back to textual JSON. Contract compilation, schema size, and strictness are covered by provider fixtures before rollout.

After this migration:

- `AgentRun` structure uses `bun_console` and `finish`;
- refinement structure uses `agencity_submit_refinement_review`;
- diagnostic recursive calls and model-summary compaction return text because their result is text;
- no runtime service parses model-generated JSON out of assistant prose.

## Integration with the completed reasoning architecture

The predecessor has already centralized model request construction and durable dispatch. This plan extends those boundaries in place:

- `ModelDispatchV1` remains the exact compatibility shape for predecessor calls;
- `ModelDispatchV2` adds the explicit response contract while preserving configuration, reasoning, and execution-endpoint identity;
- context identity and context-capacity provenance remain in their existing attributable call/context records rather than being duplicated inside the model dispatch;
- the shared AI SDK options builder combines top-level reasoning with formal tools and non-reasoning provider options;
- the shared result normalizer retains predecessor warnings, usage, directly returned gateway cost, bounded errors, and reasoning-part discard while adding tool submissions and contract violations;
- call/effect/compaction relation validators compare the complete dispatch byte-for-byte.

The adapter receives the complete retained dispatch and performs no fresh catalog or capability lookup. Known reasoning-and-tool incompatibilities fail during dispatch resolution. Unknown combinations follow the documented capability policy and never cause an automatic effort change, text fallback, transport change, or endpoint change.

Implementation must begin by testing the merged predecessor baseline and recording its exact package versions and dispatch fixtures. This plan then changes the shared core once; it does not reopen provider mappings already settled by the predecessor.

## Security and authority

- The formal agent tool set is an input-validation and protocol boundary, not a sandbox.
- A submitted TypeScript cell retains trusted-local process authority after it is committed and executed.
- Provider credentials remain supervisor-side and absent from tool definitions, tool inputs, events, progress, errors, and artifacts.
- Tool schemas contain static domain vocabulary only; they do not contain user data or secret values.
- Valid tool input passes the same known-secret rejection used by other model-visible and model-returned values before it can become an event or executable action.
- Supplemental text and invalid arguments pass through existing secret scrubbing and byte bounds before diagnostics.
- The runtime never executes a provider tool call directly from a stream or network callback.
- Controlled mutation, outbox, authority, budget, and goal-gate checks still run after submission.
- A provider's `strict: true` guarantee does not authorize an action, widen scope, or prove completion.

## Implementation sequence

### 0. Freeze the completed predecessor baseline

- Run the deterministic predecessor tests and record the pinned `ai`, `@ai-sdk/gateway`, `@ai-sdk/openai`, and `@ai-sdk/anthropic` versions.
- Freeze fixtures for `ModelDispatchV1`, all three transport factories, top-level reasoning, warnings, usage/cost, endpoint identity, streaming, and context-overflow classification.
- Re-verify the pinned AI SDK's `tool`, `toolChoice`, per-tool strictness, `fullStream` tool-input events, OpenAI `parallelToolCalls`, Anthropic `disableParallelToolUse`, gateway provider-option forwarding, and finish-reason contracts.
- Re-verify the gateway catalog fields used to classify model-level formal-tool support. Record ambiguous or absent metadata as `unknown`, not unsupported.

### 1. Domain tool contract

- Add `BunConsoleInput`, `FinishInput`, their portable strict JSON Schemas, and `agentActionFromToolSubmission`.
- Extract `validateAgentActionValue` so legacy text and formal object inputs share schema and 256 KiB enforcement.
- Add immutable tool-set names, descriptions, order, version, schema digests, and contract digest.
- Keep `AgentAction` as the canonical domain action.
- Add unit tests for every tool and variant, unknown fields, empty values, raw/canonical byte limits, schema digest stability, and conversion equality.
- Replace `AGENT_ACTION_POLICY` with the formal tool-selection prompt and isolate `parseAgentAction` as legacy compatibility.

### 2. Provider-neutral response contracts

- Add `ModelResponseContract`, normalized response blocks, tool submissions, and contract violations.
- Rename the predecessor dispatch interface to `ModelDispatchV1`, add `ModelDispatchV2`, and expose the compatibility union without changing retained version-1 meaning.
- Add total block, call-summary, call-ID, termination-reason, supplemental-text, evidence, and formal-response bounds with streaming enforcement.
- Add the append-only sealed built-in structured-contract registry and exact historical-definition validation; do not expose arbitrary contract definitions through public SDK or protocol inputs.
- Add `ModelEffectAdmissionService` over the predecessor's dispatch resolver as the sole owner of text versus sealed structured model-effect admission.
- Keep generic console model effects reserved; route admitted recursive text calls and model-backed gates through text admission and reject reserved dispatch fields.
- Put the exact version-2 dispatch into model-call, compaction, and effect records; require all compatibility mirrors to equal its configuration.
- Generalize `ModelProvider.complete/stream` and `ModelExecutor` beyond text-only output.
- Make text and required-tool-set paths explicit.
- Add transport-independent catalog tool facts, a transport-keyed resolved execution descriptor, response-contract capability reporting, proven structured-stream admission, and typed unavailable errors.
- Preserve reasoning dispatch, warnings, cost, concurrency, cancellation, secret scrubbing, progress bounds, usage, endpoint identity, and context-window classification.

### 3. Shared AI SDK integration

- Extend the existing shared AI SDK options builder to compile retained tools, `toolChoice: "required"`, retained strictness, and creator-specific parallel-call suppression without setting reasoning-related provider options.
- Run every required-tool-set call through `streamText`, consume bounded `fullStream` parts, and never expose partial arguments.
- Preserve the existing `vercel`, `openai`, and `anthropic` factories; add no provider-native adapter or gateway-surface selector.
- Normalize text, valid tool calls, invalid calls, finish reasons, warnings, usage, gateway cost, and bounded errors from AI SDK results.
- Add pinned-package wire conformance fixtures for gateway, direct OpenAI, and direct Anthropic, including reasoning-plus-tools combinations and canonical/native model IDs.
- Convert Echo and scripted providers to formal submissions.

### 4. Durable model and action events

- Extend `ModelCallRequested.modelDispatch`, `ModelCallCompleted`, `ModelCallTerminated`, `EffectOutcomeRecorded`, `RecursiveModelStarted`, `ContextCompactionRequested.modelDispatch`, recursive/model-call state, and action events with reviewed version-1 contract/submission/violation provenance.
- Update reducers, event validation, storage rows, snapshots, sync envelopes, export, historical projection, workspace-material classification, and protocol types.
- Enforce conditional version-2 completion shapes, derived formal `raw`/`error` mirrors, and the closed effect-versus-contract-violation outcome mapping.
- Increment `REDUCER_VERSION`.
- Add pre-reasoning no-dispatch, predecessor version-1 dispatch, version-2 dispatch, mixed-history, duplicate, conflicting-idempotency, branch, rebuild, and sync fixtures, including exact-byte acceptance or quarantine through frozen predecessor validators.
- Add the legacy in-flight recovery discriminator.

### 5. AgentRun integration

- Build every new run model effect with the retained `bun_console` and `finish` tool set.
- Remove raw action schema text from `agentProviderContext`.
- Require exactly one call from the retained set, convert it to a canonical action, and commit before action application.
- Map `bun_console` to the existing cell action and `finish` to successful, blocked, or failed terminal decisions.
- Route questions that prevent progress through blocked `finish` messages; do not add a formal pending-input state for new runs.
- Materialize blocked and failed `finish` messages as stable assistant messages atomically with their terminal status.
- Keep runtime-originated cancellation, budget, unknown-effect, and gate-failure outcomes outside model-selectable `finish` statuses.
- Convert contract violations into bounded action rejections.
- Update the correction instruction and preserve the one-attempt correction limit.
- Preserve goal-gate repair, ordinary subsequent user instructions, budgets, cancellation, overflow retry, unknown outcomes, and stable cells.

### 6. Specialized structured outputs

- Add supervisor-selected sealed required-tool-set contracts to retained recursive model calls.
- Define `agencity_submit_refinement_review`.
- Return typed recursive results through `RecursiveModelStatusChanged.result`, bind them to the child model completion, and keep structured recovery independent of assistant messages.
- Extract `validateRefinementReviewValue` and reuse every existing review-ID, evidence, scope, secret, byte-bound, and fingerprint check.
- Replace `RefinerService.#rawResult` and textual `parseRefinementReview` admission with formal tool input validation.
- Retain the text parser only for old refinement results committed before migration.

### 7. Product and observability surfaces

- Add agent-tool-set capability to `/capabilities`, provider/model selection, status, and raw diagnostics.
- Show actionable unavailable reasons without exposing internal IDs by default.
- Keep tool-argument streaming internal and retain compact active-run progress.
- Distinguish formal submissions, contract violations, and legacy text actions in inspectors.
- Add bounded counters for tool contract success and violations without storing credentials or unbounded provider bodies.

### 8. ADRs and documentation

- Add a new ADR that supersedes ADR 0005's textual JSON transport while preserving its typed-action and single-TypeScript-surface decisions.
- Mark ADR 0005 as superseded only for provider transport; retain it as historical context.
- Update `AGENTS.md`, `README.md`, `docs/architecture.md`, `docs/api.md`, `docs/protocol.md`, `docs/events.md`, `docs/recovery.md`, `docs/security.md`, `docs/capabilities.md`, `docs/console-sdk.md`, `docs/user-guide.md`, `docs/verification.md`, and `docs/decisions/README.md`.
- State clearly that the provider `bun_console` tool and its injected SDK are different layers.
- Remove public wording that describes raw action JSON as the current product protocol after rollout.

## Test strategy

### Domain and schema

- Every agent tool and input variant maps to the intended canonical `AgentAction`.
- Each tool schema has a root object, required fields, and `additionalProperties: false` on every object; the finish union uses portable nested `anyOf`.
- Both schemas compile together through the pinned AI SDK for gateway, direct OpenAI, and direct Anthropic fixtures.
- Tool-set names, descriptions, order, schemas, version, and digests are stable.
- Historical registry definitions remain accepted byte-for-byte; tampered names, descriptions, order, schemas, strictness, or digests fail before execution.
- A normal successful `finish` omits status, while blocked and failed require their explicit enum value.
- Empty, oversized, unknown, mismatched, and malicious inputs fail before execution.
- Version-1 dispatches decode as exact legacy text calls; every new textual or structured call uses a version-2 dispatch with an explicit contract.
- Version-2 provider/model and effect-configuration mirrors must equal `modelDispatch.configuration`; the executor ignores mirrors and rejects disagreement before network access.

### Shared AI SDK adapter

- The shared options builder supplies both retained tools, top-level `toolChoice: "required"`, the retained per-tool strictness, and no `execute` callbacks on every product transport.
- OpenAI-created requests set documented parallel-call suppression; Anthropic-created requests set documented parallel-call suppression; gateway requests use the canonical creator's provider-option namespace and preserve slash-containing model IDs.
- Exact pinned-package wire fixtures prove native strictness, required choice, parallel suppression, model-ID derivation, and reasoning without production code constructing those payloads.
- Required-tool-set calls use `streamText` internally on every transport; text contracts preserve the predecessor's streaming and non-streaming behavior.
- The adapter accepts completed inputs only from AI SDK `tool-call` parts and never parses provider-native tool envelopes.
- Each of `bun_console` and `finish` is accepted when selected alone.
- A required-tool-set response is accepted only when the AI SDK reports completed tool-call termination.
- A syntactically complete call paired with output-limit, content-filter, refusal, interrupted, missing-terminal, or other incompatible termination executes nothing.
- Text containing valid-looking action JSON with no tool call is rejected.
- One valid tool call plus narration accepts the tool call and treats narration as diagnostic only.
- Zero, duplicate, parallel, wrong-name, malformed, oversized, and truncated calls execute nothing.
- Provider refusals and unsupported tool contracts remain distinct.
- Strict-schema unsupported behavior never retries in text mode.
- Formal arguments and supplemental text containing a known secret are scrubbed or rejected without the value entering events, progress, logs, snapshots, or errors.
- `provider-strict` and `runtime-validated` requests differ exactly in provider enforcement fields while retaining identical domain validation.
- Block-count, call-ID, termination-reason, supplemental-text, violation-evidence, total-response, tool-input-delta, and canonical-action limits have exact-boundary and one-byte-over tests; oversized streamed input aborts before unbounded accumulation.
- Every selectable effort is combined with each structured contract on gateway, direct OpenAI, and direct Anthropic fixtures; tool options never replace or add a reasoning-related provider option.
- Existing warning normalization, directly returned gateway cost, direct-transport zero-cost fallback, endpoint-drift rejection, reasoning-part discard, and error classification remain unchanged.

### Runtime and recovery

- A `bun_console` submission commits before its stable cell starts and preserves exact multiline source.
- A successful `finish` appends only its message after required completion gates pass.
- Blocked and failed `finish` calls append their exact message as the final assistant response atomically with the effective terminal status.
- A failed completion gate returns an observation and permits repair instead of committing success.
- A successful `finish` with a failed or unknown required gate does not append its proposed success message; an unknown gate terminates as `unknown`.
- A `finish` with `status: "failed"` after an unresolved failed required gate terminates as goal-derived `blocked`; the same call without that gate history terminates as `failed`.
- A blocked `finish` can ask a necessary question in the visible final assistant response, ends the current run, and leaves the same durable branch ready for an ordinary subsequent user instruction.
- New formal runs never emit clarification or permission actions and never enter `waiting_for_user`; retained legacy histories still replay unchanged.
- Blocked and failed `finish` submissions preserve typed visible terminal outcomes except that an unresolved failed required gate retains the existing goal-derived blocked precedence.
- Model-selectable tools cannot claim runtime cancellation, budget exhaustion, or unknown-effect outcomes.
- A contract violation is delivered exactly once to one formal correction step.
- Missing-call, multiple-call, refusal, incompatible-termination, and malformed-call rejections each retain one bounded canonical violation source without fabricating a tool submission or retaining rejected raw argument bodies.
- SDK/API rejection, stream error, abort, process loss, completed refusal, output-limit truncation, and successful tool termination follow the closed effect-versus-violation classification without double-finalization.
- Failed version-2 model effects retain the same `ModelEffectFailureCode` in `EffectOutcomeRecorded.modelFailure` and `ModelCallTerminated.failureCode`, including recovery between those commits.
- Endpoint drift fails before network access with its distinct code; only positively classified context overflow receives the overflow code and enters the predecessor's dispatch-preserving compaction retry.
- Version-2 text completion requires a matching chunk/message digest; version-2 structured completion requires exactly one submission or violation and forbids a response message.
- A second consecutive violation fails the run without executing either submission.
- Budget exhaustion can prevent the correction call as it does today.
- Crash boundaries before request, after request, during provider execution, after effect outcome, after model completion, after action commit, and during cell execution preserve current guarantees.
- A crash after a blocked or failed action commit produces exactly one stable assistant message and terminal status; the atomic event batch cannot leave only one of them committed.
- Context overflow retries retain an identical complete version-2 dispatch.
- An old pending text-action effect with no dispatch or a version-1 dispatch recovers through the legacy decoder without duplication.
- Retained clarification and permission actions, including in-flight legacy text effects, preserve their historical `waiting_for_user` and resume behavior.
- A new effect cannot reach the legacy text-action parser.
- A pre-feature step with a context or model attempt but no `ModelCallRequested` creates the deterministic formal replacement attempt and never sends the stale raw-JSON prompt.
- Crashes before replacement context, after replacement context, after replacement attempt, and after replacement model request reuse the documented IDs and never create a third upgrade attempt.
- A structured recursive child interrupted before its first model call recovers the exact response contract and capability seed from `RecursiveModelStarted`; transport-capability drift fails unavailable rather than re-resolving.
- Diagnostic `ModelLoop`, public recursive calls, and new model-summary compactions retain version-2 `text` contracts and unchanged textual results; retained version-1 compactions preserve legacy text behavior.
- Model-backed goals receive text contracts and preserve existing effect evidence/results; generic console `tools.request("model", ...)` remains rejected while admitted `rlm` calls retain text contracts.
- Mixed old/new histories rebuild and branch deterministically.

### Refinement

- Refinement requests contain only the required `agencity_submit_refinement_review` tool.
- No-change and proposal submissions preserve current fingerprints, evidence checks, authority, validation, activation, and rollback behavior.
- Structured completion writes one typed `RecursiveModelStatusChanged.result`, no assistant result message, and recovery reconstructs it from the matching child model completion without message lookup.
- Textual JSON without a formal tool call is rejected.
- Old retained textual review results remain recoverable.
- Schema compilation failure is visible and never causes a text fallback.

### Protocol and TUI

- Public capabilities report strict, runtime-validated, unknown, and unavailable agent-tool-set states.
- Unsupported models fail before a model request when known.
- Agent-run tool deltas never appear as conversation prose.
- Committed TypeScript source and observations remain expandable.
- `/raw` distinguishes formal and legacy sources.
- Snapshot/cursor reconnect, provisional discard, detach, and resume do not duplicate tool calls or actions.

### Black-box acceptance

The linked executable matrix must prove:

1. a fresh repository selects a fixture model that supports the formal agent tool set;
2. the fixture receives exactly `bun_console` and `finish`, must choose one, and cannot call them in parallel;
3. a multiline `bun_console` cell edits and verifies a file through the Bun SDK;
4. a successful `finish` with omitted status produces the user-visible answer without raw tool syntax;
5. a fixture response containing narration plus a valid formal call does not create the former prose-prefix rejection;
6. a text response containing action JSON but no formal call executes nothing;
7. a truncated formal call executes nothing and produces a typed violation;
8. detach, service recovery, and resume do not repeat the provider call, action, cell, or effect;
9. child agent `AgentRun` work receives the same two-tool set;
10. a retained pre-feature database resumes and projects legacy actions correctly, including historical pending-input actions;
11. a model without formal tool capability fails truthfully without a prompt-JSON fallback;
12. refinement uses a formal structured submission rather than assistant JSON text;
13. a missing-information question appears in a blocked `finish` assistant response, and the user's later response is an ordinary subsequent instruction;
14. blocked and failed `finish` calls produce distinct non-success exits;
15. a failed success gate returns the run to `bun_console` repair before a later successful `finish`.

Credential-gated real-provider smoke tests must cover one supported model on each configured transport: gateway, direct OpenAI, and direct Anthropic. Pass, fail, and skip counts remain separate; a skipped transport is not verified.

## Acceptance criteria

The migration is complete when:

- every newly admitted `AgentRun` model effect contains one retained version-2 dispatch with the required-tool-set response contract;
- every ordinary autonomous provider request exposes exactly `bun_console` and `finish`;
- every conforming completed model response commits exactly one selected tool call, while each nonconforming, failed, or unknown response commits one corresponding durable rejection or effect outcome;
- every successful run ends through `finish`;
- omitted `finish.status` means success; only `blocked` and `failed` are model-selectable non-success statuses;
- every terminally accepted `finish` produces its exact user-facing assistant message, including blocked questions and failed outcomes, while a success rejected by failed or unknown gates does not;
- no new autonomous request asks for raw action JSON in assistant text;
- no new action path searches assistant text for JSON or TypeScript;
- AI SDK formal tool calls map to the existing canonical `AgentAction` and commit before execution or run-control application;
- all executable capabilities remain inside the Bun TypeScript SDK;
- known unsupported model/transport combinations fail visibly without fallback;
- streaming tool arguments remain provisional and non-executable;
- recovery preserves exact complete dispatches and does not duplicate model calls or actions;
- retained legacy histories and already-committed legacy effects remain readable and recoverable;
- trajectory refinement no longer parses a new model decision from assistant JSON text;
- the Vercel session failure pattern is covered by a regression fixture;
- typecheck, architecture checks, deterministic suites, linked-product acceptance, and applicable external provider smokes pass with skips reported separately;
- ADRs, repository guidance, public docs, and verification claims describe the formal tool transport accurately.

## Official implementation references

- [AI SDK tool calling](https://ai-sdk.dev/v7/docs/ai-sdk-core/tools-and-tool-calling)
- [AI SDK `streamText`](https://ai-sdk.dev/v7/docs/reference/ai-sdk-core/stream-text)
- [AI SDK reasoning](https://ai-sdk.dev/v7/docs/ai-sdk-core/reasoning)
- [AI SDK provider options](https://ai-sdk.dev/v7/docs/foundations/provider-options)
- [AI SDK gateway provider](https://ai-sdk.dev/v7/providers/ai-sdk-providers/ai-gateway)
- [AI SDK OpenAI provider](https://ai-sdk.dev/v7/providers/ai-sdk-providers/openai)
- [AI SDK Anthropic provider](https://ai-sdk.dev/v7/providers/ai-sdk-providers/anthropic)
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Anthropic tool definitions and forced tool choice](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use)
- [Anthropic strict tool use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/strict-tool-use)
- [Anthropic parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)

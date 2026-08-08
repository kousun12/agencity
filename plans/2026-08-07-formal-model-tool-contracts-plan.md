# Formal model tool contracts plan

**Status:** Ready for implementation  
**Date:** August 7, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related plans:** [Follow-up implementation plan](./2026-08-06-prime-agent-typescript-turso-rewrite-follow-up-plan.md), [reasoning effort and model capabilities](./2026-08-07-reasoning-effort-and-model-capabilities-plan.md)

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

## Motivation

### The current transport is not the intended programming model

Agencity's product architecture defines one general generated-execution surface: the Bun TypeScript console. The current implementation preserves that surface at execution time, but the provider-facing request does not expose a formal console/action tool. `AgentRunService` instead:

1. inserts `AGENT_ACTION_POLICY` and `AGENT_ACTION_JSON_SCHEMA` into the system prompt;
2. asks the model to return one JSON object with no surrounding prose;
3. stores the provider's text as `ModelOutputChunk`;
4. parses the concatenated text with `parseAgentAction`;
5. commits `AgentRunActionCommitted` or `AgentRunActionRejected`.

The OpenAI-compatible and Anthropic-compatible adapters send only messages and sampling configuration. They do not send `tools`, `tool_choice`, strict function schemas, or a provider-native action result contract.

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

## Terms

- **Provider tool:** A function/tool declaration sent through a model provider's formal API fields, such as OpenAI `tools` or Anthropic `tools`.
- **Agent tool set:** The two provider tools `bun_console` and `finish` supplied together to an autonomous model step.
- **Bun console:** A disposable async notebook cell that accepts normal JavaScript plus TypeScript syntax and exposes the injected Agencity SDK.
- **Console SDK:** The APIs available inside an admitted Bun console cell. These are not provider tools.
- **Response contract:** A durable declaration of whether a model call expects text or exactly one call from one bounded provider-tool set.
- **Tool submission:** A normalized provider tool call containing its provider call ID, name, structured input, and attributable transport metadata.
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

Each name, description, schema, schema digest, tool-set order, action protocol, and version is immutable contract meaning. Provider schema enforcement is a separate resolved dispatch property because some formal tool surfaces enforce schemas provider-side while others require Agencity runtime validation.

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

The provider adapter rejects an argument stream above `MAX_AGENT_ACTION_BYTES` before unbounded accumulation. The shared validator separately enforces the existing 256 KiB bound on the converted canonical action, so transport-wrapper differences cannot bypass or accidentally redefine the domain limit. The model does not provide `protocol` or `version`; the retained tool-set contract identifies `agencity.agent-action` version 1, and the supervisor injects those host-owned fields.

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

The complete response contract is committed with `ModelCallRequested` and copied byte-for-byte into `EffectRequested.input`. Provider execution uses only the retained effect input. Recovery never reconstructs a contract from current source constants or newer provider metadata. `schemaEnforcement` is also part of idempotency agreement: an adapter sends provider `strict: true` only for `provider-strict`; `runtime-validated` uses the provider's formal call channel without claiming provider schema enforcement.

`text` is explicit rather than implied. Diagnostic `ModelLoop` turns and model-summary compaction use `text`. Agent runs use the two-tool `required-tool-set`; internal refinement uses a one-tool `required-tool-set`.

### Contract authority

Arbitrary tool definitions are not a public input. `StartRecursiveModelInput`, `rlm.start`, `sdk.agents`, HTTP routes, public protocol clients, model-backed goal definitions, and console `tools.request` do not gain a `responseContract` field.

Supervisor-owned structured operations select from a sealed built-in registry:

```ts
type BuiltInStructuredContractId =
  | "agencity.agent-tools.v1"
  | "agencity.refinement-review.v1";
```

The registry resolves an ID only before the owning durable request is committed. For recursive structured work, the complete resolved contract is added compatibly to `RecursiveModelStarted`, projected through `RecursiveModelRecord`/`RecursiveModelState`, and included in exact idempotency comparison. `RecursiveModelService` exposes an internal supervisor method for starting such work; generated cells and public clients cannot call it or define arbitrary provider tools.

Recovery of a recursive child before its first `ModelCallRequested` reads the exact contract from `RecursiveModelStarted`. It never consults a newer registry definition. A public recursive call retains the explicit `text` contract.

Introduce one supervisor-owned `ModelEffectAdmissionService` with two code paths:

- `requestText(...)` injects the immutable built-in text contract;
- `requestBuiltInStructured(contractId, ...)` resolves and commits one sealed built-in structured contract.

Ordinary `AgentRun` and internal refinement use the structured path. Diagnostic turns, public recursive calls, model-summary compaction, current model-backed gates, and console `tools.request("model", ...)` use the text path. Current gates treat model output as effect evidence and do not parse it as an agent action.

The console RPC and goal-effect admission paths reject reserved model dispatch fields, including `responseContract`, instead of forwarding arbitrary model input directly to the outbox. If a future gate needs structured model data, it must add a reviewed sealed built-in contract rather than accepting a caller-defined schema.

Model-summary compaction has no `ModelCallRequested` event today. Its explicit text contract is therefore retained in `EffectRequested.input`; all model paths still execute from an immutable outbox request.

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
  readonly transport: {
    readonly provider: string;
    readonly surface: string;
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

The provider adapter parses only the provider's documented wire envelope. In particular, OpenAI Chat Completions represents formal function arguments as a JSON-encoded `function.arguments` string. Parsing that official field inside the OpenAI adapter is provider protocol handling; it is not parsing assistant text or searching prose for an action. Anthropic already returns the tool `input` as an object.

Provider adapters normalize successful provider tool termination to `termination.kind: "tool-calls"`: OpenAI `finish_reason: "tool_calls"` and Anthropic `stop_reason: "tool_use"`. A required-tool-set response is never accepted unless that normalized termination is present, even when one argument object happens to parse. Output limits, content filters, refusals, interrupted streams, missing terminal frames, and other stop reasons produce typed contract violations or failed effects as appropriate; they cannot commit an action.

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

The adapter enforces these limits while streaming. Once a second call, unknown tool name, metadata overflow, or block overflow proves a violation, it stops accumulating further argument bodies and retains only scrubbed bounded summaries. Tool names must match retained bounded names; call IDs and raw stop reasons are scrubbed and truncated; supplemental text retains bounded content or a digest plus byte count. The complete normalized submission, metadata, and formal event encoding must fit `MAX_MODEL_FORMAL_RESPONSE_BYTES`. These transport limits do not replace the separate 256 KiB canonical action limit.

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
  | "provider-refusal"
  | "unsupported-response-contract";
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

For an `AgentRun`, a completed provider call with a contract violation records `AgentRunActionRejected` and receives the existing one bounded correction step when budget permits. The correction request contains the exact typed violation and again requires exactly one call from the same retained tool set. It never asks for corrected JSON text.

A second consecutive rejection retains the current failed-run behavior. A provider HTTP/API failure remains a failed model effect rather than an action rejection. A lost started model effect remains `unknown`.

## Provider mappings

### OpenAI Chat Completions

The current OpenAI-compatible adapter uses `/chat/completions`. For a `provider-strict` agent tool set it sends:

```ts
{
  tools: AGENT_TOOL_SET.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      strict: true,
      parameters: tool.inputSchema,
    },
  })),
  tool_choice: "required",
  parallel_tool_calls: false,
}
```

The exact request builder is shared by streaming and non-streaming calls. For a retained `runtime-validated` dispatch, the builder omits `strict` rather than claiming provider enforcement. A provider surface that does not accept strict schemas may use formal runtime-validated tool calling only when it still supports:

- the official tool-call response channel;
- requiring a call from the supplied set;
- disabling or otherwise prohibiting multiple calls.

It must never fall back to assistant JSON text.

The adapter normalizes `message.tool_calls`. Text in `message.content` is supplemental only. Streaming accumulates `delta.tool_calls[*].function.arguments` by stable call index/ID and parses the complete argument string only after the stream terminates successfully with `finish_reason: "tool_calls"`. `length`, `content_filter`, refusal, transport interruption, or a missing terminal frame cannot produce an admitted call. No partial arguments leave the adapter as an executable value.

### Anthropic Messages

For Anthropic Messages the adapter sends:

```ts
{
  tools: AGENT_TOOL_SET.map(tool => ({
    name: tool.name,
    description: tool.description,
    strict: true,
    input_schema: tool.inputSchema,
  })),
  tool_choice: {
    type: "any",
    disable_parallel_tool_use: true,
  },
}
```

The adapter normalizes `tool_use` blocks and their structured `input`. Streaming accumulates `content_block_start`, `input_json_delta`, and `content_block_stop` for the one expected block and requires `stop_reason: "tool_use"`. `max_tokens`, refusal, transport interruption, or missing content/message stop frames cannot produce an admitted call. Tool-input deltas remain internal and provisional until the complete response validates.

Anthropic enables parallel tool use by default. A required `any` choice plus `disable_parallel_tool_use: true` guarantees exactly one call from the supplied set; runtime name and cardinality validation remain mandatory.

Anthropic also documents an important compatibility constraint: required `tool_choice` is incompatible with manual extended thinking, while adaptive thinking supports required tool use. The reasoning-effort capability resolver must therefore include response-contract compatibility. If a retained reasoning configuration cannot be combined with the required agent tool set on the selected model/surface, the autonomous call is unavailable. Agencity does not silently disable reasoning, change effort, use `tool_choice: auto`, or return to text JSON.

### Vercel AI Gateway

Vercel AI Gateway documents tool calling on both:

- its OpenAI Chat Completions surface; and
- its Anthropic Messages surface.

The dedicated Vercel adapter defined by the reasoning-effort plan selects one attributable surface for the model. This plan maps the required agent tool-set contract through that surface's native format. The chosen surface must satisfy both reasoning dispatch and required-tool-set compatibility before the model effect is admitted.

The current generic Anthropic-compatible Vercel registration is replaced. Gateway model IDs containing `/` remain unchanged. Provider-side routing does not authorize a retry through another surface after an unknown or failed request.

### Programmatic and custom providers

Provider adapters report transport primitives, while the model/surface capability resolver defined by the reasoning-effort plan owns the effective answer. Extend that plan's model-specific `ModelDescriptor` rather than creating a second provider-level source of truth:

```ts
interface RequiredToolSetCapability {
  readonly status:
    | "provider-strict"
    | "formal-runtime-validated"
    | "unsupported"
    | "unknown";
  readonly requireToolChoice: boolean;
  readonly exactlyOne: boolean;
  readonly streaming: boolean;
  readonly surface: string;
  readonly surfaceStatus: "compatible" | "incompatible" | "unknown";
  readonly provenance: CapabilityEvidence;
}
```

`ModelProvider` may advertise the wire transports it implements, but it does not decide whether a specific model, reasoning configuration, and surface combination is admissible. The combined `ModelCapabilityResolver` produces one immutable model dispatch containing reasoning and response-contract compatibility. `/capabilities`, model catalog responses, onboarding, the TUI, and effect admission consume that one resolved descriptor.

A custom provider that implements text completion only remains usable for explicit text operations but is unavailable for `AgentRun`. A provider cannot claim action support by returning JSON in `ModelResponse.text`; it must return normalized formal tool-call blocks. Operator-supplied model/surface metadata may establish formal capability with attributable `operator-configuration` provenance.

The internal Echo and scripted fixtures implement the normalized formal tool response directly. Echo remains unavailable in the product model picker.

## Capability and admission behavior

The public model descriptor adds:

```ts
requiredAgentToolSet: {
  status: "provider-strict" | "formal-runtime-validated" | "unsupported" | "unknown";
  surface: string;
  reason?: string;
}
```

Known unsupported models cannot start new autonomous work. Unknown manually entered models may be attempted only when the selected official/custom adapter supports the formal tool surface; a provider rejection is retained as a failed effect and does not trigger a text fallback.

The product model picker and setup flow distinguish:

- **strict agent tools** — provider-constrained schemas and one required call;
- **validated agent tools** — one required formal call with Agencity runtime schema validation;
- **agent tools unavailable** — cannot run autonomous work on this surface;
- **unknown model support** — the adapter supports the surface, but this exact model has not been verified.

Capability checks are performed before committing a new model effect when the answer is known. A resumed branch retains its model identity. If that model cannot satisfy the new action contract, the branch remains inspectable and reports a typed capability error; it is never migrated to another model silently.

The model catalog/capability resolver from the reasoning-effort plan is therefore a rollout dependency, not parallel optional work. The first implementation must merge agent-tool-set capability into that descriptor and resolver before product selection claims model-specific support. Provider-wide `/capabilities` may expose only coarse transport availability; it must not be presented as proof that every model on the provider supports the agent contract.

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

Add an optional `responseContract` to `ModelCallRequested`. Old events without it retain their exact text-response meaning. New agent-run calls always include the complete required-tool-set contract and digest.

The same contract is part of the outbox effect input and idempotency agreement. Reuse with another tool-set name, order, description, schema, strictness mode, selection rule, or digest conflicts.

### Model completion provenance

Extend `ModelCallCompleted` with one optional normalized result:

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
- provider surface;
- normalized complete tool-call termination;
- bounded supplemental-text digest or content when present.

Call IDs, tool input, termination metadata, supplemental text, and the complete canonical submission obey the formal-response bounds. `ModelOutputChunk` remains the committed text-output event for true text responses. Tool input is not a text chunk and does not enter `chunks`.

For a `text` contract, current message finalization remains: a committed assistant `MessageAppended` event supplies `responseMessageId`. For a `required-tool-set` contract, no assistant message is appended merely because the provider returned a tool call. `ModelCallCompleted` instead requires one permitted tool submission or a contract violation, and reducers validate that result against the call's retained response contract.

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
- reducers validate each formal source against the matching `ModelCallCompleted.result` and the retained response contract rather than `call.chunks.join("")`;
- the committed canonical `AgentAction` must equal the pure conversion of the submitted tool name and input.

`AgentRunStepState` retains legacy `rawAction` and adds formal action-source provenance. Increment `REDUCER_VERSION`; stale snapshots rebuild from events.

These are compatible optional version-1 event fields. `raw` remains the bounded authoritative action-source encoding: exact assistant content for a legacy text action, canonical normalized submission for a valid formal call, and canonical bounded violation evidence for a formal rejection. Retained payloads are not rewritten, and mixed-history fixtures must pass before enabling new writes.

Every terminally accepted `finish` uses the stable message ID `agent-run-final-${run.id}`. Successful finish commits that message only after required gates pass. A failed or unknown success gate does not append the proposed success message. Blocked and failed finish atomically commit `MessageAppended` with the submitted message and `AgentRunStatusChanged` with the effective non-success status and `finalMessageId`. A failed status may still become goal-derived blocked under the existing precedence rule; the assistant message remains the model's exact submitted response while the status reason retains the attributable gate summary. Runtime-originated terminal outcomes without an accepted `finish` do not fabricate an assistant message.

### Exact recovery boundaries

Recovery preserves these cases:

- **Effect requested but not started:** execute the exact retained response contract once.
- **Effect started with no outcome:** retain the current non-idempotent `unknown` behavior.
- **Effect succeeded before model finalization:** normalize and finalize the retained effect output without another provider call.
- **Model completion committed before action event:** derive and commit the action or rejection from the retained normalized result.
- **Action committed before cell execution:** apply the retained action through the existing stable cell identity.
- **Blocked or failed finish committed before terminal application:** atomically append the stable final assistant message and non-success status exactly once.
- **Terminal finish transaction committed before process exit:** replay observes both the final message and status and appends neither again.
- **Cell interrupted before a committed terminal boundary:** retain the current explicit unknown outcome and do not replay it.

Context-window overflow retries copy the same response contract byte-for-byte. Compaction can change context, not the tool contract.

### Legacy in-flight calls

`parseAgentAction(raw)` remains only for retained model effects and events whose committed `ModelCallRequested` has no response contract. No new request may omit a response contract and then enter the legacy parser.

Upgrade recovery follows the committed boundary:

- a pre-feature `EffectRequested` or `ModelCallRequested` finishes under its retained legacy text contract;
- a step with no committed model request never reuses a context containing the legacy raw-JSON policy;
- completed legacy actions continue to replay and project unchanged.

The upgrade reconciler uses deterministic replacement identities:

- when no `AgentRunModelAttemptStarted` exists, materialize `${step.contextId}-response-contract-v1` and commit attempt 1 against the original stable call/effect identities;
- when an attempt exists but no `ModelCallRequested` exists, commit attempt 2 with deterministic replacement context, call, and effect IDs;
- add `response-contract-upgrade` to the model-attempt reason vocabulary so the replacement remains attributable;
- build the replacement context through the current formal-tool transform and retain the same observation event IDs;
- never abandon or replace a call after `ModelCallRequested` exists.

This exact pre-call crash boundary requires replay and restart tests. It is safe to replace because no provider effect was committed or executed.

After all supported retained histories remain readable, the legacy parser stays as a compatibility decoder, not an admission path.

## Streaming and terminal behavior

Provider-native tool argument deltas are protocol framing, not user-facing text. They must not be rendered as assistant prose or committed before validation.

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

`RefinerService` starts the child through the internal sealed `agencity.refinement-review.v1` contract. The complete response contract is committed in `RecursiveModelStarted` before child launch. `RecursiveModelService` and `ModelLoop` return a typed `JsonValue` tool submission instead of creating an assistant text message. `RefinerService` consumes that attributable structured result through `validateRefinementReviewValue` and stops calling `parseRefinementReview` on new final text.

The refinement provider request contains only this one tool and requires one call. This is a specialized internal model operation, not an additional tool exposed beside the two ordinary agent tools.

If the existing refinement schema exceeds a provider's strict-schema subset, simplify only its transport shape and preserve the current domain validator and authority checks. Do not fall back to textual JSON. Contract compilation, schema size, and strictness are covered by provider fixtures before rollout.

After this migration:

- `AgentRun` structure uses `bun_console` and `finish`;
- refinement structure uses `agencity_submit_refinement_review`;
- diagnostic recursive calls and model-summary compaction return text because their result is text;
- no runtime service parses model-generated JSON out of assistant prose.

## Interaction with reasoning effort

The reasoning-effort plan and this plan both change provider request construction. Implement one shared immutable model dispatch envelope containing:

- model configuration;
- resolved reasoning dispatch;
- response contract;
- provider surface;
- context identity and capacity provenance.

The provider adapter receives the complete retained dispatch and performs no fresh capability lookup.

Response-contract compatibility is a model/surface capability, not a provider-wide assumption. The combined resolver must reject incompatible pairs before network access when known. Examples include Anthropic manual extended thinking with required tool choice and a Vercel route whose selected surface cannot carry both the reasoning configuration and the agent tool set.

Implementation order should establish the provider-neutral response contract and shared request builders before applying the reasoning plan's final provider mappings. Neither feature may silently drop the other feature's dispatch.

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

### 1. Domain tool contract

- Add `BunConsoleInput`, `FinishInput`, their portable strict JSON Schemas, and `agentActionFromToolSubmission`.
- Extract `validateAgentActionValue` so legacy text and formal object inputs share schema and 256 KiB enforcement.
- Add immutable tool-set names, descriptions, order, version, schema digests, and contract digest.
- Keep `AgentAction` as the canonical domain action.
- Add unit tests for every tool and variant, unknown fields, empty values, raw/canonical byte limits, schema digest stability, and conversion equality.
- Replace `AGENT_ACTION_POLICY` with the formal tool-selection prompt and isolate `parseAgentAction` as legacy compatibility.

### 2. Provider-neutral response contracts

- Add `ModelResponseContract`, normalized response blocks, tool submissions, and contract violations.
- Add total block, call-summary, call-ID, termination-reason, supplemental-text, evidence, and formal-response bounds with streaming enforcement.
- Add the sealed built-in structured-contract registry; do not expose arbitrary contract definitions through public SDK or protocol inputs.
- Add `ModelEffectAdmissionService` as the sole owner of text versus sealed structured model-effect admission.
- Route console model tools and model-backed gates through text admission and reject reserved dispatch fields.
- Put the exact contract into model effect input.
- Generalize `ModelProvider.complete/stream` and `ModelExecutor` beyond text-only output.
- Make text and required-tool-set paths explicit.
- Add response-contract capability reporting and typed unavailable errors.
- Preserve concurrency, cancellation, secret scrubbing, progress bounds, usage, and context-window classification.

### 3. Built-in provider mappings

- Implement one required strict call from the supplied set for OpenAI Chat Completions.
- Implement one required strict call from the supplied set for Anthropic Messages.
- Add a dedicated Vercel adapter that maps the selected OpenAI or Anthropic surface.
- Share pure request builders between streaming and non-streaming paths.
- Normalize text, valid tool calls, invalid calls, finish reasons, and usage.
- Implement complete streaming assembly without exposing partial arguments.
- Convert Echo and scripted providers to formal submissions.

### 4. Durable model and action events

- Extend `ModelCallRequested`, `ModelCallCompleted`, `RecursiveModelStarted`, recursive/model-call state, and action events with compatible contract/submission/violation provenance.
- Update reducers, event validation, storage rows, snapshots, sync envelopes, export, historical projection, workspace-material classification, and protocol types.
- Increment `REDUCER_VERSION`.
- Add old-event, mixed-history, duplicate, conflicting-idempotency, branch, rebuild, and sync fixtures.
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
- Return typed recursive results with exact response-contract provenance.
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
- Both schemas are accepted together by recorded OpenAI, Anthropic, and both Vercel surface fixtures.
- Tool-set names, descriptions, order, schemas, version, and digests are stable.
- A normal successful `finish` omits status, while blocked and failed require their explicit enum value.
- Empty, oversized, unknown, mismatched, and malicious inputs fail before execution.

### Provider adapters

- OpenAI agent requests contain both strict functions, `tool_choice: "required"`, and `parallel_tool_calls: false`.
- Anthropic agent requests contain both strict tools and `tool_choice.type: "any"` with `disable_parallel_tool_use: true`.
- Vercel emits the exact selected-surface shape and preserves slash-containing model IDs.
- Streaming and non-streaming normalize to equivalent final responses.
- OpenAI argument strings are parsed only from formal `tool_calls`.
- Anthropic tool inputs are accepted only from `tool_use` blocks.
- Each of `bun_console` and `finish` is accepted when selected alone.
- OpenAI accepts required-tool-set output only with `finish_reason: "tool_calls"`; Anthropic accepts it only with `stop_reason: "tool_use"`.
- A syntactically complete call paired with output-limit, content-filter, refusal, interrupted, missing-terminal, or other incompatible termination executes nothing.
- Text containing valid-looking action JSON with no tool call is rejected.
- One valid tool call plus narration accepts the tool call and treats narration as diagnostic only.
- Zero, duplicate, parallel, wrong-name, malformed, oversized, and truncated calls execute nothing.
- Provider refusals and unsupported tool contracts remain distinct.
- Strict-schema unsupported behavior never retries in text mode.
- Formal arguments and supplemental text containing a known secret are scrubbed or rejected without the value entering events, progress, logs, snapshots, or errors.
- `provider-strict` and `runtime-validated` requests differ exactly in provider enforcement fields while retaining identical domain validation.
- Block-count, call-ID, termination-reason, supplemental-text, violation-evidence, total-response, wire-argument, and canonical-action limits have exact-boundary and one-byte-over tests in streaming and non-streaming paths.

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
- A second consecutive violation fails the run without executing either submission.
- Budget exhaustion can prevent the correction call as it does today.
- Crash boundaries before request, after request, during provider execution, after effect outcome, after model completion, after action commit, and during cell execution preserve current guarantees.
- A crash after a blocked or failed action commit produces exactly one stable assistant message and terminal status; the atomic event batch cannot leave only one of them committed.
- Context overflow retries retain an identical response contract.
- An old pending text-action effect recovers through the legacy decoder without duplication.
- Retained clarification and permission actions, including in-flight legacy text effects, preserve their historical `waiting_for_user` and resume behavior.
- A new effect cannot reach the legacy text-action parser.
- A pre-feature step with a context or model attempt but no `ModelCallRequested` creates the deterministic formal replacement attempt and never sends the stale raw-JSON prompt.
- A structured recursive child interrupted before its first model call recovers the exact contract from `RecursiveModelStarted`.
- Diagnostic `ModelLoop`, public recursive calls, and model-summary compaction retain explicit `text` contracts and unchanged textual results.
- Model-backed goals and console `tools.request("model", ...)` receive text contracts, cannot inject a structured contract, and preserve existing effect evidence/results.
- Mixed old/new histories rebuild and branch deterministically.

### Refinement

- Refinement requests contain only the required `agencity_submit_refinement_review` tool.
- No-change and proposal submissions preserve current fingerprints, evidence checks, authority, validation, activation, and rollback behavior.
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

Credential-gated real-provider smoke tests must cover one supported model on each configured provider surface. Pass, fail, and skip counts remain separate; a skipped provider is not verified.

## Acceptance criteria

The migration is complete when:

- every newly admitted `AgentRun` model effect contains one retained required-tool-set response contract;
- every ordinary autonomous provider request exposes exactly `bun_console` and `finish`;
- every conforming completed model response commits exactly one selected tool call, while each nonconforming, failed, or unknown response commits one corresponding durable rejection or effect outcome;
- every successful run ends through `finish`;
- omitted `finish.status` means success; only `blocked` and `failed` are model-selectable non-success statuses;
- every terminally accepted `finish` produces its exact user-facing assistant message, including blocked questions and failed outcomes, while a success rejected by failed or unknown gates does not;
- no new autonomous request asks for raw action JSON in assistant text;
- no new action path searches assistant text for JSON or TypeScript;
- provider-native formal calls map to the existing canonical `AgentAction` and commit before execution or run-control application;
- all executable capabilities remain inside the Bun TypeScript SDK;
- known unsupported model/surface combinations fail visibly without fallback;
- streaming tool arguments remain provisional and non-executable;
- recovery preserves exact contracts and does not duplicate model calls or actions;
- retained legacy histories and already-committed legacy effects remain readable and recoverable;
- trajectory refinement no longer parses a new model decision from assistant JSON text;
- the Vercel session failure pattern is covered by a regression fixture;
- typecheck, architecture checks, deterministic suites, linked-product acceptance, and applicable external provider smokes pass with skips reported separately;
- ADRs, repository guidance, public docs, and verification claims describe the formal tool transport accurately.

## Official provider references

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Anthropic tool definitions and forced tool choice](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use)
- [Anthropic strict tool use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/strict-tool-use)
- [Anthropic parallel tool use and exactly-one control](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)
- [Vercel AI Gateway OpenAI Chat Completions tool calling](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/tool-calling)
- [Vercel AI Gateway Anthropic Messages tool calling](https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api/tool-calling)

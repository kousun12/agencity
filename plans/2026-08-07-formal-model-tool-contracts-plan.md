# Formal model tool contracts plan

**Status:** In implementation  
**Date:** August 7, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Prerequisite:** [Reasoning effort and model capabilities](./2026-08-07-reasoning-effort-and-model-capabilities-plan.md) must be complete and merged before this plan begins
**Related plan:** [Follow-up implementation plan](./2026-08-06-prime-agent-typescript-turso-rewrite-follow-up-plan.md)

## Implementation status

| Phase | Status |
| --- | --- |
| 0. Freeze the completed predecessor baseline | Done |
| 1. Domain tool contract | Done |
| 2. Provider-neutral response contracts | Done |
| 3. Shared AI SDK integration | Done |
| 4. Durable model and action events | Done |
| 5. AgentRun integration | Done |
| 6. Specialized structured outputs | Not started |
| 7. Product and observability surfaces | Not started |
| 8. ADRs and documentation | Not started |

### Implementation log

#### August 8, 2026 — Phase 0

- Confirmed the reasoning-effort and model-capabilities predecessor is present before implementation.
- Recorded the pinned baseline: `ai@7.0.58`, `@ai-sdk/gateway@4.0.46`, `@ai-sdk/openai@4.0.36`, and `@ai-sdk/anthropic@4.0.36`.
- Passed 50 focused deterministic tests covering reasoning, catalog behavior, the three product transports, streaming, context-window classification, and compaction. `bun run typecheck` also passed.
- Verified from the pinned packages that the shared SDK surface includes declaration tools, runtime-validated JSON Schema, required tool choice, strict tool metadata, tool-input stream events, OpenAI parallel-call suppression, Anthropic parallel-call suppression, provider warnings, and normalized finish reasons. Gateway service enforcement and credential-gated real-provider behavior remain externally unverified.
- The current Gateway catalog path has no authoritative normalized facts for formal tools, required choice, strict schemas, parallel calls, or structured streaming. Until stronger catalog evidence exists, exact model support remains `unknown` and strictness cannot be inferred from catalog absence.
- AI SDK 7 requires an `outputSchema` on a tool declaration without an `execute` callback. The adapter will provide a static inert output schema to satisfy the pinned type contract; this does not add provider-side execution or a tool-result continuation.
- Phase 1 will add the formal domain contract without immediately deleting clarification, permission, or pending-input types. Those removals move to Phase 5 so intermediate commits remain buildable while the existing AgentRun still depends on them.
- Phase 4 will include the minimum formal AgentRun result handling required to ensure a version-3 writer cannot commit the old textual action provenance. Phase 5 completes product behavior and deletes the transitional input lifecycle.
- External provider smokes were not run and are not treated as verified.

#### August 8, 2026 — Phase 1

- Added the immutable `agencity.agent-tools.v1` contract with ordered `bun_console` and `finish` definitions, portable strict input schemas, pinned schema and contract digests, and deep-frozen built-in meaning.
- Added stable canonical JSON encoding and digest utilities, exact formal-input and canonical-action byte bounds, strict tool-submission validation, and pure conversion to the existing canonical `AgentAction`.
- Added the formal tool-selection policy as a domain export for the later runtime cutover.
- Kept the active AgentRun prompt, textual parser, clarification and permission variants, and pending-input lifecycle unchanged. A review found that switching the prompt before provider tools were supplied would make the intermediate runtime unsatisfiable; the provider-context and correction-prompt cutover therefore remains in Phase 5 as recorded in the Phase 0 deviation.
- Passed 59 focused domain and AgentRun tests, all 350 unit tests, 213 integration tests with the documented 30-second timeout, `bun run typecheck`, `bun run check:architecture`, lint checks, and `git diff --check`.
- Review fixed the premature runtime prompt cutover and found no remaining Phase 1 blocker.
- Implementation commit: `edd2123`.

#### August 8, 2026 — Phase 2

- Added explicit text and required-tool-set response contracts, the sealed built-in contract registry, immutable contract/capability validation, response-aware dispatch version 2, transport-keyed execution descriptors, and the supervisor-owned `ModelEffectAdmissionService`.
- Added complete and guard-aborted normalized responses, evidence-only response blocks, exact tool submissions, bounded contract violations, closed model-effect failure codes, result digests, total response/evidence bounds, and strict `ModelEffectOutputV2` relation validation.
- Kept one authoritative durable copy of accepted tool input in `ModelEffectOutputV2`. Response blocks retain only the provider call ID, tool name, canonical input digest, and exact canonical input byte count; later event shapes must reference the result digest instead of copying the input.
- Added catalog facts that preserve absent formal-tool metadata as `unknown`, transport capability validation, typed pre-admission unavailability, proven-streaming requirements, reasoning/catalog/endpoint provenance checks, and rejection of reserved response-contract fields on public inputs.
- The live workspace-schema-2 writer remains on dispatch version 1. Phase 3 supplies the shared AI SDK structured-stream implementation, and Phase 4 changes the authoritative `ModelDispatch` alias and durable writers atomically.
- The normalized provider-neutral response is named `ModelResponseV2` while the transitional text-provider result keeps the existing `ModelResponse` name. Phase 4 removes the text-only ambiguity during the writer cutover.
- Review tightened fail-closed validation for required contract/capability arguments, unsupported primitives, catalog-digest format, provider declaration consistency, raw finish reasons, and violation evidence.
- Independent verification found and drove fixes for two additional gaps: accepted input byte provenance is now exact, and every completed non-guard violation code must be proved by matching termination and block evidence. The verifier confirmed both adversarial cases reject after the fixes.
- Passed 40 focused Phase 2 tests, all 390 unit tests, 213 integration tests with the documented 30-second timeout, `bun run typecheck`, `bun run check:architecture`, lint checks, and `git diff --check`.
- Implementation commit: `3516100`.

#### August 8, 2026 — Phase 3

- Extended the single shared AI SDK adapter core with declaration-only retained tools compiled through runtime-validated JSON Schema, the pinned SDK's required inert output schema, required tool choice, retained strictness, and direct OpenAI/Anthropic parallel-call suppression.
- Every structured request uses one `streamText` generation and consumes bounded AI SDK stream parts. It has no `execute` callback, explicit `stopWhen`, tool-result continuation, provider-hosted execution, or second request. The pinned SDK's default one-step behavior supplies the terminal boundary.
- Added first-source guard and external-cancellation composition, private tool-input delta accounting, exact accepted-input normalization, evidence-only invalid calls, bounded supplemental text and metadata, conservative incomplete-stream handling, normalized usage/warnings/Gateway cost, and typed provider failure classification.
- Added formal response implementations for Echo and scripted fixtures while retaining their textual methods until the schema and AgentRun cutovers.
- Added pinned-package wire fixtures for Gateway, direct OpenAI, and direct Anthropic across every selectable reasoning effort. They prove canonical/native model identity, required choice, retained strictness, direct parallel suppression, top-level reasoning preservation, and the absence of provider-managed tool execution.
- Review removed an explicit `stopWhen` that contradicted the plan and was redundant with the pinned SDK default. It also changed cyclic, proxy, and non-plain custom-provider inputs into closed `invalid-tool-input` violations instead of unclassified failures.
- Independent verification passed duplicate-call and throwing-proxy adversarial probes in addition to the committed fixture matrix.
- Passed 20 focused provider tests, all 390 unit tests, all 233 integration tests with the documented 30-second timeout, `bun run typecheck`, `bun run check:architecture`, lint checks, and `git diff --check`.
- Credential-gated real-provider and live Gateway service checks were not run and remain unverified.
- Implementation commit: `7f304e3`.

#### August 8, 2026 — Phase 4

- Cut the canonical workspace writer, event schema, reducer, snapshots, model dispatch, effect output, recovery, compaction, and fixtures to schema version 3 and response-aware dispatch version 2. Version-1 and version-2 workspaces are rejected with reset guidance before migration, row decoding, projection, sync ingestion, or recovery; no compatibility alias, decoder, or upcast path remains.
- Made `ModelEffectOutputV2` the authoritative retained model result. Model-call completion and termination events now carry digest-linked result summaries, exact termination, normalized usage and warnings, usage source, and closed failure provenance. Reducer validation ties every completion, budget debit, action commit, and action rejection back to the retained dispatch and effect outcome.
- Preserved one full accepted tool input in the effect output rather than copying it into completion and action events. This is the Phase 2 storage decision applied to the durable schema: later events retain result digests, provider tool-call IDs, and model-call references.
- Moved the minimum formal AgentRun request and result path into this phase so a schema-3 writer cannot commit textual action provenance. Ordinary steps now request the built-in tool set and commit either a tool-submission source or a typed contract-violation source. The unreachable clarification, permission, pending-input, and `waiting_for_user` code remains scheduled for deletion in Phase 5.
- Added conservative guard-abort budget attribution from the retained input estimate and output reserve, with zero provider cost and an explicit usage source. Context-overflow retries reuse the exact retained dispatch, while cancelled, failed, and unknown effects keep distinct terminal semantics.
- Pulled the required recursive `responseAdmission` seed and migration `015_recursive_model_response_admission.sql` forward from Phase 6 so schema-3 recursive starts are recoverable without a later event-shape change. The projection stores and validates the admission across migration, reopen, rebuild, idempotent start, branch fork, and replica synchronization.
- Review aligned `EffectOutcomeRecorded.modelFailure` with the planned bounded `{ code }` event object while preserving the bare failure code in executor and projection interfaces. It also updated `AGENTS.md` for the schema-3 intermediate state and added missing tamper, legacy-envelope, branch, rebuild, and sync coverage.
- Independent verification approved the phase after confirming rejection of altered completion termination, warnings, usage, usage source, budget debits, and both version-1 and version-2 signed sync envelopes. A structured AgentRun fixture now proves exact model/effect/action provenance across fork, snapshot rebuild, and actual replica sync.
- Passed `bun run typecheck`, `bun run check:architecture`, `bun run test:core` with 793 passes and 2 documented external skips, `bun run test:acceptance` with 12 passes and 1 credential-gated real-provider skip, focused verifier suites with 35 passes, and `git diff --check`.
- Credential-gated real-provider and live Gateway service checks were not run and remain unverified.
- Implementation commit: `8360c88`.

#### August 8, 2026 — Phase 5

- Completed formal AgentRun admission and execution. Root runs and novel runnable children now reject known-unsupported required-tool-set capability before committing task messages, goals, run requests, child tasks, child sessions, prompts, model calls, or effects. Unknown exact-model capability remains admissible when the transport proves bounded formal streaming, text recursive children are unaffected, and capability is checked again before each model effect for drift.
- Removed the transitional clarification and permission actions, textual action policy/schema/parser, pending-input events and projection state, `waiting_for_user`, run-input protocol and client methods, TUI composer interception and rendering, CLI pending-input output, family waiting reasons, workspace-material classifications, and refinement-context handling. A later user message after a blocked finish starts an ordinary new run on the same durable branch.
- Successful `finish` retains the existing gate-first behavior: passed gates commit the exact assistant message and success; failed gates produce repair evidence without the proposed message; unknown gates terminate unknown without the proposed message. Explicit blocked finishes bypass success gates. A failed finish after an unresolved required-gate failure becomes goal-derived blocked; otherwise model-selected blocked and failed statuses remain distinct.
- Blocked and failed finishes now append the exact submitted assistant message with stable `agent-run-final-${runId}` identity in the same event transaction as terminal status and any goal-block event. Recovery after action commit or terminal-batch commit produces no duplicate model call, message, status, goal change, or cell. Runtime cancellation, budget exhaustion, unknown effects, model failures, correction exhaustion, and interrupted cells remain status-only.
- Kept event schema version 3 and raised the reducer version to 10 for the removed projected input state. Reducer validation binds terminal status to the accepted finish action, source, result digest, exact assistant message, stable ID, role, gate evidence, and event ordering while rejecting message-less blocked or failed terminals whenever an accepted finish is retained.
- Updated Echo, scripted providers, acceptance fixtures, protocol/TUI/family tests, recovery fixtures, and black-box outcomes to use genuine formal calls. Raw fixture strings remain only where a missing-tool contract violation is intentional.
- Review closed a forged-history case where a status-only failed terminal could suppress a retained blocked finish, and removed a stale TUI method name. Independent verification found and drove one further reducer fix: a forged status-only failed or blocked terminal after a successful finish with a failed required gate can no longer bypass repair. The regression reproduces the crash boundary, proves the forged events leave state unchanged, then resumes through the legitimate goal-derived blocked path.
- Passed `bun run typecheck`, `bun run check:architecture`, `bun run test:core` with 799 passes and 2 documented external skips, `bun run test:e2e` with 3 passes, `bun run test:acceptance` with 13 passes and 1 real-provider skip, the deterministic acceptance matrix, and `git diff --check`. Two direct integration-suite runs encountered the pre-existing concurrent execution-lease timing timeout under parallel load; the test passed in isolation and the subsequent complete core run passed all deterministic tests.
- Real-provider, official Turso Sync server, and Turso Cloud matrix rows were skipped because their credentials or external binaries were absent; they remain unverified.
- Implementation commit: `69baa71`.

## Summary

Agencity's ordinary autonomous loop currently asks a model to serialize one `agencity.agent-action` JSON object into assistant text. The runtime concatenates the returned text, calls `JSON.parse`, validates the resulting object, and only then executes an admitted TypeScript action. This preserves a strict execution boundary, but it uses free-form assistant text as a transport for a protocol that model providers already support as formal tool calling.

This plan replaces that transport with a small fixed provider-native tool set on every autonomous `AgentRun` model call:

```text
bun_console
finish
```

The model must call exactly one of these tools on every step. `bun_console` proposes one multiline Bun notebook cell and exposes the existing SDK for shell, files, SQL, models, subagents, memory, skills, artifacts, and other programmatic work. `finish` ends model-directed work. Omitting its status means success; `blocked` and `failed` retain distinct terminal outcomes. If missing user information prevents progress, a blocked `finish` asks the necessary question in its final message.

The provider's formal tool-call channel and selected tool name, not assistant prose, identify the action. Agencity still validates and durably commits the submission before executing or applying anything. Assistant text is never searched for JSON, JavaScript, or an implied action.

The same provider-neutral response-contract mechanism also replaces the remaining structured model response that is parsed from text: trajectory refinement decisions. Text remains a valid model result for operations whose result is actually text, such as diagnostic turns and model-summary compaction. The rule is:

> If Agencity consumes a model result as structured data, the request declares a bounded formal provider tool set and the response must contain exactly one permitted tool call. Agencity never asks for structured JSON in assistant text.

There is no prompt-JSON fallback. A provider or model that cannot use the required formal tool contract is unavailable for that structured operation.

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

- Give every autonomous model step a fixed, minimal set of formal provider-native tools and require exactly one call.
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
- Make one explicit pre-release workspace-schema cutover; older workspace state is rejected with reset guidance rather than decoded, upcast, or recovered.
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

The canonical action retains the internal type name `typescript`. That internal name is not shown to models. The pre-release cutover removes `clarification` and `permission` from the canonical action union rather than retaining compatibility-only variants.

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

Each name, description, schema, schema digest, tool-set order, action protocol, and version is immutable contract meaning. The shared adapter compiles the retained ordered definitions into AI SDK `tool(...)` values with no `execute` callback: provider submission ends the model effect, and Agencity applies the accepted action only after durable commit. Retained JSON Schema is wrapped with the AI SDK's `jsonSchema(...)` helper and a runtime validator rather than passed as a plain object. The adapter passes `strict: true` only when the retained contract says `provider-strict`; otherwise strictness is omitted and the same Agencity schema and domain validation remain authoritative. Product selection admits only models classified as compatible with the selected strict contract. As a generic execution-time fallback, an SDK warning or provider rejection that says strict tool enforcement was ignored or unsupported fails the effect as `unsupported-response-contract`; Agencity never downgrades the committed contract or retries in text mode.

### Canonical conversion and bounds

Replace the current text parser with one formal-submission validator:

```ts
function validateAgentActionValue(
  value: unknown,
  options: { encodedBytes: number },
): AgentAction;
```

`agentActionFromToolSubmission` performs the pure canonical conversion:

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

The pre-release cutover removes `clarification`, `permission`, `AgentRunUserInputRequested`, `AgentRunUserInputReceived`, `waiting_for_user`, the run-input protocol route, and `parseAgentAction`. Missing information ends the current run through blocked `finish`; a later user message starts an ordinary new run on the same durable branch.

Formal submission validates the selected tool input, converts it to `AgentAction`, measures the UTF-8 stable canonical-JSON encoding of that canonical action, and delegates to the domain validator. The model does not provide `protocol` or `version`; the `agencity.agent-tools.v1` contract identifies the host-owned action vocabulary and the supervisor injects the canonical action fields. Tool-contract version 1 is independent of workspace event schema version 3; it does not accept or decode older workspace events.

Required-tool-set calls always use `streamText` internally, even when the caller does not request user-visible streaming. The adapter owns a private `AbortController` composed with the outbox cancellation signal and records which source fired first:

- an outbox or caller abort follows the existing cancelled-effect path;
- an adapter guard abort records the already-proven contract violation, such as `oversized-tool-input`, `multiple-tool-calls`, or `oversized-provider-response`, and never becomes cancellation.

The adapter counts observed AI SDK `tool-input-delta` bytes, aborts immediately after the first observed limit breach, stops retaining application-level argument content, and keeps only scrubbed bounded summaries. This bounds Agencity-owned accumulation; it does not claim that the AI SDK, provider package, network stack, or provider performed no buffering before Agencity observed a chunk. A guard abort produces the explicit partial `guard-aborted` response variant defined below rather than pretending that the provider supplied terminal metadata or usage. The shared validator separately enforces the existing 256 KiB bound on the converted canonical action. Formal input limits reserve enough envelope overhead that every accepted tool input can still produce a canonical action within that bound.

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

The predecessor plan's model dispatch contains model configuration, reasoning dispatch, and execution-endpoint identity. This plan replaces its pre-release shape with one required response-contract-aware dispatch instead of maintaining a compatibility union:

```ts
interface ModelDispatch {
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
```

Every accepted model call uses this shape, including genuinely textual operations, so response behavior is never inferred from an absent field. Pre-cutover dispatches are not decoded or recovered.

The complete dispatch is committed in `ModelCallRequested.modelDispatch` and copied byte-for-byte into `EffectRequested.input`. The effect input has one authoritative `modelDispatch`; the executor reads model, reasoning, endpoint, and response behavior only from it.

Provider execution uses only the retained effect input. Recovery never reconstructs a contract from current source constants or newer catalog data. `schemaEnforcement` and response-capability provenance are request attribution and part of idempotency agreement within the current schema: the adapter sets AI SDK tool `strict: true` only for `provider-strict`; `runtime-validated` uses the provider's formal call channel without claiming provider schema enforcement. Recovery does not compare that provenance with a newer runtime capability identity.

`text` is explicit rather than implied. Diagnostic `ModelLoop` turns and model-summary compaction use `text`. Agent runs use the two-tool `required-tool-set`; internal refinement uses a one-tool `required-tool-set`.

### Contract authority

Arbitrary tool definitions are not a public input. `StartRecursiveModelInput`, `rlm.start`, `sdk.agents`, HTTP routes, public protocol clients, model-backed goal definitions, and console `tools.request` do not gain a `responseContract` field.

Supervisor-owned structured operations select from a sealed built-in registry:

```ts
type BuiltInStructuredContractId =
  | "agencity.agent-tools.v1"
  | "agencity.refinement-review.v1";
```

The registry is append-only after release by contract ID and version. Event and reducer validation accepts a structured contract only when every retained name, description, schema, schema digest, tool order, selection rule, and supplemental-text rule exactly matches its template. `schemaEnforcement` is a resolved dispatch property: `provider-strict` requires matching strict capability provenance, while `runtime-validated` is used for runtime-validated or admitted unknown capability. Validation recomputes the final contract digest over the exact template plus resolved mode.

Recursive work retains the response side of future dispatch before child launch:

```ts
interface RecursiveResponseAdmission {
  readonly responseContract: ModelResponseContract;
  readonly responseCapability: ModelDispatch["responseCapability"];
}
```

The registry resolves an ID and the transport-keyed capability only before the owning durable request is committed. `RecursiveModelStarted.responseAdmission` stores that complete seed, projects it through `RecursiveModelRecord`/`RecursiveModelState`, persists it in the mutable recursive-handle projection through a numbered migration, and includes it in exact idempotency comparison. Internal structured work stores the sealed structured contract and resolved capability; admitted public recursive calls store the built-in text contract and `{ kind: "text" }`. `RecursiveModelService` exposes an internal supervisor method for starting structured work; generated cells and public clients cannot call it or define arbitrary provider tools.

Recovery of a recursive child before its first `ModelCallRequested` reads the exact response admission from `RecursiveModelStarted`. Dispatch resolution combines that seed with the retained child model configuration, reasoning dispatch, and endpoint identity; it does not re-resolve the response contract. The recorded capability is attribution only and is not compared with current transport capability during recovery. Runtime upgrades that cannot execute their own current schema require a pre-release reset rather than transport-capability drift reconciliation.

Extend the predecessor's centralized model-dispatch resolution with one supervisor-owned `ModelEffectAdmissionService` exposing two code paths:

- `requestText(...)` resolves and commits a dispatch containing the immutable built-in text contract;
- `requestBuiltInStructured(contractId, ...)` resolves and commits a dispatch containing one sealed built-in structured contract.

Both paths reuse the committed branch configuration, catalog-backed reasoning resolver, execution-endpoint identity, and call/effect relation checks already delivered by the predecessor. They do not create a second model-effect admission system. Ordinary `AgentRun` and internal refinement use the structured path. Diagnostic turns, admitted public recursive calls, and model-summary compaction use the text path. Model-backed completion gates remain unavailable.

The predecessor's reservation of the generic `model` executor remains in force: console `tools.request("model", ...)` is rejected before `EffectRequested`. Generated code reaches text models only through admitted `rlm` and child-session services. Console RPC and goal-effect admission reject reserved model dispatch fields, including `responseContract`, instead of forwarding arbitrary model input directly to the outbox. If a future gate needs structured model data, it must add a reviewed sealed built-in contract rather than accepting a caller-defined schema.

Model-summary compaction has no `ModelCallRequested` event, but it pins a complete text dispatch in `ContextCompactionRequested.modelDispatch`, and every hierarchy chunk copies it into `EffectRequested.input`.

### Normalized provider response

Providers normalize their native response into content blocks:

```ts
type ModelResponse = CompleteModelResponse | GuardAbortedModelResponse;

interface CompleteModelResponse {
  readonly kind: "complete";
  readonly blocks: readonly ModelResponseBlock[];
  readonly termination: {
    readonly kind:
      | "text-stop"
      | "tool-calls"
      | "output-limit"
      | "content-filter"
      | "refusal"
      | "other";
    readonly rawReason?: string;
  };
  readonly usage: Usage;
  readonly warnings: readonly ModelWarning[];
  readonly transport: {
    readonly provider: string;
    readonly adapter: string;
  };
}

interface GuardAbortedModelResponse {
  readonly kind: "guard-aborted";
  readonly blocks: readonly ModelResponseBlock[];
  readonly termination: {
    readonly kind: "adapter-guard";
    readonly code:
      | "multiple-tool-calls"
      | "unexpected-tool"
      | "oversized-tool-input"
      | "oversized-provider-response";
  };
  readonly usage: null;
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
      readonly inputDigest: `sha256:${string}`;
      readonly inputBytes: number;
    }
  | {
      readonly type: "invalid-tool-call";
      readonly callId?: string;
      readonly name?: string;
      readonly inputDigest?: `sha256:${string}`;
      readonly inputBytes: number;
      readonly code:
        | "malformed-arguments"
        | "truncated-arguments"
        | "oversized-arguments";
    };
```

The adapter uses a transient parsed call while it validates the selected tool input and constructs the result. The durable `tool-call` response block is evidence only and never contains the accepted input. A successful `ModelToolSubmission` below is the one durable copy of that validated input. Invalid or rejected calls retain only bounded metadata, digests, byte counts, and typed errors; no raw or bounded argument body is retained.

The shared adapter consumes only documented AI SDK results and stream parts. The pinned provider packages own native HTTP payloads, SSE framing, provider argument decoding, and finish-reason mapping. Agencity consumes AI SDK text start/delta/end, tool-input start/delta/end, `tool-call`, `finish`, `error`, and `abort` information; it never searches text for an action and never parses OpenAI or Anthropic wire envelopes itself.

The shared adapter normalizes the AI SDK's completed finish reason to `termination.kind`. A required-tool-set response is never accepted unless the completed SDK result reports tool-call termination and exactly one validated `tool-call` part. Output limits, content filters, refusals, SDK errors, aborts, interrupted streams, missing terminal completion, and other stop reasons follow the closed terminal classification below; none can commit an action accidentally.

Incomplete-stream detection uses one conservative fallback: a stream whose normalized finish reason is `other` and whose raw finish reason is absent records failed effect code `incomplete-provider-response`, even if the AI SDK exposes partial output or a synthetic finish event. This may reject an unusual legitimate `other` completion; the closed failure is preferable to accepting a partial structured result. Required-tool-set success still requires normalized `tool-calls` termination.

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

The adapter enforces these limits while consuming `streamText.stream`. Once a second call, unknown tool name, argument overflow, metadata overflow, or block overflow proves a violation, its private guard controller aborts the SDK request, stops accumulating argument bodies, and retains only scrubbed bounded summaries. The guard cause survives SDK `abort` and `AbortError` surfaces, so a proven violation cannot be reclassified as user cancellation. Tool names must match retained bounded names; call IDs and raw stop reasons are scrubbed and truncated; supplemental text retains bounded content or a digest plus byte count. Accepted tool input is retained exactly once in `ModelToolSubmission`; the durable response block carries only its digest and byte count. The complete normalized submission, metadata, and formal event encoding must fit `MAX_MODEL_FORMAL_RESPONSE_BYTES`. These transport limits do not replace the separate 256 KiB canonical action limit.

The model executor validates the transient completed call and resulting durable submission against the retained response contract:

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
      readonly inputBytes: number;
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
  | "provider-context-window-overflow"
  | "provider-request-failed"
  | "transport-failed"
  | "stream-failed"
  | "incomplete-provider-response";
```

`EffectOutcomeRecorded` gains optional bounded `modelFailure: { code: ModelEffectFailureCode }`, valid only for failed model effects. `ModelCallTerminated.failureCode` is required for a failed model call and must equal the effect's retained model-failure code. Cancellations and unknown outcomes do not synthesize one.

Terminal classification is deterministic:

- a known unsupported agent response contract fails before `AgentRunRequested` and before the initiating task `MessageAppended`; no run, step, context, model call, or effect is committed;
- known unsupported internal structured work, including refinement review, fails before `RecursiveModelStarted`;
- an SDK/API rejection or warning specifically identifying unsupported submitted tools or ignored strict enforcement records failed effect code `unsupported-response-contract`;
- a positively classified provider context-window overflow records `provider-context-window-overflow` and enters the predecessor's bounded compaction/overflow-retry path with the complete dispatch preserved;
- any other SDK/API request rejection records `provider-request-failed`; a transport failure records `transport-failed`; a stream `error` records `stream-failed`; and a stream ending without terminal completion, or conservatively ending with normalized `other` and no raw finish reason, records `incomplete-provider-response`;
- those failures are copied from `EffectOutcomeRecorded.modelFailure` to `ModelCallTerminated.failureCode` and never become action rejections;
- explicit outbox cancellation follows the existing cancelled-effect path; an adapter guard cause takes precedence over SDK abort or incomplete-stream classification, retains its originating contract violation in a successful bounded model-effect output, and never records cancellation;
- process loss after a non-idempotent model effect starts and before a durable outcome remains `unknown`;
- a completed tool-call termination with exactly one valid retained tool input records a tool submission;
- completed text-stop with no tool records `required-tool-missing`; multiple calls record `multiple-tool-calls`; an unknown name records `unexpected-tool`; malformed or schema-invalid input records `invalid-tool-input`; oversized input or total response records `oversized-tool-input` or `oversized-provider-response`; output-limit termination during tool input records `truncated-tool-input`; content filtering or a completed provider refusal records `provider-refusal`; and any other completed but structurally incomplete formal response records `incomplete-provider-response`.

For an `AgentRun`, a normalized `ModelContractViolation` records `AgentRunActionRejected` whether it came from completed provider termination or an adapter guard abort. It receives the existing one bounded correction step when budget permits. The correction request contains the exact typed violation and again requires exactly one call from the same retained tool set. It never asks for corrected JSON text. Failed, externally cancelled, or unknown effects do not consume the format-correction allowance.

A second consecutive rejection retains the current failed-run behavior. A provider HTTP/API failure remains a failed model effect rather than an action rejection. A lost started model effect remains `unknown`.

Guard-aborted responses have no provider usage. Their budget policy is deliberately simple and conservative:

- debit one turn and the measured wall time;
- debit tokens equal to the retained attempt's estimated input tokens plus its retained output-reserve tokens;
- retain `usageSource: "conservative-guard-estimate"` on the budget debit and `usage: null` on the guard-aborted response;
- retain `costUsd: 0` under the predecessor's existing best-effort cost semantics.

Normal complete responses retain `usageSource: "provider-reported"` and debit provider-reported usage as before. A conservative guard estimate may exhaust the budget and prevent the one correction call.

## Shared AI SDK execution

### One compiled request path

The existing `AiSdkModelProvider` shared options builder gains one response-contract branch. Given the committed dispatch, it:

1. preserves the predecessor's model, temperature, maximum output, top-level reasoning, endpoint, and credential behavior;
2. compiles each retained tool definition to an AI SDK `tool(...)` value with its description, `jsonSchema(retainedSchema, { validate: runtimeValidator })`, no `execute` callback, and `strict: true` only for a retained `provider-strict` contract;
3. sets top-level `toolChoice: "required"` for a required-tool-set contract;
4. applies only documented non-reasoning provider options needed to suppress parallel calls when the canonical model creator has such a control;
5. consumes exactly one AI SDK generation step and never uses `ToolLoopAgent`, `stopWhen`, a tool-result continuation, or provider-hosted execution.

The AI SDK's `toolChoice: "required"` requires tool use but does not by itself prove exactly one call. The shared core always performs final cardinality validation. It also requests the documented parallel-call suppression for creators supported by this release:

- canonical `openai/...` models use `providerOptions.openai.parallelToolCalls: false`;
- canonical `anthropic/...` models use `providerOptions.anthropic.disableParallelToolUse: true`;
- gateway execution uses runtime cardinality rejection unless a pinned Gateway service conformance fixture proves that the relevant creator-specific parallel-call option is accepted and enforced.

These provider options contain no reasoning setting and therefore cannot override the predecessor's top-level `reasoning` dispatch. The options merger rejects duplicate or reasoning-related fields rather than allowing one feature to silently replace another. Gateway and any creator whose pinned execution surface does not prove a parallel-call control are `runtime-rejected`: multiple calls remain a typed contract violation, not an execution path or text fallback.

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
}

interface ResolvedModelExecutionDescriptor {
  readonly transport: string;
  readonly model: string;
  readonly catalog: ModelDescriptor;
  readonly requiredAgentToolSet: RequiredToolSetCapability;
}
```

At implementation start, re-verify which gateway catalog fields authoritatively describe formal function tools, required tool choice, and strict schema support. Normalize only documented fields. If the catalog omits or ambiguously describes a tool capability, the model is `unknown`; absence is not converted into `unsupported` without an authoritative catalog contract. Strict support is claimed only when the model/catalog evidence and pinned-package fixture establish it. Otherwise a formal tool channel uses Agencity's runtime validation.

The pinned AI SDK packages and focused fixtures establish transport primitives: formal function tools, `toolChoice: "required"`, streaming tool-input parts, strict-option forwarding, and any creator-specific parallel-call control. The effective resolver is keyed by transport plus canonical model ID, combines the exact catalog entry with the verified transport primitive, and stores the resolved response contract and capability provenance in the dispatch before the model effect is committed. This cutover does not add transport-capability drift identities or cross-runtime compatibility handling; incompatible pre-release state is reset.

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

Known unsupported models cannot start new autonomous work. `AgentRunService.admit` performs this check before it commits the user's task message or `AgentRunRequested`, and returns the typed unavailable error without creating durable work. Internal structured operations perform the same check before child or effect admission. Unknown catalog or manually entered models may be attempted only when the selected transport implements proven formal AI SDK tool streaming with bounded input deltas; a provider rejection is retained as a failed effect and does not trigger a text fallback.

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

Provider tool submissions remain internal action history rather than assistant conversation.

## Durable events and projections

### Pre-release schema cutover

This feature performs a clean workspace event-schema cutover from version 2 to version 3. The implementation accepts version 3 only. Workspaces containing version 1 or version 2 events fail closed with explicit reset guidance; the runtime does not upcast, rewrite, import, synchronize, project, or recover them. Profile-owned model catalog caches may be discarded and rebuilt.

There is no mixed-version compatibility matrix, legacy text-action decoder, compatibility-only action variant, or pre-feature in-flight recovery path. The schema-version bump exists only to make stale local state fail before payload projection; it does not introduce a general event-version registry.

### Model request provenance

Replace `ModelCallRequested.modelDispatch` with the single response-contract-aware dispatch. Do not add a second top-level `responseContract`. Every agent-run call includes the complete required-tool-set contract and digest.

The byte-identical dispatch is part of the outbox effect input and idempotency agreement. Reuse with another model configuration, reasoning decision, endpoint identity, tool-set name, order, description, schema, strictness mode, selection rule, or digest conflicts.

### Durable model effect output

A successful model effect stores one complete bounded `ModelEffectOutputV2` in `EffectOutcomeRecorded.output`:

```ts
interface ModelEffectOutputV2 {
  readonly kind: "agencity.model-effect-output.v2";
  readonly response: ModelResponse;
  readonly result:
    | { readonly kind: "text"; readonly text: string; readonly textDigest: string }
    | { readonly kind: "tool-submission"; readonly submission: ModelToolSubmission }
    | { readonly kind: "contract-violation"; readonly violation: ModelContractViolation };
  readonly resultDigest: `sha256:${string}`;
}
```

The executor produces this value only after bounded normalization, schema validation, secret rejection/scrubbing, and terminal classification. `response.kind: "guard-aborted"` is valid only with `result.kind: "contract-violation"` and `response.usage: null`. `response.kind: "complete"` carries normal provider usage. `ModelCallCompleted` and `BudgetDebited` retain the corresponding `usageSource`; a conservative guard estimate uses the retained attempt input estimate and output reserve defined above. Recovery after `EffectOutcomeRecorded(succeeded)` derives `ModelOutputChunk`, `ModelCallCompleted`, budget debit, and any action event only from this retained output. It never reconstructs a submission from provider text, current source constants, or an uncommitted stream.

### Model completion provenance

Replace the text-only completion shape with one required normalized result:

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

Call IDs, tool input, termination metadata, supplemental text, and the complete canonical submission obey the formal-response bounds. `ModelOutputChunk` remains the committed text-output event for true text responses. Tool input is not a text chunk and does not enter `chunks`. `ModelCallCompleted.result` and its digest must equal the retained `ModelEffectOutputV2.result`.

Reducer and command validation are conditional on the one committed response contract:

- a `text` contract requires `result.kind: "text"`, a digest equal to the ordered committed text chunks, and the existing assistant response message bound to that same text;
- a `required-tool-set` contract requires exactly one `tool-submission` or `contract-violation` result and forbids `responseMessageId`;
- a tool submission or violation must match the response contract, response capability, configured transport, and adapter identity in the committed dispatch;

No assistant message is appended merely because the provider returned a tool call.

### Agent action events

Replace the text-action event shapes with required formal sources:

```ts
type AgentRunActionSource =
  | {
      kind: "tool-submission";
      modelCallId: string;
      providerToolCallId: string;
      resultDigest: `sha256:${string}`;
    }
  | {
      kind: "contract-violation";
      modelCallId: string;
      providerToolCallId?: string;
      resultDigest: `sha256:${string}`;
    };
```

- committed actions require `source.kind: "tool-submission"`;
- rejections, including no call, multiple calls, refusal, or incomplete termination, require `source.kind: "contract-violation"`;
- every source identifies the durable Agencity model call through `modelCallId` and its normalized result through `resultDigest`; `providerToolCallId` is required only for an accepted single submission and is optional diagnostic provenance for a violation;
- reducers validate each source against the matching `ModelCallCompleted.result` and committed response contract rather than `call.chunks.join("")`;
- action events retain only the call/result digest and the action-specific conversion needed by the run projection; they do not duplicate the complete tool input into `raw`, `formalSource`, and `AgentAction`;
- rejection `error` is the stable bounded message derived from the typed violation and is checked against it;
- the committed canonical `AgentAction` must equal the pure conversion of the submitted tool name and input.

`AgentRunStepState` stores formal action-source provenance and no `rawAction`. Increment `REDUCER_VERSION`; stale snapshots rebuild from version-3 events.

Every terminally accepted `finish` uses the stable message ID `agent-run-final-${run.id}`. Successful finish commits that message only after required gates pass. A failed or unknown success gate does not append the proposed success message. Blocked and failed finish atomically commit `MessageAppended` with the submitted message and `AgentRunStatusChanged` with the effective non-success status and `finalMessageId`. A failed status may still become goal-derived blocked under the existing precedence rule; the assistant message remains the model's exact submitted response while the status reason retains the attributable gate summary. Runtime-originated terminal outcomes without an accepted `finish` do not fabricate an assistant message.

Reducer validity allows `finalMessageId` for `succeeded`, `blocked`, or `failed` only when the terminal event is caused by an accepted `finish` and references the exact assistant message derived from that submission. Runtime-originated blocked/failed/cancelled/budget-exceeded/unknown outcomes must omit it.

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

Context-window overflow retries copy the complete dispatch byte-for-byte, including model configuration, reasoning, endpoint identity, and response contract. Compaction can change context, not any dispatch field.

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
- provider contract violation.

## Migrating other structured model output

The runtime has one other model path that asks for JSON in text and parses it: trajectory refinement.

Introduce a formal required tool:

```text
agencity_submit_refinement_review
```

Its input schema is derived from the existing strict `RefinementReviewDecision` domain contract. Replace `parseRefinementReview` with `validateRefinementReviewValue(value, request, sensitive, encodedBytes)`, preserving:

- review-ID binding;
- response and nested field byte bounds;
- brokered-secret rejection;
- visible-evidence authorization;
- editable-target and scope validation;
- proposal and decision fingerprint derivation.

`RefinerService` starts the child through the internal sealed `agencity.refinement-review.v1` contract. The complete response admission is committed in `RecursiveModelStarted` before child launch. A structured recursive completion writes `RecursiveModelStatusChanged.result` as a bounded typed JSON object containing `kind: "tool-submission"`, the contract ID/version/digest, child call ID, normalized submission, and submission digest; it forbids `resultMessageId`. Command validation binds that result to `RecursiveModelStarted.responseAdmission` and the child's matching `ModelCallCompleted.result`.

`RecursiveModelService` branches result recovery by the retained response admission. Text children preserve the existing assistant-message result path. Structured children use a private response-contract-aware execution mode instead of `ModelLoop.turn`, recover from the retained child model completion, recreate the same typed recursive result idempotently when needed, and never search child messages. Public `result` APIs return that typed JSON value. `RefinerService` consumes it through `validateRefinementReviewValue` and removes `parseRefinementReview` and `#rawResult`.

The refinement provider request contains only this one tool and requires one call. This is a specialized internal model operation, not an additional tool exposed beside the two ordinary agent tools.

Define one versioned, fully required refinement transport schema. Where domain fields are optional, the transport uses explicit absence sentinels and a pure normalization step removes them before domain validation. Fixtures prove normalization preserves omission semantics, decision fingerprints, proposal fingerprints, evidence checks, and authority checks. Do not fall back to textual JSON. Contract compilation, schema size, and strictness are covered by provider fixtures before rollout.

After this migration:

- `AgentRun` structure uses `bun_console` and `finish`;
- refinement structure uses `agencity_submit_refinement_review`;
- diagnostic recursive calls and model-summary compaction return text because their result is text;
- no runtime service parses model-generated JSON out of assistant prose.

## Integration with the completed reasoning architecture

The predecessor has already centralized model request construction and durable dispatch. This plan replaces that pre-release dispatch shape in place:

- one `ModelDispatch` requires the explicit response contract while preserving configuration, reasoning, and execution-endpoint identity;
- context identity and context-capacity provenance remain in their existing attributable call/context records rather than being duplicated inside the model dispatch;
- the shared AI SDK options builder combines top-level reasoning with formal tools and non-reasoning provider options;
- the shared result normalizer retains predecessor warnings, usage, directly returned gateway cost, bounded errors, and reasoning-part discard while adding tool submissions and contract violations;
- call/effect/compaction relation validators compare the complete dispatch byte-for-byte.

The adapter receives the complete committed dispatch and performs no fresh catalog or capability lookup. Known reasoning-and-tool incompatibilities fail during dispatch resolution. Unknown combinations follow the documented capability policy and never cause an automatic effort change, text fallback, transport change, or endpoint change.

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
- Freeze fixtures for the predecessor dispatch shape, all three transport factories, top-level reasoning, warnings, usage/cost, endpoint identity, streaming, and context-overflow classification.
- Re-verify the pinned AI SDK's `tool`, `jsonSchema`, `toolChoice`, per-tool strictness, `stream` tool-input events, OpenAI `parallelToolCalls`, Anthropic `disableParallelToolUse`, gateway provider-option forwarding, and finish-reason contracts.
- Re-verify the gateway catalog fields used to classify model-level formal-tool support. Record ambiguous or absent metadata as `unknown`, not unsupported.

### 1. Domain tool contract

- Add `BunConsoleInput`, `FinishInput`, their portable strict JSON Schemas, and `agentActionFromToolSubmission`.
- Add `validateAgentActionValue` for the formal conversion and 256 KiB canonical-action bound.
- Add immutable tool-set names, descriptions, order, version, schema digests, and contract digest.
- Keep `AgentAction` as the canonical domain action.
- Add unit tests for every tool and variant, unknown fields, empty values, formal/canonical byte limits, schema digest stability, and conversion equality.
- Replace `AGENT_ACTION_POLICY` with the formal tool-selection prompt and remove `parseAgentAction`.
- Remove clarification/permission action variants and all pending-input domain types.

### 2. Provider-neutral response contracts

- Add `ModelResponseContract`, complete and guard-aborted response variants, evidence-only normalized response blocks, single-copy tool submissions, and contract violations.
- Replace the predecessor dispatch with the single response-contract-aware `ModelDispatch`.
- Add total block, call-summary, call-ID, termination-reason, supplemental-text, evidence, and formal-response bounds with streaming enforcement.
- Add the append-only sealed built-in structured-contract registry and exact historical-definition validation; do not expose arbitrary contract definitions through public SDK or protocol inputs.
- Add `ModelEffectAdmissionService` over the predecessor's dispatch resolver as the sole owner of text versus sealed structured model-effect admission.
- Keep generic console model effects reserved; route admitted recursive text calls through text admission and reject reserved dispatch fields.
- Put the exact dispatch into model-call, compaction, and effect records.
- Define and validate the exact bounded `ModelEffectOutputV2` stored by a successful model effect, including the guard-aborted/contract-violation pairing and conservative usage attribution.
- Generalize `ModelProvider.complete/stream` and `ModelExecutor` beyond text-only output.
- Make text and required-tool-set paths explicit.
- Add transport-independent catalog tool facts, a transport-keyed resolved execution descriptor, response-contract capability reporting, proven structured-stream admission, and typed unavailable errors.
- Preserve reasoning dispatch, warnings, cost, concurrency, cancellation, secret scrubbing, progress bounds, usage, endpoint identity, and context-window classification.

### 3. Shared AI SDK integration

- Extend the existing shared AI SDK options builder to compile committed tools through `jsonSchema(..., { validate })`, `toolChoice: "required"`, committed strictness, and proven creator-specific parallel-call suppression without setting reasoning-related provider options.
- Run every required-tool-set call through `streamText`, consume bounded `stream` parts, apply the conservative `other`-without-raw-reason incomplete fallback, and never expose partial arguments.
- Compose an adapter-owned guard controller with outbox cancellation; preserve the first abort source so guard violations cannot become cancellations.
- Store accepted tool input exactly once in `ModelToolSubmission`; durable response evidence retains only call ID, name, digest, and byte count.
- Treat an SDK warning or rejection that says strict enforcement was ignored or unsupported as failed `unsupported-response-contract`.
- Preserve the existing `vercel`, `openai`, and `anthropic` factories; add no provider-native adapter or gateway-surface selector.
- Normalize text, valid tool calls, invalid calls, finish reasons, warnings, usage, gateway cost, and bounded errors from AI SDK results.
- Add pinned-package wire conformance fixtures for gateway, direct OpenAI, and direct Anthropic, including reasoning-plus-tools combinations and canonical/native model IDs. Gateway remains runtime-cardinality-validated unless a service fixture proves creator-specific parallel suppression.
- Convert Echo and scripted providers to formal submissions.

### 4. Durable model and action events

- Raise the workspace event schema to version 3 and reject version-1/version-2 workspaces with reset guidance.
- Replace `ModelCallRequested.modelDispatch`, `ModelCallCompleted`, `ModelCallTerminated`, `EffectOutcomeRecorded`, `BudgetDebited`, `RecursiveModelStarted`, `ContextCompactionRequested.modelDispatch`, recursive/model-call state, and action events with the formal contract/submission/violation and usage-attribution shapes.
- Update reducers, event validation, storage rows, snapshots, sync envelopes, export, historical projection, workspace-material classification, and protocol types.
- Enforce contract-specific completion shapes, result-digest linkage, and the closed effect-versus-contract-violation outcome mapping.
- Increment `REDUCER_VERSION`.
- Add version-3 duplicate, conflicting-idempotency, branch, rebuild, sync, and exact effect-output recovery fixtures.
- Add reset-guidance tests proving version-1 and version-2 workspaces never reach projection or execution.

### 5. AgentRun integration

- Reject a known unsupported required-tool-set contract before committing the initiating task message or `AgentRunRequested`.
- Build every run model effect with the `bun_console` and `finish` tool set.
- Remove raw action schema text from `agentProviderContext`.
- Require exactly one call from the set, convert it to a canonical action, and commit before action application.
- Map `bun_console` to the existing cell action and `finish` to successful, blocked, or failed terminal decisions.
- Route questions that prevent progress through blocked `finish` messages.
- Remove `waiting_for_user`, clarification/permission actions, pending-input events, run-input routes, client methods, TUI interception, and family-activity reasons.
- Materialize blocked and failed `finish` messages as stable assistant messages atomically with their terminal status.
- Keep runtime-originated cancellation, budget, unknown-effect, and gate-failure outcomes outside model-selectable `finish` statuses.
- Convert contract violations into bounded action rejections.
- Update the correction instruction and preserve the one-attempt correction limit.
- Preserve goal-gate repair, ordinary subsequent user instructions, budgets, cancellation, overflow retry, unknown outcomes, and stable cells.

### 6. Specialized structured outputs

- Add supervisor-selected sealed required-tool-set contracts to recursive model calls.
- Define `agencity_submit_refinement_review`.
- Add a private structured-child execution path, return typed recursive results through `RecursiveModelStatusChanged.result`, bind them to the child model completion, and keep structured recovery independent of assistant messages.
- Persist `responseAdmission` in the mutable recursive-handle projection through a numbered migration and update `docs/mutable-tables.md`.
- Extract `validateRefinementReviewValue` and reuse every existing review-ID, evidence, scope, secret, byte-bound, and fingerprint check.
- Replace `RefinerService.#rawResult` and textual `parseRefinementReview` with formal tool input validation.
- Add the fully required transport schema and lossless absence normalization before domain validation.

### 7. Product and observability surfaces

- Add agent-tool-set capability to `/capabilities`, provider/model selection, status, and raw diagnostics.
- Show actionable unavailable reasons without exposing internal IDs by default.
- Keep tool-argument streaming internal and retain compact active-run progress.
- Distinguish formal submissions and contract violations in inspectors.
- Add bounded counters for tool contract success and violations without storing credentials or unbounded provider bodies.

### 8. ADRs and documentation

- Add a new ADR that supersedes ADR 0005's textual JSON transport, clarification/permission lifecycle, and success-only final-message linkage while preserving strict typed admission and the single-TypeScript execution surface.
- Mark ADR 0005 as superseded and retain it as historical context.
- Update `AGENTS.md`, `README.md`, `docs/architecture.md`, `docs/api.md`, `docs/protocol.md`, `docs/events.md`, `docs/recovery.md`, `docs/security.md`, `docs/capabilities.md`, `docs/console-sdk.md`, `docs/user-guide.md`, `docs/verification.md`, `docs/operator-guide.md`, `docs/configuration.md`, `docs/data-lifecycle.md`, `docs/mutable-tables.md`, and `docs/decisions/0001-durable-local-runtime-foundations.md`.
- Verify that `docs/decisions/README.md` retains ADR 0010 and ADR 0005's supersession relationship; do not rewrite superseded ADR 0005's historical decision text.
- State clearly that the provider `bun_console` tool and its injected SDK are different layers.
- Remove public wording that describes raw action JSON as the current product protocol after rollout.

## Test strategy

### Domain and schema

- Every agent tool and input variant maps to the intended canonical `AgentAction`.
- Each tool schema has a root object, required fields, and `additionalProperties: false` on every object; the finish union uses portable nested `anyOf`.
- Both schemas compile together through the pinned AI SDK for gateway, direct OpenAI, and direct Anthropic fixtures.
- Tool-set names, descriptions, order, schemas, version, and digests are stable.
- Tampered names, descriptions, order, schemas, strictness, or digests fail before execution.
- A normal successful `finish` omits status, while blocked and failed require their explicit enum value.
- Empty, oversized, unknown, mismatched, and malicious inputs fail before execution.
- Every textual or structured call uses the one dispatch shape with an explicit contract.
- Action-source fixtures require `modelCallId` and `resultDigest`, require `providerToolCallId` for accepted submissions, and permit it to be absent for no-call and multi-call violations.
- Version-1 and version-2 workspace events fail with reset guidance before projection.

### Shared AI SDK adapter

- The shared options builder supplies both retained tools, top-level `toolChoice: "required"`, the retained per-tool strictness, and no `execute` callbacks on every product transport.
- Every retained JSON Schema is compiled through `jsonSchema(..., { validate })`; plain JSON objects and schema wrappers without runtime validation are rejected by fixtures.
- OpenAI-created requests set documented parallel-call suppression; Anthropic-created requests set documented parallel-call suppression; gateway requests preserve slash-containing model IDs and use runtime cardinality rejection unless service conformance proves suppression.
- Exact pinned-package wire fixtures prove native strictness, required choice, direct-transport parallel suppression, model-ID derivation, and reasoning without production code constructing those payloads.
- Required-tool-set calls use `streamText` internally on every transport; text contracts preserve the predecessor's streaming and non-streaming behavior.
- The adapter accepts completed inputs only from AI SDK `tool-call` parts and never parses provider-native tool envelopes.
- Each of `bun_console` and `finish` is accepted when selected alone.
- A required-tool-set response is accepted only when the AI SDK reports completed tool-call termination.
- Normalized `other` termination without a raw finish reason records `incomplete-provider-response`, including when partial output or a synthetic SDK finish is present.
- A syntactically complete call paired with output-limit, content-filter, refusal, interrupted, missing-terminal, or other incompatible termination executes nothing.
- Text containing valid-looking action JSON with no tool call is rejected.
- One valid tool call plus narration accepts the tool call and treats narration as diagnostic only.
- Zero, duplicate, parallel, wrong-name, malformed, oversized, and truncated calls execute nothing.
- Provider refusals and unsupported tool contracts remain distinct.
- A strict-schema unsupported/ignored warning or rejection fails as `unsupported-response-contract` and never downgrades or retries in text mode.
- Formal arguments and supplemental text containing a known secret are scrubbed or rejected without the value entering events, progress, logs, snapshots, or errors.
- `provider-strict` and `runtime-validated` requests differ exactly in provider enforcement fields while retaining identical domain validation.
- Block-count, call-ID, termination-reason, supplemental-text, violation-evidence, total-response, tool-input-delta, and canonical-action limits have exact-boundary and one-byte-over tests; oversized streamed input triggers the adapter guard at the first observed breach and remains a contract violation.
- Accepted tool input appears exactly once in `ModelEffectOutputV2`; response evidence contains only its digest and byte count, and invalid-call evidence contains no raw or bounded argument body.
- Every selectable effort is combined with each structured contract on gateway, direct OpenAI, and direct Anthropic fixtures; tool options never replace or add a reasoning-related provider option.
- Existing warning normalization, directly returned gateway cost, direct-transport zero-cost fallback, reasoning-part discard, and error classification remain unchanged.

### Runtime and recovery

- A `bun_console` submission commits before its stable cell starts and preserves exact multiline source.
- A successful `finish` appends only its message after required completion gates pass.
- Blocked and failed `finish` calls append their exact message as the final assistant response atomically with the effective terminal status.
- A failed completion gate returns an observation and permits repair instead of committing success.
- A successful `finish` with a failed or unknown required gate does not append its proposed success message; an unknown gate terminates as `unknown`.
- A `finish` with `status: "failed"` after an unresolved failed required gate terminates as goal-derived `blocked`; the same call without that gate history terminates as `failed`.
- A blocked `finish` can ask a necessary question in the visible final assistant response, ends the current run, and leaves the same durable branch ready for an ordinary subsequent user instruction.
- The domain has no clarification or permission actions, pending-input events, run-input route, or `waiting_for_user` state.
- Blocked and failed `finish` submissions preserve typed visible terminal outcomes except that an unresolved failed required gate retains the existing goal-derived blocked precedence.
- Model-selectable tools cannot claim runtime cancellation, budget exhaustion, or unknown-effect outcomes.
- A contract violation is delivered exactly once to one formal correction step.
- Missing-call, multiple-call, refusal, incompatible-termination, and malformed-call rejections each retain one bounded canonical violation source without fabricating a tool submission or retaining rejected raw argument bodies.
- SDK/API rejection, stream error, external cancellation, guard abort, process loss, completed refusal, output-limit truncation, and successful tool termination follow the closed effect-versus-violation classification without double-finalization.
- Adapter guard aborts retain their originating violation; only an external/outbox abort records cancellation.
- Guard-aborted responses retain `usage: null`; their budget debit uses one turn, measured wall time, and the retained input estimate plus output reserve with `usageSource: "conservative-guard-estimate"`.
- Failed model effects retain the same `ModelEffectFailureCode` in `EffectOutcomeRecorded.modelFailure` and `ModelCallTerminated.failureCode`, including recovery between those commits.
- Text completion requires a matching chunk/message digest; structured completion requires exactly one submission or violation and forbids a response message.
- A second consecutive violation fails the run without executing either submission.
- Budget exhaustion can prevent the correction call as it does today.
- Crash boundaries before request, after request, during provider execution, after effect outcome, after model completion, after action commit, and during cell execution preserve current guarantees.
- A crash after a blocked or failed action commit produces exactly one stable assistant message and terminal status; the atomic event batch cannot leave only one of them committed.
- Context overflow retries retain an identical complete dispatch.
- A structured recursive child interrupted before its first model call recovers the exact response contract and capability seed from `RecursiveModelStarted`.
- Diagnostic `ModelLoop`, public recursive calls, and model-summary compactions use explicit `text` contracts and retain unchanged textual results.
- Model-backed goals remain unavailable; generic console `tools.request("model", ...)` remains rejected while admitted `rlm` calls use text contracts.
- Version-3 histories rebuild, branch, synchronize, and recover deterministically.

### Refinement

- Refinement requests contain only the required `agencity_submit_refinement_review` tool.
- No-change and proposal submissions preserve current fingerprints, evidence checks, authority, validation, activation, and rollback behavior.
- Structured completion writes one typed `RecursiveModelStatusChanged.result`, no assistant result message, and recovery reconstructs it from the matching child model completion without message lookup.
- Textual JSON without a formal tool call is rejected.
- The old textual review parser is removed.
- Schema compilation failure is visible and never causes a text fallback.

### Protocol and TUI

- Public capabilities report strict, runtime-validated, unknown, and unavailable agent-tool-set states.
- Unsupported models fail before run admission when known; no initiating task message, `AgentRunRequested`, model request, or effect is committed.
- Agent-run tool deltas never appear as conversation prose.
- Committed TypeScript source and observations remain expandable.
- `/raw` distinguishes formal submissions and contract violations.
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
10. a pre-cutover database fails before projection with explicit reset guidance;
11. a model without formal tool capability fails truthfully before run admission, commits no task message or run, and has no prompt-JSON fallback;
12. refinement uses a formal structured submission rather than assistant JSON text;
13. a missing-information question appears in a blocked `finish` assistant response, and the user's later response is an ordinary subsequent instruction;
14. blocked and failed `finish` calls produce distinct non-success exits;
15. a failed success gate returns the run to `bun_console` repair before a later successful `finish`.

Credential-gated real-provider smoke tests must cover one supported model on each configured transport: gateway, direct OpenAI, and direct Anthropic. Pass, fail, and skip counts remain separate; a skipped transport is not verified.

## Acceptance criteria

The migration is complete when:

- every `AgentRun` model effect contains one committed dispatch with the required-tool-set response contract;
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
- known unsupported agent contracts fail before run admission and leave no partial durable run;
- guard-aborted responses retain partial provenance without invented provider usage and receive the conservative budget debit;
- accepted tool input is retained exactly once, and no rejected raw argument body enters durable output;
- streaming tool arguments remain provisional and non-executable;
- recovery preserves exact complete dispatches and does not duplicate model calls or actions;
- version-1 and version-2 workspace histories are rejected with reset guidance and never executed;
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

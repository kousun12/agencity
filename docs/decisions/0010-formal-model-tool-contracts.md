# ADR 0010: Formal model tool contracts

- **Status:** Accepted
- **Date:** 2026-08-08
- **Scope:** Autonomous model response transport, run-control submissions, and pre-release compatibility
- **Extends:** [ADR 0001](./0001-durable-local-runtime-foundations.md)
- **Supersedes:** [ADR 0005](./0005-typed-autonomous-actions.md)

## Context

Autonomous model steps return structured decisions, not ordinary assistant prose. Encoding those decisions as JSON inside text makes action identity depend on formatting and encourages unsafe fallback parsing even though model providers expose a formal tool-call channel.

Agencity also does not need a dedicated pending-input protocol. Missing information is a terminal condition for the current run. The user can provide the information in a later ordinary instruction on the same durable branch.

Structured trajectory refinement has the same transport requirement. A refinement result is typed data consumed by the supervisor, so it must not depend on an assistant-message JSON parser.

The repository is pre-release and has no retained user-data compatibility commitment. This architecture therefore uses an explicit reset boundary rather than preserving obsolete event, dispatch, action, or input-state semantics.

## Decision

### Provider tools and console APIs

Every autonomous model step declares exactly this fixed provider tool set and requires exactly one completed call:

- `bun_console` submits one multiline Bun JavaScript or TypeScript notebook cell and continues the run;
- `finish` submits the user-facing message and ends model-directed work as successful, blocked, or failed.

These tools are declaration-only response channels. They have no AI SDK `execute` callbacks, do not run at the provider, and do not produce a provider-managed `tool_result` continuation or multi-step tool loop. The provider returns a candidate call; Agencity normalizes, bounds, validates, and durably records the response before applying it.

Only an accepted `bun_console` call can lead to execution. Its cell is committed as a canonical action before a disposable Bun worker runs it. `tools`, `sql`, `state`, `cells`, `artifacts`, `rlm`, `sdk.memory`, `sdk.agents`, `sdk.harness`, skills, goals, and related names are APIs injected into that later cell. They are not provider tools.

### Cardinality and validation

The response contract, capability decision, model configuration, catalog provenance, and execution endpoint commit in `ModelCallRequested` before provider execution. A structured response is valid only when it terminates compatibly with exactly one permitted, complete, schema-valid call. Zero, multiple, unknown, malformed, truncated, oversized, refused, filtered, or incomplete calls are typed contract violations and execute nothing.

Supplemental provider narration is bounded diagnostic evidence only. It is never treated as the submitted answer, searched for JSON or TypeScript, or executed. There is no text-JSON, fenced-code, or TypeScript fallback.

Tool-input stream deltas are provisional and private. Stream callbacks may report only bounded phase, sealed tool name, or byte-count progress. They cannot execute, enter conversation history, or become durable accepted input. Text operations whose result is genuinely text may continue to stream provisional text.

Model requests use declaration-only tools and one generation. There is no provider-hosted execution, provider-managed action loop, or tool-result continuation.

### Finish and completion gates

`finish` omits status for normal success. `blocked` means a concrete external requirement or missing information prevents progress. `failed` means bounded recovery attempts could not produce a safe completion.

A successful `finish` is provisional until every required completion gate passes against attributable workspace state. Passed gates atomically materialize the exact submitted assistant message and successful status. Failed gates return bounded repair evidence without publishing the proposed success message. An unknown required gate terminates unknown without publishing it.

Blocked and failed `finish` calls atomically materialize their exact submitted assistant message with the effective terminal run status. A failed finish after an unresolved required-gate failure becomes goal-derived blocked while retaining the model's exact submitted message. Runtime-originated cancellation, budget exhaustion, model failure, unknown effect, or correction exhaustion does not fabricate an assistant message.

Missing user information is stated in a blocked message. A later user message starts an ordinary new run on the same branch. There is no pending-input protocol, clarification or permission model action, request-input route, or waiting-for-user state.

### Durable schema and recovery

The accepted workspace event schema is version 3 and the reducer is version 11. Version-1 and version-2 workspaces are rejected with reset guidance before product migration, row decoding, projection, synchronization ingestion, or recovery. They are not upcast or reinterpreted.

The retained model dispatch is `agencity.model-dispatch.v2`, and the authoritative successful effect output is `agencity.model-effect-output.v2`. One complete accepted tool input is retained in that effect output. `ModelCallCompleted`, `AgentRunActionCommitted`, and `AgentRunActionRejected` use result and input digests, provider call identity, and model-call references instead of copying the input. Rejected raw arguments are never retained in events, logs, artifacts, diagnostics, or progress.

Stable run, step, context, call, effect, action, and cell identities make committed boundaries recoverable. A pending model request may drain once; a committed terminal effect is finalized without another provider call; a lost started non-idempotent call becomes `unknown`; an accepted action is applied without resubmission; and an interrupted cell is abandoned rather than replayed.

The adapter distinguishes external cancellation from its own guard aborts. External cancellation records a cancelled effect. A guard abort caused by an oversized, duplicate, unknown, or otherwise invalid formal response retains the originating contract violation and cannot be reclassified as cancellation.

### Structured refinement

Trajectory refinement uses a separate sealed internal contract, `agencity.refinement-review.v1`, with exactly one required `agencity_submit_refinement_review` tool. Its closed transport schema requires every field and preserves absence separately from null, empty arrays, and empty objects before normalization.

This contract is supervisor-selected for a durable recursive child. Public recursive model calls remain text operations. `RecursiveModelStarted.responseAdmission` retains the exact contract and capability seed, and migration 015 adds that rebuildable projection field. A successful structured child writes no result assistant message. It returns a normalized typed recursive result bound to the response admission, exact child model completion, provider tool-call identity, model-result digest, transport-input digest, and byte count. Recovery reconstructs that result from the authoritative effect and retained admission. There is no assistant JSON parser or prose fallback.

### Capability and security boundaries

Capability reporting distinguishes `provider-strict`, `runtime-validated`, `unknown`, and `unavailable`. Transport primitives and exact model support are separate facts. The shipped transports prove the formal streaming primitives, but the ordinary public model catalog does not authoritatively prove exact-model formal-tool support; those models normally remain `unknown`. Known unsupported combinations reject before root-run or runnable-child admission. Missing credentials remain a separate usability fact. No failure changes transport, schema enforcement, model, or response mode.

Formal declarations are not a sandbox. Generated TypeScript retains the trusted-local operating-system authority established by ADR 0001. Provider credentials remain supervisor-side. Product adapters validate and scrub structured output; a custom provider's complete structured output is scanned across every field for registered or credential-shaped material and fails closed before return or persistence.

## Consequences

- Provider-native tool identity, not assistant prose, determines the submitted action.
- The TypeScript console remains the one general generated-execution surface.
- Questions and missing information produce visible blocked terminal responses without a second input protocol.
- Successful completion never publishes ahead of required gate evidence.
- Blocked and failed `finish` submissions link their exact assistant message to the terminal run; runtime-originated terminal outcomes do not fabricate one.
- Contract violations may receive one bounded formal correction step, but no prompt-JSON fallback.
- The accepted input has one durable full copy; derivative records and diagnostics stay bounded and digest-linked.
- Pre-release schema changes use an explicit reset boundary instead of compatibility code.
- Strict provider schemas improve reliability where authoritatively supported, while Agencity validation remains authoritative.
- Capability truth may remain `unknown` for an exact model even when the transport is usable.
- Structured refinement is recoverable without creating a synthetic assistant message.

## Rejected alternatives

1. **Use a provider-managed tool loop.** Rejected because provider execution and `tool_result` continuation would bypass Agencity's commit-before-application, outbox, budget, and recovery boundaries.
2. **Expose arbitrary public tool schemas or every SDK operation as a provider tool.** Rejected because it would split execution across privileged surfaces with different durability semantics and make the model-facing contract open-ended.
3. **Keep structured JSON in assistant text or parse fenced TypeScript as fallback.** Rejected because formatting heuristics make action identity ambiguous and can turn narration or partial output into executable intent.
4. **Add clarification, permission, approval, or request-input provider tools.** Rejected because blocked `finish` plus a later ordinary instruction is sufficient and keeps run control smaller.
5. **Preserve pre-release event and dispatch histories.** Rejected because there are no released compatibility commitments; reset guidance is simpler and safer than a legacy decoder.
6. **Treat every SDK abort as cancellation.** Rejected because an adapter guard abort represents a proven contract violation, not user intent.

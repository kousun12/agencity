# ADR 0010: Formal model tool contracts

- **Status:** Accepted
- **Date:** 2026-08-08
- **Scope:** Autonomous model response transport, run-control submissions, and pre-release compatibility
- **Extends:** [ADR 0001](./0001-durable-local-runtime-foundations.md)
- **Supersedes:** [ADR 0005](./0005-typed-autonomous-actions.md)

## Context

Autonomous model steps return structured decisions, not ordinary assistant prose. Encoding those decisions as JSON inside text causes otherwise valid work to be rejected for narration, truncation, or formatting differences even though model providers expose a formal tool-call channel.

Agencity also does not need a dedicated pending-input protocol. Missing information is a terminal condition for the current run. The user can provide the information in a later ordinary instruction on the same durable branch.

The repository is pre-release and has no retained user data compatibility commitment. Architecture cutovers may reject old local state with reset guidance instead of preserving obsolete event, dispatch, action, or transport semantics.

## Decision

Every autonomous model step requires exactly one provider-native call from this fixed tool set:

- `bun_console` submits one multiline Bun JavaScript or TypeScript notebook cell and continues the run;
- `finish` submits the user-facing message and ends model-directed work as successful, blocked, or failed.

`bun_console` is the only executable provider tool. Shell, files, SQL, models, subagents, memory, skills, state, artifacts, and refinement remain typed APIs inside the console. A submitted cell is validated and committed before execution.

`finish` omits status for normal success. `blocked` means a concrete external requirement or missing information prevents progress. `failed` means bounded recovery attempts could not produce a safe completion. Missing user information is stated in the blocked message; a later user message creates an ordinary new run. There are no clarification, permission, approval, request-input, or waiting-for-user model actions or run states.

Provider text accompanying a formal tool call is diagnostic only. It is never searched for JSON or code, appended as the submitted answer, or executed. A structured operation with no valid permitted call is a typed contract violation.

Model requests commit their response contract before provider execution. Provider results are normalized, bounded, validated, and durably recorded before action application. Tool-input deltas remain provisional and never execute directly from a stream callback.

The adapter distinguishes external cancellation from its own guard aborts. External cancellation records a cancelled effect. A guard abort caused by an oversized, duplicate, unknown, or otherwise invalid formal response retains the originating contract violation and cannot be reclassified as cancellation.

The formal-tool cutover raises the accepted pre-release workspace event schema to version 3. Version-1 and version-2 workspaces are rejected with reset guidance and are not upcast, projected, synchronized, or recovered. The implementation carries one response-contract-aware model dispatch shape and no legacy text-action decoder.

## Consequences

- Provider-native tool identity, not assistant prose, determines the submitted action.
- The TypeScript console remains the one general generated-execution surface.
- Questions and missing information produce visible blocked terminal responses without a second input protocol.
- Blocked and failed `finish` submissions may link their exact assistant message to the terminal run; runtime-originated terminal outcomes do not fabricate one.
- Contract violations may receive one bounded formal correction step, but no prompt-JSON fallback.
- Pre-release schema changes use explicit reset boundaries instead of compatibility code.
- Strict provider schemas improve reliability where supported, while Agencity validation remains authoritative.

## Rejected alternatives

1. **Keep JSON in assistant text.** Rejected because transport formatting consumes calls, latency, and budget without adding safety.
2. **Add clarification, permission, or request-input tools.** Rejected because blocked `finish` plus a later ordinary instruction is sufficient and keeps run control smaller.
3. **Expose each runtime capability as a provider tool.** Rejected because it would split execution across privileged surfaces with different durability semantics.
4. **Preserve pre-release event and dispatch histories.** Rejected because there are no released users or compatibility commitments; reset guidance is simpler and safer.
5. **Treat every SDK abort as cancellation.** Rejected because an adapter guard abort represents a proven contract violation, not user intent.

Formal tool contracts validate transport shape, not code safety. Generated TypeScript retains the trusted-local authority of the Agencity process.

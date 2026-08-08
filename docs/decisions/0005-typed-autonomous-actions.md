# ADR 0005: Typed autonomous actions

- **Status:** Superseded
- **Date:** 2026-08-07
- **Scope:** Autonomous model action protocol and executable action boundary
- **Extends:** [ADR 0001](./0001-durable-local-runtime-foundations.md)
- **Superseded by:** [ADR 0010](./0010-formal-model-tool-contracts.md)

## Context

This record describes the implemented pre-formal-tool architecture. ADR 0010 replaces its textual JSON transport, clarification/permission lifecycle, waiting-for-user state, and success-only message-linkage rule. The strict admission boundary and single TypeScript execution surface remain in force.

An autonomous run must distinguish executable work from user-facing text and from supervisor control decisions. Heuristically extracting code from model prose would make execution ambiguous, weaken attribution, and make validation and recovery depend on formatting guesses. Giving the provider a separate tool for every runtime capability would also split the programming model into privileged paths with different durability semantics.

## Decision

Each autonomous step asks the model for exactly one strict `agencity.agent-action` version-1 JSON object. The accepted action types are:

- `typescript`, containing one TypeScript cell;
- `final`, containing proposed user-facing completion text;
- `clarification`, containing a question;
- `permission`, containing a permission name and question;
- `blocked`, containing a reason; and
- `failed`, containing an error.

The parser rejects Markdown fences, prefix or suffix prose, malformed JSON, unsupported versions, unknown action types, and unknown fields. Raw provider output and either the validated action or rejection remain attributable durable history. Raw action encoding is not an assistant conversation message.

`typescript` is the only executable model action. File, shell, read-only SQL, state, artifacts, model calls, durable delegation, skills, memory, and refinement access are typed SDK operations inside that cell. The runtime records and validates the action before applying it. A committed cell boundary and its effects follow the durable console and outbox rules from [ADR 0001](./0001-durable-local-runtime-foundations.md).

`final`, `clarification`, `permission`, `blocked`, and `failed` are supervisor run-control actions, not executable provider tools. Only an accepted `final` that satisfies applicable completion gates appends the user-visible assistant message. Clarification and permission create durable waiting-for-user state. Cancellation, budget exhaustion, unknown recovery, and gate failure are supervisor outcomes and cannot be invented as successful completion by provider prose.

Stable run, step, context, call, action, cell, effect, and input identities make action application recoverable. Committed observations are delivered to one dependent step. Recovery reuses retained action and effect outcomes rather than asking the provider or executing a cell again.

## Consequences

- Model output is either validated data or rejected evidence; unstructured text is never executed.
- The TypeScript console remains the one general programmatic action surface.
- Run control stays typed and inspectable without expanding the model's privileged tool set.
- Clients can render validated final text separately from raw provider encoding and cursorless progress.
- Adding or changing an action meaning requires an explicit protocol-version decision and compatibility tests.
- Strict output requirements may reject otherwise understandable model responses, but rejection is safer than heuristic execution.

## Rejected alternatives and limitations

1. **Extract code blocks or infer intent from prose.** Rejected because formatting heuristics are ambiguous and unsafe to replay.
2. **Expose shell, files, SQL, delegation, and models as parallel provider tools.** Rejected because TypeScript and the typed SDK are the single generated-execution surface.
3. **Treat a provider's completion claim as proof.** Rejected because completion gates require attributable evidence.
4. **Render streamed action bytes as assistant conversation.** Rejected because partial bytes may be invalid, fail, or encode an executable action rather than user-facing text.

The protocol does not make model output correct or generated code safe. TypeScript executes within the trusted-local authority boundary, and invalid action output can still leave a run failed or blocked.

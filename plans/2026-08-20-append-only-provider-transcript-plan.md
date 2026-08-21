# Append-only autonomous provider transcript plan

**Status:** Implemented and deterministically verified
**Date:** August 20, 2026
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)
**Related specifications:** [Agent context and observation efficiency](./2026-08-09-agent-context-efficiency-plan.md) and [Formal model tool contracts](./2026-08-07-formal-model-tool-contracts-plan.md)

## Summary

Each autonomous run uses a bounded provider transcript whose messages grow by append until an attributable context-compaction boundary starts a new segment. A later request in the same segment retains every earlier provider-visible message byte-for-byte, then appends the accepted assistant tool call or bounded contract-violation outcome, the exact-once durable observation, any attributable context update, and the next run-step instruction.

Direct OpenAI requests use a deterministic session-and-branch cache key, explicit cache mode, a 30-minute TTL, and explicit breakpoints on each supported next-action input-text block. Provider storage and previous response IDs remain disabled. Function-call outputs remain native tool results and are not relied upon as cache-write boundaries.

## Goals

- Make each adjacent pre-compaction provider transcript a strict append-only extension.
- Preserve native or equivalent `bun_console` and `finish` tool-call and tool-result semantics across supported providers.
- Keep estimation, execution, retention, and recovery on one exact versioned provider-input candidate.
- Retain exact cache controls and cache read/write usage.
- Reset the transcript once at a derived compaction boundary and resume append-only growth.
- Preserve canonical events, outbox execution, exact-once observation delivery, formal tool validation, and trusted-local security boundaries.

## Non-goals

- Provider-side response storage or `previous_response_id`.
- Rewriting canonical history during compaction.
- Paid or credentialed benchmark execution.
- Making provider cache hits a correctness dependency.
- Preserving pre-release workspaces across the provider-input and event-schema cutover.

## Provider transcript contract

A transcript segment contains:

1. the exact effective system prompt and durable conversation inputs;
2. one stable, attributable segment context block;
3. one volatile run-step instruction;
4. for each continued step, an appended assistant tool call or bounded violation outcome;
5. one appended durable tool observation or equivalent observation message;
6. an appended context update when the derived durable projection changed;
7. the next volatile run-step instruction.

Earlier messages are never rebuilt because an ordinal, deadline, budget, observation, working value, artifact, or repository instruction changed. Context changes enter only through newly appended records.

The `agencity.provider-input.v2` candidate retains a provider-neutral message union for text, assistant tool calls, and tool results. It also retains cache mode, key, TTL, and explicit breakpoint metadata as part of the serialized request contract. Tool declarations and their ordering remain fixed by the formal response contract. The exact candidate drives estimation, execution, and recovery.

Direct OpenAI uses the Responses API with `store: false`, no `previous_response_id`, and no parallel tool calls. In very long segments, the provider currently considers up to its 50 most recent breakpoints for cache reads. Previously retained breakpoints are read-only, and only the latest four breakpoints may write on one request. Provider-reported cache read/write token counts are retained as diagnostics; budget debit remains based on input plus output tokens.

## Compaction and recovery

The context-window controller first evaluates the append-only candidate. If compaction is required, canonical compaction creates an attributable derived summary and the next candidate starts a new transcript segment from that summary and current durable state. If no canonical narrative is eligible, a retained prior autonomous transcript permits a bounded segment reset whose materialized context references the exact source model request, action, and observation records. The reset is explicit in retained context provenance. Later requests append within the new segment.

Recovery reads the previous exact retained provider-input candidate, canonical model output, run action, observations, and context boundary. It reconstructs and validates the next candidate without a live worker, provider response object, mutable catalog, or provider-side stored response.

Event schema version 6 and reducer version 22 form an explicit pre-release reset boundary for this contract. Versions 1 through 5 are rejected before migration, decoding, projection, synchronization, or recovery.

## Verification

- provider-input unit tests for shape, digest, cache controls, strict-prefix growth, and tamper rejection;
- direct OpenAI Responses wire tests for key, explicit mode, TTL, breakpoint, storage, tool choice, parallel-call suppression, and tool ordering;
- autonomous-run integration tests for multi-step prefix identity, exact-once observations, restart equivalence, and compaction reset/accretion;
- deterministic cacheability calculation over realistic multi-step runs with more than 90% reuse after warm-up, excluding reset calls;
- cache read/write usage retention tests;
- typecheck, architecture checks, focused suites, and `bun run verify`.

## Implementation log

### 2026-08-20 — Provider transcript, caching, and recovery

- Implemented the provider-neutral `agencity.provider-input.v2` message and cache contract in `src/domain/provider-input.ts`, including exact validation, digest/byte retention, the deterministic OpenAI session/branch key, explicit mode, 30-minute TTL, and breakpoint metadata.
- Implemented append-only autonomous transcript construction and recovery inputs in `src/runtime/agent-runs.ts`: initial attributable segment, native assistant tool call/result continuation, bounded rejection continuation, durable-state deltas, next-action messages, exact-prefix preservation, and explicit compaction/overflow segment resets.
- Implemented direct provider wire translation in `src/executors/model.ts` and usage normalization in `src/executors/model-response.ts`: OpenAI Responses API with `store: false`, no `previous_response_id`, fixed required tools/order, disabled parallel calls, explicit supported text-boundary breakpoints, and retained cache read/write token diagnostics.
- Implemented event schema 6, reducer 22, and optional cache-usage fields in `src/domain/events.ts` and `src/domain/state.ts`. Budget debit remains unchanged and uses input plus output tokens.
- Added a no-eligible-narrative fallback for long autonomous runs: the context-window controller seals an attributable transcript segment boundary from exact retained source records, rebuilds from bounded recent trajectory and current durable state, and resumes append-only growth instead of failing solely because ordinary message compaction has no source.
- Corrected the cache-write design during implementation: explicit cache mode places append-only breakpoints on each supported next-action text block. Function-call outputs are native tool results but are not relied upon for cache writes. The provider may consider up to its 50 most recent breakpoints for reads in very long segments; prior breakpoints are read-only and only the latest four may write per request.
- Validation: `bun run benchmark:context-efficiency` passed with 69 strict-prefix transitions, reusable prefixes growing from 4,397 to 19,907 estimated tokens, and 91.15% conservative aggregate reuse across three 24-step runs. `bun run verify` passed with 1,236 core tests, 10 end-to-end tests, and 27 installed acceptance tests; three external checks skipped and zero tests failed.
- Plan notes: a provider-transcript segment reset is available when no canonical narrative is eligible for ordinary compaction. The reset is attributable, preserves bounded current observations, and does not rewrite canonical history.
- Remaining: no paid benchmark or credentialed live-provider validation was run. The real-provider smoke, official Turso Sync conformance, and Turso Cloud smoke remain skipped and unverified.

### 2026-08-20 — Managed-service subscription compatibility

- Completed: advanced the managed service protocol to revision 3 and let revision-3 clients attach to a still-running revision-2 service. The TUI and public terminal wait helpers refresh the service's cursor-pinned snapshot when an older event schema cannot be reduced locally, so pre-cutover detached work remains observable without replaying effects.
- Validation: terminal UI unit tests passed 25 with zero failures; protocol stream tests passed 9 with zero failures; managed-service integration tests passed 22 with zero failures; the linked OpenTUI pseudo-terminal journey passed. The final `bun run verify` passed with 1,237 core tests, 10 end-to-end tests, and 27 installed acceptance tests; three external checks skipped and zero tests failed.
- Plan notes: revision-2 clients remain incompatible with revision-3 services. Compatibility is one-way so an old schema-5 reducer never consumes schema-6 events.
- Remaining: a running revision-2 service continues to own its schema-5 workspace until it stops. A later revision-3 service still applies the documented pre-release schema-6 reset boundary when opening that workspace.

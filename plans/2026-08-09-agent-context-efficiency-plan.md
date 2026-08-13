# Agent context and observation efficiency plan

**Status:** Implemented and verified
**Date:** August 9, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related plans:** [Formal model tool contracts](./2026-08-07-formal-model-tool-contracts-plan.md), [Lossless context-reference storage](./2026-08-07-lossless-context-references-plan.md), and [Best-effort TypeScript console scratch](./2026-08-10-best-effort-console-scratch-plan.md)

## Summary

Agencity's autonomous loop is durable and attributable, but its provider-facing context and observation path can spend substantially more tokens than the work requires. The largest opportunities are:

1. construct, version, execute, and estimate one exact provider-input candidate instead of estimating a larger duplicated retained context;
2. make the cell terminal event the model-facing owner of successful cell execution instead of also delivering complete successful effect outputs;
3. define one small output-management contract and apply it first to shell output, file reads, artifact retrieval, and the final model-observation guard;
4. teach the model to keep one-cell intermediates local, use best-effort scratch only for replaceable cross-cell data, reserve state and artifacts for recoverable values, and return only the smallest useful next-step observation.

The plan deliberately excludes a durable or replayable TypeScript heap. The related scratch plan may retain arbitrary values in a warm disposable worker and restore bounded local JSON opportunistically, but correctness remains restartable from canonical state without that cache.

## Evidence

A fresh real-provider session on August 9, 2026 exposed the relevant behavior:

- a five-step HTML task consumed 37,846 provider-reported input tokens and 4,303 output tokens;
- provider-reported input rose from 3,301 tokens on the first step to 10,157 on the fifth;
- a roughly 5 KiB successful shell result appeared in both `EffectOutcomeRecorded` and `CellCommitted`, creating a roughly 10.6 KiB next-step observation;
- the complete 10 KiB HTML-generating action remained in the active-run projection supplied to later calls;
- the final retained context estimate was 27,908 tokens while the provider reported 10,157 input tokens because admission estimated fields the production adapter did not send;
- the selected model's context capacity was `unknown`, so proactive compaction did not run;
- profile context included product routing preferences and recent-session identifiers for unrelated workspaces.

Existing local bounds do not form one end-to-end model-context guarantee:

- cell JSON spills above 128 KiB, but only after complete worker serialization and IPC transfer;
- cell logs stop near 64 KiB and 1,000 entries;
- shell captures up to 1 MiB each for stdout and stderr after buffering complete streams;
- file reads and artifact retrieval return complete content;
- SQL limits rows and execution time but not total result bytes;
- the exact-once run observation ledger has no aggregate provider-facing byte budget.

## Goals

- Reduce provider input without weakening canonical provenance, recovery, or uncertainty semantics.
- Ensure successful tool output has one intentional model-facing representation.
- Make unexpected output size a runtime responsibility rather than something the model must predict.
- Preserve complete oversized output through immutable artifact references whenever the placement supports it.
- Give the model bounded previews and explicit continuation or range-retrieval instructions.
- Keep failed, cancelled, and unknown effects visible enough to support safe repair or reconciliation.
- Make context-window admission estimate the exact normalized messages, tool declarations, and token-relevant request options.
- Keep internal product routing metadata out of model context.
- Preserve the disposable TypeScript console and restart-after-every-cell correctness.
- Verify through the production context and provider-input builders that reduction retains the deterministic facts required to select the next formal action and repair after a committed failure.

## Non-goals

- Adding a durable or replayable TypeScript or IPython-style heap.
- Making closures, module instances, subprocesses, sockets, or lexical bindings durable.
- Replacing canonical events with an opaque transcript summary.
- Applying the deferred lossless-reference format to every event or document.
- Adding semantic/vector retrieval or a repository-map subsystem.
- Replacing the existing deterministic compaction mechanism with a new model-summary architecture.
- Hiding failed or unknown effects to reduce token use.
- Claiming that deterministic decision-contract equivalence proves equivalent interpretation by a live model.
- Optimizing TUI rendering or client event storage.
- Bounding memory allocated directly by arbitrary model-generated TypeScript. The runtime bounds its own capture buffers, IPC payloads, canonical events, artifact spills, and provider observations; trusted local code can still allocate process memory until the operating system or an external sandbox intervenes.
- Converting SQL results, `state.list`, recursive-model results, skills, or every existing typed response to the output envelope without evidence that they materially affect provider context.
- Adding a general artifact garbage collector, configurable per-provider limit matrix, or universal pagination framework.

## Scope decision: one contract, narrow rollout

The output-management contract is worthwhile because truncation, completeness, artifact recovery, and model-visible guidance should use one vocabulary. The first implementation must remain narrow.

The implementer should follow these rules:

- define the generic envelope and shared preview/spill helpers once;
- adopt them only for shell, file reads, artifact retrieval, oversized cell-result transport, and the aggregate model-observation guard;
- keep ordinary small typed results in their existing shapes unless wrapping them removes a demonstrated duplicate or unbounded payload;
- do not redesign SQL or working-state APIs in this work;
- preserve extension points through a small discriminated union rather than speculative adapter registries, policy engines, or per-tool configuration;
- prefer one product-wide limit set and measured follow-up over configurable limits;
- keep canonical evidence complete or truthfully incomplete, while allowing the provider-facing projection to be smaller;
- ship the highest-impact reduction after each phase instead of waiting for every possible output source to migrate.

Future surfaces adopt the envelope only when telemetry or a reproduced session shows that their output materially affects IPC, canonical event size, or provider input.

## Priority order

### 1. Versioned provider-input candidate and bounded live-state projection

**Impact:** 5/5  
**Implementation effort:** 2/5  
**Priority:** First

The executor sends normalized messages plus provider tool declarations and request options, while admission currently estimates the complete retained context object. The retained object also duplicates selected state inside `run.durableContext`. Active-run projection retains prior action source, and profile context exposes all profile preferences without separating model-facing preferences from product routing state.

Define `agencity.provider-input.v1` as the single immutable candidate produced at model-call admission. It contains:

- the exact normalized ordered messages and roles sent by the production adapter;
- the resolved provider tool names, descriptions, JSON Schemas, strictness, selection policy, and parallel-call policy;
- token-relevant request options, including output reserve, reasoning configuration, and any transport option that changes the serialized request;
- response-contract, model-dispatch, endpoint, capacity, and estimator provenance;
- one canonical digest and the complete candidate's exact UTF-8 byte count.

The executor and context-window estimator consume this same candidate. Recovery reconstructs it from retained immutable messages, the sealed response-contract registry, and retained model dispatch, then verifies the version and digest before use. Full sealed tool schemas do not need another durable copy when their exact contract ID, version, and digest can reproduce the candidate. Component byte counts may be emitted as noncanonical benchmark telemetry; they are not additional durable contract fields.

The provider-facing durable projection should:

- represent the current run with task, status, current ordinal, terminal summaries, and unresolved control state;
- omit prior TypeScript source, accepted tool arguments, complete model results, and other history already available through canonical events and `cells`;
- remain bounded independently of the number of completed steps;
- include only preferences explicitly classified as model-facing through a default-deny allowlist;
- exclude workspace selection, recent-session, credential-routing, and model-selection bookkeeping for unrelated workspaces.

When provider capacity is unknown, Agencity retains that uncertainty but applies a 512 KiB UTF-8 product ceiling to the complete provider-input candidate and compacts toward 384 KiB. If eligible narrative compaction cannot bring the candidate below the hard ceiling, admission stops with a typed product-limit outcome before a provider call. These byte limits are product safety limits, not claims about the provider's context window.

Acceptance conditions:

- estimation and execution consume the same versioned provider-input candidate;
- tool schemas and token-relevant request options are included in the candidate estimate;
- recovery rejects a reconstructed candidate whose version or digest differs;
- changing an unsent retained-context field does not change the input estimate;
- completed action source does not accumulate in later provider messages;
- no unrelated workspace/session routing preference reaches a provider;
- a synthetic five-step benchmark reduces serialized provider-message bytes by at least 30 percent from the captured baseline shape;
- an unknown-capacity candidate above the hard product ceiling compacts or stops before provider execution;
- capacity remains visibly `unknown` when the catalog has no authoritative value.

### 2. Selective-observation prompt doctrine

**Impact:** 3/5  
**Implementation effort:** 1/5  
**Priority:** Ship with priority 1

Agencity already permits one TypeScript cell to hold, inspect, transform, and aggregate large intermediate values without returning or logging them. The related scratch plan defines replaceable cross-cell cache data without making it canonical. Recoverable values belong in `state` or artifacts. The autonomous prompt must explain the boundaries of the surfaces available in the shipped runtime while minimizing observations.

Add stable guidance that:

- assigns large read/search/tool results to local variables before processing;
- avoids `console.log` and raw `return` of complete tool objects unless the complete value is required for the next model decision;
- returns a compact summary, selected slice, counts, digests, errors, or artifact reference;
- when the scratch API ships, uses it only for replaceable cross-cell intermediates and checks or rebuilds them after worker loss;
- uses `state` for small durable JSON and artifacts for large durable content;
- treats every state write and artifact as retained storage, avoids transient or repetitive durable writes, and reuses a small stable set of state keys;
- uses only retrieval APIs that are available in the same shipped runtime.

Range-retrieval guidance is added in Phase C in the same change that exposes the range APIs. Earlier prompt changes must not tell the model to call unavailable methods.
Scratch guidance follows the same rule and activates only in the change that exposes the scratch cell global and SDK status surface.

Tests and examples must stop teaching `return r` after shell/file calls unless the raw result is the behavior under test.

This prompt change is a quick reduction, not the correctness boundary. Runtime bounds and observation ownership remain mandatory because models cannot know output size in advance and may ignore guidance.

Acceptance conditions:

- the effective system prompt states the selective-observation rule;
- ordinary autonomous fixtures return focused summaries instead of raw shell objects;
- no test relies on prompt compliance for memory, context-window, or event-size safety.

### 3. One model-facing owner for successful cell effects

**Impact:** 5/5  
**Implementation effort:** 3/5  
**Priority:** Second

Every effect remains a canonical outbox fact, but a successful effect executed inside a cell should not automatically become a second full model observation. The cell terminal event should own the next-step model view of successful cell work.

Record origin before external execution. Every console RPC effect request carries a typed origin such as `{ kind: "cell", cellId }` in `EffectRequested` and its outbox projection. Model, gate, recovery, and other non-cell effects use their own closed origin variants. The runtime validates this relation when it admits the request; it must not infer ownership later from event adjacency or add origin only after the cell terminates.

Build a derived model-observation projection with these rules:

- `CellCommitted` contributes its bounded result, bounded logs, exports, and a compact effect manifest;
- successful linked `EffectOutcomeRecorded` payloads remain queryable canonical history but are omitted from automatic next-step observations;
- failed, cancelled, and unknown linked effects contribute bounded status, error, preview, and recovery/reconciliation guidance;
- effects outside a cell retain their existing typed delivery path;
- duplicate event delivery remains a true no-op and recovery reconstructs the same projection.

The projection must not remove audit evidence or rewrite canonical outcomes. It changes only what enters an automatic provider call.

Acceptance conditions:

- one successful shell result cannot appear in both the effect and cell portions of the same provider step;
- every cell effect has a valid retained origin before `EffectAttemptStarted`;
- a cell that returns `null` after successful mutation still reports a compact effect manifest;
- failed and unknown effects remain distinguishable and actionable;
- crash recovery before and after effect outcome and cell commit reconstructs the same model observation without duplication;
- branch replay, snapshot rebuild, sync ingestion, and export retain complete attributable effect history.

### 4. Source bounds, recoverable spill, and range retrieval

**Impact:** 5/5  
**Implementation effort:** 3/5  
**Priority:** Third

Introduce `BoundedOutputV1`, a small discriminated union shared by shell, file, artifact, and oversized cell results. It is generic over each tool's existing inline value; it standardizes only completeness, preview, counts, artifact recovery, and overflow reason. The final model-observation guard uses the same completeness vocabulary when it must reduce a collection of otherwise valid event views. The closed completeness states are:

- `inline`: the returned value is complete;
- `spilled`: the inline preview is incomplete and the referenced artifact contains the complete scrubbed value;
- `truncated`: the preview is incomplete, no complete retained value is available, and the reason is one of `spill-unavailable`, `spill-failed`, or `spill-limit`;
- `refused`: execution or retrieval did not start because a declared preflight limit was violated.

Effect success and output completeness remain separate. A command may succeed while its output envelope truthfully reports `truncated`; this never becomes a claim that the complete output was retained.

Baseline numeric limits:

- complete provider-input candidate: 512 KiB UTF-8 hard ceiling, 384 KiB unknown-capacity compaction target;
- automatic model observations for one dependent step: 64 KiB UTF-8 total;
- one model-observation item: 56 KiB UTF-8;
- shell preview per stdout or stderr stream: 24 KiB UTF-8, split into 12 KiB head and 12 KiB tail;
- complete shell spill: 32 MiB total across stdout and stderr for one effect;
- cell-result IPC payload: 128 KiB; larger serializable JSON uses artifact staging rather than IPC transfer of the complete value;
- file text page: at most 2,000 lines, 2 KiB per line, and 48 KiB UTF-8 total;
- artifact range: half-open byte range `[start, end)`, at most 64 KiB per call;

These are one product-wide baseline, not a new matrix of provider, model, or workspace settings. They remain ordinary product constants. Changing a number requires tests and evidence, but not a new durable schema version unless the envelope's retained meaning changes.

An overflow envelope retains:

- a Unicode-safe head and tail preview;
- exact byte and, where meaningful, line counts;
- an explicit `truncated` or `spilled` state;
- an immutable artifact reference containing the complete output when supported;
- a clear continuation, grep, or byte/line-range retrieval instruction.

Head-and-tail preview is required for command output because test runners and compilers commonly print the decisive summary last. Overflow must spill rather than silently discard whenever local artifact placement is available.

Range and continuation semantics are exact:

- file pages are one-based line windows and return `startLine`, `endLine`, `totalLines`, `nextLine`, and the file digest; a continuation may supply `expectedSha256` and fails visibly if the mutable file changed;
- artifact ranges are zero-based half-open byte ranges over immutable content and return `start`, `end`, `size`, and `nextStart`; bytes remain exact and callers decode or parse them inside the cell;

Implement in this order:

1. stream shell stdout/stderr into bounded previews plus artifact staging instead of buffering complete streams in memory;
2. add stat-first paginated file reads with line windows;
3. expose bounded artifact byte ranges instead of only whole-artifact `get`;
4. move oversized serialized cell results through artifact staging instead of complete-result IPC;
5. enforce a final aggregate model-observation budget per dependent step.

SQL and working-state surfaces retain their current contracts in this plan. If later measurements show that either creates material provider or IPC growth, adopt the same envelope in a separate focused change rather than widening this rollout preemptively.

The final aggregate budget is a guardrail, not the primary truncation mechanism. Individual tools produce useful recoverable envelopes before the observation ledger applies its total cap. Priority within the aggregate budget is terminal status and uncertainty, then errors and tail evidence, then head evidence, then informational metadata.

### Spill security and crash contract

Overflow is scrubbed before it becomes durable. Streaming text capture applies the existing known-secret and credential-shaped redaction policy across chunk boundaries before writing an owner-only staging file. Raw unsanitized output must not enter artifacts, events, logs, or error messages.

At terminalization:

1. finalize the scrubbed staging file, byte count, and digest;
2. place the immutable bytes in CAS;
3. append `ArtifactRegistered` and the referencing `EffectOutcomeRecorded` atomically;
4. commit the later cell terminal event through its ordinary boundary.

A crash before the atomic event append leaves no visible artifact reference and provides no evidence that the effect succeeded. Recovery follows the executor's existing idempotent/unknown policy. Owner-only staging files are deleted on startup when no live capture owns them. A CAS object written before a failed event append is an unreachable orphan and may remain until a future general artifact-GC capability; this plan does not add that subsystem. A crash after the atomic append leaves both registration and outcome visible.

Crossing the 32 MiB shell spill limit stops retention but continues draining the process streams. The final envelope is `truncated` with reason `spill-limit`, no complete-artifact pointer, and exact observed byte counts. Spill failure or unavailable placement follows the same truthful no-pointer rule.

Canonical event payloads reference oversized artifact content rather than embedding multi-megabyte strings. Artifact registration and effect/cell outcomes preserve stable idempotency and crash recovery. A spill written without a committed reference is an orphan, never proof of a successful effect.

Acceptance conditions:

- a command within the spill ceiling completes with bounded head/tail previews and a digest-verified full scrubbed artifact;
- output beyond the spill ceiling is reported as incomplete without a false artifact pointer;
- file and artifact reads cannot return an unbounded string;
- an oversized serializable cell result does not cross IPC as one complete JSON string;
- every truncation is explicit and names the supported recovery action;
- Unicode boundaries remain valid;
- unavailable spill placement produces a truthful bounded result without a false recovery pointer;
- effect failure, cancellation, timeout, and unknown outcomes preserve their existing semantics;
- adversarial large-output tests demonstrate bounded runtime capture buffers, spill bytes, IPC payloads, canonical event payloads, and provider messages without claiming a memory bound for arbitrary generated code.

## Implementation sequence

### Phase A — Measure and remove avoidable context

- Add a deterministic provider-message byte benchmark reproducing the observed five-step shape.
- Add the versioned provider-input candidate and use it for construction, estimation, execution, and recovery.
- Slim active-run and profile preference projections.
- Add the product payload safety ceiling for unknown provider capacity.
- Add selective-observation guidance that refers only to currently shipped APIs and update fixtures.

Phase A should deliver a measurable reduction without changing effect or cell execution semantics.

### Phase B — Establish observation ownership

- Record explicit cell/effect origin in `EffectRequested` before execution.
- Implement the derived model-observation projection.
- Remove successful linked effect payload duplication from provider calls.
- Add replay, crash-boundary, branch, sync, and exact-once tests.

If the durable relation changes released event meaning, use the repository's versioned event-evolution process. Do not reinterpret retained history silently.

### Phase C — Ship the thin output framework

- Add the shared output envelope and artifact spill path.
- Convert shell, file, artifact, and oversized cell-result transport.
- Add the aggregate per-step observation guard.
- Add file and artifact range APIs and their prompt guidance atomically.
- Update protocol, Console SDK, event, recovery, security, capability, and verification documentation.
- Add black-box installed-product coverage for unexpected large output followed by focused recovery.

## Verification

Use the narrowest focused suites during implementation, then run the complete repository gates.

Required focused coverage:

- exact versioned provider-input candidate construction, digest, recovery, and estimator parity, including tool schemas and token-relevant options;
- bounded active-run growth across many steps;
- profile preference visibility and cross-workspace exclusion;
- successful effect/cell deduplication;
- failure, cancellation, timeout, and unknown effect delivery;
- shell streaming spill, head/tail content, digest, and Unicode safety;
- file and artifact range continuation;
- oversized cell-result IPC staging;
- aggregate observation priority and byte limits;
- cross-chunk secret scrubbing and crash recovery at staging, CAS placement, atomic artifact/outcome registration, cell-terminal, and model-delivery boundaries;
- duplicate replay, rebuild, branch fork, sync, export, and deletion behavior;
- prompt fixtures that use compact observations without treating prompt compliance as a safety control;
- isolated linked-executable acceptance from a fresh external repository.

The benchmark report should record:

- complete provider-input candidate bytes by step;
- serialized provider-message bytes by step;
- estimated input tokens by step;
- provider-reported input tokens when a credential-gated run is explicitly enabled;
- automatic observation bytes by event type;
- artifact spill bytes and preview bytes;
- compaction status and capacity provenance;
- deterministic next-action contract results for task and step identity, trajectory order, compact action/outcome facts, failure guidance, effect ownership, and required artifact references;
- uninterrupted and post-`CellCommitted` recovery results from a context-sensitive deterministic provider that chooses from the normalized provider input.

Credential-gated provider results remain separate from deterministic verification and must be reported as passed, failed, or skipped.

## Completion criteria

This plan is complete when:

1. provider admission versions, digests, estimates, and executes the same normalized messages, tools, and token-relevant options;
2. completed action history and unrelated profile routing data no longer inflate provider context;
3. successful cell effects have one bounded automatic model-facing representation;
4. shell, file, artifact, and oversized cell-result paths have source bounds and explicit completeness or recovery outcomes;
5. no single dependent step can exceed the aggregate model-observation budget;
6. complete oversized evidence within the spill ceiling remains attributable through verified artifact references;
7. disposable-console restart semantics remain unchanged;
8. deterministic next-action checks use the production context/provider-input path and focused recovery coverage proves the same context-derived continuation without duplicate cell, effect, or model work;
9. deterministic, recovery, adversarial, and installed-product tests pass;
10. public documentation and `AGENTS.md` accurately describe the implemented behavior and remaining limitations.

## Implementation log

### 2026-08-10 — Exact provider input and bounded context
- Completed: Added the versioned `agencity.provider-input.v1` candidate, immutable dispatch/capacity recovery pins, bounded active-run and model-facing preference projections, unknown-capacity product limits, and selective-observation prompt guidance.
- Validation: `bun run benchmark:context-efficiency` used the production provider-input builder and measured 297,997 baseline provider-message bytes versus 106,198 shipped bytes, a 64.36% reduction.
- Plan notes: The coordinated pre-release cutover uses event schema 5 and reducer 15; schema versions 1 through 4 fail closed.
- Remaining: Live provider token usage remains credential-gated and unverified.

### 2026-08-10 — Observation ownership and effect origins
- Completed: Added required typed effect origins, migration 019, exact request/attempt ownership validation, a complete canonical observation ledger, and a derived model-facing projection in which the cell terminal event owns successful linked effect output.
- Validation: Replay, crash, branch, synchronization, export, deletion, idempotency, and failure/unknown observation coverage passed within `bun run verify`.
- Plan notes: Failed, cancelled, and unknown effects retain separate bounded evidence; only duplicate successful linked output is removed from automatic provider observations.
- Remaining: None.

### 2026-08-10 — Bounded output, spill, and range retrieval
- Completed: Added `BoundedOutputV1`, streaming scrubbed shell spill, bounded file pages, immutable artifact ranges, streaming oversized-cell JSON staging, strict nested envelope validation, remote placement checks, and absolute 56 KiB item/64 KiB step observation guards.
- Validation: Focused adversarial suites for shell capture, secrets, artifacts, files, observations, and placement passed; linked installed-product acceptance recovered an unexpected large shell result through an artifact range.
- Plan notes: Runtime-owned capture and diagnostic buffers are bounded. Arbitrary trusted generated TypeScript remains outside the memory-bound claim.
- Remaining: General artifact garbage collection remains outside this plan.

### 2026-08-10 — Final verification and review
- Completed: Reconciled public documentation and `AGENTS.md`, corrected aggregate fixtures, hardened adversarial event identities, credential streams, CAS deduplication, remote error bodies, empty ranges, and file cancellation, and cleared independent final review.
- Validation: `bun run verify` passed: core 937 passed, 2 external skips, 0 failed; end-to-end 3 passed, 0 failed; acceptance 16 passed, 1 external skip, 0 failed.
- Plan notes: None.
- Remaining: The live-provider, official Turso Sync server, and Turso Cloud checks were skipped because their external prerequisites were unavailable; they remain explicitly unverified.

### 2026-08-12 — Deterministic semantic-preservation verification
- Completed: Extended the production-builder benchmark with a deterministic next-action contract covering task and step identity, trajectory order, compact action/outcome/effect facts, bounded failure guidance, successful-effect ownership, artifact-backed continuation, repair, and completion. Added a context-sensitive deterministic provider integration that derives its actions from normalized provider messages in uninterrupted execution and across a post-`CellCommitted` service recovery boundary.
- Validation: The benchmark retained a 60.52% provider-message reduction and passed all 16 semantic-preservation checks. Focused integration coverage proved the same continuation source and exactly three model calls, two committed cells, and two file effects in each path.
- Plan notes: This evidence proves the encoded deterministic decision contract and recovery invariants. It does not prove equivalent interpretation by a live model.
- Remaining: Live-model semantic equivalence and live-provider token usage remain unverified.

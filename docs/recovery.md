# Crash recovery and unknown effects

An **effect** is work outside deterministic event reduction, such as a model request, shell command, file operation, or skill execution. Agencity records the request in a durable **outbox** before dispatch. Recovery uses the retained request, attempt, and outcome records to continue safe work without assuming that an interrupted external action failed.

## Committed boundary

A cell has durable lifecycle events:

1. `CellProposed` records code and declared dependencies;
2. `CellStarted` records its attempt;
3. the disposable worker runs, using durable outbox requests for SDK effects;
4. success atomically appends staged `ArtifactRegistered`, `WorkingValueSet`, and `CellCommitted` events, or failure appends `CellFailed`. A new `CellFailed` includes a validated exact list of terminal non-success effect-outcome event IDs only when a convenience-helper error directly escaped the worker; an empty list means no such cause was proven.

Only a committed terminal event and its committed exports become required later state. The worker heap is never replayed. Arbitrary replay could repeat a file edit, command, network call, or model generation.

Exact-branch `scratch` is a separate best-effort cache. A successful cell may leave arbitrary values warm in its worker. After `CellCommitted`, the managed file-local product independently attempts a bounded plain-JSON checkpoint in a fenced operational table. Mutable reads remain conservatively dirty. When the filtered, validated serialization has the same schema version and digest as the current valid row, the worker becomes clean but the cold checkpoint retains its prior source provenance, timestamps, TTL, access and integrity metadata, and quota position. Nested mutation changes the digest and persists a new checkpoint. A checkpoint failure does not change the cell outcome. Failed, abandoned, or uncommitted cells evict their warm scope and cannot replace the last completed checkpoint.

Recovery uses warm scratch when present, then an exact same-device and same-branch checkpoint when available. Branch forks, child sessions, synchronized devices, diagnostic embedded supervisors, and remote relational placements start cold or warm-only as applicable. Eligible JSON can restore, while functions, classes, cycles, modules, and other skipped values do not. Known skipped names remain explicit; complete cache loss with no metadata is simply cold. Generated work must rebuild missing scratch from durable state, artifacts, files, retained cells, or safe idempotent effects and must not replay retained cell source automatically.

## Startup sequence

Unless `recover: false`, `Supervisor.open` performs:

Before this sequence, storage admission verifies that every retained event uses schema version 5. A workspace containing schema version 1, 2, 3, or 4 fails closed with reset guidance before product migration, row decoding, projection, synchronization ingestion, or recovery. The runtime does not upcast, rewrite, or delete that history. Back up or move aside the incompatible workspace state before creating a fresh schema-version-5 workspace.

1. **Staging cleanup and outbox reconciliation.** Dead-process owner-only artifact staging directories are removed. Each mutable `running` row whose owner disappeared is inspected. Unreachable CAS objects are not treated as registered evidence.
2. **Safe requeue.** An effect declared idempotent returns to `pending` with its attempt count retained.
3. **Visible uncertainty.** A non-idempotent running effect gets a canonical `EffectOutcomeRecorded { outcome: "unknown" }`; it is not requeued. An anomalous pending non-idempotent row with a retained prior attempt is treated the same way; a normal pending first attempt remains safe to drain because it was never claimed.
4. **Cell abandonment.** Every branch projection with a `proposed`/`running` cell gets a branch-scoped idempotent `CellAbandoned` event. This includes a child fork that inherited an incomplete ancestor cell, without reusing the ancestor's idempotency key. Recovery does not infer or synthesize effect-to-cell causality; abandonment remains uncertain.
5. **Recovery evidence.** Affected branches get `RecoveryPerformed` with abandoned, unknown, and retried IDs.
6. **Cancellation recovery.** Recorded `SubagentCancellationRequested` crash prefixes are resumed before queued work; the original reason wins and descendants terminate leaf-first.
7. **Drain.** Pending/requeued effects execute and commit attempt/outcome events.
8. **Model finalization.** If a requested model call already has a durable terminal effect, the runtime records model/message/budget completion or termination without calling the model again.
9. **Status reconciliation.** A branch left `running` by a crash before model-request/finalization commits is returned to `idle` with a recovery event.
10. **Heartbeat recovery.** Due active schedules append one aligned tick plus wake message; paused/cancelled schedules are ignored.
11. **Goal recovery.** Running gate effects are reconciled to passed/failed/cancelled/unknown, the canonical gate-definition/workspace-material pin is re-checked before recovered success can pass, matching terminal evaluations are reused, and ambiguous or stale required gates block completion. An active goal without a typed run association is attached to a stable `AgentRun`; recovery does not route autonomous work through the diagnostic text loop.
12. **Recursive-handle recovery.** Running terminal child calls finalize their durable task/model handle and atomically attribute direct usage to ancestors; safe pending handles re-enter the shared provider limiter. A committed handle resolves after console-worker or supervisor restart without repeating admission. Its retained profile pin fixes the child profile version, prompt digest, and prompt contract used by every recovered model call. Terminal `succeeded`, `failed`, `cancelled`, `budget-exceeded`, and `unknown` outcomes are retained separately; non-idempotent ambiguous calls are unknown and are never generated twice. Large completed values resolve through their registered content-addressed result artifact.
13. **Raw-generation recovery.** Each owned nonterminal `AiGenerationRequested` already has its `EffectRequested` in the same admission transaction. A pending first attempt may execute once; lost running non-idempotent ownership becomes `unknown` and consumes the unresolved reservation conservatively. A terminal effect finalizes result/status and one budget debit without another provider call. Pending cancellation commits the effect and generation terminal state together, while an unresolved active cancellation becomes explicit `unknown` rather than permitting a post-cancel retry. Synchronized non-owner generations remain observational.
14. **Typed agent-invocation recovery.** Runnable child admission atomically retains the task, child session/profile, run identity, and text or declared-object contract. Worker or client loss while waiting does not repeat admission; the parent recovers the handle by idempotency key or task ID and reads the same queued, running, or terminal result. A committed typed finish is validated once, then task result, terminal notice, and `AgentRunResultCommitted` delivery complete idempotently. Blocked, failed, cancelled, budget-exceeded, and unknown outcomes never fabricate object output. Awaited console capacity is reserved before admission, so capacity failure leaves no partial child.
15. **Refinement-review recovery.** Every nonterminal trajectory proposer or governance reviewer resumes from its canonical request and frozen input. A retained child link reuses the same recursive-model handle and exact structured `responseAdmission`. A successful child result is reconstructed from the authoritative model effect and bound to the child completion without creating an assistant message. Governed proposals resume deterministic validation, one sealed review, application-time revalidation, staged skill tests when required, and terminal delivery with stable identities. A child `unknown` outcome becomes terminal `unknown` and is never retried. Deterministic malformed/over-scoped output becomes visible failure; infrastructure failure leaves the last committed boundary for later recovery rather than inventing success.
16. **Family-delivery recovery.** A committed send missing its recipient-delivery event completes that prefix (or records failed if the target became unavailable). Accepted `steer` messages enter an active run once at a durable boundary, or enter retained context without waking an idle recipient. Pending `queue` messages remain in canonical recipient-delivery order. Recovery admits only the oldest eligible message with its stable run ID, completes a crash prefix between run admission and context delivery, and advances that run before dispatching the next queued message. Retained pre-mode `followUp` events preserve their former active-boundary behavior and stable `agent-follow-up` run identity. Acknowledged rows are left terminal.
17. **Agent-run recovery.** Queued/running typed runs reconcile retained formal submissions or violations, cells, gate evidence, cancellation, and unknown effects before another model call. Recovery resolves the immutable profile version named by `AgentRunRequested.profilePin`; it does not substitute a later active profile. Context, call, and effect prompt provenance must agree with that invocation pin before dependent work continues. An accepted action is applied from its digest-linked committed source rather than resubmitted. Blocked and failed finishes use one atomic message/status batch; successful finishes materialize a message only after gates pass. Family queued-work terminal replies use the same retained run/message IDs and are not regenerated on repeated startup.

Recovery commands use stable branch-scoped idempotency keys, so repeating startup does not duplicate terminal state. Projection rebuild is a separate effect-free replay operation and does not run any of these schedulers or queues. Family message acceptance is one atomic sender/recipient append batch. Queue dispatch durably admits the stable run before the atomic context-insertion, linked-artifact, and endpoint-receipt batch; advancement is asynchronous only after both boundaries commit.

## Agent-profile and prompt-pin recovery

The initial immutable profile is complete inside `SessionCreated`. Later local `AgentProfileVersionCreated` and `AgentProfileActivated` events are session-wide control records addressed through the session's initial branch. `agent_profile_versions` and `workspace_agent_profiles` are rebuildable projections; deleting and replaying an unambiguous history reconstructs exact versions and the active pointer without rendering new text or calling a model.

An active profile pointer is used only when admitting a new autonomous run or recursive-model invocation. Admission writes an immutable profile pin before model work. Prompt composition then uses the retained exact agent prompt and fixed component order, and records the effective-system-prompt digest and component references in context and model-call provenance. If the active pointer changes later, recovery of the older invocation continues with its pinned version. A missing version, digest mismatch, or prompt-component mismatch is a dependency/validation failure, not permission to use the newer profile.

Projection rebuild never creates a profile revision or activation. Governed proposal recovery resumes the same stable review request, reviewer child, decision, application, and terminal notice. Repeated recovery cannot duplicate the reviewer call, activated version, restoration, or notice.

Offline replicas may commit different profile versions or rollbacks against the same expected active version. Synchronization preserves each immutable claim on its deterministic derived branch and records an unresolved conflict. Alternate claims are not projected as a last-writer active pointer, and runnable profile lookup fails with a conflict until the divergence is explicitly reconciled.

## Governed-refinement recovery boundaries

The ordinary proposal path has durable boundaries for:

1. `GovernedRefinementProposed`;
2. deterministic validation or terminal deterministic rejection;
3. frozen `RefinementGovernanceReviewRequested`;
4. durable reviewer-child link;
5. typed reviewer decision;
6. application-time revalidation;
7. atomic profile/non-skill application, or staged skill candidate/tests/activation;
8. terminal notice delivery; and
9. exact-content restoration when rollback is requested.

Recovery always continues the same proposal, reviewer handle, decision, version IDs, skill effects, notice ID, or rollback ID. A crash before proposal commit leaves no proposal. A definitive freeze or reviewer-child admission failure commits `review_failed` directly from `validated` and delivers one terminal result; reopen does not retry it. A crash after a committed review request but before reviewer link creates or resolves the stable reviewer once. A committed reviewer effect is consumed without another model call. Unknown external reviewer ownership becomes `review_unknown`, never approval. A committed approval without application resumes final validation; stale state becomes `apply_conflict` and activates nothing. A skill approval resumes its retained compile/test effects and activates only after a passing report. A committed application is returned rather than repeated. An undelivered terminal notice is delivered once; a delivered notice is not duplicated.

Startup recovery queries only actionable statuses and scans them oldest-first in deterministic pages of 200 until no matching row remains. The page size bounds each query and delivery tranche; it is not a total-history cap. More than 200 old proposals or notices therefore cannot be starved by newer records.

The reviewer dispatch is frozen from the origin route's current model together with explicit limits of 16,384 tokens, USD 1 cost, two runtime turn slots for one structured decision, and 120 seconds wall time. Recovery never substitutes a newly selected model, ambient repository charter, caller choice, or unbounded parent default. Product constitution and policy are pinned; unsupported workspace charter and user constraints remain `null`. A malformed, failed, timed-out, budget-exceeded, cancelled, or unknown reviewer outcome never implies approval.

## Refinement review boundaries

A review has four independently recoverable boundaries: `RefinementReviewRequested` freezes the strict request and bounded snapshot; `RefinementReviewChildLinked` names the durable recursive child; `RefinementReviewStatusChanged(running)` establishes model-result processing; and the terminal status is committed after either no-change or stable proposal/candidate processing. `RecursiveModelStarted.responseAdmission` retains the sealed `agencity.refinement-review.v1` contract and capability seed. A successful `agencity_submit_refinement_review` call yields a fully typed recursive result bound to the exact child model completion, accepted input digest, result digest, provider call, and byte count. No assistant result message or JSON parser is used. Refiner proposals carry `sourceReviewId` and a deterministic proposal fingerprint, so a crash after proposal append, validation, candidate creation, or allocation continues that same identity. Projection rebuild only replays these records and never restarts the child.

Refinement review projections permit a missing frozen snapshot or trigger frontier only to keep retained database records readable. New reviews always persist both values. An incomplete retained review without a frozen snapshot fails visibly rather than reconstructing a different context.

## Effect state machine

```text
EffectRequested -> pending outbox
                -> EffectAttemptStarted -> running
                -> EffectOutcomeRecorded(succeeded | failed | cancelled | unknown)
```

The request commits before execution. A terminal event is authoritative even if its original caller dies before receiving the result. Outbox status is a mutable operational projection of that event history. If two local runners race for a pending row, the loser waits for the winner's durable terminal outcome through the recorded lease instead of reporting a transient `unknown`.

Runtime terminal waits use one shared `ProjectionService` snapshot-plus-cursor primitive. It checks terminal state before the snapshot returns, catches commits between snapshot and subscription, follows live canonical events, cleans up on timeout or cancellation, and performs a final read. Local notification-capable relational storage uses commit notifications only as wakeups; durable cursor reads remain authoritative. A centralized bounded polling fallback is selected only when the placement advertises `notifications: false`, such as the current HTTP relational adapter. The runtime does not catch a notification capability error and silently downgrade placement semantics.

The competing-outbox-owner path uses this waiter for canonical terminal outcomes until the recorded lease deadline. Its final outbox read remains authoritative for operational-only changes: a reset row returns to claim/execution, a terminal row loads its exact outcome event, and a still-running row after expiry returns unknown. This preserves lease expiry, final-read, and reset behavior without independent 25 ms polling.

When `tools.shell`, `tools.readFile`, or `tools.writeFile` receives a failed, cancelled, or unknown terminal outcome and its generated error directly fails the cell, the new `CellFailed.causalEffectOutcomeEventIds` points to that exact outcome event. The link is not derived from error text and is not reconstructed after a crash. A handled or wrapped error has no direct link unless the original convenience error itself escapes.

`unknown` means the runtime cannot prove whether an external action happened. It is not failure, cancellation, or success. Examples include process death after a provider/service accepted a request but before the result committed, or after a non-idempotent command may have changed the world.

Provider stream deltas do not alter this lifecycle. They are process-local progress emitted only after `EffectRequested` and `EffectAttemptStarted`, have no cursor, and are never recovered or replayed. If a stream fails or is cancelled before the terminal success batch, no `ModelOutputChunk` or assistant `MessageAppended` commits. If the process disappears while the non-idempotent model effect is running, startup records `unknown`; it never promotes the observed prefix to a response and never retries the generation.

Structured model requests commit `agencity.provider-input.v1` in `ModelCallRequested` and its compact admission identity with the exact context before provider execution. It contains the normalized messages, sealed tool declarations and schemas, selection/parallel policy, token-relevant options, dispatch/endpoint/capacity provenance, digest, and exact byte count used by both estimation and execution. Recovery rebuilds this candidate from retained context, dispatch, capacity, and the response-contract registry, then rejects a version or digest mismatch instead of consulting a later catalog. Provisional formal arguments never execute from stream callbacks. A successful effect retains one complete accepted input in `agencity.model-effect-output.v2`; completion and action events use digests and call identities. Contract-violation output retains bounded evidence but not rejected argument bodies. Guard-aborted responses debit a conservative token estimate with zero provider cost, so invalid output does not evade budget accounting.

## Retry rule

Automatic retry requires the executor/caller to establish idempotency for the logical effect. A durable idempotency key deduplicates runtime intent; it does not force an external service to behave idempotently. The `idempotent` request flag is an assertion that must be justified by operation semantics.

Current defaults:

- shell run: non-idempotent;
- model completion: non-idempotent;
- file read/write/delete through console helpers/default request policy: idempotent;
- file exact-text replace: non-idempotent.

File write helps make retry safe by writing atomically, accepting an expected prior digest, and recognizing already-desired content. These mechanisms do not make every filesystem topology or external observer exactly-once.

## Crash matrix

| Crash point | Durable observation after startup | Automatic action |
|---|---|---|
| Before `EffectRequested` commit | No effect exists. | None; dependent committed work cannot claim it happened. |
| After request, before claim | `pending`. | Drain once under a local claim. |
| After claim/start, before external effect | `running`; actual effect uncertain from the database alone. | Requeue only if declared idempotent; otherwise `unknown`. |
| After external action or streamed prefix, before terminal commit | Same as above; this is the ambiguity window. Cursorless progress is absent from history. | Same conservative rule; never infer success or commit the partial model text. |
| After terminal outcome commit, before caller receives it | Canonical terminal event. | Return/reconstruct it; do not call executor again. |
| Cell proposed/started, worker dies before terminal cell event | Incomplete cell plus any separately durable effect events. | Append `CellAbandoned`; reconcile effects independently. |
| Shell spill staged before CAS placement | No artifact reference or terminal effect. | Remove stale owner staging at startup; apply ordinary idempotent/unknown effect recovery. |
| Shell spill placed in CAS before atomic artifact/outcome append | Unreachable CAS bytes, no canonical success evidence. | Do not expose or infer success; unreferenced bytes may remain until a future garbage collector. |
| Shell spill artifact registration and effect outcome append succeeds | Both canonical records are visible in one batch. | Reconstruct the bounded `spilled` envelope; do not rerun the command. |
| Oversized cell JSON staged or placed before cell commit | No `ArtifactRegistered`/`CellCommitted` event. | Remove stale staging and do not expose it. Unreferenced CAS bytes may remain. |
| Staged state/artifact reference before cell commit | No `WorkingValueSet`/`ArtifactRegistered` event. | Do not expose it. Unreferenced CAS bytes may remain. |
| Cell commit succeeds, process dies before notification | Complete canonical batch. | Snapshot/subscriber catch-up reads it from storage. |
| Model effect terminal, model-call finalization missing | Requested call plus terminal effect. | Finalize once without another provider call. |
| Raw generation admitted, cancellation commits before provider claim | Atomic request/effect plus cancelled outcome/status. | Do not execute the terminal outbox row after restart. |
| Raw generation effect terminal, generation result/status/debit missing | Frozen context, request, effect, and authoritative terminal outcome. | Finalize once, validate retained output, and settle usage without another provider call. |
| Agent invocation admitted, parent worker or client disappears before handle/result delivery | Parent task, child session/profile, run ID, contract, and idempotency key are canonical. | Recover the same handle/result; do not admit a second child. |
| Queued mailbox send commits before run admission or result delivery | Immutable message ID, sender/recipient route, mode, intent, and deterministic derived run ID are retained. | Report queued with zero steps until admission; preserve FIFO routing, recover the same run after restart, and never route or admit from result lookup. |
| Queued mailbox delivery fails before run admission | Canonical failed receipt and deterministic derived ID; no `AgentRunRequested`. | Report typed failed with zero steps and `admitted: false`; do not fabricate a run. |
| Typed child finish commits before task result or terminal notice delivery | Finish, assistant message, and exact schema-constrained value are canonical. | Commit the result reference and complete paired task/notice delivery once; do not regenerate the finish. |
| Awaited nested child exceeds resident/depth capacity | No child task/session/run admission committed. | Return `CONSOLE_CAPACITY_EXCEEDED`; do not queue a dependency the suspended parent requires. |
| Profile activation commits after a run or recursive invocation was admitted | New active pointer plus older invocation profile pin. | Continue the admitted invocation with its older pinned profile; use the activation only for later invocations. |
| Profile/context/recursive projections are missing or stale | Canonical session, profile-control, invocation, and prompt-provenance events remain. | Rebuild projections in global cursor order; do not execute a model or render replacement profile content. |
| Governed proposal commits before reviewer-child link | Stable proposal, validation, and frozen reviewer request. | Reuse or create the deterministic reviewer handle once; never start an unrelated review. |
| Reviewer model effect commits before decision/application | Exact frozen input, child completion, and terminal effect. | Finalize the typed decision and resume application without another provider call. |
| Approved non-skill application crashes mid-transition | Either no application batch or one complete decision/version/activation batch. | Revalidate and apply once, or return the retained terminal result. |
| Approved skill crashes during compile/tests | Retained candidate and outbox effects identify completed and pending stages. | Resume only missing safe stages; activation requires all retained tests to pass. |
| Terminal decision commits before notice delivery | Terminal record exists with no delivered-notice event. | Deliver the stable notice once to the exact origin route. |
| Exact rollback crashes before/after commit | Either no restoration or one complete restoration/version/activation batch. | Reuse the rollback identity; never rewrite or duplicate versions. |
| Formal action committed, application incomplete | Digest-linked action plus authoritative model effect. | Apply the same action once; do not call the provider again. |
| Blocked/failed finish terminal batch interrupted | Either no message/status batch or the complete atomic batch. | Reapply the same stable message/status identities without duplication. |
| Status set running, crash before/after model request finalization | Branch remains `running` without live ownership. | Finish any terminal call, then append recovery-to-idle once. |
| Snapshot write corrupt/missing | Canonical history unaffected. | `rebuild` discards snapshots and reduces events. |

## Manual reconciliation of unknown outcomes

Unknown effects are first-class inspectable state. The product client summarizes them at startup and exposes:

```sh
agencity unknown                       # selected branch
agencity unknown <EFFECT_ID>
agencity reconcile <EFFECT_ID> still_unknown "provider audit is inconclusive"
```

The TUI equivalents are `/unknown [EFFECT_ID]` and `/reconcile EFFECT_ID succeeded|failed|no_effect|still_unknown SUMMARY`. Protocol clients use `GET .../effects/unknown`, `GET .../effects/:effect/reconciliation`, and `POST .../effects/:effect/reconciliation`.

A reconciliation appends `EffectReconciliationRecorded` with an attributable operator identity, assessment, summary, optional JSON evidence, and stable reconciliation ID. Repeating the same ID and durable meaning returns the existing assessment; changed meaning conflicts. The event is evidence only: it does **not** replace `EffectOutcomeRecorded`, update the outbox row, change the projected effect from `unknown`, or execute/retry anything. Resume and reconnect likewise never retry an unknown non-idempotent effect. A separately chosen successor operation must receive a new logical idempotency key and should be started only after the operator determines it is safe.

Do not edit the `events` or `outbox` table to turn unknown into success.

## Guarantees and limits

Guaranteed by implemented paths:

- canonical appends and their operational projection writes share one local transaction;
- exact duplicate event idempotency keys return the original event; changed meaning conflicts;
- profile versions, active pointers, invocation pins, effect origins, provider-input admission, and effective-system-prompt provenance rebuild from canonical schema-version-5 events;
- non-idempotent lost ownership becomes unknown;
- projection replay never invokes effects;
- post-commit notification loss is repaired by cursor catch-up.

Not guaranteed:

- exactly once in an external system;
- recovery of heap objects or uncheckpointed cell variables;
- reconstruction of independently changed workspace/services;
- cross-device automatic execution-owner failover or distributed leases; local same-device managed-service takeover waits for the retained process lease to expire;
- crash-atomicity across database and artifact/filesystem placement before the canonical registration/outcome append; the registration and referencing outcome themselves are one local database transaction;
- cleanup of unreferenced CAS bytes;
- complete operating-system kill tests for every crash instruction boundary (tests simulate the durable boundary states).

## Process execution leases and fencing

`ExecutionLeaseService` provides local managed-service ownership and fencing. A claim is a transactional compare-and-swap against a workspace or root scope. An active competing owner receives `EXECUTION_OWNERSHIP_CONFLICT`; expiry or explicit release permits takeover and increments the retained fence token. Renewal and release require the exact device ID, process ID, and fence token while the lease is still live, so a stale owner cannot regain authority after takeover. Time is supplied by the service clock and persisted as canonical ISO timestamps for deterministic expiry tests.

Workspace and root scopes overlap deliberately: an active workspace lease excludes every root lease in that workspace, an active root lease excludes a workspace lease, and separate root leases can run independently. A root claim refuses a projected execution owner from another device. Process fencing therefore does not weaken the existing single-device rule: local LibSQL advertises `sameDeviceProcessFencing: true` and `distributedLeases: false`; the current relational HTTP placement advertises process fencing as unavailable because its version-1 call contract does not authenticate a caller device or expose these operations. Lease rows are operational local state and never synchronization envelopes.

The row and its last fence token survive normal release, process death, projection rebuild, and database reopen. The managed per-workspace service holds one workspace lease and lazily holds one root lease for each resident tree under the same process identity. Both proofs are checked inside the same LibSQL transaction as every existing-session canonical append and outbox claim/reset; a new root uses the workspace proof until its root row exists. A stale owner therefore cannot commit after takeover even if old code continues running. Local workspace databases use write-ahead logging (WAL), a connection-local busy timeout, and bounded jittered retries of the whole database-only transaction boundary. A persistent `SQLITE_BUSY`/`SQLITE_LOCKED` during lease claim, renewal, or release is reported as `EXECUTION_OWNERSHIP_CONFLICT` with `reason: sqlite_contention_exhausted`; an active owner, stale fence, scope overlap, or other semantic conflict returns immediately and is never relabeled or retried. Ordinary exhausted storage contention is `DEPENDENCY_FAILURE`, not a raw LibSQL exception.

Service restart takes over only after expiry (or attributable release), reconciles retained outbox/cell/run state before dependent continuation, makes lost non-idempotent work `unknown`, and never retries it. Database retry never encloses model, shell, file, skill, or other external execution. This remains same-device/local coordination, not cross-device failover.

## Synchronization recovery

When configured, startup opens the modern replica locally with a deferred `null` URL, checks its durable incarnation, and runs one envelope cycle before ordinary execution recovery. A new replica stages and pushes local change-data-capture (CDC) operations before its first pull; an established replica may pre-pull. Failure records replica `error` and startup continues locally with unsent CDC operations intact. Receipts make a crash after canonical append but before lifecycle reporting idempotent: the next cycle finds the event ID/receipt and does not append again. A dependency-missing envelope remains `pending_dependency`; integrity/schema/reducer failures remain quarantined. Reconnect and interval use the same serialized push/pull/checkpoint cycle. If the local replica file was replaced, an incarnation mismatch resets only staged watermarks and restages canonical local history; ingestion receipts/frontiers remain valid. Offline divergent source parents create deterministic derived branches. Profile-control divergence preserves both histories on those branches, records explicit conflict metadata, and blocks ambiguous runnable profile lookup instead of selecting a winner. Structured recursive result validation resolves only recorded sync-derived branch mappings, preserving exact child-completion provenance without rewriting immutable payloads. Synthetic fork events are local routing evidence rather than re-enveloped remote work.

## Wake delivery recovery

Heartbeat and schedule ticks atomically advance their definition and append one `WakeQueued`. The managed service starts this coordinator only after workspace lease publication; each session write then requires its root fence. It commits `WakeClaimed` before calling `AgentRunService` with a stable wake-derived run/request ID, then commits `WakeDelivered`. Restart re-enters the same stable run request; an outcome that cannot be safely reconciled becomes `WakeDeliveryUnknown` and is not blindly replayed. Missed intervals coalesce at tick creation.


## Context-compaction recovery

A compaction request freezes its exact sources before model work. On startup, outbox recovery runs first: an unclaimed request can proceed; a succeeded terminal model effect is consumed without a second provider call; a lost non-idempotent owner becomes `unknown`. `CompactionService.recoverIncomplete()` then deterministically finishes the derivation or appends `ContextCompactionFailed`. Budget debits and hierarchy effect keys are stable, so replay of committed success boundaries is idempotent. Recovery never deletes source events or treats unknown output as a summary.

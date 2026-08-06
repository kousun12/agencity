# Crash recovery and unknown effects

## Committed boundary

A cell has durable lifecycle events:

1. `CellProposed` records code and declared dependencies;
2. `CellStarted` records its attempt;
3. the disposable worker runs, using durable outbox requests for SDK effects;
4. success atomically appends staged `ArtifactRegistered`, `WorkingValueSet`, and `CellCommitted` events, or failure appends `CellFailed`.

Only a committed terminal event and its committed exports become later state. The worker heap is never replayed. Arbitrary replay could repeat a file edit, command, network call, or model generation.

## Startup sequence

Unless `recover: false`, `Supervisor.open` performs:

1. **Outbox reconciliation.** Each mutable `running` row whose owner disappeared is inspected.
2. **Safe requeue.** An effect declared idempotent returns to `pending` with its attempt count retained.
3. **Visible uncertainty.** A non-idempotent running effect gets a canonical `EffectOutcomeRecorded { outcome: "unknown" }`; it is not requeued. An anomalous pending non-idempotent row with a retained prior attempt is treated the same way; a normal pending first attempt remains safe to drain because it was never claimed.
4. **Cell abandonment.** Every branch projection with a `proposed`/`running` cell gets a branch-scoped idempotent `CellAbandoned` event. This includes a child fork that inherited an incomplete ancestor cell, without reusing the ancestor's idempotency key.
5. **Recovery evidence.** Affected branches get `RecoveryPerformed` with abandoned, unknown, and retried IDs.
6. **Cancellation recovery.** Recorded `SubagentCancellationRequested` crash prefixes are resumed before queued work; the original reason wins and descendants terminate leaf-first.
7. **Drain.** Pending/requeued effects execute and commit attempt/outcome events.
8. **Model finalization.** If a requested model call already has a durable terminal effect, the runtime records model/message/budget completion or termination without calling the model again.
9. **Status reconciliation.** A branch left `running` by a crash before model-request/finalization commits is returned to `idle` with a recovery event.
10. **Heartbeat recovery.** Due active schedules append one aligned tick plus wake message; paused/cancelled schedules are ignored.
11. **Goal recovery.** Running gate effects are reconciled to passed/failed/cancelled/unknown, the canonical gate-definition/workspace-material pin is re-checked before recovered success can pass, matching terminal evaluations are reused, and ambiguous or stale required gates block completion. Orphan legacy active goals migrate onto a stable typed AgentRun rather than the legacy text loop.
12. **Recursive-handle recovery.** Running terminal child calls finalize their durable task/model handle and atomically attribute direct usage to ancestors; safe pending handles re-enter the shared provider limiter. A committed handle resolves after console-worker or supervisor restart without repeating admission. Terminal `succeeded`, `failed`, `cancelled`, `budget-exceeded`, and `unknown` outcomes are retained separately; non-idempotent ambiguous calls are unknown and are never generated twice. Large completed values resolve through their registered content-addressed result artifact.
13. **Refinement-review recovery.** Every nonterminal review is relaunched in the background from its canonical request and frozen trajectory snapshot. A retained child link reuses the same recursive-model handle; a retained successful decision reuses the stable proposal identity and resumes validation, candidate activation, or exact allocation without duplication. A child `unknown` outcome becomes a terminal review `unknown` and is never retried. Deterministic malformed/over-scoped output becomes visible `failed`; infrastructure failure leaves the last committed nonterminal boundary for later recovery rather than inventing success. Automatic trigger consumption commits atomically with the terminal review status.
14. **Family-delivery recovery.** A committed send missing its recipient-delivery event completes that prefix (or records failed if the target became unavailable). Accepted queued messages enter context once; a context-delivered retained follow-up whose stable run request is missing schedules that same run ID. Acknowledged rows are left terminal.
15. **Agent-run recovery.** Queued/running typed runs reconcile retained model actions, cells, user decisions, cancellation, and unknown effects before another model call. Family follow-up terminal replies use the same retained run/message IDs and are not regenerated on repeated startup.

Recovery commands use stable branch-scoped idempotency keys, so repeating startup does not duplicate terminal state. Projection rebuild is a separate effect-free replay operation and does not run any of these schedulers or queues. Family message acceptance, context insertion, linked-artifact registration, and the two endpoint receipt updates are each atomic append batches; the only intentional asynchronous boundary is between context delivery and retained follow-up run admission.

## Refinement review boundaries

A review has four independently recoverable boundaries: `RefinementReviewRequested` freezes the strict request and bounded snapshot; `RefinementReviewChildLinked` names the durable recursive child; `RefinementReviewStatusChanged(running)` establishes model-result processing; and the terminal status is committed after either no-change or stable proposal/candidate processing. Refiner proposals carry `sourceReviewId` and a deterministic proposal fingerprint, so a crash after proposal append, validation, candidate creation, or allocation continues that same identity. Projection rebuild only replays these records and never restarts the child.

Migration 12 adds nullable snapshot/frontier projection columns so databases that already applied migration 11 still open. New reviews always persist both values. A legacy incomplete review without a frozen snapshot fails visibly rather than reconstructing a different context.

## Effect state machine

```text
EffectRequested -> pending outbox
                -> EffectAttemptStarted -> running
                -> EffectOutcomeRecorded(succeeded | failed | cancelled | unknown)
```

The request commits before execution. A terminal event is authoritative even if its original caller dies before receiving the result. Outbox status is a mutable operational projection of that event history. If two local runners race for a pending row, the loser waits for the winner's durable terminal outcome through the recorded lease instead of reporting a transient `unknown`.

`unknown` means the runtime cannot prove whether an external action happened. It is not failure, cancellation, or success. Examples include process death after a provider/service accepted a request but before the result committed, or after a non-idempotent command may have changed the world.

Provider stream deltas do not alter this lifecycle. They are process-local progress emitted only after `EffectRequested` and `EffectAttemptStarted`, have no cursor, and are never recovered or replayed. If a stream fails or is cancelled before the terminal success batch, no `ModelOutputChunk` or assistant `MessageAppended` commits. If the process disappears while the non-idempotent model effect is running, startup records `unknown`; it never promotes the observed prefix to a response and never retries the generation.

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
| Staged state/artifact reference before cell commit | No `WorkingValueSet`/`ArtifactRegistered` event. | Do not expose it. Unreferenced CAS bytes may remain. |
| Cell commit succeeds, process dies before notification | Complete canonical batch. | Snapshot/subscriber catch-up reads it from storage. |
| Model effect terminal, model-call finalization missing | Requested call plus terminal effect. | Finalize once without another provider call. |
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
- non-idempotent lost ownership becomes unknown;
- projection replay never invokes effects;
- post-commit notification loss is repaired by cursor catch-up.

Not guaranteed:

- exactly once in an external system;
- recovery of heap objects or uncheckpointed cell variables;
- reconstruction of independently changed workspace/services;
- cross-device automatic execution-owner failover or distributed leases; local same-device managed-service takeover waits for the retained process lease to expire;
- crash-atomicity across database and artifact/filesystem placement;
- cleanup of unreferenced CAS bytes;
- complete operating-system kill tests for every crash instruction boundary (tests simulate the durable boundary states).

## Process execution leases and fencing

Migration 008 and `ExecutionLeaseService` provide the local ownership primitive used by the FU-015 background-service work. A claim is a transactional compare-and-swap against a workspace or root scope. An active competing owner receives `EXECUTION_OWNERSHIP_CONFLICT`; expiry or explicit release permits takeover and increments the retained fence token. Renewal and release require the exact device ID, process ID, and fence token while the lease is still live, so a stale owner cannot regain authority after takeover. Time is supplied by the service clock and persisted as canonical ISO timestamps for deterministic expiry tests.

Workspace and root scopes overlap deliberately: an active workspace lease excludes every root lease in that workspace, an active root lease excludes a workspace lease, and separate root leases can run independently. A root claim refuses a projected execution owner from another device. Process fencing therefore does not weaken the existing single-device rule: local LibSQL advertises `sameDeviceProcessFencing: true` and `distributedLeases: false`; the current relational HTTP placement advertises process fencing as unavailable because its version-1 call contract does not authenticate a caller device or expose these operations. Lease rows are operational local state and never synchronization envelopes.

The row and its last fence token survive normal release, process death, projection rebuild, and database reopen. The managed per-workspace service holds one workspace lease and lazily holds one root lease for each resident tree under the same process identity. Both proofs are checked inside the same LibSQL transaction as every existing-session canonical append and outbox claim/reset; a new root uses the workspace proof until its root row exists. A stale owner therefore cannot commit after takeover even if old code continues running. Local workspace databases use WAL, a connection-local busy timeout, and bounded jittered retries of the whole database-only transaction boundary. A persistent `SQLITE_BUSY`/`SQLITE_LOCKED` during lease claim, renewal, or release is reported as `EXECUTION_OWNERSHIP_CONFLICT` with `reason: sqlite_contention_exhausted`; an active owner, stale fence, scope overlap, or other semantic conflict returns immediately and is never relabeled or retried. Ordinary exhausted storage contention is `DEPENDENCY_FAILURE`, not a raw LibSQL exception.

Service restart takes over only after expiry (or attributable release), reconciles retained outbox/cell/run state before dependent continuation, makes lost non-idempotent work `unknown`, and never retries it. Database retry never encloses model, shell, file, skill, or other external execution. This remains same-device/local coordination, not cross-device failover.

## Synchronization recovery

When configured, startup opens the modern replica locally with a deferred `null` URL, checks its durable incarnation, and runs one envelope cycle before ordinary execution recovery. A new replica stages and pushes local CDC before its first pull; an established replica may pre-pull. Failure records replica `error` and startup continues locally with unsent CDC intact. Receipts make a crash after canonical append but before lifecycle reporting idempotent: the next cycle finds the event ID/receipt and does not append again. A dependency-missing envelope remains `pending_dependency`; integrity/schema/reducer failures remain quarantined. Reconnect and interval use the same serialized push/pull/checkpoint cycle. If the local replica file was replaced, an incarnation mismatch resets only staged watermarks and restages canonical local history; ingestion receipts/frontiers remain valid. Offline divergent source parents create deterministic derived branches, and synthetic fork events are local routing evidence rather than re-enveloped remote work.

## FU-014 wake recovery

Heartbeat and schedule ticks atomically advance their definition and append one `WakeQueued`. The managed service starts this coordinator only after workspace lease publication; each session write then requires its root fence. It commits `WakeClaimed` before calling `AgentRunService` with a stable wake-derived run/request ID, then commits `WakeDelivered`. Restart re-enters the same stable run request; an outcome that cannot be safely reconciled becomes `WakeDeliveryUnknown` and is not blindly replayed. Missed intervals coalesce at tick creation.

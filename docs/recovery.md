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
11. **Goal recovery.** Running gate effects are reconciled to passed/failed/cancelled/unknown, the persisted workspace ID/cursor pin is re-checked before recovered success can pass, ambiguous or stale required gates block completion, and active autonomous goals resume bounded model turns.
12. **Recursive-handle recovery.** Running terminal child calls finalize their durable task/model handle and atomically attribute direct usage to ancestors; safe pending handles re-enter the shared provider limiter. A committed handle resolves after console-worker or supervisor restart without repeating admission. Terminal `succeeded`, `failed`, `cancelled`, `budget-exceeded`, and `unknown` outcomes are retained separately; non-idempotent ambiguous calls are unknown and are never generated twice. Large completed values resolve through their registered content-addressed result artifact.

Recovery commands use stable branch-scoped idempotency keys, so repeating startup does not duplicate terminal state. Projection rebuild is a separate effect-free replay operation and does not run any of these schedulers or queues.

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

Slice 1 surfaces unknown effects in history/snapshot but has no dedicated reconciliation/approval command. Until one exists:

1. stop automatic/manual attempts for the same logical action;
2. inspect the effect ID, input, attempts, timestamps, and idempotency key in canonical history;
3. query the external system using its own stable request/resource identifiers;
4. obtain user direction if the effect cannot be established;
5. submit a **new, explicitly chosen** compensating or retry operation with a new logical idempotency key only when safe.

Do not edit the `events` or `outbox` table to turn unknown into success. A future reconciliation API must append attributable evidence/events rather than rewrite retained history.

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
- automatic process-owner failover or distributed leases;
- crash-atomicity across database and artifact/filesystem placement;
- cleanup of unreferenced CAS bytes;
- complete operating-system kill tests for every crash instruction boundary (tests simulate the durable boundary states).

## Synchronization recovery

When configured, startup opens the modern replica locally with a deferred `null` URL, checks its durable incarnation, and runs one envelope cycle before ordinary execution recovery. A new replica stages and pushes local CDC before its first pull; an established replica may pre-pull. Failure records replica `error` and startup continues locally with unsent CDC intact. Receipts make a crash after canonical append but before lifecycle reporting idempotent: the next cycle finds the event ID/receipt and does not append again. A dependency-missing envelope remains `pending_dependency`; integrity/schema/reducer failures remain quarantined. Reconnect and interval use the same serialized push/pull/checkpoint cycle. If the local replica file was replaced, an incarnation mismatch resets only staged watermarks and restages canonical local history; ingestion receipts/frontiers remain valid. Offline divergent source parents create deterministic derived branches, and synthetic fork events are local routing evidence rather than re-enveloped remote work.

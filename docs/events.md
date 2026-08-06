# Event schemas (version 1)

`events` is the canonical append-only history. Version 1 is validated at the storage boundary; any other schema version is rejected. Released payload meaning must not be edited in place. Evolution requires a new event schema version and an explicit tested projection/upcast path. No upcaster exists because only event schema version 1 exists; Slice 2 adds new v1 event types and optional ancestry fields without rewriting retained rows.

## Header

Every stored event has:

| Field | Type | Meaning |
|---|---|---|
| `cursor` | decimal string | Opaque, ordered local database cursor derived from `events.sequence`; compare as integer/`BigInt`, not JS `number`. |
| `id` | non-empty string | Globally unique event identity (normally ULID). Consumers deduplicate on this field. |
| `sessionId` | non-empty string | Owning session. |
| `branchId` | non-empty string | Branch where the event was appended. Lineage reads may also include ancestor-branch events. |
| `causationId` | string or `null` | Direct causal event when supplied. Slice 1 does not require it on every append. |
| `correlationId` | string or `null` | Cross-event operation correlation when supplied. |
| `type` | `EventType` | Payload discriminator listed below. |
| `schemaVersion` | positive integer | Payload/header version; currently exactly `1`. |
| `committedAt` | string (normally ISO datetime) | Commit timestamp supplied or generated at the storage boundary. The v1 validator does not yet reject a caller-supplied non-ISO string. |
| `producer` | non-empty string | Usually `supervisor`, `console`, `model`, `executor`, `client`, or `recovery`. |
| `idempotencyKey` | string or `null` | Unique within `(sessionId, type)` when present. Same payload/branch deduplicates; changed meaning conflicts. |
| `payload` | JSON value | Typed by `type` and validated before append. |
| `originDeviceId` | non-empty string | Stable profile device that first committed the event; legacy rows expose a local fallback only during migration/export. |
| `originSequence` | positive safe integer | Monotonic sequence allocated by that origin device, independent of the local database cursor. |
| `streamParentId` | string or `null` | Previous event in the writer's source branch. Sync uses it for causal order and offline divergence detection. |

The relational columns use snake case and `payload_json`; TypeScript event objects use the camel-case fields above. Replication never treats `cursor` as portable. Immutable transport envelopes use `(originDeviceId, originSequence, id)`, `streamParentId`, explicit dependencies, and a SHA-256 digest; ingestion assigns a fresh local cursor after validation.

## Shared value schemas

```ts
type JsonValue = null | boolean | number | string | JsonValue[] |
  { [key: string]: JsonValue }; // finite numbers, plain acyclic objects

type EffectOutcome = "succeeded" | "failed" | "cancelled" | "unknown";
type SessionStatus = "idle" | "running" | "stopped" | "failed" | "archived";
type WorkingValue =
  | { kind: "json"; value: JsonValue }
  | { kind: "artifact"; artifactId: string };

type ArtifactReference = {
  artifactId: string; digest: string /* 64 lowercase hex */;
  mediaType: string; size: number /* nonnegative */;
};

type Usage = {
  inputTokens: number; outputTokens: number; costUsd: number;
}; // all nonnegative
```

A model configuration has required non-empty `provider` and `model`, with optional finite `temperature` and nonnegative `maxOutputTokens`. Budget limits optionally contain nonnegative `tokenLimit`, `costLimitUsd`, `turnLimit`, and `wallTimeLimitMs`.

## Payload registry

Optional fields are marked `?`. All IDs/names required by schema are non-empty strings unless a stricter note is shown.

| Event type | Version 1 payload | Projection/semantic effect |
|---|---|---|
| `SessionCreated` | `{ workspaceId, initialBranchId, model, budget, parentSessionId?, parentBranchId?, rootSessionId?, depth?, taskId? }` | Initializes a root or a normal child session. Child creation requires the complete parent/root/depth/task tuple; legacy/root rows project self as root and depth zero. |
| `BranchCreated` | `{ branchId, parentBranchId, forkCursor: decimal string, name?: string }` | Selects the new active branch projection. Storage records ancestry through the exact parent cursor. |
| `SessionStatusChanged` | `{ status: SessionStatus, reason?: string }` | Sets projected lifecycle status. |
| `MessageAppended` | `{ messageId, role: "system" | "user" | "assistant" | "tool", content: string, modelCallId?: string }` | Appends one conversation message. |
| `CellProposed` | `{ cellId, code: string, dependencies: string[] }` | Creates a proposed cell with attempt count zero. |
| `CellStarted` | `{ cellId, attempt: positive integer }` | Moves a proposed/running cell to running. |
| `CellCommitted` | `{ cellId, result: JsonValue, logs: string[], durationMs: nonnegative number, exports: string[] }` | Moves a running cell to committed. Working/artifact events are committed in the same append batch. |
| `CellFailed` | `{ cellId, error: string, logs: string[], durationMs: nonnegative number }` | Moves a running cell to failed; no staged state/reference is appended. |
| `CellAbandoned` | `{ cellId, reason: string }` | Recovery terminal for proposed/running cell; never implies its effects did not happen. |
| `WorkingValueSet` | `{ name, version: positive integer, value: WorkingValue }` | Replaces active named value only when version increases. |
| `ArtifactRegistered` | `{ artifactId, digest, mediaType, size, sourceEventId?: string }` | Registers integrity metadata; bytes remain in the artifact store. |
| `EffectRequested` | `{ effectId, executor, operation, input: JsonValue, idempotencyKey, idempotent: boolean }` | Canonical intent and source of a pending outbox projection. Commits before execution. |
| `EffectAttemptStarted` | `{ effectId, attempt: positive integer }` | Records an execution attempt and projects running status. |
| `EffectOutcomeRecorded` | `{ effectId, attempt: positive integer, outcome: EffectOutcome, output?: JsonValue, error?: string, observedAt: ISO datetime }` | Canonical terminal observation. Unknown remains visibly distinct. |
| `ContextMaterialized` | `{ contextId, records: ContextRecordReference[], contentHash: 64 lowercase hex, context: JsonValue }` | Records exact model context and provenance; also inserts immutable `context_records`. |
| `ModelCallRequested` | `{ callId, contextId, effectId, provider, model }` | Links a logical model call to exact context and durable effect. |
| `ModelOutputChunk` | `{ callId, sequence: nonnegative integer, text: string }` | Appends projected output text. Current complete-style provider emits one sequence-0 chunk after completion. |
| `ModelCallCompleted` | `{ callId, responseMessageId, finishReason: string, usage: Usage }` | Marks model call succeeded and links its assistant message/usage. |
| `ModelCallTerminated` | `{ callId, outcome: "failed" | "cancelled" | "unknown", error?: string }` | Visible non-success terminal state; no fabricated response. |
| `BudgetDebited` | `{ callId, tokens, costUsd, turns, wallTimeMs }` (all nonnegative) | Adds usage to projected counters. |
| `BudgetExceeded` | `{ dimension: "tokens" | "cost" | "turns" | "wallTime", limit: nonnegative, spent: nonnegative }` | Sets exceeded and idle; future turns reject. Boundary comparison is `>=`. |
| `RecoveryPerformed` | `{ abandonedCellIds: string[], unknownEffectIds: string[], retriedEffectIds: string[] }` | Audit evidence for a branch recovery pass; otherwise projection-neutral. |
| `TaskCreated` / `SubagentAdmitted` | Durable parent/task/child/model/budget intent, followed by matching admitted child IDs/time. | Creates a pending task then admits the already-created normal child session. |
| `TaskStatusChanged` / `SubagentCancellationRequested` | Task ID plus validated status/result/artifacts/error/reason or child cancellation intent. | Projects current task lifecycle without hiding cancellation intent; startup finishes recorded nonterminal cascades leaf-first and the first recorded reason wins retries. |
| `TaskUsageAttributed` | `{ taskId, childSessionId, tokens, costUsd, turns, wallTimeMs, conservative }` | Attributes a terminal child’s direct usage to each ancestor exactly once; unknown model usage consumes the unaccounted reservation conservatively. |
| `MailboxMessageSent` / `MailboxMessageDelivered` / `MailboxMessageAcknowledged` | Stable message and endpoint IDs, kind/content/task; delivery links `sentEventId`; ack names recipient/time. | Paired sender/recipient events project durable at-least-once mailbox delivery and acknowledgement. |
| `TaskTerminalNoticeSent` / `TaskTerminalNoticeDelivered` | Stable notice/task/parent/child IDs, terminal status and optional result/artifacts/error/reason; delivery links send. | Makes child termination visible in both session histories. |
| `DocumentImported` / `DocumentChunkAdded` | Document metadata/digest/count and ordered chunk ID/content/size/digest. | Imports exact large-input rows without injecting all content into model context. |
| `InputSetCreated` | `{ inputSetId, name?, chunkIds, metadata? }` | Freezes an ordered set of exact chunk row IDs for delegation/model input. |
| `GoalCreated` / `GoalCompletionRequested` / `GoalStatusChanged` | Goal/criteria/bound, durable completion request with `{ workspaceId, workspaceCursor }` pin, and validated terminal/blocked transition. | Projects autonomous goal lifecycle; live and recovered succeeded gates must match the durable pin. |
| `GoalGateAdded` / `GoalGateStatusChanged` | Typed executor request policy and pending/running/passed/failed/cancelled/unknown observation. | Gates are durable requests; required failures prevent completion. |
| `HeartbeatCreated` / `HeartbeatTicked` / `HeartbeatStatusChanged` | Interval/due time/goal/payload, monotonic tick timing, and active/paused/cancelled state. | Projects a restart-safe schedule; ticking never depends on an in-memory timer identity. |
| `RecursiveModelStarted` / `RecursiveModelStatusChanged` | Durable handle/task/parent/child/model/input-set IDs and pending/running/terminal status. | Projects immediately returned recursive model handles backed by normal child sessions. |

`ContextRecordReference` is `{ eventId, type: EventType, schemaVersion: positive integer, reason?: string }`. The source event must predate the context event; the materializer stores why each record was selected. The exact context is retained in the event/immutable `context_records` row; snapshots project only context provenance metadata to avoid repeatedly copying full historical prompts.

## Lifecycle groupings

### Console cell

```text
CellProposed -> CellStarted -> CellCommitted
                           \-> CellFailed
CellProposed/CellStarted   \-> CellAbandoned (recovery)
```

A cell's external effects have their own lifecycle and can outlive an abandoned cell. Do not infer that abandonment rolled them back.

### External effect

```text
EffectRequested -> EffectAttemptStarted -> EffectOutcomeRecorded
                                      outcome = succeeded | failed | cancelled | unknown
```

Retries append a new positive attempt number. Terminal truth is the outcome event; outbox owner/lease/status is operational.

### Task and child session

```text
TaskCreated -> child SessionCreated -> SubagentAdmitted -> TaskStatusChanged(running)
                                                    \-> completed | failed | cancelled
```

Completion/failure/cancellation atomically records a child-side terminal send, parent task transition and delivery, and child lifecycle stop/failure. A child is never a special persistence object: its `SessionCreated` ancestry and parent task are validated transactionally.

### Mailbox

A send and its recipient delivery commit in one batch. Acknowledgement appends one event to each endpoint so either detached session can rebuild what it knows; `mailbox_messages` is only a query projection.

### Model turn

A normal turn appends status-running, `ContextMaterialized`, `ModelCallRequested`, and the model `EffectRequested` before provider execution. Success appends output chunk, assistant message, model completion, budget debit, optional budget-exceeded, and status-idle. Non-success appends `ModelCallTerminated` and status-idle. Startup can finalize a call whose effect terminal event committed before the supervisor's model terminal batch.

### Goal gate and heartbeat

A completion request establishes one durable `requestId` plus its workspace ID/cursor pin. Each gate moves to `running` with its effect ID, then to `passed`, `failed`, `cancelled`, or `unknown`. A successful executor result is still changed to failed/stale if the workspace-relevant branch cursor moved during evaluation. Required non-passed gates lead to `GoalStatusChanged(blocked)`; only all current required passes permit `completed`.

A heartbeat's `tick` is monotonic. One append batch contains both `HeartbeatTicked` (scheduled time, actual fire time, aligned next due time) and a system `MessageAppended` wake-up. Missed periods do not emit a backlog. Replay/rebuild projects those events but never invokes the scheduler or goal loop.

## Ordering, branching, and reduction

- Database `sequence` defines the local cursor order. Consumers treat cursors as opaque ordered strings.
- A branch read consists of inherited ancestor events plus branch-local events. Every ancestor upper bound is clamped to the minimum fork cursor among all descendants, because a nested fork may target a cursor inherited from a grandparent rather than a direct-parent-local event.
- The reducer ignores an already-applied event ID, making duplicate delivery projection-neutral.
- The local storage command path rejects nonexistent session/branch targets and invalid transitions (for example, committing a missing/unstarted cell) inside the append transaction, so poison events never commit. Exact idempotency-key duplicates are returned before transition validation. A future synchronization adapter must quarantine invalid remote rows rather than weaken local validation.
- Snapshots include `reducerVersion: 2`; rebuilding always reads canonical events and checks deterministic equality.

## Publication contract

Events are made visible to subscribers only after database commit. Notifications are not stored truth. A consumer must snapshot/catch up by cursor and deduplicate by event ID. Historical/time-travel reduction never executes an effect.

## Current evolution limitations

Slice 1 validates one uniform `EVENT_SCHEMA_VERSION = 1`. There is no per-event version registry, persisted reducer package hash, or upcaster. Before changing any released payload, introduce a new accepted version, an explicit deterministic projection path, fixtures for old history, and protocol compatibility tests.


## Slice 3 harness, evaluation, and exact-version events

All Slice 3 payloads use schema version 1 and retain stable entry/version/proposal/candidate/allocation/observation/decision identifiers. Harness content is JSON validated against the payload kind. Projection rows can be rebuilt; these events are authority.

| Event | Durable meaning |
|---|---|
| `HarnessVersionCreated` | Creates one immutable `versionId` for an `entryId`, with monotonic version, kind, scope/key, name/content, tags, confidence, status, evidence/conflict IDs, optional superseded version/proposal, creator, and last-confirmed time. Storage enforces content-kind consistency, evidence existence, conflict existence, and replacement CAS. |
| `HarnessVersionStatusChanged` | Candidate activation, retirement, rejection, or rollback transition for an exact current entry/version, with reason and optional proposal. |
| `RefinementProposed` | Typed create/replace/retire edit set, trigger, predicted effect, evidence, objective evaluation, and proposing authority. |
| `RefinementValidated` | Validation result and complete CAS/evidence/authority diagnostics against the `proposed` status. |
| `RefinementCandidateActivated` | Candidate ID, exact candidate version IDs, and bounded allocation/exposure limits. |
| `RefinementCandidateAllocated` | One numbered target session/branch/task allocation within the candidate bound. |
| `RefinementCandidateExposed` | Proof that a specific allocation actually entered materialized context, including exact exposed versions. |
| `RefinementObservationRecorded` | Objective flag, success, evaluator, metric, baseline, evidence, and notes linked to an exposed allocation. |
| `RefinementApproved` | Explicit named user authority for user/global promotion. |
| `RefinementRollbackApproved` | Separate explicit owner/admin authority for user/global rollback; promotion approval never satisfies it. |
| `RefinementDecided` | Promote/revise/reject decision with evaluator, baseline, observation IDs, and the scope-sensitive rule applied. |
| `RefinementRolledBack` | Exact candidate versions invalidated and exact superseded versions restored, with reason. |
| `SkillInvocationRecorded` | Exact skill entry/version and durable effect ID/input for an invocation. |
| `SkillTestRecorded` | Exact skill entry/version/effect and compile/runtime test report. The associated `Effect*` events own execution outcome. |
| `SubagentSpecInvoked` | Exact spec entry/version pinned to a normally admitted durable task and child session/branch. |

`ContextMaterialized.harnessProvenance` records the immutable base-policy ID/version/digest separately from editable harness state, complete FTS query/candidate/rejection/selection provenance, candidate allocation/exposure provenance, and every selected entry/version/source event. Its `records` array also references selected `HarnessVersionCreated` event IDs.

## Slice 4 reconciliation event

| Event type | Version 1 payload | Projection/semantic effect |
|---|---|---|
| `SyncConflictResolved` | `{ conflictId, action: "keep-branches" | "choose-claim" | "cancel-duplicate" | "acknowledge", resolvedBy, chosenEventId?, note?, resolvedAt }` | Records explicit authority over a surfaced reconciliation. It updates the local reconciliation projection and replicates as ordinary canonical history; it never rewrites either claim or branch. |

Transport envelopes are not domain events. Invalid envelopes live in `sync_quarantine`; duplicate-intent, divergent-session, task-claim, and rejected-mutation observations live in sync reconciliation structures. Only a typed resolution is canonical.

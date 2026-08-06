# Event schemas (version 1)

`events` is the canonical append-only history. Version 1 is validated at the storage boundary; any other schema version is rejected. Released payload meaning must not be edited in place. Evolution requires a new event schema version and an explicit tested projection/upcast path. Slice 1 has no upcaster because only version 1 exists.

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

The relational columns use snake case and `payload_json`; TypeScript event objects use the camel-case fields above.

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
| `SessionCreated` | `{ workspaceId, initialBranchId, model: ModelConfiguration, budget: BudgetLimits }` | Must be first projected event; initializes session, branch, model, counters, and idle status. |
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

### Model turn

A normal turn appends status-running, `ContextMaterialized`, `ModelCallRequested`, and the model `EffectRequested` before provider execution. Success appends output chunk, assistant message, model completion, budget debit, optional budget-exceeded, and status-idle. Non-success appends `ModelCallTerminated` and status-idle. Startup can finalize a call whose effect terminal event committed before the supervisor's model terminal batch.

## Ordering, branching, and reduction

- Database `sequence` defines the local cursor order. Consumers treat cursors as opaque ordered strings.
- A branch read consists of inherited ancestor events plus branch-local events. Every ancestor upper bound is clamped to the minimum fork cursor among all descendants, because a nested fork may target a cursor inherited from a grandparent rather than a direct-parent-local event.
- The reducer ignores an already-applied event ID, making duplicate delivery projection-neutral.
- The local storage command path rejects nonexistent session/branch targets and invalid transitions (for example, committing a missing/unstarted cell) inside the append transaction, so poison events never commit. Exact idempotency-key duplicates are returned before transition validation. A future synchronization adapter must quarantine invalid remote rows rather than weaken local validation.
- Snapshots include `reducerVersion: 1`; rebuilding always reads canonical events and checks deterministic equality.

## Publication contract

Events are made visible to subscribers only after database commit. Notifications are not stored truth. A consumer must snapshot/catch up by cursor and deduplicate by event ID. Historical/time-travel reduction never executes an effect.

## Current evolution limitations

Slice 1 validates one uniform `EVENT_SCHEMA_VERSION = 1`. There is no per-event version registry, persisted reducer package hash, or upcaster. Before changing any released payload, introduce a new accepted version, an explicit deterministic projection path, fixtures for old history, and protocol compatibility tests.

# Relational table classification registry

This registry is part of the architecture contract. `bun run check:architecture` extracts every `CREATE TABLE` from every migration (plus SQLite's `sqlite_sequence` when `AUTOINCREMENT` is used), parses the rows below, rejects a missing/unknown classification, and verifies physical guards for immutable classes.

## Machine-checked registry

Do not change the first three columns or class tokens without updating the architecture policy/checker.

| Table | Classification | Mutability | Authority and recovery |
|---|---|---|---|
| `schema_migrations` | `migration-metadata` | `mutable` | Migrator-owned ledger. It is not domain state or model-visible; inserts record which immutable migration version was applied. Back it up with the DB and never derive agent behavior directly from it. |
| `events` | `canonical-append-only` | `immutable` | Sole authoritative domain history. The adapter may insert validated events; `events_no_update` and `events_no_delete` abort rewrite/deletion. Retained history is never rebuilt from a projection. |
| `sessions` | `rebuildable-projection` | `mutable` | Routing/index projection of `SessionCreated` (`session_id`, workspace, initial branch, execution-origin device, source event). Rebuild from events; no business transition may treat this row as canonical. The owner field prevents pulled work from becoming locally executable; it is not a distributed lease or failover mechanism. |
| `branches` | `rebuildable-projection` | `mutable` | Lineage/index projection of `SessionCreated` and `BranchCreated`. Rebuild from events; branch meaning remains in canonical payloads/cursors. |
| `snapshots` | `rebuildable-projection` | `mutable` | Disposable cached `AgentState` keyed by session/branch. Upsert/delete is expected. `rebuild` discards it and reduces canonical history. A current-cursor cache has no integrity hash in Slice 1 and must never be treated as authority. |
| `context_records` | `immutable-derived` | `immutable` | Exact derived model-context/provenance copy, tied one-to-one to `ContextMaterialized.event_id`. `context_no_update`/`context_no_delete` prevent drift; it can be reconstructed from retained context events, but a retained row is never rewritten. |
| `outbox` | `operational-projection` | `mutable` | Execution queue/status/attempt projection plus disposable owner/lease. Intent and terminal truth are `Effect*` events. Rebuild status from them; lost lease ownership is reconciled as safe retry or canonical unknown, never treated as success. |
| `tasks` | `rebuildable-projection` | `mutable` | Current task admission/status/result projection of `Task*` and `Subagent*` events. Parent/child identity and terminal truth remain canonical events. |
| `mailbox_messages` | `rebuildable-projection` | `mutable` | Delivery/ack query projection of paired mailbox events. It can be deleted and replayed without losing a message or acknowledgement. |
| `terminal_notices` | `rebuildable-projection` | `mutable` | Parent-visible terminal delivery projection of paired `TaskTerminalNotice*` events. |
| `documents` | `rebuildable-projection` | `mutable` | Imported document metadata projection of `DocumentImported`; canonical payload retains the metadata. |
| `document_chunks` | `rebuildable-projection` | `mutable` | Ordered content/query projection of `DocumentChunkAdded`. Chunk identity, digest, ordinal, and content are retained canonically. |
| `input_sets` | `rebuildable-projection` | `mutable` | Input-set header projection of `InputSetCreated`; exact ordered chunk IDs remain in the event. |
| `input_set_chunks` | `rebuildable-projection` | `mutable` | Normalized ordered membership projection derived entirely from `InputSetCreated.chunkIds`. |
| `goals` | `rebuildable-projection` | `mutable` | Current autonomous goal/request/status and completion workspace-pin projection; all transitions, pins, and reasons are canonical goal events. |
| `goal_gates` | `rebuildable-projection` | `mutable` | Current completion-gate request/outcome projection. Gate effects also use the canonical effect/outbox protocol. |
| `heartbeats` | `rebuildable-projection` | `mutable` | Due-time/tick/status projection of heartbeat events. Scheduler ownership is not durable identity. |
| `recursive_model_handles` | `rebuildable-projection` | `mutable` | Current recursive-call lookup/status projection; task, child session, model, and terminal transitions are events. |
| `harness_entries` | `rebuildable-projection` | `mutable` | Current harness entry/latest/active-version routing derived from canonical harness events. |
| `harness_versions` | `rebuildable-projection` | `mutable` | Query projection of immutable version identity/content and canonical status transitions; rebuilt from harness events. |
| `refinement_proposals` | `rebuildable-projection` | `mutable` | Current proposal lifecycle, bounds, validation, and approval summary derived from refinement events. |
| `candidate_allocations` | `rebuildable-projection` | `mutable` | Bounded allocation/exposure projection; allocation and exposure events are canonical. |
| `refinement_observations` | `rebuildable-projection` | `mutable` | Objective evaluation observation projection retaining event/evidence linkage. |
| `refinement_decisions` | `rebuildable-projection` | `mutable` | Promotion/revise/reject decision projection; evaluator, baseline, observations, and rule remain canonical. |
| `refinement_approvals` | `rebuildable-projection` | `mutable` | Explicit user/global promotion authority approval projection. |
| `refinement_rollback_approvals` | `rebuildable-projection` | `mutable` | Separate explicit owner/admin authorization for user/global rollback; promotion approval never satisfies it. |
| `refinement_rollbacks` | `rebuildable-projection` | `mutable` | Reversible decision/restore mapping derived from rollback events. |
| `skill_executions` | `rebuildable-projection` | `mutable` | Exact skill-version invocation/test linkage; execution request/outcome remains in canonical effect events. |
| `subagent_spec_invocations` | `rebuildable-projection` | `mutable` | Exact specification-version pin for a normally admitted durable child task. |
| `memory_fts` | `operational-projection` | `mutable` | Disposable FTS5 candidate index; it may be deleted/rebuilt from harness versions and never decides scope/status policy. |
| `device_clocks` | `operational-projection` | `mutable` | Per-workspace monotonic origin-sequence allocator keyed by stable profile device ID. Event IDs still deduplicate if this operational clock must be reconstructed. |
| `workspace_replica_status` | `operational-projection` | `mutable` | Truthful local lifecycle/error/incarnation/count, durable local replica placement, and official CDC/WAL/revision/network-stat observation for every current or historical replica identity. Administrative enumeration does not discard inactive rows or treat current configuration as the whole ownership boundary. |
| `sync_ingest_receipts` | `operational-projection` | `mutable` | Durable envelope dedupe/ingestion receipt. It can be rebuilt by comparing retained envelopes with canonical event IDs and origin metadata. |
| `sync_origin_watermarks` | `operational-projection` | `mutable` | Per-replica/per-origin incremental stage and terminal-ingest frontiers. They are performance hints: pending causal envelopes stop ingest advancement, a changed replica incarnation resets only staging, and retained receipts/quarantine remain the correctness boundary. |
| `sync_quarantine` | `operational-projection` | `mutable` | Invalid or causally incomplete replicated input, retained outside canonical history with explicit reason and release state. Independent-session erasure deletes rows whose envelope belongs to that session but blocks when a retained envelope for another session contains its ID. |
| `sync_branch_mappings` | `operational-projection` | `mutable` | Deterministic source-to-derived branch routing for offline divergent origin streams. Canonical source events plus envelope parents reproduce it. |
| `sync_reconciliations` | `operational-projection` | `mutable` | Surfaced duplicate intents, divergent advances, rejected mutations, and task claims. A user resolution is explicit metadata; it never rewrites canonical history or silently chooses a claim. |
| `data_manifests` | `operational-projection` | `mutable` | Ownership-checked export/deletion plan enumerating workspace/profile/artifact resources, every replica status/watermark/catalog placement, managed URLs and unaddressable identities. Planned/blocked/partial is never evidence that physical deletion completed. |
| `sqlite_sequence` | `engine-metadata` | `mutable` | SQLite-owned allocator created by `events.sequence INTEGER PRIMARY KEY AUTOINCREMENT`. It preserves increasing local cursors and is recoverable from the greatest retained sequence under SQLite rules. Application/model code must not mutate it directly. |

### Allowed classification vocabulary

- `canonical-append-only`: authoritative immutable domain history; insert-only adapter plus update/delete triggers.
- `immutable-derived`: attributable derived data frozen after insert; update/delete triggers required.
- `rebuildable-projection`: mutable acceleration/routing state whose behavior must be reproduced from canonical records.
- `operational-projection`: mutable queue/cache/lease state; canonical events determine durable intent/outcome and recovery handles discarded ownership.
- `migration-metadata`: migrator-owned version ledger, not agent domain state.
- `engine-metadata`: database-engine-owned state, not an application write surface.

No table is an unclassified mutable source of business truth. New migrations must add registry rows in the same change. A future lease/sync/index table must use an allowed operational class or extend this policy deliberately.

## Per-table write rules

### `schema_migrations`

Only `LibSqlStorage.migrate` inserts a successfully applied migration version. Agent-generated SQL cannot read it, and normal runtime services do not update/delete it. This metadata is mutable because future migrations append versions; it is not event sourced because it describes the database representation itself.

### `events`

Only the LibSQL adapter performs `INSERT INTO events`, inside the same transaction as affected operational/derived rows. A partial batch rolls back. Unique event IDs and the partial unique `(session_id, type, idempotency_key)` index prevent duplicate logical appends. Exact duplicate keys return the retained event; changed branch/payload conflicts.

SQL triggers make update/delete fail even on a separate administrative client. The architecture checker rejects `UPDATE`, `DELETE`, or `REPLACE` targeting `events` in application TypeScript. User-owned deletion/export across stores is a later product operation that must be designed explicitly; it must not masquerade as an ordinary event transition.

### `sessions` and `branches`

These tables speed listing and branch-lineage queries. Adapter event application inserts rows transactionally. They currently have no ordinary update API. Because they have no immutable trigger and are not authoritative, they are conservatively classified mutable/rebuildable rather than append-only truth.

`LibSqlStorage.rebuildOperationalProjections()` deletes and replays the session/branch routing rows together with all Slice 2 projections in global event cursor order. Repair uses that operation rather than ad hoc edits during execution.

### `snapshots`

Projection reads accept a snapshot only at the current branch cursor. `saveSnapshot` upserts it; `deleteSnapshots` discards it. `ProjectionService.rebuild` always deletes session snapshots, reduces the stream twice to check deterministic equality, then stores a fresh snapshot. Snapshots contain no unique authority. Slice 1 does not hash/sign `state_json`, so a manually corrupted cache at the latest cursor can be returned by `getSnapshot` until an explicit rebuild; canonical replay remains the repair path.

### `context_records`

The same append transaction that stores `ContextMaterialized` inserts its context row. The source event contains the complete context, source references, schema versions/reasons, and content hash, so the table is reconstructible. Physical immutability prevents the analytical copy from diverging from what the model received.

### `outbox`

The adapter creates it from `EffectRequested`, marks running during a serialized local claim/attempt, and applies terminal outcome. The row may transiently carry `owner` and `lease_expires_at`; those fields are never durable identity. A competing local claimant waits for the winner's durable outcome through that lease instead of reporting a race as unknown. If ownership disappears, recovery checks the canonical request's idempotence assertion: idempotent work returns pending, while running non-idempotent work appends an unknown outcome. A normal pending first attempt is safe to drain because no local claim occurred; a pending non-idempotent row with a retained attempt is conservatively marked unknown. Direct outbox edits are not a supported reconciliation API, and the table is private to model-visible SQL.

### Slice 2 recursive projections

`tasks`, mailbox/terminal delivery rows, document/chunk/input-set rows, goals/gates (including the completion workspace pin added by migration 003), heartbeats, and recursive model handles are updated in the same transaction as their canonical event. `rebuildOperationalProjections()` deletes these mutable rows and replays only their source events; it never re-executes a model, gate, tool, heartbeat callback, or subagent. Document content is duplicated in a query-friendly table for the Slice 2 foundation, but the `DocumentChunkAdded` event remains authoritative.

### Slice 3 harness and retrieval projections

Harness entry/version rows, refinement proposals, allocations/exposures, observations, approvals, decisions, rollbacks, skill execution links, and subagent-spec pins are updated only while appending their canonical events. `rebuildOperationalProjections()` replays all Slice 3 event types in cursor order. Stable entry/version identifiers belong to events; a current pointer or projected status is never authority. `memory_fts` implements only the candidate-index contract: delete/rebuild is explicitly supported, while deterministic scope/status/tag/recency filters and every rejection/selection are recorded by `ContextMaterialized`.

### `sqlite_sequence`

This internal table exists because event cursors use `AUTOINCREMENT`. It must be preserved by normal database backup/restore. Projection rebuilding never resets cursor allocation. It is excluded from domain APIs and migrations because SQLite creates/manages it.

## Other relational objects

`failed_tool_calls` is a **view**, not a mutable table. It derives counts by joining `EffectRequested` and failed `EffectOutcomeRecorded` events. Indexes (`events_idempotency`, session/branch cursor indexes, and `outbox_pending`) are disposable query structures and carry no authority. `sqlite_schema` is SQLite's DDL catalog rather than an application data table; schema changes happen only through reviewed migrations.

## Canonical mutation policy

Allowed:

- adapter `INSERT` into `events`/`context_records` as part of validated domain append;
- adapter mutations of classified projections/operational rows;
- reviewed migration DDL and migrator metadata inserts.

Forbidden:

- update/delete/replace of canonical or immutable-derived rows;
- canonical inserts from runtime/domain/protocol/console/executor code outside the storage adapter;
- generated console DML/DDL or private operational table access;
- treating a mutable row as proof when the corresponding event is absent;
- changing a classification without documenting recovery/authority consequences.


## Explicit physical erasure exception

The append-only guards above remain mandatory while data is retained. The sole scoped exception is
`LibSqlStorage.assertIndependentSessionErasable` plus `eraseIndependentSession`, operator-only capabilities absent from generated code and remote relational RPC. The first is non-mutating and protects CAS from later relational refusal; erasure repeats the check. Architecture checking audits the exact session predicate plus the transactional drop/recreate pair for `events_no_delete` and `context_no_delete`. Linked, replicated, harness/refinement, retained-event, or hidden retained-quarantine references return `CAPABILITY_UNAVAILABLE`; selected-session quarantine is deleted with the other operational rows. Whole-workspace deletion closes the database and removes its physical files; it does not issue ordinary canonical-table mutations.

# Relational table classification registry

This registry is part of the architecture contract. `bun run check:architecture` extracts every `CREATE TABLE` from every migration (plus SQLite's `sqlite_sequence` when `AUTOINCREMENT` is used), parses the rows below, rejects a missing/unknown classification, and verifies physical guards for immutable classes.

## Machine-checked registry

Do not change the first three columns or class tokens without updating the architecture policy/checker.

| Table | Classification | Mutability | Authority and recovery |
|---|---|---|---|
| `schema_migrations` | `migration-metadata` | `mutable` | Migrator-owned ledger. It is not domain state or model-visible; inserts record which immutable migration version was applied. Back it up with the DB and never derive agent behavior directly from it. |
| `events` | `canonical-append-only` | `immutable` | Sole authoritative domain history. The adapter may insert validated events; `events_no_update` and `events_no_delete` abort rewrite/deletion. Retained history is never rebuilt from a projection. |
| `sessions` | `rebuildable-projection` | `mutable` | Routing/index projection of `SessionCreated` (`session_id`, workspace, initial branch, source event). Rebuild from events; no business transition may treat this row as canonical. |
| `branches` | `rebuildable-projection` | `mutable` | Lineage/index projection of `SessionCreated` and `BranchCreated`. Rebuild from events; branch meaning remains in canonical payloads/cursors. |
| `snapshots` | `rebuildable-projection` | `mutable` | Disposable cached `AgentState` keyed by session/branch. Upsert/delete is expected. `rebuild` discards it and reduces canonical history. A current-cursor cache has no integrity hash in Slice 1 and must never be treated as authority. |
| `context_records` | `immutable-derived` | `immutable` | Exact derived model-context/provenance copy, tied one-to-one to `ContextMaterialized.event_id`. `context_no_update`/`context_no_delete` prevent drift; it can be reconstructed from retained context events, but a retained row is never rewritten. |
| `outbox` | `operational-projection` | `mutable` | Execution queue/status/attempt projection plus disposable owner/lease. Intent and terminal truth are `Effect*` events. Rebuild status from them; lost lease ownership is reconciled as safe retry or canonical unknown, never treated as success. |
| `sqlite_sequence` | `engine-metadata` | `mutable` | SQLite-owned allocator created by `events.sequence INTEGER PRIMARY KEY AUTOINCREMENT`. It preserves increasing local cursors and is recoverable from the greatest retained sequence under SQLite rules. Application/model code must not mutate it directly. |

### Allowed classification vocabulary

- `canonical-append-only`: authoritative immutable domain history; insert-only adapter plus update/delete triggers.
- `immutable-derived`: attributable derived data frozen after insert; update/delete triggers required.
- `rebuildable-projection`: mutable acceleration/routing state whose behavior must be reproduced from canonical records.
- `operational-projection`: mutable queue/cache/lease state; canonical events determine durable intent/outcome and recovery handles discarded ownership.
- `migration-metadata`: migrator-owned version ledger, not agent domain state.
- `engine-metadata`: database-engine-owned state, not an application write surface.

No Slice 1 table is an unclassified mutable source of business truth. New migrations must add registry rows in the same change. A future lease/sync/index table must use an allowed operational class or extend this policy deliberately.

## Per-table write rules

### `schema_migrations`

Only `LibSqlStorage.migrate` inserts a successfully applied migration version. Agent-generated SQL cannot read it, and normal runtime services do not update/delete it. This metadata is mutable because future migrations append versions; it is not event sourced because it describes the database representation itself.

### `events`

Only the LibSQL adapter performs `INSERT INTO events`, inside the same transaction as affected operational/derived rows. A partial batch rolls back. Unique event IDs and the partial unique `(session_id, type, idempotency_key)` index prevent duplicate logical appends. Exact duplicate keys return the retained event; changed branch/payload conflicts.

SQL triggers make update/delete fail even on a separate administrative client. The architecture checker rejects `UPDATE`, `DELETE`, or `REPLACE` targeting `events` in application TypeScript. User-owned deletion/export across stores is a later product operation that must be designed explicitly; it must not masquerade as an ordinary event transition.

### `sessions` and `branches`

These tables speed listing and branch-lineage queries. Adapter event application inserts rows transactionally. They currently have no ordinary update API. Because they have no immutable trigger and are not authoritative, they are conservatively classified mutable/rebuildable rather than append-only truth.

A rebuild procedure for these routing tables is not exposed in Slice 1, although their complete source fields exist in `SessionCreated`/`BranchCreated`. Until tooling exists, repair should happen offline from canonical events rather than by ad hoc edits during execution.

### `snapshots`

Projection reads accept a snapshot only at the current branch cursor. `saveSnapshot` upserts it; `deleteSnapshots` discards it. `ProjectionService.rebuild` always deletes session snapshots, reduces the stream twice to check deterministic equality, then stores a fresh snapshot. Snapshots contain no unique authority. Slice 1 does not hash/sign `state_json`, so a manually corrupted cache at the latest cursor can be returned by `getSnapshot` until an explicit rebuild; canonical replay remains the repair path.

### `context_records`

The same append transaction that stores `ContextMaterialized` inserts its context row. The source event contains the complete context, source references, schema versions/reasons, and content hash, so the table is reconstructible. Physical immutability prevents the analytical copy from diverging from what the model received.

### `outbox`

The adapter creates it from `EffectRequested`, marks running during a serialized local claim/attempt, and applies terminal outcome. The row may transiently carry `owner` and `lease_expires_at`; those fields are never durable identity. A competing local claimant waits for the winner's durable outcome through that lease instead of reporting a race as unknown. If ownership disappears, recovery checks the canonical request's idempotence assertion: idempotent work returns pending, while running non-idempotent work appends an unknown outcome. A normal pending first attempt is safe to drain because no local claim occurred; a pending non-idempotent row with a retained attempt is conservatively marked unknown. Direct outbox edits are not a supported reconciliation API, and the table is private to model-visible SQL.

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

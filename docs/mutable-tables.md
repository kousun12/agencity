# Relational table classification registry

This registry is part of the architecture contract. `bun run check:architecture` processes table creation, removal, and rename operations from workspace and profile migrations in order (plus SQLite's `sqlite_sequence` when `AUTOINCREMENT` is used), parses the rows below, rejects a missing/unknown current-table classification, and verifies physical guards for immutable classes.

## Machine-checked registry

Do not change the first three columns or class tokens without updating the architecture policy/checker.

| Table | Classification | Mutability | Authority and recovery |
|---|---|---|---|
| `schema_migrations` | `migration-metadata` | `mutable` | Migrator-owned ledger. It is not domain state or model-visible; inserts record which immutable migration version was applied. Back it up with the DB and never derive agent behavior directly from it. |
| `events` | `canonical-append-only` | `immutable` | Sole authoritative domain history. The adapter may insert validated events; `events_no_update` and `events_no_delete` abort rewrite/deletion. Retained history is never rebuilt from a projection. |
| `sessions` | `rebuildable-projection` | `mutable` | Routing/index projection of `SessionCreated` (`session_id`, workspace, initial branch, execution-origin device, source event). Rebuild from events; no business transition may treat this row as canonical. The owner field prevents pulled work from becoming locally executable; it is not a distributed lease or failover mechanism. |
| `branches` | `rebuildable-projection` | `mutable` | Lineage/index projection of `SessionCreated` and `BranchCreated`. Rebuild from events; branch meaning remains in canonical payloads/cursors. |
| `agent_profile_versions` | `rebuildable-projection` | `mutable` | Query projection of complete immutable agent-profile versions from `SessionCreated.agentProfile` and `AgentProfileVersionCreated`. Exact prompt text, digest, creator, specification source, and revision provenance remain canonical event payloads. |
| `workspace_agent_profiles` | `rebuildable-projection` | `mutable` | Current session-wide active profile pointer derived from `SessionCreated` and `AgentProfileActivated`. Storage uses this row for transactional compare-and-swap, but retained events remain authority and rebuild restores the pointer in global cursor order. |
| `snapshots` | `rebuildable-projection` | `mutable` | Disposable cached `AgentState` keyed by session/branch. Upsert/delete is expected. `rebuild` discards it and reduces canonical history. A current-cursor cache has no integrity hash and must never be treated as authority. |
| `context_records` | `immutable-derived` | `immutable` | Exact derived model-context/provenance copy, tied one-to-one to `ContextMaterialized.event_id`, including immutable typed `prompt_provenance_json` for profile/effective-system-prompt pins and `derivation_json` for compaction strategy/source/capacity provenance. `context_no_update`/`context_no_delete` prevent drift; it can be reconstructed from retained context events, but a retained row is never rewritten. |
| `outbox` | `operational-projection` | `mutable` | Execution queue/status/attempt projection plus disposable owner/lease. Intent and terminal truth are `Effect*` events. Rebuild status from them; lost lease ownership is reconciled as safe retry or canonical unknown, never treated as success. |
| `process_execution_leases` | `operational-projection` | `mutable` | Retained local process-owner/fence rows for workspace or root scope. Transactional claim/takeover monotonically increments the fence token; renew/release require the exact owner and token. Rows are never sync envelopes and provide no cross-device lease or automatic failover. |
| `tasks` | `rebuildable-projection` | `mutable` | Current task admission/status/result projection of `Task*`, `Subagent*`, and typed agent-run result events. Parent/child identity, pinned invocation contract, exact result reference, and terminal truth remain canonical events; public `/agent-invocations` lookup rebuilds without rerunning the child. |
| `mailbox_messages` | `rebuildable-projection` | `mutable` | Shared sender/recipient query projection of canonical send, mailbox delivery, context delivery/failure, and acknowledgement events. It retains intent/reply/task/artifact/relationship/message-mode/context-run fields plus queued/context-delivered/acknowledged/failed receipt state. `message_mode` retains new `steer`/`queue` intent; nullable legacy `follow_up` and `follow_up_run_id` columns preserve earlier schema-5 history and consuming-run linkage. New non-legacy queue-message run IDs are deterministic versioned derivations of immutable mailbox message IDs, not stored columns or new canonical fields. Sender result lookup checks this row and delegates to `agent_runs` only after admission; steer and legacy follow-up rows have no independent run result. Paired retained events without explicit context-receipt fields rebuild as context-delivered for compatibility; deletion/replay restores the exact row without delivering context or scheduling work. |
| `terminal_notices` | `rebuildable-projection` | `mutable` | Parent-visible terminal delivery projection of paired `TaskTerminalNotice*` events. |
| `documents` | `rebuildable-projection` | `mutable` | Imported document metadata projection of `DocumentImported`; canonical payload retains the metadata. |
| `document_chunks` | `rebuildable-projection` | `mutable` | Ordered content/query projection of `DocumentChunkAdded`. Chunk identity, digest, ordinal, and content are retained canonically. |
| `input_sets` | `rebuildable-projection` | `mutable` | Input-set header projection of `InputSetCreated`; exact ordered chunk IDs remain in the event. |
| `input_set_chunks` | `rebuildable-projection` | `mutable` | Normalized ordered membership projection derived entirely from `InputSetCreated.chunkIds`. |
| `goals` | `rebuildable-projection` | `mutable` | Current autonomous goal/request/status and completion workspace-pin projection; all transitions, pins, and reasons are canonical goal events. |
| `goal_gates` | `rebuildable-projection` | `mutable` | Current completion-gate request/outcome projection. Gate effects also use the canonical effect/outbox protocol. |
| `goal_gate_evaluations` | `rebuildable-projection` | `mutable` | Full gate-evaluation history keyed by canonical definition hash and attributable workspace-material version; canonical evaluation events retain cache and pin provenance. |
| `heartbeats` | `rebuildable-projection` | `mutable` | Due-time/tick/status/owner projection of heartbeat events. Scheduler ownership is not durable identity. |
| `schedules` | `rebuildable-projection` | `mutable` | Current one-time/interval schedule definition, owner, tick, and lifecycle projection rebuilt from schedule events. |
| `wake_queue` | `rebuildable-projection` | `mutable` | Durable queued/claimed/delivered/unknown wake projection; stable AgentRun identity and canonical wake events own recovery semantics. |
| `recursive_model_handles` | `rebuildable-projection` | `mutable` | Retained supervisor-private recursive-call lookup/status projection, including response admission, migration-016 `profile_pin_json`, and structured-result recovery fields; task, child session, model, response contract, profile pin, and terminal transitions remain canonical events. It supports historical inspection and sealed operations, not current public console or `/models` admission. |
| `ai_generations` | `rebuildable-projection` | `mutable` | Raw text/object generation lookup, idempotency, execution-owner status, effect, and result projection derived from canonical `AiGeneration*` events. Rebuild restores it without calling a provider; synchronized remote generations remain observational and never execute on the receiving device. Raw generations never create child sessions, tasks, profiles, or mailbox records. |
| `harness_entries` | `rebuildable-projection` | `mutable` | Current harness entry/latest/active-version routing derived from canonical harness events. |
| `harness_versions` | `rebuildable-projection` | `mutable` | Query projection of immutable version identity/content and canonical status transitions; rebuilt from harness events. |
| `refinement_reviews` | `rebuildable-projection` | `mutable` | Current trajectory-review request, durable recursive-child link, exact frozen snapshot/source hash/IDs, automatic-trigger frontier, and terminal status derived from canonical review events. |
| `refinement_trigger_consumptions` | `rebuildable-projection` | `mutable` | Per-branch automatic-trigger evidence frontier derived from canonical consumption events; it suppresses duplicate review admission but never hides the cited evidence. |
| `user_corrections` | `rebuildable-projection` | `mutable` | Typed user correction query projection; the correction text and exact earlier corrected event IDs remain in canonical `UserCorrection` events. |
| `refinement_proposals` | `rebuildable-projection` | `mutable` | Current proposal lifecycle, bounds, validation, and approval summary derived from refinement events. |
| `governed_refinement_proposals` | `rebuildable-projection` | `mutable` | Migration-017 query state, rebuilt without an operational-handle foreign key by migration 018, for the sealed-governance lifecycle, frozen constitution/policy/target/evidence/current-model dispatch/limits, exact reviewer child/decision, application outcome, and terminal-delivery pointer. Remote non-owner replicas retain reviewer identity from canonical events without materializing executable recursive-handle rows. Canonical governed-refinement events remain authority. |
| `governed_refinement_proposals_v2` | `rebuildable-projection` | `mutable` | Migration-018 staging name for rebuilding `governed_refinement_proposals` without the invalid operational-handle foreign key. The migration copies the event-derived rows, drops the old representation, and renames this table in the same transaction; the staging name is not present after migration. |
| `refinement_restorations` | `rebuildable-projection` | `mutable` | Migration-017 query projection of exact-content profile and harness restoration events; prior, source, and new immutable version identities, actor, reason, and evidence remain canonical. |
| `candidate_allocations` | `rebuildable-projection` | `mutable` | Bounded allocation/exposure projection; allocation and exposure events are canonical. |
| `refinement_observations` | `rebuildable-projection` | `mutable` | Objective evaluation observation projection retaining event/evidence linkage. |
| `refinement_decisions` | `rebuildable-projection` | `mutable` | Promotion/revise/reject decision projection; evaluator, baseline, observations, and rule remain canonical. |
| `refinement_approvals` | `rebuildable-projection` | `mutable` | Explicit user/global promotion authority approval projection. |
| `refinement_rollback_approvals` | `rebuildable-projection` | `mutable` | Separate explicit owner/admin authorization for user/global rollback; promotion approval never satisfies it. |
| `refinement_rollbacks` | `rebuildable-projection` | `mutable` | Reversible decision/restore mapping derived from rollback events. |
| `skill_executions` | `rebuildable-projection` | `mutable` | Exact skill-version invocation/test linkage; execution request/outcome remains in canonical effect events. |
| `skill_availability_actions` | `rebuildable-projection` | `mutable` | Workspace skill enable/disable/remove projection rebuilt from canonical `SkillAvailabilityChanged` events; current state is selected by the joined canonical event sequence (not timestamps), while retained immutable harness versions and invocation history remain separate. |
| `subagent_spec_invocations` | `rebuildable-projection` | `mutable` | Exact specification-version pin for a normally admitted durable child task. |
| `memory_fts` | `operational-projection` | `mutable` | Disposable FTS5 candidate index; it may be deleted/rebuilt from harness versions and never decides scope/status policy. |
| `device_clocks` | `operational-projection` | `mutable` | Per-workspace monotonic origin-sequence allocator keyed by stable profile device ID. Event IDs still deduplicate if this operational clock must be reconstructed. |
| `workspace_replica_status` | `operational-projection` | `mutable` | Truthful local lifecycle/error/incarnation/count, durable local replica placement, and official change-data-capture (CDC), write-ahead-log (WAL), revision, and network-stat observation for every current or historical replica identity. Administrative enumeration does not discard inactive rows or treat current configuration as the whole ownership boundary. |
| `sync_ingest_receipts` | `operational-projection` | `mutable` | Durable envelope dedupe/ingestion receipt. It can be rebuilt by comparing retained envelopes with canonical event IDs and origin metadata. |
| `sync_origin_watermarks` | `operational-projection` | `mutable` | Per-replica/per-origin incremental stage and terminal-ingest frontiers. They are performance hints: pending causal envelopes stop ingest advancement, a changed replica incarnation resets only staging, and retained receipts/quarantine remain the correctness boundary. |
| `sync_quarantine` | `operational-projection` | `mutable` | Invalid or causally incomplete replicated input, retained outside canonical history with explicit reason and release state. Independent-session erasure deletes rows whose envelope belongs to that session but blocks when a retained envelope for another session contains its ID. |
| `sync_branch_mappings` | `operational-projection` | `mutable` | Deterministic source-to-derived branch routing for offline divergent origin streams. Canonical source events plus envelope parents reproduce it. |
| `sync_reconciliations` | `operational-projection` | `mutable` | Surfaced duplicate intents, divergent advances, rejected mutations, and task claims. A user resolution is explicit metadata; it never rewrites canonical history or silently chooses a claim. |
| `data_manifests` | `operational-projection` | `mutable` | Ownership-checked export/deletion plan enumerating workspace/profile/artifact resources, every replica status/watermark/catalog placement, managed URLs and unaddressable identities. Planned/blocked/partial is never evidence that physical deletion completed. |
| `sqlite_sequence` | `engine-metadata` | `mutable` | SQLite-owned allocator created by `events.sequence INTEGER PRIMARY KEY AUTOINCREMENT`. It preserves increasing local cursors and is recoverable from the greatest retained sequence under SQLite rules. Application/model code must not mutate it directly. |
| `profile_schema_migrations` | `migration-metadata` | `mutable` | Profile migrator-owned contiguous ledger with immutable source digests. Unknown, missing, or changed applied versions prevent the profile from opening. |
| `profile_identity` | `operational-projection` | `mutable` | Profile-owned identity control record. It is separate from workspace event history and is included in profile backup and deletion scopes. |
| `devices` | `operational-projection` | `mutable` | Profile-owned device identities used for origin attribution and local execution ownership. |
| `preferences` | `operational-projection` | `mutable` | Profile-owned user and workspace preferences, including model-specific effort defaults. Preferences do not rewrite existing session configuration. |
| `preference_leases` | `operational-projection` | `mutable` | Expiring profile-local coordination leases. Automatic-learning pause/resume and admission use the trigger-policy lease to order one device-wide preference across workspace-service instances; a lease is never policy authority or retained learning history. |
| `credential_references` | `operational-projection` | `mutable` | Opaque profile-owned credential handles and non-secret metadata; credential values are stored outside this table. |
| `profile_skill_versions` | `canonical-append-only` | `immutable` | Immutable profile skill definitions, provenance, and test evidence guarded against update and deletion. |
| `profile_skills` | `operational-projection` | `mutable` | Current profile skill version and availability routing derived from retained profile skill actions. |
| `profile_skill_actions` | `canonical-append-only` | `immutable` | Immutable profile skill lifecycle actions guarded against update and deletion. |
| `workspace_catalog` | `operational-projection` | `mutable` | Profile-owned workspace discovery, placement, and credential-reference catalog. Workspace canonical state remains in each workspace database. |
| `model_catalog_cache` | `operational-projection` | `mutable` | Bounded, digest-checked normalized Gateway catalog cache keyed by normalized endpoint identity. It is safe to delete and refetch and never owns committed dispatch provenance. |

### Allowed classification vocabulary

- `canonical-append-only`: authoritative immutable domain history; insert-only adapter plus update/delete triggers.
- `immutable-derived`: attributable derived data frozen after insert; update/delete triggers required.
- `rebuildable-projection`: mutable acceleration/routing state whose behavior must be reproduced from canonical records.
- `operational-projection`: mutable queue/cache/lease state; canonical events determine durable intent/outcome and recovery handles discarded ownership.
- `migration-metadata`: migrator-owned version ledger, not agent domain state.
- `engine-metadata`: database-engine-owned state, not an application write surface.

No table is an unclassified mutable source of business truth. New migrations must add registry rows in the same change. Any lease, synchronization, or index table must use an allowed operational class or extend this policy deliberately.

The machine-checked registry covers both the canonical workspace database migrations and the separately opened profile database's immutable migration ledger. Profile preferences and catalogs remain profile-owned configuration/control records rather than workspace event authority.

## Per-table write rules

### `schema_migrations`

Only `LibSqlStorage.migrate` inserts a successfully applied migration version. Agent-generated SQL cannot read it, and normal runtime services do not update/delete it. This metadata is mutable because schema changes append versions; it is not event sourced because it describes the database representation itself.

### `events`

Only the LibSQL adapter performs `INSERT INTO events`, inside the same transaction as affected operational/derived rows. A partial batch rolls back. Unique event IDs and the partial unique `(session_id, type, idempotency_key)` index prevent duplicate logical appends. Exact duplicate keys return the retained event; changed branch/payload conflicts.

SQL triggers make update/delete fail even on a separate administrative client. The architecture checker rejects `UPDATE`, `DELETE`, or `REPLACE` targeting `events` in application TypeScript. User-owned deletion and export across stores are separate guarded administrative operations; they must not masquerade as ordinary event transitions.

### `sessions` and `branches`

These tables speed listing and branch-lineage queries. Adapter event application inserts rows transactionally. They currently have no ordinary update API. Because they have no immutable trigger and are not authoritative, they are conservatively classified mutable/rebuildable rather than append-only truth.

`LibSqlStorage.rebuildOperationalProjections()` deletes and replays the session/branch routing rows together with agent-profile and recursive-session projections in global event cursor order. Repair uses that operation rather than ad hoc edits during execution.

### Agent-profile projections

`agent_profile_versions` duplicates complete immutable profile versions for bounded query and inspection. `workspace_agent_profiles` stores one active version ID per session. Initial rows derive from the complete profile embedded in `SessionCreated`; later rows derive from `AgentProfileVersionCreated` and `AgentProfileActivated`. Projection deletion and replay restore the same versions and pointer without rendering a new prompt or invoking any model.

Profile identity is session-wide even though the current event header has only session and branch addresses. Later profile version and activation events must use the session's initial branch. The append transaction checks `expectedActiveProfileVersionId` against `workspace_agent_profiles`, then applies the canonical event and projection change together. Runtime lookup replays all retained events for the session rather than treating another conversation branch as a separate profile owner. This initial-branch control-event rule avoids a broad event-addressing cutover; it does not make profile state branch-local.

### `snapshots`

Projection reads accept a snapshot only at the current branch cursor. `saveSnapshot` upserts it; `deleteSnapshots` discards it. `ProjectionService.rebuild` always deletes session snapshots, reduces the stream twice to check deterministic equality, then stores a fresh snapshot. Snapshots contain no unique authority. The runtime does not hash or sign `state_json`, so a manually corrupted cache at the latest cursor can be returned by `getSnapshot` until an explicit rebuild; canonical replay remains the repair path.

### `context_records`

The same append transaction that stores `ContextMaterialized` inserts its context row. The source event contains the complete context, source references, schema versions/reasons, content hash, and optional invocation prompt provenance, so the table is reconstructible. Physical immutability prevents the analytical copy from diverging from what the model received.

### `outbox`

The adapter creates it from `EffectRequested`, marks running during a serialized local claim/attempt, and applies terminal outcome. The row may transiently carry `owner` and `lease_expires_at`; those fields are never durable identity. A competing local claimant waits for the winner's durable outcome through that lease instead of reporting a race as unknown. If ownership disappears, recovery checks the canonical request's idempotence assertion: idempotent work returns pending, while running non-idempotent work appends an unknown outcome. A normal pending first attempt is safe to drain because no local claim occurred; a pending non-idempotent row with a retained attempt is conservatively marked unknown. Direct outbox edits are not a supported reconciliation API, and the table is private to model-visible SQL.

### `process_execution_leases`

These rows fence competing processes that share one local canonical workspace database. Release marks a row rather than deleting it; an expired or released takeover increments `fence_token`, so an older process cannot renew or release after losing ownership. A workspace lease conflicts with every active root lease in that workspace, while a root lease conflicts with the workspace lease and permits independent roots to have distinct owners. Root claims also check the projected device execution owner and refuse a different device because distributed ownership transfer is unavailable.

The table is not canonical agent history and is not rebuilt from events. It intentionally survives projection rebuild and database reopen because forgetting the last token would allow a stale process proof to become current again. Whole-workspace physical deletion removes the database; narrow independent-root erasure removes only that root's lease row after the existing ownership/quiescence checks. The table is private to model-visible analytical SQL and is never staged into synchronization envelopes.

### Recursive session projections

`tasks`, mailbox/terminal delivery rows, document/chunk/input-set rows, goals/gates with their completion workspace pins, heartbeats, and recursive model handles are updated in the same transaction as their canonical event. `response_admission_json` and migration-016 `profile_pin_json` in `recursive_model_handles` are mutable projection data reconstructed from `RecursiveModelStarted`, not new sources of truth. Recursive-handle input/provenance/hash, response admission, profile pin, and outcome/structured-result/artifact columns are rebuildable query state; the corresponding `RecursiveModel*` events remain authoritative. Recovery before the first model request reads the exact retained response contract, capability seed, and profile pin instead of resolving current values again. A sealed refinement result is validated against that admission and the exact child completion; no current public console or protocol operation admits a recursive-model handle. `rebuildOperationalProjections()` deletes these mutable rows and replays only their source events; it never re-executes a model, gate, tool, heartbeat callback, or subagent. Document content is duplicated in a query-friendly table, but the `DocumentChunkAdded` event remains authoritative.

### Harness, governance, and retrieval projections

Harness entry/version rows, governed proposals, restorations, legacy candidate allocations/exposures, observations, approvals, decisions, rollbacks, skill execution links, and subagent-spec pins are updated only while appending their canonical events. `rebuildOperationalProjections()` replays all harness and refinement event types in cursor order. Stable proposal/review/entry/version identities belong to events; a current pointer or projected status is never authority.

`governed_refinement_proposals` projects `proposed`, `deterministically_rejected`, `validated`, `reviewing`, `reviewed_rejected`, `review_failed`, `review_unknown`, `reviewed_approved`, `apply_conflict`, `apply_failed`, and `applied`. Rebuild never calls a reviewer, compiles a skill, applies a version, or redelivers a notice. Recovery services resume those side effects from the last canonical boundary with stable identities. `refinement_restorations` is the exact-content rollback lookup; it is not permission to edit historical versions.

The ADR-0002 candidate/evaluation projections remain for advanced and legacy-compatible evaluation, not as mandatory authority for ordinary governed activation. `memory_fts` implements only the candidate-index contract: delete/rebuild is explicitly supported, while deterministic scope/status/tag/recency filters and every rejection/selection are recorded by `ContextMaterialized`.

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

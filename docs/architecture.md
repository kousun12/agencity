# Architecture and capability boundaries

## Recovery invariant and authority

At every **committed cell boundary**, state needed later must be one of:

- a canonical event and its typed payload;
- a named JSON working value;
- a registered content-addressed artifact reference plus available bytes;
- an external resource reference/outcome explicitly represented by an effect event.

The Bun heap, console globals, open handles, child processes, notifications, snapshots, and outbox leases are not durable identity. `events` is canonical. The reducer plus retained artifact contents projects `AgentState`; snapshots accelerate this and may be discarded. External files/services remain external and can change independently.

## Dependency direction

```text
                     domain
        (events, JSON, reducer, state, errors)
             ^         ^          ^
             |         |          |
      storage contract |   artifact/executor contracts
             ^         |          ^
       LibSQL adapter  |    local adapters
              \        |        /
               runtime services
             /        |        \
       console host  protocol    TUI
                         ^
                        CLI (composition entrypoint)
```

- `src/domain` has no adapter/runtime imports. Its event and state semantics are placement-independent.
- `src/storage/contract.ts` uses only domain values. Only `src/storage/libsql.ts` and `src/storage/turso.ts` may import LibSQL/Turso SDKs; the modern `@tursodatabase/sync` package is confined specifically to `src/storage/turso.ts`, and emitted package declarations must not expose SDK types.
- Artifact and executor interfaces expose stable IDs, JSON requests, four-way outcomes, and explicit failures rather than filesystem/child-process types.
- Runtime services compose contracts and own valid writes. Generated console SQL is analytical/read-only; SDK RPC invokes typed commands.
- Protocol and UI adapt runtime operations. The current TUI is in-process rather than an HTTP client; this is a known Slice 1 limitation.

`bun run check:architecture` makes the first two boundaries, package barrels, migration classifications, immutable guards, and canonical SQL rules executable.

## Relational storage

### Domain contract

`AgentStorage` owns append/stream event operations, branch lookups, snapshots, outbox claims, analytical reads, migration, and post-commit wakeups. Its public values are `AgentEvent`, `AgentState`, `JsonValue`, `OutboxRecord`, and domain request types. It is not a generic cross-database query abstraction.

| Capability | `LibSqlStorage` | Boundary meaning |
|---|---:|---|
| `offlineWrites` | yes | A local `file:` database can accept writes without a cloud service. |
| `analyticalSql` | yes | LibSQL-oriented, parameterized read-only SQL is available to console/runtime callers. |
| `notifications` | yes | In-process callbacks wake subscribers after this adapter commits. This is not distributed notification. |
| `distributedLeases` | no | Outbox claims are local DB transactions; there is no globally connected coordinator or ownership failover. |

The adapter retains a supervisor write/read client and creates a short-lived query-only analytical client per generated query so a deadline can close it without poisoning canonical writes. Local writes are serialized before SQLite transactions. Event append plus affected routing/context/outbox rows occurs in one local transaction. Before insertion, local commands are reduced against the transaction-visible branch state; nonexistent targets and invalid transitions are rejected atomically. A future sync adapter may quarantine invalid remote events rather than route them through this local command path. Event IDs are ULIDs and event cursors are zero-padded local sequence numbers. Cursors are ordering tokens, not portable timestamps.

PostgreSQL remains deferred. Slice 4 implements optional Turso Cloud exchange through a **separate envelope replica database**, leaving the workspace database locally authoritative and complete. A raw `syncUrl` on `LibSqlStorage` is still not itself a lifecycle; `SyncService` owns staging, the native exchange, ingestion, status, quarantine, reconciliation, and interval/reconnect behavior.

## Turso Cloud synchronization (Slice 4)

`ProfileStore` is a separate local LibSQL database containing a restart-stable device/profile identity, cross-workspace preferences, version-pinned globally installed skills, opaque credential references, and a workspace catalog. Credential values are never accepted. Each workspace retains its own canonical database and artifact directory.

Cloud exchange uses a second local file through `TursoSyncTransport` and pinned `@tursodatabase/sync@0.7.2`. Its `connect()` URL callback returns `null` during initialization, schema creation, staging, queries, checkpointing, and stats, and returns the configured URL only during an explicit official `push()` or `pull()`. This is the installed offline-first equivalent of `bootstrapIfEmpty:false`. There is no remote schema client, client swap, legacy frame topology, or invented `sync()` wrapper. Rejected network calls leave the same local database and unsent CDC usable. Capabilities truthfully advertise directional push/pull/checkpoint/stats for this adapter; the deterministic in-process hub remains `bidirectional-only`.

Only immutable, globally keyed `ReplicatedEnvelope` rows travel through the replica database. Turso Sync pushes logical CDC statements with last-push-wins conflict settlement, so physical envelope identity hashes the origin tuple plus event content; logical event ID and origin sequence are indexed claims, not transport primary keys, so colliding raw claims remain available for quarantine and reconciliation. Workspace `events.sequence`, snapshots, outbox leases, and other mutable projections never rely on libSQL's replicated last-write behavior. Envelopes carry device/origin sequence, exact event identity, source-branch parent, dependency IDs, and a stable SHA-256 digest. Ingestion validates schema/integrity, compares duplicate-event content digests, topologically orders causal parents, deterministically orders concurrent envelopes, and quarantines divergent/invalid/incomplete input before canonical append. Durable per-origin staging and terminal-ingest frontiers avoid rescanning settled history; a pending dependency stops frontier advancement and receipts/quarantine remain the correctness boundary. An immutable replica-incarnation marker detects a lost/replaced local sync file and clears only the staging frontier so canonical history is restaged.

If two devices advance one historical branch offline, the local execution stream stays on its original branch and the remote stream is mapped to a deterministic derived branch at the shared parent. Both histories remain inspectable. Duplicate intents and rejected mutations enter reconciliation records. Competing `TaskStatusChanged(...running)` claims produce an unresolved `task_claim`; no last-writer policy chooses an owner. `sessions.execution_owner_device_id` remains the creating device. Only that device materializes effect/goal/heartbeat/model requests as locally executable operational work; every non-owner retains the canonical events but has no outbox row, and model/cell execution there returns `CAPABILITY_UNAVAILABLE`. A request authored on another trusted device can therefore become a command for the owner after replication. This is an explicit trusted single-user cross-device effect channel, not an authenticated multi-tenant channel; replica writers must share the owner's trust boundary. An explicit `SyncConflictResolved` event records the user's action and synchronizes it. Distributed leases, task stealing, global budget reservation, and automatic owner failover remain unavailable.

Startup, reconnect, interval, and manual cycles stage local envelopes, optionally pre-pull an established revision, push, pull conflict-resolved state, ingest, and checkpoint. A new replica pushes first so first-launch CDC is never discarded. Directional calls and official CDC/WAL/revision/network statistics update `workspace_replica_status` only after the corresponding operation. Network failure leaves local execution available and records `error`; it never fabricates a successful push/pull. Cloud discovery reads replicated workspace announcements. Export/deletion manifests enumerate the workspace/profile/artifact/replica resources and mark remote deletion blocked because the installed data client has no ownership-admin deletion API.

## Canonical versus derived relational data

Canonical events are physically guarded against update and delete. Context records are immutable derived provenance and have the same physical guards. Mutable tables are limited to migration metadata, rebuildable routing/snapshot projections, and the operational outbox/lease projection. [The table registry](./mutable-tables.md) specifies every table and is checked against every migration.

The adapter is the only code allowed to issue canonical inserts. Application state changes call `appendEvents`; the checker rejects update/delete/replace patterns for immutable tables anywhere in `src`.

## Recursive sessions (Slice 2)

Root agents, delegated subagents, and isolated recursive model calls all use the same `SessionCreated` event and `AgentState`. Child creation stores `parentSessionId`, `parentBranchId`, `rootSessionId`, `depth`, and `taskId`; storage validates those fields against the parent and the task row in the same append transaction. The public composition root exposes `Supervisor.agents`, `.documents`, `.models`, `.goals`, and `.heartbeats`. Their returned handles contain only JSON domain values and are returned only after the creating event batch commits.

A spawn batch validates and reserves the whole batch, then records every parent task, child session/initial prompt, and admission in one local transaction. Stable idempotency keys return the original handles—including their truthful current terminal status—without duplicating work. `maxChildrenPerSession` counts active direct children, not lifetime descendants. Child limits inherit from and cannot widen their parent; admission subtracts already-spent tree usage plus remaining active sibling reservations. Terminal child token/cost/turn/wall usage is attributed to every ancestor exactly once, with unknown usage consuming the unaccounted reservation conservatively. Mail sends, deliveries, acknowledgements, and task terminal notices are paired across normal session streams, restricted by `rootSessionId` and durable task ownership. Cancellation walks all admitted descendants leaf-first and startup completes any recorded crash prefix. Current routing/status rows accelerate list/get operations, but `rebuildOperationalProjections()` can delete and reconstruct all Slice 2 tables in global cursor order without running work.

Recursive model execution builds on a task plus child session. `models.start` atomically commits task, child, prompt/input, and recursive handle; `idempotencyKey` gives retries a stable handle. `startMany` admits one all-or-nothing batch. Every model effect (root turn, recursive call, or model-backed gate) shares the configurable `providerConcurrency` limiter, defaulting to one per provider; result/error/cancellation reaches the parent through task/terminal events. Cancelling while queued prevents provider entry, in-flight cancellation reaches the outbox abort signal, and uncertain non-idempotent recovery becomes `unknown` without retry. Depth and direct-child limits are explicit supervisor configuration (`maxSessionDepth`, `maxChildrenPerSession`) rather than hidden process state.

Documents are imported as metadata plus ordered, digested `DocumentChunkAdded` rows. An import idempotency key yields deterministic document/chunk identities. An input set freezes exact ordered chunk IDs and is authorized only inside one root family. Root context receives document/input-set metadata and SQL query hints rather than full content; a recursive child call receives the exact selected IDs and contents in its attributable context.

Goals own typed completion gates which execute through the existing request-before-effect outbox. Completion pins a workspace-relevant branch cursor, rejects stale or unknown evidence, and re-evaluates gates after continuation changes. Startup reconciles incomplete gates, re-checks each persisted workspace pin, and resumes active goals. Heartbeats project interval, next due time, monotonic ticks, and pause/cancel state; an aligned tick and wake message commit atomically. Startup fires due active schedules and a live database-polling scheduler continues firing future due rows until `Supervisor.close()`. No JavaScript timer or queue object is durable identity.

## Artifact storage

`ArtifactReference` is `{ artifactId, digest, mediaType, size }`; local IDs are `sha256:<digest>`. Identity does not encode a local path. The contract supports:

| Shared operation | Local CAS | Semantics |
|---|---:|---|
| put/deduplicate | yes | Atomic placement by digest; identical bytes share one object even when media types differ. |
| resolve/verify | yes | Validate ID/digest/size and fail visibly for missing/tampered content. |
| range read | yes | Current adapter verifies the complete object before slicing; not an optimized remote range operation. |
| export | yes | Verify, create destination parents, copy bytes. |
| delete | yes | Physical deletion; higher layers must enforce scope/retention and accept broken references if misused. |
| remote placement/replication | no | No object-store implementation or replication manifest. |

Artifact registration is canonical; bytes are outside the database. A successful `put` during a later-failed cell may leave an unreferenced physical object. That is safe for projection but there is no garbage collector yet.

## Execution

`EffectExecutor` consumes a durable domain request and `AbortSignal`, then returns `succeeded`, `failed`, `cancelled`, or `unknown`. Request and terminal outcome are canonical; the mutable outbox is operational. Capability behavior is executor-specific and must not be weakened silently.

| Executor | Supported operations | Isolation/retry boundary |
|---|---|---|
| `FileExecutor` | `read`, atomic `write`, exact-one `replace`, file `delete` | Root/symlink checks; rejects directory delete. Write can detect already-desired bytes and use an expected digest. This confines the typed adapter, not arbitrary process code. |
| `ShellExecutor` | `run` with cwd and timeout | Initial cwd must be under root, output is capped/scrubbed, abort kills the child. It uses `/bin/sh -c`, not a login shell that could reload filtered credentials. The command retains ambient OS/network authority and is normally non-idempotent. |
| `ModelExecutor` | `complete` through registered provider | Abort-aware provider call. Calls are non-idempotent; lost outcomes become unknown rather than a blind second generation. Slice 1 persists one post-completion output chunk, not live provider token streaming. |

Cancellation is best effort: an abort signal can stop an in-process executor, but external systems may already have acted. A `cancelled` record is an observed executor result, not a universal rollback.

No remote sandbox executor, capability negotiation object, per-provider distributed concurrency, resource quota enforcement, or browser executor exists yet. The shared executor interface is the extension point; any remote implementation must preserve IDs, request-before-effect ordering, outcomes, cancellation disclosure, and idempotency semantics.

## Retrieval and context

The runtime has **context selection and Slice 2 document chunk queries**, not the later semantic-memory retrieval system. `ContextMaterializer` deterministically selects the base policy, session/branch/status, recent messages, all active working values and artifact references, budget events, and recent completed/failed activity. It records every selected source event ID, event type, schema version, reason, and a hash of the exact JSON context in immutable `context_records`. The exact bytes remain in the canonical context event/immutable record, while `AgentState.contexts` projects only provenance metadata rather than copying every historical full context into snapshots.

Console SQL can query retained relational rows and artifact references can be resolved explicitly. The document service imports ordered chunks and creates exact input sets, while agent/recursive-model services delegate those references through normal child sessions. There is still no FTS candidate-index contract, scoped semantic memory, embeddings, semantic service, or retrieval evaluator; deterministic IDs and explicit chunk queries are the Slice 2 foundation.

Any future retrieval adapter must return stable domain IDs plus query/rule provenance. Scope/status/policy filters remain authoritative; engine-specific scores or embedding objects must not escape its adapter.

## Reactive interface

`ProjectionService.getSnapshot` returns a projection and cursor. `subscribe`/`events` catch up from durable storage after that cursor and use adapter commit notification only as a wake-up. Reducers ignore duplicate event IDs, and cursor order is deterministic within this local database. HTTP SSE adapts this interface.

Historical projection (`atCursor`) and branch forks replay state transitions only. They never execute console code, tools, or model calls.

## Security placement

Process separation improves lifecycle control, not privilege isolation. The console, shell, file adapter, supervisor, and unauthenticated protocol all operate inside the trusted-local boundary. `sdk.harness.list/history` are model-facing policy views restricted to active local/workspace/user/global records plus an exact exposed candidate allocation; they never return another workspace or an unexposed candidate. Raw SQL is different: it is a shared, non-confidential diagnostic surface and may read non-private cross-workspace/candidate projections. Candidate exposure is behavioral isolation, not secrecy. Environment filtering, secret redaction, read-only SQL, path checks, and validation are defense-in-depth against accidents. See [Security](./security.md) for threat/non-threat claims.

## Public replacement rules

A replacement component may add capabilities but must preserve:

- stable identifiers and causal/event semantics;
- commit-before-publication and request-before-effect ordering;
- four-way effect outcomes and visible uncertainty;
- integrity/dependency failures for artifact references;
- deterministic shared projection behavior;
- domain-shaped contracts with adapter SDK types confined to the adapter;
- explicit `CAPABILITY_UNAVAILABLE` behavior instead of silent downgrade.

Only the local implementations are tested today. A future adapter is not supported merely because it structurally implements the interface; it needs the shared conformance suite planned by the PRD.


## Slice 3 relational memory and refinement boundary

Harness ownership is split between immutable canonical history and rebuildable current/query state:

```text
Harness*/Refinement*/Skill*/SubagentSpec* events (authority)
                         |
                         v
 harness_entries + harness_versions + refinement/evaluation projections
                         |
                         +--> disposable FTS5 candidate index
                         |
                         v
 deterministic policy filter --> ContextMaterialized exact provenance
```

`entryId` names a durable memory/prompt-note/skill/spec; `versionId` names immutable content. An entry keeps a latest candidate pointer independently from its active-version pointer, so a candidate replacement never hides the active baseline outside allocated sessions. Candidate allocation and actual context exposure are separate bounded events. Rejection/rollback restores an exact superseded version rather than editing content.

FTS5 is only a candidate generator. The runtime then authoritatively applies session/workspace scope keys, requested scope/status, tags, recency, explicit links, and a stable tie-break. Conflict edges are evaluated symmetrically: either side may declare the edge, while an explicit user/global user preference suppresses a conflicting inferred workspace/local result; provenance records the declaration side, winner, and suppressed version. Context persists normalized query, filters, candidate source, rejection reasons, conflicts, final ranks, exact entry/version IDs, and source events. Deleting/rebuilding `memory_fts` cannot change ownership or status. Embeddings can later supply another candidate source without changing the policy or provenance contract.

The base runtime policy is a frozen runtime constant with ID/version/digest and is serialized separately from `context.harness`. Harness edits have no base-policy kind, reserved policy names are rejected, and generated skill permissions cannot expand permission/safety policy.

Refinement uses proposal validation and activation CAS, including a repeated local/workspace ownership check and transaction-visible duplicate-name guard. A revise/reject decision rejects every candidate version so create names and active baselines are never stranded. Objective observations bind evidence to the exact allocated session/branch/task and to the predeclared metric/test command when structurally available. User/global rollback has its own owner/admin approval event and projection; promotion approval is deliberately insufficient.

Generated skills are the additional hard gate: a candidate version is created for attribution, then Bun compilation and every declared runtime case execute in a separate process through the ordinary durable outbox. Only a passing report permits bounded candidate activation. The configured permission-name allowlist is checked at validation, activation, testing, and invocation. Invocation repeats compilation for the exact pinned immutable source and records both effect and skill-version linkage. This is trusted-local process isolation, not a new sandbox.

Subagent specs contain role, invocation criteria, expected artifact, prompt, optional model/budget, and completion criteria. Invocation resolves one active exact version and extends `AgentService.spawnManyWithEvents`; all existing ancestry, child-count, model, budget, idempotency, and atomic admission rules remain authoritative.

Promotion policy is deliberately scope sensitive: one durable supported success can promote local state; workspace promotion needs objective successes in distinct allocations; user/global state requires an explicit named approval event. Decisions always retain evaluator, baseline, observation IDs, and rule. Reject/revise and post-promotion rollback are first-class outcomes.


## Data-control boundary

Append-only is a retention rule, not a denial of user deletion. Normal connections and generated code always retain immutable-table triggers. Explicit independent-session erasure first runs the same non-mutating link/hidden-reference preflight used by the storage transaction, removes only unshared CAS objects, then rechecks and removes/recreates immutable delete guards inside one transaction. Selected-session quarantine rows are operational and removed; a retained quarantine envelope that merely mentions the session blocks erasure.

Workspace/profile erasure closes handles before unlinking files and writes an external receipt when the database containing its manifest disappears. Workspace ownership is not tombstoned before fallible remote/local/CAS work; a partial attempt therefore remains reopenable. Removed lists are postcondition observations, not planned paths. Successful workspace tombstones retain only anti-reclaim identity/owner/timestamps and scrub names, placements, sync URLs, and credential references.

Artifact placement is fail-closed: session erasure reference-counts retained event payloads, while whole-workspace removal requires an operator assertion that the entire CAS root is exclusive. Relational sync is not an administrative control plane. Administrative planning enumerates all historical replica-status rows, watermarks/counters and profile-catalog evidence, preserves the legacy adjacent/default replica path, and never downgrades a prior managed workspace merely because the current process lacks sync configuration. Every distinct addressable URL requires the separate authenticated adapter; an unaddressable replica or unsupported remote granularity blocks. Stable scope/owner/URL idempotency makes authenticated retries safe. Outbox admission is quiesced and running/claiming effects refuse deletion before physical data can race an executor.

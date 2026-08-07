# Architecture and capability boundaries

Agencity separates durable agent state from disposable computation. A local workspace database retains the event history and query projections needed to reconstruct work; content-addressed artifact storage holds larger immutable bytes; a Bun worker executes generated TypeScript without owning the agent's identity. Runtime services validate changes, execute external work through a recorded queue, and expose the same state to terminal and protocol clients.

This document describes which records are authoritative, which components may be replaced, and which guarantees are unavailable. The [capability reference](./capabilities.md) provides a shorter product-level summary.

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
       LibSQL adapter  |  placement adapters
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
- Protocol and UI adapt runtime operations. The product TUI is a full-screen OpenTUI client over the authenticated loopback `AgentClient`; explicit diagnostic TUI routes use `InProcessProtocolTransport` through the same public `ProtocolServer.handle` router. Both retain snapshot-plus-cursor semantics and keep presentation state non-canonical.

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

The adapter retains a supervisor write/read client and creates a short-lived query-only analytical client per generated query so a deadline can close it without poisoning canonical writes. Local file databases enable write-ahead logging (WAL) and apply a connection-local `busy_timeout`. Local writes are serialized before SQLite transactions; independent processes still contend through SQLite, so complete database-only transaction and read/statement boundaries retry `SQLITE_BUSY`/`SQLITE_LOCKED` a bounded number of times with jitter. A retry always replays the whole database boundary after rollback, never an executor call or other external effect, and semantic validation/ownership conflicts are not retried. Exhausted ordinary contention becomes `DEPENDENCY_FAILURE`; exhausted process-lease contention becomes `EXECUTION_OWNERSHIP_CONFLICT` with `reason: sqlite_contention_exhausted`, rather than exposing an adapter `LibsqlError`.

Event append plus affected routing/context/outbox rows occurs in one local transaction. Before insertion, local commands are reduced against the transaction-visible branch state; nonexistent targets and invalid transitions are rejected atomically. Synchronized remote envelopes use a separate ingestion path that quarantines invalid input instead of weakening local command validation. Event IDs are ULIDs and event cursors are zero-padded local sequence numbers. Cursors are ordering tokens, not portable timestamps.

`HttpRelationalStateStore` exposes the `AgentStorage` contract through a capability-negotiated JSON/HTTP adapter. Its current protocol supports canonical and recursive operations but does not provide offline writes, commit notifications, or same-device process fencing. Local and HTTP-backed relational placements share conformance coverage. The adapter is a replaceable transport boundary; this repository does not supply hosted relational infrastructure, tenancy, or service operations.

PostgreSQL remains unavailable. Optional Turso Cloud exchange uses a **separate envelope replica database**, leaving the workspace database locally authoritative and complete. A raw `syncUrl` on `LibSqlStorage` is not a synchronization lifecycle; `SyncService` owns staging, native exchange, ingestion, status, quarantine, reconciliation, and interval/reconnect behavior.

## Turso Cloud synchronization

`ProfileStore` is a separate local LibSQL database containing a restart-stable device/profile identity, cross-workspace preferences, version-pinned globally installed skills, opaque credential references, and a workspace catalog. Credential values are never accepted. Each workspace retains its own canonical database and configured content-addressed artifact placement.

Cloud exchange uses a second local file through `TursoSyncTransport` and pinned `@tursodatabase/sync@0.7.2`. Its `connect()` URL callback returns `null` during initialization, schema creation, staging, queries, checkpointing, and stats, and returns the configured URL only during an explicit official `push()` or `pull()`. This is the installed offline-first equivalent of `bootstrapIfEmpty:false`. Cloud exchange does not use remote schema administration, database-client swapping, frame-replication APIs, or an invented `sync()` wrapper. Rejected network calls leave the same local database and unsent change-data-capture (CDC) operations usable. Capabilities truthfully advertise directional push/pull/checkpoint/stats for this adapter; the deterministic in-process hub remains `bidirectional-only`.

Only immutable, globally keyed `ReplicatedEnvelope` rows travel through the replica database. Turso Sync pushes logical CDC statements with last-push-wins conflict settlement, so physical envelope identity hashes the origin tuple plus event content; logical event ID and origin sequence are indexed claims, not transport primary keys, so colliding raw claims remain available for quarantine and reconciliation. Workspace `events.sequence`, snapshots, outbox leases, and other mutable projections never rely on libSQL's replicated last-write behavior. Envelopes carry device/origin sequence, exact event identity, source-branch parent, dependency IDs, and a stable SHA-256 digest. Ingestion validates schema/integrity, compares duplicate-event content digests, topologically orders causal parents, deterministically orders concurrent envelopes, and quarantines divergent/invalid/incomplete input before canonical append. Durable per-origin staging and terminal-ingest frontiers avoid rescanning settled history; a pending dependency stops frontier advancement and receipts/quarantine remain the correctness boundary. An immutable replica-incarnation marker detects a lost/replaced local sync file and clears only the staging frontier so canonical history is restaged.

If two devices advance one historical branch offline, the local execution stream stays on its original branch and the remote stream is mapped to a deterministic derived branch at the shared parent. Both histories remain inspectable. Duplicate intents and rejected mutations enter reconciliation records. Competing `TaskStatusChanged(...running)` claims produce an unresolved `task_claim`; no last-writer policy chooses an owner. `sessions.execution_owner_device_id` remains the creating device. Only that device materializes effect/goal/heartbeat/model requests as locally executable operational work; every non-owner retains the canonical events but has no outbox row, and model/cell execution there returns `CAPABILITY_UNAVAILABLE`. A request authored on another trusted device can therefore become a command for the owner after replication. This is an explicit trusted single-user cross-device effect channel, not an authenticated multi-tenant channel; replica writers must share the owner's trust boundary. An explicit `SyncConflictResolved` event records the user's action and synchronizes it. Distributed leases, task stealing, global budget reservation, and automatic owner failover remain unavailable.

Startup, reconnect, interval, and manual cycles stage local envelopes, optionally pre-pull an established revision, push, pull conflict-resolved state, ingest, and checkpoint. A new replica pushes first so first-launch CDC is never discarded. Directional calls and official CDC/WAL/revision/network statistics update `workspace_replica_status` only after the corresponding operation. Network failure leaves local execution available and records `error`; it never fabricates a successful push/pull. Cloud discovery reads replicated workspace announcements. Export/deletion manifests enumerate the workspace/profile/artifact/replica resources and mark remote deletion blocked because the installed data client has no ownership-admin deletion API.

## Canonical versus derived relational data

Canonical events are physically guarded against update and delete. Context records are immutable derived provenance and have the same physical guards. Mutable tables are limited to migration metadata, rebuildable routing/snapshot projections, and the operational outbox/lease projection. [The table registry](./mutable-tables.md) specifies every table and is checked against every migration.

The adapter is the only code allowed to issue canonical inserts. Application state changes call `appendEvents`; the checker rejects update/delete/replace patterns for immutable tables anywhere in `src`.

## Recursive sessions and projections

Root agents, delegated subagents, and isolated recursive model calls all use the same `SessionCreated` event and `AgentState`. Child creation stores `parentSessionId`, `parentBranchId`, `rootSessionId`, `depth`, and `taskId`; storage validates those fields against the parent and the task row in the same append transaction. The public composition root exposes `Supervisor.agents`, `.documents`, `.models`, `.goals`, `.heartbeats`, and `.schedules`. Their returned handles contain only JSON domain values and are returned only after the creating event batch commits.

A spawn batch validates and reserves the whole batch, then records every parent task, child session/initial prompt, and admission in one local transaction. Stable idempotency keys return the original handles—including their truthful current terminal status—without duplicating work. `maxChildrenPerSession` counts active direct children, not lifetime descendants. Child limits inherit from and cannot widen their parent; admission subtracts already-spent tree usage plus remaining active sibling reservations. Terminal child token/cost/turn/wall usage is attributed to every ancestor exactly once, with unknown usage consuming the unaccounted reservation conservatively. Mail sends, deliveries, acknowledgements, and task terminal notices are paired across normal session streams, restricted by `rootSessionId` and durable task ownership. Cancellation walks all admitted descendants leaf-first and startup completes any recorded crash prefix. Current routing/status rows accelerate list/get operations, but `rebuildOperationalProjections()` can delete and reconstruct all recursive-session projections in global cursor order without running work.

Recursive model execution builds on a task plus child session; there is no second provider engine. `models.start` atomically commits task, child, prompt/materialized input, and recursive handle; `idempotencyKey` gives retries a stable handle. `startMany` admits one all-or-nothing batch and preserves input order while terminal results remain independent. The console `rlm.start/startMany/get/result/cancel` RPCs call this same service. Handles are strict JSON identities and their worker-only convenience methods are non-enumerable, so a later cell or new worker resolves the same child rather than repeating admission. Bounded inline JSON and policy-checked artifact/document/event/memory/read-only-SQL references retain an exact input hash and provenance. Oversized results become registered CAS artifacts. Every model effect (root turn, recursive call, or model-backed gate) shares the configurable `providerConcurrency` limiter, defaulting to one per provider; succeeded, failed, cancelled, budget-exceeded, and unknown remain distinct result outcomes delivered through the ordinary task/terminal path. Cancelling while queued prevents provider entry, in-flight cancellation reaches the outbox abort signal, and uncertain non-idempotent recovery becomes `unknown` without retry. Depth and direct-child limits are explicit supervisor configuration (`maxSessionDepth`, `maxChildrenPerSession`) rather than hidden process state.

Documents are imported as metadata plus ordered, digested `DocumentChunkAdded` rows. An import idempotency key yields deterministic document/chunk identities. An input set freezes exact ordered chunk IDs and is authorized only inside one root family. Root context receives document/input-set metadata and SQL query hints rather than full content; a recursive child call receives the exact selected IDs and contents in its attributable context.

Goals own typed completion gates which execute through the existing request-before-effect outbox. Completion pins a workspace-relevant branch cursor, rejects stale or unknown evidence, and re-evaluates gates after continuation changes. Startup reconciles incomplete gates, re-checks each persisted workspace pin, and resumes active goals. Heartbeats project interval, next due time, monotonic ticks, and pause/cancel state; an aligned tick and wake message commit atomically. Startup fires due active schedules and a live database-polling scheduler continues firing future due rows until `Supervisor.close()`. No JavaScript timer or queue object is durable identity.

## Autonomous typed runs

`AgentRunService` is the ordinary product path. It commits the user task and stable request identity, freezes an attributable context and not-previously-delivered observation ledger for each step, executes the model through the outbox, strictly parses one `agencity.agent-action` version-1 object, and applies only the admitted typed action. The one executable action is a TypeScript cell; every file, shell, SQL, model/subagent, skill, memory, state, and artifact mechanism stays inside the console SDK. Clarification, permission, blocked, failed, cancelled, budget-exceeded, unknown, and final are supervisor run-control states rather than provider tools.

Run, step, context, call, effect, action, cell, and user-input IDs are stable across recovery. Committed cell/effect/input observations enter exactly one dependent step with their event IDs. A pending unclaimed model effect drains once; a retained succeeded outcome finalizes without a second provider call; a lost started non-idempotent effect becomes unknown. Started cells are abandoned rather than replayed. Budget admission uses the existing `>=` limits, and a generated final may be accepted at the exact turn boundary while a new effectful cell is not.

Provider action JSON is retained in model/action events for attribution but is not a conversation message. Agent-run recovery is excluded from the diagnostic text-turn finalizer, preventing raw action JSON from being published after a crash. Only a strict validated final appends the assistant message linked by the terminal run event.

## Artifact storage

A content-addressed store (CAS) identifies bytes by digest rather than by their physical path. `ArtifactReference` is `{ artifactId, digest, mediaType, size }`; local IDs are `sha256:<digest>`. Identity does not encode a local path. The contract supports:

| Shared operation | Local filesystem CAS | S3-compatible HTTP CAS | Semantics |
|---|---:|---:|---|
| put/deduplicate | yes | yes | Place by digest; identical bytes share one object even when media types differ. The remote adapter uses conditional create and verifies the resulting object. |
| resolve/verify | yes | yes | Validate ID/digest/size and fail visibly for missing or tampered content. |
| range read | yes | yes | Both adapters verify the complete object before slicing; neither implements an optimized partial-object integrity scheme. |
| export | yes | yes | Verify, create destination parents, and write the requested bytes. |
| delete | yes | yes | Physical deletion; higher layers must enforce scope/retention and accept broken references if misused. |
| automatic replication | no | no | Placement selects one store. The runtime does not copy artifacts between stores or maintain a replication manifest. |

Artifact registration is canonical; bytes are outside the database. A successful `put` during a later-failed cell may leave an unreferenced physical object. That is safe for projection but there is no garbage collector yet.

## Execution

`EffectExecutor` consumes a durable domain request and `AbortSignal`, then returns `succeeded`, `failed`, `cancelled`, or `unknown`. It may report bounded process-local progress through the execution context, but request and the single terminal outcome remain the only canonical effect lifecycle; the mutable outbox is operational. Progress listeners cannot affect execution, notifications are scrubbed, capped at 2,048 items/1 MiB per effect (32 KiB each), and nothing is replayed. Capability behavior is executor-specific and must not be weakened silently.

| Executor | Supported operations | Isolation/retry boundary |
|---|---|---|
| `FileExecutor` | `read`, atomic `write`, exact-one `replace`, file `delete` | Root/symlink checks; rejects directory delete. Write can detect already-desired bytes and use an expected digest. This confines the typed adapter, not arbitrary process code. |
| `ShellExecutor` | `run` with cwd and timeout | Initial cwd must be under root, output is capped/scrubbed, abort kills the child. It uses `/bin/sh -c`, not a login shell that could reload filtered credentials. The command retains ambient OS/network authority and is normally non-idempotent. |
| `ModelExecutor` | `complete` through registered provider; optional provider streaming | Providers explicitly advertise `capabilities.streaming`; absence means false, and declaring true without a streaming implementation is rejected. OpenAI-compatible calls use incremental SSE; the internal Echo test fixture is non-streaming and is unavailable through product selection. Calls are non-idempotent, so lost outcomes become unknown rather than a blind second generation. Live deltas are ephemeral; only the full returned response can enter the durable success batch. |

Cancellation is best effort: an abort signal can stop an in-process executor, but external systems may already have acted. A `cancelled` record is an observed executor result, not a universal rollback.

`RemoteSandboxExecutor` and its HTTP server adapter provide capability negotiation, typed outcomes, and transport-level cancellation for a server-owned executor. The server operator asserts the advertised filesystem, network, and host-isolation policy; the client does not attest or independently verify that isolation. This repository supplies the adapter and conformance coverage, not hosted sandbox infrastructure. Per-provider distributed concurrency, resource quota enforcement, and browser execution remain unavailable. Every executor placement must preserve IDs, request-before-effect ordering, four-way outcomes, cancellation disclosure, and idempotency semantics.

## Retrieval and context

`ContextMaterializer` deterministically selects the base policy, session/branch/status, recent messages, active working values and artifact references, budget events, completed/failed activity, scoped harness entries, and attributable retrieval provenance. It records every selected source event ID, event type, schema version, reason, and a hash of the exact JSON context in immutable `context_records`. The exact bytes remain in the canonical context event and immutable record, while `AgentState.contexts` projects provenance metadata rather than copying every historical full context into snapshots.

The document service imports ordered chunks and creates exact input sets; agent and recursive-model services delegate those references through normal child sessions. Relational memory and refinement are implemented through canonical harness events, rebuildable projections, and a disposable FTS5 candidate index. `HttpMemoryCandidateIndex` provides the same candidate-generation boundary over capability-negotiated HTTP. Local and HTTP candidate-index adapters return stable entry/version IDs and ranks only; authoritative scope, status, policy, conflict, and exposure filtering remains in the runtime and is recorded in context provenance.

The runtime does not provide embedding-based retrieval or a hosted semantic index. A replacement candidate source must preserve stable domain IDs and query/rule provenance; engine-specific objects must not escape the adapter.

## Reactive interface

`ProjectionService.getSnapshot` returns a projection and cursor. `subscribe`/`events` catch up from durable storage after that cursor and use adapter commit notification only as a wake-up. Reducers ignore duplicate event IDs, and cursor order is deterministic within this local database. HTTP SSE adapts this interface.

Historical projection (`atCursor`) and branch forks replay state transitions only. They never execute console code, tools, or model calls.

## Security placement

Process separation improves lifecycle control, not privilege isolation. The console, shell, file adapter, supervisor, and authenticated managed loopback service all operate inside the trusted-local boundary; bearer authentication is not a hostile-code sandbox or remote multi-tenant boundary. The advanced embedded diagnostic protocol remains unauthenticated. `sdk.harness.list/history` are model-facing policy views restricted to active local/workspace/user/global records plus an exact exposed candidate allocation; they never return another workspace or an unexposed candidate. Raw SQL is different: it is a shared, non-confidential diagnostic surface and may read non-private cross-workspace/candidate projections. Candidate exposure is behavioral isolation, not secrecy. Environment filtering, secret redaction, read-only SQL, path checks, and validation are defense-in-depth against accidents. See [Security](./security.md) for threat/non-threat claims.

## Public replacement rules

A replacement component may add capabilities but must preserve:

- stable identifiers and causal/event semantics;
- commit-before-publication and request-before-effect ordering;
- four-way effect outcomes and visible uncertainty;
- integrity/dependency failures for artifact references;
- deterministic shared projection behavior;
- domain-shaped contracts with adapter SDK types confined to the adapter;
- explicit `CAPABILITY_UNAVAILABLE` behavior instead of silent downgrade.

Local and remote relational, artifact, candidate-index, and executor placements have shared conformance coverage. Conformance establishes protocol and domain behavior; it does not provide hosted infrastructure, authenticate a deployment, or prove an advertised remote sandbox policy.


## Relational memory and refinement boundary

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

Artifact placement is fail-closed: session erasure reference-counts retained event payloads, while whole-workspace removal requires an operator assertion that the entire CAS root is exclusive. Relational sync is not an administrative control plane. Administrative planning enumerates all historical replica-status rows, watermarks/counters and profile-catalog evidence, preserves the compatibility replica path recorded by older workspace layouts, and never downgrades a previously managed workspace merely because the current process lacks sync configuration. Every distinct addressable URL requires the separate authenticated adapter; an unaddressable replica or unsupported remote granularity blocks. Stable scope/owner/URL idempotency makes authenticated retries safe. Outbox admission is quiesced and running/claiming effects refuse deletion before physical data can race an executor.

## Goal and wake orchestration

`AgentRunService` is the only autonomous model-to-TypeScript loop. Product run admission records explicit goal mode (`auto`, `current`, or `create`) and commits any created goal/gates in the same append batch as the run. Completion gates use an exhaustive event-classification policy to hash attributable workspace material, and immutable evaluation records cache terminal results by gate-definition hash plus material version.

`HeartbeatService` and `ScheduleService` define/tick recurring work and append the durable wake queue. `ScheduleService` owns a replaceable `WakeCoordinator` seam targeting `AgentRunService`. In product operation the per-workspace managed service starts wake pollers only after acquiring its workspace lease; canonical and outbox admission also checks the matching root-tree fence atomically. The same services remain available embedded for tests and diagnostics, but only the managed service claims detached continuation.


## Context-window admission and derived compaction

`ContextWindowController` is a pure admission policy shared by the diagnostic `ModelLoop` and `AgentRunService`. It estimates the exact provider candidate, uses provider/model capacity with typed source provenance, repeatedly asks `CompactionService` for the oldest eligible narrative prefix, and rebuilds before admitting a call. A provider overflow retry requires an adapter-supplied typed classification and a strictly smaller estimate; `AgentRunModelAttemptStarted` gives every retry a new context/call/effect identity.

`CompactionService` first commits `ContextCompactionRequested` with deep-frozen ordered source envelopes, cursors, and SHA-256 digest. Deterministic extractive output is available without a provider. `model-summary-v1` partitions source material and prior effective summary into deterministic hierarchical levels; each level is a stable, non-idempotent outbox model effect with normal usage and budget debit. Success is a typed `ContextMaterialized.derivation`; failure or unknown is `ContextCompactionFailed`. Recovery resumes from the request and terminal effect records without replaying unknown work.

Context selection includes at most one effective summary, omits the narrative leaves it covers, and includes uncovered messages plus exact live state. Competing/rematerialized strategies coexist as immutable derived contexts, while the latest valid prefix-covering derivation is effective on that branch. Canonical history is never pruned.

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
- `src/storage/contract.ts` uses only domain values. Only `src/storage/libsql.ts` may import the LibSQL/Turso SDK, and emitted package declarations must not expose those SDK types.
- Artifact and executor interfaces expose stable IDs, JSON requests, four-way outcomes, and explicit failures rather than filesystem/child-process types.
- Runtime services compose contracts and own valid writes. Generated console SQL is analytical/read-only; SDK RPC invokes typed commands.
- Protocol and UI adapt runtime operations. The current TUI is in-process rather than an HTTP client; this is a known Slice 1 limitation.

`bun run check:architecture` makes the first two boundaries, package barrels, migration classifications, immutable guards, and canonical SQL rules executable.

## Relational storage

### Domain contract

`AgentStorage` owns append/stream event operations, branch lookups, snapshots, outbox claims, analytical reads, migration, and post-commit wakeups. Its public values are `AgentEvent`, `AgentState`, `JsonValue`, `OutboxRecord`, and domain request types. It is not a generic cross-database query abstraction.

| Capability | `LibSqlStorage` in Slice 1 | Boundary meaning |
|---|---:|---|
| `offlineWrites` | yes | A local `file:` database can accept writes without a cloud service. |
| `analyticalSql` | yes | LibSQL-oriented, parameterized read-only SQL is available to console/runtime callers. |
| `notifications` | yes | In-process callbacks wake subscribers after this adapter commits. This is not distributed notification. |
| `distributedLeases` | no | Outbox claims are local DB transactions; there is no globally connected coordinator or ownership failover. |

The adapter retains a supervisor write/read client and creates a short-lived query-only analytical client per generated query so a deadline can close it without poisoning canonical writes. Local writes are serialized before SQLite transactions. Event append plus affected routing/context/outbox rows occurs in one local transaction. Before insertion, local commands are reduced against the transaction-visible branch state; nonexistent targets and invalid transitions are rejected atomically. A future sync adapter may quarantine invalid remote events rather than route them through this local command path. Event IDs are ULIDs and event cursors are zero-padded local sequence numbers. Cursors are ordering tokens, not portable timestamps.

Cloud sync, remote conflict behavior, two offline writers advancing a session, device identity, profile/workspace database split, export/delete enumeration, and PostgreSQL are not implemented. An upstream `syncUrl` configuration property is not a supported synchronization lifecycle.

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

Process separation improves lifecycle control, not privilege isolation. The console, shell, file adapter, supervisor, and unauthenticated protocol all operate inside the trusted-local boundary. Environment filtering, secret redaction, read-only SQL, path checks, and validation are defense-in-depth against accidents. See [Security](./security.md) for threat/non-threat claims.

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

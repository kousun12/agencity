# Delivery Slice 1 acceptance and verification

Status vocabulary:

- **verified**: implemented and covered by a named automated check;
- **partial**: important path exists, but acceptance wording or crash/surface coverage is incomplete;
- **implemented/unverified**: code exists without a focused automated acceptance test;
- **deferred**: intentionally belongs to a later PRD slice or is a known unsupported capability.

This document does not convert a partial result into success. The PRD is broader than Slice 1 and remains authoritative for later delivery.

## Slice 1 feature mapping

| Slice 1 deliverable | Status | Implementation/evidence |
|---|---|---|
| Bun supervisor and local event store | **verified** | `Supervisor`, `LibSqlStorage`; event append/idempotency/transaction tests in `test/unit/events.test.ts`. |
| Disposable TypeScript console | **verified** | `ConsoleProcess`/worker Bun IPC; `test/integration/console.test.ts` restarts after every cell, confirms a heap global disappears, and proves arbitrary/protocol-shaped bounded stdout cannot corrupt RPC or the next cell. |
| Tagged-template analytical SQL | **verified** | Bound interpolation, per-query query-only connection, row/time/statement bounds; security and console integration tests reject DML/private/SQLite schema tables and oversized results. |
| Typed JSON working memory, 128 KiB boundary | **verified** | Console integration round-trips exact threshold and moves threshold+1 to an artifact. |
| Content-addressed local artifacts | **verified** | `test/unit/artifacts.test.ts` covers deduplication, resolve/range/export integrity, forged IDs, deletion/missing content. |
| Model loop and attributable context | **verified** | `test/integration/model-loop.test.ts` checks diagnostic-turn context/event provenance, response linkage, budgets, failures, and recovery. `test/integration/agent-runs.test.ts` checks strict typed actions, internal-only raw action history, exact-once dependent observations, input pauses, cancellation, budget admission, gates, and recovery without duplicate provider calls. |
| Autonomous model-to-TypeScript run | **verified** | `AgentRunService` drives strict version-1 actions through disposable cells and distinct terminal states; `ManagedWorkspaceService` durably accepts and continues runs after detach. `test/e2e/coding-task.test.ts` covers autonomous coding, and `test/integration/managed-service.test.ts` covers authenticated election, detach/reattach, crash reconciliation, and scheduled wakes. |
| Durable shell/file tools and outbox | **verified** | Console real-RPC test plus outbox idempotency/recovery tests. File executor's full symlink/precondition matrix is not separately exhaustive. |
| Reactive event interface | **verified** | `test/integration/projection.test.ts` covers snapshot/catch-up races, duplicate notifications, disconnect/resume, stream abort, and session/branch isolation. `test/integration/protocol.test.ts` covers HTTP error/status mapping. `test/integration/model-streaming.test.ts` covers transport-level cursorless progress framing, client cursor ordering, and committed-only reconnect catch-up. |
| TUI | **implemented/unverified** | Basic chat/history/budget/snapshot/cell/fork interface compiles; no automated terminal test and not yet an HTTP protocol client. |
| CLI | **verified** | `test/integration/cli.test.ts` covers boolean/value parsing and executes documented create/cell/snapshot/history commands against one durable state directory. |
| Branch history | **verified** | Unit tests prove child lineage stops at the exact fork cursor and a nested fork at an inherited ancestor cursor clamps all intervening ancestors. |
| Budgets | **verified** | Token, cost, and turn boundaries stop subsequent model calls. Wall-time uses the same function but lacks a dedicated timing test. |
| Crash recovery | **partial** | Durable boundary simulations cover idempotent requeue, conservative non-idempotent unknown, competing claims, fork-scoped abandoned cells, authoritative terminal reread, model finalization, and stuck-running reconciliation. Tests do not SIGKILL processes at every instruction boundary. |
| Trusted-local mode | **verified/limited** | Security tests cover read-only SDK and secret filtering/scrubbing; documentation/health/context name the boundary. This is explicitly not hostile-code isolation. |

## PRD acceptance criteria mapping

| PRD acceptance criterion | Slice | Status and evidence/gap |
|---|---:|---|
| Representative coding task with worker restarted after every committed cell and identical state | 1 | **verified** — `test/e2e/coding-task.test.ts` drives the typed run loop to inspect, reproduce a failing gate, edit with a digest precondition, verify, and publish a validated final; it checks fresh worker PIDs, exact-once cell observations, projection rebuild/reopen equality, and no additional model call after restart. |
| No later value exists only in Bun heap | 1 | **partial/verified mechanism** — integration proves a heap global disappears while named values/artifacts survive; the API cannot prove callers never rely on an uncheckpointed value. |
| JSON through 128 KiB round-trips; larger immutable content deduplicates | 1 | **verified** — exact byte-boundary integration test and local CAS unit tests. |
| Canonical history append-only; every mutable table classified | 1 | **verified** — SQLite guard test, `docs/mutable-tables.md`, and architecture checker migration/registry/guard/canonical-SQL checks. |
| Kill during model/tool/subagent/refinement causes no missing/duplicate committed state | 1–3 | **partial** for model/tool through simulated durable crash states; **deferred** for subagents/refinement and literal process-kill matrix. |
| Input larger than context handled through chunk queries/delegation | 2/retrieval | **deferred/not implemented** — no document/chunk or recursive session capability. Artifact storage alone does not satisfy this. |
| Parent/child sessions detach/restart from durable task records | 2 | **verified locally** by resident root ownership, retained tasks/mailboxes, and crash recovery; cross-device failover remains unavailable. |
| Every model response traces to exact context/harness versions | 1/3 | **verified** for context event IDs/schema versions/exact bytes/hash; **deferred** for harness versions because harness does not exist. |
| Snapshot subscriber disconnect/resume misses no state; duplicates projection-neutral | 1 | **verified** — projection integration simulates duplicate at-least-once notifications, a snapshot/subscribe race, disconnect/resume, isolation, and async-stream abort; provider-streaming integration verifies SSE progress has no ID and reconnect catch-up contains only committed cursor events. |
| UI historical cursor then live without effects | 1 | **partial** — projection integration time-travels, rebuilds, returns live, and proves the executor remains at one call; the basic TUI has no historical/live toggle or UI test. |
| Local execution offline and sync after reconnect | 4 | **deferred** — offline local execution exists; Cloud sync does not. |
| Two local writers append without loss and conflicting task claims surface | 4/coordination | **deferred** — no supported multi-writer/session-claim coordinator. |
| Refinement candidate evaluation/promotion/rejection/rollback | 3 | **deferred**. |
| Generated TypeScript cannot directly mutate canonical tables/read brokered secrets; trusted-local plainly identified | 1 | **verified for intended SDK, limited by trust model** — SQL/private-table/secret tests and immutable DB triggers; arbitrary hostile code has ambient OS authority, so no sandbox claim is made. |
| Storage conformance suite contains no Turso SDK types outside adapter | 1/5 | **partial** — checker confines SDK imports and scans emitted declaration surfaces; only one backend exists and there is not yet a reusable multi-backend conformance suite. |
| Local/remote relational, artifact, retrieval, executor implementations pass shared contracts | later adapters | **deferred** — local relational/artifact/executor implementations only; retrieval adapter absent. |
| Same retained events/reducer versions produce same state after restart/rebuild | 1 | **verified** — deterministic double projection, corrupted snapshot discard, database reopen/rebuild unit test. |
| Uncertain external effect is unknown and not retried without proven idempotency | 1 | **verified** — outbox crash-recovery integration test records unknown once and makes zero executor calls. |

## Required automated gates

Run from repository root:

```sh
# TypeScript strictness across src, tests, and architecture script
bun run typecheck

# Package/barrel/layer/SDK-declaration/migration/canonical mutation policy
bun run check:architecture

# All current unit and integration tests
bun test

# Ordered aggregate gate
bun run verify
```

Focused evidence:

```sh
bun test test/unit/events.test.ts
bun test test/unit/artifacts.test.ts
bun test test/unit/security.test.ts
bun test test/integration/console.test.ts
bun test test/integration/outbox.test.ts
bun test test/integration/model-loop.test.ts
bun test test/integration/projection.test.ts
bun test test/integration/protocol.test.ts
bun test test/integration/cli.test.ts
bun test test/e2e/coding-task.test.ts
```

`bun run test:e2e` runs the representative forced-worker-restart coding task. It is deterministic and local; it is not a process-SIGKILL fault-injection suite.

## Architecture checker contract

The checker fails when:

- a LibSQL/Turso SDK package is imported anywhere except the named adapter;
- emitted public declarations mention a LibSQL/Turso SDK, catching public type leakage even from the adapter;
- a domain module imports an internal non-domain layer;
- required package subpath export/barrel, executable entrypoint, or verification script metadata is absent/misdirected;
- a migration table (including implicit `sqlite_sequence`) lacks exactly one valid classification/mutability row, or documentation lists a stale unknown table;
- canonical/immutable-derived tables lack both update and delete guards;
- application TypeScript updates/deletes/replaces an immutable table, or inserts it outside the storage adapter;
- migration numbering is duplicate/non-contiguous or no initial migration exists.

These are static architecture invariants, not substitutes for behavioral tests.

## Manual smoke checks

### CLI/restart state

```sh
rm -rf /tmp/agencity-smoke
bun run src/cli.ts create --state-dir /tmp/agencity-smoke --workspace smoke
# Copy the IDs, then use the same --state-dir on every command:
bun run src/cli.ts cell --state-dir /tmp/agencity-smoke \
  --restart-console-after-cell --session <S> --branch <B> \
  'await state.set("smoke", { ok: true }); return process.pid;'
bun run src/cli.ts cell --state-dir /tmp/agencity-smoke \
  --restart-console-after-cell --session <S> --branch <B> \
  'return { pid: process.pid, restored: await state.get("smoke") };'
bun run src/cli.ts rebuild --state-dir /tmp/agencity-smoke --session <S> --branch <B>
```

Expect different worker PIDs, restored JSON, and rebuild success.

### Protocol snapshot/catch-up

```sh
bun run src/cli.ts serve --state-dir /tmp/agencity-http --port 3131
# In another terminal:
curl -s http://127.0.0.1:3131/health
curl -s -X POST http://127.0.0.1:3131/sessions \
  -H 'content-type: application/json' -d '{"workspaceId":"smoke"}'
curl -N 'http://127.0.0.1:3131/sessions/<S>/stream?branch=<B>&after=0'
```

Create messages/cells in a third terminal and observe committed SSE IDs/cursors. Reconnect with the last applied cursor. This is a smoke procedure, not yet automated acceptance evidence.

## Exit criteria for remaining partial Slice 1 items

Before declaring Slice 1 fully accepted, add:

1. process-level crash injection around cell/effect/model commit boundaries;
2. HTTP/SSE transport-level reconnect and framing tests (core cursor subscription is covered);
3. a historical/live TUI behavior surface (the effect-free projection behavior is covered);
4. either a real storage conformance harness or revised acceptance language explicitly scoped to the sole local backend;
5. an explicit operator/API reconciliation path for unknown effects.

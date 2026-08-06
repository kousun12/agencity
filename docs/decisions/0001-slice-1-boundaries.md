# ADR 0001: Slice 1 local boundaries and explicit deferrals

- **Status:** accepted for Delivery Slice 1
- **Scope:** current implementation, not the complete PRD

## Context

The PRD ultimately supports local/remote placement, recursive sessions, relational retrieval, continual-harness refinement, synchronization, and stronger connected coordination. Slice 1 must first prove that one local agent can reconstruct committed state after its console disappears without pretending later capabilities already exist.

## Decisions and consequences

### Canonical events; mutable projections

All durable domain transitions append versioned events. Session/branch routing, snapshots, and outbox rows may mutate only under their documented rebuild/disposal rules. Context copies are derived but immutable because they are evidence of what a model received.

**Consequence:** debugging and restart projection are attributable and deterministic. Reads sometimes require reduction/joins, schema evolution cannot rewrite history, and user-owned deletion will need a deliberate cross-store operation rather than ordinary DML.

### Local LibSQL is the only supported relational placement

The domain storage contract exposes events, projections, outbox operations, analytical reads, and capabilities; SDK types stay inside `src/storage/libsql.ts` and out of emitted declarations.

**Consequence:** an adapter can later replace placement without changing domain events. Today there is no Turso Cloud push/pull/reconciliation, PostgreSQL, distributed lease, shared task owner, or storage conformance matrix. A `syncUrl` accepted by the upstream client configuration is not a product sync implementation.

### Disposable process, no heap recovery

The TypeScript console is a child process. Named JSON/artifact state crosses committed cells through dedicated Bun IPC and events; arbitrary JavaScript objects do not. Stdout/stderr are bounded logs, never RPC framing.

**Consequence:** crash reconstruction is honest and diagnostic restart-after-every-cell works. Closures, modules, sockets, iterators, child processes, class instances, and console globals disappear. Cells must return JSON and explicitly checkpoint later values.

### Durable outbox with four outcomes

Intent commits before shell/file/model execution. Every observed attempt ends as succeeded, failed, cancelled, or unknown. Automatic crash retry is limited to effects asserted idempotent.

**Consequence:** ambiguous external actions are not silently duplicated or called failures. Exactly-once external execution is not promised. Slice 1 surfaces unknown in event/state history but lacks a dedicated reconcile/approval UI/API.

### Local content-addressed artifacts

Large state and explicit artifacts use SHA-256 identity outside the database. Identity is independent of local path and all reads verify integrity.

**Consequence:** identical bytes deduplicate and database rows remain small. Database-only copies can be incomplete, physical deletion can break retained references, and failed cells can leave unreferenced CAS bytes. Remote objects, replication, reference-aware deletion, and garbage collection are deferred.

### Generated SQL is read-only; commands own writes

The console receives a parameterized tagged template backed by a short-lived query-only connection and narrow validator. Statement size, result rows, and query duration are bounded, and private/SQLite schema tables are excluded. Canonical writes remain typed supervisor/storage operations and are transition-validated before insert.

**Consequence:** the intended model API cannot casually rewrite history/private operational rows. Analytical SQL remains LibSQL-specific and the validator is not advertised as an adversarial SQL parser. Trusted code still has ambient OS authority and could bypass the SDK, which is why the deployment is trusted-local.

### Trusted local, externally sandboxable

Worker separation handles crashes, not hostile code. Environment filtering, redaction, root checks, validation, and query-only SQL are defense in depth.

**Consequence:** the implementation is usable locally and can run inside an external sandbox, but must not claim microVM isolation, network restrictions, authentication, tenant security, complete credential brokering, or resource containment.

### Deterministic explicit context selection before retrieval

Slice 1 context includes attributable recent messages/activity, active working values/artifacts, policy, session, and budget. Exact source IDs/versions and context bytes/hash are retained.

**Consequence:** a response can be traced to what it received. This is not yet document chunking, FTS candidate retrieval, semantic memory, embedding search, retrieval evaluation, or input-larger-than-context orchestration.

### Basic in-process TUI and HTTP/SSE adapter

The terminal interface directly calls the supervisor; HTTP exposes snapshot/history/commands/SSE. SSE catches up by durable cursor.

**Consequence:** core reactive semantics are demonstrated without a React dependency. The TUI is not yet itself an HTTP protocol client, model providers are complete-style rather than live token streaming, `AgentClient` lacks SSE/fork helpers, and the HTTP service is unauthenticated.

## Known unsupported capabilities

The following are explicitly unavailable; callers must not infer support from a TypeScript shape or future-looking PRD text:

- recursive child sessions, tasks, mailboxes, delegation, cancellation propagation, or tree budgets;
- autonomous goals, completion gates, heartbeats, scheduled operation, approvals;
- semantic/episodic/procedural/delegation memory stores, FTS/embedding retrieval, document chunks;
- prompt notes, skills, subagent specifications, refinement proposals/evaluation/promotion/rollback;
- Turso Cloud synchronization, offline conflict branches, device discovery, reconciliation UI;
- multi-owner sessions, distributed leases, global budget reservation/concurrency, automatic owner failover;
- PostgreSQL and shared cross-backend conformance suites;
- profile database, workspace/profile split, scoped export/deletion/replica enumeration;
- remote object storage, remote executor/sandbox, browser tools;
- hostile-code isolation, authn/authz/TLS, resource/network policy, complete secret broker;
- true provider token streaming; the current implementation records one output chunk after completion;
- full rich TUI commands/status surfaces from the PRD;
- event schema upcasting beyond version 1;
- snapshot content hashing/signing (explicit rebuild repairs a current-cursor cache);
- crash injection at every machine instruction (the representative forced-worker-restart coding benchmark is covered).

## Revisit conditions

Add a capability only with:

1. a domain-shaped contract and declared capability/unsupported behavior;
2. canonical events/provenance sufficient for recovery and audit;
3. table classification and migration updates;
4. adapter SDK confinement and public declaration checks;
5. shared contract/integration/crash tests appropriate to its guarantees;
6. operator/security documentation that does not overstate isolation or coordination.

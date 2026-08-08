# ADR 0001: Durable local runtime foundations

- **Status:** Accepted
- **Date:** 2026-08-05
- **Scope:** Canonical local state, disposable execution, effects, artifacts, mutation, and trust boundary
- **Extended by:** [ADR 0002](./0002-relational-memory-refinement.md), [ADR 0003](./0003-turso-envelope-sync.md), [ADR 0004](./0004-event-evolution-and-context-references.md), [ADR 0005](./0005-typed-autonomous-actions.md), [ADR 0006](./0006-durable-agent-relationships.md), [ADR 0007](./0007-managed-workspace-execution.md), [ADR 0008](./0008-profile-workspace-and-credentials.md), [ADR 0009](./0009-owned-data-deletion.md), and [ADR 0010](./0010-formal-model-tool-contracts.md)

## Context

Agent work can outlive a model call, console process, terminal client, or supervisor process. Recovery cannot depend on a live JavaScript heap, and external effects cannot be reconstructed safely from logs or model prose after a crash. The runtime also needs a model-facing programming surface without granting generated SQL unrestricted mutation authority or representing process separation as a security sandbox.

These requirements establish the durable local boundary on which later synchronization, multi-agent work, autonomous runs, managed execution, and governed adaptation depend.

## Decision

### Canonical events and rebuildable projections

Durable domain transitions append validated events to a local LibSQL workspace database. The event stream is canonical. Reducers deterministically build state; snapshots, indexes, routing rows, and other classified projections may be rebuilt or discarded according to their documented rules. Immutable context records preserve evidence of what a model received.

Event and projection writes that represent one transition commit in one local transaction. Normal operation does not update or delete retained canonical events. Physical owned-data deletion is a separate guarded administrative operation described by [ADR 0009](./0009-owned-data-deletion.md).

### Disposable Bun TypeScript console

The generated-code surface is a Bun TypeScript console running in a child process. A committed cell is a recovery boundary. Values needed later must cross that boundary as typed JSON working values or immutable artifact references. Arbitrary closures, modules, sockets, iterators, subprocesses, class instances, and console globals are not durable state.

Console RPC uses a dedicated IPC channel. Bounded stdout and stderr are observations only and never carry protocol framing.

### Durable outbox and explicit outcomes

Model, shell, file, skill, and other external effect intent commits before execution. Each observed attempt reaches one of four outcomes: `succeeded`, `failed`, `cancelled`, or `unknown`. Recovery may requeue only work whose executor contract and request declare it safe to repeat. A lost non-idempotent attempt becomes `unknown` and is not retried automatically.

### Content-addressed artifacts

Large or byte-oriented durable values use immutable content-addressed storage. Artifact identity is a SHA-256 digest independent of a local path. Resolution and export verify identity, size, and content. Database state retains artifact references and provenance; database bytes alone are not necessarily a complete backup.

### Typed writes and analytical read-only SQL

Canonical mutation goes through typed supervisor and storage commands that validate transitions before append. Generated SQL is a parameterized, bounded, single-statement analytical surface over a short-lived query-only connection. It excludes private operational and SQLite schema tables.

The SQL restrictions protect the intended model API from accidental mutation. They are not a hostile-input SQL security boundary against arbitrary code with operating-system access.

### Trusted-local authority

The console worker is a crash and protocol boundary, not a security sandbox. Generated TypeScript and shell commands retain the operating-system authority of the Agencity process. Environment filtering, credential-value rejection and redaction, path checks, typed commands, and query-only SQL are defense in depth.

Deployments that require filesystem, network, process, resource, or tenant isolation must place the entire runtime inside an independently administered sandbox or policy boundary.

## Consequences

- A worker, supervisor, or terminal can disappear without taking committed session identity or work with it.
- Projection rebuild and historical inspection do not repeat external effects.
- Reads may require reduction, joins, artifact resolution, or explicit context materialization.
- External exactly-once execution is not promised; uncertainty remains visible as `unknown`.
- Identical artifact bytes deduplicate, but backup, replication, and deletion must account for referenced bytes outside the database.
- Generated programs use one general TypeScript surface while canonical writes remain validated and attributable.
- Trusted-local operation is usable without claiming hostile-code isolation.

Later ADRs preserve these foundations while adding relational memory and refinement, immutable envelope synchronization, proposed event-version evolution, typed autonomous actions, durable agent relationships, managed detached execution, profile and credential separation, guarded physical deletion, and formal provider-tool response contracts. ADR 0010 supersedes ADR 0005's textual action transport while preserving this ADR's durable outbox, attributable state, and single generated TypeScript execution surface.

## Rejected alternatives and limitations

1. **Keep durable identity in a long-lived language process.** Rejected because process loss would lose or ambiguously repeat work.
2. **Replay logs or cells to reconstruct state.** Rejected because replay could repeat external effects and cannot recreate arbitrary heap objects safely.
3. **Execute effects before recording intent.** Rejected because a crash would leave no authoritative request or recovery state.
4. **Treat all interrupted work as failed or retry it blindly.** Rejected because non-idempotent work may already have happened externally.
5. **Store all artifact bytes in relational rows.** Rejected because large immutable content has different integrity and lifecycle needs; complete recovery instead requires the database and referenced artifact store.
6. **Allow generated SQL to mutate canonical tables.** Rejected because it bypasses domain validation, attribution, and append-only history.
7. **Describe child-process separation as sandboxing.** Rejected because generated code retains ambient Bun and operating-system capabilities.

The current local artifact adapter does not provide automatic object replication or garbage collection. The runtime does not provide hostile-code isolation or exactly-once execution of arbitrary external effects.

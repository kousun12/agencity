# TypeScript API

All public contracts use domain values. No `@libsql/client`/Turso SDK value appears in a public method signature. Package subpaths exist so callers can depend on a boundary instead of the composition root.

| Import | Main surface |
|---|---|
| `@prime-agent/runtime` | Complete composition/public surface. |
| `@prime-agent/runtime/domain` | Events, payloads, reducer/state, JSON constraints, stable errors. |
| `@prime-agent/runtime/storage` | `AgentStorage`, capability types, `LibSqlStorage`. |
| `@prime-agent/runtime/artifacts` | `ArtifactStore`, `LocalArtifactStore`. |
| `@prime-agent/runtime/executors` | Effect contract and file, shell, model implementations. |
| `@prime-agent/runtime/console` | Generated-console SDK types and worker process host. |
| `@prime-agent/runtime/runtime` | `Supervisor`, outbox/model/context/projection services. |
| `@prime-agent/runtime/protocol` | HTTP server/client and wire-envelope types. |
| `@prime-agent/runtime/security` | Secret scrubbing/filtering helpers. |
| `@prime-agent/runtime/tui` | Basic terminal client. |

## Supervisor lifecycle

```ts
import { Supervisor } from "@prime-agent/runtime/runtime";

await usingRuntime();

async function usingRuntime() {
  const supervisor = await Supervisor.open({
    databaseUrl: "file:.agencity/agent.db",
    artifactDirectory: ".agencity/artifacts",
    workspaceRoot: process.cwd(),
    restartConsoleAfterCell: true,
    recover: true,
    // modelProviders: [customProvider],
  });
  try {
    const { sessionId, branchId } = await supervisor.createSession({
      workspaceId: "example",
      model: { provider: "echo", model: "echo-1" },
      budget: { tokenLimit: 10_000, turnLimit: 20 },
    });
    await supervisor.appendMessage(sessionId, branchId, "user", "Hello");
    console.log(await supervisor.modelLoop.turn(sessionId, branchId));
  } finally {
    await supervisor.close();
  }
}
```

`Supervisor.open` migrates storage, creates the artifact directory, installs file/shell/model executors, and normally recovers incomplete work. `close` stops the console worker and closes LibSQL clients. A supervisor process is the sole supported execution owner for a session in Slice 1.

## Core operations

- `createSession`: commits `SessionCreated`; optional caller IDs make higher-level provisioning deterministic.
- `appendMessage`: scrubs content and appends a new message event.
- `fork`: validates the parent lineage cursor, then appends `BranchCreated` on a new branch.
- `executeCell`: serializes cells per branch, stages state/artifact references, and atomically commits them with `CellCommitted` after successful execution.
- `modelLoop.turn`: materializes attributable context, requests a model effect, records response/usage, and updates status.
- `modelLoop.run`: performs a caller-bounded number of turns; it is not the autonomous-goal/completion-gate loop planned for later slices.

## Storage contract

`AgentStorage` exposes domain operations rather than a generic LibSQL client:

```ts
interface AgentStorage {
  readonly name: string;
  readonly capabilities: StorageCapabilities;
  migrate(): Promise<void>;
  appendEvents(events: readonly NewAgentEvent[]): Promise<AgentEvent[]>;
  loadEvents(sessionId: string, query?: EventQuery): Promise<AgentEvent[]>;
  // projections, outbox claims, analytical reads, and commit notification
}
```

`readonlyQuery` accepts `{ sql, args }` and returns JSON rows. It is intentionally LibSQL-oriented analytical SQL, not a portable storage interface. Reads are bounded to 64 KiB of SQL, 1,000 result rows, and 2 seconds, and SQLite/private operational schemas are unavailable. Typed domain commands own canonical writes. Local `appendEvents` validates target session/branch existence and reduces each new event against transaction-visible state before insert; a missing target raises `NOT_FOUND` and an invalid lifecycle raises `INVALID_TRANSITION` without committing any part of the batch. The local implementation advertises offline writes, analytical SQL, and in-process notifications; it explicitly does not advertise distributed leases.

Although `LibSqlStorageOptions` reflects upstream client configuration fields including `syncUrl`, Slice 1 does not implement a Cloud sync lifecycle, conflict reconciliation, device ownership, or call a supported explicit synchronization operation. Treat local `file:` storage as the supported topology.

## Artifacts

`ArtifactStore` separates content identity from placement:

```ts
const reference = await store.put(bytes, { mediaType: "text/plain" });
await store.verify(reference);
await store.resolve(reference);
await store.readRange(reference, 0, 1024);
await store.export(reference, destination);
await store.delete(reference);
```

`LocalArtifactStore` uses `sha256:<hex>` IDs and verifies ID, digest, and size on reads/exports. `delete` is physical and can invalidate retained references; callers must apply ownership/retention policy above this contract. There is no remote/replicated store in Slice 1.

## Executors and outbox

An `EffectExecutor` receives only a domain-shaped `EffectExecutionRequest` plus an `AbortSignal`, and returns exactly one visible outcome: `succeeded`, `failed`, `cancelled`, or `unknown`. The `OutboxRunner` commits intent before calling it and commits the observed outcome afterward.

Executor authors must state whether each logical request is safe to retry. The caller-provided `idempotent` flag is a semantic assertion, not something the runtime can prove generically. Never mark an external operation idempotent merely because the executor API accepts an idempotency key.

## Projection/event subscription

```ts
const { cursor, state } = await supervisor.projections.getSnapshot(sessionId, branchId);
const unsubscribe = supervisor.projections.subscribe(
  sessionId,
  branchId,
  cursor,
  (event) => consume(event),
);
```

The callback receives durable events strictly after the supplied cursor. It is a notification surface, not a second source of truth. Reconnect/catch up from storage and deduplicate by event ID. `events(...)` exposes the same mechanism as an async generator with optional cancellation.

## Stable errors

`AgentRuntimeError` subclasses expose stable codes: `VALIDATION_ERROR`, `CONFLICT`, `NOT_FOUND`, `CAPABILITY_UNAVAILABLE`, `INVALID_TRANSITION`, and `DEPENDENCY_FAILURE`. Consumers should branch on `code`, never message text. HTTP maps `NOT_FOUND` to 404, conflicts/transitions to 409, validation to 400, dependency failure to 424, unavailable capability to 501, and unknown failures to 500/`INTERNAL`.

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
    providerConcurrency: { openai: 2, echo: 4 },
    heartbeatPollIntervalMs: 100,
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

`Supervisor.open` migrates storage, creates the artifact directory, installs file/shell/model executors, normally recovers incomplete work, and starts the database-driven heartbeat scheduler. `providerConcurrency` is either one positive default or a provider-to-limit map. `close` stops heartbeat polling, drains local recursive runners, stops the console worker, and closes LibSQL clients. A supervisor process is the sole supported execution owner for a session in Slice 1.

## Core operations

- `createSession`: commits `SessionCreated`; optional caller IDs make higher-level provisioning deterministic.
- `appendMessage`: scrubs content and appends a new message event.
- `fork`: validates the parent lineage cursor, then appends `BranchCreated` on a new branch.
- `executeCell`: serializes cells per branch, stages state/artifact references, and atomically commits them with `CellCommitted` after successful execution.
- `modelLoop.turn`: materializes attributable context, requests a model effect, records response/usage, and updates status.
- `modelLoop.run`: performs a caller-bounded number of turns. `goals.runContinuation` and startup goal recovery compose it into the durable Slice 2 autonomous loop.

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

## Slice 2 recursive services

`Supervisor.open` also exposes five typed domain services. Every creation method resolves only after its canonical event batch commits, and every returned handle is JSON-serializable (no promise/controller/provider/LibSQL object is durable identity).

```ts
const child = await supervisor.agents.spawn(parentSessionId, parentBranchId, {
  task: "Investigate the failing tests",
  completionCriteria: "Return root cause and a verified patch",
});
const children = await supervisor.agents.spawnMany(parentSessionId, parentBranchId, [
  { task: "Inspect logs" }, { task: "Find the regression" },
]);
const mail = await supervisor.agents.sendMessage(parentSessionId, parentBranchId, {
  toSessionId: child.sessionId, content: "Prioritize the first failure",
});
await supervisor.agents.acknowledgeMessage(child.sessionId, child.branchId, mail.mailboxMessageId);
await supervisor.agents.completeTask(child.sessionId, child.branchId, { result: { summary: "..." } });
// failTask, cancel, listTasks, and listChildren use the same durable task IDs.

const document = await supervisor.documents.import(parentSessionId, parentBranchId, {
  name: "build.log", content: veryLargeText, chunkBytes: 32 * 1024,
});
const chunks = await supervisor.documents.readChunks(document.documentId, { start: 0, limit: 20 });
const inputSet = await supervisor.documents.createInputSet(parentSessionId, parentBranchId, {
  chunkIds: chunks.map((chunk) => chunk.chunkId),
});

const call = await supervisor.models.start(parentSessionId, parentBranchId, {
  prompt: "Summarize the selected log ranges", inputSetId: inputSet.inputSetId,
  idempotencyKey: "summarize-build-log-v1",
});
await supervisor.models.get(call.handleId);
await supervisor.models.cancel(call.handleId);
// startMany admits many durable children before their asynchronous results arrive.

const goal = await supervisor.goals.create(parentSessionId, parentBranchId, {
  description: "Ship a passing patch",
  gates: [{ name: "tests", executor: "shell", operation: "run",
    input: { command: "bun test" }, required: true }],
});
await supervisor.goals.runContinuation(parentSessionId, parentBranchId, goal.goalId, { maxTurns: 3 });
await supervisor.goals.requestCompletion(parentSessionId, parentBranchId, goal.goalId);

const heartbeat = await supervisor.heartbeats.create(parentSessionId, parentBranchId, {
  intervalMs: 60_000, goalId: goal.goalId,
});
await supervisor.heartbeats.tick(heartbeat.heartbeatId);
await supervisor.heartbeats.pause(heartbeat.heartbeatId);
await supervisor.heartbeats.cancel(heartbeat.heartbeatId);
```

`AgentStorage` retains the original mandatory Slice 1 contract and advertises the Slice 2 query/rebuild methods as optional for compatibility with existing third-party adapters. `requireRecursiveStorage` fails composition explicitly when one of these operations is unavailable. `LibSqlStorage` implements all of them, including `getSession`, child/task/mailbox/document/input-set/goal/heartbeat/model lookups and `rebuildOperationalProjections`.

### Slice 2 command and recovery semantics

- `agents.spawnMany` validates the entire request, reserves the complete active-child and sibling-budget envelope, and commits all task/session/prompt/admission events in one transaction. `idempotencyKey` gives a request a stable task/session identity; an exact retry returns the original handle with its durable current status and changed intent conflicts. Completed children release their child-count and unused-budget reservations. Actual terminal usage is attributed to each ancestor exactly once; unknown usage consumes the remaining reservation conservatively. A child inherits remaining parent limits and cannot widen its provider/model/output or budget envelope.
- Mail delivery is restricted to sessions with the same `rootSessionId`; an optional `taskId` must resolve inside that family. Cancelling a task walks and terminates its admitted descendant tree leaf-first. Startup resumes recorded cancellation prefixes, and later retries cannot replace the first recorded reason.
- `documents.import(..., { idempotencyKey })` derives stable document and chunk IDs. `createInputSet` accepts only chunks owned by the caller's root family and preserves caller order. Root contexts contain document metadata, while an isolated recursive child gets the exact authorized chunk IDs and contents for its selected input set.
- Recursive start atomically admits the task/child/prompt/input/handle; `idempotencyKey` makes retry return the stable handle, and `startMany` is all-or-nothing. A shared configurable limiter covers all model effects with a default per-provider concurrency of one. Cancelling a queued call prevents provider admission; cancelling an in-flight call aborts its effect. Lost non-idempotent calls recover as `unknown` and terminate their durable handles without provider replay.
- Completion requests persist the workspace ID and branch's current workspace-relevant cursor. A concurrent workspace change makes gate output stale and blocks completion. Required `failed`, `cancelled`, `unknown`, or stale gates block; continuation plus a new completion request re-evaluates all gates against the new version. Startup reconciles incomplete gates and resumes active goals.
- A heartbeat rejects an early tick, coalesces all missed intervals into one aligned advancement, and atomically appends `HeartbeatTicked` plus its wake-up `MessageAppended`. Startup and the live database poller fire due active schedules; paused and cancelled rows are excluded, and `close()` stops polling.

`Supervisor.close()` waits for locally queued recursive runners before closing storage. With recovery enabled, startup reconciles outbox/model outcomes, due heartbeats, completion gates and autonomous goals, then resumes pending recursive handles. Operational rebuild and historical projection never execute those effects.

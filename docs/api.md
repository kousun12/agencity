# TypeScript API

All public contracts use domain values. No `@libsql/client`/`@tursodatabase/sync` SDK value appears in a public method signature. Package subpaths exist so callers can depend on a boundary instead of the composition root.

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
| `@prime-agent/runtime/sync` | Profile DB, envelope protocol, sync lifecycle/capabilities, official directional Turso Sync adapter, and deterministic test hub. |

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
    userScopeKey: "profile-user-id",
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

`ModelProvider.complete` remains the required non-streaming contract. A provider may additionally expose `capabilities: { streaming: true }` and `stream(context, configuration, signal, onDelta)`. Missing capability metadata is false; a true declaration without `stream` is rejected. `stream` returns the same full `ModelResponse` used for the terminal outcome while `onDelta` is only provisional display data. `ModelExecutor.providers()` and `Supervisor.modelProviders` return secret-free names, labels, and capabilities. `OutboxRunner.onProgress` observes scrubbed, bounded, process-local `EffectProgressNotification` values; it is not a durable subscription and never replaces projection/history reads.

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

`LibSqlStorage` remains the local workspace adapter. Optional Cloud lifecycle is composed through `SyncService` and `TursoSyncTransport`; passing an upstream `syncUrl` to storage alone is not a lifecycle. The pinned `@tursodatabase/sync@0.7.2` adapter uses its official directional primitives and keeps all SDK values confined to `src/storage/turso.ts`.

## Profile and Turso synchronization

```ts
const supervisor = await Supervisor.open({
  databaseUrl: "file:.agencity/workspace.db",
  profileDatabaseUrl: "file:.agencity/profile.db",
  artifactDirectory: ".agencity/artifacts",
  sync: {
    workspaceId: "example",
    syncUrl: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN, // memory only
    credentialReference: "credential:turso-example", // must exist in profile DB
    replicaUrl: "file:.agencity/sync-replica.db",
    intervalMs: 30_000,
  },
});

await supervisor.sync.sync("manual");       // stage + push + pull + ingest + checkpoint
await supervisor.sync.push();                // stage + official directional push
await supervisor.sync.pull();                // official pull + local ingestion
await supervisor.sync.checkpoint();          // official local WAL checkpoint
await supervisor.sync.stats();               // official CDC/WAL/revision/network stats
await supervisor.sync.reconnect();           // reconnect lifecycle + cycle
await supervisor.sync.stage();                // local envelope preparation only
await supervisor.sync.ingest();               // local replica ingestion only
await supervisor.sync.status();
await supervisor.sync.conflicts("unresolved");
await supervisor.sync.resolveConflict(id, {
  action: "choose-claim", chosenEventId, resolvedBy: "owner",
});
```

The official adapter advertises directional push/pull plus checkpoint/statistics because those methods exist in the pinned SDK. The in-process deterministic hub stays `bidirectional-only`, so those calls still fail honestly against that test transport. A missing `sync` option yields a fully functional local-only runtime. Initialization uses a URL callback that returns `null` until a network call; a failed push or pull leaves staged CDC and local reads/writes usable.

`ProfileStore` provides stable device identity, JSON preferences/cross-workspace defaults, immutable global-skill versions with a current pointer, opaque credential references, and workspace catalog entries. It rejects credential-shaped metadata. Model context may see preferences, installed skill definitions, and opaque provider references, never authentication values.

`exportBundle(destination, scopeKind, scopeId, requestedBy)` writes an inspectable `events.jsonl`, redaction-safe `profile.json`, replica-envelope JSONL, verified referenced artifact bytes, and final manifest (`partial` if artifact content is missing). `createManifest("export"|"delete", scopeKind, scopeId, requestedBy)` verifies profile/workspace/session ownership and lists workspace DB, profile DB, artifact directory, indexes, every historical workspace replica status, its watermarks/counters, catalog sync/replica/credential-reference evidence, and every known local replica file. `SyncStorageOperations.listReplicaStatuses(workspaceId)` exposes that durable enumeration to administrative composition. Cloud evidence remains authoritative after an unconfigured reopen; deletion is `blocked` without authenticated administration or when any managed replica is unaddressable.

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
const terminal = await supervisor.models.result(call.handleId, { timeoutMs: 30_000 });
await supervisor.models.cancel(call.handleId);
// startMany admits many durable children before their asynchronous results arrive.
// Results retain stable input order and independently report succeeded, failed,
// cancelled, budget-exceeded, or unknown.

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
- Recursive start atomically admits the task/child/prompt/input/handle; `idempotencyKey` makes retry return the stable handle, and `startMany` is all-or-nothing at admission while each admitted item keeps its own terminal outcome. Inline input is capped at 256 KiB after materialization. Typed artifact ranges, document ranges, family events, active policy-visible memories, and bounded read-only SQL rows are resolved before admission and their exact identities/hash are retained. A shared configurable limiter covers all model effects with a default per-provider concurrency of one. Cancelling a queued call prevents provider admission; cancelling an in-flight call aborts its effect. Lost non-idempotent calls recover as `unknown` and terminate their durable handles without provider replay. Results above 64 KiB spill to the content-addressed artifact store; `models.result` returns the bounded descriptor and attributable context/model-call/provider-attempt/harness/usage provenance.
- Completion requests persist the workspace ID and branch's current workspace-relevant cursor. A concurrent workspace change makes gate output stale and blocks completion. Required `failed`, `cancelled`, `unknown`, or stale gates block; continuation plus a new completion request re-evaluates all gates against the new version. Startup reconciles incomplete gates and resumes active goals.
- A heartbeat rejects an early tick, coalesces all missed intervals into one aligned advancement, and atomically appends `HeartbeatTicked` plus its wake-up `MessageAppended`. Startup and the live database poller fire due active schedules; paused and cancelled rows are excluded, and `close()` stops polling.

`Supervisor.close()` waits for locally queued recursive runners before closing storage. With recovery enabled, startup reconciles outbox/model outcomes, due heartbeats, completion gates and autonomous goals, then resumes pending recursive handles. Operational rebuild and historical projection never execute those effects.


## Delivery Slice 3: relational memory and continual harness

The composition root exposes four new services. Every mutation appends validated canonical events; callers never write projection tables.

```ts
const source = await supervisor.appendMessage(sessionId, branchId, "user", "Use canary releases");
const memory = await supervisor.memory.create(sessionId, branchId, {
  name: "release-policy",
  text: "Use a canary before production rollout",
  memoryKind: "constraint",
  scope: "workspace",
  tags: ["release"],
  confidence: 0.9,
  evidenceEventIds: [source.id],
});
const result = await supervisor.memory.search(sessionId, branchId, "production rollout", {
  scopes: ["local", "workspace", "user", "global"],
  statuses: ["active"],
  tags: ["release"],
  limit: 20,
});
```

`MemorySearchResult` contains ranked records and `provenance`: normalized query, index name, filters, every candidate/source, every authoritative rejection, and every selection/reason. `memory.list` uses the same deterministic policy. `Fts5MemoryCandidateIndex.rebuild()` deletes and reconstructs the disposable candidate index without changing entry/version identity.

Refinement is intentionally staged:

```ts
let proposal = await supervisor.harness.propose(sessionId, branchId, {
  trigger: "Repeated release gate failure",
  predictedEffect: "Use the verified release ordering",
  evidenceEventIds: [source.id],
  evaluation: { kind: "objective", name: "release gate", metric: "pass", target: true },
  edits: [{
    operation: "create",
    kind: "prompt_note",
    scope: "workspace",
    name: "release-order",
    content: { kind: "prompt_note", text: "Run canary and then the release gate." },
  }],
});
proposal = await supervisor.harness.validate(sessionId, branchId, proposal.proposalId);
proposal = await supervisor.harness.activate(sessionId, branchId, proposal.proposalId, {
  allocationLimit: 3,
  exposureLimit: 3,
});
const allocation = await supervisor.harness.allocate(sessionId, branchId, proposal.proposalId);
// Context materialization durably records the actual exposure.
await supervisor.contexts.materialize(sessionId, branchId);
await supervisor.harness.recordObservation(sessionId, branchId, proposal.proposalId, {
  allocationId: allocation.allocationId,
  evaluator: "release-gate-v1",
  objective: true,
  success: true,
  metric: { pass: true },
  // gateOutcome is a successful EffectOutcomeRecorded event from this exact
  // allocation session/branch (and matches evaluation.testCommand, if set).
  evidenceEventIds: [gateOutcome.id],
});
await supervisor.harness.decide(sessionId, branchId, proposal.proposalId);
await supervisor.harness.rollback(sessionId, branchId, proposal.proposalId, "Later regression");
```

Edits are discriminated `create`, `replace`, or `retire` values. Replacement/retirement requires `expectedVersionId`; validation records the observed version and activation repeats both CAS and scope authority. Duplicate activation names fail with a typed `CONFLICT`/`VALIDATION_ERROR` and the event batch rolls back atomically. Allocations beyond `exposureLimit` are valid controls: context materialization skips them without error and does not expose candidate content or provenance. Objective evidence must be committed after the allocation's durable exposure, come from the exact allocation session/branch/task, and report the predeclared metric (plus the exact `testCommand` when supplied). A `revise` decision rejects old candidate versions and frees create names.

`harness.approve(..., "user" | "global", approvedBy)` supplies explicit promotion authority. Automatic promotion requires one supported local success, repeated objective workspace successes in distinct allocations, and explicit approval at user/global scope. Rolling back user/global content additionally requires the separate `harness.approveRollback(..., { approvedBy, role: "owner" | "admin" })`; promotion approval never authorizes rollback. Other methods are `harness.list`, `history`, `proposals`, `allocate`, `expose`, `recordObservation`, `decide` (`promote | revise | reject`), and `rollback`.

Generated skills and reusable delegation use exact immutable versions:

```ts
const tested = await supervisor.skills.test(sessionId, branchId, skillEntryId, skillVersionId);
const invoked = await supervisor.skills.invoke(sessionId, branchId, skillEntryId, input, {
  versionId: skillVersionId,
  idempotencyKey: "release-skill:run-17",
});
const child = await supervisor.specs.spawn(sessionId, branchId, specEntryId, {
  versionId: specVersionId,
  task: "Review release 17",
  idempotencyKey: "release-review:17",
});
```

A skill must export a default function or named `run` function. `Supervisor.open({ skillPermissionAllowlist: [...] })` configures exact allowed permission names (none by default); validation, activation/testing, and invocation enforce it, including after reopen/configuration changes. Activation requires at least one declared runtime test; compile and runtime test requests use executor `skill` in the durable outbox. Both `EffectRequested` and `Skill*Recorded` pin `entryId`/`versionId`. A spec spawn is normal atomic child admission extended by `SubagentSpecInvoked`, and `subagent_spec_invocations.task_id` makes the pin queryable after restart/rebuild.

The console SDK exposes policy-bounded `sdk.memory`, `sdk.harness`, `sdk.skills`, `sdk.specs`, and `sdk.rlm` RPC facades. `rlm` is also a cell global. `rlm.start`, `startMany`, `get`, `result`, and `cancel` route to `Supervisor.models`; returned handles contain durable IDs plus non-enumerable convenience methods, so saving/returning a handle serializes only JSON identity and a later fresh worker can call `rlm.get(handleId)`. A child inherits the parent model unless the existing parent policy authorizes a narrower override; generated TypeScript cannot select another provider/model.

The console SDK exposes policy-bounded `sdk.memory`, `sdk.harness`, `sdk.skills`, and `sdk.specs` RPC facades. `sdk.harness.list/history` return only active entries authorized for the calling local/workspace/user/global scope plus candidate versions from that branch's exact exposed allocation; unexposed or cross-workspace candidate content is never returned by these views. Agent-created memory is local-only and requires source-trajectory evidence; broader changes use `sdk.harness.propose`. Validation, activation/allocation, observations, decisions, approval, and rollback are deliberately evaluator/user-owned and absent from the model/console facade. The `sql` template is intentionally different: it is trusted-local, shared, read-only diagnostics and can inspect non-private cross-workspace/candidate projections. Scope/exposure is behavioral isolation, not SQL confidentiality. The HTTP `AgentClient` exposes `memoryCreate/Search/List`, `refine`, lifecycle methods, separate rollback approval, `rollback`, `invokeSkill/testSkill`, and `spawnSpec`.


## Physical data control

`Supervisor.deleteOwnedData(input)` stops worker admission, refuses while an outbox effect is running or being claimed, and terminates that supervisor after a destructive attempt. `input` selects `workspace`, `session`, or `profile`, names the owned ID and requester, and must include the exact `DELETE <scopeKind> <scopeId>` confirmation. Workspace/profile calls also require an external receipt directory. The `PhysicalDeletionReceipt` enumerates only paths proved absent after that attempt, rows, protected shared artifacts, and one receipt per distinct managed sync URL. A partial filesystem failure leaves workspace ownership live and can be retried; the catalog is tombstoned and scrubbed only after remote, replica, CAS, and workspace-database removal all succeed.

`ManagedReplicaDeletionAdmin` is intentionally separate from `SyncTransport`: it must advertise `authenticatedAdministration: true` and `deleteWorkspaceReplica`, then return a provider receipt. Every durable managed URL is called, and any URL-less managed identity blocks the operation. Session/profile remote granularity is unavailable. `assertIndependentSessionErasable` performs a non-mutating reference preflight before CAS removal; `eraseIndependentSession` repeats it and transactionally removes relational rows, including selected-session quarantine rows. Neither local administrative operation is exposed to generated-code SDKs or relational RPC.

The same operation is available as `AgentClient.deleteOwnedData`, `POST /sync/delete`, and CLI `delete-data`. Whole-workspace CAS removal additionally requires the explicit `artifactDirectoryOwnership: "exclusive"` placement assertion. Cloud calls receive a stable key derived from confirmed scope, owner, and URL—not the per-attempt manifest—so a partial local retry safely repeats authenticated administration.

# TypeScript integration API

Agencity exposes domain-shaped TypeScript contracts for embedding the runtime, connecting clients, replacing placement adapters, and operating optional synchronization. Public signatures do not expose LibSQL or Turso SDK objects.

The package is private and is consumed from a source checkout or Bun link. It is not published to a package registry.

## Package entrypoints

| Import | Public surface |
|---|---|
| `@prime-agent/runtime` | Aggregate export of the public modules below. |
| `@prime-agent/runtime/domain` | Events, payloads, reducer state, JSON constraints, and stable errors. |
| `@prime-agent/runtime/storage` | `AgentStorage`, storage capabilities, `LibSqlStorage`, and the Turso transport adapter. |
| `@prime-agent/runtime/artifacts` | `ArtifactStore` and `LocalArtifactStore`. |
| `@prime-agent/runtime/executors` | Effect contracts and file, shell, model, and skill executors. |
| `@prime-agent/runtime/console` | Generated-cell SDK types, observation helpers, and the private worker-process host. |
| `@prime-agent/runtime/runtime` | `Supervisor` and its run, outbox, projection, context, recursive-agent, memory, harness, skill, goal, schedule, and recovery services. |
| `@prime-agent/runtime/protocol` | `ProtocolServer`, `AgentClient`, HTTP and in-process transports, and wire-facing types. |
| `@prime-agent/runtime/security` | Secret filtering, scrubbing, and model-credential helpers. |
| `@prime-agent/runtime/tui` | The protocol-backed full-screen terminal client and plain-transcript fallback. |
| `@prime-agent/runtime/sync` | Profile/device state, envelope synchronization, data-control contracts, the Turso transport, and deterministic test transport. |
| `@prime-agent/runtime/placement` | Local placement descriptors and HTTP-backed relational, content-addressed object, candidate-index, and executor adapters. |

## Choose an operating model

### Embedded `Supervisor`

Use `Supervisor` when the host process owns the runtime lifecycle. The host supplies storage and artifact locations, opens and closes the supervisor, chooses whether startup recovery and wake schedulers run, and prevents another process from executing the same sessions.

```ts
import { Supervisor } from "@prime-agent/runtime/runtime";

await usingRuntime();

async function usingRuntime() {
  const supervisor = await Supervisor.open({
    databaseUrl: "file:.agencity/agent.db",
    profileDatabaseUrl: "file:.agencity/profile.db",
    artifactDirectory: ".agencity/artifacts",
    workspaceRoot: process.cwd(),
    restartConsoleAfterCell: true,
    recover: true,
    providerConcurrency: { openai: 2 },
    userScopeKey: "profile-user-id",
  });

  try {
    const { sessionId, branchId } = await supervisor.createSession({
      workspaceId: "example",
      model: {
        provider: "openai",
        model: "openai/gpt-5.6-sol",
        reasoningEffort: "high",
      },
      budget: { tokenLimit: 10_000, turnLimit: 20 },
    });

    const result = await supervisor.runs.start(sessionId, branchId, {
      task: "Inspect the workspace and report the result",
      requestKey: "api-example-run",
    });
    console.log(result);
  } finally {
    await supervisor.close();
  }
}
```

`Supervisor.open` migrates the local stores, opens the content-addressed artifact store and profile-owned credential store, installs the standard executors, and optionally performs recovery. `close` stops local schedulers, drains local recursive runners, stops the console worker, releases registered credential-redaction values, and closes storage.

An embedded supervisor does not by itself provide the managed product service's discovery manifest, bearer authentication, resident run queue, process fencing, or idle shutdown. If an embedded host creates a `ProtocolServer`, it also owns network exposure and authentication policy.

### Managed product service

Ordinary `agencity` product flows discover or start a per-workspace `ManagedWorkspaceService`. That service owns the `Supervisor`, local process lease, startup recovery, resident run advancement, schedules, loopback listener, bearer token, and graceful drain. Clients attach through `AgentClient` and do not open the workspace database directly.

The managed service is a product lifecycle component, not a hosted multi-tenant service and not a placement adapter. It binds to `127.0.0.1`, authenticates every route with an owner bearer from an owner-only manifest, and retains trusted-local OS authority. See [Public client protocol](./protocol.md).

Do not run an embedded supervisor against a workspace database currently owned by the managed product service.

## Model providers

The product supports OpenAI, Anthropic, and Vercel AI Gateway through one shared Vercel AI SDK execution core with thin transport factories. Stored owner keys take precedence over `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `AI_GATEWAY_API_KEY`. The corresponding base origin environment variables can replace the default endpoints. Model identity is durable as `{ provider, model, reasoningEffort }` and is formatted as `provider:creator/model` at product boundaries.

`reasoningEffort` is `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`. `provider-default` leaves the provider override absent. `ModelExecutor.resolveDispatch` resolves the complete configuration, reasoning capability decision, catalog digest, and execution endpoint identity once before the request is committed. Recovery executes that retained `ModelDispatch`; it does not reinterpret a changed catalog or endpoint.

`ModelCatalog` fetches the public Vercel AI Gateway `/v1/models` catalog, normalizes only language models, and stores a bounded digest-checked cache in the profile database. `ModelExecutor.contextCapacity()` uses the descriptor for the exact canonical model and reports explicit unknown capacity when the catalog has none.

The Echo provider exists inside the low-level runtime as a deterministic test fixture. It is not a selectable product provider or demo mode. Product onboarding, model selection, help, and status must not present Echo as usable product configuration. Low-level provider descriptor lists can include injected or internal providers, so an external product UI must apply product provider policy rather than treating every descriptor as selectable.

`ModelProvider.complete` is the required provider contract. A provider may also declare `capabilities.streaming: true` and implement `stream`. The stream callback emits bounded, process-local progress; the returned full `ModelResponse` is the only value used for the durable terminal outcome. AI SDK provider warnings are normalized into bounded durable warning records. Missing capability metadata means unsupported. A provider that declares streaming without implementing it is rejected.

`ModelExecutor.providers()` and `Supervisor.modelProviders` return secret-free descriptors with names, display labels, capabilities, usability, credential source, and remediation. `ModelExecutor.contextCapacity()` reports exact provider/operator metadata or an explicit unknown value; it does not guess model capacity.

Structured requests use response-aware `agencity.model-dispatch.v2` and return `agencity.model-effect-output.v2`. The built-in product transports declare formal tools without execute callbacks and perform no provider-side execution or tool-result continuation. A custom provider's complete structured output is credential-checked across all fields and fails closed before return or persistence.

## Sessions, branches, and autonomous runs

- `createSession` appends `SessionCreated`; optional caller IDs and names support deterministic provisioning.
- `selectModel` normalizes provider shorthand, checks availability, requires an idle model boundary, and appends `SessionModelChanged`.
- `appendMessage` scrubs known credentials and appends a message event.
- `fork` creates a durable branch from a validated lineage cursor without changing the parent.
- `executeCell` serializes cell execution per branch and atomically commits its observation, staged working values, and artifact references.
- `resume` reconstructs and reattaches to a retained branch.

Product tasks use the strict autonomous-run service:

- `runs.start` admits a task and advances it through typed model actions, cells, observations, budget accounting, goals, and a terminal boundary.
- `runs.get` reads the retained run.
- `runs.advance` resumes a retained run without inventing action identity.
- `runs.cancel` commits cancellation intent before aborting admitted work.

An exact `requestKey` retry returns the same run; reuse with changed durable meaning conflicts. `unknown`, `cancelled`, `budget_exceeded`, `blocked`, and `failed` are distinct outcomes.

Autonomous calls declare exactly two fixed provider tools: `bun_console` and `finish`. They are response declarations, not executable provider callbacks. Only a validated and durably committed `bun_console` submission can execute generated work. Shell, file, SQL, model, subagent, memory, skill, state, and artifact operations are injected APIs inside that later disposable cell. `finish` ends the run as successful, blocked, or failed. Supplemental narration is diagnostic-only, and the supervisor never searches prose for JSON or code. See [ADR 0010](./decisions/0010-formal-model-tool-contracts.md) and [Generated TypeScript console SDK](./console-sdk.md).

A successful finish publishes its exact message only after required gates pass. Failed or unknown required gates do not publish the proposed success. Blocked and failed finishes commit their exact messages atomically with effective terminal status. Missing information uses a blocked finish; later user text starts a normal new run.

`modelLoop.turn` and `modelLoop.run` remain low-level diagnostic paths. They are not substitutes for `runs` in a product task integration.

## Durable recursive work

Root agents, delegated agents, and recursive model calls use retained sessions, tasks, budgets, mailboxes, and JSON handles.

```ts
const child = await supervisor.agents.spawn(parentSessionId, parentBranchId, {
  task: "Investigate the failing tests",
  completionCriteria: "Return root cause and verified evidence",
  idempotencyKey: "investigate-tests-v1",
});

await supervisor.agents.sendMessage(parentSessionId, parentBranchId, {
  target: child.sessionId,
  content: "Prioritize the first failure",
  taskId: child.taskId,
  intentKey: "priority-v1",
});

const family = await supervisor.agents.listFamily(parentSessionId, parentBranchId);

const call = await supervisor.models.start(parentSessionId, parentBranchId, {
  prompt: "Summarize the selected log ranges",
  inputSetId,
  idempotencyKey: "summarize-log-v1",
});

const terminal = await supervisor.models.result(call.handleId, {
  timeoutMs: 30_000,
});
```

`agents.spawnMany` validates and admits the complete batch atomically. `agents.listFamily` returns exact parent, sibling, and branch-scoped direct-child coordinates plus task text, model configuration, cancellation state, and derived activity. Admitted children without an active run are idle, and parent activity comes from the parent route rather than the task edge that spawned the current child. Activity values are `working`, `idle`, `attention`, `ended`, or `unavailable`, with blocked, failed, budget-exceeded, unknown, cancellation-pending, cancelled, archived, and missing-state reasons. Missing retained state stays unavailable instead of resolving to another branch.

Mail is limited to the same root family. Cancellation walks an admitted descendant tree. Recursive handles retain the child, task, model, input, outcome, usage, and provenance needed after restart. Large results spill to the artifact store. Lost non-idempotent model calls become `unknown` and are not replayed.

Documents and input sets provide exact bounded inputs:

```ts
const document = await supervisor.documents.import(sessionId, branchId, {
  name: "build.log",
  content: largeLog,
  chunkBytes: 32 * 1024,
});
const chunks = await supervisor.documents.readChunks(document.documentId, {
  start: 0,
  limit: 20,
});
const inputSet = await supervisor.documents.createInputSet(sessionId, branchId, {
  chunkIds: chunks.map((chunk) => chunk.chunkId),
});
```

## Goals, heartbeats, and schedules

Goals retain completion gates and the workspace-material cursor against which evidence was evaluated. Required failed, cancelled, unknown, or stale gates block completion.

```ts
const goal = await supervisor.goals.create(sessionId, branchId, {
  description: "Ship a passing patch",
  gates: [{
    name: "tests",
    executor: "shell",
    operation: "run",
    input: { command: "bun test" },
    required: true,
  }],
});

await supervisor.runs.start(sessionId, branchId, {
  task: "Ship a passing patch",
  goalMode: "current",
});

const heartbeat = await supervisor.heartbeats.create(sessionId, branchId, {
  intervalMs: 60_000,
  goalId: goal.goalId,
  prompt: "Recheck the release",
});

const schedule = await supervisor.schedules.create(sessionId, branchId, {
  at: "2026-08-07T09:00:00Z",
  prompt: "Prepare the report",
  goalMode: "auto",
});
```

The database-driven coordinators create durable wakes. Missed intervals coalesce, and startup resumes due active records. A managed service starts those coordinators only after execution ownership is established.

## Memory, refinement, skills, and specifications

`memory.create/search/list` operate on scoped, attributable records. Search returns both ranked records and provenance for candidates, policy rejections, and selections. FTS5 is a candidate generator; scope, status, tags, conflicts, exposure, and limits remain authoritative service decisions.

`refiner.request` freezes a bounded trajectory and runs a durable recursive child under the sealed internal `agencity.refinement-review.v1` contract. The child must call the single fully typed `agencity_submit_refinement_review` tool. Its `responseAdmission` is retained before execution; successful output becomes a message-free typed result bound to the exact child model completion and transport digests. Public recursive calls remain text operations, and no assistant JSON parser or prose fallback exists. Valid output enters proposal validation and bounded candidate exposure. Promotion, broad scope, approval, and rollback are governed separately; model prose is not evidence.

`harness` exposes proposal, validation, activation, allocation, observation, decision, approval, history, and rollback operations. `skills` compiles, tests, and invokes immutable skill versions through the outbox. `specs.spawn` admits a version-pinned subagent through the normal task/session model. Skill permissions are an exact runtime allowlist and are not an OS sandbox.

The generated-cell facades are narrower than the supervisor API. In particular, evaluator and user authority is not delegated to generated code. See [Generated TypeScript console SDK](./console-sdk.md).

## Storage and projections

`AgentStorage` exposes domain operations rather than a general database client:

```ts
interface AgentStorage {
  readonly name: string;
  readonly capabilities: StorageCapabilities;
  migrate(): Promise<void>;
  appendEvents(events: readonly NewAgentEvent[]): Promise<AgentEvent[]>;
  loadEvents(sessionId: string, query?: EventQuery): Promise<AgentEvent[]>;
  // snapshots, outbox claims, domain projections, and analytical reads
}
```

Canonical writes go through validated event and service commands. `readonlyQuery({ sql, args })` is a bounded LibSQL-oriented analytical surface, not a portable mutation interface. The local adapter advertises offline writes, analytical SQL, in-process notifications, and same-device process fencing. It does not advertise distributed leases.

Snapshots and operational tables are projections. Historical rebuild is deterministic and never re-executes effects.

```ts
const { cursor, state } =
  await supervisor.projections.getSnapshot(sessionId, branchId);

const unsubscribe = supervisor.projections.subscribe(
  sessionId,
  branchId,
  cursor,
  (event) => consume(event),
);
```

Subscriptions are commit notifications, not a second source of truth. Reconnect from storage after the last applied cursor and deduplicate by event ID.

## Artifacts and placement

`ArtifactStore` uses immutable `sha256:<digest>` identities:

```ts
const reference = await store.put(bytes, { mediaType: "text/plain" });
await store.verify(reference);
await store.resolve(reference);
await store.readRange(reference, 0, 1024);
await store.export(reference, destination);
```

`LocalArtifactStore` stores bytes in a local filesystem CAS. `S3CompatibleArtifactStore` is an implemented remote S3/R2-style HTTP adapter available from the placement entrypoint. Neither adapter supplies automatic replication or garbage collection. Physical `delete` can invalidate retained references; ownership and retention policy belong above the store contract.

HTTP adapters also exist for relational state, memory candidate generation, and remote executor transport. These are client/handler implementations and conformance-tested contracts, not a hosted Agencity deployment. See [Placement adapters](./placement.md) and [Capability matrix](./capabilities.md).

## Optional Turso synchronization

The local workspace database remains canonical. Optional synchronization exchanges immutable envelopes through a separate replica database.

```ts
const supervisor = await Supervisor.open({
  databaseUrl: "file:.agencity/workspace.db",
  profileDatabaseUrl: "file:.agencity/profile.db",
  artifactDirectory: ".agencity/artifacts",
  sync: {
    workspaceId: "example",
    syncUrl: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
    credentialReference: "credential:turso-example",
    replicaUrl: "file:.agencity/sync-replica.db",
    intervalMs: 30_000,
  },
});

await supervisor.sync.sync("manual");
await supervisor.sync.push();
await supervisor.sync.pull();
await supervisor.sync.checkpoint();
await supervisor.sync.stats();
await supervisor.sync.status();
```

The pinned Turso adapter exposes directional push, pull, checkpoint, and statistics. A missing sync configuration leaves a complete local runtime. Network failure retains local reads/writes and staged envelope work. Synchronization does not provide distributed leases, task stealing, automatic execution-owner failover, artifact-byte replication, or Cloud administrative deletion.

`ProfileStore` retains device identity, preferences, workspace catalog entries, installed skill versions, and opaque credential references. Raw provider keys are stored separately and are not synchronized as canonical/profile values.

## Effects, recovery, and uncertainty

Every external effect is committed to the outbox before execution and receives one visible outcome: `succeeded`, `failed`, `cancelled`, or `unknown`. A caller-supplied idempotency key deduplicates runtime intent; it does not prove that the external system is idempotent.

Recovery may requeue lost work only when the operation was declared safe to retry. Lost non-idempotent work becomes `unknown`. Reconciliation adds evidence without rewriting the unknown outcome or retrying it. See [Crash recovery and unknown effects](./recovery.md).

## Context inspection and compaction

`Supervisor.inspectContext(sessionId, branchId)` returns the effective summary, uncovered narrative estimate, and exact provenance. `supervisor.compact(sessionId, branchId, input)` supports `deterministic-extractive-v1` and `model-summary-v1`. Compaction retains canonical source events; it creates a derived context view rather than replacing history.

## Physical data control

`Supervisor.deleteOwnedData(input)` supports owned `session`, `workspace`, and `profile` scopes with exact confirmation text. It quiesces execution admission and treats a destructive attempt as terminal for that supervisor. Workspace and profile deletion require an external receipt directory. Session deletion is limited to an independently erasable session and protects still-referenced artifacts.

Managed remote workspace deletion additionally requires an operator-supplied `ManagedReplicaDeletionAdmin` with authenticated administrative authority for every durable managed URL. Data-plane sync credentials are insufficient, and remote session/profile deletion granularity is unavailable.

## Stable errors

Branch on `AgentRuntimeError.code`, never on message text:

- `VALIDATION_ERROR`
- `CONFLICT`
- `NOT_FOUND`
- `CAPABILITY_UNAVAILABLE`
- `INVALID_TRANSITION`
- `DEPENDENCY_FAILURE`
- `EXECUTION_OWNERSHIP_CONFLICT`

The HTTP protocol maps these to stable 4xx/424/501 responses and uses `INTERNAL` for unexpected failures.

## Security boundary

All current runtime paths are trusted-local. Generated TypeScript, skills, and shell commands have the OS authority of the runtime process. The console worker is a crash/protocol boundary, not a hostile-code sandbox. Provider credential filtering and typed file/SQL guards reduce accidental exposure but do not provide tenant isolation. See [Trusted-local security boundary](./security.md).

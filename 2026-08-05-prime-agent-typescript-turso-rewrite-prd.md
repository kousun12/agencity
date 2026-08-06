# Prime Agent TypeScript/Turso rewrite

**Status:** First draft  
**Date:** August 5, 2026

## Summary

Build a new agent runtime in TypeScript on Bun, informed by [Prime Agent](https://www.primeintellect.ai/blog/prime-agent) and its [open-source implementation](https://github.com/PrimeIntellect-ai/prime-agent). Preserve Prime Agent's strongest ideas: programmatic model calls, persistent subagents, recoverable sessions, autonomous execution, and an editable continual harness. Replace the persistent IPython kernel and split file-based state with a relational runtime backed by Turso.

Turso is the default store. Each agent works against a local database and can synchronize its sessions with Turso Cloud. The database contains the complete durable record of conversations, program execution, tools, subagents, memory, and harness refinement. A Bun TypeScript console provides temporary computation over that state. Restarting the console must not change what the agent knows or what work it owns.

PostgreSQL is a later storage option for centralized deployments that need stronger coordination. The first implementation should define a narrow storage contract and migration boundary so PostgreSQL can be added without changing the agent model. PostgreSQL support is not an MVP requirement.

## Motivation

Prime Agent joins two useful abstractions:

- A Recursive Language Model (RLM) treats context as data the model can inspect and transform programmatically. Model and subagent calls become functions inside a REPL rather than fixed tool calls issued one at a time.
- Continual Harness lets the agent create, update, and delete its own prompt notes, memories, skills, and subagent specifications based on its trajectory.

The current design persists several different forms of state through different mechanisms: append-only JSONL for session history, IPython variables and kernel snapshots for working state, and JSON files for continual harness entries. The model receives a compact view of that state and must know which mechanism contains the detail it needs. Recovery works, but the runtime's durable truth is spread across files and a live process.

The rewrite makes every important fact queryable, versioned, and attributable. Conversation entries, tool requests, subagent messages, derived memories, refinement proposals, and evaluation outcomes share one relational history. Context assembly becomes a query over durable state instead of a reconstruction from several persistence formats.

The TypeScript/Bun runtime is a better fit for this system than a Python kernel. This is a claim about the agent runtime, not about every computing workload:

- Bun gives the supervisor, console, tool SDK, local server, and package manager one runtime and dependency graph.
- TypeScript makes tool inputs, event payloads, state transitions, and extension contracts compile-time interfaces.
- Promises, streams, workers, and `AbortSignal` fit long-running model calls and concurrent subagents directly.
- JSON, HTTP, WebSocket, and npm package support match the interfaces used by coding agents.
- Bun can execute TypeScript without a separate build step, which keeps generated programs and installed skills inspectable.
- A disposable worker process is easier to bound and replace than a long-lived notebook kernel whose heap has become part of session identity.

Python remains available as an external execution tool for Python repositories, data science, and libraries with no useful JavaScript equivalent. It does not own the agent session.

## Design constitution

Requirements describe behavior already anticipated by this document. The constitution records the values used when implementation exposes a choice the requirements do not answer. Each principle names a preference and a case it decides. It should change less often than the architecture built under it.

### Adapt through experience

The system should become increasingly bespoke as it works. A new installation begins with a small set of general mechanisms; trajectories, evaluations, and user decisions produce scoped memories, skills, subagent roles, retrieval policies, and workflows suited to that installation. Learned specialization must remain attributable, testable, and reversible.

When one workspace repeatedly succeeds with a particular release procedure, encode that procedure as a workspace skill. Do not add it to the universal agent loop or deny the specialization to preserve a superficially uniform product.

### Durable state owns agent identity

The database and referenced artifacts contain everything required to resume committed work. A process, model connection, console heap, UI, or machine may disappear without taking the agent's identity with it.

When preserving a convenient live object conflicts with reconstructibility, persist the required value or redesign the operation around a durable handle.

### Placement is a configuration choice

State, retrieval, artifacts, and execution may live locally or remotely. The first release uses local Turso, local full-text retrieval, a local content-addressed artifact store, and trusted local execution because that is the shortest path to a working system. Those defaults do not establish a permanent preference for local infrastructure.

Each component exposes a behavioral contract that permits a remote implementation: Turso or PostgreSQL for relational state, full-text or semantic services for retrieval, local files or object storage for artifacts, and local workers or managed sandboxes for execution. Moving an artifact to cloud storage must not change its identity or the events that refer to it.

### Boundaries preserve semantics

Replaceable components share domain semantics, not a lowest-common-denominator API. An adapter declares capabilities such as offline writes, distributed leases, semantic search, range reads, or remote isolation. The runtime either uses an available capability or reports that the requested operation is unavailable.

PostgreSQL may provide transactional claims that Turso does not. The shared task model remains stable, while its connected coordination guarantees are capability-dependent.

### Evidence governs refinement

The agent may propose changes to its own harness. Promotion depends on source evidence and an evaluator appropriate to the change's scope. A persuasive model explanation is not an observed outcome.

When a generated skill claims to fix a repeated failure, activate it as a candidate, run its tests and completion gate, and retain it only if the result supports the claim.

### User authority bounds autonomy

The agent acts within delegated data, permission, budget, and publication boundaries. It cannot expand those boundaries or promote its own permission policy. The user can inspect, export, and delete owned state through the same product interface regardless of where the backing component runs.

When a global preference conflicts with an inferred workspace tactic, the explicit preference wins. When deletion conflicts with retained provenance, deletion wins for the selected scope and its managed replicas.

### General mechanisms precede prescribed workflows

SQL, TypeScript, model calls, durable tasks, evaluators, and policies are the core building blocks. Product code should not hardcode a planning ceremony or delegation topology that the agent can construct and improve from those mechanisms.

When a workflow appears repeatedly and evaluates well, package it as an inspectable skill or policy rather than enlarging the supervisor's fixed loop.

### Uncertainty remains visible

The runtime represents unknown outcomes, conflicting claims, stale context, missing artifacts, and unavailable coordination directly. It does not convert absence of evidence into success to keep a session moving.

When a process dies after requesting a non-idempotent external action, recovery records an ambiguous outcome and reconciles it. It does not retry blindly.

## Product goals

### Durable execution

Every model message, console cell, tool request, tool result, subagent message, state transition, and refinement is committed before dependent work proceeds. A process may be killed between any two turns and resume from the database without relying on an intact JavaScript heap.

### Relational context

The model can query its complete history and working set through SQL. Large inputs live in tables or artifacts and enter model context only through deliberate queries, projections, or recursive model calls. Context length becomes a context-selection constraint rather than a persistence constraint.

### Programmatic orchestration

The agent writes TypeScript that can query state, transform data, invoke tools, and start model sessions from loops or concurrent promises. The RLM property survives the rewrite: model calls are callable operations inside model-generated programs.

### Local and remote operation

An agent can run entirely against local Turso without a network connection, synchronize that state through Turso Cloud, or later use a connected PostgreSQL deployment. Memory indexes, artifact stores, and executors follow the same placement model. Component location does not change session identity, event semantics, or the model-facing SDK.

### Inspectable multi-agent work

Every subagent is a session with a parent, durable task, messages, status, and output artifacts. Parent and child sessions communicate through persisted messages. The UI and other agents can inspect the same records without scraping console output.

### Measured harness refinement

Self-improvement produces versioned proposals with evidence, activation scope, evaluation criteria, and observed outcomes. A refinement is promoted because later execution supports it, not because the refiner described an expected benefit convincingly.

### Controlled mutation

The model does not receive unrestricted write access to canonical tables. Typed runtime APIs validate state transitions and append domain events. Raw SQL is available for reading and analysis; writes that affect execution, memory, permissions, or harness behavior pass through validated commands.

### Replaceable infrastructure

The domain model does not depend on Turso SDK objects outside the storage package, local paths outside the artifact adapter, or one retrieval engine's result type outside the memory index. Each implementation passes a shared behavioral suite and advertises additional capabilities. PostgreSQL may implement stronger locking and notification semantics without pretending to be Turso, and semantic retrieval may add candidate generation without replacing authoritative scope and policy filters.

## Non-goals

- Preserve Prime Agent's internal modules, Python APIs, session files, or extension API.
- Make arbitrary SQL portable between Turso and PostgreSQL.
- Train model weights as part of ordinary agent execution.
- Guarantee exactly-once execution across offline writers. Tools must be idempotent where practical, and the runtime must detect duplicate work.
- Store all artifacts as database blobs. Source trees, large tool outputs, media, and build artifacts may live in content-addressed local or object storage with database references.
- Provide a security sandbox in the first release. The runtime assumes it runs in a trusted local environment or inside an externally managed remote sandbox.
- Ship PostgreSQL in the first release unless the storage abstraction makes it trivial.
- Import Prime Agent JSONL sessions or harness state. A one-way migration tool may be considered after the event schema and runtime behavior stabilize.

## System guarantees

### Deterministic projection

The same canonical events, reducer versions, and artifact contents produce the same materialized agent state. Event schemas are immutable after release. Schema evolution adds a new event version and a tested upcaster or projection path; it does not rewrite retained history.

This guarantee covers committed state. It does not claim that a stochastic model will produce the same next response when called again.

### No hidden durable state

Every value required after a committed console-cell boundary exists as an event, typed working value, managed artifact, or external resource reference with an observed version. Caches may improve latency but cannot change behavior when empty.

### Explicit side-effect outcomes

Every external effect has a durable request and one of four outcomes: succeeded, failed, cancelled, or unknown. Automatic retry is allowed only when the executor can establish idempotency. Unknown non-idempotent effects require reconciliation or user direction.

### Referential integrity across stores

Artifact and external-resource references include stable identity and integrity metadata. Missing content, digest mismatch, stale external versions, and inaccessible remote stores become explicit dependency failures. A projection cannot present dependent work as complete while its required content is unavailable.

### Behavioral substitutability

Replacing a component preserves its declared contract: identifiers, causality, scope, durability boundary, and model-facing behavior. A capability may be unavailable in one implementation, but an adapter cannot silently weaken a guarantee. Shared conformance tests cover relational stores, artifact stores, memory indexes, and executors.

### Data control follows ownership

Storage placement does not determine data authority. Export and deletion operate over the selected scope and enumerate managed replicas, indexes, artifacts, and derived projections. Append-only means immutable while retained; it does not make user-owned data undeletable.

## Core model

### Recovery invariant

The complete durable agent state is reconstructible at every committed console-cell boundary. The Bun heap is a cache and may be discarded at any time.

Authoritative domain history is append-only: messages, console cells, model calls, tool requests and results, memory versions, harness refinements, subagent communication, and lifecycle transitions create new events. Mutable rows are permitted for projections, indexes, leases, sync metadata, and other operational state only when they can be rebuilt from authoritative records or safely discarded.

An arbitrary JavaScript heap cannot be recovered. Closures, sockets, iterators, child processes, and native objects do not become durable merely because they have variable names. Any value required by a later cell must be exported through the typed state API as serializable data or stored as an artifact with a durable reference. Console variables may cache those values during a healthy process.

Each cell has a transaction-like lifecycle:

1. The supervisor commits the proposed cell and its input dependencies.
2. A separate worker executes the cell. External effects use durable requests with idempotency keys.
3. On success, the supervisor atomically commits the cell result, exported values, emitted events, and artifact references.
4. Only a committed result enters later model context or becomes available to dependent work.

A worker killed before step 3 leaves an incomplete attempt. Recovery may retry it when its effects are idempotent or mark it abandoned and ask the agent to continue. The runtime never reconstructs state by blindly replaying arbitrary JavaScript, because replay could repeat file edits, network calls, or other effects.

The invariant covers state owned by the agent runtime. External systems remain external. The database records requested effects, observed results, file hashes, and artifact snapshots where configured; it cannot reconstruct an unversioned service or filesystem that changed independently.

### Sessions are durable actors

A session owns a conversation branch, model configuration, budgets, current goal, and a stream of events. Root agents and subagents use the same session model. Their relationship is data:

- `parent_session_id` identifies direct ancestry.
- A task records why the child exists and what completion means.
- Messages between sessions are appended to a mailbox.
- Running, idle, stopped, failed, and archived are projections from lifecycle events.

No distinction in persistence exists between an interactive root agent and an autonomous child.

### Events are canonical

The canonical record is an append-only event table. Events carry a unique ID, session, causal parent, type, schema version, timestamp, producer, idempotency key, and JSON payload. Mutable views such as current task status or active memory are projections over events.

Append-only storage matters for Turso Sync. Independent writers normally add different rows instead of overwriting shared state under its last-push-wins conflict policy. Events also preserve the evidence required to debug context assembly and harness changes.

Some future coordination capabilities require mutable records. A later coordinator may implement task leases, budget reservations, and exclusive resource ownership with explicit version checks and short transactions. The first release uses one execution owner per session and does not offer globally exclusive offline claims.

### The TypeScript console is disposable

The model's primary action surface is a Bun-powered TypeScript console. Each submitted cell and its result are events. The console injects a small typed SDK and a tagged-template interface for direct read-only SQL:

```ts
const failures = await sql`
  SELECT tool_name, error_code, count(*) AS occurrences
  FROM failed_tool_calls
  WHERE session_id = ${session.id}
  GROUP BY tool_name, error_code
`;

const investigations = await agents.spawnMany(
  failures.map((failure) => ({
    task: `Investigate repeated tool failure: ${JSON.stringify(failure)}`,
  })),
);
```

Template interpolation is supported in the first release. The SQL tag executes against a read-only connection and rejects statements outside the read path. It does not attempt to provide a query builder or a complete SQL-injection defense. A typed query builder and stricter parsing remain possible extensions if generated queries or untrusted values make them useful.

The console may keep variables between cells for speed, but persisted references are the only supported source of recovery. A worker restart creates a fresh console and restores named values that the agent explicitly checkpointed. The system should be able to run in a diagnostic mode that restarts the worker after every cell.

### Side effects use an outbox

Tools and model calls are external side effects. A console command appends a request with an idempotency key and commits it. An executor claims the request, performs the operation, and appends progress and completion events. The requesting session observes the result through a promise while connected or queries it after recovery.

This protocol applies to shell commands, file edits, browser actions, model calls, user questions, timers, and subagent creation. Each executor defines its cancellation and retry semantics. The database records every attempt.

### Context is a projection

Before each model call, a context materializer selects:

- the immutable base policy;
- active session and workspace policy;
- current goal, budget, and unresolved blockers;
- recent messages and tool activity;
- active memories and skill descriptions selected for the task;
- summaries of older branches;
- relevant parent, child, and sibling messages;
- references to larger records the model can query from the console.

The materializer records the IDs and versions included in each model call. A future investigation can therefore reproduce what the model was told.

Compaction creates a derived summary; it never deletes or replaces source events. Multiple compaction strategies may coexist, and a branch can be re-materialized with a different strategy.

## Memory model

Memory has explicit types because each type has different update and retrieval rules.

### Episodic memory

Session events are the complete record of what happened. They are immutable and scoped to a branch. Summaries, milestones, and failure windows are derived records linked to their source events.

### Working memory

Named values contain intermediate findings, plans, query results, and references required across turns. Each value is a discriminated union:

```ts
type WorkingValue =
  | { kind: "json"; value: JsonValue }
  | { kind: "artifact"; artifactId: string };
```

Typed JSON is the default for plans, IDs, counters, parsed facts, and other state whose fields need to be queried, diffed, or rendered. A JSON value may be at most 128 KB after serialization. Larger values and values normally consumed as a whole become immutable artifacts.

Artifacts live in a content-addressed local store or object store. Their identifier includes a digest of their contents; the database records the digest, media type, size, location, and source event. Identical content written by different cells or agents resolves to the same object, providing automatic deduplication and integrity checking. Test logs, source snapshots, datasets, large model outputs, media, and binary files normally belong here.

The artifact interface separates identity from placement. It supports put, resolve, verify, range-read, export, and delete operations. A local filesystem implementation ships first; an object-store implementation may move or replicate content without changing artifact IDs.

Each working-memory update creates a new version. Console-only variables are caches and never satisfy a durability requirement.

### Semantic memory

Memories contain claims, preferences, decisions, observations, and learned constraints. Each entry records:

- local, workspace, user, or global scope;
- source event IDs;
- confidence and status;
- creation and last-confirmed times;
- superseded and conflicting memory IDs;
- the refinement or user action that created it.

Candidate memories do not automatically enter model context. Promotion rules control when a memory becomes active.

### Procedural memory

Skills are versioned TypeScript modules or references to installed tools. A skill includes its input schema, permissions, source, tests, observed outcomes, and runtime compatibility. Generated skills run under the same trusted execution mode and host command policy as generated console code.

### Delegation memory

Subagent specifications describe a reusable role, invocation criteria, expected artifact, model policy, and budget. A specification does not represent a live child. Invoking one creates a normal task and session linked to the specification version used.

### Retrieval

The first retrieval system uses deterministic scope, recency, status, tags, full-text search, and explicit links. Every selected item records the rule or query that selected it. Semantic retrieval and embeddings are deferred until a retrieval evaluation demonstrates misses that full-text search cannot address. If added, semantic search supplies candidates; scope, status, and policy filters remain authoritative.

Retrieval sits behind a candidate-index contract that records query provenance and stable memory IDs. A later local embedding index or remote retrieval service can replace or complement full-text search without changing memory ownership, promotion, or context-selection records.

## Recursive model execution

The RLM interface exposes model sessions as asynchronous TypeScript operations. A call may create an isolated child session over a query result, document range, or generated prompt. It returns a durable handle immediately. Results arrive through messages and artifacts rather than an in-memory return value that disappears on restart.

Large inputs are imported as documents and ordered chunks. The root model receives metadata and query tools, then chooses how to inspect, aggregate, or delegate the data. A recursive call records the exact input row IDs and model configuration used. Intermediate outputs can be joined, filtered, or passed into another generation of calls.

Limits apply at the session tree and request level:

- maximum depth and child count;
- token, cost, turn, and wall-clock budgets;
- per-provider concurrency;
- result-size and artifact quotas;
- cancellation propagation.

## Continual harness

The editable harness contains prompt notes, semantic memories, skills, and subagent specifications. The base runtime policy, permission boundaries, and refinement rules are immutable from inside the agent.

Refinement follows a staged lifecycle:

1. A trigger identifies repeated failure, reusable success, user correction, stale memory, or unproductive delegation.
2. The refiner reads the source trajectory and current harness versions.
3. It creates a proposal containing typed edits, evidence IDs, intended scope, predicted effect, and an evaluation.
4. Validation rejects malformed, conflicting, over-broad, or unauthorized edits.
5. The proposal activates as a candidate for a bounded set of sessions or tasks.
6. The evaluator records observed outcomes against the stated evaluation.
7. The runtime promotes, revises, rejects, or rolls back the candidate.

Automatic promotion is limited by scope and evaluator quality:

- Session-local memory may activate automatically from one supported observation.
- Workspace prompt notes and skills require an objective evaluator and repeated successful use. Passing a previously failing completion gate, reducing a repeated tool failure, or passing a generated skill's tests are acceptable signals.
- A single success normally leaves a workspace refinement as a candidate.
- User and global preferences require explicit user approval.
- Permission and safety policy cannot be promoted by the agent the policy constrains.

Every automatic decision records the evaluator, baseline, observations, and promotion rule. Executable skills require tests before activation.

The first release does not update model weights. Offline training can consume the same event and evaluation data later without changing the runtime schema.

## Turso topology

Each local runtime opens a Turso database file. Reads and writes are local. A sync service pushes local changes to Turso Cloud and pulls remote changes on startup, reconnect, a configurable interval, and explicit user request.

The schema is designed for multi-writer convergence:

- writers generate globally unique, time-sortable IDs;
- canonical history is append-only;
- commands carry idempotency keys;
- versions identify stale proposals and projections;
- destructive changes are represented as superseding events;
- projections can be rebuilt from canonical history;
- reconciliation records duplicate work, conflicting claims, and rejected mutations.

Turso's default last-push-wins behavior must not silently decide agent ownership, budgets, permissions, or harness policy. One execution owner advances a session at a time. Other writers may append messages, observations, and results without taking ownership. If two offline runtimes advance the same historical session, synchronization preserves them as separate branches instead of merging their execution streams.

The first release does not include a coordination service. Shared task stealing, global concurrency limits, atomic budget reservation, exclusive external resources, and automatic ownership failover remain unavailable. A later coordinator may add these capabilities without changing the event model.

Cloud sync is optional. A local database remains a complete single-device runtime and can be exported as an inspectable session bundle.

### Database boundaries

Each workspace has its own database containing sessions, branches, tool activity, workspace memory, refinements, and artifact metadata. A session belongs to exactly one workspace database.

A separate small profile database contains durable user preferences, globally installed skills, provider-configuration references, and cross-workspace defaults. The context materializer reads profile state separately when constructing a session context. This split gives workspaces independent synchronization, export, deletion, sharing, and permission boundaries.

## Optional PostgreSQL backend

PostgreSQL serves deployments where all workers are connected and shared coordination matters more than offline execution. It may use row locks, advisory locks, `LISTEN`/`NOTIFY`, and server-side transactions behind storage capabilities unavailable in Turso.

The storage package exposes domain operations rather than a generic query adapter:

- append and stream events;
- create and claim executable requests;
- load session and branch projections;
- save and select context records;
- propose and transition harness versions;
- acquire leases and reserve budgets;
- store sync and reconciliation state.

Backends may implement these operations differently. Domain tests run against every supported backend. The TypeScript console's analytical SQL remains Turso-oriented in the first release; portable agent-authored SQL is not a requirement.

## Autonomous operation

A session may carry a persistent goal, completion gate, turn limit, token and cost budget, timeout, and scheduled heartbeats. The supervisor continues prompting the agent until it completes the goal, exhausts a bound, requests help, or fails.

Completion gates are durable requests. A session cannot mark its goal complete until required gates pass against the current workspace version. Failed gate output becomes another event and may trigger refinement after repeated failures.

The UI can attach to any session without becoming its owner. Steering prompts, queued follow-ups, cancellation, and approval decisions enter through the same event protocol as agent messages.

## Permissions and isolation

The first release supports trusted local mode only. Model-generated TypeScript runs in a separate Bun worker process for lifecycle and crash isolation, but it inherits the security boundary of its surrounding environment. The expected deployment runs the complete runtime inside a separately managed remote sandbox. The worker process is not itself a security sandbox.

Secrets are never stored in model-visible tables. A credential broker resolves opaque connection handles at execution time and records which credential class was used.

Raw SQL exposed to the model is read-only by default. Typed SDK commands perform writes. Administrative tables, sync metadata, permissions, and immutable policy are inaccessible from generated code.

Prime Agent makes the same fundamental trust choice: its documentation states that the IPython kernel runs model-generated Python and project commands with the worker's operating-system permissions and is not a security sandbox. This rewrite makes that boundary explicit rather than treating a Bun worker as stronger isolation.

A future isolated mode may place the Bun runtime inside a microVM with explicit filesystem mounts, network policy, resource limits, and a credential broker. The executor contract must leave room for that mode, but the first release does not implement or claim it.

## User surfaces

The initial product is a terminal interface backed by the Bun supervisor. It provides:

- chat with streaming model output;
- expandable TypeScript cells and query results;
- a recursive session tree;
- task and tool activity;
- memory and harness history;
- budget and autonomous-run status;
- branch, fork, resume, compact, refine, and rollback commands;
- sync and conflict status.

The runtime also exposes a typed SDK and a machine-readable streaming protocol. The TUI is one client of that protocol, not the owner of session lifecycle.

## Reactive event interface

The relational event stream supports a public subscription interface as an extension of Prime Agent's session and daemon model. Prime Agent can stream activity to its own clients; this rewrite makes the committed event stream a stable framework boundary that independent user interfaces, automations, and observers can consume.

Each published event carries:

- an opaque ordered cursor for catch-up;
- event ID, type, and schema version;
- session and branch IDs;
- producer identity;
- causation and correlation IDs where applicable;
- commit time;
- a typed payload or an artifact reference.

The supervisor publishes only after the database commit succeeds. Publication is a notification, not the durable record. A subscriber first loads a snapshot and its cursor, then requests events after that cursor and watches for new commits:

```ts
interface AgentEventSource {
  getSnapshot(sessionId: string): Promise<{
    cursor: string;
    state: AgentState;
  }>;

  subscribe(
    sessionId: string,
    afterCursor: string,
    onEvent: (event: AgentEvent) => void,
  ): () => void;
}
```

Delivery is resumable and at least once. Consumers deduplicate by event ID. If the supervisor commits an event and crashes before publishing its notification, a subscriber reconnects with its last cursor and receives the missing event. Events pulled from Turso Cloud pass through the same projection and publication path as events committed locally. Causally related events preserve their order; concurrent events use a deterministic ordering rule during projection.

The core exposes the subscription as an async stream. In-process listeners, WebSocket, server-sent events, and other transports adapt that stream without changing its semantics. The framework has no React dependency.

### Reactive UI projection

A reactive interface can treat agent state like a Redux store:

```ts
const current = subsequentEvents.reduce(reduceAgentState, snapshot.state);
const ui = render(current);
```

The client does not replay the complete history on every render. It loads a materialized snapshot, applies events after the snapshot cursor, and incrementally reduces new events into its local store. A React client can wrap the store with `useSyncExternalStore`; the TUI can consume the same events directly.

Because the source history is immutable and projections are deterministic, the UI can render the agent at an earlier cursor, compare two points in time, inspect the context and harness versions used for a model call, and branch a new session from a historical state. Time travel replays state transitions only. It never repeats shell commands, model calls, file edits, or other external effects.

## Improvements over the reference design

### Recovery becomes reconstruction

Prime Agent recovers JSONL history and kernel snapshots. The rewrite rebuilds every authoritative state from database records. The console can disappear without becoming a data-loss event.

### Memory becomes attributable

Harness memory entries carry scope and content in Prime Agent. The rewrite also records source evidence, confidence, conflicts, activation status, and observed outcomes. A memory can answer why it exists and whether it remains trustworthy.

### Context becomes reproducible

Every model call records the exact context-record versions it received. Compaction and retrieval decisions can be audited and evaluated independently of the model response.

### Multi-agent coordination becomes transactional

Subagent handles and messages become durable tasks, mailboxes, and artifacts. Parents, children, the UI, and recovery workers share one coordination model.

### Self-improvement becomes testable

Refinement separates proposal, candidate activation, observation, and promotion. Expected outcomes no longer stand in for measured outcomes.

### Runtime behavior becomes typed

Tool calls, events, permissions, and transitions use TypeScript schemas shared by the supervisor, console SDK, UI, and extensions. Invalid states should fail at validation or compilation rather than emerge from loosely structured kernel calls.

### Placement does not change the agent model

The same session, memory, artifact, and executor contracts support a private local agent, Turso-synchronized agents, and a later centralized deployment. Moving a component changes latency, availability, and advertised capabilities. It does not create a second kind of agent.

## Delivery slices

### Slice 1: Recoverable single agent

Implement the Bun supervisor, Turso event store, disposable TypeScript console, tagged-template SQL, typed JSON working memory, content-addressed artifacts, model loop, context materializer, shell and file tools, reactive event interface, TUI, branch history, budgets, and crash recovery. Run in trusted local mode against a local database.

### Slice 2: Recursive sessions

Add durable tasks, subagents, mailboxes, concurrent model calls, cancellation, artifacts, and autonomous goals with completion gates.

### Slice 3: Relational memory and refinement

Add scoped memory, full-text retrieval, skills, subagent specifications, refinement proposals, candidate activation, evaluations, scope-sensitive promotion, and rollback.

### Slice 4: Turso Cloud synchronization

Add push/pull lifecycle, multi-writer reconciliation, device identity, cloud session discovery, and conflict surfaces. Test offline work followed by conflicting sync.

### Slice 5: Storage extensions

PostgreSQL remains deferred. Implement it against the domain storage contract and shared conformance suite only when a centralized deployment requires its coordination semantics.

## Acceptance criteria

- A session completes a representative coding task while its TypeScript worker is restarted after every committed console cell, producing the same materialized agent state after each restart.
- No value required by a later cell exists only in the Bun heap. Serializable values survive through the typed state API; larger values survive through artifact references.
- JSON working values at or below 128 KB round-trip with their types intact. Larger values become immutable artifacts, and identical artifact content is stored once.
- Canonical domain history is append-only. Every mutable table is documented as a rebuildable projection, disposable operational cache, lease, or sync structure.
- Killing the supervisor during a model call, tool call, subagent run, and refinement produces no missing or duplicated committed state after recovery.
- A model processes an input larger than its context window by querying chunks and delegating work without importing the full input into one model call.
- Parent and child sessions exchange messages, detach, restart, and continue from the same durable task records.
- Every model response can be traced to the context records and harness versions it received.
- A subscriber can load a snapshot, consume committed events, disconnect, and resume from its cursor without missing state. Duplicate delivery does not change its projection.
- A UI can render a historical cursor and return to the live cursor without repeating external effects.
- Local execution continues without Turso Cloud and synchronizes after reconnect.
- Two local writers can add conversation and tool events concurrently without lost rows. Conflicting task claims are detected and surfaced.
- A refinement can be proposed, activated for a bounded evaluation, promoted or rejected from observed results, and rolled back.
- Generated TypeScript cannot directly mutate canonical tables or read brokered secrets. The runtime identifies trusted local mode plainly and makes no claim that its Bun worker contains hostile code.
- The storage conformance suite contains no Turso SDK types outside the Turso adapter.
- Local and remote implementations of relational state, artifacts, retrieval, and execution pass the same contract tests for shared capabilities. Implementations expose unsupported capabilities instead of silently changing semantics.
- The same retained events and reducer versions produce the same materialized state after process restart and projection rebuild.
- An external effect with an uncertain outcome is surfaced as unknown and is not automatically retried unless its executor proves idempotency.

## References

- Prime Intellect, [“Prime Agent: A self-improving RLM agent”](https://www.primeintellect.ai/blog/prime-agent), August 5, 2026.
- Prime Intellect, [`PrimeIntellect-ai/prime-agent`](https://github.com/PrimeIntellect-ai/prime-agent).
- Alex L. Zhang, Tim Kraska, and Omar Khattab, [“Recursive Language Models”](https://arxiv.org/abs/2512.24601).
- Seth Karten et al., [“Continual Harness: Online Adaptation for Self-Improving Foundation Agents”](https://arxiv.org/abs/2605.09998).
- Turso, [Sync usage](https://docs.turso.tech/sync/usage) and [conflict resolution](https://docs.turso.tech/sync/conflict-resolution).
- Bun, [runtime documentation](https://bun.sh/docs/runtime).

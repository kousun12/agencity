# Best-effort TypeScript console scratch plan

**Status:** Complete for deterministic local verification; external integrations remain unverified
**Date:** August 10, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related plans:** [Agent context and observation efficiency](./2026-08-09-agent-context-efficiency-plan.md), [Formal model tool contracts](./2026-08-07-formal-model-tool-contracts-plan.md), and [Durable tenacious goal orchestration](./2026-08-09-tenacious-goal-orchestration-plan.md)

## Summary

Agencity's TypeScript console currently evaluates every cell as a separate async function. Local variables disappear after the cell, while `state.set` and artifacts provide explicit durable storage. This is recoverable but unnecessarily expensive for replaceable intermediate values that are useful across several nearby cells.

Add a direct `scratch` object to the generated cell environment. Cells on the same exact Agencity session branch reuse one worker-local scratch object while the worker remains alive. Scratch may contain ordinary JavaScript and TypeScript runtime values, including pure functions, classes, cyclic objects, parsed documents, and module objects that do not capture cell-scoped SDK bindings.

After each successful cell commits, Agencity makes an ordinary-getter-free attempt to checkpoint independently serializable scratch properties into an overwriteable local operational cache. Worker serialization has a wall-clock bound; cache storage uses the adapter's existing bounded operation policy. A later worker on the same device may restore that cache. Scratch is never canonical state: it is excluded from events, branch lineage, synchronization, product export, completion evidence, automatic model context, and correctness claims.

The model-facing guidance must distinguish four mechanisms:

- local variables hold values needed only within one cell;
- `scratch` holds replaceable cross-cell intermediates and may disappear;
- `state` and artifacts hold values required for recovery or later durable work;
- the final expression or explicit `return` carries only the smallest observation needed for the next model decision.

Change the managed workspace service's default quiescent shutdown delay from one minute to one hour. This increases the useful lifetime of warm scratch during active work, but it is an operational cache opportunity rather than a retention guarantee.

## Architectural decision

Scratch is a local, bounded, replaceable cache with two layers:

1. **Warm layer:** arbitrary values in one console worker, keyed by exact session and branch.
2. **Cold layer:** a bounded plain-JSON snapshot in a mutable local workspace cache, overwritten after successful cells.

The cold layer uses a private `console_scratch_cache` table behind a separate `ScratchStore` contract. It does not use `WorkingValueSet`, a new canonical event, an artifact, or the general `AgentStorage` contract.

This separation is required:

- canonical events and artifacts are retained indefinitely and participate in export, replay, provenance, and synchronization;
- scratch is intentionally lossy, local, quota-bound, and safe to delete;
- repeatedly checkpointing scratch through canonical events would recreate the storage accretion this capability is intended to avoid;
- extending `AgentStorage` would imply remote placement and recovery guarantees that scratch does not provide.

The local workspace database is the preferred cache placement. A separate database or sidecar file would add another locking, backup, deletion, and discovery lifecycle without improving scratch semantics.

## Goals

- Let generated cells reuse replaceable intermediate values without repeated `state.get` and `state.set` calls.
- Preserve arbitrary runtime values across cells while one worker remains alive.
- Restore bounded plain-JSON scratch values opportunistically after worker or service replacement on the same device.
- Keep scratch isolated by exact session and branch.
- Make known partial restore, corruption, skipped values, and unavailable cache capability visible; report complete loss without retained metadata as cold and unknown.
- Keep scratch out of canonical history, provider context, synchronization, export, gates, and completion evidence.
- Teach the model when to use local variables, scratch, durable state, artifacts, cell history, and final observations.
- Reduce unnecessary final cell results and durable working-state writes.
- Bound persisted scratch by entry, workspace, age, and branch count.
- Recycle an oversized console worker at a terminal cell boundary without changing durable execution semantics.
- Increase the default managed-service idle lifetime to one hour without making console heap state a keep-alive reason.

## Non-goals

- Persistent lexical bindings or notebook-style top-level TypeScript declaration semantics.
- Durable closures, module instances, sockets, subprocess handles, streams, clients, or other live resources.
- Making scratch a source of task ownership, effect idempotency, goal evidence, completion evidence, or recovery correctness.
- Automatic replay of prior cells when a scratch value is unavailable.
- Inheriting scratch through branch forks, child sessions, synchronization, export, or another device.
- Adding scratch data to automatic model context.
- Replacing `state`, artifacts, retained cells, or durable recursive-model handles.
- Making scratch a managed-service keep-alive reason.
- Guaranteeing a hard memory limit for arbitrary trusted-local generated code inside one cell.
- Adding a general cache platform, artifact garbage collector, or state-deletion mechanism.
- Changing the formal provider tool set beyond the existing `bun_console` and `finish` contract.

## Terms

### Scratch scope

One scratch namespace identified by the exact pair `(sessionId, branchId)`. “Branch” means an Agencity durable session-history branch, not a Git branch.

### Warm scratch

The live object held by a console worker. It can contain arbitrary values and retains object identity while that worker and scope survive.

### Scratch checkpoint

A bounded plain-JSON projection of eligible top-level scratch properties. It is an operational cache record, not durable agent state.

### Durable state

Named working values written through `state.set`. Each distinct state name committed by a successful cell appends canonical history and contributes to the branch's current working-state projection.

### Cell observation

The bounded result produced by a cell's final top-level expression or explicit return. It is delivered to the next dependent model step and retained in cell history, but it is not a program variable or a replacement for recoverable state.

## Model-facing usage contract

The generated execution guidance must teach the following order of choice.

### Use a local variable

Use an ordinary `const` or `let` when the value is needed only while the current cell runs. Keep large reads, searches, and tool results local while filtering, aggregating, or transforming them.

```ts
const result = await tools.shell("rg -n \"TODO\" src");
const matches = result.stdout.split("\n").filter(Boolean);
({ count: matches.length, sample: matches.slice(0, 5) })
```

### Use `scratch`

Use scratch for replaceable intermediate values that are useful across nearby cells and can be reacquired or recomputed from durable inputs.

```ts
const result = await tools.shell("rg -n \"TODO\" src");
scratch.todoMatches = result.stdout.split("\n").filter(Boolean);
({ count: scratch.todoMatches.length })
```

Later:

```ts
const matches = scratch.todoMatches;
// Continue processing without another shell effect.
```

Good scratch candidates include parsed source indexes, filtered query results, temporary plans, module objects, and pure helper functions.

Pure functions and classes may be reused only when they do not capture cell-scoped `sdk`, `sql`, `state`, `tools`, `artifacts`, `cells`, `rlm`, `session`, or `console` objects. Those facades are bound to one cell execution. Long-lived clients, timers, streams, sockets, subprocesses, and direct network operations do not belong in scratch; use the typed outbox-backed APIs and retain only reconstructible inputs or durable handles.

Do not use scratch for the only copy of a decision, completion evidence, external-effect identity, user-authored content, an expensive result that cannot be reacquired, or anything required after recovery.

After context compaction, worker replacement, detach/resume, or a long pause, code that benefits from scratch should inspect availability or use a deliberate fallback:

```ts
if (!("repoIndex" in scratch)) {
  const files = await tools.shell("rg --files");
  scratch.repoIndex = files.stdout.split("\n").filter(Boolean);
}
```

Fallbacks must rebuild from durable inputs. They must not blindly replay a prior cell that may have performed non-idempotent effects.

### Use `state`

Use `state` for small JSON checkpoints, decisions, handles, evidence references, and other values required for correct recovery.

State has a permanent cost:

- each distinct state name committed by a successful cell appends one immutable `WorkingValueSet`; repeated writes to that name inside the cell commit only the final staged value, while overwrites across committed cells append history;
- current named values are included in future durable context;
- there is no ordinary state-delete operation;
- canonical history remains until an authorized owned-scope deletion.

The model should therefore:

- use a small, stable set of descriptive keys;
- overwrite a checkpoint key only at meaningful recovery boundaries;
- avoid writing per-step logs, raw tool outputs, temporary caches, repeated summaries, or values already retained in cell history;
- store large durable content in an artifact and keep only its reference in state;
- avoid copying retained cell source or observations into state when `cells.list/get` can retrieve them;
- retrieve effect outputs through their retained effect or artifact path rather than assuming cell history contains output the cell did not observe.

### Use an artifact

Use an artifact for large or byte-oriented content that must remain available. Artifacts are immutable and content-addressed, but they also remain retained and have no general garbage collector. They are not a substitute for disposable scratch data.

### Use the final cell result

The final expression or explicit return should contain only what the model needs to decide the next step: a focused summary, selected slice, count, digest, error, status, or artifact reference.

Do not return:

- a complete tool response merely because it is available;
- the full value just assigned to scratch;
- durable state already available through `state`;
- content already retained in an artifact or prior cell;
- large intermediate arrays or objects that the next model decision does not need.

A bare assignment is an expression and can accidentally become the notebook observation. Cells that place a large value in scratch must end with a compact observation. End with `null` only when the next model decision requires no information from the cell result or its effects:

```ts
scratch.rows = await loadAndParseRows();
({ rows: scratch.rows.length })
```

The cell result remains queryable through cell history, but later generated code cannot access it as a variable without calling `cells.get`. Use scratch or state when a later cell itself needs the value.

Prompt guidance is advisory. IPC, canonical-event, and provider-observation limits remain runtime responsibilities of the context-efficiency work.

## Console API

Every cell receives:

- `scratch`: the direct branch-scoped object;
- `sdk.scratch.status()`: bounded metadata about the live scope and the last restore/checkpoint attempt;
- `sdk.scratch.clear()`: clear the current live scope so the next successful checkpoint removes its cache record.

The direct object is preferred over `scratch.get` and `scratch.set` because the purpose is ergonomic ordinary JavaScript:

```ts
scratch.rows = rows;
scratch.helper = (value: string) => value.trim();
delete scratch.rows;
```

The implementation uses a null-prototype proxy rather than `globalThis`:

- `globalThis` is shared by every branch served by the current worker;
- a branch-keyed proxy prevents accidental cross-branch reuse;
- the proxy can enforce key limits and reject accessors, symbols, and prototype-pollution names;
- branch scoping is behavioral isolation inside trusted local execution, not a hostile-code security boundary.

Initial live limits:

- at most 64 own string keys per scope;
- key length at most 128 UTF-8 bytes;
- no symbol keys;
- no accessor properties;
- no non-configurable properties or extension locks, so `sdk.scratch.clear()` can always empty the scope;
- `__proto__`, `prototype`, and `constructor` are rejected as keys.

Values are otherwise unrestricted while warm. Nested mutation and object identity behave like ordinary JavaScript.

`sdk.scratch.status()` returns bounded metadata, not values:

- scope identity;
- whether the scope is warm, restored, or newly cold;
- live property names and shallow type labels;
- last successful checkpoint time and source cell ID;
- saved and skipped names;
- bounded skip reasons;
- cache availability and applicable limits.

Status metadata must not expose secret values, complete previews, or unbounded error text.

## Worker and execution lifecycle

The current `ConsoleProcess` is owned by one supervisor and may serve several sessions and branches. Retain that process model for this work.

Add one supervisor-owned process lifecycle queue around the shared console. It serializes, across every branch served by that process:

1. exact-key cache load and scope preparation;
2. cell execution;
3. canonical `CellCommitted` or `CellFailed` terminalization;
4. post-commit checkpoint request and local cache update when applicable;
5. scope eviction or worker recycling.

The existing per-branch queue remains responsible for branch order. The process lifecycle queue ensures that no second branch has a queued or in-flight worker execution when the first branch decides to stop or replace the shared process.

The worker maintains a bounded map keyed by exact `(sessionId, branchId)`. On execution:

1. The supervisor loads a checkpoint only when the exact scope is cold.
2. The worker creates the scope and deep-clones eligible cached JSON into it.
3. Cached skipped-name metadata is retained so known unavailable values can produce a useful error.
4. The async cell receives the same live object used by earlier cells in that warm scope.
5. Cell execution returns its ordinary observation, logs, and RSS metadata without traversing scratch.
6. The supervisor commits the canonical terminal cell event.
7. If the cell committed successfully, the supervisor issues a separate exact-scope checkpoint IPC request with a 500 ms wall-clock deadline.
8. The worker attempts bounded serialization and returns a candidate without writing storage.
9. The supervisor applies secret checks and conditionally replaces the local cache row.
10. Cache failure or timeout does not alter the committed cell outcome. A timeout causes worker recycling after the commit.
11. Restart-after-every-cell mode stops the worker only after the cache attempt.

If execution fails, is abandoned, or cannot commit its terminal event, the runtime evicts that exact warm scope before releasing the process lifecycle queue. A later cell may restore only the previous completed cold checkpoint. If exact-scope eviction cannot be confirmed, the runtime recycles the worker. This prevents partial failed-cell mutation from silently becoming the next cell's supported scratch state.

Runtime cache mutations are awaited inside this queue and never continue as detached writes. They carry the current managed process execution-fence proof; losing the fence makes an old process's cache mutation fail. The lifecycle queue prevents stale same-process writes, while the fence prevents stale cross-process writes after expiry, LRU eviction, clear, or ownership transfer.

Cell-bound RPC requests whose execution is no longer active must receive a prompt typed failure. The parent process must not ignore a stale request and leave a retained helper waiting forever.

The worker keeps at most 16 warm branch scopes. Before and after cell execution it evicts least-recently-used scopes that exceed that count or have been idle for one hour. Eviction drops arbitrary live-only values; the latest completed checkpoint remains the only possible restoration source.

The worker reports its resident-set size after each successfully reported terminal execution. When RSS exceeds a 512 MiB soft threshold, the supervisor first commits `CellCommitted` or `CellFailed`, performs the scratch-cache attempt when the cell succeeded, and then recycles the entire worker. The threshold is injectable for tests, the recycle reason is exposed through bounded operational status when available, and a fresh worker must not enter an immediate recycle loop under ordinary baseline RSS. This is a boundary-time reclamation mechanism, not a hostile-code memory limit: one cell may still allocate memory faster than the runtime can respond.

Console-worker existence and scratch contents never become managed-service keep-alive reasons.

## Checkpoint serialization

Checkpointing is independent per top-level property so one unsupported value does not hide eligible siblings.

The serializer:

- reads ordinary own property descriptors without invoking ordinary getters;
- never deliberately calls `toJSON`, custom iterators, or user serialization hooks;
- accepts only finite, acyclic, plain JSON values;
- sorts property names for deterministic encoding and digest calculation;
- applies depth, visited-node, property-count, per-value byte, and total-byte limits;
- checks known credential values and credential-shaped content before persistence;
- returns bounded reason codes rather than retaining raw serialization exceptions.

JavaScript proxy internal methods can run during reflection and cannot be reliably detected or interrupted inside the same realm. The supervisor's 500 ms post-commit deadline is the outer bound: on timeout it terminates the worker and preserves the prior cold checkpoint. The current supervisor reports the failed attempt on later status when that operational metadata remains available; after complete process loss the scope is simply cold or unknown. Scratch serialization is not a side-effect isolation boundary.

Initial checkpoint limits:

- at most 64 saved properties;
- at most 128 KiB canonical JSON per property;
- at most 256 KiB canonical JSON for one branch checkpoint;
- at most 10,000 visited nodes;
- maximum nested depth 32;
- at most 64 bounded skipped-property records.

Closed skip reasons include:

- `unsupported_type`;
- `cyclic`;
- `accessor`;
- `depth_limit`;
- `node_limit`;
- `property_limit`;
- `value_too_large`;
- `checkpoint_too_large`;
- `secret_rejected`.

If the latest value of a property is skipped, that name is omitted from the new checkpoint. Agencity must not restore an older value under the same name because doing so would silently revive stale state.

If scratch is empty, a successful checkpoint removes the prior cache record. If scratch is nonempty but no property is eligible, Agencity writes a bounded metadata-only checkpoint so a later restore can identify known unavailable names without reviving stale values. If serialization cannot safely produce a candidate at all, the prior record remains untouched and status reports that the latest live scope is not represented by it.

## Local scratch store

Add a private `ScratchStore` capability implemented by file-local LibSQL storage but kept outside `AgentStorage` and every HTTP-backed relational placement contract. Product composition injects it explicitly only when the canonical workspace database uses a local `file:` placement. It is never inferred through `instanceof`, hidden inside the fenced `AgentStorage` wrapper, created for a network URL, or used as a silent local fallback for remote placement.

Every ordinary runtime mutation requires the current `ProcessExecutionWriteFence` and validates that proof in the same storage transaction. Administrative owned-scope erasure remains a separate quiescence-checked path.

The next available numbered workspace migration adds `console_scratch_cache` with:

- `session_id` and `branch_id` as the composite primary key;
- originating durable device ID;
- checkpoint schema version;
- canonical checkpoint JSON, content digest, and full-row integrity digest;
- byte length;
- source committed cell ID, terminal event ID, and branch cursor;
- saved-name and skipped-reason metadata;
- creation, update, access, and expiry timestamps.

The table must not have a foreign key to rebuildable `sessions` or `branches` rows. Projection rebuild deletes and recreates those rows, while the replaceable scratch cache may survive independently. Store operations still validate that the exact session and branch exist before load or write.

Initial store policy:

- seven-day expiry from the latest successful checkpoint;
- at most 64 branch records per workspace;
- at most 16 MiB total encoded row bytes per workspace, including bounded metadata;
- least-recently-used eviction before an upsert would exceed either workspace cap;
- the content digest covers saved values and skipped metadata;
- the full-row integrity digest also covers schema version, device identity, source event identity, cursor, timestamps with retained meaning, and encoded byte length;
- exact digest and byte-length verification on load;
- load requires an exact current-device match; mismatched rows are ignored and may be pruned;
- every replacement or source-driven removal requires an exact committed source event for the same scope and requires that event to be the latest direct-branch `CellCommitted` event at transaction time;
- when a row exists, its source cursor must also be newer than the retained source cursor; older or equal candidates are no-ops;
- runtime writes, clears, expiry pruning, and LRU eviction require a current execution fence and never continue detached after the process lifecycle queue advances;
- corrupt rows are discarded and reported as unavailable;
- unchanged content digests avoid rewriting payload bytes while still advancing newer source metadata and the full-row integrity digest;
- expired rows are never restored and are pruned opportunistically during fenced load and upsert operations;
- expiry, pruning, corruption, lock contention, and unavailable placement never fail a cell.

The table is classified as an `operational-projection` in `docs/mutable-tables.md`. It is:

- safe to delete;
- excluded from generated analytical SQL;
- excluded from canonical projection rebuild;
- excluded from synchronization envelopes;
- excluded from product export and import guarantees;
- removed by independent-session physical erasure;
- removed with the workspace database during workspace deletion.

A raw database backup may incidentally contain cache rows, but public backup and restore behavior must not promise scratch restoration. Logical deletion and pruning do not promise immediate byte erasure from SQLite free pages, WAL files, raw backups, or filesystem recovery media; those bytes follow the existing database and storage lifecycle.

## Branching, sessions, placement, and synchronization

Scratch uses direct exact-key lookup and never branch-lineage lookup.

- A new branch fork starts cold even when its parent has warm or cached scratch.
- A child session starts with its own exact branch scope.
- Scratch namespaces and restored checkpoint objects are never automatically aliased across siblings or unrelated sessions.
- Returning to the exact branch may restore that branch's local checkpoint.
- A synchronized copy on another device starts cold.
- Remote relational placement without a local `ScratchStore` supports warm scratch only and reports cold restoration as unavailable.
- Product export/import does not transfer scratch.

Generated code can still use `globalThis`, imported module singletons, or deliberate reference transfer inside the shared trusted-local realm. Scratch scoping is the supported behavioral contract, not complete object-reference isolation or a security boundary. Any value that must intentionally cross a fork, session boundary, placement, or device must use state, artifacts, documents, input sets, or messages.

## Missing values and recovery

Ordinary unknown scratch keys behave like missing object properties. A name recorded as skipped from a restored checkpoint throws a typed `ScratchBindingUnavailableError` when read directly. The error includes only:

- the property name;
- the last checkpoint cell ID when known;
- a bounded reason code;
- guidance to inspect `sdk.scratch.status()` and rebuild from durable inputs.

When no retained metadata exists—such as a crash before the first checkpoint, prior LRU eviction, cache deletion, another device, or unsupported placement—status reports a cold or unavailable scope. It does not claim which names previously existed.

Recovery follows this order:

1. Use the warm value when present.
2. Restore the latest valid exact-branch local checkpoint when available.
3. Reacquire or recompute a missing replaceable value from durable state, artifacts, files, retained cells, or idempotent effects.
4. Stop with a visible blocked, failed, or unknown outcome when reconstruction would require unsafe replay or unavailable evidence.

The runtime never automatically re-executes retained cell source. A retained cell can contain external effects whose repetition is unsafe even when its final value looked cache-like.

## Context compaction

Narrative context compaction and scratch lifecycle remain independent.

- Compaction does not serialize, clear, restore, or extend scratch.
- Scratch payloads and inventories are not automatically inserted into model context.
- The execution-guidance component remains present after compaction and continues to explain scratch semantics.
- A model that needs to know current scratch availability uses a cell and `sdk.scratch.status()` or checks the required key.
- Compaction summaries should retain the name and reconstruction source of important replaceable intermediates only when relevant to continuing the task; they must not claim that the values are durable.

This avoids turning an optimization into an ever-growing context manifest.

## Managed-service idle lifetime

Change `DEFAULT_MANAGED_SERVICE_IDLE_SHUTDOWN_MS` from `60_000` to `3_600_000`.

This is an intentional local resource tradeoff for multi-step and detached tasks: a quiescent service may retain its loopback listener, database handles, credential broker, console process, and arbitrary warm heap for up to sixty times longer. The one-hour bound remains finite, visible in status, and subordinate to explicit shutdown.

The meaning remains “one hour after the workspace service becomes quiescent,” not:

- a task timeout;
- a minimum scratch-retention promise;
- permission to stop active work;
- a reason to keep an idle console worker alive forever.

Existing keep-alive reasons remain authoritative: attached clients, resident managed run-queue work, active runs, pending effects, queued wakes, active schedules, and active heartbeats. `resident_workers` means active managed run-queue work, not the mere existence of a `ConsoleProcess`. A terminal blocked run and warm scratch do not keep the service resident.

Keep short `idleShutdownMs` overrides for deterministic lifecycle tests. Preserve the current inclusion of the normalized timeout in the service configuration hash. When old and new binaries both omit the override, their normalized hashes differ deterministically. The upgraded client reports `CONFIG_MISMATCH`, does not take ownership, and does not delete discovery state. The operator waits for the old 60-second owner to exit or uses the matching old binary for authenticated shutdown; a new client starts normally after the old owner has exited.

Human-readable service status should render the default as one hour while retaining exact milliseconds in typed and JSON output.

## Security and authority

Scratch does not change Agencity's trusted-local security boundary.

- Generated code can already consume process memory and exercise the worker's OS authority.
- Branch-keyed scratch prevents accidental supported-API reuse, not malicious cross-branch access by hostile code.
- Provider credentials remain absent from the worker environment.
- Known credential values and credential-shaped strings are rejected from cold checkpoints.
- Rejected values, serialization errors, and status metadata must never print secret content.
- JavaScript proxies can intercept reflective operations and cannot be reliably identified before inspection. The supervisor bounds the attempt by terminating a timed-out worker; checkpointing is not a side-effect isolation boundary.
- The cache table is private to the storage adapter and unavailable through model-generated SQL.
- Scratch never grants runtime authority or widens file, shell, network, model, budget, scope, or publication permissions.

## Implementation sequence

### Phase A — Freeze semantics and prompt doctrine

- Add the public scratch types and worker/supervisor contracts.
- Add deterministic serializer and proxy tests before wiring persistence.
- Change the immutable base-policy rule from persisting every cross-cell value to persisting every value required after recovery, and increment its version.
- Prepare autonomous execution guidance with the local/scratch/state/artifact/result decision rules; activate scratch-specific guidance atomically with the Phase B cell global and SDK surface.
- Increment the execution-guidance prompt-component version.
- Keep the formal provider tools at `bun_console` and `finish`; do not create a provider-level scratch tool.
- Update examples and deterministic model fixtures that currently return complete tool responses unnecessarily.

### Phase B — Add warm branch-scoped scratch

- Maintain exact session/branch scopes in `src/console/worker.ts`.
- Add a supervisor process lifecycle queue spanning execution, canonical terminalization, checkpointing, and recycling across all branches.
- Inject direct `scratch` and `sdk.scratch`.
- Add bounded status, clear, key-policy, LRU, idle-eviction, and typed unavailable behavior.
- Make stale cell-bound RPC requests fail promptly.
- Evict the exact warm scope after failed, abandoned, or uncommitted execution.
- Extend worker IPC validation without placing arbitrary live values on IPC.
- Report worker RSS and recycle above the post-terminal soft threshold.
- Preserve ordinary execution when scratch is unused.

### Phase C — Add bounded local checkpoints

- Add the private `ScratchStore` contract and local LibSQL implementation.
- Add the next numbered migration and table-classification registry entry.
- Inject the capability only for an exact file-local workspace placement and current device.
- Load only an exact branch key when creating a cold worker scope.
- Request checkpoint candidates through separate time-bounded worker IPC only after canonical `CellCommitted` succeeds.
- Apply supervisor-side secret rejection and source-event/device validation.
- Replace or remove the cache with a newer-cursor conditional write.
- Add TTL, workspace quota, branch-count quota, digest verification, corruption discard, and LRU eviction.
- Keep local cache failures nonfatal and visible through later status.
- Add independent-session erasure and workspace-deletion coverage.

### Phase D — Extend service lifetime and product documentation

- Change the default quiescent timeout to one hour.
- Preserve short internal test overrides and current keep-alive semantics.
- Add service configuration-hash mismatch coverage for the old and new defaults.
- Improve human-readable status duration formatting.
- Update `AGENTS.md`, Console SDK, operator, recovery, security, placement, data-lifecycle, glossary, capability, and verification documentation.
- Add an installed-product path that uses scratch across cells, detaches, resumes, and truthfully recovers or rebuilds after worker loss.

## Primary implementation surface

Expected source changes include:

- `src/console/worker.ts` — branch-keyed scopes, proxy, serializer, status, and checkpoint candidate;
- `src/console/process.ts` — scope preparation/drop, separate checkpoint IPC, stale-RPC failure, validated status output, and RSS metadata;
- `src/console/inspect.ts` or a focused sibling module — shared getter-free bounded traversal;
- `src/console/sdk.ts` — `ScratchSdk`, status types, and direct global typing;
- `src/runtime/supervisor.ts` — process lifecycle queue, exact-key restore, post-commit checkpoint/cache write, failed-scope eviction, cache failure handling, and recycle policy;
- `src/runtime/context.ts` — versioned base-policy recovery wording;
- `src/runtime/agent-runs.ts` — execution guidance and prompt-component version;
- `src/storage/scratch.ts` — private local cache contract;
- `src/storage/libsql.ts` — local implementation, migration registration, pruning, and erasure;
- `src/storage/migrations/` — next numbered `console_scratch_cache` migration;
- `src/product/` runtime composition — inject scratch storage only for an exact file-local workspace placement;
- `src/product/service.ts` — one-hour default;
- `src/cli.ts` — human-readable idle duration;
- `scripts/check-architecture.ts` and `docs/mutable-tables.md` — table classification and private-surface enforcement.

No scratch feature should require changes to:

- canonical domain event schemas or reducers;
- `AgentState` projections;
- synchronization envelopes;
- the provider tool cardinality or action protocol;
- completion gates;
- context compaction records;
- public remote relational placement contracts.

## Verification

### Unit coverage

- direct property set, read, mutation, delete, and clear;
- `const` and lexical bindings remain cell-local;
- null-prototype and reserved-key behavior;
- key-count and key-size limits;
- independent serialization of plain JSON siblings beside functions, classes, cycles, getters, and oversized values;
- deterministic key ordering, digest, byte count, depth limit, and node limit;
- no ordinary getter, iterator, or `toJSON` invocation;
- adversarial proxy timeout terminates the post-commit worker without changing the cell outcome;
- secret rejection without value disclosure;
- bounded status and typed unavailable errors;
- exact immutable base-policy text and version;
- exact execution-guidance text and prompt-component version.

### Console integration coverage

- ordinary object identity and pure functions survive across cells in one warm exact branch;
- separate branches and sessions receive distinct scratch namespaces and restored clones;
- a branch fork starts cold;
- restart-after-every-cell restores eligible JSON;
- nonserializable values work warm and disappear visibly after restart;
- a retained helper that captures an expired cell RPC facade fails promptly rather than hanging;
- an updated skipped property never restores an older stale value;
- failed, abandoned, and terminal-commit-failed cells evict their warm scope and do not update the cold checkpoint;
- cache write failure does not fail `CellCommitted`;
- a process-wide lifecycle queue prevents one branch's recycle decision from terminating another branch's execution;
- a process exit restores the latest completed checkpoint without replaying cells;
- scope-count and idle eviction preserve only eligible cold data;
- RSS threshold recycling occurs only after the canonical terminal boundary and any applicable cache attempt;
- scratch assignments end with compact observations in model-facing fixtures.

### Storage and lifecycle coverage

- migration open and reopen are idempotent;
- exact-key load never follows branch lineage;
- a mismatched device never restores a local checkpoint;
- an expired or lost execution fence cannot mutate scratch cache rows;
- digest and byte-length mismatch discard corrupt rows;
- older or equal source cursors cannot replace a newer checkpoint;
- stale writes cannot resurrect a checkpoint after clear, expiry, or LRU deletion;
- unchanged snapshots avoid payload rewrites;
- expiry and LRU enforce branch-count and byte quotas;
- operational projection rebuild neither needs nor recreates scratch;
- synchronization and product export omit scratch;
- independent-session erasure removes exact scratch rows;
- workspace deletion removes the containing cache;
- remote placement reports cold scratch unavailable without local fallback.

### Managed-service coverage

- the default status reports `3_600_000` milliseconds and an approximately one-hour deadline;
- detached child startup preserves the default;
- short test overrides still stop quiescent services and release leases;
- active keep-alive reasons continue to defer shutdown;
- warm scratch alone does not defer shutdown;
- shutdown stops the console worker;
- old-default and new-default configurations produce the deliberate compatibility mismatch without ownership takeover;
- the new client starts normally after the old owner exits.

### Recovery and product coverage

- crash after cell start but before canonical commit restores only the prior checkpoint;
- crash after canonical commit but before cache replacement may restore the prior checkpoint or a cold scope without claiming which newer values were lost;
- crash after cache replacement restores the new eligible values;
- unavailable scratch leads to deliberate reconstruction from durable inputs;
- no recovery path automatically repeats an external effect;
- context compaction neither includes scratch payloads nor claims scratch durability;
- installed linked-executable acceptance demonstrates compact final observations, bounded state use, warm scratch reuse, and truthful cold recovery.

Run the narrow focused suites during implementation, followed by:

```sh
bun run typecheck
bun run check:architecture
bun test --timeout 30000
bun run test:acceptance:matrix
```

External provider, official Turso, and Turso Cloud checks remain separately gated and must be reported as passed, failed, or skipped.

## Completion criteria

This plan is complete when:

1. cells on one exact session branch can reuse arbitrary scratch values while a worker remains warm;
2. branches, forks, and sessions receive distinct supported scratch namespaces, and cold checkpoints require an exact device and branch;
3. bounded eligible JSON restores opportunistically from a private local cache after worker or service replacement;
4. known partial restore, corruption, unsupported placement, and skipped values remain explicit, while complete unrecorded loss is reported as cold or unknown;
5. scratch payloads do not enter canonical events, state projections, sync, product export, gates, or automatic context;
6. failed or uncommitted cells evict their warm scope, and crash boundaries cannot manufacture a newer cold checkpoint;
7. persisted scratch obeys entry, branch-count, workspace-byte, and expiry limits;
8. oversized warm workers are recycled after canonical cell terminalization and any applicable cache attempt without claiming an in-cell hard memory limit;
9. the effective model prompt clearly distinguishes locals, scratch, state, artifacts, cell history, and final observations;
10. state guidance explains permanent event-history accretion and discourages transient or repetitive writes;
11. the default managed-service quiescent timeout is one hour while scratch remains a non-keep-alive cache;
12. public documentation, `AGENTS.md`, architecture checks, recovery tests, and installed-product acceptance match the implemented behavior.

## Implementation log

### 2026-08-11 — Warm branch-scoped scratch
- Completed: Added the direct branch-scoped `scratch` object, `sdk.scratch` status and clear controls, bounded getter-free checkpoint serialization, exact-scope preparation and eviction, a process-wide lifecycle queue, prompt guidance, stale-RPC failures, post-terminal RSS recycling, and focused unit and integration coverage.
- Validation: `bun run typecheck`, `bun run check:architecture`, `git diff --check`, and 33 focused scratch and console tests passed.
- Plan notes: Checkpoint node and property budgets apply across the complete candidate. Persistence-hook failures remain nonfatal and preserve warm scratch; unsafe worker checkpoint timeout recycles the worker.
- Remaining: Local checkpoint persistence, managed-service lifetime, public documentation, installed-product coverage, aggregate verification, and external gated checks.

### 2026-08-11 — Bounded local scratch checkpoints
- Completed: Added migration 020 and the private file-local `ScratchStore`, exact managed-product injection, current-device exact-branch restoration, transactional source/fence validation, content and full-row integrity checks, expiry and LRU quotas, explicit cold/unavailable/corrupt load results, private SQL exclusion, and owned-scope deletion behavior.
- Validation: Focused scratch storage, migration, managed fencing, recovery, console, placement, and data-control tests pass together with typecheck, architecture checking, and diff checking.
- Plan notes: Cold persistence is enabled only when exact file-local composition also has managed execution-fence authority. Direct diagnostic supervisors and remote placements remain warm-only rather than receiving an unfenced or fallback cache.
- Remaining: Managed-service lifetime, broader public documentation, installed-product coverage, aggregate verification, and external gated checks.

### 2026-08-11 — Managed-service lifetime and installed product
- Completed: Changed the normalized managed-service default to 3,600,000 milliseconds; preserved short overrides, keep-alive rules, and timeout-sensitive configuration hashing; added one-hour human status formatting with exact typed/JSON milliseconds; covered former/current default mismatch, detached child startup, active and scratch-only idle behavior, and worker shutdown; updated the repository guide and public Console SDK, operator, recovery, security, placement, data-lifecycle, glossary, capability, verification, README, user, configuration, architecture, API, protocol, and event references.
- Installed product: Added an isolated linked-executable journey with compact cell observations, one bounded durable-state key, exact-branch warm object/function reuse, detached admission and no-ID resume, explicit service loss, same-device eligible JSON restoration, and deliberate rebuilding of a warm-only helper from durable input.
- Validation: The complete managed-service integration file passed 20 tests, the product CLI integration file passed 16 tests, and the complete primary installed acceptance file passed 3 tests. Typecheck, architecture checking, and final diff checking passed.
- Plan notes: The old-binary mismatch is represented by the exact former normalized 60,000-millisecond configuration because discovery hashes serialized normalized values. Warm scratch and a running but idle console process remain non-keep-alive state. Human formatting changes only CLI text; protocol and JSON shapes retain exact milliseconds.
- Aggregate validation: `bun run verify` passed with 981 core tests, 3 end-to-end tests, and 17 acceptance tests; 2 core external tests and 1 acceptance external test skipped. `bun run test:acceptance:matrix` passed its deterministic matrix.
- Remaining: Live-provider, official Turso Sync, and Turso Cloud checks remain gated, skipped, and unverified.

### 2026-08-11 — Independent final review
- Corrected: Scratch now rejects non-configurable properties and extension locks so the documented clear operation cannot leave undeletable warm values.
- Corrected: Supervisor-side checkpoint filtering rejects credential-shaped content as well as registered credential values, and omits secret-bearing property names from checkpoint metadata.
- Corrected: Known skipped-binding metadata now survives later successful checkpoints until the binding is rebuilt, deleted, or cleared.
- Validation: Focused scratch unit, console integration, and scratch-store integration suites passed 40 tests; typecheck, architecture checking, and diff checking passed.

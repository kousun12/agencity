# Protocol and console SDK

Agencity has two distinct protocols in Slice 1:

1. a loopback HTTP/JSON + server-sent-event interface for external clients;
2. a private Bun IPC channel between the supervisor and disposable console worker, separate from stdout/stderr.

Neither protocol is an authentication or sandbox boundary.

## HTTP server

Ordinary product commands discover or start a per-workspace `ManagedWorkspaceService` on demand. It binds an ephemeral `127.0.0.1` port, publishes an owner-only manifest, and requires `Authorization: Bearer …` on every route, including `/health` and SSE. The token is read from the 0600 manifest and is never passed in argv or printed. Authenticated health returns workspace/service identity, application and protocol versions, and the secret-free configuration hash used during discovery.

`bun run src/cli.ts debug protocol-serve --port 3131` remains an advanced embedded diagnostic. It binds `127.0.0.1` but intentionally has no bearer/discovery/process-lease lifecycle. Exposing either server beyond loopback is unsupported without an independently authenticated boundary.

All successful non-streaming responses are JSON. Failures use the typed, scrubbed shape `{ "error": { "code", "message", "details" } }`; domain errors map to 400/404/409/424/501, unexpected failures use HTTP 500 and code `INTERNAL`, and unknown routes use HTTP 404. `AgentClient` raises the same `ProtocolClientError { code, status, details }` through HTTP and in-process transports.

### Endpoints

| Method and path | Input | Result |
|---|---|---|
| `GET /health` | none | authenticated managed identity/version/config health (or basic embedded health) |
| `GET /capabilities` | none | v1 trusted-local, snapshot/resume, progress, historical projection, sync, service/catalog, and provider capability descriptor |
| `GET /service/status` | none | managed lifecycle, recovery, and resident-root worker states |
| `POST /service/shutdown` | none | accepted graceful drain; it does not cancel sessions |
| `GET /service/agents` | none | named root sessions and running/idle/detached state |
| `POST /sessions/:session/stop?branch=:branch` | `{ reason? }` | durable user-requested active-run cancellation |
| `GET /model-providers` | none | secret-free provider descriptors with truthful `capabilities.streaming` |
| `POST /sessions` | `{ workspaceId?, model?, budget? }` | `{ sessionId, branchId }` |
| `GET /sessions/:session/snapshot?branch=:branch` | none | `{ cursor, state }` |
| `GET /sessions/:session/history?branch=:branch` | none | ordered `AgentEvent[]` including branch lineage |
| `GET /sessions/:session/recovery-summary?branch=:branch` | none | pending/unknown effects, active/cancelling runs and children, gate attention, and terminal notices |
| `GET /sessions/:session/effects/unknown?branch=:branch` | none | unknown effects plus append-only assessments and safe actions (`retryAllowed: false`) |
| `GET /sessions/:session/effects/:effect/reconciliation?branch=:branch` | none | one unknown effect and its assessment history |
| `POST /sessions/:session/effects/:effect/reconciliation?branch=:branch` | `{ reconciliationId?, assessment, summary, evidence?, recordedBy }` | append-only evidence; effect stays unknown and `retried` is false |
| `GET /sessions/:session/stream?branch=:branch&after=:cursor` | none | `text/event-stream` committed events plus cursorless ephemeral progress |
| `POST /sessions/:session/messages?branch=:branch` | `{ content }` | committed user `AgentEvent` |
| `POST /sessions/:session/runs?branch=:branch` | `{ task, requestKey?, goalMode?, goalId? }` | managed: durable `202 accepted` with run ID/cursor and resident advancement; embedded: advances through terminal or waiting boundary |
| `GET /sessions/:session/runs/:run?branch=:branch` | none | current durable `AgentRunResult` |
| `POST /sessions/:session/runs/:run/resume?branch=:branch` | none | resumed `AgentRunResult` |
| `POST /sessions/:session/runs/:run/input/:request?branch=:branch` | `{ response, approved? }` | continued result; permission requires explicit boolean `approved` |
| `POST /sessions/:session/runs/:run/cancel?branch=:branch` | `{ reason? }` | cancellation-reconciled result |
| `POST /sessions/:session/turns?branch=:branch` | none | advanced diagnostic `{ outcome, message? or error? }` |
| `POST /sessions/:session/cells?branch=:branch` | `{ code }` | `{ cellId, result, logs }` |
| `POST /sessions/:session/branches?branch=:parent` | `{ cursor, name? }` | `{ branchId }` |
| `GET/POST /sessions/:session/agents?branch=:branch` | none or `SpawnAgentInput` | nuclear-family roster or durable child handle |
| `POST /sessions/:session/agents/batch?branch=:branch` | `{ inputs: SpawnAgentInput[] }` | atomically admitted child handles |
| `POST /sessions/:session/agents/:target/follow-up?branch=:branch` | `{ content, taskId?, artifactIds?, intentKey? }` | retained same-session follow-up receipt |
| `POST /sessions/:session/agents/:target/cancel?branch=:branch` | `{ reason? }` | direct-child task or active-run cancellation result |
| `GET /sessions/:session/tasks?branch=:branch` | none | durable branch task records |
| `POST /sessions/:session/tasks/:task/cancel?branch=:branch` | `{ reason? }` | cascaded terminal task record |
| `GET /sessions/:session/mailbox?branch=:branch&direction=all&limit=20&before=:cursor&pending=1` | none | bounded receipt-rich page and next cursor |
| `POST /sessions/:session/mailbox?branch=:branch` | `SendMessageInput` | stable durable delivery receipt |
| `POST /sessions/:session/mailbox/:message/ack?branch=:branch` | none | acknowledged mailbox record |
| `POST /sessions/:session/documents?branch=:branch` | `ImportDocumentInput` | document handle |
| `POST /sessions/:session/input-sets?branch=:branch` | `CreateInputSetInput` | exact ordered input-set handle |
| `POST /sessions/:session/models?branch=:branch` | `StartRecursiveModelInput` (`idempotencyKey` recommended for retry) | stable recursive model handle |
| `GET /models/:handle` / `POST /models/:handle/cancel` | none or `{ reason? }` | current/terminal model handle |
| `GET/POST /sessions/:session/goals?branch=:branch` | none or `CreateGoalInput` | goal list or created goal plus gates |
| `GET /sessions/:session/goals/current?branch=:branch` | none | current user-authoritative goal or null |
| `GET /sessions/:session/goals/:goal[/evaluations]?branch=:branch` | optional `gate` query | scoped goal or retained gate-evaluation history |
| `POST /sessions/:session/goals/:goal/(completion|continue|pause|resume|clear)?branch=:branch` | operation-specific optional reason/bound | gate-checked or lifecycle-updated goal |
| `GET/POST /sessions/:session/heartbeats?branch=:branch` | none or `CreateHeartbeatInput` | scoped heartbeat list or created user heartbeat |
| `POST /heartbeats/:id/(tick|pause|resume|clear)` | `{ at? }`, `{ nextTickAt? }`, or `{ reason? }` | updated heartbeat handle |
| `GET/POST /sessions/:session/schedules?branch=:branch` | none or `CreateScheduleInput` | scoped one-time/interval schedules or created user schedule |
| `GET /sessions/:session/schedules/wakes?branch=:branch&status=...` | none | durable queued/claimed/delivered/unknown wake records |
| `POST /schedules/:id/(tick|pause|resume|clear)` | operation-specific time/reason | updated schedule handle |
| `GET /sync/status` | none | capabilities, persisted replica lifecycle, unresolved conflicts, quarantine count |
| `POST /sync` / `POST /sync/reconnect` | none | manual/reconnect cycle (`stage → push → pull → ingest → checkpoint` for the official adapter) |
| `POST /sync/push` | none | staged count, official post-push stats, and status |
| `POST /sync/pull` | none | official pull-change flag, ingestion result, stats, and status |
| `POST /sync/checkpoint` | none | official checkpoint result and stats |
| `GET /sync/stats` | none | official local CDC/WAL/revision/network statistics |
| `GET /sync/conflicts?status=unresolved|resolved` | none | attributable reconciliation records |
| `POST /sync/conflicts/:id/resolve` | `ResolveConflictInput` | explicit durable `SyncConflictResolved` result |
| `GET /sync/workspaces?refresh=1` | none | replicated workspace announcements (`refresh` invokes a real pull first) |
| `POST /sync/manifests` | `{ operation, scopeKind, scopeId, requestedBy }` | ownership-aware resource/replica manifest |
| `POST /sync/export` | `{ destination, scopeKind, scopeId, requestedBy }` | inspectable events/profile/replica-envelope/artifact bundle plus completed/partial manifest |

For snapshot/history/stream, the branch may alternatively occupy the fourth path segment, but the query parameter is the documented form. Slice 2 commands require `?branch=`. Family targets are URL-decoded and resolve only within the caller's parent/direct-child/sibling roster; sender identity is the path session/branch and body aliases cannot replace it. Mailbox pages sort newest-first by committed send time plus stable ID, use opaque base64url cursors, and report `queued`, `delivered_to_context`, `acknowledged`, or `failed` receipts with relationship/name/task/artifact/reply provenance. A rejected request returns the ordinary typed protocol error and commits no mailbox row.

Mailbox family/task/artifact authorization, UTF-8/rate/pending bounds, document scope, spent-plus-active tree budgets, recoverable cancellation propagation, durable goal workspace pins, shared provider concurrency, and early-heartbeat rejection are enforced by the same domain services used in-process; transport routing does not weaken them. Domain/storage validation remains authoritative.

### Contract-identical transports

`HttpProtocolTransport` sends loopback requests and owner bearer headers. `InProcessProtocolTransport` constructs a standard `Request` and invokes the same public `ProtocolServer.handle` router; it is not a private `Supervisor` adapter. A shared conformance suite covers JSON bodies, capabilities, typed failures, snapshots/history, and unknown-effect routes through both transports. Body detection uses `request.body`, because an in-process `Request` has no transport-generated content-length header.

`AgentClient.watchBranch` performs snapshot-then-stream, applies committed callbacks serially, advances its reconnect cursor only after a handler successfully applies the event, ignores duplicate/older cursors, and reconnects from that cursor. Cursorless progress is temporary: it is discarded on a committed effect outcome, disconnect, or reconnect and is never replayed as history.

### Snapshot then SSE

A correct consumer:

1. calls `GET .../snapshot?branch=B` and renders the returned `state`;
2. stores its opaque decimal-string `cursor` without converting it to a JavaScript `number`;
3. connects to `GET .../stream?branch=B&after=<cursor>`;
4. for each default SSE message, parses `data` as an `AgentEvent`, ignores event IDs already applied, reduces it, and persists the new cursor;
5. optionally renders `event: progress` items as temporary UI state without reducing or persisting them;
6. reconnects with the last applied committed cursor after any disconnect and clears temporary progress.

A committed SSE item uses the cursor as `id:` and the full event JSON as `data:`. Publication happens after commit. Commit callbacks only wake the server; catch-up reads from storage, so a crash between commit and notification does not lose state. Delivery should be treated as at least once. Causally inherited branch events and branch-local events use database cursor order.

Streaming model output uses a distinct `event: progress` frame whose JSON data is an `EffectProgressNotification`. It deliberately has no `id:` or durable cursor. It is delivered only to currently attached clients, is not replayed during catch-up, and may be bounded or dropped. For a diagnostic text turn, a client may display `model-output-delta` text provisionally and reconcile it with the committed assistant message. For an autonomous run, those deltas are raw action encoding and must not be rendered as ordinary assistant conversation; clients wait for typed action/run events and show only a validated `final` as assistant text. On failure, cancellation, unknown recovery, or disconnect, clients discard partial text. A non-streaming provider emits no progress.

The endpoint does not emit the initial snapshot, heartbeat frames, or an explicit end marker. Managed service discovery authenticates the local client and checks one version range/configuration; there is still no multi-tenant authorization, non-loopback authentication claim, in-place upgrade negotiation, or WebSocket transport. The advanced embedded server is unauthenticated.

### Minimal client example

```ts
import { AgentClient } from "@prime-agent/runtime/protocol";

const client = new AgentClient("http://127.0.0.1:3131");
const session = await client.createSession("demo");
const run = await client.startRun(session.sessionId, session.branchId, {
  task: "inspect the workspace",
  requestKey: "protocol-example-run",
});
if (run.status === "waiting_for_user" && run.pendingInput) {
  await client.respondToRun(session.sessionId, session.branchId, run.runId, run.pendingInput.id, "continue");
}
const snapshot = await client.snapshot(session.sessionId, session.branchId);
```

`AgentClient` wraps these JSON calls with `startRun`, `run`, `resumeRun`, `respondToRun`, and `cancelRun`, plus `modelProviders()` and `stream(sessionId, branchId, afterCursor, handlers, signal?)`. Its stream helper advances its local cursor only for committed `AgentEvent` items, ignores duplicate/older committed cursors, and delivers cursorless progress through a separate optional handler. Fork helpers are not yet provided. Returned run and Slice 2 values are plain durable JSON handles and may be stored and reused after reconnect.

## Console cell environment

A cell is transpiled as the body of an async function and receives these names:

- `session`: `{ id, branchId }`;
- `state`: durable typed working values, including read-only discovery with `state.list()`;
- `cells`: read-only retained cell history through `list` and `get`;
- `artifacts`: content-addressed strings;
- `tools`: durable effect requests plus convenience helpers;
- `sql`: parameterized read-only tagged template;
- `inspect`: safe bounded textual inspection;
- `sdk`: the same `state`, `cells`, `artifacts`, `tools`, `inspect`, memory, harness, skill, and spec surfaces;
- a cell-local `console` whose log/warn/error strings enter the cell result event.

### Notebook observations

When a cell has no cell-level `return`, its last top-level expression becomes the observation:

```ts
const rows = await sql`SELECT type FROM events ORDER BY sequence`;
rows.slice(0, 5) // observed and awaited if it is a promise
```

An explicit `return` keeps its existing behavior, including early returns; a `return` inside a nested function does not suppress final-expression observation. A cell ending in a declaration has a `null` observation. `console.log`/`warn`/`error`, stdout, and stderr remain separate bounded logs.

Canonical structured observations remain JSON. JSON at or below 128 KiB is committed directly. Above 128 KiB, the complete serializable JSON is placed in the content-addressed artifact store and the committed result is `{ kind: "oversized-json", artifact, byteLength, preview }`. Repeated byte-identical JSON reuses the CAS object. Circular, class-backed, accessor-backed, bigint, and other unsupported JSON results commit `{ kind: "unsupported", reason, preview }` rather than entering the worker protocol as an unsafe value.

```ts
inspect(value, { depth: 4, entries: 50, lines: 40, bytes: 8192, redact: ["internalField"] })
```

`inspect` returns `{ kind: "inspect", preview, truncated, redacted, omittedGetters, limits }`. Defaults are depth 4, 50 total entries, 40 lines, and 8 KiB; hard maxima are depth 8, 200 entries, 100 lines, and 16 KiB. Getter invocation is always zero. Circular references and exhausted limits receive markers. Credential-shaped property names and caller-supplied exact property names are redacted. A preview is deliberately lossy and is never authoritative artifact content.

### Working values

```ts
const stored = await state.set("plan", { step: 2, done: false });
const restored = await state.get("plan");
console.log(state.restored.plan);
return restored;
```

`set` accepts JSON. At or below 128 KiB after JSON serialization it creates `{ kind: "json", value }`; above the threshold it writes an immutable JSON artifact and creates `{ kind: "artifact", artifactId }`. Updates are staged until the cell succeeds. Each committed name receives an increasing version. A failed or interrupted cell cannot expose staged working-value or artifact-reference events, though an unreferenced CAS object may remain physically and may be garbage-collected by future tooling.

`state.list()` returns name, version, working-value handle, `committed`/`staged` status, and exact event provenance for committed values. It never resolves artifact content. Ordinary lexical bindings and `globalThis` are not durable and are never reconstructed; use `state.set` or retain an artifact reference for anything required by another cell or restart.

### Cell history

```ts
const recent = await cells.list({ limit: 20, status: "committed" });
const prior = await cells.get(recent.items[0].cellId);
```

`cells.list` is newest-first and cursor-paginated with `beforeCursor`; its default status set is committed, failed, and abandoned. `cells.get` returns `null` outside the current branch lineage. Entries include retained source, observation, logs, status, dependencies, attempts, duration, exports/error, and the proposed/start/terminal event provenance. These operations only read retained events and never replay code or effects.

### Artifacts

```ts
const reference = await artifacts.put("large body", "text/plain");
const body = await artifacts.get(reference.artifactId);
```

`get` is limited to artifacts already registered in the branch state or staged by this cell. Artifact content is integrity-checked by the local store.

### Read-only SQL

```ts
const failures = await sql`
  SELECT type, count(*) AS occurrences
  FROM events
  WHERE session_id = ${session.id}
  GROUP BY type
`;
```

Interpolations become bound `?` arguments, not source text. The validator permits one `SELECT`, `WITH` read, `EXPLAIN SELECT/WITH`, or narrow metadata pragma (`table_info`, `index_list`, `foreign_key_list`). It rejects mutation/DDL/transactions, multiple statements, dangerous file/extension functions, private `schema_migrations`, `outbox`, and `snapshots` access, and SQLite schema/engine tables. Analytical reads use a query-only per-query connection, a 64 KiB statement cap, a 1,000-row cap, and a 2-second deadline. This is a pragmatic generated-query guard in trusted-local mode, not a complete SQL parser or hostile-input security boundary.

### Tools

```ts
const shell = await tools.shell("bun test", { timeoutMs: 120_000 });
const file = await tools.readFile("package.json");
await tools.writeFile("notes/result.txt", "done", file.sha256);

const outcome = await tools.request(
  "file",
  "delete",
  { path: "notes/obsolete.txt" },
  { idempotencyKey: "remove-obsolete-v1", idempotent: true },
);
```

Every request commits an `EffectRequested` event before execution. Convenience helpers throw when the outcome is not `succeeded`; `tools.request` returns the four-way outcome directly. Supply a stable idempotency key when logical intent may be submitted again. Shell operations default to non-idempotent. File reads/writes/deletes default to idempotent; exact-text replace defaults to non-idempotent. These defaults do not replace caller/executor reasoning about external state.

The file executor rejects lexical and resolved symlink escapes from its configured root. The shell executor constrains only its initial cwd; a shell command still has ambient OS filesystem/network authority. Neither is a sandbox.

## Private worker RPC

Supervisor and worker exchange structured messages over Bun's dedicated IPC channel. Stdout and stderr are not protocol: ordinary `console.*` and `process.stdout`/`process.stderr` writes become cell logs capped at 64 KiB/1,000 entries, so arbitrary or protocol-shaped output cannot spoof RPC. Cells are serialized within a worker because output streams are process-wide. Each cell has an `executionId`; every SDK call gets a separate `requestId`, so concurrent SDK calls inside the cell are routed correctly. Only the supervisor touches storage, artifacts, and executors through the RPC handler. A worker process exit rejects pending cells, and startup recovery appends branch-scoped `CellAbandoned` events where no terminal cell event committed.

This framing is private implementation detail, not a versioned external extension interface. External clients should use the HTTP/event protocol or TypeScript API.


## Slice 3 HTTP/AgentClient routes

All session mutation routes require `?branch=:branch` and return durable JSON records.

| Method and path | Meaning |
|---|---|
| `POST /sessions/:session/memory` | Create scoped semantic memory (`CreateMemoryInput`). |
| `GET /sessions/:session/memory?query=...&scopes=...&statuses=...&tags=...&limit=...` | Deterministic results plus full retrieval provenance. |
| `GET /sessions/:session/memory/list` | Visible memory list. |
| `POST /sessions/:session/refinement-reviews?branch=...` | Admit a manual attributable trajectory review with optional instructions/scope/kinds/wait. |
| `GET /sessions/:session/refinement-reviews?branch=...&status=...` | Current branch review lifecycle records. |
| `GET /sessions/:session/refinement-reviews/:review?branch=...` | One review, with exact session/branch ownership checked. |
| `GET /refinement-reviews?status=...` | Advanced workspace-wide review diagnostics. |
| `POST /sessions/:session/user-corrections?branch=...` | Append a typed correction citing distinct earlier branch event IDs. |
| `GET /refinement-policy` | Versioned profile-owned automatic-trigger policy; default automatic=false and scope=local. |
| `PUT /refinement-policy` | `{ enabled: boolean }`; malformed values fail rather than being coerced. |
| `POST /sessions/:session/refinements` | Advanced raw proposal path: propose typed edits/evidence/evaluation. |
| `POST .../refinements/:proposal/validate` | Validate shapes, evidence, authority, conflicts, and CAS. |
| `POST .../refinements/:proposal/activate` | Create/test candidates and set bounded allocation/exposure. |
| `POST .../refinements/:proposal/allocate` | Allocate candidate to a session/branch/task. |
| `POST .../refinements/:proposal/observations` | Record objective or supported observation. |
| `POST .../refinements/:proposal/approve` | Record explicit user/global promotion approval. |
| `POST .../refinements/:proposal/decide` | Promote, revise, or reject under scope policy. |
| `POST .../refinements/:proposal/approve-rollback` | Separately authorize user/global rollback as owner/admin. |
| `POST .../refinements/:proposal/rollback` | Roll back exact promoted versions after any required separate approval. |
| `GET /harness` | Current harness entries. |
| `GET /harness/:entry/history` | Immutable version history. |
| `GET /harness/refinements?status=...` | Proposal lifecycle records. |
| `POST /sessions/:session/skills/:entry/test` | Durable compile/runtime tests, optionally exact `versionId`. |
| `POST /sessions/:session/skills/:entry/invoke` | Durable exact-version skill invocation. |
| `POST /sessions/:session/specs/:entry/spawn` | Version-pinned normal subagent admission. |

`AgentClient` supplies the corresponding `memoryCreate`, `memorySearch`, `memoryList`, `requestRefinement`, `refinementReviews/refinementReview`, `userCorrection`, `refinementPolicy/setAutomaticRefinement`, advanced raw `refine`, `validateRefinement`, `activateRefinement`, `allocateRefinement`, `observeRefinement`, `approveRefinement`, `decideRefinement`, `approveRollback`, `rollback`, `harnessList/history`, `invokeSkill/testSkill`, and `spawnSpec` methods.

The private console RPC injects `sdk.memory`, `sdk.harness`, `sdk.skills`, and `sdk.specs`. `sdk.harness.review(instructions?)` and `reviews(options?)` use the same retained review services; `propose` remains the raw advanced proposal call. Typed `UserCorrection` creation stays client/user-owned and is deliberately absent from the model-facing SDK. These facades do not expose SQL writes or evaluator/user-owned validation, activation, allocation, observation, decision, approval, or rollback. `sdk.harness.list/history` are scope-filtered model views: active authorized entries plus only an exact exposed candidate allocation. The raw `sql` tag remains a shared trusted-local, non-confidential diagnostic read and can inspect non-private cross-workspace/candidate projections; exposure is behavioral isolation, not secrecy. Agent direct-memory creation is local-only with source-trajectory evidence. The TUI adds `/memory`, `/skills`, `/refine`, `/rollback`, `/skill-test`, and `/skill` commands. `/refine [instructions]` starts the review, `/refine status` lists branch review/proposal history, `/refine auto on|off` changes the profile preference, `/refine correct IDS -- TEXT` appends a typed correction, and `/refine propose-json JSON` preserves the raw advanced proposal diagnostic. No TUI-only mutation path exists.


## Physical deletion route

`POST /sync/delete` accepts `{ scopeKind, scopeId, requestedBy, confirmation, receiptDirectory? }`
and returns `PhysicalDeletionReceipt`. `confirmation` must exactly equal
`DELETE <scopeKind> <scopeId>`. The call quiesces worker/outbox admission and refuses while an effect is running or being claimed. The serving process must treat a destructive attempt as terminal for that runtime. Foreign ownership is a validation failure; durable remote evidence without authenticated, fully addressable administration and unsupported local/remote granularity are `CAPABILITY_UNAVAILABLE`. Completed/partial receipts enumerate observed removals, including all per-URL admin receipts. The typed client method is `AgentClient.deleteOwnedData`.

`POST /sessions/:id/resume?branch=...` rebuilds and reattaches to a retained branch; `POST /sessions/:id/compact?branch=...` creates a source-linked immutable extractive summary. Typed client methods are `AgentClient.resume` and `AgentClient.compact`.

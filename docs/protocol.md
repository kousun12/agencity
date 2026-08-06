# Protocol and console SDK

Agencity has two distinct protocols in Slice 1:

1. a loopback HTTP/JSON + server-sent-event interface for external clients;
2. a private Bun IPC channel between the supervisor and disposable console worker, separate from stdout/stderr.

Neither protocol is an authentication or sandbox boundary.

## HTTP server

Start with `bun run src/cli.ts serve --port 3131`. CLI startup binds `127.0.0.1`; `ProtocolServer.listen` can accept a different hostname programmatically, but exposing it without an independent authenticated proxy is unsupported.

All successful non-streaming responses are JSON. Domain errors use HTTP 400 and `{ "error": { "code", "message" } }`; unexpected failures use HTTP 500 and code `INTERNAL`; unknown routes use HTTP 404.

### Endpoints

| Method and path | Input | Result |
|---|---|---|
| `GET /health` | none | `{ ok: true, mode: "trusted-local" }` |
| `POST /sessions` | `{ workspaceId?, model?, budget? }` | `{ sessionId, branchId }` |
| `GET /sessions/:session/snapshot?branch=:branch` | none | `{ cursor, state }` |
| `GET /sessions/:session/history?branch=:branch` | none | ordered `AgentEvent[]` including branch lineage |
| `GET /sessions/:session/stream?branch=:branch&after=:cursor` | none | `text/event-stream` committed events |
| `POST /sessions/:session/messages?branch=:branch` | `{ content }` | committed user `AgentEvent` |
| `POST /sessions/:session/turns?branch=:branch` | none | `{ outcome, message? or error? }` |
| `POST /sessions/:session/cells?branch=:branch` | `{ code }` | `{ cellId, result, logs }` |
| `POST /sessions/:session/branches?branch=:parent` | `{ cursor, name? }` | `{ branchId }` |

For snapshot/history/stream, the branch may alternatively occupy the fourth path segment, but the query parameter is the documented form. Request validation is currently minimal at the transport boundary; domain/storage validation remains authoritative.

### Snapshot then SSE

A correct consumer:

1. calls `GET .../snapshot?branch=B` and renders the returned `state`;
2. stores its opaque decimal-string `cursor` without converting it to a JavaScript `number`;
3. connects to `GET .../stream?branch=B&after=<cursor>`;
4. for each SSE message, parses `data` as an `AgentEvent`, ignores event IDs already applied, reduces it, and persists the new cursor;
5. reconnects with the last applied cursor after any disconnect.

Each SSE item uses the cursor as `id:` and the full event JSON as `data:`. Publication happens after commit. Commit callbacks only wake the server; catch-up reads from storage, so a crash between commit and notification does not lose state. Delivery should be treated as at least once. Causally inherited branch events and branch-local events use database cursor order.

The endpoint does not emit the initial snapshot, heartbeat frames, or an explicit end marker. It also does not yet authenticate, authorize per workspace, negotiate schema versions, or expose a WebSocket transport.

### Minimal client example

```ts
import { AgentClient } from "@prime-agent/runtime/protocol";

const client = new AgentClient("http://127.0.0.1:3131");
const session = await client.createSession("demo");
await client.message(session.sessionId, session.branchId, "hello");
await client.turn(session.sessionId, session.branchId);
const snapshot = await client.snapshot(session.sessionId, session.branchId);
```

`AgentClient` currently wraps create, snapshot, message, turn, cell, and history only. Fork and SSE helpers are not yet provided; use `fetch`/`EventSource` or implement the small wire contract directly.

## Console cell environment

A cell is transpiled as the body of an async function and receives these names:

- `session`: `{ id, branchId }`;
- `state`: durable typed working values;
- `artifacts`: content-addressed strings;
- `tools`: durable effect requests plus convenience helpers;
- `sql`: parameterized read-only tagged template;
- `sdk`: `{ state, artifacts, tools }`;
- a cell-local `console` whose log/warn/error strings enter the cell result event.

### Working values

```ts
const stored = await state.set("plan", { step: 2, done: false });
const restored = await state.get("plan");
console.log(state.restored.plan);
return restored;
```

`set` accepts JSON. At or below 128 KiB after JSON serialization it creates `{ kind: "json", value }`; above the threshold it writes an immutable JSON artifact and creates `{ kind: "artifact", artifactId }`. Updates are staged until the cell succeeds. Each committed name receives an increasing version. A failed or interrupted cell cannot expose staged working-value or artifact-reference events, though an unreferenced CAS object may remain physically and may be garbage-collected by future tooling.

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

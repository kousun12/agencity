# Operator guide

## Install

Agencity requires Bun 1.2 or newer. From the repository root:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run check:architecture
bun test
```

`bun run verify` runs those three gates. Slice 1 needs no network access when the built-in `echo` model is used.

## Local placement

The CLI accepts these options on every command:

| Option | Default | Meaning |
|---|---|---|
| `--state-dir PATH` | `.agencity` | Parent for default database and artifacts paths. |
| `--db PATH` | `<state-dir>/agent.db` | Local LibSQL file. The CLI converts it to a `file:` URL. |
| `--artifacts PATH` | `<state-dir>/artifacts` | Local SHA-256 content-addressed store. |
| `--workspace-root PATH` | current directory | Initial cwd and intended root for local executors. |
| `--restart-console-after-cell` | off | Stop the disposable worker after each cell; use this for recovery diagnostics. |

The database is the canonical session record, but artifact payloads live outside it. Back up/export both when a session references artifacts. Workspace files and external services are not owned snapshots and cannot be reconstructed from the database.

## CLI

Run `bun run src/cli.ts help` for the compact built-in help. The parser distinguishes boolean flags from value options, accepts `--name=value`, rejects missing/duplicate/unknown options, and supports `--` before positional text/code that begins with `--`. The package also declares `agencity` and `prime-agent-ts` executable aliases for an installed package.

### Create

```sh
bun run src/cli.ts create --workspace <WORKSPACE_ID>
```

This creates a root session and branch using `{ provider: "echo", model: "echo-1" }`. The result contains IDs required by later commands. To select another model or set budgets, use `Supervisor.createSession` or `POST /sessions`.

### Message plus one model turn

```sh
bun run src/cli.ts chat --session <SESSION_ID> --branch <BRANCH_ID> "message text"
```

The user message is committed before the context and model request. A response is printed only after its effect outcome and model completion events commit.

### Console cell

```sh
bun run src/cli.ts cell --session <SESSION_ID> --branch <BRANCH_ID> \
  'const rows = await sql`SELECT type FROM events WHERE session_id = ${session.id}`; return rows;'
```

Cells run as the body of an async function. The final value must be JSON-serializable; return `null` for no value. Use `state.set`, not heap variables, for later cells. Static top-level module syntax is not a supported cell interface; use the injected SDK and, only in trusted code, normal Bun dynamic imports.

### Inspect and rebuild

```sh
bun run src/cli.ts snapshot --session <SESSION_ID> --branch <BRANCH_ID>
bun run src/cli.ts history  --session <SESSION_ID> --branch <BRANCH_ID>
bun run src/cli.ts rebuild  --session <SESSION_ID> --branch <BRANCH_ID>
```

- `snapshot` loads or creates a current materialized projection.
- `history` prints one canonical event JSON object per line, including inherited branch events.
- `rebuild` deletes disposable snapshots for the session, projects the retained events twice, checks equality, and saves the rebuilt state. It never re-executes effects.

### Fork

```sh
bun run src/cli.ts branch \
  --session <SESSION_ID> --branch <PARENT_BRANCH_ID> \
  --cursor <PARENT_CURSOR> --name experiment
```

The cursor must occur in the parent branch lineage. The child sees parent events through that cursor, its `BranchCreated` event, and later child events. Later parent events are not merged into it.

### Serve

```sh
bun run src/cli.ts serve --port 3131
```

The CLI binds to `127.0.0.1`. The server is unauthenticated and must not be exposed directly to an untrusted network. Shutdown currently relies on process termination; the supervisor opens and recovers before listening.

## TUI

Start it with existing session and branch IDs:

```sh
bun run src/cli.ts tui --session <SESSION_ID> --branch <BRANCH_ID>
```

Plain text is committed as a user message and followed by one model turn. Commands:

| Command | Behavior |
|---|---|
| `/history` | Print projected branch history as cursor, event type, and payload. |
| `/budget` | Print current token, cost, turn, and wall-time counters/limits. |
| `/snapshot` | Print the entire current `AgentState`. |
| `/tree` | Print the recursive child-session tree and task status. |
| `/tasks` | Print durable tasks owned by the current session/branch. |
| `/goals` | Print projected autonomous goals and completion gates. |
| `/heartbeats` | Print projected heartbeat schedules. |
| `/cancel-task <id> [reason]` | Cascade cancellation through a task's descendants. |
| `/complete-goal <id>` | Run current-version completion gates for a goal. |
| `/cell <typescript>` | Execute one disposable-console cell and print its result. |
| `/branch <cursor> [name]` | Fork at a historical cursor and switch this TUI to the child. |
| `/help` | Print command help. |
| `/quit`, `/exit` | Close the TUI. |

The current TUI is a basic in-process supervisor client. It does not yet consume the HTTP/SSE transport, render live token streaming, expose unknown-effect reconciliation, or implement the richer PRD commands (`resume`, `compact`, `refine`, `rollback`, sync/conflict views). Those limitations are intentional and visible rather than implied capabilities.

## Providers

`Supervisor.open` always installs `EchoModelProvider`. If `OPENAI_API_KEY` exists, it also installs an OpenAI-compatible provider named `openai`; `OPENAI_BASE_URL` changes its endpoint. Programmatic callers can inject additional `ModelProvider` implementations with `modelProviders`. `providerConcurrency` accepts a positive default or a per-provider map; the one shared limiter covers root turns, recursive calls, and model-backed gates.

Provider credentials remain in the supervisor. Common credential-shaped variables are removed from the console worker and non-login shell executor environments. Inputs containing an actual known secret value are rejected; executor outputs/logs/errors redact known values. Benign fields named `token`, `auth`, or similar are not mutated. This reduces accidental disclosure but is not a hostile-code boundary; trusted generated code has OS access and must be contained externally when necessary.

## Recovery startup

Opening a supervisor runs recovery by default:

1. running idempotent effects are requeued;
2. running (or anomalous prior-attempt pending) non-idempotent effects are completed as `unknown`;
3. interrupted cells are abandoned with branch-scoped recovery events, including inherited incomplete cells on forks;
4. recorded cancellation crash-prefixes finish leaf-first with their original reason;
5. normal pending/requeued effects are drained;
6. model calls whose durable effect already completed are finalized without calling the provider again;
7. a session branch stranded in `running` is reconciled to `idle`;
8. due active heartbeats fire once with aligned schedules;
9. incomplete completion gates reconcile and active goals resume;
10. pending/running recursive handles resume through the shared provider limiter.

A live database poller also fires schedules that become due after startup; `heartbeatPollIntervalMs` configures its cadence and `Supervisor.close()` stops it. Cancellation intents interrupted by a crash resume leaf-first before queued effects are drained.

Pass `recover: false` only from controlled tests or tooling that deliberately owns recovery. See [Crash recovery](./recovery.md).

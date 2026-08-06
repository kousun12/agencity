# Operator guide

## Install

Agencity requires Bun 1.2 or newer. From the repository root:

```sh
bun install --frozen-lockfile
bun run verify
bun run dev
bun run dev -- "inspect this repository"
```

Run `bun link` from the installed checkout to create `agencity` and `prime-agent-ts` under `~/.bun/bin`; the checked-in `src/cli.ts` target is Git mode `100755`, so no test-side or operator `chmod` is required. This private package has no supported registry or standalone release. `agencity --version` reports the application and Bun compatibility. The source and isolated-link verification workflows are documented in [Installation and executable workflows](./install.md).

## Local placement

The CLI accepts these options on every command:

| Option | Default | Meaning |
|---|---|---|
| `--state-dir PATH` | `.agencity` | Parent for default database and artifacts paths. |
| `--db PATH` | `<state-dir>/agent.db` | Local LibSQL file. The CLI converts it to a `file:` URL. |
| `--artifacts PATH` | `<state-dir>/artifacts` | Local SHA-256 content-addressed store. |
| `--workspace-root PATH` | current directory | Initial cwd and intended root for local executors. |
| `--profile PATH` | `<db>.profile.db` | Separate device/preferences/global-skills/credential-reference/workspace catalog. |
| `--sync-url URL` | `TURSO_DATABASE_URL` | Optional Turso database used for immutable envelope exchange. |
| `--replica PATH` | `<db>.sync-replica.db` | Local Turso Sync envelope database path (the CLI supplies a `file:` URL). |
| `--credential-ref HANDLE` | none | Opaque profile credential reference (the token itself comes from `TURSO_AUTH_TOKEN`). |
| `--sync-interval MS` | 30000 | Runtime-owned interval; zero disables interval sync. |
| `--restart-console-after-cell` | off | Stop the disposable worker after each cell; use this for recovery diagnostics. |

The database is the canonical session record, but artifact payloads live outside it. Back up/export both when a session references artifacts. Workspace files and external services are not owned snapshots and cannot be reconstructed from the database.

## Optional Turso Cloud sync

Local-only is the default and needs no Cloud credentials. For one workspace replica:

```sh
export TURSO_DATABASE_URL='libsql://database-organization.turso.io'
export TURSO_AUTH_TOKEN='...'
bun run src/cli.ts sync --workspace example --state-dir .agencity
bun run src/cli.ts sync-push --workspace example --state-dir .agencity
bun run src/cli.ts sync-pull --workspace example --state-dir .agencity
bun run src/cli.ts sync-checkpoint --workspace example --state-dir .agencity
bun run src/cli.ts sync-stats --workspace example --state-dir .agencity
bun run src/cli.ts sync-status --workspace example --state-dir .agencity
bun run src/cli.ts conflicts --workspace example --state-dir .agencity
```

The auth token stays in process memory and is not written to workspace/profile/replica metadata by Agencity. Create any named credential reference through `ProfileStore` before passing `--credential-ref`. The pinned `@tursodatabase/sync@0.7.2` adapter connects with a deferred URL callback that is `null` outside network calls, so initialization and local staging never contact Cloud. A normal cycle stages immutable event envelopes, optionally pre-pulls an established revision, invokes the official `push()`, invokes the official `pull()`, validates/ingests, then checkpoints. A brand-new replica pushes its local CDC before pulling. `error` means a network phase did not complete; local reads/writes and unsent CDC remain available.

Directional push/pull, checkpoint, and statistics commands are real SDK operations. Statistics report local CDC count, main/revert WAL sizes, last push/pull times, opaque revision, and network byte counters. Distributed leases, task stealing, automatic ownership failover, and remote administrative deletion remain unavailable. If the local sync database is replaced, its incarnation changes and canonical local history is restaged rather than skipped by a stale watermark.

Shared replica writers are a trusted single-user group, not mutually untrusted tenants. A request created on one trusted device for a session whose execution owner is another device is an effect command to that owner after synchronization. Only the `execution_owner_device_id` materializes/runs the outbox work; the requesting/non-owner replica never does. Do not share envelope-database write credentials with untrusted devices.

Run the optional real Cloud smoke only against a disposable credential-gated database:

```sh
AGENCITY_TURSO_SMOKE=1 TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
  bun test test/slice4/cloud-smoke.test.ts
```

## CLI

Run `agencity --help` (or `bun run dev -- --help`) for the built-in help. With no command, Agencity opens the product rather than developer help. The first unknown positional is treated as the initial task:

```sh
agencity                              # discover workspace, create/resume, open TUI
agencity "inspect this repository"   # run typed autonomous actions, then open TUI
agencity new [TASK]
agencity resume [NAME|ID]
agencity sessions [--json]
agencity run TASK                     # run typed autonomous actions and exit
agencity doctor [--json]
agencity config
```

Workspace discovery walks upward for explicit `.agencity` or `.git` metadata and canonicalizes the selected root with `realpath`; `--workspace PATH` is an override. The root's durable identity is the opaque value in `.agencity/workspace-id`, created atomically with mode `0600`. It therefore survives a repository rename/move and makes symlink aliases converge. Concurrent first opens retain the single winning complete marker. A repository with a pre-marker `.agencity/agent.db` records its legacy path-derived ID on first migration. Do not copy one marker into an unrelated repository or edit it manually: symlinked metadata/markers, group- or world-accessible markers, wrong ownership, oversized files, and invalid identifiers stop startup rather than falling back to a new identity.

Product state defaults to `<root>/.agencity`, while profile/device preferences default to `~/.agencity/profile.db`. The recent session/branch preference is workspace-scoped. Only one root initial branch may be selected without a preference; multiple plausible roots require an interactive selector or explicit `sessions --select NAME`.

Session and branch labels derive from the first retained task without changing it. Rename a session with `sessions --session ID --name NAME`, or add `--branch ID` to rename one branch. `sessions` shows name, time, model, state, task summary, active goals, unresolved work, and diagnostic IDs.

### Provider and model onboarding

```sh
export OPENAI_API_KEY='...'
# optional: export OPENAI_BASE_URL='https://provider.example/v1'
agencity --model openai/MODEL_ID
agencity --demo  # visibly labeled deterministic Echo fixture
```

The real-provider path persists only `provider/model`; raw credentials never enter preferences, events, logs, artifacts, or doctor output. `config credential-ref PROVIDER env:VARIABLE LABEL` records an opaque external handle, not a credential. Non-interactive new work without a usable real provider and model fails nonzero rather than choosing Echo. A resumed branch always retains its original model; if that provider is unavailable the branch remains visible and opens in a blocked configuration state.

Programmatically supplied `SupervisorOptions.modelProviders` appear in the same secret-free provider catalog. Providers may expose streaming capability, but model choice still requires a model identifier (an environment `<PROVIDER>_MODEL`, persisted preference, `--model`, or interactive input).

### Advanced compatibility commands

The parser still distinguishes boolean flags from value options, accepts `--name=value`, and rejects missing, duplicate, or unknown options. Disambiguation is deterministic:

- product route words (`new`, `resume`, `sessions`, `run`, `doctor`, and `config`) are commands when they are the exact first argument;
- legacy words followed by ordinary natural-language positional text are tasks (`agencity create a parser`, `agencity chat with the team`);
- `chat` and `cell` with `--session`/`--branch`, and other legacy words supplied only their recognized options, remain low-level commands;
- a quoted multi-word first argument is a task; and
- `--` before the task is the authoritative escape for any ambiguous exact spelling, for example `agencity -- run the benchmark` or `agencity -- create --demo`.

Low-level commands keep their prior ID-oriented contracts.

```sh
agencity create --workspace <WORKSPACE_ID>
```

This legacy diagnostic command still creates `{ provider: "echo", model: "echo-1" }` for compatibility. It is not the product onboarding path; use `--demo` through `new`, `run`, or the default route when fixture behavior is intended.

### Autonomous product run and diagnostic turn

`agencity [TASK]` and `agencity run TASK` commit one user task plus an `AgentRunRequested` event, then advance strict `agencity.agent-action` version-1 steps until a terminal or durable user-input boundary. A model may return a final response, TypeScript cell, clarification/permission request, blocked outcome, or failure. File, shell, SQL, model, subagent, skill, memory, and artifact operations are SDK calls inside TypeScript; they are not parallel provider tools. Malformed, fenced, suffixed, unsupported-version, or unknown-field responses are rejected and never executed.

Raw provider action JSON remains queryable in model/action events for attribution. It is not an assistant conversation message. Only a validated `final` appends the user-visible assistant message. A clarification or permission request is a typed waiting state; plain TUI input answers it, and `/stop` records cancellation intent.

The retained low-level text-chat diagnostic remains available:

```sh
bun run src/cli.ts chat --session <SESSION_ID> --branch <BRANCH_ID> "message text"
```

That advanced command commits the user message before a single context/model request. Its response is printed only after the effect outcome and model completion events commit.

### Console cell

```sh
bun run src/cli.ts cell --session <SESSION_ID> --branch <BRANCH_ID> \
  'const rows = await sql`SELECT type FROM events WHERE session_id = ${session.id}`; return rows;'
```

Cells run as the body of an async function. If there is no cell-level `return`, the last top-level expression is observed and promises from either path are awaited. Explicit `return` remains supported for early control flow. Logs are bounded separately from the observation.

Structured JSON observations at or below 128 KiB are committed directly. Larger serializable observations are stored once in the content-addressed artifact store; the cell result contains the artifact reference and a bounded preview. `inspect(value, options?)` produces a preview capped at 8 depth levels, 200 total entries, 100 lines, and 16 KiB (smaller defaults apply), never invokes getters, marks circular/depth truncation, and redacts credential-shaped property names. The preview is not authoritative artifact content.

Ordinary `const`/`let` bindings are cell-local, even when a worker happens to be reused. Use `state.set` for typed cross-cell state, `state.list()` to discover it, and `cells.list()`/`cells.get(cellId)` to inspect retained cell source, observation, logs, status, dependencies, and event provenance. Static top-level module syntax is not a supported cell interface; use the injected SDK and, only in trusted code, normal Bun dynamic imports.

### Retained family messaging

Generated cells use `sdk.agents` rather than supplying internal sender identity:

```ts
const child = await sdk.agents.spawn({ task: "Review the patch", name: "reviewer" });
await sdk.agents.send({ target: "reviewer", content: "Focus on cancellation", taskId: child.taskId });
const receipt = await sdk.agents.followUp("reviewer", "Recheck the revised patch");
const inbox = await sdk.agents.messages({ direction: "inbound", limit: 20 });
await sdk.agents.acknowledge(inbox.items[0].mailboxMessageId);
```

Only the unique parent, direct children, and siblings are addressable. Busy targets retain messages as queued steering until a durable run boundary; explicit follow-up to an idle/stopped child schedules work in the same child session. Receipt and reply state survives supervisor and console-worker restart. Limits are 32 KiB per UTF-8 message, eight artifact links, 60 sends per sender/minute, 100 pending target messages, and 100 rows per page. Failed/unavailable delivery and an unknown follow-up result remain visible rather than being retried as success.

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

The normal TUI path is simply `agencity` or `agencity [TASK]`; the product bootstrap selects durable work and prints a workspace/session/model/run/trusted-local header. The existing explicit-ID route remains available for diagnostics:

```sh
agencity tui --session <SESSION_ID> --branch <BRANCH_ID>
```

Plain text starts a typed autonomous run, or answers the pending clarification/permission request for the active run. Commands:

| Command | Behavior |
|---|---|
| `/history` | Print projected branch history as cursor, event type, and payload. |
| `/budget` | Print current token, cost, turn, and wall-time counters/limits. |
| `/snapshot` | Print the entire current `AgentState`. |
| `/tree` | Print the recursive child-session tree and task status. |
| `/agents` | Print the nuclear-family roster with names, relationships, session/task status, and retained IDs. |
| `/mailbox` | Print receipt-rich family messages with relationship, sender/recipient, task/artifact links, and text. |
| `/tasks` | Print durable tasks owned by the current session/branch. |
| `/goals` | Print projected autonomous goals and completion gates. |
| `/heartbeats` | Print projected heartbeat schedules. |
| `/memory [query]` | List visible scoped memory or run deterministic FTS retrieval with provenance. |
| `/skills` | List current versioned TypeScript skills. |
| `/refine <json>` | Propose and validate typed refinement edits; activation/evaluation stays explicit through SDK/protocol. |
| `/rollback <proposal> <reason>` | Roll back an exact promoted candidate. User/global proposals first require separate owner/admin approval through the supervisor/protocol `approve-rollback` command; promotion approval does not count. |
| `/skill-test <entry> [version]` | Run durable compile/runtime tests for an exact skill. |
| `/skill <entry> <json-input>` | Invoke the active exact skill version through the outbox. |
| `/cancel-task <id> [reason]` | Cascade cancellation through a task's descendants. |
| `/complete-goal <id>` | Run current-version completion gates for a goal. |
| `/stop` | Commit cancellation intent for the active agent run and reconcile its current boundary. |
| `/cell <typescript>` | Execute one disposable-console cell and print its result. |
| `/branch <cursor> [name]` | Fork at a historical cursor and switch this TUI to the child. |
| `/resume [branch]` | Rebuild and reattach to a retained durable branch without taking execution ownership. |
| `/compact` | Create an immutable deterministic extractive summary linked to retained source messages. |
| `/sync` / `/sync-status` | Run a manual directional push/pull cycle or inspect truthful capabilities/lifecycle. |
| `/conflicts` | List unresolved divergence/claim/intent reconciliation. |
| `/resolve-conflict <id> <json>` | Record an explicit typed conflict resolution. |
| `/help` | Print command help. |
| `/quit`, `/exit` | Close the TUI. |

The TUI is a basic in-process client of the same supervisor services; it never owns or closes session lifecycle. It supports resume and source-preserving compaction. Provider streaming remains available as bounded cursorless protocol progress, but the TUI deliberately does not render raw autonomous action JSON as conversation text; it prints only a validated final or a typed waiting/terminal state. Echo and other non-streaming providers report that live output is unavailable. The TUI does not yet use the HTTP/SSE transport or expose unknown-effect reconciliation; those limitations are visible rather than implied capabilities.

## Providers

`Supervisor.open` always installs `EchoModelProvider`, visibly named `Echo (demo fixture; non-streaming)`. If `OPENAI_API_KEY` exists, it also installs a streaming OpenAI-compatible provider named `openai`; `OPENAI_BASE_URL` changes its endpoint. Programmatic callers can inject additional `ModelProvider` implementations with `modelProviders`. Providers omit `capabilities` or declare `{ streaming: false }` to use `complete`; streaming providers must declare `{ streaming: true }` and implement `stream`. The runtime does not silently fall back to a second complete request if an advertised stream fails. Secret-free descriptors are available from `supervisor.modelProviders` and `GET /model-providers`. `providerConcurrency` accepts a positive default or a per-provider map; the one shared limiter covers root turns, recursive calls, and model-backed gates.

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


## Ownership-aware export and physical deletion

Deletion is terminal and fail-closed. Plan/export manifests do not delete anything. Use the explicit
command with an exact confirmation string:

```sh
# Independent, unreplicated session (shared artifact bytes are retained):
bun run src/cli.ts delete-data --workspace demo --scope session --scope-id "$SESSION" \
  --confirmation "DELETE session $SESSION" --receipt-dir .agencity/deletion-receipts

# Whole local workspace. The CAS-root ownership assertion is mandatory:
bun run src/cli.ts delete-data --workspace demo --scope workspace --scope-id demo \
  --confirmation "DELETE workspace demo" --receipt-dir .agencity/deletion-receipts \
  --exclusive-artifacts
```

Workspace/profile erasure requires an external receipt directory; it may not be inside the artifact root. Whole-workspace deletion removes the local workspace DB, exact LibSQL sidecars, every durable local replica path, the official Turso Sync `-wal`, `-wal-revert`, `-info`, `-changes`, replace-base/allowlisted backup and `.db-log` files, and the entire explicitly exclusive CAS root; similarly named unrelated sentinels are retained. Receipt removed-lists contain only entries found absent after the attempt. A permission failure leaves the catalog owned (not tombstoned), so fix the filesystem and repeat the same confirmed request. Session deletion preflights links before touching CAS, removes only artifact objects with no retained local reference, then rechecks and transactionally erases rows. Linked/recursive, replicated, harness/quarantine-referenced, or otherwise cross-referenced sessions return `CAPABILITY_UNAVAILABLE` without losing their artifacts.

Remote-managed status is durable evidence, not current configuration: every replica-status row, progress/watermark, profile catalog URL/reference, and the old adjacent default path is consulted after reopen. Data-plane sync authentication is not Cloud administrative authority. A workspace delete is blocked unless an operator supplies a separately authenticated `ManagedReplicaDeletionAdmin`, every managed identity has an addressable sync URL, and the adapter returns a receipt for every distinct URL. Retries reuse stable scope/owner/URL idempotency keys. Remote session/profile granularity is unavailable. New workspaces cannot silently reuse a successful deletion tombstone, whose placement and credential-reference fields are scrubbed.

Deletion also quiesces outbox admission and refuses while an executor is running or a claim is being admitted; retry only after that effect has a durable outcome.

Credential-free official-server conformance:

```sh
TURSO_SYNC_SERVER_BIN=/absolute/path/to/official-v0.7.2/tursodb \
  bun run test:turso-official
```

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
bun run src/cli.ts sync now --workspace example --state-dir .agencity
bun run src/cli.ts sync push --workspace example --state-dir .agencity
bun run src/cli.ts sync pull --workspace example --state-dir .agencity
bun run src/cli.ts sync checkpoint --workspace example --state-dir .agencity
bun run src/cli.ts sync stats --workspace example --state-dir .agencity
bun run src/cli.ts sync status --workspace example --state-dir .agencity
bun run src/cli.ts sync conflicts --workspace example --state-dir .agencity
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
agencity "inspect this repository"   # open TUI and run typed autonomous actions
agencity new [TASK]
agencity resume [NAME|ID]
agencity sessions [--json]
agencity run TASK                     # run typed autonomous actions and exit
agencity run --completion-gate 'COMMAND' TASK
agencity status current [--json]      # latest selected run outcome
agencity tree [--json]                # retained parent/direct-child roster
agencity history current [--json]     # retained messages, cells, effects, runs
agencity branch head [NAME]           # fork selected branch at its committed head
agencity doctor [--json]
agencity config
```

Workspace discovery walks upward for explicit `.agencity` or `.git` metadata and canonicalizes the selected root with `realpath`; `--workspace PATH` is an override. The root's durable identity is the opaque value in `.agencity/workspace-id`, created atomically with mode `0600`. It therefore survives a repository rename/move and makes symlink aliases converge. Concurrent first opens retain the single winning complete marker. A repository with a pre-marker `.agencity/agent.db` records its legacy path-derived ID on first migration. Do not copy one marker into an unrelated repository or edit it manually: symlinked metadata/markers, group- or world-accessible markers, wrong ownership, oversized files, and invalid identifiers stop startup rather than falling back to a new identity.

Product state defaults to `<root>/.agencity`, while profile/device preferences default to `~/.agencity/profile.db`. The recent session/branch preference is workspace-scoped. Only one root initial branch may be selected without a preference; multiple plausible roots require an interactive selector or explicit `sessions --select NAME`.

Session and branch labels derive from the first retained task without changing it. `branch head NAME` gives a new head fork a human name and selects it without exposing a history position; `resume NAME` reopens a named session or branch. Rename a session with the diagnostic `sessions --session ID --name NAME`, or add `--branch ID` to rename one branch. `sessions` shows name, time, model, state, task summary, active goals, unresolved work, and diagnostic IDs.

### Non-interactive run results and exit status

`agencity run --json TASK` emits exactly one compact `agencity.run-result` version-1 object for an admitted run outcome. Configuration/usage failure emits the existing `agencity.cli-output` error envelope. A detached admission instead emits `agencity.run-accepted` version 1 and intentionally omits opaque run coordinates.

| Run status | Exit status |
| --- | ---: |
| `succeeded` | 0 |
| `failed` | 1 |
| `blocked` | 4 |
| `budget_exceeded` | 5 |
| `unknown` | 7 |
| `waiting_for_user`, `queued`, or `running` | 8 |
| `cancelled` | 130 |

`status current --json` renders the same result contract for the latest retained run on the selected branch, which lets automation inspect a recovered outcome without copying an internal identifier. Non-JSON output keeps final text on stdout and distinct non-success descriptions on stderr.

### Goals, gates, heartbeats, and schedules

Normal product tasks always carry an explicit goal selection policy. `--goal auto` (the default) attaches the current active goal or creates one atomically with the run; `--goal current` refuses when no current goal exists; `--goal create` requires a new goal. Task prose is never inspected to infer this choice. A model `final` action is provisional until required gates pass. Failed or stale gate evidence is delivered once as a bounded repair observation; unknown gate effects terminate visibly. For non-interactive repository verification, `--completion-gate 'COMMAND'` creates a required idempotent shell gate with the task goal. It cannot be combined with `--goal current`. The command runs through the ordinary outbox-backed shell executor at each attributable completion request; it is not executed by the CLI parser.

Inside the TUI, `/goal` and `/goals` show the current/history view, while `/goal create DESCRIPTION`, `/goal pause`, `/goal resume`, `/goal clear`, and `/goal complete` operate without copied IDs. `/heartbeats`, `/heartbeat create MS PROMPT`, and index-based pause/resume/clear commands manage user wakes. `/schedules`, `/schedule once ISO PROMPT`, `/schedule every MS PROMPT`, and index-based lifecycle commands manage one-time and interval prompts. Missed recurring ticks coalesce.

Heartbeats and schedules queue durable wakes and deliver them through the ordinary typed `AgentRunService` with stable IDs. Ordinary product commands start or discover the per-workspace resident service; its wake pollers run only after lease admission, so future due work continues while no terminal client is attached. A service with no attached client, resident worker, queued/running run, pending effect, queued wake, active schedule, or active heartbeat exits after 60 seconds by default. A durable `waiting_for_user` run is resumed on demand and does not keep the process resident by itself. `service status` reports the idle deadline, attached-client count, and exact keep-alive reasons. An explicit `service shutdown` stops pollers and leaves durable schedules resumable on the next on-demand start.

### Provider and model onboarding

```sh
agencity
/model
# Up/Down chooses a provider; L logs in; Enter accepts a model ID; X logs out.

# Compatible direct commands:
/model login openai
/model openai:gpt-5.6-sol
/model login anthropic
/model anthropic:fable-5
/model login vercel
/model vercel:openai/gpt-5.6-sol
agencity --demo  # visibly labeled deterministic Echo fixture
```

`/model` opens a contextual inspector showing the current branch model, workspace default, provider availability, and human-readable credential source. Up/Down changes the provider selection, Enter requests an exact provider model ID, `L` starts login, `X` removes a stored key, and Escape closes the inspector. `/model login PROVIDER` accepts a key through the same hidden terminal input. Typed and bracketed-paste input remains masked. The profile-owned `auth.json` stores OpenAI, Anthropic, and Vercel AI Gateway keys with owner-only permissions, separate from profile preferences and workspace state. `/model logout PROVIDER` removes a stored key. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `AI_GATEWAY_API_KEY` remain environment fallbacks. `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, and `AI_GATEWAY_BASE_URL` may override their corresponding endpoints.

The real-provider path persists the selected `provider:model` identifier. The model portion may contain `/`, as in `vercel:openai/gpt-5.6-sol`. Anthropic shorthand such as `anthropic:fable-5` is normalized before persistence to `anthropic:claude-fable-5`, which is also the exact model ID recorded for provider calls. Raw credentials never enter preferences, events, logs, artifacts, or doctor output. `config credential-ref PROVIDER env:VARIABLE LABEL` records an opaque external handle, not a credential. Non-interactive new work without a usable real provider and model fails nonzero rather than choosing Echo. A resumed branch always retains its original model; an explicit model change commits `SessionModelChanged` only while no model work is active.

Programmatically supplied `SupervisorOptions.modelProviders` appear in the same secret-free provider catalog. Providers may expose streaming capability, but model choice still requires a model identifier (an environment `<PROVIDER>_MODEL`, persisted preference, `--model`, or interactive input).

### Context inspection and compaction

`agencity context` reports the branch cursor, canonical/message counts, uncovered narrative estimate, effective strategy, exact source digest, and prior outcomes. `agencity compact [PRESERVATION GUIDANCE] --strategy extractive|summary` requests a retained derived view; `--from-context CONTEXT_ID` rematerializes the exact frozen source set with another strategy. The TUI equivalents are `/context` and `/compact [extractive|summary] [PRESERVE...]`. Generated cells use `sdk.context.inspect()` and `sdk.context.compact({ strategy, instructions })`.

Capacity is provider/model-specific and records whether it came from provider metadata, the model catalog, operator configuration, or is unknown. Known capacities trigger automatic oldest-prefix compaction near 80 percent and target 60 percent while reserving output. Unknown capacities do not guess a proactive limit. A typed provider-confirmed overflow may retry only after a strictly smaller rematerialized candidate; generic failures and unknown outcomes never become overflow retries.

Compaction retains every canonical event. Active goals and gates, heartbeats, schedules and wakes, tasks and mailbox receipts, recursive handles, working values, artifacts, and active run control remain exact in dependent context. `debug branch --strategy extractive|summary` may choose a different derived view over inherited exact history.

### Advanced command groups and compatibility aliases

Canonical low-level routes are `debug session-create|turn|cell|snapshot|history|rebuild|branch|tui|protocol-serve`, `sync status|now|push|pull|checkpoint|stats|conflicts|resolve`, and `data export|delete`. Canonical `--json` output is one compact `agencity.cli-output` version-1 envelope on stdout for success or stderr for failure; the envelope carries the canonical command and stable exit code. The former spellings remain exact, silent aliases with historical output during the compatibility window.

The parser still distinguishes boolean flags from value options, accepts `--name=value`, and rejects missing, duplicate, or unknown options. Disambiguation is deterministic:

- product route words (`new`, `resume`, `sessions`, `run`, `doctor`, and `config`) are commands when they are the exact first argument;
- legacy words followed by ordinary natural-language positional text are tasks (`agencity create a parser`, `agencity chat with the team`);
- `chat` and `cell` with `--session`/`--branch`, and other legacy words supplied only their recognized options, remain low-level commands;
- a quoted multi-word first argument is a task; and
- `--` before the task is the authoritative escape for any ambiguous exact spelling, for example `agencity -- run the benchmark` or `agencity -- create --demo`.

Grouped commands keep the low-level ID-oriented contracts; aliases map without a migration warning:

```sh
agencity debug session-create --workspace <WORKSPACE_ID>
agencity debug history --session <SESSION_ID> --branch <BRANCH_ID> --json
agencity sync status
agencity data export --scope session --scope-id <SESSION_ID> --destination ./export
agencity data delete --scope session --scope-id <SESSION_ID> --confirmation 'DELETE session <SESSION_ID>'

# exact compatibility alias
agencity create --workspace <WORKSPACE_ID>
```

Deletion has no `--force`: its scope ID and case-sensitive, untrimmed confirmation phrase are checked before workspace state is opened, followed by the existing ownership, quiescence, remote-administration, receipt, and retry guards.

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
bun run src/cli.ts debug protocol-serve --port 3131
```

The product-managed service binds an ephemeral `127.0.0.1` port and authenticates every request with the random bearer in its 0600 discovery manifest. Discovery accepts it only when authenticated health identity, protocol/config compatibility, and the matching live workspace lease all agree. The advanced `serve --port` diagnostic is separate and unauthenticated. Neither surface is supported beyond loopback without an independently administered boundary.

`agencity service status` observes lifecycle, idle deadline, structured keep-alive reasons, and resident roots; `service shutdown` stops admission and drains without cancelling or deleting sessions. `agencity agents`, `status TARGET`, `attach TARGET`, `send TARGET MESSAGE`, and `stop TARGET` use the managed service. `agencity run --detach TASK` returns after durable acceptance. Ctrl-C or normal client exit detaches only; `stop` is the explicit durable cancellation operation. The service starts on demand and is not registered as an OS boot/login daemon.

## TUI

The normal TUI path is simply `agencity` or `agencity [TASK]`. On an interactive terminal, the product bootstrap selects durable work and opens a full-screen OpenTUI workspace; an initial task starts after admission while that workspace is visible. The existing explicit-ID route remains available for transcript-oriented diagnostics:

```sh
agencity debug tui --session <SESSION_ID> --branch <BRANCH_ID>
```

The full-screen layout keeps the session/branch/model and connection state at the top, conversation and grouped run activity in the main viewport, a stable composer at the bottom, and recovery/attention/budget/trusted-local status in the footer. At wide sizes, the contextual inspector uses about 40 percent of the terminal with bounded minimum and maximum widths. At narrow sizes, an active inspector temporarily uses the main viewport instead of injecting command output into the conversation. Plain text starts a typed autonomous run, or answers the pending clarification/permission request for the active run. `Ctrl-P` opens command search without discarding the existing draft, `Ctrl-O` expands or collapses the latest completed activity, Page Up/Down scrolls the active inspector or conversation, Escape closes the current inspector, and `Ctrl-D` detaches.

Command results replace the inspector rather than accumulating in an append-only transcript. Short success, warning, and error notices replace one another and expire. Ordinary views use labeled sections and human-readable statuses; internal IDs appear by default only when they are needed for a follow-up operation such as reconciliation. `Shift-R` toggles the current inspector into a scrubbed raw diagnostic view, and `/raw` opens raw data for the latest inspector result. Raw mode is explicit and may contain internal IDs, but never provider credential values. The plain terminal fallback renders the same structured summaries as text.

The non-interactive product surface also supports `agencity refine [INSTRUCTIONS]`, `agencity refine status`, `agencity refine auto on|off`, and the explicitly advanced `agencity refine propose-json JSON` path. Automatic mode is a profile preference, is off by default, and version 1 can trigger only local review.

Commands:

| Command | Behavior |
|---|---|
| `/history [CURSOR]` / `/live` | Inspect grouped canonical history, or enter a read-only historical projection and return to the live cursor. Use raw mode for complete event payloads. |
| `/model` | Open the interactive provider/model inspector without exposing credentials. |
| `/model login PROVIDER` / `/model logout PROVIDER` | Store a provider key through hidden input, or remove its stored value. |
| `/model PROVIDER:MODEL` | Persist the workspace default and durably select the model for the current idle branch. |
| `/budget` | Show labeled token, cost, turn, and wall-time usage and limits. |
| `/snapshot` | Show a concise projected-state overview; use raw mode for the complete `AgentState`. |
| `/tree` | Show the recursive child-session tree and task status. |
| `/agents` | Show the nuclear-family roster, relationships, task status, and mailbox summary. |
| `/mailbox` | Show receipt-rich family messages with human sender/recipient labels and text. |
| `/tasks` | Show durable tasks owned by the current session/branch. |
| `/goals` | Show autonomous goals, completion criteria, and gate attention. |
| `/heartbeats` | Show heartbeat status, intervals, prompts, and next ticks. |
| `/memory [query]` | List visible scoped memory or run deterministic FTS retrieval with provenance. |
| `/skills` | List current versioned TypeScript skills. |
| `/refine [instructions]` | Run an attributable retained-trajectory review. Use `status`, `auto on|off`, `correct EVENT_IDS -- TEXT`, or advanced `propose-json JSON` subforms as needed. |
| `/rollback <proposal> <reason>` | Roll back an exact promoted candidate. User/global proposals first require separate owner/admin approval through the supervisor/protocol `approve-rollback` command; promotion approval does not count. |
| `/skill-test <entry> [version]` | Run durable compile/runtime tests for an exact skill. |
| `/skill <entry> <json-input>` | Invoke the active exact skill version through the outbox. |
| `/cancel-task <id> [reason]` | Cascade cancellation through a task's descendants. |
| `/goal complete` | Request completion of the current goal and run its current-version gates. |
| `/stop` | Commit cancellation intent for the active agent run and reconcile its current boundary. |
| `/cell <typescript>` | Execute one disposable-console cell and print its result. |
| `/branch <cursor> [name]` | Fork at a historical cursor and switch this TUI to the child. |
| `/resume [branch]` | Rebuild and reattach to a retained durable branch without taking execution ownership. |
| `/compact` | Create an immutable deterministic extractive summary linked to retained source messages. |
| `/sync` / `/sync-status` | Run a manual directional push/pull cycle or inspect truthful capabilities/lifecycle. |
| `/conflicts` | List unresolved divergence/claim/intent reconciliation. |
| `/resolve-conflict <id> <json>` | Record an explicit typed conflict resolution. |
| `/raw` | Open scrubbed raw diagnostics for the latest inspector result. |
| `/help` | Print command help. |
| `/unknown [effect]` | List or inspect unknown effects and their append-only assessments. |
| `/reconcile <effect> <assessment> <summary>` | Append attributable evidence; effect status remains unknown and no retry occurs. |
| `/quit`, `/exit` | Detach without cancelling durable work. |

The product and diagnostic TUI both use `AgentClient` and the public protocol contract. Product attach uses authenticated loopback HTTP; diagnostic `debug tui`/`tui` uses `InProcessProtocolTransport`, which calls the exact same `ProtocolServer.handle` router rather than private supervisor services. The client snapshots then watches after the last successfully applied committed cursor, deduplicates on reconnect, and clears cursorless progress on commit or disconnect. `/history CURSOR` creates a read-only historical projection while live state continues observationally; `/live` returns to the latest committed state without replaying an effect.

The live viewport is a concise product projection, not a canonical-event tail. It shows user/assistant conversation plus one grouped activity entry per durable run. Active runs expand their typed steps; completed runs collapse by default. Retained child tasks appear as an agent summary. Consequential command and recovery details replace the contextual inspector without replacing the composer. `/history` presents grouped event types and recent cursors by default; explicit raw mode retains the complete cursor/event/payload audit.

Streaming-capable providers render bounded temporary state without exposing typed action JSON. AgentRun deltas and committed raw actions remain internal; the active run is marked working and assistant text appears only after a validated `final` action commits it. Failed or disconnected provisional progress is discarded rather than persisted. Routine SSE reconnects update the persistent connection state; a terminal watch failure remains visible in details. Echo and other non-streaming providers truthfully report committed responses only. `/unknown` and `/reconcile` inspect and append assessments without retrying or rewriting the unknown outcome. The non-interactive `agencity reconcile latest ASSESSMENT SUMMARY` form resolves the newest unknown effect inside the selected branch, so ordinary recovery does not require copying an opaque effect identifier.

First Ctrl-C requests durable cancellation for an active run; a second Ctrl-C detaches with an explicit warning that external/durable work may outlive the client. With no active run, the first Ctrl-C detaches immediately. `Ctrl-D`, `/quit`, and `/exit` detach without cancellation. Detach restores the original terminal screen and reports whether the workspace service will stop at its idle deadline or which retained-work reasons keep it active.

## Providers

`Supervisor.open` always installs `EchoModelProvider`, visibly named `Echo (demo fixture; non-streaming)`, plus credential-brokered OpenAI, Anthropic, and Vercel AI Gateway providers. OpenAI uses Chat Completions; Anthropic and Vercel use Anthropic Messages, with Vercel receiving model IDs such as `openai/gpt-5.6-sol` unchanged. Programmatic callers can inject additional `ModelProvider` implementations with `modelProviders`. Providers omit `capabilities` or declare `{ streaming: false }` to use `complete`; streaming providers must declare `{ streaming: true }` and implement `stream`. The runtime does not silently fall back to a second complete request if an advertised stream fails. Secret-free descriptors, including usability and credential source, are available from `supervisor.modelProviders` and `GET /model-providers`. `providerConcurrency` accepts a positive default or a per-provider map; the one shared limiter covers root turns, recursive calls, and model-backed gates.

Provider credentials remain in the supervisor. Stored credentials are registered with the same known-secret rejection and redaction path as environment credentials, and are released when replaced, removed, or closed. Common credential-shaped variables are removed from the console worker and non-login shell executor environments. Inputs containing an actual known secret value are rejected; executor outputs/logs/errors redact known values. Benign fields named `token`, `auth`, or similar are not mutated. This reduces accidental disclosure but is not a hostile-code boundary; trusted generated code has OS access and must be contained externally when necessary.

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
bun run src/cli.ts data delete --workspace demo --scope session --scope-id "$SESSION" \
  --confirmation "DELETE session $SESSION" --receipt-dir .agencity/deletion-receipts

# Whole local workspace. The CAS-root ownership assertion is mandatory:
bun run src/cli.ts data delete --workspace demo --scope workspace --scope-id demo \
  --confirmation "DELETE workspace demo" --receipt-dir .agencity/deletion-receipts \
  --exclusive-artifacts
```

Workspace/profile erasure requires an external receipt directory; it may not be inside the artifact root. Whole-profile deletion removes both the profile database and its model credential file. Whole-workspace deletion removes the local workspace DB, exact LibSQL sidecars, every durable local replica path, the official Turso Sync `-wal`, `-wal-revert`, `-info`, `-changes`, replace-base/allowlisted backup and `.db-log` files, and the entire explicitly exclusive CAS root; similarly named unrelated sentinels are retained. Receipt removed-lists contain only entries found absent after the attempt. A permission failure leaves the catalog owned (not tombstoned), so fix the filesystem and repeat the same confirmed request. Session deletion preflights links before touching CAS, removes only artifact objects with no retained local reference, then rechecks and transactionally erases rows. Linked/recursive, replicated, harness/quarantine-referenced, or otherwise cross-referenced sessions return `CAPABILITY_UNAVAILABLE` without losing their artifacts.

Remote-managed status is durable evidence, not current configuration: every replica-status row, progress/watermark, profile catalog URL/reference, and the old adjacent default path is consulted after reopen. Data-plane sync authentication is not Cloud administrative authority. A workspace delete is blocked unless an operator supplies a separately authenticated `ManagedReplicaDeletionAdmin`, every managed identity has an addressable sync URL, and the adapter returns a receipt for every distinct URL. Retries reuse stable scope/owner/URL idempotency keys. Remote session/profile granularity is unavailable. New workspaces cannot silently reuse a successful deletion tombstone, whose placement and credential-reference fields are scrubbed.

Deletion also quiesces outbox admission and refuses while an executor is running or a claim is being admitted; retry only after that effect has a durable outcome.

Credential-free official-server conformance:

```sh
TURSO_SYNC_SERVER_BIN=/absolute/path/to/official-v0.7.2/tursodb \
  bun run test:turso-official
```

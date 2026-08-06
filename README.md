# Agencity — recoverable Bun/LibSQL agent runtime

Agencity implements Delivery Slices 1–4 of the [Prime Agent TypeScript/Turso rewrite PRD](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md). It runs durable root and recursive child agents against a local LibSQL database. Canonical events, explicitly checkpointed working values, task/mailbox/model handles, schedules, and content-addressed artifacts survive supervisor and console-worker restarts; the Bun heap does not.

> **Security boundary:** The runtime is **trusted-local only**. Model-generated TypeScript and shell commands have the operating-system authority of the runtime. The separate Bun console worker provides crash isolation, **not a security sandbox**. Read-only raw SQL is a shared, non-confidential diagnostic channel; candidate/workspace scope filters provide behavioral context isolation, not secrecy from SQL. The HTTP server has no authentication. Run only trusted workloads, keep it loopback-only, or put the entire runtime inside an independently managed sandbox. See [Security](./docs/security.md).

## Delivery Slice 4 status

Slices 1–3 provide recoverable execution, recursive agents, and relational continual-harness refinement. Slice 4 adds stable profile/device identity, a separate profile catalog/preferences/global-skill/credential-reference database, optional Turso Cloud envelope exchange through the pinned official `@tursodatabase/sync@0.7.2` adapter, deterministic replicated-envelope validation/ingestion, offline divergent branches, duplicate-intent and task-claim reconciliation, sync lifecycle/status/discovery, ownership-aware export, and retryable physical deletion for supported owned scopes. Destructive planning follows durable historical replica/catalog evidence rather than only the current transport and requires a separate authenticated admin for every managed URL.

The installed adapter exposes real directional `push()`, `pull()`, `checkpoint()`, and `stats()` primitives. A deferred URL keeps initialization local-only, and each cycle pushes staged local CDC before pulling conflict-resolved state, so Cloud failure never blocks or erases canonical local writes. Distributed coordination is still unavailable and reported as such. Conflicting offline task claims stay unresolved until an explicit user resolution event. See [ADR 0003](./docs/decisions/0003-turso-envelope-sync.md) and the [operator guide](./docs/operator-guide.md).

This is not the whole PRD. PostgreSQL, semantic/embedding retrieval, a production Cloud administrative-deletion adapter, and a hostile-code sandbox remain later work. HTTP relational, object-CAS, candidate-index, and sandbox-executor placement adapters ship behind explicit capability contracts. `bun run verify` covers local, deterministic multi-replica, offline/conflict/restart/protocol, and real-adapter failure/incarnation tests; a real Cloud smoke is opt-in and credential-gated.

## Requirements and install

- [Bun](https://bun.sh/) 1.2 or newer
- A trusted local workspace (or an external sandbox containing the whole process)

```sh
git clone <repository-url> agencity
cd agencity
bun install --frozen-lockfile
bun run verify
bun run dev -- --version
```

For a command on `PATH`, the supported unpublished workflow is `bun link` from this installed checkout, then ensure `~/.bun/bin` is on `PATH`. The checked-in `src/cli.ts` target is mode `100755`, so the link is directly executable and no manual `chmod` is part of installation. There is no supported registry or standalone release yet. See [Installation and executable workflows](./docs/install.md).

## Product entrypoint

From a repository, `agencity` (or `bun run dev`) discovers the nearest `.agencity` or version-control root, canonicalizes path aliases, and creates or resumes named durable work without requiring session IDs:

```sh
# Real provider: credentials stay in the supervisor process; only this model ID is saved.
export OPENAI_API_KEY='...'
agencity --model openai/gpt-4o-mini "inspect this repository"

# Deterministic fixture behavior is always explicit.
agencity --demo "exercise the durable product route"

agencity sessions
agencity resume "inspect this repository"
agencity doctor
agencity config
```

`--workspace PATH` overrides discovery. The canonical root contains an owner-only `.agencity/workspace-id` marker. That opaque identity moves with the repository and makes real paths and symlinked entry paths converge; concurrent first opens atomically choose one marker. A pre-marker `.agencity/agent.db` is migrated once to its legacy path-derived identity. Agencity refuses symlinked, insecure, or malformed markers rather than silently creating a different workspace.

A workspace-scoped recent branch and non-secret model preference live in the separate profile store. If selection is ambiguous the interactive command asks instead of choosing by row order; scripts receive a typed nonzero error and can use `sessions --select NAME`. A retained branch never changes model silently, and remains inspectable when its provider is unavailable.

The startup header identifies the workspace, named session/branch, model, run state, and trusted-local authority; Echo is rendered as `[DEMO FIXTURE]`. Product tasks now use the strict `agencity.agent-action` version-1 loop: each model step chooses a typed final, TypeScript cell, clarification/permission request, blocked outcome, or failure. Cells use the injected SDK for all SQL, file, shell, model, subagent, memory, skill, and artifact work. Raw action JSON is retained as attributable internal history, never appended as an assistant conversation message; only a validated `final` becomes the user-visible assistant message.

Command-like task text is deterministic. Multi-word text such as `agencity create a parser` is treated as a task, while exact product commands such as `run`, `new`, and `resume` keep their command meaning. Quote the whole first argument or place `--` before the task to force an ambiguous spelling: `agencity -- run the benchmark`. ID-bearing `chat` and `cell` invocations remain advanced commands.

### Advanced compatibility CLI

The low-level ID-oriented commands remain available for diagnostics and scripts:

```sh
agencity create --workspace diagnostic
agencity snapshot --session <SESSION_ID> --branch <BRANCH_ID>
agencity history  --session <SESSION_ID> --branch <BRANCH_ID>
agencity cell     --session <SESSION_ID> --branch <BRANCH_ID> 'return { ok: true };'
```

Use `--restart-console-after-cell` to exercise the recovery invariant continuously. Product placement defaults to `<workspace>/.agencity`; `--state-dir`, `--db`, `--artifacts`, and `--profile` override it. Full CLI/TUI instructions are in the [operator guide](./docs/operator-guide.md).

## HTTP and event protocol

```sh
bun run src/cli.ts serve --port 3131
curl http://127.0.0.1:3131/health
```

The protocol supports autonomous run start/inspect/resume/respond/cancel, session creation, diagnostic one-turn chat, console cells, forks, snapshots, history, resumable server-sent events, scoped memory, refinement/approval/rollback, exact-version skill execution, and specification-pinned subagents. A consumer loads a snapshot, remembers its cursor, then connects to the stream with `?after=<cursor>` and deduplicates by event ID. Notifications are at-least-once hints over the durable database stream. See [Protocol and console SDK](./docs/protocol.md).

## TypeScript API

The package exports stable domain-shaped contracts rather than LibSQL SDK values:

```ts
import {
  Supervisor,
  type AgentStorage,
  type ArtifactStore,
  type EffectExecutor,
} from "@prime-agent/runtime";

const supervisor = await Supervisor.open({
  databaseUrl: "file:.agencity/agent.db",
  artifactDirectory: ".agencity/artifacts",
  workspaceRoot: process.cwd(),
  restartConsoleAfterCell: true,
});

const session = await supervisor.createSession({ workspaceId: "demo" });
const run = await supervisor.runs.start(session.sessionId, session.branchId, {
  task: "Inspect this workspace and report the result",
  requestKey: "example-run-1",
});
console.log(run);
await supervisor.memory.create(session.sessionId, session.branchId, {
  text: "This workspace verifies releases with bun run verify",
  scope: "workspace",
  tags: ["release"],
});
console.log(await supervisor.memory.search(session.sessionId, session.branchId, "release verify"));
// modelLoop.turn remains an advanced one-turn text diagnostic; product tasks use runs.
await supervisor.close();
```

Public subpath exports are `domain`, `storage`, `artifacts`, `executors`, `console`, `runtime`, `protocol`, `security`, and `tui`. API lifecycle and capability details are in [TypeScript API](./docs/api.md) and [Architecture and capability boundaries](./docs/architecture.md).

## Durable data

Default placement:

- `.agencity/agent.db`: canonical events plus documented operational/derived tables;
- `.agencity/artifacts/`: SHA-256 content-addressed immutable objects;
- the configured workspace root: shell and file effect target.

Do not copy only the database if referenced artifact bytes are required. Missing or digest-mismatched content is an explicit dependency failure. The authoritative/derived classification of every table is in [Mutable tables](./docs/mutable-tables.md), and event headers/payloads are in [Event schemas](./docs/events.md).

## Verification

```sh
bun run typecheck
bun run check:architecture
bun test
# all three, in that order:
bun run verify
```

The architecture check validates package entrypoints, domain dependency direction, LibSQL/Turso SDK confinement (including emitted declaration surfaces), migration/table classifications, immutable-table guards, and forbidden canonical SQL mutations. See [Slice 1 verification](./docs/slice-1-verification.md) for acceptance-to-test evidence.

## Design documentation

- [Installation and executable workflows](./docs/install.md)
- [Operator guide: setup, CLI, and TUI](./docs/operator-guide.md)
- [TypeScript API](./docs/api.md)
- [Protocol and console SDK](./docs/protocol.md)
- [Architecture and capability boundaries](./docs/architecture.md)
- [Trusted-local security boundary](./docs/security.md)
- [Crash recovery and unknown effects](./docs/recovery.md)
- [Event schemas](./docs/events.md)
- [Mutable table registry](./docs/mutable-tables.md)
- [Consequential decisions and unsupported capabilities](./docs/decisions/0001-slice-1-boundaries.md)
- [Slice 3 relational memory and refinement decision](./docs/decisions/0002-relational-memory-refinement.md)
- [Slice 1 acceptance mapping and verification](./docs/slice-1-verification.md)

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
```

No provider credential is needed for the built-in deterministic `echo` provider. The optional OpenAI-compatible provider reads `OPENAI_API_KEY` in the supervisor only; `OPENAI_BASE_URL` defaults to `https://api.openai.com/v1`.

## Quick start

The CLI stores its local database and CAS under `.agencity/` by default.

```sh
# 1. Create a session (copy sessionId and branchId from the JSON result).
bun run src/cli.ts create --workspace demo

# 2. Chat with the default echo model.
bun run src/cli.ts chat --session <SESSION_ID> --branch <BRANCH_ID> \
  "Summarize what you know"

# 3. Execute a generated-style TypeScript cell. The returned value must be JSON.
bun run src/cli.ts cell --session <SESSION_ID> --branch <BRANCH_ID> \
  'await state.set("answer", { value: 42 }); return await state.get("answer");'

# 4. Inspect or rebuild the deterministic projection.
bun run src/cli.ts history  --session <SESSION_ID> --branch <BRANCH_ID>
bun run src/cli.ts snapshot --session <SESSION_ID> --branch <BRANCH_ID>
bun run src/cli.ts rebuild  --session <SESSION_ID> --branch <BRANCH_ID>

# 5. Open the terminal client.
bun run src/cli.ts tui --session <SESSION_ID> --branch <BRANCH_ID>
```

Use `--restart-console-after-cell` to exercise the recovery invariant continuously. Use `--state-dir`, `--db`, `--artifacts`, and `--workspace-root` to change local placement. Full CLI/TUI instructions are in the [operator guide](./docs/operator-guide.md).

## HTTP and event protocol

```sh
bun run src/cli.ts serve --port 3131
curl http://127.0.0.1:3131/health
```

The protocol supports session creation, user messages, model turns, console cells, forks, snapshots, history, resumable server-sent events, scoped memory, refinement/approval/rollback, exact-version skill execution, and specification-pinned subagents. A consumer loads a snapshot, remembers its cursor, then connects to the stream with `?after=<cursor>` and deduplicates by event ID. Notifications are at-least-once hints over the durable database stream. See [Protocol and console SDK](./docs/protocol.md).

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
await supervisor.appendMessage(session.sessionId, session.branchId, "user", "Hello");
await supervisor.memory.create(session.sessionId, session.branchId, {
  text: "This workspace verifies releases with bun run verify",
  scope: "workspace",
  tags: ["release"],
});
console.log(await supervisor.memory.search(session.sessionId, session.branchId, "release verify"));
console.log(await supervisor.modelLoop.turn(session.sessionId, session.branchId));
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

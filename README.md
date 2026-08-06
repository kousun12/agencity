# Agencity — recoverable Bun/LibSQL agent runtime

Agencity is the Delivery Slice 1 implementation described by the [Prime Agent TypeScript/Turso rewrite PRD](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md). It runs one durable agent against a local LibSQL database. Canonical events, explicitly checkpointed working values, and content-addressed artifacts survive process and console-worker restarts; the Bun heap does not.

> **Security boundary:** Slice 1 is **trusted-local only**. Model-generated TypeScript and shell commands have the operating-system authority of the runtime. The separate Bun console worker provides crash isolation, **not a security sandbox**. The HTTP server has no authentication. Run only trusted workloads, keep it loopback-only, or put the entire runtime inside an independently managed sandbox. See [Security](./docs/security.md).

## Slice 1 status

Implemented foundations include the append-only event store, deterministic projection and branch history, disposable TypeScript console, typed working state, local content-addressed artifacts, durable effect outbox, shell/file/model executors, context provenance, budgets, snapshots/history/SSE, and a basic TUI. This is not the whole PRD. Recursive sessions, relational memory and harness refinement, Turso Cloud synchronization, PostgreSQL, semantic retrieval, remote artifacts/executors, and a hostile-code sandbox are not implemented. The exact acceptance status and gaps are in [Slice 1 verification](./docs/slice-1-verification.md).

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

The protocol supports session creation, user messages, model turns, console cells, forks, snapshots, history, and resumable server-sent events. A consumer loads a snapshot, remembers its cursor, then connects to the stream with `?after=<cursor>` and deduplicates by event ID. Notifications are at-least-once hints over the durable database stream. See [Protocol and console SDK](./docs/protocol.md).

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
- [Slice 1 acceptance mapping and verification](./docs/slice-1-verification.md)

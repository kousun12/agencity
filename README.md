# Agencity

Agencity is a terminal-first autonomous agent runtime for work that may outlive one model context, terminal, or process. It keeps agent sessions, tasks, branches, tool effects, subagents, and evidence in a durable local event history—an append-only sequence of records. Generated work runs through disposable TypeScript cells, while committed state can be inspected and resumed after restart.

A **session** is a durable agent identity. A **branch** is one retained line of that session's history. An **effect** is an external action such as a model call, shell command, or file operation. Agencity records effect intent before execution and keeps success, failure, cancellation, and uncertainty distinct.

## Trust warning

Agencity is **trusted-local software, not a hostile-code sandbox**. Model-generated TypeScript, shell commands, and installed skills have the operating-system authority of the Agencity process. The separate Bun worker provides crash isolation only.

Run Agencity with a minimally privileged OS account or place the entire runtime inside an independently managed sandbox when the workspace or generated code is not fully trusted. Keep protocol surfaces on loopback. See [Security](./docs/security.md).

## Install and first run

Requirements:

- [Bun](https://bun.sh/) 1.2 or newer
- a trusted local repository or an external sandbox around the whole runtime

The package is private and is not published to a registry or standalone binary channel. Supported use is from a source checkout:

```sh
git clone <repository-url> agencity
cd agencity
bun install --frozen-lockfile
bun run dev -- --version
```

For an `agencity` command on `PATH`, link that installed checkout:

```sh
bun link
export PATH="$HOME/.bun/bin:$PATH"
cd /path/to/a/repository
agencity
```

On the first interactive launch without a usable provider, Agencity asks you to choose OpenAI, Anthropic, or Vercel AI Gateway, accepts the API key through hidden terminal input, and asks for the canonical `creator/model` ID before creating a session. Stored keys live in an owner-only profile `auth.json`; environment credentials remain supported fallbacks.

Model execution uses the Vercel AI SDK for Gateway, direct OpenAI, and direct Anthropic transports. `/effort` selects a durable reasoning level for the current idle branch, and `--effort LEVEL` selects it for new work. Agencity uses the public Gateway catalog for model capacity, pricing, and reasoning metadata; stale or unverified capability data remains visible.

There is no product demo mode or credential-free fallback. Echo is an internal deterministic test provider and is unavailable in product selection. Non-interactive new work fails with setup guidance until a provider and model are configured.

See [Installation](./docs/install.md) and [Configuration](./docs/configuration.md).

## Core behavior

From a repository:

```sh
agencity
agencity "find and fix the flaky test"
agencity run "inspect the repository and report the result"
```

Agencity:

- discovers the nearest repository root and creates or resumes named work without requiring internal IDs;
- keeps the branch's model explicit and never silently changes it on resume;
- asks the model for a validated, structured next action: a TypeScript cell, clarification, permission request, final answer, blocked result, or failure;
- runs file, shell, SQL, model, subagent, memory, skill, and artifact operations through durable runtime APIs;
- commits each action and observation before a dependent model step;
- retains child agents, messages, goals, completion checks, budgets, and unresolved outcomes;
- opens a full-screen terminal client on interactive terminals and a readable transcript for non-interactive use; and
- starts an authenticated local-machine-only workspace service on demand so detached work can continue independently of the client.

When the current agent has retained direct children, the full-screen client keeps a compact family summary above the footer. With an empty composer, press Down to focus it, Enter or Right to open the child browser, and Up or Down to select a child. Enter or Right opens that child's conversation; Left from an empty child composer returns to the exact retained parent branch. Opening another family member is observational: it does not cancel, resume, retry, or change the workspace's remembered root selection.

Useful commands:

```sh
agencity sessions
agencity resume "session or branch name"
agencity branch head "experiment"
agencity history current
agencity run --detach "continue after this terminal closes"
agencity attach
agencity agents
agencity doctor
agencity service status
```

The default workspace database is `<repository>/.agencity/agent.db`. Large or byte-oriented results are stored separately in `<repository>/.agencity/artifacts/` and referenced by a SHA-256 content fingerprint. The product profile defaults to `~/.agencity/profile.db`.

Closing a client detaches; it does not prove that durable or external work stopped. Use `/stop` in the terminal interface or `agencity stop TARGET` for explicit cancellation.

## Recovery and uncertainty

Committed work is reconstructed from retained events rather than a live TypeScript heap. Work declared safe to repeat may resume after a crash. If an external action is not safe to repeat and may have happened without a committed result, Agencity records an `unknown` effect and does not retry it automatically.

```sh
agencity unknown
agencity reconcile latest still_unknown "provider audit was inconclusive"
```

Reconciliation appends evidence without rewriting the unknown outcome or triggering a retry. Missing artifacts, failed completion checks, sync conflicts, unavailable providers, and partial deletion also remain visible.

## Important limitations

- This is not a complete production-ready autonomous product.
- Generated code is not isolated from the host operating system.
- The product-managed service is local and on-demand, not an OS login service or a multi-tenant server.
- Distributed leases, task stealing, and automatic cross-device execution-owner failover are unavailable.
- Arbitrary external effects are not exactly-once.
- Optional Turso synchronization exchanges never-rewritten event envelopes; it does not replace the authoritative local workspace database or replicate artifact bytes.
- The shipped CLI has no production Turso Cloud administrative-deletion adapter.
- PostgreSQL coordination, embedding retrieval, browser execution, artifact garbage collection, and hostile-code isolation are unavailable.
- Export bundles do not have a general import or supported round-trip restore command.
- Installation is limited to the tested source-checkout and local-link workflows.

See [Capabilities](./docs/capabilities.md) and [Data lifecycle](./docs/data-lifecycle.md).

## Verification

The default deterministic gate is:

```sh
bun install --frozen-lockfile
bun run verify
```

It runs type checking, architecture checks, the core test suites, and linked-executable acceptance tests. External provider, official Turso server, and real Turso Cloud checks are credential- or dependency-gated and may be skipped. A skipped external check is not evidence that the integration passed.

See [Verification](./docs/verification.md) and [Installation](./docs/install.md) for the tested executable workflows.

## Documentation

Start with the [documentation map](./docs/README.md).

- Get started: [Installation](./docs/install.md), [User guide](./docs/user-guide.md), [Configuration](./docs/configuration.md)
- Operate: [Operator runbook](./docs/operator-guide.md), [Recovery](./docs/recovery.md), [Security](./docs/security.md), [Data lifecycle](./docs/data-lifecycle.md)
- Integrate: [TypeScript API](./docs/api.md), [Protocol](./docs/protocol.md), [Console SDK](./docs/console-sdk.md)
- Understand: [Architecture](./docs/architecture.md), [Capabilities](./docs/capabilities.md), [Decisions](./docs/decisions/README.md)

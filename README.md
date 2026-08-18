# Agencity

Agencity is a terminal-first autonomous agent runtime for work that may outlive one model context, terminal, or process. It keeps agent sessions, tasks, branches, tool effects, subagents, and evidence in a durable local event history—an append-only sequence of records. Generated work runs in an exact-branch TypeScript REPL whose bindings remain available while its worker lives, while committed state can be inspected and resumed after restart.

A **session** is a durable agent identity. A **branch** is one retained line of that session's history. An **effect** is an external action such as a model call, shell command, or file operation. Agencity records effect intent before execution and keeps success, failure, cancellation, and uncertainty distinct.

## Trust warning

Agencity is **trusted-local software, not a hostile-code sandbox**. Model-generated TypeScript, shell commands, and installed skills have the operating-system authority of the Agencity process. The separate Bun worker provides crash isolation only.

Run Agencity with a minimally privileged OS account or place the entire runtime inside an independently managed sandbox when the workspace or generated code is not fully trusted. Keep protocol surfaces on loopback. See [Security](./docs/security.md).

## Install and first run

Requirements:

- [Bun](https://bun.sh/) 1.3.13 or newer
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

On the first interactive launch that needs a provider or model, Agencity opens keyboard-driven provider and model selectors. Type to search provider names or fuzzy-search model display names and canonical `creator/model` IDs, use Up/Down to move, Enter to confirm, Backspace to edit, and Escape to cancel. A valid canonical ID typed exactly appears as an explicit manual row when it is not listed, including when catalog loading is unavailable. Direct OpenAI selection is limited to `openai/...`, direct Anthropic to `anthropic/...`, while Gateway accepts any valid creator namespace. Catalog display names are presentation only; the confirmed canonical ID is the durable model identity.

When setup needs a credential, Agencity reads it through hidden terminal input and stores it in an owner-only profile `auth.json`; environment credentials remain supported fallbacks. Catalog discovery loads the configured Gateway-compatible `/v1/models` endpoint without sending a provider credential or making an inference request. A failed refresh uses a visibly stale cache when available; unavailable and empty results retain exact manual entry. Catalog presence does not prove credentials, execution availability, reasoning support, or support for Agencity's fixed tools.

Model execution uses the Vercel AI SDK for Gateway, direct OpenAI, and direct Anthropic transports. New selections known not to support the fixed `bun_console` and `finish` contract are rejected before a model preference, root, or branch model change is written; unknown exact-model capability remains admissible and visible. `/model` provides the same fuzzy matching, creator filtering, and manual canonical-ID rows on an existing branch, with its own branch-attached controls. `/effort` selects a durable reasoning level for the current idle branch, and `--effort LEVEL` selects it for new work.

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
- uses one fixed formal model-tool set: `bun_console` for a validated TypeScript cell and `finish` for a successful, blocked, or failed result;
- runs file, shell, SQL, model, subagent, memory, skill, and artifact operations through durable runtime APIs, while one exact-branch TypeScript environment keeps top-level bindings alive as long as its worker remains resident;
- commits each action and observation before a dependent model step;
- keeps automatic observations bounded, spills recoverable large local output to immutable artifacts, and exposes file pages and artifact byte ranges for focused continuation;
- retains child agents, messages, goals, completion checks, budgets, and unresolved outcomes;
- enables bounded automatic learning for a device profile with no explicit preference, while preserving a persistent device-wide pause and local-only governed targets;
- opens a full-screen terminal client on interactive terminals and a readable transcript for non-interactive use; and
- starts an authenticated local-machine-only workspace service on demand so detached work can continue independently of the client; it exits after one hour of quiescence by default.

`bun_console` and `finish` are declaration-only provider response tools. They have no execute callbacks and do not run at the provider. Only an accepted `bun_console` call can lead to execution, after validation and durable action commit. The `tools`, `sql`, `state`, `ai`, `sdk`, memory, agent, skill, and artifact surfaces exist inside that later console cell; they are not provider tools. Every autonomous model step must return exactly one formal call. Supplemental narration is diagnostic only, and Agencity has no text-JSON or fenced-code fallback.

Inside a cell, ordinary TypeScript handles deterministic work. `ai.generateText` and `ai.generateObject` each make one raw provider request over only the explicit prompt/messages and bounded context supplied by that call; they cannot inspect files, run tools, use skills, read ambient branch context, or continue autonomously. `sdk.agents.run` waits for a full child agent and returns text or schema-validated object data. `sdk.agents.spawn` starts the same durable child lifecycle and returns a handle immediately; `handle.result(options)` and `sdk.agents.result(handle, options)` retrieve the same lifecycle or terminal result later. The bound method is worker-local and is not serialized with the durable JSON handle. `runMany` and `spawnMany` are bounded independent fan-out, not durable orchestration for dependent steps. Structured validity does not prove facts, completion, safety, or authority.

Top-level variables, functions, classes, imports, and object identity remain available across cells while the exact-branch worker lives. Use `state` for small values required after recovery, artifacts for larger durable bytes, and a compact final expression for the next model decision. The in-memory environment is noncanonical: it is not synchronized, exported, supplied automatically to model context, accepted as completion evidence, or guaranteed after cancellation, memory recycling, restart, or service loss.

A successful `finish` message is published only after required completion gates pass. Blocked and failed finishes atomically retain their exact assistant message and terminal status. Missing information ends the current run as blocked; a later user message starts an ordinary new run on the same branch.

When the current agent has retained direct children, the full-screen client keeps a compact family summary above the footer. With an empty composer, press Down to focus it, Enter or Right to open the child browser, and Up or Down to select a child. Enter or Right opens that child's conversation; Left from an empty child composer returns to the exact retained parent branch. Opening another family member is observational: it does not cancel, resume, retry, or change the workspace's remembered root selection.

Left from an empty top-level root composer opens the workspace Agents view. `/agents` opens the same view from any live conversation. It shows retained root branches grouped by exact status, supports search and keyboard selection, and keeps failed or archived roots visible as non-resumable. Ctrl-N creates a new root session with the current model configuration and opens it immediately. Opening a resumable row or creating a root changes the remembered workspace selection, so the next no-argument `agencity` resumes that root. The catalog refreshes when opened or with Ctrl-R; it does not poll continuously.

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

Each session has one immutable-versioned behavioral profile. Inspect or govern the selected route without copying internal IDs:

```sh
agencity profile show
agencity profile history
agencity profile proposals
agencity profile propose '{"role":"Repository maintainer","purpose":"Maintain this repository","instructions":"Preserve attributable evidence.","reason":"Clarify standing responsibility","predictedEffect":"More consistent repository work","wait":true}'
agencity profile repropose latest '{"role":"Repository maintainer","purpose":"Maintain this repository","instructions":"Preserve attributable evidence and report unresolved risks.","reason":"Address the retained rejection","predictedEffect":"More complete risk reporting"}'
agencity profile rollback 1 '{"reason":"Restore the earlier approved behavior"}'
```

The TUI exposes the same route-relative flow through `/profile`. Proposals are validated deterministically, reviewed by one separate sealed reviewer using the current route model, revalidated, and applied automatically only when approved. Rejections, failures, unknown outcomes, conflicts, reasons, and revision guidance remain visible; detached proposals deliver one durable terminal notice. Profile and non-skill changes apply atomically, while skills must also compile and pass declared runtime tests before activation. Approval establishes consistency with the pinned governance policy, not proof that outcomes improved.

Automatic learning is on when the device profile has no explicit preference. `agencity refine pause` stores a persistent pause for that device profile across its workspaces; `agencity refine resume` resumes new automatic reviews. Compatible `auto off|on` commands remain available. Automatic changes remain local to the originating session and can target only memory, prompt notes, tested skills, or subagent specifications. Each proposal still receives deterministic validation and one separate sealed review. `refine status`, `history`, and `inspect` expose an attributable learning log; `refine rollback` atomically reverses one applied automatic proposal, including creation, replacement, retirement, and multi-edit changes. The log is audit activity, not a human approval queue.

The default workspace database is `<repository>/.agencity/agent.db`. Large or byte-oriented results are stored separately in `<repository>/.agencity/artifacts/` and referenced by a SHA-256 content fingerprint. The product profile defaults to `~/.agencity/profile.db`.

Shell and file helpers return an explicit completeness envelope. Complete inline values are under `.value`; larger shell output has a bounded head/tail preview and, when local spill succeeds, an artifact with exact range guidance. File continuation uses one-based line pages and a digest precondition. Artifact continuation uses zero-based half-open ranges up to 64 KiB. A successful command with `truncated` output does not claim that complete output was retained.

Closing a client detaches; it does not prove that durable or external work stopped. Use `/stop` in the terminal interface or `agencity stop TARGET` for explicit cancellation.

## Recovery and uncertainty

Committed work is reconstructed from retained events rather than a live TypeScript heap. Missing in-memory bindings must be rebuilt from state, artifacts, files, retained cells, or other durable inputs without replaying unsafe effects. Work declared safe to repeat may resume after a crash. If an external action is not safe to repeat and may have happened without a committed result, Agencity records an `unknown` effect and does not retry it automatically.

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
- Workspace-charter and user-constraint governance configuration, caller-selected reviewers, and an organization control plane are unavailable.
- Export bundles do not have a general import or supported round-trip restore command.
- Installation is limited to the tested source-checkout and local-link workflows.

See [Capabilities](./docs/capabilities.md) and [Data lifecycle](./docs/data-lifecycle.md).

## Verification

The default deterministic gate is:

```sh
bun install --frozen-lockfile
bun run benchmark:context-efficiency
bun run verify
```

It runs type checking, architecture checks, the core test suites, and linked-executable acceptance tests. External provider, official Turso server, and real Turso Cloud checks are credential- or dependency-gated and may be skipped. A skipped external check is not evidence that the integration passed.

See [Verification](./docs/verification.md) and [Installation](./docs/install.md) for the tested executable workflows.

The isolated [`benchmarks/prime/`](./benchmarks/prime/README.md) project evaluates
Agencity as a Verifiers v1 harness on catalog-backed Terminal-Bench 2,
Terminal-Bench 2.1, SWE-bench Pro public, and OOLONG tasksets. It supports
deterministic smoke, sample, shard, and full-compatible selections and preserves
official scoring. Suite-capable infrastructure is not a claim that a paid
full-suite run or matched harness comparison has completed.

## Documentation

Start with the [documentation map](./docs/README.md).

- Get started: [Installation](./docs/install.md), [User guide](./docs/user-guide.md), [Configuration](./docs/configuration.md)
- Operate: [Operator runbook](./docs/operator-guide.md), [Recovery](./docs/recovery.md), [Security](./docs/security.md), [Data lifecycle](./docs/data-lifecycle.md)
- Integrate: [TypeScript API](./docs/api.md), [Protocol](./docs/protocol.md), [Console SDK](./docs/console-sdk.md)
- Understand: [Architecture](./docs/architecture.md), [Capabilities](./docs/capabilities.md), [Decisions](./docs/decisions/README.md)

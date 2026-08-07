# Installation and executable workflows

Agencity requires Bun 1.2 or newer. `agencity --version` reports both the application version and the active Bun runtime, and ordinary commands fail before opening state when Bun is unsupported.

## Source checkout

```sh
git clone <repository-url> agencity
cd agencity
bun install --frozen-lockfile
bun run dev
# Arguments are forwarded to the same product entrypoint:
bun run dev -- "inspect this repository"
```

`bun run dev`, `bun run src/cli.ts`, and the executable aliases all invoke `src/cli.ts`; there is no separate development behavior.

## Supported local link

This repository is private and is **not published to a package registry**. After installing dependencies in a source checkout, Bun's link workflow installs the declared executable into `~/.bun/bin`:

```sh
cd /absolute/path/to/agencity
bun install --frozen-lockfile
bun link
export PATH="$HOME/.bun/bin:$PATH"   # put this in your shell setup if needed
cd /path/to/another/repository
agencity --version
agencity --demo                      # explicit fixture mode
```

The link points at the checkout. Keep that checkout and its `node_modules` available, including the platform-specific OpenTUI package installed by Bun. Runtime assets are resolved relative to the executable module rather than the caller's working directory, so the command and full-screen interactive renderer work from another repository. The checked-in `src/cli.ts` target has Git mode `100755`; `bun link` is expected to produce a directly executable link without a post-install `chmod`. An archive, copy, or packaging process that drops that executable bit is not a valid installation. Re-run `bun install` and `bun link` if the checkout is moved. Use `bun unlink` according to Bun's documentation to remove the registration.

For isolated verification or CI, choose a temporary Bun install root:

```sh
BUN_INSTALL=/tmp/agencity-bun bun link --cwd /absolute/path/to/agencity
PATH=/tmp/agencity-bun/bin:$PATH agencity --version
```

## First invocation, workspace identity, and task escaping

The linked and source entrypoints use the same workspace rules. First open writes an owner-only `.agencity/workspace-id` atomically. The marker moves with the repository, symlink paths resolve to the same identity, and a pre-marker database is migrated once. Startup rejects a symlinked, insecure, or malformed marker instead of regenerating identity.

Exact product command names keep their command meaning. To use one as task text, either quote a multi-word first argument or put `--` before it:

```sh
agencity "run the benchmark"   # one task argument, not the run command
agencity -- run the benchmark  # explicit task escape
```

Natural-language text after a legacy word is also a task (`agencity create a parser`); ID-bearing diagnostic forms such as `agencity chat --session ... --branch ... TEXT` remain commands.

## Published and standalone status

There is currently no supported registry or standalone binary channel. Do not use or document `bun add -g @prime-agent/runtime` as a released installation. The source and linked workflows above are the supported methods until a published artifact has its own clean installation test.

## Provider setup

A real model is never replaced silently by Echo. In the interactive TUI, `/model` lists the supported providers and their credential status. Store an API key with hidden input, then select any model exposed by that provider:

```sh
/model login openai
/model openai:gpt-5.6-sol

/model login anthropic
/model anthropic:fable-5

/model login vercel
/model vercel:openai/gpt-5.6-sol
```

Stored keys live in the owner-only profile `auth.json`, separate from profile preferences and canonical workspace history. `/model logout PROVIDER` removes the stored key. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `AI_GATEWAY_API_KEY` remain supported as process-environment fallbacks; a stored key takes precedence. `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, and `AI_GATEWAY_BASE_URL` may override their corresponding endpoints.

Model identifiers use `provider:model`, so a provider-specific model ID may contain `/`. Anthropic shorthand such as `anthropic:fable-5` is normalized once to the durable and wire-visible `anthropic:claude-fable-5`; Vercel gateway IDs pass through unchanged. `--model PROVIDER:MODEL` selects the same format outside the TUI and persists only the non-secret identifier. `agencity config credential-ref PROVIDER HANDLE LABEL` remains an opaque-reference facility and never stores the referenced value. Echo is a deterministic demo/test fixture and requires `--demo` or a visibly labeled interactive choice.

## Release acceptance from an isolated link

FU-009 release verification never invokes the checkout entry module directly. Each case creates a fresh temporary `HOME` and repository, runs `bun link` with an isolated `BUN_INSTALL`, and invokes that linked `agencity` executable from outside this checkout. A source guard rejects implementation imports, direct runtime clients, LibSQL access, diagnostic session/branch options, and caller-supplied history positions in `test/acceptance/`.

```sh
bun run test:acceptance
bun run test:acceptance:matrix
```

The deterministic suite starts an external loopback OpenAI-compatible endpoint that speaks the strict version-1 action protocol and SSE. It covers missing-provider behavior, explicit model configuration, coding cells and effects, recursive and retained-child work, failed-gate repair, detach/reattach, named head branching, history/tree/status, interruption, recovery, unknown outcomes without retry, reconciliation evidence, refinement, skill installation/testing, compaction, streaming, and scheduled wakes.

The matrix reports `PASS`, `FAIL`, and `SKIP` separately. Live integrations are opt-in:

```sh
AGENCITY_ACCEPTANCE_REAL_PROVIDER=1 OPENAI_API_KEY=... AGENCITY_ACCEPTANCE_REAL_MODEL=... OPENAI_BASE_URL=https://provider.example/v1   bun run test:acceptance:matrix

TURSO_SYNC_SERVER_BIN=/absolute/path/to/tursodb   bun run test:acceptance:matrix
```

The real-provider row is `SKIP` unless explicitly enabled with a key and model. The official Turso row is `SKIP` without the external binary, and the real Turso Cloud row remains separately gated by `AGENCITY_TURSO_SMOKE=1` plus disposable credentials. A skipped row is not a pass.

## Security boundary

All workflows are trusted-local. Model-generated TypeScript and shell commands have the OS authority of the `agencity` process. Linking or installing the executable does not add a hostile-code sandbox.

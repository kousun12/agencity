# Installation

Agencity requires Bun 1.3.13 or newer. `agencity --version` reports the application version and active Bun runtime. Ordinary commands refuse to open state when the Bun version is unsupported.

The package is private. It is not published to a package registry and has no supported standalone binary channel. The supported installation paths are a source checkout and a Bun link to that checkout.

## Source checkout

```sh
git clone <repository-url> agencity
cd agencity
bun install --frozen-lockfile
bun run dev
```

Arguments after `--` go to the normal product entrypoint:

```sh
bun run dev -- "inspect this repository"
bun run dev -- --version
```

`bun run dev`, `bun run src/cli.ts`, and the executable aliases invoke the same `src/cli.ts` entrypoint. There is no separate development product behavior.

## Local link

After installing dependencies, register the executable with Bun:

```sh
cd /absolute/path/to/agencity
bun install --frozen-lockfile
bun link
export PATH="$HOME/.bun/bin:$PATH"

cd /path/to/another/repository
agencity --version
agencity
```

`bun link` exposes both declared executable names, `agencity` and the compatibility alias `prime-agent-ts`, under Bun's install bin directory, normally `~/.bun/bin`.

The link points to the source checkout. Keep that checkout, its `node_modules`, and the platform-specific OpenTUI dependency available. Runtime assets are resolved relative to the executable module, so the command can run from another repository.

The checked-in `src/cli.ts` has executable Git mode `100755`. A packaging or copy process that drops that bit is not a valid installation. No manual `chmod` is part of the supported workflow.

Re-run `bun install` and `bun link` if the checkout moves. Use Bun's `bun unlink` workflow to remove the registration.

## Isolated link for CI

Use a temporary Bun install root when verification must not modify the normal user installation:

```sh
BUN_INSTALL=/tmp/agencity-bun bun link --cwd /absolute/path/to/agencity
PATH=/tmp/agencity-bun/bin:$PATH agencity --version
```

The black-box acceptance suite uses this pattern from fresh repositories and temporary home directories. It invokes the linked executable from outside the checkout instead of importing runtime internals.

## First run

Run `agencity` inside the repository where the agent should work:

```sh
cd /path/to/repository
agencity
```

Agencity discovers the nearest `.agencity` or `.git` root. The first open creates an owner-only `.agencity/workspace-id` marker atomically. The marker moves with the repository, and canonical path resolution makes symlink aliases converge. Startup rejects a symlinked, insecure, malformed, or wrongly owned marker.

Without a usable provider, an interactive first run:

1. opens a searchable keyboard picker for OpenAI, Anthropic, or Vercel AI Gateway;
2. reads the API key through hidden terminal input; and
3. loads the configured Gateway-compatible catalog and opens a searchable model picker before creating work.

Type to filter provider display names and IDs. In the model picker, fuzzy search covers both catalog display names and canonical `creator/model` IDs. Up/Down moves the highlighted row, Enter confirms it, Backspace edits, and Escape cancels. A valid canonical ID typed exactly appears as a selectable manual row when it is absent from the catalog or catalog loading is unavailable. Direct OpenAI shows and accepts only `openai/...` models, direct Anthropic only `anthropic/...` models, and Gateway accepts any valid creator namespace. Catalog display names are not durable identity; the selected canonical ID is retained.

Catalog retrieval uses the configured `AI_GATEWAY_BASE_URL`-compatible `/v1/models` endpoint without a provider credential and makes no inference request. A failed refresh may use a visibly stale cache. Unavailable or empty catalog results do not disable manual canonical-ID entry, and a listed model is not proof that provider execution or Agencity's formal tools will work.

After startup, `/model` opens the branch-attached provider and model inspector. It uses the same fuzzy matching, creator filtering, and explicit manual rows, while retaining its own controls: Up/Down selects a provider, `L` enters a key, `X` removes a saved key, and Enter opens or confirms the selected row.

Direct commands remain available:

```text
/model login openai
/model openai:openai/gpt-5.6-sol

/model login anthropic
/model anthropic:anthropic/claude-fable-5

/model login vercel
/model vercel:openai/gpt-5.6-sol
```

Stored provider keys live in the owner-only profile `auth.json`, separate from profile preferences and canonical workspace history. Environment fallbacks are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `AI_GATEWAY_API_KEY`. A stored key takes precedence.

The model identifier uses `provider:creator/model`; the model portion is the canonical Vercel AI Gateway catalog ID. `--model PROVIDER:CREATOR/MODEL` and optional `--effort LEVEL` select a model configuration for new work. Non-interactive new work fails with setup guidance until both a usable credential and model are available.

Cancelling after a key has been stored leaves that credential in place but creates no session and writes no model preference. Confirming a model writes the workspace preference before root creation; if the later root request fails or its dispatched outcome is unconfirmed, that confirmed preference can remain. Inspect `agencity agents` before retrying an unconfirmed root request.

There is no product demo mode or credential-free provider fallback. Internal deterministic providers are test-only and cannot be selected through the product CLI or `/model`.

See [Configuration](./configuration.md) for provider, model, endpoint, path, and precedence details.

## Task text that looks like a command

Exact product command names keep their command meaning. Use one quoted task argument or a leading `--` when the task begins with a command word:

```sh
agencity "run the benchmark and explain it"
agencity -- run the benchmark and explain it
```

## Verify the checkout

The deterministic repository gate is:

```sh
bun install --frozen-lockfile
bun run verify
```

It runs type checking, architecture validation, core tests, and black-box acceptance through an isolated linked executable.

The focused executable suites are:

```sh
bun run test:acceptance
bun run test:acceptance:matrix
```

The deterministic acceptance endpoint is an external loopback OpenAI Responses-compatible fixture that implements `/v1/responses`, typed actions, and Responses streaming events. Coverage includes provider setup failure, explicit model configuration, TypeScript cells and effects, retained child work, completion-gate repair, detach and reattach, branching, history, interruption, recovery, unknown outcomes without automatic retry, refinement, skills, compaction, streaming, and scheduled wakes.

## Gated external verification

External checks are opt-in. They must report `PASS`, `FAIL`, and `SKIP` separately. A skipped check is not evidence that the integration passed.

Real provider:

```sh
AGENCITY_ACCEPTANCE_REAL_PROVIDER=1 \
OPENAI_API_KEY=... \
AGENCITY_ACCEPTANCE_REAL_MODEL=... \
bun run test:acceptance:matrix
```

`OPENAI_BASE_URL` may point the provider row at a compatible endpoint.

Official Turso Sync server:

```sh
TURSO_SYNC_SERVER_BIN=/absolute/path/to/tursodb \
bun run test:acceptance:matrix
```

Real Turso Cloud requires a disposable database:

```sh
AGENCITY_TURSO_SMOKE=1 \
TURSO_DATABASE_URL=... \
TURSO_AUTH_TOKEN=... \
bun run test:acceptance:matrix
```

The real-provider row is skipped unless explicitly enabled with a key and model. The official Turso row is skipped without the external binary. The Cloud row is skipped unless explicitly enabled with disposable credentials.

## Trust boundary

Installing or linking Agencity does not add a sandbox. Model-generated TypeScript, shell commands, and installed skills have the OS authority of the Agencity process. Run only trusted work or place the entire runtime inside an independently managed sandbox.

Continue with the [User guide](./user-guide.md) and [Security](./security.md).

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

The link points at the checkout. Keep that checkout and its `node_modules` available. Runtime assets are resolved relative to the executable module rather than the caller's working directory, so the command works from another repository. The checked-in `src/cli.ts` target has Git mode `100755`; `bun link` is expected to produce a directly executable link without a post-install `chmod`. An archive, copy, or packaging process that drops that executable bit is not a valid installation. Re-run `bun link` if the checkout is moved. Use `bun unlink` according to Bun's documentation to remove the registration.

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

A real model is never replaced silently by Echo. For an OpenAI-compatible endpoint:

```sh
export OPENAI_API_KEY='...'
# Optional; defaults to https://api.openai.com/v1
export OPENAI_BASE_URL='https://provider.example/v1'
agencity --model openai/MODEL_ID
```

The key remains process-local. `--model` persists only the provider/model identifiers. `agencity config credential-ref PROVIDER HANDLE LABEL` stores an opaque handle such as `env:OPENAI_API_KEY`, never the referenced value. Use `agencity doctor` for secret-free provider remediation. Echo is a deterministic demo/test fixture and requires `--demo` or a visibly labeled interactive choice.

## Security boundary

All workflows are trusted-local. Model-generated TypeScript and shell commands have the OS authority of the `agencity` process. Linking or installing the executable does not add a hostile-code sandbox.

# Configuration

This page is the authoritative reference for Agencity's product CLI defaults, path overrides, provider settings, and Turso synchronization settings.

All relative path options are resolved from the command's current working directory. Run `agencity --help` for the current command list.

## Configuration precedence

An explicit command option wins for the operation that accepts it. After that, precedence is setting-specific: provider credentials prefer the stored key over the environment, while new model selection prefers the retained workspace model over a model environment variable. The sections below give the complete order for each setting.

Existing session branches are different: their committed model remains authoritative. `--model` does not silently change a resumed branch; use `agencity new --model PROVIDER:MODEL` for new work.

## Workspace and state paths

### Workspace root

Without an override, Agencity starts at the current directory and walks upward to the nearest directory containing `.agencity` or `.git`. If neither exists, the current directory is the root. Paths are canonicalized so symlink aliases converge.

- On product commands, `--workspace PATH` selects the workspace root directly.
- On product commands, `--workspace-root PATH` is a compatible root override and also sets the initial root for executors.
- Product commands reject using both options together.

Grouped advanced commands use the shared spellings differently: `--workspace ID` supplies the logical workspace ID, while `--workspace-root PATH` supplies the filesystem root. For advanced work against a product workspace, read the logical ID from `<workspace-root>/.agencity/workspace-id` and pass both values when the current directory is not already the root.

The durable workspace identity is always stored at:

```text
<workspace-root>/.agencity/workspace-id
```

This owner-only marker is separate from `--state-dir`. Moving a repository with its `.agencity` metadata preserves the identity. Do not copy the marker into an unrelated repository or edit it manually.

### Product defaults

For ordinary `agencity` product commands:

- state directory: `<workspace-root>/.agencity`
- workspace database: `<state-dir>/agent.db`
- artifact directory: `<state-dir>/artifacts`
- profile database: `~/.agencity/profile.db`
- provider credential file: `~/.agencity/auth.json`
- managed-service manifest: `<workspace-root>/.agencity/service/manifest.json`

Overrides:

- `--state-dir PATH` changes the parent used by the default workspace database and artifact paths.
- `--db PATH` changes the workspace database.
- `--artifacts PATH` changes the content-addressed artifact directory.
- `--profile PATH` changes the profile database. Its credential file is `auth.json` in the same directory.
- `AGENCITY_PROFILE` changes the product profile database when `--profile` is absent.

The profile default is intentionally not derived from the workspace database. The product default is `~/.agencity/profile.db`. Grouped advanced commands and direct `Supervisor.open` calls use an adjacent `<workspace-db>.profile.db` default when no profile path is supplied. Pass `--profile ~/.agencity/profile.db` or `profileDatabaseUrl` when those operations must use the product profile. This is especially important for sync, export, and deletion because ownership and workspace catalog records live in the selected profile.

`--db`, `--artifacts`, and `--profile` do not move the workspace identity marker or managed-service discovery files.

## Provider credentials and models

Agencity's product provider choices are OpenAI, Anthropic, and Vercel AI Gateway. Internal deterministic test providers are not available through product setup.

### Credential sources

Supported variables:

- OpenAI: `OPENAI_API_KEY`
- Anthropic: `ANTHROPIC_API_KEY`
- Vercel AI Gateway: `AI_GATEWAY_API_KEY`

Credentials saved through first-run setup or `/model login PROVIDER` take precedence over the corresponding environment variable. Saved values live in the owner-only profile `auth.json`, not in the profile database, workspace events, artifacts, or command output.

`/model logout PROVIDER` removes the saved value. The environment fallback remains usable if it is still set.

Endpoint overrides:

- `OPENAI_BASE_URL`, default `https://api.openai.com/v1`
- `ANTHROPIC_BASE_URL`, default `https://api.anthropic.com`
- `AI_GATEWAY_BASE_URL`, default `https://ai-gateway.vercel.sh`

These endpoint variables affect provider network destinations. Treat a custom endpoint as part of the same trust boundary as the provider because it receives prompts and model traffic.

### Model selection

Model identifiers use `provider:model`, for example:

```text
openai:gpt-5.6-sol
anthropic:claude-fable-5
vercel:openai/gpt-5.6-sol
```

For new work, selection order is:

1. `--model PROVIDER:MODEL`
2. the workspace-scoped model preference in the profile database
3. the selected provider's model environment variable
4. interactive model entry

Model environment variables are `OPENAI_MODEL`, `ANTHROPIC_MODEL`, and `VERCEL_MODEL`. The Vercel provider uses `VERCEL_MODEL`, not `AI_GATEWAY_MODEL`.

First interactive startup asks for a provider key through hidden input and then asks for the model ID. Non-interactive new work fails when no usable credential and model can be selected.

`agencity config set-model PROVIDER:MODEL` changes the default for new work. `agencity config clear-model` clears that preference. A branch already created with another model retains its committed model.

### Opaque credential references

`agencity config credential-ref PROVIDER REFERENCE LABEL` stores an opaque handle such as `env:OPENAI_API_KEY` or `keychain:item`. It rejects values that look like raw credentials.

A reference records metadata and provenance only. It does not resolve or inject a secret by itself. In particular, Turso network authentication still comes from `TURSO_AUTH_TOKEN` unless a programmatic integration supplies another credential mechanism.

## Turso synchronization

Synchronization is optional. Without a sync URL, the workspace remains local-only and no network exchange is attempted.

Settings:

- `--sync-url URL` selects the Turso database. It takes precedence over `TURSO_DATABASE_URL`.
- `TURSO_DATABASE_URL` supplies the URL when `--sync-url` is absent.
- `TURSO_AUTH_TOKEN` supplies the data-plane token. There is no raw-token CLI option.
- `--replica PATH` selects the local envelope-replica database.
- When sync is configured and `--replica` is absent, the replica defaults to `<workspace-db>.sync-replica.db`.
- `--sync-interval MS` sets the runtime interval. The default is `30000`; `0` disables interval sync.
- `--credential-ref HANDLE` associates an existing profile credential-reference record with replica metadata. It does not replace `TURSO_AUTH_TOKEN`.

The local workspace database remains canonical. The separate replica contains immutable exchange envelopes and synchronization metadata. Network failure records an error and leaves local canonical work available.

Turso data-plane credentials do not grant administrative deletion authority. The shipped CLI has no production Cloud deletion adapter; it refuses deletion when durable history shows a managed remote replica that cannot be deleted through a separately authenticated administrative integration.

## Common product options

- `--new` forces creation of a new root session.
- `--model PROVIDER:MODEL` selects the model for new work.
- `--goal auto|current|create` controls goal selection for a task. `auto` is the default.
- `--completion-gate COMMAND` adds a required shell verification gate to a newly selected goal. It cannot be combined with `--goal current`.
- `--detach` returns after durable run admission while the managed service continues.
- `--json` requests the command's structured output contract.
- `--restart-console-after-cell` stops the disposable TypeScript worker after each cell for recovery diagnostics.
- `--help` and `--version` print help or version information without starting ordinary work.

## Selection and inspection options

- `sessions --select NAME` sets the selected retained session or branch.
- `--session ID` and `--branch ID` select low-level diagnostic identities.
- `--cursor CURSOR` selects a committed historical position for low-level branch operations.
- `--name NAME` names or renames supported session or branch operations.
- `--strategy extractive|summary` selects context compaction or low-level branch context strategy.
- `--from-context CONTEXT_ID` rematerializes an exact retained context source for compaction.
- `--port PORT` selects the loopback port for `debug protocol-serve`; its default is `3131`.

## Sync and data-control options

- `--scope KIND` is command-specific. Data control accepts `workspace`, `session`, or `profile`; skill installation accepts `workspace` or `profile`; skill proposals may use `local` or `workspace`.
- `--scope-id ID` names the owned data-control scope.
- `--destination PATH` is required by `data export`.
- `--confirmation TEXT` carries the exact destructive deletion phrase or a skill source digest, depending on the command.
- `--receipt-dir PATH` selects an external deletion-receipt directory.
- `--requested-by ID` records an attributable operator identity; advanced data control defaults to `cli-owner`.
- `--exclusive-artifacts` asserts that the configured artifact directory is wholly owned by the workspace. Whole-workspace deletion refuses without it.
- `--reconciliation-id ID` supplies a stable unknown-effect assessment identity.
- `--evidence JSON` attaches structured evidence to an unknown-effect assessment.

Options are command-specific even though the shared parser recognizes them globally. An accepted spelling does not imply that every command uses it.

## Trust implications

- Model-generated TypeScript, shell commands, and installed skills run with the OS authority of the Agencity process.
- `--workspace-root` and typed file-path checks are not an operating-system sandbox.
- Provider keys are protected against accidental durable leakage, but trusted code can still use ambient OS access.
- Custom database, artifact, profile, replica, and receipt paths may contain sensitive trajectory data. Protect them with filesystem ownership and backup controls.
- Keep the product-managed service and advanced protocol server on loopback unless an independent authenticated boundary surrounds the entire runtime.

See [Security](./security.md) for the complete boundary and [Data lifecycle](./data-lifecycle.md) before moving, backing up, exporting, or deleting state.

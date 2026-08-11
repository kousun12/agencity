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
- managed-service quiescent shutdown: one hour (`3600000` milliseconds)

Overrides:

- `--state-dir PATH` changes the parent used by the default workspace database and artifact paths.
- `--db PATH` changes the workspace database.
- `--artifacts PATH` changes the content-addressed artifact directory.
- `--profile PATH` changes the profile database. Its credential file is `auth.json` in the same directory.

Writable product startup creates missing parent directories for file-backed
workspace databases, profile databases, and artifact stores. Read-only
observers do not initialize them.
- `AGENCITY_PROFILE` changes the product profile database when `--profile` is absent.

The profile default is intentionally not derived from the workspace database. The product default is `~/.agencity/profile.db`. Grouped advanced commands and direct `Supervisor.open` calls use an adjacent `<workspace-db>.profile.db` default when no profile path is supplied. Pass `--profile ~/.agencity/profile.db` or `profileDatabaseUrl` when those operations must use the product profile. This is especially important for sync, export, and deletion because ownership and workspace catalog records live in the selected profile.

`--db`, `--artifacts`, and `--profile` do not move the workspace identity marker or managed-service discovery files.

The one-hour timeout begins whenever the managed service becomes quiescent. It is not a task timeout or scratch-retention promise. Attached clients, resident managed run-queue work, active runs, pending effects, queued wakes, active schedules, and active heartbeats defer shutdown; warm scratch and an idle console worker do not. Human `service status` formats the default as `1 hour`, while `service status --json` returns exact milliseconds.

There is no product CLI override for the idle timeout. Embedding and deterministic lifecycle tests may set `ManagedServiceConfiguration.idleShutdownMs` within the accepted bounds. The normalized value is included in the service discovery configuration hash. A client using a different default receives `CONFIG_MISMATCH` while the existing owner is live rather than taking ownership or deleting its manifest.

### Initial agent profiles

An agent profile is session-owned workspace state, not a profile-database preference. Ordinary product root creation uses the sealed repository-agent profile. The public TypeScript and HTTP APIs may instead supply a complete `{ role, purpose, instructions }` value when creating a root. Delegated and recursive spawn inputs may supply the same explicit shape and otherwise use the sealed task-specialist profile; specification spawn derives it from the exact specification version.

There is no environment variable or profile-database preference that changes initial-profile templates. Existing sessions retain the exact initial profile committed in workspace history. Route-relative `agencity profile` and `/profile` operations inspect and propose later immutable revisions or restore an exact earlier revision; they do not rewrite the initial version.

### Refinement governance

Governed profile and harness API proposals wait for their terminal result by default. Proposal JSON may set `"wait": false` to detach after durable admission and receive a later route notice. Product `agencity refine` and TUI `/refine` detach by default and accept `--wait`; explicit `--detach` is also accepted and cannot be combined with `--wait`. Both accept `--kind memory,prompt_note,skill,subagent_spec`; `agencity refine` also accepts the existing `--scope` option.

Automatic learning is enabled when the device profile has no explicit preference. `agencity refine auto off` or `/refine auto off` stores an explicit persistent pause in that device profile, affecting every workspace that uses it. `refine auto on` stores the corresponding resume preference. The setting is not session- or workspace-specific, while each resulting proposal remains local to its originating session. An explicit retained preference overrides the default across restart.

One trigger scan admits at most one automatic review. The default policy recognizes three matching failed effects, three failed cells in one exact agent run, two failures of one completion gate against distinct material pins, one typed `UserCorrection`, and five successful terminal runs within a trailing 2,048-record window. The repeated-success trigger may fire again after five newer qualifying successes. Its fifth success is considered at the next committed boundary because terminal status does not itself invoke the scanner. Successful completion is permission to reflect, not evidence that a change is beneficial, and `no_change` is an expected terminal review result.

Automatic proposals are restricted to local memory, prompt notes, tested skills, and subagent specifications. They still use deterministic validation and one separate sealed reviewer. No automatic proposal can revise an agent profile, promote scope, or change connectors, credentials, model or budget configuration, permissions, effect policy, or runtime authority. The product has no separate automatic-learning spend budget, aggregate review-rate limit, durable scheduler, or semantic workflow grouping. Automatic child usage follows ordinary tree-budget and provider-concurrency rules.

The scanner currently loads complete branch history, and the detector rejects more than 10,000 supplied records. A sufficiently large branch therefore reports a nonfatal `scan_unavailable` result instead of admitting new automatic learning.

The reviewer is not configurable by the caller. The supervisor uses the origin route's current model configuration and freezes that dispatch before review. The product constitution and review policy are packaged immutable components. Workspace-charter and user-constraint configuration is unavailable; both fields are retained as `null` rather than inferred from repository files, prompts, or profile preferences. There is no environment variable or CLI option for reviewer identity, governance charter, review policy, reproposal bound, or per-proposal human approval.

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

- `OPENAI_BASE_URL`, default `https://api.openai.com`
- `ANTHROPIC_BASE_URL`, default `https://api.anthropic.com`
- `AI_GATEWAY_BASE_URL`, default `https://ai-gateway.vercel.sh`

These values must be HTTP(S) origins without credentials, a path, query, or fragment. Agencity derives the provider API path from the origin. They affect provider network destinations, so treat a custom endpoint as part of the same trust boundary as the provider because it receives prompts and model traffic.

### Model selection

Model identifiers use `provider:creator/model`, for example:

```text
openai:openai/gpt-5.6-sol
anthropic:anthropic/claude-fable-5
vercel:openai/gpt-5.6-sol
```

The model part is the Vercel AI Gateway catalog's canonical `creator/model` ID for every product transport. Direct OpenAI and Anthropic execution remove the matching creator prefix only when calling the native provider API. A direct transport rejects a model owned by another creator.

For new work, selection order is:

1. `--model PROVIDER:MODEL`
2. the workspace-scoped model preference in the profile database
3. the selected provider's model environment variable
4. interactive model entry

Model environment variables are `OPENAI_MODEL`, `ANTHROPIC_MODEL`, and `VERCEL_MODEL`. The Vercel provider uses `VERCEL_MODEL`, not `AI_GATEWAY_MODEL`.

First interactive startup asks for a provider key through hidden input and then asks for the model ID. Non-interactive new work fails when no usable credential and model can be selected.

`agencity config set-model PROVIDER:MODEL` changes the default for new work. `agencity config clear-model` clears that preference. A branch already created with another model retains its committed model.

### Formal agent-tool capability

Autonomous work requires the selected model and transport to support Agencity's formal `bun_console` and `finish` response contract. Model setup and the model picker report one of four states:

- `provider-strict` — authoritative provider capability constrains the schema and required call; Agencity also validates the result;
- `runtime-validated` — the transport supplies the formal call channel and Agencity enforces schema and cardinality;
- `unknown` — exact-model support is unverified, but the model may be attempted when the transport proves bounded formal-tool streaming; and
- `unavailable` — new autonomous work is rejected before its task message or run is committed.

Credential usability is separate from capability state. Capability inspection uses retained transport/catalog facts and does not call the provider. The shipped product transports prove formal primitives; the public Gateway catalog normally leaves exact-model support `unknown` because it has no authoritative fields for these facts. Do not interpret a shipped transport as proof of provider-strict support for every model.

An unknown model that the provider rejects fails visibly as an unsupported response contract. Agencity does not change reasoning effort, switch transports, downgrade schema enforcement, or fall back to assistant JSON text. A resumed branch retains its committed model; select another model for new work rather than silently changing the existing branch.

### Reasoning effort

Reasoning effort is part of the durable branch model configuration. Supported values are `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`; `default` and `off` are input aliases for `provider-default` and `none`.

- `--effort LEVEL` selects an effort when creating new work.
- `/effort` or `/thinking` opens the current model's keyboard-driven effort inspector.
- `/effort LEVEL` changes the model configuration only at an idle model boundary.
- `/effort refresh` refreshes the Gateway catalog before showing the inspector.
- `agencity config set-effort LEVEL [--model CREATOR/MODEL]` sets the workspace preference for one canonical model.
- `agencity config clear-effort [--model CREATOR/MODEL]` removes that preference.

When `--model` is omitted, the workspace default model is required and supplies the canonical model ID.

An explicit unsupported choice fails. A stale stored preference falls back visibly to `provider-default` rather than silently selecting another non-default level. Preferences are keyed by workspace, normalized Gateway catalog endpoint, and canonical model ID so custom Gateway origins do not share capability assumptions.

Agencity fetches language-model metadata from the Vercel AI Gateway public `/v1/models` catalog and stores a bounded, digest-checked profile cache. Catalog metadata supplies context capacity, output limits, prices, and reasoning choices. Missing reasoning metadata is shown as unverified; it is not treated as proof that a model rejects the standard effort vocabulary. A failed refresh may use a visibly stale cache. It never changes a dispatch already committed for a model call.

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
- `--effort LEVEL` selects reasoning effort for new work.
- `--goal auto|current|create` controls goal selection for a task. `auto` is the default.
- `--completion-gate COMMAND` adds a required shell verification gate to a newly selected goal. It cannot be combined with `--goal current`.
- `--detach` returns after durable run admission while the managed service continues.
- `--json` requests the command's structured output contract.
- `--restart-console-after-cell` stops the disposable TypeScript worker after each cell for recovery diagnostics. Managed exact-file-local composition may restore eligible scratch JSON from its bounded checkpoint; warm-only values disappear.
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

# Operator runbook

This runbook covers health checks, the on-demand workspace service, provider incidents, recovery attention, optional synchronization, backup, export, and deletion. For ordinary task and terminal-interface use, see the [User guide](./user-guide.md). For defaults and precedence, see [Configuration](./configuration.md).

Agencity is trusted-local software. Generated TypeScript, shell commands, and skills have the OS authority of the runtime process. Operate it under a minimally privileged identity or inside an independently managed sandbox.

## Preflight

From the target repository:

```sh
agencity --version
agencity doctor
agencity doctor --json
```

Confirm:

- Bun is version 1.2 or newer.
- The reported workspace root is the intended repository.
- The mode says trusted-local and not sandboxed.
- Required providers are usable.
- The managed service is either stopped or associated with the expected workspace.

`doctor` is observational. Before workspace initialization it does not create the workspace marker, run migrations, recover work, or fire schedules.

The product profile database defaults to `~/.agencity/profile.db`. `--profile PATH` overrides it, and `AGENCITY_PROFILE` applies when `--profile` is absent. Low-level diagnostic commands may otherwise use an adjacent `<workspace-db>.profile.db`; pass `--profile` when they must use the product profile.

## Workspace identity and placement

Agencity discovers the nearest `.agencity` or `.git` directory, canonicalizes its real path, and stores identity in:

```text
<workspace-root>/.agencity/workspace-id
```

The marker must remain owner-only and must not be copied to an unrelated repository. Startup refuses symlinked, malformed, wrongly owned, or group/world-accessible markers instead of creating a second identity.

Product defaults:

```text
workspace database   <workspace-root>/.agencity/agent.db
artifacts            <workspace-root>/.agencity/artifacts/
profile database     ~/.agencity/profile.db
provider keys        ~/.agencity/auth.json
service manifest     <workspace-root>/.agencity/service/manifest.json
```

Use [Configuration](./configuration.md) for path overrides. Record every non-default database, artifact, profile, and replica path in operational inventory and backup policy.

## Managed workspace service

There is no explicit start command. Ordinary product operations discover or start one authenticated loopback service for the workspace:

```sh
agencity
agencity attach
agencity run --detach "continue the queued work"
```

Inspect it with:

```sh
agencity service status
agencity service status --json
```

The status reports lifecycle, recovery, attached clients, idle deadline, retained roots, and reasons the service remains resident. Active runs, pending effects, queued wakes, schedules, heartbeats, resident workers, and clients can keep it alive. A run waiting only for user input does not.

The service normally exits 60 seconds after becoming quiescent. It is not registered as an OS boot or login service.

### Graceful shutdown

```sh
agencity service shutdown
```

Shutdown stops new admission, drains admitted protocol handlers and resident workers, stops schedulers, releases local execution leases, and preserves sessions. It does not mean "cancel all work" and does not delete data.

Use shutdown before raw backups, runtime upgrades, path changes, environment-only credential changes, or advanced database operations. Confirm no separate diagnostic process is using the same database.

### Service authority conflict

If status reports a conflict:

1. Confirm the command is running from the expected canonical workspace root.
2. Check whether another live Agencity process owns the workspace.
3. Allow a healthy owner to finish or shut it down through `agencity service shutdown`.
4. Do not delete the service manifest to bypass a live lease.
5. If the prior owner is gone, retry after the retained lease expires; startup validates the process, manifest, workspace identity, configuration hash, and authenticated health together.

## Observe and control work

```sh
agencity sessions
agencity agents
agencity status current
agencity history current
agencity tree
```

`agencity agents` lists names and diagnostic identities for work known to the resident service. Use a unique name or reported identity for targeted operations:

```sh
agencity status TARGET
agencity attach TARGET
agencity send TARGET "new operator guidance"
agencity stop TARGET
```

`stop` commits cancellation intent and reconciles the run at a durable boundary. Closing a terminal, Ctrl-D, `/quit`, and `/exit` only detach. With an active TUI run, the first Ctrl-C requests cancellation and the second detaches.

## Provider and model incidents

Inspect provider status without exposing keys:

```sh
agencity doctor --json
agencity config
```

Interactive setup:

```text
/model
/model login openai
/model logout openai
/model openai:gpt-5.6-sol
```

On first interactive launch with no usable provider, Agencity asks for OpenAI, Anthropic, or Vercel AI Gateway, accepts the key through hidden input, and asks for the exact model ID.

Saved keys take precedence over `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `AI_GATEWAY_API_KEY`. Endpoint overrides are `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, and `AI_GATEWAY_BASE_URL`. A service already running keeps its inherited environment; shut it down before relying on changed environment variables.

Never place raw keys in events, prompts, task text, workspace files, artifacts, profile preferences, opaque-reference labels, or incident logs. The owner-only `auth.json` is a local credential file, not a hostile-code secret vault.

A resumed branch retains its committed model. If that provider is unavailable, restore the provider configuration or inspect the branch without running model work. Start `agencity new --model PROVIDER:MODEL` to use another model for new work.

There is no product demo provider or automatic fake fallback. Internal deterministic providers are test-only.

## Recovery and unknown effects

Startup recovery:

- requeues lost work only when the effect is declared idempotent;
- records lost non-idempotent ownership as `unknown`;
- abandons interrupted cells instead of replaying their code;
- finalizes already-committed model outcomes without another provider call;
- restores branch status, cancellation, goals, schedules, child work, and typed runs from retained boundaries; and
- never re-executes effects during projection rebuild.

Inspect attention:

```sh
agencity unknown
agencity unknown EFFECT_ID
agencity reconcile latest still_unknown "external audit is inconclusive"
agencity reconcile EFFECT_ID succeeded "provider audit confirms one request"
```

Allowed assessments are `succeeded`, `failed`, `no_effect`, and `still_unknown`. They are evidence only. The durable effect remains unknown and is not retried. Start any successor operation only after independently deciding it is safe and give it a new logical intent.

Do not edit `events` or `outbox` to manufacture an outcome.

See [Recovery](./recovery.md) for the complete state machine.

## Completion gates and waiting runs

A model's final text is provisional until required completion gates pass. Failed or stale evidence returns to the run as a bounded repair observation. An unknown gate effect remains visible and blocks completion.

For one non-interactive shell gate:

```sh
agencity run --completion-gate "bun test" \
  "repair the test failure and verify the result"
```

A run waiting for clarification or permission is durable. Attach and answer through the terminal client. Waiting alone does not require the service to stay resident.

## Optional Turso synchronization

Local-only operation is the default. Shut down the managed workspace service before opening the same database through advanced sync commands. Configure one workspace replica with:

```sh
WORKSPACE_ID="$(<.agencity/workspace-id)"
PROFILE_DB="${AGENCITY_PROFILE:-$HOME/.agencity/profile.db}"
export TURSO_DATABASE_URL='libsql://database-organization.turso.io'
export TURSO_AUTH_TOKEN='...'
agencity sync status --workspace "$WORKSPACE_ID" --profile "$PROFILE_DB"
agencity sync now --workspace "$WORKSPACE_ID" --profile "$PROFILE_DB"
```

Useful directional operations:

```sh
agencity sync push --workspace "$WORKSPACE_ID" --profile "$PROFILE_DB"
agencity sync pull --workspace "$WORKSPACE_ID" --profile "$PROFILE_DB"
agencity sync checkpoint --workspace "$WORKSPACE_ID" --profile "$PROFILE_DB"
agencity sync stats --workspace "$WORKSPACE_ID" --profile "$PROFILE_DB"
agencity sync conflicts --workspace "$WORKSPACE_ID" --profile "$PROFILE_DB"
```

Use `--sync-url`, `--replica`, and `--sync-interval` for explicit configuration. The default interval is 30 seconds; zero disables interval sync.

Sync is an advanced command group. Here `--workspace` means the logical ID from the workspace marker, not a path. Passing the product profile explicitly keeps ownership and catalog records in `~/.agencity/profile.db` instead of the low-level adjacent profile default. Also pass `--workspace-root` and `--state-dir` when running outside the repository root or using non-default placement.

The canonical workspace database remains local. The separate Turso Sync database transports immutable envelopes. A failed network cycle records `error`, leaves local canonical reads and writes available, and preserves unsent changes.

Concurrent offline advances are preserved as separate branches. Duplicate intents, rejected mutations, and competing task claims remain explicit conflicts. No automatic winner, distributed lease, task stealing, or cross-device execution-owner failover is provided.

Treat all writers to the shared envelope database as one trusted user authority. A synchronized request can command the session's execution-owner device. Do not share write credentials with an untrusted device.

`TURSO_AUTH_TOKEN` does not authorize Cloud database deletion. See [Data lifecycle](./data-lifecycle.md) before deleting any workspace that has ever been managed remotely.

## Backup and export

Before a raw backup:

1. run `agencity service shutdown`;
2. confirm no advanced Agencity process is using the same files;
3. copy the workspace database with its sidecars;
4. copy the complete artifact directory;
5. copy every replica database and sidecar; and
6. separately protect the profile database and credential file according to their sensitivity.

Do not copy only `agent.db` when referenced artifacts exist.

Create an ownership-checked logical export with:

```sh
WORKSPACE_ID="$(<.agencity/workspace-id)"
PROFILE_DB="${AGENCITY_PROFILE:-$HOME/.agencity/profile.db}"
agencity data export \
  --workspace "$WORKSPACE_ID" \
  --profile "$PROFILE_DB" \
  --scope workspace \
  --scope-id "$WORKSPACE_ID" \
  --destination ./agencity-export
```

Shut down the managed workspace service before running advanced export or deletion commands against the same database.

Inspect `manifest.json`. A `partial` export, including one with missing artifacts, is not a complete backup. There is no general import or supported export round-trip restore command.

See [Data lifecycle](./data-lifecycle.md) for exact bundle contents and restore limits.

## Physical deletion

Deletion is fail-closed and has no force option:

```sh
agencity data delete \
  --workspace "$WORKSPACE_ID" \
  --profile "$PROFILE_DB" \
  --scope session \
  --scope-id SESSION_ID \
  --confirmation "DELETE session SESSION_ID"
```

Whole-workspace deletion additionally requires an external receipt directory and exclusive ownership of the artifact root:

```sh
agencity data delete \
  --workspace "$WORKSPACE_ID" \
  --profile "$PROFILE_DB" \
  --scope workspace \
  --scope-id "$WORKSPACE_ID" \
  --confirmation "DELETE workspace $WORKSPACE_ID" \
  --receipt-dir /external/receipts \
  --exclusive-artifacts
```

Ownership, quiescence, retained references, replicas, remote administration, and receipt placement are checked independently of the phrase. Narrow session deletion is limited to independent local sessions. Profile deletion removes the profile database and provider credential file but not workspace databases or source repositories.

Data control is also an advanced command group. Pass the logical workspace ID and product profile explicitly as shown. Session and profile scopes additionally require their exact internal IDs; there is no no-ID profile deletion selector.

The shipped CLI cannot administratively delete Turso Cloud databases. Durable evidence of managed remote data blocks deletion unless a programmatic integration supplies separate authenticated administration and returns receipts for every managed URL.

Never interpret a planned, blocked, executing, or partial manifest as completed deletion. Fix the underlying problem and retry the same confirmed request. See [Data lifecycle](./data-lifecycle.md).

## Upgrade procedure

1. Read the target revision's documentation and migration notes.
2. Shut down the managed service and all diagnostic processes.
3. Back up the workspace database, sidecars, artifacts, profile data, and replicas.
4. Update the source checkout.
5. Run `bun install --frozen-lockfile`.
6. Re-run `bun link` if the checkout moved or executable registration changed.
7. Run the repository's deterministic verification gate.
8. Start with `agencity doctor`, then open the workspace.
9. Inspect recovery, unknown effects, provider status, and sync status before admitting new work.

Opening the database may apply migrations. Do not run two runtime revisions against the same writable workspace and do not hand-edit migration metadata.

## Security checklist

- Run under a dedicated, minimally privileged OS identity or external sandbox.
- Keep HTTP listeners on `127.0.0.1` unless an independent authenticated proxy and network policy surround the whole runtime.
- Mount only required workspace and state paths.
- Restrict outbound network independently when generated code must not connect freely.
- Keep provider keys in the owner-only credential file, process environment, or an external secret system.
- Treat shell commands, dynamic imports, and local skills as full local code execution.
- Inspect unknown effects before any manual retry.
- Back up database history and artifact bytes together as sensitive trajectory data.

See [Security](./security.md) for detailed controls and non-claims.

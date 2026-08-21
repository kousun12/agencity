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

- Bun is version 1.3.13 or newer.
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

The status reports lifecycle, recovery, attached clients, idle deadline, retained roots, and reasons the service remains resident. Human output renders the default duration as `1 hour`; `--json` retains the exact `idleShutdownMs: 3600000`. Active runs, pending effects, owned managed background processes, queued wakes, schedules, heartbeats, resident managed run-queue work, and clients can keep it alive. A terminal blocked branch, an idle console worker, and its live REPL namespace do not.

The service normally exits one hour after becoming quiescent. This is an idle process-lifetime bound, not a task timeout or REPL-namespace retention guarantee. It is not registered as an OS boot or login service.

### Graceful shutdown

```sh
agencity service shutdown
```

Shutdown stops new admission, drains admitted protocol handlers and resident workers, stops schedulers, and cancels owned managed background processes. Process cleanup sends a graceful signal to each owned process group, waits for a bounded grace period, force-stops survivors, commits terminal or unknown outcomes, and confirms that no authenticated owned group remains before discovery reports the service stopped. Shutdown then releases local execution leases and preserves sessions. It does not cancel already-terminal work and does not delete data.

If shutdown cannot prove managed-process cleanup, it fails instead of reporting
`stopped`. Preserve the workspace database and artifact directory, inspect the
unknown effect, and do not manually retry the command until external evidence
shows that no prior process or side effect remains.

Use shutdown before raw backups, runtime upgrades, path changes, environment-only credential changes, or advanced database operations. Confirm no separate diagnostic process is using the same database.

### Service authority conflict

If status reports a conflict:

1. Confirm the command is running from the expected canonical workspace root.
2. Check whether another live Agencity process owns the workspace.
3. Allow a healthy owner to finish or shut it down through `agencity service shutdown`.
4. Do not delete the service manifest to bypass a live lease.
5. If the prior owner is gone, retry after the retained lease expires; startup validates the process, manifest, workspace identity, configuration hash, and authenticated health together.

The normalized idle timeout is part of the service configuration hash. During an upgrade from the former 60-second default, a new client using the one-hour default receives `CONFIG_MISMATCH` while the old owner is live. It does not take ownership or delete discovery state. Wait for the old owner to exit, or use the matching old binary to request authenticated shutdown, then start the new client.

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

### Profile governance

Profile operations are relative to the selected route:

```sh
agencity profile show
agencity profile history
agencity profile proposals
```

`history` includes full prompts, adjacent diffs, active/historical revisions, actors, reasons, governance decisions, and restorations. `proposals` includes pending and terminal records, exact reasons, residual risks or violated criteria, revision guidance, and notice-delivery state. Use `agencity profile repropose latest|N JSON` only after reviewing the retained rejection. Use `agencity profile rollback REVISION JSON` to restore exact earlier approved content; rollback does not edit or delete history.

Profile proposal JSON accepts `role`, `purpose`, `instructions`, `reason`, `predictedEffect`, optional `evidenceEventIds`, and optional `wait`. Waiting is the default. Detached review survives client/service loss and delivers one terminal notice to the origin route. Do not manually select or substitute a reviewer: the supervisor pins the origin route's current model, frozen product constitution and policy, and `null` workspace-charter/user-constraint components. Approval means policy consistency, not measured improvement.

Profile governance remains inside the trusted-local boundary. Proposal validation, a sealed reviewer prompt, and typed decisions do not sandbox the reviewer, generated TypeScript, shell commands, or skills.

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
/model openai:openai/gpt-5.6-sol
```

When interactive startup needs a provider or model, Agencity uses searchable keyboard selectors. Provider search covers display names and stable IDs. Model search fuzzily matches catalog display names and canonical IDs, while an exact valid unlisted ID appears as an explicit manual row. Up/Down moves, Enter confirms, Backspace edits, and Escape cancels. Direct OpenAI is limited to `openai/...`, direct Anthropic to `anthropic/...`, and Gateway accepts any valid creator namespace. Catalog labels are presentation; the canonical ID is the durable identity.

The picker loads the configured Gateway-compatible `/v1/models` catalog without provider credentials and without an inference request. `refreshed` rows are current; `cached-fallback` rows are visibly stale; `unavailable` and provider-filtered-empty results preserve manual canonical entry. A listed row is discovery metadata, not proof that provider execution or the fixed Agencity tools are supported.

Saved keys take precedence over `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `AI_GATEWAY_API_KEY`. Endpoint overrides are `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, and `AI_GATEWAY_BASE_URL`. A service already running keeps its inherited environment; shut it down before relying on changed environment variables.

Direct OpenAI uses the Responses API with `store: false` and no `previous_response_id`. Autonomous requests use a session/branch-stable deterministic cache key, explicit mode, a 30-minute TTL, explicit supported text-boundary breakpoints, fixed required tool schema/order, and disabled parallel calls.

Never place raw keys in events, prompts, task text, workspace files, artifacts, profile preferences, opaque-reference labels, or incident logs. The owner-only `auth.json` is a local credential file, not a hostile-code secret vault. Cancelling model selection after credential entry does not roll back the stored key.

A resumed non-Echo branch retains its committed model. If that provider is unavailable, restore the provider configuration or inspect the branch without running model work. Start `agencity new --model PROVIDER:MODEL` to use another model for new work. Retained internal Echo branches use the explicit compatibility migration to a selected product model; they are not silently treated as ordinary product branches.

If startup reports an invalid retained workspace default, leave it available for diagnosis. Interactive startup warns and opens reselection; non-interactive startup fails closed with guidance to pass `--model` or use an interactive terminal. A confirmed replacement is written before root creation. If root creation then fails, the preference may remain. If request transport fails after dispatch, treat the root as unconfirmed and inspect `agencity agents` before retrying.

There is no product demo provider or automatic fake fallback. Internal deterministic providers are test-only.

Agent-tool status is `provider-strict`, `runtime-validated`, `unknown`, or `unavailable`. Missing credentials are reported separately. Capability inspection does not call the provider. The shipped transports prove the formal primitives, but ordinary catalog models usually remain `unknown` because the configured catalog has no authoritative exact-model support fields. New known-unsupported selections reject before a preference, root, branch model change, run, or runnable-child admission; unknown remains admissible under the strict runtime contract. Agencity does not switch model, transport, schema enforcement, or response mode.

## Recovery and unknown effects

Startup recovery:

- requeues lost work only when the effect is declared idempotent;
- records lost non-idempotent ownership as `unknown`;
- abandons interrupted cells instead of replaying their code;
- finalizes already-committed model outcomes and applies retained formal actions without another provider call;
- restores each autonomous or recursive invocation from its retained agent-profile pin and effective-system-prompt provenance rather than selecting the currently active profile;
- recovers trajectory proposals and governed refinement from retained recursive `responseAdmission`, frozen reviewer input, current-model dispatch, exact child-completion evidence, application boundary, and terminal notice;
- restores branch status, cancellation, goals, schedules, child work, typed runs, and managed-process ownership from retained boundaries;
- authenticates a surviving managed process group with its retained random token, stops it, and records the interrupted non-idempotent outcome as unknown without retry; and
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

### Projection repair

`agencity debug rebuild --session SESSION_ID --branch BRANCH_ID` discards and deterministically rebuilds the selected branch snapshot from canonical events. The storage-level operational rebuild also reconstructs session/branch routing, agent-profile versions and active pointers, recursive handles and their profile pins, and context prompt provenance in global cursor order. Neither form executes models, cells, tools, schedules, or other effects.

Agent-profile control events are session-wide but use the session's initial branch as their canonical address. `workspace_agent_profiles`, `governed_refinement_proposals`, and `refinement_restorations` are projections, not independent authority. Do not repair them with SQL; rebuild them from canonical profile, governance, and restoration events.

See [Recovery](./recovery.md) for the complete state machine.

### Bounded output and provider input

Shell and file helpers return `agencity.bounded-output.v1`. Shell retains complete inline output only while each stream fits 24 KiB. Larger local output uses 12 KiB head and tail previews per stream and spills at most 32 MiB of complete scrubbed stdout/stderr to CAS. `truncated` means no complete retained value exists; do not treat command success as output completeness. File reads use one-based pages capped at 2,000 lines, 2 KiB per line, and 48 KiB total. Artifact recovery uses zero-based half-open ranges capped at 64 KiB.

The runtime also limits automatic provider observations to 56 KiB per item and 64 KiB per dependent step. The complete `AgentRunStepStarted.observationEventIds` ledger remains canonical; the bounded provider projection is not evidence deletion. Use retained file-page or artifact-range guidance rather than re-running a non-idempotent effect solely to obtain omitted output.

Model admission records the exact `agencity.provider-input.v2` candidate used by estimation, execution, and recovery. An autonomous transcript segment grows by exact-prefix append: native assistant tool call/result messages, durable observations, changed-state deltas, and next-action messages follow the prior message list. `/context` reports capacity and compaction provenance. Compaction starts an attributable segment/cache reset and append-only growth resumes. Unknown provider capacity remains unknown; complete candidates above 512 KiB must compact toward 384 KiB or stop before provider dispatch. The UTF-8-bytes-per-four estimator is conservative admission evidence, not provider-reported token usage.

For direct OpenAI, each supported next-action text block is an explicit cache breakpoint. Function-call outputs are not relied upon for cache writes. In very long segments, the provider currently considers up to its 50 most recent breakpoints for reads; prior breakpoints remain read-only and only the latest four may write on a request. Provider-reported cache read/write token counts are retained for diagnostics and do not change budget debit.

## Completion gates and blocked runs

A model's successful `finish` submission is provisional until required completion gates pass. Failed or stale evidence returns to the run as a bounded repair observation. An unknown gate effect remains visible and blocks completion.

For one non-interactive shell gate:

```sh
agencity run --completion-gate "bun test" \
  "repair the test failure and verify the result"
```

Missing information ends the current run through blocked `finish` and does not keep the service resident. Attach to inspect the blocked assistant message, then submit the missing information as an ordinary new instruction on the same branch.

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

Inspect both `manifest.json` and `export-audit.json`. Missing profile pins, governed proposal/review/decision/notice/restoration provenance, evidence, or artifacts makes the export `partial`. A partial export is not a complete backup. There is no general import or supported export round-trip restore command.

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

The current workspace format accepts only event schema version 6 and reducer version 22. This is an explicit pre-release reset boundary: workspace histories containing schema version 1, 2, 3, 4, or 5 are rejected before product migration, decoding, projection, synchronization, or recovery. Back up or move aside an incompatible workspace `.agencity` directory before opening it with this format. Starting with a fresh state directory creates schema-version-6 sessions with complete initial profiles, typed effect origins, managed-process lifecycle records, and exact provider-input-v2 admission; the rejection does not delete retained data. See [Data lifecycle](./data-lifecycle.md).

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

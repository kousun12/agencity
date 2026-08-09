# Data lifecycle

Agencity is local-first. Durable agent identity belongs to retained records and referenced artifacts, not to a running terminal, TypeScript heap, or model connection.

This page explains what Agencity stores, what must be backed up together, what export does, and which physical deletion operations are available.

## Data ownership and placement

### Workspace metadata

Every discovered workspace has owner-only metadata at:

```text
<workspace-root>/.agencity/
```

`workspace-id` is the durable workspace identity marker. The managed-service discovery manifest also lives under this directory. These files remain at the workspace root even when database and artifact paths are overridden.

The workspace files that Agencity edits are not database snapshots. Git history, filesystem backups, and external service records remain separately owned.

### Workspace database

The default workspace database is:

```text
<workspace-root>/.agencity/agent.db
```

Its append-only event history is the canonical record of sessions, immutable session-owned agent profiles, invocation prompt pins, branches, tasks, cells, effects, goals, messages, memory and harness decisions, recovery, and other durable agent meaning. The initial profile is embedded in `SessionCreated`; later profile version and activation events, when present, retain session-wide control history.

The same database contains rebuildable projections and operational rows such as snapshots, routing indexes, the effect outbox, process leases, and synchronization status. Those rows accelerate or coordinate the runtime; they do not replace canonical events.

Structured model effects retain one complete accepted formal input. Model completion, action, diagnostics, and progress records use bounded digests, identities, counts, and summaries rather than copying accepted input or retaining rejected argument bodies. Context and model-call provenance retain the exact profile version, agent-prompt digest, effective-system-prompt digest, and immutable prompt-component references used by an autonomous or recursive invocation. Treat the workspace database as sensitive trajectory data even when artifacts are stored elsewhere.

Opening a database applies the repository's numbered migrations. Retained event meanings are not rewritten during ordinary projection rebuild.

### Artifact store

The default artifact store is:

```text
<workspace-root>/.agencity/artifacts/
```

Artifacts are immutable objects addressed by SHA-256 content digest. The database stores references and provenance; the bytes live in the artifact store. Equal content can be shared by multiple references.

A database without its referenced artifact bytes is incomplete. Missing or digest-mismatched artifacts are explicit dependency failures, not empty values.

### Profile and credentials

The product profile database defaults to:

```text
~/.agencity/profile.db
```

It contains device/profile identity, cross-workspace preferences, workspace catalog entries, globally installed skills, and opaque credential references. This profile/device-store state is `userProfile`; it is separate from each session's workspace-canonical `agentProfile`.

Provider key values are not stored in that database. Keys saved during onboarding or `/model login` live in the owner-only sibling file:

```text
~/.agencity/auth.json
```

Environment-only credentials are outside Agencity's stored data and must be managed separately.

### Optional replica database

When Turso synchronization is configured, Agencity uses a separate local replica database. Its default path is:

```text
<workspace-db>.sync-replica.db
```

The replica exchanges immutable event envelopes and retains synchronization state. It is not the canonical workspace database and does not replace local artifacts. Replica sidecars and durable sync status may be required to understand pending exchange, quarantine, conflicts, and deletion obligations.

## Backup requirements

There is no single-file backup that captures all Agencity-owned data.

For a complete local workspace backup, retain:

1. the workspace database and its LibSQL/SQLite sidecars;
2. the complete artifact directory;
3. `.agencity/workspace-id`;
4. every configured local replica database and its sidecars; and
5. the profile database when workspace selection, device identity, profile skills, catalog history, or preferences must be preserved.

Back up the profile `auth.json` only through an appropriately protected secret-backup process. It contains provider keys in plaintext JSON protected by owner-only filesystem permissions. A workspace backup should not casually include it.

Quiesce writers before a raw filesystem copy. Use `agencity service shutdown` and confirm that no advanced Agencity process is using the same files. Copying only a database's main file while its write-ahead log (WAL) or other sidecars are active can produce an inconsistent backup.

Workspace files and external systems are separate dependencies. Back up or version them through their own mechanisms.

## Export

The guarded export command is:

```sh
WORKSPACE_ID="$(<.agencity/workspace-id)"
PROFILE_DB="${AGENCITY_PROFILE:-$HOME/.agencity/profile.db}"
agencity data export \
  --workspace "$WORKSPACE_ID" \
  --profile "$PROFILE_DB" \
  --scope workspace|session|profile \
  --scope-id ID \
  --destination PATH
```

`data` is an advanced command group. Its `--workspace` value is the logical workspace ID, not a path. Pass the product profile explicitly; otherwise low-level commands default to `<workspace-db>.profile.db` rather than `~/.agencity/profile.db`. Use `--workspace-root` and `--state-dir` as well when running outside the repository root or using non-default placement.

Shut down the managed workspace service before opening the same database through advanced export or deletion commands.

Export first records an ownership-checked manifest. For an owned scope it writes:

- `events.jsonl` for selected workspace or session event history;
- `profile.json` with device, preferences, profile skills, opaque credential references, and workspace catalog metadata;
- `replica-envelopes.jsonl` when a configured transport can enumerate envelopes;
- selected verified artifact bytes under `artifacts/`; and
- `manifest.json` with counts, resources, status, and missing-artifact IDs.

Raw provider key values are not exported from `auth.json`. Workspace source files and external service state are also not included.

For schema-version-4 sessions, `events.jsonl` carries initial agent profiles and invocation prompt pins because those values are canonical event payloads. It also carries later profile version/activation events and context/model-call prompt provenance when those records exist. The rebuildable `agent_profile_versions` and `workspace_agent_profiles` tables are not separate authority that must be exported beside their source events.

The current exporter does not add a profile-specific completeness validator beyond its existing event selection, artifact verification, and manifest reporting. Export remains an inspection and portability artifact rather than a proven round-trip restore format.

An export with a missing or corrupt referenced artifact is marked `partial`. Treat that as incomplete evidence, not a successful backup.

### Export is not restore

Agencity does not currently provide a general `data import` command or a supported command that reconstructs a live workspace from an export bundle. Export is an inspection, portability, and data-control artifact; it is not a proven round-trip backup format.

There is also no automated restore command for raw filesystem backups. If disaster recovery depends on a backup, test restoration in an isolated copy with the runtime stopped, matching database, artifact, profile, and replica paths. Do not overwrite a live workspace to test a restore.

Turso synchronization can ingest validated envelopes for its configured workspace. That is synchronization, not a general export-import or artifact-restore mechanism.

## Physical deletion

Physical deletion is an advanced, terminal operation:

```sh
agencity data delete \
  --workspace "$WORKSPACE_ID" \
  --profile "$PROFILE_DB" \
  --scope workspace|session|profile \
  --scope-id ID \
  --confirmation "DELETE <scope> <id>"
```

There is no `--force` bypass. The confirmation is case-sensitive, untrimmed, and checked before workspace state is opened. The runtime then verifies ownership, quiesces work, applies scope-specific reference and capability checks, and records the result.

Workspace scope uses the ID in `.agencity/workspace-id`. Session IDs are available in diagnostic session listings. Profile deletion requires the exact profile ID; the current product CLI does not provide a no-ID profile deletion selector.

Deletion is separate from append-only domain history. Ordinary runtime transitions never edit retained events in place.

### Session deletion

Session deletion is available only for an independently erasable local session. The runtime refuses when retained relationships or evidence make narrow erasure unsafe, including recursive links, replication, harness/refinement references, cross-session artifact references, or protected quarantine records.

The runtime preflights references before deleting artifact bytes, rechecks inside the relational erasure transaction, and retains shared artifact content that other sessions still reference.

A receipt directory is optional for session deletion. The workspace data manifest still records completed or partial status while the database remains available.

### Workspace deletion

Workspace deletion requires:

- an exact workspace confirmation phrase;
- an external `--receipt-dir` outside the artifact directory;
- `--exclusive-artifacts`, asserting that the entire configured artifact directory belongs to this workspace;
- no running or newly claimed effect; and
- successful administration of every durable managed remote replica, if any.

On success it removes the workspace database and recognized sidecars, every known local replica database and recognized sidecars, and the exclusive artifact directory. It marks the workspace deleted in the profile catalog. It does not delete the repository's ordinary source files.

### Profile deletion

Profile deletion requires an external receipt directory and refuses a profile database containing foreign-owned workspace catalog rows. It removes the profile database and its sibling provider credential file.

Profile deletion does not remove workspace databases, artifact directories, or source repositories. Delete those owned scopes separately when required.

### Remote-administration limit

`TURSO_AUTH_TOKEN` is data-plane synchronization authority, not Cloud administrative deletion authority.

The shipped product CLI does not provide a production `ManagedReplicaDeletionAdmin`. If durable catalog, status, or watermark evidence shows that a workspace or profile has managed remote data, deletion fails closed unless a programmatic integration supplies a separately authenticated admin adapter and receives a deletion receipt for every distinct managed URL. Remote session- and profile-granularity deletion are unavailable.

Current command-line configuration cannot bypass this requirement, even if the currently configured sync URL is absent. Historical durable replica evidence remains part of the ownership boundary.

### Receipts, partial deletion, and retry

Workspace and profile receipts are written outside data being erased. A receipt lists only paths and rows proven absent after that attempt, plus any remote administrative receipts.

A filesystem or administration failure produces a partial result. Workspace ownership stays live until all required removal succeeds, allowing the same confirmed request to be retried after the underlying problem is fixed. Do not treat a planned, blocked, executing, or partial manifest as proof of erasure.

## Upgrades and migrations

- The current workspace format accepts event schema version 4, reducer version 13, model dispatch version 2, and model effect output version 2.
- Workspaces containing event schema version 1, 2, or 3 are rejected with reset guidance and are not decoded, upcast, synchronized, projected, or recovered. Profile model-catalog caches may be discarded and rebuilt.
- Opening incompatible state fails before applying product migrations to its retained rows and reports reset guidance. The runtime does not delete the old database.
- Before using this revision, back up or move aside each affected workspace's `.agencity` directory. Starting again creates a fresh version-4 workspace whose new sessions include complete initial profiles. The separate profile directory (normally `~/.agencity`) does not need to be reset unless startup reports a profile-specific incompatibility; resetting a workspace removes session-owned agent-profile history but not user/device profile state, and resetting the profile store does not remove workspace agent profiles.
- Migration 016 creates rebuildable `agent_profile_versions` and `workspace_agent_profiles` projections, adds `profile_pin_json` to recursive handles, and adds `prompt_provenance_json` to immutable context records. Canonical `SessionCreated`, profile-control, invocation, context, and model-call events remain authoritative.
- Back up databases, sidecars, artifacts, profile data, and replicas before changing to a source revision with new migrations.
- Run only one runtime version against a given writable workspace at a time.
- Do not downgrade a migrated database unless that repository revision explicitly supports it.
- Do not hand-edit canonical events, migration metadata, outbox state, profile ownership, replica status, or deletion manifests.
- Keep artifact paths and bytes stable across an upgrade; migrations cannot recreate missing artifacts.
- A projection rebuild replays retained events without executing effects. It is not a database downgrade, artifact restore, or repair for missing canonical history.

See [Configuration](./configuration.md) for path precedence, [Recovery](./recovery.md) for effect handling, and [Relational table registry](./mutable-tables.md) for the authority of each table.

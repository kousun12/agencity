# ADR 0008: Profile, workspace, and credential boundaries

- **Status:** Accepted
- **Date:** 2026-08-07
- **Scope:** Durable identity, ownership, preferences, model selection, and credential values
- **Extends:** [ADR 0001](./0001-durable-local-runtime-foundations.md)
- **Extended by:** [ADR 0012](./0012-durable-agent-profiles-automated-refinement-governance.md), which adds workspace-owned agent profiles while preserving profile/device and credential boundaries

## Context

Workspace history, cross-workspace preferences, device identity, and provider credentials have different ownership, replication, deletion, and exposure requirements. Keeping them in one canonical database would either copy secrets into agent history or make a workspace database responsible for device-wide identity and preferences. Deriving workspace identity only from a path would also make moves and symlinks ambiguous.

## Decision

Each workspace has a stable workspace identity and its own local canonical event database plus configured artifact storage. First product use writes an owner-only `.agencity/workspace-id` marker atomically in the repository. Workspace discovery resolves symlinks and uses that marker so a moved repository retains identity. Insecure, symlinked, or malformed markers are rejected rather than silently replaced.

A separate local `ProfileStore` owns restart-stable profile and device identity, the workspace catalog, cross-workspace preferences, version-pinned globally installed skills, and opaque credential references. It does not accept raw credential values. The workspace catalog records ownership and placement needed to reopen, synchronize, export, or delete known workspaces.

Provider and model selection is durable non-secret configuration in `provider:model` form. Provider-specific model IDs may contain `/`. A session branch retains its selected model across restart and resume; it changes only through an explicit durable model change while model work is idle. Workspace defaults and profile preferences may help create or configure work, but they do not silently rewrite an existing branch's model.

Provider credential values remain outside canonical events, profile preference rows, artifacts, logs, synchronization envelopes, and status output. Values may come from the trusted supervisor environment or from the profile-owned `auth.json` file written with owner-only permissions. An opaque external credential reference may be durable, but the referenced value is not. Stored and environment values are registered with known-secret rejection and output redaction.

Sessions retain an execution-owner device identity. Synchronization can carry canonical requests to that owner, but a non-owner device does not materialize local effects for the session. Device and profile identity establish trusted single-user ownership and routing; they are not hostile-party authentication.

## Consequences

- A workspace remains locally complete and independently movable while profile-level identity and preferences remain shared across workspaces.
- Durable history can name the exact provider and model without retaining the provider secret.
- Workspace synchronization does not replicate raw model credentials.
- Resume is predictable because model configuration does not change from ambient defaults.
- Backup and physical deletion must account for workspace databases, artifact bytes, the profile database, credential files, catalog records, and replica state as separate resources.
- Credential brokering reduces accidental disclosure but cannot hide files from generated code that has the same operating-system authority.

## Rejected alternatives and limitations

1. **Store provider keys in canonical events or profile preferences.** Rejected because events, projections, exports, and synchronization are retained and inspectable.
2. **Use only environment variables as durable configuration.** Rejected because provider/model identity and workspace resume must remain explicit across processes.
3. **Derive workspace identity only from its absolute path.** Rejected because repositories move and may be reached through symlinks.
4. **Apply the current profile default silently to an existing branch.** Rejected because it would change model behavior without a durable session decision.
5. **Treat opaque credential references as credential values.** Rejected because references preserve placement without putting secret material in durable state.

The owner-only credential file is not a general secret vault. Trusted generated TypeScript can use ambient filesystem APIs, and environment filtering and redaction are best-effort defenses against accidental leakage. The current identity model is not multi-tenant authorization and does not provide automatic cross-device execution-owner failover.

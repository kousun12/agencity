# ADR 0009: Guarded owned-data deletion

- **Status:** Accepted
- **Date:** 2026-08-07
- **Scope:** Physical deletion across relational, artifact, credential, and replica stores
- **Extends:** [ADR 0001](./0001-durable-local-runtime-foundations.md)

## Context

Canonical history is append-only during ordinary operation, but retention is not a denial of an owner's request to erase data. Complete deletion may span a workspace database and sidecars, a profile database, provider credential files, content-addressed artifacts, local synchronization replicas, and remotely managed replicas. These resources have shared references and independent failure modes. Ordinary domain events or unrestricted SQL cannot safely represent a destructive cross-store operation.

## Decision

Physical deletion is a guarded administrative exception to normal event retention. The supported scopes are an independently erasable session, a whole workspace, and a whole profile. A request names the scope, owned identifier, requester, and exact case-sensitive confirmation `DELETE <scopeKind> <scopeId>`. There is no force mode.

Before destructive work, the runtime validates ownership, stops new worker and outbox admission, and refuses deletion while an effect is running or a claim is being admitted. A supervisor that attempts deletion is not reused afterward. Deletion APIs are available through the supervisor, public client and protocol, and canonical command-line surface; they are not exposed to generated-code SDKs or model-visible relational commands.

Independent-session deletion first performs a non-mutating reference preflight. It removes only artifact objects with no retained local reference, repeats the reference check, and then transactionally removes the session's relational rows under the guarded administrative path. Linked or recursive sessions and sessions referenced by replication, harness, quarantine, or other retained state fail with a capability error rather than weakening the checks.

Whole-workspace deletion removes the local workspace database and known sidecars, durable local replica resources, and the artifact root only when placement explicitly asserts that root is exclusive to the workspace. Whole-profile deletion removes the profile database and profile-owned model credential file. Workspace and profile deletion require a receipt directory outside the resources being erased.

Relational synchronization is not remote administrative authority. A managed remote workspace can be deleted only through a separate `ManagedReplicaDeletionAdmin` that advertises authenticated administration. Every durable managed identity must have an addressable URL, every distinct URL must return a provider receipt, and retries use stable scope, owner, and URL idempotency. Remote session and profile granularity are unavailable.

A `PhysicalDeletionReceipt` reports postconditions: only paths, rows, credential files, protected shared artifacts, and remote resources observed absent after the attempt appear as removed. Partial failure leaves ownership live and the operation retryable. Workspace catalog ownership is tombstoned and identifying placement fields are scrubbed only after remote administration, replicas, artifacts, and workspace database removal all succeed.

## Consequences

- Append-only history remains the normal mutation rule while owners retain an explicit erasure path.
- Deletion fails closed when ownership, quiescence, references, artifact exclusivity, or remote administration cannot be proved.
- Shared artifact bytes and cross-referenced sessions are protected from speculative removal.
- Receipts distinguish intended work from verified absence and preserve evidence after a containing database disappears.
- Multi-resource deletion may be partial and require an authenticated idempotent retry.
- A successful workspace tombstone prevents silent identity reuse without retaining the deleted placement or credential reference.

## Rejected alternatives and limitations

1. **Delete canonical rows through ordinary SQL or generated code.** Rejected because it bypasses ownership, reference, quiescence, receipt, and retry rules.
2. **Append a deletion event without removing physical data.** Rejected because a logical marker is not physical erasure.
3. **Tombstone ownership before fallible deletion work.** Rejected because a partial failure would make remaining resources difficult to reopen and retry safely.
4. **Delete every digest named by the target session.** Rejected because content-addressed bytes may still be referenced by retained history.
5. **Treat a synchronization token as Cloud administrative authority.** Rejected because data-plane exchange does not prove deletion ownership or provide an administrative receipt.
6. **Report planned removals as completed removals.** Rejected because receipts must describe observed postconditions.

Remote deletion is limited to workspace granularity and requires an injected authenticated administrative adapter; the installed data client alone cannot perform it. A whole-workspace artifact root must be explicitly exclusive. Permission or filesystem failures can leave a partial but owned, reopenable state that requires retry.

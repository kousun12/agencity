# ADR 0003: Exchange immutable envelopes with the official Turso Sync adapter

- Status: accepted
- Scope: Slice 4 Cloud exchange
- Updated: 2026-08-05

## Context

The workspace schema predates multi-writer synchronization. Its local event cursor is an autoincrementing integer and the database also contains mutable snapshots, outbox leases, task/harness projections, and indexes. Sending that database through a last-push-wins system could silently overwrite canonical history, ownership, budgets, or permissions.

The pinned official dependency is `@tursodatabase/sync@0.7.2`. Its supported surface is `connect({ path, url, authToken, ... })` plus local SQL and the explicit `push()`, `pull()`, `checkpoint()`, and `stats()` methods. `push()` sends logical CDC statements and concurrent row conflicts use last-push-wins. This is a different protocol and metadata topology from the legacy `@libsql/client` embedded-replica/frame API; Agencity does not wrap or emulate the old `Client.sync()` transport.

## Decision

Keep every workspace database local and complete. Use a second local Turso Sync database solely for immutable `ReplicatedEnvelope` rows and workspace announcements. `@libsql/client` remains only for `ProfileStore` and the existing local workspace adapter; Cloud envelope exchange uses `TursoSyncTransport` and the official modern methods.

Each envelope physical primary key is deterministically derived from its workspace, origin device/sequence, entity metadata, dependencies, and exact event body. The digest covers the complete envelope. Consequently, different writers or different content never compete for the same replicated row merely because their logical event IDs collide. Last-push-wins may settle a write to an identical physical key, but it cannot erase a distinct content-and-origin claim. Update/delete triggers make the envelope table append-only locally.

`connect()` receives a deferred URL callback. During construction, schema creation, staging, local queries, checkpointing, and statistics it returns `null`; it exposes the configured URL only while an explicit `push()` or `pull()` is executing. This is the installed 0.7.2 equivalent of offline-first `bootstrapIfEmpty: false`. Local initialization therefore never contacts or bootstraps from Cloud. A rejected network call retains the same usable local database and unsent CDC operations.

A normal cycle:

1. stages all new local canonical events as immutable envelopes;
2. on an established replica, may pull the already-known remote revision first;
3. pushes local CDC with the official `push()`;
4. pulls conflict-resolved remote state with the official `pull()`;
5. validates and ingests retained envelopes; and
6. checkpoints and records official statistics.

A brand-new replica does **not** pre-pull: it pushes first-launch local CDC before any remote bootstrap can affect local state. Explicit service/protocol/CLI push, pull, checkpoint, and stats calls map to those real SDK primitives. The deterministic in-process test hub remains honestly `bidirectional-only`, so directional calls against it return `CAPABILITY_UNAVAILABLE` rather than pretending its exchange has directional guarantees.

The local transport maintains an immutable replica-incarnation marker. The workspace status records the expected incarnation. If the modern local replica files are lost or replaced, startup observes a different incarnation, clears only the staging frontier, and restages canonical local history. Ingest receipts and ingest frontiers remain intact.

## Reconciliation boundary

Pulled envelopes pass digest/schema/event validation and causal ordering before canonical append. Duplicate content is idempotent. Divergent event IDs, duplicate intents, offline branch advances, rejected mutations, and competing task claims are retained and surfaced. No last-writer rule decides agent execution ownership. An explicit `SyncConflictResolved` event records a user decision without rewriting history.

Tokens remain in process memory. Profile storage accepts only opaque credential references. The data client does not provide Cloud administrative deletion, distributed leases, task stealing, global budget reservations, or automatic owner failover, so those capabilities remain false.

## Consequences

- First launch and network failure preserve local work and local usability.
- Distinct origin/content claims survive logical last-push-wins replication.
- Directional API claims are backed by the installed official SDK methods.
- Official CDC/revision/network statistics replace legacy frame counters.
- Replacing a local replica cannot strand events behind a stale staging watermark.
- The separate envelope database adds disk and lifecycle overhead, but keeps mutable workspace projections out of multi-writer replication.

## Rejected alternatives

1. **Replicate the workspace database directly.** Rejected because mutable projections and local row identities would become conflict authority.
2. **Keep the legacy `@libsql/client` embedded-replica envelope transport.** Rejected because its first-sync frame/metadata topology is incompatible with the required offline-first logical CDC behavior.
3. **Invent directional calls around `Client.sync()`.** Rejected; the implementation instead depends on real `@tursodatabase/sync` push/pull methods.
4. **Use logical event ID as the replicated primary key.** Rejected because independent writers could overwrite evidence needed for reconciliation.
5. **Use last-push-wins for task claims or execution ownership.** Rejected because offline exclusivity is unknowable and conflicts must remain visible.
6. **Persist the Turso token in catalog/status rows.** Rejected; only opaque broker references may persist.

# Full-system PRD acceptance

This is the release evidence index for the 18 acceptance criteria in
[`2026-08-05-prime-agent-typescript-turso-rewrite-prd.md`](../2026-08-05-prime-agent-typescript-turso-rewrite-prd.md).
It complements the slice notes; it does not replace or edit the PRD. Evidence below was last run
on **2026-08-06** with Bun **1.3.14** on macOS arm64.

## Reproduce the evidence

Credential-free default verification:

```sh
bun install --frozen-lockfile
bun run verify
```

`verify` runs TypeScript checking, architecture/table/SDK-boundary checks, the static full-system
matrix check, and all tests with a 30-second per-test limit. The latest run in this tree passed
**224 tests**, skipped the two deliberately gated external tests, and failed none. With `TURSO_SYNC_SERVER_BIN` set, the same full suite runs 225 passing tests and leaves only the credential-gated Cloud smoke skipped. One skipped test
is the official local sync-server harness below; the other is the separately credential-gated Turso
Cloud smoke in `test/slice4/cloud-smoke.test.ts`.

Credential-free official Turso Sync server conformance (no Cloud account or token):

```sh
TURSO_SYNC_SERVER_BIN=/absolute/path/to/tursodb \
  bun run test:turso-official
```

The binary must report exactly `Turso 0.7.2`. The test itself starts a fresh process as
`tursodb <temporary-server.db> --sync-server 127.0.0.1:<ephemeral-port>`, waits for readiness,
runs two real `TursoSyncTransport`/`Supervisor` replicas, and terminates the process and removes all
temporary files in `finally`. The default suite skips this test **only** when
`TURSO_SYNC_SERVER_BIN` is absent; an invalid path, wrong version, startup failure, or conformance
failure is a test failure.

Current external evidence: the harness passed locally on 2026-08-06 with the official
`tursodatabase/turso` v0.7.2 macOS arm64 asset, `tursodb --version` = `Turso 0.7.2`, binary SHA-256
`3d92c0801f35e0988b69b2378cbe4c153b34204bd98da0efafbd458ac8a90115`: **1 test passed,
46 assertions, 0 failures**. The machine-specific binary path is intentionally not committed.

## The 18 acceptance criteria

| ID | PRD criterion (abridged, in order) | Exact automated evidence | Result |
|---|---|---|---|
| AC-01 | Representative coding task with a fresh TypeScript worker after every committed cell and identical state | `test/e2e/coding-task.test.ts` — “plans, reproduces, fixes, and verifies code with a fresh worker after every committed cell”; `test/integration/console.test.ts` — real RPC across restart-after-cell | Pass |
| AC-02 | No later-cell value exists only in the Bun heap | `test/integration/console.test.ts` — typed state/artifact RPC across worker restarts; `test/slice2/cancellation-handles.test.ts` — JSON handles after close/reopen | Pass |
| AC-03 | Typed JSON through 128 KiB; larger immutable/deduplicated artifact | `test/integration/console.test.ts` — exact 128 KiB boundary and first byte over; `test/unit/artifacts.test.ts` — concurrent content deduplication and integrity | Pass |
| AC-04 | Canonical history append-only; every mutable table classified | `test/unit/events.test.ts` — physical guards from a separate administrative connection; `docs/mutable-tables.md`; `scripts/check-architecture.ts` | Pass; the audited physical erasure path removes/recreates delete guards in one transaction only after explicit owned-scope deletion |
| AC-05 | Crash recovery for model, tool, subagent, and refinement without missing/duplicate committed state | `test/integration/model-loop.test.ts`, `test/integration/outbox.test.ts`, `test/integration/recursive-sessions.test.ts`, `test/slice3-adversarial/skill-security.test.ts` — “refinement recovery around generated-skill tests” | Pass |
| AC-06 | Over-context input processed through chunks/delegation without full root import | `test/slice2/documents-input-context.test.ts` — root sees metadata only and child receives exact ordered chunk set | Pass |
| AC-07 | Parent/child mailbox, detach, restart, same durable task | `test/slice2/family-mailbox.test.ts`; `test/integration/recursive-sessions.test.ts` | Pass |
| AC-08 | Every model response traces exact context and harness versions | `test/integration/model-loop.test.ts` — exact context IDs; `test/slice3/memory-context.test.ts` — exact harness/retrieval provenance | Pass |
| AC-09 | Snapshot + committed event subscription disconnect/resume, no misses, duplicate-safe | `test/integration/projection.test.ts` — snapshot/catch-up race, duplicate notification, abort, reconnect | Pass |
| AC-10 | Historical cursor and return live without repeating effects | `test/integration/projection.test.ts` — “historical projection is effect-free” | Pass |
| AC-11 | Offline local execution and reconnect synchronization | `test/slice4/sync-lifecycle.test.ts`; `test/slice4/unreachable-real-adapter.test.ts`; `test/slice4/official-server-conformance.test.ts` (official gated evidence above) | Pass |
| AC-12 | Concurrent writers preserve conversation/tool rows and surface conflicting claims | `test/slice4/conflicts.test.ts`; `test/slice4/sync-lifecycle.test.ts`; `test/slice4/official-server-conformance.test.ts` — real server concurrent offline conversation and claim writes, all expected envelope IDs, conflict policy | Pass |
| AC-13 | Refinement propose, bounded candidate, observed promote/reject, rollback | `test/slice3/refinement.test.ts`; `test/e2e/continual-harness.test.ts`; adversarial governance tests under `test/slice3-adversarial/` | Pass |
| AC-14 | Generated TypeScript cannot mutate canonical tables/read secrets; trusted-local boundary is explicit | `test/unit/security.test.ts`; `test/integration/console.test.ts`; `test/slice3-adversarial/skill-security.test.ts`; `docs/security.md` | Pass |
| AC-15 | Storage conformance surface contains no Turso SDK types outside adapter | `scripts/check-architecture.ts` scans source and emitted declarations; `bun run check:architecture` | Pass |
| AC-16 | Local/remote state, artifact, retrieval, execution shared contracts and honest capability gaps | `test/placement/placement.test.ts`; `test/placement/conformance.ts`; `test/slice4/sync-lifecycle.test.ts` directional-unavailable case | Pass |
| AC-17 | Retained events + reducer version reproduce state after restart/rebuild | `test/unit/events.test.ts`; `test/slice2/projection-recovery.test.ts`; `test/e2e/coding-task.test.ts` | Pass |
| AC-18 | Unknown external effect is visible and not automatically retried unless idempotent | `test/integration/outbox.test.ts`; `test/slice2/goals.test.ts`; `test/slice2/recursive-models.test.ts` | Pass |

## Constitution and system guarantees outside the numbered list

The PRD is broader than the 18 bullets. These cross-slice checks are also release requirements:

- **Ownership follows data, not placement.** `test/slice4/data-control.test.ts` physically checks independent-session rows/context/projections/quarantine, workspace and profile database files, exact official Sync sidecars/replacement backups/logs, exclusive managed-CAS contents (including unregistered garbage), and external receipts. It proves shared or preflight-refused artifacts remain, similarly named replica sentinels remain, foreign ownership and hidden references are refused, and tombstones are neither written early nor silently reclaimed.
- **Durable managed-replica control.** The same suite syncs real in-process history, reopens without sync configuration, and proves all historical status/watermark/catalog evidence and the adjacent default replica remain enumerated. Workspace/session/profile plans do not become false completion. Workspace deletion calls authenticated administration once per distinct known URL, blocks an unaddressable identity even when an admin exists, and reuses stable idempotency keys across a permission-failure retry.
- **Explicit destructive UX.** `Supervisor.deleteOwnedData`, `AgentClient.deleteOwnedData`, `POST /sync/delete`, and CLI `delete-data` require the literal confirmation `DELETE <scopeKind> <scopeId>`. Workspace/profile deletion requires a receipt directory outside the managed artifact root. Outbox admission is quiesced and running effects refuse deletion. Partial receipts list only observed absence; ownership remains retryable until all remote/local/CAS removals finish. Unsupported session graphs, remote session/profile granularity, non-local files, or unproven shared CAS roots fail with `CAPABILITY_UNAVAILABLE`; no planned/partial manifest is presented as completion. Ordinary retained `events` still reject `DELETE`; only the audited local transaction temporarily recreates delete guards.
- **No hidden identity / deterministic compaction.** Worker restart tests cover checkpointed values.
  `test/integration/full-system-surfaces.test.ts` proves `Supervisor.compact` and `Supervisor.resume`; compaction creates an immutable `ContextMaterialized` extractive summary with exact
  source event IDs; source messages are retained. TUI `/compact` and `/resume` are explicit, and the
  TUI observes committed `ModelOutputChunk` records. The current providers emit a single committed
  chunk after provider completion; this is resumable committed-output display, **not a claim of
  provider token streaming**.
- **Authority and evidence.** `test/slice3-adversarial/validation-authority.test.ts`,
  `test/slice3-adversarial/candidate-observation.test.ts`, and
  `test/slice3-adversarial/governance.test.ts` cover immutable safety policy, runtime-owned scope
  keys, objective evidence, exposure, repeated workspace success, explicit user/global approval,
  conflicts, and exact rollback.
- **Uncertainty and integrity stay visible.** Corrupt/missing artifact tests, sync quarantine tests,
  unknown-effect tests, stale goal-gate tests, and remote dependency-failure tests all fail visibly.
- **Profile/workspace boundary.** `test/slice4/profile-adapter.test.ts` and
  `test/slice4/restart-protocol.test.ts` cover stable identity, profile preferences/global skills,
  opaque credential references, and workspace discovery/catalog state in the separate profile DB.

## Deliberate capability boundaries

These are PRD non-goals or explicitly deferred slices, not silently emulated features:

- PostgreSQL storage and its distributed leases/budget reservations are not shipped.
- Semantic/embedding retrieval is not shipped; deterministic FTS candidate generation and
  authoritative scope/status filters are shipped.
- The Bun worker is crash isolation, not a hostile-code sandbox. Trusted-local mode and the
  loopback/externally managed sandbox requirement are documented in `docs/security.md`.
- Turso data-plane sync credentials are never treated as Cloud administrative deletion authority.
  A separately authenticated control-plane adapter is required.
- Physical session deletion is intentionally limited to independent, unreplicated sessions with no retained canonical or hidden quarantine references. A non-mutating preflight protects CAS before the transactional recheck. Anything broader reports `CAPABILITY_UNAVAILABLE` rather than manufacturing a success receipt.

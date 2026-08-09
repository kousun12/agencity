# ADR 0004: Event evolution and lossless context references

- **Status:** Deferred
- **Date:** 2026-08-07
- **Scope:** Mixed event versions and referenced context storage
- **Extends:** [ADR 0001](./0001-durable-local-runtime-foundations.md)
- **Deferred planning material:** [Lossless context-reference storage plan](../../plans/2026-08-07-lossless-context-references-plan.md)

This proposal is deferred and requires a new readiness review before implementation. [ADR 0010](./0010-formal-model-tool-contracts.md) establishes a single current workspace schema with reset guidance for older state until the first release. The context exactness and canonical-reference goals remain proposed; mixed pre-release event versions are not part of this decision.

## Context

The runtime uses one uniform pre-release workspace schema and has no general per-event version registry or upcaster pipeline. Older workspaces are rejected with reset guidance at architecture cutovers. A materialized model context is stored inline in its canonical `ContextMaterialized` event, copied into `context_records`, and repeated in context-backed model effect input. Successive contexts often share most of their content, so this representation can amplify durable storage across events, outbox rows, projections, snapshots, synchronization envelopes, and exports.

Reducing those copies must not change the exact value sent to a provider, discard attribution, introduce a projection-only source of truth, or depend on unreplicated artifact bytes.

This ADR remains deferred. The linked plan is non-authoritative planning material; adoption requires a new readiness review and an explicit accepted decision before referenced contexts become the default for new writes.

## Decision

### Uniform pre-release event schema

The context-reference implementation targets the one current workspace schema at implementation time. If the existing schema still contains inline contexts, the cutover allocates one new uniform schema and rejects every older workspace with reset guidance before projection. It does not add a per-event version registry, upcaster, mixed-history reader, old inline-effect decoder, or dual-version client protocol.

### Canonical lossless context references

Referenced context events carry a complete, versioned manifest plus immutable fragment definitions and references to earlier definitions visible in the same session and branch ancestry. Fragment identity covers the exact tagged UTF-8 bytes of `JSON.stringify(fragment)`. Resolution must reconstruct the exact JSON value and verify the existing full-context hash before token estimation, effect admission, or provider execution.

Fragment definitions remain in canonical events. Rebuildable indexes may accelerate lookup but cannot supply unique bytes. References cannot cross independent sessions, point into sibling-only history, depend on future events, or use mutable profile state. Missing, invisible, malformed, oversized, or digest-mismatched dependencies fail explicitly.

Context-backed model effect requests retain only the context identity, content hash, call identity, and model dispatch. The model executor resolves and verifies the context after claiming the effect and before contacting the provider. Context-independent model effects remain inline.

### No pre-release history conversion

No migration edits an older event payload, changes its schema version, recalculates its hash under new rules, or retrofits inline contexts into references. Older workspaces remain untouched but unavailable to the new runtime until explicitly reset. Canonical fragment definitions remain retained while any visible current-schema context references them.

## Consequences

- New contexts can avoid repeatedly embedding the same large values while preserving exact provider input and attribution.
- Event parsing, projection, protocol, synchronization, export, deletion, and recovery use one referenced-context schema.
- A referenced context is usable only when every canonical dependency is present and verified.
- Resolution adds bounded lookup and verification work before dependent model execution.
- Context-backed outbox rows, effect projections, snapshots, and envelopes can remain reference-shaped.
- Older pre-release databases fail with reset guidance and are never interpreted under the new schema.
- The change is not complete until storage savings and resolution costs meet the linked plan's reproducible acceptance thresholds.

## Rejected alternatives and limitations

1. **Rewrite older pre-release events.** Rejected because reset guidance is simpler and avoids changing canonical evidence, hashes, and synchronization identity.
2. **Silently reinterpret the current schema as a new payload shape.** Rejected because stale workspaces must fail before projection.
3. **Store context fragments only in projections or process caches.** Rejected because replay and recovery must remain self-contained.
4. **Use the external artifact store for canonical context fragments.** Rejected because automatic artifact replication is not implemented; synchronized events could become unresolvable.
5. **Reference fragments across independent sessions.** Rejected because it would complicate ownership, branch visibility, export, and deletion boundaries.
6. **Represent each context only as a delta from the previous manifest.** Rejected for the initial codec because chained resolution would increase corruption and recovery risk.

This deferred proposal optimizes context storage only. It does not change context selection, compaction policy, provider prompts, general artifact replication, or canonical retention.

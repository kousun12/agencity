# ADR 0004: Event evolution and lossless context references

- **Status:** Proposed
- **Date:** 2026-08-07
- **Scope:** Mixed event versions and referenced context storage
- **Extends:** [ADR 0001](./0001-durable-local-runtime-foundations.md)
- **Implementation plan:** [Lossless context-reference storage plan](../../plans/2026-08-07-lossless-context-references-plan.md)

## Context

The runtime currently accepts schema version 1 for every event and has no general per-event version registry or upcaster pipeline. A materialized model context is stored inline in its canonical `ContextMaterialized` event, copied into `context_records`, and repeated in context-backed model effect input. Successive contexts often share most of their content, so this representation can amplify durable storage across events, outbox rows, projections, snapshots, synchronization envelopes, and exports.

Reducing those copies must not change the exact value sent to a provider, discard attribution, introduce a projection-only source of truth, depend on unreplicated artifact bytes, or reinterpret retained version-1 history.

This ADR remains proposed until the linked implementation plan is complete and referenced contexts are the verified default for new writes.

## Decision

### Explicit event-version compatibility

Introduce a registry keyed by event type and schema version. Version 1 remains accepted for every existing event. The first additional accepted pair is version 2 for `ContextMaterialized`; other unsupported type/version pairs fail with a typed compatibility error.

Storage reads, protocol events, synchronization envelopes, and exports preserve each event's original schema version. Reducers and resolvers handle retained version-1, new version-2, and mixed histories deterministically. Compatibility tests must include retained version-1 fixtures and mixed-version replay, rebuild, synchronization, export, and client behavior.

An upcaster may provide a current in-memory view when a caller needs one, but it must be deterministic and must not update retained records. Ordinary event loading must not inflate every referenced context back into the old inline payload shape.

### Canonical lossless context references

Version-2 context events carry a complete, versioned manifest plus immutable fragment definitions and references to earlier definitions visible in the same session and branch ancestry. Fragment identity covers the exact tagged UTF-8 bytes of `JSON.stringify(fragment)`. Resolution must reconstruct the exact JSON value and verify the existing full-context hash before token estimation, effect admission, or provider execution.

Fragment definitions remain in canonical events. Rebuildable indexes may accelerate lookup but cannot supply unique bytes. References cannot cross independent sessions, point into sibling-only history, depend on future events, or use mutable profile state. Missing, invisible, malformed, oversized, or digest-mismatched dependencies fail explicitly.

New context-backed model effect requests retain only the context identity, content hash, call identity, and model configuration. The model executor resolves and verifies the context after claiming the effect and before contacting the provider. Retained version-1 inline effects and context-independent model effects remain supported.

### No retained-history rewrite

No migration edits a retained event payload, changes its schema version, recalculates its historical hash under new rules, or retrofits version-1 contexts into references. Version-1 and version-2 readers remain available. Canonical fragment definitions remain retained while any visible context references them.

## Consequences

- New contexts can avoid repeatedly embedding the same large values while preserving exact provider input and attribution.
- Event parsing, projection, protocol, synchronization, export, deletion, and recovery become explicitly version-aware.
- A referenced context is usable only when every canonical dependency is present and verified.
- Resolution adds bounded lookup and verification work before dependent model execution.
- Context-backed outbox rows, effect projections, snapshots, and envelopes can remain reference-shaped.
- Existing databases continue to open and replay without rewriting history.
- The change is not complete until storage savings and resolution costs meet the linked plan's reproducible acceptance thresholds.

## Rejected alternatives and limitations

1. **Rewrite retained version-1 events.** Rejected because it would change canonical evidence, hashes, and synchronization identity.
2. **Silently reinterpret version 1 as a new payload shape.** Rejected because released event meanings are immutable.
3. **Store context fragments only in projections or process caches.** Rejected because replay and recovery must remain self-contained.
4. **Use the external artifact store for canonical context fragments.** Rejected because automatic artifact replication is not implemented; synchronized events could become unresolvable.
5. **Reference fragments across independent sessions.** Rejected because it would complicate ownership, branch visibility, export, and deletion boundaries.
6. **Represent each context only as a delta from the previous manifest.** Rejected for the initial codec because chained resolution would increase corruption and recovery risk.

This proposal optimizes context storage only. It does not change context selection, compaction policy, provider prompts, general artifact replication, or canonical retention.

# Lossless context-reference storage plan

**Status:** Ready for implementation  
**Date:** August 7, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)

## Summary

Agencity retains the exact `JsonValue` supplied to each model provider in a canonical `ContextMaterialized` event and copies the same expanded value into `context_records`. Successive model turns contain substantial overlap: policies, prior messages, harness versions, task state, query hints, and other context components recur even when only one new message or observation was added.

This plan replaces expanded context storage for new events with:

1. immutable, content-addressed context fragments defined once in canonical history;
2. a compact manifest that preserves the exact structure and ordering of each materialized context;
3. a resolver that reconstructs and verifies the original `JsonValue` before token estimation or model execution;
4. reference-shaped context-backed model effects so outbox state, snapshots, sync envelopes, and exports do not re-embed the expanded context.

The first event that uses a fragment stores its exact JSON value. Later visible events reference the fragment's digest and source event. Fragment definitions remain inside canonical events rather than the external artifact store. This keeps context dependencies available to current event synchronization, export, branch replay, and owned-scope deletion without requiring general artifact replication.

Version-1 events remain unchanged and readable. New referenced contexts use a version-2 `ContextMaterialized` payload after the runtime gains explicit per-event schema-version support. Retained history is never rewritten.

The change is storage-internal. Context selection, provider inputs, model behavior, context hashes, attribution, compaction, recovery, CLI/TUI behavior, and trusted-local authority remain unchanged.

## Motivation

The runtime already stores transitions rather than accumulating authoritative state snapshots:

- `events` is canonical and append-only;
- projections and the current branch snapshot are rebuildable;
- `AgentState.contexts` retains context provenance rather than every expanded historical context.

The remaining amplification is physical context storage:

- `ContextMaterializer.materialize` builds the complete context and places it in `ContextMaterialized.payload.context`;
- `LibSqlStorage` copies that complete value into `context_records.context_json` in the same append transaction;
- both model paths place the expanded context in `EffectRequested.input`, which is copied into canonical events, `outbox.input_json`, reducer effect state, snapshots, sync envelopes, protocol history, and exports;
- recovery paths read `event.payload.context` directly;
- every later materialization repeats most earlier context content.

For a growing conversation, repeated expanded contexts can approach quadratic storage growth between compactions. The exact growth depends on message sizes, harness state, run observations, and compaction frequency. Snapshots amplify the problem only because projected effect inputs currently retain the expanded context; snapshots are not an independent source of context truth.

## Goals

- Reconstruct the exact materialized `JsonValue` for every version-2 context.
- Preserve the existing `contentHash` over the exact `JSON.stringify(context)` bytes.
- Store repeatable context content once per visible session history and represent later occurrences with small references.
- Remove the complete expanded context copy from new `ContextMaterialized` event payloads and `context_records` rows.
- Store only a context identity and hash in new model-effect requests backed by `ContextMaterialized` so outbox rows, effect projections, snapshots, sync envelopes, protocol history, and exports do not copy the expanded value. Context-independent model effects, including model-summary compaction prompts, remain inline.
- Preserve exact source-event, harness, compaction, model-attempt, and context-capacity provenance.
- Preserve local-first operation, offline writes, divergent branches, and current event-envelope synchronization.
- Open, replay, inspect, export, synchronize, branch, and delete databases containing any mixture of version-1 and version-2 context events.
- Fail before model-effect admission when any referenced fragment is missing, malformed, out of scope, or digest-mismatched.
- Measure total database savings and context-resolution costs with reproducible fixtures before making version-2 writes the default.

## Non-goals

- Deleting, summarizing, or rewriting canonical conversation history.
- Changing context selection, compaction policy, model prompts, provider adapters, or token estimation.
- Moving all event payloads, documents, tool outputs, or artifacts to the reference format.
- Implementing general artifact synchronization.
- Replacing the frozen source payloads in `ContextCompactionRequested`; those forensic compaction inputs require a separate measured optimization.
- Sharing context fragments across independent sessions or root-agent families.
- Retrofitting version-1 events into version-2 payloads.
- Parent-plus-delta manifests, Merkle trees, or other structural sharing between manifests. Each version-2 event carries a complete manifest; structural sharing can be evaluated later if manifest bytes become material.
- Garbage-collecting canonical fragment definitions while events that reference them remain retained.

## Required invariants

### Exact reconstruction

Resolving a version-2 context produces a value for which:

```ts
JSON.stringify(resolvedContext) === originalSerializedContext
sha256(JSON.stringify(resolvedContext)) === contentHash
```

Object property order, array order, string contents, number representation, `null`, and Unicode must therefore round-trip through the codec. Fragment identity uses the exact UTF-8 bytes of `JSON.stringify(fragment)`, not a reordered canonical-JSON representation.

### Canonical history remains self-contained

Every referenced fragment is defined by a retained canonical event visible from the referencing branch. A context cannot depend on:

- a process cache;
- a projection row;
- a sibling branch event outside its visible ancestry;
- another independent session;
- an unreplicated artifact;
- mutable profile state at resolution time.

Projections accelerate lookup but never supply unique fragment bytes.

### Resolution precedes effects

The runtime fully resolves and verifies a context before:

- estimating its token size;
- appending a model-attempt admission that depends on that estimate;
- appending `ModelCallRequested` or its model `EffectRequested`;
- invoking a model provider.

A missing or corrupt fragment is an explicit dependency failure. It is never interpreted as an empty value, regenerated from current state, or repaired by repeating a model call.

### Retained version 1 remains immutable

Existing version-1 `ContextMaterialized` events keep their current payload and meaning. Mixed histories project deterministically. No migration edits `events.payload_json`, changes a retained content hash, or requires a version-1 context to be refragmented.

Version-1 `contentHash` values remain historical assertions because the current append path validates their shape but does not recompute them. Version-2 append and resolution paths verify fragment digests and the final context hash.

## Terminology

- **Fragment:** An immutable JSON value identified by the SHA-256 digest of its exact tagged UTF-8 JSON encoding.
- **Fragment definition:** The first visible canonical occurrence that stores a fragment's value, digest, byte length, and encoding.
- **Fragment reference:** A tagged pointer to either a definition ordinal in the same event or a digest, prior source event, and definition ordinal needed to locate and verify an earlier fragment.
- **Manifest:** A complete ordered recipe for reconstructing one context from fragment references and small structural metadata.
- **Codec:** A versioned pure encoder and decoder that maps between a `JsonValue` and a manifest plus fragment definitions.
- **Resolution:** Loading definitions, checking scope and integrity, decoding the manifest, and verifying the final context hash.

## Chosen storage design

### Canonical fragment definitions live in context events

Version-2 context events store only:

- the context identity and source-record provenance;
- the expected full-context hash;
- the manifest and codec version;
- definitions for fragments not already available in the branch's visible history;
- harness and compaction provenance, represented through the same fragment mechanism where large or repeatable;
- the source event IDs for referenced earlier definitions.

An illustrative payload is:

```ts
interface ContextMaterializedV2 {
  contextId: string;
  records: ContextRecordReference[];
  contentHash: string;
  codec: "agencity.context-fragments";
  codecVersion: 1;
  manifest: ContextManifestV1;
  definitions: ContextFragmentDefinition[];
  fragmentSources: ContextFragmentSource[];
  harnessProvenanceManifest?: ContextManifestV1;
  derivation?: ContextCompactionDerivation;
}

interface ContextFragmentDefinition {
  digest: string;
  encoding: "json-stringify-utf8-v1";
  byteLength: number;
  value: JsonValue;
}

interface ContextFragmentSource {
  digest: string;
  eventId: string;
  definitionOrdinal: number;
}

type ContextFragmentReference =
  | { location: "local"; definitionOrdinal: number }
  | { location: "prior"; sourceIndex: number };
```

Manifest nodes use tagged references. A local reference identifies an entry in the same event's `definitions` array by ordinal. A prior reference identifies an entry in `fragmentSources` by array index, so digests and prior source coordinates are not repeated throughout the manifest. Local definitions never refer to their owning event by ID; the append path may allocate the event ID normally. The durable meaning remains explicit: every reference identifies immutable bytes and either their local definition or the earlier event that owns them.

This design is preferred over placing context bodies in the existing artifact store because automatic artifact replication is currently unavailable. A synced event that depended on a machine-local artifact could become unresolvable on another device. Keeping definitions in event envelopes preserves current local, sync, export, and recovery boundaries.

### Deduplication scope follows visible branch history

The encoder may reuse a fragment only when its defining event:

- has the same `session_id`;
- precedes the new context event;
- is visible through the target branch's own history or ancestry;
- remains retained.

A fork can reuse definitions inherited from its ancestor. It cannot reference a definition that exists only on a sibling branch. Child sessions define their own fragments. This narrower scope gives up some cross-session deduplication in exchange for independent export, deletion, authorization, and sync behavior.

### Fragment boundaries are semantic and deterministic

Codec version 1 splits the final context after all normal materialization transforms have run. It does not recreate context from current projections.

The codec uses these boundaries:

- stable top-level values such as policy, runtime description, session metadata, profile projection, query hints, and action protocol;
- individual elements of repeatable arrays such as messages, tasks, mailbox entries, notices, recursive handles, documents, input sets, schedules, wakes, working values, artifacts, compactions, activity, and observations;
- individual harness entries and their bounded retrieval/provenance records;
- deterministic structural nodes that preserve top-level and nested object-key order and array order.

Small scalar structure may remain in the manifest when a reference would consume more bytes. The inline threshold is part of the codec version and is selected from benchmark evidence. Large strings remain exact string fragments in the first implementation; substring chunking is deferred unless benchmarks show that changing long strings dominate retained bytes.

The manifest is complete rather than expressed as a delta from a prior manifest. This bounds resolution work, avoids parent-chain corruption, and keeps structural sharing outside this plan.

### Derived rows contain references, not expanded context

A new migration changes `context_records` so mixed rows can represent:

- version 1: existing `context_json`, records, provenance, and derivation;
- version 2: manifest, fragment sources, records, provenance references, derivation, codec version, and content hash, with no expanded `context_json`.

The migration also adds a rebuildable `context_fragment_index` containing:

- session, branch/source visibility coordinates;
- digest;
- source event ID;
- definition ordinal;
- byte length and encoding.

The index does not copy fragment values. Resolution loads the canonical source event and validates its definition. An in-process bounded cache may retain verified decoded fragments for performance, but correctness cannot depend on it.

`docs/mutable-tables.md` must classify the fragment index as a rebuildable projection. The immutable fragment bytes remain canonical event payloads.

## Event-version evolution

The current runtime accepts a single global event schema version and has no upcaster registry. This plan must not weaken version validation or silently change the released version-1 payload.

Before version-2 context writes are enabled:

1. Replace the single uniform event validator with an explicit `(event type, schema version)` registry.
2. Continue accepting version 1 for every existing event.
3. Accept version 2 only for `ContextMaterialized`.
4. Add deterministic version-specific projection and resolution paths.
5. Preserve the original version number on storage reads, protocol events, sync envelopes, and exports.
6. Reject unsupported type/version pairs with a typed compatibility error.
7. Add retained version-1 fixtures and mixed version-1/version-2 replay tests.

Upcasting must not inflate every version-2 event back into a full inline payload during ordinary event loading. Reducers need only context identity, records, hash, and derivation. Callers that need the body use the context resolver explicitly.

## Write path

1. `ContextMaterializer` determines the stable `contextId` and idempotency key for the materialization intent. A caller-supplied idempotency key requires a stable caller-supplied `contextId`; otherwise the default key remains derived from the generated `contextId`.
2. Before rebuilding or encoding context, the materializer looks up an existing `ContextMaterialized` event for the same session, event type, and idempotency key. A matching event must agree on branch and `contextId`; the resolver returns that retained context and event without re-encoding. A mismatch remains an idempotency conflict.
3. When no matching event exists, `ContextMaterializer` builds the final context exactly as it does today, including any agent-run transform.
4. Secret rejection and redaction run before fragment encoding.
5. The codec calculates the existing full-context serialized bytes and `contentHash`.
6. The codec emits a complete manifest and candidate fragment definitions.
7. Storage finds reusable definitions visible to the target branch and rewrites matching candidates as prior references. Definitions owned by the new event remain local ordinal references and do not contain the new event's ID.
8. Canonical append validation checks:
   - every local definition's digest and byte length;
   - every earlier source event's session, visibility, order, schema, ordinal, digest, and value;
   - every local and prior manifest reference;
   - complete manifest resolution;
   - the final `contentHash`;
   - idempotency-key agreement over the complete durable payload.
9. The event and its reference projections commit in one relational transaction.
10. The already-built in-memory context may be returned to the immediate caller only after the canonical append succeeds.

Concurrent writers may independently define the same digest on divergent branches. Both events remain valid. The projection chooses only definitions visible to a given branch and never rewrites canonical history to select a global winner.

Idempotent retry never changes a committed payload from local definitions to prior references merely because the original event has become visible: the retained event is found and returned before encoding. Concurrent attempts that both reach append remain governed by the existing full-payload idempotency comparison. Identical payloads converge on the retained event; differing payloads produce an explicit conflict and never append a second event.

## Read and recovery path

Introduce an explicit context-resolution contract, for example:

```ts
interface ContextResolver {
  resolve(sessionId: string, branchId: string, contextId: string): Promise<{
    context: JsonValue;
    contentHash: string;
    event: AgentEvent<"ContextMaterialized">;
  }>;
}
```

Resolution behavior:

- Version 1 returns `payload.context` unchanged. Its `contentHash` remains a historical assertion and is not newly recomputed as an enforcing read-time check; this preserves the meaning and readability of retained version-1 history.
- Version 2 loads the complete manifest and every canonical fragment source, verifies each fragment, decodes the context, and verifies `contentHash`.
- Resolution rejects references outside the session or visible branch ancestry.
- Missing source events, invalid ordinals, changed encodings, size mismatches, and hash mismatches produce typed dependency failures.
- Rebuild reconstructs `context_records` and `context_fragment_index` solely from events, then resolves representative contexts to prove the index is not authority.

All direct reads of `event.payload.context` move behind this contract, including:

- autonomous agent-run admission, retry, and recovery;
- the advanced one-turn model loop;
- model effect execution after an outbox claim;
- context-window estimation and provider-overflow handling;
- context compaction and rematerialization;
- context inspection APIs and tests;
- any refinement or recursive-model inspection that reads complete context.

## Model effect and snapshot path

Referenced context events do not achieve the storage goal if the same expanded value is copied into a model effect that consumes that context. New model effect requests backed by `ContextMaterialized` use a typed reference input:

```ts
interface ReferencedModelEffectInput {
  inputFormat: "context-reference-v1";
  callId: string;
  contextId: string;
  contentHash: string;
  configuration: ModelConfiguration;
}
```

The model executor receives a `ContextResolver` dependency. After the outbox has claimed the durable request and before any provider network call, it resolves the context using the effect's session and branch, verifies `contentHash`, and passes the expanded value to the provider only in memory.

For context-backed calls, the durable effect request, outbox row, reducer `EffectState`, and snapshots retain the reference input rather than the expanded context. Sync and protocol streams therefore carry the reference-shaped effect as well.

The executor permanently supports both forms:

- inline model effects with `input.context`, including retained version-1 requests and new context-independent requests;
- referenced context-backed model effects with `inputFormat: "context-reference-v1"`.

Model-summary compaction effects construct bounded prompts that do not have a `ContextMaterialized.contextId`. They remain inline model effects. Their frozen source payloads and any separate optimization of those forensic inputs remain outside this plan. The executor dispatches by input shape and does not require a context resolver for inline effects.

The reference form does not change outbox ordering, idempotency, attempt accounting, cancellation, or unknown-outcome rules. Failure to resolve before contacting the provider records a dependency failure and cannot become an unknown provider outcome. Once the provider call begins, existing non-idempotent recovery semantics apply.

## Synchronization

Version-2 context events continue to use event envelopes. No separate blob transport is introduced.

The envelope dependency extractor adds every earlier fragment source event ID from a version-2 manifest to `dependencies`, alongside stream-parent and causation dependencies. Ingestion must:

1. retain version-1 envelope behavior;
2. wait until all fragment-source event envelopes are present;
3. validate branch remapping without changing stable source event IDs;
4. resolve and hash-check the context before accepting its derived projection;
5. quarantine missing, invisible, malformed, or digest-mismatched references;
6. preserve independently defined equal fragments on divergent branches without inventing a conflict.

A synchronized context is usable only when all canonical definitions are present. Transport success alone is not reported as complete context availability.

## Export, backup, and deletion

Because fragment definitions remain in canonical events:

- existing event JSONL exports contain the required bytes;
- no new sidecar directory is required for context recovery;
- database backup remains sufficient for context records, while existing general artifact backup requirements remain unchanged.

Export verification must resolve every exported version-2 context and report a partial export if any definition is unavailable or corrupt. Export manifests should include counts and logical bytes for contexts, unique fragments, and references.

Independent-session deletion remains safe because cross-session fragment references are forbidden. Deletion removes the session's events and derived fragment index rows through the existing guarded process. Shared artifact deletion behavior is unchanged.

## Protocol and API compatibility

Snapshots continue exposing context provenance rather than full historical bodies. Context inspection endpoints return the same expanded values after resolving them server-side.

Committed event streams preserve each event's actual schema version. Protocol clients must either:

- support version-2 `ContextMaterialized` payloads; or
- treat unknown context payload versions as opaque non-state-changing activity while relying on snapshots for projected state.

The protocol compatibility range and TypeScript event types must make this explicit. The bundled CLI, TUI, managed service, and client library ship dual-version support before version-2 writes become the default.

No public caller should need to understand fragment manifests to request a model turn or inspect a context. A low-level diagnostic may expose the manifest and deduplication statistics separately.

## Security and authority

- Existing secret scrubbing and known-secret rejection apply to fragment definitions before append.
- A digest is identity and integrity evidence, not authorization.
- Resolution enforces session and branch visibility even if an equal digest exists elsewhere in the trusted-local database.
- Raw SQL remains a shared non-confidential diagnostic surface; references do not create a confidentiality boundary.
- Error messages may include context IDs, event IDs, digests, and ordinals, but never fragment content that failed secret checks.
- Malformed manifests receive depth, node-count, fragment-count, and total-byte bounds before allocation or recursive decoding.

## Implementation phases

### Phase 0 — Baseline and fixtures

- Add deterministic growing-conversation, stable-large-harness, branch/fork, and compaction workloads.
- Measure:
  - database file, WAL, and page usage after checkpoint;
  - `ContextMaterialized.payload_json` bytes;
  - `context_records` bytes;
  - model `EffectRequested` event, outbox, effect projection, and snapshot bytes;
  - sync-envelope and export amplification;
  - unique fragment bytes and reference/manifest bytes;
  - materialization and recovery-resolution latency.
- Record results by workload and context turn. Do not infer savings from event counts.

### Phase 1 — Event-version foundation

- Add the per-event schema-version registry.
- Preserve every existing version-1 fixture.
- Add explicit unsupported-version errors, mixed-history reducer tests, protocol tests, and sync-envelope tests.
- Update `docs/events.md` before introducing version-2 writes.

### Phase 2 — Pure fragment codec

- Implement versioned encode/decode functions with no storage dependency.
- Preserve exact serialized bytes and key/array order.
- Add corruption, bounds, Unicode, empty-value, repeated-value, and randomized round-trip tests.
- Benchmark candidate inline thresholds and fragment boundaries against Phase 0 fixtures.

### Phase 3 — Relational projection and resolver

- Add the numbered migration for mixed `context_records` rows and `context_fragment_index`.
- Extend storage contracts for visible-fragment lookup and context resolution.
- Rebuild both projections from mixed histories.
- Add bounded verified-fragment caching only after uncached correctness passes.

### Phase 4 — Dual-read runtime integration

- Route every complete-context read through the resolver.
- Add dual-format model effect execution and change new context-backed model-effect inputs to context references while preserving inline requests for retained history and context-independent calls such as model-summary compaction.
- Keep version-1 writes as the default.
- Exercise agent runs, one-turn calls, compaction, refinement, recursive models, context inspection, restart, and recovery against both formats.
- Remove direct runtime assumptions that `payload.context` always exists, and make model execution dispatch explicitly between inline and referenced inputs.

### Phase 5 — Version-2 write and sync integration

- Enable version-2 writes behind an internal compatibility gate.
- Add fragment dependencies to sync envelopes and validate them during ingestion.
- Update export, deletion, protocol, TUI/client compatibility, and diagnostics.
- Run offline, divergent-branch, missing-dependency, export/import, and crash-boundary tests.

### Phase 6 — Default and documentation

- Compare fresh version-1 and version-2 fixture databases.
- Make version-2 writes the default only when:
  - every exactness and compatibility gate passes;
  - context-attributable durable bytes fall by at least 50% on the growing-conversation and stable-large-harness fixtures;
  - total fresh-workspace durable bytes improve materially;
  - context resolution does not create a material model-admission latency regression.
- Retain dual readers permanently.
- Update `AGENTS.md`, README status where appropriate, `docs/architecture.md`, `docs/events.md`, `docs/mutable-tables.md`, `docs/recovery.md`, `docs/protocol.md`, and verification evidence.

If the 50% context-byte target is missed, keep version-1 writes as the default and use the measurements to decide whether long-string chunking is warranted. Do not add manifest deltas or a Merkle tree without separate evidence.

## Verification matrix

### Codec and integrity

- Exact round-trip for every JSON value kind.
- Stable object-key and array ordering.
- Unicode, escaping, negative zero behavior, large strings, and nested bounds.
- Duplicate fragments defined once within visible history.
- Digest, byte-length, source-event, ordinal, codec-version, and final-context-hash failures.
- Decoder limits prevent cyclic manifests, excessive depth, excessive references, and allocation abuse.

### Events, storage, and replay

- Version-1-only, version-2-only, and mixed retained histories.
- A retained version-1 context with a shape-valid but mismatched historical `contentHash` remains readable and is not reinterpreted as a version-2 integrity failure.
- Duplicate application remains a true no-op.
- A committed idempotent materialization retry returns the retained event before encoding, without changing local definitions into prior references or producing a conflict.
- Same-source concurrent attempts for one stable materialization intent append at most one event; payload disagreement remains an explicit conflict.
- Projection deletion and rebuild produce the same context records and fragment index.
- Rebuild does not execute model or tool effects.
- A fork reuses ancestor definitions but cannot use sibling-only definitions.
- Cross-session and future-event references are rejected.
- Migration and reopen are idempotent.

### Runtime and recovery

- Immediate model calls receive a deep-equal context before and after the change.
- Restart before context append creates no durable context.
- Restart after context append but before model request resolves the retained context and admits one model request.
- Restart after model request does not rematerialize context or duplicate the effect.
- Missing or corrupt fragments block before a provider effect.
- New context-backed model effect events, outbox rows, reducer state, and snapshots contain only the context reference; retained and context-independent inline model effects still execute correctly.
- A resolver failure records a dependency failure without contacting the provider or producing an unknown provider outcome.
- Context-window estimation and overflow retries use resolved exact contexts.
- Deterministic and model-summary compaction retain their current source and derivation semantics.
- Model-summary compaction prompts remain explicit inline effects and execute without a `contextId`.

### Sync and branches

- Version-1 envelopes remain accepted.
- Fragment-source dependencies arriving after the referencing envelope remain pending and later ingest.
- Permanently missing or corrupt sources remain explicit quarantine states.
- Offline writers defining equal fragments do not lose either branch.
- Branch remapping preserves source identities and exact context hashes.
- Pulling a complete context onto another device allows resolution without an artifact side channel.

### Export and deletion

- Complete export includes all definition events and verifies every referenced context.
- Corruption produces a partial export with explicit missing evidence.
- Independent-session deletion cannot remove content needed by another retained session because such references are invalid.
- Reopen and retry remain safe after partial physical deletion.

### Protocol and product

- Snapshot-plus-stream clients handle mixed event versions and cursor resume.
- TUI rendering and context inspection remain unchanged.
- No context event replay repeats a model call.
- Installed-product acceptance covers task, detach, service restart, resume, branch, and history on version-2 writes.

### Security

- Known credential values cannot enter definitions, manifests, diagnostics, exports, or error text.
- References cannot cross the validated session/branch boundary.
- Malformed untrusted sync envelopes fail closed without loading unbounded content.

### Storage benchmark

- Report logical expanded-context bytes, unique fragment bytes, manifest/reference bytes, event bytes, projection bytes, database bytes, and WAL bytes separately.
- Compare equal fresh workloads after checkpoint and close.
- Report savings for context-attributable bytes and the complete workspace rather than presenting one favorable denominator.
- Keep benchmark fixtures deterministic and part of regression verification.

## Expected implementation areas

- `src/domain/events.ts` — versioned payload types and validators.
- `src/domain/reducer.ts` and `src/domain/state.ts` — version-aware metadata projection.
- `src/domain/context-fragments.ts` — pure codec, bounds, digest, and manifest types.
- `src/storage/contract.ts` — fragment lookup and context-resolution contracts.
- `src/storage/libsql.ts` — append validation, projections, rebuild, and mixed-row reads.
- `src/storage/migrations/015_context_references.sql` — mixed context records and fragment index.
- `src/runtime/context.ts` — encode on materialization.
- `src/runtime/agent-runs.ts` and model-loop code — write reference-shaped model effects and resolve before use.
- `src/executors/model.ts` and outbox wiring — dual-format effect input and resolver-backed provider execution.
- Context compaction services — resolve referenced contexts while retaining current frozen-source semantics.
- `src/sync/types.ts` and `src/sync/service.ts` — source dependencies and ingestion validation.
- `src/protocol/` and `src/tui/` — mixed-version compatibility.
- `test/` — codec, storage, replay, recovery, sync, export/deletion, protocol, security, and benchmark coverage.
- `docs/` and `AGENTS.md` — event evolution, table classification, recovery, placement, and verification claims.

## Completion criteria

The work is complete when:

1. New contexts default to the referenced format and old contexts remain readable.
2. Every model provider receives the same context value as the inline implementation for the same retained history.
3. New model effects backed by `ContextMaterialized`, together with their outbox rows, effect projections, snapshots, sync envelopes, and exports, contain context references rather than expanded context copies. Context-independent effects such as model-summary compaction prompts remain inline.
4. Recovery never depends on a live heap, projection-only bytes, or an unreplicated artifact.
5. Missing or corrupt references prevent dependent model effects and remain visible.
6. Mixed histories rebuild, sync, export, branch, and delete correctly.
7. Context-attributable durable bytes meet the benchmark target without hiding bytes in an uncounted side store.
8. Typecheck, architecture checks, relevant unit/integration/E2E/acceptance suites, and the full `bun run verify` gate pass.
9. Documentation describes the new format, compatibility boundary, measured savings, and remaining limitations without claiming structural sharing or general artifact replication.

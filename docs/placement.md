# Placement adapters and conformance

Agencity separates relational state, artifact storage, memory candidate generation, and effect execution from their physical placement. The package provides local adapters, remote HTTP client adapters, and matching server handlers.

An implemented adapter is not a managed deployment. This repository does not provision, host, authenticate, monitor, or operate a remote relational service, object store, candidate-index service, or execution sandbox. An integrator supplies the endpoint and its security, availability, and isolation controls.

The ordinary local product composes local LibSQL, a local filesystem content-addressed store (CAS) for artifacts, local FTS5 candidate generation, and trusted-local executors. The per-workspace managed product service is still local process lifecycle; it is not the remote placement service described here.

## Capability and failure rules

Every placement publishes a descriptor with:

- `placement`: `local` or `remote`;
- `transport`: `in-process` or `http`;
- a versioned component protocol;
- component-specific capabilities.

Callers must check optional capabilities. A request for semantics the adapter did not advertise fails with `CAPABILITY_UNAVAILABLE`; the runtime does not silently emulate a weaker guarantee or switch to local placement.

Availability is distinct from capability:

- an advertised remote operation whose endpoint, object, or valid response is unavailable fails with `DEPENDENCY_FAILURE`;
- remote executor transport loss after dispatch returns the typed effect outcome `unknown`, because the external effect may have happened;
- a server-observed executor exception is definitively `failed`;
- cancellation before dispatch is `cancelled`.

These distinctions preserve unsupported, unavailable, failed, cancelled, and uncertain states.

## Relational state

`localRelationalState(storage)` describes an in-process `AgentStorage`.

`HttpRelationalStateStore.connect()` discovers capabilities and implements the storage contract over `agencity-relational-rpc-v1`. `createRelationalStateRpcHandler()` is the matching handler for a server-owned `AgentStorage`.

```ts
import {
  HttpRelationalStateStore,
  createRelationalStateRpcHandler,
} from "@prime-agent/runtime/placement";

// In an operator-owned server process:
const handler = createRelationalStateRpcHandler(serverOwnedStorage, {
  analyticalSql: true,
  administrativeMigrations: false,
});
Bun.serve({ fetch: handler });

// In the runtime process:
const storage = await HttpRelationalStateStore.connect({
  endpoint,
  headers: () => ({ authorization: `Bearer ${token}` }),
});
```

The RPC allowlist contains known storage-domain methods; it cannot dynamically invoke arbitrary methods. Values cross a versioned JSON codec that supports `Uint8Array` and `bigint`. LibSQL and Turso SDK values stay inside adapters.

The HTTP relational adapter advertises:

- no offline writes;
- no same-device process fencing in this protocol version;
- no in-process commit notifications;
- the backing store's distributed-lease capability;
- analytical SQL only when the server enables it;
- administrative migration only when the server enables it;
- recursive operations and candidate-index rebuild only when the backing store implements them.

Remote subscriptions are unavailable. Remote migration is operator-owned by default.

The included handler does not add authentication, TLS, tenancy, rate limiting, or deployment management. Wrap it in an operator-controlled service boundary.

## Artifact content-addressed storage

`LocalArtifactStore` uses a filesystem CAS. `localObjectCasDescriptor()` publishes its placement capabilities.

`S3CompatibleArtifactStore` implements path-style S3/R2 HTTP `PUT`, `GET`, and `DELETE`. It accepts static headers or an authorization callback, allowing an integrator to provide SigV4 or an edge credential broker without exposing an official object-store SDK type in Agencity's API.

```ts
import {
  S3CompatibleArtifactStore,
} from "@prime-agent/runtime/placement";

const artifacts = new S3CompatibleArtifactStore({
  endpoint: "https://objects.example",
  bucket: "agencity",
  prefix: "artifacts",
  headers: async ({ method, url, key, digest }) =>
    signObjectRequest({ method, url, key, digest }),
});
```

Object keys derive only from content:

```text
<prefix>/sha256/<first two hex digits>/<64-character sha256 digest>
```

The durable ID remains `sha256:<digest>` across local and remote placement. Conditional PUT uses `If-None-Match: *` and checksum metadata. Every resolve verifies byte length and digest. Range reads download and verify the whole object before returning a slice because the artifact ID authenticates the complete object.

Missing, inaccessible, malformed, or corrupt content is `DEPENDENCY_FAILURE`.

This adapter provides remote object placement, not replication between local and remote stores. The runtime does not automatically copy artifact bytes during Turso envelope sync and does not provide artifact garbage collection.

## Memory candidate index

`localCandidateIndexDescriptor(index)` describes an in-process candidate generator.

`HttpMemoryCandidateIndex.connect()` and `createCandidateIndexRpcHandler()` implement `agencity-candidate-index-http-v1`. The service returns only stable `{ versionId, entryId, rank }` candidates. It does not decide whether a record may enter model context.

`MemoryService` loads canonical records from relational state and applies authoritative scope, version status, candidate exposure, tags, recency, conflicts, and limits after candidate generation. A remote index can therefore return an out-of-scope candidate without bypassing runtime policy.

Rebuild is an optional administrative capability and fails with `CAPABILITY_UNAVAILABLE` when not advertised.

The default candidate index is local FTS5. The remote adapter can front FTS or another candidate generator, but this repository does not include embedding generation or a hosted semantic-search service.

## Effect execution

`TrustedLocalExecutor` wraps an in-process executor and reports its actual trust boundary:

- `isolation: "trusted-local-process"`;
- `isolatedFromHost: false`;
- explicit operation, filesystem, network, cancellation, and typed-outcome capabilities.

`RemoteSandboxExecutor.connect()` accepts a server only when it advertises:

- `isolation: "managed-remote-sandbox"`;
- `isolatedFromHost: true`;
- an explicit operation set and filesystem/network policy.

`createExecutorRpcHandler(executor, policy)` publishes the matching `agencity-executor-rpc-v1` handler. The server operator supplies the isolation assertion. A client option cannot promote a trusted process into a sandbox.

The handler itself does not create or verify an OS sandbox. To make the descriptor truthful, the operator must run the handler inside a container, microVM, separate host, or equivalent isolation boundary with the advertised filesystem and network controls. The conformance test server verifies HTTP and effect semantics only; it does not verify OS isolation or attestation.

Requests outside the advertised operation set fail with `CAPABILITY_UNAVAILABLE`. After dispatch:

- a valid server terminal result is `succeeded`, `failed`, or `cancelled`;
- timeout, disconnect, missing terminal response, or malformed terminal response becomes `unknown`;
- no automatic local fallback occurs.

The included executor RPC handler does not provide authentication, TLS, resource quotas, network policy, sandbox provisioning, or remote attestation.

## Conformance evidence

`test/placement/conformance.ts` defines shared behavioral suites:

- `relationalStateConformance`;
- `artifactStoreConformance`;
- `candidateIndexConformance`;
- `executorConformance`.

`test/placement/placement.test.ts` applies the same suites to local and remote implementations. Remote tests use real loopback HTTP boundaries and independently owned server-side databases, indexes, object maps, or executor workspaces. Additional cases stop transports and corrupt object bytes to verify dependency-failure and unknown-outcome behavior.

The object map and loopback executor used by tests are fixtures. There is no in-memory production fallback, hosted control plane, or production sandbox supplied by this repository.

## Integration checklist

1. Discover and persist the adapter descriptor.
2. Reject a deployment whose required capabilities are false.
3. Supply authentication, TLS, tenancy, rate limits, and endpoint lifecycle outside the provided handlers.
4. Keep remote placement failure visible; never switch to local placement implicitly.
5. Preserve `unknown` for effects that may have crossed the dispatch boundary.
6. Back up relational state and referenced artifact bytes together.
7. Treat executor isolation as an operator assertion that requires an actual external sandbox.

See [TypeScript integration API](./api.md), [Capability matrix](./capabilities.md), [Trusted-local security boundary](./security.md), and [Crash recovery and unknown effects](./recovery.md).

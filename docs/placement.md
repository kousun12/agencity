# Placement adapters and conformance

Agencity treats relational state, artifacts, retrieval candidate generation, and execution as replaceable components. The default implementations remain local. The `@prime-agent/runtime/placement` export adds remote adapters whose calls cross a real HTTP boundary and whose server-side state is not available to the client object.

## Capability rule

Every adapter publishes a placement descriptor containing its location, transport/protocol, and component-specific capabilities. A caller must branch on that descriptor before requesting optional behavior. Adapters fail closed with the stable `CAPABILITY_UNAVAILABLE` domain code when optional behavior is not advertised; they do not emulate a weaker guarantee.

Dependency availability is separate from capability. An advertised remote operation whose endpoint, object, or valid response is unavailable fails as `DEPENDENCY_FAILURE`. The remote executor is the exception required by side-effect semantics: losing its response after dispatch yields the typed `unknown` outcome because the effect may have happened.

## Relational state

`localRelationalState(storage)` describes a process-local `AgentStorage`. `HttpRelationalStateStore.connect()` discovers a server's capabilities and implements the same storage contract through `agencity-relational-rpc-v1`. `createRelationalStateRpcHandler()` is the matching production HTTP handler for a server-owned store.

The RPC allowlist contains domain storage operations only. It cannot dynamically invoke arbitrary methods. Values cross a versioned JSON wire codec, including `Uint8Array` and `bigint`; no LibSQL or Turso SDK value crosses the adapter boundary. Remote subscriptions are not implied by HTTP RPC and currently throw `CAPABILITY_UNAVAILABLE`. Remote schema migration is operator-owned unless the handler explicitly enables `administrativeMigrations`.

A typical server mounts the handler in its own process:

```ts
const handler = createRelationalStateRpcHandler(serverOwnedStorage, {
  analyticalSql: true,
  administrativeMigrations: false,
});
Bun.serve({ fetch: handler });
```

The client knows only the URL:

```ts
const storage = await HttpRelationalStateStore.connect({ endpoint });
```

## Artifact CAS

`localObjectCasDescriptor()` declares the capabilities of the filesystem CAS. `S3CompatibleArtifactStore` uses path-style S3/R2 HTTP object operations (`PUT`, `GET`, and `DELETE`) and accepts an authorization-header callback so a deployment can supply SigV4 or an edge credential broker without leaking official SDK types into public contracts.

Object keys derive only from the bytes:

```text
<prefix>/sha256/<first two hex digits>/<64-character sha256 digest>
```

The durable artifact ID remains `sha256:<digest>` across local files and object storage. PUT sends `If-None-Match: *`, `x-amz-checksum-sha256`, and `x-amz-meta-sha256`. Every resolve verifies both byte length and sha256. Export and range-read verify the complete object before returning data; a sha256 ID authenticates the whole object, so the current integrity-preserving range implementation deliberately downloads the complete object rather than trusting an unauthenticated partial response. Missing, inaccessible, or corrupt objects are `DEPENDENCY_FAILURE`.

## Memory candidate index

`HttpMemoryCandidateIndex.connect()` and `createCandidateIndexRpcHandler()` implement `agencity-candidate-index-http-v1`. The service returns only stable `(versionId, entryId, rank)` candidates. It has no authority to admit a memory into context.

`MemoryService` continues to load canonical memory rows from relational state and applies authoritative session/workspace/user/global scope, version status, candidate exposure, tags, recency, conflict, and limit filters after candidate generation. Tests deliberately make the remote index return an out-of-scope candidate and prove the runtime rejects it. Rebuild is administrative and throws `CAPABILITY_UNAVAILABLE` unless the remote service advertises it.

## Executors

`TrustedLocalExecutor` wraps an existing local executor and labels the actual trust boundary accurately:

- `isolation: trusted-local-process`
- `isolatedFromHost: false`
- explicit operation, filesystem, network, and cancellation capabilities

`RemoteSandboxExecutor.connect()` accepts managed isolation only when the server advertises `managed-remote-sandbox` and `isolatedFromHost: true`. `createExecutorRpcHandler()` receives that assertion from the server operator; a client option cannot promote a trusted process into a sandbox. A real deployment must run this handler inside the stated managed sandbox or equivalent isolation boundary. The loopback conformance server verifies transport semantics, not OS isolation.

Both placements return only `succeeded`, `failed`, `cancelled`, or `unknown`. A server-observed executor exception is definitively `failed`. Cancellation before dispatch is `cancelled`. Timeout, disconnection, or a malformed response after dispatch is `unknown`, preserving uncertainty for non-idempotent effects. Requests outside the advertised operation set throw `CAPABILITY_UNAVAILABLE`.

## Shared conformance suites

`test/placement/conformance.ts` exports one behavioral function per contract:

- `relationalStateConformance`
- `artifactStoreConformance`
- `candidateIndexConformance`
- `executorConformance`

`test/placement/placement.test.ts` runs each same function against both local and remote implementations. Remote cases start actual loopback Bun HTTP servers backed by independent server-owned LibSQL databases, FTS5 indexes, object maps, or executor workspaces. The suite additionally stops transports and corrupts object bytes to verify dependency and uncertainty behavior. Test object maps are server fixtures only; no production adapter has an in-memory/mock fallback.

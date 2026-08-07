# Current capability matrix

This page distinguishes implemented behavior, behavior that requires external configuration or infrastructure, and behavior the repository does not provide.

Status meanings:

- **Supported**: implemented in the repository and available in the documented local composition.
- **Conditional**: implemented, but usable only with credentials, an external service, an operator-supplied adapter, or explicit opt-in.
- **Unavailable**: no supported implementation or deployment is provided.

“Adapter implemented” means the package contains a client/handler contract and conformance coverage. It does not mean Agencity hosts, provisions, authenticates, or operates the remote endpoint.

## Product and execution

| Capability | Status | Current behavior |
|---|---|---|
| Local terminal product | Supported | `agencity` and `bun run dev` resolve a workspace, create or resume durable work, and enter the same product flow. |
| Full-screen terminal UI | Supported | The OpenTUI client consumes the public snapshot/event protocol, supports detach/catch-up, provider/model selection, contextual inspection, and a plain non-TTY transcript fallback. |
| Typed autonomous runs | Supported | Product tasks use strict version-1 model actions. Generated execution occurs only through validated TypeScript cells; final, clarification, permission, blocked, and failed are typed run control. |
| Durable recovery | Supported | Canonical events, outbox effects, cells, tasks, mailboxes, goals, schedules, and recursive model handles recover at committed boundaries. |
| Unknown-effect reconciliation | Supported | Operators can inspect and append evidence. Unknown status is not rewritten and no retry is authorized automatically. |
| Managed local workspace service | Supported | The product discovers or starts an authenticated loopback service with same-device process fencing, resident run advancement, recovery, schedules, and graceful idle shutdown. |
| Hosted or multi-tenant Agencity service | Unavailable | No hosted control plane, tenant authorization layer, TLS service, or production remote deployment is supplied. |
| Demo mode | Unavailable | There is no product demo provider. Echo is an internal deterministic test fixture and is excluded from product selection, onboarding, help, and status. |

## Models and providers

| Capability | Status | Current behavior |
|---|---|---|
| OpenAI | Conditional | Built-in OpenAI-compatible provider; requires a stored/programmatic key or `OPENAI_API_KEY` and an explicit model ID. |
| Anthropic | Conditional | Built-in Anthropic-compatible provider; requires a stored/programmatic key or `ANTHROPIC_API_KEY` and an explicit model ID. |
| Vercel AI Gateway | Conditional | Built-in gateway provider; requires a stored/programmatic key or `AI_GATEWAY_API_KEY` and an explicit gateway model ID, which may contain `/`. |
| Custom embedded provider | Conditional | An embedding host can pass `modelProviders` to `Supervisor.open`; the provider must implement the model contract and truthful capabilities. |
| Provider streaming | Conditional | Used only when a provider declares streaming and implements `stream`. Deltas are cursorless temporary progress; the full terminal response remains atomic. |
| Provider/model onboarding | Supported | Interactive missing configuration offers OpenAI, Anthropic, or Vercel, hides key input, and asks for the exact model ID. Non-interactive missing configuration fails with setup guidance. |
| Real-provider verification in the default suite | Unavailable | The deterministic suite does not prove a live provider. Live verification is an explicit credential-gated test. |

## Local state, sync, and coordination

| Capability | Status | Current behavior |
|---|---|---|
| Local canonical storage | Supported | Local LibSQL event history is canonical. Projections and snapshots are rebuildable; artifact bytes live in a content-addressed store. |
| Offline local writes | Supported | Local execution remains usable without Cloud or while the optional sync endpoint is unavailable. |
| Turso envelope synchronization | Conditional | The pinned Turso Sync adapter exchanges immutable envelopes through a separate replica and exposes directional push, pull, checkpoint, and statistics. It requires an external compatible endpoint. |
| Conflict and quarantine visibility | Supported | Divergent claims, invalid envelopes, dependencies, and explicit conflict resolution remain inspectable. No automatic conflict winner is invented. |
| Artifact replication through sync | Unavailable | Envelope synchronization does not copy referenced artifact bytes. |
| Distributed leases or task stealing | Unavailable | Sync is not a lock service and provides no distributed execution coordination. |
| Automatic cross-device execution-owner failover | Unavailable | Session ownership remains single-device. The product can fence and recover same-device local processes only. |
| PostgreSQL coordination/storage | Unavailable | PostgreSQL is not an implemented storage or coordination prerequisite. |

## Placement

| Capability | Status | Current behavior |
|---|---|---|
| Local relational placement | Supported | `LibSqlStorage` plus `localRelationalState` provide offline writes, analytical SQL, notifications, and same-device process fencing. |
| Remote relational HTTP adapter | Conditional | `HttpRelationalStateStore` and `createRelationalStateRpcHandler` implement a conformance-tested HTTP boundary. The integrator must deploy and secure the server. Remote notifications and same-device fencing are unavailable in this protocol version; migration is operator-enabled. |
| Local content-addressed artifact store | Supported | `LocalArtifactStore` uses stable SHA-256 identity and verifies digest and size. |
| S3/R2-style remote artifact adapter | Conditional | `S3CompatibleArtifactStore` implements path-style HTTP object operations and accepts operator-supplied authorization headers. The integrator supplies the object service. |
| Local FTS5 candidate index | Supported | FTS5 generates deterministic memory candidates; runtime policy remains authoritative. |
| Remote candidate-index HTTP adapter | Conditional | `HttpMemoryCandidateIndex` and its handler are implemented. The integrator supplies the service; rebuild is optional. |
| Embedding-based retrieval | Unavailable | No embedding generator, vector store, or semantic retrieval deployment is provided. |
| Trusted local executors | Supported | File, shell, model, and skill execution use typed outbox outcomes under the OS authority of the runtime process. |
| Remote executor transport | Conditional | `RemoteSandboxExecutor` and its handler implement typed HTTP execution semantics. The operator must deploy the handler inside a real sandbox and truthfully advertise policy. |
| Managed remote sandbox deployment | Unavailable | The repository does not provision a container, microVM, remote host, network policy, resource quotas, or attestation. |
| Automatic remote-to-local fallback | Unavailable | Remote transport failure remains `DEPENDENCY_FAILURE` or executor `unknown`; placement does not change silently. |

## Security and authority

| Capability | Status | Current behavior |
|---|---|---|
| Trusted-local execution | Supported | Generated TypeScript and shell commands have the runtime process's OS authority. |
| Managed loopback bearer authentication | Supported | The managed product service authenticates every loopback route using an owner-only discovery manifest. |
| Embedded diagnostic HTTP authentication | Unavailable by default | The diagnostic server is unauthenticated. A custom embedded host can configure a bearer but owns the complete boundary. |
| Hostile-code sandbox | Unavailable | The Bun console worker and skill child processes are crash/protocol boundaries, not security sandboxes. |
| Multi-tenant authorization | Unavailable | Scope filtering governs product behavior and context; it is not protection from hostile local code or shared diagnostic SQL. |
| Network isolation and syscall/resource policy | Unavailable | These must be supplied by an external container, microVM, host, or other sandbox. |
| Credential exposure reduction | Supported | Provider keys remain supervisor-side, credential-shaped environment variables are removed from worker/shell environments, and known values are rejected or redacted before durable append. This is defense in depth, not a vault. |
| Browser execution | Unavailable | No browser executor or browser tool is included. |

## Artifacts and data control

| Capability | Status | Current behavior |
|---|---|---|
| Integrity-checked artifact reads/exports | Supported | Local and S3-compatible stores verify content identity and size. Missing or corrupt content is a dependency failure. |
| Automatic artifact garbage collection | Unavailable | Unreferenced CAS bytes can remain after failed staging; no automatic GC is implemented. |
| Owned local session deletion | Conditional | Supported only when the session is independently erasable and retained references permit safe content-addressed artifact removal. |
| Owned local workspace deletion | Conditional | Requires exact confirmation, quiescence, an external receipt directory, and an explicit exclusive artifact-directory ownership assertion. |
| Owned local profile deletion | Conditional | Requires exact confirmation and an external receipt directory; removes profile state and the profile credential file when checks pass. |
| Managed remote workspace deletion | Conditional | Requires an operator-supplied `ManagedReplicaDeletionAdmin` with authenticated administration for every durable managed URL. Data-plane sync credentials are insufficient. |
| Built-in Turso Cloud administrative deletion | Unavailable | The installed Turso data/sync client does not provide the required production administrative control plane. |
| Remote session/profile deletion granularity | Unavailable | Managed remote deletion supports workspace replicas only. |

Deletion is fail-closed. `planned`, `blocked`, or `partial` receipts are not proof of complete erasure.

## Installation and release

| Capability | Status | Current behavior |
|---|---|---|
| Source checkout | Supported | Bun 1.2 or newer with `bun install --frozen-lockfile`; `bun run dev` enters the product. |
| Local `bun link` executable | Supported | `bun link` exposes `agencity` from the checkout and is covered by isolated linked-executable acceptance tests. |
| Package registry release | Unavailable | The package is private and not published. |
| Standalone binary/download channel | Unavailable | No supported standalone artifact is published or tested. |
| Production-ready product claim | Unavailable | Passing local runtime tests does not establish hosted operations, hostile-code isolation, external integration availability, or production readiness. |

## Verification tiers

Deterministic local tests cover the runtime, protocol, managed product path, and placement contracts. External rows are opt-in and can skip when prerequisites are absent.

| Verification | Status | Command and interpretation |
|---|---|---|
| Deterministic repository checks | Supported | `bun run verify`; reports only the checks actually run. |
| Isolated linked-product acceptance | Supported | `bun run test:acceptance` and `bun run test:acceptance:matrix`. |
| Real OpenAI-compatible provider smoke | Conditional | `AGENCITY_ACCEPTANCE_REAL_PROVIDER=1 OPENAI_API_KEY=... AGENCITY_ACCEPTANCE_REAL_MODEL=... bun run test:acceptance:external`. |
| Official Turso Sync server conformance | Conditional | `TURSO_SYNC_SERVER_BIN=/absolute/path/to/tursodb bun run test:turso-official`. The binary must match the pinned protocol version. |
| Real Turso Cloud smoke | Conditional | `AGENCITY_TURSO_SMOKE=1 TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... bun run test:acceptance:matrix` against a disposable database. |
| Hosted placement/sandbox verification | Unavailable | Loopback placement conformance proves adapter semantics, not a production endpoint or OS sandbox. |

A skipped external test is **unverified**, not passed. Report pass, fail, and skip counts separately.

See [TypeScript integration API](./api.md), [Public client protocol](./protocol.md), [Generated TypeScript console SDK](./console-sdk.md), [Placement adapters](./placement.md), and [Trusted-local security boundary](./security.md).

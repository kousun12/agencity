# ADR 0011: Capability-preserving placement contracts

- **Status:** Accepted
- **Date:** 2026-08-09
- **Scope:** Replaceable relational, artifact, retrieval, and execution placement
- **Extends:** [ADR 0001](./0001-durable-local-runtime-foundations.md)

## Context

Agencity is local-first, but relational state, content-addressed artifacts, memory candidate generation, and effect execution may need to move behind process or network boundaries. Physical placement must not become agent identity or silently change event, recovery, authority, or uncertainty semantics.

A remote client alone does not provide a hosted service, authentication, tenancy, availability, or isolation. Likewise, a server's claim that execution is sandboxed is not proof that an operating-system boundary exists.

## Decision

### Shared domain contracts

Local and remote implementations use the same domain-shaped contracts and durable identifiers:

- relational placement implements `AgentStorage`;
- artifact placement implements the content-addressed `ArtifactStore`;
- candidate-index placement returns stable memory entry/version identities and ranks while runtime policy remains authoritative; and
- executor placement accepts the same typed effect requests and returns `succeeded`, `failed`, `cancelled`, or `unknown`.

Adapter-specific SDK values remain inside adapters. Moving a component does not rename sessions, branches, events, artifacts, harness versions, effects, or tasks.

### Explicit capabilities

Every placement publishes a versioned descriptor containing its location, transport, and component capabilities. Callers check required capabilities before use. An unsupported operation fails with `CAPABILITY_UNAVAILABLE`; the runtime does not emulate a weaker guarantee, omit a required check, or switch to another placement.

Availability is separate from capability. A supported remote operation whose dependency cannot be reached or validated fails with `DEPENDENCY_FAILURE`, except when execution may already have crossed an external dispatch boundary. In that case the executor outcome is `unknown` and is not retried automatically.

### Local-first composition without hidden fallback

The ordinary product composes local LibSQL, a local filesystem content-addressed store, local FTS5 candidate generation, and trusted-local executors. Remote placement is explicit configuration. Loss of a remote transport does not cause an implicit return to local storage or execution.

Optional Turso envelope synchronization remains separate from relational placement. It exchanges immutable envelopes under [ADR 0003](./0003-turso-envelope-sync.md); it is not a remote `AgentStorage`, artifact replication mechanism, or execution coordinator.

### Remote handlers are integration boundaries

The repository provides versioned HTTP clients and matching handlers for relational state, candidate generation, and execution, plus an S3-compatible artifact adapter. These components provide protocol behavior, not a managed deployment.

The integrator owns endpoint authentication, TLS, tenancy, rate limiting, lifecycle, monitoring, and availability. A remote executor descriptor is an operator assertion. The handler does not create or attest a container, microVM, separate host, filesystem policy, network policy, or resource boundary.

### Conformance

Local and remote implementations run shared conformance suites for relational state, artifact integrity, candidate generation, and effect execution. Tests cover the real transport boundary, capability negotiation, dependency loss, content corruption, and uncertain executor dispatch.

Conformance proves the advertised protocol and domain behavior exercised by the suite. It does not prove a production deployment, hostile-code isolation, remote attestation, or an operator's infrastructure claims.

## Consequences

- Placement can change without changing durable agent identity or canonical semantics.
- Weaker implementations remain usable when their missing capabilities are explicit.
- Network and dependency failures stay distinguishable from unsupported behavior and uncertain effects.
- Local operation remains complete without Cloud.
- Remote integrations require operator-supplied security and operations.
- New placement implementations must publish truthful descriptors and pass the shared conformance contract.

## Rejected alternatives and limitations

1. **Make remote placement the source of new domain semantics.** Rejected because placement must not redefine identity, causality, authority, or recovery.
2. **Fall back to local components after remote failure.** Rejected because it would silently split state or execute work under different guarantees.
3. **Treat every remote failure as failed.** Rejected because an executor request may have crossed the dispatch boundary and must remain `unknown`.
4. **Infer capabilities from adapter class or endpoint reachability.** Rejected because supported semantics require an explicit versioned descriptor.
5. **Describe the included executor handler as a sandbox.** Rejected because protocol separation is not operating-system isolation or attestation.
6. **Use synchronization as generic remote storage or coordination.** Rejected because immutable envelope exchange has different authority and conflict semantics.

The current relational HTTP protocol does not provide offline writes, commit notifications, or same-device process fencing. The repository does not supply hosted placement infrastructure, automatic artifact replication, embedding retrieval, a managed remote sandbox, or remote-to-local fallback.

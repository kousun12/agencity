# Agent environments and service interfaces architecture plan

**Status:** First rough draft; not implementation-ready  
**Date:** August 11, 2026  
**Last revised:** August 11, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related planning:** [Dynamic typed connectors and managed RPC resources](./2026-08-09-dynamic-typed-connectors-plan.md), [Durable tenacious goal orchestration](./2026-08-09-tenacious-goal-orchestration-plan.md), [Durable agent profiles and automated refinement review](./2026-08-08-adaptive-agent-city-plan.md), and [Formal model-tool contracts](./2026-08-07-formal-model-tool-contracts-plan.md)  
**Governing decisions:** [Durable local runtime foundations](../docs/decisions/0001-durable-local-runtime-foundations.md), [Durable agent relationships](../docs/decisions/0006-durable-agent-relationships.md), [Managed workspace execution](../docs/decisions/0007-managed-workspace-execution.md), [Formal model-tool contracts](../docs/decisions/0010-formal-model-tool-contracts.md), and [Capability-preserving placement](../docs/decisions/0011-capability-preserving-placement-contracts.md)

## Summary

Agencity should support durable agents that can own isolated, addressable compute environments and publish versioned service interfaces. An environment can contain files, installed software, supervised processes, private services, durable volumes, and separately managed application data. It can be stopped while its agent identity and declared interfaces remain durable, then started on demand when authorized work arrives.

The long-term product model is a city of durable agents whose compute is idle by default:

```text
durable agent identity
  -> zero active instances while idle
  -> one or more explicitly admitted environment deployments
  -> one or more declared services
  -> versioned discoverable procedures
  -> authorized private peers and optional explicit ingress
```

A `Session` remains the durable agent identity. A process, container, microVM, host, endpoint, or deployment does not become that identity. The environment is a replaceable operational resource owned by the agent. This distinction lets an agent survive shutdown, placement changes, image upgrades, endpoint rotation, and infrastructure loss without changing its durable relationships or history.

Every runnable agent exposes a standard request/response procedure backed by its ordinary autonomous lifecycle. Agents may also publish domain-specific procedures such as `reviewPatch`, `queryCatalog`, `runSimulation`, or `deployPreview`. The TypeScript console reaches those procedures through a stable generic API:

```ts
const description = await sdk.agents.describe(target);
const reviewPatch = description.procedures.find(
  (procedure) => procedure.name === "reviewPatch",
);
if (!reviewPatch) throw new Error("reviewPatch is unavailable");

const result = await sdk.agents.rpc(
  target,
  "reviewPatch",
  { patch, priorities: ["correctness", "security"] },
  { expectedContractDigest: reviewPatch.contractDigest },
);
```

Procedure contracts are dynamic data. They include bounded documentation, runtime-validatable input and output schemas, version and digest, authority requirements, effect semantics, and availability. Generated TypeScript declarations may help human SDK consumers, but runtime validation is authoritative for model-generated cells.

Remote peers communicate through authenticated HTTP-based RPC routing. A tRPC-compatible TypeScript authoring model is a leading option, but this draft does not make a live tRPC router, JavaScript closure, or TypeScript type the durable contract. The durable contract must be serializable, immutable-versioned, language-neutral at the wire boundary, and independently validatable.

This plan defines the long-term architecture and staged path. It does not claim that Agencity currently provides isolated agent environments, remote sandbox provisioning, distributed execution ownership, peer authentication, dynamic agent RPC, managed volumes, hosted databases, or public service ingress.

## Product decision

Agencity will treat a durable agent as an actor that may own a computer-like execution environment and publish services, while preserving these separations:

- **Agent identity** is durable canonical state represented by a session and its retained relationships.
- **Environment identity** is a durable resource identity for the agent's operational compute and storage configuration.
- **Environment placement** selects the local process, container, microVM, remote sandbox, or future provider that realizes the environment.
- **Environment instances** are disposable allocations with endpoints, process IDs, container IDs, and lease epochs.
- **Service contracts** are immutable, versioned descriptions of callable behavior.
- **Service deployments** bind exact contract and implementation versions to an environment generation.
- **Procedure invocations** are durable outbox-backed effects.
- **Application state** belongs to declared volumes, managed services, artifacts, or external systems; it does not silently become canonical Agencity history.

The runtime will expose one stable `sdk.agents` facade rather than injecting a new top-level symbol or generated method set for every reachable peer. Dynamic procedure names and schemas remain discoverable data behind:

```ts
sdk.agents.describe(target)
sdk.agents.rpc(target, procedure, input, options?)
```

The ordinary provider action surface remains exactly `bun_console` and `finish`. Peer services expand what generated TypeScript can program against; they do not become additional provider tools.

## Current foundation and gap

Agencity currently provides:

- durable root and child sessions, tasks, budgets, cancellation, and family relationships;
- `sdk.agents.spawn`, family inspection, retained messaging, acknowledgement, follow-up, and cancellation;
- durable mailboxes that deliver terminal child outcomes to parents;
- recursive-model handles backed by child sessions and attributable model effects;
- a managed workspace service that owns detached execution, recovery, schedules, wakes, workers, and quiescent exit;
- durable schedules and heartbeats with logical wake records;
- an outbox that commits intent before external execution and preserves `succeeded`, `failed`, `cancelled`, and `unknown`;
- capability-preserving local and remote placement adapters;
- content-addressed artifacts and bounded model-facing retrieval;
- a trusted-local Bun console worker whose process boundary provides lifecycle and crash isolation, not hostile-code isolation.

Agencity does not currently provide:

- one isolated process, container, microVM, or remote sandbox per agent;
- environment image, package, volume, process, port, or lifecycle declarations;
- an environment provisioner, scheduler, or scale-to-zero wake router;
- distributed execution leases or automatic cross-device ownership failover;
- a durable registry of agent-published service contracts;
- `sdk.agents.describe` or `sdk.agents.rpc`;
- peer workload identity, delegated grants, procedure authorization, or revocation;
- private peer routing, TLS identity, service discovery, ingress, or public endpoint management;
- canonical artifact transfer from remote executors;
- managed durable volumes, snapshots, backups, or databases;
- sandbox attestation, network isolation, resource enforcement, or multi-tenant security;
- arbitrary service hosting as a supported product capability.

The remote executor protocol is a typed execution boundary, not a hosted sandbox system. Its isolation descriptor is an operator assertion. This plan must not use that descriptor as proof of container, microVM, filesystem, network, tenancy, or hostile-code isolation.

## Goals

- Give each durable agent an optional computer-like environment that can stop, start, move, and recover without changing agent identity.
- Let dormant agents consume no active compute merely because their identity, files, contracts, or relationships persist.
- Start an authorized target quickly when a call, message, schedule, heartbeat, or owned task requires execution.
- Let an environment install approved software, retain declared files, supervise processes, and use bounded network capabilities.
- Let an agent publish immutable-versioned private procedure contracts.
- Give every runnable agent a standard request/response procedure backed by its autonomous agent loop.
- Let authorized agents discover callable procedures and their exact schemas without waking the target environment.
- Let generated TypeScript invoke a peer through one stable, runtime-validated SDK surface.
- Preserve exact contract, implementation, grant, caller, callee, routing, usage, and outcome provenance for every invocation.
- Keep procedure discovery separate from authorization.
- Preserve explicit uncertainty after ambiguous network or remote execution failures.
- Support local process, local container, local microVM, and remote sandbox placements without changing durable domain semantics.
- Support supervised private HTTP services and, through a separate explicit authority boundary, workspace or public ingress.
- Allow environment-owned application services such as PostgreSQL without confusing their state with canonical Agencity state.
- Keep service documentation centrally available, bounded, authority-filtered, version-pinned, and attributable in model context.
- Preserve local-first operation through truthful weaker placement tiers.

## Non-goals

- Making a container, VM, process, endpoint, or filesystem path the agent's durable identity.
- Claiming hostile-code isolation from a child process or ordinary local container without a specified and verified boundary.
- Treating TypeScript declarations or model-facing documentation as authorization.
- Letting an agent grant itself credentials, network reach, public ingress, compute, storage, budget, or procedure authority.
- Allowing service code to write canonical tables or append arbitrary canonical events.
- Automatically retrying an invocation whose non-idempotent effect may have executed.
- Treating endpoint reachability as proof of contract compatibility or authority.
- Silently moving failed remote execution to a local placement.
- Automatically exposing every bound port to peers or the public internet.
- Requiring a running environment to inspect a service contract.
- Preserving arbitrary process memory, sockets, database connections, or JavaScript objects through shutdown.
- Making every shell script, skill, or temporary process a published service.
- Replacing durable family mailboxes with best-effort network messages.
- Making literal tRPC implementation objects part of retained history.
- Shipping distributed multi-tenant hosting as the first implementation slice.

## Terms

### Agent

A durable actor represented by a session, branch history, profile, model configuration, budgets, relationships, tasks, and mailboxes. The agent may own an environment, but it is not identical to that environment.

### Agent environment

A durable declaration and lifecycle record for computer-like resources assigned to an agent. It identifies image, setup revision, volumes, resource bounds, network policy, service deployments, placement requirements, and desired state.

### Environment generation

An immutable deployment revision of one agent environment. Changes to the base image, installed dependencies, lifecycle hooks, service implementations, mounts, or security policy create a new generation.

### Environment instance

One disposable realization of an environment generation on a placement. It has operational identifiers, a lease epoch, observed state, health, and endpoint bindings. It is never durable agent identity.

### Agent service

A named interface owned by an agent. It consists of immutable service versions, procedure contracts, implementation references, deployment policy, and authority requirements.

### Procedure contract

An immutable description of one callable operation: name, purpose, input and output schemas, bounds, effect class, idempotency rules, cancellation behavior, status-query support, required grants, and compatibility metadata.

### Service description

The bounded, authority-filtered catalog snapshot returned for a target agent. It contains only procedures visible to the caller and pins their exact versions and digests.

### Service alias

A stable logical name that resolves to one active immutable service version at an admission boundary. In-flight calls retain the version they began with.

### Workload identity

A cryptographically verifiable identity for one admitted environment instance or trusted gateway acting for a durable agent. It is distinct from a human account, device ID, bearer credential, and network location.

### Grant

An owner-authorized capability allowing a principal to discover or invoke bounded procedures for a defined audience, scope, expiry, budget, and delegation policy.

### Placement

The implementation that provisions and runs an environment. Placement affects available capabilities and guarantees but does not redefine agent, service, or invocation semantics.

### Durable volume

An environment-owned storage resource with explicit identity, attachment, snapshot, backup, retention, and deletion semantics. A volume is not canonical event history and is not automatically included in artifact export or synchronization.

## Constitutional invariants

### Durable state owns identity

Agent and environment meaning cannot depend on a live process, endpoint, scheduler, container, microVM, mount, or language object. Every required recovery identity must be canonical JSON or an immutable referenced artifact.

### Placement does not redefine semantics

Local process, container, microVM, and remote implementations share the same environment, service, invocation, outcome, and authority model. Missing guarantees are explicit capabilities. No placement silently emulates a stronger boundary.

### Calls use the outbox

An admitted RPC invocation commits its exact intent before request bytes cross a process or network boundary. The record pins caller, callee, service, procedure, contract digest, grant, input digest, effect class, idempotency key, timeout, and routing epoch.

### Uncertainty remains visible

Schema rejection before dispatch is a deterministic failure and can be corrected safely. Transport loss after dispatch may be `unknown`. Cancellation is best effort after dispatch. An idempotency key is useful only when the callee contract and implementation actually enforce it.

### Discovery is not authority

Knowing an agent ID, alias, procedure name, schema, endpoint, or documentation does not grant invocation authority. `describe` returns only the caller's authorized view.

### Runtime validation is authoritative

The caller validates against the pinned contract before dispatch. The callee validates again before implementation execution and validates output before returning success. Type declarations and documentation are advisory.

### Authority is owner-bounded

Agent-authored code cannot widen resource, credential, network, ingress, publication, service, budget, or delegation authority. An agent may propose changes within standing policy; activation follows an owner-controlled path.

### External state stays classified

Files, volumes, databases, queues, and hosted applications are durable only according to their declared service. They do not become canonical agent memory or completion evidence unless referenced through attributable records or artifacts.

### Branches do not replay external systems

Historical projection and branch creation never replay RPC calls, lifecycle hooks, deployments, package installation, or external effects. Stateful environment sharing and cloning require explicit policies.

## Target architecture

```text
Console cell
  -> sdk.agents.describe / sdk.agents.rpc
  -> caller supervisor
  -> contract and grant admission
  -> canonical invocation + outbox effect
  -> authenticated wake/router control plane
  -> target environment placement
  -> target service gateway
  -> procedure implementation or autonomous agent run
  -> validated bounded result or artifact
  -> durable caller and callee outcome records
```

The architecture separates six planes:

1. **Canonical plane:** agent, environment, service, deployment, grant, invocation, and outcome records.
2. **Catalog plane:** immutable contracts, aliases, descriptions, implementation references, and model-facing documentation snapshots.
3. **Control plane:** placement selection, leases, provisioning, wake, drain, stop, health, routing, and revocation.
4. **Data plane:** authenticated procedure requests, responses, streams, artifacts, and private service traffic.
5. **Storage plane:** canonical relational state, artifacts, environment volumes, snapshots, and separately managed application stores.
6. **Ingress plane:** explicit workspace-private or public HTTP exposure, domains, TLS, authentication, rate limits, and abuse controls.

The initial implementation should broker calls through the runtime rather than give generated cells raw peer endpoints. Logical peer-to-peer communication may use a gateway or service mesh physically. This keeps authorization, wake, version admission, attribution, and uncertainty handling outside disposable model code.

### Runtime ownership

The workspace control plane remains the canonical execution owner. An agent environment may run the disposable Bun console worker and agent-owned services, but it does not receive raw canonical database credentials, provider credentials, or authority to append arbitrary events.

The accepted runtime split should be:

- the workspace supervisor owns agent-run admission, provider dispatch, budgets, outbox state, canonical commands, and terminal decisions;
- one execution lease identifies the exact session, branch, run, environment generation, instance epoch, and worker;
- the environment receives a short-lived broker channel scoped to that lease;
- Bun cells call the ordinary SDK through the broker;
- the supervisor validates and commits every canonical mutation and external effect;
- stale workers and instances fail fencing checks after lease replacement;
- provider keys and other owner credentials remain supervisor-side unless a narrower opaque credential binding is explicitly granted to a service.

Phase 0 must decide whether any supervisor component can move into the environment. That decision cannot weaken canonical write validation, branch ownership, provider-secret isolation, execution fencing, or recovery. Moving the console worker is placement; moving canonical authority is a separate security and storage decision.

## Proposed Console SDK

### Discover procedures

```ts
const description = await sdk.agents.describe(target);
```

The result should be bounded JSON:

```ts
{
  target: {
    sessionId: "session-...",
    name: "code-reviewer",
  },
  catalogVersion: "catalog-version-...",
  catalogDigest: "sha256:...",
  procedures: [
    {
      name: "reviewPatch",
      description: "Review a patch against the supplied priorities.",
      contractVersion: "procedure-version-...",
      contractDigest: "sha256:...",
      inputSchema: { /* bounded JSON Schema */ },
      outputSchema: { /* bounded JSON Schema */ },
      mutationClass: "read-only",
      idempotency: "enforced",
      statusQuery: "unavailable",
      timeoutMs: 120000,
      maxInputBytes: 131072,
      maxOutputBytes: 65536,
    },
  ],
}
```

`describe` reads the authorized central catalog and should not wake the target. A live environment must prove that its deployed contract digest matches the admitted catalog before receiving a call.

### Invoke a procedure

```ts
const description = await sdk.agents.describe(target);
const reviewPatch = description.procedures.find(
  (procedure) => procedure.name === "reviewPatch",
);
if (!reviewPatch) throw new Error("reviewPatch is unavailable");

const outcome = await sdk.agents.rpc(
  target,
  "reviewPatch",
  {
    patch,
    priorities: ["correctness", "security"],
  },
  {
    expectedContractDigest: reviewPatch.contractDigest,
    idempotencyKey: "review-current-patch-v1",
    timeoutMs: 120_000,
  },
);
```

The model-facing outcome should preserve the existing explicit terminal vocabulary:

```ts
type AgentRpcOutcome =
  | { outcome: "succeeded"; value: JsonValue; provenance: JsonValue }
  | { outcome: "failed"; error: AgentRpcError; provenance: JsonValue }
  | { outcome: "cancelled"; error?: AgentRpcError; provenance: JsonValue }
  | { outcome: "unknown"; error: AgentRpcError; provenance: JsonValue };
```

Pre-dispatch contract errors should be structured:

```ts
{
  code: "INVALID_INPUT",
  procedure: "reviewPatch",
  contractDigest: "sha256:...",
  issues: [
    {
      path: ["priorities"],
      message: "Expected an array of strings",
    },
  ],
}
```

This feedback is safe to correct because the runtime proves that dispatch did not begin. A post-dispatch `unknown` outcome must not be presented as another correctable type error.

Every call must pin the exact discovered contract. The console step may receive a catalog snapshot before execution, or `describe` may return one during the cell. In either case, `rpc` must require the expected contract version or digest unless it can prove that it is resolving from the exact catalog snapshot already pinned to that cell. It must never resolve an unpinned alias against a newer catalog at dispatch time.

### Addressing

The SDK should accept stable IDs and authorized logical aliases. Exact IDs remain the durable addressing form. Human-readable names can be ambiguous and must fail rather than select incidental catalog order.

Existing family reachability is not RPC authority. The initial callable scope should use explicit grants and may begin with a narrow parent-to-direct-child request and child-to-parent terminal response policy. Sibling, cross-family, workspace-wide, cross-workspace, and organization-wide discovery require separate later grants and routing policy.

### Convenience handles

`sdk.agents.spawn` may continue returning a plain JSON handle. A future hydrated handle may offer convenience methods:

```ts
const child = await sdk.agents.spawn({ task: "Review the patch" });
await child.rpc("reviewPatch", { patch });
```

Such methods must be non-authoritative wrappers over stable IDs. Serialization drops methods and retains JSON identity. Later cells rehydrate through `sdk.agents`; correctness never depends on JavaScript object identity.

## Standard agent service

Every runnable agent service version should include one reserved procedure:

```text
agent.respond
```

Its input includes a bounded message, optional task reference, optional artifact references, requested response schema or response mode where admitted, and invocation bounds. Its output includes the agent's terminal response, status, referenced artifacts, usage, and provenance.

`agent.respond` is backed by the durable agent lifecycle:

1. admit the caller, exact contract, grant, budget, and request;
2. durably deliver the request to the target;
3. wake or start the target environment if required;
4. admit one ordinary autonomous run or retained follow-up run;
5. execute through `bun_console` and `finish`;
6. validate terminal status and result;
7. return or later deliver the exact outcome to the caller.

The existing mailbox remains the durable actor-to-actor communication substrate. The standard RPC procedure is a request/response facade over retained delivery and run semantics, not a second best-effort message system.

An asynchronous option should return a durable invocation handle immediately. A waiting option may block only within an explicit timeout and must remain recoverable by handle after caller-cell loss.

### Invocation authority and accounting

Admission must define:

- caller and target session and branch;
- allowed call direction and exact grant;
- target task or follow-up identity;
- who pays model, compute, storage, network, and service usage;
- caller and callee budget reservations;
- target concurrency and queue bounds;
- cancellation authority;
- artifact visibility;
- terminal response delivery and acknowledgement;
- behavior when either branch is archived, cancelled, deleted, or no longer execution-owned.

The default `agent.respond` procedure cannot consume another agent's budget merely because the caller can send a family message. Spawn-time policy may create a narrow parent-funded or child-funded grant, but its payer, bounds, expiry, and revocation must be explicit durable meaning.

## Custom service contracts

An agent service version should contain:

- stable service and procedure names;
- immutable contract and documentation digests;
- bounded input and output schemas;
- implementation identity and digest;
- protocol and compatibility version;
- mutation class such as `read-only` or `state-changing`;
- idempotency semantics and deduplication scope;
- retry policy derived from the implementation guarantee rather than the procedure name;
- status-query capability and reconciliation contract;
- cancellation support and post-cancellation uncertainty;
- timeout semantics;
- input, output, artifact, stream, turn, cost, and wall-time bounds;
- required grants and resource capabilities;
- filesystem, network, credential, volume, and process requirements;
- deployment and health declarations;
- tests and conformance evidence;
- author, owner approval, activation, retirement, and rollback provenance.

Contracts are immutable. A service alias can advance to another version only at a committed boundary. Calls, model context, logs, resources, and results retain the exact admitted version.

Mutation class, idempotency, status lookup, cancellation, and retry safety are independent properties. A state-changing operation may be idempotent and status-queryable; a read-only operation may still be expensive or externally observable. The contract must not collapse these properties into one enum.

### tRPC relationship

tRPC is a candidate TypeScript authoring and client-generation layer. It does not by itself define the durable domain boundary.

The accepted design must answer:

- whether the network wire is literal tRPC HTTP or an Agencity RPC envelope with a tRPC adapter;
- how input and output schemas become bounded canonical JSON;
- how contract digests remain stable across package builds;
- how non-TypeScript placements can implement the same contract;
- how procedure metadata declares side effects, idempotency, status lookup, authority, and bounds;
- how live routers prove agreement with the centrally activated manifest.

The domain contract should remain independent of a specific tRPC release or live router object.

## Contract publication and documentation

Service documentation is managed centrally as immutable catalog data. It is not scraped from a running container on every call.

Publication flow:

1. Author a service contract and implementation revision.
2. Validate names, schemas, bounds, effect semantics, authority requests, and known-secret exclusion.
3. Build and test the implementation in an admitted environment.
4. Record exact image, artifact, package, and test digests.
5. Obtain required owner approval for executable code, authority, ingress, credentials, and resource changes.
6. Activate an immutable service version and logical alias.
7. Deploy it to an environment generation.
8. Expose the authorized bounded description at the next caller model-step boundary.

The runtime should generate all of these views from one contract:

- supervisor admission and validation rules;
- target service validation;
- bounded `sdk.agents.describe` output;
- model-facing usage guidance and examples;
- optional TypeScript declarations for human SDK consumers;
- protocol reference material;
- conformance fixtures.

Documentation visible to one agent must be filtered by discovery authority and bounded by context policy. Hidden procedures must not be inferred from unfiltered global catalogs.

## Environment model

An environment declaration should include:

- owning agent session;
- environment and generation IDs;
- base image digest and platform;
- setup or build revision;
- implementation artifacts and package locks;
- CPU, memory, disk, process, and wall-time bounds;
- durable and ephemeral mount declarations;
- secret references, never raw secret values;
- network egress and peer-ingress policy;
- declared services, ports, protocols, and health checks;
- startup, readiness, drain, snapshot, and shutdown hooks;
- placement capability requirements;
- idle and wake policy;
- desired state and deletion policy.

An agent may install software only within granted policy. Persistent installation should produce a reproducible environment generation or an explicitly classified mutable volume change. A package manager cache or modified running filesystem must not become the only copy of required recovery state.

Lifecycle hooks are pinned executable artifacts with explicit bounds and effect semantics. Hook results and complete logs spill to artifacts when necessary. Failed or unknown setup cannot be represented as a ready environment.

## Environment lifecycle

Desired state is canonical:

```text
idle | running | terminated
```

Observed state is operational and may lag:

```text
unallocated
provisioning
starting
ready
draining
stopped
failed
lost
unknown
deleting
deleted
```

Typical wake flow:

```text
authorized call accepted
  -> durable invocation queued
  -> placement capability selected
  -> distributed lease acquired
  -> environment generation provisioned or resumed
  -> workload identity issued
  -> services started
  -> readiness and contract-digest handshake passes
  -> queued call dispatched
```

Typical idle flow:

```text
no active runs
  + no effects
  + no queued calls
  + no open resources
  + no schedule or heartbeat requiring residency
  + no declared service keepalive
  -> drain
  -> snapshot or flush declared state
  -> stop instance
  -> retain agent, environment, catalog, volume, and routing identity
```

Scale-to-zero is a policy, not a guarantee for every service. A database, long-lived stream, public website, resident queue consumer, or open resource may require active capacity or a separately managed service.

## Local and remote placement tiers

Every tier publishes truthful capabilities:

1. **In-process development placement**
   - useful for deterministic contract tests;
   - no process or hostile-code isolation;
   - no production security claim.

2. **Managed child-process placement**
   - separate lifecycle and protocol boundary;
   - ambient authority inherited from the service owner unless externally constrained;
   - no hostile-code isolation claim.

3. **Managed local container placement**
   - image, filesystem, namespace, network, and resource policies where supported;
   - isolation guarantees depend on the actual runtime and verified configuration.

4. **Managed local microVM placement**
   - stronger kernel and workload boundary;
   - explicit image, volume, network, attestation, and host requirements.

5. **Managed remote sandbox placement**
   - remote provisioning, workload identity, distributed leases, private routing, artifact transfer, policy enforcement, health, metering, and attestation;
   - no implicit fallback to a weaker local tier.

The same service contract can target multiple placements only when each placement satisfies its exact requirements. Endpoint, container, and host identities remain operational routing data.

## Networking and routing

Agent environments should default to deny:

- no public ingress;
- no undeclared peer ingress;
- bounded owner-approved egress;
- no direct canonical database credentials;
- no ambient access to other agents' volumes or secrets.

Private service addressing uses stable logical identities rather than retained URLs:

```text
workspace / agent / service / alias
```

The router resolves this identity to the current authorized deployment and routing epoch. Calls pin the resolved contract before dispatch. Stale endpoint or digest evidence fails closed.

The long-term data plane may use a gateway, service mesh, direct authenticated HTTP, or a combination. The caller-facing semantics do not expose topology. Every accepted request carries authenticated caller identity, audience, grant, invocation ID, contract digest, deadline, and idempotency key where required.

Cross-workspace addressing requires a control plane that does not exist in the current product. A future design must define:

- a target-owned authoritative catalog and service namespace;
- trust roots and bilateral authorization between workspace owners;
- caller and target durable request and result receipts;
- reconciliation without a distributed atomic commit across workspace databases;
- routing and revocation behavior while either workspace is offline;
- export, deletion, audit, and billing ownership.

Turso envelope synchronization is not service discovery, request routing, distributed locking, or cross-workspace transaction coordination.

## Authentication and authorization

A later security ADR must define these principals:

- human owner;
- workspace;
- durable agent session;
- environment instance;
- service deployment;
- peer caller;
- control-plane operator;
- public or external caller.

The design should combine workload identity with narrowly scoped capability grants. Candidate mechanisms include mTLS workload identity, signed short-lived capability tokens, or both. The mechanism remains an open decision; required semantics do not:

- unforgeable caller and callee identity;
- audience binding;
- procedure and contract binding;
- scope and budget bounds;
- expiry and revocation;
- non-delegable default;
- explicit delegation depth where allowed;
- replay resistance;
- secret rotation;
- complete authorization audit records;
- denial before implementation execution.

An agent can propose a service or access relationship. It cannot approve its own wider authority. Discovering a procedure never creates a grant.

## Files, volumes, databases, and hosted applications

An agent environment may own:

- ephemeral filesystem state;
- one or more durable volumes;
- immutable artifacts;
- external object stores;
- separately managed databases;
- declared background services;
- private or public web applications.

Each category requires explicit lifecycle and data-control semantics.

For durable volumes, the platform must define:

- owner and sharing scope;
- attach and fence rules;
- single-writer or multi-writer semantics;
- snapshots and restore;
- backup coverage;
- replication and placement migration;
- encryption and key ownership;
- quota and billing;
- deletion, retention, and orphan handling;
- behavior after agent branch, archive, export, or deletion.

Running PostgreSQL inside an environment is possible only when its volume, process supervision, backup, recovery, network, and upgrade contracts are declared. A separately managed database may provide better idle, durability, and operational guarantees. Neither option becomes Agencity's canonical event store automatically.

Public websites and APIs require a separate ingress capability:

- explicit owner approval;
- stable domain and TLS handling;
- public authentication or deliberate anonymous access;
- rate limiting, abuse protection, and spend bounds;
- deployment health and rollback;
- observability and incident controls;
- data retention and deletion policy.

Binding a port inside a sandbox does not publish it.

## Recovery and failure semantics

Environment and service operations use explicit terminal states:

- provisioning request not dispatched: safely retryable;
- dispatched provisioning with lost response: `unknown` until provider status lookup or reconciliation;
- startup failure before readiness: `failed`;
- contract or identity handshake mismatch: `failed` and unavailable for calls;
- request rejected before dispatch: deterministic typed failure;
- procedure dispatched with lost response: `unknown` unless status-query semantics resolve it;
- malformed or schema-invalid output after a state-changing dispatch: `unknown` unless status-query evidence proves the terminal result;
- cancellation before dispatch: `cancelled`;
- cancellation after dispatch: best effort and potentially `unknown`;
- instance lost with reconnectable volume and status-queryable calls: recover according to pinned contracts;
- instance lost with only local mutable state: dependency loss remains explicit.

Recovery preserves stable logical admission and never automatically redispatches an uncertain non-idempotent effect. It may recreate a lost instance only after placement status, lease fencing, or provider reconciliation proves that doing so cannot produce a second active owner. Stale or duplicate physical instances are fenced and enter explicit orphan-cleanup state. Agent runs and terminal deliveries retain stable identities and idempotent canonical commits, but the platform does not claim exactly-once execution of arbitrary remote procedures or provisioning operations.

Distributed placement requires lease epochs, write fencing, provider-side idempotency where declared, status lookup, and explicit orphan cleanup that extend beyond current same-device process fencing.

## Branching and stateful environments

Session branches and mutable environments create a major design decision. A historical branch cannot safely pretend that shared external state returned to an earlier point.

The accepted design must choose and document:

- whether one environment is session-wide or branch-owned;
- whether a fork shares the source environment by default;
- whether writable volumes can be cloned or snapshotted for a fork;
- how external services and public endpoints behave across branches;
- whether concurrent branches can write one environment;
- how service aliases and deployment activation cross branch boundaries;
- what evidence is retained when exact state cloning is unavailable.

The conservative default is:

- agent identity remains session-wide;
- canonical branch projection never rewinds an environment;
- a branch receives no writable environment clone implicitly;
- explicit clone or new-environment operations report capability and snapshot limits;
- shared external state is labeled as shared and non-replayable.

## Relationship to connectors

The dynamic connectors plan and this plan share:

- immutable versioned schemas;
- stable generic SDK roots;
- outbox-backed calls;
- runtime validation;
- process and remote placements;
- durable resource identities;
- exact contract snapshots;
- owner-bounded activation.

They serve different ownership models:

- a **connector** adapts Agencity to an external capability;
- an **agent service** is published and owned by a durable agent;
- an **environment** hosts the agent and may host connector implementations, agent services, or ordinary applications.

Both plans should depend on one **service contract and invocation substrate**. That substrate owns canonical schema normalization and digests, immutable operation snapshots, validation, bounded documentation, invocation envelopes, effect-property declarations, result validation, and durable resource-handle rules.

Connector and agent-service catalogs remain separate publisher and authority domains over that substrate. Connector runtime ownership and agent environment ownership do not collapse into one registry. Phase 0 must either amend the connector plan to name this shared substrate or accept a separate ADR before either plan creates overlapping contract, invocation, resource, or process-manager implementations.

## Relationship to subagents and recursive model calls

`sdk.agents.spawn` creates a retained autonomous child with tasks, messages, budgets, and a full `bun_console`/`finish` loop. The proposed standard `agent.respond` procedure addresses that actor through a request/response contract.

Recursive-model calls remain bounded model operations. Structured recursive results and cell-local temporary tools do not require a durable agent service or resident environment.

This separation should remain visible:

- use recursive model calls for bounded typed model computation;
- use subagents for retained autonomous delegated work;
- use agent RPC for published, versioned procedures owned by a durable agent;
- use connectors for typed external capabilities not owned by the target agent.

## Delivery strategy

### Phase 0: architecture and trust decisions

- Accept an ADR separating agent identity, environment identity, instance placement, and service deployment.
- Accept a security ADR for workload identity, grants, revocation, tenancy, network policy, and attestation claims.
- Decide literal tRPC transport versus an Agencity envelope with tRPC adapters.
- Decide branch and mutable-environment semantics.
- Decide runtime ownership: supervisor placement, console placement, branch-scoped execution leases, brokered SDK access, provider credentials, and canonical write authority.
- Define the shared service contract and invocation substrate with the connector plan.
- Define request direction, target branch, task ownership, budget payer, reservation, concurrency, cancellation, and terminal delivery for `agent.respond`.
- Define environment, service, deployment, grant, and invocation capability descriptors.
- Define artifact transfer and distributed lease prerequisites.

Exit condition: security and recovery semantics are specific enough that an implementation cannot silently substitute process separation for sandboxing.

### Phase 1: local dynamic agent-service contracts

- Add immutable service and procedure contracts to workspace canonical state.
- Evolve the current event-schema-version-5 and reducer-version-15 domain deliberately through an accepted pre-release cutover or an explicit compatibility design; do not reinterpret retained events.
- Add event validation, reducers, duplicate and idempotency rules, rebuild coverage, migrations or reset guidance, stream ownership, sync/export behavior, and mutable-table classification.
- Add filtered central catalog snapshots.
- Add `sdk.agents.describe`.
- Add `sdk.agents.rpc` through a managed local in-process or child-process test placement.
- Implement the standard `agent.respond` procedure over durable mailboxes and agent runs.
- Add runtime input/output validation, version pins, bounds, and structured errors.
- Add explicit narrow parent/child grants, target-branch rules, budget accounting, concurrency, cancellation, and terminal delivery; family reach alone grants nothing.
- Implement the shared service contract and invocation substrate instead of a second connector-shaped catalog and envelope.
- Add no container, remote placement, public ingress, or hostile-code isolation claim.

Exit condition: local agents can publish, discover, and call versioned procedures with exact durable outcomes and recovery.

### Phase 2: managed local agent environments

- Add durable environment declarations and generations.
- Add image/setup revisions, lifecycle hooks, service supervision, ports, health, and idle policy.
- Implement child-process placement first and container or microVM placement only with truthful capability distinctions.
- Add local volume identities, snapshots where supported, quotas, and guarded deletion.
- Require owned-scope reference checks, quiescence, partial-failure retry, orphan records, and exact deletion receipts before environment or volume creation is considered complete.
- Make service deployment and environment wake recoverable.

Exit condition: an agent environment can stop and restart locally without losing agent identity, contract identity, or declared durable state.

### Phase 3: single-owner remote sandbox placement

- Add a hosted or operator-managed environment control protocol.
- Add canonical artifact upload/download and remote result transfer.
- Add remote provisioning, workload identity, distributed leases, fencing, health, logs, metrics, and metering.
- Add private authenticated RPC routing and scale-to-zero wake.
- Require provider status lookup, orphan cleanup, remote volume and snapshot deletion, partial-failure retry, and provider-confirmed administrative receipts.
- Keep one owner/tenant boundary and no public ingress.

Exit condition: a remote environment can wake, serve a pinned private procedure, stop, move, and recover without hidden fallback or ambiguous identity.

### Phase 4: authorized peer service network

- Add peer discovery grants beyond the current family boundary.
- Add delegated procedure authority, revocation, audience binding, and policy-filtered documentation.
- Add stable private aliases and status-query reconciliation.
- Specify target-owned catalogs, trust roots, bilateral durable receipts, offline behavior, and non-atomic reconciliation before enabling cross-workspace calls.
- Add service version coexistence and draining across distributed placements.

Exit condition: authorized peers can discover and invoke each other while unauthorized peers cannot infer or call hidden procedures.

### Phase 5: hosted applications and public ingress

- Add explicit private-workspace and public ingress products.
- Add domains, TLS, authentication, rate limits, abuse controls, observability, rollbacks, quotas, and billing.
- Add supported managed database and durable volume patterns.
- Add application backup, export, restore, deletion, and incident procedures.

Exit condition: an agent can operate an explicitly authorized hosted application without weakening agent-runtime security or data lifecycle guarantees.

## Verification requirements

Each phase requires the narrowest applicable conformance suite plus black-box product evidence.

Service contract tests:

- deterministic contract digests;
- input and output schema validation;
- bounded descriptions and authority filtering;
- immutable activation and exact version pins;
- ambiguous alias rejection;
- stale deployment and live-digest mismatch;
- declaration generation parity where provided.

Invocation tests:

- failure before dispatch versus unknown after dispatch;
- true idempotent deduplication;
- non-idempotent no-retry behavior;
- status-query reconciliation;
- cancellation before and after dispatch;
- caller and callee restart at every durable boundary;
- result size spill and artifact integrity;
- budget, timeout, and rate enforcement;
- exact caller, callee, contract, grant, and outcome provenance.

Environment tests:

- provisioning, wake, readiness, drain, stop, restart, loss, and deletion;
- service crash without agent identity loss;
- setup and shutdown hook failure;
- volume attach fencing, snapshot, restore, migration, and orphan handling;
- resource and network policy enforcement;
- scale-to-zero eligibility;
- lease expiry, stale owner rejection, and split-brain prevention;
- placement capability mismatch and no fallback.

Security tests:

- forged identity;
- expired, revoked, wrong-audience, wrong-procedure, and over-budget grants;
- hidden procedure enumeration;
- replayed request;
- cross-agent volume and secret access;
- unapproved egress and ingress;
- endpoint substitution and contract downgrade;
- sandbox-policy and attestation verification where claimed;
- known-secret exclusion from events, descriptions, errors, logs, and artifacts.

Installed-product acceptance should eventually demonstrate:

1. create or select two durable agents;
2. publish and activate one bounded private procedure;
3. discover it from an authorized peer;
4. reject discovery and invocation from an unauthorized peer;
5. call it through `sdk.agents.rpc`;
6. stop the target environment;
7. wake it through another call;
8. lose caller, target, router, and client processes at durable boundaries;
9. preserve stable logical identities, fence stale instances, avoid redispatch of uncertain work, and never invent success;
10. inspect exact service, grant, environment, invocation, and artifact provenance.

## Documentation plan

No public document should describe these capabilities as implemented until its corresponding phase ships.

Architecture acceptance requires updates to:

- `AGENTS.md` for accepted product direction, invariants, current status, and limitations;
- `docs/architecture.md` for agent, environment, service, control-plane, data-plane, and storage-plane boundaries;
- `docs/security.md` for sandbox guarantees, principals, workload identity, grants, network policy, ingress, secrets, and attestation;
- `docs/placement.md` for local process, container, microVM, and remote environment capability contracts;
- `docs/console-sdk.md` for `sdk.agents.describe`, `sdk.agents.rpc`, result envelopes, examples, and recovery guidance;
- `docs/protocol.md` and API references for service catalogs, invocations, environments, grants, and lifecycle operations;
- `docs/events.md` for every canonical lifecycle and invocation event;
- `docs/mutable-tables.md` for operational routing, lease, health, and cache tables;
- `docs/recovery.md` for environment, call, lease, volume, and unknown-outcome recovery;
- `docs/data-lifecycle.md` for volume, snapshot, database, artifact, export, backup, restore, and deletion boundaries;
- `docs/configuration.md` for placement, image, resource, network, idle, and ingress settings;
- `docs/operator-guide.md` for provisioning, draining, incident response, capacity, routing, and credential rotation;
- `docs/capabilities.md` and `docs/verification.md` for exact supported tiers and reproduced evidence;
- `docs/user-guide.md` for human-readable service publication, access, inspection, and hosted-application flows;
- `README.md` only when an installed user journey is reproducible;
- new ADRs and `docs/decisions/README.md` for accepted identity, security, branch-state, and transport decisions.

Model-facing documentation should include concise patterns for:

- discovering procedures before calling;
- reading exact schemas and effect classifications;
- correcting deterministic validation errors;
- preserving idempotency keys;
- handling `unknown` without retry;
- selecting recursive calls, subagents, agent RPC, or connectors;
- treating service documentation as capability guidance rather than authority.

## Open decisions

1. Is the remote wire literal tRPC HTTP, a versioned Agencity HTTP/JSON envelope, or an envelope with generated tRPC adapters?
2. Does one session own one environment, one environment per active branch, or multiple named deployments?
3. How are writable environments and volumes handled when a branch forks?
4. Which service and environment records are canonical events versus rebuildable projections or operational control state?
5. What is the minimum local isolation tier accepted for executable agent-authored services?
6. Which remote sandbox provider or provider-neutral provisioning protocol is the first target?
7. What artifact-transfer contract is required before remote services can return large results or snapshots?
8. Which distributed lease and fencing mechanism owns one active environment generation?
9. How are workload identities issued, rotated, revoked, and bound to durable agents?
10. Are peer grants limited to one workspace initially?
11. Can agents delegate grants, and if so, under what depth and scope limits?
12. Which procedure effect classes are accepted, and which require status-query support?
13. How does `agent.respond` express structured output without conflating autonomous subagents with recursive-model calls?
14. How are long-running, streaming, and bidirectional procedures represented without retaining sockets as identity?
15. Which environment files belong in volumes, images, artifacts, or canonical working values?
16. How are databases backed up, restored, upgraded, and scaled to zero?
17. When may a declared background process keep an environment resident?
18. What owner approval is required for packages, images, credentials, network access, peer publication, and public ingress?
19. How are service aliases named and resolved across workspaces or organizations?
20. Which control-plane records synchronize, and which require one authoritative online owner?
21. What attestation is required before the product may claim a placement is sandboxed?
22. What deletion receipt proves that environment instances, volumes, snapshots, routes, grants, and public endpoints are gone?

## Risks

- Treating the environment as agent identity would make placement migration, shutdown, and recovery unsafe.
- Dynamic procedure documentation could leak hidden capabilities unless catalog views are authorization-filtered.
- Runtime schema errors are correctable, but encouraging retries after ambiguous dispatch could duplicate external effects.
- A general service mechanism could become an authority-escalation path if publication and invocation grants are conflated.
- Mutable volumes weaken branch reproducibility unless sharing and cloning semantics are explicit.
- Arbitrary package installation can make environments unreproducible and introduce supply-chain risk.
- Public ingress changes Agencity from a trusted-local runtime into an internet-facing hosting product with materially different security and operational obligations.
- Scale-to-zero can conflict with databases, streams, scheduled work, public latency targets, and stateful resources.
- Direct peer networking can bypass durable attribution unless routing and invocation admission remain runtime-owned.
- tRPC's TypeScript ergonomics can obscure the need for language-neutral retained schemas, immutable digests, and server-side validation.
- Distributed ownership without fencing can create two active instances serving one agent identity.
- Remote artifact and volume loss can leave canonical events pointing to unavailable required state.

## Completion criteria

This architecture plan is ready to become an implementation plan only when:

1. Agent identity and environment identity are formally separated.
2. Branch semantics for mutable environments are accepted.
3. The RPC transport and durable contract representation are selected.
4. Procedure effect, idempotency, cancellation, and unknown-outcome rules are complete.
5. Workload identity, grants, revocation, tenancy, and network policy have an accepted security design.
6. Environment desired and observed states, leases, wake, drain, stop, loss, and deletion are specified.
7. Image, package, hook, volume, artifact, database, and secret lifecycle boundaries are explicit.
8. Local placement tiers state truthful isolation guarantees.
9. Remote artifact transfer and distributed fencing prerequisites are defined.
10. The standard agent request/response procedure is reconciled with mailboxes, subagents, recursive calls, and structured output.
11. Connector and agent-service primitives are shared only where their ownership and authority semantics agree.
12. Public ingress remains a separate explicit authority and delivery phase.
13. Every phase has black-box acceptance, security, recovery, and conformance requirements.
14. Public documentation can distinguish proposed, implemented, unavailable, and externally verified behavior without ambiguity.

## Explicit deferrals

- Automatic global placement optimization.
- Multi-region active-active agent environments.
- Transparent migration of arbitrary live process memory.
- General distributed transactions across agent services.
- Exactly-once execution of arbitrary remote procedures.
- Automatic public exposure based only on agent request.
- A public service marketplace.
- Cross-organization federation.
- Anonymous peer discovery.
- Unbounded streaming or arbitrary raw socket exposure.
- Automatic conversion of arbitrary running processes into durable services.
- A claim that one universal sandbox technology works equally on every local and remote platform.

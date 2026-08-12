# Agent environments and service interfaces architecture plan

**Status:** Architecture draft; not implementation-ready<br>
**Date:** August 11, 2026  
**Last revised:** August 11, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related planning:** [Dynamic typed connectors and managed RPC resources](./2026-08-09-dynamic-typed-connectors-plan.md), [Durable tenacious goal orchestration](./2026-08-09-tenacious-goal-orchestration-plan.md), [Durable agent profiles and automated refinement review](./2026-08-08-adaptive-agent-city-plan.md), and [Formal model-tool contracts](./2026-08-07-formal-model-tool-contracts-plan.md)  
**Governing decisions:** [Durable local runtime foundations](../docs/decisions/0001-durable-local-runtime-foundations.md), [Durable agent relationships](../docs/decisions/0006-durable-agent-relationships.md), [Managed workspace execution](../docs/decisions/0007-managed-workspace-execution.md), [Formal model-tool contracts](../docs/decisions/0010-formal-model-tool-contracts.md), and [Capability-preserving placement](../docs/decisions/0011-capability-preserving-placement-contracts.md)

## Summary

Agencity should support durable agents that can own addressable compute environments, with placement isolation only where the platform verifies it, and publish versioned service interfaces. An environment can contain files, installed software, supervised processes, private services, durable volumes, and separately managed application data. It can be stopped while its agent identity and declared interfaces remain durable, then started on demand when authorized work arrives.

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

Every explicitly service-capable autonomous agent exposes a platform-owned standard request/response procedure backed by its ordinary autonomous lifecycle. Recursive-model sessions are not service-capable. Agents may also publish domain-specific procedures such as `reviewPatch`, `queryCatalog`, `runSimulation`, or `deployPreview`. The TypeScript console reaches those procedures through a stable generic API:

```ts
const description = await sdk.agents.describe(target);
const reviewer = description.services.find(
  (service) => service.alias === "reviewer",
);
const reviewPatch = reviewer?.procedures.find(
  (procedure) => procedure.name === "reviewPatch",
);
if (!reviewPatch) throw new Error("reviewPatch is unavailable");

const result = await sdk.agents.rpc(
  reviewPatch.callable,
  { patch, priorities: ["correctness", "security"] },
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
- **Service deployments** bind exact contract and implementation versions to an admitted deployment target. Phase 1 uses a managed local placement revision; later environment-backed deployments bind to an environment generation.
- **Callable references** bind a target session and branch, service and procedure version, catalog snapshot, contract digest, and authority view at one admission boundary.
- **Procedure invocations** are durable logical request/response aggregates whose physical dispatch attempts use outbox-backed effects.
- **Application state** belongs to declared volumes, managed services, artifacts, or external systems; it does not silently become canonical Agencity history.

The runtime will expose one stable `sdk.agents` facade rather than injecting a new top-level symbol or generated method set for every reachable peer. Dynamic procedure names and schemas remain discoverable data behind:

```ts
sdk.agents.describe(target, options?)
sdk.agents.rpc(callable, input, options?)
sdk.agents.invocations.start(callable, input, options?)
sdk.agents.invocations.get(invocationId)
sdk.agents.invocations.result(invocationId, options?)
sdk.agents.invocations.cancel(invocationId, reason?)
```

The ordinary provider action surface remains exactly `bun_console` and `finish`. Peer services expand what generated TypeScript can program against; they do not become additional provider tools.

## Current foundation and gap

Agencity currently provides:

- durable root and child sessions, tasks, budgets, cancellation, and family relationships;
- `sdk.agents.spawn`, family inspection, retained queue/steer messaging, acknowledgement, and cancellation;
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
- Start an authorized target quickly when an admitted call, queued family message, schedule, heartbeat, or owned task requires execution.
- Let an environment install approved software, retain declared files, supervise processes, and use bounded network capabilities.
- Let an agent publish immutable-versioned private procedure contracts.
- Give every explicitly service-capable autonomous agent a standard request/response procedure backed by its autonomous agent loop.
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

A durable declaration and lifecycle record for computer-like resources assigned to an agent. It identifies image, setup revision, volumes, resource bounds, network policy, service deployments, placement requirements, and owner intent.

### Environment generation

An immutable deployment revision of one agent environment. Changes to the base image, installed dependencies, lifecycle hooks, service implementations, mounts, or security policy create a new generation.

### Environment instance

One disposable realization of an environment generation on a placement. It has operational identifiers, a lease epoch, observed state, health, and endpoint bindings. It is never durable agent identity.

### Agent service

A named interface owned by an agent. It consists of immutable service versions, procedure contracts, implementation references, deployment policy, and authority requirements.

### Service deployment

One admitted binding of an exact service and implementation version to a deployment target. Phase 1 targets a managed local runtime revision under the shared implementation ABI. Phase 2 and later may target an environment generation. Operational instances and routes may change without changing deployment identity.

### Service allocation

One disposable operational realization of a service deployment. A Phase 1 managed local allocation has a service-allocation ID, process or pool identity, fence epoch, health, and route. An environment-backed allocation additionally identifies its environment instance and lease. Allocation identity never becomes agent, service, deployment, or invocation identity.

### Procedure contract

An immutable description of one callable operation: name, purpose, input and output schemas, bounds, mutation class, idempotency and retry rules, cancellation behavior, status-query support, required grants, and compatibility metadata.

### Service description

The bounded, authority-filtered catalog snapshot returned for a target agent. It contains only procedures visible to the caller and pins their exact versions and digests.

### Service alias

A stable logical name that resolves to one active immutable service version at an admission boundary. In-flight calls retain the version they began with.

### Agent address

An exact `{ sessionId, branchId }` route or an authorized logical alias that resolves unambiguously to that route. Session identity alone is not an executable route when the session has multiple branches. Alias resolution is retained with the catalog snapshot and fails on ambiguity.

### Callable reference

An immutable bounded value returned by service discovery. It identifies the target session and branch, service alias and exact service version, procedure name and version, contract digest, catalog snapshot, implementation compatibility identity, and the authority view under which it was described. It is not itself authority: admission and live revocation checks still apply.

### Procedure invocation

One durable logical request against an exact callable reference. The invocation owns stable caller, callee, input, budget, deadline, idempotency, delivery, terminal outcome, and acknowledgement meaning.

### Invocation dispatch attempt

One physical attempt to route an admitted invocation. It pins the service deployment and allocation, routing epoch, allocation fence, workload identity where available, environment instance and lease where applicable, and attempt deadline. Safe retries retain the logical invocation identity while creating a new attempt; retained invocation intent is never mutated to point at a replacement route.

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

Agent and environment meaning cannot depend on a live process, endpoint, scheduler, container, microVM, mount, or language object. Every required recovery identity must be a canonical event, validated durable record, typed working value, or immutable referenced artifact with documented ownership and rebuild semantics.

### Placement does not redefine semantics

Local process, container, microVM, and remote implementations share the same environment, service, invocation, outcome, and authority model. Missing guarantees are explicit capabilities. No placement silently emulates a stronger boundary.

### Calls use the outbox

An admitted RPC invocation commits its exact logical intent before request bytes cross a process or network boundary. The logical record pins caller and callee routes, service and procedure versions, catalog snapshot, contract and implementation compatibility digests, grant and policy revision, accepted input or immutable input artifacts, mutation class, idempotency and retry semantics, status-query and cancellation capabilities, idempotency key, and absolute deadline.

Each physical dispatch is a separate outbox-backed attempt that pins its route, service deployment and allocation, allocation fence, workload identity where available, environment instance and lease where applicable, and attempt deadline. A route change creates a new attempt only when retry or status-query semantics prove that doing so is safe.

### Uncertainty remains visible

Schema rejection before dispatch is a deterministic failure and can be corrected safely. Transport loss after dispatch may be `unknown`. Cancellation is best effort after dispatch. An idempotency key is useful only when the callee contract and implementation actually enforce it.

### Discovery is not authority

Knowing an agent ID, alias, procedure name, schema, endpoint, or documentation does not grant invocation authority. `describe` returns only the caller's authorized view.

A callable reference records that view for attribution and compatibility. It cannot preserve an expired or revoked grant. Admission, provisioning, dispatch, and callee execution recheck a live monotonic revocation fence.

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
  -> callable, contract, grant, and budget admission
  -> canonical logical invocation
  -> authenticated wake/router control plane
  -> outbox-backed dispatch attempt
  -> target service deployment and fenced allocation
  -> optional environment placement in Phase 2 and later
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

The workspace control plane remains the canonical execution owner. An agent environment may run the disposable Bun console worker and agent-owned services. The platform does not intentionally provision raw canonical database credentials, provider credentials, or authority to append arbitrary events into that environment.

The accepted runtime split should be:

- the workspace supervisor owns agent-run admission, provider dispatch, budgets, outbox state, canonical commands, and terminal decisions;
- existing workspace and root-family execution fences remain authoritative for canonical and outbox writes;
- a managed service-allocation fence identifies and fences one Phase 1 local implementation process or pool;
- an environment-instance lease in Phase 2 and later extends allocation fencing to one environment generation and instance epoch;
- a run-worker lease separately identifies the exact session, branch, run, environment generation, instance epoch, and worker;
- writable volumes use independent storage-level writer leases or backend fencing; canonical-write fencing alone does not prevent stale filesystem writes;
- the Phase 1 supervisor-owned Bun worker remains under existing workspace and root-family execution fences;
- an environment-placed Bun worker in Phase 2 and later receives a short-lived broker channel scoped to its environment-instance and run-worker leases;
- a custom service receives a short-lived invocation channel scoped to its exact deployment, allocation fence, and dispatch attempt without acquiring a fictitious agent-run lease;
- Bun cells call the ordinary SDK through the broker;
- the supervisor validates and commits every canonical mutation and external effect;
- stale workers and instances fail fencing checks after lease replacement;
- provider keys and other owner credentials remain supervisor-side unless a narrower opaque credential binding is explicitly granted to a service.

Phase 0 must decide whether any supervisor component can move into the environment. That decision cannot weaken canonical write validation, branch ownership, provider-secret isolation, execution fencing, or recovery. Moving the console worker is placement; moving canonical authority is a separate security and storage decision.

Child-process and other trusted-local placements share the runtime OS user's ambient authority and may read accessible workspace or profile files. Keeping credentials supervisor-side is not an isolation guarantee in those tiers. Credential and filesystem isolation may be claimed only for a placement that enforces and verifies the required boundary.

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
    branchId: "branch-...",
    name: "code-reviewer",
  },
  catalogSnapshotId: "catalog-snapshot-...",
  catalogDigest: "sha256:...",
  services: [
    {
      alias: "reviewer",
      serviceVersionId: "service-version-...",
      availability: "ready",
      procedures: [
        {
          name: "reviewPatch",
          description: "Review a patch against the supplied priorities.",
          procedureVersionId: "procedure-version-...",
          contractDigest: "sha256:...",
          inputSchema: { /* bounded JSON Schema */ },
          outputSchema: { /* bounded JSON Schema */ },
          mutationClass: "read-only",
          idempotency: "enforced",
          statusQuery: "unavailable",
          timeoutMs: 120000,
          maxInputBytes: 131072,
          maxOutputBytes: 65536,
          callable: {
            targetSessionId: "session-...",
            targetBranchId: "branch-...",
            serviceAlias: "reviewer",
            serviceVersionId: "service-version-...",
            procedureName: "reviewPatch",
            procedureVersionId: "procedure-version-...",
            catalogSnapshotId: "catalog-snapshot-...",
            contractDigest: "sha256:...",
            implementationCompatibilityDigest: "sha256:...",
            authorityViewId: "authority-view-...",
            grantRevisionId: "grant-revision-...",
            revocationGenerationAtDescribe: 7,
          },
        },
      ],
    },
  ],
}
```

`describe` resolves an exact target route, reads its authorized central catalog snapshot, and should not wake the target. It groups procedures by named service so two services may use the same procedure name without ambiguity. A live service placement must prove that its deployed service, implementation compatibility, and contract digests match the admitted callable reference before receiving a call.

Every `AgentRun` action step and direct diagnostic-cell admission receives one immutable service-catalog snapshot. Context materialization, provider retries, cell execution, `describe`, and `rpc` remain bound to that snapshot. Activation can affect only a later step. Revocation is a separate live monotonic fence that may narrow an already admitted snapshot.

### Invoke a procedure

```ts
const description = await sdk.agents.describe(target);
const reviewer = description.services.find(
  (service) => service.alias === "reviewer",
);
const reviewPatch = reviewer?.procedures.find(
  (procedure) => procedure.name === "reviewPatch",
);
if (!reviewPatch) throw new Error("reviewPatch is unavailable");

const outcome = await sdk.agents.rpc(
  reviewPatch.callable,
  {
    patch,
    priorities: ["correctness", "security"],
  },
  {
    idempotencyKey: "review-current-patch-v1",
    timeoutMs: 120_000,
  },
);
```

The model-facing outcome should preserve the existing explicit terminal vocabulary:

```ts
type AgentRpcProvenance = {
  invocationId: string;
  dispatchAttemptIds: string[];
  caller: { sessionId: string; branchId: string };
  callee: { sessionId: string; branchId: string };
  serviceVersionId: string;
  procedureVersionId: string;
  contractDigest: string;
  catalogSnapshotId: string;
  grantRevisionId: string;
  requestDigest: string;
  terminalEventId: string;
};

type AgentRpcOutcome =
  | {
      outcome: "succeeded";
      value: {
        inline: JsonValue | null;
        artifacts: ArtifactReference[];
      };
      provenance: AgentRpcProvenance;
    }
  | { outcome: "failed"; error: AgentRpcError; provenance: AgentRpcProvenance }
  | { outcome: "cancelled"; error?: AgentRpcError; provenance: AgentRpcProvenance }
  | { outcome: "unknown"; error: AgentRpcError; provenance: AgentRpcProvenance };
```

The outer outcome describes invocation execution, transport, and protocol certainty. Procedure-specific output remains inside a successful value. For `agent.respond`, that output preserves the exact autonomous terminal status:

```ts
type AgentRespondResult = {
  status:
    | "succeeded"
    | "blocked"
    | "failed"
    | "cancelled"
    | "budget_exceeded"
    | "unknown";
  message: string | null;
  artifacts: ArtifactReference[];
  usage: JsonValue;
  provenance: JsonValue;
};
```

A successfully delivered `agent.respond` call whose target run ends `blocked` has an outer RPC outcome of `succeeded` and an inner status of `blocked`. Transport failure, target-run failure, and budget exhaustion therefore remain distinct.

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

Every call consumes the exact callable reference returned from its cell's catalog snapshot. The runtime rejects a reference from another caller, branch, step, or authority view. It must never resolve an unpinned alias against a newer catalog at dispatch time. Live checks may narrow authority or availability but may not substitute a newer contract or implementation.

### Addressing

The SDK accepts exact `{ sessionId, branchId }` addresses and authorized logical aliases. Exact routes remain the durable addressing form. Human-readable names can be ambiguous and must fail rather than select incidental catalog order. Alias resolution returns and retains the exact route; a session ID alone cannot select among multiple executable branches.

Existing family reachability is not RPC authority. Phase 1 is limited to one root family, with explicit grants for a narrow parent-to-direct-child request and child-to-parent terminal response policy. Sibling, cross-family, cross-root, workspace-wide, cross-workspace, and organization-wide discovery require separate later grants, receipts, and routing policy.

### Durable invocation handles

Every admitted call receives a plain JSON handle containing its invocation ID, caller and callee routes, callable reference digest, status, and timestamps. Waiting is a convenience over the same handle:

```ts
const handle = await sdk.agents.invocations.start(
  reviewPatch.callable,
  input,
  options,
);
const current = await sdk.agents.invocations.get(handle.invocationId);
const outcome = await sdk.agents.invocations.result(handle.invocationId, {
  wait: true,
  timeoutMs: 120_000,
});
await sdk.agents.invocations.cancel(handle.invocationId, "No longer needed");
```

`sdk.agents.rpc(callable, input, options)` is shorthand for start followed by bounded wait. A wait timeout does not erase or cancel the invocation. The handle remains resolvable after caller-cell, worker, supervisor, or client loss.

The canonical invocation state machine is:

```text
admitted
  -> queued
  -> delivered
  -> execution_admitted
  -> dispatched
  -> terminal_observed
  -> caller_delivered
  -> acknowledged
```

Deterministic pre-dispatch rejection terminates without `dispatched`. Cancellation may terminate before dispatch or become best-effort after dispatch. Every transition pins the exact mailbox message, target run or implementation call, dispatch attempt, terminal record, and caller receipt where applicable. Recovery completes committed prefixes idempotently and never creates a second target run for one invocation.

### Convenience handles

`sdk.agents.spawn` may continue returning a plain JSON handle. A future hydrated handle may offer convenience methods that first resolve the target's exact route and callable reference:

```ts
const child = await sdk.agents.spawn({ task: "Review the patch" });
const description = await child.describe();
const service = description.services.find(
  (candidate) => candidate.alias === "reviewer",
);
const procedure = service?.procedures.find(
  (candidate) => candidate.name === "reviewPatch",
);
if (!procedure) throw new Error("reviewPatch is unavailable");
await child.rpc(procedure.callable, { patch });
```

Such methods must be non-authoritative wrappers over stable IDs. Serialization drops methods and retains JSON identity. Later cells rehydrate through `sdk.agents`; correctness never depends on JavaScript object identity.

## Standard agent service

The platform owns one reserved standard service and procedure:

```text
service: agent
procedure: respond
```

Agent-authored services cannot publish the reserved `agent` namespace. The standard service is versioned and deployed independently of custom services.

Only explicitly service-capable autonomous root and delegated sessions receive this service. Recursive-model sessions remain bounded model operations and are not callable autonomous services. Service eligibility is durable owner-bounded policy fixed at session admission or changed through an explicit governed operation; a session cannot make itself service-capable.

The procedure input includes a bounded message, optional task reference, typed artifact references, requested response schema or response mode where admitted, and invocation bounds. Its output is `AgentRespondResult`, including the exact terminal response, status, referenced artifacts, usage, and provenance.

`agent.respond` is backed by the durable agent lifecycle:

1. admit the caller, exact contract, grant, budget, and request;
2. durably deliver the request to the target;
3. wake or start the target environment if required;
4. admit one ordinary autonomous run or queued-message run;
5. execute through `bun_console` and `finish`;
6. validate terminal status and result;
7. return or later deliver the exact outcome to the caller.

The existing mailbox remains the durable actor-to-actor communication substrate. The standard RPC procedure is a request/response facade over retained delivery and run semantics, not a second best-effort message system.

The asynchronous form returns the durable invocation handle immediately. The waiting form blocks only within an explicit timeout and remains recoverable by handle after caller-cell loss.

Only an explicitly authorized `agent.respond` invocation or `send(..., { mode: "queue" })` can trigger a new autonomous run. `queue` is the default send mode. Explicit `steer` remains durable delivery or active-run steering and does not wake an idle agent merely because the sender can reach it.

### Invocation authority and accounting

Admission must define:

- caller and target session and branch;
- allowed call direction, exact grant revision, authority view, and live revocation generation;
- target task or queued-message identity;
- who pays model, compute, storage, network, and service usage;
- caller and callee budget reservations;
- target concurrency and queue bounds;
- cancellation authority;
- typed artifact custody, visibility, registration, retention, export, and deletion;
- terminal response delivery and acknowledgement;
- behavior when either branch is archived, cancelled, deleted, or no longer execution-owned.

The default `agent.respond` procedure cannot consume another agent's budget merely because the caller can send a family message. Spawn-time policy may create a narrow parent-funded or child-funded grant, but its payer, bounds, expiry, and revocation must be explicit durable meaning.

Grants are immutable revisions with a monotonic live revocation fence. The runtime checks the grant at discovery, invocation admission, before provisioning, immediately before dispatch, and at callee execution. Revocation before dispatch terminates without implementation execution. Revocation after possible dispatch requests cancellation where supported and preserves `unknown` whenever completion cannot be proven.

Overlapping grants never resolve by incidental storage order. Discovery either returns the one deterministic applicable authority view or fails with `AMBIGUOUS_GRANT` and bounded safe grant references. The caller may repeat `describe(target, { grantRevisionId })`. The chosen grant fixes payer, budget, delegation, cancellation, and artifact authority for the invocation.

Phase 1 calls remain inside one root family so caller and callee records can use the current family and fencing model. Cross-root calls require the later bilateral receipt and reconciliation protocol even when both roots share one workspace database.

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

The shared connector/service substrate defines the executable implementation ABI before Phase 1 begins. Agent-authored local implementations use content-addressed bundle manifests, owner-allowlisted runtimes, supervisor-controlled argv, working directory and environment construction, known-secret stripping, bounded framed I/O, startup identity and digest handshakes, test allocations, and service-owned lifecycle management. An implementation process receives no canonical database client, managed-service bearer, provider credential, or unrestricted SDK handle. Phase 1 conformance may use deterministic built-in fixture implementations, but agent-authored executable activation requires the accepted ABI and may not invent a second ad hoc launch protocol.

`idempotency: "enforced"` requires durable callee-side binding of caller, procedure, contract, logical idempotency key, and input digest to one retained result across process loss for a declared retention period. A process-local cache is insufficient. `status-queryable` requires a stable lookup that does not repeat the operation and whose evidence retention meets the declared recovery window. Key reuse with different durable meaning fails closed.

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
3. Build and test the implementation in an admitted deployment test allocation.
4. Record exact image, artifact, package, and test digests.
5. Obtain required owner approval for executable code, authority, ingress, credentials, and resource changes.
6. Publish the immutable service version without making it routable.
7. Admit and deploy it to a compatible target: a managed local placement revision in Phase 1 or an environment generation in later phases.
8. Pass readiness, identity, implementation, and contract-digest handshakes.
9. Compare-and-swap the logical alias to the ready service version.
10. Expose the authorized bounded description at the next caller model-step boundary.

Publication, deployment, readiness, alias activation, routability, draining, and retirement are distinct states. A published or active-but-unready version remains inspectable but unavailable for calls. `describe` reports bounded availability and never represents catalog activation alone as a ready deployment. A ready alias that loses every compatible deployment becomes unavailable without silently advancing to another version.

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
- owner intent and deletion policy.

An agent may install software only within granted policy. Persistent installation should produce a reproducible environment generation or an explicitly classified mutable volume change. A package manager cache or modified running filesystem must not become the only copy of required recovery state.

Lifecycle hooks are pinned executable artifacts with explicit bounds and effect semantics. Hook results and complete logs spill to artifacts when necessary. Failed or unknown setup cannot be represented as a ready environment.

## Environment lifecycle

Owner intent is canonical:

```text
enabled | disabled | terminated
```

`enabled` permits authorized wake and scale-to-zero. `disabled` rejects new work and drains according to policy without erasing data. `terminated` permanently rejects new execution but does not authorize physical deletion of instances, volumes, snapshots, routes, grants, artifacts, or history. Physical deletion remains a separately confirmed, receipted, retryable data-control operation.

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
  -> live grant and deadline revalidated
  -> placement capability selected
  -> placement-appropriate allocation and environment-instance lease acquired
  -> environment generation provisioned or resumed
  -> workload identity issued
  -> services started
  -> readiness and contract-digest handshake passes
  -> grant, deadline, route, and callee identity revalidated
  -> dispatch attempt committed
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
  -> fence new calls and writable resources
  -> snapshot or flush declared state
  -> commit proven flush/snapshot outcome
  -> stop and detach instance
  -> retain agent, environment, catalog, volume, and routing identity
```

Scale-to-zero is a policy, not a guarantee for every service. A database, long-lived stream, public website, resident queue consumer, or open resource may require active capacity or a separately managed service.

A failed or unknown flush never becomes a clean stop. Forced termination after uncertain persistence records explicit `dirty`, `lost`, or `unknown` dependency state and blocks claims that declared durable state is safely recoverable.

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

Placements that advertise verified filesystem and network isolation should enforce a default-deny policy:

- no public ingress;
- no undeclared peer ingress;
- bounded owner-approved egress;
- no direct canonical database credentials;
- no ambient access to other agents' volumes or secrets.

Trusted-local in-process and child-process placements cannot enforce all of these boundaries against same-user code. Their descriptors must report filesystem, secret, and network isolation as unavailable, and product documentation must retain the trusted-local authority warning. The control plane should avoid intentionally routing ingress or provisioning credentials in those tiers, but that behavior is not an operating-system security boundary.

Private service addressing uses stable logical identities rather than retained URLs:

```text
workspace / agent-route / service-alias
```

The agent route resolves to an exact session and branch. The service alias resolves through the caller's catalog snapshot to one exact service and procedure version. The router then resolves that callable reference to a compatible ready deployment and fenced service allocation and records the result on a dispatch attempt. Stale route, endpoint, allocation fence, identity, grant, lease, or digest evidence fails closed.

The long-term data plane may use a gateway, service mesh, direct authenticated HTTP, or a combination. The caller-facing semantics do not expose topology. Every accepted request carries authenticated caller identity, audience, grant revision and revocation generation, invocation and attempt IDs, service and procedure versions, contract digest, deadline, and idempotency key where required.

Cross-workspace addressing requires a control plane that does not exist in the current product. A future design must define:

- a target-owned authoritative catalog and service namespace;
- trust roots and bilateral authorization between workspace owners;
- caller and target durable request and result receipts;
- reconciliation without a distributed atomic commit across workspace databases;
- routing and revocation behavior while either workspace is offline;
- export, deletion, audit, and billing ownership.

Turso envelope synchronization is not service discovery, request routing, distributed locking, or cross-workspace transaction coordination.

## Authentication and authorization

The Phase 0 security ADR must define these principals:

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

Writable attachment requires independent storage-level fencing. A replacement instance cannot attach a volume read-write until the former writer is proven stopped and detached or the storage backend rejects the former writer's lease epoch. Backends that cannot enforce writer fencing advertise that limitation and cannot support automatic takeover after ambiguous instance loss. Read-only sharing, single-writer attachment, snapshot consistency, forced loss, and orphan cleanup are separate declared capabilities.

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
- dispatched provisioning with lost response: `unknown` unless provider status lookup proves the result before the terminal outcome is committed;
- startup failure before readiness: `failed`;
- contract or identity handshake mismatch: `failed` and unavailable for calls;
- request rejected before dispatch: deterministic typed failure;
- procedure dispatched with lost response: `unknown` unless status-query semantics resolve it;
- malformed or schema-invalid output after dispatch: protocol result invalid; the external-effect status is `unknown` whenever execution or externally significant consequences cannot be proven and retry is unsafe;
- cancellation before dispatch: `cancelled`;
- cancellation after dispatch: best effort and potentially `unknown`;
- instance lost with reconnectable volume and status-queryable calls: recover according to pinned contracts;
- instance lost with only local mutable state: dependency loss remains explicit.

Recovery preserves stable logical admission and never automatically redispatches an uncertain non-idempotent effect. The logical invocation retains its callable, grant, input, budget, deadline, and idempotency meaning. Each physical dispatch attempt retains its own route, deployment, service allocation, allocation fence, workload identity, and environment lease where applicable. A replacement route therefore creates a new attempt rather than mutating retained invocation intent.

Recovery may recreate a lost instance only after placement status, lease fencing, volume-writer fencing, or provider reconciliation proves that doing so cannot produce a second active owner. Stale or duplicate physical instances are fenced and enter explicit orphan-cleanup state. Agent runs and terminal deliveries retain stable identities and idempotent canonical commits, but the platform does not claim exactly-once execution of arbitrary remote procedures or provisioning operations.

Remote distributed placement requires distributed lease epochs, write fencing, provider-side idempotency where declared, status lookup, and explicit orphan cleanup that extend beyond current same-device process fencing. Local placements may reuse same-device lease and process-fencing semantics when their capability descriptor makes that limit explicit.

Bounded status lookup may resolve an ambiguous attempt before its terminal effect outcome is committed. Once `unknown` is committed, later status or operator evidence is retained as a separate invocation-resolution observation. It does not rewrite the original `unknown` outcome or retroactively authorize an automatic retry. Product views may show both the original outcome and later resolution evidence without collapsing them.

The shared connector/service invocation substrate must use this same two-layer rule: protocol-result validity is distinct from external-effect certainty, and retry safety derives from declared deduplication or status-query guarantees rather than mutation labels alone.

## RPC payload and artifact custody

Invocation records retain bounded accepted request meaning. Small non-secret JSON inputs may remain inline canonical values. Larger or byte-oriented inputs and outputs use immutable artifacts with exact digest, size, media type, owner, and retention references. Raw credentials and secret-bearing locators remain opaque broker references outside synchronized canonical payloads.

Artifact references are typed fields, not arbitrary strings that happen to look like artifact IDs. Admission verifies caller ownership, grant scope, target visibility, digest, size, and declared procedure bounds. Same-workspace delivery atomically registers authorized references on the target branch before execution and registers result references on the caller branch before terminal delivery. Export and deletion account for both sides.

Remote placement requires staged content transfer, scoped short-lived transfer authority, digest verification, atomic registration with the invocation outcome, bounded retention, and orphan cleanup. A remote call that requires unavailable canonical artifact transfer fails with `CAPABILITY_UNAVAILABLE` before dispatch.

## Branching and stateful environments

Session branches and mutable environments create a major design decision. A historical branch cannot safely pretend that shared external state returned to an earlier point.

The accepted design must choose and document:

- whether one environment is session-wide or branch-owned;
- whether a fork shares the source environment by default;
- whether writable volumes can be cloned or snapshotted for a fork;
- how external services and public endpoints behave across branches;
- whether concurrent branches can write one environment;
- how branch-specific environment deployments consume session-wide service aliases;
- what evidence is retained when exact state cloning is unavailable.

The conservative default is:

- agent identity remains session-wide;
- Phase 1 service definitions and aliases are session-owned and visible to authorized branches only through their next immutable catalog snapshot;
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
- Decide runtime ownership: supervisor placement, console placement, existing canonical-write fences, additional environment and run-worker leases, brokered SDK access, provider credentials, and canonical write authority.
- Accept the shared service contract and invocation substrate with the connector plan, including schema normalization, catalog snapshots, callable references, implementation ABI, logical invocation and dispatch-attempt records, result validation, and artifact custody.
- Accept the initial catalog ownership model: dedicated workspace connector and agent-service control streams, separate publisher and authority domains, explicit owner-session references, session-wide service aliases, exact target-branch call routes, and one coordinated event-schema cutover.
- Define the complete invocation aggregate, durable handle API, request direction, target branch, task ownership, budget payer, reservation, concurrency, cancellation, terminal delivery, acknowledgement, and recovery for `agent.respond`.
- Define environment, service, deployment, grant, and invocation capability descriptors.
- Define artifact transfer and distributed lease prerequisites.
- Define Phase 1 export, synchronization, conflict, quiescence, deletion-refusal, erasure, and receipt semantics for service versions, aliases, grants, callable snapshots, invocations, attempts, and caller/callee references. Workspace export and deletion are the complete Phase 1 erasure boundary. Session export includes attributable session-owned service and invocation records, while independent-session deletion refuses any session retained by the workspace service-control stream or another session.

Phase 1 may begin only when all listed ADRs and substrate contracts are accepted. The phase boundary must be specific enough that implementation cannot silently substitute process separation for sandboxing, synthetic agent-route events for the selected catalog stream, a mutable route for immutable invocation intent, or an ad hoc service launch protocol for the shared implementation ABI.

### Phase 1: local dynamic agent-service contracts

- Add immutable service and procedure contracts to the accepted workspace agent-service control stream, retaining exact owner-session and proposal-route provenance.
- Evolve the current event-schema-version-5 and reducer-version-15 domain deliberately through an accepted pre-release cutover or an explicit compatibility design; do not reinterpret retained events.
- Add event validation, reducers, duplicate and idempotency rules, rebuild coverage, migrations or reset guidance, stream ownership, sync/export behavior, and mutable-table classification.
- Add filtered step-pinned central catalog snapshots and callable references.
- Add `sdk.agents.describe`.
- Add `sdk.agents.invocations.start/get/result/cancel` and the bounded `sdk.agents.rpc` waiting convenience through a managed local in-process or child-process test placement.
- Add Phase 1 service-deployment, allocation, route, health, and allocation-fence identities that do not depend on Phase 2 environment records.
- Implement the platform-owned standard `agent.respond` service over durable mailboxes and agent runs, preserving exact autonomous terminal status inside the outer RPC result.
- Add the canonical invocation aggregate, separate dispatch-attempt records, exact request/result custody, caller delivery, acknowledgement, and restart recovery at every transition.
- Add proposal, deterministic validation, declared tests, exact implementation and contract digests, owner approval, compare-and-swap activation, conflict handling, revocation, retirement, and rollback for executable service publication.
- Revalidate contract, implementation, authority, and tests immediately before activation; approval of documentation alone cannot activate executable code.
- Add runtime input/output validation, version pins, bounds, and structured errors.
- Add explicit narrow same-root parent/child grants, deterministic grant selection, live revocation fencing, target-branch rules, budget accounting, concurrency, cancellation, and terminal delivery; family reach alone grants nothing.
- Consume the accepted shared service contract, invocation, implementation, and artifact substrate rather than creating a second connector-shaped catalog, envelope, or process manager.
- Update synchronization, export, owned-scope reference checks, quiescence, unknown-effect blocking, physical-deletion refusal, projection erasure, and exact deletion receipts for every Phase 1 record and cross-session reference. Session export must include attributable service-control and invocation records. Independent-session deletion must fail closed when the session owns or is referenced by any retained service, grant, catalog snapshot, invocation, attempt, receipt, or cross-session artifact link. Complete physical erasure of those records is supported only through confirmed disposable-workspace deletion in Phase 1. Physical branch deletion remains unsupported until a separate lineage and external-resource erasure design is accepted.
- Add an installed-product Phase 1 acceptance journey using a deterministic local fixture.
- Add no container, remote placement, public ingress, or hostile-code isolation claim.

Exit condition: two service-capable agents in one root family can publish, discover, authorize, call, resume, cancel, revoke, and inspect a versioned procedure through public interfaces with exact target-branch, service, procedure, implementation, deployment, allocation fence, grant, invocation, attempt, result, and artifact provenance. Caller and target restart at every durable boundary does not duplicate a target run or implementation call. Unauthorized discovery and invocation fail without leaking hidden procedures. Environment stop and wake are not Phase 1 claims.

### Phase 2: managed local agent environments

- Add durable environment declarations and generations.
- Add image/setup revisions, lifecycle hooks, service supervision, ports, health, and idle policy.
- Implement child-process placement first and container or microVM placement only with truthful capability distinctions.
- Add local volume identities, snapshots where supported, quotas, and guarded deletion.
- Add independent environment-instance, run-worker, and volume-writer leases while preserving existing workspace and root-family canonical-write fences.
- Require storage-level writer fencing or proven former-writer detachment before automatic writable-volume takeover.
- Require owned-scope reference checks, quiescence, partial-failure retry, orphan records, and exact deletion receipts before the Phase 2 environment and volume lifecycle is considered complete.
- Make service deployment and environment wake recoverable.
- Enumerate authorized wake triggers: admitted RPC invocation, queued family message, owned task, schedule, or heartbeat. Explicit `steer` delivery alone does not wake an idle agent.
- Keep the managed workspace service as the local wake and recovery owner. Phase 2 scale-to-zero stops environment instances; independently waking after every control-plane process exits remains unavailable until a later external wake owner exists.

Exit condition: an agent environment can stop and restart locally without losing agent identity, contract identity, or declared durable state.

### Phase 3: single-owner remote sandbox placement

- Add a hosted or operator-managed environment control protocol.
- Add canonical artifact upload/download and remote result transfer.
- Add remote provisioning, workload identity, distributed leases, fencing, health, logs, metrics, and metering.
- Add private authenticated RPC routing and scale-to-zero wake.
- Add an independently owned durable wake router for calls, tasks, schedules, and heartbeats after workspace and environment processes exit.
- Require provider status lookup, orphan cleanup, remote volume and snapshot deletion, partial-failure retry, and provider-confirmed administrative receipts.
- Keep one owner/tenant boundary and no public ingress.

Exit condition: a remote environment can wake, serve a pinned private procedure, stop, move, and recover without hidden fallback or ambiguous identity.

### Phase 4: authorized peer service network

- Add peer discovery grants beyond the current family boundary.
- Add delegated procedure authority, revocation, audience binding, and policy-filtered documentation.
- Add stable private aliases, pre-terminal status lookup, and evidence-only resolution after committed `unknown`.
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
- stale Phase 1 service-allocation fence rejection;
- stale deployment and live-digest mismatch;
- declaration generation parity where provided.

Invocation tests:

- failure before dispatch versus unknown after dispatch;
- logical invocation identity across replacement dispatch attempts;
- true idempotent deduplication;
- non-idempotent no-retry behavior;
- status lookup before terminal outcome and evidence-only resolution after committed `unknown`;
- cancellation before and after dispatch;
- grant expiry or revocation while queued, provisioning, dispatched, and executing;
- caller and callee restart at every durable boundary;
- result size spill and artifact integrity;
- budget, timeout, and rate enforcement;
- exact caller, callee branch, service, procedure, catalog snapshot, implementation, deployment, allocation fence, grant, invocation, attempt, and outcome provenance.
- preservation of all `agent.respond` run terminals without collapsing `blocked` or `budget_exceeded`;

Environment tests:

- provisioning, wake, readiness, drain, stop, restart, loss, and deletion;
- service crash without agent identity loss;
- setup and shutdown hook failure;
- stale-writer rejection, volume attach fencing, snapshot, restore, migration, and orphan handling;
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

Phase 1 installed-product acceptance must demonstrate:

1. create or select two service-capable durable agents in one root family;
2. publish and activate one bounded private procedure;
3. discover its exact target branch, service, procedure, catalog snapshot, and callable reference from an authorized peer;
4. reject discovery and invocation from an unauthorized peer;
5. call it through `sdk.agents.rpc`, detach, and recover its durable handle and result;
6. lose caller, target, supervisor, worker, and client processes at every durable invocation boundary;
7. prove one logical invocation creates at most one target run or unsafe implementation dispatch;
8. revoke a queued grant before dispatch and prove implementation execution does not begin;
9. preserve all standard-agent terminal statuses, including `blocked` and `budget_exceeded`;
10. inspect exact service, grant, invocation, dispatch-attempt, result, receipt, and artifact provenance;
11. export a service-owning session and prove its attributable service-control and invocation records are included;
12. refuse independent-session deletion while service, grant, invocation, receipt, artifact, or unresolved-effect references remain;
13. delete a quiescent disposable workspace containing Phase 1 records and verify its external receipt accounts for the workspace database, service-control state, artifacts, and configured replicas without leaving unclassified references.

Phase 2 extends this journey by stopping the target environment, waking it through another authorized call, fencing stale instances and volume writers, and preserving declared durable state.

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
- reading exact schemas, mutation class, idempotency, retry, status-query, and cancellation properties;
- correcting deterministic validation errors;
- preserving idempotency keys;
- handling `unknown` without retry;
- selecting recursive calls, subagents, agent RPC, or connectors;
- treating service documentation as capability guidance rather than authority.

## Open decisions

These decisions are assigned to Phase 0 or to the first later phase that depends on them. A phase cannot begin implementation while one of its required decisions remains open.

1. Is the remote wire literal tRPC HTTP, a versioned Agencity HTTP/JSON envelope, or an envelope with generated tRPC adapters?
2. Does one session own one environment, one environment per active branch, or multiple named deployments?
3. How are writable environments and volumes handled when a branch forks?
4. Which service and environment records are canonical events versus rebuildable projections or operational control state?
5. What is the minimum local isolation tier accepted for executable agent-authored services?
6. Which remote sandbox provider or provider-neutral provisioning protocol is the first target?
7. Which remote artifact staging, scoped transfer authority, retention, and orphan-cleanup protocol implements the required custody contract?
8. Which distributed lease and fencing mechanism owns one active environment generation?
9. How are workload identities issued, rotated, revoked, and bound to durable agents?
10. Are peer grants limited to one workspace initially?
11. Can agents delegate grants, and if so, under what depth and scope limits?
12. Which combinations of mutation, idempotency, retry, status-query, and cancellation properties are accepted?
13. Which bounded requested-response schema subset may `agent.respond` admit in addition to its fixed terminal envelope?
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
3. The RPC transport, durable contract representation, exact callable reference, catalog snapshot, and target-route rules are selected.
4. The logical invocation, dispatch-attempt, durable handle, delivery, acknowledgement, and recovery state machines are complete.
5. Procedure effect, durable idempotency, cancellation, status lookup, and committed-`unknown` evidence rules are complete and shared with connectors.
6. Workload identity, grants, deterministic grant selection, live revocation fencing, tenancy, and network policy have an accepted security design.
7. Catalog stream ownership, branch visibility, alias activation, conflict, synchronization, export, and deletion semantics are accepted.
8. Environment owner intent and observed states, canonical and operational lease domains, wake ownership, drain, stop, loss, and deletion are specified.
9. Image, package, hook, volume-writer fencing, artifact custody, database, and secret lifecycle boundaries are explicit.
10. Local placement tiers state truthful isolation guarantees.
11. Remote artifact transfer, distributed fencing, independently owned wake, and orphan-cleanup prerequisites are defined.
12. The platform-owned standard agent service is reconciled with service eligibility, mailboxes, subagents, recursive calls, exact autonomous terminal outcomes, and structured output.
13. Connector and agent-service primitives share one accepted implementation and invocation substrate only where their ownership and authority semantics agree.
14. Phase 1 includes public-interface acceptance and owned-data lifecycle coverage without depending on Phase 2 environment wake.
15. Public ingress remains a separate explicit authority and delivery phase.
16. Every phase has black-box acceptance, security, recovery, and conformance requirements.
17. Public documentation can distinguish proposed, implemented, unavailable, and externally verified behavior without ambiguity.

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

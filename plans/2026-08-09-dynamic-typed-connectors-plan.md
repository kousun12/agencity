# Dynamic typed connectors and managed RPC resources plan

**Status:** Proposed and gated
**Date:** August 9, 2026
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)
**Related planning:** [Formal model-tool contracts](./2026-08-07-formal-model-tool-contracts-plan.md) and [Durable agent profiles and automated refinement review](./2026-08-08-adaptive-agent-city-plan.md) are authoritative; [Lossless context-reference storage](./2026-08-07-lossless-context-references-plan.md) is deferred and is not a dependency of this plan.
**Governing decisions:** [Durable local runtime foundations](../docs/decisions/0001-durable-local-runtime-foundations.md), [Relational memory and governed refinement](../docs/decisions/0002-relational-memory-refinement.md), [Managed workspace execution](../docs/decisions/0007-managed-workspace-execution.md), [Formal model-tool contracts](../docs/decisions/0010-formal-model-tool-contracts.md), [Capability-preserving placement](../docs/decisions/0011-capability-preserving-placement-contracts.md), and [Durable agent profiles and automated refinement governance](../docs/decisions/0012-durable-agent-profiles-automated-refinement-governance.md)

## Summary

Agencity should let agents adapt to unfamiliar applications by discovering, authoring, testing, proposing, and using typed connectors without adding a privileged provider tool or a hard-coded SDK namespace for every environment.

A **connector** is an immutable, versioned contract for typed operations against an external capability. A connector may execute through:

- a managed local sidecar process using a versioned RPC protocol;
- a remote HTTP service implementing the same contract; or
- a future placement that preserves the same invocation and recovery semantics.

The model-facing root remains the static `sdk.connectors` facade inside the TypeScript console. Connector names, operation schemas, generated TypeScript declarations, active versions, and resource handles are dynamic data behind that facade. The provider still receives exactly `bun_console` and `finish`.

Connector definitions live in a durable workspace catalog. The managed workspace service owns connector execution, local sidecar processes, health, draining, and recovery. A sidecar cannot independently register itself or write canonical state. Every connector invocation remains an outbox-backed effect with `succeeded`, `failed`, `cancelled`, or `unknown` as its terminal outcome.

Agents may prototype integrations with ordinary cells, files, shell calls, and existing skills. They may then submit a connector proposal containing a bounded contract, implementation reference, lifecycle declaration, permissions, tests, evidence, and predicted benefit. Deterministic validation and outbox-backed declared tests run before activation. Every agent-authored local implementation version requires explicit owner approval of its exact digest. The current harness refinement lifecycle does not support connectors and is not treated as an activation path.

Connector revisions never mutate a live contract. A new immutable version activates for later model steps. An in-flight model call, its resulting cell, every committed connector effect, and every open resource handle retain the exact connector version and contract digest they began with. Old and new sidecar versions may coexist while pinned work drains. Activating a connector does not restart the workspace service.

## Product decision

Agencity will use a **stable generic connector SDK backed by a dynamic durable catalog**, not a runtime that rewrites its core SDK or provider tool list.

The architecture separates:

- **connector catalog:** durable definitions, immutable versions, logical aliases, activation state, authority, and provenance;
- **connector contract snapshot:** the exact bounded connector view and generated declarations supplied to one model action step;
- **connector runtime manager:** service-owned operational state for local processes, remote clients, health, draining, and resource routing;
- **connector invocation:** one outbox-backed typed request against a pinned connector version;
- **connector resource:** a durable JSON identity for stateful external work, never a socket, process, client object, or language-heap handle;
- **transport:** local framed RPC or remote HTTP used after admission;
- **placement:** where the admitted connector implementation executes, without changing its domain semantics.

This feature is a general adaptation mechanism. ARC-AGI is a motivating example, not a product-specific dependency. An ARC connector could expose `open`, `observe`, `step`, and `close`; another connector could expose a simulator, scientific instrument, local compiler service, database-specific operation, or application API.

The connector registry is not:

- a new list of provider tools;
- a service locator available directly to generated code;
- a mutable process-global map;
- a replacement for skills;
- a package manager;
- a distributed scheduler;
- a route for connector code to mutate canonical tables;
- a way for agents to grant themselves credentials, permissions, budget, or publication authority.

## Initial implementation boundary

The first accepted slice is deliberately smaller than the complete transport-neutral model:

- one workspace-scoped connector-control stream;
- one static `sdk.connectors` root;
- immutable contracts, active aliases, exact step snapshots, and manual owner activation;
- deterministic schema-derived declarations retained inline when supplied to a model;
- one managed local sidecar protocol over framed stdio;
- stateless calls and bounded ephemeral resources;
- preinstalled owner-allowlisted runtime environments with no dependency installer;
- agent proposal and outbox-backed testing;
- no cross-session resource sharing;
- no remote HTTP placement, reconnectable resources, automatic activation, or profile/global publication in the first slice.

Remote HTTP placement and reconnectable resources remain specified as follow-up compatibility targets because they constrain the contract design. They are not required to accept or ship the first slice. Agent-authored automatic activation is deferred until Agencity has a stronger executable-code isolation or an explicit later constitutional decision for a narrowly preauthorized class of connectors.

## Motivation

Agencity's general TypeScript surface can already inspect files, invoke shell commands, call HTTP-capable code, retain JSON state, create artifacts, invoke skills, and delegate work. Those primitives let an agent solve many integration tasks once.

They do not yet provide a complete path from one successful prototype to a reusable typed application integration:

1. A cell can discover an API and write client code, but later agents do not receive a stable contract for it.
2. A skill can package bounded TypeScript behavior, but each skill invocation is a disposable effect. A skill does not own a long-lived Python object, socket, simulator, or remote session.
3. The managed workspace service owns runs and workers, but it has no registry for versioned external capabilities or stateful sidecars.
4. The generic effect interface accepts executor and operation strings, but there is no durable definition, schema, version pin, alias, lifecycle, or pre-dispatch capability admission.
5. The console SDK is statically constructed. It cannot safely infer a historical connector contract from whatever happens to be installed when a worker restarts.

The desired progression is:

```text
unfamiliar environment
  -> inspect and prototype
  -> define a bounded typed contract
  -> test the implementation and failure semantics
  -> propose an immutable connector version
  -> review and activate within standing authority
  -> expose it to later model steps
  -> retain exact versions and outcomes
  -> revise through another tested immutable version
```

The runtime should make this progression possible without making every prototype a resident service or every external API a permanent addition to Agencity core.

## Verified current foundation

The runtime already provides:

- a static TypeScript console SDK injected into disposable Bun cells;
- a generic `tools.request(executor, operation, input, options)` effect path;
- durable request-before-execution outbox semantics;
- explicit `succeeded`, `failed`, `cancelled`, and `unknown` effect outcomes;
- stable idempotency keys and conservative non-idempotent recovery;
- immutable skill versions, declared schemas, tests, permissions, provenance, availability, and governed promotion;
- durable sessions, child tasks, recursive handles, and creation-family authority;
- exact model dispatch, context, harness-selection, and effect provenance;
- a managed workspace service with on-demand startup, authenticated loopback discovery, process fencing, recovery, graceful drain, resident-worker accounting, and quiescent exit;
- local and HTTP-backed effect placement with explicit capability reporting;
- content-addressed artifacts for immutable referenced bytes.

The runtime does not currently provide:

- a connector domain entity or catalog;
- dynamic connector contracts or generated connector declarations;
- connector aliases with immutable version resolution;
- stateful external resource handles;
- a service-owned local sidecar lifecycle;
- connector contract snapshots pinned to model action steps;
- agent connector proposal, test, review, activation, or rollback;
- connector status, inspection, or management through the public protocol and TUI;
- distributed connector placement, execution-owner failover, or hostile-code isolation.

## Goals

- Let an agent adapt to a previously unsupported application through ordinary TypeScript work.
- Let successful integration code become a typed, tested, versioned connector proposal.
- Keep the provider-facing action contract fixed at `bun_console` and `finish`.
- Give generated TypeScript one stable `sdk.connectors` root.
- Provide deterministic runtime validation from bounded operation schemas.
- Generate concise TypeScript declarations and model guidance from the same immutable contract.
- Support stateless calls and bounded ephemeral resource handles in the first slice.
- Keep the contract compatible with later remote HTTP and reconnectable-resource implementations.
- Make the workspace service the sole owner of local connector processes.
- Start connector processes lazily and stop idle process pools without restarting the workspace service.
- Let old and new connector versions coexist while pinned work drains.
- Make newly activated versions visible only at a committed model-step boundary.
- Preserve exact historical contracts for model context, cell execution, effects, resources, recovery, branch inspection, export, and sync.
- Let roots and children discover only connectors allowed by an exact pinned owner-policy revision.
- Preserve user-owned credential, permission, budget, and publication boundaries.
- Reuse existing outbox, artifact, refinement, protocol, and placement foundations where their semantics fit.
- Keep the initial design small enough to implement and test as one bounded capability.

## Non-goals

- Adding an ARC-specific API to Agencity core.
- Dynamically changing the provider tool list.
- Allowing connectors to add arbitrary top-level names beside `sdk`.
- Making TypeScript declarations an authority or security boundary.
- Letting a connector write canonical events or relational tables directly.
- Letting an agent install dependencies, bind credentials, broaden permissions, or activate an agent-authored local implementation.
- Treating a sidecar process as durable identity.
- Preserving arbitrary sidecar heap state after process or machine loss.
- Automatically retrying unknown non-idempotent connector calls.
- Silently switching a remote connector to a local implementation.
- Loading new connector code into an already executing model call or cell.
- Recompiling or replaying historical cells against current connector contracts.
- Making every skill, shell command, or one-off script a connector.
- Adding marketplace discovery, package-registry compatibility, raw arbitrary TCP, gRPC, WebSocket streaming, container orchestration, remote process deployment, or distributed leases in the initial implementation.
- Adding profile/global connector installation in the initial implementation.
- Claiming that process boundaries, declared permissions, or RPC validation create hostile-code isolation.

## Design principles

### The root SDK is static; contracts are dynamic

`sdk.connectors` is part of the fixed console environment. The registry changes its data and generated declarations, not the provider contract or worker RPC method set.

### Contracts are immutable and calls are pinned

A logical connector name may advance to a new active version. Every admitted model step, connector call, and resource handle records the exact version and digest it uses.

### Changes become visible at boundaries

A connector activated while a cell is running cannot alter that cell. The next model action step may receive a new connector catalog snapshot and an explicit change notice.

### Processes are operational; resources are durable identities

A PID, socket, HTTP client, Python object, or module instance is disposable. A connector resource is durable JSON that identifies external state and records whether it is ephemeral or reconnectable. The first slice supports only bounded ephemeral resources.

### The workspace service owns lifecycle

Local sidecars are children of the managed workspace service. They do not self-register, publish their own Agencity discovery manifest, acquire canonical write credentials, or survive service shutdown as orphans.

### Runtime validation is authoritative

Generated TypeScript declarations help the model write correct code. The supervisor validates connector name, version, operation, input schema, resource ownership, authority, availability, and output schema at runtime.

### Prototypes do not become standing capabilities automatically

An agent can always use existing task authority to experiment. Registering a reusable connector introduces durable executable behavior and follows a proposal, test, review, and activation lifecycle.

### Availability and compatibility are distinct

A historical connector contract remains immutable even when its implementation is unavailable. Recovery never substitutes a newer schema. Immediate revocation may stop execution, but it does not rewrite history.

## Terms

- **Connector:** A logical named external capability exposed through typed operations.
- **Connector definition version:** One immutable contract, implementation reference, lifecycle declaration, permissions, tests, provenance, and digest.
- **Connector alias:** A stable workspace-scoped logical name whose active pointer selects a definition version for new resolutions.
- **Connector catalog:** The durable set of definitions, active aliases, availability, and policy-visible metadata.
- **Connector contract snapshot:** The exact bounded connector summaries and declarations supplied to one model action step and its resulting cell.
- **Connector binding:** A model-facing typed view obtained from `sdk.connectors.use(name)`.
- **Connector invocation:** One admitted operation executed through the outbox against an exact connector version.
- **Connector resource:** A durable handle for stateful external work, such as a game environment, simulator session, or remote transaction context.
- **Sidecar:** A local process launched and supervised by the managed workspace service to implement one connector version.
- **Runtime manager:** The operational component that launches, handshakes with, routes to, drains, and stops connector implementations.
- **Transport:** The framed local or HTTP protocol used between the runtime manager and an implementation.
- **Placement:** The local or remote execution location selected by an already admitted connector version.
- **Soft disable:** Prevent resolution in later snapshots while allowing already admitted snapshots and pinned resources to drain.
- **Revocation:** Prevent new work and stop future calls on existing resources when policy requires immediate termination.
- **Supersession:** Activate a newer immutable version for new resolutions without changing existing pins.
- **Connector owner policy:** An immutable owner-authored policy revision that selects allowed runtimes, connectors, operations, principals, endpoint configurations, credential bindings, process bounds, and revocation state.

## Architecture

```text
Provider
  |
  | exactly bun_console or finish
  v
AgentRun step
  |
  | pins ConnectorContractSnapshot
  v
Disposable TypeScript cell
  |
  | sdk.connectors.use/open/call/close
  v
Supervisor connector admission
  |
  | validates pinned version, authority, schemas, resource, availability
  | commits EffectRequested
  v
ConnectorRuntimeManager
  |                         |
  | local framed RPC        | remote HTTP
  v                         v
Managed sidecar         Remote connector
  |                         |
  +----------- result ------+
              |
              v
EffectSucceeded | EffectFailed | EffectCancelled | EffectUnknown
```

The catalog and runtime manager have different ownership:

- canonical connector definitions and alias activations are rebuildable from events;
- immutable connector implementation bundles and generated declarations are content-addressed artifacts;
- process instances, sockets, health samples, pools, and leases are mutable operational state;
- connector calls use the existing canonical effect lifecycle;
- durable resource handles are canonical references to external state, while any in-process client object remains operational.

Workspace-wide connector definitions and active aliases live in one dedicated canonical control stream:

```ts
type ConnectorEventStreamAddress = {
  kind: "workspace-connectors";
  workspaceId: string;
};
```

Proposals retain their originating session, branch, run, step, and evidence references, but definition creation and alias activation commit through the workspace connector stream. Alias compare-and-swap is evaluated against transaction-visible workspace connector state. All roots read the same committed catalog; unresolved synchronized activation conflicts make the affected alias unavailable for new resolution rather than selecting a winner.

## Connector contract

### Definition

The initial contract shape is:

```ts
interface ConnectorDefinitionVersion {
  connectorVersionId: string;
  workspaceId: string;
  name: string;
  revision: number;
  description: string;

  contractVersion: 1;
  operations: ConnectorOperationDefinition[];
  resourceKinds: ConnectorResourceKindDefinition[];

  placement:
    | {
        kind: "local_sidecar";
        protocol: "agencity.connector.stdio-json.v1";
        bundleManifestArtifactId: string;
        bundleManifestDigest: string;
        launch: ConnectorLaunchDescriptor;
      }
    | {
        kind: "remote_http";
        protocol: "agencity.connector.http-json.v1";
        endpointKey: string;
        endpointConfigurationRevision: number;
        endpointConfigurationDigest: string;
      };

  permissions: string[];
  credentialBindingKeys: string[];
  recovery: ConnectorRecoveryDeclaration;
  tests: ConnectorDeclaredTest[];

  generatedDeclarationArtifactId: string;
  generatedDeclarationDigest: string;
  executionContractDigest: string;

  createdBy: ConnectorPrincipalReference;
  sourceProposalId: string | null;
  ownerApprovalId: string | null;
  supersedesVersionId: string | null;
  reason: string;
  evidenceEventIds: string[];
  createdAt: string;
}
```

Exact field names remain subject to domain review. The durable meaning is fixed:

- one immutable version owns one exact contract and implementation reference;
- the execution-contract digest covers every field that can affect execution, including the immutable endpoint-configuration revision or local runtime revision;
- generated declaration bytes are retained so renderer changes cannot alter historical context;
- remote endpoint identity uses an owner-configured non-secret key plus immutable configuration revision and digest, not a mutable raw URL supplied in model output;
- credential binding keys reference owner configuration and never contain credential values;
- a connector version cannot change placement, schemas, recovery class, permissions, endpoint identity, or implementation bytes in place.

### Local implementation bundle

The initial local ABI is a content-addressed `ConnectorBundleV1`:

```ts
interface ConnectorBundleV1 {
  schemaVersion: 1;
  runtimeKey: string;
  runtimeConfigurationRevision: number;
  runtimeConfigurationDigest: string;
  entry: string;
  protocol: "agencity.connector.stdio-json.v1";
  files: Array<{
    path: string;
    artifactId: string;
    digest: string;
    size: number;
  }>;
}
```

The definition references one canonical bundle-manifest artifact encoded as deterministic JSON with sorted object keys and ordered file entries. Every file is a separate immutable artifact identified by artifact ID, digest, and size. The execution-contract digest covers the bundle-manifest digest, runtime configuration, operation contract, resource contract, and placement identity; generated declaration and individual artifact digests remain named dependencies rather than competing definitions of the execution contract.

The managed service resolves and verifies the exact manifest and file artifacts into an owner-only cache, then launches the declared entry with argv construction, working directory, environment, inherited file descriptors, and process-group behavior controlled by the selected owner-configured runtime. Bundles reject absolute paths, traversal, symlinks, install hooks, package-manager commands, mutable external source directories, and undeclared files.

`runtimeKey` selects a preinstalled owner-allowlisted execution environment such as a pinned Bun runtime or a configured Python environment that already contains required packages. The agent may author bridge source and tests, but it cannot create or revise runtime configuration, install dependencies through connector activation, or change the interpreter path. Supporting dependency solving or self-contained container images requires a separate plan.

### Operations

Each operation declares:

- bounded lower-camel or lower-kebab name;
- bounded description;
- JSON input schema;
- JSON output schema;
- whether it requires a resource handle;
- whether it creates or closes a resource;
- idempotency class: `none`, `external_deduplicated`, or `status_queryable`;
- timeout and output bounds;
- cancellation support;
- optional progress capability;
- declared failure codes.

The schema subset should initially match or narrowly extend the existing skill schema subset. Unsupported JSON Schema features are rejected rather than interpreted inconsistently.

`external_deduplicated` requires proof that the underlying external system retains the logical idempotency key across sidecar process loss. An in-memory sidecar cache is insufficient. `status_queryable` requires a contract operation that resolves the exact logical invocation without repeating it. The runtime does not upgrade an operation's idempotency class from observed behavior.

### Resource kinds

A stateful connector declares one or more resource kinds:

```ts
interface ConnectorResourceKindDefinition {
  name: string;
  recovery: "reconnectable" | "ephemeral";
  concurrentCalls: "serialized" | "allowed";
  idleTimeoutMs: number;
  maxLifetimeMs: number;
}
```

- `reconnectable` means a fresh implementation process can resolve the external resource from durable identity without repeating the creating effect.
- `ephemeral` means process loss makes further invocation unavailable and leaves external lifecycle unresolved unless closure is independently proven.

The first slice accepts only `ephemeral`. Reconnectable resources require a later locator schema, owner-controlled handling for secret-bearing locators, and conformance proof that resolution does not repeat external actions. General restartable resources are deferred because the runtime has no connector checkpoint protocol.

Resource state is explicit:

```ts
type ConnectorResourceStatus =
  | "opening"
  | "open"
  | "open_unknown"
  | "closing"
  | "close_unknown"
  | "orphaned_unknown"
  | "closed"
  | "unavailable";
```

Open and close are ordinary effects. Their terminal effects idempotently finalize resource state. A crash between an effect outcome and resource projection update resumes finalization from the retained outcome. Unknown open or close never becomes open or closed. A secret-bearing external locator is retained only as an opaque broker reference outside canonical synchronized payloads.

Permitted transitions and calls are:

- `opening -> open` on proven success;
- `opening -> closed` only when failure or cancellation proves creation never began;
- `opening -> open_unknown` when creation may have occurred without a proven result;
- `open -> closing` on an admitted close;
- `open -> orphaned_unknown` on process loss, revocation, or dependency loss unless external closure is proven;
- `closing -> closed` on proven success;
- `closing -> open` only when the connector proves close did not begin;
- `closing -> close_unknown` when closure may have occurred without proof;
- `open_unknown`, `close_unknown`, `orphaned_unknown`, `closed`, and `unavailable` reject ordinary resource calls.

Only `opening`, `open`, and `closing` keep the service alive, and only within bounded operation, idle, and maximum-lifetime deadlines. Unknown, orphaned, and unavailable states remain visible without pinning the service resident forever, but they block ordinary owned-scope deletion because external cleanup is unresolved. Later evidence-only reconciliation may record an externally observed status but never rewrites the original unknown effect.

## Stable model-facing API

The fixed console facade gains:

```ts
sdk.connectors.list(options?)
sdk.connectors.get(nameOrVersionId)
sdk.connectors.use(nameOrVersionId)
sdk.connectors.open(nameOrVersionId, resourceKind, input, options?)
sdk.connectors.call(nameOrHandle, operation, input, options?)
sdk.connectors.close(handle, options?)
sdk.connectors.propose(input)
sdk.connectors.test(proposalOrVersion, options?)
sdk.connectors.proposals(options?)
```

Illustrative use:

```ts
const arc = sdk.connectors.use("arc-agi");
const game = await arc.open("environment", { gameId: "ls20" });
const observation = await arc.call(game, "step", {
  action: "ACTION1",
});
await arc.close(game);
```

`open`, `call`, and `close` return an explicit four-way value instead of throwing away uncertainty:

```ts
type ConnectorResult<T> =
  | { outcome: "succeeded"; value: T }
  | { outcome: "failed"; error: ConnectorError }
  | { outcome: "cancelled"; error: ConnectorError }
  | { outcome: "unknown"; error: ConnectorError };
```

Validation and authorization errors before effect admission throw typed SDK errors because no external operation began. Once dispatch may have occurred, the four-way outcome is retained and returned.

`use()` returns a cell-local convenience binding whose enumerable durable content is only connector name, version, execution-contract digest, snapshot ID, and operation metadata. Methods are non-enumerable conveniences over the fixed supervisor RPC. Serializing a binding or resource preserves JSON identity, not closures or transport objects.

Every `sdk.connectors` method implicitly carries the cell's pinned snapshot ID. `list`, `get`, `use`, `open`, and alias-based `call` resolve only versions visible in that snapshot. Exact-version access is allowed only when the version is in the snapshot, is pinned by an authorized resource, or is the subject of an isolated proposal test. A cell cannot observe or use a connector activated after that cell began.

The generic API remains usable when generated declarations are unavailable. Runtime validation never depends on TypeScript inference.

## Generated declarations and context

### Deterministic declaration generation

The runtime deterministically renders each accepted connector contract into bounded TypeScript declarations. It does not execute connector-supplied code generation.

The generated declarations provide:

- exact connector name and version;
- operation-name literal unions;
- input and output types derived from the accepted schema subset;
- resource kinds and compatible operations;
- failure and availability result types;
- deprecation or supersession metadata.

The renderer has an explicit ID and version. The exact rendered bytes are retained as an immutable artifact and referenced by digest. Whenever declaration text is supplied to a model, the exact text is also retained inline in the canonical context value. Historical context does not depend on a declaration artifact remaining available. A future lossless referenced-context design may change storage without changing this contract, but this plan does not depend on that deferred work.

Generated declarations are an authoring aid. Runtime schema validation remains authoritative because Bun transpilation does not prove semantic TypeScript correctness and historical code may be supplied without a typechecker.

### System prompt

The immutable base system prompt receives only a concise generic connector guide:

- connectors are dynamic capabilities inside `sdk.connectors`;
- inspect summaries before use;
- retrieve exact contracts when needed;
- treat resource handles as durable JSON identities;
- do not retry `unknown` state-changing calls;
- activation affects later steps, not the current step.

The base prompt does not enumerate every installed connector.

### Dynamic context

Each model action step receives a bounded connector catalog section containing:

- the catalog snapshot ID and digest;
- visible active connector names, versions, short descriptions, and operation names;
- connector versions pinned by resource handles already relevant to the route;
- availability, soft-disable, revocation, and newer-version notices;
- exact declaration text or bounded summaries selected for the step;
- the pinned connector owner-policy revision and digest;
- query guidance for omitted details.

Full schemas and declaration text are included only when:

- the connector count and bytes fit the connector-context budget;
- the current task or retained state already references the connector;
- the preceding step explicitly requested the contract; or
- an active resource requires the exact operations.

Otherwise the model calls `sdk.connectors.get()` and receives the contract as an ordinary cell observation before using it in a later step.

Every context record retains the exact connector summaries, included declaration text, declaration version IDs, digests, owner-policy revision, selection reasons, and omitted-detail query path.

### Step-level pinning

Connector contracts are pinned per **AgentRun action step**, not once for the entire run.

This differs intentionally from the implemented invocation-level profile pinning contract:

- an agent profile defines identity and remains stable for the invocation;
- a connector catalog is external capability state that an agent may legitimately extend during the task.

One snapshot is created when the step begins. Every context materialization, overflow/compaction retry, provider attempt, accepted action, cell execution, and connector RPC in that step carries the same snapshot ID and digest. The cell receives the snapshot identity as a hidden supervisor parameter; generated code cannot substitute it. A connector activation committed during that cell can appear only in the next model step.

Direct diagnostic cells outside an `AgentRun` also require a committed standalone cell-admission snapshot before execution. A connector SDK call without an AgentRun-step or standalone-cell snapshot is rejected. Historical and direct cells therefore use the same snapshot-bound resolution rules.

This rule provides dynamic adaptation without mid-call mutation:

```text
step 4 context: connector v1
step 4 model call: connector v1
step 4 cell proposes/tests v2
activation commits
step 5 context: connector v2 + explicit v1 -> v2 notice
step 5 model call and cell: connector v2
```

An admitted connector effect always pins its exact connector version independently of later step snapshots. Recovery resolves the retained snapshot and version, never the current alias.

Snapshot selection is immutable, but revocation is a live monotonic fence. Effect admission rechecks the current connector revocation generation and records both the snapshot policy revision and observed revocation generation. A later grant or catalog expansion cannot widen an existing snapshot; a later revocation can narrow it immediately.

### Roots and subagents

Each root or child receives its own snapshot according to its session, branch, task, and pinned connector owner-policy revision.

- Initial visibility is the intersection of the active workspace catalog, the owner-policy revision, route identity, task authority, connector requirements, credential-binding policy, and revocation state.
- A child cannot receive broader connector operations or bindings than this intersection allows.
- Child admission records the parent-visible catalog snapshot used to derive its initial visible set.
- Child admission records a permanent connector-authority ceiling. Later owner-policy or catalog expansion cannot broaden that child beyond the ceiling; narrower revocation still applies.
- A child model call that begins later may see a newer active version at its own next committed step.
- Existing resource handles retain their old version even when the parent or child sees a newer alias.
- Connector resources cannot be shared across sessions in the initial implementation, including between parent and child.

No broadcast mutates an in-flight model context. A catalog activation becomes a normal attributable context change the next time an affected route materializes context.

## Catalog and version semantics

### Scope

The initial catalog is workspace-scoped.

- Session-local prototypes remain ordinary cells, files, artifacts, and state.
- A registered connector is a reusable workspace capability.
- Profile/global connector templates, cross-workspace publication, and marketplace distribution are deferred.
- The owner-policy revision is workspace control state and is pinned with every step snapshot and connector effect.

### Alias resolution

A connector name is a stable logical alias. An activation event moves its active pointer through compare-and-swap:

```ts
interface ActivateConnectorVersionInput {
  name: string;
  expectedActiveVersionId: string | null;
  activateVersionId: string;
  reason: string;
  evidenceEventIds: string[];
}
```

Resolution for a new model step records both alias and exact version. Resource opens resolve only through that step's snapshot. Exact-version lookup remains available for management inspection and authorized pinned-resource continuation.

Concurrent activations conflict. Last-write-wins is not valid connector governance.

### Revision

A revision creates a new immutable definition and test history. It never edits an active version.

Activation of a revision:

- affects later connector snapshots and new resource opens;
- does not change in-flight model calls or cells;
- does not change committed or pending effects;
- does not migrate existing resources;
- may lazily start a new process version beside the old version;
- marks the old version superseded but still historically resolvable.

### Disable, revoke, and remove

- **Soft disable** is snapshot-scoped. It blocks later catalog snapshots and therefore later resource opens, but an already admitted cell snapshot may finish and open a resource. Use revocation when new effect admission must stop immediately.
- **Revoke** blocks new work and future calls on existing resources. In-flight calls reconcile through ordinary cancellation and uncertainty semantics.
- **Remove** is a management availability state for future use. It does not delete definitions, effects, resources, evidence, or artifacts.

The public UI must not collapse these states into one “off” toggle.

## Connector creation and governance

### Prototype path

An agent encountering an unsupported application uses existing capabilities first:

1. inspect local files, documentation, API descriptions, or examples;
2. experiment through TypeScript, shell, file, SQL, or existing HTTP capabilities;
3. retain exact observations, failures, and successful calls;
4. identify a stable operation boundary;
5. create a connector proposal only when reuse or stateful lifecycle justifies standing registration.

The runtime should not prompt every agent to create a connector for one-off work.

### Proposal

An agent proposal includes:

- logical name and description;
- operation and resource schemas;
- local implementation bundle or owner-configured remote endpoint key;
- placement and protocol;
- declared permissions;
- requested credential binding keys, if any;
- idempotency, timeout, cancellation, and recovery declarations;
- declared tests and expected results;
- source trajectory and evidence event IDs;
- reason, predicted benefit, and expected active version;
- whether the proposal creates or revises an alias.

Within supported SDK and domain paths, the supervisor derives the executing session and branch and does not accept caller-supplied principal fields. Owner decisions, endpoint configuration, credential references, and test outcomes come from their owning services. This is a trusted-local governance boundary, not authentication against hostile same-user code with ambient operating-system access.

### Deterministic validation

Validation checks:

- schema shape and byte bounds;
- connector and operation naming;
- deterministic declaration rendering;
- declaration/runtime schema agreement;
- implementation artifact existence and digest;
- launch descriptor allowlist;
- remote endpoint key existence without exposing its URL or secret;
- declared permission allowlist;
- credential binding availability without exposing values;
- known-secret rejection;
- resource and recovery consistency;
- timeout, output, progress, and concurrency bounds;
- compare-and-swap active version;
- proposer and target scope;
- protocol compatibility;
- forbidden canonical-write or model-dispatch operations.

Invalid proposals terminate before executable tests or owner approval.

### Tests

A valid proposal runs in a connector test allocation that is distinct from ordinary activation. Connector tests use the same connector executor and outbox path as ordinary invocations, with an explicit test-allocation identity and exact candidate version.

Deterministic contract tests include:

- contract and declaration conformance;
- implementation launch and handshake;
- every declared operation's input and output validation;
- declared safe success fixtures for operations that can run without destructive external effects;
- invalid-input rejection without implementation dispatch;
- bounded output;
- timeout and cancellation behavior;
- process exit before dispatch;
- process loss before dispatch acknowledgement and after possible dispatch;
- resource open/call/close behavior where stateful;
- ephemeral-resource loss behavior;
- known-secret and diagnostic redaction;
- proof that the runtime supplies no canonical database client, managed-service bearer, provider credentials, or SDK handle to the process.

Live external integration tests are separate and explicit. They run only when owner configuration supplies a disposable target and opt-in. A skipped live test is not verification. Generated connector code remains trusted-local; test allocation is lifecycle isolation, not a hostile-code sandbox.

### Review and activation

Connector activation turns temporary source into standing executable behavior and therefore grants durable operational authority even when it does not widen OS permissions. Every agent-authored local implementation version requires explicit owner approval of its exact execution-contract and bundle digests after tests pass.

The connector proposal aggregate has one lifecycle:

```text
proposed
  -> deterministically_rejected
  |  validated
       -> test_failed | test_cancelled | test_unknown | tested
            -> owner_rejected | awaiting_owner_approval
                 -> activation_conflict | active
```

The current harness refinement target set does not include connectors. Connector proposal, test, owner decision, version creation, and alias activation are a separate aggregate that may reuse common validation and notification utilities without claiming an existing promotion path.

Owner policy defines:

- allowed connector protocols;
- allowed local launch runtimes;
- allowed permission names;
- allowed endpoint keys;
- already configured credential binding keys;
- source and artifact bounds;
- connector count and process limits;
- connector count and process limits.

Adding a new permission, endpoint, credential binding, runtime, or broader scope is an owner configuration action outside agent proposal authority.

Owner approval records the exact proposal, bundle, execution contract, tests, expected active version, and policy revision. Activation revalidates every digest and compare-and-swap condition in one transaction. Approval of one version never authorizes later revisions.

Every test operation has a stable test-attempt identity. `test_unknown` is terminal unless the exact operation's declared idempotency class permits safe status lookup or retry; a retry retains the same logical invocation key and creates an attributable attempt. Only `tested` proposals can reach owner approval.

An agent can create, validate, test, and revise a proposal autonomously. If the task requires standing activation, it finishes blocked with the proposal reference and a concise owner action. A later owner approval and user message start ordinary later work; this plan does not add a hidden waiting-for-user state.

Automatic activation is deferred. A later plan may permit it for a narrowly preauthorized remote or externally sandboxed class after a constitutional and security review. An LLM reviewer alone cannot approve unsandboxed local standing code.

### Reproposal and rollback

- A rejected proposal is immutable and terminal.
- One bounded revised proposal may reference the rejection and must change content or evidence.
- Rollback activates exact earlier approved content through a new activation record.
- Rollback does not rewrite calls or migrate resources.
- Modified earlier content is a new proposal, not rollback.

## Local sidecar lifecycle

### Ownership

`ManagedWorkspaceService` owns a `ConnectorRuntimeManager`.

The manager:

- resolves admitted connector versions;
- launches local implementations lazily;
- performs the protocol handshake;
- routes calls and cancellation;
- tracks operational health and in-flight work;
- enforces per-version and workspace process limits;
- drains superseded versions;
- stops idle process pools;
- participates in quiescence and graceful shutdown;
- reports bounded status through the public service protocol.

A sidecar never independently registers itself. Registration means activating a durable connector definition; process startup means satisfying that already admitted definition.

### Protocol

The initial local protocol is `agencity.connector.stdio-json.v1`.

It uses:

- length-prefixed or equivalently unambiguous framed JSON on stdin/stdout;
- request IDs independent of effect IDs;
- one mandatory startup handshake;
- bounded messages;
- explicit call, cancel, health, resource-resolve, and shutdown frames;
- stderr as bounded diagnostic output only;
- no parsing of arbitrary stdout as logs or protocol fallback;
- no bearer or canonical database credentials supplied to the process.
- a startup nonce and launch identity tied to the service fence;
- explicit prepare/ready/start frames for observability;
- stable effect ID, logical idempotency key, and attempt forwarded on every call;
- EOF-triggered self-termination and a lease watchdog;
- an owner-controlled process group or equivalent job boundary for forced cleanup.

The handshake must agree on:

- protocol version;
- connector version ID;
- execution-contract and bundle-manifest digests;
- supported operation names;
- resource kinds;
- cancellation and progress capabilities;
- implementation build identity.

A mismatch makes the implementation unavailable. The runtime never edits the durable definition to match the process.

Dispatch acknowledgement is not a proof that an operation did not start. Once any `start` frame bytes may have reached the sidecar, a state-changing operation is treated as possibly dispatched. A missing acknowledgement after that boundary produces `unknown` unless external deduplication or status lookup proves the result. The optional prepare/ready exchange reduces avoidable ambiguity but does not weaken this rule.

### Lazy start and coexistence

Activating a connector does not restart the workspace service.

- The first admitted invocation or resource open lazily starts the pinned version.
- A newer version starts in a separate process pool when first used.
- The old pool remains while it has in-flight calls or live resources.
- A superseded stateless pool may stop after its in-flight count reaches zero.
- A resource-owning pool follows each resource's recovery and idle policy.
- Idle process pools do not keep the workspace service alive indefinitely.
- In-flight calls and live resources are explicit managed-service keep-alive reasons.

Only in-flight calls and active ephemeral local resources keep the service alive. Stateless idle pools do not. Every ephemeral resource has bounded idle and maximum lifetime, after which the runtime attempts close and preserves `close_unknown` when closure cannot be proven. Future reconnectable remote resources do not require a resident local process and therefore do not keep the service alive merely by existing.

### Service shutdown

Graceful shutdown:

1. stops new connector admission;
2. drains admitted connector protocol handlers;
3. requests sidecar shutdown;
4. waits within a configured bound;
5. terminates remaining local children;
6. records uncertain state-changing calls according to outbox recovery rules;
7. preserves connector definitions and resource identities.

Shutdown does not imply that an external remote resource was closed successfully.

Forced service death cannot be made equivalent to graceful drain. Sidecars must exit on parent-pipe EOF or lease expiry, and startup cleanup verifies launch nonce, process-group identity, and PID reuse before terminating a stale child. Process fencing prevents stale canonical commits but is not itself process termination.

### Recovery

On service restart:

- canonical connector definitions and aliases rebuild before connector admission;
- process pools begin empty;
- no local process identity is restored;
- a future reconnectable resource may resolve through its pinned version;
- an ephemeral resource with unproven external closure becomes `orphaned_unknown`;
- a pending idempotent effect may retry against its pinned version;
- a lost started non-idempotent effect becomes `unknown`;
- a missing, revoked, or digest-mismatched pinned implementation never falls forward to the current alias.

The ARC competition example would likely declare an environment resource `ephemeral` unless the official API proves that a new client can reconnect to the same server-side environment without another create action.

## Remote HTTP placement

The follow-up remote protocol is `agencity.connector.http-json.v1`; it is not part of the first accepted slice.

It provides:

- capability and digest discovery;
- typed operation requests;
- resource identities;
- cancellation when supported;
- bounded progress when supported;
- health inspection;
- four-way terminal outcome mapping.

The endpoint is selected through owner configuration and referenced by a non-secret endpoint key plus immutable endpoint-configuration revision and digest. Authentication uses an opaque credential binding resolved by the supervisor. Credential rotation may preserve endpoint identity, but changing URL, protocol, advertised build, or contract identity creates a new endpoint-configuration revision. Raw credentials never enter connector definitions, model context, events, artifacts, logs, or sync envelopes.

Transport failure:

- before any request bytes can reach the implementation may be `failed` when the runtime proves no operation began;
- after possible dispatch is `unknown` for a state-changing operation unless the connector supports stable idempotency or operation-status lookup;
- never causes silent local fallback.

Raw TCP, arbitrary sockets, gRPC, and WebSocket transports are deferred. The connector contract remains transport-neutral so later placements can be added through conformance rather than model-facing API changes.

## Outbox integration

Connector tests and ordinary invocations compile to one connector-specific executor over the existing effect lifecycle.

The durable request records:

- connector name;
- exact connector version ID;
- execution-contract and bundle-manifest digests;
- operation name and operation schema digest;
- resource ID when applicable;
- validated JSON input digest and retained accepted input;
- placement and endpoint/implementation identity;
- local runtime or remote endpoint configuration revision and digest;
- idempotency declaration and key;
- caller session, branch, run, step, and catalog snapshot;
- attempt and timeout policy.

Admission validates the connector before appending `EffectRequested`. A missing connector should not first be discovered after `EffectAttemptStarted`.

The connector transport must distinguish:

- rejected before dispatch;
- start bytes possibly written;
- dispatch acknowledged when observed;
- terminal result observed;
- operation status recovered by stable idempotency key.

A process exit, timeout, invalid output, or unconfirmed cancellation after start bytes may have been written becomes `unknown` for a state-changing operation unless external deduplication or status lookup proves the result. Bounded malformed-response evidence is retained without treating an invalid response as proof that the external action failed.

The generic `model` executor remains reserved. A connector cannot route around recursive-model admission or create a generic provider completion operation.

## Durable domain model

### Canonical meaning

Canonical state should include:

- connector proposals, validation, tests, reviews, and terminal decisions;
- immutable connector definition versions;
- alias activation, disable, revocation, supersession, and rollback;
- connector contract snapshots supplied to model steps;
- durable resource creation, ownership, version pin, status, and closure observations;
- ordinary effect requests and outcomes for connector operations;
- exact declaration and implementation artifact references.

Potential events:

- `ConnectorProposed`;
- `ConnectorValidated`;
- `ConnectorTestRequested`;
- `ConnectorTestCompleted`;
- `ConnectorOwnerApprovalRequested`;
- `ConnectorOwnerDecided`;
- `ConnectorVersionCreated`;
- `ConnectorVersionActivated`;
- `ConnectorAvailabilityChanged`;
- `ConnectorContractSnapshotMaterialized`;
- `ConnectorResourceOpened`;
- `ConnectorResourceStatusChanged`;
- `ConnectorResourceClosed`.

Names and consolidation are not accepted until reducers, idempotency, atomic transitions, and projection ownership are reviewed.

This feature requires a uniform pre-release event-schema cutover from the currently accepted version 3 to version 4, unless another accepted pre-release cutover lands first. In that case connector events join the next single accepted schema version instead of creating parallel registries. Older workspaces fail closed with reset guidance before migration, decode, projection, sync ingestion, or recovery. Implementation updates reducer versions, retained-history fixtures, snapshots, sync envelopes, export, protocol compatibility, architecture checks, and recovery tests together.

Schema 4 changes the canonical event envelope from an always-required agent route to an explicit stream address:

```ts
type EventStreamAddress =
  | { kind: "agent-route"; workspaceId: string; sessionId: string; branchId: string }
  | { kind: "workspace-connectors"; workspaceId: string };
```

Storage gains typed append/load operations for each address while retaining one globally ordered event cursor. Workspace connector events have workspace-stream parent ordering and no invented session or branch. Context source references identify the stream address and event ID. Sync envelopes retain the same address and causal parent. Concurrent valid alias activations from one expected version become an explicit `connector_activation` reconciliation conflict; the alias is unavailable for new resolution until an owner records a resolution.

### Projections

Likely rebuildable projections:

- `connector_versions`;
- `connector_aliases`;
- `connector_proposals`;
- `connector_tests`;
- `connector_resources`;
- connector snapshot lookup metadata.

Likely operational mutable state:

- process instances and PIDs;
- protocol endpoints;
- health samples;
- in-flight routing;
- process idle deadlines;
- restart counters and backoff;
- local concurrency claims.

Every table must be classified in `docs/mutable-tables.md`. Canonical event rows and immutable context records remain physically guarded.

### Artifacts

Immutable artifacts may hold:

- local implementation bundles;
- generated declaration bytes;
- large schemas and fixtures;
- bounded test outputs;
- large connector observations.

Resolution verifies digest and size. Missing bytes are explicit dependency failures. Connector implementation artifacts participate in export, backup, deletion, and sync dependency reporting.

Owned-scope deletion must inspect connector resources, sidecar activity, shared implementation artifacts, proposals, and endpoint dependencies from the first storage phase. Deletion cannot report an external resource closed merely because local records are removed. Open, opening, closing, or unknown resources block ordinary session deletion unless a separately reviewed force policy retains the unresolved external outcome. Whole-workspace deletion follows existing quiescence and receipt rules and records incomplete external cleanup truthfully.

## Authority and security

The runtime remains trusted-local.

- Local connector code has the OS authority of the Agencity process unless the whole runtime is externally sandboxed.
- A sidecar process boundary is lifecycle and protocol isolation, not a security sandbox.
- Connector schemas and generated declarations do not confine arbitrary local code.
- Sidecars receive a secret-stripped environment by default.
- Credential access is brokered only through owner-configured bindings and is never granted by proposal text.
- The runtime supplies no canonical database client, profile store, managed-service bearer, provider key set, or unrestricted runtime SDK. Trusted-local connector code may still read files available to the same operating-system user; this design does not claim otherwise.
- Connector outputs are untrusted data and receive schema, size, secret, and diagnostic validation before durable append.
- Remote endpoints require explicit authenticated placement configuration; loopback binding alone is not multi-tenant authorization.
- Agent proposals cannot broaden connector scope, permissions, runtime, endpoint, credentials, budget, publication, or network policy.
- Immediate revocation remains available even when it makes a pinned resource unavailable.

Connector process execution must not be described as safer than existing trusted-local skills unless an independently administered sandbox supplies and attests stronger isolation.

Local bundle materialization verifies every digest before launch, rejects path traversal and symlinks, constructs argv without a shell, uses a controlled working directory, supplies an allowlisted environment and file descriptors, and records the runtime configuration revision. Newly issued secret tokens or locators must remain broker-owned opaque references rather than connector outputs placed in canonical or synchronized state.

## Public protocol and terminal product

The public client contract should expose product operations rather than internal process maps.

Illustrative operations:

```http
GET  /product/connectors
GET  /product/connectors/:nameOrVersion
GET  /product/connectors/:nameOrVersion/history
POST /product/connectors/proposals
POST /product/connectors/proposals/:id/test
GET  /product/connectors/proposals/:id
POST /product/connectors/:name/disable
POST /product/connectors/:name/revoke
POST /product/connectors/:name/rollback
GET  /product/connector-resources
```

Exact routes may be consolidated.

The TUI and CLI should show:

- active logical names and exact versions;
- concise operation and resource summaries;
- local or remote placement;
- available, disabled, revoked, superseded, unavailable, and incompatible states;
- proposal, validation, test, review, activation, and rejection state;
- active resource count and pinned versions;
- process state as operational detail, not connector identity;
- bounded health and restart evidence;
- newer-version notices;
- exact provenance and declaration details on demand.

Suggested commands:

```sh
agencity connectors list
agencity connectors show NAME_OR_ID
agencity connectors propose "package the current simulator integration"
agencity connectors test PROPOSAL_OR_VERSION
agencity connectors disable NAME
agencity connectors revoke NAME
agencity connectors rollback NAME VERSION
```

Ordinary users should not need PIDs, sockets, endpoint URLs, event IDs, or resource IDs. Advanced diagnostics may expose them with secret-safe bounds.

## Sync, branch, and device semantics

- Connector definitions and activations are workspace canonical state and may synchronize as immutable envelopes.
- Implementation and declaration artifacts remain required dependencies; automatic artifact replication is not introduced by this plan.
- A sidecar call is authorized by the calling session's existing execution-owner device together with the current managed-workspace process lease and fence. This plan does not add a workspace-wide execution owner.
- A non-owner device may inspect definitions but reports execution unavailable.
- Concurrent alias activations preserve conflict rather than selecting a last writer.
- A branch fork preserves historical connector snapshots already in its history.
- A new model step on any branch resolves the currently active workspace catalog under that route's authority.
- Open resources remain owned by their exact session/branch and cannot be transferred in the initial implementation.
- Distributed connector leases, remote sidecar scheduling, task stealing, and execution-owner failover remain unavailable.

## Performance and bounds

The implementation defines and tests bounds for:

- connector count per workspace;
- visible connector summaries per context;
- full declaration bytes per context;
- schema, implementation bundle, and fixture bytes;
- operation count and resource-kind count per connector;
- active proposals and tests;
- local sidecar processes per workspace and version;
- concurrent calls per connector and resource;
- process startup, handshake, health, idle, drain, and shutdown timeouts;
- RPC message, output, progress, and diagnostic bytes;
- resource count, idle lifetime, and retained metadata;
- restart attempts and backoff;
- automatic reproposals;
- remote endpoint and credential bindings.

Catalog listing and ordinary context do not embed every full schema, implementation source, test result, or version history.

## Delivery sequence

### Phase 0 — Domain and constitutional review

- Accept the distinction between connector catalog, runtime manager, executor, skill, and placement.
- Confirm workspace-only initial scope.
- Confirm step-level connector snapshot pinning.
- Confirm local `stdio-json-v1` as the initial transport and remote `http-json-v1` as a follow-up.
- Confirm ephemeral as the only initial resource recovery class.
- Confirm the separate connector proposal aggregate and exact owner-approval requirement.
- Define the workspace connector-control stream and owner policy for protocols, runtimes, permissions, endpoints, credentials, counts, and principals.
- Confirm the pre-release event-schema cutover.
- Add an ADR for dynamic connectors and managed RPC resources.
- Update `AGENTS.md` when any connector capability ships; automatic activation remains deferred.

### Phase 1 — Durable catalog and static SDK root

- Add connector contract schemas, immutable definition versions, aliases, availability, and deterministic digesting.
- Add bounded deterministic TypeScript declaration generation.
- Add connector catalog snapshots to context materialization and model action steps.
- Bind every retry, action, cell, and connector RPC to the step snapshot.
- Add the workspace connector-control stream and owner-policy revisions.
- Add the static `sdk.connectors` facade with list, get, use, and stateless call.
- Pin exact connector identity in outbox effects before attempt.
- Implement one in-process deterministic fixture connector for conformance only.
- Add replay, rebuild, context-provenance, version-resolution, and schema-validation tests.

### Phase 2 — Managed local sidecars and ephemeral resources

- Add `ConnectorRuntimeManager` to the managed workspace service.
- Add framed `agencity.connector.stdio-json.v1`.
- Add the content-addressed bundle ABI and owner-configured runtime revisions.
- Add lazy process startup, handshake, prepare/ready/start framing, health, pool limits, idle stop, coexistence, drain, watchdog, and forced cleanup.
- Add durable ephemeral resource handles and their complete state machine.
- Add service keep-alive reasons for active connector calls and resources.
- Add deterministic fixture sidecars in Bun and Python.
- Add crash-boundary, orphan-prevention, fencing, quiescence, and recovery tests.

### Phase 3 — Agent proposal, testing, and owner activation

- Add `sdk.connectors.propose/test/proposals`.
- Freeze exact source trajectories, implementation artifacts, schemas, fixtures, permissions, and expected active versions.
- Add deterministic validation and outbox-backed test allocations.
- Add explicit owner approval and rejection over exact tested digests.
- Deliver exact terminal test and owner-decision outcomes to the proposer.
- Add bounded reproposal and rollback.
- Do not add automatic activation.

### Phase 4 — Initial product hardening

- Add protocol, CLI, and TUI inspection and owner decisions.
- Add installed-product journeys for prototype, proposal, test failure, correction, owner activation, coexistence, rollback, detach, service restart, and child discovery.
- Add sync divergence, export, backup, deletion, missing-artifact, and non-owner-device coverage.
- Update all public documentation and `AGENTS.md` for shipped behavior only.
- Run the full deterministic verification suite.

### Phase 5 — Follow-up remote and reconnectable placement

- Add `agencity.connector.http-json.v1` discovery and invocation.
- Add immutable endpoint-configuration revisions and credential bindings.
- Add capability, cancellation, timeout, disconnect, idempotency, status lookup, and unknown-outcome conformance.
- Add reconnectable resources only after locator and secret-broker semantics pass review.
- Prove unavailable remote placement never falls back locally.
- Add context-budget and large-catalog tests.
- Add remote and local placement conformance suites.
- Report credential-gated external checks separately.

## Test plan

### Contract and catalog

- Definitions with the same digest are idempotent.
- Reusing an identity with different durable meaning conflicts.
- Invalid schema features, names, bounds, or lifecycle combinations reject deterministically.
- Generated declaration bytes and digests are deterministic.
- Runtime input/output validation agrees with generated declarations for the accepted schema subset.
- Alias activation uses compare-and-swap.
- Disable, revoke, supersede, remove, and rollback remain distinct.
- Rebuild reproduces the same catalog and active pointers.

### Context and dynamic visibility

- One model call and its resulting cell receive the same snapshot.
- Every retry, accepted action, cell, and connector RPC carries that snapshot.
- Alias and exact-version resolution cannot escape the snapshot.
- A connector activated during a cell is absent from that cell and present with a notice in the next step.
- Historical contexts resolve their exact declarations after later revisions.
- Omitted schemas remain queryable through `sdk.connectors.get`.
- Large catalogs stay within context bounds.
- A child cannot see a connector outside its narrowed authority.
- Parent and child may safely use different snapshots without changing one another's pinned effects or resources.
- Recovery and overflow retries retain the original step snapshot.

### Effects and resources

- Every call records a durable request before implementation dispatch.
- Invalid input rejects before dispatch.
- Output validates before durable success.
- Lost idempotent work retries only against the pinned version.
- Lost non-idempotent work becomes unknown.
- Resource ownership, version, kind, and route scope are enforced.
- Existing resources do not migrate when an alias advances.
- Ephemeral loss follows its declared semantics; later reconnectable support passes separate conformance.
- Unknown create or close outcomes never fabricate resource state.

### Local lifecycle

- The workspace service starts sidecars lazily.
- Handshake mismatch prevents use.
- New and old versions coexist while pinned work remains.
- Superseded idle processes drain and stop.
- Idle process pools do not keep the service alive forever.
- Active calls and resources keep the service alive when required.
- Ephemeral resources have bounded idle and maximum lifetimes.
- Graceful shutdown drains admitted work and prevents new admission.
- Sidecar exit is observed without fabricating call failure.
- Forced service death triggers tested parent-EOF or lease-expiry termination; process-group cleanup, launch nonce, and PID reuse are covered.
- Service restart reconstructs only safe resources.
- Process fencing prevents a stale service owner from committing connector outcomes.

### Follow-up remote placement

- Capability discovery pins endpoint and contract identity.
- Authentication values never enter durable state or diagnostics.
- Pre-dispatch failure and post-dispatch uncertainty map correctly.
- Cancellation capability is truthful.
- Remote loss never falls back locally.
- Unsupported operations fail as unavailable before effect attempt.

### Proposal governance

- Agents can propose within workspace scope but cannot activate directly.
- Proposals cannot add permission names, credentials, endpoints, runtimes, or scope outside standing policy.
- Invalid proposals do not execute tests or reach owner approval.
- Cancelled and unknown tests remain distinct and cannot activate.
- Mandatory tests cannot be waived by owner approval.
- Exact owner approval activates exactly one immutable version.
- Rejection, test failure, timeout, unknown, stale version, and application conflict activate nothing.
- Reproposal has a new identity and obeys its bound.
- Rollback restores exact earlier approved content without rewriting history.

### Security

- Known credential values are rejected and redacted.
- Sidecar environments exclude brokered credential-shaped variables.
- Connector code receives no canonical storage or managed-service bearer.
- Malformed frames, oversized payloads, duplicate request IDs, output-schema violations, and diagnostic injection fail safely.
- Connector descriptions, schemas, tests, and outputs are bounded untrusted context. They cannot alter the formal provider contract, canonical base policy, or runtime authority; behavioral prompt injection remains a model risk and is not claimed impossible.
- Trusted-local limitations remain visible in CLI, TUI, and docs.

### Installed product

A linked-executable journey must:

1. open a workspace with no custom connectors;
2. use ordinary cells to prototype a deterministic local fixture integration;
3. propose a typed connector with tests;
4. observe a failed test and receive exact evidence;
5. submit one corrected immutable proposal;
6. approve and activate its exact tested digest through the owner product path;
7. observe it only on the next model step;
8. open and use a durable resource through the public console SDK;
9. revise and activate a second version without restarting the workspace service;
10. prove the first resource remains pinned to the first version;
11. detach and reattach while the resource remains active;
12. restart the managed service and observe the ephemeral resource's explicit `orphaned_unknown` result;
13. roll back the active alias;
14. inspect exact contracts, effects, resources, decisions, and remaining uncertainty without internal IDs in the ordinary flow.

## Documentation impact

Shipped implementation requires synchronized updates to:

- `README.md`;
- `AGENTS.md`;
- `docs/README.md`;
- `docs/architecture.md`;
- `docs/api.md`;
- `docs/protocol.md`;
- `docs/console-sdk.md`;
- `docs/placement.md`;
- `docs/recovery.md`;
- `docs/security.md`;
- `docs/capabilities.md`;
- `docs/configuration.md`;
- `docs/operator-guide.md`;
- `docs/user-guide.md`;
- `docs/events.md`;
- `docs/mutable-tables.md`;
- `docs/data-lifecycle.md`;
- `docs/skills.md`;
- `docs/verification.md`;
- a new connector authoring and protocol reference;
- a new ADR for catalog ownership, version pinning, lifecycle, and transport semantics.

Public documentation must distinguish:

- connectors from skills and provider tools;
- connector identity from process identity;
- local lifecycle isolation from sandboxing;
- generated types from runtime enforcement;
- soft disable from revocation;
- reconnectable resources from ephemeral resources;
- verified local/remote conformance from skipped external integrations.

## Risks and safeguards

### Registry complexity

A catalog, proposal system, type generator, process manager, resource model, and remote transport can become a plugin platform larger than the agent runtime.

Safeguards:

- one static SDK root;
- workspace-only scope;
- one bounded schema subset;
- one initial local protocol;
- no marketplace or dependency installer;
- lazy processes;
- existing outbox effects;
- phased gates with deterministic fixture connectors before agent authorship.

### Dynamic type confusion

An agent may remember a prior version while the alias has advanced.

Safeguards:

- step-level snapshots;
- exact version in every binding, effect, and handle;
- explicit activation notices;
- old/new coexistence;
- runtime schema validation;
- no replay against current aliases.

### Context growth

Many connector schemas could dominate model context.

Safeguards:

- concise catalog summaries;
- on-demand exact contract reads;
- task- and resource-relevant declaration selection;
- hard byte and count bounds;
- exact omission/query provenance.

### Process leaks

Stateful sidecars could prevent quiescence or survive shutdown.

Safeguards:

- service ownership;
- no self-registration;
- lazy startup;
- active-resource keep-alive accounting;
- idle deadlines;
- bounded drain and termination;
- orphan tests.

### False recovery

A restarted process may appear healthy while its prior external state is gone.

Safeguards:

- explicit recovery classes;
- resource resolution tests;
- version pinning;
- unknown outcomes;
- no inferred reconnectability;
- no current-version fallback.

### Authority expansion

A connector can turn a temporary experiment into standing executable behavior or credential access.

Safeguards:

- proposals cannot activate directly;
- standing owner policy;
- separate endpoint and credential configuration;
- deterministic tests;
- exact owner approval for every local implementation version;
- revocation;
- immutable provenance and rollback.

### Type illusion

Generated declarations may imply stronger safety than runtime behavior provides.

Safeguards:

- schema-derived declarations only;
- runtime validation on both input and output;
- retained renderer and declaration digests;
- explicit documentation that types are authoring aids.

### Misusing skills or placement

Collapsing connectors into skills loses stateful lifecycle; collapsing them into placement makes infrastructure own product identity.

Safeguards:

- connector catalog owns durable integration identity;
- skills remain disposable governed behavior;
- executors perform effects;
- placement selects where an admitted connector runs;
- runtime manager owns operational processes.

## Rejected alternatives

### Add one provider tool per connector

Rejected because it breaks the fixed formal action contract, creates provider-specific schema churn, enlarges prompts, and makes historical tool sets difficult to recover.

### Mutate the top-level console SDK

Rejected because active workers and historical cells would observe different names without a stable root or contract snapshot.

### Treat `tools.request` strings as the registry

Rejected because strings alone do not provide durable definitions, schemas, authority, version pins, lifecycle, context, or pre-dispatch availability.

### Treat connectors as ordinary skills

Rejected because skills are disposable executions. They do not own long-lived resources, process pools, handshake protocols, or reconnect semantics.

### Let sidecars self-register

Rejected because it creates independent process authority, orphan risk, unauthenticated local discovery, and nondeterministic recovery.

### Restart the workspace service on connector activation

Rejected because immutable version coexistence and lazy process pools can apply revisions without interrupting unrelated runs, clients, schedules, or resources.

### Load a new implementation into an existing process

Rejected because in-place code replacement obscures which version served a call and makes drain, rollback, and recovery ambiguous.

### Start with arbitrary TCP

Rejected because raw TCP adds framing, authentication, discovery, cancellation, health, and conformance work without changing the connector semantics. Local framed stdio is sufficient for the initial slice; versioned HTTP is the first follow-up remote transport.

### Make the database store sidecar heap state

Rejected because arbitrary language heaps are not portable, attributable, or safely recoverable. Connectors must expose durable JSON resources and explicit recovery behavior.

## Completion criteria

The plan is complete when:

1. The provider still receives exactly `bun_console` and `finish`.
2. Generated code uses one stable `sdk.connectors` root.
3. Connector definitions are immutable, versioned, typed, attributable, and workspace-scoped.
4. TypeScript declarations derive deterministically from accepted bounded schemas and are retained by digest.
5. Runtime validation, not generated types, controls admission.
6. Each model action step and resulting cell pin one exact connector contract snapshot.
7. A connector activated during a cell appears only in a later model step.
8. Every connector effect and resource pins an exact connector version.
9. Local sidecars are launched, supervised, drained, and stopped only by the managed workspace service.
10. Connector activation does not restart the workspace service.
11. Old and new versions coexist while pinned work drains.
12. Local connector calls preserve the same four-way outcome and recovery semantics as other effects.
13. Initial stateful resources are bounded and explicitly ephemeral.
14. Recovery never substitutes a newer contract or invents external state.
15. Agents can prototype, propose, test, revise, and inspect connectors within their authority.
16. Every agent-authored local implementation version requires mandatory tests and explicit owner approval of exact digests.
17. Credentials, endpoints, permissions, runtimes, and broader scope remain owner-controlled.
18. Roots and children receive bounded, attributable connector context under narrowed authority.
19. Sync, export, backup, deletion, and missing-artifact behavior retain complete connector dependencies and uncertainty.
20. The installed product demonstrates creation, failed testing, correction, activation, next-step visibility, version coexistence, resource use, detach, restart, rollback, and inspection through public surfaces.
21. Typecheck, architecture checks, deterministic tests, and acceptance pass; gated external checks are reported separately.
22. `AGENTS.md`, ADRs, and public documentation describe only shipped connector behavior and limitations.

## Deferred extensions

- Profile/global connector installation.
- Cross-workspace connector publication.
- Public marketplace or package-registry discovery.
- Automatic dependency installation and environment solving.
- Agent-authored automatic activation.
- OCI, microVM, or container-managed connector placement.
- Raw TCP, gRPC, and WebSocket transports.
- Remote HTTP placement and reconnectable resources until the initial local slice passes its completion bar.
- Server-pushed streaming beyond bounded progress.
- Connector-defined provider tools.
- Transferable resources across unrelated roots.
- Distributed connector leases and scheduling.
- Remote sidecar deployment and execution-owner failover.
- Connector-specific credential acquisition flows.
- Hosted multi-tenant connector administration.
- Hostile-code isolation or connector attestation.
- Automatic artifact replication and garbage collection.

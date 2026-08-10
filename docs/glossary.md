# Agencity glossary

This glossary defines Agencity's main product and architecture terms in conceptual order. It begins with authority and identity, then covers work, execution, adaptation, persistence, and deployment. It is not alphabetical because later concepts depend on earlier ones.

[`AGENTS.md`](../AGENTS.md) remains authoritative for product direction, supported behavior, invariants, and implementation rules. The [capability matrix](./capabilities.md) remains authoritative for whether a capability is supported, conditional, or unavailable. This glossary defines vocabulary; it does not turn accepted or planned behavior into a shipped capability.

## 1. Product and authority

### Agencity

A terminal-first autonomous agent runtime in which generated TypeScript programs may be temporary while committed work, identity, relationships, evidence, and decisions remain durable. Agencity is inspired by Recursive Language Models and continual harnesses, but it is not a compatibility port of Prime Agent.

### Repository guide (`AGENTS.md`)

The canonical source for Agencity's product direction, design constitution, supported behavior, invariants, security boundary, and implementation rules. It governs development of Agencity itself. During a run, a target repository's bounded root and discovered directory `AGENTS.md` files become attributable model-facing project guidance. They are not a governance charter, authority source, or permission mechanism for Agencity.

### Product or design constitution

Agencity's highest-level design principles: durable identity, attributable context, bounded autonomy, visible uncertainty, governed adaptation, user authority, and placement-preserving semantics. Maintainer guidance lives in [`AGENTS.md`](../AGENTS.md). Runtime governance supplies a packaged immutable product-constitution component with ID, version, digest, and frozen text; it is not user-editable workspace state or runtime permission.

### Base runtime policy

The immutable Agencity system-policy component included in model calls. It defines standing runtime behavior and remains separate from editable agent profiles and harness entries. The runtime, not model-authored prose, enforces actual authority.

### Workspace charter

An optional future owner-controlled statement of workspace-specific purpose and constraints subordinate to product policy and runtime boundaries. No public workspace-charter configuration exists. Governed reviews retain this component as `null` and do not infer it from repository files.

### User-declared constraint

An explicit owner instruction or policy that bounds agent behavior or refinement. It has greater authority than an inferred tactic or agent-authored preference and cannot be widened by a reviewer.

### Runtime authority

The operations and resources the runtime actually permits: model configuration, credentials, budgets, SDK methods, effects, completion rules, filesystem or process access, and other typed capabilities. Profiles, prompts, and reviewer approval may influence behavior but cannot grant runtime authority.

### Trusted-local

Agencity's current security boundary. Generated TypeScript and shell commands run with the operating-system authority of the local runtime process. Worker separation, path checks, redaction, and typed APIs reduce mistakes but do not provide a hostile-code sandbox or multi-tenant isolation.

### Capability

A behavior a placement or service can truthfully provide, such as offline writes, analytical SQL, notifications, or isolated remote execution. Unsupported capabilities fail explicitly; Agencity does not silently weaken semantics or change placement.

## 2. Ownership and identity

### Workspace

The ownership and placement boundary for agent work associated with a project. A stable owner-only `.agencity/workspace-id` marker preserves its identity if the repository moves and makes identity independent of an absolute path. A workspace has a local canonical event database and configured artifact storage and may contain multiple independent root agents. Optional synchronization exchanges immutable event envelopes but does not replace local canonical ownership.

### Profile/device store

A local store separate from workspace state. It owns stable device identity, cross-workspace preferences and catalog entries, globally installed skills, provider configuration, and opaque credential references. It does not own agent-session identity or raw credential values.

### User profile (`userProfile`)

The profile/device-store identity and preference state exposed to runtime contracts. The qualified name distinguishes it from a session-owned agent profile.

### Agent

The product term for one durable executable identity. In the domain model, an agent is a `Session`; there is no separate `Agent` aggregate above a session.

### Session

The durable actor that owns model configuration, budget state, goals, conversation branches, tasks, runs, effects, cells, schedules, recovery state, and one session-wide agent profile. A process, worker, model connection, or terminal attachment may disappear without ending the session's identity.

### Agent profile (`agentProfile`)

The immutable-versioned standing role, purpose, and agent-specific behavioral instructions for one session. It answers who the agent is and how it should generally behave. It does not contain current tasks, repository facts, memories, credentials, budgets, model configuration, or permissions.

### Agent-profile version

One immutable revision of an agent profile, including its exact rendered agent prompt, digest, creator, source, reason, and provenance. New sessions have an initial version. Approved governed proposals and exact rollback create later immutable versions for future invocations.

### Active profile

The session-wide profile version selected for future invocations. It applies across all conversation branches. Changing it does not alter an invocation that has already pinned an earlier version.

### Agent prompt

The exact provider-facing text rendered from one agent-profile version. It is stored with that version so historical behavior does not depend on future rendering-code changes.

### Effective system prompt

The complete system content for a model invocation, assembled in fixed order from the base runtime policy, pinned agent prompt, invocation response contract, and execution guidance. Dynamic task, conversation, memory, artifact, and observation context is separate.

### Invocation profile pin

The immutable reference to the exact profile version and agent-prompt digest selected when an autonomous run or recursive-model invocation begins. All model calls and retries within that invocation must use the same pin.

### Root agent

A session with no creation-family parent. A workspace may contain multiple independent roots. The user's remembered root selection determines which root receives an ordinary no-ID task.

### Child agent

A session created by a parent through a durable task. A child has the same persistence model as a root, plus retained ancestry, task ownership, inherited limits, and family-scoped communication.

### Creation family

One root agent and all descendants created under it. Task ownership, mailbox reach, cancellation, budget attribution, and follow-up use this retained family relationship. Unrelated roots are not members of one merged agent identity.

### Branch

A durable line of conversation and session history. Forking creates a counterfactual continuation from an earlier cursor without rewriting the original history. A branch does not create a new session or a separate active agent profile.

### Route

The selected session-and-branch path through which the product reads conversation state and admits new work. Route selection changes where the user is working; it does not change durable identity.

## 3. Work and completion

### Work source

An admitted reason to begin autonomous work: a direct user request, child task, retained family follow-up, schedule, or wake. A durable profile alone does not authorize execution.

### Task

The durable record of why a parent created a child, what completion means, how budget is attributed, and the child's lifecycle. A task is finite work; it is not the child's standing identity.

### Goal

A durable desired state for autonomous work. A goal may have completion gates and remains separate from the agent profile and current conversation.

### Completion gate

A typed, attributable check that must pass before a goal can be completed. Gate evidence is pinned to relevant workspace material so stale success cannot silently approve changed work.

### Budget

Durable token, cost, turn, and wall-time limits and their recorded usage. Child limits cannot widen parent limits. Unknown usage is accounted for conservatively.

### Agent run

A canonical, bounded period in which the supervisor advances one admitted work source through model decisions and TypeScript execution toward a typed terminal outcome. Outcomes include succeeded, blocked, failed, cancelled, budget-exceeded, and unknown.

### Run step

One model-decision cycle inside an agent run. A step materializes context, requests a model call, validates one formal action, and either executes a cell, checks completion, or reaches a terminal outcome.

### Invocation

One profile-pinned unit of model-driven work: either an autonomous agent run or retained recursive-model execution. An invocation may contain multiple model calls or retries while preserving one profile pin.

### Agent action

The validated, canonical decision submitted by the model for one run step. The formal action is either `bun_console`, containing a TypeScript cell, or `finish`, containing a typed successful, blocked, or failed outcome and exact user-facing message.

### Cell

A proposed TypeScript program executed in a disposable Bun worker. A committed cell records source, dependencies, bounded logs, result, exports, and terminal status. Lexical variables and the worker heap are not durable across cells.

### Working value

A named durable JSON value, or a reference to an artifact, saved through the console state API for later cells. It is the small structured-data alternative to relying on worker memory.

### Artifact

Immutable byte content identified and verified by digest in a content-addressed store. Canonical events retain its reference and provenance; the bytes may live outside the workspace database.

### Effect

External work such as a model request, shell command, file operation, or skill invocation. Its request is committed before execution, and its terminal outcome is recorded as succeeded, failed, cancelled, or unknown.

### Outbox

The rebuildable operational queue derived from committed effect requests. Executors claim work from it, but canonical effect events—not mutable claims or leases—remain the durable truth.

### Unknown outcome

An explicit terminal state used when the runtime cannot determine whether an external effect occurred or what it returned. Unknown is not treated as failure or success and does not authorize a blind retry of non-idempotent work.

### Message

A durable user, assistant, system, tool, or family-delivered conversation record on a branch. Messages are only one part of context; they do not contain the complete durable history.

### Mailbox

The durable family-scoped communication path between authorized parent, child, and sibling sessions. Sends, deliveries, acknowledgements, and terminal notices remain attributable and recoverable.

### Recursive model call

A model invocation admitted as a durable child session and task rather than an anonymous returned string. It has a stable handle, model configuration, budget, profile, input provenance, cancellation, and terminal outcome.

### Schedule

A durable one-time or recurring definition that queues work at a due time. Missed recurring intervals coalesce rather than producing an unbounded backlog.

### Heartbeat

A durable periodic trigger associated with a goal and prompt. Each tick advances monotonically and queues a wake; replaying history never invokes the scheduler.

### Wake

A durable queued request that connects a schedule or heartbeat to the ordinary agent-run path. Claim and delivery state prevents recovery from creating a second autonomous execution loop.

## 4. Context and adaptation

### Context

The bounded, attributable information selected for one model call from durable state. It may include system components, messages, profile data, task state, working values, artifacts, memories, harness entries, budgets, and observations. It is not the complete event history.

### Context materialization

The deterministic act of selecting and recording a model call's exact context, source event references, reasons, hashes, profile pin, and prompt-component provenance.

### Compaction

A derived, bounded summary or extraction of older narrative context used to fit a model window. Compaction never deletes or replaces canonical source history.

### Memory

A versioned, scoped harness entry containing a retained claim, observation, preference, or decision for later retrieval. Memory is knowledge, not agent identity or runtime authority.

### Continual harness

The adaptable collection of memories, prompt notes, skills, and reusable subagent specifications supplied to model context under explicit scope, version, provenance, and lifecycle rules.

### Prompt note

A versioned piece of optional dynamic behavioral or procedural context. A prompt note may influence a model call but does not replace the required agent profile or base runtime policy.

### Skill

A versioned reusable capability or workflow invoked through the runtime. Generated skills must compile and pass their declared runtime tests before activation. Skill text cannot widen runtime permissions.

### Subagent specification

A versioned reusable template describing a child role, invocation criteria, prompt, expected artifact, optional model or budget, and completion criteria. Invoking it creates an ordinary durable child session and materializes an initial agent profile; the specification is not itself the child's identity.

### Trajectory

A bounded, attributable sequence of events from completed work used as evidence for review or refinement. A trajectory can show what happened without proving that one prompt component caused the outcome.

### Refinement

The governed process for changing agent profiles, memories, prompt notes, skills, and subagent specifications. The ordinary path is immutable proposal, deterministic validation, one separate sealed review, application-time revalidation, automatic application or rejection, terminal delivery, attributable later evidence, and exact rollback.

### Refinement proposal

An immutable typed request to create, replace, or retire behavioral content. It identifies the proposer, target, expected active version, replacement, reason, predicted effect, scope, and evidence. A proposal is not authority to activate its own content.

### Deterministic validation

Non-model checks applied to a proposal, including schema and size bounds, authority, scope, secret rejection, compatibility, rendering, tests where required, and expected-version comparison.

### Refinement reviewer

A separate sealed model invocation that may only approve or reject one valid proposal against frozen product constitution, review policy, target, evidence, proposer relationship, runtime boundaries, and current-model dispatch. Workspace charter and user constraints are currently `null`. It cannot edit the proposal, widen authority, select another target, or activate content, and the caller cannot choose it.

### Governed refinement status

The retained lifecycle state of a governed proposal: `proposed`, `deterministically_rejected`, `validated`, `reviewing`, `reviewed_rejected`, `review_failed`, `review_unknown`, `reviewed_approved`, `apply_conflict`, `apply_failed`, or `applied`. Only `applied` changes active content.

### Evaluation

Attributable observation of outcomes associated with a candidate or active behavioral version. Reviewer approval establishes policy consistency, not empirical improvement; later evaluation may support another proposal or rollback.

### Rollback

Restoration of exact earlier approved content through a new immutable version and activation. Rollback preserves intervening history. Any modification to the earlier content is a new proposal, not a rollback.

## 5. Durable state and recovery

### Canonical event

An immutable, validated record of durable domain meaning in the append-only workspace event history. Ordinary operation does not update or delete canonical events.

### Event history

The ordered canonical record from which session state and rebuildable projections are derived. Historical replay applies state transitions only; it never re-executes models, cells, or effects.

### Reducer

A deterministic function that applies canonical events to derive agent state. Duplicate event IDs are true no-ops, allowing safe catch-up and rebuild.

### Projection

Query-friendly state derived from canonical events, such as current routes, active profiles, task status, or outbox work. A projection may be mutable only when its rebuild or operational semantics are explicit.

### Snapshot

A disposable acceleration record containing projected state at a cursor. A snapshot is not canonical and may be deleted and rebuilt from events.

### Cursor

An opaque ordered position in one local workspace database. Clients use it for catch-up, subscriptions, historical inspection, and branch forks. It is not a portable timestamp or a cross-database sequence.

### Idempotency key

A stable operation key that lets an exact retry return the original durable result without duplicating work. Reusing the same key with different durable meaning is a conflict.

### Recovery

Reconstruction and continuation from committed durable boundaries after a worker, supervisor, service, or client interruption. Recovery does not depend on preserving a JavaScript heap and does not blindly retry uncertain non-idempotent effects.

### Synchronization

Optional exchange of immutable event envelopes between trusted devices through a separate replica database. Local workspace history remains canonical, artifact bytes are not copied automatically, and synchronization does not provide distributed execution locks or owner failover.

### Replicated envelope

The immutable transport representation of an event plus origin, causal dependencies, and integrity digest. An envelope is validated before it becomes local canonical history; it is not itself a domain event.

### Divergence

The condition in which devices independently advance the same historical branch. Agencity preserves both histories through distinct branches instead of silently choosing a last writer.

### Conflict

Two durable claims that cannot safely be combined or selected automatically, such as competing task ownership. Conflicts remain explicit until a typed resolution records user authority.

### Quarantine

Storage for invalid, corrupt, incomplete, or causally unacceptable synchronized envelopes. Quarantined data does not enter canonical history.

## 6. Runtime and interfaces

### Supervisor

The runtime composition and validation layer that owns canonical commands, context materialization, model dispatch, execution orchestration, recovery, and service boundaries. It keeps credentials and authority outside generated code.

### TypeScript console

The model's general generated-execution surface. It runs validated TypeScript cells and exposes typed APIs for files, shell, SQL, state, artifacts, models, subagents, goals, memory, skills, and refinement.

### Console SDK

The typed API injected into a console cell. SDK methods request validated runtime operations; they do not grant unrestricted canonical database writes.

### Protocol

The public loopback HTTP/JSON and server-sent-event contract used by clients to inspect and control durable work. Correct clients load a snapshot, retain its cursor, and catch up committed events without treating temporary progress as durable truth.

### Terminal UI

The full-screen terminal client that presents conversation, runs, cells, effects, family relationships, and inspectors through the public protocol. It observes and steers work but does not own session identity.

### Managed workspace service

The authenticated loopback process that owns detached run advancement, recovery, schedules, wakes, and same-device execution fencing for product use. It may stop when quiescent without deleting durable agent identity.

### Placement

The configured implementation of a replaceable boundary such as relational state, artifact storage, candidate retrieval, or effect execution. Local and remote placements may differ in capability but must preserve identifiers, causality, outcomes, and failure truth.

### Adapter

An implementation that translates a stable domain contract to a specific storage, object service, executor, provider, or transport. An implemented remote adapter does not imply that Agencity hosts or secures the corresponding infrastructure.

### Model provider

The configured service that executes model requests. Provider credentials remain supervisor-side, and every request retains explicit model, endpoint, capability, and reasoning configuration.

### Recursive Language Model (RLM)

An approach in which a model treats context as data and writes programs that inspect, transform, delegate, call models and tools, and combine results. In Agencity, the TypeScript console and durable recursive sessions provide this programmatic surface.


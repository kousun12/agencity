# Durable agent specialization and adaptive workspace organization plan

**Status:** Proposed and gated
**Date:** August 8, 2026
**Last revised:** August 9, 2026
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related plans:** [Workspace Agents view](./2026-08-08-workspace-agents-view-plan.md), [Ergonomic agent-family navigation](./2026-08-07-ergonomic-agent-family-navigation-plan.md), and [Lossless context-reference storage](./2026-08-07-lossless-context-references-plan.md)  
**Related decisions:** [Durable agent relationships](../docs/decisions/0006-durable-agent-relationships.md)

## Summary

Agencity should retain useful agent specialization instead of reconstructing every helper from a task string. A durable agent can accumulate attributable work, evidence, context, and relationships while remaining dormant between finite assignments.

This plan preserves that product direction while avoiding an all-at-once organizational control plane. It introduces three gated capabilities in one document:

1. **Durable agent profiles** give every runnable session explicit, exact, attributable purpose and agent-specific system instructions for every agent invocation.
2. **Reusable specialist routing** lets a workspace coordinator discover suitable agents and send new finite work to an existing agent through a durable assignment.
3. **Direct adaptation** lets users, parents, and agents revise profiles through immutable versions that activate at invocation boundaries and remain attributable and reversible.

Each capability must prove its value before the next becomes a required product dependency. A management hierarchy independent of creation ancestry, reparenting, split and merge state machines, terminal retirement, successor identity rules, a unified per-agent grant system, generalized approval workflows, and automatic organizational restructuring are outside this plan.

`Session` remains the only executable agent identity. The plan does not introduce a second Agent aggregate.

## Central product thesis

The plan is motivated by five observations:

- A specialist that repeatedly performs useful work should be reusable without being rediscovered as an anonymous helper.
- Enduring purpose and current work are different kinds of state.
- An agent may remain available without remaining active, inventing goals, or consuming model or console capacity.
- The exact agent-specific instructions governing a model call should be inspectable after the call.
- Adaptation should be direct, attributable, versioned, and reversible rather than silently rewriting prompts or organization state.

The resulting workspace is a durable institution only in this bounded sense: it contains separately identified agents, a searchable directory, a stable inbound coordinator, finite work relationships, and retained evidence about change. It is not one merged model identity, an autonomous bureaucracy, or a distributed control plane.

## Plan structure and gates

This remains one plan because the capabilities share one product thesis and one agent identity model. They are separated into stages so later organizational machinery does not become a prerequisite for validating the simpler idea.

### Stage 1 — Durable purpose and prompt provenance

Stage 1 proves that exact agent-specific purpose improves inspectability and behavior.

It adds:

- one required immutable profile for every newly runnable agent;
- sealed product defaults for roots and concise task-specialist defaults for one-off children;
- deterministic agent-prompt materialization;
- exact profile and effective-system-prompt pinning on every autonomous run and recursive-model invocation;
- profile inspection in owner-facing agent detail.

It does not require:

- workspace-wide assignments;
- semantic routing;
- a second management hierarchy;
- profile revision;
- agent lifecycle beyond current execution state;
- organization proposals;
- automatic adaptation.

### Stage 2 — Reusable specialist routing

Stage 2 begins only after Stage 1 demonstrates that retained agent purpose is useful and that users have recurring work suitable for reuse.

It adds:

- one workspace-default coordinator route;
- a central rebuildable agent directory;
- explicit directory metadata and routing eligibility;
- explicit owner-directed metadata, assignment-route, eligibility, pause, resume, archive, and restore actions;
- durable assignments to already-existing agents;
- retained routing decisions and exact route/profile pins;
- pause and archive behavior for directory routing.

It preserves existing `Task` semantics for child creation. Initial child work is not represented as both a task and assignment.

### Stage 3 — Direct, versioned adaptation

Stage 3 begins after durable profiles have demonstrated that preserving specialist identity is useful.

It adds:

- direct self-revision of an agent's profile;
- direct parent revision of a creation-family child's profile;
- direct owner revision of any workspace agent profile;
- direct self, parent, and owner updates to directory metadata within the same relationship scope;
- atomic version creation and activation for future invocations;
- compare-and-swap conflict detection, exact history, optional evidence references, and rollback.

Stage 3 does not introduce proposal queues, approval state machines, candidate exposure, generalized policy evaluation, runtime grants, reparenting, split, merge, successor, or retirement state machines.

### Advancement evidence

A stage advances when installed-product evidence shows:

- a recurring user or runtime problem that the next stage addresses;
- the existing stage cannot solve that problem through a smaller mechanism;
- attributable quality, cost, latency, correction, or coordination signals;
- a black-box journey that exercises the new capability;
- retained recovery, security, and data-lifecycle semantics.

Passing component tests alone does not advance a stage.

### Stage-specific acceptance gates

Stage 1 acceptance requires an installed journey that creates root and child profiles, proves exact per-call prompt provenance, restarts the service, and resolves the same historical profile and prompt digests. No assignment or organization machinery is required.

Stage 2 acceptance requires an installed journey that explicitly makes one proven child workspace-eligible on an exact assignment route, routes repeated work to it, preserves one usage record and terminal result, pauses it, archives it, and reconstructs the same directory and assignment state after restart.

Stage 3 acceptance requires an installed journey in which an agent directly revises its own profile, a parent directly revises a child profile, and one revision is rolled back while earlier model calls retain their original profile and prompt content.

The domain review defines measurable advancement thresholds for routing reuse, avoidable handoffs, corrections, cost, and latency before Stage 2 or Stage 3 implementation begins.

## Product vision

The ordinary product experience addresses the workspace rather than requiring internal session or branch IDs.

```sh
agencity "find and fix the flaky test"
```

At Stage 1, the selected root agent receives the task with its exact durable profile.

At Stage 2, the workspace coordinator uses a bounded directory to:

1. handle the task itself;
2. route it to a workspace-eligible existing specialist;
3. create a child through the existing durable family model when no specialist fits;
4. finish as blocked when required user information is missing or an operation is unavailable.

Routing to an existing agent creates an assignment. Creating a child continues to create one existing `Task` relationship. Both paths eventually advance work through the same `AgentRun`, goal, gate, effect, and recovery machinery.

Returning with `agencity` resumes the remembered observation route. The remembered route and the workspace-default inbound coordinator remain distinct product concepts. Opening another agent for inspection never silently changes the default inbound recipient.

Agents consume no model or console capacity merely because they remain durable. Existing managed-service liveness continues to follow active runs, effects, wakes, schedules, heartbeats, resident workers, and attached clients. Stage 2 additionally treats queued or claimed assignments as resident work while the durable claimer can advance them. Retained tasks alone do not keep the service alive.

## Verified current foundation

The runtime already provides:

- `Session` as a durable actor with model configuration, budget, goals, conversation, branches, tasks, runs, and event history;
- atomic child admission with parent and child identity, task intent, model, budget, initial prompt, and admission;
- durable parent, child, and sibling mailboxes;
- bounded child follow-up after terminal task work;
- append-only canonical history and rebuildable projections;
- attributable materialized model context;
- immutable versioned prompt notes, memories, skills, and subagent specifications;
- governed harness refinement with proposals, validation, candidates, observations, decisions, and rollback;
- typed goals, gates, outbox effects, unknown outcomes, cancellation, schedules, wakes, and recovery;
- product branch discovery, human-readable selection, and remembered observation routes.

The runtime does not currently provide:

- required per-session agent-specific system instructions;
- exact profile-version pinning on every run and recursive-model invocation;
- a workspace-wide specialist directory;
- a distinct workspace-default coordinator pointer;
- durable work assignments to an existing unrelated session;
- direct profile revision;
- organization-level routing lifecycle or adaptation.

Reusable subagent specifications remain templates. They may produce a new agent profile, but they are not the resulting session's identity and do not silently update an existing session.

Prompt notes remain optional dynamic harness context. They do not replace the one required agent profile.

## Goals

- Give every runnable root, delegated, and recursive agent explicit durable purpose.
- Supply exact agent-specific system instructions on every agent model call.
- Preserve the exact profile version and effective system prompt used by every run and recursive-model invocation.
- Keep agent identity separate from tasks, goals, assignments, messages, memories, and current repository state.
- Keep standing purpose separate from finite admitted work.
- Let one-off helpers use concise sealed profile defaults instead of requiring a large authored charter.
- Provide one stable workspace inbound coordinator without making it the root of a new constitutional hierarchy.
- Provide a bounded searchable directory without inserting every agent or prompt into every model context.
- Route repeated work to an existing agent through a durable assignment with cancellation, goals, gates, usage, and terminal delivery.
- Preserve existing creation-family tasks, mailboxes, cancellation, and usage attribution.
- Let agents, their creation-family parents, and workspace owners directly revise future profile behavior without rewriting earlier runs.
- Keep profile, directory metadata, runtime enforcement, and work criteria separate.
- Retain exact actors, reasons, diffs, optional evidence, conflicts, and rollback for adaptive changes.
- Keep dormant, paused, and archived agents inspectable without treating retirement as deletion.
- Preserve local-first operation, explicit uncertainty, outbox semantics, branch history, sync conflicts, and user authority.

## Non-goals

- Sending all agents, profiles, histories, or directory records to every model call.
- Treating the workspace as one merged model identity.
- Keeping agent processes or model connections continuously alive.
- Making purpose text an OS sandbox, capability token, or runtime permission grant.
- Adding a unified agent grant model or representing prompt text as enforceable authority.
- Adding hierarchical assignment budgets, funding reservations, budget transfer, or economic ancestry.
- Adding a generalized proposal, approval, candidate-evaluation, or human-in-the-loop permission system.
- Replacing tasks, goals, gates, memories, prompt notes, skills, or subagent specifications with one profile.
- Changing current family mailbox reach, cancellation trees, root identity, or historical budget attribution.
- Representing initial child work simultaneously as a `Task` and `Assignment`.
- Reviving a blocked model outcome through a waiting-for-user assignment state.
- Requiring every behavioral edit to run a candidate experiment.
- Making a management hierarchy, reparenting, split, merge, succession, or terminal retirement part of the first three stages.
- Adding agent-published RPC, service bindings, an agent-defined application-data plane, per-agent compute, or distributed placement.
- Claiming hosted multi-tenancy, hostile-code isolation, distributed scheduling, or execution-owner failover.
- Letting a profile revision change model configuration, credentials, SDK availability, effect policy, execution limits, or OS authority.
- Physically deleting archived agents through admission, eligibility, or agent-wide archive commands.

## Design principles

### Identity is durable; execution is episodic

An agent is one durable `Session`. Runs, model calls, workers, schedules, and terminal attachments are temporary activity associated with that identity.

### Purpose is explicit and small

Every runnable agent has a profile that answers:

- What role does this agent serve?
- Why does it exist?
- Which exact agent-specific instructions govern its model calls?
- Which profile version governed a particular run?

The profile does not attempt to contain all knowledge, routing state, runtime permissions, or current success criteria.

### Purpose and work are separate

The profile describes who the agent is. A task or assignment describes what it should do now. A goal describes the finite desired state. An `AgentRun` is a bounded attempt to advance that work.

### Quiescence is valid

Durable purpose does not authorize execution. Every ordinary run requires a task, assignment, direct user request, retained family-follow-up message, schedule, or wake accepted through the existing run path.

### Search metadata is not model identity

Names, tags, and routing summaries support central discovery. They do not enter the provider system prompt unless their meaning is deliberately promoted into a new profile version.

### Directory visibility is bounded

Directory access permits bounded discovery. It does not expose conversation history, artifacts, secrets, or unrestricted durable-state mutation.

### Revisions append

Profile versions, directory metadata revisions, and routing decisions remain attributable. Historical runs resolve the exact versions they used.

### Existing mechanisms remain authoritative

Tasks own child creation. Goals and gates own completion. Runs own the action loop. The outbox owns effects. Family mailboxes own family communication. Refinement owns current harness evolution.

New constructs fill missing semantics rather than duplicating those mechanisms.

### Adaptation is direct and reversible

An agent, its creation-family parent, or the workspace owner may directly create and activate a new profile version within its relationship scope. Revision does not require a proposal, reviewer, experiment, or approval queue. Optional evidence and later outcome comparisons support inspection; immutable history and rollback provide the safety mechanism.

## Terms

- **Agent:** One durable `Session`.
- **Agent profile:** The immutable versioned purpose and exact agent-specific system instructions for a session.
- **Agent prompt:** The exact provider-facing text materialized from one profile version.
- **Directory metadata:** Search and routing descriptors attached to an agent but excluded from its system prompt.
- **Agent directory:** A rebuildable central projection combining session identity, profile summaries, directory metadata, assignment eligibility and route, admission state, activity, and bounded evidence.
- **Workspace coordinator:** The agent route that receives ordinary no-ID workspace tasks after Stage 2.
- **Task:** The existing durable relationship through which a parent creates and owns work for a child session.
- **Assignment:** A durable finite work relationship targeting an already-existing agent.
- **Work source:** The task, assignment, direct user request, retained family-follow-up message, schedule, or wake that starts an `AgentRun` through the existing run path.
- **Assignment eligibility:** Whether an agent accepts only creation-family work or may receive workspace assignments.
- **Agent admission state:** Whether an agent may admit new work or is paused.
- **Assignment route:** The exact branch on which an existing agent accepts workspace assignments.
- **Creation ancestry:** The immutable parent, branch, root, depth, and task relationship recorded when a child session is admitted.
- **Workspace agent-control stream:** A narrow workspace-scoped canonical stream used when session-wide revisable profile and coordinator state require ownership independent of conversation branches.

## Simplified domain model

### Agent identity

`Session` remains the executable identity.

This preserves:

- model and provider configuration;
- budget state;
- goals and gates;
- branches and conversation;
- child tasks and family mailboxes;
- runs, contexts, effects, cells, and artifacts;
- schedules, wakes, and recovery;
- current creation ancestry.

No `Agent` row or aggregate sits above `Session`.

### Agent profile

Each newly runnable session has one immutable profile version.

```ts
interface AgentProfileVersion {
  profileVersionId: string;
  agentSessionId: string;
  revision: number;

  role: string;
  purpose: string;
  instructions: string;

  exactAgentPrompt: string;
  promptContractId: "agencity.agent-profile.v1";
  promptDigest: string;

  createdBy: AgentPrincipalReference;
  sourceSpecEntryId: string | null;
  sourceSpecVersionId: string | null;
  reason: string;
  evidenceEventIds: string[];
  supersedesProfileVersionId: string | null;
  restoresProfileVersionId: string | null;
  createdAt: string;
}

type AgentPrincipalReference =
  | { kind: "user"; profileId: string }
  | { kind: "agent"; sessionId: string; branchId: string }
  | { kind: "system"; componentId: string; version: number };
```

The fields are deliberately small:

- `role` is a concise functional label;
- `purpose` explains why the agent exists and the broad work it serves;
- `instructions` contain agent-specific behavior not already covered by immutable runtime policy;
- `exactAgentPrompt` preserves provider-facing historical text independently of future renderer changes.

Responsibilities, exclusions, escalation expectations, and quality principles may be expressed concisely inside `instructions`. They become separately structured fields only if concrete validation or routing requirements justify the added schema.

The profile excludes:

- mutable repository facts;
- current task inputs;
- conversation history;
- retrieved memories;
- current goals and completion gates;
- model and budget configuration;
- credentials and runtime permissions;
- directory tags and routing summaries;
- standing aspirations or portfolio state.

### Profile defaults

Canonical admission always contains a complete profile, but public helpers may materialize one from sealed templates.

Root creation uses a sealed product profile plus explicit user configuration.

One-off delegated and recursive helpers may use a concise task-specialist template:

```text
Role: Task specialist
Purpose: Complete the admitted task within its stated scope.
Instructions:
- Use only the admitted task, context, and available tools.
- Return attributable evidence and unresolved outcomes.
- Do not infer broader standing responsibility from this task.
```

A parent may supply a narrower role, purpose, or instructions. Client ergonomics do not weaken canonical prompt provenance.

### Profile ownership and naming

An agent profile belongs to workspace canonical state and is always exposed as `agentProfile` in runtime and protocol contracts.

The existing profile/device database remains a separate owner for cross-workspace preferences, global skills, device identity, provider configuration, and opaque credential references. Runtime context exposes that state as `userProfile`.

Directory descriptors are exposed as `directoryMetadata`.

No API, context record, or projection uses the unqualified name `profile` when both agent and user/device state are present.

### Exact provider prompt

Every autonomous model request composes system content in this order:

1. immutable Agencity base policy;
2. exact pinned agent prompt;
3. invocation-specific response and run-control contract;
4. invocation-specific execution guidance.

Dynamic task, assignment, conversation, memory, skill, artifact, mailbox, and observation context follows through existing materialization semantics.

Every agent invocation creates one immutable profile pin. The invoking event is:

- `AgentRunRequested` for the ordinary autonomous action loop; or
- `RecursiveModelStarted` for retained recursive-model execution that does not use an `AgentRun`.

The invocation pin records:

- `profileVersionId`;
- `agentPromptDigest`;
- the profile-level immutable component references.

Every `ContextMaterialized` and `ModelCallRequested`, including retries and later steps in the same run, records:

- the invocation kind and ID;
- the invocation-level `profileVersionId`;
- the exact rendered effective-system-prompt digest;
- exact immutable component references;
- model dispatch and invocation-contract versions.

Each call validates that its profile component matches the invocation-level pin. The implementation should reference immutable content rather than duplicate large prompt text across every event.

A profile change during a run or recursive-model execution applies only to later invocations. Every model step in one invocation uses the same pinned profile unless an existing immediate runtime revocation prevents further execution.

### Directory metadata

Directory metadata is session-level product metadata, not profile content.

```ts
interface AgentDirectoryMetadata {
  agentSessionId: string;
  revision: number;
  routingSummary: string;
  tags: string[];
  updatedBy: AgentPrincipalReference;
  reason: string;
  evidenceEventIds: string[];
  updatedAt: string;
}
```

The agent's display name continues to use existing session naming semantics rather than duplicating a name inside the profile or metadata record.

Directory metadata is separate because:

- it must be centrally indexed and paged;
- it may change without changing the model's instructions;
- routing vocabulary may evolve independently of agent behavior;
- a metadata correction should not create a behavioral profile revision;
- owners may curate discovery without implying that the model saw the metadata.

The central directory indexes:

- current session name;
- current profile role and purpose;
- routing summary and tags;
- assignment eligibility, assignment route, and admission state;
- model compatibility and recent usage information;
- current activity and unresolved-work counts;
- bounded attributable outcome summaries;
- exact route links.

The directory projection is rebuildable. User- or agent-authored metadata changes remain canonical events with compare-and-swap revision, reason, and actor provenance.

Routing decisions record the profile version and metadata revision considered. Later metadata edits do not reinterpret an earlier decision.

### Standing knowledge

Stable role-specific knowledge belongs in attributable prompt notes or memory selected through existing harness rules. Large or changing evidence belongs in artifacts and dynamic context.

A fact enters the agent profile only when changing it would materially change the agent's purpose or behavior. This keeps routine knowledge maintenance from becoming a profile-governance operation.

### Runtime policy

Profile language is behavioral instruction. It cannot change runtime configuration. Existing services continue to own:

- model and provider configuration and preflight validation;
- simple run limits and usage reporting;
- goal and gate checks;
- SDK capabilities;
- outbox-backed effects;
- credential brokerage;
- file, shell, and skill executor policy;

Model preflight validation means checking that the selected provider is configured and that the model supports the formal tool contract required by the run. It is a compatibility check, not an authority or approval system.

Durable state changes continue to use typed runtime commands such as creating an assignment, spawning a child, or revising a profile. Model-generated code does not receive direct write access to canonical event history. This protects event validity, replay, and recovery; it is not a confidentiality or hostile-code boundary.

External model, shell, file, and skill work continues through the outbox. Recording the request before execution and recording an explicit outcome after execution prevents crash recovery from blindly repeating uncertain work.

This plan adds neither a unified `AgentGrantVersion` model nor a generalized user-approval system. Missing human information uses the existing blocked `finish` outcome and a later ordinary run. Filesystem and network isolation require a separate sandboxed or fully brokered execution architecture.

## Work model

### Existing child tasks

The current `Task` aggregate remains the source of truth for work that creates a child:

- parent and child identity;
- creation ancestry;
- task text and completion criteria;
- child model and existing execution limits;
- cancellation and usage attribution;
- result and terminal notice;
- retained family follow-up.

Child admission does not also create an assignment.

### Retained family follow-up

Existing authorized family follow-up remains a valid work source after terminal child task work.

- The exact retained mailbox message and family relationship provide provenance.
- The follow-up uses the target session's existing run path and limits.
- Pause or agent-wide archive blocks follow-up before a run begins.
- Cancellation applies to the resulting run under current semantics.
- Follow-up does not create a workspace assignment or grant cross-family rights.

### Assignments to existing agents

Stage 2 adds `Assignment` only for new finite work routed to an already-existing session.

```ts
interface Assignment {
  assignmentId: string;
  sponsor: AgentPrincipalReference;
  targetSessionId: string;
  targetBranchId: string;

  instruction: string;
  inputs: JsonValue;
  artifactIds: string[];
  goalId: string | null;

  consideredProfileVersionId: string;
  consideredDirectoryRevision: number;
  consideredRoutingRevision: number;
  executionProfileVersionId: string | null;
  routingDecisionId: string;

  status:
    | "queued"
    | "running"
    | "succeeded"
    | "blocked"
    | "failed"
    | "cancelled"
    | "budget_exceeded"
    | "unknown";
}
```

The routing decision records the profile, metadata, and routing revisions used to select the target. Assignment claim compares those references with current state, revalidates a changed target, and pins `executionProfileVersionId` before requesting a run. A stale incompatible target fails before model context is delivered.

The exact schema should reference existing goal, gate, usage, and result records rather than copy their state.

### Execution limits and usage

Assignments do not introduce funding sources, reservations, transferred budget, delegation allowances, or economic ancestry. The target run uses the runtime's existing simple runaway limits. Provider and tool usage is recorded once against the resulting run and attributed to the assignment for inspection.

The existing `budget_exceeded` terminal run status remains a compatibility outcome for current runtime limits. This plan does not expand it into a hierarchical budget system.

Assignments reuse:

- `Goal` and completion gates;
- `AgentRun`;
- outbox-backed effects;
- existing run-limit enforcement and usage reporting;
- cancellation semantics;
- artifacts;
- terminal result delivery;
- recovery and idempotency.

### Assignment lifecycle

```text
queued -> running | cancelled | failed
running -> succeeded | blocked | failed | cancelled | budget_exceeded | unknown
```

Terminal states are immutable.

`queued -> failed` records a typed claim rejection such as stale incompatible profile, unavailable route, failed model preflight validation, or archived target.

There is no `waiting_for_sponsor` or resumable pending-input state. A blocked `finish` ends the current run and assignment. Later sponsor input creates a new assignment referencing the blocked result. A user acting directly on the target route may start an ordinary new run under the accepted product contract.

An unknown effect remains unknown. Reconciliation appends evidence but does not invent success or authorize unsafe retry.

### Route selection and serialization

An assignment targets one existing session and its configured exact assignment branch.

Marking an agent workspace-eligible requires an unambiguous existing branch. The owner explicitly selects that branch; the runtime never infers it from creation order, recency, or the current observation route. Changing it is a scoped compare-and-swap update with actor, reason, and provenance.

A durable assignment claimer advances queued work:

- queued assignments are ordered deterministically per target route;
- the claimer waits while the route has an active run rather than asking the run service to queue conflicting admission;
- claim atomically checks assignment route, admission state, eligibility, model preflight validation, and profile integrity;
- claim atomically appends `AssignmentClaimed` and the existing `AgentRunRequested` admission;
- the exact assignment, considered profile, and execution profile references enter target context;
- claim rejection commits `queued -> failed` with a typed reason before model context delivery;
- recovery scans queued and claimed assignments and resumes the same identities without duplicate model calls or usage.

### Assignment scope

An assignment carries only the state needed to:

- create work for an eligible target;
- provide assignment-scoped inputs and artifacts;
- request cancellation;
- receive the terminal result.

An assignment does not create:

- general mailbox reach;
- profile revision;
- task-family parenthood;
- child cancellation-tree control;
- target history access;
- runtime-configuration changes.

Existing family messages remain governed by creation-family relationships.

## Workspace coordinator

Stage 2 designates one workspace-default coordinator route.

The coordinator:

- receives ordinary no-ID tasks;
- queries bounded directory summaries;
- records considered candidates and routing reasons;
- routes to an eligible existing agent through an assignment;
- creates a child through existing task admission when no existing agent fits;
- reports a blocked outcome when required information is missing or no valid route exists.

The coordinator does not:

- become the creation or managing parent of every agent;
- receive every agent's history;
- gain unrestricted artifacts, secrets, effects, runtime configuration, or deletion rights;
- require a separate succession ceremony.

Changing the coordinator is an explicit user-authorized pointer change. It does not rewrite creation ancestry, transfer child ownership, or reparent agents.

The remembered observation route remains a profile preference. It is not the coordinator pointer and does not change inbound routing.

## Directory and routing

### Directory projection

The Stage 2 directory is a revisioned, paged, rebuildable workspace projection. It combines:

- session and route identity;
- current session name;
- current profile ID, role, purpose, and prompt digest;
- directory metadata revision, summary, and tags;
- assignment eligibility, assignment route, and admission state;
- activity and unresolved work;
- model compatibility;
- bounded usage and outcome summaries;
- creation parent and root;
- exact navigation links.

Full prompt text, conversation history, artifacts, effects, and detailed evidence require exact authorized lookups. They are not embedded in ordinary directory pages.

### Assignment eligibility, route, and admission

Workspace assignment eligibility is separate from execution admission and existing `SessionStatus`.

```ts
interface AgentRoutingState {
  agentSessionId: string;
  revision: number;
  assignmentEligibility: "family_only" | "workspace";
  assignmentBranchId: string | null;
  admissionState: "enabled" | "paused";
  archiveState: "active" | "archived";
}
```

- `family_only` preserves existing creation-family follow-up but rejects unrelated workspace assignments.
- `workspace` permits assignments only on the exact configured `assignmentBranchId`.
- `enabled` admits work allowed by the current eligibility, session status, schedule, wake, and model preflight rules.
- `paused` blocks new assignments, family follow-up runs, schedules, wakes, and direct user runs until explicit resume.
- `archived` is a session-wide admission barrier that excludes the agent from default routing and selection while preserving explicit historical inspection.

New one-off children default to `family_only`, no assignment branch, `enabled`, and `active`. Explicit owner action may select a branch and change a proven specialist to `workspace`.

The workspace agent-control stream owns `archiveState` because current `SessionStatusChanged` events are branch-addressed operational state and cannot enforce an agent-wide archive across every branch. Every new direct run, assignment, family follow-up, schedule, wake, and spawn boundary checks the agent-wide archive barrier.

Archive activation requires the agent to be paused and quiescent: admitted runs and assignments are terminal, pending cancellation has reconciled, runtime-owned wakes and schedules cannot fire, and every started external effect has a terminal or explicit unknown outcome. Archive never blocks recovery, effect reconciliation, late outcome evidence, sync conflict handling, export, or deletion planning for already-committed work.

Existing `SessionStatus.archived` remains a legacy branch operational value until a separately reviewed cleanup removes or narrows it. It is not sufficient authority for the new agent-wide archive.

Stage 2 adds an explicit user-authorized restore action. Restoration appends a new agent-wide archive-state event and never rewrites history.

Terminal retirement and successor-only restoration remain deferred until a concrete product or compliance requirement justifies irreversible identity semantics.

### Routing evidence

The coordinator considers:

- profile role and purpose;
- directory tags and routing summary;
- assignment eligibility, configured assignment route, admission state, and session status;
- task-required model or tool compatibility;
- attributable prior outcomes;
- current queue and recent usage;
- unresolved effects or missing dependencies;
- user constraints.

Names and recency alone are insufficient routing evidence.

Each routing decision retains:

- considered candidate session IDs;
- candidate profile and directory revisions;
- selected target or creation decision;
- bounded reasons;
- task requirements;
- unresolved uncertainty.

## Profile and routing changes

### Direct profile revision

Profile revision is an ordinary typed durable-state operation:

1. The caller supplies the expected current profile version, replacement role, purpose, instructions, and a bounded reason.
2. The runtime validates shape, size, secret rejection, prompt rendering, and the expected-version comparison.
3. One transaction creates the immutable profile version and makes it active for future invocations.
4. A run or recursive-model invocation already in progress keeps its pinned profile.

An agent may revise its own profile. An active creation-family parent may revise a direct child's profile. The workspace owner may revise any workspace agent profile. Siblings and unrelated agents cannot revise one another.

These operations do not require a proposal, reviewer, human approval, candidate allocation, or evaluation result. They cannot change model or provider configuration, credentials, SDK operations, effect policy, execution limits, or operating-system authority because those values are not profile fields.

### Directory and routing changes

An agent may directly update its own directory metadata, and an active creation-family parent may update a direct child's metadata. The workspace owner may update any agent's metadata. Metadata updates use an expected revision, actor, reason, and optional evidence references.

Workspace assignment eligibility, assignment route, coordinator selection, pause, archive, and restore remain explicit owner actions. They are direct configuration changes, not approval decisions over agent proposals. Agents and parents do not need proposal APIs for these operations. If autonomous routing control later has a concrete use case, it receives a separate design based on the enforcement actually required.

### Rollback and observation

Rollback creates and activates a new profile version whose content matches an exact prior version. It records the actor, reason, prior active version, and restored source version without deleting intervening history.

Evidence references are optional provenance, not an activation prerequisite. Operators and agents may compare completion outcomes, corrections, unresolved effects, usage, latency, handoff quality, or task-specific evidence after a revision. Observation may motivate another direct revision or rollback; it does not create a governance state machine.

Current refinement remains authoritative for memory, prompt-note, skill, and subagent-spec changes. Profile revision does not reuse refinement proposal, candidate, exposure, or decision records.

## Workspace agent-control state

### Why workspace-scoped state may be required

Profile activation and coordinator selection are session- or workspace-wide meanings. They should not depend on which conversation branch happens to receive an event.

The implementation has two acceptable Stage 1 paths:

1. keep the creation profile immutable and store it with `SessionCreated`, avoiding a new stream until revision exists; or
2. accept the event-schema cutover and introduce the narrow workspace agent-control stream from the start.

The domain review must choose one path before implementation. It must not disguise workspace authority as an arbitrary operator conversation branch.

Stage 3 direct profile revision requires canonical session-wide version ownership. At that point, a narrow workspace agent-control stream is the preferred end state.

### Narrow ownership

The workspace agent-control stream owns only:

- workspace coordinator pointer;
- profile versions and active profile pointers;
- directory metadata revisions;
- assignment eligibility, assignment route, admission state, and agent-wide archive state;

It does not own:

- conversation;
- model context;
- cells or working values;
- effects;
- goals and gates;
- child tasks and family mailboxes;
- assignment target execution;
- harness refinement;
- branch history.

### Revision model

Mutations use the narrowest applicable compare-and-swap:

- coordinator changes compare `coordinatorRevision`;
- profile activation compares the target agent's current `profileVersionId`;
- directory metadata compares the target agent's `directoryMetadataRevision`;
- assignment eligibility, route, admission, and archive changes compare the target agent's `routingRevision`;

The workspace stream cursor supports consistent paging and snapshots. It is not a global mutation CAS that makes unrelated agent edits conflict.

It does not add:

- one workspace-wide expected revision for every command;
- separate head and stable organization revisions;
- admission-lock records;
- multi-step organization transitions;
- management-edge closure validation;
- governance-owner transfer.

Local transactions commit pointer changes atomically. Multi-step external work remains represented by ordinary runs and outbox effects rather than a second transition engine.

If later irreversible multi-agent operations require stable-pointer staging and admission locks, those constructs receive a separate readiness review.

### Branch semantics

The profile belongs to the session identity, not one conversation branch.

Historical runs retain their pinned profile. New runs on any branch use the current active session profile after transactional revision checks.

This means a branch is a counterfactual conversation history, not a fork of agent identity. Testing a different persistent profile uses a new version with rollback or a separate agent identity rather than silently diverging a branch-local profile.

## Canonical events and projections

Exact event shapes require domain review. The simplified end state needs a substantially smaller event surface than the previous city model.

### Candidate events

Workspace agent-control events:

- `WorkspaceAgentsInitialized`;
- `WorkspaceCoordinatorSelected`;
- `AgentProfileVersionCreated`;
- `AgentProfileActivated`;
- `AgentDirectoryMetadataChanged`;
- `AgentRoutingStateChanged`;

Assignment events:

- `AssignmentCreated`;
- `AssignmentClaimed`;
- `AssignmentStatusChanged`;
- `AssignmentTerminalNoticeDelivered`.

Existing events remain authoritative for:

- session and branch identity;
- tasks and subagent admission;
- goals and gates;
- runs and model calls;
- contexts;
- effects and reconciliation;
- usage and budgets;
- family messaging;
- harness refinement.

Events may be consolidated when one immutable transition carries complete durable meaning. Event names are not accepted until reducers, idempotency, recovery, and projection ownership are reviewed.

### Stream addressing

If the workspace agent-control stream is introduced, the canonical event header gains explicit addressing without adding a second event table:

```ts
type EventStreamAddress =
  | { kind: "workspace-agents"; workspaceId: string }
  | { kind: "agent-route"; workspaceId: string; sessionId: string; branchId: string };
```

The existing `events` table remains the globally ordered canonical history.

This is a pre-release schema cutover. Older schemas fail closed before decode, projection, sync ingestion, or recovery unless a separately reviewed importer exists. Retained events are never reinterpreted silently.

### Projections

New rebuildable projections are limited to:

- `workspace_agent_state`;
- `agent_profile_versions`;
- `agent_directory_metadata`;
- `agent_directory`;
- `assignments`;

The implementation should reuse existing session, branch, task, goal, run, budget, and activity projections rather than copy their data.

All new tables require classification in `docs/mutable-tables.md`, architecture checks, replay tests, and idempotent rebuild behavior.

## Protocol and SDK

The public contract should expose capabilities rather than mirror every internal event.

### Product protocol

Illustrative operations:

```http
GET  /product/agents
GET  /product/agents/:session
GET  /product/agents/:session/profiles
GET  /product/assignments
GET  /product/assignments/:assignment

POST /product/coordinator
POST /product/agents/:session/assign
POST /product/agents/:session/profiles
POST /product/agents/:session/directory-metadata
POST /product/agents/:session/routing
POST /product/agents/:session/pause
POST /product/agents/:session/resume
POST /product/agents/:session/archive
POST /product/agents/:session/restore
POST /product/agents/:session/profiles/rollback
```

Exact paths may be consolidated.

The contract preserves:

- exact IDs and revisions;
- paging;
- profile versus metadata distinction;
- active versus archived inclusion;
- no mutation from read or navigation calls;
- typed unavailable, stale, and conflict outcomes;
- bounded prompt and evidence payloads.

### Console SDK

Generated TypeScript receives capability-scoped operations:

```ts
sdk.agents.list(options?)
sdk.agents.get(target, options?)
sdk.agents.assign(target, input)
sdk.agents.updateProfile(target, input)
sdk.agents.rollbackProfile(target, input)
sdk.agents.updateDirectoryMetadata(target, input)

sdk.agents.spawn({ task, profile?, ... })
sdk.agents.spawnMany(inputs)
```

The executing session and branch supply actor identity. Generated code cannot spoof a user identity, parent relationship, evidence source, or current revision. Profile and metadata commands accept only the executing agent or its direct creation-family child as a target.

Routing, coordinator, pause, archive, and restore mutations remain owner-facing protocol or trusted TypeScript API operations. They are direct configuration changes rather than decisions on an agent-authored proposal.

Existing `rlm.start` and `rlm.startMany` may accept an explicit profile or use the sealed task-specialist helper. The retained child always has exact profile and prompt provenance.

## Terminal product

### Agents view

The current route and family views remain based on conversation and creation ancestry.

The directory adds a separate workspace mode showing:

- session name;
- role and purpose;
- tags and routing summary;
- assignment eligibility, assignment route, and admission state;
- current activity;
- current profile version;
- exact route links;
- unresolved-work and evidence summaries.

Archive filtering is a directory concern. Route history never disappears merely because an agent is archived.

### Agent detail

Agent detail shows:

- current profile and exact agent prompt;
- profile history and diffs;
- directory metadata and revision;
- creation ancestry;
- current routes, tasks, assignments, and runs;
- routing decisions and bounded evidence;
- pause and archive history;
- unresolved effects and missing dependencies.

Navigation is observational. Profile revision, metadata updates, assignment, pause, and archive use explicit typed actions. Profile history exposes actor, reason, exact diff, optional evidence, and rollback.

### Coordinator visibility

The coordinator receives a small directory summary and typed query methods. It does not receive every full prompt or conversation automatically.

Other agents receive:

- their own profile and metadata;
- current direct-child profile summaries where existing family authority permits;
- bounded directory summaries needed for an authorized assignment or handoff.

## Security and trust boundary

The runtime remains trusted-local.

- Model-generated TypeScript and shell commands retain the OS authority of the runtime process.
- Agent profiles and directory scope are behavioral controls, not hostile-code isolation.
- Directory access is not a confidentiality boundary.
- The coordinator cannot read raw credential values.
- Profile or metadata text cannot change model configuration, credentials, SDK operations, effect policy, execution limits, or publication configuration.
- Known-value rejection, credential stripping, bounded diagnostics, and exact provenance apply to profile and metadata admission.
- Hostile multi-agent or multi-tenant operation requires a separate authenticated and isolated deployment architecture.

New UI and documentation must not imply that routing tags, profile instructions, or typed runtime commands sandbox local code.

## Retention, export, and deletion

### Retention

Retained state includes:

- every profile version, exact agent prompt, and digest;
- every run-to-profile and effective-prompt pin;
- directory metadata revisions;
- coordinator pointer changes;
- assignment eligibility, assignment-route, admission-state, and archive changes;
- assignments, results, usage, and terminal notices;
- profile and metadata revision actors, reasons, optional evidence, conflicts, and rollback activations;
- existing session, branch, task, mailbox, goal, effect, context, and artifact provenance.

### Export

Workspace export includes all active and historical profile, metadata, routing, and assignment records plus referenced artifacts and existing canonical history.

An export that omits a profile version or effective-prompt component required to explain a model call is incomplete.

### Archive and deletion

Archive removes an agent from default directory routing. It does not delete canonical events, artifacts, tasks, mailboxes, assignments, or evidence.

Physical deletion remains a separate guarded owned-scope operation. Narrow agent deletion is unavailable when retained references would dangle. The planner reports dependencies rather than silently cascading.

## Migration and compatibility

### Fresh workspaces

A fresh workspace creates:

1. a root session and route;
2. an explicit usable model;
3. one sealed initial agent profile;
4. exact prompt provenance before the first autonomous run.

Stage 2 additionally designates the workspace coordinator and initializes directory metadata.

### Existing workspaces

The implementation follows the repository's pre-release compatibility policy.

If the event-header schema changes, older workspaces fail closed under reset guidance. A separately reviewed importer may preserve old work as historical state, but it must not infer a definitive historical agent prompt from task text.

Potentially runnable imported sessions require an explicitly confirmed profile before new work. Ended legacy sessions remain inspectable with historical-unknown profile provenance.

No migration rewrites retained event rows or silently interprets an initial task as a system instruction.

## Delivery sequence

### Phase 0 — Domain and evidence review

- Confirm the thin profile fields and exact rendering contract.
- Decide whether Stage 1 stores one immutable creation profile or immediately introduces workspace stream addressing.
- Define the Stage 1 adoption and quality signals.
- Define profile, prompt-note, subagent-spec, directory-metadata, and runtime-policy boundaries.
- Add an ADR for durable agent profiles.

### Phase 1 — Stage 1 durable profiles

- Add profile validation, bounds, secret rejection, and deterministic prompt rendering.
- Require one materialized profile for new roots and children.
- Add sealed root and task-specialist templates.
- Make subagent specifications materialize profiles with exact source provenance.
- Compose and pin the profile on every autonomous run.
- Add owner-facing profile inspection.
- Add replay, prompt-digest, compaction, recovery, and child-admission tests.

### Phase 2 — Stage 2 directory and coordinator

This phase starts after Stage 1 evidence passes its advancement gate.

- Add or activate the narrow workspace agent-control stream.
- Add the coordinator pointer separately from remembered observation state.
- Add canonical directory metadata revisions.
- Build the rebuildable directory projection over existing session and activity state.
- Add explicit assignment eligibility, assignment-route, pause/resume, archive, and restore controls.
- Add agent-wide archive state to the workspace agent-control stream and treat branch `SessionStatus.archived` as legacy operational state.
- Add bounded directory queries and retained routing decisions.
- Add product and TUI directory surfaces.

### Phase 3 — Stage 2 existing-agent assignments

- Add assignments only for existing-session work.
- Preserve existing `Task` and family semantics for child creation.
- Reuse goals, gates, runs, effects, usage, cancellation, and terminal delivery.
- Record the routing profile at assignment admission; revalidate and pin the execution profile at assignment claim.
- Queue through the durable assignment claimer; admit through the existing run service only after the route is idle.
- Add cross-family sponsor/result bridges without general messaging.
- Add restart, duplicate, run-limit, cancellation, blocked, and unknown-outcome tests.

### Phase 4 — Stage 3 direct profile adaptation

This phase starts after durable profiles have demonstrated useful specialist identity.

- Add direct self, direct-child, and owner profile revision commands.
- Create and activate each version atomically for future invocations.
- Add direct self, direct-child, and owner directory-metadata updates.
- Retain actor, reason, exact diff, optional evidence, and expected-version conflicts.
- Add rollback through a new immutable activation.
- Do not add proposal, approval, candidate-exposure, or automatic-review machinery.

### Phase 5 — Product hardening

- Add installed-product journeys for specialist creation, reuse, revision, pause, archive, restart, and inspection.
- Add directory paging and warm-refresh benchmarks.
- Add sync divergence, export, and deletion-plan coverage.
- Update public protocol, API, user, operator, recovery, security, capability, event, mutable-table, data-lifecycle, and verification documentation.
- Update `AGENTS.md` only for capabilities that actually ship.

### Deferred organization readiness review

The following require a new readiness review and are not implicit Phase 6 work:

- management hierarchy separate from creation ancestry;
- reparenting;
- split and merge transactions;
- terminal retirement and successor-only restoration;
- operator succession beyond an explicit pointer change;
- dual head/stable organization revisions;
- admission locks and multi-step organization transitions;
- cross-device governance ownership transfer.

## Test plan

### Profile identity

- Root and child runs cannot begin without a valid materialized profile.
- Recursive-model execution cannot begin without an invocation-level profile pin.
- Public task-specialist helpers produce complete canonical profiles.
- Profile rendering and digest are deterministic.
- Exact profile text survives source-code renderer changes.
- Secret-bearing profile content is rejected without echoing the secret.
- Specification spawn records exact specification and profile versions.
- Idempotency-key reuse with different profile meaning conflicts.

### Model context

- Every agent model call contains base policy, pinned profile, invocation contract, and execution guidance in fixed order.
- Every context and model-call attempt records its run or recursive invocation profile pin, exact effective prompt digest, and immutable component references.
- Retries and later steps validate against the same invocation profile pin while retaining their invocation-specific prompt content.
- Each effective prompt digest matches provider-facing content.
- Profile revisions never change an active run.
- Later runs use the newly active profile.
- Compaction preserves exact profile and effective-prompt references.
- Recovery after context, model request, or effect commit does not rematerialize with a different profile.

### Directory metadata

- Session name, profile purpose, tags, and routing summary are centrally searchable.
- Metadata changes do not alter the agent prompt or profile version.
- Profile changes do not silently rewrite manual metadata.
- Routing decisions retain exact profile and metadata revisions.
- Full prompt text is absent from ordinary list pages.
- Directory rebuild reproduces the same current entries.

### Tasks and assignments

- Child creation creates one task and no assignment.
- Existing-agent routing creates one assignment and no creation task.
- Goals, gates, run usage, and effects are not double counted.
- Assignments create no funding source, reservation, transfer, or economic ancestry.
- Provider and tool usage is recorded once against the resulting run and attributed to the assignment.
- Busy routes leave later assignments queued; the durable claimer admits one run only after the route becomes idle.
- Claim atomically pins the execution profile and requests the run.
- Invalid queued work reaches typed terminal claim rejection without model context delivery.
- Blocked assignments are terminal and never enter a pending-input state.
- Later sponsor input creates a new assignment with a reference to the prior outcome.
- Direct user input on the target route may create an ordinary new run.
- Unknown effects remain visible and are never retried unsafely.
- Cross-family assignment rights cannot be used for general messaging or profile mutation.

### Routing lifecycle

- `family_only` agents remain usable through current family follow-up but cannot receive unrelated assignments.
- `workspace`-eligible agents accept assignments only on their exact configured assignment branch.
- Paused agents reject assignments, direct user runs, follow-up runs, schedules, and wakes.
- Agent-wide archive blocks new direct runs, assignments, follow-up, schedules, wakes, and spawn on every branch.
- Archive requires paused quiescence and always permits recovery and reconciliation of previously committed work.
- Archived agents are excluded from default directory routing and remain explicitly inspectable.
- Explicit restoration appends provenance and never rewrites archived history.
- Assignment eligibility, admission state, and agent-wide archive remain distinct from branch operational `SessionStatus`.

### Direct adaptation

- An agent can directly create and activate a new version of its own profile for future invocations.
- A parent can directly revise a creation-family child's profile.
- The owner can directly revise any workspace agent profile.
- Siblings and unrelated agents cannot revise one another.
- Profile revisions cannot change runtime configuration because those fields are absent from the profile contract.
- Revision requires no proposal, approval, candidate exposure, or evaluation result.
- Rollback restores exact prior content through a new immutable profile version.
- Concurrent revisions conflict through the expected current profile version.

### Branch, recovery, and sync

- Historical runs resolve their original profile after later revisions.
- New work on any branch resolves the current session profile.
- Branch forks do not duplicate session identity.
- Workspace eligibility requires one explicit assignment branch and never follows the remembered observation route implicitly.
- Changing the assignment branch uses the target agent's routing revision and does not reinterpret prior assignments.
- Crash boundaries do not duplicate profiles, assignments, runs, effects, or usage.
- Concurrent profile, metadata, or routing edits conflict rather than use last-write-wins.
- Non-owner or divergent sync state never silently chooses an active profile.

### Installed product

A linked executable journey must:

1. create a fresh root with an exact profile;
2. complete work and display the pinned profile;
3. create a child with a concise materialized profile;
4. show the child in the directory;
5. select an exact assignment branch and mark a proven child workspace-eligible;
6. route a second task to that existing child through one assignment;
7. retain assignment gates, usage, result, and routing evidence;
8. revise the child's profile and prove old and new run pins;
9. pause and archive the child without deleting history;
10. detach, restart, and reproduce the same profiles, directory, assignments, and outcomes without duplicate work.

The journey uses only the documented executable and public protocol-backed terminal product.

## Performance and bounds

The implementation defines and tests bounds for:

- profile encoded bytes;
- directory metadata bytes and tag count;
- directory page size;
- agents eligible for routing;
- routing candidates considered;
- queued assignments per route and workspace;
- assignment input, steering, and result payloads;
- profile and metadata revision rate;
- retained evidence references;
- full-prompt detail requests.

Directory summaries never embed full prompts or conversation histories. Warm refresh reuses unchanged projections.

## Risks and safeguards

### Profile accumulation

Profiles can become knowledge dumps. Small structured fields, byte bounds, and separation from memory, prompt notes, goals, and directory metadata keep the prompt focused.

### Metadata drift

Routing summaries can diverge from actual behavior. Routing decisions pin metadata revisions, outcome evidence remains attributable, and later revisions can correct drift. Metadata never silently changes the model prompt.

### Prompt causality overclaim

An exact profile improves provenance but does not prove that prompt text caused an outcome. Evaluation considers model, provider, dynamic context, task mix, tools, and stochastic behavior.

### Coordinator bottleneck

One inbound coordinator may add latency or routing error. Routing evidence, bounded candidate queries, explicit direct addressing, and measured handoff outcomes make the bottleneck visible. The coordinator remains a replaceable pointer rather than a constitutional authority root.

### Assignment duplication

Tasks and assignments can double represent work. Domain validation prohibits an assignment for initial child creation and records usage once against the resulting run.

### Organizational overreach

Useful specialist reuse can be mistaken for a need to model a full company. Stage gates prevent reparenting, split, merge, succession, and automatic restructuring from entering the architecture without evidence.

### Configuration illusion

Profile prose can claim configuration or isolation that it does not control. Product surfaces label profile text as behavioral instruction, model preflight remains a compatibility check, and actual runtime configuration stays in the services that own it.

### Global-context illusion

Directory access can be mistaken for omniscience. Queries are bounded, full details require explicit lookup, and visibility does not grant history or effect authority.

### Cross-device conflict

Offline writers cannot silently share one active profile pointer. Compare-and-swap revisions and existing sync conflict handling preserve divergent claims explicitly.

## Completion criteria

The plan's core product direction is complete when:

1. Every newly runnable agent has one exact durable profile.
2. Every autonomous run and recursive-model call records its invocation profile pin and exact effective system prompt.
3. One-off child admission remains concise through sealed profile helpers.
4. Directory metadata is centrally searchable without becoming model prompt content.
5. The workspace coordinator and remembered observation route remain distinct.
6. Repeated work reaches an existing agent through one assignment rather than an unscoped message.
7. Child creation continues to use one task without duplicate assignment or usage attribution.
8. Agent purpose, directory metadata, runtime policy, and work criteria remain separate.
9. Blocked work remains terminal under the accepted formal model contract.
10. Profile revisions are direct, versioned, conflict-checked, and reversible without a proposal or approval workflow.
11. Profile text cannot change runtime configuration or claim sandbox guarantees.
12. Dormant agents consume no execution capacity merely because their identity persists.
13. Paused and archived agents receive no ordinary new work and retain inspectable history.
14. Restart, branch, sync, export, and deletion behavior preserve profile, assignment, and routing provenance.
15. The installed terminal journey demonstrates specialist creation, reuse, revision, pause, archive, detach, and resume without internal IDs.
16. Public documentation and `AGENTS.md` describe shipped stages and remaining limits accurately.
17. Typecheck, architecture checks, deterministic tests, and acceptance pass; gated external checks are reported separately.

## Deferred extensions

- Independent management hierarchy and reparenting.
- Split, merge, and successor state machines.
- Terminal retirement distinct from reversible archive.
- Cross-workspace or profile-level agents.
- Hosted multi-tenant organizations.
- Distributed organization ownership and failover.
- Agent-published typed RPC and stable service aliases.
- Shared canonical application-data planes.
- Per-agent isolated compute or managed databases.
- Distributed agent placement.
- Embedding-based semantic directory search.
- Automatic physical garbage collection of archived histories.
- Autonomous coordinator replacement.

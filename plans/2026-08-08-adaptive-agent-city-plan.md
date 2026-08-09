# Durable agent profiles and direct adaptation plan

**Status:** Proposed and gated
**Date:** August 8, 2026
**Last revised:** August 9, 2026
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)
**Related plans:** [Workspace Agents view](./2026-08-08-workspace-agents-view-plan.md), [Ergonomic agent-family navigation](./2026-08-07-ergonomic-agent-family-navigation-plan.md), and [Lossless context-reference storage](./2026-08-07-lossless-context-references-plan.md)
**Related decision:** [Durable agent relationships](../docs/decisions/0006-durable-agent-relationships.md)

## Summary

Agencity should retain the exact purpose and agent-specific instructions of every runnable session. A durable agent profile makes that purpose explicit, pins it to each model invocation, and allows future behavior to change through immutable, attributable, reversible versions.

This plan adds one focused capability:

1. every runnable `Session` has one durable profile;
2. every autonomous run and recursive-model invocation pins the exact profile and effective system prompt it uses;
3. an agent, its creation-family parent, or the workspace owner may directly revise the profile for future invocations;
4. revisions use validation, immutable history, compare-and-swap conflict detection, and rollback rather than proposal or approval workflows.

`Session` remains the only executable agent identity. The plan does not add assignments, a workspace coordinator, a specialist directory, workspace routing, a management hierarchy, or an `Agent` aggregate above `Session`.

The existing root-and-child model remains the complete work topology for this scope. A selected root receives user work, handles it directly, delegates by creating a child through the existing `Task` mechanism, or follows up with an existing creation-family child through the existing mailbox path.

## Product decision

The durable value in an agent is its retained identity, history, and exact behavioral instructions. That value does not require an organization control plane.

The product therefore separates:

- **identity and standing behavior:** the durable session profile;
- **finite work:** direct user requests, child tasks, retained family follow-up, schedules, and wakes;
- **completion:** goals, gates, and typed run outcomes;
- **runtime authority:** typed SDK operations, effect policy, credentials, limits, and trusted-local process authority;
- **knowledge:** memories, prompt notes, skills, artifacts, and dynamic context.

The profile answers who the agent is and how it should generally behave. It does not become a container for all agent state.

## Why this plan is narrower

The runtime already supports durable root and child sessions, retained family relationships, delegation, follow-up, goals, gates, effects, recovery, and human-readable root selection. Those mechanisms are sufficient for the initial product.

Cross-family reuse of an existing specialist is deferred. The initial product does not need:

- work assignments to unrelated existing sessions;
- a queue or claimer for such assignments;
- a workspace-default coordinator distinct from the selected root;
- workspace eligibility or assignment-route flags;
- a central routing directory;
- retained routing decisions;
- a new pause, archive, or admission model created solely for routing.

If installed-product evidence later shows repeated, valuable cross-family specialist reuse, a new review should first consider extending the existing `Task` or message model. A separate `Assignment` aggregate is justified only if materially different ownership, queuing, cancellation, result-delivery, or recovery semantics cannot fit those mechanisms cleanly.

## Root behavior

A workspace may contain multiple independent root sessions. Each root owns one creation-family tree. There is no single parent above all workspace roots.

The product's remembered root selection determines which root receives an ordinary no-ID user task. That root already acts as the coordinator for its own tree:

1. receive the user task;
2. perform the work directly; or
3. create a child through the existing durable `Task` path; or
4. send an authorized follow-up to an existing child in its creation family; or
5. finish blocked, failed, or successful through the existing typed model contract.

No new coordinator role, pointer, system prompt, authority, or routing pass is required. Opening another root for inspection or explicitly selecting another root changes the product's remembered route through existing selection behavior.

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
- product branch discovery, human-readable selection, and remembered root routes.

The runtime does not currently provide:

- required per-session agent-specific system instructions;
- exact profile-version pinning on every autonomous run and recursive-model invocation;
- direct profile revision.

Reusable subagent specifications remain templates. They may produce an initial agent profile, but they are not the resulting session's durable identity and do not silently update an existing session.

Prompt notes remain optional dynamic harness context. They do not replace the one required agent profile.

## Goals

- Give every runnable root, delegated child, and recursive agent explicit durable purpose.
- Supply exact agent-specific system instructions on every agent model call.
- Preserve the exact profile version and effective system prompt used by every run and recursive-model invocation.
- Keep `Session` as the only executable agent identity.
- Keep standing purpose separate from current tasks, goals, messages, memories, and repository state.
- Let one-off helpers use concise sealed defaults instead of requiring authored charters.
- Let an agent, its direct creation-family parent, or the workspace owner directly revise future profile behavior.
- Retain exact actors, reasons, diffs, optional evidence, conflicts, and rollback.
- Preserve local-first operation, explicit uncertainty, outbox semantics, branch history, sync conflicts, and user authority.
- Avoid making speculative organization machinery a dependency of durable identity.

## Non-goals

- Adding assignments or routing work to unrelated existing agents.
- Adding a workspace coordinator distinct from existing root selection.
- Adding a workspace-wide specialist directory.
- Adding routing eligibility, assignment branches, or assignment queues.
- Treating the workspace as one merged model identity.
- Keeping agent processes or model connections continuously alive.
- Adding a management hierarchy, reparenting, split, merge, succession, or retirement model.
- Replacing tasks, goals, gates, memories, prompt notes, skills, or subagent specifications with one profile.
- Treating profile text as an OS sandbox, capability token, runtime grant, model configuration, or approval.
- Changing current family mailbox reach, cancellation trees, root identity, or historical budget attribution.
- Requiring a proposal, reviewer, candidate experiment, or approval before a profile revision.
- Claiming hosted multi-tenancy, hostile-code isolation, distributed scheduling, or execution-owner failover.
- Physically deleting an agent through profile revision or archive behavior.

## Design principles

### Identity is durable; execution is episodic

An agent is one durable `Session`. Runs, model calls, workers, schedules, and terminal attachments are temporary activity associated with that identity.

### Purpose is explicit and small

Every runnable agent has a profile that answers:

- What role does this agent serve?
- Why does it exist?
- Which exact agent-specific instructions govern its model calls?
- Which profile version governed a particular invocation?

The profile does not contain all knowledge, current success criteria, runtime permissions, or mutable repository facts.

### Purpose and work are separate

The profile describes who the agent is. A direct request or child `Task` describes what it should do now. A goal describes the finite desired state. An `AgentRun` is a bounded attempt to advance that work.

### Roots coordinate their own trees

A root needs no special coordinator abstraction to choose between direct work and child delegation. Multiple workspace roots remain independent durable work trees selected through the existing product flow.

### Quiescence is valid

Durable purpose does not authorize execution. Every run still requires a direct user request, task, retained family-follow-up message, schedule, or wake accepted through the existing run path.

### Revisions append

Profile versions and activation changes remain attributable. Historical invocations resolve the exact versions they used.

### Adaptation is direct and reversible

An authorized actor may directly create and activate a new profile version. Validation, immutable history, bounded evidence, conflict detection, and rollback provide the control model. Profile changes do not require a proposal or approval state machine.

### Runtime services remain authoritative

Profiles influence model behavior only. Runtime services continue to own model configuration, credentials, limits, goals, gates, SDK capabilities, effects, and operating-system authority.

## Terms

- **Agent:** One durable `Session`.
- **Agent profile:** The immutable versioned purpose and exact agent-specific system instructions for a session.
- **Agent prompt:** The exact provider-facing profile text materialized from one profile version.
- **Invocation profile pin:** The profile version and prompt digest fixed when an autonomous run or recursive-model invocation begins.
- **Effective system prompt:** The complete provider-facing system content assembled from runtime policy, the pinned agent prompt, and invocation-specific contracts and guidance.
- **Root:** A session without a creation-family parent. A workspace may contain multiple roots.
- **Task:** The existing durable relationship through which a parent creates and owns work for a child session.
- **Work source:** A direct user request, task, retained family-follow-up message, schedule, or wake that starts an `AgentRun`.
- **Workspace agent-control stream:** A narrow canonical workspace-scoped stream that owns session-wide profile versions and active profile pointers independently of conversation branches.

## Domain model

### Agent identity

`Session` remains the executable identity and continues to own:

- model and provider configuration;
- budget state;
- goals and gates;
- branches and conversation;
- child tasks and family mailboxes;
- runs, contexts, effects, cells, and artifacts;
- schedules, wakes, and recovery;
- creation ancestry.

No `Agent` row or aggregate sits above `Session`.

### Agent profile

Each newly runnable session has one active immutable profile version.

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

The fields remain deliberately small:

- `role` is a concise functional label;
- `purpose` explains why the agent exists and the broad work it serves;
- `instructions` contain agent-specific behavior not already covered by immutable runtime policy;
- `exactAgentPrompt` preserves historical provider-facing text independently of future renderer changes.

Responsibilities, exclusions, escalation expectations, and quality principles may be expressed concisely inside `instructions`. They become separate structured fields only when concrete validation needs justify the added schema.

The profile excludes:

- mutable repository facts;
- current task inputs;
- conversation history;
- retrieved memories;
- current goals and completion gates;
- model and budget configuration;
- credentials and runtime permissions;
- routing or queue state;
- standing portfolio state.

### Optional discovery metadata

The initial product does not need a central specialist directory. If human-facing agent search needs small descriptors such as tags or a summary, they may be stored as prompt-excluded fields beside the profile version.

Prompt-excluded fields:

- may be shown or searched by owner-facing product surfaces;
- do not enter `exactAgentPrompt`;
- do not imply routing eligibility or runtime authority;
- do not require a separate versioned aggregate until independent ownership or update cadence is demonstrated.

The session's existing name remains the display name.

### Profile defaults

Canonical admission always contains a complete profile. Public helpers may materialize one from sealed templates.

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

### Naming

The agent profile belongs to workspace canonical state and is exposed as `agentProfile` in runtime and protocol contracts.

The existing profile/device database remains the owner of cross-workspace user preferences, global skills, device identity, provider configuration, and opaque credential references. Runtime context exposes that state as `userProfile`.

No API, context record, or projection uses the unqualified name `profile` when agent and user/device state are both present.

## Storage and canonical ownership

### Initial profile

Session admission atomically records a complete initial profile. A newly runnable session cannot exist without one.

The initial profile may be carried by `SessionCreated` or by an agent-profile event in the same transaction. Domain review should choose the event shape that produces the smallest clear invariant.

### Profile revisions

Profile identity is session-wide, not branch-local. Direct revisions therefore require canonical ownership independent of any conversation branch.

The preferred end state is a narrow workspace agent-control stream that owns only:

- immutable profile versions;
- each session's active profile pointer.

It does not own:

- conversation or branch history;
- model context;
- tasks or family mailboxes;
- goals and gates;
- cells or working values;
- effects;
- schedules or wakes;
- harness artifacts.

All events remain in the existing globally ordered `events` table. Stream addressing distinguishes workspace profile control from ordinary agent-route history:

```ts
type EventStreamAddress =
  | { kind: "workspace-agents"; workspaceId: string }
  | { kind: "agent-route"; workspaceId: string; sessionId: string; branchId: string };
```

This is a pre-release schema cutover. Older workspaces fail closed before decode, projection, sync ingestion, or recovery unless a separately reviewed importer exists. Retained events are never silently reinterpreted.

### Candidate events

- `AgentProfileVersionCreated`;
- `AgentProfileActivated`.

The initial profile may instead be complete inside `SessionCreated` if the reducers preserve the same atomic admission invariant.

Events may be consolidated when one immutable transition carries complete durable meaning. Names are not accepted until reducers, idempotency, recovery, and projection ownership are reviewed.

### Projections

New rebuildable projections are limited to:

- `workspace_agent_profiles`;
- `agent_profile_versions`.

The implementation should reuse existing session, branch, task, run, activity, and product-selection projections.

All new tables require classification in `docs/mutable-tables.md`, architecture checks, replay tests, and idempotent rebuild behavior.

## Model call integration

Every autonomous model request composes system content in this order:

1. immutable Agencity base policy;
2. exact pinned agent prompt;
3. invocation-specific response and run-control contract;
4. invocation-specific execution guidance.

Dynamic task, conversation, memory, skill, artifact, mailbox, and observation context follows through existing materialization semantics.

Every agent invocation creates one immutable profile pin. The invoking event is:

- `AgentRunRequested` for the ordinary autonomous action loop; or
- `RecursiveModelStarted` for retained recursive-model execution that does not use an `AgentRun`.

The invocation pin records:

- `profileVersionId`;
- `agentPromptDigest`;
- profile-level immutable component references.

Every `ContextMaterialized` and `ModelCallRequested`, including retries and later steps in the same invocation, records:

- invocation kind and ID;
- invocation-level `profileVersionId`;
- exact rendered effective-system-prompt digest;
- exact immutable component references;
- model dispatch and invocation-contract versions.

Each call validates that its profile component matches the invocation-level pin. Immutable content is referenced rather than duplicated across every event.

A profile change during a run or recursive-model execution applies only to later invocations. Every model step in one invocation uses the same pinned profile unless an existing immediate runtime revocation prevents further execution.

## Direct profile revision

Profile revision is an ordinary typed durable-state operation:

1. The caller supplies the expected current profile version, replacement role, purpose, instructions, and a bounded reason.
2. The runtime validates shape, size, known-secret rejection, prompt rendering, actor scope, and the expected-version comparison.
3. One transaction creates the immutable profile version and activates it for future invocations.
4. A run or recursive-model invocation already in progress keeps its pinned profile.

Authorized actors are:

- an agent revising its own profile;
- an active creation-family parent revising a direct child's profile;
- the workspace owner revising any workspace agent profile.

Siblings and unrelated agents cannot revise one another.

These operations do not require a proposal, reviewer, human approval, candidate allocation, or evaluation result. They cannot change provider or model configuration, credentials, SDK operations, effect policy, execution limits, or operating-system authority because those values are absent from the profile contract.

### Rollback

Rollback creates and activates a new profile version whose content matches an exact prior version. It records the actor, reason, prior active version, and restored source version without deleting intervening history.

Evidence references are optional provenance, not an activation prerequisite. Operators and agents may compare completion outcomes, corrections, unresolved effects, usage, latency, or task-specific evidence after a revision. Observation may motivate another revision or rollback; it does not create a governance state machine.

### Branch semantics

The profile belongs to the session identity, not one conversation branch.

Historical invocations retain their pinned profiles. New invocations on any branch use the current active session profile after transactional revision checks.

A branch is a counterfactual conversation history, not a fork of agent identity. Testing a different persistent profile uses a new version with rollback or a separate agent identity rather than silently diverging a branch-local profile.

## Proposal-system direction

The target adaptation model is direct, validated, versioned, attributable, and reversible change. Artifact type alone should not determine whether a change needs a proposal workflow.

This plan removes proposal machinery from durable agent profiles. The current refinement system for prompt notes, memories, skills, and subagent specifications already uses proposal, candidate-exposure, evaluation, and decision records. Removing that implemented system is a separate product and migration change because it affects existing canonical events, runtime behavior, tests, public APIs, documentation, and the repository's adaptation constitution.

A separate cleanup should evaluate replacing that system with the same direct-revision model:

- validate the replacement artifact;
- create an immutable version;
- activate it atomically with actor and reason;
- preserve optional evidence and outcome observations;
- detect concurrent edits;
- roll back by activating a new version matching prior content.

Automatic unattended changes may need a narrower policy than deliberate user or agent edits. That distinction should be based on the change trigger and authority, not on whether the target is a profile, prompt note, memory, skill, or subagent specification.

Until that cleanup ships, current refinement remains authoritative for its existing artifact types. This plan neither duplicates nor depends on that proposal pipeline.

## Runtime policy

Profile language is behavioral instruction. It cannot change runtime configuration. Existing services continue to own:

- model and provider configuration and preflight validation;
- run limits and usage reporting;
- goal and gate checks;
- SDK capabilities;
- outbox-backed effects;
- credential brokerage;
- file, shell, and skill executor policy.

Model preflight validation checks that the selected provider is configured and the model supports the formal tool contract required by the run. It is a compatibility check, not an authority or approval system.

Durable state changes continue through typed runtime commands. Model-generated code does not receive direct write access to canonical event history. This protects event validity, replay, and recovery; it is not a confidentiality or hostile-code boundary.

External model, shell, file, and skill work continues through the outbox. Recording requests before execution and explicit outcomes after execution prevents crash recovery from blindly repeating uncertain work.

## Protocol and SDK

The public contract should expose capabilities rather than mirror every internal event.

Illustrative product operations:

```http
GET  /product/agents/:session
GET  /product/agents/:session/profiles
POST /product/agents/:session/profiles
POST /product/agents/:session/profiles/rollback
```

Exact paths may be consolidated.

The contract preserves:

- exact IDs and revisions;
- active and historical profile distinction;
- no mutation from read or navigation calls;
- typed unavailable, stale, unauthorized, and conflict outcomes;
- bounded prompt and evidence payloads.

Generated TypeScript receives capability-scoped operations:

```ts
sdk.agents.get(target, options?)
sdk.agents.updateProfile(target, input)
sdk.agents.rollbackProfile(target, input)

sdk.agents.spawn({ task, profile?, ... })
sdk.agents.spawnMany(inputs)
```

The executing session and branch supply actor identity. Generated code cannot spoof a user identity, parent relationship, evidence source, or current revision. Profile commands accept only the executing agent or its direct creation-family child as a target.

Existing `rlm.start` and `rlm.startMany` may accept an explicit profile or use the sealed task-specialist helper. The retained child always has exact profile and prompt provenance.

## Terminal product

The existing workspace root selector, route view, and family navigation remain authoritative.

Agent detail adds:

- current profile and exact agent prompt;
- profile history and diffs;
- creation ancestry;
- current routes, tasks, and runs;
- actor, reason, optional evidence, and rollback for each revision.

Navigation remains observational. Profile revision and rollback use explicit typed actions.

No new coordinator view, assignment queue, specialist directory, routing inspector, or assignment eligibility control is required.

## Security and trust boundary

The runtime remains trusted-local.

- Model-generated TypeScript and shell commands retain the OS authority of the runtime process.
- Agent profiles are behavioral controls, not hostile-code isolation.
- Profile text cannot change model configuration, credentials, SDK operations, effect policy, execution limits, or publication configuration.
- Known-value rejection, credential stripping, bounded diagnostics, and exact provenance apply to profile admission.
- Hostile multi-agent or multi-tenant operation requires a separate authenticated and isolated deployment architecture.

New UI and documentation must not imply that profile instructions or typed runtime commands sandbox local code.

## Retention, export, and deletion

Retained state includes:

- every profile version, exact agent prompt, and digest;
- every invocation-to-profile and effective-prompt pin;
- profile revision actors, reasons, optional evidence, conflicts, and rollback activations;
- existing session, branch, task, mailbox, goal, effect, context, and artifact provenance.

Workspace export includes all active and historical profile records plus existing canonical history and referenced artifacts.

An export that omits a profile version or effective-prompt component needed to explain a model call is incomplete.

Physical deletion remains a separate guarded owned-scope operation. Profile revision never deletes canonical events, artifacts, tasks, mailboxes, or evidence.

## Migration and compatibility

### Fresh workspaces

A fresh workspace creates:

1. a root session and route;
2. an explicit usable model;
3. one sealed initial agent profile;
4. exact prompt provenance before the first autonomous run.

### Existing workspaces

The implementation follows the repository's pre-release compatibility policy.

If event addressing changes, older workspaces fail closed under reset guidance. A separately reviewed importer may preserve old work as historical state, but it must not infer a definitive historical agent prompt from task text.

Potentially runnable imported sessions require an explicitly confirmed profile before new work. Ended legacy sessions remain inspectable with historical-unknown profile provenance.

No migration rewrites retained event rows or silently interprets an initial task as a system instruction.

## Delivery sequence

### Phase 0 — Domain review

- Confirm the thin profile fields and exact rendering contract.
- Confirm the workspace agent-control stream owns only profile versions and active pointers.
- Define profile, prompt-note, subagent-spec, memory, runtime-policy, and dynamic-context boundaries.
- Define profile size and revision-rate bounds.
- Add an ADR for durable agent profiles.

### Phase 1 — Durable profiles

- Add profile validation, bounds, secret rejection, and deterministic prompt rendering.
- Require one materialized profile for new roots and children.
- Add sealed root and task-specialist templates.
- Make subagent specifications materialize initial profiles with exact source provenance.
- Compose and pin the profile on every autonomous and recursive-model invocation.
- Add owner-facing profile inspection.
- Add replay, prompt-digest, compaction, recovery, and child-admission tests.

### Phase 2 — Direct profile adaptation

- Add direct self, direct-child, and owner profile revision commands.
- Create and activate each version atomically for future invocations.
- Retain actor, reason, exact diff, optional evidence, and expected-version conflicts.
- Add rollback through a new immutable activation.
- Do not add proposal, approval, candidate-exposure, routing, assignment, or coordinator machinery.

### Phase 3 — Product hardening

- Add installed-product journeys for profile creation, revision, rollback, restart, and inspection.
- Add sync divergence, export, and deletion-plan coverage.
- Update public protocol, API, user, operator, recovery, security, capability, event, mutable-table, data-lifecycle, and verification documentation.
- Update `AGENTS.md` only for capabilities that ship.

### Separate refinement simplification

Retiring the existing proposal-based harness refinement system requires its own reviewed implementation change. That work should update canonical events, reducers, recovery, APIs, tests, public documentation, and the adaptation constitution together.

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
- Every context and model-call attempt records its invocation profile pin, effective-prompt digest, and immutable component references.
- Retries and later steps validate against the same invocation profile pin.
- Each effective prompt digest matches provider-facing content.
- Profile revisions never change an active invocation.
- Later invocations use the newly active profile.
- Compaction preserves exact profile and effective-prompt references.
- Recovery after context, model request, or effect commit does not rematerialize with a different profile.

### Direct adaptation

- An agent can directly create and activate a new version of its own profile for future invocations.
- A parent can directly revise a creation-family child's profile.
- The owner can directly revise any workspace agent profile.
- Siblings and unrelated agents cannot revise one another.
- Profile revisions cannot change runtime configuration.
- Revision requires no proposal, approval, candidate exposure, or evaluation result.
- Rollback restores exact prior content through a new immutable version.
- Concurrent revisions conflict through the expected current profile version.

### Root and task behavior

- Existing root selection remains the no-ID inbound route.
- A selected root may work directly or create a child through one existing `Task`.
- Child creation does not create an assignment or routing record.
- Existing authorized family follow-up remains available.
- Multiple workspace roots remain independent trees.
- Profile changes do not alter creation ancestry, mailbox reach, task ownership, cancellation, or usage attribution.

### Branch, recovery, and sync

- Historical invocations resolve their original profile after later revisions.
- New work on any branch resolves the current session profile.
- Branch forks do not duplicate session identity or fork the profile pointer.
- Crash boundaries do not duplicate profiles, runs, effects, tasks, or usage.
- Concurrent profile edits conflict rather than use last-write-wins.
- Non-owner or divergent sync state never silently chooses an active profile.

### Installed product

A linked executable journey must:

1. create a fresh root with an exact profile;
2. complete work and display the pinned profile;
3. create a child with a concise materialized profile;
4. revise the child's profile directly;
5. prove old and new invocation pins;
6. roll back to exact prior content;
7. detach, restart, and reproduce the same profiles and outcomes without duplicate work.

The journey uses only the documented executable and public protocol-backed terminal product.

## Performance and bounds

The implementation defines and tests bounds for:

- profile encoded bytes;
- optional prompt-excluded discovery fields;
- profile revision rate;
- retained evidence references;
- full-prompt detail requests.

Ordinary agent lists and navigation do not embed full prompts or conversation histories.

## Risks and safeguards

### Profile accumulation

Profiles can become knowledge dumps. Small fields, byte bounds, and separation from memory, prompt notes, goals, and dynamic context keep the prompt focused.

### Prompt causality overclaim

An exact profile improves provenance but does not prove that prompt text caused an outcome. Evaluation considers the model, provider, dynamic context, task mix, tools, and stochastic behavior.

### Self-revision drift

Direct self-revision can degrade behavior. Immutable history, expected-version checks, exact diffs, optional evidence, owner inspection, and rollback make the change visible and reversible. Runtime authority remains outside the profile.

### Configuration illusion

Profile prose can claim configuration or isolation that it does not control. Product surfaces label profile text as behavioral instruction, and actual runtime configuration stays in the services that own it.

### Premature organization modeling

Durable specialists can suggest a need for routing, assignments, or hierarchy before repeated specialist reuse exists. Those constructs remain deferred until installed-product evidence demonstrates a problem that the existing root, task, and family-message model cannot solve.

### Cross-device conflict

Offline writers cannot silently share one active profile pointer. Compare-and-swap revisions and existing sync conflict handling preserve divergent claims explicitly.

## Completion criteria

The plan is complete when:

1. Every newly runnable agent has one exact durable profile.
2. Every autonomous run and recursive-model invocation records its profile pin and exact effective system prompt.
3. One-off child admission remains concise through sealed profile helpers.
4. Agent purpose, runtime policy, work criteria, knowledge, and current context remain separate.
5. Root selection and existing child `Task` delegation remain the complete ordinary work flow.
6. No assignment, specialist-routing, coordinator, or management-hierarchy dependency is introduced.
7. Profile revisions are direct, versioned, conflict-checked, and reversible without a proposal or approval workflow.
8. Profile text cannot change runtime configuration or claim sandbox guarantees.
9. Dormant agents consume no execution capacity merely because their identity persists.
10. Restart, branch, sync, export, and deletion behavior preserve profile provenance.
11. The installed terminal journey demonstrates profile creation, revision, rollback, detach, and resume without internal IDs.
12. Public documentation and `AGENTS.md` describe shipped behavior and remaining limits accurately.
13. Typecheck, architecture checks, deterministic tests, and acceptance pass; gated external checks are reported separately.

## Deferred extensions

- Cross-family specialist reuse.
- Workspace-wide assignment or routing.
- A workspace coordinator distinct from selected roots.
- A central specialist directory.
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
- Embedding-based semantic agent search.
- Automatic physical garbage collection of retained histories.

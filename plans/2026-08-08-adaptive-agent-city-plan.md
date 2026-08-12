# Durable agent profiles and automated refinement review plan

**Status:** Implemented
**Date:** August 8, 2026
**Last revised:** August 9, 2026
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)
**Related plans:** [Workspace Agents view](./2026-08-08-workspace-agents-view-plan.md), [Ergonomic agent-family navigation](./2026-08-07-ergonomic-agent-family-navigation-plan.md), and [Lossless context-reference storage](./2026-08-07-lossless-context-references-plan.md)
**Related decisions:** [Event-sourced relational memory and measured refinement](../docs/decisions/0002-relational-memory-refinement.md), [Durable agent relationships](../docs/decisions/0006-durable-agent-relationships.md), [Profile, workspace, and credential boundaries](../docs/decisions/0008-profile-workspace-and-credentials.md), and [Durable agent profiles and automated refinement governance](../docs/decisions/0012-durable-agent-profiles-automated-refinement-governance.md)

## Summary

Agencity should retain the exact purpose and agent-specific instructions of every runnable session. A durable agent profile makes that purpose explicit, pins it to each model invocation, and allows future behavior to change through immutable, attributable, reversible versions.

This plan adds one focused identity capability and one shared governance path:

1. every runnable `Session` has one durable profile;
2. every autonomous run and recursive-model invocation pins the exact profile and effective system prompt it uses;
3. every profile revision is a typed refinement proposal rather than a direct mutation;
4. deterministic validation runs before one sealed LLM reviewer evaluates the proposal against exact pinned charter, constitution, policy, evidence, and current-target inputs;
5. only an approved proposal creates and activates a new profile version;
6. rejection is terminal, attributable, and returned or durably delivered to the proposer;
7. the same automated review direction applies to memory, prompt-note, skill, and subagent-specification refinements without requiring per-proposal human approval.

`Session` remains the only executable agent identity. The plan does not add assignments, a workspace coordinator, a specialist directory, workspace routing, a management hierarchy, or an `Agent` aggregate above `Session`.

The existing root-and-child model remains the complete work topology for this scope. A selected root receives user work, handles it directly, delegates by creating a child through the existing `Task` mechanism, or follows up with an existing creation-family child through the existing mailbox path.

## Product decision

The durable value in an agent is its retained identity, history, and exact behavioral instructions. That value does not require an organization control plane.

Behavioral adaptation should be automatic but not unreviewed. A proposing model and an approving model have different responsibilities:

- the **proposer** identifies a useful change and supplies evidence, predicted effect, and typed replacement content;
- deterministic validation checks shape, authority, scope, secrets, compatibility, and compare-and-swap state;
- the **reviewer** independently decides whether the valid proposal is consistent with the governing charter and constitution and is justified by the retained evidence;
- the runtime applies approved content through the target artifact's normal immutable-version mechanism;
- rejected content never becomes active.

The reviewer is the only approval actor for ordinary refinements. There is no per-proposal human approval step. Human authority remains encoded in the standing immutable product policy, workspace policy, target scope, and typed runtime boundaries supplied to the reviewer and enforced again by the runtime.

The product therefore separates:

- **identity and standing behavior:** the durable session profile;
- **finite work:** direct user requests, child tasks, retained family `queue` messages, schedules, and wakes;
- **completion:** goals, gates, and typed run outcomes;
- **runtime authority:** typed SDK operations, effect policy, credentials, limits, and trusted-local process authority;
- **knowledge:** memories, prompt notes, skills, artifacts, and dynamic context.

The profile answers who the agent is and how it should generally behave. It does not become a container for all agent state.

Review approval is not runtime authority. The reviewer cannot approve changes to credentials, operating-system authority, SDK availability, effect policy, model configuration, budgets, immutable safety policy, or any field outside the typed refinement target.

## Why this plan is narrower

The runtime already supports durable root and child sessions, retained family relationships, delegation, queue/steer messaging, goals, gates, effects, recovery, and human-readable root selection. Those mechanisms are sufficient for the initial product.

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
4. queue authorized work for an existing child or steer its active run within the creation family; or
5. finish blocked, failed, or successful through the existing typed model contract.

No new coordinator role, pointer, system prompt, authority, or routing pass is required. Opening another root for inspection or explicitly selecting another root changes the product's remembered route through existing selection behavior.

## Implemented foundation

The runtime provides:

- `Session` as a durable actor with model configuration, budget, goals, conversation, branches, tasks, runs, and event history;
- atomic child admission with parent and child identity, task intent, model, budget, initial prompt, and admission;
- durable parent, child, and sibling mailboxes;
- bounded queued child work after terminal task work and explicit active-run steering;
- append-only canonical history and rebuildable projections;
- attributable materialized model context;
- immutable versioned prompt notes, memories, skills, and subagent specifications;
- governed profile and harness refinement with deterministic validation, separate sealed review, application-time revalidation, automatic application, terminal delivery, and rollback;
- typed goals, gates, outbox effects, unknown outcomes, cancellation, schedules, wakes, and recovery;
- product branch discovery, human-readable selection, and remembered root routes.

The runtime also provides required per-session agent-specific system instructions, exact profile/effective-prompt pins, profile proposals, sealed governance review, automatic application, durable terminal delivery, route-relative CLI/TUI controls, protocol/`AgentClient` operations, and Console SDK self/direct-child operations.

The linked-executable governance journey and final deterministic aggregate verification have passed. Live providers, official Turso Sync, and Turso Cloud remain gated and unverified.

Reusable subagent specifications remain templates. They may produce an initial agent profile, but they are not the resulting session's durable identity and do not silently update an existing session.

Prompt notes remain optional dynamic harness context. They do not replace the one required agent profile.

## Goals

- Give every runnable root, delegated child, and recursive agent explicit durable purpose.
- Supply exact agent-specific system instructions on every agent model call.
- Preserve the exact profile version and effective system prompt used by every run and recursive-model invocation.
- Keep `Session` as the only executable agent identity.
- Keep standing purpose separate from current tasks, goals, messages, memories, and repository state.
- Let one-off helpers use concise sealed defaults instead of requiring authored charters.
- Let an agent, its direct creation-family parent, or the workspace owner propose future profile behavior.
- Review every profile proposal automatically through a separate sealed LLM role before activation.
- Pin the exact charter, constitution, review policy, reviewer model, proposal, evidence, and current target supplied to each review.
- Apply approved proposals without per-proposal human intervention.
- Return or durably deliver every rejection reason to the proposer.
- Permit bounded reproposal as a new immutable proposal rather than reopening a rejected proposal.
- Retain exact actors, reasons, diffs, evidence, review decisions, conflicts, and rollback.
- Move existing memory, prompt-note, skill, and subagent-specification refinement toward the same automatic review-and-apply lifecycle.
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
- Allowing a profile revision to bypass proposal validation and automated review.
- Letting the proposal author approve its own proposal.
- Treating reviewer approval as evidence that a change improved outcomes.
- Requiring per-proposal human approval for local, workspace, user, or global behavioral refinements.
- Automatically retrying rejected proposals without a new proposal identity and a strict attempt bound.
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

Durable purpose does not authorize execution. Every run still requires a direct user request, task, retained family `queue` message, schedule, or wake accepted through the existing run path.

### Revisions append

Profile versions and activation changes remain attributable. Historical invocations resolve the exact versions they used.

### Adaptation is automatic, independently reviewed, and reversible

An authorized actor may propose a new profile version. The proposer cannot activate it. Deterministic validation and one independent sealed LLM review produce a terminal approval or rejection. Approval atomically creates and activates the new version for future invocations. Rejection changes no active content.

No person must approve an ordinary proposal. Exact inputs, typed outputs, immutable history, conflict detection, terminal notification, ordinary run evidence, and rollback provide the control model.

### Runtime services remain authoritative

Profiles influence model behavior only. Runtime services continue to own model configuration, credentials, limits, goals, gates, SDK capabilities, effects, and operating-system authority.

## Terms

- **Agent:** One durable `Session`.
- **Agent profile:** The immutable versioned purpose and exact agent-specific system instructions for a session.
- **Agent prompt:** The exact provider-facing profile text materialized from one profile version.
- **Invocation profile pin:** The profile version and prompt digest fixed when an autonomous run or recursive-model invocation begins.
- **Effective system prompt:** The complete provider-facing system content assembled from runtime policy, the pinned agent prompt, and invocation-specific contracts and guidance.
- **Refinement proposal:** One immutable typed request to create, replace, or retire behavioral content, including its proposer, target, expected version, evidence, reason, and predicted effect.
- **Refinement reviewer:** A sealed recursive LLM role that may return exactly one typed `approve` or `reject` decision and cannot edit the proposal.
- **Review charter:** The exact immutable charter, constitution, and refinement-policy components supplied to the reviewer and retained by digest and source reference.
- **Reproposal:** A new proposal that references a rejected proposal and contains a substantively revised change.
- **Root:** A session without a creation-family parent. A workspace may contain multiple roots.
- **Task:** The existing durable relationship through which a parent creates and owns work for a child session.
- **Work source:** A direct user request, task, retained family `queue` message, schedule, or wake that starts an `AgentRun`.
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
  sourceProposalId: string | null;
  reviewDecisionId: string | null;
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

Revised versions record the exact approved proposal and review decision that authorized activation. Sealed initial profiles created during admission have null proposal and review references.

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

### Profile refinement target

The existing refinement proposal system gains a typed profile target without making profiles harness entries:

```ts
interface AgentProfileRefinementTarget {
  kind: "agent_profile";
  agentSessionId: string;
  expectedProfileVersionId: string;
  replacement: {
    role: string;
    purpose: string;
    instructions: string;
  };
}
```

The proposal envelope owns proposer identity, source review, trigger, evidence, predicted effect, scope, and optional objective evaluation intent. Trajectory-refiner proposals require evaluation intent; direct owner or agent proposals may omit it. The target owns only the exact profile replacement and compare-and-swap precondition.

Profiles remain session identity state. Memories, prompt notes, skills, and subagent specifications remain harness entries. They share refinement governance without sharing storage identity.

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

The initial profile is complete inside `SessionCreated`, preserving atomic runnable-session admission.

### Profile revisions

Profile identity is session-wide, not branch-local. Approved revisions therefore require canonical ownership independent of any conversation branch.

The implemented control model owns only:

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
- harness artifacts;
- proposal review execution, which remains owned by the refinement service and proposing route.

All events remain in the existing globally ordered `events` table. Profile control events use the session's initial branch as their canonical address; storage enforces that rule and session-wide compare-and-swap. This avoids a broader event-stream addressing cutover while preserving session-wide identity.

Schema version 4 is a pre-release cutover. Version-1, -2, and -3 workspaces fail closed before decode, projection, sync ingestion, or recovery. Retained events are never silently reinterpreted.

### Canonical events

- `GovernedRefinementProposed`;
- `GovernedRefinementValidated`;
- `RefinementGovernanceReviewRequested`;
- `RefinementGovernanceReviewChildLinked`;
- `RefinementGovernanceReviewDecided`;
- `GovernedRefinementApplied`;
- `RefinementProposalTerminalNoticeDelivered`;
- `RefinementRollbackApplied`;
- `AgentProfileVersionCreated`;
- `AgentProfileActivated`.

An approved profile decision, version creation, and active-pointer change commit atomically. A rejected decision commits no profile event. Skill application is staged because compile and declared runtime tests are durable effects; only a passing retained report permits activation.

### Projections

Rebuildable projections are:

- `workspace_agent_profiles`;
- `agent_profile_versions`;
- `governed_refinement_proposals`;
- `refinement_restorations`;
- existing harness, skill-execution, and trajectory-review projections.

The implementation reuses existing session, branch, task, run, activity, and product-selection projections. Migration 016 adds profile projections and prompt-pin columns; migration 017 adds governance wait state, governed proposal projection, and restoration projection.

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

## Automated profile refinement

### Proposal admission

Profile revision begins with one typed proposal:

1. The caller supplies the expected current profile version, replacement role, purpose, instructions, bounded reason, predicted effect, and attributable evidence.
2. The runtime records the immutable proposal before review.
3. Deterministic validation checks shape, byte bounds, known-secret rejection, prompt rendering, target scope, proposer authority, immutable-policy boundaries, and the expected-version comparison.
4. Invalid proposals terminate as rejected without invoking the reviewer.
5. Valid proposals start one durable sealed governance-review child.

Authorized proposers are:

- an agent proposing a revision to its own profile;
- an active creation-family parent proposing a revision to a direct child's profile;
- the workspace owner proposing a revision to any workspace agent profile;
- the automatic trajectory refiner acting within the same target scope.

Siblings and unrelated agents cannot target one another. Proposal permission grants no activation authority.

### Reviewer inputs

The governance reviewer receives one bounded, frozen input. New freezes use version 3; retained versions 1 and 2 remain readable:

- the exact proposal and proposed rendered agent prompt;
- the target's exact current profile and expected version;
- every cited event identity plus a deterministic redacted canonical-JSON payload excerpt under one fixed 32 KiB aggregate budget, with canonical/redacted payload and excerpt digests, exact byte counts, truncation, and credential/repository-instruction redaction provenance;
- source trajectory trigger, allowed kinds, review identity, and snapshot hash for refiner-produced proposals;
- the proposer identity and relationship to the target;
- the immutable Agencity base policy;
- the exact product constitution and refinement-review policy;
- workspace-charter and user-constraint slots, currently pinned as `null` because no public configuration exists;
- the target scope and runtime capability boundaries;
- relevant active harness versions and known conflicts selected through attributable context rules.

Every component is referenced by immutable ID, version, digest, or retained event. Live files or mutable prose are not silently substituted during recovery.

The trajectory refiner's objective evaluation is retained in the governed proposal fingerprint, frozen input, inspection projection, and application event. It is post-activation evaluation intent and does not block ordinary application. Generated-skill compile and declared runtime tests remain the only additional activation-time check.

The proposal is data, not reviewer instruction. The sealed reviewer policy takes precedence over proposal text and rejects attempts to rewrite the charter, reviewer role, authority boundary, or required output contract.

### Charter materialization

The reviewer does not read ambient repository guidance at decision time. The governing inputs are explicit runtime components:

- a packaged immutable Agencity base constitution with ID, version, and digest;
- a versioned refinement-review rubric derived from the constitution;
- a workspace-charter slot, currently `null`;
- the target agent's active profile and a user-constraints slot, currently `null`.

`AGENTS.md` documents the product constitution for maintainers but is not silently imported from an arbitrary target repository as reviewer authority. The runtime packages a frozen product constitution and review policy. Workspace-charter and user-constraint registration is unavailable; the frozen reviewer input records both as `null`.

The supervisor selects the reviewer model and pins its provider, model, reasoning configuration, response contract, and context digest. The reviewer is always a separate model invocation from the proposal-producing invocation. It may use the same underlying model family, but never the same completion or mutable context.

### Reviewer contract

The reviewer has exactly one formal response tool and returns exactly one decision:

```ts
type RefinementGovernanceDecision =
  | {
      decision: "approve";
      proposalId: string;
      reason: string;
      satisfiedCriteria: string[];
      residualRisks: string[];
    }
  | {
      decision: "reject";
      proposalId: string;
      reason: string;
      violatedCriteria: string[];
      revisionGuidance?: string;
    };
```

The reviewer cannot:

- edit the proposal;
- approve a different target or scope;
- broaden runtime authority;
- waive deterministic validation;
- activate a version directly;
- call the ordinary agent SDK;
- delegate its decision to another model;
- return prose as an executable fallback.

The reviewer runs under a sealed internal profile that cannot propose revisions to itself, its charter, or its review contract.

Malformed output, tool-contract failure, unknown model outcome, timeout, budget exhaustion, or unavailable pinned charter content never implies approval. The proposal ends in a typed failed or unknown review state and changes no active behavior.

### Approval and application

Approval is necessary but not sufficient to bypass runtime checks. The runtime revalidates target scope, authority, secrets, prompt rendering, and compare-and-swap state immediately before application.

For a valid approved profile proposal, one transaction:

1. appends the terminal approval decision;
2. creates the immutable profile version linked to the proposal and decision;
3. activates it for future invocations.

An in-progress run or recursive-model invocation keeps its pinned profile. A stale target rejects application rather than reviewing or applying against a different profile.

No per-proposal human approval is required at any scope. Standing policy may make a scope unavailable to automated refinement; unavailable scope ends as rejection rather than waiting for a person.

### Rejection, notification, and reproposal

Rejection is terminal and activates nothing. The exact proposer receives:

- proposal and decision IDs;
- terminal status;
- bounded rejection reason;
- violated criteria;
- optional revision guidance.

A proposal records its exact origin session, branch, and optional run, task, trigger, or client request. A synchronous SDK or protocol call may wait for the terminal result. An asynchronous or automatic proposal returns its identity immediately and later appends one idempotent terminal notice to that origin.

Agent-originated notices become exact run observations or retained route messages before dependent work continues. Owner-originated notices are available through the public event and client contract. Recovery may redeliver an undelivered notice but cannot duplicate a delivered notice or the underlying review.

A rejected proposal is never reopened or edited. The proposer may submit a new proposal with:

- a new proposal ID and fingerprint;
- `revisesProposalId` pointing to the rejection;
- a substantive content or evidence change;
- the prior rejection available to the next reviewer.

Automatic reproposal is allowed only under an explicit bounded policy. The initial default permits at most one revised proposal for the same trigger and target. Exhaustion ends the original caller's wait with the latest terminal reason. This prevents proposer-reviewer loops from consuming unbounded model calls.

### Rollback

Rollback is one explicit typed restoration command:

```ts
interface RollbackRefinementInput {
  targetKind: "agent_profile" | "memory" | "prompt_note" | "skill" | "subagent_spec";
  targetId: string;
  expectedCurrentVersionId: string;
  restoreVersionId: string;
  reason: string;
  evidenceEventIds: string[];
}
```

The runtime accepts rollback only when:

- the caller has ordinary revision authority for the target;
- `expectedCurrentVersionId` is still active;
- `restoreVersionId` is an exact earlier approved version of the same target;
- the referenced evidence exists and belongs to the caller's visible scope;
- restoring the version does not change runtime authority or violate current compatibility policy.

One transaction appends the rollback decision, creates a new immutable restoration version with the exact earlier content and digest, and activates that restoration for future invocations. It records the failed version, restored source version, actor, reason, and evidence. It never deletes or rewrites the intervening versions.

An active invocation keeps its pinned profile or harness versions. Later invocations use the restoration. A stale compare-and-swap or missing artifact fails without changing active state.

Rollback does not require another LLM review because it introduces no new content. If the caller modifies the earlier content, the operation is a new proposal and must be reviewed. An agent, its authorized parent, the workspace owner, or the automatic refiner may invoke rollback within its existing scope.

Ordinary later runs already produce attributable failures, gate results, corrections, and effect outcomes. An authorized actor may use that evidence to invoke rollback through the typed command.

### Branch semantics

The profile belongs to the session identity, not one conversation branch.

Historical invocations retain their pinned profiles. New invocations on any branch use the current active session profile after transactional revision checks.

A branch is a counterfactual conversation history, not a fork of agent identity. Testing a different persistent profile uses a new version with rollback or a separate agent identity rather than silently diverging a branch-local profile.

## Shared refinement governance

The target lifecycle for profiles, memories, prompt notes, skills, and subagent specifications is:

```text
proposed
  -> deterministically_rejected
  |  validated
       -> review_failed | review_unknown
       |  reviewed_rejected
       |  reviewed_approved
            -> apply_conflict | apply_failed | applied
```

The implemented ordinary decision path reuses durable proposal identity, validation, recovery, and immutable versioning while applying these rules:

- a separate LLM reviewer replaces per-proposal human approval;
- reviewer approval precedes activation;
- approved behavioral content applies automatically;
- rejection reasons return to the proposer;
- optional reproposal always creates a new proposal;
- ordinary later run evidence may inform another proposal or an explicit rollback.

Skills retain mandatory compile and declared runtime tests before activation. A reviewer cannot approve a failing skill. Other artifact kinds rely on deterministic validation plus charter review before activation.

ADR 0012 supersedes ADR 0002's mandatory pre-activation exposure and promotion rules while preserving its unaffected memory, retrieval, immutable-version, provenance, generated-skill test, evaluation, and rollback decisions. It extends ADR 0006's durable-session model and ADR 0008's agent-profile versus user/device-profile boundary. The retained ADR-0002 candidate/evaluation APIs remain advanced and legacy-compatible rather than the ordinary activation path.

## Documentation and decision-record obligations

Documentation is part of each shipping phase rather than a final cleanup task. A phase is not complete until its implemented behavior, public contract, operational consequences, and remaining limitations are reflected in the authoritative documents affected by that phase.

The accepted decision-record foundation includes:

- ADR 0012 for durable agent profiles and automated refinement governance;
- record exactly which ADR 0002 rules it supersedes and which rules remain in force;
- record that it extends ADRs 0006 and 0008 without replacing their durable relationship or ownership boundaries;
- update `docs/decisions/README.md`, the affected ADR metadata and backlinks, and the decision list in `docs/README.md`;
- an `AGENTS.md` amendment that distinguishes accepted direction, implemented runtime behavior, and remaining installed-product evidence.

As behavior ships, update every affected public reference:

- `docs/architecture.md` for profile ownership, workspace agent-control streams, prompt composition, and refinement boundaries;
- `docs/events.md` and `docs/mutable-tables.md` for canonical events, projections, stream addressing, classifications, and rebuild semantics;
- `docs/protocol.md`, `docs/api.md`, and `docs/console-sdk.md` for public profile, proposal, review-result, rollback, wait, detach, and capability contracts;
- `docs/user-guide.md` for owner-visible profile inspection, proposal outcomes, rollback, and terminal behavior;
- `docs/operator-guide.md` and `docs/recovery.md` for review recovery, terminal-notice redelivery, unknown outcomes, stale application, and reconciliation procedures;
- `docs/security.md` for sealed-reviewer boundaries, untrusted proposal content, secret handling, and the trusted-local limitation;
- `docs/capabilities.md` for implemented, unavailable, and partially shipped profile and refinement behavior;
- `docs/data-lifecycle.md` for retention, export completeness, backup, restore, and deletion behavior;
- `docs/configuration.md` for any charter, reviewer-model, policy, bounds, or automatic-refinement configuration that becomes public;
- `docs/verification.md` for deterministic, installed-product, sync, and externally gated verification evidence and explicit skips.

Update `docs/README.md` when public pages or decision links change. Update `plans/README.md` and this plan's status and revision metadata when the plan is accepted, implemented, partially implemented, superseded, or retired. Remove the exploratory “adaptive agent city” description once this narrower plan becomes the accepted implementation contract. Public documentation must describe only shipped behavior; planned operations and schemas remain labeled as planning until their black-box product paths pass.

### End-to-end refinement flow

For `agencity refine`, the existing trajectory-review child remains the proposer:

1. freeze the attributable trajectory;
2. ask the proposer child for exactly `no_change` or one typed proposal;
3. return immediately on `no_change`;
4. durably record and deterministically validate a proposal;
5. start a separate governance-review child with the pinned charter;
6. apply the proposal atomically only after approval and final validation;
7. return or deliver the terminal result and reason to the original route.

Manual refinement waits by default. Automatic trigger processing detaches by default and delivers its terminal result durably. Both paths use the same proposal, review, application, and recovery semantics.

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

The public contract exposes capabilities rather than requiring callers to mirror internal events.

Implemented product operations:

```http
GET  /sessions/:session/agent-profile
GET  /sessions/:session/agent-profiles
POST /sessions/:session/profile-proposals?branch=:branch
GET  /governed-refinements/:proposal
POST /sessions/:session/profiles/rollback?branch=:branch
```

The contract preserves:

- exact IDs and revisions;
- active and historical profile distinction;
- wait or detach semantics for proposal review;
- terminal approval, rejection, failure, unknown, and application-conflict outcomes;
- durable rejection reasons and revision guidance;
- no mutation from read or navigation calls;
- typed unavailable, stale, unauthorized, and conflict outcomes;
- bounded prompt and evidence payloads.

Generated TypeScript receives capability-scoped operations:

```ts
sdk.agents.get(target?)
sdk.agents.proposeProfileUpdate(target, input, { wait?: boolean })
sdk.agents.rollbackProfile(target, input)

sdk.agents.spawn({ task, profile?, ... })
sdk.agents.spawnMany(inputs)
```

The executing session and branch supply proposer identity. Generated code cannot spoof a user identity, parent relationship, evidence source, or current revision. Profile proposals accept only the executing agent or its direct creation-family child as a target.

With `wait: true`, the call resolves only after review and application reach a terminal state. The durable proposal and reviewer child survive caller, worker, and service restart. With `wait: false`, the call returns the proposal identity and delivers the terminal result later through the durable route.

Generated code cannot invoke the reviewer directly, choose the reviewer model, supply the governing charter, approve a proposal, or activate a profile version.

Existing `rlm.start` and `rlm.startMany` accept an explicit profile or use the sealed task-specialist helper. The retained child always has exact profile and prompt provenance.

## Terminal product

The existing workspace root selector, route view, and family navigation remain authoritative.

Agent detail provides:

- current profile and exact agent prompt;
- profile history and diffs;
- pending and terminal profile proposals;
- exact pinned review-charter provenance;
- reviewer approval or rejection reasons;
- creation ancestry;
- current routes, tasks, and runs;
- actor, reason, optional evidence, and rollback for each revision.

Navigation remains observational. Proposal and rollback actions remain explicit. No approval inbox or human review queue is required.

No new coordinator view, assignment queue, specialist directory, routing inspector, or assignment eligibility control is required.

## Security and trust boundary

The runtime remains trusted-local.

- Model-generated TypeScript and shell commands retain the OS authority of the runtime process.
- Agent profiles are behavioral controls, not hostile-code isolation.
- Profile text cannot change model configuration, credentials, SDK operations, effect policy, execution limits, or publication configuration.
- Known-value rejection, credential stripping, bounded diagnostics, and exact provenance apply to profile admission.
- Proposal text, evidence, and target content are untrusted reviewer data and cannot alter the sealed reviewer policy or formal response contract.
- The review model receives only bounded, attributable charter and proposal inputs; it receives no raw credentials.
- Reviewer approval cannot bypass deterministic scope, authority, secret, compatibility, or compare-and-swap checks.
- A reviewer timeout, malformed response, unavailable model, or unknown effect never becomes approval.
- Hostile multi-agent or multi-tenant operation requires a separate authenticated and isolated deployment architecture.

New UI and documentation must not imply that profile instructions or typed runtime commands sandbox local code.

## Retention, export, and deletion

Retained state includes:

- every profile version, exact agent prompt, and digest;
- every invocation-to-profile and effective-prompt pin;
- every proposal, proposer, target, expected version, reason, predicted effect, and evidence reference;
- every frozen review input, charter and constitution pin, reviewer model dispatch, typed decision, and terminal notice;
- profile revision actors, reasons, evidence, conflicts, rejection guidance, reproposal links, and rollback activations;
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

### Phase 0 — Domain and constitutional review

- Confirm the thin profile fields and exact rendering contract.
- Confirm the workspace agent-control stream owns only profile versions and active pointers.
- Define profile, prompt-note, subagent-spec, memory, runtime-policy, and dynamic-context boundaries.
- Define the immutable product constitution, workspace charter, and reviewer-policy components supplied to governance review.
- Define the sealed reviewer model contract and proposer-reviewer separation.
- Define terminal notification, synchronous wait, detached recovery, and bounded reproposal semantics.
- Define profile size and revision-rate bounds.
- Accept a new ADR for durable agent profiles and automated refinement governance that explicitly supersedes ADR 0002's promotion and activation rules, preserves its unaffected decisions, and extends ADRs 0006 and 0008.
- Update ADR statuses, metadata, backlinks, `docs/decisions/README.md`, and the decision list in `docs/README.md`.
- Amend `AGENTS.md` to authorize the accepted automatic charter-review and activation model while distinguishing accepted direction from shipped capability.

### Phase 1 — Durable profiles

- Add profile validation, bounds, secret rejection, and deterministic prompt rendering.
- Require one materialized profile for new roots and children.
- Add sealed root and task-specialist templates.
- Make subagent specifications materialize initial profiles with exact source provenance.
- Compose and pin the profile on every autonomous and recursive-model invocation.
- Add owner-facing profile inspection.
- Add replay, prompt-digest, compaction, recovery, and child-admission tests.

### Phase 2 — Automated profile refinement

- Extend typed refinement proposals with an `agent_profile` target.
- Add self, direct-child, owner, and automatic-refiner proposal admission.
- Add deterministic pre-review validation and exact frozen reviewer context.
- Run one sealed durable LLM reviewer with an approve-or-reject tool contract.
- Revalidate and atomically create and activate approved profile versions.
- Deliver terminal approval, rejection, failure, unknown, or conflict results to the proposer.
- Add bounded new-proposal revision using prior rejection guidance.
- Retain actor, reason, exact diff, evidence, review provenance, and expected-version conflicts.
- Add rollback through a new immutable activation.
- Do not add routing, assignment, coordinator, or human approval machinery.

### Phase 3 — Shared automatic refinement

- Route memory, prompt-note, skill, and subagent-specification proposals through the same sealed governance reviewer.
- Remove per-proposal human approval as an ordinary promotion dependency.
- Apply approved immutable versions automatically.
- Keep generated-skill compilation and declared runtime tests mandatory before activation.
- Add the shared typed rollback command over exact earlier approved versions.

### Phase 4 — Product hardening

- Add installed-product journeys for profile creation, proposal, approval, rejection, bounded reproposal, rollback, restart, and inspection.
- Add sync divergence, export, and deletion-plan coverage.
- Complete the documentation and decision-record obligations in this plan for architecture, events, tables, protocol, API, Console SDK, user operation, recovery, security, capabilities, configuration, data lifecycle, and verification.
- Update `docs/README.md`, `plans/README.md`, ADR indexes and backlinks, and this plan's status and revision metadata.
- Update `AGENTS.md` current implementation status only for capabilities demonstrated through the installed-product path; keep unshipped behavior explicit.

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

### Automated refinement review

- An agent can propose a new version of its own profile.
- A parent can propose a revision to a creation-family child's profile.
- The owner and automatic trajectory refiner can propose within their authorized scopes.
- Siblings and unrelated agents cannot revise one another.
- The proposer cannot approve or activate its proposal.
- Deterministically invalid proposals reject before an LLM call.
- Every valid proposal receives exactly one sealed reviewer decision.
- The reviewer receives exact pinned charter, constitution, policy, proposal, target, evidence, and model-dispatch provenance.
- Proposal content cannot inject instructions into the reviewer policy.
- Reviewer approval cannot change runtime configuration or bypass application-time validation.
- Approved proposals create and activate exactly one immutable profile version.
- Rejected, failed, unknown, stale, or malformed reviews activate nothing.
- Synchronous callers receive the terminal decision; detached callers receive the same result through durable delivery.
- Recovery redelivers an undelivered terminal notice and never duplicates a delivered notice.
- A reproposal has a new identity, references the rejection, changes content or evidence, and obeys the attempt bound.
- No per-proposal human approval is required.
- Rollback restores exact prior content through a new immutable version.
- Concurrent revisions conflict through the expected current profile version.

### Shared refinement lifecycle

- Memory, prompt-note, skill, subagent-specification, and profile proposals use the same governance reviewer contract.
- Skills compile and pass declared runtime tests before approved content becomes active.
- Rollback requires an exact earlier approved version and current-version compare-and-swap.
- Rollback creates a new immutable restoration version and never rewrites history.
- Modified restoration content is a new proposal, not rollback.

### Root and task behavior

- Existing root selection remains the no-ID inbound route.
- A selected root may work directly or create a child through one existing `Task`.
- Child creation does not create an assignment or routing record.
- Existing authorized default-queue family messaging remains available.
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
4. submit one child-profile proposal and block until an independent reviewer approves it;
5. prove the approved profile activates only for later invocations;
6. submit one proposal the reviewer rejects and receive the exact terminal reason;
7. submit one bounded revised proposal referencing that rejection;
8. prove old and new invocation pins;
9. roll back to exact prior content;
10. detach during review, restart, and reproduce the same proposal, decision, profile, and notification without duplicate model calls or activation.

The journey uses only the documented executable and public protocol-backed terminal product.

## Performance and bounds

The implementation defines and tests bounds for:

- profile encoded bytes;
- optional prompt-excluded discovery fields;
- profile revision rate;
- concurrent governance-review count;
- reviewer input and output bytes;
- reviewer model-call budget and timeout;
- automatic reproposals per trigger and target;
- pending terminal notices;
- retained evidence references;
- full-prompt detail requests.

Ordinary agent lists and navigation do not embed full prompts or conversation histories.

## Risks and safeguards

### Profile accumulation

Profiles can become knowledge dumps. Small fields, byte bounds, and separation from memory, prompt notes, goals, and dynamic context keep the prompt focused.

### Prompt causality overclaim

An exact profile improves provenance but does not prove that prompt text caused an outcome. Evaluation considers the model, provider, dynamic context, task mix, tools, and stochastic behavior.

### Reviewer agreement is not outcome evidence

An LLM reviewer can approve a coherent but ineffective change. Review proves only that the proposal passed the pinned charter and policy judgment. Attributable post-activation outcomes, later correction, and rollback remain necessary. Product language must not call review approval empirical validation.

### Reviewer capture or prompt injection

A proposal may attempt to instruct the reviewer to approve it or ignore policy. Proposal content is isolated as untrusted data, the sealed reviewer contract is supplied separately, exact charter precedence is explicit, and malformed or ambiguous output fails closed.

### Self-revision drift

Repeated self-proposals can degrade behavior even with independent review. Separate proposer and reviewer roles, hard reproposal limits, expected-version checks, exact diffs, ordinary run evidence, and rollback make drift bounded and inspectable. Runtime authority remains outside the profile.

### Reviewer bottleneck

Every refinement adds another model call and may block the proposer. Durable detached review, explicit timeouts, bounded input, stable idempotency, terminal failure states, and asynchronous notification prevent reviewer latency from becoming hidden or unrecoverable.

### Circular review behavior

A rejected proposer may repeatedly rewrite the same proposal. Rejection is terminal, reproposal requires a new identity and substantive change, and automatic revision has a strict per-trigger limit.

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
7. Every profile revision is a typed proposal reviewed by a separate sealed LLM role.
8. Every review pins the exact charter, constitution, policy, target, evidence, proposal, and reviewer dispatch.
9. Only an approved and revalidated proposal creates and activates a profile version.
10. Rejection is terminal, activates nothing, and returns or durably delivers its reason to the proposer.
11. Automatic reproposal uses a new identity and a strict attempt bound.
12. No ordinary behavioral refinement requires per-proposal human approval.
13. Memory, prompt-note, skill, subagent-specification, and profile refinements converge on the same automatic review-and-apply lifecycle.
14. Profile text and reviewer approval cannot change runtime configuration or claim sandbox guarantees.
15. Dormant agents consume no execution capacity merely because their identity persists.
16. Restart, branch, sync, export, and deletion behavior preserve proposal, review, profile, and notification provenance.
17. The installed terminal journey demonstrates approval, rejection, bounded reproposal, activation, rollback, detach, and resume without internal IDs.
18. A new accepted ADR records durable agent profiles and automated refinement governance, explicitly supersedes ADR 0002's affected promotion and activation rules, preserves its unaffected decisions, and extends ADRs 0006 and 0008.
19. ADR statuses, metadata, backlinks, `docs/decisions/README.md`, and the decision list in `docs/README.md` agree.
20. `AGENTS.md`, all affected public documentation named by this plan, `plans/README.md`, and this plan's status describe shipped behavior, unavailable behavior, and remaining limits accurately.
21. Typecheck, architecture checks, deterministic tests, and acceptance pass; gated external checks are reported separately.

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

## Implementation log

### 2026-08-09 — Phase 0: constitutional foundation

- Accepted [ADR 0012](../docs/decisions/0012-durable-agent-profiles-automated-refinement-governance.md) for durable per-session behavioral profiles and automated refinement governance.
- Superseded only ADR 0002 Decision item 4's mandatory pre-activation allocation/exposure/observation path and Decision item 5's promotion thresholds and named-approval rules. ADR 0002's retrieval, immutable-version, provenance, generated-skill test, compare-and-swap, evaluation, and rollback rules remain in force.
- Recorded that ADR 0012 extends ADR 0006 and ADR 0008 without changing durable relationship, workspace ownership, profile/device, or credential boundaries.
- Amended the repository constitution and plan indexes to make this plan the accepted implementation contract while keeping all profile and automated-governance runtime capabilities explicitly unshipped.
- Clarified that reviewer approval establishes charter compliance rather than empirical improvement and that candidate/control exposure remains available for attributable evaluation without being mandatory activation authority.

### 2026-08-09 — Phase 1: durable profiles and prompt pins

- Completed: raised the accepted workspace event schema to version 4 and reducer version to 13; schema-version-1, -2, and -3 workspaces fail closed before migration, decode, projection, synchronization ingestion, or recovery. Added immutable per-session profiles with UTF-8 bounds of 128 bytes for role, 1,024 bytes for purpose, 8,192 bytes for instructions, 9,512 bytes for the exact rendered prompt, 16,384 bytes for the encoded profile, 1,024 bytes for revision reason, and at most 32 evidence event IDs. Admission rejects registered brokered secrets before canonical commit.
- Completed: embedded the complete initial profile in `SessionCreated`; added sealed root/task-specialist defaults, explicit root/child/recursive profile inputs, specification-source provenance, rebuildable profile projections, session-wide active-profile compare-and-swap, invocation pins, fixed effective-system-prompt composition, exact context/call/effect provenance, recovery stability, and bounded supervisor/HTTP/`AgentClient` inspection.
- Validation: `bun run verify` passed. The core suite reported 856 passes, 2 gated skips, and 0 failures; installed acceptance reported 14 passes, 1 gated skip, and 0 failures; aggregate test evidence is 870 passes, 3 skips, and 0 failures.
- Plan notes: `AgentProfileVersionCreated` and `AgentProfileActivated` use the session's initial branch as their canonical address instead of adding a workspace stream-address type. CAS-backed rebuildable projections enforce one session-wide active profile, and runtime lookup replays complete session history, preserving later-invocation activation across branches without a broad event-addressing cutover.
- Remaining: profile proposal/revision commands, sealed governance review, automatic activation APIs, terminal proposal delivery, rollback, TUI profile controls, and the installed profile-governance journey remain for later phases. Live providers, official Turso Sync, and Turso Cloud were gated and remain unverified.

### 2026-08-09 — Phases 2 and 3: sealed shared refinement governance

- Completed: added immutable governed proposals for agent profiles and harness targets; deterministic validation; strict self, direct-child, owner, and local automatic-refiner authority; one separate sealed approve-or-reject recursive reviewer; frozen constitution, policy, target, evidence, relationship, current model dispatch, and runtime-boundary provenance; application-time revalidation; automatic activation; bounded reproposal; exact terminal delivery; and stable retry identity.
- Completed: made approved profile and non-skill harness application atomic, made exact profile and harness rollback atomic with its provenance event, and made skill candidate creation, durable compile/runtime tests, activation, and restart recovery an idempotent staged process. Memory, prompt-note, skill, subagent-specification, and profile changes share the same ordinary reviewer contract without per-proposal human approval.
- Completed: exposed bounded governance inspection, proposal, wait/detach, and rollback through the public protocol, `AgentClient`, and capability-scoped Console SDK. Added recovery, replay, family-authority, malformed-result, secret, conflict, retry, rollback, and staged-skill coverage.
- Validation: the deterministic full suite reported 887 passes, 3 gated skips, and 0 failures. Focused governance reported 43 passes; contract/profile/harness regressions reported 60 passes. Typecheck, architecture checks, and `git diff --check` passed.
- Plan notes: skill application is necessarily staged because compile and declared runtime tests are durable external effects. Reviewer approval records the candidate, tests run through the outbox, and only a passing retained result permits activation; recovery resumes each committed boundary without duplicating the reviewer, version, tests, or activation. Optional owner-configured workspace charter and user-constraint components remain unavailable and are pinned as `null` rather than inferred from ambient repository files.
- Remaining: installed-product governance acceptance, sync/export/deletion coverage, public documentation, and externally gated verification.

### 2026-08-09 — Phase 4: terminal profile controls

- Completed: added route-relative `agencity profile` and `/profile` operations for current-profile inspection, bounded history and diffs, exact prompt detail, pending and terminal proposals, proposal and reproposal, exact revision rollback, reviewer provenance, and durable detached notices. Distinct rejection, failure, unknown, conflict, and applied outcomes retain their exact reasons and revision guidance.
- Validation: 57 TUI unit tests, 16 CLI integration tests, and 46 protocol/governance integration tests passed. Typecheck, architecture checks, lints, and `git diff --check` passed.
- Plan notes: the no-ID terminal flow uses route-relative profile revision numbers and `latest|N` proposal selectors. Internal proposal and version IDs remain available in advanced diagnostics.
- Remaining: the linked-executable end-to-end governance journey, lifecycle hardening, documentation, independent review, aggregate verification, and gated external checks.

### 2026-08-09 — Phase 4: lifecycle hardening

- Completed: added managed-service recovery and deduplication coverage for governed review and terminal delivery; fail-closed offline profile-revision divergence with retained competing histories; workspace export auditing for profile, invocation-pin, proposal, frozen-review, decision, notice, restoration, and artifact provenance; governance-aware deletion planning and refusal; complete workspace erasure; and migration/rebuild reopen coverage.
- Validation: 106 focused lifecycle, migration, profile, and governance tests passed with 0 skips and 0 failures. Typecheck, architecture checks, lints, and `git diff --check` passed.
- Plan notes: exported bundles now include `export-audit.json`; missing required provenance or artifact dependencies make the manifest partial rather than successful. Concurrent offline profile claims remain explicit conflicts, and runnable profile lookup fails instead of inventing an active winner.
- Remaining: hard process-loss behavior at committed governance boundaries is covered by lower-level lifecycle tests; the installed-product journey uses graceful managed-service shutdown and restart.

### 2026-08-09 — Phase 4: installed governance acceptance

- Completed: added an isolated `bun link` journey using only the documented executable and public product paths. It proves exact root and child profiles, retained old/new invocation pins, blocking independent approval, exact reviewer rejection and guidance, bounded reproposal, immutable rollback, detached managed-service restart, deduplicated proposer/reviewer/application/notice behavior, and route-relative no-ID inspection.
- Validation: the focused journey reported 1 pass, 0 skips, and 0 failures; deterministic installed acceptance reported 15 passes, 1 credential-gated skip, and 0 failures; the release matrix reported 1 deterministic pass, 3 external skips, and 0 failures. Typecheck, architecture checks, and `git diff --check` passed.
- Plan notes: installed recovery uses graceful service shutdown and restart. Lower-level lifecycle tests supply hard process-loss evidence at committed boundaries.
- Remaining: final documentation reconciliation, independent review, aggregate `bun run verify`, and externally gated live-provider, official Turso Sync, and Turso Cloud checks.

### 2026-08-09 — Independent final-review focused fixes

- Completed: removed the public profile-approval preparation method and replaced it with a supervisor-internal capability. The storage transaction boundary now binds every local later profile version and activation to either the exact reviewed-approved proposal, decision, target, expected version, replacement content, principal, evidence, and atomic application event, or an exact atomic rollback event. Strict governed-proposal and frozen-input schemas, lifecycle cross-field checks, reviewer-child linkage, decision/application identity checks, terminal-notice equality, and missing row-count checks reject forged canonical transitions.
- Completed: made definitive freeze and reviewer-admission failures from `validated` terminal `review_failed` outcomes with one durable result. Unknown reviewer execution remains `review_unknown`. The reviewer now receives frozen limits of 16,384 tokens, USD 1, two runtime turn slots for one structured decision, and 120 seconds wall time; smaller parent budgets continue to refuse admission rather than being widened.
- Completed: bound revisions to one original rejected chain with the same principal, origin/trigger, target kind, scope, expected version, and intended target. Revisions require new immutable identity and substantive change, cannot revise another revision, and automatic chains permit at most one descendant. Rollback evidence for agents is checked against the caller's branch lineage; workspace-owner rollback may cite same-workspace evidence.
- Completed: replaced the newest-200 recovery scan with deterministic oldest-first pages of 200 that continue until all nonterminal proposals and terminal undelivered notices have been considered. Focused coverage includes more than 200 old proposals/notices, direct-service and forged-event activation bypasses, malformed lifecycle events, rebuild, maximum reviewer depth, each parent-budget dimension, freeze failure, reproposal-chain crossing, fork/ancestor/sibling evidence, owner evidence, and exact-once terminal delivery.
- Validation: the focused event/profile/refiner/recovery/storage/synchronization suite reported 94 passes, 0 skips, and 0 failures. `bun run typecheck`, `bun run check:architecture`, and `git diff --check` passed.
- Remaining risks: external live-provider behavior, official Turso Sync, and Turso Cloud remain unverified. Workspace-charter and user-constraint registration remains unavailable and frozen as `null`.

### 2026-08-09 — Plan completion verification

- Completed: reconciled the final-review fixes, public documentation, accepted ADR, capability claims, and implementation plan status with the shipped runtime and installed-product behavior.
- Validation: `bun run verify` passed with 893 deterministic core tests passing, 2 externally gated core skips, 15 installed acceptance tests passing, 1 credential-gated acceptance skip, and 0 failures. Aggregate evidence within the gate is 908 passes, 3 skips, and 0 failures. `bun run test:acceptance:matrix` reported 1 deterministic row passed, 3 external rows skipped, and 0 failures.
- Plan notes: the installed recovery journey uses graceful managed-service shutdown and restart; lower-level lifecycle tests cover committed hard process-loss boundaries. Reviewer approval establishes policy consistency, not empirical improvement.
- Remaining: live-provider, official Turso Sync, and Turso Cloud verification remains gated and unverified. Workspace-charter and user-constraint configuration remains unavailable and pinned as `null`; callers cannot select the reviewer. These are explicit product limits, not incomplete plan tasks.

### 2026-08-12 — Evidence-complete governance freezing

- Completed: changed new governance freezes to a strictly validated version-3 contract that gives every direct or refiner-produced proposal deterministic redacted evidence excerpts under one 32 KiB aggregate budget. The retained record carries canonical/redacted payload and excerpt digests, exact byte counts, truncation, and redaction provenance while excluding repository instruction content and brokered credentials. Version-1 and version-2 frozen inputs remain readable.
- Completed: retained the trajectory refiner's required objective evaluation in governed proposal identity, frozen input, inspection, and application history. Direct proposals may omit evaluation. Evaluation remains post-activation intent and does not gate ordinary application; generated skills keep the existing compile and declared runtime-test requirement.
- Validation: focused refinement-review, governance-hardening, and refiner suites passed with 128 passes, 0 failures, and 0 skips. Typecheck passed.
- Remaining: aggregate verification and externally gated live-provider, official Turso Sync, and Turso Cloud checks were not run for this focused change.

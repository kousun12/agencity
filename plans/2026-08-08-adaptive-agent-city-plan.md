# Adaptive agent city and organizational refactoring plan

**Status:** Proposed  
**Date:** August 8, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related plans:** [Workspace Agents view](./2026-08-08-workspace-agents-view-plan.md), [Ergonomic agent-family navigation](./2026-08-07-ergonomic-agent-family-navigation-plan.md), and [Lossless context-reference storage](./2026-08-07-lossless-context-references-plan.md)  
**Related decisions:** [Durable agent relationships](../docs/decisions/0006-durable-agent-relationships.md)

## Summary

Agencity evolves from durable agent families into a workspace-scoped **agent city**: a long-lived organization of durable agents whose roles, purposes, relationships, work, and changes remain attributable over time.

Every agent has a required, immutable, versioned **charter**. The charter defines the agent's bounded mandate: its role, mission, standing context, responsibilities, standing aspirations, operating principles, success criteria, delegation rules, escalation rules, and authority envelope. The charter contains the exact agent-specific system-prompt text supplied to the model whenever that agent runs. A task, conversation, retrieved memory, or compacted summary can add dynamic context, but none substitutes for the charter.

A charter is not a longer task prompt. A standing agent's mandate may continue indefinitely, but its goals, assignments, runs, and effects remain finite, budgeted episodes. The mandate does not authorize continuous execution or self-created work. When no admitted assignment or policy-authorized trigger capable of creating one is ready, the correct state is dormant.

Every child is created with a charter. Promptless child admission is invalid. A managing parent can revise a direct child's charter for future work, pause the child, or retire it within the authority inherited from the parent. Revisions never rewrite earlier work: each run pins one exact charter version, and every model call in that run uses it.

Each workspace has one distinguished **city operator**. The operator is the ordinary inbound route for the city. It can inspect the active organizational hierarchy and every agent charter, search the directory, route work to an existing agent, create a new functional agent, and propose changes to the organization. It does not receive every agent's complete history in its model context and does not gain unrestricted authority merely because it can inspect the directory.

Routing work to an existing agent creates a durable **assignment**. An assignment is not a plain follow-up message: it records the sponsor, target route, task, budget reservation, completion criteria, result delivery, cancellation, usage, and terminal outcome. This gives standing agents repeated work without pretending that their immutable creation task owns every future task.

The city adapts through retained evidence. Agents may propose new roles, charter revisions, management changes, splits, successors, pauses, or retirement. Organizational changes follow a governed proposal, validation, bounded evaluation, decision, and rollback process. The city does not treat a model's confidence, one successful task, or one failure as sufficient proof.

Retirement removes an agent from future routing, follow-up, schedules, and the default active hierarchy. It preserves the agent's charter history, origin, work, relationships, effects, and reasons for retirement. Retired agents remain available through explicit historical inspection but are not silently reactivated. A renewed function is represented by a new successor agent with an explicit lineage link.

The city has its own workspace-scoped canonical control stream. City state does not live on an operator conversation branch or in a mutable directory table. The control stream owns the operator pointer, active management hierarchy, charter and grant activation, session-wide lifecycle, service routes, assignment admission, organization revisions, and governance decisions. Agent conversations remain session/branch streams. All streams share the workspace's ordered canonical event universe.

The end state is not one model with every historical record in its prompt. It is one durable workspace institution containing many separately identified actors, plus a stable operator and directory through which the institution can be queried and changed. Finite work occurs inside continuing, revisable mandates; the institution persists even while all of its agents are idle.

## End-state shape

```text
user
  |
  v
city operator
  |-- queries active directory and exact charters
  |-- routes work to an existing agent
  |-- asks a manager to revise or reorganize a function
  `-- creates a new top-level function when no current agent fits

active management hierarchy
  |
  |-- engineering
  |     |-- implementation
  |     `-- verification
  |
  |-- research
  |     `-- evidence review
  |
  `-- operations

historical city record
  |-- immutable charter versions
  |-- creation and management lineage
  |-- tasks, branches, effects, artifacts, and evaluations
  |-- paused, retired, and superseded agents
  `-- organizational proposals and decisions
```

Agents are dormant when they have no admitted work. Long-lived identity means that an agent is reconstructable, addressable, inspectable, and eligible for future work; it does not require a continuously running process or language heap.

## Product vision

The ordinary product experience addresses the city rather than asking the user to manage chat sessions.

```sh
agencity "find and fix the flaky test"
```

The workspace resolves to its city operator. The operator interprets the request against the active directory:

1. route to an existing agent whose charter and evidence fit the request;
2. assemble work through an existing management hierarchy;
3. revise a direct function whose charter no longer matches its responsibilities;
4. create a new agent when no current role is suitable;
5. ask the user when the change requires broader authority or an irreversible organizational decision.

Routing to an existing agent admits a durable assignment with its own task, limits, and result path. Creation is reserved for work that needs a new identity, standing function, or isolated task agent.

Returning with `agencity` enters the same city operator. A user can navigate directly to an individual agent, but the observed route and the default inbound route are separate product state. Opening or remembering another route never silently redirects a later no-ID task away from the operator.

The city grows from observed need. A new workspace may begin with only the operator. Repeated work can justify specialization. Persistent failures, bottlenecks, or redundant roles can justify charter revision, a split, a successor, or retirement. The resulting organization is retained as history rather than reconstructed from the latest prompt or an undocumented convention.

The first implementation remains intentionally local and organizational. Agents execute on the same trusted machine and may use ordinary workspace files, artifacts, shell/file effects, and locally created databases when their runtime grants permit. Cross-agent work uses assignments and the retained family communication model. This plan does not add agent-published RPC interfaces, a shared city application-data plane, per-agent service hosting, or distributed agent placement.

## Verified current foundation

The current runtime already provides foundations that this plan extends:

- a `Session` is a durable actor with a model, budget, conversation, goals, branches, tasks, and event stream;
- child admission atomically retains parent and child identity, task intent, model, budget, initial prompt, and admission;
- parent, child, and sibling communication uses retained family mailboxes;
- child follow-up can reuse the same durable session after terminal task work;
- canonical history is append-only and projections are rebuildable;
- model calls receive attributable materialized context;
- prompt notes, skills, memories, and reusable subagent specifications are immutable, versioned harness entries;
- refinement supports evidence, proposals, candidate exposure, observations, promotion, rejection, and rollback;
- session status includes idle, running, stopped, failed, and archived;
- the proposed Workspace Agents view defines an owner-facing exact route hierarchy without broadening model-facing family authority.

The current runtime does not provide:

- a required per-agent system prompt;
- a durable charter attached to every session;
- exact charter-version pinning on every autonomous run;
- parent authority to revise a child's future system prompt;
- a distinguished workspace operator;
- a city-wide agent and charter directory;
- a separate active management hierarchy;
- durable assignments that send repeated tasks to existing agents;
- explicit pause, retirement, successor, split, merge, or reorganization semantics;
- evidence-driven organization proposals;
- automatic routing based on charter fit and retained performance.

Current reusable subagent specifications are templates, not agent identity. A specification's role and prompt are concatenated into the spawned child's initial task message. Ordinary child admission does not require a specification, and the child does not receive that content as a durable agent-specific system prompt.

Current prompt notes are optional harness context. They are not required identity, may be selected by scope, and are not compiled into the provider system message as an exact per-agent charter. They remain useful for adaptable tactics but do not replace this plan's charter model.

## Goals

- Give every root, delegated, and recursive agent a required durable charter before it can run.
- Express each charter as a bounded mandate rather than a task prompt or claim of perpetual execution.
- Keep enduring mission, responsibilities, and standing aspirations separate from finite goals, assignments, and runs.
- Supply the exact active agent charter as system-prompt content on every agent model call.
- Keep the global immutable runtime policy separate from agent-specific purpose.
- Preserve exact charter-version and effective-prompt provenance for every run and model effect.
- Let a managing parent revise a direct child's charter for future runs without rewriting past work.
- Let children propose changes to their own charter or organization without self-promoting them.
- Provide one distinguished city operator as the workspace's stable inbound route.
- Give the operator a bounded, queryable directory of every workspace agent and charter.
- Route repeated work to existing agents through durable assignments with budgets, gates, cancellation, usage, and terminal delivery.
- Keep model-facing directory access distinct from conversation-history and effect authority.
- Store city-wide state in a stable workspace control stream rather than an operator or conversation branch.
- Separate immutable creation ancestry from a versioned active management hierarchy.
- Support evidence-governed creation, revision, reparenting, splitting, succession, pausing, and retirement.
- Remove retired agents from normal routing and default active views while retaining inspectable history.
- Preserve local-first operation, explicit uncertainty, outbox effects, branch history, sync conflicts, and user authority.
- Make organizational evolution attributable, testable, reversible where possible, and explicit where irreversible.

## Non-goals

- Sending the complete city history, all charters, or every agent's context to every model call.
- Treating the whole workspace graph as one merged agent identity.
- Keeping every agent process, model connection, or console heap continuously alive.
- Giving the operator unrestricted file, credential, effect, budget, or deletion authority.
- Letting a parent remove immutable base policy or grant authority it does not possess.
- Letting an agent activate its own broader authority or approve its own retirement evidence.
- Rewriting historical prompts, contexts, branches, tasks, or effects after a charter revision.
- Inferring management authority from names, task text, timestamps, or graph proximity.
- Making arbitrary cross-agent messaging an authorization mechanism.
- Automatically merging divergent branches or organizational changes from offline writers.
- Claiming hosted multi-tenancy, hostile-code isolation, distributed scheduling, or execution-owner failover.
- Physically deleting retired agents as part of ordinary lifecycle management.
- Replacing reusable subagent specifications, memories, prompt notes, skills, or task goals with one oversized charter.
- Building an unbounded autonomous bureaucracy. Agent counts, depth, budgets, proposal rates, and evaluation exposure remain bounded.
- Treating management edges as mailbox, cancellation-tree, task-ownership, or budget-attribution edges.
- Claiming that charter text enforces an OS sandbox or technical permission boundary.
- Requiring agents to remain active, invent work, or spend budget merely because their mandate continues.
- Adding agent-published typed RPC, capability-contract registries, stable service bindings, or generated cross-agent service clients.
- Adding a canonical city application-data plane or mixing agent-defined tables into the runtime's canonical event database.
- Provisioning per-agent virtual machines, containers, databases, TCP endpoints, or supervised application services.
- Distributing active city agents across hosts or treating network placement as part of agent identity.

## Design principles

### Identity is durable; execution is episodic

An agent remains a durable session identity. Runs, provider calls, console workers, schedules, and terminal attachments are temporary activity associated with that identity.

### Purpose is explicit

No agent is admitted with only a task string. The runtime can answer:

- Why does this agent exist?
- What is its standing mission?
- What work should and should not reach it?
- Who created it?
- Who currently manages it?
- Which charter version governed a particular action?
- Which evidence justified a revision or retirement?

### Static purpose and dynamic work are separate

The charter contains durable identity and standing context. The current task, recent observations, messages, retrieved memories, working values, and artifacts remain dynamic execution context.

### Mandates continue; work terminates

A standing charter expresses a continuing responsibility, not an endless run. Goals describe desired states. Assignments fund and authorize finite units of work. Runs are bounded attempts to advance one assignment. Effects are individually admitted external actions.

Completion is local to a goal, assignment, or run. It does not imply that a standing mandate has ended. Conversely, a continuing mandate does not permit an agent to create work, reserve budget, or remain active without an admitted assignment or a policy-authorized trigger that creates one.

### Quiescence is valid

An idle city is not failing. Agents remain reconstructable and eligible for later work while consuming no model or console execution. Standing aspirations may inform future goals when authorized capacity exists, but they do not create an obligation to generate activity. The runtime must not reward busywork or infer that unused budget should be spent.

### Organizational power follows an explicit tree

Every active agent except the operator has one active managing parent. That tree determines ordinary charter and lifecycle authority. Additional collaboration, citation, successor, and task edges do not grant management power.

### Creation history never changes

The session's original parent session, parent branch, root session, depth, and task remain immutable provenance. Reparenting changes the active management edge, not who created the agent.

### Revisions append

Charters, management edges, lifecycle decisions, and organizational proposals are immutable versions or events. Current pointers are projections. Earlier model calls continue to resolve the exact version they used.

### Adaptation requires evidence

Observed outcomes may trigger a proposal. They do not directly mutate the organization. Promotion requires predeclared evaluation, attributable observations, scope-appropriate authority, and conflict checks.

### Retirement is not deletion

Retirement ends future participation. History remains. Physical erasure continues to use the separate guarded owned-scope deletion system.

### Visibility is not authority

The city operator can inspect all agent charters and directory metadata. This does not automatically grant access to all messages, artifacts, secrets, working values, or effects.

## Terms

- **City:** One workspace-scoped durable agent organization.
- **City control stream:** The workspace-scoped canonical aggregate that owns city revisions, the operator pointer, charters, management, lifecycle, assignments, and organization decisions independently of conversation branches.
- **City head revision:** The portable identity of the latest accepted city-stream event, including proposals, locks, and in-progress transitions.
- **Stable organization revision:** The city head revision at which the current operator, charter, grant, management, lifecycle, and service-route pointers last committed as a valid organization state.
- **City operator:** The single distinguished agent that receives ordinary inbound work and coordinates the city.
- **Agent:** A durable `Session` identity. The plan does not introduce a second competing agent identity above sessions.
- **Route:** One exact `(sessionId, branchId)` execution history.
- **Charter:** The durable definition of an agent's purpose and operating boundaries.
- **Mandate:** The continuing or assignment-bounded responsibility expressed by one active charter. It is not a separate domain aggregate.
- **Standing aspiration:** A bounded, role-defining direction recorded in a charter. It may motivate later goals but has no independent execution, budget, priority, or completion lifecycle.
- **Charter version:** One immutable charter revision with exact system-prompt text and provenance.
- **Effective system prompt:** The exact provider-facing system content composed from immutable base policy, one charter version, the invocation-specific response/run-control contract, and its execution guidance.
- **Creation parent:** The session and branch that admitted the agent. This relationship is immutable provenance.
- **Managing parent:** The agent currently authorized to manage the child. This relationship is versioned and can change.
- **Active hierarchy:** The current managing-parent tree rooted at the city operator.
- **Directory:** A rebuildable workspace projection of agents, active charters, hierarchy, lifecycle, routing metadata, evidence summaries, and retained routes.
- **Assignment:** A durable task relationship that sends new work to an existing agent and retains sponsor, target route, budget, completion, cancellation, usage, result, and lifecycle.
- **Standing agent:** An active agent eligible for repeated directory routing and assignments.
- **Task agent:** An assignment-scoped agent created for one bounded task and retired after its disposition decision. A recurring function becomes a new standing successor rather than changing the task agent's identity.
- **Rotation:** Eligibility for ordinary routing, schedules, follow-up, and new autonomous work.
- **Organization proposal:** A durable request to create, revise, pause, resume, reparent, split, supersede, or retire agents.
- **Successor:** A new agent that continues some or all of a retired or superseded function without reusing the old identity.
- **Retired archive:** Historical agents omitted from normal active views and routing but available through explicit inspection.

## Normative invariants

The following rules govern every later section:

1. A runnable agent has exactly one active charter version. A retained legacy agent without a confirmed charter is non-runnable.
2. Charter-version content is immutable. Candidate, active, rejected, retired, and rolled-back state is derived from separate canonical events.
3. Every run pins one charter version and exact effective system-prompt content before model-effect admission.
4. Candidate evaluation may pin an explicitly allocated candidate charter. Unallocated work continues to use the active charter.
5. Dynamic tasks, assignments, messages, memories, and observations do not mutate agent identity.
6. Every new agent is either `standing` or `task`. A task agent accepts only its creation assignment, then retires after a bounded disposition period.
7. Every charter revision creates a proposal. Validation and approval are mandatory; evaluation depth depends on the change's impact.
8. A managing parent decides ordinary direct-child charter changes within inherited ceilings. A child cannot activate its own revision.
9. Management hierarchy does not change immutable creation family, mailbox reach, cancellation trees, root identity, or historical budget attribution.
10. Cross-family work uses a typed assignment. It does not broaden general messaging.
11. The city control stream is the only authority for current operator, charter, management, lifecycle, assignment, and organization revisions.
12. Every city command compares `cityHeadRevision`; organization activation also compares `stableOrganizationRevision`. Partial transitions advance the head and may hold admission locks without changing stable organization pointers.
13. Only the city governance owner may activate city mutations. Cross-owner execution is unavailable; synced conflicting activations produce explicit conflict.
14. Charter authority declarations are behavioral policy. Enforceable model, budget, SDK, credential, and effect grants use separate runtime controls. Trusted-local OS authority is not sandboxed.
15. Session-wide lifecycle is checked at every run, assignment, assignment-steering, schedule, wake, spawn, and effect-admission boundary, including recovery.
16. Retirement blocks future execution but permits narrowly classified recovery, effect reconciliation, sync, export, deletion planning, and historical annotation.
17. Retired agents remain explicitly enumerable by the operator and owner, although normal routing and active views exclude them.
18. Internal canonical transitions are completed, blocked, failed, conflicted, or partially applied and recoverable. `unknown` remains reserved for external effects whose outcome cannot be proven.
19. A continuing mandate never admits execution by itself. Every ordinary run resolves to a finite assignment; narrowly classified recovery and control actions retain their own explicit work records.
20. Standing aspirations do not reserve budget, create assignments, or authorize effects. Any work derived from one follows ordinary goal, assignment, grant, and budget admission.
21. No agent process or model call remains active solely to preserve agent identity. Quiescent agents reconstruct from durable state when admitted work arrives.

## Core identity decision

`Session` remains the executable agent identity.

This preserves the existing durable actor model:

- one session owns model configuration, budget, goals, conversation, branches, child work, and lifecycle;
- assignments address the same standing agent rather than instantiating a new role object for every task;
- branches remain alternate histories of that agent;
- effects, context, tasks, and mail retain current ownership semantics.

Each runnable session receives exactly one charter entry with one active version. A runnable session cannot have two active charters. A retired or imported historical agent retains its last effective or historical-unknown charter record without an active runnable pointer. Reusable subagent specifications remain templates that can produce new agent charters; they are not the resulting agent's identity.

A future cross-workspace marketplace or profile-level institutional agent may require identity above a workspace session. That is outside this plan because it introduces different ownership, sync, credential, deletion, and governance boundaries.

## City initialization and operator

### One operator

Every initialized city has exactly one active operator session and one designated operator route.

The operator:

- is the ordinary no-ID product entrypoint;
- owns a charter like every other agent;
- appears at the root of the active management hierarchy;
- can inspect the complete workspace agent and charter directory through bounded queries;
- can delegate ordinary work within city policy;
- can create top-level managed functions within budget and authority;
- can propose or activate permitted organizational changes;
- cannot broaden immutable runtime or user authority;
- cannot approve its own authority expansion, replacement, or retirement.

### Operator charter

The initial operator charter is created from a sealed product template plus explicit user configuration. Model output cannot silently define the operator's initial authority.

The operator charter includes:

- mission to receive, understand, route, coordinate, and synthesize workspace work;
- obligation to prefer existing capable agents before creating redundant agents;
- obligation to query bounded directory evidence rather than infer expertise from names;
- permission to create and manage agents only inside the workspace's declared limits;
- escalation rules for user approval;
- prohibition on treating visibility as execution authority;
- obligation to leave agents dormant rather than invent work when no authorized assignment or policy-authorized trigger capable of creating one is ready;
- evaluation criteria for routing quality, duplication, unresolved work, cost, and user correction.

### Operator succession

Replacing the operator is a user-authorized atomic city transition:

1. create or select the successor agent and charter;
2. validate that the successor can satisfy the operator contract and that promoting it cannot create a management cycle;
3. pause ordinary organization mutations;
4. remove the successor's prior management edge and transfer the operator pointer and active top-level management edges;
5. reparent the predecessor beneath the successor as paused, or retire it under the same approved transition;
6. resume organization mutations under the new operator.

There is never more than one active operator at one stable organization revision. The outgoing operator cannot approve its own successor.

## Agent charter model

### Required fields

Each immutable `AgentCharterVersion` contains:

```ts
interface AgentCharterVersion {
  charterVersionId: string;
  agentSessionId: string;
  revision: number;

  name: string;
  role: string;
  mission: string;
  responsibilities: string[];
  nonResponsibilities: string[];
  standingContext: string[];
  standingAspirations: AgentCharterAspiration[];
  operatingPrinciples: string[];
  successCriteria: AgentCharterCriterion[];
  delegationPolicy: AgentDelegationPolicy;
  escalationPolicy: AgentEscalationPolicy;
  authorityEnvelope: AgentAuthorityEnvelope;
  routingMetadata: AgentRoutingMetadata;

  exactSystemPrompt: string;
  promptContractId: "agencity.agent-charter.v1";
  promptDigest: string;

  createdBy: CityPrincipalReference;
  sourceSpecEntryId: string | null;
  sourceSpecVersionId: string | null;
  proposalId: string | null;
  evidenceEventIds: string[];
  supersedesCharterVersionId: string | null;
  createdAt: string;
}

type CityPrincipalReference =
  | { kind: "user"; profileId: string }
  | { kind: "agent"; sessionId: string; branchId: string }
  | { kind: "system"; componentId: string; version: number };

interface AgentCharterAspiration {
  aspirationKey: string;
  direction: string;
  evidenceSignals: string[];
}
```

The exact field limits and nested schemas are domain constants. Every string and collection is bounded before canonical admission. Known secret values, credential-shaped values, and brokered credential references that would reveal secret material are rejected.

Version status is not stored in immutable charter content. Activation, candidate allocation, rejection, retirement, and rollback are separate canonical city events and rebuildable projections.

### Exact prompt materialization

The runtime validates the structured charter and materializes `exactSystemPrompt` at version creation. Historical prompt text does not depend on a later renderer implementation.

The prompt uses stable labeled sections:

```text
AGENT IDENTITY
Name: ...
Role: ...
Mission: ...

RESPONSIBILITIES
...

OUT OF SCOPE
...

STANDING CONTEXT
...

STANDING ASPIRATIONS
...

OPERATING PRINCIPLES
...

SUCCESS AND EVALUATION
...

DELEGATION AND ESCALATION
...

AUTHORITY BOUNDARY
...
```

Structured fields support directory queries, validation, diffs, and evaluation. The exact rendered text is the provider-facing identity contract.

### Standing context

`standingContext` contains bounded facts that should accompany every run because they are part of the agent's durable function. It is not a copy of the full workspace, conversation, or memory store.

Examples include:

- the subsystem or domain the agent owns;
- durable architectural constraints specific to the role;
- the expected audience or artifact type;
- stable dependencies and handoff boundaries;
- important historical decisions that define the function.

Task-specific data, changing repository state, recent failures, and large evidence belong in dynamic context or referenced artifacts. A standing fact that becomes stale requires a charter revision with evidence.

### Mandate and standing aspirations

The charter's mission, responsibilities, exclusions, standing aspirations, success criteria, and escalation rules together express the agent's mandate. `mandate` is explanatory language for this combined meaning, not another stored object beside the charter.

A standing aspiration describes a durable direction such as reducing recurring incident classes, improving evidence quality, or shortening feedback time without weakening correctness. It belongs in the charter only when removing it would materially change the agent's purpose. The list is bounded and may be empty, especially for task agents.

Standing aspirations deliberately omit mutable portfolio state: current priority, funding, deadlines, progress, attempts, blockers, and terminal status. Those belong to goals and assignments. An aspiration can produce work only when an authorized sponsor creates or funds a finite goal or assignment through ordinary admission. Revising, adding, or removing an aspiration is a behavioral charter revision.

### Charter and task separation

A charter answers, “Who is this agent and how does it operate?”

A task answers, “What work should this agent do now?”

A goal answers, “What finite desired state should this admitted work advance?”

The same standing agent can receive many assignments and tasks under one charter. A new assignment does not revise the charter. A charter revision does not retroactively alter earlier assignments or tasks.

The conceptual ordering is:

```text
immutable base policy
  -> agent charter and mandate
  -> finite goal
  -> finite assignment
  -> bounded run
  -> admitted effects
```

Not every assignment requires a distinct persisted goal, but every run has one attributable finite work source. No layer may use the continuing mandate to bypass the authority, budget, cancellation, or completion rules of the layers below it.

The immutable creation task explains why a child session originally came into existence. It does not own every later unit of work. Later routed work uses the assignment aggregate defined below.

For initial child work, the creation task references the initial assignment and both projections share one reservation, usage attribution, result, and cancellation source. They are not two independently billed executions.

### Standing and task agents

A parent declares the new agent kind at creation:

- **standing:** a durable function eligible for repeated routing and assignments;
- **task:** an assignment-scoped specialist created for one bounded unit of work.

Standing agents carry continuing mandates until revision, pause, succession, or retirement. Task agents receive complete charters because every model actor needs explicit purpose, but their mandate is bounded by their creation assignment and disposition policy. They are excluded from normal standing-function routing. After the creation assignment becomes terminal, they enter `disposition_pending`; the manager may use their evidence to propose a new standing successor, but the task-agent identity itself retires.

This distinction preserves complete prompt provenance for recursive and one-off children without filling the active city hierarchy with every historical helper.

### Charter and subagent specification separation

A `subagent_spec` remains a reusable template. It may supply default charter fields, model policy, budget policy, completion criteria, and routing metadata.

Spawning from a specification:

1. resolves and pins one active specification version;
2. materializes a complete charter version;
3. applies explicit parent-provided narrowing or specialization;
4. validates that no field widens the parent's authority;
5. atomically creates the child session, charter version, task, initial message, and admission;
6. records both specification and charter provenance.

The child subsequently owns its charter history. Replacing the reusable specification does not silently rewrite already-created agents.

## Durable assignments

### Purpose

An assignment sends a new bounded task to an agent. It is the finite unit through which a standing mandate receives funded work and the city-wide equivalent of durable delegated work without changing the target's creation parent or granting arbitrary cross-family messaging.

Each assignment records:

- assignment ID and idempotency key;
- sponsor principal and sponsoring manager;
- target session and exact service route;
- task, inputs, allowed artifact references, and completion criteria;
- goal and completion gates;
- reserved token, cost, turn, and wall-time budget;
- assignment admission mode;
- target charter and grant versions resolved at claim;
- lifecycle, cancellation intent, usage, result, artifacts, and terminal delivery;
- city head and stable organization revisions, authority, and routing-decision provenance.

### Assignment lifecycle

```text
proposed
  -> admitted
  -> queued
  -> claimed
  -> running
  -> waiting_for_sponsor -> queued
  -> attention -> queued | failed | cancelled
  -> completed | failed | cancelled | budget_exceeded
```

`waiting_for_sponsor` retains a blocked model result that needs clarification or steering; it is not a new task and does not auto-retire a task agent. `attention` retains an unresolved external effect, stale target, or other condition that requires reconciliation. Assignment state never converts an external unknown effect into an invented result.

A queued assignment can be cancelled before any run. Terminal states are immutable; a distinct later unit of work creates another assignment.

### Admission modes

The runtime validates one explicit mode:

- **ordinary:** target is an active standing agent on its current service route;
- **creation:** target session, service route, charter, grants, lifecycle, management edge, and initial assignment commit atomically for a new task or approved standing agent;
- **candidate-charter:** target is an active standing agent, and one valid candidate allocation authorizes a bounded trial charter for this assignment.

New-function evaluation uses one or more task agents, each with its own creation assignment, rather than a separate candidate-agent lifecycle. Evidence across those bounded agents may justify creation of a new standing successor with explicit `derivedFrom` links. An explicitly user-directed or manager-authorized standing creation can activate directly after its creation proposal is approved.

### Service route and queue

Every runnable agent has one city-designated service route. The initial branch is the default service route at creation. Changing it is a city proposal and does not reinterpret earlier assignments.

Assignments to one agent are serialized on the service route:

- one assignment may be claimed or running at a time;
- additional assignments queue by declared priority and then canonical city sequence;
- claim atomically pins current city head, stable organization revision, service route, charter, grant, budget, and run identity after checking all active locks;
- a stale route, charter incompatibility, pause, revocation, or ownership change blocks claim before context delivery;
- the same assignment can return from `waiting_for_sponsor` or reconciled `attention` to the queue;
- simultaneous work requires delegation to child agents or a separately chartered standing agent, not two interleaved runs on one agent branch.

This preserves one coherent long-lived conversation for the agent while keeping assignment observations attributable. Branches remain available for historical inspection and counterfactual work but are not routable unless the city explicitly designates one as the service route.

### Budget and completion

The assignment sponsor owns the economic reservation and charge.

- The workspace owner establishes the city-level user-work budget and any separately bounded improvement capacity.
- Managers allocate only delegated portions of that budget; a charter or standing aspiration carries no economic reservation.
- A manager-sponsored assignment reserves from that manager's delegated assignment budget.
- A user-sponsored assignment reserves from the city user-work budget.
- The assignment ledger receives direct provider/tool usage and is the sole economic charge record.
- Session, manager, creation-family, and city totals are attribution projections over that charge, not additional debits.
- The initial child task and creation assignment share one reservation and one usage source.
- Child agents or assignments created while assignment `A` is running carry `fundingAssignmentId: A`.
- Delegated child reservation must fit both `A`'s remaining delegation allowance and the applicable manager/city ceiling.
- Child usage is one economic charge against `A`'s reservation with hierarchical attribution; it is not charged again to a general delegated budget.
- Unused reservation returns to the sponsor at terminal status.
- Unknown provider usage consumes the unresolved reservation conservatively.
- Duplicate terminal or ancestor attribution is a no-op.

Completion gates run against attributable workspace state. Terminal result delivery is a typed assignment notice to the sponsor. It does not rely on general cross-family mailbox permission.

### Authority and communication

Assignment admission validates:

- the sponsor may assign work to the target;
- the admission mode permits the target kind and lifecycle;
- the target route and charter are current;
- model, runtime grants, and budgets are compatible;
- inputs and artifacts are explicitly allowed;
- the target execution owner is the city governance owner.

Assignment communication is limited to task steering, receipts, result delivery, cancellation, and authorized artifacts for that assignment. Existing family mailboxes and cancellation trees retain their current creation-family semantics.

Every new unit of work uses an assignment, including work from a creation-family parent. `followUp` is either steering or clarification on one nonterminal assignment, or a client convenience that creates a new assignment after normal validation. It never starts an unrelated run by appending a message alone. Task agents accept only their creation assignment and its nonterminal steering; they never receive unrelated assignments or schedules.

### Recovery

Assignment admission and budget reservation commit before execution. Assignment claim atomically records the run identity, charter and grant pins, and target-context delivery before the run advances. Recovery resumes the same queued, claimed, waiting, attention, or running assignment without duplicate model calls or usage attribution. Cross-owner or unavailable targets fail before admission.

## Provider context composition

### Fixed ordering

Every autonomous model request receives one deterministic effective system prompt in this order:

1. immutable Agencity base policy;
2. exact pinned agent-charter system prompt;
3. immutable invocation-specific response-contract and run-control policy;
4. immutable execution guidance required by that invocation.

Dynamic task and run input follow as user/tool context. Retained conversation messages, selected memories, skills, mailbox messages, artifacts, and observations retain their current roles and provenance.

Provider adapters must not reorder, omit, summarize, or reinterpret the charter layer. If a transport requires one system message, the runtime concatenates the four layers with stable delimiters. If it supports several system blocks, the provider-neutral materialization still records one canonical ordered effective prompt and digest.

The invocation-specific layer is not always the ordinary `bun_console`/`finish` contract. Autonomous runs, structured refinement children, context compaction, and retained recursive calls keep their exact response admission and capability contract. Every invocation still receives the agent charter unless a non-agent internal model operation is explicitly classified outside the durable session model.

### Run pinning

`AgentRunRequested` pins:

- `charterVersionId`;
- `charterPromptDigest`;
- `grantVersionId`;
- exact immutable references to every effective system-prompt component;
- exact composed effective system-prompt content or a verified content-addressed definition;
- effective system-prompt digest;
- base-policy version;
- invocation response-contract version;
- execution-guide version.

Every step and model effect in that run uses the same charter and grant versions, subject to explicit revocation barriers. A parent revision or grant expansion activated while a run is in progress applies only to later runs. Changing a charter does not mutate the model identity halfway through a task.

Steering on a nonterminal assignment may start its next run after claim and resolves the assignment's valid charter/grant policy. A new task or schedule tick creates a new assignment; it cannot start a run through an unscoped follow-up message. A schedule does not permanently preserve a stale charter unless it explicitly declares and validates a version pin.

A candidate allocation may explicitly pin a candidate charter version for one bounded trial run. The run records allocation ID, candidate version, active control version, exposure ordinal, and decision authority. Runs without a valid candidate allocation continue to pin the active charter.

### Historical system-role messages

Retained `MessageAppended` rows with role `system` remain historical conversation records. The provider-context builder represents them as quoted historical data with role and event provenance, not as later provider system instructions. They cannot replace, override, or follow the canonical effective system message as instructions. New runtime policy should prefer typed wake, schedule, task, and control records over arbitrary system-role messages.

### Inspection and provenance

For every agent model call, diagnostics can show:

- active agent identity;
- exact charter version and digest;
- exact runtime-grant version and revocation checks;
- exact effective system-prompt content and digest;
- charter creator and proposal;
- management parent at run admission;
- dynamic context sources;
- model, tool contract, and provider dispatch.

Compaction may summarize conversation narrative. It never removes, summarizes, or replaces the immutable prompt components needed to reproduce a model call. Export and recovery resolve the exact effective system content without depending on current source-code constants.

## Agent creation

### No promptless admission

Every child-creation surface requires a complete charter or a version-pinned template that deterministically produces one:

- `sdk.agents.spawn`;
- `sdk.agents.spawnMany`;
- `sdk.specs.spawn`;
- `rlm.start`;
- `rlm.startMany`;
- refinement children;
- scheduler-created agents;
- product and protocol child admission.

A bare task string is no longer a valid child-admission request. Compatibility helpers may construct an explicit charter draft in client code, but the canonical command always contains a validated charter.

Every request also declares `agentKind: "standing" | "task"`. Recursive calls and one-off delegated helpers default only at the client-helper layer to an explicit task-agent charter template; canonical admission never infers an agent kind or system prompt from task prose.

### Required parent decisions

Before creating a child, the parent defines:

- role and mission;
- standing context;
- responsibilities and exclusions;
- bounded standing aspirations, which may be empty;
- completion and quality expectations;
- authority and data scope;
- model and budget envelope;
- delegation and escalation policy;
- routing labels and invocation criteria;
- whether the child is a standing function or task agent.

The initial task remains separate and can be narrower than the standing mission.

### Creation governance

A parent may create a task agent directly inside its child-count, assignment-budget, model, and runtime-grant ceilings. The creation assignment is the bounded evaluation and execution scope.

Standing-agent and successor creation require an organization proposal. Recurring-demand evidence and candidate task-agent outcomes support autonomous approval. Explicit user direction may authorize standing creation without repeated historical demand, but all charter, grant, budget, hierarchy, capability, and secret checks still apply.

### Atomic admission

Novel child admission atomically commits:

- parent task;
- child `SessionCreated`;
- city-stream charter-version and activation events;
- city-stream grant-version and activation events;
- city-stream agent kind, lifecycle, and initial managing-parent edge;
- city-stream service-route designation;
- initial assignment request, admission, and queueing;
- subagent admission;
- optional specification invocation.

The storage transaction spans the agent session stream and city control stream under the city governance fence and the new target root's admission fence. It stops at a durable queued assignment. The ordinary assignment scheduler then claims it through the same `AssignmentClaimed` → `AssignmentContextDelivered` → `AgentRunRequested` path used for existing agents. An idle target may be claimed immediately in a second idempotent transaction, but no special creation path bypasses queue, grant, context, or run pinning.

A crash cannot leave a runnable child without a charter or a chartered child without its retained creation relationship and queued work. Idempotency-key reuse must agree on every durable field, including agent kind, complete charter and grants, management edge, service route, assignment, and prompt digest.

## Charter revision authority

### Direct-parent rule

The active managing parent can create a charter proposal and decide an eligible revision for a direct child.

This authority is durable and available throughout the relationship, including after the child's initial task completes. It is subject to these constraints:

- the revision cannot exceed constitutional ceilings, the manager's delegated ceiling, or enforceable runtime capability policy;
- the revision cannot alter immutable base policy or safety constraints;
- the revision cannot change creation ancestry;
- the revision cannot rewrite an active run's pinned charter;
- the revision uses compare-and-swap against the child's current charter version;
- the revision records reason, author, evidence, and exact old/new versions;
- conflicting concurrent revisions remain explicit and do not use last-write-wins.

“A parent can always revise its child” means the parent retains management authority over future work while the management edge is active. It does not mean that the parent can falsify historical prompts, interrupt a provider call without cancellation, or bypass higher-level policy.

Every revision has a proposal and validation record. Evaluation requirements depend on impact:

- **metadata-only correction:** changes display or directory metadata while preserving byte-identical `exactSystemPrompt`, grants, routing, responsibilities, and evaluators; the manager may activate after validation and retained reason;
- **behavioral revision:** changes any provider-facing prompt text, mission, standing context, responsibilities, routing, delegation, or evaluation; requires bounded candidate exposure and observations;
- **grant revision:** changes enforceable model, budget, SDK, credential-reference, data, or effect grants; requires grant-policy validation and the higher authority that owns the applicable ceiling;
- **constitutional revision:** changes immutable base policy, trusted-local boundary, user authority, or operator constitution; unavailable to agents and ordinary managers.

### Child self-revision

An agent may propose a revision to its own charter. It cannot activate that revision. The managing parent evaluates and decides it. The operator or user decides when no valid manager exists.

A proposal about the agent's managing parent is routed to the next higher manager. A proposal about the operator routes to the user. Every pending bottom-up proposal is visible to the operator and owner, so a direct manager cannot make it disappear by ignoring it.

### Descendant and sibling rules

- A manager directly changes only direct children.
- A manager can ask a child manager to revise a deeper descendant.
- The operator may propose a change anywhere in the city.
- The operator may directly activate a descendant change only when its charter and city policy grant that intervention authority.
- Siblings cannot revise one another.
- Management authority does not follow mailbox, artifact, branch, or task edges.

### User authority

The workspace owner can inspect and revise any charter. User changes still append new versions, preserve provenance, and obey immutable safety and secret-handling rules.

Operator charter expansion, operator succession, permission-boundary expansion, cross-workspace scope, and irreversible retirement of protected functions require explicit user approval.

### Authority ceilings

Authority has four distinct layers:

1. **Constitutional ceiling:** immutable product safety, user authority, trusted-local disclosure, and unavailable capabilities.
2. **City ceiling:** workspace model/provider allowlists, aggregate budgets, SDK capabilities, credential references, data scopes, and effect policy.
3. **Manager-delegated ceiling:** the maximum enforceable grants a manager may delegate to a child.
4. **Current child grants:** the exact runtime grants active for the child.

A charter describes expected behavior inside those grants. Runtime services enforce model, budget, SDK, credential-reference, data, and effect grants. Because trusted-local Bun and shell execution retain ambient OS authority, a charter cannot truthfully claim filesystem or network sandboxing that the runtime does not implement.

A child revision may narrow current grants. Expansion above current grants requires the authority that owns the next ceiling and cannot exceed the manager's delegated ceiling. Reparenting validates the complete descendant closure; agents whose grants do not fit the new chain must be narrowed through approved revisions or paused before the new edge activates.

## Runtime grant model

Charter language and enforceable runtime grants are separate versioned records.

Each immutable `AgentGrantVersion` contains:

- allowed model/provider and reasoning configurations;
- per-assignment and aggregate budget ceilings;
- SDK capabilities;
- opaque credential references and allowed uses;
- data and artifact scopes;
- effect categories and approval requirements;
- delegation ceilings;
- source policy, acting principal, evidence, and superseded version.

The city control stream owns grant-version creation, activation, revocation, rejection, and rollback events. Rebuildable projections expose one active grant version for every runnable agent. Grant versions use compare-and-swap and cannot exceed the complete active management chain.

Assignment claim and `AgentRunRequested` pin both charter and grant versions. Every effect request records the pinned grant version, city head, and stable organization revision used for admission.

Grant changes follow these rules:

- expansion applies only to later assignment claims and runs;
- ordinary narrowing applies to later runs and blocks incompatible queued assignments;
- security, credential, or publication revocation creates an immediate revocation barrier;
- an active run rechecks revocation barriers before its next cell, tool, model, file, shell, or other effect admission;
- the outbox rechecks the barrier atomically when claiming a pending effect and immediately before committing `EffectAttemptStarted`;
- a revoked effect with no committed attempt receives a canonical cancelled outcome and is never dispatched externally;
- revocation and outbox attempt-start use compatible fencing so neither can pass on a stale city head;
- already-started external effects retain their real terminal or unknown outcome;
- no revocation rewrites prior effect authority or provider input;
- descendant grants that exceed a new parent or city ceiling are narrowed through approved versions or the affected agents are paused.

A charter proposal that changes only behavioral text cannot alter grants. A grant proposal may be linked to a charter proposal, but each has its own immutable version, authority validation, activation, run pin, and rollback.

## Organizational hierarchy

### Two relationship layers

The city preserves two distinct structures:

1. **Creation ancestry** — immutable session/task provenance from `SessionCreated` and `TaskCreated`.
2. **Management hierarchy** — versioned current authority and routing structure.

Creation ancestry answers “How did this agent come to exist?” Management hierarchy answers “Who manages this function now?”

### Active hierarchy invariants

- exactly one operator is the root;
- every other active, paused, disposition-pending, or retiring agent has exactly one managing parent;
- management edges remain inside one workspace;
- the active management graph is acyclic;
- retired agents cannot manage active agents;
- management depth and direct-report counts are bounded;
- a management change cannot silently expand authority;
- missing or conflicting edges produce an unavailable or attention state, never an inferred parent.

Management edges do not change `rootSessionId`, immutable creation tasks, family mailbox reach, cancellation trees, or historical budget attribution. Cross-family execution uses assignments. Family operations continue to follow ADR 0006.

### Reparenting

Reparenting changes only the active management edge.

The command records:

- agent;
- previous and new managing parent;
- expected city and charter revisions;
- reason and evidence;
- authority transfer;
- treatment of current child agents;
- effective time;
- proposal and decision provenance.

Open runs continue under their pinned charter and admission authority. New work uses the new management relation. Pending parent-to-child management commands either complete before the edge change or fail with a stale-revision error.

Before activation, the runtime validates the affected agent and descendant grants against the new management chain. Incompatible descendants are explicitly narrowed, reparented, or paused. The edge does not activate with an invalid authority closure.

### Organization decision authority

Multi-agent changes use this approval rule:

| Change | Required decision authority |
| --- | --- |
| Task-agent creation inside current limits | Creating parent |
| Standing-agent creation | Manager with delegated standing-create authority and recurring-demand evidence, or explicit user direction |
| Standing successor based on task-agent evidence | Authority required for standing creation plus the source task agents' manager |
| Other successor creation | Authority required for standing creation plus the source function's retirement/split authority |
| Direct-child charter revision inside current grants | Current managing parent |
| Direct-child grant expansion inside manager ceiling | Authority that owns the expanded grant ceiling |
| Reparenting | Old manager and new manager consent; nearest common manager decides |
| Split | Current manager; operator decides when new agents cross manager boundaries |
| Merge | Nearest common manager; operator decides across top-level functions |
| Pause or resume | Current manager |
| Retirement | Current manager, plus user approval for protected or top-level functions |
| Operator succession or retirement | User |

The affected agent may attach an objection or alternative proposal, but it does not veto an ordinary in-scope management decision. If the required managers disagree or the nearest common manager is unavailable, the proposal becomes blocked and escalates to the operator or user according to the hierarchy.

Task-agent creation is the bounded direct-delegation path and does not require evidence of recurring demand. Standing and successor creation require an organization proposal. Explicit user direction supplies decision authority and may replace recurring-demand evidence, but it does not bypass charter, grant, budget, hierarchy, or secret validation.

### Functional split

A split creates two or more new agents with narrower charters and explicit `derivedFrom` links. Work is allocated to the candidates under bounded exposure. The source agent remains active or paused until evaluation decides whether to:

- keep the source and new specialists;
- revise responsibilities;
- route new work only to successors;
- retire the source.

The city never divides one session's history into several rewritten identities.

### Functional merge

A merge creates one successor agent whose charter explicitly cites the contributing agents. The contributing agents remain retained and are paused or retired after handoff. Their histories are not copied into or attributed to the successor.

### Successor lineage

Successor links are typed and directional:

- `replaces`;
- `splits_from`;
- `merges_from`;
- `inherits_function_from`.

Lineage supports navigation and context retrieval. It does not grant authority or make histories interchangeable.

## Lifecycle and retirement

### Agent lifecycle

Agent lifecycle is separate from task status and current session activity.

| State | New assignment | Assignment steering | Schedules | Default directory | Historical inspection |
| --- | --- | --- | --- | --- | --- |
| `active` | allowed | allowed | allowed | visible | visible |
| `paused` | rejected | rejected | suspended | visible with reason | visible |
| `disposition_pending` | rejected | rejected | disabled | visible with decision due | visible |
| `retiring` | rejected | rejected | disabled | visible as attention | visible |
| `retired` | rejected | rejected | disabled | hidden by default | explicit archive only |

`paused` is reversible. `retired` is terminal for that agent identity. Restoring a retired function creates a successor agent rather than resuming the retired session.

Existing session statuses continue to describe execution state. A session may be idle or stopped while its agent lifecycle remains active and eligible for a later assignment. Agent retirement is not represented by overloading task completion or session failure.

The city lifecycle projection is checked transactionally at every execution boundary: assignment admission, run request, assignment steering, schedule creation and tick, wake claim and delivery, child spawn, model/effect admission, and recovery. A branch-local event or stale snapshot cannot bypass pause or retirement.

When a task agent's creation assignment becomes terminal, one stable organization revision moves it to `disposition_pending` with a bounded policy deadline. The manager may propose a new standing successor that cites the task agent's evidence, or retire the task agent immediately. If no decision commits by the deadline, a durable city wake requests retirement. `waiting_for_sponsor` and `attention` assignments are nonterminal and do not start disposition. External effects may be terminal or unknown; either remains visible and does not erase the decision window.

### Retirement request

A parent can request retirement of a direct child. The request includes:

- reason;
- evidence;
- expected charter and management revisions;
- active-run policy: drain or request cancellation;
- schedule and wake disposition;
- direct-child disposition;
- successor links;
- artifact and handoff requirements;
- city-policy-derived approval class.

Protected functions are defined by city policy: the operator, required top-level functions, and agents explicitly marked protected by the user. A request cannot choose its own approval requirement.

### Child disposition

Retirement cannot silently orphan active children. The retirement proposal must choose one action for every direct child:

- reparent to an authorized manager;
- include in a reviewed retirement cascade;
- pause and block the retirement until a later decision.

The runtime validates the resulting management tree before beginning retirement.

### Draining and uncertainty

Entering `retiring` is an atomically completed stable organization revision. It immediately blocks new assignment, steering, routing, schedule ticks, and wakes before drain work begins. Retirement completion is a later city transition.

Active work follows the declared drain or cancellation policy. Cancellation intent is not proof that an external effect stopped. Unknown effects remain attached to the retired history and visible as unresolved evidence. Retirement may complete once no runtime-owned work can continue, even if an external effect remains unknown; completion does not convert that effect to success, failure, or cancellation.

### Retirement completion

Retirement completes when:

- no new work can be admitted;
- active local execution is terminal;
- every external effect is terminal or explicitly unknown;
- schedules and wakes are disabled;
- child disposition is complete;
- required handoff artifacts exist;
- successor and routing updates are committed;
- required approval is retained.

The final event records exact evidence, unresolved outcomes, successor links, and decision authority.

The last active management edge remains retained as historical lineage after retirement. It no longer grants authority or makes the retired agent part of the active tree.

### Visibility

Normal directory and routing queries exclude retired agents.

Explicit historical views support:

- `includeRetired: true`;
- retired-agent search;
- charter history and diffs;
- origin, management, and successor lineage;
- retained routes and work;
- retirement proposal, evidence, and decision;
- unresolved effects or missing artifacts.

Retired agents remain inspect-only. Opening history cannot start a run, create or steer an assignment, create a schedule, invoke a skill, or mutate the retired route.

Inspect-only does not prohibit supervisor- or owner-classified evidence operations. Effect reconciliation, late external outcome evidence, recovery closure, sync conflict resolution, export receipts, deletion planning, and historical annotations may append through narrow typed commands without reactivating the agent or admitting work.

## City directory

### Directory contents

The directory is a rebuildable, revisioned, paged workspace projection. Each agent summary includes:

- session identity and display name;
- lifecycle and activity;
- active charter identity, role, mission summary, and prompt digest;
- exact managing parent and creation parent;
- direct reports and bounded descendant counts;
- model and budget policy;
- active runtime-grant version and bounded grant summary;
- exact service route and assignment queue state;
- routing labels and invocation criteria;
- current assignments, active runs, and unresolved-work counts;
- bounded outcome and evaluation summaries;
- creation, revision, pause, and retirement timestamps;
- successor and predecessor links;
- exact route links;
- availability or missing-state reason.

Full prompt text and charter history are retrieved by an exact agent-detail request rather than embedded in every directory page.

### System-prompt map

The directory exposes an owner-facing and operator-readable map:

```ts
interface AgentPromptMapItem {
  agentSessionId: string;
  charterVersionId: string;
  name: string;
  role: string;
  mission: string;
  exactSystemPrompt: string;
  promptDigest: string;
  managingParentSessionId: string | null;
  createdBy: CityPrincipalReference;
  lifecycle: "active" | "paused" | "disposition_pending" | "retiring" | "retired";
  origin: AgentOriginSummary;
}
```

The operator and owner may explicitly enumerate active, paused, disposition-pending, retiring, and retired agents and retrieve every current or historical charter version through bounded paging and exact lookups. Ordinary list pages default to active organization state, and the complete map is never inserted into each operator model call. The operator receives a small directory summary and typed query methods.

### Routing

The operator routes work using:

- charter role, mission, responsibilities, and exclusions;
- routing labels and invocation criteria;
- current lifecycle and availability;
- model and budget compatibility;
- evidence from prior attributable outcomes;
- management and delegation limits;
- task-required capabilities;
- conflicts, uncertainty, and user constraints.

Routing is a retained decision. The operator records considered candidates, selected agent or creation decision, bounded reasons, and applicable charter versions. Names and recency alone are not sufficient routing evidence.

Selecting an existing agent admits a durable assignment. Selecting creation declares standing or task agent kind and atomically admits the initial charter and assignment. The router cannot send cross-family work as an unscoped mailbox message.

### Visibility boundaries

The operator can see every agent charter because city coordination requires a common purpose map.

That visibility does not automatically expose:

- complete conversation history;
- private task inputs;
- working values;
- unrestricted artifact content;
- provider credentials;
- raw effect payloads;
- permissions outside the operator's envelope.

Other agents can inspect:

- their own charter and history;
- direct children's active charters and management metadata;
- bounded directory summaries explicitly allowed by policy;
- charter details attached to an authorized handoff.

## Bottom-up adaptation

### Triggers and evidence

The city can open an organization review from typed triggers:

- repeated successful routing to the same ad hoc specialist;
- repeated effect or gate failures tied to a role boundary;
- repeated user corrections;
- stale standing context;
- duplicate agents performing substantially overlapping work;
- repeated handoff failures or mailbox loops;
- persistent queueing or overloaded managers;
- underused standing agents;
- recurring work with no suitable charter;
- budget, latency, or quality regressions;
- successful or unsuccessful delegation patterns;
- completion-gate outcomes;
- explicit parent, child, operator, or user requests.

A trigger identifies a question; it does not prove the answer. An explicit request or model concern may be a valid trigger while supplying no supporting evidence.

Organization governance keeps five concepts separate:

- **trigger:** why the review opened;
- **supporting evidence:** retained events and artifacts relevant to the proposal;
- **observation:** measured candidate or control outcome;
- **evaluator:** the principal or deterministic mechanism interpreting observations;
- **decision authority:** the principal allowed to promote, reject, or retire.

Textual model claims are not objective evidence. Minimum evidence depends on operation:

- metadata-only charter corrections require an attributable reason, exact diff, and proof that `exactSystemPrompt` is byte-identical;
- behavioral charter revisions require at least one bounded candidate comparison;
- standing-agent creation requires demonstrated recurring demand or explicit user direction;
- reparenting requires current bottleneck or authority evidence plus both manager consents;
- merge and split require observations across distinct assignments;
- retirement requires covered-function, handoff, child-disposition, and unresolved-effect evidence.

### Proposal kinds

Organization proposals support:

- `create-agent`;
- `revise-charter`;
- `pause-agent`;
- `resume-agent`;
- `reparent-agent`;
- `split-function`;
- `merge-functions`;
- `create-successor`;
- `retire-agent`;
- `replace-operator`.

Every proposal includes:

- target agents and expected current revisions;
- proposed immutable edits;
- trigger and evidence event IDs;
- predicted effect;
- affected tasks, budgets, scopes, and permissions;
- predeclared evaluation;
- exposure bounds;
- required approvals;
- rollback or irreversibility statement;
- conflict and child-disposition analysis.

### Proposal lifecycle

```text
draft
  -> proposed
  -> validated
  -> candidate | decision_pending
  -> decision_pending
  -> promoted | revision_required | rejected
```

`withdrawn`, `expired`, `superseded`, `promoted`, and `rejected` are terminal. `blocked` and `conflicted` are resumable after required evidence, approval, or compare-and-swap rebase. `revision_required` closes the current proposal version and creates a linked replacement proposal with a new immutable edit set. A promoted reversible change may later enter a separate rollback request and end `rolled_back`.

Validation proves shape, references, authority, current-version compare-and-swap, hierarchy acyclicity, budget bounds, runtime-grant bounds, evidence visibility, lifecycle compatibility, and required approvers.

Candidate exposure uses exact agents, tasks, runs, and charter versions. Observations cite attributable outcomes. A candidate cannot record its own objective success without independently retained evidence.

Candidate allocation has a separate lifecycle:

```text
allocated -> exposed -> observed -> closed
```

A charter candidate allocation pins the candidate charter and active control version for one exact standing-agent assignment. New-function evaluation allocates separate task-agent creation assignments under the proposed role and aggregates their evidence before creating a standing successor. The agent lifecycle does not add a separate `candidate` state. Metadata-only changes can proceed directly from validation to `decision_pending`.

Promotion creates one city transition:

```text
pending -> applying -> completed | blocked | failed | conflicted
```

The stable organization pointers remain active until promotion commits, but the transition request advances `cityHeadRevision` and carries affected-agent admission locks. Every admission path consults both stable pointers and active locks. Irreversible guard changes such as `active -> retiring` commit as their own stable organization revision before drain work begins.

A portable city head revision is `{ cityId, ordinal, eventId, digest, governanceOwnerDeviceId }`. The governance owner allocates the ordinal; sync preserves the identity and causality. `stableOrganizationRevision` references one such head revision. A local database cursor is never either revision.

Internal event appends are never marked `unknown`; only external effects used during evaluation or draining may have unknown outcomes. A failed transition either releases unapplied locks through a terminal event or remains visibly blocked when irreversible control actions require completion.

### Evaluation

Evaluation matches the change:

- charter revisions compare task quality, gate outcomes, corrections, cost, and escalation behavior;
- new agents must show demand and useful specialization across distinct assignments;
- routing changes measure selection quality and avoidable transfers;
- splits measure bottleneck reduction without unacceptable duplication;
- merges measure reduced coordination cost without lost capability;
- retirement requires evidence that work is covered, no required function is silently abandoned, and handoff is complete.

Broader or more destructive changes require stronger evidence and authority. Retirement is terminal, so the safe evaluation path is usually candidate routing followed by pause, observation, and only then retirement.

### Bottom-up routing and escalation

- An own-charter proposal routes to the managing parent.
- A direct-child organization proposal routes to the proposer as manager.
- A proposal about the current manager routes to the next higher manager.
- A cross-manager proposal routes to the nearest common manager.
- A top-level function proposal routes to the operator.
- An operator proposal routes to the user.

Proposal delivery, receipt, decision deadline, escalation, and terminal disposition are durable. The operator and owner can list pending proposals at every level.

### Promotion and rollback

Promotion changes active pointers and lifecycle. It does not rewrite retained versions or outcomes.

Reversible changes include:

- charter activation;
- pause and resume;
- management-edge activation;
- routing preference changes.

Rollback restores the exact prior pointer through a new event. It has its own request and decision lifecycle; it does not reopen or mutate the terminal promoted proposal.

Retirement and physical deletion are not rolled back. A retired function returns only through a new successor identity. This keeps the meaning of “retired and unavailable for continuation” stable.

## Authority model

| Actor | Read | Propose | Activate |
| --- | --- | --- | --- |
| User | all city records | any change | any policy-valid change |
| City operator | all charter history and directory metadata | any workspace organization change | changes inside delegated operator authority |
| Managing parent | own and direct-child charters | direct-child and own changes | validated direct-child changes inside inherited ceilings |
| Agent | own charter, authorized directory, direct children | own charter, direct-child, and local organization changes | validated direct-child changes inside inherited ceilings |
| Sibling or unrelated agent | bounded authorized summaries | handoff or collaboration request | none |

No actor can:

- broaden its own immutable authority;
- disable the base policy;
- grant permissions, model access, or budget beyond its own envelope;
- approve evidence it fabricated;
- mutate prior charter text;
- reactivate a retired identity;
- physically erase another agent through lifecycle commands.

Assignment sponsorship, result receipt, and cancellation are separate typed rights. They do not grant charter revision or general mailbox authority.

## Branch semantics

### Session-wide charter

The charter belongs to the session identity, not to one conversational branch. Charter activation and agent lifecycle live in the city control stream and reference the session ID.

All branches resolve the same stable organization revision and active charter for new work. Run admission transactionally compares city head, stable organization, lifecycle, charter, and grant revisions and verifies active locks before appending the run pin. A historical run on any branch retains its own pinned charter version. Forking a conversation branch does not fork the agent's identity or silently create a different charter lineage.

Session snapshots may cache city references but never own them. Context materialization, subscriptions, recovery, sync, and old branch routes explicitly resolve the city projection rather than relying on conversational ancestor visibility.

### Governance and branch divergence

Organization mutations use exact expected city, management-edge, lifecycle, and charter revisions. Competing mutations conflict rather than use last-write-wins.

The city has one governance owner device. Only that owner activates city mutations. Assignment execution is available only when the target root's execution owner is the same device. Cross-owner assignment and reorganization are explicitly unavailable; this plan does not add distributed ownership transfer.

A non-owner device may author a proposal in an owned local agent stream and synchronize it as a request. It cannot append an activation to the authoritative city stream. Synced competing activation claims produce a city conflict and suspend affected mutations; no replica silently selects a charter or hierarchy pointer.

### Counterfactual organization work

A conversation branch may analyze or simulate an organization proposal. Simulation does not change active city state. Promotion references the exact proposal and evidence but appends a new authoritative city transition after current-state validation.

## Canonical events and projections

### Proposed canonical events

The implementation adds versioned event types shaped around durable meaning:

- `CityInitialized`;
- `CityOperatorChanged`;
- `CityTransitionRequested`;
- `CityTransitionStatusChanged`;
- `AgentRegistered`;
- `AgentCharterVersionCreated`;
- `AgentCharterActivated`;
- `AgentCharterRejected`;
- `AgentCharterRolledBack`;
- `AgentGrantVersionCreated`;
- `AgentGrantActivated`;
- `AgentGrantRevoked`;
- `AgentGrantRolledBack`;
- `AgentManagementChanged`;
- `AgentLifecycleChangeRequested`;
- `AgentLifecycleChanged`;
- `AgentSuccessorLinked`;
- `AssignmentRequested`;
- `AssignmentAdmitted`;
- `AssignmentQueued`;
- `AssignmentClaimed`;
- `AssignmentStatusChanged`;
- `AssignmentSteeringSent`;
- `AssignmentContextDelivered`;
- `AssignmentUsageAttributed`;
- `AssignmentTerminalNoticeSent`;
- `AssignmentTerminalNoticeDelivered`;
- `AgentOrganizationProposalSubmitted`;
- `OrganizationProposalRegistered`;
- `OrganizationReviewRequested`;
- `OrganizationProposalCreated`;
- `OrganizationProposalValidated`;
- `OrganizationCandidateActivated`;
- `OrganizationObservationRecorded`;
- `OrganizationProposalDecided`;
- `OrganizationRollbackApproved`;
- `OrganizationRolledBack`.

Exact event shapes require a domain review before implementation. New event meaning remains immutable after adoption. Existing retained events are never rewritten to manufacture charters or organization history.

### Write ownership

The canonical event header gains explicit stream addressing:

```ts
type EventStreamAddress =
  | { kind: "city"; workspaceId: string; cityId: string }
  | { kind: "agent"; workspaceId: string; sessionId: string; branchId: string };
```

The existing `events` table remains the single ordered canonical history, but city events have no conversational branch ancestry. This requires a pre-release event-schema cutover rather than disguising city state as an operator session or mutable projection. Older schemas fail closed under the repository's existing reset guidance.

One city governance fence serializes city-stream commits and increments monotonic `cityHeadRevision`. Organization activation also advances `stableOrganizationRevision`; proposals, locks, observations, and transition progress advance only the head. The city stream owns current operator, charter and grant activation, management edges, lifecycle, service routes, assignment admission and queueing, and organization decisions. Payloads retain target session IDs, acting principals, expected revisions, authorization basis, evidence, and exact immutable content.

Agent execution events retain session/branch addressing and root execution fences. Commands that atomically create an agent or admit an assignment acquire the city governance fence and target root fence in a fixed order. If the target root is owned by another device, the command is unavailable before canonical admission.

A city transition can stage a multi-step operation such as retirement:

1. commit `active -> retiring` as a completed guard revision;
2. perform idempotent assignment, schedule, wake, and run-control steps;
3. retain external-effect outcomes through the ordinary outbox;
4. commit completed, blocked, failed, or conflicted terminal city status.

Readers expose completed stable pointers, active admission locks, and any pending transition. Internal event writes and deterministic control steps are never `unknown`. An external effect may remain unknown and block or qualify the transition without changing that effect's meaning.

City synchronization preserves the city stream and its causal revisions. Only the governance owner can produce an activation envelope. Competing or non-owner activation claims enter explicit conflict/quarantine handling and do not advance `stableOrganizationRevision`.

### Event-stream ownership and bridges

| Meaning | Canonical stream |
| --- | --- |
| Operator, city policy, charter, grant, management, lifecycle, service route, assignment queue, organization decision | City |
| Conversation, context, run, cell, effect, working value, artifact registration, family mailbox | Agent route |
| Bottom-up organization proposal submission | Proposer agent route |
| Registered proposal and later governance lifecycle | City, referencing the submission event |
| Assignment input or steering delivered to target context | Target agent service route, referencing city assignment events |
| Assignment result delivered to an agent sponsor | Sponsor agent route, referencing the city terminal notice |
| Assignment result delivered to the user/operator product | City terminal notice and product projection |

A bottom-up proposal first appends `AgentOrganizationProposalSubmitted` to the proposer route. The governance owner validates visibility and appends `OrganizationProposalRegistered` to the city stream. Registration never changes the submitted text or evidence IDs.

Assignment admission is city-stream authority. Claim acquires city and target-root fences in fixed order, then atomically appends `AssignmentClaimed` in the city stream with `AssignmentContextDelivered` and `AgentRunRequested` in the target service route. Steering follows the same city-intent/target-delivery bridge. Terminal target events are observed idempotently, then the city stream records assignment status and terminal notice. Delivery to an agent sponsor appends one provenance-linked context event on the sponsor route.

These bridges are typed and assignment-scoped. They do not create general cross-family mailbox reach. A crash between target terminal work and city notice delivery is recoverable from retained event IDs and stable idempotency keys.

### Rebuildable projections

New projections include:

- `city_state`;
- `agent_charter_entries`;
- `agent_charter_versions`;
- `agent_grant_entries`;
- `agent_grant_versions`;
- `agent_management_edges`;
- `agent_lifecycle`;
- `agent_service_routes`;
- `agent_successor_links`;
- `assignments`;
- `assignment_usage`;
- `assignment_terminal_notices`;
- `organization_reviews`;
- `organization_proposals`;
- `organization_candidate_allocations`;
- `organization_observations`;
- `organization_decisions`.

All tables are classified in `docs/mutable-tables.md`. Current pointers and indexes are rebuildable from canonical events. Prompt text and charter versions remain in canonical payloads, not only mutable tables.

### Idempotency

Stable command retries agree on:

- target agent;
- expected city head, stable organization revision, and event stream;
- expected prior versions;
- complete charter content and prompt digest;
- complete grant content and activation identity;
- assignment mode, service route, reservation, and target policy;
- acting authority;
- proposal and evidence;
- hierarchy and lifecycle transitions;
- child disposition;
- successor links.

Changed meaning under the same key is a conflict.

## Protocol and SDK

### Product protocol

The owner-facing product contract adds capability-negotiated endpoints equivalent to:

```http
GET  /product/city
GET  /product/city/agents
GET  /product/city/agents/:session
GET  /product/city/agents/:session/charters
GET  /product/city/agents/:session/charters/:version
GET  /product/city/agents/:session/grants
GET  /product/city/agents/:session/grants/:version
GET  /product/city/assignments
GET  /product/city/assignments/:assignment
GET  /product/city/proposals
POST /product/city/agents
POST /product/city/assignments
POST /product/city/assignments/:assignment/cancel
POST /product/city/agents/:session/charters
POST /product/city/agents/:session/grants
POST /product/city/agents/:session/pause
POST /product/city/agents/:session/resume
POST /product/city/agents/:session/retire
POST /product/city/proposals
POST /product/city/proposals/:proposal/validate
POST /product/city/proposals/:proposal/activate
POST /product/city/proposals/:proposal/observe
POST /product/city/proposals/:proposal/decide
POST /product/city/proposals/:proposal/rollback
```

The exact paths may be consolidated, but the typed contract preserves:

- exact IDs and revisions;
- paging and immutable directory revisions;
- active versus retired inclusion;
- owner/operator authority;
- no mutation from read/navigation calls;
- typed unavailable and conflict outcomes;
- bounded prompt and evidence payloads.

### Console SDK

Generated TypeScript receives capability-scoped operations:

```ts
sdk.city.status()
sdk.city.agents.list(options?)
sdk.city.agents.get(target, options?)
sdk.city.agents.grants(target)
sdk.city.assignments.list(options?)
sdk.city.assignments.get(assignmentId)
sdk.city.assignments.create(input)
sdk.city.assignments.cancel(assignmentId, reason?)
sdk.city.proposals.list(options?)
sdk.city.proposals.get(proposalId)
sdk.city.proposals.create(input)

sdk.agents.spawn({ charter, task, ... })
sdk.agents.reviseChild(target, proposal)
sdk.agents.pauseChild(target, proposal)
sdk.agents.resumeChild(target, proposal)
sdk.agents.retireChild(target, proposal)
```

The executing session and branch always supply actor identity. Generated code cannot spoof a parent, operator, user approval, evidence source, or current revision.

The operator receives workspace-wide charter-directory reads. Other agents receive own/direct-child detail and bounded city summaries according to policy. No console method exposes raw credentials or converts directory reach into unrestricted SQL mutation.

Assignment methods are the only general city-wide work-routing surface. Family messaging remains restricted to creation-family relationships.

### Recursive calls

`rlm.start` and `rlm.startMany` require an explicit role/mission/system-prompt charter input or a sealed version-pinned recursive-agent template. The runtime may offer concise helpers, but the retained child always has a complete charter and exact prompt digest.

## Terminal product

### City entrypoint

The default no-ID task recipient is the city operator. Product status clearly distinguishes:

- city operator;
- currently observed agent route;
- remembered observation route;
- default inbound task recipient;
- active organization revision;
- pending organization proposals.

Directly opening or remembering another agent changes observation only. A no-ID task continues to enter through the operator unless the user explicitly addresses another agent in the command.

### Agents view

The Workspace Agents view and city organization view remain separate projections within one navigation surface:

- **Routes:** the complete retained route and branch graph required by the Workspace Agents view, including working, ended, failed, archived, and unavailable routes;
- **Organization:** the active management hierarchy, charter summaries, lifecycle, and proposals;
- **Archive:** retired agents, historical management edges, and successor lineage.

The Organization mode shows:

- operator at the root;
- active and paused agents;
- role, mission summary, activity, lifecycle, manager, and unresolved work;
- exact route links;
- proposal and attention indicators.

Retired agents are excluded from Organization mode and remain available in Archive mode. Route mode never hides a retained route merely because its agent retired. Left traversal and exact route opening continue to follow creation and branch ancestry, not management edges.

### Agent detail

An agent detail screen shows:

- active charter;
- exact system prompt;
- charter-version history and diffs;
- creation origin and source specification;
- current manager and immutable creation parent;
- direct reports;
- routing metadata;
- evaluations and observed outcomes;
- current routes and tasks;
- pause, retirement, and successor history;
- unresolved effects and missing dependencies.

Navigation is observational. Editing a charter, changing management, pausing, or retiring requires an explicit action, review, and confirmation appropriate to authority.

### Operator organization view

The operator view includes:

- active function map;
- unowned recurring work;
- redundant or overlapping charters;
- overloaded and underused agents;
- pending child proposals;
- candidate evaluations;
- required user decisions;
- retirement drains and unresolved outcomes.

These summaries are derived and attributable. They do not silently become canonical truth.

## Security and trust boundary

The runtime remains trusted-local.

- Model-generated code and shell execution retain the OS authority of the runtime process.
- Directory and charter scope are behavioral controls, not hostile-code confidentiality boundaries.
- City-wide prompt visibility does not make a model safe to receive secrets.
- Charter creation and revision use known-value rejection, credential stripping, bounded diagnostics, and exact provenance.
- The operator cannot read credential values.
- A parent cannot use charter text to grant model, budget, SDK, credential, effect, or publication capability. Runtime grants change only through the typed grant policy and owning authority.
- Filesystem and network restrictions remain prompt-level expectations unless the complete runtime is placed in an external sandbox; the plan does not misstate them as local containment.
- Hostile multi-agent or multi-tenant operation requires authenticated principals, isolated storage, capability grants, external sandboxing, resource limits, and a separate deployment plan.

The first implementation runs active city agents under one governance owner on the same trusted machine. Agents may exchange information through retained messages and assignments or through workspace files, artifacts, and locally created databases available to their ordinary tools and grants. Such files and databases are user/workspace data, not a new canonical city data plane, per-agent security boundary, managed service, or durable agent identity. The plan makes no guarantee that local agents are isolated from one another at the OS level.

## Retention, export, and deletion

### Retention

Normal retention includes:

- every charter version, exact prompt text, and prompt digest;
- every runtime-grant version, activation, revocation, and run/effect pin;
- immutable content for every base-policy, invocation-contract, and execution-guide component needed to reconstruct effective system prompts;
- creation and management lineage;
- city control events, `cityHeadRevision`, and `stableOrganizationRevision`;
- assignments, usage attribution, results, and terminal notices;
- organization proposals, evaluations, approvals, and decisions;
- pause, retirement, and successor events;
- exact run-to-charter pins;
- retained session, branch, task, mailbox, effect, and artifact provenance.

### Export

Workspace export includes city control history, exact effective-prompt components, charter history, assignments, organization history, projections or rebuild inputs, and referenced artifacts. An export that omits active charter definitions, effective system content, or run pins is incomplete.

### Deletion

Retirement is the normal way to remove an agent from future use.

Independent physical deletion of one city agent is initially unavailable when retained charters, management edges, proposals, successor links, tasks, mailboxes, artifacts, replicas, or evaluations would dangle. The data-control planner reports these dependencies rather than silently cascading.

Whole-workspace deletion retains existing confirmation, ownership, quiescence, remote-administration, artifact, receipt, and retry requirements.

## Migration and compatibility

### Fresh workspaces

A fresh workspace initializes:

1. city control stream and governance owner;
2. operator session and route;
3. sealed initial operator charter;
4. active operator lifecycle;
5. empty active management hierarchy;
6. remembered operator entrypoint.

No autonomous model run begins before the operator charter commits.

### Existing workspaces

The first implementation uses the repository's pre-release reset boundary. A schema-3 workspace does not open under the city schema and is not silently migrated.

A later separately reviewed importer may copy retained work into a new city workspace. Such an importer must:

- preserve the source workspace unchanged;
- retain original event IDs, payloads, branch ancestry, and import provenance where representable;
- avoid inferring a definitive mission or historical system prompt from task text;
- mark ended legacy sessions with a non-runnable historical-unknown charter;
- mark potentially runnable sessions `charter_required` until a user or authorized manager confirms a charter;
- let the user select or create the operator;
- validate every imported cross-reference, artifact, replica, and deletion dependency.

Imported legacy agents without confirmed active charters remain inspectable and non-runnable, satisfying the runnable-agent charter invariant.

### Event schema

The city control stream requires a pre-release event-schema cutover that adds explicit city and agent stream addresses to the canonical event header. The implementation does not overload a conversation session as the city aggregate and does not add a second authoritative event table.

The cutover follows the repository's fail-closed process: older workspaces are rejected before migration, row decoding, projection, sync ingestion, or recovery unless a separately reviewed importer is implemented. Current events are never silently reinterpreted under the new header.

No migration rewrites retained event rows or silently interprets an initial task as a historical system prompt.

## Delivery sequence

### Phase 0 — Domain review and prompt contract

- Freeze charter terminology and field boundaries.
- Define the immutable `agencity.agent-charter.v1` rendering contract.
- Define domain bounds, digest rules, secret rejection, and exact prompt ordering.
- Freeze the city/agent event-stream schema cutover and governance fencing contract.
- Define city, operator, assignment, management, lifecycle, and proposal events.
- Add an ADR for durable agent charters and organizational authority.

### Phase 1 — City control stream and schema cutover

- Add city and agent stream addressing to the canonical event header.
- Reject older workspaces before decode, projection, sync, or recovery.
- Add city head, stable organization revision, governance owner, fencing, sync, export, and deletion semantics.
- Add transactional city-plus-agent append support with fixed fence ordering.
- Add replay, rebuild, duplicate, conflict, and schema-rejection tests.

### Phase 2 — Charter domain and storage

- Add charter types, validators, events, reducer behavior, and projections on the city stream.
- Add runtime-grant versions, activation, revocation barriers, and projections.
- Add table classification and architecture checks.
- Add exact charter lookup by session and version.
- Add exact immutable prompt-component storage and resolution.
- Add replay, rebuild, duplicate, conflict, and integrity tests.

### Phase 3 — Assignment foundation and required agent admission

- Add durable assignment admission, funding, budget, goals, cancellation, usage, results, terminal delivery, and recovery.
- Add service routes, serialized queues, claim fencing, assignment-context bridges, and sponsor delivery.
- Require charters on root and child creation.
- Require standing or task agent kind.
- Update specification and recursive-child admission.
- Atomically create child, charter, grants, management edge, service route, task, and queued assignment across city and agent streams.
- Route repeated city work through assignments without broadening family mailboxes.
- Prove that no creation path appends `AgentRunRequested` before assignment claim.

### Phase 4 — Assignment claim, run pinning, and parent revision authority

- Claim queued assignments with exact city-head, stable-organization, charter, grant, context, and run identity.
- Pin charter and effective-prompt identity at `AgentRunRequested`.
- Pin runtime-grant identity and enforce revocation barriers at effect boundaries.
- Recheck immediate revocation at outbox claim and attempt start.
- Compose exact invocation-specific provider system content on every step.
- Add context inspection and effect provenance.
- Block runnable legacy sessions that lack an active charter.
- Add direct-child charter read, propose, activate, and rollback commands.
- Enforce constitutional, city, manager, and current-grant ceilings.
- Add child self-proposals and parent decisions.
- Make active-run and next-run behavior explicit.
- Add bounded candidate-charter run pins.
- Add concurrent compare-and-swap and cross-device conflict tests.

### Phase 5 — City initialization, operator, directory, hierarchy, and lifecycle

- Add one operator pointer and succession rules.
- Route ordinary no-ID entry through the operator.
- Extend the workspace route graph into a revisioned agent/charter directory.
- Add bounded operator directory queries and retained routing decisions.
- Preserve model-facing family and history boundaries.
- Add active managing-parent edges distinct from creation ancestry.
- Add pause, resume, retiring, and retired states.
- Add transactional lifecycle checks to every admission and recovery boundary.
- Add child disposition, schedule/wake blocking, cancellation, and external-unknown-effect handling.
- Add automatic task-agent disposition and successor creation.
- Add disposition deadlines and city wakes without racing waiting assignments.
- Add successor links and archive filtering.
- Make retired routes execution-disabled while preserving reconciliation and administrative evidence.

### Phase 6 — Evidence-governed organizational refactoring

- Add organization reviews and typed proposals.
- Reuse refinement validation, candidate allocation, observation, decision, approval, and rollback principles.
- Add create, revise, reparent, split, merge, successor, pause, and retirement operations.
- Add repeated-success, stale-context, role-overlap, unproductive-delegation, and routing-gap detectors.
- Keep automatic triggers profile-opt-in and bounded.

### Phase 7 — Product surfaces

- Preserve route mode and add separate Organization and Archive modes with charter detail, prompt history, and proposals.
- Add owner-facing edit, review, and confirmation flows.
- Add operator function-map and attention views.
- Update public protocol, TypeScript API, console SDK, CLI help, status, user guide, operator guide, recovery, security, events, capabilities, mutable tables, data lifecycle, and verification docs.

### Phase 8 — Hardening and acceptance

- Add restart and crash-boundary coverage for every transition.
- Add sync divergence and non-owner refusal coverage.
- Add large-directory paging, prompt-map, and warm-refresh benchmarks.
- Add export and deletion-plan coverage.
- Add installed-product journeys from one operator to organic specialization, revision, handoff, retirement, and historical inspection.
- Run typecheck, architecture checks, deterministic verification, acceptance, and separately report external skips.

## Test plan

### Charter identity

- Root creation without a charter is rejected before session or run admission.
- Every child surface rejects promptless admission.
- Every child declares standing or task agent kind.
- A task agent enters disposition-pending after terminal assignment and then retires.
- Specification spawn records exact specification and charter versions.
- Recursive children receive explicit charters.
- Charter renderer output and digest are deterministic.
- Standing aspirations are bounded, render deterministically, and remain distinguishable from goals and assignments.
- Adding, changing, or removing a standing aspiration is a behavioral charter revision.
- Secret-bearing charter content is rejected without echoing the value.
- Idempotency-key reuse with changed charter meaning conflicts.

### Model context

- Every agent provider call contains base policy, exact pinned charter, invocation-specific response policy, and execution guidance in fixed order.
- The effective prompt digest matches the exact provider-facing system text.
- Run and effect records pin one immutable runtime-grant version.
- Exact historical system-role messages are quoted data, not provider system instructions.
- Prompt notes and dynamic messages cannot replace the charter.
- A charter revision during a run does not change later steps of that run.
- A newly claimed assignment run uses the newly active charter.
- An allocated candidate run uses the candidate charter and records its active control version.
- Compaction preserves exact charter references.
- Recovery after context, model request, or effect commit does not rematerialize with a different charter.

### Authority

- A parent can revise a direct child after the initial task is terminal.
- A parent cannot revise a sibling, unrelated agent, or former child after reparenting.
- A child can propose but not activate its own charter revision.
- A parent cannot exceed constitutional, city, or manager-delegated ceilings.
- Enforceable grant expansion requires the authority that owns the applicable ceiling.
- Grant expansion does not change an active run.
- Immediate revocation blocks the next effect admission without rewriting an already-started effect.
- Immediate revocation cancels a pending effect before outbox attempt start and never dispatches it.
- The operator cannot widen its own charter or replace itself.
- User approval is required for protected organization changes.
- Forged actor, evidence, approval, or current-version fields fail closed.

### Hierarchy

- Creation parent remains unchanged after reparenting.
- Active management hierarchy has one operator root.
- Cycles, cross-workspace edges, missing agents, retired managers, and excess depth fail.
- Reparenting preserves open-run charter and uses the new manager for later work.
- Split and merge operations create new identities and retained lineage.
- Concurrent hierarchy mutations conflict rather than choose by timestamp.
- Reparenting does not change family mailbox, cancellation, root, or historical budget semantics.
- Incompatible descendant grants are narrowed, reparented, or paused before activation.

### Assignments

- Routing to an existing agent creates one durable assignment.
- Assignment admission reserves sponsor budget and targets the exact service route.
- Claim pins exact city, charter, grant, assignment, and run identity.
- Busy agents queue assignments deterministically and run at most one assignment on the service route.
- Waiting-for-sponsor steering resumes the same assignment; new work creates another assignment.
- Completion gates, cancellation, usage attribution, result, artifacts, and terminal delivery survive restart.
- Cross-family assignment communication cannot be used for general messaging.
- A target owned by another device is unavailable before admission.
- Duplicate assignment admission or terminal recovery does not duplicate work or usage.
- Sponsor charge, session attribution, ancestor attribution, unused release, and conservative unknown usage never double debit.
- Child work funded by an active assignment cannot reserve beyond that assignment's remaining delegation allowance.
- A mandate or standing aspiration cannot create a run, assignment, reservation, or effect without an authorized finite work record.
- Agent-route proposal submission and assignment delivery bridge to the city stream with exact provenance.
- Creation commits queued work and reaches `AgentRunRequested` only through the ordinary claim path.

### Lifecycle

- Paused agents reject routing, assignment creation or steering, wakes, schedules, and new runs.
- Resuming a paused agent preserves identity and uses the current charter.
- Retiring immediately blocks new work.
- `active -> retiring` commits before any drain action.
- Child disposition is required before parent retirement.
- Cancellation intent and unknown effects remain visible through retirement.
- Retired agents are absent from ordinary routing and default directory pages.
- Explicit archive inspection resolves charter, history, evidence, and successors.
- Retired routes reject execution and user route mutation.
- Reconciliation, recovery closure, sync resolution, export, deletion planning, and historical annotation remain available without reactivation.
- A renewed function requires a successor agent rather than reactivation.
- Task-agent terminal work enters disposition-pending before successor creation or automatic retirement.
- A standing agent with no admitted work becomes dormant without losing identity and resumes from durable state when a later assignment is claimed.

### Adaptation and governance

- Typed repeated evidence can trigger one deduplicated organization review.
- A model assertion without evidence cannot promote a change.
- Candidate exposure is bounded and tied to exact runs and charter versions.
- Distinct-task evaluation is required where declared.
- A candidate cannot fabricate its own objective observation.
- Promotion changes only current pointers.
- Rollback restores exact prior pointers without rewriting events.
- Retirement requires the configured higher-authority decision.
- Automatic triggers cannot widen their own scope or rate.

### Directory and routing

- The operator can explicitly page every active, paused, disposition-pending, retiring, and retired agent and retrieve current or historical charter text.
- Non-operator agents receive only authorized detail.
- Full prompt text is absent from ordinary list pages.
- Routing records considered candidates, exact charter versions, and reason.
- Retired and unavailable agents are never selected as active targets.
- Missing charter or directory state remains explicit.
- Large unchanged directories refresh without replaying every route history.

### Branch, recovery, and sync

- Branch forks do not duplicate agent identity or fork charter history.
- Historical runs resolve their original charter after later revisions.
- Every branch resolves session-wide identity from the city control stream rather than branch ancestry.
- Organization simulation on a branch has no active effect.
- Crash after proposal, activation intent, partial target transition, or terminal decision recovers idempotently.
- Active transition locks block affected admission even while stable organization pointers remain unchanged.
- City head and stable organization revisions survive sync without using local cursors.
- Offline conflicting charter or hierarchy changes remain explicit.
- A non-governance-owner device cannot activate organization mutations.
- Cross-owner assignment and reorganization are unavailable.
- Sync never silently selects one conflicting charter.

### Data lifecycle

- Export contains every charter version, exact effective-prompt component, prompt digest, run pin, assignment, proposal, decision, and lineage edge.
- Missing charter content or corrupt prompt digest blocks execution.
- Narrow deletion reports management, proposal, successor, route, replica, and artifact dependencies.
- Retirement does not delete canonical events or artifacts.
- Whole-workspace deletion retains existing guarded semantics.

### Installed product

A linked `agencity` executable in a fresh repository must:

1. initialize a city and operator with an explicit usable model;
2. accept a task through the operator;
3. create a child only after committing a complete charter;
4. show the child and exact system prompt in the Agents view;
5. route a second task to a standing agent through a durable assignment;
6. complete work and retain assignment budget, gates, usage, and result delivery;
7. revise the child's charter from its parent;
8. prove an existing run retains the old charter and the next run uses the new version;
9. create a task agent and prove terminal work automatically removes it from active rotation;
10. produce and evaluate a bottom-up specialization proposal;
11. create a successor or split function with retained lineage;
12. retire an agent and remove it from ordinary routing;
13. inspect the retired agent through the archive while reconciling retained evidence;
14. show that a standing agent remains dormant after finite work completes instead of inventing work from its mandate or aspirations;
15. detach, restart the service, and reproduce the same city hierarchy, assignment state, and charter map without duplicate work.

The black-box path uses only the documented executable and public protocol-backed terminal product.

## Performance and bounds

The implementation defines and tests bounds for:

- active agents per city;
- management depth and direct reports;
- queued assignments per agent and city;
- assignment steering and result payloads;
- charter encoded bytes and collection counts;
- standing aspirations per charter and aspiration evidence references;
- directory page size;
- full-prompt detail requests;
- organization proposal rate;
- concurrent candidate exposure;
- automatic review triggers;
- retained evidence references;
- routing candidates considered per decision.

Directory summaries do not embed full prompts. Exact prompt text is loaded only for selected agents. Warm directory refresh reuses unchanged projections and does not materialize every conversation.

The lossless context-reference plan should deduplicate repeated charter and base-policy content in retained model contexts without changing exact provider input or provenance.

## Risks and safeguards

### Prompt accumulation

Large charters can consume context and become stale. Structured bounds, exact diffs, standing-context review, and separation from dynamic memory prevent the charter from becoming an unbounded knowledge dump.

### Mandate-induced busywork

A continuing mandate or standing aspiration can be misread as an instruction to remain active, consume spare budget, or manufacture goals. Run admission always requires a finite authorized work record and budget. Quiescence is valid, aspirations carry no reservation, and operator evaluation penalizes unnecessary activity.

### Organizational churn

An agent could repeatedly create roles or rewrite charters based on weak evidence. Admission limits, proposal deduplication, candidate exposure, distinct-task evaluation, cooldowns, and parent/operator authority bound churn.

### Metric gaming

Agents may optimize declared metrics rather than useful outcomes. Evaluations use multiple signals, user corrections, completion gates, cost, unresolved effects, and independent evidence. No single model-authored score is sufficient.

### Authority laundering

A broad child charter could be used to describe permissions the runtime did not grant. Every charter and management transition validates behavioral declarations against constitutional and delegated ceilings, while enforceable model, budget, SDK, credential, data, and effect grants remain separate typed runtime state.

### Hidden retired risk

Removing retired agents from default views can hide unresolved effects or missing functions. The operator receives aggregate retired-attention counts, retirement requires handoff checks, and unresolved unknown outcomes remain visible.

### Identity confusion

Creation ancestry, management hierarchy, routes, specifications, charters, and successors are distinct typed relationships. UI and protocol names preserve these differences.

### Global-context illusion

The operator's directory access can be mistaken for omniscience. Directory reads are bounded, exact prompts require lookup, and task histories remain separately selected and authorized.

### Cross-device conflict

Offline writers cannot safely share one organization pointer. Only the city governance owner activates changes; assignment targets must share that owner. Competing proposals and sync divergence remain explicit.

## Completion criteria

The adaptive agent city is complete when:

1. Every runnable agent has exactly one active immutable charter version.
2. Every agent model call uses and records one exact pinned charter and effective system prompt.
3. No child-admission path accepts only a task string.
4. Parents can revise direct children's future charters without changing active or historical runs.
5. One explicit operator is the stable workspace entrypoint and can query every agent charter.
6. Operator visibility does not broaden message, secret, artifact, effect, or permission authority.
7. The active management hierarchy is distinct from immutable creation ancestry and remains exact, bounded, and acyclic.
8. Repeated work reaches existing agents through durable assignments rather than unscoped follow-up.
9. Standing and task agents have distinct rotation and retirement behavior.
10. The city control stream owns portable head and stable organization revisions independently of conversation branches.
11. The city can create, revise, pause, resume, reparent, split, merge, supersede, and retire functions through durable governed proposals.
12. Retired agents receive no future work, disappear from normal routing and organization views, and remain inspectable through explicit history.
13. Organizational changes preserve evidence, evaluation, authority, conflicts, and rollback or irreversibility.
14. Restart, crash, branch, sync, export, and deletion behavior preserve the same city, assignment, and charter provenance.
15. The installed terminal journey demonstrates organic specialization, assignment, charter revision, succession, retirement, archive inspection, detach, and resume without internal IDs.
16. Public documentation and `AGENTS.md` describe shipped behavior and remaining limits accurately.
17. Typecheck, architecture checks, deterministic tests, and acceptance pass; credential- or service-gated external checks are reported separately as pass, fail, or skip.
18. Standing mandates remain durable while every goal, assignment, run, and effect stays finite, attributable, and separately admitted.
19. Standing aspirations can inform authorized goals but cannot independently create work, reserve budget, or keep an agent active.

## Deferred extensions

- Cross-workspace or profile-level agents.
- Hosted multi-tenant cities.
- Authenticated third-party agent participation.
- Distributed organization ownership and failover.
- Agent-published typed RPC, capability-contract registries, stable service aliases, and generated cross-agent clients.
- A shared canonical city application-data plane or agent-defined tables inside the runtime event database.
- Per-agent isolated compute, managed SQLite/Postgres resources, containers, TCP endpoints, and supervised application-service lifecycles.
- Distributed agent placement and cross-host agent execution.
- A marketplace of independently governed agent charters.
- Embedding-based semantic directory search.
- Automatic physical garbage collection of retired histories.
- General consensus or voting among agents.
- Autonomous operator replacement without explicit user authority.

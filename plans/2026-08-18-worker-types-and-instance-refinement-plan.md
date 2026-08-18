# First-class worker types and instance refinement plan

**Status:** Proposed  
**Date:** August 18, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Depends on:** [Durable agent profiles and automated refinement review](./2026-08-08-adaptive-agent-city-plan.md), [Default automatic adaptive learning](./2026-08-11-default-automatic-adaptive-learning-plan.md), and [Explicit AI generation and typed agent runs](./2026-08-11-explicit-ai-generation-and-typed-agent-runs-plan.md)  
**Related decisions:** [Durable agent relationships](../docs/decisions/0006-durable-agent-relationships.md), [Profile, workspace, and credential boundaries](../docs/decisions/0008-profile-workspace-and-credentials.md), and [Durable agent profiles and automated refinement governance](../docs/decisions/0012-durable-agent-profiles-automated-refinement-governance.md)

## Summary

Agencity should make reusable worker types and durable worker instances explicit product concepts.

A **worker type** is an immutable-versioned behavioral prototype for a recognizable kind of work, such as code reviewer, migration specialist, release operator, or security analyst. A **worker instance** is a durable `Session` created from one exact worker-type version. The instance owns its assignments, conversation, family relationships, budget usage, local learning, and execution history. The type owns behavior intended to apply across repeated instances of that job.

The resulting product model is:

```text
WorkerTypeVersion
  -> instantiated as WorkerInstance (Session)
       -> receives Task
       -> may delegate narrower Tasks to other WorkerInstances
       -> accumulates instance-local experience
       -> may propose attributable refinements

Refinement
  -> instance target: improve this durable worker only
  -> worker-type target: improve future instances of this job
  -> no_change: evidence does not justify either target
```

This plan promotes the current reusable `subagent_spec` idea into a first-class workspace-owned `WorkerType`. It preserves `Session` as the only executable agent identity and `Task` as the durable unit of delegated work. A worker type is not a process, queue, actor, permission principal, or management node. It is versioned behavioral and admission material from which a session is created.

The implementation adds:

1. workspace-owned worker-type identity and immutable versions;
2. an exact worker-type pin on every runnable session and invocation;
3. type-owned memories, prompt notes, skills, and behavioral composition;
4. refinement target selection between the instance and its source type;
5. bounded cross-instance evidence attributed to exact type-version exposure;
6. explicit adoption of a newer type version by an existing instance;
7. worker-type catalog, history, diff, provenance, and instance views;
8. a deterministic workspace adaptation snapshot;
9. recovery, synchronization, export, deletion, rollback, and black-box acceptance coverage.

The first implementation is workspace-local. It does not add cross-workspace worker types, automatic user/global promotion, class inheritance, work stealing, cross-family reassignment, a workspace manager, or an organization control plane.

Event schema 6 has one reusable-worker representation: `WorkerType`. It removes `subagent_spec` from `HarnessKind`, removes `sdk.specs`, replaces specification-source profile fields with worker-type source fields, and maps recurring delegated roles to owner-created worker types or refinements of an existing exact source type. Version-5 workspaces fail closed before decode, so the new runtime does not need to decode old specification proposals, rollback targets, or frozen review records as live schema-6 state. A future importer may translate them explicitly; no compatibility alias remains in the shipped schema-6 API.

## Product decision

Agencity treats specialization as a relationship between a reusable worker type and durable worker instances.

The system should ordinarily improve the narrowest durable owner that matches the evidence:

- task- or instance-specific facts and tactics remain with the instance;
- behavior that should hold across repeated assignments for one job may revise the worker type;
- repository-wide facts remain workspace knowledge through explicit workspace-scoped refinement;
- runtime authority, credentials, model access, budgets, and effect policy remain outside behavioral refinement.

Automatic refinement is **type-preferred when type generalization is eligible**, not type-forced. A source-linked instance may propose a type change only when deterministic attribution proves that the cited work used the target type version and the evidence spans at least two distinct work episodes, or when a typed user correction explicitly targets the worker type. Otherwise automatic refinement remains instance-local. Manual workspace-owner refinement may target a worker type from one attributable episode because the owner supplies the missing scope decision.

The refiner chooses one target owner and one coherent proposal. It does not atomically update both an instance and its type. If both changes are useful, they proceed as separately governed proposals with separate evidence, expected versions, application results, and rollback identities.

Worker-type activation affects:

- new instances created after activation; and
- existing instances that explicitly adopt that exact version.

It does not silently rewrite existing sessions, active invocations, tasks, branches, profiles, local harness content, or historical context. Every instance and invocation remains reconstructible from exact retained pins.

## Relationship to the current architecture

### Reused foundations

The implementation reuses:

- `Session` as the durable executable identity;
- `Task` as the parent-owned reason a child exists and the unit of delegated work;
- creation-family ancestry, mailboxes, cancellation, usage attribution, and terminal notices;
- immutable per-session agent profiles and invocation-level profile pins;
- immutable harness entries and versions;
- exact `subagent_spec` invocation provenance;
- governed proposals, deterministic validation, one separate sealed reviewer, application-time revalidation, terminal delivery, and rollback;
- default automatic trigger detection and trigger-consumption records;
- outbox-backed model, shell, file, and skill effects;
- local LibSQL canonical events, rebuildable projections, Turso envelope synchronization, and explicit divergence;
- protocol-backed CLI and TUI operation.

The existing `SubagentSpecService` already proves the essential admission pattern:

1. resolve one exact active specification version;
2. validate its scope;
3. materialize a complete child profile and task;
4. admit a normal durable child session;
5. retain specification, task, child, and branch provenance.

The new model generalizes this pattern and makes it the ordinary typed-worker path.

### Accepted changes to prior limits

This plan changes several current product limits:

- reusable specialist templates become a first-class workspace catalog;
- every runnable session receives explicit worker-type provenance;
- automatic refinement may target one workspace-owned worker type under bounded generalization rules;
- type-linked evidence may aggregate across sessions that used one exact type version;
- the product gains workspace-wide adaptation inspection.

This does **not** authorize:

- routing work to an unrelated existing session;
- reparenting a session into another family;
- assigning one task to several independent claimers;
- adding a global coordinator above workspace roots;
- allowing worker-type prose to grant runtime authority;
- allowing an instance to widen its parent’s model, budget, permission, or publication bounds.

Before implementation, a new ADR must amend the organization limitations in ADR 0012 while preserving its durable-session, profile, governance, and authority decisions. `AGENTS.md` must distinguish the accepted worker-type direction from shipped behavior.

## Goals

- Make worker type and worker instance first-class, inspectable product concepts.
- Give every runnable session exact type provenance, including sealed defaults and one-off inline types.
- Preserve `Session` as the only executable identity.
- Preserve `Task` as the ordinary delegated-work relationship.
- Let an authorized parent instantiate a visible worker type for a narrower task.
- Let the resulting worker delegate narrower work through the same task and family model.
- Let a worker retain instance-local memories, prompt notes, skills, and profile history.
- Let refinement explicitly choose between instance-local and worker-type ownership.
- Prefer type refinement when attributable evidence supports job-level generalization.
- Prevent task-specific or repository-specific facts from polluting a reusable job definition.
- Pin exact worker-type, agent-profile, and harness meaning to every invocation.
- Preserve old instances and historical invocations when a type changes.
- Allow explicit, conflict-checked adoption of a newer type version.
- Aggregate bounded type evidence across exact exposed instances and work episodes.
- Preserve deterministic validation, sealed independent review, immutable application, and rollback.
- Expose current effective adaptation and its reasons across an entire workspace.
- Keep local-first operation, recovery, synchronization divergence, export, and deletion complete.

## Non-goals

- Programming-language inheritance, subclassing, mixins, or method dispatch.
- A management hierarchy or reporting-line model separate from creation-family ancestry.
- Cross-family assignment to an existing durable worker.
- Task claiming, work stealing, shared assignment queues, or distributed scheduling.
- A workspace coordinator distinct from the selected root.
- Automatic reparenting, split, merge, succession, or retirement of sessions.
- Automatically mutating all existing instances when a type changes.
- Automatically promoting a workspace worker type into user, global, or cross-workspace scope.
- User-profile-owned or hosted marketplace worker types in the first implementation.
- Allowing type behavior to grant credentials, SDK methods, effect permissions, model access, budget, or OS authority.
- Training model weights.
- Inferring semantic task classes with embeddings or an unbounded model-maintained taxonomy.
- Treating reviewer approval, successful runs, or type adoption as proof of improved outcomes.
- Replacing memories, prompt notes, skills, profiles, tasks, or goals with one large type prompt.
- Adding a second agent runtime for typed workers.
- Adding provider tools beyond the existing required `bun_console` and `finish` contract.

## Terms

- **Worker type:** A non-executable workspace-owned identity whose immutable versions define reusable behavioral and admission material for one kind of worker.
- **Worker-type version:** One immutable revision of a worker type, including its standing behavior, invocation guidance, output expectations, exact prompt material, type-owned harness manifest, provenance, and bounded runtime defaults.
- **Worker instance:** A durable `Session` admitted from one exact worker-type version.
- **Type binding:** The session-wide record naming the worker type and version currently adopted by an instance.
- **Origin type version:** The version used when the instance was first admitted.
- **Adopted type version:** The version governing later invocations after an explicit adoption. It is initially the origin version.
- **Inline worker type:** A one-off immutable type embedded in session admission for an explicitly supplied custom profile. It has no reusable catalog identity and cannot receive type-level refinement.
- **Sealed worker type:** A packaged immutable product or internal-workflow type that cannot be revised through workspace learning.
- **Workspace worker type:** A reusable canonical type owned by one workspace and eligible for governed revision.
- **Type-owned harness:** Memory, prompt-note, or skill content bound into one worker-type version’s immutable harness manifest.
- **Work episode:** One exact durable run or queued work admission used as the minimum distinct unit for type-generalization evidence.
- **Generalization eligibility:** Deterministic proof that an automatic proposal may target a worker type rather than only the originating instance.
- **Type evidence:** Exact retained events and outcomes from invocations that pinned the cited worker-type version.
- **Adoption:** An explicit session-wide transition to a newer approved worker-type version for later invocations.
- **Adaptation snapshot:** A bounded deterministic workspace projection of current effective types, instance deviations, learning activity, governance, evidence, and rollbacks.

## User model

### Worker types are job definitions

A workspace may define types such as:

```text
Code Reviewer
Migration Specialist
Security Analyst
Release Operator
Test Failure Investigator
```

Each type states:

- the role and standing purpose;
- behavioral instructions and quality principles;
- when it should be invoked;
- the artifact or result it should produce;
- default completion criteria;
- optional model and budget defaults that remain subordinate to caller authority;
- exact type-owned memory, prompt-note, and skill versions.

The type is not running merely because it exists.

### Worker instances perform assignments

A parent creates a child by selecting a type and supplying a narrower task:

```ts
const reviewer = await sdk.workers.spawn("code-reviewer", {
  task: "Review the authentication changes for security, recovery, and test gaps.",
});

const result = await sdk.agents.result(reviewer);
```

Admission creates a normal `Task`, child `Session`, branch, profile, budget reservation, model configuration, and family relationship. The returned handle contains durable task, child, origin-type, and adopted-type identity.

The child may later:

- finish the task;
- accept queued follow-up work;
- receive explicit profile revisions;
- accumulate instance-local learning;
- adopt a newer type version;
- delegate narrower tasks to visible worker types.

### Persistent specialists and fresh instances are both valid

The product supports two patterns without creating separate runtimes:

- **Fresh typed instance:** create a new child from the active type version for isolation, concurrency, and clean task history.
- **Persistent typed specialist:** retain one child session and queue later work to it so local memory and instance-specific adaptation accumulate.

The type provides reusable job behavior. The session provides continuity.

## Domain model

### Worker type

The workspace owns a canonical worker-type aggregate:

```ts
interface WorkerType {
  workerTypeId: string;
  workspaceId: string;
  slug: string;
  activeVersionId: string;
  status: "active" | "retired";
  createdAt: string;
  updatedAt: string;
}

interface WorkerTypeVersion {
  workerTypeVersionId: string;
  workerTypeId: string;
  revision: number;

  title: string;
  role: string;
  purpose: string;
  instructions: string;
  invocationCriteria: string;
  expectedArtifact: string;
  completionCriteria: string | null;

  exactTypePrompt: string;
  promptContractId: "agencity.worker-type.v1";
  promptDigest: string;

  harnessManifest: WorkerTypeHarnessBinding[];
  harnessManifestDigest: string;

  modelDefault: ModelConfiguration | null;
  budgetDefault: BudgetLimits | null;

  createdBy: AgentPrincipalReference;
  reason: string;
  evidenceEventIds: string[];
  supersedesVersionId: string | null;
  restoresVersionId: string | null;
  sourceProposalId: string | null;
  reviewDecisionId: string | null;
  createdAt: string;
}

interface WorkerTypeHarnessBinding {
  entryId: string;
  versionId: string;
  kind: "memory" | "prompt_note" | "skill";
  required: boolean;
}
```

The exact bounds and rendering contract are fixed during Phase 0. `exactTypePrompt` preserves historical provider-facing meaning independently of later renderer changes.

`modelDefault` and `budgetDefault` are admission defaults, not behavioral authority:

- automatic refinement cannot change them;
- the parent’s provider, model, budget, depth, and concurrency limits remain authoritative;
- a type default that cannot fit inside parent authority makes admission unavailable;
- a caller may choose a stricter budget;
- a caller may override the model only when the type policy and parent authority both allow it.

### Worker-type categories

Every runnable session has one type source:

```ts
type WorkerTypeSource =
  | {
      kind: "workspace";
      workerTypeId: string;
      workerTypeVersionId: string;
      promptDigest: string;
      harnessManifestDigest: string;
    }
  | {
      kind: "sealed";
      componentId: string;
      version: number;
      digest: string;
    }
  | {
      kind: "inline";
      inlineTypeId: string;
      version: 1;
      digest: string;
    };
```

Sealed defaults cover:

- the ordinary repository root;
- a generic one-off task specialist;
- private governance and refinement roles;
- other packaged internal workflows.

An explicit custom child profile without a reusable type becomes an inline type. Inline types preserve exact class/instance provenance without creating a reusable catalog entry. Automatic refinement for an inline instance remains instance-local.

### Worker instance

`Session` remains the worker instance. Its canonical state gains:

```ts
interface WorkerTypeBinding {
  origin: WorkerTypeSource;
  adopted: WorkerTypeSource;
  admissionConfiguration: {
    modelSource: "inherited" | "type_default" | "explicit_override";
    effectiveModel: ModelConfiguration;
    budgetSource: "inherited_remaining" | "type_default" | "explicit_override";
    requestedBudget: BudgetLimits;
  };
  adoptedAt: string;
  adoptionEventId: string | null;
}
```

The complete initial type binding is embedded in `SessionCreated` beside the complete initial agent profile. A newly runnable session cannot exist without either a workspace, sealed, or inline type source.

`SessionCreated` continues to retain the effective model and budget as runtime truth. `admissionConfiguration` explains whether each value was inherited, supplied by the type, or explicitly overridden, and preserves the exact bounded request used during admission. It does not create another mutable model or budget owner.

The session continues to own:

- conversation and branches;
- model configuration and budget usage;
- active agent profile and profile history;
- tasks, family relationships, and mailboxes;
- runs, contexts, effects, cells, artifacts, goals, schedules, and wakes;
- local memories, prompt notes, skills, and learning history;
- current adopted type binding.

The worker type never becomes executable identity and never owns a mailbox, run, effect, task, branch, budget balance, or execution lease.

### Agent profile relationship

The agent profile remains the exact session-specific standing behavior supplied to model calls.

On admission from a worker type:

1. the type version supplies role, purpose, and instructions;
2. the runtime deterministically materializes a complete initial `AgentProfileVersion`;
3. the profile records exact worker-type source provenance;
4. `SessionCreated` atomically retains the type binding and complete profile.

Instance profile revision does not revise the worker type. Worker-type revision does not revise an instance profile.

Type adoption creates and activates a new instance profile derived from the adopted type version in the same transaction as the binding change. Adoption does not attempt an implicit text merge. If the instance profile has diverged since its previous type-derived profile, adoption requires an explicit owner-supplied resolution that previews and confirms the exact replacement profile. Automatic adoption is unavailable.

Adoption changes behavior and type-owned harness bindings only. It does not silently change the session's current model or budget. New type defaults are shown in the preview and apply only to later instances unless the owner performs a separate ordinary model or budget operation through the services that own those fields.

### Type-owned harness

The harness scope model gains:

```ts
type HarnessScope =
  | "local"
  | "worker_type"
  | "workspace"
  | "user"
  | "global";
```

For `worker_type` scope, `scopeKey` is the workspace worker-type ID. A type version does not read the mutable latest entry pointer at invocation time. It owns an immutable manifest of exact harness versions.

This prevents an old instance from silently receiving a later class memory, prompt note, or skill. A type refinement:

1. creates or selects exact harness versions;
2. creates a new worker-type version with a new manifest;
3. activates the type version after governance;
4. affects new instances and explicit adopters only.

For non-skill edits, type version and harness application are atomic. Generated type-owned skills follow the existing staged path:

1. reviewer approval;
2. candidate skill version;
3. outbox-backed compile and declared tests;
4. worker-type version creation and activation only after passing evidence;
5. terminal failure with no type activation otherwise.

Manifest binding is distinct from the mutable active-version pointer used by ordinary harness lookup. A type-bound invocation may resolve the exact historical version named by its manifest when:

- that version was approved and active when the manifest was created;
- its digest and immutable content remain available;
- every required skill has retained passing compile and runtime-test evidence for that exact content;
- no later explicit safety quarantine or physical dependency loss makes it unavailable.

Ordinary supersession, type rollback, or a newer active entry does not invalidate an old manifest. Explicit quarantine, removal, missing artifacts, or incompatible runtime changes block dependent old instances visibly; they do not substitute a newer version. Skill management and invocation gain an exact manifest-authorized version path rather than relying only on the current active pointer.

### No type inheritance

Worker types do not inherit from other worker types. Reuse occurs through:

- shared workspace/user/global harness entries where explicitly authorized;
- copied immutable source with provenance;
- delegation to another worker type;
- future explicit composition contracts if repeated evidence justifies them.

This prevents hidden method-resolution, transitive authority, ambiguous rollback, and prompt composition order.

## Refinement model

### Target ownership and artifact mechanism are separate

The refiner decides:

1. **owner target:** instance or worker type;
2. **artifact mechanism:** memory, prompt note, skill, or type behavior;
3. **proposed change:** exact immutable replacement or edits;
4. **generalization case:** why the evidence belongs to that owner;
5. **evaluation intent:** how later outcomes could support or contradict the change.

The formal result becomes:

```ts
type WorkerRefinementDecision =
  | {
      outcome: "no_change";
      reason: string;
    }
  | {
      outcome: "proposal";
      target:
        | {
            kind: "instance_harness";
            sessionId: string;
            scope: "local";
          }
        | {
            kind: "worker_type";
            workerTypeId: string;
            expectedWorkerTypeVersionId: string;
          };
      change:
        | { kind: "memory"; edits: OwnerBoundHarnessEdit[] }
        | { kind: "prompt_note"; edits: OwnerBoundHarnessEdit[] }
        | { kind: "skill"; edits: OwnerBoundHarnessEdit[] }
        | {
            kind: "worker_type_behavior";
            replacement: WorkerTypeBehaviorInput;
          };
      generalizationReason: string;
      predictedEffect: string;
      evidenceEventIds: string[];
      evaluation: ObjectiveEvaluation;
    };
```

One automatic decision targets one owner. A worker-type proposal may contain multiple same-owner harness edits when they form one atomic behavioral change, but it cannot also mutate the originating instance.

`OwnerBoundHarnessEdit` does not accept caller-supplied `scope` or `scopeKey`. The runtime derives them from the target:

- `instance_harness` always means `local` scope keyed by the exact target session;
- `worker_type` always means `worker_type` scope keyed by the exact target worker-type ID.

Deterministic validation rejects any retained or decoded edit whose entry, current version, replacement, retirement target, or name resolves outside that exact owner. Application independently repeats the same ownership check before committing any version.

### Automatic target eligibility

Before invoking the refiner, the supervisor computes the allowed target set.

Instance-local refinement is eligible when the existing trigger and evidence rules pass.

Worker-type refinement is eligible only when:

1. the session adopted a mutable workspace worker-type version;
2. every cited work event is visible to and attributable to that workspace;
3. each cited invocation pinned the exact expected active worker-type version;
4. the evidence spans at least two distinct work episodes;
5. no newer active type version exists;
6. no nonterminal proposal owns the same type, target mechanism, and trigger fingerprint;
7. the versioned automatic-learning policy explicitly permits type refinement;
8. the proposal cannot modify runtime defaults, permissions, credentials, or authority.

A typed user correction may explicitly name `target: "worker_type"` and bypass only the distinct-work-episode threshold. It does not bypass source exposure, authority, scope, secrets, expected-version, governance, or application-time validation.

Manual owner refinement may request `instance`, `type`, or `auto`. Manual type targeting may use one work episode because explicit owner intent supplies the scope decision. Agent-originated manual type proposals remain subject to ordinary source relationship and evidence rules.

### Type-preferred automatic policy

The default target policy for a mutable workspace-typed instance is:

```text
if worker-type generalization is deterministically eligible:
  allow [worker_type, instance]
  instruct the refiner to prefer worker_type for role-general behavior
else:
  allow [instance]
```

The refiner must choose instance ownership for:

- temporary task state;
- one-off debugging observations;
- personal working preferences;
- facts about one branch, artifact, or conversation;
- tactics that depend on one instance’s local history;
- evidence that does not support future-instance behavior.

The refiner may choose type ownership for:

- repeated job-level quality criteria;
- recurring review or investigation behavior;
- a deterministic operation useful to future workers of that type;
- recurring output structure or escalation behavior;
- a reusable type-owned memory whose truth is bounded to that job and workspace;
- a type’s recurring need to delegate another kind of specialist work.

If neither target directly addresses the evidence, the refiner returns `no_change`.

### Automatic-learning policy version

Type mutation broadens the meaning of the current session-local automatic-learning preference. The implementation therefore introduces a version-2 target policy rather than interpreting a retained v1 `on` value as consent to type refinement:

```ts
interface RefinementTargetPolicyV2 {
  version: 2;
  automatic: boolean;
  instanceTargets: boolean;
  workerTypeTargets: "default" | "enabled" | "disabled";
  targetPreference: "instance_only" | "type_preferred";
  generation: number;
}
```

Policy behavior is:

- a fresh device profile stores `workerTypeTargets: "default"`; it remains effectively disabled until the runtime advertises type-target capability, then resolves to type-preferred learning;
- a retained explicit v1 boolean or v1 policy preserves its automatic on/off value but maps to `instance_only` with `workerTypeTargets: "disabled"`;
- the product asks the owner to enable type learning explicitly for such a retained profile;
- pause and resume continue to control all automatic admission without rewriting target consent;
- worker-type target enablement has a separate explicit command and TUI control that stores `"enabled"` or `"disabled"`;
- policy lease ordering and generation revalidation run immediately before every automatic request append;
- already admitted work is not cancelled by a later policy change.

The profile store survives a workspace schema reset, so this migration is mandatory even when the workspace event schema cuts over.

### Type behavior versus type harness

Type behavior remains small:

- title and role;
- purpose;
- standing instructions;
- invocation criteria;
- expected artifact;
- default completion criteria.

Refinement uses:

- memory for retained facts, constraints, preferences, and observations;
- prompt notes for repeated behavioral tendencies;
- tested skills for reusable deterministic operations;
- type-behavior replacement only when the standing job definition itself should change.

The reviewer rejects type-behavior proposals that are knowledge dumps, task transcripts, mutable repository facts, or disguised runtime configuration.

Recurring delegated roles map to worker types rather than a harness `subagent_spec`. Automatic and agent-originated trajectory refinement may revise only an existing exact source type. Creating a new reusable type is an explicit workspace-owner operation with a complete definition and ordinary sealed governance. When automatic evidence suggests a missing role, the refiner returns `no_change` with bounded owner guidance rather than creating workspace catalog state.

### Cross-instance evidence

Every run and retained child invocation pins:

- worker-type ID and version;
- worker-type prompt digest;
- type harness-manifest digest;
- agent-profile version and digest;
- effective system-prompt digest;
- exact selected harness versions.

A rebuildable `worker_type_evidence` projection indexes exact canonical facts that may support type-level scanning:

- session and branch;
- work episode and run;
- task and parent relationship;
- type and version pin;
- terminal status;
- failed cell and effect identities;
- completion-gate outcomes;
- typed user corrections;
- refinement proposal, decision, application, and rollback identities;
- objective evaluation records when available.

The projection is candidate generation only. A type refinement freeze reloads the canonical events and verifies every identity, cursor, type pin, and digest before review.

The first implementation does not infer semantic workflow clusters. It groups evidence only by exact worker-type version, typed trigger identity, and work episode.

Cross-instance evidence does not expand ordinary agent visibility. The workspace-owned automatic-refiner component may query the bounded evidence index across roots only for a mutable workspace worker type. The originating agent receives typed aggregate summaries and exact identities for evidence already visible on its lineage; it does not receive raw unrelated-root events. The sealed governance reviewer may receive bounded redacted excerpts from cross-root events under workspace-owner policy because it is evaluating a workspace type, but those excerpts remain frozen reviewer data and never enter the proposing agent's context.

Agent-originated manual proposals may cite only evidence visible through existing branch-lineage rules. The workspace owner may cite same-workspace evidence. Automatic cross-root evidence access grants no mailbox access, task authority, profile authority, cancellation authority, or mutation rights over the source sessions.

### Trigger scanning and concurrency

Instance-local scans retain current branch-boundary behavior.

For a mutable typed instance, the same boundary may also query a bounded type-evidence window. One boundary scan still admits at most one automatic reflection. Deterministic ordering prefers:

1. an exact user correction;
2. an eligible type-level repeated failure;
3. an eligible instance-local failure;
4. eligible type-level repeated success;
5. eligible instance-local repeated success.

The final order is fixed and tested during implementation rather than inferred from database row order.

Type-level trigger identity includes:

- worker-type ID;
- expected type-version ID;
- trigger kind;
- normalized trigger key;
- evidence frontier.

Workspace-wide nonterminal and consumption projections prevent several instances from admitting the same type review concurrently. Expected-version compare-and-swap remains the final authority. A losing concurrent proposal becomes a visible application conflict and never rebases itself silently.

### Governance

Worker-type proposals reuse the ordinary governed lifecycle:

```text
proposed
  -> deterministically_rejected
  |  validated
       -> review_failed | review_unknown
       |  reviewed_rejected
       |  reviewed_approved
            -> apply_conflict | apply_failed | applied
```

The sealed reviewer receives:

- exact current worker-type version and manifest;
- exact proposed behavior or harness edits;
- origin instance and its relationship to the type;
- every evidence event with version-3 redacted excerpts;
- exact type exposure and work-episode summaries;
- active conflicting proposals and versions;
- immutable product constitution and refinement policy;
- workspace-charter and user-constraint components retained as `null` until those capabilities receive a separate accepted design;
- explicit instance-versus-type generalization criteria;
- runtime boundaries and fields excluded from automatic change;
- evaluation intent;
- exact reviewer model dispatch and limits.

Reviewer approval establishes policy consistency, not empirical improvement.

Worker types and their mandates do not create an implicit workspace charter, user constraint, reviewer policy, or product constitution. Repository `AGENTS.md` content remains untrusted model-facing guidance and is excluded from sealed governance authority under the existing rules.

### Authority

Authorized worker-type proposers are:

- the workspace owner;
- an instance created from the exact active worker-type version;
- the active creation-family parent of such an instance when evidence is visible through its lineage;
- the automatic refiner acting for an eligible source-linked instance.

Siblings, unrelated sessions, inline instances, and sessions pinned to a stale type version cannot automatically revise the type.

No proposer can:

- approve or activate its own proposal;
- select the reviewer;
- edit the sealed constitution;
- change model or budget defaults automatically;
- grant tools, credentials, connectors, effect permissions, or OS authority;
- promote the type outside its workspace;
- rewrite instances or historical invocations.

### Rollback

Worker-type rollback restores one exact earlier approved version through a new immutable version and activation. It records:

- failed active version;
- restored source version;
- exact behavior and harness manifest;
- actor, reason, and evidence;
- any skill test evidence carried forward under exact same-content rules.

Rollback affects new instances and later explicit adoption. It does not rewrite existing instance bindings.

Proposal-level grouped rollback remains available for automatic type-owned multi-edit proposals. Every inverse and the resulting type version commit atomically after validation, except staged skill restoration follows existing exact test-evidence rules.

Rolling back a newly created worker type has no earlier version to restore. Its exact proposal-level inverse retires the created type, deactivates only the initial type-owned harness entries created by that proposal, and records one immutable rollback event. It does not delete the type, versions, proposal, review, tests, instances, or evidence. A type with retained instances remains inspectable after retirement, and those instances keep their exact pins.

## Worker-type lifecycle

### Create

The workspace owner proposes a new workspace worker type through an explicit typed creation operation. Automatic and agent-originated trajectory refinement cannot create catalog entries in the first implementation.

Creation validates:

- unique bounded slug and title;
- complete behavioral fields;
- deterministic prompt rendering;
- type-owned harness references;
- known-secret rejection;
- workspace ownership;
- model and budget defaults against product policy;
- no runtime authority in behavioral content.

Approved creation commits the first type version and active pointer atomically. Generated skills must pass before the type becomes active.

### Instantiate

`sdk.workers.spawn(type, input)`:

1. resolves a type slug or ID to one exact active version;
2. validates workspace visibility and active status;
3. resolves exact harness-manifest dependencies;
4. validates model, budget, parent limits, child depth, capacity, and compatibility;
5. materializes a complete child task and agent profile;
6. commits task, child session, type binding, profile, and invocation provenance atomically;
7. returns only after durable admission.

Stable idempotency reuse must agree on type ID, type version, task, profile meaning, model, budget, completion criteria, and output contract.

### Revise

A worker-type refinement creates a proposal against the exact active version. Approval and application create a new immutable version and active pointer. A stale expected version conflicts.

### Adopt

An existing instance may inspect and adopt a newer version:

```sh
agencity workers adopt code-reviewer@7
```

Adoption:

1. requires the session to belong to the same worker type;
2. previews behavior, manifest, model-default, and budget-default differences;
3. refuses during an active run or recursive invocation;
4. validates all required skills and dependencies;
5. validates current instance model and budget compatibility;
6. creates a type-derived profile version;
7. atomically changes the session type binding and profile active pointer;
8. affects only later invocations.

If the active instance profile has diverged from its last type-derived profile, adoption requires explicit replacement confirmation. There is no automatic merge.

### Retire

Retiring a worker type prevents new instantiation. Existing instances remain runnable under their pinned versions. Retirement does not archive or stop sessions. Restoration creates a new active type version or explicit availability transition with exact provenance.

## Context and invocation pins

Every autonomous run and retained recursive invocation gains one discriminated pin:

```ts
type WorkerTypeInvocationPin =
  | {
      sourceKind: "workspace";
      workerTypeId: string;
      workerTypeVersionId: string;
      typePromptDigest: string;
      harnessManifestDigest: string;
    }
  | {
      sourceKind: "sealed";
      componentId: string;
      componentVersion: number;
      componentDigest: string;
      typePromptDigest: string;
      harnessManifestDigest: string;
    }
  | {
      sourceKind: "inline";
      inlineTypeId: string;
      inlineTypeDigest: string;
      typePromptDigest: string;
      harnessManifestDigest: string;
    };
```

Workspace pins resolve canonical workspace type versions. Sealed pins resolve packaged immutable components by exact ID, version, and digest. Inline pins resolve complete immutable content embedded in `SessionCreated`. Export includes complete workspace and inline material plus the exact sealed component reference and packaged content needed for independent audit. Recovery fails with a dependency error rather than substituting another sealed component or reconstructing inline content from profile prose.

Provider-facing system content remains ordered:

1. immutable Agencity base policy;
2. exact pinned agent profile;
3. exact pinned worker-type behavioral component not already materialized into the profile;
4. invocation response contract;
5. execution guidance.

Phase 0 must eliminate duplicate type/profile text. The preferred implementation materializes role, purpose, and standing instructions into the complete agent profile, while the type pin supplies provenance and type-owned harness selection rather than a second repeated prompt block.

`ContextMaterialized`, `ModelCallRequested`, provider-input records, retries, compaction, and recovery retain the exact type pin and manifest digest. Context assembly resolves only manifest versions named by the adopted type version plus independently authorized local/workspace/user/global context.

An invocation never changes its type, profile, or manifest pins mid-run.

## Storage and canonical events

### Classification

Canonical meaning remains in immutable events. New mutable rows are rebuildable projections or operational indexes.

Canonical worker-type state includes:

- type identity and first version;
- later immutable versions and activation;
- retirement and restoration;
- session origin and adoption pins;
- type-level proposal, review, application, and rollback provenance;
- type invocation and exact harness exposure;
- explicit adoption.

Candidate evidence indexes, catalogs, current pointers, and summary counts are rebuildable.

### Workspace control stream

Worker types cannot be canonically owned by an arbitrary root or by the session that first proposed them. Event schema 6 therefore introduces a non-executable workspace control address:

```ts
type EventAddress =
  | {
      kind: "session_branch";
      sessionId: string;
      branchId: string;
    }
  | {
      kind: "workspace_control";
      workspaceId: string;
      streamId: "worker-types";
    };
```

All existing session and branch events use `session_branch`. Worker-type identity, version, activation, retirement, type-targeted governance application, type-level trigger consumption, and grouped type rollback use `workspace_control`.

The control stream:

- is not a `Session`;
- cannot run a model, own a task, hold a mailbox, receive a budget, or acquire an execution lease;
- is globally ordered with ordinary workspace events through the existing canonical sequence;
- accepts writes only through typed workspace services with an authenticated principal and an exact origin route;
- retains proposer and reviewer session references without transferring event ownership to those sessions;
- remains after one root or instance is deleted;
- participates in synchronization, conflict handling, export, and guarded workspace deletion.

Governance proposer and reviewer children remain ordinary durable sessions. Their route-owned review events link to the workspace-control proposal and application identities. Storage validates the complete cross-stream relationship before application.

The event table, storage contract, sync envelope, subscription/query APIs, deletion planner, and architecture checks must support this discriminated address. Code that requires a session branch must reject `workspace_control` rather than manufacturing session IDs.

### Proposed canonical events

- `WorkerTypeCreated`
- `WorkerTypeVersionCreated`
- `WorkerTypeActivated`
- `WorkerTypeRetired`
- `WorkerTypeAdopted`
- `WorkerTypeInvoked`
- existing governed-refinement events extended with a `worker_type` target
- existing harness events extended with `worker_type` scope
- existing run, context, and model-call events extended with exact type pins

`SessionCreated` gains a required complete type binding.

Event names and payloads are finalized in the ADR and domain phase. No event stores only a mutable projection key when complete durable meaning is required for replay.

### Proposed projections

- `worker_types`
- `worker_type_versions`
- `workspace_worker_types`
- `session_worker_type_bindings`
- `worker_type_invocations`
- `worker_type_evidence`
- indexes for active type slug, type/version instances, governance target, trigger consumption, and adoption eligibility

Every table is classified in `docs/mutable-tables.md`, included in architecture checks, rebuilt from canonical events, and covered by reopen and idempotent-migration tests.

### Schema cutover

Requiring a type binding in `SessionCreated`, extending invocation pins, and adding `worker_type` harness scope changes accepted event meaning. Before release, the implementation should use a workspace event-schema cutover rather than silently reinterpret version-5 history.

The expected cutover is:

- event schema version 6;
- a reducer-version increment;
- a discriminated session-branch or workspace-control event address;
- a numbered storage migration for new projections and indexes;
- a profile-store migration from retained v1 automatic preferences to instance-only version-2 target policy;
- fail-closed reset guidance for event-schema versions 1–5 before decode, migration, projection, sync ingestion, or recovery;
- no retained-event rewriting;
- no inference of historical worker types from task text or profile prose.

A separately reviewed importer may preserve old sessions as historical records, but runnable imported sessions require an explicitly selected type and freshly materialized profile before new work. The importer is not required for this plan.

## Runtime implementation

### Domain

Primary files:

- `src/domain/agent-profile.ts`
- `src/domain/agent-invocation-contract.ts`
- `src/domain/harness.ts`
- `src/domain/refinement-governance.ts`
- `src/domain/refinement-review.ts`
- `src/domain/events.ts`
- `src/domain/state.ts`
- `src/domain/reducer.ts`
- new `src/domain/worker-type.ts`

### Runtime services

Add:

- `WorkerTypeService` for create, resolve, list, history, activation, retirement, and adoption;
- `WorkerTypeEvidenceService` for bounded candidate generation and canonical verification;
- typed worker admission through the existing `AgentService`;
- type-aware refinement target admission and governance application;
- type-aware context and invocation pinning.

Primary files:

- replace or retire `src/runtime/specs.ts`;
- `src/runtime/agents.ts`;
- `src/runtime/agent-runs.ts`;
- `src/runtime/context.ts`;
- `src/runtime/refinement-context.ts`;
- `src/runtime/refinement-triggers.ts`;
- `src/runtime/refiner.ts`;
- `src/runtime/refinement-governance.ts`;
- `src/runtime/harness.ts`;
- `src/runtime/memory.ts`;
- `src/runtime/skill-management.ts`;
- `src/runtime/recovery.ts`;
- `src/runtime/supervisor.ts`;
- runtime package barrels.

### Storage and synchronization

Primary files:

- `src/storage/libsql.ts`;
- new numbered migrations under `src/storage/migrations/`;
- storage contracts and conformance fixtures;
- `src/sync/service.ts`;
- replication-envelope validation and divergence tests;
- export, deletion, and rebuild services.

Type activation uses compare-and-swap. Offline concurrent versions remain visible divergent claims; no last-writer rule silently chooses the active type. A receiving non-owner device may inspect synchronized type history but cannot execute work unless ordinary session execution ownership permits it.

## Protocol, SDK, CLI, and TUI

### Protocol and `AgentClient`

Proposed operations:

```http
GET  /worker-types
POST /worker-types
GET  /worker-types/:type
GET  /worker-types/:type/history
GET  /worker-types/:type/instances
POST /worker-types/:type/proposals
POST /worker-types/:type/rollback
POST /sessions/:session/worker-type-adoptions?branch=:branch
GET  /learning/snapshot?scope=workspace
GET  /refinement-target-policy
PUT  /refinement-target-policy
```

Public responses retain exact IDs, versions, digests, active/historical state, source evidence, governance, application, adoption, and rollback. List operations remain bounded and omit full prompts unless detail is explicitly requested.

### Console SDK

Add:

```ts
sdk.workers.list(options?)
sdk.workers.get(type)
sdk.workers.spawn(type, input)
sdk.workers.spawnMany(inputs)
sdk.workers.instances(type, options?)
sdk.workers.proposeRefinement(type, input, options?)
sdk.workers.adopt(target, version, options?)

sdk.harness.review({
  instructions,
  target: "auto" | "instance" | "worker_type",
  allowedKinds,
  wait,
})
```

`sdk.workers.spawn` uses normal durable child admission. Generated code cannot create or revise model/budget/permission policy, spoof owner identity, approve proposals, or adopt a type for an unrelated session.

The existing `sdk.specs.spawn` and `SubagentSpecService` are removed in the schema cutover. Public documentation and generated execution guidance present one worker API. There is no schema-6 compatibility alias or second specification lifecycle.

### CLI

Proposed commands:

```sh
agencity workers types
agencity workers show TYPE
agencity workers history TYPE
agencity workers instances --type TYPE
agencity workers create JSON
agencity workers propose TYPE JSON
agencity workers rollback TYPE REVISION JSON
agencity workers adopt TYPE@REVISION

agencity refine --target auto "review recent experience"
agencity refine --target instance "retain this worker's local lesson"
agencity refine --target type "improve this kind of worker"
agencity refine targets
agencity refine targets type on|off
agencity refine snapshot --workspace
```

The product uses human-readable slugs and revision numbers for ordinary operation. Exact IDs remain in JSON and diagnostic output.

### TUI

Add:

- worker title and adopted type revision in route metadata;
- a worker-type inspector with current version, history, diffs, instances, evidence, and governance;
- creation of a child from a visible worker type;
- refinement target display and explicit manual target selection;
- adoption preview and confirmation at an idle boundary;
- a workspace adaptation snapshot reachable from learning controls;
- clear labels for instance-local, type-owned, workspace, inherited, inactive, and rolled-back content.

Navigation remains observational. Opening a type or snapshot does not select a root, start work, adopt a version, or mutate learning policy.

## Workspace adaptation snapshot

`agencity refine snapshot --workspace` is a deterministic read-only projection. It does not run a model, trigger refinement, or mutate canonical state.

The snapshot records:

- workspace event frontier;
- device automatic-learning policy generation;
- root, family, session, and worker-type coverage;
- active, retired, and conflicted worker types;
- instances grouped by origin and adopted type versions;
- instance-local and type-owned active artifacts;
- workspace/user/global artifacts currently effective for those routes;
- pending, applied, rejected, failed, unknown, rolled-back, and `no_change` learning activity;
- trigger, evidence, proposal, reviewer, application, adoption, and rollback chains;
- post-activation outcome evidence separately from reviewer approval;
- scan-unavailable, missing dependency, conflict, and truncation warnings.

The report distinguishes:

- **effective here:** content currently eligible for one or more workspace routes;
- **learned here:** content whose proposal evidence originated in the workspace;
- **instance deviation:** local content or profile behavior not present in the adopted type;
- **type evolution:** active and historical changes intended for future instances;
- **outcome evidence:** attributable later results, including explicit absence.

Shared artifacts are deduplicated by exact version ID and list their affected types or instances. Default output is bounded and summarized deterministically. `--json` exposes typed records. `--include-inactive`, `--type`, `--family`, `--instance`, `--kind`, and `--since` provide filtering. Exact content and evidence use existing detail or inspect operations rather than unbounded list output.

## Recovery, sync, export, and deletion

### Recovery

Startup recovery:

- rebuilds type, active-pointer, instance-binding, invocation, evidence, and governance projections;
- resumes nonterminal type review and staged skill application oldest-first in bounded pages;
- redelivers terminal notices exactly once;
- never adopts a type, reruns an effect, or respawns an instance from projection state;
- rejects missing or digest-mismatched type dependencies;
- preserves explicit application conflict and unknown outcomes.

### Synchronization

Worker-type events synchronize through immutable envelopes. Concurrent offline revisions:

- retain both immutable versions;
- do not silently choose an active winner;
- create an explicit conflict or divergent active claim;
- prevent new instantiation or adoption when no unique valid active version exists;
- leave already pinned instances inspectable and runnable only when all pinned dependencies are available and execution ownership permits.

### Export

Workspace export includes:

- every type and version;
- complete exact prompt and manifest content;
- type-owned harness versions and skill artifacts;
- instance origin and adoption bindings;
- invocation pins and exposure provenance;
- proposals, frozen reviewer inputs, decisions, application outcomes, notices, and rollback;
- type-evidence source events and objective evaluation records;
- conflict and missing-dependency state.

An export that cannot explain a type-derived invocation is partial, not successful.

### Deletion

Owned workspace deletion removes worker types and their projections with the existing guarded workspace operation.

Session deletion never cascades through worker-type evidence. The deletion planner refuses an instance deletion while retained workspace-control proposals, type versions, frozen reviews, evaluation records, or other surviving sessions require that instance's events to explain active or historical behavior. The refusal lists bounded dependency identities and directs the owner to delete the complete workspace scope or use a future explicitly reviewed provenance-detachment operation. No such detachment operation is included in this plan.

When no retained cross-scope dependency exists, session deletion removes the instance and its local state but does not delete a workspace worker type shared by other sessions. Ordinary refinement cannot delete or retire a type. The exact proposal-level rollback of a type-creation proposal is the sole refinement exception: it retires that created type and deactivates proposal-created initial harness entries without deleting history. Other retirement is an explicit owner management operation. Type retirement is reversible behavioral availability state; physical deletion remains a guarded data-control operation that checks retained references, quiescence, remote administration, receipts, and retry state.

## Security and authority

The runtime remains trusted-local.

- Worker-type prompts and type-owned skills do not sandbox generated code.
- Type behavior cannot grant runtime capability.
- Parent authority bounds child model, budget, depth, concurrency, tools, and effects.
- Automatic type refinement cannot change model or budget defaults.
- Known credentials and repository instruction content remain excluded from governance evidence excerpts.
- Proposal content, type text, and evidence are untrusted reviewer data.
- Reviewer failure, malformed output, timeout, refusal, or unknown outcome never implies approval.
- Cross-session type evidence is available only within one owned workspace and does not create multi-tenant confidentiality.
- User/global worker types require a separate data-lifecycle and authority plan.

## Bounds and performance

Phase 0 defines hard limits for:

- worker types per workspace;
- worker-type versions per type;
- behavior and exact-prompt bytes;
- harness bindings per type version;
- type-owned artifact bytes and skill artifacts;
- instances listed per type;
- evidence records, work episodes, and source events per refinement;
- concurrent type proposals and reviews;
- type-level automatic admissions per boundary and per recent proposal window;
- snapshot records and serialized bytes;
- history and diff responses;
- adoption preview bytes;
- recovery page size.

Type evidence uses an indexed rebuildable projection. The implementation must not scan complete history for every type at every run boundary. Candidate rows are bounded before canonical event reload and verification.

Ordinary provider context does not include the workspace worker catalog, instance catalog, or adaptation snapshot. The model queries visible worker types on demand before delegation.

## Delivery plan

### Phase 0 — Constitution, ADR, and exact contracts

1. Accept the first-class worker-type product direction.
2. Define worker type, instance, task, profile, harness, and runtime-authority boundaries.
3. Confirm workspace-only reusable types and sealed/inline type semantics.
4. Confirm explicit adoption and no silent existing-instance mutation.
5. Fix type-preferred eligibility and typed-correction override rules.
6. Fix the version-2 automatic target policy and retained-v1 migration behavior.
7. Fix type prompt, harness manifest, model-default, and budget-default contracts.
8. Fix workspace-control event addressing and cross-stream governance ownership.
9. Define event schema 6 and reducer cutover behavior.
10. Accept a new ADR amending ADRs 0006 and 0012 without weakening their durable relationship, governance, or authority decisions.
11. Update ADR indexes, backlinks, `AGENTS.md`, and this plan’s status only after acceptance.

Exit evidence:

- accepted ADR;
- reviewed domain contracts and state diagrams;
- explicit supersession/amendment list;
- no unresolved authority or migration decision.

### Phase 1 — Canonical worker types and session bindings

1. Add worker-type validation, rendering, digests, immutable versions, and active pointers.
2. Add workspace, sealed, and inline type sources.
3. Require a complete type binding in every new `SessionCreated`.
4. Add sealed repository-root and task-specialist types.
5. Add discriminated type pins to every autonomous run, retained recursive invocation, context, model call, provider-input record, compaction, recovery path, snapshot, and public inspection response.
6. Refuse model execution whenever the exact type or manifest pin cannot be materialized.
7. Add the non-executable workspace control stream and cross-stream storage validation.
8. Add the minimum `WorkerTypeService` resolution and typed child-admission path required to replace specification spawn.
9. Remove `subagent_spec` from domain schemas and refiner output, remove `SubagentSpecService`, `SubagentSpecInvoked`, `sdk.specs`, and specification-source profile fields, and add their worker-type replacements.
10. Migrate profile-store automatic policy to version 2: retained v1 choices become worker-type-disabled, fresh choices remain `"default"`, and effective worker-type targets stay unavailable until Phase 5.
11. Add storage migration, projections, rebuild, constraints, and architecture checks.
12. Cut over to event schema 6 with fail-closed older-workspace guidance only after all mandatory admission, invocation, specification-removal, and consent-migration work is present.

Exit evidence:

- fresh root, ordinary child, explicit-profile child, and private recursive child all retain exact type provenance;
- no schema-6 runnable session or invocation can exist without exact type provenance;
- schema 6 exposes no `subagent_spec` domain kind, event, service, profile source, refiner result, or public API;
- replay and rebuild produce identical type state;
- invalid or missing type dependencies prevent runnable admission.

### Phase 2 — Typed worker admission and product API hardening

1. Complete `WorkerTypeService` resolve, list, history, and private version-application primitives; creation, retirement, and rollback remain unavailable outside the governed or owner-management paths added in Phase 4.
2. Add batch `sdk.workers.spawnMany`, retained handles, and exact result inspection.
3. Harden initial profile and task materialization from worker types.
4. Preserve parent limits, awaited-child capacity, idempotency, cancellation, and usage attribution.
5. Add protocol and owner inspection for types, history, and instances.
6. Add focused type-admission and adversarial tests.

Exit evidence:

- a parent instantiates a typed child through normal durable task admission;
- restart returns the same handle and never duplicates the child;
- old and new type versions create children with exact different pins;
- no type field widens parent authority.

### Phase 3 — Type-owned harness and exact context

1. Add `worker_type` harness scope.
2. Add immutable type harness manifests.
3. Extend memory, prompt-note, skill, retrieval, and context policy for adopted types.
4. Extend the mandatory Phase-1 type pins with exact non-empty manifest selection and historical manifest-authorized resolution.
5. Stage type-owned generated skills through compile and declared tests before type activation.
6. Add context-size, missing-artifact, stale-manifest, and secret tests.

Exit evidence:

- an instance receives only exact manifest versions from its adopted type;
- later type edits do not alter existing instance context;
- context and provider-input provenance identify every effective type artifact.

### Phase 4 — Instance-versus-type refinement

1. Extend the refiner contract with explicit owner target and generalization reason.
2. Add deterministic allowed-target computation.
3. Keep instance-local behavior for ineligible evidence.
4. Add explicit governed owner creation, explicit owner retirement, exact creation rollback, and manually targeted worker-type revision governance validation with owner-bound harness edits and frozen review input.
5. Add atomic non-skill type application and staged skill type application.
6. Add terminal delivery, bounded reproposal, exact rollback, and application conflict.
7. Add `--target auto|instance|type` to CLI, TUI, protocol, and SDK while keeping automatic scans instance-only until Phase 5.

Exit evidence:

- the same trigger can produce a justified instance change, type change, or `no_change`;
- evidence for a missing recurring role produces owner guidance rather than automatic catalog mutation;
- manually targeted type proposals cannot use stale or unrelated type evidence;
- reviewer approval alone is not reported as outcome proof.

### Phase 5 — Cross-instance evidence and automatic generalization

1. Use the mandatory exact Phase-1 worker-type pins to index eligible work episodes.
2. Build the bounded `worker_type_evidence` projection.
3. Add type-version trigger identities, nonterminal suppression, and consumption frontiers.
4. Make worker-type target capability available for the Phase-1 version-2 policy, resolve fresh `"default"` choices to type-preferred, preserve migrated v1 `"disabled"` choices, and enforce lease ordering and generation revalidation.
5. Add type-preferred automatic selection for eligible existing source types.
6. Require two distinct work episodes for automatic type targeting.
7. Add explicit typed correction targeting.
8. Prevent duplicate concurrent type reviews across instances.
9. Add bounded post-activation outcome summaries without making them activation authority.

Exit evidence:

- evidence from separate pinned instances or runs can support one type proposal;
- evidence from an older or different type version cannot silently revise the active type;
- concurrent scanners admit at most one logical review per evidence frontier.

### Phase 6 — Adoption and worker product surfaces

1. Add idle-boundary adoption with exact preview and compare-and-swap.
2. Add divergence detection for instance profiles.
3. Add worker-type CLI and TUI catalogs, history, diffs, instances, proposals, and rollback.
4. Add type selection during child creation.
5. Add human-readable slugs and bounded revision selectors.
6. Keep all operations protocol-backed and no-ID for ordinary use.

Exit evidence:

- new instances use the active type;
- old instances remain pinned;
- explicit adoption changes only later invocations;
- divergent instance profiles require explicit resolution.

### Phase 7 — Workspace adaptation snapshot

1. Add the typed runtime snapshot projection.
2. Add protocol, `AgentClient`, CLI, and TUI renderers.
3. Distinguish effective, originated, inherited, local, type-owned, inactive, and rolled-back state.
4. Join exact trigger-to-evidence-to-proposal-to-review-to-application-to-outcome provenance.
5. Add bounds, truncation, filtering, digest stability, and consistency-frontier tests.

Exit evidence:

- one workspace command gives a bounded aggregate view across roots, families, types, and instances;
- shared artifacts are not double-counted;
- missing evidence and absent post-activation evaluation remain explicit.

### Phase 8 — Lifecycle hardening and installed acceptance

1. Add crash-boundary, recovery, sync divergence, export audit, deletion refusal, and rebuild coverage.
2. Add linked-executable black-box journeys for type creation, spawn, refinement, adoption, snapshot, rollback, detach, and resume.
3. Update all public documentation and capability claims.
4. Run independent review and the full deterministic gate.
5. Report external live-provider, official Turso Sync, and Turso Cloud checks as passed, failed, or skipped separately.

Exit evidence:

- `bun run verify` passes;
- installed acceptance uses only documented executable and protocol-backed paths;
- gated external skips are not represented as verification.

## Test plan

### Domain and reducer

- Worker-type rendering and digest are deterministic.
- Duplicate event application is a no-op.
- Invalid type version, activation, retirement, adoption, or manifest transition fails.
- Session creation without a valid type binding fails.
- Sealed and inline types cannot receive workspace type revisions.
- Historical reduction retains exact old type and profile pins.
- Type rollback creates a new version and never rewrites history.
- Workspace-control events cannot be projected as session activity or acquire execution state.

### Admission and families

- Type spawn creates exactly one task and child.
- Batch spawn is atomic.
- Idempotency reuse with changed type meaning conflicts.
- Child model, budget, depth, and concurrency cannot widen parent limits.
- Admission retains whether effective model and budget came from inheritance, type defaults, or explicit override.
- Typed workers retain normal queue, steer, result, cancellation, and usage semantics.
- A typed instance can delegate a narrower task to another visible type.
- Unrelated existing sessions are never reassigned or reparented.

### Context and harness

- Every invocation pins type, manifest, profile, and effective prompt.
- Existing instances do not observe later type-owned artifacts before adoption.
- Superseded manifest-bound versions remain resolvable until explicit quarantine, removal, or dependency loss.
- Local instance artifacts remain separate from type-owned artifacts.
- Type, local, workspace, user, and global context ordering is deterministic.
- Missing or corrupt manifest dependencies fail visibly.
- Generated type skills compile and pass declared tests before activation.
- Compaction and recovery preserve exact type provenance.

### Refinement and governance

- Ineligible automatic evidence permits instance-only targeting.
- Eligible evidence permits type or instance targeting.
- Two distinct work episodes satisfy the automatic type threshold.
- One episode does not, absent an explicit typed correction.
- Automatic and agent-originated trajectory refinement cannot create a workspace type.
- Owner-created types use complete governed creation and leave no active type or orphan active harness content after rejection or failure.
- Manual owner type targeting may use one attributable episode.
- Retained v1 automatic-on policy permits instance learning but not worker-type mutation.
- Fresh version-2 policy is type-preferred, and target enablement is generation-revalidated before append.
- Stale, unrelated, sibling, inline, sealed, or cross-workspace targets reject.
- Every type-owned harness edit is structurally bound to the exact target type.
- Automatic type proposals cannot modify runtime defaults or authority.
- Valid proposals receive exactly one sealed reviewer decision.
- Rejected, failed, unknown, stale, malformed, or conflicting proposals activate nothing.
- Concurrent type revisions conflict by expected version.
- Terminal notices survive restart and remain exact-once.
- Rollback restores exact content and manifest provenance.
- Rolling back a newly created type retires it and deactivates proposal-created initial harness entries without deleting history.

### Evidence

- Candidate projection rows always reload and verify canonical events.
- Type evidence identifies exact exposed versions and work episodes.
- Evidence from different type versions is not merged.
- An instance never receives raw unrelated-root evidence through automatic type aggregation.
- The sealed reviewer receives only bounded redacted cross-root excerpts under workspace policy.
- Trigger consumption prevents duplicate logical reviews.
- Post-activation evidence is distinguished from approval and skill tests.
- Missing evaluation remains explicit.
- Bounds and truncation never imply complete evidence.

### Adoption

- Adoption is unavailable during active work.
- Adoption requires the same type identity.
- Adoption validates model, budget, manifest, and skill dependencies.
- Adoption does not change the session model or budget; separate owner operations remain required.
- Adoption creates an exact type-derived profile and binding.
- Divergent profiles require explicit resolution.
- Recovery cannot partially apply adoption.
- Later invocations use the adopted version; earlier invocations retain old pins.

### Storage, sync, and data control

- Migration/open is idempotent.
- Projection rebuild restores all type state.
- Concurrent offline type activation remains an explicit conflict.
- Export contains every dependency needed to explain typed invocations.
- Partial export is reported when a type dependency is missing.
- Session deletion does not remove shared type content.
- Session deletion refuses when retained type provenance depends on that session's events.
- Workspace deletion includes all type content and projections.
- Sync does not grant execution ownership or choose a last-writer type.

### Product

A linked-executable acceptance journey must:

1. create or select a workspace;
2. create a reusable Code Reviewer type;
3. spawn two review instances from the same exact version;
4. complete attributable work through both instances;
5. produce one instance-local refinement;
6. produce one eligible type refinement;
7. prove a new instance uses the new type version;
8. prove an old instance remains pinned;
9. explicitly adopt the new version on the old instance;
10. prove later invocation pins change and historical pins do not;
11. inspect type history, evidence, governance, and rollback;
12. run the workspace adaptation snapshot;
13. detach and restart during review or adoption;
14. resume without duplicate type, session, task, model call, proposal, activation, or notice;
15. roll back the type and prove only later new/adopted work uses the restoration.

## Documentation obligations

Each shipping phase updates relevant documentation in the same change.

Required updates include:

- `AGENTS.md` for accepted direction, current status, terms, invariants, and limitations;
- a new ADR plus `docs/decisions/README.md` and `docs/README.md`;
- `README.md` and `docs/user-guide.md` for worker workflows;
- `docs/architecture.md` for type/instance/profile/task boundaries and context composition;
- `docs/events.md` and `docs/mutable-tables.md`;
- `docs/protocol.md`, `docs/api.md`, and `docs/console-sdk.md`;
- `docs/configuration.md` for automatic target policy and bounds;
- `docs/operator-guide.md` and `docs/recovery.md`;
- `docs/security.md`;
- `docs/data-lifecycle.md`;
- `docs/capabilities.md`;
- `docs/verification.md`;
- `plans/README.md` and this plan’s status and implementation log.

Public documents describe only shipped behavior. This plan remains the planning source until black-box product paths pass.

## Risks and safeguards

### Type pollution

One task-specific lesson may degrade every future worker of a type. Deterministic eligibility, distinct work episodes, explicit generalization reason, sealed review, exact diffs, outcome evidence, and rollback limit this risk.

### Class prompt growth

Repeated changes may turn a type into an unbounded knowledge dump. Small behavior fields, type-owned harness artifacts, immutable manifests, byte bounds, and mechanism-specific validation keep the type focused.

### Existing-instance surprise

Automatically changing all instances would make durable identity difficult to explain. Instances remain pinned and adoption is explicit.

### Stale evidence

Evidence from an older type may no longer apply. Automatic type proposals require the exact active version used by the evidence and fail on active-version drift.

### Duplicate type reviews

Several instances may observe the same failure. Type-level trigger fingerprints, nonterminal suppression, consumption frontiers, and expected-version compare-and-swap prevent duplicate logical application.

### Reviewer agreement overclaim

Approval establishes policy consistency only. Product views show skill tests and post-activation outcomes separately and preserve “no evidence” as a valid state.

### Runtime-authority confusion

A job title or mandate may claim powers the runtime does not grant. Type fields are behavioral, automatic changes exclude runtime defaults, and ordinary runtime services remain authoritative.

### Premature organization machinery

Worker types may invite routing, hierarchy, and staffing abstractions. The first implementation only instantiates new children inside the caller’s existing family and task model. Existing-session assignment and organization control remain deferred.

### Cross-instance data leakage

Type evidence crosses sessions inside one workspace. Canonical workspace ownership and bounded reviewer excerpts apply. This is not a confidentiality boundary for hostile local tenants.

### Migration cost

The required session and invocation pins justify a pre-release schema cutover. The product fails closed rather than inventing worker-type provenance for old history.

## Completion criteria

The plan is complete when:

1. Every runnable session has exact sealed, inline, or workspace worker-type provenance.
2. `Session` remains the only executable agent identity.
3. `Task` remains the ordinary delegated-work relationship.
4. A parent can instantiate a workspace worker type as a normal durable child.
5. Worker-type behavior cannot widen runtime authority.
6. Every invocation pins exact type, profile, manifest, and effective prompt meaning.
7. Type-owned memories, prompt notes, and skills use immutable manifest versions.
8. Existing instances do not silently receive later type changes.
9. Explicit adoption changes only later invocations and handles divergent instance profiles safely.
10. Automatic refinement computes allowed targets before the model chooses.
11. Eligible evidence may produce an instance change, type change, or `no_change`.
12. Automatic type targeting requires exact active-version exposure and at least two work episodes, except explicit type-targeted correction.
13. Every type proposal receives deterministic validation and one separate sealed review.
14. Approved proposals revalidate and apply through immutable versions.
15. Rejected, failed, unknown, stale, malformed, or conflicting proposals activate nothing.
16. Type rollback restores exact earlier content through a new version.
17. Reviewer approval, skill tests, and post-activation outcomes remain distinct.
18. Cross-instance evidence is bounded, canonical-event verified, and version attributable.
19. Concurrent scans and proposals cannot silently duplicate or overwrite type learning.
20. Workspace snapshot explains effective and learned state across roots, families, types, and instances.
21. Recovery, sync, export, and deletion preserve complete type provenance and uncertainty.
22. No class inheritance, existing-session reassignment, management hierarchy, or global type promotion is introduced.
23. Event schema, reducer, migrations, architecture checks, and retained-version policy agree.
24. Linked-executable acceptance proves creation, spawn, local refinement, type refinement, adoption, snapshot, rollback, detach, and resume.
25. `AGENTS.md`, ADRs, public documentation, capability claims, and this plan match shipped behavior.
26. Typecheck, architecture checks, focused tests, deterministic verification, and acceptance pass.
27. External live-provider, official Turso Sync, and Turso Cloud results are reported separately as pass, fail, or skip.
28. Workspace-owned type events use a non-executable canonical control stream rather than an arbitrary root session.
29. Retained version-1 automatic-learning consent never silently enables worker-type mutation.
30. Historical manifest-bound artifacts remain exact and usable unless explicitly quarantined, removed, incompatible, or missing.
31. Session deletion refuses rather than breaking surviving type evidence or governance provenance.

## Deferred extensions

- User-profile and cross-workspace worker-type catalogs.
- Signed or published worker-type packages.
- Worker-type import/export independent of workspace export.
- Cross-family assignment to an existing specialist.
- Type-aware assignment queues or routing.
- Worker availability, load balancing, or scheduler placement.
- Type hierarchies, inheritance, composition graphs, or capability interfaces.
- Automatic adoption by existing instances.
- Fleet-wide owner-approved adoption campaigns.
- Semantic task-family clustering.
- Candidate/control rollout and automatic regression rollback for type versions.
- Dedicated automatic-learning spend budgets and aggregate review-rate limits.
- Hosted organization administration and multi-tenant authorization.
- Dynamic typed RPC resources between worker types.

## Implementation log

No implementation work has begun.

# Workspace knowledge and deterministic field manual plan

**Status:** Proposed  
**Date:** August 18, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Depends on:** [Durable agent profiles and automated refinement review](./2026-08-08-adaptive-agent-city-plan.md), [Default automatic adaptive learning](./2026-08-11-default-automatic-adaptive-learning-plan.md), and the workspace-control foundation proposed by [First-class worker types and instance refinement](./2026-08-18-worker-types-and-instance-refinement-plan.md)  
**Related decisions:** [Event-sourced relational memory and measured refinement](../docs/decisions/0002-relational-memory-refinement.md), [Profile, workspace, and credential boundaries](../docs/decisions/0008-profile-workspace-and-credentials.md), and [Durable agent profiles and automated refinement governance](../docs/decisions/0012-durable-agent-profiles-automated-refinement-governance.md)

## Summary

Agencity should continuously build an evidence-backed model of the work performed in a workspace and render that model as readable field manuals.

The workspace database remains the source of truth. Complete raw experience stays in canonical event history. Model-assisted distillation creates immutable, typed workspace-knowledge revisions with exact evidence, authority, confidence, freshness, conflict, and lifecycle provenance. Deterministic renderers then compile active knowledge into Markdown and typed JSON without calling a model or consulting unpinned external state.

The product model is:

```text
Canonical workspace experience
  -> bounded work episodes and exact evidence
  -> governed knowledge proposals
  -> immutable workspace knowledge revisions
  -> rebuildable retrieval, count, freshness, and conflict projections
  -> deterministic field-manual renders
```

This direction captures more than repository documentation. Workspace knowledge includes:

- domain concepts and vocabulary;
- recurring task families and work patterns;
- explicit and inferred preferences;
- explicit and inferred goals and success criteria;
- standard operating procedures;
- decisions, constraints, conventions, and exceptions;
- failure patterns, hazards, and recovery tactics;
- stakeholder and collaboration context;
- unresolved questions, contradictions, and stale claims.

The database stores both structured semantics and bounded expressive prose. Structure supports counting, filtering, retrieval, maintenance, and deterministic rendering. Rich text preserves explanations, rationale, examples, exceptions, and tacit context that cannot be represented usefully as scalar fields alone.

Field manuals are derived products, not a second source of truth. The same workspace knowledge can produce a complete workspace manual, a process guide, a task briefing, a preferences guide, or a compact model-facing selection. A complete retained render input and renderer package produce the same bytes. Canonical render receipts additionally retain the exact rendered pages in content-addressed storage, so a historical export or publication does not depend on later source availability.

Repository `AGENTS.md`, `README.md`, and `docs/` remain ordinary owner-visible files. Automatic learning does not silently rewrite them. Publishing selected workspace knowledge into repository files is a separate explicit file-effect workflow with normal review and Git semantics.

## Product decision

Agencity treats raw experience, distilled knowledge, behavioral adaptation, and rendered documentation as separate layers.

- **Raw experience** remains complete canonical event history.
- **Workspace knowledge** records what the system currently has evidence to believe about the workspace and its work.
- **Behavioral harness content** records how an agent or worker should behave.
- **Field manuals** are deterministic human-readable projections of workspace knowledge.
- **Repository documentation** is explicit workspace file state, not an automatic side effect of knowledge activation.

Knowledge distillation may use a model because identifying a tacit goal, recurring process, or meaningful exception is a semantic judgment. The exact proposal and its evidence are retained. Once a knowledge revision is active, rendering is deterministic.

A renderer:

- makes no model call;
- does not inspect the live process heap;
- does not read mutable workspace files unless their exact content digest is part of the render input;
- uses stable ordering and a versioned rendering contract;
- produces exact bytes, a content digest, and complete source provenance;
- shows stale, conflicted, unsupported, and unavailable knowledge rather than silently resolving it.

The first implementation is workspace-local. It does not train model weights, publish cross-workspace knowledge, create a global organization model, or infer authority from repeated behavior.

## Current state and gap

Agencity already retains the foundations needed for this capability:

- complete append-only session and branch history;
- local, workspace, user, and global harness scopes;
- memories for claims, preferences, decisions, observations, and constraints;
- prompt notes for repeated behavioral tendencies;
- tested skills for reusable deterministic operations;
- reusable delegated-role material;
- exact context-selection provenance;
- governed proposals, deterministic validation, separate sealed review, application-time revalidation, rollback, synchronization, export, and deletion controls;
- content-addressed artifacts and imported document chunks;
- bounded FTS5 memory candidate retrieval.

Those foundations do not currently form a workspace knowledge corpus:

- automatic learning targets one session rather than shared workspace knowledge;
- separate workspace roots do not organically pool local learning;
- memory is a single bounded text field rather than a structured knowledge-document model;
- automatic triggers do not identify semantic task families, recurring processes, stale knowledge, or contradictions;
- the refiner may produce only memory, prompt-note, skill, or delegated-role changes;
- no canonical field-manual definition or deterministic renderer exists;
- no product surface explains everything the workspace has learned as one coherent body;
- repository instructions are loaded as untrusted behavioral input and are deliberately excluded from sealed refinement governance;
- imported documents are session/family inputs, not workspace-owned maintained knowledge;
- artifacts provide immutable bytes but no knowledge identity, revision, freshness, retrieval, or activation lifecycle;
- retrieval is lexical candidate generation and does not provide corpus-level synthesis.

The implementation must add a distinct workspace knowledge model rather than stretching memories, artifacts, imported documents, or `AGENTS.md` beyond their existing ownership and lifecycle semantics.

## Goals

- Preserve every retained raw event and evidence reference after distillation.
- Build a coherent workspace-owned model of what Agencity has learned from work.
- Capture factual, procedural, preferential, goal-oriented, and tacit knowledge without treating inference as explicit user authority.
- Represent concise structured semantics and expressive explanatory prose together.
- Let separate roots and worker instances contribute evidence to shared workspace knowledge.
- Make every generated statement attributable to exact events, artifact references, and source digests.
- Support immutable revision, compare-and-swap activation, conflict, staleness, retirement, restoration, and rollback.
- Derive occurrence counts, exposure counts, outcome summaries, and recency from canonical evidence rather than mutable business-truth counters.
- Retrieve a bounded task-relevant knowledge selection with complete candidate, rejection, and selection provenance.
- Render field manuals deterministically from exact database state.
- Produce multiple manual views from the same active knowledge.
- Keep missing dependencies, uncertainty, contradictions, and stale source material visible.
- Keep repository publication explicit and reviewable.
- Preserve local-first operation, synchronization divergence, export completeness, guarded deletion, and trusted-local security boundaries.
- Provide black-box evidence from the installed product rather than only service-level tests.

## Non-goals

- Training or fine-tuning model weights.
- Treating the database as only a blob store for generated Markdown.
- Replacing raw events with summaries or compaction output.
- Treating a field manual as canonical state.
- Automatically editing or committing `AGENTS.md`, `README.md`, `docs/`, source code, or other repository files.
- Treating repository-authored instructions as trusted knowledge or refinement-review policy.
- Converting every message or model statement into accepted workspace knowledge.
- Presenting inferred preferences or goals as explicit user declarations.
- Treating frequency, reviewer approval, or successful runs as proof that a claim is true or useful.
- Silently choosing a winner between contradictory claims or concurrent offline activations.
- Injecting the complete knowledge corpus or complete field manual into every model call.
- An unbounded ontology, autonomous organization chart, or universal task taxonomy.
- Cross-workspace personal or organizational knowledge in the first implementation.
- Embedding-based semantic retrieval as a prerequisite.
- A second agent runtime, hidden scheduler, or mutable document service outside canonical events.
- Granting credentials, permissions, budgets, publication rights, model access, effect policy, or operating-system authority through knowledge text.

## Terms

- **Workspace knowledge:** Evidence-backed, workspace-owned retained meaning learned from work. It is non-executable and cannot grant authority.
- **Knowledge entry:** A stable workspace-owned identity for one coherent subject.
- **Knowledge revision:** One immutable version of a knowledge entry.
- **Knowledge statement:** A bounded claim, instruction-like practice, preference, goal hypothesis, procedure, exception, or other semantic unit within a revision.
- **Explicit knowledge:** Content directly asserted by an authorized user or exact authoritative source.
- **Inferred knowledge:** Content synthesized from observed work and retained as an attributed hypothesis rather than explicit authority.
- **Work episode:** A bounded, exact set of canonical events representing one completed or terminal unit of work.
- **Evidence reference:** An exact event ID, artifact identity/range, imported-document chunk, file digest observation, or other retained source pin supporting or contradicting knowledge.
- **Material pin:** A deterministic digest of source material whose change may make a revision stale.
- **Freshness:** The current relationship between a knowledge revision and its pinned source material.
- **Conflict:** Two retained knowledge revisions or statements that cannot both govern the same scope without explicit resolution.
- **Exposure:** Proof that an exact knowledge revision entered a model context or generated task briefing.
- **Field manual:** A deterministic human-readable projection of active workspace knowledge.
- **Manual definition:** A versioned declarative specification of sections, selectors, grouping, ordering, and rendering policy.
- **Render frontier:** The exact workspace/control cursor and active revision set used for one render.
- **Render receipt:** The renderer version, manual-definition version, frontier, selected revision IDs, output digest, byte count, and completeness state.
- **Publication:** An explicit effect that copies or adapts generated knowledge into repository files or another external destination.

## User model

### Knowledge accumulates while work continues

Ordinary work remains the primary product activity. Agencity records messages, tasks, cells, effects, goals, outcomes, corrections, and child work exactly as it does today.

At committed boundaries, deterministic policy decides whether enough new evidence exists to admit one background knowledge-distillation review. Distillation is detached from the active task. It may return:

- `no_change`;
- a new knowledge entry;
- a replacement revision;
- a retirement proposal;
- an explicit conflict or stale-state update.

The proposer cannot activate its own output. Existing deterministic validation and one separate sealed reviewer govern activation. A failure, timeout, unknown result, malformed result, stale compare-and-swap state, or rejection changes no active knowledge.

### Knowledge is inspectable independently of manuals

Users can inspect:

- current knowledge entries;
- exact revisions and diffs;
- supporting and contradicting evidence;
- explicit versus inferred authority;
- counts and outcome summaries;
- freshness and material pins;
- conflicts and unresolved questions;
- proposal, review, activation, retirement, and rollback history;
- the exact records selected into a field manual or model context.

### Field manuals are generated views

The product includes one default workspace field manual with deterministic sections:

1. workspace purpose and job model;
2. domain concepts and vocabulary;
3. people, stakeholders, and preferences;
4. goals and success criteria;
5. recurring task families and standard processes;
6. conventions, constraints, and decisions;
7. exceptions, failure patterns, and recovery guidance;
8. unresolved questions, conflicts, and stale knowledge;
9. provenance and render metadata.

Empty sections are represented consistently or omitted according to the manual-definition version. The renderer never fills a missing section with invented prose.

Filtered views may render a process guide, stakeholder brief, task-family guide, path-specific guide, or unresolved-knowledge report from the same active revisions.

### Publication remains explicit

The default manual is visible through the protocol, CLI, and TUI. An owner may export its exact Markdown bytes or request an ordinary agent task to adapt selected knowledge into repository documentation.

Export does not make the file canonical. Re-rendering from the same complete input/status manifest and renderer package produces the same bytes. Repository publication records the source render receipt and proceeds through a distinct outbox-backed file effect and normal Git review.

## Knowledge model

### Knowledge entry identity

A knowledge entry owns one coherent subject across revisions:

```ts
interface WorkspaceKnowledgeEntry {
  readonly entryId: string;
  readonly workspaceId: string;
  readonly slug: string;
  readonly kind: WorkspaceKnowledgeKind;
  readonly headRevisionIds: readonly string[];
  readonly activeState:
    | { readonly kind: "none" }
    | { readonly kind: "unique"; readonly revisionId: string }
    | { readonly kind: "conflicted"; readonly revisionIds: readonly string[] };
  readonly createdEventId: string;
}
```

Initial kinds are:

```ts
type WorkspaceKnowledgeKind =
  | "concept"
  | "task_family"
  | "process"
  | "practice"
  | "convention"
  | "constraint"
  | "decision"
  | "preference"
  | "goal"
  | "stakeholder"
  | "exception"
  | "failure_pattern"
  | "open_question";
```

Kinds provide stable rendering and filtering semantics. Tags and typed relationships provide workspace-specific vocabulary without requiring an unbounded runtime-defined ontology.

One entry should answer one durable question. A large topic may have several linked entries rather than one unbounded document.

### Knowledge revision

```ts
interface WorkspaceKnowledgeRevision {
  readonly revisionId: string;
  readonly entryId: string;
  readonly revision: number;
  readonly title: string;
  readonly summary: string;
  readonly bodyMarkdown: string;
  readonly statements: readonly WorkspaceKnowledgeStatement[];
  readonly tags: readonly string[];
  readonly pathSelectors: readonly string[];
  readonly taskFamilyKeys: readonly string[];
  readonly relationships: readonly WorkspaceKnowledgeRelationship[];
  readonly authority: KnowledgeAuthority;
  readonly confidence: number;
  readonly evidence: readonly KnowledgeEvidenceReference[];
  readonly materialPins: readonly KnowledgeMaterialPin[];
  readonly conflictEntryIds: readonly string[];
  readonly parentRevisionIds: readonly string[];
  readonly proposalId: string;
  readonly createdEventId: string;
}
```

The canonical event contains all bounded text and structured meaning needed to render the revision. Large source material remains in existing artifacts, document chunks, or external resources and is referenced by exact identity and integrity metadata. A missing referenced dependency makes the knowledge unverifiable or the render partial; it never becomes empty evidence.

The first implementation sets strict per-field and aggregate byte limits. `bodyMarkdown` is bounded rich content rather than an arbitrary document store. Material exceeding one entry's bound is split into linked entries.

### Statements

```ts
interface WorkspaceKnowledgeStatement {
  readonly statementId: string;
  readonly kind:
    | "fact"
    | "recommendation"
    | "procedure_step"
    | "preference"
    | "goal"
    | "warning"
    | "exception"
    | "question";
  readonly text: string;
  readonly authority: KnowledgeAuthority;
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
  readonly disposition: "asserted" | "recommended" | "question";
}
```

Statements support deterministic section rendering, evidence footnotes, conflict display, and selective retrieval. `bodyMarkdown` supplies explanation and narrative around those statements. The structured and prose forms are validated for bounded consistency but are not expected to encode identical text.

Freshness, support, lifecycle, and conflict are derived against the selected workspace frontier rather than stored as mutable fields on an immutable revision. One effective-state projection maps every selected revision and statement to exactly one manual/context status:

```ts
type WorkspaceKnowledgeRenderStatus =
  | "current"
  | "stale"
  | "unverifiable"
  | "conflicted"
  | "unresolved"
  | "retired";
```

`headRevisionIds` preserves concurrent descendants. `activeState` never chooses a winner when synchronized revisions make more than one activation claim current. A conflicted entry is excluded from normal context and rendered in the conflict section with every competing head.

### Authority

```ts
type KnowledgeAuthority =
  | { readonly kind: "explicit_user"; readonly principalId: string }
  | { readonly kind: "agent_inference"; readonly proposerSessionId: string }
  | { readonly kind: "derived_metric"; readonly projectionContract: string };
```

The runtime derives every principal, proposer session, and projection contract from the authenticated command and validated evidence. Callers cannot supply or spoof those fields. A repository digest is evidence for an inference, and a passing gate is ordinarily a derived metric; neither becomes semantic authority by itself.

Authority and confidence are separate:

- repeated observation may increase evidence without becoming an explicit preference;
- an inferred goal remains inferred until an authorized user confirms it;
- an explicit user preference outranks a contradictory inferred local tactic;
- a derived count describes retained evidence, not semantic truth;
- reviewer approval establishes policy consistency, not factual correctness.

Owner confirmation creates a new immutable revision that cites the inferred revision and records `explicit_user` authority. Owner retraction creates a replacement or retirement with the same exact provenance. Confirmation and retraction are typed commands and canonical events; editing prose or repeating an inference never changes its authority.

### Relationships

Initial relationships are:

- `depends_on`;
- `applies_to`;
- `part_of`;
- `precedes`;
- `supersedes`;
- `supports`;
- `contradicts`;
- `exception_to`;
- `owned_by`;
- `related_to`.

Every relationship names exact entry IDs and is validated against the workspace projection. Missing synchronized dependencies remain explicit.

### Evidence and material pins

Evidence references use a closed typed union. Initial forms include:

- canonical event ID;
- artifact ID, digest, size, and optional exact byte range;
- imported-document chunk ID and digest;
- successful typed file-read event plus path and content digest;
- goal/gate evaluation identity and material pin;
- knowledge-exposure and later outcome identity;
- exact external resource reference when the runtime has a validated version contract.

Repository instruction content is not eligible evidence for automatic knowledge activation merely because it was loaded into model context. A normal task may cite a regular repository file observation as evidence, but the frozen reviewer input redacts or excludes instruction files according to the existing security boundary.

Material pins determine freshness. A source digest change does not rewrite or delete the prior revision. It marks the active projection stale and may admit a bounded maintenance proposal.

## Counts, observations, and derived state

Canonical knowledge meaning is append-only. Counts are rebuildable projections over unique retained identities.

Useful derived metrics include:

- supporting observation count;
- contradicting observation count;
- distinct work-episode count;
- distinct root, worker-type, and worker-instance count;
- first and latest supporting cursor;
- context exposure count;
- successful, failed, blocked, and unknown outcome counts after exposure;
- manual render count;
- stale-source count;
- unresolved-conflict count.

No runtime command increments an authoritative semantic counter. It appends a unique observation, exposure, outcome link, or material-change event. Projection replay recomputes the count. Idempotency keys prevent duplicate logical observations from inflating metrics.

Counts do not automatically change authority, confidence, or lifecycle. A governed revision must explain any semantic change derived from them.

## Work episodes and distillation

### Deterministic episode projection

A work episode is a bounded projection over exact canonical records, not a generated summary and not a new source of truth.

The first implementation uses existing durable units:

- one terminal `AgentRun`;
- one terminal queued family-message run;
- one completed goal/gate repair cycle when exact run linkage exists;
- one typed user correction and its corrected event IDs.

An episode projection contains exact task/run identity, initiating message, selected action/outcome summaries, changed material pins, child-task outcomes, gates, terminal status, usage, and canonical source IDs. Oversized details remain available through exact references.

Episode indexes are rebuildable. Candidate selection is bounded before canonical event reload and verification. The maintenance loop must not scan complete workspace history at every run boundary.

### Automatic admission

Workspace knowledge distillation is a distinct policy from instance-local behavioral refinement.

Fresh workspaces enable bounded automatic knowledge distillation by default. Users may pause or resume it per workspace. A completed pause prevents later admissions but does not cancel already admitted work.

Admission composes two controls:

- the existing device-profile automatic-learning pause is a hard gate across every workspace on that profile;
- an owner-controlled canonical `agencity.workspace-knowledge-policy.v1` record enables or pauses knowledge distillation for one workspace.

The managed workspace service holding the local workspace execution lease runs the scan. The exact session boundary that caused admission supplies the trigger and default model dispatch, but it does not own or receive the workspace-wide evidence.

Cross-root automatic distillation runs in one sealed, parentless workspace-workflow `Session` created for that exact review under the packaged `knowledge-curator` worker type. The separate governance reviewer is another sealed workspace-workflow session. These sessions:

- preserve `Session` as the only executable model identity;
- are canonically caused and owned by the workspace-control review rather than an ordinary root family or process;
- cannot receive user tasks, mail, arbitrary steering, or root selection;
- are visible to the authenticated workspace owner through knowledge history;
- are not visible through ordinary agent family, context, SQL, or SDK inspection;
- retain bounded, redacted cross-root evidence only inside their sealed workflow records;
- return a message-free typed result linked to the workspace-control proposal.

An ordinary agent proposal remains restricted to evidence visible on its own branch lineage. It cannot use the workspace curator as a query path into unrelated roots.

The workspace policy owns the fixed learning budget. The curator uses the trigger origin's exact current model dispatch only as a pinned execution choice; its usage is not charged to or exposed through the origin route's task tree. If no locally executable workspace owner, usable dispatch, or remaining workspace learning budget exists, admission records a bounded unavailable observation and does not fall back to another root.

Version 1 permits at most one nonterminal knowledge review per workspace, eight admissions in a trailing 2,048-workspace-event window, USD 1 and 32,768 tokens for the proposer, and the existing USD 1 and 16,384-token sealed-reviewer bounds. Each child has at most two turn slots and 120 seconds wall time. Provider concurrency remains shared and attributable.

The device preference lease orders device-wide pause/resume. The workspace-control append transaction compares the exact workspace-policy generation and trigger frontier immediately before admission. A completed pause therefore orders after any admission already in flight and before every later admission.

### Sealed workspace-workflow admission

A service may execute a workspace workflow but never owns its durable identity. One typed cross-stream admission transaction records:

- the workspace-control review request and deterministic workflow ID;
- `SessionCreated.sessionKind: "sealed_workspace_workflow"` with no family parent and one exact workspace-control cause;
- the sealed `knowledge-curator` or `knowledge-reviewer` worker-type pin;
- the complete immutable initial profile;
- exact model dispatch and response contract;
- execution-owner device identity;
- workspace-policy generation and fixed budget reservation;
- the initial `AgentRunRequested` with `workSource.kind: "workspace_knowledge_review"`;
- the frozen bounded input identity and digest.

Stable review/role keys return the same workflow session and run. Workspace workflow sessions:

- use ordinary model effects, provider-input retention, usage records, cancellation, unknown outcomes, and run recovery;
- debit canonical `WorkspaceKnowledgeBudgetReserved` and `WorkspaceKnowledgeBudgetDebited` records on the knowledge control stream;
- deliver one typed message-free terminal result to the exact workspace-control review;
- may be cancelled by the authenticated workspace owner or whole-workspace shutdown, while pause only stops later admission;
- recover only on the pinned execution-owner device; synchronized replicas remain observational and do not fail over automatically;
- synchronize their immutable history and control links under the same envelope and divergence rules as other sessions;
- are omitted from ordinary root selection, resume, family, mailbox, and agent SDK surfaces;
- remain owner-inspectable through knowledge activity and raw audit views;
- are erased with whole-workspace deletion and participate in the transitive narrow-deletion cascade when their frozen input contains deleted material.

Startup recovery scans nonterminal workspace-control reviews, verifies the exact linked workflow session/run and budget reservation, and resumes from the last canonical boundary. It never creates a replacement workflow because a service process or lease changed.

Initial triggers are:

- one typed user correction containing a reusable factual, preference, goal, process, or convention signal;
- five new terminal work episodes since the workspace knowledge frontier;
- three episodes with the same deterministic task-family key when one is available from typed worker/task metadata;
- a material digest change affecting an active knowledge revision;
- a newly retained contradiction against an active revision;
- an owner-requested manual distillation.

The first implementation does not infer a universal task taxonomy. Deterministic task-family keys come from exact worker-type identity, explicit task metadata, completion-gate identity, path selectors, or an already active knowledge entry. A sealed proposer may propose a new task-family entry from a bounded mixed episode batch, but trigger admission itself does not depend on an unretained semantic label.

One boundary scan admits at most one knowledge review. Every trigger kind has a deterministic trigger key, evidence-through cursor, consumption frontier, and nonterminal key. Eligible triggers order by greatest qualifying evidence cursor, then fixed trigger-kind precedence, then trigger key. One workspace-control compare-and-swap serializes cross-root admission. Other eligible evidence remains unconsumed for a later boundary.

Recovery continues the same nonterminal review. Every terminal result consumes its exact evidence tranche: `no_change`, deterministic rejection, reviewer rejection, failure, cancellation, unknown, application conflict, application failure, or successful application. This prevents automatic retry bursts. A later manual request or newly qualifying evidence creates a new identity rather than reopening the consumed tranche.

### Distillation contract

The sealed knowledge proposer receives:

- one exact workspace plus the triggering origin event identity and pinned model dispatch, without origin-family access;
- the deterministic trigger and frontier;
- a bounded episode set;
- exact evidence excerpts and references;
- active knowledge candidates relevant to those episodes;
- current conflicts, stale entries, and recent evaluation summaries;
- the allowed knowledge operation and target scope;
- immutable product policy and knowledge constitution;
- explicit model, token, cost, turn, and wall-time bounds.

It returns exactly:

- `no_change`; or
- one typed create, replace, retire, mark-conflict, or resolve-conflict proposal.

The proposer cannot:

- activate its output;
- write repository files;
- create permissions or policy;
- convert inferred authority into explicit-user authority;
- cite evidence outside the frozen input;
- edit behavioral harness content in the same proposal;
- update several unrelated knowledge subjects atomically.

### Governance and activation

Knowledge proposals reuse the existing governed-refinement principles:

1. append one immutable proposal;
2. validate schema, bounds, scope, authority, evidence visibility, source integrity, secrets, relationships, and compare-and-swap state;
3. freeze exact reviewer input and digest;
4. invoke one separate sealed reviewer;
5. accept one typed approve or reject decision;
6. revalidate against current workspace-control state;
7. atomically create and activate the revision or record a terminal non-application;
8. deliver exact terminal status;
9. support exact grouped rollback without rewriting history.

The reviewer checks whether the proposed knowledge is supported, correctly qualified, scoped, non-secret, non-authoritative beyond evidence, and directly useful to future work. Approval does not prove truth or future utility.

Proposal authority is:

- an automatic refiner may create or replace only `agent_inference` content supported by its sealed workspace snapshot;
- an ordinary agent may create or replace only `agent_inference` content supported by evidence visible on its own branch lineage;
- an automatic refiner may mark stale or conflict state but cannot retire, confirm, retract, resolve, or roll back explicit-user content;
- the authenticated workspace owner may create, replace, retire, confirm, retract, resolve conflicts, and roll back workspace knowledge;
- the sealed reviewer may approve or reject only and cannot edit, activate, confirm, resolve, or publish;
- a sibling, unrelated session, synchronized non-owner device, or repository instruction cannot exercise workspace-owner authority.

Repository reads, completion-gate results, model summaries, and ordinary connectors remain evidence or derived metrics. Only an authenticated owner action can create `explicit_user` authority in the first implementation.

## Freshness, contradiction, and maintenance

### Freshness

Freshness is deterministic where possible:

- unchanged exact material pins remain current;
- a changed pinned digest marks the revision stale;
- a missing event, artifact, chunk, or external version makes it unverifiable;
- time alone does not make knowledge stale unless a revision declares an explicit bounded validity rule.

Stale knowledge remains inspectable and appears in the manual's stale section. It is excluded from ordinary model context by default unless the task explicitly asks about historical or stale state.

### Contradiction

Contradiction may be:

- explicitly proposed from exact evidence;
- derived from mutually declared `contradicts` relationships;
- discovered during bounded maintenance review.

The runtime does not use last-write-wins to resolve semantic conflict. Deterministic authority rules may suppress an inferred preference when it conflicts with an explicit user preference, but both records remain visible. Other conflicts remain unresolved until a governed resolution activates a new revision or retires one side.

### Consolidation

Maintenance may merge duplicated subjects, split an overbroad entry, revise stale content, or retire unsupported content. It never deletes retained revisions or raw evidence.

A merge creates a new surviving revision with exact predecessor relationships and retires the duplicate active entries atomically. A split creates bounded new entries and retires the source only when every surviving statement is accounted for. Both operations require specialized validation and rollback.

The first delivery may defer automatic merge and split while supporting owner-requested governed operations. Automatic create, replace, retire, conflict, and stale maintenance are sufficient for the first useful corpus.

## Retrieval and model context

### Candidate generation

Knowledge retrieval follows the existing memory-index boundary:

1. one replaceable candidate index generates bounded candidate revision IDs;
2. deterministic policy checks workspace, lifecycle, authority, freshness, tags, paths, task-family keys, conflicts, and exact active revision;
3. stable ranking and limits select the final set;
4. `ContextMaterialized` retains candidates, rejections, selections, reasons, versions, and source events.

The initial implementation may use FTS5 over titles, summaries, statements, tags, paths, and task-family keys. Embeddings may later improve candidate generation without becoming scope or authority.

### Relationship to memory and behavioral context

Workspace knowledge owns workspace-wide facts, concepts, processes, conventions, preferences, goals, stakeholders, exceptions, and open questions. Instance-local memory remains tactical evidence for one durable session. Worker-type memory remains reusable behavior or job knowledge bound to one exact type version. User/global explicit preferences remain higher-scope user authority.

Event schema 7 rejects new `memory` harness entries with `workspace` scope; callers use workspace knowledge instead. A future schema-6 importer may propose retained workspace memories as knowledge entries, but no implicit conversion or authority upgrade occurs.

When both knowledge and memory are relevant, deterministic conflict policy applies authority before rank. Explicit user/global preference wins over workspace inference, and current supported workspace knowledge wins over conflicting instance-local inference. Both remain visible in provenance. Process and recommendation text is untrusted dynamic context subordinate to immutable policy, runtime authority, the pinned profile and worker type, and the current explicit user request.

### Context selection

Ordinary model calls do not receive the complete corpus or full manual.

A bounded automatic selection uses:

- the current user request;
- exact task and worker-type metadata;
- files successfully read through typed tools;
- active goals and gate identities;
- explicitly linked knowledge entries.

Selected context favors current, supported, directly relevant revisions. Inferred preferences and goals retain visible qualification. Conflicted or stale content is omitted by default and replaced by bounded notices when relevant.

The console SDK provides on-demand list, search, get, history, evidence, and render operations. Generated code receives read access and proposal admission, not direct canonical mutation.

### Exposure and later outcomes

Every context selection records exact knowledge revision exposure. Later terminal outcomes may be linked deterministically to that exposure.

Exposure and outcome correlation is evaluation evidence, not causal proof. It may support later refinement or rollback but cannot automatically establish that a knowledge revision improved performance.

## Deterministic field-manual rendering

### Manual definition

```ts
interface FieldManualDefinition {
  readonly manualDefinitionId: string;
  readonly version: number;
  readonly name: string;
  readonly sections: readonly FieldManualSectionDefinition[];
  readonly rendererContract: "agencity.field-manual.v1";
}

interface FieldManualSectionDefinition {
  readonly sectionId: string;
  readonly title: string;
  readonly kinds: readonly WorkspaceKnowledgeKind[];
  readonly statuses: readonly WorkspaceKnowledgeRenderStatus[];
  readonly groupBy: "kind" | "tag" | "task_family" | "none";
  readonly orderBy: "title" | "kind_then_title" | "evidence_then_title";
  readonly includeBody: boolean;
  readonly includeEvidenceFootnotes: boolean;
}
```

The packaged default manual definition is immutable product material with an exact ID, version, and digest. Future workspace-defined manual definitions require a separate typed owner-authority path; generated code cannot install arbitrary render programs.

### Render input

One render is a pure function of:

- workspace ID;
- exact workspace/control render frontier;
- exact active knowledge revision IDs;
- manual-definition ID, version, and digest;
- renderer contract and implementation version;
- filters and completeness limits;
- an exact dependency-status manifest containing every resolved or missing digest;
- the canonical JSON contract and Unicode normalization version.

Current wall-clock time, database row order, process locale, terminal width, and live filesystem state are not inputs.

### Render output

The renderer produces:

- canonical UTF-8 Markdown;
- a typed JSON representation;
- selected entry/revision IDs in stable order;
- source evidence and material-pin references;
- manual and renderer versions;
- render frontier;
- output digest and byte count;
- `complete`, `partial`, or `refused` completeness;
- explicit missing, stale, conflict, and truncation records.

Typed JSON uses the repository's versioned canonical-JSON encoder. User-authored strings are normalized to Unicode NFC at knowledge admission, and the retained normalized bytes are the rendering input. Stable ordering uses section order, declared grouping, normalized title, entry ID, and revision ID as deterministic tie-breakers.

If output exceeds a hard bound, the renderer emits a deterministic manifest plus bounded section pages. It does not silently truncate a complete manual or ask a model to shorten it during rendering.

### Render storage

The render receipt is retained when a render is exported, published, supplied as an explicit task input, or used as evaluation evidence. Every retained receipt pins the complete input/status manifest, renderer package digest, exact output page artifact IDs, page digests, and aggregate digest. Interactive previews may be computed read-only without appending canonical state and carry no historical-reproduction promise.

Unretained preview bytes are disposable. Bytes named by a canonical render receipt are retained content-addressed dependencies and participate in backup, export, integrity verification, and deletion. Missing bytes are an explicit dependency failure even when regeneration could produce the expected digest.

Historical receipt output is resolved from its exact retained page artifacts. Historical regeneration additionally requires the pinned renderer package and complete input/status manifest. Removing either dependency makes regeneration unavailable without changing the retained receipt or output bytes.

## Workspace ownership and schema coordination

Workspace knowledge cannot be owned by the root that first observed it and must be visible across independent roots. Ordinary root lifecycle does not alter it. Explicit owned-scope deletion is different: deleting a contributing session cascades through knowledge derived from that session as defined in the data-control section.

This plan uses the non-executable workspace-control address introduced by event schema 6 in the worker-type plan and extends its stream union in event schema 7:

```ts
type WorkspaceControlStreamId = "worker-types" | "knowledge";
```

Knowledge identity, revision, activation, retirement, conflict, freshness, trigger frontier, workspace-level governance application, and grouped rollback use:

```ts
{
  kind: "workspace_control";
  workspaceId: string;
  streamId: "knowledge";
}
```

Originating episodes, proposer and reviewer work, context exposures, and task outcomes remain on ordinary session branches and link to workspace-control identities.

The knowledge implementation does not alter event-schema 6 meaning after acceptance and does not invent a schema-5 control convention. It requires the schema-6 workspace-control foundation, then cuts over to event schema 7, increments the reducer version, adds the `knowledge` stream ID and knowledge events, and fails closed on versions 1–6 before decode, projection, sync ingestion, or recovery. No retained event is silently reinterpreted and no historical knowledge is inferred from memory or repository prose.

## Canonical events and projections

### Proposed canonical events

- `WorkspaceKnowledgeEntryCreated`
- `WorkspaceKnowledgeRevisionCreated`
- `WorkspaceKnowledgeRevisionActivated`
- `WorkspaceKnowledgeEntryRetired`
- `WorkspaceKnowledgeConflictRecorded`
- `WorkspaceKnowledgeConflictResolved`
- `WorkspaceKnowledgeInferenceConfirmed`
- `WorkspaceKnowledgeAssertionRetracted`
- `WorkspaceKnowledgePolicyChanged`
- `WorkspaceKnowledgeWorkflowAdmitted`
- `WorkspaceKnowledgeBudgetReserved`
- `WorkspaceKnowledgeBudgetDebited`
- `WorkspaceKnowledgeFreshnessChanged`
- `WorkspaceKnowledgeObservationRecorded`
- `WorkspaceKnowledgeExposed`
- `WorkspaceKnowledgeTriggerConsumed`
- `FieldManualRenderRetained`
- `FieldManualPublished`
- existing governed-refinement events extended with a `workspace_knowledge` target
- existing context and invocation records extended with exact selected knowledge revision provenance
- the closed effect-origin union extended for manual export and repository publication

Event names and payloads are finalized in the ADR and domain phase. A freshness projection may be derived directly from pinned workspace-material changes when all inputs are canonical; an explicit event is required when the transition contains retained human or model judgment.

### Proposed projections

- `workspace_knowledge_entries`
- `workspace_knowledge_revisions`
- `workspace_knowledge_relationships`
- `workspace_knowledge_evidence`
- `workspace_knowledge_material_pins`
- `workspace_knowledge_observations`
- `workspace_knowledge_exposures`
- `workspace_knowledge_dependencies`
- `workspace_knowledge_trigger_consumptions`
- `workspace_knowledge_conflicts`
- `workspace_knowledge_budget_usage`
- `workspace_knowledge_fts`
- `field_manual_renders`
- `field_manual_publications`

Current pointers, counts, FTS rows, freshness summaries, conflict summaries, and render caches are rebuildable or operational projections. Canonical meaning remains in immutable events.

Every table is classified in `docs/mutable-tables.md`, included in architecture checks, rebuilt from canonical events, and covered by migration reopen, idempotency, duplicate-event, replay, and deterministic-render tests.

## Runtime and service boundaries

Add:

- `WorkspaceKnowledgeService` for list, get, search, history, evidence, and owner management;
- `WorkspaceKnowledgeEpisodeService` for bounded episode projection and indexed candidate selection;
- `WorkspaceKnowledgeRefinerService` for trigger scanning and sealed distillation;
- `WorkspaceKnowledgeGovernanceAdapter` for the existing common governance path;
- `WorkspaceKnowledgeFreshnessService` for exact material-pin checks;
- `FieldManualService` for pure rendering, receipts, export, and publication provenance.

Primary areas include:

- `src/domain/` for knowledge, render, evidence, and event contracts;
- `src/storage/` for migrations, projections, rebuild, queries, and conformance;
- `src/runtime/` for episodes, knowledge lifecycle, retrieval, refinement, freshness, context, and rendering;
- `src/sync/` for workspace-control envelope handling and divergence;
- `src/protocol/` for typed read, proposal, render, and export operations;
- `src/product/` and `src/tui/` for no-ID workspace-relative controls;
- `docs/` and `AGENTS.md` for shipped behavior, security, configuration, data lifecycle, events, capabilities, and known limits.

Model-generated code cannot open the canonical database for writes. All mutation passes through typed services and domain validation.

## Product surfaces

### CLI

Initial commands:

```sh
agencity knowledge list
agencity knowledge search "release process"
agencity knowledge show SLUG_OR_ID
agencity knowledge history SLUG_OR_ID
agencity knowledge diff SLUG_OR_ID
agencity knowledge evidence SLUG_OR_ID
agencity knowledge stale
agencity knowledge conflicts
agencity knowledge refine "consolidate what this workspace has learned"
agencity knowledge confirm SLUG_OR_ID "this is an explicit workspace preference"
agencity knowledge retract SLUG_OR_ID "this no longer applies"
agencity knowledge pause
agencity knowledge resume
agencity knowledge rollback PROPOSAL_ID "restore the prior revision"
agencity manual render
agencity manual render --kind process --output ./field-manual.md
agencity manual inspect RECEIPT_OR_DIGEST
```

Default list and render output is bounded and human-readable. `--json` exposes typed envelopes. Writing `--output` first retains the exact render receipt, then executes an outbox-backed export effect with a stable request identity, destination, digest, and explicit succeeded, failed, cancelled, or unknown outcome. Export records no claim that the file is canonical or committed.

### TUI

`/knowledge` opens a workspace knowledge inspector with:

- search and kind/status filters;
- active, stale, conflicted, and unresolved views;
- revision diff and exact evidence;
- explicit/inferred labels;
- counts and outcome summaries;
- learning and rollback history;
- field-manual preview and render receipt.

`/manual` opens the deterministic default field manual. Navigation is observational and does not trigger distillation, activation, publication, or repository mutation.

### Protocol and TypeScript client

The public protocol and `AgentClient` expose typed list/search/get/history/evidence/render/status operations plus authorized refine, pause, resume, rollback, and export controls.

### Console SDK

`sdk.knowledge` exposes:

- `search(query, options?)`;
- `list(options?)`;
- `get(entryIdOrSlug)`;
- `history(entryIdOrSlug)`;
- `evidence(entryIdOrSlug, options?)`;
- `render(options?)`;
- `propose(input)`;
- `review(instructions, options?)`.

Generated code cannot activate, force-resolve conflicts, publish repository files, assert user authority, select the reviewer, or widen scope.

## Security and authority

Workspace knowledge is model-facing data under the existing trusted-local boundary. It is not a sandbox, permission source, or policy grant.

Validation must:

- reject known brokered secret values and recognizable credentials;
- retain redaction provenance in frozen review input;
- exclude repository instruction content from sealed knowledge and governance prompts;
- prevent knowledge prose from modifying immutable policy or runtime authority;
- distinguish explicit user assertions from agent inference;
- prevent one session from spoofing another session's evidence;
- verify every cited event, artifact, chunk, file digest, exposure, and outcome;
- bound titles, prose, statements, relationships, tags, evidence, and aggregate proposal size;
- refuse path traversal or arbitrary file reads during rendering;
- keep external publication behind explicit owner authority.

An automatically inferred preference or goal can influence model context only with visible qualification and lower authority than a conflicting explicit user statement.

The runtime derives the complete authority record. The authenticated owner principal is never accepted as model-supplied input. A free-form label, repository digest, passing test, or repeated outcome cannot create explicit-user authority.

## Recovery, synchronization, export, and deletion

### Recovery

Recovery resumes nonterminal knowledge proposals and reviewer work from exact canonical boundaries. It never reruns a completed model call, repeats an export or publication effect, or invents a knowledge revision from a partial result.

A knowledge activation and its active-state projection commit atomically. Trigger consumption commits with every terminal review transition according to the result matrix in Automatic admission, so an exact evidence tranche cannot refire after restart.

### Synchronization

Workspace-control knowledge events synchronize through immutable envelopes.

Concurrent offline revisions:

- retain both immutable versions;
- preserve exact origin and evidence;
- do not silently choose an active winner;
- produce explicit activation or semantic conflicts;
- remain inspectable and render under a deterministic conflict policy.

A receiving device may inspect synchronized knowledge without becoming execution owner.

The receiving projection computes `activeState: { kind: "conflicted" }` with every competing active revision ID. Neither context selection nor rendering treats a query-row order, timestamp, device identity, or last arrival as a winner.

### Export

Workspace export includes:

- every knowledge entry and revision;
- statements, prose, relationships, authority, confidence, and lifecycle;
- evidence and material pins;
- observations, exposures, counts' canonical source records, conflicts, and freshness history;
- governed proposals, frozen inputs, decisions, applications, and rollbacks;
- manual definitions, publication receipts, and cached render artifacts when present;
- missing or unavailable dependency records.

An export that cannot explain an active revision or historical publication is partial, not successful.

### Deletion

Whole-workspace deletion includes knowledge streams, projections, indexes, receipts, and managed render artifacts.

Owned-scope deletion overrides retained provenance. Independent session deletion extends the guarded physical-erasure planner with a transitive workspace-knowledge cascade:

1. enumerate every knowledge entry, proposal, frozen review, observation, exposure, conflict, render receipt, publication, and managed artifact whose content or provenance depends directly or transitively on the selected session;
2. follow a rebuildable dependency graph from each affected knowledge revision through every managed persisted copy, including `ContextMaterialized`, exact provider input, task/input-set materialization, refinement snapshots, model outputs, cells, derived memories, downstream knowledge, artifacts, render receipts, exports, and publications;
3. erase the complete affected knowledge entry and all dependent workspace-control events rather than retain model-derived prose whose source was deleted;
4. physically erase every managed record whose retained bytes copied or were generated from affected knowledge, expanding to the smallest causally complete run, branch suffix, workflow, or artifact scope required to keep surviving history valid;
5. erase dependent render receipts, page artifacts, exports, and publications when their retained bytes contain affected content;
6. rebuild projections and indexes;
7. mark surviving entries that reference erased identities conflicted or unverifiable, or include them in the cascade when their own content was derived from the erased material;
8. synchronize the same owned-scope erasure through existing data-control receipts and remote-administration rules.

Every persisted knowledge exposure or copy appends or projects an exact dependency edge before dependent work commits. Reference-only records containing no affected bytes may survive with an unavailable dependency marker. Unknown or missing dependency coverage forces physical deletion of the containing managed record. Deletion never invokes a model to rewrite surviving knowledge. The receipt retains bounded identities, counts, and integrity summaries but no deleted content. An initial implementation may conservatively cascade an entire entry, run suffix, or generated artifact when statement-level independence cannot be proved.

External provider disclosures and owner-directed files outside managed storage cannot be recalled by database deletion. The deletion receipt lists these as residual external effects with exact known destinations and digests where available; it never reports them as erased. Deletion may refuse only for the ordinary reasons that already govern owned-scope deletion—quiescence, ownership, unavailable remote administration, or incomplete physical cleanup—not merely to preserve provenance.

Retirement and rollback change active availability without physically deleting history. Physical deletion remains a guarded data-control operation.

## Performance and budgets

- Episode candidate selection uses rebuildable indexes and bounded canonical verification.
- Automatic scanning never loads complete workspace history.
- One scan admits at most one review.
- One workspace has at most one nonterminal knowledge review and eight admissions per trailing 2,048 workspace events.
- The proposer is limited to 32,768 tokens, USD 1, two turn slots, and 120 seconds; the reviewer retains its 16,384-token, USD 1, two-turn-slot, 120-second limits.
- Knowledge-model usage is separately visible from ordinary task usage.
- Usage is charged to the fixed workspace knowledge budget and retained separately from ordinary root task trees.
- Provider concurrency is shared with existing recursive work and remains attributable.
- FTS candidate generation is bounded before policy filtering.
- Ordinary context receives a small selection, not the full manual.
- Manual rendering is streaming or paged and has explicit aggregate limits.
- Counts use indexed projections rather than repeated full-event scans.
- Missing indexes degrade to a typed unavailable state or bounded rebuild, never an unbounded request-path scan.

The fixed version-1 caps above are the hard default. The ADR may lower them or add a stricter workspace owner preference, but implementation cannot ship with an unbounded parent-derived knowledge budget.

## Delivery plan

### Phase 0 — ADR and schema-7 workspace-control extension

1. Accept an ADR defining workspace knowledge, authority, inference, deterministic rendering, and publication boundaries.
2. Confirm the event-schema 6 workspace-control address, then define the schema-7 `knowledge` stream extension and versions 1–6 fail-closed behavior.
3. Define exact knowledge kinds, relationships, evidence types, proposal operations, and bounds.
4. Define the manual rendering contract and historical renderer retention policy.
5. Ratify the device hard gate, workspace policy generation, sealed workspace-curator sessions, fixed spend/rate limits, model-dispatch pin, and unavailable behavior.
6. Ratify the transitive owned-scope deletion cascade and discriminated active-conflict projection.
7. Update authoritative plan links and `AGENTS.md` only after the direction is accepted.

Exit evidence:

- no unresolved ownership or schema-address ambiguity;
- no path that treats inferred content as explicit authority;
- no deterministic-render claim depends on a model call or ambient state;
- worker types and knowledge use one workspace-control address without changing schema-6 event meaning.

### Phase 1 — Canonical knowledge domain and storage

1. Add knowledge entry, revision, statement, relationship, authority, evidence, material-pin, conflict, and lifecycle contracts.
2. Add strict event schemas and reducer behavior.
3. Add projections, indexes, constraints, migration, rebuild, and architecture classifications.
4. Add exact compare-and-swap activation and retirement.
5. Add manual owner-created knowledge for deterministic fixtures.
6. Add typed sealed workspace-workflow admission, budget, terminal delivery, cancellation, recovery, and observational sync.
7. Add sync envelope, outbox-backed export/publication, and transitive owned-scope deletion support.

Exit evidence:

- duplicate replay is a no-op;
- rebuild produces identical knowledge state;
- malformed, secret-bearing, cross-workspace, unsupported, or stale-CAS writes fail atomically;
- service/process loss cannot change or duplicate a workspace-workflow identity or budget reservation;
- event-schema versions 1–6 fail before decode or projection under the accepted schema-7 cutover.

### Phase 2 — Retrieval and context provenance

1. Add the replaceable knowledge candidate-index contract and local FTS implementation.
2. Add deterministic scope, lifecycle, authority, freshness, conflict, tag, path, and task-family filters.
3. Add bounded automatic context selection.
4. Record exact candidates, rejections, selections, versions, and reasons in context provenance.
5. Add console and runtime read APIs.
6. Add exposure records linked to later run outcomes.

Exit evidence:

- relevant current knowledge is selected reproducibly;
- stale and conflicting knowledge cannot silently enter normal context;
- deleting/rebuilding the index preserves authoritative behavior after rebuild;
- complete selection provenance survives restart.

### Phase 3 — Deterministic field-manual rendering

1. Package the immutable default manual definition.
2. Implement a pure Markdown and typed-JSON renderer.
3. Add stable ordering, evidence footnotes, explicit status sections, pagination, and completeness.
4. Add render receipts, output digests, cached-artifact support, and historical reproduction fixtures.
5. Add protocol, client, CLI, and TUI previews.
6. Add outbox-backed file export without repository-publication claims and a separate publication origin/operation.

Exit evidence:

- repeated rendering at the same frontier produces byte-identical output;
- locale, clock, row order, terminal size, and process restart do not change output;
- oversized and missing-dependency renders are explicit;
- the renderer performs no model call.

### Phase 4 — Work episodes and governed distillation

1. Add deterministic terminal work-episode projections and indexes.
2. Add workspace knowledge trigger policy, frontiers, pause/resume, and one-admission control.
3. Add the sealed structured knowledge proposer.
4. Extend governance with a `workspace_knowledge` target.
5. Add validation, separate sealed review, application-time revalidation, terminal delivery, and rollback.
6. Add explicit/inferred authority checks and source qualification.
7. Add recovery for every request, child-link, review, application, and delivery boundary.

Exit evidence:

- five new work episodes may produce `no_change` or one attributable proposal;
- one typed correction can produce only an inferred automatic revision; an authenticated owner confirmation can create a later exact explicit revision;
- proposer, reviewer, and application remain separate;
- restart never duplicates a review or activation.

### Phase 5 — Freshness, contradiction, and maintenance

1. Add exact material-pin freshness derivation.
2. Add stale and unverifiable projections.
3. Add contradiction proposal and deterministic authority suppression rules.
4. Add owner conflict resolution and exact rollback.
5. Add bounded automatic stale/contradiction maintenance triggers.
6. Add owner-requested merge and split if their accounting and rollback contracts are complete.

Exit evidence:

- changed source material cannot remain silently current;
- conflicting offline revisions remain visible;
- inferred preferences cannot override explicit user preferences;
- resolution and rollback preserve both histories.

### Phase 6 — Product completion and evaluation

1. Complete `/knowledge`, `/manual`, CLI, protocol, client, and SDK surfaces.
2. Add workspace-wide status, history, counts, spend, failures, and unresolved-state inspection.
3. Add installed black-box journeys across separate roots and worker instances.
4. Add task-relevant retrieval and field-manual usability evaluators.
5. Add post-activation exposure/outcome analysis without claiming causality.
6. Update public docs, capabilities, security, events, data lifecycle, configuration, recovery, and `AGENTS.md`.
7. Run independent review and the canonical deterministic gate.

Exit evidence:

- separate roots contribute to and consume one workspace corpus;
- a user can inspect what the workspace learned without internal IDs;
- a deterministic manual survives detach, service restart, and projection rebuild;
- external provider, official Turso, and Cloud rows are reported separately as pass, fail, or skip.

## Testing strategy

### Domain and reducer

- valid create, replace, retire, conflict, resolution, and rollback;
- duplicate event application;
- invalid kind/content, relationship, authority, evidence, and transition;
- compare-and-swap conflicts;
- exact replay and global workspace-control ordering;
- inferred versus explicit authority precedence;
- stale and missing material pins.

### Storage and migrations

- migration reopen and idempotency;
- immutable event guards;
- complete projection rebuild;
- FTS deletion and rebuild;
- concurrent activation conflict;
- workspace-control and session-branch cross-reference validation;
- architecture table classification;
- schema-cutover refusal before decode.

### Distillation and governance

- `no_change`;
- accepted create and replacement;
- rejected unsupported inference;
- secret and repository-instruction exclusion;
- proposer/reviewer separation;
- malformed output;
- timeout, cancellation, unknown provider result, and recovery;
- application-time stale state;
- one admission per frontier;
- sealed workflow admission, execution-owner pinning, budget debit, terminal delivery, and owner-only inspection;
- no cross-root evidence through ordinary family, SDK, context, or SQL views;
- exact rollback;
- bounded evidence and snapshot truncation.

### Retrieval and context

- task text, path, type, goal, and explicit-link selection;
- lifecycle, freshness, conflict, authority, and scope rejection;
- stable ranking and tie-breaks;
- complete provenance;
- bounded provider input;
- exposure and terminal-outcome linking;
- no full-corpus injection.

### Renderer

- byte-identical Markdown and JSON fixtures;
- stable ordering under shuffled query rows;
- clock, locale, terminal, and restart independence;
- current, stale, conflicted, unresolved, and empty sections;
- Markdown escaping and adversarial content;
- pagination and aggregate refusal;
- missing artifact and source dependency;
- exact receipt digest;
- historical renderer fixture reproduction.

### Recovery, sync, export, and deletion

- crash before and after proposal, review, application, receipt, and publication boundaries;
- offline concurrent revisions and activations;
- missing synchronized evidence;
- partial export;
- transitive session-deletion cascade through knowledge, receipts, publications, and managed artifacts;
- whole-workspace deletion;
- unretained preview loss and retained-render dependency failure;
- no repeated file export or publication effect.

### Installed product

One external-repository black-box journey should:

1. configure the deterministic fixture provider;
2. create two independent workspace roots;
3. complete several related and unrelated tasks;
4. retain explicit feedback and one typed correction;
5. trigger workspace knowledge distillation;
6. observe `no_change` and one approved revision;
7. inspect evidence, authority, counts, and history;
8. prove the second root retrieves relevant shared knowledge;
9. render the field manual;
10. detach and restart the managed service;
11. render byte-identical output at the same frontier;
12. change pinned repository material and observe stale knowledge;
13. inspect a conflict and resolve or roll it back;
14. export the manual explicitly;
15. verify no repository documentation was automatically changed.

## Documentation requirements

Implementation updates:

- `AGENTS.md` for product direction, implemented status, known limits, and invariants;
- `README.md` and `docs/user-guide.md` for user workflows;
- `docs/architecture.md` for ownership, event addressing, retrieval, and rendering;
- `docs/events.md` for canonical events and exact semantics;
- `docs/mutable-tables.md` for every new table;
- `docs/console-sdk.md`, `docs/api.md`, and `docs/protocol.md` for public surfaces;
- `docs/configuration.md` for policy, budget, and renderer settings;
- `docs/data-lifecycle.md` for export, publication, backup, restore, and deletion;
- `docs/recovery.md` and `docs/operator-guide.md` for nonterminal work and repair;
- `docs/security.md` for inference authority, repository instruction exclusion, secrets, and trusted-local execution;
- `docs/capabilities.md` and `docs/verification.md` for shipped and externally gated evidence;
- a new ADR and decision-index entry before implementation.

Public docs must distinguish:

- retained raw experience;
- active workspace knowledge;
- behavioral harness content;
- generated field manuals;
- checked-in repository documentation.

They must not claim semantic retrieval, empirical improvement, automatic repository publication, or verified external integration unless those capabilities are implemented and reproduced.

## Acceptance criteria

1. Raw canonical evidence remains retained after every distillation and consolidation.
2. Workspace knowledge is owned by a non-executable workspace-control stream.
3. Separate roots can contribute to and consume shared active knowledge.
4. Every revision retains exact evidence, authority, confidence, material pins, proposal, review, activation, and rollback provenance.
5. Explicit and inferred preferences and goals remain distinguishable in storage, context, and manuals.
6. Counts rebuild from unique canonical observations and never become mutable business truth.
7. Stale, missing, contradicted, and unavailable knowledge remains visible.
8. Model-authored content cannot activate itself or grant authority.
9. Repository instruction content and brokered secrets do not enter sealed knowledge review.
10. Workspace-wide evidence is visible only inside sealed owner-inspectable workflow records; ordinary roots cannot inspect unrelated-root evidence.
11. Service, worker, or lease loss cannot change durable workflow identity, execution owner, budget, or recovery semantics.
12. Ordinary context receives a bounded relevant selection, not the complete corpus.
13. Every selection retains candidate, rejection, and exact-version provenance.
14. The same complete input/status manifest, manual definition, canonical JSON/Unicode contracts, and renderer package produce byte-identical Markdown and JSON.
15. Rendering performs no model call and does not depend on ambient filesystem, clock, locale, row order, or process state.
16. Oversized output uses explicit pages or refusal rather than silent truncation.
17. Generated files and caches are derived; loss does not change canonical knowledge.
18. Publishing to repository files is explicit, effect-backed, and separate from activation.
19. Recovery never duplicates proposals, reviews, activations, exposures, renders, or publications.
20. Offline concurrent revisions remain visible conflicts rather than last-write-wins state.
21. Export contains everything needed to explain active knowledge and retained publications.
22. Session deletion removes every transitively dependent managed record and generated byte while preserving unrelated workspace knowledge, and reports non-recallable external disclosures; deletion authority is never denied merely to preserve provenance.
23. Workspace deletion includes knowledge, projections, indexes, receipts, and managed render artifacts.
24. Default automatic knowledge learning has explicit workspace controls, spend bounds, and one-admission behavior.
25. Black-box acceptance proves cross-root accumulation, retrieval, deterministic rendering, restart, stale detection, conflict visibility, rollback, and no automatic repository edits.
26. Pass, fail, and skip counts remain separate; gated external checks are never reported as verified when skipped.

## Deferred extensions

- Embedding and graph-based candidate generation.
- Cross-workspace user or organization knowledge.
- Hosted shared knowledge services and multi-tenant authorization.
- User-authored manual definitions and themes.
- Owner-registered authoritative-source contracts with deterministic claim extractors.
- Automatic merge and split when first-delivery accounting is insufficient.
- Knowledge packages for import or publication independent of workspace export.
- Less conservative statement-level provenance separation during narrow deletion.
- Causal experimentation, A/B exposure, and automatic empirical rollback.
- Automated pull requests that publish selected knowledge into repository documentation.
- Rich non-Markdown renderers.
- A learned unbounded task taxonomy or organization model.

## Definition of done

This plan is complete only when a clean installed Agencity workspace can accumulate evidence across independent roots, apply governed workspace knowledge, retrieve it in later relevant work, inspect every source and decision, and render a byte-reproducible field manual after service restart and projection rebuild.

The implementation is not complete merely because knowledge tables exist, a model generated Markdown once, or a component test can call the renderer. The ordinary no-ID product path, bounded automatic maintenance, explicit uncertainty, data lifecycle, and deterministic installed-product journey are required.

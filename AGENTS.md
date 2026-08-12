# AGENTS.md

**Role:** Canonical repository guide  
**Last reviewed:** August 12, 2026

This file is the current source of truth for Agencity's purpose, product intention, design principles, supported behavior, known gaps, architecture, and implementation rules. A new reader should not need another product document to understand what the project is trying to build or what is currently real.

[`docs/stable/BLOG.md`](./docs/stable/BLOG.md) is a companion explanation of the product thesis. This file is authoritative when wording in that essay, the README, or a technical document blurs intended behavior with shipped behavior. Code and tests are the evidence for current capabilities; they do not by themselves redefine the product intention.

Update this file whenever a change alters the product direction, supported user journey, durable domain model, security boundary, major capability, or known limitation.

Authoritative implementation plans are the [parent TypeScript/Turso rewrite PRD](./plans/2026-08-05-prime-agent-typescript-turso-rewrite-prd.md), the [FU-001–FU-019 follow-up backlog](./plans/2026-08-06-prime-agent-typescript-turso-rewrite-follow-up-plan.md), the [formal model-tool contracts plan](./plans/2026-08-07-formal-model-tool-contracts-plan.md), the [durable agent profiles and automated refinement review plan](./plans/2026-08-08-adaptive-agent-city-plan.md), and the [default automatic adaptive learning plan](./plans/2026-08-11-default-automatic-adaptive-learning-plan.md), in that order after this guide. The [lossless context-reference storage plan](./plans/2026-08-07-lossless-context-references-plan.md) is deferred and requires a new readiness review.

## What Agencity is

Agencity is a terminal-first autonomous agent runtime informed by Prime Agent. It addresses a limitation of conventional tool-calling agents: a prompt/response loop becomes strained when work outlives one context window, terminal, process, or live language heap.

The project begins from two Prime Agent ideas:

- A **Recursive Language Model (RLM)** treats context as data. The model writes programs that inspect and transform that data, call models, use tools, delegate work, and combine results instead of selecting one fixed tool at a time.
- A **Continual Harness** lets the agent adapt its prompt notes, memories, skills, and reusable subagent specifications from experience.

Agencity takes those ideas in a different systems direction. The model's intended general programmatic action surface is a Bun TypeScript console, while durable agent identity lives in a relational event history and referenced artifacts. Canonical workspace state is stored in a local LibSQL database. Optional Turso synchronization exchanges immutable envelopes through a separate replica database; Turso is not a distributed lock service or a replacement owner for local canonical state.

The console is disposable: its heap may accelerate a healthy run, but it is never the source of truth. Python workloads can run through trusted shell execution, but Python does not own the agent session and there is no dedicated Python executor.

The central thesis is that an agent can program over its own context without making a language process its identity. Programs may be temporary, while committed work, relationships, evidence, and reasons remain durable and inspectable.

The accepted product direction gives every runnable session one durable, immutable-versioned behavioral profile and governs later behavioral refinements through deterministic validation, one separate sealed reviewer, automatic activation of approved content, exact provenance, and rollback. This direction does not add an organization control plane: cross-family assignment, workspace routing, management hierarchy, and other agent-city mechanisms remain speculative and are not current supported behavior.

Agencity is inspired by Prime Agent rather than a compatibility port. It does not aim to preserve Prime Agent's Python modules, file formats, extension APIs, or persistent-kernel design, and it does not claim benchmark gains merely from adopting a different architecture.

## Product intention

This repository is not merely a storage library or collection of runtime primitives. The intended product is a usable autonomous agent whose ordinary entrypoint is a repository terminal.

The target user journey is:

```sh
agencity "find and fix the flaky test"
```

In that target flow, Agencity resolves the workspace, creates or resumes the appropriate durable session, makes the selected model explicit, commits the task, and opens an inspectable run. Returning later with `agencity` reconstructs committed work without requiring copied session or branch IDs.

The product should let a user:

- give a task and let a typed, budgeted, recoverable agent loop carry it through TypeScript cells, tools, model calls, and subagents;
- inspect the conversation together with the cells, bounded observations, effects, child sessions, budgets, goals, gates, and unresolved outcomes that produced it;
- steer, cancel, detach, resume, branch, export, and delete owned work without bypassing durable runtime semantics;
- use human-readable product flows while retaining internal IDs, SQL, and low-level operations for diagnostics and automation;
- attach through a terminal client that observes the same public snapshot/event protocol as other clients and does not become the owner of session identity.

The model should receive one general generated-execution surface—the TypeScript console. SQL, files, shell effects, artifacts, recursive model calls, subagents, memory, and refinement are typed APIs inside that environment. Product code should not replace this with a growing hard-coded workflow or independent menu of model tools.

Product success is measured through the complete user journey, not only through storage, reducer, or service tests. Do not optimize for passing component tests while leaving onboarding, autonomous execution, interruption, recovery, or resume incomplete.

## Design constitution

Use these principles when requirements leave an implementation choice:

- **Adapt through experience.** Repeated success and failure should produce scoped memories, skills, subagent roles, retrieval policies, and workflows. Learned specialization must remain attributable, testable, and reversible.
- **Durable state owns identity.** A process, model connection, console heap, UI, or machine may disappear without taking committed work or task ownership with it.
- **Context is queryable data.** Retain complete attributable history and give the model bounded projections plus deliberate query tools. Compaction is a derived view, not destructive replacement of evidence.
- **General mechanisms precede prescribed workflows.** TypeScript, SQL, model calls, durable tasks, evaluators, and policies are the building blocks. Package recurring successful workflows as inspectable skills instead of enlarging a fixed universal loop.
- **Evidence governs refinement.** A model's explanation, predicted benefit, or reviewer approval is not outcome proof. Behavioral changes advance through scoped immutable proposals, deterministic validation, one separate sealed charter reviewer, application-time revalidation, automatic activation or rejection, attributable post-activation evidence, and rollback. Standing user policy and typed runtime boundaries govern scope; the reviewer cannot widen them.
- **User authority bounds autonomy.** The agent cannot widen its own data, permission, budget, publication, or safety boundaries. Explicit user preferences and owned-scope deletion override inferred tactics and retained provenance.
- **Uncertainty remains visible.** Unknown effects, stale gates, missing artifacts, conflicting claims, and unavailable capabilities stay explicit. The runtime does not invent success or retry unsafe work to keep a run moving.
- **Subagents are retained relationships.** Root agents, subagents, and recursive model calls share the durable session/task/mailbox model. Delegation produces inspectable ownership and communication, not anonymous returned strings.
- **Placement is configuration, not identity.** Local and remote adapters preserve identifiers, causality, recovery, and model-facing behavior. Stronger infrastructure may add capabilities; weaker placement must report unavailable behavior instead of silently weakening semantics.
- **Autonomy is bounded and inspectable.** Goals, completion gates, budgets, timeouts, authority boundaries, cancellation, and unresolved outcomes are durable parts of a run. Completion is not merely the model claiming it is done.

## Product goals

Agencity aims to provide:

- **Programmatic agency:** the model can construct TypeScript programs that query state, transform data, call tools and models, fan work out, and aggregate results.
- **Durable execution:** committed work survives worker, supervisor, terminal, and machine-process restarts without relying on an intact heap.
- **Relational context:** complete history remains queryable while each model call receives a bounded, attributable selection of what matters now.
- **Retained multi-agent work:** subagents and recursive calls are durable sessions with tasks, budgets, messages, artifacts, cancellation, and follow-up—not disposable strings.
- **Bounded autonomy:** goals, completion gates, authority boundaries, budgets, timeouts, and uncertain effects remain visible and enforceable.
- **Governed adaptation:** agent profiles, memories, prompt notes, skills, and subagent specifications can improve through scoped proposals, deterministic validation, sealed independent review, automatic activation of approved immutable versions, attributable outcome evidence, and rollback.
- **Local-first replaceability:** a complete local runtime works without Cloud, while storage, artifacts, retrieval, execution, and clients can move behind capability-aware contracts without changing agent identity.
- **Inspectable operation:** users and clients can understand what the agent knew, what it did, which evidence supported it, what remains unresolved, and how to resume or reverse work.

## Non-goals and non-claims

Agencity does not claim or require:

- compatibility with Prime Agent's internal modules, Python API, file formats, or persistent-kernel behavior;
- benchmark improvement merely because the architecture uses RLM or continual-harness ideas;
- exactly-once execution of arbitrary external effects;
- durability of closures, sockets, module instances, subprocesses, or uncommitted console variables;
- unrestricted model writes to canonical relational tables;
- a hostile-code sandbox, network-facing authentication or authorization system, multi-tenant authorization boundary, or network isolation in the current trusted-local runtime;
- PostgreSQL, embeddings, or distributed coordination as prerequisites for the local product;
- one database blob containing all durable bytes—artifacts may live outside the database and remain required for complete recovery;
- a fixed planning ceremony, delegation topology, or ever-growing set of privileged model tools.

## Core product model

- A **workspace** is the ownership and placement boundary for project sessions. Its canonical events and artifact metadata live in a local workspace database; artifact bytes live in a configured content-addressed store.
- A **profile/device** store is separate from workspace state. It holds durable device identity, cross-workspace preferences and catalog entries, globally installed skills, and opaque credential references.
- A **session** is a durable actor. It owns a model configuration, budget, goals, conversation state, and event stream. Root agents, delegated subagents, and recursive model calls use the same session model.
- An **agent profile** is the immutable-versioned standing purpose and agent-specific behavioral instructions for one session. It is workspace canonical state, is pinned to each autonomous or recursive-model invocation, and cannot grant runtime authority.
- A **branch** is a durable line of session history. Forking from an earlier cursor creates a new branch; it does not mutate or replay the original history.
- A **task** records why a child session exists, what completion means, its budget attribution, and its lifecycle. Parent and child sessions communicate through durable mailboxes and terminal notices.
- A **goal** is a durable autonomous objective. **Completion gates** record required evidence and must pass against attributable workspace state before completion is accepted.
- A **cell** is a proposed TypeScript program plus its dependencies, logs, observed result, exports, and terminal status. A committed cell boundary is a recovery boundary.
- **Scratch** is an exact-session-and-branch, noncanonical console cache. Its warm object may hold ordinary runtime values while one worker survives; the managed file-local product may opportunistically restore independently serializable bounded JSON properties from a fenced operational cache. Clean scopes skip serialization and cache writes. Scratch does not transfer across parent, child, sibling, or forked work and is never task ownership, completion evidence, synchronization, export, automatic context, or a recovery requirement.
- An **effect** is external work such as a model, shell, file, or skill request. The outbox records the request before execution and records `succeeded`, `failed`, `cancelled`, or `unknown`.
- **Context** is a bounded projection assembled for a model call from attributable messages, state, memory, tasks, policy, and harness versions. It is not the complete durable record.
- A **working value** is durable typed JSON. Larger or byte-oriented content belongs in an immutable **artifact** identified by content digest.
- **Memory** records scoped claims, observations, preferences, and decisions. The **continual harness** adds versioned prompt notes, executable skills, and reusable subagent specifications with evidence and lifecycle state.
- A **projection** is deterministic state derived from canonical events. A **cursor** identifies a committed point for snapshots, catch-up, historical inspection, and branch creation.
- A **run** is a canonical, event-derived period in which the supervisor advances a task through strict versioned model actions toward a typed terminal outcome. Deterministic identities, TypeScript cells, decisions, goals, recovery, and exact observation delivery are integrated.

## Intended autonomous lifecycle

The target task path is:

1. Resolve the workspace and create or select a durable root session with an explicit usable model.
2. Commit the user's instruction and applicable goal, limits, policy, and completion requirements.
3. Materialize bounded context with the exact source-event and harness provenance supplied to the model.
4. Require exactly one formal provider tool call: `bun_console` for a TypeScript cell or `finish` for a successful, blocked, or failed outcome.
5. Validate the action, authority, scope, budget, and compatibility before execution.
6. Execute generated work through the disposable TypeScript console and durable outbox-backed APIs.
7. Commit the action, cell, effects, observations, usage, child work, and resulting state before making a dependent model call.
8. Continue until completion gates pass, a bound is reached, cancellation reconciles, or a blocked, failed, or unknown outcome ends the run. Missing user information uses blocked `finish`; a later user message starts an ordinary new run on the same branch.

Unstructured model prose must never be heuristically executed as code. The model receives TypeScript as its general generated-execution surface; run-control outcomes remain typed supervisor decisions rather than additional privileged tools.

The TUI and other clients observe this lifecycle through snapshot-plus-cursor event semantics. They may steer, cancel, detach, and resume, but client attachment is not durable session identity and process exit is not proof that external work stopped.

## Current implementation status

### Implemented runtime foundations

- local LibSQL canonical event storage, recursive creation of missing file-backed database parents, immutable event guards, deterministic projection/rebuild, branches, snapshots, and cursor-based subscriptions;
- disposable Bun TypeScript cells with exact-branch warm scratch, dirty-tracked opportunistic fenced file-local JSON scratch checkpoints in the managed product, final-expression or explicit-return observations, bounded safe inspection/logs, durable working values, retained cell history, read-only analytical SQL, content-addressed artifacts, 128 KiB cell-result IPC with streamed JSON artifact staging above that boundary, one-based bounded file pages, and exact bounded artifact byte ranges;
- outbox-backed model, shell, file, and skill effects with typed pre-execution origins, crash recovery, explicit unknown outcomes, and `agencity.bounded-output.v1` completeness envelopes; local shell execution streams scrubbed 24 KiB head/tail previews and spills complete output up to 32 MiB to CAS when available;
- durable root and child sessions, nuclear-family mailboxes and retained follow-up, cancellation trees, recursive-model runtime handles, documents/input sets, goals, cached attributable gates, heartbeats, schedules, and wake queues;
- durable per-session agent profiles embedded in root and child admission, sealed root/task-specialist defaults, specification-source provenance, session-wide active-profile projections, bounded active/history inspection, and exact profile/effective-system-prompt pins across autonomous and recursive invocations;
- scoped memory with FTS5 candidate retrieval, versioned prompt notes, skills, subagent specifications, governed refinement/evaluation/rollback, and an attributable trajectory refiner with profile-owned automatic-trigger policy;
- profile and device identity plus optional offline-first Turso envelope synchronization, divergent-branch preservation, conflict/quarantine records, and single-device session execution ownership;
- exact versioned provider-input candidates shared by estimation, execution, and recovery; bounded active-run/profile projections; a 512 KiB hard ceiling and 384 KiB compaction target for unknown-capacity candidates; and deterministic per-step provider observations capped at 56 KiB per item and 64 KiB total without changing the canonical observation ledger;
- attributable repository instruction loading: bounded root `AGENTS.md` content occupies a stable provider-message prefix, successful typed file reads deliver up to four changed ancestor files in root-to-nearest order, `CellCommitted` retains exact path/digest/size/completeness provenance plus explicit pending/omission state, unchanged digests deduplicate across restart and branch lineage, and changed/removed/restored sources reactivate automatically;
- loopback HTTP/JSON and SSE surfaces with cursorless provider progress, a TypeScript API, a no-ID product CLI plus compatible diagnostic commands, and a protocol-backed terminal TUI;
- local and HTTP-backed placement contracts for relational state, artifact storage, candidate retrieval, and execution, with explicit capability reporting and conformance coverage.

### Incomplete product surfaces

- Durable per-session agent profiles and invocation-level profile/effective-prompt pins are implemented under [ADR 0012](./docs/decisions/0012-durable-agent-profiles-automated-refinement-governance.md). Profile, memory, prompt-note, skill, and subagent-specification proposals use deterministic validation, one separate sealed reviewer selected from the origin route's current model, application-time revalidation, automatic approved-version application, exact terminal delivery, bounded reproposal chains, and exact rollback. The sealed refiner policy maps durable facts and preferences to memory, repeated behavioral tendencies to prompt notes, reusable deterministic tested operations to skills, and recurring delegated roles to subagent specifications; repository-specific implementation and missing runtime primitives remain ordinary implementation work. For refiner-produced proposals, governance input version 2 includes bounded redacted excerpts from the exact frozen source snapshot together with the trigger, allowed kinds, review identity, and snapshot hash; version 1 remains accepted for retained history. The governance reviewer rejects proposals whose evidence, trigger, selected artifact, and predicted effect do not form a direct causal chain, including generic diligence substituted for the requested capability. Profile and non-skill application is atomic; storage accepts a later profile version and activation only when they match the exact `reviewed_approved` proposal, decision, target, content, expected version, and atomic application event, or an exact atomic rollback pattern. Approved skills activate only after durable compile and declared runtime tests pass. Self, direct-child, workspace-owner, and local automatic-refiner authority is enforced; siblings and unrelated agents cannot revise one another. The reviewer receives the frozen product constitution, policy, model dispatch, and explicit 16,384-token, USD 1, two-turn-slot, 120-second limits; smaller parent budgets remain authoritative. Unavailable workspace-charter and user-constraint configuration is retained as `null`; callers cannot select the reviewer or widen authority. Agent rollback evidence must be visible on the caller branch lineage, while owner rollback may cite same-workspace evidence. Recovery scans oldest-first in bounded pages until every nonterminal proposal and terminal undelivered notice has been considered. Public protocol, `AgentClient`, Console SDK, route-relative `agencity profile`, and `/profile` controls expose inspection, proposal, wait/detach, history/diffs, reasons/guidance, notices, and rollback. Runtime, focused recovery, sync-divergence, export-audit, deletion-refusal, focused lifecycle, isolated linked-executable acceptance, and final deterministic aggregate verification have passed. External live-provider, official Turso Sync, and Turso Cloud checks remain gated and unverified.
- `agencity`, `bun run dev`, workspace discovery, durable no-ID resume/selection, explicit provider/model onboarding, and source/link installation are implemented. First interactive startup without a usable provider asks the user to choose OpenAI, Anthropic, or Vercel AI Gateway, accepts the key through hidden input, and asks for the canonical `creator/model` ID before creating a session. Gateway, direct OpenAI, and direct Anthropic execution share one Vercel AI SDK core with thin transport factories. The public Gateway catalog is the source for model capacity, pricing, and reasoning metadata and is retained in a bounded endpoint-keyed profile cache. The TUI `/model` inspector is a keyboard-driven provider/model picker; `/effort` selects durable provider-default, none, minimal, low, medium, high, or xhigh reasoning at an idle model boundary. Owner-only provider keys remain outside canonical/profile preference databases. Environment keys remain supported fallbacks. The package remains private and has no claimed registry or standalone release channel.
- The product has no demo mode. Echo remains an internal deterministic test provider and is filtered from product selection, help, status, and onboarding. Ordinary non-interactive work without a usable provider fails with setup guidance.
- The ordinary task route drives the formal provider tool contract: known unsupported models fail before root or runnable-child admission, every autonomous model call commits a required-tool-set dispatch with exactly `bun_console` and `finish`, and each canonical action or typed contract violation commits before application. Each dependent call receives at most eight bounded recent canonical action/outcome summaries plus its new exact-once observations; completed trajectory entries retain deterministic purpose, digest, size, and grouped effect facts without replaying source or result text, while only the latest failed or unresolved action retains bounded source and detailed error context. Failure recovery guidance directs inspection to a small range around reliable diagnostics or the smallest relevant source section. The decision instruction asks whether the task is complete before admitting another cell and does not direct the model to reconstruct active work from retained notebook history. `/capabilities`, startup/status, model selection, `/info`, `/raw`, and retained run steps expose the fixed contract with distinct provider-strict, runtime-validated, unknown, and unavailable states. Branch diagnostics derive fixed-cardinality submission/violation counters and bounded evidence summaries from canonical projections without adding mutable state or retaining rejected arguments. Successful completion checks required gates before materializing its exact assistant message. Blocked and failed `finish` calls atomically materialize their exact assistant message with the effective terminal status; later user input starts an ordinary new run. The former clarification/permission actions, pending-input events and route, and `waiting_for_user` state are absent. Trajectory refinement uses the sealed internal `agencity_submit_refinement_review` provider tool and a request-bound typed recursive result; it does not parse assistant text.
- Console cells support notebook observation, direct `scratch`, bounded `sdk.scratch.status/clear`, bounded `inspect`, artifact spill, `state.list`, and retained `cells.list/get`. Lexical bindings remain cell-local. Scratch preserves arbitrary values only while its exact branch scope stays warm; bounded eligible JSON may restore on the same device in managed file-local product composition. Direct diagnostic and remote placements are warm-only.
- Shell and file helpers return `agencity.bounded-output.v1`. File reads use one-based inclusive windows of at most 2,000 lines, 2 KiB per line, and 48 KiB per page. The root `AGENTS.md` is loaded up to 64 KiB; successful typed file reads discover regular UTF-8 ancestor `AGENTS.md` files up to 16 KiB each, scan at most 256 KiB per file and 64 ancestors, deliver four changed records per read and 16 discovery groups per cell, and retain 40 KiB active nested content across 64 records. Bounds and stale omitted ancestors remain explicit pending/omission records; direct shell/Bun reads do not trigger discovery. Sealed refinement and governance reviewers exclude repository-authored content. Model-facing artifact reads use zero-based half-open `artifacts.readRange` calls capped at 64 KiB; whole-object CAS resolution remains internal/operator-facing. Remote executor RPC does not transfer spilled artifact bytes, so remote artifact references are rejected until a canonical transfer capability exists.
- Every model call retains `agencity.provider-input.v1`: exact normalized messages, formal tool schemas and policy, token-relevant options, dispatch/endpoint/capacity provenance, digest, and byte count. The `provider-input-utf8-bytes-per-4-tokens-v1` estimator is conservative product admission evidence rather than provider-reported usage. Provider-reported tokens remain separate when available.
- Every `EffectRequested` retains a closed typed origin before execution and migration 019 stores it in the outbox projection. The provider-facing observation derivation gives a terminal cell ownership of successful cell effects and omits duplicate successful effect payloads, while failed/cancelled/unknown outcomes remain visible. `AgentRunStepStarted.observationEventIds` remains the complete canonical exact-once ledger.
- The console exposes direct `ai.generateText` and `ai.generateObject` (also under `sdk.ai`) for one-request raw generation over explicit prompt/messages and explicit bounded context references. Raw generation retains exact dispatch, provider input, schema, context, result, usage, budget, cancellation, timeout, unknown, and recovery provenance without creating child sessions, tasks, profiles, mailboxes, or family records; results remain inline and oversized output fails. The former model-facing `rlm`/`sdk.rlm` admission surface is absent, while retained recursive-model history and private sealed workflows remain supported. The console also exposes `sdk.agents` roster, spawn, bounded direct messaging, receipts, acknowledgement, cancellation, and same-session retained follow-up.
- `/refine`, the public protocol client, and `sdk.harness.review/reviews` run a strict trajectory-to-candidate review through a durable recursive child with a supervisor-selected one-tool response contract. The accepted transport input is retained once in the model effect; successful children return a normalized typed result bound to the exact child model completion without creating a canonical assistant result message. The TUI retains an explicit `LEARNING` result for each parent-branch review across detach and reopen, including the original request, current or terminal status, bounded reason, and whether any behavioral harness artifact changed; no-change results direct repository or runtime implementation requests back to ordinary agent work. Product CLI and TUI refinement detach by default and support explicit `--wait`, `--detach`, and `--kind`; the CLI also supports `--scope`, while `sdk.harness.review` exposes the same typed scope, kind, and wait controls and retains API wait-by-default compatibility. Frozen bounded sources, decisions, proposal identity, and recovery status remain attributable. Automatic learning is enabled when the device profile has no explicit preference. `refine pause` stores a persistent device-wide pause across every workspace using that profile, and `refine resume` resumes new admissions; `auto off|on` remains compatible. A profile-backed expiring preference lease serializes pause/resume with automatic admission across workspace-service instances, automatic requests revalidate the device-policy generation immediately before append, and storage rejects a trigger frontier that became pending or consumed before the transaction. Automatic proposals remain local memory, prompt-note, tested-skill, or subagent-specification changes; every proposal still passes deterministic validation and one separate sealed reviewer. One scan admits at most one trigger. Default triggers are three matching effect failures, three failed cells in one agent run, two distinct-pin failures of one completion gate, one typed `UserCorrection`, or five successful terminal runs within the trailing 2,048 local records, with the success trigger eligible to refire after five newer qualifying runs. Terminal success is permission to reflect rather than outcome proof, and `no_change` is expected when the evidence supports no direct adaptation. The fifth success is considered at the next committed run boundary rather than at terminal commit. Session-wide status, history, and inspection join bounded reflection summaries, governed decisions/applications, typed scan failures, and proposal-level rollback because local learned content is effective across the session's branches; pending counts include only review-linked governance, and history has a 256 KiB serialized ceiling with explicit truncation. Owner rollback derives exact inverse actions for automatic create, replace, retire, and multi-edit proposals, validates the route before idempotent return, carries passing retained test evidence only across exact same-content skill restoration, terminally disables rolled-back skill creations, and accepts an origin proposal visible in a synchronized receiving branch lineage. Learning history is audit activity, not a human review queue. There is no separate learning spend budget, aggregate review-rate limit, scheduler, or semantic workflow grouping. Boundary scanning still loads complete branch history and the detector rejects more than 10,000 supplied records, so sufficiently large branches expose typed `scan_unavailable` instead of admitting automatic learning. Stale-memory and unproductive-delegation detectors remain unavailable.
- The interactive TUI is a full-screen OpenTUI client of the managed workspace service. It reconciles stable committed Markdown message blocks and syntax-aware fenced code, interleaves each compact run status after its initiating user task, and exposes retained TypeScript actions as syntax-colored one-line summaries with expandable full source that omits the presentation-only `Purpose:` label, dim stream-colored logs and returned stdout/stderr, and errors; the canonical cell retains the exact submitted source. Expanded cell details appear in slightly indented, rounded panels; structured result JSON remains in cell diagnostics rather than the conversation transcript. During an active run, only the latest committed action remains detailed; prior actions collapse automatically, and a pending model response is represented by the active run header rather than a separate waiting row. `Ctrl-O` toggles the latest run, while `Ctrl-L` toggles all completed runs without changing the composer draft; inline shortcut hints are visually dimmed. A prompted multiline composer preserves pasted line breaks, uses `Shift-Enter` for new lines, submits with Enter, and grows within the responsive normal/compact/minimum height modes. A width-prioritized split footer preserves trusted-local authority and current actions without reserving idle inspector width. Contextual command, model, credential, provisional-output, notice, and family inspectors appear beside the conversation on wide terminals and replace it on narrow terminals. Snapshots, cursor-resumable committed SSE events, and cursorless progress remain distinct; a compact direct-child summary, responsive family browser, ancestry breadcrumb, and draft-safe Down/Enter/Right/Left navigation open exact retained parent and child branches without changing execution or workspace resume selection. Empty-composer Left from a top-level root and `/agents` open a full-screen workspace Agents selector backed by the typed product branch catalog. It groups retained root branches by exact status, searches visible fields, keeps failed and archived rows visible but non-resumable, creates and immediately opens a new root with Ctrl-N, refreshes only on open, explicit Ctrl-R, or successful selection, and opens resumable roots through exact product selection so later no-ID entry resumes the selected or newly created route. Family activity is route-derived, admitted children without active runs are idle, current projections are reused across refreshes, and periodic family refresh stops when the browser is closed and no child is actively working. Raw diagnostics remain available only through `Shift-R` or `/raw`, and non-TTY execution retains a readable plain transcript fallback.
- The TUI does not enable click or drag mouse reporting. Native text selection and clipboard copying remain available without terminal-specific overrides. On terminals that support Kitty key disambiguation and alternate-scroll mode, wheel and trackpad gestures scroll the active TUI view without taking over selection; other interaction remains keyboard-driven.
- Routine family polling does not expose its transient `refreshing` state in the TUI. Stale and unavailable family data remain visible.
- The family browser uses a highlighted selected card, dimmed activity-colored alternatives, and bounded single-line task and model metadata with ellipses instead of wrapped option blocks.
- Streaming-capable providers emit bounded cursorless progress before an atomic committed response; non-streaming providers truthfully report committed-only behavior. Real-provider streaming remains credential-gated.
- Unknown effects are retained and visible through startup/status plus `unknown` and evidence-only `reconcile` product flows. Reconciliation deliberately does not rewrite the unknown outcome or authorize automatic retry.
- The on-demand managed workspace service owns detached runs, schedules, and recovery behind the same authenticated loopback protocol, with process fencing and tested client detach/reattach. A quiescent service exits after one hour by default; active runs, effects, wakes, schedules, heartbeats, resident workers, and attached clients keep it alive and are reported by `service status`, while a terminal blocked branch and warm scratch do not. The exact normalized timeout remains part of the discovery configuration hash, so a live former one-minute owner produces `CONFIG_MISMATCH` rather than takeover by a new default client. Graceful shutdown stops admission, drains admitted protocol handlers and resident workers, stops the console worker, and preserves sessions. The service is not an OS-login service and has no cross-device execution-owner failover.
- Release acceptance invokes only an isolated `bun link` executable from fresh external repositories. Its guarded black-box matrix covers truthful missing-provider behavior, explicit fixture-model selection, coding cells/tools, compact observations, bounded durable-state use, warm scratch across cells, truthful same-device scratch restore and reconstruction after service loss, durable recursive/family follow-up, failed-gate repair, detach/client loss/service recovery, named head branch/resume/history/tree, distinct JSON run exits, post-commit crash recovery and unknown/no-retry reconciliation, refinement, installed skills, streaming, compaction, schedules, and governed profiles. The installed learning journey proves that a fresh device profile admits repeated-success reflection without first enabling it. The governed-profile journey proves exact root and child profiles, old/new invocation pins, blocking approval, rejection, bounded reproposal, exact rollback, detached managed-service restart, deduplication, and no-ID inspection. The full-screen renderer has deterministic OpenTUI frame/input/resize coverage for Markdown, retained cells, bottom following, responsive layout, notices, inspectors, family navigation, and the searchable workspace root selector. A linked-executable pseudo-terminal journey expands a retained TypeScript cell, opens retained child and grandchild routes, climbs back through the ancestry, creates a second root, selects the original root through the workspace Agents view, detaches, and resumes the remembered selection without internal IDs; the release matrix remains non-interactive. The real-provider, official Turso, and Cloud rows remain explicitly opt-in and may be skipped.

### Deliberately unavailable or deferred

- hostile-code isolation inside the Bun worker;
- authenticated multi-tenant HTTP service operation;
- distributed leases, task stealing, global budget reservation, and automatic execution-owner failover;
- PostgreSQL coordination;
- embedding-based semantic retrieval;
- automatic artifact replication and garbage collection;
- browser execution;
- production Cloud administrative deletion through the installed Turso data client;
- a formal adaptive-organization layer beyond the implemented durable agent-family model.

Do not describe Agencity as a complete autonomous product or production-ready system merely because its runtime test suite passes.

## Product completion bar

The initial terminal product is complete only when all of these are reproducible:

- A clean supported installation exposes `agencity`, and the source-checkout development command enters the same product flow.
- In a fresh repository, `agencity` creates or selects durable work and opens a ready terminal interface without asking for internal IDs.
- Re-entering the repository resumes an unambiguous selected branch; ambiguous choices use a human-readable selector rather than incidental row order.
- Provider/model choice is explicit. Interactive missing configuration enters hidden credential setup, non-interactive missing configuration fails truthfully, and a resumed branch never changes model silently except for an explicit migration from a retained former Echo branch.
- A normal task drives the typed autonomous lifecycle and TypeScript action surface rather than stopping after one chat completion.
- Worker, supervisor, and client interruption at durable boundaries reconstructs the same committed state without duplicate cells, effects, model calls, or children.
- Cancellation requests, budget exhaustion, failed gates, unknown effects, and unavailable capabilities are distinct visible states with safe resume or reconciliation behavior.
- The TUI consumes the public client contract, can detach and catch up from a cursor, and never owns durable session identity.
- Black-box tests cover installation, empty-state start, task execution, verification, root-to-child-to-grandchild ancestry navigation, workspace-root selection, quit, remembered resume, branch, and history without calling supervisor internals or parsing IDs.

## Runtime and development requirements

- Bun 1.3.13 or newer, as declared by the package engine. The default verification suite uses Bun's isolated file-level test workers.
- TypeScript is executed directly by Bun. There is currently no emitted production build step.
- The runtime is trusted-local unless the entire process is placed in an external sandbox.

Install and run all standard checks from the repository root:

```sh
bun install --frozen-lockfile
bun run verify
```

Individual gates:

```sh
bun run typecheck
bun run check:architecture
bun test --timeout 30000
bun run test:unit
bun run test:integration
bun run test:e2e
bun run test:acceptance
bun run test:acceptance:matrix
```

Source-checkout product entrypoint:

```sh
bun run dev
bun run dev -- "inspect this repository"
```

A supported source/link workflow is documented in [`docs/install.md`](./docs/install.md): `bun link` exposes the executable `agencity` outside the checkout, and black-box tests verify runtime asset resolution from another working directory. The package is private; do not claim registry or standalone installation until such a channel is actually published and tested.

## External and gated verification

The default suite may skip external integration tests when their prerequisites are absent. A skipped external test is not evidence that the integration passed in the current environment.

The real-provider installed-product smoke is not part of the deterministic claim and requires explicit opt-in:

```sh
AGENCITY_ACCEPTANCE_REAL_PROVIDER=1 OPENAI_API_KEY=... AGENCITY_ACCEPTANCE_REAL_MODEL=... \
  bun run test:acceptance:external
```

Official Turso Sync server conformance requires an external version-matched binary:

```sh
TURSO_SYNC_SERVER_BIN=/absolute/path/to/tursodb   bun run test:turso-official
```

Real Turso Cloud smoke testing is credential-gated and must use a disposable database:

```sh
AGENCITY_TURSO_SMOKE=1 TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=...   bun test test/slice4/cloud-smoke.test.ts
```

The isolated `benchmarks/prime/` project provides a custom Prime Verifiers v1
harness plus suite-capable Terminal-Bench 2, Terminal-Bench 2.1, SWE-bench Pro
public, and OOLONG tasksets. One shared deterministic selection contract
supports exact IDs, explicit ID lists, named smoke subsets, seeded samples,
stable shards, and all compatible tasks. Generated immutable catalogs retain
complete task coverage, typed incompatibility reasons, task/source/tree/image/
workdir/evaluator/lock pins, exact selected IDs and digests, and named smoke
sets. Terminal-Bench 2 and 2.1 each catalog 89/89 compatible official tasks and
leave the unmodified Harbor verifier authoritative. SWE-bench Pro catalogs all
731 public rows: one qutebrowser row is compatible, 729 remain incompatible
with `image_configuration_not_audited`, and one audited Vuls row is incompatible
because its official no-op control produced no parsed test evidence. Its `all`
mode therefore means all compatible tasks, not the complete public suite. Every
compatible SWE-bench Pro task uses the split lifecycle that replaces original
Git history with one pinned baseline, proves the withheld commit unresolved,
captures only a bounded private patch after Agencity shutdown and cleanup, and
enters host scoring only after Verifiers requests owned-runtime teardown. The
pinned unmodified official evaluator then runs in a fresh network-disabled
scorer. Verifiers currently logs runtime-stop failures without exposing a
teardown receipt to the custom environment, and the private patch is not
host-crash-resumable between finalization and scoring. Missing or malformed
scorer evidence is an infrastructure error, never reward zero. The OOLONG adapter
applies the same selection controls to its pinned file-context slice. Yahoo
128K admission enforces the packaged 50-task manifest over exact order, IDs,
context identities, sizes, and answer types. Its deterministic scorer is
parity-tested against pinned Prime OOLONG-synth v1 source, and suite configs use
portable shutdown/cleanup plus serial execution. Full context and gold answers
remain private task-object fields outside serialized task data and provenance.
OOLONG prompts give exact large-file and recursive aggregation guidance. All
suite configs use a 36,000-token per-response ceiling, and treatments with an
aggregate output ceiling use the same bound while retaining separate turn and
total-token limits. The bounded eight-task Sol treatment uses four explicit IDs
from each Yahoo context window. A
pinned-container fake-provider
test exercises the exact JSON product startup path with an initially missing
explicit state directory. Malformed launch results retain bounded scrubbed
stdout/stderr diagnostics instead of collapsing to a parser-only error.

Deterministic summaries separate passes, valid zeros, partial rewards, harness
terminal failures, provider failures, scorer/infrastructure errors,
cancellations, unknowns, and incompatibilities, and state the official-score
denominator. Taskset/scorer semantics are separated from harness-specific
installation and cleanup so a future Verifiers-compatible harness can use the
same selection and scorer. No second harness integration or matched comparison
is implemented.

Model-free suite validation is infrastructure evidence, not benchmark
performance. Paid evidence remains limited to one passing Terminal-Bench 2
`fix-git` treatment, one passing Terminal-Bench 2.1 `fix-git` treatment, bounded
OOLONG probes including one revised Sol-high Yahoo 128K pass and one
current-revision Sol-high zero, and one zero-score SWE-bench Pro qutebrowser
treatment that reached Agencity's token bound without a patch. The OOLONG zero
completed startup, execution, scoring, and cleanup on commit `5d533d1` but
returned `Society & Culture` instead of `Sports` after 19 Agencity steps, 20
provider calls, 90,951 prompt-plus-completion tokens, about four minutes, and
$0.89. No paid full-suite, hosted, or matched-harness result is verified. Large
unattended runs also remain limited by the absence of a public durable
cancellation/reconciliation receipt.

Report pass, fail, and skip counts separately. Never summarize a skipped real integration as verified.

## Architectural map

Primary source areas:

- `src/domain/` — domain types, immutable event schemas, reducers, validation, and shared semantics.
- `src/storage/` — storage contracts, local LibSQL implementation, migrations, and Turso exchange adapter boundary.
- `src/artifacts/` — artifact contracts and the local content-addressed store.
- `src/executors/` — typed effect executors for models, shell, files, skills, and related boundaries.
- `src/console/` — disposable Bun worker and supervisor-owned RPC interface.
- `src/runtime/` — supervisor and domain services: model loop, outbox, agents, goals, memory, refinement, recovery, sync integration.
- `src/product/` — workspace discovery, product catalog and selection, provider onboarding, managed-service discovery, and product lifecycle composition.
- `src/protocol/` — loopback HTTP/JSON, SSE, and typed client surfaces.
- `src/tui/` — terminal client.
- `src/security/` — SQL restrictions, secret handling, and trusted-local safeguards.
- `src/sync/` — sync lifecycle, reconciliation, manifests, and data-control services.
- `src/placement/` — replaceable local/remote contracts, including HTTP-backed and object-store placement adapters.
- `src/cli.ts` / `src/cli-args.ts` — current raw CLI dispatch and parsing.
- `test/` — unit, integration, end-to-end, slice-specific, adversarial, and placement conformance tests.
- `scripts/check-architecture.ts` — architectural boundary and schema/table checks.

The `docs/` tree is the maintained public documentation set. [`docs/README.md`](./docs/README.md) is its reader-facing entrypoint and must keep user, operator, integration, architecture, reference, decision, verification, and planning material clearly separated. Public documents explain the product without assuming knowledge of delivery phases, internal ticket names, implementation plans, or prior discussions.

This file remains canonical for product direction, intended behavior, current implementation status, and repository rules. Public docs elaborate supported behavior and operation without replacing that authority. When code or current product status disproves a public document, the document is defective and must be corrected.

## Non-negotiable invariants

### Durable state owns identity

A process, worker, model connection, TUI, or machine-local heap may disappear without taking committed agent identity with it. Anything required after a restart must be stored as a canonical event, validated durable record, typed working value, or referenced artifact.

Do not make correctness depend on:

- module globals;
- a living console worker;
- an in-memory session registry;
- an attached TUI/client;
- uncommitted stdout;
- an object handle that cannot be reconstructed from durable JSON identity.

### Events are canonical

Canonical domain history is append-only during ordinary operation. Projections, caches, snapshots, leases, sync staging, and indexes may be mutable only when their classification and rebuild/operational semantics are documented.

- Do not update or delete retained canonical events to make a projection convenient.
- State transitions append typed, validated events through domain/storage commands.
- Idempotency-key reuse must agree on all durable meaning.
- Duplicate event application must be a true no-op.
- Historical projection and rebuild must never re-execute external effects.

Physical owned-scope deletion is a separate, guarded data-control operation. Do not weaken its confirmation, ownership, quiescence, remote-administration, receipt, or retry requirements.

### Event evolution is versioned

Released event meanings are immutable. Before the first release, an architecture cutover may replace the accepted workspace schema and require local state reset instead of implementing compatibility. The current runtime accepts event schema version 5 only, uses reducer version 15, and rejects version-1/version-2/version-3/version-4 workspaces with reset guidance before migration, row decode, projection, sync ingestion, and recovery. There is no general event-version registry or upcaster pipeline.

After release, changing event meaning requires explicit version acceptance, deterministic projection/upcasting, retained-history fixtures, protocol compatibility tests, and updated event documentation. Pre-release cutovers must still fail closed before projection and must never silently reinterpret an older workspace.

Never rewrite retained history as a migration shortcut.

### No hidden durable heap state

Console cells run as disposable async-function bodies. Values needed by later cells use the typed `state` API; larger content uses artifacts. Handles passed across restart boundaries must be JSON identities resolvable through durable services.

A console worker restart after every committed cell should not change materialized state or task ownership.

### Effects use the outbox

Model calls, shell/file tools, skills, and other external effects must be durably requested before execution and receive explicit terminal outcomes.

- Stable logical retries use stable idempotency keys.
- Idempotent lost work may be requeued according to the executor contract.
- Lost non-idempotent work becomes `unknown` and is not blindly retried.
- Caller death after a committed outcome must not cause duplicate execution.
- UI history or replay must never repeat effects.

Do not bypass the outbox for convenience in a new CLI, TUI, skill, or agent loop.

### Context and adaptation are attributable

Every model response should be traceable to the immutable messages, context records, memory retrieval results, and harness versions it received.

Memory and continual-harness changes preserve:

- scope and ownership;
- source evidence;
- candidate/control exposure when evaluation uses it;
- deterministic validation and sealed-reviewer decisions;
- standing user authority and typed scope boundaries;
- attributable post-activation evaluator results when gathered;
- exact version activation and rollback;
- conflicts rather than silent preference overwrites.

A persuasive proposal or approving review is not objective outcome evidence.

### Controlled mutation

Model-generated code does not receive unrestricted canonical database writes. Raw SQL is analytical and read-only. Canonical state changes go through typed SDK/runtime commands with domain validation.

Keep LibSQL/Turso SDK objects confined to their adapters. Public domain and storage contracts must remain adapter-neutral and pass shared capability/conformance tests.

### Placement preserves semantics

Local and remote implementations may have different capabilities, but they must share domain semantics. Unsupported capabilities fail visibly with typed errors rather than silently falling back or changing guarantees.

Local-first operation must remain available when Cloud is absent or unreachable. Remote transport loss must not turn a remote placement into an implicit local placement.

### Uncertainty remains visible

Missing artifacts, corrupt digests, stale gates, divergent claims, unavailable coordination, interrupted non-idempotent effects, and partial deletion are explicit states. Do not convert unknown or unavailable into success to keep a workflow moving.

## Security boundary

The current system is **trusted-local**, not a hostile-code sandbox.

- Model-generated TypeScript and shell commands can exercise the OS authority of the runtime process.
- The separate Bun console worker provides crash and protocol isolation, not security isolation.
- The shell executor constrains its initial working directory but is not an OS sandbox.
- Automatically loaded repository `AGENTS.md` files are untrusted model-facing behavioral guidance. They are bounded, source-attributed, and scrubbed for known brokered secrets, but they cannot grant runtime authority or become sealed refinement-review policy. Repository authors must not store secrets in them.
- The product-managed HTTP service is bearer-authenticated from an owner-only discovery manifest and binds to loopback. The advanced embedded diagnostic server is unauthenticated and must remain on loopback unless protected by an external boundary.
- Read-only SQL is a shared diagnostic surface, not a confidentiality boundary between candidates or workspaces.
- Scope filtering controls behavior and context selection; it must not be described as protection against hostile local SQL/code.

Provider credentials remain supervisor-side. Preserve secret stripping, known-value rejection/redaction, non-login shell behavior, and opaque credential references. Never put raw credentials into events, logs, artifacts, profile metadata, sync envelopes, test fixtures committed to Git, or error messages.

Any new UI or entrypoint must state trusted-local authority clearly and must not claim sandboxing that does not exist.

## Database, migrations, and table changes

When adding or changing relational state:

1. Decide whether the data is canonical, a rebuildable projection, an operational cache, a lease/claim, an index, or sync/control state.
2. Prefer canonical domain events for retained agent meaning.
3. Add a numbered migration in the established migration mechanism.
4. Update the table classification in `docs/mutable-tables.md`.
5. Update architecture checks when a new table or boundary is introduced.
6. Add replay/rebuild and restart tests where the data affects agent identity or execution.
7. Test idempotent migration/open behavior.
8. Keep Turso/LibSQL types inside the storage adapter boundary.

Do not add a mutable “current state” table without documenting how it is rebuilt or why it is operational rather than canonical.

## Artifact changes

Artifacts are immutable and content-addressed. The database stores references and provenance, not necessarily payload bytes.

- Verify digest and size on resolution and export.
- Model-facing retrieval uses exact zero-based half-open ranges of at most 64 KiB. Whole-object resolution remains an internal/operator surface.
- Identical content should deduplicate independently of source name.
- Missing/corrupt referenced bytes are dependency failures, not empty content.
- Backups and exports must account for both database state and referenced artifact bytes.
- Deletion must respect retained references and ownership; do not delete shared CAS content speculatively.

## CLI and TUI direction

The no-ID product entrypoint and compatible raw diagnostic CLI are both implemented. Remaining product interface work must preserve this direction:

- `agencity` creates or resumes and opens the product directly;
- users should not copy session or branch IDs for normal operation;
- product selection must exclude internal deterministic test providers;
- provider setup must not require dropping to HTTP or TypeScript APIs;
- the TUI should project the public client/event contract;
- a task should drive a typed, recoverable model-to-TypeScript/tool action loop rather than only one chat response;
- internal IDs and low-level cell/history/rebuild operations remain available as advanced diagnostics.

Do not paper over the missing autonomous loop by heuristically executing arbitrary assistant prose. Model actions must be typed, versioned, validated, attributed, budgeted, and durably recorded before dependent work.

## Testing expectations

Choose the narrowest relevant test during iteration, then run the full gates before claiming completion.

For changes to:

- reducers/events: add unit replay, duplicate, invalid-transition, and rebuild tests;
- storage/migrations: add reopen, idempotency, physical-constraint, and architecture checks;
- effects/recovery: test crash boundaries before request, after request, during execution, and after committed outcome;
- console RPC: test worker restart, stdout isolation, secret handling, and failed-cell atomicity;
- recursive agents: test restart, cancellation trees, task budgets, mailbox authorization, and terminal delivery;
- memory/refinement: test scope, provenance, deterministic validation, proposer/reviewer separation, standing authority, skill tests, activation conflicts, terminal delivery, outcome evidence, and rollback;
- sync: test offline writes, reconnect, concurrent writers, corruption/quarantine, conflicts, restart, and unsupported capabilities;
- protocol/TUI: test snapshot-then-stream races, cursor resume, duplicate delivery, typed errors, and no repeated effects;
- CLI/product entrypoint: add black-box tests that do not call supervisor internals or manually inject IDs;
- security: include adversarial inputs and prove actual known secret values do not escape.
- bounded output/context: verify provider-candidate estimator/executor parity and recovery digest, observation ownership and raw-ledger preservation, shell spill/truncation and cross-chunk scrubbing, file/range bounds, cell-result staging cleanup/orphans, unavailable remote spill transfer, and installed-product focused recovery from unexpected large output.

Static structure checks do not replace behavioral tests, black-box product verification, or independent review. The product completion bar in this file is authoritative.

## Documentation expectations

The `docs/` directory is Agencity's maintained public documentation set, with `docs/README.md` as its index. Keep it accurate as part of implementation work rather than treating documentation as a later cleanup. Each public page must stand on its own, define necessary terms, and use stable product language instead of assuming knowledge of a delivery phase, ticket, implementation plan, or prior discussion.

Treat stale public documentation as a product defect. Update the relevant documents in the same change whenever behavior, configuration, commands, APIs, events, tables, security boundaries, recovery semantics, data lifecycle, capabilities, installation, or verification claims change.

At minimum:

- user-visible workflows update `README.md`, `docs/user-guide.md`, or both;
- defaults, options, paths, providers, credentials, or environment variables update `docs/configuration.md`;
- backup, export, import/restore limits, migration, or deletion behavior updates `docs/data-lifecycle.md`;
- operational procedures update `docs/operator-guide.md`;
- public TypeScript, protocol, or console surfaces update their dedicated API documents;
- security or recovery changes update `docs/security.md` or `docs/recovery.md`;
- capability or verification changes update their dedicated public summaries; and
- the public map in `docs/README.md` stays current when documents are added, moved, renamed, or retired.

Keep `AGENTS.md` current in the same change when product direction, intended behavior, implementation status, invariants, supported user journey, or known limitations change. Implementation plans may retain delivery-specific detail, but public pages must use stable product language and label plan links as planning or historical material.

Do not leave docs claiming:

- a command works when only a package `bin` declaration exists;
- real streaming when providers emit only a post-completion chunk;
- cloud verification when the credential-gated test was skipped;
- sandbox isolation in trusted-local execution;
- general deletion when only narrower owned scopes are supported;
- a complete autonomous product when only runtime primitives are wired.

Prefer explicit capability and limitation statements over implied behavior.

## Change discipline

- Keep domain semantics out of CLI/TUI formatting code.
- Reuse typed services and public contracts rather than opening side-channel database connections.
- Avoid broad rewrites when a focused event, command, adapter, or projection change is sufficient.
- Preserve compatibility with retained databases and artifact references unless a migration plan is included.
- Do not weaken validation or capability errors to make a demo pass.
- Do not silently broaden permissions, scope, budgets, or publication authority.
- Do not commit credentials, local `.agencity` state, generated databases, replica sidecars, or temporary artifacts.
- Record intentional deferrals and their rationale in this file's current-status section rather than representing them as complete.

## Definition of done

A change is done when:

1. The user- or operator-visible outcome is implemented.
2. Architectural and security invariants still hold.
3. Relevant automated tests cover success, restart/failure, and adversarial behavior.
4. Typecheck and architecture checks pass.
5. This guide, public docs, and verification evidence are current.
6. External tests are either reproduced or clearly reported as skipped/unverified.
7. Remaining limitations are explicit.

For product tickets, include a black-box path from the documented entrypoint. A direct unit test of the underlying service is not sufficient evidence that the user journey works.

## Cursor Cloud specific instructions

This environment is preconfigured so that `bun` (1.3.14, satisfying the `>=1.3.13` engine) is on the standard `PATH` via `/usr/local/bin/bun`. The startup update script runs only `bun install --frozen-lockfile`. Standard commands live in this file's "Runtime and development requirements" section and in `package.json`; use those rather than re-deriving them. The canonical gate is `bun run verify`.

Non-obvious caveats discovered while running the suites in this VM:

- No real provider is configured. The product CLI (`agencity` / `bun run dev`) refuses non-interactive autonomous runs without a usable OpenAI/Anthropic/Gateway credential, and Echo is filtered from product selection, so `agencity --model echo:...` is not a runtime fallback. To exercise a real end-to-end task through the installed CLI without external secrets, drive it against the loopback OpenAI-compatible fixture in `test/acceptance/strict-action-fixture.ts` together with `AcceptanceWorld` from `test/acceptance/helpers.ts` (the acceptance tests are the reference pattern: `config set-model openai:openai/fixture-v1` with `fixture.environment()`, then `run --json`).
- `bun run test:unit` and `bun run test:integration` use `--parallel=4` with the default 5000 ms per-test timeout. On this shared VM, heavier integration tests (`product-cli`, `refiner`, `skill-management`) and some OpenTUI frame-render unit tests intermittently hit that 5000 ms limit under CPU pressure; they pass when run with `--timeout 30000` or in isolation. The canonical `bun run verify` / `test:core` gate already uses `--timeout 30000`, so prefer it for a trustworthy result.
- One OpenTUI unit test in `test/unit/opentui.test.ts` ("renders a stable workspace, preserves input during protocol updates, responds to resize, and detaches") consistently times out on the native frame-render predicate in this headless VM even in isolation; the frame content does render and the remaining OpenTUI cases plus the `test/e2e/opentui-pty.test.ts` pseudo-terminal journey pass. Treat this single case as a headless native-renderer limitation, not a regression.
- The `profile-governance` acceptance test can fail at `history current --json` with a JSON "Unterminated string": that command emits a large (~475 KB) document and the CLI process may exit before the piped stdout is fully drained. This is a large-output flush behavior, not an environment/setup problem.

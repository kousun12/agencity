# AGENTS.md

**Role:** Canonical repository guide  
**Last reviewed:** August 21, 2026

This file is the current source of truth for Agencity's purpose, product intention, design principles, supported behavior, known gaps, architecture, and implementation rules. A new reader should not need another product document to understand what the project is trying to build or what is currently real.

[`docs/stable/BLOG.md`](./docs/stable/BLOG.md) is a companion explanation of the product thesis. This file is authoritative when wording in that essay, the README, or a technical document blurs intended behavior with shipped behavior. Code and tests are the evidence for current capabilities; they do not by themselves redefine the product intention.

Update this file whenever a change alters the product direction, supported user journey, durable domain model, security boundary, major capability, or known limitation.

Authoritative implementation plans are the [parent TypeScript/Turso rewrite PRD](./plans/2026-08-05-prime-agent-typescript-turso-rewrite-prd.md), the [FU-001–FU-019 follow-up backlog](./plans/2026-08-06-prime-agent-typescript-turso-rewrite-follow-up-plan.md), the [formal model-tool contracts plan](./plans/2026-08-07-formal-model-tool-contracts-plan.md), the [durable agent profiles and automated refinement review plan](./plans/2026-08-08-adaptive-agent-city-plan.md), the [default automatic adaptive learning plan](./plans/2026-08-11-default-automatic-adaptive-learning-plan.md), and the [Agencity Observe plan](./plans/2026-08-19-agencity-observe-prd-and-plan.md), in that order after this guide. The [lossless context-reference storage plan](./plans/2026-08-07-lossless-context-references-plan.md) is deferred and requires a new readiness review.

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
- watch one active root family through a disposable read-only localhost browser client without changing work, service ownership, or product selection;
- steer, cancel, detach, resume, branch, export, and delete owned work without bypassing durable runtime semantics;
- use human-readable product flows while retaining internal IDs, SQL, and low-level operations for diagnostics and automation;
- attach through a terminal client that observes the same public snapshot/event protocol as other clients and does not become the owner of session identity.

The model should receive one general generated-execution surface—the TypeScript console. SQL, files, shell effects, artifacts, explicit raw AI generation, retained child-agent calls, memory, and refinement are typed APIs inside that environment. Product code should not replace this with a growing hard-coded workflow or independent menu of model tools.

Product success is measured through the complete user journey, not only through storage, reducer, or service tests. Do not optimize for passing component tests while leaving onboarding, autonomous execution, interruption, recovery, or resume incomplete.

## Design constitution

Use these principles when requirements leave an implementation choice:

- **Adapt through experience.** Repeated success and failure should produce scoped memories, skills, subagent roles, retrieval policies, and workflows. Learned specialization must remain attributable, testable, and reversible.
- **Durable state owns identity.** A process, model connection, console heap, UI, or machine may disappear without taking committed work or task ownership with it.
- **Context is queryable data.** Retain complete attributable history and give the model bounded projections plus deliberate query tools. Compaction is a derived view, not destructive replacement of evidence.
- **General mechanisms precede prescribed workflows.** TypeScript, SQL, model calls, durable tasks, evaluators, and policies are the building blocks. Keep the core domain-general: work that can be composed through the TypeScript console and workspace file or shell operations does not require a dedicated framework surface for each task category. Package recurring successful workflows as inspectable skills instead of enlarging a fixed universal loop.
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
- **Retained multi-agent work:** subagents and recursive calls are durable sessions with tasks, budgets, mode-aware messages, artifacts, cancellation, and queued work—not disposable strings.
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
- A **console namespace** is the noncanonical Bun TypeScript REPL environment owned by one exact session and branch. Top-level variables, functions, classes, imports, module instances, and object identity remain available across cells while that worker lives. The namespace may disappear on cancellation, RSS recycling, worker/service/process loss, or branch change. It is never task ownership, completion evidence, synchronization, export, automatic context, or a recovery requirement; required recovery data uses state or artifacts.
- An **effect** is external work such as a model, shell, managed-process, file, or skill request. The outbox records the request before execution and records `succeeded`, `failed`, `cancelled`, or `unknown`.
- A **managed process** is a trusted-local background OS process group owned by one workspace/session/branch/originating cell and optional agent run. Its queued/running/terminal lifecycle, effect, random recovery identity, bounded scrubbed logs, artifact spill, and failed stop diagnostics are durable; its live child-process object is not. A process group containing only Linux zombie or dead process states is terminal execution state even while the kernel retains its process-table entries.
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
6. Execute generated work through the exact-branch persistent TypeScript REPL and durable outbox-backed APIs.
7. Commit the action, cell, effects, observations, usage, child work, and resulting state before making a dependent model call.
8. Continue until completion gates pass, a bound is reached, cancellation reconciles, or a blocked, failed, or unknown outcome ends the run. Missing user information uses blocked `finish`; a later user message starts an ordinary new run on the same branch.

Unstructured model prose must never be heuristically executed as code. The model receives TypeScript as its general generated-execution surface; run-control outcomes remain typed supervisor decisions rather than additional privileged tools.

The TUI and other clients observe this lifecycle through snapshot-plus-cursor event semantics. They may steer, cancel, detach, and resume, but client attachment is not durable session identity and process exit is not proof that external work stopped.

## Current implementation status

### Implemented runtime foundations

- local LibSQL canonical event storage, recursive creation of missing file-backed database parents, immutable event guards, deterministic projection/rebuild, branches, snapshots, cursor-based subscriptions, one shared race-safe snapshot-plus-cursor terminal waiter with an explicit bounded polling fallback only for placements that advertise unavailable relational notifications, and candidate-driven startup recovery that shares one cursor-checked current-branch projection and avoids replaying unrelated terminal runs;
- persistent Bun TypeScript REPL environments in a bounded exact-session-and-branch worker pool with separate resident-process and active-execution permits, deadlock-free capacity-reserved awaited children, queued detached children, isolated namespace/stdout/worker loss, random authoritative epoch IDs with readable adjective-noun-suffix names, final-expression or explicit-return observations, bounded safe inspection/logs, durable working values, retained cell history, read-only analytical SQL, content-addressed artifacts, 128 KiB cell-result IPC with streamed JSON artifact staging above that boundary, one-based bounded file pages, and exact bounded artifact byte ranges;
- outbox-backed model, shell, managed-process, file, and skill effects with typed pre-execution origins, crash recovery, explicit unknown outcomes, and `agencity.bounded-output.v1` completeness envelopes; direct failed/cancelled/unknown convenience-helper errors retain validated exact effect-outcome event IDs on new `CellFailed` events through private non-text worker metadata, while wrapped errors and recovery-time abandonment do not invent causality; local shell and managed-process execution stream exact registered-value scrubbing into 24 KiB head/tail previews and spill complete output up to 32 MiB to CAS when available; `sdk.processes.start/inspect/readLogs/stop/list` returns durable JSON handles, ties process groups to their owning run/cell/effect, survives console-worker loss, treats zombie-only groups as terminal, retains failed stop attempts with exact diagnostics, authenticates restart cleanup with a random token rather than PID alone, and never retries uncertain work;
- durable root and child sessions, nuclear-family mailboxes with default queued sends and explicit non-waking steering, deterministic immediate run IDs and sender-authorized observation-only result lookup for new non-legacy queued messages, cancellation trees, recursive-model runtime handles, documents/input sets, goals, cached attributable gates, heartbeats, schedules, and wake queues;
- durable per-session agent profiles embedded in root and child admission, sealed root/task-specialist defaults, specification-source provenance, session-wide active-profile projections, bounded active/history inspection, and exact profile/effective-system-prompt pins across autonomous and recursive invocations;
- scoped memory with FTS5 candidate retrieval, versioned prompt notes, skills, subagent specifications, governed refinement/evaluation/rollback, and an attributable trajectory refiner with profile-owned automatic-trigger policy;
- profile and device identity plus optional offline-first Turso envelope synchronization, divergent-branch preservation, conflict/quarantine records, and single-device session execution ownership;
- exact `agencity.provider-input.v2` candidates shared by estimation, execution, and recovery; append-only autonomous transcript segments with attributable compaction resets; provider-neutral assistant tool calls/results and durable-state deltas; bounded active-run/profile projections; a 512 KiB hard ceiling and 384 KiB compaction target for unknown-capacity candidates; deterministic per-step provider observations capped at 56 KiB per item and 64 KiB total without changing the canonical observation ledger; and production-builder verification that deterministically checks next-action facts and post-cell recovery behavior without claiming live-model semantic equivalence;
- attributable repository instruction loading: bounded root `AGENTS.md` content occupies a stable provider-message prefix, successful typed file reads deliver up to four changed ancestor files in root-to-nearest order, `CellCommitted` retains exact path/digest/size/completeness provenance plus explicit pending/omission state, unchanged digests deduplicate across restart and branch lineage, and changed/removed/restored sources reactivate automatically;
- loopback HTTP/JSON and SSE surfaces with cursorless provider progress, periodic branch-stream comment heartbeats, snapshot-plus-cursor terminal waiting for protocol client agent and raw-generation convenience methods, strictly read-only owner-validated service-manifest inspection and bounded exact-path passive discovery polling primitives, a TypeScript API, a no-ID product CLI plus compatible diagnostic commands, a protocol-backed terminal TUI, and a foreground read-only Observe server;
- `agencity observe` dispatch before writable product bootstrap; source/link entrypoints; ephemeral or explicit loopback port selection; no browser auto-open; process-lifetime fragment-to-HttpOnly-cookie authentication; exact Host/fetch-site/origin and CSP enforcement; one process-wide selected initial-root family; revision-4 health/capability admission; bounded breadth-first family projections, task-first current-run and budget summaries, auto-fitted family graphs, grouped semantic activity, in-context lazy route-detail drawers, event/replay buffers, heartbeat-driven resync, service-instance replacement, and final-browser attachment release. Technical connection IDs use progressive disclosure, while a compact header label keeps local read-only authority visible without a persistent callout. Observe never initializes the workspace, opens LibSQL, starts or stops the managed service, runs recovery or wakes, calls managed mutations, changes product selection, forwards artifact bytes/full `AgentState`, or persists observer state;
- local and HTTP-backed placement contracts for relational state, artifact storage, candidate retrieval, and execution, with explicit capability reporting and conformance coverage.

### Incomplete product surfaces

- The Agencity Observe code path, native browser assets, authenticated foreground server, narrow managed-protocol source adapter, disposable projection model, deterministic non-browser tests, source-checkout and isolated linked-asset command coverage, and opt-in Playwright journey are implemented under the complete [Observe plan](./plans/2026-08-19-agencity-observe-prd-and-plan.md). The observer requires managed protocol revision 4 and the managed-service/product-catalog/snapshot-resume/event-deduplication/cursorless-progress capabilities. Its first version is intentionally limited to one process-wide selected initial-root family, 64 loaded routes, bounded current state and process-local replay, lazy inspector pages, and artifact metadata without bytes; it has no control actions, full historical playback, branch-fork topology, multi-family/workspace view, durable index, remote hosting, or protocol-level least-privilege observation credential. On August 21, the exact final tree passed 46 focused observer tests with no failures or skips, the source-checkout and isolated linked-asset cases passed, and the actual Playwright Chromium journey passed one test through the foreground CLI, browser, and server against a protocol-compatible managed fixture. A clean `bun run verify` passed typecheck and architecture: 1,286 core tests passed with 2 gated external skips, 13 end-to-end tests passed, and 27 acceptance tests passed with 1 real-provider skip, for 1,326 passes, 3 skips, and no failures in total. Independent review found no blocking defects and independently passed typecheck, architecture, and 45 focused observer tests. Non-blocking first-version risks remain: child admission uses a bounded family resync rather than incremental child-only loading; no real-runtime canonical before/after diff supplements the static allowlists and fixture no-mutation coverage; and snapshot-pinned detail cursors can require refresh on a busy route. Real-provider, official Turso Sync, and Turso Cloud checks remain gated and unverified.
- Durable per-session agent profiles and invocation-level profile/effective-prompt pins are implemented under [ADR 0012](./docs/decisions/0012-durable-agent-profiles-automated-refinement-governance.md). Profile, memory, prompt-note, skill, and subagent-specification proposals use deterministic validation, one separate sealed reviewer selected from the origin route's current model, application-time revalidation, automatic approved-version application, exact terminal delivery, bounded reproposal chains, and exact rollback. The sealed refiner policy maps durable facts and preferences to memory, repeated behavioral tendencies to prompt notes, reusable deterministic tested operations to skills, and recurring delegated roles to subagent specifications; repository-specific implementation and missing runtime primitives remain ordinary implementation work. Every newly frozen review uses governance input version 3. It gives the reviewer deterministic cited-event excerpts under one 32 KiB aggregate budget, with canonical and redacted payload digests, excerpt digests, exact byte counts, truncation state, and credential/repository-instruction redaction provenance. Repository instruction content and brokered secrets remain excluded. Refiner-produced proposals additionally pin the trigger, allowed kinds, review identity, and source-snapshot hash. Retained version-1 and version-2 inputs remain readable. The trajectory refiner's required objective evaluation is retained in the governed proposal, frozen input, inspection projection, and application event as post-activation evaluation intent; it does not gate ordinary activation. New automatic-refiner admission requires it, while direct proposals and retained schema-5 automatic proposals may omit it. Approved generated skills remain the only target with an additional compile-and-declared-runtime-test activation check. The governance reviewer rejects proposals whose evidence, trigger, selected artifact, and predicted effect do not form a direct causal chain, including generic diligence substituted for the requested capability. Profile and non-skill application is atomic; storage accepts a later profile version and activation only when they match the exact `reviewed_approved` proposal, decision, target, content, expected version, and atomic application event, or an exact atomic rollback pattern. Approved skills activate only after durable compile and declared runtime tests pass. Self, direct-child, workspace-owner, and local automatic-refiner authority is enforced; siblings and unrelated agents cannot revise one another. The reviewer receives the frozen product constitution, policy, model dispatch, and explicit 16,384-token, USD 1, two-turn-slot, 120-second limits; smaller parent budgets remain authoritative. Unavailable workspace-charter and user-constraint configuration is retained as `null`; callers cannot select the reviewer or widen authority. Agent rollback evidence must be visible on the caller branch lineage, while owner rollback may cite same-workspace evidence. Recovery scans oldest-first in bounded pages until every nonterminal proposal and terminal undelivered notice has been considered. Public protocol, `AgentClient`, Console SDK, route-relative `agencity profile`, and `/profile` controls expose inspection, proposal, wait/detach, history/diffs, reasons/guidance, notices, and rollback. Runtime, focused recovery, sync-divergence, export-audit, deletion-refusal, focused lifecycle, isolated linked-executable acceptance, and final deterministic aggregate verification have passed. External live-provider, official Turso Sync, and Turso Cloud checks remain gated and unverified.
- `agencity`, `bun run dev`, workspace discovery, durable no-ID resume/selection, explicit provider/model onboarding, and source/link installation are implemented. Interactive setup uses a session-independent keyboard typeahead: provider display names and stable IDs are searchable; model display names and canonical `creator/model` IDs use deterministic fuzzy ranking; Up/Down, Enter, Backspace, Escape, bounded visible windows, and exact unmatched manual-ID rows are supported. Escape clears the active setup picker and exits cleanly without reporting cancellation as an error. Direct OpenAI accepts only `openai/...`, direct Anthropic only `anthropic/...`, and Gateway accepts every valid creator namespace. Catalog display names remain presentation while the exact canonical ID is retained. The configured Gateway-compatible `/v1/models` catalog is loaded without provider credentials or inference and reports refreshed, visibly stale cached fallback, unavailable, and provider-filtered-empty states; unavailable and empty states retain exact manual entry, and catalog presence is not execution evidence. Gateway, direct OpenAI, and direct Anthropic execution share one Vercel AI SDK core with thin transport factories. Direct OpenAI uses `/v1/responses` with provider storage and reasoning summaries disabled, preserves explicit reasoning effort with required function tools, and pins the Responses API path into execution endpoint identity so retained Chat Completions dispatches fail closed. The catalog supplies model capacity, pricing, reasoning, and display metadata through a bounded endpoint-keyed profile cache. The branch-attached TUI `/model` inspector consumes the same fuzzy matching, creator filtering, exact manual rows, and selection reconciliation while preserving its surface-specific provider visibility, controls, composer draft, and idle mutation boundary. `/effort` selects durable provider-default, none, minimal, low, medium, high, or xhigh reasoning at an idle model boundary. Owner-only provider keys remain outside canonical/profile preference databases. A stored key can remain after later picker cancellation, while no model preference or root is created; a confirmed model preference can remain if the separate root request later fails or becomes unconfirmed after dispatch. Malformed retained defaults warn and reopen selection interactively but fail closed with guidance non-interactively. Non-Echo resume preserves committed model identity, while retained Echo branches use the explicit product-model migration. Environment keys remain supported fallbacks. Deterministic aggregate and installed acceptance-matrix verification passed; the real-provider, official Turso Sync, and Turso Cloud rows remain gated and unverified. The package remains private and has no claimed registry or standalone release channel.
- Durable session titles are maintained in the background from task-bearing input on the exact branch: direct client messages, the session's initial delegated task, and parent-to-child family input. Child results delivered to a parent and sibling traffic do not rename the receiver. OpenAI and Vercel routes use one structured Luna call with a free-form verb, subject, and intent summary; Gateway retains canonical `openai/gpt-5.6-luna`, while direct OpenAI sends native `gpt-5.6-luna`. Other providers derive a deterministic verb-first fallback from durable messages without a model effect. Title requests and outcomes retain exact source-message, dispatch, provider-input, usage, and effect provenance, use latest-frontier-wins ordering, recover without blind retry of uncertain work, and do not debit autonomous-run budgets. Explicit `SessionNamed` changes retain user authority. Product selection, managed root DTOs, family records, the TUI, and Observe render the maintained title and bounded intent metadata while preserving technical IDs for diagnostics.
- Interactive onboarding without an explicit or valid retained model is provider-first. It always shows OpenAI, Anthropic, and Vercel AI Gateway before model selection, labels stored, environment, and missing credentials, deterministically defaults to an authenticated provider, permits selecting and authenticating another provider through hidden input, and then always opens that provider's filtered model typeahead. Interactive model environment variables do not bypass confirmation. Escape at provider, credential, or model input clears setup and exits successfully without a model preference or root; a credential stored before later cancellation may remain.
- The product has no demo mode. Echo remains an internal deterministic test provider and is filtered from product selection, help, status, and onboarding. Ordinary non-interactive work without a usable provider fails with setup guidance.
- The ordinary task route drives the formal provider tool contract: new product selections known unsupported fail before a model preference, root, branch model change, run, or runnable-child admission, while unknown exact-model capability remains admissible when transport primitives are proven. Every autonomous model call commits a required-tool-set dispatch with exactly `bun_console` and `finish`, and each canonical action or typed contract violation commits before application. Every provider step receives and retains the exact branch console status as cold or as a warm named REPL epoch; the model attempt pins that status, and a changed status before cell execution produces a typed `REPL_EPOCH_CHANGED` `CellFailed` without running the submitted source. Autonomous provider input starts with an attributable transcript segment. Each continued request preserves the prior message list as an exact prefix, then appends the provider-neutral assistant tool call or bounded rejection, the durable tool result or rejection observation, any changed durable-state delta, and one next-action message. Canonical compaction, a bounded source-record-backed reset when no canonical narrative is eligible, or a typed overflow retry starts an attributable segment/cache reset, after which append-only growth resumes. Failure recovery guidance directs inspection to a small range around reliable diagnostics or the smallest relevant source section, while epoch-change guidance directs reconstruction from durable state, artifacts, or current inputs without replaying prior effectful cells. The decision instruction asks whether the task is complete from the append-only transcript and latest durable state before admitting another cell. Ordinary production runs have no implicit model-step ceiling; durable budgets, absolute deadlines, cancellation, gates, and explicit test-only acceptance bounds remain authoritative. Direct OpenAI uses the Responses API with `store: false`, no `previous_response_id`, a session/branch-stable deterministic key, explicit cache mode, a 30-minute TTL, explicit breakpoints on supported next-action input-text blocks, fixed tool schema/order, and no parallel calls. Function-call outputs remain native tool results and are not relied upon for cache writes. In very long segments the provider may consider up to its 50 most recent breakpoints for reads; prior breakpoints are read-only and only the latest four may write on one request. `/capabilities`, startup/status, model selection, `/info`, `/raw`, and retained run steps expose the fixed contract with distinct provider-strict, runtime-validated, unknown, and unavailable states. Branch diagnostics derive fixed-cardinality submission/violation counters and bounded evidence summaries from canonical projections without adding mutable state or retaining rejected arguments. Successful completion checks required gates before materializing its exact assistant message. Blocked and failed `finish` calls atomically materialize their exact assistant message with the effective terminal status; later user input starts an ordinary new run. The former clarification/permission actions, pending-input events and route, and `waiting_for_user` state are absent. Trajectory refinement uses the sealed internal `agencity_submit_refinement_review` provider tool and a request-bound typed recursive result; it does not parse assistant text.
- Generated execution guidance states the exact positional artifact API, immutable range bounds, and `agencity.bounded-output.v1` shell-result branches. It requires delegated work to be strictly narrower than the caller's assignment, forbids recursive whole-task pass-through, and directs models to use the on-demand `sdk.agents.list()` nuclear-family projection before child admission when retained work may overlap. Family status is not injected or polled on every model step.
- Console cells support REPL observation, bounded `inspect`, artifact spill, `state.list`, and retained `cells.list/get`. Top-level variables, functions, classes, imports, module instances, and object identity persist across cells while the exact-branch worker and its epoch live. Completed in-memory mutations remain after a runtime throw, but staged state and artifact writes do not commit. Parse/transpilation failure, cancellation, worker loss, or failure after execution but before canonical commit recycles the worker and changes or removes the epoch. Required recovery values come only from state or artifacts; fresh work may recompute from current external inputs, but retained source is never replayed automatically.
- Shell and file helpers return `agencity.bounded-output.v1`. File reads use one-based inclusive windows of at most 2,000 lines, 2 KiB per line, and 48 KiB per page. The root `AGENTS.md` is loaded up to 64 KiB; successful typed file reads discover regular UTF-8 ancestor `AGENTS.md` files up to 16 KiB each, scan at most 256 KiB per file and 64 ancestors, deliver four changed records per read and 16 discovery groups per cell, and retain 40 KiB active nested content across 64 records. Bounds and stale omitted ancestors remain explicit pending/omission records; direct shell/Bun reads do not trigger discovery. Sealed refinement and governance reviewers exclude repository-authored content. Model-facing artifact reads use zero-based half-open `artifacts.readRange` calls capped at 64 KiB; whole-object CAS resolution remains internal/operator-facing. Remote executor RPC does not transfer spilled artifact bytes, so remote artifact references are rejected until a canonical transfer capability exists.
- Every model call retains `agencity.provider-input.v2`: exact provider-neutral text/tool-call/tool-result messages, fixed formal tool schema and order, cache and selection policy, token-relevant options, dispatch/endpoint/capacity provenance, digest, and byte count. The exact candidate drives estimation, execution, and recovery. The `provider-input-utf8-bytes-per-4-tokens-v1` estimator is conservative product admission evidence rather than provider-reported usage. Provider-reported cache read/write tokens remain diagnostics and do not change input-plus-output budget debit.
- Every `EffectRequested` retains a closed typed origin before execution and migration 019 stores it in the outbox projection. The provider-facing observation derivation gives a terminal cell ownership of successful cell effects and omits duplicate successful effect payloads, while failed/cancelled/unknown outcomes remain visible. `AgentRunStepStarted.observationEventIds` remains the complete canonical exact-once ledger.
- The console exposes direct `ai.generateText` and `ai.generateObject` (also under `sdk.ai`) for one-request raw generation over explicit prompt/messages and explicit bounded context references. Raw generation retains exact dispatch, provider input, schema, context, result, usage, budget, cancellation, timeout, unknown, and recovery provenance without creating child sessions, tasks, profiles, mailboxes, or family records; results remain inline and oversized output fails. The former model-facing `rlm`/`sdk.rlm` admission surface is absent, while retained recursive-model history and private sealed workflows remain supported. `sdk.agents.run`/`runMany` await full text or schema-constrained child-agent results; detached-running `spawn`/`spawnMany` return durable handles, and `handle.result(options)` or `sdk.agents.result(handle, options)` performs the same retained lifecycle/result lookup. The bound method is worker-local and non-enumerable, while the JSON handle remains durable. Awaited calls reserve bounded branch-aware console capacity before admission, while detached work may queue. The spawn input has no model-facing `run` boolean. `sdk.agents.send` defaults to `queue`: every new non-legacy message returns one deterministic immutable queued `runId`, idle recipients start immediately, and busy recipients process queued messages serially in canonical delivery order without exposing pending content to the active model context. `sdk.agents.messageResult` is sender-authorized and observation-only; it reports pre-admission queued and delivery failure without inventing a run, then delegates to retained agent-run results after admission. Explicit `steer` enters an active run at its next durable boundary or becomes retained context without waking an idle recipient. Steer and earlier schema-5 `followUp` messages expose no independent public run ID or message result and retain their former active-boundary delivery behavior. Agent output schemas and raw-generation schemas constrain data shape but do not prove facts, completion, safety, or authority.
- `/refine`, the public protocol client, and `sdk.harness.review/reviews` run a strict trajectory-to-candidate review through a durable recursive child with a supervisor-selected one-tool response contract. The accepted transport input is retained once in the model effect; successful children return a normalized typed result bound to the exact child model completion without creating a canonical assistant result message. The TUI retains an explicit `LEARNING` result for each parent-branch review across detach and reopen. Parent-route results appear in a centered dock above the composer, collapsed by default to the latest status and artifact-change hint; `Ctrl-Y` reveals the request, bounded reason, and guidance, while `/refine history` exposes all retained activity. No-change results direct repository or runtime implementation requests back to ordinary agent work. Product CLI and TUI refinement detach by default and support explicit `--wait`, `--detach`, and `--kind`; the CLI also supports `--scope`, while `sdk.harness.review` exposes the same typed scope, kind, and wait controls and retains API wait-by-default compatibility. Frozen bounded sources, decisions, proposal identity, and recovery status remain attributable. Automatic learning is enabled when the device profile has no explicit preference. `refine pause` stores a persistent device-wide pause across every workspace using that profile, and `refine resume` resumes new admissions; `auto off|on` remains compatible. A profile-backed expiring preference lease serializes pause/resume with automatic admission across workspace-service instances, automatic requests revalidate the device-policy generation immediately before append, and storage rejects a trigger frontier that became pending or consumed before the transaction. Automatic proposals remain local memory, prompt-note, tested-skill, or subagent-specification changes; every proposal still passes deterministic validation and one separate sealed reviewer. One scan admits at most one trigger. Default triggers are three matching effect failures, three failed cells in one agent run, two distinct-pin failures of one completion gate, one typed `UserCorrection`, or five successful terminal runs within the trailing 2,048 local records, with the success trigger eligible to refire after five newer qualifying runs. Run-level failed-cell repair includes effect-backed cells; when a `CellFailed` carries typed causality, repair-churn deduplication uses only its exact effect-outcome event IDs, including an explicit empty list, while retained failures that omit the field use the conservative legacy text heuristic. Terminal success is permission to reflect rather than outcome proof, and `no_change` is expected when the evidence supports no direct adaptation. The fifth success is considered at the next committed run boundary rather than at terminal commit. Session-wide status, history, and inspection join bounded reflection summaries, governed decisions/applications, typed scan failures, and proposal-level rollback because local learned content is effective across the session's branches; pending counts include only review-linked governance, and history has a 256 KiB serialized ceiling with explicit truncation. Owner rollback derives exact inverse actions for automatic create, replace, retire, and multi-edit proposals, validates the route before idempotent return, carries passing retained test evidence only across exact same-content skill restoration, terminally disables rolled-back skill creations, and accepts an origin proposal visible in a synchronized receiving branch lineage. Learning history is audit activity, not a human review queue. There is no separate learning spend budget, aggregate review-rate limit, scheduler, or semantic workflow grouping. Boundary scanning still loads complete branch history and the detector rejects more than 10,000 supplied records, so sufficiently large branches expose typed `scan_unavailable` instead of admitting automatic learning. Stale-memory and unproductive-delegation detectors remain unavailable.
- The interactive TUI is a full-screen OpenTUI client of the managed workspace service. It reconciles stable committed Markdown message blocks and syntax-aware fenced code, interleaves each compact run status after its initiating user task, animates active and queued run markers with braille frames, groups indented action rows with a dim vertical guide, and exposes retained TypeScript actions as syntax-colored one-line summaries with expandable full source that omits the presentation-only `Purpose:` label, dim stream-colored logs and returned stdout/stderr, bounded structured returned values, and errors; the canonical cell retains the exact submitted source. Expanded cell details appear in slightly indented, rounded panels. Inline logs, output, and returned values are independently limited to 12 lines and 800 characters; complete retained cell diagnostics remain available through `/cells` followed by `Shift-R`. During an active run, the latest committed action remains detailed while the next model action is pending and collapses when the next action opens; prior actions collapse automatically. The active run can be expanded to show all retained step details. A pending model response is represented by the active run header rather than a separate waiting row. `Ctrl-O` toggles the latest run between its default and fully expanded views, while `Ctrl-L` toggles all active and completed runs without changing the composer draft; inline shortcut hints are visually dimmed. A prompted multiline composer preserves pasted line breaks, uses `Shift-Enter` for new lines, submits with Enter, and grows within the responsive normal/compact/minimum height modes. A width-prioritized split footer preserves trusted-local authority and current actions without reserving idle inspector width. Contextual command, model, credential, provisional-output, notice, and family inspectors appear beside the conversation on wide terminals and replace it on narrow terminals. Snapshots, cursor-resumable committed SSE events, and cursorless progress remain distinct; a compact direct-child summary, responsive family browser, ancestry breadcrumb, and draft-safe Down/Enter/Right/Left navigation open exact retained parent and child branches without changing execution or workspace resume selection. Empty-composer Left from a top-level root and `/agents` open a full-screen workspace Agents selector backed by the typed product branch catalog. It groups retained root branches by exact status, searches visible fields, keeps failed and archived rows visible but non-resumable, creates and immediately opens a new root with Ctrl-N, refreshes only on open, explicit Ctrl-R, or successful selection, and opens resumable roots through exact product selection so later no-ID entry resumes the selected or newly created route. Family activity is route-derived, admitted children without active runs are idle, current projections are reused across refreshes, and periodic family refresh stops when the browser is closed and no child is actively working. Raw diagnostics remain available only through `Shift-R` or `/raw`, and non-TTY execution retains a readable plain transcript fallback.
- The TUI does not enable click or drag mouse reporting. Native text selection and clipboard copying remain available without terminal-specific overrides. On terminals that support Kitty key disambiguation and alternate-scroll mode, wheel and trackpad gestures scroll the active TUI view without taking over selection; other interaction remains keyboard-driven.
- Routine family polling does not expose its transient `refreshing` state in the TUI. Stale and unavailable family data remain visible.
- The family browser uses a highlighted selected card, dimmed activity-colored alternatives, and bounded single-line task and model metadata with ellipses instead of wrapped option blocks.
- Streaming-capable providers emit bounded cursorless progress before an atomic committed response; non-streaming providers truthfully report committed-only behavior. Real-provider streaming remains credential-gated.
- Unknown effects are retained and visible through startup/status plus `unknown` and evidence-only `reconcile` product flows. Reconciliation deliberately does not rewrite the unknown outcome or authorize automatic retry.
- The on-demand managed workspace service owns detached runs, managed background processes, schedules, and recovery behind the same authenticated loopback protocol, with process fencing and tested client detach/reattach. A quiescent service exits after one hour by default; active runs, effects, managed processes, wakes, schedules, heartbeats, resident workers, active console executions, and attached clients keep it alive and are reported by `service status`; idle console workers are retired at the final quiescence check, so a terminal blocked branch and its live REPL namespace do not become durable keep-alive identity. The exact normalized timeout remains part of the discovery configuration hash, so a live former one-minute owner produces `CONFIG_MISMATCH` rather than takeover by a new default client. Graceful shutdown stops admission, drains admitted protocol handlers and resident workers, sends TERM then KILL to owned process groups within bounded waits, records terminal or unknown outcomes, confirms no authenticated owned group remains, stops the console pool, and preserves sessions. The service is not an OS-login service and has no cross-device execution-owner failover.
- Managed service protocol revision 4 adds periodic branch-stream comment heartbeats and accompanies event schema 6. Revision-4 product clients may attach to still-running revision-2 or revision-3 services so already-admitted work can finish; the TUI follows a revision-2 service through cursor-pinned snapshot refresh instead of applying schema-5 events with the schema-6 reducer. Observe requires revision 4 because older services do not guarantee detectable stream liveness. Revision-2 and revision-3 clients cannot attach to revision-4 services, and other incompatible protocol ranges fail visibly.
- An immediate product reopen after authenticated graceful shutdown waits within the ordinary startup timeout for the draining owner to release its durable execution lease and discovery manifest. Startup never takes over while the prior lease remains authoritative, and unrelated authority conflicts still fail closed.
- Release acceptance invokes only an isolated `bun link` executable from fresh external repositories. Its guarded black-box matrix covers truthful missing-provider behavior, explicit fixture-model selection, searchable first-run provider/model selection, coding cells/tools, compact observations, bounded durable-state use, persistent exact-branch REPL bindings and deliberate reconstruction after worker or service loss, raw generation, awaited and detached typed child agents, durable family message queues, failed-gate repair, detach/client loss/service recovery, named head branch/resume/history/tree, distinct JSON run exits, post-commit crash recovery and unknown/no-retry reconciliation, refinement, installed skills, streaming, compaction, schedules, and governed profiles. Separate Observe black-box cases cover foreground source-checkout startup, ephemeral/explicit port behavior, fresh-workspace non-creation, signal shutdown, and checked-in asset loading through an isolated linked executable; all passed in the final audit. The installed learning journey proves that a fresh device profile admits repeated-success reflection without first enabling it. The governed-profile journey proves exact root and child profiles, old/new invocation pins, blocking approval, rejection, bounded reproposal, exact rollback, detached managed-service restart, deduplication, and no-ID inspection. The full-screen renderer has deterministic OpenTUI frame/input/resize coverage for Markdown, retained cells, bottom following, responsive layout, notices, inspectors, family navigation, and the searchable workspace root selector. The linked-executable pseudo-terminal journey begins with first-run provider search, hidden fixture credential entry, and fuzzy display-name model selection before it expands a retained TypeScript cell, opens retained child and grandchild routes, climbs back through the ancestry, creates a second root, selects the original root through the workspace Agents view, detaches, and resumes the remembered selection without internal IDs; the release matrix remains non-interactive. Deterministic selection, TTY, catalog, malformed-default, partial-persistence, admission, aggregate, installed acceptance-matrix, Observe linked-asset, and opt-in Observe browser verification passed for this revision. The real-provider, official Turso Sync, and Turso Cloud rows remain gated and unverified.

### Deliberately unavailable or deferred

- hostile-code isolation inside the Bun worker;
- authenticated multi-tenant HTTP service operation;
- distributed leases, task stealing, global budget reservation, and automatic execution-owner failover;
- PostgreSQL coordination;
- embedding-based semantic retrieval;
- automatic artifact replication and garbage collection;
- browser execution (the Observe web client is a viewing surface, not a browser executor or model tool);
- production Cloud administrative deletion through the installed Turso data client;
- dynamic cross-agent callable tools or durable versioned RPC resources beyond retained messages, artifacts, and the implemented family APIs;
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
# Optional after: bunx playwright install chromium
bun run test:acceptance:observe-web
```

The Observe Playwright command is opt-in and is not part of `bun run verify`. Missing Chromium must fail with installation guidance, and an unrun browser journey is unverified.

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
harness plus suite-capable RuneBench, Terminal-Bench 2, Terminal-Bench 2.1,
SWE-bench Pro public, and OOLONG tasksets. One shared deterministic selection contract
supports exact IDs, explicit ID lists, named smoke subsets, seeded samples,
stable shards, and all compatible tasks. Generated immutable catalogs retain
complete task coverage, typed incompatibility reasons, task/source/tree/image/
workdir/evaluator/lock pins, exact selected IDs and digests, and named smoke
sets. New treatments resolve the latest remote Agencity `main` through the
source-refresh command and then retain the resulting immutable commit across
the harness defaults, configs, and catalog treatment metadata. Suite task
images and the portable Bun executable remain explicitly `linux/amd64`; local
ARM Macs use Docker AMD64 emulation rather than changing the audited treatment.
RuneBench catalogs all 32 skill tasks in its pinned Harbor dataset against one
immutable game image and the official peak normalized XP-rate verifier. The
leaderboard-comparable full selection contains the 16 30-minute skills used by
the current public website, whose ranking is the mean of `ln(1 + peak XP/min)`
across those skills; the exhaustive local selection additionally includes all
16 15-minute variants. The committed default is serial because every task
receives an independent 8 GiB container. Suite preflight probes Docker daemon
memory, reserves 2 GiB for Docker/host overhead, rejects unsafe effective
concurrency, and reports an unavailable probe as unavailable; passing memory
does not prove CPU, provider quota, cleanup, or scoring health. Verifiers episode concurrency may
parallelize the 16-task selection only when host memory, CPU, provider quota,
cleanup, and scoring remain healthy. The
`agencity-runebench-repl-v1` treatment imports the image-owned TypeScript SDK
directly in Agencity's persistent Bun console instead of advertising generic
MCP support. Ordinary domain fields such as RuneBench's local
`password: "test"` connection option are valid model-generated TypeScript; only
exact values registered by the supervisor fail admission. It
raises the pinned package's 4 GiB
memory cap to 8 GiB, matching
the current upstream generator's hardening for documented agent OOM failures,
and retains both limits as treatment provenance. Every RuneBench run also sets
the console-worker RSS recycle threshold to 1.5 GiB while ordinary product and
other benchmark runs retain the 512 MiB default. Fresh and within-run learning
modes are separate and set the policy before the root run. Both pause automatic
learning; within-run additionally permits one evidence-backed explicit governed
review. Every scored task uses fresh Agencity and game state, so no learned
artifact crosses episodes.
Gold, collaboration, and cross-episode curriculum treatments remain unavailable,
and no full 16-skill leaderboard treatment is verified. One paid Luna-xhigh
Woodcutting 15-minute treatment on commit `1b2cebf` produced an official score
of 100 XP/min with successful scorer evidence, service shutdown, and cleanup,
but its agent terminal status was failed after the then-current 800,000
cumulative input-token bound stopped it at 43 model calls before a typed
`finish`. That RuneBench cumulative-token bound has since been removed in favor
of the official task horizon and 5,000-turn allowance. The run exposed
competing-controller, action-backoff, and tracker-path defects in the earlier
direct treatment. The current model-free treatment replaces the upstream MCP
prompt, stages one token-and-process-identity controller claim, requires bounded
backoff for false action results, gives the active tracker path explicitly,
reduces measured action batches into compact XP/failure summaries, retains the
latest strategy evidence in a replaceable durable working value, and keeps
transient loop data out of persistent REPL top-level bindings. Proven strategies
use fewer, longer bounded foreground loops; `sdk.processes` remains an optional
handoff when provider-call pauses materially prevent sustained training.
Successful `finish` is blocked unless the official tracker shows positive
scored-skill XP and a sample within the final 60 seconds or four sampling
intervals of the horizon. The gate script is treatment-staged and digest-pinned;
deadline expiry remains the normal `budget_exceeded` path when the agent trains
through the horizon. Benchmark cleanup removes
portable state only after owned-service shutdown confirms process cleanup;
shutdown and status carry the exact non-default console RSS configuration used
at service launch, and one monotonic 30-second deadline bounds the request and
all probes. An initial rejection from an already-draining service remains
observable while the matching service is polled for a confirmed stop;
unconfirmed shutdown retains lifecycle evidence and is an infrastructure error.
Treatment guidance is supplied once through root
repository instructions, identifies the high-level `bot` and low-level `rs`
receiver split with a compact translated SDK quick start, and distinguishes
three image-owned sources: the executable API contract, optional upstream
`rs-sdk` operational learnings, and factual skill/item/NPC/shop/quest wiki.
Learning and skill-guide filenames are indexed independently so a wiki page
cannot be mistaken for a missing learning. One discovery cell batches the
pinned API, exact available learning and skill guide, inventory, XP, and
bounded live state, then reduces them into an executable acquisition/action/
verification pipeline. Optional reads retain explicit read, absent, or
unavailable status without discarding successful sibling sources. Measured
loops accept only explicit `{ success: true }`, classify reported failure,
invalid results, and throws separately, distinguish command acceptance from
metric progress, and retain confirmed facts, rejected strategies, blockers,
and next hypotheses. A strategy retires after repeated zero progress, stalled official
peak, or excessive action failures unless a named assumption changes. Long
execution remains bounded by authoritative remaining time and reserves the
final gate window for tracker verification and typed completion.
A later
Luna-xhigh Attack 30-minute
treatment on commit `2d1b98f` reached a live peak of 72 XP/min but hit the outer
1,920-second timeout after 95 root model calls plus two refinement calls without
a typed `finish`; finalization and the official scorer never ran. A separate
service-authority cleanup conflict followed. The retained trace showed 16
opening turns before a working combat baseline, duplicate treatment prompting,
early automatic refinement, large completed-refinement context, growing
long-run overhead, and continued foreground action/model alternation. The
current working tree addresses the cleanup and prompt defects with model-free
tests. It also pins a durable absolute agent-run deadline to the actual game
start, reports authoritative elapsed and remaining time in each provider step,
interrupts admitted model and cell work at expiry, and returns
`budget_exceeded` through the normal JSON result path. Active run, cell,
context, and refinement paths reuse incremental branch history; automatic
trigger detection retains a bounded relevant-event frontier. Completed
recursive work enters later model context only as bounded digest-backed
summaries while complete evidence remains canonical. Both RuneBench learning
modes pause automatic triggers. Within-run mode permits one explicit review
that must cite a canonical compact evidence cell recorded after the treatment
checks a non-zero tracker rate, a running managed trainer, and a specific
failure or rate target. Core runtime enforcement covers evidence attribution
and the one-review limit; RuneBench-specific evidence interpretation remains
treatment behavior. An August 20 Luna-xhigh Attack treatment on commit
`161040cd62c78c606c7d09511bde90d779ae916a` established working combat by its
third cell and committed a successful typed `finish` at the 30-minute deadline
after 26 model calls and 25 cells. It reported 214,252 input and 21,049 output
tokens and a live peak of 38 XP/min, with no admitted refinement. Official
scoring did not run because the then-current task finalizer omitted RuneBench's
1.5 GiB console RSS threshold from service shutdown and status, producing
`CONFIG_MISMATCH`; its attempt-count cleanup loop also exceeded the nominal
30-second wait. The later harness passes that configuration through Harbor and
fallback cleanup and uses the monotonic deadline.
An August 20 serial Luna-xhigh Attack/Cooking/Crafting canary on commit
`290e01d4508487bc3f8dd7de2f38b7bda08c31ee` completed official scoring and
cleanup for all three tasks. Attack scored 48 XP/min; Cooking and Crafting
scored zero. Every run reached a semantic `budget_exceeded` outcome, while the
generic Verifiers process stop remained `agent_completed`. The trace exposed a
production 128-step ceiling that ended Cooking before the official horizon, a
combined learning/wiki filename lookup that failed Attack and Crafting
discovery, an upstream selector-overload mismatch, repeated command acceptance
without measured task progress, and provider-cache divergence caused by
rebuilding mutable run-step messages. The current working tree removes the implicit production step ceiling,
retains exact terminal reasons in benchmark metadata, separates knowledge
indices and source roles, strengthens measured strategy retirement and
deadline-aware completion guidance, and uses append-only provider transcript
segments with attributable compaction resets. These repairs have model-free coverage but no paid canary
verification.
A paid full run remains blocked on a passing exact 30-minute canary. An earlier paid Luna
canary completed 33 direct-REPL turns in one warm epoch without
credential-input or console-worker failure, but owned-service shutdown missed
the harness cleanup bound before the official scorer ran; that displayed zero
is an infrastructure error.
Terminal-Bench 2 and 2.1 each catalog 89/89 compatible official tasks and
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
suite configs route directly to OpenAI using `OPENAI_API_KEY`, use `xhigh`
reasoning, and retain a 128,000-token per-response ceiling. Terminal-Bench,
SWE-bench Pro, OOLONG, and smoke configs retain 800,000 input, 500,000 output,
and 1,000,000 total-token per-run ceilings; their turn bounds are at least 50,
with OOLONG at 64. RuneBench permits 5,000 Verifiers turns, Agencity has no
implicit production run-step ceiling, and cumulative token ceilings are omitted
because the official 15- or 30-minute horizon is the primary bound.
The enforced limits are permissive bounds rather than spend targets, are
checked between calls, and can overshoot by one admitted call. Catalog-backed
Terminal-Bench and SWE-bench Pro configs omit agent-level
rollout and scoring timeout overrides so each official task's declared limits
remain authoritative; suite preflight rejects either override. Configs use
native unprefixed OpenAI model IDs and omit unsupported temperature sampling;
the harness adds `openai/` only for Agencity's canonical model identity behind
the interception endpoint. Vercel AI Gateway remains an
explicit experimental route that changes the client endpoint, credential
variable, and wire model ID together and requires an exact canary. The bounded
eight-task Sol treatment uses four explicit IDs from each Yahoo context window. A
pinned-container fake-provider
test exercises the exact JSON product startup path with an initially missing
explicit state directory. Malformed launch results retain bounded scrubbed
stdout/stderr diagnostics instead of collapsing to a parser-only error. The
August 20, 2026 model-free verification of the RuneBench working tree passed
102 benchmark tests with one intentionally skipped unrelated opt-in SWE-bench
Pro scorer test and zero failures. The exact paid-canary preflight and dry-run,
package build, source compilation, and pinned `linux/amd64`
startup-to-configuration-matched-shutdown path passed through Docker emulation
on an ARM Mac. The repository-owned RuneBench canary command checks source pins
by default, refreshes every pin to remote `main` only when explicitly requested,
runs preflight and dry-run before inference, retains raw and summary artifacts,
and exits nonzero unless every exact selected task has one official numeric
score; valid official zeroes and scored agent terminal failures remain scored.
The August 18 verification against commit `e03a2ad`
separately passed the opt-in official scorer test, all 21 then-existing suite
preflights, all 22 then-existing config dry-runs, lock and source-pin checks,
and explicit AMD64 container startup.

Deterministic summaries separate passes, valid zeros, partial rewards, agent
terminal failures, provider failures, scorer/infrastructure errors,
cancellations, unknowns, and incompatibilities, and state the official-score
denominator. Taskset/scorer semantics are separated from harness-specific
installation and cleanup so a future Verifiers-compatible harness can use the
same selection and scorer. No second harness integration or matched comparison
is implemented.

Model-free suite validation is infrastructure evidence, not benchmark
performance. Paid evidence remains limited to three passing Terminal-Bench 2
`fix-git` treatments, two passing Terminal-Bench 2.1 `fix-git` treatments,
bounded OOLONG probes including one revised Sol-high Yahoo 128K pass and one
current-revision Sol-high zero, and one zero-score SWE-bench Pro qutebrowser
treatment that reached Agencity's token bound without a patch. The latest
Terminal-Bench 2 Sol-high pass used commit `3c2f4f6`, 8 model calls, 22,995
prompt tokens, 3,867 completion tokens, 16,492 cached input tokens, and about
125 seconds end to end through Vercel AI Gateway; Verifiers did not retain
provider billing metadata. The OOLONG zero
completed startup, execution, scoring, and cleanup on commit `5d533d1` but
returned `Society & Culture` instead of `Sports` after 19 Agencity steps, 20
provider calls, 90,951 prompt-plus-completion tokens, about four minutes, and
$0.89. A later Terminal-Bench 2 full-set attempt through Vercel AI Gateway was
operator-stopped after six completed tasks: one passed, five scored zero, three
reached the former 48,000-token bound, and one received Gateway's nonstandard
`finish_reason="error"` envelope. It is incomplete treatment evidence, not a
suite score. A later native OpenAI Sol-xhigh canary passed on commit `63b35ea`
in 6 model calls with 17,388 prompt tokens, 2,507 completion tokens, 12,170
cached input tokens, and about 81 seconds end to end. The native path uses the
unprefixed `gpt-5.6-sol` upstream ID while retaining Agencity's canonical
`openai/gpt-5.6-sol` identity behind interception. No paid full-suite, hosted,
or matched-harness result is verified. The latest Terminal-Bench 2.1 native
OpenAI Sol-xhigh canary passed on commit `63b35ea` in 6 model calls with 14,473
prompt tokens, 1,695 completion tokens, 14,604 cached input tokens, and about 75
seconds end to end. Large
unattended runs also remain limited by the absence of a public durable
cancellation/reconciliation receipt.

Report pass, fail, and skip counts separately. Never summarize a skipped real integration as verified.

## Architectural map

Primary source areas:

- `src/domain/` — domain types, immutable event schemas, reducers, validation, and shared semantics.
- `src/storage/` — storage contracts, local LibSQL implementation, migrations, and Turso exchange adapter boundary.
- `src/artifacts/` — artifact contracts and the local content-addressed store.
- `src/executors/` — typed effect executors for models, shell, files, skills, and related boundaries.
- `src/console/` — persistent exact-branch Bun REPL workers and supervisor-owned RPC interface.
- `src/runtime/` — supervisor and domain services: model loop, outbox, agents, goals, memory, refinement, recovery, sync integration.
- `src/product/` — workspace discovery, product catalog and selection, provider onboarding, managed-service discovery, and product lifecycle composition.
- `src/protocol/` — loopback HTTP/JSON, SSE, and typed client surfaces.
- `src/observe/` — foreground read-only browser server, narrow managed-protocol source, disposable family projections, bounds, generations, and checked-in native web assets.
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

Released event meanings are immutable. Before the first release, an architecture cutover may replace the accepted workspace schema and require local state reset instead of implementing compatibility. The current runtime accepts event schema version 6 only, uses reducer version 24, and rejects version-1/version-2/version-3/version-4/version-5 workspaces with reset guidance before migration, row decode, projection, sync ingestion, and recovery. This provider-transcript cutover is an explicit pre-release reset boundary. There is no general event-version registry or upcaster pipeline.

After release, changing event meaning requires explicit version acceptance, deterministic projection/upcasting, retained-history fixtures, protocol compatibility tests, and updated event documentation. Pre-release cutovers must still fail closed before projection and must never silently reinterpret an older workspace.

Never rewrite retained history as a migration shortcut.

### No hidden durable heap state

Console cells run in a persistent Bun TypeScript REPL dedicated to one exact session and branch. Top-level variables, functions, classes, imports, module instances, closures, and object identity persist while the worker lives, but the namespace is noncanonical and may be lost. Values required after recovery use the typed `state` API; larger content uses artifacts. Handles passed across restart boundaries must be JSON identities resolvable through durable services.

A console worker restart may discard the REPL namespace but must not change materialized durable state or task ownership.

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
- The shell and managed-process executors constrain their initial working directory but are not OS sandboxes. Managed-process ownership, process-group termination, and token-authenticated restart cleanup are lifecycle controls, not CPU, memory, network, syscall, or descendant isolation.
- Automatically loaded repository `AGENTS.md` files are untrusted model-facing behavioral guidance. They are bounded, source-attributed, and scrubbed for known brokered secrets, but they cannot grant runtime authority or become sealed refinement-review policy. Repository authors must not store secrets in them.
- The product-managed HTTP service is bearer-authenticated from an owner-only discovery manifest and binds to loopback. The advanced embedded diagnostic server is unauthenticated and must remain on loopback unless protected by an external boundary.
- The Observe server binds to exact loopback Host/origin semantics, exchanges a process-lifetime fragment bootstrap for an HttpOnly SameSite cookie, keeps the managed bearer server-side, has no CORS or generic proxy, serves only bounded DTOs, and renders agent strings as sensitive inert text. These browser controls do not make the trusted-local runtime a sandbox or multi-tenant service.
- Read-only SQL is a shared diagnostic surface, not a confidentiality boundary between candidates or workspaces.
- Scope filtering controls behavior and context selection; it must not be described as protection against hostile local SQL/code.

Provider credentials remain supervisor-side. Preserve removal of explicit runtime-private environment variables, exact registered-value rejection/redaction, non-login shell behavior, and structurally valid opaque credential references. Do not infer secrets from property names, assignments, provider-like prefixes, PEM/Bearer/JWT shapes, or URL query-key names. Never intentionally put raw credentials into events, logs, artifacts, profile metadata, sync envelopes, test fixtures committed to Git, or error messages.

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

## CLI and client direction

The no-ID product entrypoint and compatible raw diagnostic CLI are both implemented. Remaining product interface work must preserve this direction:

- `agencity` creates or resumes and opens the product directly;
- users should not copy session or branch IDs for normal operation;
- product selection must exclude internal deterministic test providers;
- provider setup must not require dropping to HTTP or TypeScript APIs;
- the TUI should project the public client/event contract;
- `agencity observe` should remain a foreground read-only viewing client, dispatch before writable product bootstrap, preserve one process-wide family selection, and never become service or durable identity;
- browser observation must remain distinct from unavailable browser execution and from any future privileged control surface;
- a task should drive a typed, recoverable model-to-TypeScript/tool action loop rather than only one chat response;
- internal IDs and low-level cell/history/rebuild operations remain available as advanced diagnostics.

Do not paper over the missing autonomous loop by heuristically executing arbitrary assistant prose. Model actions must be typed, versioned, validated, attributed, budgeted, and durably recorded before dependent work.

## Testing expectations

Choose the narrowest relevant test during iteration, then run the full gates before claiming completion.

For changes to:

- reducers/events: add unit replay, duplicate, invalid-transition, and rebuild tests;
- storage/migrations: add reopen, idempotency, physical-constraint, and architecture checks;
- effects/recovery: test crash boundaries before request, after request, during execution, and after committed outcome; managed processes additionally require queued cancellation, false-result/log scrubbing, worker loss, run cancellation, token-authenticated restart, process-group TERM/KILL, and confirmed service-shutdown coverage;
- console RPC: test worker restart, stdout isolation, secret handling, and failed-cell atomicity;
- recursive agents: test restart, cancellation trees, task budgets, mailbox authorization, and terminal delivery;
- memory/refinement: test scope, provenance, deterministic validation, proposer/reviewer separation, standing authority, skill tests, activation conflicts, terminal delivery, outcome evidence, and rollback;
- sync: test offline writes, reconnect, concurrent writers, corruption/quarantine, conflicts, restart, and unsupported capabilities;
- protocol/TUI: test snapshot-then-stream races, cursor resume, duplicate delivery, typed errors, and no repeated effects;
- Observe: test strict CLI admission and port behavior, non-creating discovery, revision/capability classification, route/detail/byte bounds, generation rejection, event deduplication, progress cleanup, replay/queue overflow, stream heartbeats, service replacement, attachment/quiescence release, exact Host/fetch metadata/origin/CSP/no-CORS enforcement, inert hostile strings, absence of managed credentials/full state/artifact bytes, source-checkout signal shutdown, and linked-module asset resolution. The optional Playwright journey verifies browser rendering and interaction but is not a substitute for required non-browser coverage;
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

- No real provider is configured. The product CLI (`agencity` / `bun run dev`) refuses non-interactive autonomous runs without a usable OpenAI/Anthropic/Gateway credential, and Echo is filtered from product selection, so `agencity --model echo:...` is not a runtime fallback. To exercise a real end-to-end task through the installed CLI without external secrets, drive it against the loopback OpenAI Responses-compatible fixture in `test/acceptance/strict-action-fixture.ts` together with `AcceptanceWorld` from `test/acceptance/helpers.ts` (the acceptance tests are the reference pattern: `config set-model openai:openai/fixture-v1` with `fixture.environment()`, then `run --json`).
- `bun run test:unit` and `bun run test:integration` use `--parallel=4` with the default 5000 ms per-test timeout. On this shared VM, heavier integration tests (`product-cli`, `refiner`, `skill-management`) and some OpenTUI frame-render unit tests intermittently hit that 5000 ms limit under CPU pressure; they pass when run with `--timeout 30000` or in isolation. The canonical `bun run verify` / `test:core` gate already uses `--timeout 30000`, so prefer it for a trustworthy result.
- One OpenTUI unit test in `test/unit/opentui.test.ts` ("renders a stable workspace, preserves input during protocol updates, responds to resize, and detaches") consistently times out on the native frame-render predicate in this headless VM even in isolation; the frame content does render and the remaining OpenTUI cases plus the `test/e2e/opentui-pty.test.ts` pseudo-terminal journey pass. Treat this single case as a headless native-renderer limitation, not a regression.
- The `profile-governance` acceptance test can fail at `history current --json` with a JSON "Unterminated string": that command emits a large (~475 KB) document and the CLI process may exit before the piped stdout is fully drained. This is a large-output flush behavior, not an environment/setup problem.

# Implementation plans

This directory contains Agencity's durable implementation plans. `AGENTS.md` is the canonical product and repository guide; plans specify scoped architecture and delivery work beneath it.

## Plan index

- [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md) — parent product and architecture PRD.
- [Prime Agent TypeScript/Turso rewrite follow-up plan](./2026-08-06-prime-agent-typescript-turso-rewrite-follow-up-plan.md) — FU-001–FU-019 implementation backlog and evidence.
- [Lossless context-reference storage plan](./2026-08-07-lossless-context-references-plan.md) — deferred context-storage proposal requiring a new readiness review.
- [Ergonomic agent-family navigation plan](./2026-08-07-ergonomic-agent-family-navigation-plan.md) — add a persistent child summary and keyboard parent/child navigation to the protocol-backed TUI.
- [Workspace Agents view plan](./2026-08-08-workspace-agents-view-plan.md) — add a full-screen root-session selector reached by pressing Left once more from a top-level conversation.
- [Durable agent profiles and automated refinement review plan](./2026-08-08-adaptive-agent-city-plan.md) — implemented durable per-session profiles, sealed automatic refinement governance, terminal controls, lifecycle hardening, linked-executable acceptance, and deterministic aggregate verification; organization control-plane features remain deferred.
- [Agent context and observation efficiency plan](./2026-08-09-agent-context-efficiency-plan.md) — reduce provider input through exact provider-input candidates, selective observations, explicit effect ownership, and bounded recoverable output.
- [Prime Verifiers suite benchmarking plan](./2026-08-10-prime-verifiers-benchmarking-plan.md) — catalog-backed deterministic suite selection for Terminal-Bench 2, Terminal-Bench 2.1, SWE-bench Pro public, and OOLONG, with immutable provenance, split scorer isolation, mixed-outcome reporting, and matched-harness methodology; paid full-suite, hosted, and comparison results remain unverified.
- [Durable tenacious goal orchestration plan](./2026-08-09-tenacious-goal-orchestration-plan.md) — add bounded cross-run goal episodes, exact continuation context, child-work quiescence, and optional sealed semantic completion review on one durable session branch.
- [Dynamic typed connectors and managed RPC resources plan](./2026-08-09-dynamic-typed-connectors-plan.md) — proposed and gated architecture for immutable typed external-capability contracts, managed sidecars, runtime validation, and durable RPC resource identities.
- [Agent environments and service interfaces architecture plan](./2026-08-11-agent-environments-and-service-interfaces-plan.md) — first rough draft for durable agent-owned compute environments, discoverable peer RPC, scale-to-zero placement, private services, and later explicit hosted application ingress.
- [Best-effort TypeScript console scratch plan](./2026-08-10-best-effort-console-scratch-plan.md) — add branch-scoped warm scratch, bounded local checkpoint restoration, clear model storage guidance, and a one-hour managed-service idle default.
- [Default automatic adaptive learning plan](./2026-08-11-default-automatic-adaptive-learning-plan.md) — implemented default-on device-profile learning, persistent device-wide pause/resume, bounded local triggers including repeated success, and audit-oriented learning history; deterministic aggregate verification passed.
- [Explicit AI generation and typed agent runs plan](./2026-08-11-explicit-ai-generation-and-typed-agent-runs-plan.md) — implemented context-only `ai.generateText`/`ai.generateObject`, awaited text or object-returning full agent runs, detached-running agent handles, shared model selection, and branch-aware nested console capacity; dynamic cross-agent RPC remains a separate unavailable capability.
- [First-run provider and model typeahead plan](./2026-08-10-first-run-provider-model-typeahead-plan.md) — replace numbered and exact-ID setup prompts with a shared fuzzy provider/model selector backed by the public model catalog.
- [Rich terminal rendering and layout plan](./2026-08-07-rich-terminal-rendering-and-layout-plan.md) — add structured Markdown and cell rendering, syntax color, a corrected bottom dock, and contextual inspector sizing.
- [Reasoning effort and model capabilities plan](./2026-08-07-reasoning-effort-and-model-capabilities-plan.md) — implemented durable effort selection, shared model transports, model-specific capability discovery, and terminal controls.
- [Formal model tool contracts plan](./2026-08-07-formal-model-tool-contracts-plan.md) — replace assistant-text JSON actions with required `bun_console` and `finish` tools plus formal contracts for other structured model results.

New implementation plans belong here rather than at the repository root. Keep links relative to their destination and update this index when adding, renaming, or retiring a plan.

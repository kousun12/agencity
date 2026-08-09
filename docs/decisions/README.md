# Architecture decision records

This directory records durable architecture choices that constrain future implementation. Each architecture decision record (ADR) explains the problem, the chosen rule, its consequences, and the alternatives or limitations that matter when changing the system.

## Decision index

| Number | Decision | Date | Status | Scope | Supersession and extension |
|---|---|---|---|---|---|
| [0001](./0001-durable-local-runtime-foundations.md) | Durable local runtime foundations | 2026-08-05 | Accepted | Canonical local state, disposable execution, effects, artifacts, mutation, and trust boundary | Foundational; extended by [0002](./0002-relational-memory-refinement.md), [0003](./0003-turso-envelope-sync.md), [0004](./0004-event-evolution-and-context-references.md), [0005](./0005-typed-autonomous-actions.md), [0006](./0006-durable-agent-relationships.md), [0007](./0007-managed-workspace-execution.md), [0008](./0008-profile-workspace-and-credentials.md), [0009](./0009-owned-data-deletion.md), [0010](./0010-formal-model-tool-contracts.md), and [0011](./0011-capability-preserving-placement-contracts.md) |
| [0002](./0002-relational-memory-refinement.md) | Event-sourced relational memory and measured refinement | 2026-08-06 | Superseded in part | Memory retrieval, harness versions, evaluation, promotion, and rollback | Extends [0001](./0001-durable-local-runtime-foundations.md); pre-activation exposure and promotion rules are superseded by [0012](./0012-durable-agent-profiles-automated-refinement-governance.md); all other decisions remain in force |
| [0003](./0003-turso-envelope-sync.md) | Immutable envelope exchange through Turso Sync | 2026-08-07 | Accepted | Optional offline-first relational synchronization | Extends [0001](./0001-durable-local-runtime-foundations.md); not superseded |
| [0004](./0004-event-evolution-and-context-references.md) | Event evolution and lossless context references | 2026-08-07 | Deferred | Referenced context storage under one uniform pre-release schema | Context exactness goals remain open; mixed-version assumptions are superseded by [0010](./0010-formal-model-tool-contracts.md) |
| [0005](./0005-typed-autonomous-actions.md) | Typed autonomous actions | 2026-08-07 | Superseded | Model action protocol and executable action boundary | Superseded by [0010](./0010-formal-model-tool-contracts.md) |
| [0006](./0006-durable-agent-relationships.md) | Durable agent relationships | 2026-08-07 | Accepted | Root agents, delegated agents, recursive calls, tasks, and mailboxes | Extends [0001](./0001-durable-local-runtime-foundations.md); extended by [0012](./0012-durable-agent-profiles-automated-refinement-governance.md) |
| [0007](./0007-managed-workspace-execution.md) | Managed workspace execution | 2026-08-07 | Accepted | Detached advancement, authenticated loopback access, leases, and fencing | Extends [0001](./0001-durable-local-runtime-foundations.md); not superseded |
| [0008](./0008-profile-workspace-and-credentials.md) | Profile, workspace, and credential boundaries | 2026-08-07 | Accepted | Durable identity, ownership, preferences, model selection, and secrets | Extends [0001](./0001-durable-local-runtime-foundations.md); extended by [0012](./0012-durable-agent-profiles-automated-refinement-governance.md) |
| [0009](./0009-owned-data-deletion.md) | Guarded owned-data deletion | 2026-08-07 | Accepted | Physical deletion across relational, artifact, credential, and replica stores | Extends [0001](./0001-durable-local-runtime-foundations.md); not superseded |
| [0010](./0010-formal-model-tool-contracts.md) | Formal model tool contracts | 2026-08-08 | Accepted | Provider-native action transport, two-tool run control, and pre-release cutover policy | Extends [0001](./0001-durable-local-runtime-foundations.md); supersedes [0005](./0005-typed-autonomous-actions.md) |
| [0011](./0011-capability-preserving-placement-contracts.md) | Capability-preserving placement contracts | 2026-08-09 | Accepted | Replaceable relational, artifact, retrieval, and execution placement | Extends [0001](./0001-durable-local-runtime-foundations.md); not superseded |
| [0012](./0012-durable-agent-profiles-automated-refinement-governance.md) | Durable agent profiles and automated refinement governance | 2026-08-09 | Accepted | Per-session behavioral identity, prompt provenance, and automatic behavioral-refinement review and activation | Supersedes part of [0002](./0002-relational-memory-refinement.md); extends [0006](./0006-durable-agent-relationships.md) and [0008](./0008-profile-workspace-and-credentials.md) |

ADR 0010 supersedes ADR 0005. ADR 0012 supersedes only ADR 0002's mandatory pre-activation exposure path and promotion rules; ADR 0002's unaffected decisions remain in force. When another decision changes, add a new ADR, mark the earlier record `Superseded` or `Superseded in part` according to the scope of the replacement, and link both records in this index and in their metadata.

## What belongs in an ADR

Use an ADR for a durable choice that:

- establishes or changes a system boundary, source of truth, authority rule, compatibility contract, or safety invariant;
- selects one architecture among meaningful alternatives;
- constrains multiple implementation areas or future changes; and
- needs its reasoning and consequences preserved after the implementation changes.

An ADR describes the stable decision, not a work schedule. It may identify implemented limitations, but it should not become a rolling feature-status checklist.

Use an implementation plan for sequencing, file-level work, rollout gates, migrations, benchmarks, or acceptance tasks needed to realize a decision. Use a reference document for current APIs, commands, schemas, operational procedures, security guidance, or verification evidence. Plans and references may change as implementation changes; an accepted ADR changes only through a superseding decision.

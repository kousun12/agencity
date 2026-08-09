# ADR 0006: Durable agent relationships

- **Status:** Accepted
- **Date:** 2026-08-07
- **Scope:** Root agents, delegated agents, recursive model calls, tasks, and mailboxes
- **Extends:** [ADR 0001](./0001-durable-local-runtime-foundations.md)
- **Extended by:** [ADR 0012](./0012-durable-agent-profiles-automated-refinement-governance.md), which adds durable per-session behavioral profiles without changing relationship boundaries

## Context

Delegated work and recursive model calls can outlive the cell or process that starts them. Returning an anonymous string from an in-memory helper would lose task ownership, budget attribution, cancellation state, provenance, and the ability to resume or follow up. Separate root-agent, subagent, and recursive-call runtimes would also create inconsistent recovery and authority rules.

## Decision

Root agents, delegated subagents, and isolated recursive model calls use the same durable `Session` model and canonical event stream. A child session records its parent session and branch, root session, depth, and owning task. A `Task` records why the child exists, its lifecycle, completion requirements, and budget relationship.

Child admission validates ancestry, model policy, child limits, budget reservations, and stable idempotency in one transaction. Batch admission is all-or-nothing. Child limits cannot widen parent limits, and terminal usage is attributed to ancestors exactly once. Unknown usage consumes unresolved reservations conservatively.

Parent and child sessions communicate through durable mailboxes. Sends, recipient delivery, acknowledgements, and task terminal notices are retained across the relevant session streams. Messaging is limited to authorized relationships within one root family. Cancellation propagates through admitted descendants and recovery completes any committed cancellation or delivery prefix.

Recursive model execution creates a normal task and child session and uses the same provider engine, outbox, model configuration, concurrency controls, budgets, and recovery rules. Durable recursive handles contain JSON identity, not a live object dependency. A later cell or replacement console worker resolves the same handle. Oversized results use registered content-addressed artifacts.

Retained children support bounded follow-up in the same session after terminal work. Delegation results remain inspectable as relationships and history rather than collapsing into an unstructured returned string.

## Consequences

- Child work survives console, supervisor, and terminal loss.
- Delegation, recursive calls, direct messages, acknowledgements, cancellation, usage, and results remain attributable.
- One family model enforces consistent ancestry, ownership, budget, and recovery semantics.
- Durable admission and mailbox records add state and coordination overhead.
- A parent can detach and later inspect or continue a retained child without recreating it.
- Recursive calls are not a bypass around provider limits, model policy, effect recovery, or task budgets.

## Rejected alternatives and limitations

1. **Return subagent work as an anonymous string.** Rejected because the relationship, task, budget, provenance, and follow-up path would disappear.
2. **Keep child handles only in the console heap.** Rejected because a worker restart would lose identity or duplicate admission.
3. **Create a separate recursive-provider engine.** Rejected because it would bypass shared outbox, concurrency, budget, and recovery rules.
4. **Allow arbitrary cross-session messaging.** Rejected because durable task ownership and root-family authority define the communication boundary.
5. **Permit children to widen model or budget authority.** Rejected because delegation cannot expand the parent's authority.

The implementation does not provide distributed task stealing, global budget reservation, or automatic execution-owner failover. Durable relationships are retained runtime state, not a multi-tenant authorization boundary.

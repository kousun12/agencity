# ADR 0002: Event-sourced relational memory and measured refinement

- **Status:** Accepted
- **Date:** 2026-08-06
- **Scope:** Relational memory, harness versions, candidate evaluation, promotion, and rollback
- **Extends:** [ADR 0001](./0001-durable-local-runtime-foundations.md)

## Context

Agencity can adapt memory, prompt notes, generated TypeScript skills, and reusable subagent roles from retained experience. Adaptation must not make an FTS index, generated process, or persuasive self-reflection into durable authority. Candidate behavior must be measurable, bounded, attributable, reversible, and scope-sensitive. Active behavior must remain stable while a replacement candidate is evaluated.

## Decision

1. Stable harness entries and immutable content versions are canonical `Harness*` events. `harness_entries` maintains separate latest and active pointers; all tables remain rebuildable projections.
2. FTS5 supplies candidates only. Scope, status, tags, recency, and explicit links are authoritative deterministic filters. `ContextMaterialized` stores the complete query/candidate/rejection/selection trace and exact selected versions.
3. The immutable base policy is not a harness entry. It has a frozen runtime ID/version/digest and is serialized separately.
4. Refinement is propose → validate/CAS → bounded candidate allocation/exposure → observation → promote/revise/reject, with post-promotion rollback. Candidate allocation and actual context exposure are different canonical events.
5. Local promotion needs one supported success. Workspace promotion needs repeated objective success in distinct allocations; its evidence must postdate each allocation's durable exposure and match the predeclared evaluator contract. User/global promotion needs explicit named approval. Decisions retain evaluator, baseline, observations, and rule.
6. Generated Bun skills must declare runtime tests. Compilation, tests, and invocation run in a disposable Bun subprocess behind the durable outbox and pin immutable source version IDs. This is lifecycle isolation under trusted-local authority, not a security sandbox.
7. A subagent spec invocation extends normal atomic admission and pins the exact version to the resulting task/session. Existing ancestry, budget, model, cancellation, and idempotency rules are unchanged.

## Consequences

- Projection corruption or index deletion is repaired by canonical replay/index rebuild without changing identity.
- Candidate replacements do not displace the active version for unallocated sessions.
- Retrieval investigations can reproduce both what entered context and why other candidates did not.
- Workspace promotion intentionally takes more than one exposure even when a proposal is convincing.
- User/global preferences cannot silently emerge from agent observations.
- Compile/test effects add latency but make executable self-modification observable and recoverable.
- Cloud synchronization may later relocate user/global projections without changing scope, authority, version, or context-provenance semantics.

## Rejected alternatives and limitations

1. **Treat FTS rank as authority.** Rejected because search rank does not establish scope, status, policy, or permission.
2. **Replace an active version when a candidate is proposed.** Rejected because evaluation requires a stable control and explicit allocation.
3. **Promote from the model's explanation alone.** Rejected because a claim about improvement is not attributable outcome evidence.
4. **Infer user or global preferences from local observations.** Rejected because broader authority requires explicit named approval.
5. **Run generated skills outside the outbox.** Rejected because compilation, tests, invocation, and recovery must remain attributable.

FTS5 is candidate retrieval rather than semantic proof. Generated skills execute with trusted-local operating-system authority; their disposable process is not a security sandbox. Automatic refinement is limited to implemented typed triggers and does not imply that every repeated success, stale memory, or unproductive delegation is detected.

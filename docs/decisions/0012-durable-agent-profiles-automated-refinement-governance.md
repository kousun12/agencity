# ADR 0012: Durable agent profiles and automated refinement governance

- **Status:** Accepted
- **Date:** 2026-08-09
- **Scope:** Durable per-session behavior, invocation prompt provenance, and behavioral refinement governance
- **Supersedes in part:** [ADR 0002](./0002-relational-memory-refinement.md), specifically the pre-activation exposure and promotion rules in Decision items 4 and 5
- **Extends:** [ADR 0006](./0006-durable-agent-relationships.md) and [ADR 0008](./0008-profile-workspace-and-credentials.md)

## Context

Agencity retains sessions, tasks, model configuration, messages, and harness artifacts, but a runnable session does not have one required, immutable record of its standing purpose and agent-specific instructions. Task text, prompt notes, and subagent specifications cannot fill that role: they have different lifecycles and do not establish the exact behavioral identity used by every invocation.

ADR 0002 requires pre-activation candidate allocation, exposure, and observed success, with named human approval at user and global scopes. That model supports empirical comparison, but it makes prior outcome evidence the normal activation authority even when a proposal can first be checked deterministically and reviewed independently against a sealed charter. Agencity needs a uniform behavioral-refinement path that remains attributable, bounded, reversible, and subject to standing user authority without requiring a person to approve each proposal.

## Decision

### Durable session profiles

`Session` remains the only executable agent identity. Every runnable root, delegated child, and recursive-model session has one active immutable agent-profile version containing:

- a concise role;
- its standing purpose;
- agent-specific behavioral instructions;
- the exact rendered agent prompt, rendering-contract version, and digest; and
- its creator, source, reason, evidence, supersession, proposal, review, and rollback provenance.

The initial profile is committed atomically with runnable session admission. Later profile versions and the active profile pointer are session-wide workspace canonical state, not conversation-branch state. Branches retain counterfactual conversation history; they do not fork agent identity or silently diverge a profile.

Every autonomous run and recursive-model invocation pins its active profile version before model work begins. All model calls within that invocation retain the profile pin, effective-system-prompt digest, and immutable component references. A profile activation affects only later invocations.

An agent profile is behavioral instruction, not runtime authority. It cannot change provider or model selection, credentials, budgets, SDK operations, effect policy, completion gates, operating-system authority, or immutable safety policy.

### Automated refinement governance

Agent profiles, memories, prompt notes, skills, and subagent specifications use one ordinary governance path:

1. An authorized proposer records an immutable typed proposal with the exact target, expected active version, replacement content, reason, predicted effect, scope, and attributable evidence.
2. Deterministic validation checks schema and size bounds, target scope, proposer authority, known secrets, immutable-policy boundaries, compatibility, rendering, and compare-and-swap state.
3. A valid proposal is evaluated by one separate sealed reviewer invocation against frozen, digest-addressed inputs: the proposal, current target, evidence, proposer relationship, product constitution, refinement policy, configured workspace charter and user constraints, target scope, and runtime boundaries.
4. The reviewer returns exactly one typed `approve` or `reject` decision. It cannot edit the proposal, select another target, widen authority, waive validation, delegate its decision, or activate content.
5. Approval triggers application-time validation. If it still passes, one atomic transition records the approval, creates the immutable version, and activates it for future invocations.
6. Deterministic rejection, reviewer rejection, malformed output, failure, timeout, unknown outcome, stale state, or application conflict activates nothing. The exact terminal result is returned or durably delivered to the proposer.

Ordinary behavioral refinements do not require per-proposal human approval. User authority is expressed through immutable product policy, owner-controlled workspace policy, declared constraints, scope, target-specific proposal authority, and typed runtime validation. Standing policy may make a target or scope unavailable to automated refinement; the reviewer cannot override that boundary.

An agent may propose changes to itself, an active creation-family parent may propose changes to a direct child, the workspace owner may propose changes within the workspace, and an automatic refiner may act only within its configured target scope. Proposal authority does not grant activation authority. Siblings and unrelated sessions cannot revise one another.

Rejected proposals are terminal and immutable. A revised attempt is a new proposal that references the rejection, changes content or evidence, and obeys a strict attempt bound. Reviewer approval establishes charter compliance, not empirical improvement. Later attributable outcomes remain evaluation evidence and may support another proposal or rollback.

Generated skills must compile and pass their declared runtime tests before activation. Reviewer approval cannot waive executable validation. Rollback restores the exact content of an earlier approved version through a new immutable version and activation; modified content is a new proposal and requires review.

### Exact supersession of ADR 0002

This decision supersedes only these parts of ADR 0002:

- in Decision item 4, the requirement that bounded candidate allocation and exposure followed by observation are mandatory preconditions in the ordinary path to activation; and
- Decision item 5 in full: one supported success for local promotion, repeated objective successes in distinct allocations for workspace promotion, and explicit named approval for user/global promotion.

Those rules are replaced by deterministic validation, one sealed independent review, application-time revalidation, and automatic activation of an approved immutable version. Candidate/control allocation, exposure tracking, and post-activation outcome evaluation remain valid attributable evaluation mechanisms, but they are not mandatory activation authority.

The following ADR 0002 decisions remain in force:

- canonical immutable harness versions and separate latest and active pointers;
- FTS5 as candidate generation only, with deterministic scope and status filters;
- complete retrieval, rejection, selection, and exact-version provenance in materialized context;
- the immutable base policy as a separately versioned runtime component rather than a harness entry;
- immutable proposals, validation, compare-and-swap protection, version attribution, conflicts, and post-activation rollback;
- distinct allocation and actual-exposure events whenever candidate evaluation uses allocation;
- mandatory generated-skill compilation and declared runtime tests through the durable outbox under trusted-local authority; and
- exact subagent-specification pinning through normal atomic child admission without changing ancestry, budget, model, cancellation, or idempotency rules.

### Relationship and ownership boundaries

This decision extends ADR 0006 by attaching immutable standing behavior and prompt provenance to its existing durable `Session`. It does not add an `Agent` aggregate above `Session`, cross-family assignment, arbitrary messaging, a coordinator, a specialist directory, or changes to tasks, ancestry, mailboxes, budgets, cancellation, and recovery.

This decision extends ADR 0008 by naming session-owned workspace state `agentProfile` and profile/device-store state `userProfile` when both appear in one contract. Agent profiles live in workspace canonical state. The separate `ProfileStore` continues to own device identity, cross-workspace preferences and catalog entries, globally installed skills, provider configuration, and opaque credential references. Raw credential values remain outside both forms of profile state and all retained review inputs.

## Consequences

- A model invocation can be traced to the exact standing instructions that governed it.
- Behavioral refinements can activate without a per-proposal human queue while retaining proposer/reviewer separation, standing authority, deterministic checks, exact decisions, conflict handling, and rollback.
- Review adds model cost and latency and can fail or become unknown; no such outcome implies approval.
- Reviewer agreement does not prove improved behavior. Post-activation evidence and rollback remain necessary controls.
- Session admission, profile activation, review recovery, terminal delivery, export, synchronization, and deletion must preserve complete profile and decision provenance.
- The runtime remains trusted-local. Sealed prompts and typed contracts are governance controls, not hostile-code isolation.

## Rejected alternatives and limitations

1. **Use task text, prompt notes, or subagent specifications as the agent profile.** Rejected because finite work, dynamic harness context, reusable templates, and standing identity have different ownership and versioning.
2. **Let the proposer activate its own content.** Rejected because proposal and approval are separate authority roles.
3. **Require a person to approve every behavioral change.** Rejected because standing policy, deterministic validation, sealed independent review, exact provenance, and rollback provide the ordinary control model.
4. **Treat reviewer approval as outcome evidence.** Rejected because charter consistency does not establish empirical improvement.
5. **Let profile text grant runtime capabilities.** Rejected because prose cannot widen typed authority or the trusted-local process boundary.
6. **Add routing, assignment, or management hierarchy with profiles.** Rejected because durable purpose does not require an organization control plane.

This decision is accepted architecture, but durable agent profiles and this automated governance path are not implemented runtime capabilities as of the decision date. Existing refinement behavior remains the shipped behavior until implementation and installed-product verification demonstrate the new contract.

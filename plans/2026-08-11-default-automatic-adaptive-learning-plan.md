# Default automatic adaptive learning plan

**Status:** Implemented  
**Date:** August 11, 2026  
**Last revised:** August 11, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related plan:** [Durable agent profiles and automated refinement review](./2026-08-08-adaptive-agent-city-plan.md)  
**Related decisions:** [Event-sourced relational memory and measured refinement](../docs/decisions/0002-relational-memory-refinement.md) and [Durable agent profiles and automated refinement governance](../docs/decisions/0012-durable-agent-profiles-automated-refinement-governance.md)

## Summary

Agencity already retains experience, retrieves learned state into later model calls, runs bounded trajectory refinement, applies approved behavioral changes, and preserves exact review and rollback history. Automatic refinement exists, but it is disabled by default and its implemented triggers are limited to failures and explicit typed corrections.

This plan makes automatic local refinement the default product behavior without adding a second adaptation architecture.

The implementation will:

1. enable the existing automatic refinement policy by default for device profiles that have no explicit preference;
2. preserve `refine auto off` as an explicit persistent pause;
3. continue using one exact trigger key, evidence cursor, and nonterminal key per detector;
4. admit at most one new automatic reflection per trigger-scan attempt;
5. add one deliberately coarse positive trigger after a bounded number of successful runs, without attempting semantic workflow clustering;
6. keep every automatic change local, independently sealed-reviewed, attributable, and reversible through the existing governance path;
7. present existing refinement and governance history as the ordinary learning log;
8. keep broader scope, agent-profile changes, connectors, runtime authority, and organization-level behavior outside automatic learning.

The plan does not add a generalized learning-episode model. Trigger detectors do not need to determine whether several events belong to one semantic activity. Each detector uses an exact identity that can be computed from retained typed events. A refiner may return `no_change` when a coarse trigger does not contain a useful lesson.

The plan also does not add a new versioned learning-policy aggregate, migration, durable scheduling queue, or memory backend. Existing policy constants, profile preference overrides, canonical trigger consumption, detached review recovery, governed proposals, and rollback are sufficient for this stage.

## Product decision

Adaptive learning is on by default, local by default, and quiet unless retained evidence crosses a concrete threshold.

This initial default does not introduce a separate automatic-learning spend budget, hourly review quota, or budget-isolation mechanism. Automatic refiner and reviewer children continue to use the existing recursive-child budget and provider-concurrency rules. Their usage is ordinary attributable tree usage and may reduce the budget available to later parent work. If the parent has no configured budget limit, automatic learning has no separate learning-only spend cap. A dedicated learning budget is deferred until real usage establishes that the framework and its trigger quality justify another control surface.

Automatic learning has two separate decisions:

- **whether reflection is warranted:** deterministic trigger code decides from typed retained events;
- **whether behavior should change:** the existing refiner proposes a change, deterministic validation checks it, and the separate sealed governance reviewer approves or rejects it.

A detected trigger does not imply a behavioral change. `no_change` is an expected and useful terminal result.

Ordinary automatic refinement does not create a human review queue. Users inspect a learning log and may pause, resume, or roll back learning. Sensitive changes remain outside the automatic path and continue to require explicit manual action through existing governed interfaces.

The initial automatic content scope remains one session:

- automatic proposals use `local` scope;
- they cannot revise an agent profile;
- they cannot promote content to workspace, user, or global scope;
- they cannot alter provider selection, credentials, budgets, effect policy, permissions, connectors, operating-system authority, or immutable product policy.

Local skills remain governed by the current sealed review, compile, and declared-test requirements. The runtime remains trusted-local: skill validation is a behavioral governance control, not an OS sandbox.

## Current implementation

The following behavior is already implemented and will be reused.

### Automatic trigger detector

`src/runtime/refinement-triggers.ts` provides a pure, bounded, deterministic detector.

Its default policy is:

- automatic refinement disabled;
- local scope only;
- three matching failed effects within the trailing 128 local records;
- three failed cells in one exact `AgentRun` within the trailing 128 local records;
- two failed evaluations of the same completion gate against distinct material evidence pins;
- one explicit typed `UserCorrection`;
- evidence-based refiring after the same number of new qualifying records.

The detector:

- derives stable trigger and nonterminal keys;
- retains exact evidence event IDs and the evidence-through cursor;
- suppresses a trigger while the same nonterminal review is running;
- suppresses consumed evidence until enough newer evidence exists;
- excludes successful, cancelled, and unknown effects from failure triggers;
- counts every failed cell in one run, including effect-backed failures, and partitions causally linked effect outcomes away from duplicate repeated-effect review;
- never infers a correction from message prose;
- scrubs brokered credential values before deriving error signatures;
- rejects oversized or malformed inputs.

### Boundary scanning

`AgentRunService` calls the supervisor boundary observer before a new model step whenever the prior step is absent, committed, or rejected. The supervisor delivers queued family messages and then calls `RefinerService.scanBoundary()`.

`scanBoundary()`:

- reads the profile preference or the default trigger policy;
- loads retained branch events;
- loads trigger-consumption frontiers and pending nonterminal keys;
- runs the pure detector;
- admits detached automatic reviews;
- records a bounded nonfatal observation when scanning is unavailable.

Automatic review is therefore out of band from the active model step, but admission is driven by an ordinary committed run boundary. A terminal run does not itself invoke the boundary observer; evidence created by that terminal transition is considered at the next run boundary. No new terminal hook or scheduler is added in this plan.

### Refinement and governance

The existing automatic review path:

1. freezes a bounded trajectory snapshot;
2. starts a retained structured recursive refiner child;
3. accepts `no_change` or one typed harness proposal;
4. submits a candidate through automatic governance;
5. runs deterministic validation;
6. invokes one separate sealed reviewer;
7. revalidates at application time;
8. atomically applies approved content;
9. compiles and tests approved skills before activation;
10. records terminal delivery and exact rollback provenance.

The review request and trigger consumption are canonical. Incomplete retained reviews recover after restart. These mechanisms provide sufficient durability for default-on learning; this plan does not introduce another durable work model.

### Product controls

The current product surfaces collectively expose:

- automatic refinement policy through the protocol and `AgentClient`;
- `refine auto on|off`;
- manual trajectory refinement;
- review and proposal history;
- typed user correction;
- exact governed rollback.

The implementation will improve the presentation of these existing records rather than create a separate review system.

## Goals

- Make adaptive learning active for a fresh device profile without setup.
- Preserve an explicit user choice to pause automatic learning.
- Keep automatic behavior local and bounded.
- Reuse exact trigger keys instead of adding semantic event grouping.
- Prevent one trigger-scan attempt from admitting a burst of model reviews.
- Preserve current failure and correction trigger semantics.
- Add a low-frequency positive reflection opportunity without claiming that successful runs are objective proof of improvement.
- Keep every proposed change attributable to retained evidence.
- Keep `no_change`, rejection, review failure, unknown review, application conflict, and application failure visible.
- Make the ordinary user concept a learning log rather than a review queue.
- Preserve the existing memory candidate-index boundary so a future retrieval backend can be integrated without changing canonical memory authority.
- Update public documentation and black-box product evidence for the new default.

## Non-goals

- A generalized learning episode, semantic cluster, workflow fingerprint, or task-family classifier.
- A new event type or table solely to store learning-policy versions.
- A new durable queue, wake type, scheduler, or background service.
- Time-based trigger cooldown state.
- A dedicated automatic-learning spend budget, hourly review quota, or budget-isolation mechanism.
- Automatic interpretation of ordinary message prose as a user correction.
- Automatic workspace, user, global, or profile-wide scope promotion.
- Automatic agent-profile revision.
- Automatic connector creation or modification.
- Automatic changes to model choice, reasoning effort, credentials, budgets, permissions, effect policy, completion requirements, or safety boundaries.
- Automatic empirical promotion, regression rollback, or A/B allocation in this implementation.
- Cross-workspace personal memory.
- A Supermemory integration or replacement of canonical memory storage.
- Specialist discovery, cross-family assignment, organization routing, or management hierarchy.
- Tenacious-goal orchestration.

## Current simplifications and limits

The automatic-learning preference is one unqualified preference in the device-level `ProfileDatabase`. It is not session- or workspace-specific. In this plan:

- the default applies to every workspace using that device profile;
- `refine auto off` pauses new automatic refinement in every such workspace;
- automatic proposals themselves remain local to the originating session.

Per-workspace learning controls require a separate product decision and are deferred.

`scanBoundary()` currently loads complete branch history, while the pure detector rejects more than 10,000 supplied records. A sufficiently large branch may therefore record `scan_unavailable` and stop admitting automatic refinements. This plan keeps that visible limitation instead of adding indexed scan state or a new scheduler. A later focused change may supply bounded detector-specific projections if real usage reaches this limit.

Automatic refinement also has no separate spend budget or aggregate review-rate limit in this plan. One scan attempt admits at most one review, but later attempts may admit other eligible triggers, and reviews that return `no_change` or fail before producing a proposal do not enter governance proposal-rate accounting. Refiner and reviewer model usage remains visible through the existing child-session, task, effect, and budget records and is charged through ordinary tree-budget attribution. This is an accepted early-framework simplification, not a claim that default-on learning is free or isolated from task budgets.

## Terms

- **Trigger:** A deterministic finding that retained typed evidence crossed one configured threshold.
- **Trigger key:** The stable identity of one recurring detector condition, independent of the particular evidence tranche.
- **Evidence tranche:** The exact qualifying event IDs admitted for one automatic reflection.
- **Reflection:** One bounded trajectory-refiner invocation that returns `no_change` or one typed proposal.
- **Learning log:** The user-facing projection of automatic reviews, governed decisions, applied versions, failures, and rollbacks.
- **Sensitive change:** A change excluded from automatic local refinement, including broader scope, agent profiles, connectors, or runtime authority.

## Design

### 1. Default behavior

`DEFAULT_REFINEMENT_TRIGGER_POLICY_V1.automatic` becomes `true`.

`RefinerService.automaticPolicy()` retains its current preference behavior:

- no stored preference returns the default-on policy;
- a retained boolean preference continues to override the default;
- a retained complete policy continues to be validated by the pure scanner;
- malformed retained policy remains a nonfatal scan failure rather than authority to run a review.

This provides a clean product rule:

- fresh profiles learn automatically;
- `refine auto off` pauses learning for the current device profile across its workspaces;
- `refine auto on` resumes learning;
- an explicit prior `off` preference is not overwritten when the product default changes.

No preference migration is required.

### 2. Existing trigger identities remain authoritative

The current trigger keys remain unchanged:

- repeated effect failure: executor, operation, and scrubbed normalized error signature;
- repeated cell failure: exact `AgentRun` ID;
- repeated gate failure: goal ID, gate ID, and gate-definition hash;
- explicit correction: exact corrected event-ID set.

These identities are intentionally mechanical. They do not attempt to infer whether two failures occurred during the same conceptual task.

The existing evidence cursor and `refireAfterNewEvidence` threshold remain the first debounce mechanism. This plan does not add clock-based cooldowns.

### 3. One admission per scan attempt

`RefinerService.scanBoundary()` will admit at most one new automatic review per invocation.

When multiple triggers are eligible:

1. use the detector's existing deterministic ordering;
2. admit the first trigger;
3. leave all other evidence unconsumed;
4. reconsider the remaining triggers during a later scan attempt.

This cap:

- prevents several simultaneous paid refiner and reviewer calls after one noisy step;
- requires no new queue or state;
- preserves evidence because only terminal reviews consume their admitted trigger frontier;
- keeps the initial admission rule simple while trigger quality is still being established.

This is deliberately an invocation-local cap, not a durable exactly-once boundary guarantee. If the process stops after admitting one review but before committing the next run step, recovery may scan the same logical run position again and admit a different eligible trigger. Concurrent or repeated scans may likewise return the same idempotent review or admit another trigger after the first becomes suppressed or consumed. The existing trigger, nonterminal, and consumption identities continue to prevent duplicate work for the same evidence; this plan does not add a durable boundary-admission marker.

The existing governance proposal-rate comparison remains unchanged. It validates after the proposal event is appended, so the current proposal is already included in the recent count and the existing `> 12` comparison rejects the thirteenth proposal. Governance proposal limits do not cap automatic reviews that return `no_change` or fail before producing a proposal.

### 4. Existing negative and correction thresholds

The first default-on release retains the current thresholds:

- effect failures: 3;
- failed cells in one run: 3;
- distinct-pin gate failures: 2;
- typed correction: 1.

Changing the default and the thresholds in the same release would make trigger-volume regressions harder to interpret. Threshold tuning follows observed deterministic and real-provider behavior.

The failed-cell trigger counts all failed cells in one exact run, including cells explained by failed effects. Effect outcomes causally linked to an eligible, pending, or consumed failed-cell repair tranche are excluded from repeated-effect detection so one durable failure tranche creates one automatic review. Matching effect failures spread across runs remain eligible for repeated-effect detection when no run reaches the failed-cell threshold.

### 5. Coarse positive reflection

After the default-on failure path is stable, add the reserved `repeated_success` trigger without semantic grouping.

A qualifying success is one terminal `AgentRun` with status `succeeded`. Existing run semantics already require every applicable completion gate to pass before that status is committed. A successful status remains permission to reflect, not proof that a proposed adaptation will improve later work.

The initial repeated-success policy is:

- enabled by default;
- threshold: 5 qualifying successful runs;
- trailing window: 2,048 local records;
- refire after 5 newer qualifying successful runs;
- trigger identity: the current session branch, represented by one stable repeated-success trigger key;
- evidence: the five most recent qualifying terminal run-status event IDs.

The detector does not decide that the five runs are related. Snapshot construction extracts the exact run IDs from the qualifying terminal events and selects bounded events owned by those runs. It preserves existing source-event and byte ceilings and reports omissions rather than claiming complete trajectories. The refiner must return `no_change` unless the selected evidence directly supports one allowed artifact and predicted effect. The sealed governance reviewer applies the same direct causal-chain requirement.

Because terminal status does not invoke the current boundary observer, the fifth qualifying success becomes eligible at the next committed boundary, normally the beginning of later work on that branch. If no later run begins, no success reflection is admitted. Immediate post-terminal reflection is deferred to avoid adding another observer or wake path in this plan.

The repeated-success trigger requires updates to:

- `RefinementAutomaticTriggerKind`;
- an optional `RefinementTriggerPolicyV1.repeatedSuccess` field;
- trigger detection and validation;
- `RefinementTrajectoryTriggerInput`;
- trajectory snapshot trigger validation and event selection;
- automatic trigger-to-snapshot mapping in `RefinerService`;
- public policy display and documentation.

The canonical event schema already accepts `repeated_success` as a refinement trigger kind, so this addition does not require a workspace event-schema cutover.

The new policy field is optional for retained version-1 policy objects. An omitted field uses the new default in the same way that an older retained policy may omit `cellFailure`. Existing explicit automatic `on` or `off` choices therefore remain valid without rewriting the stored preference.

`stale_memory` and `unproductive_delegation` remain unavailable. Their reliable evidence models require attribution that is not yet simple enough for this plan.

### 6. Automatic target scope and review

Automatic reflection remains constrained to local harness content:

- memory;
- prompt note;
- skill;
- subagent specification.

Every proposal continues through the separate sealed reviewer. Skills also continue through compile and declared runtime tests.

The following targets remain excluded:

- agent profiles;
- workspace, user, or global harness scope;
- profile-installed skills;
- connectors and credentials;
- model and budget configuration;
- runtime permissions and authority.

This is the sensitive-change boundary for the initial product. The plan does not add a human approval state because the automatic path cannot reach those targets. Existing manual governed actions remain the route for broader or profile-level behavior.

### 7. Learning log

The learning log is a projection over existing records:

- trajectory review request and trigger;
- evidence summary;
- refiner status;
- `no_change` reason;
- governed proposal and sealed decision;
- application outcome and exact applied version IDs;
- rollback status;
- scan-unavailable observations.

No new audit table is required.

Product surfaces should present a small action set:

- inspect learning status;
- pause automatic learning;
- resume automatic learning;
- list recent learning activity;
- inspect one activity and its evidence;
- roll back an applied change when authorized.

CLI and protocol names may retain `refine` for compatibility. User-facing descriptions should use “automatic learning” and “learning history” where that is clearer than internal review terminology.

The ordinary history view must not imply that every record needs a decision. Terminal `no_change`, applied, rejected, failed, unknown, and rolled-back records are audit entries. The product should only describe an item as requiring action when an existing operation actually requires user input.

### 8. Memory boundary

Memory remains simple in this plan.

Agencity continues to own:

- canonical memory entry and version identity;
- scope and authority;
- lifecycle status;
- evidence and conflicts;
- exact versions selected into context;
- rollback and deletion semantics.

`MemoryCandidateIndex` remains the replaceable retrieval seam. A candidate backend returns version IDs, entry IDs, and ranks; `MemoryService` reloads canonical records and applies authoritative scope, lifecycle, candidate-exposure, conflict, and result-limit checks.

No Supermemory-specific type or API is added speculatively. A future backend integration may extend the candidate-index capability contract when concrete synchronization, filtering, consistency, and deletion requirements are known. It must not move behavioral authority or provenance out of Agencity merely to replace FTS5 ranking.

## Failure behavior

- A trigger scan failure never blocks the active run.
- Missing provider configuration prevents the detached reflection from succeeding; it does not change the task outcome or fabricate learning.
- A failed, cancelled, timed-out, malformed, or unknown refiner/reviewer result activates nothing.
- A `no_change` result consumes only the admitted evidence frontier and requires the configured amount of newer evidence before refiring.
- An application conflict activates nothing and remains visible in learning history.
- Explicit `refine auto off` prevents new automatic admissions but does not cancel already admitted governed work.
- Unknown effects remain unknown and do not count as failures or successes.
- A successful run does not establish empirical benefit for a proposed change.

## Implementation phases

### Phase 0: Baseline and impact inventory

1. Run the focused trigger and refiner suites.
2. Identify tests whose fixture profiles rely implicitly on automatic refinement being off.
3. Keep explicit `auto off` fixture setup only where a test is unrelated to learning and automatic background work would make its assertion ambiguous.
4. Preserve at least one black-box fresh-profile path that exercises the real default-on behavior.

Primary evidence:

- `test/unit/refinement-triggers.test.ts`
- `test/integration/refiner.test.ts`
- `test/integration/agent-profiles.test.ts`
- `test/acceptance/profile-governance.test.ts`

### Phase 1: Default-on bounded automatic refinement

1. Change the default policy to automatic-on.
2. Preserve explicit retained preference overrides.
3. Cap each trigger-scan attempt at one admitted trigger.
4. Preserve the existing post-append governance proposal-rate comparison.
5. Update unit and integration coverage for default behavior, explicit pause, deterministic trigger ordering, deferred eligible triggers, and repeated or recovered scan attempts.
6. Confirm review failure does not directly rewrite the active run result, while retaining truthful ordinary tree-budget attribution for automatic model usage.

Primary implementation:

- `src/runtime/refinement-triggers.ts`
- `src/runtime/refiner.ts`
- `src/runtime/refinement-governance.ts`
- `test/unit/refinement-triggers.test.ts`
- `test/integration/refiner.test.ts`

### Phase 2: Learning-log product surface

1. Make automatic-on status explicit in CLI, TUI, and JSON output.
2. Present automatic review and governance history as audit activity rather than a queue.
3. Keep pause, resume, inspect, and rollback available through public typed client operations.
4. Add black-box coverage for fresh default-on behavior and explicit pause persistence.

Primary implementation:

- `src/protocol/client.ts`
- `src/protocol/server.ts`
- `src/cli.ts`
- `src/tui/index.ts`
- `src/tui/detail-model.ts`
- relevant product, protocol, TUI, and acceptance tests

### Phase 3: Repeated-success reflection

1. Add the coarse five-success detector and optional policy field with retained-policy fallback.
2. Extend trajectory snapshot validation and exact run-ID-based bounded event selection.
3. Map the trigger through `RefinerService`.
4. Prove threshold, window, consumption, refire, branch-locality, bounds, and deterministic ordering.
5. Prove failed, blocked, cancelled, budget-exceeded, and unknown runs do not count.
6. Prove unrelated successful runs may trigger reflection but do not bypass the refiner's `no_change` option or governance evidence checks.

Primary implementation:

- `src/runtime/refinement-triggers.ts`
- `src/runtime/refinement-context.ts`
- `src/runtime/refiner.ts`
- `src/domain/refinement-review.ts`
- `test/unit/refinement-triggers.test.ts`
- `test/integration/refiner.test.ts`
- refinement-context and governance adversarial tests

### Phase 4: Documentation and complete verification

Update:

- `AGENTS.md`;
- `README.md` if ordinary onboarding or status text changes;
- `docs/user-guide.md`;
- `docs/configuration.md`;
- `docs/capabilities.md`;
- `docs/events.md`;
- `docs/verification.md`;
- ADR 0012 only if implementation changes its accepted governance meaning rather than only the default trigger policy.

Verification:

```sh
bun run typecheck
bun run check:architecture
bun test --timeout 30000 test/unit/refinement-triggers.test.ts
bun test --timeout 30000 test/integration/refiner.test.ts
bun run verify
```

Report deterministic passes, failures, and skips separately. Credential-gated provider, official Turso Sync, and Turso Cloud tests remain unverified unless their prerequisites are explicitly supplied and the tests are run.

## Acceptance criteria

The plan is complete when:

1. A fresh device profile reports automatic refinement enabled.
2. A retained explicit `off` preference remains off across restart and applies across workspaces using that device profile.
3. Existing effect, cell, gate, and typed-correction thresholds are unchanged.
4. One invocation of `scanBoundary()` admits at most one new automatic reflection.
5. Remaining eligible triggers retain their evidence and can be admitted during a later scan attempt, including a recovered attempt at the same logical run position.
6. Repeated consumed evidence does not create duplicate review, model, proposal, or application work.
7. Automatic work remains local-only and cannot revise an agent profile or broader scope.
8. Every automatic proposal receives deterministic validation, and every deterministically valid proposal receives a separate sealed review.
9. Skills still require successful compile and declared tests before activation.
10. The next committed boundary after five new successful terminal runs can trigger one repeated-success reflection without semantic grouping.
11. Four successful runs do not trigger it.
12. Non-success terminal states do not count.
13. A repeated-success reflection may terminate `no_change` without any active-content change.
14. Learning history exposes trigger, evidence, result, application, and rollback provenance through public product contracts.
15. Pause, resume, inspect, and rollback remain simple typed actions independent of the TUI.
16. No new learning-policy aggregate, semantic episode model, durable scheduler, or memory backend is introduced.
17. No dedicated automatic-learning spend budget, aggregate review-rate limit, or durable per-boundary admission marker is introduced.
18. Typecheck, architecture checks, focused tests, and the deterministic verification suite pass.

## Deferred follow-up

Later work may add:

- high-confidence prose-derived correction candidates;
- contradiction-based memory quarantine;
- stale-memory detection based on authoritative conflicting evidence rather than age;
- unproductive-delegation detection tied to parent rework or failed gates;
- automatic post-activation outcome summaries derived from existing invocation pins;
- bounded candidate exposure and automatic regression handling;
- a dedicated automatic-learning spend budget, aggregate review-rate limit, and related product controls after real usage validates the framework;
- evidence-based local-to-workspace promotion;
- owner/profile memory with explicit cross-workspace identity and data lifecycle;
- a concrete external retrieval backend;
- organization-level specialist discovery and routing.

Each follow-up requires its own evidence model. None should introduce generalized semantic grouping unless narrower typed keys prove insufficient in real use.

## Implementation log

### 2026-08-11 — Default-on policy and bounded trigger admission
- Completed: enabled the existing local automatic-refinement policy when no device-profile preference exists; preserved explicit device-wide pause/resume preferences; limited each `scanBoundary()` invocation to the first deterministically ordered eligible trigger; retained existing consumption, nonterminal, recovery, local-scope, governance, skill-test, and ordinary tree-budget semantics.
- Validation: the pre-change focused baseline passed 73 tests across trigger, refiner, profile, and installed-governance suites. The completed focused implementation suite passed 143 tests across trigger/context, refiner, CLI, TUI, and installed-governance coverage with 0 failures.
- Plan notes: no new durable boundary marker or proposal-rate rule was added. A later scan may admit another eligible trigger after the first is pending or consumed, as specified.
- Remaining: aggregate repository verification and independent final review were pending at this checkpoint.

### 2026-08-11 — Repeated-success reflection and learning history
- Completed: added the optional version-1 `repeatedSuccess` policy fallback, the branch-local five-success detector, exact successful-run evidence, bounded run-owned trajectory selection, trigger mapping, and threshold/window/refire/locality/non-success coverage. CLI and TUI status/history now include the automatic policy and present retained activity as learning audit history. Installed-product coverage proves a fresh default-on profile and an explicit pause that survives managed-service restart.
- Validation: focused trigger/context, refiner, product CLI, TUI, and installed profile-governance tests passed as part of the 143-test focused run. IDE diagnostics reported no errors in changed source and test files.
- Plan notes: the existing `refine` command and protocol names remain compatibility surfaces. No learning aggregate, migration, scheduler, semantic grouping, separate spend budget, or memory backend was introduced.
- Remaining: live-provider, official Turso Sync, and Turso Cloud verification remain gated and unverified.

### 2026-08-11 — Aggregate completion verification
- Completed: reconciled runtime behavior, installed-product coverage, public documentation, capability claims, and the plan index with the implemented default-on learning policy.
- Validation: the final `bun run verify` passed with 1,007 core tests passing and 2 gated skips, 3 end-to-end tests passing, and 18 installed acceptance tests passing with 1 credential-gated skip. Aggregate evidence was 1,028 passes, 3 skips, and 0 failures. The release acceptance matrix reported 1 deterministic row passed, 3 external rows skipped, and 0 failures. Typecheck, architecture checks, focused tests, independent review, and `git diff --check` passed.
- Plan notes: successful runs permit reflection but remain neither proposal approval nor empirical outcome proof. The learning log is retained audit activity rather than a human decision queue.
- Remaining: live-provider, official Turso Sync, and Turso Cloud verification remain gated and unverified. The full-history trigger scan limit and lack of a separate learning spend budget remain explicit accepted limitations.

### 2026-08-11 — Concurrency, learning-log, and rollback hardening
- Completed: serialized pause/resume with admission across workspace-service instances through a profile-backed expiring preference lease, revalidated device-policy generation immediately before automatic request append, and added transaction-time rejection for trigger evidence that became pending or consumed. Repeated-success snapshots now select only exact run-owned context instead of a generic adjacent-event radius.
- Completed: added typed session-wide learning status, history, and activity inspection across reflection, governed decision/application, nonfatal scan observations, and rollback provenance. Pending counts include only review-linked governance. CLI and TUI expose `pause`, `resume`, `inspect`, and governed `rollback` actions while preserving `auto off|on` and legacy candidate rollback compatibility.
- Completed: added one canonical `GovernedRefinementRollbackApplied` event and owner action that derives and atomically applies proposal-level inverse operations. Automatic creation, replacement, retirement, and multi-edit proposals are reversible without caller-supplied version identities.
- Completed: made grouped rollback validation branch-lineage aware so a synchronized rollback can land on a preserved divergent branch without rejecting its final provenance event after inverse events arrive.
- Completed: hardened skill rollback so exact same-content replacement restorations carry forward passing retained test evidence from the approved source version in the atomic rollback batch, created-skill rollback overrides stale availability actions, and idempotent rollback validates the originating route before returning retained results.
- Completed: replaced prose-derived scan classification with a typed versioned `learningScan` payload and bounded learning history to compact summaries under a 256 KiB serialized ceiling with explicit truncation.
- Validation: focused refiner and sync-lifecycle suites pass, including cross-connection pause/admission ordering, dead-owner and same-process stale-lease recovery, lease fencing, session-effective fork inspection with branch-route validation, review-linked pending counts, bounded history, typed scan observations, grouped rollback divergence, and grouped/direct skill rollback. The final aggregate suite passed with 1,028 tests, 3 gated skips, and 0 failures; independent final review reported no remaining actionable findings.
- Remaining: live-provider, official Turso Sync, and Turso Cloud verification remain gated and unverified.

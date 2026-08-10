# Durable tenacious goal orchestration plan

**Status:** Proposed  
**Date:** August 9, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related planning:** [Prime Agent rewrite follow-up plan](./2026-08-06-prime-agent-typescript-turso-rewrite-follow-up-plan.md), [Formal model-tool contracts](./2026-08-07-formal-model-tool-contracts-plan.md), and [Durable agent profiles and automated refinement review](./2026-08-08-adaptive-agent-city-plan.md)  
**Governing decisions:** [Durable local runtime foundations](../docs/decisions/0001-durable-local-runtime-foundations.md), [Durable agent relationships](../docs/decisions/0006-durable-agent-relationships.md), [Managed workspace execution](../docs/decisions/0007-managed-workspace-execution.md), [Formal model-tool contracts](../docs/decisions/0010-formal-model-tool-contracts.md), and [Durable agent profiles and automated refinement governance](../docs/decisions/0012-durable-agent-profiles-automated-refinement-governance.md)

## Summary

Agencity should support an explicit tenacious goal mode for work that may need several bounded autonomous episodes before the desired state is reached.

A durable `Session` remains the agent identity. A tenacious `Goal` remains on one session branch and owns an ordered sequence of `AgentRun` episodes. Each episode receives the exact original goal, current completion criteria, remaining aggregate bounds, prior progress, unresolved child work, and the latest completion feedback. An incomplete episode can end cleanly and the managed workspace service can admit the next episode without a user message or attached terminal.

Successful model output is a completion claim, not completion by itself. The supervisor:

1. checks deterministic runtime invariants and required completion gates against pinned workspace material;
2. optionally runs one sealed semantic completion review against frozen attributable evidence;
3. completes the goal only when the configured completion policy accepts the claim; or
4. records bounded feedback and admits a successor episode when the goal remains actionable.

The ordinary provider tool set remains exactly `bun_console` and `finish`. Goal-seeking behavior extends the typed meaning of `finish`; it does not add a general provider tool, parse assistant prose, or expose unrestricted goal mutation through the console.

This feature is session-local orchestration. It does not add a workspace coordinator, cross-family assignment, a management hierarchy, or an agent aggregate above `Session`.

## Current behavior and gap

Agencity currently has a durable inner run loop:

- a normal task creates or attaches one goal and admits one `AgentRun`;
- every model step calls `bun_console` to continue the same run or `finish` to propose a terminal outcome;
- a failed completion gate returns repair evidence to another model step in that same run;
- a successful `finish` completes the attached goal immediately when its required gates pass;
- when a run becomes terminal, no successor run is admitted merely because the goal remains active.

The default product path creates no required completion gate. In that path, a successful `finish` is accepted as the model's completion claim without an independent semantic evaluator.

The existing `GoalCreated.maxTurns` field is validated and retained but is not enforced. The name is also ambiguous because current budget `turns` count provider model calls, while product discussions may use “turn” to mean a complete top-level autonomous episode.

Prime Agent's `/goal` behavior does not create another durable agent identity or an independent judge. It attaches goal state to the current thread and injects another goal prompt after each ordinary assistant turn until the model explicitly calls `goal.complete()`, a token bound is reached, or the user stops it. Agencity needs equivalent tenacity without adopting process or thread state as identity and without weakening its existing gate, outbox, and recovery semantics.

## Product decision

Agencity will add a **goal episode coordinator** over successor `AgentRun`s on the same session branch.

The product model is:

```text
Session (durable agent identity)
  └── Branch
       └── Goal (finite desired state and aggregate policy)
            ├── Episode 1 -> AgentRun
            ├── Completion claim or continuation
            ├── Gate evidence and optional semantic review
            ├── Episode 2 -> AgentRun
            └── ...
```

The same root agent performs successive episodes. A new session is not created for each episode because a session is a durable actor, not an invocation. New sessions remain appropriate for delegated child work and for a sealed completion reviewer whose separate role must be retained.

Tenacious goal mode is explicit. Ordinary tasks keep the current single-run behavior unless the user starts a tenacious goal or an API caller selects tenacious orchestration.

## Goals

- Let one user-owned objective remain active across several terminal `AgentRun` episodes.
- Re-prompt the same durable agent with the exact original goal and attributable progress until completion is accepted or a visible bound or stop condition is reached.
- Let the model explicitly yield an incomplete episode without claiming success, failure, or an external blocker.
- Treat a successful root `finish` as a completion claim rather than sufficient completion evidence in tenacious mode.
- Preserve and reuse required completion gates.
- Support an optional sealed semantic reviewer for goals whose completion cannot be decided by deterministic gates alone.
- Keep completion review, gate evidence, continuation reasons, aggregate usage, and successor admission durable and inspectable.
- Wait efficiently for goal-attributable child work instead of polling or repeatedly prompting while children are still running.
- Continue detached through the managed workspace service and recover every committed boundary without duplicate model calls, reviews, effects, or successor runs.
- Keep the provider-facing tool names fixed at `bun_console` and `finish`.
- Preserve user pause, cancellation, steering, budget, and completion authority.

## Non-goals

- Creating a new root session for every continuation episode.
- Adding a workspace-wide goal scheduler or coordinator above independent roots.
- Routing work to unrelated existing sessions.
- Treating a semantic reviewer as objective proof.
- Replacing deterministic completion gates with model judgment.
- Automatically continuing after an unknown effect or ambiguous review outcome.
- Overriding a model-declared concrete external blocker merely to keep a loop active.
- Allowing the root model or reviewer to widen its budget, permissions, credentials, scope, model selection, or publication authority.
- Keeping a provider connection, console worker, terminal, or service process alive as goal identity.
- Inferring actions or completion from unstructured model prose.
- Adding a third ordinary provider tool.
- Making every ordinary task tenacious by default.
- Adding distributed execution ownership or cross-device failover.

## Terms

### Goal

A durable finite desired state, completion criteria, completion policy, aggregate bounds, and owner controls on one session branch.

### Episode

One bounded `AgentRun` that attempts to advance a tenacious goal. An episode has an ordinal, stable identity, exact profile pin, initiating reason, run, terminal disposition, usage, and evidence references.

### Continuation claim

A typed `finish` outcome stating that the episode made progress but the goal remains incomplete. It includes a bounded progress summary, remaining work, and next intended focus.

### Completion claim

A successful `finish` outcome stating that the goal is complete and supplying the proposed final user-facing message. The message remains provisional until the configured completion policy accepts the claim.

### Completion policy

The owner-selected rule for accepting a completion claim. It combines mandatory runtime invariants, required deterministic gates, and an optional sealed semantic review.

### Semantic completion review

One separate, sealed, read-only model invocation that judges a frozen completion claim against the original goal, completion criteria, and attributable evidence. It returns a strict typed decision. Its decision is an independent semantic assessment, not objective proof or runtime authority.

### Goal episode coordinator

The supervisor-owned durable service that reconciles goal state, evaluates claims, waits for dependencies, and admits exactly one successor episode when policy permits.

## User experience

### Starting tenacious work

The TUI adds:

```text
/goal start DESCRIPTION
/goal start --criteria "CRITERIA" DESCRIPTION
/goal start --review required DESCRIPTION
```

`/goal start` defaults to required semantic review. `--review none` is an explicit lower-cost policy that accepts the root completion claim after runtime invariants and required deterministic gates pass. The selected policy is durable and visible before execution.

The product CLI adds an equivalent no-ID path:

```sh
agencity goal "bring the repository to a passing verified release state"
agencity goal --criteria "all documented release gates pass" --detach \
  "finish the release hardening work"
```

Starting a tenacious goal atomically:

1. resolves or creates the selected root session and branch;
2. records the goal, completion policy, and aggregate bounds;
3. records episode 1 and its stable run identity;
4. appends the initiating user message once;
5. admits the first `AgentRun`; and
6. lets the managed service continue after client detachment.

Existing plain task submission and `/run` remain single-run product paths. Existing low-level goal creation remains available for API compatibility but does not silently opt a branch into tenacious execution.

An active tenacious goal owns root-run admission on its branch. Plain user text received while it is active is durable **goal steering**, not an unrelated `goalMode: "auto"` run:

- during a running episode, the instruction is committed once and enters the next model-step context;
- during gate evaluation or semantic review, the instruction is committed without blindly cancelling an in-flight effect, makes the pinned completion claim stale, and is delivered to one successor episode after the terminal gate/review outcome is retained as stale evidence;
- between episodes or while blocked on a user decision, the instruction becomes the exact trigger for coordinator reconciliation and one successor episode;
- a user who intends unrelated work must stop the goal, create a branch, or select another root.

Schedules and heartbeats targeting a tenacious goal also enter through the coordinator as wake or steering triggers. They cannot attach an ordinary single-run path to that goal.

`AgentRunService.admit` rejects any direct or `goalMode: "auto"` attachment to a tenacious goal unless the request carries the exact coordinator-issued episode identity and causal decision. This domain check applies to the CLI, TUI, protocol, SDK, schedules, heartbeats, recovery, and internal callers, preventing an ordinary run from bypassing child quiescence, aggregate bounds, gates, or semantic review.

### Inspecting and controlling work

The TUI and CLI expose:

```text
/goal
/goal pause
/goal resume
/goal stop
/goal complete
```

Status shows:

- the original goal and criteria;
- orchestration mode and completion policy;
- current episode and run status;
- aggregate model calls, tokens, cost, wall time, and child attribution;
- current gate and semantic-review state;
- outstanding goal-attributable child work;
- the latest progress claim or rejected-completion feedback;
- the next continuation reason;
- any stop, uncertainty, or no-progress reason.

`/goal pause` prevents successor admission and requests cancellation of an active root episode according to existing cancellation semantics. It does not cancel child tasks unless the user explicitly requests tree cancellation. `/goal resume` re-enters coordinator reconciliation from durable state.

`/goal stop` records user cancellation and prevents future successor admission. It never rewrites completed effects or child outcomes.

`/goal complete` is an explicit owner completion request. It still requires every owner-configured deterministic gate to pass. It may bypass the optional semantic reviewer because the reviewer cannot overrule the principal, but that bypass and its actor are recorded explicitly.

The existing `/goal create` command remains an advanced single-run goal-definition operation. `/goal start` is the only command that atomically enables tenacious orchestration and admits episode 1. Existing `/goal clear` becomes a compatibility alias for `/goal stop`; it does not physically erase history. The legacy `continueGoal(maxTurns)` protocol operation is retired in favor of explicit resume, steering, and episode inspection with model-call and episode vocabulary.

A paused or blocked goal continues to occupy the branch's single current-goal slot. Starting another goal fails with direct guidance to resume or stop the current goal, branch the work, or select another root. No incidental command silently replaces a retained goal.

## Provider contract

### Keep two tools

The ordinary provider tool names remain:

```text
bun_console
finish
```

The next version of the agent tool contract adds one typed successful continuation variant to `finish`:

```ts
type FinishOutcome =
  | {
      message: string;
    }
  | {
      status: "continue";
      message: string;
      remainingWork: string[];
      nextFocus: string;
    }
  | {
      status: "blocked" | "failed";
      message: string;
    };
```

The meanings are:

- omitted `status`: claim that the current task or attached goal is complete;
- `continue`: end this episode after meaningful progress while retaining an actionable goal;
- `blocked`: stop because a concrete external requirement or missing user decision prevents useful progress;
- `failed`: stop because reasonable recovery attempts ended without a safe path forward.

Every ordinary agent invocation advertises the same version-2 contract and the same two tools. Capability inspection reports that one exact contract and digest; dispatch does not select a mode-specific schema. `continue` is schema-valid but requires a tenacious goal episode. If an ordinary single-run model submits it, domain validation commits a bounded typed action rejection and gives the model one correction opportunity without executing work or implicitly creating a goal.

For tenacious goals:

- `continue` records progress and requests another episode;
- omitted status starts completion evaluation;
- `blocked` and `failed` stop automatic continuation;
- runtime cancellation, aggregate budget exhaustion, and unknown outcomes remain supervisor-owned terminal states.

The canonical action protocol and `AgentRunStatus` gain explicit continuation/evaluation states. A continuation is not represented as success, failure, or a fake user message.

### Goal-seeking prompt component

Every episode pins a versioned immutable goal-seeking policy component in its effective system-prompt provenance. The component instructs the root to:

- treat the original goal and criteria as user-provided task data;
- make concrete progress toward the complete desired state;
- inspect retained child work and evidence before claiming completion;
- use `bun_console` while further work is immediately useful;
- use `finish` with `status: "continue"` only at a meaningful episode boundary when actionable work remains;
- use successful `finish` only after auditing every criterion;
- use `blocked` only for a concrete external requirement or missing user decision;
- never claim completion to escape a budget boundary.

The component does not grant authority. Its exact ID, version, digest, and rendered prompt digest are retained with each episode context and model request.

## Goal and episode state model

### Goal policy

A tenacious goal records:

```ts
interface GoalOrchestrationPolicy {
  mode: "single_run" | "tenacious";
  completionReview: "none" | "required";
  maxEpisodes: number;
  maxModelCalls: number;
  maxConsecutiveNoProgressEpisodes: number;
  tokenLimit?: number;
  costLimitUsd?: number;
  wallTimeLimitMs?: number;
}
```

All automatic-continuation policies are finite. Product defaults must be conservative and visible. The first implementation should calibrate numeric defaults through deterministic long-task fixtures before making `/goal start` generally available. Explicit user limits may narrow but never widen a retained session budget.

`GoalCreated.maxTurns` is replaced by or deterministically interpreted as `maxModelCalls`. Public surfaces use “model calls” and “episodes” instead of the ambiguous term “turn.” The implementation follows the repository's pre-release event-version policy rather than silently reinterpreting retained history.

### Owner lifecycle and orchestration state

Owner lifecycle remains separate from coordinator progress.

Owner lifecycle:

```text
active | paused | completed | blocked | failed | cancelled
```

Coordinator progress:

```text
idle
admitting_episode
running_episode
waiting_for_children
evaluating_gates
reviewing_completion
continuation_ready
stopped_unknown
terminal
```

This separation prevents a transient review or admission stage from being confused with user pause, goal completion, or failure.

The schema cutover removes `completion_requested` from owner `GoalStatus`. A goal remains `active` while a completion claim, gates, or semantic review is pending; the episode and coordinator projections carry those transient states. The existing `GoalCompletionRequested` and `recoverIncomplete` paths are replaced by claim-bound gate/review reconciliation for both single-run and tenacious modes. Retained older event schemas fail before projection according to the repository's pre-release compatibility policy.

### Episode lifecycle

```text
requested
running
evaluating
continued
succeeded
blocked
failed
cancelled
budget_exceeded
unknown
```

Continuation and completion claims are dispositions recorded while an episode is running; they are not standalone lifecycle states. One episode maps to one `AgentRun`. Only `requested`, `running`, and `evaluating` are nonterminal. A branch still permits at most one nonterminal root `AgentRun`.

## Durable events and projections

The implementation adds canonical events equivalent to:

- `GoalEpisodeRequested`
  - goal ID, episode ID and ordinal, stable run ID, reason, predecessor episode/decision, exact profile pin, aggregate-policy snapshot, and prompt-component pin;
- `GoalEpisodeDispositionRecorded`
  - episode/run/action IDs, continuation or completion claim, bounded progress, remaining work, proposed final message digest, material pin, and usage summary;
- `GoalSteeringRecorded`
  - exact user, schedule, or heartbeat trigger; target goal and active/next episode; retained message/event references; and delivery state;
- `GoalProgressSnapshotRecorded`
  - episode ID, normalized semantic-outcome digest, unresolved-gap fingerprint, contributing evidence IDs, and consecutive no-progress count;
- `GoalCompletionReviewRequested`
  - claim/review IDs, frozen review input and digest, reviewer dispatch, and expected coordinator state;
- `GoalCompletionReviewChildLinked`
  - review ID, recursive handle, child session, and child branch;
- `GoalCompletionReviewDecided`
  - exact accepted typed result, result digest, model-call evidence, and expected review state;
- `GoalContinuationAdmitted`
  - decision ID, predecessor episode, successor episode and run IDs, and exact context-seed record IDs;
- `GoalOrchestrationStopped`
  - typed stop kind, reason, bound or uncertainty evidence, and actor where applicable.

Names may be adjusted to match the final event registry, but the durable distinctions are required. A projection must never infer a missing review, decision, or successor admission from “the latest run looks terminal.”

Operational tables may index current episode/review state for service queries, but canonical meaning remains in events. New tables require classification in `docs/mutable-tables.md`, replay coverage, idempotent migration/open tests, and architecture checks.

Every new event receives an explicit workspace-material classification. Coordinator bookkeeping and reviewer control events are normally non-material. Actual repository effects, artifacts, messages, and user-owned goal-definition changes remain material according to their existing meaning.

## Episode admission and continuation

### Stable identity

Coordinator identities are derived from durable inputs:

```text
episode ID: goal + ordinal
run ID: episode ID
completion claim ID: episode + finish action
review ID: completion claim
successor decision ID: predecessor episode + accepted decision
```

Exact encodings are implementation details, but retries must resolve to the same IDs and durable meaning. Idempotency-key reuse with changed meaning conflicts.

### Atomic first episode

Goal creation, episode 1, run admission, and the initial user message commit atomically. A crash after commit but before worker enqueue is recovered from the canonical request.

### Atomic successor admission

A continuation decision and its successor episode/run admission commit in one transaction. The successor suppresses another user message and references the original goal event plus exact continuation evidence.

Worker enqueue is a latency optimization. Recovery advances the already-admitted successor when the process exits after commit.

### Same session and branch

Successor episodes run on the same session and branch because they are continued activity by the same durable actor. This preserves:

- branch history and workspace material;
- working values and artifact references;
- goal and gate identity;
- child-family relationships and mailbox state;
- session and descendant budget attribution;
- exact selected root and user resume behavior;
- the one-active-run-per-branch invariant.

Creating a new root session per episode would incorrectly create new durable identities, fragment budget and context, and turn ordinary continuation into cross-session assignment. Only the sealed reviewer uses a separate retained child session.

## Context for successor episodes

The first model call of every successor episode receives a supervisor-generated `goalEpisode` context section containing:

- original goal ID, description, completion criteria, and owner;
- orchestration policy and remaining aggregate bounds;
- episode ordinal and exact predecessor chain;
- latest progress or completion claim;
- deterministic gate evaluations and material pins;
- semantic-review decision and unmet criteria, when present;
- goal-attributable child tasks, recursive handles, mailbox receipts, and terminal notices;
- relevant cells, effects, artifacts, working values, and unknown outcomes;
- exact profile and effective-prompt pins for the new episode;
- no-progress evidence and next continuation reason.

The original goal event and current goal definition are protected context records and are always selected deliberately; they are not recoverable only from a generated summary. Large prior evidence may be referenced through existing artifacts and compaction derivations.

The initial user goal message is appended once. Successor episodes receive canonical continuation records rather than duplicate fake user messages. The context materializer includes their exact event IDs through `additionalRecordIds`, and every `ContextMaterialized` event retains those references.

Profile changes activated between episodes apply according to existing profile semantics: a successor episode pins the active profile at admission, while every step in that episode keeps the same invocation pin. The continuation record makes a profile-version change visible and attributable.

## Child and recursive work

Tasks and recursive handles created from a goal episode inherit correlation metadata:

- goal ID;
- episode ID;
- origin run and action IDs;
- creation event ID.

Before automatic goal completion, the supervisor applies a built-in quiescence invariant:

- every goal-attributable child task and recursive handle is terminal; and
- every required terminal result or notice is committed and available to the root context.

An active child does not cause busy re-prompting or leave a root run occupying the branch indefinitely. When the root submits `continue` or a completion claim while goal-attributable children remain active:

1. the current episode becomes terminal `continued`;
2. the coordinator records `waiting_for_children` with the exact outstanding task/handle IDs;
3. no successor root run is admitted while those dependencies remain nonterminal; and
4. attributable child terminal notices trigger one successor episode with the exact committed results.

The same rule applies to a completion claim: nonterminal child work rejects that claim as premature, withholds the proposed final message, closes the root episode as `continued`, and waits before admitting the successor. Evaluation does not resume directly after the children finish because the root must inspect their terminal evidence before making another completion claim.

A coordinator-created semantic-review child is classified as control work rather than goal work. It is excluded from the pre-review quiescence check and is instead required by the explicit review lifecycle, preventing the reviewer from waiting on itself.

A user may explicitly mark a child as independent of the goal only through a typed owner-authorized operation with retained reason and budget consequences. The model cannot silently detach unfinished goal work to make completion pass.

Child failures are evidence, not automatic parent-goal failure. The successor root decides whether to repair, redelegate, report a concrete blocker, or make another completion claim within remaining bounds.

## Completion evaluation

### Evaluation order

A tenacious completion claim is evaluated in this order:

1. **Authority and state**
   - the claim belongs to the current episode and active goal;
   - no pause, cancellation, stale execution owner, or aggregate bound forbids evaluation.
2. **Dependency quiescence**
   - goal-attributable child work is terminal and delivered.
3. **Material pin**
   - the claim records the exact workspace material version and source event IDs.
4. **Required deterministic gates**
   - existing outbox-backed gates evaluate against that pin;
   - unchanged definitions and material may reuse exact cached evaluations;
   - failed, stale, cancelled, and unknown outcomes remain distinct.
5. **Semantic completion policy**
   - `none` accepts a root completion claim after required gates pass;
   - `required` starts one sealed semantic completion review.
6. **Atomic result**
   - accepted completion records the decision, goal completion, exact final assistant message, and successful run outcome together;
   - rejected completion records bounded feedback and atomically admits or queues one successor episode;
   - blocked, unknown, unavailable, or exhausted evaluation stops visibly.

Required deterministic gates cannot be waived by the root or semantic reviewer. A user completion request may bypass semantic review but not retained required gates.

### Gate behavior across episodes

Gate evaluation is separated from final goal completion. The current `GoalService.requestCompletion` combines those operations and must be split into:

- completion-claim pinning;
- gate evaluation/recovery;
- final goal transition after the complete policy succeeds.

In single-run mode, existing failed-gate repair may continue in the same run.

In tenacious mode, a `finish` seals the current episode. A failed gate records one bounded rejection and causes a successor episode rather than reopening a supposedly terminal model response. The successor sees the exact gate output and material pin.

If workspace material has not changed, an identical failed gate is not executed repeatedly. The coordinator counts the repeated unchanged rejection as no progress.

### Sealed semantic reviewer

The semantic reviewer uses the existing durable recursive-session mechanism and built-in structured-contract registry. It has:

- a sealed internal profile;
- a supervisor-selected and pinned model dispatch;
- one frozen bounded input;
- one required response tool;
- no ordinary agent SDK, shell, files, delegation, or mutation authority;
- its own explicit budget charged to the goal and session tree;
- a retained child session, model effect, typed result, and terminal outcome.

The frozen input contains:

- goal, criteria, owner, and orchestration policy;
- the root's exact completion claim and proposed final response;
- all required gate definitions and current evaluations;
- workspace material pin and selected attributable evidence;
- goal-attributable task and recursive-work outcomes;
- prior semantic decisions and the changes made in response;
- aggregate usage and remaining bounds;
- the immutable completion-review policy and response contract.

The goal and root claim are untrusted data, not reviewer instructions.

The reviewer returns exactly one decision:

```ts
type GoalCompletionReviewDecision =
  | {
      decision: "complete";
      goalId: string;
      claimId: string;
      reason: string;
      satisfiedCriteria: string[];
      evidenceEventIds: string[];
      residualRisks: string[];
    }
  | {
      decision: "continue";
      goalId: string;
      claimId: string;
      reason: string;
      unmetCriteria: string[];
      nextFocus: string;
    }
  | {
      decision: "blocked";
      goalId: string;
      claimId: string;
      reason: string;
      missingRequirements: string[];
    };
```

The runtime validates IDs, exact claim binding, schema, byte bounds, evidence existence, and current coordinator state. Supplemental text is diagnostic-only.

Reviewer `complete` is an independent semantic judgment, not proof that external reality matches the claim. Required gates and explicit uncertainty remain authoritative.

Reviewer `continue` becomes one exact continuation decision and one successor context record.

Reviewer `blocked` stops automatic continuation and surfaces the missing requirements. A later user instruction resumes through an ordinary typed owner action.

Malformed output, contract violation, model failure, budget exhaustion, missing frozen evidence, or an unknown model effect never implies completion or continuation. The goal stops in a visible review-failed, review-unavailable, or unknown state according to the exact outcome.

## Bounds and no-progress control

Tenacity is not unbounded retry.

Before every model call, review, and successor admission, the coordinator enforces:

- retained session budget;
- aggregate goal token, cost, model-call, and wall-time limits;
- maximum episode count;
- maximum consecutive no-progress episodes;
- child budget reservations and attributed usage;
- cancellation and execution-owner state.

Semantic-review usage counts against the goal. Goal-attributable child usage remains attributed through existing task accounting and also contributes to the goal aggregate.

The goal `maxModelCalls` counter includes root model calls, semantic-review calls, and model calls attributed from goal-correlated descendants. The retained session `turnLimit` continues to count model calls under the existing budget projection. Admission uses the lower remaining allowance. Reaching the session limit produces the existing session/run `budget_exceeded` outcome; reaching the narrower goal limit appends `GoalOrchestrationStopped { kind: "model_call_limit" }`. Neither admits a successor.

No progress is a deterministic observation, not a reviewer feeling and not a comparison of raw workspace-material cursors. `MessageAppended` and `CellCommitted` are material events, so their new event IDs alone cannot prove progress.

At each episode boundary, the coordinator records a canonical `GoalProgressSnapshot` digest over normalized semantic outcomes:

- current required-gate definition and result digests;
- terminal goal-correlated child/task result digests;
- artifact and working-value content/version digests;
- normalized successful file, shell, skill, and other effect outcomes attributable to the episode;
- completion criteria resolved so far;
- the current continuation or reviewer-gap fingerprint.

Control events, context/model-call IDs, timestamps, message IDs, and repeated identical cell/effect results do not change the progress digest. Existing workspace-material classification and gate-staleness semantics remain unchanged.

An episode counts as no progress when its normalized progress digest and unresolved-gap fingerprint equal the preceding episode's values. A semantic change resets the count even when a reviewer still requests continuation.

Reaching the no-progress bound stops the goal as blocked with exact evidence. It does not keep prompting the same model with equivalent context.

Hard session-budget exhaustion remains `budget_exceeded`. Unknown effects remain `unknown`. Neither automatically admits a successor.

## Stop and continuation policy

Automatic successor admission is allowed after:

- an explicit typed `continue` finish;
- a failed or stale deterministic completion check with an actionable changed-context path;
- a semantic-review `continue` decision;
- completion of child work for an episode waiting on attributable children;
- explicit user resume of a paused or blocked actionable goal.

Automatic successor admission is forbidden after:

- successful accepted completion;
- user pause or cancellation;
- model-declared blocked or failed outcome;
- unknown effect, gate, child, or reviewer outcome;
- exhausted goal or session bound;
- execution-owner conflict;
- repeated no progress;
- unavailable required semantic-review capability;
- missing or corrupt required evidence.

The coordinator never converts unknown or unavailable into “try again.”

## Managed service and recovery

The managed workspace service owns detached goal continuation under the same process fencing as runs, effects, schedules, and wakes.

An active tenacious goal with pending coordinator work is a service keep-alive reason. Paused, blocked, completed, failed, cancelled, budget-exceeded, and unknown goals are quiescent unless another retained trigger requires service activity.

The coordinator exposes an idempotent:

```ts
reconcile(sessionId, branchId, goalId): Promise<GoalOrchestrationResult>
```

Reconciliation reads canonical state and performs only the next legal stage. It may be called:

- after episode admission;
- after a root run boundary;
- after a child terminal notice;
- after a gate effect terminal outcome;
- after semantic-review child completion;
- after durable user steering, schedule delivery, or heartbeat delivery;
- after user pause, resume, completion, or cancellation;
- during startup recovery.

The implementation must replace the current single mutable run-terminal observer with composable lifecycle subscribers or an equivalent canonical event-driven handoff. Agent task finalization, automatic refinement, and goal coordination cannot overwrite one another's observers.

### Crash boundaries

Tests must cover process loss:

- after goal and episode commit, before worker enqueue;
- after root `finish` action commit, before episode disposition;
- after completion-claim pinning, before gate request;
- after gate request, during execution, and after terminal outcome;
- after semantic-review request, before child link;
- after child link, during model execution, and after typed result;
- after review decision, before successor admission;
- after successor admission, before worker enqueue;
- after accepted decision, before final message and goal completion commit.

Recovery must:

- reuse stable requests and completed outcomes;
- never call a non-idempotent model effect twice;
- mark lost non-idempotent work unknown;
- never admit two successor runs for one decision;
- never publish a provisional final answer;
- never complete a goal from an unbound or stale review;
- preserve exact profile, prompt, context, model, gate, and evidence pins.

## Protocol, SDK, and TUI

The public protocol adds typed inspection for:

- goal orchestration policy and aggregate usage;
- ordered episodes and their runs;
- continuation/completion claims;
- gate and semantic-review state;
- successor causal links;
- outstanding goal-attributable child work;
- stop and no-progress reasons.

Mutation routes remain owner-scoped:

- start;
- pause;
- resume;
- stop/cancel;
- owner completion request;
- explicit reviewer-policy or limit selection at creation;
- optional owner-authorized child independence.

The console SDK remains read-oriented for goal orchestration. The root may inspect the current goal, episode, limits, and review feedback, but it cannot directly append completion, review, continuation, or successor events. Those transitions occur through the formal `finish` action and supervisor commands.

The TUI presents one goal with nested episode summaries rather than flattening every continuation into unrelated conversations. It distinguishes:

- working;
- waiting for children;
- checking deterministic gates;
- reviewing semantic completion;
- continuing after unmet criteria;
- paused or blocked;
- completed;
- stopped by bound or uncertainty.

Only the final accepted completion message becomes the goal's final assistant answer. Intermediate continuation messages remain inspectable episode progress and may appear collapsed in the run history without masquerading as a user-facing final result.

## Security and authority

- Goal descriptions, completion criteria, root claims, child output, and repository content are untrusted reviewer data.
- Goal-seeking and semantic-review policies are immutable supervisor components with exact digests.
- Neither root nor reviewer can grant credentials, permissions, model access, budget, connector access, or publication scope.
- The reviewer cannot execute tools, mutate state, delegate, alter the claim, or select another goal.
- Known secret values are rejected or redacted through existing model and context safeguards.
- Trusted-local authority remains explicit. This plan does not add hostile-code isolation.
- User pause, cancellation, and narrower limits take effect at the next safe durable boundary and always prevent new successor admission.

## Schema, storage, and compatibility

Implementation requires:

- versioned event schemas and strict payload validation;
- deterministic reducer transitions and duplicate-event no-ops;
- rebuildable projections for goal, episode, review, and successor state;
- a numbered migration using the next available migration ID at implementation time;
- documented mutable-table classification for any operational indexes;
- exact sync-envelope behavior for every new canonical event;
- historical projection and branch-fork tests;
- architecture checks for new tables and adapter boundaries.

The repository is pre-release and currently rejects unsupported event schema versions. If the implementation changes released-in-branch goal or run event meaning, it must perform an explicit accepted-schema cutover and fail older workspaces with reset guidance. It must not silently reinterpret retained rows.

## Implementation slices

### Slice 1 — Domain model and explicit continuation

- Define orchestration policy, episode, claim, review, and continuation types.
- Add canonical events, schemas, reducers, and projections.
- Replace ambiguous `maxTurns` with enforced model-call and episode limits.
- Version the one global formal agent contract with the `finish.status = "continue"` variant and domain rejection outside tenacious episodes.
- Add canonical agent action and run states for continuation and completion evaluation.
- Remove transient `completion_requested` from owner goal lifecycle and replace its recovery path with claim-bound reconciliation.
- Keep ordinary single-run behavior unchanged.

**Exit:** reducer and contract tests prove valid transitions, invalid cross-goal claims, duplicate no-ops, bounds, and compatibility behavior.

### Slice 2 — Goal episode context and same-branch successor admission

- Add the immutable goal-seeking prompt component.
- Pin goal/episode/profile/policy context to every episode invocation.
- Atomically create the first episode and successor episodes.
- Suppress duplicate user messages.
- Route plain user steering, schedules, and heartbeats through the coordinator while a tenacious goal owns the branch.
- Reject direct non-coordinator run attachment to a tenacious goal.
- Add aggregate usage and no-progress projections.
- Add composable run-lifecycle observation.

**Exit:** an explicit continuation finish starts exactly one successor `AgentRun` on the same session branch with the original goal and predecessor evidence.

### Slice 3 — Child correlation and waiting

- Correlate child tasks and recursive handles to their origin goal and episode.
- Add the completion quiescence invariant.
- Wait on child terminal notices without polling.
- Reconcile child completion into one successor episode.

**Exit:** a detached root can yield while several children work, then resume exactly once with all committed terminal results.

### Slice 4 — Gate separation and outer-loop repair

- Separate gate evaluation from final goal completion.
- Preserve exact material pins and cache semantics.
- Convert rejected tenacious completion claims into successor episodes.
- Retain current same-run repair for ordinary single-run work.

**Exit:** a failed gate never publishes the provisional final answer and gives the next episode exact bounded repair evidence without duplicate gate execution on unchanged material.

### Slice 5 — Sealed semantic completion review

- Add the immutable completion-review policy and sealed reviewer profile.
- Register a dedicated built-in one-tool response contract.
- Freeze and retain review input and model dispatch.
- Run the reviewer through a durable recursive child.
- Validate and apply complete, continue, and blocked decisions.
- Stop visibly on malformed, unavailable, failed, exhausted, or unknown review.

**Exit:** a premature completion claim rejected by the sealed reviewer causes one attributable successor episode; an accepted claim plus passed gates completes the goal exactly once.

### Slice 6 — Managed service and recovery

- Wire coordinator reconciliation into resident root queues and startup recovery.
- Add goal-coordinator keep-alive reporting.
- Cover every crash boundary and non-idempotent unknown outcome.
- Preserve graceful shutdown and process fencing.

**Exit:** detach and service restart during any review or successor boundary neither loses work nor duplicates a model call, gate, review, or run.

### Slice 7 — Product surfaces and documentation

- Add CLI, protocol client, TypeScript API, and TUI start/control/inspection paths.
- Present nested episode and review state without internal IDs in normal use.
- Add installed-product black-box coverage.
- Update `AGENTS.md`, README, user guide, API, protocol, events, recovery, security, configuration, verification, and mutable-table documentation.

**Exit:** a fresh external repository can start a tenacious goal, detach, observe multiple episodes including delegated children, resume, and see one accepted terminal result through the installed executable.

## Test plan

### Domain and reducer

- goal creation plus first episode is atomic;
- only one nonterminal root episode exists per branch;
- episode ordinals and predecessor links cannot fork;
- a continuation decision admits one exact successor;
- direct `auto`/`current` attachment cannot bypass a tenacious coordinator;
- duplicate events are true no-ops;
- changed idempotent meaning conflicts;
- a completion review cannot target another claim, goal, branch, or material pin;
- invalid pause, resume, cancellation, and terminal transitions fail closed;
- replay and rebuild produce identical orchestration state.

### Provider and context contracts

- ordinary runs reject `finish.status = "continue"`;
- tenacious runs accept only the strict bounded continuation shape;
- every run advertises the same version-2 tool contract and capability digest;
- supplemental prose never changes the action;
- every episode receives the original goal and exact continuation records;
- goal text cannot rewrite the goal-seeking or reviewer system policy;
- profile and effective-prompt pins remain exact across every step;
- context compaction cannot remove the only exact goal or decision reference.

### Completion and review

- no-gate, no-review policy accepts a root claim explicitly and visibly;
- required gates pass before semantic review;
- failed, stale, cancelled, and unknown gates remain distinct;
- unchanged failed evidence is cached and contributes to no-progress detection;
- reviewer complete, continue, blocked, malformed, failed, unavailable, budget-exceeded, and unknown outcomes are covered;
- accepted completion atomically publishes the exact root message and completes the goal;
- rejected completion never publishes the provisional message;
- user completion bypasses only semantic review and remains subject to required gates.

### Multi-agent work

- root spawns several children, yields, and waits without busy polling;
- no completion is accepted while goal-attributable child work is nonterminal;
- waiting closes the prior root run before child completion triggers a successor;
- terminal child notices trigger one root successor;
- child failure reaches the next root context as evidence;
- cancellation tree behavior remains unchanged;
- child and reviewer usage is attributed to the correct session and goal.

### Bounds and stopping

- episode, model-call, token, cost, wall-time, and no-progress bounds stop at exact boundaries;
- repeated identical messages, inspection cells, and effect results do not evade the normalized no-progress bound;
- session `turnLimit` and goal `maxModelCalls` use the lower remaining allowance and retain distinct stop evidence;
- pause prevents a successor already decided but not admitted;
- cancellation during active root work prevents future admission;
- blocked and failed root finishes do not auto-continue;
- unknown root, child, gate, or reviewer effects do not auto-retry;
- execution-owner loss fails visibly.

### Recovery and black-box product

- every crash boundary listed above recovers exactly once;
- detached service operation spans at least two successor episodes;
- service status reports active goal coordination as a keep-alive reason;
- quiescent blocked and terminal goals allow service exit;
- installed `agencity goal` works without copied session, branch, goal, run, or review IDs;
- TUI quit detaches without cancelling the active goal;
- plain user text, schedules, and heartbeats steer the active tenacious goal instead of creating a bypass run;
- starting unrelated work while a paused or blocked goal occupies the branch gives deterministic branch/stop guidance;
- normal `agencity "TASK"` behavior remains compatible and single-run.

## Acceptance criteria

- A user can start one tenacious goal from the documented product entrypoint without internal IDs.
- The goal remains on one durable root session and branch across at least two `AgentRun` episodes.
- Every successor episode receives the original goal, current criteria, remaining bounds, exact predecessor evidence, and active profile pin.
- An explicit continuation finish admits exactly one successor without appending a duplicate user instruction.
- A premature completion claim can be rejected by deterministic gates or the configured semantic reviewer and produces one attributable successor episode.
- Required gates and child quiescence pass before goal completion.
- Only an accepted completion publishes the final assistant answer and appends `GoalStatusChanged(completed)`.
- Pause, cancellation, blocker, budget exhaustion, no progress, unavailable capability, and unknown outcome stop continuation distinctly.
- Client detachment and process restart do not duplicate model calls, child work, gates, reviews, messages, or successor runs.
- Documented finite product defaults allow a deterministic two-episode progress fixture to complete and stop a deterministic repeated-no-op fixture at the configured no-progress bound without exceeding any aggregate limit.
- Ordinary single-run tasks retain their current behavior.
- Full typecheck, architecture checks, unit, integration, end-to-end, acceptance, and acceptance-matrix gates pass; credential-gated external rows are reported separately as pass, fail, or skip.

## Risks and mitigations

### Runaway cost

Finite aggregate limits, reviewer accounting, no-progress detection, explicit service status, pause, and cancellation bound automatic continuation.

### Reviewer false acceptance

The reviewer is labeled semantic judgment rather than proof. Deterministic required gates remain authoritative, exact evidence is retained, and users can inspect or correct the result.

### Reviewer false rejection

The decision and unmet criteria are visible. Bounded continuation prevents infinite argument between root and reviewer, and the owner can explicitly complete subject to required gates.

### Repeated equivalent work

Material-version checks, gap fingerprints, gate caching, and the consecutive no-progress bound stop equivalent episodes.

### Context drift

The original goal, criteria, policy, and predecessor evidence are exact canonical references selected into every episode. Summaries accelerate context but do not replace source identity.

### Child-work races

Goal correlation, terminal-notice delivery, dependency quiescence, stable successor IDs, and one active root run per branch prevent premature completion and duplicate wake-up.

### Observer conflicts

Composable lifecycle subscribers or canonical reconciliation replace the current single mutable terminal observer.

### Product confusion

Tenacious goals are explicit and displayed as one goal with episodes. Ordinary tasks remain one run, and the UI distinguishes progress, review, continuation, and accepted completion.

## Definition of done

The feature is done when the documented installed-product path can:

1. start a tenacious goal in a fresh external repository;
2. perform direct and delegated work through one durable root identity;
3. end an incomplete episode and automatically admit a successor;
4. reject one premature completion claim with attributable feedback;
5. accept completion only after child quiescence, required gates, and configured semantic review;
6. survive terminal detachment and managed-service restart at durable boundaries;
7. stop safely on user authority, bounds, no progress, unavailable capability, or uncertainty; and
8. expose the complete episode, evidence, review, budget, and causal history through public product surfaces.

Until those conditions are reproduced, Agencity should describe the shipped behavior as a durable goal-aware single-run loop with optional completion gates, not as tenacious cross-run goal orchestration.

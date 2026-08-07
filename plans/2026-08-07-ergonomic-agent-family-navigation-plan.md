# Ergonomic agent-family navigation plan

**Status:** Implemented  
**Date:** August 7, 2026  
**Readiness reviewed:** August 7, 2026
**Implementation verified:** August 7, 2026 (`bun run verify`)
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related backlog:** [FU-005 protocol-backed TUI and FU-012 durable agent families](./2026-08-06-prime-agent-typescript-turso-rewrite-follow-up-plan.md)

## Summary

Agencity retains parent and child sessions, exact family relationships, child tasks, mailbox activity, and branch coordinates. The full-screen terminal currently presents that information as passive task rows in the conversation and through the read-only `/agents` and `/tree` inspectors. It does not provide a selected agent, a persistent direct-child summary, or keyboard navigation between a parent and its children.

This plan adds an ergonomic agent-family navigator to the protocol-backed OpenTUI:

1. a compact direct-child summary remains visible beside the ordinary conversation composer;
2. Down focuses that summary when the composer is empty;
3. Enter or Right opens a scoped family browser;
4. Up and Down select a child;
5. Enter or Right opens the selected child's conversation without stopping either session;
6. Left returns from a child conversation to its exact parent branch;
7. a breadcrumb and explicit status labels keep the current agent scope visible.

The interaction adapts the useful Prime Agent pattern without copying Prime Agent's process-lifecycle model. Agencity continues to use durable sessions, canonical events, managed execution, exact branch coordinates, and the public snapshot-plus-cursor protocol.

## Problem

The current runtime already has the required durable relationships:

- `AgentState.parentSessionId`, `parentBranchId`, `rootSessionId`, `depth`, and `taskId` identify the current session's ancestry;
- `AgentState.tasks` identifies direct child sessions and their exact branches;
- `AgentService.listFamily` returns the current session's parent, siblings, and direct children;
- `AgentClient.agents`, `snapshot`, and `watchBranch` expose those records through the public protocol;
- `TerminalUI.#switch` can move the client to another session and branch.

The terminal presentation does not turn those capabilities into a normal navigation flow:

- default child rows are informational and cannot receive focus;
- `/agents` and `/tree` produce formatted inspection output rather than a selectable browser;
- Left and Right are not agent-navigation actions;
- switching requires `/sessions select` or leaving the TUI and resuming another route;
- the header names only the current session and branch, so nested scope is easy to lose;
- the current switch helper is command-oriented rather than a race-safe public navigation operation.

This is a product usability gap rather than a missing domain model.

## Goals

- Make direct child activity visible in the ordinary conversation view without requiring a command.
- Let a keyboard user move from a parent to a child and back with a small, predictable set of keys.
- Preserve drafts and ordinary text-editing behavior.
- Keep active work running when the client observes another family member.
- Follow exact retained parent/child branch coordinates rather than names, recent-session preferences, or incidental ordering.
- Use only the public protocol client from the TUI.
- Preserve snapshot-plus-cursor catch-up, provisional-progress isolation, and explicit disconnected or unavailable states.
- Present durable task, run, cancellation, failure, and attention states truthfully.
- Work at nested depths by repeating the same parent/direct-child interaction.
- Cover the installed full-screen product path without exposing internal IDs.

## Non-goals

- Replacing the workspace-level root-session selector or `/sessions`.
- Turning the family browser into a general branch-history browser.
- Displaying unrelated root sessions or allowing cross-family traversal.
- Changing model-facing nuclear-family authorization.
- Changing child admission, mailbox, follow-up, cancellation, budget, or completion semantics.
- Stopping, resuming, or retrying work merely because the user opens a session.
- Adding mouse navigation.
- Persisting transient row focus or browser expansion in canonical history.
- Adding a new canonical event, table, migration, or mutable source of agent identity.
- Reproducing Prime Agent's running, idle, and inactive labels where those labels do not match Agencity's durable semantics.

## Terms

- **Current route:** The session ID and branch ID whose conversation the TUI is currently observing.
- **Navigation origin:** The route selected by the product entrypoint before the user starts browsing family members.
- **Direct child:** A task-bound session whose `parentSessionId` and `parentBranchId` match the current route.
- **Parent route:** The exact `parentSessionId` and `parentBranchId` retained by the current session.
- **Family summary:** The compact direct-child status line shown with the composer.
- **Family browser:** The selectable view of the current route's direct children.
- **Open:** Attach the client to another retained route. Opening is observational and does not admit, resume, cancel, or retry work.

## Chosen interaction

### Default conversation view

When the current route has one or more retained direct children, the TUI renders a one-line family summary between the composer and the persistent footer:

```text
  3 agents: 1 working · 1 idle · 1 attention   Enter or → to open
```

The line:

- counts all retained direct children;
- remains visible while conversation and activity content scroll;
- uses singular or plural wording correctly;
- groups cancelled and archived children under `ended`, so an ended-only family remains reachable without a command;
- truncates from the right on narrow terminals while retaining the total and highest-severity count;
- receives a selected marker and background when focused;
- disappears only when there are no retained direct children;
- never claims that an agent is inactive merely because no worker process is resident.

The current passive `AGENTS` block in the timeline is replaced by this summary. Detailed child rows remain available in the family browser and `/agents` inspector, avoiding duplicated and competing default presentations.

### Focus and key behavior

Key handling follows these rules in order:

1. Hidden credential entry, the model picker, command palette, and other active modal inspectors keep their existing key ownership.
2. When the composer contains text, arrow keys and Enter retain text-editing and submission behavior. Agent navigation never discards, submits, or moves a draft.
3. When the empty composer is focused, Down focuses the family summary if it is selectable.
4. When the family summary is focused:
   - Enter or Right opens the family browser;
   - Up, Left, or Escape returns focus to the composer;
   - ordinary printable input returns focus to the composer and inserts the input there.
5. In the family browser:
   - Up and Down move through selectable direct children without wrapping;
   - Enter or Right opens the selected child route;
   - Left or Escape closes the browser and returns to the current conversation;
   - Page Up and Page Down scroll the browser when its rows exceed the viewport.
6. In a child conversation, Left from an empty composer opens the exact parent route. Left continues to edit text when a draft exists.

The footer advertises only actions that are currently available. A child route with a parent shows `← parent`; a root route does not.

`Alt-A` may be added as a summary-focus shortcut only after deterministic OpenTUI input tests verify that the supported terminal sequences report it consistently. Until then, the footer advertises Down as the focus action.

### Family browser

The browser is scoped to the current route. It starts with the current agent as a nonselectable scope header, followed by its direct-child rows. Each child row shows:

- stable human-readable session name, with the task summary as fallback;
- derived activity label;
- task summary;
- cancellation state;
- model when width permits;
- an attention reason when the child is waiting, blocked, failed, budget-exceeded, unknown, or unavailable.

Rows sort deterministically by exact activity priority:

1. `attention`;
2. `unavailable`;
3. `waiting`;
4. `working`;
5. `idle`;
6. `ended`;
7. normalized display name;
8. session ID as a final stable tie-breaker.

The browser opens in the contextual side panel on wide terminals. On narrow terminals it replaces the main content while retaining the header, composer, and footer. Closing it restores the same conversation viewport and route.

Opening a child closes the browser, changes the current route, and places focus back in the empty composer. A nested child exposes its own direct-child summary, so the same interaction works at every supported depth without rendering an unbounded graph.

Selection is keyed by the child's session and branch IDs. Refreshes retain that selection when the row remains present; otherwise they move to the nearest selectable row without expanding, opening, or cancelling anything.

The browser itself is observational. It does not add reply, resume, cancel, delete, or follow-up controls; those operations remain on their existing typed product paths.

### Breadcrumb

The header shows the current ancestry separately from the branch:

```text
root › reviewer › verifier / main
```

Ancestry resolution follows retained parent coordinates and is bounded by the runtime's maximum session depth. Long paths retain the root and current names and collapse the middle:

```text
root › … › verifier / main
```

The breadcrumb is client presentation state. Session IDs, parent IDs, and branch IDs remain the durable identity.

### Status vocabulary

The family navigation projection uses UI activity labels rather than overloading session lifecycle:

- **working:** the child task is pending, admitted, or running and no stronger attention state is present;
- **waiting:** the child's current run is waiting for user input or permission;
- **idle:** the child completed retained work and remains available for supported follow-up;
- **attention:** the child is blocked, failed, budget-exceeded, unknown, has a pending cancellation reconciliation, or has another explicit unresolved outcome;
- **ended:** the readable retained child was cancelled or archived;
- **unavailable:** required child or branch state cannot be resolved.

Activity derivation applies the first matching rule:

1. Missing required child, branch, or expected task state is `unavailable`.
2. An unresolved unknown outcome, pending cancellation reconciliation, exceeded budget, failed task or session, or latest blocked, failed, budget-exceeded, or unknown run is `attention`.
3. A cancelled task or archived session with no stronger unresolved outcome is `ended`.
4. A latest run waiting for input is `waiting`; an unresolved permission input uses `permission_required`, and other input uses `waiting_for_user`.
5. A pending, admitted, or running task, or latest queued or running run, is `working`.
6. Completed retained work or a retained idle or stopped session with no stronger state is `idle`.

The latest run is selected deterministically by canonical event order. A resolved older run does not keep a row in `attention` after later retained work supersedes it.

The compact summary groups `waiting`, `attention`, and `unavailable` under `attention`, but the browser preserves the exact label and reason. Unknown and unavailable never render as idle or successful.

## Navigation semantics

### Opening is observational

Opening a route:

- does not append an event;
- does not change task ownership;
- does not resume a stopped child;
- does not cancel the route being left;
- does not retry an effect;
- does not claim that provisional output was committed;
- does not change the managed service's execution ownership.

The selected route's existing composer semantics remain in effect after opening. A waiting child can receive the user's answer through its normal typed run-input path. Unsupported actions on stopped or unavailable sessions fail visibly through the existing typed protocol errors.

### Navigation does not change workspace resume selection

Arrow navigation is temporary client observation. It does not call `productSelect` and does not replace the workspace's remembered navigation origin.

Commands that intentionally select durable workspace work—`/sessions select`, `/new`, `/branch`, and `/resume`—retain their existing preference behavior. Detaching while viewing a child therefore does not silently make that child the default root selection for the next `agencity` invocation.

### Exact branch traversal

Every transition uses retained coordinates:

- parent traversal uses the current state's `parentSessionId` and `parentBranchId`;
- child traversal uses the selected task's `childSessionId` and `childBranchId`, or the matching family record's `sessionId` and `branchId`;
- names are display and search values only;
- a child session's other branches are not substituted automatically.

If an edge points to a missing or unreadable branch, the browser retains an unavailable row and disables Open. It does not fall back to another branch or parent.

### Historical mode

Family opening is disabled while the current route is showing a historical cursor. The footer and browser state: `Return to live before opening another agent`.

This prevents an apparent parent or child transition from silently discarding the user's historical inspection position. `/live` restores normal navigation.

## Public family projection

### Extend the existing family result

`AgentService.listFamily` already projects each related session. The fields from `sessionId` through `taskStatus` already exist. Add `task`, `cancellationRequested`, `activity`, and `activityReason` as presentation-neutral derived fields needed by any client:

```ts
interface FamilyAgentRecord {
  sessionId: string;
  branchId: string;
  name: string | null;
  relationship: "parent" | "sibling" | "child";
  depth: number;
  status: string;
  taskId: string | null;
  taskStatus: TaskStatus | null;
  task: string | null;
  cancellationRequested: boolean;
  activity: "working" | "waiting" | "idle" | "attention" | "ended" | "unavailable";
  activityReason:
    | "waiting_for_user"
    | "permission_required"
    | "blocked"
    | "failed"
    | "budget_exceeded"
    | "unknown"
    | "cancellation_pending"
    | "cancelled"
    | "archived"
    | "missing_state"
    | null;
}
```

These fields are a deterministic read projection. They do not become canonical state and do not change model-facing relationship authorization. `cancellationRequested` mirrors the related task record. It is `false` when the family member has no related task; an expected but unreadable task produces `unavailable` with `missing_state`.

The projection derives activity from the related session's latest committed state and task record. `activityReason` is a bounded status code, not raw child messages, provider output, or error text. Cursorless provider progress may improve animation inside the currently opened conversation, but it does not alter family status. The browser never treats ephemeral progress as a durable task transition.

This is a compatible enrichment of the existing `GET /sessions/:session/agents?branch=:branch` result, not a new route or aggregate event stream. `AgentClient.agents` remains the TUI's only family-roster read. The console's `sdk.agents.list()` returns the same record, so its model-visible JSON receives these additive fields without gaining broader family access or new authorization.

### TUI presentation state

Add a family-navigation section to `TerminalPresentation` containing:

- current route;
- parent record, if any;
- direct-child records;
- ancestry labels;
- refresh state: `current`, `refreshing`, `stale`, or `unavailable`;
- a client-local refresh generation.

Sibling records remain available to `/agents` but are not shown in the direct-child browser. A user reaches a sibling by returning to the shared parent and selecting that child, preserving the visible hierarchy.

### Refresh behavior

The controller refreshes the public family result:

- during initial attach;
- after a successful route switch;
- after current-branch events that change tasks, cancellation, terminal notices, session names, or status;
- on an initial bounded one-second interval while the family browser is open or a direct child is nonterminal;
- once after reconnect.

The interval stops when no refresh condition remains, the client detaches, or the protocol is disconnected. Refreshes are coalesced, tagged with a generation, and discarded when they belong to an older route. The scheduler and interval are injectable in deterministic controller tests.

Polling is supplementary status refresh, not event authority. The selected conversation continues to use the existing snapshot-plus-cursor branch watch. A failed family refresh keeps the last rows visible with a stale marker and cannot manufacture a transition.

Before release, a focused local benchmark measures family refresh with at least 25 related sessions and 5,000 committed events per branch. It records refresh latency and database work and confirms that coalescing prevents overlapping refreshes or backlog at the initial cadence. Any projection-cache or interval optimization follows that evidence rather than being required in advance.

## Race-safe route switching

Promote the current private command switch into a generic race-safe controller route transition. Add a family-navigation wrapper that rejects detached, closing, historical, or protected-modal state and verifies the target is the current exact parent or a direct child in the latest family projection. Product commands continue to authorize their targets through the product catalog before calling the shared transition.

The shared transition performs these steps:

1. Allocate a monotonically increasing navigation generation.
2. Fetch and validate the target snapshot before releasing the current usable view.
3. Abort and await the old branch watch.
4. Clear route-specific provisional output, streamed effect IDs, run-working indicators, inspectors, and interrupt state.
5. Install the target route and snapshot.
6. Start the target snapshot-plus-cursor watch.
7. Refresh family and ancestry presentation.
8. Publish one route change and return focus to the composer.

If target authorization or snapshot loading fails before step 3, the current route remains attached. If the target watch fails after installation, the target remains visibly disconnected and retryable through normal watch recovery. Results from older navigation generations cannot replace the latest route.

Rapid Right/Left input is serialized. At most one branch watch owns the visible route after each completed transition.

## Rendering and responsive behavior

### Wide terminals

- Conversation and activity remain in the main pane.
- The family browser uses the existing contextual inspector pane.
- The compact family summary remains next to the composer even when another nonmodal detail is absent.
- Opening the family browser replaces any prior contextual inspector predictably.

### Narrow terminals

- The family browser replaces the main pane.
- The composer remains visible but is not editable until the browser closes or opens a route.
- Breadcrumb, connection state, trust boundary, and current activity remain visible.
- Long names and tasks truncate without hiding status.

### Very short terminals

- Preserve header, one browser row, composer, and footer before optional detail text.
- Do not render overlapping boxes or a zero-height selectable list.
- Center the selected child when possible and use leading or trailing `…` markers when rows are outside the viewport.

### Accessibility and terminal compatibility

- Color is supplementary; every state has text and a marker.
- Key hints use literal terminal keys supported by OpenTUI.
- Enter, Return, linefeed, keypad Enter, and common CSI arrow sequences receive the same behavior.
- Repeated key input cannot open more than one concurrent route switch.

## Security and architecture invariants

- The TUI remains a public protocol client and does not open the database or call `Supervisor` directly.
- Family navigation grants no new model-facing mailbox or data reach.
- Raw internal IDs remain hidden in the normal view and available only in diagnostics.
- Provider credentials and known secret values do not enter family labels, errors, breadcrumbs, or tests.
- Route changes do not bypass the outbox because they execute no external effect.
- Client focus, selected row, refresh timers, and breadcrumbs are disposable presentation state.
- Canonical events remain append-only; replay never opens sessions or repeats effects.
- Missing child state remains unavailable rather than being replaced by a guessed route.
- Trusted-local authority remains visible in every responsive layout.

## Delivery sequence

### 1. Family projection and pure view model

- Extend `FamilyAgentRecord` and `AgentService.listFamily` with task, cancellation, activity, and reason fields.
- Add pure status derivation with exhaustive task/run/session cases.
- Add a TUI family view model that merges the current `AgentState`, family result, and exact task edges.
- Add deterministic sorting, summary counts, fallback labels, and ancestry formatting.
- Preserve existing `/agents`, `/tree`, SDK, and protocol response compatibility.

### 2. Controller navigation

- Add family state to `TerminalPresentation`.
- Add coalesced, generation-checked family refresh.
- Replace `TerminalUI.#switch` with a race-safe route-switch primitive used by both commands and family navigation.
- Separate temporary family observation from product-selection preference updates.
- Resolve bounded ancestry through public snapshots.
- Clear route-specific provisional and inspector state without cancelling work.

### 3. OpenTUI interaction

- Add a dedicated family summary renderable and focus state.
- Add the selectable family browser.
- Implement key precedence, draft protection, parent traversal, and responsive layouts.
- Add breadcrumb and scoped footer hints.
- Keep `/agents` and `/tree` as structured diagnostic inspectors.

### 4. Product verification and documentation

- Add deterministic OpenTUI frame and input tests.
- Extend the linked-executable pseudo-terminal journey with parent/child navigation.
- Update user, capability, protocol, API, and verification documentation.
- Update `AGENTS.md` implementation status only when the behavior is shipped and verified.

## Expected implementation areas

- `src/runtime/agents.ts` — deterministic family activity projection.
- `src/tui/view-model.ts` — family summary, rows, status mapping, breadcrumb, and responsive presentation.
- `src/tui/index.ts` — family refresh, ancestry resolution, route switching, and product-preference separation.
- `src/tui/opentui.ts` — summary tray, browser, focus, keys, and responsive rendering.
- `src/tui/detail-model.ts` — keep `/agents` and `/tree` aligned with enriched family records.
- `test/unit/terminal-ui.test.ts` — controller transitions, watch ownership, refresh races, and preference behavior.
- `test/unit/opentui.test.ts` — focus, keys, frames, drafts, status updates, and resize.
- `test/unit/tui-detail-model.test.ts` — enriched family inspector output.
- `test/integration/family-agents-sdk.test.ts` or a focused protocol test — family projection compatibility and unavailable-state behavior.
- `test/e2e/opentui-pty.test.ts` — installed parent/child navigation without IDs.
- `docs/user-guide.md`, `docs/capabilities.md`, `docs/protocol.md`, `docs/api.md`, `docs/console-sdk.md`, `docs/verification.md`, `README.md`, and `AGENTS.md` — shipped behavior and evidence.

## Test plan

### Pure projection

- No children produces no summary.
- Singular and plural summaries are correct.
- Only exact direct children are counted; siblings and grandchildren are excluded.
- Cancelled and archived children remain inspectable as `ended`, including when they are the only children.
- Working, waiting, idle, attention, ended, and unavailable are exhaustive and deterministic.
- Waiting, unknown, failed, budget-exceeded, and missing state cannot appear idle.
- Cancellation requests remain visible before terminal cancellation.
- Equal display names sort by stable identity.
- Long names, tasks, and ancestry paths truncate deterministically.

### Controller and protocol

- Initial attach publishes parent, direct children, and ancestry from public protocol data.
- Root to child to parent traversal uses exact branch IDs.
- Navigating to a child does not call `productSelect`.
- `/sessions select`, `/new`, `/branch`, and `/resume` retain their intentional preference updates.
- A failed target snapshot leaves the old route attached and usable.
- Rapid child/parent navigation cannot let a stale snapshot or family refresh win.
- Every successful switch leaves exactly one branch watch active.
- Old-route provisional output is removed and never displayed under the new breadcrumb.
- Current-route committed events catch up without omission or duplication after a switch.
- Family refresh failure marks rows stale and preserves the last known projection.
- Detach stops refresh timers and route watches.
- Historical mode rejects family opening until `/live`.
- A focused 25-relative, 5,000-events-per-branch benchmark records refresh cost and verifies that refreshes do not overlap or accumulate.

### OpenTUI

- Down from an empty composer focuses the summary.
- `Alt-A` is enabled and advertised only if supported terminal input sequences pass deterministic compatibility tests.
- Enter and Right open the family browser from the focused summary.
- Up, Left, and Escape return summary focus to the composer.
- Printable input from the focused summary returns to the composer and is retained.
- A nonempty draft keeps all text-editing behavior and blocks family navigation.
- Up and Down select browser rows without wrapping; Enter and Right open exactly one child.
- Left from an empty child composer returns to the exact parent.
- Existing modal and secret-input key handling takes precedence.
- Wide, narrow, and very short frames retain the current route, status, and key hints.
- Child status changes update counts without moving selection unexpectedly.
- Unavailable rows cannot be opened.

### Installed product

A linked `agencity` executable in a fresh external repository must:

1. start a root task that creates a named retained child;
2. show the direct-child summary without `/agents` or an internal ID;
3. focus and open the family browser using terminal key sequences;
4. open the child and show its conversation and breadcrumb;
5. return to the parent with Left;
6. prove the child run was not cancelled or duplicated by navigation;
7. detach and resume the remembered root work;
8. keep provider credentials absent from pseudo-terminal output.

The black-box test must use the public installed entrypoint and protocol-backed TUI. It must not query the database, call supervisor internals, or inject session IDs.

## Completion criteria

The work is complete when:

1. A direct-child summary is part of the default full-screen conversation experience.
2. A user can reach a child conversation and return to its parent using Down, Up, Enter, Right, and Left without typing a command or seeing an internal ID.
3. Draft text and existing modal key behavior are never overridden by family navigation.
4. Opening a family route does not stop, resume, retry, duplicate, or re-own durable work.
5. Parent and child transitions follow exact retained branch coordinates and preserve uncertainty.
6. Snapshot-plus-cursor delivery remains correct across route switches, reconnects, and rapid navigation.
7. Wide and narrow terminal layouts expose the same navigation semantics.
8. Unit, integration, OpenTUI frame/input, and installed pseudo-terminal tests cover the complete path.
9. `bun run typecheck`, `bun run check:architecture`, relevant focused suites, and `bun run verify` pass.
10. Public documentation and `AGENTS.md` describe the shipped interaction, status vocabulary, protocol behavior, and remaining limitations accurately.

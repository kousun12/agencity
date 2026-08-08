# Workspace Agents view plan

**Status:** Proposed  
**Date:** August 8, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Extends:** [Ergonomic agent-family navigation](./2026-08-07-ergonomic-agent-family-navigation-plan.md)

## Summary

Agencity retains root sessions, nested child sessions, branches, task edges, lifecycle state, and exact parent coordinates. The shipped terminal family navigator exposes direct children and lets an empty child composer move directly to its parent conversation with Left. The product also has a flat `/sessions` inspector, but it has no first-class screen that presents all retained workspace agents and lets a user move through arbitrary ancestry.

This plan adds a full-screen **Agents view** modeled on the useful navigation structure in Prime Agent while preserving Agencity's durable route and execution semantics:

1. Left from any live conversation with an empty composer opens the Agents view.
2. A nested conversation opens its exact parent scope with the current route selected.
3. A root conversation opens the global workspace scope.
4. Up and Down select retained routes.
5. Enter or Right opens the selected route.
6. Left in the Agents view moves one scope toward the workspace root.
7. Repeated Left reaches the global workspace view from any supported nesting depth.
8. The global view includes working, idle, attention, failed, stopped, archived, and otherwise ended retained routes.

“Left always works” means the navigation is available at every retained ancestry depth. It does not override a non-empty editor, search text, secret entry, modal control, or historical inspection.

### Relationship to Prime Agent

Prime Agent's current interaction keeps an ephemeral stack of Agents-view scopes. Left from an empty chat returns to that existing Agents view, and Left inside a scoped Agents view pops one stored scope frame. This plan adopts the visible parent-scope and global-catalog interaction, but it intentionally does not copy that state model.

Agencity derives each scope from durable exact parent routes. The same Left path therefore works after a client restart and when a conversation was opened by a command rather than through the Agents view. Prior browser scope and selection may improve the return experience, but they are never required to recover ancestry.

## Verified current behavior

The current implementation provides:

- a direct-child summary between the composer and footer;
- Down to focus that summary;
- Enter or Right to open a direct-child browser;
- Up and Down to select a direct child;
- Enter or Right to open the selected child's conversation;
- Left from an empty child composer to open the exact parent conversation;
- retained ancestry in the conversation breadcrumb;
- a flat `/sessions` inspector that includes every retained workspace branch;
- `/sessions select` for changing the remembered resumable product route.

The current behavior does not provide:

- a global Agents screen;
- a selectable workspace-wide hierarchy;
- a way to inspect unrelated retained roots without a command;
- a way to open the committed conversation and history of failed or archived routes through the flat selector;
- a parent-scope screen between a nested conversation and its parent conversation;
- a search surface for retained agents;
- one repeated Left interaction that moves from a nested route through every parent scope to the workspace catalog.

The implemented family-navigation plan explicitly excluded unrelated roots and replacement of `/sessions`. This plan adds that missing product layer without broadening model-facing family authorization.

## Goals

- Make all retained workspace agents discoverable from the ordinary terminal interface.
- Let a user move from any live conversation to its parent scope with Left.
- Let repeated Left traverse arbitrary retained ancestry and reach the global workspace view.
- Keep working, idle, stopped, failed, archived, ended, and unavailable work visible.
- Open exact session and branch routes without names, recency, or incidental ordering determining identity.
- Preserve drafts, search input, modal key ownership, and historical inspection.
- Keep browsing observational: it must not start, stop, resume, retry, cancel, or re-own work.
- Keep workspace browsing separate from the model-facing nuclear-family API.
- Preserve the current remembered workspace route unless the user invokes an explicit product-selection action.
- Support large retained workspaces without replaying every branch on every refresh.
- Cover the installed full-screen product path without exposing internal IDs.

## Non-goals

- Changing child admission, task ownership, mailbox authorization, budgets, or cancellation semantics.
- Giving generated TypeScript or models workspace-wide session visibility.
- Replacing exact session and branch identity with display names.
- Making failed or archived routes resumable merely because they are inspectable.
- Treating a terminal attachment as durable session ownership.
- Persisting search text, selected rows, expansion, scope, or scroll position as canonical events.
- Adding mouse navigation.
- Adding a new canonical event or mutable source of agent identity.
- Deleting, archiving, renaming, stopping, or resuming sessions from the first version of the Agents view.
- Silently truncating retained work when the workspace exceeds one response page.

## Terms

- **Route:** One exact `(sessionId, branchId)` pair.
- **Agent route:** A route that belongs to a root or child session.
- **Branch route:** A later branch of an existing session, linked to its exact source branch.
- **Route graph:** The workspace-wide read projection containing root routes, branch lineage, child task edges, and unavailable retained references.
- **Conversation route:** The route whose transcript the terminal currently observes.
- **Return route:** The conversation route that remains unchanged while the Agents view is open.
- **Scope route:** The route whose subtree is shown in a scoped Agents view.
- **Parent scope:** The subtree rooted at the current route's exact parent route.
- **Workspace scope:** The top-level view containing every retained root route in the workspace.
- **Open:** Observe a retained route. Open does not resume or otherwise execute it.
- **Inspect-only route:** A resolvable failed or archived route whose history may be opened but whose composer cannot start new work.
- **Unavailable route:** A retained reference whose required session or branch state cannot be resolved.

## Product interaction

### Conversation to Agents view

When a live conversation is focused and its composer is empty:

- Left opens the Agents view.
- If the current route has a retained parent route, the view opens at that parent scope and selects the current route.
- If the current route is a root, the view opens at workspace scope and selects that root.
- The conversation remains the return route until the user opens another route.

This replaces the shipped behavior in which Left jumps directly from a child conversation to the parent conversation. The parent remains one Enter or Right action away, but the user first sees the parent, siblings, descendants, and current selection in context.

When the composer contains text, Left keeps ordinary cursor-editing behavior. The terminal never discards, submits, stashes, or hides a draft to enter the Agents view.

### Agents view layout

The Agents view is a first-class full-screen product mode, not a contextual side inspector. It contains:

- an `Agents` header;
- workspace and current-scope labels;
- a search field;
- a virtualized hierarchical route list;
- visible route activity and lifecycle labels;
- a persistent trusted-local footer;
- key hints that reflect the selected row and current scope.

At workspace scope, root families are ordered in aggregate sections:

1. **Attention**
2. **Working**
3. **Idle**
4. **Ended**

Each root family remains a hierarchical subtree inside its section. Descendants are not moved into separate sections, because separating them from their parents would hide the retained relationship. Every descendant row carries its own activity and lifecycle label.

Aggregate family activity uses the first matching rule:

1. `attention` when any retained route is attention or unavailable;
2. `working` when no route needs attention and any route is working;
3. `idle` when no route needs attention or is working and at least one route remains interactive;
4. `ended` otherwise.

Aggregate state is recomputed from the complete route graph at each catalog revision. It is not copied into a route summary whose own event stream cannot observe descendant changes.

The screen must not use `inactive` as an unexplained synonym for several different durable states. Failed, archived, stopped, cancelled, unknown, and unavailable remain distinguishable.

### Key behavior

Key ownership follows this precedence:

1. Secret entry, model and effort selection, command search, notices requiring acknowledgement, and other modal surfaces retain their existing keys.
2. A non-empty conversation composer retains ordinary editing behavior.
3. A historical conversation rejects Left and `/agents` navigation with `Return to live with /live before opening Agents`.
4. An Agents-view search query retains text-editing behavior.
5. Agents navigation handles the remaining keys.

The Agents view uses:

- Up and Down: move selection without wrapping.
- Page Up and Page Down: move by one visible page.
- Enter or Right: open the selected exact route.
- Left with an empty search field: move one scope toward workspace scope.
- Left at workspace scope: remain at workspace scope.
- Escape with search text: clear the search.
- Escape with an empty search field: close the Agents view and return to the unchanged return route.
- Printable input: enter or update search; it never becomes a task prompt.

Opening a route closes the Agents view and returns focus to the conversation composer. Pressing Left again reopens the prior parent scope with that route selected.

### Repeated ancestry traversal

For a retained route:

```text
root / main
└── reviewer / main
    └── verifier / main
        └── reproduction / main
```

Left from `reproduction` opens the `verifier` scope with `reproduction` selected. Another Left opens the `reviewer` scope. Another Left opens the `root` scope. Another Left opens workspace scope. Left at workspace scope is a no-op. Escape returns to the unchanged conversation route.

Traversal follows retained exact route edges. It never chooses a route because it has a similar name or was used recently.

### Opening working and ended routes

Every row has one interaction state:

- **interactive:** idle, running, or stopped routes that support the existing conversation behavior;
- **inspect-only:** failed or archived routes whose committed transcript and cells remain readable;
- **unavailable:** missing or unreadable retained references.

Enter or Right opens interactive and inspect-only routes. Inspect-only conversations visibly disable task submission and explain the retained lifecycle state. Unavailable rows remain visible but cannot open.

A completed or cancelled child task does not automatically make its session inspect-only. Retained child follow-up remains available when the session lifecycle supports it.

Inspect-only behavior is controller-enforced rather than a visual convention:

- read-only inspection commands, `/agents`, `/tree`, `/sessions`, `/history`, `/live`, help, and raw diagnostics remain available;
- independent workspace actions such as `/new` and an explicit `/sessions select` remain available because they do not mutate the inspect-only route;
- free-text submission and every current-route mutation are rejected, including cells or model runs, `/branch`, `/resume`, model or effort changes, task cancellation, goals, heartbeats, schedules, refinement, compaction, skill invocation, and other effectful route commands;
- command metadata classifies every command as read-only, navigation, independent workspace control, or current-route mutation; an unclassified command fails closed in inspect-only mode.

The runtime and domain services remain the authority for lifecycle transitions. The terminal policy is a product guard, not a security boundary or permission to weaken server validation.

### Search

Search matches:

- session name;
- branch name;
- retained task summary;
- model label;
- visible lifecycle and activity labels.

Search results retain enough ancestors to show each match's path. Matching descendants remain under their exact root family. Internal IDs are not part of ordinary search display, but remain available in raw diagnostics.

Search, selection, expansion, scope, and scroll position are disposable client state.

### Existing direct-child summary

The compact direct-child summary remains in the conversation view.

- Down focuses the summary.
- Enter or Right opens the Agents view scoped to the current route, with its direct children visible.
- Up and Down select routes in the Agents view.
- Enter or Right opens the selected route.
- Left moves to the current route's parent scope.

The old direct-child browser implementation is retired after the new Agents view covers its behavior. `/tree` remains a structured diagnostic inspector for the current nuclear family.

### Commands

- `/agents` opens the workspace Agents view.
- `/tree` continues to inspect the current route's parent, siblings, direct children, tasks, and mailbox.
- `/sessions` continues to show the flat retained branch catalog for diagnostics.
- `/sessions select NAME|ID` remains the explicit action that changes the workspace's remembered resume selection.

Opening a route in the Agents view does not call `productSelect`. Detaching while observing an unrelated route therefore does not silently change the next no-argument `agencity` selection.

## Route graph semantics

### Exact hierarchy

Every visible row represents an exact route or an unavailable retained route reference.

- A root session's initial branch is a workspace root route.
- A child session's initial branch is attached to the exact parent session and branch recorded by its task edge.
- A later branch is attached to its exact `BranchCreated.parentBranchId` route in the same session.
- A child admitted from a non-initial parent branch appears under that exact branch.
- An unavailable child task target appears beneath the route that admitted it.

The graph must not infer parentage from session names, timestamps, branch labels, task text, or current product selection.

### Branch presentation

Rows display `session name / branch name`. A branch edge and child-agent edge use distinct text markers so users can tell whether they are entering alternate history or delegated work.

The route graph may contain several branches of one session. Each branch remains independently selectable and keeps its own status, cursor, messages, cells, effects, and descendants.

### Activity and lifecycle

The Agents view presents activity separately from session lifecycle.

Activity is one of:

- `working`;
- `idle`;
- `attention`;
- `ended`;
- `unavailable`.

Lifecycle remains the exact session status:

- `running`;
- `idle`;
- `stopped`;
- `failed`;
- `archived`.

Bounded reasons preserve blocked, failed, budget-exceeded, unknown, cancellation-pending, cancelled, archived, and missing-state distinctions without copying raw provider output or error text into a workspace roster.

Unknown and unavailable never render as idle or successful.

## Product protocol

### Workspace agent catalog

Add a managed product endpoint separate from `AgentService.listFamily`:

```http
GET /product/agents?revision=REVISION&cursor=CURSOR&limit=200
```

The endpoint returns a typed `WorkspaceAgentCatalogPage`:

```ts
interface WorkspaceAgentCatalogPage {
  workspaceId: string;
  revision: string;
  totalRoutes: number;
  items: WorkspaceAgentRoute[];
  nextCursor: string | null;
  unchanged: boolean;
}
```

Each `WorkspaceAgentRoute` includes:

- `sessionId`;
- `branchId`;
- `routeKey`;
- `routeKind: "root" | "child" | "branch" | "unavailable"`;
- `parentRouteKey`;
- `rootSessionId`;
- `sessionDepth`;
- `taskId`;
- session and branch display names;
- task summary and task status;
- model configuration;
- session lifecycle;
- activity and bounded reason;
- cancellation-request state;
- active-goal and unresolved-work counts;
- created and updated timestamps;
- interaction state: `interactive`, `inspect-only`, or `unavailable`.

The product capability document adds `workspaceAgentCatalog`. Clients that connect to an older or reduced placement report the view as unavailable instead of falling back to a misleading flat or partial tree.

`sessionDepth` is the durable child-session depth enforced by `AgentService` and defaults to a maximum of eight. Branch ancestry is a separate route relation and does not increment session depth. The client derives display indentation iteratively from `parentRouteKey`; display depth is not canonical and is bounded by the number of routes in the validated graph.

### Pagination and revision

The endpoint never silently truncates the workspace:

- pages use a deterministic opaque cursor;
- every page belongs to one immutable catalog revision;
- the client continues until `nextCursor` is null;
- the TUI shows explicit loading progress while later pages arrive;
- if a revision expires during paging, the client discards the partial graph and restarts from the new revision;
- a completed client may send its last revision and receive `unchanged: true` without retransferring rows.

The managed service may retain recent immutable catalog revisions in a bounded in-memory cache. That cache is disposable and reconstructible.

### Authorization boundary

`GET /product/agents` is an owner-facing managed product surface for the current workspace. It does not alter:

- `GET /sessions/:session/agents`;
- `sdk.agents.list()`;
- mailbox target authorization;
- model context scope;
- console SQL policy;
- child task ownership.

The model-facing family API remains nuclear-family-only. The TUI must not recursively call it to construct a workspace catalog.

## Catalog construction and performance

### Storage read projection

Add a storage read that enumerates workspace-owned route tips and retained edges in one bounded query. It may join existing `sessions`, `branches`, and task projections, but it does not create a new canonical event or mutable identity table.

The read returns enough data to:

- identify every workspace route;
- identify exact child and branch parents;
- detect missing retained targets;
- determine each route's latest canonical cursor;
- load only changed route snapshots.

If the storage contract gains a bulk workspace-route method, local and HTTP-backed placements receive the same typed capability and conformance coverage. Unsupported remote placement must report the capability as unavailable.

### Incremental catalog cache

The managed product service owns a disposable cache:

1. Read ordered route identities, edges, dependency fingerprints, and tip cursors.
2. Derive a revision from that ordered material.
3. Reuse route summaries only when their complete dependency fingerprints agree.
4. Rebuild changed summaries through cached deterministic projections.
5. Recompute root-family aggregate activity from the complete graph.
6. Sort and page the immutable graph.

A route-summary dependency fingerprint includes:

- the route's own latest canonical cursor;
- the latest session-name event across every branch of that session;
- the inbound parent-task version that supplies child task status, cancellation, and activity;
- the branch or child edge identity and source cursor;
- any other route whose canonical projection supplies a displayed field.

Synchronization, branch creation, task admission, parent-task changes, session naming on another branch, branch naming, status changes, goals, run outcomes, and unknown effects must invalidate every dependent summary. Tests prove cross-route invalidation rather than assuming an own-route tip is sufficient.

A cache miss or process restart rebuilds from canonical events and projections. Cache loss never loses agent identity or changes hierarchy.

Ordinary cold construction uses one bulk storage read for workspace routes, edges, tips, dependency versions, and valid current snapshots. It must not make one protocol or placement round trip per route. Missing or stale snapshots use a topological workspace rebuild that shares projected parent state at branch fork points and does not independently replay the same inherited history for every descendant branch. Rebuilt snapshots remain disposable and are persisted through the existing snapshot contract.

The benchmark records physical rows read and events reduced. A cold rebuild may be more expensive than an unchanged refresh, but its work must be bounded by the workspace's unique retained routes and events rather than route count multiplied by inherited history.

### Refresh

The TUI refreshes the catalog:

- when the Agents view opens;
- after a successful route transition before the next Agents view opens;
- while the Agents view remains open;
- once after reconnect.

Refreshes are revision-based, coalesced, and generation-checked. Only one refresh may be in flight. A failed refresh preserves the last complete graph, marks it stale, and never invents an idle or ended state.

No workspace-catalog polling continues after the Agents view closes.

### Scale verification

Benchmarks cover:

- 100 routes with 5,000 events per route;
- 1,000 mixed root, child, and branch routes;
- a child-session chain at the configured `AgentService.maxDepth` and a separate 100-branch lineage;
- cold catalog construction;
- unchanged warm refresh;
- one-route invalidation;
- complete paged transfer and rendering.

The acceptance threshold records latency and query work rather than embedding an unsupported production-scale claim. An unchanged warm refresh must not replay all branch histories.

## Terminal state model

Add disposable `TerminalAgentsNavigation` state:

```ts
interface TerminalAgentsNavigation {
  open: boolean;
  returnRoute: { sessionId: string; branchId: string };
  scopeRouteKey: string | null;
  selectedRouteKey: string | null;
  query: string;
  revision: string | null;
  refresh: "current" | "loading" | "stale" | "unavailable";
  loadedRoutes: number;
  totalRoutes: number | null;
  generation: number;
}
```

The controller derives visible rows and ancestor paths from the complete route graph. Route transitions reuse the existing snapshot-first, serialized, generation-checked switch primitive.

Opening a selected route:

1. verifies the selected row is resolvable;
2. fetches and validates the exact target snapshot;
3. aborts and awaits the old branch watch;
4. clears route-local provisional output and interrupt state;
5. installs the exact target route and snapshot;
6. starts one target snapshot-plus-cursor watch;
7. closes the Agents view;
8. restores conversation focus.

The transition does not append an event or call product selection.

## Responsive rendering

### Normal and wide terminals

- The Agents view replaces the conversation body.
- The search field and selected route remain visible.
- Rows show session, branch, activity, lifecycle, model, task summary, and unresolved-work count when width permits.
- Indentation and text markers show derived display depth and edge kind.

### Narrow terminals

- The full-screen hierarchy remains available.
- Rows prioritize name, branch, status, and derived display depth.
- Model, timestamps, and task detail collapse before navigation controls.
- The selected row and its complete ancestry appear in a compact detail line.

### Very short terminals

- Preserve header, search, one selected row, and trusted-local footer.
- Page movement remains available.
- Do not render a zero-height list or overlapping controls.

### Accessibility

- Color is supplementary.
- Every state has a text label and marker.
- Selection is visible without color.
- Long paths preserve root and selected labels while collapsing middle ancestry.
- Enter, Return, linefeed, keypad Enter, and common CSI arrow sequences share behavior.

## Security and architecture invariants

- The TUI remains a public protocol client and never opens the workspace database.
- Workspace browsing does not broaden model or console authorization.
- Route opening executes no effect and bypasses no outbox boundary.
- Navigation does not mutate canonical history.
- Missing or corrupt route state remains unavailable.
- Raw credentials, known secret values, provider output, and unbounded errors do not enter catalog labels.
- Internal IDs remain hidden in ordinary rendering and available through scrubbed diagnostics.
- Trusted-local authority remains visible in every layout.
- A client crash loses only disposable browser state.

## Delivery sequence

### 1. Typed route graph

- Define workspace catalog and route types.
- Add exact child and branch edge derivation.
- Add lifecycle, activity, interaction-state, and bounded-reason derivation.
- Add deterministic graph validation and ordering.
- Preserve unavailable retained edges.

### 2. Efficient catalog read

- Add the workspace route-tip storage read.
- Refactor product catalog projection to reuse snapshots and unchanged summaries.
- Add immutable revision and pagination support.
- Add cold, warm, changed-route, and scale benchmarks.

### 3. Product protocol

- Add the managed product endpoint and capability.
- Add typed client methods.
- Add revision-expiry and unavailable-capability errors.
- Keep family and console SDK contracts unchanged.

### 4. Terminal controller

- Add Agents-view state, graph loading, search, scope, selection, and refresh.
- Add Left entry from root and nested conversations.
- Replace direct parent-conversation Left with parent-scope entry.
- Reuse race-safe route switching without product selection.
- Preserve prior scope and selection when a route is opened and revisited.

### 5. OpenTUI screen

- Build the full-screen Agents view and virtualized route rows.
- Add search and responsive key hints.
- Connect the direct-child summary to the new scoped view.
- Change `/agents` to open the workspace screen and retain `/tree` diagnostics.
- Add inspect-only conversation treatment.

### 6. Product verification and documentation

- Add projection, protocol, controller, rendering, performance, and installed-product tests.
- Update the user guide, protocol and API references, verification claims, and command help.
- Update `AGENTS.md` only after implementation and verification are complete.

## Expected implementation areas

- `src/product/catalog.ts` — workspace route graph, revision, paging, and summary caching.
- `src/product/service.ts` — managed workspace catalog hook.
- `src/storage/contract.ts` — efficient workspace route-tip read contract.
- `src/storage/libsql.ts` — local route and edge query.
- `src/placement/` — capability and conformance updates if the storage read crosses placement.
- `src/protocol/server.ts` — product Agents endpoint.
- `src/protocol/client.ts` — typed catalog client.
- `src/tui/view-model.ts` — graph rows, paths, search, activity, and responsive view data.
- `src/tui/index.ts` — Agents-view state, refresh, scope traversal, and route transitions.
- `src/tui/opentui.ts` — full-screen screen, search, virtualized list, and key handling.
- `src/tui/detail-model.ts` — retain `/tree` and `/sessions` diagnostics.
- `test/unit/` — graph, catalog, controller, rendering, input, and responsive behavior.
- `test/integration/` — protocol, exact route graph, storage, refresh, and performance.
- `test/e2e/opentui-pty.test.ts` — installed multi-level navigation and retained-route inspection.
- `README.md`, `docs/user-guide.md`, `docs/protocol.md`, `docs/api.md`, `docs/verification.md`, and `AGENTS.md` — shipped behavior and evidence.

## Test plan

### Route graph

- One root produces one workspace root route.
- Multiple roots remain separate.
- Child routes attach to exact parent branches.
- Children admitted from non-initial branches attach correctly.
- Branches attach to exact source branches.
- Child traversal remains deterministic through the configured session-depth limit, including the default maximum of eight.
- Branch traversal remains deterministic through long branch lineages without treating branch depth as session depth.
- Duplicate names never merge routes.
- Missing child sessions or branches remain visible and unavailable.
- Cyclic, cross-workspace, or malformed edges fail closed.
- Physical owned-scope deletion removes only data that no longer exists by contract; retained unavailable references remain explicit.

### Activity and lifecycle

- Running work appears working.
- Resumable stopped work remains visibly stopped and idle.
- Failed work appears attention and inspect-only.
- Archived work appears ended and inspect-only.
- Cancelled child tasks remain visible.
- Unknown effects remain attention.
- Missing state remains unavailable.
- A completed child task with a follow-up-capable session remains interactive.

### Catalog and protocol

- Only routes owned by the selected workspace are returned.
- Pages are stable within one revision.
- All pages reconstruct the same deterministic graph.
- Revision expiry forces a clean restart.
- Unchanged refresh transfers no route rows.
- One changed route does not replay unrelated branch histories.
- A session rename on one branch invalidates every branch summary for that session.
- A parent-task change invalidates the related child row even when the child's own tip is unchanged.
- Descendant activity changes recompute the root family's aggregate section.
- Direct family and console SDK calls remain nuclear-family-only.
- Unsupported placement returns a typed capability error.

### Controller

- Root Left opens workspace scope with the root selected.
- Nested Left opens the exact parent scope with the current route selected.
- Repeated Left reaches every ancestor and then workspace scope.
- Left at workspace scope is a no-op.
- Escape returns to the unchanged conversation.
- Opening another root does not call `productSelect`.
- Opening a failed or archived route enters inspect-only conversation mode.
- Inspect-only mode rejects every classified current-route mutation and fails closed for an unclassified command.
- Unavailable routes cannot open.
- Rapid open, Left, and refresh input cannot let stale state win.
- Every completed transition owns exactly one branch watch.
- Navigation clears route-local provisional state without cancelling work.

### OpenTUI

- Non-empty drafts retain all cursor behavior.
- Search text retains editing behavior.
- Escape clears search before closing the screen.
- Up and Down do not wrap.
- Page movement keeps the selection visible.
- Right and all Enter variants open exactly one route.
- Existing modal and secret-input keys take precedence.
- Wide, narrow, compact, and minimum-height frames remain usable.
- Search results retain matching ancestry.
- Working, attention, idle, ended, inspect-only, and unavailable rows remain understandable without color.
- Refresh preserves the selected route when it still exists.

### Installed product

A linked `agencity` executable in a fresh external repository must:

1. create at least two root sessions;
2. create a retained child chain at least three levels deep;
3. retain an idle route and an ended or failed route;
4. press Left from the deepest conversation and open its parent scope;
5. repeat Left until the global workspace view appears;
6. find and open the idle and ended or failed routes without internal IDs;
7. return to the original nested route;
8. prove browsing did not start, stop, retry, cancel, or duplicate work;
9. detach and prove the remembered product route did not change;
10. keep provider credentials absent from pseudo-terminal output.

The black-box test must use only the installed product and public protocol-backed TUI.

## Completion criteria

The feature is complete when:

1. Left from any live empty conversation opens the correct Agents scope.
2. Repeated Left reaches every retained ancestor and workspace scope.
3. The workspace view includes every retained route, including idle, stopped, failed, archived, ended, and unavailable records.
4. Enter or Right opens an exact interactive or inspect-only route.
5. Drafts, search, modals, and historical inspection retain their authority.
6. Browsing never changes product resume selection or execution ownership.
7. Workspace catalog reads are revisioned, paged, and efficient on unchanged refresh.
8. The model-facing family boundary remains unchanged.
9. Wide, narrow, and very short terminals expose the same navigation semantics.
10. Unit, integration, performance, OpenTUI frame/input, and installed pseudo-terminal tests cover the complete path.
11. `bun run typecheck`, `bun run check:architecture`, relevant focused suites, and `bun run verify` pass.
12. Public documentation and `AGENTS.md` describe the shipped behavior and remaining limits accurately.

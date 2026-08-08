# Workspace Agents view plan

**Status:** Implemented
**Date:** August 8, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Extends:** [Ergonomic agent-family navigation](./2026-08-07-ergonomic-agent-family-navigation-plan.md)

## Summary

Agencity already supports ergonomic navigation inside one retained agent family:

- Right or Enter opens the current route's direct-child browser.
- Up and Down select a child.
- Right or Enter opens the selected child conversation.
- Left from an empty child composer opens its exact parent conversation.
- Repeating Left climbs the retained ancestry one conversation at a time.

The remaining gap is above the root. Left has no action on a top-level root conversation, and the terminal has no full-screen selector for previous root sessions.

This plan adds one new navigation boundary:

```text
workspace Agents view ← root conversation ← child ← grandchild
```

Existing parent and child navigation remains unchanged. Left opens the workspace Agents view only when the current conversation is a top-level root. `/agents` provides a direct shortcut to the same screen from any live conversation.

## Goals

- Make every retained top-level workspace session visible in one terminal screen.
- Include running, idle, stopped, failed, and archived root work.
- Preserve the existing Left-to-parent and Right-to-children behavior at every nested level.
- Let a user climb from any child to the root and press Left once more to reach the workspace screen.
- Open an exact resumable root route without internal IDs.
- Use the existing product session catalog and selection semantics.
- Preserve drafts, modal controls, historical inspection, and durable runtime ownership.
- Keep the change confined to product catalog presentation and terminal navigation.

## Non-goals

- Replacing the existing direct-child browser.
- Adding a workspace-wide descendant graph.
- Showing child sessions in the workspace screen.
- Changing family authorization, task ownership, mailbox behavior, budgets, or cancellation.
- Opening failed or archived sessions that the product catalog classifies as non-resumable.
- Adding new canonical events, tables, migrations, or storage contracts.
- Adding live workspace event aggregation.
- Adding session deletion, rename, stop, resume, or creation controls to the first version.
- Changing the model-facing `sdk.agents` API.

## Terms

- **Root conversation:** A route whose session has no retained parent session.
- **Nested conversation:** A child session route with an exact retained parent route.
- **Workspace Agents view:** A full-screen selector containing retained root-session branches in the current workspace.
- **Resumable row:** A root route whose session status is not `failed` or `archived`.
- **Non-resumable row:** A visible failed or archived root route that cannot be opened from the selector.

## Interaction

### Conversation navigation

The existing rules remain:

- Empty nested composer + Left opens the exact parent conversation.
- Repeating Left climbs one exact retained parent route at a time.
- Down focuses the direct-child summary.
- Right or Enter opens the current direct-child browser.
- Right or Enter in that browser opens the selected child.

The new rule is:

- Empty top-level root composer + Left opens the workspace Agents view.

The terminal determines root status from the current retained family projection. It does not infer root status from a missing UI row, display name, branch name, or recent-session preference.

### Workspace Agents view

The workspace Agents view is a full-screen product surface modeled on Prime Agent's top-level Agents screen. It replaces the conversation body while open and retains:

- an `Agents` header;
- the workspace label;
- a search field;
- grouped retained root rows;
- the trusted-local footer;
- current key hints.

Rows use the existing `ProductBranchSummary` identity and fields:

- session and branch names;
- exact session and branch IDs internally;
- model;
- session status;
- task summary;
- unresolved-work count;
- active-goal count;
- created and updated timestamps.

Child sessions are excluded with `root === true` filtering. Every branch of a root session remains eligible. When one root session has multiple branches, rows show `session name / branch name`; a single-branch session may omit the redundant branch suffix.

### Sections

Rows are grouped by exact retained session status:

1. **Running**
2. **Idle**
3. **Stopped**
4. **Failed**
5. **Archived**

Failed and archived rows remain visible. They are marked non-resumable and cannot be opened. The screen does not relabel several durable states as generic `inactive`.

Rows sort within each section by:

1. most recent `updatedAt`;
2. normalized session name;
3. normalized branch name;
4. session ID and branch ID as hidden stable tie-breakers.

### Keys

The workspace Agents view uses:

- Up and Down to move selection without wrapping.
- Page Up and Page Down to move by one visible page.
- Enter or Right to open the selected resumable route.
- Enter or Right on a failed or archived row to show a clear non-resumable notice.
- Left at workspace scope to remain on the workspace screen.
- Ctrl-R to refresh the catalog without changing search text.
- Escape with search text to clear the search.
- Escape with an empty search field to return to the conversation that opened the screen.
- Printable input to update search.

Search matches session name, branch name, task summary, model, and exact visible status. Search text is never submitted as a task.

### Draft and modal safety

Key ownership follows this order:

1. Secret entry, model and effort selection, command search, and other active modal surfaces retain their keys.
2. A non-empty conversation composer retains ordinary cursor behavior.
3. Historical inspection rejects root Left and `/agents` with `Return to live with /live before opening Agents`.
4. The workspace Agents view owns search and list-navigation keys.
5. Root Left navigation handles the remaining empty-composer case.

No navigation action discards, submits, stashes, or rewrites a draft.

### Opening a root route

Opening a resumable row is an explicit top-level product selection:

1. Call the existing `productSelect(sessionId, branchId)`.
2. Reuse the existing serialized, snapshot-first route transition.
3. Close the workspace Agents view.
4. Focus the selected root conversation.
5. Preserve one snapshot-plus-cursor branch watch.

Unlike temporary parent/child browsing, selecting a root from the workspace screen updates the workspace's remembered resume route. A later no-argument `agencity` invocation resumes that selected root.

Opening the screen by itself changes no preference, event, execution owner, task, run, or effect.

## Commands

- `/agents` opens the workspace Agents view from any live conversation.
- `/tree` continues to show the current route's retained parent, siblings, direct children, tasks, and mailbox.
- `/sessions` continues to show the flat diagnostic branch catalog.
- `/sessions select NAME|ID` remains the command form of explicit root or branch selection.

Changing `/agents` from a nuclear-family inspector to the workspace screen is intentional. `/tree` preserves access to the former diagnostic content.

## Data and protocol

The first version uses the existing managed product route. Its current client method is untyped:

```ts
AgentClient.productSessions(): Promise<any[]>
```

The implementation changes that client signature to `Promise<ProductBranchSummary[]>` without changing the wire route or payload. `ProductCatalog.list()` already returns every retained branch in the workspace, including:

- display names;
- model;
- exact lifecycle status;
- task summary;
- unresolved-work and active-goal counts;
- timestamps;
- `root` and `initialBranch` classification.

No new product endpoint or family API is required.

The terminal fetches the catalog:

- when the workspace Agents view opens;
- when the user explicitly refreshes it;
- after a successful top-level selection before the next open.

The first version does not poll while the screen is open. It displays the catalog's fetch time and provides Ctrl-R to refresh. This avoids repeatedly replaying every retained branch through the current `ProductCatalog.list()` implementation. Live revision-based refresh is deferred until the catalog has a measured incremental projection.

A failed refresh keeps the prior complete rows visible with a stale marker. It does not clear the list or invent a new status.

## Terminal state

Add disposable workspace-screen state:

```ts
interface TerminalWorkspaceAgentsState {
  open: boolean;
  returnRoute: { sessionId: string; branchId: string };
  rows: readonly ProductBranchSummary[];
  selectedKey: string | null;
  query: string;
  refresh: "loading" | "current" | "stale" | "unavailable";
  fetchedAt: string | null;
  generation: number;
}
```

The selected key combines exact session and branch IDs. Refresh preserves selection when the route remains present and otherwise selects the nearest visible resumable row, then the nearest visible row.

This state is client-local. A client restart reconstructs the catalog from the product service.

## Responsive rendering

### Normal and wide terminals

- The workspace screen replaces the conversation body.
- Rows show name, branch, status, model, task summary, unresolved work, and relative update time.
- Search and the selected row remain visible.

### Narrow terminals

- Rows prioritize session name, branch name, and status.
- Model, task detail, counts, and timestamps collapse in that order.
- The selected row remains distinguishable without color.

### Very short terminals

- Preserve the header, search field, one selected row, and trusted-local footer.
- Page movement remains available.
- Do not render a zero-height list or overlapping controls.

## Architecture and security invariants

- The TUI uses only `AgentClient.productSessions()` and `productSelect()`.
- The TUI does not open the database or call `Supervisor` directly.
- The workspace screen does not broaden model-facing family access.
- Root selection follows exact session and branch IDs.
- Opening the screen executes no effect and appends no canonical event.
- Failed and archived routes remain visible rather than being presented as absent.
- Unsupported or missing catalog capability fails visibly.
- Raw credentials and known secret values do not enter rows, search text, notices, or tests.
- Trusted-local authority remains visible in every layout.

## Delivery sequence

### 1. Pure workspace view model

- Filter `ProductBranchSummary` rows to roots.
- Group and sort exact statuses.
- Add search, fallback labels, resumable state, and stable selection keys.
- Add responsive row formatting.

### 2. Terminal controller

- Add workspace Agents state and one-shot refresh.
- Add root-only Left entry.
- Preserve nested Left-to-parent behavior unchanged.
- Add `/agents` entry and `/tree` diagnostic separation.
- Open selected roots through `productSelect` and the existing route transition.

### 3. OpenTUI screen

- Add the full-screen list, search, selection, refresh, notices, and footer hints.
- Add normal, compact, narrow, and minimum-height layouts.
- Preserve existing family summary and direct-child browser behavior.

### 4. Verification and documentation

- Add pure, controller, OpenTUI, and installed-product tests.
- Update user, command, protocol, and verification documentation.
- Update `AGENTS.md` only after implementation and verification are complete.

## Expected implementation areas

- `src/tui/view-model.ts` — root filtering, grouping, search, sorting, and row formatting.
- `src/tui/index.ts` — workspace catalog loading, state, root selection, and command routing.
- `src/tui/opentui.ts` — full-screen screen, keys, search, refresh, and responsive rendering.
- `src/tui/detail-model.ts` — retain the existing family diagnostic renderer for `/tree`.
- `src/product/catalog.ts` — no semantic change expected; optimize only if measurement shows the one-shot read is unacceptable.
- `test/unit/tui-workspace-agents-view-model.test.ts` — pure presentation behavior.
- `test/unit/terminal-ui.test.ts` — root detection, catalog refresh, and exact selection.
- `test/unit/opentui.test.ts` — key ownership and responsive frames.
- `test/e2e/opentui-pty.test.ts` — installed ancestry-to-workspace navigation.
- `README.md`, `docs/user-guide.md`, `docs/api.md`, `docs/protocol.md`, `docs/verification.md`, and `AGENTS.md` — shipped behavior and evidence.

## Test plan

### View model

- Child-session rows are excluded.
- Every branch of a root session remains visible.
- Running, idle, stopped, failed, and archived sections are exact.
- Failed and archived rows are visibly non-resumable.
- Duplicate names remain distinct through stable route keys.
- Search matches visible fields and never exposes IDs.
- Sorting is deterministic.
- Empty workspaces render a useful empty state.

### Controller

- Left from an empty nested composer opens the exact parent conversation, unchanged from current behavior.
- Repeated nested Left reaches the root conversation.
- Left from an empty root composer opens the workspace Agents view.
- Left with a draft retains cursor behavior.
- `/agents` opens the workspace screen from a live nested or root conversation.
- Historical mode requires `/live`.
- Opening the screen does not call `productSelect`.
- Opening a resumable row calls `productSelect` once with exact IDs.
- Failed and archived rows cannot open.
- A failed refresh preserves stale rows.
- Rapid open, close, refresh, and selection cannot let an old response replace current state.
- Each successful root selection leaves exactly one branch watch.

### OpenTUI

- Up, Down, Page Up, and Page Down keep selection visible.
- Enter and Right open one resumable row.
- Enter and Right show a notice for non-resumable rows.
- Escape clears search before closing.
- Left at workspace scope is a no-op.
- Existing family-summary and child-browser keys remain unchanged.
- Modal and secret-input keys retain precedence.
- Normal, narrow, compact, and minimum-height frames remain usable.
- Stale and unavailable catalog states remain explicit.

### Installed product

A linked `agencity` executable in a fresh external repository must:

1. create two retained root sessions;
2. create a root, child, and grandchild family;
3. open the grandchild;
4. press Left to return to the child;
5. press Left to return to the root;
6. press Left to open the workspace Agents view;
7. show both retained roots without internal IDs;
8. select the other root with Down and Right or Enter;
9. detach and confirm the selected root is the remembered resume route;
10. prove navigation did not duplicate, cancel, stop, or retry family work.

## Completion criteria

The feature is complete when:

1. Existing nested Left-to-parent and Right-to-child behavior is unchanged.
2. Left from a top-level root opens the workspace Agents view.
3. `/agents` opens the same screen from any live conversation.
4. Every retained root branch appears with its exact status, including failed and archived rows.
5. Only resumable rows can be opened.
6. Opening a root intentionally updates the remembered product selection.
7. Drafts, modals, and historical inspection retain their existing authority.
8. The implementation requires no new canonical event, table, migration, storage contract, or model-facing capability.
9. Unit, OpenTUI, controller, and installed pseudo-terminal tests cover the complete path.
10. `bun run typecheck`, `bun run check:architecture`, relevant focused tests, and `bun run verify` pass.
11. Public documentation and `AGENTS.md` describe the shipped behavior and limitations accurately.

## Implementation summary

Implementation completed on August 8, 2026.

### Delivered behavior

- `AgentClient.productSessions()` returns `Promise<ProductBranchSummary[]>`.
- The terminal view model filters root branches, groups exact statuses, applies deterministic sorting and visible-field search, retains stable route-key selection, and formats responsive rows without exposing internal IDs.
- The terminal controller owns disposable workspace Agents state, race-safe one-shot catalog refresh, stale-row preservation, historical-mode rejection, `/agents` and `/tree` command separation, and exact root selection through `productSelect`.
- Empty-composer Left opens the workspace Agents view only when the retained family projection classifies the current route as a root. Nested Left navigation remains parent-directed.
- The OpenTUI screen replaces the conversation while open, preserves the trusted-local footer and search composer, renders the human workspace label, exact status sections, and retained-root counts, keeps variable-height selection visible, prevents hidden modal state, and keeps failed and archived rows visible but non-resumable.
- Successful root opening reuses the serialized snapshot-first route transition, leaves one branch watch, refreshes the catalog, and updates the remembered no-ID resume route.
- Catalog text and stale selection failures are scrubbed at the terminal boundary so workspace and route IDs remain internal.
- Public README, user, TypeScript API, protocol, verification, and canonical repository documentation describe the shipped behavior.

### Implementation deviations

- `src/product/catalog.ts` required no change because the existing catalog already supplied the required fields and root classification.
- The linked pseudo-terminal journey opens the workspace screen with `/agents` after climbing grandchild-to-child-to-root with Left. Deterministic OpenTUI input coverage separately proves that Left from an empty root composer opens the same screen and that Left with a draft retains editor behavior. This split avoids making the installed journey depend on terminal-specific root-Left timing while retaining behavioral coverage of both entry paths.

### Verification evidence

- Focused view-model, terminal-controller, and OpenTUI tests: 36 passed, 0 failed.
- Linked installed-product pseudo-terminal journey: 1 passed, 0 failed.
- `bun run typecheck`: passed.
- `bun run check:architecture`: passed.
- `bun run verify`: passed. The deterministic core reported 845 passed, 2 skipped, and 0 failed. Installed-product acceptance reported 14 passed, 1 skipped, and 0 failed.
- The skipped rows were external or dependency-gated checks: official Turso Sync server conformance, real Turso Cloud smoke, and the real-provider installed-product smoke. They are not claimed as verified.

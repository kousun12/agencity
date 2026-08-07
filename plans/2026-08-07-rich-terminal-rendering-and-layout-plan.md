# Rich terminal rendering and layout plan

**Status:** Implemented and verified  
**Date:** August 7, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Baseline:** [Ergonomic agent-family navigation](./2026-08-07-ergonomic-agent-family-navigation-plan.md) — implemented and merged. This plan builds on the shipped family summary row, family browser, breadcrumb ancestry, and parent/child route navigation, and must preserve them unchanged.

## Summary

Agencity's full-screen terminal previously rendered conversation and run activity as one plain text value, discarded Markdown and retained cell structure, reserved idle width for an informational inspector, and used asymmetric composer spacing plus one truncating footer string.

The implemented presentation improves the terminal without changing durable runtime semantics:

1. committed user and assistant messages render as structured Markdown;
2. fenced code and retained TypeScript cells use OpenTUI's syntax-aware renderers;
3. cells expose a compact status row with expandable source and output;
4. the composer becomes a symmetric, fixed dock with a visible prompt;
5. the footer prioritizes status and interaction hints by available width;
6. the conversation uses the full terminal width unless a contextual inspector is active.

The implemented agent-family navigation — the summary row between the composer and footer, the family browser in the contextual panel, breadcrumb ancestry in the header, and parent/child key navigation — is part of the baseline. This plan restyles shared surfaces around it and does not change its interaction semantics, status vocabulary, or route-switching behavior.

The implementation uses the existing `@opentui/core` dependency. OpenTUI already provides `MarkdownRenderable`, `CodeRenderable`, `SyntaxStyle`, bundled parser assets, and the `web-tree-sitter` peer currently resolved by the repository lockfile. Agencity does not copy Prime Agent's renderer or add `cli-highlight`.

## Problem

The current presentation has four related limitations.

### The transcript is flattened

`src/tui/opentui.ts` builds one string in `renderTimeline()` and assigns it to a single `TextRenderable`. Every role label, message, run, and step therefore shares one foreground color and one wrapping mode.

Consequences:

- Markdown headings, lists, emphasis, links, quotes, inline code, and fenced code render as plain characters;
- declared code languages cannot select a syntax parser;
- message blocks cannot use role-specific spacing or color;
- activity rows cannot use semantic status colors;
- streaming or committed block updates cannot preserve individual renderable identity.

### Cell presentation loses retained structure

`src/tui/view-model.ts` reduces a TypeScript action to the first non-empty source line. `TerminalStepView` carries the step label, a one-line detail, and the model-attempt count, but not:

- complete TypeScript source;
- cell lifecycle status;
- cell execution attempts;
- logs;
- result;
- error.

The durable projection already contains everything required: `AgentState.cells` retains each cell's full `code`, `status`, `attempts`, `logs`, `result`, and `error`, and the public protocol snapshot delivers the complete projected state to the client. The terminal simply does not present the generated program and its observation in the compact, inspectable form expected from a programmatic agent.

### The bottom dock is asymmetric

The composer surface is a bordered box with top padding and no bottom padding: three rows on ordinary terminals and two rows on terminals of ten rows or fewer. The family summary row and footer follow immediately, so the bottom area appears uneven even though the total row count is stable.

The footer joins trusted-local authority, the family-navigation hint, recovery state, attention count, budget, and command help into one truncating string. On very short terminals it already reduces to authority plus the family hint, but at ordinary heights OpenTUI truncates the right side when the string does not fit, which removes actionable hints before less important telemetry.

### The default inspector consumes conversation width

On every terminal at least 96 columns wide, the details panel remains visible and occupies 40 to 64 columns even when no contextual inspector is open. Its default session, run, budget, and recovery summary duplicates information already available in the header and footer. Long conversation and code lines wrap early while the panel remains mostly empty.

Transient notices also render inside this panel, so notice visibility is currently coupled to panel visibility.

## Goals

- Render committed conversation content as Markdown with language-aware fenced-code highlighting.
- Render retained TypeScript actions as syntax-colored, selectable source.
- Present cell status, source, logs, result, and error from durable projected state.
- Preserve compact activity summaries and the existing expand/collapse interaction.
- Give user, assistant, code, output, success, warning, and failure content distinct but restrained visual roles.
- Make the composer spacing symmetric and keep it stable during protocol updates and terminal resize.
- Keep trusted-local authority, connection state, and attention visible at every supported width.
- Preserve the most relevant active interaction hint instead of depending on right truncation.
- Give the conversation the full main area when no inspector is active.
- Preserve the implemented family summary row, family browser, breadcrumb, and parent/child key navigation unchanged.
- Keep all presentation state disposable and reconstructible from the public protocol projection.

## Non-goals

- Changing canonical events, durable session identity, cell execution, effects, recovery, or model behavior.
- Changing family-navigation interaction, its status vocabulary, or route-switching semantics.
- Parsing arbitrary assistant prose as executable TypeScript.
- Adding syntax highlighting to the composer.
- Adding a new Markdown or syntax-highlighting dependency when OpenTUI supports the required language.
- Supporting every language grammar in the first implementation. Unsupported fenced languages use a consistent plain-code style.
- Replacing OpenTUI with Prime Agent's terminal library.
- Reproducing Prime Agent's layout, colors, or component hierarchy exactly.
- Adding mouse interaction.
- Adding image, screenshot, golden-frame, or other visual regression coverage.
- Creating a user-selectable theme system. The first implementation defines one coherent dark terminal theme.

## Design principles

### Structure precedes styling

Color is applied to typed message, cell, output, and status roles. The implementation does not search arbitrary rendered strings for keywords such as `failed` or `typescript` to infer presentation.

### Color is supplementary

Every status retains a text label or marker. A terminal with reduced color capability remains understandable.

### Durable projections remain the source

Cell source and outcomes come from `AgentState.agentRuns` and `AgentState.cells`. The client does not read the database, parse internal event logs, or invent execution outcomes.

### Committed and provisional content remain distinct

Committed messages and cells render in the conversation timeline. Cursorless provider progress remains provisional and must not appear as committed transcript history. An inspector may use Markdown streaming mode for provisional content, but it must retain the existing discard-on-commit behavior.

### Width is allocated intentionally

Each component receives an explicit content width after padding, prefix, and inspector allocation. Truncation follows semantic priority rather than incidental string order.

## Chosen presentation

### Shared terminal theme

Add `src/tui/theme.ts` as the single owner of terminal presentation colors and syntax styles.

The theme defines:

- background, raised surface, border, primary text, muted text, and accent;
- success, warning, danger, and provisional tones;
- Markdown heading, emphasis, list, quote, link, inline-code, and code-block scopes;
- syntax scopes for comments, keywords, functions, variables, strings, numbers, types, operators, and punctuation.

The initial palette should retain the current dark background while adopting the restrained distinctions used by Prime Agent:

- blue or cyan for keywords and functions;
- muted green for strings;
- amber for numbers and types;
- muted gray for comments and secondary output;
- existing green, amber, and red status colors.

Create one `SyntaxStyle` for the `OpenTuiApp` lifecycle. Pass it to every Markdown and code renderable and destroy it with the app. Do not recreate the native style object on each presentation update.

The current lockfile resolves OpenTUI's exact `web-tree-sitter@0.25.10` peer, and OpenTUI resolves its tree-sitter worker and grammar assets through bundled-file imports rather than the process working directory. A direct root dependency is added only if the source/link installation test demonstrates that the peer is absent in a supported install. The plan does not change dependency ownership preemptively.

### Structured conversation blocks

Replace the single timeline text node with a reconciled collection of renderables keyed by durable presentation identity.

Each committed message uses:

- a compact role label;
- a `MarkdownRenderable` body;
- one consistent blank-row separation from adjacent messages.

User and assistant messages retain their exact content. The renderer configures:

- `conceal: true` for Markdown punctuation;
- `internalBlockMode: "top-level"` for stable block layout;
- word wrapping and selection;
- committed, non-streaming mode;
- the shared syntax style;
- plain-code fallback for unsupported language tags.

Role labels are semantic text renderables rather than inserted Markdown headings. User content therefore cannot merge with or restyle the next role label.

The transcript reconciler updates an existing message body when the same message identity changes in presentation state and replaces children only when the block structure changes. Committed messages normally remain immutable. Renderable identity must be stable: an unrelated presentation update — a family refresh, connection change, notice, or footer change — must not recreate existing Markdown or code renderables, because each recreation repeats native parsing work. A deterministic test asserts this identity stability.

The timeline remains a scroll container that follows new committed content at the bottom. Bottom-following over a reconciled child collection is verified explicitly: if OpenTUI's sticky scrolling does not preserve follow-until-the-user-scrolls-away semantics across changing children, the transcript host implements that behavior itself rather than assuming it.

Message bodies and cell source remain selectable. Selection within a block copies the exact underlying text; cross-block selection follows OpenTUI's renderer selection model and is covered by an interaction test.

### Typed cell activity

Extend `TerminalStepView` with an optional cell presentation:

```ts
interface TerminalCellView {
  id: string;
  language: "typescript";
  code: string;
  status: "pending" | "proposed" | "running" | "committed" | "failed" | "abandoned" | "missing";
  attempts: number;
  logs: readonly string[];
  result: JsonValue | null;
  error: string | null;
}
```

For a TypeScript action, `buildTerminalScreen()` resolves the stable cell ID as `agent-run-cell-${actionId}` and joins the action with the matching projected cell. `proposed`, `running`, `committed`, `failed`, and `abandoned` mirror the projected cell lifecycle. `pending` and `missing` are client-side presentation states for an absent expected cell record: while the owning run is still active, the join renders `pending` with neutral styling because the cell record may not have committed yet; once the run is terminal, an absent expected cell renders `missing` with danger styling. A committed action without an expected cell is never shown as completed.

Cell execution `attempts` come from the projected cell record. The existing model-attempt count on the step remains separate and keeps its current meaning.

The default activity row shows:

- status marker;
- `TypeScript`;
- first meaningful source line;
- source line count;
- output or error indicator when present;
- model attempt count when greater than one.

Expanded activity shows:

1. complete source through `CodeRenderable` with `filetype: "typescript"`;
2. logs in their original order;
3. bounded formatted result;
4. error text with danger styling.

The existing run expansion state remains client-local. The first implementation may keep `Ctrl-O` as the run-level expand/collapse control rather than adding a second cell-focus model.

Result formatting uses the existing safe bounded-inspection conventions. Large or artifact-backed output stays summarized and refers users to existing cell/history diagnostics rather than loading unbounded bytes into the TUI.

### Other activity rows

Run summaries remain text-based but use structured styled chunks:

- active: accent marker;
- succeeded or completed: success marker;
- waiting or budget-exceeded: warning marker;
- failed, blocked, or unknown: danger marker;
- cancelled or ended: muted marker.

Status derivation continues to come from the pure view model. Render code does not infer durable status from prose.

The family summary row already replaced the passive `AGENTS` timeline section. This work styles the shared activity vocabulary used by run rows, the family summary, and the family browser; it does not add child rows back into the conversation.

### Composer surface

Replace the asymmetric composer box with a three-row raised surface:

- no border;
- `paddingY: 1`;
- two columns of horizontal padding when width permits;
- one horizontal content row;
- explicit `flexShrink: 0`.

The content row contains:

- an accent-colored `›` prompt;
- the existing `InputRenderable` using the remaining width.

Hidden credential input, model entry, busy state, submission, paste, and draft preservation keep their current behavior. The prompt does not reveal secret length beyond the existing masked-input behavior.

At very narrow widths, horizontal padding reduces before the prompt or input is clipped. The input always retains at least one editable column.

The family summary keeps its own fixed row between the composer and footer, with its existing focus behavior, printable-input handoff, and browser opening unchanged. It does not become composer padding.

### Width-aware footer

Replace the single concatenated footer string with a footer box containing independently sized left and right text.

Left-side priority:

1. `TRUSTED-LOCAL`;
2. connection state when not connected;
3. attention count when nonzero;
4. recovery state when unhealthy;
5. compact budget usage.

Right-side priority:

1. active modal or inspector action;
2. the family-navigation hint;
3. `Ctrl-P commands`.

The existing family hint derivation — browser selection hints, summary focus hints, `← parent`, `↓ agents`, and the historical-mode notice — is preserved as-is. This plan changes the hint's placement and truncation priority, not its content or the conditions that produce it.

Wide terminals show all applicable values. Narrow terminals remove low-priority healthy and budget values before shortening actionable hints. Very short terminals keep one footer row and do not allow the footer to overlap the composer or main area.

### Contextual inspector

The details panel is hidden when no contextual content is active.

It becomes visible for:

- command palette;
- model picker and model entry;
- hidden credential setup;
- explicit structured detail;
- provisional provider output;
- the family browser;
- an active transient notice.

Transient notices continue to render in the contextual panel. An active notice makes the panel visible; when the notice expires and nothing else is active, the panel hides again. Notices on narrow terminals must not permanently replace the conversation.

On wide terminals, an active inspector uses the existing bounded side width. On narrow terminals, it replaces the main timeline while preserving the header, composer, family summary, and footer. Closing it restores the conversation without changing the route or committed state.

The default session, run, budget, recovery, and shortcuts summary is removed from the idle inspector because the inspector itself is no longer visible when idle.

### Responsive height

The current renderer special-cases terminals of ten rows or fewer by shrinking the composer and panel padding. Replace that ad-hoc adjustment with three explicit height modes in presentation code:

- **normal:** two-row header, three-row composer, optional family summary, one-row footer;
- **compact:** one-row header, two-row composer, optional family summary, one-row footer;
- **minimum:** one-row header, one-row composer, one-row footer, no optional summary or inspector detail beyond the required active control.

The main area retains at least one usable row. If the terminal cannot display an active modal safely, the modal renders a bounded compact instruction instead of overlapping another component.

## Architecture and security constraints

- The TUI remains a public protocol client.
- No canonical event, migration, table, or reducer change is introduced.
- Full cell data comes from the existing projected snapshot.
- Raw provider credentials never enter Markdown, syntax rendering, notices, or diagnostics.
- Existing `scrubText` handling remains in front of user-visible transient output.
- Markdown rendering does not enable HTML, terminal escape injection, arbitrary file loading, or code execution.
- Syntax parsing is presentation-only and cannot change the admitted action or executed source.
- Unsupported parser capability falls back visibly to plain code without changing content.
- Renderable, native syntax-style, and tree-sitter parser worker resources are destroyed when the app closes, so detach and exit remain clean.
- Trusted-local authority remains visible in every responsive layout.

## Delivery sequence

### 1. Theme and transcript foundation

- Add the shared terminal theme and syntax style.
- Extract transcript formatting and reconciliation from `opentui.ts` into a focused TUI module.
- Render committed user and assistant bodies with `MarkdownRenderable`.
- Keep role labels and run headers as independent semantic text.
- Preserve selection, bottom-following scroll, input drafts, inspector state, family summary focus and browser behavior, and cursorless progress behavior.

### 2. Durable cell projection and rendering

- Extend `TerminalStepView` with full typed cell presentation.
- Join TypeScript actions to stable projected cell records, with `pending` for active runs and `missing` only after the run is terminal.
- Add compact and expanded cell renderables.
- Render source with `CodeRenderable` and output with bounded text renderables.
- Keep missing, running, failed, abandoned, and unknown outcomes explicit.

### 3. Bottom dock and responsive layout

- Replace composer border/top-padding geometry with the symmetric raised surface.
- Add the prompt glyph and width-aware horizontal allocation.
- Split footer status and action hints, keeping the existing family hint content.
- Hide the idle inspector, define notice-driven visibility, and preserve active inspector behavior.
- Replace the ad-hoc very-short handling with the compact and minimum height modes.
- Keep the family summary row placement and focus behavior unchanged.

### 4. Product verification and documentation

- Add focused pure tests for timeline projection, cell joining, status tone selection, footer priority, and responsive mode selection.
- Add the renderable identity stability test for the transcript reconciler.
- Update existing OpenTUI frame and interaction assertions to the structured presentation. A structural rendering change alters existing frame output, so assertions change with it; the behaviors they verify — draft preservation, resize, inspectors, model setup, secret masking, task submission, family navigation, and detach — must continue to pass unchanged in meaning.
- Extend the installed pseudo-terminal smoke only as needed to prove that parser assets load and the interactive product remains usable.
- Run typecheck, architecture checks, focused TUI tests, the linked executable pseudo-terminal test, and the full verification gate.
- Update public TUI documentation where it describes the default inspector, transcript presentation, composer, or footer.
- Update `AGENTS.md` current status only after the richer rendering and layout are shipped and verified.

This verification does not add screenshot comparisons, golden terminal frames, pixel or span snapshots, or a visual regression system.

## Expected implementation areas

- `src/tui/theme.ts` — shared UI palette and `SyntaxStyle`.
- `src/tui/transcript.ts` — message, activity, and cell renderable construction and reconciliation.
- `src/tui/view-model.ts` — complete cell projection and pure status/presentation fields.
- `src/tui/opentui.ts` — transcript host, composer, footer, inspector visibility, responsive height, and resource lifecycle.
- `test/unit/opentui.test.ts` — updated frame and interaction assertions, renderer integration, and reconciler identity stability.
- a focused new unit test (for example `test/unit/tui-transcript.test.ts`) — pure cell joining, status and tone selection, footer priority, and responsive-mode rules.
- `test/unit/tui-family-view-model.test.ts` — existing family presentation coverage remains passing.
- `test/e2e/opentui-pty.test.ts` — installed interactive startup, task submission, family navigation, and detach smoke.
- `docs/user-guide.md`, `docs/capabilities.md`, `docs/verification.md`, and `AGENTS.md` — shipped behavior and verified capability claims where affected.

## Test plan

### Pure view model

- User and assistant content remains exact.
- TypeScript actions retain complete source.
- Stable action IDs resolve the correct cell and never another run's cell.
- An absent expected cell is `pending` while its run is active and `missing` once the run is terminal; neither is shown as completed.
- Logs, result, error, status, and cell attempts retain deterministic order and values.
- Status tone selection is exhaustive for current run, family, and cell states.
- Footer priority retains authority, active errors, and current actions before healthy telemetry.
- Responsive mode selection is deterministic at boundary heights.

### OpenTUI interaction

- Markdown and code renderables accept committed message and cell content without changing the underlying text.
- Unsupported fenced languages fall back to plain code.
- An unrelated presentation update — family refresh, connection change, or notice — does not recreate existing committed message or cell renderables.
- Expanding activity exposes complete cell source and bounded output.
- Collapsing activity restores the compact row.
- Presentation updates preserve an in-progress composer draft.
- Bottom-following continues for new committed content and stops while the user is scrolled away, asserted against the reconciled child collection rather than a single text node.
- Selection within a message or cell block copies the exact underlying text.
- Family summary focus, browser selection, and parent/child navigation keys behave identically on the structured layout.
- Active inspectors retain existing key ownership.
- Narrow inspectors replace the timeline without hiding the composer or footer.
- Transient notices appear without an idle inspector and do not permanently replace the conversation on narrow terminals.
- Secret input remains masked and absent from transcript, notices, and errors.
- Resize does not create overlapping composer, footer, family summary, or inspector regions.

### Installed product

A linked `agencity` executable in a fresh external repository must:

1. open the full-screen interface;
2. accept and run a task that produces a TypeScript cell;
3. retain the committed assistant response and cell in history;
4. accept another composer submission after the rich transcript has rendered;
5. detach cleanly;
6. resume the same durable work without duplicating the cell or model call.

The installed smoke verifies product operation rather than terminal appearance. The existing installed family-navigation journey must continue to pass on the structured layout.

## Completion criteria

The work is complete when:

1. Committed Markdown no longer renders as undifferentiated plain text.
2. Supported fenced code and retained TypeScript cells receive syntax-aware presentation.
3. Expanded cell activity shows the exact retained source and bounded retained outcome.
4. Failed, unknown, missing, and interrupted cell states remain explicit, and active runs are not misreported as missing.
5. The composer has symmetric vertical spacing and stable horizontal prompt alignment.
6. The footer preserves trusted-local authority and the current actionable hint at supported widths.
7. The idle conversation uses the full main width, while active inspectors and transient notices remain accessible and responsive.
8. The implemented family summary, browser, breadcrumb, and navigation keys behave identically on the structured transcript and symmetric bottom dock.
9. Existing secret handling, draft preservation, resize, detach, resume, family navigation, and snapshot-plus-cursor behavior remain correct.
10. `bun run typecheck`, `bun run check:architecture`, focused tests, the installed pseudo-terminal smoke, and `bun run verify` pass.
11. Public documentation and `AGENTS.md` accurately describe shipped behavior and remaining language or terminal limitations.

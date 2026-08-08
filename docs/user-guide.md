# User guide

Agencity is a terminal-first agent runtime. It keeps each agent session, task, branch, tool effect, and result in durable local storage so work can be inspected and resumed after a terminal or process exits.

Agencity is trusted-local software. Model-generated TypeScript and shell commands run with the operating-system authority of the Agencity process. Use a dedicated OS account or an external sandbox when the workspace or generated code is not fully trusted.

## Start in a repository

Run Agencity from the repository you want it to work in:

```sh
agencity
agencity "inspect this repository and explain the test failures"
```

Agencity discovers the nearest repository root, creates or resumes durable work, and opens the terminal interface. Normal use does not require session IDs, branch IDs, or database paths.

Use a non-interactive run when a script needs a terminal result:

```sh
agencity run "run the relevant checks and report failures"
agencity run --json "summarize the current repository state"
```

To use a command-like phrase as task text, put `--` before it:

```sh
agencity -- run the benchmark and explain the result
```

## First-run provider setup

New work requires an explicit model provider and model ID. On the first interactive launch without a usable provider, Agencity:

1. asks for OpenAI, Anthropic, or Vercel AI Gateway;
2. accepts the API key through hidden terminal input; and
3. asks for the exact model ID before creating the session.

The key is saved in an owner-only `auth.json` beside the profile database. It is not stored in workspace history or profile preferences. Environment credentials are also supported. See [Configuration](./configuration.md) for variables and precedence.

Open the provider and model inspector at any time:

```text
/model
```

Use Up/Down to select a provider, `L` to enter a key, and `X` to remove a stored key. Press Enter on a usable provider, type to filter its catalog models, use Up/Down to choose a match, and press Enter to select it. An exact canonical model ID remains accepted when the catalog has no match. Direct forms are also available:

```text
/model login openai
/model openai:openai/gpt-5.6-sol
/model login vercel
/model vercel:openai/gpt-5.6-sol
```

Model identifiers use `provider:creator/model`. The model part is the canonical Vercel AI Gateway catalog ID. A session branch retains its selected model; starting Agencity again does not silently replace it. Create new work to use a different model:

```sh
agencity new --model openai:openai/gpt-5.6-sol --effort high "start a separate review"
```

Reasoning effort is retained with the branch model. Open the effort inspector with `/effort` (or `/thinking`), use Up/Down and Enter to select a catalog-supported level, or enter a direct command such as `/effort high`. `/effort refresh` refreshes the public Gateway catalog. `provider-default` omits an explicit reasoning override and lets the selected provider decide.

The inspector distinguishes catalog-listed, unverified, unsupported, and stale capability data. An explicit unsupported selection fails. A stored choice that becomes invalid falls back visibly to `provider-default`. The available levels are `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.

Agencity has no product demo mode or credential-free fallback. Internal deterministic providers are test-only and do not appear in product selection.

## Tasks and runs

A task is the instruction you give Agencity. A run is one durable attempt to carry that task forward. Every autonomous model step must make exactly one formal choice:

- `bun_console`, which submits a TypeScript cell using the console SDK for files, shell commands, SQL, models, subagents, memory, skills, or artifacts;
- `finish`, which returns a successful answer or an explicit blocked or failed result.

These are declaration-only provider tools. They do not execute at the provider and have no execute callbacks. Only a validated, durably committed `bun_console` action can start a disposable TypeScript cell. The APIs available inside that cell are a separate layer, not additional provider tools.

Every autonomous response must contain exactly one valid call from the fixed set. Provider narration is diagnostic-only. Agencity does not search it for JSON or code and has no text-JSON or TypeScript fallback. If validation rejects a response, no submitted code executes; the model receives one bounded correction step with the exact error. A second consecutive rejection ends the run. Normal budget and step limits also apply to the correction.

If information is missing, `finish` returns a blocked response containing the question. Your later message starts an ordinary new run on the same branch; there is no separate input-response lifecycle.

Agencity records a requested external effect before executing it. A dependent model step starts only after the result is committed. A final answer may also be checked by a completion gate:

```sh
agencity run --completion-gate "bun test" \
  "fix the failing tests and verify the result"
```

The completion command runs through the same durable effect path as other shell work.

A successful finish is provisional until every required gate passes. Failed gates return repair evidence to the agent without publishing its proposed success message. An unknown required gate ends the run as unknown without publishing that message. Blocked and failed finishes commit their exact submitted messages atomically with terminal status. A failed finish after unresolved required-gate failure is reported as goal-derived blocked.

## Sessions and branches

A session is a durable agent identity with its conversation, model, budget, goals, and child work. A branch is one retained line of that session's history.

Common commands:

```sh
agencity sessions
agencity resume "session or branch name"
agencity history current
agencity tree
agencity branch head "experiment"
```

Agencity remembers the recent branch for each workspace. If more than one choice is plausible, an interactive terminal asks you to choose. Scripts fail instead of selecting by incidental row order.

`branch head` creates a new branch from the selected branch's current committed state. It does not rewrite or merge the original history.

## Terminal interface basics

The full-screen terminal interface renders committed user and assistant messages as structured Markdown. Supported fenced languages and retained TypeScript cells use syntax-aware rendering; unsupported fenced languages remain readable as plain code. Each run appears directly after the user task that started it and before the resulting assistant message. During an active run, prior steps collapse to syntax-colored one-line summaries as each new step starts; only the latest committed action shows details. A pending model response is represented by the active run header rather than a separate waiting row. Completed activity collapses to one status row. Expanding it with `Ctrl-O` shows retained step details in a slightly indented, rounded panel, including exact TypeScript source, dim stream-colored logs and returned stdout/stderr, and errors. Structured result JSON remains available through cell diagnostics rather than the conversation transcript.

Agencity does not enable click or drag mouse reporting. Drag normally to select rendered text, then use the terminal's native copy command such as Command-C on macOS. Compatible terminals use alternate-scroll mode to translate trackpad or wheel gestures into conversation scrolling without taking over text selection.

The bottom composer is a raised multiline surface with a visible `›` prompt. Pasting preserves line breaks, `Shift-Enter` inserts a new line, and Enter submits the complete draft. The composer grows to show up to five lines in normal-height terminals and keeps longer drafts scrollable. A family summary, when present, remains between the composer and footer. The footer keeps the trusted-local boundary and current action visible, then adds connection, attention, recovery, budget, family, and command hints as width permits.

The conversation uses the full main width while no contextual inspector is active. Commands, model setup, provisional output, family browsing, and transient notices open the inspector. Wide terminals show it beside the conversation; narrow terminals temporarily replace the conversation while leaving the header, composer, family summary, and footer available. Closing the inspector restores the conversation without changing the selected session or branch.

Normal, compact, and minimum height modes reduce chrome in a fixed order. The main view always retains usable space, while very short terminals omit the optional family summary and reduce an active inspector to its required control.

- Type plain text to start a task or provide more information after a blocked result.
- `Ctrl-P` opens command search.
- `Ctrl-O` expands or collapses the latest run activity.
- `Ctrl-L` expands or collapses all completed run activity without changing the composer draft.
- Page Up/Down scrolls the active view.
- Escape closes the current inspector.
- `Shift-R` or `/raw` opens scrubbed raw diagnostics.
- `/help` lists commands.

Useful inspectors include `/history`, `/budget`, `/tree`, `/agents`, `/tasks`, `/goals`, `/memory`, `/skills`, `/context`, `/unknown`, and `/sync-status`.

### Navigate retained child agents

When the current agent has direct children, a one-line summary stays visible between the composer and footer. It counts working, idle, attention, and ended children. Unavailable children are included in the attention count so uncertain work is not presented as idle.

An admitted child that has no active run is idle, not working. The client refreshes continuously while the family browser is open or a child is actively working; dormant child admissions do not keep a background polling loop active.

Family navigation applies only while the composer is empty:

1. Press Down to focus the family summary.
2. Press Enter or Right to open the direct-child browser.
3. Use Up and Down to select a child.
4. Press Enter or Right to open the selected child's conversation.
5. Press Left from an empty child composer to return to its exact parent branch.

Up, Left, or Escape returns from the focused summary to the composer. Left or Escape closes the browser. Printable input from the focused summary returns to the composer and keeps the typed character. A non-empty draft retains normal editing and submission behavior.

The header breadcrumb shows retained ancestry separately from the branch. The child browser labels each row as `working`, `idle`, `attention`, `ended`, or `unavailable`, with a bounded reason where attention is required. Unavailable routes remain visible but cannot be opened.

Opening a family member only changes what this client observes. It does not stop, resume, cancel, retry, or re-own work, and it does not change the workspace's remembered resume selection. Family opening is disabled during `/history` inspection; use `/live` first.

## Detach and cancel

Detaching closes the client without claiming that durable or external work stopped:

```sh
agencity run --detach "continue this work in the background"
agencity attach
```

`Ctrl-D`, `/quit`, and `/exit` detach. With an active run, the first Ctrl-C requests durable cancellation; a second Ctrl-C detaches. With no active run, Ctrl-C detaches immediately.

Use an explicit stop when cancellation is intended:

```sh
agencity agents
agencity stop "unique agent name"
```

The on-demand workspace service owns detached execution. It is not an operating-system login service. It exits after becoming quiescent, while active runs, effects, schedules, heartbeats, queued wakes, workers, or attached clients can keep it resident.

## Recovery attention

On startup, Agencity rebuilds from committed state, resumes safe work, and does not replay completed effects. If a non-idempotent external action may have happened but its result was not committed, the effect becomes `unknown`.

Inspect unknown effects before choosing any successor action:

```sh
agencity unknown
agencity reconcile latest still_unknown "provider audit was inconclusive"
```

Reconciliation appends operator evidence. It does not change the unknown status and does not retry the effect. Failed or stale completion gates, unavailable providers, missing artifacts, sync conflicts, and partial deletion also remain visible instead of being converted to success.

See [Recovery](./recovery.md) for the full state model and [Operator runbook](./operator-guide.md) for incident procedures.

## Skills and refinement

Skills are versioned TypeScript routines with tests and retained provenance:

```sh
agencity skills list
agencity skills show NAME
agencity skills test NAME
agencity skills propose "package the repeated formatting workflow"
```

Installing local skill code requires inspection and an exact source-digest confirmation. Skills have the same trusted-local OS authority as the runtime; their permission declarations are policy checks, not a sandbox. See [Skills](./skills.md).

Refinement reviews retained work and may propose attributable memory, prompt-note, skill, or subagent-specification changes:

```sh
agencity refine "look for repeated failure patterns"
agencity refine status
agencity refine auto on
```

Automatic refinement is off by default, profile-scoped, and local-only. Promotion and rollback remain governed by scope, evidence, and approval rules.

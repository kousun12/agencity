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

Use Up/Down to select a provider, `L` to enter a key, `X` to remove a stored key, and Enter to enter a model ID. Direct forms are also available:

```text
/model login openai
/model openai:gpt-5.6-sol
/model login vercel
/model vercel:openai/gpt-5.6-sol
```

Model identifiers use `provider:model`. The model part may contain `/`. A session branch retains its selected model; starting Agencity again does not silently replace it. Create new work to use a different model:

```sh
agencity new --model openai:gpt-5.6-sol "start a separate review"
```

Agencity has no product demo mode or credential-free fallback. Internal deterministic providers are test-only and do not appear in product selection.

## Tasks and runs

A task is the instruction you give Agencity. A run is one durable attempt to carry that task forward. During a run, the model returns typed actions such as:

- a TypeScript cell that uses the console SDK for files, shell commands, SQL, models, subagents, memory, skills, or artifacts;
- a clarification or permission request;
- a final answer;
- an explicit blocked or failed result.

Agencity records a requested external effect before executing it. A dependent model step starts only after the result is committed. A final answer may also be checked by a completion gate:

```sh
agencity run --completion-gate "bun test" \
  "fix the failing tests and verify the result"
```

The completion command runs through the same durable effect path as other shell work.

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

The full-screen terminal interface keeps conversation and grouped run activity in the main view, a stable composer at the bottom, and branch, model, connection, recovery, budget, and trust status in persistent chrome.

- Type plain text to start a task or answer a pending clarification.
- `Ctrl-P` opens command search.
- `Ctrl-O` expands or collapses recent run activity.
- Page Up/Down scrolls the active view.
- Escape closes the current inspector.
- `Shift-R` or `/raw` opens scrubbed raw diagnostics.
- `/help` lists commands.

Useful inspectors include `/history`, `/budget`, `/tree`, `/agents`, `/tasks`, `/goals`, `/memory`, `/skills`, `/context`, `/unknown`, and `/sync-status`.

### Navigate retained child agents

When the current agent has direct children, a one-line summary stays visible between the composer and footer. It counts working, idle, attention, and ended children. Waiting and unavailable children are included in the attention count so uncertain work is not presented as idle.

An admitted child that has no active run is idle, not working. The client refreshes continuously while the family browser is open or a child is actively working; dormant child admissions do not keep a background polling loop active.

Family navigation applies only while the composer is empty:

1. Press Down to focus the family summary.
2. Press Enter or Right to open the direct-child browser.
3. Use Up and Down to select a child.
4. Press Enter or Right to open the selected child's conversation.
5. Press Left from an empty child composer to return to its exact parent branch.

Up, Left, or Escape returns from the focused summary to the composer. Left or Escape closes the browser. Printable input from the focused summary returns to the composer and keeps the typed character. A non-empty draft retains normal editing and submission behavior.

The header breadcrumb shows retained ancestry separately from the branch. The child browser labels each row as `working`, `waiting`, `idle`, `attention`, `ended`, or `unavailable`, with a bounded reason where attention is required. Unavailable routes remain visible but cannot be opened.

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

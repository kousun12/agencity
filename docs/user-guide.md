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

If the repository root contains a regular `AGENTS.md`, Agencity includes its bounded content and exact path/digest metadata in model input. Successful `tools.readFile` calls also discover `AGENTS.md` files between the root and the target file's directory. Instructions apply from root to nearest directory, so the nearest file wins a conflict.

Nested discoveries are retained with the committing cell and remain available after restart or branch replay. The same path and digest is recorded once per branch lineage; changed, removed, and restored files are delivered again. Automatic loading is bounded to 64 KiB for the root, 16 KiB per nested file, a 256 KiB digest scan per file, 64 ancestor files examined per read, four changed nested files delivered per read, 16 discovery-bearing reads per cell, 40 KiB of active nested content, and 64 active nested records. Work beyond a bound becomes explicit pending/omission metadata; stale pending content is not kept inline. Larger, invalid UTF-8, non-regular, or symlinked files remain visible as references or unavailable records with guidance to inspect them explicitly. Direct Bun or shell filesystem access does not trigger nested discovery; use `tools.readFile` before editing a new directory.

Repository instructions guide model behavior only. They cannot grant file, network, credential, budget, model, publication, reviewer, or other runtime authority, and they are never imported as governance-review policy. Do not put secrets in `AGENTS.md`; its loaded content is sent to the configured model provider.

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

Each dependent step receives a bounded `recentTrajectory` containing recent actions and outcomes, plus newly delivered exact-once observations. Completed actions are represented by compact deterministic facts such as their declared purpose, source and result digests, byte counts, and grouped effect status; their source and result text are not replayed. The latest failed or unresolved action retains bounded source and detailed error context so it can be repaired. After a validation or shell failure, the next-step guidance asks for a small read around a reliable diagnostic location, or the smallest relevant function or section when no reliable location exists, rather than another whole-file read. This preserves continuity without replaying the complete notebook. The step prompt asks the model to decide whether the request is complete before executing anything else. Retained cell-history APIs remain available for deliberate historical inspection, but ordinary active-run continuation does not require the model to reconstruct its own work from them.

```sh
agencity run --completion-gate "bun test" \
  "fix the failing tests and verify the result"
```

The completion command runs through the same durable effect path as other shell work.

A successful finish is provisional until every required gate passes. Failed gates return repair evidence to the agent without publishing its proposed success message. An unknown required gate ends the run as unknown without publishing that message. Blocked and failed finishes commit their exact submitted messages atomically with terminal status. A failed finish after unresolved required-gate failure is reported as goal-derived blocked.

Unexpected large output does not become an unbounded next prompt. Shell and file helpers report `inline`, `spilled`, `truncated`, or `refused` completeness. Complete inline results are under `.value`. Local shell output above the inline limit keeps bounded head/tail previews and spills complete scrubbed bytes up to 32 MiB when artifact staging is available. File reads use one-based line pages with digest-pinned continuation. Artifact recovery uses exact zero-based half-open ranges of at most 64 KiB. `truncated` means the complete output is unavailable even if the command itself succeeded.

Automatic observations are also capped per step. The complete canonical event-ID ledger remains retained for inspection; the model receives a bounded derived view that avoids repeating a successful cell effect both as an effect outcome and as the cell result. Failed, cancelled, and unknown effects remain visible and actionable.

Inside a cell, ordinary variables last only for that cell. Direct `scratch` is an exact-session-and-branch cache for replaceable parsed data, indexes, helper functions, and other intermediates useful across nearby cells. `state` and artifacts remain the correct place for anything required after recovery. Each cell should return only the focused summary, slice, status, digest, or reference needed for the next decision instead of returning the complete value placed in scratch.

Scratch is not durable work. Arbitrary values survive only while the worker remains warm. The managed file-local product attempts a bounded same-device JSON checkpoint after successful cells, but functions, classes, cycles, modules, skipped values, and evicted or expired cache rows do not restore. A later cell can inspect `sdk.scratch.status()` and rebuild missing values from durable inputs. Scratch does not cross forks, child sessions, devices, synchronization, or export and is never automatic context or completion evidence.

## Sessions and branches

A session is a durable agent identity with its conversation, model, budget, goals, and child work. A branch is one retained line of that session's history.

Every new session also has one durable initial agent profile: a concise role, standing purpose, and agent-specific instructions. The profile is behavioral guidance for model calls. It does not grant file, shell, credential, model, budget, publication, or other runtime authority.

Ordinary root creation uses Agencity's sealed repository-agent profile. Delegated and recursive helpers use a sealed task-specialist profile unless the creating API or generated TypeScript supplies a narrower explicit profile. Reusable subagent specifications materialize their exact active specification version into the new child's profile and retain that source provenance. The current task and completion criteria remain separate from standing profile behavior.

Each autonomous run and recursive-model invocation pins the exact profile version and effective system-prompt provenance before model work. A restart uses that retained pin rather than silently selecting different instructions.

The public protocol, TypeScript client, CLI, and TUI can inspect and govern the selected route's profile. Terminal operations are route-relative and do not require internal IDs:

```sh
agencity profile show
agencity profile history
agencity profile proposals
agencity profile propose '{"role":"Repository maintainer","purpose":"Maintain this repository","instructions":"Preserve attributable evidence.","reason":"Clarify standing behavior","predictedEffect":"More consistent maintenance","wait":true}'
agencity profile repropose latest '{"role":"Repository maintainer","purpose":"Maintain this repository","instructions":"Preserve evidence and report unresolved risks.","reason":"Address the rejection guidance","predictedEffect":"More complete risk reporting"}'
agencity profile rollback 1 '{"reason":"Restore the earlier approved behavior","evidenceEventIds":[]}'
```

The TUI equivalents are `/profile`, `/profile show`, `/profile history`, `/profile proposals` (or `/profile notices`), `/profile propose JSON`, `/profile repropose latest|N JSON`, and `/profile rollback REVISION JSON`. `history` shows active and historical revisions, exact prompts, adjacent diffs, proposal provenance, actors, reasons, and restoration links. `proposals` shows pending and terminal statuses, reviewer provenance, reasons, violated criteria, residual risks, and revision guidance. `latest|N` selects the newest or Nth newest rejected proposal; rollback selects an exact profile revision number.

Proposals wait by default. Set `"wait": false` to detach after durable admission; the origin route later receives one durable terminal notice. A rejected proposal is immutable. Reproposal creates a new bounded proposal linked to the rejection and must change content or evidence. Rollback restores exact earlier approved content as a new revision and never rewrites history.

The ordinary path is proposer, deterministic validation, one separate sealed governance reviewer, application-time revalidation, automatic application or rejection, and terminal delivery. The reviewer uses the route's current model but a separate completion and sealed profile. It receives the frozen product constitution and review policy; workspace-charter and user-constraint configuration is unavailable and pinned as `null`. Callers cannot select the reviewer. Reviewer approval establishes policy consistency, not proof of improved outcomes.

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

Useful inspectors include `/history`, `/budget`, `/tree`, `/tasks`, `/goals`, `/memory`, `/skills`, `/context`, `/unknown`, and `/sync-status`. `/agents` opens the workspace root selector described below.

### Navigate retained child agents

When the current agent has direct children, a one-line summary stays visible between the composer and footer. It counts working, idle, attention, and ended children. Unavailable children are included in the attention count so uncertain work is not presented as idle.

An admitted child that has no active run is idle, not working. The client refreshes continuously while the family browser is open or a child is actively working; dormant child admissions do not keep a background polling loop active. Routine polling does not change the visible status label, while stale or unavailable family data remains explicit.

Family navigation applies only while the composer is empty:

1. Press Down to focus the family summary.
2. Press Enter or Right to open the direct-child browser.
3. Use Up and Down to select a child.
4. Press Enter or Right to open the selected child's conversation.
5. Press Left from an empty child composer to return to its exact parent branch.

Up, Left, or Escape returns from the focused summary to the composer. Left or Escape closes the browser. Printable input from the focused summary returns to the composer and keeps the typed character. A non-empty draft retains normal editing and submission behavior.

The header breadcrumb shows retained ancestry separately from the branch. The child browser highlights the selected child, dims other options, and keeps names, status, tasks, and model metadata to bounded single-line rows with ellipses. It labels activity as `working`, `idle`, `attention`, `ended`, or `unavailable`, with a bounded reason where attention is required. Unavailable routes remain visible but cannot be opened.

Opening a family member only changes what this client observes. It does not stop, resume, cancel, retry, or re-own work, and it does not change the workspace's remembered resume selection. Family opening is disabled during `/history` inspection; use `/live` first.

### Navigate retained workspace roots

Left from an empty top-level root composer opens the full-screen Agents view. `/agents` opens the same view from any live root or nested conversation. Historical inspection cannot open it; use `/live` first.

The view contains only retained root branches in the current workspace. Rows are grouped as Running, Idle, Stopped, Failed, and Archived, then sorted by most recent update. Each row uses human-readable session and branch names and may show model, task, unresolved-work and active-goal counts, and update time as space permits. Child sessions do not appear. Failed and archived roots remain visible but cannot be opened.

- Type to search visible names, task text, model, or status.
- Use Up and Down to move one row, or Page Up and Page Down to move by a visible page.
- Press Enter or Right to open a resumable row.
- Press Ctrl-N to create a new root session with the current model configuration and open it immediately.
- Press Ctrl-R to refresh without clearing the search.
- Press Escape once to clear a non-empty search, or with an empty search to return to the conversation that opened the view.
- Left remains at workspace scope.

Opening the view has no durable effect and does not change the remembered branch. Opening a row uses exact retained route identity and updates the workspace's remembered resume selection. Ctrl-N creates durable root work, selects it for resume, and leaves the Agents view for its conversation. A later no-argument `agencity` therefore resumes the opened or newly created root. The catalog loads on open, on explicit refresh, and after selection; it does not poll while the view is open. A failed refresh keeps prior rows visible and marks them stale.

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

The on-demand workspace service owns detached execution. It is not an operating-system login service. It exits after one hour of quiescence by default, while active runs, effects, schedules, heartbeats, queued wakes, resident managed run-queue work, or attached clients can keep it resident. Warm scratch and an idle console worker do not keep the service alive, so detach/resume does not promise warm scratch retention.

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

Refinement reviews retained work and may propose attributable memory, prompt-note, skill, or subagent-specification changes through the same sealed governance path:

```sh
agencity refine "look for repeated failure patterns"
agencity refine --kind skill "package a reusable deterministic operation"
agencity refine --detach "review this trajectory in the background"
agencity refine status
agencity refine auto off
agencity refine auto on
```

The CLI and TUI detach manual refinement by default so the interface remains usable while retained review and governance progress continues. `agencity refine --wait` or `/refine --wait` blocks explicitly; `--detach` is an accepted explicit spelling of the default and cannot be combined with `--wait`. Both surfaces accept `--kind memory,prompt_note,skill,subagent_spec` to restrict what may be proposed. A structured refinement or governance child returns a formal tool submission rather than an assistant message, and its route shows a derived `REFINEMENT` runtime row instead of appearing empty.

The sealed refinement prompt selects an artifact by mechanism. Memory retains durable facts, preferences, decisions, observations, or constraints. Prompt notes address repeated behavioral tendencies. Skills package reusable deterministic operations with executable tests. Subagent specifications package recurring delegated roles. Repository-specific maintainability and product behavior remain ordinary repository work, while a missing runtime primitive remains runtime implementation. The refiner must return no change when no allowed harness kind directly addresses the evidence; it cannot replace the requested capability with generic advice to try harder. The separate governance reviewer receives bounded, redacted excerpts from the refiner's exact frozen source snapshot and checks this direct evidence-to-artifact relationship in addition to scope and policy.

Automatic learning is enabled when the device profile has no explicit preference. The preference is device-wide rather than workspace-specific: `refine auto off` persistently pauses new automatic admissions in every workspace using that profile, and `refine auto on` resumes them. Already admitted work is not cancelled. Proposals remain local to the originating session and may target only memory, prompt notes, tested skills, or subagent specifications. They cannot revise an agent profile, promote content to a broader scope, create connectors, or change credentials, models, budgets, permissions, effect policy, or runtime authority.

One boundary scan admits at most one trigger. The default thresholds are three matching failed effects, three failed cells in one exact agent run, two failures of one completion gate against distinct material pins, one typed `UserCorrection`, or five successful terminal runs within the trailing 2,048 local records. The success trigger can fire again after five newer qualifying successful runs. A terminal success is only permission to reflect; it is not proof that behavior should change. `no_change` is an expected result when the evidence does not directly support one allowed adaptation. Because a terminal transition does not invoke the boundary observer, the fifth success is considered at the next committed boundary.

Learning history is audit activity, not a human review queue. It retains trigger evidence, reflection status, `no_change`, proposals, sealed decisions, application outcomes, failures, unknowns, and rollbacks. Automatic work uses ordinary recursive-child budget and provider-concurrency rules; there is no separate learning spend budget, aggregate review-rate limit, scheduler, or semantic workflow grouping. Boundary scanning currently loads complete branch history, while the detector accepts at most 10,000 supplied records. A larger branch may report `scan_unavailable` and stop admitting automatic learning until that limitation is addressed.

An approved profile or non-skill harness proposal applies atomically after final validation. An approved skill is staged, compiled, and run through its declared tests before activation. Failure, unknown review, stale application, or failed skill tests activate nothing. Later attributable outcomes may support another proposal or exact rollback.

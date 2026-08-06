# Prime Agent TypeScript/Turso rewrite follow-up plan

**Status:** Living follow-up backlog  
**Date opened:** August 6, 2026  
**Parent plan:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)

## Purpose

This document tracks follow-up implementation tickets needed to fully deliver the intent of the original TypeScript/Turso rewrite after the first implementation pass.

The parent PRD remains the authoritative statement of product motivation, design constitution, runtime model, system guarantees, and intended user experience. This document does not replace or narrow it. It records concrete gaps discovered while reviewing and using the implementation, then turns those gaps into independently reviewable tickets.

The first implementation pass delivered substantial runtime infrastructure and passes its current automated acceptance matrix. Passing that matrix is useful evidence, but it is not by itself proof that the complete product intention has been met. In particular, the current product surface exposes low-level session lifecycle and runtime primitives without yet providing the simple, autonomous, terminal-first Prime Agent experience described by the parent PRD.

This is intentionally a living document. Add further tickets as missing behavior, incomplete integrations, weak acceptance coverage, or product gaps are discovered.

## How to use this document

Each follow-up item should:

1. Identify an observable gap against the parent PRD or its intended product behavior.
2. Describe a user- or operator-visible outcome rather than only an internal refactor.
3. Preserve the parent's durable-state, attribution, recovery, authority, and uncertainty invariants.
4. Include acceptance criteria that would have caught the gap in the first implementation pass.
5. State dependencies and deliberate exclusions.
6. Be completed with implementation, tests, and documentation evidence.

Ticket status values:

- **Proposed** — identified but not accepted for implementation.
- **Ready** — sufficiently specified and unblocked.
- **In progress** — implementation is underway.
- **Blocked** — depends on an unresolved decision or prerequisite.
- **Done** — acceptance criteria are implemented and independently reproducible.
- **Deferred** — intentionally postponed with rationale; not silently treated as complete.

When completing a ticket, add an evidence block containing the relevant commits, files, automated tests, manual verification, and known remaining limitations.

## Follow-up completion standard

The follow-up is complete only when:

- every accepted ticket is **Done** or explicitly **Deferred** with rationale;
- the ordinary user path matches the terminal-first TypeScript Prime Agent intention of the parent PRD;
- representative end-to-end use does not require knowledge of internal database identifiers or direct SDK calls;
- an agent can autonomously perform durable programmatic work rather than only return chat text;
- detaching or closing a client does not stop committed autonomous work, and reattachment reconstructs it;
- recovery, cancellation, permissions, budgets, goals, completion gates, and unknown outcomes remain visible through the product surface;
- the documentation describes both how to use the product and why its architectural constraints exist;
- the full verification suite includes product-level acceptance tests, not only component and storage tests.

## Invariants inherited from the parent PRD

Every ticket in this document inherits the original PRD. In particular, follow-up work must not compromise:

- durable state as the owner of agent identity;
- reconstructibility without a live Bun heap or TUI process;
- append-only canonical events and deterministic projections;
- typed, validated mutation rather than unrestricted canonical SQL writes;
- durable outbox handling and visible unknown side-effect outcomes;
- attributable context, memory, harness versions, and refinement evidence;
- explicit user authority, scope, permission, and budget boundaries;
- truthful capability reporting across local and remote placements;
- trusted-local labeling without claiming the Bun worker is a hostile-code sandbox;
- local operation without mandatory Turso Cloud connectivity;
- compatibility of retained sessions, events, and artifacts across CLI improvements.

## Ticket index

| ID | Ticket | Status | Depends on |
|---|---|---|---|
| FU-001 | Make `agencity` the default product entrypoint | Done | — |
| FU-002 | Add workspace discovery and human session resume/selection | Done | FU-001 |
| FU-003 | Add explicit provider and model onboarding | Done | FU-001, FU-002 |
| FU-004 | Implement the autonomous typed TypeScript agent-run loop | Done | FU-003, FU-011, FU-013 |
| FU-005 | Turn the TUI into the complete protocol-backed product client | Proposed | FU-001, FU-002, FU-004, FU-012, FU-015 |
| FU-006 | Expose durable interruption, recovery, and unknown outcomes in the CLI/TUI | Proposed | FU-004, FU-005, FU-015 |
| FU-007 | Provide a real installation and executable workflow | Done | FU-001 |
| FU-008 | Reorganize low-level CLI operations as advanced surfaces without breaking compatibility | In progress | FU-001, FU-005 |
| FU-009 | Add product-level end-to-end acceptance coverage | Proposed | FU-001–FU-008, FU-011–FU-019 |
| FU-010 | Add repository-level purpose and implementation guidance | Done | — |
| FU-011 | Give TypeScript cells notebook-style observation and inspection semantics | Done | — |
| FU-012 | Expose durable family messaging and retained subagent follow-up to the model | Done | FU-004 |
| FU-013 | Add first-class recursive model calls with durable handles | Done | FU-003 |
| FU-014 | Drive goals, completion gates, heartbeats, and schedules through product runs | In progress | FU-004 |
| FU-015 | Keep detached sessions executing in a background service | In progress | FU-001, FU-004 |
| FU-016 | Implement the trajectory-reviewing refiner behind `/refine` and adaptation triggers | In progress | FU-003, FU-004 |
| FU-017 | Add skill creation, installation, and management as a product surface | In progress | FU-004 |
| FU-018 | Stream provider output incrementally to attached clients | Done | FU-003 |
| FU-019 | Add automatic and agent-directed context compaction | In progress | FU-003, FU-004 |

---

## FU-001 — Make `agencity` the default product entrypoint

**Status:** Done

### Gap

The parent PRD says the initial product is a terminal interface and includes a TUI in Slice 1. The current implementation requires users to create a session, copy `sessionId` and `branchId`, then attach the TUI manually:

```sh
bun run src/cli.ts create --workspace demo
bun run src/cli.ts tui --session <SESSION_ID> --branch <BRANCH_ID>
```

Running the CLI without a subcommand displays help rather than opening the product. This exposes internal lifecycle mechanics as onboarding.

### Outcome

A user in a repository runs:

```sh
agencity
```

The command creates or resumes appropriate durable work and opens the interactive product without requiring an internal ID.

An optional initial task works directly:

```sh
agencity "fix the failing tests"
```

### Scope

- Make the no-subcommand route enter the interactive product.
- Accept an optional positional initial task.
- Add first-class `new`, `resume`, `sessions`, `run`, `doctor`, and `config` commands.
- Keep `--session` and `--branch` available for scripts and diagnostics, not required for normal use.
- Show workspace, selected session name, model, run state, and trusted-local mode in the startup header.
- Ensure the convenience path calls existing typed supervisor services and creates no hidden state.

Suggested contract:

```text
agencity [TASK]                 Open/resume the TUI and optionally start TASK
agencity new [TASK]             Create a new root session
agencity resume [NAME|ID]       Resume durable work
agencity sessions               List/select workspace sessions and branches
agencity run TASK               Run interactively or non-interactively
agencity doctor                 Check runtime, placement, providers, recovery, and sync
agencity config                 Manage non-secret preferences
```

### Acceptance criteria

- In an empty state directory, `agencity` reaches a ready TUI without asking for IDs.
- `agencity "inspect this repository"` durably commits the task and begins a run.
- A second invocation resumes the selected branch and reconstructs its committed history.
- `agencity --new` creates a distinct root without hiding prior sessions.
- Running with no subcommand never falls through to compact developer help.
- All state produced by the entrypoint is visible through the existing storage/API/protocol surfaces.

### Exclusions

This ticket does not define automatic resume selection, provider setup, or autonomous action semantics in detail; those are separate tickets below.


### Completion evidence

- Commit: `42982e4`.
- Implementation: default `agencity [TASK]`, `new`, `resume`, `sessions`, `run`, `doctor`, and `config` routes in `src/cli.ts`, `src/cli-args.ts`, and `src/product/`; durable display-name events and startup header.
- Verification: product black-box suite in `test/integration/product-cli.test.ts`; combined typecheck and architecture checks passed before commit.
- Remaining limitation: tasks use the legacy one-turn model path until FU-004 is complete; the TUI remains supervisor-owned until FU-005.

---

## FU-002 — Add workspace discovery and human session resume/selection

**Status:** Done

### Gap

Normal use requires opaque session and branch IDs. The runtime has durable identity, but the product does not use it to provide convenient workspace-scoped resume behavior.

### Outcome

Agencity identifies the current workspace, automatically resumes an unambiguous recent session, and presents a human-readable selector when selection is ambiguous.

### Scope

- Detect the nearest suitable project root, considering version-control roots and explicit Agencity metadata.
- Support `--workspace PATH` as an override.
- Canonicalize workspace identity so path aliases do not silently create duplicates.
- Store a durable, attributable recent-session/branch preference in the proper profile/workspace store.
- Add editable human-readable session and branch display names.
- Derive an initial short display name from the first task without replacing the retained task text.
- List local sessions, branches, active goals, unresolved work, and cloud-discovered sessions when available.
- Refuse to guess when multiple sessions are equally plausible.

### Default resume policy

Automatic resume is allowed only when the candidate:

- belongs to the resolved workspace;
- is a root session or explicitly preferred branch;
- is not deleted or irrecoverably failed;
- has no unresolved selection ambiguity;
- can be opened even if its provider is presently unavailable, in which case the unavailable state is visible.

### Acceptance criteria

- Re-entering the same repository through a path alias resolves to the same workspace identity.
- One unambiguous recent session resumes automatically.
- Multiple plausible sessions open a selector instead of selecting by incidental row order.
- Selection uses names, time, model, status, and task summary; IDs remain available under details.
- Explicit selection updates the durable recent preference.
- Missing provider configuration never makes retained work disappear from the selector.


### Completion evidence

- Commit: `42982e4`.
- Implementation: canonical realpath/project discovery plus owner-only durable `.agencity/workspace-id`, move/alias/concurrent-open stability, durable recent preference, human session/branch names, deterministic ambiguity refusal, and retained unavailable-provider visibility.
- Verification: move, symlink, 32-way concurrent creation, legacy migration, invalid marker, ambiguity, selection, and resume tests in `test/integration/product-cli.test.ts`; name replay tests in `test/unit/product-names.test.ts`.
- Remaining limitation: Cloud session rows appear after canonical envelopes synchronize locally because the current Cloud catalog is workspace-level.

---

## FU-003 — Add explicit provider and model onboarding

**Status:** Done

### Gap

The current CLI `create` route always creates an `echo/echo-1` session. Choosing a real model requires using HTTP or the TypeScript SDK. A user can therefore enter what looks like an agent flow but receive only deterministic echo responses.

### Outcome

Interactive startup discovers usable providers, makes model choice explicit, and persists non-secret preferences. Echo is clearly labeled as demo/test behavior and is never a silent fallback.

### Scope

- Discover supervisor-registered providers and whether they are usable without revealing secrets.
- Support OpenAI-compatible configuration through `OPENAI_API_KEY` and optional `OPENAI_BASE_URL`.
- Allow programmatically installed providers to participate in selection.
- Persist provider/model identifiers and opaque credential references at the appropriate scope.
- Never persist raw secrets in events, profile/workspace stores, logs, artifacts, or diagnostic bundles.
- Add `--model PROVIDER/MODEL` and explicit `--demo` options.
- Explain unavailable providers and remediation through startup and `agencity doctor`.
- Never silently change the model of an existing branch; require a new session or explicit fork policy.

### Acceptance criteria

- First interactive run with one usable provider can select and save a model without leaving the CLI.
- First interactive run with multiple providers presents a selector.
- Echo requires `--demo` or an explicit, visibly labeled interactive choice.
- Non-interactive execution without a usable provider fails with a typed error and nonzero status; it does not fall back to echo.
- Resuming an unavailable model produces a visible blocked/configuration state rather than a silent replacement.
- Persistence and diagnostic tests prove that raw credentials never enter durable state or output.


### Completion evidence

- Commit: `42982e4`.
- Implementation: secret-free provider descriptors, explicit `--model`/`--demo`, OpenAI-compatible discovery, saved non-secret model preference, blocked unavailable resume, doctor remediation, and credential-reference validation at CLI and profile-store boundaries.
- Verification: no-silent-Echo, unavailable-resume, doctor, expanded-secret rejection, output/database byte scans, and profile adapter tests in `test/integration/product-cli.test.ts` and `test/slice4/profile-adapter.test.ts`.
- Remaining limitation: real-provider behavior remains credential-gated; Echo is explicitly a demo fixture.

---

## FU-004 — Implement the autonomous typed TypeScript agent-run loop

**Status:** Done

### Gap

The original PRD preserves Prime Agent's central RLM property: the model writes TypeScript that can inspect durable context, execute tools, call models, and coordinate subagents. The current ordinary model loop commits one model response as text. Console cells and tool surfaces exist, but a normal user task does not automatically drive a complete recoverable model-to-program execution loop.

A friendlier CLI around single-turn chat would not close this gap.

### Outcome

A user task starts an autonomous, budgeted, recoverable run in which the model emits typed actions, executes durable TypeScript cells and tools, observes results, delegates work, and continues until a final, blocked, failed, cancelled, or unknown outcome.

The model has one programmatic execution tool: the TypeScript console. SQL, state, artifacts, shell/file effects, recursive model calls, subagents, and harness operations are injected TypeScript APIs inside that console rather than separate model tools. Final responses, clarification requests, blocked states, and failures remain typed run-control outcomes rather than executable tools.

### Scope

For every run:

1. Commit the task and run request.
2. Materialize attributable context, memory, harness, policy, budget, and task state.
3. Ask the configured model for a versioned typed next action.
4. Validate the action before execution.
5. Support at least:
   - user-facing final response;
   - TypeScript console cell;
   - clarification or permission request;
   - durable recursive model/subagent work;
   - explicit blocked or failed outcome.
6. Execute cells and effects through the existing disposable console and outbox.
7. Commit the action, logs, results, and run state before the next dependent model call.
8. Continue until a terminal outcome, cancellation, user decision, budget exhaustion, or visible unknown effect; when the run carries a goal, completion is accepted only after its required completion gates pass (FU-014).

Unstructured assistant text must not be heuristically executed as code. Providers may use native structured output or a tested portable encoding, but all actions share one domain contract.

After a cell commits, the next model call receives its bounded result, logs, exported working-value references, effect outcomes, and exact event provenance. Values that remain in the disposable Bun heap are not observable state. FU-011 defines the cell-level observation contract, FU-012 adds model-facing family messaging, FU-013 provides the programmatic recursive model API, and FU-014 wires durable goals, completion gates, heartbeats, and schedules into run continuation.

The agent-facing TypeScript SDK should expose the parent PRD's intended general mechanisms: read-only SQL, durable state, artifacts, shell/file effects, model calls, subagent/task handles, mailboxes, skills, and refinement proposals, all within existing permission and scope rules.

### Acceptance criteria

- `agencity "fix the failing test"` completes a representative coding task by inspecting files, executing durable cells/tools, modifying code, running verification, and returning a final result.
- The run uses a typed/versioned action protocol; malformed or unsupported actions fail visibly and are never executed as code.
- The provider sees one TypeScript execution tool rather than parallel shell, file, SQL, memory, or subagent tool schemas.
- Every committed cell result is included once in the dependent model context with its cell and event IDs.
- Restarting the console worker after every committed cell produces the same materialized result.
- Killing the supervisor after each durable boundary resumes without duplicating committed cells, effects, model calls, or subagents.
- Budgets stop further admission at their exact boundary.
- Permission and clarification requests pause durably and continue after a user response.
- Unknown non-idempotent effects block blind continuation.
- A run whose goal defines required completion gates does not report success while a required gate fails or its result is stale (FU-014 defines the gate contract).
- Model action, context, cell, tool, subagent, and final response provenance is queryable from retained records.


### Completion evidence

- Commits: `e1a6e0a`, `89f7cbf`, `4a82122`, `a22becf`, and the FU-014 integration commit `bbeddb1`.
- Implementation: strict `agencity.agent-action` v1 parsing; canonical run/action events and projection; deterministic step/context/call/effect/action/cell IDs; autonomous TypeScript continuation; exact-once observation ledger; pause, cancel, budget, gate, unknown, recovery, CLI/protocol/TUI routes; representative coding e2e.
- Verification: full suite after hardening passed 519 tests with 2 external skips; focused action/run suites passed 16/16. Independent adversarial review found a committed-but-unapplied action crash hole; the fix now reconciles the retained action before admitting another model step, with four explicit crash-boundary tests. Final re-review passed.
- Remaining limitations: permission decisions are retained run input but broader permission policy UI remains FU-005/FU-006 work; managed detached ownership is FU-015.

---

## FU-005 — Turn the TUI into the complete protocol-backed product client

**Status:** Proposed

### Gap

A TUI exists, but it is an attachment command requiring IDs and currently operates in process rather than as the protocol client described by the parent PRD. Provider output is committed as one post-completion chunk rather than genuinely streamed. Several runtime capabilities are exposed primarily as commands or APIs rather than an integrated product experience.

### Outcome

The TUI becomes the default terminal product and projects the same public snapshot/event protocol available to other clients.

### Scope

- Consume the public client/protocol contract for snapshots, commands, and resumable committed events.
- Permit a contract-compatible in-process transport only when it behaves identically to loopback transport.
- Add session selection and a command palette.
- Show incremental streaming assistant output where provider adapters support it (FU-018).
- Display expandable TypeScript cells, logs, SQL results, and tool outcomes.
- Show current run/task state, model, budgets, recursive tree, mailbox activity, goals, memory, harness/refinement state, sync, and conflicts.
- Surface failed, blocked, cancelled, budget-exceeded, and unknown outcomes distinctly.
- Keep trusted-local mode visible.
- Support `/new`, `/sessions`, `/agents`, `/info`, `/model`, `/run`, `/stop`, `/goal`, `/heartbeat`, `/schedule`, `/history`, `/cell`, `/tree`, `/budget`, `/memory`, `/skills`, `/refine`, `/branch`, `/resume`, `/compact`, `/sync`, `/conflicts`, and `/quit`.

### Acceptance criteria

- A TUI can load a snapshot, disconnect, and resume after its last cursor without missing or double-applying committed activity.
- Local in-process and loopback transports pass the same client behavior suite.
- Cells, effects, recursive agents, budgets, and unknown outcomes update from committed records rather than private in-memory callbacks.
- A user can create, run, branch, quit, and resume without seeing or supplying an internal ID.
- Real incremental provider output is displayed when supported; providers without it report the limitation honestly.
- Historical viewing and return to live state never repeats an effect.

---

## FU-006 — Expose durable interruption, recovery, and unknown outcomes in the CLI/TUI

**Status:** Proposed

### Gap

The runtime has substantial crash-recovery and cancellation machinery, but the ordinary terminal UX does not make its semantics clear. Process termination can be mistaken for cancellation, and unknown outcomes are not a first-class product workflow.

### Outcome

Users can stop, detach, resume, and reconcile work while the interface accurately distinguishes client state from durable execution state.

### Scope

- First `Ctrl-C` requests durable cancellation of the active run and shows reconciliation.
- A subsequent interrupt may detach after warning that durable work can outlive the client.
- `/quit` detaches cleanly without deleting or implicitly cancelling the session.
- Startup summarizes recovered work, pending effects, active children, failed or stale completion gates, and unknown outcomes.
- Add an inspect/reconcile flow for unknown effects without automatic retry of non-idempotent work.
- Show cancellation cascades and child terminal delivery.
- Preserve original cancellation reasons across recovery.

### Acceptance criteria

- Interrupting during a model call, cell, tool, or child task yields a durable, reconstructible state.
- Reopening the product shows whether work completed, cancelled, remains active, or became unknown.
- The UI never labels process exit as confirmed external cancellation.
- Unknown non-idempotent work is never retried by resume alone.
- Cancellation recovery remains leaf-first and preserves its first reason.

---

## FU-007 — Provide a real installation and executable workflow

**Status:** Done

### Gap

The package declares `agencity` and `prime-agent-ts` binaries but is private and has no documented publish, link, or standalone installation path. Local use relies on `bun run src/cli.ts`.

### Outcome

Development and installed workflows both expose the same memorable product entrypoint.

### Scope

- Add `bun run dev` as the source-checkout product entrypoint.
- Make `bun run dev -- "task"` forward product arguments.
- Document a supported link, package, or standalone installation method that produces `agencity` on `PATH`.
- Add `agencity --version` and runtime compatibility checks.
- Do not claim registry installation until a real published channel exists.
- Test executable path resolution outside the repository root.

### Acceptance criteria

- `bun run dev` and installed `agencity` enter the same flow with the same arguments.
- A clean documented installation produces a working executable.
- The executable finds its runtime assets outside the source working directory.
- `agencity --version` reports application and relevant Bun compatibility information.
- Installation documentation clearly distinguishes source, linked, and published/standalone use.


### Completion evidence

- Commit: `42982e4`.
- Implementation: `bun run dev`, version/runtime checks, executable `src/cli.ts` mode `100755`, and documented source/link installation in `docs/install.md`.
- Verification: isolated `bun link` execution from outside the checkout resolves console-worker assets without test-side chmod.
- Remaining limitation: there is no claimed registry or standalone release channel.

---

## FU-008 — Reorganize low-level CLI operations as advanced surfaces without breaking compatibility

**Status:** In progress

### Gap

The existing CLI presents lifecycle and diagnostic primitives as the primary interface. Those operations remain valuable, but their prominence obscures the ordinary product path.

### Outcome

Top-level help prioritizes normal agent use while advanced commands remain stable for development, support, and automation.

### Scope

Suggested command groups:

```text
agencity debug cell|history|snapshot|rebuild|branch
agencity sync status|now|push|pull|checkpoint|stats|conflicts
agencity data export|delete
```

- Preserve current flags and output through aliases during a documented compatibility window.
- Keep guarded destructive confirmation and ownership checks unchanged.
- Provide machine-readable output for automation.
- Group help by product, advanced diagnostics, sync, and destructive data control.

### Acceptance criteria

- Existing documented commands either continue working or emit a tested migration message.
- No destructive command becomes easier to invoke accidentally.
- Product help can be understood without first learning sessions, branches, or cursors.
- Advanced JSON output remains stable and versioned where used programmatically.

---

## FU-009 — Add product-level end-to-end acceptance coverage

**Status:** Proposed

### Gap

The current acceptance suite strongly covers storage and runtime semantics but allowed the implementation to pass without a simple entrypoint or complete autonomous user journey.

### Outcome

Release verification tests the product from installation/entrypoint through meaningful autonomous work, restart, and resume.

### Scope

Add black-box acceptance tests that invoke the executable rather than only supervisor services. At minimum cover:

- empty-state first run;
- workspace discovery;
- explicit provider selection;
- task submission;
- autonomous cell/tool execution;
- goal and completion-gate outcomes;
- detached background continuation and reattachment;
- interruption and resume;
- human session selection;
- branching;
- non-interactive JSON output;
- installation/bin invocation;
- trusted-local and missing-provider messaging.

Use a deterministic structured-action provider for the default suite and an opt-in real-provider smoke test. The deterministic provider should exercise the same action contract, not bypass it through direct service calls.

### Acceptance criteria

- One end-to-end test completes create, task, autonomous execution, quit, resume, branch, and history inspection without parsing or supplying an internal ID.
- A black-box restart test kills the product at each durable action boundary and reaches the same final state.
- Tests prove echo cannot be selected silently.
- Non-interactive mode has documented exit statuses for succeeded, failed, blocked, budget-exceeded, cancelled, and unknown outcomes.
- `bun run verify` includes these product gates.
- External provider and Turso tests remain clearly identified when credential- or binary-gated.

---

## FU-010 — Add repository-level purpose and implementation guidance

**Status:** Done

### Gap

The repository has no root `AGENTS.md`. The README and architecture documents describe much of the current implementation, but no concise guide tells future implementation agents to preserve the broader Prime Agent product intention while working on individual runtime tickets.

### Outcome

A root `AGENTS.md` gives coding agents a reliable map of the repository's purpose, background, invariants, development workflow, security boundary, and authoritative plans.

### Scope

The root guide should include:

- the goal of building a terminal-first TypeScript/Turso successor informed by Prime Agent;
- links to the parent PRD and this follow-up plan;
- the distinction between durable runtime infrastructure and complete product behavior;
- architectural boundaries for domain, storage, artifacts, execution, protocol, TUI, sync, and continual harness;
- canonical-event, projection, outbox, artifact, and recovery invariants;
- trusted-local security limits and secret handling;
- normal Bun install, typecheck, test, and verification commands;
- expectations for adding migrations, event versions, table classifications, protocol changes, and tests;
- a direction to update documentation and follow-up evidence when completing tickets.

### Acceptance criteria

- A root `AGENTS.md` exists and links both plans.
- Its commands reproduce the supported development workflow.
- Its architecture and security claims agree with current code and documentation.
- It plainly states that passing component tests does not substitute for the intended user journey.
- Subdirectory-specific guides, if later added, refine rather than contradict the root guide.

### Completion evidence

- Implementation: root [`AGENTS.md`](./AGENTS.md).
- The guide links the parent PRD and this follow-up plan; describes the product intention, current gaps, source layout, inherited runtime invariants, trusted-local boundary, database/event/artifact rules, test strategy, and documentation/change discipline.
- Development commands and referenced local documents were checked against the current repository on August 6, 2026.
- No subdirectory-specific `AGENTS.md` files currently exist.

---

## FU-011 — Give TypeScript cells notebook-style observation and inspection semantics

**Status:** Done

### Gap

The TypeScript console currently transpiles each cell as the body of an async function. Only an explicit `return` becomes the cell result:

```ts
const rows = await sql`SELECT * FROM events`;
return rows.slice(0, 5);
```

A final expression without `return` evaluates and is discarded. Ordinary `const` and `let` bindings are function-local and unavailable to later cells; `globalThis` may survive in a reused worker but disappears on restart. This behavior is internally consistent, but it does not provide the selective notebook observation that makes Prime Agent's IPython surface useful: assignment keeps data outside model context, while evaluating a variable or slice deliberately brings it back.

The existing cell result also accepts only JSON and has no first-class bounded inspection path for cyclic, class-backed, or otherwise non-JSON values. Cell source and committed output remain queryable through raw event SQL, but the model-facing SDK has no direct cell-history or working-value discovery API.

### Outcome

TypeScript cells provide explicit, bounded notebook semantics. A model can assign large intermediate values without flooding context, evaluate a final expression or call `inspect(...)` to observe selected data, list durable working values, and inspect prior committed cells. None of these conveniences make the Bun heap durable.

### Scope

- Capture the final top-level expression when a cell has no explicit `return`.
- Preserve explicit `return` for compatibility and early return control flow.
- Await a promise returned by either path.
- Keep `console.log`, `console.warn`, stdout, and stderr as bounded logs separate from the expression result.
- Add an explicit `inspect(value, options?)` helper for bounded textual previews.
- Define deterministic preview limits for depth, entries, lines, bytes, getters, circular references, and redaction.
- Keep canonical structured cell results as JSON. When an observed value exceeds the event limit, store the complete serializable value as a content-addressed artifact and return a bounded preview plus its reference.
- Add read-only `state.list()`, `cells.list(...)`, and `cells.get(cellId)` SDK operations. Raw SQL remains available for deeper inspection.
- Document that ordinary lexical bindings do not survive the cell. Cross-cell state requires `state.set` or an artifact reference.
- Include the exact observed result and logs in the next dependent model context once FU-004 drives cells autonomously.

### Acceptance criteria

- `const x = { answer: 42 }; x` commits the same JSON observation as `return x`.
- A cell containing an explicit `return` preserves current behavior.
- `const x = 42` in one cell does not create durable state and is unavailable after worker restart.
- `state.set("x", 42)` remains available through `state.get`, `state.list`, context materialization, and restart.
- Inspecting a large collection returns a bounded preview without inserting the full collection into model context.
- Repeating identical oversized serializable observations reuses one content-addressed object.
- Circular and non-JSON values produce a safe bounded preview or a typed unsupported-value result; they never corrupt the worker protocol or canonical event stream.
- Cell history returns committed source, observation, logs, status, dependencies, and event provenance without replaying the cell.
- Tests cover final expressions, promises, explicit returns, thrown errors, logging, truncation, redaction, artifacts, and restart-after-every-cell mode.

### Dependencies

- None. FU-004 consumes this contract but does not define it.

### Exclusions

- Persisting arbitrary lexical bindings, closures, sockets, processes, iterators, or module instances.
- Replaying prior cells to reconstruct a JavaScript heap.
- Treating a preview as the authoritative value of an artifact.


### Completion evidence

- Commit: `42982e4`.
- Implementation: TypeScript-AST final-expression capture, safe bounded `inspect`, typed unsupported observations, CAS spill/deduplication, `state.list`, and retained `cells.list/get` provenance.
- Verification: ten console integration tests cover explicit/final returns, promises, errors, logs, redaction, cycles/getters, oversized artifacts, state/cell history, and restart-after-every-cell; independent review passed.
- Remaining limitation: lexical JavaScript bindings remain deliberately disposable and TypeScript parsing adds per-worker startup cost.

---

## FU-012 — Expose durable family messaging and retained subagent follow-up to the model

**Status:** Done

### Gap

Agencity already persists child sessions, tasks, mailbox delivery, acknowledgements, cancellation, and terminal notices. The TypeScript console exposes version-pinned `specs.spawn`, but it does not expose the general agent roster or mailbox operations. A model executing a cell therefore cannot discover retained children, send a follow-up into an existing child context, reply to its parent, or acknowledge received work through the same programmatic surface.

Prime Agent's agent-to-agent mechanism does not require a complex interoperability protocol. Its useful behavior is direct string messaging plus trusted sender identity, family-scoped routing, persistent target context, queue/delivery state, and follow-up execution. Agencity should preserve that small contract over its relational task and mailbox model.

### Outcome

The TypeScript SDK gives every session a durable family roster and plain-text message channel. A parent can retain a child, send follow-up work later, and observe its reply. A child can reply to its parent. Messages, receipts, acknowledgements, target wake-up, and resulting turns survive process restart.

### Scope

- Add `sdk.agents` operations for `spawn`, `list`, `send`, `messages`, `acknowledge`, `cancel`, and retained-child follow-up.
- Derive sender session and branch from the executing cell; generated code cannot supply or spoof them.
- Route direct messages to the unique parent, named direct child, or sibling. Deeper relatives communicate through the intervening session.
- Keep the primary payload a bounded UTF-8 string. Permit optional task and artifact references without requiring a general A2A content protocol.
- Return durable receipts that distinguish accepted/queued, delivered to context, acknowledged, rejected, and failed states.
- Define behavior for running, idle, stopped, and unavailable targets. A message to an idle retained child may schedule a normal follow-up turn; a busy target receives queued steering input at a durable boundary.
- Preserve ordering per sender/receiver pair, enforce size and pending-queue limits, and make duplicate sends idempotent when supplied the same intent key.
- Materialize incoming messages with sender relationship, task, and receipt provenance.
- Expose the same records through the public protocol and FU-005 TUI without inventing a second message store.
- Narrow the current root-family mailbox permission to the documented parent/sibling/direct-child reach for model-facing sends.

### Acceptance criteria

- A parent spawns a child, receives its result, sends a follow-up after the child becomes idle, and receives a second reply from the same retained session.
- A child replies to its unique parent without naming or spoofing the sender.
- A sibling message resolves by stable name or ID and rejects ambiguous targets.
- A model-facing send to a grandchild or unrelated root family is rejected with a typed reach error.
- Busy-target delivery is queued without blocking the sender; idle-target delivery schedules at most one attributable follow-up turn.
- Restarting the supervisor after send, delivery, or acknowledgement preserves the exact next state without duplicate messages or turns.
- Message size, rate, queue, cancellation, and unavailable-target behavior have deterministic tests.
- The TUI can show sender relationship, message text, task/artifact links, and receipt state from committed events.

### Dependencies

- FU-004 for autonomous model-driven use.
- FU-005 consumes the public records for the complete terminal experience but does not block the SDK and runtime work.

### Exclusions

- Google's A2A protocol or arbitrary third-party agent interoperability.
- Direct cross-family communication, global broadcast, or unauthenticated remote delivery.
- Embedding an agent's full context in every message.


### Completion evidence

- Commits: `4a82122`, `a22becf`, and Supervisor integration in `bbeddb1`.
- Implementation: `sdk.agents` spawn/list/send/messages/acknowledge/cancel/followUp; derived sender identity; nuclear-family authorization and human-name resolution; bounded durable receipts, context delivery, busy steering, retained same-child follow-up, automatic replies, cancellation/recovery, protocol/TUI surfaces, and migration 009.
- Verification: final suite passed 452 tests with 2 external skips before FU-014; family suite 14/14, agent-run suite 16/16, Slice 2 45/45. Independent review found legacy non-nuclear retained rows poisoning list and an admission-to-run crash gap; legacy rows now have rendering-only compatibility and `spawnRunnable` commits `AgentRunRequested` atomically with admission. Final adversarial re-review passed.
- Remaining limitation: rejected unauthorized sends return typed errors without retaining the rejected payload, avoiding durable storage of untrusted message content.

---

## FU-013 — Add first-class recursive model calls with durable handles

**Status:** Done

### Gap

Programmatic model calls are the defining RLM capability: model-generated code can select data, launch recursive calls in loops or concurrently, and combine their results. Agencity's console can submit a generic executor request and spawn a version-pinned subagent specification, but `ConsoleSdk` has no first-class typed recursive-model API. A model cannot express the equivalent of Prime Agent's `rlm(...)` without knowing internal executor operations.

A plain promise around a provider request would violate the recovery invariant. The recursive call and its ownership must survive the worker that awaited it.

### Outcome

TypeScript cells can start one or many isolated model sessions over explicit inputs, retain serializable handles, await results while connected, and resolve the same handles after restart. Every call is a normal durable task/session with attributed context, model configuration, budget, cancellation, messages, artifacts, and terminal state.

Suggested shape:

```ts
const calls = await rlm.startMany(
  chunks.map((chunk) => ({
    task: "Extract the claims and supporting evidence.",
    input: chunk,
  })),
);

const results = await Promise.all(calls.map((call) => call.result()));
```

The ergonomic `rlm` API is backed by the ordinary recursive-agent and outbox services. It is not a privileged second execution system.

### Scope

- Add typed `rlm.start`, `rlm.startMany`, `rlm.get`, `rlm.result`, and `rlm.cancel` console operations.
- Accept bounded JSON input plus durable artifact, document-range, event, memory, and SQL-row references.
- Inherit the parent model policy by default while allowing only policy-authorized model overrides.
- Reserve tree budgets and enforce depth, child-count, token, cost, wall-clock, result-size, and provider-concurrency limits before admission.
- Represent each call as a durable child task/session and return a serializable handle immediately after admission commits.
- Make a retained handle resolvable from a later cell or fresh worker. In-process promise convenience must not be the only completion path.
- Record the exact input identities, context records, model and harness versions, provider attempts, usage, result artifacts, and terminal outcome.
- Support bounded concurrent fan-out and deterministic aggregation by stable handle or input position rather than completion order.
- Deliver completion through the same mailbox/task-terminal records used by recursive agents.
- Surface succeeded, failed, cancelled, budget-exceeded, and unknown outcomes without converting partial batches into all-or-nothing success.

### Acceptance criteria

- A cell divides an input larger than one model context into chunks, starts concurrent recursive calls, and combines their retained results without placing the full input in any one call.
- Killing the console worker after child admission leaves handles that a fresh cell can resolve without starting duplicate model calls.
- Killing the supervisor before request, during provider execution, and after committed completion recovers to the correct durable outcome.
- Repeating admission with the same intent keys returns the same child handles and does not reserve budget twice.
- A parent tree cancellation stops admissible in-flight calls, preserves completed results, and records provider outcomes that cannot be confirmed as unknown.
- Model, context, input, usage, harness, and result provenance is queryable for every recursive call.
- Concurrency and budget tests prove limits are admission controls rather than best-effort counters.
- A provider cannot be selected outside the delegated policy through generated TypeScript.

### Dependencies

- FU-003 for explicit usable provider/model configuration.
- FU-004 consumes this API as part of autonomous RLM execution but does not own its durable semantics.

### Exclusions

- Stateless provider calls that bypass sessions, tree budgets, or the outbox.
- Long-lived family steering and follow-up messaging, which belongs to FU-012.
- PostgreSQL coordination or cross-device task stealing.


### Completion evidence

- Commit: `42982e4`.
- Implementation: `rlm.start/startMany/get/result/cancel` over existing durable child tasks/sessions, bounded typed input references, policy-checked models, durable terminal outcomes, result artifacts, and migration `007_recursive_model_input_results.sql` for the rebuildable projection.
- Verification: `test/integration/recursive-console.test.ts` plus the Slice 2 recursive/recovery suites; independent adversarial review reported 30/30 probes passing.
- Remaining limitation: result waiting polls durable projection state; reference/result limits are fixed bounded runtime policy.

---

## FU-014 — Drive goals, completion gates, heartbeats, and schedules through product runs

**Status:** In progress

### Gap

The runtime already implements durable goals, required completion gates whose results are pinned to a workspace cursor and marked stale when the workspace changes, gate recovery after crashes, and heartbeats with coalesced missed ticks that can continue a goal. The product does not use them. The ordinary model loop stops only on budget exhaustion or a stopped/failed session status and never consults goal or gate state, so nothing prevents a run from ending because the model claimed completion. The raw TUI lists goals and heartbeats and accepts `/complete-goal <id>` by internal ID, but an ordinary task never creates a goal, no gate runs during a normal run, and there is no one-time or recurring schedule surface.

The parent PRD's autonomous-operation section requires persistent goals, completion gates, timeouts, and scheduled heartbeats. The Prime Agent reference implementation exposes `/goal`, a user-owned heartbeat, agent-created heartbeats, general one-time and cron schedules, and bounded autonomous continuation with user-defined quality gates that are not rerun while the workspace is unchanged.

### Outcome

A normal run with a goal continues until its required completion gates pass against attributable workspace state or a visible bound is reached. Users manage goals, heartbeats, and schedules through product commands without internal IDs. The model manages its own heartbeats and inspects its goal state through the console SDK.

### Scope

- Create or attach a durable goal, its gates, and its limits when a task requests autonomous completion.
- Make FU-004 run continuation consult goal state: completion is accepted only after required gates pass, and a failed gate returns its bounded output to the model for another attempt.
- Do not re-execute an identical gate while the pinned workspace state is unchanged; present the stale or blocked state instead.
- Expose goal lifecycle operations (create, status, pause, resume, clear) through the product surface with human-readable presentation.
- Expose user heartbeats and agent-created heartbeats: creation, interval, delivery mode, pause, resume, and clear.
- Add one-time and recurring schedules that queue a durable prompt for a session. Due ticks are claimed before delivery, missed ticks are coalesced, and a crash never replays a prompt whose delivery is uncertain.
- Add `goals` and `heartbeats` operations to the console SDK so the model can manage its own recurring wake-ups within existing scope and budget rules.
- Present goal, gate, heartbeat, and schedule state distinctly in FU-005 surfaces, including failed, stale, blocked, and budget-limited outcomes.

### Acceptance criteria

- A run with a configured required gate does not report success while the gate fails, and the failed gate's bounded output appears in the next model context.
- An unchanged workspace does not re-execute an identical completion gate; the blocked state names the stale reason.
- A heartbeat wakes an idle session into exactly one attributable follow-up turn; restarting between the tick and the turn duplicates neither.
- A one-time schedule fires once, survives supervisor restart before firing, and never fires twice after recovery.
- Goal completion is recorded only through gate-checked completion events, never from assistant text alone.
- Goal, gate, heartbeat, and schedule records remain queryable with event provenance.

### Dependencies

- FU-004 owns the typed run loop this ticket extends.
- FU-015 provides heartbeat and schedule turn delivery while no client is attached.
- FU-005 presents these records in the TUI.

### Exclusions

- Cross-device schedule execution or distributed schedule ownership.
- Calendar-style scheduling interfaces beyond time and interval expressions.

---

## FU-015 — Keep detached sessions executing in a background service

**Status:** In progress

### Gap

FU-005 and FU-006 assume durable work can outlive a terminal client, but no component provides that behavior. The current TUI constructs an in-process supervisor, so exiting the client stops model turns, cell execution, goal continuation, and heartbeat delivery. Committed state remains resumable, but nothing continues it. The `serve` command starts a loopback HTTP/SSE server that must be managed manually and has no lifecycle, discovery, or health surface.

The Prime Agent reference implementation runs a detached supervisor with one resident worker per root session tree. Closing the terminal detaches the client without stopping work; `list`, `attach`, `rename`, `stop`, `status`, `doctor`, and `shutdown` manage the background services; per-session leases prevent concurrent owners; and crash recovery restores workers without replaying uncertain effects.

### Outcome

Runs, goals, heartbeats, schedules, and child sessions continue while no client is attached. The product entrypoint discovers and reattaches to background work, and explicit commands inspect, stop, and shut down the background service. Client exit and execution stop become visibly different operations.

### Scope

- Run session execution in a local background service that owns supervision and the loopback protocol server; clients attach through the same public snapshot/event contract FU-005 consumes.
- Start the service on demand from the product entrypoint without requiring a manually managed `serve` terminal.
- Add product lifecycle commands covering agent listing, attach, stop, service status, and shutdown, plus a user-initiated `send` that delivers a durable message to a named session through the existing mailbox model.
- Enforce one execution owner per session: extend the existing device-level ownership with process-level leases so a second service or client cannot advance the same branch concurrently.
- Recover after a service crash from durable state only, preserving no-duplicate-effect guarantees; work whose outcome was lost in flight becomes `unknown` rather than being replayed.
- Protect service state, sockets, and tokens with owner-only permissions, and keep the trusted-local boundary explicit: process separation is lifecycle isolation, not a sandbox.
- Keep single-process embedded operation available for tests and diagnostics with identical contract behavior.

### Acceptance criteria

- Starting a task and quitting the client leaves the run continuing to a gate-checked terminal outcome; reattaching shows the completed work from committed events.
- Reattachment resumes from the client's last cursor without missing or duplicating committed activity.
- Killing the background service at durable boundaries loses no committed state, and restart reconciles in-flight effects to explicit outcomes.
- Two concurrent clients cannot both advance the same branch; the second observes, steers, or receives a typed ownership error.
- Service status distinguishes running, idle, detached, and stopped work; shutdown stops services without deleting or corrupting sessions.
- The client never reports process exit as proof that external work stopped.

### Dependencies

- FU-001 routes the product entrypoint through this service.
- FU-004 provides the autonomous run being continued.
- FU-005 and FU-006 consume attach/detach semantics.

### Exclusions

- Multi-device or remote execution-ownership failover.
- Coordinated in-place upgrade of running services.
- Authentication for non-loopback clients.

---

## FU-016 — Implement the trajectory-reviewing refiner behind `/refine` and adaptation triggers

**Status:** In progress

### Gap

The continual-harness services govern proposal validation, candidate exposure, evaluation, promotion, and rollback, but every proposal must arrive fully formed: the current TUI `/refine` accepts a raw JSON proposal document, and the harness service requires the caller to supply the trigger text and typed edits. Nothing reads a trajectory and produces a proposal. The parent PRD's refinement lifecycle begins with a trigger that identifies repeated failure, reusable success, user correction, stale memory, or unproductive delegation, followed by a refiner that reads the source trajectory and current harness versions.

The Prime Agent reference implementation exposes `/refine [instructions]`, which reviews the current trajectory and applies small, evidence-backed updates to supplemental prompts, memories, skill descriptions, and subagent specifications with recorded history and rollback.

### Outcome

A user runs `/refine`, optionally with instructions, and a refiner model call reviews the retained trajectory, cites durable evidence, and emits typed proposals through the existing governance pipeline. Detected triggers — repeated effect failure, repeatedly failing completion gates, explicit user corrections — can invoke the refiner automatically within existing scope and authority rules.

### Scope

- Run the refiner as an ordinary durable model call or recursive session with attributable context, never as an untracked side channel.
- Give the refiner bounded access to the trajectory, current harness versions, memory, and evaluation history through the normal query surfaces.
- Emit proposals as typed edits validated by the existing harness service; malformed or over-broad output is rejected, not partially applied.
- Detect triggers from durable records such as effect outcomes, gate results, and user corrections, not from heuristic parsing of assistant prose.
- Preserve existing promotion rules: session-local activation may be automatic, workspace changes require objective evaluators and repeated evidence, and user or global scope requires explicit approval.
- Record refiner provenance: the trigger, source events, model call, and produced proposals.
- Make `/refine` a product command backed by this refiner; keep the raw JSON proposal path as an advanced diagnostic.

### Acceptance criteria

- `/refine` on a session with a repeated tool failure produces a validated proposal whose evidence IDs reference the actual failure events.
- The refiner cannot propose outside its authority scope; an over-broad proposal is rejected with a typed error.
- An automatic trigger fires only after its configured repeated durable evidence exists and records why it fired.
- Applying and rolling back a refiner-produced change restores the exact prior harness versions.
- A proposal with persuasive text but no durable evidence does not activate beyond the allowed session-local scope.
- Restarting the supervisor during refinement resumes or fails visibly without duplicate proposals.

### Dependencies

- FU-003 for a usable non-echo model.
- FU-004 for invocation during autonomous runs; FU-013's recursive-call API is a natural execution vehicle but the existing internal services are sufficient.

### Exclusions

- Model-weight training.
- Changes to promotion policy; existing evaluator and authority rules are unchanged.

---

## FU-017 — Add skill creation, installation, and management as a product surface

**Status:** In progress

### Gap

The runtime stores versioned TypeScript skills with required tests, candidate exposure, and outbox-backed invocation, and the profile store supports globally installed skills. There is no product flow to create, install, inspect, enable, or remove a skill; a skill currently enters the system only inside a raw harness proposal. The design constitution expects recurring successful workflows to be packaged as inspectable skills instead of enlarging a fixed universal loop.

The Prime Agent reference implementation treats skills as first-class: global, project, and package skill locations; a built-in skill creator that teaches the agent to package new skills; commands to list and manage them; and executable skills that run under the same trust model as generated code.

### Outcome

A user or the agent can package a recurring workflow as an inspectable, tested skill; list installed skills with scope, version, and provenance; enable, disable, and remove them; and install skills from a local directory. Skills remain visible to context selection and callable from the console SDK.

### Scope

- Add product commands (an `agencity skills` group and `/skills`) for list, show, test, enable, disable, and remove, presenting name, scope, version, provenance, and test status.
- Support workspace-scoped and profile/global-scoped installation consistent with the existing store boundaries.
- Provide a skill-creation flow in which the agent drafts a skill through the existing harness proposal lifecycle, including required tests before activation.
- Support importing a skill from a local directory with explicit user confirmation and a trusted-local warning; imported content records its source provenance.
- Keep executable skills inside existing effect, permission, and secret-handling rules; a skill cannot widen authority.
- Disabling a skill removes it from context selection and invocation without deleting retained versions or history.

### Acceptance criteria

- A skill created from a session activates only after its tests pass and is invocable from a later console cell.
- Installed skills are listed with scope and provenance; internal IDs are available under details but not required.
- A disabled skill no longer appears in materialized context or accepts invocation, and re-enabling restores the same version.
- Importing a skill directory requires explicit confirmation and records source provenance.
- A skill cannot read brokered secrets or perform writes outside the typed SDK surface.
- Removal respects retained history; prior invocations remain attributable.

### Dependencies

- FU-004 for agent-driven creation and invocation inside autonomous runs.
- FU-016 makes trajectory-derived skill proposals ergonomic but is not a prerequisite for manual management.

### Exclusions

- A public skill registry or remote skill installation.
- Compatibility with other harnesses' skill formats.

---

## FU-018 — Stream provider output incrementally to attached clients

**Status:** Done

### Gap

Model providers currently record one output chunk after a completion finishes, so clients see nothing until the turn completes. The parent PRD lists chat with streaming model output as part of the initial terminal product, and FU-005 can only display incremental output if an adapter produces it. The Prime Agent reference implementation streams assistant deltas to attached clients while keeping the transcript authoritative.

### Outcome

Providers that support token streaming deliver incremental assistant output to attached clients during a model call. Canonical durable state remains consistent: an interrupted stream never leaves a partial message that later work depends on.

### Scope

- Extend the model executor contract with an optional streaming capability and truthful capability reporting for providers without it.
- Decide and document the durable representation: either bounded committed `ModelOutputChunk` events or non-canonical progress notifications. In both cases, dependent work reads only the committed completion (message, usage, terminal outcome), and event volume stays bounded.
- Keep the outbox lifecycle unchanged: durable request before execution, one terminal outcome, and `unknown` on uncertain interruption.
- Define interruption behavior: a stream that dies before commit produces no committed assistant message; recovery observes the effect outcome, not the partial text.
- Carry in-progress output through the protocol/SSE surface separately from committed events without breaking cursor-resume semantics.
- Keep echo non-streaming and visibly labeled as the demo fixture.

### Acceptance criteria

- With a streaming-capable provider, an attached client displays output before the completion commits.
- Killing the supervisor mid-stream yields a `failed` or `unknown` model effect with no committed partial assistant message, and resume does not replay the stream.
- Cursor-based catch-up after reconnect returns only committed events; progress delivery is never required for correctness and never duplicates history.
- A provider without streaming reports the limitation, and the client renders the committed message without pretending to stream.
- Existing recovery, idempotency, and duplicate-effect tests pass with streaming enabled.

### Dependencies

- FU-003 for real provider configuration.
- FU-005 consumes the client-visible behavior.

### Exclusions

- Token streaming for the echo fixture.
- Streaming cell or tool output; bounded logs already cover cells.


### Completion evidence

- Commit: `42982e4`.
- Implementation: truthful optional provider streaming, OpenAI-compatible SSE parsing, cursorless bounded/redacted progress, authoritative atomic completion, provider capability endpoint, client/TUI progress rendering, and explicit non-streaming mode.
- Verification: ten streaming integration tests include pre-commit deltas, fragmentation, cancellation, supervisor `SIGKILL`/unknown recovery, committed-only reconnect, progress bounds, and a known secret split across deltas; independent review passed.
- Remaining limitation: real OpenAI streaming was not credential-verified; progress is intentionally ephemeral and droppable.

---

## FU-019 — Add automatic and agent-directed context compaction

**Status:** In progress

### Gap

Compaction exists as a manual, single-strategy operation: the supervisor produces a deterministic extractive summary of all but the most recent twenty messages, and context materialization includes the last twenty messages plus the last three compaction summaries. Nothing observes context growth against the configured model's limits, the model cannot request compaction with guidance about what to preserve, and no summarizing strategy exists. The parent PRD treats compaction as a derived view with multiple coexisting strategies, and long autonomous runs will exceed a fixed recent-message window.

The Prime Agent reference implementation compacts automatically on overflow or near a configured threshold, lets the agent inspect and request compaction with custom instructions, and continues goals, heartbeats, and child sessions across compaction.

### Outcome

Long runs continue past context limits. Compaction happens automatically when materialized context approaches the model's capacity, can be requested by the user or the model with preservation guidance, records its sources and strategy, and never deletes canonical history.

### Scope

- Track provider context-window capacity and estimate materialized context size; trigger compaction near a configured threshold and on provider context-overflow errors.
- Add a model-generated summarization strategy alongside the deterministic extractive strategy, recorded with its strategy identity and source event IDs; the summarizing model call is a normal outbox-backed effect.
- Add `compact` operations to the console SDK and product surface that accept optional preservation instructions.
- Keep compaction a derived view: source events are retained, and a branch can be re-materialized under a different strategy.
- Compaction must not interrupt active goals, heartbeats, schedules, child sessions, or durable working values.
- Include compaction provenance in each dependent model call's context records.

### Acceptance criteria

- A run whose history exceeds the model's context window continues after automatic compaction without manual intervention.
- The next model call's context records name the compaction strategy and its source events.
- User- or model-requested compaction with instructions biases the summary accordingly and records the request.
- Compaction never deletes or rewrites canonical events, and rebuild after compaction produces identical projected state.
- Goals, heartbeats, and child sessions remain active across compaction.
- A branch re-materialized with a different strategy yields a different derived view over identical canonical history.

### Dependencies

- FU-004 integrates automatic compaction into the run loop.
- FU-003 provides the model used by the summarizing strategy; the deterministic strategy remains available without it.

### Exclusions

- Destructive history pruning; owned-scope deletion remains a separate guarded operation.
- Cross-session or workspace-level summarization.

---

## Template for additional follow-up tickets

Copy this section when adding a newly discovered gap.

```md
## FU-XXX — Short outcome-oriented title

**Status:** Proposed

### Gap

What observable behavior, original requirement, integration, or acceptance coverage is missing or incomplete? Link the parent PRD section and current evidence where useful.

### Outcome

What can a user, operator, integrator, or implementation agent do after this ticket that they cannot reliably do now?

### Scope

- Concrete implementation responsibility.
- Architectural boundaries that must remain intact.
- Documentation or migration responsibility.

### Acceptance criteria

- Black-box or behavior-level criterion.
- Recovery/failure criterion where applicable.
- Automated evidence requirement.

### Dependencies

- FU-XXX or external decision.

### Exclusions

What adjacent work is deliberately not part of this ticket?

### Completion evidence

- Commit(s):
- Implementation files:
- Automated tests:
- Manual/real-integration verification:
- Remaining limitations:
```

## Candidate areas for future tickets

The following areas should be assessed and promoted into concrete tickets when evidence supports them:

- real Turso Cloud verification and operational onboarding;
- official sync-server test reproducibility in ordinary development environments;
- user-facing permission review and approval workflows, including the policy model that decides which effects require approval;
- reconciliation UI for sync conflicts and uncertain external effects;
- artifact backup, export, garbage collection, and restore ergonomics;
- subagent tree visualization and terminal-result presentation beyond the messaging contract in FU-012;
- session naming, search, archival, and deletion UX;
- MCP or comparable external tool integrations inside the console permission model;
- bundled first-party skills such as web search;
- accessibility, terminal compatibility, and large-history performance;
- packaging, release versioning, upgrade, migration testing, and coordinated in-place upgrade of running background services;
- external sandbox placement and truthful capability presentation;
- documentation drift between the parent PRD, README, API, and shipped behavior.

Items listed here are not accepted work and must not be marked complete merely because they are mentioned.

## Evidence log

Add dated review and implementation evidence here.

### August 6, 2026 — Initial follow-up review

- The repository implements substantial portions of delivery slices 1–4 from the parent PRD.
- Local verification passed 224 tests with 2 external/credential-gated tests skipped.
- The ordinary CLI path still requires explicit session and branch IDs to enter the TUI.
- CLI session creation defaults to the echo provider.
- The model loop records a single response rather than driving the full typed autonomous TypeScript action loop described above.
- TypeScript cells require explicit `return`; final expressions are discarded, and the SDK has no direct cell-history or working-value discovery operations.
- The retained mailbox and subagent runtime is not exposed through the model-facing TypeScript SDK, so agents cannot yet perform Prime Agent-style family messaging and follow-up.
- `ConsoleSdk` has no first-class recursive model-call API; a generic executor request is not an ergonomic or durable RLM contract.
- No root or nested `AGENTS.md` existed at the time of the initial review.
- These observations seeded FU-001 through FU-013; they are findings, not completion evidence.

### August 6, 2026 — FU-010 completed

- Added a root `AGENTS.md` covering repository purpose, authoritative plans, current implementation status, architectural invariants, security boundaries, development and verification commands, source layout, testing expectations, documentation discipline, and definition of done.
- Verified that its local plan/document links resolve in the current tree.

### August 6, 2026 — Prime Agent parity review

- Compared this backlog against a local checkout of the Prime Agent reference implementation, including its daemon, long-running-agents, skills, compaction, and usage documentation.
- The reference implementation provides daemon-backed detached execution with attach, list, rename, stop, status, doctor, and shutdown lifecycle commands; persistent goals, user and agent-created heartbeats, and one-time/cron schedules; bounded autonomous continuation with user-defined quality gates that are not rerun while the workspace is unchanged; a `/refine` flow whose refiner reviews the trajectory and applies evidence-backed harness updates with rollback; first-class skill locations, management commands, and a built-in skill creator; automatic threshold-based compaction with agent-directed preservation instructions; and incremental assistant output streaming.
- Agencity's runtime already implements durable goals, gates with workspace-cursor pinning and staleness detection, coalesced heartbeats, harness proposal governance, versioned tested skills, and manual deterministic compaction, but FU-001 through FU-013 never connected them to the product run loop or product surfaces. The ordinary model loop stops only on budget or session status and never consults gates; the TUI `/refine` accepts only raw JSON proposals; exiting the client stops execution because the supervisor is in-process; providers commit one post-completion output chunk; and compaction is manual with a single extractive strategy.
- These findings seeded FU-014 through FU-019 and amendments to FU-004, FU-005, FU-006, FU-009, the ticket index, the follow-up completion standard, and the candidate list.


### August 6, 2026 — Product foundation, notebook, recursive-model, and streaming tranche completed

- Commit `42982e4` completes FU-001, FU-002, FU-003, FU-007, FU-011, FU-013, and FU-018 with implementation, tests, documentation, and independent review.
- Review found and implementation fixed three release-blocking issues before completion: path-derived workspace identity did not survive repository moves; credential-reference input could persist a shell-expanded secret; and the linked CLI source lacked executable Git mode. The fixes added a durable owner-only workspace marker, credential-material rejection/byte-scan tests, and mode `100755` with out-of-tree link verification.
- Streaming review identified cross-delta secret leakage as a possible ephemeral-progress risk. Progress redaction now buffers secret prefixes across deltas, emits a bounded truncation marker, and keeps the authoritative completion atomic.
- FU-013 reused the existing task/session/outbox runtime rather than adding a stateless provider-call path; migration 007 changes only the rebuildable recursive-handle projection.
- The accepted parity amendments already present in the working plan added FU-014 through FU-019 and tightened the completion standard/dependencies; they were retained because the Prime Agent parity review showed these capabilities are required rather than optional candidate work.
- External Turso and real-provider checks remain separately gated and are not represented as verified by this tranche.

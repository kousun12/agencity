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
- recovery, cancellation, permissions, budgets, and unknown outcomes remain visible through the product surface;
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
| FU-001 | Make `agencity` the default product entrypoint | Proposed | — |
| FU-002 | Add workspace discovery and human session resume/selection | Proposed | FU-001 |
| FU-003 | Add explicit provider and model onboarding | Proposed | FU-001, FU-002 |
| FU-004 | Implement the autonomous typed TypeScript agent-run loop | Proposed | FU-003, FU-011, FU-013 |
| FU-005 | Turn the TUI into the complete protocol-backed product client | Proposed | FU-001, FU-002, FU-004, FU-012 |
| FU-006 | Expose durable interruption, recovery, and unknown outcomes in the CLI/TUI | Proposed | FU-004, FU-005 |
| FU-007 | Provide a real installation and executable workflow | Proposed | FU-001 |
| FU-008 | Reorganize low-level CLI operations as advanced surfaces without breaking compatibility | Proposed | FU-001, FU-005 |
| FU-009 | Add product-level end-to-end acceptance coverage | Proposed | FU-001–FU-008, FU-011–FU-013 |
| FU-010 | Add repository-level purpose and implementation guidance | Done | — |
| FU-011 | Give TypeScript cells notebook-style observation and inspection semantics | Proposed | — |
| FU-012 | Expose durable family messaging and retained subagent follow-up to the model | Proposed | FU-004 |
| FU-013 | Add first-class recursive model calls with durable handles | Proposed | FU-003 |

---

## FU-001 — Make `agencity` the default product entrypoint

**Status:** Proposed

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

---

## FU-002 — Add workspace discovery and human session resume/selection

**Status:** Proposed

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

---

## FU-003 — Add explicit provider and model onboarding

**Status:** Proposed

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

---

## FU-004 — Implement the autonomous typed TypeScript agent-run loop

**Status:** Proposed

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
8. Continue until terminal outcome, cancellation, user decision, budget exhaustion, or visible unknown effect.

Unstructured assistant text must not be heuristically executed as code. Providers may use native structured output or a tested portable encoding, but all actions share one domain contract.

After a cell commits, the next model call receives its bounded result, logs, exported working-value references, effect outcomes, and exact event provenance. Values that remain in the disposable Bun heap are not observable state. FU-011 defines the cell-level observation contract, FU-012 adds model-facing family messaging, and FU-013 provides the programmatic recursive model API.

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
- Model action, context, cell, tool, subagent, and final response provenance is queryable from retained records.

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
- Show committed streaming assistant output where provider adapters support it.
- Display expandable TypeScript cells, logs, SQL results, and tool outcomes.
- Show current run/task state, model, budgets, recursive tree, mailbox activity, goals, memory, harness/refinement state, sync, and conflicts.
- Surface failed, blocked, cancelled, budget-exceeded, and unknown outcomes distinctly.
- Keep trusted-local mode visible.
- Support `/new`, `/sessions`, `/info`, `/model`, `/run`, `/stop`, `/history`, `/cell`, `/tree`, `/budget`, `/memory`, `/refine`, `/branch`, `/resume`, `/compact`, `/sync`, `/conflicts`, and `/quit`.

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
- Startup summarizes recovered work, pending effects, active children, and unknown outcomes.
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

**Status:** Proposed

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

---

## FU-008 — Reorganize low-level CLI operations as advanced surfaces without breaking compatibility

**Status:** Proposed

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

**Status:** Proposed

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

---

## FU-012 — Expose durable family messaging and retained subagent follow-up to the model

**Status:** Proposed

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

---

## FU-013 — Add first-class recursive model calls with durable handles

**Status:** Proposed

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
- provider-native streaming and structured-action compatibility;
- user-facing permission review and approval workflows;
- reconciliation UI for sync conflicts and uncertain external effects;
- artifact backup, export, garbage collection, and restore ergonomics;
- continual-harness proposal/evaluation UX beyond raw JSON commands;
- subagent tree visualization and terminal-result presentation beyond the messaging contract in FU-012;
- session naming, search, archival, and deletion UX;
- accessibility, terminal compatibility, and large-history performance;
- packaging, release versioning, upgrade, and migration testing;
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

# Verification guide

This page describes the current repository checks and the claims each check supports. Run commands from the repository root with Bun 1.3.13 or newer.

Install the locked dependencies before verification:

```sh
bun install --frozen-lockfile
```

## Default verification

The main local gate is:

```sh
bun run verify
```

The `verify` script runs, in order:

1. `bun run typecheck`;
2. `bun run check:architecture`;
3. `bun run test:core`; and
4. `bun run test:acceptance`.

With external opt-in variables unset, this is the reproducible default claim. It checks TypeScript, static architecture rules, deterministic runtime behavior, and the installed-product path. It does not verify a live model provider, an external official Turso Sync server, or Turso Cloud.

### What the default checks establish

`bun run typecheck` runs `tsc --noEmit` across source, tests, and repository scripts. A pass establishes that the checked TypeScript programs satisfy the configured static types; it is not runtime evidence.

`bun run check:architecture` checks structural invariants, including:

- package entrypoints, subpath exports, and required scripts;
- domain-layer dependency direction;
- confinement of LibSQL and Turso SDK imports and emitted public types to their adapters;
- the exact supported Turso Sync dependency version;
- migration numbering and table classification;
- update and delete guards for canonical and immutable derived tables; and
- forbidden application SQL mutations of immutable tables.

These are static constraints. They do not replace replay, recovery, protocol, security, or product behavior tests.

`bun run test:core` runs the deterministic unit, integration, end-to-end, and placement suites used by the main gate. Independent test files run in four isolated Bun workers; the process-heavy end-to-end files run afterward in one worker. Together, their current coverage includes schema-6 event replay and reducer-22 rebuild, typed effect origins, exact provider-input-v2 admission, bounded observation ownership, bounded shell/managed-process/file/artifact/cell output, root and nested repository-instruction loading, durable initial agent profiles and prompt pins, persistent exact-branch REPL bindings and object identity, readable epoch replacement, pre-execution stale-epoch rejection, runtime-throw mutation retention, namespace loss and durable reconstruction, branch-aware console capacity, outbox recovery, durable managed-process handles, run cancellation, token-authenticated crash cleanup, descendant process-group cleanup, explicit raw text/object generation and its cancellation/budget/context boundaries, typed text/object child-agent results and retained lifecycle lookup, formal autonomous actions, structured refinement, retained terminal refinement outcomes across reopen, recursive sessions and queue/steer mailboxes, goals and gates, memory and refinement, local synchronization logic, execution leases and fencing, protocol cursor recovery, one-hour managed-service defaults and managed-process keep-alive behavior, model streaming semantics, first-run and branch-attached provider/model selection, terminal family and workspace-root navigation, structured Markdown and TypeScript cell rendering, responsive terminal layout, and placement contracts.

Those tests use local fixtures, temporary databases, deterministic providers, and in-process or loopback test services where appropriate. A pass supports the behaviors exercised by those tests. It does not establish hostile-code isolation, exactly-once external effects, automatic cross-device failover, or correctness at every possible machine-instruction crash boundary.

## Installed-product acceptance

Run the deterministic black-box product suite directly with:

```sh
bun run test:acceptance
```

Each case creates an isolated Bun install root, temporary home directory, and fresh external repository. Independent acceptance files run in four isolated Bun workers. Each case runs `bun link` and invokes only the resulting `agencity` executable from outside the source checkout. Deterministic crash cases use a shorter test-only execution lease so ownership expiry is exercised without waiting for the five-second production duration; managed-service integration tests separately cover the production default. A source guard rejects acceptance tests that import runtime internals, open LibSQL directly, use private runtime clients, or supply opaque session, branch, or history coordinates.

The suite uses a local OpenAI API fixture reached through the Vercel AI SDK transport and implements the formal `bun_console`/`finish` response contract and streaming transport. It covers:

- truthful missing-provider behavior and explicit provider/model selection;
- canonical catalog model IDs and durable reasoning-effort selection;
- autonomous TypeScript cells and typed file or shell effects;
- compact cell observations, bounded durable-state use, persistent REPL bindings across cells, runtime-failure mutation retention, and deliberate state/artifact reconstruction after worker or service loss;
- unexpected large shell output, bounded spill delivery, and focused exact artifact-range recovery before completion;
- exact root and child provider tool sets, single-call cardinality, narration-plus-call acceptance, and no text-JSON fallback;
- raw text generation, raw object generation through real worker-side Zod conversion, and explicit-context-only provider inputs;
- awaited text/object child agents, detached spawn/result, nested child/grandchild execution, and pre-admission capacity failure;
- typed child recovery across committed parent-worker/service loss and installed-client loss without duplicate admission;
- mode-aware child messages, retained queued work, and the sealed recursive refinement path;
- sealed structured refinement submission with a message-free typed child result;
- failed completion-gate repair;
- detach, client loss, managed-service recovery, one-hour typed and human status, resume, named branching, tree, status, and history;
- distinct non-interactive run outcomes and interruption behavior;
- committed-action and effect crash recovery without duplicate execution;
- unknown effects, no automatic retry, and evidence-only reconciliation; and
- refinement review, installed skills, context compaction, streaming, and scheduled wakes; and
- governed root and child profiles, old/new invocation pins, blocking approval, rejection, bounded reproposal, exact rollback, detached managed-service restart, deduplication, and route-relative no-ID inspection.

This acceptance suite is intentionally non-interactive. The `test:core` groups separately cover deterministic full-screen renderer frames, stable reconciled Markdown and code identities, user-task/run interleaving, durable cell joining and bounded output, retained no-change/applied/rejected refinement summaries, line-preserving composer paste, `Shift-Enter` multiline input, follow-until-scrolled timeline behavior, idle and active inspectors, width-prioritized footer content, normal/compact/minimum height modes, draft-safe family focus, parent/child input, workspace-root search and selection, stale catalog races, model typeahead, and exact route switching. `bun run test:e2e` adds a linked-executable pseudo-terminal journey that begins with searchable provider selection, hidden fixture credential entry, and display-name model selection; then expands a retained TypeScript cell; opens a root, child, and grandchild; climbs back through retained parents; creates a second root; opens the workspace Agents view; selects the other root; detaches; and resumes the remembered selection without exposing credentials. The same journey verifies that the original cell and child were not duplicated or cancelled.

The agent-run integration suite verifies zero, duplicate, malformed, truncated, oversized, and unknown formal calls execute nothing; a text-JSON response does not become an action; a typed rejection is delivered once to one correction step; a second consecutive rejection terminates the run; and recovery after committed response or action boundaries does not duplicate the model call, cell, message, or observation.

The integration suite also verifies declaration-only AI SDK tools for OpenAI, Anthropic, and Gateway; direct-transport parallel-call suppression; normalized reasoning mapping; structured and text streaming; bounded warnings and errors; model-catalog normalization, endpoint-keyed cache isolation, stale fallback, and malformed-record rejection; dispatch equality; exact registered-value failure across complete custom-provider structured output while unregistered credential-like text remains ordinary data; schema-1 through schema-5 rejection without deletion; and structured result recovery across rebuild, reopen, and divergent synchronization.

It records a focused family-projection benchmark with 25 relatives and branch histories expanded to 5,000 canonical event records at the storage boundary. It proves that a cold read projects each route once and that a warm refresh reuses current snapshots without replaying the 130,000 retained events. Controller tests separately prove that periodic family refresh requests are coalesced, never overlap, do not accumulate a timer backlog, and stop when the browser is closed and no child is actively working. Workspace Agents catalog tests cover explicit one-shot refresh, stale-row retention, superseded-response rejection, and exact product selection without adding a polling loop.

### First-run provider/model typeahead coverage

The repository contains deterministic coverage for:

- provider display-name and stable-ID matching;
- fuzzy model display-name and canonical-ID ranking, direct-provider creator filtering, exact manual rows, selection reconciliation, and bounded visible windows;
- canonical product-model grammar, byte/control bounds, and terminal-safe catalog presentation;
- hidden credential input, raw-terminal cleanup, loading cancellation, stale fallback, unavailable and empty catalogs, and manual selection without a catalog row;
- credential-free fixture catalog requests that do not make inference requests;
- malformed retained defaults, no-write validation failures, credential persistence after picker cancellation, and known-unsupported versus unknown admission;
- non-Echo retained identity and the explicit retained Echo migration boundary; and
- first-run linked pseudo-terminal selection followed by the existing ancestry, workspace-root, detach, and resume journey.

For the August 11, 2026 implementation revision, `bun run verify` passed typecheck, architecture checks, 1,077 deterministic core tests, 6 linked end-to-end tests, and 22 installed acceptance tests. Two credential-gated Turso tests and the real-provider acceptance smoke were skipped. `bun run test:acceptance:matrix` passed the deterministic installed row and skipped the separately gated real-provider, official Turso Sync, and Turso Cloud rows. Those external integrations remain unverified; catalog fixture coverage is not live-provider evidence.

The package is private. This verifies the documented source and `bun link` workflow; it is not evidence of a package-registry or standalone-binary release.

### Explicit AI and typed-agent cutover evidence

On August 11, 2026, focused Phase 5 verification passed:

- prompt, raw-generation, retained private recursive-operation, and branch-aware console-pool tests: 38 passed, 0 failed, 0 skipped;
- agent-run, family-agent, and managed-service integration tests: 81 passed, 0 failed, 0 skipped;
- installed linked-executable Phase 5 acceptance plus the public-boundary source guard: 6 passed, 0 failed, 0 skipped;
- TypeScript typecheck: passed.

The installed cases use only `bun link`, the public CLI, managed loopback protocol, and generated console SDK. They cover one raw text request, one declared-object request with real Zod conversion, default text and schema-constrained child results, detached `handle.result` lookup with a JSON-compatible non-durable method, nested awaited child/grandchild execution, exact-once recovery after parent worker/service loss, continued awaited work after client loss, and `CONSOLE_CAPACITY_EXCEEDED` before grandchild admission. The provider fixture requires no external credential.

The complete aggregate `bun run verify` gate is reserved for final repository verification and is not claimed by this phase entry. Live-provider, official Turso Sync server, and Turso Cloud checks were not run; they remain gated and unverified.

### Default automatic-learning verification

Verification of default automatic learning must cover:

- default-on behavior for a device profile with no explicit preference;
- persistent device-wide pause and resume across workspaces and restart;
- local-only memory, prompt-note, tested-skill, and subagent-specification targets;
- deterministic validation and one separate sealed reviewer for every proposal;
- one admitted trigger per scan attempt with deferred evidence left available;
- thresholds of three effect failures, three failed cells in one run, two distinct-pin gate failures, and one typed correction;
- effect-backed cell failures included in run-level repair churn, with their causally linked effect outcomes excluded from duplicate repeated-effect review;
- five successful terminal runs within a 2,048-record window, refiring only after five newer qualifying successes;
- delayed consideration of the fifth success until the next committed boundary;
- `no_change` as a normal terminal audit outcome rather than a behavioral update;
- truthful `scan_unavailable` history when full-history loading supplies more than 10,000 records;
- pause/admission ordering and transaction-time stale-trigger rejection under concurrency;
- joined status, history, and activity inspection across reflection, governance, application, scan failure, and rollback;
- atomic proposal-level rollback for automatic create, replace, retire, and multi-edit changes; and
- absence of a separate learning spend budget, aggregate review-rate limit, scheduler, or semantic grouping mechanism.

The focused checks are:

```sh
bun run typecheck
bun run check:architecture
bun test --timeout 30000 test/unit/refinement-triggers.test.ts
bun test --timeout 30000 test/integration/refiner.test.ts
bun test --timeout 30000 test/acceptance/profile-governance.test.ts
```

On August 11, 2026, the default automatic-learning change passed `bun run verify`: 1,007 core tests passed with 2 gated skips, 3 end-to-end tests passed, and 18 installed acceptance tests passed with 1 credential-gated skip. Aggregate evidence was 1,028 passes, 3 skips, and 0 failures. Typecheck, architecture checks, focused cross-service lease, divergent-sync, bounded-history, typed-scan, and skill-rollback tests, independent review, and `git diff --check` also passed. The release acceptance matrix reported 1 deterministic row passed, 3 external rows skipped, and 0 failures. The live-provider, official Turso Sync, and Turso Cloud checks remain gated and unverified because their prerequisites were not supplied.

### Adaptive-profile governance evidence

The core profile/governance implementation was verified on August 9, 2026:

- deterministic full suite: 887 passed, 3 gated skips, 0 failed;
- focused governance: 43 passed, 0 failed;
- contract/profile/harness regression groups: 60 passed, 0 failed; and
- typecheck, architecture checks, and `git diff --check`: passed.

Lifecycle hardening was then verified separately:

- focused lifecycle, migration, profile, and governance tests: 106 passed, 0 skipped, 0 failed; and
- typecheck, architecture checks, lints, and `git diff --check`: passed.

Installed governance acceptance then passed:

- focused linked-executable governance journey: 1 passed, 0 skipped, 0 failed;
- complete deterministic acceptance: 15 passed, 1 credential-gated skip, 0 failed;
- release matrix: 1 deterministic row passed, 3 external rows skipped, 0 failed; and
- typecheck, architecture checks, and `git diff --check`: passed.

This evidence covers deterministic validation, proposer/reviewer separation, authority, frozen inputs, current-model dispatch, automatic application, staged tested-skill activation, terminal delivery, rollback, managed-service recovery, fail-closed profile sync divergence, export audit, deletion refusal, migration/rebuild reopening, and the installed no-ID governance journey. The installed journey uses graceful service shutdown and restart; lower-level lifecycle tests cover committed hard process-loss boundaries.

Final post-hardening verification then passed:

- `bun run verify`: passed;
- deterministic core suite: 893 passed, 2 externally gated skips, 0 failed;
- deterministic installed acceptance within the gate: 15 passed, 1 credential-gated skip, 0 failed;
- aggregate test evidence within the gate: 908 passed, 3 skips, 0 failed; and
- `bun run test:acceptance:matrix`: 1 deterministic row passed, 3 external rows skipped, 0 failed.

The externally gated rows—live provider, official Turso Sync server, and Turso Cloud—remain skipped and unverified.

### Agent-context-efficiency benchmark

Run the deterministic production-builder benchmark with:

```sh
bun run benchmark:context-efficiency
```

The benchmark uses the shipped `agentProviderContext`, observation derivation, `buildProviderInputCandidate`, estimator, formal tool registry, local shell executor, and local artifact store. Current provider messages use `agencity.provider-input.v2` and the append-only transcript contract rather than rebuilding an `AGENCITY DURABLE RUN STEP` sliding trajectory.

Deterministic checks cover:

- the initial attributable transcript segment and exact-prefix identity across adjacent requests;
- provider-neutral assistant tool calls and matching tool results, bounded rejection continuation, durable observations, state deltas, and next-action messages;
- attributable segment/cache reset at compaction followed by renewed append-only growth;
- exact candidate identity across estimation, execution, and recovery;
- direct OpenAI Responses wire options: session/branch-stable deterministic key, explicit mode, 30-minute TTL, supported input-text breakpoints, `store: false`, no `previous_response_id`, fixed required tool order, and no parallel calls;
- explicit breakpoints on each supported next-action text block, without relying on function-call outputs for cache writes;
- provider handling of up to 50 recent read breakpoints in very long segments, with prior breakpoints read-only and only the latest four writable per request; and
- retained cache read/write token diagnostics without changing input-plus-output budget debit.

Final deterministic validation for the append-only implementation on August 20, 2026 passed. `bun run benchmark:context-efficiency` recorded 69 strict-prefix transitions, reusable prefixes growing from 4,397 to 19,907 estimated tokens, and 91.15% conservative aggregate reuse across three 24-step runs. `bun run verify` passed with 1,236 core tests, 10 end-to-end tests, and 27 installed acceptance tests. Three external checks skipped and zero tests failed. The first aggregate attempt encountered a transient pseudo-terminal input-timing failure; the case passed in isolation and the complete gate then passed on rerun. No paid benchmark or credentialed live-provider validation was run; cache behavior is supported by deterministic candidate and wire tests, not provider billing or performance evidence.

Final context-efficiency verification on August 10, 2026 passed:

- `bun run verify`: passed;
- deterministic core suite: 937 passed, 2 externally gated skips, 0 failed;
- end-to-end suite: 3 passed, 0 failed;
- deterministic installed acceptance: 16 passed, 1 credential-gated skip, 0 failed; and
- independent final review: no remaining blockers.

The skipped checks are the live-provider smoke, official Turso Sync server conformance, and Turso Cloud smoke. They remain unverified.

### Repository-instruction loading evidence

Repository `AGENTS.md` loading was verified on August 10, 2026:

- focused instruction and sealed-review suites: 49 passed, 0 failed;
- typecheck and architecture checks: passed;
- deterministic core: 943 passed, 2 credential-gated external skips, 0 failed;
- end-to-end suite: 3 passed, 0 failed; and
- installed acceptance: 16 passed, 1 credential-gated skip, 0 failed.

The focused coverage proves bounded root loading and change detection; root-to-nearest nested precedence; digest deduplication including concurrent same-directory reads; changed, removed, restored, and pending omitted nested files; restart retention; ancestor, digest, redaction, active-context, and per-cell omission limits; symlink refusal; provider-message placement; trajectory-snapshot scrubbing; and exclusion from sealed refinement and governance reviewer contexts. The complete default `bun run verify` gate passed. One preceding full attempt had a transient failure in the cross-device shell-effect test; its isolated seven-test file and the complete rerun passed. Live-provider, official Turso Sync server, and Turso Cloud checks remain skipped and unverified.

### Previous recorded baseline

The preceding schema-version-3 baseline was produced on August 9, 2026 against runtime commit `1ec7114` plus documentation-only working-tree changes:

- `bun run verify`: passed;
- `bun run test:core` within that gate: 845 passes and 2 documented external skips;
- `bun run test:acceptance`: 14 passes and 1 credential-gated real-provider skip;
- deterministic installed acceptance matrix row: passed;
- real-provider, official Turso Sync server, and Turso Cloud rows: skipped and unverified.

An independent same-tree rerun then exposed an unresolved OpenTUI test instability. `bun run test:core` and one focused `bun test test/unit/opentui.test.ts` rerun both timed out waiting for the first stable workspace frame in `renders a stable workspace, preserves input during protocol updates, responds to resize, and detaches`; a later focused rerun passed all 12 OpenTUI tests. The passing full gate above is therefore recorded evidence, but not yet repeatable all-green evidence.

This is a dated, commit-scoped verification record rather than a claim about later revisions. Refresh it after code or test changes when current repository evidence is required, and do not describe this revision as merge-ready until the OpenTUI instability is resolved or disproved.

The linked acceptance suite does not include a known-unsupported-model row. That condition cannot currently be represented truthfully through a shipped product transport or the configured Gateway-compatible catalog: shipped transports prove the required primitives, while exact catalog model support remains `unknown`. Deterministic protocol and model-selection admission tests use a genuine unsupported provider to prove rejection without the prohibited preference, root, model-change event, message, run, effect, child, or provider call. Linked tests separately prove missing-provider behavior and absence of text fallback.

## Focused local commands

Use the narrowest relevant command while developing:

```sh
bun run typecheck
bun run check:architecture
bun run benchmark:context-efficiency
bun run test:unit
bun run test:integration
bun run test:e2e
bun run test:acceptance
```

Other current aggregate commands are:

```sh
# All tests discovered by Bun, with the package timeout:
bun test --timeout 30000

# The deterministic core groups used by the main gate:
bun run test:core

# Installed acceptance plus separately reported external rows:
bun run test:acceptance:matrix
```

Focused test files may be run with `bun test <path>`. A focused pass is iteration evidence, not a substitute for the main gate when making a repository-wide completion claim.

## Opt-in external verification

External rows require explicit prerequisites and are not part of the deterministic claim.

### Prime Verifiers benchmark suites

The isolated Python project under `benchmarks/prime/` evaluates Agencity as a
custom Prime Verifiers v1 harness. RuneBench, Terminal-Bench 2,
Terminal-Bench 2.1, SWE-bench Pro public, and OOLONG support exact IDs,
explicit IDs, named smoke subsets, seeded samples, stable shards, and all
compatible tasks through one selection contract.

Run the model-free gate:

```sh
cd benchmarks/prime
uv lock --check
uv run --locked python -m unittest discover -s tests -v
uv run --locked python -m unittest tests/test_exact_container_startup.py -v
uv build
uv run --locked python scripts/preflight_suite.py \
  configs/terminal-bench-2-full.toml
uv run --locked eval @ configs/terminal-bench-2-full.toml --dry-run
```

Preflight validates catalog selection and pins without model inference or
pulling every task image. Model-free checks prove only the exercised selection,
pinning, isolation, lifecycle, scorer, cleanup, packaging, and reporting paths.
They are not benchmark performance evidence.

The exact-container test installs the current runtime source in the pinned Bun
image and drives the real JSON product path through a local fake provider. It
deliberately begins without the explicit state directory and verifies startup,
one terminal result, and container cleanup without paid inference.

### Catalog coverage and scoring authority

RuneBench catalogs all 32 skill tasks in its pinned Harbor dataset. It uses one
immutable game image and the unmodified Harbor XP-rate verifier. The
`agencity-runebench-repl-v1` treatment replaces the official MCP wrapper with
one staged single-owner controller around the same image-owned TypeScript SDK
through Agencity's persistent Bun console. Controller release confirms
disconnection before a managed trainer starts; repeated actions back off on
false results and thrown errors; and the task states the active tracker path
exactly. RuneBench's benign `password: "test"` option remains in the staged
controller. It applies an 8 GiB runtime memory cap to the pinned package's 4 GiB
declaration, matching the current upstream generator's hardening for documented
agent OOM failures; both values are retained as treatment provenance. Preflight
reserves 2 GiB beyond effective container concurrency and fails when Docker
capacity is unavailable or insufficient; this does not verify CPU, provider
quota, scoring, or cleanup health. The separate fresh and within-run treatments set the
automatic-learning policy explicitly before each root run: fresh pauses it and
within-run enables it. No profile or learned artifact crosses scored tasks.
Gold, collaboration, and cross-episode curriculum treatments are not included.

Terminal-Bench 2 and 2.1 each catalog and pin all 89 official tasks. Every
entry records complete task-tree integrity, immutable linux/amd64 image
manifest/config identity, and workdir. Both catalogs currently mark 89/89 tasks
compatible. The same task class and unmodified Harbor scorer serve smoke,
sample, shard, and full-compatible selections. The portable harness does not
assume a task image package manager and keeps all Agencity state outside the
scored workspace. Harbor collection hooks run before task cleanup; Agencity
shutdown and generated-state removal complete before Harbor reward scoring.
Unconfirmed shutdown retains portable lifecycle evidence and becomes an
infrastructure error rather than deleting evidence or proceeding as clean.

The SWE-bench Pro public catalog covers all 731 public rows. One qutebrowser row
is compatible. Of the 730 incompatible rows, 729 have typed reason
`image_configuration_not_audited`; one audited Vuls row has
`official_noop_parser_evidence_empty` because its official no-op control
produced no parsed test evidence. Therefore its full-compatible config selects
one task and is not described as the complete public suite.

OOLONG's pinned Yahoo 128K slice contains 50 tasks over two context windows.
Admission checks the live predicate-pushed slice against a packaged manifest
covering exact task order, IDs, context identities, sizes, and answer types.
Its deterministic scorer is parity-tested against pinned Prime OOLONG-synth v1
source, including numeric partial credit. File and terminal answer digests plus
their agreement state remain visible. The bounded eight-task Sol treatment
selects four explicit IDs from each context window; all OOLONG suite configs
use portable shutdown/cleanup and serial execution. Context and gold answers
remain host-side task-object fields and are excluded from serialized task data
and trace provenance.
OOLONG remains file-context reasoning evidence rather than repository-coding
evidence.

### Split agent/scorer isolation and reporting

For every compatible SWE-bench Pro task, setup archives only the pinned base
tree, destroys original Git history, creates one fresh baseline commit, and
proves the withheld commit cannot resolve. The prompt and task trace exclude
reference patches, withheld tests, official scripts, patch content, parsed test
names, and evaluator output.

After Agencity shutdown and generated-state cleanup, a bounded private patch is
captured. Verifiers requests owned-runtime teardown before the custom
environment starts host scoring. A fresh network-disabled scorer then runs the
pinned unmodified official evaluator against the verified immutable image.
Missing, empty, or malformed official parser evidence is an infrastructure
error, never a valid zero. The current Verifiers API logs runtime-stop failures
but does not expose a teardown receipt to the custom environment. The private
patch is host-memory state between finalization and scoring, so a host crash in
that interval is not resumable.

Deterministic reporting keeps passes, valid zeros, partial rewards, harness
terminal failures, provider failures, scorer/infrastructure errors,
cancellations, unknowns, and incompatibilities separate. Reward aggregation
uses officially scored tasks only and states its denominator.

Recorded paid evidence remains one passing Terminal-Bench 2 `fix-git`
treatment, one passing Terminal-Bench 2.1 `fix-git` treatment, bounded OOLONG
probes, and one zero-score SWE-bench Pro qutebrowser treatment. The
current-revision Sol-high OOLONG canary completed the repaired infrastructure
route but returned `Society & Culture` instead of `Sports`, scoring `0` after
19 Agencity steps, 20 provider calls, 90,951 prompt-plus-completion tokens,
about four minutes, and $0.89. One paid RuneBench Luna-xhigh Woodcutting
15-minute treatment on commit `1b2cebf` produced an official 100 XP/min score
with successful scorer and cleanup evidence, but its agent terminated at the
then-current cumulative token bound. It exposed controller, action-backoff, and
tracker-path defects in that earlier revision. Another direct-REPL canary
completed 33 turns but never reached official scoring because service shutdown
missed the cleanup bound; its displayed zero is an infrastructure error. Both
predate the model-free fixes. No paid 30-minute canary, full RuneBench treatment,
full paid suite, or matched harness comparison has run.
The complete RuneBench operator runbook is
[`benchmarks/prime/RUNEBENCH.md`](../benchmarks/prime/RUNEBENCH.md). Shared
catalog, comparison, and reporting contracts are in
[`benchmarks/prime/README.md`](../benchmarks/prime/README.md).

The August 19, 2026 benchmark working tree passed 95 of 96 model-free tests;
the one skip was the unrelated opt-in SWE-bench Pro scorer. All six RuneBench
preflights and dry-runs, source/wheel build, and pinned-image controller and
tracker checks passed without model inference.

Final suite-layer model-free verification on August 11, 2026 recorded:

- benchmark unit/lifecycle/distribution suite: 70 passed, 1 opt-in scorer check
  skipped, 0 failed;
- compatible SWE-bench Pro official reference/no-op check: 1 passed, 0 skipped,
  0 failed;
- live OOLONG Yahoo 128K manifest comparison: passed with 50/50 exact tasks;
- catalog selection preflights: 21 passed, 0 failed;
- Verifiers config dry-runs: 22 passed, 0 failed;
- source and wheel builds, isolated wheel/sdist installation and loading,
  lockfile validation, root typecheck, architecture check, and diff check:
  passed.

The Vuls compatibility audit did not produce valid no-op parser evidence. That
was an infrastructure error rather than reward zero, and the row is retained as
incompatible. No paid benchmark run or matched second-harness run was performed
as part of suite-layer verification.

### Real OpenAI Responses-compatible provider

```sh
AGENCITY_ACCEPTANCE_REAL_PROVIDER=1 \
OPENAI_API_KEY=... \
AGENCITY_ACCEPTANCE_REAL_MODEL=... \
bun run test:acceptance:external
```

`AGENCITY_ACCEPTANCE_REAL_MODEL` uses the canonical `openai/...` catalog ID. Set `OPENAI_BASE_URL` to a path-free HTTP(S) origin when testing another endpoint that implements `/v1/responses`; Chat Completions compatibility alone is insufficient. This is a credential-gated installed-product smoke against the selected live model. It does not verify every supported provider or model.

The same row can be included in the release matrix:

```sh
AGENCITY_ACCEPTANCE_REAL_PROVIDER=1 \
OPENAI_API_KEY=... \
AGENCITY_ACCEPTANCE_REAL_MODEL=... \
bun run test:acceptance:matrix
```

### Official Turso Sync server

Provide an external version-matched `tursodb` binary:

```sh
TURSO_SYNC_SERVER_BIN=/absolute/path/to/tursodb \
bun run test:turso-official
```

The release matrix runs the same row when `TURSO_SYNC_SERVER_BIN` is set.

### Real Turso Cloud

Use only a disposable database:

```sh
AGENCITY_TURSO_SMOKE=1 \
TURSO_DATABASE_URL=... \
TURSO_AUTH_TOKEN=... \
bun run test:acceptance:matrix
```

The Cloud row verifies the credential-gated data-path smoke only. It does not establish distributed execution ownership, automatic failover, or Cloud administrative deletion.

## Reporting pass, fail, and skip

Report the exact command, exit result, test runner pass/fail/skip counts, and the prerequisites present for external checks.

`bun run test:acceptance:matrix` prints one status for each of:

- deterministic installed acceptance;
- real OpenAI Responses-compatible provider;
- official Turso Sync server; and
- real Turso Cloud.

The matrix rules are:

- `PASS` means that row ran and exited successfully.
- `FAIL` means the row ran unsuccessfully, or the row was explicitly enabled without all required prerequisites.
- `SKIP` means the row was not enabled or its external prerequisite was absent.

Any failed row makes the matrix exit nonzero. Skipped external rows do not. A skipped row is unverified and must never be summarized as passed. Likewise, a successful `bun run verify` with environment-gated tests skipped proves only the non-skipped default checks.

A concise verification report should preserve that distinction, for example:

```text
bun run verify: PASS
deterministic installed acceptance: PASS
real OpenAI Responses-compatible provider: SKIP (not enabled)
official Turso Sync server: SKIP (binary unavailable)
real Turso Cloud: SKIP (not enabled)
```

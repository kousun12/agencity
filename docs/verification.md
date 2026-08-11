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

`bun run test:core` runs the deterministic unit, integration, end-to-end, and placement suites used by the main gate. Independent test files run in four isolated Bun workers; the process-heavy end-to-end files run afterward in one worker. Together, their current coverage includes schema-5 event replay and reducer-15 rebuild, typed effect origins, exact provider-input admission, bounded observation ownership, bounded shell/file/artifact/cell output, root and nested repository-instruction loading, durable initial agent profiles and prompt pins, branch-scoped warm scratch, bounded fenced local scratch checkpoints and recovery, disposable console behavior, outbox recovery, formal autonomous actions, structured refinement, retained terminal refinement outcomes across reopen, recursive sessions and mailboxes, goals and gates, memory and refinement, local synchronization logic, execution leases and fencing, protocol cursor recovery, one-hour managed-service defaults and keep-alive behavior, model streaming semantics, terminal family and workspace-root navigation, structured Markdown and TypeScript cell rendering, responsive terminal layout, and placement contracts.

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
- compact cell observations, bounded durable-state use, warm scratch across cells, and truthful same-device scratch restore/reconstruction after managed worker and service loss;
- unexpected large shell output, bounded spill delivery, and focused exact artifact-range recovery before completion;
- exact root and child provider tool sets, single-call cardinality, narration-plus-call acceptance, and no text-JSON fallback;
- durable recursive calls, child agents, messages, and retained follow-up;
- sealed structured refinement submission with a message-free typed child result;
- failed completion-gate repair;
- detach, client loss, managed-service recovery, one-hour typed and human status, resume, named branching, tree, status, and history;
- distinct non-interactive run outcomes and interruption behavior;
- committed-action and effect crash recovery without duplicate execution;
- unknown effects, no automatic retry, and evidence-only reconciliation; and
- refinement review, installed skills, context compaction, streaming, and scheduled wakes; and
- governed root and child profiles, old/new invocation pins, blocking approval, rejection, bounded reproposal, exact rollback, detached managed-service restart, deduplication, and route-relative no-ID inspection.

This acceptance suite is intentionally non-interactive. The `test:core` groups separately cover deterministic full-screen renderer frames, stable reconciled Markdown and code identities, user-task/run interleaving, durable cell joining and bounded output, retained no-change/applied/rejected refinement summaries, line-preserving composer paste, `Shift-Enter` multiline input, follow-until-scrolled timeline behavior, idle and active inspectors, width-prioritized footer content, normal/compact/minimum height modes, draft-safe family focus, parent/child input, workspace-root search and selection, stale catalog races, and exact route switching. `bun run test:e2e` adds a linked-executable pseudo-terminal journey that expands a retained TypeScript cell; opens a root, child, and grandchild; climbs back through retained parents; creates a second root; opens the workspace Agents view; selects the other root; detaches; and resumes the remembered selection without exposing credentials. The same journey verifies that the original cell and child were not duplicated or cancelled.

The agent-run integration suite verifies zero, duplicate, malformed, truncated, oversized, and unknown formal calls execute nothing; a text-JSON response does not become an action; a typed rejection is delivered once to one correction step; a second consecutive rejection terminates the run; and recovery after committed response or action boundaries does not duplicate the model call, cell, message, or observation.

The integration suite also verifies declaration-only AI SDK tools for OpenAI, Anthropic, and Gateway; direct-transport parallel-call suppression; normalized reasoning mapping; structured and text streaming; bounded warnings and errors; model-catalog normalization, endpoint-keyed cache isolation, stale fallback, and malformed-record rejection; dispatch equality; custom-provider credential failure across complete structured output; schema-1 through schema-4 rejection without deletion; and structured result recovery across rebuild, reopen, and divergent synchronization.

It records a focused family-projection benchmark with 25 relatives and branch histories expanded to 5,000 canonical event records at the storage boundary. It proves that a cold read projects each route once and that a warm refresh reuses current snapshots without replaying the 130,000 retained events. Controller tests separately prove that periodic family refresh requests are coalesced, never overlap, do not accumulate a timer backlog, and stop when the browser is closed and no child is actively working. Workspace Agents catalog tests cover explicit one-shot refresh, stale-row retention, superseded-response rejection, and exact product selection without adding a polling loop.

The package is private. This verifies the documented source and `bun link` workflow; it is not evidence of a package-registry or standalone-binary release.

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

The benchmark uses the shipped `agentProviderContext`, bounded active-run projection, observation derivation, `buildProviderInputCandidate`, estimator, formal tool registry, local shell executor, and local artifact store. Its documented pre-change baseline shape accumulates completed TypeScript source under the active run and delivers the same successful shell result through both effect and cell observations. The optimized side is not a handcrafted request shape.

The August 10, 2026 deterministic run produced:

- step 1: complete candidate 3,527 bytes; provider messages 698 bytes; serialized request 2,563 bytes; estimated input 641 tokens; baseline messages 517 bytes;
- steps 2-5 each: complete candidate 29,205 bytes; provider messages 26,375 bytes; serialized request 28,240 bytes; estimated input 7,060 tokens;
- baseline provider messages for steps 2-5: 60,714; 69,818; 78,922; and 88,026 bytes;
- automatic observations for steps 2-5: cell-owned `CellCommitted` 25,548 bytes; production observation selection excludes request/attempt events, and the selected duplicate successful `EffectOutcomeRecorded` contributes zero automatic bytes;
- shell fixture: 30,013 artifact bytes and 24,737 serialized preview bytes, with `spilled` completeness and 64 KiB artifact-range support;
- capacity provenance: fixture provider metadata, 128,000-token context, 2,048-token output reserve, estimator `provider-input-utf8-bytes-per-4-tokens-v1`; compaction was not required; and
- cumulative provider messages: 297,997 baseline bytes versus 106,198 shipped bytes, a 64.36% reduction. The required minimum is 30%.

Provider-reported input tokens were skipped because no live credential-gated provider run was enabled. Live-provider, official Turso Sync server, and Turso Cloud results remain unverified; the deterministic estimate is not presented as provider-reported usage.

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

### Console scratch and service-lifetime evidence

The Phase D completion slice was verified on August 11, 2026:

- managed-service integration: 20 passed, 0 failed;
- product CLI integration: 16 passed, 0 failed;
- primary isolated linked-executable acceptance: 3 passed, 0 failed;
- typecheck and architecture checks: passed; and
- `git diff --check`: passed.

The coverage includes the exact one-hour default and deadline, detached child startup, short override shutdown, active keep-alive reasons, warm scratch as a non-keep-alive cache, console-worker shutdown, former/current normalized configuration mismatch without takeover, human `1 hour` status with exact JSON milliseconds, compact observations, one bounded durable-state key, warm exact-branch reuse, detach/no-ID resume, same-device eligible JSON restore after service loss, and deliberate reconstruction of a warm-only function.

The subsequent deterministic aggregate completed successfully: `bun run verify` passed 981 core tests, 3 end-to-end tests, and 17 acceptance tests, with 2 core external tests and 1 acceptance external test skipped. `bun run test:acceptance:matrix` passed its deterministic matrix; its real-provider, official Turso Sync, and Turso Cloud rows skipped and remain unverified. Independent final-review fixes for clearability, credential-shaped checkpoint rejection, and retained skipped-binding metadata passed 40 focused scratch, console, and storage tests plus typecheck and architecture checking.

### Previous recorded baseline

The preceding schema-version-3 baseline was produced on August 9, 2026 against runtime commit `1ec7114` plus documentation-only working-tree changes:

- `bun run verify`: passed;
- `bun run test:core` within that gate: 845 passes and 2 documented external skips;
- `bun run test:acceptance`: 14 passes and 1 credential-gated real-provider skip;
- deterministic installed acceptance matrix row: passed;
- real-provider, official Turso Sync server, and Turso Cloud rows: skipped and unverified.

An independent same-tree rerun then exposed an unresolved OpenTUI test instability. `bun run test:core` and one focused `bun test test/unit/opentui.test.ts` rerun both timed out waiting for the first stable workspace frame in `renders a stable workspace, preserves input during protocol updates, responds to resize, and detaches`; a later focused rerun passed all 12 OpenTUI tests. The passing full gate above is therefore recorded evidence, but not yet repeatable all-green evidence.

This is a dated, commit-scoped verification record rather than a claim about later revisions. Refresh it after code or test changes when current repository evidence is required, and do not describe this revision as merge-ready until the OpenTUI instability is resolved or disproved.

The linked acceptance suite does not include a known-unsupported-model row. That condition cannot currently be represented truthfully through a shipped product transport or the public Gateway catalog: shipped transports prove the required primitives, while exact catalog model support remains `unknown`. Protocol tests use a genuine text-only provider to prove pre-admission rejection with no message, run, effect, child, or provider call. Linked tests separately prove missing-provider behavior and absence of text fallback.

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
custom Prime Verifiers v1 harness. Terminal-Bench 2, Terminal-Bench 2.1,
SWE-bench Pro public, and OOLONG support exact IDs, explicit IDs, named smoke
subsets, seeded samples, stable shards, and all compatible tasks through one
selection contract.

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

Terminal-Bench 2 and 2.1 each catalog and pin all 89 official tasks. Every
entry records complete task-tree integrity, immutable linux/amd64 image
manifest/config identity, and workdir. Both catalogs currently mark 89/89 tasks
compatible. The same task class and unmodified Harbor scorer serve smoke,
sample, shard, and full-compatible selections. The portable harness does not
assume a task image package manager and keeps all Agencity state outside the
scored workspace. Harbor collection hooks run before task cleanup; Agencity
shutdown and generated-state removal complete before Harbor reward scoring.

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
about four minutes, and $0.89. No full paid suite or matched harness comparison
has run. Exact catalogs, commands, and limitations are in
[`benchmarks/prime/README.md`](../benchmarks/prime/README.md).

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

### Real OpenAI-compatible provider

```sh
AGENCITY_ACCEPTANCE_REAL_PROVIDER=1 \
OPENAI_API_KEY=... \
AGENCITY_ACCEPTANCE_REAL_MODEL=... \
bun run test:acceptance:external
```

`AGENCITY_ACCEPTANCE_REAL_MODEL` uses the canonical `openai/...` catalog ID. Set `OPENAI_BASE_URL` to a path-free HTTP(S) origin when testing another compatible endpoint. This is a credential-gated installed-product smoke against the selected live model. It does not verify every supported provider or model.

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
- real OpenAI-compatible provider;
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
real OpenAI-compatible provider: SKIP (not enabled)
official Turso Sync server: SKIP (binary unavailable)
real Turso Cloud: SKIP (not enabled)
```

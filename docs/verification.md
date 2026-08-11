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

`bun run test:core` runs the deterministic unit, integration, end-to-end, and placement suites used by the main gate. Independent test files run in four isolated Bun workers; the process-heavy end-to-end files run afterward in one worker. Together, their current coverage includes schema-5 event replay and reducer-15 rebuild, typed effect origins, exact provider-input admission, bounded observation ownership, bounded shell/file/artifact/cell output, root and nested repository-instruction loading, durable initial agent profiles and prompt pins, disposable console behavior, outbox recovery, formal autonomous actions, structured refinement, recursive sessions and mailboxes, goals and gates, memory and refinement, local synchronization logic, execution leases and fencing, protocol cursor recovery, managed service behavior, model streaming semantics, terminal family and workspace-root navigation, structured Markdown and TypeScript cell rendering, responsive terminal layout, and placement contracts.

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
- unexpected large shell output, bounded spill delivery, and focused exact artifact-range recovery before completion;
- exact root and child provider tool sets, single-call cardinality, narration-plus-call acceptance, and no text-JSON fallback;
- durable recursive calls, child agents, messages, and retained follow-up;
- sealed structured refinement submission with a message-free typed child result;
- failed completion-gate repair;
- detach, client loss, managed-service recovery, resume, named branching, tree, status, and history;
- distinct non-interactive run outcomes and interruption behavior;
- committed-action and effect crash recovery without duplicate execution;
- unknown effects, no automatic retry, and evidence-only reconciliation; and
- refinement review, installed skills, context compaction, streaming, and scheduled wakes; and
- governed root and child profiles, old/new invocation pins, blocking approval, rejection, bounded reproposal, exact rollback, detached managed-service restart, deduplication, and route-relative no-ID inspection.

This acceptance suite is intentionally non-interactive. The `test:core` groups separately cover deterministic full-screen renderer frames, stable reconciled Markdown and code identities, user-task/run interleaving, durable cell joining and bounded output, line-preserving composer paste, `Shift-Enter` multiline input, follow-until-scrolled timeline behavior, idle and active inspectors, width-prioritized footer content, normal/compact/minimum height modes, draft-safe family focus, parent/child input, workspace-root search and selection, stale catalog races, and exact route switching. `bun run test:e2e` adds a linked-executable pseudo-terminal journey that expands a retained TypeScript cell; opens a root, child, and grandchild; climbs back through retained parents; creates a second root; opens the workspace Agents view; selects the other root; detaches; and resumes the remembered selection without exposing credentials. The same journey verifies that the original cell and child were not duplicated or cancelled.

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

### Prime Verifiers and OOLONG

The isolated Python project under `benchmarks/prime/` runs Agencity as a custom
Prime Verifiers v1 harness. Model-free checks and config validation are:

```sh
cd benchmarks/prime
uv sync --locked
uv run --locked python -m unittest discover -s tests -v
uv run --locked eval @ configs/oolong-yahoo-128k-full.toml --dry-run
```

The pinned OOLONG preflight downloads no model inference:

```sh
uv run --locked python scripts/preflight_oolong.py \
  --output manifests/oolong-yahoo-128k.json
```

Paid OOLONG commands, exact treatment, evidence requirements, and current scale
blockers are documented in [`benchmarks/prime/README.md`](../benchmarks/prime/README.md).
The development probes are integration evidence only. No full OOLONG score,
hosted Prime execution, or exact Prime Agent reproduction is verified.

New benchmark integrations follow the
[`benchmarks/prime/AUTHORING.md`](../benchmarks/prime/AUTHORING.md) contract.
Workspace-scored coding tasks are the primary class: Agencity works in a
disposable repository or task workspace, then an independent verifier scores
the resulting files after agent execution. Answer-only tasksets remain useful
for low-cost integration checks but are not the main product benchmark.

### Terminal-Bench Harbor probes

The local Prime project contains one bounded Terminal-Bench 2 Harbor treatment:
the explicitly selected `fix-git` task. Its manifest pins the Harbor dataset
digest, complete task-tree digest, Linux `amd64` image digest, task workspace,
Agencity source revision, Bun archive, Verifiers and Harbor versions, and
Python lockfile. The shared harness stages the pinned
source and Bun into the task image without assuming `apt-get`, Git, Node, or Bun
in that image. It runs Agencity in `/app/personal-site` and keeps its state,
profile, and artifacts under rollout-local `/tmp/agencity-eval`. It rejects
pre-existing task-owned `.agencity` metadata, hides the generated workspace
marker from Git while Agencity runs, confirms service shutdown, and removes
generated metadata and state during task finalization, outside the agent
timeout and before scoring.

Run model-free checks and configuration validation:

```sh
cd benchmarks/prime
uv lock --check
uv run --locked python -m unittest discover -s tests -v
uv build
uv run --locked eval @ configs/terminal-bench-2-fix-git-sample.toml --dry-run
```

The configuration uses one task, one rollout, concurrency one, zero whole-run
retries, and `push = false`. Harbor stages the hidden verifier only after
Agencity's process exits; its reward is the score. Agencity terminal status,
steps, exit code, and cleanup outcome remain trace metadata, but its final
message does not determine the reward.

Turn and token limits are evaluated between model calls and do not constitute a
hard billed-dollar cap. Paid runs require a provider-window worst-case estimate,
an operator-approved budget, and an attended one-task configuration. Resolved
TOML may contain private client headers and remains ignored local evidence
unless scrubbed.

This is integration wiring and bounded-probe evidence only. It does not
establish Terminal-Bench performance, all-task compatibility, public
reproducibility, or unattended timeout/cancellation recovery. Additional
Terminal-Bench tasks or a suite require an explicit cost and scope approval.

On August 10, 2026, lock validation, 39 model-free benchmark tests, source and
wheel builds, installed-wheel pin validation, dry-run resolution, exact Harbor
task loading, source-distribution leak checks, complete task-tree integrity
checks, and portable lifecycle checks in the pinned task image passed.
An initial attempt failed before model admission because its state directory
was absent. A later eight-call diagnostic run reached Harbor but scored `0`
after generated `.agencity` metadata dirtied the worktree and Agencity reached
the turn cap. These are retained as infrastructure and treatment-debugging
evidence.

With generated workspace metadata isolated, the bounded Luna-high run completed
in eight calls and eight Agencity steps. Agencity reported `succeeded`; service
shutdown and cleanup were confirmed; Harbor's upstream verifier scored `1.0`;
and the trace recorded no errors. Usage was 19,408 prompt tokens, 3,088
completion tokens, 11,320 cached input tokens, and 1,622 reasoning tokens. The
undiscounted listed-price ceiling at the preflight rates was $0.0379. This is
one passing integration treatment, not a Terminal-Bench performance result.

The independent Terminal-Bench 2.1 treatment uses the same portable lifecycle
in a separate taskset and manifest. It pins
`terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`,
the refreshed `fix-git` task package and complete downloaded task-tree digest,
and image
`alexgshaw/fix-git@sha256:389b9c8247610c2c5be080b1ac00429007c2c69bf57f7f26c79f0f75ba2d5c74`.
On August 10, 2026, its model-free suite, package checks, pinned-image
portable lifecycle, exact task loading, and dry-run passed. One attended
Luna-high rollout made seven calls, reported `succeeded`, retained stopped
service and cleanup evidence, and received upstream Harbor reward `1.0`.
Its conservative 12-window preflight was $3.15 under the recorded $1/M-input
and $6/M-output list rates; no provider-reported cost was available. This is
one integration treatment, not a Terminal-Bench 2.1 score.

### SWE-bench Pro public split treatment

The Prime project contains a separate taskset and environment for one public
qutebrowser instance. The agent starts from an immutable task image, but setup
archives only the pinned base revision, deletes the original workspace and Git
object store, initializes one fresh baseline commit, and proves that the
withheld test commit is not resolvable. Prompt and trace task data exclude the
reference patch, withheld test patch, official scripts, and evaluator output.

After Agencity stops and generated metadata/state are removed, only a bounded
private patch crosses to host-side scoring. The agent runtime is destroyed. The
adapter fetches and verifies the pinned official evaluator, makes the pinned
image available under a loopback-unreachable local alias required by the
upstream mutable-tag interface, and runs the unmodified official local-Docker
evaluator in a fresh network-disabled scorer container. Trace evidence retains
only digests, byte counts, the official boolean result, and cleanup status.

On August 10, 2026, 62 model-free tests, lock/build/distribution checks,
installed package checks, dry-run resolution, exact task loading, the real
pinned-image sanitizer and portable bootstrap, and scorer cleanup checks passed.
The official scorer returned `1.0` for the reference patch and `0.0` for a
no-op patch. One attended Luna-high treatment made nine calls. Agencity reached
the total-token bound after ten steps, reported `failed`, and left no change;
the official evaluator completed normally and returned `0.0` for the declared
synthetic no-op. Service, metadata/state, scorer-container, image-alias, and
temporary-directory cleanup all completed. The provider trace exposed no
per-run cost; the observed wallet display changed by about `$0.01`.
The paid probe used the initial port-1 alias route. A later audit hardened the
current model-free path to port 0, a required failed pull of the populated
alias, and before/after alias identity checks; that no-op scorer rerun passed.
No second paid probe was run.

This is one zero-score integration treatment, not a SWE-bench Pro score,
performance result, or suite capability claim. SWE-bench Verified is not a
primary capability benchmark.

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

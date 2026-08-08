# Verification guide

This page describes the current repository checks and the claims each check supports. Run commands from the repository root with Bun 1.2 or newer.

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

`bun run test:core` runs the deterministic unit, integration, end-to-end, and placement suites used by the main gate. Together, their current coverage includes schema-3 event replay and rebuild, disposable console behavior, outbox recovery, formal autonomous actions, structured refinement, recursive sessions and mailboxes, goals and gates, memory and refinement, local synchronization logic, execution leases and fencing, protocol cursor recovery, managed service behavior, model streaming semantics, terminal family navigation, structured Markdown and TypeScript cell rendering, responsive terminal layout, and placement contracts.

Those tests use local fixtures, temporary databases, deterministic providers, and in-process or loopback test services where appropriate. A pass supports the behaviors exercised by those tests. It does not establish hostile-code isolation, exactly-once external effects, automatic cross-device failover, or correctness at every possible machine-instruction crash boundary.

## Installed-product acceptance

Run the deterministic black-box product suite directly with:

```sh
bun run test:acceptance
```

Each case creates an isolated Bun install root, temporary home directory, and fresh external repository. It runs `bun link` and invokes only the resulting `agencity` executable from outside the source checkout. A source guard rejects acceptance tests that import runtime internals, open LibSQL directly, use private runtime clients, or supply opaque session, branch, or history coordinates.

The suite uses a local OpenAI API fixture reached through the Vercel AI SDK transport and implements the formal `bun_console`/`finish` response contract and streaming transport. It covers:

- truthful missing-provider behavior and explicit provider/model selection;
- canonical catalog model IDs and durable reasoning-effort selection;
- autonomous TypeScript cells and typed file or shell effects;
- exact root and child provider tool sets, single-call cardinality, narration-plus-call acceptance, and no text-JSON fallback;
- durable recursive calls, child agents, messages, and retained follow-up;
- sealed structured refinement submission with a message-free typed child result;
- failed completion-gate repair;
- detach, client loss, managed-service recovery, resume, named branching, tree, status, and history;
- distinct non-interactive run outcomes and interruption behavior;
- committed-action and effect crash recovery without duplicate execution;
- unknown effects, no automatic retry, and evidence-only reconciliation; and
- refinement review, installed skills, context compaction, streaming, and scheduled wakes.

This acceptance suite is intentionally non-interactive. The `test:core` groups separately cover deterministic full-screen renderer frames, stable reconciled Markdown and code identities, user-task/run interleaving, durable cell joining and bounded output, line-preserving composer paste, `Shift-Enter` multiline input, follow-until-scrolled timeline behavior, idle and active inspectors, width-prioritized footer content, normal/compact/minimum height modes, draft-safe family focus, parent/child input, refresh races, and exact route switching. `bun run test:e2e` adds a linked-executable pseudo-terminal journey that expands a retained TypeScript cell, submits another composer command, creates and opens a named retained child through Down/Right, returns with Left, verifies the cell and child were not duplicated or cancelled, and resumes the remembered root without exposing credentials.

The agent-run integration suite verifies zero, duplicate, malformed, truncated, oversized, and unknown formal calls execute nothing; a text-JSON response does not become an action; a typed rejection is delivered once to one correction step; a second consecutive rejection terminates the run; and recovery after committed response or action boundaries does not duplicate the model call, cell, message, or observation.

The integration suite also verifies declaration-only AI SDK tools for OpenAI, Anthropic, and Gateway; direct-transport parallel-call suppression; normalized reasoning mapping; structured and text streaming; bounded warnings and errors; model-catalog normalization, endpoint-keyed cache isolation, stale fallback, and malformed-record rejection; dispatch equality; custom-provider credential failure across complete structured output; schema-1/schema-2 rejection without deletion; and structured result recovery across rebuild, reopen, and divergent synchronization.

It records a focused family-projection benchmark with 25 relatives and branch histories expanded to 5,000 canonical event records at the storage boundary. It proves that a cold read projects each route once and that a warm refresh reuses current snapshots without replaying the 130,000 retained events. Controller tests separately prove that periodic refresh requests are coalesced, never overlap, do not accumulate a timer backlog, and stop when the browser is closed and no child is actively working.

The package is private. This verifies the documented source and `bun link` workflow; it is not evidence of a package-registry or standalone-binary release.

### Recorded baseline

The last recorded repository evidence for the runtime baseline at commit `2d2536f` on August 8, 2026 is:

- `bun run test:core`: 828 passes and 2 documented external skips;
- `bun run test:e2e`: 3 passes;
- `bun run test:acceptance`: 14 passes and 1 credential-gated real-provider skip;
- deterministic release matrix: passed;
- real-provider, official Turso Sync server, and Turso Cloud rows: skipped and unverified.

The linked acceptance suite does not include a known-unsupported-model row. That condition cannot currently be represented truthfully through a shipped product transport or the public Gateway catalog: shipped transports prove the required primitives, while exact catalog model support remains `unknown`. Protocol tests use a genuine text-only provider to prove pre-admission rejection with no message, run, effect, child, or provider call. Linked tests separately prove missing-provider behavior and absence of text fallback.

## Focused local commands

Use the narrowest relevant command while developing:

```sh
bun run typecheck
bun run check:architecture
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

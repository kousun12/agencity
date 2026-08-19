# Prime Verifiers suite benchmarking

**Status:** Suite layer implemented; model-free verification complete
**Date:** August 10, 2026
**Updated:** August 11, 2026
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)

## Summary

Agencity is evaluated as a coding harness through Prime Verifiers v1.
Benchmarks own datasets, authorized task material, workspace construction, and
authoritative scoring. Verifiers owns rollout execution, interception of every
model call, trace capture, and provider usage. Agencity owns durable
orchestration and the formal `bun_console`/`finish` model contract. The selected
model is an evaluation parameter.

The benchmark layer supports deterministic smoke, sample, shard, and
full-compatible runs through the same task and scorer implementation. It
preserves immutable provenance and mixed outcomes without conflating task
failure with provider or scoring infrastructure failure.

Suite-capable means that selected compatible tasks can be loaded and executed
at suite scale. It does not mean that a paid model run has completed across a
suite.

## Goals

- Evaluate Agencity's shipped autonomous path across established coding and
  file-context benchmarks.
- Keep task and scoring semantics reusable across coding harnesses.
- Support exact IDs, explicit ID lists, named smoke subsets, deterministic
  samples, stable shards, and every compatible task.
- Pin source data, selected rows, task trees, task images, evaluator assets,
  runtime inputs, Agencity source, and the Python lock.
- Prevent hidden tests, reference patches, evaluator code, Docker authority,
  scorer output, and provider credentials from reaching the agent.
- Keep valid zero rewards, agent terminal failures, provider failures,
  scoring/infrastructure errors, incompatibilities, cancellations, and unknown
  outcomes distinct.
- Preserve cheap model-free validation and one-task smoke routes.
- Enable future matched comparisons that vary only the harness.

## Non-goals

- Claim benchmark performance from model-free checks or one-task treatments.
- Run a paid full suite as part of implementation.
- Rerun the existing SWE-bench Pro paid probe to seek a better result.
- Replace official scorers with convenient approximations.
- Mark unresolved or unaudited tasks compatible.
- Implement a Claude Code or Cursor harness without a reviewed
  Verifiers-compatible integration.
- Publish raw traces, private headers, hidden materials, wallet data, or local
  caches.

## Terms

- **Taskset:** Pinned benchmark data, deterministic selection, authorized
  workspace construction, task resources, and authoritative scoring.
- **Harness:** The agent installation and execution strategy under evaluation.
- **Runtime:** The local process, container, or sandbox in which a task and
  harness execute.
- **Treatment:** Explicit composition of taskset, harness, model, runtime,
  sampling, limits, and cleanup policy.
- **Catalog:** Generated bounded inventory of every pinned source task with
  immutable pins and compatibility status.
- **Compatible task:** A catalog entry that satisfies all implemented source,
  image, architecture, workdir, isolation, evaluator, and runtime admission
  requirements.
- **Full compatible set:** Every entry currently marked compatible. This is not
  the complete benchmark when the catalog contains incompatible entries.

## Component model

### Shared harness

`agencity_verifiers.AgencityHarness` owns:

- portable or apt/Git installation of one exact Agencity source revision;
- a fresh root and isolated profile, state, database, artifacts, and service
  paths per rollout;
- routing of all direct, recursive, and child model calls through Verifiers
  interception;
- provider credential isolation;
- typed `agencity.run-result` parsing and terminal-state preservation;
- service shutdown and Agencity-specific cleanup;
- bounded trace metadata.

The harness does not contain benchmark scoring, hidden answers, repository
fixes, or task-specific solution strategies.

### Tasksets

Each taskset owns:

- exact dataset identity and revision;
- deterministic selection and ordering;
- public task prompt and authorized workspace setup;
- complete task-specific immutable provenance;
- benchmark time/resource overrides;
- hidden-material handling;
- official scoring and benchmark metrics.

Task code invokes capability-named treatment hooks for workspace preparation and
cleanup. This keeps Agencity-specific metadata behavior out of benchmark
semantics and permits another compatible harness to use the same task/scorer.

### Verifiers

Verifiers owns task iteration, rollout count, model interception, provider
usage, retry/concurrency policy, lifecycle invocation, and trace serialization.
It is the evaluation runner and model proxy, not the coding harness.

### Custom environment

SWE-bench Pro uses a custom Verifiers `Env`. Its ordering requirement is
stronger than ordinary task finalization:

1. create and sanitize the agent runtime;
2. run the harness;
3. stop Agencity and remove generated state;
4. capture a bounded private patch;
5. request owned-runtime teardown through Verifiers;
6. create a fresh host-side scorer runtime;
7. invoke the official evaluator;
8. retain only bounded scoring evidence.

Scoring cannot begin while the agent runtime remains available.

## Deterministic selection

`agencity_verifiers.selection.SelectionSpec` defines:

- `exact`: exactly one requested ID;
- `ids`: an explicit list with duplicate and unknown-ID rejection;
- `smoke`: a named catalog subset;
- `sample`: deterministic sampling by retained seed and count;
- `shard`: stable SHA-256 assignment by index/count;
- `all`: all compatible catalog entries.

Catalog order is canonical. Selection outputs retain:

- requested mode and parameters;
- exact selected IDs;
- selected-ID SHA-256;
- compatible and incompatible counts;
- catalog SHA-256 and canonical task-entry SHA-256;
- selected immutable pins.

Unknown IDs, explicitly selected incompatible IDs, empty selections, invalid
shards, catalog digest mismatch, and task/source pin mismatch fail before model
admission.

## Catalogs

### Terminal-Bench 2

- dataset:
  `terminal-bench/terminal-bench-2@sha256:c6fc2e2382c1dbae99b2d5ecd2f4f4a60c3c01e0d84642d69b4afd92e99d078b`;
- source commit: `afbb742d222491967eea7f14e532abd481726a8c`;
- 89 total, 89 compatible;
- catalog SHA-256:
  `42170432fabf7dd049c09917f491c754bfb318ddd306a5d2c9e18609030c5290`;
- task-entry SHA-256:
  `8962dbae91eeb702f4f1fbca6505053bc9da19305dfe773c0b407efa04e22972`.

Every entry pins complete task-tree and `task.toml` digests, immutable
linux/amd64 image manifest/config, declared workdir, and upstream identity.

### Terminal-Bench 2.1

- dataset:
  `terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`;
- source commit: `ffccbe05ee73a9d59518217f294ad711bda39304`;
- 89 total, 89 compatible;
- catalog SHA-256:
  `abdf5a37bac0f947721489ff3dcdd6668097a480a5f338590b2d6ca6c520e968`;
- task-entry SHA-256:
  `403f87827daa0c418edbe13082b55919e8f657f943ad1b55f539c84bcc1fde94`.

Terminal-Bench 2.1 remains an independent pinned treatment.

### SWE-bench Pro public

- dataset revision: `7ab5114912baf22bb098818e604c02fe7ad2c11f`;
- 731 total cataloged rows;
- 1 compatible row;
- 730 incompatible rows: 729 with `image_configuration_not_audited` and one
  with `official_noop_parser_evidence_empty`;
- catalog SHA-256:
  `370a192eb7f64292399e1489be0dc5c00633ebe715bedaefc1836edc58d39ce8`;
- task-entry SHA-256:
  `1ac0a1db2f3705ae1c2cbbeb30d31dcdb54443c930365137ea86d8fef25b5fc6`.

The compatible row is qutebrowser. Vuls has immutable image pins, but its
official no-op control produced no parsed test evidence, so a zero could not be
distinguished from evaluator failure. Every public row remains visible. Rows
are not silently omitted, and the one-task compatible set is not called the
complete public suite.

### OOLONG-synth

- dataset: `oolongbench/oolong-synth`;
- revision: `f0d59eaf0febf130664cfceb710436c8e3216b2b`;
- comparison slice: test/Yahoo/131,072 tokens, 50 tasks, two context windows;
- enforced selection manifest: `manifests/oolong-yahoo-128k.json`, SHA-256
  `d0a105f1ee619adf94cdaf8cc5e9606cb82a57bd7f970d476a3a2db3b9a5c275`;
- scorer source:
  `PrimeIntellect-ai/research-environments@ba7eabc710b0d49cab25f52a5457ad56ca04613c`,
  file SHA-256
  `3cf9882c294be58f3b92cda5773c56ae5ebbb53e97f25c1ec9c8c612515c6131`.

Admission compares the predicate-pushed slice with the manifest's exact task
order, row IDs, context IDs, context hashes, context sizes, and normalized
answer types before selection. Selection then retains exact resulting IDs. The
deterministic scorer is a parity-tested port of the pinned Prime source,
including numeric partial credit and parsed exact match. Suite configs use the
portable harness, explicit cleanup, and serial execution. Full context and gold
answers remain private task-object fields and are excluded from serialized task
data and trace provenance.

## Workspace and scorer invariants

### Harbor tasksets

- Verify the pinned dataset package and complete selected task tree.
- Resolve every task's own immutable image and workdir.
- Do not assume a package manager, Git, Node, Bun, or a common workspace.
- Stage Agencity source and a pinned Bun archive portably.
- Keep profile, state, service, and artifacts under rollout-local `/tmp`.
- Reject task-owned `.agencity` metadata before admission.
- Hide and later remove only harness-generated metadata.
- Run Harbor collection hooks against the intact task workspace before cleanup.
- Confirm service shutdown before Harbor scoring.
- Leave upstream Harbor reward computation unchanged.
- Require non-empty well-formed reward evidence.

### SWE-bench Pro

- Verify the exact public row and base revision.
- Archive only the pinned base tree.
- Delete the original workspace and Git object database.
- Create one fresh baseline commit.
- Prove the withheld commit cannot resolve.
- Permit agent network access only to Verifiers interception.
- Keep reference patch, hidden patch/tests, official evaluator, Docker socket,
  patch content, test names, and scorer output out of agent-visible data and
  traces.
- Bound private patch size and transport it outside task traces.
- Require Verifiers owned-runtime teardown ordering before scoring. Retain a
  teardown receipt when the framework exposes one.
- Verify official evaluator source and selected assets.
- Verify image manifest/config identity before creating a unique
  loopback-unreachable local alias.
- Prove pulling the populated alias fails and recheck identity after scoring.
- Run the official scorer in a new network-disabled container.
- Treat missing or malformed parser evidence as infrastructure failure.
- Remove scorer containers, aliases, evaluator files, and temporary state.

## Reporting contract

`agencity_verifiers.reporting` classifies each attempted task as:

- passed;
- valid zero;
- partial reward;
- agent terminal failure;
- provider failure;
- scorer or infrastructure error;
- skipped;
- cancelled;
- unknown.

The selection manifest separately retains skipped/incompatible entries and
reasons. Reports include reward sum, denominator, mean, per-task outcome,
provider-reported calls/tokens/timing/cost, config digest, and bounded model,
harness, runtime, benchmark, image, evaluator, source, and lock provenance.

The default reward denominator is officially scored tasks only.
Infrastructure errors and unscored agent terminal failures are not averaged as
zero. Any alternate published policy must state both numerator and denominator.

## Comparison design

A matched harness comparison holds constant:

- catalog and exact selected IDs/order;
- model snapshot and endpoint class;
- reasoning and sampling;
- rollout count and seed;
- turn, token, time, and retry limits;
- runtime image, architecture, CPU, memory, disk, and network;
- task workspace and authorized materials;
- official evaluator and failure policy.

Only harness ID/config/source pin varies. All attempts remain in the report.
Stochastic comparisons use repeated rollouts and uncertainty estimates; a
best-of-N result is not compared with a single rollout.

A model comparison is a separate experiment. It holds harness and all other
fields constant while varying only the model configuration.

## Configuration ladder

Every suite provides:

- `*-smoke.toml` for a named fixed subset;
- `*-sample.toml` for a deterministic bounded sample;
- a stable shard config;
- `*-full.toml` for every compatible task.

Historical exact `fix-git` and qutebrowser filenames remain fast aliases and use
the same code path.

Dry-run sequence:

```sh
cd benchmarks/prime
uv run --locked python scripts/preflight_suite.py \
  configs/terminal-bench-2-full.toml
uv run --locked eval @ configs/terminal-bench-2-full.toml --dry-run
```

Paid sequence:

1. validate lock, tests, package, preflight, and dry-run;
2. inspect resolved model, selection, budgets, runtime, and pins;
3. calculate a provider-window worst-case;
4. obtain explicit operator approval;
5. run one smoke;
6. inspect trace, score, usage, terminal state, and cleanup;
7. approve any increase separately.

## Evidence

Recorded model-based evidence:

- one revised Sol-high OOLONG Yahoo 128K task scored `1.0`;
- the corresponding Luna OOLONG task scored `0`;
- one current-revision Sol-high OOLONG canary completed the repaired
  infrastructure path but returned `Society & Culture` instead of `Sports`,
  scoring `0` after 19 Agencity steps, 20 provider calls, 90,951
  prompt-plus-completion tokens, about four minutes, and $0.89;
- one hardened Terminal-Bench 2 Luna-high `fix-git` task scored `1.0`;
- one independently pinned Terminal-Bench 2.1 Luna-high `fix-git` task scored
  `1.0`;
- one SWE-bench Pro qutebrowser Luna-high task made nine calls, reached
  Agencity's total-token limit without a patch, and officially scored `0.0`.

These are integration treatments only. No full OOLONG, Terminal-Bench,
SWE-bench Pro, hosted, or matched-harness model evaluation is verified.

Model-free evidence covers deterministic selection, shard completeness,
catalog integrity, package contents, task loading beyond `fix-git`,
harness isolation, Harbor reward evidence, SWE-bench Pro sanitizer and split
lifecycle, scorer pass/zero/malformed behavior, cleanup, and mixed-outcome
reporting. On August 11, 2026, the Python gate passed 70 tests, skipped the one
opt-in official SWE-bench Pro Docker scorer row, and had zero failures. The
enabled compatible official scorer check passed separately. The live OOLONG
Yahoo 128K slice matched all 50 manifest entries exactly. All 21 suite
preflights and all 22 Verifiers config dry-runs passed. The wheel and source
distribution built and loaded from isolated environments. The pinned-container
fake-provider startup test passed with an initially absent explicit state
directory. The stratified OOLONG preflight selected eight exact IDs, four per
context window, with selected-ID digest
`c08ea3a3f651da52ba5151d6376fe776ba054d998499cda56dbf3fbccdc50ae8`.

## Remaining limits

- SWE-bench Pro complete public-suite execution is blocked until 729 image
  manifest/config pairs are resolved and audited and the Vuls official
  no-op parser-evidence failure is resolved. The one-task full compatible set
  is executable.
- Full model-based runs remain operator-gated by inference cost.
- Agencity's public JSON result lacks a durable benchmark cancellation/
  reconciliation receipt and aggregate internal budget evidence. This limits
  large unattended execution but not deterministic loading or attended smoke
  runs.
- No second harness integration has run, so separation is implemented but
  matched comparison remains unverified.
- Hosted execution and local/hosted parity remain unverified.
- Verifiers logs owned-runtime stop failures but does not expose a teardown
  receipt to the SWE-bench Pro custom environment, so scorer admission can
  prove ordering but not successful disposal.
- The SWE-bench Pro private patch is host-memory state between task finalization
  and environment scoring; a host crash in that interval is not resumable.
- OOLONG's dataset cache can require substantial local disk even with predicate
  pushdown.

## Completion criteria

The suite layer is complete when:

1. all four benchmark families expose the common selection modes;
2. smoke and full modes share task and scorer paths;
3. catalogs cover every pinned source row with compatibility status;
4. selected tasks retain exact immutable provenance;
5. hidden material remains unavailable to agents;
6. official scorers remain authoritative;
7. mixed outcomes remain distinct with an explicit denominator;
8. every committed smoke, sample, shard, and full config preflights and
   dry-runs;
9. unit, lifecycle, distribution, isolated-install, sanitizer, scorer, cleanup,
   reporting, typecheck, and architecture checks pass;
10. documentation distinguishes suite capability, model-free verification,
    paid evidence, compatibility limits, and performance claims.

## References

- [Benchmark operator guide](../benchmarks/prime/README.md)
- [Benchmark authoring contract](../benchmarks/prime/AUTHORING.md)
- [Prime Verifiers v1 tasksets](https://docs.primeintellect.ai/verifiers/v1/tasksets)
- [Prime Verifiers v1 harnesses](https://docs.primeintellect.ai/verifiers/v1/harnesses)
- [Prime Verifiers v1 evaluation](https://docs.primeintellect.ai/verifiers/v1/evaluation)

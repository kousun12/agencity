# Prime Verifiers benchmark suites

This isolated Python project evaluates Agencity as a Prime Verifiers v1 coding
harness. Benchmarks own tasks and authoritative scoring, Verifiers owns
evaluation execution and model interception, Agencity owns agent orchestration
and its `bun_console`/`finish` contract, and the configured model is a
replaceable evaluation parameter.

The implementation is suite-capable. This means the same task and scorer path
supports one exact task, a named smoke subset, an explicit ID list, a seeded
sample, a stable shard, or every compatible task. It does not mean that a paid
full-suite model run has been completed.

See [`AUTHORING.md`](./AUTHORING.md) for the reusable benchmark contract.

## Execution model

- `agencity_verifiers.harness.AgencityHarness` installs one pinned Agencity
  revision, routes all model calls through Verifiers, keeps state outside scored
  workspaces, preserves typed terminal outcomes, retains bounded scrubbed
  stdout/stderr evidence for malformed startup results, and removes portable
  state only after owned-service shutdown is confirmed.
- Benchmark tasksets load pinned datasets, select tasks deterministically,
  construct authorized workspaces, retain public provenance, and invoke the
  official scorer.
- `agencity_verifiers.selection` is the shared catalog and selection layer.
- `agencity_verifiers.harbor_suite` is reusable Harbor task/scorer integration.
- SWE-bench Pro uses a custom `Env` so Verifiers completes the owned-runtime
  teardown path before private host-side scoring starts. Verifiers currently
  logs runtime-stop failures but does not expose a teardown receipt to the
  custom environment.
- `agencity_verifiers.reporting` creates deterministic mixed-outcome summaries.
- `agencity_runebench` starts the pinned game after harness provisioning and
  maps RuneBench's TypeScript SDK directly into Agencity's persistent Bun
  console. The complete prerequisites, setup, execution, output, reporting, and
  troubleshooting runbook is [`RUNEBENCH.md`](./RUNEBENCH.md).

Task traces retain the complete selected ID list and digest, catalog and task
digests, task/image/workdir pins, benchmark-specific evaluator pins, the model,
sampling, harness, runtime, limits, usage, timing, reward, terminal status, and
cleanup evidence. Generated resolved configs and raw traces remain private
because they can contain model text, licensed data, or private client headers.

## Selection interface

Every suite taskset accepts an `[env.taskset.selection]` table:

```toml
[env.taskset.selection]
mode = "smoke" # exact | ids | smoke | sample | shard | all
subset = "default"
seed = 0
```

Examples:

```toml
# One exact task
[env.taskset.selection]
mode = "exact"
ids = ["fix-git"]

# Explicit subset
[env.taskset.selection]
mode = "ids"
ids = ["fix-git", "build-cython-ext"]

# Deterministic sample
[env.taskset.selection]
mode = "sample"
count = 8
seed = 20260810

# Stable parallel shard
[env.taskset.selection]
mode = "shard"
shard_index = 0
shard_count = 4

# Every catalog-compatible task
[env.taskset.selection]
mode = "all"
```

Catalog order is canonical. Samples use a retained seed. Shards assign each ID
by stable SHA-256 hashing, so shards are disjoint and cover the compatible
catalog. Unknown IDs, incompatible IDs, empty selections, and invalid shard
parameters fail before model admission.

Resolve a config and emit its immutable selection without downloading all task
images or calling a model:

```sh
uv run --locked python scripts/preflight_suite.py \
  configs/terminal-bench-2-full.toml
```

Run a Verifiers configuration dry-run:

```sh
uv run --locked eval @ configs/terminal-bench-2-full.toml --dry-run
```

## Configurations

Suite configs are provided for:

- RuneBench: `runebench-attack-30m-adaptive.toml` for the exact paid canary,
  `runebench-woodcutting-15m-{fresh,adaptive}.toml`,
  `runebench-15m-sample-adaptive.toml`,
  `runebench-leaderboard-full-adaptive.toml` for the current public
  leaderboard's 16 30-minute skills, and `runebench-full-adaptive.toml` for all
  32 pinned 15- and 30-minute skill tasks;
- Terminal-Bench 2: `terminal-bench-2-{smoke,sample,full}.toml` and
  `terminal-bench-2-shard-0-of-4.toml`;
- Terminal-Bench 2.1: `terminal-bench-2-1-{smoke,sample,full}.toml` and
  `terminal-bench-2-1-shard-0-of-4.toml`;
- SWE-bench Pro public: `swe-bench-pro-public-{smoke,sample,full}.toml` and
  `swe-bench-pro-public-shard-2-of-3.toml`;
- OOLONG: `oolong-synth-smoke.toml`,
  `oolong-yahoo-128k-{sample,full}.toml`,
  `oolong-yahoo-128k-sol-{sample,8-current}.toml`, and
  `oolong-yahoo-128k-shard-0-of-4.toml`. The eight-task Sol treatment selects
  four explicit IDs from each context window and runs them serially.

The earlier `fix-git` and qutebrowser filenames remain aliases for fast exact
treatments. They use the same task and scorer implementation as larger runs.

## Compatibility and immutable catalogs

### RuneBench

Catalog: [`manifests/runebench-catalog.json`](./manifests/runebench-catalog.json)

- Harbor dataset:
  `maxbittker/runebench@sha256:4bb3430af2ef3a320bd3dfeeab2447fbf9e0093452ad747997186a85a060de28`;
- upstream source commit: `826107d10f731eae4fd6b93bcd63d072d4346654`;
- catalog coverage: 32/32 compatible published skill tasks;
- immutable game image:
  `ghcr.io/maxbittker/rs-agent-benchmark@sha256:0961663ac1dc23d6cd00b88e79ff106cb1f0c7b7340659a914f96a8454124016`.

The `agencity-runebench-repl-v1` treatment replaces the task prompt's MCP
wrapper with one staged controller around the same image-owned TypeScript SDK
inside Agencity's persistent Bun console. A process-identity claim permits one
control owner, release confirms disconnection before trainer handoff, repeated
actions treat false results as failures with bounded backoff, and long-running
trainers use Agencity's managed-process API. The active tracker path is supplied
explicitly; RuneBench's benign local `password: "test"` option remains inside
the staged controller.
The official task package, save fixture,
time horizon, sampling cadence, game image, and Harbor verifier remain pinned.
The treatment raises the pinned package's 4 GiB memory cap to 8 GiB, matching
the current upstream generator's hardening for documented agent OOM failures;
both values remain explicit in the catalog. Fresh and within-run learning modes
are separate configs: fresh pauses automatic learning before the run, while
within-run explicitly enables it and permits one evidence-backed governed
review. Every scored task has fresh Agencity and game state; no learned artifact
crosses episodes.

RuneBench preflight compares effective concurrency times 8 GiB plus a 2 GiB
Docker/host reserve with Docker daemon capacity. An unavailable probe or unsafe
capacity is an error. This memory-only check does not prove CPU, provider quota,
scoring, or cleanup health.

### Terminal-Bench 2

Catalog: [`manifests/terminal-bench-2-catalog.json`](./manifests/terminal-bench-2-catalog.json)

- dataset:
  `terminal-bench/terminal-bench-2@sha256:c6fc2e2382c1dbae99b2d5ecd2f4f4a60c3c01e0d84642d69b4afd92e99d078b`;
- upstream source commit: `afbb742d222491967eea7f14e532abd481726a8c`;
- catalog coverage: 89/89 compatible tasks;
- catalog SHA-256:
  `42170432fabf7dd049c09917f491c754bfb318ddd306a5d2c9e18609030c5290`;
- canonical task-entry SHA-256:
  `8962dbae91eeb702f4f1fbca6505053bc9da19305dfe773c0b407efa04e22972`.

Each entry pins the complete downloaded task tree, `task.toml`, immutable
linux/amd64 image manifest and config, declared workdir, and upstream identity.
Harbor collection hooks run against the intact workspace first. Agencity's
portable service and generated state are then removed before the unmodified
Harbor verifier scores the collected evidence.

### Terminal-Bench 2.1

Catalog: [`manifests/terminal-bench-2-1-catalog.json`](./manifests/terminal-bench-2-1-catalog.json)

- dataset:
  `terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`;
- upstream source commit: `ffccbe05ee73a9d59518217f294ad711bda39304`;
- catalog coverage: 89/89 compatible tasks;
- catalog SHA-256:
  `abdf5a37bac0f947721489ff3dcdd6668097a480a5f338590b2d6ca6c520e968`;
- canonical task-entry SHA-256:
  `403f87827daa0c418edbe13082b55919e8f657f943ad1b55f539c84bcc1fde94`.

This is a distinct pinned dataset and catalog. It does not reinterpret
Terminal-Bench 2 history.

### SWE-bench Pro public

Catalog: [`manifests/swe-bench-pro-public-catalog.json`](./manifests/swe-bench-pro-public-catalog.json)

- public dataset revision: `7ab5114912baf22bb098818e604c02fe7ad2c11f`;
- catalog coverage: all 731 public rows;
- compatible set: 1 task;
- incompatible set: 730 tasks;
- catalog SHA-256:
  `370a192eb7f64292399e1489be0dc5c00633ebe715bedaefc1836edc58d39ce8`;
- canonical task-entry SHA-256:
  `1ac0a1db2f3705ae1c2cbbeb30d31dcdb54443c930365137ea86d8fef25b5fc6`.

Compatible row:

- `qutebrowser/qutebrowser` at base
  `def864adc8b19bdbc506919270d8ff1408b4faac`, image manifest
  `sha256:1607129d3ab3b54033dd9d6fdc9c05c6fad3d36dbdd89f36082f331acfcca35a`,
  workdir `/app`.

Of the incompatible rows, 729 have typed reason
`image_configuration_not_audited`: their public data and evaluator assets are
pinned, but their linux/amd64 image manifest/config pairs have not been resolved
and audited. The audited Vuls row is incompatible with
`official_noop_parser_evidence_empty`: its official no-op control produced no
parsed test evidence, so reward zero could not be distinguished from evaluator
failure. These rows are visible in coverage reports and cannot be selected by
`all`. Here, `all` means all compatible tasks, not the complete 731-row suite.

For each compatible task, setup archives only the pinned base tree, deletes the
original workspace and Git object store, creates one fresh baseline commit, and
proves the withheld commit cannot resolve. Only a bounded private patch crosses
to host scoring. Verifiers requests owned-runtime teardown before the custom
environment starts host scoring. A fresh network-disabled scorer then runs the
pinned unmodified official evaluator against the verified immutable image.
Empty, missing, or malformed official parser evidence is an infrastructure
error, never reward zero. The current Verifiers API does not return a
runtime-stop receipt, so a teardown exception is logged rather than made
available as scorer admission evidence.

### OOLONG-synth

- dataset: `oolongbench/oolong-synth`;
- revision: `f0d59eaf0febf130664cfceb710436c8e3216b2b`;
- pinned comparison slice: test/Yahoo/131,072 tokens, 50 tasks over two context
  windows;
- enforced manifest:
  [`manifests/oolong-yahoo-128k.json`](./manifests/oolong-yahoo-128k.json),
  SHA-256
  `d0a105f1ee619adf94cdaf8cc5e9606cb82a57bd7f970d476a3a2db3b9a5c275`;
- scorer source:
  `PrimeIntellect-ai/research-environments@ba7eabc710b0d49cab25f52a5457ad56ca04613c`,
  file SHA-256
  `3cf9882c294be58f3b92cda5773c56ae5ebbb53e97f25c1ec9c8c612515c6131`.

OOLONG supports the same exact, smoke, IDs, sample, shard, and all controls
after loading the pinned predicate-pushed slice. Every Yahoo 128K admission
checks exact task order, row IDs, context IDs, context hashes, context sizes,
and normalized answer types against the packaged manifest before applying the
selection. Its deterministic scorer is a parity-tested port of the pinned Prime
OOLONG-synth v1 source. File and terminal answers retain separate digests and an
agreement flag; the file remains authoritative as upstream specifies. Suite
configs use the portable harness, explicit shutdown/cleanup, and serial
execution. Context and gold answers remain private task-object fields: context
is written only to the authorized workspace, while neither value is serialized
in public task data or trace provenance. OOLONG is file-context reasoning
evidence, not repository-coding evidence.

Regenerate and compare the pinned slice without admitting a model:

```sh
uv run --locked python scripts/preflight_oolong.py \
  --split test --dataset-name yahoo --context-len 131072 \
  --expected-tasks 50 --check manifests/oolong-yahoo-128k.json
```

## Running evaluations

Prepare each new treatment from the latest remote Agencity `main`:

```sh
uv run --locked python scripts/refresh_agencity_source.py
```

The refresh command resolves remote `main` once, then writes that exact commit
to the harness defaults, suite configs, and catalog treatment metadata. Runs
therefore default to the latest published `main` at preparation time while
retaining an immutable source pin in their resolved configuration. Use
`--ref <full-commit>` to reproduce an earlier treatment, or `--check` to verify
that every retained pin already matches the current remote `main`.

Set the top-level `model` in a copied config to a Verifiers-supported model that
can produce Agencity's required formal tool calls. Do not change taskset
semantics when changing the model.

### Provider routes

Committed configs route evaluation calls directly to OpenAI's native
OpenAI-compatible endpoint and require an exported `OPENAI_API_KEY`. They do not
fall back to Vercel AI Gateway: a prior Gateway treatment emitted the
nonstandard streaming terminal reason `error`, which Verifiers 0.3.0 could not
represent. Configs use OpenAI's native model IDs such as `gpt-5.6-sol`, omit
unsupported temperature sampling, and let the harness add the `openai/` creator
namespace only when constructing Agencity's canonical model identity behind the
interception endpoint. A paid native OpenAI canary has passed this path.

Native OpenAI:

```sh
export OPENAI_API_KEY=...
uv run --locked eval @ configs/terminal-bench-2-smoke.toml \
  --model gpt-5.6-sol
```

Vercel AI Gateway remains available as an explicit experimental route. Change
the endpoint, credential variable, and wire model ID together:

```sh
export AI_GATEWAY_API_KEY=...
uv run --locked eval @ configs/terminal-bench-2-smoke.toml \
  --model openai/gpt-5.6-sol \
  --client.base-url https://ai-gateway.vercel.sh/v1 \
  --client.api-key-var AI_GATEWAY_API_KEY
```

Agencity's owner-only stored provider credentials are not automatically
exported to Verifiers. The resolved run `config.toml` retains the non-secret
route and model settings. The scrubbed benchmark summary does not yet project
the client base URL, so a cross-provider comparison must add that field before
claiming matched route provenance. Run one exact canary after any route change.

Smoke:

```sh
uv run --locked eval @ configs/terminal-bench-2-smoke.toml
```

Full compatible set:

```sh
uv run --locked eval @ configs/terminal-bench-2-full.toml
```

Committed configs use `xhigh` reasoning and a 128,000-token per-response
ceiling. Terminal-Bench, SWE-bench Pro, OOLONG, and smoke configs retain
per-run ceilings of 800,000 input, 500,000 output, and 1,000,000 total tokens;
their turn bounds are at least 50, with OOLONG at 64. RuneBench instead permits
5,000 turns and omits cumulative token ceilings because its official 15- or
30-minute horizon is the primary bound.
`scripts/apply_evaluation_policy.py` preserves this RuneBench-specific policy
while reapplying the shared defaults elsewhere. These are rollout bounds, not
targets or billed-dollar caps. Enforced turn and token limits are checked
between calls and can therefore overshoot by one admitted call.

Catalog-backed Terminal-Bench and SWE-bench Pro configs omit agent-level
`rollout` and `scoring` timeout overrides. Verifiers therefore applies each
official task's declared timeout. Suite preflight rejects either override so a
shared config cannot silently shorten task or evaluator execution.

These commands spend inference credit. Review the resolved config, current
pricing, selected count, provider-window worst-case, and operator budget first.
Keep `push = false` during development. Turn and token limits are checked
between calls and are not a hard billed-dollar cap.

## Matched harness comparisons

Benchmark semantics are independent from the Agencity harness. A future
Verifiers-compatible coding harness can be selected under `[env.agent.harness]`
without changing the taskset or scorer.

For a matched comparison:

1. preflight one config and retain its exact selected IDs and digest;
2. hold dataset/catalog, task IDs/order, model snapshot, endpoint class,
   reasoning, sampling, rollout count, turn/token/time budgets, runtime image,
   CPU/memory/disk/network, and official scorer constant;
3. vary only harness ID/config and harness source pin;
4. report every attempted task and the same failure policy;
5. use repeated rollouts and uncertainty estimates when stochasticity matters.

Model comparisons are a separate experiment: hold the harness and all other
fields fixed, then vary only the model configuration.

## Reporting

Create a scrubbed deterministic summary from a local Verifiers output:

```sh
uv run --locked python -m agencity_verifiers.reporting \
  outputs/<run-directory> \
  --selection /path/to/preflight-selection.json \
  --output /path/to/summary.json
```

The report separates passes, valid zeros, partial rewards, agent terminal
failures, provider failures, scorer/infrastructure errors, skips, cancellations,
unknowns, and catalog incompatibility counts. Reward mean uses only officially
scored tasks and states its denominator. Infrastructure errors are not silently
averaged as zero. Provider-supplied calls, tokens, timing, and cost are
aggregated when present. Summary schema v2 emits `agent_terminal_failure`;
the misleading v1 `harness_terminal_failure` name is not retained.

## Model-free verification

```sh
uv lock --check
uv run --locked python -m unittest discover -s tests -v
uv run --locked python -m unittest tests/test_exact_container_startup.py -v
uv build
```

The exact-container startup test archives the current runtime source, installs
it inside the pinned Bun image under explicit `linux/amd64` execution, and runs
the real JSON product path against a local fake provider. It deliberately
supplies a missing explicit state directory and requires one valid terminal
result without paid inference.

Suite task catalogs and the portable Bun executable intentionally target
`linux/amd64`. An ARM Mac therefore runs local benchmark containers through
Docker's AMD64 emulation; changing only the executable or host platform to ARM
would create a different treatment and may not match the audited task images or
official scorers. Prime remote sandboxes can execute the same pinned AMD64
treatment without relying on the local Mac's architecture.

Official SWE-bench Pro Docker reference/no-op checks are opt-in:

```sh
AGENCITY_SWE_PRO_OFFICIAL=1 \
uv run --locked python -m unittest \
  tests.test_swe_bench_pro.OfficialScorerIntegrationTests -v
```

Model-free checks validate selection, pins, packaging, isolation, sanitizer,
official scorer parsing, lifecycle order, cleanup, and reporting. They are not
model performance evaluations.

The August 18, 2026 run against Agencity commit
`e03a2ad264e18589064153252fa7f094b00a4c21` recorded 74 passing benchmark
tests, 1 skipped opt-in scorer test, and 0 failures. The same official scorer
test passed separately when enabled. The explicit `linux/amd64` exact-container
startup passed on an ARM Mac through Docker emulation. All 21 suite preflights,
all 22 config dry-runs, source/wheel builds, isolated wheel/sdist loading, lock
validation, and source-pin checks passed. The live Yahoo 128K slice exactly
matched its packaged manifest. A Vuls no-op audit returned empty parser
evidence; the catalog therefore retains that row as incompatible rather than
mapping it to reward zero.

The August 19, 2026 current working tree passed 95 benchmark tests, skipped one
unrelated opt-in SWE-bench Pro scorer test, and had zero failures. All six
RuneBench preflights and dry-runs, the source/wheel build, and pinned-image
controller and tracker checks passed without model inference.

## Recorded model evidence

- RuneBench: one Luna-xhigh Woodcutting 15-minute treatment on commit
  `1b2cebf` produced an official `100.0` XP/min score with successful scoring
  and cleanup. The agent ended failed at the then-current cumulative input-token
  bound before a typed `finish`; RuneBench configs have since removed that
  bound. The run exposed competing-controller, action-backoff, and tracker-path
  defects in that earlier revision. The current model-free treatment addresses
  them, but this paid result predates the fixes and is not readiness evidence.
- OOLONG: one revised Sol-high Yahoo 128K task scored `1.0`; a corresponding
  Luna task scored `0`. A later current-revision Sol-high canary on commit
  `5d533d1bb03c1b1f5f45ecdb65df1cc7612bf193` completed the repaired
  infrastructure path but returned `Society & Culture` instead of the expected
  `Sports`, scoring `0`. It used 19 Agencity steps, 20 provider calls, 90,951
  prompt-plus-completion tokens, about four minutes, and $0.89. No full OOLONG
  run was made.
- Terminal-Bench 2: one hardened Luna-high `fix-git` task scored `1.0`. A
  later Sol-high canary on commit
  `3c2f4f648c42fbc684db3de55905661e9f18b27a` also scored `1.0`: it completed
  in 8 model calls, used 22,995 prompt tokens, 3,867 completion tokens, and
  16,492 cached input tokens, and took about 125 seconds end to end through
  Vercel AI Gateway. Verifiers reported provider cost as `0.0`, which is
  missing billing metadata rather than evidence that the run was free.
  A subsequent full-set attempt on commit `ffe7bf8` was operator-stopped after
  six completed tasks and is not a suite result: one passed, five scored zero,
  three reached the former 48,000-token run bound, and one received Gateway's
  nonstandard `finish_reason="error"` envelope before any model turn.
  A native OpenAI Sol-xhigh canary on commit `63b35ea` then scored `1.0` in 6
  model calls, with 17,388 prompt tokens, 2,507 completion tokens, 12,170 cached
  input tokens, and about 81 seconds end to end. The first native probes exposed
  and removed Gateway-style model namespacing and unsupported temperature
  sampling before this passing treatment.
- Terminal-Bench 2.1: one independently pinned Luna-high `fix-git` task scored
  `1.0`. A native OpenAI Sol-xhigh canary on commit `63b35ea` also scored
  `1.0` in 6 model calls, with 14,473 prompt tokens, 1,695 completion tokens,
  14,604 cached input tokens, and about 75 seconds end to end.
- SWE-bench Pro: one attended Luna-high qutebrowser task made nine calls,
  reached Agencity's total-token bound without a patch, and officially scored
  `0.0`. It must not be rerun merely to seek a better result.

These are single-task integration treatments, not suite scores or comparative
performance claims. No paid full-suite execution has been performed.

## Remaining limits

- RuneBench support covers the pinned 32 published skill tasks. Gold,
  collaboration, and cross-episode curriculum treatments are not included. The
  current public-leaderboard comparison uses the 16 30-minute skills. The
  controller, managed trainer, tracker command, cleanup, and memory preflight
  have model-free coverage but no paid 30-minute canary on this revision.
- Only 1 of 731 SWE-bench Pro public rows is currently compatible. Of the 730
  incompatible rows, 729 lack audited immutable image pins and one audited Vuls
  row fails the required official no-op parser-evidence control. This blocks a
  complete public-suite run, but not the one-task full compatible set.
- Full-suite model runs remain operator-gated by cost. Suite-capable loading and
  dry-run validation do not imply model-based completion.
- Agencity's public JSON result lacks durable cancellation/reconciliation and
  aggregate internal budget receipts. Runtime disposal and Verifiers limits
  bound attended development runs; large unattended execution remains unsafe.
- The SWE-bench Pro private patch is retained only in the host task object
  between agent finalization and environment scoring. A host crash in that
  interval is not resumable. Verifiers also does not expose an owned-runtime
  teardown receipt to scorer admission.
- No second harness integration is included. The taskset/harness separation is
  implemented and tested, but an actual matched comparison remains future work.
- Hosted execution and local/hosted parity are unverified.

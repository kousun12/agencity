# Prime Verifiers benchmarks

This project runs Agencity as a custom Prime Verifiers v1 harness. Its Python
dependencies and lockfile are isolated from Agencity's Bun product runtime.

See [`AUTHORING.md`](./AUTHORING.md) to add a benchmark. Workspace-scored coding
tasks are the primary benchmark class; answer-only adapters are deferred until
a concrete low-cost evaluation requires one.

## OOLONG treatment

The OOLONG integration implements a **Prime-style file-offloaded
OOLONG-synth** treatment:

- dataset: `oolongbench/oolong-synth`;
- pinned revision: `f0d59eaf0febf130664cfceb710436c8e3216b2b`;
- benchmark context written to `/app/workspace/oolong-context.txt`;
- original question passed to a fresh Agencity root;
- answer read from `/app/workspace/oolong-answer.txt`, with Agencity's terminal
  `final` value as fallback;
- deterministic official OOLONG-synth scoring, including numeric partial credit;
- model calls routed through Verifiers' rollout interception endpoint.

The full comparison config selects the identifiable slice from Prime Agent's
published table: test split, Yahoo source, 131,072-token bucket, all 50 tasks,
two context windows, no label augmentation, and no numeric-task filtering.

This is not the paper's direct-context treatment and is not an exact
reproduction of Prime Agent's result. Prime says it gave every compared harness
the main context through a file, but it does not publish its complete task
manifest, dataset revision, prompt, numeric-filter choice, sampling settings,
budgets, or adapter.

## Setup and model-free verification

Requirements:

- Bun 1.3.14 or newer;
- Docker with the pinned Bun image available;
- Python 3.12 or 3.13 (the pinned Harbor extra requires Python 3.12+);
- `uv`;
- network access to Hugging Face for the dataset preflight;
- a current Prime login and inference credit only for paid rollouts.

From this directory:

```sh
uv sync --locked
uv run --locked python -m unittest discover -s tests -v
uv run --locked eval @ configs/oolong-synth-smoke.toml --dry-run
uv run --locked eval @ configs/oolong-yahoo-128k-sample.toml --dry-run
uv run --locked eval @ configs/oolong-yahoo-128k-sol-sample.toml --dry-run
uv run --locked eval @ configs/oolong-yahoo-128k-full.toml --dry-run
```

Resolve the pinned Yahoo 128K selection without model inference:

```sh
uv run --locked python scripts/preflight_oolong.py \
  --output manifests/oolong-yahoo-128k.json
```

The loader uses Parquet predicate pushdown. Hugging Face may still populate its
local cache, so allow several gigabytes of free storage. Set `HF_HOME` or pass
`--cache-dir` to place the cache on another volume. The complete dataset is
about 12 GB compressed; the selected slice is much smaller.

## Paid rollout ladder

Every command below spends Prime inference credit. Keep `push = false` during
development.

First run one 1K validation task:

```sh
uv run --locked eval @ configs/oolong-synth-smoke.toml
```

After inspecting its trace, score, terminal status, answer source, and cleanup,
run one task from the target Yahoo 128K treatment:

```sh
uv run --locked eval @ configs/oolong-yahoo-128k-sample.toml
```

That config uses Luna as a lower-cost integration probe. The target-model probe
is separate:

```sh
uv run --locked eval @ configs/oolong-yahoo-128k-sol-sample.toml
```

The fully loaded 50-task command is intentionally separate:

```sh
uv run --locked eval @ configs/oolong-yahoo-128k-full.toml
```

Do not start the full command without reviewing current Prime pricing and
wallet balance. Its proxy-side upper bounds permit up to 64 model turns and
500,000 total tokens for each of 50 rollouts. Those are safety ceilings, not an
expected cost estimate.

## Development evidence

On August 10, 2026:

- the pinned 1K spam selection resolved to 50 tasks and two context windows;
- the pinned Yahoo 128K selection resolved to 50 tasks, two context windows,
  280,690- and 292,898-byte context files, and the generated selection manifest;
- one Luna 1K rollout completed in seven model turns, used the answer file, and
  scored `1.0`;
- one Luna Yahoo 128K rollout reached the 12-turn probe limit while beginning a
  recursive batch-classification strategy and scored `0`;
- one Sol-high Yahoo 128K rollout launched 21 recursive classification shards
  but reached the 300,000-token probe limit before terminal aggregation. It
  scored `0`, took about 22 minutes, and consumed $9.91 of Prime inference
  credit;
- after adding in-cell recursive-result aggregation and raising the ceiling to
  500,000 tokens, one Sol-high Yahoo 128K rollout completed in 22 model calls
  and five Agencity steps. It used 397,293 total tokens, took about 22 minutes,
  returned `Sports`, scored `1.0`, and consumed $3.85 of incremental Prime
  inference credit;
- the same revised sample on Luna completed in 12 model calls and nine Agencity
  steps. It used 62,973 total tokens, took about three minutes, returned
  `Society & Culture` instead of `Sports`, scored `0`, and consumed $0.37 of
  incremental Prime inference credit.

These single-task 128K probes are integration evidence, not benchmark scores.
The successful Sol sample establishes the complete route, but extrapolating its
cost linearly gives roughly $193 for 50 tasks before variance or failed work.
The full run therefore remains operator-gated. Luna is materially cheaper but
did not solve this sampled task, so its lower cost is not evidence that it is a
viable replacement for the target-model run.

## Terminal-Bench 2 Harbor treatment

The Terminal-Bench 2 integration is a one-task workspace-scored Harbor
treatment, not a Terminal-Bench suite result.

- source: `terminal-bench/terminal-bench-2`, pinned to Harbor dataset digest
  `sha256:c6fc2e2382c1dbae99b2d5ecd2f4f4a60c3c01e0d84642d69b4afd92e99d078b`;
- selected task: `fix-git`, recording upstream task reference
  `sha256:66be7179f07f1aa8f0d60f88800a883a68c1ffb7a349aae76aa60fa679485473`
  and enforcing complete task-tree digest
  `5390c93a787a9cfea243764401ad5f9ca3733346553997c812865f3981943abd`;
- task image: `alexgshaw/fix-git@sha256:61e431c00c58df652287aadce5457634d9f9330cfdd153ebdf2802df0d540119`;
- task workspace: `/app/personal-site`;
- scorer: the upstream Harbor `tests/test.sh` verifier, staged only after
  Agencity exits;
- treatment manifest:
  [`manifests/terminal-bench-2-fix-git.json`](./manifests/terminal-bench-2-fix-git.json).

The portable harness path downloads the exact Agencity Git revision on the
evaluator host, verifies and stages a pinned Linux x64 Bun executable, then
installs the locked Bun dependencies in the selected task image. It does not
assume `apt-get`, Git, Bun, or Node are available in that image. The task
workspace remains Agencity's workspace; profile, database, artifacts, and
bootstrap files are rollout-local under `/tmp/agencity-eval`. The harness
refuses a workspace with pre-existing `.agencity` metadata, hides only the
generated marker from Git during execution, confirms managed-service shutdown,
and removes the generated marker and rollout state during task finalization,
outside the agent timeout and before scoring. Only the Verifiers interception
credential is passed by the harness to Agencity.

Model-free checks:

```sh
uv lock --check
uv run --locked python -m unittest discover -s tests -v
uv build
uv run --locked eval @ configs/terminal-bench-2-fix-git-sample.toml --dry-run
```

The sample configuration uses one task, one rollout, concurrency one, no
whole-rollout retries, no upload, twelve turns, 64,000 input tokens, 32,768
output tokens, 48,000 total tokens, a 900-second agent cap, and a 900-second
scoring cap. Run it only after reviewing current model pricing and the resolved
configuration:

```sh
uv run --locked eval @ configs/terminal-bench-2-fix-git-sample.toml
```

The turn and token limits are checked between model calls. They bound this
attended treatment but are not a hard billed-dollar admission control; one
final call can overshoot a token threshold. Review a provider-window
worst-case estimate and available wallet before every paid run. Generated
resolved configurations can contain private client headers and remain ignored
local evidence; scrub them before sharing.

The task image is `linux/amd64`; Apple Silicon Docker runs it through platform
emulation. The current single-agent harness does not expose a public durable
cancellation/reconciliation receipt if an outer evaluation timeout interrupts a
run. This limits the integration to short attended probes until that interface
exists. Harbor's hidden verifier reward, not Agencity's final message, is the
authoritative score.

On August 10, 2026, the lock, 39 model-free tests, source and wheel builds,
installed-wheel pin validation, dry-run resolution, exact Harbor task loading,
source-distribution leak checks, complete task-tree integrity checks, and
portable lifecycle checks in the pinned task image passed. The first paid
attempt failed before model admission because the portable state directory did
not exist; it made zero model calls and did not reach Harbor scoring. An
eight-call diagnostic rollout then reached Harbor and scored `0`: Agencity
reported `failed` at its turn limit after generated `.agencity` metadata made
the Git worktree appear dirty. Both failures are retained as infrastructure and
treatment-debugging evidence.

After the harness isolated and removed generated workspace metadata, the
final hardened one-task Luna-high rollout completed in eight model calls and
eight Agencity
steps. Agencity reported `succeeded`, the managed service reported stopped,
cleanup completed, and the upstream Harbor verifier scored `1.0`. The trace
recorded 19,408 prompt tokens, 3,088 completion tokens, 11,320 cached input
tokens, 1,622 reasoning tokens, no errors, and an `agent_completed` stop.
At the preflight prices of $1 per million input tokens and $6 per million
output tokens, that usage has a $0.0379 undiscounted listed-price ceiling.
This is one passing treatment probe, not a Terminal-Bench score or suite claim.

## Terminal-Bench 2.1 Harbor treatment

Terminal-Bench 2.1 is a separate one-task Harbor treatment. It does not
replace, migrate, or reinterpret the Terminal-Bench 2 treatment.

- dataset: `terminal-bench/terminal-bench-2-1` at
  `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`;
- selected task: the refreshed `fix-git` package at
  `sha256:16948b980df9d96de616a205f5acca1c5d395de83ff4f8ffabcafacb93226f2e`;
- complete downloaded Harbor task-tree digest:
  `30aed800ba51d02a300800e34db211afa4a0ea9f4af098c628bdb8308facbfc8`;
- task image:
  `alexgshaw/fix-git@sha256:389b9c8247610c2c5be080b1ac00429007c2c69bf57f7f26c79f0f75ba2d5c74`;
- workspace: `/app/personal-site`;
- scorer: the unmodified upstream Harbor verifier, after Agencity's managed
  service has stopped and the generated `.agencity` marker and rollout-local
  state have been removed.

The deliberately short Git-recovery task has a revised 2.1 task package and
image from the Terminal-Bench 2 selection. Its bounded manifest records the
official source commit, task/image digests, shared harness pins, Python lock
digest, selection rationale, and the treatment's only harness deviation.

Run the model-free checks:

```sh
uv lock --check
uv run --locked python -m unittest discover -s tests -v
uv build
uv run --locked eval @ configs/terminal-bench-2-1-fix-git-sample.toml --dry-run
```

On August 10, 2026, the 62-test model-free suite, wheel/sdist inspection,
installed-wheel pin check, exact Harbor loading and tree verification, both
dry-runs, and a portable bootstrap/metadata-cleanup lifecycle in the pinned
image passed. One attended Luna-high rollout made seven model calls, reported
`succeeded` after seven Agencity steps, confirmed service shutdown and cleanup,
and received Harbor reward `1.0`. It used 17,036 prompt tokens and 2,334
completion tokens (8,490 cached input and 1,492 reasoning tokens reported).
The run did not report provider cost. A deliberately conservative preflight
using twelve full configured provider windows at the previously recorded
$1/M-input and $6/M-output list rates was $3.15; the observed non-cached
listed-rate calculation is about $0.031. This one result is integration
evidence, not a Terminal-Bench 2.1 score or a suite capability claim.

## SWE-bench Pro public split treatment

`agencity_swe_bench_pro` is a separate one-instance treatment for public
SWE-bench Pro. It selects
`instance_qutebrowser__qutebrowser-0833b5f6f140d04200ec91605f88704dd18e2970-v059c6fdc75567943479b23ebca7c07b5e9a7f34c`
from dataset revision `7ab5114912baf22bb098818e604c02fe7ad2c11f`.
The manifest pins repository `qutebrowser/qutebrowser`, base revision
`def864adc8b19bdbc506919270d8ff1408b4faac`, public selection digest, task
image manifest/config digests and observed image ID, evaluator commit/tree and selected-file
digests, Verifiers and Docker SDK versions, Agencity commit
`ef16e551cc4494cdd76637249a80afa82cdf26be`, Bun archive digest, and Python
lock digest.

The treatment has two isolated stages:

1. The agent container archives only the pinned base revision, deletes the
   original workspace and Git object store, initializes one fresh baseline
   commit, and confirms that the withheld test commit is not resolvable. The
   prompt contains only the public issue, requirements, interface, repository,
   and base revision. Network access is limited to Verifiers interception.
2. After Agencity stops and generated metadata/state are removed, finalization
   captures a bounded private patch. The agent container is destroyed. A host
   scorer fetches and verifies the pinned official evaluator, aliases the
   immutable task image under a loopback-unreachable name required by the
   upstream mutable-tag interface, and runs the unmodified official local-Docker
   evaluator in a fresh network-disabled container.

Reference patches, withheld test patches and Git objects, official run/parser
scripts, patch content, parsed test names, and evaluator output are absent from
agent-visible task data and committed trace evidence. Traces retain only
bounded digests, byte counts, the official boolean result, and cleanup facts.

Run the bounded sample:

```sh
uv run --locked eval @ configs/swe-bench-pro-public-qutebrowser-sample.toml --dry-run
```

Model-free validation proved that the pinned container sanitizer leaves one
fresh commit and no resolvable withheld commit. The official evaluator scored
the reference patch `1.0` and a no-op patch `0.0`; temporary scorer aliases,
containers, and directories were removed.

One attended Luna-high rollout then made nine model calls. Agencity exhausted
the configured total-token bound after ten steps, reported terminal `failed`,
and produced no workspace change, so the adapter supplied its declared
synthetic no-op patch. The official evaluator completed normally and returned
`0.0`. The trace reported 34,058 prompt tokens, 3,331 completion tokens, 11,840
cached input tokens, and 2,019 reasoning tokens. Service shutdown, generated
metadata/state cleanup, scorer-container teardown, image-alias removal, and
temporary-directory cleanup all completed. The provider trace had no per-run
cost field; the attended wallet display decreased by approximately `$0.01`.
That paid probe used the initial port-1 alias route. A subsequent audit hardened
the current adapter to port 0, an explicit failed pull of the populated alias,
and before/after alias-ID checks; the model-free no-op scorer passed again.
No second paid probe was run.
This is one zero-score integration treatment, not a SWE-bench Pro score or
capability claim. SWE-bench Verified is not used as the primary benchmark.

## Evidence and interpretation

Retain:

- the resolved TOML;
- Agencity source revision;
- Python lockfile and Docker image digest;
- generated OOLONG selection manifest;
- model, reasoning effort, sampling, limits, and rollout count;
- `traces.jsonl`, terminal status, answer source, reward, token usage, and any
  Prime-reported cost;
- pass, zero-score, blocked, failed, unknown, cancelled, and infrastructure
  error counts separately.

For the new additions: Terminal-Bench 2.1 has one pass and zero zero-score,
blocked, failed, unknown, skipped, or infrastructure-error outcomes. SWE-bench
Pro has one completed zero-score treatment with Agencity terminal `failed`, and
zero pass, blocked, unknown, skipped, or infrastructure-error outcomes.

The OOLONG reward is a mean task score, not binary accuracy. Numeric tasks use
`0.75 ** absolute_error`; other supported synth answers use exact matching
after the official parser.

Agencity's current `run --json` envelope does not expose durable run identity,
internal budget telemetry, or cancellation reconciliation. Verifiers' proxy
limits and local Docker disposal bound these development runs. A large
unattended or hosted run remains blocked on a bounded Agencity benchmark-runner
contract with explicit cancellation and cleanup receipts.

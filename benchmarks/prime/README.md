# Prime Verifiers benchmarks

This project runs Agencity as a custom Prime Verifiers v1 harness. Its Python
dependencies and lockfile are isolated from Agencity's Bun product runtime.

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
- Python 3.11 through 3.13;
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
  credit.

The two 128K probes are configuration evidence, not benchmark scores. They show
that a 50-task Sol run can cost hundreds of dollars and that the harness must
aggregate recursive results inside TypeScript to avoid returning large child
outputs to the parent model. No further paid run should start until the operator
approves a cost ceiling and one target-model sample completes under that ceiling.

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

The OOLONG reward is a mean task score, not binary accuracy. Numeric tasks use
`0.75 ** absolute_error`; other supported synth answers use exact matching
after the official parser.

Agencity's current `run --json` envelope does not expose durable run identity,
internal budget telemetry, or cancellation reconciliation. Verifiers' proxy
limits and local Docker disposal bound these development runs. A large
unattended or hosted run remains blocked on a bounded Agencity benchmark-runner
contract with explicit cancellation and cleanup receipts.

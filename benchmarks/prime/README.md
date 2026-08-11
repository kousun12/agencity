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

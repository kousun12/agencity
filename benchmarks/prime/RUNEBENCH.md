# RuneBench treatment

This document defines Agencity's RuneBench evaluation treatment. RuneBench
measures long-horizon game play through an emulated RuneScape server and a
TypeScript SDK. The official verifier scores the best normalized real-game
XP/min achieved between adjacent fixed 15-second samples.

## Pinned benchmark

- Harbor dataset:
  `maxbittker/runebench@sha256:4bb3430af2ef3a320bd3dfeeab2447fbf9e0093452ad747997186a85a060de28`;
- published coverage: 32 skill tasks, one 15-minute and one 30-minute task for
  each of 16 skills;
- upstream source:
  `MaxBittker/runebench@826107d10f731eae4fd6b93bcd63d072d4346654`;
- game image:
  `ghcr.io/maxbittker/rs-agent-benchmark@sha256:0961663ac1dc23d6cd00b88e79ff106cb1f0c7b7340659a914f96a8454124016`;
- image configuration:
  `sha256:583556dc0adcc31d541629851f937bf72edd1386327f5ad46076c802fffaecb9`;
- catalog: [`manifests/runebench-catalog.json`](./manifests/runebench-catalog.json).

The pinned Harbor dataset contains the 32 skill tasks. The upstream repository
also defines newer gold and collaboration tasks, but those are not members of
this immutable dataset version and are outside this treatment.

## Prerequisites and local setup

Run the benchmark from the isolated Python project at
`benchmarks/prime/`. It does not use the repository-root Bun dependency
installation.

Required software and access:

- Python 3.12 or 3.13;
- [uv](https://docs.astral.sh/uv/);
- a running Docker daemon that can grant the task container its 8 GiB memory
  limit;
- network access for the initial Python package, Harbor dataset, game image,
  pinned Agencity source, portable Bun, and model-provider downloads or calls;
- an OpenAI API key for the preferred native OpenAI route, or a Vercel AI
  Gateway key for the fallback route.

The official game image and portable Bun are `linux/amd64`. Docker uses AMD64
emulation on ARM Macs. The platform warning is expected, and startup and game
execution are slower than on an AMD64 host.

From the repository root:

```sh
cd benchmarks/prime
uv sync --locked
docker info
```

The harness installs the exact Agencity source commit and portable Bun declared
by the selected config inside each task container. A separate host installation
or build of Agencity is not required.

Verifiers does not automatically export Agencity's owner-only stored provider
keys. Before reporting a missing benchmark credential, resolve credentials in
this order:

1. saved OpenAI key;
2. `OPENAI_API_KEY`;
3. saved Vercel AI Gateway key;
4. `AI_GATEWAY_API_KEY`.

The default saved-key file is `~/.agencity/auth.json`. When
`AGENCITY_PROFILE` selects another profile database, use `auth.json` in that
database's directory. Saved values are under `providers.openai.apiKey` and
`providers.vercel.apiKey`. Read only the selected value into the evaluation
process environment; never print it or pass it as a command argument.

The OpenAI route uses the committed config unchanged. When only the Vercel key
is available, change the endpoint, credential variable, and wire model ID
together:

```sh
uv run --locked eval @ configs/runebench-woodcutting-15m-adaptive.toml \
  --model openai/gpt-5.6-luna \
  --client.base-url https://ai-gateway.vercel.sh/v1 \
  --client.api-key-var AI_GATEWAY_API_KEY \
  --output-dir outputs/runebench-woodcutting-15m-adaptive-luna-vercel
```

Do not put the key in a config, trace, output directory, command argument, or
committed file.

## Agencity interface adaptation

The official source task describes an `execute_code` MCP wrapper. The treatment
deterministically removes that interface section before the task reaches the
model. The final task contains only Agencity's TypeScript-console interface and
the official objective, horizon, legitimate-action rule, and scoring semantics.

The harness stages `/app/agencity-runebench/controller.ts`. The model acquires
the one controller allowed in its persistent Bun console:

```ts
const {
  acquireController,
  runActionLoop,
} = await import("/app/agencity-runebench/controller.ts");
const controller = await acquireController("repl");
const rs = controller.rs;
const bot = controller.bot;
```

The treatment-owned module constructs the pinned image's `BotSDK` and
`BotActions`. Its atomic owner claim includes the process identity, rejects a
second live controller, and removes a stale claim only after the recorded
process identity is no longer live. Release waits for SDK disconnection and
confirms disconnected state before relinquishing ownership. The local
`password: "test"` option remains ordinary benchmark configuration; only exact
credential values registered by Agencity are rejected or redacted. No MCP
process or protocol is involved.

This adaptation is named `agencity-runebench-repl-v1`. It preserves the
official task package, initial save, game image, time horizon, 15-second sample
cadence, and Harbor verifier. It changes the agent-to-SDK interface, stages
explicit console guidance in the root `AGENTS.md`, and raises the runtime
memory cap from the pinned package's 4 GiB to 8 GiB. The current upstream
generator made the same memory change after documenting agent OOM failures at
4 GiB. The adapted task removes the unavailable MCP instructions and corrects
the tracker command without duplicating the root treatment guidance. The
catalog and task trace retain both memory values and both the original and
adapted prompt digests.

The game starts after the pinned Agencity source and Bun runtime are installed.
This prevents harness provisioning time from consuming the game horizon. The
harness stages the official save first, starts `/entrypoint.sh`, and admits the
agent only after both the tracker and bot report ready.

### Files available to the agent

The pinned image includes the game SDK, its documentation, retained learnings,
and extracted game-wiki Markdown:

- `/app/sdk/API.md` and the TypeScript source under `/app/sdk/`;
- `/app/learnings/`;
- `/app/wiki/skills/`;
- `/app/wiki/shops/`;
- `/app/wiki/items/`;
- `/app/wiki/npcs/`;
- `/app/wiki/quests/`.

Agencity can search and read these files through its ordinary typed file, shell,
and Bun APIs. They are image-owned files rather than MCP resources. The harness
does not mount external documentation that is absent from the pinned image.

### Treatment prompting

The adapted task retains the benchmark objective, rules, and active tracker
command. The root `AGENTS.md` supplies the Agencity-specific treatment once. It
tells the model to:

- use only the staged direct-console controller and never construct `BotSDK`;
- preserve Agencity's built-in `sdk` binding and name the acquired game objects
  `rs` and `bot`;
- keep high-level `BotActions` methods such as `attackNpc` on `bot` and
  lower-level `BotSDK` methods on `rs`, following `/app/sdk/API.md` instead of
  guessing a receiver;
- use a compact direct-SDK quick start that preserves the official interface
  examples under the translated `bot` and `rs` names, plus the exact bounded
  file and shell result shapes for finding additional methods;
- acquire once, then reuse those live objects while the exact branch REPL epoch
  remains warm;
- begin with one short action and a small returned state summary;
- treat a returned `{ success: false, message }` as failure and run repeated
  actions only through the staged bounded-backoff helper;
- lengthen only a measured working loop and change strategy instead of
  hot-looping an unavailable target;
- avoid opening-turn object enumeration and repeated unchanged documentation
  searches while the scored horizon is running;
- consult SDK, learning, and wiki files on demand rather than loading all of
  them into context;
- measure XP rate through the active tracker path after each strategy;
- write trainer files only below `/app/agencity-runebench/trainers/`;
- release and confirm the REPL controller before handing ownership to exactly
  one trainer;
- move a proven non-zero loop into that owned trainer so game actions continue
  during model decisions instead of alternating one foreground action with one
  provider call; and
- start, inspect, read logs from, and stop that trainer only through
  `sdk.processes`.

The treatment currently does not prescribe a multi-agent strategy.

### Persistent REPL semantics

Top-level imports, variables, functions, classes, module instances, sockets, and
object identity persist across cells for one exact session and branch while its
worker remains alive. The model can therefore keep one live game connection and
incrementally improve helpers and loops without rebuilding them on every turn.

The REPL heap is not durable. Worker loss, service loss, cancellation,
recycling, or a branch change produces a new epoch. Required recovery data must
use files, durable state, or artifacts, and the model must reconnect from
current inputs; prior effectful cells are never replayed automatically.
Console calls from imported callbacks outside an active cell are no-ops. A
long-running strategy therefore uses `sdk.processes`, whose JSON handle,
process-group lifecycle, bounded logs, and terminal outcome remain available
after console-worker loss. Unmanaged `command &`, `nohup`, `/tmp` trainers, and
second controllers are forbidden.

## Learning modes

Every scored task starts with a fresh Agencity workspace, profile database, and
game character.

- `fresh` explicitly pauses automatic learning before the root run and omits
  manual refinement guidance.
- `within-run` explicitly enables automatic learning before the root run and
  first requires a measured non-zero strategy. While a proven game loop runs as
  an owned managed process, the agent may request one focused governed refinement from
  retained failures and rate evidence, then test an approved memory, prompt
  note, or skill in a later measured attempt.

No profile or learned artifact crosses scored tasks. This keeps tasks
independent and avoids curriculum leakage. It also means this integration does
not measure cross-episode continual learning.

A cross-episode study requires a separate sequential environment contract. It
must define curriculum order, emulator reset, profile export/import, training
versus held-out skills, inference and reviewer budgets, and whether training
time enters the score. That study must be reported separately from the
fresh-profile RuneBench treatment.

## Configurations

- `configs/runebench-woodcutting-15m-fresh.toml` — one exact Woodcutting task
  with automatic learning paused;
- `configs/runebench-woodcutting-15m-adaptive.toml` — the same exact task with
  within-run learning enabled;
- `configs/runebench-15m-sample-adaptive.toml` — four fixed 15-minute skills;
- `configs/runebench-leaderboard-full-adaptive.toml` — the 16 30-minute skill
  tasks used by the current public leaderboard;
- `configs/runebench-full-adaptive.toml` — the exhaustive local selection of all
  32 published 15- and 30-minute skill tasks.

The committed configs use native OpenAI, `xhigh` reasoning, one rollout per
selected task, up to 5,000 model turns, and a 128,000-token per-response
ceiling. They deliberately omit cumulative input, output, and total-token
ceilings. The official 15- or 30-minute task horizon remains authoritative, so
elapsed task time normally terminates the rollout before the turn allowance.
This configuration does not bound provider spend; review the model and route
before any paid run.

### Full leaderboard run

The [public RuneBench leaderboard](https://maxbittker.github.io/runebench/)
currently loads the 30-minute skill results and presents one best-of-one result
for each of 16 skills. Its ranking value is the mean of
`ln(1 + peak XP/min)` across those 16 skills. A single task reward such as
Woodcutting `100.0` is one XP/min cell, not a percentage or complete benchmark
score.

`configs/runebench-leaderboard-full-adaptive.toml` is the full
leaderboard-comparable selection. Claim a complete row only when all 16 tasks
have valid official scores. Keep provider, model, reasoning effort, task
treatment, rollout count, and task horizon fixed. A local complete run does not
automatically publish a row; public inclusion remains subject to upstream
source-provenance and submission requirements.

Do not admit the paid full run until one exact 30-minute canary proves that the
direct-REPL treatment has one bot controller, the background trainer handles
non-throwing action failures with bounded backoff, and the documented rate
command reads the tracker's actual output path. The latest paid 15-minute
canary exposed defects in all three areas even though official scoring
completed.

The serial task horizon is eight hours before setup and scoring overhead:
16 tasks × 30 minutes. The committed serial configuration is the portable
default:

```sh
uv run --locked eval @ configs/runebench-leaderboard-full-adaptive.toml \
  --output-dir outputs/runebench-leaderboard-full-adaptive
```

Each episode receives a separate 8 GiB container and fresh Agencity/game state.
Four concurrent episodes therefore require at least 32 GiB for task containers
plus the explicit 2 GiB Docker/host reserve used by preflight, as well as
provider quota for simultaneous calls. Before changing concurrency, validate
the exact effective value:

```sh
uv run --locked python scripts/preflight_suite.py \
  configs/runebench-leaderboard-full-adaptive.toml \
  --max-concurrent 4
```

This rejects four-way admission unless the Docker daemon reports at least 34
GiB. A missing or unreadable daemon capacity is unavailable, not a pass.
Passing this memory check does not prove CPU, provider quota, scoring, or
cleanup health. Start at two only on a suitably provisioned host, inspect one
completed task, and raise further only when every resource and cleanup signal
remains healthy. Do not lower the pinned 8 GiB task memory to increase
concurrency.

### Recommended paid canary

`configs/runebench-attack-30m-adaptive.toml` selects exactly
`attack-xp-30m`, one rollout, and serial execution. Before using it, the
configured `source_ref` must be a remotely fetchable immutable commit containing
the controller and managed-process changes in this document. After that commit
reaches the configured source repository's `main`, synchronize and check every
benchmark source pin:

```sh
uv run --locked python scripts/refresh_agencity_source.py
uv run --locked python scripts/refresh_agencity_source.py --check
```

Then preflight and run the one paid canary:

```sh
uv run --locked python scripts/preflight_suite.py \
  configs/runebench-attack-30m-adaptive.toml \
  --output outputs/runebench-attack-30m-adaptive-selection.json

OPENAI_API_KEY=... uv run --locked eval @ \
  configs/runebench-attack-30m-adaptive.toml \
  --output-dir outputs/runebench-attack-30m-adaptive-luna-xhigh
```

Do not start the 16-skill treatment until this exact canary has valid official
scorer evidence, confirmed service/process cleanup, and no controller or tracker
regression.

On a host that cannot hold multiple 8 GiB containers, run serially or partition
the explicit 16 task IDs across separate machines and output directories.
Multi-machine partitions must be disjoint, preserve the exact treatment, and be
combined only after every task has valid official evidence. Infrastructure
errors remain unscored rather than becoming zeroes.

### Preflight and dry-run

Resolve the exact immutable task selection and retain it for later reporting:

```sh
uv run --locked python scripts/preflight_suite.py \
  configs/runebench-woodcutting-15m-adaptive.toml \
  --output outputs/runebench-woodcutting-selection.json
```

This checks the dataset, catalog, task, image, evaluator, lock, source,
selection, and resource pins plus effective Docker memory without model
inference. It reserves 2 GiB beyond the selected containers and reports its
memory-only scope explicitly. The resulting JSON lists the exact selected IDs,
digests, and resource calculation.

Resolve the complete Verifiers execution without calling a model:

```sh
uv run --locked eval @ configs/runebench-woodcutting-15m-adaptive.toml --dry-run
```

Neither command is benchmark-performance evidence.

### Paid execution

Use a new output directory for every attempt. Run the smallest adaptive
treatment:

```sh
uv run --locked eval @ configs/runebench-woodcutting-15m-adaptive.toml \
  --model gpt-5.6-luna \
  --output-dir outputs/runebench-woodcutting-15m-adaptive-luna
```

Run the matched fresh baseline:

```sh
uv run --locked eval @ configs/runebench-woodcutting-15m-fresh.toml \
  --model gpt-5.6-luna \
  --output-dir outputs/runebench-woodcutting-15m-fresh-luna
```

`--model` overrides the model declared by the config without changing the task
or harness treatment. Keep the model, endpoint class, reasoning effort, token
limits, runtime resources, and rollout count fixed when comparing fresh and
adaptive modes.

The four-task sample, 16-task leaderboard full run, and exhaustive 32-task
selection use the same command shape:

```sh
uv run --locked eval @ configs/runebench-15m-sample-adaptive.toml \
  --output-dir outputs/runebench-15m-sample-adaptive

uv run --locked eval @ configs/runebench-leaderboard-full-adaptive.toml \
  --output-dir outputs/runebench-leaderboard-full-adaptive

uv run --locked eval @ configs/runebench-full-adaptive.toml \
  --output-dir outputs/runebench-full-adaptive
```

These are long paid runs. Start with one exact task and verify scoring and
cleanup before admitting a sample or full treatment.

### Observe an active run

Use a separate terminal for observation. The commands below are read-only and
do not create another game SDK controller.

Follow evaluator lifecycle events from the host:

```sh
RUN_DIR=outputs/runebench-leaderboard-full-adaptive
tail -n 100 -F "$RUN_DIR/eval.log"
```

This shows rollout and container starts, terminal rewards, turn counts, and stop
reasons. It does not show each model action. `traces.jsonl` is not a live action
stream: Verifiers appends a rollout trace after that rollout reaches a terminal
outcome.

List active rollout containers:

```sh
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
```

The container name is the rollout ID printed in `eval.log`. With concurrent
execution, each active task has its own container. Set the container to inspect:

```sh
CONTAINER=<rollout-id>
```

Read the latest committed Agencity actions and bounded results:

```sh
docker exec "$CONTAINER" \
  /opt/agencity/bin/bun /opt/agencity/src/cli.ts \
  history current --json \
  --workspace /app \
  --state-dir /tmp/agencity-eval/state \
  --artifacts /tmp/agencity-eval/artifacts \
  --profile /tmp/agencity-eval/profile.db |
  jq -r '
    "status=\(.status) cells=\(.cells | length)",
    (.cells[-5:][] |
      "[\(.status)] \(.code | split("\n")[0] |
        sub("^// Purpose: "; ""))\n  => \(
        (.result // .error // null) | @json
      )")
  '
```

Rerun that command when the cell count changes. The unfiltered history can be
large and can contain benchmark or model content; keep it local.
If it reports a service-authority conflict, the managed service has already
entered a fail-closed or otherwise ambiguous ownership state. Do not start
another service. Continue observing the entrypoint and tracker logs below; the
cleanup boundary will wait for the existing service to finish draining.

For high-frequency SDK actions, follow the entrypoint log inside that rollout:

```sh
docker exec "$CONTAINER" sh -lc \
  'tail -n 100 -F /tmp/agencity-runebench-entrypoint.log'
```

This includes gateway actions and results and is much noisier than retained
cell history. `docker logs "$CONTAINER"` is normally empty because the pinned
entrypoint redirects its output to the file above.

Check the current official-style peak rate by replacing `Attack` with the
capitalized task skill:

```sh
docker exec \
  -e TRACKING_FILE=/logs/tracking/skill_tracking.json \
  "$CONTAINER" \
  /opt/agencity/bin/bun \
  /app/benchmark/shared/check_xp_rate.ts Attack
```

The same exact `TRACKING_FILE` command is included in the model-facing task.
Managed trainer output is available through
`sdk.processes.readLogs(handle)`; the treatment does not use trainer logs under
`/tmp`.

Do not observe by starting another `BotSDK`, attaching a second controller, or
writing into the container. Competing controllers can disconnect or replace
the scored agent's live game connection.

### Custom task selections

RuneBench uses the shared deterministic selection contract:

```toml
[env.taskset.selection]
mode = "exact"
ids = ["woodcutting-xp-15m"]
```

Valid modes are `exact`, `ids`, `smoke`, `sample`, `shard`, and `all`. Use a
copied config for an experiment, keep its resolved config with the output, and
run preflight before inference. The immutable catalog is the authority for
available task IDs. `all` selects the 32 compatible tasks in catalog order.

## Runtime lifecycle

For each selected task and rollout, Verifiers:

1. creates a fresh ephemeral container from the pinned game image;
2. installs the config's pinned Agencity source and portable Bun;
3. stages the official character save and treatment `AGENTS.md`;
4. explicitly pauses or enables automatic learning;
5. starts the game, tracker, and bot and waits for readiness;
6. launches one fresh Agencity root through the Verifiers model-interception
   endpoint;
7. lets the root use the image SDK through its persistent Bun REPL and, after
   an explicit controller release, an owned managed trainer;
8. requests owned Agencity service shutdown, then waits up to 30 seconds for a
   stopped lifecycle even if the first request finds an already-draining
   authority conflict; confirmed shutdown stops managed process groups and
   records their terminal or unknown outcomes before portable state is removed;
9. finalizes the task and collects the official Harbor verifier evidence; and
10. removes the task container.

If service shutdown is not confirmed, portable state and lifecycle evidence
remain in the container, cleanup raises an infrastructure error, and scoring
does not proceed as though the trainer stopped cleanly. The outer Verifiers
runtime remains responsible for container teardown.

No Agencity profile, game save, REPL heap, or learned artifact is reused by the
next scored task.

## Outputs and reporting

An output directory contains at least:

- `config.toml` — the resolved non-secret evaluation config;
- `eval.log` — evaluator lifecycle and summary logs;
- `traces.jsonl` — the raw task, model, tool, usage, timing, outcome, and
  provenance trace.

The `eval` process waits for every selected task to reach a terminal evaluation
outcome. Results do not need to be extracted from the Agencity REPL or game
container. After task finalization, Verifiers writes the official reward or
typed infrastructure failure into `traces.jsonl`; the reporting command below
turns those records into one bounded summary.

Raw traces may contain model text, licensed benchmark content, or private client
headers. Keep them private and do not commit `outputs/`.

Create the scrubbed deterministic summary with the selection retained during
preflight:

```sh
uv run --locked python -m agencity_verifiers.reporting \
  outputs/runebench-woodcutting-15m-adaptive-luna \
  --selection outputs/runebench-woodcutting-selection.json \
  --output outputs/runebench-woodcutting-15m-adaptive-luna-summary.json
```

The summary distinguishes official scores, valid zeroes, partial rewards,
agent failures, provider failures, scorer or infrastructure errors,
cancellations, unknowns, skips, and incompatibilities. A displayed reward of
zero is not a valid RuneBench score when the trace reports a harness, cleanup,
or scorer error.

For the full leaderboard-comparable run, preflight and report against the exact
16-task selection:

```sh
uv run --locked python scripts/preflight_suite.py \
  configs/runebench-leaderboard-full-adaptive.toml \
  --output outputs/runebench-leaderboard-full-selection.json

uv run --locked python -m agencity_verifiers.reporting \
  outputs/runebench-leaderboard-full-adaptive \
  --selection outputs/runebench-leaderboard-full-selection.json \
  --output outputs/runebench-leaderboard-full-adaptive-summary.json
```

The bounded Agencity summary reports official task rewards and outcome classes;
it does not replace the leaderboard's 16-skill log-mean calculation or publish
results upstream. `configs/runebench-full-adaptive.toml` remains available when
the intended local experiment is the broader 32-task dataset rather than the
current website comparison.

## Verification and troubleshooting

Run the focused model-free suite:

```sh
uv run --locked python -m unittest tests.test_runebench
```

The broader benchmark project suite is:

```sh
uv run --locked python -m unittest discover -s tests
```

On August 19, 2026, the current working tree passed 97 of 98 model-free
benchmark tests; the one skip was the unrelated opt-in official SWE-bench Pro
Docker scorer. All six RuneBench preflights and all six RuneBench dry-runs
passed, the wheel and source distribution built, and the exact pinned-container
controller and tracker tests passed. No model inference ran.

Common conditions:

- provider credential missing: apply the saved-key and environment resolution
  order above before stopping. Prefer OpenAI; use the complete Vercel route
  override only when OpenAI is unavailable.
- Docker daemon unavailable or memory too low: start Docker and ensure it can
  grant the task container 8 GiB.
- AMD64 warning on an ARM Mac: expected for the pinned image and portable Bun.
- First run is slow: the dataset, image, Agencity source, and Bun may need to be
  downloaded.
- REPL epoch changed: live game objects were lost; reconnect from current
  inputs. Do not replay prior effectful cells automatically.
- `HarnessError`, missing scorer evidence, or cleanup failure: classify the
  attempt as infrastructure error, preserve the output, and do not report its
  displayed reward as a score.
- Operator interruption: the container is ephemeral, but there is no public
  durable cancellation or reconciliation receipt for unattended benchmark
  runs. Inspect the retained output and Docker state before retrying.

## Paid canary evidence

One paid Luna-xhigh Woodcutting 15-minute treatment using Agencity commit
`1b2cebf` produced an official score of `100.0` XP/min with successful scorer
evidence, service shutdown, and cleanup. The agent itself ended failed after 43
model calls because the then-current 800,000 cumulative input-token bound was
reached before a typed `finish`. That RuneBench limit has since been removed.
The run exposed the earlier direct treatment's competing control-mode SDK
connections, generated hot loop that ignored non-throwing `No tree found`
results, and mismatched rate-check path. The current model-free revision
addresses those defects, but the paid result predates the fixes and is not
evidence for them.

An earlier paid Luna canary against the direct-REPL working tree completed 33
model turns in one warm REPL epoch and exercised native game actions without a
credential-input rejection or console-worker loss. Its official scorer did not
run because owned-service shutdown was not confirmed within the harness's
cleanup bound, so the reported reward zero is an infrastructure error rather
than a benchmark score. Model-free tests, dry-runs, pinned-image startup, and
the direct SDK connection smoke remain setup evidence rather than
game-performance evidence.

A later Luna-xhigh Attack 30-minute treatment on commit `2d1b98f` reached a live
peak of `72` Attack XP/min but produced no official score. The outer 1,920-second
agent timeout interrupted the run after 95 root model calls plus two refinement
calls; the model never called typed `finish`, and task finalization and scoring
never started. A separate cleanup attempt then found the published service in
an authority-conflicted unhealthy or draining state. The retained output does
not distinguish an expired lease, a failed health probe, or another service
failure; the read-only observer only exposed the existing conflict.

The full trace showed that the same treatment guidance was present in both the
task and root instructions, the first 16 turns were spent resolving the combat
API without a successful baseline, automatic refinement ran before the first
non-zero rate, completed refinement handles added large repeated context, and
the model continued foreground actions instead of handing a proven loop to a
managed trainer. Per-step non-provider overhead also grew with branch history.
The current working tree waits for a confirmed stopped lifecycle after an
initial conflicted shutdown request, removes the duplicate treatment prompt,
adds a direct-SDK and managed-trainer quick start, identifies the `bot`/`rs`
receiver split, and directs proven loops into managed processes. These changes
have model-free coverage but no paid canary evidence. An inner benchmark
deadline, incremental long-run projections, bounded completed-refinement
context, and evidence-gated refinement remain required before another paid
canary.

## Current limitations

- Only the pinned 32-task skill dataset is supported.
- The official image is `linux/amd64`; ARM Macs use Docker emulation.
- Video capture remains enabled because it is part of the official image
  treatment.
- The controller, bounded action retry, active tracker command, managed trainer,
  draining-service cleanup, prompt de-duplication, and Docker-memory preflight
  have model-free coverage but no paid 30-minute canary on this revision.
- No paid 16-skill leaderboard-comparable run is verified.
- A full run is long, expensive, and operator-gated.
- RuneBench is noisy; one rollout is integration evidence, not a stable harness
  comparison.

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

The official task prompt describes an `execute_code` MCP wrapper that supplies
`bot` and `sdk` globals. Agencity instead imports the same image-owned
TypeScript SDK directly into its persistent Bun console:

```ts
const { BotSDK } = await import("/app/sdk/index.ts");
const { BotActions } = await import("/app/sdk/actions.ts");
const rs = new BotSDK({
  botUsername: "agent",
  password: "test",
  gatewayUrl: "ws://localhost:7780",
  autoLaunchBrowser: false,
});
await rs.connect();
const bot = new BotActions(rs);
```

The model constructs the image-owned `BotSDK` and `BotActions` itself. Agencity
does not classify an ordinary field such as RuneBench's local
`password: "test"` option as a secret. Only exact credential values registered
by the supervisor are rejected or redacted. No MCP process, protocol, or
connection wrapper is involved.

This adaptation is named `agencity-runebench-repl-v1`. It preserves the
official task package, initial save, game image, time horizon, 15-second sample
cadence, and Harbor verifier. It changes the agent-to-SDK interface, adds
explicit console guidance, and raises the runtime memory cap from the pinned
package's 4 GiB to 8 GiB. The current upstream generator made the same memory
change after documenting agent OOM failures at 4 GiB. The catalog and task
trace retain both memory values and both the original and adapted prompt
digests.

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

The adapted task and root `AGENTS.md` tell the model to:

- ignore the task's MCP instructions and use the image-owned TypeScript SDK;
- preserve Agencity's built-in `sdk` binding and name the game objects `rs` and
  `bot`;
- import and connect once, then reuse those live objects while the exact branch
  REPL epoch remains warm;
- begin with one short action and a small returned state summary;
- lengthen only a measured working loop;
- consult SDK, learning, and wiki files on demand rather than loading all of
  them into context;
- measure XP rate after each strategy; and
- move a proven long-running loop to a background process when training should
  continue during later model decisions.

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
Console calls from imported callbacks outside an active cell are no-ops, so a
background operation should write evidence to an explicit file or durable
surface when later inspection matters.

## Learning modes

Every scored task starts with a fresh Agencity workspace, profile database, and
game character.

- `fresh` explicitly pauses automatic learning before the root run and omits
  manual refinement guidance.
- `within-run` explicitly enables automatic learning before the root run and
  first requires a measured non-zero strategy. While a proven game loop runs in
  the background, the agent may request one focused governed refinement from
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
- `configs/runebench-full-adaptive.toml` — all 32 published skill tasks.

The committed configs use native OpenAI, `xhigh` reasoning, one rollout per
selected task, up to 5,000 model turns, and a 128,000-token per-response
ceiling. They deliberately omit cumulative input, output, and total-token
ceilings. The official 15- or 30-minute task horizon remains authoritative, so
elapsed task time normally terminates the rollout before the turn allowance.
This configuration does not bound provider spend; review the model and route
before any paid run.

### Preflight and dry-run

Resolve the exact immutable task selection and retain it for later reporting:

```sh
uv run --locked python scripts/preflight_suite.py \
  configs/runebench-woodcutting-15m-adaptive.toml \
  --output outputs/runebench-woodcutting-selection.json
```

This checks the dataset, catalog, task, image, evaluator, lock, source,
selection, and resource pins without model inference. The resulting JSON lists
the exact selected IDs and digests.

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

The four-task sample and 32-task full treatment use the same command shape:

```sh
uv run --locked eval @ configs/runebench-15m-sample-adaptive.toml \
  --output-dir outputs/runebench-15m-sample-adaptive

uv run --locked eval @ configs/runebench-full-adaptive.toml \
  --output-dir outputs/runebench-full-adaptive
```

These are long paid runs. Start with one exact task and verify scoring and
cleanup before admitting a sample or full treatment.

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
7. lets the root use the image SDK through its persistent Bun REPL;
8. requests owned Agencity service shutdown and removes portable state;
9. finalizes the task and collects the official Harbor verifier evidence; and
10. removes the task container.

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

For a full run, preflight and report against the full selection:

```sh
uv run --locked python scripts/preflight_suite.py \
  configs/runebench-full-adaptive.toml \
  --output outputs/runebench-full-selection.json

uv run --locked python -m agencity_verifiers.reporting \
  outputs/runebench-full-adaptive \
  --selection outputs/runebench-full-selection.json \
  --output outputs/runebench-full-adaptive-summary.json
```

## Verification and troubleshooting

Run the focused model-free suite:

```sh
uv run --locked python -m unittest tests.test_runebench
```

The broader benchmark project suite is:

```sh
uv run --locked python -m unittest discover -s tests
```

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

One paid Luna canary against the direct-REPL working tree completed 33 model
turns in one warm REPL epoch and exercised native game actions without a
credential-input rejection or console-worker loss. The official scorer did not
run because owned-service shutdown was not confirmed within the harness's
10-second cleanup bound, so the reported reward zero is an infrastructure error,
not a benchmark score. Model-free tests, dry-runs, pinned-image startup, and the
direct SDK connection smoke are setup evidence rather than game-performance
evidence.

## Current limitations

- Only the pinned 32-task skill dataset is supported.
- The official image is `linux/amd64`; ARM Macs use Docker emulation.
- Video capture remains enabled because it is part of the official image
  treatment.
- Owned service shutdown can miss the current 10-second harness cleanup bound;
  no valid paid RuneBench score is verified for this integration.
- A full run is long and expensive and remains operator-gated.
- RuneBench is noisy; one rollout is integration evidence, not a stable harness
  comparison.

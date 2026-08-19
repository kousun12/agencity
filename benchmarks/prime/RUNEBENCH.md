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

- `runebench-woodcutting-15m-fresh.toml` — matched direct-REPL baseline;
- `runebench-woodcutting-15m-adaptive.toml` — one within-run adaptive task;
- `runebench-15m-sample-adaptive.toml` — four fixed 15-minute skills;
- `runebench-full-adaptive.toml` — all 32 published skill tasks.

Preflight without model inference:

```sh
uv run --locked python scripts/preflight_suite.py \
  configs/runebench-woodcutting-15m-adaptive.toml
uv run --locked eval @ configs/runebench-woodcutting-15m-adaptive.toml --dry-run
```

Run one paid treatment only after reviewing the model, route, limits, and
expected cost:

```sh
export OPENAI_API_KEY=...
uv run --locked eval @ configs/runebench-woodcutting-15m-adaptive.toml \
  --model gpt-5.6-sol
```

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
- A full run is long and expensive and remains operator-gated.
- RuneBench is noisy; one rollout is integration evidence, not a stable harness
  comparison.

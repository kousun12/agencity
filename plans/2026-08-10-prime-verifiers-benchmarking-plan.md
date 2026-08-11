# Prime Verifiers benchmarking

**Status:** In progress; contract and OOLONG probes verified; independent hardened Terminal-Bench 2 and 2.1 Harbor treatments scored 1.0; SWE-bench Pro public remains a model-free evaluator-compatibility spike
**Date:** August 10, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related plans:** [Formal model tool contracts](./2026-08-07-formal-model-tool-contracts-plan.md), [Reasoning effort and model capabilities](./2026-08-07-reasoning-effort-and-model-capabilities-plan.md), and [Dynamic typed connectors](./2026-08-09-dynamic-typed-connectors-plan.md)

## Summary

Build a reproducible adapter that runs Agencity as a custom
[Prime Verifiers](https://docs.primeintellect.ai/verifiers/v1/harnesses) v1
harness. Prime supplies benchmark tasksets, model inference, rollout isolation,
trace capture, scoring, and aggregate reports. Agencity remains the program
under evaluation: it receives each task, calls the evaluation model through the
Verifiers interception endpoint, performs work through its normal durable
runtime, and emits one typed terminal result.

The first milestone is deliberately small:

1. pin a separate Python evaluation toolchain without changing Agencity's Bun
   runtime dependencies;
2. run one deterministic contract task through one Agencity rollout;
3. run one adapted answer task with one rollout and a low-cost model;
4. retain the exact harness revision, task, model, limits, trace, Agencity
   result, token usage, score, and cost evidence.

Long benchmark suites, concurrent rollouts, harness comparisons, and ARC-AGI-3
follow only after each preceding treatment is deterministic and bounded.

## Verified starting point

The following facts were checked against this repository, Prime's current
documentation, and the locally installed tools on August 10, 2026:

- Agencity exposes a linked `agencity` executable and a non-interactive
  `agencity run --json` route.
- A successful run prints the versioned `agencity.run-result` JSON envelope.
  Terminal statuses have distinct exit codes: success `0`, failed `1`, blocked
  `4`, budget exceeded `5`, unknown `7`, and cancelled `130`.
- Agencity's direct OpenAI and Anthropic transports accept bare endpoint origins
  through `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL`, then append the provider's
  `/v1` path.
- Stored Agencity credentials take precedence over environment credentials.
  Evaluation must therefore use an isolated profile and credential file so a
  developer's saved provider key cannot bypass Verifiers interception.
- The installed Prime CLI is authenticated and has evaluation, inference, and
  sandbox permissions. The account has a nonzero inference balance.
- The installed toolchain contains Prime CLI `0.6.21`, Verifiers `0.3.0`, and
  the Verifiers v1 `eval` and `init` entrypoints.
- Verifiers v1 models evaluation as a taskset, harness, environment, and
  runtime. A custom harness launches any executable through
  `Runtime.run_program`; model calls must use the supplied interception origin
  and bearer secret.
- The interception server exposes a bare origin and handles
  `/v1/chat/completions`, `/v1/responses`, and Anthropic Messages traffic. It
  replaces the request's model with the evaluation's pinned model before
  forwarding upstream.
- Verifiers can run a harness in a local subprocess, local Docker container, or
  Prime remote sandbox. Docker is available locally.
- The Agencity repository is public, but the package is private and has no
  registry release. Container and remote installation must pin and install an
  exact source revision rather than assume `npm`, JSR, or standalone binaries.
- Prime's Hub currently lists `primeintellect/gsm8k`,
  `primeintellect/terminal-bench-2`, and `primeintellect/arc-agi-3`.

These checks establish integration feasibility, not benchmark performance.

## Goals

- Evaluate the shipped Agencity autonomous path, including its fixed
  `bun_console` and `finish` model contract.
- Use Verifiers v1's composable taskset/harness/runtime model rather than
  embedding benchmark logic in Agencity.
- Make every reported score reproducible from pinned source, environment,
  model, sampling, limits, and rollout count.
- Keep evaluation model calls inside the Verifiers interception path so traces,
  usage, and cost belong to the evaluated rollout.
- Start with one rollout at concurrency one and explicit time, turn, token, and
  cost expectations.
- Preserve failed, blocked, budget-exceeded, unknown, cancelled, and
  infrastructure outcomes as distinct results.
- Support later side-by-side comparisons against Prime Agent and other
  harnesses on the same taskset and model.

## Non-goals

- Claim that Agencity outperforms Prime Agent or any native model harness before
  comparable repeated measurements exist.
- Treat an internal context-size benchmark as an external capability benchmark.
- Run the full ARC-AGI-3, Terminal-Bench, SWE-bench, or long-context suites in
  the first milestone.
- Publish an environment or start a hosted evaluation before local deterministic
  validation passes.
- Send model traffic through a developer's stored Vercel, OpenAI, or Anthropic
  key during a Prime Inference evaluation.
- Add Python as a production dependency of Agencity.
- Weaken Agencity's formal tool-call validation to satisfy a benchmark parser.
- Describe Prime's published Prime Agent results as independently reproduced.

## Terms

- **Taskset:** benchmark tasks, setup, controls, rewards, metrics, and scoring.
- **Harness:** the reusable program that drives the model while attempting a
  task. Agencity is this layer.
- **Runtime:** where the harness executes: subprocess, Docker, or a remote
  sandbox.
- **Interception endpoint:** Verifiers' per-rollout model proxy. It records model
  turns and forwards them to the evaluation model.
- **Rollout:** one independent attempt by one pinned harness and model on one
  task.
- **Harness result:** Agencity's exact `agencity.run-result` envelope, retained
  separately from Verifiers' model trace.

## Integration choice

Use Verifiers v1 as the primary integration surface.

The installed Prime toolchain also exposes `prime eval`, which remains useful
for legacy Hub environments, uploaded results, and hosted evaluations. The v1
`eval` entrypoint is the correct development surface for a reusable custom
Agencity harness because it directly composes:

```text
taskset × Agencity harness × runtime × model
```

The evaluation project belongs under `benchmarks/prime/` and owns its own
`pyproject.toml` and `uv.lock`. Root `bun install` and `bun run verify` must not
install Python evaluation dependencies.

## Harness contract

### One fresh agent per rollout

Every rollout creates a new Agencity root with `--new`. It must not resume a
workspace selection left by another rollout. The runtime work directory,
`.agencity` workspace state, profile database, credential file, service
manifest, and artifacts are rollout-local.

No harness-level prompt, memory, profile revision, or working value carries
between benchmark rollouts unless an experiment explicitly defines that
treatment and reports it separately.

### Model routing

The harness receives `endpoint`, `secret`, and `ctx.model` from Verifiers.

For an `openai/...` model, it launches Agencity with:

```text
OPENAI_BASE_URL=<interception origin>
OPENAI_API_KEY=<interception secret>
--model openai:<ctx.model>
```

For an `anthropic/...` model, it uses the corresponding Anthropic variables and
provider selection. Verifiers overrides the model field sent upstream with the
evaluation's pinned model, so Agencity's direct-provider native-ID conversion
does not change the evaluated model.

Other model namespaces require a tested generic OpenAI-compatible evaluation
transport. Agencity's Vercel Gateway transport uses the Gateway-specific
`/v4/ai` protocol and must not be pointed at Verifiers' `/v1` interception
service.

The harness refuses an unsupported model namespace before launching Agencity.
It never falls back to a different provider or direct credential.

### Credential isolation

Each rollout supplies an empty, private Agencity profile location. Only the
interception secret is exposed to the Agencity process, and only under the
provider variable selected for that rollout.

The harness does not forward:

- `AI_GATEWAY_API_KEY`;
- `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` from the host;
- Agencity's default `~/.agencity/auth.json`;
- unrelated Prime, ARC, GitHub, Turso, or cloud credentials.

The interception secret must not enter an Agencity event, artifact, result,
log, or committed fixture. Existing secret scrubbing remains active, but
isolation is the primary control.

### Prompt placement

The harness resolves the taskset's system and user prompts using Verifiers'
standard prompt resolution. It submits one bounded task string to Agencity.
Prompt conversion must remain explicit:

- plain string prompts are supported first;
- message-list, image, simulated-user, and MCP-backed prompts fail capability
  validation until implemented;
- benchmark instructions remain task data and cannot grant Agencity runtime
  authority.

### Terminal result

Agencity's final answer is not necessarily Verifiers' `Trace.last_reply`.
Agencity's model ends through a typed `finish` tool call, while many answer
tasksets score plain assistant text.

The harness therefore parses stdout as an exact `agencity.run-result` v1
envelope and writes a bounded `agencity-result.json` artifact into the rollout
runtime. The initial smoke taskset reads this artifact for its answer and status.

Status handling is:

- `succeeded`: valid semantic completion; expose `final` to the task scorer;
- `failed`, `blocked`, or `budget_exceeded`: valid harness execution but
  unsuccessful task attempt;
- `unknown`: valid uncertain outcome, scored separately from ordinary failure;
- `cancelled`: cancelled rollout;
- missing, malformed, duplicate, oversized, or contradictory result JSON:
  harness infrastructure error.

The adapter must not turn a non-success terminal status into success merely to
keep Verifiers running. It may return process exit `0` after durably recording a
recognized semantic failure so the taskset can assign zero reward without
misclassifying it as infrastructure failure.

### Limits

The first smoke configuration uses all of these Verifiers-side limits:

- one task;
- one rollout;
- concurrency one;
- model-turn cap;
- total-token cap;
- per-rollout wall-clock timeout;
- no whole-rollout retry;
- a low-cost model with published Prime pricing.

Verifiers limits are authoritative at the model proxy and runtime boundary.
Before expensive suites, Agencity also needs public per-run options for its
durable token, cost, turn, wall-time, and step limits. The current product CLI
does not expose all of those bounds, and its ordinary agent-run step ceiling is
128. This gap must be closed before unattended scale runs.

The CLI result envelope also omits run identity, aggregate budget state, and
per-call usage. The smoke therefore uses the Agencity envelope only for terminal
status, step count, and final answer; Verifiers' intercepted trace is the
authoritative source for model usage. Comparable cost-accounted suites require
a bounded benchmark runner or public snapshot/API adapter that returns both
Agencity budget evidence and Verifiers usage.

An outer process timeout is not sufficient cancellation evidence because the
managed Agencity service can outlive its initiating CLI process. Before
unattended suites, the adapter must request durable cancellation, reconcile the
terminal state, stop the rollout-local service, and report cleanup status before
the runtime is discarded.

### Evidence

Each retained run records or references:

- Agencity Git commit and dirty/clean state;
- evaluation package and lockfile digest;
- taskset ID and version;
- harness ID and version;
- runtime kind and image or sandbox configuration;
- model, endpoint class, sampling, reasoning effort, and declared pricing;
- task IDs, shuffle setting and seed;
- rollout count and concurrency;
- turn, token, time, retry, and Agencity limits;
- Verifiers trace and usage;
- exact Agencity result envelope;
- task rewards and harness metrics;
- total cost when Prime reports it;
- pass, fail, skip, cancellation, unknown, and infrastructure-error counts.

Uncommitted Agencity runs may be used for development but are labeled
non-comparable and never become a published baseline.

## Compatibility boundaries

### Initial support

The first adapter supports trusted plain-text tasks with no external tools or
simulated user. A custom contract taskset scores Agencity's retained result
artifact. A second small answer-task adapter proves ordinary exact-answer
scoring.

### Workspace-scored agent tasks

Tasksets such as Harbor or Terminal-Bench score files and commands in the
harness runtime rather than only the final assistant text. The first
Terminal-Bench 2 treatment selects one short fixed task and requires:

- Agencity installed inside the same task runtime;
- the task work directory exposed as Agencity's workspace;
- hidden tests withheld until scoring;
- container or Prime sandbox execution;
- task-authored resource and timeout preservation;
- proof that Agencity shutdown leaves the runtime available for the verifier.

Do not use the older Hub `primeintellect/terminal-bench-2` package as evidence
of harness interchangeability: that package pins its own Terminus2 composable
harness. Use a current v1 Harbor/Terminal-Bench taskset that permits an explicit
Agencity harness.

### MCP and simulated-user tasksets

Verifiers v1 can expose task tools through MCP and can run multi-agent or
simulated-user environments. Agencity does not currently accept arbitrary
Verifiers MCP endpoints as Console SDK connectors, so the harness declares
`SUPPORTS_MCP = False` initially.

Do not set a capability flag merely to pass environment admission. MCP-backed
benchmarks require the separately specified connector work and security review.

Multi-turn user simulation also remains unsupported initially. Supporting it
requires one Verifiers harness session to continue the same Agencity branch with
ordinary new runs while preserving exact external observations and stop
semantics.

### ARC-AGI-3

Prime's published `primeintellect/arc-agi-3@0.1.1` is a legacy Verifiers
`MultiTurnEnv`. It expects every assistant turn to be a plain JSON game action
and directly drives the official ARC API. Agencity requires exactly one
`bun_console` or `finish` tool call per autonomous model turn. Substituting the
Agencity executable into that legacy loop is therefore not a valid benchmark.

The eventual ARC path requires one of:

1. a Verifiers v1 ARC taskset whose action API is exposed to Agencity through a
   supported typed connector; or
2. a dedicated, reviewed environment adapter that translates between retained
   Agencity runs and ARC actions without bypassing either side's contracts.

ARC also requires a separate `ARC_API_KEY`, consumes live attempts, and can be
materially more expensive. No ARC run starts during the smoke milestone.

Prime Intellect reports Prime Agent ARC-AGI-3 results in its
[launch article](https://www.primeintellect.ai/blog/prime-agent), but the
published legacy environment and article do not by themselves provide a
complete Agencity-comparable reproduction bundle. Any future comparison must
pin the game set, prompt, action limit, model, reasoning effort, run count,
selection rule, token use, and scorecard evidence.

## Repository layout

[`benchmarks/prime/AUTHORING.md`](../benchmarks/prime/AUTHORING.md) is the
authoritative contract for new benchmark adapters. Workspace-scored coding tasks
are the primary next class; answer-only tasksets remain optional low-cost checks.

```text
benchmarks/prime/
├── AUTHORING.md
├── README.md
├── pyproject.toml
├── uv.lock
├── configs/
│   ├── smoke.toml
│   └── <benchmark>-{smoke,sample,full}.toml
├── agencity_verifiers/
│   ├── __init__.py
│   ├── harness.py
│   ├── result.py
│   └── taskset.py
├── agencity_<benchmark>/
│   ├── __init__.py
│   └── taskset.py
├── manifests/
├── scripts/
└── tests/
    ├── test_adapter.py
    └── test_<benchmark>.py
```

Generated evaluation outputs remain ignored and outside the committed fixture
tree. Only bounded, scrubbed summary evidence is promoted into public
verification documentation.

## Delivery phases

### Phase 0 — Pin and preflight

- Create the isolated Python project and lock Verifiers exactly.
- Add model-free tests for command construction, model-namespace refusal,
  credential isolation, result parsing, status mapping, size limits, and secret
  scrubbing.
- Validate the smoke TOML with `eval @ configs/smoke.toml --dry-run`.
- Confirm that no model request can reach a direct provider when the
  interception endpoint is unavailable.

### Phase 1 — One local contract rollout

- Add a one-task deterministic taskset and the minimal Agencity harness.
- Run in a local Docker runtime against one low-cost OpenAI-namespaced model.
- Use one rollout, concurrency one, no retries, and strict token/turn/time caps.
- Confirm one fresh Agencity root, one terminal result artifact, one Verifiers
  trace, one score, and recorded Prime usage.
- Repeat once with the same config to prove the route is stable; do not infer
  capability from this task.

### Phase 2 — One adapted answer sample

- Add an exact-answer task adapter that scores the Agencity result artifact.
- Run one sampled task and one rollout.
- Inspect the trace and result manually before increasing the sample.
- Increase to five tasks only when status mapping, scoring, usage, and cost all
  agree.

### Phase 3 — Reproducible harness comparison

- Run Agencity and one established Verifiers harness on the same task IDs,
  model, sampling, limits, runtime class, and rollout count.
- Use repeated rollouts where stochasticity matters.
- Report raw outcomes and confidence intervals; do not compare best-of-N with
  single-rollout results.
- Separate model cost, sandbox cost, wall time, and token use.

### Phase 4 — Agentic workspace benchmarks

- A current v1 Harbor/Terminal-Bench taskset selects the explicit `fix-git`
  task through a bounded manifest. It pins the Harbor dataset and complete
  task-tree digests, Verifiers and Harbor versions, task image digest, task
  workspace, Agencity source commit, Bun archive, and Python lockfile.
- The portable shared-harness path stages source and Bun without relying on
  task-image `apt-get`, Git, Node, or Bun; it keeps Agencity state outside the
  scored workspace, isolates and removes generated workspace metadata before
  scoring during finalization outside the agent timeout, and retains bounded
  terminal and cleanup metadata in the trace.
- Harbor stages its hidden verifier after Agencity exits and remains the sole
  scoring authority.
- Model-free selection, manifest, workspace, credential, verifier-isolation,
  result-mapping, cleanup, lock, build, and dry-run checks are required before
  the one-task paid probe.
- A completed one-task probe is integration evidence only. Any additional task,
  model change, concurrency increase, retry policy change, or full-suite run
  requires a separate approval.

### Phase 5 — Multi-turn and ARC readiness

- Implement and test required typed connector and harness-session support.
- Obtain explicit ARC credentials and confirm live-attempt policy.
- Reproduce a tiny non-claiming ARC integration sample.
- Define the full ARC protocol and comparison matrix before a scored suite.

## Initial smoke configuration

The repository smoke config is:

```toml
model = "openai/gpt-5.6-luna"
num_tasks = 1
num_rollouts = 1
max_concurrent = 1
push = false
rich = false

[sampling]
temperature = 0
max_tokens = 2048

[env.taskset]
id = "agencity-verifiers"

[env.agent]
max_turns = 4
max_total_tokens = 12000

[env.agent.timeout]
setup = 300
rollout = 300
finalize = 60
scoring = 60

[env.agent.retries]
max_retries = 0

[env.agent.harness]
id = "agencity-verifiers"
source_repo = "https://github.com/kousun12/agencity.git"
source_ref = "dbe1606fdf2ed390fa0815098c1014438fc740bf"

[env.agent.runtime]
type = "docker"
image = "oven/bun:1.3.14"
allow = []
block = ["*"]
cpu = 2
memory = 4
disk = 4
```

These fields resolve through the pinned Verifiers lock. `openai/gpt-5.6-luna`
is the smoke model because it is
OpenAI-namespaced, available through Prime Inference, materially cheaper than
the frontier models intended for later runs, and has completed the exact
formal-tool contract smoke. A cheaper model may replace it only after the same
smoke proves that model reliably emits Agencity's required formal calls.

### Local smoke procedure

From the repository root:

```sh
cd benchmarks/prime
uv sync --locked
uv run --locked python -m unittest discover -s tests -v
uv run --locked eval @ configs/smoke.toml --dry-run
uv run --locked eval @ configs/smoke.toml
```

The last command performs a paid one-rollout inference through the current
Prime login. It does not require an Agencity provider credential because the
harness routes the selected model through Verifiers' rollout interception
endpoint. Stop before that command if Prime authentication or credit is not
available. Development results remain local because `push = false`.

## Development smoke evidence

On August 10, 2026, the initial adapter was exercised locally with Verifiers
`0.3.0`, Docker image `oven/bun:1.3.14`, and Agencity source revision
`dbe1606fdf2ed390fa0815098c1014438fc740bf`.

- Seven model-free adapter tests passed.
- The committed TOML resolved through `eval --dry-run` with one task, one
  rollout, concurrency one, no upload, no whole-rollout retries, a four-turn
  cap, a 12,000-token cap, and framework-only execution networking.
- `openai/gpt-5.4-mini` reached the intercepted endpoint and returned formal
  tool calls, but repeatedly selected `bun_console` and attempted to invoke
  `finish` from inside TypeScript. The rollout ended at the four-turn Verifiers
  limit with Agencity status `failed`, reward `0`, and no infrastructure error.
  This is retained as model/harness compatibility evidence, not an adapter
  failure.
- `openai/gpt-5.6-luna` selected the provider-level `finish` tool on its first
  call. Agencity returned `succeeded` in one step with the exact expected final
  answer; Verifiers recorded reward `1`, `agent_completed`, 2,442 prompt tokens,
  46 completion tokens, and 16 reasoning tokens.
- Both development runs used an uncommitted adapter checkout and are therefore
  integration evidence only, not comparable benchmark baselines.

## OOLONG development evidence

On August 10, 2026, the adapter added a pinned Prime-style file-offloaded
OOLONG-synth taskset and configs for a 1K smoke, one-case Yahoo 128K probes, and
the full 50-case Yahoo 128K slice.

- Dataset revision `f0d59eaf0febf130664cfceb710436c8e3216b2b` resolved the
  Yahoo 128K selection to exactly 50 tasks over two context windows. A generated
  manifest retains every row ID and context digest without retaining the
  benchmark answers.
- The taskset writes context into the Agencity workspace, scores the bounded
  answer file or terminal `final` value with the official deterministic synth
  rules, and keeps recognized Agencity terminal failures distinct from
  infrastructure failures.
- One Luna 1K rollout completed in seven turns and scored `1.0`.
- One Luna Yahoo 128K rollout reached its 12-turn development limit while
  beginning recursive batch classification. It scored `0`.
- One Sol-high Yahoo 128K rollout launched 21 recursive classification shards
  and reached the 300,000-token development limit before terminal aggregation.
  It scored `0`, took about 22 minutes, and consumed $9.91 of Prime inference
  credit.
- With in-cell recursive-result aggregation and a 500,000-token ceiling, a
  second Sol-high Yahoo 128K rollout completed in 22 model calls and five
  Agencity steps. It used 397,293 total tokens, took about 22 minutes, returned
  the correct `Sports` answer, scored `1.0`, and consumed $3.85 of incremental
  Prime inference credit.
- The revised Luna Yahoo 128K sample completed in 12 model calls and nine
  Agencity steps. It used 62,973 total tokens, took about three minutes, returned
  `Society & Culture` instead of `Sports`, scored `0`, and consumed $0.37 of
  incremental Prime inference credit.

The successful Sol sample establishes the complete integration route, but one
task does not establish benchmark capability. Linear cost extrapolation is about
$193 for 50 Sol tasks before variance or failed work, so the full config remains
operator-gated. Luna is materially cheaper but did not solve this sampled task.

## Terminal-Bench 2 development evidence

On August 10, 2026, the repository added one bounded current-v1 Harbor
Terminal-Bench 2 treatment:

- the taskset pins Harbor dataset digest
  `sha256:c6fc2e2382c1dbae99b2d5ecd2f4f4a60c3c01e0d84642d69b4afd92e99d078b`
  and selects only `fix-git`, task digest
  `sha256:66be7179f07f1aa8f0d60f88800a883a68c1ffb7a349aae76aa60fa679485473`;
- the manifest pins the task `linux/amd64` image, work directory, Agencity
  revision, Bun archive, and Python lockfile;
- the portable harness passed setup and lifecycle checks in the pinned task
  image without `apt-get`, Git, Bun, or Node in that image;
- `uv lock --check`, 39 model-free tests, source and wheel builds,
  installed-wheel pin validation, source-distribution leak checks, dry-run
  configuration resolution, exact task loading, and complete task-tree
  integrity validation passed;
- the first paid attempt failed before model admission because its explicit
  state directory did not exist, made zero model calls, and did not reach
  Harbor scoring;
- an eight-call diagnostic rollout reached Harbor and scored `0` after
  generated `.agencity` metadata dirtied the worktree and Agencity reached its
  turn cap;
- the harness now rejects pre-existing task-owned `.agencity` metadata, hides
  only its generated marker from Git during execution, confirms managed-service
  shutdown, and removes generated metadata and rollout state during task
  finalization outside the agent timeout and before scoring;
- the final hardened bounded Luna-high rollout completed in eight calls and eight
  Agencity steps, reported `succeeded`, retained no errors, and received `1.0`
  from Harbor's upstream verifier.

The passing trace recorded 19,408 prompt tokens, 3,088 completion tokens, 11,320
cached input tokens, and 1,622 reasoning tokens. At the preflight list prices,
its undiscounted model-cost ceiling was $0.0379. The two failed attempts remain
infrastructure and treatment-debugging evidence. The passing run establishes
this one-task integration route only; it does not establish Terminal-Bench
performance or broader task compatibility.

## Terminal-Bench 2.1 development evidence

The repository contains a separate Terminal-Bench 2.1 taskset, manifest, and
sample configuration. It selects only the refreshed `fix-git` task from
`terminal-bench/terminal-bench-2-1` at dataset digest
`sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`.
The manifest pins task package digest
`sha256:16948b980df9d96de616a205f5acca1c5d395de83ff4f8ffabcafacb93226f2e`,
the complete Harbor-downloaded task-tree digest
`30aed800ba51d02a300800e34db211afa4a0ea9f4af098c628bdb8308facbfc8`,
the `linux/amd64` image digest, source/Bun/lock inputs, and the precise
treatment deviation.

The shared portable harness retains its existing state isolation, metadata
rejection, Git exclusion, shutdown confirmation, cleanup-before-scoring order,
and Verifiers interception route. The upstream Harbor verifier remains the
sole score source.

On August 10, 2026, lock validation, the 56-test model-free suite, source and
wheel builds, installed-wheel manifest/lock resolution, both dry-runs, exact
Harbor task loading, complete tree verification, and an actual portable setup
and cleanup lifecycle in the pinned 2.1 image passed. One attended Luna-high
rollout made seven model calls. It reported `succeeded`, completed seven
Agencity steps, recorded stopped-service and cleanup evidence, and received
upstream Harbor reward `1.0`. It reported 17,036 prompt tokens, 2,334
completion tokens, 8,490 cached input tokens, and 1,492 reasoning tokens. No
provider cost field was returned. The conservative twelve-window preflight at
the existing $1/M-input and $6/M-output list rates was $3.15. This is
single-task integration evidence only.

## SWE-bench Pro public adapter spike

The public SWE-bench Pro taskset pins one `future-architect/vuls` instance,
public dataset revision `7ab5114912baf22bb098818e604c02fe7ad2c11f`, repository
base revision, public-field selection digest, agent image digest, evaluator
repository commit, evaluator-tree digest, and Python lockfile. It constructs
the model prompt only from public issue, requirements, and interface materials.
Reference patches, test patches, official run scripts, parser scripts, and
evaluator output remain outside agent prompt and task data.

The feasibility audit found that the official evaluator's local-Docker route
derives and pulls a mutable Docker Hub tag from the dataset row. It supplies no
immutable digest override. The original task image also retains Git history
that can recover withheld tests, and the shared one-runtime harness has no
verified sanitized-agent/fresh-scorer split. The adapter therefore fails before
model admission instead of altering the evaluator or using a non-equivalent or
hidden-test-exposing treatment. Model-free manifest, prompt-isolation,
evidence-shape, wheel/sdist, task-loading, and dry-run checks pass. No
SWE-bench Pro paid attempt, official reward, or performance result is present.

Verifiers evaluates the committed turn and token limits between calls, so they
are bounded trajectory controls rather than a hard billed-dollar admission
limit. Paid runs remain attended and require a provider-window worst-case cost
estimate plus an operator-approved budget. Generated resolved configuration is
private local evidence because it can contain client account headers.

## Verification and reporting rules

- Run model-free tests before every paid smoke.
- Show the resolved config before launch.
- Record wallet balance only as an operator preflight; never commit account
  identity, balance, billing rows, or secrets.
- A skipped or blocked external check remains skipped or blocked.
- A completed rollout with malformed scoring evidence is invalid, not zero.
- A recognized Agencity semantic failure may score zero but is not an
  infrastructure error.
- A provider or sandbox outage is not evidence about harness capability.
- Uploading results is opt-in during development.
- Hosted runs require a published, pinned environment and a separate local to
  hosted parity check.
- No large run starts without an estimated maximum model cost and an explicit
  operator-approved cap.

## Completion criteria

The initial benchmarking path is complete when:

1. the evaluation project installs from its lockfile without changing the Bun
   product install;
2. model-free adapter tests pass;
3. dry-run validation resolves the exact taskset, harness, runtime, and limits;
4. one Docker contract rollout reaches only the Verifiers interception endpoint;
5. its Agencity terminal result, Verifiers trace and usage, score, and any
   Prime-reported cost evidence are internally consistent;
6. one adapted answer sample scores from the exact Agencity final result;
7. rerunning the same smoke configuration creates isolated state and no resumed
   agent identity;
8. malformed output, missing interception, timeout, blocked, budget-exceeded,
   unknown, and cancellation paths remain distinct;
9. public verification documentation records the smoke as integration evidence,
   not a capability claim; and
10. ARC-AGI-3, MCP, simulated-user, hosted, and large-suite limitations remain
    explicit until separately verified.

## References

- Prime Intellect, [Evaluating Environments](https://docs.primeintellect.ai/tutorials-environments/evaluating)
- Prime Intellect, [Hosted Evaluations](https://docs.primeintellect.ai/tutorials-environments/hosted-evaluations)
- Prime Verifiers v1, [Harnesses](https://docs.primeintellect.ai/verifiers/v1/harnesses)
- Prime Verifiers v1, [Tasksets](https://docs.primeintellect.ai/verifiers/v1/tasksets)
- Prime Verifiers v1, [Evaluation](https://docs.primeintellect.ai/verifiers/v1/evaluation)
- Prime Intellect, [Prime Agent launch article](https://www.primeintellect.ai/blog/prime-agent)

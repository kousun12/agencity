# Authoring Agencity benchmarks

This document defines how to add reproducible Prime Verifiers benchmarks for
Agencity. It is the source of truth for benchmark structure, validation,
evidence, and repository hygiene. Benchmark-specific runbooks may add stricter
requirements but must not weaken these rules.

## Priority

Workspace-scored coding tasks are the primary benchmark class.

These tasks evaluate whether Agencity can inspect a repository, modify files,
run tools, manage long-lived work, and leave a workspace that passes an
independent verifier. They exercise more of the product than answer-only
questions and are the strongest basis for public claims about Agencity as an
autonomous coding agent.

Answer-scored tasks may be added later for low-cost integration checks, model
routing tests, or narrow reasoning measurements. They are useful diagnostics,
but they are not the main product benchmark.

Interactive action environments, simulated users, MCP-backed tasks, and
multi-agent environments require separate capability work. The current harness
must not advertise those capabilities until their contracts are implemented and
tested.

## Benchmark classes

### Workspace-scored coding tasks

The evaluator prepares a disposable workspace containing the public task
materials. Agencity works in that directory. After Agencity reaches a terminal
outcome, an independent verifier inspects the resulting workspace and computes
the reward.

Examples include repository repair, implementation tasks, Terminal-Bench-style
terminal work, Harbor tasksets, emulator construction, and kernel-writing
benchmarks.

The authoritative output is the verified workspace state, not the final
assistant text.

### File-context tasks

The evaluator writes a large immutable input into the workspace and scores a
small answer or output artifact. OOLONG is the current example. This class
exercises programmatic context processing but does not prove repository-editing
capability.

### Answer-scored tasks

The evaluator supplies a prompt and scores Agencity's terminal `final` value.
This class is suitable for inexpensive contract checks and may later support
datasets such as GSM8K. It is deferred until a concrete need justifies a shared
adapter.

### Interactive action tasks

The benchmark exposes an action API and returns observations over multiple
turns. ARC-AGI-3 and game environments belong here. They require a typed
connector or resumable harness-session contract and are not interchangeable
with workspace-scored tasks.

## Component ownership

Keep benchmark semantics in the narrowest responsible component.

### Taskset

The taskset owns:

- dataset loading and exact revision selection;
- task identity and deterministic ordering;
- public workspace setup;
- benchmark-specific prompt material;
- task resources and timeout overrides;
- final workspace validation and reward computation;
- benchmark-specific metrics;
- task manifests and source-data integrity checks.

### Agencity harness

The reusable harness owns:

- installation of one pinned Agencity revision;
- one fresh root session and isolated Agencity state per rollout;
- model routing through Verifiers interception;
- provider credential isolation;
- conversion of task prompts into one Agencity run;
- exact parsing of `agencity.run-result`;
- terminal-state preservation;
- cancellation, service shutdown, and cleanup when supported;
- bounded harness metadata.

Do not add benchmark-specific scoring, hidden answers, repository fixes, or
solution strategies to the shared harness.

Harness-specific workspace preparation and cleanup belong in an explicit
treatment boundary. A reusable task may call capability-named lifecycle hooks
such as `prepare_task_workspace` and `finalize_task_workspace`; it must not
assume every harness creates Agencity state. This permits the same task and
official scorer to run with another Verifiers-compatible coding harness.

### Runtime

The runtime owns:

- filesystem and process isolation;
- the base image and available language/toolchain binaries;
- CPU, memory, disk, timeout, and network enforcement;
- preservation of the workspace until scoring completes.

Use an immutable image digest for comparable runs. A mutable image tag is
acceptable only during initial development and must not appear in a published
baseline.

### Verifiers interception

The interception layer owns model-call traces and proxy-side turn and token
limits. Every evaluated model call, including recursive and child work, must use
the rollout's endpoint and secret. A direct provider fallback invalidates the
rollout.

Provider route, wire model ID, and Agencity model identity are distinct pins.
For native OpenAI, Verifiers sends an unprefixed ID such as `gpt-5.6-sol`; for
Vercel AI Gateway's OpenAI-compatible endpoint it sends the creator-qualified
`openai/gpt-5.6-sol`. The harness maps both to Agencity's canonical
`openai/gpt-5.6-sol` identity behind interception. A route change must update the
client base URL, credential-variable name, and wire model ID together, retain
the non-secret route in provenance, and pass an exact canary before a larger
treatment. Never copy a host provider credential into the task runtime.

## Workspace-scored lifecycle

A workspace benchmark follows this sequence:

1. Resolve the exact taskset, dataset revision, task manifest, Agencity
   revision, model, sampling, runtime image, and limits.
2. Create a fresh runtime and task workspace.
3. Materialize only the task materials the agent is authorized to inspect.
4. Start Agencity with `--new`, rollout-local state, and the task workspace as
   its workspace.
5. Route every model call through Verifiers interception.
6. Let Agencity reach a typed terminal state or an explicit outer limit.
7. Stop or reconcile rollout-local Agencity work before scoring.
8. Remove only harness-generated workspace metadata, preserving task-owned
   files and the agent's scored changes.
9. Run the independent verifier against the resulting workspace.
10. Record reward, task metrics, terminal status, usage, timing, cleanup status,
   and source pins.
11. Dispose of the runtime and generated workspace.

The verifier must run after agent execution. Agencity is trusted-local code with
the runtime process's operating-system authority. Hidden tests placed anywhere
the agent can inspect are not hidden. Use a separate verifier phase, a separate
runtime, or post-agent injection when the benchmark requires withheld tests.
When the entire agent runtime must be destroyed before host-side scoring, use a
custom Verifiers v1 `Env` to enforce that ordering. A task finalizer alone is
not sufficient if the framework retains the runtime through reward evaluation.
If runtime teardown can fail, require a teardown receipt before scoring or
document that the framework logs teardown failure without exposing it to the
environment. The current Verifiers API provides ordering but not that receipt.

## Repository layout

Use one importable taskset package per benchmark plugin:

```text
benchmarks/prime/
├── AUTHORING.md
├── README.md
├── pyproject.toml
├── uv.lock
├── agencity_verifiers/
│   ├── harbor_suite.py
│   ├── harness.py
│   ├── reporting.py
│   ├── result.py
│   └── selection.py
├── agencity_<benchmark>/
│   ├── __init__.py
│   └── taskset.py
├── configs/
│   ├── <benchmark>-smoke.toml
│   ├── <benchmark>-sample.toml
│   └── <benchmark>-full.toml
├── manifests/
│   └── <benchmark>-<selection>.json
├── scripts/
│   └── preflight_<benchmark>.py
└── tests/
    └── test_<benchmark>.py
```

The package `__init__.py` exports exactly one taskset class and may also export
one benchmark-specific `Env` subclass when scoring requires multi-stage control
flow. Keep shared Agencity execution behavior in `agencity_verifiers`; keep
benchmark rules in the benchmark package.

## Deterministic suite selection

Suite-capable tasksets use the shared `SelectionSpec` contract:

- `exact` selects one ID;
- `ids` selects an explicit ordered ID list;
- `smoke` selects a catalog-defined named subset;
- `sample` selects a deterministic count from a retained seed;
- `shard` assigns all compatible IDs through stable hashing;
- `all` selects every compatible catalog entry.

Partial and full runs use the same task class, workspace setup, lifecycle, and
scorer. A smoke config is a selection, not a separate weakened adapter.

Catalog-backed tasksets must:

- enumerate every task in the pinned source dataset;
- retain canonical task ordering and a digest over canonical task entries;
- record `compatible` for every entry;
- retain structured reason codes and details for every incompatible entry;
- reject unknown or incompatible explicit IDs before model admission;
- pin task source, complete task tree where applicable, immutable image manifest
  and config, workdir, evaluator assets, and lockfile;
- expose named smoke subsets as IDs from the same catalog; and
- support preflight selection and pin validation without pulling every image.

Dynamic datasets such as OOLONG may select after predicate-pushed loading only
when a packaged immutable manifest is an admission check over exact task order
and permitted content identities. The selected IDs and digest must also be
retained in each task trace. A script that only emits a manifest is not a
runtime integrity boundary.

## Authoring workflow

### 1. Audit the benchmark

Before writing code, record:

- authoritative repository, paper, dataset, and documentation;
- benchmark version and active maintenance status;
- license and redistribution constraints for code, data, fixtures, and outputs;
- task count, splits, subsets, and official metrics;
- prompt and workspace treatment;
- expected runtime, tools, network, and credentials;
- official scoring implementation;
- known contamination, hidden-test, and reward-hacking risks;
- whether the published environment permits a custom harness.

A legacy environment that owns its model loop or pins another harness is not
evidence that Agencity can be substituted safely. Port the task semantics into a
reviewed v1 taskset or use a current harness-independent taskset.

### 2. Declare the treatment

State exactly what is being evaluated:

- direct prompt, file context, or repository workspace;
- visible files and unavailable hidden materials;
- model and reasoning effort;
- allowed tools and network;
- completion requirements;
- scoring metric;
- deviations from the official benchmark.

Any harness-specific prompt, helper, skill, or context placement is part of the
treatment and must be retained. Do not label an adapted treatment as an exact
reproduction.

### 3. Pin reproducible inputs

Pin:

- Agencity Git commit;
- taskset source or package version;
- dataset revision;
- selected task IDs and deterministic order;
- container image digest;
- Python lockfile;
- model ID and endpoint class;
- sampling and reasoning settings;
- turn, token, time, retry, CPU, memory, disk, and network limits.

Create a bounded task manifest containing IDs, revisions, and content digests.
Do not put full licensed datasets, hidden answers, or secrets in the manifest.
Generate catalogs with a reviewed script. A hand-edited catalog is not
acceptable unless the generation source is unavailable and every entry has an
independent integrity check.

### 4. Implement setup and scoring

For a workspace task:

- create the workspace from immutable task inputs;
- verify source digests before admission;
- verify the complete selected task tree when a framework reuses a mutable
  local cache; checking only task metadata does not protect verifier,
  instruction, environment, or solution files;
- set the task work directory explicitly;
- expose only authorized public materials;
- keep databases, artifacts, bootstrap files, and service state outside the
  scored workspace;
- account for Agencity's `.agencity` identity marker: reject pre-existing
  task-owned metadata rather than overwriting it, keep the generated marker
  from contaminating Git-based decisions, and remove only the generated marker
  after service shutdown and before scoring;
- run the official deterministic verifier when available;
- verify that the official evaluator can consume the treatment's immutable
  image or environment identity. If it only resolves mutable tags, an adapter
  may use the unmodified evaluator's documented local-image fallback only when
  it verifies the immutable image first, makes remote resolution impossible,
  and re-verifies image identity after scoring. Otherwise implement a
  model-free adapter spike that rejects before model admission. Do not patch the
  evaluator or substitute a non-equivalent scorer merely to obtain a rollout;
- inspect the agent image for retained Git history, test commits, evaluator
  files, and other withheld material. A two-stage treatment must prove that the
  agent sees only an authorized base tree in a new history, that withheld
  commits are unresolved, that patch content remains private, that runtime
  teardown is ordered before official scoring and has a receipt when the
  framework supports one, and that scorer files, containers, aliases, and
  temporary state are removed;
- retain verifier stdout and stderr only through bounded summaries or
  non-versioned raw outputs;
- treat missing verifier dependencies and malformed evidence as infrastructure
  errors, not zero reward;
- score recognized Agencity task failures as task outcomes without changing
  their terminal status.

Do not score success from the agent's claim that tests passed.

### 5. Add the configuration ladder

Every benchmark has separate configurations:

1. **Dry run:** resolves package, harness, runtime, and limits without model
   inference.
2. **Synthetic smoke:** exercises setup and scoring with a tiny committed
   fixture where practical.
3. **One real task:** uses a known-short task and a low-cost compatible model.
4. **Target-model sample:** uses one to five fixed tasks with the intended
   model and full treatment.
5. **Full run:** contains the complete selected task set and remains
   operator-gated.

Also provide a stable shard config for suites intended to run in parallel.
Every committed suite config must pass both Verifiers `--dry-run` and the
model-free selection preflight.

Development configs use concurrency one, no whole-rollout retries, and
`push = false`. Increase concurrency only after one-task cleanup, timing, usage,
and scoring agree.

### 6. Test without model inference

At minimum, test:

- exact task selection and ordering;
- manifest and digest validation;
- workspace setup;
- generated workspace-metadata isolation and cleanup;
- no hidden material in the agent-visible workspace;
- official scorer success and failure fixtures;
- malformed and missing verifier evidence;
- every Agencity terminal status;
- result/exit-code disagreement;
- prompt and path handling for untrusted task text;
- provider namespace refusal and credential isolation;
- runtime network policy;
- cleanup behavior;
- bounded trace metadata with no secrets or full restricted inputs.

The benchmark package must build from `uv.lock`, all unit tests must pass, and
every committed config must resolve with `eval --dry-run`. Source distributions
must exclude local caches, outputs, virtual environments, task solutions, and
held-out verifier material; inspect built archive contents in an automated
test.

### 7. Run paid probes

Before each paid increase:

- inspect current wallet balance and pricing;
- calculate a conservative maximum from per-rollout limits;
- obtain explicit operator approval for the next cost tier;
- run only the next rung in the ladder;
- inspect raw traces locally;
- update bounded evidence;
- stop on unexplained score, cost, usage, timeout, cleanup, or routing behavior.

Treat turn and token thresholds according to their actual enforcement point.
Limits checked between calls can overshoot once and are not a hard
billed-dollar cap. Use a provider-window worst-case estimate, an approved
operator budget, and attended execution until a pre-request cost admission
control exists. Resolved configurations may contain private client headers and
must remain ignored local evidence or be scrubbed before sharing.

One successful task establishes integration, not benchmark performance.

### 8. Compare harnesses fairly

Public harness comparisons use:

- identical task IDs and order;
- identical model snapshot and endpoint class;
- identical reasoning and sampling;
- equivalent runtime resources and network;
- equivalent outer limits;
- the same verifier;
- the same rollout count and selection rule.

Report all attempted tasks and separate successful, zero-score, blocked, failed,
budget-exceeded, unknown, cancelled, and infrastructure-error outcomes. Do not
compare a best-of-N result with a single rollout or omit failed attempts.

Use `agencity_verifiers.reporting` or an equivalent versioned report contract.
The report must state:

- pass, valid-zero, partial, harness-failure, provider-failure,
  scorer/infrastructure-error, cancellation, unknown, skipped, and incompatible
  counts;
- reward sum, denominator, mean, and whether unscored failures enter that
  denominator;
- model calls, provider-reported tokens, timing, and cost when supplied;
- exact config and selection digests; and
- bounded model, harness, runtime, evaluator, source, image, and lock
  provenance.

Never map missing or malformed scorer evidence to zero. Never average
infrastructure errors into reward without an explicit published failure policy.

## Public evidence

A publishable result records:

- benchmark name, version, treatment, and deviations;
- Agencity and adapter commits;
- taskset, dataset, image, lockfile, and manifest digests;
- exact config;
- task count and rollout count;
- aggregate and per-task rewards;
- model calls, tokens, cost, and elapsed time;
- terminal-state and infrastructure-error counts;
- cleanup and verifier status;
- comparison methodology;
- known limitations.

Promote only bounded, scrubbed summaries into version control. Raw traces remain
local or in an access-controlled result store because they may contain licensed
task data, hidden answers, model reasoning, credentials, or very large outputs.

## Version-control policy

### Keep in Git

Commit:

- authoring and benchmark runbooks;
- taskset, harness, scorer, and preflight source;
- tests and small synthetic fixtures;
- `pyproject.toml` and `uv.lock`;
- Dockerfiles and immutable image references;
- smoke, sample, and operator-gated full configs;
- dataset, source, and task-selection revisions;
- bounded manifests containing task IDs and digests;
- public benchmark/verifier source only when its license permits vendoring;
- bounded scrubbed evidence summaries used to support repository claims;
- license notices and upstream source links.

Prefer pinning an upstream package, commit, or dataset revision over vendoring a
third-party benchmark. Vendor only when the license permits it and an immutable
local copy is required for auditability.

### Keep out of Git

Ignore:

- Python virtual environments and package build output;
- Hugging Face, model, package-manager, and benchmark caches;
- downloaded datasets and full long-context inputs;
- temporary repository clones and generated task workspaces;
- raw Verifiers output directories, traces, logs, and replay files;
- Agencity workspace databases, profile databases, service manifests, and
  artifact stores;
- container layers and extracted images;
- credentials, auth files, wallet details, API keys, and `.env` files;
- private or license-restricted benchmark data;
- hidden tests, private reference implementations, and held-out answers;
- unbounded model outputs and local analysis notebooks derived from raw traces.

If an output is needed for a public claim, derive a small scrubbed evidence
record with source run IDs and digests. Do not commit the raw output merely
because it is evidence.

## Automation

This document remains authoritative if scaffolding or an agent skill is added.
Automation may create packages, configs, manifests, and tests, but it must not:

- choose or reinterpret a benchmark silently;
- weaken capability checks;
- start paid inference without explicit approval;
- start a full run directly;
- publish results automatically;
- turn skipped, failed, or incomplete external checks into verified claims.

A scaffold becomes worthwhile after a second workspace-scored benchmark proves
which package and configuration fields are genuinely shared. A repository-local
agent skill may then automate the same documented workflow; it is a convenience,
not the specification.

## References

- [Prime Verifiers v1 tasksets](https://docs.primeintellect.ai/verifiers/v1/tasksets)
- [Prime Verifiers v1 harnesses](https://docs.primeintellect.ai/verifiers/v1/harnesses)
- [Prime Verifiers v1 evaluation](https://docs.primeintellect.ai/verifiers/v1/evaluation)
- [Benchmark runbook](./README.md)
- [Repository verification guide](../../docs/verification.md)

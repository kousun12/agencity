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
8. Run the independent verifier against the resulting workspace.
9. Record reward, task metrics, terminal status, usage, timing, cleanup status,
   and source pins.
10. Dispose of the runtime and generated workspace.

The verifier must run after agent execution. Agencity is trusted-local code with
the runtime process's operating-system authority. Hidden tests placed anywhere
the agent can inspect are not hidden. Use a separate verifier phase, a separate
runtime, or post-agent injection when the benchmark requires withheld tests.

## Repository layout

Use one importable taskset package per benchmark plugin:

```text
benchmarks/prime/
├── AUTHORING.md
├── README.md
├── pyproject.toml
├── uv.lock
├── agencity_verifiers/
│   ├── harness.py
│   └── result.py
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

The package `__init__.py` exports exactly one taskset class. Keep shared
Agencity execution behavior in `agencity_verifiers`; keep benchmark rules in the
benchmark package.

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

### 4. Implement setup and scoring

For a workspace task:

- create the workspace from immutable task inputs;
- verify source digests before admission;
- set the task work directory explicitly;
- expose only authorized public materials;
- run the official deterministic verifier when available;
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

Development configs use concurrency one, no whole-rollout retries, and
`push = false`. Increase concurrency only after one-task cleanup, timing, usage,
and scoring agree.

### 6. Test without model inference

At minimum, test:

- exact task selection and ordering;
- manifest and digest validation;
- workspace setup;
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
every committed config must resolve with `eval --dry-run`.

### 7. Run paid probes

Before each paid increase:

- inspect current wallet balance and pricing;
- calculate a conservative maximum from per-rollout limits;
- obtain explicit operator approval for the next cost tier;
- run only the next rung in the ladder;
- inspect raw traces locally;
- update bounded evidence;
- stop on unexplained score, cost, usage, timeout, cleanup, or routing behavior.

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

"""Pinned RuneBench skill tasks adapted to Agencity's persistent Bun console."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Literal

from pydantic import model_validator
import verifiers.v1 as vf
from verifiers.v1.tasksets.harbor import HarborTaskset

from agencity_verifiers.harbor_suite import (
    HarborSuiteConfig,
    HarborSuiteData,
    HarborSuiteTask,
    _sha256_file,
    _sha256_tree,
    _validate_catalog_runtime,
)
from agencity_verifiers.selection import (
    catalog_digest,
    load_catalog,
    select_catalog_tasks,
)


BENCHMARK = "runebench"
DATASET = (
    "maxbittker/runebench@"
    "sha256:4bb3430af2ef3a320bd3dfeeab2447fbf9e0093452ad747997186a85a060de28"
)
TREATMENT = "agencity-runebench-repl-v2"
SOURCE_CATALOG_PATH = (
    Path(__file__).resolve().parent.parent / "manifests" / "runebench-catalog.json"
)
SOURCE_LOCK_PATH = Path(__file__).resolve().parent.parent / "uv.lock"
PACKAGED_DATA_PATH = Path(__file__).resolve().parent / "data"
PACKAGED_LOCK_PATH = (
    Path(__file__).resolve().parent.parent
    / "agencity_terminal_bench_2"
    / "data"
    / "uv.lock"
)
CATALOG_PATH = (
    SOURCE_CATALOG_PATH
    if SOURCE_CATALOG_PATH.is_file()
    else PACKAGED_DATA_PATH / "catalog.json"
)
LOCK_PATH = (
    SOURCE_LOCK_PATH
    if SOURCE_LOCK_PATH.is_file()
    else PACKAGED_LOCK_PATH
)

LearningMode = Literal["fresh", "within-run"]

TREATMENT_DIR = "/app/agencity-runebench"
CONTROLLER_PATH = f"{TREATMENT_DIR}/controller.ts"
COMPLETION_GATE_PATH = f"{TREATMENT_DIR}/check-completion.ts"
TRAINER_DIR = f"{TREATMENT_DIR}/trainers"
TRACKING_FILE = "/logs/tracking/skill_tracking.json"
RUNEBENCH_CONSOLE_RSS_RECYCLE_BYTES = 1536 * 1024 * 1024
RATE_COMMAND_TEMPLATE = (
    f"TRACKING_FILE={TRACKING_FILE} "
    "bun /app/benchmark/shared/check_xp_rate.ts {skill}"
)
SCORED_SKILL_TOKEN = "__RUNEBENCH_SCORED_SKILL__"
SCORED_SKILL_SLUG_TOKEN = "__RUNEBENCH_SCORED_SKILL_SLUG__"

CONTROLLER_SOURCE = r"""import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { BotSDK } from "/app/sdk/index.ts";
import { BotActions } from "/app/sdk/actions.ts";

const LOCK_DIR = "/app/agencity-runebench/controller.lock";
const CLAIM_PATH = `${LOCK_DIR}/claim.json`;
const CLAIM_SCHEMA = "agencity.runebench-controller-claim.v1";
const MIN_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5_000;

type Claim = {
  schema: typeof CLAIM_SCHEMA;
  owner: string;
  pid: number;
  processStartTime: string;
  token: string;
  createdAt: string;
};

export type ActionResult = {
  success?: boolean;
  message?: string;
  [key: string]: unknown;
};

export type ActionAttempt<T> =
  | { ok: true; attempt: number; result: T }
  | {
      ok: false;
      attempt: number;
      failureCount: number;
      kind: "reported_failure" | "invalid_result" | "threw";
      result?: T;
      error?: string;
    };

export type ActionLoopOptions<T> = {
  action: () => Promise<T>;
  iterations: number;
  onAttempt?: (attempt: ActionAttempt<T>) => Promise<void> | void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  successDelayMs?: number;
  maxConsecutiveFailures?: number;
};

export type MeasuredActionLoopOptions<T> = ActionLoopOptions<T> & {
  measure: () => Promise<number> | number;
};

export type MeasuredActionLoopSummary = {
  requested: number;
  attempted: number;
  accepted: number;
  succeeded: number;
  failed: number;
  reportedFailures: number;
  invalidResults: number;
  threw: number;
  failureRate: number;
  stopReason: "iterations_completed" | "consecutive_failures";
  elapsedMs: number;
  metric: {
    before: number;
    after: number;
    delta: number;
  };
  lastFailure: {
    attempt: number;
    kind: "reported_failure" | "invalid_result" | "threw";
    error: string | null;
    message: string | null;
    reason: string | null;
  } | null;
};

type ControllerLease = {
  readonly owner: string;
  readonly claim: Readonly<Claim>;
  release(): Promise<void>;
};

let activeController: RuneBenchController | undefined;

function processIdentity(pid: number): Promise<{
  state: string;
  startTime: string;
}> {
  return readFile(`/proc/${pid}/stat`, "utf8").then((value) => {
    const close = value.lastIndexOf(")");
    const fields = value.slice(close + 2).trim().split(/\s+/);
    const state = fields[0];
    const startTime = fields[19];
    if (!state || !startTime) {
      throw new Error(`cannot read process identity for pid ${pid}`);
    }
    return { state, startTime };
  });
}

function processStartTime(pid: number): Promise<string> {
  return processIdentity(pid).then((identity) => identity.startTime);
}

async function claimIsLive(claim: Claim): Promise<boolean> {
  if (
    claim.schema !== CLAIM_SCHEMA ||
    !Number.isInteger(claim.pid) ||
    claim.pid <= 0 ||
    !claim.processStartTime
  ) {
    return false;
  }
  try {
    const identity = await processIdentity(claim.pid);
    return !["Z", "X"].includes(identity.state) &&
      identity.startTime === claim.processStartTime;
  } catch {
    return false;
  }
}

async function readClaim(): Promise<Claim | undefined> {
  try {
    return JSON.parse(await readFile(CLAIM_PATH, "utf8")) as Claim;
  } catch {
    return undefined;
  }
}

async function retireStaleClaim(observed: Claim | undefined): Promise<void> {
  if (observed && await claimIsLive(observed)) {
    throw new Error(
      `RUNEBENCH_CONTROLLER_BUSY: ${observed.owner} owns the bot in process ` +
      `${observed.pid}`,
    );
  }
  const quarantine = `${LOCK_DIR}.stale-${crypto.randomUUID()}`;
  try {
    await rename(LOCK_DIR, quarantine);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    return;
  }
  await rm(quarantine, { recursive: true, force: true });
}

export async function acquireControllerLease(owner: string): Promise<ControllerLease> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(owner)) {
    throw new Error("controller owner must be 1-64 safe identifier characters");
  }
  const claim: Claim = {
    schema: CLAIM_SCHEMA,
    owner,
    pid: process.pid,
    processStartTime: await processStartTime(process.pid),
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(LOCK_DIR);
      await writeFile(CLAIM_PATH, `${JSON.stringify(claim)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      let released = false;
      return {
        owner,
        claim,
        async release() {
          if (released) return;
          const current = await readClaim();
          if (!current || current.token !== claim.token) {
            throw new Error("RUNEBENCH_CONTROLLER_CLAIM_CHANGED");
          }
          await rm(LOCK_DIR, { recursive: true });
          released = true;
        },
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const observed = await readClaim();
      if (!observed && attempt < 2) {
        await Bun.sleep(50);
        continue;
      }
      await retireStaleClaim(observed);
    }
  }
  throw new Error("RUNEBENCH_CONTROLLER_CLAIM_UNAVAILABLE");
}

export class RuneBenchController {
  readonly bot: BotActions;
  readonly rs: BotSDK;
  readonly owner: string;
  #lease: ControllerLease;
  #released = false;

  constructor(owner: string, lease: ControllerLease, rs: BotSDK) {
    this.owner = owner;
    this.#lease = lease;
    this.rs = rs;
    this.bot = new BotActions(rs);
  }

  async release(): Promise<void> {
    if (this.#released) return;
    await this.rs.disconnect();
    if (this.rs.getConnectionState() !== "disconnected") {
      throw new Error("RUNEBENCH_CONTROLLER_DISCONNECT_UNCONFIRMED");
    }
    await this.#lease.release();
    this.#released = true;
    if (activeController === this) activeController = undefined;
  }
}

export async function acquireController(owner = "repl"): Promise<RuneBenchController> {
  if (activeController) {
    if (activeController.owner !== owner) {
      throw new Error(
        `RUNEBENCH_CONTROLLER_BUSY: ${activeController.owner} owns this process`,
      );
    }
    return activeController;
  }
  const lease = await acquireControllerLease(owner);
  const rs = new BotSDK({
    botUsername: "agent",
    password: "test",
    gatewayUrl: "ws://localhost:7780",
    autoLaunchBrowser: false,
  });
  try {
    await rs.connect();
  } catch (error) {
    await lease.release();
    throw error;
  }
  activeController = new RuneBenchController(owner, lease, rs);
  return activeController;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return selected;
}

export async function runActionLoop<T extends ActionResult>(
  options: ActionLoopOptions<T>,
): Promise<ActionAttempt<T>[]> {
  const iterations = boundedInteger(options.iterations, 1, 1, 10_000, "iterations");
  const minBackoffMs = boundedInteger(
    options.minBackoffMs,
    MIN_BACKOFF_MS,
    MIN_BACKOFF_MS,
    MAX_BACKOFF_MS,
    "minBackoffMs",
  );
  const maxBackoffMs = boundedInteger(
    options.maxBackoffMs,
    MAX_BACKOFF_MS,
    minBackoffMs,
    MAX_BACKOFF_MS,
    "maxBackoffMs",
  );
  const successDelayMs = boundedInteger(
    options.successDelayMs,
    0,
    0,
    MAX_BACKOFF_MS,
    "successDelayMs",
  );
  const maxConsecutiveFailures = boundedInteger(
    options.maxConsecutiveFailures,
    8,
    1,
    1_000,
    "maxConsecutiveFailures",
  );
  const attempts: ActionAttempt<T>[] = [];
  let failureCount = 0;

  for (let attempt = 1; attempt <= iterations; attempt += 1) {
    try {
      const result = await options.action();
      if (result?.success !== true) {
        failureCount += 1;
        const kind = result?.success === false
          ? "reported_failure" as const
          : "invalid_result" as const;
        const failed: ActionAttempt<T> = {
          ok: false,
          attempt,
          failureCount,
          kind,
          ...(result === undefined ? {} : { result }),
          ...(kind === "invalid_result"
            ? {
                error:
                  "ACTION_RESULT_INVALID: expected an object with boolean success",
              }
            : {}),
        };
        attempts.push(failed);
        await options.onAttempt?.(failed);
        if (failureCount >= maxConsecutiveFailures) break;
        const delay = Math.min(
          maxBackoffMs,
          minBackoffMs * (2 ** Math.min(failureCount - 1, 8)),
        );
        if (attempt < iterations) await Bun.sleep(delay);
        continue;
      }
      failureCount = 0;
      const succeeded: ActionAttempt<T> = { ok: true, attempt, result };
      attempts.push(succeeded);
      await options.onAttempt?.(succeeded);
      if (successDelayMs > 0) await Bun.sleep(successDelayMs);
    } catch (error) {
      failureCount += 1;
      const failed: ActionAttempt<T> = {
        ok: false,
        attempt,
        failureCount,
        kind: "threw",
        error: error instanceof Error ? error.message : String(error),
      };
      attempts.push(failed);
      await options.onAttempt?.(failed);
      if (failureCount >= maxConsecutiveFailures) break;
      const delay = Math.min(
        maxBackoffMs,
        minBackoffMs * (2 ** Math.min(failureCount - 1, 8)),
      );
      if (attempt < iterations) await Bun.sleep(delay);
    }
  }
  return attempts;
}

async function measuredValue(
  measure: () => Promise<number> | number,
): Promise<number> {
  const value = await measure();
  if (!Number.isFinite(value)) {
    throw new Error("measured action-loop value must be finite");
  }
  return value;
}

export async function runMeasuredActionLoop<T extends ActionResult>(
  options: MeasuredActionLoopOptions<T>,
): Promise<MeasuredActionLoopSummary> {
  const before = await measuredValue(options.measure);
  const startedAt = Date.now();
  const attempts = await runActionLoop(options);
  const after = await measuredValue(options.measure);
  const failed = attempts.filter((attempt) => !attempt.ok);
  const reportedFailures = failed.filter((attempt) =>
    attempt.kind === "reported_failure").length;
  const invalidResults = failed.filter((attempt) =>
    attempt.kind === "invalid_result").length;
  const threw = failed.filter((attempt) => attempt.kind === "threw").length;
  const lastFailure = failed.at(-1);
  const result = lastFailure && "result" in lastFailure
    ? lastFailure.result
    : undefined;
  return {
    requested: options.iterations,
    attempted: attempts.length,
    accepted: attempts.length - failed.length,
    succeeded: attempts.length - failed.length,
    failed: failed.length,
    reportedFailures,
    invalidResults,
    threw,
    failureRate: attempts.length === 0 ? 0 : failed.length / attempts.length,
    stopReason: attempts.length < options.iterations
      ? "consecutive_failures"
      : "iterations_completed",
    elapsedMs: Date.now() - startedAt,
    metric: { before, after, delta: after - before },
    lastFailure: lastFailure
      ? {
          attempt: lastFailure.attempt,
          kind: lastFailure.kind,
          error: "error" in lastFailure ? lastFailure.error ?? null : null,
          message: typeof result?.message === "string" ? result.message : null,
          reason: typeof result?.reason === "string" ? result.reason : null,
        }
      : null,
  };
}
"""

REPL_CONNECTION_SOURCE = f"""const {{
  acquireController,
  runActionLoop,
  runMeasuredActionLoop,
}} = await import("{CONTROLLER_PATH}");
const controller = await acquireController("repl");
const rs = controller.rs;
const bot = controller.bot;"""

REPL_GUIDANCE = f"""

## Agencity RuneBench treatment

Use only Agencity's persistent Bun TypeScript console. Keep Agencity's built-in
`sdk` name for durable agent APIs. Acquire the one permitted game controller:

```ts
{REPL_CONNECTION_SOURCE}
```

The controller claim prevents a second live process from controlling the bot.
Never construct `BotSDK` yourself. Reuse `controller`, `rs`, and `bot` while the
REPL epoch is warm. `bot` is the high-level `BotActions` surface (for example,
`bot.attackNpc(...)`); `rs` is the lower-level `BotSDK` surface. Keep methods on
the receiver documented in `/app/sdk/API.md` instead of guessing or moving a
method between `bot` and `rs`.

Direct SDK quick start:

```ts
await bot.skipTutorial();
await bot.chopTree();
await bot.interactLoc(/rocks?/i, "Mine");
await bot.attackNpc("chicken");
rs.getState();
rs.getInventory();
rs.findNearbyLoc(/tree/i);
```

These examples identify the receiver and call shape; select the action relevant
to the scored skill. The full image-owned API remains authoritative. Read a
bounded section with `tools.readFile("/app/sdk/API.md", {{ startLine, endLine }})`.
For a `BotActions` parameter implemented as a name or regular-expression
matcher, pass the string or `RegExp` selector rather than a previously resolved
inventory, NPC, or location object. A `regex.test is not a function` error is
evidence of the wrong overload shape; correct the argument once instead of
repeating the call or moving it to `rs`.
To locate a symbol first, inspect the exact bounded shell envelope:

```ts
const match = await tools.shell("grep -n 'attackNpc' /app/sdk/API.md");
return match.completeness === "inline" ? match.value : match;
```

## Image-owned API and knowledge

The pinned image provides three different sources. Keep their roles and
directories separate:

- `/app/sdk/API.md` is the executable API contract. Use it to confirm the exact
  receiver, method name, argument shape, and return type. `BotSDK` methods
  belong on `rs`; `BotActions` methods belong on `bot`.
- `/app/learnings/` contains optional upstream `rs-sdk` operational notes,
  tested interaction patterns, known obstacles, and examples. A scored skill
  may have no matching learning file. Upstream prose may call the game client
  `sdk`; in this treatment, Agencity owns the `sdk` name. Translate each game
  call through `/app/sdk/API.md` to `rs` or `bot` instead of copying receiver
  names blindly.
- `/app/wiki/` contains game facts, not callable API. Start in
  `/app/wiki/skills/` for training methods and requirements, then follow its
  Markdown links or search `/app/wiki/items/` for tools and ingredients,
  `/app/wiki/npcs/` for targets and locations, `/app/wiki/shops/` for stock and
  prices, and `/app/wiki/quests/` for access requirements and walkthroughs.

List learnings and skill guides separately so a wiki filename is never treated
as a learning filename:

```ts
const [learningFiles, skillFiles] = await Promise.all([
  tools.shell("ls -1 /app/learnings"),
  tools.shell("ls -1 /app/wiki/skills"),
]);
return {{
  learnings: learningFiles.completeness === "inline"
    ? learningFiles.value.stdout.trim().split("\\n").filter(Boolean)
    : learningFiles,
  skillGuides: skillFiles.completeness === "inline"
    ? skillFiles.value.stdout.trim().split("\\n").filter(Boolean)
    : skillFiles,
}};
```

Use targeted case-insensitive searches when the filename is uncertain. Do not
load the wiki corpus wholesale or repeat unchanged searches. Treat learnings
and wiki pages as guidance rather than current world state: confirm tools,
inventory, nearby entities, requirements, and action results through `rs`, and
confirm exact callable signatures in `/app/sdk/API.md`.

The scored skill is **{SCORED_SKILL_TOKEN}**. Begin with an initial discovery
phase before game actions. Batch independent reads and live-state inspection
instead of using one model turn per file. The example below is one efficient
starting cell, not a limit on discovery. It may read the complete 579-line
pinned API, the scored skill's wiki page, the matching upstream learning when
present, and the learning/skill filename index in parallel. Return only those
bounded documents plus a compact live-state projection; do not return the
complete game state.

```ts
const scoredSkill = "{SCORED_SKILL_TOKEN}";
const skillSlug = "{SCORED_SKILL_SLUG_TOKEN}";
const [learningIndex, skillIndex, api] = await Promise.all([
  tools.shell("ls -1 /app/learnings"),
  tools.shell("ls -1 /app/wiki/skills"),
  tools.readFile("/app/sdk/API.md", {{ startLine: 1, endLine: 579 }}),
]);
const names = (result: typeof learningIndex) =>
  result.completeness === "inline"
    ? result.value.stdout.trim().split("\\n").filter(Boolean)
    : [];
const optionalRead = async (path: string) => {{
  try {{
    return {{
      path,
      status: "read" as const,
      result: await tools.readFile(path, {{ startLine: 1, endLine: 400 }}),
    }};
  }} catch (error) {{
    return {{
      path,
      status: "unavailable" as const,
      error: error instanceof Error ? error.message : String(error),
    }};
  }}
}};
const learningFiles = names(learningIndex);
const skillFiles = names(skillIndex);
const skillPath = `/app/wiki/skills/${{skillSlug}}.md`;
const learningPath = `/app/learnings/${{skillSlug}}.md`;
const [skillGuide, matchingLearning] = await Promise.all([
  skillFiles.includes(`${{skillSlug}}.md`)
    ? optionalRead(skillPath)
    : Promise.resolve({{ path: skillPath, status: "absent" as const }}),
  learningFiles.includes(`${{skillSlug}}.md`)
    ? optionalRead(learningPath)
    : Promise.resolve({{ path: learningPath, status: "absent" as const }}),
]);
const game = rs.getState();
const progress = {{
  skill: scoredSkill,
  phase: "discovery",
  xp: rs.getSkillXp(scoredSkill) ?? null,
  confirmedFacts: [],
  rejectedStrategies: [],
  activeStrategy: null,
  blocker: null,
  nextHypothesis: "select one executable strategy from the API, guide, and live state",
  inventory: rs.getInventory(),
  liveState: inspect(game, {{
    depth: 4,
    entries: 100,
    lines: 80,
    bytes: 12_000,
  }}),
}};
await state.set("runebench.progress", progress);
return {{
  knowledgeIndex: {{ learningFiles, skillFiles }},
  api,
  skillGuide,
  matchingLearning,
  progress,
}};
```

If the exact learning filename is absent, use the returned index to select at
most one clearly relevant upstream learning in the next discovery or experiment
cell. The optional document records explicitly report `read`, `absent`, or
`unavailable`; an absent learning is normal, while an unavailable indexed file
is evidence to use the other retained sources.

After reviewing the initial discovery evidence, make an initial plan and choose
an initial strategy before the first game action. Record the plan in
`runebench.progress`: required inputs, how to acquire them, the target or
station, the exact `rs` or `bot` action, the live-state and scored-skill metric
that prove it worked, at least one viable alternative when the evidence exposes
one, open questions, and the next experiment. Treat this plan as a hypothesis,
not a fixed workflow.

Discovery remains available throughout the run. Return to focused API,
learning, wiki, or live-state inspection whenever new evidence, a missing
prerequisite, an unexpected result, a route uncertainty, a high failure rate,
or a stalled official peak creates a specific question. Update the retained
plan and strategy when evidence changes them, including what changed and why.
Alternate discovery and action as the evidence requires. Do not repeat
unchanged searches or reread sources that already answer the current question,
and do not load the wiki corpus wholesale.

## Measured experiments

Use one short action to validate a strategy, then use
`runMeasuredActionLoop` for repeated actions. It preserves the 250 ms minimum
failure backoff, stops after eight consecutive failures by default, and returns
exactly `requested`, `attempted`, `accepted`, `succeeded`, `failed`,
`reportedFailures`, `invalidResults`, `threw`, `failureRate`, `stopReason`,
`elapsedMs`, `metric`, and `lastFailure` without returning every attempt. Only
an object with `success: true` is accepted; explicit false results, thrown
errors, missing booleans, `undefined`, and malformed results back off and count
as failures. Accepted actions still do not prove a kill, loot, inventory
transition, scored XP, or rate improvement. `metric.delta` is the verification.

```ts
return await (async () => {{
  const strategy = "task-relevant tested action";
  const report = await runMeasuredActionLoop({{
    iterations: 20,
    minBackoffMs: 250,
    maxBackoffMs: 5_000,
    maxConsecutiveFailures: 8,
    successDelayMs: 0,
    action: () => bot.chopTree(),
    measure: () => rs.getSkillXp("{SCORED_SKILL_TOKEN}") ?? 0,
  }});
  const rate = await tools.shell(
    "{RATE_COMMAND_TEMPLATE.format(skill=SCORED_SKILL_TOKEN)}",
  );
  const progress = {{
    skill: "{SCORED_SKILL_TOKEN}",
    phase: report.metric.delta > 0 ? "productive" : "diagnose",
    confirmedFacts: report.metric.delta > 0
      ? [`${{strategy}} produced measured progress`]
      : [],
    rejectedStrategies: report.metric.delta > 0
      ? []
      : [{{ strategy, evidence: report }}],
    activeStrategy: report.metric.delta > 0 ? strategy : null,
    blocker: report.metric.delta > 0
      ? null
      : report.lastFailure ?? "action was accepted without measured progress",
    nextHypothesis: report.metric.delta > 0
      ? "compare the official peak with another viable strategy or exploit"
      : "change one prerequisite, target, receiver, or route before retrying",
    report,
    tracker: rate.completeness === "inline" ? rate.value.stdout.trim() : rate,
  }};
  await state.set("runebench.progress", progress);
  return progress;
}})();
```

`runebench.progress` is durable and is included in later model context even
after detailed cell observations age out. Update it after each materially
different strategy. Keep `confirmedFacts`, `rejectedStrategies`,
`activeStrategy`, `blocker`, and `nextHypothesis` compact and factual. Never
label an item raw, a target available, a station usable, or a route productive
without current inventory/state or measured evidence. A successful helper
return is not proof of task progress: only the phase-relevant state transition,
positive scored-skill XP, and tracker evidence are progress.

Start with one short action and return its small result. Treat a returned
`{{ success: false, ... }}` as a failure even though it did not throw. Every
repeated strategy must use `runActionLoop`, which applies bounded exponential
backoff to false results and thrown errors. Inspect failed messages and change
the strategy instead of hot-looping an unavailable target. Retire a strategy
after two measured zero-progress experiments with the same prerequisites and
target, after its official peak fails to improve on two checks, or when more
than 25 percent of attempts fail. Record that evidence in
`rejectedStrategies`; do not retry it until a named prerequisite, target,
receiver, route, or game-state assumption changes. The scored horizon is
already running: do not spend opening turns enumerating object surfaces or
repeating unchanged documentation searches. Cell results must be JSON-safe:
replace optional `undefined` fields with `?? null` or omit them.

Keep only reusable connections, imported helpers, and small strategy summaries
at REPL top level. Per-strategy attempt arrays, complete tool payloads, and
other transient values belong inside an async function or local block so they
can be collected after the cell returns. Return aggregate counts, the latest
useful failure, elapsed time, and the measured rate instead of retaining or
returning complete attempt history.

Write treatment scripts only under `{TRAINER_DIR}`. Measure after each strategy
with the exact `TRACKING_FILE={TRACKING_FILE} bun ... check_xp_rate.ts <Skill>`
command stated in the task.

The official peak rate, not cumulative XP, selects the strategy. Before a
foreground commitment longer than 60 seconds, compare at least two viable
methods, targets, or supply routes when the guide and live state expose them.
Once a measured loop improves the official peak with an acceptable failure
rate, prefer fewer bounded foreground loops and fewer model decisions. Check
the peak at least once per minute and reconsider when it stalls or failures
rise. Do not alternate one short foreground action with one model call after
proving a repeatable strategy.

A managed process is optional rather than the default next step. Use one only
when pauses during model decisions materially prevent sustained training. If
used, write the trainer under `{TRAINER_DIR}`, import `acquireController` and
`runActionLoop` from `{CONTROLLER_PATH}`, release the REPL controller before
calling `sdk.processes.start`, and release the trainer's unique controller in
`finally`. Retain only the returned JSON handle; inspect or stop it with
`sdk.processes.inspect`, `sdk.processes.readLogs`, and `sdk.processes.stop`.
The exact start contract is
`sdk.processes.start(input: string | {{ command: string; cwd?: string;
idempotencyKey?: string }})`. Prefer the explicit object form:

```ts
const trainer = await sdk.processes.start({{
  command: "/opt/agencity/bin/bun run {TRAINER_DIR}/trainer.ts",
  cwd: "/app",
  idempotencyKey: "runebench-trainer-v1",
}});
await state.set("runebench.trainer", trainer);
return trainer;
```

Reuse an idempotency key only for the same exact command and working directory.

Never use `command &`, `nohup`, `/tmp`, or another unmanaged process. Never
start a trainer while the REPL controller claim is live. A failed controller
claim is a lifecycle error to fix, not permission to bypass the wrapper.

Use the authoritative `deadline.remainingMs` supplied on every model step.
Never start work expected to outlive it. With at most 90 seconds remaining,
stop exploration and managed trainers, inspect the official tracker, and keep
only a bounded final action if scored XP is still zero. Once the final
60-second gate window opens, call `finish` with `status: "succeeded"` only when
the tracker proves positive scored-skill XP; otherwise keep any last attempt
short enough for the absolute deadline to end the run truthfully.
""".strip()


def render_repl_guidance(skill: str) -> str:
    if not re.fullmatch(r"[A-Za-z][A-Za-z ]{0,63}", skill):
        raise ValueError(f"invalid RuneBench scored skill: {skill!r}")
    return REPL_GUIDANCE.replace(SCORED_SKILL_TOKEN, skill).replace(
        SCORED_SKILL_SLUG_TOKEN,
        skill.lower().replace(" ", "-"),
    )


def render_completion_gate_source(
    skill: str,
    duration_seconds: int,
    sample_interval_ms: int,
) -> str:
    if not re.fullmatch(r"[A-Za-z][A-Za-z ]{0,63}", skill):
        raise ValueError(f"invalid RuneBench scored skill: {skill!r}")
    if duration_seconds < 1 or sample_interval_ms < 1:
        raise ValueError("RuneBench completion gate requires positive timing")
    finish_window_ms = max(60_000, sample_interval_ms * 4)
    minimum_elapsed_ms = max(0, duration_seconds * 1_000 - finish_window_ms)
    return f"""const TRACKING_FILE = {json.dumps(TRACKING_FILE)};
const SKILL = {json.dumps(skill)};
const MINIMUM_ELAPSED_MS = {minimum_elapsed_ms};

type Sample = {{
  elapsedMs?: number;
  skills?: Record<string, {{ xp?: number }}>;
}};

const fail = (message: string, evidence: unknown = null): never => {{
  console.error(JSON.stringify({{
    protocol: "agencity.runebench-completion-gate.v1",
    passed: false,
    message,
    evidence,
  }}));
  process.exit(1);
}};

if (!(await Bun.file(TRACKING_FILE).exists())) {{
  fail("official skill tracker is unavailable");
}}
const tracking = await Bun.file(TRACKING_FILE).json() as {{ samples?: Sample[] }};
const samples = Array.isArray(tracking.samples) ? tracking.samples : [];
if (samples.length < 2) {{
  fail("official skill tracker does not contain two samples", {{
    sampleCount: samples.length,
  }});
}}
const first = samples[0]!;
const last = samples.at(-1)!;
const firstXp = Number(first.skills?.[SKILL]?.xp);
const lastXp = Number(last.skills?.[SKILL]?.xp);
const elapsedMs = Number(last.elapsedMs);
if (![firstXp, lastXp, elapsedMs].every(Number.isFinite)) {{
  fail("official skill tracker is missing finite scored-skill evidence", {{
    skill: SKILL,
    firstXp,
    lastXp,
    elapsedMs,
  }});
}}
const evidence = {{
  skill: SKILL,
  sampleCount: samples.length,
  elapsedMs,
  minimumElapsedMs: MINIMUM_ELAPSED_MS,
  firstXp,
  lastXp,
  xpDelta: lastXp - firstXp,
}};
if (lastXp <= firstXp) {{
  fail("scored-skill XP has not increased", evidence);
}}
if (elapsedMs < MINIMUM_ELAPSED_MS) {{
  fail("official task horizon is not close enough to completion", evidence);
}}
console.log(JSON.stringify({{
  protocol: "agencity.runebench-completion-gate.v1",
  passed: true,
  evidence,
}}));
"""

WITHIN_RUN_GUIDANCE = """

This is the within-run adaptive treatment. Automatic triggers are paused. The
run permits at most one explicit governed review, and that review requires a
canonical evidence event from this run.

Do not request refinement until one compact evidence cell has verified all
three conditions: the tracker reports a non-zero XP/min rate; an
`sdk.processes` trainer inspection reports `running`; and a retained failure or
measured-rate comparison identifies one specific improvement target. Return
only a small JSON object with the measured rate, managed process ID and status,
and target. On the next model step, use that `CellCommitted` observation's
`eventId` in
`sdk.harness.review({ instructions, requestedScope: "local", allowedKinds:
["memory", "prompt_note", "skill"], evidenceEventIds: [eventId], wait: true })`.
The runtime rejects missing evidence and a second request. Generic advice or an
unmeasured guess remains an ordinary working note.

Apply an approved lesson only to a later measured attempt in this same rollout.
Each game starts fresh and no learned state is shared across scored tasks.
""".strip()


class RuneBenchConfig(HarborSuiteConfig):
    dataset: Literal[
        "maxbittker/runebench@sha256:4bb3430af2ef3a320bd3dfeeab2447fbf9e0093452ad747997186a85a060de28"
    ] = DATASET
    treatment: Literal["agencity-runebench-repl-v2"] = TREATMENT
    learning_mode: LearningMode = "within-run"
    ignore_dockerfile: Literal[True] = True
    require_image: Literal[False] = False

    @model_validator(mode="after")
    def validate_catalog_selection(self) -> "RuneBenchConfig":
        catalog = load_catalog(CATALOG_PATH, BENCHMARK)
        if catalog["dataset"]["package"] != self.dataset:
            raise ValueError("RuneBench catalog dataset pin drifted")
        select_catalog_tasks(catalog, self.selection)
        return self


class RuneBenchData(HarborSuiteData):
    skill: str
    duration_seconds: int
    sample_interval_ms: int
    save_sha256: str
    source_dockerfile_sha256: str
    learning_mode: LearningMode
    prompt_sha256: str
    adapted_prompt_sha256: str
    source_memory_gb: float
    treatment_memory_gb: float


class RuneBenchTask(HarborSuiteTask):
    """Stage the official start state and retain official Harbor scoring."""

    data: RuneBenchData

    async def setup(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        task_root = Path(self.data.task_dir)
        save = task_root / "environment" / "agent.sav"
        if _sha256_file(save) != self.data.save_sha256:
            raise ValueError(f"RuneBench task {self.data.selection_id} save fixture drifted")
        await runtime.write(
            "/app/server/engine/data/players/main/agent.sav",
            save.read_bytes(),
        )
        prepared = await runtime.run(
            ["mkdir", "-p", TREATMENT_DIR, TRAINER_DIR],
            {},
        )
        if prepared.exit_code != 0:
            detail = (prepared.stderr or prepared.stdout).strip()[-500:]
            raise RuntimeError(f"could not prepare RuneBench treatment directory: {detail}")
        await runtime.write(CONTROLLER_PATH, CONTROLLER_SOURCE.encode("utf-8"))
        await runtime.write(
            COMPLETION_GATE_PATH,
            render_completion_gate_source(
                self.data.skill,
                self.data.duration_seconds,
                self.data.sample_interval_ms,
            ).encode("utf-8"),
        )

        exists = await runtime.run(["test", "-f", "/app/AGENTS.md"], {})
        if exists.exit_code not in {0, 1}:
            raise RuntimeError(
                "could not inspect RuneBench AGENTS.md: "
                f"{(exists.stderr or exists.stdout).strip()[-500:]}"
            )
        instructions = (
            await runtime.read("/app/AGENTS.md", max_bytes=64 * 1024)
            if exists.exit_code == 0
            else b""
        )
        marker = b"## Agencity RuneBench treatment"
        treatment_guidance = render_repl_guidance(self.data.skill)
        if marker not in instructions:
            adapted = (
                (instructions.rstrip() + b"\n\n" if instructions else b"")
                + treatment_guidance.encode("utf-8")
                + b"\n"
            )
            if self.data.learning_mode == "within-run":
                adapted += b"\n" + WITHIN_RUN_GUIDANCE.encode("utf-8") + b"\n"
            await runtime.write("/app/AGENTS.md", adapted)
        trace.info["runebench"] = {
            "schema": "agencity.runebench-treatment.v1",
            "interface": "direct-rs-sdk-through-persistent-bun-console",
            "learning_mode": self.data.learning_mode,
            "cross_episode_learning": False,
            "skill": self.data.skill,
            "duration_seconds": self.data.duration_seconds,
            "sample_interval_ms": self.data.sample_interval_ms,
            "source_memory_gb": self.data.source_memory_gb,
            "treatment_memory_gb": self.data.treatment_memory_gb,
            "prompt_sha256": self.data.prompt_sha256,
            "adapted_prompt_sha256": self.data.adapted_prompt_sha256,
            "treatment_guidance_sha256": _sha256_text(treatment_guidance),
            "services": "staged",
        }

    async def finalize(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        await super().finalize(trace, runtime)
        provenance = trace.info.get("benchmark_provenance")
        if isinstance(provenance, dict):
            provenance.update(
                {
                    "interface": "direct-rs-sdk-through-persistent-bun-console",
                    "learning_mode": self.data.learning_mode,
                    "cross_episode_learning": False,
                    "skill": self.data.skill,
                    "duration_seconds": self.data.duration_seconds,
                    "sample_interval_ms": self.data.sample_interval_ms,
                    "save_sha256": self.data.save_sha256,
                    "source_dockerfile_sha256": self.data.source_dockerfile_sha256,
                    "prompt_sha256": self.data.prompt_sha256,
                    "adapted_prompt_sha256": self.data.adapted_prompt_sha256,
                    "treatment_guidance_sha256": _sha256_text(
                        render_repl_guidance(self.data.skill)
                    ),
                    "source_memory_gb": self.data.source_memory_gb,
                    "treatment_memory_gb": self.data.treatment_memory_gb,
                }
            )


class RuneBenchTaskset(vf.Taskset[RuneBenchTask, RuneBenchConfig]):
    """Load selected immutable RuneBench tasks through the REPL adaptation."""

    def load(self) -> Iterator[RuneBenchTask]:
        catalog = load_catalog(CATALOG_PATH, BENCHMARK)
        _validate_catalog_runtime(catalog, self.config, LOCK_PATH)
        selected, selection = select_catalog_tasks(catalog, self.config.selection)
        selected_ids = [str(entry["id"]) for entry in selected]
        harbor_config = self.config.model_copy(update={"tasks": selected_ids})
        upstream = list(HarborTaskset(harbor_config).load())
        by_id = {task.data.task_dir.rstrip("/").split("/")[-1]: task for task in upstream}
        if set(by_id) != set(selected_ids):
            raise ValueError(
                f"RuneBench Harbor selection drifted: expected {selected_ids}, "
                f"loaded {sorted(by_id)}"
            )

        digest = catalog_digest(CATALOG_PATH)
        for entry in selected:
            identifier = str(entry["id"])
            task = by_id[identifier]
            data = task.data
            task_root = Path(data.task_dir)
            if data.name != entry["upstream_name"]:
                raise ValueError(f"RuneBench task {identifier} upstream name drifted")
            if data.image is not None or data.workdir is not None:
                raise ValueError(f"RuneBench task {identifier} source image shape drifted")
            if data.resources.memory != entry["source_memory_gb"]:
                raise ValueError(f"RuneBench task {identifier} source memory drifted")
            if _sha256_file(task_root / "task.toml") != entry["task_toml_sha256"]:
                raise ValueError(f"RuneBench task {identifier} task.toml drifted")
            if _sha256_tree(task_root) != entry["task_tree_sha256"]:
                raise ValueError(f"RuneBench task {identifier} task tree drifted")
            if (
                _sha256_file(task_root / "environment" / "Dockerfile")
                != entry["source_dockerfile_sha256"]
            ):
                raise ValueError(f"RuneBench task {identifier} Dockerfile drifted")
            if (
                _sha256_file(task_root / "environment" / "agent.sav")
                != entry["save_sha256"]
            ):
                raise ValueError(f"RuneBench task {identifier} save fixture drifted")

            prompt = _adapt_prompt(str(data.prompt))
            suite_data = RuneBenchData.model_validate(
                data.model_dump()
                | {
                    "prompt": prompt,
                    "image": entry["image"],
                    "workdir": entry["workdir"],
                    "resources": data.resources.model_copy(
                        update={"memory": entry["treatment_memory_gb"]}
                    ),
                    "selection_id": identifier,
                    "benchmark": BENCHMARK,
                    "catalog_sha256": digest,
                    "catalog_tasks_sha256": catalog["tasks_sha256"],
                    "selected_ids": selection["selected_ids"],
                    "selected_ids_sha256": selection["selected_ids_sha256"],
                    "task_tree_sha256": entry["task_tree_sha256"],
                    "task_toml_sha256": entry["task_toml_sha256"],
                    "image_manifest_digest": entry["image_manifest_digest"],
                    "image_config_digest": entry["image_config_digest"],
                    "treatment": self.config.treatment,
                    "console_rss_recycle_bytes": (
                        RUNEBENCH_CONSOLE_RSS_RECYCLE_BYTES
                    ),
                    "skill": entry["skill"],
                    "duration_seconds": entry["duration_seconds"],
                    "sample_interval_ms": entry["sample_interval_ms"],
                    "save_sha256": entry["save_sha256"],
                    "source_dockerfile_sha256": entry["source_dockerfile_sha256"],
                    "learning_mode": self.config.learning_mode,
                    "prompt_sha256": _sha256_text(str(data.prompt)),
                    "adapted_prompt_sha256": _sha256_text(prompt),
                    "source_memory_gb": entry["source_memory_gb"],
                    "treatment_memory_gb": entry["treatment_memory_gb"],
                }
            )
            yield RuneBenchTask(suite_data, task.config)


def _adapt_prompt(prompt: str) -> str:
    adapted = _remove_upstream_mcp_instructions(prompt)
    forbidden = ("execute_code", "rs-agent", "MCP server", "bun /tmp/")
    present = [value for value in forbidden if value in adapted]
    if present:
        raise ValueError(
            "RuneBench prompt adaptation retained unsupported interfaces: "
            + ", ".join(present)
        )
    return adapted


def _remove_upstream_mcp_instructions(prompt: str) -> str:
    start = "\nYou control the bot via the `rs-agent` MCP server."
    end = "\nRULES:"
    if prompt.count(start) != 1 or prompt.count(end) != 1:
        raise ValueError("RuneBench upstream prompt interface shape drifted")
    prefix, remainder = prompt.split(start, 1)
    _, rules = remainder.split(end, 1)
    rate_pattern = re.compile(
        r"`bun /app/benchmark/shared/check_xp_rate\.ts ([A-Za-z]+)`"
    )
    prefix, replacements = rate_pattern.subn(
        lambda match: f"`{RATE_COMMAND_TEMPLATE.format(skill=match.group(1))}`",
        prefix,
    )
    if replacements != 1:
        raise ValueError("RuneBench upstream rate command shape drifted")
    return f"{prefix.rstrip()}\n\nRULES:{rules}".strip()


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


__all__ = [
    "BENCHMARK",
    "CATALOG_PATH",
    "COMPLETION_GATE_PATH",
    "DATASET",
    "CONTROLLER_PATH",
    "CONTROLLER_SOURCE",
    "RATE_COMMAND_TEMPLATE",
    "REPL_CONNECTION_SOURCE",
    "REPL_GUIDANCE",
    "RUNEBENCH_CONSOLE_RSS_RECYCLE_BYTES",
    "TREATMENT",
    "TRACKING_FILE",
    "TRAINER_DIR",
    "WITHIN_RUN_GUIDANCE",
    "RuneBenchConfig",
    "RuneBenchData",
    "RuneBenchTask",
    "RuneBenchTaskset",
    "render_completion_gate_source",
    "render_repl_guidance",
]

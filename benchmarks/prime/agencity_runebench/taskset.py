"""Pinned RuneBench skill tasks adapted to Agencity's persistent Bun console."""

from __future__ import annotations

import hashlib
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
TREATMENT = "agencity-runebench-repl-v1"
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
TRAINER_DIR = f"{TREATMENT_DIR}/trainers"
TRACKING_FILE = "/logs/tracking/skill_tracking.json"
RATE_COMMAND_TEMPLATE = (
    f"TRACKING_FILE={TRACKING_FILE} "
    "bun /app/benchmark/shared/check_xp_rate.ts {skill}"
)

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
  | { ok: false; attempt: number; failureCount: number; result?: T; error?: string };

export type ActionLoopOptions<T> = {
  action: () => Promise<T>;
  iterations: number;
  onAttempt?: (attempt: ActionAttempt<T>) => Promise<void> | void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  successDelayMs?: number;
};

type ControllerLease = {
  readonly owner: string;
  readonly claim: Readonly<Claim>;
  release(): Promise<void>;
};

let activeController: RuneBenchController | undefined;

function processStartTime(pid: number): Promise<string> {
  return readFile(`/proc/${pid}/stat`, "utf8").then((value) => {
    const close = value.lastIndexOf(")");
    const fields = value.slice(close + 2).trim().split(/\s+/);
    const startTime = fields[19];
    if (!startTime) throw new Error(`cannot read process identity for pid ${pid}`);
    return startTime;
  });
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
    return (await processStartTime(claim.pid)) === claim.processStartTime;
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
  const attempts: ActionAttempt<T>[] = [];
  let failureCount = 0;

  for (let attempt = 1; attempt <= iterations; attempt += 1) {
    try {
      const result = await options.action();
      if (result?.success === false) {
        failureCount += 1;
        const failed: ActionAttempt<T> = {
          ok: false,
          attempt,
          failureCount,
          result,
        };
        attempts.push(failed);
        await options.onAttempt?.(failed);
        const delay = Math.min(
          maxBackoffMs,
          minBackoffMs * (2 ** Math.min(failureCount - 1, 8)),
        );
        await Bun.sleep(delay);
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
        error: error instanceof Error ? error.message : String(error),
      };
      attempts.push(failed);
      await options.onAttempt?.(failed);
      const delay = Math.min(
        maxBackoffMs,
        minBackoffMs * (2 ** Math.min(failureCount - 1, 8)),
      );
      await Bun.sleep(delay);
    }
  }
  return attempts;
}
"""

REPL_CONNECTION_SOURCE = f"""const {{
  acquireController,
  runActionLoop,
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
await bot.mineRock();
await bot.attackNpc("chicken");
rs.getState();
rs.getInventory();
rs.findNearbyLoc(/tree/i);
```

These examples identify the receiver and call shape; select the action relevant
to the scored skill. The full image-owned API remains authoritative. Read a
bounded section with `tools.readFile("/app/sdk/API.md", {{ startLine, endLine }})`.
To locate a symbol first, inspect the exact bounded shell envelope:

```ts
const match = await tools.shell("grep -n 'attackNpc' /app/sdk/API.md");
return match.completeness === "inline" ? match.value : match;
```

Use the exact loop shape below after one action works. Replace only the action
with the proven task-relevant call. `minBackoffMs` cannot be below 250.

```ts
const attempts = await runActionLoop({{
  iterations: 20,
  minBackoffMs: 250,
  maxBackoffMs: 5_000,
  successDelayMs: 0,
  action: () => bot.chopTree(),
}});
return {{
  succeeded: attempts.filter((attempt) => attempt.ok).length,
  failed: attempts.filter((attempt) => !attempt.ok).length,
  last: attempts.at(-1) ?? null,
}};
```

Start with one short action and return its small result. Treat a returned
`{{ success: false, ... }}` as a failure even though it did not throw. Every
repeated strategy must use `runActionLoop`, which applies bounded exponential
backoff to false results and thrown errors. Inspect failed messages and change
the strategy instead of hot-looping an unavailable target. The scored horizon
is already running: do not spend opening turns enumerating object surfaces or
repeating unchanged documentation searches. Cell results must be JSON-safe:
replace optional `undefined` fields with `?? null` or omit them.

Write treatment scripts only under `{TRAINER_DIR}`. Read `/app/sdk/API.md`,
`/app/learnings/`, and `/app/wiki/` on demand. Measure after each strategy with
the exact `TRACKING_FILE={TRACKING_FILE} bun ... check_xp_rate.ts <Skill>`
command stated in the task.

Once a measured loop produces non-zero XP, prefer moving it into one managed
process so game actions continue during model decisions. Do not keep alternating
one foreground action with one model call after proving a repeatable strategy.
The trainer script must import `acquireController` and
`runActionLoop` from `{CONTROLLER_PATH}`, acquire one unique trainer owner, and
release that controller in `finally`. Hand ownership over in this exact order:

1. write the trainer under `{TRAINER_DIR}` with `tools.writeFile`;
2. call `await controller.release()` and do not use the old `rs` or `bot` again;
3. start exactly one trainer with
   `sdk.processes.start({{ command: "bun {TRAINER_DIR}/<name>.ts",
   cwd: "/app", idempotencyKey: "<stable-strategy-key>" }})`;
4. retain the returned JSON handle and use `sdk.processes.inspect`,
   `sdk.processes.readLogs`, or `sdk.processes.stop` for its lifecycle.

Never use `command &`, `nohup`, `/tmp`, or another unmanaged process. Never
start a trainer while the REPL controller claim is live. A failed controller
claim is a lifecycle error to fix, not permission to bypass the wrapper.
""".strip()

WITHIN_RUN_GUIDANCE = """

This is the within-run adaptive treatment. Do not spend the opening minutes on
reflection. First establish a non-zero measured baseline. While a proven managed
loop earns XP, use retained failures and measured rate evidence to improve the
next attempt. If the trajectory contains a genuinely reusable
lesson, one focused `sdk.harness.review` request may target `memory`,
`prompt_note`, or `skill` with `wait: true`; generic advice or an unmeasured
guess should remain ordinary working notes. Apply an approved lesson only to a
later measured attempt in this same rollout. Each game starts fresh and no
learned state is shared across scored tasks.
""".strip()


class RuneBenchConfig(HarborSuiteConfig):
    dataset: Literal[
        "maxbittker/runebench@sha256:4bb3430af2ef3a320bd3dfeeab2447fbf9e0093452ad747997186a85a060de28"
    ] = DATASET
    treatment: Literal["agencity-runebench-repl-v1"] = TREATMENT
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
        if marker not in instructions:
            adapted = (
                (instructions.rstrip() + b"\n\n" if instructions else b"")
                + REPL_GUIDANCE.encode("utf-8")
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
    "DATASET",
    "CONTROLLER_PATH",
    "CONTROLLER_SOURCE",
    "RATE_COMMAND_TEMPLATE",
    "REPL_CONNECTION_SOURCE",
    "REPL_GUIDANCE",
    "TREATMENT",
    "TRACKING_FILE",
    "TRAINER_DIR",
    "WITHIN_RUN_GUIDANCE",
    "RuneBenchConfig",
    "RuneBenchData",
    "RuneBenchTask",
    "RuneBenchTaskset",
]

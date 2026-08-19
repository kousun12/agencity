"""Pinned RuneBench skill tasks adapted to Agencity's persistent Bun console."""

from __future__ import annotations

import hashlib
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

REPL_GUIDANCE = """

## Agencity RuneBench treatment

This rollout uses Agencity's persistent Bun TypeScript console directly instead
of the benchmark's `execute_code` MCP wrapper. Ignore instructions to call the
`rs-agent` MCP tool. The same benchmark SDK is available from `/app`.

Keep Agencity's built-in `sdk` name for durable agent APIs. Create the game
objects under distinct names and reuse them across console cells:

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

The `rs` and `bot` bindings survive across cells while the REPL epoch is warm.
Start with one short action, return a small state summary, then lengthen only a
measured working loop. Read `/app/sdk/API.md`, `/app/learnings/`, and
`/app/wiki/` on demand. Use the benchmark's rate-check command after each
strategy. Put a proven loop in a background script only when work must continue
while you inspect results or make another model decision.
""".strip()

WITHIN_RUN_GUIDANCE = """

This is the within-run adaptive treatment. Do not spend the opening minutes on
reflection. First establish a non-zero measured baseline. While a proven
background loop is earning XP, use retained failures and measured rate evidence
to improve the next attempt. If the trajectory contains a genuinely reusable
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

            prompt = _adapt_prompt(
                str(data.prompt),
                self.config.learning_mode,
            )
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


def _adapt_prompt(prompt: str, learning_mode: LearningMode) -> str:
    parts = [prompt.rstrip(), REPL_GUIDANCE]
    if learning_mode == "within-run":
        parts.append(WITHIN_RUN_GUIDANCE)
    return "\n\n".join(parts)


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


__all__ = [
    "BENCHMARK",
    "CATALOG_PATH",
    "DATASET",
    "TREATMENT",
    "RuneBenchConfig",
    "RuneBenchData",
    "RuneBenchTask",
    "RuneBenchTaskset",
]

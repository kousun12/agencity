from __future__ import annotations

import argparse
import hashlib
import json
import tomllib
from importlib.metadata import version
from pathlib import Path
from typing import Any

from agencity_oolong_synth.taskset import OolongSynthConfig, OolongSynthTaskset
from agencity_swe_bench_pro.taskset import (
    BENCHMARK as SWE_BENCHMARK,
    CATALOG_PATH as SWE_CATALOG,
    SWEProConfig,
)
from agencity_terminal_bench_2.taskset import (
    CATALOG_PATH as TB2_CATALOG,
    TerminalBench2Config,
)
from agencity_terminal_bench_2_1.taskset import (
    CATALOG_PATH as TB21_CATALOG,
    TerminalBench21Config,
)
from agencity_verifiers.selection import (
    catalog_digest,
    load_catalog,
    select_catalog_tasks,
)


CATALOG_TASKSETS = {
    "agencity-terminal-bench-2": (
        TerminalBench2Config,
        "terminal-bench-2",
        TB2_CATALOG,
    ),
    "agencity-terminal-bench-2-1": (
        TerminalBench21Config,
        "terminal-bench-2-1",
        TB21_CATALOG,
    ),
    "agencity-swe-bench-pro": (SWEProConfig, SWE_BENCHMARK, SWE_CATALOG),
}


def preflight(config_path: Path) -> dict[str, Any]:
    raw = tomllib.loads(config_path.read_text(encoding="utf-8"))
    taskset = raw.get("env", {}).get("taskset")
    if not isinstance(taskset, dict) or not isinstance(taskset.get("id"), str):
        raise ValueError(f"{config_path} has no [env.taskset] id")
    taskset_id = taskset["id"]
    if taskset_id in CATALOG_TASKSETS:
        config_type, benchmark, path = CATALOG_TASKSETS[taskset_id]
        config = config_type.model_validate(taskset)
        _validate_official_task_timeouts(raw)
        catalog = load_catalog(path, benchmark)
        _validate_catalog_pins(raw, catalog)
        selected, manifest = select_catalog_tasks(catalog, config.selection)
        return {
            **manifest,
            "config": str(config_path),
            "catalog_sha256": catalog_digest(path),
            "selected_pins": [
                {
                    key: task.get(key)
                    for key in (
                        "id",
                        "task_tree_sha256",
                        "public_selection_sha256",
                        "image",
                        "image_manifest_digest",
                        "image_config_digest",
                        "workdir",
                    )
                    if key in task
                }
                for task in selected
            ],
        }
    if taskset_id == "agencity-oolong-synth":
        config = OolongSynthConfig.model_validate(taskset)
        tasks = OolongSynthTaskset(config).load()
        return {
            "schema": "agencity.benchmark-selection.v1",
            "benchmark": "oolong-synth",
            "config": str(config_path),
            "mode": config.selection.mode,
            "selected_count": len(tasks),
            "selected_ids": [task.data.selection_id for task in tasks],
            "selected_ids_sha256": tasks[0].data.selected_ids_sha256,
            "selected_pins": [
                {
                    "id": task.data.selection_id,
                    "context_sha256": task.data.context_sha256,
                    "context_bytes": task.data.context_bytes,
                    "context_window_id": task.data.context_window_id,
                }
                for task in tasks
            ],
        }
    raise ValueError(f"unsupported suite taskset {taskset_id!r}")


def _validate_official_task_timeouts(raw_config: dict[str, Any]) -> None:
    env = raw_config.get("env")
    agent = env.get("agent") if isinstance(env, dict) else None
    timeout = agent.get("timeout") if isinstance(agent, dict) else None
    if not isinstance(timeout, dict):
        return
    overrides = [
        stage for stage in ("rollout", "scoring") if timeout.get(stage) is not None
    ]
    if overrides:
        rendered = ", ".join(overrides)
        raise ValueError(
            "catalog suite configs must omit env.agent.timeout "
            f"{rendered} overrides so official per-task timeouts remain authoritative"
        )


def _validate_catalog_pins(
    raw_config: dict[str, Any], catalog: dict[str, Any]
) -> None:
    lock_digest = hashlib.sha256(
        (Path(__file__).resolve().parent.parent / "uv.lock").read_bytes()
    ).hexdigest()
    if catalog.get("python_lock_sha256") != lock_digest:
        raise ValueError("catalog Python lock digest does not match uv.lock")

    runtime = catalog.get("runtime")
    if not isinstance(runtime, dict):
        raise ValueError("catalog runtime pins are missing")
    distributions = {
        "verifiers_version": "verifiers",
        "harbor_version": "harbor",
        "docker_sdk_version": "docker",
    }
    for field, distribution in distributions.items():
        expected = runtime.get(field)
        if expected is not None and version(distribution) != expected:
            raise ValueError(
                f"catalog {field} {expected!r} does not match installed "
                f"{version(distribution)!r}"
            )

    env = raw_config.get("env")
    agent = env.get("agent") if isinstance(env, dict) else None
    harness = agent.get("harness") if isinstance(agent, dict) else None
    taskset = env.get("taskset") if isinstance(env, dict) else None
    treatment_name = (
        taskset.get("treatment", "agencity-portable")
        if isinstance(taskset, dict)
        else None
    )
    treatments = catalog.get("treatments")
    treatment = (
        treatments.get(treatment_name)
        if isinstance(treatments, dict) and isinstance(treatment_name, str)
        else None
    )
    if not isinstance(harness, dict) or not isinstance(treatment, dict):
        raise ValueError("config harness or catalog treatment pins are missing")
    if treatment_name == "harness-native":
        if not isinstance(harness.get("id"), str) or not harness["id"]:
            raise ValueError("harness-native comparison requires a harness id")
        return
    expected_harness = {
        "id": treatment.get("harness"),
        "source_repo": treatment.get("source_repo"),
        "source_ref": treatment.get("source_ref"),
        "bun_url": treatment.get("bun_archive"),
        "bun_sha256": treatment.get("bun_archive_sha256"),
    }
    actual_harness = {key: harness.get(key) for key in expected_harness}
    if actual_harness != expected_harness:
        raise ValueError(
            "config harness/source/Bun pins do not match catalog treatment"
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Resolve a suite config to a bounded immutable selection manifest."
    )
    parser.add_argument("config", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    value = preflight(args.config)
    encoded = json.dumps(value, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")


if __name__ == "__main__":
    main()

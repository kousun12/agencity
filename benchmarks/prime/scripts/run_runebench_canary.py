from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import tomllib
from collections.abc import Callable
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "configs" / "runebench-attack-30m-adaptive.toml"
SCORED_OUTCOMES = {
    "passed",
    "valid_zero",
    "partial_reward",
    "agent_terminal_failure",
}
CommandRunner = Callable[[list[str], Path], subprocess.CompletedProcess[Any]]


def run_canary(
    config: Path,
    output_dir: Path,
    *,
    refresh_pins: bool,
    command_runner: CommandRunner | None = None,
) -> int:
    config = config.resolve()
    output_dir = output_dir.resolve()
    _validate_config(config)
    _require_empty_output(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    runner = command_runner or _run_command

    refresh = [sys.executable, str(ROOT / "scripts" / "refresh_agencity_source.py")]
    if refresh_pins:
        completed = runner(refresh, ROOT)
        if completed.returncode != 0:
            return completed.returncode
    completed = runner([*refresh, "--check"], ROOT)
    if completed.returncode != 0:
        return completed.returncode

    selection_path = output_dir / "selection.json"
    completed = runner(
        [
            sys.executable,
            str(ROOT / "scripts" / "preflight_suite.py"),
            str(config),
            "--output",
            str(selection_path),
        ],
        ROOT,
    )
    if completed.returncode != 0:
        return completed.returncode

    selection = _load_object(selection_path)
    _validate_selection(selection)
    dry_run_dir = output_dir / "dry-run"
    completed = runner(
        [
            "eval",
            "@",
            str(config),
            "--dry-run",
            "--output-dir",
            str(dry_run_dir),
        ],
        ROOT,
    )
    if completed.returncode != 0:
        return completed.returncode

    run_dir = output_dir / "run"
    evaluation = runner(
        ["eval", "@", str(config), "--output-dir", str(run_dir)],
        ROOT,
    )
    traces_path = run_dir / "traces.jsonl"
    if not traces_path.is_file():
        print(
            f"RuneBench canary produced no trace file: {traces_path}",
            file=sys.stderr,
        )
        return evaluation.returncode or 1

    summary_path = output_dir / "summary.json"
    report = runner(
        [
            sys.executable,
            "-m",
            "agencity_verifiers.reporting",
            str(run_dir),
            "--selection",
            str(selection_path),
            "--output",
            str(summary_path),
        ],
        ROOT,
    )
    if report.returncode != 0:
        return report.returncode
    if evaluation.returncode != 0:
        return evaluation.returncode

    summary = _load_object(summary_path)
    problem = scoring_completeness_error(selection, summary)
    if problem is not None:
        print(f"RuneBench canary is not completely scored: {problem}", file=sys.stderr)
        return 1
    print(
        "RuneBench canary completed with one official score for every selected task"
    )
    return 0


def scoring_completeness_error(
    selection: dict[str, Any],
    summary: dict[str, Any],
) -> str | None:
    selected = selection.get("selected_ids")
    tasks = summary.get("tasks")
    if not isinstance(selected, list) or not all(
        isinstance(task_id, str) and task_id for task_id in selected
    ):
        return "selection has no exact task IDs"
    if not isinstance(tasks, list):
        return "summary has no task records"
    expected = set(selected)
    if len(expected) != len(selected):
        return "selection contains duplicate task IDs"
    observed: dict[str, dict[str, Any]] = {}
    for task in tasks:
        if not isinstance(task, dict) or not isinstance(task.get("task_id"), str):
            return "summary contains a task without an ID"
        task_id = task["task_id"]
        if task_id in observed:
            return f"summary contains duplicate task {task_id}"
        observed[task_id] = task
    missing = sorted(expected - observed.keys())
    unexpected = sorted(observed.keys() - expected)
    if missing:
        return f"missing task records: {', '.join(missing)}"
    if unexpected:
        return f"unexpected task records: {', '.join(unexpected)}"
    for task_id in selected:
        task = observed[task_id]
        reward = task.get("reward")
        if (
            task.get("outcome") not in SCORED_OUTCOMES
            or not _is_finite_number(reward)
        ):
            return (
                f"{task_id} has outcome {task.get('outcome')!r} "
                "without an official numeric score"
            )
    counts = summary.get("counts")
    if not isinstance(counts, dict) or counts.get("officially_scored") != len(selected):
        return "official score count does not match the selected task count"
    return None


def _is_finite_number(value: object) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def _validate_config(path: Path) -> None:
    value = tomllib.loads(path.read_text(encoding="utf-8"))
    taskset = value.get("env", {}).get("taskset", {})
    selection = taskset.get("selection", {}) if isinstance(taskset, dict) else {}
    if (
        not isinstance(taskset, dict)
        or taskset.get("id") != "agencity-runebench"
        or not isinstance(selection, dict)
        or selection.get("mode") != "exact"
        or value.get("num_tasks") != 1
        or value.get("num_rollouts") != 1
        or value.get("max_concurrent") != 1
    ):
        raise ValueError(
            "RuneBench canary requires one exact task, one rollout, and serial execution"
        )


def _validate_selection(value: dict[str, Any]) -> None:
    selected = value.get("selected_ids")
    if (
        value.get("benchmark") != "runebench"
        or value.get("mode") != "exact"
        or value.get("selected_count") != 1
        or not isinstance(selected, list)
        or len(selected) != 1
    ):
        raise ValueError("RuneBench preflight did not resolve one exact task")


def _require_empty_output(path: Path) -> None:
    if path.exists() and (not path.is_dir() or any(path.iterdir())):
        raise ValueError(f"RuneBench canary output must be a new empty directory: {path}")


def _load_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} is not a JSON object")
    return value


def _run_command(
    command: list[str],
    cwd: Path,
) -> subprocess.CompletedProcess[Any]:
    print("+", " ".join(command))
    return subprocess.run(command, cwd=cwd, check=False)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Run one exact serial RuneBench canary and fail unless every selected "
            "task has an official numeric score."
        )
    )
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--refresh-pins",
        action="store_true",
        help="Update every benchmark Agencity source pin to remote main before checking",
    )
    args = parser.parse_args()
    try:
        return run_canary(
            args.config,
            args.output_dir,
            refresh_pins=args.refresh_pins,
        )
    except (OSError, ValueError, json.JSONDecodeError, tomllib.TOMLDecodeError) as error:
        print(f"RuneBench canary setup failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

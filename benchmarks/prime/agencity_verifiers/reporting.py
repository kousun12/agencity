from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any


OUTCOMES = (
    "passed",
    "valid_zero",
    "partial_reward",
    "harness_terminal_failure",
    "provider_failure",
    "scorer_or_infrastructure_error",
    "skipped",
    "cancelled",
    "unknown",
)


def summarize_records(
    records: list[dict[str, Any]],
    *,
    selection: dict[str, Any] | None = None,
    config_bytes: bytes | None = None,
) -> dict[str, Any]:
    outcomes: Counter[str] = Counter()
    score_classes: Counter[str] = Counter()
    rewards: list[float] = []
    calls = 0
    prompt_tokens = 0
    completion_tokens = 0
    cached_input_tokens = 0
    reasoning_tokens = 0
    reported_cost = 0.0
    has_cached = has_reasoning = has_cost = False
    model_seconds = 0.0
    agent_seconds = 0.0
    task_results: list[dict[str, Any]] = []
    provenance_variants: dict[str, dict[str, Any]] = {}

    for episode in records:
        traces = episode.get("traces")
        traces = traces if isinstance(traces, list) else []
        if not traces:
            outcome = "scorer_or_infrastructure_error"
            outcomes[outcome] += 1
            task_results.append(
                {
                    "task_id": None,
                    "outcome": outcome,
                    "reward": None,
                    "terminal_status": None,
                }
            )
            continue
        trace = traces[0]
        provenance = _trace_provenance(trace)
        provenance_variants[
            hashlib.sha256(
                json.dumps(provenance, sort_keys=True, separators=(",", ":")).encode(
                    "utf-8"
                )
            ).hexdigest()
        ] = provenance
        task = trace.get("task") if isinstance(trace, dict) else {}
        data = task.get("data") if isinstance(task, dict) else {}
        task_id = (
            data.get("selection_id")
            or data.get("instance_id")
            or data.get("name")
            or data.get("idx")
        )
        reward = _trace_reward(trace)
        terminal = _terminal_status(trace)
        outcome = _classify(episode, trace, terminal, reward)
        outcomes[outcome] += 1
        if reward is not None:
            rewards.append(reward)
            if reward == 0:
                score_classes["zero"] += 1
            elif reward == 1:
                score_classes["pass"] += 1
            else:
                score_classes["partial"] += 1

        trace_calls = trace.get("calls")
        trace_calls = trace_calls if isinstance(trace_calls, list) else []
        calls += len(trace_calls)
        for call in trace_calls:
            usage = call.get("usage") if isinstance(call, dict) else None
            if isinstance(usage, dict):
                prompt_tokens += _integer(usage.get("prompt_tokens"))
                completion_tokens += _integer(usage.get("completion_tokens"))
                if usage.get("cached_input_tokens") is not None:
                    has_cached = True
                    cached_input_tokens += _integer(usage.get("cached_input_tokens"))
                if usage.get("reasoning_tokens") is not None:
                    has_reasoning = True
                    reasoning_tokens += _integer(usage.get("reasoning_tokens"))
                if usage.get("cost") is not None:
                    has_cost = True
                    reported_cost += float(usage["cost"])
            span = call.get("time") if isinstance(call, dict) else None
            if isinstance(span, dict):
                model_seconds += max(
                    0.0, float(span.get("end") or 0) - float(span.get("start") or 0)
                )
        timing = trace.get("timing")
        if isinstance(timing, dict) and isinstance(timing.get("agent"), dict):
            span = timing["agent"]
            agent_seconds += max(
                0.0, float(span.get("end") or 0) - float(span.get("start") or 0)
            )
        task_results.append(
            {
                "task_id": task_id,
                "outcome": outcome,
                "reward": reward,
                "terminal_status": terminal,
            }
        )

    selected_count = (
        selection.get("selected_count")
        if isinstance(selection, dict)
        else len(records)
    )
    incompatible = (
        selection.get("incompatible", []) if isinstance(selection, dict) else []
    )
    summary = {
        "schema": "agencity.benchmark-summary.v1",
        "failure_policy": {
            "aggregate_denominator": "officially_scored_tasks_only",
            "infrastructure_errors_in_reward": False,
            "unscored_harness_failures_in_reward": False,
        },
        "counts": {
            **{name: outcomes[name] for name in OUTCOMES},
            "selected": selected_count,
            "completed_records": len(records),
            "officially_scored": len(rewards),
            "incompatible": len(incompatible),
        },
        "score_counts": {
            "passed": score_classes["pass"],
            "valid_zero": score_classes["zero"],
            "partial": score_classes["partial"],
        },
        "reward": {
            "sum": sum(rewards),
            "denominator": len(rewards),
            "mean": sum(rewards) / len(rewards) if rewards else None,
        },
        "usage": {
            "model_calls": calls,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "cached_input_tokens": cached_input_tokens if has_cached else None,
            "reasoning_tokens": reasoning_tokens if has_reasoning else None,
            "provider_reported_cost": reported_cost if has_cost else None,
            "model_seconds": model_seconds,
            "agent_seconds": agent_seconds,
        },
        "selection": selection,
        "run_provenance": [
            {"sha256": digest, **provenance_variants[digest]}
            for digest in sorted(provenance_variants)
        ],
        "config_sha256": hashlib.sha256(config_bytes).hexdigest()
        if config_bytes is not None
        else None,
        "tasks": task_results,
    }
    return summary


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{line_number} is not a JSON object")
        records.append(value)
    return records


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create a deterministic mixed-outcome benchmark summary."
    )
    parser.add_argument("run", type=Path, help="Verifiers output directory or traces.jsonl")
    parser.add_argument("--selection", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    traces = args.run / "traces.jsonl" if args.run.is_dir() else args.run
    config = args.run / "config.toml" if args.run.is_dir() else None
    selection = (
        json.loads(args.selection.read_text(encoding="utf-8"))
        if args.selection is not None
        else None
    )
    result = summarize_records(
        load_jsonl(traces),
        selection=selection,
        config_bytes=config.read_bytes() if config is not None and config.is_file() else None,
    )
    encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")


def _classify(
    episode: dict[str, Any],
    trace: dict[str, Any],
    terminal: str | None,
    reward: float | None,
) -> str:
    errors = [
        *(
            episode.get("errors")
            if isinstance(episode.get("errors"), list)
            else []
        ),
        *(trace.get("errors") if isinstance(trace.get("errors"), list) else []),
    ]
    error_types = {
        error.get("type")
        for error in errors
        if isinstance(error, dict) and isinstance(error.get("type"), str)
    }
    if (
        episode.get("status") == "skipped"
        or trace.get("status") == "skipped"
        or error_types.intersection(
            {"SkipError", "SkippedTaskError", "TaskUnavailableError"}
        )
    ):
        return "skipped"
    if "ProviderError" in error_types or "OverlongPromptError" in error_types:
        return "provider_failure"
    if errors:
        return "scorer_or_infrastructure_error"
    if terminal == "cancelled":
        return "cancelled"
    if terminal == "unknown":
        return "unknown"
    if terminal is not None and terminal != "succeeded":
        return "harness_terminal_failure"
    if reward is None:
        return "scorer_or_infrastructure_error"
    if reward == 0:
        return "valid_zero"
    if reward == 1:
        return "passed"
    return "partial_reward"


def _trace_reward(trace: dict[str, Any]) -> float | None:
    rewards = trace.get("rewards")
    if not isinstance(rewards, dict) or not rewards:
        return None
    values: list[float] = []
    for reward in rewards.values():
        if reward is None:
            return None
        if not isinstance(reward, dict):
            return None
        values.append(float(reward.get("score", 0)) * float(reward.get("weight", 1)))
    return sum(values)


def _terminal_status(trace: dict[str, Any]) -> str | None:
    info = trace.get("info")
    agencity = info.get("agencity") if isinstance(info, dict) else None
    status = agencity.get("status") if isinstance(agencity, dict) else None
    return status if isinstance(status, str) else None


def _integer(value: object) -> int:
    return int(value) if isinstance(value, int) and not isinstance(value, bool) else 0


def _trace_provenance(trace: dict[str, Any]) -> dict[str, Any]:
    agent = trace.get("agent")
    config = agent.get("config") if isinstance(agent, dict) else None
    config = config if isinstance(config, dict) else {}
    harness = config.get("harness")
    runtime = config.get("runtime")
    sampling = config.get("sampling")
    info = trace.get("info")
    benchmark = info.get("benchmark_provenance") if isinstance(info, dict) else None
    if not isinstance(benchmark, dict):
        benchmark = _task_data_provenance(trace)
    return {
        "model": config.get("model"),
        "sampling": sampling if isinstance(sampling, dict) else None,
        "harness": _safe_fields(
            harness,
            (
                "id",
                "source_repo",
                "source_ref",
                "installation",
                "bun_url",
                "bun_sha256",
            ),
        ),
        "runtime": _safe_fields(
            runtime,
            ("type", "image", "cpu", "memory", "disk", "gpu"),
        ),
        "limits": _safe_fields(
            config,
            (
                "max_turns",
                "max_input_tokens",
                "max_output_tokens",
                "max_total_tokens",
                "timeout",
                "retries",
            ),
        ),
        "benchmark": benchmark if isinstance(benchmark, dict) else None,
    }


def _task_data_provenance(trace: dict[str, Any]) -> dict[str, Any] | None:
    task = trace.get("task")
    data = task.get("data") if isinstance(task, dict) else None
    if not isinstance(data, dict):
        return None
    benchmark = data.get("benchmark")
    if not isinstance(benchmark, str):
        if "selection_manifest_sha256" in data:
            benchmark = "oolong-synth"
        elif "public_selection_sha256" in data:
            benchmark = "swe-bench-pro-public"
        else:
            benchmark = None
    fields = (
        "selection_id",
        "catalog_sha256",
        "catalog_tasks_sha256",
        "selected_ids",
        "selected_ids_sha256",
        "dataset_id",
        "dataset_revision",
        "dataset_name",
        "context_len",
        "context_window_id",
        "context_sha256",
        "context_bytes",
        "selection_manifest_id",
        "selection_manifest_sha256",
        "scorer_repository",
        "scorer_commit",
        "scorer_path",
        "scorer_sha256",
        "repository",
        "base_commit",
        "public_selection_sha256",
        "task_tree_sha256",
        "task_toml_sha256",
        "image",
        "image_manifest_digest",
        "image_config_digest",
        "workdir",
        "treatment",
    )
    retained = {name: data[name] for name in fields if name in data}
    if benchmark is not None:
        retained["benchmark"] = benchmark
    return retained or None


def _safe_fields(value: object, names: tuple[str, ...]) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    return {name: value.get(name) for name in names if name in value}


if __name__ == "__main__":
    main()

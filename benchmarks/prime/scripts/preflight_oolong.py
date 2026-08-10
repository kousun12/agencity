from __future__ import annotations

import argparse
import json
from pathlib import Path

from agencity_oolong_synth.taskset import (
    DATASET_REVISION,
    OolongSynthConfig,
    OolongSynthTaskset,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Resolve and validate a pinned OOLONG-synth selection."
    )
    parser.add_argument("--split", choices=["validation", "test"], default="test")
    parser.add_argument("--dataset-name", default="yahoo")
    parser.add_argument("--context-len", type=int, default=131072)
    parser.add_argument("--expected-tasks", type=int, default=50)
    parser.add_argument("--cache-dir")
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = OolongSynthConfig(
        id="agencity-oolong-synth",
        split=args.split,
        dataset_name=args.dataset_name,
        context_len=args.context_len,
        expected_tasks=args.expected_tasks,
        dataset_revision=DATASET_REVISION,
        cache_dir=args.cache_dir,
    )
    tasks = OolongSynthTaskset(config).load()

    contexts: dict[int, dict[str, object]] = {}
    entries: list[dict[str, object]] = []
    for task in tasks:
        data = task.data
        existing = contexts.setdefault(
            data.context_window_id,
            {
                "contextWindowId": data.context_window_id,
                "sha256": data.context_sha256,
                "bytes": data.context_bytes,
            },
        )
        if (
            existing["sha256"] != data.context_sha256
            or existing["bytes"] != data.context_bytes
        ):
            raise ValueError(
                f"context window {data.context_window_id} has inconsistent content"
            )
        entries.append(
            {
                "rowId": data.row_id,
                "contextWindowId": data.context_window_id,
                "contextSha256": data.context_sha256,
                "contextBytes": data.context_bytes,
                "answerType": data.answer_type,
            }
        )

    manifest = {
        "protocol": "agencity.oolong-selection",
        "version": 1,
        "dataset": "oolongbench/oolong-synth",
        "revision": DATASET_REVISION,
        "split": args.split,
        "datasetName": args.dataset_name,
        "contextLength": args.context_len,
        "withLabels": False,
        "filterNumerical": False,
        "taskCount": len(tasks),
        "contextWindowCount": len(contexts),
        "contexts": sorted(contexts.values(), key=lambda value: value["contextWindowId"]),
        "tasks": entries,
    }
    encoded = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")


if __name__ == "__main__":
    main()

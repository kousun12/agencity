from __future__ import annotations

import argparse
import json
from pathlib import Path

from agencity_oolong_synth.taskset import (
    DATASET_REVISION,
    OolongSynthConfig,
    OolongSynthTaskset,
)
from agencity_verifiers.selection import SelectionSpec


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
    parser.add_argument("--check", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    # Catalog generation is the only unmanifested load of the pinned comparison
    # slice. Runtime configs use normal validation and cannot bypass the pin.
    config = OolongSynthConfig.model_construct(
        id="agencity-oolong-synth",
        split=args.split,
        dataset_name=args.dataset_name,
        context_len=args.context_len,
        expected_tasks=args.expected_tasks,
        dataset_revision=DATASET_REVISION,
        cache_dir=args.cache_dir,
        selection=SelectionSpec(mode="all"),
        selection_manifest="none",
        selection_manifest_sha256=None,
    )
    tasks = OolongSynthTaskset(config).load()
    manifest = build_manifest(tasks, config)
    encoded = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    if args.check is not None:
        expected = args.check.read_text(encoding="utf-8")
        if expected != encoded:
            raise ValueError(
                f"generated OOLONG selection differs from {args.check}"
            )
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")


def build_manifest(
    tasks,
    config: OolongSynthConfig,
) -> dict[str, object]:
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
        "split": config.split,
        "datasetName": config.dataset_name,
        "contextLength": config.context_len,
        "withLabels": config.with_labels,
        "filterNumerical": config.filter_numerical,
        "taskCount": len(tasks),
        "contextWindowCount": len(contexts),
        "contexts": sorted(contexts.values(), key=lambda value: value["contextWindowId"]),
        "tasks": entries,
    }
    return manifest


if __name__ == "__main__":
    main()

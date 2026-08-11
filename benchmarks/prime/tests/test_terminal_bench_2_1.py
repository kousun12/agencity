from __future__ import annotations

import unittest

from agencity_terminal_bench_2_1.taskset import (
    CATALOG_PATH,
    DATASET,
    TerminalBench21Config,
    TerminalBench21Task,
    TerminalBench21Taskset,
)
from agencity_verifiers.selection import SelectionSpec, load_catalog
from verifiers.v1.tasksets.harbor import HarborTask


class TerminalBench21CatalogTests(unittest.TestCase):
    def test_distinct_catalog_pins_all_89_refreshed_tasks(self) -> None:
        catalog = load_catalog(CATALOG_PATH, "terminal-bench-2-1")
        self.assertEqual(catalog["dataset"]["package"], DATASET)
        self.assertEqual(len(catalog["tasks"]), 89)
        self.assertTrue(all(task["compatible"] for task in catalog["tasks"]))
        fix_git = next(task for task in catalog["tasks"] if task["id"] == "fix-git")
        self.assertEqual(
            fix_git["image_manifest_digest"],
            "sha256:389b9c8247610c2c5be080b1ac00429007c2c69bf57f7f26c79f0f75ba2d5c74",
        )

    def test_smoke_sample_shard_and_full_resolve_deterministically(self) -> None:
        cases = (
            (SelectionSpec(mode="smoke", subset="fix-git"), 1),
            (SelectionSpec(mode="sample", count=3, seed=20260811), 3),
            (SelectionSpec(mode="shard", shard_index=0, shard_count=4), 21),
            (SelectionSpec(mode="all"), 89),
        )
        for selection, expected in cases:
            tasks = list(
                TerminalBench21Taskset(
                    TerminalBench21Config(
                        id="agencity-terminal-bench-2-1",
                        selection=selection,
                    )
                ).load()
            )
            self.assertEqual(len(tasks), expected)
            self.assertTrue(
                all(isinstance(task, TerminalBench21Task) for task in tasks)
            )

    def test_explicit_selection_runs_beyond_fix_git(self) -> None:
        config = TerminalBench21Config(
            id="agencity-terminal-bench-2-1",
            selection=SelectionSpec(
                mode="ids", ids=["regex-log", "sanitize-git-repo"]
            ),
        )
        tasks = list(TerminalBench21Taskset(config).load())
        self.assertEqual(
            [task.data.selection_id for task in tasks],
            ["regex-log", "sanitize-git-repo"],
        )
        self.assertEqual(len({task.data.image for task in tasks}), 2)

    def test_upstream_harbor_scorer_remains_authoritative(self) -> None:
        self.assertIs(TerminalBench21Task.solved, HarborTask.solved)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import copy
import unittest

from agencity_verifiers.reporting import summarize_records
from agencity_verifiers.selection import (
    CatalogError,
    SelectionSpec,
    select_catalog_tasks,
    select_loaded_items,
    task_entries_digest,
)


def catalog() -> dict:
    tasks = [
        {"id": f"task-{index}", "compatible": True, "incompatibility_reasons": []}
        for index in range(8)
    ] + [
        {
            "id": "unsupported",
            "compatible": False,
            "incompatibility_reasons": [{"code": "no_image", "detail": "missing"}],
        }
    ]
    return {
        "schema": "agencity.benchmark-catalog.v1",
        "benchmark": "test",
        "tasks": tasks,
        "tasks_sha256": task_entries_digest(tasks),
        "smoke_subsets": {"default": ["task-0"], "pair": ["task-0", "task-1"]},
    }


class SelectionTests(unittest.TestCase):
    def test_exact_explicit_smoke_and_all_share_one_catalog(self) -> None:
        value = catalog()
        exact, _ = select_catalog_tasks(
            value, SelectionSpec(mode="exact", ids=["task-3"])
        )
        explicit, _ = select_catalog_tasks(
            value, SelectionSpec(mode="ids", ids=["task-3", "task-1"])
        )
        smoke, _ = select_catalog_tasks(
            value, SelectionSpec(mode="smoke", subset="pair")
        )
        full, manifest = select_catalog_tasks(value, SelectionSpec(mode="all"))
        self.assertEqual([task["id"] for task in exact], ["task-3"])
        self.assertEqual([task["id"] for task in explicit], ["task-3", "task-1"])
        self.assertEqual([task["id"] for task in smoke], ["task-0", "task-1"])
        self.assertEqual(len(full), 8)
        self.assertEqual(manifest["incompatible_task_count"], 1)
        self.assertEqual(manifest["incompatible"][0]["id"], "unsupported")

    def test_sample_and_shards_are_deterministic_and_complete(self) -> None:
        value = catalog()
        first, first_manifest = select_catalog_tasks(
            value, SelectionSpec(mode="sample", count=3, seed=42)
        )
        second, second_manifest = select_catalog_tasks(
            value, SelectionSpec(mode="sample", count=3, seed=42)
        )
        self.assertEqual(first, second)
        self.assertEqual(
            first_manifest["selected_ids_sha256"],
            second_manifest["selected_ids_sha256"],
        )
        shards = [
            select_catalog_tasks(
                value,
                SelectionSpec(mode="shard", shard_index=index, shard_count=3),
            )[0]
            for index in range(3)
        ]
        identifiers = [task["id"] for shard in shards for task in shard]
        self.assertEqual(sorted(identifiers), [f"task-{index}" for index in range(8)])
        self.assertEqual(len(identifiers), len(set(identifiers)))

    def test_incompatible_and_unknown_ids_fail_visibly(self) -> None:
        with self.assertRaisesRegex(CatalogError, "incompatible"):
            select_catalog_tasks(
                catalog(), SelectionSpec(mode="exact", ids=["unsupported"])
            )
        with self.assertRaisesRegex(CatalogError, "unknown"):
            select_catalog_tasks(
                catalog(), SelectionSpec(mode="exact", ids=["missing"])
            )

    def test_catalog_task_digest_detects_pin_mutation(self) -> None:
        value = catalog()
        original = value["tasks_sha256"]
        changed = copy.deepcopy(value["tasks"])
        changed[0]["compatible"] = False
        self.assertNotEqual(original, task_entries_digest(changed))

    def test_dynamic_selection_preserves_manifest_order(self) -> None:
        items = [{"id": f"task-{index}"} for index in range(5)]
        selected, manifest = select_loaded_items(
            items,
            SelectionSpec(mode="ids", ids=["task-3", "task-1"]),
            identifier=lambda item: item["id"],
            smoke_subsets={"default": ["task-0"]},
        )
        self.assertEqual(
            [item["id"] for item in selected],
            manifest["selected_ids"],
        )


def trace(
    task_id: str,
    *,
    reward: float | None,
    status: str = "succeeded",
    error_type: str | None = None,
) -> dict:
    rewards = (
        {"official": {"score": reward, "weight": 1.0}}
        if reward is not None
        else {}
    )
    errors = (
        [{"type": error_type, "message": "failure"}] if error_type is not None else []
    )
    return {
        "ok": not errors,
        "errors": errors,
        "agent": {
            "config": {
                "model": "openai/example",
                "sampling": {"temperature": 0},
                "harness": {
                    "id": "agencity-verifiers",
                    "source_ref": "a" * 40,
                },
                "runtime": {
                    "type": "docker",
                    "image": "example@sha256:" + "b" * 64,
                },
                "client": {"headers": {"x-private": "secret"}},
                "max_turns": 8,
            }
        },
        "task": {"data": {"selection_id": task_id}},
        "info": {
            "agencity": {"status": status},
            "benchmark_provenance": {
                "catalog_sha256": "c" * 64,
                "selected_ids": ["pass", "zero"],
            },
        },
        "rewards": rewards,
        "calls": [
            {
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 2,
                    "cached_input_tokens": 3,
                    "reasoning_tokens": 1,
                    "cost": 0.01,
                },
                "time": {"start": 1, "end": 2},
            }
        ],
        "timing": {"agent": {"start": 1, "end": 3}},
    }


class ReportingTests(unittest.TestCase):
    def test_mixed_outcomes_keep_zero_and_infrastructure_separate(self) -> None:
        records = [
            {"errors": [], "traces": [trace("pass", reward=1)]},
            {"errors": [], "traces": [trace("zero", reward=0)]},
            {
                "errors": [],
                "traces": [trace("failed", reward=0, status="failed")],
            },
            {
                "errors": [],
                "traces": [trace("provider", reward=None, error_type="ProviderError")],
            },
            {
                "errors": [{"type": "EnvError", "message": "scorer failed"}],
                "traces": [trace("scorer", reward=None)],
            },
            {
                "status": "skipped",
                "errors": [],
                "traces": [trace("skipped", reward=None)],
            },
            {"errors": [], "traces": [trace("cancelled", reward=None, status="cancelled")]},
            {"errors": [], "traces": [trace("unknown", reward=None, status="unknown")]},
        ]
        summary = summarize_records(
            records,
            selection={
                "selected_count": len(records),
                "incompatible": [
                    {
                        "id": "unsupported",
                        "reasons": [{"code": "no_image", "detail": "missing"}],
                    }
                ],
            },
        )
        counts = summary["counts"]
        self.assertEqual(counts["passed"], 1)
        self.assertEqual(counts["valid_zero"], 1)
        self.assertEqual(counts["harness_terminal_failure"], 1)
        self.assertEqual(counts["provider_failure"], 1)
        self.assertEqual(counts["scorer_or_infrastructure_error"], 1)
        self.assertEqual(counts["skipped"], 1)
        self.assertEqual(counts["incompatible"], 1)
        self.assertEqual(counts["cancelled"], 1)
        self.assertEqual(counts["unknown"], 1)
        self.assertEqual(summary["score_counts"]["valid_zero"], 2)
        self.assertEqual(summary["reward"]["denominator"], 3)
        self.assertAlmostEqual(summary["reward"]["mean"], 1 / 3)
        self.assertFalse(
            summary["failure_policy"]["infrastructure_errors_in_reward"]
        )
        self.assertEqual(summary["usage"]["model_calls"], 8)
        self.assertAlmostEqual(summary["usage"]["provider_reported_cost"], 0.08)
        self.assertEqual(len(summary["run_provenance"]), 1)
        self.assertEqual(summary["run_provenance"][0]["model"], "openai/example")
        self.assertNotIn("secret", str(summary["run_provenance"]))

    def test_infrastructure_error_falls_back_to_safe_task_provenance(self) -> None:
        failed = trace("task-1", reward=None, error_type="TaskError")
        failed["info"].pop("benchmark_provenance")
        failed["task"]["data"].update(
            {
                "benchmark": "terminal-bench-2",
                "catalog_sha256": "c" * 64,
                "selected_ids": ["task-1"],
                "answer": "must-not-be-reported",
            }
        )
        summary = summarize_records([{"errors": [], "traces": [failed]}])
        provenance = summary["run_provenance"][0]["benchmark"]
        self.assertEqual(provenance["benchmark"], "terminal-bench-2")
        self.assertEqual(provenance["selection_id"], "task-1")
        self.assertNotIn("answer", provenance)
        self.assertNotIn("must-not-be-reported", str(summary))


if __name__ == "__main__":
    unittest.main()

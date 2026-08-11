from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from agencity_terminal_bench_2.taskset import _sha256_tree
from agencity_terminal_bench_2_1.taskset import (
    DECLARED_IMAGE,
    TASK_ID,
    TASK_IMAGE,
    TASK_NAME,
    TASK_WORKSPACE,
    TerminalBench21Config,
    TerminalBench21Task,
    TerminalBench21Taskset,
    load_manifest,
    validate_task_tree,
)
from agencity_verifiers.harness import _agencity_command
from verifiers.v1.tasksets.harbor import HarborData, HarborTask, HarborTaskset


def harbor_task(
    *, name: str = TASK_NAME, image: str | None = DECLARED_IMAGE, workdir: str | None = None
) -> HarborTask:
    return HarborTask(
        HarborData(
            idx=0,
            name=name,
            prompt="public task prompt",
            image=image,
            workdir=workdir,
            task_dir="/host/harbor/fix-git",
        )
    )


class TerminalBench21ManifestTests(unittest.TestCase):
    def test_manifest_pins_the_refreshed_dataset_and_task(self) -> None:
        manifest = load_manifest()
        self.assertEqual(manifest["selection"]["task_id"], TASK_ID)
        self.assertEqual(manifest["selection"]["image"], TASK_IMAGE)
        self.assertTrue(manifest["selection"]["dataset"].endswith(
            "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a"
        ))
        self.assertIn("selection_rationale", manifest["treatment"])

    def test_manifest_rejects_task_drift(self) -> None:
        value = load_manifest()
        value["selection"]["task_id"] = "other"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "selection"):
                load_manifest(path)

    def test_config_refuses_multiple_tasks(self) -> None:
        self.assertEqual(TerminalBench21Config().tasks, [TASK_ID])
        with self.assertRaisesRegex(ValueError, "exactly"):
            TerminalBench21Config(tasks=[TASK_ID, "regex-log"])

    def test_task_tree_tampering_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "tests").mkdir()
            verifier = root / "tests" / "test.sh"
            verifier.write_text("exit 0\n", encoding="utf-8")
            expected = _sha256_tree(root)
            validate_task_tree(root, expected)
            verifier.write_text("exit 1\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "task tree"):
                validate_task_tree(root, expected)


class TerminalBench21SelectionTests(unittest.TestCase):
    def test_taskset_rewrites_only_the_manifest_task(self) -> None:
        manifest = load_manifest()
        config = TerminalBench21Config(id="agencity-terminal-bench-2-1")
        with (
            patch.object(HarborTaskset, "load", return_value=iter([harbor_task()])),
            patch(
                "agencity_terminal_bench_2_1.taskset._sha256_file",
                side_effect=lambda path: (
                    manifest["python_lock_sha256"]
                    if path.name == "uv.lock"
                    else manifest["selection"]["task_toml_sha256"]
                ),
            ),
            patch("agencity_terminal_bench_2_1.taskset.validate_task_tree"),
        ):
            tasks = list(TerminalBench21Taskset(config).load())
        self.assertEqual(len(tasks), 1)
        self.assertIsInstance(tasks[0], TerminalBench21Task)
        self.assertEqual(tasks[0].data.image, TASK_IMAGE)
        self.assertEqual(tasks[0].data.workdir, TASK_WORKSPACE)

    def test_upstream_harbor_verifier_remains_authoritative_and_hidden(self) -> None:
        self.assertIs(TerminalBench21Task.solved, HarborTask.solved)
        command = _agencity_command(
            "openai",
            "openai/gpt-5.6-luna",
            "high",
            "public task text",
            workspace=TASK_WORKSPACE,
            installation="portable",
        )
        self.assertIn(TASK_WORKSPACE, command)
        self.assertNotIn("/tests", command)
        self.assertNotIn("/host/harbor/fix-git", command)


class TerminalBench21LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_finalization_stops_service_and_removes_metadata_before_scoring(self) -> None:
        task = TerminalBench21Task(
            HarborData(
                idx=0,
                name=TASK_NAME,
                prompt="task",
                image=TASK_IMAGE,
                workdir=TASK_WORKSPACE,
                task_dir="/host/task",
            )
        )
        trace = SimpleNamespace(info={"agencity": {"status": "succeeded"}})
        shutdown = AsyncMock(return_value="stopped")
        cleanup = AsyncMock(return_value="workspace-metadata-and-state-removed")
        harbor_finalize = AsyncMock()
        with (
            patch("agencity_terminal_bench_2_1.taskset._shutdown_portable", shutdown),
            patch("agencity_terminal_bench_2_1.taskset._cleanup_portable", cleanup),
            patch.object(HarborTask, "finalize", harbor_finalize),
        ):
            await task.finalize(trace, SimpleNamespace())
        shutdown.assert_awaited_once()
        cleanup.assert_awaited_once()
        harbor_finalize.assert_awaited_once()
        self.assertEqual(trace.info["agencity"]["service_shutdown"], "stopped")
        self.assertEqual(
            trace.info["agencity"]["cleanup"], "workspace-metadata-and-state-removed"
        )


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from agencity_terminal_bench_2.taskset import (
    CATALOG_PATH,
    DATASET,
    TerminalBench2Config,
    TerminalBench2Task,
    TerminalBench2Taskset,
)
from agencity_verifiers.bootstrap import _archive_bootstrap, _is_commit_sha
from agencity_verifiers.harbor_suite import (
    HarborSuiteTask,
    _require_harbor_reward_evidence,
)
from agencity_verifiers.harness import (
    PORTABLE_ARTIFACTS_DIR,
    PORTABLE_GIT_EXCLUDES_PATH,
    PORTABLE_PROFILE_PATH,
    PORTABLE_STATE_DIR,
    AgencityHarness,
    AgencityHarnessConfig,
    _agencity_command,
    _agencity_service_command,
    _cleanup_portable,
    _evaluation_environment,
    _prepare_portable_workspace,
    _shutdown_portable,
)
from agencity_verifiers.selection import SelectionSpec, load_catalog
from verifiers.v1.tasksets.harbor import HarborTask


class CatalogTests(unittest.TestCase):
    def test_catalog_pins_all_89_tasks_and_images(self) -> None:
        catalog = load_catalog(CATALOG_PATH, "terminal-bench-2")
        self.assertEqual(catalog["dataset"]["package"], DATASET)
        self.assertEqual(len(catalog["tasks"]), 89)
        self.assertEqual(
            sum(task["compatible"] for task in catalog["tasks"]), 89
        )
        for task in catalog["tasks"]:
            self.assertTrue(task["image"].endswith(task["image_manifest_digest"]))
            self.assertTrue(task["image_config_digest"].startswith("sha256:"))
            self.assertTrue(task["workdir"].startswith("/"))
            self.assertEqual(len(task["task_tree_sha256"]), 64)

    def test_smoke_sample_shard_and_full_load_the_same_task_class(self) -> None:
        expected = {"smoke": 1, "sample": 3, "shard": 21, "all": 89}
        specs = {
            "smoke": SelectionSpec(mode="smoke", subset="fix-git"),
            "sample": SelectionSpec(mode="sample", count=3, seed=20260811),
            "shard": SelectionSpec(mode="shard", shard_index=0, shard_count=4),
            "all": SelectionSpec(mode="all"),
        }
        for name, selection in specs.items():
            config = TerminalBench2Config(
                id="agencity-terminal-bench-2", selection=selection
            )
            tasks = list(TerminalBench2Taskset(config).load())
            self.assertEqual(len(tasks), expected[name])
            self.assertTrue(all(isinstance(task, TerminalBench2Task) for task in tasks))
        sample_ids = [
            task.data.selection_id
            for task in TerminalBench2Taskset(
                TerminalBench2Config(
                    id="agencity-terminal-bench-2",
                    selection=SelectionSpec(mode="sample", count=3, seed=20260811),
                )
            ).load()
        ]
        self.assertEqual(
            sample_ids,
            ["circuit-fibsqrt", "bn-fit-modify", "feal-differential-cryptanalysis"],
        )

    def test_exact_and_explicit_list_select_beyond_fix_git(self) -> None:
        exact = TerminalBench2Config(
            id="agencity-terminal-bench-2",
            selection=SelectionSpec(mode="exact", ids=["regex-log"]),
        )
        listed = TerminalBench2Config(
            id="agencity-terminal-bench-2",
            selection=SelectionSpec(mode="ids", ids=["regex-log", "fix-git"]),
        )
        self.assertEqual(
            [task.data.selection_id for task in TerminalBench2Taskset(exact).load()],
            ["regex-log"],
        )
        self.assertEqual(
            [task.data.selection_id for task in TerminalBench2Taskset(listed).load()],
            ["regex-log", "fix-git"],
        )

    def test_upstream_harbor_reward_implementation_remains_authoritative(self) -> None:
        self.assertIs(TerminalBench2Task.solved, HarborTask.solved)
        self.assertIsNot(HarborSuiteTask._graded, HarborTask._graded)


class RewardEvidenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_official_reward_evidence_accepts_pass_and_zero(self) -> None:
        class Runtime:
            def __init__(self, value: bytes) -> None:
                self.value = value

            async def read(self, path: str, max_bytes: int) -> bytes:
                if path.endswith(".json"):
                    return self.value
                raise FileNotFoundError(path)

        await _require_harbor_reward_evidence(Runtime(b'{"reward":1}'))
        await _require_harbor_reward_evidence(Runtime(b'{"reward":0}'))

    async def test_missing_or_malformed_reward_is_infrastructure_error(self) -> None:
        class Runtime:
            async def read(self, path: str, max_bytes: int) -> bytes:
                if path.endswith(".json"):
                    return b"malformed"
                return b""

        with self.assertRaisesRegex(RuntimeError, "official reward evidence"):
            await _require_harbor_reward_evidence(Runtime())


class HarnessIsolationTests(unittest.IsolatedAsyncioTestCase):
    def test_command_uses_rollout_local_state_and_exact_workspace(self) -> None:
        command = _agencity_command(
            "openai",
            "openai/gpt-5.6-luna",
            "high",
            "--workspace=/escape",
            workspace="/app/personal-site",
            installation="portable",
            console_rss_recycle_bytes=1536 * 1024 * 1024,
        )
        self.assertIn(PORTABLE_STATE_DIR, command)
        self.assertIn(PORTABLE_ARTIFACTS_DIR, command)
        self.assertIn(PORTABLE_PROFILE_PATH, command)
        self.assertIn("--console-rss-recycle-bytes", command)
        self.assertIn(str(1536 * 1024 * 1024), command)
        self.assertEqual(command[-2:], ["--", "--workspace=/escape"])

    def test_only_interception_credentials_reach_agencity(self) -> None:
        environment = _evaluation_environment(
            {
                "OPENAI_BASE_URL": "http://host.docker.internal:4312",
                "OPENAI_API_KEY": "rollout-only-secret",
            },
            "portable",
        )
        self.assertEqual(environment["OPENAI_API_KEY"], "rollout-only-secret")
        self.assertNotIn("AI_GATEWAY_API_KEY", environment)
        self.assertNotIn("GITHUB_TOKEN", environment)

    async def test_prepare_cleanup_and_shutdown_are_idempotent_boundaries(self) -> None:
        calls: list[list[str]] = []
        statuses = iter(("running", "stopped"))

        class Runtime:
            async def write(self, path: str, data: bytes) -> None:
                self.write_path = path
                self.write_data = data

            async def run(self, command: list[str], environment: dict[str, str]):
                calls.append(command)
                if "status" in command:
                    return SimpleNamespace(
                        exit_code=0,
                        stdout=json.dumps({"lifecycle": next(statuses)}),
                        stderr="",
                    )
                return SimpleNamespace(exit_code=0, stdout="", stderr="")

        runtime = Runtime()
        workspace = "/app/personal-site"
        await _prepare_portable_workspace(runtime, workspace)
        self.assertEqual(runtime.write_path, PORTABLE_GIT_EXCLUDES_PATH)
        with patch("agencity_verifiers.harness.asyncio.sleep", return_value=None):
            self.assertEqual(await _shutdown_portable(runtime, workspace), "stopped")
        self.assertEqual(
            await _cleanup_portable(runtime, workspace),
            "workspace-metadata-and-state-removed",
        )
        self.assertIn(_agencity_service_command("shutdown", workspace), calls)

    async def test_shutdown_waits_for_an_already_draining_conflicted_service(
        self,
    ) -> None:
        statuses = iter(("conflict", "conflict", "stopped"))

        class Runtime:
            async def run(self, command: list[str], environment: dict[str, str]):
                if "status" in command:
                    return SimpleNamespace(
                        exit_code=0,
                        stdout=json.dumps({"lifecycle": next(statuses)}),
                        stderr="",
                    )
                return SimpleNamespace(
                    exit_code=1,
                    stdout="",
                    stderr=(
                        "Agencity error [VALIDATION_ERROR]: Service authority is "
                        "conflicted; refusing unauthenticated shutdown"
                    ),
                )

        with patch("agencity_verifiers.harness.asyncio.sleep", return_value=None):
            self.assertEqual(
                await _shutdown_portable(Runtime(), "/app/personal-site"),
                "stopped",
            )

    async def test_shutdown_retains_request_failure_when_stop_is_unconfirmed(
        self,
    ) -> None:
        class Runtime:
            async def run(self, command: list[str], environment: dict[str, str]):
                if "status" in command:
                    return SimpleNamespace(
                        exit_code=0,
                        stdout=json.dumps({"lifecycle": "conflict"}),
                        stderr="",
                    )
                return SimpleNamespace(
                    exit_code=1,
                    stdout="",
                    stderr="authority conflict",
                )

        with (
            patch("agencity_verifiers.harness.asyncio.sleep", return_value=None),
            self.assertRaisesRegex(
                RuntimeError,
                "did not confirm shutdown within 30 seconds: authority conflict",
            ),
        ):
            await _shutdown_portable(Runtime(), "/app/personal-site")

    async def test_harbor_collection_precedes_task_cleanup(self) -> None:
        selected = list(
            TerminalBench2Taskset(
                TerminalBench2Config(id="agencity-terminal-bench-2")
            ).load()
        )[0]
        trace = SimpleNamespace(info={"agencity": {"status": "succeeded"}})
        events: list[str] = []
        shutdown = AsyncMock(
            side_effect=lambda *_: events.append("shutdown") or "stopped"
        )
        cleanup = AsyncMock(
            side_effect=lambda *_: events.append("cleanup")
            or "workspace-metadata-and-state-removed"
        )
        parent = AsyncMock(side_effect=lambda *_: events.append("collect"))
        with (
            patch("agencity_verifiers.harbor_suite._shutdown_portable", shutdown),
            patch("agencity_verifiers.harbor_suite._cleanup_portable", cleanup),
            patch.object(HarborTask, "finalize", parent),
        ):
            await selected.finalize(trace, SimpleNamespace())
        shutdown.assert_awaited_once()
        cleanup.assert_awaited_once()
        parent.assert_awaited_once()
        self.assertEqual(events, ["collect", "shutdown", "cleanup"])

    async def test_harbor_task_retains_state_when_shutdown_is_unconfirmed(
        self,
    ) -> None:
        selected = list(
            TerminalBench2Taskset(
                TerminalBench2Config(id="agencity-terminal-bench-2")
            ).load()
        )[0]
        trace = SimpleNamespace(id="trace-shutdown-failed", info={})
        cleanup = AsyncMock()
        with (
            patch(
                "agencity_verifiers.harbor_suite._shutdown_portable",
                AsyncMock(side_effect=RuntimeError("shutdown unconfirmed")),
            ),
            patch("agencity_verifiers.harbor_suite._cleanup_portable", cleanup),
            patch.object(HarborTask, "finalize", AsyncMock()),
        ):
            with self.assertRaisesRegex(RuntimeError, "shutdown unconfirmed"):
                await selected.finalize(trace, SimpleNamespace())
        cleanup.assert_not_awaited()
        self.assertEqual(
            trace.info["agencity"],
            {
                "service_shutdown": "unconfirmed",
                "cleanup": "retained-after-unconfirmed-shutdown",
            },
        )

    async def test_harness_cleanup_recovers_failed_rollout(self) -> None:
        harness = AgencityHarness(
            AgencityHarnessConfig(id="agencity-verifiers", installation="portable")
        )
        selected = list(
            TerminalBench2Taskset(
                TerminalBench2Config(id="agencity-terminal-bench-2")
            ).load()
        )[0]
        trace = SimpleNamespace(
            info={"agencity": {"status": "failed"}},
            task=SimpleNamespace(data=selected.data),
        )
        with (
            patch(
                "agencity_verifiers.harness._shutdown_portable",
                AsyncMock(return_value="stopped"),
            ),
            patch(
                "agencity_verifiers.harness._cleanup_portable",
                AsyncMock(return_value="workspace-metadata-and-state-removed"),
            ),
        ):
            await harness.cleanup(trace, SimpleNamespace())
        self.assertEqual(
            trace.info["agencity"]["cleanup"],
            "workspace-metadata-and-state-removed",
        )

    async def test_harness_cleanup_retains_state_when_shutdown_is_unconfirmed(
        self,
    ) -> None:
        harness = AgencityHarness(
            AgencityHarnessConfig(id="agencity-verifiers", installation="portable")
        )
        selected = list(
            TerminalBench2Taskset(
                TerminalBench2Config(id="agencity-terminal-bench-2")
            ).load()
        )[0]
        trace = SimpleNamespace(
            info={"agencity": {"status": "failed"}},
            task=SimpleNamespace(data=selected.data),
        )
        cleanup = AsyncMock()
        with (
            patch(
                "agencity_verifiers.harness._shutdown_portable",
                AsyncMock(side_effect=RuntimeError("shutdown unconfirmed")),
            ),
            patch("agencity_verifiers.harness._cleanup_portable", cleanup),
        ):
            with self.assertRaisesRegex(RuntimeError, "shutdown unconfirmed"):
                await harness.cleanup(trace, SimpleNamespace())
        cleanup.assert_not_awaited()
        self.assertEqual(
            trace.info["agencity"],
            {
                "status": "failed",
                "service_shutdown": "unconfirmed",
                "cleanup": "retained-after-unconfirmed-shutdown",
            },
        )


class BootstrapTests(unittest.TestCase):
    def test_bootstrap_archive_contains_source_and_linux_bun(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            (source / "package.json").write_text('{"name":"agencity"}\n')
            (source / ".git").mkdir()
            archive = _archive_bootstrap(source, b"bun-binary")
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
            names = bundle.getnames()
            self.assertIn("agencity/package.json", names)
            self.assertIn("agencity/bin/bun", names)
            self.assertNotIn("agencity/.git", names)

    def test_source_revision_must_be_full_commit(self) -> None:
        self.assertTrue(_is_commit_sha("a" * 40))
        self.assertFalse(_is_commit_sha("a" * 39))


if __name__ == "__main__":
    unittest.main()

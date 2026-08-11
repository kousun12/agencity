from __future__ import annotations

import io
import json
import tarfile
import tempfile
import tomllib
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from agencity_terminal_bench_2.taskset import (
    AGENCITY_SOURCE_REPO,
    AGENCITY_SOURCE_REF,
    BUN_ARCHIVE,
    BUN_ARCHIVE_SHA256,
    DATASET,
    DECLARED_IMAGE,
    TASK_ID,
    TASK_IMAGE,
    TASK_NAME,
    TASK_REFERENCE,
    TASK_TREE_SHA256,
    TASK_WORKSPACE,
    TerminalBench2Config,
    TerminalBench2Task,
    TerminalBench2Taskset,
    _sha256_tree,
    load_manifest,
    validate_task_tree,
)
from agencity_verifiers.bootstrap import _archive_bootstrap, _is_commit_sha
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
    _trace_result,
)
from agencity_verifiers.result import parse_run_result
from verifiers.v1.tasksets.harbor import HarborData, HarborTask, HarborTaskset


def terminal_result(**updates: object):
    value: dict[str, object] = {
        "protocol": "agencity.run-result",
        "version": 1,
        "status": "succeeded",
        "exitCode": 0,
        "steps": 2,
        "final": "private task answer",
    }
    value.update(updates)
    return parse_run_result(json.dumps(value), int(value["exitCode"]))


def harbor_task(
    *,
    name: str = TASK_NAME,
    image: str | None = DECLARED_IMAGE,
    workdir: str | None = None,
) -> HarborTask:
    data = HarborData(
        idx=0,
        name=name,
        prompt="public task prompt",
        image=image,
        workdir=workdir,
        task_dir="/host/harbor/fix-git",
    )
    return HarborTask(data)


def verified_manifest_digest(path: Path) -> str:
    manifest = load_manifest()
    if path.name == "uv.lock":
        return manifest["python_lock_sha256"]
    return manifest["selection"]["task_toml_sha256"]


class ManifestTests(unittest.TestCase):
    def test_manifest_pins_one_exact_task(self) -> None:
        manifest = load_manifest()
        selection = manifest["selection"]
        self.assertEqual(selection["dataset"], DATASET)
        self.assertEqual(selection["task_id"], TASK_ID)
        self.assertEqual(selection["task_reference"], TASK_REFERENCE)
        self.assertEqual(selection["task_tree_sha256"], TASK_TREE_SHA256)
        self.assertEqual(selection["image"], TASK_IMAGE)
        self.assertEqual(selection["workspace"], TASK_WORKSPACE)
        self.assertEqual(len(selection["task_toml_sha256"]), 64)
        self.assertEqual(manifest["agencity"]["source_ref"], AGENCITY_SOURCE_REF)

    def test_manifest_rejects_selection_drift(self) -> None:
        value = load_manifest()
        value["selection"]["task_id"] = "some-other-task"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, "selection"):
                load_manifest(path)

    def test_config_refuses_implicit_or_multiple_tasks(self) -> None:
        self.assertEqual(TerminalBench2Config().tasks, [TASK_ID])
        with self.assertRaisesRegex(ValueError, "exactly"):
            TerminalBench2Config(tasks=["fix-git", "regex-log"])

    def test_sample_config_matches_manifest_runtime_pins(self) -> None:
        config_path = Path(__file__).resolve().parent.parent / "configs" / (
            "terminal-bench-2-fix-git-sample.toml"
        )
        value = tomllib.loads(config_path.read_text(encoding="utf-8"))
        harness = value["env"]["agent"]["harness"]
        self.assertEqual(harness["source_repo"], AGENCITY_SOURCE_REPO)
        self.assertEqual(harness["source_ref"], AGENCITY_SOURCE_REF)
        self.assertEqual(harness["bun_url"], BUN_ARCHIVE)
        self.assertEqual(harness["bun_sha256"], BUN_ARCHIVE_SHA256)

    def test_task_tree_tampering_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tests = root / "tests"
            tests.mkdir()
            verifier = tests / "test.sh"
            verifier.write_text("exit 0\n")
            expected = _sha256_tree(root)
            validate_task_tree(root, expected)
            verifier.write_text("exit 1\n")
            with self.assertRaisesRegex(ValueError, "task tree"):
                validate_task_tree(root, expected)


class SelectionTests(unittest.TestCase):
    def test_taskset_rewrites_only_the_manifest_task_to_pinned_image(self) -> None:
        config = TerminalBench2Config(id="agencity-terminal-bench-2")
        with (
            patch.object(HarborTaskset, "load", return_value=iter([harbor_task()])),
            patch(
                "agencity_terminal_bench_2.taskset._sha256_file",
                side_effect=verified_manifest_digest,
            ),
            patch("agencity_terminal_bench_2.taskset.validate_task_tree"),
        ):
            tasks = list(TerminalBench2Taskset(config).load())
        self.assertEqual(len(tasks), 1)
        self.assertIsInstance(tasks[0], TerminalBench2Task)
        self.assertEqual(tasks[0].data.image, TASK_IMAGE)
        self.assertEqual(tasks[0].data.workdir, TASK_WORKSPACE)
        self.assertEqual(tasks[0].data.task_dir, "/host/harbor/fix-git")

    def test_taskset_rejects_a_changed_upstream_image_or_workspace(self) -> None:
        config = TerminalBench2Config(id="agencity-terminal-bench-2")
        with (
            patch.object(
                HarborTaskset,
                "load",
                return_value=iter([harbor_task(image="changed:tag")]),
            ),
            patch(
                "agencity_terminal_bench_2.taskset._sha256_file",
                side_effect=verified_manifest_digest,
            ),
            patch("agencity_terminal_bench_2.taskset.validate_task_tree"),
        ):
            with self.assertRaisesRegex(ValueError, "image"):
                list(TerminalBench2Taskset(config).load())
        with (
            patch.object(
                HarborTaskset,
                "load",
                return_value=iter([harbor_task(workdir="/changed")]),
            ),
            patch(
                "agencity_terminal_bench_2.taskset._sha256_file",
                side_effect=verified_manifest_digest,
            ),
            patch("agencity_terminal_bench_2.taskset.validate_task_tree"),
        ):
            with self.assertRaisesRegex(ValueError, "workdir"):
                list(TerminalBench2Taskset(config).load())

    def test_taskset_keeps_the_upstream_harbor_verifier(self) -> None:
        self.assertIs(TerminalBench2Task.solved, HarborTask.solved)
        command = _agencity_command(
            "openai",
            "openai/gpt-5.6-luna",
            "high",
            "task text",
            workspace=TASK_WORKSPACE,
            installation="portable",
        )
        self.assertIn(TASK_WORKSPACE, command)
        self.assertNotIn("/tests", command)
        self.assertNotIn("/host/harbor/fix-git", command)


class HarnessIsolationTests(unittest.IsolatedAsyncioTestCase):
    def test_portable_command_uses_rollout_local_state_outside_task_workspace(self) -> None:
        command = _agencity_command(
            "openai",
            "openai/gpt-5.6-luna",
            "high",
            "--workspace=/escape",
            workspace=TASK_WORKSPACE,
            installation="portable",
        )
        self.assertEqual(command[0], "/opt/agencity/bin/bun")
        self.assertIn(PORTABLE_STATE_DIR, command)
        self.assertIn(PORTABLE_ARTIFACTS_DIR, command)
        self.assertIn(PORTABLE_PROFILE_PATH, command)
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
        self.assertEqual(set(environment), {
            "OPENAI_BASE_URL",
            "OPENAI_API_KEY",
            "AGENCITY_PROFILE",
            "HOME",
            "NO_COLOR",
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0",
        })
        self.assertNotIn("AI_GATEWAY_API_KEY", environment)
        self.assertNotIn("ANTHROPIC_API_KEY", environment)
        self.assertNotIn("GITHUB_TOKEN", environment)

    def test_status_mapping_keeps_terminal_states_without_final_task_content(self) -> None:
        mapped = _trace_result(terminal_result(status="blocked", exitCode=4, final=None))
        self.assertEqual(mapped["status"], "blocked")
        self.assertEqual(mapped["exit_code"], 4)
        self.assertNotIn("final", mapped)

    async def test_prepare_refuses_existing_workspace_metadata(self) -> None:
        class Runtime:
            async def run(self, command: list[str], environment: dict[str, str]):
                return SimpleNamespace(exit_code=1, stdout="", stderr="")

            async def write(self, path: str, data: bytes):
                raise AssertionError("refused workspace must not be prepared")

        with self.assertRaisesRegex(RuntimeError, "pre-existing"):
            await _prepare_portable_workspace(Runtime(), TASK_WORKSPACE)

    async def test_prepare_and_cleanup_isolate_generated_workspace_metadata(self) -> None:
        calls: list[tuple[list[str], dict[str, str]]] = []

        class Runtime:
            async def write(self, path: str, data: bytes):
                self.write_path = path
                self.write_data = data

            async def run(self, command: list[str], environment: dict[str, str]):
                calls.append((command, environment))
                return SimpleNamespace(exit_code=0, stdout="", stderr="")

        runtime = Runtime()
        await _prepare_portable_workspace(runtime, TASK_WORKSPACE)
        self.assertEqual(runtime.write_path, PORTABLE_GIT_EXCLUDES_PATH)
        self.assertEqual(runtime.write_data, b".agencity/\n")
        self.assertEqual(
            await _cleanup_portable(runtime, TASK_WORKSPACE),
            "workspace-metadata-and-state-removed",
        )
        self.assertEqual(
            calls,
            [
                (["test", "!", "-e", f"{TASK_WORKSPACE}/.agencity"], {}),
                (
                    [
                        "rm",
                        "-rf",
                        "--",
                        f"{TASK_WORKSPACE}/.agencity",
                        "/tmp/agencity-eval",
                    ],
                    {},
                ),
            ],
        )

    async def test_shutdown_waits_until_service_is_stopped(self) -> None:
        calls: list[tuple[list[str], dict[str, str]]] = []
        statuses = iter(("running", "stopped"))

        class Runtime:
            async def run(self, command: list[str], environment: dict[str, str]):
                calls.append((command, environment))
                if "shutdown" in command:
                    return SimpleNamespace(exit_code=0, stdout='{"accepted":true}', stderr="")
                lifecycle = next(statuses)
                return SimpleNamespace(
                    exit_code=0,
                    stdout=json.dumps({"lifecycle": lifecycle}),
                    stderr="",
                )

        with patch("agencity_verifiers.harness.asyncio.sleep", return_value=None):
            result = await _shutdown_portable(Runtime(), TASK_WORKSPACE)
        self.assertEqual(result, "stopped")
        self.assertEqual(
            [command for command, _ in calls],
            [
                _agencity_service_command("shutdown", TASK_WORKSPACE),
                _agencity_service_command("status", TASK_WORKSPACE),
                _agencity_service_command("status", TASK_WORKSPACE),
            ],
        )
        self.assertTrue(all("OPENAI_API_KEY" not in environment for _, environment in calls))

    async def test_task_finalization_stops_service_before_harbor_finalization(self) -> None:
        task = TerminalBench2Task(
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
            patch(
                "agencity_terminal_bench_2.taskset._shutdown_portable",
                shutdown,
            ),
            patch(
                "agencity_terminal_bench_2.taskset._cleanup_portable",
                cleanup,
            ),
            patch.object(HarborTask, "finalize", harbor_finalize),
        ):
            await task.finalize(trace, SimpleNamespace())
        shutdown.assert_awaited_once()
        cleanup.assert_awaited_once()
        harbor_finalize.assert_awaited_once()
        self.assertEqual(trace.info["agencity"]["service_shutdown"], "stopped")

    async def test_harness_cleanup_recovers_failed_portable_rollout(self) -> None:
        harness = AgencityHarness(
            AgencityHarnessConfig(id="agencity-verifiers", installation="portable")
        )
        trace = SimpleNamespace(
            info={"agencity": {"status": "failed"}},
            task=SimpleNamespace(
                data=HarborData(
                    idx=0,
                    name=TASK_NAME,
                    prompt="task",
                    image=TASK_IMAGE,
                    workdir=TASK_WORKSPACE,
                    task_dir="/host/task",
                )
            ),
        )
        shutdown = AsyncMock(return_value="stopped")
        cleanup = AsyncMock(return_value="workspace-metadata-and-state-removed")
        with (
            patch("agencity_verifiers.harness._shutdown_portable", shutdown),
            patch("agencity_verifiers.harness._cleanup_portable", cleanup),
        ):
            await harness.cleanup(trace, SimpleNamespace())
        shutdown.assert_awaited_once()
        cleanup.assert_awaited_once()
        self.assertEqual(trace.info["agencity"]["cleanup"], "workspace-metadata-and-state-removed")

    async def test_portable_install_never_requires_a_task_image_package_manager(self) -> None:
        commands: list[list[str]] = []

        class Runtime:
            async def write(self, path: str, data: bytes):
                self.write_path = path
                self.write_data = data

            async def run(self, command: list[str], environment: dict[str, str]):
                commands.append(command)
                return SimpleNamespace(exit_code=0, stdout="", stderr="")

        harness = AgencityHarness(
            AgencityHarnessConfig(id="agencity-verifiers", installation="portable")
        )
        runtime = Runtime()
        with patch("agencity_verifiers.harness.build_portable_bootstrap", return_value=b"bundle"):
            await harness.setup(runtime)
        self.assertEqual(runtime.write_path, "/tmp/agencity-bootstrap.tgz")
        self.assertEqual(runtime.write_data, b"bundle")
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0][:2], ["sh", "-c"])
        self.assertNotIn("apt-get", commands[0][2])
        self.assertIn("/opt/agencity/bin/bun", commands[0][2])
        self.assertIn(PORTABLE_STATE_DIR, commands[0][2])
        self.assertIn(PORTABLE_ARTIFACTS_DIR, commands[0][2])


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
            self.assertEqual(bundle.extractfile("agencity/bin/bun").read(), b"bun-binary")

    def test_source_revision_must_be_a_full_commit_sha(self) -> None:
        self.assertTrue(_is_commit_sha("a" * 40))
        self.assertFalse(_is_commit_sha("a" * 39))
        self.assertFalse(_is_commit_sha("g" * 40))

    def test_bootstrap_rejects_source_above_its_bound(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            (source / "package.json").write_text("{}")
            with (
                patch(
                    "agencity_verifiers.bootstrap.MAX_SOURCE_ARCHIVE_BYTES",
                    1,
                ),
                self.assertRaisesRegex(RuntimeError, "source exceeds"),
            ):
                _archive_bootstrap(source, b"bun")


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import verifiers.v1 as vf

from agencity_swe_bench_pro.scorer import (
    IMAGE_ID,
    OfficialEvaluatorError,
    OfficialScore,
    _official_image_alias,
    _require_alias_pull_failure,
    score_with_official_evaluator,
    validate_official_parser_output,
)
from agencity_swe_bench_pro.taskset import (
    AGENCITY_SOURCE_REF,
    AGENCITY_SOURCE_REPO,
    BASE_COMMIT,
    BUN_ARCHIVE,
    BUN_ARCHIVE_SHA256,
    DATASET_REVISION,
    DOCKER_TAG,
    IMAGE,
    PUBLIC_SELECTION_SHA256,
    REPOSITORY,
    TASK_ID,
    SWEProConfig,
    SWEProData,
    SWEProEnv,
    SWEProEnvConfig,
    SWEProTask,
    SWEProTaskset,
    build_prompt,
    load_manifest,
    validate_official_evaluator_evidence,
    validate_selected_public_row,
)


HIDDEN_COMMIT = "0833b5f6f140d04200ec91605f88704dd18e2970"


def row() -> dict[str, str]:
    return {
        "repo": REPOSITORY,
        "instance_id": TASK_ID,
        "base_commit": BASE_COMMIT,
        "dockerhub_tag": DOCKER_TAG,
        "problem_statement": "Fix the public issue.",
        "requirements": "Use the modern error signal.",
        "interface": "No new interfaces.",
        "repo_language": "python",
        "before_repo_set_cmd": (
            f"git reset --hard {BASE_COMMIT}\n"
            f"git checkout {HIDDEN_COMMIT} -- hidden_test.py"
        ),
        "selected_test_files_to_run": "['hidden_test.py']",
        "fail_to_pass": "['hidden_test.py::test_error']",
        "pass_to_pass": "['hidden_test.py::test_existing']",
        "patch": "hidden reference patch",
        "test_patch": "hidden verifier patch",
    }


def task(evaluator_row: dict[str, str] | None = None) -> SWEProTask:
    return SWEProTask(
        SWEProData(
            idx=0,
            name=TASK_ID,
            prompt="public prompt",
            image=IMAGE,
            workdir="/app",
            instance_id=TASK_ID,
            repository=REPOSITORY,
            base_commit=BASE_COMMIT,
            dataset_revision=DATASET_REVISION,
        ),
        evaluator_row=evaluator_row or row(),
    )


class SWEProManifestTests(unittest.TestCase):
    def test_manifest_pins_split_route_and_latest_agencity_head(self) -> None:
        manifest = load_manifest()
        self.assertEqual(manifest["selection"]["instance_id"], TASK_ID)
        self.assertEqual(manifest["selection"]["repository"], REPOSITORY)
        self.assertEqual(manifest["selection"]["image"], IMAGE)
        self.assertEqual(manifest["selection"]["image_id"], IMAGE_ID)
        self.assertFalse(
            manifest["official_evaluator"]["upstream_accepts_image_digest"]
        )
        self.assertTrue(
            manifest["official_evaluator"]["adapter_enforces_image_digest"]
        )
        self.assertEqual(
            manifest["agencity"]["source_ref"],
            "ef16e551cc4494cdd76637249a80afa82cdf26be",
        )

    def test_manifest_rejects_pin_drift(self) -> None:
        value = load_manifest()
        value["selection"]["base_commit"] = "0" * 40
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "selection"):
                load_manifest(path)

    def test_config_refuses_implicit_or_multiple_instances(self) -> None:
        self.assertEqual(SWEProConfig().instances, [TASK_ID])
        with self.assertRaisesRegex(ValueError, "exactly"):
            SWEProConfig(instances=[TASK_ID, "another-instance"])


class SWEProIsolationTests(unittest.TestCase):
    def test_prompt_uses_public_issue_material_only(self) -> None:
        prompt = build_prompt(row())
        self.assertIn("Fix the public issue.", prompt)
        self.assertIn(REPOSITORY, prompt)
        self.assertNotIn("hidden reference patch", prompt)
        self.assertNotIn("hidden verifier patch", prompt)
        self.assertNotIn(HIDDEN_COMMIT, prompt)
        self.assertIn("Do not assume access to hidden tests", prompt)

    def test_selected_row_digest_rejects_pinned_material_drift(self) -> None:
        value = row()
        fields = (
            "repo",
            "instance_id",
            "base_commit",
            "dockerhub_tag",
            "problem_statement",
            "requirements",
            "interface",
            "repo_language",
            "before_repo_set_cmd",
            "selected_test_files_to_run",
            "fail_to_pass",
            "pass_to_pass",
        )
        digest = hashlib.sha256(
            json.dumps(
                {key: value[key] for key in fields},
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        with patch(
            "agencity_swe_bench_pro.taskset.PUBLIC_SELECTION_SHA256", digest
        ):
            validate_selected_public_row(value)
        value["problem_statement"] = "changed"
        with patch(
            "agencity_swe_bench_pro.taskset.PUBLIC_SELECTION_SHA256", digest
        ), self.assertRaisesRegex(ValueError, "fields drifted"):
            validate_selected_public_row(value)

    def test_loader_keeps_evaluator_material_out_of_trace_data(self) -> None:
        config = SWEProConfig(id="agencity-swe-bench-pro")
        with (
            patch(
                "agencity_swe_bench_pro.taskset.load_selected_public_row",
                return_value=row(),
            ),
            patch("agencity_swe_bench_pro.taskset.validate_selected_public_row"),
            patch("agencity_swe_bench_pro.taskset.validate_lockfile"),
        ):
            loaded = SWEProTaskset(config).load()[0]
        self.assertEqual(loaded.data.image, IMAGE)
        self.assertEqual(loaded.data.workdir, "/app")
        self.assertEqual(loaded.data.network_allow, [])
        self.assertNotIn("patch", loaded.data.model_dump())
        self.assertNotIn("test_patch", loaded.data.model_dump())
        self.assertNotIn("before_repo_set_cmd", loaded.data.model_dump())

    def test_custom_environment_is_exported_by_taskset_package(self) -> None:
        from verifiers.v1.utils.loaders import environment_class

        self.assertIs(environment_class("agencity-swe-bench-pro"), SWEProEnv)


class FakeRuntime:
    def __init__(self, patch_content: bytes = b"diff --git a/a b/a\n") -> None:
        self.patch_content = patch_content
        self.commands: list[list[str]] = []

    async def run(self, argv: list[str], env: dict[str, str]) -> vf.ProgramResult:
        self.commands.append(argv)
        if argv[:5] == ["git", "-C", "/app", "cat-file", "-e"]:
            return vf.ProgramResult(1, "", "not found")
        if argv[:2] == ["sh", "-lc"] and "sanitized public baseline" in argv[2]:
            return vf.ProgramResult(0, "a" * 40 + "\n", "")
        return vf.ProgramResult(0, "", "")

    async def read(self, path: str, max_bytes: int | None = None) -> bytes:
        self.asserted_path = path
        self.asserted_max = max_bytes
        return self.patch_content


class SWEProLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_environment_requires_exact_pinned_harness_and_docker(self) -> None:
        environment = object.__new__(SWEProEnv)
        harness = SimpleNamespace(
            id="agencity-verifiers",
            source_repo=AGENCITY_SOURCE_REPO,
            source_ref=AGENCITY_SOURCE_REF,
            installation="portable",
            bun_url=BUN_ARCHIVE,
            bun_sha256=BUN_ARCHIVE_SHA256,
        )
        agents = SimpleNamespace(
            agent=SimpleNamespace(
                config=SimpleNamespace(
                    harness=harness,
                    runtime=SimpleNamespace(type="docker"),
                )
            )
        )
        await environment.setup(agents)
        harness.source_ref = "0" * 40
        with self.assertRaisesRegex(ValueError, "exact pinned"):
            await environment.setup(agents)

    async def test_setup_strips_original_history_and_finalize_hides_patch(self) -> None:
        runtime = FakeRuntime()
        trace = SimpleNamespace(id="trace-1", info={})
        selected = task()
        shutdown = AsyncMock(return_value="stopped")
        cleanup = AsyncMock(return_value="workspace-metadata-and-state-removed")
        with (
            patch("agencity_swe_bench_pro.taskset._shutdown_portable", shutdown),
            patch("agencity_swe_bench_pro.taskset._cleanup_portable", cleanup),
        ):
            await selected.setup(trace, runtime)
            await selected.finalize(trace, runtime)

        isolation = trace.info["swe_bench_pro_isolation"]
        self.assertTrue(isolation["original_git_history_removed"])
        self.assertFalse(isolation["withheld_commits_resolvable"])
        metadata = trace.info["swe_bench_pro_patch"]
        self.assertFalse(metadata["content_retained_in_trace"])
        self.assertNotIn("diff --git", json.dumps(trace.info))
        self.assertEqual(selected.take_patch("trace-1"), "diff --git a/a b/a\n")
        self.assertTrue(
            any(command[:5] == ["git", "-C", "/app", "cat-file", "-e"] for command in runtime.commands)
        )
        shutdown.assert_awaited_once()
        cleanup.assert_awaited_once()

    async def test_environment_scores_only_after_private_patch_capture(self) -> None:
        selected = task()
        selected._patches["trace-2"] = "private patch"
        rewards: list[tuple[str, float]] = []
        trace = SimpleNamespace(
            id="trace-2",
            has_error=False,
            info={},
            record_reward=lambda name, value: rewards.append((name, value)),
        )
        episode = SimpleNamespace(traces=[trace])
        score = OfficialScore(
            reward=1.0,
            evidence={"agent_runtime_stopped_before_scoring": True},
        )
        environment = object.__new__(SWEProEnv)
        with patch(
            "agencity_swe_bench_pro.taskset.score_with_official_evaluator",
            return_value=score,
        ) as scorer:
            await environment.finalize(selected, episode)
        scorer.assert_called_once_with(
            "private patch", selected.evaluator_row, trace_id="trace-2"
        )
        self.assertEqual(rewards, [("official_swe_bench_pro", 1.0)])
        self.assertTrue(
            trace.info["swe_bench_pro_official"][
                "agent_runtime_stopped_before_scoring"
            ]
        )


class SWEProScorerTests(unittest.TestCase):
    def test_official_image_alias_matches_upstream_helper_shape(self) -> None:
        alias = _official_image_alias("127.0.0.1:0/agencity", TASK_ID, REPOSITORY)
        self.assertEqual(
            alias,
            f"127.0.0.1:0/agencity/sweap-images:{DOCKER_TAG}",
        )

    def test_alias_preflight_rejects_any_registry_resolution(self) -> None:
        completed = subprocess.CompletedProcess([], 0, stdout=b"", stderr=b"")
        with (
            patch("agencity_swe_bench_pro.scorer.subprocess.run", return_value=completed),
            self.assertRaisesRegex(OfficialEvaluatorError, "unexpectedly resolved"),
        ):
            _require_alias_pull_failure(
                "127.0.0.1:0/agencity/sweap-images:test", IMAGE_ID
            )

    def test_official_evaluator_evidence_requires_one_boolean_result(self) -> None:
        self.assertTrue(validate_official_evaluator_evidence({TASK_ID: True}, TASK_ID))
        with self.assertRaisesRegex(ValueError, "one selected"):
            validate_official_evaluator_evidence({}, TASK_ID)
        with self.assertRaisesRegex(ValueError, "boolean"):
            validate_official_evaluator_evidence({TASK_ID: "passed"}, TASK_ID)

    def test_parser_evidence_rejects_missing_or_malformed_tests(self) -> None:
        validate_official_parser_output(
            {"tests": [{"name": "private-test", "status": "PASSED"}]}
        )
        with self.assertRaisesRegex(OfficialEvaluatorError, "no test"):
            validate_official_parser_output({"tests": []})
        with self.assertRaisesRegex(OfficialEvaluatorError, "malformed"):
            validate_official_parser_output(
                {"tests": [{"name": "private-test", "status": "UNKNOWN"}]}
            )

    def test_split_scorer_maps_official_result_without_retaining_test_names(self) -> None:
        def checkout(destination: Path) -> None:
            destination.mkdir()

        def run_evaluator(
            command: list[str],
            cwd: Path,
            stdout_path: Path,
            stderr_path: Path,
            timeout_seconds: int,
        ) -> subprocess.CompletedProcess[bytes]:
            output_dir = Path(command[command.index("--output_dir") + 1])
            (output_dir / TASK_ID).mkdir()
            (output_dir / "eval_results.json").write_text(
                json.dumps({TASK_ID: True}), encoding="utf-8"
            )
            (output_dir / TASK_ID / "agencity_output.json").write_text(
                json.dumps(
                    {"tests": [{"name": "held-out-name", "status": "PASSED"}]}
                ),
                encoding="utf-8",
            )
            stdout_path.write_text("official stdout", encoding="utf-8")
            stderr_path.write_text("", encoding="utf-8")
            return subprocess.CompletedProcess(command, 0)

        completed = subprocess.CompletedProcess([], 0, stdout=b"", stderr=b"")
        with (
            patch("agencity_swe_bench_pro.scorer._checkout_evaluator", checkout),
            patch("agencity_swe_bench_pro.scorer._validate_evaluator_source"),
            patch(
                "agencity_swe_bench_pro.scorer._ensure_pinned_image",
                return_value=IMAGE_ID,
            ),
            patch(
                "agencity_swe_bench_pro.scorer._inspect_image_id",
                return_value=IMAGE_ID,
            ),
            patch(
                "agencity_swe_bench_pro.scorer._inspect_optional_image_id",
                side_effect=[IMAGE_ID, None],
            ),
            patch(
                "agencity_swe_bench_pro.scorer._run_checked",
                return_value=completed,
            ),
            patch("agencity_swe_bench_pro.scorer._require_alias_pull_failure"),
            patch("agencity_swe_bench_pro.scorer._run_evaluator", run_evaluator),
            patch(
                "agencity_swe_bench_pro.scorer._remove_alias_containers",
                return_value=0,
            ),
            patch("agencity_swe_bench_pro.scorer._run_best_effort"),
        ):
            score = score_with_official_evaluator(
                "private patch", row(), trace_id="trace"
            )

        self.assertEqual(score.reward, 1.0)
        serialized = json.dumps(score.evidence)
        self.assertNotIn("held-out-name", serialized)
        self.assertNotIn("private patch", serialized)
        self.assertEqual(score.evidence["alias_image_id_before"], IMAGE_ID)
        self.assertEqual(score.evidence["alias_image_id_after"], IMAGE_ID)
        self.assertTrue(score.evidence["cleanup"]["temporary_alias_removed"])


if __name__ == "__main__":
    unittest.main()

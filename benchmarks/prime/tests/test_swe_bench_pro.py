from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agencity_swe_bench_pro.taskset import (
    BASE_COMMIT,
    DOCKER_TAG,
    IMAGE,
    PUBLIC_SELECTION_SHA256,
    REPOSITORY,
    TASK_ID,
    OfficialEvaluatorCompatibilityError,
    SWEProConfig,
    SWEProData,
    SWEProTask,
    SWEProTaskset,
    build_prompt,
    load_manifest,
    require_official_evaluator_compatibility,
    validate_official_evaluator_evidence,
    validate_selected_public_row,
)


def row() -> dict[str, str]:
    return {
        "repo": REPOSITORY,
        "instance_id": TASK_ID,
        "base_commit": BASE_COMMIT,
        "dockerhub_tag": DOCKER_TAG,
        "problem_statement": "Fix the public issue.",
        "requirements": "Keep the public API stable.",
        "interface": "Use the documented interface.",
        "repo_language": "go",
        "before_repo_set_cmd": "true",
        "selected_test_files_to_run": "['internal/public_test.go']",
        "fail_to_pass": "['public_failure']",
        "pass_to_pass": "['public_pass']",
        "patch": "hidden reference patch",
        "test_patch": "hidden verifier patch",
    }


class SWEProManifestTests(unittest.TestCase):
    def test_manifest_pins_one_public_instance_and_official_evaluator(self) -> None:
        manifest = load_manifest()
        self.assertEqual(manifest["selection"]["instance_id"], TASK_ID)
        self.assertEqual(manifest["selection"]["repository"], REPOSITORY)
        self.assertEqual(manifest["selection"]["image"], IMAGE)
        self.assertFalse(manifest["official_evaluator"]["immutable_image_input"])

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
        self.assertIn("Do not assume access to hidden tests", prompt)

    def test_selected_row_digest_rejects_public_material_drift(self) -> None:
        value = row()
        public = {
            key: value[key]
            for key in (
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
        }
        digest = hashlib.sha256(
            json.dumps(public, sort_keys=True, separators=(",", ":")).encode("utf-8")
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

    def test_loader_creates_an_isolated_pinned_workspace_task(self) -> None:
        config = SWEProConfig(id="agencity-swe-bench-pro")
        with (
            patch("agencity_swe_bench_pro.taskset.load_selected_public_row", return_value=row()),
            patch("agencity_swe_bench_pro.taskset.validate_selected_public_row"),
            patch("agencity_swe_bench_pro.taskset.validate_lockfile"),
        ):
            task = SWEProTaskset(config).load()[0]
        self.assertEqual(task.data.image, IMAGE)
        self.assertEqual(task.data.workdir, "/app")
        self.assertEqual(task.data.network_allow, [])
        self.assertNotIn("patch", task.data.model_dump())
        self.assertNotIn("test_patch", task.data.model_dump())

    def test_official_evaluator_evidence_requires_one_boolean_result(self) -> None:
        self.assertTrue(validate_official_evaluator_evidence({TASK_ID: True}))
        with self.assertRaisesRegex(ValueError, "one selected"):
            validate_official_evaluator_evidence({})
        with self.assertRaisesRegex(ValueError, "boolean"):
            validate_official_evaluator_evidence({TASK_ID: "passed"})

    def test_spike_blocks_before_model_or_workspace_mutation(self) -> None:
        task = SWEProTask(
            SWEProData(
                idx=0,
                name=TASK_ID,
                prompt="public prompt",
                image=IMAGE,
                workdir="/app",
                instance_id=TASK_ID,
                repository=REPOSITORY,
                base_commit=BASE_COMMIT,
                dataset_revision="7ab5114912baf22bb098818e604c02fe7ad2c11f",
            )
        )
        with self.assertRaisesRegex(OfficialEvaluatorCompatibilityError, "mutable"):
            require_official_evaluator_compatibility()
        self.assertEqual(task.data.image, IMAGE)


class SWEProLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_task_setup_rejects_before_runtime_access_or_model_admission(self) -> None:
        task = SWEProTask(
            SWEProData(
                idx=0,
                name=TASK_ID,
                prompt="public prompt",
                image=IMAGE,
                workdir="/app",
                instance_id=TASK_ID,
                repository=REPOSITORY,
                base_commit=BASE_COMMIT,
                dataset_revision="7ab5114912baf22bb098818e604c02fe7ad2c11f",
            )
        )

        class Runtime:
            def __getattr__(self, name: str):
                raise AssertionError(f"blocked task must not access runtime.{name}")

        with self.assertRaisesRegex(OfficialEvaluatorCompatibilityError, "mutable"):
            await task.setup(object(), Runtime())


if __name__ == "__main__":
    unittest.main()

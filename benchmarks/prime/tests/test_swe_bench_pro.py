from __future__ import annotations

import json
import os
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import verifiers.v1 as vf

from agencity_swe_bench_pro.scorer import (
    OfficialEvaluatorError,
    OfficialScore,
    _official_image_alias,
    _safe_token,
    score_with_official_evaluator,
    validate_official_evaluator_evidence,
    validate_official_parser_output,
)
from agencity_swe_bench_pro.taskset import (
    BENCHMARK,
    CATALOG_PATH,
    DATASET_REVISION,
    SWEProConfig,
    SWEProData,
    SWEProEnv,
    SWEProTask,
    SWEProTaskset,
    build_prompt,
    load_selected_public_rows,
    validate_selected_public_row,
)
from agencity_verifiers.selection import SelectionSpec, load_catalog


QUTE = (
    "instance_qutebrowser__qutebrowser-"
    "0833b5f6f140d04200ec91605f88704dd18e2970-"
    "v059c6fdc75567943479b23ebca7c07b5e9a7f34c"
)
VULS = "instance_future-architect__vuls-36456cb151894964ba1683ce7da5c35ada789970"
HIDDEN_COMMIT = "0833b5f6f140d04200ec91605f88704dd18e2970"


def catalog_pin(identifier: str = QUTE) -> dict:
    catalog = load_catalog(CATALOG_PATH, BENCHMARK)
    return next(task for task in catalog["tasks"] if task["id"] == identifier)


def row(identifier: str = QUTE) -> dict[str, str]:
    pin = catalog_pin(identifier)
    return {
        "repo": pin["repository"],
        "instance_id": identifier,
        "base_commit": pin["base_commit"],
        "dockerhub_tag": pin["docker_tag"],
        "problem_statement": "Fix the public issue.",
        "requirements": "Use the modern error signal.",
        "interface": "No new interfaces.",
        "repo_language": "python",
        "before_repo_set_cmd": (
            f"git reset --hard {pin['base_commit']}\n"
            f"git checkout {HIDDEN_COMMIT} -- hidden_test.py"
        ),
        "selected_test_files_to_run": "['hidden_test.py']",
        "fail_to_pass": "['hidden_test.py::test_error']",
        "pass_to_pass": "['hidden_test.py::test_existing']",
        "patch": "hidden reference patch",
        "test_patch": "hidden verifier patch",
    }


def task(identifier: str = QUTE) -> SWEProTask:
    pin = catalog_pin(identifier)
    selected_row = row(identifier)
    return SWEProTask(
        SWEProData(
            idx=0,
            name=identifier,
            prompt="public prompt",
            image=pin["image"],
            workdir="/app",
            selection_id=identifier,
            repository=pin["repository"],
            base_commit=pin["base_commit"],
            dataset_revision=DATASET_REVISION,
            catalog_sha256="a" * 64,
            catalog_tasks_sha256="b" * 64,
            selected_ids=[identifier],
            selected_ids_sha256="c" * 64,
            public_selection_sha256=pin["public_selection_sha256"],
            image_manifest_digest=pin["image_manifest_digest"],
            image_config_digest=pin["image_config_digest"],
            treatment="agencity-portable",
        ),
        evaluator_row=selected_row,
        pin=pin,
    )


class CatalogTests(unittest.TestCase):
    def test_score_alias_tokens_do_not_share_trace_prefixes(self) -> None:
        first = _safe_token("trace-with-a-shared-24-character-prefix-a")
        second = _safe_token("trace-with-a-shared-24-character-prefix-b")
        self.assertNotEqual(first, second)
        self.assertEqual(len(first), 24)

    def test_catalog_covers_every_public_row_with_explicit_compatibility(self) -> None:
        catalog = load_catalog(CATALOG_PATH, BENCHMARK)
        self.assertEqual(catalog["dataset"]["task_count"], 731)
        self.assertEqual(len(catalog["tasks"]), 731)
        compatible = [task for task in catalog["tasks"] if task["compatible"]]
        incompatible = [task for task in catalog["tasks"] if not task["compatible"]]
        self.assertEqual({task["id"] for task in compatible}, {QUTE})
        self.assertEqual(len(incompatible), 730)
        self.assertTrue(
            all(task["incompatibility_reasons"] for task in incompatible)
        )
        reasons = {
            reason["code"]
            for task in incompatible
            for reason in task["incompatibility_reasons"]
        }
        self.assertEqual(
            reasons,
            {
                "image_configuration_not_audited",
                "official_noop_parser_evidence_empty",
            },
        )

    def test_smoke_subset_and_full_compatible_use_same_taskset(self) -> None:
        rows = {QUTE: row(QUTE), VULS: row(VULS)}
        for selection, expected in (
            (SelectionSpec(mode="smoke", subset="qutebrowser"), [QUTE]),
            (SelectionSpec(mode="ids", ids=[QUTE]), [QUTE]),
            (SelectionSpec(mode="all"), [QUTE]),
        ):
            with patch(
                "agencity_swe_bench_pro.taskset.load_selected_public_rows",
                return_value=rows,
            ), patch(
                "agencity_swe_bench_pro.taskset.validate_selected_public_row"
            ):
                tasks = SWEProTaskset(
                    SWEProConfig(
                        id="agencity-swe-bench-pro", selection=selection
                    )
                ).load()
            self.assertEqual([task.data.selection_id for task in tasks], expected)
            self.assertTrue(all(isinstance(task, SWEProTask) for task in tasks))

    def test_incompatible_instance_fails_with_typed_reason(self) -> None:
        catalog = load_catalog(CATALOG_PATH, BENCHMARK)
        identifier = next(
            task["id"] for task in catalog["tasks"] if not task["compatible"]
        )
        with self.assertRaisesRegex(ValueError, "incompatible"):
            SWEProTaskset(
                SWEProConfig(
                    id="agencity-swe-bench-pro",
                    selection=SelectionSpec(mode="exact", ids=[identifier]),
                )
            ).load()
        with self.assertRaisesRegex(
            ValueError, "official_noop_parser_evidence_empty"
        ):
            SWEProConfig(
                id="agencity-swe-bench-pro",
                selection=SelectionSpec(mode="exact", ids=[VULS]),
            )

    def test_public_row_digest_and_identity_are_enforced(self) -> None:
        pin = catalog_pin()
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
        pin = dict(pin)
        import hashlib

        pin["public_selection_sha256"] = hashlib.sha256(
            json.dumps(public, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        validate_selected_public_row(value, pin)
        value["problem_statement"] = "changed"
        with self.assertRaisesRegex(ValueError, "fields drifted"):
            validate_selected_public_row(value, pin)

    def test_prompt_excludes_hidden_material(self) -> None:
        prompt = build_prompt(row())
        self.assertIn("Fix the public issue.", prompt)
        self.assertNotIn("hidden reference patch", prompt)
        self.assertNotIn("hidden verifier patch", prompt)
        self.assertNotIn(HIDDEN_COMMIT, prompt)
        self.assertIn("Do not assume access to hidden tests", prompt)


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
        return self.patch_content


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_setup_removes_history_and_finalize_keeps_patch_private(self) -> None:
        for number, identifier in enumerate((QUTE, VULS), 1):
            with self.subTest(identifier=identifier):
                selected = task(identifier)
                runtime = FakeRuntime()
                trace = SimpleNamespace(id=f"trace-{number}", info={})
                with (
                    patch(
                        "agencity_swe_bench_pro.taskset._shutdown_portable",
                        AsyncMock(return_value="stopped"),
                    ),
                    patch(
                        "agencity_swe_bench_pro.taskset._cleanup_portable",
                        AsyncMock(
                            return_value="workspace-metadata-and-state-removed"
                        ),
                    ),
                ):
                    await selected.setup(trace, runtime)
                    await selected.finalize(trace, runtime)
                self.assertTrue(
                    trace.info["swe_bench_pro_isolation"][
                        "original_git_history_removed"
                    ]
                )
                self.assertFalse(
                    trace.info["swe_bench_pro_isolation"][
                        "withheld_commits_resolvable"
                    ]
                )
                self.assertNotIn("diff --git", json.dumps(trace.info))
                self.assertEqual(
                    selected.take_patch(f"trace-{number}"),
                    "diff --git a/a b/a\n",
                )

    async def test_environment_scores_after_patch_capture(self) -> None:
        selected = task()
        selected._patches["trace-2"] = "private patch"
        rewards: list[tuple[str, float]] = []
        trace = SimpleNamespace(
            id="trace-2",
            has_error=False,
            info={},
            record_reward=lambda name, value: rewards.append((name, value)),
        )
        score = OfficialScore(
            reward=1.0,
            evidence={
                "agent_runtime_teardown_order": (
                    "verifiers-owned-runtime-stop-requested-before-env-finalize"
                )
            },
        )
        environment = object.__new__(SWEProEnv)
        with patch(
            "agencity_swe_bench_pro.taskset.score_with_official_evaluator",
            return_value=score,
        ) as scorer:
            await environment.finalize(
                selected, SimpleNamespace(traces=[trace])
            )
        scorer.assert_called_once_with(
            "private patch",
            selected.evaluator_row,
            selected.pin,
            trace_id="trace-2",
        )
        self.assertEqual(rewards, [("official_swe_bench_pro", 1.0)])

    async def test_harness_native_treatment_skips_agencity_cleanup(self) -> None:
        selected = task()
        selected.data = selected.data.model_copy(update={"treatment": "harness-native"})
        selected._baselines["trace-3"] = "a" * 40
        runtime = FakeRuntime()
        trace = SimpleNamespace(id="trace-3", info={})
        shutdown = AsyncMock()
        cleanup = AsyncMock()
        with (
            patch("agencity_swe_bench_pro.taskset._shutdown_portable", shutdown),
            patch("agencity_swe_bench_pro.taskset._cleanup_portable", cleanup),
        ):
            await selected.finalize(trace, runtime)
        shutdown.assert_not_awaited()
        cleanup.assert_not_awaited()


class ScorerEvidenceTests(unittest.TestCase):
    def test_official_parser_requires_nonempty_well_formed_evidence(self) -> None:
        validate_official_parser_output(
            {"tests": [{"name": "private-test", "status": "PASSED"}]}
        )
        with self.assertRaisesRegex(OfficialEvaluatorError, "no test"):
            validate_official_parser_output({"tests": []})
        with self.assertRaisesRegex(OfficialEvaluatorError, "malformed"):
            validate_official_parser_output(
                {"tests": [{"name": "", "status": "PASSED"}]}
            )
        with self.assertRaisesRegex(OfficialEvaluatorError, "conflicts"):
            validate_official_parser_output(
                {"tests": [{"name": "private-test", "status": "FAILED"}]},
                official_result=True,
            )

    def test_official_result_requires_exact_boolean(self) -> None:
        self.assertTrue(validate_official_evaluator_evidence({QUTE: True}, QUTE))
        with self.assertRaisesRegex(OfficialEvaluatorError, "one selected"):
            validate_official_evaluator_evidence({}, QUTE)
        with self.assertRaisesRegex(OfficialEvaluatorError, "boolean"):
            validate_official_evaluator_evidence({QUTE: "passed"}, QUTE)

    def test_alias_matches_upstream_shape(self) -> None:
        pin = catalog_pin()
        alias = _official_image_alias("127.0.0.1:0/agencity", QUTE, pin["repository"])
        self.assertEqual(
            alias,
            f"127.0.0.1:0/agencity/sweap-images:{pin['docker_tag']}",
        )


@unittest.skipUnless(
    os.environ.get("AGENCITY_SWE_PRO_OFFICIAL") == "1",
    "set AGENCITY_SWE_PRO_OFFICIAL=1 for official Docker scorer checks",
)
class OfficialScorerIntegrationTests(unittest.TestCase):
    def test_reference_patch_passes_and_noop_is_valid_zero(self) -> None:
        rows = load_selected_public_rows([QUTE])
        for identifier in (QUTE,):
            with self.subTest(identifier=identifier):
                selected_row = rows[identifier]
                pin = catalog_pin(identifier)
                reference = selected_row["patch"]
                passed = score_with_official_evaluator(
                    reference,
                    selected_row,
                    pin,
                    trace_id=f"reference-{identifier}",
                )
                zero = score_with_official_evaluator(
                    "diff --git a/.noop b/.noop\nnew file mode 100644\n",
                    selected_row,
                    pin,
                    trace_id=f"noop-{identifier}",
                )
                self.assertEqual(passed.reward, 1.0)
                self.assertEqual(zero.reward, 0.0)


if __name__ == "__main__":
    unittest.main()

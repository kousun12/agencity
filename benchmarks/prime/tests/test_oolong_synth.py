from __future__ import annotations

import hashlib
import json
import tempfile
import tomllib
import unittest
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from agencity_oolong_synth.taskset import (
    ANSWER_PATH,
    CONTEXT_PATH,
    DATASET_ID,
    DATASET_REVISION,
    OolongSynthConfig,
    OolongSynthData,
    OolongSynthTask,
    OolongSynthTaskset,
    SCORER_COMMIT,
    SCORER_SHA256,
    SELECTION_MANIFEST_ID,
    _prompt,
    _read_answer,
    parse_candidate,
    score_answer,
)
from agencity_verifiers.source import AGENCITY_SOURCE_REF
from agencity_verifiers.harness import RESULT_PATH, WORKSPACE_DIR
from agencity_verifiers.selection import SelectionSpec
from scripts.preflight_oolong import build_manifest


ROOT = Path(__file__).resolve().parent.parent


def row(**updates: object) -> dict[str, object]:
    value: dict[str, object] = {
        "id": 17,
        "context_len": 131072,
        "dataset": "yahoo",
        "context_window_text": "context body",
        "question": "Which label is most common?",
        "answer": "['Society & Culture']",
        "answer_type": "ANSWER_TYPE.CATEGORICAL",
        "context_window_id": 3,
    }
    value.update(updates)
    return value


class PromptContractTests(unittest.TestCase):
    def test_guides_bounded_file_and_recursive_aggregation(self) -> None:
        prompt = _prompt("Which label is most common?")
        self.assertIn(f"await Bun.file('{CONTEXT_PATH}').text()", prompt)
        self.assertIn("do not request the whole file as one typed page", prompt)
        self.assertIn("rlm.startMany([{ prompt, input }, ...])", prompt)
        self.assertIn("handle.result({ wait: true })", prompt)
        self.assertIn("not per-record output", prompt)
        self.assertIn("Reject empty or truncated results", prompt)

class ScoringTests(unittest.TestCase):
    def test_exact_label(self) -> None:
        result = score_answer(
            "['Society & Culture']",
            "",
            "Label: Society & Culture",
        )
        self.assertEqual(result.score, 1.0)
        self.assertEqual(result.parsed, "Society & Culture")

    def test_numeric_partial_credit_matches_official_rule(self) -> None:
        result = score_answer("[12]", "ANSWER_TYPE.NUMERIC", "Answer: 10")
        self.assertEqual(result.score, 0.75**2)

    def test_date_parsing_matches_official_rule(self) -> None:
        result = score_answer(
            "[datetime.date(2026, 8, 10)]",
            "ANSWER_TYPE.DATE",
            "Date: August 10, 2026",
        )
        self.assertEqual(result.score, 1.0)

    def test_bare_multiword_answer_is_not_truncated(self) -> None:
        parsed = parse_candidate(
            "I inspected the context and the requested final label is sports"
        )
        self.assertEqual(
            parsed,
            "I inspected the context and the requested final label is sports",
        )

    def test_pinned_prime_scorer_parity_vectors(self) -> None:
        self.assertEqual(SCORER_COMMIT, "ba7eabc710b0d49cab25f52a5457ad56ca04613c")
        self.assertEqual(
            SCORER_SHA256,
            "3cf9882c294be58f3b92cda5773c56ae5ebbb53e97f25c1ec9c8c612515c6131",
        )
        vectors = (
            ("['Sports']", "", "Sports", 1.0),
            ("['Society & Culture']", "", "Society & Culture", 1.0),
            ("['more common']", "", "Answer: more common.", 1.0),
            ("[12]", "ANSWER_TYPE.NUMERIC", "Answer: 10", 0.75**2),
            (
                "[datetime.date(2026, 8, 10)]",
                "ANSWER_TYPE.DATE",
                "Date: August 10, 2026",
                1.0,
            ),
            ("['Sports']", "", "wrong", 0.0),
        )
        for answer, answer_type, output, expected in vectors:
            with self.subTest(output=output):
                self.assertEqual(
                    score_answer(answer, answer_type, output).score,
                    expected,
                )


class LoadingTests(unittest.TestCase):
    def test_builds_file_context_task_from_pinned_selection(self) -> None:
        calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

        def fake_load_dataset(*args: object, **kwargs: object) -> list[dict[str, object]]:
            calls.append((args, kwargs))
            return [row()]

        config = OolongSynthConfig(
            id="agencity-oolong-synth",
            split="validation",
            expected_tasks=1,
            selection_manifest="none",
        )
        with patch("datasets.load_dataset", fake_load_dataset):
            tasks = OolongSynthTaskset(config).load()

        self.assertEqual(len(tasks), 1)
        data = tasks[0].data
        self.assertEqual(data.dataset_revision, DATASET_REVISION)
        self.assertEqual(
            data.context_sha256,
            hashlib.sha256(b"context body").hexdigest(),
        )
        self.assertIn(CONTEXT_PATH, data.prompt_text)
        self.assertIn(ANSWER_PATH, data.prompt_text)
        args, kwargs = calls[0]
        self.assertEqual(args, (DATASET_ID,))
        self.assertEqual(kwargs["revision"], DATASET_REVISION)
        self.assertEqual(
            kwargs["filters"],
            [("context_len", "==", 131072), ("dataset", "==", "yahoo")],
        )
        self.assertTrue(kwargs["streaming"])
        serialized = data.model_dump()
        self.assertNotIn("context", serialized)
        self.assertNotIn("answer", serialized)
        self.assertNotIn("question", serialized)

    def test_rejects_an_incomplete_pinned_selection(self) -> None:
        config = OolongSynthConfig(
            id="agencity-oolong-synth",
            split="validation",
            expected_tasks=2,
            selection_manifest="none",
        )
        with (
            patch("datasets.load_dataset", return_value=[row()]),
            self.assertRaisesRegex(ValueError, "expected 2"),
        ):
            OolongSynthTaskset(config).load()

    def test_can_exclude_numeric_tasks_explicitly(self) -> None:
        config = OolongSynthConfig(
            id="agencity-oolong-synth",
            split="validation",
            filter_numerical=True,
            expected_tasks=1,
            selection_manifest="none",
        )
        rows = [
            row(),
            row(
                id=18,
                context_window_id=4,
                answer="[7]",
                answer_type="ANSWER_TYPE.NUMERIC",
            ),
        ]
        with patch("datasets.load_dataset", return_value=rows):
            tasks = OolongSynthTaskset(config).load()
        self.assertEqual([task.data.row_id for task in tasks], [17])

    def test_supports_exact_sample_shard_and_full_selection(self) -> None:
        rows = [
            row(id=17 + index, context_window_id=3 + index)
            for index in range(8)
        ]
        cases = (
            (
                SelectionSpec(
                    mode="exact", ids=["yahoo:131072:20:6"]
                ),
                ["yahoo:131072:20:6"],
            ),
            (SelectionSpec(mode="sample", count=3, seed=7), None),
            (SelectionSpec(mode="shard", shard_index=0, shard_count=2), None),
            (SelectionSpec(mode="all"), [f"yahoo:131072:{17 + i}:{3 + i}" for i in range(8)]),
        )
        for selection, expected in cases:
            config = OolongSynthConfig(
                id="agencity-oolong-synth",
                split="validation",
                expected_tasks=8,
                selection=selection,
                selection_manifest="none",
            )
            with patch("datasets.load_dataset", return_value=rows):
                tasks = OolongSynthTaskset(config).load()
            identifiers = [task.data.selection_id for task in tasks]
            if expected is not None:
                self.assertEqual(identifiers, expected)
            self.assertTrue(
                all(task.data.selected_ids_sha256 for task in tasks)
            )

    def test_sol_eight_task_config_is_exactly_stratified_across_contexts(self) -> None:
        value = tomllib.loads(
            (ROOT / "configs/oolong-yahoo-128k-sol-8-current.toml").read_text(
                encoding="utf-8"
            )
        )
        selection = value["env"]["taskset"]["selection"]
        identifiers = selection["ids"]
        self.assertEqual(selection["mode"], "ids")
        self.assertEqual(value["num_tasks"], 8)
        self.assertEqual(value["max_concurrent"], 1)
        self.assertEqual(len(identifiers), 8)
        contexts = Counter(identifier.rsplit(":", 1)[1] for identifier in identifiers)
        self.assertEqual(contexts, {"50021": 4, "50022": 4})
        self.assertEqual(len(set(identifiers)), len(identifiers))

    def test_manifest_is_an_admission_check(self) -> None:
        context = "context body"
        context_digest = hashlib.sha256(context.encode()).hexdigest()
        manifest = {
            "protocol": "agencity.oolong-selection",
            "version": 1,
            "dataset": DATASET_ID,
            "revision": DATASET_REVISION,
            "split": "test",
            "datasetName": "yahoo",
            "contextLength": 131072,
            "withLabels": False,
            "filterNumerical": False,
            "taskCount": 1,
            "contextWindowCount": 1,
            "contexts": [
                {
                    "contextWindowId": 3,
                    "sha256": context_digest,
                    "bytes": len(context),
                }
            ],
            "tasks": [
                {
                    "rowId": 17,
                    "contextWindowId": 3,
                    "contextSha256": context_digest,
                    "contextBytes": len(context),
                    "answerType": "",
                }
            ],
        }
        encoded = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "selection.json"
            path.write_bytes(encoded)
            digest = hashlib.sha256(encoded).hexdigest()
            with (
                patch(
                    "agencity_oolong_synth.taskset.SELECTION_MANIFEST_PATH",
                    path,
                ),
                patch(
                    "agencity_oolong_synth.taskset.SELECTION_MANIFEST_SHA256",
                    digest,
                ),
            ):
                config = OolongSynthConfig(
                    id="agencity-oolong-synth",
                    expected_tasks=1,
                    selection=SelectionSpec(mode="all"),
                    selection_manifest=SELECTION_MANIFEST_ID,
                    selection_manifest_sha256=digest,
                )
                with patch("datasets.load_dataset", return_value=[row()]):
                    tasks = OolongSynthTaskset(config).load()
                self.assertEqual(tasks[0].data.selection_manifest_sha256, digest)

                changed = row(id=18)
                with (
                    patch("datasets.load_dataset", return_value=[changed]),
                    self.assertRaisesRegex(ValueError, "do not match"),
                ):
                    OolongSynthTaskset(config).load()

    def test_pinned_comparison_slice_cannot_disable_manifest(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires its pinned manifest"):
            OolongSynthConfig(
                id="agencity-oolong-synth",
                selection_manifest="none",
            )

    def test_manifest_builder_retains_exact_order_and_contexts(self) -> None:
        config = OolongSynthConfig(
            id="agencity-oolong-synth",
            split="validation",
            expected_tasks=1,
            selection=SelectionSpec(mode="all"),
            selection_manifest="none",
        )
        with patch("datasets.load_dataset", return_value=[row()]):
            tasks = OolongSynthTaskset(config).load()
        manifest = build_manifest(tasks, config)
        self.assertEqual(manifest["tasks"][0]["rowId"], 17)
        self.assertEqual(manifest["tasks"][0]["contextWindowId"], 3)
        self.assertEqual(manifest["contextWindowCount"], 1)

    def test_oolong_configs_pin_manifest_source_and_portable_cleanup(self) -> None:
        config_paths = sorted((ROOT / "configs").glob("oolong-*.toml"))
        self.assertTrue(config_paths)
        for path in config_paths:
            with self.subTest(config=path.name):
                value = tomllib.loads(path.read_text(encoding="utf-8"))
                taskset = value["env"]["taskset"]
                harness = value["env"]["agent"]["harness"]
                self.assertEqual(harness["installation"], "portable")
                self.assertEqual(
                    harness["source_ref"],
                    AGENCITY_SOURCE_REF,
                )
                if taskset["dataset_name"] == "yahoo":
                    self.assertEqual(
                        taskset["selection_manifest"],
                        SELECTION_MANIFEST_ID,
                    )
                    self.assertEqual(
                        taskset["selection_manifest_sha256"],
                        "d0a105f1ee619adf94cdaf8cc5e9606cb82a57bd7f970d476a3a2db3b9a5c275",
                    )
        full = tomllib.loads(
            (ROOT / "configs/oolong-yahoo-128k-full.toml").read_text()
        )
        self.assertEqual(full["max_concurrent"], 1)


class FakeRuntime:
    def __init__(self, answer: bytes | Exception) -> None:
        self.answer = answer

    async def read(self, path: str) -> bytes:
        self.path = path
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


class MappingRuntime:
    def __init__(self, files: dict[str, bytes]) -> None:
        self.files = files

    async def read(self, path: str) -> bytes:
        if path not in self.files:
            raise FileNotFoundError(path)
        return self.files[path]


class AnswerSourceTests(unittest.IsolatedAsyncioTestCase):
    async def test_prefers_answer_file(self) -> None:
        runtime = FakeRuntime(b"Society & Culture\n")
        answer, source, evidence = await _read_answer(runtime, "different")
        self.assertEqual((answer, source), ("Society & Culture", "answer_file"))
        self.assertFalse(evidence["answer_sources_agree"])
        self.assertEqual(runtime.path, ANSWER_PATH)

    async def test_falls_back_to_agencity_final(self) -> None:
        runtime = FakeRuntime(FileNotFoundError())
        answer, source, evidence = await _read_answer(
            runtime, "Society & Culture"
        )
        self.assertEqual((answer, source), ("Society & Culture", "agencity_final"))
        self.assertIsNone(evidence["answer_sources_agree"])


class RewardTests(unittest.IsolatedAsyncioTestCase):
    def task(self) -> OolongSynthTask:
        context = "context"
        return OolongSynthTask(
            OolongSynthData(
                idx=1,
                name="yahoo:131072:1:2",
                prompt="prompt",
                workdir=WORKSPACE_DIR,
                selection_id="yahoo:131072:1:2",
                dataset_revision=DATASET_REVISION,
                dataset_name="yahoo",
                row_id=1,
                context_window_id=2,
                context_len=131072,
                context_sha256=hashlib.sha256(context.encode()).hexdigest(),
                context_bytes=len(context),
            ),
            context=context,
            answer="['Sports']",
        )

    async def test_scores_success_from_terminal_artifact_and_answer_file(self) -> None:
        result = {
            "protocol": "agencity.run-result",
            "version": 1,
            "status": "succeeded",
            "exitCode": 0,
            "steps": 3,
            "final": "Label: Sports",
        }
        runtime = MappingRuntime(
            {
                RESULT_PATH: json.dumps(result).encode(),
                ANSWER_PATH: b"Label: Sports\n",
            }
        )
        trace = SimpleNamespace(info={})
        reward = await self.task().correct(trace, runtime)
        self.assertEqual(reward, 1.0)
        self.assertEqual(trace.info["oolong"]["answer_source"], "answer_file")
        self.assertEqual(trace.info["agencity"]["status"], "succeeded")

    async def test_preserves_terminal_failure_as_zero_reward(self) -> None:
        result = {
            "protocol": "agencity.run-result",
            "version": 1,
            "status": "failed",
            "exitCode": 1,
            "steps": 9,
            "final": None,
        }
        runtime = MappingRuntime({RESULT_PATH: json.dumps(result).encode()})
        trace = SimpleNamespace(info={})
        reward = await self.task().correct(trace, runtime)
        self.assertEqual(reward, 0.0)
        self.assertIsNone(trace.info["oolong"]["answer_source"])

    async def test_scores_portable_retained_result_without_artifact(self) -> None:
        runtime = MappingRuntime({ANSWER_PATH: b"Sports\n"})
        trace = SimpleNamespace(
            info={
                "agencity": {
                    "protocol": "agencity.run-result",
                    "version": 1,
                    "status": "succeeded",
                    "exit_code": 0,
                    "steps": 2,
                    "final": "Sports",
                }
            }
        )
        reward = await self.task().correct(trace, runtime)
        self.assertEqual(reward, 1.0)
        self.assertTrue(trace.info["oolong"]["answer_sources_agree"])
        self.assertEqual(
            trace.info["benchmark_provenance"]["scorer_commit"],
            SCORER_COMMIT,
        )


if __name__ == "__main__":
    unittest.main()

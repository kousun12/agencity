from __future__ import annotations

import hashlib
import json
import unittest
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
    _read_answer,
    parse_candidate,
    score_answer,
)
from agencity_verifiers.harness import RESULT_PATH, WORKSPACE_DIR


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


class ScoringTests(unittest.TestCase):
    def test_exact_label(self) -> None:
        result = score_answer(
            "['Society & Culture']",
            "",
            "Label: Society & Culture",
        )
        self.assertEqual(result.score, 1.0)
        self.assertEqual(result.parsed, "Society & Culture")
        self.assertEqual(result.confidence, "vhigh")

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

    def test_long_unstructured_answer_uses_last_token(self) -> None:
        parsed, confidence = parse_candidate(
            "I inspected the context and the requested final label is sports"
        )
        self.assertEqual(parsed, "sports")
        self.assertEqual(confidence, "low")


class LoadingTests(unittest.TestCase):
    def test_builds_file_context_task_from_pinned_selection(self) -> None:
        calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

        def fake_load_dataset(*args: object, **kwargs: object) -> list[dict[str, object]]:
            calls.append((args, kwargs))
            return [row()]

        config = OolongSynthConfig(
            id="agencity-oolong-synth",
            expected_tasks=1,
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

    def test_rejects_an_incomplete_pinned_selection(self) -> None:
        config = OolongSynthConfig(
            id="agencity-oolong-synth",
            expected_tasks=2,
        )
        with (
            patch("datasets.load_dataset", return_value=[row()]),
            self.assertRaisesRegex(ValueError, "expected 2"),
        ):
            OolongSynthTaskset(config).load()

    def test_can_exclude_numeric_tasks_explicitly(self) -> None:
        config = OolongSynthConfig(
            id="agencity-oolong-synth",
            filter_numerical=True,
            expected_tasks=1,
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
        answer, source = await _read_answer(runtime, "different")
        self.assertEqual((answer, source), ("Society & Culture", "answer_file"))
        self.assertEqual(runtime.path, ANSWER_PATH)

    async def test_falls_back_to_agencity_final(self) -> None:
        runtime = FakeRuntime(FileNotFoundError())
        answer, source = await _read_answer(runtime, "Society & Culture")
        self.assertEqual((answer, source), ("Society & Culture", "agencity_final"))


class RewardTests(unittest.IsolatedAsyncioTestCase):
    def task(self) -> OolongSynthTask:
        context = "context"
        return OolongSynthTask(
            OolongSynthData(
                idx=1,
                prompt="prompt",
                workdir=WORKSPACE_DIR,
                dataset_revision=DATASET_REVISION,
                dataset_name="yahoo",
                row_id=1,
                context_window_id=2,
                context_len=131072,
                question="question",
                answer="['Sports']",
                context=context,
                context_sha256=hashlib.sha256(context.encode()).hexdigest(),
                context_bytes=len(context),
            )
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


if __name__ == "__main__":
    unittest.main()

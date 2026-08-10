from __future__ import annotations

import ast
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

import dateutil.parser
import verifiers.v1 as vf

from agencity_verifiers.harness import RESULT_PATH, WORKSPACE_DIR
from agencity_verifiers.result import parse_run_result


DATASET_ID = "oolongbench/oolong-synth"
DATASET_REVISION = "f0d59eaf0febf130664cfceb710436c8e3216b2b"
CONTEXT_PATH = f"{WORKSPACE_DIR}/oolong-context.txt"
ANSWER_PATH = f"{WORKSPACE_DIR}/oolong-answer.txt"
MAX_ANSWER_BYTES = 4 * 1024

ContextLen = Literal[
    1024,
    2048,
    4096,
    8192,
    16384,
    32768,
    65536,
    131072,
    262144,
    524288,
    1048576,
    2097152,
    4194304,
]
DatasetName = Literal[
    "spam",
    "trec_coarse",
    "agnews",
    "app_reviews",
    "formality",
    "imdb",
    "metaphors",
    "multinli",
    "negation",
    "yahoo",
]
AnswerType = Literal["", "ANSWER_TYPE.NUMERIC", "ANSWER_TYPE.DATE"]


def _prompt(question: str) -> str:
    return (
        f"The benchmark context is stored in `{CONTEXT_PATH}`. Inspect that file "
        "programmatically and answer this question. The runtime provides Bun and "
        "Agencity's TypeScript console, including `sdk.rlm.start`, "
        "`sdk.rlm.startMany`, and `sdk.rlm.result` for recursive model work; do "
        "not assume Python or Node are installed. If you delegate, keep the "
        "returned handles and collect and aggregate child results inside the "
        "TypeScript cell rather than returning bulk child output to the parent "
        "model.\n\n"
        f"{question}\n\n"
        f"Write only the final answer to `{ANSWER_PATH}`, then finish with exactly "
        "the same answer. The answer should be one label, number, date, user ID, "
        "or comparison phrase as requested by the question."
    )


@dataclass(frozen=True)
class ScoredAnswer:
    score: float
    parsed: str
    confidence: str
    gold: str


def parse_candidate(output: str) -> tuple[str, str]:
    confidence = "low"
    if ":" not in output:
        if len(output) < 20:
            return output, confidence
        return output.split()[-1], confidence

    candidate = output.split(":")[-1].strip()
    candidate = candidate.replace("*", "").replace("[", "").replace("]", "")
    confidence = "med"
    if any(
        marker in output for marker in ("User:", "Answer:", "Date:", "Label")
    ):
        confidence = "high"
    if len(candidate) < 20:
        confidence = "vhigh"
    elif "more common" in candidate:
        candidate = "more common"
    elif "less common" in candidate:
        candidate = "less common"
    elif "same frequency" in candidate:
        candidate = "same frequency"
    return candidate, confidence


def parse_gold(answer_raw: str) -> object:
    if "datetime" not in answer_raw:
        parsed = ast.literal_eval(answer_raw)
        if not isinstance(parsed, list) or not parsed:
            raise ValueError("OOLONG gold answer must be a non-empty list literal")
        return parsed[0]
    return datetime.strptime(answer_raw, "[datetime.date(%Y, %m, %d)]")


def score_answer(answer_raw: str, answer_type: str, output: str) -> ScoredAnswer:
    gold = parse_gold(answer_raw)
    parsed, confidence = parse_candidate(output.strip())
    score = 0.0

    if str(parsed) == str(gold):
        score = 1.0
    elif parsed in {"more common", "less common", "same frequency"}:
        score = float(parsed in str(gold))
    elif answer_type == "ANSWER_TYPE.NUMERIC":
        try:
            score = float(0.75 ** abs(int(gold) - int(parsed)))
        except (TypeError, ValueError):
            confidence = "low"
    elif answer_type == "ANSWER_TYPE.DATE":
        try:
            score = float(dateutil.parser.parse(str(parsed)) == gold)
        except (TypeError, ValueError, OverflowError):
            confidence = "low"

    return ScoredAnswer(
        score=score,
        parsed=str(parsed),
        confidence=confidence,
        gold=str(gold),
    )


class OolongSynthData(vf.TaskData):
    dataset_revision: str
    dataset_name: str
    row_id: int
    context_window_id: int
    context_len: int
    question: str
    answer: str
    answer_type: AnswerType = ""
    context: str
    context_sha256: str
    context_bytes: int


class OolongSynthTask(vf.Task[OolongSynthData]):
    NEEDS_CONTAINER = True

    async def setup(self, runtime: vf.Runtime) -> None:
        encoded = self.data.context.encode("utf-8")
        if len(encoded) != self.data.context_bytes:
            raise ValueError("OOLONG context byte count changed before setup")
        if hashlib.sha256(encoded).hexdigest() != self.data.context_sha256:
            raise ValueError("OOLONG context digest changed before setup")
        result = await runtime.run(["mkdir", "-p", WORKSPACE_DIR], {})
        if result.exit_code != 0:
            raise RuntimeError(f"could not create OOLONG workspace: {result.stderr}")
        await runtime.write(CONTEXT_PATH, encoded)

    @vf.reward(weight=1.0)
    async def correct(self, trace: vf.Trace, runtime: vf.Runtime) -> float:
        raw_result = (await runtime.read(RESULT_PATH)).decode("utf-8")
        value = json.loads(raw_result)
        if not isinstance(value, dict) or not isinstance(value.get("exitCode"), int):
            raise ValueError("Agencity result artifact is malformed")
        result = parse_run_result(raw_result, value["exitCode"])

        trace.info["agencity"] = {
            "status": result.status,
            "steps": result.value["steps"],
        }
        if result.status != "succeeded":
            trace.info["oolong"] = {
                "answer_source": None,
                "context_sha256": self.data.context_sha256,
                "context_bytes": self.data.context_bytes,
                "score": 0.0,
            }
            return 0.0

        answer, answer_source = await _read_answer(runtime, result.final)
        scored = score_answer(self.data.answer, self.data.answer_type, answer)
        trace.info["oolong"] = {
            "answer_source": answer_source,
            "context_sha256": self.data.context_sha256,
            "context_bytes": self.data.context_bytes,
            "parsed_answer": scored.parsed,
            "parse_confidence": scored.confidence,
            "score": scored.score,
        }
        return scored.score


async def _read_answer(
    runtime: vf.Runtime,
    final: str | None,
) -> tuple[str, str]:
    try:
        raw = await runtime.read(ANSWER_PATH)
    except Exception:
        raw = b""
    if len(raw) > MAX_ANSWER_BYTES:
        raise ValueError("OOLONG answer file exceeds 4 KiB")
    if raw:
        answer = raw.decode("utf-8").strip()
        if answer:
            return answer, "answer_file"
    if final is None:
        raise ValueError("successful Agencity result has no final answer")
    return final.strip(), "agencity_final"


class OolongSynthConfig(vf.TasksetConfig):
    split: Literal["validation", "test"] = "test"
    dataset_name: DatasetName | None = "yahoo"
    context_len: ContextLen = 131072
    with_labels: bool = False
    filter_numerical: bool = False
    expected_tasks: int | None = 50
    dataset_revision: str = DATASET_REVISION
    cache_dir: str | None = None


class OolongSynthTaskset(vf.Taskset[OolongSynthTask, OolongSynthConfig]):
    def load(self) -> list[OolongSynthTask]:
        from datasets import load_dataset

        cfg = self.config
        context_column = (
            "context_window_text_with_labels"
            if cfg.with_labels
            else "context_window_text"
        )
        columns = [
            "id",
            "context_len",
            "dataset",
            context_column,
            "question",
            "answer",
            "answer_type",
            "context_window_id",
        ]
        filters: list[tuple[str, str, object]] = [
            ("context_len", "==", cfg.context_len),
        ]
        if cfg.dataset_name is not None:
            filters.append(("dataset", "==", cfg.dataset_name))

        rows = load_dataset(
            DATASET_ID,
            split=cfg.split,
            revision=cfg.dataset_revision,
            streaming=True,
            cache_dir=cfg.cache_dir,
            columns=columns,
            filters=filters,
        )
        tasks: list[OolongSynthTask] = []
        seen: set[tuple[int, int]] = set()
        for row in rows:
            if row["context_len"] != cfg.context_len:
                raise ValueError("OOLONG loader returned the wrong context length")
            if cfg.dataset_name is not None and row["dataset"] != cfg.dataset_name:
                raise ValueError("OOLONG loader returned the wrong source dataset")
            answer_type = row.get("answer_type", "")
            if answer_type not in ("ANSWER_TYPE.NUMERIC", "ANSWER_TYPE.DATE"):
                answer_type = ""
            if cfg.filter_numerical and answer_type == "ANSWER_TYPE.NUMERIC":
                continue

            context = row[context_column]
            if not isinstance(context, str) or not context:
                raise ValueError("OOLONG row has no context text")
            encoded = context.encode("utf-8")
            row_id = int(row["id"])
            context_window_id = int(row["context_window_id"])
            key = (row_id, context_window_id)
            if key in seen:
                raise ValueError(f"duplicate OOLONG task identity: {key}")
            seen.add(key)
            dataset_name = str(row["dataset"])
            tasks.append(
                OolongSynthTask(
                    OolongSynthData(
                        idx=row_id,
                        name=f"{dataset_name}-{cfg.context_len}-{row_id}",
                        description="OOLONG-synth file-context aggregation task",
                        prompt=_prompt(str(row["question"])),
                        workdir=WORKSPACE_DIR,
                        network_allow=[],
                        network_block=["*"],
                        dataset_revision=cfg.dataset_revision,
                        dataset_name=dataset_name,
                        row_id=row_id,
                        context_window_id=context_window_id,
                        context_len=cfg.context_len,
                        question=str(row["question"]),
                        answer=str(row["answer"]),
                        answer_type=answer_type,
                        context=context,
                        context_sha256=hashlib.sha256(encoded).hexdigest(),
                        context_bytes=len(encoded),
                    )
                )
            )

        if cfg.expected_tasks is not None and len(tasks) != cfg.expected_tasks:
            raise ValueError(
                f"expected {cfg.expected_tasks} OOLONG tasks, loaded {len(tasks)}"
            )
        if not tasks:
            raise ValueError("OOLONG selection produced no tasks")
        return tasks

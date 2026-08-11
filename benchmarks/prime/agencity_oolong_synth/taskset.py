from __future__ import annotations

import ast
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal

import dateutil.parser
from pydantic import Field, model_validator
import verifiers.v1 as vf

from agencity_verifiers.harness import RESULT_PATH, WORKSPACE_DIR
from agencity_verifiers.result import parse_run_result
from agencity_verifiers.selection import SelectionSpec, select_loaded_items


DATASET_ID = "oolongbench/oolong-synth"
DATASET_REVISION = "f0d59eaf0febf130664cfceb710436c8e3216b2b"
CONTEXT_PATH = f"{WORKSPACE_DIR}/oolong-context.txt"
ANSWER_PATH = f"{WORKSPACE_DIR}/oolong-answer.txt"
MAX_ANSWER_BYTES = 4 * 1024
SCORER_REPOSITORY = "https://github.com/PrimeIntellect-ai/research-environments"
SCORER_COMMIT = "ba7eabc710b0d49cab25f52a5457ad56ca04613c"
SCORER_PATH = "environments/oolong_synth_v1/oolong_synth_v1/taskset.py"
SCORER_SHA256 = "3cf9882c294be58f3b92cda5773c56ae5ebbb53e97f25c1ec9c8c612515c6131"
SELECTION_MANIFEST_ID = "yahoo-test-128k-v1"
SELECTION_MANIFEST_SHA256 = (
    "d0a105f1ee619adf94cdaf8cc5e9606cb82a57bd7f970d476a3a2db3b9a5c275"
)
SOURCE_MANIFEST_PATH = (
    Path(__file__).resolve().parent.parent
    / "manifests"
    / "oolong-yahoo-128k.json"
)
PACKAGED_MANIFEST_PATH = Path(__file__).resolve().parent / "data" / "selection.json"
SELECTION_MANIFEST_PATH = (
    SOURCE_MANIFEST_PATH
    if SOURCE_MANIFEST_PATH.is_file()
    else PACKAGED_MANIFEST_PATH
)

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
        f"The benchmark context is stored in `{CONTEXT_PATH}` and is larger than "
        "one typed file page. Read the complete file inside a TypeScript cell with "
        f"`await Bun.file({CONTEXT_PATH!r}).text()`, or use bounded "
        "`tools.readFile` line windows; do not request the whole file as one typed "
        "page. Bun is available, but do not assume Python or Node are installed.\n\n"
        "For parallel recursive work, use "
        "`const handles = await rlm.startMany([{ prompt, input }, ...])`, then "
        "collect the results in the same cell with "
        "`await Promise.all(handles.map((handle) => "
        "handle.result({ wait: true })))`. Give each child a self-contained input "
        "and require only a compact partial aggregate that fits the configured "
        "output limit, not per-record output. Reject empty or truncated results "
        "before aggregation. Keep handles and child-result aggregation inside the "
        "cell, and return only the compact evidence needed for the next decision.\n\n"
        f"{question}\n\n"
        f"Write only the final answer to `{ANSWER_PATH}` with `Bun.write`, then "
        "finish with exactly the same answer. The answer should be one label, "
        "number, date, user ID, or comparison phrase as requested by the question."
    )


@dataclass(frozen=True)
class ScoredAnswer:
    score: float
    parsed: str
    gold: str


def parse_candidate(output: str) -> str:
    """Port of the pinned Prime OOLONG-synth v1 answer parser."""

    if ":" not in output:
        return output
    candidate = output.split(":")[-1].strip()
    candidate = candidate.replace("*", "").replace("[", "").replace("]", "")
    for phrase in ("more common", "less common", "same frequency"):
        if phrase in candidate:
            return phrase
    return candidate


def parse_gold(answer_raw: str) -> object:
    if "datetime" not in answer_raw:
        parsed = ast.literal_eval(answer_raw)
        if not isinstance(parsed, list) or not parsed:
            raise ValueError("OOLONG gold answer must be a non-empty list literal")
        return parsed[0]
    return datetime.strptime(answer_raw, "[datetime.date(%Y, %m, %d)]")


def score_answer(answer_raw: str, answer_type: str, output: str) -> ScoredAnswer:
    gold = parse_gold(answer_raw)
    parsed = parse_candidate(output.strip())
    score = 0.0

    if str(parsed) == str(gold):
        score = 1.0
    elif parsed in {"more common", "less common", "same frequency"}:
        score = float(parsed in str(gold))
    elif answer_type == "ANSWER_TYPE.NUMERIC":
        try:
            score = float(0.75 ** abs(int(gold) - int(parsed)))
        except (TypeError, ValueError):
            pass
    elif answer_type == "ANSWER_TYPE.DATE":
        try:
            score = float(dateutil.parser.parse(str(parsed)) == gold)
        except (TypeError, ValueError, OverflowError):
            pass

    return ScoredAnswer(
        score=score,
        parsed=str(parsed),
        gold=str(gold),
    )


class OolongSynthData(vf.TaskData):
    selection_id: str
    dataset_id: str = DATASET_ID
    dataset_revision: str
    dataset_name: str
    row_id: int
    context_window_id: int
    context_len: int
    answer_type: AnswerType = ""
    context_sha256: str
    context_bytes: int
    selected_ids: list[str] = Field(default_factory=list)
    selected_ids_sha256: str = ""
    selection_manifest_id: str | None = None
    selection_manifest_sha256: str | None = None
    scorer_repository: str = SCORER_REPOSITORY
    scorer_commit: str = SCORER_COMMIT
    scorer_path: str = SCORER_PATH
    scorer_sha256: str = SCORER_SHA256


class OolongSynthTask(vf.Task[OolongSynthData]):
    NEEDS_CONTAINER = True

    def __init__(
        self,
        data: OolongSynthData,
        config: vf.TaskConfig | None = None,
        *,
        context: str,
        answer: str,
    ) -> None:
        super().__init__(data, config)
        self._context = context
        self._answer = answer

    async def setup(self, runtime: vf.Runtime) -> None:
        encoded = self._context.encode("utf-8")
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
        retained = trace.info.get("agencity")
        if (
            isinstance(retained, dict)
            and isinstance(retained.get("status"), str)
            and isinstance(retained.get("steps"), int)
        ):
            status = retained["status"]
            steps = retained["steps"]
            final = retained.get("final")
            if final is not None and not isinstance(final, str):
                raise ValueError("Retained Agencity final answer is malformed")
        else:
            raw_result = (await runtime.read(RESULT_PATH)).decode("utf-8")
            value = json.loads(raw_result)
            if not isinstance(value, dict) or not isinstance(value.get("exitCode"), int):
                raise ValueError("Agencity result artifact is malformed")
            result = parse_run_result(raw_result, value["exitCode"])
            status = result.status
            steps = result.value["steps"]
            final = result.final
            trace.info["agencity"] = {
                "status": status,
                "steps": steps,
                "final": final,
            }
        trace.info["benchmark_provenance"] = {
            "schema": "agencity.benchmark-task-provenance.v1",
            "benchmark": "oolong-synth",
            "selection_id": self.data.selection_id,
            "selected_ids": self.data.selected_ids,
            "selected_ids_sha256": self.data.selected_ids_sha256,
            "dataset": DATASET_ID,
            "dataset_revision": self.data.dataset_revision,
            "dataset_name": self.data.dataset_name,
            "context_len": self.data.context_len,
            "context_window_id": self.data.context_window_id,
            "context_sha256": self.data.context_sha256,
            "context_bytes": self.data.context_bytes,
            "selection_manifest_id": self.data.selection_manifest_id,
            "selection_manifest_sha256": self.data.selection_manifest_sha256,
            "scorer_repository": SCORER_REPOSITORY,
            "scorer_commit": SCORER_COMMIT,
            "scorer_path": SCORER_PATH,
            "scorer_sha256": SCORER_SHA256,
        }
        if status != "succeeded":
            trace.info["oolong"] = {
                "answer_source": None,
                "context_sha256": self.data.context_sha256,
                "context_bytes": self.data.context_bytes,
                "score": 0.0,
            }
            return 0.0

        answer, answer_source, answer_evidence = await _read_answer(runtime, final)
        scored = score_answer(self._answer, self.data.answer_type, answer)
        trace.info["oolong"] = {
            "answer_source": answer_source,
            **answer_evidence,
            "context_sha256": self.data.context_sha256,
            "context_bytes": self.data.context_bytes,
            "parsed_answer": scored.parsed,
            "score": scored.score,
        }
        return scored.score


async def _read_answer(
    runtime: vf.Runtime,
    final: str | None,
) -> tuple[str, str, dict[str, object]]:
    try:
        raw = await runtime.read(ANSWER_PATH)
    except Exception:
        raw = b""
    if len(raw) > MAX_ANSWER_BYTES:
        raise ValueError("OOLONG answer file exceeds 4 KiB")
    if raw:
        answer = raw.decode("utf-8").strip()
        if answer:
            normalized_final = final.strip() if final is not None else None
            return (
                answer,
                "answer_file",
                {
                    "answer_file_sha256": _text_digest(answer),
                    "terminal_final_sha256": (
                        _text_digest(normalized_final)
                        if normalized_final is not None
                        else None
                    ),
                    "answer_sources_agree": (
                        answer == normalized_final
                        if normalized_final is not None
                        else None
                    ),
                },
            )
    if final is None:
        raise ValueError("successful Agencity result has no final answer")
    answer = final.strip()
    return (
        answer,
        "agencity_final",
        {
            "answer_file_sha256": None,
            "terminal_final_sha256": _text_digest(answer),
            "answer_sources_agree": None,
        },
    )


class OolongSynthConfig(vf.TasksetConfig):
    split: Literal["validation", "test"] = "test"
    dataset_name: DatasetName | None = "yahoo"
    context_len: ContextLen = 131072
    with_labels: bool = False
    filter_numerical: bool = False
    expected_tasks: int | None = 50
    dataset_revision: str = DATASET_REVISION
    cache_dir: str | None = None
    selection: SelectionSpec = SelectionSpec()
    selection_manifest: Literal["yahoo-test-128k-v1", "none"] = (
        SELECTION_MANIFEST_ID
    )
    selection_manifest_sha256: str | None = SELECTION_MANIFEST_SHA256

    @model_validator(mode="after")
    def validate_manifest_pin(self) -> "OolongSynthConfig":
        if self.selection_manifest == "none":
            if (
                self.split == "test"
                and self.dataset_name == "yahoo"
                and self.context_len == 131072
                and not self.with_labels
                and not self.filter_numerical
            ):
                raise ValueError(
                    "the Yahoo test/128K comparison slice requires its pinned manifest"
                )
            if (
                "selection_manifest_sha256" in self.model_fields_set
                and self.selection_manifest_sha256 is not None
            ):
                raise ValueError(
                    "unmanifested OOLONG selections cannot declare a manifest digest"
                )
            self.selection_manifest_sha256 = None
            return self
        if self.selection_manifest_sha256 != SELECTION_MANIFEST_SHA256:
            raise ValueError("OOLONG selection manifest SHA-256 is unsupported")
        _load_selection_manifest(self)
        return self


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
            selection_id = (
                f"{dataset_name}:{cfg.context_len}:{row_id}:{context_window_id}"
            )
            tasks.append(
                OolongSynthTask(
                    OolongSynthData(
                        idx=row_id,
                        name=selection_id,
                        description="OOLONG-synth file-context aggregation task",
                        prompt=_prompt(str(row["question"])),
                        workdir=WORKSPACE_DIR,
                        network_allow=[],
                        network_block=["*"],
                        selection_id=selection_id,
                        dataset_revision=cfg.dataset_revision,
                        dataset_name=dataset_name,
                        row_id=row_id,
                        context_window_id=context_window_id,
                        context_len=cfg.context_len,
                        answer_type=answer_type,
                        context_sha256=hashlib.sha256(encoded).hexdigest(),
                        context_bytes=len(encoded),
                    ),
                    context=context,
                    answer=str(row["answer"]),
                )
            )

        if cfg.expected_tasks is not None and len(tasks) != cfg.expected_tasks:
            raise ValueError(
                f"expected {cfg.expected_tasks} OOLONG tasks, loaded {len(tasks)}"
            )
        if not tasks:
            raise ValueError("OOLONG selection produced no tasks")
        manifest_sha256 = _validate_manifest_tasks(tasks, cfg)
        ordered_ids = sorted(task.data.selection_id for task in tasks)
        selected, manifest = select_loaded_items(
            tasks,
            cfg.selection,
            identifier=lambda task: task.data.selection_id,
            smoke_subsets={
                "default": ordered_ids[:1],
                "fixed": ordered_ids[:1],
            },
        )
        return [
            OolongSynthTask(
                task.data.model_copy(
                    update={
                        "selected_ids": manifest["selected_ids"],
                        "selected_ids_sha256": manifest["selected_ids_sha256"],
                        "selection_manifest_id": (
                            cfg.selection_manifest
                            if cfg.selection_manifest != "none"
                            else None
                        ),
                        "selection_manifest_sha256": manifest_sha256,
                    }
                ),
                task.config,
                context=task._context,
                answer=task._answer,
            )
            for task in selected
        ]


def _load_selection_manifest(config: OolongSynthConfig) -> dict[str, object]:
    payload = SELECTION_MANIFEST_PATH.read_bytes()
    if hashlib.sha256(payload).hexdigest() != config.selection_manifest_sha256:
        raise ValueError("OOLONG selection manifest file digest drifted")
    value = json.loads(payload)
    expected = {
        "protocol": "agencity.oolong-selection",
        "version": 1,
        "dataset": DATASET_ID,
        "revision": config.dataset_revision,
        "split": config.split,
        "datasetName": config.dataset_name,
        "contextLength": config.context_len,
        "withLabels": config.with_labels,
        "filterNumerical": config.filter_numerical,
        "taskCount": config.expected_tasks,
    }
    if not isinstance(value, dict) or any(
        value.get(name) != expected_value
        for name, expected_value in expected.items()
    ):
        raise ValueError("OOLONG selection manifest metadata does not match config")
    return value


def _validate_manifest_tasks(
    tasks: list[OolongSynthTask], config: OolongSynthConfig
) -> str | None:
    if config.selection_manifest == "none":
        return None
    value = _load_selection_manifest(config)
    entries = [
        {
            "rowId": task.data.row_id,
            "contextWindowId": task.data.context_window_id,
            "contextSha256": task.data.context_sha256,
            "contextBytes": task.data.context_bytes,
            "answerType": task.data.answer_type,
        }
        for task in tasks
    ]
    if value.get("tasks") != entries:
        raise ValueError(
            "OOLONG loaded task IDs/order/content do not match selection manifest"
        )
    contexts: dict[int, dict[str, object]] = {}
    for task in tasks:
        contexts.setdefault(
            task.data.context_window_id,
            {
                "contextWindowId": task.data.context_window_id,
                "sha256": task.data.context_sha256,
                "bytes": task.data.context_bytes,
            },
        )
    expected_contexts = sorted(
        contexts.values(), key=lambda item: int(item["contextWindowId"])
    )
    if value.get("contexts") != expected_contexts:
        raise ValueError("OOLONG loaded contexts do not match selection manifest")
    return config.selection_manifest_sha256


def _text_digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()

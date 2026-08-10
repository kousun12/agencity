from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


RESULT_PROTOCOL = "agencity.run-result"
RESULT_VERSION = 1
MAX_RESULT_BYTES = 64 * 1024
STATUS_EXIT_CODES = {
    "succeeded": 0,
    "failed": 1,
    "blocked": 4,
    "budget_exceeded": 5,
    "unknown": 7,
    "cancelled": 130,
}


@dataclass(frozen=True)
class RunResult:
    value: dict[str, Any]

    @property
    def status(self) -> str:
        return str(self.value["status"])

    @property
    def final(self) -> str | None:
        value = self.value.get("final")
        return value if isinstance(value, str) else None


def parse_run_result(stdout: str, process_exit_code: int) -> RunResult:
    if len(stdout.encode("utf-8")) > MAX_RESULT_BYTES:
        raise ValueError("Agencity result exceeds the 64 KiB adapter limit")

    lines = [line for line in stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise ValueError("Agencity must emit exactly one non-empty stdout line")

    try:
        value = json.loads(lines[0])
    except json.JSONDecodeError as error:
        raise ValueError("Agencity stdout is not valid JSON") from error
    if not isinstance(value, dict):
        raise ValueError("Agencity result must be a JSON object")
    if value.get("protocol") != RESULT_PROTOCOL or value.get("version") != RESULT_VERSION:
        raise ValueError("Agencity result protocol or version is unsupported")

    status = value.get("status")
    if status not in STATUS_EXIT_CODES:
        raise ValueError(f"Agencity result has unsupported status {status!r}")
    expected_exit = STATUS_EXIT_CODES[status]
    if value.get("exitCode") != expected_exit:
        raise ValueError("Agencity result status and embedded exit code disagree")
    if process_exit_code != expected_exit:
        raise ValueError("Agencity process and result exit codes disagree")
    if not isinstance(value.get("steps"), int) or value["steps"] < 0:
        raise ValueError("Agencity result steps must be a non-negative integer")
    if status == "succeeded" and not isinstance(value.get("final"), str):
        raise ValueError("A successful Agencity result requires a final string")

    return RunResult(value=value)

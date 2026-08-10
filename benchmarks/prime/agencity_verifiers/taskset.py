from __future__ import annotations

import json

import verifiers.v1 as vf

from agencity_verifiers.harness import RESULT_PATH
from agencity_verifiers.result import parse_run_result


SMOKE_ANSWER = "AGENCITY_VERIFIERS_SMOKE_OK"


class AgencitySmokeData(vf.TaskData):
    answer: str


class AgencitySmokeTask(vf.Task[AgencitySmokeData]):
    @vf.reward(weight=1.0)
    async def exact_result(self, trace: vf.Trace, runtime: vf.Runtime) -> float:
        raw = (await runtime.read(RESULT_PATH)).decode("utf-8")
        value = json.loads(raw)
        if not isinstance(value, dict) or not isinstance(value.get("exitCode"), int):
            raise ValueError("Agencity result artifact is malformed")
        result = parse_run_result(raw, value["exitCode"])
        trace.info["agencity"] = {
            "status": result.status,
            "steps": result.value["steps"],
            "final": result.final,
        }
        return float(
            result.status == "succeeded"
            and result.final is not None
            and result.final.strip() == self.data.answer
        )


class AgencitySmokeTaskset(vf.Taskset[AgencitySmokeTask, vf.TasksetConfig]):
    def load(self) -> list[AgencitySmokeTask]:
        return [
            AgencitySmokeTask(
                AgencitySmokeData(
                    idx=0,
                    name="typed-finish-contract",
                    prompt=(
                        f"Return exactly {SMOKE_ANSWER} as your final answer. "
                        "Do not inspect files, run commands, or delegate. Finish immediately."
                    ),
                    answer=SMOKE_ANSWER,
                ),
                self.config.task,
            )
        ]

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.run_runebench_canary import (
    DEFAULT_CONFIG,
    run_canary,
    scoring_completeness_error,
)


SELECTION = {
    "benchmark": "runebench",
    "mode": "exact",
    "selected_count": 1,
    "selected_ids": ["attack-xp-30m"],
}


class RuneBenchCanaryRunnerTests(unittest.TestCase):
    def test_runs_pin_check_preflight_dry_run_eval_report_in_order(self) -> None:
        commands: list[list[str]] = []
        with TemporaryDirectory() as directory:
            output = Path(directory) / "canary"

            def runner(
                command: list[str],
                _cwd: Path,
            ) -> subprocess.CompletedProcess[object]:
                commands.append(command)
                if "preflight_suite.py" in " ".join(command):
                    path = Path(command[command.index("--output") + 1])
                    path.write_text(json.dumps(SELECTION), encoding="utf-8")
                elif command[:2] == ["eval", "@"] and "--dry-run" not in command:
                    run = Path(command[command.index("--output-dir") + 1])
                    run.mkdir(parents=True)
                    (run / "traces.jsonl").write_text("{}\n", encoding="utf-8")
                elif "agencity_verifiers.reporting" in command:
                    path = Path(command[command.index("--output") + 1])
                    path.write_text(
                        json.dumps(
                            _summary(
                                outcome="passed",
                                reward=100.0,
                            )
                        ),
                        encoding="utf-8",
                    )
                return subprocess.CompletedProcess(command, 0)

            self.assertEqual(
                run_canary(
                    DEFAULT_CONFIG,
                    output,
                    refresh_pins=False,
                    command_runner=runner,
                ),
                0,
            )

        self.assertEqual(len(commands), 5)
        self.assertEqual(commands[0][-1], "--check")
        self.assertIn("preflight_suite.py", commands[1][1])
        self.assertIn("--dry-run", commands[2])
        self.assertNotIn("--dry-run", commands[3])
        self.assertEqual(
            commands[4][1:3],
            ["-m", "agencity_verifiers.reporting"],
        )

    def test_refresh_is_opt_in_and_followed_by_a_pin_check(self) -> None:
        commands: list[list[str]] = []
        with TemporaryDirectory() as directory:

            def runner(
                command: list[str],
                _cwd: Path,
            ) -> subprocess.CompletedProcess[object]:
                commands.append(command)
                return subprocess.CompletedProcess(
                    command,
                    0 if len(commands) == 1 else 7,
                )

            result = run_canary(
                DEFAULT_CONFIG,
                Path(directory) / "canary",
                refresh_pins=True,
                command_runner=runner,
            )

        self.assertEqual(result, 7)
        self.assertEqual(len(commands), 2)
        self.assertNotIn("--check", commands[0])
        self.assertEqual(commands[1][-1], "--check")

    def test_stale_pin_check_fails_before_preflight(self) -> None:
        commands: list[list[str]] = []
        with TemporaryDirectory() as directory:

            def runner(
                command: list[str],
                _cwd: Path,
            ) -> subprocess.CompletedProcess[object]:
                commands.append(command)
                return subprocess.CompletedProcess(command, 3)

            result = run_canary(
                DEFAULT_CONFIG,
                Path(directory) / "canary",
                refresh_pins=False,
                command_runner=runner,
            )

        self.assertEqual(result, 3)
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0][-1], "--check")

    def test_refuses_a_nonempty_output_directory(self) -> None:
        with TemporaryDirectory() as directory:
            output = Path(directory)
            (output / "retained.txt").write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "new empty directory"):
                run_canary(
                    DEFAULT_CONFIG,
                    output,
                    refresh_pins=False,
                    command_runner=lambda command, cwd: subprocess.CompletedProcess(
                        command, 0
                    ),
                )

    def test_scoring_gate_preserves_official_zero_and_scored_agent_failure(
        self,
    ) -> None:
        for outcome, reward in (
            ("valid_zero", 0.0),
            ("agent_terminal_failure", 48.0),
        ):
            with self.subTest(outcome=outcome):
                self.assertIsNone(
                    scoring_completeness_error(
                        SELECTION,
                        _summary(outcome=outcome, reward=reward),
                    )
                )

    def test_scoring_gate_rejects_unscored_and_mismatched_results(self) -> None:
        cases = {
            "task error": _summary(
                outcome="scorer_or_infrastructure_error",
                reward=None,
                officially_scored=0,
            ),
            "missing": {
                **_summary(outcome="passed", reward=1.0),
                "tasks": [],
            },
            "duplicate": {
                **_summary(outcome="passed", reward=1.0),
                "tasks": [
                    {
                        "task_id": "attack-xp-30m",
                        "outcome": "passed",
                        "reward": 1.0,
                    },
                    {
                        "task_id": "attack-xp-30m",
                        "outcome": "passed",
                        "reward": 1.0,
                    },
                ],
            },
            "unexpected": {
                **_summary(outcome="passed", reward=1.0),
                "tasks": [
                    {
                        "task_id": "other",
                        "outcome": "passed",
                        "reward": 1.0,
                    }
                ],
            },
            "nonfinite": _summary(
                outcome="valid_zero",
                reward=float("nan"),
            ),
        }
        for name, summary in cases.items():
            with self.subTest(name=name):
                self.assertIsNotNone(
                    scoring_completeness_error(SELECTION, summary)
                )

    def test_task_error_and_missing_trace_make_the_canary_fail(self) -> None:
        task_error = _summary(
            outcome="scorer_or_infrastructure_error",
            reward=None,
            officially_scored=0,
        )
        with self.subTest(case="captured task error"):
            result, commands = _exercise_run(
                evaluation_code=0,
                create_trace=True,
                summary=task_error,
            )
            self.assertEqual(result, 1)
            self.assertTrue(
                any("agencity_verifiers.reporting" in command for command in commands)
            )
        with self.subTest(case="missing trace"):
            result, commands = _exercise_run(
                evaluation_code=0,
                create_trace=False,
                summary=task_error,
            )
            self.assertEqual(result, 1)
            self.assertFalse(
                any("agencity_verifiers.reporting" in command for command in commands)
            )

    def test_eval_failure_is_nonzero_but_still_writes_the_report(self) -> None:
        result, commands = _exercise_run(
            evaluation_code=9,
            create_trace=True,
            summary=_summary(outcome="passed", reward=1.0),
        )
        self.assertEqual(result, 9)
        self.assertTrue(
            any("agencity_verifiers.reporting" in command for command in commands)
        )


def _summary(
    *,
    outcome: str,
    reward: float | None,
    officially_scored: int = 1,
) -> dict[str, object]:
    return {
        "counts": {"officially_scored": officially_scored},
        "tasks": [
            {
                "task_id": "attack-xp-30m",
                "outcome": outcome,
                "reward": reward,
            }
        ],
    }


def _exercise_run(
    *,
    evaluation_code: int,
    create_trace: bool,
    summary: dict[str, object],
) -> tuple[int, list[list[str]]]:
    commands: list[list[str]] = []
    with TemporaryDirectory() as directory:
        output = Path(directory) / "canary"

        def runner(
            command: list[str],
            _cwd: Path,
        ) -> subprocess.CompletedProcess[object]:
            commands.append(command)
            if "preflight_suite.py" in " ".join(command):
                Path(command[command.index("--output") + 1]).write_text(
                    json.dumps(SELECTION),
                    encoding="utf-8",
                )
            elif command[:2] == ["eval", "@"] and "--dry-run" not in command:
                run = Path(command[command.index("--output-dir") + 1])
                run.mkdir(parents=True)
                if create_trace:
                    (run / "traces.jsonl").write_text("{}\n", encoding="utf-8")
                return subprocess.CompletedProcess(command, evaluation_code)
            elif "agencity_verifiers.reporting" in command:
                Path(command[command.index("--output") + 1]).write_text(
                    json.dumps(summary),
                    encoding="utf-8",
                )
            return subprocess.CompletedProcess(command, 0)

        result = run_canary(
            DEFAULT_CONFIG,
            output,
            refresh_pins=False,
            command_runner=runner,
        )
    return result, commands


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from agencity_runebench.harness import (
    AgencityRuneBenchHarness,
    RUNEBENCH_CONSOLE_RSS_RECYCLE_BYTES,
    _set_automatic_learning,
    _start_game,
)
from agencity_runebench.taskset import (
    BENCHMARK,
    CATALOG_PATH,
    CONTROLLER_PATH,
    CONTROLLER_SOURCE,
    DATASET,
    RATE_COMMAND_TEMPLATE,
    REPL_CONNECTION_SOURCE,
    REPL_GUIDANCE,
    TRACKING_FILE,
    WITHIN_RUN_GUIDANCE,
    RuneBenchConfig,
    RuneBenchTask,
    RuneBenchTaskset,
)
from agencity_verifiers.harbor_suite import HarborSuiteTask
from agencity_verifiers.selection import SelectionSpec, load_catalog
from verifiers.v1.tasksets.harbor import HarborTask


class RuneBenchCatalogTests(unittest.TestCase):
    def test_catalog_pins_all_published_skill_tasks_and_shared_image(self) -> None:
        catalog = load_catalog(CATALOG_PATH, BENCHMARK)
        self.assertEqual(catalog["dataset"]["package"], DATASET)
        self.assertEqual(len(catalog["tasks"]), 32)
        self.assertEqual(sum(task["compatible"] for task in catalog["tasks"]), 32)
        self.assertEqual(
            {task["duration_seconds"] for task in catalog["tasks"]},
            {900, 1800},
        )
        self.assertEqual(
            {task["sample_interval_ms"] for task in catalog["tasks"]},
            {15000},
        )
        self.assertEqual(
            len({task["image_manifest_digest"] for task in catalog["tasks"]}),
            1,
        )
        treatment = catalog["treatments"]["agencity-runebench-repl-v1"]
        self.assertEqual(treatment["source_memory_gb"], 4)
        self.assertEqual(treatment["treatment_memory_gb"], 8)
        for task in catalog["tasks"]:
            self.assertTrue(task["image"].endswith(task["image_manifest_digest"]))
            self.assertEqual(task["workdir"], "/app")
            self.assertEqual(len(task["save_sha256"]), 64)
            self.assertEqual(len(task["source_dockerfile_sha256"]), 64)

    def test_selection_modes_use_one_task_implementation(self) -> None:
        selections = {
            "smoke": SelectionSpec(mode="smoke", subset="woodcutting"),
            "sample": SelectionSpec(mode="sample", count=3, seed=20260819),
            "all": SelectionSpec(mode="all"),
        }
        expected = {"smoke": 1, "sample": 3, "all": 32}
        for name, selection in selections.items():
            with self.subTest(name=name):
                tasks = list(
                    RuneBenchTaskset(
                        RuneBenchConfig(
                            id="agencity-runebench",
                            selection=selection,
                        )
                    ).load()
                )
                self.assertEqual(len(tasks), expected[name])
                self.assertTrue(all(isinstance(task, RuneBenchTask) for task in tasks))
                self.assertTrue(all(task.data.resources.memory == 8 for task in tasks))
                self.assertTrue(
                    all(
                        task.data.console_rss_recycle_bytes
                        == RUNEBENCH_CONSOLE_RSS_RECYCLE_BYTES
                        for task in tasks
                    )
                )

    def test_fresh_and_within_run_modes_are_explicit_and_isolated(self) -> None:
        selection = SelectionSpec(
            mode="exact",
            ids=["woodcutting-xp-15m"],
        )
        fresh = next(
            iter(
                RuneBenchTaskset(
                    RuneBenchConfig(
                        id="agencity-runebench",
                        selection=selection,
                        learning_mode="fresh",
                    )
                ).load()
            )
        )
        adaptive = next(
            iter(
                RuneBenchTaskset(
                    RuneBenchConfig(
                        id="agencity-runebench",
                        selection=selection,
                        learning_mode="within-run",
                    )
                ).load()
            )
        )
        self.assertNotIn(REPL_GUIDANCE, str(fresh.data.prompt))
        self.assertNotIn(REPL_CONNECTION_SOURCE, str(fresh.data.prompt))
        self.assertIn('password: "test"', CONTROLLER_SOURCE)
        self.assertNotIn(WITHIN_RUN_GUIDANCE, str(fresh.data.prompt))
        self.assertNotIn(WITHIN_RUN_GUIDANCE, str(adaptive.data.prompt))
        for unsupported in ("execute_code", "rs-agent", "MCP server", "bun /tmp/"):
            self.assertNotIn(unsupported, str(fresh.data.prompt))
            self.assertNotIn(unsupported, str(adaptive.data.prompt))
        self.assertIn(
            RATE_COMMAND_TEMPLATE.format(skill="Woodcutting"),
            str(fresh.data.prompt),
        )
        self.assertIn("Never construct `BotSDK` yourself", REPL_GUIDANCE)
        self.assertIn("`bot` is the high-level `BotActions` surface", REPL_GUIDANCE)
        self.assertIn('await bot.attackNpc("chicken")', REPL_GUIDANCE)
        self.assertIn("rs.getState()", REPL_GUIDANCE)
        self.assertIn('match.completeness === "inline"', REPL_GUIDANCE)
        self.assertIn("do not spend opening turns enumerating object surfaces", REPL_GUIDANCE)
        self.assertIn("minBackoffMs: 250", REPL_GUIDANCE)
        self.assertIn("return await (async () =>", REPL_GUIDANCE)
        self.assertIn("last: attempts.at(-1) ?? null", REPL_GUIDANCE)
        self.assertIn("Cell results must be JSON-safe", REPL_GUIDANCE)
        self.assertIn("Per-strategy attempt arrays", REPL_GUIDANCE)
        self.assertIn("fewer, longer bounded", REPL_GUIDANCE)
        self.assertIn("runActionLoop", REPL_GUIDANCE)
        self.assertIn("sdk.processes.start", REPL_GUIDANCE)
        self.assertIn("sdk.processes.readLogs", REPL_GUIDANCE)
        self.assertIn("managed process is optional", REPL_GUIDANCE)
        self.assertIn("release the REPL controller", REPL_GUIDANCE)
        self.assertIn("Never use `command &`", REPL_GUIDANCE)
        self.assertLess(
            REPL_GUIDANCE.index("release the REPL controller"),
            REPL_GUIDANCE.index("sdk.processes.start"),
        )
        self.assertEqual(fresh.data.adapted_prompt_sha256, adaptive.data.adapted_prompt_sha256)
        self.assertEqual(fresh.data.selected_ids, adaptive.data.selected_ids)

    def test_controller_protocol_is_single_owner_and_backs_off_false_results(
        self,
    ) -> None:
        self.assertIn('mkdir(LOCK_DIR)', CONTROLLER_SOURCE)
        self.assertIn("RUNEBENCH_CONTROLLER_BUSY", CONTROLLER_SOURCE)
        self.assertIn("processStartTime", CONTROLLER_SOURCE)
        self.assertIn("await this.rs.disconnect()", CONTROLLER_SOURCE)
        self.assertIn("RUNEBENCH_CONTROLLER_DISCONNECT_UNCONFIRMED", CONTROLLER_SOURCE)
        self.assertIn("result?.success === false", CONTROLLER_SOURCE)
        self.assertIn("Math.min(", CONTROLLER_SOURCE)
        self.assertIn("await Bun.sleep(delay)", CONTROLLER_SOURCE)

    def test_official_harbor_reward_remains_authoritative(self) -> None:
        self.assertIs(RuneBenchTask.solved, HarborTask.solved)
        self.assertIsNot(HarborSuiteTask._graded, HarborTask._graded)


class RuneBenchLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def task(self, learning_mode: str = "within-run") -> RuneBenchTask:
        return next(
            iter(
                RuneBenchTaskset(
                    RuneBenchConfig(
                        id="agencity-runebench",
                        learning_mode=learning_mode,
                        selection=SelectionSpec(
                            mode="exact",
                            ids=["woodcutting-xp-15m"],
                        ),
                    )
                ).load()
            )
        )

    async def test_task_setup_stages_save_and_repl_instructions(self) -> None:
        writes: dict[str, bytes] = {}

        class Runtime:
            async def run(self, command: list[str], environment: dict[str, str]):
                return SimpleNamespace(exit_code=0, stdout="", stderr="")

            async def read(self, path: str, max_bytes: int) -> bytes:
                self.read_call = (path, max_bytes)
                return b"# upstream instructions\n"

            async def write(self, path: str, data: bytes) -> None:
                writes[path] = data

        trace = SimpleNamespace(info={})
        task = self.task()
        await task.setup(trace, Runtime())
        self.assertIn(
            "/app/server/engine/data/players/main/agent.sav",
            writes,
        )
        self.assertIn(b"## Agencity RuneBench treatment", writes["/app/AGENTS.md"])
        self.assertIn(b'acquireController("repl")', writes["/app/AGENTS.md"])
        self.assertIn(b'await bot.attackNpc("chicken")', writes["/app/AGENTS.md"])
        self.assertIn(b"rs.getInventory()", writes["/app/AGENTS.md"])
        self.assertIn(b"within-run adaptive treatment", writes["/app/AGENTS.md"])
        self.assertEqual(writes[CONTROLLER_PATH], CONTROLLER_SOURCE.encode("utf-8"))
        self.assertIn(TRACKING_FILE.encode("utf-8"), writes["/app/AGENTS.md"])
        self.assertEqual(trace.info["runebench"]["services"], "staged")
        self.assertFalse(trace.info["runebench"]["cross_episode_learning"])

    async def test_task_setup_creates_missing_agents_instructions(self) -> None:
        writes: dict[str, bytes] = {}

        class Runtime:
            async def run(self, command: list[str], environment: dict[str, str]):
                if command[:2] == ["mkdir", "-p"]:
                    return SimpleNamespace(exit_code=0, stdout="", stderr="")
                return SimpleNamespace(exit_code=1, stdout="", stderr="")

            async def read(self, path: str, max_bytes: int) -> bytes:
                raise AssertionError("missing AGENTS.md must not be read")

            async def write(self, path: str, data: bytes) -> None:
                writes[path] = data

        await self.task().setup(SimpleNamespace(info={}), Runtime())
        self.assertTrue(
            writes["/app/AGENTS.md"].startswith(b"## Agencity RuneBench treatment")
        )

    async def test_game_starts_after_staging_and_waits_for_tracker_and_bot(self) -> None:
        calls: list[tuple[str, object]] = []

        class Runtime:
            async def run_background(
                self, command: list[str], environment: dict[str, str], log: str
            ) -> None:
                calls.append(("background", (command, environment, log)))

            async def run(self, command: list[str], environment: dict[str, str]):
                calls.append(("run", command))
                return SimpleNamespace(exit_code=0, stdout="", stderr="")

        trace = SimpleNamespace(
            info={"runebench": {"services": "staged"}},
        )
        task = self.task()
        await _start_game(Runtime(), trace, task.data)
        kind, background = calls[0]
        self.assertEqual(kind, "background")
        command, environment, log = background
        self.assertEqual(command, ["/entrypoint.sh"])
        self.assertEqual(environment["BENCHMARK_DURATION_SECS"], "900")
        self.assertEqual(environment["SAMPLE_INTERVAL_MS"], "15000")
        self.assertTrue(log.endswith("entrypoint.log"))
        self.assertEqual(trace.info["runebench"]["services"], "ready")

    async def test_learning_policy_is_explicit_before_launch(self) -> None:
        calls: list[list[str]] = []

        class Runtime:
            async def run(self, command: list[str], environment: dict[str, str]):
                calls.append(command)
                return SimpleNamespace(exit_code=0, stdout="", stderr="")

        runtime = Runtime()
        await _set_automatic_learning(
            runtime,
            installation="portable",
            enabled=False,
        )
        self.assertIn("refinement.trigger-policy.v1',false", calls[0][2])
        await _set_automatic_learning(
            runtime,
            installation="portable",
            enabled=True,
        )
        self.assertIn("refinement.trigger-policy.v1',true", calls[1][2])

    async def test_finalize_reuses_runebench_service_configuration(self) -> None:
        task = self.task()
        trace = SimpleNamespace(info={})
        runtime = SimpleNamespace()
        with (
            patch.object(HarborTask, "finalize", AsyncMock()),
            patch(
                "agencity_verifiers.harbor_suite._shutdown_portable",
                AsyncMock(return_value="stopped"),
            ) as shutdown,
            patch(
                "agencity_verifiers.harbor_suite._cleanup_portable",
                AsyncMock(return_value="workspace-metadata-and-state-removed"),
            ),
        ):
            await task.finalize(trace, runtime)
        shutdown.assert_awaited_once_with(
            runtime,
            "/app",
            console_rss_recycle_bytes=RUNEBENCH_CONSOLE_RSS_RECYCLE_BYTES,
        )

    async def test_startup_timeout_is_infrastructure_error_with_bounded_log(self) -> None:
        class Runtime:
            async def run_background(self, *args) -> None:
                return None

            async def run(self, command: list[str], environment: dict[str, str]):
                if command[1] == "-c" and command[2].startswith("tail"):
                    return SimpleNamespace(
                        exit_code=0,
                        stdout="startup failed",
                        stderr="",
                    )
                return SimpleNamespace(exit_code=1, stdout="", stderr="not ready")

        with (
            patch("agencity_runebench.harness.STARTUP_ATTEMPTS", 1),
            patch("agencity_runebench.harness.asyncio.sleep", AsyncMock()),
        ):
            with self.assertRaisesRegex(RuntimeError, "startup failed"):
                await _start_game(
                    Runtime(),
                    SimpleNamespace(info={"runebench": {}}),
                    self.task().data,
                )

    async def test_harness_starts_game_immediately_before_agencity_launch(self) -> None:
        harness = AgencityRuneBenchHarness(
            SimpleNamespace(installation="portable")
        )
        self.assertEqual(
            harness.CONSOLE_RSS_RECYCLE_BYTES,
            1536 * 1024 * 1024,
        )
        self.assertEqual(
            RUNEBENCH_CONSOLE_RSS_RECYCLE_BYTES,
            1536 * 1024 * 1024,
        )
        order: list[str] = []
        task = self.task()
        with (
            patch(
                "agencity_runebench.harness._set_automatic_learning",
                AsyncMock(side_effect=lambda *_args, **_kwargs: order.append("learning")),
            ) as learning,
            patch(
                "agencity_runebench.harness._start_game",
                AsyncMock(
                    side_effect=lambda *_: order.append("game")
                    or (
                        "2026-08-19T00:00:00.000Z",
                        "2026-08-19T00:30:00.000Z",
                    )
                ),
            ),
            patch(
                "agencity_verifiers.harness.AgencityHarness.launch",
                AsyncMock(
                    side_effect=lambda *_args, **_kwargs: order.append("agencity")
                    or SimpleNamespace()
                ),
            ) as base_launch,
        ):
            await harness.launch(
                SimpleNamespace(),
                SimpleNamespace(info={}),
                SimpleNamespace(),
                "http://localhost:1/v1",
                "secret",
                {},
                task.data,
            )
        learning.assert_awaited_once()
        self.assertFalse(learning.await_args.kwargs["enabled"])
        self.assertEqual(
            base_launch.await_args.kwargs["run_started_at"],
            "2026-08-19T00:00:00.000Z",
        )
        self.assertEqual(
            base_launch.await_args.kwargs["run_deadline_at"],
            "2026-08-19T00:30:00.000Z",
        )
        self.assertEqual(
            base_launch.await_args.kwargs["refinement_review_limit"],
            1,
        )
        self.assertEqual(
            base_launch.await_args.kwargs["refinement_evidence_required"],
            1,
        )
        self.assertEqual(order, ["learning", "game", "agencity"])


if __name__ == "__main__":
    unittest.main()

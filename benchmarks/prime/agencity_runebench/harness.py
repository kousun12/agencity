"""Agencity harness that starts RuneBench after Agencity provisioning."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import verifiers.v1 as vf

from agencity_verifiers.harness import (
    AGENCITY_DIR,
    PORTABLE_BUN_PATH,
    PORTABLE_PROFILE_PATH,
    PROFILE_PATH,
    AgencityHarness,
)
from agencity_runebench.taskset import BENCHMARK, RuneBenchData


STARTUP_LOG = "/tmp/agencity-runebench-entrypoint.log"
STARTUP_ATTEMPTS = 240
RUNEBENCH_CONSOLE_RSS_RECYCLE_BYTES = 1536 * 1024 * 1024


class AgencityRuneBenchHarness(AgencityHarness):
    """Start the staged game immediately before the autonomous model run."""

    CONSOLE_RSS_RECYCLE_BYTES = RUNEBENCH_CONSOLE_RSS_RECYCLE_BYTES

    async def launch(
        self,
        ctx: vf.ModelContext,
        trace: vf.Trace,
        runtime: vf.Runtime,
        endpoint: str,
        secret: str,
        mcp_urls: dict[str, str],
        data: vf.TaskData,
    ) -> vf.ProgramResult:
        if not isinstance(data, RuneBenchData) or data.benchmark != BENCHMARK:
            raise ValueError("The RuneBench harness requires RuneBench task data")
        await _set_automatic_learning(
            runtime,
            installation=self.config.installation,
            enabled=data.learning_mode == "within-run",
        )
        metadata = trace.info.get("runebench")
        if isinstance(metadata, dict):
            metadata["automatic_learning"] = (
                "enabled" if data.learning_mode == "within-run" else "paused"
            )
            metadata["console_rss_recycle_bytes"] = (
                RUNEBENCH_CONSOLE_RSS_RECYCLE_BYTES
            )
        await _start_game(runtime, trace, data)
        return await super().launch(
            ctx,
            trace,
            runtime,
            endpoint,
            secret,
            mcp_urls,
            data,
        )


async def _set_automatic_learning(
    runtime: vf.Runtime,
    *,
    installation: str,
    enabled: bool,
) -> None:
    bun = PORTABLE_BUN_PATH if installation == "portable" else "bun"
    profile_path = PORTABLE_PROFILE_PATH if installation == "portable" else PROFILE_PATH
    source = (
        f'import {{ ProfileStore }} from "{AGENCITY_DIR}/src/storage/turso.ts";'
        f"const profile=await ProfileStore.open({json.dumps(f'file:{profile_path}')});"
        f"try{{await profile.setPreference('refinement.trigger-policy.v1',{str(enabled).lower()});}}"
        "finally{profile.close();}"
    )
    result = await runtime.run([bun, "-e", source], {})
    if result.exit_code != 0:
        detail = (result.stderr or result.stdout).strip()[-2000:]
        raise RuntimeError(f"could not configure RuneBench automatic learning: {detail}")


async def _start_game(
    runtime: vf.Runtime,
    trace: vf.Trace,
    data: RuneBenchData,
) -> None:
    environment = {
        "SAMPLE_INTERVAL_MS": str(data.sample_interval_ms),
        "GATEWAY_URL": "ws://localhost:7780",
        "BENCHMARK_DURATION_SECS": str(data.duration_seconds),
    }
    await runtime.run_background(["/entrypoint.sh"], environment, STARTUP_LOG)
    last = SimpleNamespace(exit_code=1, stdout="", stderr="")
    for _ in range(STARTUP_ATTEMPTS):
        last = await runtime.run(
            [
                "sh",
                "-c",
                (
                    "test -s /logs/tracking/skill_tracker.log && "
                    "curl -fsS http://localhost:7780/status/agent "
                    "| tr -d '[:space:]' | grep -q '\"status\":\"active\"'"
                ),
            ],
            {},
        )
        if last.exit_code == 0:
            metadata = trace.info.get("runebench")
            if isinstance(metadata, dict):
                metadata["services"] = "ready"
                metadata["startup_log"] = STARTUP_LOG
            return
        await asyncio.sleep(1)

    diagnostics = await runtime.run(
        ["sh", "-c", f"tail -c 4096 {STARTUP_LOG} 2>/dev/null || true"],
        {},
    )
    detail = (diagnostics.stdout or last.stderr or last.stdout).strip()
    raise RuntimeError(
        "RuneBench game services did not become ready within "
        f"{STARTUP_ATTEMPTS} seconds: {detail[-4096:]}"
    )


__all__ = [
    "AgencityRuneBenchHarness",
]

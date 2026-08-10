from __future__ import annotations

import json
import shlex
from urllib.parse import urlsplit

import verifiers.v1 as vf

from agencity_verifiers.result import parse_run_result


RESULT_PATH = ".agencity-eval/agencity-result.json"
AGENCITY_DIR = "/opt/agencity"
WORKSPACE_DIR = "/app/workspace"
PROFILE_PATH = "/app/.agencity-eval/profile.db"


class AgencityHarnessConfig(vf.HarnessConfig):
    source_repo: str = "https://github.com/kousun12/agencity.git"
    source_ref: str = "dbe1606fdf2ed390fa0815098c1014438fc740bf"


class AgencityHarness(vf.Harness[AgencityHarnessConfig]):
    APPENDS_SYSTEM_PROMPT = True
    SUPPORTS_MCP = False
    SUPPORTS_RESUME = False
    EXECUTES_CODE = True
    NEEDS_CONTAINER = True

    async def setup(self, runtime: vf.Runtime) -> None:
        await _checked(runtime, ["apt-get", "update"])
        await _checked(
            runtime,
            [
                "apt-get",
                "install",
                "-y",
                "--no-install-recommends",
                "ca-certificates",
                "git",
            ],
        )
        await _checked(runtime, ["git", "init", AGENCITY_DIR])
        await _checked(
            runtime,
            [
                "git",
                "-C",
                AGENCITY_DIR,
                "remote",
                "add",
                "origin",
                self.config.source_repo,
            ],
        )
        await _checked(
            runtime,
            [
                "git",
                "-C",
                AGENCITY_DIR,
                "fetch",
                "--depth",
                "1",
                "origin",
                self.config.source_ref,
            ],
        )
        await _checked(
            runtime,
            ["git", "-C", AGENCITY_DIR, "checkout", "--detach", "FETCH_HEAD"],
        )
        await _checked(
            runtime,
            [
                "sh",
                "-lc",
                f"cd {shlex.quote(AGENCITY_DIR)} && bun install --frozen-lockfile",
            ],
        )

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
        del trace
        if mcp_urls:
            raise ValueError("The initial Agencity harness does not support MCP tools")

        system_prompt, prompt = self.resolve_text_prompt(data)
        if prompt is None:
            raise ValueError("The initial Agencity harness requires a text task prompt")
        task = (
            f"Benchmark system instructions:\n{system_prompt}\n\nBenchmark task:\n{prompt}"
            if system_prompt
            else prompt
        )
        if len(task.encode("utf-8")) > 64 * 1024:
            raise ValueError("The initial Agencity harness limits task prompts to 64 KiB")

        provider, provider_env = _provider_environment(
            ctx.model,
            _endpoint_origin(endpoint),
            secret,
        )
        await _checked(runtime, ["mkdir", "-p", WORKSPACE_DIR, "/app/.agencity-eval"])

        effort = ctx.sampling.reasoning_effort
        if effort not in {
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
        }:
            effort = "provider-default"

        environment = {
            **self.config.resolved_env,
            **provider_env,
            "AGENCITY_PROFILE": PROFILE_PATH,
            "HOME": "/app/.agencity-eval/home",
            "NO_COLOR": "1",
        }
        process = await runtime.run_program(
            _agencity_command(provider, ctx.model, effort, task),
            environment,
        )
        result = parse_run_result(process.stdout, process.exit_code)
        await runtime.write(
            RESULT_PATH,
            (
                json.dumps(result.value, sort_keys=True, separators=(",", ":")) + "\n"
            ).encode("utf-8"),
        )

        # Recognized Agencity terminal states are semantic rollout outcomes. The
        # taskset scores them from RESULT_PATH; malformed or missing output raises
        # above as a harness infrastructure error.
        return vf.ProgramResult(
            exit_code=0,
            stdout=process.stdout,
            stderr=process.stderr,
        )


def _agencity_command(
    provider: str,
    model: str,
    effort: str,
    task: str,
) -> list[str]:
    return [
        "bun",
        "run",
        f"{AGENCITY_DIR}/src/cli.ts",
        "run",
        "--new",
        "--json",
        "--workspace",
        WORKSPACE_DIR,
        "--profile",
        PROFILE_PATH,
        "--model",
        f"{provider}:{model}",
        "--effort",
        effort,
        "--",
        task,
    ]


async def _checked(runtime: vf.Runtime, command: list[str]) -> None:
    result = await runtime.run(command, {"GIT_TERMINAL_PROMPT": "0"})
    if result.exit_code != 0:
        detail = (result.stderr or result.stdout).strip()[-2000:]
        raise RuntimeError(f"setup command failed ({command[0]}): {detail}")


def _endpoint_origin(endpoint: str) -> str:
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.path.rstrip("/") != "/v1"
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Agencity requires a Verifiers endpoint ending at the root /v1")
    return f"{parsed.scheme}://{parsed.netloc}"


def _provider_environment(
    model: str,
    origin: str,
    secret: str,
) -> tuple[str, dict[str, str]]:
    if model.startswith("openai/"):
        return "openai", {
            "OPENAI_BASE_URL": origin,
            "OPENAI_API_KEY": secret,
        }
    if model.startswith("anthropic/"):
        return "anthropic", {
            "ANTHROPIC_BASE_URL": origin,
            "ANTHROPIC_API_KEY": secret,
        }
    raise ValueError(
        "The initial Agencity harness supports only openai/... and anthropic/... models"
    )

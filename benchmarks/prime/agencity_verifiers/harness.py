from __future__ import annotations

import asyncio
import json
import shlex
from typing import Literal
from urllib.parse import urlsplit

import verifiers.v1 as vf

from agencity_verifiers.bootstrap import PortableBootstrap, build_portable_bootstrap
from agencity_verifiers.result import parse_run_result
from agencity_verifiers.source import AGENCITY_SOURCE_REF, AGENCITY_SOURCE_REPO


RESULT_PATH = ".agencity-eval/agencity-result.json"
AGENCITY_DIR = "/opt/agencity"
WORKSPACE_DIR = "/app/workspace"
PROFILE_PATH = "/app/.agencity-eval/profile.db"
STATE_DIR = "/app/.agencity-eval/state"
ARTIFACTS_DIR = "/app/.agencity-eval/artifacts"
HOME_DIR = "/app/.agencity-eval/home"
PORTABLE_ROOT = "/tmp/agencity-eval"
PORTABLE_PROFILE_PATH = f"{PORTABLE_ROOT}/profile.db"
PORTABLE_STATE_DIR = f"{PORTABLE_ROOT}/state"
PORTABLE_ARTIFACTS_DIR = f"{PORTABLE_ROOT}/artifacts"
PORTABLE_BUNDLE_PATH = "/tmp/agencity-bootstrap.tgz"
PORTABLE_BUN_PATH = f"{AGENCITY_DIR}/bin/bun"
PORTABLE_GIT_EXCLUDES_PATH = f"{PORTABLE_ROOT}/git-excludes"
ADAPTER_DIAGNOSTIC_STREAM_BYTES = 4 * 1024
BUN_LINUX_X64_URL = (
    "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip"
)
BUN_LINUX_X64_SHA256 = "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f"


class AgencityHarnessConfig(vf.HarnessConfig):
    source_repo: str = AGENCITY_SOURCE_REPO
    source_ref: str = AGENCITY_SOURCE_REF
    installation: Literal["apt-git", "portable"] = "apt-git"
    bun_url: str = BUN_LINUX_X64_URL
    bun_sha256: str = BUN_LINUX_X64_SHA256


class AgencityHarness(vf.Harness[AgencityHarnessConfig]):
    APPENDS_SYSTEM_PROMPT = True
    SUPPORTS_MCP = False
    SUPPORTS_RESUME = False
    EXECUTES_CODE = True
    NEEDS_CONTAINER = True

    async def setup(self, runtime: vf.Runtime) -> None:
        if self.config.installation == "portable":
            await self._setup_portable(runtime)
            return
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
        await _checked(
            runtime,
            [
                "mkdir",
                "-p",
                WORKSPACE_DIR,
                STATE_DIR,
                ARTIFACTS_DIR,
                HOME_DIR,
            ],
        )

    async def _setup_portable(self, runtime: vf.Runtime) -> None:
        bootstrap = await asyncio.to_thread(
            build_portable_bootstrap,
            PortableBootstrap(
                source_repo=self.config.source_repo,
                source_ref=self.config.source_ref,
                bun_url=self.config.bun_url,
                bun_sha256=self.config.bun_sha256,
            ),
        )
        await runtime.write(PORTABLE_BUNDLE_PATH, bootstrap)
        await _checked(
            runtime,
            [
                "sh",
                "-c",
                (
                    f"rm -rf {shlex.quote(AGENCITY_DIR)} {shlex.quote(PORTABLE_ROOT)} && "
                    f"mkdir -p {shlex.quote(AGENCITY_DIR)} {shlex.quote(PORTABLE_ROOT)} "
                    f"{shlex.quote(PORTABLE_STATE_DIR)} {shlex.quote(PORTABLE_ARTIFACTS_DIR)} "
                    f"{shlex.quote(PORTABLE_ROOT + '/home')} && "
                    f"tar --no-same-owner -xzf {shlex.quote(PORTABLE_BUNDLE_PATH)} -C {shlex.quote(AGENCITY_DIR)} "
                    f"--strip-components=1 && "
                    f"rm -f {shlex.quote(PORTABLE_BUNDLE_PATH)} && "
                    f"chmod 0755 {shlex.quote(PORTABLE_BUN_PATH)} && "
                    f"cd {shlex.quote(AGENCITY_DIR)} && "
                    f"{shlex.quote(PORTABLE_BUN_PATH)} install --frozen-lockfile"
                ),
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
        workspace = _workspace(data, self.config.installation)
        if self.config.installation == "portable":
            await _prepare_portable_workspace(runtime, workspace)
        else:
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

        environment = _evaluation_environment(provider_env, self.config.installation)
        process = await runtime.run_program(
            _agencity_command(
                provider,
                _agencity_model(provider, ctx.model),
                effort,
                task,
                workspace=workspace,
                installation=self.config.installation,
            ),
            environment,
        )
        try:
            result = parse_run_result(process.stdout, process.exit_code)
        except Exception as error:
            diagnostics = _adapter_failure_diagnostics(
                process.stdout,
                process.stderr,
                process.exit_code,
                secrets=[secret],
                parse_error=error,
            )
            trace.info["agencity_adapter_failure"] = diagnostics
            stderr_preview = _diagnostic_summary(diagnostics["stderr"])
            raise ValueError(
                "Agencity result protocol failed "
                f"(exit={process.exit_code}, "
                f"stdout_lines={diagnostics['stdout']['line_count']}, "
                f"stderr={stderr_preview!r}): "
                f"{diagnostics['parse_error']['message']}"
            ) from error
        if self.config.installation == "portable":
            trace.info["agencity"] = _trace_result(result)
        else:
            await runtime.write(
                RESULT_PATH,
                (
                    json.dumps(result.value, sort_keys=True, separators=(",", ":")) + "\n"
                ).encode("utf-8"),
            )

        # Recognized terminal states are semantic rollout outcomes. Benchmark
        # tasksets either read RESULT_PATH or score the resulting workspace;
        # malformed or missing output raises as a harness infrastructure error.
        return vf.ProgramResult(
            exit_code=0,
            stdout=process.stdout,
            stderr=process.stderr,
        )

    async def cleanup(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        if self.config.installation != "portable":
            return
        metadata = trace.info.setdefault("agencity", {})
        if not isinstance(metadata, dict) or metadata.get("cleanup") is not None:
            return
        workspace = _workspace(trace.task.data, "portable")
        try:
            metadata["service_shutdown"] = await _shutdown_portable(runtime, workspace)
        finally:
            metadata["cleanup"] = await _cleanup_portable(runtime, workspace)


def _agencity_command(
    provider: str,
    model: str,
    effort: str,
    task: str,
    *,
    workspace: str = WORKSPACE_DIR,
    installation: Literal["apt-git", "portable"] = "apt-git",
) -> list[str]:
    command = [
        PORTABLE_BUN_PATH if installation == "portable" else "bun",
        "run",
        f"{AGENCITY_DIR}/src/cli.ts",
        "run",
        "--new",
        "--json",
        "--workspace",
        workspace,
        "--state-dir",
        PORTABLE_STATE_DIR if installation == "portable" else STATE_DIR,
        "--artifacts",
        PORTABLE_ARTIFACTS_DIR if installation == "portable" else ARTIFACTS_DIR,
        "--profile",
        PORTABLE_PROFILE_PATH if installation == "portable" else PROFILE_PATH,
        "--model",
        f"{provider}:{model}",
        "--effort",
        effort,
        "--",
        task,
    ]
    return command


def _agencity_service_command(action: Literal["status", "shutdown"], workspace: str) -> list[str]:
    return [
        PORTABLE_BUN_PATH,
        "run",
        f"{AGENCITY_DIR}/src/cli.ts",
        "service",
        action,
        "--json",
        "--workspace",
        workspace,
        "--state-dir",
        PORTABLE_STATE_DIR,
        "--artifacts",
        PORTABLE_ARTIFACTS_DIR,
        "--profile",
        PORTABLE_PROFILE_PATH,
    ]


def _workspace(data: vf.TaskData, installation: Literal["apt-git", "portable"]) -> str:
    if installation == "apt-git":
        return WORKSPACE_DIR
    workdir = data.workdir
    if not isinstance(workdir, str) or not workdir.startswith("/"):
        raise ValueError(
            "Portable Agencity installation requires an explicit absolute task work directory"
        )
    return workdir


def _evaluation_environment(
    provider_env: dict[str, str],
    installation: Literal["apt-git", "portable"],
) -> dict[str, str]:
    """Pass only the rollout interception credential into Agencity.

    `Runtime.run_program` receives image defaults plus this mapping. Host
    provider, Gateway, GitHub, and unrelated credentials are deliberately not
    inherited through the harness configuration.
    """
    root = PORTABLE_ROOT if installation == "portable" else "/app/.agencity-eval"
    profile = PORTABLE_PROFILE_PATH if installation == "portable" else PROFILE_PATH
    environment = {
        **provider_env,
        "AGENCITY_PROFILE": profile,
        "HOME": f"{root}/home" if installation == "portable" else HOME_DIR,
        "NO_COLOR": "1",
    }
    if installation == "portable":
        environment.update(
            {
                "GIT_CONFIG_COUNT": "1",
                "GIT_CONFIG_KEY_0": "core.excludesFile",
                "GIT_CONFIG_VALUE_0": PORTABLE_GIT_EXCLUDES_PATH,
            }
        )
    return environment


def _adapter_failure_diagnostics(
    stdout: str,
    stderr: str,
    exit_code: int,
    *,
    secrets: list[str],
    parse_error: Exception,
) -> dict[str, object]:
    return {
        "schema": "agencity.adapter-failure.v1",
        "process_exit_code": exit_code,
        "parse_error": {
            "type": type(parse_error).__name__,
            "message": _redact_known_secrets(str(parse_error), secrets),
        },
        "stdout": _bounded_diagnostic_stream(stdout, secrets),
        "stderr": _bounded_diagnostic_stream(stderr, secrets),
    }


def _bounded_diagnostic_stream(
    value: str,
    secrets: list[str],
) -> dict[str, object]:
    original_bytes = len(value.encode("utf-8"))
    redacted = _redact_known_secrets(value, secrets)
    encoded = redacted.encode("utf-8")
    common = {
        "byte_count": original_bytes,
        "redacted_byte_count": len(encoded),
        "line_count": len(redacted.splitlines()),
    }
    if len(encoded) <= ADAPTER_DIAGNOSTIC_STREAM_BYTES:
        return {
            **common,
            "completeness": "complete",
            "value": redacted,
        }
    side = ADAPTER_DIAGNOSTIC_STREAM_BYTES // 2
    return {
        **common,
        "completeness": "truncated",
        "head": encoded[:side].decode("utf-8", errors="replace"),
        "tail": encoded[-side:].decode("utf-8", errors="replace"),
    }


def _redact_known_secrets(value: str, secrets: list[str]) -> str:
    redacted = value
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    return redacted


def _diagnostic_summary(stream: object) -> str:
    if not isinstance(stream, dict):
        return ""
    if isinstance(stream.get("value"), str):
        return stream["value"]
    head = stream.get("head") if isinstance(stream.get("head"), str) else ""
    tail = stream.get("tail") if isinstance(stream.get("tail"), str) else ""
    return f"{head}\n[...diagnostic truncated...]\n{tail}"


def _trace_result(result) -> dict[str, object]:
    return {
        "protocol": result.value["protocol"],
        "version": result.value["version"],
        "status": result.status,
        "exit_code": result.value["exitCode"],
        "steps": result.value["steps"],
        "final": result.final,
    }


async def _prepare_portable_workspace(runtime: vf.Runtime, workspace: str) -> None:
    marker = f"{workspace}/.agencity"
    available = await runtime.run(["test", "!", "-e", marker], {})
    if available.exit_code != 0:
        raise RuntimeError(
            "Portable Agencity evaluation refuses a task workspace with "
            "pre-existing .agencity metadata"
        )
    await runtime.write(PORTABLE_GIT_EXCLUDES_PATH, b".agencity/\n")


async def _cleanup_portable(runtime: vf.Runtime, workspace: str) -> str:
    result = await runtime.run(
        ["rm", "-rf", "--", f"{workspace}/.agencity", PORTABLE_ROOT],
        {},
    )
    if result.exit_code != 0:
        detail = (result.stderr or result.stdout).strip()[-500:]
        raise RuntimeError(f"Agencity portable-state cleanup failed: {detail}")
    return "workspace-metadata-and-state-removed"


async def _shutdown_portable(runtime: vf.Runtime, workspace: str) -> str:
    environment = _evaluation_environment({}, "portable")
    requested = await runtime.run(
        _agencity_service_command("shutdown", workspace),
        environment,
    )
    if requested.exit_code != 0:
        detail = (requested.stderr or requested.stdout).strip()[-500:]
        raise RuntimeError(f"Agencity service shutdown request failed: {detail}")

    for _ in range(100):
        observed = await runtime.run(
            _agencity_service_command("status", workspace),
            environment,
        )
        if observed.exit_code == 0:
            try:
                value = json.loads(observed.stdout)
            except json.JSONDecodeError:
                value = None
            if isinstance(value, dict) and value.get("lifecycle") == "stopped":
                return "stopped"
        await asyncio.sleep(0.1)
    raise RuntimeError("Agencity service did not confirm shutdown within 10 seconds")


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
    if model.startswith("openai/") or "/" not in model:
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
        "The initial Agencity harness supports only native OpenAI, openai/..., "
        "and anthropic/... models"
    )


def _agencity_model(provider: str, model: str) -> str:
    if provider == "openai" and "/" not in model:
        return f"openai/{model}"
    return model

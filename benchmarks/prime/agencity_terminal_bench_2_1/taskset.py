"""A bounded Terminal-Bench 2.1 Harbor treatment for Agencity."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from importlib.metadata import version
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, model_validator
import verifiers.v1 as vf
from verifiers.v1.tasksets.harbor import HarborConfig, HarborTask, HarborTaskset

from agencity_terminal_bench_2.taskset import _is_sha256, _sha256_file, _sha256_tree
from agencity_verifiers.harness import _cleanup_portable, _shutdown_portable


SOURCE_MANIFEST_PATH = (
    Path(__file__).resolve().parent.parent / "manifests" / "terminal-bench-2-1-fix-git.json"
)
SOURCE_LOCK_PATH = Path(__file__).resolve().parent.parent / "uv.lock"
PACKAGED_DATA_PATH = Path(__file__).resolve().parent / "data"
PACKAGED_LOCK_PATH = (
    Path(__file__).resolve().parent.parent
    / "agencity_terminal_bench_2"
    / "data"
    / "uv.lock"
)
MANIFEST_PATH = (
    SOURCE_MANIFEST_PATH
    if SOURCE_MANIFEST_PATH.is_file()
    else PACKAGED_DATA_PATH / "manifest.json"
)
LOCK_PATH = SOURCE_LOCK_PATH if SOURCE_LOCK_PATH.is_file() else PACKAGED_LOCK_PATH
MANIFEST_SCHEMA = "agencity.terminal-bench-2-1-manifest.v1"
VERIFIERS_VERSION = "0.3.0"
HARBOR_VERSION = "0.20.0"
DATASET = (
    "terminal-bench/terminal-bench-2-1@"
    "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a"
)
TASK_ID = "fix-git"
TASK_NAME = "terminal-bench/fix-git"
TASK_REFERENCE = "sha256:16948b980df9d96de616a205f5acca1c5d395de83ff4f8ffabcafacb93226f2e"
TASK_TREE_SHA256 = "30aed800ba51d02a300800e34db211afa4a0ea9f4af098c628bdb8308facbfc8"
DECLARED_IMAGE = "alexgshaw/fix-git:20260403"
TASK_IMAGE = (
    "alexgshaw/fix-git@"
    "sha256:389b9c8247610c2c5be080b1ac00429007c2c69bf57f7f26c79f0f75ba2d5c74"
)
TASK_WORKSPACE = "/app/personal-site"
AGENCITY_SOURCE_REPO = "https://github.com/kousun12/agencity.git"
AGENCITY_SOURCE_REF = "eeceb6f02e2178e2e0d0e1a9b2f6e3f31a907a02"
BUN_VERSION = "1.3.14"
BUN_ARCHIVE = (
    "https://github.com/oven-sh/bun/releases/download/"
    "bun-v1.3.14/bun-linux-x64.zip"
)
BUN_ARCHIVE_SHA256 = "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f"


class TerminalBench21Config(HarborConfig):
    dataset: Literal[
        "terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a"
    ] = DATASET
    tasks: list[str] = Field(default_factory=lambda: [TASK_ID])
    ignore_timeouts: Literal[False] = False
    require_image: Literal[True] = True

    @model_validator(mode="after")
    def validates_bounded_selection(self) -> "TerminalBench21Config":
        if self.tasks != [TASK_ID]:
            raise ValueError(
                f"Terminal-Bench 2.1 integration permits exactly {TASK_ID!r}"
            )
        return self


class TerminalBench21Task(HarborTask):
    """Preserve the upstream Harbor verifier as the sole scorer."""

    async def finalize(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        metadata = trace.info.setdefault("agencity", {})
        if not isinstance(metadata, dict):
            raise ValueError("Agencity trace metadata is malformed")
        try:
            metadata["service_shutdown"] = await _shutdown_portable(
                runtime, TASK_WORKSPACE
            )
        finally:
            metadata["cleanup"] = await _cleanup_portable(runtime, TASK_WORKSPACE)
        await super().finalize(trace, runtime)


class TerminalBench21Taskset(
    HarborTaskset, vf.Taskset[TerminalBench21Task, TerminalBench21Config]
):
    def load(self) -> Iterator[TerminalBench21Task]:
        manifest = load_manifest()
        validate_runtime_versions()
        validate_lockfile(manifest)
        tasks = list(super().load())
        if len(tasks) != 1:
            raise ValueError(
                f"Terminal-Bench 2.1 manifest expected one task, Harbor loaded {len(tasks)}"
            )
        task = tasks[0]
        data = task.data
        if data.name != TASK_NAME:
            raise ValueError(
                f"Terminal-Bench 2.1 manifest selected {TASK_NAME!r}, Harbor loaded {data.name!r}"
            )
        if data.image != DECLARED_IMAGE:
            raise ValueError("Selected Terminal-Bench 2.1 image no longer matches manifest")
        if data.workdir is not None:
            raise ValueError(
                "Selected Terminal-Bench 2.1 task now declares a workdir; update manifest"
            )
        if manifest["selection"]["task_reference"] != TASK_REFERENCE:
            raise ValueError("Terminal-Bench 2.1 task reference does not match manifest")
        if _sha256_file(Path(data.task_dir) / "task.toml") != manifest["selection"][
            "task_toml_sha256"
        ]:
            raise ValueError("Terminal-Bench 2.1 task.toml does not match manifest")
        validate_task_tree(Path(data.task_dir), manifest["selection"]["task_tree_sha256"])
        yield TerminalBench21Task(
            data.model_copy(update={"image": TASK_IMAGE, "workdir": TASK_WORKSPACE}),
            task.config,
        )


def load_manifest(path: Path = MANIFEST_PATH) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schema") != MANIFEST_SCHEMA:
        raise ValueError("Terminal-Bench 2.1 manifest schema is unsupported")
    selection = value.get("selection")
    expected = {
        "dataset": DATASET,
        "task_id": TASK_ID,
        "task_reference": TASK_REFERENCE,
        "task_tree_sha256": TASK_TREE_SHA256,
        "declared_image": DECLARED_IMAGE,
        "image": TASK_IMAGE,
        "workspace": TASK_WORKSPACE,
    }
    if not isinstance(selection, dict) or {
        key: selection.get(key) for key in expected
    } != expected:
        raise ValueError("Terminal-Bench 2.1 manifest selection does not match taskset")
    upstream = value.get("upstream")
    expected_versions = {
        "verifiers_version": VERIFIERS_VERSION,
        "harbor_version": HARBOR_VERSION,
    }
    if not isinstance(upstream, dict) or {
        key: upstream.get(key) for key in expected_versions
    } != expected_versions:
        raise ValueError("Terminal-Bench 2.1 manifest runtime versions do not match")
    if not _is_sha256(selection.get("task_toml_sha256")):
        raise ValueError("Terminal-Bench 2.1 manifest task.toml digest is invalid")
    agencity = value.get("agencity")
    expected_agencity = {
        "source_repo": AGENCITY_SOURCE_REPO,
        "source_ref": AGENCITY_SOURCE_REF,
        "bun_version": BUN_VERSION,
        "bun_archive": BUN_ARCHIVE,
        "bun_archive_sha256": BUN_ARCHIVE_SHA256,
    }
    if not isinstance(agencity, dict) or {
        key: agencity.get(key) for key in expected_agencity
    } != expected_agencity:
        raise ValueError("Terminal-Bench 2.1 Agencity pins do not match")
    if not _is_sha256(value.get("python_lock_sha256")):
        raise ValueError("Terminal-Bench 2.1 Python lock digest is invalid")
    return value


def manifest_digest() -> str:
    return hashlib.sha256(MANIFEST_PATH.read_bytes()).hexdigest()


def validate_lockfile(manifest: dict[str, Any]) -> None:
    if _sha256_file(LOCK_PATH) != manifest["python_lock_sha256"]:
        raise ValueError("Terminal-Bench 2.1 Python lock digest does not match uv.lock")


def validate_runtime_versions() -> None:
    installed = {"verifiers": version("verifiers"), "harbor": version("harbor")}
    expected = {"verifiers": VERIFIERS_VERSION, "harbor": HARBOR_VERSION}
    if installed != expected:
        raise ValueError(
            f"Terminal-Bench 2.1 runtime version mismatch: expected {expected}, installed {installed}"
        )


def validate_task_tree(root: Path, expected_sha256: str) -> None:
    if _sha256_tree(root) != expected_sha256:
        raise ValueError("Selected Terminal-Bench 2.1 task tree no longer matches manifest")

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator, Mapping
from importlib.metadata import version
from pathlib import Path
from typing import Any, Literal

from pydantic import model_validator
import verifiers.v1 as vf
from verifiers.v1.tasksets.harbor import HarborConfig, HarborData, HarborTask, HarborTaskset
from verifiers.v1.tasksets.harbor.taskset import MAX_REWARD_BYTES, REWARD_JSON_ADAPTER

from agencity_verifiers.harness import (
    _cleanup_portable,
    _export_debug_inspection,
    _shutdown_portable,
)
from agencity_verifiers.selection import (
    SelectionSpec,
    catalog_digest,
    load_catalog,
    select_catalog_tasks,
)


VERIFIERS_VERSION = "0.3.0"
HARBOR_VERSION = "0.20.0"


class HarborSuiteConfig(HarborConfig):
    tasks: None = None
    selection: SelectionSpec = SelectionSpec()
    treatment: Literal["agencity-portable", "harness-native"] = "agencity-portable"
    ignore_timeouts: Literal[False] = False
    require_image: Literal[True] = True
    ignore_dockerfile: Literal[False] = False
    ignore_separate_verifier: Literal[False] = False

    @model_validator(mode="after")
    def validate_suite_policy(self) -> "HarborSuiteConfig":
        if self.tasks is not None:
            raise ValueError("use the deterministic selection block instead of Harbor tasks")
        return self


class HarborSuiteData(HarborData):
    selection_id: str
    benchmark: str
    catalog_sha256: str
    catalog_tasks_sha256: str
    selected_ids: list[str]
    selected_ids_sha256: str
    task_tree_sha256: str
    task_toml_sha256: str
    image_manifest_digest: str
    image_config_digest: str
    treatment: str
    console_rss_recycle_bytes: int | None = None


class HarborSuiteTask(HarborTask):
    data: HarborSuiteData

    async def finalize(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        trace.info["benchmark_provenance"] = {
            "schema": "agencity.benchmark-task-provenance.v1",
            "benchmark": self.data.benchmark,
            "selection_id": self.data.selection_id,
            "catalog_sha256": self.data.catalog_sha256,
            "catalog_tasks_sha256": self.data.catalog_tasks_sha256,
            "selected_ids": self.data.selected_ids,
            "selected_ids_sha256": self.data.selected_ids_sha256,
            "task_tree_sha256": self.data.task_tree_sha256,
            "task_toml_sha256": self.data.task_toml_sha256,
            "image": self.data.image,
            "image_manifest_digest": self.data.image_manifest_digest,
            "image_config_digest": self.data.image_config_digest,
            "workdir": self.data.workdir,
            "treatment": self.data.treatment,
        }
        try:
            # Harbor owns collection hooks. Keep the scored workspace intact
            # until they finish, then remove only Agencity's portable state.
            await super().finalize(trace, runtime)
        finally:
            if self.data.treatment.startswith("agencity-"):
                metadata = trace.info.setdefault("agencity", {})
                if not isinstance(metadata, dict):
                    raise ValueError("Agencity trace metadata is malformed")
                try:
                    metadata["service_shutdown"] = await _shutdown_portable(
                        runtime,
                        self.data.workdir,
                        console_rss_recycle_bytes=(
                            self.data.console_rss_recycle_bytes
                        ),
                    )
                except Exception:
                    metadata["service_shutdown"] = "unconfirmed"
                    metadata["cleanup"] = "retained-after-unconfirmed-shutdown"
                    if metadata.get("debug") is True:
                        metadata["debug_export"] = "skipped-unconfirmed-shutdown"
                    raise
                if metadata.get("debug") is True:
                    source_repo = metadata.get("debug_source_repo")
                    source_ref = metadata.get("debug_source_ref")
                    if not isinstance(source_repo, str) or not isinstance(
                        source_ref, str
                    ):
                        metadata["debug_export"] = "failed"
                        metadata["debug_export_error"] = (
                            "debug source provenance is missing"
                        )
                    else:
                        await _export_debug_inspection(
                            runtime,
                            self.data.workdir,
                            trace,
                            metadata,
                            source_repo=source_repo,
                            source_ref=source_ref,
                        )
                try:
                    metadata["cleanup"] = await _cleanup_portable(
                        runtime, self.data.workdir
                    )
                except Exception:
                    metadata["cleanup"] = "failed"
                    raise

    async def _graded(
        self, runtime: vf.Runtime, trace: vf.Trace
    ) -> float | dict[str, float]:
        score = await super()._graded(runtime, trace)
        await _require_harbor_reward_evidence(runtime)
        return score


def load_harbor_suite(
    config: HarborSuiteConfig,
    *,
    benchmark: str,
    catalog_path: Path,
    lock_path: Path,
    task_cls: type[HarborSuiteTask] = HarborSuiteTask,
) -> Iterator[HarborSuiteTask]:
    catalog = load_catalog(catalog_path, benchmark)
    _validate_catalog_runtime(catalog, config, lock_path)
    selected, selection = select_catalog_tasks(catalog, config.selection)
    selected_ids = [str(entry["id"]) for entry in selected]
    harbor_config = config.model_copy(update={"tasks": selected_ids})
    upstream = list(HarborTaskset(harbor_config).load())
    by_id = {task.data.task_dir.rstrip("/").split("/")[-1]: task for task in upstream}
    if set(by_id) != set(selected_ids):
        raise ValueError(
            f"{benchmark} Harbor selection drifted: expected {selected_ids}, "
            f"loaded {sorted(by_id)}"
        )

    digest = catalog_digest(catalog_path)
    for entry in selected:
        identifier = str(entry["id"])
        task = by_id[identifier]
        data = task.data
        task_root = Path(data.task_dir)
        if data.name != entry["upstream_name"]:
            raise ValueError(f"{benchmark} task {identifier} upstream name drifted")
        if data.image != entry["declared_image"]:
            raise ValueError(f"{benchmark} task {identifier} declared image drifted")
        if data.workdir != entry.get("declared_workdir"):
            raise ValueError(f"{benchmark} task {identifier} declared workdir drifted")
        if _sha256_file(task_root / "task.toml") != entry["task_toml_sha256"]:
            raise ValueError(f"{benchmark} task {identifier} task.toml drifted")
        if _sha256_tree(task_root) != entry["task_tree_sha256"]:
            raise ValueError(f"{benchmark} task {identifier} task tree drifted")
        image = str(entry["image"])
        manifest_digest = str(entry["image_manifest_digest"])
        if not image.endswith(f"@{manifest_digest}"):
            raise ValueError(f"{benchmark} task {identifier} immutable image is malformed")
        workdir = entry.get("workdir")
        if not isinstance(workdir, str) or not workdir.startswith("/"):
            raise ValueError(f"{benchmark} task {identifier} has no absolute workdir")
        suite_data = HarborSuiteData.model_validate(
            data.model_dump()
            | {
                "image": image,
                "workdir": workdir,
                "selection_id": identifier,
                "benchmark": benchmark,
                "catalog_sha256": digest,
                "catalog_tasks_sha256": catalog["tasks_sha256"],
                "selected_ids": selection["selected_ids"],
                "selected_ids_sha256": selection["selected_ids_sha256"],
                "task_tree_sha256": entry["task_tree_sha256"],
                "task_toml_sha256": entry["task_toml_sha256"],
                "image_manifest_digest": manifest_digest,
                "image_config_digest": entry["image_config_digest"],
                "treatment": config.treatment,
            }
        )
        yield task_cls(suite_data, task.config)


def _validate_catalog_runtime(
    catalog: Mapping[str, Any],
    config: HarborSuiteConfig,
    lock_path: Path,
) -> None:
    dataset = catalog.get("dataset")
    if not isinstance(dataset, dict) or dataset.get("package") != config.dataset:
        raise ValueError("Harbor suite catalog dataset does not match taskset config")
    runtime = catalog.get("runtime")
    expected = {
        "verifiers_version": VERIFIERS_VERSION,
        "harbor_version": HARBOR_VERSION,
    }
    if not isinstance(runtime, dict) or {
        key: runtime.get(key) for key in expected
    } != expected:
        raise ValueError("Harbor suite catalog runtime versions do not match")
    installed = {"verifiers_version": version("verifiers"), "harbor_version": version("harbor")}
    if installed != expected:
        raise ValueError(
            f"Harbor suite runtime mismatch: expected {expected}, installed {installed}"
        )
    if catalog.get("python_lock_sha256") != _sha256_file(lock_path):
        raise ValueError("Harbor suite catalog Python lock digest does not match uv.lock")


async def _require_harbor_reward_evidence(runtime: vf.Runtime) -> None:
    try:
        payload = await runtime.read(
            "/logs/verifier/reward.json", max_bytes=MAX_REWARD_BYTES
        )
        REWARD_JSON_ADAPTER.validate_json(payload)
        return
    except Exception:
        pass
    try:
        payload = await runtime.read(
            "/logs/verifier/reward.txt", max_bytes=MAX_REWARD_BYTES
        )
        value = payload.decode("utf-8").strip()
        if value:
            float(value)
            return
    except Exception:
        pass
    raise RuntimeError(
        "Harbor verifier produced no non-empty parseable official reward evidence"
    )


def _sha256_tree(root: Path) -> str:
    digest = hashlib.sha256()
    paths = sorted(
        path for path in root.rglob("*") if path.is_file() or path.is_symlink()
    )
    for path in paths:
        relative = path.relative_to(root).as_posix().encode("utf-8")
        if path.is_symlink():
            kind = b"L"
            content = path.readlink().as_posix().encode("utf-8")
        else:
            kind = b"F"
            content = path.read_bytes()
        digest.update(kind)
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


__all__ = [
    "HARBOR_VERSION",
    "VERIFIERS_VERSION",
    "HarborSuiteConfig",
    "HarborSuiteData",
    "HarborSuiteTask",
    "_sha256_file",
    "_sha256_tree",
    "load_harbor_suite",
]

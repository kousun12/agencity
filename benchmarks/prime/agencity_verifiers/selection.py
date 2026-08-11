from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


SelectionMode = Literal["exact", "smoke", "ids", "sample", "shard", "all"]


class SelectionSpec(BaseModel):
    """A deterministic task selection over one immutable compatibility catalog."""

    mode: SelectionMode = "smoke"
    ids: list[str] = Field(default_factory=list)
    subset: str = "default"
    count: int | None = Field(default=None, ge=1)
    seed: int = 0
    shard_index: int | None = Field(default=None, ge=0)
    shard_count: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def validate_shape(self) -> "SelectionSpec":
        if self.mode == "exact" and len(self.ids) != 1:
            raise ValueError("exact selection requires exactly one id")
        if self.mode == "ids" and not self.ids:
            raise ValueError("ids selection requires at least one id")
        if self.mode not in {"exact", "ids"} and self.ids:
            raise ValueError(f"{self.mode} selection does not accept ids")
        if self.mode == "sample" and self.count is None:
            raise ValueError("sample selection requires count")
        if self.mode != "sample" and self.count is not None:
            raise ValueError(f"{self.mode} selection does not accept count")
        if self.mode == "shard":
            if self.shard_index is None or self.shard_count is None:
                raise ValueError("shard selection requires shard_index and shard_count")
            if self.shard_index >= self.shard_count:
                raise ValueError("shard_index must be less than shard_count")
        elif self.shard_index is not None or self.shard_count is not None:
            raise ValueError(f"{self.mode} selection does not accept shard fields")
        return self


class CatalogError(ValueError):
    """An immutable benchmark catalog or requested selection is invalid."""


def load_catalog(path: Path, expected_benchmark: str) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(value, dict)
        or value.get("schema") != "agencity.benchmark-catalog.v1"
        or value.get("benchmark") != expected_benchmark
    ):
        raise CatalogError(f"{expected_benchmark} benchmark catalog is unsupported")
    tasks = value.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise CatalogError(f"{expected_benchmark} benchmark catalog has no tasks")
    identifiers = [task.get("id") for task in tasks if isinstance(task, dict)]
    if len(identifiers) != len(tasks) or any(
        not isinstance(identifier, str) or not identifier for identifier in identifiers
    ):
        raise CatalogError(f"{expected_benchmark} catalog contains an invalid task id")
    duplicates = sorted(
        identifier for identifier, count in Counter(identifiers).items() if count > 1
    )
    if duplicates:
        raise CatalogError(
            f"{expected_benchmark} catalog contains duplicate task ids: {duplicates}"
        )
    expected_digest = value.get("tasks_sha256")
    actual_digest = task_entries_digest(tasks)
    if expected_digest != actual_digest:
        raise CatalogError(
            f"{expected_benchmark} catalog task entries do not match tasks_sha256"
        )
    return value


def task_entries_digest(tasks: Sequence[Mapping[str, Any]]) -> str:
    return hashlib.sha256(
        json.dumps(
            list(tasks), sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
    ).hexdigest()


def catalog_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def select_catalog_tasks(
    catalog: Mapping[str, Any], spec: SelectionSpec
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    raw_tasks = catalog.get("tasks")
    if not isinstance(raw_tasks, list):
        raise CatalogError("benchmark catalog tasks are malformed")
    tasks = [dict(task) for task in raw_tasks if isinstance(task, dict)]
    by_id = {str(task["id"]): task for task in tasks}
    compatible = sorted(
        (task for task in tasks if task.get("compatible") is True),
        key=lambda task: str(task["id"]),
    )
    compatible_ids = [str(task["id"]) for task in compatible]

    requested_ids: list[str]
    if spec.mode in {"exact", "ids"}:
        requested_ids = list(spec.ids)
    elif spec.mode == "smoke":
        subsets = catalog.get("smoke_subsets")
        if not isinstance(subsets, dict) or not isinstance(subsets.get(spec.subset), list):
            available = sorted(subsets) if isinstance(subsets, dict) else []
            raise CatalogError(
                f"unknown smoke subset {spec.subset!r}; available subsets: {available}"
            )
        requested_ids = list(subsets[spec.subset])
    elif spec.mode == "sample":
        assert spec.count is not None
        if spec.count > len(compatible_ids):
            raise CatalogError(
                f"sample count {spec.count} exceeds {len(compatible_ids)} compatible tasks"
            )
        requested_ids = sorted(
            compatible_ids,
            key=lambda identifier: (
                hashlib.sha256(f"{spec.seed}\0{identifier}".encode()).digest(),
                identifier,
            ),
        )[: spec.count]
    elif spec.mode == "shard":
        assert spec.shard_index is not None and spec.shard_count is not None
        requested_ids = [
            identifier
            for identifier in compatible_ids
            if _stable_shard(identifier, spec.shard_count) == spec.shard_index
        ]
    else:
        requested_ids = compatible_ids

    if len(set(requested_ids)) != len(requested_ids):
        raise CatalogError("selection contains duplicate task ids")
    missing = [identifier for identifier in requested_ids if identifier not in by_id]
    if missing:
        raise CatalogError(f"selection names unknown task ids: {missing}")
    incompatible = [
        {
            "id": identifier,
            "reasons": list(by_id[identifier].get("incompatibility_reasons") or []),
        }
        for identifier in requested_ids
        if by_id[identifier].get("compatible") is not True
    ]
    if incompatible:
        raise CatalogError(f"selection includes incompatible tasks: {incompatible}")
    selected = [by_id[identifier] for identifier in requested_ids]
    if not selected:
        raise CatalogError("selection produced no compatible tasks")

    excluded = [
        {
            "id": str(task["id"]),
            "reasons": list(task.get("incompatibility_reasons") or []),
        }
        for task in tasks
        if task.get("compatible") is not True
    ]
    manifest = {
        "schema": "agencity.benchmark-selection.v1",
        "benchmark": catalog["benchmark"],
        "catalog_tasks_sha256": catalog["tasks_sha256"],
        "mode": spec.mode,
        "subset": spec.subset if spec.mode == "smoke" else None,
        "seed": spec.seed if spec.mode == "sample" else None,
        "sample_count": spec.count if spec.mode == "sample" else None,
        "shard_index": spec.shard_index if spec.mode == "shard" else None,
        "shard_count": spec.shard_count if spec.mode == "shard" else None,
        "selected_ids": requested_ids,
        "selected_ids_sha256": _ids_digest(requested_ids),
        "selected_count": len(requested_ids),
        "catalog_task_count": len(tasks),
        "compatible_task_count": len(compatible_ids),
        "incompatible_task_count": len(excluded),
        "incompatible": excluded,
    }
    return selected, manifest


def select_loaded_items(
    items: Iterable[Any],
    spec: SelectionSpec,
    *,
    identifier,
    smoke_subsets: Mapping[str, Sequence[str]],
) -> tuple[list[Any], dict[str, Any]]:
    """Apply the same selection contract to a dynamically loaded pinned dataset."""

    ordered = sorted(items, key=lambda item: identifier(item))
    identifiers = [identifier(item) for item in ordered]
    if len(set(identifiers)) != len(identifiers):
        raise CatalogError("loaded dataset contains duplicate task ids")
    pseudo_catalog = {
        "benchmark": "dynamic",
        "tasks_sha256": _ids_digest(identifiers),
        "smoke_subsets": {name: list(values) for name, values in smoke_subsets.items()},
        "tasks": [{"id": value, "compatible": True} for value in identifiers],
    }
    selected_entries, manifest = select_catalog_tasks(pseudo_catalog, spec)
    by_id = {identifier(item): item for item in ordered}
    selected = [by_id[entry["id"]] for entry in selected_entries]
    manifest["benchmark"] = None
    return selected, manifest


def _stable_shard(identifier: str, shard_count: int) -> int:
    digest = hashlib.sha256(identifier.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % shard_count


def _ids_digest(identifiers: Sequence[str]) -> str:
    return hashlib.sha256(
        json.dumps(list(identifiers), separators=(",", ":"), ensure_ascii=False).encode(
            "utf-8"
        )
    ).hexdigest()


__all__ = [
    "CatalogError",
    "SelectionSpec",
    "catalog_digest",
    "load_catalog",
    "select_catalog_tasks",
    "select_loaded_items",
    "task_entries_digest",
]

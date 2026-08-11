"""Suite-capable Terminal-Bench 2 task selection with upstream Harbor scoring."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Literal

from pydantic import model_validator
import verifiers.v1 as vf

from agencity_verifiers.harbor_suite import (
    HarborSuiteConfig,
    HarborSuiteTask,
    load_harbor_suite,
)
from agencity_verifiers.selection import load_catalog, select_catalog_tasks


DATASET = (
    "terminal-bench/terminal-bench-2@"
    "sha256:c6fc2e2382c1dbae99b2d5ecd2f4f4a60c3c01e0d84642d69b4afd92e99d078b"
)
SOURCE_CATALOG_PATH = (
    Path(__file__).resolve().parent.parent
    / "manifests"
    / "terminal-bench-2-catalog.json"
)
SOURCE_LOCK_PATH = Path(__file__).resolve().parent.parent / "uv.lock"
PACKAGED_DATA_PATH = Path(__file__).resolve().parent / "data"
CATALOG_PATH = (
    SOURCE_CATALOG_PATH
    if SOURCE_CATALOG_PATH.is_file()
    else PACKAGED_DATA_PATH / "catalog.json"
)
LOCK_PATH = (
    SOURCE_LOCK_PATH
    if SOURCE_LOCK_PATH.is_file()
    else PACKAGED_DATA_PATH / "uv.lock"
)


class TerminalBench2Config(HarborSuiteConfig):
    dataset: Literal[
        "terminal-bench/terminal-bench-2@sha256:c6fc2e2382c1dbae99b2d5ecd2f4f4a60c3c01e0d84642d69b4afd92e99d078b"
    ] = DATASET

    @model_validator(mode="after")
    def validate_catalog_selection(self) -> "TerminalBench2Config":
        catalog = load_catalog(CATALOG_PATH, "terminal-bench-2")
        if catalog["dataset"]["package"] != self.dataset:
            raise ValueError("Terminal-Bench 2 catalog dataset pin drifted")
        select_catalog_tasks(catalog, self.selection)
        return self


class TerminalBench2Task(HarborSuiteTask):
    """The upstream task package and Harbor verifier remain authoritative."""


class TerminalBench2Taskset(
    vf.Taskset[TerminalBench2Task, TerminalBench2Config]
):
    """Load the exact selected tasks through one catalog-backed implementation."""

    def load(self) -> Iterator[TerminalBench2Task]:
        return load_harbor_suite(
            self.config,
            benchmark="terminal-bench-2",
            catalog_path=CATALOG_PATH,
            lock_path=LOCK_PATH,
            task_cls=TerminalBench2Task,
        )


__all__ = [
    "DATASET",
    "TerminalBench2Config",
    "TerminalBench2Task",
    "TerminalBench2Taskset",
]

"""Suite-capable Terminal-Bench 2.1 task selection with Harbor scoring."""

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
    "terminal-bench/terminal-bench-2-1@"
    "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a"
)
SOURCE_CATALOG_PATH = (
    Path(__file__).resolve().parent.parent
    / "manifests"
    / "terminal-bench-2-1-catalog.json"
)
SOURCE_LOCK_PATH = Path(__file__).resolve().parent.parent / "uv.lock"
PACKAGED_DATA_PATH = Path(__file__).resolve().parent / "data"
PACKAGED_LOCK_PATH = (
    Path(__file__).resolve().parent.parent
    / "agencity_terminal_bench_2"
    / "data"
    / "uv.lock"
)
CATALOG_PATH = (
    SOURCE_CATALOG_PATH
    if SOURCE_CATALOG_PATH.is_file()
    else PACKAGED_DATA_PATH / "catalog.json"
)
LOCK_PATH = (
    SOURCE_LOCK_PATH if SOURCE_LOCK_PATH.is_file() else PACKAGED_LOCK_PATH
)


class TerminalBench21Config(HarborSuiteConfig):
    dataset: Literal[
        "terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a"
    ] = DATASET

    @model_validator(mode="after")
    def validate_catalog_selection(self) -> "TerminalBench21Config":
        catalog = load_catalog(CATALOG_PATH, "terminal-bench-2-1")
        if catalog["dataset"]["package"] != self.dataset:
            raise ValueError("Terminal-Bench 2.1 catalog dataset pin drifted")
        select_catalog_tasks(catalog, self.selection)
        return self


class TerminalBench21Task(HarborSuiteTask):
    """The distinct 2.1 package and verifier remain authoritative."""


class TerminalBench21Taskset(
    vf.Taskset[TerminalBench21Task, TerminalBench21Config]
):
    def load(self) -> Iterator[TerminalBench21Task]:
        return load_harbor_suite(
            self.config,
            benchmark="terminal-bench-2-1",
            catalog_path=CATALOG_PATH,
            lock_path=LOCK_PATH,
            task_cls=TerminalBench21Task,
        )


__all__ = [
    "DATASET",
    "TerminalBench21Config",
    "TerminalBench21Task",
    "TerminalBench21Taskset",
]

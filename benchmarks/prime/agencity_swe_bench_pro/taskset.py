"""A model-free safety and pinning spike for one SWE-bench Pro public instance.

The official evaluator accepts only mutable Docker Hub tags, and its task image
retains Git history that can expose withheld test material. This adapter stops
before model admission rather than claiming that the current one-runtime route
is an immutable, independently isolated treatment.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, model_validator
import verifiers.v1 as vf

from agencity_terminal_bench_2.taskset import _is_sha256, _sha256_file


SOURCE_MANIFEST_PATH = (
    Path(__file__).resolve().parent.parent / "manifests" / "swe-bench-pro-public-vuls.json"
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
MANIFEST_SCHEMA = "agencity.swe-bench-pro-public-manifest.v1"
DATASET = "ScaleAI/SWE-bench_Pro"
DATASET_REVISION = "7ab5114912baf22bb098818e604c02fe7ad2c11f"
TASK_ID = "instance_future-architect__vuls-36456cb151894964ba1683ce7da5c35ada789970"
REPOSITORY = "future-architect/vuls"
BASE_COMMIT = "4ae87cc36cb1b1dbc7fd49680d553c8bb47fa8b6"
DOCKER_TAG = "future-architect.vuls-future-architect__vuls-36456cb151894964ba1683ce7da5c35ada789970"
IMAGE = (
    "jefzda/sweap-images@"
    "sha256:9692fd1d1709d74120c024da8f660a045d57a62ce1711cc390062ac51a718ae3"
)
WORKSPACE = "/app"
PUBLIC_SELECTION_SHA256 = "227115c9f6893ef6146f9a432fdf89388793b39ae4112d67a77e066662c535a0"
EVALUATOR_REPOSITORY = "https://github.com/scaleapi/SWE-bench_Pro-os"
EVALUATOR_COMMIT = "ca10a60a5fcae51e6948ffe1485d4153d421e6c5"
EVALUATOR_TREE_SHA256 = "472a5ec338449cc18d4e2809d134814ede3d98349e9ea09babc3fe098348a830"
AGENCITY_SOURCE_REPO = "https://github.com/kousun12/agencity.git"
AGENCITY_SOURCE_REF = "eeceb6f02e2178e2e0d0e1a9b2f6e3f31a907a02"
BUN_VERSION = "1.3.14"
BUN_ARCHIVE = (
    "https://github.com/oven-sh/bun/releases/download/"
    "bun-v1.3.14/bun-linux-x64.zip"
)
BUN_ARCHIVE_SHA256 = "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f"

_PUBLIC_FIELDS = (
    "repo",
    "instance_id",
    "base_commit",
    "dockerhub_tag",
    "problem_statement",
    "requirements",
    "interface",
    "repo_language",
    "before_repo_set_cmd",
    "selected_test_files_to_run",
    "fail_to_pass",
    "pass_to_pass",
)


class OfficialEvaluatorCompatibilityError(RuntimeError):
    """The current official route lacks immutable images and test isolation."""


class SWEProConfig(vf.TasksetConfig):
    dataset: Literal["ScaleAI/SWE-bench_Pro"] = DATASET
    revision: Literal["7ab5114912baf22bb098818e604c02fe7ad2c11f"] = DATASET_REVISION
    instances: list[str] = Field(default_factory=lambda: [TASK_ID])

    @model_validator(mode="after")
    def validates_bounded_selection(self) -> "SWEProConfig":
        if self.instances != [TASK_ID]:
            raise ValueError(
                f"SWE-bench Pro integration permits exactly {TASK_ID!r}"
            )
        return self


class SWEProData(vf.TaskData):
    instance_id: str
    repository: str
    base_commit: str
    dataset_revision: str


class SWEProTask(vf.Task[SWEProData]):
    """Refuse model admission until the official evaluator accepts image digests."""

    NEEDS_CONTAINER = True

    async def setup(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        require_official_evaluator_compatibility()


class SWEProTaskset(vf.Taskset[SWEProTask, SWEProConfig]):
    def load(self) -> list[SWEProTask]:
        manifest = load_manifest()
        validate_lockfile(manifest)
        row = load_selected_public_row()
        validate_selected_public_row(row, manifest)
        data = SWEProData(
            idx=0,
            name=TASK_ID,
            prompt=build_prompt(row),
            image=IMAGE,
            workdir=WORKSPACE,
            network_allow=[],
            instance_id=TASK_ID,
            repository=REPOSITORY,
            base_commit=BASE_COMMIT,
            dataset_revision=DATASET_REVISION,
        )
        return [SWEProTask(data, self.config.task)]


def load_manifest(path: Path = MANIFEST_PATH) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schema") != MANIFEST_SCHEMA:
        raise ValueError("SWE-bench Pro manifest schema is unsupported")
    selection = value.get("selection")
    expected_selection = {
        "dataset": DATASET,
        "dataset_revision": DATASET_REVISION,
        "instance_id": TASK_ID,
        "repository": REPOSITORY,
        "base_commit": BASE_COMMIT,
        "docker_tag": DOCKER_TAG,
        "image": IMAGE,
        "workspace": WORKSPACE,
        "public_selection_sha256": PUBLIC_SELECTION_SHA256,
    }
    if not isinstance(selection, dict) or {
        key: selection.get(key) for key in expected_selection
    } != expected_selection:
        raise ValueError("SWE-bench Pro manifest selection does not match taskset")
    evaluator = value.get("official_evaluator")
    expected_evaluator = {
        "repository": EVALUATOR_REPOSITORY,
        "commit": EVALUATOR_COMMIT,
        "tree_sha256": EVALUATOR_TREE_SHA256,
        "immutable_image_input": False,
    }
    if not isinstance(evaluator, dict) or {
        key: evaluator.get(key) for key in expected_evaluator
    } != expected_evaluator:
        raise ValueError("SWE-bench Pro evaluator manifest does not match the audited route")
    if not _is_sha256(value.get("python_lock_sha256")):
        raise ValueError("SWE-bench Pro manifest Python lock digest is invalid")
    return value


def validate_lockfile(manifest: dict[str, Any]) -> None:
    if _sha256_file(LOCK_PATH) != manifest["python_lock_sha256"]:
        raise ValueError("SWE-bench Pro manifest Python lock digest does not match uv.lock")


def load_selected_public_row() -> Mapping[str, Any]:
    from datasets import load_dataset

    rows = load_dataset(DATASET, revision=DATASET_REVISION, split="test")
    matching = [row for row in rows if row.get("instance_id") == TASK_ID]
    if len(matching) != 1:
        raise ValueError(f"Expected one selected SWE-bench Pro instance, found {len(matching)}")
    return matching[0]


def validate_selected_public_row(
    row: Mapping[str, Any], manifest: Mapping[str, Any] | None = None
) -> None:
    if row.get("repo") != REPOSITORY or row.get("base_commit") != BASE_COMMIT:
        raise ValueError("SWE-bench Pro selected repository or base revision drifted")
    if row.get("dockerhub_tag") != DOCKER_TAG:
        raise ValueError("SWE-bench Pro selected Docker tag drifted")
    public = {key: row.get(key) for key in _PUBLIC_FIELDS}
    digest = hashlib.sha256(
        json.dumps(public, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    expected = (
        manifest["selection"]["public_selection_sha256"]
        if manifest is not None
        else PUBLIC_SELECTION_SHA256
    )
    if digest != expected:
        raise ValueError("SWE-bench Pro public selection fields drifted")


def build_prompt(row: Mapping[str, Any]) -> str:
    """Expose issue materials only; evaluator-only fields never reach Agencity."""
    sections = [
        "Resolve the following public SWE-bench Pro issue in the repository workspace.",
        f"Repository: {REPOSITORY}",
        f"Base revision: {BASE_COMMIT}",
        "Issue:",
        required_text(row, "problem_statement"),
    ]
    for name, heading in (("requirements", "Requirements"), ("interface", "Interface")):
        value = row.get(name)
        if isinstance(value, str) and value.strip():
            sections.extend((f"{heading}:", value))
    sections.append(
        "Work only in the repository workspace. Do not assume access to hidden tests, "
        "reference patches, evaluator scripts, or evaluator output."
    )
    return "\n\n".join(sections)


def required_text(row: Mapping[str, Any], name: str) -> str:
    value = row.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"SWE-bench Pro public row has no usable {name}")
    return value


def require_official_evaluator_compatibility() -> None:
    raise OfficialEvaluatorCompatibilityError(
        "The audited official SWE-bench Pro route only accepts a mutable Docker "
        "Hub tag, and the original task image retains Git history from which "
        "withheld tests can be recovered. The shared one-runtime harness has no "
        "verified sanitized-agent/fresh-scorer split, so model admission is refused."
    )


def validate_official_evaluator_evidence(value: object) -> bool:
    """Validate the one-instance boolean result shape before a future scorer maps it."""
    if not isinstance(value, dict) or set(value) != {TASK_ID}:
        raise ValueError("SWE-bench Pro evaluator evidence must contain one selected instance")
    result = value[TASK_ID]
    if type(result) is not bool:
        raise ValueError("SWE-bench Pro evaluator result must be a boolean")
    return result

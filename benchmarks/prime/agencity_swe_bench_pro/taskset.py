"""Suite-capable split-runtime SWE-bench Pro public taskset."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import Mapping
from importlib.metadata import version
from pathlib import Path
from typing import Any, Literal

from pydantic import model_validator
import verifiers.v1 as vf

from agencity_swe_bench_pro.scorer import score_with_official_evaluator
from agencity_verifiers.harbor_suite import _sha256_file
from agencity_verifiers.harness import _cleanup_portable, _shutdown_portable
from agencity_verifiers.selection import (
    SelectionSpec,
    catalog_digest,
    load_catalog,
    select_catalog_tasks,
)


DATASET = "ScaleAI/SWE-bench_Pro"
DATASET_REVISION = "7ab5114912baf22bb098818e604c02fe7ad2c11f"
BENCHMARK = "swe-bench-pro-public"
WORKSPACE = "/app"
PATCH_MAX_BYTES = 8 * 1024 * 1024
PATCH_PATH = "/tmp/agencity-swe-bench-pro.patch"
SOURCE_CATALOG_PATH = (
    Path(__file__).resolve().parent.parent
    / "manifests"
    / "swe-bench-pro-public-catalog.json"
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
_PINNED_ROW_FIELDS = (
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
_COMMIT_PATTERN = re.compile(r"\b[0-9a-f]{40}\b")
_EMPTY_PATCH = """\
diff --git a/.agencity-empty-change b/.agencity-empty-change
new file mode 100644
index 0000000..e69de29
"""


class SWEProConfig(vf.TasksetConfig):
    dataset: Literal["ScaleAI/SWE-bench_Pro"] = DATASET
    revision: Literal["7ab5114912baf22bb098818e604c02fe7ad2c11f"] = (
        DATASET_REVISION
    )
    selection: SelectionSpec = SelectionSpec()
    treatment: Literal["agencity-portable", "harness-native"] = "agencity-portable"

    @model_validator(mode="after")
    def validate_catalog_selection(self) -> "SWEProConfig":
        catalog = load_catalog(CATALOG_PATH, BENCHMARK)
        dataset = catalog["dataset"]
        if dataset["id"] != self.dataset or dataset["revision"] != self.revision:
            raise ValueError("SWE-bench Pro catalog dataset pin drifted")
        select_catalog_tasks(catalog, self.selection)
        return self


class SWEProData(vf.TaskData):
    selection_id: str
    repository: str
    base_commit: str
    dataset_revision: str
    catalog_sha256: str
    catalog_tasks_sha256: str
    selected_ids: list[str]
    selected_ids_sha256: str
    public_selection_sha256: str
    image_manifest_digest: str
    image_config_digest: str
    treatment: str


class SWEProTask(vf.Task[SWEProData]):
    """Sanitize the agent workspace and retain only a bounded private patch."""

    NEEDS_CONTAINER = True

    def __init__(
        self,
        data: SWEProData,
        config: vf.TaskConfig | None = None,
        *,
        evaluator_row: Mapping[str, Any],
        pin: Mapping[str, Any],
    ) -> None:
        super().__init__(data, config)
        self._evaluator_row = dict(evaluator_row)
        self._pin = dict(pin)
        self._baselines: dict[str, str] = {}
        self._patches: dict[str, str] = {}

    async def setup(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        baseline = await _sanitize_workspace(
            runtime, self.data.workdir, self.data.base_commit
        )
        self._baselines[trace.id] = baseline
        forbidden = _forbidden_history_commits(
            self._evaluator_row, self.data.base_commit
        )
        for commit in forbidden:
            observed = await runtime.run(
                [
                    "git",
                    "-C",
                    self.data.workdir,
                    "cat-file",
                    "-e",
                    f"{commit}^{{commit}}",
                ],
                {},
            )
            if observed.exit_code == 0:
                raise RuntimeError(
                    "Sanitized agent repository still resolves withheld Git history"
                )
        trace.info["swe_bench_pro_isolation"] = {
            "schema": "agencity.swe-bench-pro-agent-isolation.v2",
            "workspace": self.data.workdir,
            "base_commit": self.data.base_commit,
            "original_git_history_removed": True,
            "fresh_baseline_repository": True,
            "withheld_commits_resolvable": False,
            "agent_network": "verifiers-interception-only",
        }

    async def finalize(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        if self.data.treatment == "agencity-portable":
            metadata = trace.info.setdefault("agencity", {})
            if not isinstance(metadata, dict):
                raise ValueError("Agencity trace metadata is malformed")
            try:
                metadata["service_shutdown"] = await _shutdown_portable(
                    runtime, self.data.workdir
                )
            finally:
                metadata["cleanup"] = await _cleanup_portable(
                    runtime, self.data.workdir
                )

        baseline = self._baselines.pop(trace.id, None)
        if baseline is None:
            raise RuntimeError("SWE-bench Pro baseline identity was not retained")
        patch = await _capture_patch(runtime, self.data.workdir, baseline)
        synthetic_noop = not patch
        if synthetic_noop:
            patch = _EMPTY_PATCH
        self._patches[trace.id] = patch
        trace.info["swe_bench_pro_patch"] = {
            "schema": "agencity.swe-bench-pro-private-patch.v2",
            "bytes": len(patch.encode("utf-8")),
            "sha256": hashlib.sha256(patch.encode("utf-8")).hexdigest(),
            "synthetic_noop": synthetic_noop,
            "content_retained_in_trace": False,
            "workspace_metadata_removed_before_capture": (
                self.data.treatment == "agencity-portable"
            ),
        }
        trace.info["benchmark_provenance"] = {
            "schema": "agencity.benchmark-task-provenance.v1",
            "benchmark": BENCHMARK,
            "selection_id": self.data.selection_id,
            "catalog_sha256": self.data.catalog_sha256,
            "catalog_tasks_sha256": self.data.catalog_tasks_sha256,
            "selected_ids": self.data.selected_ids,
            "selected_ids_sha256": self.data.selected_ids_sha256,
            "dataset_revision": self.data.dataset_revision,
            "public_selection_sha256": self.data.public_selection_sha256,
            "image": self.data.image,
            "image_manifest_digest": self.data.image_manifest_digest,
            "image_config_digest": self.data.image_config_digest,
            "workdir": self.data.workdir,
            "treatment": self.data.treatment,
        }

    def take_patch(self, trace_id: str) -> str:
        try:
            return self._patches.pop(trace_id)
        except KeyError as error:
            raise RuntimeError("SWE-bench Pro private patch is unavailable") from error

    @property
    def evaluator_row(self) -> Mapping[str, Any]:
        return self._evaluator_row

    @property
    def pin(self) -> Mapping[str, Any]:
        return self._pin


class SWEProEnvConfig(vf.EnvConfig):
    agent: vf.AgentConfig = vf.AgentConfig()


class SWEProEnv(vf.Env[SWEProEnvConfig]):
    """Run one harness, destroy its runtime, then invoke the official scorer."""

    async def setup(self, agents: vf.Agents) -> None:
        config = agents.agent.config
        if config.runtime.type != "docker":
            raise ValueError("SWE-bench Pro requires a disposable Docker agent runtime")
        taskset_config = self.taskset.config
        if taskset_config.treatment != "agencity-portable":
            return
        catalog = load_catalog(CATALOG_PATH, BENCHMARK)
        treatment = catalog["treatments"]["agencity-portable"]
        harness = config.harness
        expected = {
            "id": treatment["harness"],
            "source_repo": treatment["source_repo"],
            "source_ref": treatment["source_ref"],
            "installation": "portable",
            "bun_url": treatment["bun_archive"],
            "bun_sha256": treatment["bun_archive_sha256"],
        }
        if harness is None or any(
            getattr(harness, name, None) != value for name, value in expected.items()
        ):
            raise ValueError(
                "Agencity SWE-bench Pro treatment requires the catalog-pinned "
                "portable Agencity harness"
            )

    async def run(self, task: vf.Task, agents: vf.Agents) -> None:
        await agents.agent.run(task)

    async def finalize(self, task: vf.Task, episode: vf.Episode) -> None:
        if not isinstance(task, SWEProTask):
            raise TypeError("SWE-bench Pro environment received the wrong task type")
        if len(episode.traces) != 1:
            raise ValueError("SWE-bench Pro treatment expects exactly one agent trace")
        trace = episode.traces[0]
        if trace.has_error:
            return
        patch = task.take_patch(trace.id)
        score = await asyncio.to_thread(
            score_with_official_evaluator,
            patch,
            task.evaluator_row,
            task.pin,
            trace_id=trace.id,
        )
        trace.info["swe_bench_pro_official"] = score.evidence
        trace.record_reward("official_swe_bench_pro", score.reward)


class SWEProTaskset(vf.Taskset[SWEProTask, SWEProConfig]):
    def load(self) -> list[SWEProTask]:
        catalog = load_catalog(CATALOG_PATH, BENCHMARK)
        _validate_catalog(catalog, self.config)
        selected, selection = select_catalog_tasks(catalog, self.config.selection)
        selected_ids = [entry["id"] for entry in selected]
        rows = load_selected_public_rows(selected_ids)
        digest = catalog_digest(CATALOG_PATH)
        tasks: list[SWEProTask] = []
        for idx, pin in enumerate(selected):
            identifier = pin["id"]
            row = rows[identifier]
            validate_selected_public_row(row, pin)
            data = SWEProData(
                idx=idx,
                name=identifier,
                prompt=build_prompt(row),
                image=pin["image"],
                workdir=pin["workdir"],
                network_allow=[],
                network_block=["*"],
                selection_id=identifier,
                repository=pin["repository"],
                base_commit=pin["base_commit"],
                dataset_revision=DATASET_REVISION,
                catalog_sha256=digest,
                catalog_tasks_sha256=catalog["tasks_sha256"],
                selected_ids=selection["selected_ids"],
                selected_ids_sha256=selection["selected_ids_sha256"],
                public_selection_sha256=pin["public_selection_sha256"],
                image_manifest_digest=pin["image_manifest_digest"],
                image_config_digest=pin["image_config_digest"],
                treatment=self.config.treatment,
            )
            tasks.append(
                SWEProTask(
                    data,
                    self.config.task,
                    evaluator_row=row,
                    pin=pin,
                )
            )
        return tasks


def _validate_catalog(catalog: Mapping[str, Any], config: SWEProConfig) -> None:
    dataset = catalog.get("dataset")
    if (
        not isinstance(dataset, Mapping)
        or dataset.get("id") != config.dataset
        or dataset.get("revision") != config.revision
    ):
        raise ValueError("SWE-bench Pro catalog dataset does not match taskset config")
    runtime = catalog.get("runtime")
    expected = {"verifiers_version": "0.3.0", "docker_sdk_version": "7.2.0"}
    if not isinstance(runtime, Mapping) or {
        key: runtime.get(key) for key in expected
    } != expected:
        raise ValueError("SWE-bench Pro catalog runtime pins do not match")
    installed = {"verifiers_version": version("verifiers"), "docker_sdk_version": version("docker")}
    if installed != expected:
        raise ValueError(
            f"SWE-bench Pro runtime mismatch: expected {expected}, installed {installed}"
        )
    if catalog.get("python_lock_sha256") != _sha256_file(LOCK_PATH):
        raise ValueError("SWE-bench Pro catalog Python lock digest does not match uv.lock")


def load_selected_public_rows(ids: list[str]) -> dict[str, Mapping[str, Any]]:
    from datasets import load_dataset

    wanted = set(ids)
    rows = load_dataset(DATASET, revision=DATASET_REVISION, split="test")
    matching = {
        row["instance_id"]: row
        for row in rows
        if row.get("instance_id") in wanted
    }
    if set(matching) != wanted:
        raise ValueError(
            f"SWE-bench Pro selected rows drifted; missing {sorted(wanted - set(matching))}"
        )
    return matching


def validate_selected_public_row(
    row: Mapping[str, Any], pin: Mapping[str, Any]
) -> None:
    expected = {
        "instance_id": pin["id"],
        "repo": pin["repository"],
        "base_commit": pin["base_commit"],
        "dockerhub_tag": pin["docker_tag"],
    }
    if {key: row.get(key) for key in expected} != expected:
        raise ValueError("SWE-bench Pro selected row identity drifted")
    public = {key: row.get(key) for key in _PINNED_ROW_FIELDS}
    digest = hashlib.sha256(
        json.dumps(public, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if digest != pin["public_selection_sha256"]:
        raise ValueError("SWE-bench Pro public selection fields drifted")


def build_prompt(row: Mapping[str, Any]) -> str:
    sections = [
        "Resolve the following public SWE-bench Pro issue in the repository workspace.",
        f"Repository: {required_text(row, 'repo')}",
        f"Base revision: {required_text(row, 'base_commit')}",
        "Issue:",
        required_text(row, "problem_statement"),
    ]
    for name, heading in (("requirements", "Requirements"), ("interface", "Interface")):
        value = row.get(name)
        if isinstance(value, str) and value.strip():
            sections.extend((f"{heading}:", value))
    sections.append(
        "Work only in the repository workspace. Do not assume access to hidden tests, "
        "reference patches, evaluator scripts, Docker, or evaluator output."
    )
    return "\n\n".join(sections)


def required_text(row: Mapping[str, Any], name: str) -> str:
    value = row.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"SWE-bench Pro public row has no usable {name}")
    return value


async def _sanitize_workspace(
    runtime: vf.Runtime, workspace: str, base_commit: str
) -> str:
    command = f"""
set -eu
cd {workspace}
test "$(git rev-parse HEAD)" = "{base_commit}"
archive=/tmp/agencity-swe-bench-pro-public.tar
git archive --format=tar --output="$archive" {base_commit}
find {workspace} -mindepth 1 -maxdepth 1 -exec rm -rf -- {{}} +
tar -xf "$archive" -C {workspace}
rm -f "$archive"
test ! -e {workspace}/.git
git -C {workspace} init -q
git -C {workspace} config user.name "Agencity Benchmark"
git -C {workspace} config user.email "benchmark@agencity.invalid"
git -C {workspace} add -A
GIT_AUTHOR_DATE="2000-01-01T00:00:00Z" \
GIT_COMMITTER_DATE="2000-01-01T00:00:00Z" \
  git -C {workspace} commit -qm "sanitized public baseline"
git -C {workspace} rev-parse HEAD
"""
    result = await runtime.run(["sh", "-lc", command], {})
    if result.exit_code != 0:
        detail = (result.stderr or result.stdout).strip()[-2000:]
        raise RuntimeError(f"SWE-bench Pro workspace sanitization failed: {detail}")
    baseline = result.stdout.strip().splitlines()[-1]
    if not re.fullmatch(r"[0-9a-f]{40}", baseline):
        raise RuntimeError("SWE-bench Pro sanitized baseline identity is invalid")
    return baseline


async def _capture_patch(runtime: vf.Runtime, workspace: str, baseline: str) -> str:
    staged = await runtime.run(["git", "-C", workspace, "add", "-A"], {})
    if staged.exit_code != 0:
        raise RuntimeError("SWE-bench Pro could not stage the final workspace")
    command = (
        f"git -C {workspace} diff --cached --binary --no-ext-diff "
        f"{baseline} -- > {PATCH_PATH}"
    )
    captured = await runtime.run(["sh", "-lc", command], {})
    if captured.exit_code != 0:
        detail = (captured.stderr or captured.stdout).strip()[-1000:]
        raise RuntimeError(f"SWE-bench Pro patch capture failed: {detail}")
    payload = await runtime.read(PATCH_PATH, max_bytes=PATCH_MAX_BYTES + 1)
    if len(payload) > PATCH_MAX_BYTES:
        raise RuntimeError(
            f"SWE-bench Pro patch exceeds the {PATCH_MAX_BYTES}-byte treatment bound"
        )
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RuntimeError("SWE-bench Pro patch is not valid UTF-8") from error


def _forbidden_history_commits(
    row: Mapping[str, Any], base_commit: str
) -> set[str]:
    command = row.get("before_repo_set_cmd")
    if not isinstance(command, str):
        return set()
    return {
        commit
        for commit in _COMMIT_PATTERN.findall(command)
        if commit != base_commit
    }


__all__ = [
    "SWEProConfig",
    "SWEProData",
    "SWEProEnv",
    "SWEProEnvConfig",
    "SWEProTask",
    "SWEProTaskset",
    "build_prompt",
    "validate_selected_public_row",
]

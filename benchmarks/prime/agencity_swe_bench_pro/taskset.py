"""A split-runtime SWE-bench Pro public treatment for one pinned instance."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import Mapping
from importlib.metadata import version
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, model_validator
import verifiers.v1 as vf

from agencity_swe_bench_pro.scorer import (
    BASE_DOCKERFILE_SHA256,
    EVALUATOR_COMMIT,
    EVALUATOR_ENTRYPOINT_SHA256,
    EVALUATOR_IMAGE_HELPER_SHA256,
    EVALUATOR_REPOSITORY,
    EVALUATOR_TREE_SHA256,
    IMAGE,
    IMAGE_CONFIG_DIGEST,
    IMAGE_ID,
    INSTANCE_DOCKERFILE_SHA256,
    PARSER_SHA256,
    RUN_SCRIPT_SHA256,
    score_with_official_evaluator,
    validate_official_evaluator_evidence,
)
from agencity_terminal_bench_2.taskset import _is_sha256, _sha256_file
from agencity_verifiers.harness import _cleanup_portable, _shutdown_portable


SOURCE_MANIFEST_PATH = (
    Path(__file__).resolve().parent.parent
    / "manifests"
    / "swe-bench-pro-public-qutebrowser.json"
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
MANIFEST_SCHEMA = "agencity.swe-bench-pro-public-manifest.v2"
DATASET = "ScaleAI/SWE-bench_Pro"
DATASET_REVISION = "7ab5114912baf22bb098818e604c02fe7ad2c11f"
TASK_ID = (
    "instance_qutebrowser__qutebrowser-"
    "0833b5f6f140d04200ec91605f88704dd18e2970-"
    "v059c6fdc75567943479b23ebca7c07b5e9a7f34c"
)
REPOSITORY = "qutebrowser/qutebrowser"
BASE_COMMIT = "def864adc8b19bdbc506919270d8ff1408b4faac"
DOCKER_TAG = (
    "qutebrowser.qutebrowser-qutebrowser__qutebrowser-"
    "0833b5f6f140d04200ec91605f88704dd18e2970-"
    "v059c6fdc75567943479b23ebca7c07b5e9a7f"
)
WORKSPACE = "/app"
PUBLIC_SELECTION_SHA256 = "2b0e0fc1d3f877c2870d3fd3d8c3a679b5a4d6fa4fad6e5f1732e7ba73509f50"
AGENCITY_SOURCE_REPO = "https://github.com/kousun12/agencity.git"
AGENCITY_SOURCE_REF = "ef16e551cc4494cdd76637249a80afa82cdf26be"
BUN_VERSION = "1.3.14"
BUN_ARCHIVE = (
    "https://github.com/oven-sh/bun/releases/download/"
    "bun-v1.3.14/bun-linux-x64.zip"
)
BUN_ARCHIVE_SHA256 = "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f"
VERIFIERS_VERSION = "0.3.0"
DOCKER_SDK_VERSION = "7.2.0"
PATCH_MAX_BYTES = 8 * 1024 * 1024
PATCH_PATH = "/tmp/agencity-swe-bench-pro.patch"

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
    instances: list[str] = Field(default_factory=lambda: [TASK_ID])

    @model_validator(mode="after")
    def validates_bounded_selection(self) -> "SWEProConfig":
        if self.instances != [TASK_ID]:
            raise ValueError(f"SWE-bench Pro integration permits exactly {TASK_ID!r}")
        return self


class SWEProData(vf.TaskData):
    instance_id: str
    repository: str
    base_commit: str
    dataset_revision: str


class SWEProTask(vf.Task[SWEProData]):
    """Sanitize the agent workspace and privately retain only its final patch."""

    NEEDS_CONTAINER = True

    def __init__(
        self,
        data: SWEProData,
        config: vf.TaskConfig | None = None,
        *,
        evaluator_row: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(data, config)
        self._evaluator_row = dict(evaluator_row or {})
        self._baselines: dict[str, str] = {}
        self._patches: dict[str, str] = {}

    async def setup(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        baseline = await _sanitize_workspace(runtime)
        self._baselines[trace.id] = baseline
        forbidden = _forbidden_history_commits(self._evaluator_row)
        for commit in forbidden:
            observed = await runtime.run(
                ["git", "-C", WORKSPACE, "cat-file", "-e", f"{commit}^{{commit}}"],
                {},
            )
            if observed.exit_code == 0:
                raise RuntimeError(
                    "Sanitized agent repository still resolves withheld Git history"
                )
        trace.info["swe_bench_pro_isolation"] = {
            "schema": "agencity.swe-bench-pro-agent-isolation.v1",
            "workspace": WORKSPACE,
            "base_commit": BASE_COMMIT,
            "original_git_history_removed": True,
            "fresh_baseline_repository": True,
            "withheld_commits_resolvable": False,
            "agent_network": "verifiers-interception-only",
        }

    async def finalize(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        metadata = trace.info.setdefault("agencity", {})
        if not isinstance(metadata, dict):
            raise ValueError("Agencity trace metadata is malformed")
        try:
            metadata["service_shutdown"] = await _shutdown_portable(runtime, WORKSPACE)
        finally:
            metadata["cleanup"] = await _cleanup_portable(runtime, WORKSPACE)

        baseline = self._baselines.pop(trace.id, None)
        if baseline is None:
            raise RuntimeError("SWE-bench Pro baseline identity was not retained")
        patch = await _capture_patch(runtime, baseline)
        synthetic_noop = not patch
        if synthetic_noop:
            patch = _EMPTY_PATCH
        self._patches[trace.id] = patch
        trace.info["swe_bench_pro_patch"] = {
            "schema": "agencity.swe-bench-pro-private-patch.v1",
            "bytes": len(patch.encode("utf-8")),
            "sha256": hashlib.sha256(patch.encode("utf-8")).hexdigest(),
            "synthetic_noop": synthetic_noop,
            "content_retained_in_trace": False,
            "workspace_metadata_removed_before_capture": True,
        }

    def take_patch(self, trace_id: str) -> str:
        try:
            return self._patches.pop(trace_id)
        except KeyError as error:
            raise RuntimeError("SWE-bench Pro private patch is unavailable") from error

    @property
    def evaluator_row(self) -> Mapping[str, Any]:
        if not self._evaluator_row:
            raise RuntimeError("SWE-bench Pro evaluator row is unavailable")
        return self._evaluator_row


class SWEProEnvConfig(vf.EnvConfig):
    agent: vf.AgentConfig = vf.AgentConfig()


class SWEProEnv(vf.Env[SWEProEnvConfig]):
    """Run Agencity first, then score privately after its runtime teardown."""

    async def setup(self, agents: vf.Agents) -> None:
        config = agents.agent.config
        harness = config.harness
        expected = {
            "id": "agencity-verifiers",
            "source_repo": AGENCITY_SOURCE_REPO,
            "source_ref": AGENCITY_SOURCE_REF,
            "installation": "portable",
            "bun_url": BUN_ARCHIVE,
            "bun_sha256": BUN_ARCHIVE_SHA256,
        }
        if harness is None or any(
            getattr(harness, name, None) != value for name, value in expected.items()
        ):
            raise ValueError(
                "SWE-bench Pro requires the exact pinned Agencity portable harness"
            )
        if config.runtime.type != "docker":
            raise ValueError("SWE-bench Pro requires a disposable Docker agent runtime")

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
            trace_id=trace.id,
        )
        trace.info["swe_bench_pro_official"] = score.evidence
        trace.record_reward("official_swe_bench_pro", score.reward)


class SWEProTaskset(vf.Taskset[SWEProTask, SWEProConfig]):
    def load(self) -> list[SWEProTask]:
        manifest = load_manifest()
        validate_runtime_versions()
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
        return [SWEProTask(data, self.config.task, evaluator_row=row)]


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
        "image_id": IMAGE_ID,
        "image_config_digest": IMAGE_CONFIG_DIGEST,
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
        "entrypoint_sha256": EVALUATOR_ENTRYPOINT_SHA256,
        "image_helper_sha256": EVALUATOR_IMAGE_HELPER_SHA256,
        "run_script_sha256": RUN_SCRIPT_SHA256,
        "parser_sha256": PARSER_SHA256,
        "base_dockerfile_sha256": BASE_DOCKERFILE_SHA256,
        "instance_dockerfile_sha256": INSTANCE_DOCKERFILE_SHA256,
        "upstream_accepts_image_digest": False,
        "adapter_enforces_image_digest": True,
    }
    if not isinstance(evaluator, dict) or {
        key: evaluator.get(key) for key in expected_evaluator
    } != expected_evaluator:
        raise ValueError("SWE-bench Pro evaluator manifest does not match the pinned route")
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
        raise ValueError("SWE-bench Pro Agencity pins do not match")
    if not _is_sha256(value.get("python_lock_sha256")):
        raise ValueError("SWE-bench Pro manifest Python lock digest is invalid")
    runtime = value.get("runtime")
    expected_runtime = {
        "verifiers_version": VERIFIERS_VERSION,
        "docker_sdk_version": DOCKER_SDK_VERSION,
    }
    if not isinstance(runtime, dict) or {
        key: runtime.get(key) for key in expected_runtime
    } != expected_runtime:
        raise ValueError("SWE-bench Pro runtime version pins do not match")
    return value


def validate_runtime_versions() -> None:
    expected = {
        "verifiers": VERIFIERS_VERSION,
        "docker": DOCKER_SDK_VERSION,
    }
    for package, pinned in expected.items():
        installed = version(package)
        if installed != pinned:
            raise ValueError(
                f"SWE-bench Pro requires {package}=={pinned}, found {installed}"
            )


def validate_lockfile(manifest: Mapping[str, Any]) -> None:
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
    public = {key: row.get(key) for key in _PINNED_ROW_FIELDS}
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


async def _sanitize_workspace(runtime: vf.Runtime) -> str:
    command = f"""
set -eu
cd {WORKSPACE}
test "$(git rev-parse HEAD)" = "{BASE_COMMIT}"
archive=/tmp/agencity-swe-bench-pro-public.tar
git archive --format=tar --output="$archive" {BASE_COMMIT}
find {WORKSPACE} -mindepth 1 -maxdepth 1 -exec rm -rf -- {{}} +
tar -xf "$archive" -C {WORKSPACE}
rm -f "$archive"
test ! -e {WORKSPACE}/.git
git -C {WORKSPACE} init -q
git -C {WORKSPACE} config user.name "Agencity Benchmark"
git -C {WORKSPACE} config user.email "benchmark@agencity.invalid"
git -C {WORKSPACE} add -A
GIT_AUTHOR_DATE="2000-01-01T00:00:00Z" \
GIT_COMMITTER_DATE="2000-01-01T00:00:00Z" \
  git -C {WORKSPACE} commit -qm "sanitized public baseline"
git -C {WORKSPACE} rev-parse HEAD
"""
    result = await runtime.run(["sh", "-lc", command], {})
    if result.exit_code != 0:
        detail = (result.stderr or result.stdout).strip()[-2000:]
        raise RuntimeError(f"SWE-bench Pro workspace sanitization failed: {detail}")
    baseline = result.stdout.strip().splitlines()[-1]
    if not re.fullmatch(r"[0-9a-f]{40}", baseline):
        raise RuntimeError("SWE-bench Pro sanitized baseline identity is invalid")
    return baseline


async def _capture_patch(runtime: vf.Runtime, baseline: str) -> str:
    staged = await runtime.run(["git", "-C", WORKSPACE, "add", "-A"], {})
    if staged.exit_code != 0:
        raise RuntimeError("SWE-bench Pro could not stage the final workspace")
    command = (
        f"git -C {WORKSPACE} diff --cached --binary --no-ext-diff "
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


def _forbidden_history_commits(row: Mapping[str, Any]) -> set[str]:
    command = row.get("before_repo_set_cmd")
    if not isinstance(command, str):
        return set()
    return {
        commit
        for commit in _COMMIT_PATTERN.findall(command)
        if commit != BASE_COMMIT
    }


__all__ = [
    "SWEProEnv",
    "SWEProEnvConfig",
    "SWEProTaskset",
    "validate_official_evaluator_evidence",
]

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import tomllib
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from agencity_verifiers.harbor_suite import _sha256_file, _sha256_tree
from agencity_verifiers.selection import task_entries_digest
from agencity_verifiers.source import AGENCITY_SOURCE_REF, AGENCITY_SOURCE_REPO


ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = ROOT / "uv.lock"
BUN_ARCHIVE = (
    "https://github.com/oven-sh/bun/releases/download/"
    "bun-v1.3.14/bun-linux-x64.zip"
)
BUN_ARCHIVE_SHA256 = "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f"
SWE_DATASET = "ScaleAI/SWE-bench_Pro"
SWE_REVISION = "7ab5114912baf22bb098818e604c02fe7ad2c11f"
SWE_EVALUATOR_REPOSITORY = "https://github.com/scaleapi/SWE-bench_Pro-os"
SWE_EVALUATOR_COMMIT = "ca10a60a5fcae51e6948ffe1485d4153d421e6c5"
SWE_EVALUATOR_TREE_SHA256 = (
    "472a5ec338449cc18d4e2809d134814ede3d98349e9ea09babc3fe098348a830"
)
SWE_PUBLIC_FIELDS = (
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
SWE_AUDITED_IDS = (
    "instance_qutebrowser__qutebrowser-"
    "0833b5f6f140d04200ec91605f88704dd18e2970-"
    "v059c6fdc75567943479b23ebca7c07b5e9a7f34c",
    "instance_future-architect__vuls-36456cb151894964ba1683ce7da5c35ada789970",
)
SWE_KNOWN_INCOMPATIBILITIES = {
    "instance_future-architect__vuls-36456cb151894964ba1683ce7da5c35ada789970": {
        "code": "official_noop_parser_evidence_empty",
        "detail": (
            "the pinned official evaluator returned an empty parsed test set "
            "for the model-free no-op control, so reward zero cannot be "
            "distinguished from evaluator infrastructure failure"
        ),
    }
}

TERMINAL = {
    "terminal-bench-2": {
        "package": (
            "terminal-bench/terminal-bench-2@"
            "sha256:c6fc2e2382c1dbae99b2d5ecd2f4f4a60c3c01e0d84642d69b4afd92e99d078b"
        ),
        "cache": (
            Path.home()
            / ".cache/harbor"
            / "terminal-bench_terminal-bench-2_sha256:"
            "c6fc2e2382c1dbae99b2d5ecd2f4f4a60c3c01e0d84642d69b4afd92e99d078b"
            / "terminal-bench-2"
        ),
        "source": {
            "repository": "https://github.com/laude-institute/terminal-bench-datasets",
            "commit": "afbb742d222491967eea7f14e532abd481726a8c",
        },
    },
    "terminal-bench-2-1": {
        "package": (
            "terminal-bench/terminal-bench-2-1@"
            "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a"
        ),
        "cache": (
            Path.home()
            / ".cache/harbor"
            / "terminal-bench_terminal-bench-2-1_sha256:"
            "7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a"
            / "terminal-bench-2-1"
        ),
        "source": {
            "repository": "https://github.com/harbor-framework/terminal-bench-2-1",
            "commit": "ffccbe05ee73a9d59518217f294ad711bda39304",
        },
    },
}
RUNEBENCH = {
    "package": (
        "maxbittker/runebench@"
        "sha256:4bb3430af2ef3a320bd3dfeeab2447fbf9e0093452ad747997186a85a060de28"
    ),
    "cache": (
        Path.home()
        / ".cache/harbor"
        / "maxbittker_runebench_sha256:"
        "4bb3430af2ef3a320bd3dfeeab2447fbf9e0093452ad747997186a85a060de28"
        / "runebench"
    ),
    "source": {
        "repository": "https://github.com/MaxBittker/runebench",
        "commit": "826107d10f731eae4fd6b93bcd63d072d4346654",
    },
    "image_tag": "ghcr.io/maxbittker/rs-agent-benchmark:v37",
    "image": (
        "ghcr.io/maxbittker/rs-agent-benchmark@"
        "sha256:0961663ac1dc23d6cd00b88e79ff106cb1f0c7b7340659a914f96a8454124016"
    ),
    "image_manifest_digest": (
        "sha256:0961663ac1dc23d6cd00b88e79ff106cb1f0c7b7340659a914f96a8454124016"
    ),
    "image_config_digest": (
        "sha256:583556dc0adcc31d541629851f937bf72edd1386327f5ad46076c802fffaecb9"
    ),
    "workdir": "/app",
}


class RegistryClient:
    def __init__(self) -> None:
        self._tokens: dict[str, str] = {}

    def resolve(self, reference: str) -> dict[str, str]:
        repository, tag = reference.rsplit(":", 1)
        if "/" not in repository:
            repository = f"library/{repository}"
        token = self._tokens.get(repository)
        if token is None:
            query = urllib.parse.urlencode(
                {
                    "service": "registry.docker.io",
                    "scope": f"repository:{repository}:pull",
                }
            )
            token = self._json(f"https://auth.docker.io/token?{query}")["token"]
            self._tokens[repository] = token
        request = urllib.request.Request(
            f"https://registry-1.docker.io/v2/{repository}/manifests/{tag}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": (
                    "application/vnd.oci.image.index.v1+json,"
                    "application/vnd.docker.distribution.manifest.list.v2+json,"
                    "application/vnd.oci.image.manifest.v1+json,"
                    "application/vnd.docker.distribution.manifest.v2+json"
                ),
            },
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            manifest = json.load(response)
            digest = response.headers["Docker-Content-Digest"]
        if "manifests" in manifest:
            candidates = [
                item
                for item in manifest["manifests"]
                if item.get("platform", {}).get("os") == "linux"
                and item.get("platform", {}).get("architecture") == "amd64"
                and item.get("platform", {}).get("variant") in (None, "")
            ]
            if len(candidates) != 1:
                raise ValueError(f"{reference} has {len(candidates)} linux/amd64 manifests")
            digest = candidates[0]["digest"]
            request = urllib.request.Request(
                f"https://registry-1.docker.io/v2/{repository}/manifests/{digest}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": (
                        "application/vnd.oci.image.manifest.v1+json,"
                        "application/vnd.docker.distribution.manifest.v2+json"
                    ),
                },
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                manifest = json.load(response)
        config_digest = manifest["config"]["digest"]
        request = urllib.request.Request(
            f"https://registry-1.docker.io/v2/{repository}/blobs/{config_digest}",
            headers={"Authorization": f"Bearer {token}"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            config = json.load(response)
        workdir = config.get("config", {}).get("WorkingDir") or "/"
        return {
            "manifest_digest": digest,
            "config_digest": config_digest,
            "workdir": workdir,
        }

    @staticmethod
    def _json(url: str) -> dict[str, Any]:
        with urllib.request.urlopen(url, timeout=30) as response:
            return json.load(response)


def terminal_catalog(benchmark: str, workers: int) -> dict[str, Any]:
    spec = TERMINAL[benchmark]
    root = spec["cache"]
    if not root.is_dir():
        raise FileNotFoundError(f"Harbor cache is unavailable: {root}")
    definitions: list[tuple[Path, dict[str, Any]]] = []
    for task_toml in sorted(root.glob("*/task.toml")):
        value = tomllib.loads(task_toml.read_text(encoding="utf-8"))
        definitions.append((task_toml.parent, value))
    client = RegistryClient()
    pins: dict[str, dict[str, str] | Exception] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        pending = {
            pool.submit(client.resolve, value["environment"]["docker_image"]): path.name
            for path, value in definitions
        }
        for future in as_completed(pending):
            identifier = pending[future]
            try:
                pins[identifier] = future.result()
            except Exception as error:  # retained as typed incompatibility
                pins[identifier] = error

    tasks: list[dict[str, Any]] = []
    for task_dir, value in definitions:
        identifier = task_dir.name
        declared_image = value["environment"]["docker_image"]
        declared_workdir = value["environment"].get("workdir")
        pin = pins[identifier]
        reasons: list[dict[str, str]] = []
        if isinstance(pin, Exception):
            reasons.append(
                {
                    "code": "immutable_image_unresolved",
                    "detail": f"{type(pin).__name__}: {pin}",
                }
            )
            manifest_digest = config_digest = None
            workdir = declared_workdir
            image = None
        else:
            manifest_digest = pin["manifest_digest"]
            config_digest = pin["config_digest"]
            workdir = declared_workdir or pin["workdir"]
            image = f"{declared_image.rsplit(':', 1)[0]}@{manifest_digest}"
        if not isinstance(workdir, str) or not workdir.startswith("/"):
            reasons.append(
                {
                    "code": "absolute_workdir_unavailable",
                    "detail": f"resolved workdir is {workdir!r}",
                }
            )
        tasks.append(
            {
                "id": identifier,
                "upstream_name": value["task"]["name"],
                "task_toml_sha256": _sha256_file(task_dir / "task.toml"),
                "task_tree_sha256": _sha256_tree(task_dir),
                "declared_image": declared_image,
                "declared_workdir": declared_workdir,
                "image": image,
                "image_manifest_digest": manifest_digest,
                "image_config_digest": config_digest,
                "workdir": workdir,
                "compatible": not reasons,
                "incompatibility_reasons": reasons,
            }
        )
    return _catalog(
        benchmark,
        dataset={
            "package": spec["package"],
            "source": spec["source"],
            "task_count": len(tasks),
        },
        evaluator={
            "kind": "upstream-harbor",
            "version": "0.20.0",
            "reward_files": [
                "/logs/verifier/reward.json",
                "/logs/verifier/reward.txt",
            ],
        },
        smoke_subsets={
            "default": ["fix-git"],
            "fix-git": ["fix-git"],
            "multi-image": ["fix-git", "regex-log"],
        },
        tasks=tasks,
    )


def runebench_catalog() -> dict[str, Any]:
    root = RUNEBENCH["cache"]
    if not root.is_dir():
        raise FileNotFoundError(f"RuneBench Harbor cache is unavailable: {root}")
    tasks: list[dict[str, Any]] = []
    expected_ids: list[str] = []
    for task_toml in sorted(root.glob("*/task.toml")):
        task_dir = task_toml.parent
        identifier = task_dir.name
        value = tomllib.loads(task_toml.read_text(encoding="utf-8"))
        expected_ids.append(identifier)
        reasons: list[dict[str, str]] = []
        try:
            skill_slug, horizon = identifier.rsplit("-xp-", 1)
            duration_seconds = int(horizon.removesuffix("m")) * 60
        except (TypeError, ValueError):
            skill_slug = identifier
            duration_seconds = 0
            reasons.append(
                {
                    "code": "unsupported_task_shape",
                    "detail": "expected a <skill>-xp-<minutes>m task id",
                }
            )
        dockerfile = task_dir / "environment" / "Dockerfile"
        save = task_dir / "environment" / "agent.sav"
        instruction = task_dir / "instruction.md"
        verifier = task_dir / "tests" / "check_skill_xp.ts"
        test_script = task_dir / "tests" / "test.sh"
        missing = [
            path.relative_to(task_dir).as_posix()
            for path in (dockerfile, save, instruction, verifier, test_script)
            if not path.is_file()
        ]
        if missing:
            reasons.append(
                {
                    "code": "official_task_assets_missing",
                    "detail": ", ".join(missing),
                }
            )
            docker_text = ""
        else:
            docker_text = dockerfile.read_text(encoding="utf-8")
            expected_dockerfile = "\n".join(
                [
                    f"FROM {RUNEBENCH['image_tag']}",
                    "ENV SAMPLE_INTERVAL_MS=15000",
                    "ENV GATEWAY_URL=ws://localhost:7780",
                    f"ENV BENCHMARK_DURATION_SECS={duration_seconds}",
                    "COPY agent.sav /app/server/engine/data/players/main/agent.sav",
                    "",
                ]
            )
            if docker_text != expected_dockerfile:
                reasons.append(
                    {
                        "code": "unsupported_environment_dockerfile",
                        "detail": "the task thin image no longer matches the audited template",
                    }
                )
        environment = value.get("environment", {})
        source_memory_gb = environment.get("memory_mb", 0) / 1024
        treatment_memory_gb = 8.0
        if source_memory_gb != 4.0:
            reasons.append(
                {
                    "code": "unexpected_source_memory",
                    "detail": f"expected the pinned package's 4 GiB, found {source_memory_gb!r}",
                }
            )
        if environment.get("docker_image") is not None:
            reasons.append(
                {
                    "code": "unexpected_declared_image",
                    "detail": "the pinned task is expected to use an audited thin Dockerfile",
                }
            )
        if environment.get("workdir") is not None:
            reasons.append(
                {
                    "code": "unexpected_declared_workdir",
                    "detail": "the pinned task is expected to inherit /app from the base image",
                }
            )
        task_name = value.get("task", {}).get("name")
        if task_name != f"maxbittker/{identifier}":
            reasons.append(
                {
                    "code": "upstream_name_drift",
                    "detail": f"found {task_name!r}",
                }
            )
        tasks.append(
            {
                "id": identifier,
                "upstream_name": task_name,
                "skill": skill_slug.replace("-", " ").title(),
                "duration_seconds": duration_seconds,
                "sample_interval_ms": 15000,
                "source_memory_gb": source_memory_gb,
                "treatment_memory_gb": treatment_memory_gb,
                "task_toml_sha256": _sha256_file(task_toml),
                "task_tree_sha256": _sha256_tree(task_dir),
                "source_dockerfile_sha256": (
                    _sha256_file(dockerfile) if dockerfile.is_file() else None
                ),
                "save_sha256": _sha256_file(save) if save.is_file() else None,
                "instruction_sha256": (
                    _sha256_file(instruction) if instruction.is_file() else None
                ),
                "verifier_sha256": (
                    _sha256_file(verifier) if verifier.is_file() else None
                ),
                "test_script_sha256": (
                    _sha256_file(test_script) if test_script.is_file() else None
                ),
                "declared_image": None,
                "declared_workdir": None,
                "image": RUNEBENCH["image"],
                "image_manifest_digest": RUNEBENCH["image_manifest_digest"],
                "image_config_digest": RUNEBENCH["image_config_digest"],
                "workdir": RUNEBENCH["workdir"],
                "compatible": not reasons,
                "incompatibility_reasons": reasons,
            }
        )
    if len(expected_ids) != 32:
        raise ValueError(f"RuneBench dataset has {len(expected_ids)} tasks, expected 32")
    treatment = {
        "agencity-runebench-repl-v1": {
            "harness": "agencity-runebench",
            "source_repo": AGENCITY_SOURCE_REPO,
            "source_ref": AGENCITY_SOURCE_REF,
            "bun_version": "1.3.14",
            "bun_archive": BUN_ARCHIVE,
            "bun_archive_sha256": BUN_ARCHIVE_SHA256,
            "interface": "direct-rs-sdk-through-persistent-bun-console",
            "learning_modes": ["fresh", "within-run"],
            "cross_episode_learning": False,
            "source_memory_gb": 4,
            "treatment_memory_gb": 8,
            "memory_reason": (
                "The current upstream generator uses an 8 GiB hard cap after "
                "documented 4 GiB agent OOM failures; this treatment applies that "
                "runtime hardening to the pinned task package."
            ),
        },
        "harness-native": {
            "description": (
                "The original RuneBench MCP treatment. It is retained as the "
                "comparison protocol and is not executed by this Agencity taskset."
            )
        },
    }
    return _catalog(
        "runebench",
        dataset={
            "package": RUNEBENCH["package"],
            "source": RUNEBENCH["source"],
            "task_count": len(tasks),
        },
        evaluator={
            "kind": "upstream-harbor-runebench",
            "source_repository": RUNEBENCH["source"]["repository"],
            "source_commit": RUNEBENCH["source"]["commit"],
            "reward_files": [
                "/logs/verifier/reward.json",
                "/logs/verifier/reward.txt",
            ],
            "metric": "peak normalized real-game XP per minute over fixed 15-second windows",
        },
        smoke_subsets={
            "default": ["woodcutting-xp-15m"],
            "woodcutting": ["woodcutting-xp-15m"],
            "representative-15m": [
                "attack-xp-15m",
                "cooking-xp-15m",
                "mining-xp-15m",
                "woodcutting-xp-15m",
            ],
        },
        tasks=tasks,
        treatments=treatment,
        uses_harbor=True,
    )


def swe_catalog(evaluator: Path, workers: int) -> dict[str, Any]:
    from datasets import load_dataset

    rows = load_dataset(SWE_DATASET, revision=SWE_REVISION, split="test")
    by_id = {row["instance_id"]: row for row in rows}
    if len(by_id) != len(rows):
        raise ValueError("SWE-bench Pro dataset contains duplicate instance ids")
    client = RegistryClient()
    pins: dict[str, dict[str, str] | Exception] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        pending = {
            pool.submit(
                client.resolve, f"jefzda/sweap-images:{by_id[identifier]['dockerhub_tag']}"
            ): identifier
            for identifier in SWE_AUDITED_IDS
        }
        for future in as_completed(pending):
            identifier = pending[future]
            try:
                pins[identifier] = future.result()
            except Exception as error:
                pins[identifier] = error

    common_assets = {
        "entrypoint_sha256": _sha256_file(evaluator / "swe_bench_pro_eval.py"),
        "image_helper_sha256": _sha256_file(evaluator / "helper_code/image_uri.py"),
    }
    tasks: list[dict[str, Any]] = []
    for identifier in sorted(by_id):
        row = by_id[identifier]
        asset_paths = {
            "run_script_sha256": evaluator / "run_scripts" / identifier / "run_script.sh",
            "parser_sha256": evaluator / "run_scripts" / identifier / "parser.py",
            "base_dockerfile_sha256": (
                evaluator / "dockerfiles/base_dockerfile" / identifier / "Dockerfile"
            ),
            "instance_dockerfile_sha256": (
                evaluator
                / "dockerfiles/instance_dockerfile"
                / identifier
                / "Dockerfile"
            ),
        }
        reasons: list[dict[str, str]] = []
        known_incompatibility = SWE_KNOWN_INCOMPATIBILITIES.get(identifier)
        if known_incompatibility is not None:
            reasons.append(known_incompatibility)
        missing = [name for name, path in asset_paths.items() if not path.is_file()]
        if missing:
            reasons.append(
                {
                    "code": "official_evaluator_assets_missing",
                    "detail": ", ".join(missing),
                }
            )
        pin = pins.get(identifier)
        if identifier not in SWE_AUDITED_IDS:
            reasons.append(
                {
                    "code": "image_configuration_not_audited",
                    "detail": (
                        "the public row and official evaluator assets are pinned, but "
                        "the linux/amd64 image manifest/config pair has not been resolved"
                    ),
                }
            )
        elif isinstance(pin, Exception):
            reasons.append(
                {
                    "code": "immutable_image_unresolved",
                    "detail": f"{type(pin).__name__}: {pin}",
                }
            )
        manifest_digest = (
            pin["manifest_digest"] if isinstance(pin, dict) else None
        )
        config_digest = pin["config_digest"] if isinstance(pin, dict) else None
        workdir = pin["workdir"] if isinstance(pin, dict) else None
        if isinstance(pin, dict) and workdir != "/app":
            reasons.append(
                {
                    "code": "unexpected_image_workdir",
                    "detail": f"expected /app, found {workdir!r}",
                }
            )
        public = {field: row.get(field) for field in SWE_PUBLIC_FIELDS}
        tasks.append(
            {
                "id": identifier,
                "repository": row["repo"],
                "base_commit": row["base_commit"],
                "docker_tag": row["dockerhub_tag"],
                "public_selection_sha256": _json_digest(public),
                "image": (
                    f"jefzda/sweap-images@{manifest_digest}"
                    if manifest_digest is not None
                    else None
                ),
                "image_manifest_digest": manifest_digest,
                "image_config_digest": config_digest,
                "workdir": workdir,
                "evaluator_assets": {
                    name: _sha256_file(path) for name, path in asset_paths.items()
                    if path.is_file()
                },
                "compatible": not reasons,
                "incompatibility_reasons": reasons,
            }
        )
    compatible_ids = [task["id"] for task in tasks if task["compatible"]]
    return _catalog(
        "swe-bench-pro-public",
        dataset={
            "id": SWE_DATASET,
            "revision": SWE_REVISION,
            "task_count": len(tasks),
        },
        evaluator={
            "kind": "official-swe-bench-pro",
            "repository": SWE_EVALUATOR_REPOSITORY,
            "commit": SWE_EVALUATOR_COMMIT,
            "tree_sha256": SWE_EVALUATOR_TREE_SHA256,
            **common_assets,
        },
        smoke_subsets={
            "default": compatible_ids[:1],
            "qutebrowser": compatible_ids[:1],
        },
        tasks=tasks,
    )


def _catalog(
    benchmark: str,
    *,
    dataset: dict[str, Any],
    evaluator: dict[str, Any],
    smoke_subsets: dict[str, list[str]],
    tasks: list[dict[str, Any]],
    treatments: dict[str, Any] | None = None,
    uses_harbor: bool | None = None,
) -> dict[str, Any]:
    if uses_harbor is None:
        uses_harbor = benchmark.startswith("terminal-bench")
    return {
        "schema": "agencity.benchmark-catalog.v1",
        "benchmark": benchmark,
        "dataset": dataset,
        "evaluator": evaluator,
        "runtime": {
            "verifiers_version": "0.3.0",
            "harbor_version": "0.20.0" if uses_harbor else None,
            "docker_sdk_version": "7.2.0",
        },
        "treatments": treatments or {
            "agencity-portable": {
                "harness": "agencity-verifiers",
                "source_repo": AGENCITY_SOURCE_REPO,
                "source_ref": AGENCITY_SOURCE_REF,
                "bun_version": "1.3.14",
                "bun_archive": BUN_ARCHIVE,
                "bun_archive_sha256": BUN_ARCHIVE_SHA256,
            },
            "harness-native": {
                "description": (
                    "Benchmark setup and official scoring without Agencity-specific "
                    "workspace cleanup; the selected comparison harness owns its state."
                )
            },
        },
        "python_lock_sha256": _sha256_file(LOCK_PATH),
        "smoke_subsets": smoke_subsets,
        "tasks_sha256": task_entries_digest(tasks),
        "tasks": tasks,
    }


def _json_digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Build immutable benchmark catalogs.")
    parser.add_argument(
        "benchmark",
        choices=[
            "runebench",
            "terminal-bench-2",
            "terminal-bench-2-1",
            "swe-bench-pro-public",
        ],
    )
    parser.add_argument("--evaluator", type=Path)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.benchmark == "runebench":
        catalog = runebench_catalog()
    elif args.benchmark.startswith("terminal-bench"):
        catalog = terminal_catalog(args.benchmark, args.workers)
    else:
        evaluator = args.evaluator
        if evaluator is None:
            raise ValueError("--evaluator is required for SWE-bench Pro")
        commit = subprocess.run(
            ["git", "-C", str(evaluator), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if commit != SWE_EVALUATOR_COMMIT:
            raise ValueError(
                f"evaluator checkout is {commit!r}, expected {SWE_EVALUATOR_COMMIT}"
            )
        catalog = swe_catalog(evaluator, args.workers)
    encoded = json.dumps(catalog, indent=2, sort_keys=True) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(encoded, encoding="utf-8")
    print(
        json.dumps(
            {
                "benchmark": catalog["benchmark"],
                "tasks": len(catalog["tasks"]),
                "compatible": sum(
                    task["compatible"] for task in catalog["tasks"]
                ),
                "output": str(args.output),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()

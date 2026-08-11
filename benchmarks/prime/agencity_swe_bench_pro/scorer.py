"""Host-side official SWE-bench Pro scoring after agent runtime destruction."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any


EVALUATOR_REPOSITORY = "https://github.com/scaleapi/SWE-bench_Pro-os"
EVALUATOR_COMMIT = "ca10a60a5fcae51e6948ffe1485d4153d421e6c5"
EVALUATOR_TREE_SHA256 = "472a5ec338449cc18d4e2809d134814ede3d98349e9ea09babc3fe098348a830"
DOCKER_PLATFORM = "linux/amd64"
SCORER_TIMEOUT_SECONDS = 1800
_EVALUATOR_ROW_FIELDS = (
    "instance_id",
    "repo",
    "base_commit",
    "before_repo_set_cmd",
    "selected_test_files_to_run",
    "fail_to_pass",
    "pass_to_pass",
)


class OfficialEvaluatorError(RuntimeError):
    """The pinned official evaluator did not produce trustworthy evidence."""


@dataclass(frozen=True)
class OfficialScore:
    reward: float
    evidence: dict[str, Any]


def score_with_official_evaluator(
    patch: str,
    row: Mapping[str, Any],
    pin: Mapping[str, Any],
    *,
    trace_id: str,
    timeout_seconds: int = SCORER_TIMEOUT_SECONDS,
) -> OfficialScore:
    instance_id = _required_text(row, "instance_id")
    if pin.get("id") != instance_id or pin.get("compatible") is not True:
        raise OfficialEvaluatorError("SWE-bench Pro scorer received an incompatible pin")
    image = _required_text(pin, "image")
    manifest_digest = _required_text(pin, "image_manifest_digest")
    config_digest = _required_text(pin, "image_config_digest")
    if not image.endswith(f"@{manifest_digest}"):
        raise OfficialEvaluatorError("SWE-bench Pro immutable image pin is malformed")

    with tempfile.TemporaryDirectory(prefix="agencity-swe-pro-scorer-") as directory:
        root = Path(directory)
        evaluator = root / "evaluator"
        inputs = root / "inputs"
        outputs = root / "outputs"
        inputs.mkdir()
        outputs.mkdir()
        _checkout_evaluator(evaluator)
        _validate_evaluator_source(evaluator, pin)

        image_id = _ensure_pinned_image(image, {manifest_digest, config_digest})
        username = f"127.0.0.1:0/agencity-{_safe_token(trace_id)}"
        alias = _official_image_alias(
            username, instance_id, _required_text(row, "repo")
        )
        _run_checked(["docker", "tag", image, alias], "tag pinned scorer image")
        alias_id_before = _inspect_image_id(alias)
        if alias_id_before != image_id:
            _run_best_effort(["docker", "image", "rm", alias])
            raise OfficialEvaluatorError("Pinned scorer alias resolved to the wrong image")

        raw_sample = inputs / "sample.jsonl"
        patch_path = inputs / "patches.json"
        stdout_path = root / "evaluator.stdout"
        stderr_path = root / "evaluator.stderr"
        process: subprocess.CompletedProcess[bytes] | None = None
        run_error: BaseException | None = None
        alias_id_after: str | None = None
        cleanup_count = 0
        try:
            _require_alias_pull_failure(alias, image_id)
            raw_sample.write_text(
                json.dumps(
                    {name: row.get(name) for name in _EVALUATOR_ROW_FIELDS},
                    sort_keys=True,
                )
                + "\n",
                encoding="utf-8",
            )
            patch_path.write_text(
                json.dumps(
                    [
                        {
                            "instance_id": instance_id,
                            "model_patch": patch,
                            "prefix": "agencity",
                        }
                    ]
                ),
                encoding="utf-8",
            )
            command = [
                sys.executable,
                "swe_bench_pro_eval.py",
                "--raw_sample_path",
                str(raw_sample),
                "--patch_path",
                str(patch_path),
                "--output_dir",
                str(outputs),
                "--scripts_dir",
                str(evaluator / "run_scripts"),
                "--dockerhub_username",
                username,
                "--use_local_docker",
                "--docker_platform",
                DOCKER_PLATFORM,
                "--block_network",
                "--num_workers",
                "1",
                "--redo",
            ]
            process = _run_evaluator(
                command,
                evaluator,
                stdout_path,
                stderr_path,
                timeout_seconds,
            )
        except BaseException as error:
            run_error = error
        finally:
            alias_id_after = _inspect_optional_image_id(alias)
            cleanup_count = _remove_alias_containers(alias)
            _run_best_effort(["docker", "image", "rm", alias])

        if alias_id_after != image_id:
            raise OfficialEvaluatorError(
                "Temporary scorer alias changed or disappeared during evaluation"
            )
        if run_error is not None:
            raise run_error
        if process is None or process.returncode != 0:
            raise OfficialEvaluatorError(
                f"Official evaluator exited with {None if process is None else process.returncode}"
            )
        if _inspect_image_id(image) != image_id:
            raise OfficialEvaluatorError("Pinned scorer image changed during evaluation")
        if _inspect_optional_image_id(alias) is not None:
            raise OfficialEvaluatorError("Temporary scorer image alias was not removed")

        result_path = outputs / "eval_results.json"
        result_bytes = _read_bounded_file(result_path, 64 * 1024)
        result = validate_official_evaluator_evidence(
            json.loads(result_bytes.decode("utf-8")), instance_id
        )
        parsed_path = outputs / instance_id / "agencity_output.json"
        parsed_bytes = _read_bounded_file(parsed_path, 2 * 1024 * 1024)
        validate_official_parser_output(
            json.loads(parsed_bytes.decode("utf-8")),
            official_result=result,
        )

        evidence = {
            "schema": "agencity.swe-bench-pro-official-evidence.v2",
            "evaluator_commit": EVALUATOR_COMMIT,
            "evaluator_tree_sha256": EVALUATOR_TREE_SHA256,
            "image": image,
            "image_id": image_id,
            "image_manifest_digest": manifest_digest,
            "image_config_digest": config_digest,
            "alias_image_id_before": alias_id_before,
            "alias_image_id_after": alias_id_after,
            "agent_runtime_teardown_order": (
                "verifiers-owned-runtime-stop-requested-before-env-finalize"
            ),
            "network_blocked": True,
            "alias_pull_preflight": "failed_as_required",
            "official_result": result,
            "process_exit_code": process.returncode,
            "stdout": _file_evidence(stdout_path),
            "stderr": _file_evidence(stderr_path),
            "official_result_file": _bytes_evidence(result_bytes),
            "official_parser_file": _bytes_evidence(parsed_bytes),
            "cleanup": {
                "temporary_alias_removed": True,
                "leftover_containers_removed": cleanup_count,
                "temporary_directory_removed_after_return": True,
            },
        }
        return OfficialScore(reward=float(result), evidence=evidence)


def validate_official_evaluator_evidence(value: object, instance_id: str) -> bool:
    if not isinstance(value, dict) or set(value) != {instance_id}:
        raise OfficialEvaluatorError(
            "SWE-bench Pro evaluator evidence must contain one selected instance"
        )
    result = value[instance_id]
    if type(result) is not bool:
        raise OfficialEvaluatorError("SWE-bench Pro evaluator result must be a boolean")
    return result


def validate_official_parser_output(
    value: object, *, official_result: bool | None = None
) -> None:
    if not isinstance(value, dict) or set(value) != {"tests"}:
        raise OfficialEvaluatorError("Official parser output has an invalid top-level shape")
    tests = value["tests"]
    if not isinstance(tests, list) or not tests:
        raise OfficialEvaluatorError("Official parser output contains no test evidence")
    for test in tests:
        if (
            not isinstance(test, dict)
            or set(test) != {"name", "status"}
            or not isinstance(test["name"], str)
            or not test["name"]
            or test["status"] not in {"PASSED", "FAILED", "SKIPPED", "ERROR"}
        ):
            raise OfficialEvaluatorError(
                "Official parser output contains malformed test evidence"
            )
    if official_result is True and any(
        test["status"] in {"FAILED", "ERROR"} for test in tests
    ):
        raise OfficialEvaluatorError(
            "Official pass result conflicts with failing parser evidence"
        )


def _checkout_evaluator(destination: Path) -> None:
    destination.mkdir()
    _run_checked(["git", "init", "-q", str(destination)], "initialize evaluator checkout")
    _run_checked(
        [
            "git",
            "-C",
            str(destination),
            "-c",
            "protocol.file.allow=never",
            "fetch",
            "--depth",
            "1",
            EVALUATOR_REPOSITORY,
            EVALUATOR_COMMIT,
        ],
        "fetch pinned evaluator",
    )
    _run_checked(
        ["git", "-C", str(destination), "checkout", "-q", "--detach", "FETCH_HEAD"],
        "checkout pinned evaluator",
    )
    commit = _run_checked(
        ["git", "-C", str(destination), "rev-parse", "HEAD"],
        "resolve evaluator commit",
    ).stdout.decode().strip()
    if commit != EVALUATOR_COMMIT:
        raise OfficialEvaluatorError("Evaluator checkout did not resolve the pinned commit")
    shutil.rmtree(destination / ".git")
    if _sha256_tree(destination) != EVALUATOR_TREE_SHA256:
        raise OfficialEvaluatorError("Evaluator checkout does not match its pinned tree")


def _validate_evaluator_source(root: Path, pin: Mapping[str, Any]) -> None:
    instance_id = _required_text(pin, "id")
    assets = pin.get("evaluator_assets")
    if not isinstance(assets, Mapping):
        raise OfficialEvaluatorError("SWE-bench Pro evaluator asset pins are unavailable")
    paths = {
        Path("run_scripts") / instance_id / "run_script.sh": "run_script_sha256",
        Path("run_scripts") / instance_id / "parser.py": "parser_sha256",
        Path("dockerfiles/base_dockerfile") / instance_id / "Dockerfile": (
            "base_dockerfile_sha256"
        ),
        Path("dockerfiles/instance_dockerfile") / instance_id / "Dockerfile": (
            "instance_dockerfile_sha256"
        ),
    }
    for relative, key in paths.items():
        if _sha256_file(root / relative) != assets.get(key):
            raise OfficialEvaluatorError(f"Pinned evaluator file drifted: {relative}")


def _ensure_pinned_image(image: str, expected_ids: set[str]) -> str:
    image_id = _inspect_optional_image_id(image)
    if image_id is None:
        _run_checked(
            ["docker", "pull", "--platform", DOCKER_PLATFORM, image],
            "pull pinned scorer image",
        )
        image_id = _inspect_image_id(image)
    if image_id not in expected_ids:
        raise OfficialEvaluatorError(
            f"Pinned scorer image ID mismatch: expected one of {sorted(expected_ids)}, "
            f"got {image_id}"
        )
    return image_id


def _official_image_alias(username: str, instance_id: str, repository: str) -> str:
    repo_base, repo_name = repository.lower().split("/")
    suffix = instance_id.removeprefix("instance_")
    tag = f"{repo_base}.{repo_name}-{suffix}"[:128]
    return f"{username}/sweap-images:{tag}"


def _require_alias_pull_failure(alias: str, expected_id: str) -> None:
    result = subprocess.run(
        ["docker", "pull", "--platform", DOCKER_PLATFORM, alias],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=15,
    )
    if result.returncode == 0:
        raise OfficialEvaluatorError(
            "Temporary scorer alias unexpectedly resolved through a registry"
        )
    if _inspect_image_id(alias) != expected_id:
        raise OfficialEvaluatorError(
            "Failed alias pull changed the pinned local scorer image"
        )


def _run_evaluator(
    command: list[str],
    cwd: Path,
    stdout_path: Path,
    stderr_path: Path,
    timeout_seconds: int,
) -> subprocess.CompletedProcess[bytes]:
    environment = {
        name: value
        for name, value in os.environ.items()
        if name
        in {
            "DOCKER_CERT_PATH",
            "DOCKER_CONTEXT",
            "DOCKER_HOST",
            "DOCKER_TLS_VERIFY",
            "HOME",
            "PATH",
            "TMPDIR",
        }
    }
    with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
        try:
            return subprocess.run(
                command,
                cwd=cwd,
                env=environment,
                stdout=stdout,
                stderr=stderr,
                check=False,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired as error:
            raise OfficialEvaluatorError(
                f"Official evaluator exceeded {timeout_seconds} seconds"
            ) from error


def _remove_alias_containers(alias: str) -> int:
    listed = _run_best_effort(["docker", "ps", "-aq", "--filter", f"ancestor={alias}"])
    if listed is None:
        return 0
    identifiers = listed.stdout.decode().split()
    if identifiers:
        _run_best_effort(["docker", "rm", "-f", *identifiers])
    return len(identifiers)


def _inspect_image_id(reference: str) -> str:
    result = _run_checked(
        ["docker", "image", "inspect", "--format", "{{.Id}}", reference],
        "inspect scorer image",
    )
    value = result.stdout.decode().strip()
    if not value.startswith("sha256:"):
        raise OfficialEvaluatorError(f"Image {reference!r} returned an invalid ID")
    return value


def _inspect_optional_image_id(reference: str) -> str | None:
    result = subprocess.run(
        ["docker", "image", "inspect", "--format", "{{.Id}}", reference],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.stdout.decode().strip() if result.returncode == 0 else None


def _run_checked(command: list[str], purpose: str) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.decode(errors="replace").strip()[-2000:]
        raise OfficialEvaluatorError(f"Failed to {purpose}: {detail}")
    return result


def _run_best_effort(command: list[str]) -> subprocess.CompletedProcess[bytes] | None:
    try:
        return subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError:
        return None


def _read_bounded_file(path: Path, maximum: int) -> bytes:
    if not path.is_file():
        raise OfficialEvaluatorError(f"Official evaluator did not create {path.name}")
    size = path.stat().st_size
    if size > maximum:
        raise OfficialEvaluatorError(
            f"Official evaluator file {path.name} exceeded {maximum} bytes"
        )
    return path.read_bytes()


def _file_evidence(path: Path) -> dict[str, Any]:
    return _bytes_evidence(path.read_bytes())


def _bytes_evidence(value: bytes) -> dict[str, Any]:
    return {"bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sha256_tree(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if ".git" in path.relative_to(root).parts:
            continue
        if not path.is_file() and not path.is_symlink():
            continue
        relative = path.relative_to(root).as_posix()
        payload = (
            os.readlink(path).encode("utf-8") if path.is_symlink() else path.read_bytes()
        )
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(payload)
    return digest.hexdigest()


def _required_text(value: Mapping[str, Any], name: str) -> str:
    item = value.get(name)
    if not isinstance(item, str) or not item.strip():
        raise OfficialEvaluatorError(f"SWE-bench Pro value has no usable {name}")
    return item


def _safe_token(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]


__all__ = [
    "EVALUATOR_COMMIT",
    "EVALUATOR_REPOSITORY",
    "EVALUATOR_TREE_SHA256",
    "OfficialEvaluatorError",
    "OfficialScore",
    "score_with_official_evaluator",
    "validate_official_evaluator_evidence",
    "validate_official_parser_output",
]

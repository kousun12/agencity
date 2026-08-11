from __future__ import annotations

import hashlib
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path


MAX_BUN_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_SOURCE_ARCHIVE_BYTES = 64 * 1024 * 1024
GIT_COMMAND_TIMEOUT_SECONDS = 120


@dataclass(frozen=True)
class PortableBootstrap:
    source_repo: str
    source_ref: str
    bun_url: str
    bun_sha256: str


def build_portable_bootstrap(config: PortableBootstrap) -> bytes:
    """Build a task-container-neutral bundle on the evaluator host.

    The target image receives a verified Bun executable and a source tree at the
    exact Git revision. Dependencies are installed later in the target image so
    platform-specific packages match that image rather than the evaluator host.
    """
    with tempfile.TemporaryDirectory(prefix="agencity-verifiers-") as temporary:
        root = Path(temporary)
        source = _checkout_source(config.source_repo, config.source_ref, root / "source")
        bun = _download_bun(config.bun_url, config.bun_sha256)
        return _archive_bootstrap(source, bun)


def _checkout_source(repo: str, revision: str, destination: Path) -> Path:
    if not _is_commit_sha(revision):
        raise ValueError("Agencity source_ref must be a full 40-character Git commit")
    if shutil.which("git") is None:
        raise RuntimeError("Portable Agencity setup requires Git on the evaluator host")
    _checked(["git", "init", str(destination)])
    _checked(["git", "-C", str(destination), "remote", "add", "origin", repo])
    _checked(
        [
            "git",
            "-c",
            "credential.helper=",
            "-C",
            str(destination),
            "fetch",
            "--depth",
            "1",
            "origin",
            revision,
        ]
    )
    _checked(["git", "-C", str(destination), "checkout", "--detach", "FETCH_HEAD"])
    resolved = _output(["git", "-C", str(destination), "rev-parse", "HEAD"])
    if resolved != revision:
        raise RuntimeError(
            "Agencity source checkout did not resolve the requested immutable revision"
        )
    return destination


def _download_bun(url: str, expected_sha256: str) -> bytes:
    archive = _read_url(url, MAX_BUN_ARCHIVE_BYTES)
    actual = hashlib.sha256(archive).hexdigest()
    if actual != expected_sha256:
        raise RuntimeError("Pinned Bun archive digest did not match")
    with zipfile.ZipFile(BytesIO(archive)) as bundle:
        candidates = [
            name
            for name in bundle.namelist()
            if name.endswith("/bun") and not name.endswith("/")
        ]
        if candidates != ["bun-linux-x64/bun"]:
            raise RuntimeError("Pinned Bun archive has an unexpected executable layout")
        info = bundle.getinfo(candidates[0])
        if info.file_size <= 0 or info.file_size > MAX_BUN_ARCHIVE_BYTES:
            raise RuntimeError("Pinned Bun executable has an invalid size")
        return bundle.read(info)


def _archive_bootstrap(source: Path, bun: bytes) -> bytes:
    source_size = sum(
        item.stat(follow_symlinks=False).st_size
        for item in source.rglob("*")
        if ".git" not in item.relative_to(source).parts and item.is_file()
    )
    if source_size > MAX_SOURCE_ARCHIVE_BYTES:
        raise RuntimeError("Portable Agencity source exceeds its bounded size")
    buffer = BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for item in sorted(source.iterdir()):
            if item.name == ".git":
                continue
            archive.add(item, arcname=f"agencity/{item.name}", recursive=True)
        info = tarfile.TarInfo("agencity/bin/bun")
        info.mode = 0o755
        info.size = len(bun)
        archive.addfile(info, BytesIO(bun))
    payload = buffer.getvalue()
    if len(payload) > MAX_SOURCE_ARCHIVE_BYTES + MAX_BUN_ARCHIVE_BYTES:
        raise RuntimeError("Portable Agencity bootstrap exceeds its bounded size")
    return payload


def _read_url(url: str, maximum: int) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as response:
        payload = response.read(maximum + 1)
    if len(payload) > maximum:
        raise RuntimeError("Pinned Bun archive exceeds its bounded size")
    return payload


def _checked(command: list[str]) -> None:
    result = _run(command)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()[-1000:]
        raise RuntimeError(f"Bootstrap command failed ({command[0]}): {detail}")


def _output(command: list[str]) -> str:
    result = _run(command)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()[-1000:]
        raise RuntimeError(f"Bootstrap command failed ({command[0]}): {detail}")
    return result.stdout.strip()


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=GIT_COMMAND_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(
            f"Bootstrap command timed out ({command[0]})"
        ) from error


def _is_commit_sha(value: str) -> bool:
    return len(value) == 40 and all(character in "0123456789abcdef" for character in value)

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

from agencity_verifiers.source import (
    AGENCITY_SOURCE_BRANCH,
    AGENCITY_SOURCE_REF,
    AGENCITY_SOURCE_REPO,
)


ROOT = Path(__file__).resolve().parent.parent
SOURCE_MODULE = ROOT / "agencity_verifiers" / "source.py"
CONFIGS = tuple(sorted((ROOT / "configs").glob("*.toml")))
CATALOGS = tuple(sorted((ROOT / "manifests").glob("*-catalog.json")))
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")


def resolve_remote_branch(repo: str, branch: str) -> str:
    completed = subprocess.run(
        ["git", "-c", "credential.helper=", "ls-remote", "--exit-code", repo, f"refs/heads/{branch}"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()[-1000:]
        raise RuntimeError(f"Could not resolve {repo} {branch}: {detail}")
    rows = [line.split() for line in completed.stdout.splitlines() if line.strip()]
    if len(rows) != 1 or len(rows[0]) != 2 or rows[0][1] != f"refs/heads/{branch}":
        raise RuntimeError(f"Remote {repo} returned an unexpected {branch} reference")
    revision = rows[0][0]
    require_commit(revision)
    return revision


def require_commit(revision: str) -> None:
    if COMMIT_PATTERN.fullmatch(revision) is None:
        raise ValueError("Agencity source revision must be a full lowercase Git commit")


def configured_revisions() -> dict[Path, str]:
    revisions: dict[Path, str] = {}
    source_text = SOURCE_MODULE.read_text(encoding="utf-8")
    source_match = re.search(r'^AGENCITY_SOURCE_REF = "([0-9a-f]{40})"$', source_text, re.MULTILINE)
    if source_match is None:
        raise RuntimeError(f"{SOURCE_MODULE} has no exact Agencity source pin")
    revisions[SOURCE_MODULE] = source_match.group(1)

    for path in CONFIGS:
        text = path.read_text(encoding="utf-8")
        if f'source_repo = "{AGENCITY_SOURCE_REPO}"' not in text:
            continue
        matches = re.findall(r'^source_ref = "([0-9a-f]{40})"$', text, re.MULTILINE)
        if len(matches) != 1:
            raise RuntimeError(f"{path} must contain exactly one Agencity source pin")
        revisions[path] = matches[0]

    for path in CATALOGS:
        value = json.loads(path.read_text(encoding="utf-8"))
        treatment = value.get("treatments", {}).get("agencity-portable")
        if not isinstance(treatment, dict) or treatment.get("source_repo") != AGENCITY_SOURCE_REPO:
            raise RuntimeError(f"{path} has no Agencity portable treatment")
        revision = treatment.get("source_ref")
        if not isinstance(revision, str):
            raise RuntimeError(f"{path} has no Agencity treatment source pin")
        require_commit(revision)
        revisions[path] = revision
    return revisions


def refresh(revision: str) -> int:
    require_commit(revision)
    changed = 0
    for path, current in configured_revisions().items():
        if current == revision:
            continue
        text = path.read_text(encoding="utf-8")
        if path == SOURCE_MODULE:
            updated = text.replace(
                f'AGENCITY_SOURCE_REF = "{current}"',
                f'AGENCITY_SOURCE_REF = "{revision}"',
            )
        elif path.suffix == ".toml":
            updated = text.replace(
                f'source_ref = "{current}"',
                f'source_ref = "{revision}"',
            )
        else:
            updated = text.replace(
                f'"source_ref": "{current}"',
                f'"source_ref": "{revision}"',
            )
        if updated == text:
            raise RuntimeError(f"Could not update Agencity source pin in {path}")
        write_atomic(path, updated)
        changed += 1
    return changed


def write_atomic(path: Path, value: str) -> None:
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        delete=False,
    ) as handle:
        handle.write(value)
        temporary = Path(handle.name)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Resolve Agencity remote main to an immutable commit and synchronize "
            "the benchmark configs and catalog treatment pins."
        )
    )
    parser.add_argument("--ref", help="Use an explicit full commit instead of resolving remote main")
    parser.add_argument("--check", action="store_true", help="Check pins without changing files")
    args = parser.parse_args()

    revision = args.ref or resolve_remote_branch(AGENCITY_SOURCE_REPO, AGENCITY_SOURCE_BRANCH)
    require_commit(revision)
    mismatches = {
        path: current
        for path, current in configured_revisions().items()
        if current != revision
    }
    if args.check:
        if mismatches:
            rendered = ", ".join(str(path.relative_to(ROOT)) for path in mismatches)
            raise SystemExit(f"Agencity benchmark source pins differ from {revision}: {rendered}")
        print(f"Agencity benchmark source pins match {revision}")
        return

    changed = refresh(revision)
    print(f"Agencity benchmark source pinned to {revision}; updated {changed} files")


if __name__ == "__main__":
    main()

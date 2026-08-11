from __future__ import annotations

import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class DistributionTests(unittest.TestCase):
    def test_sdist_excludes_local_evaluation_material(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                ["uv", "build", "--sdist", "--out-dir", directory],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=120,
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            archive_path = next(Path(directory).glob("*.tar.gz"))
            with tarfile.open(archive_path, "r:gz") as archive:
                names = archive.getnames()

        forbidden_parts = {".cache", ".venv", "dist", "outputs", "solution"}
        leaked = [
            name
            for name in names
            if forbidden_parts.intersection(Path(name).parts)
        ]
        self.assertEqual(leaked, [])
        self.assertTrue(
            any(name.endswith("/manifests/terminal-bench-2-fix-git.json") for name in names)
        )
        self.assertTrue(any(name.endswith("/uv.lock") for name in names))


if __name__ == "__main__":
    unittest.main()

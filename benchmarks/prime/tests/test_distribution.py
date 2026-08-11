from __future__ import annotations

import subprocess
import tarfile
import tempfile
import unittest
import zipfile
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
        self.assertTrue(
            any(
                name.endswith("/manifests/terminal-bench-2-1-fix-git.json")
                for name in names
            )
        )
        self.assertTrue(
            any(name.endswith("/manifests/swe-bench-pro-public-vuls.json") for name in names)
        )
        self.assertTrue(any(name.endswith("/uv.lock") for name in names))

    def test_wheel_contains_all_adapter_manifests_without_local_material(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                ["uv", "build", "--wheel", "--out-dir", directory],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=120,
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            wheel_path = next(Path(directory).glob("*.whl"))
            with zipfile.ZipFile(wheel_path) as archive:
                names = archive.namelist()

        self.assertIn("agencity_terminal_bench_2_1/data/manifest.json", names)
        self.assertIn("agencity_swe_bench_pro/data/manifest.json", names)
        self.assertIn("agencity_terminal_bench_2/data/uv.lock", names)
        self.assertFalse(
            any(
                part in {".cache", ".venv", "dist", "outputs", "solution"}
                for name in names
                for part in Path(name).parts
            )
        )


if __name__ == "__main__":
    unittest.main()

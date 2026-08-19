from __future__ import annotations

import os
import site
import subprocess
import sys
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
            any(name.endswith("/manifests/runebench-catalog.json") for name in names)
        )
        self.assertTrue(
            any(name.endswith("/manifests/terminal-bench-2-catalog.json") for name in names)
        )
        self.assertTrue(
            any(
                name.endswith("/manifests/terminal-bench-2-1-catalog.json")
                for name in names
            )
        )
        self.assertTrue(
            any(
                name.endswith("/manifests/swe-bench-pro-public-catalog.json")
                for name in names
            )
        )
        self.assertTrue(
            any(name.endswith("/manifests/oolong-yahoo-128k.json") for name in names)
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

        self.assertIn("agencity_runebench/data/catalog.json", names)
        self.assertIn("agencity_terminal_bench_2/data/catalog.json", names)
        self.assertIn("agencity_terminal_bench_2_1/data/catalog.json", names)
        self.assertIn("agencity_swe_bench_pro/data/catalog.json", names)
        self.assertIn("agencity_oolong_synth/data/selection.json", names)
        self.assertIn("agencity_swe_bench_pro/scorer.py", names)
        self.assertIn("agencity_verifiers/selection.py", names)
        self.assertIn("agencity_verifiers/reporting.py", names)
        self.assertIn("agencity_terminal_bench_2/data/uv.lock", names)
        self.assertFalse(any(name.endswith("/run_script.sh") for name in names))
        self.assertFalse(any(name.endswith("/parser.py") for name in names))
        self.assertFalse(
            any(
                part in {".cache", ".venv", "dist", "outputs", "solution"}
                for name in names
                for part in Path(name).parts
            )
        )

    def test_wheel_and_sdist_install_and_load_outside_source_tree(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build = subprocess.run(
                ["uv", "build", "--out-dir", str(root / "dist")],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=120,
            )
            self.assertEqual(build.returncode, 0, build.stderr or build.stdout)
            artifacts = [
                next((root / "dist").glob("*.whl")),
                next((root / "dist").glob("*.tar.gz")),
            ]
            for index, artifact in enumerate(artifacts):
                with self.subTest(artifact=artifact.name):
                    environment = root / f"venv-{index}"
                    created = subprocess.run(
                        [
                            sys.executable,
                            "-m",
                            "venv",
                            "--system-site-packages",
                            str(environment),
                        ],
                        capture_output=True,
                        text=True,
                        timeout=120,
                    )
                    self.assertEqual(
                        created.returncode, 0, created.stderr or created.stdout
                    )
                    python = environment / "bin" / "python"
                    installed = subprocess.run(
                        [
                            str(python),
                            "-m",
                            "pip",
                            "install",
                            "--no-deps",
                            str(artifact),
                        ],
                        cwd=root,
                        capture_output=True,
                        text=True,
                        timeout=120,
                    )
                    self.assertEqual(
                        installed.returncode,
                        0,
                        installed.stderr or installed.stdout,
                    )
                    loaded = subprocess.run(
                        [
                            str(python),
                            "-c",
                            (
                                "from agencity_verifiers.selection import load_catalog;"
                                "from agencity_runebench.taskset import "
                                "CATALOG_PATH as RUNEBENCH_CATALOG;"
                                "from agencity_terminal_bench_2.taskset import "
                                "CATALOG_PATH;"
                                "from agencity_oolong_synth.taskset import "
                                "OolongSynthConfig,SELECTION_MANIFEST_ID,"
                                "SELECTION_MANIFEST_PATH,SELECTION_MANIFEST_SHA256;"
                                "c=load_catalog(CATALOG_PATH,'terminal-bench-2');"
                                "r=load_catalog(RUNEBENCH_CATALOG,'runebench');"
                                "assert len(c['tasks']) == 89;"
                                "assert len(r['tasks']) == 32;"
                                "assert SELECTION_MANIFEST_PATH.is_file();"
                                "OolongSynthConfig(id='oolong',"
                                "selection_manifest=SELECTION_MANIFEST_ID,"
                                "selection_manifest_sha256=SELECTION_MANIFEST_SHA256)"
                            ),
                        ],
                        cwd=root,
                        env={
                            **os.environ,
                            "PYTHONPATH": os.pathsep.join(site.getsitepackages()),
                        },
                        capture_output=True,
                        text=True,
                        timeout=120,
                    )
                    self.assertEqual(
                        loaded.returncode, 0, loaded.stderr or loaded.stdout
                    )


if __name__ == "__main__":
    unittest.main()

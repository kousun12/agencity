from __future__ import annotations

import copy
import tomllib
import unittest
from pathlib import Path

from agencity_terminal_bench_2.taskset import CATALOG_PATH
from agencity_verifiers.selection import load_catalog
from scripts.preflight_suite import _validate_catalog_pins, preflight


ROOT = Path(__file__).resolve().parent.parent


class SuitePreflightTests(unittest.TestCase):
    def test_full_catalog_configs_validate_without_loading_images(self) -> None:
        for name, expected in (
            ("terminal-bench-2-full.toml", 89),
            ("terminal-bench-2-1-full.toml", 89),
            ("swe-bench-pro-public-full.toml", 1),
        ):
            with self.subTest(config=name):
                manifest = preflight(ROOT / "configs" / name)
                self.assertEqual(manifest["selected_count"], expected)
                self.assertEqual(len(manifest["selected_pins"]), expected)

    def test_preflight_rejects_harness_pin_drift(self) -> None:
        config_path = ROOT / "configs" / "terminal-bench-2-full.toml"
        raw = tomllib.loads(config_path.read_text(encoding="utf-8"))
        changed = copy.deepcopy(raw)
        changed["env"]["agent"]["harness"]["source_ref"] = "0" * 40
        catalog = load_catalog(CATALOG_PATH, "terminal-bench-2")
        with self.assertRaisesRegex(ValueError, "do not match"):
            _validate_catalog_pins(changed, catalog)


if __name__ == "__main__":
    unittest.main()

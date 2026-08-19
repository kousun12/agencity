from __future__ import annotations

import copy
import json
import tomllib
import unittest
from pathlib import Path

from agencity_terminal_bench_2.taskset import CATALOG_PATH
from agencity_verifiers.evaluation_policy import (
    EVALUATION_CLIENT_API_KEY_VAR,
    EVALUATION_CLIENT_BASE_URL,
    EVALUATION_CLIENT_TYPE,
    EVALUATION_MIN_MAX_TURNS,
    EVALUATION_MAX_INPUT_TOKENS,
    EVALUATION_MAX_OUTPUT_TOKENS,
    EVALUATION_MAX_RESPONSE_TOKENS,
    EVALUATION_MAX_TOTAL_TOKENS,
    EVALUATION_REASONING_EFFORT,
)
from agencity_verifiers.harness import AgencityHarnessConfig
from agencity_verifiers.selection import load_catalog
from agencity_verifiers.source import AGENCITY_SOURCE_REF, AGENCITY_SOURCE_REPO
from scripts.preflight_suite import (
    _validate_catalog_pins,
    _validate_official_task_timeouts,
    preflight,
)


ROOT = Path(__file__).resolve().parent.parent


class SuitePreflightTests(unittest.TestCase):
    def test_configs_and_catalogs_share_the_canonical_agencity_source_pin(self) -> None:
        harness_config = AgencityHarnessConfig(id="agencity-verifiers")
        self.assertEqual(harness_config.source_ref, AGENCITY_SOURCE_REF)
        self.assertEqual(harness_config.source_repo, AGENCITY_SOURCE_REPO)
        self.assertEqual(len(AGENCITY_SOURCE_REF), 40)

        config_paths = sorted((ROOT / "configs").glob("*.toml"))
        self.assertTrue(config_paths)
        for path in config_paths:
            with self.subTest(config=path.name):
                harness = tomllib.loads(path.read_text(encoding="utf-8"))["env"]["agent"]["harness"]
                self.assertEqual(harness["source_repo"], AGENCITY_SOURCE_REPO)
                self.assertEqual(harness["source_ref"], AGENCITY_SOURCE_REF)

        catalog_paths = sorted((ROOT / "manifests").glob("*-catalog.json"))
        self.assertTrue(catalog_paths)
        for path in catalog_paths:
            with self.subTest(catalog=path.name):
                catalog = json.loads(path.read_text(encoding="utf-8"))
                treatment = catalog["treatments"]["agencity-portable"]
                self.assertEqual(treatment["source_repo"], AGENCITY_SOURCE_REPO)
                self.assertEqual(treatment["source_ref"], AGENCITY_SOURCE_REF)

    def test_configs_use_canonical_native_openai_and_high_token_policy(self) -> None:
        config_paths = sorted((ROOT / "configs").glob("*.toml"))
        self.assertTrue(config_paths)
        for path in config_paths:
            with self.subTest(config=path.name):
                config = tomllib.loads(path.read_text(encoding="utf-8"))
                self.assertNotIn("/", config["model"])
                self.assertEqual(
                    config["client"],
                    {
                        "type": EVALUATION_CLIENT_TYPE,
                        "base_url": EVALUATION_CLIENT_BASE_URL,
                        "api_key_var": EVALUATION_CLIENT_API_KEY_VAR,
                    },
                )
                self.assertEqual(
                    config["sampling"]["reasoning_effort"],
                    EVALUATION_REASONING_EFFORT,
                )
                self.assertNotIn("temperature", config["sampling"])
                self.assertEqual(
                    config["sampling"]["max_tokens"],
                    EVALUATION_MAX_RESPONSE_TOKENS,
                )
                agent = config["env"]["agent"]
                self.assertGreaterEqual(agent["max_turns"], EVALUATION_MIN_MAX_TURNS)
                self.assertEqual(agent["max_input_tokens"], EVALUATION_MAX_INPUT_TOKENS)
                self.assertEqual(agent["max_output_tokens"], EVALUATION_MAX_OUTPUT_TOKENS)
                self.assertEqual(agent["max_total_tokens"], EVALUATION_MAX_TOTAL_TOKENS)
                if config["env"]["taskset"]["id"] in {
                    "agencity-terminal-bench-2",
                    "agencity-terminal-bench-2-1",
                    "agencity-swe-bench-pro",
                }:
                    timeout = agent.get("timeout", {})
                    self.assertNotIn("rollout", timeout)
                    self.assertNotIn("scoring", timeout)

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

    def test_preflight_rejects_agent_overrides_of_official_task_timeouts(self) -> None:
        raw = tomllib.loads(
            (ROOT / "configs" / "terminal-bench-2-1-full.toml").read_text(
                encoding="utf-8"
            )
        )
        for stage in ("rollout", "scoring"):
            with self.subTest(stage=stage):
                changed = copy.deepcopy(raw)
                changed["env"]["agent"].setdefault("timeout", {})[stage] = 900
                with self.assertRaisesRegex(
                    ValueError, "official per-task timeouts remain authoritative"
                ):
                    _validate_official_task_timeouts(changed)


if __name__ == "__main__":
    unittest.main()

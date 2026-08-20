from __future__ import annotations

import json
import unittest
from types import SimpleNamespace

from agencity_verifiers.harness import (
    ADAPTER_DIAGNOSTIC_STREAM_BYTES,
    ARTIFACTS_DIR,
    HOME_DIR,
    STATE_DIR,
    AgencityHarness,
    AgencityHarnessConfig,
    _adapter_failure_diagnostics,
    _agencity_command,
    _agencity_model,
    _endpoint_origin,
    _provider_environment,
)
from agencity_verifiers.result import parse_run_result


def encoded_result(**updates: object) -> str:
    value: dict[str, object] = {
        "protocol": "agencity.run-result",
        "version": 1,
        "status": "succeeded",
        "exitCode": 0,
        "steps": 1,
        "final": "ok",
    }
    value.update(updates)
    return json.dumps(value)


class ResultTests(unittest.TestCase):
    def test_accepts_exact_success(self) -> None:
        result = parse_run_result(encoded_result(), 0)
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(result.final, "ok")

    def test_rejects_process_envelope_disagreement(self) -> None:
        with self.assertRaisesRegex(ValueError, "process and result"):
            parse_run_result(encoded_result(), 1)

    def test_rejects_extra_stdout(self) -> None:
        with self.assertRaisesRegex(ValueError, "exactly one"):
            parse_run_result(f"diagnostic\n{encoded_result()}", 0)

    def test_accepts_recognized_semantic_failure(self) -> None:
        result = parse_run_result(
            encoded_result(status="blocked", exitCode=4, final=None),
            4,
        )
        self.assertEqual(result.status, "blocked")
        expired = parse_run_result(
            encoded_result(
                status="budget_exceeded",
                exitCode=5,
                final=None,
            ),
            5,
        )
        self.assertEqual(expired.status, "budget_exceeded")

    def test_failure_diagnostics_are_bounded_and_scrub_known_secrets(self) -> None:
        secret = "intercept-secret-value"
        diagnostics = _adapter_failure_diagnostics(
            f"{secret}\n" + ("x" * (ADAPTER_DIAGNOSTIC_STREAM_BYTES * 2)),
            json.dumps({"error": secret}),
            2,
            secrets=[secret],
            parse_error=ValueError(f"invalid result near {secret}"),
        )
        self.assertEqual(diagnostics["schema"], "agencity.adapter-failure.v1")
        self.assertEqual(diagnostics["process_exit_code"], 2)
        stdout = diagnostics["stdout"]
        stderr = diagnostics["stderr"]
        self.assertEqual(stdout["completeness"], "truncated")
        self.assertLessEqual(
            len((stdout["head"] + stdout["tail"]).encode("utf-8")),
            ADAPTER_DIAGNOSTIC_STREAM_BYTES + 6,
        )
        self.assertNotIn(secret, json.dumps(diagnostics))
        self.assertIn("[REDACTED]", stderr["value"])


class SetupTests(unittest.IsolatedAsyncioTestCase):
    async def test_apt_git_setup_prepares_every_explicit_runtime_directory(self) -> None:
        commands: list[list[str]] = []

        class Runtime:
            async def run(self, command: list[str], environment: dict[str, str]):
                commands.append(command)
                return SimpleNamespace(exit_code=0, stdout="", stderr="")

        harness = AgencityHarness(AgencityHarnessConfig(id="agencity-verifiers"))
        await harness.setup(Runtime())
        self.assertIn(
            ["mkdir", "-p", "/app/workspace", STATE_DIR, ARTIFACTS_DIR, HOME_DIR],
            commands,
        )


class RoutingTests(unittest.TestCase):
    def test_places_untrusted_task_after_option_terminator(self) -> None:
        command = _agencity_command(
            "openai",
            "openai/gpt-5.6-luna",
            "provider-default",
            "--workspace=/tmp/escape",
        )
        self.assertEqual(command[-2:], ["--", "--workspace=/tmp/escape"])

    def test_passes_absolute_deadline_and_refinement_controls(self) -> None:
        command = _agencity_command(
            "openai",
            "openai/gpt-5.6-luna",
            "provider-default",
            "train",
            run_started_at="2026-08-19T00:00:00.000Z",
            run_deadline_at="2026-08-19T00:30:00.000Z",
            refinement_review_limit=1,
            refinement_evidence_required=1,
        )
        self.assertIn("--started-at", command)
        self.assertIn("--deadline-at", command)
        self.assertIn("--refinement-review-limit", command)
        self.assertIn("--refinement-evidence-required", command)
        self.assertEqual(command[-2:], ["--", "train"])

    def test_strips_only_root_v1_endpoint(self) -> None:
        self.assertEqual(
            _endpoint_origin("http://host.docker.internal:4312/v1"),
            "http://host.docker.internal:4312",
        )
        with self.assertRaises(ValueError):
            _endpoint_origin("http://localhost:4312/proxy/v1")

    def test_routes_only_direct_supported_namespaces(self) -> None:
        provider, environment = _provider_environment(
            "openai/gpt-5.4-mini",
            "http://localhost:4312",
            "intercept-secret",
        )
        self.assertEqual(provider, "openai")
        self.assertEqual(environment["OPENAI_BASE_URL"], "http://localhost:4312")
        self.assertEqual(environment["OPENAI_API_KEY"], "intercept-secret")
        native_provider, native_environment = _provider_environment(
            "gpt-5.6-sol",
            "http://localhost:4312",
            "intercept-secret",
        )
        self.assertEqual(native_provider, "openai")
        self.assertEqual(native_environment["OPENAI_API_KEY"], "intercept-secret")
        self.assertEqual(
            _agencity_model(native_provider, "gpt-5.6-sol"),
            "openai/gpt-5.6-sol",
        )
        with self.assertRaisesRegex(ValueError, "supports only"):
            _provider_environment(
                "deepseek/deepseek-v4-flash",
                "http://localhost:4312",
                "intercept-secret",
            )


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import json
import unittest

from agencity_verifiers.harness import (
    _agencity_command,
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


class RoutingTests(unittest.TestCase):
    def test_places_untrusted_task_after_option_terminator(self) -> None:
        command = _agencity_command(
            "openai",
            "openai/gpt-5.6-luna",
            "provider-default",
            "--workspace=/tmp/escape",
        )
        self.assertEqual(command[-2:], ["--", "--workspace=/tmp/escape"])

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
        with self.assertRaisesRegex(ValueError, "only openai"):
            _provider_environment(
                "deepseek/deepseek-v4-flash",
                "http://localhost:4312",
                "intercept-secret",
            )


if __name__ == "__main__":
    unittest.main()

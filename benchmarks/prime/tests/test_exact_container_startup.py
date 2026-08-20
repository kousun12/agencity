from __future__ import annotations

import json
import shutil
import subprocess
import tarfile
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from agencity_runebench.taskset import (
    CONTROLLER_SOURCE,
    RATE_COMMAND_TEMPLATE,
    render_completion_gate_source,
)


ROOT = Path(__file__).resolve().parents[3]
IMAGE = (
    "oven/bun@sha256:"
    "e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4"
)
RUNEBENCH_IMAGE = (
    "ghcr.io/maxbittker/rs-agent-benchmark@sha256:"
    "0961663ac1dc23d6cd00b88e79ff106cb1f0c7b7340659a914f96a8454124016"
)


class _ProviderHandler(BaseHTTPRequestHandler):
    requests: list[dict[str, object]] = []

    def do_GET(self) -> None:
        if self.path != "/v1/models":
            self.send_error(404)
            return
        self._json(
            {
                "data": [
                    {
                        "id": "openai/gpt-5.6-sol",
                        "name": "GPT-5.6 Sol fixture",
                        "type": "language",
                        "context_window": 400_000,
                        "max_tokens": 16_384,
                        "pricing": {"input": "0", "output": "0"},
                        "tags": ["tools", "reasoning"],
                        "reasoning_options": [
                            {"type": "effort", "values": ["high"]}
                        ],
                    }
                ]
            }
        )

    def do_POST(self) -> None:
        if self.path not in {"/v1/chat/completions", "/v1/responses"}:
            self.send_error(404)
            return
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length))
        type(self).requests.append(body)
        arguments = json.dumps(
            {"outcome": {"message": "exact container startup passed"}},
            separators=(",", ":"),
        )
        model = body.get("model", "gpt-5.6-sol")
        if self.path == "/v1/responses":
            self._responses(model, arguments, body.get("stream") is True)
            return
        if body.get("stream") is not True:
            self._json(
                {
                    "id": "container-fixture",
                    "object": "chat.completion",
                    "created": 1,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": "container-fixture-tool",
                                        "type": "function",
                                        "function": {
                                            "name": "finish",
                                            "arguments": arguments,
                                        },
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 7,
                        "completion_tokens": 4,
                        "total_tokens": 11,
                    },
                }
            )
            return

        chunks = [
            {
                "id": "container-fixture",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "container-fixture-tool",
                                    "type": "function",
                                    "function": {
                                        "name": "finish",
                                        "arguments": arguments,
                                    },
                                }
                            ]
                        },
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": "container-fixture",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {},
                        "finish_reason": "tool_calls",
                    }
                ],
            },
            {
                "id": "container-fixture",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": model,
                "choices": [],
                "usage": {
                    "prompt_tokens": 7,
                    "completion_tokens": 4,
                    "total_tokens": 11,
                },
            },
        ]
        payload = "".join(
            f"data: {json.dumps(chunk, separators=(',', ':'))}\n\n"
            for chunk in chunks
        ) + "data: [DONE]\n\n"
        encoded = payload.encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _responses(self, model: object, arguments: str, streaming: bool) -> None:
        item = {
            "type": "function_call",
            "id": "container-fixture-item",
            "call_id": "container-fixture-tool",
            "name": "finish",
            "arguments": arguments,
            "status": "completed",
        }
        usage = {
            "input_tokens": 7,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens": 4,
            "output_tokens_details": {"reasoning_tokens": 0},
        }
        if not streaming:
            self._json(
                {
                    "id": "container-fixture",
                    "created_at": 1,
                    "model": model,
                    "output": [item],
                    "incomplete_details": None,
                    "usage": usage,
                }
            )
            return
        events = [
            {
                "type": "response.created",
                "response": {
                    "id": "container-fixture",
                    "created_at": 1,
                    "model": model,
                    "service_tier": None,
                },
            },
            {
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {
                    "type": "function_call",
                    "id": "container-fixture-item",
                    "call_id": "container-fixture-tool",
                    "name": "finish",
                    "arguments": "",
                },
            },
            {
                "type": "response.function_call_arguments.delta",
                "item_id": "container-fixture-item",
                "output_index": 0,
                "delta": arguments,
            },
            {
                "type": "response.output_item.done",
                "output_index": 0,
                "item": item,
            },
            {
                "type": "response.completed",
                "response": {
                    "incomplete_details": None,
                    "usage": usage,
                    "reasoning": None,
                    "service_tier": None,
                },
            },
        ]
        payload = "".join(
            f"data: {json.dumps(event, separators=(',', ':'))}\n\n"
            for event in events
        )
        encoded = payload.encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        return

    def _json(self, value: object) -> None:
        encoded = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


@unittest.skipUnless(shutil.which("docker"), "Docker is unavailable")
class ExactContainerStartupTests(unittest.TestCase):
    def test_current_checkout_starts_in_pinned_image_with_missing_state_directory(
        self,
    ) -> None:
        daemon = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            timeout=30,
        )
        if daemon.returncode != 0:
            self.skipTest("Docker daemon is unavailable")

        _ProviderHandler.requests = []
        server = ThreadingHTTPServer(("0.0.0.0", 0), _ProviderHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / "agencity-source.tgz"
                with tarfile.open(archive, "w:gz") as bundle:
                    bundle.add(ROOT / "package.json", arcname="package.json")
                    bundle.add(ROOT / "bun.lock", arcname="bun.lock")
                    bundle.add(ROOT / "src", arcname="src")
                command = [
                    "docker",
                    "run",
                    "--rm",
                    "--platform",
                    "linux/amd64",
                    "--add-host",
                    "host.docker.internal:host-gateway",
                    "-v",
                    f"{archive}:/tmp/agencity-source.tgz:ro",
                    IMAGE,
                    "sh",
                    "-lc",
                    (
                        "test \"$(uname -m)\" = x86_64 && "
                        "mkdir -p /opt/agencity /app/workspace /app/.agencity-eval && "
                        "tar -xzf /tmp/agencity-source.tgz -C /opt/agencity && "
                        "cd /opt/agencity && "
                        "bun install --frozen-lockfile >/tmp/agencity-install.log 2>&1 && "
                        f"export OPENAI_BASE_URL=http://host.docker.internal:{server.server_port} "
                        f"AI_GATEWAY_BASE_URL=http://host.docker.internal:{server.server_port} "
                        "OPENAI_API_KEY=container-fixture-key "
                        "AGENCITY_PROFILE=/app/.agencity-eval/profile.db "
                        "HOME=/app/.agencity-eval/home NO_COLOR=1 && "
                        "result=\"$(bun run /opt/agencity/src/cli.ts run --new --json "
                        "--workspace /app/workspace "
                        "--state-dir /app/.agencity-eval/state "
                        "--artifacts /app/.agencity-eval/artifacts "
                        "--profile /app/.agencity-eval/profile.db "
                        "--console-rss-recycle-bytes 1610612736 "
                        "--model openai:openai/gpt-5.6-sol --effort high -- "
                        "'exact container startup test')\" && "
                        "bun run /opt/agencity/src/cli.ts service shutdown --json "
                        "--workspace /app/workspace "
                        "--state-dir /app/.agencity-eval/state "
                        "--artifacts /app/.agencity-eval/artifacts "
                        "--profile /app/.agencity-eval/profile.db "
                        "--console-rss-recycle-bytes 1610612736 "
                        ">/tmp/agencity-shutdown.json && "
                        "lifecycle='' && i=0 && "
                        "while [ \"$i\" -lt 100 ]; do "
                        "status=\"$(bun run /opt/agencity/src/cli.ts service status --json "
                        "--workspace /app/workspace "
                        "--state-dir /app/.agencity-eval/state "
                        "--artifacts /app/.agencity-eval/artifacts "
                        "--profile /app/.agencity-eval/profile.db "
                        "--console-rss-recycle-bytes 1610612736)\" || exit 1; "
                        "lifecycle=\"$(STATUS=\"$status\" bun -e "
                        "'console.log(JSON.parse(process.env.STATUS).lifecycle)')\"; "
                        "[ \"$lifecycle\" = stopped ] && break; "
                        "i=$((i + 1)); sleep 0.1; "
                        "done && test \"$lifecycle\" = stopped && printf '%s\\n' \"$result\""
                    ),
                ]
                completed = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    timeout=240,
                )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

        self.assertEqual(
            completed.returncode,
            0,
            completed.stderr or completed.stdout,
        )
        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        self.assertEqual(len(lines), 1, completed.stdout)
        self.assertEqual(
            json.loads(lines[0]),
            {
                "protocol": "agencity.run-result",
                "version": 1,
                "status": "succeeded",
                "exitCode": 0,
                "steps": 1,
                "final": "exact container startup passed",
            },
        )
        self.assertEqual(len(_ProviderHandler.requests), 1)
        self.assertEqual(
            [
                tool.get("name") or tool.get("function", {}).get("name")
                for tool in _ProviderHandler.requests[0].get("tools", [])
            ],
            ["bun_console", "finish"],
        )


@unittest.skipUnless(shutil.which("docker"), "Docker is unavailable")
class ExactRuneBenchTreatmentTests(unittest.TestCase):
    def setUp(self) -> None:
        daemon = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            timeout=30,
        )
        if daemon.returncode != 0:
            self.skipTest("Docker daemon is unavailable")

    def test_controller_excludes_competitors_and_backs_off_false_results(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            controller = Path(directory) / "controller.ts"
            controller.write_text(CONTROLLER_SOURCE, encoding="utf-8")
            test_script = Path(directory) / "controller-test.ts"
            source = """
import {
  acquireControllerLease,
  runActionLoop,
} from "/app/agencity-runebench/controller.ts";
const first = await acquireControllerLease("first");
let blocked = false;
try {
  await acquireControllerLease("competitor");
} catch (error) {
  blocked = String(error).includes("RUNEBENCH_CONTROLLER_BUSY");
}
const started = Date.now();
const attempts = await runActionLoop({
  iterations: 2,
  minBackoffMs: 250,
  maxBackoffMs: 250,
  action: async () => ({ success: false, message: "No target found" }),
});
await first.release();
const successor = await acquireControllerLease("successor");
await successor.release();
console.log(JSON.stringify({
  blocked,
  elapsedMs: Date.now() - started,
  failures: attempts.filter((attempt) => !attempt.ok).length,
}));
"""
            test_script.write_text(source, encoding="utf-8")
            completed = subprocess.run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--platform",
                    "linux/amd64",
                    "--entrypoint",
                    "/bin/bash",
                    "-v",
                    f"{controller}:/app/agencity-runebench/controller.ts:ro",
                    "-v",
                    f"{test_script}:/tmp/controller-test.ts:ro",
                    RUNEBENCH_IMAGE,
                    "-lc",
                    "bun /tmp/controller-test.ts",
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
        self.assertEqual(
            completed.returncode,
            0,
            completed.stderr or completed.stdout,
        )
        result = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertTrue(result["blocked"])
        self.assertEqual(result["failures"], 2)
        self.assertGreaterEqual(result["elapsedMs"], 450)

    def test_documented_rate_command_reads_active_tracker_file(self) -> None:
        tracker = {
            "samples": [
                {"elapsedMs": 0, "skills": {"Woodcutting": {"xp": 0}}},
                {"elapsedMs": 15_000, "skills": {"Woodcutting": {"xp": 200_000}}},
            ]
        }
        with tempfile.TemporaryDirectory() as directory:
            tracking_file = Path(directory) / "skill_tracking.json"
            tracking_file.write_text(json.dumps(tracker), encoding="utf-8")
            completed = subprocess.run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--platform",
                    "linux/amd64",
                    "--entrypoint",
                    "/bin/bash",
                    "-v",
                    f"{tracking_file}:/logs/tracking/skill_tracking.json:ro",
                    RUNEBENCH_IMAGE,
                    "-lc",
                    RATE_COMMAND_TEMPLATE.format(skill="Woodcutting"),
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
        self.assertEqual(
            completed.returncode,
            0,
            completed.stderr or completed.stdout,
        )
        self.assertIn("Overall:          4,000 XP/min", completed.stdout)

    def test_completion_gate_rejects_zero_or_early_xp_and_accepts_near_horizon(
        self,
    ) -> None:
        source = render_completion_gate_source("Cooking", 120, 15_000)

        def execute(
            directory: str,
            samples: list[dict[str, object]],
        ) -> subprocess.CompletedProcess[str]:
            root = Path(directory)
            gate = root / "check-completion.ts"
            tracker = root / "skill_tracking.json"
            gate.write_text(source, encoding="utf-8")
            tracker.write_text(json.dumps({"samples": samples}), encoding="utf-8")
            return subprocess.run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--platform",
                    "linux/amd64",
                    "--entrypoint",
                    "/bin/bash",
                    "-v",
                    f"{gate}:/tmp/check-completion.ts:ro",
                    "-v",
                    f"{tracker}:/logs/tracking/skill_tracking.json:ro",
                    RUNEBENCH_IMAGE,
                    "-lc",
                    "bun /tmp/check-completion.ts",
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )

        with tempfile.TemporaryDirectory() as directory:
            zero = execute(
                directory,
                [
                    {"elapsedMs": 0, "skills": {"Cooking": {"xp": 0}}},
                    {"elapsedMs": 60_000, "skills": {"Cooking": {"xp": 0}}},
                ],
            )
            early = execute(
                directory,
                [
                    {"elapsedMs": 0, "skills": {"Cooking": {"xp": 0}}},
                    {"elapsedMs": 45_000, "skills": {"Cooking": {"xp": 25}}},
                ],
            )
            passing = execute(
                directory,
                [
                    {"elapsedMs": 0, "skills": {"Cooking": {"xp": 0}}},
                    {"elapsedMs": 60_000, "skills": {"Cooking": {"xp": 25}}},
                ],
            )

        self.assertNotEqual(zero.returncode, 0)
        self.assertIn("scored-skill XP has not increased", zero.stderr)
        self.assertNotEqual(early.returncode, 0)
        self.assertIn("not close enough to completion", early.stderr)
        self.assertEqual(
            passing.returncode,
            0,
            passing.stderr or passing.stdout,
        )
        evidence = json.loads(passing.stdout.strip().splitlines()[-1])
        self.assertTrue(evidence["passed"])
        self.assertEqual(evidence["evidence"]["xpDelta"], 25)


if __name__ == "__main__":
    unittest.main()

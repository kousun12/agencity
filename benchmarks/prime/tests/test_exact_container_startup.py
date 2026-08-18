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


ROOT = Path(__file__).resolve().parents[3]
IMAGE = (
    "oven/bun@sha256:"
    "e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4"
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
        if self.path != "/v1/chat/completions":
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
                        f"exec env OPENAI_BASE_URL=http://host.docker.internal:{server.server_port} "
                        f"AI_GATEWAY_BASE_URL=http://host.docker.internal:{server.server_port} "
                        "OPENAI_API_KEY=container-fixture-key "
                        "AGENCITY_PROFILE=/app/.agencity-eval/profile.db "
                        "HOME=/app/.agencity-eval/home NO_COLOR=1 "
                        "bun run /opt/agencity/src/cli.ts run --new --json "
                        "--workspace /app/workspace "
                        "--state-dir /app/.agencity-eval/state "
                        "--artifacts /app/.agencity-eval/artifacts "
                        "--profile /app/.agencity-eval/profile.db "
                        "--model openai:openai/gpt-5.6-sol --effort high -- "
                        "'exact container startup test'"
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
                tool.get("function", {}).get("name")
                for tool in _ProviderHandler.requests[0].get("tools", [])
            ],
            ["bun_console", "finish"],
        )


if __name__ == "__main__":
    unittest.main()

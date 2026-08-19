from __future__ import annotations

import os
import re
import tempfile
import tomllib
from pathlib import Path

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
    RUNEBENCH_MAX_TURNS,
    RUNEBENCH_TASKSET_ID,
)


ROOT = Path(__file__).resolve().parent.parent
CONFIGS = tuple(sorted((ROOT / "configs").glob("*.toml")))


def apply_policy(path: Path) -> bool:
    original = path.read_text(encoding="utf-8")
    value = tomllib.loads(original)
    if "env" not in value or "agent" not in value["env"]:
        raise RuntimeError(f"{path} has no evaluation agent configuration")
    is_runebench = value["env"].get("taskset", {}).get("id") == RUNEBENCH_TASKSET_ID

    updated = re.sub(
        r'(?m)^model = "openai/([^"]+)"$',
        r'model = "\1"',
        original,
        count=1,
    )
    updated = re.sub(r"(?m)^temperature = [^\n]+\n", "", updated)
    updated, turns_count = re.subn(
        r"(?m)^max_turns = (\d+)$",
        lambda match: (
            f"max_turns = {RUNEBENCH_MAX_TURNS}"
            if is_runebench
            else f"max_turns = {max(int(match.group(1)), EVALUATION_MIN_MAX_TURNS)}"
        ),
        updated,
    )
    if turns_count != 1:
        raise RuntimeError(f"{path} must contain exactly one max_turns value")
    updated, reasoning_count = re.subn(
        r'(?m)^reasoning_effort = "[^"]+"$',
        f'reasoning_effort = "{EVALUATION_REASONING_EFFORT}"',
        updated,
    )
    if reasoning_count == 0:
        updated = updated.replace(
            "[sampling]\n",
            f'[sampling]\nreasoning_effort = "{EVALUATION_REASONING_EFFORT}"\n',
            1,
        )
    elif reasoning_count != 1:
        raise RuntimeError(f"{path} must contain at most one reasoning_effort value")
    updated, response_count = re.subn(
        r"(?m)^max_tokens = \d+$",
        f"max_tokens = {EVALUATION_MAX_RESPONSE_TOKENS}",
        updated,
        count=1,
    )
    if response_count != 1:
        raise RuntimeError(f"{path} must contain one sampling max_tokens value")

    client = (
        "[client]\n"
        f'type = "{EVALUATION_CLIENT_TYPE}"\n'
        f'base_url = "{EVALUATION_CLIENT_BASE_URL}"\n'
        f'api_key_var = "{EVALUATION_CLIENT_API_KEY_VAR}"\n\n'
    )
    client_pattern = re.compile(r"(?ms)^\[client\]\n.*?(?=^\[)")
    if client_pattern.search(updated):
        updated = client_pattern.sub(client, updated, count=1)
    else:
        sampling_marker = "[sampling]\n"
        if sampling_marker not in updated:
            raise RuntimeError(f"{path} has no sampling configuration")
        updated = updated.replace(sampling_marker, client + sampling_marker, 1)

    agent_pattern = re.compile(r"(?ms)^\[env\.agent\]\n(.*?)(?=^\[)")
    match = agent_pattern.search(updated)
    if match is None:
        raise RuntimeError(f"{path} has no env.agent configuration")
    agent_lines = [
        line
        for line in match.group(1).splitlines()
        if not re.match(r"^max_(?:input|output|total)_tokens = \d+$", line)
    ]
    while agent_lines and not agent_lines[-1]:
        agent_lines.pop()
    if not is_runebench:
        agent_lines.extend(
            [
                f"max_input_tokens = {EVALUATION_MAX_INPUT_TOKENS}",
                f"max_output_tokens = {EVALUATION_MAX_OUTPUT_TOKENS}",
                f"max_total_tokens = {EVALUATION_MAX_TOTAL_TOKENS}",
            ]
        )
    agent_lines.extend(["", ""])
    updated = updated[: match.start(1)] + "\n".join(agent_lines) + updated[match.end(1) :]

    parsed = tomllib.loads(updated)
    sampling = parsed["sampling"]
    agent = parsed["env"]["agent"]
    if (
        not isinstance(parsed.get("model"), str)
        or "/" in parsed["model"]
        or "temperature" in parsed["sampling"]
        or parsed["client"]
        != {
            "type": EVALUATION_CLIENT_TYPE,
            "base_url": EVALUATION_CLIENT_BASE_URL,
            "api_key_var": EVALUATION_CLIENT_API_KEY_VAR,
        }
        or sampling.get("reasoning_effort") != EVALUATION_REASONING_EFFORT
        or sampling.get("max_tokens") != EVALUATION_MAX_RESPONSE_TOKENS
        or (
            agent.get("max_turns") != RUNEBENCH_MAX_TURNS
            if is_runebench
            else agent.get("max_turns", 0) < EVALUATION_MIN_MAX_TURNS
        )
        or (
            any(
                key in agent
                for key in (
                    "max_input_tokens",
                    "max_output_tokens",
                    "max_total_tokens",
                )
            )
            if is_runebench
            else (
                agent.get("max_input_tokens") != EVALUATION_MAX_INPUT_TOKENS
                or agent.get("max_output_tokens") != EVALUATION_MAX_OUTPUT_TOKENS
                or agent.get("max_total_tokens") != EVALUATION_MAX_TOTAL_TOKENS
            )
        )
    ):
        raise RuntimeError(f"{path} did not resolve to the canonical evaluation policy")

    if updated == original:
        return False
    write_atomic(path, updated)
    return True


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
    changed = sum(apply_policy(path) for path in CONFIGS)
    print(f"Applied canonical evaluation policy to {len(CONFIGS)} configs; updated {changed}")


if __name__ == "__main__":
    main()

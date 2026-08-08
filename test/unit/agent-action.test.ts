import { describe, expect, test } from "bun:test";
import {
  AGENT_ACTION_PROTOCOL,
  AGENT_ACTION_VERSION,
  MAX_AGENT_ACTION_BYTES,
  canonicalJsonByteLength,
  validateAgentActionValue,
} from "../../src/index.ts";

const valid = (extra: Record<string, unknown> = {}) => ({
  protocol: AGENT_ACTION_PROTOCOL,
  version: AGENT_ACTION_VERSION,
  type: "typescript",
  code: "return 1;",
  ...extra,
});

describe("agent action protocol", () => {
  test("accepts one strict canonical action value", () => {
    const value = valid();
    expect(validateAgentActionValue(value, { encodedBytes: canonicalJsonByteLength(value) })).toEqual({
      protocol: "agencity.agent-action",
      version: 1,
      type: "typescript",
      code: "return 1;",
    });
  });

  test.each([
    ["wrong protocol", valid({ protocol: "other" })],
    ["unsupported version", valid({ version: 2 })],
    ["unknown field", valid({ tool: "shell" })],
    ["missing executable source", { protocol: AGENT_ACTION_PROTOCOL, version: 1, type: "typescript" }],
    ["parallel tool shape", { protocol: AGENT_ACTION_PROTOCOL, version: 1, type: "shell", command: "touch owned" }],
    ["removed clarification", { protocol: AGENT_ACTION_PROTOCOL, version: 1, type: "clarification", question: "Which file?" }],
    ["removed permission", { protocol: AGENT_ACTION_PROTOCOL, version: 1, type: "permission", permission: "write", question: "Proceed?" }],
  ])("rejects %s", (_name, value) => {
    expect(() => validateAgentActionValue(value, { encodedBytes: canonicalJsonByteLength(value) })).toThrow();
  });

  test("rejects an action above the byte bound before schema admission", () => {
    const value = {
      protocol: AGENT_ACTION_PROTOCOL,
      version: AGENT_ACTION_VERSION,
      type: "final",
      content: "x".repeat(MAX_AGENT_ACTION_BYTES),
    };
    expect(canonicalJsonByteLength(value)).toBeGreaterThan(MAX_AGENT_ACTION_BYTES);
    expect(() => validateAgentActionValue(value, { encodedBytes: canonicalJsonByteLength(value) }))
      .toThrow(`exceeds ${MAX_AGENT_ACTION_BYTES} bytes`);
  });
});

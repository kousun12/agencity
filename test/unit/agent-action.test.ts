import { describe, expect, test } from "bun:test";
import {
  AGENT_ACTION_PROTOCOL,
  AGENT_ACTION_VERSION,
  MAX_AGENT_ACTION_BYTES,
  parseAgentAction,
} from "../../src/index.ts";

const valid = (extra: Record<string, unknown> = {}) => JSON.stringify({
  protocol: AGENT_ACTION_PROTOCOL,
  version: AGENT_ACTION_VERSION,
  type: "typescript",
  code: "return 1;",
  ...extra,
});

describe("agent action protocol", () => {
  test("accepts exactly one strict versioned JSON object", () => {
    expect(parseAgentAction(valid())).toEqual({
      protocol: "agencity.agent-action",
      version: 1,
      type: "typescript",
      code: "return 1;",
    });
  });

  test.each([
    ["markdown fence", `\`\`\`json\n${valid()}\n\`\`\``],
    ["leading prose", `execute this: ${valid()}`],
    ["trailing object", `${valid()}${valid()}`],
    ["wrong protocol", valid({ protocol: "other" })],
    ["unsupported version", valid({ version: 2 })],
    ["unknown field", valid({ tool: "shell" })],
    ["missing executable source", JSON.stringify({ protocol: AGENT_ACTION_PROTOCOL, version: 1, type: "typescript" })],
    ["parallel tool shape", JSON.stringify({ protocol: AGENT_ACTION_PROTOCOL, version: 1, type: "shell", command: "touch owned" })],
  ])("rejects %s", (_name, raw) => {
    expect(() => parseAgentAction(raw)).toThrow();
  });

  test("rejects a response above the byte bound before schema admission", () => {
    const raw = JSON.stringify({
      protocol: AGENT_ACTION_PROTOCOL,
      version: AGENT_ACTION_VERSION,
      type: "final",
      content: "x".repeat(MAX_AGENT_ACTION_BYTES),
    });
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(MAX_AGENT_ACTION_BYTES);
    expect(() => parseAgentAction(raw)).toThrow(`exceeds ${MAX_AGENT_ACTION_BYTES} bytes`);
  });
});

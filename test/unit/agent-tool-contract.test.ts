import { describe, expect, test } from "bun:test";
import {
  AGENT_ACTION_PROTOCOL,
  AGENT_ACTION_VERSION,
  AGENT_TOOL_CONTRACT,
  AGENT_TOOL_CONTRACT_DIGEST,
  AGENT_TOOL_CONTRACT_ID,
  AGENT_TOOL_CONTRACT_VERSION,
  AGENT_TOOL_NAMES,
  AGENT_TOOL_SELECTION_POLICY,
  AGENT_TOOL_SET,
  BUN_CONSOLE_INPUT_SCHEMA,
  BUN_CONSOLE_INPUT_SCHEMA_DIGEST,
  FINISH_INPUT_SCHEMA,
  FINISH_INPUT_SCHEMA_DIGEST,
  MAX_AGENT_ACTION_BYTES,
  MAX_AGENT_TOOL_INPUT_BYTES,
  agentActionFromToolSubmission,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  canonicalJsonStringify,
  validateAgentActionValue,
  validateAgentToolContract,
  validateAgentToolSubmissionValue,
  type AgentAction,
  type AgentToolSubmission,
} from "../../src/index.ts";

const submissions: readonly [string, AgentToolSubmission, AgentAction][] = [
  [
    "bun console",
    { name: "bun_console", input: { source: "const value: number = await Promise.resolve(1);\nvalue;" } },
    {
      protocol: AGENT_ACTION_PROTOCOL,
      version: AGENT_ACTION_VERSION,
      type: "typescript",
      code: "const value: number = await Promise.resolve(1);\nvalue;",
    },
  ],
  [
    "successful finish",
    { name: "finish", input: { outcome: { message: "Done." } } },
    {
      protocol: AGENT_ACTION_PROTOCOL,
      version: AGENT_ACTION_VERSION,
      type: "final",
      content: "Done.",
    },
  ],
  [
    "blocked finish",
    { name: "finish", input: { outcome: { status: "blocked", message: "Which account should I use?" } } },
    {
      protocol: AGENT_ACTION_PROTOCOL,
      version: AGENT_ACTION_VERSION,
      type: "blocked",
      reason: "Which account should I use?",
    },
  ],
  [
    "failed finish",
    { name: "finish", input: { outcome: { status: "failed", message: "Verification cannot complete safely." } } },
    {
      protocol: AGENT_ACTION_PROTOCOL,
      version: AGENT_ACTION_VERSION,
      type: "failed",
      error: "Verification cannot complete safely.",
    },
  ],
];

describe("formal agent tool contract", () => {
  test.each(submissions)("validates and converts the %s variant", (_name, submission, expected) => {
    const validated = validateAgentToolSubmissionValue(submission, {
      encodedBytes: canonicalJsonByteLength(submission.input),
    });
    expect(validated).toEqual(submission);
    expect(agentActionFromToolSubmission(validated)).toEqual(expected);
    expect(agentActionFromToolSubmission(validated)).toEqual(validateAgentActionValue(expected, {
      encodedBytes: canonicalJsonByteLength(expected),
    }));
  });

  test.each([
    ["unknown tool", { name: "shell", input: { source: "return 1;" } }],
    ["submission field", { name: "bun_console", input: { source: "return 1;" }, callId: "provider-call" }],
    ["console input field", { name: "bun_console", input: { source: "return 1;", command: "touch owned" } }],
    ["finish input field", { name: "finish", input: { outcome: { message: "Done." }, status: "blocked" } }],
    ["finish outcome field", { name: "finish", input: { outcome: { message: "Done.", note: "extra" } } }],
    ["explicit success status", { name: "finish", input: { outcome: { status: "success", message: "Done." } } }],
    ["missing blocked status", { name: "finish", input: { outcome: { status: null, message: "Blocked." } } }],
  ])("rejects %s", (_name, submission) => {
    expect(() => validateAgentToolSubmissionValue(submission, {
      encodedBytes: canonicalJsonByteLength(submission),
    })).toThrow("does not match agencity.agent-tools.v1");
  });

  test.each([
    ["empty source", { name: "bun_console", input: { source: "" } }],
    ["empty success message", { name: "finish", input: { outcome: { message: "" } } }],
    ["empty blocked message", { name: "finish", input: { outcome: { status: "blocked", message: "" } } }],
    ["empty failed message", { name: "finish", input: { outcome: { status: "failed", message: "" } } }],
  ])("rejects %s", (_name, submission) => {
    const input = (submission as { input: unknown }).input;
    expect(() => validateAgentToolSubmissionValue(submission, {
      encodedBytes: canonicalJsonByteLength(input),
    })).toThrow("does not match agencity.agent-tools.v1");
  });

  test("uses portable strict root-object schemas", () => {
    expect(BUN_CONSOLE_INPUT_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { source: { type: "string" } },
      required: ["source"],
    });
    expect(FINISH_INPUT_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["outcome"],
    });
    expect((FINISH_INPUT_SCHEMA as any).properties.outcome.anyOf).toHaveLength(2);
    assertEverySchemaObjectIsStrict(BUN_CONSOLE_INPUT_SCHEMA);
    assertEverySchemaObjectIsStrict(FINISH_INPUT_SCHEMA);
    expect(JSON.stringify([BUN_CONSOLE_INPUT_SCHEMA, FINISH_INPUT_SCHEMA])).not.toMatch(
      /minLength|maxLength|patternProperties|unevaluatedProperties/,
    );
  });

  test("pins tool order, identity, descriptions, schemas, and digests", () => {
    expect(AGENT_TOOL_CONTRACT_ID).toBe("agencity.agent-tools.v1");
    expect(AGENT_TOOL_CONTRACT_VERSION).toBe(1);
    expect(AGENT_TOOL_NAMES).toEqual(["bun_console", "finish"]);
    expect(AGENT_TOOL_SET.map((tool) => tool.name)).toEqual([...AGENT_TOOL_NAMES]);
    expect(AGENT_TOOL_SET[0].description).toStartWith("Propose one durable Agencity Bun console cell");
    expect(AGENT_TOOL_SET[1].description).toStartWith("End model-directed work");
    expect(AGENT_TOOL_SET[0].inputSchema).toBe(BUN_CONSOLE_INPUT_SCHEMA);
    expect(AGENT_TOOL_SET[1].inputSchema).toBe(FINISH_INPUT_SCHEMA);
    expect(BUN_CONSOLE_INPUT_SCHEMA_DIGEST)
      .toBe("sha256:6055c544e6d5dffaae127494d16501f8b3fedd2a8165a06dcc868f7793fc6e11");
    expect(FINISH_INPUT_SCHEMA_DIGEST)
      .toBe("sha256:d5370334b0cdcc02e436af3affd381fa6c9e4a5ce4a0955ec98c86cad84dda8d");
    expect(AGENT_TOOL_CONTRACT_DIGEST)
      .toBe("sha256:f48e13358eb94ffa133baaafd538f8975e3f407c7c5009ff8aac61910b2b6400");
    expect(validateAgentToolContract(AGENT_TOOL_CONTRACT)).toBe(AGENT_TOOL_CONTRACT);
  });

  test("deep-freezes immutable contract meaning", () => {
    expect(Object.isFrozen(AGENT_TOOL_CONTRACT)).toBe(true);
    expect(Object.isFrozen(AGENT_TOOL_CONTRACT.tools)).toBe(true);
    expect(Object.isFrozen(AGENT_TOOL_CONTRACT.tools[0])).toBe(true);
    expect(Object.isFrozen(AGENT_TOOL_CONTRACT.tools[0].inputSchema)).toBe(true);
    expect(Object.isFrozen((BUN_CONSOLE_INPUT_SCHEMA as any).properties)).toBe(true);
    expect(Object.isFrozen((FINISH_INPUT_SCHEMA as any).properties.outcome.anyOf)).toBe(true);
  });

  test.each([
    ["name", (value: any) => { value.tools[0].name = "typescript"; }],
    ["description", (value: any) => { value.tools[1].description += " Changed."; }],
    ["order", (value: any) => { value.tools.reverse(); }],
    ["schema", (value: any) => { value.tools[0].inputSchema.properties.source.type = "number"; }],
    ["schema digest", (value: any) => { value.tools[0].schemaDigest = value.tools[1].schemaDigest; }],
    ["contract digest", (value: any) => { value.contractDigest = `sha256:${"0".repeat(64)}`; }],
  ])("rejects tampered contract %s", (_name, mutate) => {
    const value = structuredClone(AGENT_TOOL_CONTRACT) as any;
    mutate(value);
    if (_name !== "contract digest") resignContract(value);
    expect(() => validateAgentToolContract(value)).toThrow();
  });

  test("accepts the exact formal and canonical bounds", () => {
    const emptyInputBytes = canonicalJsonByteLength({ source: "" });
    const submission = {
      name: "bun_console",
      input: { source: "x".repeat(MAX_AGENT_TOOL_INPUT_BYTES - emptyInputBytes) },
    } as const;
    expect(canonicalJsonByteLength(submission.input)).toBe(MAX_AGENT_TOOL_INPUT_BYTES);
    const validated = validateAgentToolSubmissionValue(submission, {
      encodedBytes: MAX_AGENT_TOOL_INPUT_BYTES,
    });
    const action = agentActionFromToolSubmission(validated);
    expect(canonicalJsonByteLength(action)).toBe(MAX_AGENT_ACTION_BYTES);
    expect(validateAgentActionValue(action, {
      encodedBytes: MAX_AGENT_ACTION_BYTES,
    })).toEqual(action);
  });

  test("rejects one byte over the formal and canonical bounds", () => {
    const emptyInputBytes = canonicalJsonByteLength({ source: "" });
    const oversizedSubmission = {
      name: "bun_console",
      input: { source: "x".repeat(MAX_AGENT_TOOL_INPUT_BYTES - emptyInputBytes + 1) },
    } as const;
    expect(canonicalJsonByteLength(oversizedSubmission.input)).toBe(MAX_AGENT_TOOL_INPUT_BYTES + 1);
    expect(() => validateAgentToolSubmissionValue(oversizedSubmission, {
      encodedBytes: MAX_AGENT_TOOL_INPUT_BYTES + 1,
    })).toThrow(`exceeds ${MAX_AGENT_TOOL_INPUT_BYTES} bytes`);

    const emptyAction: AgentAction = {
      protocol: AGENT_ACTION_PROTOCOL,
      version: AGENT_ACTION_VERSION,
      type: "typescript",
      code: "",
    };
    const oversizedAction = {
      ...emptyAction,
      code: "x".repeat(MAX_AGENT_ACTION_BYTES - canonicalJsonByteLength(emptyAction) + 1),
    };
    expect(canonicalJsonByteLength(oversizedAction)).toBe(MAX_AGENT_ACTION_BYTES + 1);
    expect(() => validateAgentActionValue(oversizedAction, {
      encodedBytes: MAX_AGENT_ACTION_BYTES + 1,
    })).toThrow(`exceeds ${MAX_AGENT_ACTION_BYTES} bytes`);
  });

  test("rejects invalid or understated encoded byte counts", () => {
    const submission = { name: "bun_console", input: { source: "return 1;" } } as const;
    const bytes = canonicalJsonByteLength(submission.input);
    expect(() => validateAgentToolSubmissionValue(submission, { encodedBytes: bytes - 1 }))
      .toThrow("smaller than its canonical JSON encoding");
    expect(() => validateAgentToolSubmissionValue(submission, { encodedBytes: -1 }))
      .toThrow("non-negative safe integer");

    const action = agentActionFromToolSubmission(submission);
    expect(() => validateAgentActionValue(action, {
      encodedBytes: canonicalJsonByteLength(action) - 1,
    })).toThrow("does not match its canonical JSON encoding");
  });

  test("provides stable canonical JSON and rejects non-JSON values", () => {
    const left = { z: [3, 2, 1], a: { y: true, x: null } };
    const right = { a: { x: null, y: true }, z: [3, 2, 1] };
    expect(canonicalJsonStringify(left)).toBe('{"a":{"x":null,"y":true},"z":[3,2,1]}');
    expect(canonicalJsonStringify(left)).toBe(canonicalJsonStringify(right));
    expect(canonicalJsonDigest(left)).toBe(canonicalJsonDigest(right));
    expect(canonicalJsonDigest({ z: [1, 2, 3], a: { x: null, y: true } }))
      .not.toBe(canonicalJsonDigest(left));
    expect(() => canonicalJsonStringify({ invalid: undefined })).toThrow();
    expect(() => canonicalJsonStringify({ invalid: Number.NaN })).toThrow();
    expect(() => canonicalJsonStringify(new Array(1))).toThrow();
    expect(() => canonicalJsonStringify(Object.assign([], { extra: true }))).toThrow();
    expect(() => canonicalJsonStringify({ [Symbol("invalid")]: true })).toThrow();
  });

  test("uses the formal tool-selection policy without asking for action JSON", () => {
    expect(AGENT_TOOL_SELECTION_POLICY).toContain("call exactly one provided tool");
    expect(AGENT_TOOL_SELECTION_POLICY).toContain("A successfully completed run always ends with finish");
    expect(AGENT_TOOL_SELECTION_POLICY).not.toContain("Return exactly one JSON object");
    expect(AGENT_TOOL_SELECTION_POLICY).not.toContain("Action JSON Schema");
  });
});

function assertEverySchemaObjectIsStrict(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value) && (value as Record<string, unknown>).type === "object") {
    expect((value as Record<string, unknown>).additionalProperties).toBe(false);
    expect(Array.isArray((value as Record<string, unknown>).required)).toBe(true);
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    assertEverySchemaObjectIsStrict(child);
  }
}

function resignContract(value: any): void {
  const { contractDigest: _digest, ...body } = value;
  value.contractDigest = canonicalJsonDigest(body);
}

import { z } from "zod";
import {
  AGENT_ACTION_PROTOCOL,
  AGENT_ACTION_VERSION,
  MAX_AGENT_ACTION_BYTES,
  validateAgentActionValue,
  type AgentAction,
} from "./agent-action.ts";
import { ValidationError } from "./errors.ts";
import {
  assertJsonValue,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  canonicalJsonStringify,
  type JsonValue,
  type Sha256Digest,
} from "./json.ts";

export const AGENT_TOOL_CONTRACT_ID = "agencity.agent-tools.v1" as const;
export const AGENT_TOOL_CONTRACT_VERSION = 1 as const;
export const AGENT_TOOL_SELECTION = "exactly-one-of" as const;
export const BUN_CONSOLE_TOOL_NAME = "bun_console" as const;
export const FINISH_TOOL_NAME = "finish" as const;

export const BUN_CONSOLE_TOOL_DESCRIPTION =
  "Propose one durable Agencity Bun console cell and continue the run. " +
  "Pass multiline JavaScript or TypeScript source without Markdown fences. " +
  "Use the injected SDK for every repository, shell, file, SQL, model, " +
  "agent, memory, skill, state, and artifact operation. The cell is an " +
  "async notebook body: top-level await is supported and the final " +
  "expression or explicit return becomes its bounded observation.";

export const FINISH_TOOL_DESCRIPTION =
  "End model-directed work. Omit status for normal successful completion, " +
  "and provide the final user-facing message. Use blocked only when a " +
  "specific external requirement or missing user information prevents " +
  "progress; ask any necessary question in the message. Use failed only " +
  "after reasonable recovery attempts have failed. Successful completion " +
  "remains subject to required Agencity completion gates.";

export interface BunConsoleInput {
  readonly source: string;
}

export type FinishOutcome =
  | { readonly message: string }
  | { readonly status: "blocked" | "failed"; readonly message: string };

export interface FinishInput {
  readonly outcome: FinishOutcome;
}

export type AgentToolName =
  | typeof BUN_CONSOLE_TOOL_NAME
  | typeof FINISH_TOOL_NAME;

export type AgentToolSubmission =
  | { readonly name: typeof BUN_CONSOLE_TOOL_NAME; readonly input: BunConsoleInput }
  | { readonly name: typeof FINISH_TOOL_NAME; readonly input: FinishInput };

export const BUN_CONSOLE_INPUT_SCHEMA: JsonValue = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string" },
  },
  required: ["source"],
});

export const FINISH_INPUT_SCHEMA: JsonValue = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            message: { type: "string" },
          },
          required: ["message"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["blocked", "failed"] },
            message: { type: "string" },
          },
          required: ["status", "message"],
        },
      ],
    },
  },
  required: ["outcome"],
});

export const BUN_CONSOLE_INPUT_SCHEMA_DIGEST =
  canonicalJsonDigest(BUN_CONSOLE_INPUT_SCHEMA);
export const FINISH_INPUT_SCHEMA_DIGEST =
  canonicalJsonDigest(FINISH_INPUT_SCHEMA);

export interface AgentToolDefinition<Name extends AgentToolName = AgentToolName> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: JsonValue;
  readonly schemaDigest: Sha256Digest;
}

export const AGENT_TOOL_NAMES: readonly [
  typeof BUN_CONSOLE_TOOL_NAME,
  typeof FINISH_TOOL_NAME,
] = Object.freeze([BUN_CONSOLE_TOOL_NAME, FINISH_TOOL_NAME]);

export const AGENT_TOOL_SET: readonly [
  AgentToolDefinition<typeof BUN_CONSOLE_TOOL_NAME>,
  AgentToolDefinition<typeof FINISH_TOOL_NAME>,
] = deepFreeze([
  {
    name: BUN_CONSOLE_TOOL_NAME,
    description: BUN_CONSOLE_TOOL_DESCRIPTION,
    inputSchema: BUN_CONSOLE_INPUT_SCHEMA,
    schemaDigest: BUN_CONSOLE_INPUT_SCHEMA_DIGEST,
  },
  {
    name: FINISH_TOOL_NAME,
    description: FINISH_TOOL_DESCRIPTION,
    inputSchema: FINISH_INPUT_SCHEMA,
    schemaDigest: FINISH_INPUT_SCHEMA_DIGEST,
  },
]);

const MAX_CANONICAL_ACTION_EXPANSION_BYTES = Math.max(
  canonicalJsonByteLength({
    protocol: AGENT_ACTION_PROTOCOL,
    version: AGENT_ACTION_VERSION,
    type: "typescript",
    code: "",
  }) - canonicalJsonByteLength({ source: "" }),
  canonicalJsonByteLength({
    protocol: AGENT_ACTION_PROTOCOL,
    version: AGENT_ACTION_VERSION,
    type: "final",
    content: "",
  }) - canonicalJsonByteLength({ outcome: { message: "" } }),
  canonicalJsonByteLength({
    protocol: AGENT_ACTION_PROTOCOL,
    version: AGENT_ACTION_VERSION,
    type: "blocked",
    reason: "",
  }) - canonicalJsonByteLength({ outcome: { status: "blocked", message: "" } }),
  canonicalJsonByteLength({
    protocol: AGENT_ACTION_PROTOCOL,
    version: AGENT_ACTION_VERSION,
    type: "failed",
    error: "",
  }) - canonicalJsonByteLength({ outcome: { status: "failed", message: "" } }),
);

/**
 * Bounds the selected tool's encoded input while reserving enough room for
 * host-owned canonical action fields.
 */
export const MAX_AGENT_TOOL_INPUT_BYTES =
  MAX_AGENT_ACTION_BYTES - MAX_CANONICAL_ACTION_EXPANSION_BYTES;

export interface AgentToolContractBody {
  readonly contractId: typeof AGENT_TOOL_CONTRACT_ID;
  readonly version: typeof AGENT_TOOL_CONTRACT_VERSION;
  readonly actionProtocol: typeof AGENT_ACTION_PROTOCOL;
  readonly actionVersion: typeof AGENT_ACTION_VERSION;
  readonly selection: typeof AGENT_TOOL_SELECTION;
  readonly inputByteLimit: typeof MAX_AGENT_TOOL_INPUT_BYTES;
  readonly canonicalActionByteLimit: typeof MAX_AGENT_ACTION_BYTES;
  readonly tools: typeof AGENT_TOOL_SET;
}

export interface AgentToolContract extends AgentToolContractBody {
  readonly contractDigest: Sha256Digest;
}

const AGENT_TOOL_CONTRACT_BODY: AgentToolContractBody = deepFreeze({
  contractId: AGENT_TOOL_CONTRACT_ID,
  version: AGENT_TOOL_CONTRACT_VERSION,
  actionProtocol: AGENT_ACTION_PROTOCOL,
  actionVersion: AGENT_ACTION_VERSION,
  selection: AGENT_TOOL_SELECTION,
  inputByteLimit: MAX_AGENT_TOOL_INPUT_BYTES,
  canonicalActionByteLimit: MAX_AGENT_ACTION_BYTES,
  tools: AGENT_TOOL_SET,
});

export const AGENT_TOOL_CONTRACT: AgentToolContract = deepFreeze({
  ...AGENT_TOOL_CONTRACT_BODY,
  contractDigest: canonicalJsonDigest(AGENT_TOOL_CONTRACT_BODY),
});

export const AGENT_TOOL_CONTRACT_DIGEST = AGENT_TOOL_CONTRACT.contractDigest;

export const AGENT_TOOL_SELECTION_POLICY = [
  "On every step, call exactly one provided tool.",
  "",
  "Use bun_console for all repository work, shell commands, file operations,",
  "SQL queries, model calls, delegation, memory, skills, and other execution.",
  "Do not request additional provider tools.",
  "",
  "bun_console source may contain multiline Bun JavaScript or TypeScript syntax.",
  "Do not wrap source in Markdown fences or JSON. The source runs as an async",
  "notebook cell, so top-level await is supported. Its final expression becomes",
  "the observation unless it explicitly returns. Lexical variables do not survive",
  "the committed cell boundary; use state or artifacts for durable values.",
  "",
  "Use finish only when no further execution is required:",
  "- omit status for successful completion;",
  "- use blocked when an external requirement or missing user information prevents further progress;",
  "- use failed only after reasonable recovery attempts have failed.",
  "",
  "When missing information blocks progress, ask the necessary question in the finish message.",
  "A successfully completed run always ends with finish.",
  "A successful finish is provisional until required completion gates pass.",
  "A completed cell is not by itself task completion. Inspect results, repair failures, and verify work before finishing.",
].join("\n");

const bunConsoleInputSchema = z.object({
  source: z.string().min(1),
}).strict();

const successfulFinishInputSchema = z.object({
  outcome: z.object({
    message: z.string().min(1),
  }).strict(),
}).strict();

const nonSuccessfulFinishInputSchema = z.object({
  outcome: z.object({
    status: z.enum(["blocked", "failed"]),
    message: z.string().min(1),
  }).strict(),
}).strict();

const agentToolSubmissionSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.literal(BUN_CONSOLE_TOOL_NAME),
    input: bunConsoleInputSchema,
  }).strict(),
  z.object({
    name: z.literal(FINISH_TOOL_NAME),
    input: z.union([successfulFinishInputSchema, nonSuccessfulFinishInputSchema]),
  }).strict(),
]);

export function agentActionFromToolSubmission(
  submission: AgentToolSubmission,
): AgentAction {
  if (submission.name === BUN_CONSOLE_TOOL_NAME) {
    return {
      protocol: AGENT_ACTION_PROTOCOL,
      version: AGENT_ACTION_VERSION,
      type: "typescript",
      code: submission.input.source,
    };
  }
  const outcome = submission.input.outcome;
  if ("status" in outcome && outcome.status === "blocked") {
    return {
      protocol: AGENT_ACTION_PROTOCOL,
      version: AGENT_ACTION_VERSION,
      type: "blocked",
      reason: outcome.message,
    };
  }
  if ("status" in outcome && outcome.status === "failed") {
    return {
      protocol: AGENT_ACTION_PROTOCOL,
      version: AGENT_ACTION_VERSION,
      type: "failed",
      error: outcome.message,
    };
  }
  return {
    protocol: AGENT_ACTION_PROTOCOL,
    version: AGENT_ACTION_VERSION,
    type: "final",
    content: outcome.message,
  };
}

export function validateAgentToolSubmissionValue(
  value: unknown,
  options: { readonly encodedBytes: number },
): AgentToolSubmission {
  assertEncodedBytes(options.encodedBytes, MAX_AGENT_TOOL_INPUT_BYTES, "Agent tool input");
  assertJsonValue(value);
  const parsed = agentToolSubmissionSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError("Agent tool submission does not match agencity.agent-tools.v1", {
      issues: parsed.error.issues,
    });
  }
  const submission = parsed.data as AgentToolSubmission;
  const canonicalInputBytes = canonicalJsonByteLength(submission.input);
  if (canonicalInputBytes > options.encodedBytes) {
    throw new ValidationError(
      "Agent tool input byte count is smaller than its canonical JSON encoding",
      { expectedAtLeast: canonicalInputBytes, received: options.encodedBytes },
    );
  }
  const action = agentActionFromToolSubmission(submission);
  validateAgentActionValue(action, {
    encodedBytes: canonicalJsonByteLength(action),
  });
  return submission;
}

export function validateAgentToolContract(value: unknown): AgentToolContract {
  assertJsonValue(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Agent tool contract must be an object");
  }
  const record = value as Record<string, JsonValue>;
  if (typeof record.contractDigest !== "string") {
    throw new ValidationError("Agent tool contract digest is missing");
  }
  const { contractDigest, ...body } = record;
  if (canonicalJsonDigest(body) !== contractDigest) {
    throw new ValidationError("Agent tool contract digest does not match its definition");
  }
  if (canonicalJsonStringify(value) !== canonicalJsonStringify(AGENT_TOOL_CONTRACT)) {
    throw new ValidationError("Agent tool contract does not match agencity.agent-tools.v1");
  }
  return AGENT_TOOL_CONTRACT;
}

function assertEncodedBytes(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${label} byte count must be a non-negative safe integer`);
  }
  if (value > maximum) {
    throw new ValidationError(`${label} exceeds ${maximum} bytes`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

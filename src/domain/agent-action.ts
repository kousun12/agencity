import { z } from "zod";
import { ValidationError } from "./errors.ts";
import { canonicalJsonByteLength, type JsonValue } from "./json.ts";

export const AGENT_ACTION_PROTOCOL = "agencity.agent-action" as const;
export const AGENT_ACTION_VERSION = 1 as const;
export const MAX_AGENT_ACTION_BYTES = 256 * 1024;

const header = {
  protocol: z.literal(AGENT_ACTION_PROTOCOL),
  version: z.literal(AGENT_ACTION_VERSION),
};
export const agentActionSchema = z.discriminatedUnion("type", [
  z.object({ ...header, type: z.literal("typescript"), code: z.string().min(1) }).strict(),
  z.object({ ...header, type: z.literal("final"), content: z.string().min(1) }).strict(),
  z.object({ ...header, type: z.literal("clarification"), question: z.string().min(1) }).strict(),
  z.object({ ...header, type: z.literal("permission"), permission: z.string().min(1), question: z.string().min(1) }).strict(),
  z.object({ ...header, type: z.literal("blocked"), reason: z.string().min(1) }).strict(),
  z.object({ ...header, type: z.literal("failed"), error: z.string().min(1) }).strict(),
]);

export type AgentAction = z.infer<typeof agentActionSchema>;
export type AgentActionType = AgentAction["type"];

/** Transitional textual-action schema retained until the Phase 5 runtime cutover. */
export const AGENT_ACTION_JSON_SCHEMA: JsonValue = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Agencity agent action v1",
  oneOf: [
    actionObject("typescript", { code: { type: "string", minLength: 1 } }, ["code"]),
    actionObject("final", { content: { type: "string", minLength: 1 } }, ["content"]),
    actionObject("clarification", { question: { type: "string", minLength: 1 } }, ["question"]),
    actionObject("permission", { permission: { type: "string", minLength: 1 }, question: { type: "string", minLength: 1 } }, ["permission", "question"]),
    actionObject("blocked", { reason: { type: "string", minLength: 1 } }, ["reason"]),
    actionObject("failed", { error: { type: "string", minLength: 1 } }, ["error"]),
  ],
};

/** Transitional textual policy for the text-parsing AgentRun path retained until the Phase 5 runtime cutover. */
export const AGENT_ACTION_POLICY = [
  "Return exactly one JSON object matching agencity.agent-action version 1.",
  "Do not use Markdown fences, prose outside the object, comments, or unknown fields.",
  "The only executable action is type=typescript. Delegation, recursive models, shell, files, SQL, skills, and other tools are SDK operations inside that TypeScript cell; they are not parallel provider tools.",
  "Streamed deltas are display-only. Only the provider's authoritative final response is parsed or executed.",
].join(" ");

export function validateAgentActionValue(
  value: unknown,
  options: { readonly encodedBytes: number },
): AgentAction {
  if (!Number.isSafeInteger(options.encodedBytes) || options.encodedBytes < 0) {
    throw new ValidationError("Agent action encoded byte count must be a non-negative safe integer");
  }
  if (options.encodedBytes > MAX_AGENT_ACTION_BYTES) {
    throw new ValidationError(`Agent action exceeds ${MAX_AGENT_ACTION_BYTES} bytes`);
  }
  const actualBytes = canonicalJsonByteLength(value);
  if (actualBytes > MAX_AGENT_ACTION_BYTES) {
    throw new ValidationError(`Agent action exceeds ${MAX_AGENT_ACTION_BYTES} bytes`);
  }
  if (actualBytes !== options.encodedBytes) {
    throw new ValidationError("Agent action encoded byte count does not match its canonical JSON encoding", {
      expected: actualBytes,
      received: options.encodedBytes,
    });
  }
  const parsed = agentActionSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError("Agent action does not match agencity.agent-action v1", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

/** Transitional parser retained only while the textual AgentRun path remains buildable. */
export function parseAgentAction(raw: string): AgentAction {
  if (typeof raw !== "string") throw new ValidationError("Agent action must be a JSON string");
  const bytes = new TextEncoder().encode(raw).byteLength;
  if (bytes === 0) throw new ValidationError("Agent action response is empty");
  if (bytes > MAX_AGENT_ACTION_BYTES) throw new ValidationError(`Agent action exceeds ${MAX_AGENT_ACTION_BYTES} bytes`);
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new ValidationError("Agent action must be exactly one JSON object with no fences or trailing content"); }
  const parsed = agentActionSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError("Agent action does not match agencity.agent-action v1", { issues: parsed.error.issues });
  return parsed.data;
}

function actionObject(type: AgentActionType, properties: Record<string, JsonValue>, required: string[]): JsonValue {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      protocol: { const: AGENT_ACTION_PROTOCOL },
      version: { const: AGENT_ACTION_VERSION },
      type: { const: type },
      ...properties,
    },
    required: ["protocol", "version", "type", ...required],
  };
}

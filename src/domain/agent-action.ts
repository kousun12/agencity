import { z } from "zod";
import { ValidationError } from "./errors.ts";
import { canonicalJsonByteLength } from "./json.ts";

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
  z.object({ ...header, type: z.literal("blocked"), reason: z.string().min(1) }).strict(),
  z.object({ ...header, type: z.literal("failed"), error: z.string().min(1) }).strict(),
]);

export type AgentAction = z.infer<typeof agentActionSchema>;
export type AgentActionType = AgentAction["type"];

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

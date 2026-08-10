import {
  EFFECTIVE_SYSTEM_PROMPT_CONTRACT_ID,
  ValidationError,
  sha256,
  type AgentInvocationProfilePin,
  type AgentProfileVersion,
  type InvocationPromptProvenance,
} from "../domain/index.ts";
import { IMMUTABLE_BASE_POLICY } from "./context.ts";

export interface PromptComponent {
  readonly id: string;
  readonly version: number;
  readonly text: string;
}

export interface ComposeAgentSystemPromptInput {
  readonly invocationKind: "agent-run" | "recursive-model";
  readonly invocationId: string;
  readonly profilePin: AgentInvocationProfilePin;
  readonly agentProfile: AgentProfileVersion;
  readonly responseContract: PromptComponent;
  readonly executionGuidance: PromptComponent;
}

export interface ComposedAgentSystemPrompt {
  readonly content: string;
  readonly provenance: InvocationPromptProvenance;
}

export function composeAgentSystemPrompt(input: ComposeAgentSystemPromptInput): ComposedAgentSystemPrompt {
  if (input.agentProfile.profileVersionId !== input.profilePin.profileVersionId ||
      input.agentProfile.promptDigest !== input.profilePin.agentPromptDigest ||
      input.agentProfile.promptContractId !== input.profilePin.promptContractId) {
    throw new ValidationError("Invocation profile pin does not match the retained agent profile");
  }
  const content = [
    IMMUTABLE_BASE_POLICY.text,
    input.agentProfile.exactAgentPrompt,
    input.responseContract.text,
    input.executionGuidance.text,
  ].join("\n\n");
  const provenance: InvocationPromptProvenance = Object.freeze({
    invocationKind: input.invocationKind,
    invocationId: input.invocationId,
    profileVersionId: input.profilePin.profileVersionId,
    agentPromptDigest: input.profilePin.agentPromptDigest,
    effectiveSystemPromptDigest: sha256(content),
    systemPromptContractId: EFFECTIVE_SYSTEM_PROMPT_CONTRACT_ID,
    components: Object.freeze({
      basePolicy: Object.freeze({
        componentId: IMMUTABLE_BASE_POLICY.id,
        version: IMMUTABLE_BASE_POLICY.version,
        digest: sha256(IMMUTABLE_BASE_POLICY.text),
      }),
      agentProfile: Object.freeze({
        componentId: input.agentProfile.profileVersionId,
        version: input.agentProfile.revision,
        digest: input.agentProfile.promptDigest,
      }),
      responseContract: Object.freeze({
        componentId: input.responseContract.id,
        version: input.responseContract.version,
        digest: sha256(input.responseContract.text),
      }),
      executionGuidance: Object.freeze({
        componentId: input.executionGuidance.id,
        version: input.executionGuidance.version,
        digest: sha256(input.executionGuidance.text),
      }),
    }),
  });
  return Object.freeze({ content, provenance });
}

export function withProviderSystemPrompt(context: unknown, systemPrompt: string): import("../domain/index.ts").JsonValue {
  const durable = context && typeof context === "object" && !Array.isArray(context)
    ? context as Record<string, import("../domain/index.ts").JsonValue>
    : {};
  const messages = Array.isArray(durable.messages)
    ? durable.messages.flatMap((message) => {
        if (!message || typeof message !== "object" || Array.isArray(message) ||
            !["system", "user", "assistant", "tool"].includes(String(message.role)) ||
            typeof message.content !== "string") return [];
        return message.role === "system"
          ? [{ ...message, role: "user", content: `DURABLE SYSTEM RECORD\n${message.content}` }]
          : [message];
      })
    : [];
  return JSON.parse(JSON.stringify({
    ...durable,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
  })) as import("../domain/index.ts").JsonValue;
}

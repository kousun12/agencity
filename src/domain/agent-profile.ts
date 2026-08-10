import { ValidationError } from "./errors.ts";

export const AGENT_PROFILE_PROMPT_CONTRACT_ID = "agencity.agent-profile.v1" as const;
export const EFFECTIVE_SYSTEM_PROMPT_CONTRACT_ID = "agencity.system-prompt.v1" as const;

export const AGENT_PROFILE_BOUNDS = Object.freeze({
  roleBytes: 128,
  purposeBytes: 1_024,
  instructionsBytes: 8_192,
  exactAgentPromptBytes: 9_512,
  encodedProfileBytes: 16_384,
  reasonBytes: 1_024,
  evidenceEventIds: 32,
});

export type AgentPrincipalReference =
  | { readonly kind: "user"; readonly profileId: string }
  | { readonly kind: "agent"; readonly sessionId: string; readonly branchId: string }
  | { readonly kind: "system"; readonly componentId: string; readonly version: number };

export interface AgentProfileInput {
  readonly role: string;
  readonly purpose: string;
  readonly instructions: string;
}

export interface AgentProfileVersion extends AgentProfileInput {
  readonly profileVersionId: string;
  readonly agentSessionId: string;
  readonly revision: number;
  readonly exactAgentPrompt: string;
  readonly promptContractId: typeof AGENT_PROFILE_PROMPT_CONTRACT_ID;
  readonly promptDigest: string;
  readonly createdBy: AgentPrincipalReference;
  readonly sourceSpecEntryId: string | null;
  readonly sourceSpecVersionId: string | null;
  readonly reason: string;
  readonly evidenceEventIds: readonly string[];
  readonly supersedesProfileVersionId: string | null;
  readonly restoresProfileVersionId: string | null;
  readonly sourceProposalId: string | null;
  readonly reviewDecisionId: string | null;
  readonly createdAt: string;
}

export interface AgentProfileAdmissionMetadata {
  readonly profileVersionId: string;
  readonly agentSessionId: string;
  readonly revision?: 1;
  readonly createdBy: AgentPrincipalReference;
  readonly sourceSpecEntryId?: string | null;
  readonly sourceSpecVersionId?: string | null;
  readonly reason: string;
  readonly createdAt: string;
}

export interface AgentInvocationProfilePin {
  readonly profileVersionId: string;
  readonly agentPromptDigest: string;
  readonly promptContractId: typeof AGENT_PROFILE_PROMPT_CONTRACT_ID;
}

export interface ImmutablePromptComponentReference {
  readonly componentId: string;
  readonly version: number;
  readonly digest: string;
}

export interface InvocationPromptProvenance {
  readonly invocationKind: "agent-run" | "recursive-model";
  readonly invocationId: string;
  readonly profileVersionId: string;
  readonly agentPromptDigest: string;
  readonly effectiveSystemPromptDigest: string;
  readonly systemPromptContractId: typeof EFFECTIVE_SYSTEM_PROMPT_CONTRACT_ID;
  readonly components: {
    readonly basePolicy: ImmutablePromptComponentReference;
    readonly agentProfile: ImmutablePromptComponentReference;
    readonly responseContract: ImmutablePromptComponentReference;
    readonly executionGuidance: ImmutablePromptComponentReference;
  };
}

export const SEALED_ROOT_AGENT_PROFILE: Readonly<AgentProfileInput> = Object.freeze({
  role: "Repository agent",
  purpose: "Advance user-directed work in this workspace.",
  instructions: [
    "- Work toward the user's requested outcome using attributable evidence.",
    "- Preserve unresolved risks and unknown external effects.",
    "- Delegate only when a bounded child task improves the result.",
  ].join("\n"),
});

export const SEALED_TASK_SPECIALIST_PROFILE: Readonly<AgentProfileInput> = Object.freeze({
  role: "Task specialist",
  purpose: "Complete the admitted task within its stated scope.",
  instructions: [
    "- Use only the admitted task, context, and available tools.",
    "- Return attributable evidence and unresolved outcomes.",
    "- Do not infer broader standing responsibility from this task.",
  ].join("\n"),
});

export function renderExactAgentPrompt(input: AgentProfileInput): string {
  const normalized = normalizeAgentProfileInput(input);
  const prompt = [
    `Role: ${normalized.role}`,
    `Purpose: ${normalized.purpose}`,
    "Instructions:",
    normalized.instructions,
  ].join("\n");
  assertUtf8Bound("exact agent prompt", prompt, AGENT_PROFILE_BOUNDS.exactAgentPromptBytes);
  return prompt;
}

export function materializeInitialAgentProfile(
  input: AgentProfileInput,
  metadata: AgentProfileAdmissionMetadata,
): AgentProfileVersion {
  const normalized = normalizeAgentProfileInput(input);
  assertPrincipal(metadata.createdBy);
  assertIdentifier("profileVersionId", metadata.profileVersionId);
  assertIdentifier("agentSessionId", metadata.agentSessionId);
  assertUtf8Bound("profile reason", normalizeText(metadata.reason), AGENT_PROFILE_BOUNDS.reasonBytes);
  if (!Number.isFinite(Date.parse(metadata.createdAt))) throw new ValidationError("Agent profile createdAt must be an ISO timestamp");
  if ((metadata.sourceSpecEntryId === null) !== (metadata.sourceSpecVersionId === null) ||
      (metadata.sourceSpecEntryId === undefined) !== (metadata.sourceSpecVersionId === undefined)) {
    throw new ValidationError("Agent profile specification provenance requires both entry and version IDs");
  }
  const exactAgentPrompt = renderExactAgentPrompt(normalized);
  const profile = Object.freeze({
    profileVersionId: metadata.profileVersionId,
    agentSessionId: metadata.agentSessionId,
    revision: 1,
    ...normalized,
    exactAgentPrompt,
    promptContractId: AGENT_PROFILE_PROMPT_CONTRACT_ID,
    promptDigest: sha256(exactAgentPrompt),
    createdBy: Object.freeze({ ...metadata.createdBy }),
    sourceSpecEntryId: metadata.sourceSpecEntryId ?? null,
    sourceSpecVersionId: metadata.sourceSpecVersionId ?? null,
    reason: normalizeText(metadata.reason),
    evidenceEventIds: Object.freeze([]),
    supersedesProfileVersionId: null,
    restoresProfileVersionId: null,
    sourceProposalId: null,
    reviewDecisionId: null,
    createdAt: metadata.createdAt,
  });
  return validateAgentProfileVersion(profile);
}

export function validateAgentProfileVersion(profile: AgentProfileVersion): AgentProfileVersion {
  const normalized = normalizeAgentProfileInput(profile);
  assertIdentifier("profileVersionId", profile.profileVersionId);
  assertIdentifier("agentSessionId", profile.agentSessionId);
  if (!Number.isSafeInteger(profile.revision) || profile.revision < 1) throw new ValidationError("Agent profile revision must be a positive integer");
  assertPrincipal(profile.createdBy);
  assertUtf8Bound("profile reason", profile.reason, AGENT_PROFILE_BOUNDS.reasonBytes);
  if (profile.evidenceEventIds.length > AGENT_PROFILE_BOUNDS.evidenceEventIds ||
      new Set(profile.evidenceEventIds).size !== profile.evidenceEventIds.length ||
      profile.evidenceEventIds.some((eventId) => !eventId || new TextEncoder().encode(eventId).byteLength > 256)) {
    throw new ValidationError(`Agent profile evidence must contain at most ${AGENT_PROFILE_BOUNDS.evidenceEventIds} distinct event IDs`);
  }
  if ((profile.sourceSpecEntryId === null) !== (profile.sourceSpecVersionId === null)) {
    throw new ValidationError("Agent profile specification provenance requires both entry and version IDs");
  }
  for (const [label, value] of [
    ["sourceSpecEntryId", profile.sourceSpecEntryId],
    ["sourceSpecVersionId", profile.sourceSpecVersionId],
    ["supersedesProfileVersionId", profile.supersedesProfileVersionId],
    ["restoresProfileVersionId", profile.restoresProfileVersionId],
    ["sourceProposalId", profile.sourceProposalId],
    ["reviewDecisionId", profile.reviewDecisionId],
  ] as const) if (value !== null) assertIdentifier(label, value);
  if (profile.revision === 1 && (profile.supersedesProfileVersionId !== null ||
      profile.restoresProfileVersionId !== null || profile.sourceProposalId !== null ||
      profile.reviewDecisionId !== null || profile.evidenceEventIds.length !== 0)) {
    throw new ValidationError("Initial agent profiles cannot claim revision-governance provenance");
  }
  if (profile.revision > 1 && profile.supersedesProfileVersionId === null) {
    throw new ValidationError("Later agent profile versions must identify the superseded version");
  }
  if ((profile.sourceProposalId === null) !== (profile.reviewDecisionId === null)) {
    throw new ValidationError("Agent profile proposal and review provenance must appear together");
  }
  const exact = renderExactAgentPrompt(normalized);
  if (profile.promptContractId !== AGENT_PROFILE_PROMPT_CONTRACT_ID ||
      profile.exactAgentPrompt !== exact ||
      profile.promptDigest !== sha256(exact)) {
    throw new ValidationError("Agent profile prompt rendering or digest is invalid");
  }
  if (!Number.isFinite(Date.parse(profile.createdAt))) throw new ValidationError("Agent profile createdAt must be an ISO timestamp");
  if (new TextEncoder().encode(JSON.stringify(profile)).byteLength > AGENT_PROFILE_BOUNDS.encodedProfileBytes) {
    throw new ValidationError(`Encoded agent profile exceeds ${AGENT_PROFILE_BOUNDS.encodedProfileBytes} UTF-8 bytes`);
  }
  return profile;
}

export function agentProfilePin(profile: AgentProfileVersion): AgentInvocationProfilePin {
  validateAgentProfileVersion(profile);
  return Object.freeze({
    profileVersionId: profile.profileVersionId,
    agentPromptDigest: profile.promptDigest,
    promptContractId: profile.promptContractId,
  });
}

export function sameAgentProfileAdmissionMeaning(
  profile: AgentProfileVersion,
  input: AgentProfileInput,
  expected: Pick<AgentProfileAdmissionMetadata, "agentSessionId" | "createdBy" | "sourceSpecEntryId" | "sourceSpecVersionId" | "reason">,
): boolean {
  const normalized = normalizeAgentProfileInput(input);
  return profile.agentSessionId === expected.agentSessionId &&
    profile.role === normalized.role &&
    profile.purpose === normalized.purpose &&
    profile.instructions === normalized.instructions &&
    Bun.deepEquals(profile.createdBy, expected.createdBy) &&
    profile.sourceSpecEntryId === (expected.sourceSpecEntryId ?? null) &&
    profile.sourceSpecVersionId === (expected.sourceSpecVersionId ?? null) &&
    profile.reason === normalizeText(expected.reason);
}

export function normalizeAgentProfileInput(input: AgentProfileInput): AgentProfileInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("Agent profile must be an object");
  const role = normalizeText(input.role);
  const purpose = normalizeText(input.purpose);
  const instructions = normalizeText(input.instructions);
  assertUtf8Bound("agent profile role", role, AGENT_PROFILE_BOUNDS.roleBytes);
  assertUtf8Bound("agent profile purpose", purpose, AGENT_PROFILE_BOUNDS.purposeBytes);
  assertUtf8Bound("agent profile instructions", instructions, AGENT_PROFILE_BOUNDS.instructionsBytes);
  return Object.freeze({ role, purpose, instructions });
}

export function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("Agent profile text fields must be strings");
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized || normalized.includes("\0")) throw new ValidationError("Agent profile text fields must be non-empty and contain no NUL bytes");
  return normalized;
}

function assertUtf8Bound(label: string, value: string, maximum: number): void {
  if (new TextEncoder().encode(value).byteLength > maximum) {
    throw new ValidationError(`${label} exceeds ${maximum} UTF-8 bytes`);
  }
}

function assertIdentifier(label: string, value: string): void {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || new TextEncoder().encode(value).byteLength > 256) {
    throw new ValidationError(`Agent profile ${label} must be a non-empty identifier`);
  }
}

function assertPrincipal(principal: AgentPrincipalReference): void {
  if (!principal || typeof principal !== "object") throw new ValidationError("Agent profile principal is invalid");
  if (principal.kind === "user") return assertIdentifier("principal profileId", principal.profileId);
  if (principal.kind === "agent") {
    assertIdentifier("principal sessionId", principal.sessionId);
    return assertIdentifier("principal branchId", principal.branchId);
  }
  if (principal.kind === "system") {
    assertIdentifier("principal componentId", principal.componentId);
    if (!Number.isSafeInteger(principal.version) || principal.version < 1) throw new ValidationError("Agent profile system principal version must be positive");
    return;
  }
  throw new ValidationError("Agent profile principal kind is invalid");
}

import {
  NotFoundError,
  ValidationError,
  materializeInitialAgentProfile,
  validateAgentProfileVersion,
  type AgentEvent,
  type AgentProfileAdmissionMetadata,
  type AgentProfileInput,
  type AgentProfileVersion,
  type EventPayloads,
} from "../domain/index.ts";
import { containsBrokeredSecret } from "../security/index.ts";
import type { AgentStorage } from "../storage/index.ts";

export interface AgentProfileSummary {
  readonly profileVersionId: string;
  readonly agentSessionId: string;
  readonly revision: number;
  readonly role: string;
  readonly purpose: string;
  readonly promptContractId: AgentProfileVersion["promptContractId"];
  readonly promptDigest: string;
  readonly createdBy: AgentProfileVersion["createdBy"];
  readonly sourceSpecEntryId: string | null;
  readonly sourceSpecVersionId: string | null;
  readonly reason: string;
  readonly createdAt: string;
  readonly active: boolean;
}

export interface AgentProfileDetail extends AgentProfileSummary {
  readonly instructions: string;
  readonly exactAgentPrompt: string;
  readonly evidenceEventIds: readonly string[];
  readonly supersedesProfileVersionId: string | null;
  readonly restoresProfileVersionId: string | null;
  readonly sourceProposalId: string | null;
  readonly reviewDecisionId: string | null;
}

export class AgentProfileService {
  constructor(readonly storage: AgentStorage) {}

  materializeInitial(input: AgentProfileInput, metadata: AgentProfileAdmissionMetadata): AgentProfileVersion {
    if (containsBrokeredSecret({
      role: input.role,
      purpose: input.purpose,
      instructions: input.instructions,
    })) {
      throw new ValidationError("Brokered credentials cannot enter an agent profile");
    }
    return materializeInitialAgentProfile(input, metadata);
  }

  async active(sessionId: string): Promise<AgentProfileVersion> {
    const projected = await this.#project(sessionId);
    const profile = projected.versions.get(projected.activeProfileVersionId);
    if (!profile) throw new ValidationError("Active agent profile projection is incomplete");
    return profile;
  }

  async getVersion(sessionId: string, profileVersionId: string): Promise<AgentProfileVersion> {
    const profile = (await this.#project(sessionId)).versions.get(profileVersionId);
    if (!profile) throw new NotFoundError("agent profile version", profileVersionId);
    return profile;
  }

  async get(sessionId: string, options: { readonly includePrompt?: boolean } = {}): Promise<AgentProfileSummary | AgentProfileDetail> {
    const profile = await this.active(sessionId);
    return publicProfile(profile, profile.profileVersionId, options.includePrompt === true);
  }

  async list(
    sessionId: string,
    options: { readonly includePrompt?: boolean; readonly limit?: number } = {},
  ): Promise<{ readonly activeProfileVersionId: string; readonly items: readonly (AgentProfileSummary | AgentProfileDetail)[] }> {
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidationError("Agent profile history limit must be an integer from 1 to 100");
    }
    const projected = await this.#project(sessionId);
    const profiles = [...projected.versions.values()]
      .sort((left, right) => right.revision - left.revision)
      .slice(0, limit)
      .map((profile) => publicProfile(profile, projected.activeProfileVersionId, options.includePrompt === true));
    return { activeProfileVersionId: projected.activeProfileVersionId, items: profiles };
  }

  async #project(sessionId: string): Promise<{ versions: Map<string, AgentProfileVersion>; activeProfileVersionId: string }> {
    const events = await this.storage.loadEvents(sessionId);
    const created = events.find((event) => event.type === "SessionCreated") as AgentEvent<"SessionCreated"> | undefined;
    if (!created) throw new NotFoundError("session", sessionId);
    const initial = validateAgentProfileVersion(created.payload.agentProfile);
    const versions = new Map([[initial.profileVersionId, initial]]);
    let activeProfileVersionId = initial.profileVersionId;
    for (const event of events) {
      if (event.type === "AgentProfileVersionCreated") {
        const payload = event.payload as EventPayloads["AgentProfileVersionCreated"];
        const profile = validateAgentProfileVersion(payload.agentProfile);
        if (payload.expectedActiveProfileVersionId !== activeProfileVersionId ||
            profile.agentSessionId !== sessionId ||
            profile.revision !== versions.size + 1 ||
            profile.supersedesProfileVersionId !== activeProfileVersionId ||
            versions.has(profile.profileVersionId)) {
          throw new ValidationError("Agent profile version history is invalid");
        }
        versions.set(profile.profileVersionId, profile);
      }
      if (event.type === "AgentProfileActivated") {
        const payload = event.payload as EventPayloads["AgentProfileActivated"];
        if (payload.expectedActiveProfileVersionId !== activeProfileVersionId || !versions.has(payload.profileVersionId)) {
          throw new ValidationError("Agent profile activation history is invalid");
        }
        activeProfileVersionId = payload.profileVersionId;
      }
    }
    return { versions, activeProfileVersionId };
  }
}

function publicProfile(
  profile: AgentProfileVersion,
  activeProfileVersionId: string,
  includePrompt: boolean,
): AgentProfileSummary | AgentProfileDetail {
  const summary: AgentProfileSummary = {
    profileVersionId: profile.profileVersionId,
    agentSessionId: profile.agentSessionId,
    revision: profile.revision,
    role: profile.role,
    purpose: profile.purpose,
    promptContractId: profile.promptContractId,
    promptDigest: profile.promptDigest,
    createdBy: profile.createdBy,
    sourceSpecEntryId: profile.sourceSpecEntryId,
    sourceSpecVersionId: profile.sourceSpecVersionId,
    reason: profile.reason,
    createdAt: profile.createdAt,
    active: profile.profileVersionId === activeProfileVersionId,
  };
  return includePrompt ? {
    ...summary,
    instructions: profile.instructions,
    exactAgentPrompt: profile.exactAgentPrompt,
    evidenceEventIds: profile.evidenceEventIds,
    supersedesProfileVersionId: profile.supersedesProfileVersionId,
    restoresProfileVersionId: profile.restoresProfileVersionId,
    sourceProposalId: profile.sourceProposalId,
    reviewDecisionId: profile.reviewDecisionId,
  } : summary;
}

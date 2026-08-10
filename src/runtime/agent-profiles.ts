import {
  ConflictError,
  NotFoundError,
  ValidationError,
  materializeInitialAgentProfile,
  normalizeAgentProfileInput,
  renderExactAgentPrompt,
  sha256,
  validateAgentProfileVersion,
  type AgentEvent,
  type AgentProfileAdmissionMetadata,
  type AgentProfileInput,
  type AgentProfileVersion,
  type EventPayloads,
  type NewAgentEvent,
  type AgentPrincipalReference,
} from "../domain/index.ts";
import { containsBrokeredSecret } from "../security/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import { registerGovernedAgentProfilePreparer } from "./internal.ts";

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
  constructor(readonly storage: AgentStorage) {
    registerGovernedAgentProfilePreparer(this, (input) => this.#prepareApproved(input));
  }

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

  async #prepareApproved(input: {
    readonly targetSessionId: string;
    readonly eventBranchId: string;
    readonly originSessionId: string;
    readonly originBranchId: string;
    readonly expectedActiveProfileVersionId: string;
    readonly replacement: AgentProfileInput;
    readonly createdBy: AgentPrincipalReference;
    readonly reason: string;
    readonly evidenceEventIds: readonly string[];
    readonly proposalId: string;
    readonly reviewDecisionId: string;
  }): Promise<{ readonly profile: AgentProfileVersion; readonly events: readonly NewAgentEvent[] }> {
    const active = await this.active(input.targetSessionId);
    if (active.profileVersionId !== input.expectedActiveProfileVersionId) {
      throw new ValidationError("Agent profile application compare-and-swap failed");
    }
    if (containsBrokeredSecret(input.replacement as unknown as Record<string, string>)) {
      throw new ValidationError("Brokered credentials cannot enter an agent profile");
    }
    const replacement = normalizeAgentProfileInput(input.replacement);
    if (active.role === replacement.role && active.purpose === replacement.purpose &&
        active.instructions === replacement.instructions) {
      throw new ValidationError("Agent profile reproposal must make a substantive change");
    }
    await this.#assertEvidenceVisible(
      input.originSessionId,
      input.originBranchId,
      input.evidenceEventIds,
    );
    const createdAt = new Date().toISOString();
    const profileVersionId = stableId(
      "agent-profile-version",
      `${input.proposalId}:${input.targetSessionId}:${input.expectedActiveProfileVersionId}`,
    );
    const exactAgentPrompt = renderExactAgentPrompt(replacement);
    const profile = validateAgentProfileVersion({
      profileVersionId,
      agentSessionId: input.targetSessionId,
      revision: active.revision + 1,
      ...replacement,
      exactAgentPrompt,
      promptContractId: active.promptContractId,
      promptDigest: sha256(exactAgentPrompt),
      createdBy: input.createdBy,
      sourceSpecEntryId: null,
      sourceSpecVersionId: null,
      reason: input.reason.trim(),
      evidenceEventIds: [...new Set(input.evidenceEventIds)],
      supersedesProfileVersionId: active.profileVersionId,
      restoresProfileVersionId: null,
      sourceProposalId: input.proposalId,
      reviewDecisionId: input.reviewDecisionId,
      createdAt,
    });
    const events: NewAgentEvent[] = [{
      sessionId: input.targetSessionId,
      branchId: input.eventBranchId,
      type: "AgentProfileVersionCreated",
      producer: "supervisor",
      idempotencyKey: `agent-profile-approved:${input.proposalId}`,
      payload: {
        agentProfile: profile,
        expectedActiveProfileVersionId: active.profileVersionId,
      },
    }, {
      sessionId: input.targetSessionId,
      branchId: input.eventBranchId,
      type: "AgentProfileActivated",
      producer: "supervisor",
      idempotencyKey: `agent-profile-activated:${input.proposalId}`,
      payload: {
        profileVersionId,
        expectedActiveProfileVersionId: active.profileVersionId,
        reason: input.reason.trim(),
      },
    }];
    return { profile, events };
  }

  async prepareRestore(input: {
    readonly targetSessionId: string;
    readonly eventBranchId: string;
    readonly originSessionId: string;
    readonly originBranchId: string;
    readonly evidenceAuthority: "origin_lineage" | "workspace_owner";
    readonly expectedCurrentVersionId: string;
    readonly restoreVersionId: string;
    readonly createdBy: AgentPrincipalReference;
    readonly reason: string;
    readonly evidenceEventIds: readonly string[];
    readonly rollbackId: string;
  }): Promise<{ readonly profile: AgentProfileVersion; readonly events: readonly NewAgentEvent[] }> {
    const active = await this.active(input.targetSessionId);
    if (active.profileVersionId !== input.expectedCurrentVersionId) {
      throw new ValidationError("Agent profile rollback compare-and-swap failed");
    }
    const restore = await this.getVersion(input.targetSessionId, input.restoreVersionId);
    if (restore.revision >= active.revision) {
      throw new ValidationError("Agent profile rollback requires an earlier version");
    }
    await this.#assertEvidenceVisible(
      input.originSessionId,
      input.originBranchId,
      input.evidenceEventIds,
      input.evidenceAuthority,
    );
    const profileVersionId = stableId(
      "agent-profile-restoration",
      `${input.rollbackId}:${input.targetSessionId}:${active.profileVersionId}:${restore.profileVersionId}`,
    );
    const restored = validateAgentProfileVersion({
      ...restore,
      profileVersionId,
      revision: active.revision + 1,
      createdBy: input.createdBy,
      reason: input.reason.trim(),
      evidenceEventIds: [...new Set(input.evidenceEventIds)],
      supersedesProfileVersionId: active.profileVersionId,
      restoresProfileVersionId: restore.profileVersionId,
      sourceProposalId: null,
      reviewDecisionId: null,
      createdAt: new Date().toISOString(),
    });
    const events: NewAgentEvent[] = [{
      sessionId: input.targetSessionId,
      branchId: input.eventBranchId,
      type: "AgentProfileVersionCreated",
      producer: "supervisor",
      idempotencyKey: `agent-profile-restoration-version:${input.rollbackId}`,
      payload: {
        agentProfile: restored,
        expectedActiveProfileVersionId: active.profileVersionId,
      },
    }, {
      sessionId: input.targetSessionId,
      branchId: input.eventBranchId,
      type: "AgentProfileActivated",
      producer: "supervisor",
      idempotencyKey: `agent-profile-restoration-activated:${input.rollbackId}`,
      payload: {
        profileVersionId,
        expectedActiveProfileVersionId: active.profileVersionId,
        reason: input.reason.trim(),
      },
    }];
    return { profile: restored, events };
  }

  async #project(sessionId: string): Promise<{ versions: Map<string, AgentProfileVersion>; activeProfileVersionId: string }> {
    const events = await this.storage.loadEvents(sessionId);
    const created = events.find((event) => event.type === "SessionCreated") as AgentEvent<"SessionCreated"> | undefined;
    if (!created) throw new NotFoundError("session", sessionId);
    const initial = validateAgentProfileVersion(created.payload.agentProfile);
    const versions = new Map([[initial.profileVersionId, initial]]);
    const successorClaims = new Map<string, string>();
    let activeProfileVersionId = initial.profileVersionId;
    for (const event of events) {
      if (event.type === "AgentProfileVersionCreated") {
        const payload = event.payload as EventPayloads["AgentProfileVersionCreated"];
        const profile = validateAgentProfileVersion(payload.agentProfile);
        const priorClaim = successorClaims.get(payload.expectedActiveProfileVersionId);
        if (priorClaim !== undefined && priorClaim !== profile.profileVersionId) {
          throw new ConflictError("Agent profile has divergent immutable version claims", {
            sessionId,
            expectedActiveProfileVersionId: payload.expectedActiveProfileVersionId,
            profileVersionIds: [priorClaim, profile.profileVersionId].sort(),
          });
        }
        successorClaims.set(payload.expectedActiveProfileVersionId, profile.profileVersionId);
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

  async #assertEvidenceVisible(
    sessionId: string,
    branchId: string,
    evidenceEventIds: readonly string[],
    authority: "origin_lineage" | "workspace_owner" = "origin_lineage",
  ): Promise<void> {
    if (evidenceEventIds.length > 32 || new Set(evidenceEventIds).size !== evidenceEventIds.length) {
      throw new ValidationError("Agent profile evidence must contain at most 32 distinct events");
    }
    const originRows = await this.storage.readonlyQuery({
      sql: "SELECT workspace_id FROM sessions WHERE session_id=?",
      args: [sessionId],
    });
    const workspaceId = String((originRows[0] as any)?.workspace_id ?? "");
    const visible = authority === "origin_lineage"
      ? new Set((await this.storage.loadEvents(sessionId, { branchId })).map((event) => event.id))
      : null;
    for (const eventId of evidenceEventIds) {
      const event = await this.storage.getEvent(eventId);
      const sourceRows = event ? await this.storage.readonlyQuery({
        sql: "SELECT workspace_id FROM sessions WHERE session_id=?",
        args: [event.sessionId],
      }) : [];
      if (!event ||
          String((sourceRows[0] as any)?.workspace_id ?? "") !== workspaceId ||
          (visible !== null && !visible.has(eventId))) {
        throw new ValidationError("Agent profile evidence is outside the authorized route");
      }
    }
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

function stableId(prefix: string, value: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(value);
  return `${prefix}-${hash.digest("hex").slice(0, 32)}`;
}

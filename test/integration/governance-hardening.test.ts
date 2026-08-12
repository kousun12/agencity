import { afterEach, describe, expect, test } from "bun:test";
import {
  SEALED_GOVERNANCE_REVIEWER_LIMITS,
  Supervisor,
  canonicalJsonDigest,
  registerBrokeredSecret,
  validateNewEvent,
  type GovernedRefinementProposal,
} from "../../src/index.ts";
import {
  ApprovingGovernanceProvider,
  approveProfileRevision,
} from "../governance-provider.ts";
import {
  makeTempRuntime,
  removeTempRuntime,
  type TempRuntime,
} from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

async function open(name: string, provider = new ApprovingGovernanceProvider(name)) {
  const temp = await makeTempRuntime(`agencity-${name}-`);
  temps.push(temp);
  const supervisor = await Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    modelProviders: [provider],
    recover: false,
  });
  return { supervisor, provider, temp };
}

describe("governance final-review hardening", () => {
  test("freezes bounded redacted evidence for direct proposals", async () => {
    const { supervisor, provider } = await open("governance-v3-evidence");
    const secret = "governance-brokered-secret-value";
    let releaseSecret: (() => void) | undefined;
    try {
      const root = await supervisor.createSession({
        workspaceId: "v3-evidence",
        model: { provider: provider.name, model: "fixture" },
      });
      const message = await supervisor.appendMessage(
        root.sessionId,
        root.branchId,
        "user",
        `Visible evidence with ${secret}`,
      );
      const [context] = await supervisor.storage.appendEvents([{
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "ContextMaterialized",
        producer: "supervisor",
        idempotencyKey: "governance-v3-repository-instructions",
        payload: {
          contextId: "governance-v3-context",
          records: [],
          contentHash: "a".repeat(64),
          context: {
            messages: [{
              role: "user",
              content: "WORKSPACE ROOT INSTRUCTIONS\nmust-not-reach-reviewer",
            }],
            retained: "visible-context",
          },
        },
      }]);
      releaseSecret = registerBrokeredSecret(secret);
      await expect(supervisor.refinementGovernance.proposeAutomatic(
        root.sessionId,
        root.branchId,
        {
          target: {
            kind: "harness",
            harnessKind: "prompt_note",
            edits: [{
              operation: "create",
              kind: "prompt_note",
              scope: "local",
              scopeKey: root.sessionId,
              name: "missing-objective-evaluation",
              content: { kind: "prompt_note", text: "Must not be admitted." },
            }],
          },
          reason: "Exercise automatic evaluation validation.",
          predictedEffect: "No proposal is admitted.",
          evidenceEventIds: [message.id],
        },
      )).rejects.toThrow(/require objective post-activation evaluation/i);
      const active = await supervisor.agentProfiles.active(root.sessionId);
      const record = await supervisor.refinementGovernance.proposeOwner(
        root.sessionId,
        root.branchId,
        {
          target: {
            kind: "agent_profile",
            agentSessionId: root.sessionId,
            expectedProfileVersionId: active.profileVersionId,
            replacement: {
              role: active.role,
              purpose: active.purpose,
              instructions: "Use direct evidence with explicit provenance.",
            },
          },
          reason: "Exercise V3 direct evidence freezing.",
          predictedEffect: "Retain reviewer-visible evidence safely.",
          evidenceEventIds: [message.id, context!.id],
          wait: true,
        },
      );
      expect(record.status).toBe("applied");
      expect(record.proposal.evaluation).toBeUndefined();
      expect(record.frozenInput?.version).toBe(3);
      if (record.frozenInput?.version !== 3) {
        throw new Error("expected governance input v3");
      }
      const excerpts = record.frozenInput.evidencePayloads.excerpts;
      expect(excerpts.map((item) => item.eventId))
        .toEqual([message.id, context!.id]);
      expect(excerpts[0]!.redactions).toContain("credentials");
      expect(excerpts[0]!.excerpt).toContain("[REDACTED]");
      expect(excerpts[0]!.excerpt).not.toContain(secret);
      expect(excerpts[1]!.redactions).toContain("repository_instructions");
      expect(excerpts[1]!.excerpt).toContain("visible-context");
      expect(excerpts[1]!.excerpt).not.toContain("must-not-reach-reviewer");
      expect(record.frozenInput.evidencePayloads.usedBytes).toBe(
        excerpts.reduce((total, item) => total + item.excerptBytes, 0),
      );
      for (const version of [1, 2] as const) {
        const {
          canonicalDigest: _v3Digest,
          evidencePayloads: _evidencePayloads,
          refinementGrounding: _refinementGrounding,
          ...retainedBody
        } = record.frozenInput;
        const body = { ...retainedBody, version };
        const retained = {
          ...body,
          canonicalDigest: canonicalJsonDigest(body),
        };
        expect(() => validateNewEvent({
          sessionId: root.sessionId,
          branchId: root.branchId,
          type: "RefinementGovernanceReviewRequested",
          producer: "supervisor",
          payload: {
            proposalId: record.proposalId,
            reviewId: `retained-governance-v${version}`,
            frozenInput: retained as any,
            frozenInputDigest: retained.canonicalDigest,
            expectedStatus: "validated",
          },
        })).not.toThrow();
      }
      const forged = structuredClone(record.frozenInput) as any;
      forged.evidencePayloads.excerpts[0].excerptDigest =
        `sha256:${"f".repeat(64)}`;
      const { canonicalDigest: _canonicalDigest, ...forgedBody } = forged;
      forged.canonicalDigest = canonicalJsonDigest(forgedBody);
      await expect(supervisor.storage.appendEvents([{
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "RefinementGovernanceReviewRequested",
        producer: "supervisor",
        idempotencyKey: "forged-governance-v3-excerpt",
        payload: {
          proposalId: record.proposalId,
          reviewId: "forged-governance-v3-review",
          frozenInput: forged,
          frozenInputDigest: forged.canonicalDigest,
          expectedStatus: "validated",
        },
      }])).rejects.toThrow(/Invalid RefinementGovernanceReviewRequested payload/i);
    } finally {
      releaseSecret?.();
      await supervisor.close();
    }
  });

  test("pins sealed reviewer limits in frozen input and durable child admission", async () => {
    const { supervisor, provider } = await open("governance-limits");
    try {
      const root = await supervisor.createSession({
        workspaceId: "limits",
        model: { provider: provider.name, model: "fixture" },
      });
      await approveProfileRevision(
        supervisor,
        root.sessionId,
        root.branchId,
        "Use the bounded reviewer fixture.",
        "bounded-reviewer",
      );
      const [record] = await supervisor.refinementGovernance.list({
        sessionId: root.sessionId,
        branchId: root.branchId,
        limit: 1,
      });
      expect(record!.frozenInput!.reviewerLimits).toEqual(
        SEALED_GOVERNANCE_REVIEWER_LIMITS,
      );
      const task = (await supervisor.storage.loadEvents(root.sessionId, {
        branchId: root.branchId,
      })).find((event) =>
        event.type === "TaskCreated" &&
        (event.payload as any).childSessionId === record!.reviewerSessionId);
      expect((task!.payload as any).budget).toEqual(
        SEALED_GOVERNANCE_REVIEWER_LIMITS,
      );
    } finally {
      await supervisor.close();
    }
  });

  test("converts reviewer wait timeout and unknown ownership into distinct terminal outcomes", async () => {
    const { supervisor, provider } = await open("governance-timeout-unknown");
    try {
      const root = await supervisor.createSession({
        workspaceId: "timeout-unknown",
        model: { provider: provider.name, model: "fixture" },
      });
      const active = await supervisor.agentProfiles.active(root.sessionId);
      const originalResult = supervisor.models.result.bind(supervisor.models);
      const originalCancel = supervisor.models.cancel.bind(supervisor.models);
      let observedTimeout: number | undefined;
      let forcedOutcome: "timeout" | "unknown" = "timeout";
      (supervisor.models as any).result = async (handleId: string, options: any) => {
        const retained = await originalResult(handleId, { wait: false });
        if (options?.wait) {
          observedTimeout = options.timeoutMs;
          return forcedOutcome === "timeout"
            ? { ...retained, status: "running", outcome: undefined, value: undefined }
            : { ...retained, status: "unknown", outcome: "unknown", error: "ownership lost", value: undefined };
        }
        return forcedOutcome === "timeout"
          ? { ...retained, status: "cancelled", outcome: "cancelled", error: "review timeout", value: undefined }
          : retained;
      };
      (supervisor.models as any).cancel = async (handleId: string) =>
        supervisor.models.get(handleId);
      const timedOut = await supervisor.refinementGovernance.proposeOwner(
        root.sessionId,
        root.branchId,
        {
          clientRequestId: "forced-review-timeout",
          target: {
            kind: "agent_profile",
            agentSessionId: root.sessionId,
            expectedProfileVersionId: active.profileVersionId,
            replacement: {
              role: active.role,
              purpose: active.purpose,
              instructions: "Timeout must not activate.",
            },
          },
          reason: "Exercise reviewer wait timeout.",
          predictedEffect: "No activation occurs.",
          evidenceEventIds: [],
          wait: true,
        },
      );
      expect(timedOut.status).toBe("review_failed");
      expect(observedTimeout).toBe(
        SEALED_GOVERNANCE_REVIEWER_LIMITS.wallTimeLimitMs + 5_000,
      );
      forcedOutcome = "unknown";
      const unknown = await supervisor.refinementGovernance.proposeOwner(
        root.sessionId,
        root.branchId,
        {
          clientRequestId: "forced-review-unknown",
          target: {
            kind: "agent_profile",
            agentSessionId: root.sessionId,
            expectedProfileVersionId: active.profileVersionId,
            replacement: {
              role: active.role,
              purpose: active.purpose,
              instructions: "Unknown ownership must not activate.",
            },
          },
          reason: "Exercise unknown reviewer ownership.",
          predictedEffect: "No activation occurs.",
          evidenceEventIds: [],
          wait: true,
        },
      );
      expect(unknown.status).toBe("review_unknown");
      expect((await supervisor.agentProfiles.active(root.sessionId)).profileVersionId)
        .toBe(active.profileVersionId);
      (supervisor.models as any).result = originalResult;
      (supervisor.models as any).cancel = originalCancel;
    } finally {
      await supervisor.close();
    }
  });

  test.each([
    ["token", { tokenLimit: SEALED_GOVERNANCE_REVIEWER_LIMITS.tokenLimit - 1 }],
    ["cost", { costLimitUsd: SEALED_GOVERNANCE_REVIEWER_LIMITS.costLimitUsd - 0.01 }],
    ["turn", { turnLimit: SEALED_GOVERNANCE_REVIEWER_LIMITS.turnLimit - 1 }],
    ["wall-time", { wallTimeLimitMs: SEALED_GOVERNANCE_REVIEWER_LIMITS.wallTimeLimitMs - 1 }],
  ])("fails sealed reviewer admission when parent %s budget is smaller", async (_kind, budget) => {
    const { supervisor, provider } = await open(`governance-limit-${_kind}`);
    try {
      const root = await supervisor.createSession({
        workspaceId: `limit-${_kind}`,
        model: { provider: provider.name, model: "fixture" },
        budget,
      });
      const active = await supervisor.agentProfiles.active(root.sessionId);
      const result = await supervisor.refinementGovernance.proposeOwner(
        root.sessionId,
        root.branchId,
        {
          target: {
            kind: "agent_profile",
            agentSessionId: root.sessionId,
            expectedProfileVersionId: active.profileVersionId,
            replacement: {
              role: active.role,
              purpose: active.purpose,
              instructions: `Bounded ${_kind} admission.`,
            },
          },
          reason: `Exercise ${_kind} reviewer admission.`,
          predictedEffect: "No activation occurs.",
          evidenceEventIds: [],
          wait: true,
        },
      );
      expect(result.status).toBe("review_failed");
      expect(result.noticeDelivered).toBe(true);
      expect(provider.governanceCalls).toBe(0);
      expect((await supervisor.agentProfiles.active(root.sessionId)).profileVersionId)
        .toBe(active.profileVersionId);
    } finally {
      await supervisor.close();
    }
  });

  test("turns freeze and maximum-depth admission failures terminal exactly once", async () => {
    const { supervisor, provider } = await open("governance-prelink");
    try {
      const root = await supervisor.createSession({
        workspaceId: "prelink",
        model: { provider: provider.name, model: "fixture" },
      });
      const active = await supervisor.agentProfiles.active(root.sessionId);
      const originalList = supervisor.harness.modelList.bind(supervisor.harness);
      (supervisor.harness as any).modelList = async () => {
        throw new Error("fixture freeze failure");
      };
      const frozenFailure = await supervisor.refinementGovernance.proposeOwner(
        root.sessionId,
        root.branchId,
        {
          target: {
            kind: "agent_profile",
            agentSessionId: root.sessionId,
            expectedProfileVersionId: active.profileVersionId,
            replacement: {
              role: active.role,
              purpose: active.purpose,
              instructions: "Freeze must fail closed.",
            },
          },
          reason: "Exercise definitive freeze failure.",
          predictedEffect: "No reviewer starts.",
          evidenceEventIds: [],
          wait: true,
        },
      );
      (supervisor.harness as any).modelList = originalList;
      expect(frozenFailure.status).toBe("review_failed");
      expect(frozenFailure.reviewHandleId).toBeNull();

      let parent = root;
      for (let depth = 0; depth < 8; depth++) {
        parent = await supervisor.agents.spawn(parent.sessionId, parent.branchId, {
          task: `depth ${depth + 1}`,
          idempotencyKey: `depth-${depth + 1}`,
        });
      }
      const deep = await supervisor.agentProfiles.active(parent.sessionId);
      const depthFailure = await supervisor.refinementGovernance.proposeAgent(
        parent.sessionId,
        parent.branchId,
        {
          target: {
            kind: "agent_profile",
            agentSessionId: parent.sessionId,
            expectedProfileVersionId: deep.profileVersionId,
            replacement: {
              role: deep.role,
              purpose: deep.purpose,
              instructions: "Depth admission must fail closed.",
            },
          },
          reason: "Exercise maximum reviewer depth.",
          predictedEffect: "No reviewer starts.",
          evidenceEventIds: [],
          wait: true,
        },
      );
      expect(depthFailure.status).toBe("review_failed");
      expect(depthFailure.terminalReason).toMatch(/maximum session depth/i);
      await supervisor.refinementGovernance.recoverIncomplete();
      await supervisor.refinementGovernance.recoverIncomplete();
      const notices = (await supervisor.storage.loadEvents(root.sessionId))
        .filter((event) =>
          event.type === "RefinementProposalTerminalNoticeDelivered" &&
          (event.payload as any).proposalId === frozenFailure.proposalId);
      expect(notices).toHaveLength(1);
    } finally {
      await supervisor.close();
    }
  });

  test("reopens after a committed validated failure and delivers once without retry", async () => {
    const provider = new ApprovingGovernanceProvider("governance-failure-reopen");
    const { supervisor, temp } = await open("governance-failure-reopen", provider);
    const root = await supervisor.createSession({
      workspaceId: "failure-reopen",
      model: { provider: provider.name, model: "fixture" },
    });
    const active = await supervisor.agentProfiles.active(root.sessionId);
    (supervisor.harness as any).modelList = async () => {
      throw new Error("reopen freeze failure");
    };
    const storage = supervisor.storage as any;
    const append = storage.appendEvents.bind(storage);
    let crashed = false;
    storage.appendEvents = async (events: any[], options?: any) => {
      const committed = await append(events, options);
      if (!crashed && events.some((event) =>
        event.type === "RefinementGovernanceReviewDecided" &&
        event.payload.expectedStatus === "validated")) {
        crashed = true;
        throw new Error("simulated terminal transition crash");
      }
      return committed;
    };
    let proposalId = "";
    await expect(supervisor.refinementGovernance.proposeOwner(
      root.sessionId,
      root.branchId,
      {
        clientRequestId: "validated-failure-reopen",
        target: {
          kind: "agent_profile",
          agentSessionId: root.sessionId,
          expectedProfileVersionId: active.profileVersionId,
          replacement: {
            role: active.role,
            purpose: active.purpose,
            instructions: "Reopen must not retry freeze.",
          },
        },
        reason: "Exercise reopen after terminal transition.",
        predictedEffect: "One failed result is delivered.",
        evidenceEventIds: [],
        wait: true,
      },
    )).rejects.toThrow("simulated terminal transition crash");
    proposalId = (await supervisor.refinementGovernance.list({
      sessionId: root.sessionId,
      branchId: root.branchId,
      limit: 1,
    }))[0]!.proposalId;
    storage.appendEvents = append;
    await supervisor.close();

    const reopened = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: true,
    });
    try {
      await reopened.refinementGovernance.recoverIncomplete();
      await reopened.refinementGovernance.recoverIncomplete();
      const record = await reopened.refinementGovernance.get(proposalId);
      expect(record.status).toBe("review_failed");
      expect(record.noticeDelivered).toBe(true);
      const events = await reopened.storage.loadEvents(root.sessionId, {
        branchId: root.branchId,
      });
      expect(events.filter((event) =>
        event.type === "RefinementGovernanceReviewDecided" &&
        (event.payload as any).proposalId === proposalId)).toHaveLength(1);
      expect(events.filter((event) =>
        event.type === "RefinementProposalTerminalNoticeDelivered" &&
        (event.payload as any).proposalId === proposalId)).toHaveLength(1);
      expect(provider.governanceCalls).toBe(0);
    } finally {
      await reopened.close();
    }
  });

  test("binds revisions to one rejected principal, origin, and target chain", async () => {
    const provider = new ApprovingGovernanceProvider("governance-chain");
    (provider as any).decision = "reject";
    const { supervisor } = await open("governance-chain", provider);
    try {
      const root = await supervisor.createSession({
        workspaceId: "chain",
        model: { provider: provider.name, model: "fixture" },
      });
      const active = await supervisor.agentProfiles.active(root.sessionId);
      const base = {
        target: {
          kind: "agent_profile" as const,
          agentSessionId: root.sessionId,
          expectedProfileVersionId: active.profileVersionId,
          replacement: {
            role: active.role,
            purpose: active.purpose,
            instructions: "First rejected chain content.",
          },
        },
        reason: "First chain proposal.",
        predictedEffect: "Bound one chain.",
        evidenceEventIds: [] as string[],
        wait: true,
      };
      const rejected = await supervisor.refinementGovernance.proposeOwner(
        root.sessionId,
        root.branchId,
        base,
      );
      expect(rejected.status).toBe("reviewed_rejected");
      const child = await supervisor.agents.spawn(root.sessionId, root.branchId, {
        task: "chain child",
      });
      const crossPrincipal = await supervisor.refinementGovernance.proposeAgent(
        root.sessionId,
        root.branchId,
        {
          ...base,
          target: {
            ...base.target,
            replacement: {
              ...base.target.replacement,
              instructions: "Cross-principal revision.",
            },
          },
          revisesProposalId: rejected.proposalId,
        },
      );
      expect(crossPrincipal.status).toBe("deterministically_rejected");
      const childProfile = await supervisor.agentProfiles.active(child.sessionId);
      const crossTarget = await supervisor.refinementGovernance.proposeOwner(
        root.sessionId,
        root.branchId,
        {
          ...base,
          target: {
            kind: "agent_profile",
            agentSessionId: child.sessionId,
            expectedProfileVersionId: childProfile.profileVersionId,
            replacement: {
              role: childProfile.role,
              purpose: childProfile.purpose,
              instructions: "Cross-target revision.",
            },
          },
          revisesProposalId: rejected.proposalId,
        },
      );
      expect(crossTarget.status).toBe("deterministically_rejected");
      const revision = await supervisor.refinementGovernance.proposeOwner(
        root.sessionId,
        root.branchId,
        {
          ...base,
          target: {
            ...base.target,
            replacement: {
              ...base.target.replacement,
              instructions: "Substantively revised chain content.",
            },
          },
          revisesProposalId: rejected.proposalId,
        },
      );
      expect(revision.status).toBe("reviewed_rejected");
      const chained = await supervisor.refinementGovernance.proposeOwner(
        root.sessionId,
        root.branchId,
        {
          ...base,
          target: {
            ...base.target,
            replacement: {
              ...base.target.replacement,
              instructions: "Forbidden revision of a revision.",
            },
          },
          revisesProposalId: revision.proposalId,
        },
      );
      expect(chained.status).toBe("deterministically_rejected");
    } finally {
      await supervisor.close();
    }
  });

  test("scopes rollback evidence to agent lineage while owners may use workspace evidence", async () => {
    const { supervisor, provider } = await open("governance-rollback-evidence");
    try {
      const root = await supervisor.createSession({
        workspaceId: "rollback-evidence",
        model: { provider: provider.name, model: "fixture" },
      });
      const sibling = await supervisor.createSession({
        workspaceId: "rollback-evidence",
        model: { provider: provider.name, model: "fixture" },
      });
      const initial = await supervisor.agentProfiles.active(root.sessionId);
      const ancestorEvidence = await supervisor.appendMessage(
        root.sessionId,
        root.branchId,
        "user",
        "Ancestor rollback evidence",
      );
      const forkId = await supervisor.fork(
        root.sessionId,
        root.branchId,
        ancestorEvidence.cursor,
      );
      const siblingEvidence = await supervisor.appendMessage(
        sibling.sessionId,
        sibling.branchId,
        "user",
        "Sibling-session evidence",
      );
      const revised = await approveProfileRevision(
        supervisor,
        root.sessionId,
        root.branchId,
        "Temporary evidence-scope profile.",
        "rollback-evidence-revision",
      );
      await expect(supervisor.refinementGovernance.rollbackAgent(
        root.sessionId,
        forkId,
        {
          targetKind: "agent_profile",
          targetId: root.sessionId,
          expectedCurrentVersionId: revised.profileVersionId,
          restoreVersionId: initial.profileVersionId,
          reason: "Sibling evidence is not on the caller lineage.",
          evidenceEventIds: [siblingEvidence.id],
        },
      )).rejects.toThrow(/outside the authorized route/i);
      const agentRollback = await supervisor.refinementGovernance.rollbackAgent(
        root.sessionId,
        forkId,
        {
          targetKind: "agent_profile",
          targetId: root.sessionId,
          expectedCurrentVersionId: revised.profileVersionId,
          restoreVersionId: initial.profileVersionId,
          reason: "Ancestor evidence is visible on the fork lineage.",
          evidenceEventIds: [ancestorEvidence.id],
        },
      );
      expect((await supervisor.agentProfiles.active(root.sessionId)).profileVersionId)
        .toBe(agentRollback.restorationVersionId);

      const revisedAgain = await approveProfileRevision(
        supervisor,
        root.sessionId,
        root.branchId,
        "Second temporary evidence-scope profile.",
        "rollback-owner-evidence-revision",
      );
      const ownerRollback = await supervisor.refinementGovernance.rollbackOwner(
        root.sessionId,
        root.branchId,
        {
          targetKind: "agent_profile",
          targetId: root.sessionId,
          expectedCurrentVersionId: revisedAgain.profileVersionId,
          restoreVersionId: initial.profileVersionId,
          reason: "Workspace owner may cite same-workspace evidence.",
          evidenceEventIds: [siblingEvidence.id],
        },
      );
      expect((await supervisor.agentProfiles.active(root.sessionId)).profileVersionId)
        .toBe(ownerRollback.restorationVersionId);
    } finally {
      await supervisor.close();
    }
  });

  test("recovers more than 200 oldest nonterminal proposals and undelivered notices", async () => {
    const { supervisor, provider } = await open("governance-pagination");
    try {
      const root = await supervisor.createSession({
        workspaceId: "pagination",
        model: { provider: provider.name, model: "fixture" },
      });
      const active = await supervisor.agentProfiles.active(root.sessionId);
      const events: any[] = [];
      for (let index = 0; index < 205; index++) {
        const proposalId = `pagination-terminal-${String(index).padStart(3, "0")}`;
        const proposal: GovernedRefinementProposal = {
          proposalId,
          target: {
            kind: "agent_profile",
            agentSessionId: root.sessionId,
            expectedProfileVersionId: active.profileVersionId,
            replacement: {
              role: active.role,
              purpose: active.purpose,
              instructions: active.instructions,
            },
          },
          principal: { kind: "owner", profileId: supervisor.device.profileId },
          origin: { sessionId: root.sessionId, branchId: root.branchId },
          reason: `terminal ${index}`,
          predictedEffect: "Reject without review.",
          evidenceEventIds: [],
        };
        events.push({
          sessionId: root.sessionId,
          branchId: root.branchId,
          type: "GovernedRefinementProposed",
          producer: "client",
          idempotencyKey: `pagination-proposed-${index}`,
          payload: {
            proposalId,
            proposalFingerprint: canonicalJsonDigest(proposal as any),
            proposal,
          },
        }, {
          sessionId: root.sessionId,
          branchId: root.branchId,
          type: "GovernedRefinementValidated",
          producer: "supervisor",
          idempotencyKey: `pagination-rejected-${index}`,
          payload: {
            proposalId,
            valid: false,
            validation: { valid: false, reason: `rejected ${index}` },
            expectedStatus: "proposed",
          },
        });
      }
      await supervisor.storage.appendEvents(events);
      expect(await supervisor.refinementGovernance.recoverIncomplete()).toBe(0);
      const delivered = (await supervisor.storage.loadEvents(root.sessionId))
        .filter((event) => event.type === "RefinementProposalTerminalNoticeDelivered");
      expect(delivered).toHaveLength(205);
      expect((delivered[0]!.payload as any).proposalId).toBe("pagination-terminal-000");
      await supervisor.refinementGovernance.recoverIncomplete();
      expect((await supervisor.storage.loadEvents(root.sessionId))
        .filter((event) => event.type === "RefinementProposalTerminalNoticeDelivered"))
        .toHaveLength(205);

      const pending: any[] = [];
      for (let index = 0; index < 205; index++) {
        const proposalId = `pagination-pending-${String(index).padStart(3, "0")}`;
        const proposal: GovernedRefinementProposal = {
          proposalId,
          target: {
            kind: "agent_profile",
            agentSessionId: root.sessionId,
            expectedProfileVersionId: active.profileVersionId,
            replacement: {
              role: active.role,
              purpose: active.purpose,
              instructions: `pending ${index}`,
            },
          },
          principal: { kind: "owner", profileId: supervisor.device.profileId },
          origin: { sessionId: root.sessionId, branchId: root.branchId },
          reason: `pending ${index}`,
          predictedEffect: "Await validation.",
          evidenceEventIds: [],
        };
        pending.push({
          sessionId: root.sessionId,
          branchId: root.branchId,
          type: "GovernedRefinementProposed",
          producer: "client",
          idempotencyKey: `pagination-pending-${index}`,
          payload: {
            proposalId,
            proposalFingerprint: canonicalJsonDigest(proposal as any),
            proposal,
          },
        });
      }
      await supervisor.storage.appendEvents(pending);
      expect(await supervisor.refinementGovernance.recoverIncomplete()).toBe(205);
    } finally {
      await supervisor.close();
    }
  });

  test("rejects forged governance digests and nonterminal terminal notices, then rebuilds exactly", async () => {
    const { supervisor, provider } = await open("governance-forgery");
    try {
      const root = await supervisor.createSession({
        workspaceId: "forgery",
        model: { provider: provider.name, model: "fixture" },
      });
      const active = await supervisor.agentProfiles.active(root.sessionId);
      const proposal: GovernedRefinementProposal = {
        proposalId: "forged-proposal",
        target: {
          kind: "agent_profile",
          agentSessionId: root.sessionId,
          expectedProfileVersionId: active.profileVersionId,
          replacement: {
            role: active.role,
            purpose: active.purpose,
            instructions: "Forged proposal.",
          },
        },
        principal: { kind: "owner", profileId: supervisor.device.profileId },
        origin: { sessionId: root.sessionId, branchId: root.branchId },
        reason: "Forged proposal.",
        predictedEffect: "Must fail.",
        evidenceEventIds: [],
      };
      await expect(supervisor.storage.appendEvents([{
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "GovernedRefinementProposed",
        producer: "client",
        payload: {
          proposalId: proposal.proposalId,
          proposalFingerprint: `sha256:${"f".repeat(64)}`,
          proposal: proposal as any,
        },
      }])).rejects.toThrow(/fingerprint|payload/i);
      await supervisor.storage.appendEvents([{
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "GovernedRefinementProposed",
        producer: "client",
        payload: {
          proposalId: proposal.proposalId,
          proposalFingerprint: canonicalJsonDigest(proposal as any),
          proposal: proposal as any,
        },
      }]);
      await expect(supervisor.storage.appendEvents([{
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "RefinementProposalTerminalNoticeDelivered",
        producer: "supervisor",
        payload: {
          proposalId: proposal.proposalId,
          noticeId: "forged-notice",
          originSessionId: root.sessionId,
          originBranchId: root.branchId,
          status: "review_failed",
          result: {
            proposalId: proposal.proposalId,
            status: "review_failed",
            reviewDecisionId: null,
            reason: null,
            appliedVersionIds: [],
          },
        },
      }])).rejects.toThrow(/terminal proposal/i);
      await supervisor.storage.rebuildOperationalProjections?.();
      expect((await supervisor.refinementGovernance.get(proposal.proposalId)).status)
        .toBe("proposed");
    } finally {
      await supervisor.close();
    }
  });
});

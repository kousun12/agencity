import {
  REFINEMENT_GOVERNANCE_CONTRACT_ID,
  type JsonValue,
  type AgentProfileInput,
  type ModelConfiguration,
  type ModelDispatch,
  type ModelEffectOutputV2,
  type ModelProvider,
  type Supervisor,
  type TextModelResponse,
} from "../src/index.ts";
import {
  formalOutputFromAgentAction,
  formalOutputFromRefinementGovernanceDecision,
} from "../src/executors/model-response.ts";

export class ApprovingGovernanceProvider implements ModelProvider {
  readonly capabilities = {
    streaming: false,
    requiredToolSet: {
      status: "provider-strict",
      requiredChoice: "provider-enforced",
      parallelCalls: "provider-disabled",
      streaming: true,
      adapter: "agencity.governance-fixture.v1",
    },
  } as const;
  governanceCalls = 0;

  constructor(
    readonly name: string,
    public decision: "approve" | "reject" = "approve",
  ) {}

  async complete(
    _context: JsonValue,
    _configuration: ModelConfiguration,
    _signal: AbortSignal,
  ): Promise<TextModelResponse> {
    return {
      text: "done",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    };
  }

  async streamResponse(
    context: JsonValue,
    dispatch: ModelDispatch,
    _signal: AbortSignal,
  ): Promise<ModelEffectOutputV2> {
    if (dispatch.responseContract.kind !== "required-tool-set" ||
        dispatch.responseContract.contractId !== REFINEMENT_GOVERNANCE_CONTRACT_ID) {
      return formalOutputFromAgentAction({
        action: {
          protocol: "agencity.agent-action",
          version: 1,
          type: "final",
          content: "done",
        },
        dispatch,
        providerToolCallId: "governance-fixture-agent",
        provider: this.name,
        adapter: this.capabilities.requiredToolSet.adapter,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      });
    }
    const proposalId = JSON.stringify(context).match(
      /proposalId[^A-Za-z0-9]+(governed-refinement-proposal-[a-f0-9]{32}|[0-9A-HJKMNP-TV-Z]{26})/,
    )?.[1];
    if (!proposalId) throw new Error("Missing governed proposal ID");
    this.governanceCalls++;
    return formalOutputFromRefinementGovernanceDecision({
      decision: this.decision === "approve" ? {
        decision: "approve",
        proposalId,
        reason: "The bounded fixture proposal satisfies the sealed policy.",
        satisfiedCriteria: ["scope", "evidence", "runtime-boundaries"],
        residualRisks: ["Outcome improvement remains unproven."],
      } : {
        decision: "reject",
        proposalId,
        reason: "The fixture rejects this proposal.",
        violatedCriteria: ["evidence-sufficiency"],
        revisionGuidance: "Submit one bounded substantive revision.",
      },
      dispatch,
      providerToolCallId: `governance-fixture-${this.governanceCalls}`,
      provider: this.name,
      adapter: this.capabilities.requiredToolSet.adapter,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    });
  }
}

export async function approveProfileRevision(
  supervisor: Supervisor,
  sessionId: string,
  branchId: string,
  replacement: string | AgentProfileInput,
  requestKey: string,
) {
  const active = await supervisor.agentProfiles.active(sessionId);
  const evidence = await supervisor.appendMessage(
    sessionId,
    branchId,
    "user",
    `Governed profile evidence: ${requestKey}`,
  );
  const applied = await supervisor.refinementGovernance.proposeOwner(
    sessionId,
    branchId,
    {
      clientRequestId: requestKey,
      target: {
        kind: "agent_profile",
        agentSessionId: sessionId,
        expectedProfileVersionId: active.profileVersionId,
        replacement: {
          role: typeof replacement === "string" ? active.role : replacement.role,
          purpose: typeof replacement === "string" ? active.purpose : replacement.purpose,
          instructions: typeof replacement === "string" ? replacement : replacement.instructions,
        },
      },
      reason: `Apply governed profile fixture ${requestKey}.`,
      predictedEffect: "Exercise exact governed profile provenance.",
      evidenceEventIds: [evidence.id],
      wait: true,
    },
  );
  if (applied.status !== "applied") {
    throw new Error(`Governed fixture did not apply: ${applied.status}`);
  }
  return supervisor.agentProfiles.active(sessionId);
}

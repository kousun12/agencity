import { Supervisor, type AgentEvent, type HarnessContent, type HarnessEdit, type HarnessRecord, type RefinementProposalRecord } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime, waitFor } from "../helpers.ts";

export interface AdversarialRuntime { supervisor: Supervisor; temp: TempRuntime }
export { waitFor };

export async function openAdversarial(prefix = "agencity-s3-adversarial-"): Promise<AdversarialRuntime> {
  const temp = await makeTempRuntime(prefix);
  const supervisor = await Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    recover: false,
  });
  return { supervisor, temp };
}

export async function reopenAdversarial(value: AdversarialRuntime, recover = true): Promise<AdversarialRuntime> {
  await value.supervisor.close();
  const supervisor = await Supervisor.open({
    databaseUrl: value.temp.databaseUrl,
    artifactDirectory: value.temp.artifactDirectory,
    workspaceRoot: value.temp.workspaceRoot,
    recover,
  });
  return { supervisor, temp: value.temp };
}

export async function closeAdversarial(value: AdversarialRuntime | undefined): Promise<void> {
  if (!value) return;
  await value.supervisor.close();
  await removeTempRuntime(value.temp);
}

export async function evidence(
  supervisor: Supervisor,
  sessionId: string,
  branchId: string,
  text = "durable refinement evidence",
): Promise<AgentEvent<"MessageAppended">> {
  return supervisor.appendMessage(sessionId, branchId, "user", text);
}

/** Produces executor-owned, durable success evidence rather than a model claim. */
export async function objectiveEvidence(
  supervisor: Supervisor,
  sessionId: string,
  branchId: string,
  key: string,
): Promise<AgentEvent<"EffectOutcomeRecorded">> {
  const effectId = await supervisor.outbox.request({
    sessionId,
    branchId,
    executor: "shell",
    operation: "run",
    input: { command: "true" },
    idempotencyKey: `adversarial-objective:${key}`,
    idempotent: true,
  });
  const outcome = await supervisor.outbox.run(effectId);
  if (outcome.outcome !== "succeeded") throw new Error(`objective evidence failed: ${outcome.error}`);
  const events = await supervisor.storage.loadEvents(sessionId, { branchId });
  const event = [...events].reverse().find((item) =>
    item.type === "EffectOutcomeRecorded" && (item.payload as { effectId?: string }).effectId === effectId
  );
  if (!event) throw new Error("objective outcome event was not committed");
  return event as AgentEvent<"EffectOutcomeRecorded">;
}

export async function validatedProposal(
  supervisor: Supervisor,
  sessionId: string,
  branchId: string,
  edits: readonly HarnessEdit[],
  evidenceEventIds: readonly string[],
  options: { trigger?: string; predictedEffect?: string; authority?: "agent" | "user" | "system" } = {},
): Promise<RefinementProposalRecord> {
  const proposed = await supervisor.harness.propose(sessionId, branchId, {
    trigger: options.trigger ?? "adversarial reusable outcome",
    predictedEffect: options.predictedEffect ?? "the measured outcome should improve",
    evidenceEventIds,
    authority: options.authority ?? "agent",
    evaluation: { kind: "objective", name: "adversarial check", metric: "passed", target: true, baseline: false },
    edits,
  });
  return supervisor.harness.validate(sessionId, branchId, proposed.proposalId);
}

export async function activeLocalEntry(
  supervisor: Supervisor,
  sessionId: string,
  branchId: string,
  kind: "prompt_note" | "skill" | "subagent_spec",
  name: string,
  content: HarnessContent,
): Promise<HarnessRecord> {
  const ev = await evidence(supervisor, sessionId, branchId, `evidence for ${name}`);
  let proposal = await validatedProposal(supervisor, sessionId, branchId, [{
    operation: "create", kind, scope: "local", name, content,
  }], [ev.id]);
  if (proposal.status !== "validated") throw new Error(`proposal validation failed: ${JSON.stringify(proposal.validation)}`);
  proposal = await supervisor.harness.activate(sessionId, branchId, proposal.proposalId, { allocationLimit: 1, exposureLimit: 1 });
  const allocation = await supervisor.harness.allocate(sessionId, branchId, proposal.proposalId);
  await supervisor.contexts.materialize(sessionId, branchId);
  await supervisor.harness.recordObservation(sessionId, branchId, proposal.proposalId, {
    allocationId: allocation.allocationId,
    evaluator: "adversarial-local-observer",
    objective: false,
    success: true,
    metric: true,
    evidenceEventIds: [ev.id],
  });
  await supervisor.harness.decide(sessionId, branchId, proposal.proposalId);
  const entry = (await supervisor.harness.list({ kind })).find((item) => item.name === name);
  if (!entry) throw new Error(`promoted ${kind} ${name} is missing`);
  return entry;
}

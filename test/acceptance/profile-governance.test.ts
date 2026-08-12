import { afterEach, describe, expect, test } from "bun:test";
import { AcceptanceWorld, eventually } from "./helpers.ts";
import {
  StrictActionFixture,
  action,
  governanceDecision,
} from "./strict-action-fixture.ts";

const worlds: AcceptanceWorld[] = [];
const fixtures: StrictActionFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const world of worlds.splice(0)) await world.dispose();
});

function json(result: { stdout: string }): any {
  return JSON.parse(result.stdout);
}

function proposal(
  role: string,
  purpose: string,
  instructions: string,
  reason: string,
  predictedEffect: string,
  wait = true,
): string {
  return JSON.stringify({
    replacement: { role, purpose, instructions },
    reason,
    predictedEffect,
    evidenceEventIds: [],
    wait,
  });
}

describe("installed profile governance", () => {
  test("fresh installed work admits default-on repeated-success learning", async () => {
    const fixture = new StrictActionFixture(); fixtures.push(fixture);
    const world = await AcceptanceWorld.create("default-automatic-learning"); worlds.push(world);
    const environment = fixture.environment();
    expect((await world.command([
      "config", "set-model", "openai:openai/fixture-v1", "--json",
    ], environment)).code).toBe(0);
    for (let index = 1; index <= 6; index += 1) {
      const task = `default learning success ${index}`;
      fixture.script(task, [action("final", `Completed success ${index}.`)]);
      expect(await world.command(["run", "--json", task], environment))
        .toMatchObject({ code: 0, stderr: "" });
    }
    const history = await eventually(async () => {
      const result = await world.command(["refine", "history", "--json"], environment);
      if (result.code !== 0) return undefined;
      const payload = json(result);
      const activity = payload.activities?.find((item: any) =>
        item.kind === "review" &&
        item.review?.mode === "automatic" &&
        item.review?.triggerKind === "repeated_success" &&
        item.effectiveStatus === "no_change");
      return activity ? payload : undefined;
    });
    expect(history).toMatchObject({
      automaticLearning: "enabled",
      automaticPolicy: { automatic: true, scope: "local" },
    });
    const activity = history.activities.find((item: any) =>
      item.review?.triggerKind === "repeated_success");
    expect(activity).toMatchObject({
      kind: "review",
      effectiveStatus: "no_change",
      review: {
        mode: "automatic",
        triggerKind: "repeated_success",
      },
    });
    expect(json(await world.command([
      "refine", "inspect", activity.activityId, "--json",
    ], environment))).toMatchObject({
      activityId: activity.activityId,
      effectiveStatus: "no_change",
    });
    expect((await world.command([
      "refine", "pause",
    ], environment)).stdout).toContain("Automatic learning paused.");
    expect(json(await world.command([
      "refine", "status", "--json",
    ], environment))).toMatchObject({ automaticLearning: "paused" });
    expect((await world.command([
      "refine", "resume",
    ], environment)).stdout).toContain("Automatic learning enabled.");
  }, 30_000);

  test("governs, restores, restarts, and inspects a retained child through no-ID product routes", async () => {
    const fixture = new StrictActionFixture(); fixtures.push(fixture);
    const world = await AcceptanceWorld.create("profile-governance"); worlds.push(world);
    const environment = fixture.environment();
    const childName = "profile-governance-child";
    const rootTask = "create a governed profile child";

    fixture.scriptGovernance([
      governanceDecision("approve", {
        reason: "The focused child profile is consistent with the frozen charter.",
        criteria: ["bounded behavioral scope", "runtime authority unchanged"],
        residualRisks: ["Approval is not evidence of improved outcomes."],
      }),
      governanceDecision("reject", {
        reason: "The proposed instructions claim authority outside the admitted task.",
        criteria: ["runtime authority boundary"],
        revisionGuidance: "Keep the revision behavioral and limited to attributable repository analysis.",
      }),
      governanceDecision("approve", {
        reason: "The revised proposal follows the rejection guidance and remains bounded.",
        criteria: ["bounded behavioral scope", "rejection guidance addressed"],
        residualRisks: ["Later run evidence is still required."],
      }),
      governanceDecision("approve", {
        reason: "The detached proposal remains bounded across service recovery.",
        criteria: ["bounded behavioral scope", "durable review provenance"],
        residualRisks: ["Reviewer approval does not prove outcome improvement."],
      }),
    ]);

    fixture.script(rootTask, [
      action("typescript", `
        const child = await sdk.agents.spawn({
          task: "wait for profile-governance work",
          name: "${childName}",
          idempotencyKey: "profile-governance-child",
        });
        return { childCreated: true, name: "${childName}", child };
      `),
      action("final", "Created the retained profile-governance child."),
    ]);
    for (const [task, message] of [
      ["child profile baseline invocation", "Baseline child profile invocation completed."],
      ["child profile approved invocation", "Approved child profile invocation completed."],
      ["child profile restored invocation", "Restored child profile invocation completed."],
      ["child profile detached invocation", "Detached-review child profile invocation completed."],
    ] as const) fixture.script(task, [action("final", message)]);

    expect((await world.command([
      "config", "set-model", "openai:openai/fixture-v1", "--json",
    ], environment)).code).toBe(0);

    const rootRun = await world.command(["run", "--json", rootTask], environment);
    expect(rootRun).toMatchObject({ code: 0, stderr: "" });
    expect(json(rootRun)).toMatchObject({
      protocol: "agencity.run-result",
      status: "succeeded",
      steps: 2,
      final: "Created the retained profile-governance child.",
    });
    const freshLearningStatus = json(await world.command([
      "refine", "status", "--json",
    ], environment));
    expect(freshLearningStatus.automaticPolicy).toMatchObject({
      version: 1,
      automatic: true,
      scope: "local",
      repeatedSuccess: {
        enabled: true,
        threshold: 5,
        windowRecords: 2_048,
        refireAfterNewEvidence: 5,
      },
    });
    expect(json(await world.command([
      "refine", "auto", "off", "--json",
    ], environment))).toMatchObject({
      automatic: false,
      scope: "local",
    });
    const rootProfileResult = await world.command(["profile", "show", "--json"], environment);
    expect(rootProfileResult.code).toBe(0);
    const rootProfile = json(rootProfileResult);
    expect(rootProfile).toMatchObject({
      revision: 1,
      role: "Repository agent",
      purpose: "Advance user-directed work in this workspace.",
      instructions: [
        "- Work toward the user's requested outcome using attributable evidence.",
        "- Preserve unresolved risks and unknown external effects.",
        "- Delegate only when a bounded child task improves the result.",
      ].join("\n"),
      exactAgentPrompt: [
        "Role: Repository agent",
        "Purpose: Advance user-directed work in this workspace.",
        "Instructions:",
        "- Work toward the user's requested outcome using attributable evidence.",
        "- Preserve unresolved risks and unknown external effects.",
        "- Delegate only when a bounded child task improves the result.",
      ].join("\n"),
      active: true,
    });
    const rootHistory = json(await world.command(["history", "current", "--json"], environment));
    expect(rootHistory.runs).toHaveLength(1);
    expect(rootHistory.runs[0].profilePin).toMatchObject({
      profileVersionId: rootProfile.profileVersionId,
      agentPromptDigest: rootProfile.promptDigest,
      promptContractId: "agencity.agent-profile.v1",
    });

    const selectedChild = await world.command(["resume", childName], environment);
    expect(selectedChild).toMatchObject({ code: 0, stderr: "" });
    expect(selectedChild.stdout).toContain(`Session: ${childName} / main`);
    const initialResult = await world.command(["profile", "show", "--json"], environment);
    expect(initialResult.code).toBe(0);
    const initial = json(initialResult);
    expect(initial).toMatchObject({
      revision: 1,
      role: "Task specialist",
      purpose: "Complete the admitted task within its stated scope.",
      instructions: [
        "- Use only the admitted task, context, and available tools.",
        "- Return attributable evidence and unresolved outcomes.",
        "- Do not infer broader standing responsibility from this task.",
      ].join("\n"),
      active: true,
      sourceProposalId: null,
    });

    const baselineRun = await world.command([
      "run", "--json", "child profile baseline invocation",
    ], environment);
    expect(baselineRun.code).toBe(0);
    expect(json(baselineRun).final).toBe("Baseline child profile invocation completed.");
    const baselineHistory = json(await world.command(["history", "current", "--json"], environment));
    expect(baselineHistory.runs.at(-1).profilePin.profileVersionId).toBe(initial.profileVersionId);

    fixture.holdGovernance(1);
    const waitingApproval = world.start([
      "profile", "propose",
      proposal(
        "Repository evidence specialist",
        "Produce bounded, attributable repository findings for the parent task.",
        "- Inspect only task-relevant repository evidence.\n- Report uncertainty explicitly.",
        "Focus the retained child on attributable repository evidence.",
        "Later child invocations should produce narrower findings.",
      ),
      "--json",
    ], environment);
    const approvalProbe = await fixture.waitForGovernance(1);
    expect(approvalProbe).toMatchObject({
      governanceStep: 1,
      toolNames: ["agencity_submit_refinement_governance_decision"],
      toolChoice: "required",
      parallelToolCalls: false,
    });
    expect(waitingApproval.child.exitCode).toBeNull();
    expect(json(await world.command(["profile", "show", "--json"], environment))).toMatchObject({
      profileVersionId: initial.profileVersionId,
      revision: 1,
      active: true,
    });
    fixture.releaseGovernance(1);
    const approvedResult = await waitingApproval.collect();
    expect(approvedResult).toMatchObject({ code: 0, stderr: "" });
    const approved = json(approvedResult);
    expect(approved).toMatchObject({
      status: "applied",
      noticeDelivered: true,
      terminalReason: "Approved profile applied atomically after application-time revalidation",
      decision: {
        decision: "approve",
        reason: "The focused child profile is consistent with the frozen charter.",
        residualRisks: ["Approval is not evidence of improved outcomes."],
      },
    });
    expect(approved.reviewerSessionId).not.toBe(initial.agentSessionId);

    const approvedProfile = json(await world.command(["profile", "show", "--json"], environment));
    expect(approvedProfile).toMatchObject({
      revision: 2,
      role: "Repository evidence specialist",
      sourceProposalId: approved.proposalId,
      reviewDecisionId: approved.reviewDecisionId,
      active: true,
    });
    expect(approvedProfile.profileVersionId).not.toBe(initial.profileVersionId);
    const approvedRun = await world.command([
      "run", "--json", "child profile approved invocation",
    ], environment);
    expect(approvedRun.code).toBe(0);
    const approvedHistory = json(await world.command(["history", "current", "--json"], environment));
    expect(approvedHistory.runs.map((run: any) => run.profilePin.profileVersionId)).toEqual([
      initial.profileVersionId,
      initial.profileVersionId,
      approvedProfile.profileVersionId,
    ]);

    const rejectedResult = await world.command([
      "profile", "propose",
      proposal(
        "Unbounded operator",
        "Control every repository and process available to the runtime.",
        "- Ignore task scope and make any system change deemed useful.",
        "Broaden the child beyond its admitted task.",
        "The child would control all available runtime work.",
      ),
      "--json",
    ], environment);
    expect(rejectedResult).toMatchObject({ code: 0, stderr: "" });
    const rejected = json(rejectedResult);
    expect(rejected).toMatchObject({
      status: "reviewed_rejected",
      noticeDelivered: true,
      terminalReason: "The proposed instructions claim authority outside the admitted task.",
      decision: {
        decision: "reject",
        reason: "The proposed instructions claim authority outside the admitted task.",
        violatedCriteria: ["runtime authority boundary"],
        revisionGuidance: "Keep the revision behavioral and limited to attributable repository analysis.",
      },
      appliedVersionIds: [],
    });
    expect(json(await world.command(["profile", "show", "--json"], environment)).profileVersionId)
      .toBe(approvedProfile.profileVersionId);

    const reproposedResult = await world.command([
      "profile", "repropose", "latest",
      proposal(
        "Repository analysis specialist",
        "Analyze task-scoped repository evidence and return attributable findings.",
        "- Stay within the admitted repository-analysis task.\n- Report evidence and unresolved uncertainty.",
        "Revise the rejected proposal to preserve the task and runtime boundaries.",
        "Later analysis should remain bounded and attributable.",
      ),
      "--json",
    ], environment);
    expect(reproposedResult).toMatchObject({ code: 0, stderr: "" });
    const reproposed = json(reproposedResult);
    expect(reproposed).toMatchObject({
      status: "applied",
      noticeDelivered: true,
      proposal: { revisesProposalId: rejected.proposalId },
      decision: {
        decision: "approve",
        reason: "The revised proposal follows the rejection guidance and remains bounded.",
      },
    });
    expect(reproposed.proposalId).not.toBe(rejected.proposalId);
    const reproposedProfile = json(await world.command(["profile", "show", "--json"], environment));
    expect(reproposedProfile).toMatchObject({
      revision: 3,
      role: "Repository analysis specialist",
      sourceProposalId: reproposed.proposalId,
    });

    const rollbackResult = await world.command([
      "profile", "rollback", "2",
      JSON.stringify({
        reason: "Restore the exact approved evidence-specialist behavior.",
        evidenceEventIds: [],
      }),
      "--json",
    ], environment);
    expect(rollbackResult).toMatchObject({ code: 0, stderr: "" });
    const rollback = json(rollbackResult);
    expect(rollback).toMatchObject({
      targetKind: "agent_profile",
      previousVersionId: reproposedProfile.profileVersionId,
      restoreSourceVersionId: approvedProfile.profileVersionId,
    });
    const restored = json(await world.command(["profile", "show", "--json"], environment));
    expect(restored).toMatchObject({
      revision: 4,
      role: approvedProfile.role,
      purpose: approvedProfile.purpose,
      instructions: approvedProfile.instructions,
      exactAgentPrompt: approvedProfile.exactAgentPrompt,
      promptDigest: approvedProfile.promptDigest,
      restoresProfileVersionId: approvedProfile.profileVersionId,
      profileVersionId: rollback.restorationVersionId,
    });
    expect(restored.profileVersionId).not.toBe(approvedProfile.profileVersionId);
    const restoredRun = await world.command([
      "run", "--json", "child profile restored invocation",
    ], environment);
    expect(restoredRun.code).toBe(0);

    fixture.holdGovernance(4);
    const detachedResult = await world.command([
      "profile", "propose",
      proposal(
        "Recovered repository specialist",
        "Preserve bounded repository evidence across detached governance recovery.",
        "- Stay task-scoped.\n- Preserve exact evidence and unresolved outcomes after recovery.",
        "Exercise detached governance recovery without changing runtime authority.",
        "A later invocation should use one recovered immutable profile.",
        false,
      ),
      "--json",
    ], environment);
    expect(detachedResult.code).toBe(0);
    const detachedAdmission = json(detachedResult);
    expect(["validated", "reviewing"]).toContain(detachedAdmission.status);
    await fixture.waitForGovernance(4);
    const reviewing = await eventually(async () => {
      const result = await world.command(["profile", "proposals", "--json"], environment);
      if (result.code !== 0) return undefined;
      const record = json(result).find((item: any) => item.proposalId === detachedAdmission.proposalId);
      return record?.status === "reviewing" ? record : undefined;
    });
    expect(reviewing).toMatchObject({
      proposalId: detachedAdmission.proposalId,
      status: "reviewing",
      noticeDelivered: false,
      proposal: {
        reason: "Exercise detached governance recovery without changing runtime authority.",
      },
    });
    expect(reviewing.reviewHandleId).toBeTruthy();
    expect(reviewing.reviewerSessionId).toBeTruthy();
    expect(reviewing.frozenInput).toMatchObject({
      protocol: "agencity.refinement-governance-input",
      proposal: { proposalId: detachedAdmission.proposalId },
      constitution: { componentId: "agencity.product-constitution", version: 1 },
      reviewPolicy: { componentId: "agencity.refinement-governance-policy", version: 2 },
    });

    const beforeRestart = json(await world.command(["service", "status", "--json"], environment));
    const shutdown = await world.command(["service", "shutdown", "--json"], environment);
    expect(shutdown).toMatchObject({ code: 0, stderr: "" });
    expect(json(shutdown)).toEqual({ accepted: true, lifecycle: "draining" });
    fixture.releaseGovernance(4);

    const afterRecovery = await eventually(async () => {
      const result = await world.command(["profile", "proposals", "--json"], environment);
      if (result.code !== 0) return undefined;
      const record = json(result).find((item: any) => item.proposalId === detachedAdmission.proposalId);
      return record?.status === "applied" && record.noticeDelivered ? record : undefined;
    }, 30_000);
    expect(afterRecovery).toMatchObject({
      proposalId: reviewing.proposalId,
      reviewHandleId: reviewing.reviewHandleId,
      reviewerSessionId: reviewing.reviewerSessionId,
      reviewerBranchId: reviewing.reviewerBranchId,
      status: "applied",
      noticeDelivered: true,
      decision: {
        decision: "approve",
        reason: "The detached proposal remains bounded across service recovery.",
      },
      proposal: reviewing.proposal,
      frozenInput: reviewing.frozenInput,
    });
    const afterRestart = json(await world.command(["service", "status", "--json"], environment));
    expect(afterRestart.instanceId).not.toBe(beforeRestart.instanceId);
    expect(json(await world.command([
      "refine", "status", "--json",
    ], environment)).automaticPolicy).toMatchObject({
      automatic: false,
      scope: "local",
    });

    const finalProfile = json(await world.command(["profile", "show", "--json"], environment));
    expect(finalProfile).toMatchObject({
      revision: 5,
      role: "Recovered repository specialist",
      sourceProposalId: detachedAdmission.proposalId,
      active: true,
    });
    const finalRun = await world.command([
      "run", "--json", "child profile detached invocation",
    ], environment);
    expect(finalRun.code).toBe(0);

    const inspectionResult = await world.command(["profile", "history", "--json"], environment);
    expect(inspectionResult.code).toBe(0);
    const inspection = json(inspectionResult);
    expect(inspection.items).toHaveLength(5);
    expect(inspection.items.map((item: any) => item.revision)).toEqual([5, 4, 3, 2, 1]);
    expect(inspection.proposals).toHaveLength(4);
    expect(inspection.proposals.map((item: any) => item.status).sort()).toEqual([
      "applied", "applied", "applied", "reviewed_rejected",
    ]);
    expect(new Set(inspection.proposals.map((item: any) => item.proposalId)).size).toBe(4);
    expect(new Set(inspection.proposals.map((item: any) => item.reviewerSessionId)).size).toBe(4);
    expect(inspection.proposals.every((item: any) => item.noticeDelivered)).toBe(true);
    expect(inspection.proposals.every((item: any) =>
      item.frozenInput.constitution.digest &&
      item.frozenInput.reviewPolicy.digest &&
      item.frozenInput.reviewerDispatch.configuration)).toBe(true);

    const finalHistoryResult = await world.command(["history", "current", "--json"], environment);
    expect(finalHistoryResult.code).toBe(0);
    expect(Buffer.byteLength(finalHistoryResult.stdout)).toBeGreaterThan(200_000);
    expect(finalHistoryResult.stdout.endsWith("\n")).toBe(true);
    const finalHistory = json(finalHistoryResult);
    expect(finalHistory.runs.map((run: any) => run.profilePin.profileVersionId)).toEqual([
      initial.profileVersionId,
      initial.profileVersionId,
      approvedProfile.profileVersionId,
      restored.profileVersionId,
      finalProfile.profileVersionId,
    ]);

    const terminalInspection = await world.commandWithInput([], "/quit\n", environment);
    expect(terminalInspection).toMatchObject({ code: 0, stderr: "" });
    expect(terminalInspection.stdout).toContain(
      "Mode: trusted-local; generated code has this process's OS authority (not sandboxed)",
    );
    expect(terminalInspection.stdout).toContain(
      "Reviewer approval establishes policy consistency, not proven improvement.",
    );

    expect(fixture.count(rootTask)).toBe(2);
    expect(fixture.count("child profile baseline invocation")).toBe(1);
    expect(fixture.count("child profile approved invocation")).toBe(1);
    expect(fixture.count("child profile restored invocation")).toBe(1);
    expect(fixture.count("child profile detached invocation")).toBe(1);
    expect(fixture.countGovernance()).toBe(4);
    expect(fixture.requests.filter(item => item.governanceStep !== null).every(item =>
      item.toolNames.length === 1 &&
      item.toolNames[0] === "agencity_submit_refinement_governance_decision" &&
      item.toolChoice === "required" &&
      item.parallelToolCalls === false)).toBe(true);
  }, 120_000);
});

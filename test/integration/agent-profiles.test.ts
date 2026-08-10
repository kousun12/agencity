import { afterEach, describe, expect, test } from "bun:test";
import {
  AGENT_PROFILE_BOUNDS,
  AGENT_TOOL_SELECTION_POLICY,
  AgentClient,
  BASE_POLICY,
  InProcessProtocolTransport,
  ProtocolServer,
  ScriptedAgentActionProvider,
  Supervisor,
  PROVIDER_INPUT_ESTIMATOR_ID,
  agentProfilePin,
  buildProviderInputCandidate,
  estimateProviderInputCandidate,
  registerBrokeredSecret,
  renderExactAgentPrompt,
  sha256,
  type EventPayloads,
  type JsonValue,
  type ModelProvider,
  type AgentProfileVersion,
} from "../../src/index.ts";
import {
  FIXTURE_EFFECTIVE_SYSTEM_PROMPT,
  fixturePromptProvenanceForPin,
  makeTempRuntime,
  removeTempRuntime,
  type TempRuntime,
} from "../helpers.ts";
import {
  ApprovingGovernanceProvider,
  approveProfileRevision,
} from "../governance-provider.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

async function open(prefix: string, provider?: ModelProvider): Promise<Supervisor> {
  const temp = await makeTempRuntime(prefix);
  temps.push(temp);
  return Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    recover: false,
    ...(provider ? { modelProviders: [provider] } : {}),
  });
}

describe("durable agent profiles", () => {
  test("renders deterministically, enforces UTF-8 bounds, and rejects known secrets without echo", async () => {
    const normalized = renderExactAgentPrompt({
      role: " Reviewer\r\n",
      purpose: "Review one bounded change.\r\n",
      instructions: "- Cite evidence.\r\n- Preserve uncertainty.\r\n",
    });
    expect(normalized).toBe("Role: Reviewer\nPurpose: Review one bounded change.\nInstructions:\n- Cite evidence.\n- Preserve uncertainty.");
    expect(sha256(normalized)).toMatch(/^[a-f0-9]{64}$/);
    expect(renderExactAgentPrompt({
      role: "Reviewer",
      purpose: "Review one bounded change.",
      instructions: "- Cite evidence.\n- Preserve uncertainty.",
    })).toBe(normalized);
    expect(() => renderExactAgentPrompt({
      role: "x".repeat(AGENT_PROFILE_BOUNDS.roleBytes + 1),
      purpose: "bounded",
      instructions: "bounded",
    })).toThrow(`exceeds ${AGENT_PROFILE_BOUNDS.roleBytes}`);

    const secret = "profile-secret-value-12345";
    const release = registerBrokeredSecret(secret);
    const supervisor = await open("agencity-agent-profile-secret-");
    try {
      let message = "";
      try {
        await supervisor.createSession({
          workspaceId: "secret",
          agentProfile: { role: "Worker", purpose: "Test rejection.", instructions: `Never reveal ${secret}` },
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("Brokered credentials cannot enter an agent profile");
      expect(message).not.toContain(secret);
      expect(await supervisor.storage.listBranches()).toEqual([]);
    } finally {
      release();
      await supervisor.close();
    }
  });

  test("atomically admits complete root profiles and keeps normal inspection small", async () => {
    const supervisor = await open("agencity-agent-profile-root-");
    try {
      const input = {
        role: "Release verifier",
        purpose: "Verify one repository release.",
        instructions: "- Run attributable checks.\n- Report skips separately.",
      };
      const session = await supervisor.createSession({
        workspaceId: "profiles",
        sessionId: "profile-root",
        branchId: "main",
        agentProfile: input,
      });
      await expect(supervisor.createSession({
        workspaceId: "profiles",
        sessionId: "profile-root",
        branchId: "main",
        agentProfile: input,
      })).resolves.toEqual(session);
      await expect(supervisor.createSession({
        workspaceId: "profiles",
        sessionId: "profile-root",
        branchId: "main",
        agentProfile: { ...input, purpose: "Different durable meaning." },
      })).rejects.toThrow("different durable meaning");

      const created = (await supervisor.storage.loadEvents(session.sessionId))[0]!;
      expect(created.type).toBe("SessionCreated");
      const initial = (created.payload as EventPayloads["SessionCreated"]).agentProfile;
      expect(initial).toMatchObject({
        agentSessionId: session.sessionId,
        revision: 1,
        role: input.role,
        purpose: input.purpose,
        promptContractId: "agencity.agent-profile.v1",
        createdBy: { kind: "user", profileId: supervisor.device.profileId },
      });
      expect(initial.exactAgentPrompt).toBe(renderExactAgentPrompt(input));
      expect(initial.promptDigest).toBe(sha256(initial.exactAgentPrompt));

      const summary = await supervisor.agentProfiles.get(session.sessionId);
      expect(summary).not.toHaveProperty("exactAgentPrompt");
      expect(summary).not.toHaveProperty("instructions");
      const detail = await supervisor.agentProfiles.get(session.sessionId, { includePrompt: true });
      expect(detail).toMatchObject({ exactAgentPrompt: initial.exactAgentPrompt, instructions: input.instructions });
      expect((await supervisor.agentProfiles.list(session.sessionId)).items[0]).not.toHaveProperty("exactAgentPrompt");
      const client = new AgentClient(new InProcessProtocolTransport(new ProtocolServer(supervisor)));
      expect(await client.agentProfile(session.sessionId)).not.toHaveProperty("exactAgentPrompt");
      expect(await client.agentProfile(session.sessionId, true)).toMatchObject({ exactAgentPrompt: initial.exactAgentPrompt });
    } finally {
      await supervisor.close();
    }
  });

  test("serializes concurrent root admission by session identity", async () => {
    const supervisor = await open("agencity-agent-profile-root-concurrency-");
    try {
      const options = {
        workspaceId: "concurrent-roots",
        sessionId: "concurrent-root",
        agentProfile: {
          role: "Concurrent verifier",
          purpose: "Verify one stable root admission.",
          instructions: "- Preserve one canonical identity.",
        },
      };
      const [first, second] = await Promise.all([
        supervisor.createSession(options),
        supervisor.createSession(options),
      ]);
      expect(second).toEqual(first);
      const created = (await supervisor.storage.loadEvents(options.sessionId))
        .filter((event) => event.type === "SessionCreated");
      expect(created).toHaveLength(1);
      expect((created[0]!.payload as EventPayloads["SessionCreated"]).agentProfile.createdAt)
        .toBe((await supervisor.agentProfiles.active(options.sessionId)).createdAt);

      const competing = await Promise.allSettled([
        supervisor.createSession({
          workspaceId: "concurrent-roots",
          sessionId: "competing-root",
          agentProfile: { role: "First", purpose: "Win one admission.", instructions: "- Stay first." },
        }),
        supervisor.createSession({
          workspaceId: "concurrent-roots",
          sessionId: "competing-root",
          agentProfile: { role: "Second", purpose: "Win another admission.", instructions: "- Stay second." },
        }),
      ]);
      expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(competing.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect((await supervisor.storage.loadEvents("competing-root"))
        .filter((event) => event.type === "SessionCreated")).toHaveLength(1);
    } finally {
      await supervisor.close();
    }
  });

  test("rejects direct-service and forged-event profile activation bypasses", async () => {
    const supervisor = await open("agencity-agent-profile-bypass-");
    try {
      const root = await supervisor.createSession({ workspaceId: "profile-bypass" });
      const active = await supervisor.agentProfiles.active(root.sessionId);
      expect((supervisor.agentProfiles as any).prepareApproved).toBeUndefined();
      const input = {
        role: active.role,
        purpose: active.purpose,
        instructions: "Invented governance must not activate.",
      };
      const exactAgentPrompt = renderExactAgentPrompt(input);
      const forged: AgentProfileVersion = {
        ...input,
        profileVersionId: "forged-profile-version",
        agentSessionId: root.sessionId,
        revision: 2,
        exactAgentPrompt,
        promptContractId: "agencity.agent-profile.v1",
        promptDigest: sha256(exactAgentPrompt),
        createdBy: { kind: "user", profileId: supervisor.device.profileId },
        sourceSpecEntryId: null,
        sourceSpecVersionId: null,
        reason: "Invented reviewed proposal.",
        evidenceEventIds: [],
        supersedesProfileVersionId: active.profileVersionId,
        restoresProfileVersionId: null,
        sourceProposalId: "missing-proposal",
        reviewDecisionId: "missing-decision",
        createdAt: new Date().toISOString(),
      };
      await expect(supervisor.storage.appendEvents([{
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "AgentProfileVersionCreated",
        producer: "supervisor",
        idempotencyKey: "forged-profile-version",
        payload: {
          agentProfile: forged,
          expectedActiveProfileVersionId: active.profileVersionId,
        },
      }, {
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "AgentProfileActivated",
        producer: "supervisor",
        idempotencyKey: "forged-profile-activation",
        payload: {
          profileVersionId: forged.profileVersionId,
          expectedActiveProfileVersionId: active.profileVersionId,
          reason: forged.reason,
        },
      }])).rejects.toThrow(/reviewed_approved governed proposal/i);
      expect((await supervisor.agentProfiles.active(root.sessionId)).profileVersionId)
        .toBe(active.profileVersionId);
    } finally {
      await supervisor.close();
    }
  });

  test("materializes sealed and explicit child profiles and compares them during idempotent admission", async () => {
    const supervisor = await open("agencity-agent-profile-child-");
    try {
      const root = await supervisor.createSession({ workspaceId: "children" });
      const sealed = await supervisor.agents.spawn(root.sessionId, root.branchId, {
        task: "Inspect one file",
        idempotencyKey: "sealed-child",
      });
      const sealedProfile = await supervisor.agentProfiles.active(sealed.sessionId);
      expect(sealedProfile).toMatchObject({
        role: "Task specialist",
        sourceSpecEntryId: null,
        sourceSpecVersionId: null,
        createdBy: { kind: "agent", sessionId: root.sessionId, branchId: root.branchId },
      });

      const explicit = { role: "Test analyst", purpose: "Analyze one failing test.", instructions: "- Stay within the admitted test." };
      const first = await supervisor.agents.spawn(root.sessionId, root.branchId, {
        task: "Analyze failure",
        profile: explicit,
        idempotencyKey: "explicit-child",
      });
      const again = await supervisor.agents.spawn(root.sessionId, root.branchId, {
        task: "Analyze failure",
        profile: explicit,
        idempotencyKey: "explicit-child",
      });
      expect(again.sessionId).toBe(first.sessionId);
      await expect(supervisor.agents.spawn(root.sessionId, root.branchId, {
        task: "Analyze failure",
        profile: { ...explicit, instructions: "- Broaden the task." },
        idempotencyKey: "explicit-child",
      })).rejects.toThrow("different agent profile");
    } finally {
      await supervisor.close();
    }
  });

  test("rejects missing and forged invocation profile pins", async () => {
    const provider = new ScriptedAgentActionProvider([], "profile-pin-adversary");
    const supervisor = await open("agencity-agent-profile-pin-adversary-", provider);
    try {
      const root = await supervisor.createSession({
        workspaceId: "pin-adversary",
        model: { provider: provider.name, model: "v1" },
      });
      const rootProfile = await supervisor.agentProfiles.active(root.sessionId);
      await expect(supervisor.storage.appendEvents([{
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "AgentRunRequested",
        producer: "client",
        idempotencyKey: "forged-run:missing-pin",
        payload: { runId: "forged-run-missing-pin", task: "forged", requestKey: "forged-run-missing-pin" } as any,
      }])).rejects.toThrow("Invalid AgentRunRequested payload");
      await expect(supervisor.storage.appendEvents([{
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "AgentRunRequested",
        producer: "client",
        idempotencyKey: "forged-run:wrong-pin",
        payload: {
          runId: "forged-run-wrong-pin",
          task: "forged",
          requestKey: "forged-run-wrong-pin",
          profilePin: { ...agentProfilePin(rootProfile), profileVersionId: "missing-profile" },
        },
      }])).rejects.toThrow("does not reference a retained profile version");

      const handle = await supervisor.models.start(root.sessionId, root.branchId, {
        prompt: "Retain one recursive handle",
        idempotencyKey: "pin-adversary-handle",
        run: false,
      });
      const parentEvents = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      const started = parentEvents.find((event) => event.type === "RecursiveModelStarted")!;
      const startedPayload = started.payload as EventPayloads["RecursiveModelStarted"];
      const { profilePin: _omittedProfilePin, ...missingPinPayload } = startedPayload;
      await expect(supervisor.storage.appendEvents([{
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "RecursiveModelStarted",
        producer: "supervisor",
        idempotencyKey: "forged-recursive:missing-pin",
        payload: { ...missingPinPayload, handleId: "forged-recursive-missing-pin" } as any,
      }])).rejects.toThrow("Invalid RecursiveModelStarted payload");
      await expect(supervisor.storage.appendEvents([{
        sessionId: root.sessionId,
        branchId: root.branchId,
        type: "RecursiveModelStarted",
        producer: "supervisor",
        idempotencyKey: "forged-recursive:wrong-pin",
        payload: {
          ...startedPayload,
          handleId: "forged-recursive-wrong-pin",
          profilePin: { ...handle.profilePin, agentPromptDigest: "f".repeat(64) },
        },
      }])).rejects.toThrow("does not match the child admission profile");

      const promptProvenance = fixturePromptProvenanceForPin(
        handle.profilePin,
        "missing-recursive-handle",
      );
      await supervisor.storage.appendEvents([{
        sessionId: handle.childSessionId,
        branchId: handle.childBranchId,
        type: "ContextMaterialized",
        producer: "supervisor",
        idempotencyKey: "forged-recursive-context",
        payload: {
          contextId: "forged-recursive-context",
          records: [],
          contentHash: sha256(FIXTURE_EFFECTIVE_SYSTEM_PROMPT),
          context: { messages: [{ role: "system", content: FIXTURE_EFFECTIVE_SYSTEM_PROMPT }] },
          promptProvenance,
        },
      }]);
      const childState = await supervisor.projections.getSnapshot(handle.childSessionId, handle.childBranchId);
      const modelDispatch = supervisor.modelExecutor.resolveDispatch(childState.state.model);
      const resolvedCapacity = supervisor.modelExecutor.contextCapacity(childState.state.model);
      const contextWindow = {
        ...resolvedCapacity,
        outputReserveTokens: childState.state.model.maxOutputTokens ?? 0,
        estimatorId: PROVIDER_INPUT_ESTIMATOR_ID,
        triggerRatio: 0.8,
        targetRatio: 0.6,
      };
      const providerInput = buildProviderInputCandidate({
        context: { messages: [{ role: "system", content: FIXTURE_EFFECTIVE_SYSTEM_PROMPT }] },
        modelDispatch,
        capacity: contextWindow,
      });
      await expect(supervisor.storage.appendEvents([{
        sessionId: handle.childSessionId,
        branchId: handle.childBranchId,
        type: "ModelCallRequested",
        producer: "supervisor",
        idempotencyKey: "forged-recursive-call",
        payload: {
          callId: "forged-recursive-call",
          contextId: "forged-recursive-context",
          effectId: "forged-recursive-effect",
          modelDispatch,
          providerInput,
          estimatedInputTokens: estimateProviderInputCandidate(providerInput).estimatedTokens,
          promptProvenance,
          contextWindow,
        },
      }])).rejects.toThrow("does not match its retained handle invocation pin");
    } finally {
      await supervisor.close();
    }
  });

  test("pins one profile and effective prompt across context, call, effect, and recovery boundaries", async () => {
    const provider = new ApprovingGovernanceProvider("profile-prompt-provider");
    const supervisor = await open("agencity-agent-profile-prompt-", provider);
    try {
      const session = await supervisor.createSession({
        workspaceId: "prompt",
        model: { provider: provider.name, model: "v1" },
        agentProfile: { role: "Pinned reviewer", purpose: "Review one task.", instructions: "- Verify before finishing." },
      });
      const admitted = await supervisor.runs.admit(session.sessionId, session.branchId, {
        task: "Finish once",
        requestKey: "profile-run-one",
      });
      const firstProfile = await supervisor.agentProfiles.active(session.sessionId);
      expect((await supervisor.runs.get(session.sessionId, session.branchId, admitted.runId)).status).toBe("queued");

      const replacementInput = { role: "Later reviewer", purpose: "Review later tasks.", instructions: "- Use the later profile." };
      const replacement = await approveProfileRevision(
        supervisor,
        session.sessionId,
        session.branchId,
        replacementInput,
        "profile-prompt-v2",
      );
      expect((await supervisor.agentProfiles.active(session.sessionId)).profileVersionId).toBe(replacement.profileVersionId);

      await supervisor.runs.advance(session.sessionId, session.branchId, admitted.runId);
      const firstHistory = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId });
      const firstRun = firstHistory.find((event) => event.type === "AgentRunRequested" &&
        (event.payload as EventPayloads["AgentRunRequested"]).runId === admitted.runId)!;
      expect((firstRun.payload as EventPayloads["AgentRunRequested"]).profilePin).toEqual(agentProfilePin(firstProfile));
      const context = firstHistory.find((event) => event.type === "ContextMaterialized" &&
        (event.payload as EventPayloads["ContextMaterialized"]).promptProvenance?.invocationId === admitted.runId)!;
      const contextPayload = context.payload as EventPayloads["ContextMaterialized"];
      const call = firstHistory.find((event) => event.type === "ModelCallRequested" &&
        (event.payload as EventPayloads["ModelCallRequested"]).promptProvenance.invocationId === admitted.runId)!;
      const callPayload = call.payload as EventPayloads["ModelCallRequested"];
      expect(contextPayload.promptProvenance).toEqual(callPayload.promptProvenance);
      expect(contextPayload.promptProvenance?.profileVersionId).toBe(firstProfile.profileVersionId);
      const providerContext = contextPayload.context as Record<string, JsonValue>;
      const system = (providerContext.messages as Array<{ role: string; content: string }>)[0]!.content;
      expect(system.indexOf(BASE_POLICY)).toBe(0);
      expect(system.indexOf(firstProfile.exactAgentPrompt)).toBeGreaterThan(system.indexOf(BASE_POLICY));
      expect(system.indexOf(AGENT_TOOL_SELECTION_POLICY)).toBeGreaterThan(system.indexOf(firstProfile.exactAgentPrompt));
      expect(system.indexOf("The only executable action is a TypeScript cell.")).toBeGreaterThan(system.indexOf(AGENT_TOOL_SELECTION_POLICY));
      expect(sha256(system)).toBe(contextPayload.promptProvenance!.effectiveSystemPromptDigest);
      const effect = firstHistory.find((event) => event.type === "EffectRequested" &&
        (event.payload as EventPayloads["EffectRequested"]).effectId === callPayload.effectId)!;
      expect(((effect.payload as EventPayloads["EffectRequested"]).input as Record<string, JsonValue>).promptProvenance)
        .toEqual(callPayload.promptProvenance as unknown as JsonValue);
      const tamperedContext = JSON.parse(JSON.stringify(contextPayload.context)) as Record<string, JsonValue>;
      const tamperedMessages = tamperedContext.messages as Array<{ role: string; content: string }>;
      tamperedMessages[0] = { ...tamperedMessages[0]!, content: `${tamperedMessages[0]!.content}\nforged` };
      await expect(supervisor.storage.appendEvents([{
        sessionId: session.sessionId,
        branchId: session.branchId,
        type: "ContextMaterialized",
        producer: "supervisor",
        idempotencyKey: "profile-context:tampered-system",
        payload: {
          ...contextPayload,
          contextId: "profile-context-tampered-system",
          context: tamperedContext,
          contentHash: sha256(JSON.stringify(tamperedContext)),
        },
      }])).rejects.toThrow("Effective system prompt digest does not match");
      await expect(supervisor.storage.appendEvents([{
        sessionId: session.sessionId,
        branchId: session.branchId,
        type: "ContextMaterialized",
        producer: "supervisor",
        idempotencyKey: "profile-context:tampered-digest",
        payload: {
          ...contextPayload,
          contextId: "profile-context-tampered-digest",
          promptProvenance: {
            ...contextPayload.promptProvenance!,
            effectiveSystemPromptDigest: "f".repeat(64),
          },
        },
      }])).rejects.toThrow("Effective system prompt digest does not match");
      await expect(supervisor.storage.appendEvents([{
        sessionId: session.sessionId,
        branchId: session.branchId,
        type: "ModelCallRequested",
        producer: "supervisor",
        idempotencyKey: "profile-call:tampered-context-pin",
        payload: {
          ...callPayload,
          callId: "profile-call-tampered-context-pin",
          effectId: "profile-effect-tampered-context-pin",
          promptProvenance: {
            ...callPayload.promptProvenance,
            effectiveSystemPromptDigest: "f".repeat(64),
          },
        },
      }])).rejects.toThrow("must exactly match its retained context");

      await supervisor.runs.start(session.sessionId, session.branchId, {
        task: "Finish later",
        requestKey: "profile-run-two",
      });
      const secondRun = (await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId }))
        .filter((event) => event.type === "AgentRunRequested")
        .at(-1)!;
      expect((secondRun.payload as EventPayloads["AgentRunRequested"]).profilePin.profileVersionId)
        .toBe(replacement.profileVersionId);

      await supervisor.storage.rebuildOperationalProjections?.();
      expect((await supervisor.agentProfiles.active(session.sessionId)).profileVersionId).toBe(replacement.profileVersionId);
      expect(await supervisor.storage.readonlyQuery({
        sql: "SELECT active_profile_version_id FROM workspace_agent_profiles WHERE agent_session_id=?",
        args: [session.sessionId],
      })).toEqual([{ active_profile_version_id: replacement.profileVersionId }]);
    } finally {
      await supervisor.close();
    }
  });

  test("projects session-wide profile activation into forks and branch subscriptions", async () => {
    const provider = new ApprovingGovernanceProvider("profile-fork-provider");
    const supervisor = await open("agencity-agent-profile-fork-", provider);
    try {
      const root = await supervisor.createSession({ workspaceId: "profile-fork", model: { provider: provider.name, model: "v1" } });
      await supervisor.appendMessage(root.sessionId, root.branchId, "user", "fork before activation");
      const rootHistory = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      const forkBranchId = await supervisor.fork(root.sessionId, root.branchId, rootHistory.at(-1)!.cursor);
      const before = await supervisor.projections.getSnapshot(root.sessionId, forkBranchId);
      const initial = await supervisor.agentProfiles.active(root.sessionId);
      expect(before.state.activeAgentProfileVersionId).toBe(initial.profileVersionId);

      const observed: string[] = [];
      const unsubscribe = supervisor.projections.subscribe(
        root.sessionId,
        forkBranchId,
        before.cursor,
        (event) => {
          if (event.type === "AgentProfileVersionCreated" ||
              event.type === "AgentProfileActivated") observed.push(event.id);
        },
      );
      const input = {
        role: "Fork-visible reviewer",
        purpose: "Provide standing behavior to every branch.",
        instructions: "- Keep profile identity session-wide.",
      };
      const beforeIds = new Set((await supervisor.storage.loadEvents(root.sessionId)).map((event) => event.id));
      const replacement = await approveProfileRevision(
        supervisor,
        root.sessionId,
        root.branchId,
        input,
        "fork-profile-v2",
      );
      const committed = (await supervisor.storage.loadEvents(root.sessionId))
        .filter((event) => !beforeIds.has(event.id) &&
          (event.type === "AgentProfileVersionCreated" || event.type === "AgentProfileActivated"));
      const deadline = Date.now() + 2_000;
      while (observed.length < 2 && Date.now() < deadline) await Bun.sleep(5);
      unsubscribe();
      expect(observed).toEqual(committed.map((event) => event.id));

      const after = await supervisor.projections.getSnapshot(root.sessionId, forkBranchId);
      expect(after.state.branch.id).toBe(forkBranchId);
      expect(after.state.activeAgentProfileVersionId).toBe(replacement.profileVersionId);
      expect(after.state.agentProfiles[replacement.profileVersionId]?.promptDigest).toBe(replacement.promptDigest);
      const forkHistory = await supervisor.storage.loadEvents(root.sessionId, { branchId: forkBranchId });
      for (const event of committed) {
        expect(forkHistory.filter((candidate) => candidate.id === event.id)).toHaveLength(1);
        expect(forkHistory.find((candidate) => candidate.id === event.id)?.branchId).toBe(root.branchId);
      }
    } finally {
      await supervisor.close();
    }
  });

  test("pins explicit recursive helper profiles to the handle and every child call", async () => {
    const provider = new ApprovingGovernanceProvider("unused-profile-recursive");
    const supervisor = await open("agencity-agent-profile-recursive-", provider);
    try {
      const root = await supervisor.createSession({ workspaceId: "recursive", model: { provider: provider.name, model: "v1" } });
      const handle = await supervisor.models.start(root.sessionId, root.branchId, {
        prompt: "Inspect bounded input",
        idempotencyKey: "recursive-profile",
        profile: {
          role: "Input inspector",
          purpose: "Inspect one bounded recursive input.",
          instructions: "- Return only attributable findings.",
        },
      });
      const child = await supervisor.agentProfiles.active(handle.childSessionId);
      expect(handle.profilePin).toEqual(agentProfilePin(child));
      expect(child).toMatchObject({ role: "Input inspector", purpose: "Inspect one bounded recursive input." });
      const parent = await supervisor.storage.loadEvents(root.sessionId, { branchId: root.branchId });
      const started = parent.find((event) => event.type === "RecursiveModelStarted")!;
      expect((started.payload as EventPayloads["RecursiveModelStarted"]).profilePin).toEqual(handle.profilePin);
      expect((await supervisor.models.result(handle.handleId, { wait: true, timeoutMs: 2_000 })).outcome).toBe("succeeded");
      const childHistory = await supervisor.storage.loadEvents(handle.childSessionId, { branchId: handle.childBranchId });
      const call = childHistory.find((event) => event.type === "ModelCallRequested")!;
      const provenance = (call.payload as EventPayloads["ModelCallRequested"]).promptProvenance;
      expect(provenance).toMatchObject({
        invocationKind: "recursive-model",
        invocationId: handle.handleId,
        profileVersionId: child.profileVersionId,
        agentPromptDigest: child.promptDigest,
      });

      const laterInput = {
        role: "Later input inspector",
        purpose: "Inspect later recursive work.",
        instructions: "- Use the later standing behavior.",
      };
      const later = await approveProfileRevision(
        supervisor,
        handle.childSessionId,
        handle.childBranchId,
        laterInput,
        "recursive-profile-later",
      );
      const wrongHandleProvenance = fixturePromptProvenanceForPin(
        {
          profileVersionId: later.profileVersionId,
          agentPromptDigest: later.promptDigest,
        },
        handle.handleId,
      );
      wrongHandleProvenance.components.agentProfile.version = later.revision;
      await supervisor.storage.appendEvents([{
        sessionId: handle.childSessionId,
        branchId: handle.childBranchId,
        type: "ContextMaterialized",
        producer: "supervisor",
        idempotencyKey: "recursive-later-profile-context",
        payload: {
          contextId: "recursive-later-profile-context",
          records: [],
          contentHash: sha256(FIXTURE_EFFECTIVE_SYSTEM_PROMPT),
          context: { messages: [{ role: "system", content: FIXTURE_EFFECTIVE_SYSTEM_PROMPT }] },
          promptProvenance: wrongHandleProvenance,
        },
      }]);
      const retainedCall = call.payload as EventPayloads["ModelCallRequested"];
      const { retryOfCallId: _retryOfCallId, ...retainedInitialCall } = retainedCall;
      const laterProviderInput = buildProviderInputCandidate({
        context: { messages: [{ role: "system", content: FIXTURE_EFFECTIVE_SYSTEM_PROMPT }] },
        modelDispatch: retainedCall.modelDispatch,
        capacity: retainedCall.contextWindow!,
      });
      await expect(supervisor.storage.appendEvents([{
        sessionId: handle.childSessionId,
        branchId: handle.childBranchId,
        type: "ModelCallRequested",
        producer: "supervisor",
        idempotencyKey: "recursive-later-profile-call",
        payload: {
          ...retainedInitialCall,
          callId: "recursive-later-profile-call",
          contextId: "recursive-later-profile-context",
          effectId: "recursive-later-profile-effect",
          promptProvenance: wrongHandleProvenance,
          providerInput: laterProviderInput,
          estimatedInputTokens:
            estimateProviderInputCandidate(laterProviderInput).estimatedTokens,
          attempt: 1,
        },
      }])).rejects.toThrow("does not match its retained handle invocation pin");

      const retried = await supervisor.models.start(root.sessionId, root.branchId, {
        prompt: "Inspect bounded input",
        idempotencyKey: "recursive-profile",
        profile: {
          role: "Input inspector",
          purpose: "Inspect one bounded recursive input.",
          instructions: "- Return only attributable findings.",
        },
      });
      expect(retried.handleId).toBe(handle.handleId);
      expect(retried.childSessionId).toBe(handle.childSessionId);
      expect(retried.profilePin.profileVersionId).toBe(child.profileVersionId);
    } finally {
      await supervisor.close();
    }
  });
});

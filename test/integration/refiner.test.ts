import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { AgentClient, LibSqlStorage, ProtocolServer, REFINEMENT_REVIEW_CONTRACT_ID, REFINEMENT_REVIEW_TOOL_NAME, Supervisor, TerminalUI, canonicalJsonByteLength, canonicalJsonDigest, createModelEffectOutputV2, createRefinementReviewRecursiveResult, deriveModelContractDiagnostics, encodeRefinementReviewTransportValue, projectEvents, registerBrokeredSecret, type JsonValue, type ModelConfiguration, type ModelDispatch, type ModelEffectOutputV2, type ModelProvider, type RefinementReviewDecision, type TextModelResponse } from "../../src/index.ts";
import { ModelProviderResponseFailureError, formalMissingToolOutput, formalOutputFromAgentAction, formalOutputFromRefinementReviewSubmission } from "../../src/executors/model-response.ts";
import { internalStructuredModelTurn } from "../../src/runtime/internal.ts";
import { makeTempRuntime, removeTempRuntime, waitFor, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

class ReviewProvider implements ModelProvider {
  readonly capabilities = {
    streaming: false,
    requiredToolSet: {
      status: "provider-strict",
      requiredChoice: "provider-enforced",
      parallelCalls: "provider-disabled",
      streaming: true,
      adapter: "agencity.refiner-test.formal.v1",
    },
  } as const;
  calls = 0;
  runCalls = 0;
  evidenceEventId = "";
  requestedScopeKey = "";
  targetEntryId = "";
  targetVersionId = "";
  constructor(readonly name: string, readonly decision: "no_change" | "propose" | "replace" | "malformed" | "overscope" | "no_evidence" = "no_change") {}
  async complete(_context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<TextModelResponse> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return { text: "done", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 2, costUsd: 0 } };
  }
  async streamResponse(context: JsonValue, dispatch: ModelDispatch, signal: AbortSignal): Promise<ModelEffectOutputV2> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (dispatch.responseContract.kind === "required-tool-set" &&
        dispatch.responseContract.contractId === REFINEMENT_REVIEW_CONTRACT_ID) {
      this.calls++;
      const reviewId = JSON.stringify(context).match(/refinement-review-[a-f0-9]{32}/)?.[0];
      if (!reviewId) throw new Error("missing review ID");
      const usage = { inputTokens: 2, outputTokens: 2, costUsd: 0 };
      if (this.decision === "malformed") {
        return formalMissingToolOutput({
          dispatch,
          provider: this.name,
          adapter: this.capabilities.requiredToolSet.adapter,
          text: `not-a-formal-call ${reviewId}`,
          usage,
        });
      }
      const evidenceIds = this.decision === "no_evidence"
        ? ["event-not-visible"]
        : [this.evidenceEventId];
      const decision: RefinementReviewDecision = this.decision === "no_change"
        ? {
            protocol: "agencity.refinement-review",
            version: 1,
            reviewId,
            status: "no_change",
            reason: "No evidence-backed update is necessary.",
            evidenceEventIds: [],
          }
        : {
            protocol: "agencity.refinement-review",
            version: 1,
            reviewId,
            status: "propose",
            trigger: "Retained user evidence supports a small prompt note",
            predictedEffect: "Keep future work tied to retained evidence",
            edits: this.decision === "replace"
              ? [{
                  operation: "replace",
                  entryId: this.targetEntryId,
                  expectedVersionId: this.targetVersionId,
                  content: {
                    kind: "memory",
                    memoryKind: "claim",
                    text: "Use the corrected retained fact.",
                  },
                  evidenceEventIds: evidenceIds,
                }]
              : [{
                  operation: "create",
                  kind: "prompt_note",
                  scope: this.decision === "overscope" ? "global" : "local",
                  scopeKey: this.decision === "overscope"
                    ? "global"
                    : this.requestedScopeKey,
                  name: "evidence-discipline",
                  content: {
                    kind: "prompt_note",
                    text: "Cite retained evidence before claiming completion.",
                  },
                  evidenceEventIds: evidenceIds,
                }],
            evidenceEventIds: evidenceIds,
            evaluation: {
              kind: "objective",
              name: "retained-evidence-check",
              metric: "verification command succeeds",
              target: true,
            },
          };
      return formalOutputFromRefinementReviewSubmission({
        transportInput: encodeRefinementReviewTransportValue(decision),
        dispatch,
        providerToolCallId: `refinement-review-${this.calls}`,
        provider: this.name,
        adapter: this.capabilities.requiredToolSet.adapter,
        usage,
      });
    }
    this.runCalls++;
    return formalOutputFromAgentAction({
      action: { protocol: "agencity.agent-action", version: 1, type: "final", content: "done" },
      dispatch,
      providerToolCallId: `refiner-run-${this.runCalls}`,
      provider: this.name,
      adapter: this.capabilities.requiredToolSet.adapter,
      usage: { inputTokens: 2, outputTokens: 2, costUsd: 0 },
    });
  }
}

class FailingReviewProvider extends ReviewProvider {
  override async streamResponse(
    context: JsonValue,
    dispatch: ModelDispatch,
    signal: AbortSignal,
  ): Promise<ModelEffectOutputV2> {
    if (dispatch.responseContract.kind === "required-tool-set" &&
        dispatch.responseContract.contractId === REFINEMENT_REVIEW_CONTRACT_ID) {
      throw new ModelProviderResponseFailureError(
        "provider-request-failed",
        this.name,
        dispatch.configuration.model,
        "fixture provider rejected refinement",
      );
    }
    return super.streamResponse(context, dispatch, signal);
  }
}

class BlockingReviewProvider extends ReviewProvider {
  active = false;
  override async streamResponse(
    context: JsonValue,
    dispatch: ModelDispatch,
    signal: AbortSignal,
  ): Promise<ModelEffectOutputV2> {
    if (dispatch.responseContract.kind === "required-tool-set" &&
        dispatch.responseContract.contractId === REFINEMENT_REVIEW_CONTRACT_ID) {
      this.active = true;
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      } finally {
        this.active = false;
      }
    }
    return super.streamResponse(context, dispatch, signal);
  }
}

class SecretReviewProvider extends ReviewProvider {
  constructor(
    name: string,
    readonly secret: string,
    readonly placement: "input" | "raw-reason" = "input",
  ) { super(name); }
  override async streamResponse(
    context: JsonValue,
    dispatch: ModelDispatch,
    signal: AbortSignal,
  ): Promise<ModelEffectOutputV2> {
    if (dispatch.responseContract.kind === "required-tool-set" &&
        dispatch.responseContract.contractId === REFINEMENT_REVIEW_CONTRACT_ID) {
      const contract = dispatch.responseContract;
      // Hand-built structurally valid output that bypasses the product
      // adapters' input acceptance checks, exactly like a hostile or buggy
      // custom provider could.
      const input = encodeRefinementReviewTransportValue({
        protocol: "agencity.refinement-review",
        version: 1,
        reviewId: "refinement-review-secret",
        status: "no_change",
        reason: this.placement === "input"
          ? `Continue with credential ${this.secret} attached.`
          : "No attributable change is justified.",
        evidenceEventIds: [],
      });
      const inputDigest = canonicalJsonDigest(input);
      const inputBytes = canonicalJsonByteLength(input);
      const termination = {
        kind: "tool-calls" as const,
        rawReason: this.placement === "raw-reason"
          ? `stop:${this.secret}`
          : "tool_calls",
      };
      const transport = {
        provider: this.name,
        adapter: this.capabilities.requiredToolSet.adapter,
      };
      return createModelEffectOutputV2({
        response: {
          kind: "complete",
          blocks: [{
            type: "tool-call",
            callId: "secret-call-1",
            name: REFINEMENT_REVIEW_TOOL_NAME,
            inputDigest,
            inputBytes,
          }],
          termination,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          warnings: [],
          transport,
        },
        result: {
          kind: "tool-submission",
          submission: {
            providerToolCallId: "secret-call-1",
            name: REFINEMENT_REVIEW_TOOL_NAME,
            input,
            inputDigest,
            inputBytes,
            responseContract: {
              contractId: contract.contractId,
              version: contract.version,
              contractDigest: contract.contractDigest,
            },
            transport,
            termination,
          },
        },
        responseContract: contract,
        responseCapability: dispatch.responseCapability,
        configuredProvider: this.name,
      });
    }
    return super.streamResponse(context, dispatch, signal);
  }
}

async function fixture(provider: ReviewProvider) {
  const temp = await makeTempRuntime("agencity-refiner-"); temps.push(temp);
  const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: false });
  const root = await supervisor.createSession({ workspaceId: "refiner-workspace", model: { provider: provider.name, model: "scripted-v1" } });
  const evidence = await supervisor.appendMessage(root.sessionId, root.branchId, "user", "Retained evidence for refinement");
  provider.evidenceEventId = evidence.id;
  provider.requestedScopeKey = root.sessionId;
  return { temp, supervisor, ...root, evidence };
}

describe("FU-016 refinement review migration", () => {
  test("upgrades a database that already applied lifecycle migration 11", async () => {
    const temp = await makeTempRuntime("agencity-refiner-migration-"); temps.push(temp);
    const legacy = createClient({ url: temp.databaseUrl });
    await legacy.execute("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
    for (let version = 1; version <= 11; version++) {
      const name = (await Array.fromAsync(new Bun.Glob(`${String(version).padStart(3, "0")}_*.sql`).scan("src/storage/migrations")))[0];
      if (!name) throw new Error(`Missing migration ${version}`);
      await legacy.executeMultiple(await Bun.file(`src/storage/migrations/${name}`).text());
      await legacy.execute({ sql: "INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)", args: [version, name, "2026-08-06T00:00:00.000Z"] });
    }
    legacy.close();

    const upgraded = new LibSqlStorage({ url: temp.databaseUrl, deviceId: "migration-test-device" });
    await upgraded.migrate();
    upgraded.close();
    const inspected = createClient({ url: temp.databaseUrl });
    try {
      const columns = await inspected.execute("PRAGMA table_info(refinement_reviews)");
      const columnNames = new Set(columns.rows.map((row) => String(row.name)));
      expect(columnNames.has("trigger_evidence_through_cursor")).toBe(true);
      expect(columnNames.has("snapshot_json")).toBe(true);
      expect((await inspected.execute("SELECT version FROM schema_migrations WHERE version=12")).rows).toHaveLength(1);
      expect((await inspected.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='refinement_review_nonterminal_key'")).rows).toHaveLength(1);
    } finally { inspected.close(); }
  });
});

describe("FU-016 durable RefinerService", () => {
  test("runs a no_change review as an attributable recursive child with exact frozen sources", async () => {
    const provider = new ReviewProvider("review-no-change");
    const { supervisor, sessionId, branchId, evidence } = await fixture(provider);
    try {
      const review = await supervisor.refiner.request(sessionId, branchId, { instructions: "Review failures only" });
      expect(review.status).toBe("no_change");
      expect(review.handleId).toBeTruthy();
      expect(review.sourceEventIds).toContain(evidence.id);
      expect(review.sourceSnapshotHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(provider.calls).toBe(1);
      const events = await supervisor.storage.loadEvents(sessionId, { branchId });
      expect(events.filter((event) => event.type === "RefinementReviewRequested")).toHaveLength(1);
      expect(events.filter((event) => event.type === "RefinementReviewChildLinked")).toHaveLength(1);
      expect(projectEvents(events).refinementReviews[review.reviewId]?.status).toBe("no_change");
      const result = await supervisor.models.result(review.handleId!);
      expect(result.value).toMatchObject({
        kind: "tool-submission",
        contractId: REFINEMENT_REVIEW_CONTRACT_ID,
        toolName: "agencity_submit_refinement_review",
        submission: { reviewId: review.reviewId, status: "no_change" },
      });
      expect(result.resultMessageId).toBeUndefined();
      expect(result.resultArtifactId).toBeUndefined();
      const childEvents = await supervisor.storage.loadEvents(
        result.provenance.childSessionId,
        { branchId: result.provenance.childBranchId },
      );
      expect(childEvents.filter((event) =>
        event.type === "MessageAppended" &&
        (event.payload as { role?: string }).role === "assistant"
      )).toHaveLength(0);
      expect(childEvents.find((event) =>
        event.type === "ModelCallCompleted"
      )?.payload).toMatchObject({
        result: {
          kind: "tool-submission",
          name: "agencity_submit_refinement_review",
        },
      });
      const terminal = [...events].reverse().find((event) =>
        event.type === "RecursiveModelStatusChanged" &&
        (event.payload as { handleId?: string }).handleId === review.handleId
      )!;
      const fork = await supervisor.fork(
        sessionId,
        branchId,
        terminal.cursor,
        "structured-result-fork",
      );
      const forked = projectEvents(await supervisor.storage.loadEvents(
        sessionId,
        { branchId: fork },
      )).recursiveModels[review.handleId!];
      expect(forked?.result).toEqual(result.value);
      await supervisor.storage.rebuildOperationalProjections?.();
      expect((await supervisor.models.get(review.handleId!)).result)
        .toEqual(result.value);
    } finally { await supervisor.close(); }
  });

  test("branch diagnostics count one retained refinement submission without double counting", async () => {
    const provider = new ReviewProvider("review-diagnostic-count");
    const { supervisor, sessionId, branchId } = await fixture(provider);
    try {
      const review = await supervisor.refiner.request(sessionId, branchId, {});
      expect(review.status).toBe("no_change");
      const refinementCount = (
        view: ReturnType<typeof deriveModelContractDiagnostics>,
      ): number => view.counters.submissions.find(
        (item) => item.tool === REFINEMENT_REVIEW_TOOL_NAME,
      )!.count;

      const parentState = projectEvents(
        await supervisor.storage.loadEvents(sessionId, { branchId }),
      );
      const parent = deriveModelContractDiagnostics(parentState);
      expect(refinementCount(parent)).toBe(1);
      // The single count comes from the retained recursive result. The child's
      // model call is committed on the child branch and is absent from the
      // parent projection, so nothing can be counted twice.
      expect(Object.values(parentState.modelCalls).filter((call) =>
        call.modelDispatch.responseContract.kind === "required-tool-set" &&
        call.modelDispatch.responseContract.contractId === REFINEMENT_REVIEW_CONTRACT_ID,
      )).toHaveLength(0);
      expect(parent.recentOutcomes.filter((outcome) =>
        outcome.kind === "formal-submission" &&
        outcome.tool === REFINEMENT_REVIEW_TOOL_NAME,
      )).toEqual([
        expect.objectContaining({ source: "retained-recursive-result" }),
      ]);

      const result = await supervisor.models.result(review.handleId!);
      const child = deriveModelContractDiagnostics(projectEvents(
        await supervisor.storage.loadEvents(result.provenance.childSessionId, {
          branchId: result.provenance.childBranchId,
        }),
      ));
      expect(refinementCount(child)).toBe(1);
      expect(child.recentOutcomes).toEqual([
        expect.objectContaining({
          kind: "formal-submission",
          tool: REFINEMENT_REVIEW_TOOL_NAME,
          source: "model-call",
        }),
      ]);
    } finally { await supervisor.close(); }
  });

  test("rejects unsupported structured admission before child history exists", async () => {
    const temp = await makeTempRuntime("agencity-refiner-unsupported-");
    temps.push(temp);
    const provider: ModelProvider = {
      name: "refinement-text-only",
      capabilities: { streaming: false },
      complete: async () => ({
        text: "text only",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      }),
    };
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    try {
      const root = await supervisor.createSession({
        workspaceId: "unsupported-refinement",
        model: { provider: provider.name, model: "text-only" },
      });
      await expect((supervisor.refiner as any).startStructuredRefinementModel(
        root.sessionId,
        root.branchId,
        {
          prompt: "review",
          idempotencyKey: "unsupported-refinement",
          run: false,
        },
      )).rejects.toMatchObject({
        code: "MODEL_RESPONSE_CONTRACT_UNAVAILABLE",
      });
      expect(await supervisor.agents.listTasks(
        root.sessionId,
        root.branchId,
      )).toHaveLength(0);
      const parentEvents = await supervisor.storage.loadEvents(
        root.sessionId,
        { branchId: root.branchId },
      );
      expect(parentEvents.some((event) =>
        event.type === "RecursiveModelStarted"
      )).toBe(false);
      expect(await supervisor.storage.listBranches()).toHaveLength(1);
    } finally {
      await supervisor.close();
    }
  });

  test("rejects a structured result without its exact child completion", async () => {
    const provider = new ReviewProvider("review-binding");
    const { supervisor, sessionId, branchId } = await fixture(provider);
    try {
      const handle = await (supervisor.refiner as any).startStructuredRefinementModel(
        sessionId,
        branchId,
        {
          prompt: "review",
          idempotencyKey: "binding-check",
          run: false,
        },
      );
      const contract = handle.responseAdmission.responseContract;
      if (contract.kind !== "required-tool-set") {
        throw new Error("expected structured admission");
      }
      const transportInput = encodeRefinementReviewTransportValue({
        protocol: "agencity.refinement-review",
        version: 1,
        reviewId: "refinement-review-binding",
        status: "no_change",
        reason: "No change.",
        evidenceEventIds: [],
      });
      const result = createRefinementReviewRecursiveResult({
        contractDigest: contract.contractDigest,
        modelCallId: "missing-child-call",
        providerToolCallId: "missing-provider-call",
        modelResultDigest: `sha256:${"1".repeat(64)}`,
        transportInput,
        transportInputDigest: canonicalJsonDigest(transportInput),
        transportInputBytes: canonicalJsonByteLength(transportInput),
      });
      await expect(supervisor.storage.appendEvents([{
        sessionId,
        branchId,
        type: "RecursiveModelStatusChanged",
        producer: "supervisor",
        idempotencyKey: "forged-structured-result",
        payload: {
          handleId: handle.handleId,
          status: "completed",
          outcome: "succeeded",
          result: result as unknown as JsonValue,
        },
      }])).rejects.toThrow(/response admission|child model completion/i);
      expect((await supervisor.models.get(handle.handleId)).status).toBe("pending");
    } finally {
      await supervisor.close();
    }
  });

  test.each([
    ["cancelled", "cancelled", "cancelled"],
    ["failed", "failed", "failed"],
  ] as const)(
    "recovers a terminal %s task without attaching the completed structured child result",
    async (kind, expectedStatus, expectedOutcome) => {
    const provider = new ReviewProvider(`review-crash-recovery-${kind}`);
    const { temp, supervisor, sessionId, branchId } = await fixture(provider);
    let active: Supervisor | undefined = supervisor;
    try {
      const handle = await (supervisor.refiner as any).startStructuredRefinementModel(
        sessionId,
        branchId,
        {
          prompt: `review refinement-review-${"a".repeat(32)}`,
          idempotencyKey: `crash-boundary-recovery-${kind}`,
          run: false,
        },
      );
      const turn = await internalStructuredModelTurn(supervisor.modelLoop)(
        handle.childSessionId,
        handle.childBranchId,
        handle.responseAdmission,
      );
      expect(turn.outcome).toBe("succeeded");
      // Simulate a crash between the terminal task transition and the handle
      // status commit: the task is already terminal while the child retains a
      // successful structured tool submission.
      if (kind === "cancelled") {
        await supervisor.agents.cancel(
          handle.taskId,
          "simulated crash before status commit",
        );
      } else {
        await supervisor.agents.failTask(handle.taskId, {
          error: "simulated crash before status commit",
        });
      }
      expect((await supervisor.models.get(handle.handleId)).status).toBe("pending");
      await supervisor.close();
      active = undefined;
      const reopened = await Supervisor.open({
        databaseUrl: temp.databaseUrl,
        artifactDirectory: temp.artifactDirectory,
        workspaceRoot: temp.workspaceRoot,
        modelProviders: [provider],
        recover: true,
      });
      active = reopened;
      const recovered = await reopened.models.get(handle.handleId);
      expect(recovered.status).toBe(expectedStatus);
      expect(recovered.outcome).toBe(expectedOutcome);
      expect(recovered.result).toBeUndefined();
      expect(recovered.resultMessageId).toBeUndefined();
      // A second recovery pass must not terminalize the handle again.
      await reopened.recoverExecution();
      const terminal = (await reopened.storage.loadEvents(sessionId, { branchId }))
        .filter((event) =>
          event.type === "RecursiveModelStatusChanged" &&
          (event.payload as { handleId?: string; status?: string }).handleId === handle.handleId &&
          (event.payload as { status?: string }).status !== "running");
      expect(terminal).toHaveLength(1);
      expect((terminal[0]!.payload as { result?: unknown }).result).toBeUndefined();
    } finally {
      await active?.close();
    }
  });

  test.each([
    ["a registered secret in the submitted tool input", true, "input"],
    ["an unregistered credential in termination.rawReason", false, "raw-reason"],
  ] as const)(
    "a custom provider cannot push %s through the real outbox",
    async (_label, registered, placement) => {
    const secret = "sk-live-Section31DeepCover0042";
    const release = registered ? registerBrokeredSecret(secret) : undefined;
    const provider = new SecretReviewProvider(
      `review-secret-leak-${placement}`,
      secret,
      placement,
    );
    const { supervisor, sessionId, branchId } = await fixture(provider);
    try {
      const progress: string[] = [];
      const stopProgress = supervisor.outbox.onProgress((notification) =>
        progress.push(JSON.stringify(notification)));
      const handle = await (supervisor.refiner as any).startStructuredRefinementModel(
        sessionId,
        branchId,
        {
          prompt: `review refinement-review-${"a".repeat(32)}`,
          idempotencyKey: `secret-structured-output-${placement}`,
          run: false,
        },
      );
      const turn = await internalStructuredModelTurn(supervisor.modelLoop)(
        handle.childSessionId,
        handle.childBranchId,
        handle.responseAdmission,
      );
      stopProgress();
      expect(turn.outcome).toBe("failed");
      expect(turn.error ?? "").not.toContain(secret);
      const childEvents = await supervisor.storage.loadEvents(
        handle.childSessionId,
        { branchId: handle.childBranchId },
      );
      const child = projectEvents(childEvents);
      expect(Object.values(child.modelCalls).at(-1)).toMatchObject({
        status: "failed",
        failureCode: "stream-failed",
      });
      const outcome = childEvents.find((event) =>
        event.type === "EffectOutcomeRecorded")!;
      expect((outcome.payload as { outcome?: string }).outcome).toBe("failed");
      expect((outcome.payload as { output?: unknown }).output).toBeUndefined();
      expect((outcome.payload as { modelFailure?: { code?: string } }).modelFailure)
        .toEqual({ code: "stream-failed" });
      const parentEvents = await supervisor.storage.loadEvents(sessionId, { branchId });
      expect(JSON.stringify([...childEvents, ...parentEvents])).not.toContain(secret);
      expect(progress.join("")).not.toContain(secret);
      const effectId = (childEvents.find((event) => event.type === "EffectRequested")!
        .payload as { effectId: string }).effectId;
      expect(JSON.stringify(await supervisor.storage.getOutbox(effectId) ?? {}))
        .not.toContain(secret);
      await supervisor.storage.rebuildOperationalProjections?.();
      expect(JSON.stringify(await supervisor.models.get(handle.handleId)))
        .not.toContain(secret);
    } finally {
      release?.();
      await supervisor.close();
    }
  });

  test("strictly parses, proposes with stable identity, validates, activates, and allocates without promotion", async () => {
    const provider = new ReviewProvider("review-propose", "propose");
    const { supervisor, sessionId, branchId, evidence } = await fixture(provider);
    try {
      const review = await supervisor.refiner.request(sessionId, branchId);
      expect(review.status).toBe("candidate");
      expect(review.proposalId).toMatch(/^refinement-proposal-[a-f0-9]{32}$/);
      const proposal = (await supervisor.harness.proposals()).find((item) => item.proposalId === review.proposalId)!;
      expect(proposal.status).toBe("candidate");
      expect(proposal.sourceReviewId).toBe(review.reviewId);
      expect(proposal.evidenceEventIds).toContain(evidence.id);
      expect((await supervisor.harness.allocations(proposal.candidateId!))).toHaveLength(1);
      expect((await supervisor.harness.list()).some((entry) => entry.name === "evidence-discipline" && entry.current.status === "candidate")).toBe(true);
      expect((await supervisor.harness.list()).some((entry) => entry.name === "evidence-discipline" && entry.current.status === "active")).toBe(false);
    } finally { await supervisor.close(); }
  });

  test("a refiner-produced replacement promotes and rolls back to the exact prior active version", async () => {
    const provider = new ReviewProvider("review-replace", "replace");
    const { supervisor, sessionId, branchId, evidence } = await fixture(provider);
    try {
      const original = await supervisor.memory.create(sessionId, branchId, { name: "retained-fact", text: "Use the original retained fact.", memoryKind: "claim", scope: "local" });
      provider.targetEntryId = original.entryId;
      provider.targetVersionId = original.currentVersionId;
      const review = await supervisor.refiner.request(sessionId, branchId);
      expect(review.status).toBe("candidate");
      const proposal = (await supervisor.harness.proposals()).find((item) => item.proposalId === review.proposalId)!;
      const allocation = (await supervisor.harness.allocations(proposal.candidateId!))[0]!;
      await supervisor.contexts.materialize(sessionId, branchId);
      await supervisor.harness.recordObservation(sessionId, branchId, proposal.proposalId, { allocationId: allocation.allocationId, evaluator: "refiner-rollback-test", objective: false, success: true, metric: true, evidenceEventIds: [evidence.id] });
      await supervisor.harness.decide(sessionId, branchId, proposal.proposalId);
      expect((await supervisor.harness.getActive(original.entryId))?.current.versionId).not.toBe(original.currentVersionId);
      await supervisor.harness.rollback(sessionId, branchId, proposal.proposalId, "restore exact prior refiner version");
      expect((await supervisor.harness.getActive(original.entryId))?.current.versionId).toBe(original.currentVersionId);
    } finally { await supervisor.close(); }
  });

  test("persuasive output without durable evidence cannot create or activate a proposal", async () => {
    const provider = new ReviewProvider("review-no-evidence", "no_evidence");
    const { supervisor, sessionId, branchId } = await fixture(provider);
    try {
      const review = await supervisor.refiner.request(sessionId, branchId);
      expect(review.status).toBe("failed");
      expect(review.reason).toMatch(/match agencity\.refinement-review|evidence/i);
      expect(await supervisor.harness.proposals()).toHaveLength(0);
    } finally { await supervisor.close(); }
  });

  test("rejects malformed and over-scoped provider output atomically", async () => {
    for (const kind of ["malformed", "overscope"] as const) {
      const provider = new ReviewProvider(`review-${kind}`, kind);
      const { supervisor, sessionId, branchId } = await fixture(provider);
      try {
        const review = await supervisor.refiner.request(sessionId, branchId);
        expect(review.status).toBe("failed");
        expect(review.reason).toMatch(kind === "malformed" ? /required tool/i : /outside requested scope/i);
        expect(await supervisor.harness.proposals()).toHaveLength(0);
      } finally { await supervisor.close(); }
    }
  });

  test("keeps structured provider failure, cancellation, and budget exhaustion distinct", async () => {
    {
      const provider = new FailingReviewProvider("review-provider-failure");
      const { supervisor, sessionId, branchId } = await fixture(provider);
      try {
        const review = await supervisor.refiner.request(sessionId, branchId);
        expect(review.status).toBe("failed");
        const handle = await supervisor.models.get(review.handleId!);
        expect(handle.outcome).toBe("failed");
        const child = projectEvents(await supervisor.storage.loadEvents(
          handle.childSessionId,
          { branchId: handle.childBranchId },
        ));
        expect(Object.values(child.modelCalls).at(-1)).toMatchObject({
          status: "failed",
          failureCode: "provider-request-failed",
        });
      } finally {
        await supervisor.close();
      }
    }

    {
      const provider = new BlockingReviewProvider("review-cancelled");
      const { supervisor, sessionId, branchId } = await fixture(provider);
      try {
        const admitted = await supervisor.refiner.request(
          sessionId,
          branchId,
          { wait: false },
        );
        await waitFor(async () => {
          const review = await supervisor.refiner.get(admitted.reviewId);
          return review.handleId !== null && provider.active;
        }, "blocking refinement provider");
        const running = await supervisor.refiner.get(admitted.reviewId);
        await supervisor.models.cancel(running.handleId!, "cancel review");
        await waitFor(async () =>
          (await supervisor.refiner.get(admitted.reviewId)).status ===
            "cancelled", "cancelled refinement");
        const cancelled = await supervisor.refiner.get(admitted.reviewId);
        expect(cancelled.status).toBe("cancelled");
        expect((await supervisor.models.get(cancelled.handleId!)).outcome)
          .toBe("cancelled");
      } finally {
        await supervisor.close();
      }
    }

    {
      const provider = new ReviewProvider("review-budget");
      const temp = await makeTempRuntime("agencity-refiner-budget-");
      temps.push(temp);
      const supervisor = await Supervisor.open({
        databaseUrl: temp.databaseUrl,
        artifactDirectory: temp.artifactDirectory,
        workspaceRoot: temp.workspaceRoot,
        modelProviders: [provider],
        recover: false,
      });
      try {
        const root = await supervisor.createSession({
          workspaceId: "refiner-budget",
          model: { provider: provider.name, model: "scripted-v1" },
          budget: { turnLimit: 1 },
        });
        const evidence = await supervisor.appendMessage(
          root.sessionId,
          root.branchId,
          "user",
          "Retained evidence",
        );
        provider.evidenceEventId = evidence.id;
        provider.requestedScopeKey = root.sessionId;
        const review = await supervisor.refiner.request(
          root.sessionId,
          root.branchId,
        );
        expect(review.status).toBe("failed");
        const handle = await supervisor.models.get(review.handleId!);
        expect(handle.outcome).toBe("budget-exceeded");
        expect(handle.result).toBeUndefined();
        expect(handle.resultMessageId).toBeUndefined();
      } finally {
        await supervisor.close();
      }
    }
  });

  test("automatic trigger policy is profile-opt-in, local-only, thresholded, and deduplicated", async () => {
    const provider = new ReviewProvider("review-automatic");
    const { supervisor, sessionId, branchId } = await fixture(provider);
    try {
      expect((await supervisor.refiner.automaticPolicy()).automatic).toBe(false);
      for (let index = 1; index <= 3; index++) {
        const effectId = `repeat-effect-${index}`;
        await supervisor.storage.appendEvents([{
          sessionId, branchId, type: "EffectRequested", producer: "supervisor", idempotencyKey: `repeat-request-${index}`,
          payload: { effectId, executor: "shell", operation: "run", input: { command: "false" }, idempotencyKey: `repeat-${index}`, idempotent: true },
        }, {
          sessionId, branchId, type: "EffectOutcomeRecorded", producer: "executor", idempotencyKey: `repeat-outcome-${index}`,
          payload: { effectId, attempt: 1, outcome: "failed", error: "command timed out", observedAt: new Date().toISOString() },
        }]);
      }
      expect(await supervisor.refiner.scanBoundary(sessionId, branchId)).toEqual([]);
      await supervisor.refiner.setAutomatic(true);
      expect((await supervisor.profile.getPreference("refinement.trigger-policy.v1"))?.value).toMatchObject({ version: 1, automatic: true, scope: "local" });
      const [[admitted], [duplicate]] = await Promise.all([
        supervisor.refiner.scanBoundary(sessionId, branchId),
        supervisor.refiner.scanBoundary(sessionId, branchId),
      ]);
      expect(duplicate?.reviewId).toBe(admitted?.reviewId);
      expect(admitted?.mode).toBe("automatic");
      expect(admitted?.requestedScope).toBe("local");
      await waitFor(async () => (await supervisor.refiner.get(admitted!.reviewId)).status === "no_change", "automatic refinement terminal", 5_000);
      const terminal = await supervisor.refiner.get(admitted!.reviewId);
      expect(terminal.status).toBe("no_change");
      expect(await supervisor.refiner.scanBoundary(sessionId, branchId)).toEqual([]);
      const consumption = await supervisor.storage.readonlyQuery({ sql: "SELECT * FROM refinement_trigger_consumptions WHERE review_id=?", args: [terminal.reviewId] });
      expect(consumption).toHaveLength(1);
      expect(provider.calls).toBe(1);
    } finally { await supervisor.close(); }
  });

  test("refinement correction, review lifecycle, and trigger consumption projections survive rebuild without refiring evidence", async () => {
    const provider = new ReviewProvider("review-rebuild");
    const { supervisor, sessionId, branchId, evidence } = await fixture(provider);
    try {
      await supervisor.refiner.setAutomatic(true);
      await supervisor.refiner.correct(sessionId, branchId, "Keep this correction attributable across rebuild", [evidence.id]);
      const [automatic] = await supervisor.refiner.scanBoundary(sessionId, branchId);
      expect(automatic).toBeTruthy();
      await waitFor(async () => (await supervisor.refiner.get(automatic!.reviewId)).status === "no_change", "terminal review before rebuild", 5_000);

      const storage = supervisor.storage as any;
      const originalAppend = storage.appendEvents.bind(storage);
      storage.appendEvents = async (events: any[], options?: any) => {
        const committed = await originalAppend(events, options);
        if (events.some((event) => event.type === "RefinementReviewRequested")) throw new Error("simulated crash after nonterminal review request");
        return committed;
      };
      try {
        await expect(supervisor.refiner.request(sessionId, branchId, { instructions: "Leave this review requested for rebuild coverage" })).rejects.toThrow(/simulated crash/);
      } finally { storage.appendEvents = originalAppend; }

      const beforeReviews = await supervisor.refiner.list({ sessionId, branchId });
      const terminal = beforeReviews.find((review) => review.reviewId === automatic!.reviewId)!;
      const nonterminal = beforeReviews.find((review) => review.status === "requested")!;
      expect(terminal.status).toBe("no_change");
      expect(terminal.handleId).toBeTruthy();
      expect(nonterminal.handleId).toBeNull();
      const beforeCorrection = await supervisor.storage.readonlyQuery({ sql: "SELECT * FROM user_corrections WHERE session_id=? AND branch_id=?", args: [sessionId, branchId] });
      const beforeConsumption = await supervisor.storage.readonlyQuery({ sql: "SELECT * FROM refinement_trigger_consumptions WHERE review_id=?", args: [terminal.reviewId] });
      const beforeEvents = await supervisor.storage.loadEvents(sessionId, { branchId });
      const beforeChildCount = beforeEvents.filter((event) => event.type === "RefinementReviewChildLinked").length;

      await supervisor.storage.rebuildOperationalProjections?.();

      expect(await supervisor.refiner.get(terminal.reviewId)).toEqual(terminal);
      expect(await supervisor.refiner.get(nonterminal.reviewId)).toEqual(nonterminal);
      expect(await supervisor.storage.readonlyQuery({ sql: "SELECT * FROM user_corrections WHERE session_id=? AND branch_id=?", args: [sessionId, branchId] })).toEqual(beforeCorrection);
      expect(await supervisor.storage.readonlyQuery({ sql: "SELECT * FROM refinement_trigger_consumptions WHERE review_id=?", args: [terminal.reviewId] })).toEqual(beforeConsumption);
      expect(await supervisor.refiner.scanBoundary(sessionId, branchId)).toEqual([]);
      const afterEvents = await supervisor.storage.loadEvents(sessionId, { branchId });
      expect(afterEvents.filter((event) => event.type === "RefinementReviewChildLinked")).toHaveLength(beforeChildCount);
      expect(provider.calls).toBe(1);
    } finally { await supervisor.close(); }
  });

  test("distinct failed completion-gate evaluation pins admit an automatic review", async () => {
    const provider = new ReviewProvider("review-gate-trigger");
    const { supervisor, sessionId, branchId } = await fixture(provider);
    try {
      const goal = await supervisor.goals.create(sessionId, branchId, { description: "verify gate trigger", gates: [{ name: "tests", executor: "shell", operation: "run", input: { command: "false" }, idempotent: true, required: true }] });
      const gate = goal.gates[0]!;
      const first = await supervisor.appendMessage(sessionId, branchId, "user", "first material pin");
      const second = await supervisor.appendMessage(sessionId, branchId, "user", "second material pin");
      for (const [index, source] of [first, second].entries()) await supervisor.storage.appendEvents([{
        sessionId, branchId, type: "GoalGateEvaluationRecorded", producer: "supervisor", idempotencyKey: `refiner-gate-evaluation-${index}`,
        payload: { evaluationId: `refiner-gate-evaluation-${index}`, goalId: goal.goalId, gateId: gate.gateId, requestId: `refiner-request-${index}`, definitionHash: "a".repeat(64), materialVersion: (index === 0 ? "b" : "c").repeat(64), materialEventIds: [source.id], status: "failed", error: "gate failed" },
      }]);
      await supervisor.refiner.setAutomatic(true);
      const [review] = await supervisor.refiner.scanBoundary(sessionId, branchId);
      expect(review?.triggerKind).toBe("repeated_gate_failure");
      await waitFor(async () => (await supervisor.refiner.get(review!.reviewId)).status === "no_change", "gate review terminal", 5_000);
    } finally { await supervisor.close(); }
  });

  test("the AgentRun committed boundary hook admits configured automatic refinement", async () => {
    const provider = new ReviewProvider("review-boundary-hook");
    const { supervisor, sessionId, branchId } = await fixture(provider);
    try {
      for (let index = 1; index <= 3; index++) {
        const effectId = `boundary-effect-${index}`;
        await supervisor.storage.appendEvents([{
          sessionId, branchId, type: "EffectRequested", producer: "supervisor", idempotencyKey: `boundary-request-${index}`,
          payload: { effectId, executor: "shell", operation: "run", input: { command: "false" }, idempotencyKey: `boundary-${index}`, idempotent: true },
        }, {
          sessionId, branchId, type: "EffectOutcomeRecorded", producer: "executor", idempotencyKey: `boundary-outcome-${index}`,
          payload: { effectId, attempt: 1, outcome: "failed", error: "same boundary failure", observedAt: new Date().toISOString() },
        }]);
      }
      await supervisor.refiner.setAutomatic(true);
      const run = await supervisor.runs.start(sessionId, branchId, { task: "finish after checking the committed boundary", goalMode: "auto" });
      expect(run.status).toBe("succeeded");
      await waitFor(async () => (await supervisor.refiner.list({ sessionId, branchId })).some((review) => review.mode === "automatic" && review.status === "no_change"), "boundary refinement terminal", 5_000);
      expect(provider.runCalls).toBe(1);
      expect(provider.calls).toBe(1);
    } finally { await supervisor.close(); }
  });

  test("malformed automatic policy is a bounded non-fatal boundary observation and cannot wedge run recovery", async () => {
    const provider = new ReviewProvider("review-malformed-policy");
    const { temp, supervisor, sessionId, branchId } = await fixture(provider);
    let reopened: Supervisor | undefined;
    let originalClosed = false;
    try {
      await supervisor.profile.setPreference("refinement.trigger-policy.v1", { version: 1, automatic: true, scope: "local" });
      const admitted = await supervisor.runs.admit(sessionId, branchId, { task: "recover despite malformed refinement preference", goalMode: "none" });
      expect(admitted.status).toBe("queued");
      await supervisor.close(); originalClosed = true;

      reopened = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
      expect(await reopened.runs.get(sessionId, branchId, admitted.runId)).toMatchObject({ status: "succeeded" });
      const events = await reopened.storage.loadEvents(sessionId, { branchId });
      const observations = events.filter((event) => event.type === "MessageAppended" && String((event.payload as any).messageId).startsWith("refinement-scan-observation-"));
      expect(observations).toHaveLength(1);
      expect((observations[0]!.payload as any).content).toBe("Automatic refinement scan skipped at a committed boundary (validation_failed); task execution remains available and no refinement result is implied.");
      expect(provider.runCalls).toBe(1);
      expect(provider.calls).toBe(0);
    } finally {
      if (reopened) await reopened.close();
      else if (!originalClosed) await supervisor.close();
    }
  });

  test("credential-shaped retained failure evidence skips automatic refinement without blocking the AgentRun", async () => {
    const provider = new ReviewProvider("review-credential-shaped-evidence");
    const { supervisor, sessionId, branchId } = await fixture(provider);
    try {
      for (let index = 1; index <= 3; index++) {
        const effectId = `credential-shaped-effect-${index}`;
        await supervisor.storage.appendEvents([{
          sessionId, branchId, type: "EffectRequested", producer: "supervisor", idempotencyKey: `credential-shaped-request-${index}`,
          payload: { effectId, executor: "shell", operation: "run", input: { command: "false" }, idempotencyKey: `credential-shaped-${index}`, idempotent: true },
        }, {
          sessionId, branchId, type: "EffectOutcomeRecorded", producer: "executor", idempotencyKey: `credential-shaped-outcome-${index}`,
          payload: { effectId, attempt: 1, outcome: "failed", error: "api_key=retained-credential-shaped-value", observedAt: new Date().toISOString() },
        }]);
      }
      await supervisor.refiner.setAutomatic(true);
      expect(await supervisor.refiner.scanBoundary(sessionId, branchId, "direct-credential-scan")).toEqual([]);
      const run = await supervisor.runs.start(sessionId, branchId, { task: "continue despite unsafe refinement evidence", goalMode: "none" });
      expect(run.status).toBe("succeeded");
      expect(await supervisor.refiner.list({ sessionId, branchId })).toHaveLength(0);
      const events = await supervisor.storage.loadEvents(sessionId, { branchId });
      const observations = events.filter((event) => event.type === "MessageAppended" && String((event.payload as any).messageId).startsWith("refinement-scan-observation-"));
      expect(observations).toHaveLength(2);
      expect(JSON.stringify(observations.map((event) => event.payload))).not.toContain("retained-credential-shaped-value");
      expect(provider.runCalls).toBe(1);
      expect(provider.calls).toBe(0);
    } finally { await supervisor.close(); }
  });

  test("only typed UserCorrection events trigger correction refinement", async () => {
    const provider = new ReviewProvider("review-correction");
    const { supervisor, sessionId, branchId, evidence } = await fixture(provider);
    try {
      await supervisor.refiner.setAutomatic(true);
      await supervisor.appendMessage(sessionId, branchId, "user", "Correction: please use Bun");
      expect(await supervisor.refiner.scanBoundary(sessionId, branchId)).toEqual([]);
      await supervisor.refiner.correct(sessionId, branchId, "Use Bun for repository commands", [evidence.id]);
      const [review] = await supervisor.refiner.scanBoundary(sessionId, branchId);
      expect(review?.mode).toBe("automatic");
      expect((await supervisor.storage.loadEvents(sessionId, { branchId })).some((event) => event.type === "UserCorrection")).toBe(true);
    } finally { await supervisor.close(); }
  });


  test("the model-facing harness SDK can request and inspect local reviews without user-correction authority", async () => {
    const provider = new ReviewProvider("review-console-sdk");
    const { supervisor, sessionId, branchId } = await fixture(provider);
    try {
      const cell = await supervisor.executeCell(sessionId, branchId, `
        const review = await sdk.harness.review("Inspect the retained local trajectory");
        const reviews = await sdk.harness.reviews();
        return { status: review.status, count: reviews.length, correctionAvailable: typeof (sdk.harness as any).correct };
      `);
      expect(cell.result).toEqual({ status: "no_change", count: 1, correctionAvailable: "undefined" });
    } finally { await supervisor.close(); }
  });

  test("exposes review, policy, typed correction, status, and advanced proposal paths through AgentClient", async () => {
    const provider = new ReviewProvider("review-protocol");
    const { supervisor, sessionId, branchId, evidence } = await fixture(provider);
    const protocol = new ProtocolServer(supervisor); const server = protocol.listen(0);
    const client = new AgentClient(`http://${server.hostname}:${server.port}`);
    try {
      expect((await client.refinementPolicy()).automatic).toBe(false);
      expect((await client.setAutomaticRefinement(true)).automatic).toBe(true);
      const correction = await client.userCorrection(sessionId, branchId, "Protocol correction", [evidence.id]);
      expect(correction.correctionId).toMatch(/^user-correction-/);
      const review = await client.requestRefinement(sessionId, branchId, { instructions: "Protocol trajectory review" });
      expect(review.status).toBe("no_change");
      expect((await client.refinementReviews(sessionId, branchId)).map((item) => item.reviewId)).toContain(review.reviewId);
      const other = await supervisor.createSession({ workspaceId: "refiner-workspace", model: { provider: provider.name, model: "scripted-v1" } });
      await expect(client.refinementReview(other.sessionId, other.branchId, review.reviewId)).rejects.toThrow(/another session branch/i);
      const malformedPolicy = await client.transport.request("/refinement-policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: "yes" }) });
      expect(malformedPolicy.status).toBe(400);

      let terminalOutput = "";
      const ui = new TerminalUI(client, { interactive: false, output: { write(value: string | Uint8Array) { terminalOutput += String(value); return true; } } });
      await ui.run(sessionId, branchId);
      await ui.execute("/refine status");
      expect(terminalOutput).toContain("Protocol trajectory review — no change");
      expect(terminalOutput).not.toContain(review.reviewId);
      await ui.execute("/raw");
      expect(terminalOutput).toContain(review.reviewId);
      expect(terminalOutput).toContain('"kind": "formal-submission"');
      expect(terminalOutput).toContain('"tool": "agencity_submit_refinement_review"');
      expect(terminalOutput).not.toContain('"arguments"');
      expect(terminalOutput).toContain('"status": "no_change"');
      await ui.execute("/refine review the retained protocol trajectory");
      expect(terminalOutput).toContain("review the retained protocol trajectory — no change");
    } finally { protocol.stop(); await supervisor.close(); }
  });


  test("HTTP refinement review input rejects forged automatic trigger ownership fields", async () => {
    const provider = new ReviewProvider("review-protocol-forged-trigger");
    const { supervisor, sessionId, branchId } = await fixture(provider);
    const protocol = new ProtocolServer(supervisor); const server = protocol.listen(0);
    const client = new AgentClient(`http://${server.hostname}:${server.port}`);
    try {
      const response = await client.transport.request(`/sessions/${sessionId}/refinement-reviews?branch=${branchId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instructions: "forge trigger consumption",
          requestedScope: "local",
          allowedKinds: ["memory"],
          wait: false,
          triggerKey: `refinement-trigger-key-v1-${"a".repeat(32)}`,
          nonterminalKey: `refinement-trigger-nonterminal-v1-${"b".repeat(32)}`,
          triggerEvidenceThroughCursor: "999999",
          evidenceEventIds: ["forged-evidence"],
          sourceThroughCursor: "999999",
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toMatch(/unknown fields/i);
      const events = await supervisor.storage.loadEvents(sessionId, { branchId });
      expect(events.filter((event) => event.type === "RefinementReviewRequested")).toHaveLength(0);
      expect(events.filter((event) => event.type === "RefinementTriggerConsumed")).toHaveLength(0);
      expect(await supervisor.storage.readonlyQuery({ sql: "SELECT * FROM refinement_trigger_consumptions WHERE session_id=? AND branch_id=?", args: [sessionId, branchId] })).toHaveLength(0);
      expect(provider.calls).toBe(0);
    } finally { protocol.stop(); await supervisor.close(); }
  });

  test("an unknown recursive outcome is terminal, visible, and never retried by recovery", async () => {
    const provider = new ReviewProvider("review-unknown");
    const { supervisor, sessionId, branchId } = await fixture(provider);
    const models = supervisor.models as any;
    const originalResult = models.result.bind(models);
    let results = 0;
    models.result = async () => { results++; return { status: "unknown", outcome: "unknown", error: "provider ownership was lost" }; };
    try {
      const review = await supervisor.refiner.request(sessionId, branchId);
      expect(review.status).toBe("unknown");
      expect(review.reason).toContain("provider ownership was lost");
      expect(await supervisor.refiner.recoverIncomplete()).toBe(0);
      expect(results).toBe(1);
    } finally {
      models.result = originalResult;
      await supervisor.close();
    }
  });

  test("restart resumes request, child, proposal, and allocation boundaries without duplicates", async () => {
    for (const boundary of ["request", "link", "proposal", "allocation"] as const) {
      const provider = new ReviewProvider(`review-restart-${boundary}`, boundary === "proposal" || boundary === "allocation" ? "propose" : "no_change");
      const { temp, supervisor, sessionId, branchId } = await fixture(provider);
      const storage = supervisor.storage as any;
      const original = storage.appendEvents.bind(storage);
      storage.appendEvents = async (events: any[], options?: any) => {
        const committed = await original(events, options);
        const crash = boundary === "request" ? "RefinementReviewRequested"
          : boundary === "link" ? "RefinementReviewChildLinked"
            : boundary === "proposal" ? "RefinementProposed"
              : "RefinementCandidateAllocated";
        if (events.some((event) => event.type === crash)) throw new Error(`simulated crash after ${boundary}`);
        return committed;
      };
      await expect(supervisor.refiner.request(sessionId, branchId)).rejects.toThrow(/simulated crash|compare-and-swap/i);
      storage.appendEvents = original;
      await supervisor.close();

      const reopened = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [provider], recover: true });
      try {
        const expectedStatus = boundary === "proposal" || boundary === "allocation" ? "candidate" : "no_change";
        await waitFor(async () => (await reopened.refiner.list({ sessionId, branchId }))[0]?.status === expectedStatus, `recovered ${boundary} review`, 5_000);
        const [review] = await reopened.refiner.list({ sessionId, branchId });
        expect(review?.status).toBe(expectedStatus);
        expect(provider.calls).toBe(1);
        const events = await reopened.storage.loadEvents(sessionId, { branchId });
        expect(events.filter((event) => event.type === "RefinementReviewRequested")).toHaveLength(1);
        expect(events.filter((event) => event.type === "RefinementReviewChildLinked")).toHaveLength(1);
        expect(events.filter((event) => event.type === "RefinementProposed")).toHaveLength(expectedStatus === "candidate" ? 1 : 0);
        expect((await reopened.harness.proposals()).length).toBe(expectedStatus === "candidate" ? 1 : 0);
      } finally { await reopened.close(); }
    }
  });

});

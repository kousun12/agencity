import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { AgentClient, LibSqlStorage, ProtocolServer, Supervisor, TerminalUI, projectEvents, type JsonValue, type ModelConfiguration, type ModelProvider, type ModelResponse } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, waitFor, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

class ReviewProvider implements ModelProvider {
  calls = 0;
  runCalls = 0;
  evidenceEventId = "";
  requestedScopeKey = "";
  targetEntryId = "";
  targetVersionId = "";
  constructor(readonly name: string, readonly decision: "no_change" | "propose" | "replace" | "malformed" | "overscope" | "no_evidence" = "no_change") {}
  async complete(context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const reviewId = JSON.stringify(context).match(/refinement-review-[a-f0-9]{32}/)?.[0];
    if (!reviewId) {
      this.runCalls++;
      return { text: JSON.stringify({ protocol: "agencity.agent-action", version: 1, type: "final", content: "done" }), finishReason: "stop", usage: { inputTokens: 2, outputTokens: 2, costUsd: 0 } };
    }
    this.calls++;
    let text: string;
    if (this.decision === "malformed") text = `not-json ${reviewId}`;
    else if (this.decision === "no_change") text = JSON.stringify({ protocol: "agencity.refinement-review", version: 1, reviewId, status: "no_change", reason: "No evidence-backed update is necessary.", evidenceEventIds: [] });
    else {
      const evidenceIds = this.decision === "no_evidence" ? [] : [this.evidenceEventId];
      text = JSON.stringify({
      protocol: "agencity.refinement-review", version: 1, reviewId, status: "propose",
      trigger: "Retained user evidence supports a small prompt note", predictedEffect: "Keep future work tied to retained evidence",
      edits: this.decision === "replace"
        ? [{ operation: "replace", entryId: this.targetEntryId, expectedVersionId: this.targetVersionId, content: { kind: "memory", memoryKind: "claim", text: "Use the corrected retained fact." }, evidenceEventIds: evidenceIds }]
        : [{ operation: "create", kind: "prompt_note", scope: this.decision === "overscope" ? "global" : "local", scopeKey: this.decision === "overscope" ? "global" : this.requestedScopeKey, name: "evidence-discipline", content: { kind: "prompt_note", text: "Cite retained evidence before claiming completion." }, evidenceEventIds: evidenceIds }],
      evidenceEventIds: evidenceIds, evaluation: { kind: "objective", name: "retained-evidence-check", metric: "verification command succeeds", target: true },
    });
    }
    return { text, finishReason: "stop", usage: { inputTokens: 2, outputTokens: 2, costUsd: 0 } };
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
    } finally { await supervisor.close(); }
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
        expect(review.reason).toMatch(kind === "malformed" ? /exactly one JSON object/i : /outside requested scope/i);
        expect(await supervisor.harness.proposals()).toHaveLength(0);
      } finally { await supervisor.close(); }
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
      await ui.execute("/refine review the retained protocol trajectory");
      expect(terminalOutput).toContain(review.reviewId);
      expect(terminalOutput).toContain('"status": "no_change"');
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

import { afterEach, describe, expect, test } from "bun:test";
import {
  Supervisor,
  type JsonValue,
  type ModelConfiguration,
  type ModelProvider,
  type ModelResponse,
} from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, waitFor, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

class PromptProvider implements ModelProvider {
  calls = 0;
  readonly contexts: JsonValue[] = [];
  constructor(readonly name: string, readonly large = false) {}
  async complete(context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.calls++;
    this.contexts.push(context);
    const serialized = JSON.stringify(context);
    if (serialized.includes("FAIL-THIS-CALL")) throw new Error("selected provider failure");
    const text = this.large ? "R".repeat(100_000) : `call-${this.calls}`;
    return { text, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
  }
}

class TimedProvider implements ModelProvider {
  calls = 0;
  constructor(readonly name: string) {}
  async complete(_context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<ModelResponse> {
    this.calls++;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1_000);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    });
    return { text: "late", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
  }
}

function open(temp: TempRuntime, providers: readonly ModelProvider[] = [], extra: Record<string, unknown> = {}): Promise<Supervisor> {
  return Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    modelProviders: providers,
    recover: false,
    heartbeatPollIntervalMs: 1_000,
    ...extra,
  });
}

describe("FU-013 model-facing durable rlm API", () => {
  test("console handles serialize through working state and resolve in a fresh worker", async () => {
    const temp = await makeTempRuntime("agencity-rlm-console-"); temps.push(temp);
    const provider = new PromptProvider("console-rlm");
    const supervisor = await open(temp, [provider], { restartConsoleAfterCell: true });
    try {
      const root = await supervisor.createSession({ workspaceId: "rlm", model: { provider: provider.name, model: "m" } });
      const admitted = await supervisor.executeCell(root.sessionId, root.branchId, `
        const handle = await rlm.start({ task: "inspect", input: { position: 0, value: "alpha" }, idempotencyKey: "console-stable" });
        await state.set("savedRlm", { handleId: handle.handleId });
        return handle;
      `);
      const admittedHandle = admitted.result as Record<string, any>;
      expect(admittedHandle.handleId).toMatch(/^model-task-/);
      expect(JSON.stringify(admitted.result)).not.toContain("function");

      const resolved = await supervisor.executeCell(root.sessionId, root.branchId, `
        const saved = await state.get("savedRlm");
        if (!saved || saved.kind !== "json") throw new Error("missing handle");
        const handle = await rlm.get(saved.value.handleId);
        return await handle.result({ timeoutMs: 5000 });
      `);
      expect((resolved.result as any).status).toBe("succeeded");
      expect((resolved.result as any).provenance.inputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(provider.calls).toBe(1);
      expect((await supervisor.agents.listTasks(root.sessionId))).toHaveLength(1);
    } finally { await supervisor.close(); }
  });

  test("typed artifact, document, event, memory, and SQL references are policy checked and attributed", async () => {
    const temp = await makeTempRuntime("agencity-rlm-inputs-"); temps.push(temp);
    const supervisor = await open(temp);
    try {
      const root = await supervisor.createSession({ workspaceId: "inputs" });
      const artifactCell = await supervisor.executeCell(root.sessionId, root.branchId, `return await artifacts.put("artifact-range-value")`);
      const artifactId = (artifactCell.result as any).artifactId as string;
      const document = await supervisor.documents.import(root.sessionId, root.branchId, { content: "A".repeat(300) + "B".repeat(300), chunkBytes: 300 });
      const sourceEvent = await supervisor.appendMessage(root.sessionId, root.branchId, "user", "event input");
      const memory = await supervisor.memory.create(root.sessionId, root.branchId, { text: "durable memory input", evidenceEventIds: [sourceEvent.id] });
      const starts = await supervisor.models.startMany(root.sessionId, root.branchId, [
        { task: "artifact", input: { kind: "artifact", artifactId, start: 0, end: 8 }, run: false },
        { task: "document", input: { kind: "document-range", documentId: document.documentId, start: 1, limit: 1 }, run: false },
        { task: "event", input: { kind: "event", eventId: sourceEvent.id }, run: false },
        { task: "memory", input: { kind: "memory", entryId: memory.entryId, versionId: memory.current.versionId }, run: false },
        { task: "sql", input: { kind: "sql-rows", query: "SELECT type FROM events WHERE session_id=? ORDER BY sequence", args: [root.sessionId], limit: 3 }, run: false },
      ]);
      expect(starts.map((item) => (item.inputProvenance as any).sources[0].kind)).toEqual(["artifact", "document-range", "event", "memory", "sql-rows"]);
      expect(starts[0]?.input).toBe("artifact");
      expect((starts[1]?.input as any[])[0].ordinal).toBe(1);
      expect((starts[2]?.input as any).eventId).toBe(sourceEvent.id);
      expect((starts[3]?.input as any).entryId).toBe(memory.entryId);
      expect((starts[4]?.input as any[]).length).toBeLessThanOrEqual(3);
      expect(starts.every((item) => typeof item.inputHash === "string")).toBe(true);

      const stranger = await supervisor.createSession({ workspaceId: "inputs" });
      await expect(supervisor.models.start(stranger.sessionId, stranger.branchId, { task: "steal event", input: { kind: "event", eventId: sourceEvent.id }, run: false }))
        .rejects.toThrow(/family scope/i);
    } finally { await supervisor.close(); }
  });

  test("startMany preserves input order and independent succeeded/failed terminal outcomes", async () => {
    const temp = await makeTempRuntime("agencity-rlm-batch-"); temps.push(temp);
    const provider = new PromptProvider("batch-rlm");
    const supervisor = await open(temp, [provider], { providerConcurrency: { [provider.name]: 2 } });
    try {
      const root = await supervisor.createSession({ workspaceId: "batch", model: { provider: provider.name, model: "m" } });
      const handles = await supervisor.models.startMany(root.sessionId, root.branchId, [
        { task: "first", input: { position: 0 } },
        { task: "FAIL-THIS-CALL", input: { position: 1 } },
        { task: "third", input: { position: 2 } },
      ]);
      const results = await Promise.all(handles.map((handle) => supervisor.models.result(handle.handleId, { timeoutMs: 5_000 })));
      expect(results.map((item) => item.status)).toEqual(["succeeded", "failed", "succeeded"]);
      expect(handles.map((item) => (item.input as any).position)).toEqual([0, 1, 2]);
      expect(results[1]?.error).toContain("Model provider request failed");
      expect(results[0]?.provenance.providerAttemptEffectIds).toHaveLength(1);
    } finally { await supervisor.close(); }
  });

  test("stable retries do not duplicate admission and unauthorized model overrides fail before admission", async () => {
    const temp = await makeTempRuntime("agencity-rlm-policy-"); temps.push(temp);
    const supervisor = await open(temp);
    try {
      const root = await supervisor.createSession({ workspaceId: "policy" });
      const request = { task: "stable", input: { chunk: 1 }, run: false, idempotencyKey: "same-intent" } as const;
      const first = await supervisor.models.start(root.sessionId, root.branchId, request);
      const second = await supervisor.models.start(root.sessionId, root.branchId, request);
      expect(second.handleId).toBe(first.handleId);
      expect((await supervisor.agents.listTasks(root.sessionId))).toHaveLength(1);
      await expect(supervisor.models.start(root.sessionId, root.branchId, { ...request, input: { chunk: 2 } })).rejects.toThrow(/different request/i);
      await expect(supervisor.executeCell(root.sessionId, root.branchId, `
        return await rlm.start({ task: "override", model: { provider: "other", model: "forbidden" } });
      `)).rejects.toThrow(/parent model policy/i);
      expect((await supervisor.agents.listTasks(root.sessionId))).toHaveLength(1);
    } finally { await supervisor.close(); }
  });

  test("large results spill to durable artifacts and wall-time exhaustion remains distinct", async () => {
    const temp = await makeTempRuntime("agencity-rlm-results-"); temps.push(temp);
    const large = new PromptProvider("large-rlm", true);
    let supervisor = await open(temp, [large]);
    const root = await supervisor.createSession({ workspaceId: "results", model: { provider: large.name, model: "m" } });
    const handle = await supervisor.models.start(root.sessionId, root.branchId, { task: "large", idempotencyKey: "large" });
    const result = await supervisor.models.result(handle.handleId, { timeoutMs: 5_000 });
    expect(result.status).toBe("succeeded");
    expect((result.value as any).kind).toBe("artifact");
    expect(result.resultArtifactId).toMatch(/^sha256:/);
    const serialized = JSON.parse(JSON.stringify(handle));
    await supervisor.close();

    supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: [large], recover: true, heartbeatPollIntervalMs: 1_000 });
    try {
      const recovered = await supervisor.models.result(serialized.handleId, { wait: false });
      expect(recovered.status).toBe("succeeded");
      expect(recovered.resultArtifactId).toBe(result.resultArtifactId);
    } finally { await supervisor.close(); }

    const timedTemp = await makeTempRuntime("agencity-rlm-time-"); temps.push(timedTemp);
    const timed = new TimedProvider("timed-rlm");
    const timedSupervisor = await open(timedTemp, [timed]);
    try {
      const timedRoot = await timedSupervisor.createSession({ workspaceId: "timed", model: { provider: timed.name, model: "m" }, budget: { wallTimeLimitMs: 1_000 } });
      const timedHandle = await timedSupervisor.models.start(timedRoot.sessionId, timedRoot.branchId, { task: "time out", budget: { wallTimeLimitMs: 25 } });
      const timedResult = await timedSupervisor.models.result(timedHandle.handleId, { timeoutMs: 2_000 });
      expect(timedResult.status).toBe("budget-exceeded");
      expect((await timedSupervisor.models.get(timedHandle.handleId)).outcome).toBe("budget-exceeded");
    } finally { await timedSupervisor.close(); }
  });
});

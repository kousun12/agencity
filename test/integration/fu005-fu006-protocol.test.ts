import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentClient, ConflictError, InProcessProtocolTransport, ProtocolClientError, ProtocolServer, Supervisor,
  WORKSPACE_MATERIAL_EVENT_CLASS, projectEvents,
  type AgentEvent, type ProtocolTransport,
} from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, waitFor, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

async function fixture(prefix = "agencity-protocol-conformance-") {
  const temp = await makeTempRuntime(prefix); temps.push(temp);
  const supervisor = await Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, recover: false });
  return { temp, supervisor };
}

async function appendUnknown(supervisor: Supervisor, sessionId: string, branchId: string, effectId: string): Promise<void> {
  await supervisor.storage.appendEvents([{
    sessionId, branchId, type: "EffectRequested", producer: "supervisor", idempotencyKey: `request:${effectId}`,
    payload: { effectId, executor: "shell", operation: "run", input: { command: "ambiguous" }, origin: { kind: "runtime", requestId: `logical:${effectId}` }, idempotencyKey: `logical:${effectId}`, idempotent: false },
  }, {
    sessionId, branchId, type: "EffectAttemptStarted", producer: "supervisor", idempotencyKey: `attempt:${effectId}`,
    payload: { effectId, attempt: 1 },
  }, {
    sessionId, branchId, type: "EffectOutcomeRecorded", producer: "recovery", idempotencyKey: `outcome:${effectId}`,
    payload: { effectId, attempt: 1, outcome: "unknown", error: "worker disappeared", observedAt: new Date().toISOString() },
  }]);
}

describe("FU-005 protocol transport contract", () => {
  test("a terminal client can abort its outstanding protocol requests during detach", async () => {
    let requestSignal: AbortSignal | null = null;
    const transport: ProtocolTransport = {
      kind: "in-process",
      request: async (_path, init = {}) => {
        requestSignal = init.signal ?? null;
        await new Promise<void>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
        });
        throw new Error("unreachable");
      },
    };
    const client = new AgentClient(transport);
    const pending = client.serviceStatus();
    await Bun.sleep(0);
    client.abortPendingRequests("terminal detached");
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "terminal detached" });
    expect(requestSignal).not.toBeNull();
    expect((requestSignal as unknown as AbortSignal).aborted).toBe(true);
  });

  test("HTTP and in-process clients use the same router, request bodies, capabilities, typed errors, and reconciliation routes", async () => {
    const { supervisor } = await fixture();
    const protocol = new ProtocolServer(supervisor);
    const listener = protocol.listen(0);
    const clients = [
      new AgentClient(`http://127.0.0.1:${listener.port}`),
      new AgentClient(new InProcessProtocolTransport(protocol)),
    ];
    try {
      for (const [index, client] of clients.entries()) {
        expect(await client.capabilities()).toMatchObject({ protocol: "agencity.protocol", version: 1, mode: "trusted-local", snapshotCursorResume: true });
        const session = await client.createSession(`transport-${index}`, { sessionName: `transport ${index}` });
        await client.message(session.sessionId, session.branchId, `body-${index}`);
        expect((await client.snapshot(session.sessionId, session.branchId)).state.messages.at(-1)?.content).toBe(`body-${index}`);
        const effectId = `unknown-${index}`;
        await appendUnknown(supervisor, session.sessionId, session.branchId, effectId);
        expect(await client.unknownEffects(session.sessionId, session.branchId)).toEqual([
          expect.objectContaining({ effect: expect.objectContaining({ id: effectId, status: "unknown" }), retryAllowed: false }),
        ]);
        const recorded = await client.reconcileUnknownEffect(session.sessionId, session.branchId, effectId, {
          reconciliationId: `assessment-${index}`, assessment: "no_effect", summary: "Remote system shows no invocation", recordedBy: "operator",
        });
        expect(recorded).toMatchObject({ durableEffectStatus: "unknown", retried: false, assessment: "no_effect" });
        expect((await client.inspectUnknownEffect(session.sessionId, session.branchId, effectId)).effect.status).toBe("unknown");
        await expect(client.snapshot("missing", "missing")).rejects.toMatchObject({
          name: "ProtocolClientError", code: "NOT_FOUND", status: 404, details: { kind: "session branch", id: "missing/missing" },
        });
      }
    } finally {
      protocol.stop(); await supervisor.close();
    }
  });

  test("both transports return the same scrubbed authentication error", async () => {
    const { supervisor } = await fixture("agencity-protocol-auth-");
    const protocol = new ProtocolServer(supervisor, { bearerToken: "owner-token" });
    const listener = protocol.listen(0);
    try {
      for (const client of [
        new AgentClient(`http://127.0.0.1:${listener.port}`, "wrong-token"),
        new AgentClient(new InProcessProtocolTransport(protocol, "wrong-token")),
      ]) {
        await expect(client.capabilities()).rejects.toEqual(expect.objectContaining({
          name: "ProtocolClientError", code: "UNAUTHORIZED", status: 401,
        }));
      }
    } finally { protocol.stop(); await supervisor.close(); }
  });

  test("a quiet HTTP branch stream opens immediately and stays connected past the server idle timeout", async () => {
    const { supervisor } = await fixture("agencity-sse-idle-");
    const session = await supervisor.createSession({ workspaceId: "sse-idle" });
    const after = (await supervisor.projections.getSnapshot(session.sessionId, session.branchId)).cursor;
    const protocol = new ProtocolServer(supervisor, { httpIdleTimeoutSeconds: 1 });
    const listener = protocol.listen(0);
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await Promise.race([
        fetch(`http://127.0.0.1:${listener.port}/sessions/${session.sessionId}/stream?branch=${session.branchId}&after=${after}`, {
          signal: controller.signal,
        }),
        Bun.sleep(500).then(() => { throw new Error("Quiet SSE response did not open"); }),
      ]);
      expect(response.status).toBe(200);
      reader = response.body!.getReader();
      const opened = await reader.read();
      expect(new TextDecoder().decode(opened.value)).toBe(": connected\n\n");

      await Bun.sleep(1_250);
      await supervisor.appendMessage(session.sessionId, session.branchId, "user", "after idle timeout");
      const delivered = await Promise.race([
        reader.read(),
        Bun.sleep(500).then(() => { throw new Error("SSE stream disconnected while idle"); }),
      ]);
      expect(delivered.done).toBe(false);
      expect(new TextDecoder().decode(delivered.value)).toContain("after idle timeout");
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
      await protocol.stop(true);
      await supervisor.close();
    }
  });

  test("an SSE enqueue failure immediately unsubscribes committed-event and progress listeners", async () => {
    const { supervisor } = await fixture("agencity-sse-enqueue-failure-");
    const session = await supervisor.createSession({ workspaceId: "sse-enqueue" });
    const protocol = new ProtocolServer(supervisor);
    const after = (await supervisor.projections.getSnapshot(session.sessionId, session.branchId)).cursor;

    let eventListeners = 0;
    let progressListeners = 0;
    const projectionSource = supervisor.projections;
    const originalSubscribe = projectionSource.subscribe.bind(projectionSource);
    projectionSource.subscribe = ((...args: Parameters<typeof originalSubscribe>) => {
      eventListeners++;
      const release = originalSubscribe(...args);
      let active = true;
      return () => { if (!active) return; active = false; eventListeners--; release(); };
    }) as typeof projectionSource.subscribe;
    const outbox = supervisor.outbox;
    const originalProgress = outbox.onProgress.bind(outbox);
    outbox.onProgress = ((...args: Parameters<typeof originalProgress>) => {
      progressListeners++;
      const release = originalProgress(...args);
      let active = true;
      return () => { if (!active) return; active = false; progressListeners--; release(); };
    }) as typeof outbox.onProgress;

    const controller = new AbortController();
    const response = await protocol.handle(new Request(
      `http://agencity.local/sessions/${session.sessionId}/stream?branch=${session.branchId}&after=${after}`,
      { signal: controller.signal },
    ));
    expect(response.status).toBe(200);
    expect({ eventListeners, progressListeners }).toEqual({ eventListeners: 1, progressListeners: 1 });

    const prototype = ReadableStreamDefaultController.prototype as ReadableStreamDefaultController<Uint8Array>;
    const originalEnqueue = prototype.enqueue;
    let rejectNextEnqueue = true;
    prototype.enqueue = function (chunk: Uint8Array): void {
      if (rejectNextEnqueue) { rejectNextEnqueue = false; throw new TypeError("forced closed stream"); }
      return originalEnqueue.call(this, chunk);
    };
    try {
      await supervisor.appendMessage(session.sessionId, session.branchId, "user", "force SSE delivery");
      await waitFor(() => eventListeners === 0 && progressListeners === 0, "SSE listener cleanup after enqueue failure");
    } finally {
      prototype.enqueue = originalEnqueue;
      controller.abort();
      await response.body?.cancel().catch(() => {});
      projectionSource.subscribe = originalSubscribe;
      outbox.onProgress = originalProgress;
      await supervisor.close();
    }
  });

  test("watchBranch retries from the last successfully applied cursor, deduplicates, and discards ephemeral progress", async () => {
    const { supervisor } = await fixture("agencity-watch-reconnect-");
    const session = await supervisor.createSession({ workspaceId: "watch" });
    const protocol = new ProtocolServer(supervisor);
    const base = new InProcessProtocolTransport(protocol);
    let snapshotHook = true; let streamAttempt = 0; let firstEvent: AgentEvent | undefined;
    const transport: ProtocolTransport = {
      kind: "in-process",
      async request(path, init) {
        if (path.includes("/snapshot")) {
          const response = await base.request(path, init);
          if (snapshotHook) {
            snapshotHook = false;
            firstEvent = await supervisor.appendMessage(session.sessionId, session.branchId, "user", "first after snapshot");
          }
          return response;
        }
        if (path.includes("/stream?")) {
          streamAttempt++;
          if (streamAttempt === 2) await supervisor.appendMessage(session.sessionId, session.branchId, "user", "second after reconnect");
          const after = new URL(`http://local${path}`).searchParams.get("after")!;
          const retained = await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId, afterCursor: after });
          const events = streamAttempt === 1 ? retained.filter((event) => event.id === firstEvent?.id) : retained;
          const progress = streamAttempt === 1 ? `event: progress\ndata: ${JSON.stringify({ type: "effect-progress", effectId: "ephemeral", sessionId: session.sessionId, branchId: session.branchId, executor: "model", operation: "complete", attempt: 1, sequence: 0, kind: "model-output-delta", value: { text: "temporary" }, observedAt: new Date().toISOString() })}\n\n` : "";
          return new Response(`${progress}${events.map((event) => `id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`).join("")}`, { headers: { "content-type": "text/event-stream" } });
        }
        return base.request(path, init);
      },
    };
    const client = new AgentClient(transport);
    const applied: string[] = []; const reconnects: Array<{ attempt: number; cursor: string }> = []; const discards: string[] = []; const connectionStates: string[] = [];
    let failFirstDelivery = true;
    await client.watchBranch(session.sessionId, session.branchId, {
      onSnapshot: () => {},
      async onEvent(event) {
        if (event.id === firstEvent?.id && failFirstDelivery) { failFirstDelivery = false; throw new Error("renderer failed before apply"); }
        await Bun.sleep(1);
        applied.push(event.id);
      },
      onProgress: () => {},
      onProgressDiscard: (ids, reason) => { discards.push(`${reason}:${ids.join(",")}`); },
      onReconnect: (attempt, cursor) => { reconnects.push({ attempt, cursor }); },
      onConnectionState: state => { connectionStates.push(state); },
    }, { reconnectDelayMs: 0, maxReconnects: 1 });
    expect(streamAttempt).toBe(2);
    expect(applied.filter((id) => id === firstEvent!.id)).toHaveLength(1);
    expect(applied).toHaveLength(2);
    expect(reconnects).toEqual([{ attempt: 1, cursor: expect.any(String) }]);
    expect(connectionStates).toEqual(["connected", "disconnected", "reconnecting", "connected", "disconnected"]);
    expect(BigInt(reconnects[0]!.cursor)).toBeLessThan(BigInt(firstEvent!.cursor));
    expect(discards).toContain("disconnect:ephemeral");
    await supervisor.close();
  });
});

describe("FU-006 append-only unknown-effect reconciliation", () => {
  test("records evidence idempotently, never rewrites unknown status, and rebuilds deterministically", async () => {
    const { supervisor } = await fixture("agencity-effect-reconcile-");
    const session = await supervisor.createSession({ workspaceId: "reconciliation" });
    await appendUnknown(supervisor, session.sessionId, session.branchId, "effect-unknown");
    const input = { reconciliationId: "operator-assessment", assessment: "succeeded" as const, summary: "Provider audit contains a matching receipt", evidence: { receipt: "external-1" }, recordedBy: "owner" };
    const first = await supervisor.effectReconciliation.record(session.sessionId, session.branchId, "effect-unknown", input);
    const duplicate = await supervisor.effectReconciliation.record(session.sessionId, session.branchId, "effect-unknown", input);
    expect(duplicate).toEqual(first);
    await expect(supervisor.effectReconciliation.record(session.sessionId, session.branchId, "effect-unknown", { ...input, summary: "different" }))
      .rejects.toBeInstanceOf(ConflictError);
    const before = await supervisor.projections.getSnapshot(session.sessionId, session.branchId);
    expect(before.state.effects["effect-unknown"]?.status).toBe("unknown");
    expect(Object.values(before.state.effectReconciliations)).toHaveLength(1);
    expect((await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId })).filter((event) => event.type === "EffectReconciliationRecorded")).toHaveLength(1);
    const rebuilt = await supervisor.projections.rebuild(session.sessionId, session.branchId);
    expect(rebuilt).toEqual(before.state);
    expect(rebuilt.effects["effect-unknown"]?.status).toBe("unknown");
    expect(WORKSPACE_MATERIAL_EVENT_CLASS.EffectReconciliationRecorded).toBe("non-material");
    await supervisor.close();
  });

  test("rejects reconciliation for a non-unknown effect", async () => {
    const { supervisor } = await fixture("agencity-effect-reconcile-invalid-");
    const session = await supervisor.createSession({ workspaceId: "reconciliation" });
    const effectId = "effect-failed";
    await supervisor.storage.appendEvents([{
      sessionId: session.sessionId, branchId: session.branchId, type: "EffectRequested", producer: "supervisor", idempotencyKey: "failed-request",
      payload: { effectId, executor: "shell", operation: "run", input: {}, origin: { kind: "runtime", requestId: "failed-logical" }, idempotencyKey: "failed-logical", idempotent: false },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "EffectOutcomeRecorded", producer: "supervisor", idempotencyKey: "failed-outcome",
      payload: { effectId, attempt: 1, outcome: "failed", error: "known failure", observedAt: new Date().toISOString() },
    }]);
    await expect(supervisor.effectReconciliation.record(session.sessionId, session.branchId, effectId, { assessment: "failed", summary: "already known", recordedBy: "owner" }))
      .rejects.toThrow("only unknown effects");
    expect(projectEvents(await supervisor.storage.loadEvents(session.sessionId, { branchId: session.branchId })).effects[effectId]?.status).toBe("failed");
    await supervisor.close();
  });
});

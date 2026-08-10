import { expect } from "bun:test";
import { join } from "node:path";
import type {
  AgentStorage, ArtifactStore, EffectExecutor, MemoryCandidateIndex,
} from "../../src/index.ts";
import { projectEvents } from "../../src/index.ts";
import { fixtureAgentProfile } from "../helpers.ts";

export async function relationalStateConformance(storage: AgentStorage, suffix: string): Promise<void> {
  const sessionId = `placement-session-${suffix}`, branchId = "main";
  const committed = await storage.appendEvents([{
    id: `placement-created-${suffix}`,
    sessionId,
    branchId,
    type: "SessionCreated",
    producer: "supervisor",
    idempotencyKey: `placement-session:${suffix}`,
    committedAt: "2026-08-05T00:00:00.000Z",
    payload: { workspaceId: `workspace-${suffix}`, initialBranchId: branchId, model: { provider: "echo", model: "echo", reasoningEffort: "provider-default" }, budget: {}, agentProfile: fixtureAgentProfile(sessionId) },
  }, {
    id: `placement-message-${suffix}`,
    sessionId,
    branchId,
    type: "MessageAppended",
    producer: "client",
    idempotencyKey: `placement-message:${suffix}`,
    committedAt: "2026-08-05T00:00:01.000Z",
    payload: { messageId: `message-${suffix}`, role: "user", content: "transport invariant" },
  }]);
  expect(committed).toHaveLength(2);
  expect((await storage.appendEvents([{
    id: `placement-message-${suffix}`,
    sessionId,
    branchId,
    type: "MessageAppended",
    producer: "client",
    idempotencyKey: `placement-message:${suffix}`,
    committedAt: "2026-08-05T00:00:01.000Z",
    payload: { messageId: `message-${suffix}`, role: "user", content: "transport invariant" },
  }]))[0]?.id).toBe(`placement-message-${suffix}`);
  const loaded = await storage.loadEvents(sessionId, { branchId, afterCursor: committed[0]!.cursor });
  expect(loaded.map((event) => event.id)).toEqual([`placement-message-${suffix}`]);
  expect((await storage.getEvent(`placement-message-${suffix}`))?.payload).toEqual({ messageId: `message-${suffix}`, role: "user", content: "transport invariant" });
  expect(await storage.getLatestCursor(sessionId, branchId)).toBe(committed[1]!.cursor);
  expect(await storage.listBranches()).toContainEqual({ sessionId, branchId });
  const [markerEvent] = await storage.appendEvents([{
    id: `placement-wire-marker-${suffix}`, sessionId, branchId, type: "WorkingValueSet", producer: "console",
    idempotencyKey: `placement-wire-marker:${suffix}`, committedAt: "2026-08-05T00:00:02.000Z",
    payload: { name: "wire-marker", version: 1, value: { kind: "json", value: { __agencity_wire_v1__: "undefined" } } },
  }]);
  expect(markerEvent?.payload).toEqual({ name: "wire-marker", version: 1, value: { kind: "json", value: { __agencity_wire_v1__: "undefined" } } });
  const projected = projectEvents(await storage.loadEvents(sessionId, { branchId }));
  await storage.saveSnapshot(projected);
  expect(await storage.loadSnapshot(sessionId, branchId)).toEqual(projected);
  await storage.deleteSnapshots(sessionId);
  expect(await storage.loadSnapshot(sessionId, branchId)).toBeNull();
  expect(await storage.readonlyQuery({ sql: "SELECT type FROM events WHERE id=?", args: [`placement-message-${suffix}`] })).toEqual([{ type: "MessageAppended" }]);
  expect(await storage.getSession?.(sessionId)).toMatchObject({ sessionId, workspaceId: `workspace-${suffix}` });
}

export async function artifactStoreConformance(store: ArtifactStore, exportDirectory: string): Promise<void> {
  const content = new TextEncoder().encode("placement-stable-content-0123456789");
  const [first, second] = await Promise.all([
    store.put(content, { mediaType: "text/plain" }),
    store.put(content, { mediaType: "application/x-same-bytes" }),
  ]);
  expect(first.artifactId).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(second.artifactId).toBe(first.artifactId);
  expect(second.digest).toBe(first.digest);
  expect(new Uint8Array(await store.resolve(first))).toEqual(content);
  expect(await store.verify(first)).toBe(true);
  expect(new TextDecoder().decode(await store.readRange(first, 10, 16))).toBe("stable");
  const target = join(exportDirectory, `${store.name.replaceAll(/[^a-z0-9]/gi, "-")}.txt`);
  await store.export(first, target);
  expect(new Uint8Array(await Bun.file(target).arrayBuffer())).toEqual(content);
  await store.delete(first);
  expect(await store.verify(first)).toBe(false);
  await expect(store.resolve(first)).rejects.toMatchObject({ code: "DEPENDENCY_FAILURE" });
}

export async function candidateIndexConformance(index: MemoryCandidateIndex): Promise<void> {
  await index.rebuild();
  const first = await index.candidates("placement sentinel");
  const second = await index.candidates("placement sentinel");
  expect(first.length).toBeGreaterThan(0);
  expect(second).toEqual(first);
  expect(first.every((item) => item.versionId.length > 0 && item.entryId.length > 0 && Number.isFinite(item.rank))).toBe(true);
  expect(await index.candidates("definitelyabsenttoken")).toEqual([]);
}

export async function executorConformance(executor: EffectExecutor, suffix: string): Promise<void> {
  const base = {
    effectId: `effect-${suffix}`,
    sessionId: `session-${suffix}`,
    branchId: "main",
    executor: executor.name,
    idempotencyKey: `executor-placement:${suffix}`,
    idempotent: true,
    attempt: 1,
  } as const;
  const success = await executor.execute({ ...base, operation: "run", input: { command: "printf conformance" } }, { signal: new AbortController().signal });
  expect(success).toMatchObject({
    outcome: "succeeded",
    output: {
      completeness: "inline",
      value: { exitCode: 0, stdout: "conformance" },
    },
  });
  const failure = await executor.execute({ ...base, effectId: `${base.effectId}-failed`, operation: "run", input: { command: "printf failure >&2; exit 7" } }, { signal: new AbortController().signal });
  expect(failure).toMatchObject({
    outcome: "failed",
    output: { completeness: "inline", value: { exitCode: 7, stderr: "failure" } },
  });
  const cancelled = new AbortController(); cancelled.abort();
  expect(await executor.execute({ ...base, effectId: `${base.effectId}-cancelled`, operation: "run", input: { command: "exit 0" } }, { signal: cancelled.signal })).toMatchObject({ outcome: "cancelled" });
  await expect(Promise.resolve().then(() => executor.execute({ ...base, effectId: `${base.effectId}-unsupported`, operation: "unsupported", input: {} }, { signal: new AbortController().signal }))).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
}

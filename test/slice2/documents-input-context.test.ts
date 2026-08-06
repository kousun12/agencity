import { afterEach, describe, expect, test } from "bun:test";
import { Supervisor, type ImportDocumentInput } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, waitFor, type TempRuntime } from "../helpers.ts";
import { RecordingProvider } from "./helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

async function open(temp: TempRuntime, providers: readonly RecordingProvider[] = [], recover = false): Promise<Supervisor> {
  return Supervisor.open({ databaseUrl: temp.databaseUrl, artifactDirectory: temp.artifactDirectory, workspaceRoot: temp.workspaceRoot, modelProviders: providers, recover });
}

describe("Slice 2 deterministic, scoped document inputs", () => {
  test("document import retry is idempotent and preserves deterministic chunk row ids", async () => {
    const temp = await makeTempRuntime("agencity-slice2-doc-retry-"); temps.push(temp);
    const supervisor = await open(temp);
    try {
      const root = await supervisor.createSession({ workspaceId: "documents" });
      type IdempotentImport = ImportDocumentInput & { readonly idempotencyKey: string };
      const request: IdempotentImport = { content: "αβγ".repeat(300), name: "unicode.txt", chunkBytes: 256, idempotencyKey: "import-unicode-v1" };
      const first = await supervisor.documents.import(root.sessionId, root.branchId, request);
      const firstChunks = await supervisor.documents.readChunks(first.documentId);
      const retried = await supervisor.documents.import(root.sessionId, root.branchId, request);
      const retriedChunks = await supervisor.documents.readChunks(retried.documentId);
      expect(retried).toEqual(first);
      expect(retriedChunks.map((chunk) => chunk.chunkId)).toEqual(firstChunks.map((chunk) => chunk.chunkId));
      expect(retriedChunks.map((chunk) => chunk.digest)).toEqual(firstChunks.map((chunk) => chunk.digest));
    } finally { await supervisor.close(); }
  });

  test("ordered chunk paging resumes without gaps after storage reopen", async () => {
    const temp = await makeTempRuntime("agencity-slice2-doc-resume-"); temps.push(temp);
    const supervisor = await open(temp);
    const root = await supervisor.createSession({ workspaceId: "resume" });
    const document = await supervisor.documents.import(root.sessionId, root.branchId, { content: "0123456789".repeat(200), chunkBytes: 256 });
    const firstPage = await supervisor.documents.readChunks(document.documentId, { start: 0, limit: 3 });
    await supervisor.close();

    const resumed = await open(temp, [], true);
    try {
      const rest = await resumed.documents.readChunks(document.documentId, { start: firstPage.length, limit: 100 });
      const all = await resumed.documents.readChunks(document.documentId, { start: 0, limit: 100 });
      expect([...firstPage, ...rest].map((chunk) => chunk.chunkId)).toEqual(all.map((chunk) => chunk.chunkId));
      expect(all.map((chunk) => chunk.ordinal)).toEqual(all.map((_, index) => index));
      expect(all.map((chunk) => chunk.content).join("")).toBe("0123456789".repeat(200));
      expect(all.every((chunk) => new TextEncoder().encode(chunk.content).byteLength <= 256)).toBe(true);
    } finally { await resumed.close(); }
  });

  test("input sets cannot link chunks from another root family", async () => {
    const temp = await makeTempRuntime("agencity-slice2-doc-scope-"); temps.push(temp);
    const supervisor = await open(temp);
    try {
      const owner = await supervisor.createSession({ workspaceId: "same" });
      const stranger = await supervisor.createSession({ workspaceId: "same" });
      const document = await supervisor.documents.import(owner.sessionId, owner.branchId, { content: "private".repeat(100), chunkBytes: 256 });
      const chunk = (await supervisor.documents.readChunks(document.documentId))[0]!;
      await expect(supervisor.documents.createInputSet(stranger.sessionId, stranger.branchId, { chunkIds: [chunk.chunkId] }))
        .rejects.toThrow(/scope|family|session|owner/i);
    } finally { await supervisor.close(); }
  });

  test("the exact ordered inputSet chunk ids and contents reach the recursive child context", async () => {
    const temp = await makeTempRuntime("agencity-slice2-input-context-"); temps.push(temp);
    const provider = new RecordingProvider("capture-input");
    const supervisor = await open(temp, [provider]);
    try {
      const root = await supervisor.createSession({ workspaceId: "input", model: { provider: provider.name, model: "capture" } });
      const a = "A".repeat(256); const b = "B".repeat(256); const c = "C".repeat(256);
      const document = await supervisor.documents.import(root.sessionId, root.branchId, { content: a + b + c, chunkBytes: 256 });
      const chunks = await supervisor.documents.readChunks(document.documentId);
      const selectedIds = [chunks[2]!.chunkId, chunks[0]!.chunkId];
      const inputSet = await supervisor.documents.createInputSet(root.sessionId, root.branchId, { chunkIds: selectedIds, name: "non-contiguous" });
      const handle = await supervisor.models.start(root.sessionId, root.branchId, { prompt: "inspect only selected chunks", inputSetId: inputSet.inputSetId });
      await waitFor(async () => ["completed", "failed"].includes((await supervisor.models.get(handle.handleId)).status), "recursive input model");
      expect((await supervisor.models.get(handle.handleId)).status).toBe("completed");
      expect(provider.contexts).toHaveLength(1);
      const serialized = JSON.stringify(provider.contexts[0]);
      expect(serialized).toContain(selectedIds[0]!);
      expect(serialized).toContain(selectedIds[1]!);
      expect(serialized.indexOf(selectedIds[0]!)).toBeLessThan(serialized.indexOf(selectedIds[1]!));
      expect(serialized).toContain(c);
      expect(serialized).toContain(a);
      expect(serialized).not.toContain(b);
    } finally { await Bun.sleep(30); await supervisor.close(); }
  });

  test("a root model call receives metadata, never the full over-context document", async () => {
    const temp = await makeTempRuntime("agencity-slice2-root-context-"); temps.push(temp);
    const provider = new RecordingProvider("capture-root");
    const supervisor = await open(temp, [provider]);
    try {
      const root = await supervisor.createSession({ workspaceId: "large", model: { provider: provider.name, model: "capture" } });
      const huge = `BEGIN-PRIVATE-${"z".repeat(200_000)}-END-PRIVATE`;
      const document = await supervisor.documents.import(root.sessionId, root.branchId, { content: huge, name: "huge.txt", chunkBytes: 16 * 1024 });
      await supervisor.appendMessage(root.sessionId, root.branchId, "user", "Summarize by querying selected ranges");
      expect((await supervisor.modelLoop.turn(root.sessionId, root.branchId)).outcome).toBe("succeeded");
      const serialized = JSON.stringify(provider.contexts[0]);
      expect(serialized).toContain(document.documentId);
      expect(serialized).toContain(document.digest);
      expect(serialized).not.toContain(huge);
      expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(new TextEncoder().encode(huge).byteLength / 4);
    } finally { await supervisor.close(); }
  });
});

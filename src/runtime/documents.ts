import { NotFoundError, ValidationError, newId, type JsonValue } from "../domain/index.ts";
import { requireRecursiveStorage, type AgentStorage, type DocumentChunkRecord, type InputSetRecord } from "../storage/index.ts";

export interface ImportDocumentInput { readonly content: string; readonly name?: string; readonly mediaType?: string; readonly chunkBytes?: number; readonly idempotencyKey?: string; }
export interface DocumentHandle { readonly documentId: string; readonly sessionId: string; readonly branchId: string; readonly name: string; readonly mediaType: string; readonly size: number; readonly digest: string; readonly chunkCount: number; }
export interface CreateInputSetInput { readonly chunkIds: readonly string[]; readonly name?: string; readonly metadata?: JsonValue; }
export interface InputSetHandle extends InputSetRecord {}

function sha256(value: string): string { const hash = new Bun.CryptoHasher("sha256"); hash.update(value); return hash.digest("hex"); }
function splitText(content: string, maxBytes: number): string[] {
  if (content.length === 0) return [];
  const encoder = new TextEncoder(); const chunks: string[] = []; let current = ""; let bytes = 0;
  for (const character of content) {
    const size = encoder.encode(character).byteLength;
    if (current && bytes + size > maxBytes) { chunks.push(current); current = ""; bytes = 0; }
    current += character; bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

export class DocumentService {
  readonly #recursive;
  constructor(readonly storage: AgentStorage) { this.#recursive = requireRecursiveStorage(storage); }

  async import(sessionId: string, branchId: string, rawInput: ImportDocumentInput | string): Promise<DocumentHandle> {
    const input: ImportDocumentInput = typeof rawInput === "string" ? { content: rawInput } : rawInput;
    const session = await this.#recursive.getSession(sessionId); if (!session) throw new NotFoundError("session", sessionId);
    if (!(await this.storage.loadEvents(sessionId, { branchId })).length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const chunkBytes = input.chunkBytes ?? 32 * 1024;
    if (!Number.isInteger(chunkBytes) || chunkBytes < 256 || chunkBytes > 256 * 1024) throw new ValidationError("Document chunkBytes must be between 256 and 262144");
    const chunks = splitText(input.content, chunkBytes); const encoder = new TextEncoder();
    if (input.idempotencyKey !== undefined && !input.idempotencyKey.trim()) throw new ValidationError("Document idempotencyKey cannot be empty");
    const documentId = input.idempotencyKey === undefined ? newId() : `document-${sha256(`${sessionId}/${branchId}/${input.idempotencyKey}`).slice(0, 32)}`;
    const name = input.name ?? `document-${documentId}`; const mediaType = input.mediaType ?? "text/plain";
    const imported = { documentId, name, mediaType, size: encoder.encode(input.content).byteLength, digest: sha256(input.content), chunkCount: chunks.length };
    await this.storage.appendEvents([{
      sessionId, branchId, type: "DocumentImported", producer: "client", idempotencyKey: `document:${documentId}`, payload: imported,
    }, ...chunks.map((content, ordinal) => ({
      sessionId, branchId, type: "DocumentChunkAdded" as const, producer: "client", idempotencyKey: `document-chunk:${documentId}:${ordinal}`,
      payload: { documentId, chunkId: `chunk-${sha256(`${documentId}/${ordinal}/${sha256(content)}`).slice(0, 32)}`, ordinal, content, size: encoder.encode(content).byteLength, digest: sha256(content) },
    }))]);
    return { ...imported, sessionId, branchId };
  }

  async readChunks(documentId: string, options: { readonly start?: number; readonly limit?: number; readonly chunkIds?: readonly string[] } = {}): Promise<DocumentChunkRecord[]> {
    if (!(await this.#recursive.getDocument(documentId))) throw new NotFoundError("document", documentId);
    return this.#recursive.readDocumentChunks(documentId, options);
  }

  async createInputSet(sessionId: string, branchId: string, rawInput: CreateInputSetInput | readonly string[]): Promise<InputSetHandle> {
    const input: CreateInputSetInput = Array.isArray(rawInput) ? { chunkIds: rawInput } : rawInput as CreateInputSetInput;
    if (new Set(input.chunkIds).size !== input.chunkIds.length) throw new ValidationError("Input set chunks must be unique");
    const session = await this.#recursive.getSession(sessionId); if (!session) throw new NotFoundError("session", sessionId);
    if (!(await this.storage.loadEvents(sessionId, { branchId })).length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    // Chunks are addressable globally in storage, but capability scope is the
    // caller's durable root family (workspace equality is intentionally insufficient).
    for (const chunkId of input.chunkIds) {
      const chunk = await this.#recursive.getDocumentChunk(chunkId);
      if (!chunk) throw new NotFoundError("document chunk", chunkId);
      const document = await this.#recursive.getDocument(chunk.documentId);
      const owner = document && await this.#recursive.getSession(document.sessionId);
      if (!document || !owner || owner.rootSessionId !== session.rootSessionId) throw new ValidationError("Input set chunk is outside the session family scope");
    }
    const inputSetId = newId();
    await this.storage.appendEvents([{
      sessionId, branchId, type: "InputSetCreated", producer: "client", idempotencyKey: `input-set:${inputSetId}`,
      payload: { inputSetId, ...(input.name === undefined ? {} : { name: input.name }), chunkIds: [...input.chunkIds], ...(input.metadata === undefined ? {} : { metadata: input.metadata }) },
    }]);
    const record = await this.#recursive.getInputSet(inputSetId); if (!record) throw new NotFoundError("input set", inputSetId); return record;
  }
}

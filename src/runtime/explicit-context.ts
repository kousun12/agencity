import type { ArtifactStore } from "../artifacts/index.ts";
import {
  NotFoundError,
  ValidationError,
  assertJsonValue,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  projectEvents,
  type ArtifactReference,
  type JsonValue,
} from "../domain/index.ts";
import { containsBrokeredSecret } from "../security/index.ts";
import { requireRecursiveStorage, type AgentStorage } from "../storage/index.ts";
import type { MemoryService } from "./memory.ts";

export const MAX_EXPLICIT_CONTEXT_BYTES = 256 * 1024;
export const MAX_EXPLICIT_CONTEXT_ITEMS = 64;
export const MAX_EXPLICIT_SQL_ROWS = 100;
export const MAX_EXPLICIT_CONTEXT_DEPTH = 64;
export const MAX_EXPLICIT_CONTEXT_NODES = 10_000;

export type ExplicitContextReference =
  | { readonly kind: "artifact"; readonly artifactId: string; readonly start?: number; readonly end?: number }
  | { readonly kind: "document-range"; readonly documentId: string; readonly start?: number; readonly limit?: number; readonly chunkIds?: readonly string[] }
  | { readonly kind: "event"; readonly eventId: string }
  | { readonly kind: "memory"; readonly entryId: string; readonly versionId?: string }
  | { readonly kind: "sql-row"; readonly query: string; readonly args?: readonly (string | number | boolean | null)[]; readonly row?: number }
  | { readonly kind: "sql-rows"; readonly query: string; readonly args?: readonly (string | number | boolean | null)[]; readonly limit?: number };

export type ExplicitContextInput = JsonValue | ExplicitContextReference;

export interface FrozenExplicitContext {
  readonly value: JsonValue;
  readonly provenance: JsonValue;
  readonly digest: `sha256:${string}`;
  readonly exactUtf8Bytes: number;
}

/**
 * Materializes only caller-selected values and durable references. It never
 * consults ContextMaterializer and therefore cannot add branch conversation,
 * profiles, memories, skills, repository instructions, or retrieval results.
 */
export class ExplicitContextMaterializer {
  readonly #recursive;
  constructor(
    readonly storage: AgentStorage,
    readonly artifacts?: ArtifactStore,
    readonly memory?: MemoryService,
  ) {
    this.#recursive = requireRecursiveStorage(storage);
  }

  async materialize(
    sessionId: string,
    branchId: string,
    rootSessionId: string,
    inputs: readonly ExplicitContextInput[] = [],
  ): Promise<FrozenExplicitContext> {
    if (!Array.isArray(inputs) || inputs.length > MAX_EXPLICIT_CONTEXT_ITEMS) {
      throw new ValidationError(`Explicit AI context accepts at most ${MAX_EXPLICIT_CONTEXT_ITEMS} ordered items`);
    }
    const values: JsonValue[] = [];
    const sources: Record<string, JsonValue>[] = [];
    for (let position = 0; position < inputs.length; position++) {
      const resolved = await this.#resolvePart(sessionId, branchId, rootSessionId, inputs[position]);
      values.push(resolved.value);
      sources.push({ position, ...resolved.provenance });
    }
    const value = values;
    if (containsBrokeredSecret(value)) {
      throw new ValidationError("Registered credential values cannot enter explicit AI context");
    }
    const exactUtf8Bytes = canonicalJsonByteLength(value);
    if (exactUtf8Bytes > MAX_EXPLICIT_CONTEXT_BYTES) {
      throw new ValidationError(`Materialized explicit AI context exceeds ${MAX_EXPLICIT_CONTEXT_BYTES} bytes`);
    }
    const omissions = sources.flatMap((source, position) =>
      source.complete === false ? [{ position, reason: "bounded-reference" }] : []);
    const provenance = {
      version: "agencity.explicit-context.v1",
      ordered: true,
      complete: omissions.length === 0,
      itemCount: values.length,
      exactUtf8Bytes,
      omissions,
      sources,
    } satisfies JsonValue;
    if (containsBrokeredSecret(provenance)) {
      throw new ValidationError("Registered credential values cannot enter explicit AI context provenance");
    }
    return Object.freeze({
      value,
      provenance,
      digest: canonicalJsonDigest(value),
      exactUtf8Bytes,
    });
  }

  async #resolvePart(
    sessionId: string,
    branchId: string,
    rootSessionId: string,
    raw: unknown,
  ): Promise<{ value: JsonValue; provenance: Record<string, JsonValue> }> {
    const checked = cloneExactJsonValue(raw);
    if (!checked || typeof checked !== "object" || Array.isArray(checked) || typeof checked.kind !== "string" ||
        !["artifact", "document-range", "event", "memory", "sql-row", "sql-rows"].includes(checked.kind)) {
      const value = checked;
      return {
        value,
        provenance: {
          kind: "inline-json",
          digest: canonicalJsonDigest(value),
          exactUtf8Bytes: canonicalJsonByteLength(value),
          complete: true,
        },
      };
    }
    const reference = checked as Record<string, JsonValue>;
    if (reference.kind === "artifact") {
      assertReferenceKeys(reference, ["kind", "artifactId", "start", "end"], "artifact");
      if (typeof reference.artifactId !== "string") throw new ValidationError("Artifact context requires artifactId");
      if (!this.artifacts) throw new ValidationError("Artifact context resolution is unavailable");
      const found = await this.#familyArtifact(rootSessionId, reference.artifactId);
      if (!found) throw new NotFoundError("family artifact", reference.artifactId);
      const start = reference.start === undefined ? 0 : Number(reference.start);
      const end = reference.end === undefined ? found.size : Number(reference.end);
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start || end > found.size) {
        throw new ValidationError("Invalid explicit artifact range");
      }
      const artifactBytes = await this.artifacts.readRange(found, start, end);
      let value: string;
      try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(artifactBytes);
      } catch {
        throw new ValidationError("Explicit artifact context is not valid UTF-8");
      }
      return {
        value,
        provenance: {
          kind: "artifact", artifactId: found.artifactId, digest: found.digest,
          mediaType: found.mediaType, size: found.size, start, end,
          rangeDigest: canonicalJsonDigest(value), sourceBytes: artifactBytes.byteLength,
          exactUtf8Bytes: canonicalJsonByteLength(value),
          complete: start === 0 && end === found.size,
        },
      };
    }
    if (reference.kind === "document-range") {
      assertReferenceKeys(reference, ["kind", "documentId", "start", "limit", "chunkIds"], "document-range");
      if (typeof reference.documentId !== "string") throw new ValidationError("Document context requires documentId");
      const document = await this.#recursive.getDocument(reference.documentId);
      if (!document) throw new NotFoundError("document", reference.documentId);
      const owner = await this.#recursive.getSession(document.sessionId);
      if (!owner || owner.rootSessionId !== rootSessionId) throw new ValidationError("Document context is outside the caller family");
      const chunkIds = reference.chunkIds === undefined ? undefined : asStringArray(reference.chunkIds, "document chunkIds");
      let start = 0;
      let limit = 20;
      let complete: boolean;
      let chunks: import("../storage/index.ts").DocumentChunkRecord[];
      if (chunkIds !== undefined) {
        if (reference.start !== undefined || reference.limit !== undefined) {
          throw new ValidationError("Document chunkIds cannot be combined with start or limit");
        }
        if (chunkIds.length > 100 || new Set(chunkIds).size !== chunkIds.length) {
          throw new ValidationError("Document chunkIds must contain at most 100 unique IDs");
        }
        const selected = chunkIds.length === 0
          ? []
          : await this.#recursive.readDocumentChunks(reference.documentId, {
              chunkIds,
              limit: Math.max(1, chunkIds.length),
            });
        const byId = new Map(selected.map((chunk) => [chunk.chunkId, chunk]));
        if (chunkIds.some((chunkId) => !byId.has(chunkId))) {
          throw new NotFoundError("document chunk", chunkIds.find((chunkId) => !byId.has(chunkId))!);
        }
        chunks = chunkIds.map((chunkId) => byId.get(chunkId)!);
        limit = chunkIds.length;
        complete = true;
      } else {
        start = reference.start === undefined ? 0 : Number(reference.start);
        limit = reference.limit === undefined ? 20 : Number(reference.limit);
        if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new ValidationError("Document context range is invalid");
        }
        const selected = await this.#recursive.readDocumentChunks(reference.documentId, { start, limit: limit + 1 });
        complete = selected.length <= limit;
        chunks = selected.slice(0, limit);
      }
      const value = chunks.map((chunk) => ({
        chunkId: chunk.chunkId, documentId: chunk.documentId, ordinal: chunk.ordinal,
        content: chunk.content, digest: chunk.digest, size: chunk.size,
      }));
      return {
        value,
        provenance: {
          kind: "document-range", documentId: document.documentId, documentDigest: document.digest,
          start, limit, chunkIds: chunks.map((chunk) => chunk.chunkId),
          resultHash: canonicalJsonDigest(value), complete,
          exactUtf8Bytes: canonicalJsonByteLength(value),
        },
      };
    }
    if (reference.kind === "event") {
      assertReferenceKeys(reference, ["kind", "eventId"], "event");
      if (typeof reference.eventId !== "string") throw new ValidationError("Event context requires eventId");
      const found = await this.storage.getEvent(reference.eventId);
      if (!found) throw new NotFoundError("event", reference.eventId);
      const owner = await this.#recursive.getSession(found.sessionId);
      if (!owner || owner.rootSessionId !== rootSessionId) throw new ValidationError("Event context is outside the caller family");
      const value = jsonClone({
        eventId: found.id, sessionId: found.sessionId, branchId: found.branchId,
        cursor: found.cursor, type: found.type, schemaVersion: found.schemaVersion,
        committedAt: found.committedAt, payload: found.payload,
      });
      return {
        value,
        provenance: {
          kind: "event", eventId: found.id, sessionId: found.sessionId,
          branchId: found.branchId, cursor: found.cursor, schemaVersion: found.schemaVersion,
          resultHash: canonicalJsonDigest(value), complete: true,
          exactUtf8Bytes: canonicalJsonByteLength(value),
        },
      };
    }
    if (reference.kind === "memory") {
      assertReferenceKeys(reference, ["kind", "entryId", "versionId"], "memory");
      if (typeof reference.entryId !== "string") throw new ValidationError("Memory context requires entryId");
      if (!this.memory) throw new ValidationError("Policy-checked memory context resolution is unavailable");
      const result = await this.memory.search(sessionId, branchId, "", {
        linkedEntryIds: [reference.entryId], statuses: ["active"], limit: 500,
      });
      const item = result.items.find((candidate) => candidate.record.entryId === reference.entryId);
      if (!item || reference.versionId !== undefined &&
          (typeof reference.versionId !== "string" || item.record.current.versionId !== reference.versionId)) {
        throw new ValidationError("Memory context is not active and visible in caller policy scope");
      }
      const record = item.record;
      const value = jsonClone({
        entryId: record.entryId, versionId: record.current.versionId, name: record.name,
        scope: record.scope, content: record.current.content, tags: record.current.tags,
        confidence: record.current.confidence, evidenceEventIds: record.current.evidenceEventIds,
      });
      return {
        value,
        provenance: {
          kind: "memory", entryId: record.entryId, versionId: record.current.versionId,
          scope: record.scope, scopeKey: record.scopeKey, createdEventId: record.current.createdEventId,
          resultHash: canonicalJsonDigest(value), complete: true,
          exactUtf8Bytes: canonicalJsonByteLength(value),
        },
      };
    }
    if (reference.kind === "sql-row" || reference.kind === "sql-rows") {
      assertReferenceKeys(
        reference,
        reference.kind === "sql-row"
          ? ["kind", "query", "args", "row"]
          : ["kind", "query", "args", "limit"],
        reference.kind,
      );
      if (typeof reference.query !== "string" || !reference.query.trim()) throw new ValidationError("SQL context requires a read-only query");
      const args = sqlArgs(reference.args);
      const limit = reference.kind === "sql-row"
        ? Math.max(1, Number(reference.row ?? 0) + 1)
        : Number(reference.limit ?? MAX_EXPLICIT_SQL_ROWS);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXPLICIT_SQL_ROWS) {
        throw new ValidationError(`Explicit SQL context limit must be from 1 to ${MAX_EXPLICIT_SQL_ROWS}`);
      }
      const rows = await this.storage.readonlyQuery({
        sql: `SELECT * FROM (${reference.query}) AS explicit_context LIMIT ?`,
        args: [...args, limit + (reference.kind === "sql-rows" ? 1 : 0)],
      });
      if (reference.kind === "sql-row") {
        const row = Number(reference.row ?? 0);
        if (!Number.isSafeInteger(row) || row < 0 || row >= MAX_EXPLICIT_SQL_ROWS || rows[row] === undefined) {
          throw new NotFoundError("SQL row", String(row));
        }
        return {
          value: rows[row]!,
          provenance: {
            kind: "sql-row", query: reference.query, args, row,
            resultHash: canonicalJsonDigest(rows[row]!), complete: true,
            exactUtf8Bytes: canonicalJsonByteLength(rows[row]!),
          },
        };
      }
      const selectedRows = rows.slice(0, limit);
      return {
        value: selectedRows,
        provenance: {
          kind: "sql-rows", query: reference.query, args, limit, rowCount: selectedRows.length,
          resultHash: canonicalJsonDigest(selectedRows), complete: rows.length <= limit,
          exactUtf8Bytes: canonicalJsonByteLength(selectedRows),
        },
      };
    }
    throw new ValidationError("Unsupported explicit context reference");
  }

  async #familyArtifact(rootSessionId: string, artifactId: string): Promise<ArtifactReference | null> {
    for (const branch of await this.storage.listBranches()) {
      const session = await this.#recursive.getSession(branch.sessionId);
      if (!session || session.rootSessionId !== rootSessionId) continue;
      const events = await this.storage.loadEvents(branch.sessionId, { branchId: branch.branchId });
      if (!events.length) continue;
      const artifact = projectEvents(events).artifacts[artifactId];
      if (artifact) return artifact;
    }
    return null;
  }
}

function asStringArray(value: JsonValue, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ValidationError(`${label} must be an array of strings`);
  }
  return value;
}

function assertReferenceKeys(
  reference: Record<string, JsonValue>,
  allowed: readonly string[],
  label: string,
): void {
  const accepted = new Set(allowed);
  const unexpected = Object.keys(reference).filter((key) => !accepted.has(key));
  if (unexpected.length) {
    throw new ValidationError(`Explicit ${label} context has unsupported field ${unexpected[0]}`);
  }
}

function sqlArgs(value: JsonValue | undefined): Array<string | number | null> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError("SQL context args must be an array");
  return value.map((item) => {
    if (item === null || typeof item === "string" || typeof item === "number") return item;
    if (typeof item === "boolean") return item ? 1 : 0;
    throw new ValidationError("SQL context arguments must be JSON scalars");
  });
}

function jsonClone(value: unknown): JsonValue {
  return cloneExactJsonValue(value);
}

export function cloneExactJsonValue(value: unknown): JsonValue {
  const seen = new Set<object>();
  const counter = { value: 0 };
  const visit = (current: unknown, path: string, depth: number): JsonValue => {
    counter.value++;
    if (counter.value > MAX_EXPLICIT_CONTEXT_NODES) {
      throw new ValidationError(`Explicit context exceeds ${MAX_EXPLICIT_CONTEXT_NODES} JSON nodes`);
    }
    if (depth > MAX_EXPLICIT_CONTEXT_DEPTH) {
      throw new ValidationError(`Explicit context exceeds depth ${MAX_EXPLICIT_CONTEXT_DEPTH}`);
    }
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new ValidationError(`Non-finite number at ${path}`);
      return current;
    }
    if (typeof current !== "object") throw new ValidationError(`Value at ${path} is not JSON serializable`);
    if (seen.has(current)) throw new ValidationError(`Circular value at ${path}`);
    seen.add(current);
    try {
      if (Object.getOwnPropertySymbols(current).length) {
        throw new ValidationError(`Symbol-keyed property at ${path} is not a JSON value`);
      }
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          throw new ValidationError(`Non-plain array at ${path}`);
        }
        const names = Object.getOwnPropertyNames(current);
        const expected = Array.from({ length: current.length }, (_, index) => String(index));
        if (names.length !== expected.length + 1 || names.at(-1) !== "length" ||
            expected.some((key, index) => names[index] !== key)) {
          throw new ValidationError(`Sparse or extended array at ${path} is not a JSON value`);
        }
        return expected.map((key, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            throw new ValidationError(`Accessor or hidden array property at ${path}[${index}] is not allowed`);
          }
          return visit(descriptor.value, `${path}[${index}]`, depth + 1);
        });
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new ValidationError(`Non-plain object at ${path}`);
      }
      const result: Record<string, JsonValue> = Object.create(null);
      for (const key of Object.getOwnPropertyNames(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new ValidationError(`Accessor or hidden property at ${path}.${key} is not allowed`);
        }
        Object.defineProperty(result, key, {
          value: visit(descriptor.value, `${path}.${key}`, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    } finally {
      seen.delete(current);
    }
  };
  const normalized = visit(value, "$", 0);
  assertJsonValue(normalized);
  return normalized;
}

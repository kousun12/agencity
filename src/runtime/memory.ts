import {
  newId, NotFoundError, ValidationError, type HarnessRecord, type HarnessScope, type HarnessVersionStatus,
  type MemoryKind, type MemorySearchOptions, type MemorySearchResult,
} from "../domain/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import { rowToHarness } from "./harness.ts";

export interface CreateMemoryInput {
  readonly name?: string;
  readonly text: string;
  readonly memoryKind?: MemoryKind;
  readonly scope?: HarnessScope;
  readonly scopeKey?: string;
  readonly tags?: readonly string[];
  readonly confidence?: number;
  readonly status?: "active" | "candidate";
  readonly evidenceEventIds?: readonly string[];
  readonly conflictEntryIds?: readonly string[];
}
export interface ListMemoryOptions { readonly scopes?: readonly HarnessScope[]; readonly statuses?: readonly HarnessVersionStatus[]; readonly tags?: readonly string[]; }

export interface MemoryCandidateIndex {
  readonly name: string;
  candidates(query: string): Promise<Array<{ versionId: string; entryId: string; rank: number }>>;
  rebuild(): Promise<void>;
}
export class Fts5MemoryCandidateIndex implements MemoryCandidateIndex {
  readonly name = "fts5" as const;
  constructor(readonly storage: AgentStorage) {}
  async candidates(query: string): Promise<Array<{ versionId: string; entryId: string; rank: number }>> {
    const normalized = normalize(query); if (!normalized) return [];
    const expression = normalized.split(" ").map((token) => `"${token.replaceAll('"','""')}"`).join(" OR ");
    const rows = await this.storage.readonlyQuery({ sql: "SELECT version_id,entry_id,bm25(memory_fts) AS rank FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank,version_id LIMIT 500", args: [expression] });
    return rows.map((row: any) => ({ versionId: String(row.version_id), entryId: String(row.entry_id), rank: Number(row.rank) }));
  }
  async rebuild(): Promise<void> { if (!this.storage.rebuildMemoryCandidateIndex) throw new ValidationError("Storage does not expose the disposable memory candidate-index contract"); await this.storage.rebuildMemoryCandidateIndex(); }
}

export class MemoryService {
  readonly index: MemoryCandidateIndex;
  constructor(readonly storage: AgentStorage, index?: MemoryCandidateIndex, readonly userScopeKey = "default-user") { this.index = index ?? new Fts5MemoryCandidateIndex(storage); }

  async create(sessionId: string, branchId: string, input: CreateMemoryInput | string, authority: "user"|"agent" = "user"): Promise<HarnessRecord> {
    const value: CreateMemoryInput = typeof input === "string" ? { text: input } : input;
    if (!value.text?.trim()) throw new ValidationError("Memory text cannot be empty");
    if (value.status === "candidate") throw new ValidationError("Candidate memory requires a validated refinement proposal and bounded allocation");
    if (/\b(ignore|override|disable|weaken|expand|change)\b.{0,40}\b(base policy|permission boundary|safety policy|permissions)\b/i.test(value.text)) throw new ValidationError("Memory cannot modify immutable permission, safety, or base policy");
    const confidence = value.confidence ?? 0.5;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new ValidationError("Memory confidence must be between zero and one");
    const session = await this.#session(sessionId, branchId); const scope = value.scope ?? "local";
    if(authority === "agent") { if(scope !== "local") throw new ValidationError("Agent memory creation is local-only; broader scope requires refinement"); const trajectory=new Set((await this.storage.loadEvents(sessionId,{branchId})).map((event)=>event.id)); if(!(value.evidenceEventIds?.length) || value.evidenceEventIds.some((id)=>!trajectory.has(id))) throw new ValidationError("Agent local memory requires supported evidence from its source trajectory"); }
    if(scope === "user" && value.scopeKey === undefined) throw new ValidationError("User scope requires an explicit authority scopeKey");
    const scopeKey = scope === "local" ? sessionId : scope === "workspace" ? session.workspaceId : scope === "global" ? "global" : this.userScopeKey;
    if (value.scopeKey !== undefined && value.scopeKey !== scopeKey) throw new ValidationError(`scopeKey is runtime-owned for ${scope} scope`);
    const entryId = newId(), versionId = newId(), now = new Date().toISOString();
    await this.storage.appendEvents([{
      sessionId, branchId, type: "HarnessVersionCreated", producer: authority === "agent" ? "console" : "client", idempotencyKey: `memory:${entryId}`,
      payload: { entryId, versionId, version: 1, kind: "memory", scope, scopeKey, name: value.name?.trim() || `memory-${entryId.slice(-8)}`, content: { kind: "memory", memoryKind: value.memoryKind ?? "observation", text: value.text.trim() }, tags: unique(value.tags ?? []), confidence, status: value.status ?? "active", evidenceEventIds: unique(value.evidenceEventIds ?? []), conflictEntryIds: unique(value.conflictEntryIds ?? []), createdBy: authority, lastConfirmedAt: now },
    }]);
    const rows = await this.storage.readonlyQuery({ sql: "SELECT v.*,e.current_version_id,e.active_version_id,e.status AS entry_status,e.created_at AS entry_created_at,e.updated_at AS entry_updated_at FROM harness_entries e JOIN harness_versions v ON v.version_id=e.current_version_id WHERE e.entry_id=?", args: [entryId] });
    return rowToMemory(rows[0] as any);
  }

  async list(sessionId: string, branchId: string, options: ListMemoryOptions = {}): Promise<HarnessRecord[]> {
    return (await this.search(sessionId, branchId, "", { ...(options.scopes === undefined ? {} : { scopes: options.scopes }), ...(options.statuses === undefined ? {} : { statuses: options.statuses }), ...(options.tags === undefined ? {} : { tags: options.tags }), limit: 500 })).items.map((item) => item.record);
  }

  async search(sessionId: string, branchId: string, queryOrInput: string | ({ query: string } & MemorySearchOptions), rawOptions: MemorySearchOptions = {}): Promise<MemorySearchResult> {
    const session = await this.#session(sessionId, branchId);
    const query = typeof queryOrInput === "string" ? queryOrInput : queryOrInput.query;
    const options = typeof queryOrInput === "string" ? rawOptions : queryOrInput;
    const normalizedQuery = normalize(query);
    const scopes = unique(options.scopes ?? ["local","workspace","user","global"]);
    const statuses = unique(options.statuses ?? ["active"]);
    const tags = unique(options.tags ?? []).map((tag) => tag.toLowerCase());
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ValidationError("Memory search limit must be an integer from 1 to 500");
    if (options.since !== undefined && Number.isNaN(Date.parse(options.since))) throw new ValidationError("Memory recency boundary must be an ISO timestamp");

    // Candidate generation is deliberately independent from authoritative
    // scope/status policy. The complete accept/reject path is retained below.
    const indexed = normalizedQuery ? await this.index.candidates(normalizedQuery) : [];
    const sourceByVersion = new Map<string, { entryId: string; rank: number; sources: string[] }>();
    for (const item of indexed) sourceByVersion.set(item.versionId, { entryId: item.entryId, rank: item.rank, sources: ["fts5"] });
    for (const entryId of options.linkedEntryIds ?? []) {
      const rows = await this.storage.readonlyQuery({ sql: "SELECT current_version_id,active_version_id FROM harness_entries WHERE entry_id=?", args: [entryId] });
      if (!rows[0]) continue;
      for (const versionId of unique([String((rows[0] as any).current_version_id), ...((rows[0] as any).active_version_id === null ? [] : [String((rows[0] as any).active_version_id)])])) {
        const previous = sourceByVersion.get(versionId); sourceByVersion.set(versionId, { entryId, rank: previous?.rank ?? Number.MAX_SAFE_INTEGER, sources: unique([...(previous?.sources ?? []), "explicit_link"]) });
      }
    }
    const universe = await this.storage.readonlyQuery({
      sql: `SELECT v.*,e.current_version_id,e.active_version_id,e.status AS entry_status,e.created_at AS entry_created_at,e.updated_at AS entry_updated_at FROM harness_entries e JOIN harness_versions v ON v.entry_id=e.entry_id WHERE e.kind='memory' ${normalizedQuery ? "" : "AND (v.version_id=e.current_version_id OR v.version_id=e.active_version_id)"} ORDER BY v.version_id`,
      args: [],
    });
    if (!normalizedQuery) for (const row of universe as any[]) sourceByVersion.set(String(row.version_id), { entryId: String(row.entry_id), rank: 0, sources: ["recency_scan"] });
    const candidateRows = (universe as any[]).filter((row) => sourceByVersion.has(String(row.version_id)));
    const exposedRows=await this.storage.readonlyQuery({sql:"SELECT a.proposal_id FROM candidate_allocations a JOIN refinement_proposals p ON p.proposal_id=a.proposal_id WHERE a.session_id=? AND a.branch_id=? AND a.exposed_at IS NOT NULL AND p.status='candidate' ",args:[sessionId,branchId]}); const exposedProposals=new Set(exposedRows.map((row:any)=>String(row.proposal_id)));
    const rejections: Array<{ versionId: string; entryId: string; reasons: string[] }> = [];
    let accepted: Array<{ record: HarnessRecord; rank: number; reason: string }> = [];
    const allowedScopeKey = (scope: string, key: string) => scope === "local" ? key === sessionId : scope === "workspace" ? key === session.workspaceId : scope === "user" ? key === this.userScopeKey : true;
    for (const row of candidateRows) {
      const record = rowToMemory(row), reasons: string[] = [];
      if (record.current.status === "candidate" && (!record.current.proposalId || !exposedProposals.has(record.current.proposalId))) reasons.push("candidate_not_exposed");
      if (record.current.versionId !== record.currentVersionId && record.current.versionId !== record.activeVersionId) reasons.push("superseded_version");
      if (!scopes.includes(record.scope) || !allowedScopeKey(record.scope, record.scopeKey)) reasons.push("scope_mismatch");
      if (!statuses.includes(record.current.status)) reasons.push("status_mismatch");
      const currentTags = record.current.tags.map((tag) => tag.toLowerCase());
      if (tags.some((tag) => !currentTags.includes(tag))) reasons.push("tag_mismatch");
      if (options.since && record.current.lastConfirmedAt < options.since) reasons.push("recency_mismatch");
      if (reasons.length) rejections.push({ versionId: record.current.versionId, entryId: record.entryId, reasons });
      else {
        const source = sourceByVersion.get(record.current.versionId)!;
        accepted.push({ record, rank: source.rank, reason: source.sources.includes("explicit_link") ? "explicit link plus authoritative scope/status/tag filters" : normalizedQuery ? "FTS5 match plus authoritative scope/status/tag/recency filters" : "deterministic recency scan plus authoritative scope/status/tag filters" });
      }
    }
    const acceptedById=new Map(accepted.map((item)=>[item.record.entryId,item]));
    const suppressed=new Set<string>();
    const conflicts: MemorySearchResult["provenance"]["conflicts"] = [];
    const conflictPairs = new Set<string>();
    for (const item of accepted) for (const conflictId of item.record.current.conflictEntryIds) {
      const other = acceptedById.get(conflictId);
      if (!other || other.record.entryId === item.record.entryId) continue;
      const ids = [item.record.entryId,other.record.entryId].sort();
      const pairKey = ids.join(" ");
      if (conflictPairs.has(pairKey)) continue;
      conflictPairs.add(pairKey);
      const left = acceptedById.get(ids[0]!)!, right = acceptedById.get(ids[1]!)!;
      const declaredByEntryIds = [left,right].filter((candidate) => candidate.record.current.conflictEntryIds.includes(candidate === left ? right.record.entryId : left.record.entryId)).map((candidate) => candidate.record.entryId).sort();
      const high = authorityRank(left.record) < authorityRank(right.record) ? left : authorityRank(right.record) < authorityRank(left.record) ? right : null;
      const low = high === left ? right : high === right ? left : null;
      const explicitHigherPreference = high !== null && (high.record.scope === "global" || high.record.scope === "user") && high.record.current.content.kind === "memory" && high.record.current.content.memoryKind === "preference" && high.record.current.createdBy === "user";
      const inferredLower = low !== null && (low.record.scope === "workspace" || low.record.scope === "local") && low.record.current.createdBy !== "user";
      if (high && low && explicitHigherPreference && inferredLower) {
        suppressed.add(low.record.entryId);
        const reason = `conflict_suppressed_by_explicit_authority:${high.record.entryId}:declared_by:${declaredByEntryIds.join(",")}`;
        rejections.push({versionId:low.record.current.versionId,entryId:low.record.entryId,reasons:[reason]});
        high.reason += `; explicit authoritative conflict winner over ${low.record.entryId}`;
        conflicts.push({ leftEntryId:left.record.entryId, rightEntryId:right.record.entryId, declaredByEntryIds, winnerEntryId:high.record.entryId, suppressedEntryId:low.record.entryId, reason });
      } else {
        conflicts.push({ leftEntryId:left.record.entryId, rightEntryId:right.record.entryId, declaredByEntryIds, winnerEntryId:null, suppressedEntryId:null, reason:"conflict_recorded_without_authority_suppression" });
      }
    }
    accepted=accepted.filter((item)=>!suppressed.has(item.record.entryId));
    accepted.sort((left,right) => scopeRank(left.record.scope)-scopeRank(right.record.scope) || left.rank-right.rank || right.record.current.lastConfirmedAt.localeCompare(left.record.current.lastConfirmedAt) || left.record.current.versionId.localeCompare(right.record.current.versionId));
    for (const item of accepted.slice(limit)) rejections.push({ versionId: item.record.current.versionId, entryId: item.record.entryId, reasons: ["selection_limit"] });
    const selected = accepted.slice(0, limit);
    const filters = { scopes, statuses, tags, since: options.since ?? null, limit, localSessionId: sessionId, workspaceId: session.workspaceId } as const;
    return {
      items: selected.map((item,index) => ({ record: item.record, reason: item.reason, rank: index + 1 })),
      provenance: {
        query, normalizedQuery, index: this.index.name, filters: filters as any,
        generatedCandidateVersionIds: [...sourceByVersion.keys()].sort(),
        candidates: [...sourceByVersion.entries()].sort(([left],[right]) => left.localeCompare(right)).map(([versionId,source]) => ({ versionId, entryId: source.entryId, sources: source.sources })),
        rejections: rejections.sort((left,right) => left.versionId.localeCompare(right.versionId)),
        conflicts: conflicts.sort((left,right) => left.leftEntryId.localeCompare(right.leftEntryId) || left.rightEntryId.localeCompare(right.rightEntryId)),
        selections: selected.map((item,index) => ({ versionId: item.record.current.versionId, entryId: item.record.entryId, reason: item.reason, rank: index + 1 })),
      },
    };
  }

  async #session(sessionId: string, branchId: string): Promise<{ workspaceId: string }> {
    if (!(await this.storage.loadEvents(sessionId, { branchId })).length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const rows = await this.storage.readonlyQuery({ sql: "SELECT workspace_id FROM sessions WHERE session_id=?", args: [sessionId] });
    if (!rows[0]) throw new NotFoundError("session", sessionId); return { workspaceId: String((rows[0] as any).workspace_id) };
  }
}
function rowToMemory(row: any): HarnessRecord { const record = rowToHarness(row); return { ...record, createdAt: String(row.entry_created_at ?? row.created_at), updatedAt: String(row.entry_updated_at ?? row.updated_at), status: String(row.entry_status ?? row.status) as HarnessVersionStatus }; }
function normalize(query: string): string { return (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).join(" "); }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function scopeRank(scope: HarnessScope): number { return { local: 0, workspace: 1, user: 2, global: 3 }[scope]; }
function authorityRank(record:HarnessRecord):number { return {global:0,user:1,workspace:2,local:3}[record.scope]; }

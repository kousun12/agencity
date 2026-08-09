import { NotFoundError, ValidationError, newId, type HarnessContent, type ModelConfiguration } from "../domain/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import type { AgentService, SubagentHandle } from "./agents.ts";
import { rowToVersion } from "./harness.ts";
export interface SpawnSpecInput { readonly versionId?: string; readonly task?: string; readonly idempotencyKey?: string; readonly model?: ModelConfiguration; }
export interface SpecSubagentHandle extends SubagentHandle { readonly specEntryId: string; readonly specVersionId: string; }
export class SubagentSpecService {
  constructor(readonly storage: AgentStorage, readonly agents: AgentService, readonly userScopeKey = "default-user") {}
  async spawn(parentSessionId: string, parentBranchId: string, entryId: string, input: SpawnSpecInput = {}): Promise<SpecSubagentHandle> {
    const rows = input.versionId
      ? await this.storage.readonlyQuery({ sql: "SELECT * FROM harness_versions WHERE entry_id=? AND version_id=?", args: [entryId,input.versionId] })
      : await this.storage.readonlyQuery({ sql: "SELECT v.* FROM harness_entries e JOIN harness_versions v ON v.version_id=e.active_version_id WHERE e.entry_id=?", args: [entryId] });
    if (!rows[0]) throw new NotFoundError("subagent specification", input.versionId ?? entryId);
    const version = rowToVersion(rows[0] as any);
    if (version.kind !== "subagent_spec" || version.content.kind !== "subagent_spec") throw new ValidationError("Harness entry is not a subagent specification");
    const sessionRows = await this.storage.readonlyQuery({ sql: "SELECT workspace_id FROM sessions WHERE session_id=?", args: [parentSessionId] });
    if (!sessionRows[0]) throw new NotFoundError("session", parentSessionId);
    const workspaceId = String((sessionRows[0] as any).workspace_id);
    const scopeAllowed = version.scope === "local" ? version.scopeKey === parentSessionId : version.scope === "workspace" ? version.scopeKey === workspaceId : version.scope === "user" ? version.scopeKey === this.userScopeKey : version.scopeKey === "global";
    if (!scopeAllowed) throw new ValidationError("Subagent specification belongs to another session or workspace scope");
    if (version.status !== "active") throw new ValidationError(`Subagent specification ${version.versionId} is not active`);
    const spec = version.content as Extract<HarnessContent,{kind:"subagent_spec"}>;
    if(input.model!==undefined && spec.model!==undefined && !Bun.deepEquals(input.model,spec.model)) throw new ValidationError("Invocation cannot override the pinned subagent specification model policy");
    const task = [`Role: ${spec.role}`,spec.prompt,`Invocation criteria: ${spec.invocationCriteria}`,`Expected artifact: ${spec.expectedArtifact}`,input.task ? `Invocation task: ${input.task}` : ""].filter(Boolean).join("\n\n");
    const profile = {
      role: spec.role,
      purpose: `Fulfill the reusable subagent specification "${version.name}".`,
      instructions: [
        spec.prompt,
        `Invocation criteria: ${spec.invocationCriteria}`,
        `Expected artifact: ${spec.expectedArtifact}`,
      ].join("\n\n"),
    };
    const [handle] = await this.agents.spawnManyWithEvents(parentSessionId,parentBranchId,[{ task, profile, ...(spec.completionCriteria === undefined ? {} : { completionCriteria: spec.completionCriteria }), ...((spec.model ?? input.model) ? { model: spec.model ?? input.model } : {}), ...(spec.budget === undefined ? {} : { budget: spec.budget }), idempotencyKey: input.idempotencyKey ?? `spec:${version.versionId}:${newId()}` }],(items) => items.filter((item) => !item.existing).map((item) => ({ sessionId: parentSessionId, branchId: parentBranchId, type: "SubagentSpecInvoked" as const, producer: "supervisor", idempotencyKey: `subagent-spec-invoked:${item.handle.taskId}`, payload: { entryId, versionId: version.versionId, taskId: item.handle.taskId, childSessionId: item.handle.sessionId, childBranchId: item.handle.branchId } })), { profileSources: [{ entryId, versionId: version.versionId }] });
    if (!handle) throw new Error("Subagent specification admission returned no handle");
    return { ...handle, specEntryId: entryId, specVersionId: version.versionId };
  }
}

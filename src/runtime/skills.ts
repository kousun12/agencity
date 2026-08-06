import {
  newId, NotFoundError, ValidationError, type HarnessContent, type HarnessVersionRecord,
  type JsonValue, type SkillInvocationResult, type SkillTestReport,
} from "../domain/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import type { OutboxRunner } from "./outbox.ts";
import { rowToVersion } from "./harness.ts";

export interface InvokeSkillOptions { readonly versionId?: string; readonly idempotencyKey?: string; }
export class SkillService {
  readonly permissionAllowlist: ReadonlySet<string>;
  constructor(readonly storage: AgentStorage, readonly outbox: OutboxRunner, permissionAllowlist: readonly string[] = [], readonly userScopeKey = "default-user") {
    this.permissionAllowlist = new Set(permissionAllowlist.map((permission) => permission.trim()).filter(Boolean));
  }

  assertPermissionsAllowed(permissions: readonly string[]): void {
    for (const permission of permissions) if (!this.permissionAllowlist.has(permission)) {
      throw new ValidationError(`Skill permission is not allowed by runtime configuration: ${permission}`);
    }
  }

  async invoke(sessionId: string, branchId: string, entryId: string, input: JsonValue, options: InvokeSkillOptions = {}): Promise<SkillInvocationResult> {
    const version = await this.#resolve(entryId, options.versionId, false); const content = skillContent(version);
    await this.#assertScopeAuthority(sessionId, branchId, version, false);
    this.assertPermissionsAllowed(content.permissions);
    validateJsonSchema(input, content.inputSchema);
    const key = options.idempotencyKey ?? `skill-invoke:${version.versionId}:${newId()}`;
    const effectId = await this.outbox.request({ sessionId, branchId, executor: "skill", operation: "invoke", input: { entryId, versionId: version.versionId, source: content.source, input }, idempotencyKey: key, idempotent: false });
    await this.storage.appendEvents([{
      sessionId, branchId, type: "SkillInvocationRecorded", producer: "supervisor", idempotencyKey: `skill-invocation:${effectId}`,
      payload: { entryId, versionId: version.versionId, effectId, input },
    }]);
    const execution = await this.outbox.run(effectId);
    return { effectId, entryId, versionId: version.versionId, outcome: execution.outcome, ...(execution.output === undefined ? {} : { output: execution.output }), ...(execution.error === undefined ? {} : { error: execution.error }) };
  }

  async test(sessionId: string, branchId: string, entryId: string, versionId?: string, requireExposedCandidate = false): Promise<SkillTestReport> {
    const version = await this.#resolve(entryId, versionId, true); const content = skillContent(version);
    await this.#assertScopeAuthority(sessionId, branchId, version, requireExposedCandidate);
    this.assertPermissionsAllowed(content.permissions);
    if (!content.tests.length) throw new ValidationError("Generated skills require runtime tests");
    const effectId = await this.outbox.request({ sessionId, branchId, executor: "skill", operation: "test", input: { entryId, versionId: version.versionId, source: content.source, tests: content.tests as unknown as JsonValue }, idempotencyKey: `skill-test:${version.versionId}`, idempotent: false });
    const execution = await this.outbox.run(effectId);
    const report = execution.output && typeof execution.output === "object" && !Array.isArray(execution.output) ? execution.output as Record<string,JsonValue> : {};
    const value: SkillTestReport = { effectId, entryId, versionId: version.versionId, outcome: execution.outcome, compiled: report.compiled === true, passed: typeof report.passed === "number" ? report.passed : 0, failed: typeof report.failed === "number" ? report.failed : content.tests.length, tests: Array.isArray(report.tests) ? report.tests : [], ...(execution.output === undefined ? {} : { output: execution.output }), ...(execution.error === undefined ? {} : { error: execution.error }) };
    await this.storage.appendEvents([{
      sessionId, branchId, type: "SkillTestRecorded", producer: "supervisor", idempotencyKey: `skill-test-recorded:${version.versionId}`,
      payload: { entryId, versionId: version.versionId, effectId, passed: value.outcome === "succeeded" && value.compiled && value.failed === 0, report: { compiled: value.compiled, passed: value.passed, failed: value.failed, tests: value.tests, outcome: value.outcome, ...(value.error === undefined ? {} : { error: value.error }) } },
    }]);
    return value;
  }

  async testModelVisible(sessionId: string, branchId: string, entryId: string, versionId?: string): Promise<SkillTestReport> {
    return this.test(sessionId, branchId, entryId, versionId, true);
  }

  async #assertScopeAuthority(sessionId:string, branchId:string, version:HarnessVersionRecord, requireExposedCandidate:boolean):Promise<void> {
    const rows = await this.storage.readonlyQuery({ sql: "SELECT workspace_id FROM sessions WHERE session_id=?", args: [sessionId] });
    if (!rows[0]) throw new NotFoundError("session", sessionId);
    const workspaceId = String((rows[0] as any).workspace_id);
    const allowed = version.scope === "local" ? version.scopeKey === sessionId
      : version.scope === "workspace" ? version.scopeKey === workspaceId
      : version.scope === "user" ? version.scopeKey === this.userScopeKey
      : version.scopeKey === "global";
    if (!allowed) throw new ValidationError("Skill version belongs to another session or workspace scope");
    if (version.status === "candidate" && requireExposedCandidate) {
      const allocations = await this.storage.readonlyQuery({ sql: "SELECT a.allocation_id FROM candidate_allocations a JOIN refinement_proposals p ON p.proposal_id=a.proposal_id WHERE a.proposal_id=? AND a.session_id=? AND a.branch_id=? AND a.exposed_at IS NOT NULL AND p.status='candidate'", args: [version.proposalId,sessionId,branchId] });
      if (!allocations.length) throw new ValidationError("Candidate skill is not exposed to this exact allocation");
    }
  }

  async #resolve(entryId: string, explicit: string | undefined, allowCandidate: boolean): Promise<HarnessVersionRecord> {
    const rows = explicit
      ? await this.storage.readonlyQuery({ sql: "SELECT v.* FROM harness_versions v WHERE v.entry_id=? AND v.version_id=?", args: [entryId,explicit] })
      : await this.storage.readonlyQuery({ sql: "SELECT v.* FROM harness_entries e JOIN harness_versions v ON v.version_id=e.active_version_id WHERE e.entry_id=?", args: [entryId] });
    if (!rows[0]) throw new NotFoundError("skill version", explicit ?? entryId);
    const version = rowToVersion(rows[0] as any);
    if (version.kind !== "skill") throw new ValidationError("Harness entry is not a TypeScript skill");
    if (version.status !== "active" && !(allowCandidate && version.status === "candidate")) throw new ValidationError(`Skill version ${version.versionId} is ${version.status}, not invocable`);
    return version;
  }
}
function skillContent(version: HarnessVersionRecord): Extract<HarnessContent,{kind:"skill"}> { if (version.content.kind !== "skill") throw new ValidationError("Skill version content is malformed"); return version.content; }
function validateJsonSchema(value: JsonValue, schema?: JsonValue, path = "input"): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const rule=schema as Record<string,JsonValue>;
  if(Array.isArray(rule.enum)&&!rule.enum.some((item)=>Bun.deepEquals(item,value))) throw new ValidationError(`${path} is not an allowed enum value`);
  const expected=rule.type; const actual=value===null?"null":Array.isArray(value)?"array":typeof value;
  if(typeof expected==="string"&&expected!==actual&&!(expected==="integer"&&actual==="number"&&Number.isInteger(value))) throw new ValidationError(`${path} schema expected ${expected}, received ${actual}`);
  if((expected==="object"||rule.properties)&&value&&typeof value==="object"&&!Array.isArray(value)){
    const object=value as Record<string,JsonValue>;const required=Array.isArray(rule.required)?rule.required:[];
    for(const key of required)if(typeof key==="string"&&!(key in object))throw new ValidationError(`${path} schema requires ${key}`);
    const properties=rule.properties&&typeof rule.properties==="object"&&!Array.isArray(rule.properties)?rule.properties as Record<string,JsonValue>:{};
    for(const [key,item] of Object.entries(object)) { if(key in properties)validateJsonSchema(item,properties[key],`${path}.${key}`);else if(rule.additionalProperties===false)throw new ValidationError(`${path} schema does not allow ${key}`); }
  }
  if((expected==="array"||rule.items)&&Array.isArray(value)&&rule.items!==undefined)for(const [index,item] of value.entries())validateJsonSchema(item,rule.items,`${path}[${index}]`);
  if(typeof value==="string"){if(typeof rule.minLength==="number"&&value.length<rule.minLength)throw new ValidationError(`${path} is shorter than minLength`);if(typeof rule.maxLength==="number"&&value.length>rule.maxLength)throw new ValidationError(`${path} exceeds maxLength`);if(typeof rule.pattern==="string"&&!new RegExp(rule.pattern).test(value))throw new ValidationError(`${path} does not match pattern`);}
  if(typeof value==="number"){if(typeof rule.minimum==="number"&&value<rule.minimum)throw new ValidationError(`${path} is below minimum`);if(typeof rule.maximum==="number"&&value>rule.maximum)throw new ValidationError(`${path} exceeds maximum`);}
}

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ValidationError, type JsonValue } from "../domain/index.ts";
import { environmentWithoutSecrets, scrubText } from "../security/index.ts";
import type { EffectExecutor, ExecutionResult } from "./contract.ts";
import { result } from "./contract.ts";

interface SkillInput { entryId: string; versionId: string; source: string; input?: JsonValue; tests?: Array<{ name: string; input: JsonValue; expected?: JsonValue; expectedError?: string }> }
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const RESULT_MARKER = "__AGENCITY_SKILL_RESULT__";

export class SkillExecutor implements EffectExecutor {
  readonly name = "skill";
  async execute(request: Parameters<EffectExecutor["execute"]>[0], context: Parameters<EffectExecutor["execute"]>[1]): Promise<ExecutionResult> {
    if (!["invoke","test"].includes(request.operation)) return result("failed", undefined, `Unsupported skill operation: ${request.operation}`);
    const input = object(request.input) as unknown as SkillInput;
    if (!input.entryId || !input.versionId || typeof input.source !== "string") throw new ValidationError("Skill effect must pin entryId, versionId, and immutable source");
    if (new TextEncoder().encode(input.source).byteLength > MAX_SOURCE_BYTES) throw new ValidationError("Generated skill source is too large");
    if (context.signal.aborted) return result("cancelled", undefined, "Skill execution cancelled");
    const directory = await mkdtemp(join(tmpdir(), `agencity-skill-${input.versionId.slice(-8)}-`));
    try {
      const modulePath = join(directory, "skill.ts"), runnerPath = join(directory, "runner.ts");
      await writeFile(modulePath, input.source, "utf8");
      await writeFile(runnerPath, runnerSource(), "utf8");
      const dependencyRoot=resolve(import.meta.dir,"../../node_modules"); await symlink(dependencyRoot,join(directory,"node_modules"),"dir"); const tsc = Bun.which("tsc") ?? resolve(dependencyRoot,".bin/tsc");
      const typechecked = await spawn([tsc,"--noEmit","--strict","--skipLibCheck","--target","ESNext","--module","ESNext","--moduleResolution","bundler","--allowImportingTsExtensions","--typeRoots",resolve(dependencyRoot,"@types"),"--types","bun",modulePath],directory,context.signal);
      if (typechecked.cancelled) return result("cancelled", { compiled: false, passed: 0, failed: 0, tests: [] }, "Skill compile cancelled");
      if (typechecked.exitCode !== 0) return result("failed", { compiled: false, passed: 0, failed: 0, tests: [], compile: typechecked as unknown as JsonValue }, "Generated skill failed TypeScript compilation");
      const compiled = await spawn([process.execPath, "build", modulePath, "--target=bun", "--outdir", join(directory,"build")], directory, context.signal);
      if (compiled.cancelled) return result("cancelled", { compiled: false, passed: 0, failed: 0, tests: [] }, "Skill compile cancelled");
      if (compiled.exitCode !== 0) return result("failed", { compiled: false, passed: 0, failed: 0, tests: [], compile: compiled as unknown as JsonValue }, "Generated skill failed to compile");
      if (request.operation === "invoke") {
        const invocation = await runCase(runnerPath, input.input ?? null, directory, context.signal);
        if (!invocation.ok) return result(invocation.cancelled ? "cancelled" : "failed", { compiled: true, logs: invocation.logs } as JsonValue, invocation.error);
        return result("succeeded", { compiled: true, versionId: input.versionId, value: invocation.value ?? null, logs: invocation.logs } as JsonValue);
      }
      const reports: JsonValue[] = []; let passed = 0, failed = 0;
      for (const test of input.tests ?? []) {
        if (context.signal.aborted) return result("cancelled", { compiled: true, passed, failed, tests: reports }, "Skill tests cancelled");
        const invocation = await runCase(runnerPath, test.input, directory, context.signal);
        let success: boolean;
        if (test.expectedError !== undefined) success = !invocation.ok && (invocation.error ?? "").includes(test.expectedError);
        else success = invocation.ok && Object.prototype.hasOwnProperty.call(test,"expected") && Bun.deepEquals(invocation.value, test.expected);
        if (success) passed++; else failed++;
        reports.push({ name: test.name, passed: success, ...(invocation.ok ? { output: invocation.value ?? null } : { error: invocation.error ?? "Unknown skill failure" }), logs: invocation.logs } as JsonValue);
      }
      const report = { compiled: true, passed, failed, tests: reports } as JsonValue;
      return failed === 0 && (input.tests?.length ?? 0) > 0 ? result("succeeded", report) : result("failed", report, input.tests?.length ? `${failed} skill test(s) failed` : "Generated skill has no runtime tests");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
function object(value: JsonValue): Record<string,JsonValue> { if (!value || Array.isArray(value) || typeof value !== "object") throw new ValidationError("Skill effect input must be an object"); return value; }
function runnerSource(): string { return `import * as skill from "./skill.ts";\nconst fn = typeof skill.default === "function" ? skill.default : skill.run;\nif (typeof fn !== "function") throw new Error("Skill must export default function or named run function");\nconst input = JSON.parse(process.argv[2] ?? "null");\ntry { const value = (await fn(input)) ?? null; console.log("${RESULT_MARKER}" + JSON.stringify({ok:true,value})); } catch (error) { console.log("${RESULT_MARKER}" + JSON.stringify({ok:false,error:error instanceof Error ? error.message : String(error)})); process.exitCode=1; }\n`; }
async function runCase(runnerPath: string, input: JsonValue, cwd: string, signal: AbortSignal): Promise<{ok:boolean;value?:JsonValue;error?:string;logs:string[];cancelled:boolean}> {
  const executed = await spawn([process.execPath,"run",runnerPath,JSON.stringify(input)],cwd,signal);
  const lines = executed.stdout.split(/\r?\n/); const marker = [...lines].reverse().find((line) => line.startsWith(RESULT_MARKER));
  const logs = lines.filter((line) => line && !line.startsWith(RESULT_MARKER)).concat(executed.stderr ? [executed.stderr] : []);
  if (executed.cancelled) return { ok:false,error:"Skill execution cancelled",logs,cancelled:true };
  if (!marker) return { ok:false,error:`Skill runtime exited ${executed.exitCode} without a result`,logs,cancelled:false };
  try { const parsed = JSON.parse(marker.slice(RESULT_MARKER.length)) as {ok:boolean;value?:JsonValue;error?:string}; return {...parsed,logs,cancelled:false}; }
  catch { return {ok:false,error:"Skill returned malformed JSON",logs,cancelled:false}; }
}
async function spawn(command: string[], cwd: string, signal: AbortSignal): Promise<{exitCode:number;stdout:string;stderr:string;cancelled:boolean}> {
  // AbortSignal does not replay an already-fired abort event to a listener added
  // later. Check before every compiler/runtime subprocess so cancellation in the
  // narrow handoff between phases cannot accidentally launch the next phase.
  if(signal.aborted)return{exitCode:143,stdout:"",stderr:"",cancelled:true};
  const child = Bun.spawn(command,{cwd,stdout:"pipe",stderr:"pipe",env:environmentWithoutSecrets()});
  let cancelled=false,timedOut=false; const abort=()=>{cancelled=true;child.kill();}; signal.addEventListener("abort",abort,{once:true}); const timer=setTimeout(()=>{timedOut=true;child.kill();},30_000);
  try { const [exitCode,out,err]=await Promise.all([child.exited,new Response(child.stdout).arrayBuffer(),new Response(child.stderr).arrayBuffer()]); const decode=(value:ArrayBuffer)=>scrubText(new TextDecoder().decode(value.slice(0,MAX_OUTPUT_BYTES))); return {exitCode,stdout:decode(out),stderr:timedOut ? `${decode(err)}\nTimed out` : decode(err),cancelled}; }
  finally { clearTimeout(timer); signal.removeEventListener("abort",abort); }
}

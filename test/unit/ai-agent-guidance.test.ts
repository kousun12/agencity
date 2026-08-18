import { describe, expect, test } from "bun:test";
import { AGENT_RUN_EXECUTION_GUIDANCE } from "../../src/index.ts";

describe("explicit AI and typed agent guidance", () => {
  const guidance = AGENT_RUN_EXECUTION_GUIDANCE.text;

  test("keeps the deterministic, raw, awaited, and detached choices distinct", () => {
    expect(AGENT_RUN_EXECUTION_GUIDANCE.version).toBe(11);
    expect(guidance).toContain("Use ordinary TypeScript for deterministic work");
    expect(guidance).toContain("Use ai.generateText only when every required fact is already in the explicit prompt/context");
    expect(guidance).toContain("Use ai.generateObject under the same explicit-context constraint");
    expect(guidance).toContain("Use sdk.agents.run when a strictly narrower child task must inspect the workspace");
    expect(guidance).toContain("Do not hand off your entire assigned task");
    expect(guidance).toContain("sdk.agents.list() is an on-demand nuclear-family snapshot");
    expect(guidance).toContain("do not poll it on every step");
    expect(guidance).toContain("Use sdk.agents.spawn when a child should work independently");
    expect(guidance).toContain("handle.result(options)");
    expect(guidance).toContain("sdk.agents.result(handle, options)");
    expect(guidance).toContain("worker-local convenience");
    expect(guidance).toContain("send defaults to mode queue");
    expect(guidance).toContain("use mode steer only");
  });

  test("states raw-generation, schema, fan-out, model, authority, and durability limits", () => {
    expect(guidance).toContain("Raw ai calls cannot inspect files, run commands, use skills, call tools");
    expect(guidance).toContain("Keep object schemas small and decision-oriented");
    expect(guidance).toContain("Use runMany or spawnMany only for bounded independent tasks");
    expect(guidance).toContain("same canonical creator/model IDs");
    expect(guidance).toContain("not objective evidence, factual proof, completion proof, or expanded runtime authority");
    expect(guidance).toContain("A long parent-cell loop is not a durable coordinator across worker loss");
    expect(guidance).toContain("durable versioned RPC is available only when a separately advertised capability implements it");
  });

  test("states exact artifact and bounded shell-result contracts", () => {
    expect(guidance).toContain("tools.shell(command, options?) returns agencity.bounded-output.v1");
    expect(guidance).toContain("inline has result.value with { exitCode, stdout, stderr }");
    expect(guidance).toContain("only spilled has result.artifact");
    expect(guidance).toContain("never copy protocol/completeness onto a partial wrapper");
    expect(guidance).toContain("artifacts.put(content: string, mediaType?: string)");
    expect(guidance).toContain("end <= the artifact's known immutable size");
    expect(guidance).toContain("end - start <= 64 KiB");
  });

  test("retains representative text, object, awaited-agent, and detached-agent examples", () => {
    expect(guidance).toContain("const summary = await ai.generateText");
    expect(guidance).toContain("const verdict = await ai.generateObject");
    expect(guidance).toContain("schema: z.object({ complete: z.boolean(), missing: z.array(z.string()) })");
    expect(guidance).toContain("const review = await sdk.agents.run");
    expect(guidance).toContain("remainingWork: z.array(z.string())");
    expect(guidance).toContain("const audit = await sdk.agents.spawn");
    expect(guidance).toContain("return { auditTaskId: audit.taskId }");
  });
});

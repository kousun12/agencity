import { mkdir } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AGENT_ACTION_PROTOCOL,
  AGENT_ACTION_VERSION,
  ScriptedAgentActionProvider,
  Supervisor,
  projectEvents,
  type AgentAction,
  type JsonValue,
  type ModelConfiguration,
  type ModelProvider,
  type TextModelResponse,
} from "../../src/index.ts";
import {
  makeTempRuntime,
  removeTempRuntime,
  type TempRuntime,
} from "../helpers.ts";

const typedAction = <T extends Omit<AgentAction, "protocol" | "version">>(value: T): AgentAction => ({
  protocol: AGENT_ACTION_PROTOCOL,
  version: AGENT_ACTION_VERSION,
  ...value,
} as unknown as AgentAction);

class CodingProvider extends ScriptedAgentActionProvider {
  readonly contexts: JsonValue[] = [];
  calls = 0;
  constructor(script: readonly AgentAction[]) { super(script, "coding-planner"); }
  override async complete(
    context: JsonValue,
    configuration: ModelConfiguration,
    signal: AbortSignal,
  ): Promise<TextModelResponse> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    expect(configuration.model).toBe("deterministic-plan-v1");
    expect(JSON.stringify(context)).toContain("slugify");
    this.contexts.push(context);
    this.calls++;
    const ordinal = context && typeof context === "object" && !Array.isArray(context) &&
      context.run && typeof context.run === "object" && !Array.isArray(context.run) &&
      typeof context.run.stepOrdinal === "number" ? context.run.stepOrdinal : 1;
    const selected = (this.script as readonly AgentAction[])[ordinal - 1];
    if (!selected) throw new Error("coding fixture exhausted");
    const text = JSON.stringify(selected);
    return {
      text,
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: Math.ceil(text.length / 4), costUsd: 0 },
    };
  }
}

const STUB = `export function slugify(_input: string): string {
  return "";
}
`;
const IMPLEMENTATION = `export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
`;
const SPEC = `import { expect, test } from "bun:test";
import { slugify } from "../src/slug.ts";

test("slugifies representative titles", () => {
  expect(slugify("  Durable Agent: Hello, World!  ")).toBe("durable-agent-hello-world");
  expect(slugify("already---spaced")).toBe("already-spaced");
  expect(slugify("***")).toBe("");
});
`;

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

function observations(context: JsonValue): Array<{ eventId: string; type: string }> {
  if (!context || typeof context !== "object" || Array.isArray(context) ||
      !context.run || typeof context.run !== "object" || Array.isArray(context.run) ||
      !Array.isArray(context.run.observations)) return [];
  return context.run.observations as Array<{ eventId: string; type: string }>;
}

describe("representative autonomous coding task", () => {
  test("inspects, reproduces, fixes, verifies, and reports through typed actions with a fresh worker per cell", async () => {
    const temp = await makeTempRuntime("agencity-coding-task-");
    temps.push(temp);
    await mkdir(`${temp.workspaceRoot}/src`, { recursive: true });
    await mkdir(`${temp.workspaceRoot}/test`, { recursive: true });
    await Bun.write(`${temp.workspaceRoot}/src/slug.ts`, STUB);
    await Bun.write(`${temp.workspaceRoot}/test/slug.test.ts`, SPEC);

    const provider = new CodingProvider([
      typedAction({ type: "typescript", code: `
        const source = await tools.readFile("src/slug.ts");
        const baseline = await tools.request(
          "shell",
          "run",
          { command: "bun test ./test/slug.test.ts" },
          { idempotencyKey: "coding-task:baseline-test", idempotent: true },
        );
        if (baseline.outcome !== "failed") throw new Error("expected the baseline test to fail");
        await state.set("baselineEvidence", {
          outcome: baseline.outcome,
          error: baseline.error ?? null,
          output: baseline.output ?? null,
          sourceSha256: source.value.sha256,
        });
        (globalThis as any).__codingHeap = "not durable";
        return { pid: process.pid, baseline, sourceSha256: source.value.sha256 };
      ` }),
      typedAction({ type: "typescript", code: `
        const current = await tools.readFile("src/slug.ts");
        const write = await tools.writeFile("src/slug.ts", ${JSON.stringify(IMPLEMENTATION)}, current.value.sha256);
        await state.set("codingTask", {
          requirement: "implement slugify",
          gate: "bun test ./test/slug.test.ts",
          phase: "implemented",
          sourceSha256: write.sha256,
        });
        return { pid: process.pid, heap: (globalThis as any).__codingHeap ?? null, write };
      ` }),
      typedAction({ type: "typescript", code: `
        const gate = await tools.shell("bun test ./test/slug.test.ts");
        if (gate.completeness !== "inline") throw new Error(gate.guidance);
        await state.set("completion", {
          status: "complete",
          gate: "bun test ./test/slug.test.ts",
          exitCode: gate.value.exitCode,
          stdout: gate.value.stdout,
          stderr: gate.value.stderr,
        });
        return { pid: process.pid, gate };
      ` }),
      typedAction({ type: "final", content: "Implemented slugify and verified all representative tests pass." }),
    ]);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      restartConsoleAfterCell: true,
      modelProviders: [provider],
      recover: false,
    });
    const { sessionId, branchId } = await supervisor.createSession({
      workspaceId: "coding-workspace",
      model: { provider: provider.name, model: "deterministic-plan-v1", temperature: 0 },
      budget: { tokenLimit: 10_000, turnLimit: 8 },
    });

    const result = await supervisor.runs.start(sessionId, branchId, {
      task: "Implement slugify in src/slug.ts and make test/slug.test.ts pass. Preserve durable evidence.",
      requestKey: "coding-task-run",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      steps: 4,
      final: "Implemented slugify and verified all representative tests pass.",
    });
    expect(provider.calls).toBe(4);
    expect(await Bun.file(`${temp.workspaceRoot}/src/slug.ts`).text()).toBe(IMPLEMENTATION);

    const beforeRestart = projectEvents(await supervisor.storage.loadEvents(sessionId, { branchId }));
    expect(beforeRestart.workingValues.baselineEvidence?.value.kind).toBe("json");
    expect(beforeRestart.workingValues.codingTask).toMatchObject({
      version: 1,
      value: { kind: "json", value: { phase: "implemented" } },
    });
    expect(beforeRestart.workingValues.completion).toMatchObject({
      value: { kind: "json", value: { status: "complete", exitCode: 0 } },
    });
    const cells = Object.values(beforeRestart.cells);
    expect(cells).toHaveLength(3);
    expect(cells.every(cell => cell.status === "committed")).toBe(true);
    const workerPids = cells.map(cell => (cell.result as { pid: number }).pid);
    expect((cells[1]!.result as { heap: unknown }).heap).toBeNull();
    expect(new Set(workerPids).size).toBe(workerPids.length);
    expect(workerPids.every(pid => pid !== process.pid)).toBe(true);
    expect(beforeRestart.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(beforeRestart.messages.at(-1)?.content).toBe(result.final);

    const observed = provider.contexts.flatMap(observations);
    const committedCells = observed.filter(item => item.type === "CellCommitted");
    expect(committedCells).toHaveLength(3);
    expect(new Set(committedCells.map(item => item.eventId)).size).toBe(3);
    for (const cell of cells) {
      const dependentContexts = provider.contexts.filter(context => observations(context).some(item => item.eventId === cell.eventId));
      expect(dependentContexts).toHaveLength(1);
    }
    expect(await supervisor.projections.rebuild(sessionId, branchId)).toEqual(beforeRestart);
    await supervisor.close();

    const restarted = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      restartConsoleAfterCell: true,
      modelProviders: [provider],
      recover: true,
    });
    try {
      expect(await restarted.projections.rebuild(sessionId, branchId)).toEqual(beforeRestart);
      expect(await restarted.runs.get(sessionId, branchId, result.runId)).toEqual(result);
      expect(provider.calls).toBe(4);
      expect(await Bun.file(`${temp.workspaceRoot}/src/slug.ts`).text()).toBe(IMPLEMENTATION);
    } finally { await restarted.close(); }
  }, 20_000);
});

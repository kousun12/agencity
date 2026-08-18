import { afterEach, describe, expect, test } from "bun:test";
import {
  AGENT_ACTION_PROTOCOL,
  AGENT_ACTION_VERSION,
  ConsoleExecutionPool,
  Supervisor,
  type AgentAction,
  type JsonValue,
  type ModelConfiguration,
  type ModelDispatch,
  type ModelEffectOutputV2,
  type ModelProvider,
  type TextModelResponse,
} from "../../src/index.ts";
import { formalOutputFromAgentAction } from "../../src/executors/model-response.ts";
import {
  makeTempRuntime,
  removeTempRuntime,
  type TempRuntime,
} from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

const action = <T extends Omit<AgentAction, "protocol" | "version">>(
  value: T,
): AgentAction => ({
  protocol: AGENT_ACTION_PROTOCOL,
  version: AGENT_ACTION_VERSION,
  ...value,
} as unknown as AgentAction);

class NestedAgentProvider implements ModelProvider {
  readonly name = "nested-console-actions";
  readonly capabilities = {
    streaming: false,
    requiredToolSet: {
      status: "provider-strict",
      requiredChoice: "provider-enforced",
      parallelCalls: "provider-disabled",
      streaming: true,
      adapter: "agencity.nested-console.fixture.v1",
    },
  } as const;
  readonly #ordinals = new Map<string, number>();

  async complete(): Promise<TextModelResponse> {
    throw new Error("Nested console fixture requires formal streaming");
  }

  async streamResponse(
    context: JsonValue,
    dispatch: ModelDispatch,
    signal: AbortSignal,
  ): Promise<ModelEffectOutputV2> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const route = this.#route(JSON.stringify(context));
    const ordinal = (this.#ordinals.get(route) ?? 0) + 1;
    this.#ordinals.set(route, ordinal);
    const selected = this.#action(route, ordinal);
    return formalOutputFromAgentAction({
      action: selected,
      dispatch,
      providerToolCallId: `${route}-${ordinal}`,
      provider: this.name,
      adapter: this.capabilities.requiredToolSet.adapter,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    });
  }

  #route(encoded: string): string {
    for (const route of [
      "nested-parent-child",
      "nested-grandchild",
      "nested-multi-child",
      "fan-left",
      "fan-right",
      "detached-queued-child",
      "cancellable-pool-child",
      "retry-running-child",
    ]) {
      if (encoded.includes(route)) return route;
    }
    return "unknown";
  }

  #action(route: string, ordinal: number): AgentAction {
    if (route === "nested-multi-child") {
      if (ordinal === 1) {
        return action({
          type: "typescript",
          code: `const steps = ["first"]; console.log("child-first"); return { step: 1, pid: process.pid };`,
        });
      }
      if (ordinal === 2) {
        return action({
          type: "typescript",
          code: `steps.push("second"); console.log("child-second"); return { steps, pid: process.pid };`,
        });
      }
      return action({ type: "final", content: "multi-cell child complete" });
    }
    if (route === "nested-parent-child") {
      if (ordinal === 1) {
        return action({
          type: "typescript",
          code: `return sdk.agents.run({ task: "nested-grandchild", idempotencyKey: "nested-grandchild" });`,
        });
      }
      return action({ type: "final", content: "grandchild was awaited" });
    }
    if (route === "nested-grandchild") {
      if (ordinal === 1) {
        return action({
          type: "typescript",
          code: `const level = "grandchild"; console.log("grandchild-only"); return { level, pid: process.pid };`,
        });
      }
      return action({ type: "final", content: "grandchild complete" });
    }
    if (route === "fan-left" || route === "fan-right") {
      const identity = route === "fan-left" ? "left" : "right";
      if (ordinal === 1) {
        return action({
          type: "typescript",
          code: `const identity = "${identity}"; console.log("${identity}-only"); const startedAt = Date.now(); await Bun.sleep(200); return { identity, pid: process.pid, startedAt, endedAt: Date.now() };`,
        });
      }
      if (ordinal === 2) {
        return action({
          type: "typescript",
          code: `return { identity, pid: process.pid };`,
        });
      }
      return action({ type: "final", content: `${identity} complete` });
    }
    if (route === "detached-queued-child") {
      if (ordinal === 1) {
        return action({
          type: "typescript",
          code: `return { detached: true, pid: process.pid };`,
        });
      }
      return action({ type: "final", content: "detached complete" });
    }
    if (route === "cancellable-pool-child") {
      return action({
        type: "typescript",
        code: `console.log("cancellable-started"); await Bun.sleep(10_000); return { unexpected: true };`,
      });
    }
    if (route === "retry-running-child") {
      if (ordinal === 1) {
        return action({
          type: "typescript",
          code: `await Bun.sleep(500); return { retry: true, pid: process.pid };`,
        });
      }
      return action({ type: "final", content: "retry child complete" });
    }
    return action({ type: "failed", error: `Unknown fixture route: ${route}` });
  }
}

class ReplEpochRaceProvider implements ModelProvider {
  readonly name = "repl-epoch-race";
  readonly capabilities = {
    streaming: false,
    requiredToolSet: {
      status: "provider-strict",
      requiredChoice: "provider-enforced",
      parallelCalls: "provider-disabled",
      streaming: true,
      adapter: "agencity.repl-epoch-race.fixture.v1",
    },
  } as const;
  beforeFirstAction: (() => Promise<void>) | null = null;
  #ordinal = 0;

  async complete(): Promise<TextModelResponse> {
    throw new Error("REPL epoch fixture requires formal streaming");
  }

  async streamResponse(
    _context: JsonValue,
    dispatch: ModelDispatch,
    signal: AbortSignal,
  ): Promise<ModelEffectOutputV2> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.#ordinal++;
    if (this.#ordinal === 1) await this.beforeFirstAction?.();
    const selected = this.#ordinal === 1
      ? action({
          type: "typescript",
          code: `globalThis.__staleEpochActionExecuted = true; return "stale";`,
        })
      : this.#ordinal === 2
      ? action({
          type: "typescript",
          code: `const rebuiltAfterEpochChange = 42; return rebuiltAfterEpochChange;`,
        })
      : action({ type: "final", content: "epoch recovery complete" });
    return formalOutputFromAgentAction({
      action: selected,
      dispatch,
      providerToolCallId: `repl-epoch-${this.#ordinal}`,
      provider: this.name,
      adapter: this.capabilities.requiredToolSet.adapter,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    });
  }
}

async function fixture(
  options: {
    readonly maxResident?: number;
    readonly maxActive?: number;
    readonly maxAwaitedDepth?: number;
  } = {},
) {
  const temp = await makeTempRuntime("agencity-console-pool-");
  temps.push(temp);
  const provider = new NestedAgentProvider();
  const supervisor = await Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    modelProviders: [provider],
    recover: false,
    maxConsoleResidentProcesses: options.maxResident ?? 4,
    maxConsoleActiveExecutions: options.maxActive ?? 2,
    maxAwaitedAgentDepth: options.maxAwaitedDepth ?? 4,
  });
  const root = await supervisor.createSession({
    workspaceId: "console-pool",
    model: { provider: provider.name, model: "fixture-v1" },
  });
  return { supervisor, root };
}

describe("branch-aware console execution pool", () => {
  test("names each warm namespace and reports cold without spawning", async () => {
    const pool = new ConsoleExecutionPool({
      maxResidentProcesses: 1,
      maxActiveExecutions: 1,
    });
    const scope = { sessionId: "epoch-status", branchId: "branch" };
    try {
      expect(pool.replNamespaceStatus(scope)).toMatchObject({
        state: "cold",
        epochId: null,
        epochName: null,
      });
      let firstEpochId = "";
      await pool.run(scope, async (process, acquisition) => {
        expect(acquisition.epochChanged).toBe(false);
        const status = process.status().replNamespace;
        expect(status.state).toBe("warm");
        if (status.state === "warm") {
          firstEpochId = status.epochId;
          expect(status.epochName).toMatch(
            /^[a-z]+-[a-z]+-[0-9a-f]{6}$/,
          );
        }
      });
      expect(pool.replNamespaceStatus(scope).state).toBe("warm");
      await pool.recycleScope(scope, "test-epoch-replacement");
      expect(pool.replNamespaceStatus(scope).state).toBe("cold");
      await pool.run(scope, async (process) => {
        const status = process.status().replNamespace;
        expect(status.state).toBe("warm");
        if (status.state === "warm") {
          expect(status.epochId).not.toBe(firstEpochId);
        }
      });
    } finally {
      await pool.stop();
    }
  });

  test("rejects a model cell when its pinned REPL epoch changed", async () => {
    const temp = await makeTempRuntime("agencity-repl-epoch-race-");
    temps.push(temp);
    const provider = new ReplEpochRaceProvider();
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    const root = await supervisor.createSession({
      workspaceId: "repl-epoch-race",
      model: { provider: provider.name, model: "fixture-v1" },
    });
    provider.beforeFirstAction = async () => {
      await supervisor.executeCell(
        root.sessionId,
        root.branchId,
        `const interleavedBinding = "warm"; return interleavedBinding;`,
      );
    };
    try {
      const result = await supervisor.runs.start(
        root.sessionId,
        root.branchId,
        "recover after the exact branch namespace changes",
      );
      expect(result).toMatchObject({
        status: "succeeded",
        final: "epoch recovery complete",
      });
      const events = await supervisor.storage.loadEvents(root.sessionId, {
        branchId: root.branchId,
      });
      const attempts = events.filter((event) =>
        event.type === "AgentRunModelAttemptStarted"
      ).map((event) =>
        (event.payload as {
          replNamespace?: { state: string; epochId: string | null };
        }).replNamespace
      );
      expect(attempts.map((status) => status?.state)).toEqual([
        "cold",
        "warm",
        "warm",
      ]);
      const changed = events.find((event) =>
        event.type === "CellFailed" &&
        (event.payload as { failure?: { code?: string } }).failure?.code ===
          "REPL_EPOCH_CHANGED"
      );
      expect(changed?.payload).toMatchObject({
        failure: {
          code: "REPL_EPOCH_CHANGED",
          expected: { state: "cold", epochId: null },
          current: { state: "warm" },
        },
      });
      const changedCellId = (changed?.payload as { cellId?: string } | undefined)
        ?.cellId;
      expect(events.find((event) =>
        event.type === "CellProposed" &&
        (event.payload as { cellId: string }).cellId === changedCellId
      )?.payload).toMatchObject({
        code: expect.stringContaining("__staleEpochActionExecuted"),
      });
      expect(events.some((event) =>
        event.type === "CellCommitted" &&
        (event.payload as { cellId: string }).cellId === changedCellId
      )).toBe(false);
    } finally {
      await supervisor.close();
    }
  });

  test("does not restart a guarded worker after loss at execution", async () => {
    const pool = new ConsoleExecutionPool({
      maxResidentProcesses: 1,
      maxActiveExecutions: 1,
    });
    const scope = { sessionId: "epoch-send-race", branchId: "branch" };
    try {
      await pool.run(scope, async (process, acquisition) => {
        const expected = acquisition.replNamespaceForExecution;
        expect(expected.state).toBe("warm");
        await process.recycle("test-loss-before-send");
        await expect(pool.execute(
          process,
          `globalThis.__guardedRestartExecuted = true;`,
          { id: scope.sessionId, branchId: scope.branchId },
          {},
          async () => null,
          globalThis.process.cwd(),
          {
            modelExpected: expected,
            executionExpected: expected,
          },
        )).rejects.toMatchObject({
          code: "REPL_EPOCH_CHANGED",
          details: {
            expected,
            current: { state: "cold", epochId: null },
          },
        });
        expect(process.status().running).toBe(false);
      });
    } finally {
      await pool.stop();
    }
  });

  test("fails a retained action without an epoch pin before execution", async () => {
    const temp = await makeTempRuntime("agencity-unpinned-epoch-");
    temps.push(temp);
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    const root = await supervisor.createSession({
      workspaceId: "unpinned-epoch",
    });
    try {
      await expect(supervisor.executeCell(
        root.sessionId,
        root.branchId,
        `globalThis.__unpinnedActionExecuted = true;`,
        [],
        "legacy-unpinned-cell",
        null,
      )).rejects.toMatchObject({
        code: "REPL_EPOCH_CHANGED",
        details: {
          expected: null,
          current: { state: "cold" },
        },
      });
      const events = await supervisor.storage.loadEvents(root.sessionId, {
        branchId: root.branchId,
      });
      expect(events.find((event) =>
        event.type === "CellFailed" &&
        (event.payload as { cellId: string }).cellId ===
          "legacy-unpinned-cell"
      )?.payload).toMatchObject({
        failure: {
          code: "REPL_EPOCH_CHANGED",
          expected: null,
          current: { state: "cold" },
        },
      });
      expect(events.some((event) =>
        event.type === "CellCommitted" &&
        (event.payload as { cellId: string }).cellId ===
          "legacy-unpinned-cell"
      )).toBe(false);
    } finally {
      await supervisor.close();
    }
  });

  test("parallel RPC completions share one active-permit reacquisition", async () => {
    const value = await fixture({ maxResident: 1, maxActive: 1 });
    try {
      const result = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `const [values, cellRows] = await Promise.all([
          state.list(),
          sdk.cells.list(),
        ]);
        return {
          valuesReturned: Array.isArray(values),
          cellsReturned: typeof cellRows === "object" && cellRows !== null,
        };`,
      );
      expect(result.result).toEqual({
        valuesReturned: true,
        cellsReturned: true,
      });
      expect(value.supervisor.console.capacityStatus().activeExecutions).toBe(0);
    } finally {
      await value.supervisor.close();
    }
  });

  test("a fast parallel RPC cannot retain the permit needed by a slower child RPC", async () => {
    const pool = new ConsoleExecutionPool({
      maxResidentProcesses: 2,
      maxActiveExecutions: 1,
    });
    try {
      const execution = pool.run(
        { sessionId: "parallel-parent", branchId: "branch" },
        (parentProcess) => pool.execute(
          parentProcess,
          `const [values, child] = await Promise.all([
            state.list(),
            sdk.cells.list(),
          ]);
          ({ valueCount: values.length, child });`,
          { id: "parallel-parent", branchId: "branch" },
          {},
          async (method) => {
            if (method === "state.list") return [];
            if (method === "cells.list") {
              await Bun.sleep(50);
              const child = await pool.run(
                { sessionId: "parallel-child", branchId: "branch" },
                (childProcess) => pool.execute(
                  childProcess,
                  `({ completed: true })`,
                  { id: "parallel-child", branchId: "branch" },
                  {},
                  async () => null,
                ),
              );
              return {
                completed: child.observation.kind === "json",
              };
            }
            throw new Error(`Unexpected RPC method: ${method}`);
          },
        ),
      );
      const result = await Promise.race([
        execution,
        Bun.sleep(2_000).then(() => {
          throw new Error("Parallel child RPC deadlocked");
        }),
      ]);
      expect(result.observation.kind).toBe("json");
      if (result.observation.kind === "json") {
        expect(JSON.parse(result.observation.json)).toEqual({
          valueCount: 0,
          child: { completed: true },
        });
      }
    } finally {
      await pool.stop();
    }
  });

  test("running-child retries reuse full resident capacity", async () => {
    const value = await fixture({ maxResident: 2, maxActive: 2 });
    try {
      const spawned = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.spawn({
          task: "retry-running-child",
          idempotencyKey: "retry-running-child",
        });`,
      );
      const handle = spawned.result as { taskId: string };
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (value.supervisor.console.capacityStatus().activeExecutions === 1) {
          break;
        }
        await Bun.sleep(10);
      }
      expect(value.supervisor.console.capacityStatus()).toMatchObject({
        residentProcesses: 2,
        activeExecutions: 1,
      });
      const retried = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return Promise.all([
          sdk.agents.result("${handle.taskId}", { wait: true }),
          sdk.agents.run({
            task: "retry-running-child",
            idempotencyKey: "retry-running-child",
          }),
        ]);`,
      );
      expect((retried.result as any[]).map((item) => item.status)).toEqual([
        "succeeded",
        "succeeded",
      ]);
      expect(await value.supervisor.agents.listTasks(
        value.root.sessionId,
        value.root.branchId,
      )).toHaveLength(1);
      expect(value.supervisor.console.capacityStatus()).toMatchObject({
        activeExecutions: 0,
        reservedProcesses: 0,
      });
    } finally {
      await value.supervisor.close();
    }
  });

  test("shutdown and late reservation release cannot corrupt accounting", async () => {
    const pool = new ConsoleExecutionPool({
      maxResidentProcesses: 1,
      maxActiveExecutions: 1,
    });
    const reservation = await pool.reserveAwaited([{
      sessionId: "reserved-session",
      branchId: "reserved-branch",
    }]);
    expect(pool.capacityStatus().reservedProcesses).toBe(1);
    await pool.stop();
    await reservation.release();
    expect(pool.capacityStatus()).toMatchObject({
      residentProcesses: 0,
      activeExecutions: 0,
      queuedExecutions: 0,
      reservedProcesses: 0,
    });
  });

  test("scope reservations pin exact idle workers without overbooking", async () => {
    const pool = new ConsoleExecutionPool({
      maxResidentProcesses: 2,
      maxActiveExecutions: 1,
    });
    const pinned = { sessionId: "pinned-session", branchId: "pinned-branch" };
    const occupied = {
      sessionId: "occupied-session",
      branchId: "occupied-branch",
    };
    const queued = { sessionId: "queued-session", branchId: "queued-branch" };
    await pool.run(pinned, async () => undefined);
    const reservation = await pool.reserveAwaited([pinned]);
    let releaseOccupied!: () => void;
    const occupiedGate = new Promise<void>((resolve) => {
      releaseOccupied = resolve;
    });
    const occupiedRun = pool.run(occupied, async () => occupiedGate);
    while (pool.capacityStatus().residentProcesses < 2) await Bun.sleep(5);
    const queuedRun = pool.run(queued, async () => "queued-ran");
    await Bun.sleep(25);
    expect(pool.capacityStatus()).toMatchObject({
      residentProcesses: 2,
      queuedExecutions: 1,
      reservedProcesses: 1,
    });
    await reservation.release();
    expect(await queuedRun).toBe("queued-ran");
    releaseOccupied();
    await occupiedRun;
    await pool.stop();
  });

  test("a suspended parent awaits a multi-cell child with one active permit", async () => {
    const value = await fixture({ maxResident: 2, maxActive: 1 });
    try {
      const result = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.run({ task: "nested-multi-child", idempotencyKey: "nested-multi-child" });`,
      );
      expect(result.result).toMatchObject({
        status: "succeeded",
        output: { kind: "text", text: "multi-cell child complete" },
      });
      const [task] = await value.supervisor.agents.listTasks(
        value.root.sessionId,
        value.root.branchId,
      );
      const childEvents = await value.supervisor.storage.loadEvents(
        task!.childSessionId,
        { branchId: task!.childBranchId },
      );
      const cells = childEvents.filter((event) => event.type === "CellCommitted");
      expect(cells).toHaveLength(2);
      expect((cells[1]!.payload as any).result).toMatchObject({
        steps: ["first", "second"],
      });
      expect(value.supervisor.console.capacityStatus().activeExecutions).toBe(0);
    } finally {
      await value.supervisor.close();
    }
  });

  test("a child can await a grandchild without exceeding durable depth", async () => {
    const value = await fixture({
      maxResident: 3,
      maxActive: 1,
      maxAwaitedDepth: 2,
    });
    try {
      const result = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.run({ task: "nested-parent-child", idempotencyKey: "nested-parent-child" });`,
      );
      expect(result.result).toMatchObject({
        status: "succeeded",
        output: { kind: "text", text: "grandchild was awaited" },
      });
      const children = await value.supervisor.agents.listTasks(
        value.root.sessionId,
        value.root.branchId,
      );
      expect(children).toHaveLength(1);
      const grandchildren = await value.supervisor.agents.listTasks(
        children[0]!.childSessionId,
        children[0]!.childBranchId,
      );
      expect(grandchildren).toHaveLength(1);
      expect(grandchildren[0]!.status).toBe("completed");
    } finally {
      await value.supervisor.close();
    }
  });

  test("runMany overlaps siblings while isolating bindings, logs, and worker heap", async () => {
    const value = await fixture({ maxResident: 3, maxActive: 2 });
    try {
      const result = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.runMany([
          { task: "fan-left", idempotencyKey: "fan-left" },
          { task: "fan-right", idempotencyKey: "fan-right" },
        ]);`,
      );
      expect((result.result as any[]).map((item) => item.status)).toEqual([
        "succeeded",
        "succeeded",
      ]);
      const tasks = await value.supervisor.agents.listTasks(
        value.root.sessionId,
        value.root.branchId,
      );
      const committed = await Promise.all(tasks.map(async (task) =>
        (await value.supervisor.storage.loadEvents(task.childSessionId, {
          branchId: task.childBranchId,
        })).filter((event) => event.type === "CellCommitted")
      ));
      const finalResults = committed.map((events) =>
        (events[0]!.payload as any).result
      );
      expect(new Set(finalResults.map((item) => item.identity))).toEqual(
        new Set(["left", "right"]),
      );
      expect(new Set(finalResults.map((item) => item.pid)).size).toBe(2);
      expect(
        Math.max(...finalResults.map((item) => item.startedAt)),
      ).toBeLessThan(
        Math.min(...finalResults.map((item) => item.endedAt)),
      );
      const logs = committed.map((events) =>
        events.flatMap((event) => (event.payload as any).logs)
      );
      expect(logs.some((items) =>
        items.includes("left-only") && !items.includes("right-only")
      )).toBe(true);
      expect(logs.some((items) =>
        items.includes("right-only") && !items.includes("left-only")
      )).toBe(true);
    } finally {
      await value.supervisor.close();
    }
  });

  test("capacity errors are typed, pre-admission, and batch atomic", async () => {
    const value = await fixture({ maxResident: 2, maxActive: 1 });
    try {
      const failed = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `try {
          await sdk.agents.runMany([
            { task: "fan-left", idempotencyKey: "capacity-left" },
            { task: "fan-right", idempotencyKey: "capacity-right" },
          ]);
          return { unexpected: true };
        } catch (error) {
          return { code: error.code, details: error.details };
        }`,
      );
      expect(failed.result).toMatchObject({
        code: "CONSOLE_CAPACITY_EXCEEDED",
        details: {
          requestedResidentProcesses: 2,
          availableResidentProcesses: 1,
        },
      });
      expect(await value.supervisor.agents.listTasks(
        value.root.sessionId,
        value.root.branchId,
      )).toHaveLength(0);
    } finally {
      await value.supervisor.close();
    }
  });

  test("admission validation precedes capacity and leaves no reservation", async () => {
    const value = await fixture({ maxResident: 1, maxActive: 1 });
    try {
      const failed = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `try {
          await sdk.agents.run({ task: "", idempotencyKey: "invalid-child" });
          return { unexpected: true };
        } catch (error) {
          return { code: error.code, message: error.message };
        }`,
      );
      expect(failed.result).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "Subagent task must be a non-empty string",
      });
      expect(await value.supervisor.agents.listTasks(
        value.root.sessionId,
        value.root.branchId,
      )).toHaveLength(0);
      expect(value.supervisor.console.capacityStatus().reservedProcesses).toBe(0);
    } finally {
      await value.supervisor.close();
    }
  });

  test("a single awaited child fails before admission when no slot exists", async () => {
    const value = await fixture({ maxResident: 1, maxActive: 1 });
    try {
      const failed = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `try {
          await sdk.agents.run({ task: "nested-multi-child", idempotencyKey: "no-capacity-child" });
          return { unexpected: true };
        } catch (error) {
          return { code: error.code };
        }`,
      );
      expect(failed.result).toEqual({
        code: "CONSOLE_CAPACITY_EXCEEDED",
      });
      expect(await value.supervisor.agents.listTasks(
        value.root.sessionId,
        value.root.branchId,
      )).toHaveLength(0);
    } finally {
      await value.supervisor.close();
    }
  });

  test("detached spawn may queue until its parent worker becomes idle", async () => {
    const value = await fixture({ maxResident: 1, maxActive: 1 });
    try {
      const spawned = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.spawn({ task: "detached-queued-child", idempotencyKey: "detached-queued-child" });`,
      );
      expect(spawned.result).toMatchObject({ status: "admitted" });
      const handle = spawned.result as any;
      const terminal = await value.supervisor.agents.result(
        value.root.sessionId,
        value.root.branchId,
        handle.taskId,
        { wait: true, timeoutMs: 3_000 },
      );
      expect(terminal.status).toBe("succeeded");
      const retained = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.result("${handle.taskId}", { wait: true });`,
      );
      expect(retained.result).toMatchObject({ status: "succeeded" });
      const retried = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.run({ task: "detached-queued-child", idempotencyKey: "detached-queued-child" });`,
      );
      expect(retried.result).toMatchObject({ status: "succeeded" });
    } finally {
      await value.supervisor.close();
    }
  });

  test("one worker loss does not disturb a sibling warm scope", async () => {
    const value = await fixture({ maxResident: 2, maxActive: 1 });
    try {
      const sibling = await value.supervisor.createSession({
        workspaceId: "console-pool",
        model: { provider: "nested-console-actions", model: "fixture-v1" },
      });
      const first = await value.supervisor.executeCell(
        sibling.sessionId,
        sibling.branchId,
        `const keep = "sibling"; return { pid: process.pid };`,
      );
      const interrupted = value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `console.log("interrupt-me"); await Bun.sleep(10_000); return { unexpected: true };`,
      );
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (value.supervisor.console.capacityStatus().activeExecutions === 1) {
          break;
        }
        await Bun.sleep(10);
      }
      await value.supervisor.console.recycleScope(
        { sessionId: value.root.sessionId, branchId: value.root.branchId },
        "test-worker-loss",
      );
      await expect(interrupted).rejects.toThrow(/exited/i);
      const rootEvents = await value.supervisor.storage.loadEvents(
        value.root.sessionId,
        { branchId: value.root.branchId },
      );
      expect(rootEvents.some((event) => event.type === "CellFailed")).toBe(true);
      const preserved = await value.supervisor.executeCell(
        sibling.sessionId,
        sibling.branchId,
        `return { keep, pid: process.pid };`,
      );
      expect(preserved.result).toEqual({
        keep: "sibling",
        pid: (first.result as any).pid,
      });
    } finally {
      await value.supervisor.close();
    }
  });

  test("cancellation stops the exact child worker and releases active capacity", async () => {
    const value = await fixture({ maxResident: 3, maxActive: 2 });
    try {
      const spawned = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.spawn({ task: "cancellable-pool-child", name: "pool-cancellable", idempotencyKey: "cancellable-pool-child" });`,
      );
      const handle = spawned.result as any;
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (value.supervisor.console.capacityStatus().activeExecutions === 1) {
          break;
        }
        await Bun.sleep(10);
      }
      expect(value.supervisor.console.capacityStatus().activeExecutions).toBe(1);
      const cancelled = await value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.cancel("pool-cancellable", "pool cancellation");`,
      );
      expect(cancelled.result).toMatchObject({
        taskId: handle.taskId,
        status: "cancelled",
      });
      expect(value.supervisor.console.capacityStatus()).toMatchObject({
        activeExecutions: 0,
        residentProcesses: 1,
      });
      const childEvents = await value.supervisor.storage.loadEvents(
        handle.sessionId,
        { branchId: handle.branchId },
      );
      expect(childEvents.some((event) => event.type === "CellFailed")).toBe(true);
    } finally {
      await value.supervisor.close();
    }
  });

  test("parent worker loss does not cancel an admitted awaited child", async () => {
    const value = await fixture({ maxResident: 2, maxActive: 1 });
    try {
      const parentCell = value.supervisor.executeCell(
        value.root.sessionId,
        value.root.branchId,
        `return sdk.agents.run({ task: "nested-multi-child", idempotencyKey: "survive-parent-loss" });`,
      );
      let task: Awaited<ReturnType<typeof value.supervisor.agents.listTasks>>[number] |
        undefined;
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        task = (await value.supervisor.agents.listTasks(
          value.root.sessionId,
          value.root.branchId,
        ))[0];
        if (task) break;
        await Bun.sleep(10);
      }
      expect(task).toBeDefined();
      await value.supervisor.console.recycleScope(
        { sessionId: value.root.sessionId, branchId: value.root.branchId },
        "parent-worker-lost",
      );
      await expect(parentCell).rejects.toThrow(/exited/i);
      const child = await value.supervisor.agents.result(
        value.root.sessionId,
        value.root.branchId,
        task!.taskId,
        { wait: true, timeoutMs: 3_000 },
      );
      expect(child.status).toBe("succeeded");
      expect(value.supervisor.console.capacityStatus().activeExecutions).toBe(0);
    } finally {
      await value.supervisor.close();
    }
  });

  test("shutdown terminates in-flight workers and clears pool accounting", async () => {
    const value = await fixture({ maxResident: 2, maxActive: 1 });
    const running = value.supervisor.executeCell(
      value.root.sessionId,
      value.root.branchId,
      `await Bun.sleep(10_000); return { unexpected: true };`,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (value.supervisor.console.capacityStatus().activeExecutions === 1) break;
      await Bun.sleep(10);
    }
    await value.supervisor.close();
    expect(await running).toBeInstanceOf(Error);
    expect(value.supervisor.console.capacityStatus()).toMatchObject({
      residentProcesses: 0,
      activeExecutions: 0,
      queuedExecutions: 0,
      reservedProcesses: 0,
    });
  });

  test("shutdown drains late durable RPC completion before storage closes", async () => {
    const value = await fixture({ maxResident: 2, maxActive: 1 });
    const parent = value.supervisor.executeCell(
      value.root.sessionId,
      value.root.branchId,
      `return sdk.agents.run({
        task: "retry-running-child",
        idempotencyKey: "shutdown-running-child",
      });`,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if ((await value.supervisor.agents.listTasks(
        value.root.sessionId,
        value.root.branchId,
      )).length === 1) break;
      await Bun.sleep(10);
    }
    await value.supervisor.console.recycleScope(
      { sessionId: value.root.sessionId, branchId: value.root.branchId },
      "shutdown-parent-worker-loss",
    );
    expect(await parent).toBeInstanceOf(Error);
    const closed = await Promise.race([
      value.supervisor.close().then(() => true),
      Bun.sleep(3_000).then(() => false),
    ]);
    expect(closed).toBe(true);
    expect(value.supervisor.console.capacityStatus()).toMatchObject({
      residentProcesses: 0,
      activeExecutions: 0,
      queuedExecutions: 0,
      reservedProcesses: 0,
    });
  });
});

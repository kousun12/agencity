import { afterEach, describe, expect, test } from "bun:test";
import { Supervisor, projectEvents, type SpawnAgentInput } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(removeTempRuntime)); });

async function open(options: Record<string, unknown> = {}) {
  const temp = await makeTempRuntime("agencity-slice2-spawn-");
  temps.push(temp);
  return Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    recover: false,
    ...options,
  });
}

describe("Slice 2 atomic and policy-bounded subagent admission", () => {
  test("spawnMany is all-or-nothing when any member is invalid", async () => {
    const supervisor = await open();
    try {
      const root = await supervisor.createSession({ workspaceId: "atomic" });
      await expect(supervisor.agents.spawnMany(root.sessionId, root.branchId, [
        { task: "valid child must roll back" },
        { task: "   " },
      ])).rejects.toThrow();
      await Bun.sleep(30); // a rejected Promise.all must not leave a still-committing sibling
      expect(await supervisor.agents.listChildren(root.sessionId)).toEqual([]);
      expect(await supervisor.agents.listTasks(root.sessionId, root.branchId)).toEqual([]);
    } finally { await supervisor.close(); }
  });

  test("spawnMany reserves the whole batch against the child-count limit", async () => {
    const supervisor = await open({ maxChildrenPerSession: 2 });
    try {
      const root = await supervisor.createSession({ workspaceId: "count" });
      await supervisor.agents.spawn(root.sessionId, root.branchId, "already admitted");
      await expect(supervisor.agents.spawnMany(root.sessionId, root.branchId, ["batch a", "batch b"]))
        .rejects.toThrow(/child|limit|maximum/i);
      expect(await supervisor.agents.listChildren(root.sessionId)).toHaveLength(1);
      expect(await supervisor.agents.listTasks(root.sessionId, root.branchId)).toHaveLength(1);
    } finally { await supervisor.close(); }
  });

  test("an idempotent spawnMany retry returns the original durable handles without duplicate work", async () => {
    const supervisor = await open();
    try {
      const root = await supervisor.createSession({ workspaceId: "retry" });
      type IdempotentSpawn = SpawnAgentInput & { readonly idempotencyKey: string };
      const requests: readonly IdempotentSpawn[] = [
        { task: "one", sessionId: "stable-child-one", branchId: "main", idempotencyKey: "spawn-one" },
        { task: "two", sessionId: "stable-child-two", branchId: "main", idempotencyKey: "spawn-two" },
      ];
      const first = await supervisor.agents.spawnMany(root.sessionId, root.branchId, requests);
      const retried = await supervisor.agents.spawnMany(root.sessionId, root.branchId, requests);
      expect(retried).toEqual(first);
      expect(await supervisor.agents.listChildren(root.sessionId)).toHaveLength(2);
      expect(await supervisor.agents.listTasks(root.sessionId, root.branchId)).toHaveLength(2);
    } finally { await supervisor.close(); }
  });

  test("an explicit-model retry reuses the retained child configuration without re-resolving capability data", async () => {
    const provider = {
      name: "reasoning-retry-fixture",
      capabilities: { streaming: false, reasoningControl: "normalized" as const },
      normalizeModel(model: string) { return model === "alias-model" ? "canonical-model" : model; },
      async complete() {
        return { text: "unused", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
      },
    };
    const supervisor = await open({ modelProviders: [provider] });
    try {
      const root = await supervisor.createSession({
        workspaceId: "model-retry",
        model: { provider: provider.name, model: "alias-model", reasoningEffort: "high" },
      });
      const request = {
        task: "stable explicit model",
        idempotencyKey: "stable-explicit-model",
        model: { provider: provider.name, model: "alias-model", reasoningEffort: "high" as const },
      };
      const first = await supervisor.agents.spawn(root.sessionId, root.branchId, request);
      (supervisor.agents as any).normalizeModel = () => {
        throw new Error("catalog changed");
      };
      await expect(supervisor.agents.spawn(root.sessionId, root.branchId, request)).resolves.toEqual(first);
    } finally { await supervisor.close(); }
  });

  test("a child with no explicit budget inherits the bounded parent budget", async () => {
    const supervisor = await open();
    try {
      const budget = { tokenLimit: 100, costLimitUsd: 1, turnLimit: 3, wallTimeLimitMs: 5_000 };
      const root = await supervisor.createSession({ workspaceId: "budget", budget });
      const child = await supervisor.agents.spawn(root.sessionId, root.branchId, "bounded child");
      const state = projectEvents(await supervisor.storage.loadEvents(child.sessionId, { branchId: child.branchId }));
      expect(state.budget.limits).toEqual(budget);
      const task = (await supervisor.agents.listTasks(root.sessionId))[0];
      expect(task?.budget).toEqual(budget);
    } finally { await supervisor.close(); }
  });

  test("omitted child models inherit effort exactly while explicit effort is normalized independently", async () => {
    const provider = {
      name: "reasoning-fixture",
      capabilities: { streaming: false, reasoningControl: "normalized" as const },
      async complete() {
        return {
          text: "unused",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        };
      },
    };
    const supervisor = await open({ modelProviders: [provider] });
    try {
      const root = await supervisor.createSession({
        workspaceId: "reasoning-inheritance",
        model: { provider: provider.name, model: "same-model", reasoningEffort: "high" },
      });
      const inherited = await supervisor.agents.spawn(root.sessionId, root.branchId, "inherit exact effort");
      const explicit = await supervisor.agents.spawn(root.sessionId, root.branchId, {
        task: "use an explicit lower effort",
        model: { provider: provider.name, model: "same-model", reasoningEffort: "low" },
      });
      expect(projectEvents(await supervisor.storage.loadEvents(inherited.sessionId, { branchId: inherited.branchId })).model.reasoningEffort).toBe("high");
      expect(projectEvents(await supervisor.storage.loadEvents(explicit.sessionId, { branchId: explicit.branchId })).model.reasoningEffort).toBe("low");
    } finally { await supervisor.close(); }
  });

  test("a child cannot request a larger budget or model envelope than its parent", async () => {
    const supervisor = await open();
    try {
      const root = await supervisor.createSession({
        workspaceId: "policy",
        model: { provider: "echo", model: "echo-1", maxOutputTokens: 32 },
        budget: { tokenLimit: 100, costLimitUsd: 2, turnLimit: 4, wallTimeLimitMs: 10_000 },
      });
      await expect(supervisor.agents.spawn(root.sessionId, root.branchId, {
        task: "over-budget",
        budget: { tokenLimit: 101, costLimitUsd: 3, turnLimit: 5, wallTimeLimitMs: 10_001 },
      })).rejects.toThrow(/budget|policy|limit/i);
      await expect(supervisor.agents.spawn(root.sessionId, root.branchId, {
        task: "unapproved-model",
        model: { provider: "other-provider", model: "larger", maxOutputTokens: 64 },
      })).rejects.toThrow(/model|provider|policy|limit/i);
      expect(await supervisor.agents.listChildren(root.sessionId)).toEqual([]);
    } finally { await supervisor.close(); }
  });

  test("sibling budget reservations cannot collectively exceed the parent tree budget", async () => {
    const supervisor = await open();
    try {
      const root = await supervisor.createSession({ workspaceId: "tree-budget", budget: { tokenLimit: 100 } });
      await supervisor.agents.spawn(root.sessionId, root.branchId, { task: "first", budget: { tokenLimit: 60 } });
      await expect(supervisor.agents.spawn(root.sessionId, root.branchId, { task: "second", budget: { tokenLimit: 60 } }))
        .rejects.toThrow(/budget|reserve|limit/i);
      expect(await supervisor.agents.listChildren(root.sessionId)).toHaveLength(1);
    } finally { await supervisor.close(); }
  });

  test("depth and direct-child limits remain authoritative at every generation", async () => {
    const supervisor = await open({ maxSessionDepth: 1, maxChildrenPerSession: 1 });
    try {
      const root = await supervisor.createSession({ workspaceId: "shape" });
      const child = await supervisor.agents.spawn(root.sessionId, root.branchId, "only child");
      await expect(supervisor.agents.spawn(root.sessionId, root.branchId, "second child"))
        .rejects.toThrow(/child|maximum/i);
      await expect(supervisor.agents.spawn(child.sessionId, child.branchId, "too deep"))
        .rejects.toThrow(/depth|maximum/i);
      expect(await supervisor.agents.listChildren(root.sessionId)).toHaveLength(1);
      expect(await supervisor.agents.listChildren(child.sessionId)).toHaveLength(0);
    } finally { await supervisor.close(); }
  });
});

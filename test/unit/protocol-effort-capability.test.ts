import { describe, expect, test } from "bun:test";
import { AgentClient, ProtocolClientError, type ProtocolTransport } from "../../src/protocol/index.ts";

describe("reasoning-effort protocol negotiation", () => {
  test("preserves legacy model selection and fails before sending effort to an older server", async () => {
    const requests: string[] = [];
    const transport: ProtocolTransport = {
      kind: "in-process",
      async request(path) {
        requests.push(path);
        if (path === "/capabilities") {
          return Response.json({
            protocol: "agencity.protocol",
            version: 1,
            mode: "trusted-local",
            trustedLocal: true,
            hostileCodeSandbox: false,
            snapshotCursorResume: true,
            committedEventDeduplication: true,
            cursorlessProgress: true,
            historicalProjection: true,
            managedService: true,
            productCatalog: true,
            sync: {},
            providers: [],
          });
        }
        return Response.json({ changed: true });
      },
    };
    const client = new AgentClient(transport);

    await expect(client.selectModel("session", "branch", {
      provider: "openai",
      model: "openai/gpt-test",
    })).resolves.toEqual({ changed: true });

    await expect(client.selectModel("session", "branch", {
      provider: "openai",
      model: "openai/gpt-test",
      reasoningEffort: "high",
    })).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      status: 501,
    });
    await expect(client.modelCatalog()).rejects.toBeInstanceOf(ProtocolClientError);
    const explicitModel = {
      provider: "openai",
      model: "openai/gpt-test",
      reasoningEffort: "high",
    } as const;
    await expect(client.createSession("workspace", { model: explicitModel })).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    await expect(client.spawn("session", "branch", { task: "child", model: explicitModel })).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    await expect(client.spawnMany("session", "branch", [{ task: "child", model: explicitModel }])).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    await expect(client.admitTextGeneration("session", "branch", { prompt: "child", model: explicitModel })).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    expect(requests.filter(path => path.includes("/sessions/"))).toHaveLength(1);
    expect(requests).not.toContain("/sessions");
    expect(requests).not.toContain("/model-catalog");
  });

  test("omits provider-default and undefined effort fields for an older server", async () => {
    const requests: Array<{ path: string; body: any }> = [];
    const transport: ProtocolTransport = {
      kind: "in-process",
      async request(path, init) {
        requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (path === "/capabilities") return Response.json({ reasoningEffortSelection: false });
        if (path === "/sessions") return Response.json({ sessionId: "new-session", branchId: "main" });
        return Response.json({ changed: true });
      },
    };
    const client = new AgentClient(transport);
    await client.selectModel("session", "branch", {
      provider: "openai",
      model: "openai/gpt-test",
      reasoningEffort: undefined,
    } as any);
    expect(requests.some(request => request.path === "/capabilities")).toBe(false);
    expect(requests[0]?.body.model).not.toHaveProperty("reasoningEffort");

    await client.createSession("workspace", {
      model: { provider: "openai", model: "openai/gpt-test", reasoningEffort: "default" },
    });
    expect(requests.filter(request => request.path === "/capabilities")).toHaveLength(0);
    expect(requests.find(request => request.path === "/sessions")?.body.model)
      .toEqual({ provider: "openai", model: "openai/gpt-test" });
  });

  test("retries a transient capability lookup before sending non-default effort", async () => {
    let capabilityCalls = 0;
    let modelCalls = 0;
    const transport: ProtocolTransport = {
      kind: "in-process",
      async request(path) {
        if (path === "/capabilities") {
          capabilityCalls++;
          if (capabilityCalls === 1) throw new Error("temporary disconnect");
          return Response.json({ reasoningEffortSelection: true });
        }
        modelCalls++;
        return Response.json({ changed: true });
      },
    };
    const client = new AgentClient(transport);
    const model = { provider: "openai", model: "openai/gpt-test", reasoningEffort: "high" } as const;
    await expect(client.selectModel("session", "branch", model)).rejects.toThrow("temporary disconnect");
    await expect(client.selectModel("session", "branch", model)).resolves.toEqual({ changed: true });
    expect(capabilityCalls).toBe(2);
    expect(modelCalls).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import {
  buildTerminalDetail,
  buildTerminalEffortDetail,
  buildTerminalModelDetail,
  formatTerminalDetail,
  formatTerminalRaw,
} from "../../src/tui/detail-model.ts";

describe("terminal inspector view models", () => {
  test.each([
    ["/sessions", [{ sessionName: "Fix parser", branchName: "main", status: "idle", model: { provider: "openai", model: "gpt-test" }, taskSummary: "Repair parsing", unresolvedWork: 0, activeGoals: 1 }], "Retained work"],
    ["/budget", { limits: { tokenLimit: 10_000, turnLimit: 20 }, tokens: 450, turns: 2, costUsd: 0.1, wallTimeMs: 2_000, exceeded: false }, "Usage"],
    ["/cells", [{ code: "return 42", status: "committed", attempts: 1, result: 42, logs: [] }], "Cells · 1"],
    ["/agents", { family: { items: [{ name: "reviewer", relationship: "child", status: "idle", taskStatus: "completed", task: "Review the patch", cancellationRequested: false, activity: "attention", activityReason: "unknown" }] }, tasks: [{ task: "Review", status: "completed", model: { provider: "openai", model: "gpt-test" }, result: "Done" }], mailbox: { items: [] } }, "unknown outcome"],
    ["/mailbox", { items: [{ senderName: "reviewer", recipientName: "root", receiptStatus: "delivered", content: "Review complete" }] }, "Review complete"],
    ["/goals", [{ description: "Ship safely", status: "active", gates: [{ status: "passed" }] }], "completion evidence"],
    ["/heartbeats", [{ intervalMs: 60_000, nextTickAt: "2026-08-07T12:00:00.000Z", status: "active", prompt: "Check progress" }], "Every 1 min"],
    ["/schedules", [{ kind: "once", prompt: "Run checks", nextTickAt: "2026-08-07T12:00:00.000Z", status: "active" }], "Run checks"],
    ["/memory", [{ name: "Testing preference", kind: "memory", scope: "workspace", current: { status: "active", content: { text: "Run focused tests first" } } }], "Run focused tests first"],
    ["/skills", [{ name: "verify", availability: "enabled", scope: "workspace", source: "harness", description: "Run verification", permissions: ["shell"] }], "Permissions: shell"],
    ["/refine", { reviews: [{ mode: "manual", status: "completed", sourceEventIds: [] }], proposals: [{ predictedEffect: "Reduce repeated failures", status: "validated", edits: [], authority: "agent" }] }, "Proposals"],
    ["/refine", { automatic: true, scope: "local", effectFailure: { enabled: true }, completionGateFailure: { enabled: true } }, "Automatic refinement — enabled"],
    ["/context", { canonicalEventCount: 20, messageCount: 5, uncoveredMessageCount: 2, estimatedUncompactedNarrativeTokens: 300, capacity: { source: "model-catalog" }, effective: null }, "Uncovered narrative"],
    ["/sync-status", { capabilities: { configured: false, networkSync: false }, replica: { lifecycle: "local_only", stagedEnvelopes: 0, quarantinedEnvelopes: 0 }, conflicts: [], quarantineCount: 0 }, "Local-only"],
    ["/conflicts", [{ conflictId: "conflict-needed-for-resolution", kind: "task_claim", status: "unresolved", detectedAt: "2026-08-07T12:00:00.000Z" }], "Conflict ID"],
    ["/unknown", [{ effect: { id: "effect-needed-for-reconciliation", executor: "shell", operation: "run" }, assessments: [] }], "retry not allowed"],
    ["/history", [{ cursor: "0002", type: "MessageAppended", payload: { content: "hello" } }], "Message Appended"],
  ] as const)("%s renders a task-specific view", (command, value, expected) => {
    const output = formatTerminalDetail(buildTerminalDetail(command, value), { footer: false });
    expect(output).toContain(expected);
    expect(output.trimStart().startsWith("{")).toBe(false);
    expect(output).not.toContain('"sessionId"');
  });

  test("model status uses human provider and credential labels", () => {
    const detail = buildTerminalModelDetail({
      current: { provider: "vercel", model: "openai/gpt-test", reasoningEffort: "provider-default" },
      workspaceDefault: "vercel:openai/gpt-test",
      providers: [{
        name: "vercel",
        displayName: "Vercel AI Gateway",
        capabilities: {
          streaming: true,
          requiredToolSet: {
            status: "unknown",
            requiredChoice: "provider-enforced",
            parallelCalls: "runtime-rejected",
            streaming: true,
            adapter: "fixture.ai-sdk.v1",
            reason: "Catalog evidence remains unknown.",
          },
        },
        usable: true,
        credentialSource: "stored",
      }],
      currentAgentTools: {
        provider: "vercel",
        model: "openai/gpt-test",
        state: "unknown",
        admission: "allowed",
        canRun: true,
        reason: "Catalog evidence remains unknown.",
        capabilityReason: "Catalog evidence remains unknown.",
        transport: {
          provider: "vercel",
          displayName: "Vercel AI Gateway",
          state: "unknown",
          admission: "allowed",
          canRun: true,
          credential: "stored",
          requiredChoice: "provider-enforced",
          parallelCalls: "runtime-rejected",
          boundedToolInputStreaming: true,
          adapter: "fixture.ai-sdk.v1",
          provenance: { kind: "transport", reportedStatus: "unknown" },
        },
        modelCatalog: {
          status: "unknown",
          strictSchema: "unknown",
          requiredChoice: "unknown",
          digest: "a".repeat(64),
          endpointId: "b".repeat(64),
          stale: false,
        },
      },
      catalogModels: [{
        model: "openai/unsupported-test",
        displayName: "Unsupported test model",
        contextWindowTokens: null,
        maxOutputTokens: null,
        pricing: null,
        reasoning: { status: "unsupported", levels: [] },
        requiredToolSet: {
          status: "unsupported",
          strictSchema: "unsupported",
          requiredChoice: "unsupported",
        },
        catalogDigest: "c".repeat(64),
        catalogEndpointId: "d".repeat(64),
        stale: false,
      }],
    });
    const output = formatTerminalDetail(detail);
    expect(output).toContain("Vercel AI Gateway");
    expect(output).toContain("Credential: saved");
    expect(output).toContain("openai/gpt-test");
    expect(output).toContain("Agent tools: unknown");
    expect(output).toContain("Catalog evidence remains unknown.");
    expect(output).toContain("agent tools unavailable");
    expect(output).not.toContain('"credentialSource"');
  });

  test("workspace status shows selected formal capability and bounded counters", () => {
    const detail = buildTerminalDetail("/info", {
      state: {
        sessionName: "Formal status",
        branch: { name: "main" },
        model: { provider: "openai", model: "openai/gpt-test" },
      },
      capabilities: {
        snapshotCursorResume: true,
        sync: { configured: false },
        providers: [{ name: "openai", capabilities: { streaming: true } }],
      },
      recovery: {
        pendingEffectIds: [],
        unknownEffects: [],
        activeChildTaskIds: [],
        attentionGoalGateIds: [],
      },
      agentTools: {
        contract: { tools: ["bun_console", "finish"] },
        selected: {
          state: "runtime-validated",
          canRun: true,
        },
      },
      modelContracts: {
        counters: {
          submissions: [{ count: 3 }],
          violations: [{ count: 1 }],
        },
      },
      connection: "connected",
    });
    const output = formatTerminalDetail(detail, { footer: false });
    expect(output).toContain("Formal agent tools — runtime validated");
    expect(output).toContain("bun_console + finish");
    expect(output).toContain("Formal outcomes — 3 accepted · 1 violations");
    expect(output).not.toContain("sessionId");
  });

  test("reasoning effort status distinguishes unverified catalog choices", () => {
    const detail = buildTerminalEffortDetail({
      model: { provider: "vercel", model: "openai/gpt-test", reasoningEffort: "high" },
      capability: { status: "unverified", levels: ["none", "low", "medium", "high"] },
      catalog: {
        origin: "https://ai-gateway.vercel.sh",
        stale: true,
        error: "Gateway model catalog request failed",
      },
    });
    const output = formatTerminalDetail(detail);
    expect(output).toContain("Capability: unverified · stale catalog");
    expect(output).toContain("> high · unverified");
    expect(output).toContain("Gateway model catalog request failed");
    expect(output).not.toContain('"catalog"');
  });

  test("raw diagnostics require an explicit formatter and redact credential fields and known values", () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "known-secret-for-inspector";
    try {
      const value = {
        status: "ok",
        apiKey: "unknown-secret-value",
        accessToken: "unknown-access-token",
        auth_token: "unknown-auth-token",
        clientSecret: "unknown-client-secret",
        nested: { message: "known-secret-for-inspector" },
      };
      const normal = formatTerminalDetail(buildTerminalDetail("/snapshot", value), { footer: false });
      expect(normal).not.toContain("unknown-secret-value");
      expect(normal).not.toContain("known-secret-for-inspector");
      const raw = formatTerminalRaw(value);
      expect(raw).toContain('"apiKey": "[REDACTED]"');
      expect(raw).not.toContain("unknown-secret-value");
      expect(raw).not.toContain("unknown-access-token");
      expect(raw).not.toContain("unknown-auth-token");
      expect(raw).not.toContain("unknown-client-secret");
      expect(raw).not.toContain("known-secret-for-inspector");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
});

import { describe, expect, test } from "bun:test";
import {
  buildTerminalDetail,
  buildTerminalModelDetail,
  formatTerminalDetail,
  formatTerminalRaw,
} from "../../src/tui/detail-model.ts";

describe("terminal inspector view models", () => {
  test.each([
    ["/sessions", [{ sessionName: "Fix parser", branchName: "main", status: "idle", model: { provider: "openai", model: "gpt-test" }, taskSummary: "Repair parsing", unresolvedWork: 0, activeGoals: 1 }], "Retained work"],
    ["/budget", { limits: { tokenLimit: 10_000, turnLimit: 20 }, tokens: 450, turns: 2, costUsd: 0.1, wallTimeMs: 2_000, exceeded: false }, "Usage"],
    ["/cells", [{ code: "return 42", status: "committed", attempts: 1, result: 42, logs: [] }], "Cells · 1"],
    ["/agents", { family: { items: [{ name: "reviewer", relationship: "child", status: "idle", taskStatus: "completed" }] }, tasks: [{ task: "Review", status: "completed", model: { provider: "openai", model: "gpt-test" }, result: "Done" }], mailbox: { items: [] } }, "Family"],
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
      current: { provider: "vercel", model: "openai/gpt-test" },
      workspaceDefault: "vercel:openai/gpt-test",
      providers: [{
        name: "vercel",
        displayName: "Vercel AI Gateway",
        capabilities: { streaming: true },
        usable: true,
        credentialSource: "stored",
      }],
    });
    const output = formatTerminalDetail(detail);
    expect(output).toContain("Vercel AI Gateway");
    expect(output).toContain("Credential: saved");
    expect(output).toContain("openai/gpt-test");
    expect(output).not.toContain('"credentialSource"');
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

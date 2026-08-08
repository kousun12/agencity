import { describe, expect, test } from "bun:test";
import type { ProductBranchSummary } from "../../src/product/index.ts";
import {
  buildTerminalWorkspaceAgentRows,
  buildTerminalWorkspaceAgentsView,
  formatTerminalWorkspaceAgentRow,
  selectTerminalWorkspaceAgentKey,
  terminalWorkspaceAgentKey,
  type TerminalWorkspaceAgentsState,
} from "../../src/tui/view-model.ts";

const timestamp = "2026-08-08T12:00:00.000Z";

function summary(
  sessionId: string,
  branchId: string,
  overrides: Partial<ProductBranchSummary> = {},
): ProductBranchSummary {
  return {
    sessionId,
    branchId,
    sessionName: `Agent ${sessionId}`,
    branchName: "main",
    model: { provider: "openai", model: "gpt-test", reasoningEffort: "provider-default" },
    status: "idle",
    taskSummary: "Inspect the workspace",
    activeGoals: 0,
    unresolvedWork: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    root: true,
    initialBranch: true,
    ...overrides,
  };
}

function state(rows: readonly ProductBranchSummary[], overrides: Partial<TerminalWorkspaceAgentsState> = {}): TerminalWorkspaceAgentsState {
  return {
    open: true,
    returnRoute: { sessionId: "return-session", branchId: "return-branch" },
    rows,
    selectedKey: null,
    query: "",
    refresh: "current",
    fetchedAt: timestamp,
    generation: 1,
    ...overrides,
  };
}

describe("workspace Agents view model", () => {
  test("shows every root branch, excludes children, and preserves exact status sections", () => {
    const rows = [
      summary("running", "main", { status: "running" }),
      summary("idle", "main", { status: "idle" }),
      summary("stopped", "main", { status: "stopped" }),
      summary("failed", "main", { status: "failed" }),
      summary("archived", "main", { status: "archived" }),
      summary("child", "main", { root: false }),
      summary("idle", "experiment", { branchName: "experiment", initialBranch: false }),
    ];
    const view = buildTerminalWorkspaceAgentsView(state(rows));

    expect(view.sections.map(section => section.title)).toEqual([
      "Running",
      "Idle",
      "Stopped",
      "Failed",
      "Archived",
    ]);
    expect(view.rows.map(row => [row.sessionId, row.branchId])).toEqual([
      ["running", "main"],
      ["idle", "experiment"],
      ["idle", "main"],
      ["stopped", "main"],
      ["failed", "main"],
      ["archived", "main"],
    ]);
    expect(view.rows.find(row => row.sessionId === "idle")?.displayName).toContain(" / ");
    expect(view.rows.find(row => row.sessionId === "failed")?.resumable).toBe(false);
    expect(view.rows.find(row => row.sessionId === "archived")?.resumable).toBe(false);
    expect(view.rows.find(row => row.sessionId === "stopped")?.resumable).toBe(true);
  });

  test("searches visible fields without matching hidden route IDs", () => {
    const rows = [
      summary("secret-session-id", "secret-branch-id", {
        sessionName: "Research agent",
        branchName: "experiment",
        status: "stopped",
        taskSummary: "Review protocol behavior",
        model: { provider: "anthropic", model: "claude-test", reasoningEffort: "high" },
      }),
    ];
    for (const query of ["research", "experiment", "protocol", "anthropic", "stopped"]) {
      expect(buildTerminalWorkspaceAgentRows(rows, query)).toHaveLength(1);
    }
    expect(buildTerminalWorkspaceAgentRows(rows, "secret-session-id")).toHaveLength(0);
    expect(buildTerminalWorkspaceAgentRows(rows, "secret-branch-id")).toHaveLength(0);
  });

  test("sorts deterministically and keeps duplicate names distinct through route keys", () => {
    const rows = [
      summary("session-b", "branch-b", { sessionName: "Same", branchName: "Same", updatedAt: "2026-08-08T11:00:00.000Z" }),
      summary("session-a", "branch-a", { sessionName: "Same", branchName: "Same", updatedAt: "2026-08-08T11:00:00.000Z" }),
      summary("session-c", "branch-c", { sessionName: "Later", updatedAt: "2026-08-08T12:00:00.000Z" }),
    ];
    const built = buildTerminalWorkspaceAgentRows(rows);
    expect(built.map(row => row.sessionId)).toEqual(["session-c", "session-a", "session-b"]);
    expect(new Set(built.map(row => row.key)).size).toBe(3);
    expect(built[1]?.key).toBe(terminalWorkspaceAgentKey(rows[1]!));
  });

  test("preserves visible selection and otherwise prefers the nearest resumable row", () => {
    const rows = [
      summary("running", "main", { status: "running", sessionName: "Alpha" }),
      summary("failed", "main", { status: "failed", sessionName: "Beta" }),
      summary("idle", "main", { status: "idle", sessionName: "Gamma" }),
    ];
    const failedKey = terminalWorkspaceAgentKey(rows[1]!);
    expect(selectTerminalWorkspaceAgentKey(rows, "", failedKey)).toBe(failedKey);
    expect(selectTerminalWorkspaceAgentKey(rows, "gamma", failedKey)).toBe(terminalWorkspaceAgentKey(rows[2]!));
    expect(selectTerminalWorkspaceAgentKey(rows, "missing", failedKey)).toBeNull();
  });

  test("uses useful empty and fallback labels and progressively collapses row detail", () => {
    expect(buildTerminalWorkspaceAgentsView(state([]))).toMatchObject({
      rows: [],
      sections: [],
      selectedKey: null,
    });
    const row = buildTerminalWorkspaceAgentRows([
      summary("session", "branch", {
        sessionName: " ",
        branchName: " ",
        taskSummary: null,
        unresolvedWork: 2,
        activeGoals: 1,
      }),
    ])[0]!;
    expect(row).toMatchObject({
      displayName: "Unnamed agent",
      branchName: "unnamed branch",
      task: "No retained task summary",
    });
    const now = Date.parse("2026-08-08T12:05:00.000Z");
    expect(formatTerminalWorkspaceAgentRow(row, 100, true, now).secondary).toContain("openai:gpt-test");
    expect(formatTerminalWorkspaceAgentRow(row, 80, true, now).secondary).not.toContain("openai:gpt-test");
    expect(formatTerminalWorkspaceAgentRow(row, 64, true, now).secondary).not.toContain(row.task);
    expect(formatTerminalWorkspaceAgentRow(row, 50, true, now).secondary).toContain("updated 5m ago");
    expect(formatTerminalWorkspaceAgentRow(row, 40, true, now).secondary).toBeNull();
    expect(formatTerminalWorkspaceAgentRow(row, 40, true, now).primary).toStartWith("› ");
  });
});

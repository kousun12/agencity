import { describe, expect, test } from "bun:test";
import {
  buildTerminalFamilyChildren,
  buildTerminalFamilySummary,
  formatTerminalBreadcrumb,
  formatTerminalFamilySummary,
} from "../../src/tui/view-model.ts";
import type { FamilyAgentRecord } from "../../src/index.ts";

function family(
  sessionId: string,
  activity: FamilyAgentRecord["activity"],
  overrides: Partial<FamilyAgentRecord> = {},
): FamilyAgentRecord {
  return {
    sessionId,
    branchId: `${sessionId}-branch`,
    name: sessionId,
    relationship: "child",
    depth: 1,
    status: "idle",
    taskId: `${sessionId}-task`,
    taskStatus: "completed",
    task: `Task for ${sessionId}`,
    model: { provider: "fixture", model: "family-model", reasoningEffort: "provider-default" },
    cancellationRequested: false,
    activity,
    activityReason: null,
    ...overrides,
  };
}

describe("terminal family view model", () => {
  test("omits the summary when no direct children exist", () => {
    const rows = buildTerminalFamilyChildren([
      family("parent", "idle", { relationship: "parent" }),
      family("sibling", "working", { relationship: "sibling" }),
    ]);
    expect(rows).toEqual([]);
    expect(buildTerminalFamilySummary(rows)).toBeNull();
  });

  test("sorts exact activity priority with stable identity ties and task fallbacks", () => {
    const rows = buildTerminalFamilyChildren([
      family("idle", "idle"),
      family("working", "working"),
      family("unavailable", "unavailable", { activityReason: "missing_state" }),
      family("ended", "ended", { activityReason: "cancelled" }),
      family("attention-b", "attention", { name: "Same", activityReason: "failed" }),
      family("attention-a", "attention", { name: "Same", activityReason: "unknown" }),
      family("task-fallback", "idle", { name: null, task: "Fallback task" }),
    ]);
    expect(rows.map(row => row.sessionId)).toEqual([
      "attention-a",
      "attention-b",
      "unavailable",
      "working",
      "task-fallback",
      "idle",
      "ended",
    ]);
    expect(rows.find(row => row.sessionId === "task-fallback")?.displayName).toBe("Fallback task");
    expect(rows.find(row => row.sessionId === "unavailable")?.openable).toBe(false);
  });

  test("groups unavailable as attention while retaining ended-only families", () => {
    const summary = buildTerminalFamilySummary(buildTerminalFamilyChildren([
      family("working", "working"),
      family("unavailable", "unavailable"),
      family("attention", "attention"),
      family("ended", "ended"),
    ]));
    expect(summary).toEqual({
      total: 4,
      working: 1,
      idle: 0,
      attention: 2,
      ended: 1,
      label: "4 agents: 1 working · 2 attention · 1 ended   Enter or → to open",
    });
    expect(buildTerminalFamilySummary(buildTerminalFamilyChildren([family("ended", "ended")]))?.label)
      .toBe("1 agent: 1 ended   Enter or → to open");
  });

  test("narrow summaries retain the total and highest-severity count", () => {
    const summary = buildTerminalFamilySummary(buildTerminalFamilyChildren([
      family("working", "working"),
      family("attention", "attention"),
      family("idle", "idle"),
    ]))!;
    expect(formatTerminalFamilySummary(summary, 80)).toBe(summary.label);
    expect(formatTerminalFamilySummary(summary, 24)).toBe("3 agents · 1 attention");
    expect(formatTerminalFamilySummary(summary, 13)).toBe("3 agents · 1…");
  });

  test("breadcrumbs collapse middle ancestry while retaining root and current labels", () => {
    expect(formatTerminalBreadcrumb(["root", "reviewer", "verifier"], "main", 80))
      .toBe("root › reviewer › verifier / main");
    expect(formatTerminalBreadcrumb(["root", "reviewer", "verifier"], "main", 30))
      .toBe("root › … › verifier / main");
    const narrow = formatTerminalBreadcrumb(["long-root-agent", "middle", "long-current-agent"], "main", 24);
    expect(narrow).toContain("long");
    expect(narrow).toContain("… ›");
    expect(narrow).toEndWith("/ main");
    const longBranch = formatTerminalBreadcrumb(["root", "child"], "feature/with-a-very-long-name", 24);
    expect(longBranch.length).toBeLessThanOrEqual(24);
    expect(longBranch).toContain(" / ");
  });
});

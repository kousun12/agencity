import { describe, expect, test } from "bun:test";
import { terminalCellReturnedOutput } from "../../src/tui/transcript.ts";
import {
  terminalCellTone,
  terminalFamilyTone,
  terminalRunTone,
} from "../../src/tui/theme.ts";
import {
  layoutTerminalFooter,
  selectTerminalHeightLayout,
  terminalComposerContentRows,
  terminalComposerPaddingX,
} from "../../src/tui/layout.ts";

describe("structured terminal transcript", () => {
  test("maps every current run, cell, and family status to a semantic tone", () => {
    expect([
      terminalRunTone("queued"),
      terminalRunTone("running"),
      terminalRunTone("succeeded"),
      terminalRunTone("blocked"),
      terminalRunTone("failed"),
      terminalRunTone("cancelled"),
      terminalRunTone("budget_exceeded"),
      terminalRunTone("unknown"),
    ]).toEqual(["accent", "accent", "success", "danger", "danger", "muted", "warning", "danger"]);
    expect([
      terminalCellTone("pending"),
      terminalCellTone("proposed"),
      terminalCellTone("running"),
      terminalCellTone("committed"),
      terminalCellTone("failed"),
      terminalCellTone("abandoned"),
      terminalCellTone("missing"),
    ]).toEqual(["muted", "accent", "accent", "success", "danger", "muted", "danger"]);
    expect([
      terminalFamilyTone("working"),
      terminalFamilyTone("idle"),
      terminalFamilyTone("attention"),
      terminalFamilyTone("ended"),
      terminalFamilyTone("unavailable"),
    ]).toEqual(["accent", "muted", "danger", "muted", "danger"]);
  });

  test("renders returned shell streams without exposing result JSON or duplicating logs", () => {
    const shellResult = {
      exitCode: 0,
      stdout: "tests passed\n",
      stderr: "warning\n",
    };
    expect(terminalCellReturnedOutput(shellResult, [])).toEqual({
      values: ["tests passed", "warning"],
      streams: ["stdout", "stderr"],
    });
    expect(terminalCellReturnedOutput(shellResult, ["tests passed"])).toEqual({
      values: ["warning"],
      streams: ["stderr"],
    });
    expect(terminalCellReturnedOutput({ value: 42 }, [])).toEqual({ values: [], streams: [] });
  });

  test("selects deterministic normal, compact, and minimum height modes", () => {
    expect(selectTerminalHeightLayout(12).mode).toBe("normal");
    expect(selectTerminalHeightLayout(11)).toMatchObject({
      mode: "compact",
      headerRows: 1,
      composerRows: 2,
      showFamilySummary: true,
    });
    expect(selectTerminalHeightLayout(7).mode).toBe("compact");
    expect(selectTerminalHeightLayout(6)).toMatchObject({
      mode: "minimum",
      composerRows: 1,
      showFamilySummary: false,
    });
    expect([terminalComposerPaddingX(7), terminalComposerPaddingX(8), terminalComposerPaddingX(40)])
      .toEqual([0, 1, 2]);
    expect([
      terminalComposerContentRows("one", "normal"),
      terminalComposerContentRows("one\ntwo\nthree", "normal"),
      terminalComposerContentRows("1\n2\n3\n4\n5\n6", "normal"),
      terminalComposerContentRows("one\ntwo\nthree", "compact"),
      terminalComposerContentRows("one\ntwo", "minimum"),
    ]).toEqual([1, 3, 5, 2, 1]);
  });

  test("prioritizes authority, unhealthy state, and current actions in the footer", () => {
    const wide = layoutTerminalFooter({
      width: 160,
      trustLabel: "TRUSTED-LOCAL",
      connection: "reconnecting",
      attentionCount: 3,
      recoveryLabel: "2 recovery items",
      budgetLabel: "8 turns · 400 tokens",
      activeActionHint: "Esc close",
      familyHint: "↓ agents",
    });
    expect(wide.left).toContain("TRUSTED-LOCAL · reconnecting · 3 attention · 2 recovery items");
    expect(wide.left).toContain("8 turns");
    expect(wide.right).toBe("Esc close · ↓ agents · Ctrl-P commands");

    const narrow = layoutTerminalFooter({
      width: 52,
      trustLabel: "TRUSTED-LOCAL",
      connection: "reconnecting",
      attentionCount: 3,
      recoveryLabel: "2 recovery items",
      budgetLabel: "8 turns · 400 tokens",
      activeActionHint: "Esc close",
      familyHint: "↓ agents",
    });
    expect(narrow.left).toContain("TRUSTED-LOCAL");
    expect(narrow.left).toContain("reconnecting");
    expect(narrow.left).toContain("3 attention");
    expect(narrow.left).not.toContain("8 turns");
    expect(narrow.left).not.toContain("recovery");
    expect(narrow.right).toStartWith("Esc");

    const familyFirst = layoutTerminalFooter({
      width: 30,
      trustLabel: "TRUSTED-LOCAL",
      connection: "connected",
      attentionCount: 0,
      recoveryLabel: "recovery healthy",
      budgetLabel: "8 turns · 400 tokens",
      activeActionHint: "",
      familyHint: "↓ agents",
    });
    expect(familyFirst).toEqual({ left: "TRUSTED-LOCAL", right: "↓ agents" });
  });
});

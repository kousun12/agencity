import { describe, expect, test } from "bun:test";
import { formatTerminalCellResult } from "../../src/tui/transcript.ts";
import {
  terminalCellTone,
  terminalFamilyTone,
  terminalRunTone,
} from "../../src/tui/theme.ts";

describe("structured terminal transcript", () => {
  test("maps every current run, cell, and family status to a semantic tone", () => {
    expect([
      terminalRunTone("queued"),
      terminalRunTone("running"),
      terminalRunTone("waiting_for_user"),
      terminalRunTone("succeeded"),
      terminalRunTone("blocked"),
      terminalRunTone("failed"),
      terminalRunTone("cancelled"),
      terminalRunTone("budget_exceeded"),
      terminalRunTone("unknown"),
    ]).toEqual(["accent", "accent", "warning", "success", "danger", "danger", "muted", "warning", "danger"]);
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
      terminalFamilyTone("waiting"),
      terminalFamilyTone("attention"),
      terminalFamilyTone("ended"),
      terminalFamilyTone("unavailable"),
    ]).toEqual(["accent", "muted", "warning", "danger", "muted", "danger"]);
  });

  test("bounds formatted cell results without losing the retained prefix", () => {
    const formatted = formatTerminalCellResult({ rows: Array.from({ length: 200 }, (_, index) => `row-${index}`) });
    expect(formatted).toStartWith("{\n  \"rows\"");
    expect(formatted).toContain("output truncated");
    expect(formatted.length).toBeLessThan(4_200);
  });
});

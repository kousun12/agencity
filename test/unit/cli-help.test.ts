import { describe, expect, test } from "bun:test";
import { cliHelpColorEnabled, renderCliHelp } from "../../src/cli/help.ts";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

describe("CLI help", () => {
  test("renders product-first, readable plain text", () => {
    const help = renderCliHelp({ color: false, width: 100 });
    const positions = ["Usage", "Examples", "Product commands", "Advanced diagnostics", "Sync", "Data control", "Common options", "Advanced options", "Notes"]
      .map((label) => help.indexOf(label));

    expect(help).not.toMatch(ANSI_PATTERN);
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(help).toContain('agencity "find and fix the flaky test"');
    expect(help).toContain("agencity debug history");
    expect(help).toContain("(legacy: history)");
    expect(help).toContain("DESTRUCTIVE: exact confirmation required");
    expect(help).toContain("--model PROVIDER:CREATOR/MODEL");
    expect(help).toContain("agencity.cli-output v1");
  });

  test("uses ANSI styling without changing the help content", () => {
    const plain = renderCliHelp({ color: false, width: 100 });
    const colored = renderCliHelp({ color: true, width: 100 });

    expect(colored).toMatch(ANSI_PATTERN);
    expect(colored.replace(ANSI_PATTERN, "")).toBe(plain);
  });

  test("enables color only for supported interactive terminals", () => {
    expect(cliHelpColorEnabled(true, {})).toBe(true);
    expect(cliHelpColorEnabled(false, {})).toBe(false);
    expect(cliHelpColorEnabled(true, { NO_COLOR: "" })).toBe(false);
    expect(cliHelpColorEnabled(true, { TERM: "dumb" })).toBe(false);
  });

  test("stacks the trust warning and long command descriptions on narrow terminals", () => {
    const help = renderCliHelp({ color: false, width: 60 });
    expect(help).toContain("TRUSTED LOCAL\nGenerated code has this process's OS authority;");
    expect(help).toContain("agencity reconcile EFFECT_ID ASSESSMENT SUMMARY\n      Append operator evidence");
  });
});

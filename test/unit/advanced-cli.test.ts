import { describe, expect, test } from "bun:test";
import {
  ADVANCED_CLI_COMPATIBILITY,
  ADVANCED_COMMAND_PATHS,
  CLI_HELP_GROUPS,
  LEGACY_ADVANCED_ALIASES,
  LEGACY_CLI_BOOLEAN_OPTIONS,
  LEGACY_CLI_VALUE_OPTIONS,
  buildDataDeleteConfirmation,
  canonicalizeAdvancedArgv,
  parseAdvancedArgv,
  type AdvancedCommandGroup,
  type AdvancedCommandPath,
  type AdvancedSubcommand,
  type DataDeleteScope,
  type LegacyAdvancedAlias,
} from "../../src/cli/advanced.ts";
import { parseCliArgs } from "../../src/cli-args.ts";

const pathParts = (path: AdvancedCommandPath): [AdvancedCommandGroup, AdvancedSubcommand] =>
  path.split(" ") as [AdvancedCommandGroup, AdvancedSubcommand];

describe("advanced CLI command recognition", () => {
  test("recognizes every canonical path and preserves trailing argv exactly", () => {
    expect(ADVANCED_COMMAND_PATHS).toHaveLength(19);
    for (const path of ADVANCED_COMMAND_PATHS) {
      const [group, subcommand] = pathParts(path);
      const trailing = ["--json", "--name=two words", "position one", "--", "literal"];
      const argv = [group, subcommand, ...trailing];
      const before = [...argv];
      expect(parseAdvancedArgv(argv)).toEqual({
        kind: "advanced",
        path,
        group,
        subcommand,
        args: trailing,
        source: "canonical",
        legacyAlias: null,
      });
      expect(argv).toEqual(before);
      expect(canonicalizeAdvancedArgv(argv)).toEqual(argv);
    }
  });

  test("a group is ordinary text unless the immediately following subcommand is recognized", () => {
    const cases: readonly (readonly string[])[] = [
      ["debug"],
      ["debug", "fix", "the", "cell"],
      ["debug", "CELL"],
      ["debug", "--json", "cell"],
      ["sync", "the", "repository"],
      ["sync", "unknown"],
      ["sync", "NOW"],
      ["data"],
      ["data", "remove", "old", "files"],
      ["data", "--", "delete"],
    ];
    for (const args of cases) {
      expect(parseAdvancedArgv(args)).toEqual({ kind: "task", args, escaped: false });
    }
  });

  test("a leading -- unconditionally escapes canonical paths and legacy aliases", () => {
    for (const args of [
      ["--", "debug", "cell", "return 1"],
      ["--", "sync", "status"],
      ["--", "sync"],
      ["--", "delete-data", "--scope", "workspace"],
      ["--"],
    ]) {
      expect(parseAdvancedArgv(args)).toEqual({ kind: "task", args: args.slice(1), escaped: true });
      expect(canonicalizeAdvancedArgv(args)).toEqual(args.slice(1));
    }
  });

  test("maps every compatibility alias silently to exactly one canonical path", () => {
    expect(Object.keys(LEGACY_ADVANCED_ALIASES)).toHaveLength(17);
    for (const [legacyAlias, path] of Object.entries(LEGACY_ADVANCED_ALIASES) as [LegacyAdvancedAlias, AdvancedCommandPath][]) {
      const parsed = parseAdvancedArgv([legacyAlias]);
      const [group, subcommand] = pathParts(path);
      expect(parsed).toEqual({
        kind: "advanced",
        path,
        group,
        subcommand,
        args: [],
        source: "legacy",
        legacyAlias,
      });
      expect(canonicalizeAdvancedArgv([legacyAlias])).toEqual([group, subcommand]);
    }
    expect(ADVANCED_CLI_COMPATIBILITY).toEqual({
      version: 1,
      legacyAliasesAccepted: true,
      deprecationOutput: false,
    });
  });

  test("retains exact aliases for all formerly dispatched command names", () => {
    expect(LEGACY_ADVANCED_ALIASES).toEqual({
      create: "debug session-create",
      chat: "debug turn",
      cell: "debug cell",
      snapshot: "debug snapshot",
      history: "debug history",
      rebuild: "debug rebuild",
      branch: "debug branch",
      tui: "debug tui",
      serve: "debug protocol-serve",
      sync: "sync now",
      "sync-status": "sync status",
      "sync-push": "sync push",
      "sync-pull": "sync pull",
      "sync-checkpoint": "sync checkpoint",
      "sync-stats": "sync stats",
      conflicts: "sync conflicts",
      "delete-data": "data delete",
    });
  });

  test("preserves legacy flags and values byte-for-byte during normalization", () => {
    for (const alias of Object.keys(LEGACY_ADVANCED_ALIASES) as LegacyAdvancedAlias[]) {
      const args = alias === "chat" || alias === "cell"
        ? ["--session=session-1", "--branch", "branch-1", "text", "--json"]
        : ["--state-dir", "relative state", "--workspace=demo", "--json"];
      const parsed = parseAdvancedArgv([alias, ...args]);
      expect(parsed.kind).toBe("advanced");
      if (parsed.kind === "advanced") expect(parsed.args).toEqual(args);
    }
    expect(new Set(LEGACY_CLI_VALUE_OPTIONS)).toEqual(new Set([
      "state-dir", "db", "artifacts", "workspace-root", "workspace", "session", "branch", "cursor",
      "name", "select", "model", "goal", "port", "profile", "sync-url", "replica", "credential-ref",
      "sync-interval", "scope", "scope-id", "confirmation", "receipt-dir", "destination", "requested-by",
    ]));
    expect(new Set(LEGACY_CLI_BOOLEAN_OPTIONS)).toEqual(new Set([
      "help", "version", "new", "demo", "json", "restart-console-after-cell", "exclusive-artifacts",
    ]));
  });

  test("preserves the former alias-versus-natural-language ambiguity rules", () => {
    for (const alias of ["create", "snapshot", "history", "rebuild", "branch", "tui", "serve", "sync-push", "sync-pull", "sync-checkpoint", "sync-stats", "sync-status", "conflicts", "delete-data"] as const) {
      expect(parseAdvancedArgv([alias, "ordinary", "task"]).kind).toBe("task");
      expect(parseAdvancedArgv([alias, "--", "--session", "s"]).kind).toBe("task");
      expect(parseAdvancedArgv([alias, "--unknown"])).toMatchObject({ kind: "advanced", legacyAlias: alias });
    }
    for (const alias of ["chat", "cell"] as const) {
      expect(parseAdvancedArgv([alias, "ordinary", "task"]).kind).toBe("task");
      expect(parseAdvancedArgv([alias, "ordinary", "task", "--session=s"])).toMatchObject({
        kind: "advanced",
        legacyAlias: alias,
      });
      expect(parseAdvancedArgv([alias, "--branch", "b", "ordinary", "task"])).toMatchObject({
        kind: "advanced",
        legacyAlias: alias,
      });
    }
  });

  test("the former --goal value option keeps legacy aliases distinct from ordinary task text", () => {
    const aliases = Object.keys(LEGACY_ADVANCED_ALIASES)
      .filter((alias) => alias !== "chat" && alias !== "cell") as LegacyAdvancedAlias[];
    for (const alias of aliases) {
      const split = parseCliArgs([alias, "--goal", "current"]);
      const inline = parseCliArgs([alias, "--goal=create"]);
      expect(split).toMatchObject({ command: alias, advanced: { source: "legacy", legacyAlias: alias } });
      expect(split.values.get("goal")).toBe("current");
      expect(inline).toMatchObject({ command: alias, advanced: { source: "legacy", legacyAlias: alias } });
      expect(inline.values.get("goal")).toBe("create");

      const task = parseCliArgs([alias, "ordinary", "task", "--goal", "auto"]);
      expect(task).toMatchObject({ command: "product", positionals: [alias, "ordinary", "task"] });
      expect(task.values.get("goal")).toBe("auto");
    }
  });

  test("recognizes the public refine product route without treating its instructions as legacy diagnostics", () => {
    expect(parseCliArgs(["refine"])).toMatchObject({ command: "refine", positionals: [] });
    expect(parseCliArgs(["refine", "review", "the", "retained", "failures", "--json"])).toMatchObject({
      command: "refine",
      positionals: ["review", "the", "retained", "failures"],
    });
    expect(parseCliArgs(["refine", "auto", "on"]).advanced).toBeUndefined();
  });

  test("maps bare and legacy options-only sync to sync now without stealing sync task text", () => {
    for (const args of [
      ["sync"],
      ["sync", "--json"],
      ["sync", "--workspace", "demo", "--sync-url=https://example.invalid"],
    ]) {
      expect(parseAdvancedArgv(args)).toMatchObject({
        kind: "advanced",
        path: "sync now",
        source: "legacy",
        legacyAlias: "sync",
      });
    }
    expect(parseAdvancedArgv(["sync", "everything", "carefully"])).toEqual({
      kind: "task",
      args: ["sync", "everything", "carefully"],
      escaped: false,
    });
    expect(parseAdvancedArgv(["sync", "now"])).toMatchObject({
      kind: "advanced",
      path: "sync now",
      source: "canonical",
      legacyAlias: null,
    });
  });

  test("recognition is deterministic and does not depend on suffix values", () => {
    const tokens = ["", "x", "debug", "sync", "data", "--", "--json", "cell", "delete", "status"];
    for (let index = 0; index < 500; index++) {
      const args = Array.from({ length: index % 6 }, (_, position) => tokens[(index * 17 + position * 7) % tokens.length]!);
      const before = JSON.stringify(args);
      const first = parseAdvancedArgv(args);
      const second = parseAdvancedArgv(args);
      expect(second).toEqual(first);
      expect(JSON.stringify(args)).toBe(before);
      if (first.kind === "advanced" && first.source === "canonical") {
        expect(first.path).toBe(`${args[0]} ${args[1]}` as AdvancedCommandPath);
      }
    }
  });
});

describe("CLI help grouping metadata", () => {
  test("prioritizes product, then diagnostics, sync, and data control", () => {
    expect(CLI_HELP_GROUPS.map((group) => group.id)).toEqual([
      "product", "advanced-diagnostics", "sync", "data-control",
    ]);
    expect(CLI_HELP_GROUPS[0]!.commands[0]!.invocation).toBe("agencity [TASK]");
  });

  test("lists every canonical advanced path exactly once with its compatibility aliases", () => {
    const advancedCommands = CLI_HELP_GROUPS.flatMap((group) => group.commands)
      .filter((command) => command.canonicalPath !== null);
    expect(advancedCommands.map((command) => command.canonicalPath)).toEqual([...ADVANCED_COMMAND_PATHS]);
    expect(new Set(advancedCommands.map((command) => command.canonicalPath)).size).toBe(ADVANCED_COMMAND_PATHS.length);
    for (const [alias, path] of Object.entries(LEGACY_ADVANCED_ALIASES) as [LegacyAdvancedAlias, AdvancedCommandPath][]) {
      expect(advancedCommands.find((command) => command.canonicalPath === path)?.legacyAliases).toContain(alias);
    }
    expect(advancedCommands.filter((command) => command.destructive).map((command) => command.canonicalPath)).toEqual(["data delete"]);
  });
});

describe("guarded data-delete confirmation", () => {
  test.each([
    ["workspace", "workspace-01"],
    ["session", "01HSESSION"],
    ["profile", "profile:device"],
  ] as const)("requires the exact operator phrase for %s", (scopeKind, scopeId) => {
    const phrase = `DELETE ${scopeKind} ${scopeId}`;
    expect(buildDataDeleteConfirmation(scopeKind, scopeId, phrase)).toEqual({
      scopeKind,
      scopeId,
      confirmation: phrase,
    });
  });

  test("does not trim, case-fold, accept force-like text, or synthesize missing confirmation", () => {
    const expected = "DELETE session session-1";
    for (const confirmation of [
      "", "delete session session-1", "DELETE SESSION session-1", ` ${expected}`, `${expected} `,
      `${expected}
`, "yes", "true", "--force", "DELETE session other",
    ]) {
      expect(() => buildDataDeleteConfirmation("session", "session-1", confirmation)).toThrow(expected);
    }
    expect(() => buildDataDeleteConfirmation("session", "session-1", undefined as unknown as string)).toThrow(expected);
  });

  test("rejects malformed scope identities before constructing a request", () => {
    for (const scopeId of ["", " padded", "padded ", "line\nbreak", "nul\0byte"]) {
      expect(() => buildDataDeleteConfirmation("workspace", scopeId, `DELETE workspace ${scopeId}`)).toThrow();
    }
    expect(() => buildDataDeleteConfirmation("all" as DataDeleteScope, "id", "DELETE all id")).toThrow("Unsupported");
  });
});

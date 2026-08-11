/**
 * Pure command recognition for FU-008's advanced CLI surface.
 *
 * This module deliberately does not dispatch commands, read environment state,
 * write output, or emit compatibility warnings. It only decides whether argv is
 * an advanced invocation and, if so, returns its canonical command identity.
 */

export const ADVANCED_COMMAND_TREE = Object.freeze({
  debug: Object.freeze([
    "session-create",
    "turn",
    "cell",
    "snapshot",
    "history",
    "rebuild",
    "branch",
    "tui",
    "protocol-serve",
  ]),
  sync: Object.freeze([
    "status",
    "now",
    "push",
    "pull",
    "checkpoint",
    "stats",
    "conflicts",
    "resolve",
  ]),
  data: Object.freeze(["export", "delete"]),
} as const);

export type AdvancedCommandGroup = keyof typeof ADVANCED_COMMAND_TREE;
export type DebugSubcommand = (typeof ADVANCED_COMMAND_TREE.debug)[number];
export type SyncSubcommand = (typeof ADVANCED_COMMAND_TREE.sync)[number];
export type DataSubcommand = (typeof ADVANCED_COMMAND_TREE.data)[number];
export type AdvancedSubcommand = DebugSubcommand | SyncSubcommand | DataSubcommand;
export type AdvancedCommandPath =
  | `debug ${DebugSubcommand}`
  | `sync ${SyncSubcommand}`
  | `data ${DataSubcommand}`;

export const ADVANCED_COMMAND_PATHS = Object.freeze([
  ...ADVANCED_COMMAND_TREE.debug.map((subcommand) => `debug ${subcommand}` as const),
  ...ADVANCED_COMMAND_TREE.sync.map((subcommand) => `sync ${subcommand}` as const),
  ...ADVANCED_COMMAND_TREE.data.map((subcommand) => `data ${subcommand}` as const),
] as const satisfies readonly AdvancedCommandPath[]);

export type LegacyAdvancedAlias =
  | "create"
  | "chat"
  | "cell"
  | "snapshot"
  | "history"
  | "rebuild"
  | "branch"
  | "tui"
  | "serve"
  | "sync"
  | "sync-status"
  | "sync-push"
  | "sync-pull"
  | "sync-checkpoint"
  | "sync-stats"
  | "conflicts"
  | "delete-data";

/**
 * Compatibility is intentionally silent: callers must not turn an alias into
 * stderr output. Alias provenance is returned for diagnostics and tests only.
 */
export const LEGACY_ADVANCED_ALIASES: Readonly<Record<LegacyAdvancedAlias, AdvancedCommandPath>> = Object.freeze({
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

export const ADVANCED_CLI_COMPATIBILITY = Object.freeze({
  version: 1 as const,
  legacyAliasesAccepted: true as const,
  deprecationOutput: false as const,
});

/** Exact option spellings understood by the compatibility parser today. */
export const LEGACY_CLI_VALUE_OPTIONS = Object.freeze([
  "state-dir",
  "db",
  "artifacts",
  "workspace-root",
  "workspace",
  "session",
  "branch",
  "cursor",
  "name",
  "select",
  "model",
  "goal",
  "port",
  "profile",
  "sync-url",
  "replica",
  "credential-ref",
  "sync-interval",
  "scope",
  "scope-id",
  "confirmation",
  "receipt-dir",
  "destination",
  "requested-by",
  "strategy",
  "from-context",
] as const);

/** Exact boolean option spellings understood by the compatibility parser today. */
export const LEGACY_CLI_BOOLEAN_OPTIONS = Object.freeze([
  "help",
  "version",
  "new",
  "json",
  "restart-console-after-cell",
  "exclusive-artifacts",
] as const);

export interface CanonicalAdvancedInvocation {
  readonly kind: "advanced";
  readonly path: AdvancedCommandPath;
  readonly group: AdvancedCommandGroup;
  readonly subcommand: AdvancedSubcommand;
  /** Arguments after the canonical path or compatibility alias, unchanged. */
  readonly args: readonly string[];
  readonly source: "canonical" | "legacy";
  readonly legacyAlias: LegacyAdvancedAlias | null;
}

export interface OrdinaryTaskInvocation {
  readonly kind: "task";
  /** Task argv with a leading escape marker removed, otherwise unchanged. */
  readonly args: readonly string[];
  readonly escaped: boolean;
}

export type AdvancedArgvResult = CanonicalAdvancedInvocation | OrdinaryTaskInvocation;

const commandGroups = new Set<string>(Object.keys(ADVANCED_COMMAND_TREE));
const legacyAliases = new Set<string>(Object.keys(LEGACY_ADVANCED_ALIASES));
const legacyValueOptions = new Set<string>(LEGACY_CLI_VALUE_OPTIONS);
const legacyTextAliases = new Set<string>(["chat", "cell"]);

/**
 * Recognize advanced argv without consuming ordinary task text.
 *
 * A canonical group is a command only when its immediately following token is
 * a subcommand in that group. Every other group-looking sequence is ordinary
 * task text. A leading `--` always escapes command recognition. The one-token
 * `sync` compatibility alias maps to `sync now`; its existing options-only
 * form is retained as well.
 */
export function parseAdvancedArgv(argv: readonly string[]): AdvancedArgvResult {
  if (argv[0] === "--") return task(argv.slice(1), true);

  const first = argv[0];
  if (first === undefined) return task(argv, false);

  if (commandGroups.has(first)) {
    const second = argv[1];
    if (second !== undefined && isSubcommand(first as AdvancedCommandGroup, second)) {
      return advanced(`${first} ${second}` as AdvancedCommandPath, argv.slice(2), "canonical", null);
    }
    // `sync` was the old spelling for a manual two-way sync. Preserve its bare
    // and options-only forms, but never steal `sync SOMETHING` task text.
    if (first === "sync" && legacyInvocationRequested(first, argv.slice(1))) {
      return advanced("sync now", argv.slice(1), "legacy", "sync");
    }
    return task(argv, false);
  }

  if (legacyAliases.has(first) && legacyInvocationRequested(first, argv.slice(1))) {
    const alias = first as LegacyAdvancedAlias;
    return advanced(LEGACY_ADVANCED_ALIASES[alias], argv.slice(1), "legacy", alias);
  }
  return task(argv, false);
}

/** Alias retained for callers that prefer recognition terminology. */
export const recognizeAdvancedCommand = parseAdvancedArgv;

/** Return canonical grouped argv for dispatch adapters, or task argv unchanged. */
export function canonicalizeAdvancedArgv(argv: readonly string[]): readonly string[] {
  const parsed = parseAdvancedArgv(argv);
  if (parsed.kind === "task") return parsed.args;
  return [...parsed.path.split(" "), ...parsed.args];
}

function advanced(
  path: AdvancedCommandPath,
  args: readonly string[],
  source: CanonicalAdvancedInvocation["source"],
  legacyAlias: LegacyAdvancedAlias | null,
): CanonicalAdvancedInvocation {
  const [group, subcommand] = path.split(" ") as [AdvancedCommandGroup, AdvancedSubcommand];
  return Object.freeze({
    kind: "advanced",
    path,
    group,
    subcommand,
    args: Object.freeze([...args]),
    source,
    legacyAlias,
  });
}

function task(args: readonly string[], escaped: boolean): OrdinaryTaskInvocation {
  return Object.freeze({ kind: "task", args: Object.freeze([...args]), escaped });
}

function isSubcommand(group: AdvancedCommandGroup, candidate: string): boolean {
  return (ADVANCED_COMMAND_TREE[group] as readonly string[]).includes(candidate);
}

/** Preserve the pre-FU-008 alias/task ambiguity contract exactly. */
function legacyInvocationRequested(command: string, rest: readonly string[]): boolean {
  if (rest.length === 0) return true;
  if (legacyTextAliases.has(command)) {
    return rest.some((argument) =>
      argument === "--session" || argument.startsWith("--session=") ||
      argument === "--branch" || argument.startsWith("--branch="));
  }
  let positionalOnly = false;
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index]!;
    if (positionalOnly) return false;
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!argument.startsWith("--")) return false;
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals < 0 ? undefined : equals);
    if (equals < 0 && legacyValueOptions.has(name)) index++;
  }
  return !positionalOnly;
}

export type HelpGroupId = "product" | "advanced-diagnostics" | "sync" | "data-control";

export interface CliHelpCommand {
  readonly invocation: string;
  readonly summary: string;
  readonly canonicalPath: AdvancedCommandPath | null;
  readonly legacyAliases: readonly LegacyAdvancedAlias[];
  readonly destructive: boolean;
}

export interface CliHelpGroup {
  readonly id: HelpGroupId;
  readonly title: string;
  readonly description: string;
  readonly commands: readonly CliHelpCommand[];
}

const productHelp = (invocation: string, summary: string): CliHelpCommand => Object.freeze({
  invocation,
  summary,
  canonicalPath: null,
  legacyAliases: Object.freeze([]) as readonly LegacyAdvancedAlias[],
  destructive: false,
});

const advancedHelp = (
  path: AdvancedCommandPath,
  summary: string,
  destructive = false,
): CliHelpCommand => Object.freeze({
  invocation: `agencity ${path}`,
  summary,
  canonicalPath: path,
  legacyAliases: Object.freeze(
    (Object.entries(LEGACY_ADVANCED_ALIASES) as [LegacyAdvancedAlias, AdvancedCommandPath][])
      .filter(([, target]) => target === path)
      .map(([alias]) => alias),
  ),
  destructive,
});

/** Ordered metadata: ordinary product use is always shown before advanced work. */
export const CLI_HELP_GROUPS: readonly CliHelpGroup[] = Object.freeze([
  Object.freeze({
    id: "product",
    title: "Product commands",
    description: "Start, resume, inspect, and configure ordinary agent work without internal IDs.",
    commands: Object.freeze([
      productHelp("agencity [TASK]", "Create or resume work and optionally start TASK."),
      productHelp("agencity new [TASK]", "Create a distinct root session."),
      productHelp("agencity resume [NAME|ID]", "Resume durable work."),
      productHelp("agencity sessions", "List and select named sessions and branches."),
      productHelp("agencity run TASK", "Run a task and exit at a typed terminal outcome."),
      productHelp("agencity branch head [NAME]", "Fork the selected branch at its current committed head without an internal cursor."),
      productHelp("agencity history current", "Inspect retained messages, cells, effects, and runs for the selected branch."),
      productHelp("agencity tree", "Inspect the retained workspace agent tree."),
      productHelp("agencity attach [NAME|ID]", "Open the protocol-backed terminal client."),
      productHelp("agencity unknown [EFFECT_ID]", "Inspect unknown external effects without retrying them."),
      productHelp("agencity reconcile EFFECT_ID ASSESSMENT SUMMARY", "Append operator evidence without rewriting effect status."),
      productHelp("agencity profile [show|history|proposals|propose|repropose|rollback]", "Inspect and explicitly govern the selected agent's behavioral profile without copying internal target IDs."),
      productHelp("agencity refine [status|history|inspect ID|pause|resume|rollback PROPOSAL REASON|--wait ...]", "Inspect automatic learning, control future admission, reverse one applied automatic change, or start a detached attributable reflection."),
      productHelp("agencity skills [list|show|install|propose|test|enable|disable|remove]", "Manage tested workspace and profile skills; local code installation requires an exact digest confirmation."),
      productHelp("agencity context", "Inspect effective context, capacity, and compaction provenance."),
      productHelp("agencity compact [GUIDANCE] [--strategy extractive|summary]", "Compact retained narrative without deleting canonical history."),
      productHelp("agencity doctor", "Check providers, recovery, placement, and sync."),
      productHelp("agencity config", "Manage non-secret preferences and credential references."),
    ]),
  }),
  Object.freeze({
    id: "advanced-diagnostics",
    title: "Advanced diagnostics",
    description: "Low-level retained session, cell, projection, branch, TUI, and protocol operations.",
    commands: Object.freeze([
      advancedHelp("debug session-create", "Create a low-level durable session."),
      advancedHelp("debug turn", "Append user text and execute one model turn."),
      advancedHelp("debug cell", "Execute one TypeScript cell."),
      advancedHelp("debug snapshot", "Read a materialized snapshot."),
      advancedHelp("debug history", "Read canonical event history."),
      advancedHelp("debug rebuild", "Rebuild and inspect a projection."),
      advancedHelp("debug branch", "Fork a branch at a committed cursor."),
      advancedHelp("debug tui", "Attach the diagnostic terminal UI by ID."),
      advancedHelp("debug protocol-serve", "Serve the trusted-local loopback protocol."),
    ]),
  }),
  Object.freeze({
    id: "sync",
    title: "Sync",
    description: "Inspect and explicitly advance optional workspace synchronization.",
    commands: Object.freeze([
      advancedHelp("sync status", "Inspect lifecycle and capability status."),
      advancedHelp("sync now", "Run the normal pull/push sync cycle now."),
      advancedHelp("sync push", "Push pending immutable envelopes."),
      advancedHelp("sync pull", "Pull and reconcile immutable envelopes."),
      advancedHelp("sync checkpoint", "Checkpoint the replica when supported."),
      advancedHelp("sync stats", "Inspect replica statistics."),
      advancedHelp("sync conflicts", "List retained synchronization conflicts."),
      advancedHelp("sync resolve", "Resolve a retained conflict explicitly."),
    ]),
  }),
  Object.freeze({
    id: "data-control",
    title: "Data control",
    description: "Export owned data or perform guarded destructive erasure.",
    commands: Object.freeze([
      advancedHelp("data export", "Export an owned scope without mutating it."),
      advancedHelp("data delete", "Delete an owned scope after exact confirmation.", true),
    ]),
  }),
]);

export type DataDeleteScope = "workspace" | "session" | "profile";

export interface ConfirmedDataDelete {
  readonly scopeKind: DataDeleteScope;
  readonly scopeId: string;
  /** The exact operator-supplied phrase; never synthesized by this builder. */
  readonly confirmation: string;
}

/**
 * Admit a destructive deletion only after an exact, operator-supplied phrase.
 * The phrase is neither trimmed nor case-folded, and there is no force/bypass
 * input. Runtime ownership, quiescence, receipt, and capability guards remain
 * additional requirements; this helper cannot replace or relax them.
 */
export function buildDataDeleteConfirmation(
  scopeKind: DataDeleteScope,
  scopeId: string,
  operatorConfirmation: string,
): ConfirmedDataDelete {
  if (scopeKind !== "workspace" && scopeKind !== "session" && scopeKind !== "profile") {
    throw new Error(`Unsupported data-delete scope: ${String(scopeKind)}`);
  }
  if (scopeId.length === 0 || scopeId.trim() !== scopeId || /[\r\n\0]/.test(scopeId)) {
    throw new Error("Data-delete scope ID must be non-empty, unpadded, and single-line");
  }
  const expected = `DELETE ${scopeKind} ${scopeId}`;
  if (operatorConfirmation !== expected) {
    throw new Error(`Data deletion requires exact confirmation: ${expected}`);
  }
  return Object.freeze({ scopeKind, scopeId, confirmation: operatorConfirmation });
}

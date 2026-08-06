import {
  ADVANCED_COMMAND_PATHS,
  parseAdvancedArgv,
  type CanonicalAdvancedInvocation,
  type LegacyAdvancedAlias,
} from "./cli/advanced.ts";

export const PRODUCT_CLI_COMMANDS = [
  "product", "help", "version", "new", "resume", "sessions", "run", "branch", "history", "tree", "goals", "heartbeats", "schedules",
  "doctor", "config", "service", "agents", "status", "attach", "send", "stop", "unknown", "reconcile", "refine", "skills", "context", "compact",
] as const;
export const LEGACY_CLI_COMMANDS = [
  "create", "chat", "cell", "snapshot", "history", "rebuild", "branch", "tui", "serve",
  "sync", "sync-push", "sync-pull", "sync-checkpoint", "sync-stats", "sync-status", "conflicts", "delete-data",
] as const satisfies readonly LegacyAdvancedAlias[];
export const CLI_COMMANDS = [...PRODUCT_CLI_COMMANDS, ...LEGACY_CLI_COMMANDS, ...ADVANCED_COMMAND_PATHS] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];

const PRODUCT_ROUTE_COMMANDS = new Set<string>(PRODUCT_CLI_COMMANDS.filter((item) => item !== "product"));
const VALUE_OPTIONS = new Set([
  "state-dir", "db", "artifacts", "workspace-root", "workspace",
  "session", "branch", "cursor", "name", "select", "model", "goal", "port", "profile", "sync-url", "replica", "credential-ref", "sync-interval",
  "scope", "scope-id", "confirmation", "receipt-dir", "destination", "requested-by", "reconciliation-id", "evidence", "strategy", "from-context", "completion-gate",
]);
const BOOLEAN_OPTIONS = new Set([
  "help", "version", "new", "demo", "json", "detach", "restart-console-after-cell", "exclusive-artifacts",
]);

export interface ParsedCliArgs {
  readonly command: CliCommand;
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly positionals: readonly string[];
  /** Canonical identity and alias provenance for grouped advanced dispatch. */
  readonly advanced?: CanonicalAdvancedInvocation;
}

/** Parses product-first argv plus canonical grouped and exact legacy advanced aliases. */
export function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  const recognized = parseAdvancedArgv(args);
  if (recognized.kind === "advanced") {
    const command = (recognized.source === "legacy" ? recognized.legacyAlias! : recognized.path) as CliCommand;
    return parseOptions(command, recognized.args, recognized);
  }
  if (recognized.escaped) {
    return { command: "product", values: new Map(), flags: new Set(), positionals: recognized.args };
  }

  const argv = recognized.args;
  const first = argv[0];
  const productShape = first === "history" ? argv[1] === "current" : first === "branch" ? argv[1] === "head" : true;
  const hasCommand = first !== undefined && !first.startsWith("--") && PRODUCT_ROUTE_COMMANDS.has(first) && productShape;
  const command: CliCommand = hasCommand ? first as CliCommand : "product";
  return parseOptions(command, argv.slice(hasCommand ? 1 : 0));
}

function parseOptions(
  initialCommand: CliCommand,
  args: readonly string[],
  advanced?: CanonicalAdvancedInvocation,
): ParsedCliArgs {
  let command = initialCommand;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  let positionalOnly = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (positionalOnly) { positionals.push(argument); continue; }
    if (argument === "--") { positionalOnly = true; continue; }
    if (!argument.startsWith("--")) { positionals.push(argument); continue; }

    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals < 0 ? undefined : equals);
    const inline = equals < 0 ? undefined : argument.slice(equals + 1);
    if (BOOLEAN_OPTIONS.has(name)) {
      if (inline !== undefined) throw new Error(`--${name} does not accept a value`);
      flags.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    if (values.has(name)) throw new Error(`Duplicate option: --${name}`);
    const value = inline ?? args[++index];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new Error(`--${name} requires a value`);
    values.set(name, value);
  }
  if (flags.has("help")) command = "help";
  else if (flags.has("version")) command = "version";
  return { command, values, flags, positionals, ...(advanced === undefined ? {} : { advanced }) };
}

export const CLI_COMMANDS = [
  "product", "help", "version", "new", "resume", "sessions", "run", "goals", "heartbeats", "schedules", "doctor", "config", "service", "agents", "status", "attach", "send", "stop",
  "create", "chat", "cell", "snapshot", "history", "rebuild", "branch", "tui", "serve",
  "sync", "sync-push", "sync-pull", "sync-checkpoint", "sync-stats", "sync-status", "conflicts", "delete-data",
] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];

const KNOWN_COMMANDS = new Set<string>(CLI_COMMANDS);
const PRODUCT_ROUTE_COMMANDS = new Set<string>(["help", "version", "new", "resume", "sessions", "run", "goals", "heartbeats", "schedules", "doctor", "config", "service", "agents", "status", "attach", "send", "stop"]);
const LEGACY_TEXT_COMMANDS = new Set<string>(["chat", "cell"]);
const VALUE_OPTIONS = new Set([
  "state-dir", "db", "artifacts", "workspace-root", "workspace",
  "session", "branch", "cursor", "name", "select", "model", "goal", "port", "profile", "sync-url", "replica", "credential-ref", "sync-interval",
  "scope", "scope-id", "confirmation", "receipt-dir",
]);
const BOOLEAN_OPTIONS = new Set([
  "help", "version", "new", "demo", "json", "detach", "restart-console-after-cell", "exclusive-artifacts",
]);

export interface ParsedCliArgs {
  readonly command: CliCommand;
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

/** Parses both the product-first `agencity [TASK]` route and retained diagnostic commands. */
export function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  const first = args[0];
  const exactCommand = first !== undefined && !first.startsWith("--") && KNOWN_COMMANDS.has(first) && first !== "product";
  const hasCommand = exactCommand && (PRODUCT_ROUTE_COMMANDS.has(first!) || legacyInvocationRequested(first!, args.slice(1)));
  let command: CliCommand = hasCommand ? first as CliCommand : "product";
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  let positionalOnly = false;
  for (let index = hasCommand ? 1 : 0; index < args.length; index++) {
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
  return { command, values, flags, positionals };
}

/**
 * Direct legacy commands remain available, but command-like natural-language
 * tasks are not silently consumed. `chat` and `cell` are legacy only when an
 * ID option is present; other legacy words followed by positional text are a
 * product task. A quoted multi-word first argument never equals a command, and
 * `--` remains the explicit escape for every ambiguous spelling.
 */
function legacyInvocationRequested(command: string, rest: readonly string[]): boolean {
  if (rest.length === 0) return true;
  if (LEGACY_TEXT_COMMANDS.has(command)) {
    return rest.some(argument => argument === "--session" || argument.startsWith("--session=") || argument === "--branch" || argument.startsWith("--branch="));
  }
  let positionalOnly = false;
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index]!;
    if (positionalOnly) return false;
    if (argument === "--") { positionalOnly = true; continue; }
    if (!argument.startsWith("--")) return false;
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals < 0 ? undefined : equals);
    if (equals < 0 && VALUE_OPTIONS.has(name)) index++;
  }
  return !positionalOnly;
}

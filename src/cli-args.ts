export const CLI_COMMANDS = [
  "help", "create", "chat", "cell", "snapshot", "history", "rebuild", "branch", "tui", "serve",
] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];

const VALUE_OPTIONS = new Set([
  "state-dir", "db", "artifacts", "workspace-root", "workspace",
  "session", "branch", "cursor", "name", "port",
]);
const BOOLEAN_OPTIONS = new Set(["help", "restart-console-after-cell"]);

export interface ParsedCliArgs {
  readonly command: CliCommand;
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

/** Parses command options without consuming a positional after boolean flags. */
export function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  const first = args[0];
  const command = first && !first.startsWith("--") ? first : "help";
  if (!CLI_COMMANDS.includes(command as CliCommand)) throw new Error(`Unknown command: ${command}`);

  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  let positionalOnly = false;
  for (let index = first && !first.startsWith("--") ? 1 : 0; index < args.length; index++) {
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
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      throw new Error(`--${name} requires a value`);
    }
    values.set(name, value);
  }
  if (flags.has("help")) return { command: "help", values, flags, positionals };
  return { command: command as CliCommand, values, flags, positionals };
}

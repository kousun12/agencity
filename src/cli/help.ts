import { CLI_HELP_GROUPS, type CliHelpCommand } from "./advanced.ts";

const ANSI = Object.freeze({
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
});

interface HelpRenderOptions {
  readonly color: boolean;
  readonly width: number;
}

interface HelpRow {
  readonly label: string;
  readonly description: string;
  readonly labelTone?: "command" | "option";
  readonly legacyAliases?: readonly string[];
  readonly destructive?: boolean;
}

const COMMON_OPTIONS: readonly HelpRow[] = Object.freeze([
  { label: "--workspace PATH", description: "Use a specific workspace path.", labelTone: "option" },
  { label: "--model PROVIDER:CREATOR/MODEL", description: "Select the provider and model explicitly.", labelTone: "option" },
  { label: "--effort LEVEL", description: "Set reasoning effort: default, none, minimal, low, medium, high, or xhigh.", labelTone: "option" },
  { label: "--new", description: "Create a distinct root session.", labelTone: "option" },
  { label: "--detach", description: "Leave an admitted run working in the managed service.", labelTone: "option" },
  { label: "--completion-gate COMMAND", description: "Require COMMAND to pass before successful completion.", labelTone: "option" },
  { label: "--json", description: "Emit machine-readable output when the command supports it.", labelTone: "option" },
  { label: "--version", description: "Show version information.", labelTone: "option" },
  { label: "--help", description: "Show this help.", labelTone: "option" },
]);

const ADVANCED_OPTIONS: readonly HelpRow[] = Object.freeze([
  { label: "--session ID  --branch ID  --cursor N", description: "Address retained diagnostic state.", labelTone: "option" },
  { label: "--db PATH  --artifacts PATH  --workspace-root PATH", description: "Override low-level local storage paths.", labelTone: "option" },
  { label: "--console-rss-recycle-bytes N", description: "Recycle a console worker after its reported RSS exceeds N bytes.", labelTone: "option" },
  { label: "--sync-url URL  --replica PATH", description: "Configure optional synchronization.", labelTone: "option" },
  { label: "--scope KIND  --scope-id ID  --destination PATH", description: "Select an owned data scope and export destination.", labelTone: "option" },
  { label: "--confirmation 'DELETE <scope> <id>'", description: "Provide exact confirmation for guarded deletion.", labelTone: "option" },
  { label: "--receipt-dir PATH  --requested-by ID", description: "Configure deletion receipts and operator identity.", labelTone: "option" },
  { label: "--reconciliation-id ID  --evidence JSON", description: "Attach identity and evidence to effect reconciliation.", labelTone: "option" },
]);

export interface CliHelpRenderOptions {
  readonly color?: boolean;
  readonly width?: number;
}

/** Colors human help only when stdout is an interactive terminal that permits it. */
export function cliHelpColorEnabled(
  isTTY = process.stdout.isTTY === true,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return isTTY && environment.NO_COLOR === undefined && environment.TERM !== "dumb";
}

/** Render the full product-first help page without performing I/O. */
export function renderCliHelp(options: CliHelpRenderOptions = {}): string {
  const renderOptions: HelpRenderOptions = {
    color: options.color ?? false,
    width: Math.max(48, Math.min(112, Math.floor(options.width ?? 100))),
  };
  const lines: string[] = [
    paint("Agencity", `${ANSI.bold}${ANSI.cyan}`, renderOptions),
    paint("Terminal-first durable agent runtime", ANSI.dim, renderOptions),
    ...renderTrustBoundary(renderOptions),
    "",
    heading("Usage", renderOptions),
    ...renderRows([
      { label: "agencity [TASK]", description: "Create or resume work, then optionally start TASK.", labelTone: "command" },
      { label: "agencity <COMMAND> [OPTIONS]", description: "Run a product or diagnostic command.", labelTone: "command" },
    ], renderOptions),
    "",
    heading("Examples", renderOptions),
    ...renderExamples([
      ['agencity "find and fix the flaky test"', "Start ordinary agent work."],
      ["agencity", "Resume the selected branch and open the terminal client."],
      ['agencity run "update dependencies" --completion-gate "bun test"', "Run to a typed terminal outcome."],
    ], renderOptions),
  ];

  for (const group of CLI_HELP_GROUPS) {
    lines.push(
      "",
      heading(group.title, renderOptions),
      ...wrapWords(group.description, renderOptions.width - 2)
        .map((line) => paint(`  ${line}`, ANSI.dim, renderOptions)),
      ...renderRows(group.commands.map(commandRow), renderOptions),
    );
  }

  lines.push(
    "",
    heading("Common options", renderOptions),
    ...renderRows(COMMON_OPTIONS, renderOptions),
    "",
    heading("Advanced options", renderOptions),
    ...renderRows(ADVANCED_OPTIONS, renderOptions),
    "",
    heading("Notes", renderOptions),
    ...renderBullets([
      "Use `agencity -- TASK` to send command-like text through the product route.",
      "Interactive startup guides provider setup. Credentials remain supervisor-side.",
      "Canonical advanced `--json` output uses the stable `agencity.cli-output` v1 envelope.",
      "Legacy aliases remain silent and preserve their historical output during the compatibility window.",
    ], renderOptions),
  );

  return lines.join("\n");
}

function commandRow(command: CliHelpCommand): HelpRow {
  return {
    label: command.invocation,
    description: command.summary,
    labelTone: "command",
    legacyAliases: command.legacyAliases,
    destructive: command.destructive,
  };
}

function renderRows(rows: readonly HelpRow[], options: HelpRenderOptions): string[] {
  const labels = rows.map((row) => row.label.length);
  const labelWidth = Math.min(Math.max(...labels, 0), options.width >= 92 ? 42 : 32);
  const inlineDescriptionWidth = options.width - 2 - labelWidth - 3;
  const canUseColumns = inlineDescriptionWidth >= 28;
  const lines: string[] = [];

  for (const row of rows) {
    const styledLabel = paint(row.label, row.labelTone === "command" ? ANSI.cyan : ANSI.yellow, options);
    const description = row.legacyAliases?.length
      ? `${row.description} (legacy: ${row.legacyAliases.join(", ")})`
      : row.description;
    if (canUseColumns && row.label.length <= labelWidth) {
      const descriptionLines = wrapWords(description, inlineDescriptionWidth);
      lines.push(`  ${styledLabel}${" ".repeat(labelWidth - row.label.length)}   ${descriptionLines[0] ?? ""}`);
      const continuationIndent = " ".repeat(2 + labelWidth + 3);
      lines.push(...descriptionLines.slice(1).map((line) => `${continuationIndent}${line}`));
    } else {
      lines.push(`  ${styledLabel}`);
      lines.push(...wrapWords(description, options.width - 6).map((line) => `      ${line}`));
    }
    if (row.destructive) {
      lines.push(paint("      DESTRUCTIVE: exact confirmation required", `${ANSI.bold}${ANSI.red}`, options));
    }
  }
  return lines;
}

function renderTrustBoundary(options: HelpRenderOptions): string[] {
  const badge = "TRUSTED LOCAL";
  const explanation = "Generated code has this process's OS authority; it is not sandboxed.";
  if (badge.length + 2 + explanation.length <= options.width) {
    return [`${paint(badge, `${ANSI.bold}${ANSI.yellow}`, options)}  ${explanation}`];
  }
  return [
    paint(badge, `${ANSI.bold}${ANSI.yellow}`, options),
    ...wrapWords(explanation, options.width).map((line) => paint(line, ANSI.dim, options)),
  ];
}

function renderExamples(examples: readonly (readonly [string, string])[], options: HelpRenderOptions): string[] {
  const lines: string[] = [];
  for (const [command, description] of examples) {
    lines.push(`  ${paint("$", ANSI.dim, options)} ${paint(command, ANSI.cyan, options)}`);
    lines.push(...wrapWords(description, options.width - 6).map((line) => paint(`      ${line}`, ANSI.dim, options)));
  }
  return lines;
}

function renderBullets(items: readonly string[], options: HelpRenderOptions): string[] {
  return items.flatMap((item) => {
    const wrapped = wrapWords(item, options.width - 6);
    return wrapped.map((line, index) => `${index === 0 ? "  • " : "    "}${paintInlineCode(line, options)}`);
  });
}

function heading(value: string, options: HelpRenderOptions): string {
  return paint(value, ANSI.bold, options);
}

function paint(value: string, code: string, options: HelpRenderOptions): string {
  return options.color ? `${code}${value}${ANSI.reset}` : value;
}

function paintInlineCode(value: string, options: HelpRenderOptions): string {
  if (!options.color) return value.replaceAll("`", "");
  return value.replace(/`([^`]+)`/g, (_, code: string) => `${ANSI.cyan}${code}${ANSI.reset}`);
}

function wrapWords(value: string, width: number): string[] {
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

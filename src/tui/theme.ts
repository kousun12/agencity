import { SyntaxStyle } from "@opentui/core";
import type { AgentRunState } from "../domain/index.ts";
import type { FamilyAgentActivity } from "../runtime/index.ts";

export const TERMINAL_THEME = {
  background: "#0d1117",
  raised: "#151b23",
  border: "#30363d",
  text: "#e6edf3",
  muted: "#8b949e",
  accent: "#58a6ff",
  success: "#3fb950",
  warning: "#d29922",
  danger: "#f85149",
  provisional: "#a371f7",
  codeBackground: "#11161d",
  selectionBackground: "#264f78",
  keyword: "#79c0ff",
  string: "#7ee787",
  number: "#e3b341",
  type: "#ffa657",
  function: "#56d4dd",
  comment: "#6e7681",
  operator: "#ff7b72",
  punctuation: "#c9d1d9",
} as const;

export type TerminalTone = "normal" | "accent" | "success" | "warning" | "danger" | "muted" | "provisional";

export type TerminalCellStatus =
  | "pending"
  | "proposed"
  | "running"
  | "committed"
  | "failed"
  | "abandoned"
  | "missing";

const RUN_TONES: Readonly<Record<AgentRunState["status"], TerminalTone>> = {
  queued: "accent",
  running: "accent",
  succeeded: "success",
  blocked: "danger",
  failed: "danger",
  cancelled: "muted",
  budget_exceeded: "warning",
  unknown: "danger",
};

const CELL_TONES: Readonly<Record<TerminalCellStatus, TerminalTone>> = {
  pending: "muted",
  proposed: "accent",
  running: "accent",
  committed: "success",
  failed: "danger",
  abandoned: "muted",
  missing: "danger",
};

const FAMILY_TONES: Readonly<Record<FamilyAgentActivity, TerminalTone>> = {
  working: "accent",
  idle: "muted",
  attention: "danger",
  ended: "muted",
  unavailable: "danger",
};

export function terminalRunTone(status: AgentRunState["status"]): TerminalTone {
  return RUN_TONES[status];
}

export function terminalCellTone(status: TerminalCellStatus): TerminalTone {
  return CELL_TONES[status];
}

export function terminalFamilyTone(activity: FamilyAgentActivity): TerminalTone {
  return FAMILY_TONES[activity];
}

export function terminalToneColor(tone: TerminalTone): string {
  switch (tone) {
    case "accent": return TERMINAL_THEME.accent;
    case "success": return TERMINAL_THEME.success;
    case "warning": return TERMINAL_THEME.warning;
    case "danger": return TERMINAL_THEME.danger;
    case "muted": return TERMINAL_THEME.muted;
    case "provisional": return TERMINAL_THEME.provisional;
    case "normal": return TERMINAL_THEME.text;
  }
}

export function createTerminalSyntaxStyle(): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: TERMINAL_THEME.text },
    keyword: { fg: TERMINAL_THEME.keyword, bold: true },
    "keyword.import": { fg: TERMINAL_THEME.keyword, bold: true },
    "keyword.operator": { fg: TERMINAL_THEME.operator },
    function: { fg: TERMINAL_THEME.function },
    method: { fg: TERMINAL_THEME.function },
    constructor: { fg: TERMINAL_THEME.type },
    type: { fg: TERMINAL_THEME.type },
    string: { fg: TERMINAL_THEME.string },
    number: { fg: TERMINAL_THEME.number },
    boolean: { fg: TERMINAL_THEME.number },
    constant: { fg: TERMINAL_THEME.number },
    comment: { fg: TERMINAL_THEME.comment, italic: true },
    variable: { fg: TERMINAL_THEME.text },
    property: { fg: TERMINAL_THEME.keyword },
    operator: { fg: TERMINAL_THEME.operator },
    punctuation: { fg: TERMINAL_THEME.punctuation },
    "punctuation.bracket": { fg: TERMINAL_THEME.punctuation },
    "punctuation.delimiter": { fg: TERMINAL_THEME.punctuation },
    "punctuation.special": { fg: TERMINAL_THEME.muted },
    "markup.heading": { fg: TERMINAL_THEME.accent, bold: true },
    "markup.heading.1": { fg: TERMINAL_THEME.function, bold: true },
    "markup.heading.2": { fg: TERMINAL_THEME.accent, bold: true },
    "markup.bold": { fg: TERMINAL_THEME.text, bold: true },
    "markup.strong": { fg: TERMINAL_THEME.text, bold: true },
    "markup.italic": { fg: TERMINAL_THEME.muted, italic: true },
    "markup.list": { fg: TERMINAL_THEME.accent },
    "markup.quote": { fg: TERMINAL_THEME.muted, italic: true },
    "markup.raw": { fg: TERMINAL_THEME.warning, bg: TERMINAL_THEME.codeBackground },
    "markup.raw.block": { fg: TERMINAL_THEME.text, bg: TERMINAL_THEME.codeBackground },
    "markup.raw.inline": { fg: TERMINAL_THEME.warning, bg: TERMINAL_THEME.codeBackground },
    "markup.link": { fg: TERMINAL_THEME.accent, underline: true },
    "markup.link.label": { fg: TERMINAL_THEME.accent, underline: true },
    "markup.link.url": { fg: TERMINAL_THEME.accent, underline: true },
    conceal: { fg: TERMINAL_THEME.muted },
  });
}

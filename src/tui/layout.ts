import type { TerminalConnectionState } from "./view-model.ts";

export type TerminalHeightMode = "normal" | "compact" | "minimum";

export interface TerminalHeightLayout {
  readonly mode: TerminalHeightMode;
  readonly headerRows: 1 | 2;
  readonly composerRows: 1 | 2 | 3;
  readonly composerPaddingTop: 0 | 1;
  readonly composerPaddingBottom: 0 | 1;
  readonly showFamilySummary: boolean;
  readonly inspectorPadding: 0 | 1;
}

export interface TerminalFooterInput {
  readonly width: number;
  readonly trustLabel: "TRUSTED-LOCAL";
  readonly connection: TerminalConnectionState;
  readonly attentionCount: number;
  readonly recoveryLabel: string;
  readonly budgetLabel: string;
  readonly activeActionHint: string;
  readonly familyHint: string;
}

export interface TerminalFooterLayout {
  readonly left: string;
  readonly right: string;
}

export function selectTerminalHeightLayout(height: number): TerminalHeightLayout {
  if (height >= 12) {
    return {
      mode: "normal",
      headerRows: 2,
      composerRows: 3,
      composerPaddingTop: 1,
      composerPaddingBottom: 1,
      showFamilySummary: true,
      inspectorPadding: 1,
    };
  }
  if (height >= 7) {
    return {
      mode: "compact",
      headerRows: 1,
      composerRows: 2,
      composerPaddingTop: 0,
      composerPaddingBottom: 1,
      showFamilySummary: true,
      inspectorPadding: 0,
    };
  }
  return {
    mode: "minimum",
    headerRows: 1,
    composerRows: 1,
    composerPaddingTop: 0,
    composerPaddingBottom: 0,
    showFamilySummary: false,
    inspectorPadding: 0,
  };
}

export function terminalComposerPaddingX(width: number): 0 | 1 | 2 {
  if (width >= 40) return 2;
  if (width >= 8) return 1;
  return 0;
}

function joined(segments: readonly string[]): string {
  return segments.filter(Boolean).join(" · ");
}

function totalWidth(left: string, right: string): number {
  return left.length + (left && right ? 1 : 0) + right.length;
}

function truncate(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  if (value.length <= maximum) return value;
  return maximum === 1 ? "…" : `${value.slice(0, maximum - 1)}…`;
}

export function layoutTerminalFooter(input: TerminalFooterInput): TerminalFooterLayout {
  const width = Math.max(1, input.width);
  const mandatoryLeft = [
    input.trustLabel,
    input.connection === "connected" ? "" : input.connection,
    input.attentionCount > 0 ? `${input.attentionCount} attention` : "",
  ].filter(Boolean);
  const recoveryLeft = input.recoveryLabel === "recovery healthy" ? [] : [input.recoveryLabel];
  const optionalLeft = [input.budgetLabel].filter(Boolean);
  const rightSegments = [
    input.activeActionHint,
    input.familyHint && input.familyHint !== input.activeActionHint ? input.familyHint : "",
    "Ctrl-P commands",
  ].filter(Boolean);

  let left = joined([...mandatoryLeft, ...recoveryLeft, ...optionalLeft]);
  let right = joined(rightSegments);
  if (totalWidth(left, right) <= width) return { left, right };

  left = joined([...mandatoryLeft, ...recoveryLeft]);
  if (totalWidth(left, right) <= width) return { left, right };

  const withoutCommands = rightSegments.filter(segment => segment !== "Ctrl-P commands");
  right = joined(withoutCommands);
  if (totalWidth(left, right) <= width) return { left, right };

  const primaryAction = input.activeActionHint || input.familyHint;
  right = primaryAction;
  if (totalWidth(left, right) <= width) return { left, right };

  left = joined(mandatoryLeft);
  if (totalWidth(left, right) <= width) return { left, right };

  const availableRight = Math.max(0, width - left.length - (left && primaryAction ? 1 : 0));
  right = truncate(primaryAction, availableRight);
  if (totalWidth(left, right) <= width) return { left, right };

  const compactRequired = [
    input.trustLabel,
    input.connection === "connected" ? "" : input.connection.toUpperCase(),
    input.attentionCount > 0 ? `!${input.attentionCount}` : "",
    input.recoveryLabel === "recovery healthy" ? "" : "RECOVERY!",
  ].filter(Boolean);
  left = joined(compactRequired);
  const compactAvailableRight = Math.max(0, width - left.length - (left && primaryAction ? 1 : 0));
  right = truncate(primaryAction, compactAvailableRight);
  if (totalWidth(left, right) <= width) return { left, right };

  left = truncate(input.trustLabel, width);
  return { left, right: "" };
}

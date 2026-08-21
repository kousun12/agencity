import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  createCliRenderer,
  bg,
  bold,
  dim,
  fg,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  TextareaRenderable,
  type KeyEvent,
  type PasteEvent,
  type TextChunk,
  decodePasteBytes,
} from "@opentui/core";
import { stdin, stdout } from "node:process";
import {
  boundModelSelectionQuery,
  fitTerminalLine,
  navigateSelectedIdentity,
  rankModelOptions,
  reconcileSelectedIdentity,
  sanitizeTerminalLine,
  visibleSelectionWindow,
  type ModelSelectionOption,
} from "../product/model-selection.ts";
import { scrubText } from "../security/index.ts";
import {
  TERMINAL_COMMAND_REGISTRY,
  TerminalUI,
  renderTerminalError,
  type InterruptDecision,
  type TerminalAgentClient,
} from "./index.ts";
import {
  buildTerminalScreen,
  formatTerminalBreadcrumb,
  formatTerminalFamilySummary,
  formatTerminalWorkspaceAgentRow,
  type TerminalFamilyChildView,
  type TerminalFamilyRefreshState,
  type TerminalLearningDockView,
  type TerminalPresentation,
  type TerminalScreenView,
} from "./view-model.ts";
import { TerminalTranscript } from "./transcript.ts";
import {
  TERMINAL_THEME,
  createTerminalSyntaxStyle,
  terminalFamilyTone,
  terminalToneColor,
} from "./theme.ts";
import {
  layoutTerminalFooter,
  selectTerminalHeightLayout,
  terminalComposerContentRows,
  terminalComposerPaddingX,
} from "./layout.ts";
import {
  formatTerminalDetail,
  terminalCatalogAgentToolState,
  type TerminalDetail,
  type TerminalEffortDetail,
  type TerminalModelDetail,
  type TerminalModelProviderDetail,
} from "./detail-model.ts";

export interface OpenTerminalUIOptions {
  readonly workspaceId?: string;
  readonly workspaceLabel?: string;
  readonly input?: NodeJS.ReadStream;
  readonly output?: NodeJS.WriteStream;
}

const ENABLE_ALTERNATE_SCROLL = "\u001b[?1007h";
const DISABLE_ALTERNATE_SCROLL = "\u001b[?1007l";
const ENABLE_APPLICATION_CURSOR_KEYS = "\u001b[?1h";
const DISABLE_APPLICATION_CURSOR_KEYS = "\u001b[?1l";
const ALTERNATE_SCROLL_LINES = 3;
const RUN_ANIMATION_INTERVAL_MS = 90;

export interface ManagedServiceKeepAliveReasonView {
  readonly kind: string;
  readonly count: number;
  readonly summary: string;
}

export interface ManagedServiceStatusView {
  readonly lifecycle: string;
  readonly idleShutdownAt?: string;
  readonly keepAliveReasons?: readonly ManagedServiceKeepAliveReasonView[];
}

export function formatManagedDetach(status: ManagedServiceStatusView | null): string {
  if (!status) return "Detached. Durable work, if any, remains owned by the workspace service.";
  if (status.lifecycle === "stopped") return "Detached. The workspace service has stopped.";
  const reasons = status.keepAliveReasons ?? [];
  if (reasons.length > 0) {
    return `Detached. Service remains active: ${reasons.map(reason => reason.summary).join("; ")}.`;
  }
  const deadline = status.idleShutdownAt ? new Date(status.idleShutdownAt).toLocaleTimeString() : "within its idle timeout";
  return `Detached. No retained background work; the workspace service will stop automatically by ${deadline}.`;
}

function isRoutineTranscript(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "[agent working…]"
    || trimmed === "[run complete]"
    || trimmed === "Run accepted."
    || trimmed.startsWith("[cell complete]")
    || trimmed.startsWith("assistant:");
}

function familyActivityMarker(activity: TerminalFamilyChildView["activity"]): string {
  if (activity === "attention" || activity === "unavailable") return "!";
  if (activity === "working") return "●";
  if (activity === "ended") return "×";
  return "○";
}

export function familyRefreshSuffix(refresh: TerminalFamilyRefreshState): string {
  return refresh === "stale" || refresh === "unavailable" ? ` · ${refresh}` : "";
}

export interface FamilyBrowserLine {
  readonly text: string;
  readonly tone: "title" | "context" | "selected" | "selected-detail" | "option" | "warning" | "help";
  readonly activity?: TerminalFamilyChildView["activity"];
}

function truncateFamilyText(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (maximum <= 0) return "";
  if (normalized.length <= maximum) return normalized;
  return maximum === 1 ? "…" : `${normalized.slice(0, maximum - 1)}…`;
}

function removeLastCodePoint(value: string): string {
  return Array.from(value).slice(0, -1).join("");
}

export function familyBrowserLines(
  view: TerminalScreenView,
  selectedKey: string | null,
  compact = false,
  showModel = false,
  width = 48,
): FamilyBrowserLine[] {
  const maximum = Math.max(12, width);
  const selected = view.familyChildren.find(child => child.key === selectedKey) ?? view.familyChildren[0];
  const title = compact ? `AGENT FAMILY · ${view.sessionName}` : "AGENT FAMILY";
  if (compact) {
    return [
      { text: truncateFamilyText(title, maximum), tone: "title" },
      selected
        ? {
            text: truncateFamilyText(`› ${familyActivityMarker(selected.activity)} ${selected.displayName} · ${selected.activityLabel}`, maximum),
            tone: "selected",
            activity: selected.activity,
          }
        : { text: "No retained direct children.", tone: "context" },
    ];
  }

  const count = view.familyChildren.length;
  const lines: FamilyBrowserLine[] = [
    { text: title, tone: "title" },
    {
      text: truncateFamilyText(
        `${view.sessionName} · ${count} direct ${count === 1 ? "child" : "children"}${familyRefreshSuffix(view.familyRefresh)}`,
        maximum,
      ),
      tone: "context",
    },
    { text: "", tone: "context" },
  ];

  for (const child of view.familyChildren) {
    const isSelected = child.key === selected?.key;
    const label = `${familyActivityMarker(child.activity)} ${child.displayName} · ${child.activityLabel}`;
    if (isSelected) {
      lines.push({
        text: truncateFamilyText(`› ${label}`, maximum),
        tone: "selected",
        activity: child.activity,
      });
      lines.push({
        text: truncateFamilyText(`  ${child.task}`, maximum),
        tone: "selected-detail",
      });
      if (showModel && child.model) {
        lines.push({
          text: truncateFamilyText(`  model · ${child.model}`, maximum),
          tone: "selected-detail",
        });
      }
      if (child.cancellationRequested) {
        lines.push({ text: "  cancellation requested", tone: "warning" });
      }
      if (child.activityReasonLabel) {
        lines.push({
          text: truncateFamilyText(`  ${child.activityReasonLabel}`, maximum),
          tone: "warning",
        });
      }
      continue;
    }
    lines.push({
      text: truncateFamilyText(`  ${label} — ${child.task}`, maximum),
      tone: "option",
      activity: child.activity,
    });
  }

  if (!view.familyChildren.length) lines.push({ text: "No retained direct children.", tone: "context" });
  lines.push(
    { text: "", tone: "context" },
    { text: truncateFamilyText("↑/↓ select · Enter/→ open · ←/Esc close", maximum), tone: "help" },
  );
  return lines;
}

function styledFamilyBrowser(lines: readonly FamilyBrowserLine[], width: number): StyledText {
  const chunks: TextChunk[] = [];
  lines.forEach((line, index) => {
    const selected = line.tone === "selected" || line.tone === "selected-detail" || line.tone === "warning";
    const text = selected ? line.text.padEnd(Math.max(1, width)) : line.text;
    switch (line.tone) {
      case "title":
        chunks.push(bold(fg(TERMINAL_THEME.accent)(text)));
        break;
      case "selected":
        chunks.push(bold(bg(TERMINAL_THEME.selectionBackground)(fg(TERMINAL_THEME.text)(text))));
        break;
      case "selected-detail":
        chunks.push(bg(TERMINAL_THEME.selectionBackground)(fg(TERMINAL_THEME.muted)(text)));
        break;
      case "warning":
        chunks.push(bg(TERMINAL_THEME.selectionBackground)(fg(TERMINAL_THEME.danger)(text)));
        break;
      case "option":
        chunks.push(dim(fg(terminalToneColor(terminalFamilyTone(line.activity ?? "idle")))(text)));
        break;
      case "context":
      case "help":
        chunks.push(dim(fg(TERMINAL_THEME.muted)(text)));
        break;
    }
    if (index < lines.length - 1) chunks.push(fg(TERMINAL_THEME.muted)("\n"));
  });
  return new StyledText(chunks);
}

function renderFamilyBrowser(
  view: TerminalScreenView,
  selectedKey: string | null,
  compact = false,
  showModel = false,
  width = 48,
): string {
  return familyBrowserLines(view, selectedKey, compact, showModel, width).map(line => line.text).join("\n");
}

export interface WorkspaceAgentsLine {
  readonly text: string;
  readonly tone: "context" | "section" | "selected" | "selected-detail" | "option" | "warning" | "help";
  readonly rowKey?: string;
}

export function workspaceAgentsLines(
  view: TerminalScreenView["workspaceAgents"],
  width: number,
  now = Date.now(),
): WorkspaceAgentsLine[] {
  const maximum = Math.max(1, width);
  const freshness = view.refresh === "loading"
    ? "Loading retained roots…"
    : view.refresh === "unavailable"
      ? "Catalog unavailable · Ctrl-R to retry"
      : view.refresh === "stale"
        ? "Catalog stale · Ctrl-R to retry"
        : view.fetchedAt
          ? `Catalog current · ${new Date(view.fetchedAt).toLocaleTimeString()}`
          : "Catalog current";
  const lines: WorkspaceAgentsLine[] = [
    { text: truncateFamilyText(freshness, maximum), tone: view.refresh === "stale" || view.refresh === "unavailable" ? "warning" : "context" },
    { text: "", tone: "context" },
  ];
  if (!view.rows.length) {
    lines.push({
      text: truncateFamilyText(
        view.query ? `No retained root work matches “${view.query}”.` : "No retained root work is available.",
        maximum,
      ),
      tone: "context",
    });
  }
  for (const section of view.sections) {
    lines.push({ text: truncateFamilyText(section.title.toUpperCase(), maximum), tone: "section" });
    for (const row of section.rows) {
      const formatted = formatTerminalWorkspaceAgentRow(row, maximum, row.key === view.selectedKey, now);
      const selected = row.key === view.selectedKey;
      lines.push({
        text: formatted.primary,
        tone: selected ? "selected" : row.resumable ? "option" : "warning",
        rowKey: row.key,
      });
      if (formatted.secondary) {
        lines.push({
          text: formatted.secondary,
          tone: selected ? "selected-detail" : row.resumable ? "context" : "warning",
          rowKey: row.key,
        });
      }
    }
    lines.push({ text: "", tone: "context" });
  }
  lines.push({
    text: truncateFamilyText("Ctrl-N new · ↑/↓ select · PgUp/PgDn page · Enter/→ open · Ctrl-R refresh · Esc back", maximum),
    tone: "help",
  });
  return lines;
}

function styledWorkspaceAgents(lines: readonly WorkspaceAgentsLine[], width: number): StyledText {
  const chunks: TextChunk[] = [];
  lines.forEach((line, index) => {
    const selected = line.tone === "selected" || line.tone === "selected-detail";
    const text = selected ? line.text.padEnd(Math.max(1, width)) : line.text;
    switch (line.tone) {
      case "section":
        chunks.push(bold(fg(TERMINAL_THEME.accent)(text)));
        break;
      case "selected":
        chunks.push(bold(bg(TERMINAL_THEME.selectionBackground)(fg(TERMINAL_THEME.text)(text))));
        break;
      case "selected-detail":
        chunks.push(bg(TERMINAL_THEME.selectionBackground)(fg(TERMINAL_THEME.muted)(text)));
        break;
      case "warning":
        chunks.push(fg(TERMINAL_THEME.warning)(text));
        break;
      case "option":
        chunks.push(fg(TERMINAL_THEME.text)(text));
        break;
      case "context":
      case "help":
        chunks.push(dim(fg(TERMINAL_THEME.muted)(text)));
        break;
    }
    if (index < lines.length - 1) chunks.push(fg(TERMINAL_THEME.muted)("\n"));
  });
  return new StyledText(chunks);
}

function paletteText(query: string): string {
  const normalized = query.toLowerCase();
  const matches = TERMINAL_COMMAND_REGISTRY.filter(command => {
    if (!normalized || normalized === "/") return command.category === "product";
    return command.name.includes(normalized) || command.summary.toLowerCase().includes(normalized.slice(1));
  }).slice(0, 12);
  return [
    "COMMANDS",
    ...matches.map(command => `${command.usage}\n  ${command.summary}`),
    "",
    "Ctrl-P commands · Ctrl-O latest activity · Ctrl-L all activity · Ctrl-Y learning · PgUp/PgDn scroll · Ctrl-C stop/detach · Ctrl-D detach · Esc close",
  ].join("\n");
}

export function renderModelInspector(
  detail: TerminalModelDetail,
  selectedIndex: number,
  entryProvider: string | null,
  query: string,
  selectedIdentity: string | null,
  width = 80,
): string {
  const currentProvider = detail.providers.find(provider => provider.name === detail.current.provider);
  const selectedProvider = entryProvider ?? detail.providers[selectedIndex]?.name;
  const catalogOptions = selectedProvider
    ? rankModelOptions(
        detail.catalogModels,
        selectedProvider,
        entryProvider ? query : "",
      )
    : [];
  const fit = (value: unknown): string =>
    fitTerminalLine(value, Math.max(1, width));
  if (entryProvider) {
    const provider = detail.providers.find(item => item.name === entryProvider);
    const window = visibleSelectionWindow(
      catalogOptions,
      selectedIdentity,
    );
    const catalogCount = catalogOptions.filter(option =>
      option.kind === "catalog"
    ).length;
    const statusLines = detail.catalogStatus === "cached-fallback"
      ? [
          `! Using cached catalog${detail.catalogError ? ` · ${detail.catalogError}` : ""}`,
        ]
      : detail.catalogStatus === "unavailable"
        ? [
            `! Catalog unavailable${detail.catalogError ? ` · ${detail.catalogError}` : ""}`,
            "Type an exact model ID to continue.",
          ]
        : catalogCount === 0
          ? [
              `No catalog models are available for ${provider?.displayName ?? entryProvider}.`,
              "Type an exact model ID to continue.",
            ]
          : [];
    const lines = [
      "MODEL",
      "",
      "Choose model",
      provider?.displayName ?? entryProvider,
      `Search: ${query || "type a name or exact model ID"}`,
      ...statusLines,
      ...(detail.catalogOrigin ? [`Catalog origin: ${detail.catalogOrigin}`] : []),
      ...(window.options.length ? [
        "",
        `Models ${window.start + 1}–${window.end} of ${catalogOptions.length}`,
        ...window.options.flatMap(option =>
          modelSelectionLines(detail, entryProvider, option, option.identity === selectedIdentity)
        ),
      ] : []),
      "",
      "Current",
      `${currentProvider?.displayName ?? detail.current.provider} · ${detail.current.model}`,
      "",
      "Type/paste search · Backspace edit · ↑/↓ select",
      "Enter save canonical ID · Esc back",
    ].filter((line, index, lines) => line || lines[index - 1] !== "");
    return lines.map(fit).join("\n");
  }
  const lines = [
    "MODEL",
    "",
    "Current",
    `${currentProvider?.usable ? "✓" : "!"} ${currentProvider?.displayName ?? detail.current.provider}`,
    `  ${detail.current.model}`,
    `  Credential: ${currentProvider?.credentialLabel ?? "unavailable"}`,
    `  Agent tools: ${detail.currentAgentTools?.state ?? currentProvider?.agentToolState ?? "unavailable"}${detail.currentAgentTools?.canRun === false ? " · unavailable" : ""}`,
    ...(detail.currentAgentTools?.reason ? [`  ${detail.currentAgentTools.reason}`] : []),
    "",
    "Workspace default",
    `  ${detail.workspaceDefault ?? "Not set"}`,
    "",
    "Providers",
  ];
  detail.providers.forEach((provider, index) => {
    const selected = index === selectedIndex;
    lines.push(`${selected ? ">" : " "} ${provider.usable && provider.agentToolAdmission === "allowed" ? "✓" : "○"} ${provider.displayName}`);
    lines.push(`    ${provider.credentialLabel} · agent tools ${provider.agentToolState}`);
    if (selected && (!provider.usable || provider.agentToolAdmission === "rejected") && provider.remediation) lines.push(`    ${provider.remediation}`);
  });
  const catalogModels = catalogOptions.filter(
    (option): option is Extract<ModelSelectionOption, { kind: "catalog" }> =>
      option.kind === "catalog",
  );
  if (catalogModels.length) {
    lines.push("", "Catalog models");
    for (const option of catalogModels.slice(0, 6)) {
      const model = option.descriptor;
      const pricing = model.pricing === null ? "price unknown"
        : `$${(model.pricing.inputUsdPerToken * 1_000_000).toFixed(2)}/$${(model.pricing.outputUsdPerToken * 1_000_000).toFixed(2)} per 1M`;
      lines.push(
        `  ${model.displayName} · ${model.model}`,
        `    ${model.contextWindowTokens === null ? "context unknown" : `${Math.round(model.contextWindowTokens / 1_000)}k context`} · ${pricing} · ${model.reasoning.status === "listed" ? "effort" : model.reasoning.status === "unverified" ? "effort (unverified)" : "fixed"} · agent tools ${terminalCatalogAgentToolState(detail, selectedProvider ?? "", model.model)}${model.stale ? " · stale" : ""}`,
      );
    }
  }
  if (detail.catalogStatus === "cached-fallback") {
    lines.push("", `! Cached catalog fallback${detail.catalogError ? ` · ${detail.catalogError}` : ""}`);
  } else if (detail.catalogStatus === "unavailable") {
    lines.push("", `! Catalog unavailable${detail.catalogError ? ` · ${detail.catalogError}` : ""}`);
  } else if (selectedProvider && catalogModels.length === 0) {
    lines.push("", "No catalog models are available for this provider.");
  }
  lines.push("", "↑/↓ provider · Enter choose · L login · X logout", "Shift-R raw · Esc close");
  return lines.map(fit).join("\n");
}

function modelSelectionLines(
  detail: TerminalModelDetail,
  provider: string,
  option: ModelSelectionOption,
  selected: boolean,
): string[] {
  if (option.kind === "manual") {
    return [
      `${selected ? ">" : " "} ${option.displayName}`,
      `  ${option.model} · not listed in catalog`,
    ];
  }
  const model = option.descriptor;
  return [
    `${selected ? ">" : " "} ${model.displayName} · ${model.model}`,
    `  ${model.contextWindowTokens === null ? "context unknown" : `${Math.round(model.contextWindowTokens / 1_000)}k context`} · ${model.reasoning.status === "listed" ? "effort" : model.reasoning.status === "unverified" ? "effort (unverified)" : "fixed"} · agent tools ${terminalCatalogAgentToolState(detail, provider, model.model)}${model.stale ? " · stale" : ""}`,
  ];
}

function renderEffortInspector(detail: TerminalEffortDetail, selectedIndex: number): string {
  return [
    "REASONING EFFORT",
    "",
    `Model: ${detail.model}`,
    `Capability: ${detail.capability}${detail.stale ? " · stale catalog" : ""}`,
    ...(detail.catalogError ? [`Catalog: ${detail.catalogError}`] : []),
    "",
    ...detail.options.map((effort, index) =>
      `${index === selectedIndex ? ">" : " "} ${effort}${detail.capability === "unverified" && effort !== "provider-default" ? " · unverified" : ""}`),
    "",
    "↑/↓ effort · Enter select · Shift-R raw · Esc close",
  ].join("\n");
}

function noticeText(notice: { text: string; tone: "normal" | "success" | "warning" | "danger" } | null): string {
  if (!notice) return "";
  const marker = notice.tone === "success" ? "✓" : notice.tone === "danger" ? "×" : notice.tone === "warning" ? "!" : "•";
  return `${marker} ${notice.text}`;
}

export function learningDockLines(
  learning: TerminalLearningDockView,
  expanded: boolean,
  width: number,
): string[] {
  const latest = learning.items.at(-1);
  if (!latest) return [];
  const maximum = Math.max(1, width);
  const refresh = learning.refresh === "stale" || learning.refresh === "unavailable"
    ? ` · ${learning.refresh}`
    : "";
  if (!expanded) {
    const prior = learning.items.length > 1
      ? ` · ${learning.items.length} updates`
      : "";
    return [truncateFamilyText(
      `▸ LEARNING · ${latest.status} · ${latest.result}${prior}${refresh} · Ctrl-Y expand`,
      maximum,
    )];
  }
  const count = learning.items.length;
  return [
    `▾ LEARNING · ${count} retained update${count === 1 ? "" : "s"}${refresh} · Ctrl-Y dismiss`,
    `Request  ${latest.request}`,
    `Status   ${latest.status}`,
    `Result   ${latest.result}`,
    ...(latest.reason ? [`Reason   ${latest.reason}`] : []),
    ...(latest.guidance ? [`Next     ${latest.guidance}`] : []),
    ...(count > 1 ? [`History  ${count} retained updates · /refine history shows all`] : []),
  ].map(line => truncateFamilyText(line, maximum));
}

export interface OpenTuiController {
  readonly presentation: TerminalPresentation;
  readonly detached: boolean;
  readonly pendingSecretInput?: boolean;
  readonly pendingSecretProvider?: string | null;
  subscribePresentation(listener: (presentation: TerminalPresentation) => void): () => void;
  execute(line: string): Promise<"continue" | "detach">;
  handleInterrupt(): Promise<InterruptDecision>;
  openFamilyChild?(sessionId: string, branchId: string): Promise<void>;
  openFamilyParent?(): Promise<void>;
  setFamilyBrowserOpen?(open: boolean): void;
  openWorkspaceAgents?(): Promise<void>;
  closeWorkspaceAgents?(): void;
  refreshWorkspaceAgents?(): Promise<void>;
  setWorkspaceAgentsQuery?(query: string): void;
  selectWorkspaceAgent?(selectedKey: string | null): void;
  openWorkspaceAgent?(sessionId: string, branchId: string): Promise<void>;
  createWorkspaceAgent?(): Promise<void>;
  abortPendingOperations?(): void;
}

export function toggleAllRunDetails(
  runs: TerminalScreenView["runs"],
  expandedRunIds: Set<string>,
): boolean {
  const expandableRunIds = runs
    .filter(run => run.steps.length > 0)
    .map(run => run.id);
  if (expandableRunIds.length === 0) return false;
  const collapse = expandableRunIds.every(runId => expandedRunIds.has(runId));
  for (const runId of expandableRunIds) {
    if (collapse) expandedRunIds.delete(runId);
    else expandedRunIds.add(runId);
  }
  return true;
}

export function toggleLatestRunDetails(
  runs: TerminalScreenView["runs"],
  expandedRunIds: Set<string>,
): boolean {
  const latest = [...runs].reverse().find(run => run.steps.length > 0);
  if (!latest) return false;
  if (expandedRunIds.has(latest.id)) expandedRunIds.delete(latest.id);
  else expandedRunIds.add(latest.id);
  return true;
}

export function alternateScrollDelta(sequence: string): number | null {
  if (sequence === "\u001bOA") return -ALTERNATE_SCROLL_LINES;
  if (sequence === "\u001bOB") return ALTERNATE_SCROLL_LINES;
  return null;
}

export class OpenTuiApp {
  readonly #syntaxStyle = createTerminalSyntaxStyle();
  readonly #root: BoxRenderable;
  readonly #header: TextRenderable;
  readonly #main: BoxRenderable;
  readonly #timeline: ScrollBoxRenderable;
  readonly #transcript: TerminalTranscript;
  readonly #details: ScrollBoxRenderable;
  readonly #noticeText: TextRenderable;
  readonly #detailsText: TextRenderable;
  readonly #learningDockHost: BoxRenderable;
  readonly #learningDock: BoxRenderable;
  readonly #learningDockText: TextRenderable;
  readonly #composerBox: BoxRenderable;
  readonly #composerContent: BoxRenderable;
  readonly #composerPrompt: TextRenderable;
  readonly #composer: TextareaRenderable;
  readonly #familySummary: TextRenderable;
  readonly #footer: BoxRenderable;
  readonly #footerLeft: TextRenderable;
  readonly #footerRight: TextRenderable;
  readonly #expandedRunIds = new Set<string>();
  readonly #provisionalOutput = new Map<string, string>();
  readonly #unsubscribe: () => void;
  readonly #done: Promise<void>;
  #resolveDone!: () => void;
  #view: TerminalScreenView;
  #detail: TerminalDetail | null = null;
  #rawDetail = false;
  #notice: { text: string; tone: "normal" | "success" | "warning" | "danger" } | null = null;
  #noticeTimer: ReturnType<typeof setTimeout> | null = null;
  #detailScrollTimer: ReturnType<typeof setTimeout> | null = null;
  #runAnimationTimer: ReturnType<typeof setInterval> | null = null;
  #runAnimationFrame = 0;
  #paletteQuery = "";
  #paletteDraft: string | null = null;
  #modelProviderIndex = 0;
  #modelEntryProvider: string | null = null;
  #modelEntryQuery = "";
  #modelSelectedIdentity: string | null = null;
  #modelEntryDraft: string | null = null;
  #effortIndex = 0;
  #resetDetailScroll = false;
  #busy = false;
  #closed = false;
  #activeOperation: Promise<void> | null = null;
  #secretBuffer = "";
  #learningExpanded = false;
  readonly #learningDismissedThroughIdByRoute = new Map<string, string>();
  #familyFocus: "composer" | "summary" | "browser" = "composer";
  #familySelectedKey: string | null = null;
  readonly #familyBrowserStateByRoute = new Map<string, { selectedKey: string; scrollTop: number }>();

  constructor(readonly renderer: CliRenderer, readonly controller: OpenTuiController) {
    this.#view = buildTerminalScreen(controller.presentation);
    this.#done = new Promise(resolve => { this.#resolveDone = resolve; });
    this.#root = new BoxRenderable(renderer, {
      id: "agencity-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: TERMINAL_THEME.background,
    });
    this.#header = new TextRenderable(renderer, {
      id: "agencity-header",
      height: 2,
      paddingX: 1,
      fg: TERMINAL_THEME.text,
      bg: TERMINAL_THEME.raised,
      truncate: true,
      wrapMode: "none",
    });
    this.#main = new BoxRenderable(renderer, {
      id: "agencity-main",
      flexGrow: 1,
      minHeight: 3,
      flexDirection: "row",
      backgroundColor: TERMINAL_THEME.background,
    });
    this.#timeline = new ScrollBoxRenderable(renderer, {
      id: "agencity-timeline",
      flexGrow: 1,
      minWidth: 20,
      scrollY: true,
      scrollX: false,
      stickyScroll: true,
      stickyStart: "bottom",
      padding: 1,
      viewportCulling: true,
    });
    this.#transcript = new TerminalTranscript(renderer, this.#timeline, this.#syntaxStyle);
    this.#details = new ScrollBoxRenderable(renderer, {
      id: "agencity-details",
      width: 38,
      border: ["left"],
      borderColor: TERMINAL_THEME.border,
      padding: 1,
      backgroundColor: TERMINAL_THEME.raised,
      scrollY: true,
      scrollX: false,
      stickyScroll: false,
    });
    this.#noticeText = new TextRenderable(renderer, {
      id: "agencity-notice",
      width: "100%",
      height: "auto",
      fg: TERMINAL_THEME.muted,
      wrapMode: "word",
      selectable: true,
      visible: false,
    });
    this.#detailsText = new TextRenderable(renderer, {
      id: "agencity-details-text",
      width: "100%",
      height: "auto",
      fg: TERMINAL_THEME.muted,
      wrapMode: "word",
      selectable: true,
    });
    this.#learningDockHost = new BoxRenderable(renderer, {
      id: "agencity-learning-dock-host",
      width: "100%",
      height: 0,
      flexDirection: "row",
      justifyContent: "center",
      flexShrink: 0,
      backgroundColor: TERMINAL_THEME.background,
      visible: false,
    });
    this.#learningDock = new BoxRenderable(renderer, {
      id: "agencity-learning-dock",
      width: 80,
      height: 3,
      paddingX: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: TERMINAL_THEME.provisionalDim,
      backgroundColor: TERMINAL_THEME.raised,
    });
    this.#learningDockText = new TextRenderable(renderer, {
      id: "agencity-learning-dock-text",
      width: "100%",
      height: 1,
      fg: TERMINAL_THEME.provisionalDim,
      bg: TERMINAL_THEME.raised,
      wrapMode: "none",
      truncate: true,
      selectable: true,
    });
    this.#composerBox = new BoxRenderable(renderer, {
      id: "agencity-composer-box",
      height: 3,
      flexShrink: 0,
      paddingX: 2,
      paddingY: 1,
      backgroundColor: TERMINAL_THEME.raised,
    });
    this.#composerContent = new BoxRenderable(renderer, {
      id: "agencity-composer-content",
      width: "100%",
      height: 1,
      flexDirection: "row",
      flexShrink: 0,
      backgroundColor: TERMINAL_THEME.raised,
    });
    this.#composerPrompt = new TextRenderable(renderer, {
      id: "agencity-composer-prompt",
      width: 2,
      height: 1,
      flexShrink: 0,
      content: "› ",
      fg: TERMINAL_THEME.accent,
      bg: TERMINAL_THEME.raised,
      wrapMode: "none",
    });
    this.#composer = new TextareaRenderable(renderer, {
      id: "agencity-composer",
      flexGrow: 1,
      minWidth: 1,
      height: 1,
      wrapMode: "word",
      placeholder: this.#view.composerPlaceholder,
      textColor: TERMINAL_THEME.text,
      focusedTextColor: TERMINAL_THEME.text,
      backgroundColor: TERMINAL_THEME.raised,
      focusedBackgroundColor: TERMINAL_THEME.raised,
      placeholderColor: TERMINAL_THEME.muted,
      onSubmit: () => {
        if (!this.#view.workspaceAgents.open) void this.#submit();
      },
      onContentChange: () => {
        if (this.#closed) return;
        if (this.#view.workspaceAgents.open) {
          this.controller.setWorkspaceAgentsQuery?.(this.#composerValue());
        }
        this.#render();
      },
      onKeyDown: key => {
        const escape = key.name === "escape" || key.name === "esc" || key.sequence === "\u001b";
        if (!this.controller.pendingSecretInput && this.#modelEntryProvider && escape) {
          key.preventDefault();
          key.stopPropagation();
          this.#leaveModelEntry();
          this.#render();
          return;
        }
        if (!this.controller.pendingSecretInput && this.#view.workspaceAgents.open && escape) {
          key.preventDefault();
          key.stopPropagation();
          if (this.#view.workspaceAgents.query) {
            this.#setComposerValue("");
            this.controller.setWorkspaceAgentsQuery?.("");
          } else {
            this.controller.closeWorkspaceAgents?.();
          }
          return;
        }
      },
    });
    this.#familySummary = new TextRenderable(renderer, {
      id: "agencity-family-summary",
      height: 1,
      flexShrink: 0,
      paddingX: 1,
      fg: TERMINAL_THEME.muted,
      bg: TERMINAL_THEME.raised,
      truncate: true,
      wrapMode: "none",
    });
    this.#footer = new BoxRenderable(renderer, {
      id: "agencity-footer",
      height: 1,
      flexShrink: 0,
      paddingX: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      backgroundColor: TERMINAL_THEME.raised,
    });
    this.#footerLeft = new TextRenderable(renderer, {
      id: "agencity-footer-left",
      flexGrow: 1,
      minWidth: 1,
      height: 1,
      fg: TERMINAL_THEME.muted,
      bg: TERMINAL_THEME.raised,
      truncate: true,
      wrapMode: "none",
    });
    this.#footerRight = new TextRenderable(renderer, {
      id: "agencity-footer-right",
      width: 0,
      height: 1,
      flexShrink: 0,
      fg: TERMINAL_THEME.accent,
      bg: TERMINAL_THEME.raised,
      truncate: true,
      wrapMode: "none",
    });

    this.#details.add(this.#noticeText);
    this.#details.add(this.#detailsText);
    this.#main.add(this.#timeline);
    this.#main.add(this.#details);
    this.#learningDock.add(this.#learningDockText);
    this.#learningDockHost.add(this.#learningDock);
    this.#composerContent.add(this.#composerPrompt);
    this.#composerContent.add(this.#composer);
    this.#composerBox.add(this.#composerContent);
    this.#footer.add(this.#footerLeft);
    this.#footer.add(this.#footerRight);
    this.#root.add(this.#header);
    this.#root.add(this.#main);
    this.#root.add(this.#learningDockHost);
    this.#root.add(this.#composerBox);
    this.#root.add(this.#familySummary);
    this.#root.add(this.#footer);
    renderer.root.add(this.#root);

    this.#unsubscribe = controller.subscribePresentation(presentation => {
      const previousIndex = this.#view.familyChildren.findIndex(child => child.key === this.#familySelectedKey);
      const previousWorkspace = this.#view.workspaceAgents;
      const workspaceWasOpen = this.#view.workspaceAgents.open;
      this.#view = buildTerminalScreen(presentation);
      const recenterWorkspace = this.#view.workspaceAgents.open && (
        !workspaceWasOpen
        || previousWorkspace.selectedKey !== this.#view.workspaceAgents.selectedKey
        || previousWorkspace.query !== this.#view.workspaceAgents.query
        || previousWorkspace.fetchedAt !== this.#view.workspaceAgents.fetchedAt
      );
      if (this.#view.workspaceAgents.open) {
        if (this.#familyFocus === "browser") this.controller.setFamilyBrowserOpen?.(false);
        this.#familyFocus = "composer";
        this.#detail = null;
        this.#rawDetail = false;
        this.#paletteQuery = "";
        this.#paletteDraft = null;
        if (this.#composerValue() !== this.#view.workspaceAgents.query) {
          this.#setComposerValue(this.#view.workspaceAgents.query);
        }
        this.#composer.focus();
      } else if (workspaceWasOpen) {
        this.#setComposerValue("");
        this.#composer.focus();
      } else if (this.#familyFocus === "browser") {
        const retained = this.#view.familyChildren.some(child => child.key === this.#familySelectedKey);
        if (!retained) {
          const nextIndex = Math.min(Math.max(0, previousIndex), Math.max(0, this.#view.familyChildren.length - 1));
          this.#familySelectedKey = this.#view.familyChildren[nextIndex]?.key ?? null;
        }
        if (!this.#view.familyChildren.length) this.#focusComposer(false);
      } else if (this.#familyFocus === "summary" && !this.#view.familySummary) {
        this.#focusComposer(false);
      }
      this.#render();
      if (recenterWorkspace) this.#centerWorkspaceAgentSelection();
    });
    renderer.keyInput.on("keypress", this.#onKey);
    renderer.keyInput.on("paste", this.#onPaste);
    renderer.on(CliRenderEvents.RESIZE, this.#onResize);
    this.#render();
    this.#composer.focus();
  }

  async run(): Promise<void> {
    await this.#done;
  }

  handleAlternateScrollInput(sequence: string): boolean {
    const delta = alternateScrollDelta(sequence);
    if (delta === null) return false;
    if (delta !== 0) this.#scrollActiveView(delta);
    return true;
  }

  handleTerminalLinefeedInput(sequence: string): boolean {
    if (sequence !== "\n" || this.controller.pendingSecretInput) return false;
    if (this.#view.workspaceAgents.open) return true;
    if (this.#modelEntryProvider) {
      this.#confirmModelSelection();
      return true;
    }
    this.#composer.newLine();
    this.#render();
    return true;
  }

  showOutput(value: string): void {
    if (this.#closed) return;
    if (isRoutineTranscript(value)) return;
    const next = scrubText(value).trim();
    if (!next) return;
    const danger = /\[(?:command|interrupt|protocol watch) (?:error|failed)|\bfailed\b/i.test(next);
    const warning = /unknown|discarded|cancel|not confirmed|may outlive/i.test(next);
    const success = /^(?:Saved|Selected|Removed|Returned|Switched|Assessment recorded|Cancellation requested)/i.test(next);
    this.#notice = { text: next.slice(0, 800), tone: danger ? "danger" : warning ? "warning" : success ? "success" : "normal" };
    if (next.startsWith("[protocol watch failed]")) {
      if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
      this.#noticeTimer = null;
    } else {
      this.#scheduleNoticeDismiss(danger ? 8_000 : 4_000);
    }
    this.#render();
  }

  showDetail(detail: TerminalDetail | null): void {
    if (this.#closed) return;
    if (detail === null) {
      this.#detail = null;
      this.#rawDetail = false;
      this.#leaveModelEntry();
      this.#render();
      return;
    }
    const previousProvider = this.#selectedModelProvider()?.name;
    const previousEntryProvider = this.#modelEntryProvider;
    const previousEntryQuery = this.#modelEntryQuery;
    const previousSelectedIdentity = this.#modelSelectedIdentity;
    this.#detail = detail;
    this.#rawDetail = detail.kind === "raw";
    this.#paletteQuery = "";
    this.#paletteDraft = null;
    if (detail.kind === "model") {
      const selected = detail.providers.findIndex(provider => provider.name === (previousProvider ?? detail.current.provider));
      this.#modelProviderIndex = Math.max(0, selected);
      if (
        previousEntryProvider &&
        detail.providers.some(provider => provider.name === previousEntryProvider)
      ) {
        this.#modelEntryProvider = previousEntryProvider;
        this.#modelEntryQuery = previousEntryQuery;
        this.#modelSelectedIdentity = reconcileSelectedIdentity(
          rankModelOptions(
            detail.catalogModels,
            previousEntryProvider,
            previousEntryQuery,
          ),
          previousSelectedIdentity,
          "data-refresh",
        );
      } else {
        this.#leaveModelEntry();
      }
    } else if (detail.kind === "effort") {
      this.#leaveModelEntry();
      this.#effortIndex = Math.max(0, detail.options.indexOf(detail.current));
    } else {
      this.#leaveModelEntry();
    }
    this.#resetDetailScroll = this.#modelEntryProvider === null;
    if (!this.#resetDetailScroll && this.#detailScrollTimer) {
      clearTimeout(this.#detailScrollTimer);
      this.#detailScrollTimer = null;
    }
    this.#render();
  }

  showProvisional(effectId: string, value: string): void {
    if (this.#closed) return;
    this.#provisionalOutput.set(effectId, `${this.#provisionalOutput.get(effectId) ?? ""}${scrubText(value)}`.slice(-4_000));
    this.#render();
  }

  discardProvisional(effectIds: readonly string[], reason: "committed" | "disconnect" | "reconnect"): void {
    if (this.#closed) return;
    for (const effectId of effectIds) this.#provisionalOutput.delete(effectId);
    if (reason !== "committed" && effectIds.length > 0) {
      this.#notice = { text: "Provisional provider output was discarded after the connection changed.", tone: "warning" };
      this.#scheduleNoticeDismiss(6_000);
    }
    this.#render();
  }

  async settle(timeoutMs = 1_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.#activeOperation) {
      const operation = this.#activeOperation;
      const remaining = Math.max(0, deadline - Date.now());
      const completed = await Promise.race([
        operation.then(() => true, () => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), remaining)),
      ]);
      if (!completed) return false;
      if (this.#activeOperation === operation) this.#activeOperation = null;
    }
    return true;
  }

  requestExit(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#familyFocus === "browser") this.controller.setFamilyBrowserOpen?.(false);
    this.#clearSecretInput();
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    if (this.#detailScrollTimer) clearTimeout(this.#detailScrollTimer);
    this.#stopRunAnimation();
    this.controller.abortPendingOperations?.();
    this.#resolveDone();
  }

  destroy(): void {
    this.#closed = true;
    if (this.#familyFocus === "browser") this.controller.setFamilyBrowserOpen?.(false);
    this.#clearSecretInput();
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    if (this.#detailScrollTimer) clearTimeout(this.#detailScrollTimer);
    this.#stopRunAnimation();
    this.#unsubscribe();
    this.renderer.keyInput.off("keypress", this.#onKey);
    this.renderer.keyInput.off("paste", this.#onPaste);
    this.renderer.off(CliRenderEvents.RESIZE, this.#onResize);
    this.#root.destroyRecursively();
    this.#syntaxStyle.destroy();
  }

  #onResize = (): void => {
    if (this.#activeInspector() && !this.#view.workspaceAgents.open) this.#resetDetailScroll = true;
    this.#render();
    if (this.#view.workspaceAgents.open) this.#centerWorkspaceAgentSelection();
    if (this.#familyFocus === "composer") this.#composer.focus();
  };

  #onPaste = (event: PasteEvent): void => {
    if (this.#modelEntryProvider && !this.controller.pendingSecretInput) {
      event.preventDefault();
      event.stopPropagation();
      this.#appendModelQuery(decodePasteBytes(event.bytes));
      return;
    }
    if (!this.controller.pendingSecretInput) return;
    event.preventDefault();
    event.stopPropagation();
    const value = decodePasteBytes(event.bytes);
    this.#secretBuffer = `${this.#secretBuffer}${value}`.slice(0, 16_384);
    this.#setComposerValue("•".repeat(this.#secretBuffer.length));
  };

  #onKey = (key: KeyEvent): void => {
    const escape = key.name === "escape" || key.name === "esc" || key.sequence === "\u001b";
    if (this.controller.pendingSecretInput) {
      key.preventDefault();
      key.stopPropagation();
      if (key.ctrl && key.name === "d") {
        this.#clearSecretInput();
        this.requestExit();
        return;
      }
      if (escape || key.ctrl && key.name === "c") {
        this.#clearSecretInput();
        void this.controller.execute("/cancel").finally(() => {
          if (!this.#closed) { this.#render(); this.#composer.focus(); }
        });
        return;
      }
      if (key.name === "return" || key.name === "linefeed" || key.name === "kpenter") {
        void this.#submitSecret();
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        this.#secretBuffer = this.#secretBuffer.slice(0, -1);
        this.#setComposerValue("•".repeat(this.#secretBuffer.length));
        return;
      }
      if (!key.ctrl && !key.meta && key.sequence && !/[\r\n\0-\x1f\x7f]/.test(key.sequence)) {
        this.#secretBuffer = `${this.#secretBuffer}${key.sequence}`.slice(0, 16_384);
        this.#setComposerValue("•".repeat(this.#secretBuffer.length));
      }
      return;
    }
    const enter = key.name === "return" || key.name === "linefeed" || key.name === "kpenter";
    if (this.#view.workspaceAgents.open) {
      if (key.ctrl && key.name === "p") {
        key.preventDefault();
        key.stopPropagation();
        this.#showNotice("Close Agents before opening commands.");
        return;
      }
      if (key.ctrl && key.name === "r") {
        key.preventDefault();
        key.stopPropagation();
        void this.#refreshWorkspaceAgents();
        return;
      }
      if (key.ctrl && key.name === "n") {
        key.preventDefault();
        key.stopPropagation();
        void this.#createWorkspaceAgent();
        return;
      }
      if (!key.ctrl && !key.meta) {
        if (key.name === "up" || key.name === "down") {
          key.preventDefault();
          key.stopPropagation();
          this.#moveWorkspaceAgentSelection(key.name === "up" ? -1 : 1);
          return;
        }
        if (key.name === "pageup" || key.name === "pagedown") {
          key.preventDefault();
          key.stopPropagation();
          this.#moveWorkspaceAgentPage(key.name === "pageup" ? -1 : 1);
          return;
        }
        if (enter || key.name === "right") {
          key.preventDefault();
          key.stopPropagation();
          void this.#openSelectedWorkspaceAgent();
          return;
        }
        if (escape) {
          key.preventDefault();
          key.stopPropagation();
          if (this.#view.workspaceAgents.query) {
            this.#setComposerValue("");
            this.controller.setWorkspaceAgentsQuery?.("");
          } else {
            this.controller.closeWorkspaceAgents?.();
          }
          return;
        }
        if (key.name === "left") {
          key.preventDefault();
          key.stopPropagation();
          return;
        }
      }
    }
    const modelDetail = this.#activeModelDetail();
    if (modelDetail && !this.#paletteQuery && this.#provisionalOutput.size === 0 && !this.#rawDetail) {
      if (this.#modelEntryProvider) {
        const options = this.#modelOptions(modelDetail);
        if ((key.name === "up" || key.name === "down") && options.length) {
          key.preventDefault();
          key.stopPropagation();
          this.#modelSelectedIdentity = navigateSelectedIdentity(
            options,
            this.#modelSelectedIdentity,
            key.name === "up" ? -1 : 1,
          );
          this.#render();
          return;
        }
        if (escape) {
          key.preventDefault();
          key.stopPropagation();
          this.#leaveModelEntry();
          this.#render();
          return;
        }
        if (enter && !key.meta && !key.ctrl) {
          key.preventDefault();
          key.stopPropagation();
          this.#confirmModelSelection();
          return;
        }
        if (
          !key.ctrl &&
          !key.meta &&
          (key.name === "backspace" || key.name === "delete")
        ) {
          key.preventDefault();
          key.stopPropagation();
          this.#setModelQuery(removeLastCodePoint(this.#modelEntryQuery));
          return;
        }
        if (
          !key.ctrl &&
          !key.meta &&
          key.sequence &&
          !/[\r\n\u0000-\u001f\u007f]/u.test(key.sequence)
        ) {
          key.preventDefault();
          key.stopPropagation();
          this.#appendModelQuery(key.sequence);
          return;
        }
        if (!(key.ctrl && (key.name === "c" || key.name === "d"))) {
          key.preventDefault();
          key.stopPropagation();
          return;
        }
      } else {
        const providers = modelDetail.providers;
        if ((key.name === "up" || key.name === "down") && providers.length) {
          key.preventDefault();
          key.stopPropagation();
          const delta = key.name === "up" ? -1 : 1;
          this.#modelProviderIndex = (this.#modelProviderIndex + delta + providers.length) % providers.length;
          this.#render();
          return;
        }
        const provider = providers[this.#modelProviderIndex];
        if ((key.name === "return" || key.name === "linefeed" || key.name === "kpenter") && !key.meta && !key.ctrl) {
          key.preventDefault();
          key.stopPropagation();
          if (!provider) return;
          if (!provider.usable) {
            this.#showNotice(provider.remediation ?? `Press L to log in to ${provider.displayName}.`, "warning");
            return;
          }
          this.#beginModelEntry(modelDetail, provider.name);
          this.#render();
          return;
        }
        if (!key.ctrl && !key.meta && provider && (key.name === "l" || key.name === "x")) {
          key.preventDefault();
          key.stopPropagation();
          if (!provider.credentialManaged) {
            this.#showNotice(`${provider.displayName} does not use the local provider credential store.`, "warning");
            return;
          }
          if (key.name === "l") {
            void this.#runCommand(`/model login ${provider.name}`, true);
          } else {
            void this.#runCommand(`/model logout ${provider.name}`, true);
          }
          return;
        }
      }
    }
    const effortDetail = this.#activeEffortDetail();
    if (effortDetail && !this.#paletteQuery && this.#provisionalOutput.size === 0 && !this.#rawDetail) {
      if ((key.name === "up" || key.name === "down") && effortDetail.options.length) {
        key.preventDefault();
        key.stopPropagation();
        const delta = key.name === "up" ? -1 : 1;
        this.#effortIndex = (this.#effortIndex + delta + effortDetail.options.length) % effortDetail.options.length;
        this.#render();
        return;
      }
      if ((key.name === "return" || key.name === "linefeed" || key.name === "kpenter") && !key.meta && !key.ctrl) {
        key.preventDefault();
        key.stopPropagation();
        const effort = effortDetail.options[this.#effortIndex];
        if (effort) void this.#runCommand(`/effort ${effort}`, true);
        return;
      }
    }
    if (this.#familyFocus === "browser" && !key.ctrl && !key.meta) {
      if (key.name === "up" || key.name === "down") {
        key.preventDefault();
        key.stopPropagation();
        this.#moveFamilySelection(key.name === "up" ? -1 : 1);
        return;
      }
      if (key.name === "pageup" || key.name === "pagedown") {
        key.preventDefault();
        key.stopPropagation();
        const page = Math.max(1, Math.floor((this.renderer.terminalHeight - 10) / 3));
        this.#moveFamilySelection(key.name === "pageup" ? -page : page);
        return;
      }
      if (enter || key.name === "right") {
        key.preventDefault();
        key.stopPropagation();
        void this.#openSelectedFamilyChild();
        return;
      }
      if (escape || key.name === "left") {
        key.preventDefault();
        key.stopPropagation();
        this.#focusComposer();
        return;
      }
      if (key.sequence && !/[\r\n\0-\x1f\x7f]/.test(key.sequence)) {
        key.preventDefault();
        key.stopPropagation();
        return;
      }
    }
    if (this.#familyFocus === "summary" && !key.ctrl && !key.meta) {
      if (enter || key.name === "right") {
        key.preventDefault();
        key.stopPropagation();
        this.#openFamilyBrowser();
        return;
      }
      if (escape || key.name === "up" || key.name === "left") {
        key.preventDefault();
        key.stopPropagation();
        this.#focusComposer();
        return;
      }
      if (key.sequence && !/[\r\n\0-\x1f\x7f]/.test(key.sequence)) {
        key.preventDefault();
        key.stopPropagation();
        const value = key.sequence;
        this.#focusComposer(false);
        this.#setComposerValue(`${this.#composerValue()}${value}`);
        this.#composer.focus();
        this.#render();
        return;
      }
    }
    if (
      this.#familyFocus === "composer"
      && this.#composerValue().length === 0
      && !this.#familyNavigationBlockedByInspector()
    ) {
      if (key.name === "right" && this.#view.familySummary) {
        key.preventDefault();
        key.stopPropagation();
        this.#openFamilyBrowser();
        return;
      }
      if (key.name === "down" && this.#view.familySummary) {
        key.preventDefault();
        key.stopPropagation();
        this.#focusFamilySummary();
        return;
      }
      if (key.name === "left" && this.#view.familyParent) {
        key.preventDefault();
        key.stopPropagation();
        void this.#openFamilyParent();
        return;
      }
      if (key.name === "left" && this.#view.familyRoot === true) {
        key.preventDefault();
        key.stopPropagation();
        void this.#openWorkspaceAgents();
        return;
      }
    }
    if (key.shift && key.name === "r" && this.#detail && !this.#modelEntryProvider) {
      key.preventDefault();
      key.stopPropagation();
      this.#rawDetail = !this.#rawDetail;
      this.#resetDetailScroll = true;
      this.#render();
      return;
    }
    if (enter && !key.meta && !key.ctrl && (key.shift || key.name === "linefeed")) {
      key.preventDefault();
      key.stopPropagation();
      this.#composer.newLine();
      this.#render();
      return;
    }
    if (enter && !key.shift && !key.meta && !key.ctrl) {
      key.preventDefault();
      key.stopPropagation();
      void this.#submit();
      return;
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      key.stopPropagation();
      void this.#interrupt();
      return;
    }
    if (key.ctrl && key.name === "d") {
      key.preventDefault();
      key.stopPropagation();
      this.requestExit();
      return;
    }
    if (
      key.ctrl
      && key.name === "y"
      && !this.#view.workspaceAgents.open
      && this.#view.learning.items.length > 0
    ) {
      key.preventDefault();
      key.stopPropagation();
      const canExpand = selectTerminalHeightLayout(this.renderer.terminalHeight).mode === "normal";
      if (this.#isLearningDockDismissed()) {
        this.#clearLearningDockDismissed();
        this.#learningExpanded = canExpand;
      } else if (this.#learningExpanded && canExpand) {
        this.#dismissLearningDock();
        this.#learningExpanded = false;
      } else if (canExpand) {
        this.#learningExpanded = true;
      }
      this.#render();
      return;
    }
    if (key.ctrl && key.name === "l") {
      if (toggleAllRunDetails(this.#view.runs, this.#expandedRunIds)) {
        key.preventDefault();
        key.stopPropagation();
        this.#render();
        return;
      }
    }
    if (key.ctrl && key.name === "p") {
      key.preventDefault();
      key.stopPropagation();
      this.#paletteDraft = this.#composerValue();
      this.#setComposerValue("/");
      this.#paletteQuery = "/";
      this.#render();
      return;
    }
    if (key.ctrl && key.name === "o") {
      key.preventDefault();
      key.stopPropagation();
      toggleLatestRunDetails(this.#view.runs, this.#expandedRunIds);
      this.#render();
      return;
    }
    if (key.name === "pageup") {
      key.preventDefault();
      this.#scrollActiveView(-Math.max(3, this.renderer.terminalHeight - 8));
      return;
    }
    if (key.name === "pagedown") {
      key.preventDefault();
      this.#scrollActiveView(Math.max(3, this.renderer.terminalHeight - 8));
      return;
    }
    if (escape) {
      key.preventDefault();
      key.stopPropagation();
      this.#dismissInspector();
      return;
    }
    setTimeout(() => {
      if (this.#closed) return;
      const value = this.#composerValue();
      this.#paletteQuery = value.startsWith("/") ? value : "";
      this.#render();
    }, 0);
  };

  #scrollActiveView(delta: number): void {
    if (this.#activeInspector() && this.#detailScrollTimer) {
      clearTimeout(this.#detailScrollTimer);
      this.#detailScrollTimer = null;
    }
    this.#details.stickyScroll = false;
    const target = this.#activeInspector() ? this.#details : this.#timeline;
    target.scrollBy({ x: 0, y: delta });
  }

  #submit(): Promise<void> {
    const value = this.#composerValue().trim();
    if (!value || this.#busy) return Promise.resolve();
    return this.#runCommand(value);
  }

  #composerValue(): string {
    return this.#composer.plainText;
  }

  #setComposerValue(value: string): void {
    this.#composer.setText(value);
    this.#composer.gotoBufferEnd();
  }

  #modelOptions(
    detail: TerminalModelDetail = this.#activeModelDetail()!,
  ): readonly ModelSelectionOption[] {
    return this.#modelEntryProvider
      ? rankModelOptions(
          detail.catalogModels,
          this.#modelEntryProvider,
          this.#modelEntryQuery,
        )
      : [];
  }

  #beginModelEntry(detail: TerminalModelDetail, provider: string): void {
    this.#modelEntryDraft = this.#composerValue();
    this.#modelEntryProvider = provider;
    this.#modelEntryQuery = "";
    this.#modelSelectedIdentity = reconcileSelectedIdentity(
      rankModelOptions(detail.catalogModels, provider, ""),
      null,
      "query-edit",
    );
  }

  #setModelQuery(value: string): void {
    const detail = this.#activeModelDetail();
    const provider = this.#modelEntryProvider;
    if (!detail || !provider) return;
    this.#modelEntryQuery = boundModelSelectionQuery(value);
    this.#modelSelectedIdentity = reconcileSelectedIdentity(
      rankModelOptions(
        detail.catalogModels,
        provider,
        this.#modelEntryQuery,
      ),
      this.#modelSelectedIdentity,
      "query-edit",
    );
    this.#render();
  }

  #appendModelQuery(value: string): void {
    const singleLine = sanitizeTerminalLine(value).replace(/\s+/gu, " ");
    this.#setModelQuery(`${this.#modelEntryQuery}${singleLine}`);
  }

  #leaveModelEntry(): void {
    if (this.#modelEntryDraft !== null) {
      this.#setComposerValue(this.#modelEntryDraft);
    }
    this.#modelEntryProvider = null;
    this.#modelEntryQuery = "";
    this.#modelSelectedIdentity = null;
    this.#modelEntryDraft = null;
  }

  #confirmModelSelection(): void {
    const detail = this.#activeModelDetail();
    const provider = this.#modelEntryProvider;
    if (!detail || !provider) return;
    const selected = this.#modelOptions(detail).find(option =>
      option.identity === this.#modelSelectedIdentity
    );
    if (!selected) {
      this.#showNotice(
        "Type a matching model name or valid exact model ID first.",
        "warning",
      );
      return;
    }
    this.#leaveModelEntry();
    void this.#runCommand(`/model ${provider}:${selected.model}`, true);
  }

  #runCommand(value: string, preserveComposer = false): Promise<void> {
    if (this.#busy) return Promise.resolve();
    const operation = this.#performSubmit(value, preserveComposer);
    this.#activeOperation = operation;
    return operation.finally(() => {
      if (this.#activeOperation === operation) this.#activeOperation = null;
    });
  }

  async #submitSecret(): Promise<void> {
    if (!this.#secretBuffer || this.#busy) return;
    const secret = this.#secretBuffer;
    this.#secretBuffer = "";
    this.#setComposerValue("");
    this.#busy = true;
    this.#render();
    try {
      await this.controller.execute(secret);
    } catch (error) {
      this.showOutput(renderTerminalError(error).split(secret).join("[REDACTED]"));
    } finally {
      this.#busy = false;
      if (!this.#closed) {
        this.#render();
        this.#composer.focus();
      }
    }
  }

  async #performSubmit(value: string, preserveComposer = false): Promise<void> {
    if (!preserveComposer) {
      this.#setComposerValue("");
      this.#paletteQuery = "";
      this.#paletteDraft = null;
    }
    this.#busy = true;
    this.#render();
    try {
      const result = await this.controller.execute(value);
      if (result === "detach" || this.controller.detached) this.requestExit();
    } catch (error) {
      this.showOutput(renderTerminalError(error));
    } finally {
      this.#busy = false;
      if (!this.#closed) {
        this.#render();
        this.#composer.focus();
      }
    }
  }

  #activeModelDetail(): TerminalModelDetail | null {
    return this.#detail?.kind === "model" ? this.#detail : null;
  }

  #activeEffortDetail(): TerminalEffortDetail | null {
    return this.#detail?.kind === "effort" ? this.#detail : null;
  }

  #selectedModelProvider(): TerminalModelProviderDetail | null {
    return this.#activeModelDetail()?.providers[this.#modelProviderIndex] ?? null;
  }

  #familyNavigationBlockedByInspector(): boolean {
    return Boolean(
      this.controller.pendingSecretInput
      || this.#paletteQuery
      || this.#provisionalOutput.size
      || this.#detail
      || this.#modelEntryProvider
      || this.#view.workspaceAgents.open
      || this.#busy,
    );
  }

  #focusFamilySummary(): void {
    if (!this.#view.familySummary) return;
    this.#familyFocus = "summary";
    this.#composer.blur();
    this.#render();
  }

  #openFamilyBrowser(restoredScrollTop?: number): void {
    if (this.#view.historicalCursor !== null) {
      this.#showNotice("Return to live before opening another agent.", "warning");
      return;
    }
    if (!this.#view.familyChildren.length) {
      this.#focusComposer();
      return;
    }
    this.#detail = null;
    this.#rawDetail = false;
    this.#paletteQuery = "";
    this.#paletteDraft = null;
    this.#familyFocus = "browser";
    if (!this.#view.familyChildren.some(child => child.key === this.#familySelectedKey)) {
      this.#familySelectedKey = this.#view.familyChildren[0]?.key ?? null;
    }
    this.controller.setFamilyBrowserOpen?.(true);
    this.#composer.blur();
    this.#resetDetailScroll = restoredScrollTop === undefined;
    if (restoredScrollTop !== undefined && this.#detailScrollTimer) {
      clearTimeout(this.#detailScrollTimer);
      this.#detailScrollTimer = null;
    }
    this.#render();
    if (restoredScrollTop !== undefined) {
      this.#details.stickyScroll = false;
      this.#details.scrollTo({ x: 0, y: restoredScrollTop });
      this.#details.scrollTop = restoredScrollTop;
      this.renderer.requestRender();
    }
  }

  #focusComposer(render = true): void {
    const browserWasOpen = this.#familyFocus === "browser";
    this.#familyFocus = "composer";
    if (browserWasOpen) this.controller.setFamilyBrowserOpen?.(false);
    this.#composer.focus();
    if (render) this.#render();
  }

  #moveFamilySelection(delta: number): void {
    const rows = this.#view.familyChildren;
    if (!rows.length) return;
    const current = rows.findIndex(row => row.key === this.#familySelectedKey);
    const index = Math.min(rows.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta));
    this.#familySelectedKey = rows[index]!.key;
    const rowHeight = (row: TerminalFamilyChildView): number =>
      2 + Number(row.cancellationRequested) + Number(row.activityReasonLabel !== null);
    const rowTop = rows.slice(0, index).reduce((lines, row) => lines + rowHeight(row), 0);
    const viewportLines = Math.max(1, this.renderer.terminalHeight - 10);
    const selectedHeight = rowHeight(rows[index]!);
    const scrollTop = Math.max(0, rowTop - Math.floor((viewportLines - selectedHeight) / 2));
    this.#details.stickyScroll = false;
    this.#details.scrollTo({ x: 0, y: scrollTop });
    this.#render();
  }

  #openSelectedFamilyChild(): Promise<void> {
    const child = this.#view.familyChildren.find(row => row.key === this.#familySelectedKey);
    if (!child) return Promise.resolve();
    if (!child.openable) {
      this.#showNotice(`${child.displayName} is unavailable and cannot be opened.`, "warning");
      return Promise.resolve();
    }
    if (!this.controller.openFamilyChild) {
      this.#showNotice("Family navigation is unavailable in this terminal.", "warning");
      return Promise.resolve();
    }
    this.#rememberFamilyBrowserState();
    return this.#runFamilyTransition(() => this.controller.openFamilyChild!(child.sessionId, child.branchId));
  }

  #openFamilyParent(): Promise<void> {
    if (this.#view.historicalCursor !== null) {
      this.#showNotice("Return to live before opening another agent.", "warning");
      return Promise.resolve();
    }
    const parent = this.#view.familyParent;
    if (!parent) return Promise.resolve();
    if (parent.activity === "unavailable") {
      this.#showNotice("The retained parent route is unavailable.", "warning");
      return Promise.resolve();
    }
    if (!this.controller.openFamilyParent) {
      this.#showNotice("Parent navigation is unavailable in this terminal.", "warning");
      return Promise.resolve();
    }
    return this.#runFamilyTransition(() => this.controller.openFamilyParent!(), true);
  }

  #currentRouteKey(): string {
    const state = this.controller.presentation.state;
    return `${state.sessionId}\u0000${state.branch.id}`;
  }

  #latestLearningItemId(): string | null {
    return this.#view.learning.items.at(-1)?.id ?? null;
  }

  #isLearningDockDismissed(): boolean {
    const latestId = this.#latestLearningItemId();
    if (!latestId) return false;
    return this.#learningDismissedThroughIdByRoute.get(this.#currentRouteKey()) === latestId;
  }

  #dismissLearningDock(): void {
    const latestId = this.#latestLearningItemId();
    if (!latestId) return;
    const routeKey = this.#currentRouteKey();
    this.#learningDismissedThroughIdByRoute.delete(routeKey);
    this.#learningDismissedThroughIdByRoute.set(routeKey, latestId);
    if (this.#learningDismissedThroughIdByRoute.size > 64) {
      const oldest = this.#learningDismissedThroughIdByRoute.keys().next().value;
      if (oldest !== undefined) this.#learningDismissedThroughIdByRoute.delete(oldest);
    }
  }

  #clearLearningDockDismissed(): void {
    this.#learningDismissedThroughIdByRoute.delete(this.#currentRouteKey());
  }

  #rememberFamilyBrowserState(): void {
    if (!this.#familySelectedKey) return;
    const routeKey = this.#currentRouteKey();
    this.#familyBrowserStateByRoute.delete(routeKey);
    this.#familyBrowserStateByRoute.set(routeKey, {
      selectedKey: this.#familySelectedKey,
      scrollTop: Math.max(0, this.#details.scrollTop),
    });
    if (this.#familyBrowserStateByRoute.size > 64) {
      const oldest = this.#familyBrowserStateByRoute.keys().next().value;
      if (oldest !== undefined) this.#familyBrowserStateByRoute.delete(oldest);
    }
  }

  #openWorkspaceAgents(): Promise<void> {
    if (this.#view.historicalCursor !== null) {
      this.#showNotice("Return to live with /live before opening Agents.", "warning");
      return Promise.resolve();
    }
    if (!this.controller.openWorkspaceAgents) {
      this.#showNotice("The workspace Agents view is unavailable in this terminal.", "warning");
      return Promise.resolve();
    }
    return this.#runFamilyTransition(() => this.controller.openWorkspaceAgents!());
  }

  #refreshWorkspaceAgents(): Promise<void> {
    if (!this.controller.refreshWorkspaceAgents) {
      this.#showNotice("The workspace Agents catalog cannot be refreshed in this terminal.", "warning");
      return Promise.resolve();
    }
    return this.#runFamilyTransition(() => this.controller.refreshWorkspaceAgents!());
  }

  #createWorkspaceAgent(): Promise<void> {
    if (!this.controller.createWorkspaceAgent) {
      this.#showNotice("Creating a workspace agent is unavailable in this terminal.", "warning");
      return Promise.resolve();
    }
    return this.#runFamilyTransition(() => this.controller.createWorkspaceAgent!());
  }

  #moveWorkspaceAgentSelection(delta: number): void {
    const rows = this.#view.workspaceAgents.rows;
    if (!rows.length) return;
    const current = rows.findIndex(row => row.key === this.#view.workspaceAgents.selectedKey);
    const index = Math.min(rows.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta));
    this.controller.selectWorkspaceAgent?.(rows[index]!.key);
  }

  #workspaceAgentLineStarts(): Array<{ key: string; line: number }> {
    const lines = workspaceAgentsLines(
      this.#view.workspaceAgents,
      this.#workspaceAgentsContentWidth(),
    );
    const starts: Array<{ key: string; line: number }> = [];
    for (let index = 0; index < lines.length; index++) {
      const key = lines[index]!.rowKey;
      if (key && lines[index - 1]?.rowKey !== key) starts.push({ key, line: index });
    }
    return starts;
  }

  #workspaceAgentsContentWidth(): number {
    const layout = selectTerminalHeightLayout(this.renderer.terminalHeight);
    return Math.max(12, this.renderer.terminalWidth - layout.inspectorPadding * 2);
  }

  #workspaceAgentsViewportLines(): number {
    const layout = selectTerminalHeightLayout(this.renderer.terminalHeight);
    const composerRows = layout.composerRows
      + terminalComposerContentRows(this.#composerValue(), layout.mode)
      - 1;
    return Math.max(1, this.renderer.terminalHeight - layout.headerRows - composerRows - 1);
  }

  #moveWorkspaceAgentPage(direction: -1 | 1): void {
    const starts = this.#workspaceAgentLineStarts();
    if (!starts.length) return;
    const currentIndex = Math.max(0, starts.findIndex(row =>
      row.key === this.#view.workspaceAgents.selectedKey));
    const targetLine = starts[currentIndex]!.line + direction * this.#workspaceAgentsViewportLines();
    const target = direction > 0
      ? starts.find(row => row.line >= targetLine) ?? starts.at(-1)!
      : [...starts].reverse().find(row => row.line <= targetLine) ?? starts[0]!;
    this.controller.selectWorkspaceAgent?.(target.key);
  }

  #centerWorkspaceAgentSelection(): void {
    const selectedKey = this.#view.workspaceAgents.selectedKey;
    if (!selectedKey) return;
    const lines = workspaceAgentsLines(
      this.#view.workspaceAgents,
      this.#workspaceAgentsContentWidth(),
    );
    const rowTop = lines.findIndex(line => line.rowKey === selectedKey);
    if (rowTop < 0) return;
    let rowBottom = rowTop;
    while (lines[rowBottom + 1]?.rowKey === selectedKey) rowBottom++;
    const rowHeight = rowBottom - rowTop + 1;
    const viewportLines = this.#workspaceAgentsViewportLines();
    const scrollTop = Math.max(0, rowTop - Math.floor((viewportLines - rowHeight) / 2));
    this.#details.stickyScroll = false;
    this.#details.scrollTo({ x: 0, y: scrollTop });
    this.renderer.requestRender();
  }

  #openSelectedWorkspaceAgent(): Promise<void> {
    const selected = this.#view.workspaceAgents.rows.find(row =>
      row.key === this.#view.workspaceAgents.selectedKey);
    if (!selected) return Promise.resolve();
    if (!selected.resumable) {
      this.#showNotice(`${selected.displayName} is ${selected.status} and cannot be opened.`, "warning");
      this.#composer.focus();
      return Promise.resolve();
    }
    if (!this.controller.openWorkspaceAgent) {
      this.#showNotice("Workspace root navigation is unavailable in this terminal.", "warning");
      return Promise.resolve();
    }
    return this.#runFamilyTransition(() =>
      this.controller.openWorkspaceAgent!(selected.sessionId, selected.branchId));
  }

  #runFamilyTransition(navigate: () => Promise<void>, restoreFamilyBrowser = false): Promise<void> {
    if (this.#busy) return Promise.resolve();
    const operation = this.#performFamilyTransition(navigate, restoreFamilyBrowser);
    this.#activeOperation = operation;
    return operation.finally(() => {
      if (this.#activeOperation === operation) this.#activeOperation = null;
    });
  }

  async #performFamilyTransition(navigate: () => Promise<void>, restoreFamilyBrowser: boolean): Promise<void> {
    this.#busy = true;
    this.#render();
    try {
      await navigate();
      const restoredState = restoreFamilyBrowser
        ? this.#familyBrowserStateByRoute.get(this.#currentRouteKey()) ?? null
        : null;
      this.#familySelectedKey = restoredState?.selectedKey ?? null;
      if (
        restoredState
        && this.#view.familyChildren.some(child => child.key === restoredState.selectedKey)
      ) {
        this.#openFamilyBrowser(restoredState.scrollTop);
      } else {
        this.#focusComposer(false);
      }
    } catch (error) {
      this.showOutput(renderTerminalError(error, "command"));
    } finally {
      this.#busy = false;
      if (!this.#closed) {
        this.#render();
        if (this.#familyFocus === "composer") this.#composer.focus();
      }
    }
  }

  #activeInspector(): boolean {
    return Boolean(
      this.controller.pendingSecretInput
      || this.#paletteQuery
      || this.#provisionalOutput.size
      || this.#detail
      || this.#notice
      || this.#familyFocus === "browser"
      || this.#view.workspaceAgents.open,
    );
  }

  #clearSecretInput(): void {
    this.#secretBuffer = "";
    this.#setComposerValue("");
  }

  #dismissInspector(): void {
    if (this.#modelEntryProvider) {
      this.#leaveModelEntry();
      this.#render();
      return;
    }
    if (this.#paletteQuery) this.#setComposerValue(this.#paletteDraft ?? "");
    this.#paletteQuery = "";
    this.#paletteDraft = null;
    this.#detail = null;
    this.#rawDetail = false;
    this.#notice = null;
    this.#render();
  }

  #showNotice(text: string, tone: "normal" | "success" | "warning" | "danger" = "normal"): void {
    this.#notice = { text: scrubText(text).slice(0, 800), tone };
    this.#scheduleNoticeDismiss(tone === "danger" ? 8_000 : 4_000);
    this.#render();
  }

  #scheduleNoticeDismiss(milliseconds: number): void {
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    this.#noticeTimer = setTimeout(() => {
      this.#noticeTimer = null;
      this.#notice = null;
      if (!this.#closed) this.#render();
    }, milliseconds);
    this.#noticeTimer.unref?.();
  }

  #interrupt(): Promise<void> {
    if (this.#busy) {
      return this.controller.handleInterrupt().then((decision) => {
        if (decision.action === "detach") this.requestExit();
      }).catch((error) => {
        this.showOutput(renderTerminalError(error, "interrupt"));
      });
    }
    const operation = this.#performInterrupt();
    this.#activeOperation = operation;
    return operation.finally(() => {
      if (this.#activeOperation === operation) this.#activeOperation = null;
    });
  }

  async #performInterrupt(): Promise<void> {
    this.#busy = true;
    this.#render();
    try {
      const decision = await this.controller.handleInterrupt();
      if (decision.action === "detach") this.requestExit();
    } catch (error) {
      this.showOutput(renderTerminalError(error, "interrupt"));
    } finally {
      this.#busy = false;
      if (!this.#closed) {
        this.#render();
        this.#composer.focus();
      }
    }
  }

  #familyHint(compact: boolean): string {
    if (this.#view.workspaceAgents.open) return "";
    if (this.#familyFocus === "browser") {
      return compact ? "↑/↓ · Enter/→ open · ←/Esc close" : "↑/↓ select · Enter/→ open · ←/Esc close";
    }
    if (this.#familyFocus === "summary") return "Enter/→ agents · ↑/←/Esc composer";
    if (this.#view.historicalCursor !== null && (this.#view.familySummary || this.#view.familyParent || this.#view.familyRoot === true)) {
      return "/live before agent navigation";
    }
    return [
      this.#view.familyParent?.activity !== "unavailable" && this.#view.familyParent ? "← parent" : "",
      this.#view.familyRoot === true ? "← agents" : "",
      this.#view.familySummary ? "↓/→ agents" : "",
    ].filter(Boolean).join(" · ");
  }

  #activeInspectorAction(): string {
    if (this.controller.pendingSecretInput) return "Enter save · Esc cancel";
    if (this.#view.workspaceAgents.open) {
      const count = this.#view.workspaceAgents.rows.length;
      return `${count} ${count === 1 ? "agent" : "agents"} · Ctrl-N new · ↑/↓ select · Enter/→ open · Ctrl-R refresh · Esc back`;
    }
    if (this.#modelEntryProvider) return "Type search · ↑/↓ select · Enter save · Esc back";
    if (this.#activeModelDetail()) return "↑/↓ provider · Enter choose · Esc close";
    if (this.#paletteQuery) return "Esc close";
    if (this.#provisionalOutput.size > 0) return "PgUp/PgDn scroll";
    if (this.#familyFocus === "browser") return "";
    if (this.#detail || this.#notice) return "Esc close";
    return "";
  }

  #minimumInspectorText(details: string): string {
    if (this.controller.pendingSecretInput) return "PROVIDER LOGIN · Enter save · Esc cancel";
    if (this.#view.workspaceAgents.open) {
      const selected = this.#view.workspaceAgents.rows.find(row =>
        row.key === this.#view.workspaceAgents.selectedKey);
      return selected
        ? `AGENTS · ${selected.displayName} · ${selected.status} · ${selected.resumable ? "Enter/→ open" : "cannot open"} · Ctrl-N new · Esc back`
        : `AGENTS · ${this.#view.workspaceAgents.refresh} · Ctrl-N new · Esc back`;
    }
    if (this.#paletteQuery) return "COMMANDS · type to filter · Esc close";
    if (this.#provisionalOutput.size > 0) return "PROVISIONAL OUTPUT · PgUp/PgDn scroll";
    if (this.#familyFocus === "browser") {
      const selected = this.#view.familyChildren.find(child => child.key === this.#familySelectedKey)
        ?? this.#view.familyChildren[0];
      return selected
        ? `AGENT FAMILY · ${familyActivityMarker(selected.activity)} ${selected.displayName} · Enter/→ open · ←/Esc close`
        : "AGENT FAMILY · no retained direct children · Esc close";
    }
    if (this.#activeModelDetail()) {
      if (this.#modelEntryProvider) {
        const selected = this.#modelOptions().find(option =>
          option.identity === this.#modelSelectedIdentity
        );
        return fitTerminalLine(
          `MODEL · ${selected?.model ?? this.#modelEntryProvider} · Enter save · Esc back`,
          Math.max(1, this.renderer.terminalWidth),
        );
      }
      return "MODEL · ↑/↓ provider · Enter choose · Esc close";
    }
    const firstLine = details.split("\n").find(line => line.trim()) ?? "DETAILS";
    return `${firstLine} · Esc close`;
  }

  #syncRunAnimation(): void {
    const animating = this.#view.runs.some(run =>
      run.active || run.status === "queued" || run.status === "running"
    );
    if (!animating) {
      this.#stopRunAnimation();
      this.#runAnimationFrame = 0;
      this.#transcript.setAnimationFrame(0);
      return;
    }
    if (this.#runAnimationTimer) return;
    this.#runAnimationTimer = setInterval(() => {
      if (this.#closed) {
        this.#stopRunAnimation();
        return;
      }
      this.#runAnimationFrame += 1;
      this.#transcript.setAnimationFrame(this.#runAnimationFrame);
      this.renderer.requestRender();
    }, RUN_ANIMATION_INTERVAL_MS);
    this.#runAnimationTimer.unref?.();
  }

  #stopRunAnimation(): void {
    if (!this.#runAnimationTimer) return;
    clearInterval(this.#runAnimationTimer);
    this.#runAnimationTimer = null;
  }

  #render(): void {
    const width = this.renderer.terminalWidth;
    const height = this.renderer.terminalHeight;
    const wide = width >= 96;
    const layout = selectTerminalHeightLayout(height);
    const compact = layout.mode !== "normal";
    const workspaceAgentsActive = this.#view.workspaceAgents.open;
    const activeInspector = this.#activeInspector();
    const composerContentRows = terminalComposerContentRows(this.#composerValue(), layout.mode);
    const learningVisible = !activeInspector
      && !workspaceAgentsActive
      && layout.mode !== "minimum"
      && width >= 20
      && this.#view.learning.items.length > 0
      && !this.#isLearningDockDismissed();
    const learningExpanded = learningVisible
      && layout.mode === "normal"
      && this.#learningExpanded;
    const learningDockWidth = Math.max(
      1,
      Math.min(width - 2, 92, Math.max(28, Math.round(width * 0.82))),
    );
    const learningLines = learningVisible
      ? learningDockLines(
          this.#view.learning,
          learningExpanded,
          Math.max(1, learningDockWidth - 4),
        )
      : [];
    this.#header.height = layout.headerRows;
    this.#main.minHeight = 1;
    this.#learningDockHost.visible = learningVisible;
    this.#learningDockHost.height = learningVisible ? learningLines.length + 2 : 0;
    this.#learningDock.width = learningDockWidth;
    this.#learningDock.height = learningVisible ? learningLines.length + 2 : 0;
    this.#learningDockText.height = Math.max(1, learningLines.length);
    this.#learningDockText.content = learningLines.join("\n");
    this.#composerBox.height = layout.composerRows + composerContentRows - 1;
    this.#composerBox.paddingX = terminalComposerPaddingX(width);
    this.#composerBox.paddingTop = layout.composerPaddingTop;
    this.#composerBox.paddingBottom = layout.composerPaddingBottom;
    this.#composerContent.height = composerContentRows;
    this.#composer.height = composerContentRows;
    this.#details.padding = layout.inspectorPadding;
    this.#details.border = !workspaceAgentsActive && wide && layout.mode !== "minimum" ? ["left"] : false;
    this.#details.visible = activeInspector;
    this.#timeline.visible = !workspaceAgentsActive && (!activeInspector || (wide && layout.mode !== "minimum"));
    const detailsWidth = workspaceAgentsActive
      ? width
      : wide
        ? Math.min(64, Math.max(40, Math.round(width * 0.4)))
        : width;
    const detailsContentWidth = Math.max(
      12,
      detailsWidth - layout.inspectorPadding * 2 - (wide && layout.mode !== "minimum" ? 1 : 0),
    );
    const familyBrowserActive = this.#familyFocus === "browser";
    this.#details.width = workspaceAgentsActive || !wide ? "100%" : detailsWidth;
    const provisional = [...this.#provisionalOutput.values()].join("");
    const baseDetails = this.controller.pendingSecretInput
      ? [
          "PROVIDER LOGIN",
          "",
          this.#selectedModelProvider()?.displayName ?? this.controller.pendingSecretProvider ?? "Provider",
          "API key input is hidden.",
          "The key is stored only in the owner-only local auth file.",
          "",
          "Enter saves · Esc cancels",
        ].join("\n")
      : workspaceAgentsActive
        ? workspaceAgentsLines(this.#view.workspaceAgents, detailsContentWidth).map(line => line.text).join("\n")
      : this.#paletteQuery
      ? paletteText(this.#paletteQuery)
      : provisional
        ? `PROVISIONAL OUTPUT\n${provisional}`
        : familyBrowserActive
          ? renderFamilyBrowser(this.#view, this.#familySelectedKey, compact, width >= 96, detailsContentWidth)
        : this.#detail
          ? this.#detail.kind === "model" && !this.#rawDetail
            ? renderModelInspector(
                this.#detail,
                this.#modelProviderIndex,
                this.#modelEntryProvider,
                this.#modelEntryQuery,
                this.#modelSelectedIdentity,
                detailsContentWidth,
              )
            : this.#detail.kind === "effort" && !this.#rawDetail
              ? renderEffortInspector(this.#detail, this.#effortIndex)
              : formatTerminalDetail(this.#detail, { raw: this.#rawDetail })
          : "";
    const notice = noticeText(this.#notice);
    const fullDetails = notice ? `${notice}\n${baseDetails ? `\n${baseDetails}` : ""}` : baseDetails;
    const details = layout.mode === "minimum" && activeInspector
      ? this.#minimumInspectorText(fullDetails)
      : baseDetails;
    const history = this.#view.historicalCursor ? ` · history@${this.#view.historicalCursor}` : "";
    const breadcrumb = formatTerminalBreadcrumb(
      this.#view.ancestry,
      this.#view.branchName,
      Math.max(8, width - history.length - 2),
    );
    const primaryHeader = workspaceAgentsActive ? "Agents" : `${breadcrumb}${history}`;
    const secondaryHeader = workspaceAgentsActive
      ? `${this.#view.workspaceLabel} · ${this.#view.workspaceAgents.rows.length} roots · ${this.#view.workspaceAgents.refresh}`
      : `${this.#view.model} · ${this.#view.runState} · ${this.#view.connection}`;
    this.#header.content = layout.mode === "normal"
      ? `${primaryHeader}\n${secondaryHeader}`
      : workspaceAgentsActive
        ? `Agents · ${this.#view.workspaceLabel}`
        : primaryHeader;
    this.#header.fg = this.#view.connection === "connected" ? TERMINAL_THEME.text : TERMINAL_THEME.warning;
    this.#transcript.reconcile(this.#view, this.#expandedRunIds);
    this.#syncRunAnimation();
    const styledFamily = familyBrowserActive && layout.mode !== "minimum"
      ? styledFamilyBrowser(
          familyBrowserLines(this.#view, this.#familySelectedKey, compact, width >= 96, detailsContentWidth),
          detailsContentWidth,
        )
      : null;
    const styledWorkspace = workspaceAgentsActive && layout.mode !== "minimum"
      ? styledWorkspaceAgents(
          workspaceAgentsLines(this.#view.workspaceAgents, detailsContentWidth),
          detailsContentWidth,
        )
      : null;
    this.#noticeText.visible = Boolean(notice) && layout.mode !== "minimum";
    this.#noticeText.content = notice ? `${notice}\n` : "";
    this.#noticeText.fg = terminalToneColor(this.#notice?.tone ?? "normal");
    this.#detailsText.wrapMode = styledWorkspace || styledFamily ||
        this.#detail?.kind === "model"
      ? "none"
      : "word";
    this.#detailsText.content = styledWorkspace ?? styledFamily ?? details;
    const selectedFamily = this.#view.familyChildren.find(child => child.key === this.#familySelectedKey);
    this.#detailsText.fg = layout.mode === "minimum" && this.#notice
      ? terminalToneColor(this.#notice.tone)
      : provisional
        ? TERMINAL_THEME.provisional
        : workspaceAgentsActive
          ? TERMINAL_THEME.muted
        : this.#familyFocus === "browser" && selectedFamily
          ? terminalToneColor(terminalFamilyTone(selectedFamily.activity))
          : TERMINAL_THEME.muted;
    const familyRefresh = familyRefreshSuffix(this.#view.familyRefresh);
    this.#familySummary.visible = !workspaceAgentsActive && layout.showFamilySummary && this.#view.familySummary !== null;
    this.#familySummary.content = this.#view.familySummary
      ? `${this.#familyFocus === "summary" ? ">" : " "} ${formatTerminalFamilySummary(
          this.#view.familySummary,
          Math.max(1, width - familyRefresh.length - 3),
        )}${familyRefresh}`
      : "";
    this.#familySummary.bg = this.#familyFocus === "summary" ? TERMINAL_THEME.border : TERMINAL_THEME.raised;
    const familyTone = this.#view.familySummary?.attention
      ? "attention"
      : this.#view.familySummary?.working
        ? "working"
        : "idle";
    this.#familySummary.fg = this.#familyFocus === "summary"
      ? TERMINAL_THEME.text
      : terminalToneColor(terminalFamilyTone(familyTone));
    if (this.#resetDetailScroll) {
      this.#resetDetailScroll = false;
      this.#details.stickyScroll = false;
      this.#details.scrollTo({ x: 0, y: 0 });
      this.#details.scrollTop = 0;
      if (this.#detailScrollTimer) clearTimeout(this.#detailScrollTimer);
      this.#detailScrollTimer = setTimeout(() => {
        this.#detailScrollTimer = null;
        if (this.#closed) return;
        this.#details.stickyScroll = false;
        this.#details.scrollTo({ x: 0, y: 0 });
        this.#details.scrollTop = 0;
        this.renderer.requestRender();
      }, 0);
      this.#detailScrollTimer.unref?.();
    }
    if (this.#modelEntryProvider) {
      const options = this.#modelOptions();
      const window = visibleSelectionWindow(
        options,
        this.#modelSelectedIdentity,
      );
      const selectedIndex = window.options.findIndex(option =>
        option.identity === this.#modelSelectedIdentity
      );
      const scrollTop = Math.max(0, (selectedIndex - 5) * 2);
      this.#details.stickyScroll = false;
      this.#details.scrollTo({ x: 0, y: scrollTop });
      this.#details.scrollTop = scrollTop;
    }
    this.#composer.placeholder = this.#busy
      ? "Working…"
      : this.controller.pendingSecretInput
        ? "API key (input hidden)…"
        : this.#modelEntryProvider
          ? `Model ID for ${this.#modelEntryProvider}…`
          : workspaceAgentsActive
            ? "Search retained root work…"
          : this.#view.composerPlaceholder;
    this.#composerPrompt.content = workspaceAgentsActive ||
        this.#modelEntryProvider
      ? "⌕ "
      : "› ";
    const familyHint = this.#familyHint(compact);
    const footer = layoutTerminalFooter({
      width: Math.max(1, width - 2),
      trustLabel: this.#view.trustLabel,
      connection: this.#view.connection,
      attentionCount: this.#view.attentionCount,
      recoveryLabel: this.#view.recoveryLabel,
      budgetLabel: this.#view.budgetLabel,
      activeActionHint: this.#activeInspectorAction(),
      familyHint,
    });
    this.#footerLeft.content = footer.left;
    this.#footerLeft.fg = this.#view.attentionCount > 0
      || this.#view.connection !== "connected"
      || this.#view.recoveryLabel !== "recovery healthy"
      ? TERMINAL_THEME.warning
      : TERMINAL_THEME.muted;
    this.#footerRight.content = footer.right;
    this.#footerRight.width = footer.right.length;
    this.renderer.setTerminalTitle(workspaceAgentsActive
      ? `Agencity — Agents — ${this.#view.workspaceLabel}`
      : `Agencity — ${this.#view.sessionName}`);
    this.renderer.requestRender();
  }
}

export class OpenTerminalUI {
  readonly #input: NodeJS.ReadStream;
  readonly #output: NodeJS.WriteStream;

  constructor(readonly client: TerminalAgentClient, readonly options: OpenTerminalUIOptions = {}) {
    this.#input = options.input ?? stdin;
    this.#output = options.output ?? stdout;
  }

  async run(sessionId: string, branchId: string): Promise<void> {
    let app: OpenTuiApp | null = null;
    let renderer: CliRenderer | null = null;
    let alternateScrollEnabled = false;
    let attached = false;
    let receivedSignal: NodeJS.Signals | null = null;
    const pendingOutput: string[] = [];
    const pendingDetails: Array<TerminalDetail | null> = [];
    const pendingProvisional = new Map<string, string>();
    const controller = new TerminalUI(this.client, {
      ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
      ...(this.options.workspaceLabel ? { workspaceLabel: this.options.workspaceLabel } : {}),
      interactive: false,
      manageSignals: false,
      onOutput: value => {
        if (app) app.showOutput(value);
        else pendingOutput.push(value);
      },
      onDetail: detail => {
        if (app) app.showDetail(detail);
        else pendingDetails.push(detail);
      },
      onProvisionalOutput: (effectId, value) => {
        if (app) app.showProvisional(effectId, value);
        else pendingProvisional.set(effectId, `${pendingProvisional.get(effectId) ?? ""}${value}`);
      },
      onProvisionalDiscard: (effectIds, reason) => {
        if (app) app.discardProvisional(effectIds, reason);
        else for (const effectId of effectIds) pendingProvisional.delete(effectId);
      },
    });
    const requestSignalExit = (signal: NodeJS.Signals) => (): void => {
      receivedSignal = signal;
      app?.requestExit();
    };
    const onSigint = requestSignalExit("SIGINT");
    const onSigterm = requestSignalExit("SIGTERM");
    const onSighup = requestSignalExit("SIGHUP");
    const handleAlternateScrollInput = (sequence: string): boolean =>
      alternateScrollEnabled && (app?.handleAlternateScrollInput(sequence) ?? false);
    const handleTerminalLinefeedInput = (sequence: string): boolean =>
      app?.handleTerminalLinefeedInput(sequence) ?? false;
    const enableAlternateScroll = (): void => {
      const capabilities = renderer?.capabilities as { kitty_keyboard?: boolean } | null | undefined;
      if (alternateScrollEnabled || capabilities?.kitty_keyboard !== true) return;
      this.#output.write(`${ENABLE_APPLICATION_CURSOR_KEYS}${ENABLE_ALTERNATE_SCROLL}`);
      alternateScrollEnabled = true;
    };
    try {
      await controller.attach(sessionId, branchId, false);
      attached = true;
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
      process.on("SIGHUP", onSighup);
      renderer = await createCliRenderer({
        stdin: this.#input,
        stdout: this.#output,
        exitOnCtrlC: false,
        exitSignals: [],
        screenMode: "alternate-screen",
        useMouse: false,
        useKittyKeyboard: { disambiguate: true },
        prependInputHandlers: [handleTerminalLinefeedInput, handleAlternateScrollInput],
        autoFocus: false,
        clearOnShutdown: true,
        consoleMode: "disabled",
      });
      renderer.on("capabilities", enableAlternateScroll);
      enableAlternateScroll();
      app = new OpenTuiApp(renderer, controller);
      for (const value of pendingOutput) app.showOutput(value);
      for (const detail of pendingDetails) app.showDetail(detail);
      for (const [effectId, value] of pendingProvisional) app.showProvisional(effectId, value);
      if (receivedSignal) app.requestExit();
      await app.run();
      await app.settle();
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      process.off("SIGHUP", onSighup);
      app?.destroy();
      renderer?.off("capabilities", enableAlternateScroll);
      if (alternateScrollEnabled) this.#output.write(`${DISABLE_ALTERNATE_SCROLL}${DISABLE_APPLICATION_CURSOR_KEYS}`);
      if (attached) await controller.detach(false);
      renderer?.destroy();
    }

    if (receivedSignal) {
      process.kill(process.pid, receivedSignal);
      return;
    }
    let serviceStatus: ManagedServiceStatusView | null = null;
    if (this.client.serviceStatus) {
      const timedOut = Symbol("service-status-timeout");
      const statusRequest = this.client.serviceStatus()
        .then(value => value as ManagedServiceStatusView)
        .catch(() => null);
      const statusResult = await Promise.race([statusRequest, Bun.sleep(750).then(() => timedOut)]);
      if (statusResult === timedOut) this.client.abortPendingRequests?.("Detach status timed out");
      else serviceStatus = statusResult as ManagedServiceStatusView | null;
    }
    this.#output.write(`${formatManagedDetach(serviceStatus)}\n`);
  }
}


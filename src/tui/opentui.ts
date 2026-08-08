import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  createCliRenderer,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
  type KeyEvent,
  type PasteEvent,
  decodePasteBytes,
} from "@opentui/core";
import { stdin, stdout } from "node:process";
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
  type TerminalFamilyChildView,
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
  type TerminalDetail,
  type TerminalEffortDetail,
  type TerminalModelDetail,
  type TerminalModelProviderDetail,
} from "./detail-model.ts";

export interface OpenTerminalUIOptions {
  readonly workspaceId?: string;
  readonly input?: NodeJS.ReadStream;
  readonly output?: NodeJS.WriteStream;
}

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

function renderFamilyBrowser(
  view: TerminalScreenView,
  selectedKey: string | null,
  compact = false,
  showModel = false,
): string {
  if (compact) {
    const selected = view.familyChildren.find(child => child.key === selectedKey) ?? view.familyChildren[0];
    return [
      `AGENT FAMILY · ${view.sessionName}`,
      selected ? `> ${familyActivityMarker(selected.activity)} ${selected.displayName} — ${selected.activityLabel}` : "No retained direct children.",
    ].join("\n");
  }
  const lines = [
    "AGENT FAMILY",
    "",
    `Current: ${view.sessionName}`,
    view.familyRefresh === "current" ? "Direct children" : `Direct children · ${view.familyRefresh}`,
  ];
  for (const child of view.familyChildren) {
    const selected = child.key === selectedKey;
    lines.push(
      `${selected ? ">" : " "} ${familyActivityMarker(child.activity)} ${child.displayName} — ${child.activityLabel}${showModel && child.model ? ` · ${child.model}` : ""}`,
      `    ${child.task}`,
    );
    if (child.cancellationRequested) lines.push("    cancellation requested");
    if (child.activityReasonLabel) lines.push(`    ${child.activityReasonLabel}`);
  }
  if (!view.familyChildren.length) lines.push("", "No retained direct children.");
  lines.push("", "↑/↓ select · Enter/→ open · ←/Esc close · PgUp/PgDn scroll");
  return lines.join("\n");
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
    "Ctrl-P commands · Ctrl-O activity · PgUp/PgDn scroll · Ctrl-C stop/detach · Ctrl-D detach · Esc close",
  ].join("\n");
}

function catalogModelsForProvider(
  detail: TerminalModelDetail,
  provider: string | null | undefined,
  query = "",
): readonly TerminalModelDetail["catalogModels"][number][] {
  const normalized = query.trim().toLowerCase();
  return detail.catalogModels.filter(model =>
    (provider === "vercel" || model.model.startsWith(`${provider}/`))
    && (!normalized || model.model.toLowerCase().includes(normalized) || model.displayName.toLowerCase().includes(normalized)));
}

function renderModelInspector(
  detail: TerminalModelDetail,
  selectedIndex: number,
  entryProvider: string | null,
  catalogIndex: number,
  query: string,
): string {
  const currentProvider = detail.providers.find(provider => provider.name === detail.current.provider);
  const selectedProvider = entryProvider ?? detail.providers[selectedIndex]?.name;
  const catalogModels = catalogModelsForProvider(detail, selectedProvider, entryProvider ? query : "");
  if (entryProvider) {
    const provider = detail.providers.find(item => item.name === entryProvider);
    const selectedCatalogIndex = catalogModels.length ? catalogIndex % catalogModels.length : -1;
    return [
      "MODEL",
      "",
      "Choose model",
      provider?.displayName ?? entryProvider,
      "Type to filter the catalog, or enter an exact provider model ID.",
      provider?.name === "vercel" ? "Gateway model IDs may contain /." : "",
      ...(catalogModels.length ? [
        "",
        "Catalog",
        ...catalogModels.slice(0, 8).flatMap((model, index) => [
          `${index === selectedCatalogIndex ? ">" : " "} ${model.displayName} · ${model.model}`,
          `  ${model.contextWindowTokens === null ? "context unknown" : `${Math.round(model.contextWindowTokens / 1_000)}k context`} · ${model.reasoning.status === "listed" ? "effort" : model.reasoning.status === "unverified" ? "effort (unverified)" : "fixed"}${model.stale ? " · stale" : ""}`,
        ]),
      ] : []),
      "",
      "Current",
      `${currentProvider?.displayName ?? detail.current.provider} · ${detail.current.model}`,
      "",
      "↑/↓ model · Enter save · Esc back",
    ].filter((line, index, lines) => line || lines[index - 1] !== "").join("\n");
  }
  const lines = [
    "MODEL",
    "",
    "Current",
    `${currentProvider?.usable ? "✓" : "!"} ${currentProvider?.displayName ?? detail.current.provider}`,
    `  ${detail.current.model}`,
    `  Credential: ${currentProvider?.credentialLabel ?? "unavailable"}`,
    "",
    "Workspace default",
    `  ${detail.workspaceDefault ?? "Not set"}`,
    "",
    "Providers",
  ];
  detail.providers.forEach((provider, index) => {
    const selected = index === selectedIndex;
    lines.push(`${selected ? ">" : " "} ${provider.usable ? "✓" : "○"} ${provider.displayName}`);
    lines.push(`    ${provider.credentialLabel}`);
    if (selected && !provider.usable && provider.remediation) lines.push(`    ${provider.remediation}`);
  });
  if (catalogModels.length) {
    lines.push("", "Catalog models");
    for (const model of catalogModels.slice(0, 6)) {
      const pricing = model.pricing === null ? "price unknown"
        : `$${(model.pricing.inputUsdPerToken * 1_000_000).toFixed(2)}/$${(model.pricing.outputUsdPerToken * 1_000_000).toFixed(2)} per 1M`;
      lines.push(
        `  ${model.displayName} · ${model.model}`,
        `    ${model.contextWindowTokens === null ? "context unknown" : `${Math.round(model.contextWindowTokens / 1_000)}k context`} · ${pricing} · ${model.reasoning.status === "listed" ? "effort" : model.reasoning.status === "unverified" ? "effort (unverified)" : "fixed"}${model.stale ? " · stale" : ""}`,
      );
    }
  }
  lines.push("", "↑/↓ provider · Enter choose · L login · X logout", "Shift-R raw · Esc close");
  return lines.join("\n");
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
  abortPendingOperations?(): void;
}

export class OpenTuiApp {
  readonly #syntaxStyle = createTerminalSyntaxStyle();
  readonly #root: BoxRenderable;
  readonly #header: TextRenderable;
  readonly #main: BoxRenderable;
  readonly #timeline: ScrollBoxRenderable;
  readonly #transcript: TerminalTranscript;
  readonly #details: ScrollBoxRenderable;
  readonly #detailsText: TextRenderable;
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
  #paletteQuery = "";
  #paletteDraft: string | null = null;
  #modelProviderIndex = 0;
  #modelEntryProvider: string | null = null;
  #modelCatalogIndex = 0;
  #effortIndex = 0;
  #resetDetailScroll = false;
  #busy = false;
  #closed = false;
  #activeOperation: Promise<void> | null = null;
  #secretBuffer = "";
  #familyFocus: "composer" | "summary" | "browser" = "composer";
  #familySelectedKey: string | null = null;

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
    this.#detailsText = new TextRenderable(renderer, {
      id: "agencity-details-text",
      width: "100%",
      height: "auto",
      fg: TERMINAL_THEME.muted,
      wrapMode: "word",
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
      onSubmit: () => { void this.#submit(); },
      onContentChange: () => { if (!this.#closed) this.#render(); },
      onKeyDown: key => {
        if (!this.controller.pendingSecretInput && (key.name === "escape" || key.name === "esc" || key.sequence === "\u001b")) {
          key.preventDefault();
          key.stopPropagation();
          this.#dismissInspector();
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

    this.#details.add(this.#detailsText);
    this.#main.add(this.#timeline);
    this.#main.add(this.#details);
    this.#composerContent.add(this.#composerPrompt);
    this.#composerContent.add(this.#composer);
    this.#composerBox.add(this.#composerContent);
    this.#footer.add(this.#footerLeft);
    this.#footer.add(this.#footerRight);
    this.#root.add(this.#header);
    this.#root.add(this.#main);
    this.#root.add(this.#composerBox);
    this.#root.add(this.#familySummary);
    this.#root.add(this.#footer);
    renderer.root.add(this.#root);

    this.#unsubscribe = controller.subscribePresentation(presentation => {
      const previousIndex = this.#view.familyChildren.findIndex(child => child.key === this.#familySelectedKey);
      this.#view = buildTerminalScreen(presentation);
      if (this.#familyFocus === "browser") {
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
      this.#modelEntryProvider = null;
      this.#render();
      return;
    }
    const previousProvider = this.#selectedModelProvider()?.name;
    this.#detail = detail;
    this.#rawDetail = detail.kind === "raw";
    this.#paletteQuery = "";
    this.#paletteDraft = null;
    this.#modelEntryProvider = null;
    this.#modelCatalogIndex = 0;
    if (detail.kind === "model") {
      const selected = detail.providers.findIndex(provider => provider.name === (previousProvider ?? detail.current.provider));
      this.#modelProviderIndex = Math.max(0, selected);
    } else if (detail.kind === "effort") {
      this.#effortIndex = Math.max(0, detail.options.indexOf(detail.current));
    }
    this.#resetDetailScroll = true;
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
    this.controller.abortPendingOperations?.();
    this.#resolveDone();
  }

  destroy(): void {
    this.#closed = true;
    if (this.#familyFocus === "browser") this.controller.setFamilyBrowserOpen?.(false);
    this.#clearSecretInput();
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    if (this.#detailScrollTimer) clearTimeout(this.#detailScrollTimer);
    this.#unsubscribe();
    this.renderer.keyInput.off("keypress", this.#onKey);
    this.renderer.keyInput.off("paste", this.#onPaste);
    this.renderer.off(CliRenderEvents.RESIZE, this.#onResize);
    this.#root.destroyRecursively();
    this.#syntaxStyle.destroy();
  }

  #onResize = (): void => {
    if (this.#activeInspector()) this.#resetDetailScroll = true;
    this.#render();
    if (this.#familyFocus === "composer") this.#composer.focus();
  };

  #onPaste = (event: PasteEvent): void => {
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
    const modelDetail = this.#activeModelDetail();
    if (modelDetail && !this.#paletteQuery && this.#provisionalOutput.size === 0 && !this.#rawDetail) {
      if (this.#modelEntryProvider) {
        const catalogModels = catalogModelsForProvider(modelDetail, this.#modelEntryProvider, this.#composerValue());
        if ((key.name === "up" || key.name === "down") && catalogModels.length) {
          key.preventDefault();
          key.stopPropagation();
          const delta = key.name === "up" ? -1 : 1;
          this.#modelCatalogIndex = (this.#modelCatalogIndex + delta + catalogModels.length) % catalogModels.length;
          this.#render();
          return;
        }
        if (escape) {
          key.preventDefault();
          key.stopPropagation();
          this.#dismissInspector();
          return;
        }
        if ((key.name === "return" || key.name === "linefeed" || key.name === "kpenter") && !key.meta && !key.ctrl) {
          key.preventDefault();
          key.stopPropagation();
          const query = this.#composerValue().trim();
          const exact = catalogModels.find(model => model.model.toLowerCase() === query.toLowerCase());
          const modelId = exact?.model ?? catalogModels[this.#modelCatalogIndex % Math.max(1, catalogModels.length)]?.model ?? query;
          if (!modelId) {
            this.#showNotice("Enter a model ID first.", "warning");
            return;
          }
          void this.#runCommand(`/model ${this.#modelEntryProvider}:${modelId}`);
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
          this.#modelEntryProvider = provider.name;
          this.#modelCatalogIndex = 0;
          this.#setComposerValue("");
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
          if (key.name === "l") void this.#runCommand(`/model login ${provider.name}`);
          else void this.#runCommand(`/model logout ${provider.name}`);
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
        if (effort) void this.#runCommand(`/effort ${effort}`);
        return;
      }
    }
    const enter = key.name === "return" || key.name === "linefeed" || key.name === "kpenter";
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
    }
    if (key.shift && key.name === "r" && this.#detail && !this.#modelEntryProvider) {
      key.preventDefault();
      key.stopPropagation();
      this.#rawDetail = !this.#rawDetail;
      this.#resetDetailScroll = true;
      this.#render();
      return;
    }
    if (enter && key.shift && !key.meta && !key.ctrl) {
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
      const latest = [...this.#view.runs].reverse().find(run => run.steps.length > 0);
      if (latest) {
        if (this.#expandedRunIds.has(latest.id)) this.#expandedRunIds.delete(latest.id);
        else this.#expandedRunIds.add(latest.id);
      }
      this.#render();
      return;
    }
    if (key.name === "pageup") {
      key.preventDefault();
      this.#details.stickyScroll = false;
      const delta = -Math.max(3, this.renderer.terminalHeight - 8);
      this.#activeInspector() ? this.#details.scrollBy({ x: 0, y: delta }) : this.#timeline.scrollBy({ x: 0, y: delta });
      return;
    }
    if (key.name === "pagedown") {
      key.preventDefault();
      this.#details.stickyScroll = false;
      const delta = Math.max(3, this.renderer.terminalHeight - 8);
      this.#activeInspector() ? this.#details.scrollBy({ x: 0, y: delta }) : this.#timeline.scrollBy({ x: 0, y: delta });
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

  #runCommand(value: string): Promise<void> {
    if (this.#busy) return Promise.resolve();
    const operation = this.#performSubmit(value);
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

  async #performSubmit(value: string): Promise<void> {
    this.#setComposerValue("");
    this.#paletteQuery = "";
    this.#paletteDraft = null;
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
      || this.#busy,
    );
  }

  #focusFamilySummary(): void {
    if (!this.#view.familySummary) return;
    this.#familyFocus = "summary";
    this.#composer.blur();
    this.#render();
  }

  #openFamilyBrowser(): void {
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
    this.#resetDetailScroll = true;
    this.#render();
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
    return this.#runFamilyTransition(() => this.controller.openFamilyParent!());
  }

  #runFamilyTransition(navigate: () => Promise<void>): Promise<void> {
    if (this.#busy) return Promise.resolve();
    const operation = this.#performFamilyTransition(navigate);
    this.#activeOperation = operation;
    return operation.finally(() => {
      if (this.#activeOperation === operation) this.#activeOperation = null;
    });
  }

  async #performFamilyTransition(navigate: () => Promise<void>): Promise<void> {
    this.#busy = true;
    this.#render();
    try {
      await navigate();
      this.#familySelectedKey = null;
      this.#focusComposer(false);
    } catch (error) {
      this.showOutput(renderTerminalError(error, "command"));
    } finally {
      this.#busy = false;
      if (!this.#closed) {
        this.#render();
        this.#composer.focus();
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
      || this.#familyFocus === "browser",
    );
  }

  #clearSecretInput(): void {
    this.#secretBuffer = "";
    this.#setComposerValue("");
  }

  #dismissInspector(): void {
    if (this.#modelEntryProvider) {
      this.#modelEntryProvider = null;
      this.#setComposerValue("");
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
    if (this.#busy) return Promise.resolve();
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
    if (this.#familyFocus === "browser") {
      return compact ? "↑/↓ · Enter/→ open · ←/Esc close" : "↑/↓ select · Enter/→ open · ←/Esc close";
    }
    if (this.#familyFocus === "summary") return "Enter/→ agents · ↑/←/Esc composer";
    if (this.#view.historicalCursor !== null && (this.#view.familySummary || this.#view.familyParent)) {
      return "/live before agent navigation";
    }
    return [
      this.#view.familyParent?.activity !== "unavailable" && this.#view.familyParent ? "← parent" : "",
      this.#view.familySummary ? "↓ agents" : "",
    ].filter(Boolean).join(" · ");
  }

  #activeInspectorAction(): string {
    if (this.controller.pendingSecretInput) return "Enter save · Esc cancel";
    if (this.#modelEntryProvider) return "Enter save · Esc back";
    if (this.#activeModelDetail()) return "↑/↓ provider · Enter choose · Esc close";
    if (this.#paletteQuery) return "Esc close";
    if (this.#provisionalOutput.size > 0) return "PgUp/PgDn scroll";
    if (this.#familyFocus === "browser") return "";
    if (this.#detail || this.#notice) return "Esc close";
    return "";
  }

  #minimumInspectorText(details: string): string {
    if (this.controller.pendingSecretInput) return "PROVIDER LOGIN · Enter save · Esc cancel";
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
      return this.#modelEntryProvider
        ? `MODEL · ${this.#modelEntryProvider} ID · Enter save · Esc back`
        : "MODEL · ↑/↓ provider · Enter choose · Esc close";
    }
    const firstLine = details.split("\n").find(line => line.trim()) ?? "DETAILS";
    return `${firstLine} · Esc close`;
  }

  #render(): void {
    const width = this.renderer.terminalWidth;
    const height = this.renderer.terminalHeight;
    const wide = width >= 96;
    const layout = selectTerminalHeightLayout(height);
    const compact = layout.mode !== "normal";
    const activeInspector = this.#activeInspector();
    const composerContentRows = terminalComposerContentRows(this.#composerValue(), layout.mode);
    this.#header.height = layout.headerRows;
    this.#main.minHeight = 1;
    this.#composerBox.height = layout.composerRows + composerContentRows - 1;
    this.#composerBox.paddingX = terminalComposerPaddingX(width);
    this.#composerBox.paddingTop = layout.composerPaddingTop;
    this.#composerBox.paddingBottom = layout.composerPaddingBottom;
    this.#composerContent.height = composerContentRows;
    this.#composer.height = composerContentRows;
    this.#details.padding = layout.inspectorPadding;
    this.#details.border = wide && layout.mode !== "minimum" ? ["left"] : false;
    this.#details.visible = activeInspector;
    this.#timeline.visible = !activeInspector || (wide && layout.mode !== "minimum");
    this.#details.width = wide ? Math.min(64, Math.max(40, Math.round(width * 0.4))) : "100%";
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
      : this.#paletteQuery
      ? paletteText(this.#paletteQuery)
      : provisional
        ? `PROVISIONAL OUTPUT\n${provisional}`
        : this.#familyFocus === "browser"
          ? renderFamilyBrowser(this.#view, this.#familySelectedKey, compact, width >= 96)
        : this.#detail
          ? this.#detail.kind === "model" && !this.#rawDetail
            ? renderModelInspector(this.#detail, this.#modelProviderIndex, this.#modelEntryProvider, this.#modelCatalogIndex, this.#composerValue())
            : this.#detail.kind === "effort" && !this.#rawDetail
              ? renderEffortInspector(this.#detail, this.#effortIndex)
              : formatTerminalDetail(this.#detail, { raw: this.#rawDetail })
          : "";
    const notice = noticeText(this.#notice);
    const fullDetails = notice ? `${notice}\n${baseDetails ? `\n${baseDetails}` : ""}` : baseDetails;
    const details = layout.mode === "minimum" && activeInspector
      ? this.#minimumInspectorText(fullDetails)
      : fullDetails;
    const history = this.#view.historicalCursor ? ` · history@${this.#view.historicalCursor}` : "";
    const breadcrumb = formatTerminalBreadcrumb(
      this.#view.ancestry,
      this.#view.branchName,
      Math.max(8, width - history.length - 2),
    );
    const primaryHeader = `${breadcrumb}${history}`;
    const secondaryHeader = `${this.#view.model} · ${this.#view.runState} · ${this.#view.connection}`;
    this.#header.content = layout.mode === "normal"
      ? `${primaryHeader}\n${secondaryHeader}`
      : primaryHeader;
    this.#header.fg = this.#view.connection === "connected" ? TERMINAL_THEME.text : TERMINAL_THEME.warning;
    this.#transcript.reconcile(this.#view, this.#expandedRunIds);
    this.#detailsText.content = details;
    const selectedFamily = this.#view.familyChildren.find(child => child.key === this.#familySelectedKey);
    const noticeTone = this.#notice?.tone ?? "normal";
    this.#detailsText.fg = this.#notice
      ? terminalToneColor(noticeTone)
      : provisional
        ? TERMINAL_THEME.provisional
        : this.#familyFocus === "browser" && selectedFamily
          ? terminalToneColor(terminalFamilyTone(selectedFamily.activity))
          : TERMINAL_THEME.muted;
    const familyRefresh = this.#view.familyRefresh === "current" ? "" : ` · ${this.#view.familyRefresh}`;
    this.#familySummary.visible = layout.showFamilySummary && this.#view.familySummary !== null;
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
    this.#composer.placeholder = this.#busy
      ? "Working…"
      : this.controller.pendingSecretInput
        ? "API key (input hidden)…"
        : this.#modelEntryProvider
          ? `Model ID for ${this.#modelEntryProvider}…`
          : this.#view.composerPlaceholder;
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
    this.renderer.setTerminalTitle(`Agencity — ${this.#view.sessionName}`);
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
    let attached = false;
    let receivedSignal: NodeJS.Signals | null = null;
    const pendingOutput: string[] = [];
    const pendingDetails: Array<TerminalDetail | null> = [];
    const pendingProvisional = new Map<string, string>();
    const controller = new TerminalUI(this.client, {
      ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
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
        useMouse: true,
        useKittyKeyboard: { disambiguate: true },
        autoFocus: false,
        clearOnShutdown: true,
        consoleMode: "disabled",
      });
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


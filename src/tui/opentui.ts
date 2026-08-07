import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  createCliRenderer,
  InputRenderable,
  ScrollBoxRenderable,
  TextRenderable,
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
import { buildTerminalScreen, type TerminalPresentation, type TerminalScreenView } from "./view-model.ts";
import {
  formatTerminalDetail,
  type TerminalDetail,
  type TerminalModelDetail,
  type TerminalModelProviderDetail,
} from "./detail-model.ts";

const COLORS = {
  background: "#0d1117",
  panel: "#151b23",
  border: "#30363d",
  text: "#e6edf3",
  muted: "#8b949e",
  accent: "#58a6ff",
  success: "#3fb950",
  warning: "#d29922",
  danger: "#f85149",
};

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
    || trimmed === "Response accepted."
    || trimmed.startsWith("[cell complete]")
    || trimmed.startsWith("assistant:");
}

function statusColor(status: string): string {
  if (status === "succeeded" || status === "completed") return COLORS.success;
  if (status === "failed" || status === "blocked" || status === "unknown") return COLORS.danger;
  if (status === "waiting for user" || status === "waiting_for_user" || status === "budget exceeded") return COLORS.warning;
  return COLORS.accent;
}

function renderTimeline(view: TerminalScreenView, expandedRunIds: ReadonlySet<string>, compactDetails: string): string {
  const lines: string[] = [];
  for (const message of view.conversation) {
    lines.push(message.role === "user" ? "YOU" : "AGENT");
    lines.push(message.content.trim(), "");
  }

  if (view.runs.length > 0) {
    lines.push("ACTIVITY");
    for (const run of view.runs.slice(-6)) {
      const marker = run.active ? "●" : run.status === "succeeded" ? "✓" : "!";
      const cancellation = run.cancellationRequested ? " · cancellation requested" : "";
      const provisional = run.provisional ? " · working" : "";
      lines.push(`${marker} ${run.statusLabel}${provisional}${cancellation} — ${run.task}`);
      if (run.pendingInput) lines.push(`  needs input: ${run.pendingInput}`);
      if (run.reason) lines.push(`  ${run.reason}`);
      const expanded = run.active || expandedRunIds.has(run.id);
      if (expanded) {
        for (const step of run.steps.slice(-8)) {
          const attempts = step.attempts > 1 ? ` · ${step.attempts} attempts` : "";
          lines.push(`  ${step.ordinal}. ${step.label}${attempts}`);
          if (step.detail) lines.push(`     ${step.detail}`);
        }
      } else if (run.steps.length > 0) {
        lines.push(`  ▸ ${run.steps.length} step${run.steps.length === 1 ? "" : "s"} (Ctrl-O to expand latest)`);
      }
      lines.push("");
    }
  }

  if (view.tasks.length > 0) {
    lines.push("AGENTS");
    for (const task of view.tasks.slice(-8)) {
      lines.push(`  ${task.status} — ${task.task}${task.cancellationRequested ? " · cancellation requested" : ""}`);
      if (task.result) lines.push(`    ${task.result}`);
    }
    lines.push("");
  }

  if (compactDetails) {
    lines.push("DETAILS", compactDetails, "");
  }
  return lines.join("\n").trimEnd();
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

function renderModelInspector(detail: TerminalModelDetail, selectedIndex: number, entryProvider: string | null): string {
  const currentProvider = detail.providers.find(provider => provider.name === detail.current.provider);
  if (entryProvider) {
    const provider = detail.providers.find(item => item.name === entryProvider);
    return [
      "MODEL",
      "",
      "Choose model",
      provider?.displayName ?? entryProvider,
      "Enter the exact provider model ID in the composer.",
      provider?.name === "vercel" ? "Gateway model IDs may contain /." : "",
      "",
      "Current",
      `${currentProvider?.displayName ?? detail.current.provider} · ${detail.current.model}`,
      "",
      "Enter save · Esc back",
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
  lines.push("", "↑/↓ provider · Enter choose · L login · X logout", "Shift-R raw · Esc close");
  return lines.join("\n");
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
  abortPendingOperations?(): void;
}

export class OpenTuiApp {
  readonly #root: BoxRenderable;
  readonly #header: TextRenderable;
  readonly #main: BoxRenderable;
  readonly #timeline: ScrollBoxRenderable;
  readonly #timelineText: TextRenderable;
  readonly #details: ScrollBoxRenderable;
  readonly #detailsText: TextRenderable;
  readonly #composerBox: BoxRenderable;
  readonly #composer: InputRenderable;
  readonly #footer: TextRenderable;
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
  #resetDetailScroll = false;
  #busy = false;
  #closed = false;
  #activeOperation: Promise<void> | null = null;
  #secretBuffer = "";

  constructor(readonly renderer: CliRenderer, readonly controller: OpenTuiController) {
    this.#view = buildTerminalScreen(controller.presentation);
    this.#done = new Promise(resolve => { this.#resolveDone = resolve; });
    this.#root = new BoxRenderable(renderer, {
      id: "agencity-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: COLORS.background,
    });
    this.#header = new TextRenderable(renderer, {
      id: "agencity-header",
      height: 2,
      paddingX: 1,
      fg: COLORS.text,
      bg: COLORS.panel,
      truncate: true,
      wrapMode: "none",
    });
    this.#main = new BoxRenderable(renderer, {
      id: "agencity-main",
      flexGrow: 1,
      minHeight: 3,
      flexDirection: "row",
      backgroundColor: COLORS.background,
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
    this.#timelineText = new TextRenderable(renderer, {
      id: "agencity-timeline-text",
      width: "100%",
      height: "auto",
      fg: COLORS.text,
      wrapMode: "word",
      selectable: true,
    });
    this.#details = new ScrollBoxRenderable(renderer, {
      id: "agencity-details",
      width: 38,
      border: ["left"],
      borderColor: COLORS.border,
      padding: 1,
      backgroundColor: COLORS.panel,
      scrollY: true,
      scrollX: false,
      stickyScroll: false,
    });
    this.#detailsText = new TextRenderable(renderer, {
      id: "agencity-details-text",
      width: "100%",
      height: "auto",
      fg: COLORS.muted,
      wrapMode: "word",
      selectable: true,
    });
    this.#composerBox = new BoxRenderable(renderer, {
      id: "agencity-composer-box",
      height: 3,
      border: ["top"],
      borderColor: COLORS.border,
      paddingX: 1,
      paddingTop: 1,
      backgroundColor: COLORS.panel,
    });
    this.#composer = new InputRenderable(renderer, {
      id: "agencity-composer",
      width: "100%",
      placeholder: this.#view.composerPlaceholder,
      textColor: COLORS.text,
      focusedTextColor: COLORS.text,
      backgroundColor: COLORS.panel,
      focusedBackgroundColor: COLORS.panel,
      placeholderColor: COLORS.muted,
      onSubmit: () => { void this.#submit(); },
      onKeyDown: key => {
        if (!this.controller.pendingSecretInput && (key.name === "escape" || key.name === "esc" || key.sequence === "\u001b")) {
          key.preventDefault();
          key.stopPropagation();
          this.#dismissInspector();
        }
      },
    });
    this.#footer = new TextRenderable(renderer, {
      id: "agencity-footer",
      height: 1,
      paddingX: 1,
      fg: COLORS.muted,
      bg: COLORS.panel,
      truncate: true,
      wrapMode: "none",
    });

    this.#timeline.add(this.#timelineText);
    this.#details.add(this.#detailsText);
    this.#main.add(this.#timeline);
    this.#main.add(this.#details);
    this.#composerBox.add(this.#composer);
    this.#root.add(this.#header);
    this.#root.add(this.#main);
    this.#root.add(this.#composerBox);
    this.#root.add(this.#footer);
    renderer.root.add(this.#root);

    this.#unsubscribe = controller.subscribePresentation(presentation => {
      this.#view = buildTerminalScreen(presentation);
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
    if (detail.kind === "model") {
      const selected = detail.providers.findIndex(provider => provider.name === (previousProvider ?? detail.current.provider));
      this.#modelProviderIndex = Math.max(0, selected);
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
    this.#clearSecretInput();
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    if (this.#detailScrollTimer) clearTimeout(this.#detailScrollTimer);
    this.controller.abortPendingOperations?.();
    this.#resolveDone();
  }

  destroy(): void {
    this.#closed = true;
    this.#clearSecretInput();
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    if (this.#detailScrollTimer) clearTimeout(this.#detailScrollTimer);
    this.#unsubscribe();
    this.renderer.keyInput.off("keypress", this.#onKey);
    this.renderer.keyInput.off("paste", this.#onPaste);
    this.renderer.off(CliRenderEvents.RESIZE, this.#onResize);
    this.#root.destroyRecursively();
  }

  #onResize = (): void => {
    if (this.#activeInspector()) this.#resetDetailScroll = true;
    this.#render();
  };

  #onPaste = (event: PasteEvent): void => {
    if (!this.controller.pendingSecretInput) return;
    event.preventDefault();
    event.stopPropagation();
    const value = decodePasteBytes(event.bytes);
    this.#secretBuffer = `${this.#secretBuffer}${value}`.slice(0, 16_384);
    this.#composer.value = "•".repeat(this.#secretBuffer.length);
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
        this.#composer.value = "•".repeat(this.#secretBuffer.length);
        return;
      }
      if (!key.ctrl && !key.meta && key.sequence && !/[\r\n\0-\x1f\x7f]/.test(key.sequence)) {
        this.#secretBuffer = `${this.#secretBuffer}${key.sequence}`.slice(0, 16_384);
        this.#composer.value = "•".repeat(this.#secretBuffer.length);
      }
      return;
    }
    const modelDetail = this.#activeModelDetail();
    if (modelDetail && !this.#paletteQuery && this.#provisionalOutput.size === 0 && !this.#rawDetail) {
      if (this.#modelEntryProvider) {
        if (escape) {
          key.preventDefault();
          key.stopPropagation();
          this.#dismissInspector();
          return;
        }
        if ((key.name === "return" || key.name === "linefeed" || key.name === "kpenter") && !key.meta && !key.ctrl) {
          key.preventDefault();
          key.stopPropagation();
          const modelId = this.#composer.value.trim();
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
          this.#composer.value = provider.name === modelDetail.current.provider ? modelDetail.current.model : "";
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
    if (key.shift && key.name === "r" && this.#detail && !this.#modelEntryProvider) {
      key.preventDefault();
      key.stopPropagation();
      this.#rawDetail = !this.#rawDetail;
      this.#resetDetailScroll = true;
      this.#render();
      return;
    }
    if ((key.name === "return" || key.name === "linefeed" || key.name === "kpenter") && !key.meta && !key.ctrl) {
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
      this.#paletteDraft = this.#composer.value;
      this.#composer.value = "/";
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
      const value = this.#composer.value;
      this.#paletteQuery = value.startsWith("/") ? value : "";
      this.#render();
    }, 0);
  };

  #submit(): Promise<void> {
    const value = this.#composer.value.trim();
    if (!value || this.#busy) return Promise.resolve();
    return this.#runCommand(value);
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
    this.#composer.value = "";
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
    this.#composer.value = "";
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

  #selectedModelProvider(): TerminalModelProviderDetail | null {
    return this.#activeModelDetail()?.providers[this.#modelProviderIndex] ?? null;
  }

  #activeInspector(): boolean {
    return Boolean(
      this.controller.pendingSecretInput
      || this.#paletteQuery
      || this.#provisionalOutput.size
      || this.#detail
      || this.#notice,
    );
  }

  #clearSecretInput(): void {
    this.#secretBuffer = "";
    this.#composer.value = "";
  }

  #dismissInspector(): void {
    if (this.#modelEntryProvider) {
      this.#modelEntryProvider = null;
      this.#composer.value = "";
      this.#render();
      return;
    }
    if (this.#paletteQuery) this.#composer.value = this.#paletteDraft ?? "";
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

  #render(): void {
    const width = this.renderer.terminalWidth;
    const wide = width >= 96;
    const activeInspector = this.#activeInspector();
    this.#details.visible = wide || activeInspector;
    this.#timeline.visible = wide || !activeInspector;
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
        : this.#detail
          ? this.#detail.kind === "model" && !this.#rawDetail
            ? renderModelInspector(this.#detail, this.#modelProviderIndex, this.#modelEntryProvider)
            : formatTerminalDetail(this.#detail, { raw: this.#rawDetail })
          : [
          "SESSION",
          this.#view.sessionName,
          "",
          "RUN",
          this.#view.runState,
          "",
          "BUDGET",
          this.#view.budgetLabel,
          "",
          "RECOVERY",
          this.#view.recoveryLabel,
          "",
          "SHORTCUTS",
          "Ctrl-P commands",
          "Ctrl-O activity",
          "Ctrl-C stop / detach",
          "Ctrl-D detach",
          ].join("\n");
    const notice = noticeText(this.#notice);
    const details = notice ? `${notice}\n${baseDetails ? `\n${baseDetails}` : ""}` : baseDetails;
    const history = this.#view.historicalCursor ? ` · history@${this.#view.historicalCursor}` : "";
    this.#header.content = `${this.#view.sessionName} / ${this.#view.branchName}${history}\n${this.#view.model} · ${this.#view.runState} · ${this.#view.connection}`;
    this.#header.fg = this.#view.connection === "connected" ? COLORS.text : COLORS.warning;
    this.#timelineText.content = renderTimeline(this.#view, this.#expandedRunIds, "");
    this.#detailsText.content = details;
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
    const inspectorHint = this.#activeModelDetail() && !this.#modelEntryProvider ? " · ↑/↓ model provider · Enter choose" : "";
    this.#footer.content = `${this.#view.trustLabel} · ${this.#view.recoveryLabel} · ${this.#view.attentionCount} attention · ${this.#view.budgetLabel} · Ctrl-P commands${inspectorHint}`;
    this.#footer.fg = this.#view.attentionCount > 0 ? statusColor("waiting for user") : COLORS.muted;
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


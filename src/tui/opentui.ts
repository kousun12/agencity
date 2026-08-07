import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  createCliRenderer,
  InputRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type KeyEvent,
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

export interface OpenTuiController {
  readonly presentation: TerminalPresentation;
  readonly detached: boolean;
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
  #detailContent = "";
  #paletteQuery = "";
  #busy = false;
  #closed = false;
  #activeOperation: Promise<void> | null = null;

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
      stickyScroll: true,
      stickyStart: "bottom",
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
    this.#detailContent = `${this.#detailContent}${this.#detailContent ? "\n" : ""}${next}`.slice(-8_000);
    this.#paletteQuery = "";
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
      this.#detailContent = "Provisional provider output was discarded after the connection changed.";
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
    this.controller.abortPendingOperations?.();
    this.#resolveDone();
  }

  destroy(): void {
    this.#closed = true;
    this.#unsubscribe();
    this.renderer.keyInput.off("keypress", this.#onKey);
    this.renderer.off(CliRenderEvents.RESIZE, this.#onResize);
    this.#root.destroyRecursively();
  }

  #onResize = (): void => {
    this.#render();
  };

  #onKey = (key: KeyEvent): void => {
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
      this.#timeline.scrollBy(-Math.max(3, this.renderer.terminalHeight - 8));
      return;
    }
    if (key.name === "pagedown") {
      key.preventDefault();
      this.#timeline.scrollBy(Math.max(3, this.renderer.terminalHeight - 8));
      return;
    }
    if (key.name === "escape") {
      this.#paletteQuery = "";
      this.#detailContent = "";
      this.#render();
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
    const operation = this.#performSubmit(value);
    this.#activeOperation = operation;
    return operation.finally(() => {
      if (this.#activeOperation === operation) this.#activeOperation = null;
    });
  }

  async #performSubmit(value: string): Promise<void> {
    this.#composer.value = "";
    this.#paletteQuery = "";
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
    const showDetails = width >= 100;
    this.#details.visible = showDetails;
    const provisional = [...this.#provisionalOutput.values()].join("");
    const details = this.#paletteQuery
      ? paletteText(this.#paletteQuery)
      : provisional
        ? `PROVISIONAL OUTPUT\n${provisional}`
        : this.#detailContent || [
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
    const compactDetails = showDetails ? "" : (this.#paletteQuery || provisional || this.#detailContent ? details : "");
    const history = this.#view.historicalCursor ? ` · history@${this.#view.historicalCursor}` : "";
    this.#header.content = `${this.#view.sessionName} / ${this.#view.branchName}${history}\n${this.#view.model} · ${this.#view.runState} · ${this.#view.connection}`;
    this.#header.fg = this.#view.connection === "connected" ? COLORS.text : COLORS.warning;
    this.#timelineText.content = renderTimeline(this.#view, this.#expandedRunIds, compactDetails);
    this.#detailsText.content = details;
    this.#composer.placeholder = this.#busy ? "Working…" : this.#view.composerPlaceholder;
    this.#footer.content = `${this.#view.trustLabel} · ${this.#view.recoveryLabel} · ${this.#view.attentionCount} attention · ${this.#view.budgetLabel} · Ctrl-P commands`;
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
    const pendingProvisional = new Map<string, string>();
    const controller = new TerminalUI(this.client, {
      ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
      interactive: false,
      manageSignals: false,
      onOutput: value => {
        if (app) app.showOutput(value);
        else pendingOutput.push(value);
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
    const timedOut = Symbol("service-status-timeout");
    const statusRequest = this.client.serviceStatus()
      .then(value => value as ManagedServiceStatusView)
      .catch(() => null);
    const statusResult = await Promise.race([statusRequest, Bun.sleep(750).then(() => timedOut)]);
    if (statusResult === timedOut) this.client.abortPendingRequests("Detach status timed out");
    else serviceStatus = statusResult as ManagedServiceStatusView | null;
    this.#output.write(`${formatManagedDetach(serviceStatus)}\n`);
  }
}


import {
  BoxRenderable,
  CodeRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type SyntaxStyle,
} from "@opentui/core";
import type { JsonValue } from "../domain/index.ts";
import {
  TERMINAL_THEME,
  terminalCellTone,
  terminalRunTone,
  terminalToneColor,
} from "./theme.ts";
import type {
  TerminalCellView,
  TerminalConversationItem,
  TerminalRunView,
  TerminalScreenView,
  TerminalStepView,
} from "./view-model.ts";

const MAX_INLINE_OUTPUT_CHARACTERS = 800;
const MAX_INLINE_OUTPUT_LINES = 12;

interface TranscriptBlock {
  readonly key: string;
  readonly root: BoxRenderable | TextRenderable;
  update(): void;
}

interface MessageBlock extends TranscriptBlock {
  readonly role: TextRenderable;
  readonly body: MarkdownRenderable;
  message: TerminalConversationItem;
}

interface StepBlock {
  readonly key: string;
  readonly root: BoxRenderable;
  step: TerminalStepView;
  update(step: TerminalStepView): void;
}

interface RunBlock extends TranscriptBlock {
  readonly marker: TextRenderable;
  readonly summary: TextRenderable;
  readonly reason: TextRenderable;
  readonly stepsHost: BoxRenderable;
  readonly stepBlocks: Map<string, StepBlock>;
  run: TerminalRunView;
  expanded: boolean;
  inline: boolean;
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split("\n").length;
}

function firstMeaningfulLine(value: string): string {
  return value.split("\n").find(line => line.trim())?.trim() ?? "";
}

function truncateLine(value: string, maximum = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function boundedText(value: string): string {
  const lines = value.split("\n");
  let bounded = lines.slice(0, MAX_INLINE_OUTPUT_LINES).join("\n");
  let truncated = lines.length > MAX_INLINE_OUTPUT_LINES;
  if (bounded.length > MAX_INLINE_OUTPUT_CHARACTERS) {
    bounded = bounded.slice(0, MAX_INLINE_OUTPUT_CHARACTERS);
    truncated = true;
  }
  return truncated ? `${bounded}\n… output truncated; use /cells for retained diagnostics` : bounded;
}

export function formatTerminalCellResult(value: JsonValue): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return boundedText(serialized ?? "null");
}

export function terminalRunMarker(run: Pick<TerminalRunView, "active" | "status">): string {
  if (run.active) return "●";
  switch (run.status) {
    case "succeeded": return "✓";
    case "budget_exceeded": return "!";
    case "failed":
    case "blocked":
    case "unknown": return "!";
    case "cancelled": return "×";
    case "queued":
    case "running": return "●";
  }
}

export function terminalCellMarker(status: TerminalCellView["status"]): string {
  switch (status) {
    case "pending": return "○";
    case "proposed": return "◇";
    case "running": return "●";
    case "committed": return "✓";
    case "failed": return "×";
    case "abandoned": return "–";
    case "missing": return "!";
  }
}

function runSummary(run: TerminalRunView, inline: boolean, expanded: boolean): string {
  const provisional = run.provisional ? " · working" : "";
  const cancellation = run.cancellationRequested ? " · cancellation requested" : "";
  const task = inline ? "" : ` — ${run.task}`;
  const steps = !expanded && run.steps.length > 0
    ? ` · ${run.steps.length} step${run.steps.length === 1 ? "" : "s"} (Ctrl-O to expand latest)`
    : "";
  return `${run.statusLabel}${provisional}${cancellation}${task}${steps}`;
}

function cellSummary(step: TerminalStepView, cell: TerminalCellView): string {
  const source = truncateLine(firstMeaningfulLine(cell.code));
  const lines = lineCount(cell.code);
  const output = cell.error
    ? " · error"
    : cell.logs.length > 0 || cell.status === "committed"
      ? " · output"
      : "";
  const executions = cell.attempts > 1 ? ` · ${cell.attempts} executions` : "";
  const modelAttempts = step.attempts > 1 ? ` · ${step.attempts} model attempts` : "";
  return `TypeScript · ${source || "(empty source)"} · ${lines} ${lines === 1 ? "line" : "lines"}${output}${executions}${modelAttempts}`;
}

function ordinaryStepSummary(step: TerminalStepView): string {
  const attempts = step.attempts > 1 ? ` · ${step.attempts} model attempts` : "";
  return `${step.ordinal}. ${step.label}${attempts}${step.detail ? `\n   ${step.detail}` : ""}`;
}

export class TerminalTranscript {
  readonly #blocks = new Map<string, TranscriptBlock>();

  constructor(
    readonly renderer: CliRenderer,
    readonly host: ScrollBoxRenderable,
    readonly syntaxStyle: SyntaxStyle,
  ) {}

  reconcile(view: TerminalScreenView, expandedRunIds: ReadonlySet<string>): void {
    const desired: TranscriptBlock[] = [];
    const runs = view.runs.slice(-6);
    const visibleMessageIds = new Set(view.conversation.map(message => message.id));
    const runsByTaskMessage = new Map(runs.map(run => [run.taskMessageId, run]));
    const runsByFinalMessage = new Map(
      runs
        .filter((run): run is TerminalRunView & { finalMessageId: string } => run.finalMessageId !== null)
        .map(run => [run.finalMessageId, run]),
    );
    const placedRunIds = new Set<string>();
    const appendRun = (run: TerminalRunView, inline: boolean): void => {
      if (placedRunIds.has(run.id)) return;
      const key = `run:${run.id}`;
      let block = this.#blocks.get(key) as RunBlock | undefined;
      if (!block) {
        block = this.#createRunBlock(key, run);
        this.#blocks.set(key, block);
      }
      block.run = run;
      block.expanded = run.active || expandedRunIds.has(run.id);
      block.inline = inline;
      block.update();
      desired.push(block);
      placedRunIds.add(run.id);
    };

    for (const message of view.conversation) {
      const finalRun = runsByFinalMessage.get(message.id);
      if (finalRun && !visibleMessageIds.has(finalRun.taskMessageId)) appendRun(finalRun, false);

      const key = `message:${message.id}`;
      let block = this.#blocks.get(key) as MessageBlock | undefined;
      if (!block) {
        block = this.#createMessageBlock(key, message);
        this.#blocks.set(key, block);
      } else {
        block.message = message;
      }
      block.update();
      desired.push(block);

      const taskRun = runsByTaskMessage.get(message.id);
      if (taskRun) appendRun(taskRun, true);
    }

    for (const run of runs) appendRun(run, false);

    const desiredKeys = new Set(desired.map(block => block.key));
    for (const [key, block] of this.#blocks) {
      if (desiredKeys.has(key)) continue;
      this.host.remove(block.root);
      block.root.destroyRecursively();
      this.#blocks.delete(key);
    }
    desired.forEach((block, index) => {
      const current = this.host.getChildren()[index];
      if (current === block.root) return;
      if (block.root.parent) this.host.remove(block.root);
      this.host.add(block.root, index);
    });
  }

  #createMessageBlock(key: string, message: TerminalConversationItem): MessageBlock {
    const root = new BoxRenderable(this.renderer, {
      id: `agencity-transcript-message-${message.id}`,
      width: "100%",
      height: "auto",
      flexDirection: "column",
      marginBottom: 1,
      backgroundColor: TERMINAL_THEME.background,
    });
    const role = new TextRenderable(this.renderer, {
      id: `agencity-transcript-message-role-${message.id}`,
      width: "100%",
      height: 1,
      fg: message.role === "user" ? TERMINAL_THEME.accent : TERMINAL_THEME.success,
      wrapMode: "none",
    });
    const body = new MarkdownRenderable(this.renderer, {
      id: `agencity-transcript-message-body-${message.id}`,
      width: "100%",
      height: "auto",
      content: message.content,
      syntaxStyle: this.syntaxStyle,
      fg: TERMINAL_THEME.text,
      bg: TERMINAL_THEME.background,
      conceal: true,
      internalBlockMode: "top-level",
      streaming: false,
      tableOptions: { widthMode: "content", wrapMode: "word", selectable: true },
    });
    root.add(role);
    root.add(body);
    const block: MessageBlock = {
      key,
      root,
      role,
      body,
      message,
      update: () => {
        role.content = block.message.role === "user" ? "YOU" : "AGENT";
        role.fg = block.message.role === "user" ? TERMINAL_THEME.accent : TERMINAL_THEME.success;
        if (body.content !== block.message.content) body.content = block.message.content;
      },
    };
    return block;
  }

  #createRunBlock(key: string, run: TerminalRunView): RunBlock {
    const root = new BoxRenderable(this.renderer, {
      id: `agencity-transcript-run-${run.id}`,
      width: "100%",
      height: "auto",
      flexDirection: "column",
      marginBottom: 1,
      backgroundColor: TERMINAL_THEME.background,
    });
    const header = new BoxRenderable(this.renderer, {
      id: `agencity-transcript-run-header-${run.id}`,
      width: "100%",
      height: 1,
      flexDirection: "row",
      backgroundColor: TERMINAL_THEME.background,
    });
    const marker = new TextRenderable(this.renderer, {
      id: `agencity-transcript-run-marker-${run.id}`,
      width: 2,
      height: 1,
      wrapMode: "none",
    });
    const summary = new TextRenderable(this.renderer, {
      id: `agencity-transcript-run-summary-${run.id}`,
      flexGrow: 1,
      minWidth: 1,
      height: 1,
      fg: TERMINAL_THEME.text,
      truncate: true,
      wrapMode: "none",
    });
    const reason = new TextRenderable(this.renderer, {
      id: `agencity-transcript-run-reason-${run.id}`,
      width: "100%",
      height: "auto",
      paddingLeft: 2,
      fg: TERMINAL_THEME.muted,
      wrapMode: "word",
    });
    const stepsHost = new BoxRenderable(this.renderer, {
      id: `agencity-transcript-run-steps-${run.id}`,
      width: "100%",
      height: "auto",
      flexDirection: "column",
      paddingLeft: 2,
      backgroundColor: TERMINAL_THEME.background,
    });
    header.add(marker);
    header.add(summary);
    root.add(header);
    root.add(reason);
    root.add(stepsHost);

    const block: RunBlock = {
      key,
      root,
      marker,
      summary,
      reason,
      stepsHost,
      stepBlocks: new Map(),
      run,
      expanded: run.active,
      inline: false,
      update: () => {
        const current = block.run;
        marker.content = terminalRunMarker(current);
        marker.fg = terminalToneColor(current.provisional ? "provisional" : terminalRunTone(current.status));
        summary.content = runSummary(current, block.inline, block.expanded);
        reason.content = current.reason ?? "";
        stepsHost.visible = block.expanded;
        if (block.expanded) this.#reconcileSteps(block, current.steps.slice(-8));
      },
    };
    return block;
  }

  #reconcileSteps(block: RunBlock, steps: readonly TerminalStepView[]): void {
    const desired: StepBlock[] = [];
    for (const step of steps) {
      const key = `step:${step.id}`;
      let stepBlock = block.stepBlocks.get(key);
      if (!stepBlock || Boolean(stepBlock.step.cell) !== Boolean(step.cell)) {
        if (stepBlock) {
          block.stepsHost.remove(stepBlock.root);
          stepBlock.root.destroyRecursively();
        }
        stepBlock = step.cell
          ? this.#createCellStepBlock(key, step)
          : this.#createOrdinaryStepBlock(key, step);
        block.stepBlocks.set(key, stepBlock);
      }
      stepBlock.update(step);
      desired.push(stepBlock);
    }
    const desiredKeys = new Set(desired.map(item => item.key));
    for (const [key, item] of block.stepBlocks) {
      if (desiredKeys.has(key)) continue;
      block.stepsHost.remove(item.root);
      item.root.destroyRecursively();
      block.stepBlocks.delete(key);
    }
    desired.forEach((item, index) => {
      const current = block.stepsHost.getChildren()[index];
      if (current === item.root) return;
      if (item.root.parent) block.stepsHost.remove(item.root);
      block.stepsHost.add(item.root, index);
    });
  }

  #createOrdinaryStepBlock(key: string, initial: TerminalStepView): StepBlock {
    const root = new BoxRenderable(this.renderer, {
      id: `agencity-transcript-step-${initial.id}`,
      width: "100%",
      height: "auto",
      flexDirection: "column",
      marginTop: 1,
      backgroundColor: TERMINAL_THEME.background,
    });
    const text = new TextRenderable(this.renderer, {
      id: `agencity-transcript-step-text-${initial.id}`,
      width: "100%",
      height: "auto",
      fg: TERMINAL_THEME.muted,
      wrapMode: "word",
    });
    root.add(text);
    const block: StepBlock = {
      key,
      root,
      step: initial,
      update: step => {
        block.step = step;
        text.content = ordinaryStepSummary(step);
      },
    };
    return block;
  }

  #createCellStepBlock(key: string, initial: TerminalStepView): StepBlock {
    const cell = initial.cell!;
    const root = new BoxRenderable(this.renderer, {
      id: `agencity-transcript-step-${initial.id}`,
      width: "100%",
      height: "auto",
      flexDirection: "column",
      marginTop: 1,
      backgroundColor: TERMINAL_THEME.background,
    });
    const compact = new BoxRenderable(this.renderer, {
      id: `agencity-transcript-cell-header-${cell.id}`,
      width: "100%",
      height: 1,
      flexDirection: "row",
      backgroundColor: TERMINAL_THEME.background,
    });
    const marker = new TextRenderable(this.renderer, {
      id: `agencity-transcript-cell-marker-${cell.id}`,
      width: 2,
      height: 1,
      wrapMode: "none",
    });
    const summary = new TextRenderable(this.renderer, {
      id: `agencity-transcript-cell-summary-${cell.id}`,
      flexGrow: 1,
      minWidth: 1,
      height: 1,
      fg: TERMINAL_THEME.text,
      truncate: true,
      wrapMode: "none",
    });
    const sourceLabel = new TextRenderable(this.renderer, {
      id: `agencity-transcript-cell-source-label-${cell.id}`,
      width: "100%",
      height: 1,
      marginTop: 1,
      fg: TERMINAL_THEME.muted,
      content: "SOURCE",
      wrapMode: "none",
    });
    const source = new CodeRenderable(this.renderer, {
      id: `agencity-transcript-cell-source-${cell.id}`,
      width: "100%",
      height: "auto",
      content: cell.code,
      filetype: "typescript",
      syntaxStyle: this.syntaxStyle,
      fg: TERMINAL_THEME.text,
      bg: TERMINAL_THEME.codeBackground,
      selectionBg: TERMINAL_THEME.selectionBackground,
      wrapMode: "word",
      selectable: true,
      drawUnstyledText: true,
      streaming: false,
    });
    const logs = new TextRenderable(this.renderer, {
      id: `agencity-transcript-cell-logs-${cell.id}`,
      width: "100%",
      height: "auto",
      marginTop: 1,
      fg: TERMINAL_THEME.muted,
      wrapMode: "word",
      selectable: true,
    });
    const result = new TextRenderable(this.renderer, {
      id: `agencity-transcript-cell-result-${cell.id}`,
      width: "100%",
      height: "auto",
      marginTop: 1,
      fg: TERMINAL_THEME.muted,
      wrapMode: "word",
      selectable: true,
    });
    const error = new TextRenderable(this.renderer, {
      id: `agencity-transcript-cell-error-${cell.id}`,
      width: "100%",
      height: "auto",
      marginTop: 1,
      fg: TERMINAL_THEME.danger,
      wrapMode: "word",
      selectable: true,
    });
    compact.add(marker);
    compact.add(summary);
    root.add(compact);
    root.add(sourceLabel);
    root.add(source);
    root.add(logs);
    root.add(result);
    root.add(error);

    const block: StepBlock = {
      key,
      root,
      step: initial,
      update: step => {
        block.step = step;
        const next = step.cell!;
        marker.content = terminalCellMarker(next.status);
        marker.fg = terminalToneColor(terminalCellTone(next.status));
        summary.content = cellSummary(step, next);
        if (source.content !== next.code) source.content = next.code;
        logs.content = next.logs.length > 0 ? `LOGS\n${boundedText(next.logs.join("\n"))}` : "";
        result.content = next.status === "committed" ? `RESULT\n${formatTerminalCellResult(next.result)}` : "";
        error.content = next.error ? `ERROR\n${boundedText(next.error)}` : "";
      },
    };
    return block;
  }
}

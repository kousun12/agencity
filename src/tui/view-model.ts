import type { AgentRunState, AgentState, MessageState } from "../domain/index.ts";
import type { ProtocolCapabilities } from "../protocol/index.ts";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"]);

export type TerminalConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface TerminalPresentation {
  readonly state: AgentState;
  readonly capabilities: ProtocolCapabilities;
  readonly historicalCursor: string | null;
  readonly connection: TerminalConnectionState;
  readonly provisionalRunIds: readonly string[];
}

export interface TerminalConversationItem {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface TerminalStepView {
  readonly id: string;
  readonly ordinal: number;
  readonly label: string;
  readonly detail: string | null;
  readonly attempts: number;
}

export interface TerminalRunView {
  readonly id: string;
  readonly task: string;
  readonly status: AgentRunState["status"];
  readonly statusLabel: string;
  readonly active: boolean;
  readonly provisional: boolean;
  readonly cancellationRequested: boolean;
  readonly reason: string | null;
  readonly pendingInput: string | null;
  readonly steps: readonly TerminalStepView[];
}

export interface TerminalTaskView {
  readonly id: string;
  readonly task: string;
  readonly status: string;
  readonly cancellationRequested: boolean;
  readonly result: string | null;
}

export interface TerminalScreenView {
  readonly workspaceId: string;
  readonly sessionName: string;
  readonly branchName: string;
  readonly model: string;
  readonly providerMode: string;
  readonly connection: TerminalConnectionState;
  readonly historicalCursor: string | null;
  readonly conversation: readonly TerminalConversationItem[];
  readonly runs: readonly TerminalRunView[];
  readonly tasks: readonly TerminalTaskView[];
  readonly runState: string;
  readonly composerPlaceholder: string;
  readonly attentionCount: number;
  readonly recoveryLabel: string;
  readonly budgetLabel: string;
  readonly trustLabel: "TRUSTED-LOCAL";
}

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

function oneLine(value: string, max = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function valueSummary(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized === undefined ? String(value) : oneLine(serialized);
}

function visibleConversation(messages: readonly MessageState[]): TerminalConversationItem[] {
  return messages
    .filter((message): message is MessageState & { role: "user" | "assistant" } => message.role === "user" || message.role === "assistant")
    .map(message => ({ id: message.id, role: message.role, content: message.content }))
    .slice(-24);
}

function stepView(run: AgentRunState, ordinal: number): TerminalStepView {
  const step = run.steps[ordinal]!;
  const action = step.action;
  let label = "Model decision";
  let detail: string | null = null;
  if (action?.type === "typescript") {
    label = "TypeScript cell";
    detail = oneLine(action.code.split("\n").find(line => line.trim()) ?? action.code);
  } else if (action?.type === "final") {
    const accepted = run.status === "succeeded" && run.finalMessageId !== undefined && run.steps.at(-1)?.id === step.id;
    label = accepted ? "Final response committed" : "Completion proposed";
    detail = accepted ? oneLine(action.content) : null;
  } else if (action?.type === "clarification") {
    label = "Clarification requested";
    detail = oneLine(action.question);
  } else if (action?.type === "permission") {
    label = "Permission requested";
    detail = oneLine(action.question);
  } else if (action?.type === "blocked") {
    label = "Blocked";
    detail = oneLine(action.reason);
  } else if (action?.type === "failed") {
    label = "Failed";
    detail = oneLine(action.error);
  } else if (step.rejection) {
    label = "Rejected model action";
    detail = oneLine(step.rejection);
  }
  return {
    id: step.id,
    ordinal: step.ordinal,
    label,
    detail,
    attempts: Math.max(1, step.modelAttempts.length),
  };
}

function runView(run: AgentRunState, provisionalRunIds: ReadonlySet<string>): TerminalRunView {
  const pending = Object.values(run.inputRequests).find(request => request.response === undefined);
  return {
    id: run.id,
    task: run.task,
    status: run.status,
    statusLabel: run.status.replaceAll("_", " "),
    active: !isTerminalRunStatus(run.status),
    provisional: provisionalRunIds.has(run.id),
    cancellationRequested: run.cancellationRequested,
    reason: run.reason ?? run.cancellationReason ?? null,
    pendingInput: pending?.question ?? null,
    steps: run.steps.map((_, index) => stepView(run, index)),
  };
}

export function buildTerminalScreen(presentation: TerminalPresentation): TerminalScreenView {
  const { state, capabilities } = presentation;
  const provider = capabilities.providers.find(item => item.name === state.model.provider);
  const provisionalRunIds = new Set(presentation.provisionalRunIds);
  const runs = Object.values(state.agentRuns).map(run => runView(run, provisionalRunIds)).slice(-12);
  const activeRun = [...runs].reverse().find(run => run.active);
  const tasks = Object.values(state.tasks).slice(-12).map(task => ({
    id: task.id,
    task: task.task,
    status: task.status,
    cancellationRequested: task.cancellationRequested,
    result: valueSummary(task.result ?? task.error ?? task.reason),
  }));
  const effects = Object.values(state.effects);
  const unknownEffects = effects.filter(effect => effect.status === "unknown").length;
  const pendingEffects = effects.filter(effect => effect.status === "requested" || effect.status === "started").length;
  const activeTasks = Object.values(state.tasks).filter(task => ["pending", "admitted", "running"].includes(task.status)).length;
  const attentionGates = Object.values(state.goals).flatMap(goal => Object.values(goal.gates))
    .filter(gate => ["failed", "unknown", "running"].includes(gate.status)).length;
  const cancellationPending = Object.values(state.agentRuns).filter(run => run.cancellationRequested && !isTerminalRunStatus(run.status)).length;
  const attentionCount = unknownEffects + attentionGates + cancellationPending;
  const streaming = provider?.capabilities.streaming ? "incremental" : "committed";
  const recoveryCount = pendingEffects + unknownEffects + activeTasks + attentionGates;

  return {
    workspaceId: state.workspaceId,
    sessionName: state.sessionName ?? "Unnamed session",
    branchName: state.branch.name ?? "unnamed branch",
    model: `${state.model.provider}/${state.model.model}${state.model.provider === "echo" ? " [DEMO FIXTURE]" : ""}`,
    providerMode: streaming,
    connection: presentation.connection,
    historicalCursor: presentation.historicalCursor,
    conversation: visibleConversation(state.messages),
    runs,
    tasks,
    runState: activeRun?.statusLabel ?? [...runs].at(-1)?.statusLabel ?? "idle",
    composerPlaceholder: activeRun?.pendingInput
      ? "Answer the pending request…"
      : activeRun
        ? "Run in progress — /stop to cancel"
        : "Ask Agencity…",
    attentionCount,
    recoveryLabel: recoveryCount === 0
      ? "recovery healthy"
      : `${recoveryCount} recovery item${recoveryCount === 1 ? "" : "s"}`,
    budgetLabel: `${state.budget.turns} turns · ${state.budget.tokens} tokens${state.budget.exceeded ? " · exceeded" : ""}`,
    trustLabel: "TRUSTED-LOCAL",
  };
}


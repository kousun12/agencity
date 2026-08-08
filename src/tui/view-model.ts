import type { AgentRunState, AgentState, CellLogStream, JsonValue, MessageState } from "../domain/index.ts";
import type { ProtocolCapabilities } from "../protocol/index.ts";
import type {
  FamilyAgentActivity,
  FamilyAgentActivityReason,
  FamilyAgentRecord,
  ModelContractDiagnosticOutcome,
} from "../runtime/index.ts";
import { deriveModelContractCallDiagnostic } from "../runtime/index.ts";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"]);

export type TerminalConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";
export type TerminalFamilyRefreshState = "current" | "refreshing" | "stale" | "unavailable";

export interface TerminalRoute {
  readonly sessionId: string;
  readonly branchId: string;
}

export interface TerminalFamilyNavigation {
  readonly route: TerminalRoute;
  readonly parent: FamilyAgentRecord | null;
  readonly children: readonly FamilyAgentRecord[];
  readonly ancestry: readonly string[];
  readonly refresh: TerminalFamilyRefreshState;
  readonly generation: number;
}

export interface TerminalPresentation {
  readonly state: AgentState;
  readonly capabilities: ProtocolCapabilities;
  readonly historicalCursor: string | null;
  readonly connection: TerminalConnectionState;
  readonly provisionalRunIds: readonly string[];
  readonly family: TerminalFamilyNavigation;
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
  readonly cell: TerminalCellView | null;
  readonly formalOutcome: ModelContractDiagnosticOutcome | null;
}

export interface TerminalCellView {
  readonly id: string;
  readonly language: "typescript";
  readonly code: string;
  readonly status: "pending" | "proposed" | "running" | "committed" | "failed" | "abandoned" | "missing";
  readonly attempts: number;
  readonly logs: readonly string[];
  readonly logStreams: readonly CellLogStream[];
  readonly result: JsonValue | null;
  readonly error: string | null;
}

export interface TerminalRunView {
  readonly id: string;
  readonly task: string;
  readonly taskMessageId: string;
  readonly finalMessageId: string | null;
  readonly status: AgentRunState["status"];
  readonly statusLabel: string;
  readonly active: boolean;
  readonly actionPending: boolean;
  readonly provisional: boolean;
  readonly cancellationRequested: boolean;
  readonly reason: string | null;
  readonly steps: readonly TerminalStepView[];
}

export interface TerminalFamilyChildView extends TerminalRoute {
  readonly key: string;
  readonly displayName: string;
  readonly task: string;
  readonly activity: FamilyAgentActivity;
  readonly activityLabel: string;
  readonly activityReason: FamilyAgentActivityReason;
  readonly activityReasonLabel: string | null;
  readonly model: string | null;
  readonly cancellationRequested: boolean;
  readonly openable: boolean;
}

export interface TerminalFamilySummaryView {
  readonly total: number;
  readonly working: number;
  readonly idle: number;
  readonly attention: number;
  readonly ended: number;
  readonly label: string;
}

export interface TerminalScreenView {
  readonly workspaceId: string;
  readonly sessionName: string;
  readonly branchName: string;
  readonly model: string;
  readonly providerMode: string;
  readonly connection: TerminalConnectionState;
  readonly historicalCursor: string | null;
  readonly ancestry: readonly string[];
  readonly conversation: readonly TerminalConversationItem[];
  readonly runs: readonly TerminalRunView[];
  readonly familyChildren: readonly TerminalFamilyChildView[];
  readonly familyParent: FamilyAgentRecord | null;
  readonly familySummary: TerminalFamilySummaryView | null;
  readonly familyRefresh: TerminalFamilyRefreshState;
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

const FAMILY_ACTIVITY_PRIORITY: Readonly<Record<FamilyAgentActivity, number>> = {
  attention: 0,
  unavailable: 1,
  working: 2,
  idle: 3,
  ended: 4,
};

const FAMILY_REASON_LABELS: Readonly<Record<Exclude<FamilyAgentActivityReason, null>, string>> = {
  blocked: "blocked",
  failed: "failed",
  budget_exceeded: "budget exceeded",
  unknown: "unknown outcome",
  cancellation_pending: "cancellation pending",
  cancelled: "cancelled",
  archived: "archived",
  missing_state: "missing state",
};

function familyDisplayName(record: FamilyAgentRecord): string {
  const name = record.name?.replace(/\s+/g, " ").trim();
  if (name) return oneLine(name, 100);
  const task = record.task?.replace(/\s+/g, " ").trim();
  return task ? oneLine(task, 100) : "Unnamed agent";
}

export function buildTerminalFamilyChildren(records: readonly FamilyAgentRecord[]): TerminalFamilyChildView[] {
  return records
    .filter(record => record.relationship === "child")
    .map(record => ({
      key: `${record.sessionId}\u0000${record.branchId}`,
      sessionId: record.sessionId,
      branchId: record.branchId,
      displayName: familyDisplayName(record),
      task: record.task ?? "No retained task summary",
      activity: record.activity,
      activityLabel: record.activity,
      activityReason: record.activityReason,
      activityReasonLabel: record.activityReason === null ? null : FAMILY_REASON_LABELS[record.activityReason],
      model: record.model ? `${record.model.provider}:${record.model.model}` : null,
      cancellationRequested: record.cancellationRequested,
      openable: record.activity !== "unavailable",
    }))
    .sort((left, right) =>
      FAMILY_ACTIVITY_PRIORITY[left.activity] - FAMILY_ACTIVITY_PRIORITY[right.activity]
      || left.displayName.normalize().toLocaleLowerCase().localeCompare(right.displayName.normalize().toLocaleLowerCase())
      || left.sessionId.localeCompare(right.sessionId)
      || left.branchId.localeCompare(right.branchId));
}

export function buildTerminalFamilySummary(children: readonly TerminalFamilyChildView[]): TerminalFamilySummaryView | null {
  if (!children.length) return null;
  const working = children.filter(child => child.activity === "working").length;
  const idle = children.filter(child => child.activity === "idle").length;
  const attention = children.filter(child => ["attention", "unavailable"].includes(child.activity)).length;
  const ended = children.filter(child => child.activity === "ended").length;
  const counts = [
    working ? `${working} working` : "",
    idle ? `${idle} idle` : "",
    attention ? `${attention} attention` : "",
    ended ? `${ended} ended` : "",
  ].filter(Boolean);
  const total = children.length;
  return {
    total,
    working,
    idle,
    attention,
    ended,
    label: `${total} ${total === 1 ? "agent" : "agents"}: ${counts.join(" · ")}   Enter or → to open`,
  };
}

function truncate(value: string, max: number): string {
  if (max < 1) return "";
  if (value.length <= max) return value;
  return max === 1 ? "…" : `${value.slice(0, max - 1)}…`;
}

export function formatTerminalFamilySummary(summary: TerminalFamilySummaryView, maxWidth: number): string {
  if (summary.label.length <= maxWidth) return summary.label;
  const highest = summary.attention
    ? `${summary.attention} attention`
    : summary.working
      ? `${summary.working} working`
      : summary.idle
        ? `${summary.idle} idle`
        : `${summary.ended} ended`;
  return truncate(`${summary.total} ${summary.total === 1 ? "agent" : "agents"} · ${highest}`, maxWidth);
}

export function formatTerminalBreadcrumb(ancestry: readonly string[], branchName: string, maxWidth: number): string {
  const labels = ancestry.length ? ancestry : ["Unnamed session"];
  const full = `${labels.join(" › ")} / ${branchName}`;
  if (full.length <= maxWidth) return full;
  if (maxWidth < 1) return "";
  const maxSuffixWidth = Math.max(4, Math.floor(maxWidth / 2));
  const suffix = ` / ${truncate(branchName, Math.max(1, maxSuffixWidth - 3))}`;
  const labelWidth = maxWidth - suffix.length;
  if (labelWidth < 1) return truncate(suffix, maxWidth);
  const root = labels[0]!;
  const current = labels.at(-1)!;
  const middle = labels.length > 2 ? " › … › " : labels.length === 2 ? " › " : "";
  if (labels.length === 1 || labelWidth <= middle.length + 2) {
    return `${truncate(current, labelWidth)}${suffix}`;
  }
  const available = labelWidth - middle.length;
  const rootWidth = Math.max(1, Math.floor(available / 2));
  const currentWidth = Math.max(1, available - rootWidth);
  return truncate(labels.length === 1 ? current : root, rootWidth)
    + middle
    + (labels.length === 1 ? "" : truncate(current, currentWidth))
    + suffix;
}

function visibleConversation(messages: readonly MessageState[]): TerminalConversationItem[] {
  return messages
    .filter((message): message is MessageState & { role: "user" | "assistant" } => message.role === "user" || message.role === "assistant")
    .map(message => ({ id: message.id, role: message.role, content: message.content }))
    .slice(-24);
}

function stepView(state: AgentState, run: AgentRunState, ordinal: number): TerminalStepView | null {
  const step = run.steps[ordinal]!;
  const action = step.action;
  if (!action && !step.rejection) return null;
  const formalOutcome = step.actionSource
    ? deriveModelContractCallDiagnostic(state, step.actionSource.modelCallId)
    : null;
  let label = "";
  let detail: string | null = null;
  let cell: TerminalCellView | null = null;
  if (action?.type === "typescript") {
    label = "Formal bun_console submission";
    const cellId = `agent-run-cell-${step.actionId}`;
    const projected = state.cells[cellId];
    const code = projected?.code ?? action.code;
    detail = oneLine(code.split("\n").find(line => line.trim()) ?? code);
    cell = {
      id: cellId,
      language: "typescript",
      code,
      status: projected?.status ?? (isTerminalRunStatus(run.status) ? "missing" : "pending"),
      attempts: projected?.attempts ?? 0,
      logs: projected ? [...projected.logs] : [],
      logStreams: projected ? [...projected.logStreams] : [],
      result: projected?.result ?? null,
      error: projected?.error ?? null,
    };
  } else if (action?.type === "final") {
    const accepted = run.status === "succeeded" && run.finalMessageId !== undefined && run.steps.at(-1)?.id === step.id;
    label = accepted
      ? "Completed successfully"
      : "Checking completion…";
    detail = accepted ? oneLine(action.content) : null;
  } else if (action?.type === "blocked") {
    label = "Stopped — needs input";
    detail = oneLine(action.reason);
  } else if (action?.type === "failed") {
    label = "Failed";
    detail = oneLine(action.error);
  } else if (step.rejection) {
    const violation = formalOutcome?.kind === "contract-violation"
      ? formalOutcome
      : null;
    label = violation
      ? `Formal contract violation · ${violation.code}`
      : "Formal contract violation";
    detail = oneLine(violation?.message ?? step.rejection);
  }
  return {
    id: step.id,
    ordinal: step.ordinal,
    label,
    detail,
    attempts: Math.max(1, step.modelAttempts.length),
    cell,
    formalOutcome,
  };
}

function runView(state: AgentState, run: AgentRunState, provisionalRunIds: ReadonlySet<string>): TerminalRunView {
  const latestStep = run.steps.at(-1);
  return {
    id: run.id,
    task: run.task,
    taskMessageId: `agent-run-task-${run.id}`,
    finalMessageId: run.finalMessageId ?? null,
    status: run.status,
    statusLabel: run.status.replaceAll("_", " "),
    active: !isTerminalRunStatus(run.status),
    actionPending: Boolean(latestStep && !latestStep.action && !latestStep.rejection),
    provisional: provisionalRunIds.has(run.id),
    cancellationRequested: run.cancellationRequested,
    reason: run.reason ?? run.cancellationReason ?? null,
    steps: run.steps.flatMap((_, index) => {
      const step = stepView(state, run, index);
      return step ? [step] : [];
    }),
  };
}

export function buildTerminalScreen(presentation: TerminalPresentation): TerminalScreenView {
  const { state, capabilities } = presentation;
  const provider = capabilities.providers.find(item => item.name === state.model.provider);
  const provisionalRunIds = new Set(presentation.provisionalRunIds);
  const runs = Object.values(state.agentRuns).map(run => runView(state, run, provisionalRunIds)).slice(-12);
  const activeRun = [...runs].reverse().find(run => run.active);
  const familyChildren = buildTerminalFamilyChildren(presentation.family.children);
  const ancestry = presentation.family.ancestry.length
    ? [...presentation.family.ancestry.slice(0, -1), state.sessionName ?? "Unnamed session"]
    : [state.sessionName ?? "Unnamed session"];
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
    model: `${state.model.provider}:${state.model.model} · ${state.model.reasoningEffort}`,
    providerMode: streaming,
    connection: presentation.connection,
    historicalCursor: presentation.historicalCursor,
    ancestry,
    conversation: visibleConversation(state.messages),
    runs,
    familyChildren,
    familyParent: presentation.family.parent,
    familySummary: buildTerminalFamilySummary(familyChildren),
    familyRefresh: presentation.family.refresh,
    runState: activeRun?.statusLabel ?? [...runs].at(-1)?.statusLabel ?? "idle",
    composerPlaceholder: activeRun
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


import type { AgentRunState, AgentState, CellLogStream, JsonValue, MessageState } from "../domain/index.ts";
import type { ProtocolCapabilities } from "../protocol/index.ts";
import type { ProductBranchSummary } from "../product/index.ts";
import type {
  FamilyAgentActivity,
  FamilyAgentActivityReason,
  FamilyAgentRecord,
  ModelContractDiagnosticOutcome,
  RefinementReviewRecord,
} from "../runtime/index.ts";
import { deriveModelContractCallDiagnostic } from "../runtime/index.ts";
import { scrubText } from "../security/index.ts";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"]);

export type TerminalConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";
export type TerminalFamilyRefreshState = "current" | "refreshing" | "stale" | "unavailable";
export type TerminalWorkspaceAgentsRefreshState = "loading" | "current" | "stale" | "unavailable";
export type TerminalRefinementRefreshState = "refreshing" | "current" | "stale" | "unavailable";

export interface TerminalRoute {
  readonly sessionId: string;
  readonly branchId: string;
}

export interface TerminalFamilyNavigation {
  readonly route: TerminalRoute;
  readonly parent: FamilyAgentRecord | null;
  readonly children: readonly FamilyAgentRecord[];
  readonly ancestry: readonly string[];
  readonly root: boolean | null;
  readonly refresh: TerminalFamilyRefreshState;
  readonly generation: number;
}

export interface TerminalWorkspaceAgentsState {
  readonly open: boolean;
  readonly returnRoute: TerminalRoute;
  readonly rows: readonly ProductBranchSummary[];
  readonly selectedKey: string | null;
  readonly query: string;
  readonly refresh: TerminalWorkspaceAgentsRefreshState;
  readonly fetchedAt: string | null;
  readonly generation: number;
}

export interface TerminalPresentation {
  readonly state: AgentState;
  readonly workspaceLabel: string;
  readonly capabilities: ProtocolCapabilities;
  readonly historicalCursor: string | null;
  readonly connection: TerminalConnectionState;
  readonly provisionalRunIds: readonly string[];
  readonly family: TerminalFamilyNavigation;
  readonly workspaceAgents: TerminalWorkspaceAgentsState;
  readonly refinementReviews: readonly RefinementReviewRecord[];
  readonly refinementRefresh: TerminalRefinementRefreshState;
}

export interface TerminalConversationItem {
  readonly id: string;
  readonly role: "user" | "assistant" | "runtime";
  readonly content: string;
}

export interface TerminalRefinementSummary {
  readonly request: string;
  readonly status: string;
  readonly result: string;
  readonly reason: string | null;
  readonly guidance: string | null;
  readonly changed: boolean;
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

export type TerminalWorkspaceAgentStatus = ProductBranchSummary["status"];

export interface TerminalWorkspaceAgentRow extends TerminalRoute {
  readonly key: string;
  readonly sessionName: string;
  readonly branchName: string;
  readonly displayName: string;
  readonly model: string;
  readonly status: TerminalWorkspaceAgentStatus;
  readonly task: string;
  readonly unresolvedWork: number;
  readonly activeGoals: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resumable: boolean;
}

export interface TerminalWorkspaceAgentSection {
  readonly status: TerminalWorkspaceAgentStatus;
  readonly title: string;
  readonly rows: readonly TerminalWorkspaceAgentRow[];
}

export interface TerminalWorkspaceAgentsView {
  readonly open: boolean;
  readonly returnRoute: TerminalRoute;
  readonly rows: readonly TerminalWorkspaceAgentRow[];
  readonly sections: readonly TerminalWorkspaceAgentSection[];
  readonly selectedKey: string | null;
  readonly query: string;
  readonly refresh: TerminalWorkspaceAgentsRefreshState;
  readonly fetchedAt: string | null;
}

export interface TerminalScreenView {
  readonly workspaceId: string;
  readonly workspaceLabel: string;
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
  readonly familyRoot: boolean | null;
  readonly familyRefresh: TerminalFamilyRefreshState;
  readonly workspaceAgents: TerminalWorkspaceAgentsView;
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

const WORKSPACE_AGENT_STATUS_ORDER: readonly TerminalWorkspaceAgentStatus[] = [
  "running",
  "idle",
  "stopped",
  "failed",
  "archived",
];

const WORKSPACE_AGENT_STATUS_TITLES: Readonly<Record<TerminalWorkspaceAgentStatus, string>> = {
  running: "Running",
  idle: "Idle",
  stopped: "Stopped",
  failed: "Failed",
  archived: "Archived",
};

function normalizedWorkspaceLabel(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function workspaceAgentName(value: string, fallback: string): string {
  const normalized = scrubText(value).replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

export function terminalWorkspaceAgentKey(route: TerminalRoute): string {
  return `${route.sessionId}\u0000${route.branchId}`;
}

export function buildTerminalWorkspaceAgentRows(
  summaries: readonly ProductBranchSummary[],
  query = "",
): TerminalWorkspaceAgentRow[] {
  const roots = summaries.filter(summary => summary.root);
  const branchesPerSession = new Map<string, number>();
  for (const summary of roots) {
    branchesPerSession.set(summary.sessionId, (branchesPerSession.get(summary.sessionId) ?? 0) + 1);
  }
  const normalizedQuery = normalizedWorkspaceLabel(query);
  return roots
    .map((summary): TerminalWorkspaceAgentRow => {
      const sessionName = workspaceAgentName(summary.sessionName, "Unnamed agent");
      const branchName = workspaceAgentName(summary.branchName, "unnamed branch");
      return {
        key: terminalWorkspaceAgentKey(summary),
        sessionId: summary.sessionId,
        branchId: summary.branchId,
        sessionName,
        branchName,
        displayName: (branchesPerSession.get(summary.sessionId) ?? 0) > 1
          ? `${sessionName} / ${branchName}`
          : sessionName,
        model: scrubText(`${summary.model.provider}:${summary.model.model}`),
        status: summary.status,
        task: workspaceAgentName(summary.taskSummary ?? "", "No retained task summary"),
        unresolvedWork: summary.unresolvedWork,
        activeGoals: summary.activeGoals,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        resumable: summary.status !== "failed" && summary.status !== "archived",
      };
    })
    .filter(row => !normalizedQuery || [
      row.sessionName,
      row.branchName,
      row.task,
      row.model,
      row.status,
    ].some(value => normalizedWorkspaceLabel(value).includes(normalizedQuery)))
    .sort((left, right) =>
      WORKSPACE_AGENT_STATUS_ORDER.indexOf(left.status) - WORKSPACE_AGENT_STATUS_ORDER.indexOf(right.status)
      || right.updatedAt.localeCompare(left.updatedAt)
      || normalizedWorkspaceLabel(left.sessionName).localeCompare(normalizedWorkspaceLabel(right.sessionName))
      || normalizedWorkspaceLabel(left.branchName).localeCompare(normalizedWorkspaceLabel(right.branchName))
      || left.sessionId.localeCompare(right.sessionId)
      || left.branchId.localeCompare(right.branchId));
}

export function selectTerminalWorkspaceAgentKey(
  summaries: readonly ProductBranchSummary[],
  query: string,
  selectedKey: string | null,
  selectedIndexHint?: number,
): string | null {
  const visible = buildTerminalWorkspaceAgentRows(summaries, query);
  if (selectedKey && visible.some(row => row.key === selectedKey)) return selectedKey;
  if (!visible.length) return null;
  const preferred = visible.filter(row => row.resumable);
  const candidates = preferred.length ? preferred : visible;
  if (!selectedKey) return candidates[0]!.key;
  const all = buildTerminalWorkspaceAgentRows(summaries);
  const selectedIndex = all.findIndex(row => row.key === selectedKey);
  const anchorIndex = selectedIndex >= 0 ? selectedIndex : selectedIndexHint;
  if (anchorIndex === undefined || anchorIndex < 0) return candidates[0]!.key;
  return [...candidates]
    .sort((left, right) =>
      Math.abs(all.findIndex(row => row.key === left.key) - anchorIndex)
      - Math.abs(all.findIndex(row => row.key === right.key) - anchorIndex)
      || all.findIndex(row => row.key === left.key) - all.findIndex(row => row.key === right.key))[0]!.key;
}

export function buildTerminalWorkspaceAgentsView(
  state: TerminalWorkspaceAgentsState,
): TerminalWorkspaceAgentsView {
  const rows = buildTerminalWorkspaceAgentRows(state.rows, state.query);
  const selectedKey = selectTerminalWorkspaceAgentKey(state.rows, state.query, state.selectedKey);
  return {
    open: state.open,
    returnRoute: state.returnRoute,
    rows,
    sections: WORKSPACE_AGENT_STATUS_ORDER.flatMap(status => {
      const statusRows = rows.filter(row => row.status === status);
      return statusRows.length
        ? [{ status, title: WORKSPACE_AGENT_STATUS_TITLES[status], rows: statusRows }]
        : [];
    }),
    selectedKey,
    query: state.query,
    refresh: state.refresh,
    fetchedAt: state.fetchedAt,
  };
}

export function formatTerminalWorkspaceAgentsRelativeTime(
  timestamp: string,
  now = Date.now(),
): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return "updated time unknown";
  const seconds = Math.max(0, Math.floor((now - parsed) / 1_000));
  if (seconds < 60) return "updated just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `updated ${days}d ago`;
}

export interface TerminalWorkspaceAgentRowLines {
  readonly primary: string;
  readonly secondary: string | null;
}

export function formatTerminalWorkspaceAgentRow(
  row: TerminalWorkspaceAgentRow,
  maxWidth: number,
  selected: boolean,
  now = Date.now(),
): TerminalWorkspaceAgentRowLines {
  const width = Math.max(1, maxWidth);
  const prefix = selected ? "› " : "  ";
  const status = ` · ${row.status}${row.resumable ? "" : " · cannot open"}`;
  const primary = `${prefix}${truncate(row.displayName, Math.max(1, width - prefix.length - status.length))}${status}`;
  const relative = formatTerminalWorkspaceAgentsRelativeTime(row.updatedAt, now);
  const counts = `${row.unresolvedWork} unresolved · ${row.activeGoals} goals`;
  const details = width >= 96
    ? `${row.task} · ${row.model} · ${counts} · ${relative}`
    : width >= 76
      ? `${row.task} · ${counts} · ${relative}`
      : width >= 60
        ? `${counts} · ${relative}`
        : width >= 48
          ? relative
          : null;
  return {
    primary: truncate(primary, width),
    secondary: details === null ? null : `  ${truncate(details, Math.max(1, width - 2))}`,
  };
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

function structuredRefinementConversation(
  state: AgentState,
): TerminalConversationItem[] {
  return Object.values(state.modelCalls).flatMap((call) => {
    const contract = call.modelDispatch.responseContract;
    if (contract.kind !== "required-tool-set" ||
        !contract.contractId.startsWith("agencity.refinement-")) return [];
    const label = contract.contractId.includes("governance")
      ? "learning governance review"
      : "learning reflection";
    let content: string;
    if (call.status === "requested") {
      content = `Structured ${label} is running. Its formal result is retained without an assistant chat message.`;
    } else if (call.status === "succeeded" && call.result?.kind === "tool-submission") {
      content = `Structured ${label} submitted ${call.result.name}. The decision is retained on the parent session.`;
    } else if (call.status === "failed" || call.status === "cancelled" ||
        call.status === "unknown") {
      content = `Structured ${label} ended ${call.status}${call.error ? `: ${oneLine(call.error)}` : "."}`;
    } else {
      content = `Structured ${label} ended without a valid formal submission.`;
    }
    return [{
      id: `structured-result:${call.id}`,
      role: "runtime" as const,
      content,
    }];
  });
}

const GOVERNED_REFINEMENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  proposed: "Proposal pending validation",
  validated: "Proposal validated; governance pending",
  reviewing: "Governance review running",
  deterministically_rejected: "Proposal rejected",
  reviewed_rejected: "Governance reviewer rejected the proposal",
  review_failed: "Governance review failed",
  review_unknown: "Governance outcome unknown",
  reviewed_approved: "Proposal approved; application pending",
  apply_conflict: "Application conflict",
  apply_failed: "Application failed",
  applied: "Applied",
});

const TERMINAL_GOVERNED_WITHOUT_CHANGE = new Set([
  "deterministically_rejected",
  "reviewed_rejected",
  "review_failed",
  "review_unknown",
  "apply_conflict",
  "apply_failed",
]);

function refinementRequest(record: RefinementReviewRecord): string {
  const instructions = record.instructions?.trim();
  if (instructions) return oneLine(scrubText(instructions), 500);
  if (record.mode === "automatic") {
    return `Automatic ${record.triggerKind.replaceAll("_", " ")} review`;
  }
  if (record.mode === "skill_creation") return "Create a tested reusable skill from retained work";
  return "Review the retained trajectory for a behavioral improvement";
}

function governedResult(record: RefinementReviewRecord): Record<string, JsonValue> {
  return record.governedResult && typeof record.governedResult === "object" &&
      !Array.isArray(record.governedResult)
    ? record.governedResult as Record<string, JsonValue>
    : {};
}

/** Human-facing retained outcome for one trajectory review and any linked governance. */
export function summarizeTerminalRefinement(
  record: RefinementReviewRecord,
): TerminalRefinementSummary {
  const governed = governedResult(record);
  const governedStatus = record.governedStatus;
  const governedReason = typeof governed.reason === "string" ? governed.reason : null;
  const reason = oneLine(scrubText(governedReason ?? record.reason ?? ""), 700) || null;
  const appliedVersionIds = Array.isArray(governed.appliedVersionIds)
    ? governed.appliedVersionIds.filter((value): value is string => typeof value === "string")
    : [];
  if (governedStatus === "applied") {
    const count = Math.max(1, appliedVersionIds.length);
    return {
      request: refinementRequest(record),
      status: GOVERNED_REFINEMENT_LABELS.applied!,
      result: `${count} behavioral harness artifact version${count === 1 ? "" : "s"} changed.`,
      reason,
      guidance: "Reviewer approval establishes policy consistency, not proven improvement.",
      changed: true,
    };
  }
  if (governedStatus) {
    const terminal = TERMINAL_GOVERNED_WITHOUT_CHANGE.has(governedStatus);
    return {
      request: refinementRequest(record),
      status: GOVERNED_REFINEMENT_LABELS[governedStatus] ?? governedStatus.replaceAll("_", " "),
      result: terminal
        ? "No behavioral harness artifact changed."
        : "No behavioral harness artifact has changed yet.",
      reason,
      guidance: null,
      changed: false,
    };
  }
  switch (record.status) {
    case "requested":
      return {
        request: refinementRequest(record),
        status: "Review queued",
        result: "No behavioral harness artifact has changed yet.",
        reason,
        guidance: null,
        changed: false,
      };
    case "running":
      return {
        request: refinementRequest(record),
        status: "Review running",
        result: "No behavioral harness artifact has changed yet.",
        reason,
        guidance: null,
        changed: false,
      };
    case "candidate":
      return {
        request: refinementRequest(record),
        status: "Proposal pending governance",
        result: "No behavioral harness artifact has changed yet.",
        reason,
        guidance: null,
        changed: false,
      };
    case "no_change":
      return {
        request: refinementRequest(record),
        status: "No change",
        result: "No behavioral harness artifact changed.",
        reason,
        guidance: "Refinement updates memory, prompt notes, tested skills, or subagent specifications. Submit code, repository, or runtime implementation as a normal task.",
        changed: false,
      };
    case "revision_required":
      return {
        request: refinementRequest(record),
        status: "Revision required",
        result: "No behavioral harness artifact changed.",
        reason,
        guidance: null,
        changed: false,
      };
    case "failed":
      return {
        request: refinementRequest(record),
        status: "Review failed",
        result: "No behavioral harness artifact changed.",
        reason,
        guidance: null,
        changed: false,
      };
    case "cancelled":
      return {
        request: refinementRequest(record),
        status: "Review cancelled",
        result: "No behavioral harness artifact changed.",
        reason,
        guidance: null,
        changed: false,
      };
    case "unknown":
      return {
        request: refinementRequest(record),
        status: "Review outcome unknown",
        result: "No behavioral harness artifact change is confirmed.",
        reason,
        guidance: null,
        changed: false,
      };
  }
  return {
    request: refinementRequest(record),
    status: "Review status unavailable",
    result: "No behavioral harness artifact change is confirmed.",
    reason,
    guidance: null,
    changed: false,
  };
}

export function retainedRefinementConversation(
  records: readonly RefinementReviewRecord[],
  refresh: TerminalRefinementRefreshState,
): TerminalConversationItem[] {
  const items = records.slice(-8).map((record): TerminalConversationItem => {
    const summary = summarizeTerminalRefinement(record);
    const content = [
      `**Request:** ${summary.request}`,
      `**Status:** ${summary.status}`,
      summary.result,
      ...(summary.reason ? [`**Reason:** ${summary.reason}`] : []),
      ...(summary.guidance ? [`**Next:** ${summary.guidance}`] : []),
    ].join("\n\n");
    return {
      id: `refinement-review:${record.reviewId}`,
      role: "runtime",
      content,
    };
  });
  if (refresh === "stale" && items.length) {
    items.push({
      id: "refinement-review:stale",
      role: "runtime",
      content: "Refinement history is temporarily stale. Retained results remain visible; use `/refine history` to retry.",
    });
  }
  return items;
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
  const runs = Object.values(state.agentRuns).slice(-12)
    .map(run => runView(state, run, provisionalRunIds));
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
    workspaceLabel: presentation.workspaceLabel,
    sessionName: state.sessionName ?? "Unnamed session",
    branchName: state.branch.name ?? "unnamed branch",
    model: `${state.model.provider}:${state.model.model} · ${state.model.reasoningEffort}`,
    providerMode: streaming,
    connection: presentation.connection,
    historicalCursor: presentation.historicalCursor,
    ancestry,
    conversation: [
      ...visibleConversation(state.messages),
      ...structuredRefinementConversation(state),
      ...(presentation.historicalCursor === null
        ? retainedRefinementConversation(presentation.refinementReviews, presentation.refinementRefresh)
        : []),
    ].slice(-24),
    runs,
    familyChildren,
    familyParent: presentation.family.parent,
    familySummary: buildTerminalFamilySummary(familyChildren),
    familyRoot: presentation.family.root,
    familyRefresh: presentation.family.refresh,
    workspaceAgents: buildTerminalWorkspaceAgentsView(presentation.workspaceAgents),
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


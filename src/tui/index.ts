import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  AgentRuntimeError,
  EVENT_SCHEMA_VERSION,
  REDUCER_VERSION,
  normalizeReasoningEffort,
  projectEvents,
  reduceAgentState,
  resolveSessionTitlePresentation,
  type AgentEvent,
  type AgentState,
  type GovernedRefinementRecord,
  type HarnessKind,
} from "../domain/index.ts";
import {
  ProtocolClientError,
  type AgentClient, type BranchWatchHandlers, type ProtocolCapabilities,
} from "../protocol/index.ts";
import type {
  FamilyAgentRecord,
  RecoverySummaryView,
  RefinementReviewRecord,
  StartRefinementReviewInput,
} from "../runtime/index.ts";
import { scrubText } from "../security/index.ts";
import type { ModelConfiguration } from "../domain/index.ts";
import {
  buildTerminalWorkspaceAgentRows,
  selectTerminalWorkspaceAgentKey,
  terminalWorkspaceAgentKey,
  type TerminalConnectionState,
  type TerminalFamilyNavigation,
  type TerminalPresentation,
  type TerminalRefinementRefreshState,
  type TerminalWorkspaceAgentsState,
} from "./view-model.ts";
import {
  buildTerminalDetail,
  buildTerminalModelDetail,
  formatTerminalDetail,
  formatTerminalRaw,
  type TerminalDetail,
  type TerminalEffortDetail,
} from "./detail-model.ts";

export type TerminalAgentClient = Pick<AgentClient,
  "capabilities" | "snapshot" | "watchBranch" | "history" | "productSessions" | "productSelect" |
  "createSession" | "modelProviders" | "startRun" | "run" | "cancelRun" |
  "productConfig" | "productSetModel" | "productSetReasoningEffort" | "productSetProviderKey" | "selectModel" | "modelCatalog" | "agentToolCapability" | "modelContractDiagnostics" |
  "cell" | "fork" | "resume" | "inspectContext" | "compact" | "agents" | "tasks" | "mailbox" | "cancelTask" |
  "goals" | "currentGoal" | "createGoal" | "pauseGoal" | "resumeGoal" | "clearGoal" | "requestGoalCompletion" |
  "heartbeats" | "createHeartbeat" | "pauseHeartbeat" | "resumeHeartbeat" | "cancelHeartbeat" |
  "schedules" | "createSchedule" | "pauseSchedule" | "resumeSchedule" | "clearSchedule" |
  "memoryList" | "memorySearch" | "harnessList" | "listSkills" | "getSkill" | "previewSkillImport" | "installSkill" | "enableSkill" | "disableSkill" | "removeSkill" | "proposeSkill" | "agentProfile" | "agentProfiles" | "proposeProfileUpdate" | "governedRefinements" | "rollbackRefinement" | "rollbackGovernedRefinement" | "refinements" | "requestRefinement" | "refinementReviews" | "refinementPolicy" | "setAutomaticRefinement" | "learningStatus" | "learningHistory" | "learningActivity" | "pauseAutomaticLearning" | "resumeAutomaticLearning" | "userCorrection" | "refine" | "validateRefinement" | "rollback" | "invokeSkill" | "testSkill" |
  "syncStatus" | "syncNow" | "syncConflicts" | "resolveSyncConflict" | "recoverySummary" | "unknownEffects" |
  "inspectUnknownEffect" | "reconcileUnknownEffect"
> & Partial<Pick<AgentClient, "abortPendingRequests" | "serviceStatus">>;

export interface TerminalUIOptions {
  readonly workspaceId?: string;
  readonly workspaceLabel?: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: Pick<NodeJS.WriteStream, "write">;
  readonly interactive?: boolean;
  readonly manageSignals?: boolean;
  readonly onOutput?: (value: string) => void;
  readonly onDetail?: (detail: TerminalDetail | null) => void;
  readonly onProvisionalOutput?: (effectId: string, value: string) => void;
  readonly onProvisionalDiscard?: (effectIds: readonly string[], reason: "committed" | "disconnect" | "reconnect") => void;
  readonly familyRefreshIntervalMs?: number;
  readonly familyRefreshScheduler?: {
    setTimeout(callback: () => void, milliseconds: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

export type TerminalPresentationListener = (presentation: TerminalPresentation) => void;


export type TerminalCommandCategory = "product" | "status" | "notebook" | "autonomy" | "operations";
export interface TerminalCommandDefinition {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly category: TerminalCommandCategory;
  readonly usage: string;
  readonly summary: string;
}

/** Public palette metadata shared by the terminal renderer and command tests. */
export const TERMINAL_COMMAND_REGISTRY: readonly TerminalCommandDefinition[] = Object.freeze([
  { name: "/new", aliases: [], category: "product", usage: "/new [NAME]", summary: "Create and select a new root session." },
  { name: "/sessions", aliases: [], category: "product", usage: "/sessions [select NAME|ID]", summary: "List or select retained work." },
  { name: "/run", aliases: [], category: "product", usage: "/run TASK", summary: "Start typed autonomous work." },
  { name: "/stop", aliases: [], category: "product", usage: "/stop", summary: "Request durable run cancellation." },
  { name: "/quit", aliases: ["/exit"], category: "product", usage: "/quit", summary: "Detach without cancellation." },
  { name: "/info", aliases: ["/status"], category: "status", usage: "/info", summary: "Show model, recovery, trust, and protocol status." },
  { name: "/model", aliases: [], category: "status", usage: "/model [PROVIDER:MODEL|login PROVIDER|logout PROVIDER]", summary: "Open the provider picker or use a compatible direct model command." },
  { name: "/effort", aliases: ["/thinking"], category: "status", usage: "/effort [provider-default|none|minimal|low|medium|high|xhigh|refresh]", summary: "Inspect or change reasoning effort on an idle branch." },
  { name: "/budget", aliases: [], category: "status", usage: "/budget", summary: "Show committed budget usage." },
  { name: "/snapshot", aliases: [], category: "status", usage: "/snapshot", summary: "Show a structured overview of the projected state." },
  { name: "/mailbox", aliases: [], category: "status", usage: "/mailbox", summary: "Show retained family messages and receipts." },
  { name: "/tasks", aliases: [], category: "status", usage: "/tasks", summary: "Show retained child tasks." },
  { name: "/cancel-task", aliases: [], category: "status", usage: "/cancel-task TASK_ID [REASON]", summary: "Request durable child-task cancellation." },
  { name: "/agents", aliases: [], category: "product", usage: "/agents", summary: "Open retained root work in this workspace." },
  { name: "/tree", aliases: [], category: "status", usage: "/tree", summary: "Show the current retained family, tasks, and mailbox." },
  { name: "/goal", aliases: ["/goals"], category: "autonomy", usage: "/goal [create DESCRIPTION|pause|resume|clear|complete]", summary: "Inspect or manage the current goal." },
  { name: "/heartbeat", aliases: ["/heartbeats"], category: "autonomy", usage: "/heartbeat [create MS [PROMPT]|pause N|resume N|clear N]", summary: "Inspect or manage heartbeats." },
  { name: "/schedule", aliases: ["/schedules"], category: "autonomy", usage: "/schedule [once ISO PROMPT|every MS PROMPT|pause N|resume N|clear N]", summary: "Inspect or manage schedules." },
  { name: "/history", aliases: [], category: "notebook", usage: "/history [CURSOR]", summary: "Inspect structured history or enter a read-only historical projection." },
  { name: "/live", aliases: [], category: "notebook", usage: "/live", summary: "Return from historical inspection to live committed state." },
  { name: "/cells", aliases: [], category: "notebook", usage: "/cells", summary: "Show retained notebook cells." },
  { name: "/cell", aliases: [], category: "notebook", usage: "/cell TYPESCRIPT", summary: "Execute a diagnostic TypeScript cell." },
  { name: "/branch", aliases: [], category: "notebook", usage: "/branch CURSOR [NAME]", summary: "Fork without replaying effects." },
  { name: "/resume", aliases: [], category: "notebook", usage: "/resume [BRANCH]", summary: "Resume a retained branch." },
  { name: "/context", aliases: [], category: "notebook", usage: "/context", summary: "Inspect context capacity and effective compaction provenance." },
  { name: "/compact", aliases: [], category: "notebook", usage: "/compact [extractive|summary] [PRESERVE...]", summary: "Commit a guided source-linked context derivation." },
  { name: "/memory", aliases: [], category: "status", usage: "/memory [QUERY]", summary: "Inspect scoped memory." },
  { name: "/skills", aliases: [], category: "status", usage: "/skills [show|preview|install|test|enable|disable|remove|propose]", summary: "Inspect and manage the unified workspace/profile skill catalog." },
  { name: "/skill", aliases: [], category: "status", usage: "/skill ENTRY_ID JSON", summary: "Invoke a retained skill version." },
  { name: "/skill-test", aliases: [], category: "status", usage: "/skill-test ENTRY_ID [VERSION_ID]", summary: "Run a retained skill test." },
  { name: "/profile", aliases: [], category: "status", usage: "/profile [show|history|proposals|propose JSON|repropose latest|N JSON|rollback REVISION JSON]", summary: "Inspect and explicitly govern this agent's behavioral profile." },
  { name: "/refine", aliases: [], category: "status", usage: "/refine [status|history|inspect ID|pause|resume|auto on|off|rollback PROPOSAL REASON|correct IDS -- TEXT|propose-json JSON|--wait|--detach] [--kind KIND[,KIND]] [INSTRUCTIONS]", summary: "Inspect automatic learning, control admission, reverse an applied change, or start a governed reflection; submit code/runtime work as a normal task." },
  { name: "/rollback", aliases: [], category: "status", usage: "/rollback PROPOSAL_ID REASON", summary: "Advanced legacy measured-candidate rollback." },
  { name: "/sync", aliases: [], category: "operations", usage: "/sync", summary: "Run explicit synchronization." },
  { name: "/sync-status", aliases: [], category: "operations", usage: "/sync-status", summary: "Inspect sync lifecycle." },
  { name: "/conflicts", aliases: [], category: "operations", usage: "/conflicts", summary: "Inspect unresolved sync conflicts." },
  { name: "/resolve-conflict", aliases: [], category: "operations", usage: "/resolve-conflict CONFLICT_ID JSON", summary: "Commit an explicit sync-conflict resolution." },
  { name: "/unknown", aliases: [], category: "operations", usage: "/unknown [EFFECT_ID]", summary: "Inspect unknown effects and assessments." },
  { name: "/reconcile", aliases: [], category: "operations", usage: "/reconcile EFFECT_ID ASSESSMENT SUMMARY", summary: "Append evidence without retrying or rewriting status." },
  { name: "/raw", aliases: [], category: "operations", usage: "/raw", summary: "Open raw diagnostics for the latest inspector result." },
  { name: "/help", aliases: [], category: "product", usage: "/help", summary: "Show this command palette." },
]);

export type InterruptDecision =
  | { readonly action: "cancel"; readonly runId: string }
  | { readonly action: "detach"; readonly warning: string };

/** Pure state machine: process exit is never represented as cancellation success. */
export class TerminalInterruptPolicy {
  #requestedRunId: string | null = null;
  decide(activeRunId: string | null): InterruptDecision {
    if (activeRunId && this.#requestedRunId !== activeRunId) {
      this.#requestedRunId = activeRunId;
      return { action: "cancel", runId: activeRunId };
    }
    return {
      action: "detach",
      warning: activeRunId
        ? "Detaching after a cancellation request. Durable/external work may outlive this client; cancellation is not yet confirmed."
        : "Detaching. Durable work, if any, may outlive this client.",
    };
  }
  reset(): void { this.#requestedRunId = null; }
}

export function renderStartupStatus(
  state: AgentState,
  capabilities: ProtocolCapabilities,
  recovery: RecoverySummaryView,
  agentTools = capabilities.agentTools?.selected,
): string {
  const provider = capabilities.providers.find((item) => item.name === state.model.provider);
  const streaming = provider?.capabilities.streaming ? "incremental progress" : "committed responses only";
  const sync = capabilities.sync && typeof capabilities.sync === "object" && "configured" in capabilities.sync
    ? (capabilities.sync as { configured?: boolean }).configured ? "configured" : "local only"
    : "unknown";
  return [
    "Agencity trusted-local TUI (protocol-backed terminal client)",
    `Session: ${resolveSessionTitlePresentation(state, "Start new session", true).text} / ${state.branch.name ?? "unnamed branch"}`,
    `Model: ${state.model.provider}:${state.model.model} · effort ${state.model.reasoningEffort} (${streaming})`,
    // A missing selected-capability view is absence of facts, not evidence of
    // an unavailable contract, so no state is claimed for it.
    ...(agentTools === undefined
      ? []
      : [`Agent tools: bun_console + finish · ${agentTools.state}${agentTools.canRun ? "" : " [UNAVAILABLE]"}`]),
    ...(agentTools?.reason ? [`Agent-tool detail: ${agentTools.reason}`] : []),
    "Authority: TRUSTED-LOCAL; generated code has the runtime process's OS authority (not sandboxed)",
    `Protocol: snapshot+cursor resume=${capabilities.snapshotCursorResume}; progress is ephemeral; sync=${sync}`,
    `Recovery: ${recovery.pendingEffectIds.length} pending effects, ${recovery.unknownEffects.length} unknown, ${recovery.activeChildTaskIds.length} active children, ${recovery.attentionGoalGateIds.length} failed/unknown/running gates`,
    recovery.cancellationRequestedRunIds.length
      ? `Cancellation reconciliation pending for ${recovery.cancellationRequestedRunIds.length} run${recovery.cancellationRequestedRunIds.length === 1 ? "" : "s"}`
      : "Cancellation reconciliation: none pending",
  ].join("\n");
}

/** Render only scrubbed, typed command failures; protocol details are intentionally omitted. */
export function renderTerminalError(error: unknown, context = "command"): string {
  const code = error instanceof ProtocolClientError
    ? error.code
    : error instanceof AgentRuntimeError
      ? error.code
      : "VALIDATION_ERROR";
  const status = error instanceof ProtocolClientError ? ` status=${error.status}` : "";
  const raw = error instanceof Error ? error.message : String(error);
  const prefix = `[${code}] `;
  const message = scrubText(raw.startsWith(prefix) ? raw.slice(prefix.length) : raw);
  return `[${context} error:${code}${status}] ${message}`;
}

const LIVE_SUMMARY_MAX_CHARS = 240;

function conciseValue(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const oneLine = scrubText((serialized ?? String(value)).replace(/\s+/g, " ").trim());
  return oneLine.length <= LIVE_SUMMARY_MAX_CHARS ? oneLine : `${oneLine.slice(0, LIVE_SUMMARY_MAX_CHARS - 1)}…`;
}

/**
 * Render the small user-facing projection used by the live TUI. Canonical
 * event payloads, identifiers, and cursors remain available through /history.
 */
export function renderEvent(event: AgentEvent): string | null {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "MessageAppended":
      return payload.role === "assistant" ? `assistant: ${String(payload.content)}` : null;
    case "SessionModelChanged":
      return `[model changed] ${String((payload.model as { provider?: string } | undefined)?.provider ?? "")}:${String((payload.model as { model?: string } | undefined)?.model ?? "")}`;
    case "CellCommitted":
      return `[cell complete] ${conciseValue(payload.result)}`;
    case "CellFailed":
      return `[cell failed] ${conciseValue(payload.error)}`;
    case "EffectOutcomeRecorded":
      if (payload.outcome === "unknown") return "[operation outcome unknown] Inspect with /unknown before retrying.";
      if (payload.outcome === "failed") return `[operation failed] ${conciseValue(payload.error ?? "No error details were recorded.")}`;
      return null;
    case "EffectReconciliationRecorded":
      return `[unknown outcome assessed as ${String(payload.assessment)}; the durable outcome remains unknown]`;
    case "ModelCallCompleted":
      return Array.isArray(payload.warnings) && payload.warnings.length
        ? payload.warnings.map((warning) => `[model warning] ${conciseValue((warning as { message?: unknown }).message)}`).join("\n")
        : null;
    case "RefinementReviewRequested":
      return `[learning reflection requested] ${conciseValue(payload.instructions ?? payload.triggerKind ?? "trajectory review")}`;
    case "RefinementReviewChildLinked":
      return "[learning reflection started]";
    case "RefinementReviewStatusChanged":
      return payload.status === "running"
        ? "[learning reflection running]"
        : `[learning activity ${String(payload.status).replaceAll("_", " ")}]${payload.reason ? ` ${conciseValue(payload.reason)}` : ""}`;
    case "RefinementGovernanceReviewRequested":
      return "[learning governance requested]";
    case "RefinementGovernanceReviewChildLinked":
      return "[learning governance reviewer started]";
    case "RefinementGovernanceReviewDecided":
      return `[learning governance ${String(payload.status ?? "decided").replaceAll("_", " ")}]`;
    case "RefinementProposalTerminalNoticeDelivered":
      return renderGovernanceNotice(payload.result);
    case "AgentRunStatusChanged": {
      const reason = payload.reason ? ` — ${conciseValue(payload.reason)}` : "";
      switch (payload.status) {
        case "succeeded": return "[run complete]";
        case "blocked": return `[run blocked]${reason}`;
        case "failed": return `[run failed]${reason}`;
        case "cancelled": return `[run cancelled]${reason}`;
        case "budget_exceeded": return `[run stopped: budget exceeded]${reason}`;
        case "unknown": return `[run outcome unknown]${reason}`;
        default: return null;
      }
    }
    default:
      return null;
  }
}

const GOVERNANCE_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  proposed: "pending validation",
  validated: "validated; reviewer pending",
  reviewing: "reviewing",
  deterministically_rejected: "deterministically rejected",
  reviewed_rejected: "reviewer rejected",
  review_failed: "review failed",
  review_unknown: "review outcome unknown",
  reviewed_approved: "reviewer approved; application pending",
  apply_conflict: "apply conflict",
  apply_failed: "apply failed",
  applied: "applied",
});

export function renderGovernanceNotice(value: unknown): string {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const status = String(record.status ?? "unknown");
  const decision = record.decision && typeof record.decision === "object" && !Array.isArray(record.decision)
    ? record.decision as Record<string, unknown>
    : {};
  const reason = record.reason ?? decision.reason;
  const guidance = decision.revisionGuidance;
  const targetKind = String(record.targetKind ?? "");
  const label = targetKind === "agent_profile"
    ? "profile governance"
    : "learning governance";
  const suffix = [
    reason ? `Reason: ${conciseValue(reason)}` : "",
    guidance ? `Guidance: ${conciseValue(guidance)}` : "",
    status === "applied"
      ? "Reviewer approval establishes policy consistency, not proven improvement."
      : "",
  ].filter(Boolean).join(" ");
  return `[${label}: ${GOVERNANCE_STATUS_LABELS[status] ?? status.replaceAll("_", " ")}]${suffix ? ` ${suffix}` : ""}`;
}

const TERMINAL_REFINEMENT_KINDS = new Set<HarnessKind>([
  "memory",
  "prompt_note",
  "skill",
  "subagent_spec",
]);

/** Parse user-facing refinement controls without rewriting retained instructions. */
export function parseTerminalRefinementRequest(
  command: string,
): StartRefinementReviewInput {
  let remaining = command.trim();
  let wait = false;
  let detach = false;
  let allowedKinds: HarnessKind[] | undefined;
  while (remaining.startsWith("--")) {
    if (remaining === "--wait" || remaining.startsWith("--wait ")) {
      wait = true;
      remaining = remaining.slice("--wait".length).trimStart();
      continue;
    }
    if (remaining === "--detach" || remaining.startsWith("--detach ")) {
      detach = true;
      remaining = remaining.slice("--detach".length).trimStart();
      continue;
    }
    if (remaining.startsWith("--kind ")) {
      const value = /^--kind\s+(\S+)(?:\s+|$)/.exec(remaining);
      if (!value) throw new Error("/refine --kind requires comma-separated kinds");
      const kinds = value[1]!.split(",").filter(Boolean) as HarnessKind[];
      if (kinds.length === 0 || new Set(kinds).size !== kinds.length ||
          kinds.some((kind) => !TERMINAL_REFINEMENT_KINDS.has(kind))) {
        throw new Error("/refine --kind requires memory, prompt_note, skill, or subagent_spec");
      }
      allowedKinds = kinds;
      remaining = remaining.slice(value[0].length).trimStart();
      continue;
    }
    throw new Error("Unknown /refine option; use --wait, --detach, or --kind KIND[,KIND]");
  }
  if (wait && detach) throw new Error("/refine accepts --wait or --detach, not both");
  return {
    wait,
    ...(allowedKinds === undefined ? {} : { allowedKinds }),
    ...(remaining ? { instructions: remaining } : {}),
  };
}

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"]);
const FAMILY_REFRESH_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "TaskCreated", "SubagentAdmitted", "TaskStatusChanged", "SubagentCancellationRequested",
  "TaskTerminalNoticeSent", "TaskTerminalNoticeDelivered", "SessionNamed", "SessionTitleResolved",
  "SessionTitleModeChanged", "SessionStatusChanged",
  "AgentRunRequested",
  "AgentRunCancellationRequested", "AgentRunStatusChanged", "BudgetExceeded",
  "EffectOutcomeRecorded", "EffectReconciliationRecorded",
]);
const REFINEMENT_REFRESH_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "RefinementReviewRequested", "RefinementReviewChildLinked", "RefinementReviewStatusChanged",
  "GovernedRefinementProposed", "GovernedRefinementValidated", "RefinementGovernanceReviewRequested",
  "RefinementGovernanceReviewChildLinked", "RefinementGovernanceReviewDecided",
  "GovernedRefinementApplied", "RefinementProposalTerminalNoticeDelivered",
]);

function refinementHistoryUnavailable(state: TerminalRefinementRefreshState): boolean {
  return state === "unavailable";
}

export class TerminalUI {
  readonly #output: Pick<NodeJS.WriteStream, "write">;
  readonly #input: NodeJS.ReadableStream;
  readonly #interactive: boolean;
  readonly #manageSignals: boolean;
  readonly #interrupts = new TerminalInterruptPolicy();
  readonly #presentationListeners = new Set<TerminalPresentationListener>();
  #presentationTimer: ReturnType<typeof setTimeout> | null = null;
  #sessionId = "";
  #branchId = "";
  #productCatalog = false;
  #liveState: AgentState | null = null;
  #viewState: AgentState | null = null;
  #capabilities: ProtocolCapabilities | null = null;
  #connection: TerminalConnectionState = "connecting";
  #historicalCursor: string | null = null;
  #progress = new Map<string, string>();
  #streamedEffectIds = new Set<string>();
  #streamedCallIds = new Set<string>();
  #visibleProgressEffectIds = new Set<string>();
  #agentProgressRunByEffect = new Map<string, string>();
  #agentWorkingRunIds = new Set<string>();
  #agentWorkingAnnouncementRunIds = new Set<string>();
  #watchController: AbortController | null = null;
  #watchPromise: Promise<void> | null = null;
  #detachController: AbortController | null = null;
  #sigintHandler: (() => void) | null = null;
  #lastDetachDecision: Extract<InterruptDecision, { action: "detach" }> | null = null;
  #detached = false;
  #closing = false;
  #readline: ReadlineInterface | null = null;
  #pendingCredentialProvider: string | null = null;
  #lastDetail: TerminalDetail | null = null;
  #family: TerminalFamilyNavigation = {
    route: { sessionId: "", branchId: "" },
    parent: null,
    children: [],
    ancestry: [],
    root: null,
    refresh: "unavailable",
    generation: 0,
  };
  #workspaceAgents: TerminalWorkspaceAgentsState = {
    open: false,
    returnRoute: { sessionId: "", branchId: "" },
    rows: [],
    selectedKey: null,
    query: "",
    refresh: "unavailable",
    fetchedAt: null,
    generation: 0,
  };
  #familyRefreshPromise: Promise<void> | null = null;
  #familyRefreshQueued = false;
  #familyResolveAncestryQueued = false;
  #familyRefreshTimer: unknown = null;
  #familyBrowserOpen = false;
  #familyGeneration = 0;
  #refinementReviews: RefinementReviewRecord[] = [];
  #refinementRefresh: TerminalRefinementRefreshState = "unavailable";
  #refinementRefreshPromise: Promise<void> | null = null;
  #refinementRefreshQueued = false;
  #refinementGeneration = 0;
  #navigationGeneration = 0;
  #navigationTail: Promise<void> = Promise.resolve();

  constructor(readonly client: TerminalAgentClient, readonly options: TerminalUIOptions = {}) {
    this.#input = options.input ?? stdin;
    this.#output = options.output ?? stdout;
    this.#interactive = options.interactive ?? Boolean((this.#input as { isTTY?: boolean }).isTTY && (this.#output as { isTTY?: boolean }).isTTY);
    this.#manageSignals = options.manageSignals ?? true;
  }

  async run(sessionId: string, branchId: string): Promise<void> {
    await this.attach(sessionId, branchId);
    try {
      if (!this.#interactive) return;
      this.#readline = createInterface({ input: this.#input, output: this.#output as NodeJS.WriteStream });
      while (!this.#detached) {
        let line: string;
        try {
          line = this.#pendingCredentialProvider
            ? await this.#hiddenCredentialQuestion()
            : (await this.#readline.question(this.#prompt(), { signal: this.#detachController?.signal })).trim();
        } catch (error) {
          if (!this.#detachController?.signal.aborted) this.#write(`${renderTerminalError(error, "input")}\n`);
          break;
        }
        if (!line) continue;
        try {
          await this.execute(line);
        } catch (error) {
          this.#renderError(error, "command");
        }
      }
    } finally {
      await this.detach(true, this.#interactive);
    }
  }

  async attach(sessionId: string, branchId: string, announce = true): Promise<void> {
    this.#sessionId = sessionId;
    this.#branchId = branchId;
    this.#detached = false;
    this.#closing = false;
    this.#lastDetachDecision = null;
    this.#detachController = new AbortController();
    const capabilities = await this.client.capabilities();
    this.#capabilities = capabilities;
    this.#productCatalog = capabilities.productCatalog;
    const snapshot = await this.client.snapshot(sessionId, branchId);
    const agentTools = await this.client.agentToolCapability(snapshot.state.model);
    this.#liveState = snapshot.state;
    this.#viewState = snapshot.state;
    this.#navigationGeneration++;
    this.#refinementGeneration++;
    this.#refinementReviews = [];
    this.#refinementRefresh = "refreshing";
    this.#family = {
      route: { sessionId, branchId },
      parent: null,
      children: [],
      ancestry: [resolveSessionTitlePresentation(snapshot.state, "Start new session", true).text],
      root: snapshot.state.parentSessionId === null,
      refresh: "refreshing",
      generation: ++this.#familyGeneration,
    };
    this.#workspaceAgents = {
      open: false,
      returnRoute: { sessionId, branchId },
      rows: [],
      selectedKey: null,
      query: "",
      refresh: this.#productCatalog ? "loading" : "unavailable",
      fetchedAt: null,
      generation: this.#workspaceAgents.generation + 1,
    };
    await Promise.all([
      this.#refreshFamily(true),
      this.#refreshRefinementReviews(),
    ]);
    const recovery = await this.client.recoverySummary(sessionId, branchId);
    let profileGovernance: GovernedRefinementRecord[] = [];
    let profileGovernanceUnavailable = false;
    try {
      profileGovernance = await this.#profileGovernanceRecords();
    } catch {
      profileGovernanceUnavailable = true;
    }
    if (announce) {
      this.#write(`${renderStartupStatus(snapshot.state, capabilities, recovery, agentTools.selected)}\n`);
      if (recovery.unknownEffects.length) this.#write("Unknown effects require inspection with /unknown and evidence-only /reconcile; resume never retries them.\n");
      if (refinementHistoryUnavailable(this.#refinementRefresh)) {
        this.#write("Refinement history is temporarily unavailable; retry with /refine history.\n");
      }
      if (profileGovernanceUnavailable) this.#write("Profile governance notices are temporarily unavailable; profile inspection remains available.\n");
      const pendingGovernance = profileGovernance.filter(record => ![
        "deterministically_rejected", "reviewed_rejected", "review_failed", "review_unknown",
        "apply_conflict", "apply_failed", "applied",
      ].includes(record.status));
      if (pendingGovernance.length) {
        this.#write(`Profile governance: ${pendingGovernance.length} pending. Inspect with /profile proposals.\n`);
      }
      const latestNotice = profileGovernance.find(record => record.noticeDelivered && [
        "deterministically_rejected", "reviewed_rejected", "review_failed", "review_unknown",
        "apply_conflict", "apply_failed", "applied",
      ].includes(record.status));
      if (latestNotice) this.#write(`${renderGovernanceNotice({
        status: latestNotice.status,
        targetKind: "agent_profile",
        reason: latestNotice.terminalReason,
        decision: latestNotice.decision,
      })}\n`);
      this.#write("/help opens the command palette. /quit detaches without cancellation.\n");
    }
    await this.#startWatch();
    if (this.#manageSignals) {
      this.#sigintHandler = (): void => {
        void this.handleInterrupt().catch((error) => {
          if (!this.#detached) {
            try { this.#renderError(error, "interrupt"); } catch {}
          }
        });
      };
      process.on("SIGINT", this.#sigintHandler);
    }
    this.#publish();
  }

  async detach(announce = true, markDetached = true): Promise<void> {
    if (markDetached) {
      this.#requestDetach();
      this.abortPendingOperations();
    }
    this.#watchController?.abort();
    this.#familyBrowserOpen = false;
    this.#workspaceAgents = {
      ...this.#workspaceAgents,
      open: false,
      generation: this.#workspaceAgents.generation + 1,
    };
    this.#clearFamilyRefreshTimer();
    this.#familyGeneration++;
    this.#removeSigintHandler();
    this.#detachController?.abort();
    this.#detachController = null;
    this.#readline?.close();
    this.#readline = null;
    await this.#watchPromise?.catch(() => {});
    this.#connection = "disconnected";
    this.#publish();
    if (announce) this.#write("Detached. Session identity and durable work remain owned by the service.\n");
  }

  get detached(): boolean { return this.#detached; }
  get pendingSecretInput(): boolean { return this.#pendingCredentialProvider !== null; }
  get pendingSecretProvider(): string | null { return this.#pendingCredentialProvider; }

  abortPendingOperations(): void {
    this.#closing = true;
    this.#clearFamilyRefreshTimer();
    this.#familyGeneration++;
    this.client.abortPendingRequests?.("Terminal detached");
  }

  get presentation(): TerminalPresentation {
    if (!this.#viewState || !this.#capabilities) throw new Error("Terminal is not attached");
    return {
      state: this.#viewState,
      workspaceLabel: scrubText(this.options.workspaceLabel ?? "Workspace"),
      capabilities: this.#capabilities,
      historicalCursor: this.#historicalCursor,
      connection: this.#connection,
      provisionalRunIds: [...this.#agentWorkingRunIds],
      family: this.#family,
      workspaceAgents: this.#workspaceAgents,
      refinementReviews: this.#refinementReviews,
      refinementRefresh: this.#refinementRefresh,
    };
  }

  async openFamilyChild(sessionId: string, branchId: string): Promise<void> {
    this.#assertFamilyNavigationAvailable();
    const child = this.#family.children.find(item => item.sessionId === sessionId && item.branchId === branchId);
    if (!child) throw new Error("The selected route is not a direct child of the current agent");
    if (child.activity === "unavailable") throw new Error("The selected child route is unavailable");
    await this.#queueRouteTransition(sessionId, branchId);
  }

  async openFamilyParent(): Promise<void> {
    this.#assertFamilyNavigationAvailable();
    const parent = this.#family.parent;
    if (!parent) throw new Error("The current agent has no retained parent route");
    if (parent.activity === "unavailable") throw new Error("The retained parent route is unavailable");
    await this.#queueRouteTransition(parent.sessionId, parent.branchId);
  }

  setFamilyBrowserOpen(open: boolean): void {
    this.#familyBrowserOpen = open;
    if (open) void this.#refreshFamily();
    this.#scheduleFamilyRefresh();
  }

  async openWorkspaceAgents(): Promise<void> {
    this.#assertWorkspaceAgentsAvailable();
    const returnRoute = { sessionId: this.#sessionId, branchId: this.#branchId };
    const preferredKey = terminalWorkspaceAgentKey(returnRoute);
    this.#workspaceAgents = {
      ...this.#workspaceAgents,
      open: true,
      returnRoute,
      query: "",
      selectedKey: selectTerminalWorkspaceAgentKey(this.#workspaceAgents.rows, "", preferredKey),
    };
    this.#publish();
    await this.refreshWorkspaceAgents();
  }

  closeWorkspaceAgents(): void {
    if (!this.#workspaceAgents.open) return;
    this.#workspaceAgents = {
      ...this.#workspaceAgents,
      open: false,
      query: "",
      generation: this.#workspaceAgents.generation + 1,
    };
    this.#publish();
  }

  setWorkspaceAgentsQuery(query: string): void {
    if (!this.#workspaceAgents.open || query === this.#workspaceAgents.query) return;
    this.#workspaceAgents = {
      ...this.#workspaceAgents,
      query,
      selectedKey: selectTerminalWorkspaceAgentKey(
        this.#workspaceAgents.rows,
        query,
        this.#workspaceAgents.selectedKey,
      ),
    };
    this.#publish();
  }

  selectWorkspaceAgent(selectedKey: string | null): void {
    if (!this.#workspaceAgents.open || selectedKey === this.#workspaceAgents.selectedKey) return;
    const nextKey = selectTerminalWorkspaceAgentKey(
      this.#workspaceAgents.rows,
      this.#workspaceAgents.query,
      selectedKey,
    );
    this.#workspaceAgents = { ...this.#workspaceAgents, selectedKey: nextKey };
    this.#publish();
  }

  async refreshWorkspaceAgents(): Promise<void> {
    this.#assertWorkspaceAgentsAvailable();
    const generation = this.#workspaceAgents.generation + 1;
    this.#workspaceAgents = { ...this.#workspaceAgents, refresh: "loading", generation };
    this.#publish();
    try {
      const rows = await this.client.productSessions();
      if (generation !== this.#workspaceAgents.generation || this.#detached || this.#closing) return;
      const selectedIndex = buildTerminalWorkspaceAgentRows(this.#workspaceAgents.rows)
        .findIndex(row => row.key === this.#workspaceAgents.selectedKey);
      const selectedKey = selectTerminalWorkspaceAgentKey(
        rows,
        this.#workspaceAgents.query,
        this.#workspaceAgents.selectedKey,
        selectedIndex,
      );
      this.#workspaceAgents = {
        ...this.#workspaceAgents,
        rows,
        selectedKey,
        refresh: "current",
        fetchedAt: new Date().toISOString(),
        generation,
      };
    } catch {
      if (generation !== this.#workspaceAgents.generation || this.#detached || this.#closing) return;
      this.#workspaceAgents = {
        ...this.#workspaceAgents,
        refresh: this.#workspaceAgents.rows.length ? "stale" : "unavailable",
        generation,
      };
    }
    this.#publish();
  }

  async openWorkspaceAgent(sessionId: string, branchId: string): Promise<void> {
    this.#assertWorkspaceAgentsAvailable();
    if (!this.#workspaceAgents.open) throw new Error("The workspace Agents view is not open");
    const selected = this.#workspaceAgents.rows.find(row =>
      row.root && row.sessionId === sessionId && row.branchId === branchId);
    if (!selected) throw new Error("The selected root route is no longer available");
    const selectedName = scrubText(selected.sessionName).replace(/\s+/g, " ").trim() || "Selected root";
    if (selected.status === "failed" || selected.status === "archived") {
      throw new Error(`${selectedName} is ${selected.status} and cannot be opened`);
    }
    try {
      await this.#queueRouteTransition(sessionId, branchId);
    } catch {
      throw new Error(`Could not open ${selectedName}. Refresh Agents and try again.`);
    }
    this.#workspaceAgents = {
      ...this.#workspaceAgents,
      open: false,
      returnRoute: { sessionId, branchId },
      query: "",
      selectedKey: terminalWorkspaceAgentKey({ sessionId, branchId }),
      generation: this.#workspaceAgents.generation + 1,
    };
    this.#publish();
    try {
      await this.client.productSelect(sessionId, branchId);
    } catch {
      throw new Error(`${selectedName} is open, but could not be selected for resume. Reopen Agents and try again.`);
    }
    await this.refreshWorkspaceAgents();
  }

  async createWorkspaceAgent(): Promise<void> {
    this.#assertWorkspaceAgentsAvailable();
    if (!this.#workspaceAgents.open) throw new Error("The workspace Agents view is not open");
    await this.#createRootSession();
  }

  subscribePresentation(listener: TerminalPresentationListener): () => void {
    this.#presentationListeners.add(listener);
    if (this.#viewState && this.#capabilities) listener(this.presentation);
    return () => { this.#presentationListeners.delete(listener); };
  }

  /** Public command entry for renderer/command tests and alternate terminal shells. */
  async execute(line: string): Promise<"continue" | "detach"> {
    if (this.#closing) return "detach";
    if (this.#pendingCredentialProvider) {
      if (line === "/cancel") {
        this.#pendingCredentialProvider = null;
        this.#write("Provider login cancelled.\n");
        return "continue";
      }
      const provider = this.#pendingCredentialProvider;
      const secret = line.trim();
      try {
        await this.client.productSetProviderKey(provider, secret);
      } catch (error) {
        throw redactSubmittedSecret(error, secret);
      }
      this.#pendingCredentialProvider = null;
      this.#capabilities = await this.client.capabilities();
      this.#write(`Saved API key for ${provider} in the owner-only local auth file.\n`);
      await this.#showModelDetail();
      this.#publish();
      return "continue";
    }
    if (line === "/quit" || line === "/exit") { this.#requestDetach(); return "detach"; }
    if (line === "/help") { this.#writePalette(); return "continue"; }
    if (line === "/raw") {
      const modelContracts = await this.client.modelContractDiagnostics(this.#sessionId, this.#branchId);
      this.#emitDetail({
        kind: "raw",
        command: "/raw",
        title: `${this.#lastDetail?.title ?? "Branch"} · raw diagnostics`,
        raw: {
          ...(this.#lastDetail ? { inspector: this.#lastDetail.raw } : {}),
          modelContracts,
        },
      });
      return "continue";
    }
    if (line === "/live") { this.#historicalCursor = null; this.#viewState = this.#liveState; this.#write("Returned to live state.\n"); this.#publish(); return "continue"; }
    if (line === "/info" || line === "/status") { await this.#info(); return "continue"; }
    if (line === "/sessions") { this.#detail("/sessions", await this.client.productSessions()); return "continue"; }
    if (line.startsWith("/sessions select ")) { const target=line.slice(17).trim(); const selected=await this.client.productSelect(target); await this.#queueRouteTransition(selected.sessionId, selected.branchId); return "continue"; }
    if (line === "/new" || line.startsWith("/new ")) {
      const requestedName=line.slice(5).trim();
      await this.#createRootSession(requestedName);
      return "continue";
    }
    if (line === "/model" || line.startsWith("/model ")) { await this.#model(line.slice(6).trim()); return "continue"; }
    if (line === "/effort" || line.startsWith("/effort ")) { await this.#effort(line.slice(7).trim()); return "continue"; }
    if (line === "/thinking" || line.startsWith("/thinking ")) { await this.#effort(line.slice(9).trim()); return "continue"; }
    if (line === "/history" || line.startsWith("/history ")) { await this.#history(line.slice(8).trim()); return "continue"; }
    if (line === "/snapshot") { this.#detail("/snapshot", this.#requireState()); return "continue"; }
    if (line === "/budget") { this.#detail("/budget", this.#requireState().budget); return "continue"; }
    if (line === "/cells") { this.#detail("/cells", Object.values(this.#requireState().cells)); return "continue"; }
    if (line.startsWith("/cell ")) { this.#detail("/cell", await this.client.cell(this.#sessionId,this.#branchId,line.slice(6))); return "continue"; }
    if (line === "/agents") { await this.openWorkspaceAgents(); return "continue"; }
    if (line === "/tree") { this.#detail(line, {family:await this.client.agents(this.#sessionId,this.#branchId),tasks:await this.client.tasks(this.#sessionId,this.#branchId),mailbox:await this.client.mailbox(this.#sessionId,this.#branchId,{limit:50})}); return "continue"; }
    if (line === "/mailbox") { this.#detail("/mailbox", await this.client.mailbox(this.#sessionId,this.#branchId,{limit:50}));return "continue"; }
    if (line === "/tasks") { this.#detail("/tasks", await this.client.tasks(this.#sessionId,this.#branchId));return "continue"; }
    if (line.startsWith("/cancel-task ")) { const [taskId,...reason]=line.slice(13).trim().split(/\s+/);if(!taskId)throw new Error("/cancel-task requires TASK_ID [REASON]");this.#detail("/cancel-task", await this.client.cancelTask(this.#sessionId,this.#branchId,taskId,reason.join(" ")||undefined));return "continue"; }
    if (line === "/goals" || line === "/goal") { this.#detail("/goals", await this.client.goals(this.#sessionId,this.#branchId)); return "continue"; }
    if (line.startsWith("/goal ")) { await this.#goal(line.slice(6).trim()); return "continue"; }
    if (line === "/heartbeats" || line === "/heartbeat") { this.#detail("/heartbeats", await this.client.heartbeats(this.#sessionId,this.#branchId)); return "continue"; }
    if (line.startsWith("/heartbeat ")) { await this.#heartbeat(line.slice(11).trim()); return "continue"; }
    if (line === "/schedules" || line === "/schedule") { this.#detail("/schedules", await this.client.schedules(this.#sessionId,this.#branchId)); return "continue"; }
    if (line.startsWith("/schedule ")) { await this.#schedule(line.slice(10).trim()); return "continue"; }
    if (line === "/memory" || line.startsWith("/memory ")) { const q=line.slice(7).trim();this.#detail("/memory", q?await this.client.memorySearch(this.#sessionId,this.#branchId,q):await this.client.memoryList(this.#sessionId,this.#branchId));return "continue"; }
    if (line === "/profile" || line === "/profile show") { this.#detail("/profile", await this.client.agentProfile(this.#sessionId,true));return "continue"; }
    if (line === "/profile history") {
      const [profiles,proposals]=await Promise.all([
        this.client.agentProfiles(this.#sessionId,{includePrompt:true,limit:100}),
        this.#profileGovernanceRecords(),
      ]);
      this.#detail("/profile-history",{...profiles,proposals});return "continue";
    }
    if (line === "/profile proposals" || line === "/profile notices") { this.#detail("/profile-proposals",await this.#profileGovernanceRecords());return "continue"; }
    if (line.startsWith("/profile propose ")) {
      this.#assertLiveProfileMutation();
      const input=parseTerminalProfileProposal(line.slice(17));
      const current=await this.client.agentProfile(this.#sessionId);
      this.#detail("/profile-proposal",await this.client.proposeProfileUpdate(this.#sessionId,this.#branchId,{
        expectedProfileVersionId:current.profileVersionId,
        ...input,
        evidenceEventIds:input.evidenceEventIds??[],
        wait:input.wait??true,
      }));return "continue";
    }
    if (line.startsWith("/profile repropose ")) {
      this.#assertLiveProfileMutation();
      const match=/^(\S+)\s+([\s\S]+)$/.exec(line.slice(19));
      if(!match)throw new Error("/profile repropose requires latest|NUMBER PROPOSAL_JSON");
      const rejected=(await this.#profileGovernanceRecords()).filter(record=>record.status==="deterministically_rejected"||record.status==="reviewed_rejected");
      const previous=match[1]==="latest"?rejected[0]:rejected[Number(match[1])-1];
      if(!previous)throw new Error("Rejected profile proposal selection was not found");
      const input=parseTerminalProfileProposal(match[2]!);
      const current=await this.client.agentProfile(this.#sessionId);
      this.#detail("/profile-proposal",await this.client.proposeProfileUpdate(this.#sessionId,this.#branchId,{
        expectedProfileVersionId:current.profileVersionId,
        ...input,
        evidenceEventIds:input.evidenceEventIds??[],
        revisesProposalId:previous.proposalId,
        wait:input.wait??true,
      }));return "continue";
    }
    if (line.startsWith("/profile rollback ")) {
      this.#assertLiveProfileMutation();
      const match=/^(\d+)\s+([\s\S]+)$/.exec(line.slice(18));
      if(!match)throw new Error("/profile rollback requires REVISION ROLLBACK_JSON");
      const input=parseTerminalProfileRollback(match[2]!);
      const history=await this.client.agentProfiles(this.#sessionId,{limit:100});
      const current=history.items.find(item=>item.active);
      const restore=history.items.find(item=>item.revision===Number(match[1]));
      if(!current||!restore)throw new Error(`Profile revision ${match[1]} was not found`);
      if(restore.active)throw new Error(`Profile revision ${match[1]} is already active`);
      this.#detail("/profile-rollback",await this.client.rollbackRefinement(this.#sessionId,this.#branchId,{
        targetKind:"agent_profile",targetId:this.#sessionId,
        expectedCurrentVersionId:current.profileVersionId,
        restoreVersionId:restore.profileVersionId,
        reason:input.reason,evidenceEventIds:input.evidenceEventIds??[],
      }));return "continue";
    }
    if (line.startsWith("/profile ")) throw new Error("/profile requires show|history|proposals|propose|repropose or rollback");
    if (line === "/skills") { this.#detail("/skills", await this.client.listSkills(this.#sessionId,this.#branchId,true));return "continue"; }
    if (line.startsWith("/skills ")) { const [action,reference,...rest]=line.slice(8).trim().split(/\s+/);if(action==="show"&&reference)this.#detail("/skills", await this.client.getSkill(this.#sessionId,this.#branchId,reference));else if(action==="preview"&&reference){const preview=await this.client.previewSkillImport(this.#sessionId,this.#branchId,reference);this.#detail("/skills-preview", preview);}else if(action==="install"&&reference){const [scope,digest]=rest;if((scope!=="workspace"&&scope!=="profile")||!digest)throw new Error("/skills install requires DIRECTORY workspace|profile CONFIRMATION_DIGEST");const preview=await this.client.previewSkillImport(this.#sessionId,this.#branchId,reference);if(digest!==preview.confirmationDigest)throw new Error(`Confirmation digest must equal ${preview.confirmationDigest}`);this.#detail("/skills", await this.client.installSkill(this.#sessionId,this.#branchId,{directory:reference,scope,confirmationDigest:digest,installedBy:"tui-owner"}));}else if(action==="test"&&reference)this.#detail("/skill-test", await this.client.testSkill(this.#sessionId,this.#branchId,reference));else if(action==="enable"&&reference)this.#detail("/skills", await this.client.enableSkill(this.#sessionId,this.#branchId,reference));else if(action==="disable"&&reference)this.#detail("/skills", await this.client.disableSkill(this.#sessionId,this.#branchId,reference));else if(action==="remove"&&reference)this.#detail("/skills", await this.client.removeSkill(this.#sessionId,this.#branchId,reference));else if(action==="propose"&&reference)this.#detail("/refine", await this.client.proposeSkill(this.#sessionId,this.#branchId,[reference,...rest].join(" ")));else throw new Error("/skills requires show|preview|install|test|enable|disable|remove or propose");return "continue"; }
    if (line.startsWith("/skill-test ")) { const [entryId]=line.slice(12).trim().split(/\s+/);if(!entryId)throw new Error("/skill-test requires NAME_OR_ID");this.#detail("/skill-test", await this.client.testSkill(this.#sessionId,this.#branchId,entryId));return "continue"; }
    if (line.startsWith("/skill ")) { const match=/^(\S+)\s+([\s\S]+)$/.exec(line.slice(7));if(!match)throw new Error("/skill requires ENTRY_ID JSON");this.#detail("/skill", await this.client.invokeSkill(this.#sessionId,this.#branchId,match[1]!,JSON.parse(match[2]!)));return "continue"; }
    if (line === "/refine") { this.#detail("/refine", await this.client.requestRefinement(this.#sessionId,this.#branchId,{wait:false}));return "continue"; }
    if (line === "/refine status" || line === "/refine history") {
      const [learning, reviews] = await Promise.all([
        line === "/refine status"
          ? this.client.learningStatus(this.#sessionId, this.#branchId)
          : this.client.learningHistory(this.#sessionId, this.#branchId),
        this.client.refinementReviews(this.#sessionId, this.#branchId),
      ]);
      this.#refinementReviews = reviews.slice(-24);
      this.#refinementRefresh = "current";
      this.#publish();
      this.#detail(line === "/refine status" ? "/refine-status" : "/refine-history", learning);
      return "continue";
    }
    if (line.startsWith("/refine inspect ")) { const activityId=line.slice(16).trim();if(!activityId)throw new Error("/refine inspect requires ACTIVITY_ID");this.#detail("/refine-activity",await this.client.learningActivity(this.#sessionId,this.#branchId,activityId));return "continue"; }
    if (line === "/refine pause" || line === "/refine resume") { this.#detail("/refine",line.endsWith(" pause")?await this.client.pauseAutomaticLearning():await this.client.resumeAutomaticLearning());return "continue"; }
    if (line === "/refine auto on" || line === "/refine auto off") { this.#detail("/refine", await this.client.setAutomaticRefinement(line.endsWith(" on")));return "continue"; }
    if (line.startsWith("/refine auto")) throw new Error("/refine auto requires on or off");
    if (line.startsWith("/refine rollback ")) { const [proposalId,...reason]=line.slice(17).trim().split(/\s+/);if(!proposalId||!reason.length)throw new Error("/refine rollback requires PROPOSAL_ID REASON");this.#detail("/refine-rollback",await this.client.rollbackGovernedRefinement(this.#sessionId,this.#branchId,proposalId,{reason:reason.join(" "),evidenceEventIds:[]}));return "continue"; }
    if (line.startsWith("/refine correct ")) { const match=/^([^ ]+)\s+--\s+([\s\S]+)$/.exec(line.slice(16));if(!match)throw new Error("/refine correct EVENT_ID[,EVENT_ID] -- CORRECTION");this.#detail("/refine", await this.client.userCorrection(this.#sessionId,this.#branchId,match[2]!,match[1]!.split(",").filter(Boolean)));return "continue"; }
    if (line.startsWith("/refine propose-json ")) { const proposed=await this.client.refine(this.#sessionId,this.#branchId,JSON.parse(line.slice(21)));this.#detail("/refine", await this.client.validateRefinement(this.#sessionId,this.#branchId,proposed.proposalId));return "continue"; }
    if (line.startsWith("/refine ")) { this.#detail("/refine", await this.client.requestRefinement(this.#sessionId,this.#branchId,parseTerminalRefinementRequest(line.slice(8))));return "continue"; }
    if (line.startsWith("/rollback ")) { const [proposalId,...reason]=line.slice(10).trim().split(/\s+/);if(!proposalId||!reason.length)throw new Error("/rollback requires legacy PROPOSAL_ID REASON");this.#detail("/legacy-rollback", await this.client.rollback(this.#sessionId,this.#branchId,proposalId,reason.join(" ")));return "continue"; }
    if (line.startsWith("/branch ")) { const [,cursor,...name]=line.split(/\s+/);if(!cursor)throw new Error("/branch requires CURSOR [NAME]");const fork=await this.client.fork(this.#sessionId,this.#branchId,cursor,name.join(" ")||undefined);if(this.#productCatalog)await this.client.productSelect(this.#sessionId,fork.branchId);await this.#queueRouteTransition(this.#sessionId,fork.branchId);return "continue"; }
    if (line === "/resume" || line.startsWith("/resume ")) { const branch=line.slice(7).trim()||this.#branchId;await this.client.resume(this.#sessionId,branch);if(this.#productCatalog)await this.client.productSelect(this.#sessionId,branch);await this.#queueRouteTransition(this.#sessionId,branch);return "continue"; }
    if (line === "/context") { this.#detail("/context", await this.client.inspectContext(this.#sessionId,this.#branchId));return "continue"; }
    if (line === "/compact" || line.startsWith("/compact ")) {
      const [, strategyName, ...guidance] = line.split(/\s+/);
      const strategy = strategyName === "summary" ? "model-summary-v1" : "deterministic-extractive-v1";
      const instructions = strategyName === "summary" || strategyName === "extractive" ? guidance.join(" ") : [strategyName,...guidance].filter(Boolean).join(" ");
      this.#detail("/compact", await this.client.compact(this.#sessionId,this.#branchId,{strategy,...(instructions ? {instructions}: {})}));return "continue";
    }
    if (line === "/sync") { this.#detail("/sync", await this.client.syncNow());return "continue"; }
    if (line === "/sync-status") { this.#detail("/sync-status", await this.client.syncStatus());return "continue"; }
    if (line === "/conflicts") { this.#detail("/conflicts", await this.client.syncConflicts("unresolved"));return "continue"; }
    if (line.startsWith("/resolve-conflict ")) { const match=/^(\S+)\s+([\s\S]+)$/.exec(line.slice(18));if(!match)throw new Error("/resolve-conflict requires CONFLICT_ID JSON");this.#detail("/resolve-conflict", await this.client.resolveSyncConflict(match[1]!,JSON.parse(match[2]!)));return "continue"; }
    if (line === "/unknown") { this.#detail("/unknown", await this.client.unknownEffects(this.#sessionId,this.#branchId));return "continue"; }
    if (line.startsWith("/unknown ")) { this.#detail("/unknown", await this.client.inspectUnknownEffect(this.#sessionId,this.#branchId,line.slice(9).trim()));return "continue"; }
    if (line.startsWith("/reconcile ")) { await this.#reconcile(line.slice(11));return "continue"; }
    if (line === "/stop") { await this.#stop("User requested /stop");return "continue"; }
    if (line.startsWith("/run ")) { await this.#startTask(line.slice(5));return "continue"; }
    if (line.startsWith("/")) { this.#write("Unknown command. Use /help.\n");return "continue"; }
    await this.#startTask(line);
    return "continue";
  }

  async handleInterrupt(): Promise<InterruptDecision> {
    if (this.#detached) {
      return this.#lastDetachDecision ?? {
        action: "detach",
        warning: "Detaching. Durable work, if any, may outlive this client.",
      };
    }
    const active = this.#activeRun();
    const decision = this.#interrupts.decide(active?.id ?? null);
    if (decision.action === "cancel") {
      try {
        await this.client.cancelRun(this.#sessionId,this.#branchId,decision.runId,"User requested cancellation with Ctrl-C");
        if (!this.#detached) this.#write("Durable cancellation requested. Waiting for leaf-first reconciliation; press Ctrl-C again to detach.\n");
      } catch (error) {
        if (!this.#detached) {
          this.#renderError(error, "interrupt");
          this.#write("Cancellation was not confirmed. Durable/external work may outlive this client; press Ctrl-C again to detach.\n");
        }
      }
    } else if (this.#requestDetach(decision)) {
      this.#write(`${decision.warning}\n`);
    }
    return decision;
  }

  #watchHandlers(sessionId: string, branchId: string, navigationGeneration: number): BranchWatchHandlers {
    const currentRoute = (): boolean =>
      navigationGeneration === this.#navigationGeneration
      && sessionId === this.#sessionId
      && branchId === this.#branchId;
    const applySnapshot = (snapshot: { cursor: string; state: AgentState }): void => {
      if (!currentRoute()) return;
      this.#liveState = snapshot.state;
      if (this.#historicalCursor === null) this.#viewState = snapshot.state;
      this.#publish();
    };
    return {
      onSnapshot: applySnapshot,
      onEvent: async (event) => {
        if (!currentRoute()) return;
        if (!this.#liveState) return;
        if (
          event.schemaVersion !== EVENT_SCHEMA_VERSION ||
          this.#liveState.reducerVersion !== REDUCER_VERSION
        ) {
          // A managed service may still be finishing work admitted by the
          // immediately preceding pre-release protocol revision. The service
          // remains the authoritative reducer; refresh its cursor-pinned
          // snapshot instead of applying an incompatible raw event locally.
          const snapshot = await this.client.snapshot(sessionId, branchId);
          if (!currentRoute()) return;
          if (BigInt(snapshot.cursor) < BigInt(event.cursor)) {
            throw new Error(
              `Protocol snapshot ${snapshot.cursor} did not include event ${event.cursor}`,
            );
          }
          applySnapshot(snapshot);
        } else {
          this.#liveState = reduceAgentState(this.#liveState, event);
        }
        if (event.type === "EffectOutcomeRecorded") {
          const effectId = String((event.payload as { effectId?: string }).effectId ?? "");
          if (this.#streamedEffectIds.has(effectId)) {
            const call = Object.values(this.#liveState.modelCalls).find((item) => item.effectId === effectId);
            if (call) this.#streamedCallIds.add(call.id);
            this.#streamedEffectIds.delete(effectId);
          }
        }
        if (this.#historicalCursor === null) {
          this.#viewState = this.#liveState;
          const payload = event.payload as { callId?: string; modelCallId?: string };
          const streamedCallId = payload.callId ?? payload.modelCallId;
          const suppressStreamDuplicate = Boolean(
            streamedCallId && this.#streamedCallIds.has(streamedCallId) && event.type === "MessageAppended",
          );
          const rendered = renderEvent(event);
          if (suppressStreamDuplicate) this.#write("\n[assistant response committed]\n");
          else if (rendered !== null) this.#write(`${rendered}\n`);
        }
        if (event.type === "ModelCallCompleted") {
          const callId = String((event.payload as { callId?: string }).callId ?? "");
          if (callId) this.#streamedCallIds.delete(callId);
        }
        if (event.type === "AgentRunStatusChanged" &&
          TERMINAL_RUN_STATUSES.has(String((event.payload as { status?: string }).status))) {
          const runId = String((event.payload as { runId?: string }).runId ?? "");
          this.#interrupts.reset();
          this.#agentWorkingRunIds.delete(runId);
          this.#agentWorkingAnnouncementRunIds.delete(runId);
          for (const [effectId, progressRunId] of this.#agentProgressRunByEffect) {
            if (progressRunId === runId) this.#agentProgressRunByEffect.delete(effectId);
          }
        }
        this.#publishDeferred();
        if (FAMILY_REFRESH_EVENT_TYPES.has(event.type)) void this.#refreshFamily();
        if (this.#workspaceAgents.open &&
            ["SessionNamed", "SessionTitleResolved", "SessionTitleModeChanged"].includes(event.type)) {
          void this.refreshWorkspaceAgents();
        }
        if (REFINEMENT_REFRESH_EVENT_TYPES.has(event.type)) void this.#refreshRefinementReviews();
      },
      onProgress: (progress) => {
        if (!currentRoute()) return;
        const text = progress.kind === "model-output-delta" && progress.value && typeof progress.value === "object" && "text" in progress.value
          ? String((progress.value as { text: string }).text)
          : "";
        const runId = this.#agentProgressRunByEffect.get(progress.effectId)
          ?? this.#agentRunIdForEffect(progress.effectId);
        if (runId !== null) {
          let changed = false;
          if (this.#historicalCursor === null) {
            if (!this.#visibleProgressEffectIds.has(progress.effectId)) {
              this.#visibleProgressEffectIds.add(progress.effectId);
              changed = true;
            }
            if (this.#agentProgressRunByEffect.get(progress.effectId) !== runId) {
              this.#agentProgressRunByEffect.set(progress.effectId, runId);
              changed = true;
            }
            if (!this.#agentWorkingRunIds.has(runId)) {
              this.#agentWorkingRunIds.add(runId);
              changed = true;
            }
            if (!this.#agentWorkingAnnouncementRunIds.has(runId)) {
              this.#agentWorkingAnnouncementRunIds.add(runId);
              this.#write("[agent working…]\n");
            }
          }
          if (changed) this.#publishDeferred();
          return;
        }
        if (!text || this.#historicalCursor !== null) return;
        this.#streamedEffectIds.add(progress.effectId);
        this.#visibleProgressEffectIds.add(progress.effectId);
        this.#progress.set(progress.effectId, (this.#progress.get(progress.effectId) ?? "") + text);
        if (this.options.onProvisionalOutput) this.options.onProvisionalOutput(progress.effectId, text);
        else this.#write(text);
        this.#publishDeferred();
      },
      onProgressDiscard: (ids, reason) => {
        if (!currentRoute()) return;
        let discardedVisibleProgress = false;
        const affectedRunIds = new Set<string>();
        for (const id of ids) {
          this.#progress.delete(id);
          if (this.#visibleProgressEffectIds.delete(id) && reason !== "committed") discardedVisibleProgress = true;
          const progressRunId = this.#agentProgressRunByEffect.get(id);
          if (progressRunId) affectedRunIds.add(progressRunId);
          this.#agentProgressRunByEffect.delete(id);
          if (reason !== "committed") this.#streamedEffectIds.delete(id);
        }
        for (const runId of affectedRunIds) {
          if (![...this.#agentProgressRunByEffect.values()].includes(runId)) this.#agentWorkingRunIds.delete(runId);
        }
        this.options.onProvisionalDiscard?.(ids, reason);
        if (discardedVisibleProgress && !this.options.onProvisionalDiscard) this.#write("\n[provisional progress discarded after connection loss]\n");
        this.#publishDeferred();
      },
      onReconnect: () => {
        if (!currentRoute()) return;
        this.#connection = "reconnecting";
        this.#publish();
        void this.#refreshFamily();
        void this.#refreshRefinementReviews();
      },
      onConnectionState: (state) => {
        if (!currentRoute()) return;
        this.#connection = state;
        this.#publish();
        if (state === "connected") {
          void this.#refreshFamily();
          void this.#refreshRefinementReviews();
          this.#scheduleFamilyRefresh();
        } else {
          this.#clearFamilyRefreshTimer();
        }
      },
    };
  }

  async #startWatch(): Promise<void> {
    this.#watchController?.abort();
    await this.#watchPromise?.catch(() => {});
    this.#connection = "connecting";
    this.#publish();
    const controller = new AbortController();
    this.#watchController = controller;
    const sessionId = this.#sessionId;
    const branchId = this.#branchId;
    const navigationGeneration = this.#navigationGeneration;
    this.#watchPromise = this.client.watchBranch(
      sessionId,
      branchId,
      this.#watchHandlers(sessionId, branchId, navigationGeneration),
      { signal: controller.signal },
    );
    void this.#watchPromise.catch((error) => {
      if (!controller.signal.aborted && navigationGeneration === this.#navigationGeneration) {
        this.#connection = "disconnected";
        this.#write(`[protocol watch failed] ${scrubText(error instanceof Error ? error.message : String(error))}\n`);
        this.#publish();
      }
    });
  }

  #assertFamilyNavigationAvailable(): void {
    if (this.#detached || this.#closing) throw new Error("The terminal is detached");
    if (this.#historicalCursor !== null) throw new Error("Return to live before opening another agent");
    if (this.#pendingCredentialProvider !== null) throw new Error("Finish or cancel provider login before opening another agent");
  }

  #assertWorkspaceAgentsAvailable(): void {
    if (this.#detached || this.#closing) throw new Error("The terminal is detached");
    if (this.#historicalCursor !== null) throw new Error("Return to live with /live before opening Agents");
    if (this.#pendingCredentialProvider !== null) throw new Error("Finish or cancel provider login before opening Agents");
    if (!this.#productCatalog) throw new Error("The workspace Agents catalog is unavailable");
  }

  #assertLiveProfileMutation(): void {
    if (this.#historicalCursor !== null) throw new Error("Return to live with /live before changing the agent profile");
  }

  async #profileGovernanceRecords(): Promise<GovernedRefinementRecord[]> {
    return (await this.client.governedRefinements({limit:100}))
      .filter(record=>record.proposal.target.kind==="agent_profile"&&
        record.proposal.target.agentSessionId===this.#sessionId)
      .sort((left,right)=>right.createdAt.localeCompare(left.createdAt)||
        right.proposalId.localeCompare(left.proposalId));
  }

  async #createRootSession(requestedName = ""): Promise<void> {
    const current = this.#liveState;
    let model: ModelConfiguration | undefined = current
      ? { ...current.model, reasoningEffort: "provider-default" }
      : undefined;
    if (model) {
      try {
        const config = await this.client.productConfig(model.model);
        model = {
          ...model,
          reasoningEffort: config.selectedModelEffortPreference ?? "provider-default",
        };
      } catch (error) {
        if (
          !(error instanceof ProtocolClientError)
          || !["NOT_FOUND", "CAPABILITY_UNAVAILABLE"].includes(error.code)
        ) throw error;
      }
    }
    let created;
    try {
      created = await this.client.createSession(
        this.options.workspaceId ?? current?.workspaceId ?? "default",
        model ? { model, ...(requestedName ? { sessionName: requestedName } : {}) } : {},
      );
    } catch (error) {
      if (!model || model.reasoningEffort === "provider-default" || !isReasoningSelectionError(error)) {
        throw error;
      }
      model = { ...model, reasoningEffort: "provider-default" };
      created = await this.client.createSession(
        this.options.workspaceId ?? current?.workspaceId ?? "default",
        { model, ...(requestedName ? { sessionName: requestedName } : {}) },
      );
      this.#write(`Stored reasoning effort is no longer valid for ${model.model}; using provider-default.\n`);
    }
    if (this.#productCatalog) await this.client.productSelect(created.sessionId, created.branchId);
    await this.#queueRouteTransition(created.sessionId, created.branchId);
    if (this.#workspaceAgents.open) {
      this.#workspaceAgents = {
        ...this.#workspaceAgents,
        open: false,
        returnRoute: { sessionId: created.sessionId, branchId: created.branchId },
        query: "",
        selectedKey: terminalWorkspaceAgentKey(created),
        generation: this.#workspaceAgents.generation + 1,
      };
      this.#publish();
    }
  }

  #queueRouteTransition(sessionId: string, branchId: string): Promise<void> {
    const operation = this.#navigationTail.then(() => this.#transitionRoute(sessionId, branchId));
    this.#navigationTail = operation.catch(() => {});
    return operation;
  }

  async #transitionRoute(sessionId: string, branchId: string): Promise<void> {
    if (this.#closing || this.#detached) throw new Error("The terminal is detached");
    const snapshot = await this.client.snapshot(sessionId, branchId);
    if (this.#closing || this.#detached) throw new Error("The terminal detached while opening the route");

    this.#watchController?.abort();
    await this.#watchPromise?.catch(() => {});
    if (this.#closing || this.#detached) throw new Error("The terminal detached while opening the route");

    this.#navigationGeneration++;
    this.#familyGeneration++;
    this.#clearFamilyRefreshTimer();
    this.#sessionId = sessionId;
    this.#branchId = branchId;
    this.#historicalCursor = null;
    this.#pendingCredentialProvider = null;
    this.#lastDetail = null;
    this.options.onDetail?.(null);
    this.#progress.clear();
    this.#streamedEffectIds.clear();
    this.#streamedCallIds.clear();
    this.#visibleProgressEffectIds.clear();
    this.#agentProgressRunByEffect.clear();
    this.#agentWorkingRunIds.clear();
    this.#agentWorkingAnnouncementRunIds.clear();
    this.#refinementGeneration++;
    this.#refinementReviews = [];
    this.#refinementRefresh = "refreshing";
    this.#liveState = snapshot.state;
    this.#viewState = snapshot.state;
    this.#family = {
      route: { sessionId, branchId },
      parent: null,
      children: [],
      ancestry: [resolveSessionTitlePresentation(snapshot.state, "Start new session", true).text],
      root: snapshot.state.parentSessionId === null,
      refresh: "refreshing",
      generation: this.#familyGeneration,
    };
    this.#interrupts.reset();
    await this.#startWatch();
    await Promise.all([
      this.#refreshFamily(true),
      this.#refreshRefinementReviews(),
    ]);
    const sessionName = resolveSessionTitlePresentation(snapshot.state, "Start new session", true).text;
    const branchName = snapshot.state.branch.name ?? "unnamed branch";
    this.#write(`Switched to ${sessionName}/${branchName}.\n`);
    this.#publish();
  }

  async #refreshRefinementReviews(): Promise<void> {
    if (this.#detached || this.#closing || !this.#liveState) return;
    if (this.#refinementRefreshPromise) {
      this.#refinementRefreshQueued = true;
      await this.#refinementRefreshPromise;
      return;
    }
    const operation = this.#drainRefinementRefresh();
    this.#refinementRefreshPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#refinementRefreshPromise === operation) this.#refinementRefreshPromise = null;
    }
  }

  async #drainRefinementRefresh(): Promise<void> {
    do {
      this.#refinementRefreshQueued = false;
      await this.#performRefinementRefresh();
    } while (this.#refinementRefreshQueued && !this.#detached && !this.#closing);
  }

  async #performRefinementRefresh(): Promise<void> {
    const sessionId = this.#sessionId;
    const branchId = this.#branchId;
    const generation = ++this.#refinementGeneration;
    this.#refinementRefresh = "refreshing";
    this.#publishDeferred();
    try {
      const records = await this.client.refinementReviews(sessionId, branchId);
      if (generation !== this.#refinementGeneration ||
          sessionId !== this.#sessionId || branchId !== this.#branchId) return;
      this.#refinementReviews = records.slice(-24);
      this.#refinementRefresh = "current";
    } catch {
      if (generation !== this.#refinementGeneration ||
          sessionId !== this.#sessionId || branchId !== this.#branchId) return;
      this.#refinementRefresh = this.#refinementReviews.length ? "stale" : "unavailable";
    }
    this.#publish();
  }

  async #refreshFamily(resolveAncestry = false): Promise<void> {
    if (this.#detached || this.#closing || !this.#liveState) return;
    if (this.#familyRefreshPromise) {
      this.#familyRefreshQueued = true;
      this.#familyResolveAncestryQueued ||= resolveAncestry;
      await this.#familyRefreshPromise;
      return;
    }
    const operation = this.#drainFamilyRefresh(resolveAncestry);
    this.#familyRefreshPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#familyRefreshPromise === operation) this.#familyRefreshPromise = null;
      this.#scheduleFamilyRefresh();
    }
  }

  async #drainFamilyRefresh(resolveAncestry: boolean): Promise<void> {
    let includeAncestry = resolveAncestry;
    do {
      this.#familyRefreshQueued = false;
      this.#familyResolveAncestryQueued = false;
      await this.#performFamilyRefresh(includeAncestry);
      includeAncestry = this.#familyResolveAncestryQueued;
    } while (this.#familyRefreshQueued && !this.#detached && !this.#closing);
  }

  async #performFamilyRefresh(resolveAncestry: boolean): Promise<void> {
    const sessionId = this.#sessionId;
    const branchId = this.#branchId;
    const state = this.#liveState;
    if (!state) return;
    const generation = ++this.#familyGeneration;
    this.#family = { ...this.#family, refresh: "refreshing", generation };
    this.#publishDeferred();
    try {
      const family = await this.client.agents(sessionId, branchId);
      const parent = family.items.find(item => item.relationship === "parent") ?? null;
      const children = family.items.filter(item => item.relationship === "child");
      const ancestry = resolveAncestry
        ? await this.#resolveAncestry(state, parent)
        : this.#family.ancestry;
      if (generation !== this.#familyGeneration || sessionId !== this.#sessionId || branchId !== this.#branchId) return;
      this.#family = {
        route: { sessionId, branchId },
        parent,
        children,
        ancestry,
        root: parent === null,
        refresh: "current",
        generation,
      };
    } catch {
      if (generation !== this.#familyGeneration || sessionId !== this.#sessionId || branchId !== this.#branchId) return;
      const hadFamilyData = this.#family.parent !== null || this.#family.children.length > 0;
      this.#family = {
        ...this.#family,
        refresh: hadFamilyData ? "stale" : "unavailable",
        generation,
      };
    }
    this.#publish();
  }

  async #resolveAncestry(state: AgentState, directParent: FamilyAgentRecord | null): Promise<string[]> {
    const labels = [resolveSessionTitlePresentation(state, "Start new session", true).text];
    let parentSessionId = state.parentSessionId;
    let parentBranchId = state.parentBranchId;
    const visited = new Set([state.sessionId]);
    for (let depth = 0; depth < 8 && parentSessionId && parentBranchId; depth++) {
      if (visited.has(parentSessionId)) break;
      visited.add(parentSessionId);
      try {
        const snapshot = await this.client.snapshot(parentSessionId, parentBranchId);
        labels.unshift(resolveSessionTitlePresentation(snapshot.state, "Start new session", true).text);
        parentSessionId = snapshot.state.parentSessionId;
        parentBranchId = snapshot.state.parentBranchId;
      } catch {
        labels.unshift(directParent?.name ?? "Unavailable parent");
        break;
      }
    }
    return labels;
  }

  #scheduleFamilyRefresh(): void {
    this.#clearFamilyRefreshTimer();
    if (this.#detached || this.#closing || this.#connection !== "connected") return;
    const activeChild = this.#family.children.some(child => child.activity === "working");
    if (!this.#familyBrowserOpen && !activeChild) return;
    const milliseconds = Math.max(10, this.options.familyRefreshIntervalMs ?? 1_000);
    const callback = (): void => {
      this.#familyRefreshTimer = null;
      void this.#refreshFamily();
    };
    this.#familyRefreshTimer = this.options.familyRefreshScheduler
      ? this.options.familyRefreshScheduler.setTimeout(callback, milliseconds)
      : setTimeout(callback, milliseconds);
    (this.#familyRefreshTimer as { unref?: () => void } | null)?.unref?.();
  }

  #clearFamilyRefreshTimer(): void {
    if (this.#familyRefreshTimer === null) return;
    if (this.options.familyRefreshScheduler) {
      this.options.familyRefreshScheduler.clearTimeout(this.#familyRefreshTimer);
    } else {
      clearTimeout(this.#familyRefreshTimer as ReturnType<typeof setTimeout>);
    }
    this.#familyRefreshTimer = null;
  }

  async #history(cursor:string):Promise<void>{
    const events=await this.client.history(this.#sessionId,this.#branchId);
    if(!cursor){this.#detail("/history", events);return;}
    if(!/^\d+$/.test(cursor))throw new Error("/history CURSOR requires a numeric committed cursor");
    const selected=events.filter((event)=>BigInt(event.cursor)<=BigInt(cursor));if(!selected.length)throw new Error(`No retained history at cursor ${cursor}`);
    this.#viewState=projectEvents(selected);this.#historicalCursor=this.#viewState.cursor;this.#write(`Historical projection at ${this.#historicalCursor}; live events remain observational only. Use /live to return.\n`);this.#detail("/history-snapshot", this.#viewState);this.#publish();
  }

  async #info():Promise<void>{
    const state=this.#requireState();
    const [caps,recovery,agentTools,modelContracts]=await Promise.all([
      this.client.capabilities(),
      this.client.recoverySummary(this.#sessionId,this.#branchId),
      this.client.agentToolCapability(state.model),
      this.client.modelContractDiagnostics(this.#sessionId,this.#branchId),
    ]);
    this.#capabilities=caps;
    this.#detail("/info",{state,capabilities:caps,recovery,agentTools,modelContracts,connection:this.#connection});
    this.#publish();
  }
  async #model(command:string):Promise<void>{
    const providers=await this.client.modelProviders();
    if(!command){
      await this.#showModelDetail(providers);
      return;
    }
    const login=/^login\s+(\S+)$/.exec(command);
    if(login){
      const provider=login[1]!;
      if(!["openai","anthropic","vercel"].includes(provider))throw new Error("/model login supports openai, anthropic, or vercel");
      this.#pendingCredentialProvider=provider;
      this.#write(`Enter API key for ${provider}; input is hidden. Use Escape or /cancel to cancel.\n`);
      return;
    }
    const logout=/^logout\s+(\S+)$/.exec(command);
    if(logout){
      const provider=logout[1]!;
      await this.client.productSetProviderKey(provider,null);
      this.#capabilities=await this.client.capabilities();
      this.#write(`Removed the stored API key for ${provider}. Environment credentials, if set, remain usable.\n`);
      await this.#showModelDetail();
      this.#publish();
      return;
    }
    if(this.#historicalCursor!==null)throw new Error("Return to /live before changing the branch model");
    const model=parseTerminalModel(command.replace(/^set\s+/,""));
    const descriptor=providers.find(provider=>provider.name===model.provider);
    if(!descriptor)throw new Error(`Unknown model provider: ${model.provider}`);
    if(!descriptor.usable)throw new Error(descriptor.remediation??`Use /model login ${model.provider} first`);
    const config=await this.client.productConfig(model.model);
    const configuredModel={...model,reasoningEffort:config.selectedModelEffortPreference??"provider-default"} as ModelConfiguration;
    let selected:{changed?:boolean;model?:ModelConfiguration};
    try {
      selected=await this.client.selectModel(this.#sessionId,this.#branchId,configuredModel) as {changed?:boolean;model?:ModelConfiguration};
    } catch (error) {
      if(config.selectedModelEffortPreference===null||!isReasoningSelectionError(error))throw error;
      selected=await this.client.selectModel(this.#sessionId,this.#branchId,{...configuredModel,reasoningEffort:"provider-default"}) as {changed?:boolean;model?:ModelConfiguration};
      this.#write(`Stored reasoning effort is no longer valid for ${model.model}; using provider-default.\n`);
    }
    const selectedModel=selected.model??configuredModel;
    await this.client.productSetModel(formatTerminalModel(selectedModel));
    this.#write(`${selected.changed===false?"Model already selected":"Selected branch model"}: ${formatTerminalModel(selectedModel)}. Reasoning effort: ${selectedModel.reasoningEffort}. Saved as this workspace's default.\n`);
    await this.#showModelDetail(undefined,selectedModel);
  }
  async #effort(command:string):Promise<void>{
    const state=this.#requireState();
    const refresh=command==="refresh";
    const catalog=await this.client.modelCatalog(refresh);
    if(refresh)command="";
    const descriptor=catalog.descriptors.find(item=>item.model===state.model.model)??null;
    const capability=descriptor?.reasoning??{status:"unverified" as const,levels:["none","minimal","low","medium","high","xhigh"] as const};
    const detail=(current:ModelConfiguration["reasoningEffort"]):TerminalEffortDetail=>({
      kind:"effort",command:"/effort",title:"Reasoning effort",current,model:state.model.model,
      capability:capability.status,
      options:capability.status==="unsupported"?["provider-default"]:["provider-default",...capability.levels],
      stale:descriptor?.stale??true,
      ...(catalog.origin?{catalogOrigin:catalog.origin}:{}),
      ...(catalog.error?{catalogError:catalog.error}:{}),
      raw:{model:state.model,descriptor,catalog},
    });
    if(!command){
      const value=detail(state.model.reasoningEffort);this.#lastDetail=value;this.#emitDetail(value);
      return;
    }
    if(this.#historicalCursor!==null)throw new Error("Return to /live before changing reasoning effort");
    const effort=normalizeReasoningEffort(command);
    const model={...state.model,reasoningEffort:effort};
    const selected=await this.client.selectModel(this.#sessionId,this.#branchId,model) as {changed?:boolean;model?:ModelConfiguration};
    await this.client.productSetReasoningEffort(state.model.model,effort);
    this.#write(`${selected.changed===false?"Reasoning effort already selected":"Selected reasoning effort"}: ${effort}. Saved for ${state.model.model} in this workspace.\n`);
    const value=detail((selected.model??model).reasoningEffort);this.#lastDetail=value;this.#emitDetail(value);
  }
  async #stop(reason:string):Promise<void>{const active=this.#activeRun();if(!active){this.#write("No active run.\n");return;}await this.client.cancelRun(this.#sessionId,this.#branchId,active.id,reason);this.#write("Cancellation requested.\n");}
  async #startTask(text:string):Promise<void>{
    const active=this.#activeRun();
    if(active){this.#write(`A run is ${active.status}; /stop requests cancellation.\n`);return;}
    const result=await this.client.startRun(this.#sessionId,this.#branchId,{task:text,goalMode:"auto"});
    if(result.status==="queued"||result.status==="running")this.#write("Run accepted.\n");
  }
  async #goal(command:string):Promise<void>{if(command.startsWith("create ")){this.#detail("/goal", await this.client.createGoal(this.#sessionId,this.#branchId,command.slice(7)));return;}const current=await this.client.currentGoal(this.#sessionId,this.#branchId);if(!current){this.#write("No current goal.\n");return;}if(command==="pause")this.#detail("/goal", await this.client.pauseGoal(this.#sessionId,this.#branchId,current.goalId));else if(command==="resume")this.#detail("/goal", await this.client.resumeGoal(this.#sessionId,this.#branchId,current.goalId));else if(command==="clear")this.#detail("/goal", await this.client.clearGoal(this.#sessionId,this.#branchId,current.goalId));else if(command==="complete")this.#detail("/goal", await this.client.requestGoalCompletion(this.#sessionId,this.#branchId,current.goalId));else throw new Error("/goal create DESCRIPTION|pause|resume|clear|complete");}
  async #heartbeat(command:string):Promise<void>{const create=/^create\s+(\d+)(?:\s+([\s\S]+))?$/.exec(command);if(create){this.#detail("/heartbeat", await this.client.createHeartbeat(this.#sessionId,this.#branchId,{intervalMs:Number(create[1]),...(create[2]?{prompt:create[2]}:{})}));return;}const change=/^(pause|resume|clear)\s+(\d+)$/.exec(command);if(!change)throw new Error("/heartbeat create MS [PROMPT]|pause N|resume N|clear N");const item=(await this.client.heartbeats(this.#sessionId,this.#branchId))[Number(change[2])-1];if(!item)throw new Error("Heartbeat number not found");this.#detail("/heartbeat", change[1]==="pause"?await this.client.pauseHeartbeat(item.heartbeatId):change[1]==="resume"?await this.client.resumeHeartbeat(item.heartbeatId):await this.client.cancelHeartbeat(item.heartbeatId));}
  async #schedule(command:string):Promise<void>{const once=/^once\s+(\S+)\s+([\s\S]+)$/.exec(command);const every=/^every\s+(\d+)\s+([\s\S]+)$/.exec(command);if(once){this.#detail("/schedule", await this.client.createSchedule(this.#sessionId,this.#branchId,{at:once[1]!,prompt:once[2]!}));return;}if(every){this.#detail("/schedule", await this.client.createSchedule(this.#sessionId,this.#branchId,{intervalMs:Number(every[1]),prompt:every[2]!}));return;}const change=/^(pause|resume|clear)\s+(\d+)$/.exec(command);if(!change)throw new Error("/schedule once ISO PROMPT|every MS PROMPT|pause N|resume N|clear N");const item=(await this.client.schedules(this.#sessionId,this.#branchId))[Number(change[2])-1];if(!item)throw new Error("Schedule number not found");this.#detail("/schedule", change[1]==="pause"?await this.client.pauseSchedule(item.scheduleId):change[1]==="resume"?await this.client.resumeSchedule(item.scheduleId):await this.client.clearSchedule(item.scheduleId));}
  async #reconcile(command:string):Promise<void>{const match=/^(\S+)\s+(succeeded|failed|no_effect|still_unknown)\s+([\s\S]+)$/.exec(command);if(!match)throw new Error("/reconcile EFFECT_ID succeeded|failed|no_effect|still_unknown SUMMARY");this.#detail("/reconcile", await this.client.reconcileUnknownEffect(this.#sessionId,this.#branchId,match[1]!,{assessment:match[2] as "succeeded"|"failed"|"no_effect"|"still_unknown",summary:match[3]!,recordedBy:"terminal-user"}));this.#write("Assessment recorded as evidence. The durable effect remains unknown and was not retried. Start a new /run only if safe.\n");}
  #agentRunIdForEffect(effectId:string):string|null{for(const run of Object.values(this.#liveState?.agentRuns??{})){for(const step of run.steps){if(step.effectId===effectId||step.modelAttempts.some((attempt)=>attempt.effectId===effectId))return run.id;}}return null;}
  #requestDetach(decision?:Extract<InterruptDecision,{action:"detach"}>):boolean{if(this.#detached)return false;this.#detached=true;this.#familyGeneration++;this.#refinementGeneration++;this.#clearFamilyRefreshTimer();if(decision)this.#lastDetachDecision=decision;this.#removeSigintHandler();this.#detachController?.abort();this.#watchController?.abort();return true;}
  #removeSigintHandler():void{if(!this.#sigintHandler)return;process.off("SIGINT",this.#sigintHandler);this.#sigintHandler=null;}
  #activeRun(){return Object.values(this.#liveState?.agentRuns??{}).find((run)=>!TERMINAL_RUN_STATUSES.has(run.status));}
  #requireState():AgentState{if(!this.#viewState)throw new Error("No projected state");return this.#viewState;}
  #prompt():string{return `${(this.#liveState?resolveSessionTitlePresentation(this.#liveState,"Start new session",true).text:"agent").slice(-12)}/${(this.#liveState?.branch.name??"live").slice(-12)}${this.#historicalCursor?`@${this.#historicalCursor}`:""}> `;}
  async #hiddenCredentialQuestion():Promise<string>{
    if(!this.#readline||!this.#pendingCredentialProvider)throw new Error("Credential prompt is unavailable");
    const hidden=this.#readline as ReadlineInterface&{_writeToOutput?:(value:string)=>void;history?:string[]};
    const original=hidden._writeToOutput;
    if(typeof original!=="function")throw new Error("This terminal cannot provide hidden credential input");
    let answer="";
    this.#write(`API key for ${this.#pendingCredentialProvider}: `);
    hidden._writeToOutput=()=>{};
    try{answer=await this.#readline.question("",{signal:this.#detachController?.signal});return answer.trim();}
    finally{
      hidden._writeToOutput=original;
      if(answer&&hidden.history){for(let index=hidden.history.length-1;index>=0;index--){if(hidden.history[index]===answer)hidden.history.splice(index,1);}}
      this.#write("\n");
    }
  }
  #write(value:string):void{if(this.options.onOutput)this.options.onOutput(value);else this.#output.write(value);}
  #publish():void{
    if(this.#presentationTimer!==null){
      clearTimeout(this.#presentationTimer);
      this.#presentationTimer=null;
    }
    this.#emitPresentation();
  }
  #publishDeferred():void{
    if(!this.#viewState||!this.#capabilities||this.#presentationListeners.size===0||this.#presentationTimer!==null)return;
    this.#presentationTimer=setTimeout(()=>{
      this.#presentationTimer=null;
      this.#emitPresentation();
    },0);
    this.#presentationTimer.unref?.();
  }
  #emitPresentation():void{
    if(!this.#viewState||!this.#capabilities)return;
    const presentation=this.presentation;
    for(const listener of this.#presentationListeners)listener(presentation);
  }
  #renderError(error:unknown,context:"command"|"interrupt"):void{this.#write(`${renderTerminalError(error,context)}\n`);}
  #detail(command:string,value:unknown):void{
    const detail=buildTerminalDetail(command,value);
    this.#lastDetail=detail;
    this.#emitDetail(detail);
  }
  #emitDetail(detail:TerminalDetail):void{
    if(this.options.onDetail)this.options.onDetail(detail);
    else if(detail.kind==="raw")this.#write(`${formatTerminalRaw(detail.raw)}\n`);
    else this.#write(`${formatTerminalDetail(detail,{footer:false})}\n`);
  }
  async #showModelDetail(providers?:Awaited<ReturnType<TerminalAgentClient["modelProviders"]>>,current:ModelConfiguration=this.#requireState().model):Promise<void>{
    const available=providers??await this.client.modelProviders();
    const [config,catalog,agentTools]=await Promise.all([
      this.client.productConfig(),
      this.client.modelCatalog().catch((error)=>({
        status:"unavailable" as const,
        descriptors:[],
        error:renderTerminalError(error,"model catalog"),
      })),
      this.client.agentToolCapability(current),
    ]);
    const detail=buildTerminalModelDetail({
      current,
      workspaceDefault:config.defaultModel,
      providers:available,
      catalog,
      ...(agentTools.selected===undefined?{}:{currentAgentTools:agentTools.selected}),
    });
    this.#lastDetail=detail;
    this.#emitDetail(detail);
  }
  #writePalette():void{
    if(this.options.onDetail){
      const detail=buildTerminalDetail("/help",TERMINAL_COMMAND_REGISTRY);
      this.#lastDetail=detail;
      this.#emitDetail(detail);
      return;
    }
    const labels:Record<TerminalCommandCategory,string>={product:"Product",status:"Status",notebook:"Notebook/history",autonomy:"Autonomy",operations:"Operations"};
    const lines=(Object.keys(labels) as TerminalCommandCategory[]).flatMap((category)=>[
      `${labels[category]}:`,
      ...TERMINAL_COMMAND_REGISTRY.filter((item)=>item.category===category).map((item)=>`  ${item.usage} — ${item.summary}`),
    ]);
    lines.push("Ctrl-C first requests durable cancellation of an active run; Ctrl-C again detaches. /quit only detaches.");
    this.#write(lines.join("\n")+"\n");
  }
}

function parseTerminalModel(value:string):ModelConfiguration{
  const separator=value.indexOf(":");
  if(separator<=0||separator===value.length-1)throw new Error("Model must use PROVIDER:MODEL format");
  const provider=value.slice(0,separator);
  const model=value.slice(separator+1);
  if(!/^[a-z][a-z0-9-]*$/.test(provider)||/\s/.test(model))throw new Error("Model must use PROVIDER:MODEL format");
  return{provider,model,reasoningEffort:"provider-default"};
}

function formatTerminalModel(model:ModelConfiguration):string{return`${model.provider}:${model.model}`;}

function isReasoningSelectionError(error: unknown): boolean {
  const message=error instanceof Error?error.message:String(error);
  return /reasoning effort|reasoning control|available levels/i.test(message);
}

function redactSubmittedSecret(error:unknown,secret:string):unknown{
  if(!secret)return error;
  const redact=(value:string):string=>value.split(secret).join("[REDACTED]");
  if(error instanceof ProtocolClientError){
    const prefix=`[${error.code}] `;
    const message=error.message.startsWith(prefix)?error.message.slice(prefix.length):error.message;
    return new ProtocolClientError(error.code,redact(message),error.status,null);
  }
  if(error instanceof Error){
    const safe=new Error(redact(error.message));
    safe.name=error.name;
    return safe;
  }
  return new Error(redact(String(error)));
}

type TerminalProfileProposalInput={
  replacement:{role:string;purpose:string;instructions:string};
  reason:string;
  predictedEffect:string;
  evidenceEventIds?:string[];
  wait?:boolean;
};

function parseTerminalJsonObject(value:string,label:string):Record<string,unknown>{
  let parsed:unknown;
  try{parsed=JSON.parse(value);}
  catch{throw new Error(`${label} must be valid JSON`);}
  if(!parsed||Array.isArray(parsed)||typeof parsed!=="object")throw new Error(`${label} must be a JSON object`);
  return parsed as Record<string,unknown>;
}

function parseTerminalProfileProposal(value:string):TerminalProfileProposalInput{
  const parsed=parseTerminalJsonObject(value,"Profile proposal");
  const replacement=parsed.replacement;
  if(!replacement||Array.isArray(replacement)||typeof replacement!=="object")throw new Error("Profile proposal requires replacement role, purpose, and instructions");
  const fields=replacement as Record<string,unknown>;
  if(![fields.role,fields.purpose,fields.instructions].every(item=>typeof item==="string"&&item.trim()))throw new Error("Profile proposal requires non-empty replacement role, purpose, and instructions");
  if(typeof parsed.reason!=="string"||!parsed.reason.trim()||typeof parsed.predictedEffect!=="string"||!parsed.predictedEffect.trim())throw new Error("Profile proposal requires non-empty reason and predictedEffect");
  if(parsed.evidenceEventIds!==undefined&&(!Array.isArray(parsed.evidenceEventIds)||!parsed.evidenceEventIds.every(item=>typeof item==="string")))throw new Error("Profile proposal evidenceEventIds must be an array of event IDs");
  if(parsed.wait!==undefined&&typeof parsed.wait!=="boolean")throw new Error("Profile proposal wait must be boolean");
  return{
    replacement:{role:fields.role as string,purpose:fields.purpose as string,instructions:fields.instructions as string},
    reason:parsed.reason,predictedEffect:parsed.predictedEffect,
    ...(parsed.evidenceEventIds===undefined?{}:{evidenceEventIds:parsed.evidenceEventIds as string[]}),
    ...(parsed.wait===undefined?{}:{wait:parsed.wait}),
  };
}

function parseTerminalProfileRollback(value:string):{reason:string;evidenceEventIds?:string[]}{
  const parsed=parseTerminalJsonObject(value,"Profile rollback");
  if(typeof parsed.reason!=="string"||!parsed.reason.trim())throw new Error("Profile rollback requires a non-empty reason");
  if(parsed.evidenceEventIds!==undefined&&(!Array.isArray(parsed.evidenceEventIds)||!parsed.evidenceEventIds.every(item=>typeof item==="string")))throw new Error("Profile rollback evidenceEventIds must be an array of event IDs");
  return{reason:parsed.reason,...(parsed.evidenceEventIds===undefined?{}:{evidenceEventIds:parsed.evidenceEventIds as string[]})};
}

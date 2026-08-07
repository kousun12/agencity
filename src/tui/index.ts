import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AgentRuntimeError, projectEvents, reduceAgentState, type AgentEvent, type AgentState } from "../domain/index.ts";
import {
  ProtocolClientError,
  type AgentClient, type BranchWatchHandlers, type ProtocolCapabilities,
} from "../protocol/index.ts";
import type { FamilyAgentRecord, RecoverySummaryView } from "../runtime/index.ts";
import { scrubText } from "../security/index.ts";
import type { ModelConfiguration } from "../domain/index.ts";
import {
  type TerminalConnectionState,
  type TerminalFamilyNavigation,
  type TerminalPresentation,
} from "./view-model.ts";
import {
  buildTerminalDetail,
  buildTerminalModelDetail,
  formatTerminalDetail,
  formatTerminalRaw,
  type TerminalDetail,
} from "./detail-model.ts";

export type TerminalAgentClient = Pick<AgentClient,
  "capabilities" | "snapshot" | "watchBranch" | "history" | "productSessions" | "productSelect" |
  "createSession" | "modelProviders" | "startRun" | "run" | "respondToRun" | "cancelRun" |
  "productConfig" | "productSetModel" | "productSetProviderKey" | "selectModel" |
  "cell" | "fork" | "resume" | "inspectContext" | "compact" | "agents" | "tasks" | "mailbox" | "cancelTask" |
  "goals" | "currentGoal" | "createGoal" | "pauseGoal" | "resumeGoal" | "clearGoal" | "requestGoalCompletion" |
  "heartbeats" | "createHeartbeat" | "pauseHeartbeat" | "resumeHeartbeat" | "cancelHeartbeat" |
  "schedules" | "createSchedule" | "pauseSchedule" | "resumeSchedule" | "clearSchedule" |
  "memoryList" | "memorySearch" | "harnessList" | "listSkills" | "getSkill" | "previewSkillImport" | "installSkill" | "enableSkill" | "disableSkill" | "removeSkill" | "proposeSkill" | "refinements" | "requestRefinement" | "refinementReviews" | "refinementPolicy" | "setAutomaticRefinement" | "userCorrection" | "refine" | "validateRefinement" | "rollback" | "invokeSkill" | "testSkill" |
  "syncStatus" | "syncNow" | "syncConflicts" | "resolveSyncConflict" | "recoverySummary" | "unknownEffects" |
  "inspectUnknownEffect" | "reconcileUnknownEffect"
> & Partial<Pick<AgentClient, "abortPendingRequests" | "serviceStatus">>;

export interface TerminalUIOptions {
  readonly workspaceId?: string;
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
  { name: "/budget", aliases: [], category: "status", usage: "/budget", summary: "Show committed budget usage." },
  { name: "/snapshot", aliases: [], category: "status", usage: "/snapshot", summary: "Show a structured overview of the projected state." },
  { name: "/mailbox", aliases: [], category: "status", usage: "/mailbox", summary: "Show retained family messages and receipts." },
  { name: "/tasks", aliases: [], category: "status", usage: "/tasks", summary: "Show retained child tasks." },
  { name: "/cancel-task", aliases: [], category: "status", usage: "/cancel-task TASK_ID [REASON]", summary: "Request durable child-task cancellation." },
  { name: "/agents", aliases: ["/tree"], category: "status", usage: "/agents", summary: "Show the retained family, tasks, and mailbox." },
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
  { name: "/refine", aliases: [], category: "status", usage: "/refine [INSTRUCTIONS|status|auto on|off|correct IDS -- TEXT|propose-json JSON]", summary: "Run a trajectory review; raw proposal JSON is an advanced diagnostic." },
  { name: "/rollback", aliases: [], category: "status", usage: "/rollback PROPOSAL_ID REASON", summary: "Request governed refinement rollback." },
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
): string {
  const provider = capabilities.providers.find((item) => item.name === state.model.provider);
  const streaming = provider?.capabilities.streaming ? "incremental progress" : "committed responses only";
  const sync = capabilities.sync && typeof capabilities.sync === "object" && "configured" in capabilities.sync
    ? (capabilities.sync as { configured?: boolean }).configured ? "configured" : "local only"
    : "unknown";
  return [
    "Agencity trusted-local TUI (protocol-backed terminal client)",
    `Session: ${state.sessionName ?? "unnamed session"} / ${state.branch.name ?? "unnamed branch"}`,
    `Model: ${state.model.provider}:${state.model.model} (${streaming})`,
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
    case "AgentRunUserInputRequested":
      return payload.kind === "permission"
        ? `[permission needed: ${conciseValue(payload.permission)}] ${conciseValue(payload.question)}`
        : `[input needed] ${conciseValue(payload.question)}`;
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

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"]);
const FAMILY_REFRESH_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "TaskCreated", "SubagentAdmitted", "TaskStatusChanged", "SubagentCancellationRequested",
  "TaskTerminalNoticeSent", "TaskTerminalNoticeDelivered", "SessionNamed", "SessionStatusChanged",
  "AgentRunRequested", "AgentRunUserInputRequested", "AgentRunUserInputReceived",
  "AgentRunCancellationRequested", "AgentRunStatusChanged", "BudgetExceeded",
  "EffectOutcomeRecorded", "EffectReconciliationRecorded",
]);

export class TerminalUI {
  readonly #output: Pick<NodeJS.WriteStream, "write">;
  readonly #input: NodeJS.ReadableStream;
  readonly #interactive: boolean;
  readonly #manageSignals: boolean;
  readonly #interrupts = new TerminalInterruptPolicy();
  readonly #presentationListeners = new Set<TerminalPresentationListener>();
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
    refresh: "unavailable",
    generation: 0,
  };
  #familyRefreshPromise: Promise<void> | null = null;
  #familyRefreshQueued = false;
  #familyResolveAncestryQueued = false;
  #familyRefreshTimer: unknown = null;
  #familyBrowserOpen = false;
  #familyGeneration = 0;
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
    this.#liveState = snapshot.state;
    this.#viewState = snapshot.state;
    this.#navigationGeneration++;
    this.#family = {
      route: { sessionId, branchId },
      parent: null,
      children: [],
      ancestry: [snapshot.state.sessionName ?? "Unnamed session"],
      refresh: "refreshing",
      generation: ++this.#familyGeneration,
    };
    await this.#refreshFamily(true);
    const recovery = await this.client.recoverySummary(sessionId, branchId);
    if (announce) {
      this.#write(`${renderStartupStatus(snapshot.state, capabilities, recovery)}\n`);
      if (recovery.unknownEffects.length) this.#write("Unknown effects require inspection with /unknown and evidence-only /reconcile; resume never retries them.\n");
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
      capabilities: this.#capabilities,
      historicalCursor: this.#historicalCursor,
      connection: this.#connection,
      provisionalRunIds: [...this.#agentWorkingRunIds],
      family: this.#family,
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
      if (!this.#lastDetail) this.#write("No inspector result is available yet.\n");
      else this.#emitDetail({ kind: "raw", command: "/raw", title: `${this.#lastDetail.title} · raw diagnostics`, raw: this.#lastDetail.raw });
      return "continue";
    }
    if (line === "/live") { this.#historicalCursor = null; this.#viewState = this.#liveState; this.#write("Returned to live state.\n"); this.#publish(); return "continue"; }
    if (line === "/info" || line === "/status") { await this.#info(); return "continue"; }
    if (line === "/sessions") { this.#detail("/sessions", await this.client.productSessions()); return "continue"; }
    if (line.startsWith("/sessions select ")) { const target=line.slice(17).trim(); const selected=await this.client.productSelect(target); await this.#queueRouteTransition(selected.sessionId, selected.branchId); return "continue"; }
    if (line === "/new" || line.startsWith("/new ")) {
      const current=this.#liveState; const requestedName=line.slice(5).trim();const created=await this.client.createSession(this.options.workspaceId ?? current?.workspaceId ?? "default", current ? { model: current.model, ...(requestedName ? { sessionName: requestedName } : {}) } : {});
      if(this.#productCatalog)await this.client.productSelect(created.sessionId, created.branchId);
      await this.#queueRouteTransition(created.sessionId, created.branchId); return "continue";
    }
    if (line === "/model" || line.startsWith("/model ")) { await this.#model(line.slice(6).trim()); return "continue"; }
    if (line === "/history" || line.startsWith("/history ")) { await this.#history(line.slice(8).trim()); return "continue"; }
    if (line === "/snapshot") { this.#detail("/snapshot", this.#requireState()); return "continue"; }
    if (line === "/budget") { this.#detail("/budget", this.#requireState().budget); return "continue"; }
    if (line === "/cells") { this.#detail("/cells", Object.values(this.#requireState().cells)); return "continue"; }
    if (line.startsWith("/cell ")) { this.#detail("/cell", await this.client.cell(this.#sessionId,this.#branchId,line.slice(6))); return "continue"; }
    if (line === "/agents" || line === "/tree") { this.#detail(line, {family:await this.client.agents(this.#sessionId,this.#branchId),tasks:await this.client.tasks(this.#sessionId,this.#branchId),mailbox:await this.client.mailbox(this.#sessionId,this.#branchId,{limit:50})}); return "continue"; }
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
    if (line === "/skills") { this.#detail("/skills", await this.client.listSkills(this.#sessionId,this.#branchId,true));return "continue"; }
    if (line.startsWith("/skills ")) { const [action,reference,...rest]=line.slice(8).trim().split(/\s+/);if(action==="show"&&reference)this.#detail("/skills", await this.client.getSkill(this.#sessionId,this.#branchId,reference));else if(action==="preview"&&reference){const preview=await this.client.previewSkillImport(this.#sessionId,this.#branchId,reference);this.#detail("/skills-preview", preview);}else if(action==="install"&&reference){const [scope,digest]=rest;if((scope!=="workspace"&&scope!=="profile")||!digest)throw new Error("/skills install requires DIRECTORY workspace|profile CONFIRMATION_DIGEST");const preview=await this.client.previewSkillImport(this.#sessionId,this.#branchId,reference);if(digest!==preview.confirmationDigest)throw new Error(`Confirmation digest must equal ${preview.confirmationDigest}`);this.#detail("/skills", await this.client.installSkill(this.#sessionId,this.#branchId,{directory:reference,scope,confirmationDigest:digest,installedBy:"tui-owner"}));}else if(action==="test"&&reference)this.#detail("/skill-test", await this.client.testSkill(this.#sessionId,this.#branchId,reference));else if(action==="enable"&&reference)this.#detail("/skills", await this.client.enableSkill(this.#sessionId,this.#branchId,reference));else if(action==="disable"&&reference)this.#detail("/skills", await this.client.disableSkill(this.#sessionId,this.#branchId,reference));else if(action==="remove"&&reference)this.#detail("/skills", await this.client.removeSkill(this.#sessionId,this.#branchId,reference));else if(action==="propose"&&reference)this.#detail("/refine", await this.client.proposeSkill(this.#sessionId,this.#branchId,[reference,...rest].join(" ")));else throw new Error("/skills requires show|preview|install|test|enable|disable|remove or propose");return "continue"; }
    if (line.startsWith("/skill-test ")) { const [entryId]=line.slice(12).trim().split(/\s+/);if(!entryId)throw new Error("/skill-test requires NAME_OR_ID");this.#detail("/skill-test", await this.client.testSkill(this.#sessionId,this.#branchId,entryId));return "continue"; }
    if (line.startsWith("/skill ")) { const match=/^(\S+)\s+([\s\S]+)$/.exec(line.slice(7));if(!match)throw new Error("/skill requires ENTRY_ID JSON");this.#detail("/skill", await this.client.invokeSkill(this.#sessionId,this.#branchId,match[1]!,JSON.parse(match[2]!)));return "continue"; }
    if (line === "/refine") { this.#detail("/refine", await this.client.requestRefinement(this.#sessionId,this.#branchId));return "continue"; }
    if (line === "/refine status" || line === "/refine history") { this.#detail("/refine", { reviews: await this.client.refinementReviews(this.#sessionId,this.#branchId), proposals: (await this.client.refinements()).filter((item)=>item.sessionId===this.#sessionId&&item.branchId===this.#branchId) });return "continue"; }
    if (line === "/refine auto on" || line === "/refine auto off") { this.#detail("/refine", await this.client.setAutomaticRefinement(line.endsWith(" on")));return "continue"; }
    if (line.startsWith("/refine auto")) throw new Error("/refine auto requires on or off");
    if (line.startsWith("/refine correct ")) { const match=/^([^ ]+)\s+--\s+([\s\S]+)$/.exec(line.slice(16));if(!match)throw new Error("/refine correct EVENT_ID[,EVENT_ID] -- CORRECTION");this.#detail("/refine", await this.client.userCorrection(this.#sessionId,this.#branchId,match[2]!,match[1]!.split(",").filter(Boolean)));return "continue"; }
    if (line.startsWith("/refine propose-json ")) { const proposed=await this.client.refine(this.#sessionId,this.#branchId,JSON.parse(line.slice(21)));this.#detail("/refine", await this.client.validateRefinement(this.#sessionId,this.#branchId,proposed.proposalId));return "continue"; }
    if (line.startsWith("/refine ")) { this.#detail("/refine", await this.client.requestRefinement(this.#sessionId,this.#branchId,{instructions:line.slice(8)}));return "continue"; }
    if (line.startsWith("/rollback ")) { const [proposalId,...reason]=line.slice(10).trim().split(/\s+/);if(!proposalId||!reason.length)throw new Error("/rollback requires PROPOSAL_ID REASON");this.#detail("/rollback", await this.client.rollback(this.#sessionId,this.#branchId,proposalId,reason.join(" ")));return "continue"; }
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
    if (line.startsWith("/run ")) { await this.#startOrRespond(line.slice(5));return "continue"; }
    if (line.startsWith("/")) { this.#write("Unknown command. Use /help.\n");return "continue"; }
    await this.#startOrRespond(line);
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
    return {
      onSnapshot: (snapshot) => {
        if (!currentRoute()) return;
        this.#liveState = snapshot.state;
        if (this.#historicalCursor === null) this.#viewState = snapshot.state;
        this.#publish();
      },
      onEvent: (event) => {
        if (!currentRoute()) return;
        if (!this.#liveState) return;
        this.#liveState = reduceAgentState(this.#liveState, event);
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
        if (event.type === "AgentRunStatusChanged" && (
          TERMINAL_RUN_STATUSES.has(String((event.payload as { status?: string }).status))
          || String((event.payload as { status?: string }).status) === "waiting_for_user"
        )) {
          const runId = String((event.payload as { runId?: string }).runId ?? "");
          this.#interrupts.reset();
          this.#agentWorkingRunIds.delete(runId);
          this.#agentWorkingAnnouncementRunIds.delete(runId);
          for (const [effectId, progressRunId] of this.#agentProgressRunByEffect) {
            if (progressRunId === runId) this.#agentProgressRunByEffect.delete(effectId);
          }
        }
        this.#publish();
        if (FAMILY_REFRESH_EVENT_TYPES.has(event.type)) void this.#refreshFamily();
      },
      onProgress: (progress) => {
        if (!currentRoute()) return;
        const text = progress.kind === "model-output-delta" && progress.value && typeof progress.value === "object" && "text" in progress.value
          ? String((progress.value as { text: string }).text)
          : "";
        const runId = this.#agentRunIdForEffect(progress.effectId);
        if (runId !== null) {
          if (this.#historicalCursor === null) {
            this.#visibleProgressEffectIds.add(progress.effectId);
            this.#agentProgressRunByEffect.set(progress.effectId, runId);
            this.#agentWorkingRunIds.add(runId);
            if (!this.#agentWorkingAnnouncementRunIds.has(runId)) {
              this.#agentWorkingAnnouncementRunIds.add(runId);
              this.#write("[agent working…]\n");
            }
          }
          this.#publish();
          return;
        }
        if (!text || this.#historicalCursor !== null) return;
        this.#streamedEffectIds.add(progress.effectId);
        this.#visibleProgressEffectIds.add(progress.effectId);
        this.#progress.set(progress.effectId, (this.#progress.get(progress.effectId) ?? "") + text);
        if (this.options.onProvisionalOutput) this.options.onProvisionalOutput(progress.effectId, text);
        else this.#write(text);
        this.#publish();
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
        this.#publish();
      },
      onReconnect: () => {
        if (!currentRoute()) return;
        this.#connection = "reconnecting";
        this.#publish();
        void this.#refreshFamily();
      },
      onConnectionState: (state) => {
        if (!currentRoute()) return;
        this.#connection = state;
        this.#publish();
        if (state === "connected") {
          void this.#refreshFamily();
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
    this.#liveState = snapshot.state;
    this.#viewState = snapshot.state;
    this.#family = {
      route: { sessionId, branchId },
      parent: null,
      children: [],
      ancestry: [snapshot.state.sessionName ?? "Unnamed session"],
      refresh: "refreshing",
      generation: this.#familyGeneration,
    };
    this.#interrupts.reset();
    await this.#startWatch();
    await this.#refreshFamily(true);
    const sessionName = snapshot.state.sessionName ?? "unnamed session";
    const branchName = snapshot.state.branch.name ?? "unnamed branch";
    this.#write(`Switched to ${sessionName}/${branchName}.\n`);
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
    this.#publish();
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
    const labels = [state.sessionName ?? "Unnamed session"];
    let parentSessionId = state.parentSessionId;
    let parentBranchId = state.parentBranchId;
    const visited = new Set([state.sessionId]);
    for (let depth = 0; depth < 8 && parentSessionId && parentBranchId; depth++) {
      if (visited.has(parentSessionId)) break;
      visited.add(parentSessionId);
      try {
        const snapshot = await this.client.snapshot(parentSessionId, parentBranchId);
        labels.unshift(snapshot.state.sessionName ?? "Unnamed session");
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
    const nonterminalChild = this.#family.children.some(child =>
      child.taskStatus !== null && ["pending", "admitted", "running"].includes(child.taskStatus));
    if (!this.#familyBrowserOpen && !nonterminalChild) return;
    const milliseconds = Math.min(1_000, Math.max(10, this.options.familyRefreshIntervalMs ?? 1_000));
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

  async #info():Promise<void>{const caps=await this.client.capabilities();const recovery=await this.client.recoverySummary(this.#sessionId,this.#branchId);this.#capabilities=caps;this.#detail("/info",{state:this.#requireState(),capabilities:caps,recovery,connection:this.#connection});this.#publish();}
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
    const selected=await this.client.selectModel(this.#sessionId,this.#branchId,model) as {changed?:boolean;model?:ModelConfiguration};
    const selectedModel=selected.model??model;
    await this.client.productSetModel(formatTerminalModel(selectedModel));
    this.#write(`${selected.changed===false?"Model already selected":"Selected branch model"}: ${formatTerminalModel(selectedModel)}. Saved as this workspace's default.\n`);
    await this.#showModelDetail(undefined,selectedModel);
  }
  async #stop(reason:string):Promise<void>{const active=this.#activeRun();if(!active){this.#write("No active run.\n");return;}await this.client.cancelRun(this.#sessionId,this.#branchId,active.id,reason);this.#write("Cancellation requested.\n");}
  async #startOrRespond(text:string):Promise<void>{
    const active=this.#activeRun();
    if(active?.status==="waiting_for_user"){const request=Object.values(active.inputRequests).find((item)=>item.response===undefined);if(!request)throw new Error("Waiting run has no pending request");const approved=request.kind==="permission"?/^(y|yes|approve|approved)$/i.test(text):undefined;const result=await this.client.respondToRun(this.#sessionId,this.#branchId,active.id,request.id,{response:text,...(approved===undefined?{}:{approved})});if(result.status==="queued"||result.status==="running")this.#write("Response accepted.\n");}
    else if(active){this.#write(`A run is ${active.status}; /stop requests cancellation.\n`);return;}
    else {const result=await this.client.startRun(this.#sessionId,this.#branchId,{task:text,goalMode:"auto"});if(result.status==="queued"||result.status==="running")this.#write("Run accepted.\n");}
  }
  async #goal(command:string):Promise<void>{if(command.startsWith("create ")){this.#detail("/goal", await this.client.createGoal(this.#sessionId,this.#branchId,command.slice(7)));return;}const current=await this.client.currentGoal(this.#sessionId,this.#branchId);if(!current){this.#write("No current goal.\n");return;}if(command==="pause")this.#detail("/goal", await this.client.pauseGoal(this.#sessionId,this.#branchId,current.goalId));else if(command==="resume")this.#detail("/goal", await this.client.resumeGoal(this.#sessionId,this.#branchId,current.goalId));else if(command==="clear")this.#detail("/goal", await this.client.clearGoal(this.#sessionId,this.#branchId,current.goalId));else if(command==="complete")this.#detail("/goal", await this.client.requestGoalCompletion(this.#sessionId,this.#branchId,current.goalId));else throw new Error("/goal create DESCRIPTION|pause|resume|clear|complete");}
  async #heartbeat(command:string):Promise<void>{const create=/^create\s+(\d+)(?:\s+([\s\S]+))?$/.exec(command);if(create){this.#detail("/heartbeat", await this.client.createHeartbeat(this.#sessionId,this.#branchId,{intervalMs:Number(create[1]),...(create[2]?{prompt:create[2]}:{})}));return;}const change=/^(pause|resume|clear)\s+(\d+)$/.exec(command);if(!change)throw new Error("/heartbeat create MS [PROMPT]|pause N|resume N|clear N");const item=(await this.client.heartbeats(this.#sessionId,this.#branchId))[Number(change[2])-1];if(!item)throw new Error("Heartbeat number not found");this.#detail("/heartbeat", change[1]==="pause"?await this.client.pauseHeartbeat(item.heartbeatId):change[1]==="resume"?await this.client.resumeHeartbeat(item.heartbeatId):await this.client.cancelHeartbeat(item.heartbeatId));}
  async #schedule(command:string):Promise<void>{const once=/^once\s+(\S+)\s+([\s\S]+)$/.exec(command);const every=/^every\s+(\d+)\s+([\s\S]+)$/.exec(command);if(once){this.#detail("/schedule", await this.client.createSchedule(this.#sessionId,this.#branchId,{at:once[1]!,prompt:once[2]!}));return;}if(every){this.#detail("/schedule", await this.client.createSchedule(this.#sessionId,this.#branchId,{intervalMs:Number(every[1]),prompt:every[2]!}));return;}const change=/^(pause|resume|clear)\s+(\d+)$/.exec(command);if(!change)throw new Error("/schedule once ISO PROMPT|every MS PROMPT|pause N|resume N|clear N");const item=(await this.client.schedules(this.#sessionId,this.#branchId))[Number(change[2])-1];if(!item)throw new Error("Schedule number not found");this.#detail("/schedule", change[1]==="pause"?await this.client.pauseSchedule(item.scheduleId):change[1]==="resume"?await this.client.resumeSchedule(item.scheduleId):await this.client.clearSchedule(item.scheduleId));}
  async #reconcile(command:string):Promise<void>{const match=/^(\S+)\s+(succeeded|failed|no_effect|still_unknown)\s+([\s\S]+)$/.exec(command);if(!match)throw new Error("/reconcile EFFECT_ID succeeded|failed|no_effect|still_unknown SUMMARY");this.#detail("/reconcile", await this.client.reconcileUnknownEffect(this.#sessionId,this.#branchId,match[1]!,{assessment:match[2] as "succeeded"|"failed"|"no_effect"|"still_unknown",summary:match[3]!,recordedBy:"terminal-user"}));this.#write("Assessment recorded as evidence. The durable effect remains unknown and was not retried. Start a new /run only if safe.\n");}
  #agentRunIdForEffect(effectId:string):string|null{for(const run of Object.values(this.#liveState?.agentRuns??{})){for(const step of run.steps){if(step.effectId===effectId||step.modelAttempts.some((attempt)=>attempt.effectId===effectId))return run.id;}}return null;}
  #requestDetach(decision?:Extract<InterruptDecision,{action:"detach"}>):boolean{if(this.#detached)return false;this.#detached=true;this.#familyGeneration++;this.#clearFamilyRefreshTimer();if(decision)this.#lastDetachDecision=decision;this.#removeSigintHandler();this.#detachController?.abort();this.#watchController?.abort();return true;}
  #removeSigintHandler():void{if(!this.#sigintHandler)return;process.off("SIGINT",this.#sigintHandler);this.#sigintHandler=null;}
  #activeRun(){return Object.values(this.#liveState?.agentRuns??{}).find((run)=>!TERMINAL_RUN_STATUSES.has(run.status));}
  #requireState():AgentState{if(!this.#viewState)throw new Error("No projected state");return this.#viewState;}
  #prompt():string{return `${(this.#liveState?.sessionName??"agent").slice(-12)}/${(this.#liveState?.branch.name??"live").slice(-12)}${this.#historicalCursor?`@${this.#historicalCursor}`:""}> `;}
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
    const config=await this.client.productConfig();
    const detail=buildTerminalModelDetail({current,workspaceDefault:config.defaultModel,providers:available});
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
  return{provider,model};
}

function formatTerminalModel(model:ModelConfiguration):string{return`${model.provider}:${model.model}`;}

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

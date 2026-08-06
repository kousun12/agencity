import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AgentRuntimeError, projectEvents, reduceAgentState, type AgentEvent, type AgentState } from "../domain/index.ts";
import {
  ProtocolClientError,
  type AgentClient, type BranchWatchHandlers, type ProtocolCapabilities,
} from "../protocol/index.ts";
import type { RecoverySummaryView } from "../runtime/index.ts";
import { scrubText } from "../security/index.ts";

export type TerminalAgentClient = Pick<AgentClient,
  "capabilities" | "snapshot" | "watchBranch" | "history" | "productSessions" | "productSelect" |
  "createSession" | "modelProviders" | "startRun" | "run" | "respondToRun" | "cancelRun" |
  "cell" | "fork" | "resume" | "compact" | "agents" | "tasks" | "mailbox" | "cancelTask" |
  "goals" | "currentGoal" | "createGoal" | "pauseGoal" | "resumeGoal" | "clearGoal" | "requestGoalCompletion" |
  "heartbeats" | "createHeartbeat" | "pauseHeartbeat" | "resumeHeartbeat" | "cancelHeartbeat" |
  "schedules" | "createSchedule" | "pauseSchedule" | "resumeSchedule" | "clearSchedule" |
  "memoryList" | "memorySearch" | "harnessList" | "listSkills" | "getSkill" | "previewSkillImport" | "installSkill" | "enableSkill" | "disableSkill" | "removeSkill" | "proposeSkill" | "refinements" | "requestRefinement" | "refinementReviews" | "refinementPolicy" | "setAutomaticRefinement" | "userCorrection" | "refine" | "validateRefinement" | "rollback" | "invokeSkill" | "testSkill" |
  "syncStatus" | "syncNow" | "syncConflicts" | "resolveSyncConflict" | "recoverySummary" | "unknownEffects" |
  "inspectUnknownEffect" | "reconcileUnknownEffect"
>;

export interface TerminalUIOptions {
  readonly workspaceId?: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: Pick<NodeJS.WriteStream, "write">;
  readonly interactive?: boolean;
}


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
  { name: "/model", aliases: [], category: "status", usage: "/model", summary: "Show the branch-pinned model and provider capability." },
  { name: "/budget", aliases: [], category: "status", usage: "/budget", summary: "Show committed budget usage." },
  { name: "/snapshot", aliases: [], category: "status", usage: "/snapshot", summary: "Show the projected state currently being viewed." },
  { name: "/mailbox", aliases: [], category: "status", usage: "/mailbox", summary: "Show retained family messages and receipts." },
  { name: "/tasks", aliases: [], category: "status", usage: "/tasks", summary: "Show retained child tasks." },
  { name: "/cancel-task", aliases: [], category: "status", usage: "/cancel-task TASK_ID [REASON]", summary: "Request durable child-task cancellation." },
  { name: "/agents", aliases: ["/tree"], category: "status", usage: "/agents", summary: "Show the retained family, tasks, and mailbox." },
  { name: "/goal", aliases: ["/goals"], category: "autonomy", usage: "/goal [create DESCRIPTION|pause|resume|clear|complete]", summary: "Inspect or manage the current goal." },
  { name: "/heartbeat", aliases: ["/heartbeats"], category: "autonomy", usage: "/heartbeat [create MS [PROMPT]|pause N|resume N|clear N]", summary: "Inspect or manage heartbeats." },
  { name: "/schedule", aliases: ["/schedules"], category: "autonomy", usage: "/schedule [once ISO PROMPT|every MS PROMPT|pause N|resume N|clear N]", summary: "Inspect or manage schedules." },
  { name: "/history", aliases: [], category: "notebook", usage: "/history [CURSOR]", summary: "List history or enter a read-only historical projection." },
  { name: "/live", aliases: [], category: "notebook", usage: "/live", summary: "Return from historical inspection to live committed state." },
  { name: "/cells", aliases: [], category: "notebook", usage: "/cells", summary: "Show retained notebook cells." },
  { name: "/cell", aliases: [], category: "notebook", usage: "/cell TYPESCRIPT", summary: "Execute a diagnostic TypeScript cell." },
  { name: "/branch", aliases: [], category: "notebook", usage: "/branch CURSOR [NAME]", summary: "Fork without replaying effects." },
  { name: "/resume", aliases: [], category: "notebook", usage: "/resume [BRANCH]", summary: "Resume a retained branch." },
  { name: "/compact", aliases: [], category: "notebook", usage: "/compact", summary: "Commit a source-linked context derivation." },
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
    `Session: ${state.sessionName ?? state.sessionId} / ${state.branch.name ?? state.branch.id}`,
    `Model: ${state.model.provider}/${state.model.model} (${streaming})`,
    "Authority: TRUSTED-LOCAL; generated code has the runtime process's OS authority (not sandboxed)",
    `Protocol: snapshot+cursor resume=${capabilities.snapshotCursorResume}; progress is ephemeral; sync=${sync}`,
    `Recovery: ${recovery.pendingEffectIds.length} pending effects, ${recovery.unknownEffects.length} unknown, ${recovery.activeChildTaskIds.length} active children, ${recovery.attentionGoalGateIds.length} failed/unknown/running gates`,
    recovery.cancellationRequestedRunIds.length
      ? `Cancellation reconciliation pending: ${recovery.cancellationRequestedRunIds.join(", ")}`
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

export function renderEvent(event: AgentEvent): string {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "MessageAppended": return `[message:${String(payload.role)}] ${String(payload.content)}`;
    case "CellProposed": return `[cell:${String(payload.cellId)}] proposed`;
    case "CellCommitted": return `[cell:${String(payload.cellId)}] committed ${JSON.stringify(payload.result)}`;
    case "CellFailed": return `[cell:${String(payload.cellId)}] failed ${String(payload.error)}`;
    case "EffectOutcomeRecorded": return `[effect:${String(payload.effectId)}] ${String(payload.outcome)}`;
    case "EffectReconciliationRecorded": return `[unknown:${String(payload.effectId)}] assessment=${String(payload.assessment)} (effect remains unknown)`;
    case "AgentRunStatusChanged": return `[run:${String(payload.runId)}] ${String(payload.status)}${payload.reason ? ` — ${String(payload.reason)}` : ""}`;
    default: return `[${event.type}] cursor=${event.cursor}`;
  }
}

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"]);

export class TerminalUI {
  readonly #output: Pick<NodeJS.WriteStream, "write">;
  readonly #input: NodeJS.ReadableStream;
  readonly #interactive: boolean;
  readonly #interrupts = new TerminalInterruptPolicy();
  #sessionId = "";
  #branchId = "";
  #productCatalog = false;
  #liveState: AgentState | null = null;
  #viewState: AgentState | null = null;
  #historicalCursor: string | null = null;
  #progress = new Map<string, string>();
  #streamedEffectIds = new Set<string>();
  #streamedCallIds = new Set<string>();
  #watchController: AbortController | null = null;
  #watchPromise: Promise<void> | null = null;
  #detached = false;
  #readline: ReadlineInterface | null = null;

  constructor(readonly client: TerminalAgentClient, readonly options: TerminalUIOptions = {}) {
    this.#input = options.input ?? stdin;
    this.#output = options.output ?? stdout;
    this.#interactive = options.interactive ?? Boolean((this.#input as { isTTY?: boolean }).isTTY && (this.#output as { isTTY?: boolean }).isTTY);
  }

  async run(sessionId: string, branchId: string): Promise<void> {
    this.#sessionId = sessionId;
    this.#branchId = branchId;
    const capabilities = await this.client.capabilities();
    this.#productCatalog = capabilities.productCatalog;
    const snapshot = await this.client.snapshot(sessionId, branchId);
    this.#liveState = snapshot.state;
    this.#viewState = snapshot.state;
    const recovery = await this.client.recoverySummary(sessionId, branchId);
    this.#write(`${renderStartupStatus(snapshot.state, capabilities, recovery)}\n`);
    if (recovery.unknownEffects.length) this.#write("Unknown effects require inspection with /unknown and evidence-only /reconcile; resume never retries them.\n");
    this.#write("/help opens the command palette. /quit detaches without cancellation.\n");
    await this.#startWatch();
    const sigint = (): void => {
      void this.handleInterrupt().catch((error) => {
        try { this.#renderError(error, "interrupt"); } catch {}
      });
    };
    process.on("SIGINT", sigint);
    try {
      if (!this.#interactive) return;
      this.#readline = createInterface({ input: this.#input, output: this.#output as NodeJS.WriteStream });
      while (!this.#detached) {
        let line: string;
        try { line = (await this.#readline.question(this.#prompt())).trim(); }
        catch { break; }
        if (!line) continue;
        try {
          await this.execute(line);
        } catch (error) {
          this.#renderError(error, "command");
        }
      }
    } finally {
      process.off("SIGINT", sigint);
      this.#readline?.close();
      this.#readline = null;
      this.#watchController?.abort();
      await this.#watchPromise?.catch(() => {});
      this.#write("Detached. Session identity and durable work remain owned by the service.\n");
    }
  }

  /** Public command entry for renderer/command tests and alternate terminal shells. */
  async execute(line: string): Promise<"continue" | "detach"> {
    if (line === "/quit" || line === "/exit") { this.#detached = true; this.#watchController?.abort(); return "detach"; }
    if (line === "/help") { this.#writePalette(); return "continue"; }
    if (line === "/live") { this.#historicalCursor = null; this.#viewState = this.#liveState; this.#write(`Returned to live cursor ${this.#liveState?.cursor ?? "?"}.\n`); return "continue"; }
    if (line === "/info" || line === "/status") { await this.#info(); return "continue"; }
    if (line === "/sessions") { this.#json(await this.client.productSessions()); return "continue"; }
    if (line.startsWith("/sessions select ")) { const target=line.slice(17).trim(); const selected=await this.client.productSelect(target); await this.#switch(selected.sessionId, selected.branchId); return "continue"; }
    if (line === "/new" || line.startsWith("/new ")) {
      const current=this.#liveState; const requestedName=line.slice(5).trim();const created=await this.client.createSession(this.options.workspaceId ?? current?.workspaceId ?? "default", current ? { model: current.model, ...(requestedName ? { sessionName: requestedName } : {}) } : {});
      if(this.#productCatalog)await this.client.productSelect(created.sessionId, created.branchId);
      await this.#switch(created.sessionId, created.branchId); return "continue";
    }
    if (line === "/model") { const state=this.#requireState(); const descriptor=(await this.client.modelProviders()).find((item)=>item.name===state.model.provider); this.#json({selected:state.model,provider:descriptor??null,resumedBranchesNeverChangeModelSilently:true}); return "continue"; }
    if (line === "/history" || line.startsWith("/history ")) { await this.#history(line.slice(8).trim()); return "continue"; }
    if (line === "/snapshot") { this.#json(this.#requireState()); return "continue"; }
    if (line === "/budget") { this.#json(this.#requireState().budget); return "continue"; }
    if (line === "/cells") { this.#json(Object.values(this.#requireState().cells)); return "continue"; }
    if (line.startsWith("/cell ")) { this.#json(await this.client.cell(this.#sessionId,this.#branchId,line.slice(6))); return "continue"; }
    if (line === "/agents" || line === "/tree") { this.#json({family:await this.client.agents(this.#sessionId,this.#branchId),tasks:await this.client.tasks(this.#sessionId,this.#branchId),mailbox:await this.client.mailbox(this.#sessionId,this.#branchId,{limit:50})}); return "continue"; }
    if (line === "/mailbox") { this.#json(await this.client.mailbox(this.#sessionId,this.#branchId,{limit:50}));return "continue"; }
    if (line === "/tasks") { this.#json(await this.client.tasks(this.#sessionId,this.#branchId));return "continue"; }
    if (line.startsWith("/cancel-task ")) { const [taskId,...reason]=line.slice(13).trim().split(/\s+/);if(!taskId)throw new Error("/cancel-task requires TASK_ID [REASON]");this.#json(await this.client.cancelTask(this.#sessionId,this.#branchId,taskId,reason.join(" ")||undefined));return "continue"; }
    if (line === "/goals" || line === "/goal") { this.#json(await this.client.goals(this.#sessionId,this.#branchId)); return "continue"; }
    if (line.startsWith("/goal ")) { await this.#goal(line.slice(6).trim()); return "continue"; }
    if (line === "/heartbeats" || line === "/heartbeat") { this.#json(await this.client.heartbeats(this.#sessionId,this.#branchId)); return "continue"; }
    if (line.startsWith("/heartbeat ")) { await this.#heartbeat(line.slice(11).trim()); return "continue"; }
    if (line === "/schedules" || line === "/schedule") { this.#json(await this.client.schedules(this.#sessionId,this.#branchId)); return "continue"; }
    if (line.startsWith("/schedule ")) { await this.#schedule(line.slice(10).trim()); return "continue"; }
    if (line === "/memory" || line.startsWith("/memory ")) { const q=line.slice(7).trim();this.#json(q?await this.client.memorySearch(this.#sessionId,this.#branchId,q):await this.client.memoryList(this.#sessionId,this.#branchId));return "continue"; }
    if (line === "/skills") { this.#json(await this.client.listSkills(this.#sessionId,this.#branchId,true));return "continue"; }
    if (line.startsWith("/skills ")) { const [action,reference,...rest]=line.slice(8).trim().split(/\s+/);if(action==="show"&&reference)this.#json(await this.client.getSkill(this.#sessionId,this.#branchId,reference));else if(action==="preview"&&reference){const preview=await this.client.previewSkillImport(this.#sessionId,this.#branchId,reference);this.#write(`${preview.bundle.warning.message}
Confirmation digest: ${preview.confirmationDigest}
`);}else if(action==="install"&&reference){const [scope,digest]=rest;if((scope!=="workspace"&&scope!=="profile")||!digest)throw new Error("/skills install requires DIRECTORY workspace|profile CONFIRMATION_DIGEST");const preview=await this.client.previewSkillImport(this.#sessionId,this.#branchId,reference);this.#write(`${preview.bundle.warning.message}
`);if(digest!==preview.confirmationDigest)throw new Error(`Confirmation digest must equal ${preview.confirmationDigest}`);this.#json(await this.client.installSkill(this.#sessionId,this.#branchId,{directory:reference,scope,confirmationDigest:digest,installedBy:"tui-owner"}));}else if(action==="test"&&reference)this.#json(await this.client.testSkill(this.#sessionId,this.#branchId,reference));else if(action==="enable"&&reference)this.#json(await this.client.enableSkill(this.#sessionId,this.#branchId,reference));else if(action==="disable"&&reference)this.#json(await this.client.disableSkill(this.#sessionId,this.#branchId,reference));else if(action==="remove"&&reference)this.#json(await this.client.removeSkill(this.#sessionId,this.#branchId,reference));else if(action==="propose"&&reference)this.#json(await this.client.proposeSkill(this.#sessionId,this.#branchId,[reference,...rest].join(" ")));else throw new Error("/skills requires show|preview|install|test|enable|disable|remove or propose");return "continue"; }
    if (line.startsWith("/skill-test ")) { const [entryId]=line.slice(12).trim().split(/\s+/);if(!entryId)throw new Error("/skill-test requires NAME_OR_ID");this.#json(await this.client.testSkill(this.#sessionId,this.#branchId,entryId));return "continue"; }
    if (line.startsWith("/skill ")) { const match=/^(\S+)\s+([\s\S]+)$/.exec(line.slice(7));if(!match)throw new Error("/skill requires ENTRY_ID JSON");this.#json(await this.client.invokeSkill(this.#sessionId,this.#branchId,match[1]!,JSON.parse(match[2]!)));return "continue"; }
    if (line === "/refine") { this.#json(await this.client.requestRefinement(this.#sessionId,this.#branchId));return "continue"; }
    if (line === "/refine status" || line === "/refine history") { this.#json({ reviews: await this.client.refinementReviews(this.#sessionId,this.#branchId), proposals: (await this.client.refinements()).filter((item)=>item.sessionId===this.#sessionId&&item.branchId===this.#branchId) });return "continue"; }
    if (line === "/refine auto on" || line === "/refine auto off") { this.#json(await this.client.setAutomaticRefinement(line.endsWith(" on")));return "continue"; }
    if (line.startsWith("/refine auto")) throw new Error("/refine auto requires on or off");
    if (line.startsWith("/refine correct ")) { const match=/^([^ ]+)\s+--\s+([\s\S]+)$/.exec(line.slice(16));if(!match)throw new Error("/refine correct EVENT_ID[,EVENT_ID] -- CORRECTION");this.#json(await this.client.userCorrection(this.#sessionId,this.#branchId,match[2]!,match[1]!.split(",").filter(Boolean)));return "continue"; }
    if (line.startsWith("/refine propose-json ")) { const proposed=await this.client.refine(this.#sessionId,this.#branchId,JSON.parse(line.slice(21)));this.#json(await this.client.validateRefinement(this.#sessionId,this.#branchId,proposed.proposalId));return "continue"; }
    if (line.startsWith("/refine ")) { this.#json(await this.client.requestRefinement(this.#sessionId,this.#branchId,{instructions:line.slice(8)}));return "continue"; }
    if (line.startsWith("/rollback ")) { const [proposalId,...reason]=line.slice(10).trim().split(/\s+/);if(!proposalId||!reason.length)throw new Error("/rollback requires PROPOSAL_ID REASON");this.#json(await this.client.rollback(this.#sessionId,this.#branchId,proposalId,reason.join(" ")));return "continue"; }
    if (line.startsWith("/branch ")) { const [,cursor,...name]=line.split(/\s+/);if(!cursor)throw new Error("/branch requires CURSOR [NAME]");const fork=await this.client.fork(this.#sessionId,this.#branchId,cursor,name.join(" ")||undefined);if(this.#productCatalog)await this.client.productSelect(this.#sessionId,fork.branchId);await this.#switch(this.#sessionId,fork.branchId);return "continue"; }
    if (line === "/resume" || line.startsWith("/resume ")) { const branch=line.slice(7).trim()||this.#branchId;await this.client.resume(this.#sessionId,branch);if(this.#productCatalog)await this.client.productSelect(this.#sessionId,branch);await this.#switch(this.#sessionId,branch);return "continue"; }
    if (line === "/compact") { this.#json(await this.client.compact(this.#sessionId,this.#branchId));return "continue"; }
    if (line === "/sync") { this.#json(await this.client.syncNow());return "continue"; }
    if (line === "/sync-status") { this.#json(await this.client.syncStatus());return "continue"; }
    if (line === "/conflicts") { this.#json(await this.client.syncConflicts("unresolved"));return "continue"; }
    if (line.startsWith("/resolve-conflict ")) { const match=/^(\S+)\s+([\s\S]+)$/.exec(line.slice(18));if(!match)throw new Error("/resolve-conflict requires CONFLICT_ID JSON");this.#json(await this.client.resolveSyncConflict(match[1]!,JSON.parse(match[2]!)));return "continue"; }
    if (line === "/unknown") { this.#json(await this.client.unknownEffects(this.#sessionId,this.#branchId));return "continue"; }
    if (line.startsWith("/unknown ")) { this.#json(await this.client.inspectUnknownEffect(this.#sessionId,this.#branchId,line.slice(9).trim()));return "continue"; }
    if (line.startsWith("/reconcile ")) { await this.#reconcile(line.slice(11));return "continue"; }
    if (line === "/stop") { await this.#stop("User requested /stop");return "continue"; }
    if (line.startsWith("/run ")) { await this.#startOrRespond(line.slice(5));return "continue"; }
    if (line.startsWith("/")) { this.#write("Unknown command. Use /help.\n");return "continue"; }
    await this.#startOrRespond(line);
    return "continue";
  }

  async handleInterrupt(): Promise<InterruptDecision> {
    const active = this.#activeRun();
    const decision = this.#interrupts.decide(active?.id ?? null);
    if (decision.action === "cancel") {
      try {
        await this.client.cancelRun(this.#sessionId,this.#branchId,decision.runId,"User requested cancellation with Ctrl-C");
        this.#write(`Durable cancellation requested for run ${decision.runId}. Waiting for leaf-first reconciliation; press Ctrl-C again to detach.\n`);
      } catch (error) {
        this.#renderError(error, "interrupt");
        this.#write(`Cancellation for run ${decision.runId} was not confirmed. Durable/external work may outlive this client; press Ctrl-C again to detach.\n`);
      }
    } else {
      this.#write(`${decision.warning}\n`);
      this.#detached = true;
      this.#watchController?.abort();
      this.#readline?.close();
    }
    return decision;
  }

  #watchHandlers(): BranchWatchHandlers {
    return {
      onSnapshot: (snapshot) => { this.#liveState=snapshot.state;if(this.#historicalCursor===null)this.#viewState=snapshot.state; },
      onEvent: (event) => {
        if (!this.#liveState) return;
        this.#liveState=reduceAgentState(this.#liveState,event);
        if (event.type === "EffectOutcomeRecorded") {
          const effectId=String((event.payload as {effectId?:string}).effectId??"");
          if(this.#streamedEffectIds.has(effectId)){
            const call=Object.values(this.#liveState.modelCalls).find((item)=>item.effectId===effectId);
            if(call)this.#streamedCallIds.add(call.id);
            this.#streamedEffectIds.delete(effectId);
          }
        }
        if(this.#historicalCursor===null){
          this.#viewState=this.#liveState;
          const payload=event.payload as {callId?:string;modelCallId?:string};
          const streamedCallId=payload.callId??payload.modelCallId;
          const suppressStreamDuplicate=Boolean(streamedCallId&&this.#streamedCallIds.has(streamedCallId)&&(event.type==="ModelOutputChunk"||event.type==="MessageAppended"));
          if(!suppressStreamDuplicate)this.#write(`${renderEvent(event)}\n`);
          else if(event.type==="MessageAppended")this.#write("\n[assistant output committed]\n");
        }
        if(event.type==="ModelCallCompleted"){
          const callId=String((event.payload as {callId?:string}).callId??"");
          if(callId)this.#streamedCallIds.delete(callId);
        }
        if(event.type==="AgentRunStatusChanged"&&TERMINAL_RUN_STATUSES.has(String((event.payload as {status?:string}).status)))this.#interrupts.reset();
      },
      onProgress: (progress) => { const text=progress.kind==="model-output-delta"&&progress.value&&typeof progress.value==="object"&&"text" in progress.value?String((progress.value as {text:string}).text):"";this.#streamedEffectIds.add(progress.effectId);this.#progress.set(progress.effectId,(this.#progress.get(progress.effectId)??"")+text);if(text&&this.#historicalCursor===null)this.#write(text); },
      onProgressDiscard: (ids,reason) => { ids.forEach((id)=>{this.#progress.delete(id);if(reason!=="committed")this.#streamedEffectIds.delete(id);});if(reason!=="committed"&&ids.length)this.#write(`\n[discarded ephemeral progress after ${reason}: ${ids.join(", ")}]\n`); },
      onReconnect: (_attempt,cursor) => { this.#write(`[protocol reconnected after committed cursor ${cursor}; progress was not replayed]\n`); },
    };
  }

  async #startWatch(): Promise<void> {
    this.#watchController?.abort();
    await this.#watchPromise?.catch(()=>{});
    this.#watchController=new AbortController();
    this.#watchPromise=this.client.watchBranch(this.#sessionId,this.#branchId,this.#watchHandlers(),{signal:this.#watchController.signal});
    void this.#watchPromise.catch((error)=>{if(!this.#watchController?.signal.aborted)this.#write(`[protocol watch failed: ${error instanceof Error?error.message:String(error)}]\n`);});
  }

  async #switch(sessionId:string,branchId:string):Promise<void>{
    this.#watchController?.abort();await this.#watchPromise?.catch(()=>{});this.#sessionId=sessionId;this.#branchId=branchId;this.#historicalCursor=null;this.#progress.clear();this.#streamedEffectIds.clear();this.#streamedCallIds.clear();const snapshot=await this.client.snapshot(sessionId,branchId);this.#liveState=snapshot.state;this.#viewState=snapshot.state;this.#interrupts.reset();await this.#startWatch();this.#write(`Switched to ${snapshot.state.sessionName??sessionId}/${snapshot.state.branch.name??branchId} at ${snapshot.cursor}.\n`);
  }

  async #history(cursor:string):Promise<void>{
    const events=await this.client.history(this.#sessionId,this.#branchId);
    if(!cursor){events.forEach((event)=>this.#write(`${event.cursor} ${event.type} ${JSON.stringify(event.payload)}\n`));return;}
    if(!/^\d+$/.test(cursor))throw new Error("/history CURSOR requires a numeric committed cursor");
    const selected=events.filter((event)=>BigInt(event.cursor)<=BigInt(cursor));if(!selected.length)throw new Error(`No retained history at cursor ${cursor}`);
    this.#viewState=projectEvents(selected);this.#historicalCursor=this.#viewState.cursor;this.#write(`Historical projection at ${this.#historicalCursor}; live events remain observational only. Use /live to return.\n`);this.#json(this.#viewState);
  }

  async #info():Promise<void>{const caps=await this.client.capabilities();const recovery=await this.client.recoverySummary(this.#sessionId,this.#branchId);this.#write(`${renderStartupStatus(this.#requireState(),caps,recovery)}\n`);}
  async #stop(reason:string):Promise<void>{const active=this.#activeRun();if(!active){this.#write("No active run.\n");return;}this.#json(await this.client.cancelRun(this.#sessionId,this.#branchId,active.id,reason));}
  async #startOrRespond(text:string):Promise<void>{
    const active=this.#activeRun();let result;
    if(active?.status==="waiting_for_user"){const request=Object.values(active.inputRequests).find((item)=>item.response===undefined);if(!request)throw new Error("Waiting run has no pending request");const approved=request.kind==="permission"?/^(y|yes|approve|approved)$/i.test(text):undefined;result=await this.client.respondToRun(this.#sessionId,this.#branchId,active.id,request.id,{response:text,...(approved===undefined?{}:{approved})});}
    else if(active){this.#write(`Run ${active.id} is ${active.status}; /stop requests cancellation.\n`);return;}
    else result=await this.client.startRun(this.#sessionId,this.#branchId,{task:text,goalMode:"auto"});
    this.#json(result);
  }
  async #goal(command:string):Promise<void>{if(command.startsWith("create ")){this.#json(await this.client.createGoal(this.#sessionId,this.#branchId,command.slice(7)));return;}const current=await this.client.currentGoal(this.#sessionId,this.#branchId);if(!current){this.#write("No current goal.\n");return;}if(command==="pause")this.#json(await this.client.pauseGoal(this.#sessionId,this.#branchId,current.goalId));else if(command==="resume")this.#json(await this.client.resumeGoal(this.#sessionId,this.#branchId,current.goalId));else if(command==="clear")this.#json(await this.client.clearGoal(this.#sessionId,this.#branchId,current.goalId));else if(command==="complete")this.#json(await this.client.requestGoalCompletion(this.#sessionId,this.#branchId,current.goalId));else throw new Error("/goal create DESCRIPTION|pause|resume|clear|complete");}
  async #heartbeat(command:string):Promise<void>{const create=/^create\s+(\d+)(?:\s+([\s\S]+))?$/.exec(command);if(create){this.#json(await this.client.createHeartbeat(this.#sessionId,this.#branchId,{intervalMs:Number(create[1]),...(create[2]?{prompt:create[2]}:{})}));return;}const change=/^(pause|resume|clear)\s+(\d+)$/.exec(command);if(!change)throw new Error("/heartbeat create MS [PROMPT]|pause N|resume N|clear N");const item=(await this.client.heartbeats(this.#sessionId,this.#branchId))[Number(change[2])-1];if(!item)throw new Error("Heartbeat number not found");this.#json(change[1]==="pause"?await this.client.pauseHeartbeat(item.heartbeatId):change[1]==="resume"?await this.client.resumeHeartbeat(item.heartbeatId):await this.client.cancelHeartbeat(item.heartbeatId));}
  async #schedule(command:string):Promise<void>{const once=/^once\s+(\S+)\s+([\s\S]+)$/.exec(command);const every=/^every\s+(\d+)\s+([\s\S]+)$/.exec(command);if(once){this.#json(await this.client.createSchedule(this.#sessionId,this.#branchId,{at:once[1]!,prompt:once[2]!}));return;}if(every){this.#json(await this.client.createSchedule(this.#sessionId,this.#branchId,{intervalMs:Number(every[1]),prompt:every[2]!}));return;}const change=/^(pause|resume|clear)\s+(\d+)$/.exec(command);if(!change)throw new Error("/schedule once ISO PROMPT|every MS PROMPT|pause N|resume N|clear N");const item=(await this.client.schedules(this.#sessionId,this.#branchId))[Number(change[2])-1];if(!item)throw new Error("Schedule number not found");this.#json(change[1]==="pause"?await this.client.pauseSchedule(item.scheduleId):change[1]==="resume"?await this.client.resumeSchedule(item.scheduleId):await this.client.clearSchedule(item.scheduleId));}
  async #reconcile(command:string):Promise<void>{const match=/^(\S+)\s+(succeeded|failed|no_effect|still_unknown)\s+([\s\S]+)$/.exec(command);if(!match)throw new Error("/reconcile EFFECT_ID succeeded|failed|no_effect|still_unknown SUMMARY");this.#json(await this.client.reconcileUnknownEffect(this.#sessionId,this.#branchId,match[1]!,{assessment:match[2] as "succeeded"|"failed"|"no_effect"|"still_unknown",summary:match[3]!,recordedBy:"terminal-user"}));this.#write("Assessment recorded as evidence. The durable effect remains unknown and was not retried. Start a new /run only if safe.\n");}
  #activeRun(){return Object.values(this.#liveState?.agentRuns??{}).find((run)=>!TERMINAL_RUN_STATUSES.has(run.status));}
  #requireState():AgentState{if(!this.#viewState)throw new Error("No projected state");return this.#viewState;}
  #prompt():string{return `${(this.#liveState?.sessionName??this.#sessionId).slice(-12)}/${(this.#liveState?.branch.name??this.#branchId).slice(-12)}${this.#historicalCursor?`@${this.#historicalCursor}`:""}> `;}
  #write(value:string):void{this.#output.write(value);}
  #renderError(error:unknown,context:"command"|"interrupt"):void{this.#write(`${renderTerminalError(error,context)}\n`);}
  #json(value:unknown):void{this.#write(`${JSON.stringify(value,null,2)}\n`);}
  #writePalette():void{
    const labels:Record<TerminalCommandCategory,string>={product:"Product",status:"Status",notebook:"Notebook/history",autonomy:"Autonomy",operations:"Operations"};
    const lines=(Object.keys(labels) as TerminalCommandCategory[]).flatMap((category)=>[
      `${labels[category]}:`,
      ...TERMINAL_COMMAND_REGISTRY.filter((item)=>item.category===category).map((item)=>`  ${item.usage} — ${item.summary}`),
    ]);
    lines.push("Ctrl-C first requests durable cancellation of an active run; Ctrl-C again detaches. /quit only detaches.");
    this.#write(lines.join("\n")+"\n");
  }
}

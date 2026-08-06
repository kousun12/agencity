import type { AgentEvent, EventPayloads, TaskStatus } from "./events.ts";
import type {
  AgentRunInputRequestState, AgentRunState, AgentRunStepState, AgentState, CellState, DocumentChunkState, EffectState, GoalGateState,
  MailboxMessageState, ModelCallState, RecursiveModelState, TaskState, TerminalNoticeState,
} from "./state.ts";
import { InvalidTransitionError, ValidationError } from "./errors.ts";

function withBase(state: AgentState, event: AgentEvent): AgentState {
  return { ...state, cursor: event.cursor, appliedEventIds: [...state.appliedEventIds, event.id] };
}
function taskCanTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return false;
  if (["completed", "failed", "cancelled"].includes(from)) return false;
  if (from === "pending") return to === "admitted" || to === "cancelled";
  return ["running", "completed", "failed", "cancelled"].includes(to);
}

export function reduceAgentState(state: AgentState | undefined, event: AgentEvent): AgentState {
  if (state?.appliedEventIds.includes(event.id)) return state;
  if (!state) {
    if (event.type !== "SessionCreated") throw new ValidationError("First projected event must be SessionCreated");
    const p = event.payload as EventPayloads["SessionCreated"];
    const parentSessionId = p.parentSessionId ?? null;
    const parentBranchId = p.parentBranchId ?? null;
    if ((parentSessionId === null) !== (parentBranchId === null)) throw new ValidationError("Session ancestry requires both parent IDs");
    return {
      reducerVersion: 3, sessionId: event.sessionId, workspaceId: p.workspaceId, sessionName: p.sessionName ?? null,
      parentSessionId, parentBranchId, rootSessionId: p.rootSessionId ?? event.sessionId,
      depth: p.depth ?? 0, taskId: p.taskId ?? null,
      branch: { id: p.initialBranchId, parentBranchId: null, forkCursor: null, name: p.initialBranchName ?? null }, model: p.model,
      status: "idle", cursor: event.cursor, appliedEventIds: [event.id], messages: [], cells: {}, workingValues: {}, artifacts: {}, effects: {}, contexts: {}, modelCalls: {},
      budget: { limits: p.budget, tokens: 0, costUsd: 0, turns: 0, wallTimeMs: 0, exceeded: false },
      tasks: {}, mailbox: {}, terminalNotices: {}, documents: {}, inputSets: {}, goals: {}, heartbeats: {}, recursiveModels: {}, agentRuns: {},
    };
  }
  if (state.sessionId !== event.sessionId) throw new ValidationError("Cannot reduce an event from another session");
  const next = withBase(state, event);
  switch (event.type) {
    case "SessionCreated": return state;
    case "BranchCreated": { const p = event.payload as EventPayloads["BranchCreated"]; return { ...next, branch: { id: p.branchId, parentBranchId: p.parentBranchId, forkCursor: p.forkCursor, name: p.name ?? null } }; }
    case "SessionNamed": return { ...next, sessionName: (event.payload as EventPayloads["SessionNamed"]).name };
    case "BranchNamed": return { ...next, branch: { ...state.branch, name: (event.payload as EventPayloads["BranchNamed"]).name } };
    case "SessionStatusChanged": return { ...next, status: (event.payload as EventPayloads["SessionStatusChanged"]).status };
    case "MessageAppended": { const p = event.payload as EventPayloads["MessageAppended"]; return { ...next, messages: [...state.messages, { id: p.messageId, role: p.role, content: p.content, eventId: event.id, modelCallId: p.modelCallId ?? null }] }; }
    case "CellProposed": { const p = event.payload as EventPayloads["CellProposed"]; if (state.cells[p.cellId]) throw new InvalidTransitionError("cell", state.cells[p.cellId]!.status, "proposed"); const cell: CellState = { id: p.cellId, code: p.code, status: "proposed", attempts: 0, logs: [], eventId: event.id }; return { ...next, cells: { ...state.cells, [p.cellId]: cell } }; }
    case "CellStarted": { const p = event.payload as EventPayloads["CellStarted"]; const old = state.cells[p.cellId]; if (!old || !["proposed", "running"].includes(old.status) || p.attempt !== old.attempts + 1) throw new InvalidTransitionError("cell", old?.status ?? "missing", "running"); return { ...next, cells: { ...state.cells, [p.cellId]: { ...old, status: "running", attempts: p.attempt, eventId: event.id } } }; }
    case "CellCommitted": { const p = event.payload as EventPayloads["CellCommitted"]; const old = state.cells[p.cellId]; if (!old || old.status !== "running") throw new InvalidTransitionError("cell", old?.status ?? "missing", "committed"); return { ...next, cells: { ...state.cells, [p.cellId]: { ...old, status: "committed", result: p.result, logs: p.logs, eventId: event.id } } }; }
    case "CellFailed": { const p = event.payload as EventPayloads["CellFailed"]; const old = state.cells[p.cellId]; if (!old || old.status !== "running") throw new InvalidTransitionError("cell", old?.status ?? "missing", "failed"); return { ...next, cells: { ...state.cells, [p.cellId]: { ...old, status: "failed", error: p.error, logs: p.logs, eventId: event.id } } }; }
    case "CellAbandoned": { const p = event.payload as EventPayloads["CellAbandoned"]; const old = state.cells[p.cellId]; if (!old || !["proposed", "running"].includes(old.status)) throw new InvalidTransitionError("cell", old?.status ?? "missing", "abandoned"); return { ...next, cells: { ...state.cells, [p.cellId]: { ...old, status: "abandoned", error: p.reason, eventId: event.id } } }; }
    case "WorkingValueSet": { const p = event.payload as EventPayloads["WorkingValueSet"]; const old = state.workingValues[p.name]; if (old && p.version <= old.version) throw new ValidationError(`Working value version must increase for ${p.name}`); return { ...next, workingValues: { ...state.workingValues, [p.name]: { name: p.name, version: p.version, value: p.value, eventId: event.id } } }; }
    case "ArtifactRegistered": { const p = event.payload as EventPayloads["ArtifactRegistered"]; return { ...next, artifacts: { ...state.artifacts, [p.artifactId]: { artifactId: p.artifactId, digest: p.digest, mediaType: p.mediaType, size: p.size } } }; }
    case "EffectRequested": { const p = event.payload as EventPayloads["EffectRequested"]; if (state.effects[p.effectId]) throw new InvalidTransitionError("effect", state.effects[p.effectId]!.status, "requested"); const effect: EffectState = { id: p.effectId, executor: p.executor, operation: p.operation, input: p.input, idempotencyKey: p.idempotencyKey, idempotent: p.idempotent, attempts: 0, status: "requested", eventId: event.id }; return { ...next, effects: { ...state.effects, [p.effectId]: effect } }; }
    case "EffectAttemptStarted": { const p = event.payload as EventPayloads["EffectAttemptStarted"]; const old = state.effects[p.effectId]; if (!old || !["requested", "started"].includes(old.status) || p.attempt !== old.attempts + 1) throw new InvalidTransitionError("effect", old?.status ?? "missing", "started"); return { ...next, effects: { ...state.effects, [p.effectId]: { ...old, status: "started", attempts: p.attempt, eventId: event.id } } }; }
    case "EffectOutcomeRecorded": { const p = event.payload as EventPayloads["EffectOutcomeRecorded"]; const old = state.effects[p.effectId]; if (!old || !["requested", "started"].includes(old.status) || p.attempt < Math.max(1, old.attempts)) throw new InvalidTransitionError("effect", old?.status ?? "missing", p.outcome); const updated: EffectState = { ...old, status: p.outcome, attempts: Math.max(old.attempts, p.attempt), eventId: event.id, ...(p.output === undefined ? {} : { output: p.output }), ...(p.error === undefined ? {} : { error: p.error }) }; return { ...next, effects: { ...state.effects, [p.effectId]: updated } }; }
    case "ContextMaterialized": { const p = event.payload as EventPayloads["ContextMaterialized"]; if (state.contexts[p.contextId]) throw new InvalidTransitionError("context", "materialized", "materialized"); return { ...next, contexts: { ...state.contexts, [p.contextId]: { id: p.contextId, records: p.records, contentHash: p.contentHash, eventId: event.id } } }; }
    case "ModelCallRequested": { const p = event.payload as EventPayloads["ModelCallRequested"]; if (!state.contexts[p.contextId] || state.modelCalls[p.callId]) throw new InvalidTransitionError("modelCall", state.modelCalls[p.callId]?.status ?? "missing-context", "requested"); const call: ModelCallState = { id: p.callId, contextId: p.contextId, effectId: p.effectId, provider: p.provider, model: p.model, chunks: [], status: "requested", eventId: event.id }; return { ...next, modelCalls: { ...state.modelCalls, [p.callId]: call } }; }
    case "ModelOutputChunk": { const p = event.payload as EventPayloads["ModelOutputChunk"]; const old = state.modelCalls[p.callId]; if (!old || old.status !== "requested" || p.sequence !== old.chunks.length) throw new InvalidTransitionError("modelCall", old?.status ?? "missing", "streaming"); return { ...next, modelCalls: { ...state.modelCalls, [p.callId]: { ...old, chunks: [...old.chunks, p.text], eventId: event.id } } }; }
    case "ModelCallCompleted": { const p = event.payload as EventPayloads["ModelCallCompleted"]; const old = state.modelCalls[p.callId]; if (!old || old.status !== "requested") throw new InvalidTransitionError("modelCall", old?.status ?? "missing", "succeeded"); return { ...next, modelCalls: { ...state.modelCalls, [p.callId]: { ...old, status: "succeeded", responseMessageId: p.responseMessageId, finishReason: p.finishReason, usage: p.usage, eventId: event.id } } }; }
    case "ModelCallTerminated": { const p = event.payload as EventPayloads["ModelCallTerminated"]; const old = state.modelCalls[p.callId]; if (!old || old.status !== "requested") throw new InvalidTransitionError("modelCall", old?.status ?? "missing", p.outcome); return { ...next, modelCalls: { ...state.modelCalls, [p.callId]: { ...old, status: p.outcome, ...(p.error === undefined ? {} : { error: p.error }), eventId: event.id } } }; }
    case "BudgetDebited": { const p = event.payload as EventPayloads["BudgetDebited"]; return { ...next, budget: { ...state.budget, tokens: state.budget.tokens + p.tokens, costUsd: state.budget.costUsd + p.costUsd, turns: state.budget.turns + p.turns, wallTimeMs: state.budget.wallTimeMs + p.wallTimeMs } }; }
    case "BudgetExceeded": return { ...next, budget: { ...state.budget, exceeded: true }, status: "idle" };
    case "RecoveryPerformed": return next;
    case "SyncConflictResolved": return next;
    case "TaskCreated": {
      const p = event.payload as EventPayloads["TaskCreated"];
      if (state.tasks[p.taskId]) throw new InvalidTransitionError("task", state.tasks[p.taskId]!.status, "pending");
      if (p.parentSessionId !== state.sessionId || p.parentBranchId !== event.branchId) throw new ValidationError("Task parent must match its event stream");
      const task: TaskState = { id: p.taskId, parentSessionId: p.parentSessionId, parentBranchId: p.parentBranchId, childSessionId: p.childSessionId, childBranchId: p.childBranchId, task: p.task, completionCriteria: p.completionCriteria ?? null, model: p.model, budget: p.budget, status: "pending", cancellationRequested: false, artifactIds: [], eventId: event.id };
      return { ...next, tasks: { ...state.tasks, [p.taskId]: task } };
    }
    case "SubagentAdmitted": {
      const p = event.payload as EventPayloads["SubagentAdmitted"]; const old = state.tasks[p.taskId];
      if (!old || old.status !== "pending" || old.childSessionId !== p.childSessionId || old.childBranchId !== p.childBranchId) throw new InvalidTransitionError("task", old?.status ?? "missing", "admitted");
      return { ...next, tasks: { ...state.tasks, [p.taskId]: { ...old, status: "admitted", eventId: event.id } } };
    }
    case "TaskStatusChanged": {
      const p = event.payload as EventPayloads["TaskStatusChanged"]; const old = state.tasks[p.taskId];
      if (!old || !taskCanTransition(old.status, p.status)) throw new InvalidTransitionError("task", old?.status ?? "missing", p.status);
      return { ...next, tasks: { ...state.tasks, [p.taskId]: { ...old, status: p.status, eventId: event.id, ...(p.result === undefined ? {} : { result: p.result }), ...(p.artifactIds === undefined ? {} : { artifactIds: p.artifactIds }), ...(p.error === undefined ? {} : { error: p.error }), ...(p.reason === undefined ? {} : { reason: p.reason }) } } };
    }
    case "SubagentCancellationRequested": {
      const p = event.payload as EventPayloads["SubagentCancellationRequested"]; const old = state.tasks[p.taskId];
      if (!old || old.childSessionId !== p.childSessionId || ["completed", "failed", "cancelled"].includes(old.status)) throw new InvalidTransitionError("task", old?.status ?? "missing", "cancellation-requested");
      return { ...next, tasks: { ...state.tasks, [p.taskId]: { ...old, cancellationRequested: true, ...(p.reason === undefined ? {} : { reason: p.reason }), eventId: event.id } } };
    }
    case "TaskUsageAttributed": {
      const p = event.payload as EventPayloads["TaskUsageAttributed"];
      return { ...next, budget: { ...state.budget, tokens: state.budget.tokens + p.tokens, costUsd: state.budget.costUsd + p.costUsd, turns: state.budget.turns + p.turns, wallTimeMs: state.budget.wallTimeMs + p.wallTimeMs } };
    }
    case "MailboxMessageSent": {
      const p = event.payload as EventPayloads["MailboxMessageSent"]; if (state.mailbox[p.mailboxMessageId]) throw new InvalidTransitionError("mailboxMessage", "existing", "sent");
      const message: MailboxMessageState = { id: p.mailboxMessageId, fromSessionId: p.fromSessionId, fromBranchId: p.fromBranchId, toSessionId: p.toSessionId, toBranchId: p.toBranchId, kind: p.kind, content: p.content, taskId: p.taskId ?? null, direction: "outbound", delivered: false, acknowledged: false, eventId: event.id };
      return { ...next, mailbox: { ...state.mailbox, [p.mailboxMessageId]: message } };
    }
    case "MailboxMessageDelivered": {
      const p = event.payload as EventPayloads["MailboxMessageDelivered"]; if (state.mailbox[p.mailboxMessageId]) throw new InvalidTransitionError("mailboxMessage", "existing", "delivered");
      const message: MailboxMessageState = { id: p.mailboxMessageId, fromSessionId: p.fromSessionId, fromBranchId: p.fromBranchId, toSessionId: p.toSessionId, toBranchId: p.toBranchId, kind: p.kind, content: p.content, taskId: p.taskId ?? null, direction: "inbound", delivered: true, acknowledged: false, eventId: event.id };
      return { ...next, mailbox: { ...state.mailbox, [p.mailboxMessageId]: message } };
    }
    case "MailboxMessageAcknowledged": {
      const p = event.payload as EventPayloads["MailboxMessageAcknowledged"]; const old = state.mailbox[p.mailboxMessageId];
      if (!old || old.acknowledged) throw new InvalidTransitionError("mailboxMessage", old ? "acknowledged" : "missing", "acknowledged");
      return { ...next, mailbox: { ...state.mailbox, [p.mailboxMessageId]: { ...old, acknowledged: true, eventId: event.id } } };
    }
    case "TaskTerminalNoticeSent":
    case "TaskTerminalNoticeDelivered": {
      const p = event.payload as EventPayloads["TaskTerminalNoticeSent"] | EventPayloads["TaskTerminalNoticeDelivered"];
      if (state.terminalNotices[p.noticeId]) throw new InvalidTransitionError("terminalNotice", "existing", "delivered");
      const delivered = event.type === "TaskTerminalNoticeDelivered";
      const notice: TerminalNoticeState = { id: p.noticeId, taskId: p.taskId, parentSessionId: p.parentSessionId, childSessionId: p.childSessionId, status: p.status, direction: delivered ? "inbound" : "outbound", delivered, artifactIds: p.artifactIds ?? [], eventId: event.id, ...(p.result === undefined ? {} : { result: p.result }), ...(p.error === undefined ? {} : { error: p.error }), ...(p.reason === undefined ? {} : { reason: p.reason }) };
      return { ...next, terminalNotices: { ...state.terminalNotices, [p.noticeId]: notice } };
    }
    case "DocumentImported": {
      const p = event.payload as EventPayloads["DocumentImported"]; if (state.documents[p.documentId]) throw new InvalidTransitionError("document", "existing", "imported");
      return { ...next, documents: { ...state.documents, [p.documentId]: { id: p.documentId, name: p.name, mediaType: p.mediaType, size: p.size, digest: p.digest, chunkCount: p.chunkCount, chunks: {}, eventId: event.id } } };
    }
    case "DocumentChunkAdded": {
      const p = event.payload as EventPayloads["DocumentChunkAdded"]; const document = state.documents[p.documentId];
      if (!document || document.chunks[p.chunkId] || Object.values(document.chunks).some((chunk) => chunk.ordinal === p.ordinal)) throw new InvalidTransitionError("documentChunk", document ? "duplicate" : "missing-document", "added");
      const chunk: DocumentChunkState = { id: p.chunkId, documentId: p.documentId, ordinal: p.ordinal, content: p.content, size: p.size, digest: p.digest, eventId: event.id };
      return { ...next, documents: { ...state.documents, [p.documentId]: { ...document, chunks: { ...document.chunks, [p.chunkId]: chunk }, eventId: event.id } } };
    }
    case "InputSetCreated": {
      const p = event.payload as EventPayloads["InputSetCreated"]; if (state.inputSets[p.inputSetId]) throw new InvalidTransitionError("inputSet", "existing", "created");
      const known = new Set(Object.values(state.documents).flatMap((document) => Object.keys(document.chunks)));
      if (p.chunkIds.some((chunkId) => !known.has(chunkId))) throw new ValidationError("Input set contains an unknown document chunk");
      return { ...next, inputSets: { ...state.inputSets, [p.inputSetId]: { id: p.inputSetId, name: p.name ?? null, chunkIds: p.chunkIds, ...(p.metadata === undefined ? {} : { metadata: p.metadata }), eventId: event.id } } };
    }
    case "GoalCreated": {
      const p = event.payload as EventPayloads["GoalCreated"]; if (state.goals[p.goalId] || Object.values(state.goals).some((goal) => !["completed", "failed", "cancelled"].includes(goal.status))) throw new InvalidTransitionError("goal", "active-goal-exists", "active");
      return { ...next, goals: { ...state.goals, [p.goalId]: { id: p.goalId, description: p.description, completionCriteria: p.completionCriteria ?? null, maxTurns: p.maxTurns ?? null, status: "active", completionRequestId: null, completionWorkspaceId: null, completionWorkspaceCursor: null, completionPinRecorded: false, gates: {}, eventId: event.id } } };
    }
    case "GoalCompletionRequested": {
      const p = event.payload as EventPayloads["GoalCompletionRequested"]; const old = state.goals[p.goalId];
      if (!old || old.status !== "active") throw new InvalidTransitionError("goal", old?.status ?? "missing", "completion_requested");
      return { ...next, goals: { ...state.goals, [p.goalId]: { ...old, status: "completion_requested", completionRequestId: p.requestId, completionWorkspaceId: p.workspaceId ?? null, completionWorkspaceCursor: p.workspaceCursor ?? null, completionPinRecorded: p.workspaceId !== undefined && Object.prototype.hasOwnProperty.call(p, "workspaceCursor"), eventId: event.id } } };
    }
    case "GoalGateAdded": {
      const p = event.payload as EventPayloads["GoalGateAdded"]; const goal = state.goals[p.goalId];
      if (!goal || goal.gates[p.gateId] || goal.status !== "active") throw new InvalidTransitionError("goalGate", goal?.status ?? "missing-goal", "pending");
      const gate: GoalGateState = { id: p.gateId, name: p.name, executor: p.executor, operation: p.operation, input: p.input, idempotent: p.idempotent, required: p.required, status: "pending", eventId: event.id };
      return { ...next, goals: { ...state.goals, [p.goalId]: { ...goal, gates: { ...goal.gates, [p.gateId]: gate }, eventId: event.id } } };
    }
    case "GoalGateStatusChanged": {
      const p = event.payload as EventPayloads["GoalGateStatusChanged"]; const goal = state.goals[p.goalId]; const old = goal?.gates[p.gateId];
      const valid = old && ((old.status === "pending" && ["running", "passed", "failed", "cancelled", "unknown"].includes(p.status)) || (old.status === "running" && ["passed", "failed", "cancelled", "unknown"].includes(p.status)) || (["passed", "failed", "cancelled", "unknown"].includes(old.status) && p.status === "running"));
      if (!goal || !old || !valid) throw new InvalidTransitionError("goalGate", old?.status ?? "missing", p.status);
      const { output: _oldOutput, error: _oldError, ...baseGate } = old;
      const gate: GoalGateState = { ...baseGate, status: p.status, eventId: event.id, ...(p.effectId === undefined ? {} : { effectId: p.effectId }), ...(p.output === undefined ? {} : { output: p.output }), ...(p.error === undefined ? {} : { error: p.error }) };
      return { ...next, goals: { ...state.goals, [p.goalId]: { ...goal, gates: { ...goal.gates, [p.gateId]: gate }, eventId: event.id } } };
    }
    case "GoalStatusChanged": {
      const p = event.payload as EventPayloads["GoalStatusChanged"]; const old = state.goals[p.goalId];
      const valid = old && !["completed", "failed", "cancelled"].includes(old.status) &&
        (p.status === "failed" || p.status === "cancelled" ||
          (p.status === "completed" && old.status === "completion_requested") ||
          (p.status === "blocked" && old.status === "completion_requested") ||
          (p.status === "active" && old.status === "blocked") ||
          (p.status === "completion_requested" && old.status === "active"));
      if (!old || !valid) throw new InvalidTransitionError("goal", old?.status ?? "missing", p.status);
      const { reason: _oldReason, ...baseGoal } = old;
      return { ...next, goals: { ...state.goals, [p.goalId]: { ...baseGoal, status: p.status, ...(p.reason === undefined ? {} : { reason: p.reason }), eventId: event.id } } };
    }
    case "HeartbeatCreated": {
      const p = event.payload as EventPayloads["HeartbeatCreated"]; if (state.heartbeats[p.heartbeatId]) throw new InvalidTransitionError("heartbeat", "existing", "active");
      if (p.goalId && !state.goals[p.goalId]) throw new ValidationError("Heartbeat goal does not exist");
      return { ...next, heartbeats: { ...state.heartbeats, [p.heartbeatId]: { id: p.heartbeatId, intervalMs: p.intervalMs, nextTickAt: p.nextTickAt, goalId: p.goalId ?? null, ...(p.payload === undefined ? {} : { payload: p.payload }), status: "active", tick: 0, lastFiredAt: null, eventId: event.id } } };
    }
    case "HeartbeatTicked": {
      const p = event.payload as EventPayloads["HeartbeatTicked"]; const old = state.heartbeats[p.heartbeatId];
      if (!old || old.status !== "active" || p.tick !== old.tick + 1) throw new InvalidTransitionError("heartbeat", old?.status ?? "missing", "ticked");
      return { ...next, heartbeats: { ...state.heartbeats, [p.heartbeatId]: { ...old, tick: p.tick, lastFiredAt: p.firedAt, nextTickAt: p.nextTickAt, eventId: event.id } } };
    }
    case "HeartbeatStatusChanged": {
      const p = event.payload as EventPayloads["HeartbeatStatusChanged"]; const old = state.heartbeats[p.heartbeatId];
      if (!old || old.status === "cancelled" || old.status === p.status) throw new InvalidTransitionError("heartbeat", old?.status ?? "missing", p.status);
      return { ...next, heartbeats: { ...state.heartbeats, [p.heartbeatId]: { ...old, status: p.status, ...(p.nextTickAt === undefined ? {} : { nextTickAt: p.nextTickAt }), eventId: event.id } } };
    }
    case "RecursiveModelStarted": {
      const p = event.payload as EventPayloads["RecursiveModelStarted"]; if (state.recursiveModels[p.handleId]) throw new InvalidTransitionError("recursiveModel", "existing", "pending");
      const handle: RecursiveModelState = { id: p.handleId, taskId: p.taskId, parentSessionId: p.parentSessionId, parentBranchId: p.parentBranchId, childSessionId: p.childSessionId, childBranchId: p.childBranchId, model: p.model, inputSetId: p.inputSetId ?? null, ...(p.input === undefined ? {} : { input: p.input }), ...(p.inputProvenance === undefined ? {} : { inputProvenance: p.inputProvenance }), ...(p.inputHash === undefined ? {} : { inputHash: p.inputHash }), status: "pending", eventId: event.id };
      return { ...next, recursiveModels: { ...state.recursiveModels, [p.handleId]: handle } };
    }
    case "RecursiveModelStatusChanged": {
      const p = event.payload as EventPayloads["RecursiveModelStatusChanged"]; const old = state.recursiveModels[p.handleId];
      const valid = old && ((old.status === "pending" && ["running", "completed", "failed", "cancelled"].includes(p.status)) || (old.status === "running" && ["completed", "failed", "cancelled"].includes(p.status)));
      if (!old || !valid) throw new InvalidTransitionError("recursiveModel", old?.status ?? "missing", p.status);
      const updated: RecursiveModelState = { ...old, status: p.status, eventId: event.id, ...(p.outcome === undefined ? {} : { outcome: p.outcome }), ...(p.resultMessageId === undefined ? {} : { resultMessageId: p.resultMessageId }), ...(p.result === undefined ? {} : { result: p.result }), ...(p.resultArtifactId === undefined ? {} : { resultArtifactId: p.resultArtifactId }), ...(p.error === undefined ? {} : { error: p.error }) };
      return { ...next, recursiveModels: { ...state.recursiveModels, [p.handleId]: updated } };
    }
    case "AgentRunRequested": {
      const p = event.payload as EventPayloads["AgentRunRequested"];
      if (state.agentRuns[p.runId]) throw new InvalidTransitionError("agentRun", state.agentRuns[p.runId]!.status, "queued");
      if (Object.values(state.agentRuns).some((run) => !["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status))) {
        throw new InvalidTransitionError("agentRun", "active-run-exists", "queued");
      }
      const run: AgentRunState = {
        id: p.runId, task: p.task, requestKey: p.requestKey, goalId: p.goalId ?? null, status: "queued",
        steps: [], inputRequests: {}, cancellationRequested: false, requestEventId: event.id, eventId: event.id,
      };
      return { ...next, agentRuns: { ...state.agentRuns, [p.runId]: run } };
    }
    case "AgentRunStepStarted": {
      const p = event.payload as EventPayloads["AgentRunStepStarted"]; const run = state.agentRuns[p.runId];
      const expected = (run?.steps.at(-1)?.ordinal ?? 0) + 1;
      const prior = run?.steps.at(-1);
      if (!run || !["queued", "running"].includes(run.status) || p.ordinal !== expected ||
          (prior !== undefined && prior.action === undefined && prior.rejection === undefined)) {
        throw new InvalidTransitionError("agentRunStep", run?.status ?? "missing-run", "started");
      }
      const step: AgentRunStepState = { id: p.stepId, ordinal: p.ordinal, contextId: p.contextId, callId: p.callId, effectId: p.effectId, actionId: p.actionId, observationEventIds: [...p.observationEventIds], eventId: event.id };
      return { ...next, agentRuns: { ...state.agentRuns, [p.runId]: { ...run, status: "running", steps: [...run.steps, step], eventId: event.id } } };
    }
    case "AgentRunActionCommitted": {
      const p = event.payload as EventPayloads["AgentRunActionCommitted"]; const run = state.agentRuns[p.runId]; const step = run?.steps.at(-1);
      if (!run || run.status !== "running" || !step || step.id !== p.stepId || step.ordinal !== p.ordinal || step.actionId !== p.actionId || step.callId !== p.callId || step.action !== undefined || step.rejection !== undefined) {
        throw new InvalidTransitionError("agentRunAction", step?.action ? "committed" : run?.status ?? "missing-run", "committed");
      }
      const updated = { ...step, action: p.action, rawAction: p.raw, eventId: event.id };
      return { ...next, agentRuns: { ...state.agentRuns, [p.runId]: { ...run, steps: [...run.steps.slice(0, -1), updated], eventId: event.id } } };
    }
    case "AgentRunActionRejected": {
      const p = event.payload as EventPayloads["AgentRunActionRejected"]; const run = state.agentRuns[p.runId]; const step = run?.steps.at(-1);
      if (!run || run.status !== "running" || !step || step.id !== p.stepId || step.ordinal !== p.ordinal || step.actionId !== p.actionId || step.callId !== p.callId || step.action !== undefined || step.rejection !== undefined) {
        throw new InvalidTransitionError("agentRunAction", step?.rejection ? "rejected" : run?.status ?? "missing-run", "rejected");
      }
      const updated = { ...step, rejection: p.error, rawAction: p.raw, eventId: event.id };
      return { ...next, agentRuns: { ...state.agentRuns, [p.runId]: { ...run, steps: [...run.steps.slice(0, -1), updated], eventId: event.id } } };
    }
    case "AgentRunUserInputRequested": {
      const p = event.payload as EventPayloads["AgentRunUserInputRequested"]; const run = state.agentRuns[p.runId]; const step = run?.steps.at(-1);
      if (!run || run.status !== "running" || !step?.action || step.actionId !== p.actionId || run.inputRequests[p.requestId]) {
        throw new InvalidTransitionError("agentRunInput", run?.status ?? "missing-run", "requested");
      }
      const request: AgentRunInputRequestState = { id: p.requestId, actionId: p.actionId, kind: p.kind, question: p.question, ...(p.permission === undefined ? {} : { permission: p.permission }), requestedEventId: event.id };
      return { ...next, agentRuns: { ...state.agentRuns, [p.runId]: { ...run, inputRequests: { ...run.inputRequests, [p.requestId]: request }, eventId: event.id } } };
    }
    case "AgentRunUserInputReceived": {
      const p = event.payload as EventPayloads["AgentRunUserInputReceived"]; const run = state.agentRuns[p.runId]; const request = run?.inputRequests[p.requestId];
      if (!run || run.status !== "waiting_for_user" || !request || request.response !== undefined) throw new InvalidTransitionError("agentRunInput", request?.response === undefined ? run?.status ?? "missing-run" : "received", "received");
      const updated = { ...request, response: p.response, ...(p.approved === undefined ? {} : { approved: p.approved }), receivedEventId: event.id };
      return { ...next, agentRuns: { ...state.agentRuns, [p.runId]: { ...run, status: "running", inputRequests: { ...run.inputRequests, [p.requestId]: updated }, eventId: event.id } } };
    }
    case "AgentRunCancellationRequested": {
      const p = event.payload as EventPayloads["AgentRunCancellationRequested"]; const run = state.agentRuns[p.runId];
      if (!run || ["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status) || run.cancellationRequested) throw new InvalidTransitionError("agentRun", run?.status ?? "missing", "cancellation_requested");
      return { ...next, agentRuns: { ...state.agentRuns, [p.runId]: { ...run, cancellationRequested: true, ...(p.reason === undefined ? {} : { cancellationReason: p.reason }), eventId: event.id } } };
    }
    case "AgentRunStatusChanged": {
      const p = event.payload as EventPayloads["AgentRunStatusChanged"]; const run = state.agentRuns[p.runId];
      const terminal = ["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"];
      const valid = run && !terminal.includes(run.status) && (
        (p.status === "waiting_for_user" && run.status === "running" && Object.values(run.inputRequests).some((request) => request.response === undefined)) ||
        (p.status === "cancelled" && run.cancellationRequested) ||
        (terminal.includes(p.status) && p.status !== "cancelled")
      );
      if (!run || !valid) throw new InvalidTransitionError("agentRun", run?.status ?? "missing", p.status);
      return { ...next, agentRuns: { ...state.agentRuns, [p.runId]: { ...run, status: p.status, ...(p.reason === undefined ? {} : { reason: p.reason }), ...(p.finalMessageId === undefined ? {} : { finalMessageId: p.finalMessageId }), eventId: event.id } } };
    }
    // Harness history is canonical and has dedicated rebuildable relational
    // projections. Session projection still advances its cursor so snapshot
    // recovery retains the exact committed boundary.
    case "HarnessVersionCreated":
    case "HarnessVersionStatusChanged":
    case "RefinementProposed":
    case "RefinementValidated":
    case "RefinementCandidateActivated":
    case "RefinementCandidateAllocated":
    case "RefinementCandidateExposed":
    case "RefinementObservationRecorded":
    case "RefinementDecided":
    case "RefinementApproved":
    case "RefinementRollbackApproved":
    case "RefinementRolledBack":
    case "SkillInvocationRecorded":
    case "SkillTestRecorded":
    case "SubagentSpecInvoked":
      return next;
  }
}

export function projectEvents(events: readonly AgentEvent[]): AgentState {
  let state: AgentState | undefined;
  for (const event of events) state = reduceAgentState(state, event);
  if (!state) throw new ValidationError("Cannot project an empty event stream");
  return state;
}

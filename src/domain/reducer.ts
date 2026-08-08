import { EVENT_SCHEMA_VERSION, type AgentEvent, type EventPayloads, type ModelCallResult, type TaskStatus } from "./events.ts";
import type {
  AgentRunState, AgentRunStepState, AgentState, CellState, DocumentChunkState, EffectState, GoalGateState,
  MailboxMessageState, ModelCallState, RecursiveModelState, TaskState, TerminalNoticeState,
} from "./state.ts";
import { REDUCER_VERSION } from "./state.ts";
import { InvalidTransitionError, ValidationError } from "./errors.ts";
import type { AgentAction } from "./agent-action.ts";
import { agentActionFromToolSubmission } from "./agent-tool-contract.ts";
import {
  validateModelEffectOutputV2,
  type ModelEffectOutputV2,
} from "./model-response.ts";
import { validateModelDispatch, type ModelDispatch } from "./model.ts";

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
  if (event.schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new ValidationError(
      `Unsupported event schema version ${event.schemaVersion}. Reset local Agencity state before using schema version ${EVENT_SCHEMA_VERSION}; legacy history was not projected.`,
    );
  }
  if (state?.appliedEventIds.includes(event.id)) return state;
  if (!state) {
    if (event.type !== "SessionCreated") throw new ValidationError("First projected event must be SessionCreated");
    const p = event.payload as EventPayloads["SessionCreated"];
    const parentSessionId = p.parentSessionId ?? null;
    const parentBranchId = p.parentBranchId ?? null;
    if ((parentSessionId === null) !== (parentBranchId === null)) throw new ValidationError("Session ancestry requires both parent IDs");
    return {
      reducerVersion: REDUCER_VERSION, sessionId: event.sessionId, workspaceId: p.workspaceId, sessionName: p.sessionName ?? null,
      parentSessionId, parentBranchId, rootSessionId: p.rootSessionId ?? event.sessionId,
      depth: p.depth ?? 0, taskId: p.taskId ?? null,
      branch: { id: p.initialBranchId, parentBranchId: null, forkCursor: null, name: p.initialBranchName ?? null }, model: p.model,
      status: "idle", cursor: event.cursor, appliedEventIds: [event.id], messages: [], cells: {}, workingValues: {}, artifacts: {}, effects: {}, effectReconciliations: {}, contexts: {}, compactions: {}, modelCalls: {},
      budget: { limits: p.budget, tokens: 0, costUsd: 0, turns: 0, wallTimeMs: 0, exceeded: false },
      tasks: {}, mailbox: {}, terminalNotices: {}, documents: {}, inputSets: {}, goals: {}, heartbeats: {}, schedules: {}, wakes: {}, recursiveModels: {}, agentRuns: {}, userCorrections: {}, refinementReviews: {}, refinementTriggerConsumptions: {},
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
    case "SessionModelChanged": {
      const p = event.payload as EventPayloads["SessionModelChanged"];
      if (!Bun.deepEquals(p.previousModel, state.model)) throw new InvalidTransitionError("sessionModel", `${state.model.provider}:${state.model.model}`, `${p.model.provider}:${p.model.model}`);
      if (state.status === "running" ||
          Object.values(state.agentRuns).some(run => !["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status)) ||
          Object.values(state.modelCalls).some(call => call.status === "requested")) {
        throw new InvalidTransitionError("sessionModel", "active", `${p.model.provider}:${p.model.model}`);
      }
      return { ...next, model: p.model };
    }
    case "MessageAppended": { const p = event.payload as EventPayloads["MessageAppended"]; return { ...next, messages: [...state.messages, { id: p.messageId, role: p.role, content: p.content, eventId: event.id, eventCursor: event.cursor, schemaVersion: event.schemaVersion, modelCallId: p.modelCallId ?? null, ...(p.mailbox === undefined ? {} : { mailbox: { ...p.mailbox, ...(p.mailbox.artifactIds === undefined ? {} : { artifactIds: [...p.mailbox.artifactIds] }) } }) }] }; }
    case "CellProposed": { const p = event.payload as EventPayloads["CellProposed"]; if (state.cells[p.cellId]) throw new InvalidTransitionError("cell", state.cells[p.cellId]!.status, "proposed"); const cell: CellState = { id: p.cellId, code: p.code, status: "proposed", attempts: 0, logs: [], eventId: event.id }; return { ...next, cells: { ...state.cells, [p.cellId]: cell } }; }
    case "CellStarted": { const p = event.payload as EventPayloads["CellStarted"]; const old = state.cells[p.cellId]; if (!old || !["proposed", "running"].includes(old.status) || p.attempt !== old.attempts + 1) throw new InvalidTransitionError("cell", old?.status ?? "missing", "running"); return { ...next, cells: { ...state.cells, [p.cellId]: { ...old, status: "running", attempts: p.attempt, eventId: event.id } } }; }
    case "CellCommitted": { const p = event.payload as EventPayloads["CellCommitted"]; const old = state.cells[p.cellId]; if (!old || old.status !== "running") throw new InvalidTransitionError("cell", old?.status ?? "missing", "committed"); return { ...next, cells: { ...state.cells, [p.cellId]: { ...old, status: "committed", result: p.result, logs: p.logs, eventId: event.id } } }; }
    case "CellFailed": { const p = event.payload as EventPayloads["CellFailed"]; const old = state.cells[p.cellId]; if (!old || old.status !== "running") throw new InvalidTransitionError("cell", old?.status ?? "missing", "failed"); return { ...next, cells: { ...state.cells, [p.cellId]: { ...old, status: "failed", error: p.error, logs: p.logs, eventId: event.id } } }; }
    case "CellAbandoned": { const p = event.payload as EventPayloads["CellAbandoned"]; const old = state.cells[p.cellId]; if (!old || !["proposed", "running"].includes(old.status)) throw new InvalidTransitionError("cell", old?.status ?? "missing", "abandoned"); return { ...next, cells: { ...state.cells, [p.cellId]: { ...old, status: "abandoned", error: p.reason, eventId: event.id } } }; }
    case "WorkingValueSet": { const p = event.payload as EventPayloads["WorkingValueSet"]; const old = state.workingValues[p.name]; if (old && p.version <= old.version) throw new ValidationError(`Working value version must increase for ${p.name}`); return { ...next, workingValues: { ...state.workingValues, [p.name]: { name: p.name, version: p.version, value: p.value, eventId: event.id } } }; }
    case "ArtifactRegistered": { const p = event.payload as EventPayloads["ArtifactRegistered"]; return { ...next, artifacts: { ...state.artifacts, [p.artifactId]: { artifactId: p.artifactId, digest: p.digest, mediaType: p.mediaType, size: p.size } } }; }
    case "EffectRequested": {
      const p = event.payload as EventPayloads["EffectRequested"];
      if (state.effects[p.effectId]) throw new InvalidTransitionError("effect", state.effects[p.effectId]!.status, "requested");
      if (p.executor === "model") validateModelEffectRelation(state, p);
      const effect: EffectState = { id: p.effectId, executor: p.executor, operation: p.operation, input: p.input, idempotencyKey: p.idempotencyKey, idempotent: p.idempotent, attempts: 0, status: "requested", eventId: event.id };
      return { ...next, effects: { ...state.effects, [p.effectId]: effect } };
    }
    case "EffectAttemptStarted": { const p = event.payload as EventPayloads["EffectAttemptStarted"]; const old = state.effects[p.effectId]; if (!old || !["requested", "started"].includes(old.status) || p.attempt !== old.attempts + 1) throw new InvalidTransitionError("effect", old?.status ?? "missing", "started"); return { ...next, effects: { ...state.effects, [p.effectId]: { ...old, status: "started", attempts: p.attempt, eventId: event.id } } }; }
    case "EffectOutcomeRecorded": {
      const p = event.payload as EventPayloads["EffectOutcomeRecorded"];
      const old = state.effects[p.effectId];
      if (!old || !["requested", "started"].includes(old.status) || p.attempt < Math.max(1, old.attempts)) {
        throw new InvalidTransitionError("effect", old?.status ?? "missing", p.outcome);
      }
      if (old.executor === "model") {
        if (p.outcome === "succeeded") {
          if (p.output === undefined || p.modelFailure !== undefined) {
            throw new ValidationError("Succeeded model effects require one normalized output and no modelFailure");
          }
          const dispatch = modelDispatchFromEffectInput(old.input);
          validateModelEffectOutputV2(p.output, {
            responseContract: dispatch.responseContract,
            responseCapability: dispatch.responseCapability,
            configuredProvider: dispatch.configuration.provider,
          });
        } else if (p.outcome === "failed") {
          if (p.modelFailure === undefined) throw new ValidationError("Failed model effects require a typed modelFailure");
        } else if (p.modelFailure !== undefined) {
          throw new ValidationError("Cancelled and unknown model effects must omit modelFailure");
        }
      } else if (p.modelFailure !== undefined) {
        throw new ValidationError("Non-model effects cannot retain modelFailure");
      }
      const updated: EffectState = {
        ...old,
        status: p.outcome,
        attempts: Math.max(old.attempts, p.attempt),
        eventId: event.id,
        ...(p.output === undefined ? {} : { output: p.output }),
        ...(p.error === undefined ? {} : { error: p.error }),
        ...(p.modelFailure === undefined ? {} : { modelFailure: p.modelFailure.code }),
      };
      return { ...next, effects: { ...state.effects, [p.effectId]: updated } };
    }
    case "EffectReconciliationRecorded": {
      const p = event.payload as EventPayloads["EffectReconciliationRecorded"];
      const effect = state.effects[p.effectId];
      if (!effect || effect.status !== "unknown") throw new InvalidTransitionError("effectReconciliation", effect?.status ?? "missing", p.assessment);
      if (state.effectReconciliations[p.reconciliationId]) throw new InvalidTransitionError("effectReconciliation", "existing", "recorded");
      return { ...next, effectReconciliations: { ...state.effectReconciliations, [p.reconciliationId]: {
        id: p.reconciliationId, effectId: p.effectId, assessment: p.assessment, summary: p.summary,
        ...(p.evidence === undefined ? {} : { evidence: p.evidence }), recordedBy: p.recordedBy,
        recordedAt: p.recordedAt, eventId: event.id,
      } } };
    }
    case "ContextCompactionRequested": {
      const p = event.payload as EventPayloads["ContextCompactionRequested"];
      if (state.compactions[p.compactionId]) throw new InvalidTransitionError("contextCompaction", state.compactions[p.compactionId]!.status, "requested");
      const sourceIds = new Set(p.sourceEventIds);
      if (sourceIds.size !== p.sourceEventIds.length || p.frozenSources.some((source, index) => {
        const message = state.messages.find((candidate) => candidate.eventId === source.eventId);
        const exactPayload = message ? {
          messageId: message.id, role: message.role, content: message.content,
          ...(message.modelCallId === null ? {} : { modelCallId: message.modelCallId }),
          ...(message.mailbox === undefined ? {} : { mailbox: message.mailbox }),
        } : null;
        return source.eventId !== p.sourceEventIds[index] || !state.appliedEventIds.includes(source.eventId) || BigInt(source.cursor) > BigInt(p.throughCursor) || source.type !== "MessageAppended" || exactPayload === null || !message || BigInt(source.cursor) !== BigInt(message.eventCursor) || source.schemaVersion !== message.schemaVersion || !Bun.deepEquals(source.payload, exactPayload);
      })) {
        throw new ValidationError("Context compaction sources must be exact unique retained prior narrative events at or before throughCursor");
      }
      if (p.modelDispatch !== undefined && !Bun.deepEquals(p.modelDispatch.configuration, state.model)) {
        throw new ValidationError("Context compaction dispatch configuration must match the committed branch configuration");
      }
      return { ...next, compactions: { ...state.compactions, [p.compactionId]: {
        id: p.compactionId, strategy: p.strategy, reason: p.reason, requestedBy: p.requestedBy,
        ...(p.instructions === undefined ? {} : { instructions: p.instructions }), throughCursor: p.throughCursor,
        sourceEventIds: [...p.sourceEventIds], sourceDigest: p.sourceDigest,
        frozenSources: p.frozenSources.map((source) => ({ ...source })),
        ...(p.capacity === undefined ? {} : { capacity: { ...p.capacity } }),
        ...(p.ancestorContextId === undefined ? {} : { ancestorContextId: p.ancestorContextId }),
        ...(p.rematerializedFromContextId === undefined ? {} : { rematerializedFromContextId: p.rematerializedFromContextId }),
        ...(p.modelDispatch === undefined ? {} : { modelDispatch: p.modelDispatch }),
        status: "requested", requestEventId: event.id, eventId: event.id,
      } } };
    }
    case "ContextCompactionFailed": {
      const p = event.payload as EventPayloads["ContextCompactionFailed"]; const old = state.compactions[p.compactionId];
      if (!old || old.status !== "requested" || old.requestEventId !== p.requestEventId || old.strategy !== p.strategy) throw new InvalidTransitionError("contextCompaction", old?.status ?? "missing", p.outcome);
      return { ...next, compactions: { ...state.compactions, [p.compactionId]: { ...old, status: p.outcome, error: p.error, ...(p.effectId === undefined ? {} : { effectIds: [p.effectId] }), eventId: event.id } } };
    }
    case "ContextMaterialized": {
      const p = event.payload as EventPayloads["ContextMaterialized"];
      if (state.contexts[p.contextId]) throw new InvalidTransitionError("context", "materialized", "materialized");
      let compactions = state.compactions;
      if (p.derivation) {
        const request = state.compactions[p.derivation.compactionId];
        if (!request || request.status !== "requested" || request.requestEventId !== p.derivation.requestEventId || request.strategy !== p.derivation.strategy || request.sourceDigest !== p.derivation.sourceDigest || !sameStrings(request.sourceEventIds, p.derivation.sourceEventIds)) {
          throw new InvalidTransitionError("contextCompaction", request?.status ?? "missing", "completed");
        }
        compactions = { ...state.compactions, [request.id]: { ...request, status: "completed", contextId: p.contextId, ...(p.derivation.effectIds === undefined ? {} : { effectIds: [...p.derivation.effectIds] }), eventId: event.id } };
      }
      return { ...next, compactions, contexts: { ...state.contexts, [p.contextId]: { id: p.contextId, records: p.records.map((record) => ({ ...record })), contentHash: p.contentHash, ...(p.derivation === undefined ? {} : { derivation: p.derivation }), eventId: event.id } } };
    }
    case "ModelCallRequested": {
      const p = event.payload as EventPayloads["ModelCallRequested"];
      if (!state.contexts[p.contextId] || state.modelCalls[p.callId]) throw new InvalidTransitionError("modelCall", state.modelCalls[p.callId]?.status ?? "missing-context", "requested");
      if (Object.values(state.modelCalls).some((call) => call.effectId === p.effectId)) {
        throw new ValidationError("A model effect can belong to only one model call");
      }
      if (!Bun.deepEquals(p.modelDispatch.configuration, state.model)) throw new ValidationError("Model call dispatch configuration must match the committed branch configuration");
      const ownedStep = Object.values(state.agentRuns)
        .flatMap((run) => run.steps)
        .find((candidate) => candidate.callId === p.callId || candidate.modelAttempts.some((attempt) => attempt.callId === p.callId));
      if (ownedStep) {
        const ownedAttempt = ownedStep.modelAttempts.at(-1);
        if (!ownedAttempt || ownedAttempt.callId !== p.callId || ownedAttempt.effectId !== p.effectId ||
            ownedAttempt.contextId !== p.contextId || ownedAttempt.estimatedInputTokens !== p.estimatedInputTokens ||
            ownedAttempt.attempt !== (p.attempt ?? 1) || ownedAttempt.retryOfCallId !== p.retryOfCallId ||
            !Bun.deepEquals(ownedAttempt.contextWindow, p.contextWindow)) {
          throw new ValidationError("Agent-run model call must be atomically bound to its retained attempt");
        }
      }
      if (p.retryOfCallId !== undefined) {
        const prior = state.modelCalls[p.retryOfCallId];
        if (!prior || !Bun.deepEquals(prior.modelDispatch, p.modelDispatch)) throw new ValidationError("Model overflow retries must reuse the complete prior dispatch");
      }
      const call: ModelCallState = { id: p.callId, contextId: p.contextId, effectId: p.effectId, modelDispatch: p.modelDispatch, estimatedInputTokens: p.estimatedInputTokens, attempt: p.attempt ?? 1, ...(p.retryOfCallId === undefined ? {} : { retryOfCallId: p.retryOfCallId }), ...(p.contextWindow === undefined ? {} : { contextWindow: p.contextWindow }), chunks: [], status: "requested", eventId: event.id };
      return { ...next, modelCalls: { ...state.modelCalls, [p.callId]: call } };
    }
    case "ModelOutputChunk": {
      const p = event.payload as EventPayloads["ModelOutputChunk"];
      const old = state.modelCalls[p.callId];
      if (!old || old.status !== "requested" || old.modelDispatch.responseContract.kind !== "text" || p.sequence !== old.chunks.length) {
        throw new InvalidTransitionError("modelCall", old?.status ?? "missing", "streaming");
      }
      return { ...next, modelCalls: { ...state.modelCalls, [p.callId]: { ...old, chunks: [...old.chunks, p.text], eventId: event.id } } };
    }
    case "ModelCallCompleted": {
      const p = event.payload as EventPayloads["ModelCallCompleted"]; const old = state.modelCalls[p.callId];
      const response = p.responseMessageId === undefined ? undefined : state.messages.find((message) => message.id === p.responseMessageId);
      const effect = old ? state.effects[old.effectId] : undefined;
      if (!old || old.status !== "requested" || effect?.status !== "succeeded" || effect.output === undefined) {
        throw new InvalidTransitionError("modelCall", old?.status ?? "missing", "succeeded");
      }
      const output = validateModelEffectOutputV2(effect.output, {
        responseContract: old.modelDispatch.responseContract,
        responseCapability: old.modelDispatch.responseCapability,
        configuredProvider: old.modelDispatch.configuration.provider,
      });
      const expected = compactModelCallResult(output);
      const text = output.result.kind === "text" ? output.result.text : undefined;
      const textShapeValid = output.result.kind === "text"
        ? p.responseMessageId !== undefined && response?.role === "assistant" && response.modelCallId === p.callId &&
          response.content === text && old.chunks.join("") === text
        : p.responseMessageId === undefined && old.chunks.length === 0;
      const responseUsage = output.response.usage;
      const usageSource = output.response.kind === "guard-aborted"
        ? "conservative-guard-estimate"
        : "provider-reported";
      if (!textShapeValid || !Bun.deepEquals(p.result, expected) || p.resultDigest !== output.resultDigest ||
          !Bun.deepEquals(p.termination, output.response.termination) ||
          !Bun.deepEquals(p.usage, responseUsage) ||
          !Bun.deepEquals(p.warnings, output.response.warnings) ||
          p.usageSource !== usageSource) {
        throw new ValidationError("Model completion does not match its authoritative retained effect output");
      }
      return { ...next, modelCalls: { ...state.modelCalls, [p.callId]: {
        ...old, status: "succeeded",
        ...(p.responseMessageId === undefined ? {} : { responseMessageId: p.responseMessageId }),
        result: p.result, resultDigest: p.resultDigest, termination: p.termination,
        usage: p.usage, usageSource: p.usageSource,
        warnings: p.warnings.map((warning) => ({ ...warning })), eventId: event.id,
      } } };
    }
    case "ModelCallTerminated": {
      const p = event.payload as EventPayloads["ModelCallTerminated"];
      const old = state.modelCalls[p.callId];
      const effect = old ? state.effects[old.effectId] : undefined;
      if (!old || old.status !== "requested" || !effect || effect.status !== p.outcome ||
          (p.outcome === "failed" && p.failureCode !== effect.modelFailure) ||
          (p.outcome !== "failed" && p.failureCode !== undefined)) {
        throw new InvalidTransitionError("modelCall", old?.status ?? "missing", p.outcome);
      }
      return { ...next, modelCalls: { ...state.modelCalls, [p.callId]: { ...old, status: p.outcome, ...(p.error === undefined ? {} : { error: p.error }), ...(p.failureCode === undefined ? {} : { failureCode: p.failureCode }), eventId: event.id } } };
    }
    case "BudgetDebited": {
      const p = event.payload as EventPayloads["BudgetDebited"];
      const call = state.modelCalls[p.callId];
      if (call) {
        if (call.status !== "succeeded" || call.usageSource !== p.usageSource || call.budgetDebited !== undefined) {
          throw new ValidationError("Model-call budget debit must match its completed usage attribution");
        }
        const expectedTokens = call.usageSource === "provider-reported"
          ? (call.usage?.inputTokens ?? 0) + (call.usage?.outputTokens ?? 0)
          : call.estimatedInputTokens + (call.contextWindow?.outputReserveTokens ?? call.modelDispatch.configuration.maxOutputTokens ?? 0);
        const expectedCost = call.usageSource === "provider-reported" ? call.usage?.costUsd ?? 0 : 0;
        if (p.tokens !== expectedTokens || p.costUsd !== expectedCost || p.turns !== 1) {
          throw new ValidationError("Model-call budget debit disagrees with retained usage provenance");
        }
      }
      return {
        ...next,
        ...(call === undefined ? {} : {
          modelCalls: {
            ...state.modelCalls,
            [p.callId]: {
              ...call,
              budgetDebited: {
                tokens: p.tokens, costUsd: p.costUsd, turns: p.turns,
                wallTimeMs: p.wallTimeMs, usageSource: p.usageSource, eventId: event.id,
              },
            },
          },
        }),
        budget: { ...state.budget, tokens: state.budget.tokens + p.tokens, costUsd: state.budget.costUsd + p.costUsd, turns: state.budget.turns + p.turns, wallTimeMs: state.budget.wallTimeMs + p.wallTimeMs },
      };
    }
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
      const legacyDelivered = p.intentKey === undefined;
      const message: MailboxMessageState = { id: p.mailboxMessageId, fromSessionId: p.fromSessionId, fromBranchId: p.fromBranchId, toSessionId: p.toSessionId, toBranchId: p.toBranchId, kind: p.kind, content: p.content, taskId: p.taskId ?? null, artifactIds: [...(p.artifactIds ?? [])], direction: "outbound", intentKey: p.intentKey ?? null, followUp: p.followUp ?? false, replyToMessageId: p.replyToMessageId ?? null, senderRelationship: null, receiptStatus: legacyDelivered ? "delivered_to_context" : "queued", delivered: legacyDelivered, deliveredToContext: legacyDelivered, acknowledged: false, followUpRunId: null, error: null, eventId: event.id };
      return { ...next, mailbox: { ...state.mailbox, [p.mailboxMessageId]: message } };
    }
    case "MailboxMessageDelivered": {
      const p = event.payload as EventPayloads["MailboxMessageDelivered"]; if (state.mailbox[p.mailboxMessageId]) throw new InvalidTransitionError("mailboxMessage", "existing", "delivered");
      const legacyDelivered = p.intentKey === undefined;
      const message: MailboxMessageState = { id: p.mailboxMessageId, fromSessionId: p.fromSessionId, fromBranchId: p.fromBranchId, toSessionId: p.toSessionId, toBranchId: p.toBranchId, kind: p.kind, content: p.content, taskId: p.taskId ?? null, artifactIds: [...(p.artifactIds ?? [])], direction: "inbound", intentKey: p.intentKey ?? null, followUp: p.followUp ?? false, replyToMessageId: p.replyToMessageId ?? null, senderRelationship: p.senderRelationship ?? null, receiptStatus: legacyDelivered ? "delivered_to_context" : "queued", delivered: true, deliveredToContext: legacyDelivered, acknowledged: false, followUpRunId: null, error: null, eventId: event.id };
      return { ...next, mailbox: { ...state.mailbox, [p.mailboxMessageId]: message } };
    }
    case "MailboxMessageContextDelivered": {
      const p = event.payload as EventPayloads["MailboxMessageContextDelivered"]; const old = state.mailbox[p.mailboxMessageId];
      if (!old) throw new InvalidTransitionError("mailboxMessage", "missing", "delivered_to_context");
      if (old.receiptStatus === "failed") throw new InvalidTransitionError("mailboxMessage", "failed", "delivered_to_context");
      return { ...next, mailbox: { ...state.mailbox, [p.mailboxMessageId]: { ...old, delivered: true, deliveredToContext: true, senderRelationship: old.senderRelationship ?? p.relationship, receiptStatus: old.acknowledged ? "acknowledged" : "delivered_to_context", followUpRunId: p.runId ?? old.followUpRunId, eventId: event.id } } };
    }
    case "MailboxMessageDeliveryFailed": {
      const p = event.payload as EventPayloads["MailboxMessageDeliveryFailed"]; const old = state.mailbox[p.mailboxMessageId];
      if (!old || old.acknowledged || old.deliveredToContext) throw new InvalidTransitionError("mailboxMessage", old?.receiptStatus ?? "missing", "failed");
      return { ...next, mailbox: { ...state.mailbox, [p.mailboxMessageId]: { ...old, receiptStatus: "failed", error: p.error, eventId: event.id } } };
    }
    case "MailboxMessageAcknowledged": {
      const p = event.payload as EventPayloads["MailboxMessageAcknowledged"]; const old = state.mailbox[p.mailboxMessageId];
      if (!old || old.acknowledged) throw new InvalidTransitionError("mailboxMessage", old ? "acknowledged" : "missing", "acknowledged");
      return { ...next, mailbox: { ...state.mailbox, [p.mailboxMessageId]: { ...old, acknowledged: true, receiptStatus: "acknowledged", eventId: event.id } } };
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
      return { ...next, goals: { ...state.goals, [p.goalId]: { id: p.goalId, description: p.description, completionCriteria: p.completionCriteria ?? null, maxTurns: p.maxTurns ?? null, status: "active", completionRequestId: null, completionWorkspaceId: null, completionWorkspaceCursor: null, completionMaterialVersion: null, completionMaterialEventIds: [], completionPinRecorded: false, gates: {}, eventId: event.id } } };
    }
    case "GoalCompletionRequested": {
      const p = event.payload as EventPayloads["GoalCompletionRequested"]; const old = state.goals[p.goalId];
      if (!old || old.status !== "active") throw new InvalidTransitionError("goal", old?.status ?? "missing", "completion_requested");
      return { ...next, goals: { ...state.goals, [p.goalId]: { ...old, status: "completion_requested", completionRequestId: p.requestId, completionWorkspaceId: p.workspaceId ?? null, completionWorkspaceCursor: p.workspaceCursor ?? null, completionMaterialVersion: p.materialVersion ?? null, completionMaterialEventIds: [...(p.materialEventIds ?? [])], completionPinRecorded: p.materialVersion !== undefined || (p.workspaceId !== undefined && Object.prototype.hasOwnProperty.call(p, "workspaceCursor")), eventId: event.id } } };
    }
    case "GoalGateAdded": {
      const p = event.payload as EventPayloads["GoalGateAdded"]; const goal = state.goals[p.goalId];
      if (!goal || goal.gates[p.gateId] || goal.status !== "active") throw new InvalidTransitionError("goalGate", goal?.status ?? "missing-goal", "pending");
      const gate: GoalGateState = { id: p.gateId, name: p.name, executor: p.executor, operation: p.operation, input: p.input, idempotent: p.idempotent, required: p.required, status: "pending", evaluations: [], eventId: event.id };
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
    case "GoalGateEvaluationRecorded": {
      const p = event.payload as EventPayloads["GoalGateEvaluationRecorded"]; const goal = state.goals[p.goalId]; const old = goal?.gates[p.gateId];
      if (!goal || !old || old.evaluations.some((item) => item.id === p.evaluationId)) throw new InvalidTransitionError("goalGateEvaluation", old ? "duplicate" : "missing", p.status);
      const evaluation = { id: p.evaluationId, requestId: p.requestId, definitionHash: p.definitionHash, materialVersion: p.materialVersion, materialEventIds: [...p.materialEventIds], status: p.status, ...(p.effectId === undefined ? {} : { effectId: p.effectId }), ...(p.output === undefined ? {} : { output: p.output }), ...(p.error === undefined ? {} : { error: p.error }), ...(p.cachedFromEvaluationId === undefined ? {} : { cachedFromEvaluationId: p.cachedFromEvaluationId }), eventId: event.id };
      const { output: _oldOutput, error: _oldError, ...baseGate } = old;
      const gate: GoalGateState = { ...baseGate, status: p.status, currentEvaluationId: p.evaluationId, evaluations: [...old.evaluations, evaluation], eventId: event.id, ...(p.effectId === undefined ? {} : { effectId: p.effectId }), ...(p.output === undefined ? {} : { output: p.output }), ...(p.error === undefined ? {} : { error: p.error }) };
      return { ...next, goals: { ...state.goals, [p.goalId]: { ...goal, gates: { ...goal.gates, [p.gateId]: gate }, eventId: event.id } } };
    }
    case "GoalStatusChanged": {
      const p = event.payload as EventPayloads["GoalStatusChanged"]; const old = state.goals[p.goalId];
      const valid = old && !["completed", "failed", "cancelled"].includes(old.status) &&
        (p.status === "failed" || p.status === "cancelled" ||
          (p.status === "completed" && old.status === "completion_requested") ||
          (p.status === "blocked" && ["completion_requested", "active"].includes(old.status)) ||
          (p.status === "paused" && ["active", "blocked"].includes(old.status)) ||
          (p.status === "active" && ["blocked", "paused"].includes(old.status)) ||
          (p.status === "completion_requested" && old.status === "active"));
      if (!old || !valid) throw new InvalidTransitionError("goal", old?.status ?? "missing", p.status);
      const { reason: _oldReason, ...baseGoal } = old;
      return { ...next, goals: { ...state.goals, [p.goalId]: { ...baseGoal, status: p.status, ...(p.reason === undefined ? {} : { reason: p.reason }), eventId: event.id } } };
    }
    case "HeartbeatCreated": {
      const p = event.payload as EventPayloads["HeartbeatCreated"]; if (state.heartbeats[p.heartbeatId]) throw new InvalidTransitionError("heartbeat", "existing", "active");
      if (p.goalId && !state.goals[p.goalId]) throw new ValidationError("Heartbeat goal does not exist");
      return { ...next, heartbeats: { ...state.heartbeats, [p.heartbeatId]: { id: p.heartbeatId, intervalMs: p.intervalMs, nextTickAt: p.nextTickAt, goalId: p.goalId ?? null, prompt: p.prompt ?? null, ...(p.payload === undefined ? {} : { payload: p.payload }), owner: p.owner ?? "user", status: "active", tick: 0, lastFiredAt: null, eventId: event.id } } };
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
    case "ScheduleCreated": {
      const p = event.payload as EventPayloads["ScheduleCreated"];
      if (state.schedules[p.scheduleId] || (p.kind === "once" && p.intervalMs !== undefined) || (p.kind === "interval" && p.intervalMs === undefined)) throw new InvalidTransitionError("schedule", state.schedules[p.scheduleId] ? "existing" : "invalid-definition", "active");
      return { ...next, schedules: { ...state.schedules, [p.scheduleId]: { id: p.scheduleId, kind: p.kind, prompt: p.prompt, intervalMs: p.intervalMs ?? null, nextTickAt: p.nextTickAt, owner: p.owner, goalMode: p.goalMode, status: "active", tick: 0, lastFiredAt: null, eventId: event.id } } };
    }
    case "ScheduleTicked": {
      const p = event.payload as EventPayloads["ScheduleTicked"]; const old = state.schedules[p.scheduleId];
      if (!old || old.status !== "active" || p.tick !== old.tick + 1) throw new InvalidTransitionError("schedule", old?.status ?? "missing", "ticked");
      return { ...next, schedules: { ...state.schedules, [p.scheduleId]: { ...old, tick: p.tick, lastFiredAt: p.firedAt, nextTickAt: p.nextTickAt ?? old.nextTickAt, status: p.nextTickAt === null ? "completed" : old.status, eventId: event.id } } };
    }
    case "ScheduleStatusChanged": {
      const p = event.payload as EventPayloads["ScheduleStatusChanged"]; const old = state.schedules[p.scheduleId];
      const valid = old && old.status !== "cancelled" && old.status !== "completed" && old.status !== p.status && ((old.status === "active" && ["paused", "cancelled"].includes(p.status)) || (old.status === "paused" && ["active", "cancelled"].includes(p.status)));
      if (!valid) throw new InvalidTransitionError("schedule", old?.status ?? "missing", p.status);
      return { ...next, schedules: { ...state.schedules, [p.scheduleId]: { ...old!, status: p.status, ...(p.nextTickAt === undefined ? {} : { nextTickAt: p.nextTickAt }), ...(p.reason === undefined ? {} : { reason: p.reason }), eventId: event.id } } };
    }
    case "WakeQueued": {
      const p = event.payload as EventPayloads["WakeQueued"];
      if (state.wakes[p.wakeId]) throw new InvalidTransitionError("wake", state.wakes[p.wakeId]!.status, "queued");
      return { ...next, wakes: { ...state.wakes, [p.wakeId]: { id: p.wakeId, sourceType: p.sourceType, sourceId: p.sourceId, tick: p.tick, scheduledAt: p.scheduledAt, firedAt: p.firedAt, prompt: p.prompt, goalId: p.goalId ?? null, goalMode: p.goalMode, status: "queued", claimId: null, claimedAt: null, runId: null, deliveredAt: null, eventId: event.id } } };
    }
    case "WakeClaimed": {
      const p = event.payload as EventPayloads["WakeClaimed"]; const old = state.wakes[p.wakeId];
      if (!old || old.status !== "queued") throw new InvalidTransitionError("wake", old?.status ?? "missing", "claimed");
      return { ...next, wakes: { ...state.wakes, [p.wakeId]: { ...old, status: "claimed", claimId: p.claimId, claimedAt: p.claimedAt, eventId: event.id } } };
    }
    case "WakeDelivered": {
      const p = event.payload as EventPayloads["WakeDelivered"]; const old = state.wakes[p.wakeId];
      if (!old || old.status !== "claimed" || old.claimId !== p.claimId) throw new InvalidTransitionError("wake", old?.status ?? "missing", "delivered");
      return { ...next, wakes: { ...state.wakes, [p.wakeId]: { ...old, status: "delivered", runId: p.runId, deliveredAt: p.deliveredAt, eventId: event.id } } };
    }
    case "WakeDeliveryUnknown": {
      const p = event.payload as EventPayloads["WakeDeliveryUnknown"]; const old = state.wakes[p.wakeId];
      if (!old || old.status !== "claimed" || old.claimId !== p.claimId) throw new InvalidTransitionError("wake", old?.status ?? "missing", "unknown");
      return { ...next, wakes: { ...state.wakes, [p.wakeId]: { ...old, status: "unknown", reason: p.reason, eventId: event.id } } };
    }
    case "RecursiveModelStarted": {
      const p = event.payload as EventPayloads["RecursiveModelStarted"]; if (state.recursiveModels[p.handleId]) throw new InvalidTransitionError("recursiveModel", "existing", "pending");
      const handle: RecursiveModelState = { id: p.handleId, taskId: p.taskId, parentSessionId: p.parentSessionId, parentBranchId: p.parentBranchId, childSessionId: p.childSessionId, childBranchId: p.childBranchId, model: p.model, responseAdmission: p.responseAdmission, inputSetId: p.inputSetId ?? null, ...(p.input === undefined ? {} : { input: p.input }), ...(p.inputProvenance === undefined ? {} : { inputProvenance: p.inputProvenance }), ...(p.inputHash === undefined ? {} : { inputHash: p.inputHash }), status: "pending", eventId: event.id };
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
        id: p.runId, task: p.task, requestKey: p.requestKey, goalId: p.goalId ?? null, goalMode: p.goalMode ?? (p.goalId ? "current" : "none"), wakeId: p.wakeId ?? null, status: "queued",
        steps: [], goalChecks: {}, cancellationRequested: false, requestEventId: event.id, eventId: event.id,
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
      const step: AgentRunStepState = { id: p.stepId, ordinal: p.ordinal, contextId: p.contextId, callId: p.callId, effectId: p.effectId, actionId: p.actionId, observationEventIds: [...p.observationEventIds], modelAttempts: [], eventId: event.id };
      return { ...next, agentRuns: { ...state.agentRuns, [p.runId]: { ...run, status: "running", steps: [...run.steps, step], eventId: event.id } } };
    }
    case "AgentRunModelAttemptStarted": {
      const p = event.payload as EventPayloads["AgentRunModelAttemptStarted"]; const run = state.agentRuns[p.runId]; const step = run?.steps.at(-1);
      const expectedAttempt = (step?.modelAttempts.length ?? 0) + 1;
      const prior = step?.modelAttempts.at(-1);
      if (!run || run.status !== "running" || !step || step.id !== p.stepId || step.ordinal !== p.ordinal || p.attempt !== expectedAttempt ||
          (p.attempt === 1 && (p.callId !== step.callId || p.effectId !== step.effectId)) ||
          (p.attempt > 1 && p.retryOfCallId !== prior?.callId) || step.action !== undefined || step.rejection !== undefined) {
        throw new InvalidTransitionError("agentRunModelAttempt", run?.status ?? "missing-run", "started");
      }
      const attempt = { attempt: p.attempt, contextId: p.contextId, callId: p.callId, effectId: p.effectId, reason: p.reason, estimatedInputTokens: p.estimatedInputTokens, contextWindow: p.contextWindow, ...(p.retryOfCallId === undefined ? {} : { retryOfCallId: p.retryOfCallId }), eventId: event.id };
      const updated = { ...step, modelAttempts: [...step.modelAttempts, attempt], eventId: event.id };
      return { ...next, agentRuns: { ...state.agentRuns, [p.runId]: { ...run, steps: [...run.steps.slice(0, -1), updated], eventId: event.id } } };
    }
    case "AgentRunActionCommitted": {
      const p = event.payload as EventPayloads["AgentRunActionCommitted"];
      const run = state.agentRuns[p.runId];
      const step = run?.steps.at(-1);
      const call = state.modelCalls[p.source.modelCallId];
      const output = call ? completedModelOutput(state, call) : undefined;
      const submission = output?.result.kind === "tool-submission" ? output.result.submission : undefined;
      const expectedAction = submission
        ? agentActionFromToolSubmission({ name: submission.name, input: submission.input } as unknown as Parameters<typeof agentActionFromToolSubmission>[0])
        : undefined;
      if (!run || run.status !== "running" || !step || step.id !== p.stepId || step.ordinal !== p.ordinal || step.actionId !== p.actionId ||
          (step.modelAttempts.at(-1)?.callId ?? step.callId) !== p.source.modelCallId ||
          call?.status !== "succeeded" || step.action !== undefined || step.rejection !== undefined ||
          !submission || output!.resultDigest !== p.source.resultDigest ||
          submission.providerToolCallId !== p.source.providerToolCallId ||
          !expectedAction || !sameAgentAction(expectedAction, p.action)) {
        throw new InvalidTransitionError("agentRunAction", step?.action ? "committed" : run?.status ?? "missing-run", "committed");
      }
      const updated = { ...step, action: p.action, actionSource: p.source, eventId: event.id };
      return { ...next, agentRuns: { ...state.agentRuns, [p.runId]: { ...run, steps: [...run.steps.slice(0, -1), updated], eventId: event.id } } };
    }
    case "AgentRunActionRejected": {
      const p = event.payload as EventPayloads["AgentRunActionRejected"];
      const run = state.agentRuns[p.runId];
      const step = run?.steps.at(-1);
      const call = state.modelCalls[p.source.modelCallId];
      const output = call ? completedModelOutput(state, call) : undefined;
      const violation = output?.result.kind === "contract-violation" ? output.result.violation : undefined;
      const diagnosticCallId = violation?.evidence.toolCalls.find((item) => item.callId !== undefined)?.callId;
      if (!run || run.status !== "running" || !step || step.id !== p.stepId || step.ordinal !== p.ordinal || step.actionId !== p.actionId ||
          (step.modelAttempts.at(-1)?.callId ?? step.callId) !== p.source.modelCallId ||
          call?.status !== "succeeded" || step.action !== undefined || step.rejection !== undefined ||
          !violation || output!.resultDigest !== p.source.resultDigest || p.error !== violation.message ||
          p.source.providerToolCallId !== diagnosticCallId) {
        throw new InvalidTransitionError("agentRunAction", step?.rejection ? "rejected" : run?.status ?? "missing-run", "rejected");
      }
      const updated = { ...step, rejection: p.error, actionSource: p.source, eventId: event.id };
      return { ...next, agentRuns: { ...state.agentRuns, [p.runId]: { ...run, steps: [...run.steps.slice(0, -1), updated], eventId: event.id } } };
    }
    case "AgentRunGoalCheckRecorded": {
      const p = event.payload as EventPayloads["AgentRunGoalCheckRecorded"]; const run = state.agentRuns[p.runId]; const step = run?.steps.at(-1);
      if (!run || run.status !== "running" || !step?.action || step.action.type !== "final" || step.actionId !== p.actionId || run.goalId !== p.goalId || run.goalChecks[p.actionId]) throw new InvalidTransitionError("agentRunGoalCheck", run?.status ?? "missing-run", p.status);
      return { ...next, agentRuns: { ...state.agentRuns, [p.runId]: { ...run, goalChecks: { ...run.goalChecks, [p.actionId]: { actionId: p.actionId, goalId: p.goalId, requestId: p.requestId, status: p.status, summary: p.summary, gateEvaluationEventIds: [...p.gateEvaluationEventIds], eventId: event.id } }, eventId: event.id } } };
    }
    case "AgentRunCancellationRequested": {
      const p = event.payload as EventPayloads["AgentRunCancellationRequested"]; const run = state.agentRuns[p.runId];
      if (!run || ["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status) || run.cancellationRequested) throw new InvalidTransitionError("agentRun", run?.status ?? "missing", "cancellation_requested");
      return { ...next, agentRuns: { ...state.agentRuns, [p.runId]: { ...run, cancellationRequested: true, ...(p.reason === undefined ? {} : { cancellationReason: p.reason }), eventId: event.id } } };
    }
    case "AgentRunStatusChanged": {
      const p = event.payload as EventPayloads["AgentRunStatusChanged"]; const run = state.agentRuns[p.runId];
      const terminal = ["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"];
      const step = run?.steps.at(-1);
      const finalAction = step?.action;
      const acceptedFinish = step?.actionSource?.kind === "tool-submission" &&
        finalAction !== undefined && ["final", "blocked", "failed"].includes(finalAction.type);
      const expectedMessageId = run ? `agent-run-final-${run.id}` : "";
      const matchingMessages = p.finalMessageId === undefined
        ? []
        : state.messages.filter((message) => message.id === p.finalMessageId);
      const finalMessage = matchingMessages[0];
      const expectedContent = finalAction?.type === "final" ? finalAction.content
        : finalAction?.type === "blocked" ? finalAction.reason
        : finalAction?.type === "failed" ? finalAction.error
        : undefined;
      // A retained accepted finish action owns its blocked/failed terminal
      // meaning: a successful finish repairs failed gates or later maps to
      // goal-derived blocked, and blocked/failed finishes carry their exact
      // message. Status-only blocked/failed terminals are runtime-originated
      // and are valid only when no finish action is the retained last action.
      const finalLinkValid = p.finalMessageId === undefined
        ? p.status !== "succeeded" &&
          !(acceptedFinish && (p.status === "blocked" || p.status === "failed"))
        : acceptedFinish &&
          ["succeeded", "blocked", "failed"].includes(p.status) &&
          p.finalMessageId === expectedMessageId &&
          matchingMessages.length === 1 &&
          finalMessage?.role === "assistant" &&
          finalMessage.modelCallId === null &&
          finalMessage.content === expectedContent &&
          finalMessage.eventId === state.appliedEventIds.at(-1);
      const latestCheck = run ? Object.values(run.goalChecks).at(-1) : undefined;
      const unresolvedFailedGate = latestCheck?.status === "failed" &&
        run?.goalId !== null && run?.goalId !== undefined &&
        state.goals[run.goalId]?.status === "active";
      const goalDerivedFailure = latestCheck?.status === "failed" &&
        run?.goalId !== null && run?.goalId !== undefined &&
        state.goals[run.goalId]?.status === "blocked";
      const goalDerivedReason = goalDerivedFailure
        ? `Goal repair stopped after a failed required gate: ${latestCheck.summary}`
        : undefined;
      const finishStatusValid = p.finalMessageId === undefined || (
        finalAction?.type === "final"
          ? p.status === "succeeded" && p.reason === undefined &&
            (run?.goalId === null || run?.goalChecks[step!.actionId]?.status === "passed")
          : finalAction?.type === "blocked"
            ? p.status === "blocked" && p.reason === finalAction.reason
            : finalAction?.type === "failed" && goalDerivedFailure
              ? p.status === "blocked" && p.reason === goalDerivedReason &&
                run?.goalId !== null
              : finalAction?.type === "failed" && !unresolvedFailedGate &&
                p.status === "failed" && p.reason === finalAction.error
      );
      const valid = run && !terminal.includes(run.status) && finalLinkValid && finishStatusValid && (
        (p.status === "cancelled" && run.cancellationRequested) ||
        (p.status !== "cancelled")
      );
      if (!run || !valid) throw new InvalidTransitionError("agentRun", run?.status ?? "missing", p.status);
      return { ...next, agentRuns: { ...state.agentRuns, [p.runId]: { ...run, status: p.status, ...(p.reason === undefined ? {} : { reason: p.reason }), ...(p.finalMessageId === undefined ? {} : { finalMessageId: p.finalMessageId }), eventId: event.id } } };
    }
    // Harness history is canonical and has dedicated rebuildable relational
    // projections. Session projection still advances its cursor so snapshot
    // recovery retains the exact committed boundary.
    case "UserCorrection": {
      const p = event.payload as EventPayloads["UserCorrection"];
      if (state.userCorrections[p.correctionId]) throw new InvalidTransitionError("userCorrection", "existing", "recorded");
      if (new Set(p.correctedEventIds).size !== p.correctedEventIds.length || p.correctedEventIds.some((id) => !state.appliedEventIds.includes(id))) throw new ValidationError("User correction must cite distinct earlier events in this trajectory");
      return { ...next, userCorrections: { ...state.userCorrections, [p.correctionId]: { id: p.correctionId, correctedEventIds: [...p.correctedEventIds], correction: p.correction, eventId: event.id } } };
    }
    case "RefinementReviewRequested": {
      const p = event.payload as EventPayloads["RefinementReviewRequested"];
      if (state.refinementReviews[p.reviewId]) throw new InvalidTransitionError("refinementReview", state.refinementReviews[p.reviewId]!.status, "requested");
      if (p.sourceEventIds.some((id) => !state.appliedEventIds.includes(id)) || p.evidenceEventIds.some((id) => !p.sourceEventIds.includes(id))) throw new ValidationError("Refinement review sources must be earlier visible trajectory events");
      const review = { id: p.reviewId, fingerprint: p.fingerprint, mode: p.mode, requestedScope: p.requestedScope, requestedScopeKey: p.requestedScopeKey, allowedKinds: [...p.allowedKinds], triggerId: p.triggerId, triggerKind: p.triggerKind, triggerFingerprint: p.triggerFingerprint, ...(p.triggerKey === undefined ? {} : { triggerKey: p.triggerKey }), ...(p.nonterminalKey === undefined ? {} : { nonterminalKey: p.nonterminalKey }), ...(p.triggerEvidenceThroughCursor === undefined ? {} : { triggerEvidenceThroughCursor: p.triggerEvidenceThroughCursor }), evidenceEventIds: [...p.evidenceEventIds], sourceEventIds: [...p.sourceEventIds], sourceSnapshotHash: p.sourceSnapshotHash, sourceThroughCursor: p.sourceThroughCursor, ...(p.instructions === undefined ? {} : { instructions: p.instructions }), status: "requested" as const, requestEventId: event.id, eventId: event.id };
      return { ...next, refinementReviews: { ...state.refinementReviews, [p.reviewId]: review } };
    }
    case "RefinementReviewChildLinked": {
      const p = event.payload as EventPayloads["RefinementReviewChildLinked"]; const old = state.refinementReviews[p.reviewId];
      if (!old || old.status !== "requested" || old.handleId !== undefined) throw new InvalidTransitionError("refinementReview", old?.status ?? "missing", "child-linked");
      return { ...next, refinementReviews: { ...state.refinementReviews, [p.reviewId]: { ...old, handleId: p.handleId, childSessionId: p.childSessionId, childBranchId: p.childBranchId, eventId: event.id } } };
    }
    case "RefinementReviewStatusChanged": {
      const p = event.payload as EventPayloads["RefinementReviewStatusChanged"]; const old = state.refinementReviews[p.reviewId];
      const terminal = ["no_change", "candidate", "revision_required", "failed", "cancelled", "unknown"];
      if (!old || old.status !== p.expectedStatus || terminal.includes(old.status) || (p.status === "running" && old.handleId === undefined)) throw new InvalidTransitionError("refinementReview", old?.status ?? "missing", p.status);
      if (p.status === "candidate" && p.proposalId === undefined) throw new ValidationError("Candidate refinement review requires its proposal link");
      return { ...next, refinementReviews: { ...state.refinementReviews, [p.reviewId]: { ...old, status: p.status, ...(p.decisionFingerprint === undefined ? {} : { decisionFingerprint: p.decisionFingerprint }), ...(p.proposalId === undefined ? {} : { proposalId: p.proposalId }), ...(p.reason === undefined ? {} : { reason: p.reason }), eventId: event.id } } };
    }
    case "RefinementTriggerConsumed": {
      const p = event.payload as EventPayloads["RefinementTriggerConsumed"]; const review = state.refinementReviews[p.reviewId];
      if (!review || !["no_change", "candidate", "revision_required", "failed", "cancelled", "unknown"].includes(review.status) || review.triggerKey !== p.triggerKey) throw new InvalidTransitionError("refinementTrigger", review?.status ?? "missing-review", "consumed");
      const old = state.refinementTriggerConsumptions[p.triggerKey];
      if (old && BigInt(p.evidenceThroughCursor) <= BigInt(old.lastConsumedEvidenceCursor)) throw new ValidationError("Refinement trigger consumption cursor must advance");
      return { ...next, refinementTriggerConsumptions: { ...state.refinementTriggerConsumptions, [p.triggerKey]: { triggerKey: p.triggerKey, lastConsumedEvidenceCursor: p.evidenceThroughCursor, reviewId: p.reviewId, eventId: event.id } } };
    }
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
    case "SkillImported":
    case "SkillAvailabilityChanged":
    case "SkillInvocationRecorded":
    case "SkillTestRecorded":
    case "SubagentSpecInvoked":
      return next;
  }
}

function validateModelEffectRelation(
  state: AgentState,
  payload: EventPayloads["EffectRequested"],
): void {
  if (payload.operation !== "complete" || !payload.input || typeof payload.input !== "object" ||
      Array.isArray(payload.input)) {
    throw new ValidationError("Model effects require a complete admitted model input");
  }
  const input = payload.input;
  const callId = typeof input.callId === "string" ? input.callId : undefined;
  const compactionId = typeof input.compactionId === "string" ? input.compactionId : undefined;
  const dispatch = input.modelDispatch;
  if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)) {
    throw new ValidationError("Model effects require a complete immutable model dispatch");
  }
  if ((callId === undefined) === (compactionId === undefined)) {
    throw new ValidationError("Model effects must belong to exactly one admitted call or compaction");
  }
  if (callId !== undefined) {
    const call = state.modelCalls[callId];
    if (!call || call.effectId !== payload.effectId || !Bun.deepEquals(call.modelDispatch, dispatch)) {
      throw new ValidationError("Model effect does not agree with its admitted model call");
    }
    return;
  }
  const compaction = state.compactions[compactionId!];
  if (!compaction || compaction.strategy !== "model-summary-v1" ||
      !compaction.modelDispatch || !Bun.deepEquals(compaction.modelDispatch, dispatch)) {
    throw new ValidationError("Model effect does not agree with its pinned compaction dispatch");
  }
}

function modelDispatchFromEffectInput(input: import("./json.ts").JsonValue): ModelDispatch {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !input.modelDispatch || typeof input.modelDispatch !== "object" || Array.isArray(input.modelDispatch)) {
    throw new ValidationError("Model effect is missing its retained dispatch");
  }
  const dispatch = input.modelDispatch as unknown as ModelDispatch;
  validateModelDispatch(dispatch);
  return dispatch;
}

function completedModelOutput(state: AgentState, call: ModelCallState): ModelEffectOutputV2 {
  const effect = state.effects[call.effectId];
  if (!effect || effect.status !== "succeeded" || effect.output === undefined) {
    throw new ValidationError("Completed model call is missing its authoritative effect output");
  }
  return validateModelEffectOutputV2(effect.output, {
    responseContract: call.modelDispatch.responseContract,
    responseCapability: call.modelDispatch.responseCapability,
    configuredProvider: call.modelDispatch.configuration.provider,
  });
}

function compactModelCallResult(output: ModelEffectOutputV2): ModelCallResult {
  if (output.result.kind === "text") {
    return { kind: "text", textDigest: output.result.textDigest };
  }
  if (output.result.kind === "tool-submission") {
    return {
      kind: "tool-submission",
      providerToolCallId: output.result.submission.providerToolCallId,
      name: output.result.submission.name,
      inputDigest: output.result.submission.inputDigest,
    };
  }
  const providerToolCallId = output.result.violation.evidence.toolCalls
    .find((item) => item.callId !== undefined)?.callId;
  return {
    kind: "contract-violation",
    code: output.result.violation.code,
    evidenceDigest: output.result.violation.evidenceDigest,
    ...(providerToolCallId === undefined ? {} : { providerToolCallId }),
  };
}

function sameAgentAction(left: AgentAction, right: AgentAction): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "typescript" && right.type === "typescript") return left.code === right.code;
  if (left.type === "final" && right.type === "final") return left.content === right.content;
  if (left.type === "blocked" && right.type === "blocked") return left.reason === right.reason;
  if (left.type === "failed" && right.type === "failed") return left.error === right.error;
  return false;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function projectEvents(events: readonly AgentEvent[]): AgentState {
  let state: AgentState | undefined;
  for (const event of events) state = reduceAgentState(state, event);
  if (!state) throw new ValidationError("Cannot project an empty event stream");
  return state;
}

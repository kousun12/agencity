import type {
  AgentRunState,
  AgentState,
  MailboxMessageState,
  TaskState,
} from "../domain/index.ts";
import { boundText, boundedJsonText, serializedUtf8Bytes } from "./bounds.ts";
import { observerRouteKey } from "./discovery.ts";
import {
  OBSERVER_BOUNDS,
  OBSERVER_PROTOCOL,
  type InternalObserverFamily,
  type InternalObserverRouteSnapshot,
  type ObserverDetailItemDto,
  type ObserverDetailPageDto,
  type ObserverDetailSection,
  type ObserverFamilyOverviewDto,
  type ObserverItemProvenance,
  type ObserverMailboxLifecycle,
  type ObserverMailboxLifecycleDto,
  type ObserverRoute,
  type ObserverRouteActivity,
  type ObserverRouteActivityReason,
} from "./types.ts";

function routeEquals(left: ObserverRoute, right: ObserverRoute): boolean {
  return left.sessionId === right.sessionId && left.branchId === right.branchId;
}

function latestRun(state: AgentState): AgentRunState | null {
  const eventOrder = new Map(state.appliedEventIds.map((eventId, index) => [eventId, index]));
  let selected: AgentRunState | null = null;
  let selectedOrder = -1;
  for (const run of Object.values(state.agentRuns)) {
    const order = eventOrder.get(run.eventId) ?? -1;
    if (order > selectedOrder ||
        order === selectedOrder && run.id.localeCompare(selected?.id ?? "") > 0) {
      selected = run;
      selectedOrder = order;
    }
  }
  return selected;
}

export function deriveObserverRouteStatus(
  state: AgentState | null,
  task: Pick<TaskState, "status" | "cancellationRequested"> | null = null,
  taskExpected = task !== null,
): { readonly activity: ObserverRouteActivity; readonly activityReason: ObserverRouteActivityReason } {
  if (!state || taskExpected && !task) {
    return { activity: "unavailable", activityReason: "missing_state" };
  }
  const run = latestRun(state);
  if (task?.cancellationRequested && !["completed", "failed", "cancelled"].includes(task.status) ||
      run?.cancellationRequested && run.status !== "cancelled") {
    return { activity: "attention", activityReason: "cancellation_pending" };
  }
  if (Object.values(state.effects).some((effect) => effect.status === "unknown")) {
    return { activity: "attention", activityReason: "unknown" };
  }
  if (state.budget.exceeded || run?.status === "budget_exceeded") {
    return { activity: "attention", activityReason: "budget_exceeded" };
  }
  if (task?.status === "failed" || state.status === "failed" || run?.status === "failed") {
    return { activity: "attention", activityReason: "failed" };
  }
  if (run?.status === "blocked") return { activity: "attention", activityReason: "blocked" };
  if (run?.status === "unknown") return { activity: "attention", activityReason: "unknown" };
  if (task?.status === "cancelled" || run?.status === "cancelled") {
    return { activity: "ended", activityReason: "cancelled" };
  }
  if (state.status === "archived") return { activity: "ended", activityReason: "archived" };
  if (task?.status === "running" ||
      run && ["queued", "running"].includes(run.status) ||
      state.status === "running") {
    return { activity: "working", activityReason: null };
  }
  return { activity: "idle", activityReason: null };
}

function lifecycleStages(records: readonly MailboxMessageState[]): ObserverMailboxLifecycle[] {
  const stages = new Set<ObserverMailboxLifecycle>();
  if (records.some((record) => record.direction === "outbound")) stages.add("sent");
  if (records.some((record) => record.direction === "inbound" || record.delivered)) stages.add("delivered");
  if (records.some((record) => record.deliveredToContext || record.receiptStatus === "delivered_to_context")) {
    stages.add("delivered_to_context");
  }
  if (records.some((record) => record.acknowledged || record.receiptStatus === "acknowledged")) {
    stages.add("acknowledged");
  }
  if (records.some((record) => record.receiptStatus === "failed" || record.receiptStatus === "rejected")) {
    stages.add("failed");
  }
  return ["sent", "delivered", "delivered_to_context", "acknowledged", "failed"]
    .filter((stage): stage is ObserverMailboxLifecycle => stages.has(stage as ObserverMailboxLifecycle));
}

function sameMailboxMeaning(left: MailboxMessageState, right: MailboxMessageState): boolean {
  return left.fromSessionId === right.fromSessionId &&
    left.fromBranchId === right.fromBranchId &&
    left.toSessionId === right.toSessionId &&
    left.toBranchId === right.toBranchId &&
    left.kind === right.kind &&
    left.taskId === right.taskId &&
    left.content === right.content;
}

function exactRouteMailboxRecords(
  snapshot: InternalObserverRouteSnapshot,
): MailboxMessageState[] {
  if (!snapshot.state) return [];
  return Object.values(snapshot.state.mailbox).filter((record) =>
    record.fromSessionId === snapshot.route.sessionId &&
      record.fromBranchId === snapshot.route.branchId ||
    record.toSessionId === snapshot.route.sessionId &&
      record.toBranchId === snapshot.route.branchId,
  );
}

export function aggregateObserverMailbox(
  family: InternalObserverFamily,
): ObserverMailboxLifecycleDto[] {
  const records = new Map<string, MailboxMessageState[]>();
  for (const snapshot of family.routes.values()) {
    for (const record of exactRouteMailboxRecords(snapshot)) {
      const fromKey = observerRouteKey({
        sessionId: record.fromSessionId,
        branchId: record.fromBranchId,
      });
      const toKey = observerRouteKey({
        sessionId: record.toSessionId,
        branchId: record.toBranchId,
      });
      if (!family.routes.has(fromKey) || !family.routes.has(toKey)) continue;
      const grouped = records.get(record.id) ?? [];
      grouped.push(record);
      records.set(record.id, grouped);
    }
  }
  return [...records.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([mailboxMessageId, grouped]) => {
      const first = grouped[0]!;
      const stages = lifecycleStages(grouped);
      const lifecycle = stages.includes("failed")
        ? "failed"
        : stages.includes("acknowledged")
          ? "acknowledged"
          : stages.includes("delivered_to_context")
            ? "delivered_to_context"
            : stages.includes("delivered")
              ? "delivered"
              : "sent";
      return {
        mailboxMessageId,
        from: { sessionId: first.fromSessionId, branchId: first.fromBranchId },
        to: { sessionId: first.toSessionId, branchId: first.toBranchId },
        taskId: first.taskId,
        kind: first.kind,
        lifecycle,
        stages,
        conflict: grouped.some((record) => !sameMailboxMeaning(first, record)),
        itemEventIds: [...new Set(grouped.map((record) => record.eventId))].slice(0, 8),
        itemEventIdsTruncated: new Set(grouped.map((record) => record.eventId)).size > 8,
        omittedItemEventIdCount: Math.max(
          0,
          new Set(grouped.map((record) => record.eventId)).size - 8,
        ),
      };
    });
}

function routeCursorKey(route: ObserverRoute): string {
  return JSON.stringify([route.sessionId, route.branchId]);
}

export function deriveObserverFamilyOverview(
  family: InternalObserverFamily,
): ObserverFamilyOverviewDto {
  const edgeByChild = new Map(family.edges.map((edge) => [observerRouteKey(edge.child), edge]));
  let nodes: ObserverFamilyOverviewDto["nodes"][number][] = [...family.routes.values()].map((snapshot) => {
    const state = snapshot.state;
    const edge = edgeByChild.get(observerRouteKey(snapshot.route));
    const parentState = edge ? family.routes.get(observerRouteKey(edge.parent))?.state : null;
    const task = edge && parentState?.tasks[edge.taskId] || null;
    const status = deriveObserverRouteStatus(state, task, edge !== undefined);
    const run = state ? latestRun(state) : null;
    const latestStep = run
      ? [...run.steps].sort((left, right) => right.ordinal - left.ordinal)[0] ?? null
      : null;
    return {
      route: snapshot.route,
      depth: state?.depth ?? (edge && parentState ? parentState.depth + 1 : null),
      availability: snapshot.availability,
      unavailableReason: snapshot.unavailableReason,
      sessionName: state?.sessionName
        ? boundText(state.sessionName, { maximumBytes: OBSERVER_BOUNDS.shortTextBytes })
        : null,
      branchName: state?.branch.name
        ? boundText(state.branch.name, { maximumBytes: OBSERVER_BOUNDS.shortTextBytes })
        : null,
      model: state
        ? {
            provider: boundText(state.model.provider, { maximumBytes: OBSERVER_BOUNDS.shortTextBytes }),
            model: boundText(state.model.model, { maximumBytes: OBSERVER_BOUNDS.shortTextBytes }),
          }
        : null,
      taskId: edge?.taskId ?? state?.taskId ?? null,
      taskSummary: edge
        ? boundText(edge.taskSummary, { maximumBytes: OBSERVER_BOUNDS.shortTextBytes })
        : null,
      sessionStatus: state?.status ?? null,
      ...status,
      latestRun: run ? {
        id: run.id,
        task: boundText(run.task, { maximumBytes: OBSERVER_BOUNDS.shortTextBytes }),
        status: run.status,
        stepCount: run.steps.length,
        currentAction: ["queued", "running"].includes(run.status)
          ? latestStep?.action?.type ?? "awaiting_model" as const
          : null,
        reason: run.reason
          ? boundText(run.reason, { maximumBytes: OBSERVER_BOUNDS.shortTextBytes })
          : null,
        deadline: run.deadline ?? null,
      } : null,
      budget: state ? {
        tokens: state.budget.tokens,
        costUsd: state.budget.costUsd,
        turns: state.budget.turns,
        wallTimeMs: state.budget.wallTimeMs,
        exceeded: state.budget.exceeded,
      } : null,
      snapshotCursor: snapshot.cursor,
    };
  });
  let delegationEdges = family.edges.slice(0, OBSERVER_BOUNDS.familyEdges).map((edge) => ({
    taskId: edge.taskId,
    parent: edge.parent,
    child: edge.child,
    taskSummary: boundText(edge.taskSummary, { maximumBytes: OBSERVER_BOUNDS.shortTextBytes }),
    taskStatus: edge.taskStatus,
    cancellationRequested: edge.cancellationRequested,
    provenance: {
      itemEventId: edge.eventId,
      snapshotCursor: edge.snapshotCursor,
      exactEventCursor: null,
    },
  }));
  const allMailboxEdges = aggregateObserverMailbox(family);
  let mailboxEdges = allMailboxEdges.slice(0, OBSERVER_BOUNDS.familyMessages);
  const routeCursors = Object.fromEntries(
    [...family.routes.values()]
      .filter((snapshot): snapshot is InternalObserverRouteSnapshot & { cursor: string } => snapshot.cursor !== null)
      .map((snapshot) => [routeCursorKey(snapshot.route), snapshot.cursor]),
  );
  let graphEdgesTruncated = family.edgesTruncated || family.edges.length > delegationEdges.length;
  let mailboxEdgesTruncated = allMailboxEdges.length > mailboxEdges.length;
  let byteLimit = false;

  const build = (): ObserverFamilyOverviewDto => ({
    version: OBSERVER_PROTOCOL,
    root: family.root,
    nodes,
    delegationEdges,
    mailboxEdges,
    routeCursors,
    truncation: {
      familyRoutes: family.truncated,
      graphEdges: graphEdgesTruncated,
      mailboxEdges: mailboxEdgesTruncated,
      byteLimit,
      exactOmittedRouteCount: null,
    },
  });
  while (serializedUtf8Bytes(build()) > OBSERVER_BOUNDS.familySnapshotBytes &&
         (mailboxEdges.length > 0 || delegationEdges.length > 0)) {
    byteLimit = true;
    if (mailboxEdges.length > 0) {
      mailboxEdges = mailboxEdges.slice(0, -1);
      mailboxEdgesTruncated = true;
    } else {
      delegationEdges = delegationEdges.slice(0, -1);
      graphEdgesTruncated = true;
    }
  }
  if (serializedUtf8Bytes(build()) > OBSERVER_BOUNDS.familySnapshotBytes) {
    byteLimit = true;
    nodes = nodes.map((node) => ({
      ...node,
      taskSummary: null,
      latestRun: node.latestRun ? {
        ...node.latestRun,
        task: null,
        reason: null,
      } : null,
    }));
  }
  if (serializedUtf8Bytes(build()) > OBSERVER_BOUNDS.familySnapshotBytes) {
    nodes = nodes.map((node) => ({
      ...node,
      sessionName: null,
      branchName: null,
      model: null,
    }));
  }
  if (serializedUtf8Bytes(build()) > OBSERVER_BOUNDS.familySnapshotBytes) {
    nodes = nodes.map((node) => ({
      ...node,
      latestRun: null,
      budget: null,
    }));
  }
  return build();
}

function provenance(
  snapshotCursor: string,
  itemEventId: string | null,
  exactEventCursor: string | null = null,
): ObserverItemProvenance {
  return { itemEventId, snapshotCursor, exactEventCursor };
}

function eventOrder(state: AgentState): ReadonlyMap<string, number> {
  return new Map(state.appliedEventIds.map((eventId, index) => [eventId, index]));
}

function newestFirst<T extends { readonly id: string; readonly eventId: string }>(
  state: AgentState,
  values: readonly T[],
): T[] {
  const order = eventOrder(state);
  return [...values].sort((left, right) =>
    (order.get(right.eventId) ?? -1) - (order.get(left.eventId) ?? -1) ||
    right.id.localeCompare(left.id),
  );
}

function item(
  kind: ObserverDetailItemDto["kind"],
  id: string,
  itemProvenance: ObserverItemProvenance,
  data: Readonly<Record<string, unknown>>,
): ObserverDetailItemDto {
  return { kind, id, provenance: itemProvenance, data };
}

function detailItems(
  snapshot: InternalObserverRouteSnapshot,
  section: ObserverDetailSection,
): ObserverDetailItemDto[] {
  const state = snapshot.state;
  const cursor = snapshot.cursor;
  if (!state || cursor === null) return [];
  switch (section) {
    case "identity": {
      const profile = state.agentProfiles[state.activeAgentProfileVersionId];
      return [item("identity", state.sessionId, provenance(cursor, null), {
        sessionId: state.sessionId,
        workspaceId: state.workspaceId,
        sessionName: state.sessionName === undefined || state.sessionName === null
          ? null
          : boundText(state.sessionName),
        branch: {
          id: state.branch.id,
          name: state.branch.name === null ? null : boundText(state.branch.name),
          parentBranchId: state.branch.parentBranchId,
          forkCursor: state.branch.forkCursor,
        },
        parent: state.parentSessionId === null ? null : {
          sessionId: state.parentSessionId,
          branchId: state.parentBranchId,
        },
        rootSessionId: state.rootSessionId,
        depth: state.depth,
        taskId: state.taskId,
        model: state.model,
        status: state.status,
        activeProfile: profile ? {
          profileVersionId: profile.profileVersionId,
          revision: profile.revision,
          role: boundText(profile.role),
          purpose: boundText(profile.purpose),
          instructions: boundText(profile.instructions, { mode: "head_tail" }),
          promptDigest: profile.promptDigest,
        } : null,
      })];
    }
    case "runs":
      return newestFirst(state, Object.values(state.agentRuns)).map((run) =>
        item("runs", run.id, provenance(cursor, run.eventId), {
          task: boundText(run.task, { mode: "head_tail" }),
          status: run.status,
          goalId: run.goalId,
          goalMode: run.goalMode,
          cancellationRequested: run.cancellationRequested,
          cancellationReason: run.cancellationReason ? boundText(run.cancellationReason) : null,
          reason: run.reason ? boundText(run.reason) : null,
          stepCount: run.steps.length,
          deadline: run.deadline ?? null,
          result: run.result ? {
            kind: run.result.kind,
            value: boundedJsonText(run.result.value),
            valueDigest: run.result.valueDigest,
            resultBytes: run.result.resultBytes,
            finishEventId: run.result.finishEventId,
          } : null,
        }),
      );
    case "model_attempts": {
      const attempts: ObserverDetailItemDto[] = [];
      for (const run of newestFirst(state, Object.values(state.agentRuns))) {
        for (const step of [...run.steps].sort((left, right) => right.ordinal - left.ordinal)) {
          for (const attempt of [...step.modelAttempts].sort((left, right) => right.attempt - left.attempt)) {
            const call = state.modelCalls[attempt.callId];
            attempts.push(item("model_attempts", `${run.id}:${step.id}:${attempt.attempt}`, provenance(cursor, attempt.eventId), {
              runId: run.id,
              stepId: step.id,
              ordinal: step.ordinal,
              attempt: attempt.attempt,
              reason: attempt.reason,
              callId: attempt.callId,
              effectId: attempt.effectId,
              contextId: attempt.contextId,
              estimatedInputTokens: attempt.estimatedInputTokens,
              providerInputVersion: attempt.providerInputVersion,
              providerInputDigest: attempt.providerInputDigest,
              contextWindow: attempt.contextWindow,
              replNamespace: attempt.replNamespace ?? null,
              retryOfCallId: attempt.retryOfCallId ?? null,
              model: call ? {
                provider: call.modelDispatch.configuration.provider,
                model: call.modelDispatch.configuration.model,
                status: call.status,
                usage: call.usage ?? null,
                usageSource: call.usageSource ?? null,
                termination: call.termination ?? null,
                failureCode: call.failureCode ?? null,
                error: call.error ? boundText(call.error, { mode: "head_tail" }) : null,
              } : null,
            }));
          }
        }
      }
      return attempts;
    }
    case "cells":
      return newestFirst(state, Object.values(state.cells)).map((cell) =>
        item("cells", cell.id, provenance(cursor, cell.eventId), {
          status: cell.status,
          attempts: cell.attempts,
          source: boundText(cell.code, { mode: "head_tail" }),
          logs: boundText(cell.logs.join("\n"), { mode: "head_tail" }),
          logStreams: cell.logStreams,
          result: cell.result === undefined ? null : boundedJsonText(cell.result),
          error: cell.error ? boundText(cell.error, { mode: "head_tail" }) : null,
          causalEffectOutcomeEventIds: cell.causalEffectOutcomeEventIds ?? null,
        }),
      );
    case "effects":
      return newestFirst(state, Object.values(state.effects)).map((effect) =>
        item("effects", effect.id, provenance(cursor, effect.eventId), {
          executor: effect.executor,
          operation: effect.operation,
          origin: effect.origin,
          idempotencyKey: effect.idempotencyKey,
          idempotent: effect.idempotent,
          attempts: effect.attempts,
          status: effect.status,
          input: boundedJsonText(effect.input),
          output: effect.output === undefined ? null : boundedJsonText(effect.output),
          error: effect.error ? boundText(effect.error, { mode: "head_tail" }) : null,
          modelFailure: effect.modelFailure ?? null,
          uncertain: effect.status === "unknown",
        }),
      );
    case "tasks":
      return newestFirst(state, Object.values(state.tasks)).map((task) =>
        item("tasks", task.id, provenance(cursor, task.eventId), {
          parent: { sessionId: task.parentSessionId, branchId: task.parentBranchId },
          child: { sessionId: task.childSessionId, branchId: task.childBranchId },
          task: boundText(task.task, { mode: "head_tail" }),
          completionCriteria: task.completionCriteria
            ? boundText(task.completionCriteria, { mode: "head_tail" })
            : null,
          model: task.model,
          budget: task.budget,
          status: task.status,
          cancellationRequested: task.cancellationRequested,
          result: task.result === undefined ? null : boundedJsonText(task.result),
          artifactIds: task.artifactIds,
          error: task.error ? boundText(task.error) : null,
          reason: task.reason ? boundText(task.reason) : null,
        }),
      );
    case "mailbox":
      return newestFirst(state, exactRouteMailboxRecords(snapshot)).map((message) =>
        item("mailbox", message.id, provenance(cursor, message.eventId), {
          from: { sessionId: message.fromSessionId, branchId: message.fromBranchId },
          to: { sessionId: message.toSessionId, branchId: message.toBranchId },
          kind: message.kind,
          content: boundText(message.content, { mode: "head_tail" }),
          taskId: message.taskId,
          artifactIds: message.artifactIds,
          direction: message.direction,
          intentKey: message.intentKey,
          mode: message.mode,
          replyToMessageId: message.replyToMessageId,
          senderRelationship: message.senderRelationship,
          receiptStatus: message.receiptStatus,
          delivered: message.delivered,
          deliveredToContext: message.deliveredToContext,
          acknowledged: message.acknowledged,
          contextRunId: message.contextRunId,
          error: message.error ? boundText(message.error) : null,
        }),
      );
    case "budget":
      return [item("budget", "budget", provenance(cursor, null), {
        limits: state.budget.limits,
        tokens: state.budget.tokens,
        costUsd: state.budget.costUsd,
        turns: state.budget.turns,
        wallTimeMs: state.budget.wallTimeMs,
        exceeded: state.budget.exceeded,
      })];
    case "goals":
      return newestFirst(state, Object.values(state.goals)).map((goal) =>
        item("goals", goal.id, provenance(cursor, goal.eventId), {
          description: boundText(goal.description, { mode: "head_tail" }),
          completionCriteria: goal.completionCriteria
            ? boundText(goal.completionCriteria, { mode: "head_tail" })
            : null,
          maxTurns: goal.maxTurns,
          status: goal.status,
          completionRequestId: goal.completionRequestId,
          reason: goal.reason ? boundText(goal.reason) : null,
          gateCount: Object.keys(goal.gates).length,
        }),
      );
    case "gates": {
      const gates: ObserverDetailItemDto[] = [];
      for (const goal of newestFirst(state, Object.values(state.goals))) {
        for (const gate of newestFirst(state, Object.values(goal.gates))) {
          gates.push(item("gates", `${goal.id}:${gate.id}`, provenance(cursor, gate.eventId), {
            goalId: goal.id,
            name: boundText(gate.name),
            executor: gate.executor,
            operation: gate.operation,
            input: boundedJsonText(gate.input),
            idempotent: gate.idempotent,
            required: gate.required,
            status: gate.status,
            effectId: gate.effectId ?? null,
            output: gate.output === undefined ? null : boundedJsonText(gate.output),
            error: gate.error ? boundText(gate.error) : null,
            currentEvaluationId: gate.currentEvaluationId ?? null,
            evaluations: gate.evaluations.slice(-10).map((evaluation) => ({
              id: evaluation.id,
              status: evaluation.status,
              eventId: evaluation.eventId,
              cachedFromEvaluationId: evaluation.cachedFromEvaluationId ?? null,
            })),
            evaluationTruncation: {
              truncated: gate.evaluations.length > 10,
              omittedCount: Math.max(0, gate.evaluations.length - 10),
            },
          }));
        }
      }
      return gates;
    }
    case "artifacts":
      return Object.values(state.artifacts)
        .sort((left, right) => left.artifactId.localeCompare(right.artifactId))
        .map((artifact) => item("artifacts", artifact.artifactId, provenance(cursor, null), {
          digest: artifact.digest,
          mediaType: boundText(artifact.mediaType, { maximumBytes: OBSERVER_BOUNDS.shortTextBytes }),
          size: artifact.size,
          bytesAvailable: false,
        }));
    case "terminal_outcomes": {
      const outcomes: ObserverDetailItemDto[] = [];
      for (const run of newestFirst(state, Object.values(state.agentRuns))) {
        if (["queued", "running"].includes(run.status)) continue;
        const finish = [...run.steps].reverse().find((step) => step.typedFinish)?.typedFinish;
        outcomes.push(item("terminal_run", run.id, provenance(cursor, run.eventId), {
          status: run.status,
          reason: run.reason ? boundText(run.reason) : null,
          finish: finish ? boundedJsonText(finish) : null,
          finalMessageId: run.finalMessageId ?? null,
        }));
      }
      for (const notice of newestFirst(state, Object.values(state.terminalNotices))) {
        outcomes.push(item("terminal_notice", notice.id, provenance(cursor, notice.eventId), {
          taskId: notice.taskId,
          parentSessionId: notice.parentSessionId,
          childSessionId: notice.childSessionId,
          status: notice.status,
          direction: notice.direction,
          delivered: notice.delivered,
          result: notice.result === undefined ? null : boundedJsonText(notice.result),
          artifactIds: notice.artifactIds,
          error: notice.error ? boundText(notice.error) : null,
          reason: notice.reason ? boundText(notice.reason) : null,
        }));
      }
      for (const task of newestFirst(state, Object.values(state.tasks))) {
        if (!["completed", "failed", "cancelled"].includes(task.status)) continue;
        outcomes.push(item("terminal_task", task.id, provenance(cursor, task.eventId), {
          status: task.status,
          child: { sessionId: task.childSessionId, branchId: task.childBranchId },
          result: task.result === undefined ? null : boundedJsonText(task.result),
          artifactIds: task.artifactIds,
          error: task.error ? boundText(task.error) : null,
          reason: task.reason ? boundText(task.reason) : null,
        }));
      }
      return outcomes;
    }
  }
}

function encodePageCursor(
  section: ObserverDetailSection,
  snapshotCursor: string,
  offset: number,
): string {
  return Buffer.from(JSON.stringify({ v: 1, section, snapshotCursor, offset }), "utf8").toString("base64url");
}

function decodePageCursor(
  cursor: string | null | undefined,
  section: ObserverDetailSection,
  snapshotCursor: string,
): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (value.v !== 1 || value.section !== section || value.snapshotCursor !== snapshotCursor ||
        typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0) {
      throw new Error("invalid cursor");
    }
    return value.offset;
  } catch {
    throw new Error("Invalid observer detail pagination cursor");
  }
}

export function deriveObserverDetailPage(
  snapshot: InternalObserverRouteSnapshot,
  section: ObserverDetailSection,
  options: {
    readonly limit?: number;
    readonly cursor?: string | null;
    readonly itemId?: string | null;
  } = {},
): ObserverDetailPageDto {
  if (!snapshot.state || snapshot.cursor === null) {
    throw new Error("Observer route is unavailable");
  }
  const limit = Math.max(1, Math.min(
    OBSERVER_BOUNDS.detailItems,
    Math.floor(options.limit ?? OBSERVER_BOUNDS.detailItems),
  ));
  const offset = decodePageCursor(options.cursor, section, snapshot.cursor);
  const allItems = detailItems(snapshot, section);
  const all = options.itemId
    ? allItems.filter(value => value.id === options.itemId)
    : allItems;
  const selected: ObserverDetailItemDto[] = [];
  let byteLimit = false;
  for (let index = offset; index < all.length && selected.length < limit; index += 1) {
    const candidate = [...selected, all[index]!];
    const probe = {
      version: OBSERVER_PROTOCOL,
      route: snapshot.route,
      section,
      snapshotCursor: snapshot.cursor,
      items: candidate,
    };
    if (serializedUtf8Bytes(probe) > OBSERVER_BOUNDS.detailPageBytes - 1_024) {
      byteLimit = true;
      if (selected.length === 0) {
        const oversized = all[index]!;
        selected.push(item(
          oversized.kind,
          oversized.id,
          oversized.provenance,
          {
            omitted: true,
            reason: "item_exceeded_page_byte_limit",
            originalItemUtf8Bytes: serializedUtf8Bytes(oversized),
          },
        ));
      }
      break;
    }
    selected.push(all[index]!);
  }
  const consumed = offset + selected.length;
  const hasMore = consumed < all.length;
  const nextCursor = hasMore ? encodePageCursor(section, snapshot.cursor, consumed) : null;
  const page: ObserverDetailPageDto = {
    version: OBSERVER_PROTOCOL,
    route: snapshot.route,
    section,
    snapshotCursor: snapshot.cursor,
    items: selected,
    pagination: {
      cursor: options.cursor ?? null,
      nextCursor,
      limit,
    },
    truncation: {
      itemLimit: hasMore && !byteLimit,
      byteLimit,
    },
  };
  if (serializedUtf8Bytes(page) > OBSERVER_BOUNDS.detailPageBytes) {
    throw new Error("Observer detail page exceeded its byte bound");
  }
  return page;
}

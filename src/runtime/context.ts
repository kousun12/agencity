import {
  newId,
  NotFoundError,
  projectEvents,
  type AgentEvent,
  type ContextRecordReference,
  type EventType,
} from "../domain/index.ts";
import type { JsonValue } from "../domain/json.ts";
import type { AgentStorage } from "../storage/index.ts";

export const BASE_POLICY = "You are a durable coding agent running in trusted local mode. Use the TypeScript console and typed SDK for mutation. SQL is read-only. Persist every value needed after a cell boundary. Never infer success for an unknown external effect. The worker is process-isolated, not a security sandbox.";

function hash(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

export class ContextMaterializer {
  constructor(readonly storage: AgentStorage, readonly maxRecentRecords = 30) {}

  async materialize(
    sessionId: string,
    branchId: string,
  ): Promise<{ contextId: string; context: JsonValue; event: AgentEvent<"ContextMaterialized"> }> {
    const events = await this.storage.loadEvents(sessionId, { branchId });
    if (!events.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const state = projectEvents(events);
    const messages = state.messages.slice(-20);
    const selected = new Map<string, { event: AgentEvent; reason: string }>();
    const add = (event: AgentEvent | undefined, reason: string) => {
      if (event) selected.set(event.id, { event, reason });
    };

    add(events.find((event) => event.type === "SessionCreated"), "session model, workspace, and budget policy");
    add([...events].reverse().find((event) => event.type === "BranchCreated"), "active branch ancestry");
    add([...events].reverse().find((event) => event.type === "SessionStatusChanged"), "current session status");
    for (const message of messages) add(events.find((event) => event.id === message.eventId), "recent conversation");
    for (const value of Object.values(state.workingValues)) {
      add(events.find((event) => event.id === value.eventId), "active working value");
    }
    for (const artifact of Object.values(state.artifacts)) {
      add([...events].reverse().find(
        (event) => event.type === "ArtifactRegistered" &&
          (event.payload as { artifactId?: string }).artifactId === artifact.artifactId,
      ), "active artifact reference");
    }
    for (const event of events) {
      if (event.type === "BudgetDebited" || event.type === "TaskUsageAttributed" || event.type === "BudgetExceeded") add(event, "current budget projection");
    }
    for (const task of Object.values(state.tasks)) add(events.find((event) => event.id === task.eventId), "current child task");
    for (const message of Object.values(state.mailbox)) add(events.find((event) => event.id === message.eventId), "session mailbox");
    for (const notice of Object.values(state.terminalNotices)) add(events.find((event) => event.id === notice.eventId), "child terminal notice");
    for (const goal of Object.values(state.goals)) add(events.find((event) => event.id === goal.eventId), "current autonomous goal");
    for (const heartbeat of Object.values(state.heartbeats)) add(events.find((event) => event.id === heartbeat.eventId), "scheduled heartbeat");
    for (const handle of Object.values(state.recursiveModels)) add(events.find((event) => event.id === handle.eventId), "recursive model handle");
    const activity = events.filter(
      (event) => event.type === "EffectOutcomeRecorded" || event.type === "CellCommitted" || event.type === "CellFailed" || event.type === "TaskStatusChanged" || event.type === "GoalGateStatusChanged",
    ).slice(-this.maxRecentRecords);
    for (const event of activity) add(event, "recent durable activity");

    const ordered = [...selected.values()].sort((left, right) => BigInt(left.event.cursor) < BigInt(right.event.cursor) ? -1 : 1);
    const references: ContextRecordReference[] = ordered.map(({ event, reason }) => ({
      eventId: event.id,
      type: event.type as EventType,
      schemaVersion: event.schemaVersion,
      reason,
    }));
    const context: JsonValue = JSON.parse(JSON.stringify({
      basePolicy: BASE_POLICY,
      runtime: { mode: "trusted-local", workerIsSecuritySandbox: false },
      session: { id: sessionId, branchId, status: state.status, model: state.model, parentSessionId: state.parentSessionId, parentBranchId: state.parentBranchId, rootSessionId: state.rootSessionId, depth: state.depth, taskId: state.taskId },
      budget: state.budget,
      goal: Object.values(state.goals).find((goal) => !["completed", "failed", "cancelled"].includes(goal.status)) ?? null,
      tasks: Object.values(state.tasks),
      mailbox: Object.values(state.mailbox),
      terminalNotices: Object.values(state.terminalNotices),
      recursiveModels: Object.values(state.recursiveModels),
      documents: Object.values(state.documents).map((document) => ({ id: document.id, name: document.name, mediaType: document.mediaType, size: document.size, digest: document.digest, chunkCount: document.chunkCount })),
      inputSets: Object.values(state.inputSets),
      heartbeats: Object.values(state.heartbeats),
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
        eventId: message.eventId,
      })),
      workingValues: Object.values(state.workingValues).map((value) => ({
        name: value.name,
        version: value.version,
        value: value.value,
        eventId: value.eventId,
      })),
      artifacts: Object.values(state.artifacts),
      recentActivity: activity.map((event) => ({
        eventId: event.id,
        type: event.type,
        payload: event.payload,
      })),
      queryHints: {
        history: "SELECT type, committed_at, payload_json FROM events WHERE session_id = ? ORDER BY sequence",
        largeRecords: "Resolve artifact references through sdk.artifacts.get",
        documents: "SELECT chunk_id, ordinal, content FROM document_chunks WHERE document_id = ? ORDER BY ordinal",
        mailbox: "SELECT * FROM mailbox_messages WHERE to_session_id = ? ORDER BY sent_at",
      },
    })) as JsonValue;
    const serialized = JSON.stringify(context);
    const contextId = newId();
    const [event] = await this.storage.appendEvents([{
      sessionId,
      branchId,
      type: "ContextMaterialized",
      producer: "supervisor",
      idempotencyKey: `context:${contextId}`,
      payload: { contextId, records: references, contentHash: hash(serialized), context },
    }]);
    if (!event) throw new Error("Context was not committed");
    return { contextId, context, event: event as AgentEvent<"ContextMaterialized"> };
  }
}

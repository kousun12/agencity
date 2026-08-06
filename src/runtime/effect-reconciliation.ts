import {
  canonicalJson, ConflictError, newId, NotFoundError, projectEvents, ValidationError,
  type AgentEvent, type AgentState, type JsonValue,
} from "../domain/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import { containsBrokeredSecret, scrubJson, scrubText } from "../security/index.ts";

export type EffectReconciliationAssessment = "succeeded" | "failed" | "no_effect" | "still_unknown";

export interface RecordEffectReconciliationInput {
  readonly assessment: EffectReconciliationAssessment;
  /** Human/operator account, never inferred from the assessment. */
  readonly recordedBy: string;
  readonly summary: string;
  readonly evidence?: JsonValue;
  /** Stable identity for retried protocol submissions. */
  readonly reconciliationId?: string;
}

export interface EffectReconciliationView {
  readonly reconciliationId: string;
  readonly effectId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly effect: AgentState["effects"][string];
  readonly assessment: EffectReconciliationAssessment;
  readonly summary: string;
  readonly evidence?: JsonValue;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly eventId: string;
  readonly cursor: string;
  /** Assessments are evidence only; this is always unknown. */
  readonly durableEffectStatus: "unknown";
  readonly retried: false;
}

export interface UnknownEffectView {
  readonly sessionId: string;
  readonly branchId: string;
  readonly effect: AgentState["effects"][string];
  readonly assessments: readonly EffectReconciliationView[];
  readonly requiresOperatorAssessment: boolean;
  readonly safeActions: readonly ["record-assessment", "start-successor-run"];
  readonly retryAllowed: false;
}

export interface RecoverySummaryView {
  readonly cursor: string;
  readonly recovered: boolean;
  readonly pendingEffectIds: readonly string[];
  readonly unknownEffects: readonly UnknownEffectView[];
  readonly activeRunIds: readonly string[];
  readonly cancellationRequestedRunIds: readonly string[];
  readonly activeChildTaskIds: readonly string[];
  readonly attentionGoalGateIds: readonly string[];
  readonly terminalChildNoticeIds: readonly string[];
}

/**
 * Operator reconciliation is an append-only evidence trail. It deliberately
 * cannot update an outbox row, replace EffectOutcomeRecorded, or execute work.
 */
export class EffectReconciliationService {
  constructor(readonly storage: AgentStorage) {}

  async listUnknown(sessionId: string, branchId: string): Promise<UnknownEffectView[]> {
    const { events, state } = await this.#load(sessionId, branchId);
    return Object.values(state.effects)
      .filter((effect) => effect.status === "unknown")
      .map((effect) => this.#unknownView(sessionId, branchId, effect, events, state));
  }

  async inspect(sessionId: string, branchId: string, effectId: string): Promise<UnknownEffectView> {
    const { events, state } = await this.#load(sessionId, branchId);
    const effect = state.effects[effectId];
    if (!effect) throw new NotFoundError("effect", effectId);
    if (effect.status !== "unknown") throw new ValidationError(`Effect ${effectId} is ${effect.status}; only unknown effects can be reconciled`);
    return this.#unknownView(sessionId, branchId, effect, events, state);
  }

  async record(
    sessionId: string,
    branchId: string,
    effectId: string,
    input: RecordEffectReconciliationInput,
  ): Promise<EffectReconciliationView> {
    if (!input.recordedBy?.trim() || input.recordedBy.trim() !== input.recordedBy) {
      throw new ValidationError("Reconciliation recordedBy must be a non-empty unpadded identity");
    }
    const summary = scrubText(input.summary ?? "").trim();
    if (!summary || summary.length > 16_384) throw new ValidationError("Reconciliation summary must contain 1 to 16384 characters");
    if (!( ["succeeded", "failed", "no_effect", "still_unknown"] as const).includes(input.assessment)) {
      throw new ValidationError("Unknown effect assessment is invalid");
    }
    if (input.evidence !== undefined && containsBrokeredSecret(JSON.stringify(input.evidence))) {
      throw new ValidationError("Brokered credentials cannot enter reconciliation evidence");
    }
    const evidence = input.evidence === undefined ? undefined : scrubJson(input.evidence);
    const inspected = await this.inspect(sessionId, branchId, effectId);
    const reconciliationId = input.reconciliationId ?? newId();
    const existing = inspected.assessments.find((item) => item.reconciliationId === reconciliationId);
    if (existing) {
      const sameMeaning = existing.effectId === effectId &&
        existing.assessment === input.assessment && existing.summary === summary &&
        existing.recordedBy === input.recordedBy &&
        canonicalJson(existing.evidence ?? null) === canonicalJson(evidence ?? null);
      if (!sameMeaning) {
        throw new ConflictError(`Effect reconciliation identity ${reconciliationId} already has different durable meaning`, {
          reconciliationId, effectId,
        });
      }
      return existing;
    }
    const recordedAt = new Date().toISOString();
    const [event] = await this.storage.appendEvents([{
      sessionId, branchId, type: "EffectReconciliationRecorded", producer: "client",
      idempotencyKey: `effect-reconciliation:${reconciliationId}`,
      payload: {
        reconciliationId, effectId, assessment: input.assessment, summary,
        ...(evidence === undefined ? {} : { evidence }),
        recordedBy: input.recordedBy, recordedAt,
      },
    }]);
    if (!event) throw new Error("Effect reconciliation was not committed");
    const updated = await this.inspect(sessionId, branchId, effectId);
    const result = updated.assessments.find((item) => item.reconciliationId === reconciliationId);
    if (!result) throw new Error("Committed effect reconciliation did not project");
    return result;
  }

  async recoverySummary(sessionId: string, branchId: string): Promise<RecoverySummaryView> {
    const { events, state } = await this.#load(sessionId, branchId);
    const terminalRuns = new Set(["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"]);
    const activeTasks = new Set(["pending", "admitted", "running"]);
    const attentionGoalGateIds = Object.values(state.goals).flatMap((goal) =>
      Object.values(goal.gates)
        .filter((gate) => ["failed", "unknown", "running"].includes(gate.status))
        .map((gate) => `${goal.id}/${gate.id}`));
    return {
      cursor: state.cursor,
      recovered: events.some((event) => event.type === "RecoveryPerformed"),
      pendingEffectIds: Object.values(state.effects).filter((effect) => effect.status === "requested" || effect.status === "started").map((effect) => effect.id),
      unknownEffects: Object.values(state.effects).filter((effect) => effect.status === "unknown").map((effect) => this.#unknownView(sessionId, branchId, effect, events, state)),
      activeRunIds: Object.values(state.agentRuns).filter((run) => !terminalRuns.has(run.status)).map((run) => run.id),
      cancellationRequestedRunIds: Object.values(state.agentRuns).filter((run) => run.cancellationRequested && !terminalRuns.has(run.status)).map((run) => run.id),
      activeChildTaskIds: Object.values(state.tasks).filter((task) => activeTasks.has(task.status)).map((task) => task.id),
      attentionGoalGateIds,
      terminalChildNoticeIds: Object.values(state.terminalNotices).map((notice) => notice.id),
    };
  }

  async #load(sessionId: string, branchId: string): Promise<{ events: AgentEvent[]; state: AgentState }> {
    const events = await this.storage.loadEvents(sessionId, { branchId });
    if (!events.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    return { events, state: projectEvents(events) };
  }

  #unknownView(
    sessionId: string,
    branchId: string,
    effect: AgentState["effects"][string],
    events: readonly AgentEvent[],
    state: AgentState,
  ): UnknownEffectView {
    const assessments = Object.values(state.effectReconciliations)
      .filter((item) => item.effectId === effect.id)
      .map((item): EffectReconciliationView => {
        const event = events.find((candidate) => candidate.id === item.eventId)!;
        return {
          reconciliationId: item.id, effectId: effect.id, sessionId, branchId, effect,
          assessment: item.assessment, summary: item.summary,
          ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
          recordedBy: item.recordedBy, recordedAt: item.recordedAt,
          eventId: item.eventId, cursor: event.cursor,
          durableEffectStatus: "unknown", retried: false,
        };
      })
      .sort((left, right) => BigInt(left.cursor) < BigInt(right.cursor) ? -1 : BigInt(left.cursor) > BigInt(right.cursor) ? 1 : 0);
    return {
      sessionId, branchId, effect, assessments,
      requiresOperatorAssessment: assessments.length === 0 || assessments.at(-1)!.assessment === "still_unknown",
      safeActions: ["record-assessment", "start-successor-run"], retryAllowed: false,
    };
  }
}

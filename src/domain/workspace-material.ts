import type { AgentEvent, EventPayloads, EventType } from "./events.ts";
import type { JsonValue } from "./json.ts";

export type WorkspaceMaterialEventClass = "material" | "file-effect" | "non-material";

/**
 * Exhaustive version-1 policy for the attributable workspace material pin.
 * Adding an event type fails typecheck until its material semantics are chosen.
 */
export const WORKSPACE_MATERIAL_EVENT_CLASS = {
  SessionCreated: "non-material",
  AgentProfileVersionCreated: "non-material",
  AgentProfileActivated: "non-material",
  BranchCreated: "non-material",
  SessionNamed: "non-material",
  BranchNamed: "non-material",
  SessionStatusChanged: "non-material",
  SessionModelChanged: "non-material",
  MessageAppended: "material",
  CellProposed: "non-material",
  CellStarted: "non-material",
  CellCommitted: "material",
  CellFailed: "non-material",
  CellAbandoned: "non-material",
  WorkingValueSet: "material",
  ArtifactRegistered: "material",
  EffectRequested: "non-material",
  EffectAttemptStarted: "non-material",
  EffectOutcomeRecorded: "file-effect",
  EffectReconciliationRecorded: "non-material",
  ContextCompactionRequested: "non-material",
  ContextCompactionFailed: "non-material",
  ContextMaterialized: "non-material",
  ModelCallRequested: "non-material",
  ModelOutputChunk: "non-material",
  ModelCallCompleted: "non-material",
  ModelCallTerminated: "non-material",
  BudgetDebited: "non-material",
  BudgetExceeded: "non-material",
  RecoveryPerformed: "non-material",
  TaskCreated: "non-material",
  SubagentAdmitted: "non-material",
  TaskStatusChanged: "non-material",
  SubagentCancellationRequested: "non-material",
  TaskUsageAttributed: "non-material",
  MailboxMessageSent: "non-material",
  MailboxMessageDelivered: "non-material",
  MailboxMessageContextDelivered: "non-material",
  MailboxMessageDeliveryFailed: "non-material",
  MailboxMessageAcknowledged: "non-material",
  TaskTerminalNoticeSent: "non-material",
  TaskTerminalNoticeDelivered: "non-material",
  DocumentImported: "non-material",
  DocumentChunkAdded: "non-material",
  InputSetCreated: "non-material",
  GoalCreated: "non-material",
  GoalCompletionRequested: "non-material",
  GoalGateAdded: "non-material",
  GoalGateStatusChanged: "non-material",
  GoalGateEvaluationRecorded: "non-material",
  GoalStatusChanged: "non-material",
  HeartbeatCreated: "non-material",
  HeartbeatTicked: "non-material",
  HeartbeatStatusChanged: "non-material",
  ScheduleCreated: "non-material",
  ScheduleTicked: "non-material",
  ScheduleStatusChanged: "non-material",
  WakeQueued: "non-material",
  WakeClaimed: "non-material",
  WakeDelivered: "non-material",
  WakeDeliveryUnknown: "non-material",
  RecursiveModelStarted: "non-material",
  RecursiveModelStatusChanged: "non-material",
  AiGenerationContextFrozen: "non-material",
  AiGenerationRequested: "non-material",
  AiGenerationStatusChanged: "non-material",
  AiGenerationResultCommitted: "non-material",
  AiGenerationBudgetDebited: "non-material",
  UserCorrection: "non-material",
  RefinementReviewRequested: "non-material",
  RefinementReviewChildLinked: "non-material",
  RefinementReviewStatusChanged: "non-material",
  RefinementTriggerConsumed: "non-material",
  HarnessVersionCreated: "non-material",
  HarnessVersionStatusChanged: "non-material",
  RefinementProposed: "non-material",
  RefinementValidated: "non-material",
  RefinementCandidateActivated: "non-material",
  RefinementCandidateAllocated: "non-material",
  RefinementCandidateExposed: "non-material",
  RefinementObservationRecorded: "non-material",
  RefinementDecided: "non-material",
  RefinementApproved: "non-material",
  RefinementRollbackApproved: "non-material",
  RefinementRolledBack: "non-material",
  GovernedRefinementProposed: "non-material",
  GovernedRefinementValidated: "non-material",
  RefinementGovernanceReviewRequested: "non-material",
  RefinementGovernanceReviewChildLinked: "non-material",
  RefinementGovernanceReviewDecided: "non-material",
  GovernedRefinementApplied: "non-material",
  RefinementProposalTerminalNoticeDelivered: "non-material",
  RefinementRollbackApplied: "non-material",
  GovernedRefinementRollbackApplied: "non-material",
  SkillImported: "non-material",
  SkillAvailabilityChanged: "non-material",
  SkillInvocationRecorded: "non-material",
  SkillTestRecorded: "non-material",
  SubagentSpecInvoked: "non-material",
  SyncConflictResolved: "non-material",
  AgentRunRequested: "non-material",
  AgentInvocationContractPinned: "non-material",
  AgentRunStepStarted: "non-material",
  AgentRunModelAttemptStarted: "non-material",
  AgentRunActionCommitted: "non-material",
  AgentRunActionRejected: "non-material",
  AgentRunTypedFinishCommitted: "non-material",
  AgentRunTypedActionViolationCommitted: "non-material",
  AgentRunResultCommitted: "non-material",
  AgentRunGoalCheckRecorded: "non-material",
  AgentRunCancellationRequested: "non-material",
  AgentRunStatusChanged: "non-material",
} as const satisfies Record<EventType, WorkspaceMaterialEventClass>;

export interface WorkspaceMaterialPin {
  readonly version: string;
  readonly eventIds: string[];
}

export function isWorkspaceMaterialEvent(
  event: AgentEvent,
  effects: ReadonlyMap<string, EventPayloads["EffectRequested"]> = new Map(),
): boolean {
  const classification = WORKSPACE_MATERIAL_EVENT_CLASS[event.type];
  if (classification === "material") return event.type !== "MessageAppended" || event.producer !== "scheduler";
  if (classification === "non-material") return false;
  const outcome = event.payload as EventPayloads["EffectOutcomeRecorded"];
  if (outcome.outcome !== "succeeded") return false;
  const requested = effects.get(outcome.effectId);
  if (!requested || requested.executor !== "file" || !["write", "replace"].includes(requested.operation)) return false;
  const output = outcome.output;
  return !(output && typeof output === "object" && !Array.isArray(output) && output.unchanged === true);
}

export function workspaceMaterialPin(events: readonly AgentEvent[]): WorkspaceMaterialPin {
  const effects = new Map<string, EventPayloads["EffectRequested"]>();
  const eventIds: string[] = [];
  for (const event of events) {
    if (event.type === "EffectRequested") effects.set((event.payload as EventPayloads["EffectRequested"]).effectId, event.payload as EventPayloads["EffectRequested"]);
    if (isWorkspaceMaterialEvent(event, effects)) eventIds.push(event.id);
  }
  return { version: sha256(canonicalJson(eventIds)), eventIds };
}

export function gateDefinitionHash(definition: {
  readonly name: string; readonly executor: string; readonly operation: string;
  readonly input: JsonValue; readonly idempotent: boolean; readonly required: boolean;
}): string {
  return sha256(canonicalJson({ name: definition.name, executor: definition.executor, operation: definition.operation, input: definition.input, idempotent: definition.idempotent, required: definition.required }));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  const hash = new Bun.CryptoHasher("sha256"); hash.update(value); return hash.digest("hex");
}

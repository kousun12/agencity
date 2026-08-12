import type { AgentEvent, AgentProfileInput, AgentState, BudgetLimits, JsonValue, ModelConfigurationInput } from "../domain/index.ts";
import type { ResolveConflictInput } from "../sync/index.ts";
import type { CompactContextInput, CreateGoalInput, CreateHeartbeatInput, CreateScheduleInput, CreateInputSetInput, ImportDocumentInput, SendMessageInput, SpawnAgentInput, CreateMemoryInput, ProposeRefinementInput, ActivateCandidateInput, RecordObservationInput, DecideRefinementInput, ApproveRollbackInput, StartRefinementReviewInput, InvokeSkillOptions, SpawnSpecInput } from "../runtime/index.ts";

export type ProtocolRequest =
  | { type: "createSession"; workspaceId: string; model?: ModelConfigurationInput; budget?: BudgetLimits; agentProfile?: AgentProfileInput }
  | { type: "message"; sessionId: string; branchId: string; content: string }
  | { type: "turn"; sessionId: string; branchId: string }
  | { type: "cell"; sessionId: string; branchId: string; code: string }
  | { type: "fork"; sessionId: string; branchId: string; cursor: string; name?: string; compactionStrategy?: "deterministic-extractive-v1" | "model-summary-v1" }
  | { type: "contextInspect"; sessionId: string; branchId: string }
  | { type: "contextCompact"; sessionId: string; branchId: string; input?: CompactContextInput }
  | { type: "spawn"; sessionId: string; branchId: string; input: SpawnAgentInput }
  | { type: "spawnMany"; sessionId: string; branchId: string; inputs: SpawnAgentInput[] }
  | { type: "mailbox"; sessionId: string; branchId: string; input: SendMessageInput }
  | { type: "importDocument"; sessionId: string; branchId: string; input: ImportDocumentInput }
  | { type: "createInputSet"; sessionId: string; branchId: string; input: CreateInputSetInput }
  | { type: "createGoal"; sessionId: string; branchId: string; input: CreateGoalInput }
  | { type: "createHeartbeat"; sessionId: string; branchId: string; input: CreateHeartbeatInput }
  | { type: "createSchedule"; sessionId: string; branchId: string; input: CreateScheduleInput }
  | { type: "memoryCreate"; sessionId: string; branchId: string; input: CreateMemoryInput }
  | { type: "memorySearch"; sessionId: string; branchId: string; query: string }
  | { type: "refineReview"; sessionId: string; branchId: string; input: StartRefinementReviewInput }
  | { type: "refine"; sessionId: string; branchId: string; input: ProposeRefinementInput }
  | { type: "refineActivate"; sessionId: string; branchId: string; proposalId: string; input?: ActivateCandidateInput }
  | { type: "refineObserve"; sessionId: string; branchId: string; proposalId: string; input: RecordObservationInput }
  | { type: "refineDecide"; sessionId: string; branchId: string; proposalId: string; input?: DecideRefinementInput }
  | { type: "refineApproveRollback"; sessionId: string; branchId: string; proposalId: string; input?: ApproveRollbackInput }
  | { type: "skillInvoke"; sessionId: string; branchId: string; entryId: string; input: JsonValue; options?: InvokeSkillOptions }
  | { type: "specSpawn"; sessionId: string; branchId: string; entryId: string; input?: SpawnSpecInput }
  | { type: "sync" }
  | { type: "syncPush" }
  | { type: "syncPull" }
  | { type: "syncCheckpoint" }
  | { type: "syncStats" }
  | { type: "syncReconnect" }
  | { type: "syncResolve"; conflictId: string; input: ResolveConflictInput }
  | { type: "syncManifest"; operation: "export" | "delete"; scopeKind: "workspace" | "session" | "profile"; scopeId: string; requestedBy: string }
  | { type: "syncExport"; destination: string; scopeKind: "workspace" | "session" | "profile"; scopeId: string; requestedBy: string };
export type ProtocolResponse = { ok: true; value: JsonValue } | { ok: false; error: { code: string; message: string } };
export interface SnapshotEnvelope { cursor: string; state: AgentState }
export interface EventEnvelope { cursor: string; event: AgentEvent }

import type { AgentEvent, AgentState, BudgetLimits, JsonValue, ModelConfiguration } from "../domain/index.ts";
import type { CreateGoalInput, CreateHeartbeatInput, CreateInputSetInput, ImportDocumentInput, SendMessageInput, SpawnAgentInput, StartRecursiveModelInput } from "../runtime/index.ts";

export type ProtocolRequest =
  | { type: "createSession"; workspaceId: string; model?: ModelConfiguration; budget?: BudgetLimits }
  | { type: "message"; sessionId: string; branchId: string; content: string }
  | { type: "turn"; sessionId: string; branchId: string }
  | { type: "cell"; sessionId: string; branchId: string; code: string }
  | { type: "fork"; sessionId: string; branchId: string; cursor: string; name?: string }
  | { type: "spawn"; sessionId: string; branchId: string; input: SpawnAgentInput }
  | { type: "spawnMany"; sessionId: string; branchId: string; inputs: SpawnAgentInput[] }
  | { type: "mailbox"; sessionId: string; branchId: string; input: SendMessageInput }
  | { type: "importDocument"; sessionId: string; branchId: string; input: ImportDocumentInput }
  | { type: "createInputSet"; sessionId: string; branchId: string; input: CreateInputSetInput }
  | { type: "startRecursiveModel"; sessionId: string; branchId: string; input: StartRecursiveModelInput }
  | { type: "createGoal"; sessionId: string; branchId: string; input: CreateGoalInput }
  | { type: "createHeartbeat"; sessionId: string; branchId: string; input: CreateHeartbeatInput };
export type ProtocolResponse = { ok: true; value: JsonValue } | { ok: false; error: { code: string; message: string } };
export interface SnapshotEnvelope { cursor: string; state: AgentState }
export interface EventEnvelope { cursor: string; event: AgentEvent }

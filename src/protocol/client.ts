import type { AgentEvent, AgentState } from "../domain/index.ts";
import type {
  CreateGoalInput, CreateHeartbeatInput, CreateInputSetInput, DocumentHandle, GoalHandle,
  HeartbeatHandle, ImportDocumentInput, InputSetHandle, RecursiveModelHandle, SendMessageInput,
  SpawnAgentInput, StartRecursiveModelInput, SubagentHandle,
} from "../runtime/index.ts";
import type { TaskRecord } from "../storage/index.ts";

export class AgentClient {
  constructor(readonly baseUrl: string) {}
  createSession(workspaceId: string): Promise<{ sessionId: string; branchId: string }> { return this.#post("/sessions", { workspaceId }); }
  snapshot(sessionId: string, branchId: string): Promise<{ cursor: string; state: AgentState }> { return this.#json(`/sessions/${sessionId}/snapshot?branch=${branchId}`); }
  message(sessionId: string, branchId: string, content: string): Promise<AgentEvent> { return this.#post(`/sessions/${sessionId}/messages?branch=${branchId}`, { content }); }
  turn(sessionId: string, branchId: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/turns?branch=${branchId}`); }
  cell(sessionId: string, branchId: string, code: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/cells?branch=${branchId}`, { code }); }
  history(sessionId: string, branchId: string): Promise<AgentEvent[]> { return this.#json(`/sessions/${sessionId}/history?branch=${branchId}`); }

  spawn(sessionId: string, branchId: string, input: SpawnAgentInput | string): Promise<SubagentHandle> { return this.#post(`/sessions/${sessionId}/agents?branch=${branchId}`, typeof input === "string" ? { task: input } : input); }
  spawnMany(sessionId: string, branchId: string, inputs: readonly (SpawnAgentInput | string)[]): Promise<SubagentHandle[]> { return this.#post(`/sessions/${sessionId}/agents/batch?branch=${branchId}`, { inputs }); }
  tasks(sessionId: string, branchId: string): Promise<TaskRecord[]> { return this.#json(`/sessions/${sessionId}/tasks?branch=${branchId}`); }
  cancelTask(sessionId: string, branchId: string, taskId: string, reason?: string): Promise<TaskRecord> { return this.#post(`/sessions/${sessionId}/tasks/${taskId}/cancel?branch=${branchId}`, reason === undefined ? {} : { reason }); }
  sendMailbox(sessionId: string, branchId: string, input: SendMessageInput): Promise<unknown> { return this.#post(`/sessions/${sessionId}/mailbox?branch=${branchId}`, input); }
  acknowledgeMailbox(sessionId: string, branchId: string, messageId: string): Promise<unknown> { return this.#post(`/sessions/${sessionId}/mailbox/${messageId}/ack?branch=${branchId}`); }

  importDocument(sessionId: string, branchId: string, input: ImportDocumentInput): Promise<DocumentHandle> { return this.#post(`/sessions/${sessionId}/documents?branch=${branchId}`, input); }
  createInputSet(sessionId: string, branchId: string, input: CreateInputSetInput): Promise<InputSetHandle> { return this.#post(`/sessions/${sessionId}/input-sets?branch=${branchId}`, input); }
  startModel(sessionId: string, branchId: string, input: StartRecursiveModelInput | string): Promise<RecursiveModelHandle> { return this.#post(`/sessions/${sessionId}/models?branch=${branchId}`, typeof input === "string" ? { prompt: input } : input); }
  model(handleId: string): Promise<RecursiveModelHandle> { return this.#json(`/models/${handleId}`); }
  cancelModel(handleId: string, reason?: string): Promise<RecursiveModelHandle> { return this.#post(`/models/${handleId}/cancel`, reason === undefined ? {} : { reason }); }

  createGoal(sessionId: string, branchId: string, input: CreateGoalInput | string): Promise<GoalHandle> { return this.#post(`/sessions/${sessionId}/goals?branch=${branchId}`, typeof input === "string" ? { description: input } : input); }
  requestGoalCompletion(sessionId: string, branchId: string, goalId: string): Promise<GoalHandle> { return this.#post(`/sessions/${sessionId}/goals/${goalId}/completion?branch=${branchId}`); }
  continueGoal(sessionId: string, branchId: string, goalId: string, maxTurns?: number): Promise<GoalHandle> { return this.#post(`/sessions/${sessionId}/goals/${goalId}/continue?branch=${branchId}`, maxTurns === undefined ? {} : { maxTurns }); }
  createHeartbeat(sessionId: string, branchId: string, input: CreateHeartbeatInput | number): Promise<HeartbeatHandle> { return this.#post(`/sessions/${sessionId}/heartbeats?branch=${branchId}`, typeof input === "number" ? { intervalMs: input } : input); }
  tickHeartbeat(heartbeatId: string, at?: string): Promise<HeartbeatHandle> { return this.#post(`/heartbeats/${heartbeatId}/tick`, at === undefined ? {} : { at }); }
  pauseHeartbeat(heartbeatId: string, reason?: string): Promise<HeartbeatHandle> { return this.#post(`/heartbeats/${heartbeatId}/pause`, reason === undefined ? {} : { reason }); }
  cancelHeartbeat(heartbeatId: string, reason?: string): Promise<HeartbeatHandle> { return this.#post(`/heartbeats/${heartbeatId}/cancel`, reason === undefined ? {} : { reason }); }

  #post<T>(path: string, value?: unknown): Promise<T> { return this.#json(path, { method: "POST", ...(value === undefined ? {} : { body: JSON.stringify(value), headers: { "content-type": "application/json" } }) }); }
  async #json<T>(path: string, init?: RequestInit): Promise<T> { const response = await fetch(`${this.baseUrl}${path}`, init); const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body as T; }
}

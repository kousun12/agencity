import { NotFoundError, ValidationError, newId, type JsonValue } from "../domain/index.ts";
import { requireRecursiveStorage, type AgentStorage, type HeartbeatRecord } from "../storage/index.ts";
import type { GoalService } from "./goals.ts";

export interface CreateHeartbeatInput { readonly intervalMs: number; readonly nextTickAt?: string; readonly goalId?: string; readonly payload?: JsonValue; }
export interface HeartbeatHandle extends HeartbeatRecord {}

export class HeartbeatService {
  readonly #recursive;
  readonly #ticks = new Map<string, Promise<HeartbeatHandle>>();
  #schedulerAbort: AbortController | undefined;
  #scheduler: Promise<void> | undefined;
  constructor(readonly storage: AgentStorage, readonly goals: GoalService) { this.#recursive = requireRecursiveStorage(storage); }

  async create(sessionId: string, branchId: string, rawInput: CreateHeartbeatInput | number): Promise<HeartbeatHandle> {
    const input: CreateHeartbeatInput = typeof rawInput === "number" ? { intervalMs: rawInput } : rawInput;
    if (!Number.isInteger(input.intervalMs) || input.intervalMs < 1) throw new ValidationError("Heartbeat intervalMs must be positive");
    if (!(await this.#recursive.getSession(sessionId))) throw new NotFoundError("session", sessionId);
    if (input.goalId) { const goal = await this.#recursive.getGoal(input.goalId); if (!goal || goal.sessionId !== sessionId || goal.branchId !== branchId) throw new NotFoundError("goal", input.goalId); }
    const heartbeatId = newId(); const parsedNext = Date.parse(input.nextTickAt ?? new Date().toISOString());
    if (!Number.isFinite(parsedNext)) throw new ValidationError("Heartbeat nextTickAt must be an ISO timestamp");
    const nextTickAt = new Date(parsedNext).toISOString();
    await this.storage.appendEvents([{ sessionId, branchId, type: "HeartbeatCreated", producer: "client", idempotencyKey: `heartbeat:${heartbeatId}`, payload: { heartbeatId, intervalMs: input.intervalMs, nextTickAt, ...(input.goalId === undefined ? {} : { goalId: input.goalId }), ...(input.payload === undefined ? {} : { payload: input.payload }) } }]);
    return this.#load(heartbeatId);
  }

  tick(heartbeatId: string, at: string | Date = new Date()): Promise<HeartbeatHandle> {
    const existing = this.#ticks.get(heartbeatId); if (existing) return existing;
    let tick!: Promise<HeartbeatHandle>;
    tick = this.#tick(heartbeatId, at).finally(() => { if (this.#ticks.get(heartbeatId) === tick) this.#ticks.delete(heartbeatId); });
    this.#ticks.set(heartbeatId, tick); return tick;
  }

  async #tick(heartbeatId: string, at: string | Date): Promise<HeartbeatHandle> {
    const heartbeat = await this.#recursive.getHeartbeat(heartbeatId); if (!heartbeat) throw new NotFoundError("heartbeat", heartbeatId);
    if (heartbeat.status !== "active") throw new ValidationError(`Cannot tick a ${heartbeat.status} heartbeat`);
    const requestedAt = typeof at === "string" ? at : at.toISOString(); const firedMs = Date.parse(requestedAt);
    if (!Number.isFinite(firedMs)) throw new ValidationError("Heartbeat tick time must be an ISO timestamp");
    const firedAt = new Date(firedMs).toISOString();
    const scheduledMs = Date.parse(heartbeat.nextTickAt);
    if (firedMs < scheduledMs) throw new ValidationError("Heartbeat tick is early; the schedule is not due");
    const intervals = Math.floor((firedMs - scheduledMs) / heartbeat.intervalMs) + 1;
    const nextTickAt = new Date(scheduledMs + intervals * heartbeat.intervalMs).toISOString();
    const tickNumber = heartbeat.tick + 1;
    const wake = JSON.stringify({ heartbeatId, tick: tickNumber, scheduledAt: heartbeat.nextTickAt, firedAt, missedIntervals: Math.max(0, intervals - 1), payload: heartbeat.payload ?? null });
    // The schedule advancement and its durable wake-up are one canonical
    // transaction. There is no state in which one exists without the other.
    await this.storage.appendEvents([{
      sessionId: heartbeat.sessionId, branchId: heartbeat.branchId, type: "HeartbeatTicked", producer: "scheduler",
      idempotencyKey: `heartbeat-tick:${heartbeatId}:${tickNumber}`, payload: { heartbeatId, tick: tickNumber, scheduledAt: heartbeat.nextTickAt, firedAt, nextTickAt },
    }, {
      sessionId: heartbeat.sessionId, branchId: heartbeat.branchId, type: "MessageAppended", producer: "scheduler",
      idempotencyKey: `heartbeat-wake:${heartbeatId}:${tickNumber}`, payload: { messageId: `heartbeat-${heartbeatId}-${tickNumber}`, role: "system", content: `Heartbeat wake-up: ${wake}` },
    }]);
    if (heartbeat.goalId) {
      const goal = await this.#recursive.getGoal(heartbeat.goalId);
      if (goal && ["active", "blocked"].includes(goal.status)) await this.goals.runContinuation(heartbeat.sessionId, heartbeat.branchId, heartbeat.goalId, 1);
    }
    return this.#load(heartbeatId);
  }

  async recoverDue(at: string | Date = new Date()): Promise<number> {
    const parsedAt = Date.parse(typeof at === "string" ? at : at.toISOString());
    if (!Number.isFinite(parsedAt)) throw new ValidationError("Heartbeat recovery time must be an ISO timestamp");
    const firedAt = new Date(parsedAt).toISOString();
    const due = await this.#recursive.listDueHeartbeats(firedAt);
    for (const heartbeat of due) await this.tick(heartbeat.heartbeatId, firedAt);
    return due.length;
  }

  startScheduler(pollIntervalMs = 100): void {
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) throw new ValidationError("Heartbeat poll interval must be positive");
    if (this.#scheduler) return;
    const controller = new AbortController(); this.#schedulerAbort = controller;
    this.#scheduler = (async () => {
      while (!controller.signal.aborted) {
        await abortableSleep(pollIntervalMs, controller.signal);
        if (controller.signal.aborted) break;
        try { await this.recoverDue(new Date()); }
        catch { if (controller.signal.aborted) break; /* the next DB poll retries */ }
      }
    })().finally(() => { if (this.#schedulerAbort === controller) { this.#schedulerAbort = undefined; this.#scheduler = undefined; } });
  }

  async close(): Promise<void> {
    const running = this.#scheduler;
    this.#schedulerAbort?.abort();
    if (running) await running;
    await Promise.allSettled([...this.#ticks.values()]);
  }

  async pause(heartbeatId: string, reason?: string): Promise<HeartbeatHandle> {
    const heartbeat = await this.#recursive.getHeartbeat(heartbeatId); if (!heartbeat) throw new NotFoundError("heartbeat", heartbeatId);
    if (heartbeat.status === "paused") return heartbeat;
    if (heartbeat.status === "cancelled") throw new ValidationError("Cancelled heartbeat cannot be paused");
    await this.storage.appendEvents([{ sessionId: heartbeat.sessionId, branchId: heartbeat.branchId, type: "HeartbeatStatusChanged", producer: "client", idempotencyKey: `heartbeat-pause:${heartbeatId}`, payload: { heartbeatId, status: "paused", ...(reason === undefined ? {} : { reason }) } }]);
    return this.#load(heartbeatId);
  }

  async cancel(heartbeatId: string, reason?: string): Promise<HeartbeatHandle> {
    const heartbeat = await this.#recursive.getHeartbeat(heartbeatId); if (!heartbeat) throw new NotFoundError("heartbeat", heartbeatId);
    if (heartbeat.status === "cancelled") return heartbeat;
    await this.storage.appendEvents([{ sessionId: heartbeat.sessionId, branchId: heartbeat.branchId, type: "HeartbeatStatusChanged", producer: "client", idempotencyKey: `heartbeat-cancel:${heartbeatId}`, payload: { heartbeatId, status: "cancelled", ...(reason === undefined ? {} : { reason }) } }]);
    return this.#load(heartbeatId);
  }

  async #load(id: string): Promise<HeartbeatHandle> { const result = await this.#recursive.getHeartbeat(id); if (!result) throw new NotFoundError("heartbeat", id); return result; }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); }
    signal.addEventListener("abort", finish, { once: true });
  });
}

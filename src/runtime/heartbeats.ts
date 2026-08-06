import { NotFoundError, ValidationError, newId, type AutonomyOwner, type JsonValue } from "../domain/index.ts";
import { requireRecursiveStorage, type AgentStorage, type HeartbeatRecord } from "../storage/index.ts";

export interface CreateHeartbeatInput {
  readonly intervalMs: number;
  readonly nextTickAt?: string;
  readonly goalId?: string;
  readonly prompt?: string;
  readonly payload?: JsonValue;
}
export interface HeartbeatHandle extends HeartbeatRecord {}

/** Durable heartbeat definitions. Ticks enqueue wakes; only AgentRunService delivers them. */
export class HeartbeatService {
  readonly #recursive;
  readonly #ticks = new Map<string, Promise<HeartbeatHandle>>();
  #schedulerAbort: AbortController | undefined;
  #scheduler: Promise<void> | undefined;
  constructor(readonly storage: AgentStorage) { this.#recursive = requireRecursiveStorage(storage); }

  create(sessionId: string, branchId: string, rawInput: CreateHeartbeatInput | number): Promise<HeartbeatHandle> {
    return this.#create(sessionId, branchId, rawInput, "user");
  }

  createAgent(sessionId: string, branchId: string, rawInput: CreateHeartbeatInput | number): Promise<HeartbeatHandle> {
    return this.#create(sessionId, branchId, rawInput, "agent");
  }

  async #create(sessionId: string, branchId: string, rawInput: CreateHeartbeatInput | number, owner: AutonomyOwner): Promise<HeartbeatHandle> {
    const input: CreateHeartbeatInput = typeof rawInput === "number" ? { intervalMs: rawInput } : rawInput;
    if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1) throw new ValidationError("Heartbeat intervalMs must be positive");
    if (input.prompt !== undefined && !input.prompt.trim()) throw new ValidationError("Heartbeat prompt cannot be empty");
    if (!(await this.#recursive.getSession(sessionId))) throw new NotFoundError("session", sessionId);
    if (input.goalId) {
      const goal = await this.#recursive.getGoal(input.goalId);
      if (!goal || goal.sessionId !== sessionId || goal.branchId !== branchId) throw new NotFoundError("goal", input.goalId);
    }
    const heartbeatId = newId();
    const parsedNext = Date.parse(input.nextTickAt ?? new Date().toISOString());
    if (!Number.isFinite(parsedNext)) throw new ValidationError("Heartbeat nextTickAt must be an ISO timestamp");
    const nextTickAt = new Date(parsedNext).toISOString();
    await this.storage.appendEvents([{
      sessionId, branchId, type: "HeartbeatCreated", producer: owner === "agent" ? "console" : "client",
      idempotencyKey: `heartbeat:${heartbeatId}`,
      payload: {
        heartbeatId, intervalMs: input.intervalMs, nextTickAt, owner,
        ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt.trim() }),
        ...(input.payload === undefined ? {} : { payload: input.payload }),
      },
    }]);
    return this.#load(heartbeatId);
  }

  list(sessionId: string, branchId: string): Promise<HeartbeatRecord[]> {
    return this.#recursive.listHeartbeats(sessionId, branchId);
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
    const wakeId = `heartbeat-wake:${heartbeatId}:${tickNumber}`;
    const missedIntervals = Math.max(0, intervals - 1);
    const prompt = heartbeat.prompt ?? `Heartbeat ${heartbeatId} tick ${tickNumber}${missedIntervals ? ` (${missedIntervals} missed interval(s) coalesced)` : ""}${heartbeat.payload === undefined ? "" : `: ${JSON.stringify(heartbeat.payload)}`}`;
    // Advancement and queue insertion are one canonical transaction.
    await this.storage.appendEvents([{
      sessionId: heartbeat.sessionId, branchId: heartbeat.branchId, type: "HeartbeatTicked", producer: "scheduler",
      idempotencyKey: `heartbeat-tick:${heartbeatId}:${tickNumber}`,
      payload: { heartbeatId, tick: tickNumber, scheduledAt: heartbeat.nextTickAt, firedAt, nextTickAt, missedIntervals, wakeId },
    }, {
      sessionId: heartbeat.sessionId, branchId: heartbeat.branchId, type: "MessageAppended", producer: "scheduler",
      idempotencyKey: `heartbeat-wake-message:${heartbeatId}:${tickNumber}`,
      payload: { messageId: `heartbeat-${heartbeatId}-${tickNumber}`, role: "system", content: prompt },
    }, {
      sessionId: heartbeat.sessionId, branchId: heartbeat.branchId, type: "WakeQueued", producer: "scheduler",
      idempotencyKey: `wake-queued:${wakeId}`,
      payload: {
        wakeId, sourceType: "heartbeat", sourceId: heartbeatId, tick: tickNumber,
        scheduledAt: heartbeat.nextTickAt, firedAt, prompt,
        ...(heartbeat.goalId === null ? {} : { goalId: heartbeat.goalId }),
        goalMode: heartbeat.goalId === null ? "none" : "current",
      },
    }]);
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
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) throw new ValidationError("Heartbeat poll interval must be positive");
    if (this.#scheduler) return;
    const controller = new AbortController(); this.#schedulerAbort = controller;
    this.#scheduler = (async () => {
      while (!controller.signal.aborted) {
        await abortableSleep(pollIntervalMs, controller.signal);
        if (controller.signal.aborted) break;
        try { await this.recoverDue(new Date()); }
        catch { if (controller.signal.aborted) break; }
      }
    })().finally(() => { if (this.#schedulerAbort === controller) { this.#schedulerAbort = undefined; this.#scheduler = undefined; } });
  }

  async close(): Promise<void> {
    const running = this.#scheduler;
    this.#schedulerAbort?.abort();
    if (running) await running;
    await Promise.allSettled([...this.#ticks.values()]);
  }

  pause(heartbeatId: string, reason?: string): Promise<HeartbeatHandle> { return this.#status(heartbeatId, "paused", "user", reason); }
  resume(heartbeatId: string, nextTickAt?: string): Promise<HeartbeatHandle> { return this.#resume(heartbeatId, nextTickAt, "user"); }
  cancel(heartbeatId: string, reason?: string): Promise<HeartbeatHandle> { return this.#status(heartbeatId, "cancelled", "user", reason); }
  async pauseAgent(sessionId: string, branchId: string, heartbeatId: string, reason?: string): Promise<HeartbeatHandle> { await this.#assertAgentScope(sessionId, branchId, heartbeatId); return this.#status(heartbeatId, "paused", "agent", reason); }
  async resumeAgent(sessionId: string, branchId: string, heartbeatId: string, nextTickAt?: string): Promise<HeartbeatHandle> { await this.#assertAgentScope(sessionId, branchId, heartbeatId); return this.#resume(heartbeatId, nextTickAt, "agent"); }
  async cancelAgent(sessionId: string, branchId: string, heartbeatId: string, reason?: string): Promise<HeartbeatHandle> { await this.#assertAgentScope(sessionId, branchId, heartbeatId); return this.#status(heartbeatId, "cancelled", "agent", reason); }

  async #resume(heartbeatId: string, rawNextTickAt: string | undefined, authority: AutonomyOwner): Promise<HeartbeatHandle> {
    const heartbeat = await this.#owned(heartbeatId, authority);
    if (heartbeat.status === "active") return heartbeat;
    if (heartbeat.status === "cancelled") throw new ValidationError("Cancelled heartbeat cannot be resumed");
    const parsed = Date.parse(rawNextTickAt ?? new Date().toISOString());
    if (!Number.isFinite(parsed)) throw new ValidationError("Heartbeat nextTickAt must be an ISO timestamp");
    await this.storage.appendEvents([{ sessionId: heartbeat.sessionId, branchId: heartbeat.branchId, type: "HeartbeatStatusChanged", producer: authority === "agent" ? "console" : "client", idempotencyKey: `heartbeat-resume:${heartbeatId}:${newId()}`, payload: { heartbeatId, status: "active", nextTickAt: new Date(parsed).toISOString() } }]);
    return this.#load(heartbeatId);
  }

  async #status(heartbeatId: string, status: "paused" | "cancelled", authority: AutonomyOwner, reason?: string): Promise<HeartbeatHandle> {
    const heartbeat = await this.#owned(heartbeatId, authority);
    if (heartbeat.status === status) return heartbeat;
    if (heartbeat.status === "cancelled") throw new ValidationError("Cancelled heartbeat cannot change status");
    await this.storage.appendEvents([{ sessionId: heartbeat.sessionId, branchId: heartbeat.branchId, type: "HeartbeatStatusChanged", producer: authority === "agent" ? "console" : "client", idempotencyKey: `heartbeat-${status}:${heartbeatId}:${newId()}`, payload: { heartbeatId, status, ...(reason === undefined ? {} : { reason }) } }]);
    return this.#load(heartbeatId);
  }

  async #assertAgentScope(sessionId: string, branchId: string, heartbeatId: string): Promise<void> {
    const heartbeat = await this.#recursive.getHeartbeat(heartbeatId);
    if (!heartbeat || heartbeat.sessionId !== sessionId || heartbeat.branchId !== branchId) throw new NotFoundError("heartbeat", heartbeatId);
  }

  async #owned(heartbeatId: string, authority: AutonomyOwner): Promise<HeartbeatRecord> {
    const heartbeat = await this.#recursive.getHeartbeat(heartbeatId); if (!heartbeat) throw new NotFoundError("heartbeat", heartbeatId);
    if (authority === "agent" && heartbeat.owner !== "agent") throw new ValidationError("Agent code cannot change a user-owned heartbeat");
    return heartbeat;
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

import { NotFoundError, ValidationError, newId, projectEvents, type AgentRunGoalMode, type AutonomyOwner } from "../domain/index.ts";
import { requireRecursiveStorage, type AgentStorage, type ScheduleRecord, type WakeRecord } from "../storage/index.ts";
import type { AgentRunService } from "./agent-runs.ts";

export interface CreateScheduleInput {
  readonly prompt: string;
  /** ISO time for a one-time or first interval tick. Defaults to now. */
  readonly at?: string;
  readonly nextTickAt?: string;
  /** Present for recurring schedules; absent for one-time schedules. */
  readonly intervalMs?: number;
  readonly goalMode?: Exclude<AgentRunGoalMode, "none">;
}
export interface ScheduleHandle extends ScheduleRecord {}

/** Coordinator seam retained for FU-015 process/lease ownership. */
export interface WakeCoordinator {
  deliver(wake: WakeRecord): Promise<{ readonly runId: string }>;
}

class AgentRunWakeCoordinator implements WakeCoordinator {
  constructor(readonly storage: AgentStorage, readonly runs: AgentRunService) {}
  async deliver(wake: WakeRecord): Promise<{ runId: string }> {
    const requestedRunId = `autonomy-wake-run:${wake.wakeId}`;
    const result = await this.runs.start(wake.sessionId, wake.branchId, {
      task: wake.prompt,
      requestKey: `autonomy-wake:${wake.wakeId}`,
      requestedRunId,
      wakeId: wake.wakeId,
      suppressTaskMessage: wake.sourceType === "heartbeat",
      ...(wake.goalId === null ? { goalMode: wake.goalMode } : { goalId: wake.goalId, goalMode: "current" }),
    });
    return { runId: result.runId };
  }
}

/** Durable one-time/interval schedules plus queued wake delivery. */
export class ScheduleService {
  readonly #recursive;
  readonly #ticks = new Map<string, Promise<ScheduleHandle>>();
  #coordinator: WakeCoordinator | null = null;
  #schedulerAbort: AbortController | undefined;
  #scheduler: Promise<void> | undefined;
  constructor(readonly storage: AgentStorage) { this.#recursive = requireRecursiveStorage(storage); }

  attachRunService(runs: AgentRunService): void { this.#coordinator = new AgentRunWakeCoordinator(this.storage, runs); }
  attachCoordinator(coordinator: WakeCoordinator): void { this.#coordinator = coordinator; }

  create(sessionId: string, branchId: string, input: CreateScheduleInput): Promise<ScheduleHandle> {
    return this.#create(sessionId, branchId, input, "user");
  }
  createAgent(sessionId: string, branchId: string, input: CreateScheduleInput): Promise<ScheduleHandle> {
    return this.#create(sessionId, branchId, input, "agent");
  }

  async #create(sessionId: string, branchId: string, input: CreateScheduleInput, owner: AutonomyOwner): Promise<ScheduleHandle> {
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.prompt !== "string" || !input.prompt.trim()) throw new ValidationError("Schedule prompt cannot be empty");
    if (input.intervalMs !== undefined && (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1)) throw new ValidationError("Schedule intervalMs must be positive");
    const parsed = Date.parse(input.at ?? input.nextTickAt ?? new Date().toISOString());
    if (!Number.isFinite(parsed)) throw new ValidationError("Schedule time must be an ISO timestamp");
    if (!(await this.#recursive.getSession(sessionId))) throw new NotFoundError("session", sessionId);
    const scheduleId = newId();
    await this.storage.appendEvents([{
      sessionId, branchId, type: "ScheduleCreated", producer: owner === "agent" ? "console" : "client",
      idempotencyKey: `schedule:${scheduleId}`,
      payload: {
        scheduleId, kind: input.intervalMs === undefined ? "once" : "interval",
        prompt: input.prompt.trim(), nextTickAt: new Date(parsed).toISOString(), owner,
        ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
        goalMode: input.goalMode ?? "auto",
      },
    }]);
    return this.#load(scheduleId);
  }

  list(sessionId: string, branchId: string): Promise<ScheduleRecord[]> { return this.#recursive.listSchedules(sessionId, branchId); }
  wakes(sessionId: string, branchId: string, statuses?: readonly WakeRecord["status"][]): Promise<WakeRecord[]> { return this.#recursive.listWakes(sessionId, branchId, statuses); }

  tick(scheduleId: string, at: string | Date = new Date()): Promise<ScheduleHandle> {
    const existing = this.#ticks.get(scheduleId); if (existing) return existing;
    let tick!: Promise<ScheduleHandle>;
    tick = this.#tick(scheduleId, at).finally(() => { if (this.#ticks.get(scheduleId) === tick) this.#ticks.delete(scheduleId); });
    this.#ticks.set(scheduleId, tick); return tick;
  }

  async #tick(scheduleId: string, at: string | Date): Promise<ScheduleHandle> {
    const schedule = await this.#recursive.getSchedule(scheduleId); if (!schedule) throw new NotFoundError("schedule", scheduleId);
    if (schedule.status !== "active") throw new ValidationError(`Cannot tick a ${schedule.status} schedule`);
    const firedMs = Date.parse(typeof at === "string" ? at : at.toISOString());
    if (!Number.isFinite(firedMs)) throw new ValidationError("Schedule tick time must be an ISO timestamp");
    const scheduledMs = Date.parse(schedule.nextTickAt);
    if (firedMs < scheduledMs) throw new ValidationError("Schedule tick is early; the schedule is not due");
    let nextTickAt: string | null = null;
    let missedIntervals = 0;
    if (schedule.kind === "interval") {
      if (!schedule.intervalMs) throw new ValidationError("Interval schedule is missing intervalMs");
      const intervals = Math.floor((firedMs - scheduledMs) / schedule.intervalMs) + 1;
      missedIntervals = Math.max(0, intervals - 1);
      nextTickAt = new Date(scheduledMs + intervals * schedule.intervalMs).toISOString();
    }
    const tickNumber = schedule.tick + 1;
    const firedAt = new Date(firedMs).toISOString();
    const wakeId = `schedule-wake:${scheduleId}:${tickNumber}`;
    await this.storage.appendEvents([{
      sessionId: schedule.sessionId, branchId: schedule.branchId, type: "ScheduleTicked", producer: "scheduler",
      idempotencyKey: `schedule-tick:${scheduleId}:${tickNumber}`,
      payload: { scheduleId, tick: tickNumber, scheduledAt: schedule.nextTickAt, firedAt, nextTickAt, missedIntervals, wakeId },
    }, {
      sessionId: schedule.sessionId, branchId: schedule.branchId, type: "WakeQueued", producer: "scheduler",
      idempotencyKey: `wake-queued:${wakeId}`,
      payload: { wakeId, sourceType: "schedule", sourceId: scheduleId, tick: tickNumber, scheduledAt: schedule.nextTickAt, firedAt, prompt: schedule.prompt, goalMode: schedule.goalMode },
    }]);
    return this.#load(scheduleId);
  }

  async recoverDue(at: string | Date = new Date()): Promise<number> {
    const parsed = Date.parse(typeof at === "string" ? at : at.toISOString());
    if (!Number.isFinite(parsed)) throw new ValidationError("Schedule recovery time must be an ISO timestamp");
    const dueAt = new Date(parsed).toISOString();
    const due = await this.#recursive.listDueSchedules(dueAt);
    for (const schedule of due) await this.tick(schedule.scheduleId, dueAt);
    return due.length;
  }

  /** Claims before delivery and reconciles claimed wakes by stable run identity. */
  async deliverQueued(): Promise<number> {
    if (!this.#coordinator) return 0;
    let delivered = 0;
    for (const branch of await this.storage.listBranches()) {
      const wakes = await this.#recursive.listWakes(branch.sessionId, branch.branchId, ["queued", "claimed"]);
      for (let wake of wakes) {
        const events = await this.storage.loadEvents(wake.sessionId, { branchId: wake.branchId });
        const active = Object.values(projectEvents(events).agentRuns).find((run) => !["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status));
        const expectedRunId = `autonomy-wake-run:${wake.wakeId}`;
        if (active && active.id !== expectedRunId) continue;
        if (wake.status === "queued") {
          const claimId = `wake-claim:${wake.wakeId}`;
          await this.storage.appendEvents([{
            sessionId: wake.sessionId, branchId: wake.branchId, type: "WakeClaimed", producer: "scheduler",
            idempotencyKey: `wake-claimed:${wake.wakeId}`, payload: { wakeId: wake.wakeId, claimId, claimedAt: new Date().toISOString() },
          }]);
          wake = (await this.#recursive.getWake(wake.wakeId))!;
        }
        try {
          const result = await this.#coordinator.deliver(wake);
          await this.storage.appendEvents([{
            sessionId: wake.sessionId, branchId: wake.branchId, type: "WakeDelivered", producer: "scheduler",
            idempotencyKey: `wake-delivered:${wake.wakeId}`,
            payload: { wakeId: wake.wakeId, claimId: wake.claimId!, runId: result.runId, deliveredAt: new Date().toISOString() },
          }]);
          delivered++;
        } catch (error) {
          // A stable AgentRun request is recoverable; ownership/capability
          // failures remain claimed for the rightful coordinator. Other errors
          // are explicit unknown delivery rather than a replayed prompt.
          const message = error instanceof Error ? error.message : String(error);
          if (/owner|lease|already .*run|execution of session/i.test(message)) continue;
          await this.storage.appendEvents([{
            sessionId: wake.sessionId, branchId: wake.branchId, type: "WakeDeliveryUnknown", producer: "recovery",
            idempotencyKey: `wake-unknown:${wake.wakeId}`,
            payload: { wakeId: wake.wakeId, claimId: wake.claimId!, reason: `Wake delivery could not be safely reconciled: ${message}`, observedAt: new Date().toISOString() },
          }]);
        }
      }
    }
    return delivered;
  }

  async recover(at: string | Date = new Date()): Promise<{ ticks: number; delivered: number }> {
    const ticks = await this.recoverDue(at);
    const delivered = await this.deliverQueued();
    return { ticks, delivered };
  }

  startScheduler(pollIntervalMs = 100): void {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) throw new ValidationError("Schedule poll interval must be positive");
    if (this.#scheduler) return;
    const controller = new AbortController(); this.#schedulerAbort = controller;
    this.#scheduler = (async () => {
      while (!controller.signal.aborted) {
        await abortableSleep(pollIntervalMs, controller.signal);
        if (controller.signal.aborted) break;
        try { await this.recover(new Date()); }
        catch { if (controller.signal.aborted) break; }
      }
    })().finally(() => { if (this.#schedulerAbort === controller) { this.#schedulerAbort = undefined; this.#scheduler = undefined; } });
  }

  async close(): Promise<void> {
    const running = this.#scheduler; this.#schedulerAbort?.abort(); if (running) await running;
    await Promise.allSettled([...this.#ticks.values()]);
  }

  pause(scheduleId: string, reason?: string): Promise<ScheduleHandle> { return this.#status(scheduleId, "paused", "user", reason); }
  resume(scheduleId: string, nextTickAt?: string): Promise<ScheduleHandle> { return this.#resume(scheduleId, nextTickAt, "user"); }
  clear(scheduleId: string, reason?: string): Promise<ScheduleHandle> { return this.#status(scheduleId, "cancelled", "user", reason ?? "User cleared schedule"); }
  async pauseAgent(sessionId: string, branchId: string, scheduleId: string, reason?: string): Promise<ScheduleHandle> { await this.#assertAgentScope(sessionId, branchId, scheduleId); return this.#status(scheduleId, "paused", "agent", reason); }
  async resumeAgent(sessionId: string, branchId: string, scheduleId: string, nextTickAt?: string): Promise<ScheduleHandle> { await this.#assertAgentScope(sessionId, branchId, scheduleId); return this.#resume(scheduleId, nextTickAt, "agent"); }
  async clearAgent(sessionId: string, branchId: string, scheduleId: string, reason?: string): Promise<ScheduleHandle> { await this.#assertAgentScope(sessionId, branchId, scheduleId); return this.#status(scheduleId, "cancelled", "agent", reason); }

  async #resume(scheduleId: string, rawAt: string | undefined, authority: AutonomyOwner): Promise<ScheduleHandle> {
    const schedule = await this.#owned(scheduleId, authority);
    if (schedule.status === "active") return schedule;
    if (["completed", "cancelled"].includes(schedule.status)) throw new ValidationError(`${schedule.status} schedule cannot be resumed`);
    const parsed = Date.parse(rawAt ?? new Date().toISOString());
    if (!Number.isFinite(parsed)) throw new ValidationError("Schedule time must be an ISO timestamp");
    await this.storage.appendEvents([{ sessionId: schedule.sessionId, branchId: schedule.branchId, type: "ScheduleStatusChanged", producer: authority === "agent" ? "console" : "client", idempotencyKey: `schedule-resume:${scheduleId}:${newId()}`, payload: { scheduleId, status: "active", nextTickAt: new Date(parsed).toISOString() } }]);
    return this.#load(scheduleId);
  }

  async #status(scheduleId: string, status: "paused" | "cancelled", authority: AutonomyOwner, reason?: string): Promise<ScheduleHandle> {
    const schedule = await this.#owned(scheduleId, authority);
    if (schedule.status === status) return schedule;
    if (["completed", "cancelled"].includes(schedule.status)) throw new ValidationError(`${schedule.status} schedule cannot change status`);
    await this.storage.appendEvents([{ sessionId: schedule.sessionId, branchId: schedule.branchId, type: "ScheduleStatusChanged", producer: authority === "agent" ? "console" : "client", idempotencyKey: `schedule-${status}:${scheduleId}:${newId()}`, payload: { scheduleId, status, ...(reason === undefined ? {} : { reason }) } }]);
    return this.#load(scheduleId);
  }

  async #assertAgentScope(sessionId: string, branchId: string, scheduleId: string): Promise<void> {
    const schedule = await this.#recursive.getSchedule(scheduleId);
    if (!schedule || schedule.sessionId !== sessionId || schedule.branchId !== branchId) throw new NotFoundError("schedule", scheduleId);
  }

  async #owned(scheduleId: string, authority: AutonomyOwner): Promise<ScheduleRecord> {
    const schedule = await this.#recursive.getSchedule(scheduleId); if (!schedule) throw new NotFoundError("schedule", scheduleId);
    if (authority === "agent" && schedule.owner !== "agent") throw new ValidationError("Agent code cannot change a user-owned schedule");
    return schedule;
  }
  async #load(scheduleId: string): Promise<ScheduleHandle> { const result = await this.#recursive.getSchedule(scheduleId); if (!result) throw new NotFoundError("schedule", scheduleId); return result; }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); }
    signal.addEventListener("abort", finish, { once: true });
  });
}

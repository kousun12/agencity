import {
  NotFoundError,
  projectEvents,
  reduceAgentState,
  type AgentEvent,
  type AgentState,
} from "../domain/index.ts";
import type { AgentStorage } from "../storage/index.ts";

function validateCursor(cursor: string): void {
  if (!/^\d+$/.test(cursor)) throw new Error(`Invalid cursor: ${cursor}`);
}

export const DEFAULT_TERMINAL_WAIT_POLL_INTERVAL_MS = 25;

export interface ProjectionTerminalWaitOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Used only by the explicit no-notifications placement fallback. */
  readonly pollingFallbackIntervalMs?: number;
}

export interface ProjectionTerminalWaitResult {
  readonly cursor: string;
  readonly state: AgentState;
  readonly reason: "terminal" | "timeout" | "cancelled";
  readonly mode: "notifications" | "polling-fallback";
}

export interface CurrentBranchProjection {
  readonly sessionId: string;
  readonly branchId: string;
  readonly state: AgentState;
}

export class ProjectionService {
  constructor(readonly storage: AgentStorage) {}

  /**
   * Loads each current branch through the verified snapshot path once. Startup
   * recovery shares this bounded view instead of independently replaying every
   * branch for each recovery subsystem.
   */
  async currentBranches(): Promise<CurrentBranchProjection[]> {
    const result: CurrentBranchProjection[] = [];
    for (const branch of await this.storage.listBranches()) {
      const { state } = await this.getSnapshot(branch.sessionId, branch.branchId);
      result.push({ ...branch, state });
    }
    return result;
  }

  async getSnapshot(sessionId: string, branchId: string): Promise<{ cursor: string; state: AgentState }> {
    const latest = await this.storage.getLatestCursor(sessionId, branchId);
    if (!latest) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const cached = await this.storage.loadSnapshot(sessionId, branchId);
    if (cached && cached.cursor === latest) return { cursor: cached.cursor, state: cached };
    if (cached && BigInt(cached.cursor) < BigInt(latest)) {
      const events = await this.storage.loadEvents(sessionId, { branchId, afterCursor: cached.cursor });
      if (events.length) {
        const state = events.reduce<AgentState>((current, event) => reduceAgentState(current, event), cached);
        await this.storage.saveSnapshot(state);
        return { cursor: state.cursor, state };
      }
    }
    const events = await this.storage.loadEvents(sessionId, { branchId });
    const state = projectEvents(events);
    await this.storage.saveSnapshot(state);
    return { cursor: state.cursor, state };
  }

  async atCursor(sessionId: string, branchId: string, cursor: string): Promise<AgentState> {
    validateCursor(cursor);
    const events = await this.storage.loadEvents(sessionId, { branchId, untilCursor: cursor });
    if (events.length === 0) throw new NotFoundError("event cursor", cursor);
    return projectEvents(events);
  }

  async rebuild(sessionId: string, branchId: string): Promise<AgentState> {
    await this.storage.deleteSnapshots(sessionId);
    const events = await this.storage.loadEvents(sessionId, { branchId });
    const first = projectEvents(events);
    const second = projectEvents(events);
    if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("Projection is not deterministic");
    await this.storage.saveSnapshot(first);
    return first;
  }

  async history(sessionId: string, branchId: string): Promise<AgentEvent[]> {
    const events = await this.storage.loadEvents(sessionId, { branchId });
    if (!events.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    return events;
  }

  /**
   * Race-safe terminal wait over one canonical branch.
   *
   * Notification-capable placements use snapshot plus cursor catch-up. A
   * centralized polling fallback is selected only when the relational adapter
   * truthfully advertises that notifications are unavailable.
   */
  async waitForTerminal(
    sessionId: string,
    branchId: string,
    terminal: (state: AgentState) => boolean | Promise<boolean>,
    options: ProjectionTerminalWaitOptions = {},
  ): Promise<ProjectionTerminalWaitResult> {
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined &&
        (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 86_400_000)) {
      throw new Error("Projection terminal wait timeout must be from 0 to 86400000ms");
    }
    const interval = options.pollingFallbackIntervalMs ??
      DEFAULT_TERMINAL_WAIT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 60_000) {
      throw new Error("Projection terminal polling fallback interval must be from 1 to 60000ms");
    }
    const deadline = timeoutMs === undefined
      ? Number.POSITIVE_INFINITY
      : Date.now() + timeoutMs;
    const initial = await this.getSnapshot(sessionId, branchId);
    if (await terminal(initial.state)) {
      const final = await this.getSnapshot(sessionId, branchId);
      return {
        ...final,
        reason: "terminal",
        mode: this.storage.capabilities.notifications
          ? "notifications"
          : "polling-fallback",
      };
    }
    if (!this.storage.capabilities.notifications) {
      return this.#waitByPollingFallback(
        sessionId,
        branchId,
        terminal,
        initial,
        deadline,
        interval,
        options.signal,
      );
    }

    let dirty = false;
    let wake: (() => void) | undefined;
    let state = initial.state;
    const unsubscribe = this.subscribe(
      sessionId,
      branchId,
      initial.cursor,
      (event) => {
        state = reduceAgentState(state, event);
        dirty = true;
        wake?.();
      },
    );
    let reason: ProjectionTerminalWaitResult["reason"] = "timeout";
    try {
      while (true) {
        if (await terminal(state)) {
          reason = "terminal";
          break;
        }
        if (options.signal?.aborted) {
          reason = "cancelled";
          break;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          reason = "timeout";
          break;
        }
        if (dirty) {
          dirty = false;
          continue;
        }
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            options.signal?.removeEventListener("abort", finish);
            if (wake === finish) wake = undefined;
            resolve();
          };
          const timer = Number.isFinite(remaining)
            ? setTimeout(finish, remaining)
            : undefined;
          wake = finish;
          options.signal?.addEventListener("abort", finish, { once: true });
          // Close the event-between-check-and-arm race.
          if (dirty || options.signal?.aborted) finish();
        });
        dirty = false;
      }
    } finally {
      wake?.();
      wake = undefined;
      unsubscribe();
    }
    const final = await this.getSnapshot(sessionId, branchId);
    return {
      ...final,
      reason: await terminal(final.state) ? "terminal" : reason,
      mode: "notifications",
    };
  }

  async #waitByPollingFallback(
    sessionId: string,
    branchId: string,
    terminal: (state: AgentState) => boolean | Promise<boolean>,
    initial: { cursor: string; state: AgentState },
    deadline: number,
    interval: number,
    signal?: AbortSignal,
  ): Promise<ProjectionTerminalWaitResult> {
    let current = initial;
    let reason: ProjectionTerminalWaitResult["reason"] = "timeout";
    while (true) {
      if (await terminal(current.state)) {
        reason = "terminal";
        break;
      }
      if (signal?.aborted) {
        reason = "cancelled";
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reason = "timeout";
        break;
      }
      await abortableDelay(Math.min(interval, remaining), signal);
      current = await this.getSnapshot(sessionId, branchId);
    }
    const final = await this.getSnapshot(sessionId, branchId);
    return {
      ...final,
      reason: await terminal(final.state) ? "terminal" : reason,
      mode: "polling-fallback",
    };
  }

  /**
   * Notifications only mark the durable stream dirty. Every delivery is pulled
   * from storage after the current cursor, closing the snapshot/catch-up race and
   * preserving database cursor order even when commit callbacks arrive late.
   */
  subscribe(
    sessionId: string,
    branchId: string,
    afterCursor: string,
    onEvent: (event: AgentEvent) => void,
  ): () => void {
    validateCursor(afterCursor);
    let cursor = afterCursor;
    let active = true;
    let dirty = true;
    let pumping = false;

    const pump = async (): Promise<void> => {
      if (!active || pumping) return;
      pumping = true;
      try {
        while (active && dirty) {
          dirty = false;
          const events = await this.storage.loadEvents(sessionId, { branchId, afterCursor: cursor });
          for (const event of events) {
            if (!active) break;
            if (BigInt(event.cursor) <= BigInt(cursor)) continue;
            cursor = event.cursor; // advance before user code can cause another commit
            try { onEvent(event); } catch { /* a consumer cannot stop durable delivery */ }
          }
        }
      } finally {
        pumping = false;
        if (active && dirty) void pump();
      }
    };

    const unsubscribe = this.storage.onCommitted((events) => {
      if (events.some((event) => event.sessionId === sessionId &&
          (event.branchId === branchId ||
            event.type === "AgentProfileVersionCreated" ||
            event.type === "AgentProfileActivated"))) {
        dirty = true;
        void pump();
      }
    });
    void pump();
    return () => {
      active = false;
      unsubscribe();
    };
  }

  async *events(
    sessionId: string,
    branchId: string,
    afterCursor: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = this.subscribe(sessionId, branchId, afterCursor, (event) => {
      queue.push(event);
      wake?.();
      wake = undefined;
    });
    const abort = () => { wake?.(); wake = undefined; };
    signal?.addEventListener("abort", abort);
    try {
      while (!signal?.aborted) {
        if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
        while (queue.length) {
          const event = queue.shift();
          if (event) yield event;
        }
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      unsubscribe();
    }
  }
}

export interface AgentEventSource {
  getSnapshot(sessionId: string, branchId: string): Promise<{ cursor: string; state: AgentState }>;
  subscribe(
    sessionId: string,
    branchId: string,
    afterCursor: string,
    onEvent: (event: AgentEvent) => void,
  ): () => void;
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || milliseconds <= 0) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

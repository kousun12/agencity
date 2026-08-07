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

export class ProjectionService {
  constructor(readonly storage: AgentStorage) {}

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
      if (events.some((event) => event.sessionId === sessionId && event.branchId === branchId)) {
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

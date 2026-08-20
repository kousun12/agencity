import {
  projectEvents,
  reduceAgentState,
  type AgentEvent,
  type AgentState,
} from "../domain/index.ts";
import type { AgentStorage } from "../storage/index.ts";

interface CachedBranchHistory {
  cursor: string;
  events: AgentEvent[];
  eventsById: Map<string, AgentEvent>;
  eventIndexById: Map<string, number>;
  state: AgentState;
}

/**
 * Reuses the canonical snapshot and advances retained branch history from its
 * last cursor. The cache is rebuildable and never owns durable meaning.
 */
export class IncrementalBranchHistory {
  readonly #branches = new Map<string, CachedBranchHistory>();
  readonly #tails = new Map<string, Promise<void>>();

  constructor(readonly storage: AgentStorage) {}

  async load(
    sessionId: string,
    branchId: string,
  ): Promise<{
    state: AgentState;
    events: readonly AgentEvent[];
    eventsById: ReadonlyMap<string, AgentEvent>;
    eventIndexById: ReadonlyMap<string, number>;
    newEvents: readonly AgentEvent[];
  }> {
    const key = `${sessionId}\u0000${branchId}`;
    const prior = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => {}).then(() => current);
    this.#tails.set(key, tail);
    await prior.catch(() => {});
    try {
      return await this.#load(sessionId, branchId, key);
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }

  async #load(
    sessionId: string,
    branchId: string,
    key: string,
  ): Promise<{
    state: AgentState;
    events: readonly AgentEvent[];
    eventsById: ReadonlyMap<string, AgentEvent>;
    eventIndexById: ReadonlyMap<string, number>;
    newEvents: readonly AgentEvent[];
  }> {
    let cached = this.#branches.get(key);
    let added: AgentEvent[];
    if (!cached) {
      added = await this.storage.loadEvents(sessionId, { branchId });
      const state = projectEvents(added);
      cached = {
        cursor: state.cursor,
        events: [...added],
        eventsById: new Map(added.map((event) => [event.id, event])),
        eventIndexById: new Map(added.map((event, index) => [event.id, index])),
        state,
      };
      this.#branches.set(key, cached);
    } else {
      added = await this.storage.loadEvents(sessionId, {
        branchId,
        afterCursor: cached.cursor,
      });
      for (const event of added) {
        cached.state = reduceAgentState(cached.state, event);
        cached.eventIndexById.set(event.id, cached.events.length);
        cached.events.push(event);
        cached.eventsById.set(event.id, event);
      }
      if (added.length) cached.cursor = added.at(-1)!.cursor;
    }
    return {
      state: cached.state,
      events: cached.events,
      eventsById: cached.eventsById,
      eventIndexById: cached.eventIndexById,
      newEvents: added,
    };
  }

  clear(sessionId?: string, branchId?: string): void {
    if (sessionId === undefined) {
      this.#branches.clear();
      return;
    }
    if (branchId !== undefined) {
      this.#branches.delete(`${sessionId}\u0000${branchId}`);
      return;
    }
    for (const key of this.#branches.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) this.#branches.delete(key);
    }
  }
}

import type { AgentState, TaskState } from "../domain/index.ts";
import {
  OBSERVER_BOUNDS,
  type InternalObserverFamily,
  type InternalObserverRouteSnapshot,
  type InternalObserverTaskEdge,
  type ObserverRoute,
  type ObserverSnapshotSource,
} from "./types.ts";

export function observerRouteKey(route: ObserverRoute): string {
  return `${route.sessionId}\u0000${route.branchId}`;
}

function unavailableRoute(
  route: ObserverRoute,
  reason: InternalObserverRouteSnapshot["unavailableReason"],
): InternalObserverRouteSnapshot {
  return {
    route,
    state: null,
    cursor: null,
    availability: "route_unavailable",
    unavailableReason: reason,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Observer family discovery aborted");
}

function orderedTasks(state: AgentState): TaskState[] {
  const order = new Map(state.appliedEventIds.map((eventId, index) => [eventId, index]));
  return Object.values(state.tasks).sort((left, right) => {
    const leftOrder = order.get(left.eventId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.eventId) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.id.localeCompare(right.id);
  });
}

async function loadOne(
  source: ObserverSnapshotSource,
  route: ObserverRoute,
  signal?: AbortSignal,
): Promise<InternalObserverRouteSnapshot> {
  throwIfAborted(signal);
  try {
    const loaded = await source.loadRouteSnapshot(route, signal);
    throwIfAborted(signal);
    if (loaded.state.sessionId !== route.sessionId ||
        loaded.state.branch.id !== route.branchId ||
        loaded.cursor !== loaded.state.cursor) {
      return unavailableRoute(route, "invalid_snapshot");
    }
    return {
      route,
      state: loaded.state,
      cursor: loaded.cursor,
      availability: "available",
      unavailableReason: null,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return unavailableRoute(route, "snapshot_unavailable");
  }
}

export async function discoverObserverFamily(
  root: ObserverRoute,
  source: ObserverSnapshotSource,
  options: {
    readonly signal?: AbortSignal;
    readonly maximumRoutes?: number;
    readonly maximumConcurrency?: number;
  } = {},
): Promise<InternalObserverFamily> {
  const maximumRoutes = Math.max(
    1,
    Math.min(OBSERVER_BOUNDS.familyRoutes, Math.floor(options.maximumRoutes ?? OBSERVER_BOUNDS.familyRoutes)),
  );
  const maximumConcurrency = Math.max(
    1,
    Math.min(
      OBSERVER_BOUNDS.familyDiscoveryConcurrency,
      Math.floor(options.maximumConcurrency ?? OBSERVER_BOUNDS.familyDiscoveryConcurrency),
    ),
  );
  const routes = new Map<string, InternalObserverRouteSnapshot>();
  const edges: InternalObserverTaskEdge[] = [];
  const rootKey = observerRouteKey(root);
  routes.set(rootKey, unavailableRoute(root, "snapshot_unavailable"));
  const queue: ObserverRoute[] = [root];
  let truncated = false;
  let edgesTruncated = false;

  while (queue.length > 0) {
    throwIfAborted(options.signal);
    const batch = queue.splice(0, maximumConcurrency);
    const loadedBatch = await Promise.all(
      batch.map((route) => loadOne(source, route, options.signal)),
    );
    for (const loaded of loadedBatch) {
      routes.set(observerRouteKey(loaded.route), loaded);
      if (!loaded.state || loaded.cursor === null) continue;
      for (const task of orderedTasks(loaded.state)) {
        const child: ObserverRoute = {
          sessionId: task.childSessionId,
          branchId: task.childBranchId,
        };
        if (edges.length < OBSERVER_BOUNDS.familyEdges) {
          edges.push({
            taskId: task.id,
            parent: loaded.route,
            child,
            taskSummary: task.task,
            taskStatus: task.status,
            cancellationRequested: task.cancellationRequested,
            eventId: task.eventId,
            snapshotCursor: loaded.cursor,
          });
        } else {
          edgesTruncated = true;
        }
        const key = observerRouteKey(child);
        if (routes.has(key)) continue;
        if (routes.size >= maximumRoutes) {
          truncated = true;
          continue;
        }
        routes.set(key, unavailableRoute(child, "snapshot_unavailable"));
        queue.push(child);
      }
    }
  }

  return { root, routes, edges, truncated, edgesTruncated };
}

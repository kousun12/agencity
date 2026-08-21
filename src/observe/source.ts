import type { AgentEvent, SessionTitlePresentation } from "../domain/index.ts";
import type {
  ObserverProgressInput,
  ObserverRoute,
  ObserverSnapshotLoadResult,
  ObserverSnapshotSource,
} from "./types.ts";

export interface ObserverRootRoute {
  readonly route: ObserverRoute;
  readonly name: string;
  readonly sessionTitle?: SessionTitlePresentation;
  readonly status: string;
  readonly worker: "running" | "idle" | "detached";
  readonly unresolvedWork: number;
}

export interface ObserverSourceStreamHandlers {
  readonly onEvent: (event: AgentEvent) => unknown | Promise<unknown>;
  readonly onProgress: (progress: ObserverProgressInput) => unknown | Promise<unknown>;
  readonly onComment: () => unknown | Promise<unknown>;
}

/** Closed read-only boundary used by the observer lifecycle. */
export interface ObserverSource extends ObserverSnapshotSource {
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly applicationVersion: string;
  roots(signal?: AbortSignal): Promise<readonly ObserverRootRoute[]>;
  streamRoute(
    route: ObserverRoute,
    afterCursor: string,
    handlers: ObserverSourceStreamHandlers,
    signal: AbortSignal,
  ): Promise<void>;
  close(reason?: string): void;
}

export type ObserverSourceAvailability =
  | "service_stopped"
  | "service_stale"
  | "service_conflict"
  | "service_incompatible"
  | "connecting";

export type ObserverSourceConnection =
  | {
      readonly kind: "connected";
      readonly source: ObserverSource;
    }
  | {
      readonly kind: ObserverSourceAvailability;
      readonly reason: string;
    };

export interface ObserverSourceFactory {
  connect(input: {
    readonly workspaceRoot: string;
    readonly workspaceId: string;
    readonly signal?: AbortSignal;
  }): Promise<ObserverSourceConnection>;
}

export function observerSnapshotSource(source: ObserverSource): ObserverSnapshotSource {
  return {
    loadRouteSnapshot(
      route: ObserverRoute,
      signal?: AbortSignal,
    ): Promise<ObserverSnapshotLoadResult> {
      return source.loadRouteSnapshot(route, signal);
    },
  };
}

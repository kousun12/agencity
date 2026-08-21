import type { AgentEvent, AgentState, SessionStatus } from "../domain/index.ts";

export const OBSERVER_PROTOCOL = "agencity.observe.v1" as const;

export const OBSERVER_BOUNDS = Object.freeze({
  familyRoutes: 64,
  familyDiscoveryConcurrency: 4,
  familyEdges: 512,
  familyMessages: 200,
  familySnapshotBytes: 512 * 1024,
  detailItems: 50,
  detailPageBytes: 128 * 1024,
  textBytes: 16 * 1024,
  shortTextBytes: 1_024,
  activityItems: 200,
  activityBytes: 1 * 1024 * 1024,
  replayEnvelopes: 512,
  replayBytes: 2 * 1024 * 1024,
  streamEnvelopeBytes: 64 * 1024,
});

export interface ObserverRoute {
  readonly sessionId: string;
  readonly branchId: string;
}

export interface ObserverItemProvenance {
  /** The event retained on the current projected item, when one exists. */
  readonly itemEventId: string | null;
  /** The cursor enclosing the current projection, not the item's historical cursor. */
  readonly snapshotCursor: string;
  /** Present only when the projection itself retains an exact item cursor. */
  readonly exactEventCursor: string | null;
}

export type ObserverBoundedText =
  | {
      readonly kind: "complete";
      readonly text: string;
      readonly originalUtf8Bytes: number;
      readonly visibleUtf8Bytes: number;
      readonly omittedUtf8Bytes: 0;
      readonly digest: string | null;
    }
  | {
      readonly kind: "prefix";
      readonly prefix: string;
      readonly originalUtf8Bytes: number;
      readonly visibleUtf8Bytes: number;
      readonly omittedUtf8Bytes: number;
      readonly digest: string | null;
    }
  | {
      readonly kind: "head_tail";
      readonly head: string;
      readonly tail: string;
      readonly originalUtf8Bytes: number;
      readonly visibleUtf8Bytes: number;
      readonly omittedUtf8Bytes: number;
      readonly digest: string | null;
    };

export type ObserverRouteActivity = "working" | "idle" | "attention" | "ended" | "unavailable";
export type ObserverRouteActivityReason =
  | "missing_state"
  | "cancellation_pending"
  | "unknown"
  | "budget_exceeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "archived"
  | null;

export interface ObserverFamilyNodeDto {
  readonly route: ObserverRoute;
  readonly depth: number | null;
  readonly availability: "available" | "route_unavailable";
  readonly unavailableReason: "snapshot_unavailable" | "invalid_snapshot" | null;
  readonly sessionName: ObserverBoundedText | null;
  readonly branchName: ObserverBoundedText | null;
  readonly model: {
    readonly provider: ObserverBoundedText;
    readonly model: ObserverBoundedText;
  } | null;
  readonly taskId: string | null;
  readonly taskSummary: ObserverBoundedText | null;
  readonly sessionStatus: SessionStatus | null;
  readonly activity: ObserverRouteActivity;
  readonly activityReason: ObserverRouteActivityReason;
  readonly snapshotCursor: string | null;
}

export interface ObserverFamilyEdgeDto {
  readonly taskId: string;
  readonly parent: ObserverRoute;
  readonly child: ObserverRoute;
  readonly taskSummary: ObserverBoundedText;
  readonly taskStatus: string;
  readonly cancellationRequested: boolean;
  readonly provenance: ObserverItemProvenance;
}

export type ObserverMailboxLifecycle = "sent" | "delivered" | "delivered_to_context" | "acknowledged" | "failed";

export interface ObserverMailboxLifecycleDto {
  readonly mailboxMessageId: string;
  readonly from: ObserverRoute;
  readonly to: ObserverRoute;
  readonly taskId: string | null;
  readonly kind: string;
  readonly lifecycle: ObserverMailboxLifecycle;
  readonly stages: readonly ObserverMailboxLifecycle[];
  readonly conflict: boolean;
  readonly itemEventIds: readonly string[];
  readonly itemEventIdsTruncated: boolean;
  readonly omittedItemEventIdCount: number;
}

export interface ObserverFamilyOverviewDto {
  readonly version: typeof OBSERVER_PROTOCOL;
  readonly root: ObserverRoute;
  readonly nodes: readonly ObserverFamilyNodeDto[];
  readonly delegationEdges: readonly ObserverFamilyEdgeDto[];
  readonly mailboxEdges: readonly ObserverMailboxLifecycleDto[];
  readonly routeCursors: Readonly<Record<string, string>>;
  readonly truncation: {
    readonly familyRoutes: boolean;
    readonly graphEdges: boolean;
    readonly mailboxEdges: boolean;
    readonly byteLimit: boolean;
    readonly exactOmittedRouteCount: null;
  };
}

export const OBSERVER_DETAIL_SECTIONS = [
  "identity",
  "runs",
  "model_attempts",
  "cells",
  "effects",
  "tasks",
  "mailbox",
  "budget",
  "goals",
  "gates",
  "artifacts",
  "terminal_outcomes",
] as const;
export type ObserverDetailSection = (typeof OBSERVER_DETAIL_SECTIONS)[number];

export interface ObserverDetailItemDto {
  readonly kind: ObserverDetailSection | "terminal_run" | "terminal_notice" | "terminal_task";
  readonly id: string;
  readonly provenance: ObserverItemProvenance;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ObserverDetailPageDto {
  readonly version: typeof OBSERVER_PROTOCOL;
  readonly route: ObserverRoute;
  readonly section: ObserverDetailSection;
  readonly snapshotCursor: string;
  readonly items: readonly ObserverDetailItemDto[];
  readonly pagination: {
    readonly cursor: string | null;
    readonly nextCursor: string | null;
    readonly limit: number;
  };
  readonly truncation: {
    readonly itemLimit: boolean;
    readonly byteLimit: boolean;
  };
}

export interface ObserverSnapshotLoadResult {
  readonly cursor: string;
  readonly state: AgentState;
}

export interface ObserverSnapshotSource {
  loadRouteSnapshot(route: ObserverRoute, signal?: AbortSignal): Promise<ObserverSnapshotLoadResult>;
}

export interface InternalObserverRouteSnapshot {
  readonly route: ObserverRoute;
  readonly state: AgentState | null;
  readonly cursor: string | null;
  readonly availability: "available" | "route_unavailable";
  readonly unavailableReason: "snapshot_unavailable" | "invalid_snapshot" | null;
}

export interface InternalObserverTaskEdge {
  readonly taskId: string;
  readonly parent: ObserverRoute;
  readonly child: ObserverRoute;
  readonly taskSummary: string;
  readonly taskStatus: string;
  readonly cancellationRequested: boolean;
  readonly eventId: string;
  readonly snapshotCursor: string;
}

export interface InternalObserverFamily {
  readonly root: ObserverRoute;
  readonly routes: ReadonlyMap<string, InternalObserverRouteSnapshot>;
  readonly edges: readonly InternalObserverTaskEdge[];
  readonly truncated: boolean;
  readonly edgesTruncated: boolean;
}

export interface ObserverDurableActivityDto {
  readonly route: ObserverRoute;
  readonly eventId: string;
  readonly cursor: string;
  readonly type: AgentEvent["type"];
  readonly producer: string;
  readonly committedAt: string;
}

export interface ObserverProgressInput {
  readonly effectId: string;
  readonly stage: string;
  readonly message?: string;
}

export type ObserverStreamPayload =
  | { readonly kind: "committed_event"; readonly activity: ObserverDurableActivityDto }
  | { readonly kind: "progress"; readonly route: ObserverRoute; readonly effectId: string; readonly stage: ObserverBoundedText; readonly message: ObserverBoundedText | null }
  | { readonly kind: "progress_cleared"; readonly route: ObserverRoute; readonly effectId: string; readonly reason: "committed" | "disconnect" | "generation_replaced" | "resync" }
  | { readonly kind: "resync_required"; readonly reason: "replay_overflow" | "generation_mismatch" | "replay_unavailable" };

export interface ObserverStreamEnvelope {
  readonly version: typeof OBSERVER_PROTOCOL;
  readonly generation: string;
  readonly sequence: number;
  readonly managedInstanceId: string;
  readonly payload: ObserverStreamPayload;
}

export interface ObserverRouteProjection {
  readonly route: ObserverRoute;
  readonly state: AgentState;
  readonly cursor: string;
}

export interface ObserverGenerationState {
  readonly generation: string;
  readonly managedInstanceId: string;
  readonly sequence: number;
  readonly routes: ReadonlyMap<string, ObserverRouteProjection>;
  readonly progress: ReadonlyMap<string, {
    readonly route: ObserverRoute;
    readonly effectId: string;
    readonly stage: ObserverBoundedText;
    readonly message: ObserverBoundedText | null;
  }>;
  readonly activity: readonly ObserverDurableActivityDto[];
  readonly activityBytes: number;
  readonly replay: readonly ObserverStreamEnvelope[];
  readonly replayBytes: number;
  readonly replayFloorSequence: number;
}

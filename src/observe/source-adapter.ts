import {
  REDUCER_VERSION,
  type AgentState,
  type SessionTitlePresentation,
} from "../domain/index.ts";
import { AgentClient, type ProtocolCapabilities } from "../protocol/index.ts";
import { readServiceManifestReadOnly } from "../product/service-discovery.ts";
import type {
  ObserverRootRoute,
  ObserverSource,
  ObserverSourceConnection,
  ObserverSourceFactory,
  ObserverSourceStreamHandlers,
} from "./source.ts";
import type { ObserverRoute, ObserverSnapshotLoadResult } from "./types.ts";

const REQUIRED_PROTOCOL_REVISION = 4;
const READ_TIMEOUT_MS = 5_000;
const MAX_ROOT_ROWS = 10_000;
const MAX_ROOT_NAME_BYTES = 16 * 1024;

type ManagedHealth = Awaited<ReturnType<AgentClient["health"]>>;

function linkedTimeout(
  external: AbortSignal | undefined,
  timeoutMs = READ_TIMEOUT_MS,
): { readonly signal: AbortSignal; readonly release: () => void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort(external?.reason);
  if (external?.aborted) abort();
  else external?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException("Observer managed read timed out", "TimeoutError")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    release(): void {
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    },
  };
}

async function boundedRead<T>(
  external: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = linkedTimeout(external);
  try {
    return await operation(timeout.signal);
  } finally {
    timeout.release();
  }
}

function supportsRequiredProtocol(value: {
  readonly protocolMin?: number;
  readonly protocolMax?: number;
}): boolean {
  return Number.isSafeInteger(value.protocolMin) &&
    Number.isSafeInteger(value.protocolMax) &&
    value.protocolMin! <= REQUIRED_PROTOCOL_REVISION &&
    value.protocolMax! >= REQUIRED_PROTOCOL_REVISION;
}

function supportsObserve(capabilities: ProtocolCapabilities): boolean {
  return capabilities.managedService === true &&
    capabilities.productCatalog === true &&
    capabilities.snapshotCursorResume === true &&
    capabilities.committedEventDeduplication === true &&
    capabilities.cursorlessProgress === true;
}

function unauthorized(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "status" in error && Number((error as { readonly status?: unknown }).status) === 401;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCursor(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{1,20}$/.test(value) &&
    Number.isSafeInteger(Number(value));
}

function validNullableCursor(value: unknown): value is string | null {
  return value === null || validCursor(value);
}

function validTitleText(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_ROOT_NAME_BYTES;
}

function validSessionTitlePresentation(value: unknown): value is SessionTitlePresentation {
  if (!record(value) ||
      !validTitleText(value.text) ||
      !["model", "deterministic_fallback", "explicit", "ordinary_fallback"].includes(String(value.source)) ||
      !validNullableCursor(value.sourceMessageCursor)) return false;
  return ["verb", "subject", "intentSummary"].every((field) =>
    value[field] === null || validTitleText(value[field]));
}

function validateSnapshot(
  route: ObserverRoute,
  workspaceId: string,
  value: unknown,
): ObserverSnapshotLoadResult {
  if (!record(value) || !validCursor(value.cursor) || !record(value.state)) {
    throw new Error("Managed route snapshot is invalid");
  }
  const state = value.state;
  if (state.reducerVersion !== REDUCER_VERSION ||
      state.sessionId !== route.sessionId ||
      state.workspaceId !== workspaceId ||
      state.cursor !== value.cursor ||
      !record(state.branch) || state.branch.id !== route.branchId ||
      !Array.isArray(state.appliedEventIds) ||
      state.appliedEventIds.some(eventId => typeof eventId !== "string") ||
      !Array.isArray(state.messages) ||
      !(state.sessionName === null || state.sessionName === undefined || typeof state.sessionName === "string")) {
    throw new Error("Managed route snapshot identity is invalid");
  }
  for (const field of [
    "agentProfiles", "cells", "workingValues", "artifacts", "effects",
    "effectReconciliations", "managedProcesses", "contexts", "compactions",
    "modelCalls", "tasks", "mailbox", "taskUsageAttributions", "terminalNotices",
    "documents", "inputSets", "goals", "heartbeats", "schedules", "wakes",
    "recursiveModels", "aiGenerations", "agentRuns", "userCorrections",
    "refinementReviews", "refinementTriggerConsumptions",
  ]) {
    if (!record(state[field])) throw new Error("Managed route snapshot projection is invalid");
  }
  if (!record(state.model) || !record(state.budget)) {
    throw new Error("Managed route snapshot projection is invalid");
  }
  if (!record(state.sessionTitle) ||
      !["automatic", "manual"].includes(String(state.sessionTitle.mode)) ||
      !validNullableCursor(state.sessionTitle.latestRequestedSourceMessageCursor) ||
      !validNullableCursor(state.sessionTitle.appliedSourceMessageCursor) ||
      !record(state.sessionTitle.requests) ||
      !record(state.sessionTitle.resolutions)) {
    throw new Error("Managed route snapshot title projection is invalid");
  }
  return { cursor: value.cursor, state: state as unknown as AgentState };
}

class AgentClientObserverSource implements ObserverSource {
  constructor(
    private readonly client: AgentClient,
    readonly workspaceId: string,
    readonly instanceId: string,
    readonly applicationVersion: string,
  ) {}

  async roots(signal?: AbortSignal): Promise<readonly ObserverRootRoute[]> {
    const values = await boundedRead(signal, scoped => this.client.serviceAgents(scoped));
    if (!Array.isArray(values) || values.length > MAX_ROOT_ROWS) {
      throw new Error("Managed root listing is invalid");
    }
    return values.map((value): ObserverRootRoute => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Managed root row is invalid");
      }
      const row = value as unknown as Record<string, unknown>;
      if (typeof row.sessionId !== "string" || row.sessionId.length < 1 || row.sessionId.length > 256 ||
          typeof row.branchId !== "string" || row.branchId.length < 1 || row.branchId.length > 256 ||
          typeof row.name !== "string" || Buffer.byteLength(row.name, "utf8") > MAX_ROOT_NAME_BYTES ||
          !(row.sessionTitle === undefined || validSessionTitlePresentation(row.sessionTitle)) ||
          typeof row.status !== "string" ||
          !["idle", "running", "stopped", "failed", "archived"].includes(row.status) ||
          !["running", "idle", "detached"].includes(String(row.worker)) ||
          !Number.isSafeInteger(row.unresolvedWork) || Number(row.unresolvedWork) < 0) {
        throw new Error("Managed root row is invalid");
      }
      return {
        route: { sessionId: row.sessionId, branchId: row.branchId },
        name: row.name,
        sessionTitle: row.sessionTitle ?? {
          text: row.name,
          source: "ordinary_fallback",
          verb: null,
          subject: null,
          intentSummary: null,
          sourceMessageCursor: null,
        },
        status: row.status,
        worker: row.worker as ObserverRootRoute["worker"],
        unresolvedWork: Number(row.unresolvedWork),
      };
    });
  }

  async loadRouteSnapshot(
    route: ObserverRoute,
    signal?: AbortSignal,
  ): Promise<ObserverSnapshotLoadResult> {
    const value = await boundedRead(signal, scoped =>
      this.client.snapshot(route.sessionId, route.branchId, scoped));
    return validateSnapshot(route, this.workspaceId, value);
  }

  streamRoute(
    route: ObserverRoute,
    afterCursor: string,
    handlers: ObserverSourceStreamHandlers,
    signal: AbortSignal,
  ): Promise<void> {
    return this.client.stream(route.sessionId, route.branchId, afterCursor, {
      onEvent: handlers.onEvent,
      onComment: async () => handlers.onComment(),
      onProgress: async progress => handlers.onProgress({
        effectId: progress.effectId,
        stage: progress.kind,
        message: JSON.stringify(progress.value),
      }),
    }, signal);
  }

  close(reason = "Observer source detached"): void {
    this.client.abortPendingRequests(reason);
  }
}

export const agentClientObserverSourceFactory: ObserverSourceFactory = Object.freeze({
  async connect(
    input: Parameters<ObserverSourceFactory["connect"]>[0],
  ): Promise<ObserverSourceConnection> {
    let manifest;
    try {
      manifest = await readServiceManifestReadOnly({
        workspaceRoot: input.workspaceRoot,
        workspaceId: input.workspaceId,
      });
    } catch {
      return { kind: "service_conflict", reason: "Managed service discovery metadata is invalid or unsafe" };
    }
    if (manifest === null) {
      return { kind: "service_stopped", reason: "Managed workspace service is not running" };
    }
    if (!supportsRequiredProtocol(manifest)) {
      return { kind: "service_incompatible", reason: "Managed service protocol revision 4 is required" };
    }

    const client = new AgentClient(manifest.url, manifest.bearerToken);
    let health: ManagedHealth;
    try {
      health = await boundedRead(input.signal, signal => client.health(signal));
    } catch (error) {
      client.abortPendingRequests();
      return unauthorized(error)
        ? { kind: "service_conflict", reason: "Managed service authentication was rejected" }
        : { kind: "service_stale", reason: "Managed service is unreachable" };
    }
    if (health.ok !== true || health.authenticated !== true ||
        health.workspaceId !== input.workspaceId ||
        health.instanceId !== manifest.instanceId) {
      client.abortPendingRequests();
      return { kind: "service_conflict", reason: "Managed service identity does not match discovery metadata" };
    }
    if (!supportsRequiredProtocol(health)) {
      client.abortPendingRequests();
      return { kind: "service_incompatible", reason: "Authenticated service does not include protocol revision 4" };
    }
    if (health.ready !== true) {
      client.abortPendingRequests();
      return { kind: "connecting", reason: "Managed service is not ready" };
    }

    let capabilities: ProtocolCapabilities;
    try {
      capabilities = await boundedRead(input.signal, signal => client.capabilities(signal));
    } catch (error) {
      client.abortPendingRequests();
      return unauthorized(error)
        ? { kind: "service_conflict", reason: "Managed capability authentication was rejected" }
        : { kind: "service_stale", reason: "Managed service capabilities are unavailable" };
    }
    if (!supportsObserve(capabilities)) {
      client.abortPendingRequests();
      return { kind: "service_incompatible", reason: "Managed service lacks required observation capabilities" };
    }
    return {
      kind: "connected",
      source: new AgentClientObserverSource(
        client,
        input.workspaceId,
        manifest.instanceId,
        health.appVersion ?? manifest.appVersion,
      ),
    };
  },
});

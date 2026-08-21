import { lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { AgentEvent } from "../domain/index.ts";
import { observeWorkspace } from "../product/workspace.ts";
import {
  passiveDiscoveryPaths,
  startPassivePathPolling,
  type PassivePathPollHandle,
} from "../product/passive-path-poll.ts";
import { serializedUtf8Bytes } from "./bounds.ts";
import { discoverObserverFamily, observerRouteKey } from "./discovery.ts";
import {
  applyObserverCommittedEvent,
  createObserverGeneration,
  discardObserverProgress,
  recordObserverProgress,
  replayObserverEnvelopes,
} from "./generation.ts";
import {
  deriveObserverDetailPage,
  deriveObserverFamilyOverview,
} from "./projection.ts";
import {
  OBSERVER_DETAIL_SECTIONS,
  OBSERVER_PROTOCOL,
  type InternalObserverFamily,
  type InternalObserverRouteSnapshot,
  type ObserverDetailSection,
  type ObserverGenerationState,
  type ObserverRoute,
  type ObserverStreamEnvelope,
} from "./types.ts";
import type {
  ObserverRootRoute,
  ObserverSource,
  ObserverSourceFactory,
} from "./source.ts";

const ROOT_PAGE_ITEMS = 100;
const ROOT_PAGE_BYTES = 256 * 1024;
const DEFAULT_STREAM_SILENCE_MS = 45_000;
const DEFAULT_REDISCOVERY_MS = 1_000;

export type ObserverAvailability =
  | "workspace_uninitialized"
  | "service_stopped"
  | "service_stale"
  | "service_conflict"
  | "service_incompatible"
  | "connecting"
  | "connected"
  | "resyncing"
  | "route_unavailable"
  | "family_truncated";

export type ObserverControllerUpdate =
  | { readonly kind: "envelope"; readonly envelope: ObserverStreamEnvelope }
  | { readonly kind: "resync" };

export interface ObserverControllerOptions {
  readonly workspaceRoot: string;
  readonly sourceFactory: ObserverSourceFactory;
  readonly streamSilenceMs?: number;
  readonly rediscoveryMs?: number;
  readonly passivePollIntervalMs?: number;
  readonly now?: () => number;
}

export interface ObserverRootPage {
  readonly items: readonly (ObserverRootRoute & { readonly selectable: boolean })[];
  readonly selectableCount: number;
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

export interface ObserverBrowserSnapshot {
  readonly version: typeof OBSERVER_PROTOCOL;
  readonly availability: ObserverAvailability;
  readonly availabilityReason: string;
  readonly workspaceRoot: string;
  readonly workspaceName: string;
  readonly workspaceId: string | null;
  readonly generation: string;
  readonly sequence: number;
  readonly managedInstanceId: string | null;
  readonly selectedRoot: ObserverRoute | null;
  readonly rootsPage: ObserverRootPage;
  readonly family: ReturnType<typeof deriveObserverFamilyOverview> | null;
  readonly activity: ObserverGenerationState["activity"];
  readonly progress: readonly (
    ObserverGenerationState["progress"] extends ReadonlyMap<string, infer Value> ? Value : never
  )[];
}

function generationId(): string {
  return randomBytes(24).toString("base64url");
}

function selectable(root: ObserverRootRoute): boolean {
  return root.status !== "failed" && root.status !== "archived";
}

function routesEqual(left: ObserverRoute | null, right: ObserverRoute): boolean {
  return left?.sessionId === right.sessionId && left.branchId === right.branchId;
}

function encodeRootCursor(generation: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, generation, offset }), "utf8").toString("base64url");
}

function decodeRootCursor(cursor: string | null | undefined, generation: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || parsed.generation !== generation ||
        !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) {
      throw new Error("invalid");
    }
    return Number(parsed.offset);
  } catch {
    throw new ObserverControllerError(
      "INVALID_CURSOR",
      "Observer root pagination cursor is invalid",
      400,
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

export class ObserverController {
  readonly #workspaceRoot: string;
  readonly #sourceFactory: ObserverSourceFactory;
  readonly #streamSilenceMs: number;
  readonly #rediscoveryMs: number;
  readonly #passivePollIntervalMs: number | undefined;
  readonly #now: () => number;
  readonly #lifetime = new AbortController();
  readonly #listeners = new Set<(update: ObserverControllerUpdate) => void>();
  readonly #routeStreams = new Map<string, AbortController>();
  readonly #lastRouteActivity = new Map<string, number>();

  #poller: PassivePathPollHandle | null = null;
  #source: ObserverSource | null = null;
  #familyAbort: AbortController | null = null;
  #silenceTimer: ReturnType<typeof setInterval> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #attachments = 0;
  #connectionEpoch = 0;
  #connectPromise: Promise<void> | null = null;
  #workspaceName = "";
  #workspaceId: string | null = null;
  #availability: ObserverAvailability = "connecting";
  #availabilityReason = "Inspecting read-only workspace discovery";
  #roots: readonly ObserverRootRoute[] = [];
  #selectedRoot: ObserverRoute | null = null;
  #family: InternalObserverFamily | null = null;
  #generation: ObserverGenerationState | null = null;
  #detachedGeneration = generationId();

  constructor(options: ObserverControllerOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#sourceFactory = options.sourceFactory;
    this.#streamSilenceMs = options.streamSilenceMs ?? DEFAULT_STREAM_SILENCE_MS;
    this.#rediscoveryMs = options.rediscoveryMs ?? DEFAULT_REDISCOVERY_MS;
    this.#passivePollIntervalMs = options.passivePollIntervalMs;
    this.#now = options.now ?? Date.now;
  }

  get attachmentCount(): number {
    return this.#attachments;
  }

  async start(): Promise<void> {
    await this.#refreshWorkspace();
    const paths = passiveDiscoveryPaths(this.#workspaceRoot);
    await this.#refreshPassiveAvailability(paths);
    this.#poller = await startPassivePathPolling({
      paths,
      ...(this.#passivePollIntervalMs === undefined
        ? {}
        : { intervalMs: this.#passivePollIntervalMs }),
      signal: this.#lifetime.signal,
      onChange: async () => {
        await this.#refreshWorkspace();
        if (this.#attachments > 0) await this.#replaceConnection();
        else await this.#refreshPassiveAvailability(paths);
      },
    });
  }

  async stop(): Promise<void> {
    if (this.#lifetime.signal.aborted) return;
    this.#lifetime.abort(new DOMException("Observer stopped", "AbortError"));
    this.#poller?.stop();
    this.#poller = null;
    this.#abortConnectedWork("Observer stopped");
    this.#listeners.clear();
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    if (this.#silenceTimer) clearInterval(this.#silenceTimer);
    await this.#connectPromise?.catch(() => {});
  }

  async attach(): Promise<() => void> {
    if (this.#lifetime.signal.aborted) throw new Error("Observer is stopped");
    this.#attachments += 1;
    let released = false;
    try {
      await this.#ensureConnected();
    } catch (error) {
      this.#releaseAttachment();
      throw error;
    }
    return () => {
      if (released) return;
      released = true;
      this.#releaseAttachment();
    };
  }

  subscribe(listener: (update: ObserverControllerUpdate) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(rootCursor?: string | null, rootsLimit?: number): ObserverBrowserSnapshot {
    const rootsPage = this.rootPage(rootCursor, rootsLimit);
    return {
      version: OBSERVER_PROTOCOL,
      availability: this.#availability,
      availabilityReason: this.#availabilityReason,
      workspaceRoot: this.#workspaceRoot,
      workspaceName: this.#workspaceName,
      workspaceId: this.#workspaceId,
      generation: this.#generation?.generation ?? this.#detachedGeneration,
      sequence: this.#generation?.sequence ?? 0,
      managedInstanceId: this.#source?.instanceId ?? null,
      selectedRoot: this.#selectedRoot,
      rootsPage,
      family: this.#family ? deriveObserverFamilyOverview(this.#family) : null,
      activity: this.#generation?.activity ?? [],
      progress: this.#generation ? [...this.#generation.progress.values()] : [],
    };
  }

  rootPage(cursor?: string | null, requestedLimit = ROOT_PAGE_ITEMS): ObserverRootPage {
    const generation = this.#generation?.generation ?? this.#detachedGeneration;
    const offset = decodeRootCursor(cursor, generation);
    const decorated = this.#roots
      .filter(selectable)
      .map(root => ({ ...root, selectable: true }));
    const limit = Math.max(1, Math.min(ROOT_PAGE_ITEMS, Math.floor(requestedLimit)));
    let items = decorated.slice(offset, offset + limit);
    let truncated = offset + items.length < decorated.length;
    while (serializedUtf8Bytes(items) > ROOT_PAGE_BYTES && items.length > 0) {
      items = items.slice(0, -1);
      truncated = true;
    }
    const nextOffset = offset + items.length;
    return {
      items,
      selectableCount: decorated.length,
      nextCursor: nextOffset < decorated.length
        ? encodeRootCursor(generation, nextOffset)
        : null,
      truncated,
    };
  }

  async selectRoot(route: ObserverRoute, expectedGeneration: string): Promise<ObserverBrowserSnapshot> {
    const currentGeneration = this.#generation?.generation ?? this.#detachedGeneration;
    if (expectedGeneration !== currentGeneration) {
      throw new ObserverControllerError("STALE_GENERATION", "Observer selection generation is stale", 409);
    }
    const candidate = this.#roots.find(root => routesEqual(root.route, route) && selectable(root));
    if (!candidate) throw new ObserverControllerError("INVALID_SELECTION", "Root route is not selectable", 400);
    if (!routesEqual(this.#selectedRoot, route) || this.#family === null) {
      await this.#buildFamily(route, true);
    }
    return this.snapshot();
  }

  detail(input: {
    readonly route: ObserverRoute;
    readonly section: string;
    readonly limit?: number;
    readonly cursor?: string | null;
    readonly itemId?: string | null;
  }): ReturnType<typeof deriveObserverDetailPage> {
    if (!OBSERVER_DETAIL_SECTIONS.includes(input.section as ObserverDetailSection)) {
      throw new ObserverControllerError("INVALID_SECTION", "Observer detail section is invalid", 400);
    }
    const snapshot = this.#family?.routes.get(observerRouteKey(input.route));
    if (!snapshot) throw new ObserverControllerError("ROUTE_UNAVAILABLE", "Observer route is unavailable", 404);
    let page;
    try {
      page = deriveObserverDetailPage(snapshot, input.section as ObserverDetailSection, {
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid observer detail pagination cursor") {
        throw new ObserverControllerError(
          "INVALID_CURSOR",
          "Observer detail pagination cursor is invalid",
          400,
        );
      }
      throw error;
    }
    if (input.itemId && page.items.length === 0) {
      throw new ObserverControllerError("ITEM_UNAVAILABLE", "Observer detail item is unavailable", 404);
    }
    return page;
  }

  replay(generation: string, after: number): ReturnType<typeof replayObserverEnvelopes> {
    if (!this.#generation) return { kind: "resync_required", reason: "replay_unavailable" };
    return replayObserverEnvelopes(this.#generation, generation, after);
  }

  async #ensureConnected(): Promise<void> {
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = this.#connect().finally(() => {
      this.#connectPromise = null;
    });
    return this.#connectPromise;
  }

  async #connect(): Promise<void> {
    await this.#refreshWorkspace();
    if (this.#workspaceId === null) {
      this.#setAvailability("workspace_uninitialized", "Workspace identity has not been initialized");
      return;
    }
    const epoch = ++this.#connectionEpoch;
    this.#setAvailability("connecting", "Validating the managed workspace service");
    const controller = new AbortController();
    const abort = (): void => controller.abort(this.#lifetime.signal.reason);
    this.#lifetime.signal.addEventListener("abort", abort, { once: true });
    let connected;
    try {
      connected = await this.#sourceFactory.connect({
        workspaceRoot: this.#workspaceRoot,
        workspaceId: this.#workspaceId,
        signal: controller.signal,
      });
    } finally {
      this.#lifetime.signal.removeEventListener("abort", abort);
    }
    if (epoch !== this.#connectionEpoch || this.#attachments === 0 || this.#lifetime.signal.aborted) {
      if (connected?.kind === "connected") connected.source.close("Stale observer connection");
      return;
    }
    if (connected.kind !== "connected") {
      this.#setAvailability(connected.kind, connected.reason);
      this.#scheduleRediscovery();
      return;
    }
    this.#source = connected.source;
    let roots: readonly ObserverRootRoute[];
    try {
      roots = await connected.source.roots(this.#lifetime.signal);
    } catch {
      if (epoch !== this.#connectionEpoch) return;
      this.#setAvailability("service_stale", "Managed root listing is unavailable");
      this.#scheduleRediscovery();
      return;
    }
    if (epoch !== this.#connectionEpoch || connected.source.instanceId !== this.#source?.instanceId) return;
    this.#roots = roots;
    const candidates = roots.filter(selectable);
    const retained = this.#selectedRoot === null
      ? undefined
      : candidates.find(candidate => routesEqual(this.#selectedRoot, candidate.route));
    if (retained) {
      if (this.#family && this.#generation &&
          this.#generation.managedInstanceId === connected.source.instanceId) {
        this.#setAvailability(this.#family.truncated ? "family_truncated" : "connected",
          this.#family.truncated ? "Family route bound reached" : "Connected to committed family state");
        for (const snapshot of this.#family.routes.values()) {
          if (snapshot.cursor !== null && snapshot.state !== null) {
            this.#startRouteStream(snapshot.route, snapshot.cursor);
          }
        }
        this.#startSilenceMonitor();
      } else {
        await this.#buildFamily(retained.route, false);
      }
    } else if (candidates.length === 1) {
      await this.#buildFamily(candidates[0]!.route, false);
    } else {
      this.#selectedRoot = null;
      this.#family = null;
      this.#generation = null;
      this.#setAvailability("connected", candidates.length
        ? "Select one root family"
        : "No selectable root family is available");
    }
  }

  async #buildFamily(route: ObserverRoute, replacing: boolean): Promise<void> {
    const source = this.#source;
    if (!source || this.#attachments === 0) return;
    const epoch = this.#connectionEpoch;
    const instanceId = source.instanceId;
    this.#familyAbort?.abort(new DOMException("Observer family replaced", "AbortError"));
    for (const controller of this.#routeStreams.values()) controller.abort();
    this.#routeStreams.clear();
    const familyAbort = new AbortController();
    this.#familyAbort = familyAbort;
    this.#setAvailability(replacing ? "resyncing" : "connecting", "Loading bounded family state");
    const family = await discoverObserverFamily(route, source, { signal: familyAbort.signal });
    if (familyAbort.signal.aborted || epoch !== this.#connectionEpoch ||
        instanceId !== this.#source?.instanceId || this.#attachments === 0) return;
    this.#selectedRoot = route;
    this.#family = family;
    this.#generation = createObserverGeneration({
      generation: generationId(),
      managedInstanceId: instanceId,
      routes: [...family.routes.values()]
        .filter((value): value is InternalObserverRouteSnapshot & {
          readonly state: NonNullable<InternalObserverRouteSnapshot["state"]>;
          readonly cursor: string;
        } => value.state !== null && value.cursor !== null)
        .map(value => ({ route: value.route, state: value.state, cursor: value.cursor })),
    });
    this.#detachedGeneration = this.#generation.generation;
    this.#setAvailability(family.truncated ? "family_truncated" : "connected",
      family.truncated ? "Family route bound reached" : "Connected to committed family state");
    if (replacing) this.#notify({ kind: "resync" });
    for (const snapshot of family.routes.values()) {
      if (snapshot.cursor !== null && snapshot.state !== null) this.#startRouteStream(snapshot.route, snapshot.cursor);
    }
    this.#startSilenceMonitor();
  }

  #startRouteStream(route: ObserverRoute, afterCursor: string): void {
    const source = this.#source;
    const generation = this.#generation;
    if (!source || !generation) return;
    const key = observerRouteKey(route);
    this.#routeStreams.get(key)?.abort(
      new DOMException("Observer route stream replaced", "AbortError"),
    );
    const controller = new AbortController();
    this.#routeStreams.set(key, controller);
    this.#lastRouteActivity.set(key, this.#now());
    const expectedGeneration = generation.generation;
    const expectedInstance = source.instanceId;
    void source.streamRoute(route, afterCursor, {
      onComment: () => {
        if (this.#current(expectedGeneration, expectedInstance)) {
          this.#lastRouteActivity.set(key, this.#now());
        }
      },
      onProgress: progress => {
        if (!this.#generation || !this.#current(expectedGeneration, expectedInstance)) return;
        this.#lastRouteActivity.set(key, this.#now());
        const prior = this.#generation.sequence;
        const result = recordObserverProgress(this.#generation, {
          generation: expectedGeneration,
          managedInstanceId: expectedInstance,
          route,
          progress,
        });
        this.#generation = result.state;
        this.#notifyNewEnvelopes(prior);
      },
      onEvent: event => this.#handleEvent(route, event, expectedGeneration, expectedInstance),
    }, controller.signal).then(() => {
      if (!controller.signal.aborted && this.#current(expectedGeneration, expectedInstance)) {
        this.#scheduleRediscovery();
      }
    }).catch(() => {
      if (!controller.signal.aborted && this.#current(expectedGeneration, expectedInstance)) {
        this.#scheduleRediscovery();
      }
    });
  }

  #handleEvent(
    route: ObserverRoute,
    event: AgentEvent,
    expectedGeneration: string,
    expectedInstance: string,
  ): void {
    if (!this.#generation || !this.#family || !this.#current(expectedGeneration, expectedInstance)) return;
    this.#lastRouteActivity.set(observerRouteKey(route), this.#now());
    const prior = this.#generation.sequence;
    const result = applyObserverCommittedEvent(this.#generation, {
      generation: expectedGeneration,
      managedInstanceId: expectedInstance,
      route,
      event,
    });
    this.#generation = result.state;
    if (result.kind !== "applied") return;
    const projected = this.#generation.routes.get(observerRouteKey(route));
    if (projected) {
      const routes = new Map(this.#family.routes);
      routes.set(observerRouteKey(route), {
        route,
        state: projected.state,
        cursor: projected.cursor,
        availability: "available",
        unavailableReason: null,
      });
      this.#family = { ...this.#family, routes };
    }
    this.#notifyNewEnvelopes(prior);
    if (event.type === "TaskCreated" && this.#selectedRoot) {
      void this.#buildFamily(this.#selectedRoot, true).catch(() => this.#scheduleRediscovery());
    }
  }

  #notifyNewEnvelopes(afterSequence: number): void {
    for (const envelope of this.#generation?.replay ?? []) {
      if (envelope.sequence > afterSequence) this.#notify({ kind: "envelope", envelope });
    }
  }

  #notify(update: ObserverControllerUpdate): void {
    for (const listener of this.#listeners) listener(update);
  }

  #current(generation: string, instanceId: string): boolean {
    return this.#attachments > 0 &&
      this.#generation?.generation === generation &&
      this.#source?.instanceId === instanceId;
  }

  #startSilenceMonitor(): void {
    if (this.#silenceTimer) clearInterval(this.#silenceTimer);
    const interval = Math.max(10, Math.min(5_000, Math.floor(this.#streamSilenceMs / 3)));
    this.#silenceTimer = setInterval(() => {
      if (this.#attachments === 0) return;
      const now = this.#now();
      if ([...this.#lastRouteActivity.values()].some(last => now - last > this.#streamSilenceMs)) {
        this.#scheduleRediscovery();
      }
    }, interval);
  }

  #scheduleRediscovery(): void {
    if (this.#attachments === 0 || this.#retryTimer || this.#lifetime.signal.aborted) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.#replaceConnection();
    }, this.#rediscoveryMs);
  }

  async #replaceConnection(): Promise<void> {
    if (this.#attachments === 0) return;
    this.#abortConnectedWork("Observer rediscovery");
    this.#setAvailability("resyncing", "Rediscovering managed workspace service");
    this.#notify({ kind: "resync" });
    await this.#ensureConnected();
  }

  #abortConnectedWork(reason: string, retainProjection = false): void {
    this.#connectionEpoch += 1;
    this.#familyAbort?.abort(new DOMException(reason, "AbortError"));
    this.#familyAbort = null;
    for (const controller of this.#routeStreams.values()) {
      controller.abort(new DOMException(reason, "AbortError"));
    }
    this.#routeStreams.clear();
    this.#lastRouteActivity.clear();
    this.#source?.close(reason);
    this.#source = null;
    if (this.#silenceTimer) clearInterval(this.#silenceTimer);
    this.#silenceTimer = null;
    if (retainProjection) {
      if (this.#generation) this.#generation = discardObserverProgress(this.#generation, "disconnect");
    } else {
      this.#generation = null;
      this.#family = null;
      this.#detachedGeneration = generationId();
    }
  }

  #releaseAttachment(): void {
    this.#attachments = Math.max(0, this.#attachments - 1);
    if (this.#attachments !== 0) return;
    this.#abortConnectedWork("Last browser attachment disconnected", true);
    this.#setAvailability(this.#workspaceId === null ? "workspace_uninitialized" : "connecting",
      this.#workspaceId === null
        ? "Workspace identity has not been initialized"
        : "Waiting for a browser attachment");
  }

  async #refreshWorkspace(): Promise<void> {
    const observed = await observeWorkspace({ override: this.#workspaceRoot });
    this.#workspaceName = observed.name;
    this.#workspaceId = observed.workspaceId;
  }

  async #refreshPassiveAvailability(paths: readonly [string, string]): Promise<void> {
    if (!await pathExists(paths[0])) {
      this.#setAvailability("workspace_uninitialized", "Workspace identity has not been initialized");
    } else if (!await pathExists(paths[1])) {
      this.#setAvailability("service_stopped", "Managed workspace service is not running");
    } else {
      this.#setAvailability("connecting", "Service discovery metadata is present; attach a browser to validate it");
    }
  }

  #setAvailability(state: ObserverAvailability, reason: string): void {
    this.#availability = state;
    this.#availabilityReason = reason;
  }
}

export class ObserverControllerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ObserverControllerError";
  }
}

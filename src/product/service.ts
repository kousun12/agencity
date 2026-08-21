import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { REASONING_EFFORTS, ValidationError, newId, projectEvents, type ReasoningEffort } from "../domain/index.ts";
import { AgentClient, ProtocolServer } from "../protocol/index.ts";
import { Supervisor, type AgentRunResult, type StartAgentRunInput, type SupervisorOptions } from "../runtime/index.ts";
import {
  DEFAULT_CONSOLE_RSS_RECYCLE_BYTES,
  DEFAULT_MAX_CONSOLE_ACTIVE_EXECUTIONS,
  DEFAULT_MAX_CONSOLE_RESIDENT_PROCESSES,
  type ConsoleExecutionPoolStatus,
} from "../console/index.ts";
import { LibSqlStorage } from "../storage/index.ts";
import { scrubText } from "../security/index.ts";
import { ProductCatalog } from "./catalog.ts";
import { modelEffortPreferenceKey, workspacePreferenceKey, type ResolvedWorkspace } from "./workspace.ts";
import { formatModel, parseModel } from "./providers.ts";
import {
  assessService,
  assertServiceCompatibility,
  authorityDecisionError,
  buildServiceChildSpawnSpecification,
  cleanupStaleServiceManifest,
  createServiceManifest,
  hashServiceConfiguration,
  publishServiceManifest,
  readServiceManifest,
  serviceStatePaths,
  unpublishServiceManifest,
  type ServiceAssessment,
  type ServiceHealthEvidence,
  type ServiceLeaseEvidence,
  type ServiceManifestV1,
} from "./service-discovery.ts";

export const MANAGED_SERVICE_PROTOCOL_VERSION = 3;
export const MANAGED_SERVICE_CLIENT_PROTOCOL_MIN_VERSION = 2;
export const MANAGED_SERVICE_CONFIG_ENV = "AGENCITY_SERVICE_CONFIG";
export const DEFAULT_MANAGED_SERVICE_IDLE_SHUTDOWN_MS = 3_600_000;
export const DEFAULT_MANAGED_SERVICE_LEASE_MS = 30_000;
const MIN_MANAGED_SERVICE_IDLE_SHUTDOWN_MS = 100;
const MAX_MANAGED_SERVICE_IDLE_SHUTDOWN_MS = 24 * 60 * 60 * 1_000;
const MAX_SERVICE_CHILD_STARTUP_ERROR_BYTES = 16 * 1_024;

export interface ManagedServiceConfiguration {
  readonly workspace: ResolvedWorkspace;
  readonly databasePath: string;
  readonly artifactDirectory: string;
  readonly profileDatabasePath: string;
  readonly restartConsoleAfterCell?: boolean;
  readonly consoleRssRecycleThresholdBytes?: number;
  readonly maxConsoleResidentProcesses?: number;
  readonly maxConsoleActiveExecutions?: number;
  readonly maxAwaitedAgentDepth?: number;
  /** Internal/test override; production defaults to a 30-second local lease. */
  readonly leaseMs?: number;
  /** Internal/test override for bounded shutdown after the workspace becomes quiescent. */
  readonly idleShutdownMs?: number;
  readonly sync?: {
    readonly syncUrl?: string;
    readonly replicaPath?: string;
    readonly credentialReference?: string;
    readonly intervalMs?: number;
  };
}

interface SerializedManagedServiceConfiguration {
  readonly workspace: ResolvedWorkspace;
  readonly databasePath: string;
  readonly artifactDirectory: string;
  readonly profileDatabasePath: string;
  readonly restartConsoleAfterCell: boolean;
  readonly consoleRssRecycleThresholdBytes: number;
  readonly maxConsoleResidentProcesses: number;
  readonly maxConsoleActiveExecutions: number;
  readonly maxAwaitedAgentDepth: number;
  readonly leaseMs: number;
  readonly idleShutdownMs: number;
  readonly sync: {
    readonly syncUrl: string | null;
    readonly replicaPath: string | null;
    readonly credentialReference: string | null;
    readonly intervalMs: number | null;
  };
}

export interface ManagedServiceConnection {
  readonly client: AgentClient;
  readonly manifest: ServiceManifestV1;
  readonly started: boolean;
}

export interface ManagedServiceStatus {
  readonly lifecycle: "starting" | "running" | "draining" | "stopped" | "failed";
  readonly mode: "trusted-local";
  readonly instanceId: string;
  readonly workspaceId: string;
  readonly startedAt: string;
  readonly recovery: "pending" | "running" | "complete" | "failed";
  readonly recoveryError: string | null;
  readonly idleShutdownMs: number;
  readonly idleShutdownAt: string;
  readonly attachedClients: number;
  readonly keepAliveReasons: readonly {
    readonly kind: "attached_clients" | "resident_workers" | "active_executions" | "active_runs" | "pending_effects" | "managed_processes" | "queued_wakes" | "active_schedules" | "active_heartbeats";
    readonly count: number;
    readonly summary: string;
  }[];
  readonly console: ConsoleExecutionPoolStatus;
  readonly roots: readonly {
    readonly sessionId: string;
    readonly branchId: string;
    readonly name: string;
    readonly status: string;
    readonly worker: "running" | "idle" | "detached";
    readonly unresolvedWork: number;
  }[];
}

function normalizedIdleShutdownMs(value: number | undefined): number {
  const candidate = value ?? DEFAULT_MANAGED_SERVICE_IDLE_SHUTDOWN_MS;
  if (!Number.isSafeInteger(candidate) || candidate < MIN_MANAGED_SERVICE_IDLE_SHUTDOWN_MS || candidate > MAX_MANAGED_SERVICE_IDLE_SHUTDOWN_MS) {
    throw new ValidationError(`Managed service idle shutdown must be between ${MIN_MANAGED_SERVICE_IDLE_SHUTDOWN_MS} and ${MAX_MANAGED_SERVICE_IDLE_SHUTDOWN_MS} milliseconds`);
  }
  return candidate;
}

function normalizedConsoleRssRecycleThresholdBytes(
  value: number | undefined,
): number {
  const candidate = value ?? DEFAULT_CONSOLE_RSS_RECYCLE_BYTES;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new ValidationError(
      "Console RSS recycle threshold must be a positive integer",
    );
  }
  return candidate;
}

function normalizedConfiguration(input: ManagedServiceConfiguration): ManagedServiceConfiguration {
  return {
    workspace: { root: resolve(input.workspace.root), workspaceId: input.workspace.workspaceId, name: input.workspace.name, stateDirectory: resolve(input.workspace.stateDirectory) },
    databasePath: resolve(input.databasePath),
    artifactDirectory: resolve(input.artifactDirectory),
    profileDatabasePath: resolve(input.profileDatabasePath),
    restartConsoleAfterCell: input.restartConsoleAfterCell ?? false,
    consoleRssRecycleThresholdBytes:
      normalizedConsoleRssRecycleThresholdBytes(
        input.consoleRssRecycleThresholdBytes,
      ),
    maxConsoleResidentProcesses: input.maxConsoleResidentProcesses ??
      DEFAULT_MAX_CONSOLE_RESIDENT_PROCESSES,
    maxConsoleActiveExecutions: input.maxConsoleActiveExecutions ??
      DEFAULT_MAX_CONSOLE_ACTIVE_EXECUTIONS,
    maxAwaitedAgentDepth: input.maxAwaitedAgentDepth ?? 8,
    leaseMs: input.leaseMs ?? DEFAULT_MANAGED_SERVICE_LEASE_MS,
    idleShutdownMs: normalizedIdleShutdownMs(input.idleShutdownMs),
    sync: {
      ...(input.sync?.syncUrl ? { syncUrl: input.sync.syncUrl } : {}),
      ...(input.sync?.replicaPath ? { replicaPath: resolve(input.sync.replicaPath) } : {}),
      ...(input.sync?.credentialReference ? { credentialReference: input.sync.credentialReference } : {}),
      ...(input.sync?.intervalMs === undefined ? {} : { intervalMs: input.sync.intervalMs }),
    },
  };
}

function serializedConfiguration(input: ManagedServiceConfiguration): SerializedManagedServiceConfiguration {
  const normalized = normalizedConfiguration(input);
  return {
    workspace: {
      root: resolve(normalized.workspace.root),
      workspaceId: normalized.workspace.workspaceId,
      name: normalized.workspace.name,
      stateDirectory: resolve(normalized.workspace.stateDirectory),
    },
    databasePath: resolve(normalized.databasePath),
    artifactDirectory: resolve(normalized.artifactDirectory),
    profileDatabasePath: resolve(normalized.profileDatabasePath),
    restartConsoleAfterCell: normalized.restartConsoleAfterCell ?? false,
    consoleRssRecycleThresholdBytes:
      normalized.consoleRssRecycleThresholdBytes ??
      DEFAULT_CONSOLE_RSS_RECYCLE_BYTES,
    maxConsoleResidentProcesses: normalized.maxConsoleResidentProcesses ??
      DEFAULT_MAX_CONSOLE_RESIDENT_PROCESSES,
    maxConsoleActiveExecutions: normalized.maxConsoleActiveExecutions ??
      DEFAULT_MAX_CONSOLE_ACTIVE_EXECUTIONS,
    maxAwaitedAgentDepth: normalized.maxAwaitedAgentDepth ?? 8,
    leaseMs: normalized.leaseMs ?? DEFAULT_MANAGED_SERVICE_LEASE_MS,
    idleShutdownMs: normalized.idleShutdownMs ?? DEFAULT_MANAGED_SERVICE_IDLE_SHUTDOWN_MS,
    sync: {
      syncUrl: normalized.sync?.syncUrl ?? null,
      replicaPath: normalized.sync?.replicaPath ? resolve(normalized.sync.replicaPath) : null,
      credentialReference: normalized.sync?.credentialReference ?? null,
      intervalMs: normalized.sync?.intervalMs ?? null,
    },
  };
}

export function managedServiceConfigurationHash(input: ManagedServiceConfiguration): string {
  return hashServiceConfiguration(JSON.stringify(serializedConfiguration(input)));
}

export function encodeManagedServiceConfiguration(input: ManagedServiceConfiguration): string {
  return Buffer.from(JSON.stringify(serializedConfiguration(input))).toString("base64url");
}

export function decodeManagedServiceConfiguration(value: string): ManagedServiceConfiguration {
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new ValidationError("Managed service configuration is invalid"); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new ValidationError("Managed service configuration is invalid");
  const candidate = decoded as Partial<SerializedManagedServiceConfiguration>;
  if (!candidate.workspace || typeof candidate.databasePath !== "string" || typeof candidate.artifactDirectory !== "string" || typeof candidate.profileDatabasePath !== "string") {
    throw new ValidationError("Managed service configuration is incomplete");
  }
  const serialized = candidate as SerializedManagedServiceConfiguration;
  return normalizedConfiguration({
    workspace: serialized.workspace!, databasePath: serialized.databasePath!, artifactDirectory: serialized.artifactDirectory!, profileDatabasePath: serialized.profileDatabasePath!,
    restartConsoleAfterCell: serialized.restartConsoleAfterCell,
    consoleRssRecycleThresholdBytes:
      serialized.consoleRssRecycleThresholdBytes,
    maxConsoleResidentProcesses: serialized.maxConsoleResidentProcesses,
    maxConsoleActiveExecutions: serialized.maxConsoleActiveExecutions,
    maxAwaitedAgentDepth: serialized.maxAwaitedAgentDepth,
    leaseMs: serialized.leaseMs,
    idleShutdownMs: serialized.idleShutdownMs,
    sync: {
      ...(serialized.sync?.syncUrl ? { syncUrl: serialized.sync.syncUrl } : {}),
      ...(serialized.sync?.replicaPath ? { replicaPath: serialized.sync.replicaPath } : {}),
      ...(serialized.sync?.credentialReference ? { credentialReference: serialized.sync.credentialReference } : {}),
      ...(serialized.sync?.intervalMs === null || serialized.sync?.intervalMs === undefined ? {} : { intervalMs: serialized.sync.intervalMs }),
    },
  });
}

class ResidentRootQueue {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #active = new Set<string>();
  #draining = false;

  enqueue(rootSessionId: string, operation: () => Promise<void>): void {
    if (this.#draining) throw new ValidationError("Managed service is draining and does not accept new execution");
    const prior = this.#tails.get(rootSessionId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(async () => {
      this.#active.add(rootSessionId);
      try { await operation(); } finally { this.#active.delete(rootSessionId); }
    });
    this.#tails.set(rootSessionId, next);
    void next.finally(() => { if (this.#tails.get(rootSessionId) === next) this.#tails.delete(rootSessionId); });
  }

  state(rootSessionId: string): "running" | "idle" | "detached" {
    if (this.#active.has(rootSessionId)) return "running";
    return this.#tails.has(rootSessionId) ? "idle" : "detached";
  }

  get busy(): boolean { return this.#active.size > 0 || this.#tails.size > 0; }

  async drain(): Promise<void> {
    this.#draining = true;
    await Promise.allSettled([...this.#tails.values()]);
  }
}

export class ManagedWorkspaceService {
  readonly supervisor: Supervisor;
  readonly catalog: ProductCatalog;
  readonly protocol: ProtocolServer;
  readonly manifest: ServiceManifestV1;
  readonly config: ManagedServiceConfiguration;
  readonly #workers = new ResidentRootQueue();
  readonly #startedAt: string;
  readonly #attachmentProbe: () => boolean;
  readonly #attachmentCountProbe: () => number;
  #lifecycle: ManagedServiceStatus["lifecycle"] = "starting";
  #recovery: ManagedServiceStatus["recovery"] = "pending";
  #recoveryError: string | null = null;
  #recoveryPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #lastActivityAt = Date.now();
  #exitProcessWhenClosed = false;

  private constructor(
    supervisor: Supervisor,
    catalog: ProductCatalog,
    protocol: ProtocolServer,
    manifest: ServiceManifestV1,
    config: ManagedServiceConfiguration,
    attachmentProbe: () => boolean,
    attachmentCountProbe: () => number,
  ) {
    this.supervisor = supervisor;
    this.catalog = catalog;
    this.protocol = protocol;
    this.manifest = manifest;
    this.config = config;
    this.#startedAt = manifest.startedAt;
    this.#attachmentProbe = attachmentProbe;
    this.#attachmentCountProbe = attachmentCountProbe;
  }

  static async open(
    config: ManagedServiceConfiguration,
    appVersion: string,
    options: Pick<SupervisorOptions, "modelCatalog" | "modelProviders"> = {},
  ): Promise<ManagedWorkspaceService> {
    const normalized = normalizedConfiguration(config);
    const instanceId = `service-${newId()}`;
    let service: ManagedWorkspaceService | null = null;
    const supervisor = await Supervisor.open({
      databaseUrl: `file:${normalized.databasePath}`,
      artifactDirectory: normalized.artifactDirectory,
      artifactDirectoryOwnership: "shared",
      workspaceRoot: normalized.workspace.root,
      profileDatabaseUrl: `file:${normalized.profileDatabasePath}`,
      restartConsoleAfterCell: normalized.restartConsoleAfterCell ?? false,
      consoleRssRecycleThresholdBytes:
        normalized.consoleRssRecycleThresholdBytes ??
        DEFAULT_CONSOLE_RSS_RECYCLE_BYTES,
      maxConsoleResidentProcesses: normalized.maxConsoleResidentProcesses ??
        DEFAULT_MAX_CONSOLE_RESIDENT_PROCESSES,
      maxConsoleActiveExecutions: normalized.maxConsoleActiveExecutions ??
        DEFAULT_MAX_CONSOLE_ACTIVE_EXECUTIONS,
      maxAwaitedAgentDepth: normalized.maxAwaitedAgentDepth ?? 8,
      recover: false,
      startWakeSchedulers: false,
      ...options,
      executionLease: {
        workspaceId: normalized.workspace.workspaceId,
        ownerProcessId: instanceId,
        leaseMs: normalized.leaseMs ?? DEFAULT_MANAGED_SERVICE_LEASE_MS,
        renewalIntervalMs: Math.max(
          1,
          Math.floor(
            (normalized.leaseMs ?? DEFAULT_MANAGED_SERVICE_LEASE_MS) / 3,
          ),
        ),
        onLost: () => { if (service) void service.failClosed("Execution lease renewal was lost"); },
      },
      sync: {
        workspaceId: normalized.workspace.workspaceId,
        workspaceName: normalized.workspace.name,
        ...(normalized.sync?.syncUrl ? { syncUrl: normalized.sync!.syncUrl } : {}),
        ...(normalized.sync?.replicaPath ? { replicaUrl: `file:${normalized.sync!.replicaPath}` } : {}),
        ...(process.env.TURSO_AUTH_TOKEN ? { authToken: process.env.TURSO_AUTH_TOKEN } : {}),
        ...(normalized.sync?.credentialReference ? { credentialReference: normalized.sync!.credentialReference } : {}),
        ...(normalized.sync?.intervalMs === undefined ? {} : { intervalMs: normalized.sync.intervalMs }),
      },
    });
    let protocol: ProtocolServer | null = null;
    let publishedManifest: ServiceManifestV1 | null = null;
    try {
      const catalog = new ProductCatalog(supervisor, normalized.workspace.workspaceId);
      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const bearerToken = Buffer.from(tokenBytes).toString("base64url");
      const hooks = {
        health: {
          workspaceId: normalized.workspace.workspaceId,
          instanceId,
          appVersion,
          protocolMin: MANAGED_SERVICE_PROTOCOL_VERSION,
          protocolMax: MANAGED_SERVICE_PROTOCOL_VERSION,
          configHash: managedServiceConfigurationHash(normalized),
        },
        ready: () => service?.ready ?? false,
        status: () => service!.status(true),
        shutdown: () => service!.requestShutdown(),
        agents: () => service!.agents(),
        startRun: (sessionId: string, branchId: string, input: StartAgentRunInput) => service!.startRun(sessionId, branchId, input),
        stop: (sessionId: string, branchId: string, reason?: string) => service!.stop(sessionId, branchId, reason),
        productSessions: () => catalog.list(),
        productSelect: (target?: string, branchId?: string) => catalog.select(target, branchId),
        productRename: async (sessionId: string, branchId: string | undefined, name: string) => { await catalog.rename(sessionId, branchId, name); return { renamed: true }; },
        productConfig: async (requestedModel?: string) => {
          const model = await supervisor.profile.getPreference(workspacePreferenceKey(normalized.workspace.workspaceId, "model"));
          let selected: ReturnType<typeof parseModel> | null = null;
          if (typeof model?.value === "string") {
            try {
              selected = parseModel(model.value);
            } catch {
              // Retain malformed pre-boundary values for diagnostics. Product
              // selection decides whether to warn interactively or fail closed.
            }
          }
          const preferenceModel = requestedModel?.trim() || selected?.model;
          const effortPreference = preferenceModel
            ? await supervisor.profile.getPreference(modelEffortPreferenceKey(normalized.workspace.workspaceId, supervisor.modelCatalog.endpointId, preferenceModel))
            : null;
          const credentialReferences = (await supervisor.profile.listCredentialReferences()).map(({ reference, provider, label, createdAt, updatedAt }) => ({ reference, provider, label, createdAt, updatedAt }));
          return {
            defaultModel: typeof model?.value === "string" ? model.value : null,
            catalogEndpointId: supervisor.modelCatalog.endpointId,
            catalogOrigin: supervisor.modelCatalog.gatewayOrigin,
            executionOrigins: supervisor.modelExecutor.executionOrigins(),
            selectedModelEffortPreference: typeof effortPreference?.value === "string" && REASONING_EFFORTS.includes(effortPreference.value as ReasoningEffort)
              ? effortPreference.value : null,
            credentialReferences,
            providers: supervisor.modelProviders,
          };
        },
        productSetModel: async (model: string | null) => {
          if (model !== null && !model.trim()) throw new ValidationError("Model preference is required");
          const normalizedModel = model === null
            ? null
            : formatModel(await supervisor.normalizeSelectedModelAdmission(parseModel(model)));
          await supervisor.profile.setPreference(workspacePreferenceKey(normalized.workspace.workspaceId, "model"), normalizedModel);
          return { defaultModel: normalizedModel };
        },
        productSetReasoningEffort: async (model: string, effort: string | null) => {
          if (!model.trim() || /\s/.test(model)) throw new ValidationError("Canonical model ID is required");
          const key = modelEffortPreferenceKey(normalized.workspace.workspaceId, supervisor.modelCatalog.endpointId, model);
          if (effort === null) {
            await supervisor.profile.setPreference(key, null);
            return { model, effort: null, catalogEndpointId: supervisor.modelCatalog.endpointId };
          }
          if (!REASONING_EFFORTS.includes(effort as ReasoningEffort)) throw new ValidationError("Reasoning effort must use a canonical level");
          if (effort !== "provider-default") await supervisor.modelCatalog.ensureFresh();
          const configuration = supervisor.normalizeModelConfiguration({ provider: "vercel", model, reasoningEffort: effort as ReasoningEffort });
          await supervisor.profile.setPreference(key, configuration.reasoningEffort);
          return { model, effort: configuration.reasoningEffort, descriptor: supervisor.modelCatalog.descriptor(model) };
        },
        productSetProviderKey: async (provider: string, apiKey: string | null) => {
          const status = apiKey === null
            ? await supervisor.credentials.remove(provider)
            : await supervisor.credentials.set(provider, apiKey);
          return { provider: status.provider, configured: status.configured, source: status.source };
        },
        productCredentialReference: async (provider: string, reference: string, label: string) => {
          const record = await supervisor.profile.putCredentialReference({ reference, provider, label, metadata: { kind: "opaque-handle" } });
          return { reference: record.reference, provider: record.provider, label: record.label };
        },
      };
      protocol = new ProtocolServer(supervisor, { bearerToken, service: hooks });
      const originalHandle = protocol.handle.bind(protocol);
      protocol.handle = async (request: Request): Promise<Response> => {
        const authenticated = request.headers.get("authorization") === `Bearer ${bearerToken}`;
        if (service && authenticated) service.#recordActivity();
        try { return await originalHandle(request); }
        finally { if (service && authenticated) service.#recordActivity(); }
      };
      const listener = protocol.listen(0, "127.0.0.1");
      const manifest = createServiceManifest({
        workspaceId: normalized.workspace.workspaceId,
        deviceId: supervisor.device.deviceId,
        instanceId,
        url: `http://127.0.0.1:${listener.port}`,
        appVersion,
        protocolMin: MANAGED_SERVICE_PROTOCOL_VERSION,
        protocolMax: MANAGED_SERVICE_PROTOCOL_VERSION,
        configHash: hooks.health.configHash,
        randomToken: () => tokenBytes,
      });
      const publication = await publishServiceManifest({ workspaceRoot: normalized.workspace.root, workspaceId: normalized.workspace.workspaceId, manifest });
      if (publication.kind !== "published" || publication.manifest.instanceId !== instanceId) {
        throw new ValidationError("Another managed workspace service won discovery publication");
      }
      publishedManifest = manifest;
      service = new ManagedWorkspaceService(
        supervisor,
        catalog,
        protocol,
        manifest,
        normalized,
        () => listener.pendingRequests > 0 || listener.pendingWebSockets > 0,
        () => listener.pendingRequests + listener.pendingWebSockets,
      );
      service.#startRecovery();
      await service.#recoveryPromise;
      if (service.#recovery !== "complete") {
        throw new ValidationError(`Managed service recovery failed${service.#recoveryError ? `: ${service.#recoveryError}` : ""}`);
      }
      supervisor.startWakeSchedulers();
      service.#lifecycle = "running";
      service.#exitProcessWhenClosed = Bun.argv[2] === "__service-child";
      service.#recordActivity();
      return service;
    } catch (error) {
      if (service) await service.close().catch(() => {});
      else {
        if (publishedManifest) {
          await unpublishServiceManifest({
            workspaceRoot: normalized.workspace.root,
            workspaceId: normalized.workspace.workspaceId,
            manifest: publishedManifest,
          }).catch(() => {});
        }
        await protocol?.stop().catch(() => {});
        await supervisor.close().catch(() => {});
      }
      throw error;
    }
  }

  get ready(): boolean { return this.#lifecycle === "running"; }

  async status(excludeCurrentRequest = false): Promise<ManagedServiceStatus> {
    const summaries = await this.catalog.list();
    const idleShutdownMs = this.config.idleShutdownMs ?? DEFAULT_MANAGED_SERVICE_IDLE_SHUTDOWN_MS;
    const attachedClients = Math.max(0, this.#attachmentCountProbe() - (excludeCurrentRequest ? 1 : 0));
    const keepAliveReasons = await this.#keepAliveReasons(attachedClients);
    return {
      lifecycle: this.#lifecycle,
      mode: "trusted-local",
      instanceId: this.manifest.instanceId,
      workspaceId: this.manifest.workspaceId,
      startedAt: this.#startedAt,
      recovery: this.#recovery,
      recoveryError: this.#recoveryError,
      idleShutdownMs,
      idleShutdownAt: new Date(this.#lastActivityAt + idleShutdownMs).toISOString(),
      attachedClients,
      keepAliveReasons,
      console: this.supervisor.console.capacityStatus(),
      roots: summaries.filter(summary => summary.root && summary.initialBranch).map(summary => ({
        sessionId: summary.sessionId,
        branchId: summary.branchId,
        name: summary.sessionName,
        status: summary.status,
        worker: this.#workers.state(summary.sessionId),
        unresolvedWork: summary.unresolvedWork,
      })),
    };
  }

  async agents(): Promise<ManagedServiceStatus["roots"]> { return (await this.status()).roots; }

  async startRun(sessionId: string, branchId: string, input: StartAgentRunInput): Promise<unknown> {
    if (this.#lifecycle !== "running") throw new ValidationError("Managed service is not accepting execution");
    this.#recordActivity();
    const session = await this.supervisor.storage.getSession?.(sessionId);
    if (!session) throw new ValidationError(`Session not found: ${sessionId}`);
    await this.supervisor.executionLeases!.ensureRoot(session.rootSessionId);
    const admitted = await this.supervisor.runs.admit(sessionId, branchId, input);
    if (!["queued", "running"].includes(admitted.status)) return { accepted: false, ...admitted };
    const cursor = await this.supervisor.storage.getLatestCursor(sessionId, branchId) ?? "0";
    this.#workers.enqueue(session.rootSessionId, async () => {
      try { await this.supervisor.runs.advance(sessionId, branchId, admitted.runId); }
      catch (error) { this.#recoveryError = scrubText(error instanceof Error ? error.message : String(error)); }
      finally { this.#recordActivity(); }
    });
    return { accepted: true, runId: admitted.runId, sessionId, branchId, status: admitted.status, cursor };
  }

  async stop(sessionId: string, branchId: string, reason?: string): Promise<AgentRunResult | { stopped: false; reason: string }> {
    const events = await this.supervisor.storage.loadEvents(sessionId, { branchId });
    const state = events.length ? projectEvents(events) : null;
    const active = state && Object.values(state.agentRuns).find(run => !["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status));
    if (!active) return { stopped: false, reason: "No active run" };
    return this.supervisor.runs.cancel(sessionId, branchId, active.id, reason ?? "Stopped by user");
  }

  async requestShutdown(): Promise<{ accepted: true; lifecycle: "draining" }> {
    if (this.#lifecycle === "running" || this.#lifecycle === "starting") this.#lifecycle = "draining";
    setTimeout(() => { void this.close(); }, 0);
    return { accepted: true, lifecycle: "draining" };
  }

  async failClosed(reason: string): Promise<void> {
    this.#recoveryError = reason;
    this.#lifecycle = "failed";
    await this.close();
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.#closePromise = (async () => {
      if (this.#lifecycle !== "failed") this.#lifecycle = "draining";
      this.supervisor.processes.stopAdmission();
      const failures: unknown[] = [];
      const settle = async (operation: () => Promise<unknown>): Promise<void> => {
        try { await operation(); } catch (error) { failures.push(error); }
      };
      await this.#recoveryPromise?.catch(error => { failures.push(error); });
      this.protocol.stopAccepting();
      await settle(() => this.supervisor.processes.shutdown());
      await settle(() => this.protocol.drainHandlers());
      await settle(() => this.#workers.drain());
      await settle(() => this.supervisor.heartbeats.close());
      await settle(() => this.supervisor.schedules.close());
      await settle(() => this.protocol.closeActiveConnections());
      let ownedProcessesConfirmedStopped = false;
      try {
        await this.supervisor.close();
        ownedProcessesConfirmedStopped = true;
      } catch (error) {
        failures.push(error);
      }
      if (ownedProcessesConfirmedStopped) {
        await unpublishServiceManifest({
          workspaceRoot: this.config.workspace.root,
          workspaceId: this.config.workspace.workspaceId,
          manifest: this.manifest,
        }).catch(() => {});
      }
      if (this.#lifecycle !== "failed" && failures.length === 0) {
        this.#lifecycle = "stopped";
      } else {
        this.#lifecycle = "failed";
        this.#recoveryError ??= scrubText(
          failures[0] instanceof Error
            ? failures[0].message
            : String(failures[0] ?? "Managed service shutdown failed"),
        );
      }
      if (this.#exitProcessWhenClosed) {
        const code = this.#lifecycle === "failed" || failures.length > 0 ? 1 : 0;
        setTimeout(() => process.exit(code), 0);
      } else if (failures.length > 0) {
        throw failures[0];
      }
    })();
    return this.#closePromise;
  }

  #recordActivity(): void {
    if (this.#lifecycle === "draining" || this.#lifecycle === "stopped" || this.#lifecycle === "failed") return;
    this.#lastActivityAt = Date.now();
    this.#scheduleIdleCheck();
  }

  #scheduleIdleCheck(delayMs?: number): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    const ttl = this.config.idleShutdownMs ?? DEFAULT_MANAGED_SERVICE_IDLE_SHUTDOWN_MS;
    const delay = delayMs ?? Math.max(1, this.#lastActivityAt + ttl - Date.now());
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      void this.#checkIdle().catch(error => {
        this.#recoveryError = scrubText(error instanceof Error ? error.message : String(error));
      });
    }, delay);
    this.#idleTimer.unref?.();
  }

  async #checkIdle(): Promise<void> {
    if (this.#lifecycle !== "running") return;
    const ttl = this.config.idleShutdownMs ?? DEFAULT_MANAGED_SERVICE_IDLE_SHUTDOWN_MS;
    const remaining = this.#lastActivityAt + ttl - Date.now();
    if (remaining > 0) { this.#scheduleIdleCheck(remaining); return; }
    const observedActivityAt = this.#lastActivityAt;
    let workspacePresent = true;
    try { await access(this.config.workspace.root); }
    catch { workspacePresent = false; }
    if (!workspacePresent) {
      // A removed owned workspace cannot be discovered or resumed. Local worker
      // and transport activity still drain first; an otherwise idle child exits.
      if (this.#attachmentProbe() || this.#workers.busy) { this.#recordActivity(); return; }
      await this.close();
      return;
    }
    try {
      // Warm workers are replaceable operational caches. Retire idle workers
      // before the final quiescence decision; active/suspended workers remain
      // visible and keep the service alive until they settle.
      await this.supervisor.console.retireIdleWorkers();
      if (this.#attachmentProbe() || await this.#hasOutstandingWork()) {
        this.#recordActivity();
        return;
      }
    } catch {
      // Inspection failure must preserve detached work rather than infer quiescence.
      this.#recordActivity();
      return;
    }
    if (this.#lifecycle !== "running") return;
    if (observedActivityAt !== this.#lastActivityAt || this.#attachmentProbe() || this.#workers.busy) {
      this.#scheduleIdleCheck();
      return;
    }
    await this.close();
  }

  async #hasOutstandingWork(): Promise<boolean> {
    if (this.#workers.busy) return true;
    const console = this.supervisor.console.capacityStatus();
    if (console.residentProcesses > 0 || console.activeExecutions > 0 ||
        console.reservedProcesses > 0 || console.queuedExecutions > 0) {
      return true;
    }
    const storage = this.supervisor.storage;
    for (const route of await this.#ownedRoutes()) {
      const events = await storage.loadEvents(route.sessionId, { branchId: route.branchId });
      if (events.length) {
        const state = projectEvents(events);
        if (Object.values(state.agentRuns).some(run => run.status === "queued" || run.status === "running")) return true;
        if (Object.values(state.effects).some(effect => effect.status === "requested" || effect.status === "started")) return true;
      }
      if ((await storage.listWakes?.(route.sessionId, route.branchId, ["queued", "claimed"]))?.length) return true;
      // Future active triggers are detached work too: exiting would prevent them
      // from becoming due because this local product has no boot/login daemon.
      if ((await storage.listSchedules?.(route.sessionId, route.branchId))?.some(schedule => schedule.status === "active")) return true;
      if ((await storage.listHeartbeats?.(route.sessionId, route.branchId))?.some(heartbeat => heartbeat.status === "active")) return true;
    }
    return false;
  }

  async #keepAliveReasons(attachedClients: number): Promise<ManagedServiceStatus["keepAliveReasons"]> {
    const counts = new Map<ManagedServiceStatus["keepAliveReasons"][number]["kind"], number>();
    const add = (kind: ManagedServiceStatus["keepAliveReasons"][number]["kind"], count = 1): void => {
      counts.set(kind, (counts.get(kind) ?? 0) + count);
    };
    if (attachedClients > 0) add("attached_clients", attachedClients);
    if (this.#workers.busy) add("resident_workers");
    const console = this.supervisor.console.capacityStatus();
    add("resident_workers", console.residentProcesses);
    add("active_executions", console.activeExecutions);
    const storage = this.supervisor.storage;
    for (const route of await this.#ownedRoutes()) {
      const events = await storage.loadEvents(route.sessionId, { branchId: route.branchId });
      if (events.length) {
        const state = projectEvents(events);
        add("active_runs", Object.values(state.agentRuns).filter(run => run.status === "queued" || run.status === "running").length);
        add("pending_effects", Object.values(state.effects).filter(effect =>
          effect.executor !== "managed-process" &&
          (effect.status === "requested" || effect.status === "started")
        ).length);
        add("managed_processes", Object.values(state.managedProcesses).filter(process =>
          process.status === "queued" || process.status === "running"
        ).length);
      }
      add("queued_wakes", (await storage.listWakes?.(route.sessionId, route.branchId, ["queued", "claimed"]))?.length ?? 0);
      add("active_schedules", (await storage.listSchedules?.(route.sessionId, route.branchId))?.filter(schedule => schedule.status === "active").length ?? 0);
      add("active_heartbeats", (await storage.listHeartbeats?.(route.sessionId, route.branchId))?.filter(heartbeat => heartbeat.status === "active").length ?? 0);
    }
    const labels: Record<ManagedServiceStatus["keepAliveReasons"][number]["kind"], [string, string]> = {
      attached_clients: ["attached client", "attached clients"],
      resident_workers: ["resident worker", "resident workers"],
      active_executions: ["active console execution", "active console executions"],
      active_runs: ["active run", "active runs"],
      pending_effects: ["pending effect", "pending effects"],
      managed_processes: ["managed process", "managed processes"],
      queued_wakes: ["queued wake", "queued wakes"],
      active_schedules: ["active schedule", "active schedules"],
      active_heartbeats: ["active heartbeat", "active heartbeats"],
    };
    return [...counts.entries()]
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => ({ kind, count, summary: `${count} ${labels[kind][count === 1 ? 0 : 1]}` }));
  }

  async #ownedRoutes(): Promise<Array<{ sessionId: string; branchId: string }>> {
    const storage = this.supervisor.storage;
    const sessions = new Map<string, Awaited<ReturnType<NonNullable<typeof storage.getSession>>>>();
    const routes: Array<{ sessionId: string; branchId: string }> = [];
    for (const route of await storage.listBranches()) {
      let session = sessions.get(route.sessionId);
      if (session === undefined) {
        session = await storage.getSession?.(route.sessionId) ?? null;
        sessions.set(route.sessionId, session);
      }
      if (!session || session.workspaceId !== this.config.workspace.workspaceId) continue;
      if (session.executionOwnerDeviceId && session.executionOwnerDeviceId !== this.supervisor.device.deviceId) continue;
      routes.push(route);
    }
    return routes;
  }

  #startRecovery(): void {
    this.#recovery = "running";
    this.#recoveryPromise = this.supervisor.recoverExecution({ drainPending: false }).then(() => {
      this.#recovery = "complete";
    }, (error) => {
      this.#recovery = "failed";
      this.#recoveryError = scrubText(error instanceof Error ? error.message : String(error));
    });
  }
}

async function probeManifest(manifest: ServiceManifestV1): Promise<ServiceHealthEvidence> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch(`${manifest.url}/health`, {
      signal: controller.signal,
      headers: { authorization: `Bearer ${manifest.bearerToken}` },
    });
    if (response.status === 401) return { status: "unauthorized" };
    if (!response.ok) return { status: "unreachable" };
    const body = await response.json() as Record<string, unknown>;
    if (body.workspaceId !== manifest.workspaceId || body.instanceId !== manifest.instanceId) return { status: "identity-mismatch" };
    if (body.ready === false) return { status: "unreachable" };
    return { status: "healthy", authenticated: body.authenticated === true, workspaceId: String(body.workspaceId), instanceId: String(body.instanceId) };
  } catch { return { status: "unreachable" }; }
  finally { clearTimeout(timeout); }
}

async function inspectManifestLease(config: ManagedServiceConfiguration, manifest: ServiceManifestV1): Promise<ServiceLeaseEvidence> {
  const storage = new LibSqlStorage({ url: `file:${resolve(config.databasePath)}`, deviceId: manifest.deviceId });
  try {
    const lease = await storage.getProcessExecutionLease({ kind: "workspace", workspaceId: manifest.workspaceId });
    if (!lease || lease.releasedAt !== null) return { status: "absent" };
    return { status: "held", instanceId: lease.ownerProcessId, expiresAt: lease.leaseExpiresAt };
  } catch { return { status: "unknown" }; }
  finally { storage.close(); }
}

async function assessment(config: ManagedServiceConfiguration): Promise<ServiceAssessment> {
  return assessService({
    workspaceRoot: config.workspace.root,
    workspaceId: config.workspace.workspaceId,
    compatibility: {
      configHash: managedServiceConfigurationHash(config),
      protocolMin: MANAGED_SERVICE_CLIENT_PROTOCOL_MIN_VERSION,
      protocolMax: MANAGED_SERVICE_PROTOCOL_VERSION,
    },
    probeHealth: async () => {
      const manifest = await readServiceManifest({ workspaceRoot: config.workspace.root, workspaceId: config.workspace.workspaceId });
      return manifest ? probeManifest(manifest) : { status: "unreachable" };
    },
    inspectLease: async () => {
      const manifest = await readServiceManifest({ workspaceRoot: config.workspace.root, workspaceId: config.workspace.workspaceId });
      return manifest ? inspectManifestLease(config, manifest) : { status: "absent" };
    },
  });
}

async function terminateSpawnedServiceChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
    child.once("error", () => resolveExit());
  });
  child.kill("SIGTERM");
  await Promise.race([exited, Bun.sleep(1_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, Bun.sleep(1_000)]);
  }
}

function serviceChildStartupError(stderr: Buffer, exitCode: number | null, signalCode: NodeJS.Signals | null): Error {
  const retained = scrubText(stderr.toString("utf8")).trim()
    .replace(/^Agencity error \[[A-Z0-9_]+\]:\s*/, "");
  if (retained) return new Error(retained);
  if (exitCode !== null) return new Error(`Managed workspace service child exited with code ${exitCode}`);
  if (signalCode !== null) return new Error(`Managed workspace service child exited from signal ${signalCode}`);
  return new Error("Managed workspace service child exited before publishing health");
}

/** Discovers a compatible service or securely elects one detached child on demand. */
export async function connectManagedService(config: ManagedServiceConfiguration, options: { readonly spawn?: boolean; readonly timeoutMs?: number } = {}): Promise<ManagedServiceConnection> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let current = await assessment(config);
  while (
    options.spawn !== false &&
    current.kind === "found" &&
    current.decision.kind === "conflict" &&
    current.decision.reason === "lease-held-without-health" &&
    Date.now() < deadline
  ) {
    // A graceful shutdown makes health unavailable before it releases the
    // durable execution lease and discovery manifest. Wait for that fenced
    // handoff instead of turning an immediate product reopen into a conflict.
    await Bun.sleep(25);
    current = await assessment(config);
  }
  if (current.kind === "found" && current.decision.kind === "authoritative") {
    return { client: new AgentClient(current.manifest.url, current.manifest.bearerToken), manifest: current.manifest, started: false };
  }
  if (current.kind === "found" && current.decision.kind === "conflict") throw authorityDecisionError(current.decision)!;
  if (current.kind === "found" && current.decision.kind === "stale") {
    await cleanupStaleServiceManifest({ workspaceRoot: config.workspace.root, workspaceId: config.workspace.workspaceId, observedManifest: current.manifest, decision: current.decision });
  }
  if (options.spawn === false) throw new ValidationError("Managed workspace service is not running");
  const specification = buildServiceChildSpawnSpecification({ workspaceRoot: config.workspace.root });
  const child = spawn(specification.executable, [...specification.argv], {
    ...specification.options,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, [MANAGED_SERVICE_CONFIG_ENV]: encodeManagedServiceConfiguration(config) },
  });
  let spawnError: unknown;
  let childStderr = Buffer.alloc(0);
  child.once("error", error => { spawnError = error; });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    if (childStderr.byteLength >= MAX_SERVICE_CHILD_STARTUP_ERROR_BYTES) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = MAX_SERVICE_CHILD_STARTUP_ERROR_BYTES - childStderr.byteLength;
    childStderr = Buffer.concat([childStderr, bytes.subarray(0, remaining)]);
  });
  const childClosed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
  child.unref();
  let lastError: unknown;
  while (Date.now() < deadline) {
    await Bun.sleep(25);
    if (child.exitCode !== null || child.signalCode !== null) {
      await Promise.race([childClosed, Bun.sleep(100)]);
      lastError = spawnError ?? serviceChildStartupError(childStderr, child.exitCode, child.signalCode);
      break;
    }
    try {
      current = await assessment(config);
      if (current.kind === "found" && current.decision.kind === "authoritative") {
        if (child.pid !== current.manifest.pidHint && child.exitCode === null && child.signalCode === null) await terminateSpawnedServiceChild(child);
        child.stderr?.destroy();
        return { client: new AgentClient(current.manifest.url, current.manifest.bearerToken), manifest: current.manifest, started: true };
      }
      if (current.kind === "found" && current.decision.kind === "conflict") lastError = authorityDecisionError(current.decision);
      else if (spawnError) lastError = spawnError;
    } catch (error) { lastError = error; }
  }
  await terminateSpawnedServiceChild(child);
  child.stderr?.destroy();
  throw new ValidationError(`Managed workspace service did not become healthy${lastError instanceof Error ? `: ${scrubText(lastError.message)}` : ""}`);
}

/** Read-only observer: it never creates state, migrates, recovers, ticks, or spawns. */
export async function observeManagedService(config: ManagedServiceConfiguration): Promise<{ state: "stopped" | "running" | "conflict"; manifest?: ServiceManifestV1; health?: ServiceHealthEvidence }> {
  const paths = serviceStatePaths(config.workspace.root);
  try { await access(paths.manifestPath); } catch { return { state: "stopped" }; }
  const manifest = await readServiceManifest({ workspaceRoot: config.workspace.root, workspaceId: config.workspace.workspaceId });
  if (!manifest) return { state: "stopped" };
  try {
    assertServiceCompatibility(manifest, {
      configHash: managedServiceConfigurationHash(config),
      protocolMin: MANAGED_SERVICE_CLIENT_PROTOCOL_MIN_VERSION,
      protocolMax: MANAGED_SERVICE_PROTOCOL_VERSION,
    });
  } catch { return { state: "conflict", manifest }; }
  const health = await probeManifest(manifest);
  if (health.status !== "healthy" || !health.authenticated) return { state: "conflict", manifest, health };
  return { state: "running", manifest, health };
}

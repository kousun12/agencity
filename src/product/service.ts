import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { ValidationError, newId, projectEvents } from "../domain/index.ts";
import { AgentClient, ProtocolServer } from "../protocol/index.ts";
import { Supervisor, type AgentRunResult, type StartAgentRunInput } from "../runtime/index.ts";
import { LibSqlStorage } from "../storage/index.ts";
import { scrubText } from "../security/index.ts";
import { ProductCatalog } from "./catalog.ts";
import { workspacePreferenceKey, type ResolvedWorkspace } from "./workspace.ts";
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

export const MANAGED_SERVICE_PROTOCOL_VERSION = 1;
export const MANAGED_SERVICE_CONFIG_ENV = "AGENCITY_SERVICE_CONFIG";

export interface ManagedServiceConfiguration {
  readonly workspace: ResolvedWorkspace;
  readonly databasePath: string;
  readonly artifactDirectory: string;
  readonly profileDatabasePath: string;
  readonly restartConsoleAfterCell?: boolean;
  /** Internal/test override; production defaults to a five-second local lease. */
  readonly leaseMs?: number;
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
  readonly leaseMs: number;
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
  readonly roots: readonly {
    readonly sessionId: string;
    readonly branchId: string;
    readonly name: string;
    readonly status: string;
    readonly worker: "running" | "idle" | "detached";
    readonly unresolvedWork: number;
  }[];
}

function normalizedConfiguration(input: ManagedServiceConfiguration): ManagedServiceConfiguration {
  return {
    workspace: { root: resolve(input.workspace.root), workspaceId: input.workspace.workspaceId, name: input.workspace.name, stateDirectory: resolve(input.workspace.stateDirectory) },
    databasePath: resolve(input.databasePath),
    artifactDirectory: resolve(input.artifactDirectory),
    profileDatabasePath: resolve(input.profileDatabasePath),
    restartConsoleAfterCell: input.restartConsoleAfterCell ?? false,
    leaseMs: input.leaseMs ?? 5_000,
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
    leaseMs: normalized.leaseMs ?? 5_000,
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
    leaseMs: serialized.leaseMs,
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
  #lifecycle: ManagedServiceStatus["lifecycle"] = "starting";
  #recovery: ManagedServiceStatus["recovery"] = "pending";
  #recoveryError: string | null = null;
  #recoveryPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;

  private constructor(
    supervisor: Supervisor,
    catalog: ProductCatalog,
    protocol: ProtocolServer,
    manifest: ServiceManifestV1,
    config: ManagedServiceConfiguration,
  ) {
    this.supervisor = supervisor;
    this.catalog = catalog;
    this.protocol = protocol;
    this.manifest = manifest;
    this.config = config;
    this.#startedAt = manifest.startedAt;
  }

  static async open(config: ManagedServiceConfiguration, appVersion: string): Promise<ManagedWorkspaceService> {
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
      recover: false,
      startWakeSchedulers: false,
      executionLease: {
        workspaceId: normalized.workspace.workspaceId,
        ownerProcessId: instanceId,
        leaseMs: normalized.leaseMs ?? 5_000,
        renewalIntervalMs: Math.max(1, Math.floor((normalized.leaseMs ?? 5_000) / 3)),
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
    const catalog = new ProductCatalog(supervisor, normalized.workspace.workspaceId);
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const bearerToken = Buffer.from(tokenBytes).toString("base64url");
    let protocol!: ProtocolServer;
    const hooks = {
      health: {
        workspaceId: normalized.workspace.workspaceId,
        instanceId,
        appVersion,
        protocolMin: MANAGED_SERVICE_PROTOCOL_VERSION,
        protocolMax: MANAGED_SERVICE_PROTOCOL_VERSION,
        configHash: managedServiceConfigurationHash(normalized),
      },
      status: () => service!.status(),
      shutdown: () => service!.requestShutdown(),
      agents: () => service!.agents(),
      startRun: (sessionId: string, branchId: string, input: StartAgentRunInput) => service!.startRun(sessionId, branchId, input),
      stop: (sessionId: string, branchId: string, reason?: string) => service!.stop(sessionId, branchId, reason),
      productSessions: () => catalog.list(),
      productSelect: (target?: string, branchId?: string) => catalog.select(target, branchId),
      productRename: async (sessionId: string, branchId: string | undefined, name: string) => { await catalog.rename(sessionId, branchId, name); return { renamed: true }; },
      productConfig: async () => {
        const model = await supervisor.profile.getPreference(workspacePreferenceKey(normalized.workspace.workspaceId, "model"));
        const credentialReferences = (await supervisor.profile.listCredentialReferences()).map(({ reference, provider, label, createdAt, updatedAt }) => ({ reference, provider, label, createdAt, updatedAt }));
        return { defaultModel: typeof model?.value === "string" ? model.value : null, credentialReferences };
      },
      productSetModel: async (model: string | null) => {
        if (model !== null && !model.trim()) throw new ValidationError("Model preference is required");
        await supervisor.profile.setPreference(workspacePreferenceKey(normalized.workspace.workspaceId, "model"), model === null ? null : model.trim());
        return { defaultModel: model === null ? null : model.trim() };
      },
      productCredentialReference: async (provider: string, reference: string, label: string) => {
        const record = await supervisor.profile.putCredentialReference({ reference, provider, label, metadata: { kind: "opaque-handle" } });
        return { reference: record.reference, provider: record.provider, label: record.label };
      },
    };
    protocol = new ProtocolServer(supervisor, { bearerToken, service: hooks });
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
    try {
      const publication = await publishServiceManifest({ workspaceRoot: normalized.workspace.root, workspaceId: normalized.workspace.workspaceId, manifest });
      if (publication.kind !== "published" || publication.manifest.instanceId !== instanceId) {
        throw new ValidationError("Another managed workspace service won discovery publication");
      }
    } catch (error) {
      protocol.stop();
      await supervisor.close();
      throw error;
    }
    service = new ManagedWorkspaceService(supervisor, catalog, protocol, manifest, normalized);
    service.#lifecycle = "running";
    supervisor.startWakeSchedulers();
    service.#startRecovery();
    return service;
  }

  async status(): Promise<ManagedServiceStatus> {
    const summaries = await this.catalog.list();
    return {
      lifecycle: this.#lifecycle,
      mode: "trusted-local",
      instanceId: this.manifest.instanceId,
      workspaceId: this.manifest.workspaceId,
      startedAt: this.#startedAt,
      recovery: this.#recovery,
      recoveryError: this.#recoveryError,
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
    const session = await this.supervisor.storage.getSession?.(sessionId);
    if (!session) throw new ValidationError(`Session not found: ${sessionId}`);
    await this.supervisor.executionLeases!.ensureRoot(session.rootSessionId);
    const admitted = await this.supervisor.runs.admit(sessionId, branchId, input);
    if (!["queued", "running"].includes(admitted.status)) return { accepted: false, ...admitted };
    const cursor = await this.supervisor.storage.getLatestCursor(sessionId, branchId) ?? "0";
    this.#workers.enqueue(session.rootSessionId, async () => {
      try { await this.supervisor.runs.advance(sessionId, branchId, admitted.runId); }
      catch (error) { this.#recoveryError = scrubText(error instanceof Error ? error.message : String(error)); }
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
    this.#closePromise = (async () => {
      if (this.#lifecycle !== "failed") this.#lifecycle = "draining";
      await this.#recoveryPromise?.catch(() => {});
      await this.#workers.drain();
      await this.supervisor.heartbeats.close();
      await this.supervisor.schedules.close();
      await unpublishServiceManifest({
        workspaceRoot: this.config.workspace.root,
        workspaceId: this.config.workspace.workspaceId,
        manifest: this.manifest,
      }).catch(() => {});
      this.protocol.stop();
      await this.supervisor.close();
      if (this.#lifecycle !== "failed") this.#lifecycle = "stopped";
    })();
    return this.#closePromise;
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
      protocolMin: MANAGED_SERVICE_PROTOCOL_VERSION,
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

/** Discovers a compatible service or securely elects one detached child on demand. */
export async function connectManagedService(config: ManagedServiceConfiguration, options: { readonly spawn?: boolean; readonly timeoutMs?: number } = {}): Promise<ManagedServiceConnection> {
  let current = await assessment(config);
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
    env: { ...process.env, [MANAGED_SERVICE_CONFIG_ENV]: encodeManagedServiceConfiguration(config) },
  });
  child.unref();
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    await Bun.sleep(25);
    try {
      current = await assessment(config);
      if (current.kind === "found" && current.decision.kind === "authoritative") {
        return { client: new AgentClient(current.manifest.url, current.manifest.bearerToken), manifest: current.manifest, started: true };
      }
      if (current.kind === "found" && current.decision.kind === "conflict") lastError = authorityDecisionError(current.decision);
    } catch (error) { lastError = error; }
  }
  throw new ValidationError(`Managed workspace service did not become healthy${lastError instanceof Error ? `: ${scrubText(lastError.message)}` : ""}`);
}

/** Read-only observer: it never creates state, migrates, recovers, ticks, or spawns. */
export async function observeManagedService(config: ManagedServiceConfiguration): Promise<{ state: "stopped" | "running" | "conflict"; manifest?: ServiceManifestV1; health?: ServiceHealthEvidence }> {
  const paths = serviceStatePaths(config.workspace.root);
  try { await access(paths.manifestPath); } catch { return { state: "stopped" }; }
  const manifest = await readServiceManifest({ workspaceRoot: config.workspace.root, workspaceId: config.workspace.workspaceId });
  if (!manifest) return { state: "stopped" };
  try {
    assertServiceCompatibility(manifest, { configHash: managedServiceConfigurationHash(config), protocolMin: MANAGED_SERVICE_PROTOCOL_VERSION, protocolMax: MANAGED_SERVICE_PROTOCOL_VERSION });
  } catch { return { state: "conflict", manifest }; }
  const health = await probeManifest(manifest);
  if (health.status !== "healthy" || !health.authenticated) return { state: "conflict", manifest, health };
  return { state: "running", manifest, health };
}

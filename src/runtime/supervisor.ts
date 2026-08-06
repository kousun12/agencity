import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalArtifactStore } from "../artifacts/index.ts";
import {
  ConsoleCellError,
  ConsoleProcess,
  MAX_CELL_OBSERVATION_JSON_BYTES,
  type CellHistoryEntry,
  type CellHistoryStatus,
  type CellListOptions,
  type EventProvenance,
} from "../console/index.ts";
import {
  CapabilityUnavailableError,
  assertJsonValue,
  jsonBytes,
  MAX_WORKING_JSON_BYTES,
  newId,
  NotFoundError,
  projectEvents,
  ValidationError,
  type AgentEvent,
  type ArtifactReference,
  type BudgetLimits,
  type JsonValue,
  type ModelConfiguration,
  type WorkingValue,
} from "../domain/index.ts";
import {
  EchoModelProvider,
  FileExecutor,
  ModelExecutor,
  OpenAICompatibleProvider,
  ShellExecutor,
  SkillExecutor,
  type ModelProvider,
  type ProviderConcurrency,
} from "../executors/index.ts";
import { LibSqlStorage, ProfileStore, TursoSyncTransport, type AgentStorage } from "../storage/index.ts";
import { SyncService, type DeleteOwnedDataInput, type DeviceIdentity, type ManagedReplicaDeletionAdmin, type PhysicalDeletionReceipt, type SyncTransport } from "../sync/index.ts";
import { ContextMaterializer } from "./context.ts";
import { ModelLoop } from "./model-loop.ts";
import { OutboxRunner } from "./outbox.ts";
import { ProjectionService } from "./projection.ts";
import { containsBrokeredSecret, scrubJson, scrubText } from "../security/index.ts";
import { AgentService } from "./agents.ts";
import { DocumentService } from "./documents.ts";
import { GoalService } from "./goals.ts";
import { HeartbeatService } from "./heartbeats.ts";
import { ScheduleService } from "./schedules.ts";
import { RecursiveModelService } from "./models.ts";
import { MemoryService } from "./memory.ts";
import { HarnessService } from "./harness.ts";
import { SkillService } from "./skills.ts";
import { SubagentSpecService } from "./specs.ts";
import { AgentRunService } from "./agent-runs.ts";
import { ManagedExecutionLeaseCoordinator, createFencedAgentStorage } from "./execution-leases.ts";
import { EffectReconciliationService } from "./effect-reconciliation.ts";
import { RefinerService } from "./refiner.ts";
import { SkillManagementService } from "./skill-management.ts";
import { CompactionService, type CompactContextInput, type ContextCompactionView, type ContextInspection } from "./context-compaction.ts";

export interface SupervisorOptions {
  readonly databaseUrl: string;
  readonly artifactDirectory: string;
  /** Defaults to shared/fail-closed; assert exclusive only for a workspace-owned CAS root. */
  readonly artifactDirectoryOwnership?: "exclusive" | "shared";
  readonly workspaceRoot?: string;
  readonly restartConsoleAfterCell?: boolean;
  readonly modelProviders?: readonly ModelProvider[];
  readonly recover?: boolean;
  readonly maxSessionDepth?: number;
  readonly maxChildrenPerSession?: number;
  /** Shared limit for every model effect; a map may override individual providers. */
  readonly providerConcurrency?: ProviderConcurrency;
  /** Poll interval for the live database-driven heartbeat scheduler (default 100ms). */
  readonly heartbeatPollIntervalMs?: number;
  /** Runtime-owned authority key for the profile/user scope. */
  readonly userScopeKey?: string;
  /** Enables managed workspace+root process fencing for a resident service. */
  readonly executionLease?: {
    readonly ownerProcessId: string;
    readonly workspaceId: string;
    readonly leaseMs?: number;
    readonly renewalIntervalMs?: number;
    readonly onLost?: (error: unknown) => void;
  };
  /** Embedded diagnostics may opt out; managed services start only after lease admission. */
  readonly startWakeSchedulers?: boolean;
  /** Exact generated-skill permission names allowed at activation and invocation (default: none). */
  readonly skillPermissionAllowlist?: readonly string[];
  /** Separate durable profile catalog/preferences/credential-reference database. */
  readonly profileDatabaseUrl?: string;
  readonly deviceName?: string;
  /** Optional cloud transport. Without this block the runtime is completely local-only. */
  readonly sync?: {
    readonly workspaceId: string;
    readonly workspaceName?: string;
    readonly syncUrl?: string;
    readonly replicaUrl?: string;
    readonly authToken?: string;
    readonly credentialReference?: string;
    readonly intervalMs?: number;
    readonly startup?: boolean;
    /** Deterministic in-process transports can be injected for conformance tests. */
    readonly transport?: SyncTransport;
    /** Separate authenticated control plane; sync credentials alone cannot delete Cloud data. */
    readonly remoteDeletionAdmin?: ManagedReplicaDeletionAdmin;
  };
}

export interface CreateSessionOptions {
  readonly workspaceId: string;
  readonly model?: ModelConfiguration;
  readonly budget?: BudgetLimits;
  readonly sessionId?: string;
  readonly branchId?: string;
  readonly sessionName?: string;
  readonly branchName?: string;
}

/** Serializes committed cell boundaries per branch without retaining domain state. */
class BranchQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => current);
    this.#tails.set(key, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

interface CellHistoryWithCursor {
  readonly entry: CellHistoryEntry;
  readonly cursor: string;
}

function provenance(event: AgentEvent): EventProvenance {
  return {
    eventId: event.id,
    cursor: event.cursor,
    sessionId: event.sessionId,
    branchId: event.branchId,
    type: event.type,
    schemaVersion: event.schemaVersion,
    committedAt: event.committedAt,
    producer: event.producer,
    originDeviceId: event.originDeviceId,
    originSequence: event.originSequence,
  };
}

function cellHistory(events: readonly AgentEvent[]): CellHistoryWithCursor[] {
  const byId = new Map<string, { proposed: AgentEvent<"CellProposed">; starts: AgentEvent<"CellStarted">[]; terminal?: AgentEvent }>();
  for (const event of events) {
    if (event.type === "CellProposed") {
      const typed = event as AgentEvent<"CellProposed">;
      byId.set(typed.payload.cellId, { proposed: typed, starts: [] });
      continue;
    }
    if (!["CellStarted", "CellCommitted", "CellFailed", "CellAbandoned"].includes(event.type)) continue;
    const cellId = (event.payload as { cellId: string }).cellId;
    const record = byId.get(cellId);
    if (!record) continue;
    if (event.type === "CellStarted") record.starts.push(event as AgentEvent<"CellStarted">);
    else record.terminal = event;
  }
  const entries: CellHistoryWithCursor[] = [];
  for (const { proposed, starts, terminal } of byId.values()) {
    let status: CellHistoryStatus = starts.length ? "running" : "proposed";
    let observation: JsonValue | null = null;
    let logs: string[] = [];
    let durationMs: number | null = null;
    let exports: string[] = [];
    let error: string | null = null;
    if (terminal?.type === "CellCommitted") {
      status = "committed";
      const payload = terminal.payload as { result: JsonValue; logs: string[]; durationMs: number; exports: string[] };
      observation = payload.result;
      logs = payload.logs;
      durationMs = payload.durationMs;
      exports = payload.exports;
    } else if (terminal?.type === "CellFailed") {
      status = "failed";
      const payload = terminal.payload as { error: string; logs: string[]; durationMs: number };
      error = payload.error;
      logs = payload.logs;
      durationMs = payload.durationMs;
    } else if (terminal?.type === "CellAbandoned") {
      status = "abandoned";
      error = (terminal.payload as { reason: string }).reason;
    }
    const cursor = terminal?.cursor ?? starts.at(-1)?.cursor ?? proposed.cursor;
    entries.push({
      cursor,
      entry: {
        cellId: proposed.payload.cellId,
        source: proposed.payload.code,
        status,
        dependencies: [...proposed.payload.dependencies],
        attempts: starts.length,
        observation,
        logs: [...logs],
        durationMs,
        exports: [...exports],
        error,
        provenance: {
          proposed: provenance(proposed),
          starts: starts.map(provenance),
          terminal: terminal ? provenance(terminal) : null,
        },
      },
    });
  }
  return entries.sort((left, right) => right.cursor.localeCompare(left.cursor));
}

const CELL_HISTORY_STATUSES: readonly CellHistoryStatus[] = ["proposed", "running", "committed", "failed", "abandoned"];
function cellListOptions(raw: unknown): Required<Pick<CellListOptions, "limit">> & { statuses: ReadonlySet<CellHistoryStatus>; beforeCursor: string | null } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("Cell list options must be an object");
  const options = raw as Record<string, unknown>;
  const limit = options.limit === undefined ? 20 : Number(options.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ValidationError("Cell list limit must be an integer from 1 to 100");
  const requested = options.status === undefined
    ? ["committed", "failed", "abandoned"]
    : Array.isArray(options.status) ? options.status : [options.status];
  if (!requested.length || !requested.every((status): status is CellHistoryStatus =>
    typeof status === "string" && CELL_HISTORY_STATUSES.includes(status as CellHistoryStatus))) {
    throw new ValidationError("Invalid cell history status filter");
  }
  let beforeCursor: string | null = null;
  if (options.beforeCursor !== undefined) {
    if (typeof options.beforeCursor !== "string" || !/^\d{1,20}$/.test(options.beforeCursor) ||
        !Number.isSafeInteger(Number(options.beforeCursor))) throw new ValidationError("Invalid cell history cursor");
    beforeCursor = Number(options.beforeCursor).toString().padStart(20, "0");
  }
  return { limit, statuses: new Set(requested), beforeCursor };
}

export class Supervisor {
  readonly storage: AgentStorage;
  readonly profile: ProfileStore;
  readonly device: DeviceIdentity;
  readonly sync: SyncService;
  readonly artifacts: LocalArtifactStore;
  readonly console: ConsoleProcess;
  readonly outbox: OutboxRunner;
  readonly projections: ProjectionService;
  readonly contexts: ContextMaterializer;
  readonly compactions: CompactionService;
  readonly modelLoop: ModelLoop;
  readonly agents: AgentService;
  readonly documents: DocumentService;
  readonly models: RecursiveModelService;
  readonly goals: GoalService;
  readonly heartbeats: HeartbeatService;
  readonly schedules: ScheduleService;
  readonly memory: MemoryService;
  readonly harness: HarnessService;
  readonly skills: SkillService;
  readonly skillManagement: SkillManagementService;
  readonly specs: SubagentSpecService;
  readonly runs: AgentRunService;
  readonly effectReconciliation: EffectReconciliationService;
  readonly refiner: RefinerService;
  /** Process-local executor/provider catalog; descriptors contain no credential material. */
  readonly modelExecutor: ModelExecutor;
  readonly restartConsoleAfterCell: boolean;
  readonly executionLeases: ManagedExecutionLeaseCoordinator | null;
  readonly #cells = new BranchQueue();
  #closed = false;

  private constructor(
    storage: AgentStorage,
    profile: ProfileStore,
    device: DeviceIdentity,
    sync: SyncService,
    artifacts: LocalArtifactStore,
    consoleProcess: ConsoleProcess,
    outbox: OutboxRunner,
    restartConsoleAfterCell: boolean,
    maxSessionDepth: number,
    maxChildrenPerSession: number,
    userScopeKey: string,
    skillPermissionAllowlist: readonly string[],
    modelExecutor: ModelExecutor,
    executionLeases: ManagedExecutionLeaseCoordinator | null,
  ) {
    this.storage = storage;
    this.profile = profile;
    this.device = device;
    this.sync = sync;
    this.artifacts = artifacts;
    this.console = consoleProcess;
    this.outbox = outbox;
    this.projections = new ProjectionService(storage);
    this.agents = new AgentService(storage, outbox, maxSessionDepth, maxChildrenPerSession);
    this.skills = new SkillService(storage, outbox, skillPermissionAllowlist, userScopeKey);
    this.harness = new HarnessService(storage, this.skills, userScopeKey);
    this.memory = new MemoryService(storage, undefined, userScopeKey);
    this.specs = new SubagentSpecService(storage, this.agents, userScopeKey);
    this.modelExecutor = modelExecutor;
    this.executionLeases = executionLeases;
    this.contexts = new ContextMaterializer(storage, this.memory, this.harness, 30, userScopeKey, profile);
    this.compactions = new CompactionService(storage, outbox, modelExecutor);
    this.modelLoop = new ModelLoop(storage, this.contexts, outbox, this.compactions, modelExecutor);
    this.documents = new DocumentService(storage);
    this.goals = new GoalService(storage, outbox);
    this.heartbeats = new HeartbeatService(storage);
    this.schedules = new ScheduleService(storage);
    this.models = new RecursiveModelService(storage, this.agents, this.modelLoop, outbox, artifacts, this.memory);
    this.restartConsoleAfterCell = restartConsoleAfterCell;
    this.runs = new AgentRunService(storage, this.contexts, outbox, this.goals, this.executeCell.bind(this), 128, this.compactions, modelExecutor);
    this.effectReconciliation = new EffectReconciliationService(storage);
    this.refiner = new RefinerService(storage, this.models, this.harness, profile, userScopeKey);
    this.skillManagement = new SkillManagementService(storage, profile, this.harness, this.skills, this.refiner, userScopeKey, device.profileId);
    this.skills.attachCatalog(this.skillManagement);
    this.contexts.attachSkillCatalog(this.skillManagement);
    this.schedules.attachRunService(this.runs);
    this.agents.attachRunService(this.runs);
    this.runs.setBoundaryObserver(async (sessionId, branchId, runId) => { await this.agents.deliverQueuedAtBoundary(sessionId, branchId, runId); await this.refiner.scanBoundary(sessionId, branchId, runId); });
  }

  static async open(options: SupervisorOptions): Promise<Supervisor> {
    const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    const profileDatabaseUrl=options.profileDatabaseUrl??adjacentFileUrl(options.databaseUrl,".profile.db");
    if(profileDatabaseUrl.startsWith("file:"))await mkdir(dirname(fileURLToPath(new URL(profileDatabaseUrl))),{recursive:true});
    const profile = await ProfileStore.open(profileDatabaseUrl);
    const device = await profile.getOrCreateDeviceIdentity(options.deviceName);
    const openingWorkspaceId=options.sync?.workspaceId??"default";const catalog=await profile.getWorkspace(openingWorkspaceId);
    if(catalog?.deletedAt){profile.close();throw new ValidationError("Configured workspace is tombstoned and cannot be silently reclaimed",{workspaceId:openingWorkspaceId,deletedAt:catalog.deletedAt});}
    if (options.sync?.credentialReference && !await profile.getCredentialReference(options.sync.credentialReference)) {
      profile.close();
      throw new ValidationError(`Unknown profile credential reference: ${options.sync.credentialReference}`);
    }
    await mkdir(options.artifactDirectory,{recursive:true});
    await mkdir(workspaceRoot,{recursive:true});
    const rawStorage = new LibSqlStorage({ url: options.databaseUrl, deviceId: device.deviceId });
    await rawStorage.migrate();
    let executionLeases: ManagedExecutionLeaseCoordinator | null = null;
    let storage = rawStorage;
    if (options.executionLease) {
      executionLeases = await ManagedExecutionLeaseCoordinator.open(rawStorage, {
        workspaceId: options.executionLease.workspaceId,
        ownerProcessId: options.executionLease.ownerProcessId,
        ownerDeviceId: device.deviceId,
        ...(options.executionLease.leaseMs === undefined ? {} : { leaseMs: options.executionLease.leaseMs }),
        ...(options.executionLease.renewalIntervalMs === undefined ? {} : { renewalIntervalMs: options.executionLease.renewalIntervalMs }),
        ...(options.executionLease.onLost === undefined ? {} : { onLost: options.executionLease.onLost }),
      });
      storage = createFencedAgentStorage(rawStorage, executionLeases);
    }
    const replicaUrl = options.sync?.replicaUrl ?? (options.sync?.syncUrl ? adjacentFileUrl(options.databaseUrl, ".sync-replica.db") : undefined);
    const transport = options.sync?.transport ?? (options.sync?.syncUrl ? new TursoSyncTransport({
      replicaUrl: replicaUrl!,
      syncUrl: options.sync.syncUrl,
      ...(options.sync.authToken === undefined ? {} : { authToken: options.sync.authToken }),
    }) : undefined);
    const sync = new SyncService({
      storage, profile, device,
      workspaceId: options.sync?.workspaceId ?? "default",
      ...(options.sync?.workspaceName === undefined ? {} : { workspaceName: options.sync.workspaceName }),
      databaseUrl: options.databaseUrl,
      artifactDirectory: options.artifactDirectory,
      ...(options.artifactDirectoryOwnership === undefined ? {} : { artifactDirectoryOwnership: options.artifactDirectoryOwnership }),
      ...(options.sync?.syncUrl === undefined ? {} : { syncUrl: options.sync.syncUrl }),
      ...(replicaUrl === undefined ? {} : { replicaUrl }),
      ...(options.sync?.credentialReference === undefined ? {} : { credentialReference: options.sync.credentialReference }),
      ...(options.sync?.remoteDeletionAdmin === undefined ? {} : { remoteDeletionAdmin: options.sync.remoteDeletionAdmin }),
      ...(options.sync?.intervalMs === undefined ? {} : { intervalMs: options.sync.intervalMs }),
      ...(transport === undefined ? {} : { transport }),
    });
    try { await sync.start(options.sync?.startup ?? true); }
    catch (error) {
      await sync.stop().catch(() => {});
      await executionLeases?.close().catch(() => {});
      storage.close();profile.close();
      throw error;
    }
    const artifacts = new LocalArtifactStore(options.artifactDirectory);
    const providers: ModelProvider[] = [new EchoModelProvider(), ...(options.modelProviders ?? [])];
    if (process.env.OPENAI_API_KEY) {
      providers.push(new OpenAICompatibleProvider({
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: () => process.env.OPENAI_API_KEY,
      }));
    }
    const modelExecutor = new ModelExecutor(providers, options.providerConcurrency ?? 1);
    const executors = [
      new ShellExecutor(workspaceRoot),
      new FileExecutor(workspaceRoot),
      new SkillExecutor(),
      modelExecutor,
    ];
    const supervisor = new Supervisor(
      storage,
      profile,
      device,
      sync,
      artifacts,
      new ConsoleProcess(),
      new OutboxRunner(storage, executors),
      options.restartConsoleAfterCell ?? false,
      options.maxSessionDepth ?? 8,
      options.maxChildrenPerSession ?? 32,
      options.userScopeKey ?? "default-user",
      options.skillPermissionAllowlist ?? [],
      modelExecutor,
      executionLeases,
    );
    if (options.recover !== false) await supervisor.recoverExecution({ drainPending: executionLeases === null });
    if (options.startWakeSchedulers !== false) supervisor.startWakeSchedulers(options.heartbeatPollIntervalMs ?? 100);
    return supervisor;
  }

  /** Secret-free provider descriptors suitable for onboarding and clients. */
  get modelProviders() { return this.modelExecutor.providers(); }

  /** Reconciles retained work only after managed lease admission. */
  async recoverExecution(options: { readonly drainPending?: boolean } = {}): Promise<void> {
    await this.outbox.recover();
    await this.agents.recoverCancellations();
    if (options.drainPending !== false) await this.outbox.drain();
    await this.compactions.recoverIncomplete();
    await this.modelLoop.recoverIncomplete();
    await this.modelLoop.reconcileRunningSessions();
    await this.goals.recoverIncomplete();
    await this.models.recoverIncomplete();
    await this.refiner.recoverIncomplete();
    await this.agents.recoverDeliveries();
    await this.runs.recoverIncomplete();
    await this.runs.recoverOrphanGoals();
    await this.heartbeats.recoverDue();
    await this.schedules.recover();
  }

  /** Wake coordinators are started explicitly by managed services after leases. */
  startWakeSchedulers(pollIntervalMs = 100): void {
    if (this.#closed) throw new ValidationError("Supervisor is closed");
    this.heartbeats.startScheduler(pollIntervalMs);
    this.schedules.startScheduler(pollIntervalMs);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.heartbeats.close();
    await this.schedules.close();
    await this.console.stop();
    await this.refiner.close();
    await this.models.close();
    await this.sync.stop();
    await this.executionLeases?.close();
    this.storage.close();
    this.profile.close();
  }

  /** Quiesces all workers before invoking the terminal physical deletion path. */
  async deleteOwnedData(input: DeleteOwnedDataInput): Promise<PhysicalDeletionReceipt> {
    if (this.#closed) throw new ValidationError("Supervisor is closed");
    await this.heartbeats.close();
    await this.schedules.close();
    await this.console.stop();
    await this.refiner.close();
    await this.models.close();
    await this.outbox.quiesceForDeletion();
    try { return await this.sync.deleteOwnedData(input); }
    finally {
      await this.sync.stop().catch(() => {});
      await this.executionLeases?.close().catch(() => {});
      this.storage.close();this.profile.close();this.#closed = true;
    }
  }

  async createSession(options: CreateSessionOptions): Promise<{ sessionId: string; branchId: string }> {
    if (this.sync.capabilities.configured && options.workspaceId !== this.sync.workspaceId) {
      throw new ValidationError(`Configured cloud replica belongs to workspace ${this.sync.workspaceId}, not ${options.workspaceId}`);
    }
    const now = new Date().toISOString();
    const catalog = await this.profile.getWorkspace(options.workspaceId);
    if (catalog?.ownerProfileId !== undefined && catalog.ownerProfileId !== this.device.profileId) {
      throw new ValidationError("Workspace is owned by another profile", { workspaceId: options.workspaceId, ownerProfileId: catalog.ownerProfileId, profileId: this.device.profileId });
    }
    if (catalog?.deletedAt) throw new ValidationError("Workspace was deleted and cannot be silently reclaimed", { workspaceId: options.workspaceId, deletedAt: catalog.deletedAt });
    if (!catalog) await this.profile.putWorkspace({ workspaceId: options.workspaceId, name: options.workspaceId, databaseUrl: this.sync.databaseUrl, replicaUrl: null, syncUrl: null, credentialReference: null, ownerProfileId: this.device.profileId, createdAt: now, updatedAt: now, deletedAt: null });
    const sessionId = options.sessionId ?? newId();
    const branchId = options.branchId ?? newId();
    const model = options.model ?? { provider: "echo", model: "echo-1" };
    await this.storage.appendEvents([{
      sessionId,
      branchId,
      type: "SessionCreated",
      producer: "supervisor",
      idempotencyKey: `session:${sessionId}`,
      payload: {
        workspaceId: options.workspaceId,
        initialBranchId: branchId,
        model,
        budget: options.budget ?? {},
        ...(options.sessionName === undefined ? {} : { sessionName: options.sessionName }),
        ...(options.branchName === undefined ? {} : { initialBranchName: options.branchName }),
      },
    }]);
    return { sessionId, branchId };
  }

  async nameSession(sessionId: string, branchId: string, name: string): Promise<void> {
    if (!name.trim()) throw new ValidationError("Session display name is required");
    const branches = (await this.storage.listBranches()).filter(route => route.sessionId === sessionId);
    if (!branches.some(route => route.branchId === branchId)) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const operationId = newId();
    await this.storage.appendEvents(branches.map(route => ({
      sessionId, branchId: route.branchId, type: "SessionNamed" as const, producer: "client",
      idempotencyKey: `session-name:${operationId}:${route.branchId}`, payload: { name: name.trim() },
    })));
  }

  async nameBranch(sessionId: string, branchId: string, name: string): Promise<void> {
    if (!name.trim()) throw new ValidationError("Branch display name is required");
    await this.storage.appendEvents([{
      sessionId, branchId, type: "BranchNamed", producer: "client",
      idempotencyKey: `branch-name:${newId()}`, payload: { name: name.trim() },
    }]);
  }

  async appendMessage(
    sessionId: string,
    branchId: string,
    role: "system" | "user" | "assistant" | "tool",
    content: string,
  ): Promise<AgentEvent<"MessageAppended">> {
    if (containsBrokeredSecret(content)) {
      throw new ValidationError("Brokered credentials cannot enter messages");
    }
    const [event] = await this.storage.appendEvents([{
      sessionId,
      branchId,
      type: "MessageAppended",
      producer: "client",
      idempotencyKey: `message:${newId()}`,
      payload: { messageId: newId(), role, content },
    }]);
    if (!event) throw new Error("Message not committed");
    return event as AgentEvent<"MessageAppended">;
  }

  /** Rebuilds and reattaches to a durable branch without changing execution ownership. */
  async resume(sessionId:string,branchId:string):Promise<{sessionId:string;branchId:string;cursor:string}>{const events=await this.storage.loadEvents(sessionId,{branchId});if(!events.length)throw new NotFoundError("session branch",`${sessionId}/${branchId}`);const state=await this.projections.rebuild(sessionId,branchId);return{sessionId,branchId,cursor:state.cursor};}

  /** Creates an immutable source-linked derived view; canonical history is retained. */
  compact(sessionId: string, branchId: string, input: CompactContextInput = {}): Promise<ContextCompactionView> {
    return this.compactions.compact(sessionId, branchId, input);
  }

  inspectContext(sessionId: string, branchId: string): Promise<ContextInspection> {
    return this.compactions.inspect(sessionId, branchId);
  }

  async fork(sessionId: string, parentBranchId: string, forkCursor: string, name?: string, compactionStrategy?: "deterministic-extractive-v1" | "model-summary-v1"): Promise<string> {
    const completeHistory = await this.storage.loadEvents(sessionId, { branchId: parentBranchId });
    if (!completeHistory.length) throw new NotFoundError("session branch", `${sessionId}/${parentBranchId}`);
    if (!completeHistory.some((event) => event.cursor === forkCursor)) {
      throw new ValidationError("Fork cursor is not in the parent branch history");
    }
    const branchId = newId();
    await this.storage.appendEvents([{
      sessionId,
      branchId,
      type: "BranchCreated",
      producer: "client",
      idempotencyKey: `branch:${branchId}`,
      payload: { branchId, parentBranchId, forkCursor, ...(name === undefined ? {} : { name }) },
    }]);
    if (compactionStrategy) {
      const inherited = await this.compactions.inspect(sessionId, branchId);
      if (inherited.effective?.contextId) await this.compactions.compact(sessionId, branchId, {
        strategy: compactionStrategy, reason: "rematerialize", requestedBy: "user",
        idempotencyKey: `branch-compaction-strategy:${branchId}:${compactionStrategy}`,
        rematerializeFromContextId: inherited.effective.contextId,
      });
    }
    return branchId;
  }

  async executeCell(
    sessionId: string,
    branchId: string,
    code: string,
    dependencies: string[] = [],
    stableCellId?: string,
  ): Promise<{ cellId: string; result: JsonValue; logs: string[] }> {
    const session = await this.storage.getSession?.(sessionId);
    if (session?.executionOwnerDeviceId && session.executionOwnerDeviceId !== this.device.deviceId) throw new CapabilityUnavailableError(`execution of session owned by device ${session.executionOwnerDeviceId}`, `device ${this.device.deviceId} (automatic ownership failover is unavailable)`);
    return this.#cells.run(`${sessionId}/${branchId}`, () => this.#executeCell(sessionId, branchId, code, dependencies, stableCellId));
  }

  async #executeCell(
    sessionId: string,
    branchId: string,
    code: string,
    dependencies: string[],
    stableCellId?: string,
  ): Promise<{ cellId: string; result: JsonValue; logs: string[] }> {
    if (containsBrokeredSecret(code)) {
      throw new ValidationError("Brokered credentials cannot enter console cell source");
    }
    const history = await this.storage.loadEvents(sessionId, { branchId });
    if (!history.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const state = projectEvents(history);
    const cellId = stableCellId ?? newId();
    const existing = state.cells[cellId];
    if (existing) {
      const proposed = history.find((event) => event.type === "CellProposed" && (event.payload as { cellId: string }).cellId === cellId);
      const payload = proposed?.payload as { code?: string; dependencies?: string[] } | undefined;
      if (payload?.code !== code || !Bun.deepEquals(payload.dependencies ?? [], dependencies)) throw new ValidationError("Stable cell identity was reused with different source or dependencies");
      if (existing.status === "committed") return { cellId, result: existing.result!, logs: [...existing.logs] };
      throw new ValidationError(`Stable cell ${cellId} is ${existing.status}; started cells are never blindly replayed`);
    }
    const started = performance.now();
    await this.storage.appendEvents([{
      sessionId,
      branchId,
      type: "CellProposed",
      producer: "console",
      idempotencyKey: `cell-proposed:${cellId}`,
      payload: { cellId, code, dependencies },
    }, {
      sessionId,
      branchId,
      type: "CellStarted",
      producer: "console",
      idempotencyKey: `cell-started:${cellId}:1`,
      payload: { cellId, attempt: 1 },
    }]);

    const stagedValues = new Map<string, WorkingValue>();
    const stagedArtifacts = new Map<string, ArtifactReference>();
    const restored = Object.fromEntries(
      Object.entries(state.workingValues).map(([name, value]) => [name, value.value]),
    );
    const rpcOrdinals = new Map<string, number>();
    const nextRpcKey = (method: string): string => {
      const ordinal = (rpcOrdinals.get(method) ?? 0) + 1;
      rpcOrdinals.set(method, ordinal);
      return `cell:${cellId}:${method}:${ordinal}`;
    };
    const handler = async (method: string, args: unknown[]): Promise<unknown> => {
      if (method === "state.get") {
        const name = String(args[0]);
        return stagedValues.get(name) ?? state.workingValues[name]?.value ?? null;
      }
      if (method === "state.list") {
        const eventById = new Map(history.map((event) => [event.id, event]));
        const names = new Set([...Object.keys(state.workingValues), ...stagedValues.keys()]);
        return [...names].sort().map((name) => {
          const staged = stagedValues.get(name);
          if (staged) return {
            name,
            version: (state.workingValues[name]?.version ?? 0) + 1,
            value: staged,
            status: "staged",
            provenance: null,
          };
          const committed = state.workingValues[name]!;
          const source = eventById.get(committed.eventId);
          return {
            name,
            version: committed.version,
            value: committed.value,
            status: "committed",
            provenance: source ? provenance(source) : null,
          };
        });
      }
      if (method === "cells.list") {
        const options = cellListOptions(args[0] ?? {});
        const available = cellHistory(await this.storage.loadEvents(sessionId, { branchId }))
          .filter(({ entry, cursor }) => options.statuses.has(entry.status) &&
            (options.beforeCursor === null || cursor < options.beforeCursor));
        const selected = available.slice(0, options.limit);
        return {
          items: selected.map(({ entry }) => entry),
          nextCursor: available.length > selected.length ? selected.at(-1)?.cursor ?? null : null,
        };
      }
      if (method === "cells.get") {
        if (typeof args[0] !== "string" || !args[0]) throw new ValidationError("Cell id must be a non-empty string");
        return cellHistory(await this.storage.loadEvents(sessionId, { branchId }))
          .find(({ entry }) => entry.cellId === args[0])?.entry ?? null;
      }
      if (method === "state.set") {
        const name = String(args[0]);
        const value = args[1];
        if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(name)) throw new ValidationError("Invalid working value name");
        assertJsonValue(value);
        if (containsBrokeredSecret(value)) throw new ValidationError("Brokered credentials cannot enter working memory");
        let working: WorkingValue;
        if (jsonBytes(value) <= MAX_WORKING_JSON_BYTES) {
          working = { kind: "json", value: scrubJson(value) };
        } else {
          const reference = await this.artifacts.put(JSON.stringify(scrubJson(value)), { mediaType: "application/json" });
          stagedArtifacts.set(reference.artifactId, reference);
          working = { kind: "artifact", artifactId: reference.artifactId };
        }
        stagedValues.set(name, working);
        return working;
      }
      if (method === "artifacts.put") {
        if (typeof args[0] !== "string") throw new ValidationError("Artifact content must be a string");
        if (containsBrokeredSecret(args[0])) throw new ValidationError("Brokered credentials cannot enter artifacts");
        const reference = await this.artifacts.put(scrubText(args[0]), {
          mediaType: typeof args[1] === "string" ? args[1] : "text/plain",
        });
        stagedArtifacts.set(reference.artifactId, reference);
        return reference;
      }
      if (method === "artifacts.get") {
        const artifactId = String(args[0]);
        const reference = stagedArtifacts.get(artifactId) ?? state.artifacts[artifactId];
        if (!reference) throw new ValidationError(`Artifact not found: ${artifactId}`);
        return new TextDecoder().decode(await this.artifacts.resolve(reference));
      }
      if (method === "sql") {
        const sql = String(args[0]);
        const values = Array.isArray(args[1]) ? args[1] : [];
        const sqlArgs = values.map((value) => {
          if (value === null || typeof value === "string" || typeof value === "number" ||
              typeof value === "bigint" || value instanceof Uint8Array) return value;
          if (typeof value === "boolean") return value ? 1 : 0;
          throw new ValidationError("Unsupported SQL interpolation value");
        });
        return this.storage.readonlyQuery({ sql, args: sqlArgs });
      }
      if (method === "context.inspect") return this.inspectContext(sessionId, branchId);
      if (method === "context.compact") return this.compact(sessionId, branchId, { ...((args[0] ?? {}) as CompactContextInput), reason: "agent-request", requestedBy: "agent" });
      if (method === "goals.current") return this.goals.current(sessionId, branchId);
      if (method === "goals.list") return this.goals.list(sessionId, branchId);
      if (method === "goals.get") return this.goals.get(sessionId, branchId, String(args[0] ?? ""));
      if (method === "goals.evaluations") {
        const goal = await this.goals.get(sessionId, branchId, String(args[0] ?? ""));
        const gateId = typeof args[1] === "string" ? args[1] : undefined;
        if (gateId && !goal.gates.some((gate) => gate.gateId === gateId)) throw new ValidationError("Goal gate is outside the calling session branch scope");
        return this.storage.listGoalGateEvaluations!(goal.goalId, gateId);
      }
      if (method === "heartbeats.create") return this.heartbeats.createAgent(sessionId, branchId, args[0] as any);
      if (method === "heartbeats.list") return (await this.heartbeats.list(sessionId, branchId)).filter((heartbeat) => heartbeat.owner === "agent");
      if (method === "heartbeats.pause") return this.heartbeats.pauseAgent(sessionId, branchId, String(args[0] ?? ""), typeof args[1] === "string" ? args[1] : undefined);
      if (method === "heartbeats.resume") return this.heartbeats.resumeAgent(sessionId, branchId, String(args[0] ?? ""), typeof args[1] === "string" ? args[1] : undefined);
      if (method === "heartbeats.clear") return this.heartbeats.cancelAgent(sessionId, branchId, String(args[0] ?? ""), typeof args[1] === "string" ? args[1] : undefined);
      if (method === "schedules.create") return this.schedules.createAgent(sessionId, branchId, args[0] as any);
      if (method === "schedules.list") return (await this.schedules.list(sessionId, branchId)).filter((schedule) => schedule.owner === "agent");
      if (method === "schedules.wakes") {
        const statuses = Array.isArray(args[0]) ? args[0] as any : undefined;
        const owned = new Set((await this.schedules.list(sessionId, branchId)).filter((schedule) => schedule.owner === "agent").map((schedule) => schedule.scheduleId));
        return (await this.schedules.wakes(sessionId, branchId, statuses)).filter((wake) => wake.sourceType === "schedule" ? owned.has(wake.sourceId) : false);
      }
      if (method === "schedules.pause") return this.schedules.pauseAgent(sessionId, branchId, String(args[0] ?? ""), typeof args[1] === "string" ? args[1] : undefined);
      if (method === "schedules.resume") return this.schedules.resumeAgent(sessionId, branchId, String(args[0] ?? ""), typeof args[1] === "string" ? args[1] : undefined);
      if (method === "schedules.clear") return this.schedules.clearAgent(sessionId, branchId, String(args[0] ?? ""), typeof args[1] === "string" ? args[1] : undefined);
      if (method === "memory.search") return this.memory.search(sessionId,branchId,String(args[0] ?? ""),(args[1] ?? {}) as any);
      if (method === "memory.create") return this.memory.create(sessionId,branchId,args[0] as any,"agent");
      if (method === "memory.list") return this.memory.list(sessionId,branchId,(args[0] ?? {}) as any);
      if (method === "harness.review") return this.refiner.request(sessionId,branchId,{ ...(typeof args[0] === "string" ? { instructions: args[0] } : {}) });
      if (method === "harness.reviews") return this.refiner.list({ sessionId, branchId, ...((args[0] ?? {}) as any) });
      if (method === "harness.propose") return this.harness.propose(sessionId,branchId,{...(args[0] as any),authority:"agent"});
      if (method === "harness.list") return this.harness.modelList(sessionId,branchId,(args[0] ?? {}) as any);
      if (method === "harness.history") return this.harness.modelHistory(sessionId,branchId,String(args[0]));
      if (method === "skills.list") return this.skillManagement.list(sessionId,branchId,(args[0] ?? {}) as any);
      if (method === "skills.get") return this.skillManagement.get(sessionId,branchId,String(args[0] ?? ""));
      if (method === "skills.propose") return this.skillManagement.propose(sessionId,branchId,String(args[0] ?? ""),(args[1] === "local" ? "local" : "workspace"));
      if (method === "skills.invoke") {
        const options = (args[2] ?? {}) as Record<string, unknown>;
        return this.skills.invoke(sessionId,branchId,String(args[0]),args[1] as JsonValue,{ ...options, idempotencyKey: typeof options.idempotencyKey === "string" ? options.idempotencyKey : nextRpcKey(method) } as any);
      }
      if (method === "skills.test") return this.skillManagement.test(sessionId,branchId,String(args[0]));
      if (method === "agents.spawn") {
        const raw = args[0]; const input = typeof raw === "string" ? { task: raw } : raw as Record<string, unknown>;
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("agents.spawn requires a task string or object");
        const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey : nextRpcKey(method);
        if (input.run !== false) return this.agents.spawnRunnable(sessionId, branchId, { ...input, idempotencyKey } as any);
        return this.agents.spawn(sessionId, branchId, { ...input, idempotencyKey } as any);
      }
      if (method === "agents.list") return this.agents.listFamily(sessionId, branchId);
      if (method === "agents.send") {
        const raw = args[0];
        const input = typeof raw === "string" ? { target: raw, content: args[1] } : raw as Record<string, unknown>;
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("agents.send requires a target/content object");
        return this.agents.sendMessage(sessionId, branchId, { ...input, intentKey: typeof input.intentKey === "string" ? input.intentKey : nextRpcKey(method) } as any);
      }
      if (method === "agents.messages") return this.agents.messages(sessionId, branchId, (args[0] ?? {}) as any);
      if (method === "agents.acknowledge") {
        if (typeof args[0] !== "string" || !args[0]) throw new ValidationError("agents.acknowledge requires a message ID");
        return this.agents.acknowledgeMessage(sessionId, branchId, args[0]);
      }
      if (method === "agents.cancel") {
        if (typeof args[0] !== "string" || !args[0]) throw new ValidationError("agents.cancel requires a direct-child target");
        if (args[1] !== undefined && typeof args[1] !== "string") throw new ValidationError("agents.cancel reason must be a string");
        return this.agents.cancelFamilyTarget(sessionId, branchId, args[0], args[1] as string | undefined);
      }
      if (method === "agents.followUp") {
        if (typeof args[0] !== "string" || !args[0] || typeof args[1] !== "string") throw new ValidationError("agents.followUp requires target and content strings");
        const options = args[2] && typeof args[2] === "object" && !Array.isArray(args[2]) ? args[2] as Record<string, unknown> : {};
        return this.agents.followUp(sessionId, branchId, args[0], args[1], { ...options, intentKey: typeof options.intentKey === "string" ? options.intentKey : nextRpcKey(method) } as any);
      }
      if (method === "specs.spawn") {
        const input = (args[1] ?? {}) as Record<string, unknown>;
        return this.specs.spawn(sessionId,branchId,String(args[0]),{ ...input, idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : nextRpcKey(method) } as any);
      }
      if (method === "rlm.start") {
        const raw = args[0]; const input = typeof raw === "string" ? { prompt: raw } : raw as Record<string, unknown>;
        return this.models.start(sessionId, branchId, { ...input, idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : nextRpcKey(method) } as any);
      }
      if (method === "rlm.startMany") {
        if (!Array.isArray(args[0])) throw new ValidationError("rlm.startMany requires an input array");
        return this.models.startMany(sessionId, branchId, args[0].map((raw, index) => {
          const input = typeof raw === "string" ? { prompt: raw } : raw as Record<string, unknown>;
          return { ...input, idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : `${nextRpcKey(method)}:${index + 1}` };
        }) as any[]);
      }
      if (method === "rlm.get" || method === "rlm.result" || method === "rlm.cancel") {
        if (typeof args[0] !== "string" || !args[0]) throw new ValidationError("Recursive model handleId must be a non-empty string");
        const handle = await this.models.get(args[0]);
        if (handle.parentSessionId !== sessionId || handle.parentBranchId !== branchId) {
          throw new ValidationError("Recursive model handle is outside the calling session branch scope");
        }
        if (method === "rlm.get") return handle;
        if (method === "rlm.cancel") {
          if (args[1] !== undefined && typeof args[1] !== "string") throw new ValidationError("Recursive model cancellation reason must be a string");
          return this.models.cancel(handle.handleId, args[1] as string | undefined);
        }
        const options = args[1] === undefined ? {} : args[1];
        if (!options || typeof options !== "object" || Array.isArray(options)) throw new ValidationError("Recursive model result options must be an object");
        return this.models.result(handle.handleId, options as any);
      }
      if (method === "tools.request") {
        const [executor, operation, input, rawOptions] = args;
        if (typeof executor !== "string" || typeof operation !== "string") throw new ValidationError("Invalid tool request");
        assertJsonValue(input);
        const options = rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions)
          ? rawOptions as Record<string, unknown>
          : {};
        const idempotencyKey = typeof options.idempotencyKey === "string"
          ? options.idempotencyKey
          : nextRpcKey(`tools.${executor}.${operation}`);
        const idempotent = typeof options.idempotent === "boolean"
          ? options.idempotent
          : executor === "file" && operation !== "replace";
        const effectId = await this.outbox.request({
          sessionId,
          branchId,
          executor,
          operation,
          input,
          idempotencyKey,
          idempotent,
        });
        return this.outbox.run(effectId);
      }
      throw new ValidationError(`Unknown console RPC method: ${method}`);
    };

    try {
      const execution = await this.console.execute(code, { id: sessionId, branchId }, restored, handler);
      const rawPreview = JSON.parse(JSON.stringify(execution.observation.preview)) as unknown;
      assertJsonValue(rawPreview);
      const preview = scrubJson(rawPreview);
      let result: JsonValue;
      if (execution.observation.kind === "json") {
        const parsed = JSON.parse(execution.observation.json) as unknown;
        assertJsonValue(parsed);
        const scrubbed = scrubJson(parsed);
        const serialized = JSON.stringify(scrubbed);
        const byteLength = new TextEncoder().encode(serialized).byteLength;
        if (byteLength > MAX_CELL_OBSERVATION_JSON_BYTES) {
          const reference = await this.artifacts.put(serialized, { mediaType: "application/json" });
          stagedArtifacts.set(reference.artifactId, reference);
          result = {
            kind: "oversized-json",
            artifact: {
              artifactId: reference.artifactId,
              digest: reference.digest,
              mediaType: reference.mediaType,
              size: reference.size,
            },
            byteLength,
            preview,
          };
        } else {
          result = scrubbed;
        }
      } else {
        result = {
          kind: "unsupported",
          reason: scrubText(execution.observation.reason),
          preview,
        };
      }
      assertJsonValue(result);
      const logs = execution.logs.map(scrubText);
      const events: any[] = [];
      for (const reference of stagedArtifacts.values()) {
        events.push({
          sessionId,
          branchId,
          type: "ArtifactRegistered",
          producer: "console",
          idempotencyKey: `cell-artifact:${cellId}:${reference.artifactId}`,
          payload: reference,
        });
      }
      for (const [name, value] of stagedValues) {
        events.push({
          sessionId,
          branchId,
          type: "WorkingValueSet",
          producer: "console",
          idempotencyKey: `cell-value:${cellId}:${name}`,
          payload: { name, version: (state.workingValues[name]?.version ?? 0) + 1, value },
        });
      }
      events.push({
        sessionId,
        branchId,
        type: "CellCommitted",
        producer: "console",
        idempotencyKey: `cell-committed:${cellId}`,
        payload: {
          cellId,
          result,
          logs,
          durationMs: Math.round(performance.now() - started),
          exports: [...stagedValues.keys()],
        },
      });
      await this.storage.appendEvents(events);
      return { cellId, result, logs };
    } catch (error) {
      const logs = error instanceof ConsoleCellError ? error.logs.map(scrubText) : [];
      await this.storage.appendEvents([{
        sessionId,
        branchId,
        type: "CellFailed",
        producer: "console",
        idempotencyKey: `cell-failed:${cellId}`,
        payload: {
          cellId,
          error: scrubText(error instanceof Error ? error.message : String(error)),
          logs,
          durationMs: Math.round(performance.now() - started),
        },
      }]);
      throw error;
    } finally {
      if (this.restartConsoleAfterCell) await this.console.stop();
    }
  }
}

function adjacentFileUrl(databaseUrl: string, suffix: string): string {
  if (!databaseUrl.startsWith("file:")) throw new ValidationError("Profile and local sync-replica defaults require a file: workspace database URL");
  return `${databaseUrl}${suffix}`;
}

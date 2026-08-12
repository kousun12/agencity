import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalArtifactStore } from "../artifacts/index.ts";
import {
  ConsoleCellError,
  ConsoleExecutionPool,
  ConsoleProcess,
  DEFAULT_MAX_CONSOLE_ACTIVE_EXECUTIONS,
  DEFAULT_MAX_CONSOLE_RESIDENT_PROCESSES,
  MAX_CELL_OBSERVATION_JSON_BYTES,
  SCRATCH_LIMITS,
  filterScratchCheckpoint,
  type ScratchCheckpointCandidate,
  type ScratchCheckpointHooks,
  type ScratchCheckpointLoadResult,
  type ScratchScope,
  type CellHistoryEntry,
  type CellHistoryStatus,
  type CellListOptions,
  type EventProvenance,
} from "../console/index.ts";
import { StreamingJsonStager } from "../console/json-staging.ts";
import {
  CapabilityUnavailableError,
  BOUNDED_OUTPUT_PROTOCOL,
  REPOSITORY_INSTRUCTION_LIMITS,
  REPOSITORY_INSTRUCTIONS_PROTOCOL,
  SEALED_ROOT_AGENT_PROFILE,
  assertNoReservedModelDispatchInputFields,
  assertJsonValue,
  assertBoundedOutputV1,
  jsonBytes,
  MAX_WORKING_JSON_BYTES,
  newId,
  NotFoundError,
  normalizeReasoningEffort,
  projectEvents,
  ValidationError,
  type AgentEvent,
  type AgentProfileInput,
  type ArtifactReference,
  type BudgetLimits,
  type JsonValue,
  type ModelConfiguration,
  type ModelConfigurationInput,
  type RepositoryInstructionDiscovery,
  type RepositoryInstructionOmission,
  type WorkingValue,
} from "../domain/index.ts";
import {
  EchoModelProvider,
  FileExecutor,
  ModelExecutor,
  ShellExecutor,
  SkillExecutor,
  createAnthropicModelProvider,
  createOpenAIModelProvider,
  createVercelModelProvider,
  type ModelProvider,
  type ProviderConcurrency,
} from "../executors/index.ts";
import { LibSqlStorage, ProfileStore, TursoSyncTransport, type AgentStorage } from "../storage/index.ts";
import { LibSqlScratchStore } from "../storage/libsql.ts";
import type { ScratchStore } from "../storage/scratch.ts";
import { SyncService, type DeleteOwnedDataInput, type DeviceIdentity, type ManagedReplicaDeletionAdmin, type PhysicalDeletionReceipt, type SyncTransport } from "../sync/index.ts";
import { ContextMaterializer } from "./context.ts";
import { ModelLoop } from "./model-loop.ts";
import { OutboxRunner } from "./outbox.ts";
import { ProjectionService } from "./projection.ts";
import {
  ModelCredentialStore,
  containsBrokeredSecret,
  containsCredentialMaterial,
  modelCredentialPathForProfile,
  scrubJson,
  scrubText,
  type SupportedModelProviderName,
} from "../security/index.ts";
import { AgentService } from "./agents.ts";
import { AgentProfileService } from "./agent-profiles.ts";
import { DocumentService } from "./documents.ts";
import { GoalService } from "./goals.ts";
import { HeartbeatService } from "./heartbeats.ts";
import { ScheduleService } from "./schedules.ts";
import {
  RecursiveModelService,
  type PublicRecursiveModelService,
} from "./models.ts";
import {
  internalRefinementGovernanceStarter,
  internalRefinementReviewStarter,
  internalStructuredModelTurn,
} from "./internal.ts";
import { MemoryService } from "./memory.ts";
import { HarnessService } from "./harness.ts";
import { SkillService } from "./skills.ts";
import { SubagentSpecService } from "./specs.ts";
import { AgentRunService } from "./agent-runs.ts";
import { ManagedExecutionLeaseCoordinator, createFencedAgentStorage } from "./execution-leases.ts";
import { EffectReconciliationService } from "./effect-reconciliation.ts";
import { RefinerService } from "./refiner.ts";
import { RefinementGovernanceService } from "./refinement-governance.ts";
import { SkillManagementService } from "./skill-management.ts";
import { CompactionService, type CompactContextInput, type ContextCompactionView, type ContextInspection } from "./context-compaction.ts";
import { ModelCatalog, type ModelCatalogOptions } from "./model-catalog.ts";
import { ModelEffectAdmissionService } from "./model-effect-admission.ts";
import { ModelSelectionService } from "./model-selection.ts";
import { RepositoryInstructionService } from "./repository-instructions.ts";
import { AiGenerationService } from "./ai-generation.ts";
import { ExplicitContextMaterializer } from "./explicit-context.ts";

export interface SupervisorOptions {
  readonly databaseUrl: string;
  readonly artifactDirectory: string;
  /** Defaults to shared/fail-closed; assert exclusive only for a workspace-owned CAS root. */
  readonly artifactDirectoryOwnership?: "exclusive" | "shared";
  readonly workspaceRoot?: string;
  readonly restartConsoleAfterCell?: boolean;
  /** Optional noncanonical cold-cache adapter; Phase B defaults to warm-only scratch. */
  readonly scratchCheckpointHooks?: ScratchCheckpointHooks;
  readonly scratchCheckpointTimeoutMs?: number;
  readonly scratchIdleScopeMs?: number;
  readonly scratchMaxWarmScopes?: number;
  /** Product composition opt-in for the private file-local scratch cache. */
  readonly enableLocalScratchCheckpoints?: boolean;
  readonly consoleRssRecycleThresholdBytes?: number;
  /** Global bound for exact-branch resident Bun console workers (default 17). */
  readonly maxConsoleResidentProcesses?: number;
  /** Global bound for generated JavaScript that is actively running (default 4). */
  readonly maxConsoleActiveExecutions?: number;
  /** Awaited nested-agent depth; defaults to and cannot exceed maxSessionDepth. */
  readonly maxAwaitedAgentDepth?: number;
  readonly modelProviders?: readonly ModelProvider[];
  /** Model-catalog transport controls; fetch injection is intended for deterministic conformance tests. */
  readonly modelCatalog?: ModelCatalogOptions;
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
  /** Separate owner-only API-key file; defaults beside the profile database. */
  readonly modelCredentialPath?: string;
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
  readonly model?: ModelConfigurationInput;
  readonly budget?: BudgetLimits;
  readonly sessionId?: string;
  readonly branchId?: string;
  readonly sessionName?: string;
  readonly branchName?: string;
  readonly agentProfile?: AgentProfileInput;
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
  readonly credentials: ModelCredentialStore;
  readonly device: DeviceIdentity;
  readonly sync: SyncService;
  readonly artifacts: LocalArtifactStore;
  readonly console: ConsoleExecutionPool;
  readonly outbox: OutboxRunner;
  readonly projections: ProjectionService;
  readonly contexts: ContextMaterializer;
  readonly compactions: CompactionService;
  readonly modelLoop: ModelLoop;
  readonly agents: AgentService;
  readonly agentProfiles: AgentProfileService;
  readonly documents: DocumentService;
  readonly models: PublicRecursiveModelService;
  readonly #recursiveModels: RecursiveModelService;
  readonly ai: AiGenerationService;
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
  readonly refinementGovernance: RefinementGovernanceService;
  /** Process-local executor/provider catalog; descriptors contain no credential material. */
  readonly modelExecutor: ModelExecutor;
  readonly modelEffectAdmission: ModelEffectAdmissionService;
  readonly modelSelection: ModelSelectionService;
  readonly modelCatalog: ModelCatalog;
  readonly repositoryInstructions: RepositoryInstructionService;
  readonly restartConsoleAfterCell: boolean;
  readonly scratchCheckpointHooks: ScratchCheckpointHooks | null;
  readonly #scratchStore: ScratchStore | null;
  readonly consoleRssRecycleThresholdBytes: number;
  readonly executionLeases: ManagedExecutionLeaseCoordinator | null;
  readonly #cells = new BranchQueue();
  readonly #sessionCreations = new BranchQueue();
  readonly maxAwaitedAgentDepth: number;
  #closed = false;

  private constructor(
    storage: AgentStorage,
    profile: ProfileStore,
    credentials: ModelCredentialStore,
    device: DeviceIdentity,
    sync: SyncService,
    artifacts: LocalArtifactStore,
    consoleProcess: ConsoleExecutionPool,
    outbox: OutboxRunner,
    restartConsoleAfterCell: boolean,
    scratchCheckpointHooks: ScratchCheckpointHooks | null,
    scratchStore: ScratchStore | null,
    consoleRssRecycleThresholdBytes: number,
    maxSessionDepth: number,
    maxAwaitedAgentDepth: number,
    maxChildrenPerSession: number,
    userScopeKey: string,
    skillPermissionAllowlist: readonly string[],
    modelExecutor: ModelExecutor,
    modelCatalog: ModelCatalog,
    workspaceRoot: string,
    executionLeases: ManagedExecutionLeaseCoordinator | null,
  ) {
    this.storage = storage;
    this.profile = profile;
    this.credentials = credentials;
    this.device = device;
    this.sync = sync;
    this.artifacts = artifacts;
    this.console = consoleProcess;
    this.outbox = outbox;
    this.projections = new ProjectionService(storage);
    this.modelSelection = new ModelSelectionService(modelExecutor, profile);
    this.agents = new AgentService(
      storage,
      outbox,
      maxSessionDepth,
      maxChildrenPerSession,
      (model) => modelExecutor.normalizeConfiguration(model),
      (model) => modelExecutor.normalizeConfigurationIdentity(model),
      (model) => modelExecutor.assertRequiredToolSetAdmission(
        modelExecutor.resolveExecutionDescriptor(model),
      ),
      (caller, selection, mode) =>
        mode === "identity"
          ? Promise.resolve(
              this.modelSelection.normalizeIdentity(caller, selection),
            )
          : this.modelSelection.admit(caller, selection),
    );
    this.agentProfiles = this.agents.profiles;
    this.skills = new SkillService(storage, outbox, skillPermissionAllowlist, userScopeKey);
    this.harness = new HarnessService(storage, this.skills, userScopeKey);
    this.memory = new MemoryService(storage, undefined, userScopeKey);
    this.specs = new SubagentSpecService(storage, this.agents, userScopeKey);
    this.modelExecutor = modelExecutor;
    this.modelEffectAdmission = new ModelEffectAdmissionService(modelExecutor);
    this.modelCatalog = modelCatalog;
    this.repositoryInstructions = new RepositoryInstructionService(workspaceRoot);
    this.executionLeases = executionLeases;
    this.contexts = new ContextMaterializer(
      storage,
      this.memory,
      this.harness,
      30,
      userScopeKey,
      profile,
      this.repositoryInstructions,
    );
    this.compactions = new CompactionService(storage, outbox, modelExecutor);
    this.modelLoop = new ModelLoop(storage, this.contexts, outbox, this.compactions, modelExecutor, this.agentProfiles);
    this.documents = new DocumentService(storage);
    this.goals = new GoalService(storage, outbox);
    this.heartbeats = new HeartbeatService(storage);
    this.schedules = new ScheduleService(storage);
    this.#recursiveModels = new RecursiveModelService(
      storage,
      this.agents,
      this.modelLoop,
      internalStructuredModelTurn(this.modelLoop),
      this.modelEffectAdmission,
      outbox,
      artifacts,
      this.memory,
    );
    this.models = this.#recursiveModels;
    this.ai = new AiGenerationService(
      storage,
      outbox,
      modelExecutor,
      this.modelEffectAdmission,
      this.modelSelection,
      new ExplicitContextMaterializer(storage, artifacts, this.memory),
    );
    this.restartConsoleAfterCell = restartConsoleAfterCell;
    this.scratchCheckpointHooks = scratchCheckpointHooks;
    this.#scratchStore = scratchStore;
    this.consoleRssRecycleThresholdBytes = consoleRssRecycleThresholdBytes;
    this.maxAwaitedAgentDepth = maxAwaitedAgentDepth;
    this.runs = new AgentRunService(storage, this.contexts, outbox, this.goals, this.executeCell.bind(this), acceptanceAgentRunMaxSteps(), this.compactions, modelExecutor, this.agentProfiles);
    this.effectReconciliation = new EffectReconciliationService(storage);
    this.refiner = new RefinerService(
      storage,
      this.#recursiveModels,
      internalRefinementReviewStarter(this.#recursiveModels),
      this.harness,
      profile,
      userScopeKey,
    );
    this.refinementGovernance = new RefinementGovernanceService(
      storage,
      this.#recursiveModels,
      internalRefinementGovernanceStarter(this.#recursiveModels),
      this.agentProfiles,
      this.harness,
      this.modelEffectAdmission,
      device.profileId,
    );
    this.refiner.attachGovernance(this.refinementGovernance);
    this.skillManagement = new SkillManagementService(storage, profile, this.harness, this.skills, this.refiner, userScopeKey, device.profileId);
    this.skills.attachCatalog(this.skillManagement);
    this.contexts.attachSkillCatalog(this.skillManagement);
    this.schedules.attachRunService(this.runs);
    this.agents.attachRunService(this.runs);
    this.runs.setCancellationObserver((sessionId, branchId) =>
      this.console.recycleScope(
        { sessionId, branchId },
        "branch-cancelled",
      )
    );
    this.runs.setBoundaryObserver(async (sessionId, branchId, runId) => { await this.agents.deliverQueuedAtBoundary(sessionId, branchId, runId); await this.refiner.scanBoundary(sessionId, branchId, runId); });
  }

  static async open(options: SupervisorOptions): Promise<Supervisor> {
    if (options.enableLocalScratchCheckpoints && options.scratchCheckpointHooks) {
      throw new ValidationError(
        "Local scratch checkpoints cannot be combined with custom checkpoint hooks",
      );
    }
    if (options.enableLocalScratchCheckpoints &&
        (!options.executionLease || !isExactFileDatabaseUrl(options.databaseUrl))) {
      throw new ValidationError(
        "Local scratch checkpoints require managed execution fencing and an exact file: workspace database URL",
      );
    }
    if (options.consoleRssRecycleThresholdBytes !== undefined &&
        (!Number.isSafeInteger(options.consoleRssRecycleThresholdBytes) ||
         options.consoleRssRecycleThresholdBytes < 1)) {
      throw new ValidationError("Console RSS recycle threshold must be a positive integer");
    }
    const maxSessionDepth = options.maxSessionDepth ?? 8;
    const maxAwaitedAgentDepth = options.maxAwaitedAgentDepth ?? maxSessionDepth;
    for (const [value, label] of [
      [options.maxConsoleResidentProcesses ??
        DEFAULT_MAX_CONSOLE_RESIDENT_PROCESSES, "resident-process limit"],
      [options.maxConsoleActiveExecutions ??
        DEFAULT_MAX_CONSOLE_ACTIVE_EXECUTIONS, "active-execution limit"],
      [maxSessionDepth, "session depth"],
      [maxAwaitedAgentDepth, "awaited-agent depth"],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new ValidationError(`Console ${label} must be a positive integer`);
      }
    }
    if (maxAwaitedAgentDepth > maxSessionDepth) {
      throw new ValidationError(
        "Awaited-agent depth cannot exceed the durable session depth",
      );
    }
    const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    const profileDatabaseUrl=options.profileDatabaseUrl??adjacentFileUrl(options.databaseUrl,".profile.db");
    if(options.databaseUrl.startsWith("file:"))await mkdir(dirname(fileURLToPath(new URL(options.databaseUrl))),{recursive:true});
    if(profileDatabaseUrl.startsWith("file:"))await mkdir(dirname(fileURLToPath(new URL(profileDatabaseUrl))),{recursive:true});
    const profile = await ProfileStore.open(profileDatabaseUrl);
    const modelCatalog = new ModelCatalog(profile, {
      ...(process.env.AI_GATEWAY_BASE_URL === undefined ? {} : { gatewayOrigin: process.env.AI_GATEWAY_BASE_URL }),
      ...options.modelCatalog,
    });
    await modelCatalog.hydrate();
    let credentials: ModelCredentialStore;
    try {
      if (!options.modelCredentialPath && !profileDatabaseUrl.startsWith("file:")) {
        throw new ValidationError("A model credential path is required when the profile database is not file-backed");
      }
      const credentialPath = options.modelCredentialPath ??
        modelCredentialPathForProfile(fileURLToPath(new URL(profileDatabaseUrl)));
      credentials = await ModelCredentialStore.open(credentialPath);
    } catch (error) {
      profile.close();
      throw error;
    }
    let device: DeviceIdentity;
    try {
      device = await profile.getOrCreateDeviceIdentity(options.deviceName);
    } catch (error) {
      credentials.close();
      profile.close();
      throw error;
    }
    const openingWorkspaceId=options.sync?.workspaceId??"default";const catalog=await profile.getWorkspace(openingWorkspaceId);
    if(catalog?.deletedAt){credentials.close();profile.close();throw new ValidationError("Configured workspace is tombstoned and cannot be silently reclaimed",{workspaceId:openingWorkspaceId,deletedAt:catalog.deletedAt});}
    if (options.sync?.credentialReference && !await profile.getCredentialReference(options.sync.credentialReference)) {
      credentials.close();
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
      profileCredentialPath: credentials.path,
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
      storage.close();credentials.close();profile.close();
      throw error;
    }
    const artifacts = new LocalArtifactStore(options.artifactDirectory);
    await artifacts.cleanupStaging();
    const providers: ModelProvider[] = [new EchoModelProvider(), ...(options.modelProviders ?? [])];
    const configuredNames = new Set(providers.map(provider => provider.name));
    const availability = (provider: SupportedModelProviderName) => {
      const status = credentials.status(provider);
      return {
        usable: status.configured,
        credentialSource: status.source,
        ...(status.configured ? {} : { remediation: `Use /model login ${provider} or set ${status.environmentVariable}.` }),
      };
    };
    if (!configuredNames.has("vercel")) providers.push(createVercelModelProvider({
      origin: modelCatalog.gatewayOrigin,
      apiKey: () => credentials.resolve("vercel"),
      availability: () => availability("vercel"),
    }));
    if (!configuredNames.has("openai")) providers.push(createOpenAIModelProvider({
      origin: process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
      apiKey: () => credentials.resolve("openai"),
      availability: () => availability("openai"),
    }));
    if (!configuredNames.has("anthropic")) providers.push(createAnthropicModelProvider({
      origin: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      apiKey: () => credentials.resolve("anthropic"),
      availability: () => availability("anthropic"),
    }));
    const modelExecutor = new ModelExecutor(providers, options.providerConcurrency ?? 1, modelCatalog);
    const executors = [
      new ShellExecutor(workspaceRoot, artifacts),
      new FileExecutor(workspaceRoot),
      new SkillExecutor(),
      modelExecutor,
    ];
    let scratchStore: ScratchStore | null = null;
    let scratchCheckpointHooks = options.scratchCheckpointHooks ?? null;
    if (options.enableLocalScratchCheckpoints) {
      scratchStore = new LibSqlScratchStore({
        url: options.databaseUrl,
        deviceId: device.deviceId,
      });
      scratchCheckpointHooks = {
        load: async (scope) => scratchStore!.load(
          scope,
          await executionLeases!.fenceForSession(scope.sessionId),
        ),
        checkpoint: async (scope, candidate, source) => {
          const fence = await executionLeases!.fenceForSession(scope.sessionId);
          const result = candidate.savedNames.length === 0 && candidate.skipped.length === 0
            ? await scratchStore!.clear(scope, source, fence)
            : await scratchStore!.write(scope, candidate, source, fence);
          if (result.status === "stale") {
            throw new ValidationError(
              "Scratch checkpoint was superseded before local cache persistence",
            );
          }
        },
      };
    }
    const supervisor = new Supervisor(
      storage,
      profile,
      credentials,
      device,
      sync,
      artifacts,
      new ConsoleExecutionPool({
        maxResidentProcesses: options.maxConsoleResidentProcesses ??
          DEFAULT_MAX_CONSOLE_RESIDENT_PROCESSES,
        maxActiveExecutions: options.maxConsoleActiveExecutions ??
          DEFAULT_MAX_CONSOLE_ACTIVE_EXECUTIONS,
        ...(options.scratchCheckpointTimeoutMs === undefined ? {} : {
          scratchCheckpointTimeoutMs: options.scratchCheckpointTimeoutMs,
        }),
        ...(options.scratchIdleScopeMs === undefined ? {} : {
          scratchIdleScopeMs: options.scratchIdleScopeMs,
        }),
        ...(options.scratchMaxWarmScopes === undefined ? {} : {
          scratchMaxWarmScopes: options.scratchMaxWarmScopes,
        }),
      }),
      new OutboxRunner(storage, executors),
      options.restartConsoleAfterCell ?? false,
      scratchCheckpointHooks,
      scratchStore,
      options.consoleRssRecycleThresholdBytes ?? SCRATCH_LIMITS.rssRecycleBytes,
      maxSessionDepth,
      maxAwaitedAgentDepth,
      options.maxChildrenPerSession ?? 32,
      options.userScopeKey ?? "default-user",
      options.skillPermissionAllowlist ?? [],
      modelExecutor,
      modelCatalog,
      workspaceRoot,
      executionLeases,
    );
    if (options.recover !== false) await supervisor.recoverExecution({ drainPending: executionLeases === null });
    if (options.startWakeSchedulers !== false) supervisor.startWakeSchedulers(options.heartbeatPollIntervalMs ?? 100);
    return supervisor;
  }

  /** Secret-free provider descriptors suitable for onboarding and clients. */
  get modelProviders() { return this.modelExecutor.providers(); }

  /** Resolves provider-defined shorthand before model identity becomes durable. */
  normalizeModelConfiguration(model: ModelConfigurationInput): ModelConfiguration {
    return this.modelExecutor.normalizeConfiguration(model);
  }

  async #normalizeSelectedModel(model: ModelConfigurationInput): Promise<ModelConfiguration> {
    if (this.modelExecutor.isProductTransport(model.provider) &&
        normalizeReasoningEffort(model.reasoningEffort) !== "provider-default") {
      await this.modelCatalog.ensureFresh();
    }
    return this.normalizeModelConfiguration(model);
  }

  /** Reconciles retained work only after managed lease admission. */
  async recoverExecution(options: { readonly drainPending?: boolean } = {}): Promise<void> {
    await this.outbox.recover();
    await this.agents.recoverCancellations();
    if (options.drainPending !== false) await this.outbox.drain();
    await this.compactions.recoverIncomplete();
    await this.modelLoop.recoverIncomplete();
    await this.modelLoop.reconcileRunningSessions();
    await this.goals.recoverIncomplete();
    await this.ai.recoverIncomplete();
    await this.#recursiveModels.recoverIncomplete();
    await this.refiner.recoverIncomplete();
    await this.refinementGovernance.recoverIncomplete();
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
    await this.refinementGovernance.close();
    await this.ai.close();
    await this.#recursiveModels.close();
    await this.sync.stop();
    await this.executionLeases?.close();
    this.#scratchStore?.close();
    this.storage.close();
    this.credentials.close();
    this.profile.close();
  }

  /** Quiesces all workers before invoking the terminal physical deletion path. */
  async deleteOwnedData(input: DeleteOwnedDataInput): Promise<PhysicalDeletionReceipt> {
    if (this.#closed) throw new ValidationError("Supervisor is closed");
    await this.heartbeats.close();
    await this.schedules.close();
    await this.console.stop();
    await this.refiner.close();
    await this.refinementGovernance.close();
    await this.ai.close();
    await this.#recursiveModels.close();
    await this.outbox.quiesceForDeletion();
    this.#scratchStore?.close();
    try { return await this.sync.deleteOwnedData(input); }
    finally {
      await this.sync.stop().catch(() => {});
      await this.executionLeases?.close().catch(() => {});
      this.storage.close();this.credentials.close();this.profile.close();this.#closed = true;
    }
  }

  async createSession(options: CreateSessionOptions): Promise<{ sessionId: string; branchId: string }> {
    assertNoReservedModelDispatchInputFields(
      options,
      "Public session input",
    );
    assertNoReservedModelDispatchInputFields(
      options.model,
      "Public model configuration",
    );
    const sessionId = options.sessionId ?? newId();
    return this.#sessionCreations.run(sessionId, () => this.#createSessionWithIdentity(sessionId, options));
  }

  async #createSessionWithIdentity(
    sessionId: string,
    options: CreateSessionOptions,
  ): Promise<{ sessionId: string; branchId: string }> {
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
    const model = await this.#normalizeSelectedModel(options.model ?? { provider: "echo", model: "echo-1", reasoningEffort: "provider-default" });
    const existing = await this.storage.loadEvents(sessionId);
    const existingCreated = existing.find((event) => event.type === "SessionCreated") as AgentEvent<"SessionCreated"> | undefined;
    const branchId = options.branchId ?? existingCreated?.payload.initialBranchId ?? newId();
    const requestedProfile = options.agentProfile ?? SEALED_ROOT_AGENT_PROFILE;
    const profileMetadata = {
      profileVersionId: `agent-profile-${sessionId}-v1`,
      agentSessionId: sessionId,
      createdBy: options.agentProfile
        ? { kind: "user" as const, profileId: this.device.profileId }
        : { kind: "system" as const, componentId: "agencity.sealed-root-profile", version: 1 },
      reason: options.agentProfile ? "Explicit owner-supplied initial profile" : "Sealed root admission profile",
      createdAt: existingCreated?.payload.agentProfile.createdAt ?? now,
    };
    const agentProfile = this.agentProfiles.materializeInitial(requestedProfile, profileMetadata);
    if (existingCreated) {
      const payload = existingCreated.payload;
      if (payload.workspaceId !== options.workspaceId || payload.initialBranchId !== branchId ||
          !Bun.deepEquals(payload.model, model) || !Bun.deepEquals(payload.budget, options.budget ?? {}) ||
          payload.sessionName !== options.sessionName || payload.initialBranchName !== options.branchName ||
          !Bun.deepEquals(payload.agentProfile, agentProfile)) {
        throw new ValidationError("Session identity was reused with different durable meaning");
      }
      return { sessionId, branchId };
    }
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
        agentProfile,
        ...(options.sessionName === undefined ? {} : { sessionName: options.sessionName }),
        ...(options.branchName === undefined ? {} : { initialBranchName: options.branchName }),
      },
    }]);
    return { sessionId, branchId };
  }

  /** Explicitly changes the durable branch model while no model work is active. */
  async selectModel(sessionId: string, branchId: string, model: ModelConfigurationInput): Promise<{
    readonly changed: boolean;
    readonly previousModel: ModelConfiguration;
    readonly model: ModelConfiguration;
    readonly eventId?: string;
    readonly cursor?: string;
  }> {
    const normalizedModel = await this.#normalizeSelectedModel(model);
    const descriptor = this.modelExecutor.providers().find(provider => provider.name === normalizedModel.provider);
    if (!descriptor || normalizedModel.provider === "echo") {
      throw new ValidationError(normalizedModel.provider === "echo"
        ? "Echo is an internal test fixture and cannot be selected through /model"
        : `Unknown model provider: ${normalizedModel.provider}`);
    }
    if (!descriptor.usable) throw new ValidationError(descriptor.remediation ?? `Credential unavailable for ${normalizedModel.provider}`);
    const events = await this.storage.loadEvents(sessionId, { branchId });
    if (!events.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const state = projectEvents(events);
    if (Bun.deepEquals(state.model, normalizedModel)) return { changed: false, previousModel: state.model, model: normalizedModel };
    if (Object.values(state.agentRuns).some(run => !["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status)) ||
        Object.values(state.modelCalls).some(call => call.status === "requested")) {
      throw new ValidationError("Cannot change the branch model while model work is active");
    }
    const [event] = await this.storage.appendEvents([{
      sessionId,
      branchId,
      type: "SessionModelChanged",
      producer: "client",
      idempotencyKey: `session-model:${newId()}`,
      payload: { previousModel: state.model, model: normalizedModel, selectedBy: "user" },
    }]);
    return { changed: true, previousModel: state.model, model: normalizedModel, eventId: event!.id, cursor: event!.cursor };
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

  /** Retained diagnostic compatibility route using the canonical AgentRun boundary. */
  async diagnosticTurn(sessionId: string, branchId: string): Promise<{
    readonly outcome: "succeeded" | "failed" | "cancelled" | "unknown";
    readonly message?: string;
    readonly error?: string;
    readonly runId: string;
  }> {
    const events = await this.storage.loadEvents(sessionId, { branchId });
    if (!events.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const state = projectEvents(events);
    const task = [...state.messages].reverse().find((message) => message.role === "user")?.content;
    if (!task) throw new ValidationError("Diagnostic turn requires a retained user message");
    const result = await this.runs.start(sessionId, branchId, {
      task,
      goalMode: "none",
      requestKey: `diagnostic-turn:${newId()}`,
      suppressTaskMessage: true,
    });
    if (result.status === "succeeded") {
      return { outcome: "succeeded", runId: result.runId, ...(result.final === undefined ? {} : { message: result.final }) };
    }
    if (result.status === "cancelled" || result.status === "unknown") {
      return { outcome: result.status, runId: result.runId, ...(result.reason === undefined ? {} : { error: result.reason }) };
    }
    return { outcome: "failed", runId: result.runId, error: result.reason ?? `Agent run ${result.status}` };
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
    return this.#cells.run(
      `${sessionId}/${branchId}`,
      () => this.console.run(
        { sessionId, branchId },
        (consoleProcess) =>
          this.#executeCell(
            consoleProcess,
            sessionId,
            branchId,
            code,
            dependencies,
            stableCellId,
          ),
      ),
    );
  }

  async #executeCell(
    consoleProcess: ConsoleProcess,
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
    const scratchScope: ScratchScope = { sessionId, branchId };
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
    const stagedRepositoryInstructions: RepositoryInstructionDiscovery[] = [];
    const omittedRepositoryInstructionPaths = new Set<string>();
    const omittedRepositoryInstructionTargets = new Set<string>();
    let omittedRepositoryInstructionCount = 0;
    let omittedRepositoryInstructionReadCount = 0;
    let unidentifiedRepositoryInstructionOmissionOccurrences = 0;
    let unidentifiedRepositoryInstructionReadTargetOmissionOccurrences = 0;
    let unidentifiedRepositoryInstructionAncestorScanOmissionOccurrences = 0;
    const deliveredRepositoryInstructions = this.repositoryInstructions.deliveredInstructions(history);
    let repositoryInstructionDiscoveryQueue: Promise<void> = Promise.resolve();
    let stagedObservationExpected: number | null = null;
    let stagedObservationBytes = 0;
    let stagedObservationPath: string | null = null;
    let stagedObservationWriter: StreamingJsonStager | null = null;
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
      if (method === "observation.stage.begin") {
        if (stagedObservationExpected !== null) throw new ValidationError("An oversized cell observation is already being staged");
        if (!Number.isSafeInteger(args[0]) || Number(args[0]) <= MAX_CELL_OBSERVATION_JSON_BYTES) {
          throw new ValidationError("Oversized cell observation staging requires a declared size above the IPC limit");
        }
        stagedObservationExpected = Number(args[0]);
        stagedObservationBytes = 0;
        stagedObservationPath = await this.artifacts.createStagingPath(`${cellId}-observation`);
        stagedObservationWriter = await StreamingJsonStager.open(stagedObservationPath);
        return { accepted: true };
      }
      if (method === "observation.stage.chunk") {
        if (stagedObservationExpected === null || typeof args[0] !== "string") {
          throw new ValidationError("Oversized cell observation staging was not initialized");
        }
        const bytes = Uint8Array.from(Buffer.from(args[0], "base64"));
        if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024 ||
            Buffer.from(bytes).toString("base64") !== args[0]) {
          throw new ValidationError("Oversized cell observation chunk is invalid");
        }
        stagedObservationBytes += bytes.byteLength;
        if (stagedObservationBytes > stagedObservationExpected) {
          throw new ValidationError("Oversized cell observation exceeded its declared size");
        }
        await stagedObservationWriter!.push(bytes);
        return { received: stagedObservationBytes };
      }
      if (method === "observation.stage.finish") {
        if (stagedObservationExpected === null || stagedObservationBytes !== stagedObservationExpected) {
          throw new ValidationError("Oversized cell observation staging is incomplete");
        }
        const rawPreview = JSON.parse(JSON.stringify(args[0])) as unknown;
        assertJsonValue(rawPreview);
        const preview = scrubJson(rawPreview);
        const writer = stagedObservationWriter;
        const path = stagedObservationPath;
        if (!writer || !path) throw new ValidationError("Oversized cell observation staging is unavailable");
        try {
          const byteLength = await writer.finish();
          const reference = await this.artifacts.putStaged(path, { mediaType: "application/json" });
          if (reference.size !== byteLength) {
            throw new ValidationError("Staged cell observation size changed during CAS placement");
          }
          stagedArtifacts.set(reference.artifactId, reference);
          const result = {
            protocol: BOUNDED_OUTPUT_PROTOCOL,
            completeness: "spilled",
            byteLength,
            preview,
            artifact: reference,
            guidance: "Use artifacts.readRange(artifactId, start, end) to retrieve exact JSON bytes in bounded ranges and parse them inside a cell.",
          } as const;
          assertBoundedOutputV1(result);
          stagedObservationExpected = null;
          stagedObservationPath = null;
          stagedObservationWriter = null;
          return result;
        } catch (error) {
          await writer.abort();
          await rm(path, { force: true }).catch(() => {});
          stagedObservationExpected = null;
          stagedObservationPath = null;
          stagedObservationWriter = null;
          throw error;
        }
      }
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
      if (method === "artifacts.readRange") {
        const artifactId = String(args[0]);
        const reference = stagedArtifacts.get(artifactId) ?? state.artifacts[artifactId];
        if (!reference) throw new ValidationError(`Artifact not found: ${artifactId}`);
        const start = args[1];
        const end = args[2];
        if (!Number.isSafeInteger(start) || Number(start) < 0 ||
            !Number.isSafeInteger(end) || Number(end) < Number(start)) {
          throw new ValidationError("Artifact ranges require zero-based integer start and end values");
        }
        const bytes = await this.artifacts.readRange(reference, Number(start), Number(end));
        return {
          protocol: BOUNDED_OUTPUT_PROTOCOL,
          completeness: "inline",
          byteLength: bytes.byteLength,
          value: {
            bytesBase64: Buffer.from(bytes).toString("base64"),
            start: Number(start),
            end: Number(end),
            size: reference.size,
            nextStart: Number(end) < reference.size ? Number(end) : null,
          },
        };
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
      if (method === "harness.review") {
        const input = typeof args[0] === "string"
          ? { instructions: args[0] }
          : (args[0] ?? {});
        return this.refiner.request(sessionId,branchId,input as any);
      }
      if (method === "harness.reviews") return this.refiner.list({ sessionId, branchId, ...((args[0] ?? {}) as any) });
      if (method === "harness.propose") return this.harness.propose(sessionId,branchId,{...(args[0] as any),authority:"agent"});
      if (method === "harness.list") return this.harness.modelList(sessionId,branchId,(args[0] ?? {}) as any);
      if (method === "harness.history") return this.harness.modelHistory(sessionId,branchId,String(args[0]));
      if (method === "skills.list") return this.skillManagement.list(sessionId,branchId,(args[0] ?? {}) as any);
      if (method === "skills.get") return this.skillManagement.get(sessionId,branchId,String(args[0] ?? ""));
      if (method === "skills.propose") return this.skillManagement.propose(sessionId,branchId,String(args[0] ?? ""),(args[1] === "local" ? "local" : "workspace"));
      if (method === "skills.invoke") {
        const options = (args[2] ?? {}) as Record<string, unknown>;
        return this.skills.invoke(sessionId,branchId,String(args[0]),args[1] as JsonValue,{ ...options, idempotencyKey: typeof options.idempotencyKey === "string" ? options.idempotencyKey : nextRpcKey(method), effectOrigin: { kind: "cell", cellId } } as any);
      }
      if (method === "skills.test") return this.skillManagement.test(sessionId,branchId,String(args[0]),{ kind: "cell", cellId });
      if (method === "agents.spawn") {
        const raw = args[0]; const input = typeof raw === "string" ? { task: raw } : raw as Record<string, unknown>;
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("agents.spawn requires a task string or object");
        const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey : nextRpcKey(method);
        return this.agents.spawnRunnable(sessionId, branchId, { ...input, idempotencyKey } as any);
      }
      if (method === "agents.spawnMany") {
        if (!Array.isArray(args[0]) || args[0].length === 0 || args[0].length > 16) {
          throw new ValidationError("agents.spawnMany requires 1-16 inputs");
        }
        const inputs = args[0].map((raw, index) => {
          const input = typeof raw === "string" ? { task: raw } : raw as Record<string, unknown>;
          if (!input || typeof input !== "object" || Array.isArray(input)) {
            throw new ValidationError("agents.spawnMany inputs must be task strings or objects");
          }
          const normalized = {
            ...input,
            idempotencyKey: typeof input.idempotencyKey === "string"
              ? input.idempotencyKey
              : `${nextRpcKey(method)}:${index + 1}`,
          };
          return normalized;
        });
        return this.agents.spawnManyRunnable(sessionId, branchId, inputs as any);
      }
      if (method === "agents.run" || method === "agents.runMany") {
        const values = method === "agents.run" ? [args[0]] : args[0];
        if (!Array.isArray(values) || values.length === 0 || values.length > 16) {
          throw new ValidationError(`${method} requires 1-16 inputs`);
        }
        const inputs = values.map((raw, index) => {
          const input = typeof raw === "string" ? { task: raw } : raw as Record<string, unknown>;
          if (!input || typeof input !== "object" || Array.isArray(input)) {
            throw new ValidationError(`${method} inputs must be task strings or objects`);
          }
          return {
            ...input,
            idempotencyKey: typeof input.idempotencyKey === "string"
              ? input.idempotencyKey
              : `${nextRpcKey(method)}:${index + 1}`,
          };
        });
        const caller = await this.storage.getSession?.(sessionId);
        if (!caller) throw new NotFoundError("session", sessionId);
        if (caller.depth + 1 > this.maxAwaitedAgentDepth) {
          throw new ValidationError(
            `Maximum awaited agent depth ${this.maxAwaitedAgentDepth} exceeded`,
            {
              sessionId,
              branchId,
              callerDepth: caller.depth,
              maxAwaitedAgentDepth: this.maxAwaitedAgentDepth,
            },
          );
        }
        let reservation:
          Awaited<ReturnType<ConsoleExecutionPool["reserveAwaited"]>> | null =
            null;
        try {
          const handles = await this.agents.spawnManyRunnable(
            sessionId,
            branchId,
            inputs as any,
            {
              // AgentService invokes this only after complete batch validation
              // and while holding its exact-parent admission queue, but before
              // the atomic child/task append. Concurrent stable retries
              // therefore share the same scope reservation instead of racing
              // two speculative process counts.
              beforeAdmission: async (items) => {
                const awaitedScopes: ScratchScope[] = [];
                for (const item of items) {
                  if (item.existing) {
                    const current = await this.agents.result(
                      sessionId,
                      branchId,
                      item.handle.taskId,
                      { wait: false },
                    );
                    if (["succeeded", "blocked", "failed", "cancelled",
                      "budget_exceeded", "unknown"].includes(current.status)) {
                      continue;
                    }
                  }
                  awaitedScopes.push({
                    sessionId: item.handle.sessionId,
                    branchId: item.handle.branchId,
                  });
                }
                reservation = awaitedScopes.length
                  ? await this.console.reserveAwaited(awaitedScopes)
                  : null;
              },
            },
          );
          const results = await Promise.all(handles.map((handle) =>
            this.agents.result(sessionId, branchId, handle.taskId, {
              wait: true,
            })
          ));
          return method === "agents.run" ? results[0] : results;
        } finally {
          const heldReservation = reservation as
            Awaited<ReturnType<ConsoleExecutionPool["reserveAwaited"]>> | null;
          await heldReservation?.release();
        }
      }
      if (method === "agents.result") {
        const handle = args[0];
        const taskId = typeof handle === "string"
          ? handle
          : handle && typeof handle === "object" && !Array.isArray(handle) &&
              typeof (handle as Record<string, unknown>).taskId === "string"
          ? (handle as Record<string, string>).taskId
          : "";
        if (!taskId) {
          throw new ValidationError(
            "agents.result requires a task ID or retained agent handle",
          );
        }
        if (args[1] !== undefined &&
            (!args[1] || typeof args[1] !== "object" ||
              Array.isArray(args[1]))) {
          throw new ValidationError("agents.result options must be an object");
        }
        const options = (args[1] ?? {}) as Record<string, unknown>;
        if (Object.keys(options).some((key) =>
          key !== "wait" && key !== "timeoutMs"
        )) {
          throw new ValidationError("agents.result options contain unknown fields");
        }
        if (options.wait !== undefined && typeof options.wait !== "boolean") {
          throw new ValidationError("agents.result wait must be boolean");
        }
        if (options.timeoutMs !== undefined &&
            typeof options.timeoutMs !== "number") {
          throw new ValidationError("agents.result timeoutMs must be a number");
        }
        if (options.wait === false) {
          return this.agents.result(sessionId, branchId, taskId, {
            wait: false,
            ...(typeof options.timeoutMs === "number"
              ? { timeoutMs: options.timeoutMs }
              : {}),
          });
        }
        const current = await this.agents.result(
          sessionId,
          branchId,
          taskId,
          { wait: false },
        );
        if (["succeeded", "blocked", "failed", "cancelled",
          "budget_exceeded", "unknown"].includes(current.status)) {
          return current;
        }
        const task = (await this.agents.listTasks(sessionId, branchId))
          .find((candidate) => candidate.taskId === taskId);
        if (!task) throw new NotFoundError("agent invocation", taskId);
        const reservation = await this.console.reserveAwaited([{
          sessionId: task.childSessionId,
          branchId: task.childBranchId,
        }]);
        try {
          return await this.agents.result(sessionId, branchId, taskId, {
            wait: true,
            ...(typeof options.timeoutMs === "number"
              ? { timeoutMs: options.timeoutMs }
              : {}),
          });
        } finally {
          await reservation.release();
        }
      }
      if (method === "agents.get") {
        const target = typeof args[0] === "string" && args[0] ? args[0] : sessionId;
        if (target !== sessionId) {
          const rows = await this.storage.readonlyQuery({
            sql: "SELECT parent_session_id,parent_branch_id FROM sessions WHERE session_id=?",
            args: [target],
          });
          if (!rows[0] || String((rows[0] as any).parent_session_id ?? "") !== sessionId ||
              String((rows[0] as any).parent_branch_id ?? "") !== branchId) {
            throw new ValidationError("agents.get may inspect only self or a direct child");
          }
        }
        return this.agentProfiles.get(target, { includePrompt: true });
      }
      if (method === "agents.proposeProfileUpdate") {
        const target = typeof args[0] === "string" && args[0] ? args[0] : sessionId;
        const input = args[1] as Record<string, unknown>;
        const options = args[2] && typeof args[2] === "object" && !Array.isArray(args[2])
          ? args[2] as Record<string, unknown>
          : {};
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new ValidationError("agents.proposeProfileUpdate requires typed input");
        }
        return this.refinementGovernance.proposeAgent(sessionId, branchId, {
          target: {
            kind: "agent_profile",
            agentSessionId: target,
            expectedProfileVersionId: String(input.expectedProfileVersionId ?? ""),
            replacement: input.replacement as AgentProfileInput,
          },
          reason: String(input.reason ?? ""),
          predictedEffect: String(input.predictedEffect ?? ""),
          evidenceEventIds: Array.isArray(input.evidenceEventIds)
            ? input.evidenceEventIds.map(String)
            : [],
          ...(typeof input.revisesProposalId === "string"
            ? { revisesProposalId: input.revisesProposalId }
            : {}),
          wait: options.wait !== false,
        });
      }
      if (method === "agents.rollbackProfile") {
        const target = typeof args[0] === "string" && args[0] ? args[0] : sessionId;
        const input = args[1] as Record<string, unknown>;
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new ValidationError("agents.rollbackProfile requires typed input");
        }
        return this.refinementGovernance.rollbackAgent(sessionId, branchId, {
          targetKind: "agent_profile",
          targetId: target,
          expectedCurrentVersionId: String(input.expectedCurrentVersionId ?? ""),
          restoreVersionId: String(input.restoreVersionId ?? ""),
          reason: String(input.reason ?? ""),
          evidenceEventIds: Array.isArray(input.evidenceEventIds)
            ? input.evidenceEventIds.map(String)
            : [],
        });
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
        return this.agents.cancelFamilyTarget(
          sessionId,
          branchId,
          args[0],
          args[1] as string | undefined,
        );
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
      if (method === "ai.generateText" || method === "ai.generateObject") {
        const raw = args[0] as Record<string, unknown>;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new ValidationError(`${method} requires an input object`);
        }
        const input = {
          ...raw,
          idempotencyKey: typeof raw.idempotencyKey === "string"
            ? raw.idempotencyKey
            : nextRpcKey(method),
        };
        const admitted = method === "ai.generateText"
          ? await this.ai.admitText(sessionId, branchId, input as any, { cellId })
          : await this.ai.admitObject(sessionId, branchId, input as any, { cellId });
        return this.ai.result(admitted.generationId, { wait: true });
      }
      if (method === "tools.request") {
        const [executor, operation, input, rawOptions] = args;
        if (typeof executor !== "string" || typeof operation !== "string") throw new ValidationError("Invalid tool request");
        if (executor === "model") throw new CapabilityUnavailableError("generic model executor access", "use ai.generateText, ai.generateObject, or sdk.agents.spawn so model admission and dispatch provenance are retained");
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
          origin: { kind: "cell", cellId },
          idempotencyKey,
          idempotent,
        });
        const execution = await this.outbox.run(effectId);
        if (execution.outcome === "succeeded" && executor === "file" && operation === "read" &&
            input !== null && typeof input === "object" && !Array.isArray(input) &&
            typeof input.path === "string") {
          const readPath = input.path;
          const discover = repositoryInstructionDiscoveryQueue.then(async () => {
            const discovery = await this.repositoryInstructions.discoverForRead(
              readPath,
              deliveredRepositoryInstructions,
            );
            if (!discovery) return;
            if (stagedRepositoryInstructions.length <
                REPOSITORY_INSTRUCTION_LIMITS.discoveriesPerCell) {
              stagedRepositoryInstructions.push(discovery);
              for (const instruction of discovery.instructions) {
                deliveredRepositoryInstructions.set(instruction.path, instruction);
              }
              return;
            }
            omittedRepositoryInstructionReadCount++;
            omittedRepositoryInstructionCount += discovery.instructions.length +
              (discovery.omittedInstructionCount ?? 0);
            let omittedTargetRecorded = omittedRepositoryInstructionTargets.has(
              discovery.targetPath,
            );
            if (!omittedTargetRecorded &&
                omittedRepositoryInstructionTargets.size <
                  REPOSITORY_INSTRUCTION_LIMITS.omittedPaths) {
              omittedRepositoryInstructionTargets.add(discovery.targetPath);
              omittedTargetRecorded = true;
            }
            if (!omittedTargetRecorded) {
              unidentifiedRepositoryInstructionReadTargetOmissionOccurrences++;
            }
            let unidentifiedInstructionPath = false;
            for (const path of [
              ...discovery.instructions.map((instruction) => instruction.path),
              ...(discovery.omittedInstructionPaths ?? []),
            ]) {
              if (omittedRepositoryInstructionPaths.has(path)) continue;
              if (omittedRepositoryInstructionPaths.size <
                  REPOSITORY_INSTRUCTION_LIMITS.omittedPaths) {
                omittedRepositoryInstructionPaths.add(path);
              } else {
                unidentifiedInstructionPath = true;
              }
            }
            if (unidentifiedInstructionPath) {
              unidentifiedRepositoryInstructionOmissionOccurrences++;
            }
            unidentifiedRepositoryInstructionOmissionOccurrences +=
              discovery.unidentifiedInstructionOmissionOccurrences ?? 0;
            unidentifiedRepositoryInstructionAncestorScanOmissionOccurrences +=
              discovery.unidentifiedAncestorScanOmissionOccurrences ?? 0;
          });
          repositoryInstructionDiscoveryQueue = discover.catch(() => undefined);
          await discover;
        }
        return execution;
      }
      throw new ValidationError(`Unknown console RPC method: ${method}`);
    };

    let terminalCommitted = false;
    let workerRssBytes = 0;
    try {
      let loadResult: ScratchCheckpointLoadResult = {
        status: "unavailable",
        reason: "placement_unavailable",
      };
      if (this.scratchCheckpointHooks && !await consoleProcess.hasScratch(scratchScope)) {
        loadResult = await this.scratchCheckpointHooks.load(scratchScope).catch(() => ({
          status: "unavailable",
          reason: "storage_error",
        }));
        if (loadResult.status === "restored") {
          loadResult = {
            status: "restored",
            restore: {
              ...loadResult.restore,
              candidate: filterSensitiveScratchCheckpoint(loadResult.restore.candidate),
            },
          };
        }
      }
      await consoleProcess.prepareScratch(
        scratchScope,
        loadResult,
        this.scratchCheckpointHooks !== null,
      );
      const execution = await this.console.execute(
        consoleProcess,
        code,
        { id: sessionId, branchId },
        restored,
        handler,
      );
      workerRssBytes = execution.rssBytes;
      const rawPreview = JSON.parse(JSON.stringify(execution.observation.preview)) as unknown;
      assertJsonValue(rawPreview);
      const preview = scrubJson(rawPreview);
      let result: JsonValue;
      if (execution.observation.kind === "json") {
        const receivedBytes = new TextEncoder().encode(execution.observation.json).byteLength;
        if (receivedBytes !== execution.observation.byteLength ||
            receivedBytes > MAX_CELL_OBSERVATION_JSON_BYTES) {
          throw new ValidationError("Console worker returned an invalid or oversized inline observation");
        }
        const parsed = JSON.parse(execution.observation.json) as unknown;
        assertJsonValue(parsed);
        const scrubbed = scrubJson(parsed);
        const serialized = JSON.stringify(scrubbed);
        const byteLength = new TextEncoder().encode(serialized).byteLength;
        if (byteLength > MAX_CELL_OBSERVATION_JSON_BYTES) {
          throw new ValidationError("Scrubbed inline observation exceeds the cell IPC limit");
        } else {
          result = scrubbed;
        }
      } else if (execution.observation.kind === "staged") {
        assertJsonValue(execution.observation.result);
        assertBoundedOutputV1(execution.observation.result);
        result = scrubJson(execution.observation.result);
      } else {
        result = {
          kind: "unsupported",
          reason: scrubText(execution.observation.reason),
          preview,
        };
      }
      assertJsonValue(result);
      const logs = execution.logs.map(scrubText);
      const logStreams = [...execution.logStreams];
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
          logStreams,
          durationMs: Math.round(performance.now() - started),
          exports: [...stagedValues.keys()],
          ...(stagedRepositoryInstructions.length
            ? { repositoryInstructions: stagedRepositoryInstructions }
            : {}),
          ...(omittedRepositoryInstructionReadCount
            ? {
                repositoryInstructionOmission: {
                  protocol: REPOSITORY_INSTRUCTIONS_PROTOCOL,
                  targetPaths: [...omittedRepositoryInstructionTargets],
                  instructionPaths: [...omittedRepositoryInstructionPaths],
                  omittedInstructionCount: omittedRepositoryInstructionCount,
                  omittedReadTargetCount: omittedRepositoryInstructionReadCount,
                  ...(unidentifiedRepositoryInstructionOmissionOccurrences
                    ? {
                        unidentifiedInstructionOmissionOccurrences:
                          unidentifiedRepositoryInstructionOmissionOccurrences,
                      }
                    : {}),
                  ...(unidentifiedRepositoryInstructionReadTargetOmissionOccurrences
                    ? {
                        unidentifiedReadTargetOmissionOccurrences:
                          unidentifiedRepositoryInstructionReadTargetOmissionOccurrences,
                      }
                    : {}),
                  ...(unidentifiedRepositoryInstructionAncestorScanOmissionOccurrences
                    ? {
                        unidentifiedAncestorScanOmissionOccurrences:
                          unidentifiedRepositoryInstructionAncestorScanOmissionOccurrences,
                      }
                    : {}),
                } satisfies RepositoryInstructionOmission,
              }
            : {}),
        },
      });
      const committedEvents = await this.storage.appendEvents(events);
      const committedCellEvent = committedEvents.find((event) =>
        event.type === "CellCommitted" &&
        (event.payload as { cellId?: unknown }).cellId === cellId);
      if (!committedCellEvent) {
        throw new ValidationError("Committed cell batch did not return its terminal event");
      }
      terminalCommitted = true;
      acceptanceCrashAfterCellCommit(cellId);
      let checkpoint: ScratchCheckpointCandidate | null = null;
      try {
        checkpoint = await consoleProcess.checkpointScratch(scratchScope, cellId);
        if (checkpoint) checkpoint = filterSensitiveScratchCheckpoint(checkpoint);
      } catch {
        if (consoleProcess.status().running) {
          await consoleProcess
            .recycle("scratch-checkpoint-serialization-failed")
            .catch(() => {});
        }
      }
      if (checkpoint && this.scratchCheckpointHooks) {
        let persisted = false;
        try {
          await this.scratchCheckpointHooks.checkpoint(
            scratchScope,
            checkpoint,
            {
              cellId,
              eventId: committedCellEvent.id,
              cursor: committedCellEvent.cursor,
            },
          );
          persisted = true;
        } catch {
          // Scratch persistence is an optional operational cache. The warm
          // scope and committed cell remain valid when its storage is absent.
          await consoleProcess.recordScratchCacheWrite(
            scratchScope,
            "unavailable",
          ).catch(() => {});
        }
        if (persisted) {
          try {
            await consoleProcess.recordScratchCheckpoint(
              scratchScope,
              cellId,
              checkpoint,
            );
            await consoleProcess.recordScratchCacheWrite(
              scratchScope,
              checkpoint.savedNames.length === 0 && checkpoint.skipped.length === 0
                ? "cleared"
                : "stored",
            );
          } catch { /* Status bookkeeping never invalidates committed warm scratch. */ }
        }
      }
      return { cellId, result, logs };
    } catch (error) {
      if (error instanceof ConsoleCellError) workerRssBytes = error.rssBytes;
      const logs = error instanceof ConsoleCellError ? error.logs.map(scrubText) : [];
      const logStreams = error instanceof ConsoleCellError ? [...error.logStreams] : [];
      if (!terminalCommitted) {
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
            logStreams,
            durationMs: Math.round(performance.now() - started),
          },
        }]);
      }
      throw error;
    } finally {
      const unfinishedWriter = stagedObservationWriter as StreamingJsonStager | null;
      await unfinishedWriter?.abort();
      if (stagedObservationPath) await rm(stagedObservationPath, { force: true }).catch(() => {});
      if (!terminalCommitted) {
        if (consoleProcess.status().running) {
          try {
            await consoleProcess.evictScratch(scratchScope);
          } catch {
            if (consoleProcess.status().running) {
              await consoleProcess.recycle("failed-scope-eviction").catch(() => {});
            }
          }
        }
      }
      if (workerRssBytes > this.consoleRssRecycleThresholdBytes &&
          consoleProcess.status().running) {
        await consoleProcess.recycle("rss-soft-threshold").catch(() => {});
      }
      if (this.restartConsoleAfterCell) await consoleProcess.stop();
    }
  }
}

function filterSensitiveScratchCheckpoint(
  candidate: ScratchCheckpointCandidate,
): ScratchCheckpointCandidate {
  const safeNames = filterScratchCheckpoint(
    candidate,
    (name) => containsCredentialMaterial(name),
    {
      retainRejectedNames: false,
      omitSkippedName: (name) => containsCredentialMaterial(name),
    },
  );
  return filterScratchCheckpoint(
    safeNames,
    (_name, value) => containsCredentialMaterial(JSON.stringify(value)),
  );
}

function acceptanceCrashAfterCellCommit(cellId: string): void {
  if (process.env.AGENCITY_ACCEPTANCE !== "1") return;
  if (process.env.AGENCITY_ACCEPTANCE_FAILPOINT !== "cell-committed") return;
  process.stderr.write(`[agencity acceptance failpoint] committed CellCommitted for ${cellId}; exiting service before caller acknowledgement\n`);
  process.exit(86);
}

function acceptanceAgentRunMaxSteps(): number {
  if (process.env.AGENCITY_ACCEPTANCE !== "1") return 128;
  const raw = process.env.AGENCITY_ACCEPTANCE_MAX_RUN_STEPS;
  if (raw === undefined) return 128;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 128) throw new ValidationError("AGENCITY_ACCEPTANCE_MAX_RUN_STEPS must be an integer from 1 to 128");
  return value;
}

function adjacentFileUrl(databaseUrl: string, suffix: string): string {
  if (!databaseUrl.startsWith("file:")) throw new ValidationError("Profile and local sync-replica defaults require a file: workspace database URL");
  return `${databaseUrl}${suffix}`;
}

function isExactFileDatabaseUrl(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl);
    return url.protocol === "file:" && !url.username && !url.password &&
      !url.hostname && !url.search && !url.hash &&
      url.pathname.length > 0 &&
      url.pathname !== ":memory:" && url.pathname !== "/:memory:";
  } catch {
    return false;
  }
}

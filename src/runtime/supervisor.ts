import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalArtifactStore } from "../artifacts/index.ts";
import { ConsoleCellError, ConsoleProcess } from "../console/index.ts";
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
import { RecursiveModelService } from "./models.ts";
import { MemoryService } from "./memory.ts";
import { HarnessService } from "./harness.ts";
import { SkillService } from "./skills.ts";
import { SubagentSpecService } from "./specs.ts";

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
  readonly modelLoop: ModelLoop;
  readonly agents: AgentService;
  readonly documents: DocumentService;
  readonly models: RecursiveModelService;
  readonly goals: GoalService;
  readonly heartbeats: HeartbeatService;
  readonly memory: MemoryService;
  readonly harness: HarnessService;
  readonly skills: SkillService;
  readonly specs: SubagentSpecService;
  readonly restartConsoleAfterCell: boolean;
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
    this.contexts = new ContextMaterializer(storage, this.memory, this.harness, 30, userScopeKey, profile);
    this.modelLoop = new ModelLoop(storage, this.contexts, outbox);
    this.documents = new DocumentService(storage);
    this.goals = new GoalService(storage, outbox, this.modelLoop);
    this.heartbeats = new HeartbeatService(storage, this.goals);
    this.models = new RecursiveModelService(storage, this.agents, this.modelLoop, outbox);
    this.restartConsoleAfterCell = restartConsoleAfterCell;
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
    const storage = new LibSqlStorage({ url: options.databaseUrl, deviceId: device.deviceId });
    await storage.migrate();
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
    const executors = [
      new ShellExecutor(workspaceRoot),
      new FileExecutor(workspaceRoot),
      new SkillExecutor(),
      new ModelExecutor(providers, options.providerConcurrency ?? 1),
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
    );
    if (options.recover !== false) {
      await supervisor.outbox.recover();
      // Durable cancellation intent wins before queued effects or recursive
      // handles are allowed to resume.
      await supervisor.agents.recoverCancellations();
      await supervisor.outbox.drain();
      await supervisor.modelLoop.recoverIncomplete();
      await supervisor.modelLoop.reconcileRunningSessions();
      await supervisor.heartbeats.recoverDue();
      await supervisor.goals.recoverIncomplete();
      await supervisor.models.recoverIncomplete();
    }
    supervisor.heartbeats.startScheduler(options.heartbeatPollIntervalMs ?? 100);
    return supervisor;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.heartbeats.close();
    await this.console.stop();
    await this.models.close();
    await this.sync.stop();
    this.storage.close();
    this.profile.close();
  }

  /** Quiesces all workers before invoking the terminal physical deletion path. */
  async deleteOwnedData(input: DeleteOwnedDataInput): Promise<PhysicalDeletionReceipt> {
    if (this.#closed) throw new ValidationError("Supervisor is closed");
    await this.heartbeats.close();
    await this.console.stop();
    await this.models.close();
    await this.outbox.quiesceForDeletion();
    try { return await this.sync.deleteOwnedData(input); }
    finally {
      await this.sync.stop().catch(() => {});
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
      payload: { workspaceId: options.workspaceId, initialBranchId: branchId, model, budget: options.budget ?? {} },
    }]);
    return { sessionId, branchId };
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

  /** Creates an immutable, source-linked deterministic extractive summary; source messages remain canonical. */
  async compact(sessionId: string, branchId: string): Promise<{ contextId: string; sourceEventIds: string[]; summary: string }> {
    const events=await this.storage.loadEvents(sessionId,{branchId});if(!events.length)throw new NotFoundError("session branch",`${sessionId}/${branchId}`);
    const messages=events.filter(event=>event.type==="MessageAppended");const source=messages.slice(0,Math.max(0,messages.length-20));
    if(!source.length)throw new CapabilityUnavailableError("compaction before more than 20 retained messages exist","deterministic-extractive-v1");
    const summary=source.map(event=>{const payload=event.payload as {role:string;content:string};return `[${payload.role}] ${payload.content.slice(0,500)}`;}).join("\n").slice(0,64*1024);
    const contextId=newId();const context=JSON.parse(JSON.stringify({kind:"compaction",strategy:"deterministic-extractive-v1",summary,sourceEventIds:source.map(event=>event.id),sourceCount:source.length})) as JsonValue;
    const encoded=JSON.stringify(context);const hasher=new Bun.CryptoHasher("sha256");hasher.update(encoded);const contentHash=hasher.digest("hex");
    await this.storage.appendEvents([{sessionId,branchId,type:"ContextMaterialized",producer:"supervisor",idempotencyKey:`compaction:${contextId}`,payload:{contextId,records:source.map(event=>({eventId:event.id,type:event.type,schemaVersion:event.schemaVersion,reason:"compaction source retained"})),contentHash,context}}]);
    return{contextId,sourceEventIds:source.map(event=>event.id),summary};
  }

  async fork(sessionId: string, parentBranchId: string, forkCursor: string, name?: string): Promise<string> {
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
    return branchId;
  }

  async executeCell(
    sessionId: string,
    branchId: string,
    code: string,
    dependencies: string[] = [],
  ): Promise<{ cellId: string; result: JsonValue; logs: string[] }> {
    const session = await this.storage.getSession?.(sessionId);
    if (session?.executionOwnerDeviceId && session.executionOwnerDeviceId !== this.device.deviceId) throw new CapabilityUnavailableError(`execution of session owned by device ${session.executionOwnerDeviceId}`, `device ${this.device.deviceId} (automatic ownership failover is unavailable)`);
    return this.#cells.run(`${sessionId}/${branchId}`, () => this.#executeCell(sessionId, branchId, code, dependencies));
  }

  async #executeCell(
    sessionId: string,
    branchId: string,
    code: string,
    dependencies: string[],
  ): Promise<{ cellId: string; result: JsonValue; logs: string[] }> {
    if (containsBrokeredSecret(code)) {
      throw new ValidationError("Brokered credentials cannot enter console cell source");
    }
    const history = await this.storage.loadEvents(sessionId, { branchId });
    if (!history.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const state = projectEvents(history);
    const cellId = newId();
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
    const handler = async (method: string, args: unknown[]): Promise<unknown> => {
      if (method === "state.get") {
        const name = String(args[0]);
        return stagedValues.get(name) ?? state.workingValues[name]?.value ?? null;
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
      if (method === "memory.search") return this.memory.search(sessionId,branchId,String(args[0] ?? ""),(args[1] ?? {}) as any);
      if (method === "memory.create") return this.memory.create(sessionId,branchId,args[0] as any,"agent");
      if (method === "memory.list") return this.memory.list(sessionId,branchId,(args[0] ?? {}) as any);
      if (method === "harness.propose") return this.harness.propose(sessionId,branchId,{...(args[0] as any),authority:"agent"});
      if (method === "harness.list") return this.harness.modelList(sessionId,branchId,(args[0] ?? {}) as any);
      if (method === "harness.history") return this.harness.modelHistory(sessionId,branchId,String(args[0]));
      if (method === "skills.invoke") return this.skills.invoke(sessionId,branchId,String(args[0]),args[1] as JsonValue,(args[2] ?? {}) as any);
      if (method === "skills.test") return this.skills.testModelVisible(sessionId,branchId,String(args[0]),typeof args[1] === "string" ? args[1] : undefined);
      if (method === "specs.spawn") return this.specs.spawn(sessionId,branchId,String(args[0]),(args[1] ?? {}) as any);
      if (method === "tools.request") {
        const [executor, operation, input, rawOptions] = args;
        if (typeof executor !== "string" || typeof operation !== "string") throw new ValidationError("Invalid tool request");
        assertJsonValue(input);
        const options = rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions)
          ? rawOptions as Record<string, unknown>
          : {};
        const idempotencyKey = typeof options.idempotencyKey === "string"
          ? options.idempotencyKey
          : `cell:${cellId}:${executor}:${operation}:${newId()}`;
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
      assertJsonValue(execution.value);
      const result = scrubJson(execution.value);
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

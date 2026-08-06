import type { AgentEvent, AgentState, NewAgentEvent } from "../domain/index.ts";
import { CapabilityUnavailableError, DependencyFailureError } from "../domain/index.ts";
import type { JsonValue } from "../domain/json.ts";
import type {
  AgentStorage, DocumentChunkRecord, DocumentRecord, EventQuery, GoalGateRecord, GoalRecord,
  HeartbeatRecord, InputSetRecord, MailboxRecord, OutboxRecord, ReadonlyStatement,
  RecursiveModelRecord, RecursiveStorageOperations, SessionRecord, StorageCapabilities, TaskRecord,
} from "../storage/index.ts";
import { requireCapability, type PlacementDescriptor } from "./capabilities.ts";
import { decodeWire, encodeWire, errorResponse, jsonResponse, normalizedEndpoint, readWireResponse } from "./http-wire.ts";

export interface RelationalPlacementCapabilities extends StorageCapabilities {
  readonly administrativeMigrations: boolean;
  readonly recursiveOperations: boolean;
  readonly memoryCandidateIndexRebuild: boolean;
}

export type RelationalPlacementDescriptor = PlacementDescriptor<RelationalPlacementCapabilities> & {
  readonly protocol: "agencity-relational-rpc-v1" | "in-process";
};

export interface RelationalStatePlacement {
  readonly storage: AgentStorage;
  readonly descriptor: RelationalPlacementDescriptor;
}

/** Marks an existing process-local store without changing its domain contract. */
export function localRelationalState(storage: AgentStorage): RelationalStatePlacement {
  const recursiveOperations = recursiveMethodNames.every((method) => typeof storage[method] === "function");
  return {
    storage,
    descriptor: {
      name: storage.name,
      placement: "local",
      transport: "in-process",
      protocol: "in-process",
      capabilities: {
        ...storage.capabilities,
        administrativeMigrations: true,
        recursiveOperations,
        memoryCandidateIndexRebuild: typeof storage.rebuildMemoryCandidateIndex === "function",
      },
    },
  };
}

export interface RelationalRpcServerOptions {
  /** Schema changes remain operator-owned unless explicitly exposed. */
  readonly administrativeMigrations?: boolean;
  readonly analyticalSql?: boolean;
}

const recursiveMethodNames = [
  "getSession", "listChildren", "getTask", "findTaskByChild", "listTasks",
  "getMailboxMessage", "listMailboxMessages", "getDocument", "getDocumentChunk",
  "readDocumentChunks", "getInputSet", "getGoal", "listGoalGates", "getHeartbeat",
  "listDueHeartbeats", "getRecursiveModel", "listRecursiveModels", "rebuildOperationalProjections",
] as const satisfies readonly (keyof RecursiveStorageOperations)[];

const remotelyCallable = new Set<string>([
  "migrate", "appendEvents", "loadEvents", "getEvent", "getLatestCursor", "listBranches",
  "saveSnapshot", "loadSnapshot", "deleteSnapshots", "claimOutbox", "claimEffect", "getOutbox",
  "listOutbox", "resetOutbox", "readonlyQuery", ...recursiveMethodNames,
  "rebuildMemoryCandidateIndex",
]);

function serverDescriptor(storage: AgentStorage, options: RelationalRpcServerOptions): RelationalPlacementDescriptor {
  const recursiveOperations = recursiveMethodNames.every((method) => typeof storage[method] === "function");
  return {
    name: `http-rpc:${storage.name}`,
    placement: "remote",
    transport: "http",
    protocol: "agencity-relational-rpc-v1",
    capabilities: {
      offlineWrites: false,
      // Process fencing is a local placement contract. This RPC version does not
      // carry a verified caller device identity or expose lease operations.
      sameDeviceProcessFencing: false,
      distributedLeases: storage.capabilities.distributedLeases,
      analyticalSql: options.analyticalSql ?? storage.capabilities.analyticalSql,
      notifications: false,
      administrativeMigrations: options.administrativeMigrations ?? false,
      recursiveOperations,
      memoryCandidateIndexRebuild: typeof storage.rebuildMemoryCandidateIndex === "function",
    },
  };
}

/**
 * Production RPC boundary for server-owned relational state. The client never
 * receives the backing adapter and every call crosses JSON/HTTP serialization.
 */
export function createRelationalStateRpcHandler(
  storage: AgentStorage,
  options: RelationalRpcServerOptions = {},
): (request: Request) => Promise<Response> {
  const descriptor = serverDescriptor(storage, options);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/relational/capabilities") {
      return jsonResponse(descriptor);
    }
    if (request.method !== "POST" || url.pathname !== "/v1/relational/call") {
      return jsonResponse({ error: { code: "NOT_FOUND", message: "Unknown relational RPC route", details: {} } }, 404);
    }
    try {
      const decoded = decodeWire(await request.json() as never);
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new TypeError("RPC body must be an object");
      const body = decoded as { operation?: unknown; args?: unknown };
      if (typeof body.operation !== "string" || !remotelyCallable.has(body.operation) || !Array.isArray(body.args)) {
        throw new TypeError("Unknown or malformed relational RPC operation");
      }
      if (body.operation === "migrate") requireCapability(descriptor.name, "administrativeMigrations", descriptor.capabilities.administrativeMigrations);
      if (body.operation === "readonlyQuery") requireCapability(descriptor.name, "analyticalSql", descriptor.capabilities.analyticalSql);
      if (recursiveMethodNames.includes(body.operation as typeof recursiveMethodNames[number])) {
        requireCapability(descriptor.name, "recursiveOperations", descriptor.capabilities.recursiveOperations);
      }
      if (body.operation === "rebuildMemoryCandidateIndex") {
        requireCapability(descriptor.name, "memoryCandidateIndexRebuild", descriptor.capabilities.memoryCandidateIndexRebuild);
      }
      const operation = (storage as unknown as Record<string, unknown>)[body.operation];
      if (typeof operation !== "function") throw new CapabilityUnavailableError(body.operation, storage.name);
      const value = await (operation as (...args: unknown[]) => unknown).apply(storage, body.args);
      return jsonResponse({ value });
    } catch (error) { return errorResponse(error); }
  };
}

function isRelationalDescriptor(value: unknown): value is RelationalPlacementDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>, capabilities = item.capabilities;
  if (typeof item.name !== "string" || item.protocol !== "agencity-relational-rpc-v1" || item.transport !== "http" || item.placement !== "remote" || !capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  const flags = capabilities as Record<string, unknown>;
  return ["offlineWrites", "sameDeviceProcessFencing", "distributedLeases", "analyticalSql", "notifications", "administrativeMigrations", "recursiveOperations", "memoryCandidateIndexRebuild"].every((key) => typeof flags[key] === "boolean");
}

export interface HttpRelationalStateOptions {
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>);
  readonly requestTimeoutMs?: number;
}

export class HttpRelationalStateStore implements AgentStorage {
  readonly name: string;
  readonly capabilities: StorageCapabilities;
  readonly placement: RelationalPlacementDescriptor;
  readonly #endpoint: string;
  readonly #headers?: HttpRelationalStateOptions["headers"];
  readonly #timeoutMs: number;
  #closed = false;

  private constructor(options: HttpRelationalStateOptions, descriptor: RelationalPlacementDescriptor) {
    this.#endpoint = normalizedEndpoint(options.endpoint);
    this.#headers = options.headers;
    this.#timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.name = descriptor.name;
    this.placement = descriptor;
    this.capabilities = {
      offlineWrites: descriptor.capabilities.offlineWrites,
      sameDeviceProcessFencing: descriptor.capabilities.sameDeviceProcessFencing,
      distributedLeases: descriptor.capabilities.distributedLeases,
      analyticalSql: descriptor.capabilities.analyticalSql,
      notifications: descriptor.capabilities.notifications,
    };
  }

  static async connect(options: HttpRelationalStateOptions): Promise<HttpRelationalStateStore> {
    const endpoint = normalizedEndpoint(options.endpoint);
    let response: Response;
    try {
      const supplied = typeof options.headers === "function" ? await options.headers() : options.headers;
      response = await fetch(`${endpoint}/v1/relational/capabilities`, {
        ...(supplied === undefined ? {} : { headers: supplied }),
        signal: AbortSignal.timeout(options.requestTimeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new DependencyFailureError("Relational RPC capability discovery failed", {
        endpoint,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const descriptor = await readWireResponse(response, "Relational RPC");
    if (!isRelationalDescriptor(descriptor)) {
      throw new DependencyFailureError("Relational RPC advertised an incompatible protocol or capabilities", { endpoint });
    }
    return new HttpRelationalStateStore(options, descriptor);
  }

  async #call<T>(operation: string, args: readonly unknown[] = []): Promise<T> {
    if (this.#closed) throw new DependencyFailureError("Relational RPC client is closed", { adapter: this.name });
    let response: Response;
    try {
      const supplied = typeof this.#headers === "function" ? await this.#headers() : this.#headers;
      response = await fetch(`${this.#endpoint}/v1/relational/call`, {
        method: "POST",
        headers: { "content-type": "application/json", ...supplied },
        body: JSON.stringify(encodeWire({ operation, args })),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new DependencyFailureError("Relational RPC transport failed", {
        adapter: this.name,
        operation,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const body = await readWireResponse(response, "Relational RPC");
    if (!body || typeof body !== "object" || Array.isArray(body) || !("value" in body)) {
      throw new DependencyFailureError("Relational RPC response omitted its value", { operation });
    }
    return (body as { value: T }).value;
  }

  async migrate(): Promise<void> {
    requireCapability(this.name, "administrativeMigrations", this.placement.capabilities.administrativeMigrations);
    await this.#call("migrate");
  }
  close(): void { this.#closed = true; }
  onCommitted(_listener: (events: readonly AgentEvent[]) => void): () => void {
    throw new CapabilityUnavailableError("notifications", this.name);
  }
  appendEvents(events: readonly NewAgentEvent[]): Promise<AgentEvent[]> { return this.#call("appendEvents", [events]); }
  loadEvents(sessionId: string, query?: EventQuery): Promise<AgentEvent[]> { return this.#call("loadEvents", [sessionId, query]); }
  getEvent(eventId: string): Promise<AgentEvent | null> { return this.#call("getEvent", [eventId]); }
  getLatestCursor(sessionId: string, branchId: string): Promise<string | null> { return this.#call("getLatestCursor", [sessionId, branchId]); }
  listBranches(): Promise<Array<{ sessionId: string; branchId: string }>> { return this.#call("listBranches"); }
  saveSnapshot(state: AgentState): Promise<void> { return this.#call("saveSnapshot", [state]); }
  loadSnapshot(sessionId: string, branchId: string): Promise<AgentState | null> { return this.#call("loadSnapshot", [sessionId, branchId]); }
  deleteSnapshots(sessionId?: string): Promise<void> { return this.#call("deleteSnapshots", [sessionId]); }
  claimOutbox(owner: string, limit?: number, leaseMs?: number): Promise<OutboxRecord[]> { return this.#call("claimOutbox", [owner, limit, leaseMs]); }
  claimEffect(effectId: string, owner: string, leaseMs?: number): Promise<OutboxRecord | null> { return this.#call("claimEffect", [effectId, owner, leaseMs]); }
  getOutbox(effectId: string): Promise<OutboxRecord | null> { return this.#call("getOutbox", [effectId]); }
  listOutbox(statuses?: readonly OutboxRecord["status"][]): Promise<OutboxRecord[]> { return this.#call("listOutbox", [statuses]); }
  resetOutbox(effectId: string): Promise<void> { return this.#call("resetOutbox", [effectId]); }
  readonlyQuery(statement: ReadonlyStatement): Promise<JsonValue[]> {
    requireCapability(this.name, "analyticalSql", this.placement.capabilities.analyticalSql);
    return this.#call("readonlyQuery", [statement]);
  }

  getSession(sessionId: string): Promise<SessionRecord | null> { return this.#recursive("getSession", [sessionId]); }
  listChildren(parentSessionId: string): Promise<SessionRecord[]> { return this.#recursive("listChildren", [parentSessionId]); }
  getTask(taskId: string): Promise<TaskRecord | null> { return this.#recursive("getTask", [taskId]); }
  findTaskByChild(childSessionId: string): Promise<TaskRecord | null> { return this.#recursive("findTaskByChild", [childSessionId]); }
  listTasks(parentSessionId: string, parentBranchId?: string): Promise<TaskRecord[]> { return this.#recursive("listTasks", [parentSessionId, parentBranchId]); }
  getMailboxMessage(messageId: string): Promise<MailboxRecord | null> { return this.#recursive("getMailboxMessage", [messageId]); }
  listMailboxMessages(sessionId: string, direction?: "inbound" | "outbound" | "all"): Promise<MailboxRecord[]> { return this.#recursive("listMailboxMessages", [sessionId, direction]); }
  getDocument(documentId: string): Promise<DocumentRecord | null> { return this.#recursive("getDocument", [documentId]); }
  getDocumentChunk(chunkId: string): Promise<DocumentChunkRecord | null> { return this.#recursive("getDocumentChunk", [chunkId]); }
  readDocumentChunks(documentId: string, options?: { readonly start?: number; readonly limit?: number; readonly chunkIds?: readonly string[] }): Promise<DocumentChunkRecord[]> { return this.#recursive("readDocumentChunks", [documentId, options]); }
  getInputSet(inputSetId: string): Promise<InputSetRecord | null> { return this.#recursive("getInputSet", [inputSetId]); }
  getGoal(goalId: string): Promise<GoalRecord | null> { return this.#recursive("getGoal", [goalId]); }
  listGoalGates(goalId: string): Promise<GoalGateRecord[]> { return this.#recursive("listGoalGates", [goalId]); }
  getHeartbeat(heartbeatId: string): Promise<HeartbeatRecord | null> { return this.#recursive("getHeartbeat", [heartbeatId]); }
  listDueHeartbeats(at: string): Promise<HeartbeatRecord[]> { return this.#recursive("listDueHeartbeats", [at]); }
  getRecursiveModel(handleId: string): Promise<RecursiveModelRecord | null> { return this.#recursive("getRecursiveModel", [handleId]); }
  listRecursiveModels(statuses?: readonly RecursiveModelRecord["status"][]): Promise<RecursiveModelRecord[]> { return this.#recursive("listRecursiveModels", [statuses]); }
  rebuildOperationalProjections(): Promise<void> { return this.#recursive("rebuildOperationalProjections"); }
  rebuildMemoryCandidateIndex(): Promise<void> {
    requireCapability(this.name, "memoryCandidateIndexRebuild", this.placement.capabilities.memoryCandidateIndexRebuild);
    return this.#call("rebuildMemoryCandidateIndex");
  }
  #recursive<T>(operation: string, args: readonly unknown[] = []): Promise<T> {
    requireCapability(this.name, "recursiveOperations", this.placement.capabilities.recursiveOperations);
    return this.#call(operation, args);
  }
}

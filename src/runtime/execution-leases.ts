import {
  CapabilityUnavailableError,
  ExecutionOwnershipConflictError,
  NotFoundError,
  ValidationError,
  newId,
} from "../domain/index.ts";
import type {
  AgentStorage,
  ProcessExecutionLeaseRecord,
  ProcessExecutionLeaseScope,
  ProcessExecutionLeaseStorageOperations,
  ProcessExecutionWriteFence,
} from "../storage/index.ts";
import type { NewAgentEvent } from "../domain/index.ts";

export interface ExecutionLeaseServiceOptions {
  /** A service-instance identity, not durable agent identity. */
  readonly ownerProcessId?: string;
  /** Defaults to the local store/profile device identity. */
  readonly ownerDeviceId?: string;
  readonly leaseMs?: number;
  /** Injectable wall clock used for every expiry/CAS decision. */
  readonly now?: () => Date;
}

/**
 * Process-local lifecycle facade over retained LibSQL lease rows.
 *
 * Every mutating call carries the current fence token. Callers must pass the
 * token onward to the execution path they fence; merely holding this object is
 * not proof of ownership after an expiry or takeover.
 */
export class ExecutionLeaseService {
  readonly ownerProcessId: string;
  readonly ownerDeviceId: string;
  readonly #storage: AgentStorage & ProcessExecutionLeaseStorageOperations;
  readonly #leaseMs: number;
  readonly #now: () => Date;

  constructor(storage: AgentStorage, options: ExecutionLeaseServiceOptions = {}) {
    if (!storage.capabilities.sameDeviceProcessFencing) {
      throw new CapabilityUnavailableError("same-device process execution fencing", storage.name);
    }
    const operations: Array<keyof ProcessExecutionLeaseStorageOperations> = [
      "getProcessExecutionLease", "claimProcessExecutionLease",
      "renewProcessExecutionLease", "releaseProcessExecutionLease",
    ];
    for (const operation of operations) {
      if (typeof storage[operation] !== "function") {
        throw new CapabilityUnavailableError(`same-device process execution fencing operation ${operation}`, storage.name);
      }
    }
    this.#storage = storage as AgentStorage & ProcessExecutionLeaseStorageOperations;
    this.ownerProcessId = options.ownerProcessId ?? `${process.pid}:${newId()}`;
    this.ownerDeviceId = options.ownerDeviceId ?? storage.deviceId ?? "";
    if (!this.ownerProcessId.trim()) throw new ValidationError("Execution lease owner process ID is required");
    if (!this.ownerDeviceId.trim()) {
      throw new CapabilityUnavailableError("stable device identity for process execution fencing", storage.name);
    }
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#assertLeaseMs(this.#leaseMs);
    this.#now = options.now ?? (() => new Date());
  }

  get(scope: ProcessExecutionLeaseScope): Promise<ProcessExecutionLeaseRecord | null> {
    return this.#storage.getProcessExecutionLease(scope);
  }

  claim(scope: ProcessExecutionLeaseScope, leaseMs = this.#leaseMs): Promise<ProcessExecutionLeaseRecord> {
    this.#assertLeaseMs(leaseMs);
    return this.#storage.claimProcessExecutionLease({
      scope,
      ownerDeviceId: this.ownerDeviceId,
      ownerProcessId: this.ownerProcessId,
      now: this.#timestamp(),
      leaseMs,
    });
  }

  renew(
    lease: ProcessExecutionLeaseRecord,
    leaseMs = this.#leaseMs,
  ): Promise<ProcessExecutionLeaseRecord> {
    this.#assertOwnedHandle(lease);
    this.#assertLeaseMs(leaseMs);
    return this.#storage.renewProcessExecutionLease({
      scope: lease.scope,
      ownerDeviceId: this.ownerDeviceId,
      ownerProcessId: this.ownerProcessId,
      fenceToken: lease.fenceToken,
      now: this.#timestamp(),
      leaseMs,
    });
  }

  release(lease: ProcessExecutionLeaseRecord): Promise<ProcessExecutionLeaseRecord> {
    this.#assertOwnedHandle(lease);
    return this.#storage.releaseProcessExecutionLease({
      scope: lease.scope,
      ownerDeviceId: this.ownerDeviceId,
      ownerProcessId: this.ownerProcessId,
      fenceToken: lease.fenceToken,
      now: this.#timestamp(),
    });
  }

  currentTimestamp(): string {
    return this.#timestamp();
  }

  #timestamp(): string {
    const value = this.#now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new ValidationError("Execution lease clock returned an invalid date");
    }
    return value.toISOString();
  }

  #assertLeaseMs(leaseMs: number): void {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new ValidationError("Execution lease duration must be a positive safe integer");
    }
  }

  #assertOwnedHandle(lease: ProcessExecutionLeaseRecord): void {
    if (lease.ownerDeviceId !== this.ownerDeviceId || lease.ownerProcessId !== this.ownerProcessId) {
      throw new ExecutionOwnershipConflictError("Execution lease handle belongs to another owner", {
        reason: "handle_owner_mismatch",
        requestedOwnerDeviceId: this.ownerDeviceId,
        requestedOwnerProcessId: this.ownerProcessId,
        handleOwnerDeviceId: lease.ownerDeviceId,
        handleOwnerProcessId: lease.ownerProcessId,
        fenceToken: lease.fenceToken,
      });
    }
  }
}


export interface ManagedExecutionLeaseCoordinatorOptions extends ExecutionLeaseServiceOptions {
  readonly workspaceId: string;
  /** Renewal defaults to one third of the lease duration. */
  readonly renewalIntervalMs?: number;
  readonly onLost?: (error: unknown) => void;
}

/**
 * Owns the one managed workspace service lease plus lazily acquired root-tree
 * leases. The corresponding fenced storage proxy presents fresh proofs at the
 * atomic LibSQL write boundary; a stale service can therefore execute code but
 * cannot commit canonical or outbox state after takeover.
 */
export class ManagedExecutionLeaseCoordinator {
  readonly service: ExecutionLeaseService;
  readonly workspaceId: string;
  readonly leaseMs: number;
  readonly renewalIntervalMs: number;
  #workspace: ProcessExecutionLeaseRecord;
  readonly #roots = new Map<string, ProcessExecutionLeaseRecord>();
  readonly #rootClaims = new Map<string, Promise<ProcessExecutionLeaseRecord>>();
  readonly #onLost: ((error: unknown) => void) | undefined;
  #timer: ReturnType<typeof setInterval> | null = null;
  #renewal: Promise<void> | null = null;
  #lost: unknown = null;
  #closed = false;

  private constructor(
    service: ExecutionLeaseService,
    workspaceId: string,
    workspace: ProcessExecutionLeaseRecord,
    leaseMs: number,
    renewalIntervalMs: number,
    onLost?: (error: unknown) => void,
  ) {
    this.service = service;
    this.workspaceId = workspaceId;
    this.#workspace = workspace;
    this.leaseMs = leaseMs;
    this.renewalIntervalMs = renewalIntervalMs;
    this.#onLost = onLost;
  }

  static async open(storage: AgentStorage, options: ManagedExecutionLeaseCoordinatorOptions): Promise<ManagedExecutionLeaseCoordinator> {
    if (!options.workspaceId.trim()) throw new ValidationError("Managed execution workspace ID is required");
    const leaseMs = options.leaseMs ?? 30_000;
    const renewalIntervalMs = options.renewalIntervalMs ?? Math.max(1, Math.floor(leaseMs / 3));
    if (!Number.isSafeInteger(renewalIntervalMs) || renewalIntervalMs < 1 || renewalIntervalMs >= leaseMs) {
      throw new ValidationError("Execution lease renewal interval must be positive and shorter than the lease");
    }
    const service = new ExecutionLeaseService(storage, options);
    const workspace = await service.claim({ kind: "workspace", workspaceId: options.workspaceId }, leaseMs);
    const coordinator = new ManagedExecutionLeaseCoordinator(
      service, options.workspaceId, workspace, leaseMs, renewalIntervalMs, options.onLost,
    );
    coordinator.#timer = setInterval(() => {
      void coordinator.refreshIfNeeded(true).catch(() => {});
    }, renewalIntervalMs);
    return coordinator;
  }

  get ownerProcessId(): string { return this.service.ownerProcessId; }
  get ownerDeviceId(): string { return this.service.ownerDeviceId; }
  get lost(): boolean { return this.#lost !== null; }
  get rootSessionIds(): readonly string[] { return [...this.#roots.keys()].sort(); }

  async fenceForEvents(events: readonly NewAgentEvent[]): Promise<ProcessExecutionWriteFence> {
    await this.refreshIfNeeded();
    this.#assertLive();
    if (!events.length) throw new ValidationError("Cannot fence an empty event append");
    const rootIds = new Set<string>();
    const stagedRoots = new Map(events
      .filter((event) => event.type === "SessionCreated")
      .map((event) => {
        const payload = event.payload as { parentSessionId?: string; rootSessionId?: string };
        return [event.sessionId, payload.parentSessionId ? payload.rootSessionId : event.sessionId] as const;
      }));
    let onlyNewRoot = true;
    for (const event of events) {
      if (event.type === "SessionCreated") {
        const payload = event.payload as { parentSessionId?: string; rootSessionId?: string };
        const root = payload.parentSessionId ? payload.rootSessionId : event.sessionId;
        if (!root) throw new ValidationError("Child SessionCreated is missing rootSessionId");
        rootIds.add(root);
        if (payload.parentSessionId) onlyNewRoot = false;
      } else {
        onlyNewRoot = false;
        const stagedRoot = stagedRoots.get(event.sessionId);
        if (stagedRoot) rootIds.add(stagedRoot);
        else rootIds.add(await this.#rootForSession(event.sessionId));
      }
    }
    if (rootIds.size !== 1) throw new ExecutionOwnershipConflictError("One fenced append cannot cross root trees", { reason: "cross_root_write", roots: [...rootIds].sort() });
    const workspace = this.#proof(this.#workspace);
    const rootSessionId = [...rootIds][0]!;
    if (onlyNewRoot && events.every(event => event.type === "SessionCreated" && event.sessionId === rootSessionId)) return { workspace };
    const root = await this.ensureRoot(rootSessionId);
    return { workspace, root: this.#proof(root) };
  }

  #storage: AgentStorage | null = null;
  attachStorage(storage: AgentStorage): void {
    if (this.#storage && this.#storage !== storage) throw new ValidationError("Managed execution coordinator storage is already attached");
    this.#storage = storage;
  }

  async fenceForSession(sessionId: string): Promise<ProcessExecutionWriteFence> {
    await this.refreshIfNeeded();
    this.#assertLive();
    const rootId = await this.#rootForSession(sessionId);
    const root = await this.ensureRoot(rootId);
    return { workspace: this.#proof(this.#workspace), root: this.#proof(root) };
  }

  async ensureRoot(rootSessionId: string): Promise<ProcessExecutionLeaseRecord> {
    await this.refreshIfNeeded();
    this.#assertLive();
    const retained = this.#roots.get(rootSessionId);
    if (retained) return retained;
    const inflight = this.#rootClaims.get(rootSessionId);
    if (inflight) return inflight;
    const claim = this.service.claim({ kind: "root", rootSessionId }, this.leaseMs)
      .then((lease) => { this.#roots.set(rootSessionId, lease); return lease; })
      .finally(() => this.#rootClaims.delete(rootSessionId));
    this.#rootClaims.set(rootSessionId, claim);
    return claim;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#renewal?.catch(() => {});
    await Promise.allSettled([...this.#rootClaims.values()]);
    for (const lease of [...this.#roots.values()].reverse()) await this.service.release(lease).catch(() => {});
    await this.service.release(this.#workspace).catch(() => {});
    this.#roots.clear();
  }

  async #rootForSession(sessionId: string): Promise<string> {
    const storage = this.#storage;
    if (!storage?.getSession) throw new CapabilityUnavailableError("root-session resolution for managed fencing", storage?.name ?? "unattached storage");
    const session = await storage.getSession(sessionId);
    if (!session) throw new NotFoundError("session", sessionId);
    if (session.workspaceId !== this.workspaceId) throw new ExecutionOwnershipConflictError("Session belongs to another managed workspace", { reason: "workspace_mismatch", sessionId });
    return session.rootSessionId;
  }

  #proof(lease: ProcessExecutionLeaseRecord): import("../storage/index.ts").ProcessExecutionLeaseProof {
    return {
      scope: lease.scope,
      ownerDeviceId: lease.ownerDeviceId,
      ownerProcessId: lease.ownerProcessId,
      fenceToken: lease.fenceToken,
      now: new Date().toISOString(),
    };
  }

  async refreshIfNeeded(force = false): Promise<void> {
    this.#assertLive();
    const remainingMs = Date.parse(this.#workspace.leaseExpiresAt) -
      Date.parse(this.service.currentTimestamp());
    if (!force && remainingMs > this.renewalIntervalMs) return;
    if (this.#renewal) return this.#renewal;
    const renewal = (async () => {
      this.#workspace = await this.service.renew(this.#workspace, this.leaseMs);
      for (const [rootId, lease] of this.#roots) {
        this.#roots.set(
          rootId,
          await this.service.renew(lease, this.leaseMs),
        );
      }
    })();
    this.#renewal = renewal;
    try {
      await renewal;
    } catch (error) {
      this.#lost = error;
      if (this.#timer) clearInterval(this.#timer);
      this.#timer = null;
      this.#onLost?.(error);
      throw error;
    } finally {
      if (this.#renewal === renewal) this.#renewal = null;
    }
  }

  #assertLive(): void {
    if (this.#closed) throw new ExecutionOwnershipConflictError("Managed execution owner is closed", { reason: "owner_closed" });
    if (this.#lost) throw new ExecutionOwnershipConflictError("Managed execution lease was lost", { reason: "lease_lost" });
  }
}

/** Returns an AgentStorage facade that supplies atomic write fences automatically. */
export function createFencedAgentStorage<T extends AgentStorage>(storage: T, coordinator: ManagedExecutionLeaseCoordinator): T {
  coordinator.attachStorage(storage);
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === "appendEvents") return async (events: readonly NewAgentEvent[]) =>
        target.appendEvents(events, await coordinator.fenceForEvents(events));
      if (property === "claimEffect") return async (effectId: string, owner: string, leaseMs?: number) => {
        const record = await target.getOutbox(effectId);
        if (!record) return null;
        return target.claimEffect(effectId, owner, leaseMs, await coordinator.fenceForSession(record.sessionId));
      };
      if (property === "resetOutbox") return async (effectId: string) => {
        const record = await target.getOutbox(effectId);
        if (!record) return;
        return target.resetOutbox(effectId, await coordinator.fenceForSession(record.sessionId));
      };
      if (property === "claimOutbox") return async () => {
        throw new CapabilityUnavailableError("unscoped outbox claiming under managed execution fencing", target.name);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

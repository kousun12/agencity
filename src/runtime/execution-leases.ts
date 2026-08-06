import {
  CapabilityUnavailableError,
  ExecutionOwnershipConflictError,
  ValidationError,
  newId,
} from "../domain/index.ts";
import type {
  AgentStorage,
  ProcessExecutionLeaseRecord,
  ProcessExecutionLeaseScope,
  ProcessExecutionLeaseStorageOperations,
} from "../storage/index.ts";

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

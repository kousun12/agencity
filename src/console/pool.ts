import { ConsoleCapacityError, ValidationError } from "../domain/index.ts";
import {
  ConsoleProcess,
  type ConsoleExecution,
  type ConsoleProcessOptions,
  type ConsoleRpcHandler,
} from "./process.ts";
import type { ScratchScope } from "./scratch.ts";

// One caller plus the largest public runMany batch (16). Larger concurrent
// families fail visibly instead of eagerly retaining dozens of Bun processes.
export const DEFAULT_MAX_CONSOLE_RESIDENT_PROCESSES = 17;
export const DEFAULT_MAX_CONSOLE_ACTIVE_EXECUTIONS = 4;

type Release = () => void;

interface BranchWorker {
  readonly scope: ScratchScope;
  readonly process: ConsoleProcess;
  busy: number;
  resident: boolean;
  lastUsedAt: number;
}

interface ResidentWaiter {
  readonly scope: ScratchScope;
  readonly resolve: (worker: BranchWorker) => void;
  readonly reject: (error: Error) => void;
}

interface ResidentReservationSlot {
  key: string;
  released: boolean;
}

export interface ConsoleExecutionPoolOptions extends ConsoleProcessOptions {
  readonly maxResidentProcesses?: number;
  readonly maxActiveExecutions?: number;
}

export interface ConsoleExecutionPoolStatus {
  readonly residentProcesses: number;
  readonly activeExecutions: number;
  readonly queuedExecutions: number;
  readonly reservedProcesses: number;
  readonly maxResidentProcesses: number;
  readonly maxActiveExecutions: number;
}

export interface ConsoleResidentReservation {
  release(): Promise<void>;
}

class AsyncPermitPool {
  readonly #waiters: Array<{
    readonly resolve: (release: Release) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  #active = 0;
  #closed = false;

  constructor(readonly limit: number) {}

  get active(): number {
    return this.#active;
  }

  async acquire(): Promise<Release> {
    if (this.#closed) throw new ValidationError("Console execution pool is closed");
    if (this.#active < this.limit) return this.#grant();
    return new Promise<Release>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new ValidationError("Console execution pool is closed");
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  #grant(): Release {
    this.#active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(this.#grant());
    };
  }
}

/**
 * Bounds disposable Bun workers independently from generated-JavaScript
 * execution. A worker is pinned to one exact session/branch for its lifetime.
 */
export class ConsoleExecutionPool {
  readonly maxResidentProcesses: number;
  readonly maxActiveExecutions: number;
  readonly #processOptions: ConsoleProcessOptions;
  readonly #workers = new Map<string, BranchWorker>();
  readonly #residentWaiters: ResidentWaiter[] = [];
  readonly #active: AsyncPermitPool;
  readonly #mutations = new SerialQueue();
  readonly #scopeReservations = new Map<string, Set<ResidentReservationSlot>>();
  readonly #operations = new Set<Promise<void>>();
  readonly #retiredRpcDrains = new Set<Promise<void>>();
  #closed = false;
  #lastRecycleReason: string | null = null;
  #stopPromise: Promise<void> | null = null;

  constructor(options: ConsoleExecutionPoolOptions = {}) {
    this.maxResidentProcesses = options.maxResidentProcesses ??
      DEFAULT_MAX_CONSOLE_RESIDENT_PROCESSES;
    this.maxActiveExecutions = options.maxActiveExecutions ??
      DEFAULT_MAX_CONSOLE_ACTIVE_EXECUTIONS;
    assertPositiveInteger(this.maxResidentProcesses, "resident-process limit");
    assertPositiveInteger(this.maxActiveExecutions, "active-execution limit");
    this.#processOptions = {
      ...(options.scratchCheckpointTimeoutMs === undefined
        ? {}
        : { scratchCheckpointTimeoutMs: options.scratchCheckpointTimeoutMs }),
      ...(options.scratchIdleScopeMs === undefined
        ? {}
        : { scratchIdleScopeMs: options.scratchIdleScopeMs }),
      ...(options.scratchMaxWarmScopes === undefined
        ? {}
        : { scratchMaxWarmScopes: options.scratchMaxWarmScopes }),
    };
    this.#active = new AsyncPermitPool(this.maxActiveExecutions);
  }

  /** Compatibility summary for existing diagnostics. */
  status(): { readonly running: boolean; readonly lastRecycleReason: string | null } {
    return {
      running: this.#residentCount() > 0,
      lastRecycleReason: this.#lastRecycleReason,
    };
  }

  capacityStatus(): ConsoleExecutionPoolStatus {
    return {
      residentProcesses: this.#residentCount(),
      activeExecutions: this.#active.active,
      queuedExecutions: this.#residentWaiters.length,
      reservedProcesses: this.#reservationCommitmentCount(),
      maxResidentProcesses: this.maxResidentProcesses,
      maxActiveExecutions: this.maxActiveExecutions,
    };
  }

  async run<T>(
    scope: ScratchScope,
    operation: (process: ConsoleProcess) => Promise<T>,
  ): Promise<T> {
    let settleOperation!: () => void;
    const operationSettled = new Promise<void>((resolve) => {
      settleOperation = resolve;
    });
    this.#operations.add(operationSettled);
    let acquired = false;
    try {
      const worker = await this.#acquireWorker(scope);
      acquired = true;
      return await operation(worker.process);
    } finally {
      settleOperation();
      this.#operations.delete(operationSettled);
      if (acquired) await this.#releaseWorker(scope);
    }
  }

  async execute(
    process: ConsoleProcess,
    code: string,
    session: { readonly id: string; readonly branchId: string },
    restored: Record<string, unknown>,
    handler: ConsoleRpcHandler,
  ): Promise<ConsoleExecution> {
    let releaseActive: Release | null = await this.#active.acquire();
    let reacquiring: Promise<void> | null = null;
    let executionEnded = false;
    const ensureActive = (): Promise<void> => {
      if (releaseActive || executionEnded) return Promise.resolve();
      if (!reacquiring) {
        reacquiring = this.#active.acquire().then((acquired) => {
          if (executionEnded) acquired();
          else releaseActive = acquired;
        }).finally(() => {
          reacquiring = null;
        });
      }
      return reacquiring;
    };
    const wrapped: ConsoleRpcHandler = async (method, args) => {
      if (releaseActive) {
        releaseActive();
        releaseActive = null;
      }
      try {
        return await handler(method, args);
      } finally {
        // Concurrent RPC completions must share one reacquisition. If each
        // queued independently, the first result could resume a Promise.all
        // while the second remained blocked behind the permit it now holds.
        await ensureActive();
      }
    };
    try {
      return await process.execute(code, session, restored, wrapped);
    } finally {
      executionEnded = true;
      releaseActive?.();
      releaseActive = null;
      const pendingReacquisition = reacquiring as Promise<void> | null;
      await pendingReacquisition?.catch(() => {});
    }
  }

  async reserveAwaited(
    scopes: readonly ScratchScope[],
  ): Promise<ConsoleResidentReservation> {
    if (scopes.length < 1) {
      throw new ValidationError("Awaited console reservation scopes cannot be empty");
    }
    const slots = scopes.map((scope): ResidentReservationSlot => ({
      key: scopeKey(scope),
      released: false,
    }));
    await this.#mutations.run(async () => {
      this.#assertOpen();
      this.#pruneStoppedWorkers();
      const addedKeys = new Set<string>();
      for (const slot of slots) {
        if (!this.#scopeReservations.has(slot.key) &&
            !this.#isBusyResident(slot.key)) {
          addedKeys.add(slot.key);
        }
      }
      const available = this.maxResidentProcesses -
        this.#capacityCommitmentCount();
      if (available < addedKeys.size) {
        throw new ConsoleCapacityError({
          requestedResidentProcesses: addedKeys.size,
          availableResidentProcesses: Math.max(0, available),
          maxResidentProcesses: this.maxResidentProcesses,
          residentProcesses: this.#residentCount(),
          reservedProcesses: this.#reservationCommitmentCount(),
        });
      }
      for (const slot of slots) this.#registerScopeReservation(slot);
      try {
        await this.#retireIdleToFitClaims();
      } catch (error) {
        for (const slot of slots) this.#unregisterScopeReservation(slot);
        throw error;
      }
    });

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await this.#mutations.run(async () => {
          for (const slot of slots) {
            if (slot.released) continue;
            slot.released = true;
            this.#unregisterScopeReservation(slot);
          }
          await this.#serviceWaiters();
        });
      },
    };
  }

  async recycleScope(scope: ScratchScope, reason: string): Promise<void> {
    await this.#mutations.run(async () => {
      if (this.#closed) return;
      const worker = this.#workers.get(scopeKey(scope));
      if (!worker?.resident) return;
      await worker.process.recycle(reason);
      worker.resident = false;
      this.#lastRecycleReason = worker.process.status().lastRecycleReason ?? reason;
      await this.#serviceWaiters();
    });
  }

  /** Stops replaceable idle workers so service quiescence can be reached. */
  async retireIdleWorkers(): Promise<number> {
    return this.#mutations.run(async () => {
      if (this.#closed) return 0;
      const idle = [...this.#workers.values()].filter((worker) =>
        worker.resident && worker.busy === 0 &&
        !this.#scopeReservations.has(scopeKey(worker.scope))
      );
      for (const worker of idle) await this.#stopWorker(worker);
      await this.#serviceWaiters();
      return idle.length;
    });
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stopAll();
    return this.#stopPromise;
  }

  async #stopAll(): Promise<void> {
    let workers: BranchWorker[] = [];
    await this.#mutations.run(async () => {
      if (this.#closed) return;
      this.#closed = true;
      const error = new ValidationError("Console execution pool is closed");
      for (const waiter of this.#residentWaiters.splice(0)) waiter.reject(error);
      this.#active.close();
      workers = [...this.#workers.values()];
      this.#scopeReservations.clear();
    });
    await Promise.allSettled(workers.map((worker) => worker.process.close()));
    // Let affected executeCell calls commit their explicit interrupted
    // outcomes, and let already-admitted durable RPC work settle, before
    // Supervisor closes canonical storage.
    await Promise.allSettled([
      ...this.#operations,
      ...workers.map((worker) => worker.process.drainRpcOperations()),
    ]);
    while (this.#retiredRpcDrains.size > 0) {
      await Promise.allSettled([...this.#retiredRpcDrains]);
    }
    await this.#mutations.run(async () => {
      for (const worker of this.#workers.values()) worker.resident = false;
      this.#workers.clear();
    });
  }

  async #acquireWorker(scope: ScratchScope): Promise<BranchWorker> {
    return new Promise<BranchWorker>((resolve, reject) => {
      void this.#mutations.run(async () => {
        try {
          this.#assertOpen();
          const worker = await this.#tryAcquire(scope);
          if (worker) resolve(worker);
          else this.#residentWaiters.push({ scope, resolve, reject });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  async #tryAcquire(scope: ScratchScope): Promise<BranchWorker | null> {
    this.#pruneStoppedWorkers();
    const key = scopeKey(scope);
    let worker = this.#workers.get(key);
    if (worker?.resident && worker.process.status().running) {
      if (!this.#isBusyResident(key) &&
          !this.#scopeReservations.has(key) &&
          this.#capacityCommitmentCount() >= this.maxResidentProcesses) {
        return null;
      }
      worker.busy++;
      return worker;
    }
    if (worker?.resident) worker.resident = false;

    if (!this.#scopeReservations.has(key) &&
        this.#capacityCommitmentCount() >= this.maxResidentProcesses) {
      return null;
    }
    await this.#retireIdleForPhysicalSlot();
    if (this.#residentCount() >= this.maxResidentProcesses) return null;

    worker ??= {
      scope,
      process: new ConsoleProcess(undefined, this.#processOptions),
      busy: 0,
      resident: false,
      lastUsedAt: Date.now(),
    };
    this.#workers.set(key, worker);
    try {
      await worker.process.start();
      worker.resident = true;
      worker.busy++;
      worker.lastUsedAt = Date.now();
      return worker;
    } catch (error) {
      worker.resident = false;
      if (this.#workers.get(key) === worker) this.#workers.delete(key);
      throw error;
    }
  }

  async #retireIdleToFitClaims(): Promise<void> {
    let deficit = this.#residentCount() + this.#missingReservationCount() -
      this.maxResidentProcesses;
    if (deficit <= 0) return;
    const idle = [...this.#workers.values()]
      .filter((worker) => worker.resident && worker.busy === 0 &&
        !this.#scopeReservations.has(scopeKey(worker.scope)))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt ||
        scopeKey(left.scope).localeCompare(scopeKey(right.scope)));
    for (const worker of idle) {
      if (deficit <= 0) break;
      await this.#stopWorker(worker);
      deficit--;
    }
  }

  async #retireIdleForPhysicalSlot(): Promise<void> {
    if (this.#residentCount() < this.maxResidentProcesses) return;
    const worker = [...this.#workers.values()]
      .filter((candidate) => candidate.resident && candidate.busy === 0 &&
        !this.#scopeReservations.has(scopeKey(candidate.scope)))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt ||
        scopeKey(left.scope).localeCompare(scopeKey(right.scope)))[0];
    if (worker) await this.#stopWorker(worker);
  }

  async #stopWorker(worker: BranchWorker): Promise<void> {
    await worker.process.stop();
    worker.resident = false;
    const key = scopeKey(worker.scope);
    if (worker.busy === 0 && this.#workers.get(key) === worker) {
      this.#workers.delete(key);
    }
    this.#lastRecycleReason =
      worker.process.status().lastRecycleReason ?? this.#lastRecycleReason;
  }

  async #serviceWaiters(): Promise<void> {
    for (let index = 0; index < this.#residentWaiters.length;) {
      const waiter = this.#residentWaiters[index]!;
      try {
        const worker = await this.#tryAcquire(waiter.scope);
        if (!worker) {
          index++;
          continue;
        }
        this.#residentWaiters.splice(index, 1);
        waiter.resolve(worker);
      } catch (error) {
        this.#residentWaiters.splice(index, 1);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #residentCount(): number {
    let count = 0;
    for (const worker of this.#workers.values()) {
      if (worker.resident && worker.process.status().running) count++;
    }
    return count;
  }

  #isBusyResident(key: string): boolean {
    const worker = this.#workers.get(key);
    return Boolean(worker?.resident && worker.process.status().running &&
      worker.busy > 0);
  }

  #capacityCommitmentCount(): number {
    const keys = new Set(this.#scopeReservations.keys());
    for (const [key, worker] of this.#workers) {
      if (worker.resident && worker.process.status().running && worker.busy > 0) {
        keys.add(key);
      }
    }
    return keys.size;
  }

  #reservationCommitmentCount(): number {
    return this.#scopeReservations.size;
  }

  #missingReservationCount(): number {
    let count = 0;
    for (const key of this.#scopeReservations.keys()) {
      const worker = this.#workers.get(key);
      if (!worker?.resident || !worker.process.status().running) count++;
    }
    return count;
  }

  #registerScopeReservation(slot: ResidentReservationSlot): void {
    const reservations = this.#scopeReservations.get(slot.key) ?? new Set();
    reservations.add(slot);
    this.#scopeReservations.set(slot.key, reservations);
  }

  #unregisterScopeReservation(slot: ResidentReservationSlot): void {
    const reservations = this.#scopeReservations.get(slot.key);
    if (!reservations) return;
    reservations.delete(slot);
    if (reservations.size === 0) this.#scopeReservations.delete(slot.key);
  }

  async #releaseWorker(scope: ScratchScope): Promise<void> {
    await this.#mutations.run(async () => {
      const key = scopeKey(scope);
      const worker = this.#workers.get(key);
      if (!worker) return;
      worker.busy = Math.max(0, worker.busy - 1);
      worker.lastUsedAt = Date.now();
      if (!worker.process.status().running) {
        worker.resident = false;
        this.#lastRecycleReason =
          worker.process.status().lastRecycleReason ?? this.#lastRecycleReason;
      }
      if (!worker.resident && worker.busy === 0 &&
          this.#workers.get(key) === worker) {
        this.#workers.delete(key);
        this.#trackRetiredRpcDrain(worker.process);
      }
      await this.#serviceWaiters();
    });
  }

  #pruneStoppedWorkers(): void {
    for (const [key, worker] of this.#workers) {
      if (worker.busy === 0 &&
          (!worker.resident || !worker.process.status().running)) {
        worker.resident = false;
        this.#workers.delete(key);
      }
    }
  }

  #trackRetiredRpcDrain(process: ConsoleProcess): void {
    let drain!: Promise<void>;
    drain = process.drainRpcOperations().finally(() => {
      this.#retiredRpcDrains.delete(drain);
    });
    this.#retiredRpcDrains.add(drain);
  }

  #assertOpen(): void {
    if (this.#closed) throw new ValidationError("Console execution pool is closed");
  }
}

class SerialQueue {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function scopeKey(scope: ScratchScope): string {
  return `${scope.sessionId.length}:${scope.sessionId}${scope.branchId}`;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError(`Console ${label} must be a positive integer`);
  }
}

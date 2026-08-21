import { join } from "node:path";
import {
  NotFoundError,
  ValidationError,
  projectEvents,
  type AgentState,
  type JsonValue,
  type ManagedProcessState,
  type NewAgentEvent,
} from "../domain/index.ts";
import {
  MANAGED_PROCESS_EXECUTOR,
  ManagedProcessExecutor,
} from "../executors/managed-process.ts";
import type { AgentStorage, OutboxRecord } from "../storage/index.ts";
import { containsBrokeredSecret } from "../security/index.ts";
import { OutboxRunner, stableEffectId } from "./outbox.ts";
import { ProjectionService } from "./projection.ts";

export interface ManagedProcessStartInput {
  readonly command: string;
  readonly cwd?: string;
  readonly idempotencyKey?: string;
}

export interface ManagedProcessHandle {
  readonly processId: string;
  readonly effectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly runId: string | null;
  readonly cellId: string;
  readonly status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "unknown";
}

export interface ManagedProcessInspection extends ManagedProcessHandle {
  readonly command: string;
  readonly cwd: string | null;
  readonly pid: number | null;
  readonly processGroupId: number | null;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly stopFailureCount: number;
  readonly stopFailure?: {
    readonly attempt: number;
    readonly reason: string;
    readonly error: string;
    readonly processGroupIds: number[];
    readonly survivingProcessGroupIds: number[];
    readonly attemptedAt: string;
  };
  readonly output?: JsonValue;
  readonly error?: string;
}

export class ManagedProcessService {
  readonly #projections: ProjectionService;
  #accepting = true;

  constructor(
    readonly storage: AgentStorage,
    readonly outbox: OutboxRunner,
    readonly executor: ManagedProcessExecutor,
  ) {
    this.#projections = new ProjectionService(storage);
  }

  get activeCount(): number {
    return this.executor.activeCount;
  }

  stopAdmission(): void {
    this.#accepting = false;
    this.executor.stopAdmission();
  }

  async start(
    sessionId: string,
    branchId: string,
    cellId: string,
    input: ManagedProcessStartInput,
    fallbackIdempotencyKey: string,
  ): Promise<ManagedProcessHandle> {
    if (!this.#accepting) {
      throw new ValidationError(
        "Managed process service is not accepting new processes",
      );
    }
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        typeof input.command !== "string" || !input.command.trim()) {
      throw new ValidationError(
        "processes.start requires a non-empty command",
      );
    }
    if (input.cwd !== undefined && typeof input.cwd !== "string") {
      throw new ValidationError("Managed process cwd must be a string");
    }
    if (input.idempotencyKey !== undefined &&
        (typeof input.idempotencyKey !== "string" ||
         !input.idempotencyKey.trim())) {
      throw new ValidationError(
        "Managed process idempotency key must be non-empty",
      );
    }
    if (containsBrokeredSecret(input.command) ||
        input.cwd !== undefined && containsBrokeredSecret(input.cwd) ||
        input.idempotencyKey !== undefined &&
          containsBrokeredSecret(input.idempotencyKey)) {
      throw new ValidationError(
        "Brokered credentials cannot enter managed process requests",
      );
    }
    const state = await this.#state(sessionId, branchId);
    const cell = state.cells[cellId];
    if (!cell || !["proposed", "running"].includes(cell.status)) {
      throw new ValidationError(
        "Managed processes may only be started by the active originating cell",
      );
    }
    const idempotencyKey = input.idempotencyKey ?? fallbackIdempotencyKey;
    const effectId = stableEffectId(sessionId, idempotencyKey);
    const retained = await this.storage.getOutbox(effectId);
    if (retained) {
      const retainedInput = retained.input as Record<string, JsonValue>;
      if (retained.sessionId !== sessionId ||
          retained.branchId !== branchId ||
          retained.executor !== MANAGED_PROCESS_EXECUTOR ||
          retained.operation !== "start" ||
          retained.origin.kind !== "cell" ||
          retained.origin.cellId !== cellId ||
          retainedInput.command !== input.command ||
          (retainedInput.cwd ?? undefined) !== input.cwd) {
        throw new ValidationError(
          "Managed process idempotency key was reused with different intent",
        );
      }
      void this.outbox.run(effectId).catch(() => {});
      return this.inspect(sessionId, branchId,
        String(retainedInput.processId));
    }

    const processId = `process-${effectId.slice("effect-".length, 38)}`;
    const identityToken = randomIdentityToken();
    const runId = runForCell(state, cellId);
    const effectEvent = this.outbox.requestEvent({
      sessionId,
      branchId,
      executor: MANAGED_PROCESS_EXECUTOR,
      operation: "start",
      input: {
        processId,
        command: input.command,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        identityToken,
      },
      origin: { kind: "cell", cellId },
      idempotencyKey,
      idempotent: false,
    });
    const processEvent: NewAgentEvent<"ManagedProcessRegistered"> = {
      sessionId,
      branchId,
      type: "ManagedProcessRegistered",
      producer: "supervisor",
      idempotencyKey: `managed-process-registered:${processId}`,
      payload: {
        processId,
        effectId,
        workspaceId: state.workspaceId,
        ...(runId === null ? {} : { runId }),
        cellId,
        command: input.command,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        identityToken,
        requestedAt: new Date().toISOString(),
      },
    };
    await this.storage.appendEvents([effectEvent, processEvent]);
    void this.outbox.run(effectId).catch(() => {});
    const admitted = await this.#projections.waitForTerminal(
      sessionId,
      branchId,
      (candidate) =>
        candidate.managedProcesses[processId]?.status !== "queued",
      { timeoutMs: 2_000 },
    );
    const process = admitted.state.managedProcesses[processId];
    if (!process) throw new Error("Managed process registration was lost");
    return handle(process);
  }

  async inspect(
    sessionId: string,
    branchId: string,
    target: string | Pick<ManagedProcessHandle, "processId">,
  ): Promise<ManagedProcessInspection> {
    const processId = targetId(target);
    const process = (await this.#state(sessionId, branchId))
      .managedProcesses[processId];
    if (!process) throw new NotFoundError("managed process", processId);
    return inspection(process);
  }

  async list(
    sessionId: string,
    branchId: string,
  ): Promise<ManagedProcessInspection[]> {
    const state = await this.#state(sessionId, branchId);
    return Object.values(state.managedProcesses)
      .sort((left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) ||
        left.id.localeCompare(right.id))
      .map(inspection);
  }

  async readLogs(
    sessionId: string,
    branchId: string,
    target: string | Pick<ManagedProcessHandle, "processId">,
  ): Promise<JsonValue> {
    const process = await this.inspect(sessionId, branchId, target);
    const active = this.executor.readActiveLogs(process.processId);
    if (active !== null) return active;
    if (process.output !== undefined) return process.output;
    if (process.status === "unknown") {
      return {
        protocol: "agencity.bounded-output.v1",
        completeness: "refused",
        byteLength: 0,
        reason: "managed-process-output-unknown",
        guidance:
          "Process ownership was lost before complete scrubbed logs reached a durable boundary.",
      };
    }
    return {
      protocol: "agencity.bounded-output.v1",
      completeness: "inline",
      byteLength: 0,
      value: { stdout: "", stderr: "" },
    };
  }

  async stop(
    sessionId: string,
    branchId: string,
    target: string | Pick<ManagedProcessHandle, "processId">,
    reason = "Stopped by agent",
  ): Promise<ManagedProcessInspection> {
    if (typeof reason !== "string" || !reason.trim() ||
        reason.length > 16_384) {
      throw new ValidationError(
        "Managed process stop reason must be non-empty and at most 16384 characters",
      );
    }
    if (containsBrokeredSecret(reason)) {
      throw new ValidationError(
        "Brokered credentials cannot enter managed process stop reasons",
      );
    }
    const current = await this.inspect(sessionId, branchId, target);
    if (!["queued", "running"].includes(current.status)) return current;
    if (current.status === "queued") {
      const cancelled = await this.outbox.cancelBeforeExecution(
        current.effectId,
        reason,
      );
      if (!cancelled) {
        const stopped = await this.executor.stop(current.processId, reason);
        if (!stopped) this.outbox.cancel(current.effectId);
      }
    } else {
      await this.executor.stop(current.processId, reason);
    }
    const terminal = await this.#projections.waitForTerminal(
      sessionId,
      branchId,
      (state) => {
        const process = state.managedProcesses[current.processId];
        return process !== undefined &&
          !["queued", "running"].includes(process.status);
      },
      { timeoutMs: 5_000 },
    );
    const process = terminal.state.managedProcesses[current.processId];
    if (!process || ["queued", "running"].includes(process.status)) {
      throw new Error(
        `Managed process ${current.processId} did not stop durably`,
      );
    }
    return inspection(process);
  }

  async cancelRun(
    sessionId: string,
    branchId: string,
    runId: string,
    reason = "Originating run cancelled",
  ): Promise<void> {
    const state = await this.#state(sessionId, branchId);
    await Promise.all(Object.values(state.managedProcesses)
      .filter((process) => process.runId === runId &&
        ["queued", "running"].includes(process.status))
      .map(async (process) => {
        await this.stop(sessionId, branchId, process.id, reason);
      }));
  }

  async recover(): Promise<string[]> {
    const recovered: string[] = [];
    const unresolved = await this.storage.listOutbox([
      "pending",
      "running",
    ]);
    for (const record of unresolved) {
      if (record.executor !== MANAGED_PROCESS_EXECUTOR) continue;
      // A never-claimed request did not spawn, but its originating cell owner
      // disappeared. Cancel it rather than starting detached work after restart.
      if (record.status === "pending" && record.attempt === 0) {
        if (!await this.outbox.cancelBeforeExecution(
          record.effectId,
          "Managed process request was cancelled because its originating execution ended before spawn",
          "recovery",
        )) {
          throw new Error(
            `Queued managed process ${record.effectId} could not be cancelled during recovery`,
          );
        }
        const input = record.input as Record<string, JsonValue>;
        if (typeof input.processId === "string") recovered.push(input.processId);
        continue;
      }
      const process = await this.#processForRecord(record);
      const input = record.input as Record<string, JsonValue>;
      const processId = process?.id ??
        (typeof input.processId === "string" ? input.processId : null);
      const identityToken = process?.identityToken ??
        (typeof input.identityToken === "string"
          ? input.identityToken
          : null);
      if (!processId || !identityToken) {
        throw new ValidationError(
          `Running managed process effect ${record.effectId} lacks recovery identity`,
        );
      }
      const termination = await this.executor.terminateRecovered(
        process?.processGroupId ?? null,
        identityToken,
      );
      if (termination.found && !termination.terminated) {
        if (process?.status === "running") {
          const attempt = process.stopFailureCount + 1;
          await this.storage.appendEvents([{
            sessionId: record.sessionId,
            branchId: record.branchId,
            type: "ManagedProcessStopFailed",
            producer: "recovery",
            idempotencyKey:
              `managed-process-recovery-stop-failed:${processId}:${attempt}`,
            payload: {
              processId,
              effectId: record.effectId,
              attempt,
              reason: "Managed process recovery cleanup",
              error: termination.error ??
                "Authenticated process groups survived recovery cleanup",
              processGroupIds: termination.processGroupIds,
              survivingProcessGroupIds:
                termination.survivingProcessGroupIds,
              attemptedAt: new Date().toISOString(),
            },
          } satisfies NewAgentEvent<"ManagedProcessStopFailed">]);
        }
        throw new Error(
          `Recovered managed process ${processId} could not be terminated${
            termination.error ? `: ${termination.error}` : ""
          }`,
        );
      }
      const output = await this.executor.recoveryLogs(processId);
      await this.storage.appendEvents([{
        sessionId: record.sessionId,
        branchId: record.branchId,
        type: "EffectOutcomeRecorded",
        producer: "recovery",
        idempotencyKey:
          `managed-process-recovery-unknown:${record.effectId}`,
        payload: {
          effectId: record.effectId,
          attempt: Math.max(1, record.attempt),
          outcome: "unknown",
          ...(output === undefined ? {} : { output }),
          error: termination.found
            ? "Managed process ownership was lost; its authenticated process group was terminated and its outcome is unknown"
            : "Managed process ownership was lost and its outcome is unknown",
          observedAt: new Date().toISOString(),
        },
      }]);
      await this.executor.removeLogs(processId);
      recovered.push(processId);
    }
    return recovered;
  }

  async shutdown(): Promise<void> {
    this.stopAdmission();
    await this.executor.shutdown();
    const admitted = (await this.storage.listOutbox([
      "pending",
      "running",
    ])).filter((record) => record.executor === MANAGED_PROCESS_EXECUTOR);
    await this.outbox.waitForInflight(
      admitted.map((record) => record.effectId),
      5_000,
    );
    const unresolved = (await this.storage.listOutbox([
      "pending",
      "running",
    ])).filter((record) => record.executor === MANAGED_PROCESS_EXECUTOR);
    for (const record of unresolved) {
      if (record.status === "pending" && record.attempt === 0) {
        await this.outbox.cancelBeforeExecution(
          record.effectId,
          "Managed service shutdown ended the queued process before spawn",
          "supervisor",
        );
      }
    }
    await this.recover();
    const remaining = (await this.storage.listOutbox([
      "pending",
      "running",
    ])).filter((record) => record.executor === MANAGED_PROCESS_EXECUTOR);
    if (!remaining.length && this.executor.activeCount === 0) return;
    throw new Error(
      "Managed process outcomes did not become durable during shutdown: " +
        remaining.map((record) => record.effectId).join(", "),
    );
  }

  async #state(sessionId: string, branchId: string): Promise<AgentState> {
    return (await this.#projections.getSnapshot(sessionId, branchId)).state;
  }

  async #processForRecord(
    record: OutboxRecord,
  ): Promise<ManagedProcessState | null> {
    const events = await this.storage.loadEvents(record.sessionId, {
      branchId: record.branchId,
    });
    if (!events.length) return null;
    const state = projectEvents(events);
    return Object.values(state.managedProcesses).find(
      (process) => process.effectId === record.effectId,
    ) ?? null;
  }
}

export function managedProcessLogRoot(artifactDirectory: string): string {
  return join(artifactDirectory, ".managed-processes");
}

function randomIdentityToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("hex");
}

function runForCell(state: AgentState, cellId: string): string | null {
  for (const run of Object.values(state.agentRuns)) {
    if (run.steps.some((step) =>
      step.actionId && `agent-run-cell-${step.actionId}` === cellId)) {
      return run.id;
    }
  }
  return null;
}

function targetId(
  target: string | Pick<ManagedProcessHandle, "processId">,
): string {
  if (typeof target === "string" && target) return target;
  if (target && typeof target === "object" &&
      typeof target.processId === "string" && target.processId) {
    return target.processId;
  }
  throw new ValidationError(
    "Managed process target must be a process ID or durable handle",
  );
}

function handle(process: ManagedProcessState): ManagedProcessHandle {
  return {
    processId: process.id,
    effectId: process.effectId,
    workspaceId: process.workspaceId,
    sessionId: process.sessionId,
    branchId: process.branchId,
    runId: process.runId,
    cellId: process.cellId,
    status: process.status,
  };
}

function inspection(process: ManagedProcessState): ManagedProcessInspection {
  return {
    ...handle(process),
    command: process.command,
    cwd: process.cwd,
    pid: process.pid,
    processGroupId: process.processGroupId,
    requestedAt: process.requestedAt,
    startedAt: process.startedAt,
    stopFailureCount: process.stopFailureCount,
    ...(process.stopFailure === undefined
      ? {}
      : {
          stopFailure: {
            attempt: process.stopFailure.attempt,
            reason: process.stopFailure.reason,
            error: process.stopFailure.error,
            processGroupIds: [...process.stopFailure.processGroupIds],
              survivingProcessGroupIds: [
                ...process.stopFailure.survivingProcessGroupIds,
              ],
            attemptedAt: process.stopFailure.attemptedAt,
          },
        }),
    ...(process.output === undefined ? {} : { output: process.output }),
    ...(process.error === undefined ? {} : { error: process.error }),
  };
}

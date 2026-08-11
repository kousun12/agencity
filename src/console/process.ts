import { environmentWithoutSecrets } from "../security/index.ts";
import { assertBoundedOutputV1, type CellLogStream } from "../domain/index.ts";
import { MAX_CELL_OBSERVATION_JSON_BYTES, type EncodedObservation } from "./inspect.ts";
import {
  SCRATCH_LIMITS,
  validateScratchCheckpoint,
  type ScratchCheckpointCandidate,
  type ScratchCheckpointRestore,
  type ScratchScope,
  type ScratchStatus,
} from "./scratch.ts";

export interface ConsoleExecution {
  readonly observation: EncodedObservation;
  readonly logs: string[];
  readonly logStreams: CellLogStream[];
  readonly rssBytes: number;
}

export type ConsoleRpcHandler = (method: string, args: unknown[]) => Promise<unknown>;

type WorkerMessage =
  | { type: "rpc"; executionId: string; requestId: string; method: string; args: unknown[] }
  | { type: "result"; executionId: string; ok: boolean; observation?: EncodedObservation; error?: string; logs: string[]; logStreams: CellLogStream[]; rssBytes: number }
  | { type: "control-result"; requestId: string; ok: boolean; value?: unknown; error?: string };

interface PendingExecution {
  readonly resolve: (value: ConsoleExecution) => void;
  readonly reject: (error: Error) => void;
  readonly handler: ConsoleRpcHandler;
}

interface PendingControl {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface ConsoleProcessOptions {
  readonly scratchCheckpointTimeoutMs?: number;
  readonly scratchIdleScopeMs?: number;
  readonly scratchMaxWarmScopes?: number;
}

export interface ConsoleProcessStatus {
  readonly running: boolean;
  readonly lastRecycleReason: string | null;
}

/**
 * Owns a disposable console worker with a dedicated Bun IPC channel.
 *
 * Protocol messages never share stdout/stderr with generated code. The worker
 * captures ordinary process/console output as bounded cell logs, so arbitrary
 * text (including JSON that resembles an RPC message) cannot corrupt routing.
 */
export class ConsoleProcess {
  #process: ReturnType<typeof Bun.spawn> | null = null;
  #pending = new Map<string, PendingExecution>();
  #controls = new Map<string, PendingControl>();
  #lastRecycleReason: string | null = null;

  constructor(
    readonly workerUrl = new URL("./worker.ts", import.meta.url),
    readonly options: ConsoleProcessOptions = {},
  ) {
    assertPositiveInteger(options.scratchCheckpointTimeoutMs, "scratch checkpoint timeout");
    assertPositiveInteger(options.scratchIdleScopeMs, "scratch idle scope timeout");
    assertPositiveInteger(options.scratchMaxWarmScopes, "scratch warm-scope limit");
  }

  status(): ConsoleProcessStatus {
    return { running: this.#process !== null, lastRecycleReason: this.#lastRecycleReason };
  }

  async start(): Promise<void> {
    if (this.#process) return;
    const child = Bun.spawn([processExec(), "run", this.workerUrl.pathname], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: consoleWorkerEnvironment(),
      serialization: "json",
      ipc: (message) => {
        try {
          this.#message(message as WorkerMessage);
        } catch (error) {
          this.#rejectAll(error instanceof Error ? error : new Error(String(error)));
          if (this.#process === child) child.kill();
        }
      },
    });
    this.#process = child;
    // Output that bypasses the worker's per-cell capture is never protocol. It
    // is drained to prevent pipe backpressure and deliberately not re-parsed.
    void drain(child.stdout);
    void drain(child.stderr);
    void child.exited.then((code) => {
      if (this.#process === child) this.#process = null;
      this.#rejectAll(new Error(`Console worker exited with code ${code}`));
    });
  }

  async execute(
    code: string,
    session: { id: string; branchId: string },
    restored: Record<string, unknown>,
    handler: ConsoleRpcHandler,
  ): Promise<ConsoleExecution> {
    await this.start();
    const executionId = crypto.randomUUID();
    const promise = new Promise<ConsoleExecution>((resolve, reject) => {
      this.#pending.set(executionId, { resolve, reject, handler });
    });
    try {
      this.#send({ type: "execute", executionId, code, session, restored });
    } catch (error) {
      this.#pending.delete(executionId);
      throw error;
    }
    return promise;
  }

  async prepareScratch(
    scope: ScratchScope,
    restore: ScratchCheckpointRestore | null,
    cacheAvailable: boolean,
  ): Promise<ScratchStatus> {
    const value = await this.#control({
      type: "scratch-prepare",
      scope,
      restore,
      cacheAvailable,
      idleScopeMs: this.options.scratchIdleScopeMs ?? SCRATCH_LIMITS.idleScopeMs,
      maxWarmScopes: this.options.scratchMaxWarmScopes ?? SCRATCH_LIMITS.maxWarmScopes,
    }, 5_000, "scratch-control-timeout");
    return value as ScratchStatus;
  }

  async hasScratch(scope: ScratchScope): Promise<boolean> {
    const value = await this.#control(
      { type: "scratch-probe", scope },
      5_000,
      "scratch-control-timeout",
    ) as { warm?: unknown };
    return value?.warm === true;
  }

  async checkpointScratch(
    scope: ScratchScope,
    sourceCellId: string,
  ): Promise<ScratchCheckpointCandidate> {
    const value = await this.#control(
      { type: "scratch-checkpoint", scope, sourceCellId },
      this.options.scratchCheckpointTimeoutMs ?? SCRATCH_LIMITS.checkpointTimeoutMs,
      "scratch-checkpoint-timeout",
    );
    return validateScratchCheckpoint(value as ScratchCheckpointCandidate);
  }

  async recordScratchCheckpoint(
    scope: ScratchScope,
    sourceCellId: string,
    candidate: ScratchCheckpointCandidate,
  ): Promise<void> {
    await this.#control(
      { type: "scratch-record-checkpoint", scope, sourceCellId, candidate },
      5_000,
      "scratch-control-timeout",
    );
  }

  async evictScratch(scope: ScratchScope): Promise<void> {
    await this.#control(
      { type: "scratch-evict", scope },
      5_000,
      "scratch-control-timeout",
    );
  }

  async recycle(reason: string): Promise<void> {
    this.#lastRecycleReason = reason.slice(0, 128);
    const child = this.#process;
    if (!child) return;
    child.kill();
    await child.exited;
    if (this.#process === child) this.#process = null;
  }

  async stop(): Promise<void> {
    const child = this.#process;
    if (!child) return;
    try {
      this.#send({ type: "shutdown" });
    } catch {
      child.kill();
    }
    const timer = setTimeout(() => child.kill(), 1_000);
    await child.exited;
    clearTimeout(timer);
    if (this.#process === child) this.#process = null;
  }

  async #control(
    message: Record<string, unknown>,
    timeoutMs = 5_000,
    recycleReason?: string,
  ): Promise<unknown> {
    await this.start();
    const requestId = crypto.randomUUID();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#controls.delete(requestId);
        const error = new Error(`Console control request timed out after ${timeoutMs}ms`);
        if (!recycleReason) {
          reject(error);
          return;
        }
        void this.recycle(recycleReason).then(
          () => reject(error),
          () => reject(error),
        );
      }, timeoutMs);
      this.#controls.set(requestId, { resolve, reject, timer });
    });
    try {
      this.#send({ ...message, requestId });
    } catch (error) {
      const pending = this.#controls.get(requestId);
      if (pending) clearTimeout(pending.timer);
      this.#controls.delete(requestId);
      throw error;
    }
    return promise;
  }

  #send(message: unknown): void {
    const child = this.#process;
    if (!child) throw new Error("Console worker is not running");
    child.send(message);
  }

  #message(message: WorkerMessage): void {
    if (!message || typeof message !== "object" ||
        (message.type !== "rpc" && message.type !== "result" && message.type !== "control-result")) {
      throw new Error("Console worker emitted an invalid IPC message");
    }
    if (message.type === "control-result") {
      if (typeof message.requestId !== "string") throw new Error("Console worker emitted an invalid control response");
      const pending = this.#controls.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#controls.delete(message.requestId);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error ?? "Console control request failed"));
      return;
    }
    if (typeof message.executionId !== "string") {
      throw new Error("Console worker emitted an invalid execution response");
    }
    const pending = this.#pending.get(message.executionId);
    if (!pending) {
      if (message.type === "rpc" && typeof message.requestId === "string") {
        this.#send({
          type: "rpc-result",
          requestId: message.requestId,
          ok: false,
          error: "Console RPC execution is no longer active",
        });
      }
      return;
    }
    if (message.type === "result") {
      if (!Array.isArray(message.logs) || !message.logs.every((log) => typeof log === "string")) {
        throw new Error("Console worker emitted invalid logs");
      }
      if (!Array.isArray(message.logStreams) ||
          message.logStreams.length !== message.logs.length ||
          !message.logStreams.every((stream) => stream === "stdout" || stream === "stderr")) {
        throw new Error("Console worker emitted invalid log stream metadata");
      }
      if (!Number.isSafeInteger(message.rssBytes) || message.rssBytes < 0) {
        throw new Error("Console worker emitted invalid RSS metadata");
      }
      this.#pending.delete(message.executionId);
      if (message.ok) {
        if (!validObservation(message.observation)) throw new Error("Console worker emitted an invalid observation");
        pending.resolve({ observation: message.observation, logs: message.logs, logStreams: message.logStreams, rssBytes: message.rssBytes });
      } else pending.reject(new ConsoleCellError(
        message.error ?? "Console cell failed",
        message.logs,
        message.logStreams,
        message.rssBytes,
      ));
      return;
    }
    if (typeof message.requestId !== "string" || typeof message.method !== "string" || !Array.isArray(message.args)) {
      throw new Error("Console worker emitted an invalid RPC request");
    }
    queueMicrotask(() => {
      void pending.handler(message.method, message.args).then(
        (value) => this.#send({ type: "rpc-result", requestId: message.requestId, ok: true, value }),
        (error) => this.#send({
          type: "rpc-result",
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const pending of this.#controls.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#controls.clear();
  }
}

function validObservation(value: unknown): value is EncodedObservation {
  if (!value || typeof value !== "object") return false;
  const observation = value as Record<string, unknown>;
  const preview = observation.preview;
  if (!preview || typeof preview !== "object" ||
      (preview as Record<string, unknown>).kind !== "inspect" ||
      typeof (preview as Record<string, unknown>).preview !== "string") return false;
  if (observation.kind === "json") {
    return typeof observation.json === "string" &&
      Number.isSafeInteger(observation.byteLength) && Number(observation.byteLength) >= 0 &&
      Number(observation.byteLength) <= MAX_CELL_OBSERVATION_JSON_BYTES;
  }
  if (observation.kind === "staged") {
    try {
      assertBoundedOutputV1(observation.result);
      return observation.result.completeness === "spilled" &&
        Number.isSafeInteger(observation.byteLength) && Number(observation.byteLength) >= 0;
    } catch {
      return false;
    }
  }
  return observation.kind === "unsupported" && typeof observation.reason === "string";
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) { /* prevent worker output backpressure */ }
  } catch { /* worker exit closes the pipe */ }
}

function processExec(): string {
  return process.execPath.endsWith("bun") ? process.execPath : "bun";
}

function assertPositiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error(`Console ${label} must be a positive integer`);
  }
}

/** Do not give generated code brokered provider credentials through process.env. */
function consoleWorkerEnvironment(): Record<string, string> {
  return environmentWithoutSecrets();
}

export class ConsoleCellError extends Error {
  constructor(
    message: string,
    readonly logs: string[],
    readonly logStreams: CellLogStream[],
    readonly rssBytes: number,
  ) {
    super(message);
    this.name = "ConsoleCellError";
  }
}

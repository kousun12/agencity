import { environmentWithoutSecrets } from "../security/index.ts";
import { assertBoundedOutputV1, type CellLogStream } from "../domain/index.ts";
import { MAX_CELL_OBSERVATION_JSON_BYTES, type EncodedObservation } from "./inspect.ts";

export interface ConsoleExecution {
  readonly observation: EncodedObservation;
  readonly logs: string[];
  readonly logStreams: CellLogStream[];
  readonly rssBytes: number;
}

export type ConsoleRpcHandler = (method: string, args: unknown[]) => Promise<unknown>;

const CONSOLE_RPC_RESPONSE = Symbol("agencity.console-rpc-response");

interface ConsoleRpcResponse {
  readonly [CONSOLE_RPC_RESPONSE]: true;
  readonly value: unknown;
  readonly causalEffectOutcomeEventId?: string;
}

/**
 * Attaches supervisor-only metadata to an RPC value. The worker unwraps the
 * public value before generated code receives it.
 */
export function consoleRpcResponse(
  value: unknown,
  metadata: { readonly causalEffectOutcomeEventId?: string },
): unknown {
  return {
    [CONSOLE_RPC_RESPONSE]: true,
    value,
    ...metadata,
  } satisfies ConsoleRpcResponse;
}

type WorkerMessage =
  | { type: "rpc"; executionId: string; requestId: string; method: string; args: unknown[] }
  | { type: "result"; executionId: string; ok: boolean; observation?: EncodedObservation; error?: string; failurePhase?: "compile" | "runtime"; causalEffectOutcomeEventIds?: string[]; logs: string[]; logStreams: CellLogStream[]; rssBytes: number };

interface PendingExecution {
  readonly resolve: (value: ConsoleExecution) => void;
  readonly reject: (error: Error) => void;
  readonly handler: ConsoleRpcHandler;
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
  #rpcOperations = new Set<Promise<void>>();
  #lastRecycleReason: string | null = null;
  #closed = false;

  constructor(readonly workerUrl = new URL("./worker.ts", import.meta.url)) {}

  status(): ConsoleProcessStatus {
    return { running: this.#process !== null, lastRecycleReason: this.#lastRecycleReason };
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("Console worker is closed");
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
    workspaceRoot = process.cwd(),
  ): Promise<ConsoleExecution> {
    await this.start();
    const executionId = crypto.randomUUID();
    const promise = new Promise<ConsoleExecution>((resolve, reject) => {
      this.#pending.set(executionId, { resolve, reject, handler });
    });
    try {
      this.#send({
        type: "execute",
        executionId,
        code,
        session,
        restored,
        workspaceRoot,
      });
    } catch (error) {
      this.#pending.delete(executionId);
      throw error;
    }
    return promise;
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

  /** Permanently prevents this pool-owned worker from restarting. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.stop();
  }

  async drainRpcOperations(): Promise<void> {
    // Flush handlers queued by the last IPC callback before observing the set.
    await Promise.resolve();
    while (this.#rpcOperations.size > 0) {
      await Promise.allSettled([...this.#rpcOperations]);
    }
  }

  #send(message: unknown): void {
    const child = this.#process;
    if (!child) throw new Error("Console worker is not running");
    child.send(message);
  }

  #message(message: WorkerMessage): void {
    if (!message || typeof message !== "object" ||
        (message.type !== "rpc" && message.type !== "result")) {
      throw new Error("Console worker emitted an invalid IPC message");
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
      } else {
        if (message.failurePhase !== "compile" &&
            message.failurePhase !== "runtime") {
          throw new Error("Console worker emitted invalid failure phase");
        }
        if (message.causalEffectOutcomeEventIds !== undefined &&
            (!Array.isArray(message.causalEffectOutcomeEventIds) ||
             message.causalEffectOutcomeEventIds.length > 16 ||
             !message.causalEffectOutcomeEventIds.every((id) => typeof id === "string"))) {
          throw new Error("Console worker emitted invalid private failure causality");
        }
        pending.reject(new ConsoleCellError(
          message.error ?? "Console cell failed",
          message.logs,
          message.logStreams,
          message.rssBytes,
          message.failurePhase,
          message.causalEffectOutcomeEventIds ?? [],
        ));
      }
      return;
    }
    if (typeof message.requestId !== "string" || typeof message.method !== "string" || !Array.isArray(message.args)) {
      throw new Error("Console worker emitted an invalid RPC request");
    }
    queueMicrotask(() => {
      const operation = Promise.resolve().then(() =>
        pending.handler(message.method, message.args)
      ).then(
        (value) => {
          try {
            const response: {
              readonly value: unknown;
              readonly causalEffectOutcomeEventId?: string;
            } = isConsoleRpcResponse(value) ? value : { value };
            this.#send({
              type: "rpc-result",
              requestId: message.requestId,
              ok: true,
              value: response.value,
              ...(response.causalEffectOutcomeEventId === undefined
                ? {}
                : {
                    causalEffectOutcomeEventId:
                      response.causalEffectOutcomeEventId,
                  }),
            });
          } catch { /* Worker loss does not cancel durable RPC work. */ }
        },
        (error) => {
          try {
            this.#send({
              type: "rpc-result",
              requestId: message.requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              ...(error && typeof error === "object" &&
                  typeof (error as { code?: unknown }).code === "string"
                ? { code: (error as { code: string }).code }
                : {}),
              ...(error && typeof error === "object" &&
                  (error as { details?: unknown }).details !== undefined
                ? { details: (error as { details: unknown }).details }
                : {}),
            });
          } catch { /* Worker loss does not cancel durable RPC work. */ }
        },
      ).finally(() => {
        this.#rpcOperations.delete(operation);
      });
      this.#rpcOperations.add(operation);
    });
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
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
    readonly failurePhase: "compile" | "runtime",
    readonly causalEffectOutcomeEventIds: readonly string[] = [],
  ) {
    super(message);
    this.name = "ConsoleCellError";
  }
}

function isConsoleRpcResponse(value: unknown): value is ConsoleRpcResponse {
  return Boolean(
    value && typeof value === "object" &&
    (value as Partial<ConsoleRpcResponse>)[CONSOLE_RPC_RESPONSE] === true,
  );
}

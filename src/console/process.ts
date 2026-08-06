import { environmentWithoutSecrets } from "../security/index.ts";

export interface ConsoleExecution {
  readonly value: unknown;
  readonly logs: string[];
}

export type ConsoleRpcHandler = (method: string, args: unknown[]) => Promise<unknown>;

type WorkerMessage =
  | { type: "rpc"; executionId: string; requestId: string; method: string; args: unknown[] }
  | { type: "result"; executionId: string; ok: boolean; value?: unknown; error?: string; logs: string[] };

interface PendingExecution {
  readonly resolve: (value: ConsoleExecution) => void;
  readonly reject: (error: Error) => void;
  readonly handler: ConsoleRpcHandler;
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

  constructor(readonly workerUrl = new URL("./worker.ts", import.meta.url)) {}

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

  #send(message: unknown): void {
    const child = this.#process;
    if (!child) throw new Error("Console worker is not running");
    child.send(message);
  }

  #message(message: WorkerMessage): void {
    if (!message || typeof message !== "object" ||
        (message.type !== "rpc" && message.type !== "result") ||
        typeof message.executionId !== "string") {
      throw new Error("Console worker emitted an invalid IPC message");
    }
    const pending = this.#pending.get(message.executionId);
    if (!pending) return; // A late response from a cancelled/failed execution.
    if (message.type === "result") {
      if (!Array.isArray(message.logs) || !message.logs.every((log) => typeof log === "string")) {
        throw new Error("Console worker emitted invalid logs");
      }
      this.#pending.delete(message.executionId);
      if (message.ok) pending.resolve({ value: message.value, logs: message.logs });
      else pending.reject(new ConsoleCellError(message.error ?? "Console cell failed", message.logs));
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
  }
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
  constructor(message: string, readonly logs: string[]) {
    super(message);
    this.name = "ConsoleCellError";
  }
}

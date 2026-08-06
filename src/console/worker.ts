import { assertJsonValue } from "../domain/json.ts";
import type { JsonValue } from "../domain/json.ts";
import type { ConsoleSdk, SqlTag } from "./sdk.ts";

type Incoming =
  | { type: "execute"; executionId: string; code: string; session: { id: string; branchId: string }; restored: Record<string, unknown> }
  | { type: "rpc-result"; requestId: string; ok: boolean; value?: unknown; error?: string }
  | { type: "shutdown" };

const MAX_LOG_BYTES = 64 * 1024;
const MAX_LOG_LINES = 1_000;
const LOG_TRUNCATED = "[console output truncated]";

class BoundedLogs {
  readonly values: string[] = [];
  #bytes = 0;
  #truncated = false;

  push(value: string): void {
    if (this.#truncated) return;
    if (this.values.length >= MAX_LOG_LINES) return this.#truncate();
    const bytes = new TextEncoder().encode(value);
    const remaining = MAX_LOG_BYTES - this.#bytes;
    if (bytes.byteLength <= remaining) {
      this.values.push(value);
      this.#bytes += bytes.byteLength;
      return;
    }
    if (remaining > 0) {
      const prefix = new TextDecoder().decode(bytes.slice(0, remaining));
      if (prefix) this.values.push(prefix);
    }
    this.#truncate();
  }

  #truncate(): void {
    if (this.#truncated) return;
    this.#truncated = true;
    this.values.push(LOG_TRUNCATED);
  }
}

function send(message: unknown): void {
  if (!process.send) throw new Error("Console IPC channel is unavailable");
  process.send(message);
}

const pendingRpc = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let executionQueue = Promise.resolve();

function rpc(executionId: string, method: string, args: unknown[]): Promise<unknown> {
  const requestId = crypto.randomUUID();
  const promise = new Promise<unknown>((resolve, reject) => pendingRpc.set(requestId, { resolve, reject }));
  send({ type: "rpc", executionId, requestId, method, args });
  return promise;
}

process.on("message", (raw: unknown) => {
  const message = raw as Incoming;
  if (!message || typeof message !== "object" || typeof message.type !== "string") return;
  if (message.type === "rpc-result") {
    const pending = pendingRpc.get(message.requestId);
    if (pending) {
      pendingRpc.delete(message.requestId);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error ?? "RPC failed"));
    }
    return;
  }
  if (message.type === "execute") {
    // One worker can serve several branches, but stdout/stderr are process-wide.
    // Serial execution makes their bounded capture unambiguous.
    executionQueue = executionQueue.then(() => execute(message));
    return;
  }
  process.exit(0);
});

async function execute(message: Extract<Incoming, { type: "execute" }>): Promise<void> {
  const logs = new BoundedLogs();
  const printable = (value: unknown): string => {
    if (typeof value === "string") return value;
    try {
      const encoded = JSON.stringify(value);
      return encoded === undefined ? String(value) : encoded;
    } catch {
      return String(value);
    }
  };
  const write = (chunk: unknown, ...args: unknown[]): boolean => {
    const text = typeof chunk === "string"
      ? chunk
      : chunk instanceof Uint8Array
        ? new TextDecoder().decode(chunk)
        : String(chunk);
    for (const line of text.replace(/\n$/, "").split("\n")) if (line) logs.push(line);
    const callback = [...args].reverse().find((arg) => typeof arg === "function") as (() => void) | undefined;
    if (callback) queueMicrotask(callback);
    return true;
  };
  const stdout = process.stdout as typeof process.stdout & { write: typeof process.stdout.write };
  const stderr = process.stderr as typeof process.stderr & { write: typeof process.stderr.write };
  const originalStdout = stdout.write;
  const originalStderr = stderr.write;
  stdout.write = write as typeof process.stdout.write;
  stderr.write = write as typeof process.stderr.write;

  const cellConsole = {
    log: (...args: unknown[]) => logs.push(args.map(printable).join(" ")),
    error: (...args: unknown[]) => logs.push(args.map(printable).join(" ")),
    warn: (...args: unknown[]) => logs.push(args.map(printable).join(" ")),
  };
  const call = (method: string, args: unknown[]) => rpc(message.executionId, method, args);
  const state = {
    restored: message.restored,
    get: (name: string) => call("state.get", [name]),
    set: (name: string, value: JsonValue) => call("state.set", [name, value]),
  };
  const artifacts = {
    put: (content: string, mediaType?: string) => call("artifacts.put", [content, mediaType]),
    get: (artifactId: string) => call("artifacts.get", [artifactId]),
  };
  const request = async (executor: string, operation: string, input: JsonValue, options?: unknown) =>
    call("tools.request", [executor, operation, input, options]) as Promise<any>;
  const tools = {
    request,
    shell: async (command: string, options: Record<string, unknown> = {}) => {
      const response = await request("shell", "run", { command, ...options }, options);
      if (response.outcome !== "succeeded") throw new Error(response.error ?? `shell: ${response.outcome}`);
      return response.output;
    },
    readFile: async (path: string) => {
      const response = await request("file", "read", { path }, { idempotent: true });
      if (response.outcome !== "succeeded") throw new Error(response.error ?? `readFile: ${response.outcome}`);
      return response.output;
    },
    writeFile: async (path: string, content: string, expectedSha256?: string) => {
      const response = await request(
        "file",
        "write",
        { path, content, ...(expectedSha256 ? { expectedSha256 } : {}) },
        { idempotent: true },
      );
      if (response.outcome !== "succeeded") throw new Error(response.error ?? `writeFile: ${response.outcome}`);
      return response.output;
    },
  };
  const memory = {
    search: (query: string, options: JsonValue = {}) => call("memory.search", [query, options]),
    create: (input: JsonValue | string) => call("memory.create", [input]),
    list: (options: JsonValue = {}) => call("memory.list", [options]),
  };
  const harness = {
    propose: (input: JsonValue) => call("harness.propose", [input]),
    list: (options: JsonValue = {}) => call("harness.list", [options]),
    history: (entryId: string) => call("harness.history", [entryId]),
  };
  const skills = { invoke: (entryId:string,input:JsonValue,options:JsonValue={}) => call("skills.invoke",[entryId,input,options]), test: (entryId:string,versionId?:string) => call("skills.test",[entryId,versionId]) };
  const specs = { spawn: (entryId:string,input:JsonValue={}) => call("specs.spawn",[entryId,input]) };
  const sql: SqlTag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    for (let index = 0; index < values.length; index++) text += `?${strings[index + 1] ?? ""}`;
    return call("sql", [text, values]) as Promise<JsonValue[]>;
  });

  let response: Record<string, unknown>;
  try {
    const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
    const source = `async function __cell(sdk,sql,session,console,state,artifacts,tools){\n${message.code}\n}`;
    const javascript = transpiler.transformSync(source);
    const factory = new Function(`${javascript}\nreturn __cell;`)() as (
      sdk: ConsoleSdk,
      sql: SqlTag,
      session: unknown,
      console: unknown,
      state: unknown,
      artifacts: unknown,
      tools: unknown,
    ) => Promise<unknown>;
    const sdk = { state, artifacts, tools, memory, harness, skills, specs } as unknown as ConsoleSdk;
    const value = await factory(sdk, sql, message.session, cellConsole, state, artifacts, tools);
    const result = value === undefined ? null : value;
    assertJsonValue(result);
    response = { type: "result", executionId: message.executionId, ok: true, value: result };
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    response = {
      type: "result",
      executionId: message.executionId,
      ok: false,
      error: detail.length > MAX_LOG_BYTES ? `${detail.slice(0, MAX_LOG_BYTES)}…` : detail,
    };
  } finally {
    stdout.write = originalStdout;
    stderr.write = originalStderr;
  }
  send({ ...response, logs: logs.values });
}

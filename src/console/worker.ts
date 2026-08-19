import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInThisContext } from "node:vm";
import type { JsonValue } from "../domain/json.ts";
import type { CellLogStream } from "../domain/events.ts";
import type {
  ConsoleAgentHandle,
  ConsoleAgentHandleIdentity,
  ConsoleAgentResultOptions,
  ConsoleAgentRunResult,
  ConsoleAgentSpawnInput,
  ConsoleSdk,
  HarnessReviewInput,
  SqlTag,
} from "./sdk.ts";
import {
  MAX_CELL_OBSERVATION_JSON_BYTES,
  encodeObservation,
  inspectValue,
  type EncodedObservation,
  type InspectOptions,
} from "./inspect.ts";
import {
  CELL_RETURN_GLOBAL,
  CELL_RETURN_GUARD_GLOBAL,
  prepareReplCellSource,
} from "./repl.ts";
import { CONSOLE_EXECUTION_YIELD_METHOD } from "./process.ts";
import { schemaToPlainJsonSchema } from "./schema-conversion.ts";

type Incoming =
  | { type: "execute"; executionId: string; code: string; session: { id: string; branchId: string }; restored: Record<string, unknown>; workspaceRoot: string }
  | { type: "rpc-result"; requestId: string; ok: boolean; value?: unknown; error?: string; code?: string; details?: Record<string, unknown>; causalEffectOutcomeEventId?: string }
  | { type: "shutdown" };

const MAX_LOG_BYTES = 64 * 1024;
const MAX_LOG_LINES = 1_000;
const LOG_TRUNCATED = "[console output truncated]";
const MAX_TERMINAL_IPC_BYTES = 128 * 1024;

class BoundedLogs {
  readonly values: string[] = [];
  readonly streams: CellLogStream[] = [];
  #bytes = 0;
  #truncated = false;

  push(value: string, stream: CellLogStream): void {
    if (this.#truncated) return;
    if (this.values.length >= MAX_LOG_LINES) return this.#truncate(stream);
    const bytes = new TextEncoder().encode(value);
    const remaining = MAX_LOG_BYTES - this.#bytes;
    if (bytes.byteLength <= remaining) {
      this.values.push(value);
      this.streams.push(stream);
      this.#bytes += bytes.byteLength;
      return;
    }
    if (remaining > 0) {
      const prefix = new TextDecoder().decode(bytes.slice(0, remaining));
      if (prefix) {
        this.values.push(prefix);
        this.streams.push(stream);
      }
    }
    this.#truncate(stream);
  }

  #truncate(stream: CellLogStream): void {
    if (this.#truncated) return;
    this.#truncated = true;
    this.values.push(LOG_TRUNCATED);
    this.streams.push(stream);
  }
}

function send(message: unknown): void {
  if (!process.send) throw new Error("Console IPC channel is unavailable");
  process.send(message);
}

interface PrivateRpcResult {
  readonly value: unknown;
  readonly causalEffectOutcomeEventId?: string;
}

const pendingRpc = new Map<string, {
  resolve: (value: PrivateRpcResult) => void;
  reject: (error: Error) => void;
  executionId: string;
  executionYield: boolean;
}>();
const causalEffectErrors = new WeakMap<
  Error,
  readonly string[]
>();
let executionQueue = Promise.resolve();

type ReplBindingName =
  | "sdk"
  | "sql"
  | "session"
  | "console"
  | "state"
  | "artifacts"
  | "tools"
  | "inspect"
  | "cells"
  | "ai";

type ReplBindings = Readonly<Record<ReplBindingName, unknown>>;
interface ActiveReplContext {
  readonly executionId: string;
  readonly bindings: ReplBindings;
}
const activeReplContext = new AsyncLocalStorage<ActiveReplContext>();
const noopConsoleMethod = () => undefined;
const OUT_OF_CELL_CONSOLE = new Proxy(Object.create(null), {
  get: () => noopConsoleMethod,
});
const REPL_BINDING_NAMES: readonly ReplBindingName[] = [
  "sdk",
  "sql",
  "session",
  "console",
  "state",
  "artifacts",
  "tools",
  "inspect",
  "cells",
  "ai",
];
const replGlobals = Object.fromEntries(
  REPL_BINDING_NAMES.map((name) => [
    name,
    name === "sql" || name === "inspect"
      ? createCallableReplBinding(name)
      : createObjectReplBinding(name),
  ]),
) as Record<ReplBindingName, unknown>;
let replScopeKey: string | null = null;
let runningExecutionId: string | null = null;
let executionYieldScheduled = false;

class CellReturnSignal {
  constructor(readonly value: unknown) {}
}

function rpc(
  executionId: string,
  method: string,
  args: unknown[],
  executionYield = false,
): Promise<PrivateRpcResult> {
  const requestId = crypto.randomUUID();
  const promise = new Promise<PrivateRpcResult>((resolve, reject) =>
    pendingRpc.set(requestId, {
      resolve,
      reject,
      executionId,
      executionYield,
    }));
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
      if (message.ok) {
        pending.resolve({
          value: message.value,
          ...(typeof message.causalEffectOutcomeEventId === "string"
            ? {
                causalEffectOutcomeEventId:
                  message.causalEffectOutcomeEventId,
              }
            : {}),
        });
      }
      else {
        const error = new Error(message.error ?? "RPC failed") as Error & {
          code?: string;
          details?: Record<string, unknown>;
        };
        if (typeof message.code === "string") error.code = message.code;
        if (message.details && typeof message.details === "object") {
          error.details = message.details;
        }
        pending.reject(error);
      }
      if (!pending.executionYield) {
        scheduleExecutionYield(pending.executionId);
      }
    }
    return;
  }
  if (message.type === "execute") {
    // A pool-owned worker is pinned to one exact branch. Serial execution also
    // keeps process-wide stdout/stderr capture unambiguous.
    executionQueue = executionQueue.then(() => execute(message));
    return;
  }
  process.exit(0);
});

function scheduleExecutionYield(executionId: string): void {
  if (executionYieldScheduled || runningExecutionId !== executionId) return;
  executionYieldScheduled = true;
  // An RPC result reacquires the active-execution permit before it can resume
  // generated code. After that code drains its microtasks, release the permit
  // again when the cell is still suspended on another concurrent RPC.
  setTimeout(() => {
    executionYieldScheduled = false;
    if (runningExecutionId !== executionId) return;
    const hasPendingCellRpc = [...pendingRpc.values()].some((pending) =>
      pending.executionId === executionId && !pending.executionYield
    );
    const hasPendingYield = [...pendingRpc.values()].some((pending) =>
      pending.executionId === executionId && pending.executionYield
    );
    if (!hasPendingCellRpc || hasPendingYield) return;
    void rpc(
      executionId,
      CONSOLE_EXECUTION_YIELD_METHOD,
      [],
      true,
    ).catch(() => {});
  }, 0);
}

async function execute(message: Extract<Incoming, { type: "execute" }>): Promise<void> {
  const scope = `${message.session.id.length}:${message.session.id}${message.session.branchId}`;
  if (replScopeKey !== null && replScopeKey !== scope) {
    throw new Error("Console worker cannot change its exact session/branch scope");
  }
  replScopeKey = scope;
  runningExecutionId = message.executionId;
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
  const write = (stream: CellLogStream) =>
    (chunk: unknown, ...args: unknown[]): boolean => {
      const text = typeof chunk === "string"
        ? chunk
        : chunk instanceof Uint8Array
          ? new TextDecoder().decode(chunk)
          : String(chunk);
      for (const line of text.replace(/\n$/, "").split("\n")) if (line) logs.push(line, stream);
      const callback = [...args].reverse().find((arg) => typeof arg === "function") as (() => void) | undefined;
      if (callback) queueMicrotask(callback);
      return true;
    };
  const stdout = process.stdout as typeof process.stdout & { write: typeof process.stdout.write };
  const stderr = process.stderr as typeof process.stderr & { write: typeof process.stderr.write };
  const originalStdout = stdout.write;
  const originalStderr = stderr.write;
  stdout.write = write("stdout") as typeof process.stdout.write;
  stderr.write = write("stderr") as typeof process.stderr.write;

  const cellConsole = {
    log: (...args: unknown[]) => logs.push(args.map(printable).join(" "), "stdout"),
    error: (...args: unknown[]) => logs.push(args.map(printable).join(" "), "stderr"),
    warn: (...args: unknown[]) => logs.push(args.map(printable).join(" "), "stderr"),
  };
  const call = async (method: string, args: unknown[]) =>
    (await rpc(currentReplExecutionId(), method, args)).value;
  const callWithOptional = (
    method: string,
    required: unknown[],
    optional: unknown,
  ) => call(method, optional === undefined ? required : [...required, optional]);
  const optionsObject = (
    value: unknown,
    name: string,
  ): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`${name} must be an object`);
    }
    return value as Record<string, unknown>;
  };
  const state = {
    restored: message.restored,
    get: (name: string) => call("state.get", [name]),
    set: (name: string, value: JsonValue) => call("state.set", [name, value]),
    list: () => call("state.list", []),
  };
  const cells = {
    list: (options: JsonValue = {}) => call("cells.list", [options]),
    get: (cellId: string) => call("cells.get", [cellId]),
  };
  const inspect = (value: unknown, options: InspectOptions = {}) => inspectValue(value, options);
  const artifacts = {
    put: (content: string, mediaType?: string) =>
      callWithOptional("artifacts.put", [content], mediaType),
    readRange: async (artifactId: string, start: number, end: number) => {
      const envelope = await call("artifacts.readRange", [artifactId, start, end]) as any;
      if (envelope?.completeness !== "inline" || typeof envelope.value?.bytesBase64 !== "string") {
        throw new Error("Artifact range response is invalid");
      }
      const { bytesBase64, ...metadata } = envelope.value;
      return {
        ...envelope,
        value: {
          ...metadata,
          bytes: Uint8Array.from(Buffer.from(bytesBase64, "base64")),
        },
      };
    },
  };
  const requestWithMetadata = (
    executor: string,
    operation: string,
    input: JsonValue,
    options?: unknown,
  ) => rpc(
    currentReplExecutionId(),
    "tools.request",
    options === undefined
      ? [executor, operation, input]
      : [executor, operation, input, options],
  );
  const request = async (
    executor: string,
    operation: string,
    input: JsonValue,
    options?: unknown,
  ) => (await requestWithMetadata(executor, operation, input, options)).value as any;
  const convenienceResult = async (
    result: Promise<PrivateRpcResult>,
    label: string,
  ): Promise<any> => {
    const response = await result;
    const value = response.value as any;
    if (value?.outcome === "succeeded") return value.output;
    const error = new Error(
      value?.error ?? `${label}: ${value?.outcome ?? "failed"}`,
    );
    if (response.causalEffectOutcomeEventId !== undefined) {
      causalEffectErrors.set(error, [response.causalEffectOutcomeEventId]);
    }
    throw error;
  };
  const tools = {
    request,
    shell: async (command: string, rawOptions: Record<string, unknown> = {}) => {
      const options = optionsObject(rawOptions, "shell options");
      return convenienceResult(
        requestWithMetadata("shell", "run", { command, ...options }, options),
        "shell",
      );
    },
    readFile: async (path: string, rawOptions: Record<string, unknown> = {}) => {
      const options = optionsObject(rawOptions, "readFile options");
      return convenienceResult(
        requestWithMetadata(
          "file",
          "read",
          { path, ...options },
          { idempotent: true },
        ),
        "readFile",
      );
    },
    writeFile: async (path: string, content: string, expectedSha256?: string) => {
      if (expectedSha256 !== undefined && typeof expectedSha256 !== "string") {
        throw new TypeError("writeFile expectedSha256 must be a string");
      }
      return convenienceResult(
        requestWithMetadata(
          "file",
          "write",
          {
            path,
            content,
            ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
          },
          { idempotent: true },
        ),
        "writeFile",
      );
    },
  };
  const memory = {
    search: (query: string, options: JsonValue = {}) => call("memory.search", [query, options]),
    create: (input: JsonValue | string) => call("memory.create", [input]),
    list: (options: JsonValue = {}) => call("memory.list", [options]),
  };
  const harness = {
    review: (input?: string | HarnessReviewInput) =>
      callWithOptional("harness.review", [], input),
    reviews: (options: JsonValue = {}) => call("harness.reviews", [options]),
    propose: (input: JsonValue) => call("harness.propose", [input]),
    list: (options: JsonValue = {}) => call("harness.list", [options]),
    history: (entryId: string) => call("harness.history", [entryId]),
  };
  const skills = {
    list: (options:JsonValue={}) => call("skills.list",[options]),
    get: (nameOrId:string) => call("skills.get",[nameOrId]),
    invoke: (nameOrId:string,input:JsonValue,options:JsonValue={}) => call("skills.invoke",[nameOrId,input,options]),
    test: (nameOrId:string) => call("skills.test",[nameOrId]),
    propose: (instructions:string,scope:"local"|"workspace"="workspace") => call("skills.propose",[instructions,scope]),
  };
  const specs = { spawn: (entryId:string,input:JsonValue={}) => call("specs.spawn",[entryId,input]) };
  const agentResult = <I extends ConsoleAgentSpawnInput | string>(
    handle: string | ConsoleAgentHandleIdentity<I>,
    options: ConsoleAgentResultOptions = {},
  ) =>
    call("agents.result", [
      typeof handle === "string" ? handle : { taskId: handle.taskId },
      options,
    ]) as Promise<ConsoleAgentRunResult<I>>;
  const agentMessageResult = (
    message: string | { readonly mailboxMessageId: string },
    options: ConsoleAgentResultOptions = {},
  ) => call("agents.messageResult", [
    typeof message === "string"
      ? message
      : { mailboxMessageId: message.mailboxMessageId },
    options,
  ]);
  const attachAgentHandle = <I extends ConsoleAgentSpawnInput | string>(
    raw: unknown,
  ): ConsoleAgentHandle<I> => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        typeof (raw as Record<string, unknown>).taskId !== "string") {
      throw new Error("Agent spawn returned an invalid handle");
    }
    const handle = raw as ConsoleAgentHandle<I>;
    Object.defineProperty(handle, "result", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (options: ConsoleAgentResultOptions = {}) =>
        agentResult(handle.taskId, options),
    });
    return handle;
  };
  const agents = {
    spawn: async (input: unknown) =>
      attachAgentHandle(await call("agents.spawn", [normalizeAgentInput(input)])),
    spawnMany: async (inputs: unknown[]) => {
      const raw = await call("agents.spawnMany", [
        inputs.map(normalizeAgentInput),
      ]);
      if (!Array.isArray(raw)) {
        throw new Error("Agent spawnMany returned invalid handles");
      }
      return raw.map((handle) => attachAgentHandle(handle));
    },
    run: (input: unknown) => call("agents.run", [normalizeAgentInput(input)]),
    runMany: (inputs: unknown[]) => call("agents.runMany", [inputs.map(normalizeAgentInput)]),
    result: agentResult,
    get: (target?: string) => callWithOptional("agents.get", [], target),
    proposeProfileUpdate: (
      target: string | undefined,
      input: unknown,
      options: Record<string, unknown> = {},
    ) => {
      if (target !== undefined && typeof target !== "string") {
        throw new TypeError("Agent profile target must be a string");
      }
      return call("agents.proposeProfileUpdate", [target ?? null, input, options]);
    },
    rollbackProfile: (target: string | undefined, input: unknown) => {
      if (target !== undefined && typeof target !== "string") {
        throw new TypeError("Agent profile target must be a string");
      }
      return call("agents.rollbackProfile", [target ?? null, input]);
    },
    list: () => call("agents.list", []),
    send: (input: unknown, content?: string, options: Record<string, unknown> = {}) => call("agents.send", [input, content, options]),
    messageResult: agentMessageResult,
    messages: (options: Record<string, unknown> = {}) => call("agents.messages", [options]),
    acknowledge: (messageId: string) => call("agents.acknowledge", [messageId]),
    cancel: (target: string, reason?: string) =>
      callWithOptional("agents.cancel", [target], reason),
  };
  const goals = {
    current: () => call("goals.current", []),
    list: () => call("goals.list", []),
    get: (goalId: string) => call("goals.get", [goalId]),
    evaluations: (goalId: string, gateId?: string) =>
      callWithOptional("goals.evaluations", [goalId], gateId),
  };
  const heartbeats = {
    create: (input: unknown) => call("heartbeats.create", [input]),
    list: () => call("heartbeats.list", []),
    pause: (heartbeatId: string, reason?: string) =>
      callWithOptional("heartbeats.pause", [heartbeatId], reason),
    resume: (heartbeatId: string, nextTickAt?: string) =>
      callWithOptional("heartbeats.resume", [heartbeatId], nextTickAt),
    clear: (heartbeatId: string, reason?: string) =>
      callWithOptional("heartbeats.clear", [heartbeatId], reason),
  };
  const schedules = {
    create: (input: unknown) => call("schedules.create", [input]),
    list: () => call("schedules.list", []),
    wakes: (statuses?: string[]) =>
      callWithOptional("schedules.wakes", [], statuses),
    pause: (scheduleId: string, reason?: string) =>
      callWithOptional("schedules.pause", [scheduleId], reason),
    resume: (scheduleId: string, nextTickAt?: string) =>
      callWithOptional("schedules.resume", [scheduleId], nextTickAt),
    clear: (scheduleId: string, reason?: string) =>
      callWithOptional("schedules.clear", [scheduleId], reason),
  };
  const context = {
    inspect: () => call("context.inspect", []),
    compact: (options: Record<string, unknown> = {}) => call("context.compact", [options]),
  };
  const ai = {
    generateText: (input: unknown) => call("ai.generateText", [input]),
    generateObject: (input: unknown) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("ai.generateObject requires an input object");
      }
      const { schema, ...rest } = input as Record<string, unknown>;
      return call("ai.generateObject", [{ ...rest, schema: schemaToPlainJsonSchema(schema) }]);
    },
  };
  const sql: SqlTag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    for (let index = 0; index < values.length; index++) text += `?${strings[index + 1] ?? ""}`;
    return call("sql", [text, values]) as Promise<JsonValue[]>;
  });

  let response: Record<string, unknown> & { rssBytes: number };
  let failurePhase: "compile" | "runtime" | "finalization" = "compile";
  try {
    const transpiler = new Bun.Transpiler({
      loader: "ts",
      target: "bun",
      replMode: true,
    });
    const javascript = transpiler.transformSync(
      prepareReplCellSource(message.code),
    );
    failurePhase = "runtime";
    const sdk = { state, cells, artifacts, tools, memory, harness, skills, specs, agents, goals, heartbeats, schedules, context, ai, inspect } as unknown as ConsoleSdk;
    const bindings: ReplBindings = {
      sdk,
      sql,
      session: message.session,
      console: cellConsole,
      state,
      artifacts,
      tools,
      inspect,
      cells,
      ai,
    };
    for (const name of REPL_BINDING_NAMES) {
      Reflect.set(globalThis, name, replGlobals[name]);
    }
    Reflect.set(
      globalThis,
      CELL_RETURN_GLOBAL,
      (value: unknown) => new CellReturnSignal(value),
    );
    Reflect.set(
      globalThis,
      CELL_RETURN_GUARD_GLOBAL,
      (value: unknown) => value instanceof CellReturnSignal,
    );
    let replResult: unknown;
    let explicitReturn = false;
    try {
      replResult = await activeReplContext.run(
        { executionId: message.executionId, bindings },
        () => runInThisContext(javascript, {
          filename: `agencity://${message.session.id}/${message.session.branchId}/${message.executionId}.ts`,
          importModuleDynamically: (specifier: string) =>
            import(resolveCellImport(specifier, message.workspaceRoot)),
        }),
      );
    } catch (error) {
      if (!(error instanceof CellReturnSignal)) throw error;
      explicitReturn = true;
      replResult = error.value;
    }
    const value = await (
      explicitReturn ? replResult : unwrapReplResult(replResult)
    );
    failurePhase = "finalization";
    const encoded = encodeObservation(value);
    const inlineTerminal = {
      type: "result",
      executionId: message.executionId,
      ok: true,
      observation: encoded,
      logs: logs.values,
      logStreams: logs.streams,
    };
    const observation = encoded.kind === "json" &&
      (encoded.byteLength > MAX_CELL_OBSERVATION_JSON_BYTES ||
       ipcBytes(inlineTerminal) > MAX_TERMINAL_IPC_BYTES)
      ? await stageObservation(message.executionId, encoded)
      : encoded;
    response = { type: "result", executionId: message.executionId, ok: true, observation, rssBytes: process.memoryUsage.rss() };
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    const causalEffectOutcomeEventIds = error instanceof Error
      ? causalEffectErrors.get(error)
      : undefined;
    response = {
      type: "result",
      executionId: message.executionId,
      ok: false,
      error: detail.length > MAX_LOG_BYTES ? `${detail.slice(0, MAX_LOG_BYTES)}…` : detail,
      failurePhase,
      ...(causalEffectOutcomeEventIds === undefined
        ? {}
        : { causalEffectOutcomeEventIds: [...causalEffectOutcomeEventIds] }),
      rssBytes: process.memoryUsage.rss(),
    };
  } finally {
    stdout.write = originalStdout;
    stderr.write = originalStderr;
  }
  runningExecutionId = null;
  executionYieldScheduled = false;
  send(fitTerminalIpc({ ...response, logs: logs.values, logStreams: logs.streams }));
}

function normalizeAgentInput(input: unknown): unknown {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (record.output === undefined) return input;
  if (!record.output || typeof record.output !== "object" ||
      Array.isArray(record.output)) return input;
  const output = record.output as Record<string, unknown>;
  return {
    ...record,
    output: {
      ...output,
      schema: schemaToPlainJsonSchema(output.schema),
    },
  };
}

function currentReplBinding(name: ReplBindingName): unknown {
  const context = activeReplContext.getStore();
  if (!context) {
    // Imported modules may retain sockets, timers, or event listeners whose
    // callbacks outlive the cell's AsyncLocalStorage context. Logging from
    // those callbacks must not crash the worker or bypass bounded cell logs.
    // Other SDK bindings remain unavailable because they can request effects.
    if (name === "console") return OUT_OF_CELL_CONSOLE;
    throw new Error(`Console binding ${name} is unavailable outside an active cell`);
  }
  return context.bindings[name];
}

function currentReplExecutionId(): string {
  const context = activeReplContext.getStore();
  if (!context) {
    throw new Error("Console RPC is unavailable outside an active cell");
  }
  return context.executionId;
}

function createObjectReplBinding(name: ReplBindingName): object {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      return Reflect.get(currentReplBinding(name) as object, property);
    },
    set(_target, property, value) {
      return Reflect.set(currentReplBinding(name) as object, property, value);
    },
    has(_target, property) {
      return Reflect.has(currentReplBinding(name) as object, property);
    },
    ownKeys() {
      return Reflect.ownKeys(currentReplBinding(name) as object);
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        currentReplBinding(name) as object,
        property,
      );
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}

function createCallableReplBinding(name: ReplBindingName): (...args: unknown[]) => unknown {
  return new Proxy(function () {}, {
    apply(_target, thisArg, args) {
      return Reflect.apply(
        currentReplBinding(name) as (...values: unknown[]) => unknown,
        thisArg,
        args,
      );
    },
    get(_target, property) {
      return Reflect.get(currentReplBinding(name) as object, property);
    },
  });
}

function unwrapReplResult(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === null &&
    Reflect.ownKeys(value).length === 1 &&
    Object.hasOwn(value, "value")
  ) {
    return (value as { value: unknown }).value;
  }
  return value;
}

function resolveCellImport(specifier: string, workspaceRoot: string): string {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const base = pathToFileURL(
      resolve(workspaceRoot, "__agencity_cell__.ts"),
    );
    return new URL(specifier, base).href;
  }
  if (specifier.startsWith("/")) return pathToFileURL(specifier).href;
  return specifier;
}

async function stageObservation(
  executionId: string,
  observation: Extract<EncodedObservation, { kind: "json" }>,
): Promise<EncodedObservation> {
  const bytes = new TextEncoder().encode(observation.json);
  await rpc(executionId, "observation.stage.begin", [bytes.byteLength]);
  const chunkBytes = 64 * 1024;
  for (let start = 0; start < bytes.byteLength; start += chunkBytes) {
    await rpc(executionId, "observation.stage.chunk", [
      Buffer.from(bytes.subarray(start, Math.min(bytes.byteLength, start + chunkBytes))).toString("base64"),
    ]);
  }
  const result = (await rpc(
    executionId,
    "observation.stage.finish",
    [observation.preview],
  )).value as JsonValue;
  return {
    kind: "staged",
    result,
    byteLength: bytes.byteLength,
    preview: observation.preview,
  };
}

function ipcBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function fitTerminalIpc<T extends Record<string, unknown> & {
  readonly logs: string[];
  readonly logStreams: CellLogStream[];
  readonly rssBytes: number;
  readonly error?: string;
}>(input: T): T {
  if (ipcBytes(input) <= MAX_TERMINAL_IPC_BYTES) return input;
  const logs = [...input.logs];
  const logStreams = [...input.logStreams];
  let output = { ...input, logs, logStreams };
  while (logs.length && ipcBytes(output) > MAX_TERMINAL_IPC_BYTES) {
    logs.pop();
    logStreams.pop();
  }
  if (logs.length < input.logs.length) {
    logs.push(LOG_TRUNCATED);
    logStreams.push(input.logStreams[0] ?? "stdout");
    if (ipcBytes(output) > MAX_TERMINAL_IPC_BYTES) {
      logs.pop();
      logStreams.pop();
    }
  }
  if (ipcBytes(output) <= MAX_TERMINAL_IPC_BYTES) return output;
  if (typeof output.error === "string") {
    let error = output.error;
    while (error && ipcBytes({ ...output, error }) > MAX_TERMINAL_IPC_BYTES) {
      error = error.slice(0, Math.floor(error.length / 2));
    }
    output = { ...output, error: error ? `${error}…` : "Console cell failed" };
  }
  if (ipcBytes(output) > MAX_TERMINAL_IPC_BYTES) {
    return {
      type: input.type,
      executionId: input.executionId,
      ok: false,
      error: "Console terminal IPC response exceeded the 128 KiB product limit",
      logs: [],
      logStreams: [],
      rssBytes: input.rssBytes,
    } as unknown as T;
  }
  return output;
}

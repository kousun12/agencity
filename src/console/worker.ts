import type { JsonValue } from "../domain/json.ts";
import type { CellLogStream } from "../domain/events.ts";
import type { ConsoleSdk, HarnessReviewInput, SqlTag } from "./sdk.ts";
import {
  MAX_CELL_OBSERVATION_JSON_BYTES,
  encodeObservation,
  inspectValue,
  type EncodedObservation,
  type InspectOptions,
} from "./inspect.ts";
import { notebookCellBody } from "./notebook.ts";
import { schemaToPlainJsonSchema } from "./schema-conversion.ts";
import {
  SCRATCH_LIMITS,
  createScratchProxy,
  scratchValueType,
  serializeScratch,
  validateScratchCheckpoint,
  type ScratchCheckpointLoadResult,
  type ScratchProxyState,
  type ScratchScope,
  type ScratchStatus,
} from "./scratch.ts";

type Incoming =
  | { type: "execute"; executionId: string; code: string; session: { id: string; branchId: string }; restored: Record<string, unknown> }
  | { type: "scratch-prepare"; requestId: string; scope: ScratchScope; loadResult: ScratchCheckpointLoadResult; cacheAvailable: boolean; idleScopeMs: number; maxWarmScopes: number }
  | { type: "scratch-probe"; requestId: string; scope: ScratchScope }
  | { type: "scratch-checkpoint"; requestId: string; scope: ScratchScope; sourceCellId: string }
  | { type: "scratch-record-checkpoint"; requestId: string; scope: ScratchScope; sourceCellId: string; candidate: import("./scratch.ts").ScratchCheckpointCandidate }
  | { type: "scratch-record-cache-write"; requestId: string; scope: ScratchScope; status: "stored" | "cleared" | "unavailable" }
  | { type: "scratch-evict"; requestId: string; scope: ScratchScope }
  | { type: "rpc-result"; requestId: string; ok: boolean; value?: unknown; error?: string; code?: string; details?: Record<string, unknown> }
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

const pendingRpc = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let executionQueue = Promise.resolve();
interface WarmScratchScope {
  readonly scope: ScratchScope;
  readonly proxy: ScratchProxyState;
  temperature: "warm" | "cold" | "restored";
  readonly cacheAvailable: boolean;
  readonly restoreAttempted: boolean;
  cacheStatus: ScratchCheckpointLoadResult["status"];
  cacheReason: import("./scratch.ts").ScratchCacheUnavailableReason |
    import("./scratch.ts").ScratchCacheCorruptReason | null;
  lastCacheWrite: "stored" | "cleared" | "unavailable" | null;
  lastUsedAt: number;
  lastCheckpointAt: string | null;
  lastCheckpointCellId: string | null;
  savedNames: string[];
  skipped: Array<{ name: string; reason: import("./scratch.ts").ScratchSkipReason }>;
}
const scratchScopes = new Map<string, WarmScratchScope>();
let idleScopeMs: number = SCRATCH_LIMITS.idleScopeMs;
let maxWarmScopes: number = SCRATCH_LIMITS.maxWarmScopes;

function scopeKey(scope: ScratchScope): string {
  return `${scope.sessionId.length}:${scope.sessionId}${scope.branchId}`;
}

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
    }
    return;
  }
  if (message.type === "execute") {
    // One worker can serve several branches, but stdout/stderr are process-wide.
    // Serial execution makes their bounded capture unambiguous.
    executionQueue = executionQueue.then(() => execute(message));
    return;
  }
  if (message.type === "scratch-prepare") {
    executionQueue = executionQueue.then(() => control(message.requestId, () => prepareScratch(message)));
    return;
  }
  if (message.type === "scratch-probe") {
    executionQueue = executionQueue.then(() => control(message.requestId, () => {
      evictScratchScopes();
      return { warm: scratchScopes.has(scopeKey(message.scope)) };
    }));
    return;
  }
  if (message.type === "scratch-checkpoint") {
    executionQueue = executionQueue.then(() => control(message.requestId, () => checkpointScratch(message)));
    return;
  }
  if (message.type === "scratch-record-checkpoint") {
    executionQueue = executionQueue.then(() => control(
      message.requestId,
      () => recordScratchCheckpoint(message),
    ));
    return;
  }
  if (message.type === "scratch-record-cache-write") {
    executionQueue = executionQueue.then(() => control(message.requestId, () => {
      const warm = scratchScopes.get(scopeKey(message.scope));
      if (!warm) throw new Error("Scratch scope is not warm");
      warm.lastCacheWrite = message.status;
      return { recorded: true };
    }));
    return;
  }
  if (message.type === "scratch-evict") {
    executionQueue = executionQueue.then(() => control(message.requestId, () => {
      scratchScopes.delete(scopeKey(message.scope));
      return { evicted: true };
    }));
    return;
  }
  process.exit(0);
});

async function execute(message: Extract<Incoming, { type: "execute" }>): Promise<void> {
  evictScratchScopes();
  const warmScratch = scratchScopes.get(scopeKey({
    sessionId: message.session.id,
    branchId: message.session.branchId,
  })) ?? createWarmScratch({
    sessionId: message.session.id,
    branchId: message.session.branchId,
  }, { status: "unavailable", reason: "placement_unavailable" }, false);
  warmScratch.lastUsedAt = Date.now();
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
  const call = (method: string, args: unknown[]) => rpc(message.executionId, method, args);
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
    put: (content: string, mediaType?: string) => call("artifacts.put", [content, mediaType]),
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
  const request = async (executor: string, operation: string, input: JsonValue, options?: unknown) =>
    call("tools.request", [executor, operation, input, options]) as Promise<any>;
  const tools = {
    request,
    shell: async (command: string, options: Record<string, unknown> = {}) => {
      const response = await request("shell", "run", { command, ...options }, options);
      if (response.outcome !== "succeeded") throw new Error(response.error ?? `shell: ${response.outcome}`);
      return response.output;
    },
    readFile: async (path: string, options: Record<string, unknown> = {}) => {
      const response = await request("file", "read", { path, ...options }, { idempotent: true });
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
    review: (input?: string | HarnessReviewInput) =>
      call("harness.review", [input as JsonValue | undefined]),
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
  const agents = {
    spawn: (input: unknown) => call("agents.spawn", [normalizeAgentInput(input)]),
    spawnMany: (inputs: unknown[]) => call("agents.spawnMany", [inputs.map(normalizeAgentInput)]),
    run: (input: unknown) => call("agents.run", [normalizeAgentInput(input)]),
    runMany: (inputs: unknown[]) => call("agents.runMany", [inputs.map(normalizeAgentInput)]),
    result: (handle: string | { taskId: string }, options: Record<string, unknown> = {}) =>
      call("agents.result", [handle, options]),
    get: (target?: string) => call("agents.get", [target]),
    proposeProfileUpdate: (target: string | undefined, input: unknown, options: Record<string, unknown> = {}) =>
      call("agents.proposeProfileUpdate", [target, input, options]),
    rollbackProfile: (target: string | undefined, input: unknown) =>
      call("agents.rollbackProfile", [target, input]),
    list: () => call("agents.list", []),
    send: (input: unknown, content?: string) => call("agents.send", [input, content]),
    messages: (options: Record<string, unknown> = {}) => call("agents.messages", [options]),
    acknowledge: (messageId: string) => call("agents.acknowledge", [messageId]),
    cancel: (target: string, reason?: string) => call("agents.cancel", [target, reason]),
    followUp: (target: string, content: string, options: Record<string, unknown> = {}) => call("agents.followUp", [target, content, options]),
  };
  const goals = {
    current: () => call("goals.current", []),
    list: () => call("goals.list", []),
    get: (goalId: string) => call("goals.get", [goalId]),
    evaluations: (goalId: string, gateId?: string) => call("goals.evaluations", [goalId, gateId]),
  };
  const heartbeats = {
    create: (input: unknown) => call("heartbeats.create", [input]),
    list: () => call("heartbeats.list", []),
    pause: (heartbeatId: string, reason?: string) => call("heartbeats.pause", [heartbeatId, reason]),
    resume: (heartbeatId: string, nextTickAt?: string) => call("heartbeats.resume", [heartbeatId, nextTickAt]),
    clear: (heartbeatId: string, reason?: string) => call("heartbeats.clear", [heartbeatId, reason]),
  };
  const schedules = {
    create: (input: unknown) => call("schedules.create", [input]),
    list: () => call("schedules.list", []),
    wakes: (statuses?: string[]) => call("schedules.wakes", [statuses]),
    pause: (scheduleId: string, reason?: string) => call("schedules.pause", [scheduleId, reason]),
    resume: (scheduleId: string, nextTickAt?: string) => call("schedules.resume", [scheduleId, nextTickAt]),
    clear: (scheduleId: string, reason?: string) => call("schedules.clear", [scheduleId, reason]),
  };
  const context = {
    inspect: () => call("context.inspect", []),
    compact: (options: Record<string, unknown> = {}) => call("context.compact", [options]),
  };
  const scratchStatus = (): ScratchStatus => {
    const descriptors = Object.getOwnPropertyDescriptors(warmScratch.proxy.target);
    const propertyNames = Object.keys(descriptors).sort();
    const propertyTypes: Record<string, import("./scratch.ts").ScratchValueType> = Object.create(null);
    for (const name of propertyNames) {
      const descriptor = descriptors[name]!;
      propertyTypes[name] = "value" in descriptor
        ? scratchValueType(descriptor.value)
        : "undefined";
    }
    return {
      scope: warmScratch.scope,
      temperature: warmScratch.temperature,
      propertyNames,
      propertyTypes,
      lastCheckpointAt: warmScratch.lastCheckpointAt,
      lastCheckpointCellId: warmScratch.lastCheckpointCellId,
      savedNames: [...warmScratch.savedNames],
      skipped: [...warmScratch.skipped],
      cache: {
        available: warmScratch.cacheAvailable,
        restoreAttempted: warmScratch.restoreAttempted,
        status: warmScratch.cacheStatus,
        reason: warmScratch.cacheReason,
        lastWrite: warmScratch.lastCacheWrite,
      },
      limits: SCRATCH_LIMITS,
    };
  };
  const scratchSdk = {
    status: async () => scratchStatus(),
    clear: async () => {
      warmScratch.proxy.clear();
      return scratchStatus();
    },
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
  try {
    const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
    const body = notebookCellBody(message.code);
    const source = `async function __cell(sdk,sql,session,console,state,artifacts,tools,inspect,cells,ai,scratch){\n${body}\n}`;
    const javascript = transpiler.transformSync(source);
    const factory = new Function(`${javascript}\nreturn __cell;`)() as (
      sdk: ConsoleSdk,
      sql: SqlTag,
      session: unknown,
      console: unknown,
      state: unknown,
      artifacts: unknown,
      tools: unknown,
      inspect: typeof inspectValue,
      cells: unknown,
      ai: unknown,
      scratch: Record<string, unknown>,
    ) => Promise<unknown>;
    const sdk = { scratch: scratchSdk, state, cells, artifacts, tools, memory, harness, skills, specs, agents, goals, heartbeats, schedules, context, ai, inspect } as unknown as ConsoleSdk;
    const value = await factory(sdk, sql, message.session, cellConsole, state, artifacts, tools, inspect, cells, ai, warmScratch.proxy.object);
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
    response = {
      type: "result",
      executionId: message.executionId,
      ok: false,
      error: detail.length > MAX_LOG_BYTES ? `${detail.slice(0, MAX_LOG_BYTES)}…` : detail,
      rssBytes: process.memoryUsage.rss(),
    };
  } finally {
    stdout.write = originalStdout;
    stderr.write = originalStderr;
  }
  warmScratch.lastUsedAt = Date.now();
  warmScratch.temperature = "warm";
  evictScratchScopes();
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

async function control(requestId: string, operation: () => unknown | Promise<unknown>): Promise<void> {
  try {
    send({ type: "control-result", requestId, ok: true, value: await operation() });
  } catch (error) {
    send({
      type: "control-result",
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function prepareScratch(
  message: Extract<Incoming, { type: "scratch-prepare" }>,
): ScratchStatus {
  idleScopeMs = message.idleScopeMs;
  maxWarmScopes = message.maxWarmScopes;
  evictScratchScopes();
  const key = scopeKey(message.scope);
  let warm = scratchScopes.get(key);
  if (!warm) warm = createWarmScratch(message.scope, message.loadResult, message.cacheAvailable);
  warm.lastUsedAt = Date.now();
  evictScratchScopes(key);
  const descriptors = Object.getOwnPropertyDescriptors(warm.proxy.target);
  const names = Object.keys(descriptors).sort();
  const propertyTypes: Record<string, import("./scratch.ts").ScratchValueType> = Object.create(null);
  for (const name of names) {
    const descriptor = descriptors[name]!;
    propertyTypes[name] = "value" in descriptor ? scratchValueType(descriptor.value) : "undefined";
  }
  return {
    scope: warm.scope,
    temperature: warm.temperature,
    propertyNames: names,
    propertyTypes,
    lastCheckpointAt: warm.lastCheckpointAt,
    lastCheckpointCellId: warm.lastCheckpointCellId,
    savedNames: [...warm.savedNames],
    skipped: [...warm.skipped],
    cache: {
      available: warm.cacheAvailable,
      restoreAttempted: warm.restoreAttempted,
      status: warm.cacheStatus,
      reason: warm.cacheReason,
      lastWrite: warm.lastCacheWrite,
    },
    limits: SCRATCH_LIMITS,
  };
}

function createWarmScratch(
  scope: ScratchScope,
  loadResult: ScratchCheckpointLoadResult,
  cacheAvailable: boolean,
): WarmScratchScope {
  const restore = loadResult.status === "restored" ? loadResult.restore : null;
  const candidate = restore ? validateScratchCheckpoint(restore.candidate) : null;
  const skipped = new Map(candidate?.skipped.map((item) => [item.name, item.reason]) ?? []);
  const proxy = createScratchProxy(skipped, restore?.sourceCellId ?? null);
  if (candidate) {
    for (const name of candidate.savedNames) {
      Reflect.defineProperty(proxy.target, name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: structuredClone(candidate.values[name]),
      });
    }
  }
  const warm: WarmScratchScope = {
    scope,
    proxy,
    temperature: restore ? "restored" : "cold",
    cacheAvailable,
    restoreAttempted: cacheAvailable,
    cacheStatus: loadResult.status,
    cacheReason: loadResult.status === "unavailable" || loadResult.status === "corrupt"
      ? loadResult.reason
      : null,
    lastCacheWrite: null,
    lastUsedAt: Date.now(),
    lastCheckpointAt: restore?.checkpointedAt ?? null,
    lastCheckpointCellId: restore?.sourceCellId ?? null,
    savedNames: candidate ? [...candidate.savedNames] : [],
    skipped: candidate ? [...candidate.skipped] : [],
  };
  scratchScopes.set(scopeKey(scope), warm);
  return warm;
}

function checkpointScratch(
  message: Extract<Incoming, { type: "scratch-checkpoint" }>,
) {
  const warm = scratchScopes.get(scopeKey(message.scope));
  if (!warm) throw new Error("Scratch scope is not warm");
  if (!warm.proxy.dirty) return null;
  const candidate = serializeScratch(warm.proxy.target, warm.proxy.skipped);
  warm.lastUsedAt = Date.now();
  return candidate;
}

function recordScratchCheckpoint(
  message: Extract<Incoming, { type: "scratch-record-checkpoint" }>,
): { recorded: true } {
  const warm = scratchScopes.get(scopeKey(message.scope));
  if (!warm) throw new Error("Scratch scope is not warm");
  const candidate = validateScratchCheckpoint(message.candidate);
  warm.lastCheckpointAt = new Date().toISOString();
  warm.lastCheckpointCellId = message.sourceCellId;
  warm.savedNames = [...candidate.savedNames];
  warm.skipped = [...candidate.skipped];
  warm.proxy.skipped.clear();
  for (const item of candidate.skipped) warm.proxy.skipped.set(item.name, item.reason);
  warm.proxy.unavailableCheckpointCellId = message.sourceCellId;
  warm.proxy.markClean();
  warm.lastUsedAt = Date.now();
  return { recorded: true };
}

function evictScratchScopes(preserveKey?: string): void {
  const now = Date.now();
  for (const [key, scope] of scratchScopes) {
    if (key !== preserveKey && now - scope.lastUsedAt >= idleScopeMs) scratchScopes.delete(key);
  }
  while (scratchScopes.size > maxWarmScopes) {
    const candidate = [...scratchScopes.entries()]
      .filter(([key]) => key !== preserveKey)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt ||
        left[0].localeCompare(right[0]))[0];
    if (!candidate) break;
    scratchScopes.delete(candidate[0]);
  }
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
  const result = await rpc(executionId, "observation.stage.finish", [observation.preview]) as JsonValue;
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

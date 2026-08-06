import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { LocalArtifactStore } from "../artifacts/index.ts";
import { ConsoleCellError, ConsoleProcess } from "../console/index.ts";
import {
  assertJsonValue,
  jsonBytes,
  MAX_WORKING_JSON_BYTES,
  newId,
  NotFoundError,
  projectEvents,
  ValidationError,
  type AgentEvent,
  type ArtifactReference,
  type BudgetLimits,
  type JsonValue,
  type ModelConfiguration,
  type WorkingValue,
} from "../domain/index.ts";
import {
  EchoModelProvider,
  FileExecutor,
  ModelExecutor,
  OpenAICompatibleProvider,
  ShellExecutor,
  type ModelProvider,
} from "../executors/index.ts";
import { LibSqlStorage, type AgentStorage } from "../storage/index.ts";
import { ContextMaterializer } from "./context.ts";
import { ModelLoop } from "./model-loop.ts";
import { OutboxRunner } from "./outbox.ts";
import { ProjectionService } from "./projection.ts";
import { containsBrokeredSecret, scrubJson, scrubText } from "../security/index.ts";

export interface SupervisorOptions {
  readonly databaseUrl: string;
  readonly artifactDirectory: string;
  readonly workspaceRoot?: string;
  readonly restartConsoleAfterCell?: boolean;
  readonly modelProviders?: readonly ModelProvider[];
  readonly recover?: boolean;
}

export interface CreateSessionOptions {
  readonly workspaceId: string;
  readonly model?: ModelConfiguration;
  readonly budget?: BudgetLimits;
  readonly sessionId?: string;
  readonly branchId?: string;
}

/** Serializes committed cell boundaries per branch without retaining domain state. */
class BranchQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => current);
    this.#tails.set(key, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

export class Supervisor {
  readonly storage: AgentStorage;
  readonly artifacts: LocalArtifactStore;
  readonly console: ConsoleProcess;
  readonly outbox: OutboxRunner;
  readonly projections: ProjectionService;
  readonly contexts: ContextMaterializer;
  readonly modelLoop: ModelLoop;
  readonly restartConsoleAfterCell: boolean;
  readonly #cells = new BranchQueue();

  private constructor(
    storage: AgentStorage,
    artifacts: LocalArtifactStore,
    consoleProcess: ConsoleProcess,
    outbox: OutboxRunner,
    restartConsoleAfterCell: boolean,
  ) {
    this.storage = storage;
    this.artifacts = artifacts;
    this.console = consoleProcess;
    this.outbox = outbox;
    this.projections = new ProjectionService(storage);
    this.contexts = new ContextMaterializer(storage);
    this.modelLoop = new ModelLoop(storage, this.contexts, outbox);
    this.restartConsoleAfterCell = restartConsoleAfterCell;
  }

  static async open(options: SupervisorOptions): Promise<Supervisor> {
    await mkdir(options.artifactDirectory, { recursive: true });
    const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    await mkdir(workspaceRoot, { recursive: true });
    const storage = new LibSqlStorage(options.databaseUrl);
    await storage.migrate();
    const artifacts = new LocalArtifactStore(options.artifactDirectory);
    const providers: ModelProvider[] = [new EchoModelProvider(), ...(options.modelProviders ?? [])];
    if (process.env.OPENAI_API_KEY) {
      providers.push(new OpenAICompatibleProvider({
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: () => process.env.OPENAI_API_KEY,
      }));
    }
    const executors = [
      new ShellExecutor(workspaceRoot),
      new FileExecutor(workspaceRoot),
      new ModelExecutor(providers),
    ];
    const supervisor = new Supervisor(
      storage,
      artifacts,
      new ConsoleProcess(),
      new OutboxRunner(storage, executors),
      options.restartConsoleAfterCell ?? false,
    );
    if (options.recover !== false) {
      await supervisor.outbox.recover();
      await supervisor.outbox.drain();
      await supervisor.modelLoop.recoverIncomplete();
      await supervisor.modelLoop.reconcileRunningSessions();
    }
    return supervisor;
  }

  async close(): Promise<void> {
    await this.console.stop();
    this.storage.close();
  }

  async createSession(options: CreateSessionOptions): Promise<{ sessionId: string; branchId: string }> {
    const sessionId = options.sessionId ?? newId();
    const branchId = options.branchId ?? newId();
    const model = options.model ?? { provider: "echo", model: "echo-1" };
    await this.storage.appendEvents([{
      sessionId,
      branchId,
      type: "SessionCreated",
      producer: "supervisor",
      idempotencyKey: `session:${sessionId}`,
      payload: { workspaceId: options.workspaceId, initialBranchId: branchId, model, budget: options.budget ?? {} },
    }]);
    return { sessionId, branchId };
  }

  async appendMessage(
    sessionId: string,
    branchId: string,
    role: "system" | "user" | "assistant" | "tool",
    content: string,
  ): Promise<AgentEvent> {
    if (containsBrokeredSecret(content)) {
      throw new ValidationError("Brokered credentials cannot enter messages");
    }
    const [event] = await this.storage.appendEvents([{
      sessionId,
      branchId,
      type: "MessageAppended",
      producer: "client",
      idempotencyKey: `message:${newId()}`,
      payload: { messageId: newId(), role, content },
    }]);
    if (!event) throw new Error("Message not committed");
    return event;
  }

  async fork(sessionId: string, parentBranchId: string, forkCursor: string, name?: string): Promise<string> {
    const completeHistory = await this.storage.loadEvents(sessionId, { branchId: parentBranchId });
    if (!completeHistory.length) throw new NotFoundError("session branch", `${sessionId}/${parentBranchId}`);
    if (!completeHistory.some((event) => event.cursor === forkCursor)) {
      throw new ValidationError("Fork cursor is not in the parent branch history");
    }
    const branchId = newId();
    await this.storage.appendEvents([{
      sessionId,
      branchId,
      type: "BranchCreated",
      producer: "client",
      idempotencyKey: `branch:${branchId}`,
      payload: { branchId, parentBranchId, forkCursor, ...(name === undefined ? {} : { name }) },
    }]);
    return branchId;
  }

  async executeCell(
    sessionId: string,
    branchId: string,
    code: string,
    dependencies: string[] = [],
  ): Promise<{ cellId: string; result: JsonValue; logs: string[] }> {
    return this.#cells.run(`${sessionId}/${branchId}`, () => this.#executeCell(sessionId, branchId, code, dependencies));
  }

  async #executeCell(
    sessionId: string,
    branchId: string,
    code: string,
    dependencies: string[],
  ): Promise<{ cellId: string; result: JsonValue; logs: string[] }> {
    if (containsBrokeredSecret(code)) {
      throw new ValidationError("Brokered credentials cannot enter console cell source");
    }
    const history = await this.storage.loadEvents(sessionId, { branchId });
    if (!history.length) throw new NotFoundError("session branch", `${sessionId}/${branchId}`);
    const state = projectEvents(history);
    const cellId = newId();
    const started = performance.now();
    await this.storage.appendEvents([{
      sessionId,
      branchId,
      type: "CellProposed",
      producer: "console",
      idempotencyKey: `cell-proposed:${cellId}`,
      payload: { cellId, code, dependencies },
    }, {
      sessionId,
      branchId,
      type: "CellStarted",
      producer: "console",
      idempotencyKey: `cell-started:${cellId}:1`,
      payload: { cellId, attempt: 1 },
    }]);

    const stagedValues = new Map<string, WorkingValue>();
    const stagedArtifacts = new Map<string, ArtifactReference>();
    const restored = Object.fromEntries(
      Object.entries(state.workingValues).map(([name, value]) => [name, value.value]),
    );
    const handler = async (method: string, args: unknown[]): Promise<unknown> => {
      if (method === "state.get") {
        const name = String(args[0]);
        return stagedValues.get(name) ?? state.workingValues[name]?.value ?? null;
      }
      if (method === "state.set") {
        const name = String(args[0]);
        const value = args[1];
        if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(name)) throw new ValidationError("Invalid working value name");
        assertJsonValue(value);
        if (containsBrokeredSecret(value)) throw new ValidationError("Brokered credentials cannot enter working memory");
        let working: WorkingValue;
        if (jsonBytes(value) <= MAX_WORKING_JSON_BYTES) {
          working = { kind: "json", value: scrubJson(value) };
        } else {
          const reference = await this.artifacts.put(JSON.stringify(scrubJson(value)), { mediaType: "application/json" });
          stagedArtifacts.set(reference.artifactId, reference);
          working = { kind: "artifact", artifactId: reference.artifactId };
        }
        stagedValues.set(name, working);
        return working;
      }
      if (method === "artifacts.put") {
        if (typeof args[0] !== "string") throw new ValidationError("Artifact content must be a string");
        if (containsBrokeredSecret(args[0])) throw new ValidationError("Brokered credentials cannot enter artifacts");
        const reference = await this.artifacts.put(scrubText(args[0]), {
          mediaType: typeof args[1] === "string" ? args[1] : "text/plain",
        });
        stagedArtifacts.set(reference.artifactId, reference);
        return reference;
      }
      if (method === "artifacts.get") {
        const artifactId = String(args[0]);
        const reference = stagedArtifacts.get(artifactId) ?? state.artifacts[artifactId];
        if (!reference) throw new ValidationError(`Artifact not found: ${artifactId}`);
        return new TextDecoder().decode(await this.artifacts.resolve(reference));
      }
      if (method === "sql") {
        const sql = String(args[0]);
        const values = Array.isArray(args[1]) ? args[1] : [];
        const sqlArgs = values.map((value) => {
          if (value === null || typeof value === "string" || typeof value === "number" ||
              typeof value === "bigint" || value instanceof Uint8Array) return value;
          if (typeof value === "boolean") return value ? 1 : 0;
          throw new ValidationError("Unsupported SQL interpolation value");
        });
        return this.storage.readonlyQuery({ sql, args: sqlArgs });
      }
      if (method === "tools.request") {
        const [executor, operation, input, rawOptions] = args;
        if (typeof executor !== "string" || typeof operation !== "string") throw new ValidationError("Invalid tool request");
        assertJsonValue(input);
        const options = rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions)
          ? rawOptions as Record<string, unknown>
          : {};
        const idempotencyKey = typeof options.idempotencyKey === "string"
          ? options.idempotencyKey
          : `cell:${cellId}:${executor}:${operation}:${newId()}`;
        const idempotent = typeof options.idempotent === "boolean"
          ? options.idempotent
          : executor === "file" && operation !== "replace";
        const effectId = await this.outbox.request({
          sessionId,
          branchId,
          executor,
          operation,
          input,
          idempotencyKey,
          idempotent,
        });
        return this.outbox.run(effectId);
      }
      throw new ValidationError(`Unknown console RPC method: ${method}`);
    };

    try {
      const execution = await this.console.execute(code, { id: sessionId, branchId }, restored, handler);
      assertJsonValue(execution.value);
      const result = scrubJson(execution.value);
      const logs = execution.logs.map(scrubText);
      const events: any[] = [];
      for (const reference of stagedArtifacts.values()) {
        events.push({
          sessionId,
          branchId,
          type: "ArtifactRegistered",
          producer: "console",
          idempotencyKey: `cell-artifact:${cellId}:${reference.artifactId}`,
          payload: reference,
        });
      }
      for (const [name, value] of stagedValues) {
        events.push({
          sessionId,
          branchId,
          type: "WorkingValueSet",
          producer: "console",
          idempotencyKey: `cell-value:${cellId}:${name}`,
          payload: { name, version: (state.workingValues[name]?.version ?? 0) + 1, value },
        });
      }
      events.push({
        sessionId,
        branchId,
        type: "CellCommitted",
        producer: "console",
        idempotencyKey: `cell-committed:${cellId}`,
        payload: {
          cellId,
          result,
          logs,
          durationMs: Math.round(performance.now() - started),
          exports: [...stagedValues.keys()],
        },
      });
      await this.storage.appendEvents(events);
      return { cellId, result, logs };
    } catch (error) {
      const logs = error instanceof ConsoleCellError ? error.logs.map(scrubText) : [];
      await this.storage.appendEvents([{
        sessionId,
        branchId,
        type: "CellFailed",
        producer: "console",
        idempotencyKey: `cell-failed:${cellId}`,
        payload: {
          cellId,
          error: scrubText(error instanceof Error ? error.message : String(error)),
          logs,
          durationMs: Math.round(performance.now() - started),
        },
      }]);
      throw error;
    } finally {
      if (this.restartConsoleAfterCell) await this.console.stop();
    }
  }
}

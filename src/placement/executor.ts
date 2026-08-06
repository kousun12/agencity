import { AgentRuntimeError, DependencyFailureError, ValidationError } from "../domain/index.ts";
import type { JsonValue } from "../domain/json.ts";
import type { EffectExecutionContext, EffectExecutionRequest, EffectExecutor, ExecutionResult } from "../executors/index.ts";
import { result } from "../executors/index.ts";
import { requireCapability, type PlacementDescriptor } from "./capabilities.ts";
import { errorResponse, jsonResponse, normalizedEndpoint, readWireResponse } from "./http-wire.ts";

export type ExecutorIsolation = "trusted-local-process" | "managed-remote-sandbox";
export interface ExecutorPlacementCapabilities {
  readonly isolation: ExecutorIsolation;
  readonly isolatedFromHost: boolean;
  readonly operations: readonly string[];
  readonly filesystem: "host-workspace" | "sandbox" | "none";
  readonly network: "host-policy" | "sandbox-policy" | "none";
  readonly cancellation: "process-signal" | "transport-best-effort";
  readonly typedOutcomes: true;
}
export type ExecutorPlacementDescriptor = PlacementDescriptor<ExecutorPlacementCapabilities> & {
  readonly protocol: "in-process" | "agencity-executor-rpc-v1";
};

export interface TrustedLocalExecutorOptions {
  readonly operations: readonly string[];
  readonly filesystem?: "host-workspace" | "none";
  readonly network?: "host-policy" | "none";
}

/** Explicitly labels the existing process executor as trusted, never sandboxed. */
export class TrustedLocalExecutor implements EffectExecutor {
  readonly name: string;
  readonly placement: ExecutorPlacementDescriptor;
  readonly #executor: EffectExecutor;
  constructor(executor: EffectExecutor, options: TrustedLocalExecutorOptions) {
    if (!options.operations.length) throw new ValidationError("Trusted executor must advertise at least one operation");
    this.#executor = executor;
    this.name = executor.name;
    this.placement = {
      name: this.name,
      placement: "local",
      transport: "in-process",
      protocol: "in-process",
      capabilities: {
        isolation: "trusted-local-process",
        isolatedFromHost: false,
        operations: [...new Set(options.operations)],
        filesystem: options.filesystem ?? "host-workspace",
        network: options.network ?? "host-policy",
        cancellation: "process-signal",
        typedOutcomes: true,
      },
    };
  }
  execute(request: EffectExecutionRequest, context: EffectExecutionContext): Promise<ExecutionResult> {
    requireCapability(this.name, `operation:${request.operation}`, this.placement.capabilities.operations.includes(request.operation));
    return this.#executor.execute(request, context);
  }
}

export interface RemoteSandboxPolicy {
  readonly operations: readonly string[];
  readonly filesystem: "sandbox" | "none";
  readonly network: "sandbox-policy" | "none";
  /** The server operator, not the client, makes this isolation assertion. */
  readonly isolatedFromHost: true;
  readonly name?: string;
}

function remoteDescriptor(executor: EffectExecutor, policy: RemoteSandboxPolicy): ExecutorPlacementDescriptor {
  if (!policy.operations.length) throw new ValidationError("Remote sandbox must advertise at least one operation");
  if (policy.isolatedFromHost !== true) throw new ValidationError("Remote executor cannot advertise managed isolation without a server assertion");
  const name = policy.name ?? `remote-${executor.name}`;
  return {
    name,
    placement: "remote",
    transport: "http",
    protocol: "agencity-executor-rpc-v1",
    capabilities: {
      isolation: "managed-remote-sandbox",
      isolatedFromHost: true,
      operations: [...new Set(policy.operations)],
      filesystem: policy.filesystem,
      network: policy.network,
      cancellation: "transport-best-effort",
      typedOutcomes: true,
    },
  };
}

function executionRequest(value: unknown): EffectExecutionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Executor RPC request must be an object");
  const item = value as Record<string, unknown>;
  for (const key of ["effectId", "sessionId", "branchId", "executor", "operation", "idempotencyKey"] as const) {
    if (typeof item[key] !== "string") throw new ValidationError(`Executor RPC request requires ${key}`);
  }
  if (typeof item.idempotent !== "boolean" || !Number.isInteger(item.attempt) || Number(item.attempt) < 0 || !isJsonValue(item.input)) {
    throw new ValidationError("Executor RPC request has invalid input, idempotency, or attempt fields");
  }
  return item as unknown as EffectExecutionRequest;
}

/** Real HTTP/RPC boundary for a server-owned executor in a managed sandbox. */
export function createExecutorRpcHandler(
  executor: EffectExecutor,
  policy: RemoteSandboxPolicy,
): (request: Request) => Promise<Response> {
  const descriptor = remoteDescriptor(executor, policy);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/executor/capabilities") return jsonResponse(descriptor);
    if (request.method !== "POST" || url.pathname !== "/v1/executor/execute") {
      return jsonResponse({ error: { code: "NOT_FOUND", message: "Unknown executor RPC route", details: {} } }, 404);
    }
    try {
      const body = await request.json() as { request?: unknown };
      const effect = executionRequest(body.request);
      requireCapability(descriptor.name, `operation:${effect.operation}`, descriptor.capabilities.operations.includes(effect.operation));
      try {
        const execution = await executor.execute(effect, { signal: request.signal });
        return jsonResponse({ execution: normalizeExecution(execution) });
      } catch (error) {
        // The server observed the executor throw, so this is a definitive failed
        // outcome rather than an ambiguous network result.
        return jsonResponse({ execution: result("failed", undefined, error instanceof Error ? error.message : String(error)) });
      }
    } catch (error) { return errorResponse(error); }
  };
}

function isExecutorDescriptor(value: unknown): value is ExecutorPlacementDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>, capabilities = item.capabilities;
  if (typeof item.name !== "string" || item.protocol !== "agencity-executor-rpc-v1" || item.placement !== "remote" || item.transport !== "http" || !capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  const flags = capabilities as Record<string, unknown>;
  return flags.isolation === "managed-remote-sandbox" && flags.isolatedFromHost === true &&
    Array.isArray(flags.operations) && flags.operations.every((operation) => typeof operation === "string") &&
    (flags.filesystem === "sandbox" || flags.filesystem === "none") &&
    (flags.network === "sandbox-policy" || flags.network === "none") &&
    flags.cancellation === "transport-best-effort" && flags.typedOutcomes === true;
}

export interface RemoteSandboxExecutorOptions {
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>);
  readonly requestTimeoutMs?: number;
}

export class RemoteSandboxExecutor implements EffectExecutor {
  readonly name: string;
  readonly placement: ExecutorPlacementDescriptor;
  readonly #endpoint: string;
  readonly #headers?: RemoteSandboxExecutorOptions["headers"];
  readonly #timeoutMs: number;
  private constructor(options: RemoteSandboxExecutorOptions, descriptor: ExecutorPlacementDescriptor) {
    this.#endpoint = normalizedEndpoint(options.endpoint);
    this.#headers = options.headers;
    this.#timeoutMs = options.requestTimeoutMs ?? 120_000;
    this.placement = descriptor;
    this.name = descriptor.name;
  }

  static async connect(options: RemoteSandboxExecutorOptions): Promise<RemoteSandboxExecutor> {
    const endpoint = normalizedEndpoint(options.endpoint);
    let response: Response;
    try {
      const supplied = typeof options.headers === "function" ? await options.headers() : options.headers;
      response = await fetch(`${endpoint}/v1/executor/capabilities`, {
        ...(supplied === undefined ? {} : { headers: supplied }),
        signal: AbortSignal.timeout(options.requestTimeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new DependencyFailureError("Remote executor capability discovery failed", {
        endpoint, cause: error instanceof Error ? error.message : String(error),
      });
    }
    const descriptor = await readWireResponse(response, "Remote executor");
    if (!isExecutorDescriptor(descriptor)) {
      throw new DependencyFailureError("Remote executor did not advertise compatible managed sandbox isolation and capabilities", { endpoint });
    }
    return new RemoteSandboxExecutor(options, descriptor);
  }

  async execute(request: EffectExecutionRequest, context: EffectExecutionContext): Promise<ExecutionResult> {
    requireCapability(this.name, `operation:${request.operation}`, this.placement.capabilities.operations.includes(request.operation));
    if (context.signal.aborted) return result("cancelled", undefined, "Remote execution cancelled before dispatch");
    let response: Response;
    try {
      const supplied = typeof this.#headers === "function" ? await this.#headers() : this.#headers;
      response = await fetch(`${this.#endpoint}/v1/executor/execute`, {
        method: "POST",
        headers: { "content-type": "application/json", ...supplied },
        body: JSON.stringify({ request }),
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(this.#timeoutMs)]),
      });
    } catch (error) {
      return result("unknown", undefined,
        `Remote executor outcome is unknown after transport failure: ${error instanceof Error ? error.message : String(error)}`);
    }
    let body: unknown;
    try { body = await readWireResponse(response, "Remote executor"); }
    catch (error) {
      if (error instanceof AgentRuntimeError && error.code === "CAPABILITY_UNAVAILABLE") throw error;
      return result("unknown", undefined, `Remote executor returned no authoritative outcome: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || !("execution" in body)) {
      return result("unknown", undefined, "Remote executor returned a malformed authoritative outcome");
    }
    try { return normalizeExecution((body as { execution: unknown }).execution); }
    catch (error) {
      return result("unknown", undefined, `Remote executor returned an invalid authoritative outcome: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function normalizeExecution(value: unknown): ExecutionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Execution result must be an object");
  const item = value as Record<string, unknown>;
  if (item.outcome !== "succeeded" && item.outcome !== "failed" && item.outcome !== "cancelled" && item.outcome !== "unknown") {
    throw new ValidationError("Execution result has an invalid outcome");
  }
  if (item.error !== undefined && typeof item.error !== "string") throw new ValidationError("Execution result error must be a string");
  if (item.output !== undefined && !isJsonValue(item.output)) throw new ValidationError("Execution result output must be JSON");
  return result(item.outcome, item.output as JsonValue | undefined, item.error as string | undefined);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).every((item) => item !== undefined && isJsonValue(item));
  return false;
}

import type { EffectOutcome } from "../domain/index.ts";
import type { JsonValue } from "../domain/json.ts";

/** Executor-facing request shape; no storage-adapter type crosses this boundary. */
export interface EffectExecutionRequest {
  readonly effectId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly executor: string;
  readonly operation: string;
  readonly input: JsonValue;
  readonly idempotencyKey: string;
  readonly idempotent: boolean;
  readonly attempt: number;
}
export interface ExecutionResult {
  readonly outcome: EffectOutcome;
  readonly output?: JsonValue;
  readonly error?: string;
}
export interface EffectExecutionContext { readonly signal: AbortSignal }
export interface EffectExecutor {
  readonly name: string;
  execute(request: EffectExecutionRequest, context: EffectExecutionContext): Promise<ExecutionResult>;
}
export function result(outcome: EffectOutcome, output?: JsonValue, error?: string): ExecutionResult {
  return { outcome, ...(output === undefined ? {} : { output }), ...(error === undefined ? {} : { error }) };
}

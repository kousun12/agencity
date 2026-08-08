import type { EffectOutcome, ModelEffectFailureCode } from "../domain/index.ts";
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
  readonly modelFailure?: ModelEffectFailureCode;
}
/**
 * Non-authoritative, process-local progress from a running effect. Progress is
 * never an effect outcome and callers must not use it as dependent state.
 */
export interface EffectExecutionProgress {
  readonly kind: string;
  readonly value: JsonValue;
}
export interface EffectExecutionContext {
  readonly signal: AbortSignal;
  /** Best-effort and non-durable. The outbox may bound or drop notifications. */
  readonly reportProgress?: (progress: EffectExecutionProgress) => void;
}
export interface EffectExecutor {
  readonly name: string;
  execute(request: EffectExecutionRequest, context: EffectExecutionContext): Promise<ExecutionResult>;
}
export function result(outcome: EffectOutcome, output?: JsonValue, error?: string, modelFailure?: ModelEffectFailureCode): ExecutionResult {
  return { outcome, ...(output === undefined ? {} : { output }), ...(error === undefined ? {} : { error }), ...(modelFailure === undefined ? {} : { modelFailure }) };
}

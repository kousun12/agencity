import { ValidationError, type AgentInvocationProfilePin, type RecursiveResponseAdmission } from "../domain/index.ts";
import type { ModelLoop, StructuredModelTurnResult } from "./model-loop.ts";
import type {
  RecursiveModelHandle,
  RecursiveModelService,
  StartRecursiveModelInput,
} from "./models.ts";

/**
 * Supervisor-only capability registry for sealed structured model operations.
 *
 * This module is deliberately excluded from the runtime barrel and the package
 * root: public recursive, console, and protocol inputs must never select a
 * response contract or provider tools. The owning classes register a closure
 * over their hard-private (`#`) methods exactly once at construction, so the
 * only route to structured execution is holding the live in-process instance
 * and importing this internal module directly.
 */

export type StructuredModelTurnRunner = (
  sessionId: string,
  branchId: string,
  responseAdmission: RecursiveResponseAdmission,
  invocation: { readonly invocationId: string; readonly profilePin: AgentInvocationProfilePin },
) => Promise<StructuredModelTurnResult>;

export type StructuredRefinementReviewStarter = (
  parentSessionId: string,
  parentBranchId: string,
  input: StartRecursiveModelInput,
) => Promise<RecursiveModelHandle>;

const STRUCTURED_TURN_RUNNERS = new WeakMap<ModelLoop, StructuredModelTurnRunner>();
const REFINEMENT_REVIEW_STARTERS = new WeakMap<
  RecursiveModelService,
  StructuredRefinementReviewStarter
>();

/** @internal Called once by the `ModelLoop` constructor. */
export function registerStructuredModelTurn(
  loop: ModelLoop,
  runner: StructuredModelTurnRunner,
): void {
  if (STRUCTURED_TURN_RUNNERS.has(loop)) {
    throw new ValidationError(
      "Model loop already registered its structured-turn capability",
    );
  }
  STRUCTURED_TURN_RUNNERS.set(loop, runner);
}

/** @internal Supervisor-only accessor for the registered structured-turn capability. */
export function internalStructuredModelTurn(loop: ModelLoop): StructuredModelTurnRunner {
  const runner = STRUCTURED_TURN_RUNNERS.get(loop);
  if (!runner) {
    throw new ValidationError("Model loop has no registered structured-turn capability");
  }
  return runner;
}

/** @internal Called once by the `RecursiveModelService` constructor. */
export function registerRefinementReviewStarter(
  service: RecursiveModelService,
  starter: StructuredRefinementReviewStarter,
): void {
  if (REFINEMENT_REVIEW_STARTERS.has(service)) {
    throw new ValidationError(
      "Recursive model service already registered its refinement-review capability",
    );
  }
  REFINEMENT_REVIEW_STARTERS.set(service, starter);
}

/** @internal Supervisor-only accessor for the registered refinement-review capability. */
export function internalRefinementReviewStarter(
  service: RecursiveModelService,
): StructuredRefinementReviewStarter {
  const starter = REFINEMENT_REVIEW_STARTERS.get(service);
  if (!starter) {
    throw new ValidationError(
      "Recursive model service has no registered refinement-review capability",
    );
  }
  return starter;
}

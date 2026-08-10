import {
  ValidationError,
  type AgentInvocationProfilePin,
  type AgentPrincipalReference,
  type AgentProfileInput,
  type AgentProfileVersion,
  type NewAgentEvent,
  type RecursiveResponseAdmission,
} from "../domain/index.ts";
import type { AgentProfileService } from "./agent-profiles.ts";
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
export type StructuredRefinementGovernanceStarter =
  StructuredRefinementReviewStarter;
export type GovernedAgentProfilePreparer = (input: {
  readonly targetSessionId: string;
  readonly eventBranchId: string;
  readonly originSessionId: string;
  readonly originBranchId: string;
  readonly expectedActiveProfileVersionId: string;
  readonly replacement: AgentProfileInput;
  readonly createdBy: AgentPrincipalReference;
  readonly reason: string;
  readonly evidenceEventIds: readonly string[];
  readonly proposalId: string;
  readonly reviewDecisionId: string;
}) => Promise<{
  readonly profile: AgentProfileVersion;
  readonly events: readonly NewAgentEvent[];
}>;

const STRUCTURED_TURN_RUNNERS = new WeakMap<ModelLoop, StructuredModelTurnRunner>();
const REFINEMENT_REVIEW_STARTERS = new WeakMap<
  RecursiveModelService,
  StructuredRefinementReviewStarter
>();
const REFINEMENT_GOVERNANCE_STARTERS = new WeakMap<
  RecursiveModelService,
  StructuredRefinementGovernanceStarter
>();
const GOVERNED_AGENT_PROFILE_PREPARERS = new WeakMap<
  AgentProfileService,
  GovernedAgentProfilePreparer
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

/** @internal Called once by the `RecursiveModelService` constructor. */
export function registerRefinementGovernanceStarter(
  service: RecursiveModelService,
  starter: StructuredRefinementGovernanceStarter,
): void {
  if (REFINEMENT_GOVERNANCE_STARTERS.has(service)) {
    throw new ValidationError(
      "Recursive model service already registered its refinement-governance capability",
    );
  }
  REFINEMENT_GOVERNANCE_STARTERS.set(service, starter);
}

/** @internal Supervisor-only accessor for the sealed governance capability. */
export function internalRefinementGovernanceStarter(
  service: RecursiveModelService,
): StructuredRefinementGovernanceStarter {
  const starter = REFINEMENT_GOVERNANCE_STARTERS.get(service);
  if (!starter) {
    throw new ValidationError(
      "Recursive model service has no registered refinement-governance capability",
    );
  }
  return starter;
}

/** @internal Called once by the `AgentProfileService` constructor. */
export function registerGovernedAgentProfilePreparer(
  service: AgentProfileService,
  preparer: GovernedAgentProfilePreparer,
): void {
  if (GOVERNED_AGENT_PROFILE_PREPARERS.has(service)) {
    throw new ValidationError(
      "Agent profile service already registered its governed preparation capability",
    );
  }
  GOVERNED_AGENT_PROFILE_PREPARERS.set(service, preparer);
}

/** @internal Supervisor-only accessor for governed profile preparation. */
export function internalGovernedAgentProfilePreparer(
  service: AgentProfileService,
): GovernedAgentProfilePreparer {
  const preparer = GOVERNED_AGENT_PROFILE_PREPARERS.get(service);
  if (!preparer) {
    throw new ValidationError(
      "Agent profile service has no governed preparation capability",
    );
  }
  return preparer;
}

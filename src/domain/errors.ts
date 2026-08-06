/** Domain errors have stable codes so callers never need to parse messages. */
export class AgentRuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AgentRuntimeError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("VALIDATION_ERROR", message, details);
  }
}

export class ConflictError extends AgentRuntimeError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("CONFLICT", message, details);
  }
}

export class NotFoundError extends AgentRuntimeError {
  constructor(kind: string, id: string) {
    super("NOT_FOUND", `${kind} not found: ${id}`, { kind, id });
  }
}

/** A process/device no longer owns the fenced execution scope it attempted to use. */
export class ExecutionOwnershipConflictError extends AgentRuntimeError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("EXECUTION_OWNERSHIP_CONFLICT", message, details);
  }
}

/** A generated agent attempted to address a session outside its nuclear family. */
export class FamilyReachError extends AgentRuntimeError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("FAMILY_REACH_DENIED", message, details);
  }
}

export class CapabilityUnavailableError extends AgentRuntimeError {
  constructor(capability: string, adapter: string) {
    super("CAPABILITY_UNAVAILABLE", `${adapter} does not provide ${capability}`, {
      capability,
      adapter,
    });
  }
}

export class InvalidTransitionError extends AgentRuntimeError {
  constructor(entity: string, from: string, to: string) {
    super("INVALID_TRANSITION", `Invalid ${entity} transition: ${from} -> ${to}`, {
      entity,
      from,
      to,
    });
  }
}

export class DependencyFailureError extends AgentRuntimeError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("DEPENDENCY_FAILURE", message, details);
  }
}

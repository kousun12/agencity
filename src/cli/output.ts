/** Pure, versioned CLI output contracts. No function in this module performs I/O. */

export const CLI_OUTPUT_PROTOCOL = "agencity.cli-output" as const;
export const CLI_OUTPUT_VERSION = 1 as const;

export const CLI_EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  CONFLICT: 4,
  UNAVAILABLE: 5,
  PERMISSION_DENIED: 6,
  CANCELLED: 130,
} as const);

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

/** Format an admitted managed-service duration without changing typed/JSON milliseconds. */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  const units = [
    { label: "hour", milliseconds: 60 * 60 * 1_000 },
    { label: "minute", milliseconds: 60 * 1_000 },
    { label: "second", milliseconds: 1_000 },
  ] as const;
  let remaining = milliseconds;
  const parts: string[] = [];
  for (const unit of units) {
    const count = Math.floor(remaining / unit.milliseconds);
    if (count === 0) continue;
    parts.push(`${count} ${unit.label}${count === 1 ? "" : "s"}`);
    remaining -= count * unit.milliseconds;
  }
  if (remaining > 0) parts.push(`${remaining} ms`);
  return parts.join(" ");
}

/** Stable v1 mapping. Unknown codes deliberately remain generic failures. */
export const CLI_ERROR_EXIT_CODES: Readonly<Record<string, Exclude<CliExitCode, 0>>> = Object.freeze({
  CLI_ERROR: CLI_EXIT_CODES.FAILURE,
  INTERNAL_ERROR: CLI_EXIT_CODES.FAILURE,
  VALIDATION_ERROR: CLI_EXIT_CODES.USAGE,
  CLI_USAGE: CLI_EXIT_CODES.USAGE,
  UNKNOWN_OPTION: CLI_EXIT_CODES.USAGE,
  MISSING_OPTION: CLI_EXIT_CODES.USAGE,
  NOT_FOUND: CLI_EXIT_CODES.NOT_FOUND,
  CONFLICT: CLI_EXIT_CODES.CONFLICT,
  EXECUTION_OWNERSHIP_CONFLICT: CLI_EXIT_CODES.CONFLICT,
  INVALID_TRANSITION: CLI_EXIT_CODES.CONFLICT,
  DIVERGENT_DUPLICATE_EVENT: CLI_EXIT_CODES.CONFLICT,
  ORIGIN_SEQUENCE_COLLISION: CLI_EXIT_CODES.CONFLICT,
  CONFIG_MISMATCH: CLI_EXIT_CODES.CONFLICT,
  CAPABILITY_UNAVAILABLE: CLI_EXIT_CODES.UNAVAILABLE,
  DEPENDENCY_FAILURE: CLI_EXIT_CODES.UNAVAILABLE,
  PROVIDER_UNAVAILABLE: CLI_EXIT_CODES.UNAVAILABLE,
  FAMILY_REACH_DENIED: CLI_EXIT_CODES.PERMISSION_DENIED,
  PERMISSION_DENIED: CLI_EXIT_CODES.PERMISSION_DENIED,
  CANCELLED: CLI_EXIT_CODES.CANCELLED,
});

export type CliJsonPrimitive = string | number | boolean | null;
export type CliJsonValue = CliJsonPrimitive | readonly CliJsonValue[] | CliJsonObject;
export interface CliJsonObject { readonly [key: string]: CliJsonValue }

export interface CliSuccessEnvelope {
  readonly protocol: typeof CLI_OUTPUT_PROTOCOL;
  readonly version: typeof CLI_OUTPUT_VERSION;
  readonly ok: true;
  readonly command: string;
  readonly exitCode: typeof CLI_EXIT_CODES.SUCCESS;
  readonly message: string;
  readonly data: CliJsonValue;
}

export interface CliErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details: CliJsonObject | null;
}

export interface CliErrorEnvelope {
  readonly protocol: typeof CLI_OUTPUT_PROTOCOL;
  readonly version: typeof CLI_OUTPUT_VERSION;
  readonly ok: false;
  /** Null when argv could not be assigned to a command. */
  readonly command: string | null;
  readonly exitCode: Exclude<CliExitCode, 0>;
  readonly error: CliErrorBody;
}

export type CliOutputEnvelope = CliSuccessEnvelope | CliErrorEnvelope;
export type CliOutputFormat = "human" | "json";

export interface CliSuccessInput {
  readonly command: string;
  readonly message: string;
  readonly data?: CliJsonValue;
}

export interface CliErrorInput {
  readonly command?: string | null;
  readonly code: string;
  readonly message: string;
  readonly details?: CliJsonObject | null;
  /** May only restate the stable mapping, never override it. */
  readonly exitCode?: Exclude<CliExitCode, 0>;
}

export interface CliOutputPlan {
  readonly exitCode: CliExitCode;
  readonly stdout: string | null;
  readonly stderr: string | null;
}

export function exitCodeForCliError(code: string): Exclude<CliExitCode, 0> {
  return CLI_ERROR_EXIT_CODES[code] ?? CLI_EXIT_CODES.FAILURE;
}

/** Build the only admitted v1 success shape and snapshot its JSON payload. */
export function createCliSuccessEnvelope(input: CliSuccessInput): CliSuccessEnvelope {
  const command = requiredSingleLine(input.command, "CLI output command");
  const message = requiredString(input.message, "CLI success message", true);
  const data = cloneJson(Object.prototype.hasOwnProperty.call(input, "data") ? input.data : null);
  return Object.freeze({
    protocol: CLI_OUTPUT_PROTOCOL,
    version: CLI_OUTPUT_VERSION,
    ok: true,
    command,
    exitCode: CLI_EXIT_CODES.SUCCESS,
    message,
    data,
  });
}

/**
 * Build the only admitted v1 error shape. A supplied exit code is accepted only
 * when it equals the stable code-derived value, preventing caller drift.
 */
export function createCliErrorEnvelope(input: CliErrorInput): CliErrorEnvelope {
  const code = requiredErrorCode(input.code);
  const message = requiredString(input.message, "CLI error message", false);
  const command = input.command == null ? null : requiredSingleLine(input.command, "CLI output command");
  const mappedExitCode = exitCodeForCliError(code);
  if (input.exitCode !== undefined && input.exitCode !== mappedExitCode) {
    throw new Error(`Exit code ${input.exitCode} does not match ${code}'s stable CLI exit code ${mappedExitCode}`);
  }
  const detailsValue = input.details == null ? null : cloneJson(input.details);
  if (detailsValue !== null && (Array.isArray(detailsValue) || typeof detailsValue !== "object")) {
    throw new Error("CLI error details must be a JSON object or null");
  }
  const details = detailsValue as CliJsonObject | null;
  const error = Object.freeze({ code, message, details });
  return Object.freeze({
    protocol: CLI_OUTPUT_PROTOCOL,
    version: CLI_OUTPUT_VERSION,
    ok: false,
    command,
    exitCode: mappedExitCode,
    error,
  });
}

/** Turn an unknown thrown value into a safe, structurally stable v1 error. */
export function cliErrorEnvelopeFromUnknown(error: unknown, command: string | null = null): CliErrorEnvelope {
  if (hasStringProperty(error, "code") && /^[A-Z][A-Z0-9_]*$/.test(error.code) &&
      hasStringProperty(error, "message") && error.message.length > 0 && !error.message.includes("\0")) {
    const details = hasProperty(error, "details") && isCliJsonObject(error.details)
      ? error.details
      : null;
    return createCliErrorEnvelope({ command, code: error.code, message: error.message, details });
  }
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.replaceAll("\0", "�") || "Unknown CLI error";
  return createCliErrorEnvelope({ command, code: "CLI_ERROR", message });
}

/** Render exactly one envelope. JSON is compact and newline-free for composition. */
export function renderCliEnvelope(envelope: CliOutputEnvelope, format: CliOutputFormat): string {
  const admitted = parseCliOutputEnvelope(envelope);
  if (format === "json") return JSON.stringify(admitted);
  if (admitted.ok) return admitted.message;
  return `Agencity error [${admitted.error.code}]: ${admitted.error.message}`;
}

/** Choose stdout/stderr and exit status without performing writes or exiting. */
export function planCliOutput(envelope: CliOutputEnvelope, format: CliOutputFormat): CliOutputPlan {
  const admitted = parseCliOutputEnvelope(envelope);
  const rendered = renderCliEnvelope(admitted, format);
  return admitted.ok
    ? Object.freeze({ exitCode: admitted.exitCode, stdout: rendered, stderr: null })
    : Object.freeze({ exitCode: admitted.exitCode, stdout: null, stderr: rendered });
}

/**
 * Strictly admit a v1 envelope from an untrusted boundary. Unknown/missing
 * fields, wrong protocol/version, non-JSON data, and mismatched exit codes fail.
 */
export function parseCliOutputEnvelope(value: unknown): CliOutputEnvelope {
  if (!isRecord(value)) throw new Error("CLI output envelope must be an object");
  if (value.protocol !== CLI_OUTPUT_PROTOCOL || value.version !== CLI_OUTPUT_VERSION || typeof value.ok !== "boolean") {
    throw new Error(`CLI output envelope must use ${CLI_OUTPUT_PROTOCOL} v${CLI_OUTPUT_VERSION}`);
  }
  if (value.ok) {
    assertExactKeys(value, ["protocol", "version", "ok", "command", "exitCode", "message", "data"]);
    if (value.exitCode !== CLI_EXIT_CODES.SUCCESS) throw new Error("CLI success exit code must be 0");
    return createCliSuccessEnvelope({
      command: assertString(value.command, "CLI output command"),
      message: assertString(value.message, "CLI success message"),
      data: cloneJson(value.data),
    });
  }
  assertExactKeys(value, ["protocol", "version", "ok", "command", "exitCode", "error"]);
  if (!isRecord(value.error)) throw new Error("CLI error body must be an object");
  assertExactKeys(value.error, ["code", "message", "details"]);
  const details = value.error.details;
  if (details !== null && !isCliJsonObject(details)) throw new Error("CLI error details must be a JSON object or null");
  const command = value.command === null ? null : assertString(value.command, "CLI output command");
  const numericExitCode = value.exitCode;
  if (typeof numericExitCode !== "number") throw new Error("CLI error exit code must be numeric");
  return createCliErrorEnvelope({
    command,
    code: assertString(value.error.code, "CLI error code"),
    message: assertString(value.error.message, "CLI error message"),
    details,
    exitCode: numericExitCode as Exclude<CliExitCode, 0>,
  });
}

function requiredErrorCode(value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(value)) throw new Error("CLI error code must be stable uppercase snake case");
  return value;
}

function requiredSingleLine(value: string, label: string): string {
  const result = requiredString(value, label, false);
  if (result.trim() !== result || /[\r\n\0]/.test(result)) throw new Error(`${label} must be unpadded and single-line`);
  return result;
}

function requiredString(value: string, label: string, allowEmpty: boolean): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || /\0/.test(value)) {
    throw new Error(`${label} must be ${allowEmpty ? "a NUL-free string" : "a non-empty NUL-free string"}`);
  }
  return value;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function cloneJson(value: unknown, seen = new WeakSet<object>(), depth = 0): CliJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CLI JSON numbers must be finite");
    return value;
  }
  if (typeof value !== "object") throw new Error(`CLI output contains a non-JSON ${typeof value} value`);
  if (depth >= 64) throw new Error("CLI output exceeds the maximum JSON depth of 64");
  if (seen.has(value)) throw new Error("CLI output cannot contain cyclic data");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item) => cloneJson(item, seen, depth + 1)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("CLI output objects must be plain JSON objects");
    const result: Record<string, CliJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(result, key, {
        value: cloneJson(item, seen, depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
}

function isCliJsonObject(value: unknown): value is CliJsonObject {
  if (!isRecord(value) || Array.isArray(value)) return false;
  try {
    const cloned = cloneJson(value);
    return cloned !== null && !Array.isArray(cloned) && typeof cloned === "object";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasProperty<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return isRecord(value) && key in value;
}

function hasStringProperty<K extends string>(value: unknown, key: K): value is Record<K, string> {
  return hasProperty(value, key) && typeof value[key] === "string";
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`CLI output envelope fields must be exactly: ${expected.join(", ")}`);
  }
}

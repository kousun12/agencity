import type { JsonValue } from "../domain/json.ts";

const encoder = new TextEncoder();
/** Structured observations above this bound move to the content-addressed store. */
export const MAX_CELL_OBSERVATION_JSON_BYTES = 128 * 1024;
const SENSITIVE_PREVIEW_KEY = /(?:api[-_]?key|token|secret|password|passwd|credential|authorization|cookie|private[-_]?key)/i;
const REDACTED = "[REDACTED]";

export const INSPECT_HARD_LIMITS = Object.freeze({
  depth: 8,
  entries: 200,
  lines: 100,
  bytes: 16 * 1024,
  getters: 0,
});

export const INSPECT_DEFAULT_LIMITS = Object.freeze({
  depth: 4,
  entries: 50,
  lines: 40,
  bytes: 8 * 1024,
  getters: 0,
});

export interface InspectOptions {
  readonly depth?: number;
  /** Total properties and array positions visited across the preview. */
  readonly entries?: number;
  readonly lines?: number;
  readonly bytes?: number;
  /** Additional exact, case-insensitive property names to redact. */
  readonly redact?: readonly string[];
}

export interface InspectPreview {
  readonly kind: "inspect";
  readonly preview: string;
  readonly truncated: boolean;
  readonly redacted: number;
  readonly omittedGetters: number;
  readonly limits: {
    readonly depth: number;
    readonly entries: number;
    readonly lines: number;
    readonly bytes: number;
    readonly getters: 0;
  };
}

export type EncodedObservation =
  | { readonly kind: "json"; readonly json: string; readonly byteLength: number; readonly preview: InspectPreview }
  | { readonly kind: "unsupported"; readonly reason: string; readonly preview: InspectPreview };

interface PreviewBudget {
  entries: number;
  redacted: number;
  omittedGetters: number;
  truncated: boolean;
  readonly limits: InspectPreview["limits"];
  readonly additionalRedactions: ReadonlySet<string>;
  readonly ancestors: Set<object>;
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function limits(options: InspectOptions = {}): InspectPreview["limits"] {
  return {
    depth: boundedInteger(options.depth, INSPECT_DEFAULT_LIMITS.depth, INSPECT_HARD_LIMITS.depth),
    entries: boundedInteger(options.entries, INSPECT_DEFAULT_LIMITS.entries, INSPECT_HARD_LIMITS.entries),
    lines: boundedInteger(options.lines, INSPECT_DEFAULT_LIMITS.lines, INSPECT_HARD_LIMITS.lines),
    bytes: boundedInteger(options.bytes, INSPECT_DEFAULT_LIMITS.bytes, INSPECT_HARD_LIMITS.bytes),
    getters: 0,
  };
}

function clipped(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  const marker = "…";
  const markerBytes = encoder.encode(marker).byteLength;
  let text = "";
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maximumBytes) {
      if (maximumBytes < markerBytes) return { text: ".".repeat(maximumBytes), truncated: true };
      while (text && bytes + markerBytes > maximumBytes) {
        const last = [...text].at(-1)!;
        text = text.slice(0, -last.length);
        bytes -= encoder.encode(last).byteLength;
      }
      return { text: `${text}${marker}`, truncated: true };
    }
    text += character;
    bytes += size;
  }
  return { text, truncated: false };
}

function propertyIsSensitive(key: string, budget: PreviewBudget): boolean {
  return SENSITIVE_PREVIEW_KEY.test(key) || budget.additionalRedactions.has(key.toLowerCase());
}

function className(value: object): string {
  try {
    const prototype = Object.getPrototypeOf(value) as { constructor?: unknown } | null;
    if (prototype === null) return "Object(null prototype)";
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
    const constructor = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (typeof constructor === "function" && constructor.name) return clipped(constructor.name, 128).text;
  } catch { /* a proxy may reject introspection */ }
  return "Object";
}

function primitivePreview(value: unknown, budget: PreviewBudget): JsonValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "[NaN]";
    if (value === Infinity) return "[Infinity]";
    if (value === -Infinity) return "[-Infinity]";
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    const result = clipped(value, Math.min(2 * 1024, budget.limits.bytes));
    if (result.truncated) budget.truncated = true;
    return result.text;
  }
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "bigint") return `[BigInt ${clipped(value.toString(), 256).text}]`;
  if (typeof value === "symbol") return `[Symbol ${clipped(value.description ?? "", 256).text}]`;
  if (typeof value === "function") return `[Function ${clipped(value.name || "anonymous", 128).text}]`;
  return undefined;
}

function previewValue(value: unknown, depth: number, budget: PreviewBudget): JsonValue {
  const primitive = primitivePreview(value, budget);
  if (primitive !== undefined) return primitive;
  if (typeof value !== "object" || value === null) return `[Unsupported ${typeof value}]`;
  if (budget.ancestors.has(value)) {
    budget.truncated = true;
    return "[Circular]";
  }
  if (depth >= budget.limits.depth) {
    budget.truncated = true;
    return "[MaxDepth]";
  }
  budget.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output: JsonValue[] = [];
      let length = 0;
      try { length = value.length; } catch { return ["[Uninspectable Array]"]; }
      for (let index = 0; index < length; index++) {
        if (budget.entries >= budget.limits.entries) {
          budget.truncated = true;
          output.push(`[${length - index} more entries]`);
          break;
        }
        budget.entries++;
        let descriptor: PropertyDescriptor | undefined;
        try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); }
        catch {
          budget.truncated = true;
          output.push("[Uninspectable]");
          continue;
        }
        if (!descriptor) {
          output.push("[Empty]");
        } else if (!("value" in descriptor)) {
          budget.omittedGetters++;
          output.push("[Getter omitted]");
        } else {
          output.push(previewValue(descriptor.value, depth + 1, budget));
        }
      }
      return output;
    }

    let keys: string[];
    try { keys = Object.keys(value); }
    catch {
      budget.truncated = true;
      return { "[Uninspectable]": className(value) };
    }
    const output: Record<string, JsonValue> = {};
    let prototype: object | null | undefined;
    try { prototype = Object.getPrototypeOf(value); } catch { prototype = undefined; }
    if (prototype !== Object.prototype && prototype !== null) output["[Type]"] = className(value);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      if (budget.entries >= budget.limits.entries) {
        budget.truncated = true;
        output["[More entries]"] = keys.length - index;
        break;
      }
      budget.entries++;
      const displayedKey = clipped(key, 256);
      if (displayedKey.truncated) budget.truncated = true;
      if (propertyIsSensitive(key, budget)) {
        budget.redacted++;
        output[displayedKey.text] = REDACTED;
        continue;
      }
      let descriptor: PropertyDescriptor | undefined;
      try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
      catch {
        budget.truncated = true;
        output[displayedKey.text] = "[Uninspectable]";
        continue;
      }
      if (!descriptor || !("value" in descriptor)) {
        budget.omittedGetters++;
        output[displayedKey.text] = "[Getter omitted]";
      } else {
        output[displayedKey.text] = previewValue(descriptor.value, depth + 1, budget);
      }
    }
    return output;
  } finally {
    budget.ancestors.delete(value);
  }
}

/**
 * Produces a deterministic JSON-shaped textual preview. Accessors are never
 * invoked, circular references are marked, and credential-shaped keys are
 * always redacted. Options can only narrow or raise limits up to the hard caps.
 */
export function inspectValue(value: unknown, options: InspectOptions = {}): InspectPreview {
  const resolved = limits(options);
  const budget: PreviewBudget = {
    entries: 0,
    redacted: 0,
    omittedGetters: 0,
    truncated: false,
    limits: resolved,
    additionalRedactions: new Set(
      Array.isArray(options.redact)
        ? options.redact.filter((item): item is string => typeof item === "string").slice(0, 32).map((item) => item.toLowerCase())
        : [],
    ),
    ancestors: new Set(),
  };
  let normalized: JsonValue;
  try { normalized = previewValue(value, 0, budget); }
  catch {
    budget.truncated = true;
    normalized = "[Uninspectable]";
  }
  let text = JSON.stringify(normalized, null, 2);
  const lineValues = text.split("\n");
  if (lineValues.length > resolved.lines) {
    text = `${lineValues.slice(0, Math.max(1, resolved.lines - 1)).join("\n")}\n…`;
    budget.truncated = true;
  }
  const byteLimited = clipped(text, resolved.bytes);
  if (byteLimited.truncated) budget.truncated = true;
  return {
    kind: "inspect",
    preview: byteLimited.text,
    truncated: budget.truncated,
    redacted: budget.redacted,
    omittedGetters: budget.omittedGetters,
    limits: resolved,
  };
}

class UnsupportedJsonObservation extends Error {}

function strictJson(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnsupportedJsonObservation(`Non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new UnsupportedJsonObservation(`Value at ${path} is not JSON serializable (${typeof value})`);
  if (ancestors.has(value)) throw new UnsupportedJsonObservation(`Circular reference at ${path}`);

  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(value); }
  catch { throw new UnsupportedJsonObservation(`Object at ${path} cannot be inspected safely`); }
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new UnsupportedJsonObservation(`Non-plain object at ${path} (${className(value)})`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      let length: number;
      try { length = value.length; }
      catch { throw new UnsupportedJsonObservation(`Array at ${path} cannot be inspected safely`); }
      const output: JsonValue[] = [];
      for (let index = 0; index < length; index++) {
        let descriptor: PropertyDescriptor | undefined;
        try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); }
        catch { throw new UnsupportedJsonObservation(`Array entry at ${path}[${index}] cannot be inspected safely`); }
        if (!descriptor) output.push(null); // JSON.stringify turns array holes into null.
        else if (!("value" in descriptor)) throw new UnsupportedJsonObservation(`Getter at ${path}[${index}] is not invoked`);
        else output.push(strictJson(descriptor.value, `${path}[${index}]`, ancestors));
      }
      return output;
    }

    let keys: string[];
    try { keys = Object.keys(value); }
    catch { throw new UnsupportedJsonObservation(`Object at ${path} cannot be inspected safely`); }
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of keys) {
      let descriptor: PropertyDescriptor | undefined;
      try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
      catch { throw new UnsupportedJsonObservation(`Property ${path}.${clipped(key, 128).text} cannot be inspected safely`); }
      if (!descriptor || !("value" in descriptor)) {
        throw new UnsupportedJsonObservation(`Getter at ${path}.${clipped(key, 128).text} is not invoked`);
      }
      Object.defineProperty(output, key, {
        value: strictJson(descriptor.value, `${path}.${clipped(key, 128).text}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

/** Encodes a result before IPC so cyclic/class-backed values cannot corrupt it. */
export function encodeObservation(value: unknown): EncodedObservation {
  const normalized = value === undefined ? null : value;
  const preview = inspectValue(normalized);
  try {
    const json = JSON.stringify(strictJson(normalized, "$", new Set()));
    return { kind: "json", json, byteLength: encoder.encode(json).byteLength, preview };
  } catch (error) {
    const reason = error instanceof UnsupportedJsonObservation ? error.message : "Value is not safely JSON serializable";
    return { kind: "unsupported", reason: clipped(reason, 1024).text, preview };
  }
}

import { ValidationError } from "./errors.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const MAX_WORKING_JSON_BYTES = 128 * 1024;

export function assertJsonValue(value: unknown, path = "$", seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationError(`Non-finite number at ${path}`);
    return;
  }
  if (typeof value !== "object") throw new ValidationError(`Value at ${path} is not JSON serializable`);
  if (seen.has(value)) throw new ValidationError(`Circular value at ${path}`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen));
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new ValidationError(`Non-plain object at ${path}`);
    }
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

export function jsonBytes(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

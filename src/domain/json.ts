import { ValidationError } from "./errors.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Sha256Digest = `sha256:${string}`;

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
    const keys = Object.keys(value);
    if (keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))) {
      throw new ValidationError(`Sparse or extended array at ${path} is not a JSON value`);
    }
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen));
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new ValidationError(`Non-plain object at ${path}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new ValidationError(`Symbol-keyed property at ${path} is not a JSON value`);
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

/**
 * Locale-independent JSON encoding for retained identities and byte bounds.
 * Object keys are sorted while array order and JSON scalar values are preserved.
 */
export function canonicalJsonStringify(value: unknown): string {
  assertJsonValue(value);
  return encodeCanonicalJson(value);
}

export function canonicalJsonByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJsonStringify(value)).byteLength;
}

export function canonicalJsonDigest(value: unknown): Sha256Digest {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonicalJsonStringify(value));
  return `sha256:${hasher.digest("hex")}`;
}

function encodeCanonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encodeCanonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${encodeCanonicalJson(value[key]!)}`).join(",")}}`;
}

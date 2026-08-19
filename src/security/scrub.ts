import type { JsonValue } from "../domain/json.ts";
import {
  brokeredSecretValues,
  registerBrokeredSecretValue,
} from "./secret-registry.ts";

const REDACTED = "[REDACTED]";
const PRIVATE_ENVIRONMENT_KEYS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AI_GATEWAY_API_KEY",
  "TURSO_AUTH_TOKEN",
]);

/**
 * Registers a supervisor-side credential value for rejection and redaction.
 * The returned release function is reference-counted so multiple local
 * supervisors may safely broker the same credential in one process.
 */
export function registerBrokeredSecret(value: string): () => void {
  return registerBrokeredSecretValue(value);
}

/** Removes runtime-owned private variables before starting generated code or shell tools. */
export function environmentWithoutSecrets(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !isRuntimePrivateEnvironmentKey(key)) result[key] = value;
  }
  return result;
}

export function scrubText(text: string): string {
  let scrubbed = text;
  for (const secret of brokeredSecretValues()) scrubbed = scrubbed.split(secret).join(REDACTED);
  return scrubbed;
}

/**
 * Scrubs exact registered values from streaming UTF-8 text, including values
 * split across source chunks. Values registered during a stream are added to
 * its retained set; values released during the stream remain protected.
 */
export class StreamingTextScrubber {
  readonly #decoder = new TextDecoder();
  readonly #secrets = new Set<string>();
  #pending = "";

  constructor() {
    this.#refreshSecrets();
  }

  /** Exposes retained streaming state for bounded-memory tests. */
  get bufferedCharacterCount(): number {
    return this.#pending.length;
  }

  push(chunk: Uint8Array): string {
    this.#refreshSecrets();
    this.#pending += this.#decoder.decode(chunk, { stream: true });
    return this.#drain(false);
  }

  #drain(final: boolean): string {
    const secrets = [...this.#secrets].sort((left, right) =>
      right.length - left.length || left.localeCompare(right)
    );
    if (final || secrets.length === 0) {
      const emitted = this.#scrub(this.#pending, secrets);
      this.#pending = "";
      return emitted;
    }
    const longestSecret = secrets[0]!.length;
    if (this.#pending.length <= longestSecret) return "";
    let safeEnd = this.#pending.length - longestSecret;
    while (safeEnd > 0) {
      let crossingStart = safeEnd;
      for (const secret of secrets) {
        const earliest = Math.max(0, safeEnd - secret.length + 1);
        for (let start = earliest; start < safeEnd; start++) {
          if (start + secret.length > safeEnd &&
              this.#pending.startsWith(secret, start)) {
            crossingStart = Math.min(crossingStart, start);
            break;
          }
        }
      }
      if (crossingStart === safeEnd) break;
      safeEnd = crossingStart;
    }
    const emitted = this.#pending.slice(0, safeEnd);
    this.#pending = this.#pending.slice(safeEnd);
    return this.#scrub(emitted, secrets);
  }

  #refreshSecrets(): void {
    for (const secret of brokeredSecretValues()) this.#secrets.add(secret);
  }

  #scrub(text: string, secrets: readonly string[]): string {
    let scrubbed = text;
    for (const secret of secrets) scrubbed = scrubbed.split(secret).join(REDACTED);
    return scrubbed;
  }

  finish(): string {
    this.#refreshSecrets();
    this.#pending += this.#decoder.decode();
    return this.#drain(true);
  }
}

/**
 * Redacts occurrences of actual credential values known to the supervisor.
 *
 * Key names are deliberately preserved: ordinary domain payloads commonly use
 * names such as `token`, `auth`, or `password` without containing a credential.
 * Mutating those values would corrupt canonical application data. Inputs that
 * contain a known credential are rejected at command/storage boundaries; this
 * function is for executor outputs, logs, and errors that must remain useful.
 */
export function scrubJson(value: JsonValue): JsonValue {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(scrubJson);
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) result[scrubText(key)] = scrubJson(item);
  return result;
}

/** Brokered credentials may be referenced by opaque handles, never copied into durable requests. */
export function containsBrokeredSecret(value: JsonValue): boolean {
  const secrets = brokeredSecretValues();
  const contains = (candidate: JsonValue): boolean => {
    if (typeof candidate === "string") {
      return secrets.some((secret) => candidate.includes(secret));
    }
    if (candidate === null || typeof candidate === "number" ||
        typeof candidate === "boolean") return false;
    if (Array.isArray(candidate)) return candidate.some(contains);
    return Object.entries(candidate).some(([key, item]) =>
      secrets.some((secret) => key.includes(secret)) || contains(item)
    );
  };
  return contains(value);
}

export function isRuntimePrivateEnvironmentKey(key: string): boolean {
  return PRIVATE_ENVIRONMENT_KEYS.has(key) || key.startsWith("AGENCITY_");
}

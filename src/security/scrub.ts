import type { JsonValue } from "../domain/json.ts";

const SENSITIVE_KEY = /(?:^|_)(?:api_?key|token|secret|password|passwd|credential|authorization|auth)(?:_|$)/i;
const REDACTED = "[REDACTED]";

function knownSecrets(environment: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(environment)
    .filter(([key, value]) => SENSITIVE_KEY.test(key) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}

/**
 * Rejects a value that is either a credential currently brokered through the
 * environment or recognizable raw credential material. Opaque handles such as
 * `env:OPENAI_API_KEY` and ordinary labels such as `OpenAI production` remain
 * valid because they contain neither the value nor raw material.
 */
export function containsCredentialMaterial(text: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  if (knownSecrets(environment).some(secret => text.includes(secret))) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true;
  if (/(?:^|\s)(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]{8,}(?:$|\s)/i.test(text)) return true;
  if (/(?:^|[^A-Za-z0-9_-])(?:sk-(?:(?:live|test|proj)[-_]?)?|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|AIza)[A-Za-z0-9_-]{8,}/.test(text)) return true;
  if (/(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])/.test(text)) return true;
  // Do not treat `credential:handle-name` as an assignment: it is a valid
  // opaque reference scheme. Raw credential assignments use concrete secret
  // field names, while reference descriptors are checked structurally by the
  // profile store.
  if (/(?:password|passwd|secret|auth[_-]?token|api[_-]?key)\s*[:=]\s*[^\s,;]+/i.test(text)) return true;
  for (const match of text.matchAll(/(?:https?|libsql):\/\/[^\s]+/gi)) {
    try {
      const url = new URL(match[0]);
      if (url.username || url.password) return true;
      if ([...url.searchParams.keys()].some(key => SENSITIVE_KEY.test(key))) return true;
    } catch {
      // A malformed URL is handled by the caller's ordinary field validation.
    }
  }
  return false;
}

/** Removes credential-shaped environment variables before starting generated code or shell tools. */
export function environmentWithoutSecrets(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !SENSITIVE_KEY.test(key) && !key.startsWith("AGENCITY_")) result[key] = value;
  }
  return result;
}

export function scrubText(text: string): string {
  let scrubbed = text;
  for (const secret of knownSecrets()) scrubbed = scrubbed.split(secret).join(REDACTED);
  return scrubbed;
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
  for (const [key, item] of Object.entries(value)) result[key] = scrubJson(item);
  return result;
}

/** Brokered credentials may be referenced by opaque handles, never copied into durable requests. */
export function containsBrokeredSecret(value: JsonValue): boolean {
  const serialized = JSON.stringify(value);
  return knownSecrets().some((secret) => serialized.includes(secret));
}

export function isSensitiveEnvironmentKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

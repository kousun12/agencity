import type { JsonValue } from "../domain/json.ts";

const SENSITIVE_KEY = /(?:^|_)(?:api_?key|token|secret|password|passwd|credential|authorization|auth)(?:_|$)/i;
const REDACTED = "[REDACTED]";
const STREAMING_PREFIX_GUARD_CHARACTERS = 128;
const brokeredSecrets = new Map<string, number>();

function knownSecrets(environment: NodeJS.ProcessEnv = process.env): string[] {
  const environmentSecrets = Object.entries(environment)
    .filter(([key, value]) => SENSITIVE_KEY.test(key) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value as string);
  return [...new Set([...environmentSecrets, ...brokeredSecrets.keys()])]
    .sort((left, right) => right.length - left.length);
}

/**
 * Registers a supervisor-side credential value for rejection and redaction.
 * The returned release function is reference-counted so multiple local
 * supervisors may safely broker the same credential in one process.
 */
export function registerBrokeredSecret(value: string): () => void {
  if (value.length < 4) throw new Error("Brokered credentials must contain at least four characters");
  brokeredSecrets.set(value, (brokeredSecrets.get(value) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (brokeredSecrets.get(value) ?? 1) - 1;
    if (remaining <= 0) brokeredSecrets.delete(value);
    else brokeredSecrets.set(value, remaining);
  };
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

/** Output-only redaction for recognizable raw credential shapes. */
export function scrubCredentialText(text: string): string {
  const scrubbedUrls = text.replace(/(?:https?|libsql):\/\/[^\s]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      if (!url.username && !url.password && ![...url.searchParams.keys()].some((key) => SENSITIVE_KEY.test(key))) {
        return candidate;
      }
      return REDACTED;
    } catch {
      return candidate;
    }
  });
  return scrubText(scrubbedUrls)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED)
    .replace(/(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]{8,}/gi, REDACTED)
    .replace(/(?:sk-(?:(?:live|test|proj)[-_]?)?|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|AIza)[A-Za-z0-9_-]{8,}/g, REDACTED)
    .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED)
    .replace(/((?:password|passwd|secret|auth[_-]?token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED}`);
}

/**
 * Scrubs streaming UTF-8 text while retaining enough suffix to recognize
 * known secrets and credential-shaped values split across source chunks.
 */
export class StreamingTextScrubber {
  readonly #decoder = new TextDecoder();
  readonly #holdCharacters: number;
  #pending = "";
  #insidePrivateKey = false;
  #credentialRun: "token" | "assignment" | "url" | null = null;

  constructor() {
    const longestKnownSecret = knownSecrets().reduce((maximum, secret) => Math.max(maximum, secret.length), 0);
    this.#holdCharacters = Math.max(1_024, longestKnownSecret + 32);
  }

  /** Exposes retained streaming state for bounded-memory tests. */
  get bufferedCharacterCount(): number {
    return this.#pending.length;
  }

  push(chunk: Uint8Array): string {
    return this.#pushText(this.#decoder.decode(chunk, { stream: true }));
  }

  #pushText(decoded: string): string {
    let incoming = decoded;
    if (this.#credentialRun) {
      let end = 0;
      while (end < incoming.length && this.#continuesCredential(incoming[end]!)) end++;
      if (end === incoming.length) return "";
      incoming = incoming.slice(end);
      this.#credentialRun = null;
    }
    this.#pending += incoming;
    let privateKeyRedactions = "";
    while (true) {
      if (this.#insidePrivateKey) {
        const end = /-----END [A-Z ]*PRIVATE KEY-----/.exec(this.#pending);
        if (!end) {
          // Private-key bodies are discarded, but retain a bounded suffix so an
          // END marker split across source chunks can terminate the redaction.
          const marker = this.#pending.lastIndexOf("-----");
          this.#pending = (marker >= 0 ? this.#pending.slice(marker) : this.#pending.slice(-32))
            .slice(-256);
          return privateKeyRedactions;
        }
        this.#pending = this.#pending.slice(end.index + end[0].length);
        this.#insidePrivateKey = false;
        continue;
      }
      const begin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.exec(this.#pending);
      if (!begin) break;
      privateKeyRedactions += scrubCredentialText(this.#pending.slice(0, begin.index)) + REDACTED;
      this.#pending = this.#pending.slice(begin.index + begin[0].length);
      this.#insidePrivateKey = true;
    }
    if (this.#pending.length <= this.#holdCharacters + STREAMING_PREFIX_GUARD_CHARACTERS) {
      return privateKeyRedactions;
    }
    let safeEnd = this.#pending.length - this.#holdCharacters - STREAMING_PREFIX_GUARD_CHARACTERS;
    const candidate = this.#pending.slice(0, safeEnd);
    for (const secret of knownSecrets()) {
      const maximum = Math.min(secret.length - 1, candidate.length);
      for (let length = maximum; length > 0; length--) {
        if (candidate.endsWith(secret.slice(0, length))) {
          safeEnd -= length;
          break;
        }
      }
    }
    const credentialPrefix = this.#pending.slice(0, safeEnd).match(
      /(?:Bearer\s+|Basic\s+|sk-(?:(?:live|test|proj)[-_]?)?|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|AIza)[A-Za-z0-9+/_.=-]*$|(?:password|passwd|secret|auth[_-]?token|api[_-]?key)\s*[:=]\s*[^\s,;]*$|(?:https?|libsql):\/\/[^\s]*$/i,
    );
    if (credentialPrefix) {
      const matchStart = safeEnd - credentialPrefix[0].length;
      const retainedCredentialLength = this.#pending.length - matchStart;
      if (retainedCredentialLength > this.#holdCharacters + 4_096) {
        const mode = /^(?:https?|libsql):\/\//i.test(credentialPrefix[0])
          ? "url"
          : /^(?:password|passwd|secret|auth[_-]?token|api[_-]?key)\s*[:=]/i.test(credentialPrefix[0])
            ? "assignment"
            : "token";
        const before = this.#pending.slice(0, matchStart);
        const continuation = this.#pending.slice(safeEnd);
        this.#pending = "";
        this.#credentialRun = mode;
        let end = 0;
        while (end < continuation.length && this.#continuesCredential(continuation[end]!)) end++;
        if (end < continuation.length) {
          this.#credentialRun = null;
          this.#pending = continuation.slice(end);
        }
        return privateKeyRedactions + scrubCredentialText(before) + REDACTED;
      }
      safeEnd = matchStart;
    }
    const emitted = this.#pending.slice(0, safeEnd);
    this.#pending = this.#pending.slice(safeEnd);
    return privateKeyRedactions + scrubCredentialText(emitted);
  }

  #continuesCredential(character: string): boolean {
    if (this.#credentialRun === "assignment") return !/[\s,;]/.test(character);
    if (this.#credentialRun === "url") return !/\s/.test(character);
    return /[A-Za-z0-9+/_.=-]/.test(character);
  }

  finish(): string {
    const streamed = this.#pushText(this.#decoder.decode());
    if (this.#credentialRun) {
      this.#credentialRun = null;
      this.#pending = "";
      this.#insidePrivateKey = false;
      return streamed;
    }
    const emitted = this.#insidePrivateKey
      ? ""
      : scrubCredentialText(this.#pending.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g, REDACTED));
    this.#pending = "";
    this.#insidePrivateKey = false;
    return streamed + emitted;
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
  const serialized = JSON.stringify(value);
  return knownSecrets().some((secret) => serialized.includes(secret));
}

export function isSensitiveEnvironmentKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

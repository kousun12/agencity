import { ValidationError } from "./errors.ts";
import type { JsonValue } from "./json.ts";
import type { AgentState } from "./state.ts";

export const SESSION_TITLE_MODEL = "openai/gpt-5.6-luna" as const;
export const SESSION_TITLE_MAX_WORDS = 6;
export const SESSION_TITLE_FIELD_LIMITS = Object.freeze({
  verb: 64,
  subject: 160,
  intentSummary: 512,
  title: 256,
});

export const SESSION_TITLE_SCHEMA: JsonValue = Object.freeze({
  type: "object",
  properties: {
    verb: {
      type: "string",
      minLength: 1,
      maxLength: SESSION_TITLE_FIELD_LIMITS.verb,
      description: "A concise semantic action verb or verb phrase. This is free-form, not an enum.",
    },
    subject: {
      type: "string",
      minLength: 1,
      maxLength: SESSION_TITLE_FIELD_LIMITS.subject,
      description: "The concise object of the user's work.",
    },
    intentSummary: {
      type: "string",
      minLength: 1,
      maxLength: SESSION_TITLE_FIELD_LIMITS.intentSummary,
      description: "A one-line summary of the user's cumulative intent.",
    },
  },
  required: ["verb", "subject", "intentSummary"],
  additionalProperties: false,
});

export const SESSION_TITLE_SYSTEM_INSTRUCTION = [
  "Maintain a concise title for this session using only the chronological user messages supplied.",
  "Return one structured value with a free-form semantic verb or verb phrase, a concise subject, and a one-line intent summary.",
  "The title will be constructed from verb plus subject and must describe the current cumulative user intent in at most six whitespace-delimited words.",
  "Do not use assistant output, tools, files, repository instructions, prompt notes, or any information outside these user messages.",
].join(" ");

export interface SessionTitleFields {
  readonly verb: string;
  readonly subject: string;
  readonly intentSummary: string;
}

export interface ValidatedSessionTitle extends SessionTitleFields {
  readonly title: string;
}

export type SessionTitlePresentationSource =
  | "model"
  | "deterministic_fallback"
  | "explicit"
  | "ordinary_fallback";

export interface SessionTitlePresentation {
  /** Always the effective projected session name when one is available. */
  readonly text: string;
  readonly source: SessionTitlePresentationSource;
  readonly verb: string | null;
  readonly subject: string | null;
  readonly intentSummary: string | null;
  readonly sourceMessageCursor: string | null;
}

export function isSessionTitleInputMessage(message: {
  readonly role: string;
  readonly producer?: string;
  readonly idempotencyKey?: string | null;
  readonly mailbox?: { readonly relationship?: string };
}): boolean {
  if (message.role !== "user") return false;
  if (message.producer === "client") return true;
  if (message.idempotencyKey?.startsWith("task-prompt:")) return true;
  if (message.mailbox?.relationship === "parent") return true;
  // Pure presentation fixtures and retained callers predating producer
  // projection remain user input unless durable provenance says otherwise.
  return message.producer === undefined && message.idempotencyKey === undefined;
}

/**
 * Resolves the user-facing title and its bounded provenance without exposing
 * source messages. Explicit names are represented as explicit even when an
 * older automatic resolution remains in retained state.
 */
export function resolveSessionTitlePresentation(
  state: Pick<AgentState, "sessionName" | "messages"> & {
    readonly sessionTitle?: AgentState["sessionTitle"];
  },
  ordinaryFallback = "Unnamed session",
  deriveFromUserMessages = false,
): SessionTitlePresentation {
  const userMessages = state.messages
    .filter(isSessionTitleInputMessage)
    .map((message) => message.content);
  const deterministic = deriveFromUserMessages && userMessages.length
    ? deterministicSessionTitleFallback(userMessages)
    : null;
  const sessionTitle = state.sessionTitle;
  if (sessionTitle?.mode === "manual") {
    return Object.freeze({
      text: state.sessionName ?? ordinaryFallback,
      source: "explicit",
      verb: null,
      subject: null,
      intentSummary: null,
      sourceMessageCursor: null,
    });
  }
  const cursor = sessionTitle?.appliedSourceMessageCursor ?? null;
  const resolution = cursor === null
    ? undefined
    : Object.values(sessionTitle?.resolutions ?? {})
      .find((candidate) => candidate.sourceMessageCursor === cursor);
  if (resolution) {
    return Object.freeze({
      text: resolution.title,
      source: resolution.method === "model" ? "model" : "deterministic_fallback",
      verb: resolution.verb,
      subject: resolution.subject,
      intentSummary: resolution.intentSummary,
      sourceMessageCursor: resolution.sourceMessageCursor,
    });
  }
  if (deterministic) {
    return Object.freeze({
      text: deterministic.title,
      source: "deterministic_fallback",
      verb: deterministic.verb,
      subject: deterministic.subject,
      intentSummary: deterministic.intentSummary,
      sourceMessageCursor: null,
    });
  }
  return Object.freeze({
    text: state.sessionName ?? ordinaryFallback,
    source: "ordinary_fallback",
    verb: null,
    subject: null,
    intentSummary: null,
    sourceMessageCursor: null,
  });
}

export function validateSessionTitleFields(value: unknown): ValidatedSessionTitle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Session title output must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "intentSummary,subject,verb") {
    throw new ValidationError("Session title output must contain exactly verb, subject, and intentSummary");
  }
  const verb = oneLine(record.verb, "verb", SESSION_TITLE_FIELD_LIMITS.verb);
  const subject = oneLine(record.subject, "subject", SESSION_TITLE_FIELD_LIMITS.subject);
  const intentSummary = oneLine(
    record.intentSummary,
    "intentSummary",
    SESSION_TITLE_FIELD_LIMITS.intentSummary,
  );
  const verbWords = words(verb);
  if (verbWords.length > SESSION_TITLE_MAX_WORDS) {
    throw new ValidationError("Session title verb cannot exceed the title word limit");
  }
  const remaining = SESSION_TITLE_MAX_WORDS - verbWords.length;
  const title = [...verbWords, ...words(subject).slice(0, remaining)].join(" ");
  if (!title.startsWith(verb) || words(title).length > SESSION_TITLE_MAX_WORDS) {
    throw new ValidationError("Session title must begin with the returned verb and contain at most six words");
  }
  return Object.freeze({ verb, subject, intentSummary, title });
}

export function deterministicSessionTitleFallback(
  userMessages: readonly string[],
): ValidatedSessionTitle {
  const latest = oneLineFallback(userMessages.at(-1) ?? "new session");
  const directive = latest
    .replace(/^(?:please\s+|(?:can|could|would|will)\s+you\s+|i\s+(?:want|need|would\s+like)(?:\s+you)?\s+to\s+)/i, "")
    .trim();
  const directiveWords = words(directive);
  const first = directiveWords[0] ?? "";
  const useLeadingVerb = directiveWords.length > 1 &&
    first.length <= SESSION_TITLE_FIELD_LIMITS.verb &&
    !/^(?:i|we|my|our|this|that|the|a|an|how|why|what|when|where|who)$/i.test(first);
  const verb = useLeadingVerb ? first : latest === "new session" ? "Start" : "Handle";
  const subjectSource = useLeadingVerb
    ? directiveWords.slice(1).join(" ")
    : latest === "new session"
      ? "new session"
      : directive;
  const subject = words(subjectSource)
    .slice(0, SESSION_TITLE_MAX_WORDS - words(verb).length)
    .join(" ")
    .slice(0, SESSION_TITLE_FIELD_LIMITS.subject)
    .trim() || "new session";
  return validateSessionTitleFields({
    verb,
    subject,
    intentSummary: latest.slice(0, SESSION_TITLE_FIELD_LIMITS.intentSummary),
  });
}

function oneLine(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() ||
      /[\r\n\u2028\u2029]/.test(value) || value.length > maximum) {
    throw new ValidationError(`Session title ${field} must be a bounded, trimmed single line`);
  }
  return value.replace(/\s+/g, " ");
}

function oneLineFallback(value: string): string {
  const normalized = value.replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "new session";
}

function words(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

import { ValidationError } from "../domain/errors.ts";
import {
  canonicalJsonDigest,
  type JsonValue,
} from "../domain/json.ts";
import { scrubCredentialText } from "./scrub.ts";

export type RefinementEvidenceRedaction =
  | "credentials"
  | "repository_instructions";

export interface SanitizedRefinementEvidencePayload {
  readonly payload: JsonValue;
  readonly redactions: readonly RefinementEvidenceRedaction[];
}

/**
 * Produces the common model-visible evidence payload used by trajectory
 * snapshots and frozen governance inputs.
 */
export function sanitizeRefinementEvidencePayload(
  type: string,
  value: JsonValue,
): SanitizedRefinementEvidencePayload {
  const withoutInstructionFields = stripRepositoryInstructionFields(value);
  const withoutInstructions = stripRepositoryInstructionMessages(
    type,
    withoutInstructionFields,
  );
  const payload = scrubRefinementCredentialEvidence(withoutInstructions);
  const redactions: RefinementEvidenceRedaction[] = [];
  if (canonicalJsonDigest(withoutInstructions) !== canonicalJsonDigest(value)) {
    redactions.push("repository_instructions");
  }
  if (canonicalJsonDigest(payload) !== canonicalJsonDigest(withoutInstructions)) {
    redactions.push("credentials");
  }
  return { payload, redactions };
}

export function refinementVisibleEventPayload(
  type: string,
  value: JsonValue,
): JsonValue {
  return sanitizeRefinementEvidencePayload(type, value).payload;
}

function scrubRefinementCredentialEvidence(value: JsonValue): JsonValue {
  if (typeof value === "string") return scrubRefinementCredentialText(value);
  if (value === null || typeof value === "boolean" ||
      typeof value === "number") return value;
  if (Array.isArray(value)) {
    return value.map(scrubRefinementCredentialEvidence);
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const scrubbedKey = scrubRefinementCredentialText(key);
    if (Object.hasOwn(result, scrubbedKey)) {
      throw new ValidationError(
        "Credential redaction produced duplicate refinement evidence keys",
      );
    }
    result[scrubbedKey] = scrubRefinementCredentialEvidence(item);
  }
  return result;
}

function scrubRefinementCredentialText(value: string): string {
  return scrubCredentialText(value).replace(
    /(?:password|passwd|secret|authorization|token|(?:access|refresh|auth|id)[_-]?token|api[_-]?key)\s*[:=]\s*\[REDACTED\]/gi,
    "[REDACTED]",
  );
}

function stripRepositoryInstructionFields(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stripRepositoryInstructionFields);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) =>
        key !== "repositoryInstructions" &&
        key !== "repositoryInstructionOmission")
      .map(([key, item]) => [key, stripRepositoryInstructionFields(item)]),
  ) as JsonValue;
}

function stripRepositoryInstructionMessages(
  type: string,
  value: JsonValue,
): JsonValue {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return value;
  }
  const payload = value as Record<string, JsonValue>;
  if (type === "ContextMaterialized") {
    return {
      ...payload,
      context: withoutRepositoryInstructionMessages(payload.context ?? null),
    };
  }
  if (type === "ModelCallRequested") {
    return {
      ...payload,
      providerInput: withoutRepositoryInstructionMessages(
        payload.providerInput ?? null,
      ),
    };
  }
  if (type === "EffectRequested" && payload.executor === "model") {
    const input = jsonRecord(payload.input ?? null);
    return input
      ? {
          ...payload,
          input: {
            ...input,
            providerInput: withoutRepositoryInstructionMessages(
              input.providerInput ?? null,
            ),
          },
        }
      : payload;
  }
  return payload;
}

function withoutRepositoryInstructionMessages(value: JsonValue): JsonValue {
  const record = jsonRecord(value);
  if (!record || !Array.isArray(record.messages)) return value;
  return {
    ...record,
    messages: record.messages.filter((message) =>
      !repositoryInstructionMessage(message)),
  };
}

function repositoryInstructionMessage(value: JsonValue): boolean {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  return value.role === "user" && typeof value.content === "string" &&
    (value.content.startsWith("WORKSPACE ROOT INSTRUCTIONS\n") ||
      value.content.startsWith("DISCOVERED DIRECTORY INSTRUCTIONS\n"));
}

function jsonRecord(value: JsonValue): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}

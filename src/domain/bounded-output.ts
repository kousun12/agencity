import type { ArtifactReference } from "./events.ts";
import { assertJsonValue, type JsonValue } from "./json.ts";
import { ValidationError } from "./errors.ts";

export const BOUNDED_OUTPUT_PROTOCOL = "agencity.bounded-output.v1" as const;

export const OUTPUT_LIMITS = Object.freeze({
  agentObservationBytes: 64 * 1024,
  agentObservationItemBytes: 56 * 1024,
  shellPreviewBytesPerStream: 24 * 1024,
  shellPreviewHeadBytes: 12 * 1024,
  shellPreviewTailBytes: 12 * 1024,
  shellSpillBytes: 32 * 1024 * 1024,
  cellResultIpcBytes: 128 * 1024,
  filePageLines: 2_000,
  fileLineBytes: 2 * 1024,
  filePageBytes: 48 * 1024,
  artifactRangeBytes: 64 * 1024,
});

export type BoundedOutputTruncationReason =
  | "spill-unavailable"
  | "spill-failed"
  | "spill-limit"
  | "observation-budget";

interface BoundedOutputBase {
  readonly protocol: typeof BOUNDED_OUTPUT_PROTOCOL;
  /** Exact UTF-8 or binary byte count for the complete logical output. */
  readonly byteLength: number;
}

export type BoundedOutputV1<T extends JsonValue = JsonValue, P extends JsonValue = T> =
  | (BoundedOutputBase & {
      readonly completeness: "inline";
      readonly value: T;
    })
  | (BoundedOutputBase & {
      readonly completeness: "spilled";
      readonly preview: P;
      readonly artifact: ArtifactReference;
      readonly guidance: string;
    })
  | (BoundedOutputBase & {
      readonly completeness: "truncated";
      readonly preview: P;
      readonly reason: BoundedOutputTruncationReason;
      readonly guidance: string;
    })
  | (BoundedOutputBase & {
      readonly completeness: "refused";
      readonly reason: string;
      readonly guidance: string;
    });

const COMPLETENESS = new Set(["inline", "spilled", "truncated", "refused"]);
const TRUNCATION_REASONS = new Set<BoundedOutputTruncationReason>([
  "spill-unavailable",
  "spill-failed",
  "spill-limit",
  "observation-budget",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function assertArtifactReference(value: unknown): asserts value is ArtifactReference {
  const artifact = record(value);
  if (!artifact ||
      typeof artifact.digest !== "string" || !/^[a-f0-9]{64}$/.test(artifact.digest) ||
      artifact.artifactId !== `sha256:${artifact.digest}` ||
      typeof artifact.mediaType !== "string" || artifact.mediaType.length === 0 ||
      !Number.isSafeInteger(artifact.size) || Number(artifact.size) < 0) {
    throw new ValidationError("Bounded output has an invalid artifact reference");
  }
}

/** Validates the retained completeness claim without constraining tool-specific metadata. */
export function assertBoundedOutputV1(value: unknown): asserts value is BoundedOutputV1 {
  const output = record(value);
  if (!output || output.protocol !== BOUNDED_OUTPUT_PROTOCOL ||
      typeof output.completeness !== "string" || !COMPLETENESS.has(output.completeness) ||
      !Number.isSafeInteger(output.byteLength) || Number(output.byteLength) < 0) {
    throw new ValidationError("Invalid agencity.bounded-output.v1 envelope");
  }
  const guidance = (): void => {
    if (typeof output.guidance !== "string" || output.guidance.length === 0) {
      throw new ValidationError("Incomplete bounded output requires recovery guidance");
    }
  };
  if (output.completeness === "inline") {
    if (!has(output, "value") ||
        ["preview", "artifact", "reason", "guidance"].some((key) => has(output, key))) {
      throw new ValidationError("Inline bounded output must contain only a complete value claim");
    }
    assertJsonValue(output.value);
    return;
  }
  if (output.completeness === "spilled") {
    if (!has(output, "preview") || !has(output, "artifact") ||
        has(output, "value") || has(output, "reason")) {
      throw new ValidationError("Spilled bounded output requires preview and artifact only");
    }
    assertArtifactReference(output.artifact);
    if ((output.artifact as ArtifactReference).size !== output.byteLength) {
      throw new ValidationError("Spilled bounded output byteLength must match its artifact");
    }
    assertJsonValue(output.preview);
    guidance();
    return;
  }
  if (output.completeness === "truncated") {
    if (!has(output, "preview") || has(output, "artifact") || has(output, "value") ||
        typeof output.reason !== "string" ||
        !TRUNCATION_REASONS.has(output.reason as BoundedOutputTruncationReason)) {
      throw new ValidationError("Truncated bounded output has an invalid completeness claim");
    }
    assertJsonValue(output.preview);
    guidance();
    return;
  }
  if (output.byteLength !== 0 ||
      has(output, "value") || has(output, "preview") || has(output, "artifact") ||
      typeof output.reason !== "string" || output.reason.length === 0) {
    throw new ValidationError("Refused bounded output has an invalid completeness claim");
  }
  guidance();
}

/** Rejects malformed bounded-output claims anywhere inside a retained JSON value. */
export function assertBoundedOutputs(value: JsonValue): void {
  const pending: JsonValue[] = [value];
  while (pending.length) {
    const current = pending.pop()!;
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current.protocol === BOUNDED_OUTPUT_PROTOCOL) assertBoundedOutputV1(current);
    pending.push(...Object.values(current));
  }
}

/** Returns every artifact reference that makes a nested bounded output complete. */
export function boundedOutputArtifactReferences(value: JsonValue): ArtifactReference[] {
  const references: ArtifactReference[] = [];
  const pending: JsonValue[] = [value];
  while (pending.length) {
    const current = pending.pop()!;
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current.protocol === BOUNDED_OUTPUT_PROTOCOL) {
      assertBoundedOutputV1(current);
      if (current.completeness === "spilled") references.push(current.artifact);
    }
    pending.push(...Object.values(current));
  }
  return references;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function utf8Prefix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

export function utf8Suffix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maximumBytes) return value;
  let start = bytes.byteLength - maximumBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;
  return decoder.decode(bytes.subarray(start));
}

export interface HeadTailPreview {
  readonly head: string;
  readonly tail: string;
  readonly byteLength: number;
}

/** Bounded Unicode-safe text capture that retains useful beginning and end evidence. */
export class Utf8HeadTailCapture {
  #head = "";
  #tail = "";
  #byteLength = 0;

  constructor(
    readonly headBytes: number,
    readonly tailBytes: number,
  ) {}

  push(value: string): void {
    if (!value) return;
    this.#byteLength += utf8Bytes(value);
    if (utf8Bytes(this.#head) < this.headBytes) {
      this.#head = utf8Prefix(this.#head + value, this.headBytes);
    }
    this.#tail = utf8Suffix(this.#tail + value, this.tailBytes);
  }

  value(): HeadTailPreview {
    return { head: this.#head, tail: this.#tail, byteLength: this.#byteLength };
  }
}

export function boundedInline<T extends JsonValue>(value: T, byteLength = utf8Bytes(JSON.stringify(value))): BoundedOutputV1<T> {
  return { protocol: BOUNDED_OUTPUT_PROTOCOL, completeness: "inline", value, byteLength };
}

export function boundedRefused(reason: string, guidance: string): BoundedOutputV1 {
  return {
    protocol: BOUNDED_OUTPUT_PROTOCOL,
    completeness: "refused",
    byteLength: 0,
    reason,
    guidance,
  };
}

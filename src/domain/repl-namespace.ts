import { z } from "zod";

export const REPL_NAMESPACE_PROTOCOL =
  "agencity.repl-namespace.v1" as const;
export const REPL_EPOCH_CHANGED = "REPL_EPOCH_CHANGED" as const;

const epochId = z.string().uuid();
const epochName = z.string().regex(
  /^[a-z]+-[a-z]+-[0-9a-f]{6}$/,
  "REPL epoch name must be adjective-noun-hex",
);

export const replNamespaceStatusSchema = z.discriminatedUnion("state", [
  z.object({
    protocol: z.literal(REPL_NAMESPACE_PROTOCOL),
    state: z.literal("cold"),
    epochId: z.null(),
    epochName: z.null(),
  }).strict(),
  z.object({
    protocol: z.literal(REPL_NAMESPACE_PROTOCOL),
    state: z.literal("warm"),
    epochId,
    epochName,
  }).strict(),
]);

export type ReplNamespaceStatus = z.infer<
  typeof replNamespaceStatusSchema
>;

export const COLD_REPL_NAMESPACE: ReplNamespaceStatus = Object.freeze({
  protocol: REPL_NAMESPACE_PROTOCOL,
  state: "cold",
  epochId: null,
  epochName: null,
});

export interface ReplEpochChangedDetails {
  readonly expected: ReplNamespaceStatus | null;
  readonly current: ReplNamespaceStatus;
  readonly guidance: string;
}

export class ReplEpochChangedError extends Error {
  readonly code = REPL_EPOCH_CHANGED;
  readonly details: ReplEpochChangedDetails;

  constructor(
    expected: ReplNamespaceStatus | null,
    current: ReplNamespaceStatus,
  ) {
    const guidance =
      "The model action was not executed. Rebuild required bindings from durable state, artifacts, or current inputs in a new cell; do not replay prior effectful cells.";
    super(
      `${REPL_EPOCH_CHANGED}: expected ${describeReplNamespace(expected)}, ` +
        `but the exact-branch console is ${describeReplNamespace(current)}. ${guidance}`,
    );
    this.name = "ReplEpochChangedError";
    this.details = { expected, current, guidance };
  }
}

export function sameReplNamespace(
  left: ReplNamespaceStatus,
  right: ReplNamespaceStatus,
): boolean {
  return left.state === right.state &&
    left.epochId === right.epochId &&
    left.epochName === right.epochName;
}

function describeReplNamespace(
  status: ReplNamespaceStatus | null,
): string {
  if (status === null) return "an unavailable retained epoch pin";
  return status.state === "cold"
    ? "cold (no live namespace)"
    : `warm epoch ${status.epochName} (${status.epochId})`;
}

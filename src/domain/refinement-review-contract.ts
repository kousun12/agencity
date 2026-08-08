import { z } from "zod";
import { ValidationError } from "./errors.ts";
import type { HarnessContent, HarnessEdit } from "./harness.ts";
import {
  MAX_REFINEMENT_REVIEW_BYTES,
  refinementReviewResponseSchema,
  type RefinementReviewDecision,
} from "./refinement-review.ts";
import {
  assertJsonValue,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  canonicalJsonStringify,
  type JsonValue,
  type Sha256Digest,
} from "./json.ts";

export const REFINEMENT_REVIEW_CONTRACT_ID =
  "agencity.refinement-review.v1" as const;
export const REFINEMENT_REVIEW_CONTRACT_VERSION = 1 as const;
export const MAX_REFINEMENT_RECURSIVE_RESULT_BYTES =
  MAX_REFINEMENT_REVIEW_BYTES + 16 * 1024;
export const REFINEMENT_REVIEW_TOOL_NAME =
  "agencity_submit_refinement_review" as const;
export const REFINEMENT_REVIEW_TOOL_DESCRIPTION = [
  "Submit exactly one trajectory-refinement review for the retained request.",
  "Use no_change when the visible durable evidence does not justify a safe edit.",
  "A proposal may cite only visible event IDs and may edit only the authorized scope, kinds, and targets.",
  "Every optional field uses an explicit presence wrapper. Arbitrary JSON fields use the declared lossless jsonValue encoding.",
].join(" ");

type Presence<T> =
  | { readonly present: false }
  | { readonly present: true; readonly value: T };

type TransportJsonValue =
  | { readonly kind: "null" }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "array"; readonly value: readonly TransportJsonValue[] }
  | {
      readonly kind: "object";
      readonly value: readonly {
        readonly key: string;
        readonly value: TransportJsonValue;
      }[];
    };

const boundedId = z.string().min(1).max(256);
const boundedName = z.string().min(1).max(128);
const boundedTag = z.string().min(1).max(64);

const presence = <T extends z.ZodTypeAny>(schema: T) =>
  z.discriminatedUnion("present", [
    z.object({ present: z.literal(false) }).strict(),
    z.object({ present: z.literal(true), value: schema }).strict(),
  ]);

const transportJsonValueSchema: z.ZodType<TransportJsonValue> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("null") }).strict(),
    z.object({ kind: z.literal("string"), value: z.string() }).strict(),
    z.object({ kind: z.literal("number"), value: z.number().finite() }).strict(),
    z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
    z.object({
      kind: z.literal("array"),
      value: z.array(transportJsonValueSchema),
    }).strict(),
    z.object({
      kind: z.literal("object"),
      value: z.array(z.object({
        key: z.string(),
        value: transportJsonValueSchema,
      }).strict()).superRefine((entries, context) => {
        const keys = new Set<string>();
        for (let index = 0; index < entries.length; index++) {
          const key = entries[index]!.key;
          if (keys.has(key)) {
            context.addIssue({
              code: "custom",
              path: [index, "key"],
              message: "duplicate JSON object keys are not allowed",
            });
          }
          keys.add(key);
        }
      }),
    }).strict(),
  ])
);

const stringList = z.array(boundedId);
const metadataSchema = {
  tags: presence(z.array(boundedTag)),
  confidence: presence(z.number().finite()),
  evidenceEventIds: presence(stringList),
  conflictEntryIds: presence(stringList),
};

const memoryContentSchema = z.object({
  kind: z.literal("memory"),
  memoryKind: z.enum([
    "claim",
    "preference",
    "decision",
    "observation",
    "constraint",
  ]),
  text: z.string(),
}).strict();

const promptNoteContentSchema = z.object({
  kind: z.literal("prompt_note"),
  text: z.string(),
}).strict();

const skillTestSchema = z.object({
  name: boundedName,
  input: transportJsonValueSchema,
  expected: presence(transportJsonValueSchema),
  expectedError: presence(z.string()),
}).strict();

const skillContentSchema = z.object({
  kind: z.literal("skill"),
  description: z.string(),
  source: z.string(),
  inputSchema: presence(transportJsonValueSchema),
  permissions: z.array(z.string()),
  tests: z.array(skillTestSchema),
  runtime: z.literal("bun"),
  compatibility: presence(z.string()),
}).strict();

const modelConfigurationSchema = z.object({
  provider: z.string(),
  model: z.string(),
  temperature: presence(z.number().finite()),
  maxOutputTokens: presence(z.number().finite()),
  reasoningEffort: z.enum([
    "provider-default",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]),
}).strict();

const budgetSchema = z.object({
  tokenLimit: presence(z.number().finite()),
  costLimitUsd: presence(z.number().finite()),
  turnLimit: presence(z.number().finite()),
  wallTimeLimitMs: presence(z.number().finite()),
}).strict();

const subagentSpecContentSchema = z.object({
  kind: z.literal("subagent_spec"),
  role: z.string(),
  invocationCriteria: z.string(),
  expectedArtifact: z.string(),
  prompt: z.string(),
  model: presence(modelConfigurationSchema),
  budget: presence(budgetSchema),
  completionCriteria: presence(z.string()),
}).strict();

const contentSchema = z.discriminatedUnion("kind", [
  memoryContentSchema,
  promptNoteContentSchema,
  skillContentSchema,
  subagentSpecContentSchema,
]);

const createEditSchema = z.object({
  operation: z.literal("create"),
  kind: z.enum(["memory", "prompt_note", "skill", "subagent_spec"]),
  scope: z.enum(["local", "workspace", "user", "global"]),
  scopeKey: presence(boundedId),
  name: boundedName,
  content: contentSchema,
  ...metadataSchema,
}).strict();

const replaceEditSchema = z.object({
  operation: z.literal("replace"),
  entryId: boundedId,
  expectedVersionId: boundedId,
  name: presence(boundedName),
  content: contentSchema,
  ...metadataSchema,
}).strict();

const retireEditSchema = z.object({
  operation: z.literal("retire"),
  entryId: boundedId,
  expectedVersionId: boundedId,
  evidenceEventIds: presence(stringList),
  reason: presence(z.string()),
}).strict();

const transportDecisionSchema = z.discriminatedUnion("status", [
  z.object({
    protocol: z.literal("agencity.refinement-review"),
    version: z.literal(1),
    reviewId: boundedId,
    status: z.literal("no_change"),
    reason: z.string(),
    evidenceEventIds: stringList,
  }).strict(),
  z.object({
    protocol: z.literal("agencity.refinement-review"),
    version: z.literal(1),
    reviewId: boundedId,
    status: z.literal("propose"),
    trigger: z.string(),
    predictedEffect: z.string(),
    edits: z.array(z.discriminatedUnion("operation", [
      createEditSchema,
      replaceEditSchema,
      retireEditSchema,
    ])),
    evidenceEventIds: stringList,
    evaluation: z.object({
      kind: z.literal("objective"),
      name: boundedName,
      metric: z.string(),
      target: transportJsonValueSchema,
      baseline: presence(transportJsonValueSchema),
      testCommand: presence(z.string()),
    }).strict(),
  }).strict(),
]);

const transportInputSchema = z.object({
  decision: transportDecisionSchema,
}).strict();

const objectSchema = (
  properties: Record<string, JsonValue>,
  required = Object.keys(properties),
): JsonValue => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const ref = (name: string): JsonValue => ({ $ref: `#/$defs/${name}` });
const absentSchema = objectSchema({
  present: { type: "boolean", const: false },
});
const presentSchema = (value: JsonValue): JsonValue => objectSchema({
  present: { type: "boolean", const: true },
  value,
});
const presenceSchema = (value: JsonValue): JsonValue => ({
  anyOf: [absentSchema, presentSchema(value)],
});
const stringSchema: JsonValue = { type: "string" };
const numberSchema: JsonValue = { type: "number" };
const idSchema: JsonValue = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
};
const nameSchema: JsonValue = {
  type: "string",
  minLength: 1,
  maxLength: 128,
};
const idListSchema: JsonValue = { type: "array", items: idSchema };

const optionalMetadataProperties = {
  tags: presenceSchema({
    type: "array",
    items: { type: "string", minLength: 1, maxLength: 64 },
  }),
  confidence: presenceSchema(numberSchema),
  evidenceEventIds: presenceSchema(idListSchema),
  conflictEntryIds: presenceSchema(idListSchema),
} satisfies Record<string, JsonValue>;

const memoryContentJsonSchema = objectSchema({
  kind: { type: "string", const: "memory" },
  memoryKind: {
    type: "string",
    enum: ["claim", "preference", "decision", "observation", "constraint"],
  },
  text: stringSchema,
});
const promptNoteContentJsonSchema = objectSchema({
  kind: { type: "string", const: "prompt_note" },
  text: stringSchema,
});
const skillContentJsonSchema = objectSchema({
  kind: { type: "string", const: "skill" },
  description: stringSchema,
  source: stringSchema,
  inputSchema: ref("jsonPresence"),
  permissions: { type: "array", items: stringSchema },
  tests: { type: "array", items: ref("skillTest") },
  runtime: { type: "string", const: "bun" },
  compatibility: presenceSchema(stringSchema),
});
const subagentContentJsonSchema = objectSchema({
  kind: { type: "string", const: "subagent_spec" },
  role: stringSchema,
  invocationCriteria: stringSchema,
  expectedArtifact: stringSchema,
  prompt: stringSchema,
  model: presenceSchema(ref("modelConfiguration")),
  budget: presenceSchema(ref("budget")),
  completionCriteria: presenceSchema(stringSchema),
});

const definitions: Record<string, JsonValue> = {
  jsonValue: {
    anyOf: [
      objectSchema({ kind: { type: "string", const: "null" } }),
      objectSchema({
        kind: { type: "string", const: "string" },
        value: stringSchema,
      }),
      objectSchema({
        kind: { type: "string", const: "number" },
        value: numberSchema,
      }),
      objectSchema({
        kind: { type: "string", const: "boolean" },
        value: { type: "boolean" },
      }),
      objectSchema({
        kind: { type: "string", const: "array" },
        value: { type: "array", items: ref("jsonValue") },
      }),
      objectSchema({
        kind: { type: "string", const: "object" },
        value: { type: "array", items: ref("jsonEntry") },
      }),
    ],
  },
  jsonEntry: objectSchema({
    key: stringSchema,
    value: ref("jsonValue"),
  }),
  jsonPresence: {
    anyOf: [absentSchema, presentSchema(ref("jsonValue"))],
  },
  skillTest: objectSchema({
    name: nameSchema,
    input: ref("jsonValue"),
    expected: ref("jsonPresence"),
    expectedError: presenceSchema(stringSchema),
  }),
  modelConfiguration: objectSchema({
    provider: stringSchema,
    model: stringSchema,
    temperature: presenceSchema(numberSchema),
    maxOutputTokens: presenceSchema(numberSchema),
    reasoningEffort: {
      type: "string",
      enum: [
        "provider-default",
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ],
    },
  }),
  budget: objectSchema({
    tokenLimit: presenceSchema(numberSchema),
    costLimitUsd: presenceSchema(numberSchema),
    turnLimit: presenceSchema(numberSchema),
    wallTimeLimitMs: presenceSchema(numberSchema),
  }),
  content: {
    anyOf: [
      memoryContentJsonSchema,
      promptNoteContentJsonSchema,
      skillContentJsonSchema,
      subagentContentJsonSchema,
    ],
  },
  createEdit: objectSchema({
    operation: { type: "string", const: "create" },
    kind: {
      type: "string",
      enum: ["memory", "prompt_note", "skill", "subagent_spec"],
    },
    scope: {
      type: "string",
      enum: ["local", "workspace", "user", "global"],
    },
    scopeKey: presenceSchema(idSchema),
    name: nameSchema,
    content: ref("content"),
    ...optionalMetadataProperties,
  }),
  replaceEdit: objectSchema({
    operation: { type: "string", const: "replace" },
    entryId: idSchema,
    expectedVersionId: idSchema,
    name: presenceSchema(nameSchema),
    content: ref("content"),
    ...optionalMetadataProperties,
  }),
  retireEdit: objectSchema({
    operation: { type: "string", const: "retire" },
    entryId: idSchema,
    expectedVersionId: idSchema,
    evidenceEventIds: presenceSchema(idListSchema),
    reason: presenceSchema(stringSchema),
  }),
  evaluation: objectSchema({
    kind: { type: "string", const: "objective" },
    name: nameSchema,
    metric: stringSchema,
    target: ref("jsonValue"),
    baseline: ref("jsonPresence"),
    testCommand: presenceSchema(stringSchema),
  }),
};

const noChangeJsonSchema = objectSchema({
  protocol: { type: "string", const: "agencity.refinement-review" },
  version: { type: "integer", const: 1 },
  reviewId: idSchema,
  status: { type: "string", const: "no_change" },
  reason: stringSchema,
  evidenceEventIds: idListSchema,
});

const proposeJsonSchema = objectSchema({
  protocol: { type: "string", const: "agencity.refinement-review" },
  version: { type: "integer", const: 1 },
  reviewId: idSchema,
  status: { type: "string", const: "propose" },
  trigger: stringSchema,
  predictedEffect: stringSchema,
  edits: {
    type: "array",
    items: {
      anyOf: [ref("createEdit"), ref("replaceEdit"), ref("retireEdit")],
    },
  },
  evidenceEventIds: idListSchema,
  evaluation: ref("evaluation"),
});

export const REFINEMENT_REVIEW_INPUT_SCHEMA: JsonValue = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {
    decision: {
      anyOf: [noChangeJsonSchema, proposeJsonSchema],
    },
  },
  required: ["decision"],
  $defs: definitions,
});

export const REFINEMENT_REVIEW_INPUT_SCHEMA_DIGEST: Sha256Digest =
  canonicalJsonDigest(REFINEMENT_REVIEW_INPUT_SCHEMA);

export interface RefinementReviewToolDefinition {
  readonly name: typeof REFINEMENT_REVIEW_TOOL_NAME;
  readonly description: typeof REFINEMENT_REVIEW_TOOL_DESCRIPTION;
  readonly inputSchema: typeof REFINEMENT_REVIEW_INPUT_SCHEMA;
  readonly schemaDigest: typeof REFINEMENT_REVIEW_INPUT_SCHEMA_DIGEST;
}

export const REFINEMENT_REVIEW_TOOL_SET:
  readonly [RefinementReviewToolDefinition] = deepFreeze([{
    name: REFINEMENT_REVIEW_TOOL_NAME,
    description: REFINEMENT_REVIEW_TOOL_DESCRIPTION,
    inputSchema: REFINEMENT_REVIEW_INPUT_SCHEMA,
    schemaDigest: REFINEMENT_REVIEW_INPUT_SCHEMA_DIGEST,
  }]);

export interface RefinementReviewRecursiveResult {
  readonly kind: "tool-submission";
  readonly contractId: typeof REFINEMENT_REVIEW_CONTRACT_ID;
  readonly contractVersion: typeof REFINEMENT_REVIEW_CONTRACT_VERSION;
  readonly contractDigest: Sha256Digest;
  readonly modelCallId: string;
  readonly providerToolCallId: string;
  readonly toolName: typeof REFINEMENT_REVIEW_TOOL_NAME;
  readonly modelResultDigest: Sha256Digest;
  readonly transportInputDigest: Sha256Digest;
  readonly transportInputBytes: number;
  readonly submission: RefinementReviewDecision;
  readonly submissionDigest: Sha256Digest;
}

export function createRefinementReviewRecursiveResult(input: {
  readonly contractDigest: Sha256Digest;
  readonly modelCallId: string;
  readonly providerToolCallId: string;
  readonly modelResultDigest: Sha256Digest;
  readonly transportInput: JsonValue;
  readonly transportInputDigest: Sha256Digest;
  readonly transportInputBytes: number;
}): RefinementReviewRecursiveResult {
  if (canonicalJsonDigest(input.transportInput) !== input.transportInputDigest) {
    throw new ValidationError(
      "Refinement transport input digest does not match its accepted input",
    );
  }
  const submission = normalizeRefinementReviewTransportValue(
    input.transportInput,
    { encodedBytes: input.transportInputBytes },
  );
  const result: RefinementReviewRecursiveResult = {
    kind: "tool-submission",
    contractId: REFINEMENT_REVIEW_CONTRACT_ID,
    contractVersion: REFINEMENT_REVIEW_CONTRACT_VERSION,
    contractDigest: input.contractDigest,
    modelCallId: input.modelCallId,
    providerToolCallId: input.providerToolCallId,
    toolName: REFINEMENT_REVIEW_TOOL_NAME,
    modelResultDigest: input.modelResultDigest,
    transportInputDigest: input.transportInputDigest,
    transportInputBytes: input.transportInputBytes,
    submission,
    submissionDigest: canonicalJsonDigest(submission as unknown as JsonValue),
  };
  return validateRefinementReviewRecursiveResult(result, {
    contractDigest: input.contractDigest,
  });
}

export function validateRefinementReviewRecursiveResult(
  value: unknown,
  expected?: { readonly contractDigest: Sha256Digest },
): RefinementReviewRecursiveResult {
  assertJsonValue(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Structured refinement result must be an object");
  }
  const record = value as Record<string, JsonValue>;
  const keys = [
    "kind",
    "contractId",
    "contractVersion",
    "contractDigest",
    "modelCallId",
    "providerToolCallId",
    "toolName",
    "modelResultDigest",
    "transportInputDigest",
    "transportInputBytes",
    "submission",
    "submissionDigest",
  ];
  if (canonicalJsonStringify(Object.keys(record).sort()) !==
      canonicalJsonStringify([...keys].sort())) {
    throw new ValidationError(
      "Structured refinement result has missing or unknown fields",
    );
  }
  if (record.kind !== "tool-submission" ||
      record.contractId !== REFINEMENT_REVIEW_CONTRACT_ID ||
      record.contractVersion !== REFINEMENT_REVIEW_CONTRACT_VERSION ||
      record.toolName !== REFINEMENT_REVIEW_TOOL_NAME) {
    throw new ValidationError(
      "Structured refinement result has invalid sealed contract identity",
    );
  }
  for (const [key, candidate] of [
    ["contractDigest", record.contractDigest],
    ["modelResultDigest", record.modelResultDigest],
    ["transportInputDigest", record.transportInputDigest],
    ["submissionDigest", record.submissionDigest],
  ] as const) {
    if (typeof candidate !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(candidate)) {
      throw new ValidationError(`Structured refinement result ${key} is invalid`);
    }
  }
  if (expected && record.contractDigest !== expected.contractDigest) {
    throw new ValidationError(
      "Structured refinement result contract digest disagrees with admission",
    );
  }
  if (typeof record.modelCallId !== "string" || !record.modelCallId ||
      typeof record.providerToolCallId !== "string" ||
      !record.providerToolCallId) {
    throw new ValidationError(
      "Structured refinement result call identity is invalid",
    );
  }
  if (!Number.isSafeInteger(record.transportInputBytes) ||
      Number(record.transportInputBytes) < 1 ||
      Number(record.transportInputBytes) > MAX_REFINEMENT_REVIEW_BYTES) {
    throw new ValidationError(
      "Structured refinement result transport byte count is invalid",
    );
  }
  const submission = refinementReviewResponseSchema.safeParse(record.submission);
  if (!submission.success) {
    throw new ValidationError(
      "Structured refinement result submission is invalid",
      { issues: submission.error.issues },
    );
  }
  if (canonicalJsonDigest(record.submission) !== record.submissionDigest) {
    throw new ValidationError(
      "Structured refinement result submission digest does not match",
    );
  }
  if (canonicalJsonByteLength(record) > MAX_REFINEMENT_RECURSIVE_RESULT_BYTES) {
    throw new ValidationError(
      `Structured refinement result exceeds ${MAX_REFINEMENT_RECURSIVE_RESULT_BYTES} bytes`,
    );
  }
  return value as unknown as RefinementReviewRecursiveResult;
}

/**
 * Validates the fully-required provider transport and removes only its
 * explicit absence/value encodings. The returned domain value does not retain
 * a second copy of the accepted provider transport.
 */
export function normalizeRefinementReviewTransportValue(
  value: unknown,
  options: { readonly encodedBytes: number },
): RefinementReviewDecision {
  assertEncodedBytes(options.encodedBytes);
  assertJsonValue(value);
  const parsed = transportInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(
      `Refinement tool input does not match ${REFINEMENT_REVIEW_CONTRACT_ID}`,
      { issues: parsed.error.issues },
    );
  }
  const normalized = normalizeDecision(parsed.data.decision);
  const decision = refinementReviewResponseSchema.safeParse(normalized);
  if (!decision.success) {
    throw new ValidationError(
      "Normalized refinement review does not match its domain contract",
      { issues: decision.error.issues },
    );
  }
  if (canonicalJsonByteLength(decision.data) > options.encodedBytes) {
    throw new ValidationError(
      "Refinement transport byte count is smaller than its normalized canonical value",
    );
  }
  return decision.data as RefinementReviewDecision;
}

/** Canonical fixture/provider encoder for the lossless formal transport. */
export function encodeRefinementReviewTransportValue(
  decision: RefinementReviewDecision,
): JsonValue {
  const parsed = refinementReviewResponseSchema.safeParse(decision);
  if (!parsed.success) {
    throw new ValidationError("Cannot encode an invalid refinement decision", {
      issues: parsed.error.issues,
    });
  }
  const value = parsed.data as RefinementReviewDecision;
  if (value.status === "no_change") {
    return { decision: value as unknown as JsonValue };
  }
  return {
    decision: {
      protocol: value.protocol,
      version: value.version,
      reviewId: value.reviewId,
      status: value.status,
      trigger: value.trigger,
      predictedEffect: value.predictedEffect,
      edits: value.edits.map(encodeEdit),
      evidenceEventIds: [...value.evidenceEventIds],
      evaluation: {
        kind: value.evaluation.kind,
        name: value.evaluation.name,
        metric: value.evaluation.metric,
        target: encodeJsonValue(value.evaluation.target),
        baseline: encodeOptional(value.evaluation, "baseline", encodeJsonValue),
        testCommand: encodeOptional(value.evaluation, "testCommand"),
      },
    },
  };
}

function encodeEdit(edit: HarnessEdit): JsonValue {
  if (edit.operation === "retire") {
    return {
      operation: edit.operation,
      entryId: edit.entryId,
      expectedVersionId: edit.expectedVersionId,
      evidenceEventIds: encodeOptional(edit, "evidenceEventIds"),
      reason: encodeOptional(edit, "reason"),
    };
  }
  const metadata = {
    tags: encodeOptional(edit, "tags"),
    confidence: encodeOptional(edit, "confidence"),
    evidenceEventIds: encodeOptional(edit, "evidenceEventIds"),
    conflictEntryIds: encodeOptional(edit, "conflictEntryIds"),
  };
  if (edit.operation === "create") {
    return {
      operation: edit.operation,
      kind: edit.kind,
      scope: edit.scope,
      scopeKey: encodeOptional(edit, "scopeKey"),
      name: edit.name,
      content: encodeContent(edit.content),
      ...metadata,
    };
  }
  return {
    operation: edit.operation,
    entryId: edit.entryId,
    expectedVersionId: edit.expectedVersionId,
    name: encodeOptional(edit, "name"),
    content: encodeContent(edit.content),
    ...metadata,
  };
}

function encodeContent(
  content: HarnessContent,
): JsonValue {
  if (content.kind === "memory" || content.kind === "prompt_note") {
    return content as unknown as JsonValue;
  }
  if (content.kind === "skill") {
    return {
      kind: content.kind,
      description: content.description,
      source: content.source,
      inputSchema: encodeOptional(content, "inputSchema", encodeJsonValue),
      permissions: [...content.permissions],
      tests: content.tests.map((test) => ({
        name: test.name,
        input: encodeJsonValue(test.input),
        expected: encodeOptional(test, "expected", encodeJsonValue),
        expectedError: encodeOptional(test, "expectedError"),
      })),
      runtime: content.runtime,
      compatibility: encodeOptional(content, "compatibility"),
    };
  }
  return {
    kind: content.kind,
    role: content.role,
    invocationCriteria: content.invocationCriteria,
    expectedArtifact: content.expectedArtifact,
    prompt: content.prompt,
    model: encodeOptional(content, "model", encodeModel),
    budget: encodeOptional(content, "budget", encodeBudget),
    completionCriteria: encodeOptional(content, "completionCriteria"),
  };
}

function encodeModel(
  model: NonNullable<
    Extract<import("./harness.ts").HarnessContent, { kind: "subagent_spec" }>["model"]
  >,
): JsonValue {
  return {
    provider: model.provider,
    model: model.model,
    temperature: encodeOptional(model, "temperature"),
    maxOutputTokens: encodeOptional(model, "maxOutputTokens"),
    reasoningEffort: model.reasoningEffort,
  };
}

function encodeBudget(
  budget: NonNullable<
    Extract<import("./harness.ts").HarnessContent, { kind: "subagent_spec" }>["budget"]
  >,
): JsonValue {
  return {
    tokenLimit: encodeOptional(budget, "tokenLimit"),
    costLimitUsd: encodeOptional(budget, "costLimitUsd"),
    turnLimit: encodeOptional(budget, "turnLimit"),
    wallTimeLimitMs: encodeOptional(budget, "wallTimeLimitMs"),
  };
}

function encodeOptional<T extends object, K extends keyof T>(
  owner: T,
  key: K,
  encode?: (value: NonNullable<T[K]>) => JsonValue,
): JsonValue {
  if (!Object.hasOwn(owner, key) || owner[key] === undefined) {
    return { present: false };
  }
  const value = owner[key] as NonNullable<T[K]>;
  return {
    present: true,
    value: encode ? encode(value) : value as unknown as JsonValue,
  };
}

function encodeJsonValue(value: JsonValue): JsonValue {
  if (value === null) return { kind: "null" };
  if (typeof value === "string") return { kind: "string", value };
  if (typeof value === "number") return { kind: "number", value };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (Array.isArray(value)) {
    return { kind: "array", value: value.map(encodeJsonValue) };
  }
  return {
    kind: "object",
    value: Object.keys(value).sort().map((key) => ({
      key,
      value: encodeJsonValue(value[key]!),
    })),
  };
}

function normalizeDecision(value: z.infer<typeof transportDecisionSchema>): unknown {
  if (value.status === "no_change") return value;
  return {
    protocol: value.protocol,
    version: value.version,
    reviewId: value.reviewId,
    status: value.status,
    trigger: value.trigger,
    predictedEffect: value.predictedEffect,
    edits: value.edits.map(normalizeEdit),
    evidenceEventIds: value.evidenceEventIds,
    evaluation: {
      kind: value.evaluation.kind,
      name: value.evaluation.name,
      metric: value.evaluation.metric,
      target: decodeJsonValue(value.evaluation.target),
      ...optional("baseline", value.evaluation.baseline, decodeJsonValue),
      ...optional("testCommand", value.evaluation.testCommand),
    },
  };
}

function normalizeEdit(
  edit: z.infer<typeof createEditSchema> |
    z.infer<typeof replaceEditSchema> |
    z.infer<typeof retireEditSchema>,
): unknown {
  if (edit.operation === "retire") {
    return {
      operation: edit.operation,
      entryId: edit.entryId,
      expectedVersionId: edit.expectedVersionId,
      ...optional("evidenceEventIds", edit.evidenceEventIds),
      ...optional("reason", edit.reason),
    };
  }
  const metadata = {
    ...optional("tags", edit.tags),
    ...optional("confidence", edit.confidence),
    ...optional("evidenceEventIds", edit.evidenceEventIds),
    ...optional("conflictEntryIds", edit.conflictEntryIds),
  };
  if (edit.operation === "create") {
    return {
      operation: edit.operation,
      kind: edit.kind,
      scope: edit.scope,
      ...optional("scopeKey", edit.scopeKey),
      name: edit.name,
      content: normalizeContent(edit.content),
      ...metadata,
    };
  }
  return {
    operation: edit.operation,
    entryId: edit.entryId,
    expectedVersionId: edit.expectedVersionId,
    ...optional("name", edit.name),
    content: normalizeContent(edit.content),
    ...metadata,
  };
}

function normalizeContent(value: z.infer<typeof contentSchema>): unknown {
  if (value.kind === "memory" || value.kind === "prompt_note") return value;
  if (value.kind === "skill") {
    return {
      kind: value.kind,
      description: value.description,
      source: value.source,
      ...optional("inputSchema", value.inputSchema, decodeJsonValue),
      permissions: value.permissions,
      tests: value.tests.map((test) => ({
        name: test.name,
        input: decodeJsonValue(test.input),
        ...optional("expected", test.expected, decodeJsonValue),
        ...optional("expectedError", test.expectedError),
      })),
      runtime: value.runtime,
      ...optional("compatibility", value.compatibility),
    };
  }
  return {
    kind: value.kind,
    role: value.role,
    invocationCriteria: value.invocationCriteria,
    expectedArtifact: value.expectedArtifact,
    prompt: value.prompt,
    ...optional("model", value.model, normalizeModel),
    ...optional("budget", value.budget, normalizeBudget),
    ...optional("completionCriteria", value.completionCriteria),
  };
}

function normalizeModel(value: z.infer<typeof modelConfigurationSchema>): unknown {
  return {
    provider: value.provider,
    model: value.model,
    ...optional("temperature", value.temperature),
    ...optional("maxOutputTokens", value.maxOutputTokens),
    reasoningEffort: value.reasoningEffort,
  };
}

function normalizeBudget(value: z.infer<typeof budgetSchema>): unknown {
  return {
    ...optional("tokenLimit", value.tokenLimit),
    ...optional("costLimitUsd", value.costLimitUsd),
    ...optional("turnLimit", value.turnLimit),
    ...optional("wallTimeLimitMs", value.wallTimeLimitMs),
  };
}

function optional<T, R = T>(
  key: string,
  value: Presence<T>,
  normalize?: (value: T) => R,
): Record<string, T | R> {
  return value.present
    ? { [key]: normalize ? normalize(value.value) : value.value }
    : {};
}

function decodeJsonValue(value: TransportJsonValue): JsonValue {
  if (value.kind === "null") return null;
  if (value.kind === "string" || value.kind === "number" ||
      value.kind === "boolean") return value.value;
  if (value.kind === "array") return value.value.map(decodeJsonValue);
  const decoded: Record<string, JsonValue> = {};
  for (const entry of value.value) decoded[entry.key] = decodeJsonValue(entry.value);
  return decoded;
}

function assertEncodedBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError(
      "Refinement tool input byte count must be a positive safe integer",
    );
  }
  if (value > MAX_REFINEMENT_REVIEW_BYTES) {
    throw new ValidationError(
      `Refinement tool input exceeds ${MAX_REFINEMENT_REVIEW_BYTES} bytes`,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

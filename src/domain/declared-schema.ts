import { ValidationError } from "./errors.ts";
import {
  assertJsonValue,
  canonicalJsonByteLength,
  canonicalJsonDigest,
  canonicalJsonStringify,
  type JsonValue,
  type Sha256Digest,
} from "./json.ts";

export const DECLARED_SCHEMA_PROFILE_ID =
  "agencity.restricted-json-schema.draft-07.v1" as const;
export const DECLARED_SCHEMA_DRAFT =
  "http://json-schema.org/draft-07/schema#" as const;
export const DECLARED_SCHEMA_VALIDATOR_ID =
  "agencity.restricted-json-schema-validator.v1" as const;

export const MAX_DECLARED_SCHEMA_BYTES = 32 * 1024;
export const MAX_DECLARED_SCHEMA_DEPTH = 16;
export const MAX_DECLARED_SCHEMA_NODES = 256;
export const MAX_DECLARED_SCHEMA_PROPERTIES = 128;
export const MAX_DECLARED_SCHEMA_ALTERNATIVES = 32;
export const MAX_DECLARED_SCHEMA_ENUM_MEMBERS = 256;
export const MAX_DECLARED_SCHEMA_REFERENCES = 64;
export const MAX_DECLARED_SCHEMA_STRING_LENGTH = 16 * 1024;
export const MAX_DECLARED_SCHEMA_ARRAY_ITEMS = 256;
export const MAX_DECLARED_SCHEMA_MAP_PROPERTIES = 128;
export const MAX_DECLARED_SCHEMA_PATTERN_BYTES = 1_024;
export const MAX_DECLARED_INLINE_RESULT_BYTES = 64 * 1024;
export const MAX_DECLARED_SCHEMA_RAW_DEPTH = 80;
export const MAX_DECLARED_SCHEMA_RAW_NODES = 4_096;
const MAX_DECLARED_SCHEMA_VALIDATION_DEPTH =
  MAX_DECLARED_SCHEMA_NODES + MAX_DECLARED_SCHEMA_DEPTH + 1;

// Zod v4's built-in email format emits this bounded pattern. It contains a
// repeated, delimiter-terminated group that the conservative generic pattern
// guard below cannot prove safe, so retain the exact reviewed pattern only.
const ZOD_V4_EMAIL_PATTERN =
  "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$";
const ZOD_V4_HOSTNAME_PATTERN =
  "^(?=.{1,253}\\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\\.?$";

const SCHEMA_TYPES = new Set([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "integer",
  "string",
]);
const FORMATS = new Set([
  "date",
  "date-time",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "time",
  "uri",
  "uuid",
]);
const SCHEMA_KEYS = new Set([
  "$schema",
  "$defs",
  "$ref",
  "type",
  "title",
  "description",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "anyOf",
  "oneOf",
]);

export interface ResolvedDeclaredSchema {
  readonly profile: typeof DECLARED_SCHEMA_PROFILE_ID;
  readonly validatorId: typeof DECLARED_SCHEMA_VALIDATOR_ID;
  readonly schema: JsonValue;
  readonly schemaDigest: Sha256Digest;
  readonly schemaBytes: number;
  readonly inlineResultByteLimit: typeof MAX_DECLARED_INLINE_RESULT_BYTES;
}

interface SchemaCounters {
  nodes: number;
  properties: number;
  alternatives: number;
  enums: number;
  references: number;
}

interface SchemaContext {
  readonly root: boolean;
  readonly path: string;
  readonly depth: number;
  readonly counters: SchemaCounters;
  readonly definitions: ReadonlySet<string>;
}

/**
 * Canonicalizes the restricted profile. Host defaults close objects and apply
 * finite collection/string bounds, so provider and runtime validation share
 * the same durable schema rather than relying on implicit implementation caps.
 */
export function resolveDeclaredSchema(value: unknown): ResolvedDeclaredSchema {
  assertSafeRawSchemaStructure(value);
  assertJsonValue(value);
  if (!isRecord(value)) {
    throw new ValidationError("Declared JSON Schema must be an object");
  }
  if (canonicalJsonByteLength(value) > MAX_DECLARED_SCHEMA_BYTES) {
    throw new ValidationError(
      `Declared JSON Schema exceeds ${MAX_DECLARED_SCHEMA_BYTES} bytes`,
    );
  }
  const rawDefinitions = value.$defs;
  if (
    rawDefinitions !== undefined &&
    (!isRecord(rawDefinitions) ||
      Object.keys(rawDefinitions).some((name) => !validDefinitionName(name)))
  ) {
    throw new ValidationError(
      "Declared JSON Schema $defs must use simple local definition names",
    );
  }
  const definitions = new Set(Object.keys(rawDefinitions ?? {}));
  const counters: SchemaCounters = {
    nodes: 0,
    properties: 0,
    alternatives: 0,
    enums: 0,
    references: 0,
  };
  const canonical = normalizeSchema(value, {
    root: true,
    path: "$",
    depth: 0,
    counters,
    definitions,
  });
  assertAcyclicDefinitions(canonical);
  const schemaBytes = canonicalJsonByteLength(canonical);
  if (schemaBytes > MAX_DECLARED_SCHEMA_BYTES) {
    throw new ValidationError(
      `Canonical declared JSON Schema exceeds ${MAX_DECLARED_SCHEMA_BYTES} bytes`,
    );
  }
  const resolved: ResolvedDeclaredSchema = deepFreeze({
    profile: DECLARED_SCHEMA_PROFILE_ID,
    validatorId: DECLARED_SCHEMA_VALIDATOR_ID,
    schema: canonical,
    schemaDigest: canonicalJsonDigest(canonical),
    schemaBytes,
    inlineResultByteLimit: MAX_DECLARED_INLINE_RESULT_BYTES,
  });
  return resolved;
}

export function validateResolvedDeclaredSchema(
  value: unknown,
): ResolvedDeclaredSchema {
  assertJsonValue(value);
  if (!isRecord(value)) {
    throw new ValidationError("Resolved declared schema must be an object");
  }
  assertExactKeys(
    value,
    [
      "profile",
      "validatorId",
      "schema",
      "schemaDigest",
      "schemaBytes",
      "inlineResultByteLimit",
    ],
    "Resolved declared schema",
  );
  if (
    value.profile !== DECLARED_SCHEMA_PROFILE_ID ||
    value.validatorId !== DECLARED_SCHEMA_VALIDATOR_ID ||
    value.inlineResultByteLimit !== MAX_DECLARED_INLINE_RESULT_BYTES
  ) {
    throw new ValidationError(
      "Resolved declared schema does not use the supported profile",
    );
  }
  const expected = resolveDeclaredSchema(value.schema);
  if (
    value.schemaDigest !== expected.schemaDigest ||
    value.schemaBytes !== expected.schemaBytes ||
    canonicalJsonStringify(value.schema) !==
      canonicalJsonStringify(expected.schema)
  ) {
    throw new ValidationError(
      "Resolved declared schema disagrees with its canonical schema",
    );
  }
  return expected;
}

export function validateDeclaredSchemaValue(
  resolved: ResolvedDeclaredSchema,
  value: unknown,
): JsonValue {
  const retained = validateResolvedDeclaredSchema(resolved);
  assertJsonValue(value);
  const bytes = canonicalJsonByteLength(value);
  if (bytes > retained.inlineResultByteLimit) {
    throw new ValidationError(
      `Declared result exceeds ${retained.inlineResultByteLimit} bytes`,
    );
  }
  const schema = retained.schema as Record<string, JsonValue>;
  validateValueAgainstSchema(value, schema, schema, "$", 0);
  return value;
}

function normalizeSchema(
  input: Record<string, JsonValue>,
  context: SchemaContext,
): Record<string, JsonValue> {
  context.counters.nodes++;
  if (context.counters.nodes > MAX_DECLARED_SCHEMA_NODES) {
    throw new ValidationError(
      `Declared JSON Schema exceeds ${MAX_DECLARED_SCHEMA_NODES} nodes`,
    );
  }
  if (context.depth > MAX_DECLARED_SCHEMA_DEPTH) {
    throw new ValidationError(
      `Declared JSON Schema exceeds depth ${MAX_DECLARED_SCHEMA_DEPTH}`,
    );
  }
  for (const key of Object.keys(input)) {
    if (!SCHEMA_KEYS.has(key)) {
      throw new ValidationError(
        `Declared JSON Schema has unsupported keyword ${key} at ${context.path}`,
      );
    }
  }
  if (context.root) {
    if (
      input.$schema !== undefined &&
      input.$schema !== DECLARED_SCHEMA_DRAFT
    ) {
      throw new ValidationError(
        `Declared JSON Schema must target ${DECLARED_SCHEMA_DRAFT}`,
      );
    }
  } else if (input.$schema !== undefined || input.$defs !== undefined) {
    throw new ValidationError(
      `Declared JSON Schema metadata is allowed only at the root (${context.path})`,
    );
  }
  if (input.$ref !== undefined) {
    const allowedReferenceKeys = context.root
      ? new Set(["$ref", "$schema", "$defs"])
      : new Set(["$ref"]);
    if (Object.keys(input).some((key) => !allowedReferenceKeys.has(key))) {
      throw new ValidationError(
        `Declared JSON Schema references cannot have sibling keywords at ${context.path}`,
      );
    }
    if (
      typeof input.$ref !== "string" ||
      !input.$ref.startsWith("#/$defs/") ||
      !context.definitions.has(input.$ref.slice("#/$defs/".length))
    ) {
      throw new ValidationError(
        `Declared JSON Schema reference must resolve within root $defs at ${context.path}`,
      );
    }
    context.counters.references++;
    if (context.counters.references > MAX_DECLARED_SCHEMA_REFERENCES) {
      throw new ValidationError(
        `Declared JSON Schema exceeds ${MAX_DECLARED_SCHEMA_REFERENCES} references`,
      );
    }
    if (!context.root) return { $ref: input.$ref };
    const referencedRoot: Record<string, JsonValue> = {
      $schema: DECLARED_SCHEMA_DRAFT,
      $ref: input.$ref,
    };
    if (rawDefinitionsRecord(input.$defs)) {
      const canonicalDefinitions: Record<string, JsonValue> =
        Object.create(null);
      for (const name of Object.keys(input.$defs).sort()) {
        canonicalDefinitions[name] = normalizeNestedSchema(
          input.$defs[name],
          context,
          `$.$defs.${name}`,
        );
      }
      referencedRoot.$defs = canonicalDefinitions;
    }
    return referencedRoot;
  }

  const result: Record<string, JsonValue> = {};
  if (context.root) result.$schema = DECLARED_SCHEMA_DRAFT;
  copyBoundedAnnotation(input, result, "title", context.path);
  copyBoundedAnnotation(input, result, "description", context.path);

  if (input.type !== undefined) {
    if (typeof input.type !== "string" || !SCHEMA_TYPES.has(input.type)) {
      throw new ValidationError(
        `Declared JSON Schema type is unsupported at ${context.path}`,
      );
    }
    result.type = input.type;
  }

  if (input.const !== undefined) {
    assertScalarLiteral(input.const, "const", context.path);
    result.const = input.const;
  }
  if (input.enum !== undefined) {
    if (
      !Array.isArray(input.enum) ||
      input.enum.length === 0 ||
      input.enum.length > MAX_DECLARED_SCHEMA_ENUM_MEMBERS ||
      input.enum.some((item) => !isScalarJson(item))
    ) {
      throw new ValidationError(
        `Declared JSON Schema enum must contain 1 to ${MAX_DECLARED_SCHEMA_ENUM_MEMBERS} scalar values at ${context.path}`,
      );
    }
    const identities = input.enum.map(canonicalJsonStringify);
    if (new Set(identities).size !== identities.length) {
      throw new ValidationError(
        `Declared JSON Schema enum contains duplicate values at ${context.path}`,
      );
    }
    context.counters.enums += input.enum.length;
    if (context.counters.enums > MAX_DECLARED_SCHEMA_ENUM_MEMBERS) {
      throw new ValidationError(
        `Declared JSON Schema exceeds ${MAX_DECLARED_SCHEMA_ENUM_MEMBERS} total enum values`,
      );
    }
    result.enum = input.enum;
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    const alternatives = input[keyword];
    if (alternatives === undefined) continue;
    if (!Array.isArray(alternatives) || alternatives.length < 1) {
      throw new ValidationError(
        `Declared JSON Schema ${keyword} must be non-empty at ${context.path}`,
      );
    }
    context.counters.alternatives += alternatives.length;
    if (context.counters.alternatives > MAX_DECLARED_SCHEMA_ALTERNATIVES) {
      throw new ValidationError(
        `Declared JSON Schema exceeds ${MAX_DECLARED_SCHEMA_ALTERNATIVES} alternatives`,
      );
    }
    result[keyword] = alternatives.map((item, index) =>
      normalizeNestedSchema(
        item,
        context,
        `${context.path}.${keyword}[${index}]`,
      )
    );
  }

  const objectShape =
    input.type === "object" ||
    input.properties !== undefined ||
    input.additionalProperties !== undefined ||
    input.required !== undefined ||
    input.propertyNames !== undefined ||
    input.minProperties !== undefined ||
    input.maxProperties !== undefined;
  if (objectShape) {
    if (input.type !== undefined && input.type !== "object") {
      throw new ValidationError(
        `Declared JSON Schema object keywords require object type at ${context.path}`,
      );
    }
    result.type = "object";
    const properties = input.properties ?? {};
    if (!isRecord(properties)) {
      throw new ValidationError(
        `Declared JSON Schema properties must be an object at ${context.path}`,
      );
    }
    const propertyNames = Object.keys(properties);
    context.counters.properties += propertyNames.length;
    if (
      propertyNames.length > MAX_DECLARED_SCHEMA_PROPERTIES ||
      context.counters.properties > MAX_DECLARED_SCHEMA_PROPERTIES
    ) {
      throw new ValidationError(
        `Declared JSON Schema exceeds ${MAX_DECLARED_SCHEMA_PROPERTIES} properties`,
      );
    }
    if (propertyNames.length > 0) {
      const canonicalProperties: Record<string, JsonValue> =
        Object.create(null);
      for (const name of propertyNames.sort()) {
        if (!name || byteLength(name) > 256) {
          throw new ValidationError(
            `Declared JSON Schema property name is invalid at ${context.path}`,
          );
        }
        canonicalProperties[name] = normalizeNestedSchema(
          properties[name],
          context,
          `${context.path}.properties.${name}`,
        );
      }
      result.properties = canonicalProperties;
    }
    const required = input.required ?? [];
    if (
      !Array.isArray(required) ||
      required.some((name) => typeof name !== "string") ||
      new Set(required).size !== required.length ||
      required.some((name) =>
        typeof name !== "string" || !Object.hasOwn(properties, name)
      )
    ) {
      throw new ValidationError(
        `Declared JSON Schema required fields are invalid at ${context.path}`,
      );
    }
    if (required.length > 0) {
      result.required = (required as string[]).slice().sort();
    }
    if (input.additionalProperties === true) {
      throw new ValidationError(
        `Declared JSON Schema objects cannot be open at ${context.path}`,
      );
    }
    result.additionalProperties = input.additionalProperties === undefined ||
        input.additionalProperties === false
      ? false
      : normalizeNestedSchema(
          input.additionalProperties,
          context,
          `${context.path}.additionalProperties`,
        );
    if (input.propertyNames !== undefined) {
      result.propertyNames = normalizeNestedSchema(
        input.propertyNames,
        context,
        `${context.path}.propertyNames`,
      );
    }
    const minimum = boundedInteger(
      input.minProperties,
      0,
      MAX_DECLARED_SCHEMA_MAP_PROPERTIES,
      "minProperties",
      context.path,
    );
    const maximum = boundedInteger(
      input.maxProperties,
      0,
      MAX_DECLARED_SCHEMA_MAP_PROPERTIES,
      "maxProperties",
      context.path,
    ) ?? MAX_DECLARED_SCHEMA_MAP_PROPERTIES;
    if (minimum !== undefined) result.minProperties = minimum;
    result.maxProperties = maximum;
    if (minimum !== undefined && minimum > maximum) {
      throw new ValidationError(
        `Declared JSON Schema minProperties exceeds maxProperties at ${context.path}`,
      );
    }
  } else {
    rejectKeywords(input, [
      "properties",
      "required",
      "additionalProperties",
      "propertyNames",
      "minProperties",
      "maxProperties",
    ], context.path);
  }

  const arrayShape =
    input.type === "array" ||
    input.items !== undefined ||
    input.minItems !== undefined ||
    input.maxItems !== undefined ||
    input.uniqueItems !== undefined;
  if (arrayShape) {
    if (input.type !== undefined && input.type !== "array") {
      throw new ValidationError(
        `Declared JSON Schema array keywords require array type at ${context.path}`,
      );
    }
    if (!isRecord(input.items)) {
      throw new ValidationError(
        `Declared JSON Schema arrays require one item schema at ${context.path}`,
      );
    }
    result.type = "array";
    result.items = normalizeNestedSchema(
      input.items,
      context,
      `${context.path}.items`,
    );
    const minimum = boundedInteger(
      input.minItems,
      0,
      MAX_DECLARED_SCHEMA_ARRAY_ITEMS,
      "minItems",
      context.path,
    );
    const maximum = boundedInteger(
      input.maxItems,
      0,
      MAX_DECLARED_SCHEMA_ARRAY_ITEMS,
      "maxItems",
      context.path,
    ) ?? MAX_DECLARED_SCHEMA_ARRAY_ITEMS;
    if (minimum !== undefined) result.minItems = minimum;
    result.maxItems = maximum;
    if (minimum !== undefined && minimum > maximum) {
      throw new ValidationError(
        `Declared JSON Schema minItems exceeds maxItems at ${context.path}`,
      );
    }
    if (input.uniqueItems !== undefined) {
      if (input.uniqueItems !== true) {
        throw new ValidationError(
          `Declared JSON Schema uniqueItems must be true when present at ${context.path}`,
        );
      }
      result.uniqueItems = true;
    }
  } else {
    rejectKeywords(
      input,
      ["items", "minItems", "maxItems", "uniqueItems"],
      context.path,
    );
  }

  const stringShape =
    input.type === "string" ||
    input.minLength !== undefined ||
    input.maxLength !== undefined ||
    input.pattern !== undefined ||
    input.format !== undefined;
  if (stringShape) {
    if (input.type !== undefined && input.type !== "string") {
      throw new ValidationError(
        `Declared JSON Schema string keywords require string type at ${context.path}`,
      );
    }
    result.type = "string";
    const minimum = boundedInteger(
      input.minLength,
      0,
      MAX_DECLARED_SCHEMA_STRING_LENGTH,
      "minLength",
      context.path,
    );
    const maximum = boundedInteger(
      input.maxLength,
      0,
      MAX_DECLARED_SCHEMA_STRING_LENGTH,
      "maxLength",
      context.path,
    ) ?? MAX_DECLARED_SCHEMA_STRING_LENGTH;
    if (minimum !== undefined) result.minLength = minimum;
    result.maxLength = maximum;
    if (minimum !== undefined && minimum > maximum) {
      throw new ValidationError(
        `Declared JSON Schema minLength exceeds maxLength at ${context.path}`,
      );
    }
    if (input.pattern !== undefined) {
      if (
        typeof input.pattern !== "string" ||
        byteLength(input.pattern) > MAX_DECLARED_SCHEMA_PATTERN_BYTES
      ) {
        throw new ValidationError(
          `Declared JSON Schema pattern is invalid at ${context.path}`,
        );
      }
      try {
        new RegExp(input.pattern, "u");
      } catch {
        throw new ValidationError(
          `Declared JSON Schema pattern is invalid at ${context.path}`,
        );
      }
      assertSafePattern(input.pattern, context.path);
      result.pattern = input.pattern;
    }
    if (input.format !== undefined) {
      if (typeof input.format !== "string" || !FORMATS.has(input.format)) {
        throw new ValidationError(
          `Declared JSON Schema format is unsupported at ${context.path}`,
        );
      }
      result.format = input.format;
    }
  } else {
    rejectKeywords(
      input,
      ["minLength", "maxLength", "pattern", "format"],
      context.path,
    );
  }

  const numericShape =
    input.type === "number" ||
    input.type === "integer" ||
    [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
    ].some((key) => input[key] !== undefined);
  if (numericShape) {
    if (
      input.type !== undefined &&
      input.type !== "number" &&
      input.type !== "integer"
    ) {
      throw new ValidationError(
        `Declared JSON Schema numeric keywords require number or integer type at ${context.path}`,
      );
    }
    if (input.type === undefined) result.type = "number";
    for (
      const keyword of [
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
      ] as const
    ) {
      const candidate = input[keyword];
      if (candidate === undefined) continue;
      if (
        typeof candidate !== "number" ||
        !Number.isFinite(candidate) ||
        (keyword === "multipleOf" && candidate <= 0)
      ) {
        throw new ValidationError(
          `Declared JSON Schema ${keyword} is invalid at ${context.path}`,
        );
      }
      result[keyword] = candidate;
    }
    assertNumericBounds(result, context.path);
  } else {
    rejectKeywords(
      input,
      [
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
      ],
      context.path,
    );
  }

  if (context.root && rawDefinitionsRecord(input.$defs)) {
    const canonicalDefinitions: Record<string, JsonValue> =
      Object.create(null);
    for (const name of Object.keys(input.$defs).sort()) {
      canonicalDefinitions[name] = normalizeNestedSchema(
        input.$defs[name],
        context,
        `$.$defs.${name}`,
      );
    }
    result.$defs = canonicalDefinitions;
  }
  const hasAssertion = [
    "type",
    "const",
    "enum",
    "anyOf",
    "oneOf",
    "allOf",
  ].some((key) => result[key] !== undefined);
  if (!hasAssertion) {
    throw new ValidationError(
      `Declared JSON Schema is unconstrained at ${context.path}`,
    );
  }
  return result;
}

function normalizeNestedSchema(
  value: JsonValue | undefined,
  parent: SchemaContext,
  path: string,
): Record<string, JsonValue> {
  if (!isRecord(value)) {
    throw new ValidationError(
      `Declared JSON Schema child must be an object at ${path}`,
    );
  }
  return normalizeSchema(value, {
    ...parent,
    root: false,
    path,
    depth: parent.depth + 1,
  });
}

function validateValueAgainstSchema(
  value: JsonValue,
  schema: Record<string, JsonValue>,
  root: Record<string, JsonValue>,
  path: string,
  depth: number,
): void {
  if (depth > MAX_DECLARED_SCHEMA_VALIDATION_DEPTH) {
    throw new ValidationError(`Declared result exceeds validation depth at ${path}`);
  }
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.slice("#/$defs/".length);
    const definitions = root.$defs;
    if (!isRecord(definitions) || !isRecord(definitions[name])) {
      throw new ValidationError("Declared result schema reference is unavailable");
    }
    validateValueAgainstSchema(value, definitions[name], root, path, depth + 1);
    return;
  }
  if (
    schema.const !== undefined &&
    canonicalJsonStringify(value) !== canonicalJsonStringify(schema.const)
  ) {
    failValue(path);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) =>
      canonicalJsonStringify(item) === canonicalJsonStringify(value)
    )
  ) {
    failValue(path);
  }
  validateCombiners(value, schema, root, path, depth);
  if (typeof schema.type !== "string") return;
  switch (schema.type) {
    case "null":
      if (value !== null) failValue(path);
      return;
    case "boolean":
      if (typeof value !== "boolean") failValue(path);
      return;
    case "number":
    case "integer":
      if (
        typeof value !== "number" ||
        (schema.type === "integer" && !Number.isInteger(value))
      ) {
        failValue(path);
      }
      validateNumber(value as number, schema, path);
      return;
    case "string":
      if (typeof value !== "string") failValue(path);
      validateString(value as string, schema, path);
      return;
    case "array": {
      if (!Array.isArray(value)) failValue(path);
      const array = value as JsonValue[];
      assertLength(
        array.length,
        schema.minItems,
        schema.maxItems,
        path,
      );
      if (schema.uniqueItems === true) {
        const identities = array.map(canonicalJsonStringify);
        if (new Set(identities).size !== identities.length) failValue(path);
      }
      if (!isRecord(schema.items)) failValue(path);
      array.forEach((item, index) =>
        validateValueAgainstSchema(
          item,
          schema.items as Record<string, JsonValue>,
          root,
          `${path}[${index}]`,
          depth + 1,
        )
      );
      return;
    }
    case "object": {
      if (!isRecord(value)) failValue(path);
      const object = value as Record<string, JsonValue>;
      const keys = Object.keys(object);
      assertLength(
        keys.length,
        schema.minProperties,
        schema.maxProperties,
        path,
      );
      const properties = isRecord(schema.properties)
        ? schema.properties
        : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      if (
        required.some((name) =>
          typeof name !== "string" || !Object.hasOwn(object, name)
        )
      ) {
        failValue(path);
      }
      for (const key of keys) {
        if (isRecord(schema.propertyNames)) {
          validateValueAgainstSchema(
            key,
            schema.propertyNames,
            root,
            `${path} key`,
            depth + 1,
          );
        }
        const propertySchema = properties[key];
        if (isRecord(propertySchema)) {
          validateValueAgainstSchema(
            object[key]!,
            propertySchema,
            root,
            `${path}.${key}`,
            depth + 1,
          );
        } else if (isRecord(schema.additionalProperties)) {
          validateValueAgainstSchema(
            object[key]!,
            schema.additionalProperties,
            root,
            `${path}.${key}`,
            depth + 1,
          );
        } else {
          failValue(`${path}.${key}`);
        }
      }
      return;
    }
  }
}

function validateCombiners(
  value: JsonValue,
  schema: Record<string, JsonValue>,
  root: Record<string, JsonValue>,
  path: string,
  depth: number,
): void {
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const alternatives = schema[keyword];
    if (!Array.isArray(alternatives)) continue;
    let successes = 0;
    for (const alternative of alternatives) {
      try {
        validateValueAgainstSchema(
          value,
          alternative as Record<string, JsonValue>,
          root,
          path,
          depth + 1,
        );
        successes++;
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
      }
    }
    if (
      keyword === "oneOf"
        ? successes !== 1
        : successes < 1
    ) {
      failValue(path);
    }
  }
}

function validateString(
  value: string,
  schema: Record<string, JsonValue>,
  path: string,
): void {
  const length = [...value].length;
  assertLength(length, schema.minLength, schema.maxLength, path);
  if (
    typeof schema.pattern === "string" &&
    !new RegExp(schema.pattern, "u").test(value)
  ) {
    failValue(path);
  }
  if (typeof schema.format === "string" && !validFormat(schema.format, value)) {
    failValue(path);
  }
}

function validateNumber(
  value: number,
  schema: Record<string, JsonValue>,
  path: string,
): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) failValue(path);
  if (typeof schema.maximum === "number" && value > schema.maximum) failValue(path);
  if (
    typeof schema.exclusiveMinimum === "number" &&
    value <= schema.exclusiveMinimum
  ) {
    failValue(path);
  }
  if (
    typeof schema.exclusiveMaximum === "number" &&
    value >= schema.exclusiveMaximum
  ) {
    failValue(path);
  }
  if (typeof schema.multipleOf === "number") {
    const quotient = value / schema.multipleOf;
    if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * 16) {
      failValue(path);
    }
  }
}

function validFormat(format: string, value: string): boolean {
  switch (format) {
    case "date":
      return validCalendarDate(value);
    case "date-time": {
      const match =
        /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
          .exec(value);
      return Boolean(match && validCalendarDate(match[1]!));
    }
    case "time":
      return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
        .test(value);
    case "duration":
      return /^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/
        .test(value);
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case "hostname":
      return value.length <= 253 &&
        value.split(".").every((part) =>
          /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/.test(part)
        );
    case "ipv4": {
      return validIpv4(value);
    }
    case "ipv6":
      return validIpv6(value);
    case "uri":
      try {
        return Boolean(new URL(value).protocol);
      } catch {
        return false;
      }
    case "uuid":
      return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i
        .test(value);
    default:
      return false;
  }
}

function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day >= 1 && day <= days[month - 1]!;
}

function validIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 &&
    parts.every((part) =>
      /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255
    );
}

function validIpv6(value: string): boolean {
  let normalized = value;
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    if (separator < 0) return false;
    const ipv4 = value.slice(separator + 1);
    if (!validIpv4(ipv4)) return false;
    const octets = ipv4.split(".").map(Number);
    normalized = `${value.slice(0, separator)}:${
      ((octets[0]! << 8) | octets[1]!).toString(16)
    }:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => half ? half.split(":") : []);
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

function assertAcyclicDefinitions(schema: Record<string, JsonValue>): void {
  if (!isRecord(schema.$defs)) return;
  const graph = new Map<string, Set<string>>();
  for (const [name, definition] of Object.entries(schema.$defs)) {
    const references = new Set<string>();
    collectReferences(definition, references);
    graph.set(name, references);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) {
      throw new ValidationError(
        "Declared JSON Schema cannot contain recursive references",
      );
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const target of graph.get(name) ?? []) visit(target);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of graph.keys()) visit(name);
}

function collectReferences(value: JsonValue, references: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectReferences(item, references));
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.$ref === "string") {
    references.add(value.$ref.slice("#/$defs/".length));
  }
  for (const child of Object.values(value)) collectReferences(child, references);
}

function assertNumericBounds(
  schema: Record<string, JsonValue>,
  path: string,
): void {
  const lower = typeof schema.minimum === "number"
    ? schema.minimum
    : typeof schema.exclusiveMinimum === "number"
      ? schema.exclusiveMinimum
      : undefined;
  const upper = typeof schema.maximum === "number"
    ? schema.maximum
    : typeof schema.exclusiveMaximum === "number"
      ? schema.exclusiveMaximum
      : undefined;
  if (lower !== undefined && upper !== undefined && lower > upper) {
    throw new ValidationError(
      `Declared JSON Schema numeric lower bound exceeds upper bound at ${path}`,
    );
  }
}

/**
 * JavaScript regular expressions have no execution timeout. Reject constructs
 * with common exponential/polynomial backtracking shapes before a declared
 * result can execute them against a bounded but attacker-controlled string.
 * This intentionally accepts a smaller language than ECMA-262.
 */
function assertSafePattern(pattern: string, path: string): void {
  if (
    pattern === ZOD_V4_EMAIL_PATTERN ||
    pattern === ZOD_V4_HOSTNAME_PATTERN
  ) {
    return;
  }
  const groups: Array<{
    hasAlternation: boolean;
    hasVariableRepeat: boolean;
  }> = [{ hasAlternation: false, hasVariableRepeat: false }];
  let lastClosedGroup:
    | { hasAlternation: boolean; hasVariableRepeat: boolean }
    | null = null;
  let unboundedRepeats = 0;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === "\\") {
      const escaped = pattern[index + 1];
      if (
        escaped === undefined ||
        /[1-9]/.test(escaped) ||
        (escaped === "k" && pattern[index + 2] === "<")
      ) {
        throw new ValidationError(
          `Declared JSON Schema pattern is unsafe at ${path}`,
        );
      }
      index++;
      lastClosedGroup = null;
      continue;
    }
    if (character === "[") {
      let closed = false;
      for (index++; index < pattern.length; index++) {
        if (pattern[index] === "\\") {
          index++;
          continue;
        }
        if (pattern[index] === "]") {
          closed = true;
          break;
        }
      }
      if (!closed) {
        throw new ValidationError(
          `Declared JSON Schema pattern is invalid at ${path}`,
        );
      }
      lastClosedGroup = null;
      continue;
    }
    if (character === "(") {
      groups.push({ hasAlternation: false, hasVariableRepeat: false });
      lastClosedGroup = null;
      continue;
    }
    if (character === ")") {
      const closed = groups.pop();
      if (!closed || groups.length === 0) {
        throw new ValidationError(
          `Declared JSON Schema pattern is invalid at ${path}`,
        );
      }
      const parent = groups.at(-1)!;
      parent.hasAlternation ||= closed.hasAlternation;
      parent.hasVariableRepeat ||= closed.hasVariableRepeat;
      lastClosedGroup = closed;
      continue;
    }
    if (character === "|") {
      groups.at(-1)!.hasAlternation = true;
      lastClosedGroup = null;
      continue;
    }
    let quantifier:
      | { minimum: number; maximum: number }
      | undefined;
    if (character === "*") {
      quantifier = { minimum: 0, maximum: Number.POSITIVE_INFINITY };
    } else if (character === "+") {
      quantifier = { minimum: 1, maximum: Number.POSITIVE_INFINITY };
    } else if (character === "?" && pattern[index - 1] !== "(") {
      quantifier = { minimum: 0, maximum: 1 };
    }
    if (character === "{") {
      const remainder = pattern.slice(index);
      const match = /^\{(\d+)(?:,(\d*))?\}/.exec(remainder);
      if (match) {
        const minimum = Number(match[1]);
        const maximum = match[2] === undefined
          ? minimum
          : match[2] === ""
            ? Number.POSITIVE_INFINITY
            : Number(match[2]);
        if (
          !Number.isSafeInteger(minimum) ||
          (!Number.isFinite(maximum) && maximum !== Number.POSITIVE_INFINITY) ||
          (Number.isFinite(maximum) && !Number.isSafeInteger(maximum)) ||
          minimum > maximum
        ) {
          throw new ValidationError(
            `Declared JSON Schema pattern is invalid at ${path}`,
          );
        }
        quantifier = { minimum, maximum };
        index += match[0].length - 1;
      }
    }
    if (quantifier) {
      if (
        quantifier.maximum > 1 &&
        (lastClosedGroup?.hasAlternation ||
          lastClosedGroup?.hasVariableRepeat)
      ) {
        throw new ValidationError(
          `Declared JSON Schema pattern is unsafe at ${path}`,
        );
      }
      if (quantifier.minimum !== quantifier.maximum) {
        groups.at(-1)!.hasVariableRepeat = true;
      }
      if (quantifier.maximum === Number.POSITIVE_INFINITY) {
        unboundedRepeats++;
        if (unboundedRepeats > 8) {
          throw new ValidationError(
            `Declared JSON Schema pattern has too many unbounded repetitions at ${path}`,
          );
        }
      }
      lastClosedGroup = null;
      continue;
    }
    lastClosedGroup = null;
  }
}

function copyBoundedAnnotation(
  input: Record<string, JsonValue>,
  result: Record<string, JsonValue>,
  key: "title" | "description",
  path: string,
): void {
  const value = input[key];
  if (value === undefined) return;
  if (typeof value !== "string" || byteLength(value) > 2_048) {
    throw new ValidationError(
      `Declared JSON Schema ${key} is invalid at ${path}`,
    );
  }
  result[key] = value;
}

function boundedInteger(
  value: JsonValue | undefined,
  minimum: number,
  maximum: number,
  keyword: string,
  path: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ValidationError(
      `Declared JSON Schema ${keyword} is invalid at ${path}`,
    );
  }
  return value;
}

function assertLength(
  length: number,
  minimum: JsonValue | undefined,
  maximum: JsonValue | undefined,
  path: string,
): void {
  if (typeof minimum === "number" && length < minimum) failValue(path);
  if (typeof maximum === "number" && length > maximum) failValue(path);
}

function rejectKeywords(
  input: Record<string, JsonValue>,
  keys: readonly string[],
  path: string,
): void {
  const found = keys.find((key) => input[key] !== undefined);
  if (found) {
    throw new ValidationError(
      `Declared JSON Schema keyword ${found} is incompatible at ${path}`,
    );
  }
}

function failValue(path: string): never {
  throw new ValidationError(`Declared result does not satisfy schema at ${path}`);
}

function rawDefinitionsRecord(
  value: JsonValue | undefined,
): value is Record<string, JsonValue> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function validDefinitionName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value);
}

function assertScalarLiteral(
  value: JsonValue,
  keyword: string,
  path: string,
): void {
  if (!isScalarJson(value)) {
    throw new ValidationError(
      `Declared JSON Schema ${keyword} must use scalar JSON values at ${path}`,
    );
  }
}

/**
 * Rejects hostile object graphs before generic JSON validation or canonical
 * encoding recurse. Accessors and non-plain objects are excluded because their
 * traversal can execute code or produce process-dependent JSON.
 */
function assertSafeRawSchemaStructure(value: unknown): void {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (candidate === null || typeof candidate !== "object") return;
    if (depth > MAX_DECLARED_SCHEMA_RAW_DEPTH) {
      throw new ValidationError(
        `Declared JSON Schema raw input exceeds depth ${MAX_DECLARED_SCHEMA_RAW_DEPTH}`,
      );
    }
    if (ancestors.has(candidate)) {
      throw new ValidationError(
        "Declared JSON Schema raw input cannot contain cyclic references",
      );
    }
    nodes++;
    if (nodes > MAX_DECLARED_SCHEMA_RAW_NODES) {
      throw new ValidationError(
        `Declared JSON Schema raw input exceeds ${MAX_DECLARED_SCHEMA_RAW_NODES} nodes`,
      );
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (
      !Array.isArray(candidate) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new ValidationError(
        "Declared JSON Schema raw input must contain only plain JSON objects",
      );
    }
    const keys = Reflect.ownKeys(candidate);
    if (keys.some((key) => typeof key === "symbol")) {
      throw new ValidationError(
        "Declared JSON Schema raw input cannot contain symbol properties",
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_DECLARED_SCHEMA_RAW_NODES) {
        throw new ValidationError(
          `Declared JSON Schema raw input exceeds ${MAX_DECLARED_SCHEMA_RAW_NODES} nodes`,
        );
      }
      for (let index = 0; index < candidate.length; index++) {
        if (!Object.hasOwn(candidate, String(index))) {
          throw new ValidationError(
            "Declared JSON Schema raw input arrays must be dense plain JSON arrays",
          );
        }
      }
      if (keys.some((key) => {
        if (key === "length") return false;
        return !/^(?:0|[1-9]\d*)$/.test(key as string) ||
          Number(key) >= candidate.length;
      })) {
        throw new ValidationError(
          "Declared JSON Schema raw input arrays must be dense plain JSON arrays",
        );
      }
    } else if (
      keys.some((key) => descriptors[key as string]?.enumerable !== true)
    ) {
      throw new ValidationError(
        "Declared JSON Schema raw input cannot contain hidden properties",
      );
    }
    ancestors.add(candidate);
    try {
      for (const key of keys as string[]) {
        const descriptor = descriptors[key];
        if (!descriptor || descriptor.get || descriptor.set) {
          throw new ValidationError(
            "Declared JSON Schema raw input cannot contain accessors",
          );
        }
        visit(descriptor.value, depth + 1);
      }
    } finally {
      ancestors.delete(candidate);
    }
  };
  visit(value, 0);
}

function isScalarJson(value: JsonValue): value is null | boolean | number | string {
  return value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertExactKeys(
  value: Record<string, JsonValue>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (
    expected.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !expected.includes(key))
  ) {
    throw new ValidationError(`${label} has missing or unknown fields`);
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

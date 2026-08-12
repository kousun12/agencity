import { describe, expect, test } from "bun:test";
import {
  DECLARED_SCHEMA_DRAFT,
  DECLARED_SCHEMA_PROFILE_ID,
  MAX_DECLARED_INLINE_RESULT_BYTES,
  MAX_DECLARED_SCHEMA_RAW_DEPTH,
  MAX_DECLARED_SCHEMA_DEPTH,
  MAX_DECLARED_SCHEMA_PROPERTIES,
  canonicalJsonStringify,
  registerBrokeredSecret,
  resolveConsoleDeclaredSchema,
  resolveDeclaredSchema,
  validateDeclaredSchemaValue,
  validateResolvedDeclaredSchema,
} from "../../src/index.ts";

describe("restricted declared JSON Schema profile", () => {
  test("canonicalizes key order, closes objects, and applies finite bounds", () => {
    const first = resolveDeclaredSchema({
      required: ["name", "tags"],
      properties: {
        tags: { items: { type: "string" }, type: "array" },
        name: { type: "string" },
      },
      type: "object",
    });
    const second = resolveDeclaredSchema({
      type: "object",
      properties: {
        name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["tags", "name"],
    });
    expect(first.profile).toBe(DECLARED_SCHEMA_PROFILE_ID);
    expect(first.schema).toMatchObject({
      $schema: DECLARED_SCHEMA_DRAFT,
      additionalProperties: false,
      maxProperties: 128,
      properties: {
        name: { type: "string", maxLength: 16_384 },
        tags: {
          type: "array",
          maxItems: 256,
          items: { type: "string", maxLength: 16_384 },
        },
      },
      required: ["name", "tags"],
    });
    expect(first.schemaDigest).toBe(second.schemaDigest);
    expect(first.schemaBytes).toBe(second.schemaBytes);
    expect(canonicalJsonStringify(first.schema))
      .toBe(canonicalJsonStringify(second.schema));
    expect(validateResolvedDeclaredSchema(structuredClone(first)).schemaDigest)
      .toBe(first.schemaDigest);
  });

  test("supports bounded acyclic local definitions and runtime validation", () => {
    const resolved = resolveDeclaredSchema({
      $defs: {
        item: {
          type: "object",
          properties: { id: { type: "integer", minimum: 1 } },
          required: ["id"],
        },
      },
      type: "array",
      items: { $ref: "#/$defs/item" },
      maxItems: 2,
    });
    expect(validateDeclaredSchemaValue(resolved, [{ id: 1 }, { id: 2 }]))
      .toEqual([{ id: 1 }, { id: 2 }]);
    expect(() => validateDeclaredSchemaValue(resolved, [{ id: 0 }]))
      .toThrow("does not satisfy schema");
    expect(() => validateDeclaredSchemaValue(resolved, [{ id: 1, extra: true }]))
      .toThrow("does not satisfy schema");
    expect(() => validateDeclaredSchemaValue(resolved, [
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ])).toThrow("does not satisfy schema");
  });

  test("validates accepted acyclic reference chains at runtime", () => {
    const definitions: Record<string, unknown> = {};
    for (let index = 0; index < 24; index++) {
      definitions[`level${index}`] = index === 23
        ? { type: "string" }
        : { $ref: `#/$defs/level${index + 1}` };
    }
    const resolved = resolveDeclaredSchema({
      $defs: definitions,
      $ref: "#/$defs/level0",
    });
    expect(validateDeclaredSchemaValue(resolved, "retained")).toBe("retained");
  });

  test("validates calendar dates and IP formats without parser normalization", () => {
    const resolved = resolveDeclaredSchema({
      type: "object",
      properties: {
        date: { type: "string", format: "date" },
        ipv6: { type: "string", format: "ipv6" },
      },
      required: ["date", "ipv6"],
    });
    expect(() => validateDeclaredSchemaValue(resolved, {
      date: "2024-02-29",
      ipv6: "2001:db8::1",
    })).not.toThrow();
    expect(() => validateDeclaredSchemaValue(resolved, {
      date: "2026-02-30",
      ipv6: "::::",
    })).toThrow("does not satisfy schema");
  });

  test("binds prototype-shaped property names as ordinary closed fields", () => {
    const resolved = resolveDeclaredSchema(JSON.parse(`{
      "type": "object",
      "properties": { "__proto__": { "type": "string" } },
      "required": ["__proto__"]
    }`));
    const properties = (resolved.schema as any).properties;
    expect(Object.hasOwn(properties, "__proto__")).toBe(true);
    expect(() =>
      validateDeclaredSchemaValue(
        resolved,
        JSON.parse(`{ "__proto__": "ordinary data" }`),
      )
    ).not.toThrow();
  });

  test.each([
    ["unknown keyword", { type: "string", default: "x" }, /unsupported keyword default/],
    ["external reference", { $ref: "https://example.com/schema" }, /root \$defs/],
    [
      "missing reference",
      { $defs: {}, $ref: "#/$defs/missing" },
      /root \$defs/,
    ],
    [
      "recursive reference",
      {
        $defs: { node: { $ref: "#/$defs/node" } },
        $ref: "#/$defs/node",
      },
      /recursive references/,
    ],
    ["open object", { type: "object", additionalProperties: true }, /cannot be open/],
    ["unsupported format", { type: "string", format: "password" }, /format is unsupported/],
    ["object enum member", { enum: [{ unsafe: "shape" }] }, /scalar values/],
    ["object const", { const: { unsafe: "shape" } }, /scalar JSON values/],
    ["all-of intersection", { allOf: [{ type: "string" }] }, /unsupported keyword allOf/],
    ["definitions without a root assertion", {
      $defs: { value: { type: "string" } },
    }, /is unconstrained/],
    ["tuple array", { type: "array", items: [{ type: "string" }] }, /one item schema/],
    ["boolean schema", true, /must be an object/],
  ])("rejects %s", (_name, schema, message) => {
    expect(() => resolveDeclaredSchema(schema)).toThrow(message);
  });

  test("enforces aggregate complexity and depth bounds", () => {
    const properties = Object.fromEntries(
      Array.from(
        { length: MAX_DECLARED_SCHEMA_PROPERTIES + 1 },
        (_, index) => [`p${index}`, { type: "boolean" }],
      ),
    );
    expect(() => resolveDeclaredSchema({ type: "object", properties }))
      .toThrow(`exceeds ${MAX_DECLARED_SCHEMA_PROPERTIES} properties`);

    let nested: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < MAX_DECLARED_SCHEMA_DEPTH + 1; index++) {
      nested = { type: "array", items: nested };
    }
    expect(() => resolveDeclaredSchema(nested))
      .toThrow(`exceeds depth ${MAX_DECLARED_SCHEMA_DEPTH}`);
  });

  test("rejects cyclic and pathologically deep raw input before JSON recursion", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.self = cyclic;
    expect(() => resolveDeclaredSchema(cyclic))
      .toThrow("cannot contain cyclic references");

    let nested: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < MAX_DECLARED_SCHEMA_RAW_DEPTH + 10; index++) {
      nested = { type: "array", items: nested };
    }
    expect(() => resolveDeclaredSchema(nested))
      .toThrow(`raw input exceeds depth ${MAX_DECLARED_SCHEMA_RAW_DEPTH}`);
  });

  test.each([
    "(a+)+$",
    "(a|aa)+$",
    "(a{1,100}){1,100}$",
    String.raw`(a)\1`,
  ])("rejects unsafe executable pattern %s", (pattern) => {
    expect(() => resolveDeclaredSchema({ type: "string", pattern }))
      .toThrow(/pattern is unsafe/);
  });

  test("rejects secrets in schema annotations at the worker boundary", () => {
    const secret = "sk-proj-declared-schema-secret-123456";
    const release = registerBrokeredSecret(secret);
    try {
      expect(() =>
        resolveConsoleDeclaredSchema({
          type: "string",
          description: `Never retain ${secret}`,
        })
      ).toThrow("contains credential material");
    } finally {
      release();
    }
  });

  test("fails closed above the hard inline result bound", () => {
    const resolved = resolveDeclaredSchema({
      type: "string",
      maxLength: 16_384,
    });
    // Four-byte code points stay within the profile character cap while
    // exceeding the independent canonical UTF-8 result bound.
    const oversized = "😀".repeat(16_384);
    expect(() => validateDeclaredSchemaValue(resolved, oversized))
      .toThrow(`exceeds ${MAX_DECLARED_INLINE_RESULT_BYTES} bytes`);
  });
});

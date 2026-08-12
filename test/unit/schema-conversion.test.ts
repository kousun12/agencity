import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  resolveConsoleDeclaredSchema,
  schemaToPlainJsonSchema,
  validateDeclaredSchemaValue,
} from "../../src/index.ts";

describe("console declared-schema conversion", () => {
  test("converts supported Zod v4 and plain schemas to identical plain JSON", () => {
    const zodSchema = z.object({
      complete: z.boolean(),
      missing: z.array(z.string()),
      confidence: z.number().min(0).max(1),
      status: z.enum(["passed", "failed"]),
      note: z.string().optional(),
    });
    const converted = resolveConsoleDeclaredSchema(zodSchema);
    expect(JSON.stringify(converted.schema)).not.toContain("~standard");
    expect(converted.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        confidence: { type: "number", minimum: 0, maximum: 1 },
        status: { type: "string", enum: ["passed", "failed"] },
      },
      required: ["complete", "confidence", "missing", "status"],
    });
    const plain = resolveConsoleDeclaredSchema(
      structuredClone(converted.schema),
    );
    expect(plain.schemaDigest).toBe(converted.schemaDigest);
    expect(schemaToPlainJsonSchema(zodSchema)).toEqual(converted.schema);
    expect(validateDeclaredSchemaValue(converted, {
      complete: true,
      missing: [],
      confidence: 0.75,
      status: "passed",
    })).toMatchObject({ complete: true, confidence: 0.75 });
  });

  test("supports representable Zod unions, nullability, and scalar formats", () => {
    const converted = resolveConsoleDeclaredSchema(z.object({
      id: z.uuid(),
      when: z.iso.datetime(),
      value: z.union([z.string(), z.number()]).nullable(),
    }));
    expect(() => validateDeclaredSchemaValue(converted, {
      id: "550e8400-e29b-41d4-a716-446655440000",
      when: "2026-08-11T12:00:00Z",
      value: null,
    })).not.toThrow();
    expect(() => validateDeclaredSchemaValue(converted, {
      id: "not-a-uuid",
      when: "yesterday",
      value: true,
    })).toThrow("does not satisfy schema");
  });

  test("preserves Zod format semantics without conflicting assertions", () => {
    const converted = resolveConsoleDeclaredSchema(z.object({
      when: z.iso.datetime(),
      host: z.hostname(),
      address: z.ipv6(),
      email: z.email(),
    }));
    const properties = (converted.schema as any).properties;
    expect(properties.when).not.toHaveProperty("format");
    expect(properties.when).toHaveProperty("pattern");
    expect(properties.host).not.toHaveProperty("format");
    expect(properties.address).toMatchObject({ format: "ipv6" });
    expect(properties.address).not.toHaveProperty("pattern");
    expect(() => validateDeclaredSchemaValue(converted, {
      when: "2026-08-11T12:00Z",
      host: "example.com.",
      address: "::ffff:192.0.2.1",
      email: "agent@example.com",
    })).not.toThrow();
  });

  test("preserves explicitly Unicode Zod regular expressions", () => {
    const converted = resolveConsoleDeclaredSchema(
      z.string().regex(/^.{2}$/u),
    );
    expect(() => validateDeclaredSchemaValue(converted, "ab")).not.toThrow();
    expect(() => validateDeclaredSchemaValue(converted, "😀"))
      .toThrow("does not satisfy schema");
  });

  test.each([
    ["transform", z.string().transform((value) => value.length)],
    ["preprocessor", z.preprocess((value) => value, z.string())],
    ["refinement", z.string().refine((value) => value.length > 0)],
    ["default", z.string().default("value")],
    ["catch", z.string().catch("value")],
    ["lazy", z.lazy(() => z.string())],
    ["custom validator", z.custom<string>(() => true)],
    ["coercion", z.coerce.string()],
    ["overwrite", z.string().trim()],
    ["UTF-16 string length", z.string().max(1)],
    ["non-Unicode regex flags", z.string().regex(/value/i)],
    ["readonly output mutation", z.object({ value: z.string() }).readonly()],
    ["intersection", z.intersection(
      z.object({ left: z.string() }),
      z.object({ right: z.string() }),
    )],
  ])("rejects Zod %s semantics instead of degrading them", (_name, schema) => {
    expect(() => resolveConsoleDeclaredSchema(schema)).toThrow();
  });

  test("rejects unknown and malformed Standard Schema vendors", () => {
    expect(() =>
      resolveConsoleDeclaredSchema({
        "~standard": {
          version: 1,
          vendor: "other",
          validate: () => ({ value: "x" }),
          jsonSchema: {
            output: () => ({ type: "string" }),
          },
        },
      })
    ).toThrow("Unsupported Standard Schema vendor");
    expect(() =>
      resolveConsoleDeclaredSchema({
        "~standard": { version: 2, vendor: "zod" },
      })
    ).toThrow("Malformed Standard Schema");
  });
});

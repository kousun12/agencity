import { z } from "zod";
import {
  ValidationError,
  canonicalJsonStringify,
  resolveDeclaredSchema,
  type JsonValue,
  type ResolvedDeclaredSchema,
} from "../domain/index.ts";
import {
  containsBrokeredSecret,
  containsCredentialMaterial,
} from "../security/index.ts";

export interface StandardSchemaLike {
  readonly "~standard": {
    readonly version: number;
    readonly vendor: string;
    readonly validate?: unknown;
    readonly jsonSchema?: {
      readonly output?: (options: {
        readonly target: "draft-07";
      }) => unknown;
    };
  };
}

/**
 * Worker-side ergonomic conversion. The returned value contains no functions,
 * schema instances, or vendor runtime state and is safe to send through RPC.
 * The supervisor must independently call resolveDeclaredSchema again.
 */
export function schemaToPlainJsonSchema(value: unknown): JsonValue {
  return resolveConsoleDeclaredSchema(value).schema;
}

export function resolveConsoleDeclaredSchema(
  value: unknown,
): ResolvedDeclaredSchema {
  if (isStandardSchema(value)) {
    if (value["~standard"].vendor !== "zod") {
      throw new ValidationError(
        `Unsupported Standard Schema vendor: ${value["~standard"].vendor || "unknown"}`,
      );
    }
    assertSupportedZodV4Schema(value);
    let converted: unknown;
    try {
      converted = z.toJSONSchema(value as z.ZodType, {
        target: "draft-07",
        io: "output",
        unrepresentable: "throw",
        cycles: "throw",
        reused: "inline",
      });
    } catch {
      throw new ValidationError(
        "Zod schema cannot be converted losslessly to the declared JSON Schema profile",
      );
    }
    if (!isPlainRecord(converted)) {
      throw new ValidationError("Zod conversion did not return a plain JSON Schema");
    }
    // Zod attaches its live Standard Schema adapter to the root conversion.
    // It is conversion metadata rather than JSON Schema meaning and must never
    // cross RPC or enter durable state.
    const { ["~standard"]: _standard, ...plain } = converted;
    return resolveSecretSafeSchema(normalizeZodFormatAssertions(plain));
  }
  if (
    value &&
    typeof value === "object" &&
    Object.hasOwn(value as object, "~standard")
  ) {
    throw new ValidationError("Malformed Standard Schema value");
  }
  return resolveSecretSafeSchema(value);
}

function resolveSecretSafeSchema(value: unknown): ResolvedDeclaredSchema {
  const resolved = resolveDeclaredSchema(value);
  if (
    containsBrokeredSecret(resolved.schema) ||
    containsCredentialMaterial(canonicalJsonStringify(resolved.schema))
  ) {
    throw new ValidationError(
      "Declared JSON Schema contains credential material",
    );
  }
  return resolved;
}

function assertSupportedZodV4Schema(value: StandardSchemaLike): void {
  const root = value as unknown as {
    readonly _zod?: {
      readonly version?: { readonly major?: number };
      readonly def?: unknown;
    };
  };
  if (
    root._zod?.version?.major !== 4 ||
    !root._zod.def ||
    typeof root._zod.def !== "object"
  ) {
    throw new ValidationError(
      "Only concrete Zod v4 schemas are supported by the Zod converter",
    );
  }
  const seen = new Set<object>();
  inspectZodNode(root, "$", seen);
}

function inspectZodNode(value: unknown, path: string, seen: Set<object>): void {
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  const zod = object._zod;
  if (!zod || typeof zod !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  const definition = (zod as Record<string, unknown>).def;
  if (!definition || typeof definition !== "object") {
    throw new ValidationError(`Malformed Zod schema at ${path}`);
  }
  const record = definition as Record<string, unknown>;
  const type = record.type;
  if (
    typeof type !== "string" ||
    [
      "transform",
      "pipe",
      "default",
      "prefault",
      "catch",
      "lazy",
      "custom",
      "promise",
      "function",
      "readonly",
    ].includes(type)
  ) {
    throw new ValidationError(
      `Zod schema uses unsupported ${String(type)} semantics at ${path}`,
    );
  }
  if (record.coerce === true) {
    throw new ValidationError(
      `Zod coercion cannot be retained as JSON Schema at ${path}`,
    );
  }
  const checks = record.checks;
  if (Array.isArray(checks)) {
    for (const [index, check] of checks.entries()) {
      const checkDefinition = zodDefinition(check);
      if (
        checkDefinition &&
        (checkDefinition.type === "custom" ||
          checkDefinition.check === "custom" ||
          checkDefinition.check === "overwrite" ||
          typeof checkDefinition.fn === "function")
      ) {
        throw new ValidationError(
          `Zod schema uses a custom validator or refinement at ${path}.checks[${index}]`,
        );
      }
      if (
        type === "string" &&
        checkDefinition &&
        ["min_length", "max_length", "length_equals"].includes(
          String(checkDefinition.check),
        )
      ) {
        throw new ValidationError(
          `Zod string length uses UTF-16 semantics that JSON Schema cannot retain at ${path}.checks[${index}]`,
        );
      }
      if (
        checkDefinition?.format === "regex" &&
        (!(checkDefinition.pattern instanceof RegExp) ||
          checkDefinition.pattern.flags !== "u")
      ) {
        throw new ValidationError(
          `Zod regular expressions require exact Unicode-only semantics at ${path}.checks[${index}]`,
        );
      }
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === "checks") continue;
    if (Array.isArray(child)) {
      child.forEach((item, index) =>
        inspectZodNode(item, `${path}.${key}[${index}]`, seen)
      );
    } else if (child && typeof child === "object") {
      if (hasZodDefinition(child)) {
        inspectZodNode(child, `${path}.${key}`, seen);
      } else {
        for (const [name, item] of Object.entries(child)) {
          inspectZodNode(item, `${path}.${key}.${name}`, seen);
        }
      }
    }
  }
}

function zodDefinition(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const zod = (value as Record<string, unknown>)._zod;
  if (!zod || typeof zod !== "object") return null;
  const definition = (zod as Record<string, unknown>).def;
  return definition && typeof definition === "object"
    ? definition as Record<string, unknown>
    : null;
}

function hasZodDefinition(value: object): boolean {
  return zodDefinition(value) !== null;
}

function isStandardSchema(value: unknown): value is StandardSchemaLike {
  if (!value || typeof value !== "object") return false;
  const standard = (value as Record<string, unknown>)["~standard"];
  if (!standard || typeof standard !== "object") return false;
  const record = standard as Record<string, unknown>;
  return record.version === 1 && typeof record.vendor === "string";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Zod emits both `format` and its exact runtime pattern for most formatted
 * strings. Keeping both lets a provider or the durable format validator impose
 * stricter, different semantics than Zod. The generated pattern is therefore
 * authoritative. Zod's IPv6 pattern is the exception: it omits valid embedded
 * IPv4 forms that Zod accepts, while the durable IPv6 validator retains them.
 */
function normalizeZodFormatAssertions(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeZodFormatAssertions);
  }
  if (!isPlainRecord(value)) return value;
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    result[key] = normalizeZodFormatAssertions(child);
  }
  if (
    typeof result.pattern === "string" &&
    typeof result.format === "string"
  ) {
    if (result.format === "ipv6") delete result.pattern;
    else delete result.format;
  }
  return result;
}

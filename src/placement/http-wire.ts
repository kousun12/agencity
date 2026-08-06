import { AgentRuntimeError, DependencyFailureError } from "../domain/index.ts";

const marker = "__agencity_wire_v1__";

type WireObject = { readonly [key: string]: WireValue };
type WireValue = null | boolean | number | string | WireValue[] | WireObject;

export function encodeWire(value: unknown): WireValue {
  if (value === undefined) return { [marker]: "undefined" };
  if (typeof value === "bigint") return { [marker]: "bigint", value: value.toString() };
  if (value instanceof Uint8Array) return { [marker]: "bytes", value: Buffer.from(value).toString("base64") };
  if (value instanceof ArrayBuffer) return { [marker]: "bytes", value: Buffer.from(value).toString("base64") };
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(encodeWire);
  if (typeof value === "object") {
    const encoded: Record<string, WireValue> = {};
    for (const [key, item] of Object.entries(value)) encoded[key] = encodeWire(item);
    // Tag every ordinary object so domain JSON can safely contain the reserved
    // marker key without being mistaken for a transport sentinel.
    return { [marker]: "object", value: encoded };
  }
  throw new TypeError(`Value is not encodable by the placement HTTP protocol: ${typeof value}`);
}

export function decodeWire(value: WireValue): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeWire);
  const tag = value[marker];
  if (tag === "undefined") return undefined;
  if (tag === "bigint" && typeof value.value === "string") return BigInt(value.value);
  if (tag === "bytes" && typeof value.value === "string") return new Uint8Array(Buffer.from(value.value, "base64"));
  if (tag === "object" && value.value && typeof value.value === "object" && !Array.isArray(value.value)) {
    const decoded: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value.value)) decoded[key] = decodeWire(item);
    return decoded;
  }
  throw new TypeError("Invalid placement HTTP wire object");
}

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(encodeWire(value), { status });
}

export async function readWireResponse(response: Response, dependency: string): Promise<unknown> {
  let body: unknown;
  try { body = decodeWire(await response.json() as WireValue); }
  catch (error) {
    throw new DependencyFailureError(`${dependency} returned an invalid wire response`, {
      status: response.status,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (response.ok) return body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    const error = record.error;
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const detail = error as Record<string, unknown>;
      if (typeof detail.code === "string" && typeof detail.message === "string") {
        throw new AgentRuntimeError(
          detail.code,
          detail.message,
          detail.details && typeof detail.details === "object" && !Array.isArray(detail.details)
            ? detail.details as Readonly<Record<string, unknown>>
            : undefined,
        );
      }
    }
  }
  throw new DependencyFailureError(`${dependency} returned HTTP ${response.status}`, { status: response.status });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AgentRuntimeError) {
    return jsonResponse({ error: { code: error.code, message: error.message, details: error.details ?? {} } },
      error.code === "CAPABILITY_UNAVAILABLE" ? 409 : error.code === "VALIDATION_ERROR" ? 400 : 500);
  }
  return jsonResponse({ error: { code: "DEPENDENCY_FAILURE", message: error instanceof Error ? error.message : String(error), details: {} } }, 500);
}

export function normalizedEndpoint(endpoint: string): string {
  return endpoint.replace(/\/$/, "");
}

import type { JsonValue } from "../domain/json.ts";

export const SCRATCH_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const SCRATCH_LIMITS = Object.freeze({
  maxKeys: 64,
  maxKeyBytes: 128,
  maxDepth: 32,
  maxNodes: 10_000,
  maxProperties: 10_000,
  maxValueBytes: 128 * 1024,
  maxCheckpointBytes: 256 * 1024,
  maxSkipped: 64,
  maxWarmScopes: 16,
  idleScopeMs: 60 * 60 * 1_000,
  checkpointTimeoutMs: 500,
  rssRecycleBytes: 512 * 1024 * 1024,
});

export type ScratchSkipReason =
  | "unsupported_type"
  | "cyclic"
  | "accessor"
  | "depth_limit"
  | "node_limit"
  | "property_limit"
  | "value_too_large"
  | "checkpoint_too_large"
  | "secret_rejected";

export interface ScratchScope {
  readonly sessionId: string;
  readonly branchId: string;
}

export interface ScratchSkippedProperty {
  readonly name: string;
  readonly reason: ScratchSkipReason;
}

export interface ScratchCheckpointCandidate {
  readonly schemaVersion: typeof SCRATCH_CHECKPOINT_SCHEMA_VERSION;
  readonly values: Readonly<Record<string, JsonValue>>;
  readonly canonicalJson: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly savedNames: readonly string[];
  readonly skipped: readonly ScratchSkippedProperty[];
}

export interface ScratchCheckpointRestore {
  readonly candidate: ScratchCheckpointCandidate;
  readonly sourceCellId?: string;
  readonly checkpointedAt?: string;
}

export type ScratchCacheUnavailableReason =
  | "device_mismatch"
  | "placement_unavailable"
  | "storage_error";

export type ScratchCacheCorruptReason =
  | "checkpoint_integrity"
  | "row_integrity"
  | "row_malformed";

export type ScratchCheckpointLoadResult =
  | { readonly status: "restored"; readonly restore: ScratchCheckpointRestore }
  | { readonly status: "cold" }
  | { readonly status: "unavailable"; readonly reason: ScratchCacheUnavailableReason }
  | { readonly status: "corrupt"; readonly reason: ScratchCacheCorruptReason };

export interface ScratchCheckpointSource {
  readonly cellId: string;
  readonly eventId: string;
  readonly cursor: string;
}

export type ScratchCheckpointWriteResult =
  | { readonly status: "stored" }
  | { readonly status: "cleared" }
  | { readonly status: "unchanged" };

export interface ScratchCheckpointHooks {
  /** Phase-C storage may return only an exact session/branch restore. */
  load(scope: ScratchScope): Promise<ScratchCheckpointLoadResult>;
  /** The hook is awaited inside the process lifecycle queue. */
  checkpoint(
    scope: ScratchScope,
    candidate: ScratchCheckpointCandidate,
    source: ScratchCheckpointSource,
  ): Promise<ScratchCheckpointWriteResult>;
}

export type ScratchScopeTemperature = "warm" | "restored" | "cold";
export type ScratchValueType =
  | "array"
  | "bigint"
  | "boolean"
  | "function"
  | "null"
  | "number"
  | "object"
  | "string"
  | "symbol"
  | "undefined";

export interface ScratchStatus {
  readonly scope: ScratchScope;
  readonly temperature: ScratchScopeTemperature;
  readonly propertyNames: readonly string[];
  readonly propertyTypes: Readonly<Record<string, ScratchValueType>>;
  readonly lastCheckpointAt: string | null;
  readonly lastCheckpointCellId: string | null;
  readonly savedNames: readonly string[];
  readonly skipped: readonly ScratchSkippedProperty[];
  readonly cache: {
    readonly available: boolean;
    readonly restoreAttempted: boolean;
    readonly status: ScratchCheckpointLoadResult["status"];
    readonly reason: ScratchCacheUnavailableReason | ScratchCacheCorruptReason | null;
    readonly lastWrite: ScratchCheckpointWriteResult["status"] | "unavailable" | null;
  };
  readonly limits: typeof SCRATCH_LIMITS;
}

export interface ScratchSdk {
  status(): Promise<ScratchStatus>;
  clear(): Promise<ScratchStatus>;
}

export class ScratchBindingUnavailableError extends Error {
  constructor(
    readonly propertyName: string,
    readonly reason: ScratchSkipReason,
    readonly checkpointCellId: string | null,
  ) {
    super(
      `Scratch property ${JSON.stringify(propertyName)} was unavailable from the last checkpoint ` +
      `(${reason}). Inspect sdk.scratch.status() and rebuild it from durable inputs.`,
    );
    this.name = "ScratchBindingUnavailableError";
  }
}

export class ScratchKeyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScratchKeyPolicyError";
  }
}

export interface ScratchProxyState {
  readonly object: Record<string, unknown>;
  readonly target: Record<string, unknown>;
  readonly skipped: Map<string, ScratchSkipReason>;
  readonly dirty: boolean;
  unavailableCheckpointCellId: string | null;
  clear(): void;
  markClean(): void;
}

const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const encoder = new TextEncoder();

export function createScratchProxy(
  skipped: ReadonlyMap<string, ScratchSkipReason> = new Map(),
  initialCheckpointCellId: string | null = null,
): ScratchProxyState {
  const target = Object.create(null) as Record<string, unknown>;
  const unavailable = new Map(skipped);
  let unavailableCheckpointCellId = initialCheckpointCellId;
  let dirty = false;
  const isMutable = (value: unknown): boolean =>
    (typeof value === "object" && value !== null) || typeof value === "function";
  const validateKey = (key: PropertyKey, adding: boolean): string => {
    if (typeof key !== "string") throw new ScratchKeyPolicyError("Scratch does not support symbol keys");
    if (RESERVED_KEYS.has(key)) throw new ScratchKeyPolicyError(`Scratch key ${JSON.stringify(key)} is reserved`);
    if (encoder.encode(key).byteLength > SCRATCH_LIMITS.maxKeyBytes) {
      throw new ScratchKeyPolicyError(`Scratch keys are limited to ${SCRATCH_LIMITS.maxKeyBytes} UTF-8 bytes`);
    }
    if (adding && !Object.hasOwn(target, key) &&
        Reflect.ownKeys(target).length >= SCRATCH_LIMITS.maxKeys) {
      throw new ScratchKeyPolicyError(`Scratch is limited to ${SCRATCH_LIMITS.maxKeys} properties`);
    }
    return key;
  };
  const object = new Proxy(target, {
    get(current, key, receiver) {
      if (typeof key === "string" && !Object.hasOwn(current, key) && unavailable.has(key)) {
        throw new ScratchBindingUnavailableError(
          key,
          unavailable.get(key)!,
          unavailableCheckpointCellId,
        );
      }
      const value = Reflect.get(current, key, receiver);
      // Mutable values can change below the top-level proxy (for example,
      // scratch.index.files.push(...)). Treat access as potentially dirty so a
      // later checkpoint never silently restores stale nested data.
      if (isMutable(value)) dirty = true;
      return value;
    },
    set(current, key, value) {
      const name = validateKey(key, true);
      const written = Reflect.set(current, name, value, current);
      if (written) {
        unavailable.delete(name);
        dirty = true;
      }
      return written;
    },
    defineProperty(current, key, descriptor) {
      const name = validateKey(key, true);
      if ("get" in descriptor || "set" in descriptor) {
        throw new ScratchKeyPolicyError("Scratch does not support accessor properties");
      }
      const currentDescriptor = Reflect.getOwnPropertyDescriptor(current, name);
      const remainsConfigurable = descriptor.configurable ??
        currentDescriptor?.configurable ??
        false;
      if (!remainsConfigurable) {
        throw new ScratchKeyPolicyError(
          "Scratch properties must remain configurable so the scope can be cleared",
        );
      }
      const defined = Reflect.defineProperty(current, name, descriptor);
      if (defined) {
        unavailable.delete(name);
        dirty = true;
      }
      return defined;
    },
    deleteProperty(current, key) {
      const name = validateKey(key, false);
      const existed = Object.hasOwn(current, name) || unavailable.has(name);
      const deleted = Reflect.deleteProperty(current, name);
      if (deleted) {
        unavailable.delete(name);
        if (existed) dirty = true;
      }
      return deleted;
    },
    getOwnPropertyDescriptor(current, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      if (descriptor && "value" in descriptor && isMutable(descriptor.value)) dirty = true;
      return descriptor;
    },
    setPrototypeOf() {
      throw new ScratchKeyPolicyError("Scratch has an immutable null prototype");
    },
    preventExtensions() {
      throw new ScratchKeyPolicyError("Scratch must remain extensible so the scope can be cleared");
    },
  });
  return {
    object,
    target,
    skipped: unavailable,
    get dirty() {
      return dirty;
    },
    get unavailableCheckpointCellId() {
      return unavailableCheckpointCellId;
    },
    set unavailableCheckpointCellId(value: string | null) {
      unavailableCheckpointCellId = value;
    },
    clear() {
      if (Reflect.ownKeys(target).length > 0 || unavailable.size > 0) dirty = true;
      for (const key of Reflect.ownKeys(target)) Reflect.deleteProperty(target, key);
      unavailable.clear();
    },
    markClean() {
      dirty = false;
    },
  };
}

interface TraversalBudget {
  nodes: number;
  properties: number;
}

class SerializationSkip extends Error {
  constructor(readonly reason: ScratchSkipReason) {
    super(reason);
  }
}

export function serializeScratch(
  value: Record<string, unknown>,
  knownUnavailable: ReadonlyMap<string, ScratchSkipReason> = new Map(),
): ScratchCheckpointCandidate {
  const values: Record<string, JsonValue> = Object.create(null);
  const skipped: ScratchSkippedProperty[] = [...knownUnavailable]
    .filter(([name]) => !Object.hasOwn(value, name))
    .map(([name, reason]) => ({ name, reason }));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors).sort();
  const budget: TraversalBudget = { nodes: 0, properties: 0 };
  for (const name of names) {
    if (Object.keys(values).length >= SCRATCH_LIMITS.maxKeys) {
      pushSkipped(skipped, name, "property_limit");
      continue;
    }
    const descriptor = descriptors[name]!;
    if (!("value" in descriptor)) {
      pushSkipped(skipped, name, "accessor");
      continue;
    }
    try {
      const converted = jsonCloneGetterFree(descriptor.value, 0, budget, new Set());
      const encoded = canonicalJson(converted);
      if (encoder.encode(encoded).byteLength > SCRATCH_LIMITS.maxValueBytes) {
        throw new SerializationSkip("value_too_large");
      }
      const prospective = { ...values, [name]: converted };
      if (encoder.encode(canonicalJson(prospective)).byteLength >
          SCRATCH_LIMITS.maxCheckpointBytes) {
        pushSkipped(skipped, name, "checkpoint_too_large");
        continue;
      }
      values[name] = converted;
    } catch (error) {
      pushSkipped(
        skipped,
        name,
        error instanceof SerializationSkip ? error.reason : "unsupported_type",
      );
    }
  }
  return buildScratchCheckpointCandidate(values, skipped);
}

export function filterScratchCheckpoint(
  candidate: ScratchCheckpointCandidate,
  reject: (name: string, value: JsonValue) => boolean,
  options: {
    readonly retainRejectedNames?: boolean;
    readonly omitSkippedName?: (name: string) => boolean;
  } = {},
): ScratchCheckpointCandidate {
  const values: Record<string, JsonValue> = Object.create(null);
  const skipped = candidate.skipped.filter((item) => !options.omitSkippedName?.(item.name));
  for (const name of candidate.savedNames) {
    const value = candidate.values[name]!;
    if (reject(name, value)) {
      if (options.retainRejectedNames !== false) {
        pushSkipped(skipped, name, "secret_rejected");
      }
    }
    else values[name] = value;
  }
  return buildScratchCheckpointCandidate(values, skipped);
}

export function validateScratchCheckpoint(
  candidate: ScratchCheckpointCandidate,
): ScratchCheckpointCandidate {
  const rebuilt = buildScratchCheckpointCandidate(candidate.values, candidate.skipped);
  if (candidate.schemaVersion !== SCRATCH_CHECKPOINT_SCHEMA_VERSION ||
      candidate.canonicalJson !== rebuilt.canonicalJson ||
      candidate.byteLength !== rebuilt.byteLength ||
      candidate.digest !== rebuilt.digest ||
      !Bun.deepEquals(candidate.savedNames, rebuilt.savedNames)) {
    throw new Error("Scratch checkpoint candidate failed integrity validation");
  }
  return rebuilt;
}

function buildScratchCheckpointCandidate(
  input: Readonly<Record<string, JsonValue>>,
  inputSkipped: readonly ScratchSkippedProperty[],
): ScratchCheckpointCandidate {
  const values: Record<string, JsonValue> = Object.create(null);
  for (const name of Object.keys(input).sort()) values[name] = input[name]!;
  const skipped = [...inputSkipped]
    .slice(0, SCRATCH_LIMITS.maxSkipped)
    .sort((left, right) => left.name.localeCompare(right.name) || left.reason.localeCompare(right.reason));
  let canonicalJson = canonicalJsonValue({ values, skipped } as unknown as JsonValue);
  while (encoder.encode(canonicalJson).byteLength > SCRATCH_LIMITS.maxCheckpointBytes &&
         Object.keys(values).length > 0) {
    const name = Object.keys(values).sort().at(-1)!;
    delete values[name];
    const existing = skipped.findIndex((item) => item.name === name);
    if (existing >= 0) skipped.splice(existing, 1);
    pushSkipped(skipped, name, "checkpoint_too_large");
    skipped.sort((left, right) =>
      left.name.localeCompare(right.name) || left.reason.localeCompare(right.reason));
    canonicalJson = canonicalJsonValue({ values, skipped } as unknown as JsonValue);
  }
  const byteLength = encoder.encode(canonicalJson).byteLength;
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonicalJson);
  return Object.freeze({
    schemaVersion: SCRATCH_CHECKPOINT_SCHEMA_VERSION,
    values: Object.freeze(values),
    canonicalJson,
    byteLength,
    digest: hasher.digest("hex"),
    savedNames: Object.freeze(Object.keys(values)),
    skipped: Object.freeze(skipped),
  });
}

function pushSkipped(
  skipped: ScratchSkippedProperty[],
  name: string,
  reason: ScratchSkipReason,
): void {
  if (skipped.length < SCRATCH_LIMITS.maxSkipped) skipped.push({ name, reason });
}

function jsonCloneGetterFree(
  value: unknown,
  depth: number,
  budget: TraversalBudget,
  ancestors: Set<object>,
): JsonValue {
  if (depth > SCRATCH_LIMITS.maxDepth) throw new SerializationSkip("depth_limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SerializationSkip("unsupported_type");
    return value;
  }
  if (typeof value !== "object") throw new SerializationSkip("unsupported_type");
  if (++budget.nodes > SCRATCH_LIMITS.maxNodes) throw new SerializationSkip("node_limit");
  if (ancestors.has(value)) throw new SerializationSkip("cyclic");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const lengthDescriptor = (descriptors as unknown as Record<string, PropertyDescriptor>)["length"];
      const lengthValue = lengthDescriptor?.value;
      if (typeof lengthValue !== "number" ||
          !Number.isSafeInteger(lengthValue) || lengthValue < 0) {
        throw new SerializationSkip("unsupported_type");
      }
      const length = lengthValue;
      const output: JsonValue[] = [];
      for (let index = 0; index < length; index++) {
        if (++budget.properties > SCRATCH_LIMITS.maxProperties) {
          throw new SerializationSkip("property_limit");
        }
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) throw new SerializationSkip("accessor");
        output.push(jsonCloneGetterFree(descriptor.value, depth + 1, budget, ancestors));
      }
      const extras = Object.keys(descriptors).filter((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key));
      if (extras.length) throw new SerializationSkip("unsupported_type");
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SerializationSkip("unsupported_type");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, JsonValue> = Object.create(null);
    for (const name of Object.keys(descriptors).sort()) {
      if (++budget.properties > SCRATCH_LIMITS.maxProperties) {
        throw new SerializationSkip("property_limit");
      }
      const descriptor = descriptors[name]!;
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) throw new SerializationSkip("accessor");
      output[name] = jsonCloneGetterFree(descriptor.value, depth + 1, budget, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: JsonValue): string {
  return canonicalJsonValue(value);
}

function canonicalJsonValue(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJsonValue(value[key]!)}`).join(",")}}`;
}

export function scratchValueType(value: unknown): ScratchValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as ScratchValueType;
}

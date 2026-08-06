import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const SERVICE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const SERVICE_MANIFEST_FILE = "manifest.json";
export const MAX_SERVICE_MANIFEST_BYTES = 16 * 1024;
export const SERVICE_BEARER_TOKEN_BYTES = 32;
export const INSTALLED_SERVICE_SOURCE_URL = new URL("../cli.ts", import.meta.url);

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_ID_LENGTH = 128;
const MAX_APP_VERSION_LENGTH = 64;
const MAX_PROTOCOL_VERSION = 65_535;
const MAX_PID_HINT = 2_147_483_647;
const PUBLISH_LOCK_NAME = ".publish-lock";
const PUBLISH_LOCK_WAIT_MS = 5_000;
const PUBLISH_LOCK_POLL_MS = 5;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const APP_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const CONFIG_HASH_PATTERN = /^[a-f0-9]{64}$/;
const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type ServiceDiscoveryErrorCode =
  | "INVALID_MANIFEST"
  | "MANIFEST_TOO_LARGE"
  | "INSECURE_SERVICE_STATE"
  | "WORKSPACE_MISMATCH"
  | "DEVICE_MISMATCH"
  | "CONFIG_MISMATCH"
  | "PROTOCOL_MISMATCH"
  | "AUTHORITY_CONFLICT"
  | "STALE_MANIFEST_CHANGED"
  | "PUBLICATION_LOCKED"
  | "HEALTH_PROBE_FAILED"
  | "LEASE_INSPECTION_FAILED";

/** Errors deliberately omit manifest bytes, configuration hashes, and bearer tokens. */
export class ServiceDiscoveryError extends Error {
  readonly code: ServiceDiscoveryErrorCode;

  constructor(code: ServiceDiscoveryErrorCode, message: string) {
    super(message);
    this.name = "ServiceDiscoveryError";
    this.code = code;
  }
}

/**
 * Owner-only discovery record. The bearer token authenticates loopback clients;
 * callers must never log or place the complete manifest on a command line.
 */
export interface ServiceManifestV1 {
  readonly schemaVersion: typeof SERVICE_MANIFEST_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly instanceId: string;
  /** Diagnostic hint only. It is never execution-ownership evidence. */
  readonly pidHint: number;
  readonly url: string;
  readonly startedAt: string;
  readonly appVersion: string;
  readonly protocolMin: number;
  readonly protocolMax: number;
  readonly configHash: string;
  readonly bearerToken: string;
}

export interface CreateServiceManifestInput {
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly instanceId: string;
  readonly pidHint?: number;
  readonly url: string;
  readonly startedAt?: string;
  readonly appVersion: string;
  readonly protocolMin: number;
  readonly protocolMax: number;
  readonly configHash: string;
  readonly randomToken?: () => Uint8Array;
  readonly now?: () => Date;
}

export interface ServiceManifestSummary {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly instanceId: string;
  readonly url: string;
  readonly startedAt: string;
  readonly appVersion: string;
  readonly protocolMin: number;
  readonly protocolMax: number;
  readonly configHash: "[redacted]";
  readonly bearerToken: "[redacted]";
}

export interface ServiceCompatibilityExpectation {
  readonly configHash: string;
  readonly protocolMin: number;
  readonly protocolMax: number;
}

export interface ServiceHealthProbeInput {
  readonly url: string;
  readonly bearerToken: string;
  readonly workspaceId: string;
  readonly instanceId: string;
}

export type ServiceHealthEvidence =
  | {
      readonly status: "healthy";
      /** True only when the response was authenticated with this manifest's token. */
      readonly authenticated: boolean;
      readonly workspaceId: string;
      readonly instanceId: string;
    }
  | { readonly status: "unreachable" }
  | { readonly status: "unauthorized" }
  | { readonly status: "identity-mismatch" };

export interface ServiceLeaseInspectionInput {
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly instanceId: string;
}

export type ServiceLeaseEvidence =
  | { readonly status: "absent" }
  | { readonly status: "unknown" }
  | {
      readonly status: "held";
      readonly instanceId: string;
      /** An expired held record is treated as absent, not as live authority. */
      readonly expiresAt?: string;
    };

export type ServiceAuthorityDecision =
  | { readonly kind: "authoritative"; readonly instanceId: string }
  | { readonly kind: "stale"; readonly instanceId: string; readonly reason: "unreachable-without-lease" }
  | {
      readonly kind: "conflict";
      readonly instanceId: string;
      readonly code: "CONFIG_MISMATCH" | "PROTOCOL_MISMATCH" | "AUTHORITY_CONFLICT";
      readonly reason:
        | "configuration-mismatch"
        | "protocol-incompatible"
        | "health-not-authenticated"
        | "health-identity-mismatch"
        | "health-without-matching-lease"
        | "lease-held-without-health"
        | "lease-authority-unknown";
    };

export interface AssessServiceInput {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly compatibility: ServiceCompatibilityExpectation;
  readonly probeHealth: (input: ServiceHealthProbeInput) => Promise<ServiceHealthEvidence>;
  readonly inspectLease: (input: ServiceLeaseInspectionInput) => Promise<ServiceLeaseEvidence>;
  readonly now?: Date;
}

export type ServiceAssessment =
  | { readonly kind: "missing" }
  | {
      readonly kind: "found";
      readonly manifest: ServiceManifestV1;
      readonly decision: ServiceAuthorityDecision;
    };

export interface PublishServiceManifestInput {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly manifest: ServiceManifestV1;
  readonly lockWaitMs?: number;
}

export type ServicePublication =
  | { readonly kind: "published"; readonly manifest: ServiceManifestV1 }
  | { readonly kind: "existing-winner"; readonly manifest: ServiceManifestV1 };

export interface CleanupStaleManifestInput {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly observedManifest: ServiceManifestV1;
  readonly decision: ServiceAuthorityDecision;
  readonly lockWaitMs?: number;
}

export interface ServiceChildSpawnSpecification {
  /** Always process.execPath; no shell command string is constructed. */
  readonly executable: string;
  /** First argument is resolved from the installed module URL, never cwd. */
  readonly argv: readonly string[];
  readonly sourceUrl: string;
  readonly options: {
    readonly cwd: string;
    readonly detached: true;
    readonly stdio: "ignore";
    readonly shell: false;
    readonly windowsHide: true;
  };
  /** The future caller must call ChildProcess.unref(); this tranche never spawns. */
  readonly unref: true;
}

export interface BuildServiceChildSpawnSpecificationInput {
  readonly workspaceRoot: string;
  readonly sourceUrl?: URL;
}

const MANIFEST_FIELDS = new Set([
  "schemaVersion",
  "workspaceId",
  "deviceId",
  "instanceId",
  "pidHint",
  "url",
  "startedAt",
  "appVersion",
  "protocolMin",
  "protocolMax",
  "configHash",
  "bearerToken",
]);

export function createServiceManifest(input: CreateServiceManifestInput): ServiceManifestV1 {
  const tokenBytes = input.randomToken?.() ?? randomBytes(SERVICE_BEARER_TOKEN_BYTES);
  if (!(tokenBytes instanceof Uint8Array) || tokenBytes.byteLength !== SERVICE_BEARER_TOKEN_BYTES) {
    throw invalidManifest("Service bearer-token generator must return exactly 32 bytes");
  }
  const manifest: ServiceManifestV1 = {
    schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    deviceId: input.deviceId,
    instanceId: input.instanceId,
    pidHint: input.pidHint ?? process.pid,
    url: input.url,
    startedAt: input.startedAt ?? (input.now?.() ?? new Date()).toISOString(),
    appVersion: input.appVersion,
    protocolMin: input.protocolMin,
    protocolMax: input.protocolMax,
    configHash: input.configHash,
    bearerToken: Buffer.from(tokenBytes).toString("base64url"),
  };
  return validateServiceManifest(manifest);
}

/** Strict runtime validation: unknown fields and coercions are rejected. */
export function validateServiceManifest(value: unknown): ServiceManifestV1 {
  if (!isPlainObject(value)) throw invalidManifest("Service manifest must be a JSON object");
  const keys = Object.keys(value);
  if (keys.length !== MANIFEST_FIELDS.size || keys.some(key => !MANIFEST_FIELDS.has(key))) {
    throw invalidManifest("Service manifest fields do not match schema version 1");
  }
  if (value.schemaVersion !== SERVICE_MANIFEST_SCHEMA_VERSION) {
    throw invalidManifest("Unsupported service manifest schema version");
  }
  const workspaceId = strictId(value.workspaceId, "workspaceId");
  const deviceId = strictId(value.deviceId, "deviceId");
  const instanceId = strictId(value.instanceId, "instanceId");
  const pidHint = strictInteger(value.pidHint, "pidHint", 1, MAX_PID_HINT);
  const url = strictLoopbackUrl(value.url);
  const startedAt = strictIsoTimestamp(value.startedAt);
  const appVersion = strictPatternString(value.appVersion, "appVersion", MAX_APP_VERSION_LENGTH, APP_VERSION_PATTERN);
  const protocolMin = strictInteger(value.protocolMin, "protocolMin", 1, MAX_PROTOCOL_VERSION);
  const protocolMax = strictInteger(value.protocolMax, "protocolMax", 1, MAX_PROTOCOL_VERSION);
  if (protocolMin > protocolMax) throw invalidManifest("Service protocol range is invalid");
  const configHash = strictPatternString(value.configHash, "configHash", 64, CONFIG_HASH_PATTERN);
  const bearerToken = strictPatternString(value.bearerToken, "bearerToken", 43, BEARER_TOKEN_PATTERN);
  return Object.freeze({
    schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
    workspaceId,
    deviceId,
    instanceId,
    pidHint,
    url,
    startedAt,
    appVersion,
    protocolMin,
    protocolMax,
    configHash,
    bearerToken,
  });
}

export function serviceManifestSummary(manifest: ServiceManifestV1): ServiceManifestSummary {
  const valid = validateServiceManifest(manifest);
  return {
    schemaVersion: valid.schemaVersion,
    workspaceId: valid.workspaceId,
    deviceId: valid.deviceId,
    instanceId: valid.instanceId,
    url: valid.url,
    startedAt: valid.startedAt,
    appVersion: valid.appVersion,
    protocolMin: valid.protocolMin,
    protocolMax: valid.protocolMax,
    configHash: "[redacted]",
    bearerToken: "[redacted]",
  };
}

/** Stable hash helper for already serialized, secret-free service configuration. */
export function hashServiceConfiguration(serializedConfiguration: string | Uint8Array): string {
  return createHash("sha256").update(serializedConfiguration).digest("hex");
}

export function assertServiceCompatibility(
  manifest: ServiceManifestV1,
  expectation: ServiceCompatibilityExpectation,
): void {
  const valid = validateServiceManifest(manifest);
  const expectedHash = strictPatternString(expectation.configHash, "expected configHash", 64, CONFIG_HASH_PATTERN);
  const expectedMin = strictInteger(expectation.protocolMin, "expected protocolMin", 1, MAX_PROTOCOL_VERSION);
  const expectedMax = strictInteger(expectation.protocolMax, "expected protocolMax", 1, MAX_PROTOCOL_VERSION);
  if (expectedMin > expectedMax) throw invalidManifest("Expected service protocol range is invalid");
  if (valid.configHash !== expectedHash) {
    throw new ServiceDiscoveryError("CONFIG_MISMATCH", "The running service uses a different configuration");
  }
  if (!rangesOverlap(valid.protocolMin, valid.protocolMax, expectedMin, expectedMax)) {
    throw new ServiceDiscoveryError("PROTOCOL_MISMATCH", "The running service protocol is incompatible");
  }
}

/**
 * Pure authority rule. A PID is intentionally not an input to the decision:
 * authenticated health and a matching non-expired durable lease are both
 * required before an existing service is authoritative.
 */
export function decideServiceAuthority(input: {
  readonly manifest: ServiceManifestV1;
  readonly compatibility: ServiceCompatibilityExpectation;
  readonly health: ServiceHealthEvidence;
  readonly lease: ServiceLeaseEvidence;
  readonly now?: Date;
}): ServiceAuthorityDecision {
  const manifest = validateServiceManifest(input.manifest);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw invalidManifest("Authority-decision time is invalid");
  const activeLease = normalizeLease(input.lease, now);

  if (input.health.status === "unreachable") {
    if (activeLease.status === "absent") {
      return { kind: "stale", instanceId: manifest.instanceId, reason: "unreachable-without-lease" };
    }
    if (activeLease.status === "unknown") {
      return conflict(manifest, "AUTHORITY_CONFLICT", "lease-authority-unknown");
    }
    return conflict(manifest, "AUTHORITY_CONFLICT", "lease-held-without-health");
  }

  if (input.health.status !== "healthy") {
    return conflict(manifest, "AUTHORITY_CONFLICT", input.health.status === "identity-mismatch"
      ? "health-identity-mismatch"
      : "health-not-authenticated");
  }
  if (!input.health.authenticated) {
    return conflict(manifest, "AUTHORITY_CONFLICT", "health-not-authenticated");
  }
  if (input.health.workspaceId !== manifest.workspaceId || input.health.instanceId !== manifest.instanceId) {
    return conflict(manifest, "AUTHORITY_CONFLICT", "health-identity-mismatch");
  }
  if (activeLease.status !== "held" || activeLease.instanceId !== manifest.instanceId) {
    return conflict(manifest, "AUTHORITY_CONFLICT", activeLease.status === "unknown"
      ? "lease-authority-unknown"
      : "health-without-matching-lease");
  }

  try {
    assertServiceCompatibility(manifest, input.compatibility);
  } catch (error) {
    if (error instanceof ServiceDiscoveryError && error.code === "CONFIG_MISMATCH") {
      return conflict(manifest, "CONFIG_MISMATCH", "configuration-mismatch");
    }
    if (error instanceof ServiceDiscoveryError && error.code === "PROTOCOL_MISMATCH") {
      return conflict(manifest, "PROTOCOL_MISMATCH", "protocol-incompatible");
    }
    throw error;
  }
  return { kind: "authoritative", instanceId: manifest.instanceId };
}

export function authorityDecisionError(decision: ServiceAuthorityDecision): ServiceDiscoveryError | null {
  if (decision.kind !== "conflict") return null;
  if (decision.code === "CONFIG_MISMATCH") {
    return new ServiceDiscoveryError(decision.code, "The running service uses a different configuration");
  }
  if (decision.code === "PROTOCOL_MISMATCH") {
    return new ServiceDiscoveryError(decision.code, "The running service protocol is incompatible");
  }
  return new ServiceDiscoveryError(decision.code, "Service execution authority could not be proved safely");
}

export async function assessService(input: AssessServiceInput): Promise<ServiceAssessment> {
  const manifest = await readServiceManifest({
    workspaceRoot: input.workspaceRoot,
    workspaceId: input.workspaceId,
  });
  if (!manifest) return { kind: "missing" };
  let health: ServiceHealthEvidence;
  let lease: ServiceLeaseEvidence;
  try {
    health = await input.probeHealth({
      url: manifest.url,
      bearerToken: manifest.bearerToken,
      workspaceId: manifest.workspaceId,
      instanceId: manifest.instanceId,
    });
  } catch {
    throw new ServiceDiscoveryError("HEALTH_PROBE_FAILED", "Service health probe failed");
  }
  try {
    lease = await input.inspectLease({
      workspaceId: manifest.workspaceId,
      deviceId: manifest.deviceId,
      instanceId: manifest.instanceId,
    });
  } catch {
    throw new ServiceDiscoveryError("LEASE_INSPECTION_FAILED", "Service lease inspection failed");
  }
  return {
    kind: "found",
    manifest,
    decision: decideServiceAuthority({
      manifest,
      compatibility: input.compatibility,
      health,
      lease,
      ...(input.now ? { now: input.now } : {}),
    }),
  };
}

export function serviceStatePaths(workspaceRoot: string): {
  readonly workspaceRoot: string;
  readonly metadataDirectory: string;
  readonly serviceDirectory: string;
  readonly manifestPath: string;
} {
  const root = resolve(workspaceRoot);
  const metadataDirectory = join(root, ".agencity");
  const serviceDirectory = join(metadataDirectory, "service");
  return {
    workspaceRoot: root,
    metadataDirectory,
    serviceDirectory,
    manifestPath: join(serviceDirectory, SERVICE_MANIFEST_FILE),
  };
}

/** Creates missing state directories and rejects, rather than repairs, insecure existing ones. */
export async function ensureSecureServiceDirectory(workspaceRoot: string): Promise<string> {
  const paths = serviceStatePaths(workspaceRoot);
  await assertWorkspaceRoot(paths.workspaceRoot);
  await ensureOwnerOnlyDirectory(paths.metadataDirectory, paths.workspaceRoot);
  await ensureOwnerOnlyDirectory(paths.serviceDirectory, paths.metadataDirectory);
  return paths.serviceDirectory;
}

/** Reads through one O_NOFOLLOW descriptor, with lstat/fstat identity checks and a byte cap. */
export async function readServiceManifest(input: {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
}): Promise<ServiceManifestV1 | null> {
  const paths = serviceStatePaths(input.workspaceRoot);
  await ensureSecureServiceDirectory(paths.workspaceRoot);
  let handle: FileHandle;
  let before: Stats;
  try {
    before = await lstat(paths.manifestPath);
    if (before.isSymbolicLink()) throw insecure("Service manifest must not be a symbolic link");
    handle = await open(paths.manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    if (error instanceof ServiceDiscoveryError) throw error;
    throw insecure("Service manifest could not be opened securely");
  }
  try {
    const initial = await handle.stat();
    assertSameFile(before, initial, "Service manifest changed while it was opened");
    assertOwnerOnlyFile(initial);
    if (initial.size < 2) throw invalidManifest("Service manifest is empty");
    if (initial.size > MAX_SERVICE_MANIFEST_BYTES) {
      throw new ServiceDiscoveryError("MANIFEST_TOO_LARGE", "Service manifest exceeds the byte limit");
    }
    const buffer = Buffer.alloc(Number(initial.size) + 1);
    const result = await handle.read(buffer, 0, buffer.byteLength, 0);
    const final = await handle.stat();
    assertSameFile(initial, final, "Service manifest changed while it was read");
    if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || result.bytesRead !== initial.size) {
      throw insecure("Service manifest changed while it was read");
    }
    if (result.bytesRead > MAX_SERVICE_MANIFEST_BYTES) {
      throw new ServiceDiscoveryError("MANIFEST_TOO_LARGE", "Service manifest exceeds the byte limit");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, result.bytesRead));
    } catch {
      throw invalidManifest("Service manifest is not valid UTF-8");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalidManifest("Service manifest is not valid JSON");
    }
    const manifest = validateServiceManifest(parsed);
    if (manifest.workspaceId !== input.workspaceId) {
      throw new ServiceDiscoveryError("WORKSPACE_MISMATCH", "Service manifest belongs to a different workspace");
    }
    return manifest;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Serializes publishers with an owner-only claim directory, then commits via a
 * fully synced temp file, rename(2), and directory fsync. The first compatible
 * publication is the winner; later concurrent publishers receive that record.
 */
export async function publishServiceManifest(input: PublishServiceManifestInput): Promise<ServicePublication> {
  const candidate = validateServiceManifest(input.manifest);
  if (candidate.workspaceId !== input.workspaceId) {
    throw new ServiceDiscoveryError("WORKSPACE_MISMATCH", "Service manifest belongs to a different workspace");
  }
  const paths = serviceStatePaths(input.workspaceRoot);
  await ensureSecureServiceDirectory(paths.workspaceRoot);
  return withPublicationLock(paths.serviceDirectory, input.lockWaitMs, async () => {
    const existing = await readServiceManifest({ workspaceRoot: paths.workspaceRoot, workspaceId: input.workspaceId });
    if (existing) {
      if (existing.deviceId !== candidate.deviceId) {
        throw new ServiceDiscoveryError("DEVICE_MISMATCH", "Service manifest belongs to a different device");
      }
      assertServiceCompatibility(existing, {
        configHash: candidate.configHash,
        protocolMin: candidate.protocolMin,
        protocolMax: candidate.protocolMax,
      });
      return { kind: "existing-winner", manifest: existing };
    }
    await writeManifestAtomically(paths.serviceDirectory, paths.manifestPath, candidate);
    const committed = await readServiceManifest({ workspaceRoot: paths.workspaceRoot, workspaceId: input.workspaceId });
    if (!committed || !sameManifest(committed, candidate)) {
      throw insecure("Published service manifest could not be verified");
    }
    return { kind: "published", manifest: committed };
  });
}

/** Deletes only the exact manifest for which health+lease produced a stale decision. */
export async function cleanupStaleServiceManifest(input: CleanupStaleManifestInput): Promise<boolean> {
  const observed = validateServiceManifest(input.observedManifest);
  if (observed.workspaceId !== input.workspaceId) {
    throw new ServiceDiscoveryError("WORKSPACE_MISMATCH", "Service manifest belongs to a different workspace");
  }
  if (input.decision.kind !== "stale" || input.decision.instanceId !== observed.instanceId) {
    throw new ServiceDiscoveryError("AUTHORITY_CONFLICT", "Stale cleanup requires matching health and lease evidence");
  }
  const paths = serviceStatePaths(input.workspaceRoot);
  await ensureSecureServiceDirectory(paths.workspaceRoot);
  return withPublicationLock(paths.serviceDirectory, input.lockWaitMs, async () => {
    const current = await readServiceManifest({ workspaceRoot: paths.workspaceRoot, workspaceId: input.workspaceId });
    if (!current) return false;
    if (!sameManifest(current, observed)) {
      throw new ServiceDiscoveryError("STALE_MANIFEST_CHANGED", "Service manifest changed before stale cleanup");
    }
    const before = await lstat(paths.manifestPath).catch(error => {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    });
    if (!before) return false;
    assertOwnerOnlyFile(before);
    await unlink(paths.manifestPath);
    await syncCheckedDirectory(paths.serviceDirectory, DIRECTORY_MODE);
    return true;
  });
}

/**
 * Pure spawn plan only. It contains no bearer token, shell string, or real
 * Supervisor lifecycle. The future service owner is responsible for spawning
 * and then honoring `unref`.
 */
export function buildServiceChildSpawnSpecification(
  input: BuildServiceChildSpawnSpecificationInput,
): ServiceChildSpawnSpecification {
  const sourceUrl = input.sourceUrl ?? INSTALLED_SERVICE_SOURCE_URL;
  if (sourceUrl.protocol !== "file:" || sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash) {
    throw invalidManifest("Service child source URL must be a local file URL without credentials or parameters");
  }
  const sourcePath = fileURLToPath(sourceUrl);
  if (!sourcePath) throw invalidManifest("Service child source URL is invalid");
  const workspaceRoot = resolve(input.workspaceRoot);
  return Object.freeze({
    executable: process.execPath,
    argv: Object.freeze([sourcePath, "__service-child", "--workspace", workspaceRoot]),
    sourceUrl: sourceUrl.href,
    options: Object.freeze({
      cwd: workspaceRoot,
      detached: true as const,
      stdio: "ignore" as const,
      shell: false as const,
      windowsHide: true as const,
    }),
    unref: true as const,
  });
}

function invalidManifest(message: string): ServiceDiscoveryError {
  return new ServiceDiscoveryError("INVALID_MANIFEST", message);
}

function insecure(message: string): ServiceDiscoveryError {
  return new ServiceDiscoveryError("INSECURE_SERVICE_STATE", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function strictId(value: unknown, field: string): string {
  return strictPatternString(value, field, MAX_ID_LENGTH, ID_PATTERN);
}

function strictPatternString(value: unknown, field: string, maxLength: number, pattern: RegExp): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || !pattern.test(value)) {
    throw invalidManifest(`Service manifest ${field} is invalid`);
  }
  return value;
}

function strictInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidManifest(`Service manifest ${field} is invalid`);
  }
  return value;
}

function strictIsoTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length !== 24) throw invalidManifest("Service manifest startedAt is invalid");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw invalidManifest("Service manifest startedAt is invalid");
  }
  return value;
}

function strictLoopbackUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) throw invalidManifest("Service manifest URL is invalid");
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw invalidManifest("Service manifest URL is invalid"); }
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || !parsed.port
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw invalidManifest("Service manifest URL must be a bare 127.0.0.1 HTTP origin");
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw invalidManifest("Service manifest URL port is invalid");
  }
  const canonical = `http://127.0.0.1:${port}`;
  if (value !== canonical && value !== `${canonical}/`) {
    throw invalidManifest("Service manifest URL is not canonical");
  }
  return canonical;
}

function rangesOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin <= bMax && bMin <= aMax;
}

function conflict(
  manifest: ServiceManifestV1,
  code: "CONFIG_MISMATCH" | "PROTOCOL_MISMATCH" | "AUTHORITY_CONFLICT",
  reason: Extract<ServiceAuthorityDecision, { kind: "conflict" }> ["reason"],
): ServiceAuthorityDecision {
  return { kind: "conflict", instanceId: manifest.instanceId, code, reason };
}

function normalizeLease(lease: ServiceLeaseEvidence, now: Date): ServiceLeaseEvidence {
  if (lease.status !== "held" || lease.expiresAt === undefined) return lease;
  let expiresAt: number;
  try { expiresAt = Date.parse(strictIsoTimestamp(lease.expiresAt)); }
  catch { return { status: "unknown" }; }
  if (expiresAt <= now.getTime()) return { status: "absent" };
  if (!ID_PATTERN.test(lease.instanceId) || lease.instanceId.length > MAX_ID_LENGTH) return { status: "unknown" };
  return lease;
}

function sameManifest(left: ServiceManifestV1, right: ServiceManifestV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function assertWorkspaceRoot(root: string): Promise<void> {
  let before: Stats;
  let handle: FileHandle;
  try {
    before = await lstat(root);
    if (!before.isDirectory() || before.isSymbolicLink()) throw insecure("Workspace root must be a real directory");
    handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof ServiceDiscoveryError) throw error;
    throw insecure("Workspace root could not be opened securely");
  }
  try {
    const after = await handle.stat();
    assertSameFile(before, after, "Workspace root changed while it was opened");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function ensureOwnerOnlyDirectory(path: string, parent: string): Promise<void> {
  let created = false;
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw insecure("Service state directory could not be created");
  }
  let before: Stats;
  let handle: FileHandle;
  try {
    before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink()) throw insecure("Service state path must be a real directory");
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof ServiceDiscoveryError) throw error;
    throw insecure("Service state directory could not be opened securely");
  }
  try {
    if (created) await handle.chmod(DIRECTORY_MODE);
    const after = await handle.stat();
    assertSameFile(before, after, "Service state directory changed while it was opened");
    assertOwnerAndMode(after, DIRECTORY_MODE, "Service state directory");
    if (created) await syncCheckedDirectory(parent);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function syncCheckedDirectory(path: string, requiredMode?: number): Promise<void> {
  const before = await lstat(path).catch(() => null);
  if (!before?.isDirectory() || before.isSymbolicLink()) throw insecure("Directory fsync target is not a real directory");
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw insecure("Directory fsync target could not be opened securely");
  }
  try {
    const after = await handle.stat();
    assertSameFile(before, after, "Directory changed before fsync");
    if (requiredMode !== undefined) assertOwnerAndMode(after, requiredMode, "Service state directory");
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
}

function assertOwnerOnlyFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink()) throw insecure("Service manifest must be a regular file");
  assertOwnerAndMode(info, FILE_MODE, "Service manifest");
}

function assertOwnerAndMode(info: Stats, expectedMode: number, label: string): void {
  if ((info.mode & 0o777) !== expectedMode) throw insecure(`${label} must use mode ${expectedMode.toString(8)}`);
  if (typeof process.getuid !== "function") {
    throw insecure(`${label} ownership cannot be verified on this platform`);
  }
  if (info.uid !== process.getuid()) throw insecure(`${label} must be owned by the current user`);
}

function assertSameFile(before: Stats, after: Stats, message: string): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.isDirectory() !== after.isDirectory() || before.isFile() !== after.isFile()) {
    throw insecure(message);
  }
}

async function writeManifestAtomically(
  serviceDirectory: string,
  manifestPath: string,
  manifest: ServiceManifestV1,
): Promise<void> {
  const serialized = `${JSON.stringify(manifest)}\n`;
  const size = Buffer.byteLength(serialized);
  if (size > MAX_SERVICE_MANIFEST_BYTES) {
    throw new ServiceDiscoveryError("MANIFEST_TOO_LARGE", "Service manifest exceeds the byte limit");
  }
  const temporary = join(
    serviceDirectory,
    `.manifest.${process.pid}.${randomBytes(16).toString("hex")}.tmp`,
  );
  let handle: FileHandle | null = null;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      FILE_MODE,
    );
    await handle.chmod(FILE_MODE);
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    const written = await handle.stat();
    assertOwnerOnlyFile(written);
    if (written.size !== size) throw insecure("Service manifest temporary file was not written completely");
    await handle.close();
    handle = null;
    await rename(temporary, manifestPath);
    await syncCheckedDirectory(serviceDirectory, DIRECTORY_MODE);
  } catch (error) {
    if (error instanceof ServiceDiscoveryError) throw error;
    throw insecure("Service manifest could not be published atomically");
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

async function withPublicationLock<T>(
  serviceDirectory: string,
  requestedWaitMs: number | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const waitMs = requestedWaitMs ?? PUBLISH_LOCK_WAIT_MS;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) {
    throw invalidManifest("Publication lock wait is invalid");
  }
  const lockPath = join(serviceDirectory, PUBLISH_LOCK_NAME);
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      await mkdir(lockPath, { mode: DIRECTORY_MODE });
      let lockHandle: FileHandle | null = null;
      try {
        const before = await lstat(lockPath);
        if (!before.isDirectory() || before.isSymbolicLink()) throw insecure("Publication lock is not a real directory");
        lockHandle = await open(lockPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await lockHandle.chmod(DIRECTORY_MODE);
        const after = await lockHandle.stat();
        assertSameFile(before, after, "Publication lock changed while it was opened");
        assertOwnerAndMode(after, DIRECTORY_MODE, "Publication lock");
        return await operation();
      } finally {
        await lockHandle?.close().catch(() => {});
        await rmdir(lockPath).catch(() => {});
        await syncCheckedDirectory(serviceDirectory, DIRECTORY_MODE).catch(() => {});
      }
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      await validateExistingLock(lockPath);
      if (Date.now() >= deadline) {
        throw new ServiceDiscoveryError("PUBLICATION_LOCKED", "Another service publication is still in progress");
      }
      await Bun.sleep(PUBLISH_LOCK_POLL_MS);
    }
  }
}

async function validateExistingLock(lockPath: string): Promise<void> {
  let before: Stats;
  let handle: FileHandle;
  try {
    before = await lstat(lockPath);
    if (!before.isDirectory() || before.isSymbolicLink()) throw insecure("Publication lock is not a real directory");
    handle = await open(lockPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    if (error instanceof ServiceDiscoveryError) throw error;
    throw insecure("Publication lock could not be inspected securely");
  }
  try {
    const after = await handle.stat();
    assertSameFile(before, after, "Publication lock changed while it was inspected");
    assertOwnerAndMode(after, DIRECTORY_MODE, "Publication lock");
  } finally {
    await handle.close().catch(() => {});
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

/**
 * Pure, storage-neutral skill catalog and resolution policy.
 *
 * This module deliberately contains no event, storage, runtime, or profile
 * adapter behavior. Adapters must construct records from their retained
 * histories and prove candidate exposure before calling these helpers.
 */

import type { JsonValue } from "./json.ts";

export const SKILL_CATALOG_SCHEMA_VERSION = 1 as const;
export const SKILL_HARNESS_GLOBAL_SCOPE_KEY = "global" as const;
export const MAX_SKILL_CATALOG_RECORDS = 2_048;
export const MAX_SKILL_CANDIDATE_EXPOSURES = 512;
export const MAX_SKILL_PERMISSIONS = 32;
export const MAX_SKILL_TEST_CASES = 64;
export const MAX_CANONICAL_SKILL_DEFINITION_BYTES = 768 * 1_024;

const MAX_ID_BYTES = 256;
const MAX_NAME_BYTES = 64;
const MAX_PERMISSION_BYTES = 128;
const MAX_PROVENANCE_REFERENCE_BYTES = 4 * 1_024;
const MAX_CANONICAL_DEPTH = 24;
const MAX_CANONICAL_NODES = 32_768;
const encoder = new TextEncoder();
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Shared write/read boundary for executable skill names. */
export function isValidSkillName(value: unknown): value is string {
  return typeof value === "string" && byteLength(value) <= MAX_NAME_BYTES && namePattern.test(value);
}
const digestPattern = /^[a-f0-9]{64}$/;
const permissionPattern = /^[a-z][a-z0-9]*(?:[.:-][a-z0-9]+)*$/;
const forbiddenPermissionPattern = /^(?:admin|root|policy|permission|\*)$/i;

export const skillCatalogSources = ["harness", "profile"] as const;
export type SkillCatalogSource = (typeof skillCatalogSources)[number];
export const skillCatalogScopes = ["local", "workspace", "user", "global"] as const;
export type SkillCatalogScope = (typeof skillCatalogScopes)[number];
export const skillAvailabilities = ["candidate", "enabled", "disabled", "removed", "rejected"] as const;
export type SkillAvailability = (typeof skillAvailabilities)[number];
export const skillTestOutcomes = ["passed", "failed"] as const;
export type SkillTestOutcome = (typeof skillTestOutcomes)[number];

export interface SkillLatestTestSummary {
  readonly testId: string;
  readonly versionId: string;
  readonly digest: string;
  readonly testedAt: string;
  readonly compiled: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly outcome: SkillTestOutcome;
}

export interface HarnessSkillProvenance {
  readonly kind: "harness-version";
  readonly entryId: string;
  readonly versionId: string;
  readonly contentDigest: string;
  readonly createdEventId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly proposalId: string | null;
  readonly evidenceEventIds: readonly string[];
}

export type ProfileSkillOrigin =
  | {
      readonly kind: "local-directory";
      /** An attributable display/reference value, not an execution path. */
      readonly reference: string;
      readonly manifestDigest: string;
      readonly sourceDigest: string;
    }
  | {
      readonly kind: "harness-version";
      readonly entryId: string;
      readonly versionId: string;
      readonly digest: string;
    }
  | {
      readonly kind: "profile-api";
      readonly reference: string;
    };

export interface ProfileSkillProvenance {
  readonly kind: "profile-install";
  readonly entryId: string;
  readonly versionId: string;
  readonly contentDigest: string;
  readonly installationId: string;
  readonly installedBy: string;
  readonly installedAt: string;
  readonly origin: ProfileSkillOrigin;
}

export type SkillCatalogProvenance = HarnessSkillProvenance | ProfileSkillProvenance;

/**
 * One immutable skill version plus its current catalog availability and latest
 * test projection. Removal keeps this record; it never erases provenance.
 */
export interface SkillCatalogRecord {
  readonly schemaVersion: typeof SKILL_CATALOG_SCHEMA_VERSION;
  readonly source: SkillCatalogSource;
  readonly entryId: string;
  readonly versionId: string;
  /** SHA-256 of a canonical skill definition, not of mutable availability. */
  readonly digest: string;
  readonly name: string;
  readonly scope: SkillCatalogScope;
  readonly scopeKey: string;
  readonly availability: SkillAvailability;
  readonly provenance: SkillCatalogProvenance;
  readonly permissions: readonly string[];
  readonly latestTest: SkillLatestTestSummary | null;
}

/** Exact durable allocation evidence supplied by the caller's trusted adapter. */
export interface SkillCandidateExposure {
  readonly exposureId: string;
  readonly entryId: string;
  readonly versionId: string;
  readonly digest: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly exposedAt: string;
}

export interface SkillResolutionPolicy {
  readonly sessionId: string;
  readonly branchId: string;
  readonly workspaceId: string;
  readonly userScopeKey: string;
  readonly profileScopeKey: string;
  readonly permissionAllowlist: readonly string[];
  readonly candidateExposures: readonly SkillCandidateExposure[];
}

export const skillResolutionPrecedences = [
  "exposed-candidate",
  "session-local",
  "workspace",
  "user-or-global-harness",
  "profile-global",
] as const;
export type SkillResolutionPrecedence = (typeof skillResolutionPrecedences)[number];

export interface SkillResolution {
  readonly record: SkillCatalogRecord;
  readonly matchedBy: "entry-id" | "version-id" | "name";
  readonly precedence: SkillResolutionPrecedence;
  readonly exposureId?: string;
}

export type SkillResolutionErrorCode =
  | "NOT_FOUND"
  | "AMBIGUOUS"
  | "UNAVAILABLE"
  | "CANDIDATE_NOT_EXPOSED"
  | "OUT_OF_SCOPE"
  | "PERMISSION_DENIED";

/** A typed, deterministic failure that never includes executable skill text. */
export class SkillResolutionError extends Error {
  readonly code: SkillResolutionErrorCode;
  readonly matches: readonly string[];

  constructor(code: SkillResolutionErrorCode, message: string, matches: readonly string[] = []) {
    super(message);
    this.name = "SkillResolutionError";
    this.code = code;
    this.matches = Object.freeze([...matches].sort(compareText));
  }
}

export type SkillCatalogValidationErrorCode =
  | "INVALID_RECORD"
  | "INVALID_POLICY"
  | "INVALID_DIGEST"
  | "IMMUTABLE_VERSION_CHANGED"
  | "INVALID_AVAILABILITY_TRANSITION";

export class SkillCatalogValidationError extends Error {
  readonly code: SkillCatalogValidationErrorCode;

  constructor(code: SkillCatalogValidationErrorCode, message: string) {
    super(message);
    this.name = "SkillCatalogValidationError";
    this.code = code;
  }
}

const recordFields = new Set([
  "schemaVersion", "source", "entryId", "versionId", "digest", "name", "scope", "scopeKey",
  "availability", "provenance", "permissions", "latestTest",
]);
const testFields = new Set(["testId", "versionId", "digest", "testedAt", "compiled", "passed", "failed", "outcome"]);
const harnessProvenanceFields = new Set([
  "kind", "entryId", "versionId", "contentDigest", "createdEventId", "createdBy", "createdAt", "proposalId",
  "evidenceEventIds",
]);
const profileProvenanceFields = new Set([
  "kind", "entryId", "versionId", "contentDigest", "installationId", "installedBy", "installedAt", "origin",
]);
const localDirectoryOriginFields = new Set(["kind", "reference", "manifestDigest", "sourceDigest"]);
const harnessOriginFields = new Set(["kind", "entryId", "versionId", "digest"]);
const profileApiOriginFields = new Set(["kind", "reference"]);
const policyFields = new Set([
  "sessionId", "branchId", "workspaceId", "userScopeKey", "profileScopeKey", "permissionAllowlist",
  "candidateExposures",
]);
const exposureFields = new Set(["exposureId", "entryId", "versionId", "digest", "sessionId", "branchId", "exposedAt"]);
const transitionFields = new Set(["expectedVersionId", "expectedDigest", "availability"]);

/** Strict validation rejects coercions, unknown fields, mismatched provenance, and non-canonical lists. */
export function validateSkillCatalogRecord(value: unknown): SkillCatalogRecord {
  const input = strictObject(value, "Skill catalog record", recordFields, "INVALID_RECORD");
  if (input.schemaVersion !== SKILL_CATALOG_SCHEMA_VERSION) invalidRecord("Unsupported skill catalog schema version");
  const source = strictEnum(input.source, skillCatalogSources, "source", "INVALID_RECORD");
  const entryId = strictId(input.entryId, "entryId", "INVALID_RECORD");
  const versionId = strictId(input.versionId, "versionId", "INVALID_RECORD");
  const digest = strictDigest(input.digest, "digest", "INVALID_RECORD");
  const name = strictName(input.name);
  const scope = strictEnum(input.scope, skillCatalogScopes, "scope", "INVALID_RECORD");
  const scopeKey = strictId(input.scopeKey, "scopeKey", "INVALID_RECORD");
  const availability = strictEnum(input.availability, skillAvailabilities, "availability", "INVALID_RECORD");
  const permissions = strictPermissions(input.permissions, "INVALID_RECORD", true);
  const provenance = validateProvenance(input.provenance, source, entryId, versionId, digest);
  const latestTest = input.latestTest === null
    ? null
    : validateTestSummary(input.latestTest, versionId, digest);

  if (source === "profile" && scope !== "global") invalidRecord("Profile skills must use global scope");
  if (source === "profile" && availability === "candidate") invalidRecord("Profile skills cannot be harness candidates");
  if (source === "harness" && scope === "global" && scopeKey !== SKILL_HARNESS_GLOBAL_SCOPE_KEY) {
    invalidRecord(`Global harness skills must use scopeKey ${SKILL_HARNESS_GLOBAL_SCOPE_KEY}`);
  }
  if ((availability === "candidate" || availability === "enabled") && latestTest?.outcome !== "passed") {
    invalidRecord(`${availability} skill versions require a passing latest test for the same immutable digest`);
  }

  return Object.freeze({
    schemaVersion: SKILL_CATALOG_SCHEMA_VERSION,
    source,
    entryId,
    versionId,
    digest,
    name,
    scope,
    scopeKey,
    availability,
    provenance,
    permissions: Object.freeze(permissions),
    latestTest,
  });
}

/** Validates and de-duplicates physical source/version rows without discarding removed history. */
export function validateSkillCatalog(records: readonly unknown[]): readonly SkillCatalogRecord[] {
  if (!Array.isArray(records) || records.length > MAX_SKILL_CATALOG_RECORDS) {
    throw new SkillCatalogValidationError("INVALID_RECORD", `Skill catalog exceeds ${MAX_SKILL_CATALOG_RECORDS} records`);
  }
  const result: SkillCatalogRecord[] = [];
  const identities = new Set<string>();
  for (const value of records) {
    const record = validateSkillCatalogRecord(value);
    const identity = skillCatalogIdentity(record);
    if (identities.has(identity)) invalidRecord(`Duplicate skill catalog identity: ${identity}`);
    identities.add(identity);
    result.push(record);
  }
  return Object.freeze(result);
}

/** Canonical SHA-256 compatible with sorted-key profile definitions. */
export function canonicalSkillDigest(definition: JsonValue): string {
  const state = { nodes: 0, bytes: 0 };
  const canonical = canonicalJson(definition, 0, state);
  if (byteLength(canonical) > MAX_CANONICAL_SKILL_DEFINITION_BYTES) {
    throw new SkillCatalogValidationError("INVALID_DIGEST", `Canonical skill definition exceeds ${MAX_CANONICAL_SKILL_DEFINITION_BYTES} bytes`);
  }
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(canonical);
  return hash.digest("hex");
}

export function assertCanonicalSkillDigest(definition: JsonValue, digest: string): void {
  const expected = canonicalSkillDigest(definition);
  const actual = strictDigest(digest, "digest", "INVALID_DIGEST");
  if (actual !== expected) throw new SkillCatalogValidationError("INVALID_DIGEST", "Skill definition does not match its canonical digest");
}

export function skillCatalogIdentity(record: Pick<SkillCatalogRecord, "source" | "entryId" | "versionId">): string {
  return `${record.source}:${record.entryId}:${record.versionId}`;
}

/**
 * A lifecycle-only predicate. Scope and permission checks are deliberately
 * separate so management surfaces can explain availability without granting it.
 */
export function isSkillAvailable(record: SkillCatalogRecord, policy: SkillResolutionPolicy): boolean {
  const validRecord = validateSkillCatalogRecord(record);
  const validPolicy = validateSkillResolutionPolicy(policy);
  return availableExposure(validRecord, validPolicy) !== undefined;
}

/** Context selection is availability plus exact durable scope authority. */
export function isSkillContextEligible(record: SkillCatalogRecord, policy: SkillResolutionPolicy): boolean {
  const validRecord = validateSkillCatalogRecord(record);
  const validPolicy = validateSkillResolutionPolicy(policy);
  return availableExposure(validRecord, validPolicy) !== undefined && scopePrecedence(validRecord, validPolicy) !== null;
}

/** Invocation additionally requires every declared permission to be runtime-allowed. */
export function isSkillInvocable(record: SkillCatalogRecord, policy: SkillResolutionPolicy): boolean {
  const validRecord = validateSkillCatalogRecord(record);
  const validPolicy = validateSkillResolutionPolicy(policy);
  return availableExposure(validRecord, validPolicy) !== undefined
    && scopePrecedence(validRecord, validPolicy) !== null
    && permissionsAllowed(validRecord, validPolicy);
}

/** Disabled, removed, and rejected rows are never implicit even when their names match. */
export function isSkillImplicitlyResolvable(record: SkillCatalogRecord, policy: SkillResolutionPolicy): boolean {
  return isSkillInvocable(record, policy);
}

/**
 * Resolves one invocable immutable version. Exact entry/version identifiers are
 * detected before name lookup, so a disabled ID cannot fall through to an
 * unrelated record whose name happens to equal that ID.
 */
export function resolveSkillCatalog(
  records: readonly SkillCatalogRecord[],
  reference: string,
  policy: SkillResolutionPolicy,
): SkillResolution {
  const catalog = validateSkillCatalog(records);
  const validPolicy = validateSkillResolutionPolicy(policy);
  const validReference = strictReference(reference);
  const entryMatches = catalog.filter(record => record.entryId === validReference);
  const versionMatches = catalog.filter(record => record.versionId === validReference);
  // Entry IDs are the durable management identity. If an adversarial version ID
  // collides with one, it cannot redirect an entry-ID lookup.
  const idMatches = entryMatches.length > 0 ? entryMatches : versionMatches;
  const matchedBy: SkillResolution["matchedBy"] = entryMatches.length > 0
    ? "entry-id"
    : versionMatches.length > 0 ? "version-id" : "name";
  const considered = idMatches.length > 0 ? idMatches : catalog.filter(record => record.name === validReference);

  const eligible = considered.flatMap(record => {
    const exposure = availableExposure(record, validPolicy);
    const precedence = scopePrecedence(record, validPolicy);
    if (exposure === undefined || precedence === null || !permissionsAllowed(record, validPolicy)) return [];
    return [{ record, matchedBy, precedence, exposure }];
  });

  if (eligible.length === 0) {
    if (idMatches.length > 0) throw exactIdFailure(idMatches, validPolicy);
    throw new SkillResolutionError("NOT_FOUND", "No invocable skill matches the requested name");
  }

  const bestRank = Math.min(...eligible.map(item => precedenceRank(item.precedence)));
  const winners = eligible
    .filter(item => precedenceRank(item.precedence) === bestRank)
    .sort((left, right) => compareText(skillCatalogIdentity(left.record), skillCatalogIdentity(right.record)));
  if (winners.length > 1) {
    throw new SkillResolutionError(
      "AMBIGUOUS",
      `Skill resolution is ambiguous at precedence ${winners[0]!.precedence}`,
      winners.map(item => skillCatalogIdentity(item.record)),
    );
  }
  const winner = winners[0]!;
  return Object.freeze({
    record: winner.record,
    matchedBy: winner.matchedBy,
    precedence: winner.precedence,
    ...(winner.exposure === null ? {} : { exposureId: winner.exposure.exposureId }),
  });
}

export interface SkillAvailabilityTransition {
  readonly expectedVersionId: string;
  readonly expectedDigest: string;
  readonly availability: SkillAvailability;
}

/**
 * Compare-and-swap lifecycle transition. Re-enable changes availability only;
 * entry, version, digest, provenance, permissions, name, and scope are retained.
 */
export function transitionSkillAvailability(
  record: SkillCatalogRecord,
  transition: SkillAvailabilityTransition,
): SkillCatalogRecord {
  const current = validateSkillCatalogRecord(record);
  const input = strictObject(transition, "Skill availability transition", transitionFields, "INVALID_AVAILABILITY_TRANSITION");
  const expectedVersionId = strictId(input.expectedVersionId, "expectedVersionId", "INVALID_AVAILABILITY_TRANSITION");
  const expectedDigest = strictDigest(input.expectedDigest, "expectedDigest", "INVALID_AVAILABILITY_TRANSITION");
  const target = strictEnum(input.availability, skillAvailabilities, "availability", "INVALID_AVAILABILITY_TRANSITION");
  if (current.versionId !== expectedVersionId || current.digest !== expectedDigest) {
    throw new SkillCatalogValidationError("IMMUTABLE_VERSION_CHANGED", "Skill availability compare-and-swap did not match the immutable version");
  }
  if (!allowedAvailabilityTransition(current.availability, target)) {
    throw new SkillCatalogValidationError(
      "INVALID_AVAILABILITY_TRANSITION",
      `Skill availability cannot transition from ${current.availability} to ${target}`,
    );
  }
  if ((target === "candidate" || target === "enabled") && current.latestTest?.outcome !== "passed") {
    throw new SkillCatalogValidationError("INVALID_AVAILABILITY_TRANSITION", "A passing test for the same digest is required before enablement");
  }
  const result = validateSkillCatalogRecord({ ...current, availability: target });
  assertSameImmutableSkillVersion(current, result);
  return result;
}

/** Ensures lifecycle/test projections never rewrite the immutable skill version. */
export function assertSameImmutableSkillVersion(previous: SkillCatalogRecord, next: SkillCatalogRecord): void {
  const left = validateSkillCatalogRecord(previous);
  const right = validateSkillCatalogRecord(next);
  const immutable = (record: SkillCatalogRecord): JsonValue => ({
    schemaVersion: record.schemaVersion,
    source: record.source,
    entryId: record.entryId,
    versionId: record.versionId,
    digest: record.digest,
    name: record.name,
    scope: record.scope,
    scopeKey: record.scopeKey,
    provenance: record.provenance as unknown as JsonValue,
    permissions: [...record.permissions],
  });
  if (canonicalJson(immutable(left), 0, { nodes: 0, bytes: 0 }) !== canonicalJson(immutable(right), 0, { nodes: 0, bytes: 0 })) {
    throw new SkillCatalogValidationError("IMMUTABLE_VERSION_CHANGED", "Immutable skill version fields changed");
  }
}

function validateSkillResolutionPolicy(value: unknown): SkillResolutionPolicy {
  const input = strictObject(value, "Skill resolution policy", policyFields, "INVALID_POLICY");
  const sessionId = strictId(input.sessionId, "sessionId", "INVALID_POLICY");
  const branchId = strictId(input.branchId, "branchId", "INVALID_POLICY");
  const workspaceId = strictId(input.workspaceId, "workspaceId", "INVALID_POLICY");
  const userScopeKey = strictId(input.userScopeKey, "userScopeKey", "INVALID_POLICY");
  const profileScopeKey = strictId(input.profileScopeKey, "profileScopeKey", "INVALID_POLICY");
  const permissionAllowlist = strictPermissions(input.permissionAllowlist, "INVALID_POLICY", false);
  if (!Array.isArray(input.candidateExposures) || input.candidateExposures.length > MAX_SKILL_CANDIDATE_EXPOSURES) {
    invalidPolicy(`candidateExposures exceeds ${MAX_SKILL_CANDIDATE_EXPOSURES}`);
  }
  const exposureIds = new Set<string>();
  const candidateExposures = input.candidateExposures.map(value => {
    const exposure = validateExposure(value);
    if (exposureIds.has(exposure.exposureId)) invalidPolicy(`Duplicate candidate exposure ID: ${exposure.exposureId}`);
    exposureIds.add(exposure.exposureId);
    return exposure;
  });
  return Object.freeze({
    sessionId,
    branchId,
    workspaceId,
    userScopeKey,
    profileScopeKey,
    permissionAllowlist: Object.freeze(permissionAllowlist),
    candidateExposures: Object.freeze(candidateExposures),
  });
}

function validateExposure(value: unknown): SkillCandidateExposure {
  const input = strictObject(value, "Candidate exposure", exposureFields, "INVALID_POLICY");
  return Object.freeze({
    exposureId: strictId(input.exposureId, "exposureId", "INVALID_POLICY"),
    entryId: strictId(input.entryId, "entryId", "INVALID_POLICY"),
    versionId: strictId(input.versionId, "versionId", "INVALID_POLICY"),
    digest: strictDigest(input.digest, "digest", "INVALID_POLICY"),
    sessionId: strictId(input.sessionId, "sessionId", "INVALID_POLICY"),
    branchId: strictId(input.branchId, "branchId", "INVALID_POLICY"),
    exposedAt: strictTimestamp(input.exposedAt, "exposedAt", "INVALID_POLICY"),
  });
}

function validateProvenance(
  value: unknown,
  source: SkillCatalogSource,
  entryId: string,
  versionId: string,
  digest: string,
): SkillCatalogProvenance {
  if (!isPlainObject(value)) invalidRecord("Skill provenance must be an object");
  if (source === "harness") {
    const input = strictObject(value, "Harness skill provenance", harnessProvenanceFields, "INVALID_RECORD");
    if (input.kind !== "harness-version") invalidRecord("Harness skill provenance kind is invalid");
    const provenance: HarnessSkillProvenance = {
      kind: "harness-version",
      entryId: strictId(input.entryId, "provenance.entryId", "INVALID_RECORD"),
      versionId: strictId(input.versionId, "provenance.versionId", "INVALID_RECORD"),
      contentDigest: strictDigest(input.contentDigest, "provenance.contentDigest", "INVALID_RECORD"),
      createdEventId: strictId(input.createdEventId, "provenance.createdEventId", "INVALID_RECORD"),
      createdBy: strictId(input.createdBy, "provenance.createdBy", "INVALID_RECORD"),
      createdAt: strictTimestamp(input.createdAt, "provenance.createdAt", "INVALID_RECORD"),
      proposalId: input.proposalId === null ? null : strictId(input.proposalId, "provenance.proposalId", "INVALID_RECORD"),
      evidenceEventIds: Object.freeze(strictIdList(input.evidenceEventIds, 64, "provenance.evidenceEventIds", "INVALID_RECORD", true)),
    };
    assertProvenanceIdentity(provenance, entryId, versionId, digest);
    return Object.freeze(provenance);
  }
  const input = strictObject(value, "Profile skill provenance", profileProvenanceFields, "INVALID_RECORD");
  if (input.kind !== "profile-install") invalidRecord("Profile skill provenance kind is invalid");
  const provenance: ProfileSkillProvenance = {
    kind: "profile-install",
    entryId: strictId(input.entryId, "provenance.entryId", "INVALID_RECORD"),
    versionId: strictId(input.versionId, "provenance.versionId", "INVALID_RECORD"),
    contentDigest: strictDigest(input.contentDigest, "provenance.contentDigest", "INVALID_RECORD"),
    installationId: strictId(input.installationId, "provenance.installationId", "INVALID_RECORD"),
    installedBy: strictId(input.installedBy, "provenance.installedBy", "INVALID_RECORD"),
    installedAt: strictTimestamp(input.installedAt, "provenance.installedAt", "INVALID_RECORD"),
    origin: validateProfileOrigin(input.origin),
  };
  assertProvenanceIdentity(provenance, entryId, versionId, digest);
  return Object.freeze(provenance);
}

function validateProfileOrigin(value: unknown): ProfileSkillOrigin {
  if (!isPlainObject(value)) invalidRecord("Profile skill origin must be an object");
  if (value.kind === "local-directory") {
    const input = strictObject(value, "Local-directory origin", localDirectoryOriginFields, "INVALID_RECORD");
    return Object.freeze({
      kind: "local-directory",
      reference: strictReferenceValue(input.reference, "origin.reference"),
      manifestDigest: strictDigest(input.manifestDigest, "origin.manifestDigest", "INVALID_RECORD"),
      sourceDigest: strictDigest(input.sourceDigest, "origin.sourceDigest", "INVALID_RECORD"),
    });
  }
  if (value.kind === "harness-version") {
    const input = strictObject(value, "Harness-version origin", harnessOriginFields, "INVALID_RECORD");
    return Object.freeze({
      kind: "harness-version",
      entryId: strictId(input.entryId, "origin.entryId", "INVALID_RECORD"),
      versionId: strictId(input.versionId, "origin.versionId", "INVALID_RECORD"),
      digest: strictDigest(input.digest, "origin.digest", "INVALID_RECORD"),
    });
  }
  if (value.kind === "profile-api") {
    const input = strictObject(value, "Profile API origin", profileApiOriginFields, "INVALID_RECORD");
    return Object.freeze({ kind: "profile-api", reference: strictReferenceValue(input.reference, "origin.reference") });
  }
  invalidRecord("Profile skill origin kind is invalid");
}

function validateTestSummary(value: unknown, versionId: string, digest: string): SkillLatestTestSummary {
  const input = strictObject(value, "Latest skill test", testFields, "INVALID_RECORD");
  const result: SkillLatestTestSummary = {
    testId: strictId(input.testId, "latestTest.testId", "INVALID_RECORD"),
    versionId: strictId(input.versionId, "latestTest.versionId", "INVALID_RECORD"),
    digest: strictDigest(input.digest, "latestTest.digest", "INVALID_RECORD"),
    testedAt: strictTimestamp(input.testedAt, "latestTest.testedAt", "INVALID_RECORD"),
    compiled: strictBoolean(input.compiled, "latestTest.compiled"),
    passed: strictCount(input.passed, "latestTest.passed"),
    failed: strictCount(input.failed, "latestTest.failed"),
    outcome: strictEnum(input.outcome, skillTestOutcomes, "latestTest.outcome", "INVALID_RECORD"),
  };
  if (result.versionId !== versionId || result.digest !== digest) invalidRecord("Latest test does not match the immutable version and digest");
  if (result.passed + result.failed < 1 || result.passed + result.failed > MAX_SKILL_TEST_CASES) {
    invalidRecord(`Latest test must summarize 1-${MAX_SKILL_TEST_CASES} cases`);
  }
  const passed = result.compiled && result.failed === 0 && result.passed > 0;
  if ((result.outcome === "passed") !== passed) invalidRecord("Latest test outcome contradicts its compile and case counts");
  return Object.freeze(result);
}

function assertProvenanceIdentity(
  provenance: Pick<SkillCatalogProvenance, "entryId" | "versionId" | "contentDigest">,
  entryId: string,
  versionId: string,
  digest: string,
): void {
  if (provenance.entryId !== entryId || provenance.versionId !== versionId || provenance.contentDigest !== digest) {
    invalidRecord("Skill provenance does not match the record's immutable identity and digest");
  }
}

function availableExposure(record: SkillCatalogRecord, policy: SkillResolutionPolicy): SkillCandidateExposure | null | undefined {
  if (record.availability === "enabled") return null;
  if (record.availability !== "candidate" || record.source !== "harness") return undefined;
  return policy.candidateExposures.find(exposure =>
    exposure.entryId === record.entryId
    && exposure.versionId === record.versionId
    && exposure.digest === record.digest
    && exposure.sessionId === policy.sessionId
    && exposure.branchId === policy.branchId
  );
}

function scopePrecedence(record: SkillCatalogRecord, policy: SkillResolutionPolicy): SkillResolutionPrecedence | null {
  if (record.availability === "candidate") {
    return availableExposure(record, policy) !== undefined && harnessScopeAuthorized(record, policy)
      ? "exposed-candidate"
      : null;
  }
  if (record.source === "profile") {
    return record.scope === "global" && record.scopeKey === policy.profileScopeKey ? "profile-global" : null;
  }
  if (!harnessScopeAuthorized(record, policy)) return null;
  if (record.scope === "local") return "session-local";
  if (record.scope === "workspace") return "workspace";
  return "user-or-global-harness";
}

function harnessScopeAuthorized(record: SkillCatalogRecord, policy: SkillResolutionPolicy): boolean {
  if (record.source !== "harness") return false;
  if (record.scope === "local") return record.scopeKey === policy.sessionId;
  if (record.scope === "workspace") return record.scopeKey === policy.workspaceId;
  if (record.scope === "user") return record.scopeKey === policy.userScopeKey;
  return record.scopeKey === SKILL_HARNESS_GLOBAL_SCOPE_KEY;
}

function permissionsAllowed(record: SkillCatalogRecord, policy: SkillResolutionPolicy): boolean {
  const allowed = new Set(policy.permissionAllowlist);
  return record.permissions.every(permission => allowed.has(permission));
}

function precedenceRank(precedence: SkillResolutionPrecedence): number {
  return skillResolutionPrecedences.indexOf(precedence);
}

function exactIdFailure(records: readonly SkillCatalogRecord[], policy: SkillResolutionPolicy): SkillResolutionError {
  const identities = records.map(skillCatalogIdentity);
  const lifecycleAvailable = records.filter(record => availableExposure(record, policy) !== undefined);
  if (lifecycleAvailable.length === 0) {
    if (records.some(record => record.availability === "candidate")) {
      return new SkillResolutionError("CANDIDATE_NOT_EXPOSED", "Candidate skill lacks exact exposure evidence for this session branch", identities);
    }
    return new SkillResolutionError("UNAVAILABLE", "The requested skill version is not enabled", identities);
  }
  const inScope = lifecycleAvailable.filter(record => scopePrecedence(record, policy) !== null);
  if (inScope.length === 0) return new SkillResolutionError("OUT_OF_SCOPE", "The requested skill is outside the caller's exact scope", identities);
  if (inScope.every(record => !permissionsAllowed(record, policy))) {
    return new SkillResolutionError("PERMISSION_DENIED", "The requested skill declares permissions not allowed by runtime policy", identities);
  }
  return new SkillResolutionError("NOT_FOUND", "No invocable skill version matches the requested identifier", identities);
}

function allowedAvailabilityTransition(current: SkillAvailability, target: SkillAvailability): boolean {
  if (current === target) return true;
  if (current === "candidate") return target === "enabled" || target === "rejected" || target === "removed";
  if (current === "enabled") return target === "disabled" || target === "removed";
  if (current === "disabled") return target === "enabled" || target === "removed";
  return false;
}

function canonicalJson(value: unknown, depth: number, state: { nodes: number; bytes: number }): string {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
    throw new SkillCatalogValidationError("INVALID_DIGEST", "Canonical skill definition is too deep or complex");
  }
  if (value === null) return accountCanonical("null", state);
  if (typeof value === "string") {
    if (byteLength(value) > MAX_CANONICAL_SKILL_DEFINITION_BYTES) {
      throw new SkillCatalogValidationError("INVALID_DIGEST", "Canonical skill definition exceeds the byte bound");
    }
    return accountCanonical(JSON.stringify(value), state);
  }
  if (typeof value === "boolean") return accountCanonical(JSON.stringify(value), state);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SkillCatalogValidationError("INVALID_DIGEST", "Canonical skill definition contains a non-finite number");
    return accountCanonical(JSON.stringify(Object.is(value, -0) ? 0 : value), state);
  }
  if (Array.isArray(value)) {
    accountCanonicalBytes(2 + Math.max(0, value.length - 1), state);
    return `[${value.map(item => canonicalJson(item, depth + 1, state)).join(",")}]`;
  }
  if (!isPlainObject(value)) throw new SkillCatalogValidationError("INVALID_DIGEST", "Canonical skill definition contains a non-JSON value");
  const keys = Object.keys(value).sort(compareText);
  accountCanonicalBytes(2 + Math.max(0, keys.length - 1), state);
  return `{${keys.map(key => {
    if (byteLength(key) > MAX_PROVENANCE_REFERENCE_BYTES) {
      throw new SkillCatalogValidationError("INVALID_DIGEST", "Canonical skill definition contains an overlong object key");
    }
    const serializedKey = JSON.stringify(key);
    accountCanonicalBytes(byteLength(serializedKey) + 1, state);
    return `${serializedKey}:${canonicalJson(value[key], depth + 1, state)}`;
  }).join(",")}}`;
}

function accountCanonical(value: string, state: { bytes: number }): string {
  accountCanonicalBytes(byteLength(value), state);
  return value;
}

function accountCanonicalBytes(bytes: number, state: { bytes: number }): void {
  state.bytes += bytes;
  if (state.bytes > MAX_CANONICAL_SKILL_DEFINITION_BYTES) {
    throw new SkillCatalogValidationError("INVALID_DIGEST", `Canonical skill definition exceeds ${MAX_CANONICAL_SKILL_DEFINITION_BYTES} bytes`);
  }
}

function strictObject(
  value: unknown,
  label: string,
  fields: ReadonlySet<string>,
  code: SkillCatalogValidationErrorCode,
): Record<string, unknown> {
  if (!isPlainObject(value)) throw new SkillCatalogValidationError(code, `${label} must be an object`);
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some(key => !fields.has(key))) {
    throw new SkillCatalogValidationError(code, `${label} fields do not match schema version 1`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function strictEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string,
  code: SkillCatalogValidationErrorCode,
): Values[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new SkillCatalogValidationError(code, `Skill catalog ${field} is invalid`);
  }
  return value as Values[number];
}

function strictId(value: unknown, field: string, code: SkillCatalogValidationErrorCode): string {
  if (typeof value !== "string" || byteLength(value) > MAX_ID_BYTES || !idPattern.test(value)) {
    throw new SkillCatalogValidationError(code, `Skill catalog ${field} is invalid`);
  }
  return value;
}

function strictName(value: unknown): string {
  if (!isValidSkillName(value)) invalidRecord("Skill name must use bounded lower-kebab-case");
  return value;
}

function strictDigest(value: unknown, field: string, code: SkillCatalogValidationErrorCode): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new SkillCatalogValidationError(code, `Skill catalog ${field} must be lowercase SHA-256`);
  }
  return value;
}

function strictTimestamp(value: unknown, field: string, code: SkillCatalogValidationErrorCode): string {
  if (typeof value !== "string" || value.length !== 24) {
    throw new SkillCatalogValidationError(code, `Skill catalog ${field} is not canonical ISO-8601`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new SkillCatalogValidationError(code, `Skill catalog ${field} is not canonical ISO-8601`);
  }
  return value;
}

function strictReferenceValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value !== value.trim() || !value || value.includes("\0") || byteLength(value) > MAX_PROVENANCE_REFERENCE_BYTES) {
    invalidRecord(`Skill ${field} is invalid`);
  }
  return value;
}

function strictPermissions(
  value: unknown,
  code: SkillCatalogValidationErrorCode,
  requireCanonicalOrder: boolean,
): string[] {
  if (!Array.isArray(value) || value.length > MAX_SKILL_PERMISSIONS) {
    throw new SkillCatalogValidationError(code, `Skill permissions exceed ${MAX_SKILL_PERMISSIONS}`);
  }
  const result = value.map((permission, index) => {
    if (
      typeof permission !== "string"
      || byteLength(permission) > MAX_PERMISSION_BYTES
      || !permissionPattern.test(permission)
      || forbiddenPermissionPattern.test(permission)
    ) {
      throw new SkillCatalogValidationError(code, `Skill permission at index ${index} is invalid`);
    }
    return permission;
  });
  if (new Set(result).size !== result.length) throw new SkillCatalogValidationError(code, "Duplicate skill permissions are not allowed");
  if (requireCanonicalOrder && result.some((permission, index) => index > 0 && compareText(result[index - 1]!, permission) >= 0)) {
    throw new SkillCatalogValidationError(code, "Skill permissions must use canonical sorted order");
  }
  return result;
}

function strictIdList(
  value: unknown,
  maximum: number,
  field: string,
  code: SkillCatalogValidationErrorCode,
  requireCanonicalOrder: boolean,
): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new SkillCatalogValidationError(code, `${field} exceeds ${maximum}`);
  const result = value.map(item => strictId(item, field, code));
  if (new Set(result).size !== result.length) throw new SkillCatalogValidationError(code, `${field} contains duplicates`);
  if (requireCanonicalOrder && result.some((item, index) => index > 0 && compareText(result[index - 1]!, item) >= 0)) {
    throw new SkillCatalogValidationError(code, `${field} must use canonical sorted order`);
  }
  return result;
}

function strictBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalidRecord(`Skill ${field} must be boolean`);
  return value;
}

function strictCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_SKILL_TEST_CASES) {
    invalidRecord(`Skill ${field} is invalid`);
  }
  return value;
}

function strictReference(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !value || byteLength(value) > MAX_ID_BYTES) {
    throw new SkillResolutionError("NOT_FOUND", "Skill reference is invalid");
  }
  return value;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidRecord(message: string): never {
  throw new SkillCatalogValidationError("INVALID_RECORD", message);
}

function invalidPolicy(message: string): never {
  throw new SkillCatalogValidationError("INVALID_POLICY", message);
}

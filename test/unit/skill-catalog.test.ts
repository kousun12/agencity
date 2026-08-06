import { describe, expect, test } from "bun:test";
import {
  MAX_SKILL_CATALOG_RECORDS,
  SkillCatalogValidationError,
  SkillResolutionError,
  assertCanonicalSkillDigest,
  assertSameImmutableSkillVersion,
  canonicalSkillDigest,
  isSkillAvailable,
  isSkillContextEligible,
  isSkillImplicitlyResolvable,
  isSkillInvocable,
  resolveSkillCatalog,
  transitionSkillAvailability,
  validateSkillCatalog,
  validateSkillCatalogRecord,
  type SkillCandidateExposure,
  type SkillCatalogRecord,
  type SkillResolutionPolicy,
} from "../../src/domain/skill-catalog.ts";

const createdAt = "2026-08-06T12:00:00.000Z";
const testedAt = "2026-08-06T12:01:00.000Z";
const digest = canonicalSkillDigest({
  description: "Read a bounded fixture",
  permissions: ["files.read"],
  runtime: "bun",
  source: "export default () => 'ok'",
  tests: [{ expected: "ok", input: null, name: "returns ok" }],
});
const otherDigest = canonicalSkillDigest({ source: "different immutable source" });

function passingTest(versionId: string, contentDigest = digest) {
  return {
    testId: `test-${versionId}`,
    versionId,
    digest: contentDigest,
    testedAt,
    compiled: true,
    passed: 1,
    failed: 0,
    outcome: "passed" as const,
  };
}

function harnessRecord(input: Partial<SkillCatalogRecord> & {
  entryId?: string;
  versionId?: string;
  scope?: SkillCatalogRecord["scope"];
  scopeKey?: string;
} = {}): SkillCatalogRecord {
  const entryId = input.entryId ?? "entry-skill";
  const versionId = input.versionId ?? `version-${entryId}`;
  const contentDigest = input.digest ?? digest;
  const scope = input.scope ?? "workspace";
  const scopeKey = input.scopeKey ?? (scope === "local" ? "session-1" : scope === "workspace" ? "workspace-1" : scope === "user" ? "user-1" : "global");
  return {
    schemaVersion: 1,
    source: "harness",
    entryId,
    versionId,
    digest: contentDigest,
    name: input.name ?? "read-fixture",
    scope,
    scopeKey,
    availability: input.availability ?? "enabled",
    provenance: input.provenance ?? {
      kind: "harness-version",
      entryId,
      versionId,
      contentDigest,
      createdEventId: `event-${entryId}`,
      createdBy: "agent",
      createdAt,
      proposalId: `proposal-${entryId}`,
      evidenceEventIds: [`evidence-${entryId}`],
    },
    permissions: input.permissions ?? ["files.read"],
    latestTest: input.latestTest === undefined ? passingTest(versionId, contentDigest) : input.latestTest,
  };
}

function profileRecord(input: Partial<SkillCatalogRecord> & { entryId?: string; versionId?: string } = {}): SkillCatalogRecord {
  const entryId = input.entryId ?? "profile-skill";
  const versionId = input.versionId ?? `version-${entryId}`;
  const contentDigest = input.digest ?? digest;
  return {
    schemaVersion: 1,
    source: "profile",
    entryId,
    versionId,
    digest: contentDigest,
    name: input.name ?? "read-fixture",
    scope: "global",
    scopeKey: input.scopeKey ?? "profile-1",
    availability: input.availability ?? "enabled",
    provenance: input.provenance ?? {
      kind: "profile-install",
      entryId,
      versionId,
      contentDigest,
      installationId: `install-${entryId}`,
      installedBy: "user-1",
      installedAt: createdAt,
      origin: {
        kind: "local-directory",
        reference: "/tmp/inspected-skill",
        manifestDigest: otherDigest,
        sourceDigest: contentDigest,
      },
    },
    permissions: input.permissions ?? ["files.read"],
    latestTest: input.latestTest === undefined ? passingTest(versionId, contentDigest) : input.latestTest,
  };
}

function exposure(record: SkillCatalogRecord, input: Partial<SkillCandidateExposure> = {}): SkillCandidateExposure {
  return {
    exposureId: input.exposureId ?? `exposure-${record.entryId}`,
    entryId: input.entryId ?? record.entryId,
    versionId: input.versionId ?? record.versionId,
    digest: input.digest ?? record.digest,
    sessionId: input.sessionId ?? "session-1",
    branchId: input.branchId ?? "branch-1",
    exposedAt: input.exposedAt ?? testedAt,
  };
}

function policy(input: Partial<SkillResolutionPolicy> = {}): SkillResolutionPolicy {
  return {
    sessionId: input.sessionId ?? "session-1",
    branchId: input.branchId ?? "branch-1",
    workspaceId: input.workspaceId ?? "workspace-1",
    userScopeKey: input.userScopeKey ?? "user-1",
    profileScopeKey: input.profileScopeKey ?? "profile-1",
    permissionAllowlist: input.permissionAllowlist ?? ["files.read"],
    candidateExposures: input.candidateExposures ?? [],
  };
}

function resolutionError(action: () => unknown): SkillResolutionError {
  try {
    action();
    throw new Error("Expected SkillResolutionError");
  } catch (error) {
    expect(error).toBeInstanceOf(SkillResolutionError);
    return error as SkillResolutionError;
  }
}

function validationError(action: () => unknown): SkillCatalogValidationError {
  try {
    action();
    throw new Error("Expected SkillCatalogValidationError");
  } catch (error) {
    expect(error).toBeInstanceOf(SkillCatalogValidationError);
    return error as SkillCatalogValidationError;
  }
}

describe("strict skill catalog records", () => {
  test("accepts and freezes canonical harness and profile provenance", () => {
    const harness = validateSkillCatalogRecord(harnessRecord());
    const profile = validateSkillCatalogRecord(profileRecord());

    expect(Object.isFrozen(harness)).toBe(true);
    expect(Object.isFrozen(harness.permissions)).toBe(true);
    expect(Object.isFrozen(harness.provenance)).toBe(true);
    expect(Object.isFrozen(profile.provenance)).toBe(true);
    expect(profile.provenance.kind).toBe("profile-install");
    if (profile.provenance.kind === "profile-install") {
      expect(Object.isFrozen(profile.provenance.origin)).toBe(true);
      expect(profile.provenance.origin.kind).toBe("local-directory");
    }
  });

  test("rejects unknown fields, coercions, malformed names, and noncanonical permissions", () => {
    const valid = harnessRecord();
    expect(() => validateSkillCatalogRecord({ ...valid, surprise: true })).toThrow(SkillCatalogValidationError);
    expect(() => validateSkillCatalogRecord({ ...valid, schemaVersion: "1" })).toThrow(SkillCatalogValidationError);
    expect(() => validateSkillCatalogRecord({ ...valid, name: "Read Fixture" })).toThrow(SkillCatalogValidationError);
    expect(() => validateSkillCatalogRecord({ ...valid, permissions: ["shell.run", "files.read"] })).toThrow(/canonical sorted order/);
    expect(() => validateSkillCatalogRecord({ ...valid, permissions: ["files.read", "files.read"] })).toThrow(/Duplicate/);
    expect(() => validateSkillCatalogRecord({ ...valid, permissions: ["*"] })).toThrow(/permission/);
    expect(() => validateSkillCatalogRecord({
      ...valid,
      provenance: { ...valid.provenance, evidenceEventIds: ["event-z", "event-a"] },
    })).toThrow(/canonical sorted order/);
  });

  test("binds provenance and latest tests to the exact entry, version, and digest", () => {
    const valid = harnessRecord();
    expect(() => validateSkillCatalogRecord({
      ...valid,
      provenance: { ...valid.provenance, contentDigest: otherDigest },
    })).toThrow(/provenance/);
    expect(() => validateSkillCatalogRecord({
      ...valid,
      latestTest: { ...valid.latestTest!, versionId: "version-other" },
    })).toThrow(/Latest test/);
    expect(() => validateSkillCatalogRecord({
      ...valid,
      latestTest: { ...valid.latestTest!, digest: otherDigest },
    })).toThrow(/Latest test/);
  });

  test("requires consistent nonempty test summaries before candidate exposure or enablement", () => {
    expect(() => validateSkillCatalogRecord(harnessRecord({ availability: "enabled", latestTest: null }))).toThrow(/passing latest test/);
    expect(() => validateSkillCatalogRecord(harnessRecord({ availability: "candidate", latestTest: null }))).toThrow(/passing latest test/);
    const valid = harnessRecord();
    expect(() => validateSkillCatalogRecord({
      ...valid,
      latestTest: { ...valid.latestTest!, outcome: "failed" },
    })).toThrow(/contradicts/);
    expect(() => validateSkillCatalogRecord({
      ...valid,
      latestTest: { ...valid.latestTest!, passed: 0, failed: 0, outcome: "failed" },
    })).toThrow(/1-64 cases/);
  });

  test("enforces source/scope invariants and strict nested profile origins", () => {
    expect(() => validateSkillCatalogRecord({ ...profileRecord(), scope: "workspace" })).toThrow(/Profile skills/);
    expect(() => validateSkillCatalogRecord({ ...profileRecord(), availability: "candidate" })).toThrow(/cannot be harness candidates/);
    expect(() => validateSkillCatalogRecord(harnessRecord({ scope: "global", scopeKey: "not-global" }))).toThrow(/scopeKey global/);
    const profile = profileRecord();
    expect(() => validateSkillCatalogRecord({
      ...profile,
      provenance: {
        ...profile.provenance,
        origin: { kind: "local-directory", reference: "/tmp/x", manifestDigest: otherDigest, sourceDigest: digest, extra: true },
      },
    })).toThrow(/fields/);
  });

  test("bounds catalogs and rejects duplicate physical history rows without deleting removed rows", () => {
    const removed = harnessRecord({ availability: "removed" });
    expect(validateSkillCatalog([removed])).toHaveLength(1);
    expect(validateSkillCatalog([removed])[0]!.availability).toBe("removed");
    expect(() => validateSkillCatalog([removed, removed])).toThrow(/Duplicate skill catalog identity/);
    const oversized = Array.from({ length: MAX_SKILL_CATALOG_RECORDS + 1 }, () => removed);
    expect(() => validateSkillCatalog(oversized)).toThrow(/exceeds/);
  });
});

describe("canonical skill digests", () => {
  test("sorts keys recursively and matches a stable SHA-256", () => {
    const left = canonicalSkillDigest({ z: [3, { b: true, a: null }], a: "value" });
    const right = canonicalSkillDigest({ a: "value", z: [3, { a: null, b: true }] });
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    assertCanonicalSkillDigest({ a: "value", z: [3, { a: null, b: true }] }, left);
    expect(() => assertCanonicalSkillDigest({ changed: true }, left)).toThrow(/canonical digest/);
  });

  test("rejects non-JSON, cyclic, non-finite, and over-deep definitions", () => {
    expect(() => canonicalSkillDigest({ value: Number.POSITIVE_INFINITY } as never)).toThrow(/non-finite/);
    expect(() => canonicalSkillDigest({ value: undefined } as never)).toThrow(/non-JSON/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalSkillDigest(cyclic as never)).toThrow(/deep or complex/);
    let deep: unknown = null;
    for (let index = 0; index < 30; index += 1) deep = [deep];
    expect(() => canonicalSkillDigest(deep as never)).toThrow(/deep or complex/);
    expect(() => canonicalSkillDigest({ source: "x".repeat(768 * 1_024) })).toThrow(/exceeds/);
  });
});

describe("policy predicates and deterministic resolution", () => {
  test("uses exposed candidate, session, workspace, harness, and profile precedence in order", () => {
    const candidate = harnessRecord({ entryId: "entry-candidate", availability: "candidate", scope: "workspace", scopeKey: "workspace-1" });
    const local = harnessRecord({ entryId: "entry-local", scope: "local", scopeKey: "session-1" });
    const workspace = harnessRecord({ entryId: "entry-workspace" });
    const user = harnessRecord({ entryId: "entry-user", scope: "user", scopeKey: "user-1" });
    const profile = profileRecord({ entryId: "entry-profile" });
    const records = [profile, user, workspace, local, candidate];

    const withCandidate = resolveSkillCatalog(records, "read-fixture", policy({ candidateExposures: [exposure(candidate)] }));
    expect(withCandidate.record.entryId).toBe("entry-candidate");
    expect(withCandidate.precedence).toBe("exposed-candidate");
    expect(withCandidate.exposureId).toBe("exposure-entry-candidate");

    const withoutCandidate = resolveSkillCatalog(records, "read-fixture", policy());
    expect(withoutCandidate.record.entryId).toBe("entry-local");
    expect(withoutCandidate.precedence).toBe("session-local");

    expect(resolveSkillCatalog([profile, user, workspace], "read-fixture", policy()).record.entryId).toBe("entry-workspace");
    expect(resolveSkillCatalog([profile, user], "read-fixture", policy()).record.entryId).toBe("entry-user");
    expect(resolveSkillCatalog([profile], "read-fixture", policy()).precedence).toBe("profile-global");
  });

  test("requires an exact candidate entry/version/digest/session/branch exposure proof", () => {
    const candidate = harnessRecord({ entryId: "entry-candidate", availability: "candidate" });
    const variants = [
      exposure(candidate, { entryId: "entry-other" }),
      exposure(candidate, { versionId: "version-other" }),
      exposure(candidate, { digest: otherDigest }),
      exposure(candidate, { sessionId: "session-other" }),
      exposure(candidate, { branchId: "branch-other" }),
    ];
    for (const proof of variants) {
      expect(isSkillAvailable(candidate, policy({ candidateExposures: [proof] }))).toBe(false);
      const error = resolutionError(() => resolveSkillCatalog([candidate], candidate.entryId, policy({ candidateExposures: [proof] })));
      expect(error.code).toBe("CANDIDATE_NOT_EXPOSED");
    }
    const exact = policy({ candidateExposures: [exposure(candidate)] });
    expect(isSkillAvailable(candidate, exact)).toBe(true);
    expect(isSkillContextEligible(candidate, exact)).toBe(true);
    expect(isSkillInvocable(candidate, exact)).toBe(true);
  });

  test("candidate exposure does not widen session, workspace, user, or global scope authority", () => {
    const foreign = harnessRecord({
      entryId: "foreign-candidate",
      availability: "candidate",
      scope: "workspace",
      scopeKey: "workspace-foreign",
    });
    const exact = policy({ candidateExposures: [exposure(foreign)] });
    expect(isSkillAvailable(foreign, exact)).toBe(true);
    expect(isSkillContextEligible(foreign, exact)).toBe(false);
    expect(isSkillInvocable(foreign, exact)).toBe(false);
    expect(resolutionError(() => resolveSkillCatalog([foreign], foreign.entryId, exact)).code).toBe("OUT_OF_SCOPE");
  });

  test("disabled, removed, and rejected records are retained but never implicit, contextual, or invocable", () => {
    for (const availability of ["disabled", "removed", "rejected"] as const) {
      const record = harnessRecord({ entryId: `entry-${availability}`, availability });
      expect(isSkillAvailable(record, policy())).toBe(false);
      expect(isSkillContextEligible(record, policy())).toBe(false);
      expect(isSkillInvocable(record, policy())).toBe(false);
      expect(isSkillImplicitlyResolvable(record, policy())).toBe(false);
      expect(resolutionError(() => resolveSkillCatalog([record], record.entryId, policy())).code).toBe("UNAVAILABLE");
      expect(resolutionError(() => resolveSkillCatalog([record], record.name, policy())).code).toBe("NOT_FOUND");
    }
  });

  test("skips unavailable and policy-denied name matches but does not fall through from an exact ID", () => {
    const disabledLocal = harnessRecord({ entryId: "disabled-local", scope: "local", scopeKey: "session-1", availability: "disabled" });
    const workspace = harnessRecord({ entryId: "workspace-enabled" });
    expect(resolveSkillCatalog([disabledLocal, workspace], "read-fixture", policy()).record.entryId).toBe("workspace-enabled");
    expect(resolutionError(() => resolveSkillCatalog([disabledLocal, workspace], "disabled-local", policy())).code).toBe("UNAVAILABLE");

    const deniedLocal = harnessRecord({ entryId: "denied-local", scope: "local", scopeKey: "session-1", permissions: ["shell.run"] });
    expect(isSkillContextEligible(deniedLocal, policy())).toBe(true);
    expect(isSkillInvocable(deniedLocal, policy())).toBe(false);
    expect(resolveSkillCatalog([deniedLocal, workspace], "read-fixture", policy()).record.entryId).toBe("workspace-enabled");
    expect(resolutionError(() => resolveSkillCatalog([deniedLocal], deniedLocal.entryId, policy())).code).toBe("PERMISSION_DENIED");
  });

  test("treats user and global harness collisions as same-precedence typed ambiguity", () => {
    const user = harnessRecord({ entryId: "entry-z", scope: "user", scopeKey: "user-1" });
    const global = harnessRecord({ entryId: "entry-a", scope: "global", scopeKey: "global" });
    const first = resolutionError(() => resolveSkillCatalog([user, global], "read-fixture", policy()));
    const second = resolutionError(() => resolveSkillCatalog([global, user], "read-fixture", policy()));
    expect(first.code).toBe("AMBIGUOUS");
    expect(first.matches).toEqual([
      `harness:${global.entryId}:${global.versionId}`,
      `harness:${user.entryId}:${user.versionId}`,
    ]);
    expect(second.matches).toEqual(first.matches);
  });

  test("reports same-precedence workspace ambiguity instead of selecting incidental input order", () => {
    const left = harnessRecord({ entryId: "entry-left" });
    const right = harnessRecord({ entryId: "entry-right" });
    const error = resolutionError(() => resolveSkillCatalog([right, left], "read-fixture", policy()));
    expect(error.code).toBe("AMBIGUOUS");
    expect(error.matches).toEqual([
      `harness:${left.entryId}:${left.versionId}`,
      `harness:${right.entryId}:${right.versionId}`,
    ]);
  });

  test("matches stable entry and version IDs before treating a reference as a name", () => {
    const record = harnessRecord({ entryId: "entry-exact", versionId: "version-exact" });
    expect(resolveSkillCatalog([record], "entry-exact", policy()).matchedBy).toBe("entry-id");
    expect(resolveSkillCatalog([record], "version-exact", policy()).matchedBy).toBe("version-id");
    expect(resolveSkillCatalog([record], "read-fixture", policy()).matchedBy).toBe("name");

    const collidingVersion = harnessRecord({ entryId: "entry-other", versionId: "entry-exact", scope: "local", scopeKey: "session-1" });
    const collision = resolveSkillCatalog([collidingVersion, record], "entry-exact", policy());
    expect(collision.record.entryId).toBe("entry-exact");
    expect(collision.matchedBy).toBe("entry-id");
  });

  test("rejects malformed and over-broad policy proofs before resolution", () => {
    const record = harnessRecord();
    expect(() => resolveSkillCatalog([record], record.name, { ...policy(), extra: true } as never)).toThrow(/fields/);
    expect(() => resolveSkillCatalog([record], record.name, policy({ permissionAllowlist: ["files.read", "files.read"] }))).toThrow(/Duplicate/);
    expect(() => resolveSkillCatalog([record], record.name, policy({
      candidateExposures: [
        exposure(record, { exposureId: "same" }),
        exposure(record, { exposureId: "same" }),
      ],
    }))).toThrow(/Duplicate candidate exposure/);
  });
});

describe("availability history and immutable re-enable", () => {
  test("disable then enable restores the exact tested version digest and provenance", () => {
    const enabled = validateSkillCatalogRecord(harnessRecord());
    const disabled = transitionSkillAvailability(enabled, {
      expectedVersionId: enabled.versionId,
      expectedDigest: enabled.digest,
      availability: "disabled",
    });
    const reenabled = transitionSkillAvailability(disabled, {
      expectedVersionId: disabled.versionId,
      expectedDigest: disabled.digest,
      availability: "enabled",
    });

    expect(disabled.availability).toBe("disabled");
    expect(reenabled.availability).toBe("enabled");
    expect(reenabled.digest).toBe(enabled.digest);
    expect(reenabled.versionId).toBe(enabled.versionId);
    expect(reenabled.provenance).toEqual(enabled.provenance);
    expect(reenabled.permissions).toEqual(enabled.permissions);
    assertSameImmutableSkillVersion(enabled, reenabled);
  });

  test("compare-and-swap rejects stale digest/version and immutable rewrites", () => {
    const record = validateSkillCatalogRecord(harnessRecord());
    expect(() => transitionSkillAvailability(record, {
      expectedVersionId: record.versionId,
      expectedDigest: record.digest,
      availability: "disabled",
      extra: true,
    } as never)).toThrow(/fields/);
    expect(validationError(() => transitionSkillAvailability(record, {
      expectedVersionId: "version-stale",
      expectedDigest: record.digest,
      availability: "disabled",
    })).code).toBe("IMMUTABLE_VERSION_CHANGED");
    expect(validationError(() => transitionSkillAvailability(record, {
      expectedVersionId: record.versionId,
      expectedDigest: otherDigest,
      availability: "disabled",
    })).code).toBe("IMMUTABLE_VERSION_CHANGED");

    const rewritten = validateSkillCatalogRecord(harnessRecord({
      entryId: record.entryId,
      versionId: record.versionId,
      digest: otherDigest,
      provenance: {
        ...(record.provenance as Extract<SkillCatalogRecord["provenance"], { kind: "harness-version" }>),
        contentDigest: otherDigest,
      },
      latestTest: passingTest(record.versionId, otherDigest),
    }));
    expect(validationError(() => assertSameImmutableSkillVersion(record, rewritten)).code).toBe("IMMUTABLE_VERSION_CHANGED");
  });

  test("removal retains the record and makes history terminal", () => {
    const enabled = validateSkillCatalogRecord(harnessRecord());
    const removed = transitionSkillAvailability(enabled, {
      expectedVersionId: enabled.versionId,
      expectedDigest: enabled.digest,
      availability: "removed",
    });
    expect(removed.entryId).toBe(enabled.entryId);
    expect(removed.digest).toBe(enabled.digest);
    expect(removed.provenance).toEqual(enabled.provenance);
    expect(removed.availability).toBe("removed");
    expect(validateSkillCatalog([removed])).toHaveLength(1);
    expect(() => transitionSkillAvailability(removed, {
      expectedVersionId: removed.versionId,
      expectedDigest: removed.digest,
      availability: "enabled",
    })).toThrow(/cannot transition/);
  });

  test("failed or absent tests cannot be enabled", () => {
    const failed = validateSkillCatalogRecord(harnessRecord({
      availability: "disabled",
      latestTest: {
        testId: "test-failed",
        versionId: "version-entry-skill",
        digest,
        testedAt,
        compiled: true,
        passed: 0,
        failed: 1,
        outcome: "failed",
      },
    }));
    expect(() => transitionSkillAvailability(failed, {
      expectedVersionId: failed.versionId,
      expectedDigest: failed.digest,
      availability: "enabled",
    })).toThrow(/passing test/);

    const untested = validateSkillCatalogRecord(harnessRecord({ availability: "disabled", latestTest: null }));
    expect(() => transitionSkillAvailability(untested, {
      expectedVersionId: untested.versionId,
      expectedDigest: untested.digest,
      availability: "enabled",
    })).toThrow(/passing test/);
  });
});

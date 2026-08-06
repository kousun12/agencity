import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SERVICE_MANIFEST_BYTES,
  ServiceDiscoveryError,
  assessService,
  authorityDecisionError,
  buildServiceChildSpawnSpecification,
  cleanupStaleServiceManifest,
  createServiceManifest,
  decideServiceAuthority,
  ensureSecureServiceDirectory,
  hashServiceConfiguration,
  publishServiceManifest,
  readServiceManifest,
  serviceManifestSummary,
  serviceStatePaths,
  validateServiceManifest,
  type ServiceAuthorityDecision,
  type ServiceManifestV1,
} from "../../src/product/service-discovery.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function tempRoot(prefix = "agencity-service-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function manifest(overrides: Partial<Parameters<typeof createServiceManifest>[0]> = {}): ServiceManifestV1 {
  return createServiceManifest({
    workspaceId: "workspace-0123456789abcdef",
    deviceId: "device-0123456789abcdef",
    instanceId: "instance-0123456789abcdef",
    pidHint: 12345,
    url: "http://127.0.0.1:43123",
    startedAt: "2026-08-06T12:34:56.789Z",
    appVersion: "0.1.0",
    protocolMin: 1,
    protocolMax: 3,
    configHash: "a".repeat(64),
    randomToken: () => new Uint8Array(32).fill(7),
    ...overrides,
  });
}

function errorCode(error: unknown): string | undefined {
  return error instanceof ServiceDiscoveryError ? error.code : undefined;
}

async function writeRawManifest(root: string, content: string, mode = 0o600): Promise<void> {
  const service = await ensureSecureServiceDirectory(root);
  await writeFile(join(service, "manifest.json"), content, { mode });
  await chmod(join(service, "manifest.json"), mode);
}

const compatibility = { configHash: "a".repeat(64), protocolMin: 2, protocolMax: 4 } as const;

function healthy(found: ServiceManifestV1) {
  return {
    status: "healthy" as const,
    authenticated: true,
    workspaceId: found.workspaceId,
    instanceId: found.instanceId,
  };
}

function held(found: ServiceManifestV1) {
  return { status: "held" as const, instanceId: found.instanceId };
}

describe("FU-015 service manifest schema", () => {
  test("creates a bounded versioned loopback manifest with a random 256-bit bearer token", () => {
    const first = manifest();
    const second = createServiceManifest({
      workspaceId: first.workspaceId,
      deviceId: first.deviceId,
      instanceId: first.instanceId,
      pidHint: first.pidHint,
      url: first.url,
      startedAt: first.startedAt,
      appVersion: first.appVersion,
      protocolMin: first.protocolMin,
      protocolMax: first.protocolMax,
      configHash: first.configHash,
    });
    expect(first.schemaVersion).toBe(1);
    expect(first.url).toBe("http://127.0.0.1:43123");
    expect(first.bearerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.bearerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.bearerToken).not.toBe(first.bearerToken);
    expect(hashServiceConfiguration("same config")).toMatch(/^[a-f0-9]{64}$/);
  });

  test("strictly rejects unknown fields, coercions, unsafe URLs, invalid ranges, and weak tokens", () => {
    const valid = manifest();
    const cases: unknown[] = [
      { ...valid, surprise: true },
      { ...valid, schemaVersion: 2 },
      { ...valid, pidHint: "12345" },
      { ...valid, url: "http://localhost:43123" },
      { ...valid, url: "http://127.0.0.1:43123/path" },
      { ...valid, url: "https://127.0.0.1:43123" },
      { ...valid, protocolMin: 4, protocolMax: 3 },
      { ...valid, configHash: "A".repeat(64) },
      { ...valid, bearerToken: "short" },
      { ...valid, startedAt: "yesterday" },
      { ...valid, workspaceId: "../other" },
    ];
    for (const value of cases) {
      expect(() => validateServiceManifest(value)).toThrow(ServiceDiscoveryError);
      try { validateServiceManifest(value); }
      catch (error) { expect(errorCode(error)).toBe("INVALID_MANIFEST"); }
    }
  });

  test("redacted summaries and validation errors never disclose bearer tokens or config hashes", () => {
    const valid = manifest();
    const summary = serviceManifestSummary(valid);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(valid.bearerToken);
    expect(serialized).not.toContain(valid.configHash);
    expect(summary.bearerToken).toBe("[redacted]");
    expect(summary.configHash).toBe("[redacted]");

    const secret = "token-that-must-not-escape";
    try {
      validateServiceManifest({ ...valid, bearerToken: secret });
      throw new Error("expected validation failure");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(valid.bearerToken);
    }
  });
});

describe("owner-only service discovery state", () => {
  test("creates .agencity/service as 0700 and atomically publishes a 0600 manifest", async () => {
    const root = await tempRoot();
    const candidate = manifest();
    const result = await publishServiceManifest({
      workspaceRoot: root,
      workspaceId: candidate.workspaceId,
      manifest: candidate,
    });
    expect(result.kind).toBe("published");
    const paths = serviceStatePaths(root);
    expect((await lstat(paths.metadataDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.serviceDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.manifestPath)).mode & 0o777).toBe(0o600);
    expect(await readServiceManifest({ workspaceRoot: root, workspaceId: candidate.workspaceId })).toEqual(candidate);
    expect(await readdir(paths.serviceDirectory)).toEqual(["manifest.json"]);
  });

  test("rejects symlinked metadata, service directories, and manifests", async () => {
    const first = await tempRoot("agencity-service-link-metadata-");
    const externalMetadata = await tempRoot("agencity-service-link-target-");
    await symlink(externalMetadata, join(first, ".agencity"));
    await expect(ensureSecureServiceDirectory(first)).rejects.toMatchObject({ code: "INSECURE_SERVICE_STATE" });

    const second = await tempRoot("agencity-service-link-service-");
    const metadata = join(second, ".agencity");
    await mkdir(metadata, { mode: 0o700 });
    await chmod(metadata, 0o700);
    const externalService = await tempRoot("agencity-service-link-target-");
    await symlink(externalService, join(metadata, "service"));
    await expect(ensureSecureServiceDirectory(second)).rejects.toMatchObject({ code: "INSECURE_SERVICE_STATE" });

    const third = await tempRoot("agencity-service-link-manifest-");
    const service = await ensureSecureServiceDirectory(third);
    const outside = join(await tempRoot("agencity-service-manifest-target-"), "outside.json");
    await writeFile(outside, `${JSON.stringify(manifest())}\n`, { mode: 0o600 });
    await chmod(outside, 0o600);
    await symlink(outside, join(service, "manifest.json"));
    await expect(readServiceManifest({ workspaceRoot: third, workspaceId: manifest().workspaceId })).rejects.toMatchObject({
      code: "INSECURE_SERVICE_STATE",
    });
  });

  test("rejects insecure existing directory and file modes rather than silently repairing them", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".agencity"), { mode: 0o755 });
    await chmod(join(root, ".agencity"), 0o755);
    await expect(ensureSecureServiceDirectory(root)).rejects.toMatchObject({ code: "INSECURE_SERVICE_STATE" });

    const other = await tempRoot();
    const candidate = manifest();
    await publishServiceManifest({ workspaceRoot: other, workspaceId: candidate.workspaceId, manifest: candidate });
    await chmod(serviceStatePaths(other).manifestPath, 0o644);
    await expect(readServiceManifest({ workspaceRoot: other, workspaceId: candidate.workspaceId })).rejects.toMatchObject({
      code: "INSECURE_SERVICE_STATE",
    });
  });

  test("descriptor read rejects invalid, oversized, and cross-workspace manifests", async () => {
    const invalidRoot = await tempRoot();
    await writeRawManifest(invalidRoot, "{not-json}\n");
    await expect(readServiceManifest({ workspaceRoot: invalidRoot, workspaceId: manifest().workspaceId })).rejects.toMatchObject({
      code: "INVALID_MANIFEST",
    });

    const oversizedRoot = await tempRoot();
    await writeRawManifest(oversizedRoot, "x".repeat(MAX_SERVICE_MANIFEST_BYTES + 1));
    await expect(readServiceManifest({ workspaceRoot: oversizedRoot, workspaceId: manifest().workspaceId })).rejects.toMatchObject({
      code: "MANIFEST_TOO_LARGE",
    });

    const mismatchRoot = await tempRoot();
    await writeRawManifest(mismatchRoot, `${JSON.stringify(manifest())}\n`);
    await expect(readServiceManifest({ workspaceRoot: mismatchRoot, workspaceId: "workspace-other-12345678" })).rejects.toMatchObject({
      code: "WORKSPACE_MISMATCH",
    });
  });
});

describe("publication winner and compatibility semantics", () => {
  test("selects exactly one winner under concurrent publication", async () => {
    const root = await tempRoot();
    const candidates = Array.from({ length: 24 }, (_, index) => manifest({
      instanceId: `instance-concurrent-${index.toString().padStart(2, "0")}`,
      pidHint: 20_000 + index,
      randomToken: () => new Uint8Array(32).fill(index + 1),
    }));
    const publications = await Promise.all(candidates.map(candidate => publishServiceManifest({
      workspaceRoot: root,
      workspaceId: candidate.workspaceId,
      manifest: candidate,
    })));
    expect(publications.filter(result => result.kind === "published")).toHaveLength(1);
    const winnerIds = new Set(publications.map(result => result.manifest.instanceId));
    expect(winnerIds.size).toBe(1);
    const stored = await readServiceManifest({ workspaceRoot: root, workspaceId: candidates[0]!.workspaceId });
    expect(stored?.instanceId).toBe(publications[0]!.manifest.instanceId);
  });

  test("returns typed config and protocol mismatch errors instead of replacing a winner", async () => {
    const root = await tempRoot();
    const winner = manifest();
    await publishServiceManifest({ workspaceRoot: root, workspaceId: winner.workspaceId, manifest: winner });
    await expect(publishServiceManifest({
      workspaceRoot: root,
      workspaceId: winner.workspaceId,
      manifest: manifest({ instanceId: "config-loser", configHash: "b".repeat(64) }),
    })).rejects.toMatchObject({ code: "CONFIG_MISMATCH" });
    await expect(publishServiceManifest({
      workspaceRoot: root,
      workspaceId: winner.workspaceId,
      manifest: manifest({ instanceId: "protocol-loser", protocolMin: 5, protocolMax: 6 }),
    })).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
    expect((await readServiceManifest({ workspaceRoot: root, workspaceId: winner.workspaceId }))?.instanceId).toBe(winner.instanceId);
  });
});

describe("health plus lease authority and stale cleanup", () => {
  test("requires authenticated identity health and a matching live lease; PID alone is never authority", () => {
    const found = manifest();
    const authoritative = decideServiceAuthority({
      manifest: found,
      compatibility,
      health: healthy(found),
      lease: held(found),
      now: new Date("2026-08-06T12:35:00.000Z"),
    });
    expect(authoritative.kind).toBe("authoritative");

    const changedPid = validateServiceManifest({ ...found, pidHint: 99_999 });
    expect(decideServiceAuthority({
      manifest: changedPid,
      compatibility,
      health: { status: "unreachable" },
      lease: { status: "absent" },
    })).toEqual({ kind: "stale", instanceId: found.instanceId, reason: "unreachable-without-lease" });
    expect(decideServiceAuthority({
      manifest: found,
      compatibility,
      health: { status: "unreachable" },
      lease: held(found),
    })).toMatchObject({ kind: "conflict", reason: "lease-held-without-health" });
    expect(decideServiceAuthority({
      manifest: found,
      compatibility,
      health: healthy(found),
      lease: { status: "absent" },
    })).toMatchObject({ kind: "conflict", reason: "health-without-matching-lease" });
    expect(decideServiceAuthority({
      manifest: found,
      compatibility,
      health: healthy(found),
      lease: { status: "held", instanceId: found.instanceId, expiresAt: "2026-08-06T12:34:00.000Z" },
      now: new Date("2026-08-06T12:35:00.000Z"),
    })).toMatchObject({ kind: "conflict", reason: "health-without-matching-lease" });
  });

  test("reports config/protocol conflicts only after authority is proved", () => {
    const found = manifest();
    const configDecision = decideServiceAuthority({
      manifest: found,
      compatibility: { ...compatibility, configHash: "b".repeat(64) },
      health: healthy(found),
      lease: held(found),
    });
    expect(configDecision).toMatchObject({ kind: "conflict", code: "CONFIG_MISMATCH" });
    expect(authorityDecisionError(configDecision)?.code).toBe("CONFIG_MISMATCH");
    const protocolDecision = decideServiceAuthority({
      manifest: found,
      compatibility: { ...compatibility, protocolMin: 10, protocolMax: 12 },
      health: healthy(found),
      lease: held(found),
    });
    expect(protocolDecision).toMatchObject({ kind: "conflict", code: "PROTOCOL_MISMATCH" });
    expect(authorityDecisionError(protocolDecision)?.code).toBe("PROTOCOL_MISMATCH");

    expect(decideServiceAuthority({
      manifest: found,
      compatibility: { ...compatibility, configHash: "b".repeat(64) },
      health: { status: "unreachable" },
      lease: { status: "absent" },
    }).kind).toBe("stale");
  });

  test("uses injected health and lease evidence and cleans only the exact observed stale record", async () => {
    const root = await tempRoot();
    const found = manifest();
    await publishServiceManifest({ workspaceRoot: root, workspaceId: found.workspaceId, manifest: found });
    let probedToken = "";
    const assessed = await assessService({
      workspaceRoot: root,
      workspaceId: found.workspaceId,
      compatibility,
      probeHealth: async input => {
        probedToken = input.bearerToken;
        return { status: "unreachable" };
      },
      inspectLease: async input => {
        expect(input.instanceId).toBe(found.instanceId);
        return { status: "absent" };
      },
    });
    expect(probedToken).toBe(found.bearerToken);
    expect(assessed.kind).toBe("found");
    if (assessed.kind !== "found") throw new Error("expected manifest");
    expect(assessed.decision.kind).toBe("stale");
    expect(await cleanupStaleServiceManifest({
      workspaceRoot: root,
      workspaceId: found.workspaceId,
      observedManifest: assessed.manifest,
      decision: assessed.decision,
    })).toBe(true);
    expect(await readServiceManifest({ workspaceRoot: root, workspaceId: found.workspaceId })).toBeNull();
  });

  test("refuses cleanup if the observed stale record was replaced", async () => {
    const root = await tempRoot();
    const old = manifest();
    await publishServiceManifest({ workspaceRoot: root, workspaceId: old.workspaceId, manifest: old });
    const stale: ServiceAuthorityDecision = {
      kind: "stale",
      instanceId: old.instanceId,
      reason: "unreachable-without-lease",
    };
    expect(await cleanupStaleServiceManifest({
      workspaceRoot: root,
      workspaceId: old.workspaceId,
      observedManifest: old,
      decision: stale,
    })).toBe(true);
    const replacement = manifest({ instanceId: "instance-replacement-123" });
    await publishServiceManifest({ workspaceRoot: root, workspaceId: replacement.workspaceId, manifest: replacement });
    await expect(cleanupStaleServiceManifest({
      workspaceRoot: root,
      workspaceId: old.workspaceId,
      observedManifest: old,
      decision: stale,
    })).rejects.toMatchObject({ code: "STALE_MANIFEST_CHANGED" });
    expect((await readServiceManifest({ workspaceRoot: root, workspaceId: old.workspaceId }))?.instanceId).toBe(replacement.instanceId);
  });
});

describe("detached service child spawn plan", () => {
  test("uses process.execPath and installed source URL without a shell, secret argv, or spawning", async () => {
    const root = await tempRoot();
    const token = manifest().bearerToken;
    const plan = buildServiceChildSpawnSpecification({ workspaceRoot: root });
    expect(plan.executable).toBe(process.execPath);
    expect(plan.sourceUrl).toMatch(/^file:/);
    expect(plan.argv[0]).toMatch(/src\/cli\.ts$/);
    expect(plan.argv).toContain("__service-child");
    expect(plan.argv).toContain("--workspace");
    expect(plan.options).toMatchObject({ detached: true, stdio: "ignore", shell: false, windowsHide: true });
    expect(plan.unref).toBe(true);
    expect(JSON.stringify(plan)).not.toContain(token);
    expect(plan.argv.join(" ")).not.toContain("token");
    expect(plan.argv).not.toContain("-e");
  });

  test("rejects credentialed or parameterized source URLs", async () => {
    const root = await tempRoot();
    expect(() => buildServiceChildSpawnSpecification({
      workspaceRoot: root,
      sourceUrl: new URL("file:///tmp/service.ts?token=secret"),
    })).toThrow(ServiceDiscoveryError);
  });
});

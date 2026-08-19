import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_SKILL_SOURCE_BYTES,
  SKILL_BUNDLE_ENTRY,
  SKILL_BUNDLE_MANIFEST,
  parseSkillImportBundle,
} from "../../src/runtime/skill-import.ts";
import { registerBrokeredSecret } from "../../src/security/index.ts";

const SOURCE = `export default function run(input: { value: number }) {\n  return { doubled: input.value * 2 };\n}\n`;

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "double-number",
    description: "Doubles one numeric input.",
    entry: "skill.ts",
    runtime: "bun",
    inputSchema: {
      type: "object",
      properties: { value: { type: "number", minimum: 0 } },
      required: ["value"],
      additionalProperties: false,
    },
    permissions: [],
    tests: [{ name: "doubles two", input: { value: 2 }, expected: { doubled: 4 } }],
    ...overrides,
  };
}

async function writeBundle(
  directory: string,
  manifest: unknown = validManifest(),
  source = SOURCE,
): Promise<{ manifestText: string; source: string }> {
  const manifestText = typeof manifest === "string" ? manifest : `${JSON.stringify(manifest, null, 2)}\n`;
  await Promise.all([
    writeFile(join(directory, SKILL_BUNDLE_MANIFEST), manifestText, "utf8"),
    writeFile(join(directory, SKILL_BUNDLE_ENTRY), source, "utf8"),
  ]);
  return { manifestText, source };
}

function hash(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

describe("local skill bundle import validation", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agencity-skill-import-test-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("returns a bounded native definition, exact byte digests, and trusted-local warning", async () => {
    const files = await writeBundle(directory);

    const bundle = await parseSkillImportBundle(directory);
    const canonicalDirectory = await realpath(directory);

    expect(bundle).toEqual({
      schemaVersion: 1,
      name: "double-number",
      definition: {
        description: "Doubles one numeric input.",
        source: SOURCE,
        inputSchema: {
          type: "object",
          properties: { value: { type: "number", minimum: 0 } },
          required: ["value"],
          additionalProperties: false,
        },
        permissions: [],
        tests: [{ name: "doubles two", input: { value: 2 }, expected: { doubled: 4 } }],
        runtime: "bun",
      },
      provenance: {
        kind: "local-directory",
        directory: canonicalDirectory,
        manifest: {
          path: join(canonicalDirectory, SKILL_BUNDLE_MANIFEST),
          byteLength: Buffer.byteLength(files.manifestText),
          sha256: hash(files.manifestText),
        },
        source: {
          path: join(canonicalDirectory, SKILL_BUNDLE_ENTRY),
          byteLength: Buffer.byteLength(files.source),
          sha256: hash(files.source),
        },
      },
      warning: {
        code: "trusted-local-code-execution",
        trustModel: "trusted-local",
        requiresExplicitConfirmation: true,
        message: "This skill is trusted-local TypeScript and will run with the OS authority of the Agencity process; inspect it and explicitly confirm before installation.",
      },
    });
    expect(bundle.provenance.manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.provenance.source.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("hashes exact manifest and source bytes deterministically", async () => {
    const firstFiles = await writeBundle(directory);
    const first = await parseSkillImportBundle(directory);
    const secondDirectory = await mkdtemp(join(tmpdir(), "agencity-skill-import-digest-"));
    try {
      await writeFile(join(secondDirectory, SKILL_BUNDLE_MANIFEST), firstFiles.manifestText, "utf8");
      await writeFile(join(secondDirectory, SKILL_BUNDLE_ENTRY), firstFiles.source, "utf8");
      const second = await parseSkillImportBundle(secondDirectory);
      expect(second.provenance.manifest.sha256).toBe(first.provenance.manifest.sha256);
      expect(second.provenance.source.sha256).toBe(first.provenance.source.sha256);

      const changedManifest = `${firstFiles.manifestText} `;
      await writeFile(join(secondDirectory, SKILL_BUNDLE_MANIFEST), changedManifest, "utf8");
      const changed = await parseSkillImportBundle(secondDirectory);
      expect(changed.provenance.manifest.sha256).toBe(hash(changedManifest));
      expect(changed.provenance.manifest.sha256).not.toBe(first.provenance.manifest.sha256);
      expect(changed.provenance.source.sha256).toBe(first.provenance.source.sha256);
    } finally {
      await rm(secondDirectory, { recursive: true, force: true });
    }
  });

  test("enforces the caller's exact permission allowlist", async () => {
    await writeBundle(directory, validManifest({ permissions: ["files.read"] }));
    await expect(parseSkillImportBundle(directory)).rejects.toThrow("not in the import allowlist");
    const bundle = await parseSkillImportBundle(directory, { permissionAllowlist: ["files.read"] });
    expect(bundle.definition.permissions).toEqual(["files.read"]);
  });

  test.each([
    ["malformed JSON", "{ nope", "valid JSON"],
    ["array manifest", "[]", "JSON object"],
    ["unsupported schema version", validManifest({ schemaVersion: 2 }), "schemaVersion"],
    ["non-kebab name", validManifest({ name: "Not_Kebab" }), "lower-kebab-case"],
    ["unknown top-level field", validManifest({ package: "example" }), "unknown field"],
    ["remote entry", validManifest({ entry: "https://example.test/skill.ts" }), "exactly skill.ts"],
    ["package entry", validManifest({ entry: "package/skill.ts" }), "exactly skill.ts"],
    ["unknown input schema field", validManifest({ inputSchema: { type: "string", format: "uri" } }), "unknown field"],
    ["unsupported schema type", validManifest({ inputSchema: { type: "function" } }), "not supported"],
    ["empty tests", validManifest({ tests: [] }), "at least one"],
    ["unknown test field", validManifest({ tests: [{ name: "x", input: null, expected: null, command: "echo no" }] }), "unknown field"],
    ["ambiguous test result", validManifest({ tests: [{ name: "x", input: null, expected: null, expectedError: "no" }] }), "exactly one"],
    ["permission wildcard", validManifest({ permissions: ["*"] }), "cannot expand"],
  ])("rejects %s", async (_name, manifest, message) => {
    await writeBundle(directory, manifest);
    await expect(parseSkillImportBundle(directory, { permissionAllowlist: ["*"] })).rejects.toThrow(String(message));
  });

  test("refuses traversal even when the required local source also exists", async () => {
    await writeBundle(directory, validManifest({ entry: "../skill.ts" }));
    await expect(parseSkillImportBundle(directory)).rejects.toThrow("exactly skill.ts");
  });

  test("refuses source and root symlinks", async () => {
    const outside = join(tmpdir(), `agencity-skill-outside-${crypto.randomUUID()}.ts`);
    await writeFile(outside, SOURCE, "utf8");
    await writeFile(join(directory, SKILL_BUNDLE_MANIFEST), JSON.stringify(validManifest()), "utf8");
    await symlink(outside, join(directory, SKILL_BUNDLE_ENTRY));
    try {
      await expect(parseSkillImportBundle(directory)).rejects.toThrow("symbolic links");
      const linkedRoot = `${directory}-link`;
      await symlink(directory, linkedRoot, "dir");
      try {
        await expect(parseSkillImportBundle(linkedRoot)).rejects.toThrow("cannot be a symbolic link");
      } finally {
        await rm(linkedRoot, { force: true });
      }
    } finally {
      await rm(outside, { force: true });
    }
  });

  test.each(["package.json", "postinstall.sh", "asset.txt"])("refuses extra package or asset file %s", async (filename) => {
    await writeBundle(directory);
    await writeFile(join(directory, filename), "not part of the bundle", "utf8");
    await expect(parseSkillImportBundle(directory)).rejects.toThrow("unsupported package, asset, or file");
  });

  test("refuses asset directories", async () => {
    await writeBundle(directory);
    await mkdir(join(directory, "assets"));
    await expect(parseSkillImportBundle(directory)).rejects.toThrow("unsupported package, asset, or file");
  });

  test("refuses remote bundle sources", async () => {
    await expect(parseSkillImportBundle("https://example.test/skill")).rejects.toThrow("Remote skill sources");
    await expect(parseSkillImportBundle("npm:example-skill")).rejects.toThrow("Remote skill sources");
  });

  test("refuses source larger than 512 KiB", async () => {
    await writeBundle(directory, validManifest(), "x".repeat(MAX_SKILL_SOURCE_BYTES + 1));
    await expect(parseSkillImportBundle(directory)).rejects.toThrow(`${MAX_SKILL_SOURCE_BYTES} bytes`);
  });

  test("preserves credential-shaped source text", async () => {
    const source = `const credential = "sk-live-abcdefghijklmnop";\n${SOURCE}`;
    await writeBundle(directory, validManifest(), source);
    expect((await parseSkillImportBundle(directory)).definition.source).toBe(source);
  });

  test("preserves credential-shaped manifest metadata", async () => {
    await writeBundle(directory, validManifest({ description: "-----BEGIN PRIVATE KEY----- do not import" }));
    expect((await parseSkillImportBundle(directory)).definition.description)
      .toBe("-----BEGIN PRIVATE KEY----- do not import");
  });

  test("rejects an explicitly registered value", async () => {
    const release = registerBrokeredSecret("brokered-value-123456");
    try {
      await writeBundle(directory, validManifest(), `const value = "brokered-value-123456";\n${SOURCE}`);
      await expect(parseSkillImportBundle(directory)).rejects.toThrow("registered credential value");
    } finally {
      release();
    }
  });
});

import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  ValidationError,
  assertJsonValue,
  type JsonValue,
  type SkillTestCase,
  type TypeScriptSkillDefinition,
} from "../domain/index.ts";
import { containsBrokeredSecret, containsCredentialMaterial } from "../security/index.ts";

export const SKILL_BUNDLE_MANIFEST = "agencity-skill.json";
export const SKILL_BUNDLE_ENTRY = "skill.ts";
export const MAX_SKILL_SOURCE_BYTES = 512 * 1024;
export const MAX_SKILL_MANIFEST_BYTES = 64 * 1024;

const MAX_PATH_BYTES = 4 * 1024;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 2 * 1024;
const MAX_PERMISSION_LENGTH = 128;
const MAX_PERMISSIONS = 32;
const MAX_TESTS = 64;
const MAX_TEST_NAME_LENGTH = 128;
const MAX_EXPECTED_ERROR_LENGTH = 2 * 1024;
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_PROPERTIES = 128;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOCAL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REMOTE_SOURCE_PATTERN = /^(?:https?|git|ssh|npm):/i;
const FORBIDDEN_PERMISSION_PATTERN = /^(?:admin|root|policy|permission|\*)$/i;

const MANIFEST_FIELDS = new Set([
  "schemaVersion",
  "name",
  "description",
  "entry",
  "runtime",
  "inputSchema",
  "permissions",
  "tests",
]);
const TEST_FIELDS = new Set(["name", "input", "expected", "expectedError"]);
const SCHEMA_FIELDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
]);
const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

export interface SkillImportOptions {
  /** Exact runtime-configured permissions the imported definition may request. */
  readonly permissionAllowlist?: readonly string[];
}

export interface SkillImportFile {
  readonly path: string;
  readonly byteLength: number;
  /** Lowercase SHA-256 of the exact bytes read from disk, without normalization. */
  readonly sha256: string;
}

export interface TrustedLocalSkillWarning {
  readonly code: "trusted-local-code-execution";
  readonly trustModel: "trusted-local";
  readonly requiresExplicitConfirmation: true;
  readonly message: string;
}

/**
 * A deterministic, bounded, read-only projection of a local skill directory.
 * It is suitable as input to a later, separately authorized install command.
 */
export interface SkillImportBundle {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly definition: TypeScriptSkillDefinition;
  readonly provenance: {
    readonly kind: "local-directory";
    readonly directory: string;
    readonly manifest: SkillImportFile;
    readonly source: SkillImportFile;
  };
  readonly warning: TrustedLocalSkillWarning;
}

export const TRUSTED_LOCAL_SKILL_WARNING: TrustedLocalSkillWarning = Object.freeze({
  code: "trusted-local-code-execution",
  trustModel: "trusted-local",
  requiresExplicitConfirmation: true,
  message: "This skill is trusted-local TypeScript and will run with the OS authority of the Agencity process; inspect it and explicitly confirm before installation.",
});

/**
 * Read and validate an Agencity-native local skill bundle without compiling,
 * importing, testing, installing, or otherwise executing its source.
 */
export async function parseSkillImportBundle(
  directory: string,
  options: SkillImportOptions = {},
): Promise<SkillImportBundle> {
  assertLocalDirectoryArgument(directory);
  const requestedDirectory = resolve(directory);
  const requestedInfo = await safeLstat(requestedDirectory, "Skill bundle directory does not exist");
  if (requestedInfo.isSymbolicLink()) throw new ValidationError("Skill bundle directory cannot be a symbolic link");
  if (!requestedInfo.isDirectory()) throw new ValidationError("Skill bundle path must be a directory");

  const root = await safeRealpath(requestedDirectory, "Unable to resolve skill bundle directory");
  assertBoundedPath(root, "Resolved skill bundle directory");
  const rootInfo = await safeStat(root, "Unable to inspect resolved skill bundle directory");
  if (!rootInfo.isDirectory()) throw new ValidationError("Resolved skill bundle path must be a directory");

  const entries = await safeReadDirectory(root);
  const expected = new Set([SKILL_BUNDLE_MANIFEST, SKILL_BUNDLE_ENTRY]);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new ValidationError(`Skill bundle cannot contain symbolic links: ${entry.name}`);
    if (!expected.has(entry.name)) {
      throw new ValidationError(`Skill bundle contains unsupported package, asset, or file: ${entry.name}`);
    }
    if (!entry.isFile()) throw new ValidationError(`Skill bundle entry must be a regular file: ${entry.name}`);
  }
  for (const filename of expected) {
    if (!entries.some((entry) => entry.name === filename)) {
      throw new ValidationError(`Skill bundle is missing required file: ${filename}`);
    }
  }

  const manifestPath = resolveContainedFile(root, SKILL_BUNDLE_MANIFEST);
  const sourcePath = resolveContainedFile(root, SKILL_BUNDLE_ENTRY);
  await assertContainedRegularFile(root, manifestPath, "manifest");
  await assertContainedRegularFile(root, sourcePath, "source");

  const [manifestBytes, sourceBytes] = await Promise.all([
    readBoundedFile(manifestPath, MAX_SKILL_MANIFEST_BYTES, "Skill bundle manifest"),
    readBoundedFile(sourcePath, MAX_SKILL_SOURCE_BYTES, "Skill source"),
  ]);
  const manifestText = decodeUtf8(manifestBytes, "Skill bundle manifest");
  const source = decodeUtf8(sourceBytes, "Skill source");
  const manifest = parseManifest(manifestText);
  const definition = validateManifest(manifest, source, options.permissionAllowlist ?? []);

  rejectCredentialMaterial(manifestText, "Skill bundle manifest");
  rejectCredentialMaterial(source, "Skill source");

  const manifestSha256 = sha256(manifestBytes);
  const sourceSha256 = sha256(sourceBytes);
  if (!SHA256_PATTERN.test(manifestSha256) || !SHA256_PATTERN.test(sourceSha256)) {
    throw new ValidationError("Skill bundle digest calculation did not produce exact SHA-256 values");
  }

  return {
    schemaVersion: 1,
    name: strictString(manifest.name, "Skill name", 1, MAX_NAME_LENGTH),
    definition,
    provenance: {
      kind: "local-directory",
      directory: root,
      manifest: { path: manifestPath, byteLength: manifestBytes.byteLength, sha256: manifestSha256 },
      source: { path: sourcePath, byteLength: sourceBytes.byteLength, sha256: sourceSha256 },
    },
    warning: TRUSTED_LOCAL_SKILL_WARNING,
  };
}

function assertLocalDirectoryArgument(directory: string): void {
  if (typeof directory !== "string" || !directory.trim()) throw new ValidationError("Skill bundle directory is required");
  if (directory !== directory.trim()) throw new ValidationError("Skill bundle directory cannot have surrounding whitespace");
  assertBoundedPath(directory, "Skill bundle directory");
  if (REMOTE_SOURCE_PATTERN.test(directory) || /^[a-z][a-z0-9+.-]*:\/\//i.test(directory)) {
    throw new ValidationError("Remote skill sources are not supported; provide a local directory");
  }
}

function assertBoundedPath(path: string, label: string): void {
  if (new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES) throw new ValidationError(`${label} is too long`);
  if (path.includes("\0")) throw new ValidationError(`${label} cannot contain NUL bytes`);
}

async function safeLstat(path: string, message: string): Promise<Stats> {
  try { return await lstat(path); }
  catch (error) { throw filesystemValidationError(message, error); }
}

async function safeStat(path: string, message: string): Promise<Stats> {
  try { return await stat(path); }
  catch (error) { throw filesystemValidationError(message, error); }
}

async function safeRealpath(path: string, message: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) { throw filesystemValidationError(message, error); }
}

async function safeReadDirectory(path: string): Promise<Dirent[]> {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { throw filesystemValidationError("Unable to read skill bundle directory", error); }
}

function filesystemValidationError(message: string, error: unknown): ValidationError {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "UNKNOWN";
  return new ValidationError(message, { filesystemCode: code });
}

function resolveContainedFile(root: string, filename: string): string {
  if (filename !== SKILL_BUNDLE_MANIFEST && filename !== SKILL_BUNDLE_ENTRY) {
    throw new ValidationError("Skill bundle entry is not an allowed contained filename");
  }
  const resolved = resolve(root, filename);
  assertContained(root, resolved, filename);
  return resolved;
}

async function assertContainedRegularFile(root: string, path: string, label: string): Promise<void> {
  const info = await safeLstat(path, `Unable to inspect skill ${label}`);
  if (info.isSymbolicLink()) throw new ValidationError(`Skill ${label} cannot be a symbolic link`);
  if (!info.isFile()) throw new ValidationError(`Skill ${label} must be a regular file`);
  const canonical = await safeRealpath(path, `Unable to resolve skill ${label}`);
  assertContained(root, canonical, label);
  if (canonical !== path) throw new ValidationError(`Skill ${label} must resolve directly inside the bundle directory`);
}

function assertContained(root: string, child: string, label: string): void {
  const pathFromRoot = relative(root, child);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new ValidationError(`Skill ${label} escapes the bundle directory`);
  }
}

async function readBoundedFile(path: string, maximum: number, label: string): Promise<Uint8Array> {
  const info = await safeStat(path, `Unable to inspect ${label.toLowerCase()}`);
  if (info.size > maximum) throw new ValidationError(`${label} exceeds ${maximum} bytes`);
  let bytes: Uint8Array;
  try { bytes = await readFile(path); }
  catch (error) { throw filesystemValidationError(`Unable to read ${label.toLowerCase()}`, error); }
  if (bytes.byteLength > maximum) throw new ValidationError(`${label} exceeds ${maximum} bytes`);
  return bytes;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ValidationError(`${label} must be valid UTF-8`); }
}

function parseManifest(text: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new ValidationError("Skill bundle manifest must be valid JSON"); }
  if (!isPlainObject(parsed)) throw new ValidationError("Skill bundle manifest must be a JSON object");
  assertNoUnknownFields(parsed, MANIFEST_FIELDS, "Skill bundle manifest");
  return parsed;
}

function validateManifest(
  manifest: Record<string, unknown>,
  source: string,
  permissionAllowlist: readonly string[],
): TypeScriptSkillDefinition {
  if (manifest.schemaVersion !== 1) throw new ValidationError("Skill bundle schemaVersion must be 1");
  const name = strictString(manifest.name, "Skill name", 1, MAX_NAME_LENGTH);
  if (!LOCAL_NAME_PATTERN.test(name)) throw new ValidationError("Skill name must use bounded lower-kebab-case");
  const description = strictString(manifest.description, "Skill description", 1, MAX_DESCRIPTION_LENGTH);
  if (manifest.entry !== SKILL_BUNDLE_ENTRY) {
    throw new ValidationError(`Skill entry must be exactly ${SKILL_BUNDLE_ENTRY}; traversal and alternate assets are not supported`);
  }
  if (manifest.runtime !== "bun") throw new ValidationError("Skill runtime must be bun");
  if (!source.trim()) throw new ValidationError("Skill source cannot be empty");

  const inputSchema = validateInputSchema(manifest.inputSchema, "inputSchema", 0);
  const permissions = validatePermissions(manifest.permissions, permissionAllowlist);
  const tests = validateTests(manifest.tests);

  // This is intentionally a strict superset of the runtime harness skill
  // checks: non-empty description/source, Bun runtime, named tests with an
  // expected value or error, safe permissions, and a supported input schema.
  return { description, source, inputSchema, permissions, tests, runtime: "bun" };
}

function validatePermissions(value: unknown, permissionAllowlist: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) throw new ValidationError("Skill permissions must be an array");
  if (value.length > MAX_PERMISSIONS) throw new ValidationError(`Skill permissions cannot exceed ${MAX_PERMISSIONS} entries`);
  const allowed = new Set<string>();
  for (const permission of permissionAllowlist) {
    allowed.add(strictString(permission, "Permission allowlist entry", 1, MAX_PERMISSION_LENGTH));
  }
  const permissions = value.map((permission) => strictString(permission, "Skill permission", 1, MAX_PERMISSION_LENGTH));
  if (new Set(permissions).size !== permissions.length) throw new ValidationError("Skill permissions must be unique");
  for (const permission of permissions) {
    if (FORBIDDEN_PERMISSION_PATTERN.test(permission)) {
      throw new ValidationError("A skill cannot expand immutable permission or safety policy");
    }
    if (!allowed.has(permission)) throw new ValidationError(`Skill permission is not in the import allowlist: ${permission}`);
  }
  return permissions;
}

function validateTests(value: unknown): readonly SkillTestCase[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError("Imported skills require at least one named runtime test");
  }
  if (value.length > MAX_TESTS) throw new ValidationError(`Skill tests cannot exceed ${MAX_TESTS} entries`);
  const names = new Set<string>();
  return value.map((item, index) => {
    if (!isPlainObject(item)) throw new ValidationError(`Skill test ${index} must be an object`);
    assertNoUnknownFields(item, TEST_FIELDS, `Skill test ${index}`);
    const name = strictString(item.name, `Skill test ${index} name`, 1, MAX_TEST_NAME_LENGTH);
    if (names.has(name)) throw new ValidationError(`Skill test names must be unique: ${name}`);
    names.add(name);
    if (!Object.prototype.hasOwnProperty.call(item, "input")) throw new ValidationError(`Skill test ${name} requires input`);
    assertJsonValue(item.input, `tests[${index}].input`);
    const hasExpected = Object.prototype.hasOwnProperty.call(item, "expected");
    const hasExpectedError = Object.prototype.hasOwnProperty.call(item, "expectedError");
    if (hasExpected === hasExpectedError) {
      throw new ValidationError(`Skill test ${name} requires exactly one of expected or expectedError`);
    }
    if (hasExpected) {
      assertJsonValue(item.expected, `tests[${index}].expected`);
      return { name, input: item.input, expected: item.expected };
    }
    const expectedError = strictString(item.expectedError, `Skill test ${name} expectedError`, 1, MAX_EXPECTED_ERROR_LENGTH);
    return { name, input: item.input, expectedError };
  });
}

function validateInputSchema(value: unknown, path: string, depth: number): JsonValue {
  if (depth > MAX_SCHEMA_DEPTH) throw new ValidationError(`${path} exceeds the supported schema depth`);
  if (!isPlainObject(value)) throw new ValidationError(`${path} must be a JSON Schema object`);
  assertNoUnknownFields(value, SCHEMA_FIELDS, path);
  assertJsonValue(value, path);

  if (value.type !== undefined && (typeof value.type !== "string" || !SCHEMA_TYPES.has(value.type))) {
    throw new ValidationError(`${path}.type is not supported`);
  }
  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || value.required.some((item) => typeof item !== "string" || !item || item.length > MAX_NAME_LENGTH)) {
      throw new ValidationError(`${path}.required must be bounded non-empty string[]`);
    }
    if (new Set(value.required).size !== value.required.length) throw new ValidationError(`${path}.required must be unique`);
  }
  if (value.properties !== undefined) {
    if (!isPlainObject(value.properties)) throw new ValidationError(`${path}.properties must be an object`);
    const properties = Object.entries(value.properties);
    if (properties.length > MAX_SCHEMA_PROPERTIES) throw new ValidationError(`${path}.properties is too large`);
    for (const [key, child] of properties) {
      strictString(key, `${path}.properties key`, 1, MAX_NAME_LENGTH);
      validateInputSchema(child, `${path}.properties.${key}`, depth + 1);
    }
  }
  if (value.items !== undefined) validateInputSchema(value.items, `${path}.items`, depth + 1);
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") {
    throw new ValidationError(`${path}.additionalProperties must be boolean`);
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > MAX_SCHEMA_PROPERTIES) {
      throw new ValidationError(`${path}.enum must be a bounded non-empty array`);
    }
    value.enum.forEach((item, index) => assertJsonValue(item, `${path}.enum[${index}]`));
  }
  validateNonNegativeInteger(value.minLength, `${path}.minLength`);
  validateNonNegativeInteger(value.maxLength, `${path}.maxLength`);
  if (typeof value.minLength === "number" && typeof value.maxLength === "number" && value.minLength > value.maxLength) {
    throw new ValidationError(`${path}.minLength cannot exceed maxLength`);
  }
  if (value.pattern !== undefined) {
    const pattern = strictString(value.pattern, `${path}.pattern`, 1, 1024);
    try { new RegExp(pattern); }
    catch { throw new ValidationError(`${path}.pattern must be a valid regular expression`); }
  }
  validateFiniteNumber(value.minimum, `${path}.minimum`);
  validateFiniteNumber(value.maximum, `${path}.maximum`);
  if (typeof value.minimum === "number" && typeof value.maximum === "number" && value.minimum > value.maximum) {
    throw new ValidationError(`${path}.minimum cannot exceed maximum`);
  }
  return value;
}

function validateNonNegativeInteger(value: unknown, path: string): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
    throw new ValidationError(`${path} must be a non-negative integer`);
  }
}

function validateFiniteNumber(value: unknown, path: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new ValidationError(`${path} must be a finite number`);
  }
}

function strictString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < minimum || value.length > maximum) {
    throw new ValidationError(`${label} must be a trimmed string from ${minimum} to ${maximum} characters`);
  }
  return value;
}

function assertNoUnknownFields(value: Record<string, unknown>, fields: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !fields.has(key));
  if (unknown.length) throw new ValidationError(`${label} has unknown field(s): ${unknown.sort().join(", ")}`);
}

function rejectCredentialMaterial(text: string, label: string): void {
  if (containsCredentialMaterial(text) || containsBrokeredSecret(text)) {
    throw new ValidationError(`${label} contains credential or brokered secret material`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

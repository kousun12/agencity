import { constants } from "node:fs";
import { access, link, lstat, mkdir, open, realpath, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { ValidationError } from "../domain/index.ts";

export interface ResolvedWorkspace {
  readonly root: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly stateDirectory: string;
}

export interface ObservedWorkspace {
  readonly root: string;
  readonly workspaceId: string | null;
  readonly name: string;
  readonly stateDirectory: string;
}

/** Read-only workspace discovery for doctor/status observers. */
export async function observeWorkspace(input: {
  readonly override?: string;
  readonly startDirectory?: string;
  readonly stateDirectory?: string;
} = {}): Promise<ObservedWorkspace> {
  const start = resolve(input.override ?? input.startDirectory ?? process.cwd());
  let canonical: string;
  try {
    if (!(await stat(start)).isDirectory()) throw new ValidationError(`Workspace path is not a directory: ${start}`);
    canonical = await realpath(start);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`Workspace path is unavailable: ${start}`);
  }
  const root = input.override ? canonical : await discoverRoot(canonical);
  const stateDirectory = resolve(input.stateDirectory ?? join(root, ".agencity"));
  const marker = join(root, ".agencity", "workspace-id");
  return { root, workspaceId: await readWorkspaceMarker(marker), name: basename(root) || "workspace", stateDirectory };
}

/**
 * Resolves path aliases and loads the owner-only durable identity marker.
 *
 * A pre-marker workspace database retains its legacy path-derived ID on first
 * open. Once written, the marker moves with `.agencity`, so later repository
 * renames do not change session ownership or profile preference keys.
 */
export async function resolveWorkspace(input: {
  readonly override?: string;
  readonly startDirectory?: string;
  readonly stateDirectory?: string;
  /** Optional non-default database used only to detect a pre-marker workspace. */
  readonly legacyDatabasePath?: string;
} = {}): Promise<ResolvedWorkspace> {
  const start = resolve(input.override ?? input.startDirectory ?? process.cwd());
  let canonical: string;
  try {
    if (!(await stat(start)).isDirectory()) throw new ValidationError(`Workspace path is not a directory: ${start}`);
    canonical = await realpath(start);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`Workspace path is unavailable: ${start}`);
  }
  const root = input.override ? canonical : await discoverRoot(canonical);
  const stateDirectory = resolve(input.stateDirectory ?? join(root, ".agencity"));
  const metadataDirectory = join(root, ".agencity");
  await ensureMetadataDirectory(metadataDirectory);
  const marker = join(metadataDirectory, "workspace-id");
  let workspaceId = await readWorkspaceMarker(marker);
  if (!workspaceId) {
    const legacyDatabases = [
      resolve(input.legacyDatabasePath ?? join(stateDirectory, "agent.db")),
    ];
    const hasLegacyDatabase = (await Promise.all(legacyDatabases.map(exists))).some(Boolean);
    const candidate = hasLegacyDatabase ? legacyPathWorkspaceId(root) : `workspace-${randomBytes(16).toString("hex")}`;
    workspaceId = await createWorkspaceMarker(marker, candidate);
  }
  return {
    root,
    workspaceId,
    name: basename(root) || "workspace",
    stateDirectory,
  };
}

function legacyPathWorkspaceId(root: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(root);
  return `workspace-${hash.digest("hex").slice(0, 24)}`;
}

async function ensureMetadataDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 }).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new ValidationError("Workspace .agencity metadata must be a real directory");
  }
}

async function readWorkspaceMarker(marker: string): Promise<string | null> {
  let file: FileHandle;
  try {
    // Validate and read through one no-follow descriptor. An lstat followed by
    // readFile would let a concurrently replaced symlink bypass validation.
    file = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ValidationError("Workspace identity marker is unavailable");
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ValidationError("Workspace identity marker must be a regular file");
    if ((info.mode & 0o077) !== 0) throw new ValidationError("Workspace identity marker must be owner-only (mode 0600)");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new ValidationError("Workspace identity marker must be owned by the current user");
    }
    if (info.size < 1 || info.size > 160) throw new ValidationError("Workspace identity marker is invalid");
    const raw = await file.readFile({ encoding: "utf8" });
    const workspaceId = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if ((raw !== workspaceId && raw !== `${workspaceId}\n`) || !/^workspace-[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(workspaceId)) {
      throw new ValidationError("Workspace identity marker is invalid");
    }
    return workspaceId;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("Workspace identity marker is unreadable");
  } finally {
    await file.close().catch(() => {});
  }
}

/** Writes a complete temp file, then atomically claims the marker with link(2). */
async function createWorkspaceMarker(marker: string, candidate: string): Promise<string> {
  const temporary = join(dirname(marker), `.workspace-id.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
  await writeFile(temporary, `${candidate}\n`, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, marker).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  } finally {
    await unlink(temporary).catch(() => {});
  }
  const workspaceId = await readWorkspaceMarker(marker);
  if (!workspaceId) throw new ValidationError("Workspace identity marker could not be created");
  return workspaceId;
}

async function discoverRoot(start: string): Promise<string> {
  let directory = start;
  while (true) {
    // Explicit Agencity metadata is at least as authoritative as VCS metadata.
    if (await exists(join(directory, ".agencity")) || await exists(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return start;
    directory = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export function defaultProfilePath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.AGENCITY_PROFILE?.trim()) return resolve(environment.AGENCITY_PROFILE);
  return join(homedir(), ".agencity", "profile.db");
}

export function workspacePreferenceKey(workspaceId: string, preference: "recent" | "model"): string {
  return `workspace:${workspaceId}:${preference}`;
}

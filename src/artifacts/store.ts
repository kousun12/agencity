import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  DependencyFailureError,
  OUTPUT_LIMITS,
  ValidationError,
  type ArtifactReference,
} from "../domain/index.ts";

export interface ArtifactPutOptions { readonly mediaType?: string }
export interface ArtifactStore {
  readonly name: string;
  put(content: Uint8Array | string, options?: ArtifactPutOptions): Promise<ArtifactReference>;
  /** Optional owner-only staging used by bounded streaming producers. */
  createStagingPath?(label: string): Promise<string>;
  putStaged?(path: string, options?: ArtifactPutOptions): Promise<ArtifactReference>;
  cleanupStaging?(): Promise<void>;
  resolve(reference: ArtifactReference): Promise<Uint8Array>;
  verify(reference: ArtifactReference): Promise<boolean>;
  readRange(reference: ArtifactReference, start: number, end: number): Promise<Uint8Array>;
  export(reference: ArtifactReference, destination: string): Promise<void>;
  delete(reference: ArtifactReference): Promise<void>;
}

function sha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

export class LocalArtifactStore implements ArtifactStore {
  readonly name = "local-cas";
  readonly root: string;
  readonly stagingBaseRoot: string;
  readonly stagingRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.stagingBaseRoot = join(this.root, ".staging");
    this.stagingRoot = join(
      this.stagingBaseRoot,
      `${process.pid}-${crypto.randomUUID()}`,
    );
  }

  #path(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new ValidationError("Invalid artifact digest");
    return join(this.root, digest.slice(0, 2), digest.slice(2));
  }

  #validate(reference: ArtifactReference): void {
    if (reference.artifactId !== `sha256:${reference.digest}`) {
      throw new DependencyFailureError("Artifact identity does not match digest", {
        artifactId: reference.artifactId,
        digest: reference.digest,
      });
    }
    if (!Number.isSafeInteger(reference.size) || reference.size < 0) throw new ValidationError("Invalid artifact size");
    this.#path(reference.digest);
  }

  async put(content: Uint8Array | string, options: ArtifactPutOptions = {}): Promise<ArtifactReference> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const digest = sha256(bytes);
    const artifactId = `sha256:${digest}`;
    const target = this.#path(digest);
    await mkdir(dirname(target), { recursive: true });
    try {
      await stat(target);
    } catch {
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      await Bun.write(temporary, bytes);
      try { await rename(temporary, target); }
      finally { await rm(temporary, { force: true }); }
    }
    return {
      artifactId,
      digest,
      mediaType: options.mediaType ?? "application/octet-stream",
      size: bytes.byteLength,
    };
  }

  async cleanupStaging(): Promise<void> {
    await mkdir(this.stagingBaseRoot, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.stagingBaseRoot, { withFileTypes: true }).catch(() => [])) {
      const path = join(this.stagingBaseRoot, entry.name);
      const ownerPid = entry.isDirectory() ? Number(entry.name.split("-", 1)[0]) : Number.NaN;
      if (!entry.isDirectory() || !Number.isSafeInteger(ownerPid) ||
          ownerPid !== process.pid && !processIsAlive(ownerPid)) {
        await rm(path, { recursive: true, force: true });
      }
    }
    await rm(this.stagingRoot, { recursive: true, force: true });
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
  }

  async createStagingPath(label: string): Promise<string> {
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const safe = label.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80) || "spill";
    return join(this.stagingRoot, `${safe}-${crypto.randomUUID()}.stage`);
  }

  async putStaged(path: string, options: ArtifactPutOptions = {}): Promise<ArtifactReference> {
    const staged = resolve(path);
    const rel = staged.startsWith(`${this.stagingRoot}/`);
    if (!rel) throw new ValidationError("Artifact staging path is outside the owner-only staging directory");
    const file = Bun.file(staged);
    if (!await file.exists()) throw new DependencyFailureError("Artifact staging content is missing");
    const hasher = new Bun.CryptoHasher("sha256");
    let size = 0;
    const reader = file.stream().getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        hasher.update(chunk.value);
        size += chunk.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    const digest = hasher.digest("hex");
    const artifactId = `sha256:${digest}`;
    const target = this.#path(digest);
    await mkdir(dirname(target), { recursive: true });
    try {
      await stat(target);
      await rm(staged, { force: true });
    } catch {
      await rename(staged, target);
    }
    return {
      artifactId,
      digest,
      mediaType: options.mediaType ?? "application/octet-stream",
      size,
    };
  }

  async resolve(reference: ArtifactReference): Promise<Uint8Array> {
    this.#validate(reference);
    const file = Bun.file(this.#path(reference.digest));
    if (!await file.exists()) {
      throw new DependencyFailureError("Artifact content is missing", { artifactId: reference.artifactId });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== reference.size || sha256(bytes) !== reference.digest) {
      throw new DependencyFailureError("Artifact integrity check failed", { artifactId: reference.artifactId });
    }
    return bytes;
  }

  async verify(reference: ArtifactReference): Promise<boolean> {
    try { await this.resolve(reference); return true; }
    catch { return false; }
  }

  async readRange(reference: ArtifactReference, start: number, end: number): Promise<Uint8Array> {
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < start) {
      throw new ValidationError("Invalid artifact range");
    }
    this.#validate(reference);
    if (start > reference.size || end > reference.size) throw new ValidationError("Artifact range exceeds immutable content size");
    if (end - start > OUTPUT_LIMITS.artifactRangeBytes) {
      throw new ValidationError(`Artifact range exceeds ${OUTPUT_LIMITS.artifactRangeBytes} bytes`);
    }
    const file = Bun.file(this.#path(reference.digest));
    if (!await file.exists()) {
      throw new DependencyFailureError("Artifact content is missing", { artifactId: reference.artifactId });
    }
    const hasher = new Bun.CryptoHasher("sha256");
    let size = 0;
    const reader = file.stream().getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        hasher.update(chunk.value);
        size += chunk.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    if (size !== reference.size || hasher.digest("hex") !== reference.digest) {
      throw new DependencyFailureError("Artifact integrity check failed", { artifactId: reference.artifactId });
    }
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  async export(reference: ArtifactReference, destination: string): Promise<void> {
    await this.resolve(reference); // verifies before copying
    const target = resolve(destination);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(this.#path(reference.digest), target);
  }

  async delete(reference: ArtifactReference): Promise<void> {
    this.#validate(reference);
    await rm(this.#path(reference.digest), { force: true });
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DependencyFailureError, ValidationError, type ArtifactReference } from "../domain/index.ts";

export interface ArtifactPutOptions { readonly mediaType?: string }
export interface ArtifactStore {
  readonly name: string;
  put(content: Uint8Array | string, options?: ArtifactPutOptions): Promise<ArtifactReference>;
  resolve(reference: ArtifactReference): Promise<Uint8Array>;
  verify(reference: ArtifactReference): Promise<boolean>;
  readRange(reference: ArtifactReference, start: number, end?: number): Promise<Uint8Array>;
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

  constructor(root: string) { this.root = resolve(root); }

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

  async readRange(reference: ArtifactReference, start: number, end?: number): Promise<Uint8Array> {
    if (!Number.isInteger(start) || start < 0 ||
        (end !== undefined && (!Number.isInteger(end) || end < start))) throw new ValidationError("Invalid artifact range");
    const bytes = await this.resolve(reference);
    return bytes.slice(start, end);
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

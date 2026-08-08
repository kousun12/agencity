import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import type { JsonValue } from "../domain/json.ts";
import { ValidationError } from "../domain/index.ts";
import type { EffectExecutor, ExecutionResult } from "./contract.ts";
import { result } from "./contract.ts";

function object(value: JsonValue): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new ValidationError("File input must be an object");
  return value;
}
function digest(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

export class FileExecutor implements EffectExecutor {
  readonly name = "file";
  readonly root: string;

  constructor(root = process.cwd()) { this.root = resolve(root); }

  #path(value: JsonValue | undefined): string {
    if (typeof value !== "string") throw new ValidationError("File operation requires path");
    return resolve(this.root, value);
  }

  async #assertResolvedInside(path: string, parentOnly = false): Promise<void> {
    const root = await realpath(this.root);
    let candidate = parentOnly ? dirname(path) : path;
    while (true) {
      try { candidate = await realpath(candidate); break; }
      catch {
        const next = dirname(candidate);
        if (next === candidate) throw new ValidationError("File path has no accessible parent");
        candidate = next;
      }
    }
    const rel = relative(root, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ValidationError("File path escapes executor root");
    }
  }

  async execute(
    request: Parameters<EffectExecutor["execute"]>[0],
    context: Parameters<EffectExecutor["execute"]>[1],
  ): Promise<ExecutionResult> {
    if (context.signal.aborted) return result("cancelled");
    const input = object(request.input);
    const path = this.#path(input.path);
    try {
      if (request.operation === "read") {
        await this.#assertResolvedInside(path);
        const file = Bun.file(path);
        if (!await file.exists()) return result("failed", undefined, "File does not exist");
        const bytes = new Uint8Array(await file.arrayBuffer());
        return result("succeeded", { content: new TextDecoder().decode(bytes), sha256: digest(bytes), size: bytes.length });
      }
      if (request.operation === "write") {
        if (typeof input.content !== "string") throw new ValidationError("file.write requires string content");
        await this.#assertResolvedInside(path, true);
        const bytes = new TextEncoder().encode(input.content);
        const desiredDigest = digest(bytes);
        const before = Bun.file(path);
        if (await before.exists()) {
          if ((await lstat(path)).isSymbolicLink()) throw new ValidationError("Refusing to overwrite a symbolic link");
          await this.#assertResolvedInside(path);
          const old = new Uint8Array(await before.arrayBuffer());
          // Makes a retry after an ambiguous atomic rename provably idempotent.
          if (digest(old) === desiredDigest) return result("succeeded", { path, sha256: desiredDigest, size: bytes.length, unchanged: true });
          if (typeof input.expectedSha256 === "string" && digest(old) !== input.expectedSha256) {
            return result("failed", undefined, "File precondition failed: digest mismatch");
          }
        } else if (typeof input.expectedSha256 === "string") {
          return result("failed", undefined, "File precondition failed: missing");
        }
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${crypto.randomUUID()}.tmp`;
        await Bun.write(temporary, bytes);
        if (context.signal.aborted) { await rm(temporary, { force: true }); return result("cancelled"); }
        await rename(temporary, path);
        return result("succeeded", { path, sha256: desiredDigest, size: bytes.length });
      }
      if (request.operation === "replace") {
        if (typeof input.old !== "string" || typeof input.new !== "string") {
          throw new ValidationError("file.replace requires old and new");
        }
        await this.#assertResolvedInside(path);
        const file = Bun.file(path);
        if (!await file.exists()) return result("failed", undefined, "File does not exist");
        const text = await file.text();
        const parts = text.split(input.old);
        if (parts.length !== 2) return result("failed", undefined, `Expected exactly one match, found ${parts.length - 1}`);
        const updated = parts.join(input.new);
        const bytes = new TextEncoder().encode(updated);
        const temporary = `${path}.${crypto.randomUUID()}.tmp`;
        await Bun.write(temporary, bytes);
        if (context.signal.aborted) { await rm(temporary, { force: true }); return result("cancelled"); }
        await rename(temporary, path);
        return result("succeeded", { path, sha256: digest(bytes), size: bytes.length });
      }
      if (request.operation === "delete") {
        await this.#assertResolvedInside(path, true);
        const info = await lstat(path).catch(() => null);
        if (info?.isDirectory()) return result("failed", undefined, "Refusing to delete a directory");
        await rm(path, { force: true });
        return result("succeeded", { path });
      }
      return result("failed", undefined, `Unsupported file operation: ${request.operation}`);
    } catch (error) {
      return result(
        context.signal.aborted ? "cancelled" : "failed",
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

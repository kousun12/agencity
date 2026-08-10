import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import {
  BOUNDED_OUTPUT_PROTOCOL,
  OUTPUT_LIMITS,
  ValidationError,
  type JsonValue,
} from "../domain/index.ts";
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
        const startLine = input.startLine === undefined ? 1 : input.startLine;
        const endLine = input.endLine === undefined
          ? Number(startLine) + OUTPUT_LIMITS.filePageLines - 1
          : input.endLine;
        if (!Number.isSafeInteger(startLine) || Number(startLine) < 1 ||
            !Number.isSafeInteger(endLine) || Number(endLine) < Number(startLine)) {
          return result("succeeded", refusedFilePage("File line windows require positive one-based startLine and endLine values."));
        }
        if (Number(endLine) - Number(startLine) + 1 > OUTPUT_LIMITS.filePageLines) {
          return result("succeeded", refusedFilePage(`File pages may contain at most ${OUTPUT_LIMITS.filePageLines} lines.`));
        }
        if (input.expectedSha256 !== undefined && typeof input.expectedSha256 !== "string") {
          return result("failed", undefined, "File continuation expectedSha256 must be a string");
        }
        const before = await lstat(path);
        if (!before.isFile()) return result("failed", undefined, "File read requires a regular file");
        const page = await readTextPage(file, Number(startLine), Number(endLine));
        const after = await lstat(path);
        if (before.dev !== after.dev || before.ino !== after.ino ||
            before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          return result("failed", undefined, "File changed while the requested line window was being read");
        }
        if (typeof input.expectedSha256 === "string" && input.expectedSha256 !== page.sha256) {
          return result("failed", undefined, "File continuation precondition failed: digest mismatch");
        }
        if (page.refusal) return result("succeeded", refusedFilePage(page.refusal));
        const value: JsonValue = {
          content: page.content,
          startLine: page.startLine,
          endLine: page.endLine,
          totalLines: page.totalLines,
          nextLine: page.nextLine,
          sha256: page.sha256,
          size: before.size,
        };
        return result("succeeded", {
          protocol: BOUNDED_OUTPUT_PROTOCOL,
          completeness: "inline",
          byteLength: new TextEncoder().encode(page.content).byteLength,
          value,
        });
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

function refusedFilePage(reason: string): JsonValue {
  return {
    protocol: BOUNDED_OUTPUT_PROTOCOL,
    completeness: "refused",
    byteLength: 0,
    reason,
    guidance: `Request a one-based line window of at most ${OUTPUT_LIMITS.filePageLines} lines, ${OUTPUT_LIMITS.fileLineBytes} bytes per line, and ${OUTPUT_LIMITS.filePageBytes} bytes total.`,
  };
}

interface TextPage {
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly nextLine: number | null;
  readonly sha256: string;
  readonly refusal?: string;
}

async function readTextPage(file: ReturnType<typeof Bun.file>, requestedStart: number, requestedEnd: number): Promise<TextPage> {
  const hasher = new Bun.CryptoHasher("sha256");
  const selected: string[] = [];
  let selectedBytes = 0;
  let lineNumber = 1;
  let lineBytes: number[] = [];
  let lineTooLarge = false;
  let sawAnyByte = false;
  let endedWithNewline = false;
  let refusal: string | undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const finishLine = (): void => {
    if (lineNumber >= requestedStart && lineNumber <= requestedEnd) {
      if (lineTooLarge) {
        refusal ??= `Line ${lineNumber} exceeds the ${OUTPUT_LIMITS.fileLineBytes}-byte line limit.`;
      } else {
        const text = decoder.decode(Uint8Array.from(lineBytes));
        const additional = lineBytes.length + (selected.length > 0 ? 1 : 0);
        if (selectedBytes + additional > OUTPUT_LIMITS.filePageBytes) {
          refusal ??= `Requested page exceeds the ${OUTPUT_LIMITS.filePageBytes}-byte page limit.`;
        } else {
          selected.push(text);
          selectedBytes += additional;
        }
      }
    }
    lineNumber++;
    lineBytes = [];
    lineTooLarge = false;
  };
  const reader = file.stream().getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hasher.update(chunk.value);
      for (const byte of chunk.value) {
        sawAnyByte = true;
        endedWithNewline = byte === 0x0a;
        if (byte === 0x0a) {
          finishLine();
        } else if (lineBytes.length < OUTPUT_LIMITS.fileLineBytes + 1) {
          lineBytes.push(byte);
          if (lineBytes.length > OUTPUT_LIMITS.fileLineBytes) lineTooLarge = true;
        } else {
          lineTooLarge = true;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (sawAnyByte && !endedWithNewline) finishLine();
  const totalLines = sawAnyByte ? lineNumber - 1 : 0;
  const actualStart = requestedStart;
  const actualEnd = Math.min(requestedEnd, totalLines);
  let content = selected.join("\n");
  if (selected.length > 0 && endedWithNewline && actualEnd === totalLines) {
    if (selectedBytes + 1 > OUTPUT_LIMITS.filePageBytes) {
      refusal ??= `Requested page exceeds the ${OUTPUT_LIMITS.filePageBytes}-byte page limit.`;
    } else {
      content += "\n";
    }
  }
  return {
    content,
    startLine: actualStart,
    endLine: Math.max(0, actualEnd),
    totalLines,
    nextLine: actualEnd < totalLines ? actualEnd + 1 : null,
    sha256: hasher.digest("hex"),
    ...(refusal === undefined ? {} : { refusal }),
  };
}

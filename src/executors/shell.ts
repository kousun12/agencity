import { realpath } from "node:fs/promises";
import { open, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ArtifactStore } from "../artifacts/index.ts";
import {
  BOUNDED_OUTPUT_PROTOCOL,
  OUTPUT_LIMITS,
  Utf8HeadTailCapture,
  ValidationError,
  utf8Bytes,
  type JsonValue,
} from "../domain/index.ts";
import { environmentWithoutSecrets, StreamingTextScrubber } from "../security/index.ts";
import type { EffectExecutor, ExecutionResult } from "./contract.ts";
import { result } from "./contract.ts";

function object(input: JsonValue): Record<string, JsonValue> {
  if (input === null || Array.isArray(input) || typeof input !== "object") throw new ValidationError("Shell input must be an object");
  return input;
}

export class ShellExecutor implements EffectExecutor {
  readonly name = "shell";
  readonly defaultCwd: string;

  constructor(defaultCwd = process.cwd(), readonly artifacts?: ArtifactStore) {
    this.defaultCwd = resolve(defaultCwd);
  }

  async execute(
    request: Parameters<EffectExecutor["execute"]>[0],
    context: Parameters<EffectExecutor["execute"]>[1],
  ): Promise<ExecutionResult> {
    if (request.operation !== "run") return result("failed", undefined, `Unsupported shell operation: ${request.operation}`);
    const input = object(request.input);
    const command = input.command;
    if (typeof command !== "string") throw new ValidationError("shell.run requires command");
    const cwd = await this.#cwd(input.cwd);
    if (input.timeoutMs !== undefined && typeof input.timeoutMs !== "number") {
      throw new ValidationError("Shell timeout must be a number");
    }
    const timeout = input.timeoutMs ?? 120_000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3_600_000) throw new ValidationError("Invalid shell timeout");
    if (context.signal.aborted) return result("cancelled", undefined, "Shell command cancelled");

    const child = Bun.spawn(["/bin/sh", "-c", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...environmentWithoutSecrets(), PWD: cwd },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    const abort = () => child.kill();
    context.signal.addEventListener("abort", abort, { once: true });
    const canSpill = Boolean(
      this.artifacts?.createStagingPath &&
      this.artifacts.putStaged,
    );
    let stdoutStage: string | undefined;
    let stderrStage: string | undefined;
    let stagingSetupFailed = false;
    if (canSpill) {
      try {
        stdoutStage = await this.artifacts!.createStagingPath!(`${request.effectId}-stdout`);
        stderrStage = await this.artifacts!.createStagingPath!(`${request.effectId}-stderr`);
      } catch {
        stagingSetupFailed = true;
        await cleanup([stdoutStage, stderrStage]);
        stdoutStage = undefined;
        stderrStage = undefined;
      }
    }
    const spillBudget = { observedBytes: 0, exceeded: false };
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        captureStream(child.stdout, stdoutStage, spillBudget),
        captureStream(child.stderr, stderrStage, spillBudget),
      ]);
      const totalBytes = stdout.byteLength + stderr.byteLength;
      const totalObservedBytes = stdout.observedByteLength + stderr.observedByteLength;
      const inline = stdout.complete !== undefined && stderr.complete !== undefined;
      let output: JsonValue;
      let artifacts: ExecutionResult["artifacts"];
      if (spillBudget.exceeded) {
        output = shellOverflow(
          exitCode,
          stdout,
          stderr,
          totalObservedBytes,
          "spill-limit",
          "Complete output exceeded the 32 MiB spill limit. Re-run a narrower command or redirect focused output to a file.",
        );
        await cleanup([stdoutStage, stderrStage]);
      } else if (inline) {
        output = {
          protocol: BOUNDED_OUTPUT_PROTOCOL,
          completeness: "inline",
          byteLength: totalBytes,
          value: { exitCode, stdout: stdout.complete!, stderr: stderr.complete! },
        };
        await cleanup([stdoutStage, stderrStage]);
      } else if (!canSpill) {
        output = shellOverflow(
          exitCode,
          stdout,
          stderr,
          totalBytes,
          "spill-unavailable",
          "Complete output could not be retained because local artifact staging is unavailable. Re-run a narrower command.",
        );
      } else if (stagingSetupFailed || !stdoutStage || !stderrStage ||
                 stdout.stagingFailed || stderr.stagingFailed) {
        output = shellOverflow(
          exitCode,
          stdout,
          stderr,
          totalBytes,
          "spill-failed",
          "Complete output staging failed. Re-run a narrower command; no complete retained value is available.",
        );
        await cleanup([stdoutStage, stderrStage]);
      } else {
        let combined: string | undefined;
        try {
          combined = await this.artifacts!.createStagingPath!(`${request.effectId}-combined`);
          const stdoutEnd = await concatenateStages(combined, [stdoutStage, stderrStage]);
          const reference = await this.artifacts!.putStaged!(combined, {
            mediaType: "application/vnd.agencity.shell-output.v1",
          });
          output = {
            protocol: BOUNDED_OUTPUT_PROTOCOL,
            completeness: "spilled",
            byteLength: totalBytes,
            preview: shellPreview(exitCode, stdout, stderr),
            artifact: {
              artifactId: reference.artifactId,
              digest: reference.digest,
              mediaType: reference.mediaType,
              size: reference.size,
            },
            layout: {
              stdout: { start: 0, end: stdoutEnd },
              stderr: { start: stdoutEnd, end: totalBytes },
            },
            guidance: "Use artifacts.readRange(artifactId, start, end) with the retained layout to retrieve exact scrubbed stdout or stderr bytes.",
          };
          artifacts = [reference];
        } catch {
          output = shellOverflow(
            exitCode,
            stdout,
            stderr,
            totalBytes,
            "spill-failed",
            "Complete output placement failed. Re-run a narrower command; no complete retained value is available.",
          );
        } finally {
          await cleanup([combined, stdoutStage, stderrStage]);
        }
      }
      if (context.signal.aborted) return result("cancelled", output, "Shell command cancelled", undefined, artifacts);
      if (timedOut) return result("failed", output, `Shell command timed out after ${timeout}ms`, undefined, artifacts);
      return exitCode === 0
        ? result("succeeded", output, undefined, undefined, artifacts)
        : result("failed", output, `Shell command exited ${exitCode}`, undefined, artifacts);
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
      await cleanup([stdoutStage, stderrStage]);
    }
  }

  async #cwd(value: JsonValue | undefined): Promise<string> {
    if (value !== undefined && typeof value !== "string") throw new ValidationError("Shell cwd must be a string");
    const requested = resolve(this.defaultCwd, value ?? ".");
    let root: string;
    let cwd: string;
    try {
      [root, cwd] = await Promise.all([realpath(this.defaultCwd), realpath(requested)]);
    } catch {
      throw new ValidationError("Shell cwd is unavailable");
    }
    const rel = relative(root, cwd);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ValidationError("Shell cwd escapes workspace root");
    }
    return cwd;
  }
}

interface CapturedStream {
  readonly byteLength: number;
  readonly observedByteLength: number;
  readonly head: string;
  readonly tail: string;
  readonly complete?: string;
  readonly stagingFailed: boolean;
}

export function releaseStreamReader(reader: { releaseLock?: () => void }): void {
  const releaseLock = reader.releaseLock;
  if (typeof releaseLock !== "function") return;
  try {
    Reflect.apply(releaseLock, reader, []);
  } catch {
    // Bun child-process pipe readers can expose a releaseLock function whose
    // internal implementation has already been detached after EOF.
  }
}

async function captureStream(
  stream: ReadableStream<Uint8Array>,
  stagingPath?: string,
  spillBudget: { observedBytes: number; exceeded: boolean } = { observedBytes: 0, exceeded: false },
): Promise<CapturedStream> {
  const preview = new Utf8HeadTailCapture(
    OUTPUT_LIMITS.shellPreviewHeadBytes,
    OUTPUT_LIMITS.shellPreviewTailBytes,
  );
  const scrubber = new StreamingTextScrubber();
  let inline = "";
  let inlineAvailable = true;
  let stagingFailed = false;
  let observedByteLength = 0;
  const handle = stagingPath
    ? await open(stagingPath, "wx", 0o600).catch(() => {
        stagingFailed = true;
        return undefined;
      })
    : undefined;
  const retain = async (value: string): Promise<void> => {
    if (!value) return;
    preview.push(value);
    if (inlineAvailable) {
      if (utf8Bytes(inline) + utf8Bytes(value) <= OUTPUT_LIMITS.shellPreviewBytesPerStream) inline += value;
      else {
        inline = "";
        inlineAvailable = false;
      }
    }
    const bytes = new TextEncoder().encode(value);
    if (handle && !stagingFailed && !spillBudget.exceeded) {
      try { await handle.write(bytes); }
      catch { stagingFailed = true; }
    }
  };
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      observedByteLength += chunk.value.byteLength;
      spillBudget.observedBytes += chunk.value.byteLength;
      if (spillBudget.observedBytes > OUTPUT_LIMITS.shellSpillBytes) {
        spillBudget.exceeded = true;
      }
      await retain(scrubber.push(chunk.value));
    }
    await retain(scrubber.finish());
  } finally {
    releaseStreamReader(reader);
    await handle?.close().catch(() => { stagingFailed = true; });
  }
  const value = preview.value();
  return {
    ...value,
    observedByteLength,
    ...(inlineAvailable ? { complete: inline } : {}),
    stagingFailed,
  };
}

function shellPreview(exitCode: number, stdout: CapturedStream, stderr: CapturedStream): JsonValue {
  return {
    exitCode,
    stdout: {
      head: stdout.head,
      tail: stdout.tail,
      byteLength: stdout.observedByteLength,
      retainedByteLength: stdout.byteLength,
    },
    stderr: {
      head: stderr.head,
      tail: stderr.tail,
      byteLength: stderr.observedByteLength,
      retainedByteLength: stderr.byteLength,
    },
  };
}

function shellOverflow(
  exitCode: number,
  stdout: CapturedStream,
  stderr: CapturedStream,
  byteLength: number,
  reason: "spill-unavailable" | "spill-failed" | "spill-limit",
  guidance: string,
): JsonValue {
  return {
    protocol: BOUNDED_OUTPUT_PROTOCOL,
    completeness: "truncated",
    byteLength,
    preview: shellPreview(exitCode, stdout, stderr),
    reason,
    guidance,
  };
}

async function concatenateStages(target: string, sources: readonly string[]): Promise<number> {
  const output = await open(target, "wx", 0o600);
  let offset = 0;
  let firstSize = 0;
  try {
    for (let index = 0; index < sources.length; index++) {
      const reader = Bun.file(sources[index]!).stream().getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          await output.write(chunk.value);
          offset += chunk.value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
      if (index === 0) firstSize = offset;
    }
  } finally {
    await output.close();
  }
  return firstSize;
}

async function cleanup(paths: readonly (string | undefined)[]): Promise<void> {
  await Promise.all(paths.flatMap((path) => path ? [rm(path, { force: true }).catch(() => {})] : []));
}

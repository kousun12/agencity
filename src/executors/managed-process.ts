import { open, mkdir, readFile, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import type { ArtifactStore } from "../artifacts/index.ts";
import {
  BOUNDED_OUTPUT_PROTOCOL,
  OUTPUT_LIMITS,
  Utf8HeadTailCapture,
  ValidationError,
  utf8Bytes,
  type ArtifactReference,
  type JsonValue,
  type NewAgentEvent,
} from "../domain/index.ts";
import type { AgentStorage } from "../storage/index.ts";
import {
  environmentWithoutSecrets,
  StreamingTextScrubber,
} from "../security/index.ts";
import type {
  EffectExecutionContext,
  EffectExecutionRequest,
  EffectExecutor,
  ExecutionResult,
} from "./contract.ts";
import { result } from "./contract.ts";

export const MANAGED_PROCESS_EXECUTOR = "managed-process";
export const MANAGED_PROCESS_TOKEN_ENV = "AGENCITY_MANAGED_PROCESS_TOKEN";
const TERMINATION_GRACE_MS = 1_000;
const PROCESS_MARKER_PREFIX = "agencity-managed-process:";

export interface ManagedProcessExecutorInput {
  readonly processId: string;
  readonly command: string;
  readonly cwd?: string;
  readonly identityToken: string;
}

interface CaptureSnapshot {
  readonly byteLength: number;
  readonly head: string;
  readonly tail: string;
  readonly complete?: string;
}

interface ActiveProcess {
  readonly processId: string;
  readonly effectId: string;
  readonly identityToken: string;
  readonly pid: number;
  readonly processGroupId: number;
  readonly child: ChildProcess;
  readonly stdout: ManagedStreamCapture;
  readonly stderr: ManagedStreamCapture;
  readonly finished: Promise<void>;
  finish(): void;
  cancellationReason: string | null;
}

class ManagedStreamCapture {
  readonly #preview = new Utf8HeadTailCapture(
    OUTPUT_LIMITS.shellPreviewHeadBytes,
    OUTPUT_LIMITS.shellPreviewTailBytes,
  );
  readonly #scrubber = new StreamingTextScrubber();
  #inline = "";
  #inlineAvailable = true;
  #retainedBytes = 0;

  constructor(
    readonly path: string,
    readonly spillBudget: { observedBytes: number; exceeded: boolean },
  ) {}

  async consume(stream: NodeJS.ReadableStream): Promise<void> {
    const handle = await open(this.path, "wx", 0o600);
    try {
      for await (const raw of stream) {
        const bytes = typeof raw === "string"
          ? new TextEncoder().encode(raw)
          : new Uint8Array(raw as Buffer);
        this.spillBudget.observedBytes += bytes.byteLength;
        if (this.spillBudget.observedBytes > OUTPUT_LIMITS.shellSpillBytes) {
          this.spillBudget.exceeded = true;
        }
        await this.#retain(handle, this.#scrubber.push(bytes));
      }
      await this.#retain(handle, this.#scrubber.finish());
    } finally {
      await handle.close();
    }
  }

  async #retain(
    handle: Awaited<ReturnType<typeof open>>,
    value: string,
  ): Promise<void> {
    if (!value) return;
    this.#preview.push(value);
    if (this.#inlineAvailable) {
      if (utf8Bytes(this.#inline) + utf8Bytes(value) <=
          OUTPUT_LIMITS.shellPreviewBytesPerStream) {
        this.#inline += value;
      } else {
        this.#inline = "";
        this.#inlineAvailable = false;
      }
    }
    const bytes = new TextEncoder().encode(value);
    if (!this.spillBudget.exceeded) {
      await handle.write(bytes);
      this.#retainedBytes += bytes.byteLength;
    }
  }

  snapshot(): CaptureSnapshot {
    const preview = this.#preview.value();
    return {
      byteLength: preview.byteLength,
      head: preview.head,
      tail: preview.tail,
      ...(this.#inlineAvailable ? { complete: this.#inline } : {}),
    };
  }

  get retainedBytes(): number {
    return this.#retainedBytes;
  }
}

export class ManagedProcessExecutor implements EffectExecutor {
  readonly name = MANAGED_PROCESS_EXECUTOR;
  readonly defaultCwd: string;
  readonly logRoot: string;
  readonly #active = new Map<string, ActiveProcess>();
  #accepting = true;

  constructor(
    readonly storage: AgentStorage,
    defaultCwd: string,
    logRoot: string,
    readonly artifacts: ArtifactStore,
  ) {
    this.defaultCwd = resolve(defaultCwd);
    this.logRoot = resolve(logRoot);
  }

  get activeCount(): number {
    return this.#active.size;
  }

  stopAdmission(): void {
    this.#accepting = false;
  }

  async execute(
    request: EffectExecutionRequest,
    context: EffectExecutionContext,
  ): Promise<ExecutionResult> {
    if (request.operation !== "start") {
      return result("failed", undefined,
        `Unsupported managed-process operation: ${request.operation}`);
    }
    if (!this.#accepting) {
      return result("cancelled", undefined,
        "Managed process admission is stopped");
    }
    const input = managedProcessInput(request.input);
    const cwd = await resolveWorkspaceCwd(this.defaultCwd, input.cwd);
    await mkdir(this.logRoot, { recursive: true, mode: 0o700 });
    const paths = this.logPaths(input.processId);
    await Promise.all([
      rm(paths.stdout, { force: true }),
      rm(paths.stderr, { force: true }),
    ]);
    const marker = `${PROCESS_MARKER_PREFIX}${input.identityToken}`;
    const wrapper = [
      "trap 'kill -TERM \"$child\" 2>/dev/null' TERM INT",
      "/bin/sh -c \"$1\" &",
      "child=$!",
      "wait \"$child\"",
      "exit $?",
    ].join("\n");
    const child = spawn(
      "/bin/sh",
      ["-c", wrapper, marker, input.command],
      {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...environmentWithoutSecrets(),
          PWD: cwd,
          [MANAGED_PROCESS_TOKEN_ENV]: input.identityToken,
        },
      },
    );
    if (!child.pid) {
      return result("failed", undefined,
        "Managed process spawn did not return a process identity");
    }
    const spillBudget = { observedBytes: 0, exceeded: false };
    let finish!: () => void;
    const finished = new Promise<void>((resolveFinished) => {
      finish = resolveFinished;
    });
    const active: ActiveProcess = {
      processId: input.processId,
      effectId: request.effectId,
      identityToken: input.identityToken,
      pid: child.pid,
      processGroupId: child.pid,
      child,
      stdout: new ManagedStreamCapture(paths.stdout, spillBudget),
      stderr: new ManagedStreamCapture(paths.stderr, spillBudget),
      finished,
      finish,
      cancellationReason: null,
    };
    this.#active.set(input.processId, active);
    const abort = () => {
      active.cancellationReason ??= "Managed process cancelled";
      void this.#terminate(active);
    };
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      await this.storage.appendEvents([{
        sessionId: request.sessionId,
        branchId: request.branchId,
        type: "ManagedProcessStarted",
        producer: "executor",
        idempotencyKey: `managed-process-started:${input.processId}`,
        payload: {
          processId: input.processId,
          effectId: request.effectId,
          identityToken: input.identityToken,
          pid: active.pid,
          processGroupId: active.processGroupId,
          startedAt: new Date().toISOString(),
        },
      } satisfies NewAgentEvent<"ManagedProcessStarted">]);
      const stdoutPromise = active.stdout.consume(child.stdout!);
      const stderrPromise = active.stderr.consume(child.stderr!);
      const exit = await childExit(child);
      await waitForNaturalGroupExit(active.processGroupId, context.signal);
      await Promise.all([stdoutPromise, stderrPromise]);
      const finalized = await this.#finalizeOutput(active, spillBudget.exceeded);
      if (active.cancellationReason || context.signal.aborted) {
        return result(
          "cancelled",
          finalized.output,
          active.cancellationReason ?? "Managed process cancelled",
          undefined,
          finalized.artifacts,
        );
      }
      if (exit.signal) {
        return result(
          "failed",
          finalized.output,
          `Managed process terminated by ${exit.signal}`,
          undefined,
          finalized.artifacts,
        );
      }
      return exit.code === 0
        ? result("succeeded", finalized.output, undefined, undefined,
            finalized.artifacts)
        : result("failed", finalized.output,
            `Managed process exited ${exit.code ?? "without a code"}`,
            undefined, finalized.artifacts);
    } catch (error) {
      const terminationError = await this.#terminate(active).then(
        () => null,
        (failure) => failure,
      );
      const output = await this.recoveryLogs(active.processId);
      await this.removeLogs(active.processId);
      const detail = error instanceof Error ? error.message : String(error);
      const terminationDetail = terminationError === null
        ? ""
        : `; termination also failed: ${
          terminationError instanceof Error
            ? terminationError.message
            : String(terminationError)
        }`;
      return result(
        "unknown",
        output,
        `Managed process execution became uncertain: ${detail}${terminationDetail}`,
      );
    } finally {
      context.signal.removeEventListener("abort", abort);
      this.#active.delete(input.processId);
      active.finish();
    }
  }

  async stop(processId: string, reason = "Managed process stopped"): Promise<boolean> {
    const active = this.#active.get(processId);
    if (!active) return false;
    active.cancellationReason ??= reason;
    await this.#terminate(active);
    return true;
  }

  readActiveLogs(processId: string): JsonValue | null {
    const active = this.#active.get(processId);
    if (!active) return null;
    return liveOutput(active.stdout.snapshot(), active.stderr.snapshot());
  }

  async shutdown(reason = "Managed service shutdown"): Promise<void> {
    this.stopAdmission();
    const active = [...this.#active.values()];
    for (const process of active) {
      process.cancellationReason ??= reason;
    }
    const terminations = await Promise.allSettled(
      active.map((process) => this.#terminate(process)),
    );
    await Promise.race([
      Promise.allSettled(active.map((process) => process.finished)),
      Bun.sleep(2 * TERMINATION_GRACE_MS),
    ]);
    const descendantTerminations = await Promise.allSettled(
      active.map(async (process) => {
        const cleanup = await this.terminateRecovered(
          null,
          process.identityToken,
        );
        if (cleanup.found && !cleanup.terminated) {
          throw new Error(
            `Managed process ${process.processId} retained authenticated descendant groups`,
          );
        }
      }),
    );
    const survivors = active.flatMap((process) =>
      groupsForToken(process.identityToken).map((processGroupId) => ({
        processId: process.processId,
        processGroupId,
      })));
    const failures = [...terminations, ...descendantTerminations].filter(
      (termination) => termination.status === "rejected",
    );
    if (survivors.length || failures.length) {
      throw new Error(
        survivors.length
          ? `Managed process groups survived shutdown: ${
            survivors.map((process) =>
              `${process.processId}:${process.processGroupId}`).join(", ")
          }`
          : `Managed process group termination failed: ${
            failures.map((failure) =>
              failure.status === "rejected"
                ? failure.reason instanceof Error
                  ? failure.reason.message
                  : String(failure.reason)
                : "").join("; ")
          }`,
      );
    }
  }

  logPaths(processId: string): { stdout: string; stderr: string } {
    const safe = processId.replace(/[^A-Za-z0-9_.-]/g, "-");
    return {
      stdout: resolve(this.logRoot, `${safe}.stdout`),
      stderr: resolve(this.logRoot, `${safe}.stderr`),
    };
  }

  async recoveryLogs(processId: string): Promise<JsonValue | undefined> {
    const paths = this.logPaths(processId);
    const [stdout, stderr] = await Promise.all([
      readFile(paths.stdout).catch(() => Buffer.alloc(0)),
      readFile(paths.stderr).catch(() => Buffer.alloc(0)),
    ]);
    if (!stdout.byteLength && !stderr.byteLength) return undefined;
    const stdoutText = stdout.toString("utf8");
    const stderrText = stderr.toString("utf8");
    return {
      protocol: BOUNDED_OUTPUT_PROTOCOL,
      completeness: "truncated",
      byteLength: stdout.byteLength + stderr.byteLength,
      preview: processPreview(
        retainedSnapshot(stdoutText),
        retainedSnapshot(stderrText),
      ),
      reason: "spill-unavailable",
      guidance:
        "Only the scrubbed bytes retained before process-owner loss are available; the complete output is unknown.",
    };
  }

  async removeLogs(processId: string): Promise<void> {
    const paths = this.logPaths(processId);
    await Promise.all([
      rm(paths.stdout, { force: true }),
      rm(paths.stderr, { force: true }),
    ]);
  }

  async terminateRecovered(
    processGroupId: number | null,
    identityToken: string,
  ): Promise<{ found: boolean; terminated: boolean; processGroupIds: number[] }> {
    const candidates = [...new Set([
      ...(processGroupId !== null &&
          groupHasToken(processGroupId, identityToken)
        ? [processGroupId]
        : []),
      ...groupsForToken(identityToken),
    ])];
    for (const group of candidates) {
      await terminateProcessGroup(group);
    }
    return {
      found: candidates.length > 0,
      terminated: candidates.every((group) => !groupExists(group)),
      processGroupIds: candidates,
    };
  }

  async #terminate(active: ActiveProcess): Promise<void> {
    const groups = [...new Set([
      active.processGroupId,
      ...groupsForToken(active.identityToken),
    ])];
    for (const processGroupId of groups) {
      await terminateProcessGroup(processGroupId);
    }
  }

  async #finalizeOutput(
    active: ActiveProcess,
    exceeded: boolean,
  ): Promise<{ output: JsonValue; artifacts?: ArtifactReference[] }> {
    const stdout = active.stdout.snapshot();
    const stderr = active.stderr.snapshot();
    const totalBytes = stdout.byteLength + stderr.byteLength;
    const paths = this.logPaths(active.processId);
    try {
      if (exceeded) {
        return {
          output: {
            protocol: BOUNDED_OUTPUT_PROTOCOL,
            completeness: "truncated",
            byteLength: totalBytes,
            preview: processPreview(stdout, stderr),
            reason: "spill-limit",
            guidance:
              "Complete output exceeded the 32 MiB spill limit. Start a process that writes focused output or use a narrower command.",
          },
        };
      }
      if (stdout.complete !== undefined && stderr.complete !== undefined) {
        return {
          output: {
            protocol: BOUNDED_OUTPUT_PROTOCOL,
            completeness: "inline",
            byteLength: totalBytes,
            value: {
              stdout: stdout.complete,
              stderr: stderr.complete,
            },
          },
        };
      }
      const [stdoutBytes, stderrBytes] = await Promise.all([
        readFile(paths.stdout),
        readFile(paths.stderr),
      ]);
      const combined = Buffer.concat([stdoutBytes, stderrBytes]);
      const reference = await this.artifacts.put(combined, {
        mediaType: "application/vnd.agencity.managed-process-output.v1",
      });
      return {
        output: {
          protocol: BOUNDED_OUTPUT_PROTOCOL,
          completeness: "spilled",
          byteLength: combined.byteLength,
          preview: processPreview(stdout, stderr),
          artifact: {
            artifactId: reference.artifactId,
            digest: reference.digest,
            mediaType: reference.mediaType,
            size: reference.size,
          },
          layout: {
            stdout: { start: 0, end: stdoutBytes.byteLength },
            stderr: {
              start: stdoutBytes.byteLength,
              end: combined.byteLength,
            },
          },
          guidance:
            "Use artifacts.readRange(artifactId, start, end) with the retained layout to retrieve exact scrubbed stdout or stderr bytes.",
        },
        artifacts: [reference],
      };
    } finally {
      await this.removeLogs(active.processId);
    }
  }
}

function managedProcessInput(input: JsonValue): ManagedProcessExecutorInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("Managed process input must be an object");
  }
  const processId = input.processId;
  const command = input.command;
  const cwd = input.cwd;
  const identityToken = input.identityToken;
  if (typeof processId !== "string" || !processId ||
      typeof command !== "string" || !command ||
      cwd !== undefined && typeof cwd !== "string" ||
      typeof identityToken !== "string" ||
      !/^[a-f0-9]{64}$/.test(identityToken)) {
    throw new ValidationError("Managed process input is invalid");
  }
  return {
    processId,
    command,
    ...(cwd === undefined ? {} : { cwd }),
    identityToken,
  };
}

export async function resolveWorkspaceCwd(
  defaultCwd: string,
  value?: string,
): Promise<string> {
  const requested = resolve(defaultCwd, value ?? ".");
  let root: string;
  let cwd: string;
  try {
    [root, cwd] = await Promise.all([realpath(defaultCwd), realpath(requested)]);
  } catch {
    throw new ValidationError("Managed process cwd is unavailable");
  }
  const rel = relative(root, cwd);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ValidationError("Managed process cwd escapes workspace root");
  }
  return cwd;
}

function childExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function processPreview(
  stdout: CaptureSnapshot,
  stderr: CaptureSnapshot,
): JsonValue {
  return {
    stdout: {
      head: stdout.head,
      tail: stdout.tail,
      byteLength: stdout.byteLength,
    },
    stderr: {
      head: stderr.head,
      tail: stderr.tail,
      byteLength: stderr.byteLength,
    },
  };
}

function liveOutput(
  stdout: CaptureSnapshot,
  stderr: CaptureSnapshot,
): JsonValue {
  const byteLength = stdout.byteLength + stderr.byteLength;
  if (stdout.complete !== undefined && stderr.complete !== undefined) {
    return {
      protocol: BOUNDED_OUTPUT_PROTOCOL,
      completeness: "inline",
      byteLength,
      value: { stdout: stdout.complete, stderr: stderr.complete },
    };
  }
  return {
    protocol: BOUNDED_OUTPUT_PROTOCOL,
    completeness: "truncated",
    byteLength,
    preview: processPreview(stdout, stderr),
    reason: "spill-unavailable",
    guidance:
      "The process is still running. Exact complete output will be retained at its terminal boundary.",
  };
}

function retainedSnapshot(value: string): CaptureSnapshot {
  const preview = new Utf8HeadTailCapture(
    OUTPUT_LIMITS.shellPreviewHeadBytes,
    OUTPUT_LIMITS.shellPreviewTailBytes,
  );
  preview.push(value);
  return preview.value();
}

function groupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function terminateProcessGroup(processGroupId: number): Promise<void> {
  if (!groupExists(processGroupId)) return;
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (await waitForGroupExit(processGroupId, TERMINATION_GRACE_MS)) return;
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (!await waitForGroupExit(processGroupId, TERMINATION_GRACE_MS)) {
    throw new Error(
      `Managed process group ${processGroupId} survived SIGKILL`,
    );
  }
}

async function waitForGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupExists(processGroupId)) return true;
    await Bun.sleep(20);
  }
  return !groupExists(processGroupId);
}

async function waitForNaturalGroupExit(
  processGroupId: number,
  signal: AbortSignal,
): Promise<void> {
  while (groupExists(processGroupId)) {
    if (signal.aborted) {
      await terminateProcessGroup(processGroupId);
      return;
    }
    await Bun.sleep(20);
  }
}

function processRows(): Array<{
  pid: number;
  processGroupId: number;
  command: string;
}> {
  const ps = Bun.spawnSync([
    "ps",
    "-axo",
    "pid=,pgid=,command=",
  ]);
  if (ps.exitCode !== 0) return [];
  return ps.stdout.toString().split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      processGroupId: Number(match[2]),
      command: match[3]!,
    }];
  });
}

function groupHasToken(processGroupId: number, identityToken: string): boolean {
  const marker = `${PROCESS_MARKER_PREFIX}${identityToken}`;
  const rows = processRows().filter((row) =>
    row.processGroupId === processGroupId);
  return rows.some((row) => row.command.includes(marker)) ||
    rows.some((row) => processEnvironmentHasToken(row.pid, identityToken));
}

function groupsForToken(identityToken: string): number[] {
  const marker = `${PROCESS_MARKER_PREFIX}${identityToken}`;
  const rows = processRows();
  const marked = rows.filter((row) => row.command.includes(marker));
  if (marked.length) {
    return [...new Set(marked.map((row) => row.processGroupId))];
  }
  return [...new Set(rows.flatMap((row) =>
    processEnvironmentHasToken(row.pid, identityToken)
      ? [row.processGroupId]
      : []
  ))];
}

function processEnvironmentHasToken(
  pid: number,
  identityToken: string,
): boolean {
  const ps = Bun.spawnSync([
    "ps",
    "eww",
    "-p",
    String(pid),
    "-o",
    "command=",
  ]);
  if (ps.exitCode !== 0) return false;
  return ps.stdout.toString().includes(
    `${MANAGED_PROCESS_TOKEN_ENV}=${identityToken}`,
  );
}

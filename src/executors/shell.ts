import { isAbsolute, relative, resolve } from "node:path";
import type { JsonValue } from "../domain/json.ts";
import { ValidationError } from "../domain/index.ts";
import { environmentWithoutSecrets, scrubText } from "../security/index.ts";
import type { EffectExecutor, ExecutionResult } from "./contract.ts";
import { result } from "./contract.ts";

function object(input: JsonValue): Record<string, JsonValue> {
  if (input === null || Array.isArray(input) || typeof input !== "object") throw new ValidationError("Shell input must be an object");
  return input;
}

export class ShellExecutor implements EffectExecutor {
  readonly name = "shell";
  readonly defaultCwd: string;

  constructor(defaultCwd = process.cwd(), readonly maxOutputBytes = 1024 * 1024) {
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
    const cwd = this.#cwd(input.cwd);
    const timeout = typeof input.timeoutMs === "number" ? input.timeoutMs : 120_000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3_600_000) throw new ValidationError("Invalid shell timeout");
    if (context.signal.aborted) return result("cancelled", undefined, "Shell command cancelled");

    const child = Bun.spawn(["/bin/sh", "-c", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: environmentWithoutSecrets(),
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    const abort = () => child.kill();
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).arrayBuffer(),
      ]);
      const decode = (bytes: ArrayBuffer) => scrubText(new TextDecoder().decode(bytes.slice(0, this.maxOutputBytes)));
      const output: JsonValue = {
        exitCode,
        stdout: decode(stdout),
        stderr: decode(stderr),
        truncated: stdout.byteLength > this.maxOutputBytes || stderr.byteLength > this.maxOutputBytes,
      };
      if (context.signal.aborted) return result("cancelled", output, "Shell command cancelled");
      if (timedOut) return result("failed", output, `Shell command timed out after ${timeout}ms`);
      return exitCode === 0 ? result("succeeded", output) : result("failed", output, `Shell command exited ${exitCode}`);
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
    }
  }

  #cwd(value: JsonValue | undefined): string {
    if (value !== undefined && typeof value !== "string") throw new ValidationError("Shell cwd must be a string");
    const cwd = resolve(this.defaultCwd, value ?? ".");
    const rel = relative(this.defaultCwd, cwd);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new ValidationError("Shell cwd escapes workspace root");
    return cwd;
  }
}

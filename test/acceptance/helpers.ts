import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const checkout = resolve(new URL("../..", import.meta.url).pathname);

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunningCommand {
  readonly child: ReturnType<typeof Bun.spawn>;
  collect(): Promise<CommandResult>;
}

export class AcceptanceWorld {
  readonly binary: string;
  private constructor(
    readonly directory: string,
    readonly home: string,
    readonly repository: string,
    private readonly baseEnvironment: Readonly<Record<string, string>>,
  ) {
    this.binary = join(home, ".bun", "bin", "agencity");
  }

  static async create(label: string, baseEnvironment: Readonly<Record<string, string>> = {}): Promise<AcceptanceWorld> {
    const directory = await mkdtemp(join(tmpdir(), `agencity-acceptance-${label}-`));
    const home = join(directory, "home");
    const repository = join(directory, "repository");
    await mkdir(home, { recursive: true });
    await mkdir(join(repository, ".git"), { recursive: true });
    const world = new AcceptanceWorld(directory, home, repository, baseEnvironment);
    const linked = await world.spawn(["bun", "link"], checkout, {});
    if (linked.code !== 0) {
      await rm(directory, { recursive: true, force: true });
      throw new Error(`isolated bun link failed: ${linked.stderr || linked.stdout}`);
    }
    if (!(await Bun.file(world.binary).exists())) {
      await rm(directory, { recursive: true, force: true });
      throw new Error("isolated bun link did not expose agencity");
    }
    return world;
  }

  command(args: readonly string[], extraEnvironment: Readonly<Record<string, string>> = {}): Promise<CommandResult> {
    return this.spawn([this.binary, ...args], this.repository, extraEnvironment);
  }

  async commandWithInput(args: readonly string[], input: string, extraEnvironment: Readonly<Record<string, string>> = {}): Promise<CommandResult> {
    const command = [this.binary, ...args];
    const child = Bun.spawn(command, {
      cwd: this.repository,
      env: this.environment(extraEnvironment),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(input);
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    // #region agent log
    appendFileSync("/opt/cursor/logs/debug.log", `${JSON.stringify({ hypothesisId: "E", location: "test/acceptance/helpers.ts:spawn", message: "acceptance child output collected", data: { command: command.slice(-4), code, stdoutBytes: Buffer.byteLength(stdout), stdoutSuffix: stdout.slice(-16), stderrBytes: Buffer.byteLength(stderr) }, timestamp: Date.now() })}\n`);
    // #endregion
    return { code, stdout, stderr };
  }

  start(args: readonly string[], extraEnvironment: Readonly<Record<string, string>> = {}): RunningCommand {
    const child = Bun.spawn([this.binary, ...args], {
      cwd: this.repository,
      env: this.environment(extraEnvironment),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      child,
      async collect() {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { code, stdout, stderr };
      },
    };
  }

  async dispose(extraEnvironment: Readonly<Record<string, string>> = {}): Promise<void> {
    await this.command(["service", "shutdown", "--json"], extraEnvironment).catch(() => undefined);
    await rm(this.directory, { recursive: true, force: true });
  }

  private async spawn(command: readonly string[], cwd: string, extraEnvironment: Readonly<Record<string, string>>): Promise<CommandResult> {
    const child = Bun.spawn([...command], {
      cwd,
      env: this.environment(extraEnvironment),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    // #region agent log
    appendFileSync("/opt/cursor/logs/debug.log", `${JSON.stringify({ hypothesisId: "F", location: "test/acceptance/helpers.ts:spawn", message: "acceptance command output collected", data: { command: command.slice(-4), code, stdoutBytes: Buffer.byteLength(stdout), stdoutSuffix: stdout.slice(-16), stderrBytes: Buffer.byteLength(stderr) }, timestamp: Date.now() })}\n`);
    // #endregion
    return { code, stdout, stderr };
  }

  private environment(extra: Readonly<Record<string, string>>): Record<string, string> {
    const clean = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "AGENCITY_PROFILE", "AGENCITY_ACCEPTANCE", "AGENCITY_ACCEPTANCE_FAILPOINT", "AGENCITY_ACCEPTANCE_MAX_RUN_STEPS", "AGENCITY_ACCEPTANCE_LEASE_MS"]) delete clean[key];
    return {
      ...clean,
      HOME: this.home,
      BUN_INSTALL: join(this.home, ".bun"),
      PATH: `${join(this.home, ".bun", "bin")}:${clean.PATH ?? ""}`,
      ...this.baseEnvironment,
      ...extra,
    };
  }
}

export async function eventually<T>(operation: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined) return value;
    } catch (error) { lastError = error; }
    await Bun.sleep(50);
  }
  throw lastError ?? new Error(`condition was not met within ${timeoutMs}ms`);
}

export function parseSingleJson(result: CommandResult): any {
  const text = result.stdout.trim() || result.stderr.trim();
  const lines = text.split("\n").filter(Boolean);
  if (lines.length !== 1) throw new Error(`expected one JSON line, received ${lines.length}: ${text}`);
  return JSON.parse(lines[0]!);
}

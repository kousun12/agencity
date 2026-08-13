import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StrictActionFixture } from "../acceptance/strict-action-fixture.ts";

const root = resolve(new URL("../..", import.meta.url).pathname);
const python = Bun.which("python3");
const worlds: TestWorld[] = [];

interface TestWorld {
  readonly directory: string;
  readonly workspace: string;
  readonly home: string;
  readonly fixture: StrictActionFixture;
  readonly environment: Record<string, string>;
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface PtyResult {
  readonly providerPrompt: boolean;
  readonly authenticatedStatus: boolean;
  readonly unauthenticatedStatus: boolean;
  readonly keyPrompt: boolean;
  readonly catalogReady: boolean;
  readonly manualRow: boolean;
  readonly ready: boolean;
  readonly exitCode: number | null;
  readonly preConfirmationConfig: unknown;
  readonly preConfirmationSessions: unknown;
  readonly servicePid: number | null;
  readonly serviceKilled: boolean;
  readonly pickerOutputBase64: string;
  readonly outputTail: string;
}

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await command(world, ["service", "shutdown", "--json"], 5_000).catch(
      () => undefined,
    );
    world.fixture.close();
    await rm(world.directory, { recursive: true, force: true });
  }
});

async function createWorld(
  catalogMode: NonNullable<
    NonNullable<
      ConstructorParameters<typeof StrictActionFixture>[0]
    >["catalogMode"]
  >,
  credentialMode: "missing" | "openai-environment" = "missing",
): Promise<TestWorld> {
  const directory = await mkdtemp(
    join(tmpdir(), "agencity-first-run-picker-pty-"),
  );
  const workspace = join(directory, "workspace");
  const home = join(directory, "home");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(home, { recursive: true });
  const fixture = new StrictActionFixture({ catalogMode });
  const {
    OPENAI_API_KEY: _openaiKey,
    OPENAI_MODEL: _openaiModel,
    ANTHROPIC_API_KEY: _anthropicKey,
    ANTHROPIC_MODEL: _anthropicModel,
    AI_GATEWAY_API_KEY: _gatewayKey,
    AI_GATEWAY_MODEL: _gatewayModel,
    VERCEL_MODEL: _vercelModel,
    AGENCITY_PROFILE: _profile,
    ...clean
  } = process.env;
  const environment = {
    ...Object.fromEntries(
      Object.entries(clean).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    HOME: home,
    ...(credentialMode === "openai-environment"
      ? fixture.environment()
      : fixture.firstRunEnvironment()),
  };
  const world = { directory, workspace, home, fixture, environment };
  worlds.push(world);
  return world;
}

async function command(
  world: TestWorld,
  args: readonly string[],
  timeoutMs = 10_000,
): Promise<CommandResult> {
  const child = Bun.spawn(
    [process.execPath, join(root, "src/cli.ts"), ...args],
    {
      cwd: root,
      env: world.environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

async function runPty(
  world: TestWorld,
  scenario:
    | "unavailable"
    | "hostile"
    | "cancel"
    | "cancel-provider"
    | "cancel-credential"
    | "service-loss"
    | "authenticated-default"
    | "authenticate-new",
  columns: number,
  controlPath = "",
): Promise<PtyResult> {
  const driver = String.raw`
import base64, fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time

root, workspace, scenario, columns_text, control_path = sys.argv[1:]
columns = int(columns_text)
cli = os.path.join(root, "src", "cli.ts")
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root)
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 30, columns, 0, 0))
    os.execvp("bun", ["bun", cli, "new", "--workspace", workspace])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, columns, 0, 0))
os.set_blocking(fd, False)
output = bytearray()

def pump(seconds, needle=None, start=0):
    deadline = time.time() + seconds
    target = needle.encode() if needle else None
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
        if target and target in output[start:]:
            return True
    return target is None or target in output[start:]

def wait_exit(seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            return os.waitstatus_to_exitcode(status)
        time.sleep(0.05)
    return None

def public_json(args):
    result = subprocess.run(
        ["bun", cli, *args, "--workspace", workspace, "--json"],
        cwd=root,
        env=os.environ.copy(),
        capture_output=True,
        timeout=10,
    )
    if result.returncode != 0:
        return {"commandError": result.stderr.decode("utf-8", "replace")[-500:]}
    return json.loads(result.stdout)

def owned_service_pid():
    manifest_path = os.path.join(workspace, ".agencity", "service", "manifest.json")
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            with open(manifest_path, "r", encoding="utf-8") as handle:
                value = json.load(handle)
            candidate = value.get("pidHint")
            if isinstance(candidate, int) and candidate > 0:
                return candidate
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass
        time.sleep(0.05)
    return None

provider_prompt = pump(10, "Choose a provider")
if provider_prompt:
    if scenario == "cancel-provider":
        os.write(fd, b"\x1b")
    elif scenario == "authenticated-default":
        os.write(fd, b"\r")
    elif scenario == "authenticate-new":
        os.write(fd, b"vercel\r")
    else:
        os.write(fd, b"openai\r")
authenticated_status = b"environment credential" in output or b"stored credential" in output
unauthenticated_status = b"not authenticated" in output
key_label = "API key for Vercel AI Gateway" if scenario == "authenticate-new" else "API key for OpenAI"
key_prompt = False if scenario == "authenticated-default" or scenario == "cancel-provider" else pump(5, key_label)
if key_prompt:
    if scenario == "cancel-credential":
        os.write(fd, b"\x1b")
    else:
        os.write(fd, b"acceptance-fixture-key\r")

catalog_ready = False
manual_row = False
ready = False
pre_config = None
pre_sessions = None
service_pid = None
service_killed = False
picker_start = len(output)
picker_end = picker_start

if scenario == "cancel-provider" or scenario == "cancel-credential":
    pass
elif scenario == "unavailable":
    catalog_ready = pump(10, "Catalog unavailable", picker_start)
    if catalog_ready:
        pre_config = public_json(["config"])
        pre_sessions = public_json(["sessions"])
        model_mark = len(output)
        os.write(fd, b"openai/private-preview-v1")
        manual_row = pump(5, "not listed in catalog", model_mark)
        picker_end = len(output)
        if manual_row:
            os.write(fd, b"\r")
            ready = pump(10, "Ask Agencity", picker_end)
elif scenario == "hostile":
    catalog_ready = pump(10, "Scarlet", picker_start)
    query_mark = len(output)
    if catalog_ready:
        os.write(fd, b"scarlet")
        manual_row = pump(5, "openai/fixture-v1", query_mark)
    picker_end = len(output)
    if manual_row:
        os.write(fd, b"\r")
        ready = pump(10, "Ask Agencity", picker_end)
elif scenario == "cancel":
    catalog_ready = pump(10, "Scarlet", picker_start)
    picker_end = len(output)
    if catalog_ready:
        os.write(fd, b"\x1b")
elif scenario == "authenticated-default" or scenario == "authenticate-new":
    catalog_ready = pump(10, "Fixture Reasoner", picker_start)
    picker_end = len(output)
    if catalog_ready:
        pre_config = public_json(["config"])
        pre_sessions = public_json(["sessions"])
        os.write(fd, b"reasoner\r")
        ready = pump(10, "Ask Agencity", picker_end)
else:
    catalog_ready = pump(10, "Loading configured model catalog", picker_start)
    picker_end = len(output)
    if catalog_ready:
        with open(control_path + ".ready", "w", encoding="utf-8") as handle:
            handle.write("ready\n")
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                with open(control_path, "r", encoding="utf-8") as handle:
                    if handle.read().strip() == "kill":
                        break
            except FileNotFoundError:
                pass
            time.sleep(0.05)
        service_pid = owned_service_pid()
        if service_pid is not None:
            try:
                os.kill(service_pid, signal.SIGKILL)
                service_killed = True
            except ProcessLookupError:
                pass
        if service_killed:
            pump(2, "Catalog unavailable", picker_end)
            os.write(fd, b"\x1b")

if scenario != "service-loss" and ready:
    os.write(fd, b"/quit\r")
    pump(5, "workspace service will stop automatically")

exit_code = wait_exit(10)
if exit_code is None:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    exit_code = wait_exit(2)
if exit_code is None:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    done, status = os.waitpid(pid, 0)
    exit_code = os.waitstatus_to_exitcode(status)
try:
    os.close(fd)
except OSError:
    pass

print(json.dumps({
    "providerPrompt": provider_prompt,
    "authenticatedStatus": authenticated_status,
    "unauthenticatedStatus": unauthenticated_status,
    "keyPrompt": key_prompt,
    "catalogReady": catalog_ready,
    "manualRow": manual_row,
    "ready": ready,
    "exitCode": exit_code,
    "preConfirmationConfig": pre_config,
    "preConfirmationSessions": pre_sessions,
    "servicePid": service_pid,
    "serviceKilled": service_killed,
    "pickerOutputBase64": base64.b64encode(bytes(output[picker_start:picker_end])).decode("ascii"),
    "outputTail": output.decode("utf-8", "replace")[-1600:],
}))
`;
  const child = Bun.spawn(
    [
      python!,
      "-c",
      driver,
      root,
      world.workspace,
      scenario,
      String(columns),
      controlPath,
    ],
    {
      cwd: root,
      env: world.environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 25_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout) as PtyResult;
  } finally {
    clearTimeout(timeout);
  }
}

async function configAndSessions(world: TestWorld): Promise<{
  readonly config: { readonly defaultModel: string | null };
  readonly sessions: Array<{
    readonly model: {
      readonly provider: string;
      readonly model: string;
      readonly reasoningEffort: string;
    };
  }>;
}> {
  const configured = await command(world, [
    "config",
    "--workspace",
    world.workspace,
    "--json",
  ]);
  expect(configured.code, configured.stderr).toBe(0);
  const sessions = await command(world, [
    "sessions",
    "--workspace",
    world.workspace,
    "--json",
  ]);
  expect(sessions.code, sessions.stderr).toBe(0);
  return {
    config: JSON.parse(configured.stdout),
    sessions: JSON.parse(sessions.stdout),
  };
}

test.skipIf(!python || process.platform === "win32")(
  "defaults to the authenticated provider and still requires interactive model confirmation",
  async () => {
    const world = await createWorld("normal", "openai-environment");
    const result = await runPty(world, "authenticated-default", 100);
    expect(result, result.outputTail).toMatchObject({
      providerPrompt: true,
      authenticatedStatus: true,
      unauthenticatedStatus: true,
      keyPrompt: false,
      catalogReady: true,
      ready: true,
      exitCode: 0,
      preConfirmationConfig: expect.objectContaining({ defaultModel: null }),
      preConfirmationSessions: [],
    });

    const durable = await configAndSessions(world);
    expect(durable.config.defaultModel).toBe("openai:openai/fixture-v1");
    expect(durable.sessions).toHaveLength(1);
    expect(durable.sessions[0]?.model).toMatchObject({
      provider: "openai",
      model: "openai/fixture-v1",
    });
  },
  30_000,
);

test.skipIf(!python || process.platform === "win32")(
  "authenticates a newly selected provider before its filtered model picker",
  async () => {
    const world = await createWorld("normal", "openai-environment");
    const result = await runPty(world, "authenticate-new", 100);
    expect(result, result.outputTail).toMatchObject({
      providerPrompt: true,
      authenticatedStatus: true,
      unauthenticatedStatus: true,
      keyPrompt: true,
      catalogReady: true,
      ready: true,
      exitCode: 0,
      preConfirmationConfig: expect.objectContaining({ defaultModel: null }),
      preConfirmationSessions: [],
    });

    const durable = await configAndSessions(world);
    expect(durable.config.defaultModel).toBe("vercel:openai/fixture-v1");
    expect(durable.sessions).toHaveLength(1);
    expect(durable.sessions[0]?.model).toMatchObject({
      provider: "vercel",
      model: "openai/fixture-v1",
    });
    const doctor = await command(world, [
      "doctor",
      "--workspace",
      world.workspace,
      "--json",
    ]);
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout).providers).toContainEqual(
      expect.objectContaining({
        provider: "vercel",
        usable: true,
        credentialSource: "stored",
      }),
    );
  },
  30_000,
);

test.skipIf(!python || process.platform === "win32")(
  "selects an exact manual model when the configured catalog is unavailable without creating a placeholder root",
  async () => {
    const world = await createWorld("unavailable");
    const result = await runPty(world, "unavailable", 80);
    expect(result, result.outputTail).toMatchObject({
      providerPrompt: true,
      keyPrompt: true,
      catalogReady: true,
      manualRow: true,
      ready: true,
      exitCode: 0,
      preConfirmationConfig: expect.objectContaining({ defaultModel: null }),
      preConfirmationSessions: [],
    });
    const pickerOutput = Buffer.from(
      result.pickerOutputBase64,
      "base64",
    ).toString("utf8");
    expect(pickerOutput).toContain("Catalog unavailable");
    expect(pickerOutput).toContain("not listed in catalog");
    expect(pickerOutput).not.toMatch(
      /catalog\s+(?:verified|confirmed)|(?:verified|confirmed)\s+by\s+(?:the\s+)?catalog/i,
    );
    expect(world.fixture.catalogRequests.length).toBeGreaterThan(0);
    expect(
      world.fixture.catalogRequests.every(
        (request) => request.authorization === null,
      ),
    ).toBeTrue();

    const durable = await configAndSessions(world);
    expect(durable.config.defaultModel).toBe(
      "openai:openai/private-preview-v1",
    );
    expect(durable.sessions).toHaveLength(1);
    expect(durable.sessions[0]?.model).toEqual({
      provider: "openai",
      model: "openai/private-preview-v1",
      reasoningEffort: "provider-default",
    });
  },
  30_000,
);

test.skipIf(!python || process.platform === "win32")(
  "sanitizes hostile catalog labels within terminal width and persists the canonical model ID",
  async () => {
    const columns = 42;
    const world = await createWorld("hostile");
    const result = await runPty(world, "hostile", columns);
    expect(result, result.outputTail).toMatchObject({
      providerPrompt: true,
      keyPrompt: true,
      catalogReady: true,
      manualRow: true,
      ready: true,
      exitCode: 0,
    });
    expect(world.fixture.catalogRequests.length).toBeGreaterThan(0);
    expect(
      world.fixture.catalogRequests.every(
        (request) => request.authorization === null,
      ),
    ).toBeTrue();

    const pickerOutput = Buffer.from(
      result.pickerOutputBase64,
      "base64",
    ).toString("utf8");
    expect(pickerOutput).not.toContain("\u001b[31m");
    expect(pickerOutput).not.toContain("\u001b[2J");
    expect(pickerOutput).not.toMatch(/[\u202e\u2066\u2069]/u);
    expect(pickerOutput).not.toMatch(
      /Fixture\r?\n\u001b\[2K\r[^\n]*Scarlet/u,
    );
    expect(pickerOutput).not.toMatch(
      /Mini\r?\n\u001b\[2K\r[^\n]*catalog/u,
    );
    expect(pickerOutput).toMatch(/[模型界試験]/u);
    const emittedLines = pickerOutput.split("\u001b[2K\r").slice(1).map(
      (write) =>
        (write.split("\n")[0] ?? "")
          .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
          .replace(/\r/g, ""),
    );
    expect(emittedLines.length).toBeGreaterThan(1);
    for (const line of emittedLines) {
      expect(Bun.stringWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(
        columns,
      );
    }

    const durable = await configAndSessions(world);
    expect(durable.config.defaultModel).toBe("openai:openai/fixture-v1");
    expect(durable.sessions).toHaveLength(1);
    expect(durable.sessions[0]?.model.model).toBe("openai/fixture-v1");
    expect(JSON.stringify(durable)).not.toContain("Scarlet");
    expect(JSON.stringify(durable)).not.toContain("override");
  },
  30_000,
);

test.skipIf(!python || process.platform === "win32")(
  "exits cleanly when provider or credential selection is cancelled",
  async () => {
    for (const scenario of ["cancel-provider", "cancel-credential"] as const) {
      const world = await createWorld("normal");
      const result = await runPty(world, scenario, 80);
      expect(result, result.outputTail).toMatchObject({
        providerPrompt: true,
        keyPrompt: scenario === "cancel-credential",
        catalogReady: false,
        ready: false,
        exitCode: 0,
      });
      expect(result.outputTail).not.toContain("Agencity error");
      expect(result.outputTail).not.toContain("was cancelled");

      const durable = await configAndSessions(world);
      expect(durable.config.defaultModel).toBeNull();
      expect(durable.sessions).toEqual([]);
    }
  },
  30_000,
);

test.skipIf(!python || process.platform === "win32")(
  "exits cleanly when first-run model selection is cancelled",
  async () => {
    const world = await createWorld("hostile");
    const result = await runPty(world, "cancel", 80);
    expect(result, result.outputTail).toMatchObject({
      providerPrompt: true,
      keyPrompt: true,
      catalogReady: true,
      ready: false,
      exitCode: 0,
    });
    expect(result.outputTail).not.toContain("Agencity error");
    expect(result.outputTail).not.toContain("Model selection was cancelled");

    const durable = await configAndSessions(world);
    expect(durable.config.defaultModel).toBeNull();
    expect(durable.sessions).toEqual([]);
  },
  30_000,
);

test.skipIf(!python || process.platform === "win32")(
  "retains the stored credential but no model or root after service loss and clean picker cancellation",
  async () => {
    const world = await createWorld("delayed");
    world.environment.AGENCITY_ACCEPTANCE = "1";
    world.environment.AGENCITY_ACCEPTANCE_LEASE_MS = "500";
    const controlPath = join(world.directory, "service-loss-control");
    const running = runPty(world, "service-loss", 80, controlPath);
    const [, catalogRequest] = await Promise.all([
      waitForFile(`${controlPath}.ready`, 10_000),
      world.fixture.waitForCatalog(1, 10_000),
    ]);
    expect(catalogRequest.authorization).toBeNull();
    await writeFile(controlPath, "kill\n");
    const result = await running;
    expect(result, result.outputTail).toMatchObject({
      providerPrompt: true,
      keyPrompt: true,
      catalogReady: true,
      ready: false,
      serviceKilled: true,
    });
    expect(result.servicePid).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
    expect(result.outputTail).not.toContain("Agencity error");
    expect(result.outputTail).not.toContain("Model selection was cancelled");

    world.fixture.releaseCatalog();
    await Bun.sleep(1_000);
    const durable = await configAndSessions(world);
    expect(durable.config.defaultModel).toBeNull();
    expect(durable.sessions).toEqual([]);
    const doctor = await command(world, [
      "doctor",
      "--workspace",
      world.workspace,
      "--json",
    ]);
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout).providers).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        usable: true,
        credentialSource: "stored",
      }),
    );
  },
  30_000,
);

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, "utf8")).trim() === "ready") return;
    } catch {}
    await Bun.sleep(25);
  }
  throw new Error(`PTY driver did not create readiness marker: ${path}`);
}

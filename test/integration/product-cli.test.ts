import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseCliArgs } from "../../src/cli-args.ts";
import { resolveWorkspace, validateServiceManifest, workspacePreferenceKey, type ServiceManifestV1 } from "../../src/product/index.ts";
import { ProfileStore } from "../../src/storage/index.ts";
import { StrictActionFixture } from "../acceptance/strict-action-fixture.ts";

const root = resolve(new URL("../..", import.meta.url).pathname);
const python = Bun.which("python3");
const directories: string[] = [];
const ownedFixtureRoots = new Set<string>();
const modelFixtures: StrictActionFixture[] = [];
let baselineServicePids = new Set<number>();

function serviceChildren(): Array<{ pid: number; command: string }> {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,command="]);
  if (result.exitCode !== 0) return [];
  return result.stdout.toString().split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && match[2]!.includes("__service-child") ? [{ pid: Number(match[1]), command: match[2]! }] : [];
  });
}

function processIsLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsLive(pid)) return true;
    await Bun.sleep(25);
  }
  return !processIsLive(pid);
}

async function ownedManifests(directory: string): Promise<Array<{ manifest: ServiceManifestV1; workspaceRoot: string }>> {
  const found: Array<{ manifest: ServiceManifestV1; workspaceRoot: string }> = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { await visit(path); continue; }
      if (entry.name !== "manifest.json" || !current.endsWith(`${join(".agencity", "service")}`)) continue;
      try {
        const manifest = validateServiceManifest(JSON.parse(await readFile(path, "utf8")));
        found.push({ manifest, workspaceRoot: resolve(current, "..", "..") });
      } catch {}
    }
  };
  await visit(directory);
  return found;
}

function isOwnedServiceChild(manifest: ServiceManifestV1, workspaceRoot: string): boolean {
  if (manifest.pidHint === process.pid) return false;
  const command = serviceChildren().find(candidate => candidate.pid === manifest.pidHint)?.command;
  return Boolean(command?.includes(`__service-child --workspace ${workspaceRoot}`));
}

async function shutdownOwnedServices(directory: string): Promise<void> {
  for (const { manifest, workspaceRoot } of await ownedManifests(directory)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 750);
    try {
      await fetch(`${manifest.url}/service/shutdown`, {
        method: "POST",
        signal: controller.signal,
        headers: { authorization: `Bearer ${manifest.bearerToken}` },
      });
    } catch {} finally { clearTimeout(timeout); }
    if (await waitForProcessExit(manifest.pidHint)) continue;
    // The fallback is limited to a manifest discovered below this test's temp
    // root and a live service-child argv containing the same owned root.
    if (!isOwnedServiceChild(manifest, workspaceRoot)) continue;
    try { process.kill(manifest.pidHint, "SIGTERM"); } catch { continue; }
    if (await waitForProcessExit(manifest.pidHint, 1_000)) continue;
    if (!isOwnedServiceChild(manifest, workspaceRoot)) continue;
    try { process.kill(manifest.pidHint, "SIGKILL"); } catch {}
    await waitForProcessExit(manifest.pidHint, 1_000);
  }
}

async function teardownFixtures(): Promise<void> {
  for (const directory of directories.splice(0)) {
    await shutdownOwnedServices(directory);
    await rm(directory, { recursive: true, force: true });
  }
  for (const fixture of modelFixtures.splice(0)) fixture.close();
}

beforeAll(() => { baselineServicePids = new Set(serviceChildren().map(child => child.pid)); });
afterEach(teardownFixtures);
afterAll(async () => {
  await teardownFixtures();
  const leaked = serviceChildren().filter(child =>
    !baselineServicePids.has(child.pid) && [...ownedFixtureRoots].some(fixtureRoot => child.command.includes(fixtureRoot))
  );
  expect(leaked).toEqual([]);
});

async function fixture(): Promise<{ directory: string; workspace: string; home: string }> {
  const directory = await mkdtemp(join(tmpdir(), "agencity-product-")); directories.push(directory); ownedFixtureRoots.add(directory);
  const workspace = join(directory, "repo"); const home = join(directory, "home");
  await mkdir(workspace); await mkdir(home); await mkdir(join(workspace, ".git"));
  return { directory, workspace, home };
}

async function cli(args: readonly string[], options: { cwd?: string; home: string; extraEnv?: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string }> {
  const { OPENAI_API_KEY: _key, OPENAI_BASE_URL: _base, OPENAI_MODEL: _model, AGENCITY_PROFILE: _profile, ...clean } = process.env;
  const child = Bun.spawn([process.execPath, "run", join(root, "src/cli.ts"), ...args], {
    cwd: options.cwd ?? root,
    env: { ...clean, HOME: options.home, ...(options.extraEnv ?? {}) },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

async function allFileText(directory: string): Promise<string> {
  let text = "";
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) text += await allFileText(path);
    else text += (await readFile(path)).toString("latin1");
  }
  return text;
}

describe("product CLI", () => {
  test("disambiguates command-like tasks from product and retained diagnostic commands", () => {
    expect(parseCliArgs([])).toMatchObject({ command: "product", positionals: [] });
    expect(() => parseCliArgs(["fix", "the", "tests", "--demo"])).toThrow("Unknown option: --demo");
    expect(() => parseCliArgs(["--demo", "create", "a", "parser"])).toThrow("Unknown option: --demo");

    expect(parseCliArgs(["run", "fix", "it", "--model", "openai/gpt-test"])).toMatchObject({ command: "run", positionals: ["fix", "it"] });
    expect(parseCliArgs(["history", "current"])).toMatchObject({ command: "history", positionals: ["current"] });
    expect(parseCliArgs(["branch", "head", "named-fork"])).toMatchObject({ command: "branch", positionals: ["head", "named-fork"] });
    expect(parseCliArgs(["new", "write", "docs"])).toMatchObject({ command: "new", positionals: ["write", "docs"] });
    expect(parseCliArgs(["skills", "install", "./bundle", "--scope", "profile", "--confirmation", "abc"])).toMatchObject({ command: "skills", positionals: ["install", "./bundle"] });
    expect(parseCliArgs(["profile", "history", "--json"])).toMatchObject({ command: "profile", positionals: ["history"] });
    expect(parseCliArgs(["profile", "repropose", "latest", "{}"])).toMatchObject({ command: "profile", positionals: ["repropose", "latest", "{}"] });
    expect(parseCliArgs(["--", "run", "the", "benchmark"])).toMatchObject({ command: "product", positionals: ["run", "the", "benchmark"] });
    expect(parseCliArgs(["run the benchmark"])).toMatchObject({ command: "product", positionals: ["run the benchmark"] });

    expect(parseCliArgs(["create"]).command).toBe("create");
    expect(parseCliArgs(["create", "--workspace", "diagnostic"]).command).toBe("create");
    expect(parseCliArgs(["snapshot", "--session", "s", "--branch", "b"]).command).toBe("snapshot");
    expect(parseCliArgs(["chat", "--session=s", "--branch=b", "hello"])).toMatchObject({ command: "chat", positionals: ["hello"] });
    expect(parseCliArgs(["cell", "--session", "s", "--branch", "b", "return 1"])).toMatchObject({ command: "cell", positionals: ["return 1"] });

    expect(parseCliArgs(["create", "a", "parser"])).toMatchObject({ command: "product", positionals: ["create", "a", "parser"] });
    expect(parseCliArgs(["snapshot", "the", "current", "design"])).toMatchObject({ command: "product", positionals: ["snapshot", "the", "current", "design"] });
    expect(parseCliArgs(["chat", "with", "the", "team"])).toMatchObject({ command: "product", positionals: ["chat", "with", "the", "team"] });
    expect(parseCliArgs(["cell", "division", "cleanup"])).toMatchObject({ command: "product", positionals: ["cell", "division", "cleanup"] });
    expect(parseCliArgs(["create a parser"])).toMatchObject({ command: "product", positionals: ["create a parser"] });
    expect(parseCliArgs(["--", "create", "--demo"])).toMatchObject({ command: "product", positionals: ["create", "--demo"] });
  });

  test("canonical workspace discovery resolves nested paths and aliases to one identity", async () => {
    const value = await fixture();
    const nested = join(value.workspace, "packages", "app"); await mkdir(nested, { recursive: true });
    const alias = join(value.directory, "alias"); await symlink(value.workspace, alias);
    const fromNested = await resolveWorkspace({ startDirectory: nested });
    const fromAlias = await resolveWorkspace({ override: alias });
    expect(fromNested.root).toBe(fromAlias.root);
    expect(fromNested.workspaceId).toBe(fromAlias.workspaceId);
  });

  test("durable workspace identity survives a repository move and symlinked entry path", async () => {
    const value = await fixture();
    const original = await resolveWorkspace({ override: value.workspace });
    const marker = join(value.workspace, ".agencity", "workspace-id");
    expect((await lstat(marker)).mode & 0o777).toBe(0o600);
    expect(await readFile(marker, "utf8")).toBe(`${original.workspaceId}\n`);

    const moved = join(value.directory, "renamed-repo");
    await rename(value.workspace, moved);
    const alias = join(value.directory, "renamed-alias");
    await symlink(moved, alias);
    const fromMoved = await resolveWorkspace({ override: moved });
    const fromAlias = await resolveWorkspace({ override: alias });
    expect(fromMoved.root).toBe(fromAlias.root);
    expect(fromMoved.root.endsWith("/renamed-repo")).toBe(true);
    expect(fromMoved.workspaceId).toBe(original.workspaceId);
    expect(fromAlias.workspaceId).toBe(original.workspaceId);
    expect(fromMoved.stateDirectory).toBe(join(fromMoved.root, ".agencity"));
  });

  test("concurrent first opens atomically converge on one complete workspace marker", async () => {
    const value = await fixture();
    const resolved = await Promise.all(Array.from({ length: 32 }, () => resolveWorkspace({ override: value.workspace })));
    expect(new Set(resolved.map(item => item.workspaceId)).size).toBe(1);
    const workspaceId = resolved[0]!.workspaceId;
    expect(workspaceId).toMatch(/^workspace-[a-f0-9]{32}$/);
    expect(await readFile(join(value.workspace, ".agencity", "workspace-id"), "utf8")).toBe(`${workspaceId}\n`);
    expect((await readdir(join(value.workspace, ".agencity"))).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a pre-marker database migrates once to the legacy path-derived workspace identity", async () => {
    const value = await fixture();
    const stateDirectory = join(value.workspace, ".agencity");
    await mkdir(stateDirectory, { mode: 0o700 });
    await writeFile(join(stateDirectory, "agent.db"), "pre-marker database");
    const migrated = await resolveWorkspace({ override: value.workspace });
    const hash = new Bun.CryptoHasher("sha256"); hash.update(migrated.root);
    const legacyId = `workspace-${hash.digest("hex").slice(0, 24)}`;
    expect(migrated.workspaceId).toBe(legacyId);
    expect(await readFile(join(stateDirectory, "workspace-id"), "utf8")).toBe(`${legacyId}\n`);

    await rm(join(stateDirectory, "agent.db"));
    expect((await resolveWorkspace({ override: value.workspace })).workspaceId).toBe(legacyId);

    const customWorkspace = join(value.directory, "custom-db-repo"); await mkdir(customWorkspace);
    const customDatabase = join(value.directory, "custom-state", "legacy.db");
    await mkdir(join(value.directory, "custom-state")); await writeFile(customDatabase, "custom pre-marker database");
    const customMigrated = await resolveWorkspace({ override: customWorkspace, legacyDatabasePath: customDatabase });
    const customHash = new Bun.CryptoHasher("sha256"); customHash.update(customMigrated.root);
    expect(customMigrated.workspaceId).toBe(`workspace-${customHash.digest("hex").slice(0, 24)}`);
  });

  test("rejects symlinked metadata and symlink, insecure, or invalid workspace markers", async () => {
    const value = await fixture();

    const metadataTarget = join(value.directory, "metadata-target"); await mkdir(metadataTarget);
    const metadataLinkWorkspace = join(value.directory, "metadata-link-repo"); await mkdir(metadataLinkWorkspace);
    await symlink(metadataTarget, join(metadataLinkWorkspace, ".agencity"));
    await expect(resolveWorkspace({ override: metadataLinkWorkspace })).rejects.toThrow("metadata must be a real directory");

    const symlinkWorkspace = join(value.directory, "symlink-marker-repo"); await mkdir(join(symlinkWorkspace, ".agencity"), { recursive: true });
    const externalMarker = join(value.directory, "external-workspace-id");
    await writeFile(externalMarker, "workspace-aaaaaaaaaaaaaaaa\n", { mode: 0o600 });
    await symlink(externalMarker, join(symlinkWorkspace, ".agencity", "workspace-id"));
    await expect(resolveWorkspace({ override: symlinkWorkspace })).rejects.toThrow("marker is unavailable");

    const insecureWorkspace = join(value.directory, "insecure-marker-repo"); await mkdir(join(insecureWorkspace, ".agencity"), { recursive: true });
    const insecureMarker = join(insecureWorkspace, ".agencity", "workspace-id");
    await writeFile(insecureMarker, "workspace-bbbbbbbbbbbbbbbb\n"); await chmod(insecureMarker, 0o644);
    await expect(resolveWorkspace({ override: insecureWorkspace })).rejects.toThrow("owner-only");

    const invalidWorkspace = join(value.directory, "invalid-marker-repo"); await mkdir(join(invalidWorkspace, ".agencity"), { recursive: true });
    const invalidMarker = join(invalidWorkspace, ".agencity", "workspace-id");
    await writeFile(invalidMarker, "../../not-an-identity\n", { mode: 0o600 });
    await expect(resolveWorkspace({ override: invalidWorkspace })).rejects.toThrow("marker is invalid");
  });

  test("creates a missing explicit state directory before opening the workspace database", async () => {
    const value = await fixture();
    const provider = new StrictActionFixture(); modelFixtures.push(provider);
    const stateDirectory = join(value.directory, "external", "nested-state");
    const result = await cli([
      "run",
      "--new",
      "--json",
      "--workspace",
      value.workspace,
      "--state-dir",
      stateDirectory,
      "--model",
      "openai:openai/fixture-v1",
      "exercise explicit state creation",
    ], {
      home: value.home,
      extraEnv: provider.environment(),
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      protocol: "agencity.run-result",
      status: "succeeded",
    });
    expect((await lstat(stateDirectory)).isDirectory()).toBe(true);
    expect((await lstat(join(stateDirectory, "agent.db"))).isFile()).toBe(true);
  });

  test("no-subcommand route reaches a ready TUI and a second invocation resumes without IDs", async () => {
    const value = await fixture();
    const provider = new StrictActionFixture(); modelFixtures.push(provider);
    const invoke = async (extra: string[], extraEnv: Record<string, string> = {}) => {
      const { OPENAI_API_KEY: _key, ...clean } = process.env;
      const child = Bun.spawn([process.execPath, "run", join(root, "src/cli.ts"), "--workspace", value.workspace, ...extra], {
        cwd: root, env: { ...clean, HOME: value.home, ...extraEnv }, stdout: "pipe", stderr: "pipe", stdin: "pipe",
      });
      child.stdin.write("/quit\n"); child.stdin.end();
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    const first = await invoke([], provider.environment());
    expect(first).toMatchObject({ code: 0, stderr: "" });
    expect(first.stdout).toContain("Agencity product session");
    expect(first.stdout).toContain("Agencity trusted-local TUI");
    const second = await invoke([]);
    expect(second).toMatchObject({ code: 0, stderr: "" });
    expect(second.stdout).toContain("Session: New session");
  });

  test("configured provider run creates named durable work, resumes it, selects, and renames without IDs for normal use", async () => {
    const value = await fixture();
    const provider = new StrictActionFixture(); modelFixtures.push(provider);
    const first = await cli(["run", "--workspace", value.workspace, "--model", "openai:openai/fixture-v1", "--effort", "high", "inspect this repository"], {
      home: value.home,
      extraEnv: provider.environment(),
    });
    expect(first).toMatchObject({ code: 0, stderr: "" });
    expect(first.stdout).toContain("Session: inspect this repository / main");
    expect(first.stdout).toContain("Model: openai:openai/fixture-v1");
    expect(first.stdout).toContain("Agent tools: bun_console + finish · unknown");
    expect(first.stdout).toContain("fixture completed: inspect this repository");

    const configuredEffort = await cli(["config", "set-effort", "medium", "--workspace", value.workspace, "--json"], { home: value.home });
    expect(configuredEffort.code).toBe(0);
    expect(JSON.parse(configuredEffort.stdout)).toMatchObject({ effort: "medium" });

    const resumed = await cli(["run", "--workspace", value.workspace, "continue inspection"], { home: value.home });
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain("Session: inspect this repository / main");
    expect(resumed.stdout).toContain("fixture completed: continue inspection");

    const listed = await cli(["sessions", "--workspace", value.workspace, "--json"], { home: value.home });
    const rows = JSON.parse(listed.stdout) as Array<{ sessionId: string; branchId: string; sessionName: string; taskSummary: string; model: { provider: string; reasoningEffort: string } }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionName: "inspect this repository", taskSummary: "inspect this repository", model: { provider: "openai", reasoningEffort: "high" } });

    const activeProfile = await cli(["profile", "show", "--workspace", value.workspace, "--json"], { home: value.home });
    expect(activeProfile).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(activeProfile.stdout)).toMatchObject({
      revision: 1,
      active: true,
      promptContractId: "agencity.agent-profile.v1",
    });
    expect(JSON.parse(activeProfile.stdout).exactAgentPrompt).toContain("Role:");
    const profileHistory = await cli(["profile", "history", "--workspace", value.workspace, "--json"], { home: value.home });
    expect(profileHistory).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(profileHistory.stdout)).toMatchObject({
      activeProfileVersionId: JSON.parse(activeProfile.stdout).profileVersionId,
      items: [{ revision: 1, active: true }],
      proposals: [],
    });

    const learningStatus = await cli(["refine", "status", "--workspace", value.workspace, "--json"], { home: value.home });
    const learningHistory = await cli(["refine", "history", "--workspace", value.workspace, "--json"], { home: value.home });
    expect(learningStatus).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(learningStatus.stdout)).toMatchObject({
      automaticLearning: "enabled",
      automaticPolicy: {
        automatic: true,
        scope: "local",
        repeatedSuccess: { enabled: true, threshold: 5 },
      },
      pendingActivityCount: 0,
      latestActivity: null,
    });
    expect(learningHistory).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(learningHistory.stdout)).toMatchObject({
      automaticLearning: "enabled",
      activities: [],
    });
    const pausedLearning = await cli(["refine", "pause", "--workspace", value.workspace], { home: value.home });
    expect(pausedLearning).toMatchObject({ code: 0, stderr: "" });
    expect(pausedLearning.stdout).toContain("Automatic learning paused.");
    const resumedLearning = await cli(["refine", "resume", "--workspace", value.workspace], { home: value.home });
    expect(resumedLearning).toMatchObject({ code: 0, stderr: "" });
    expect(resumedLearning.stdout).toContain("Automatic learning enabled.");

    const renamed = await cli(["sessions", "--workspace", value.workspace, "--session", rows[0]!.sessionId, "--name", "Repository inspection", "--json"], { home: value.home });
    expect(renamed.code).toBe(0);
    expect((JSON.parse(renamed.stdout) as Array<{ sessionName: string }>)[0]!.sessionName).toBe("Repository inspection");
    const selected = await cli(["sessions", "--workspace", value.workspace, "--select", "Repository inspection"], { home: value.home });
    expect(selected).toMatchObject({ code: 0, stderr: "" });
    expect(selected.stdout).toContain("Selected");
  });

  test("multiple equally plausible roots require explicit selection rather than row order", async () => {
    const value = await fixture();
    const provider = new StrictActionFixture(); modelFixtures.push(provider);
    expect((await cli(["run", "--workspace", value.workspace, "--model", "openai:openai/fixture-v1", "first root"], {
      home: value.home,
      extraEnv: provider.environment(),
    })).code).toBe(0);
    expect((await cli(["run", "--workspace", value.workspace, "--new", "second root"], { home: value.home })).code).toBe(0);
    const workspace = await resolveWorkspace({ override: value.workspace });
    const profile = await ProfileStore.open(`file:${join(value.home, ".agencity", "profile.db")}`);
    await profile.setPreference(workspacePreferenceKey(workspace.workspaceId, "recent"), null); profile.close();
    const ambiguous = await cli(["run", "--workspace", value.workspace, "do not guess"], { home: value.home });
    expect(ambiguous.code).not.toBe(0);
    expect(ambiguous.stderr).toContain("Multiple sessions are plausible");
    const rows = JSON.parse((await cli(["sessions", "--workspace", value.workspace, "--json"], { home: value.home })).stdout) as Array<{ sessionId: string }>;
    const selected = await cli(["run", "--workspace", value.workspace, "--session", rows[0]!.sessionId, "explicit work"], { home: value.home });
    expect(selected.code).toBe(0);
    expect(selected.stdout).toContain("fixture completed: explicit work");
  });

  test("non-interactive new work requires provider configuration", async () => {
    const value = await fixture();
    const failed = await cli(["run", "--workspace", value.workspace, "work without provider"], { home: value.home });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("No usable model is selected");
    expect(failed.stdout).not.toContain("Echo:");
    const listed = await cli(["sessions", "--workspace", value.workspace, "--json"], { home: value.home });
    expect(JSON.parse(listed.stdout)).toEqual([]);
  });

  test("rejects model grammar and effort before writing a preference or root", async () => {
    const value = await fixture();
    const provider = new StrictActionFixture();
    modelFixtures.push(provider);
    const malformed = await cli([
      "run",
      "--workspace",
      value.workspace,
      "--model",
      "openai:not-canonical",
      "malformed selection",
    ], {
      home: value.home,
      extraEnv: provider.environment(),
    });
    expect(malformed.code).not.toBe(0);
    expect(malformed.stderr).toContain("canonical creator/model");

    const invalidEffort = await cli([
      "run",
      "--workspace",
      value.workspace,
      "--model",
      "openai:openai/fixture-v1",
      "--effort",
      "none",
      "invalid effort",
    ], {
      home: value.home,
      extraEnv: provider.environment(),
    });
    expect(invalidEffort.code).not.toBe(0);
    expect(invalidEffort.stderr).toContain("Reasoning effort");

    const configured = await cli([
      "config",
      "--workspace",
      value.workspace,
      "--json",
    ], { home: value.home });
    expect(configured.code).toBe(0);
    expect(JSON.parse(configured.stdout).defaultModel).toBeNull();
    const sessions = await cli([
      "sessions",
      "--workspace",
      value.workspace,
      "--json",
    ], { home: value.home });
    expect(JSON.parse(sessions.stdout)).toEqual([]);
  });

  test("retains malformed defaults for diagnostics and fails closed non-interactively", async () => {
    const value = await fixture();
    const provider = new StrictActionFixture();
    modelFixtures.push(provider);
    const workspace = await resolveWorkspace({ override: value.workspace });
    const profileDirectory = join(value.home, ".agencity");
    await mkdir(profileDirectory, { recursive: true });
    const profile = await ProfileStore.open(
      `file:${join(profileDirectory, "profile.db")}`,
    );
    await profile.setPreference(
      workspacePreferenceKey(workspace.workspaceId, "model"),
      "openai:retained-malformed",
    );
    profile.close();

    const failed = await cli([
      "run",
      "--workspace",
      value.workspace,
      "must not replace retained default",
    ], {
      home: value.home,
      extraEnv: provider.environment(),
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain(
      "Stored workspace model preference is invalid",
    );
    expect(failed.stderr).toContain("pass --model PROVIDER:MODEL");

    const inspected = await cli([
      "config",
      "--workspace",
      value.workspace,
      "--json",
    ], { home: value.home });
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout).defaultModel).toBe(
      "openai:retained-malformed",
    );
    const sessions = await cli([
      "sessions",
      "--workspace",
      value.workspace,
      "--json",
    ], { home: value.home });
    expect(JSON.parse(sessions.stdout)).toEqual([]);
  });

  test.skipIf(!python || process.platform === "win32")(
    "keeps a stored key but writes no model or root when first-run model selection is interrupted",
    async () => {
      const value = await fixture();
      const provider = new StrictActionFixture();
      modelFixtures.push(provider);
      const secret = "acceptance-fixture-key";
      const driver = String.raw`
import fcntl, json, os, pty, select, signal, struct, sys, termios, time
root, workspace = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(root)
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    os.execvp("bun", ["bun", os.path.join(root, "src/cli.ts"), "new", "--workspace", workspace])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
os.set_blocking(fd, False)
output = bytearray()
def pump(seconds, needle):
    deadline = time.time() + seconds
    target = needle.encode()
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try: chunk = os.read(fd, 65536)
            except OSError: break
            if not chunk: break
            output.extend(chunk)
            if target in output: return True
    return target in output
provider_prompt = pump(10, "Choose a provider")
if provider_prompt: os.write(fd, b"openai\r")
key_prompt = pump(5, "API key for OpenAI")
if key_prompt: os.write(fd, b"acceptance-fixture-key\r")
model_prompt = pump(10, "Fixture Reasoner")
signal_sent = False
if model_prompt:
    time.sleep(0.1)
    os.kill(pid, signal.SIGTERM)
    signal_sent = True
    pump(1, "__drain_without_match__")
deadline = time.time() + 10
exit_code = None
while time.time() < deadline:
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        exit_code = os.waitstatus_to_exitcode(status)
        break
    time.sleep(0.05)
print(json.dumps({
    "providerPrompt": provider_prompt,
    "keyPrompt": key_prompt,
    "modelPrompt": model_prompt,
    "signalSent": signal_sent,
    "exitCode": exit_code,
    "secretHidden": b"acceptance-fixture-key" not in output,
    "outputTail": output.decode("utf-8", "replace")[-1200:],
}))
`;
      const {
        OPENAI_API_KEY: _openai,
        OPENAI_MODEL: _openaiModel,
        ANTHROPIC_API_KEY: _anthropic,
        ANTHROPIC_MODEL: _anthropicModel,
        AI_GATEWAY_API_KEY: _gateway,
        VERCEL_MODEL: _vercelModel,
        ...cleanEnvironment
      } = process.env;
      const driven = Bun.spawn(
        [python!, "-c", driver, root, value.workspace],
        {
          cwd: root,
          env: {
            ...cleanEnvironment,
            HOME: value.home,
            WORKSPACE: value.workspace,
            ...provider.firstRunEnvironment(),
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [driverCode, driverOutput, driverError] = await Promise.all([
        driven.exited,
        new Response(driven.stdout).text(),
        new Response(driven.stderr).text(),
      ]);
      expect(driverCode, driverError).toBe(0);
      expect(JSON.parse(driverOutput)).toMatchObject({
        providerPrompt: true,
        keyPrompt: true,
        modelPrompt: true,
        signalSent: true,
        exitCode: -15,
        secretHidden: true,
      });

      const configured = await cli([
        "config",
        "--workspace",
        value.workspace,
        "--json",
      ], { home: value.home });
      expect(JSON.parse(configured.stdout).defaultModel).toBeNull();
      const sessions = await cli([
        "sessions",
        "--workspace",
        value.workspace,
        "--json",
      ], { home: value.home });
      expect(JSON.parse(sessions.stdout)).toEqual([]);
      const doctor = await cli([
        "doctor",
        "--workspace",
        value.workspace,
        "--json",
      ], { home: value.home });
      expect(JSON.parse(doctor.stdout).providers).toContainEqual(
        expect.objectContaining({
          provider: "openai",
          usable: true,
          credentialSource: "stored",
        }),
      );
      expect(await allFileText(value.directory)).toContain(secret);
    },
    30_000,
  );

  test("retained work remains selectable through the resident service after the originating client exits", async () => {
    const value = await fixture();
    const invokeTui = async (extraEnv: Record<string, string>) => {
      const { OPENAI_API_KEY: _key, ...clean } = process.env;
      const child = Bun.spawn([process.execPath, "run", join(root, "src/cli.ts"), "--workspace", value.workspace, "--model", "openai:openai/test-model"], {
        cwd: root, env: { ...clean, HOME: value.home, ...extraEnv }, stdout: "pipe", stderr: "pipe", stdin: "pipe",
      });
      child.stdin.write("/quit\n"); child.stdin.end();
      return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    };
    const [createdCode] = await invokeTui({ OPENAI_API_KEY: "sk-test-process-only-123456789" });
    expect(createdCode).toBe(0);
    const resumed = await cli(["run", "--workspace", value.workspace, "work while unavailable"], { home: value.home });
    expect(resumed.code).toBe(1);
    expect(resumed.stdout).toContain("Model: openai:openai/test-model");
    expect(resumed.stderr).toContain("Run failed");
    expect(resumed.stdout).not.toContain("[UNAVAILABLE]");
    const rows = JSON.parse((await cli(["sessions", "--workspace", value.workspace, "--json"], { home: value.home })).stdout) as Array<{ model: { provider: string; model: string; reasoningEffort: string } }>;
    expect(rows[0]!.model).toEqual({ provider: "openai", model: "openai/test-model", reasoningEffort: "provider-default" });
  });

  test("doctor is a read-only observer and does not initialize a fresh workspace", async () => {
    const value = await fixture();
    const before = await readdir(value.workspace);
    const checked = await cli(["doctor", "--workspace", value.workspace, "--json"], { home: value.home });
    expect(checked).toMatchObject({ code: 0, stderr: "" });
    const report = JSON.parse(checked.stdout) as { workspace: { workspaceId: string | null }; observer: string; service: { state: string } };
    expect(report.workspace.workspaceId).toBeNull();
    expect(report.observer).toContain("no workspace initialization");
    expect(report.service.state).toBe("stopped");
    expect(await readdir(value.workspace)).toEqual(before);
    expect(await Bun.file(join(value.home, ".agencity", "profile.db")).exists()).toBe(false);
  });

  test("doctor discovers OpenAI Responses configuration without outputting or persisting its raw secret", async () => {
    const value = await fixture(); const secret = "sk-test-NEVER-PERSIST-0123456789";
    const checked = await cli(["doctor", "--workspace", value.workspace, "--json"], { home: value.home, extraEnv: { OPENAI_API_KEY: secret, OPENAI_BASE_URL: "https://example.invalid/v1" } });
    expect(checked).toMatchObject({ code: 0, stderr: "" });
    expect(checked.stdout).not.toContain(secret);
    const report = JSON.parse(checked.stdout) as { providers: Array<{ provider: string; usable: boolean }> };
    expect(report.providers).toContainEqual(expect.objectContaining({ provider: "openai", usable: true }));
    expect(await allFileText(value.directory)).not.toContain(secret);
  });

  test("doctor reports stored provider credentials without exposing their values", async () => {
    const value = await fixture();
    const secret = "stored-doctor-secret-0123456789";
    const profileDirectory = join(value.home, ".agencity");
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(join(profileDirectory, "auth.json"), JSON.stringify({
      version: 1,
      providers: { vercel: { apiKey: secret } },
    }), { mode: 0o600 });

    const checked = await cli(["doctor", "--workspace", value.workspace, "--json"], { home: value.home });
    expect(checked).toMatchObject({ code: 0, stderr: "" });
    expect(checked.stdout).not.toContain(secret);
    const report = JSON.parse(checked.stdout) as { providers: Array<{ provider: string; usable: boolean; credentialSource: string }> };
    expect(report.providers).toContainEqual(expect.objectContaining({
      provider: "vercel",
      usable: true,
      credentialSource: "stored",
    }));
  });

  test("credential configuration rejects expanded known secrets and credential-shaped references or labels without disclosure", async () => {
    const value = await fixture();
    // This deliberately does not resemble a provider key: rejection proves the
    // value supplied in argv after shell expansion is matched to the environment.
    const expandedSecret = "known-shell-expanded-value-4815162342";
    const shapedReference = "sk-live-CREDENTIALSHAPED0123456789";
    const shapedLabel = "Bearer credentialshapedlabel123456";
    const cases: Array<{ reference: string; label: string; rejected: string }> = [
      { reference: expandedSecret, label: "safe label", rejected: expandedSecret },
      { reference: "env:OPENAI_API_KEY", label: expandedSecret, rejected: expandedSecret },
      { reference: shapedReference, label: "safe label", rejected: shapedReference },
      { reference: "env:OPENAI_API_KEY", label: shapedLabel, rejected: shapedLabel },
    ];
    for (const candidate of cases) {
      const result = await cli([
        "config", "--workspace", value.workspace, "credential-ref", "openai", candidate.reference, candidate.label,
      ], { home: value.home, extraEnv: { OPENAI_API_KEY: expandedSecret } });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("must be non-secret opaque identifiers");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(candidate.rejected);
    }
    const inspected = await cli(["config", "--workspace", value.workspace, "--json"], { home: value.home });
    expect(inspected.code).toBe(0);
    expect((JSON.parse(inspected.stdout) as { credentialReferences: unknown[] }).credentialReferences).toEqual([]);
    const durableBytes = await allFileText(value.directory);
    for (const candidate of [expandedSecret, shapedReference, shapedLabel]) expect(durableBytes).not.toContain(candidate);
  });

  test("version and isolated bun link executable work outside the source directory", async () => {
    const value = await fixture(); const installation = join(value.directory, "bun-install");
    const linked = Bun.spawn([process.execPath, "link", "--cwd", root], { env: { ...process.env, BUN_INSTALL: installation }, stdout: "pipe", stderr: "pipe" });
    const [linkCode, linkError] = await Promise.all([linked.exited, new Response(linked.stderr).text()]);
    expect(linkCode, linkError).toBe(0);
    const executable = join(installation, "bin", "agencity");
    const indexed = Bun.spawnSync(["git", "ls-files", "-s", "src/cli.ts"], { cwd: root });
    expect(new TextDecoder().decode(indexed.stdout)).toStartWith("100755 ");
    expect((await lstat(join(root, "src/cli.ts"))).mode & 0o111).not.toBe(0);
    const version = Bun.spawn([executable, "--version"], { cwd: value.workspace, env: { ...process.env, HOME: value.home }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([version.exited, new Response(version.stdout).text(), new Response(version.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("agencity 0.1.0");
    expect(stdout).toContain("supported: >=1.3.13");
    const development = Bun.spawn([process.execPath, "run", "dev", "--", "--version"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [developmentCode, developmentStdout, developmentStderr] = await Promise.all([development.exited, new Response(development.stdout).text(), new Response(development.stderr).text()]);
    expect(developmentCode, developmentStderr).toBe(0);
    expect(developmentStdout).toBe(stdout);
  });
});

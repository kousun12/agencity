import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseCliArgs } from "../../src/cli-args.ts";

const root = resolve(new URL("../..", import.meta.url).pathname);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function cli(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "run", join(root, "src/cli.ts"), ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }

describe("FU-008 canonical advanced CLI integration", () => {
  test("the canonical parser dispatches grouped commands while retaining exact legacy identities", () => {
    expect(parseCliArgs(["debug", "history", "--session", "s", "--branch", "b", "--json"])).toMatchObject({
      command: "debug history", advanced: { path: "debug history", source: "canonical", legacyAlias: null },
    });
    expect(parseCliArgs(["history", "--session", "s", "--branch", "b", "--json"])).toMatchObject({
      command: "history", advanced: { path: "debug history", source: "legacy", legacyAlias: "history" },
    });
    expect(parseCliArgs(["sync", "status", "--json"])).toMatchObject({ command: "sync status", advanced: { path: "sync status" } });
    expect(parseCliArgs(["data", "export", "--destination", "out"])).toMatchObject({ command: "data export", advanced: { path: "data export" } });
  });

  test("canonical debug and data commands emit one stable v1 JSON envelope, while aliases preserve historical JSON", async () => {
    const state = await mkdtemp(join(tmpdir(), "agencity-advanced-cli-")); directories.push(state);
    const common = ["--state-dir", state, "--workspace-root", state, "--workspace", "advanced"];
    const created = await cli(["debug", "session-create", ...common, "--json"]);
    expect(created).toMatchObject({ code: 0, stderr: "" });
    const createdEnvelope = JSON.parse(created.stdout) as any;
    expect(createdEnvelope).toMatchObject({ protocol: "agencity.cli-output", version: 1, ok: true, command: "debug session-create", exitCode: 0 });
    const { sessionId, branchId } = createdEnvelope.data;

    const canonicalHistory = await cli(["debug", "history", ...common, "--session", sessionId, "--branch", branchId, "--json"]);
    expect(canonicalHistory.code).toBe(0);
    expect(JSON.parse(canonicalHistory.stdout)).toMatchObject({ protocol: "agencity.cli-output", version: 1, command: "debug history", data: [expect.objectContaining({ type: "SessionCreated" })] });

    const legacyHistory = await cli(["history", ...common, "--session", sessionId, "--branch", branchId, "--json"]);
    expect(legacyHistory).toMatchObject({ code: 0, stderr: "" });
    expect(legacyHistory.stdout).not.toContain("agencity.cli-output");
    expect(JSON.parse(legacyHistory.stdout.trim().split("\n")[0]!)).toMatchObject({ type: "SessionCreated" });

    const destination = join(state, "export");
    const exported = await cli(["data", "export", ...common, "--scope", "session", "--scope-id", sessionId, "--destination", destination, "--json"]);
    expect(exported.code).toBe(0);
    expect(JSON.parse(exported.stdout)).toMatchObject({ protocol: "agencity.cli-output", version: 1, command: "data export", data: { operation: "export", owned: true, status: "completed" } });
    expect(await exists(join(destination, "events.jsonl"))).toBe(true);
  });

  test("canonical failures have stable typed exits and parseable stderr envelopes", async () => {
    const state = await mkdtemp(join(tmpdir(), "agencity-advanced-error-")); directories.push(state);
    const result = await cli(["debug", "snapshot", "--state-dir", state, "--workspace-root", state, "--json"]);
    expect(result).toMatchObject({ code: 2, stdout: "" });
    expect(JSON.parse(result.stderr)).toEqual({
      protocol: "agencity.cli-output", version: 1, ok: false, command: "debug snapshot", exitCode: 2,
      error: { code: "VALIDATION_ERROR", message: "--session is required", details: null },
    });
  });

  test("data delete validates exact confirmation before creating or opening workspace state", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "agencity-delete-guard-")); directories.push(rootDirectory);
    const state = join(rootDirectory, "must-not-exist");
    const rejected = await cli([
      "data", "delete", "--state-dir", state, "--workspace-root", rootDirectory,
      "--scope", "session", "--scope-id", "session-1", "--confirmation", "yes", "--json",
    ]);
    expect(rejected.code).toBe(2);
    expect(JSON.parse(rejected.stderr)).toMatchObject({ command: "data delete", exitCode: 2, error: { code: "VALIDATION_ERROR", message: "Data deletion requires exact confirmation: DELETE session session-1" } });
    expect(await exists(state)).toBe(false);
  });

  test("help prioritizes product, advanced diagnostics, sync, and guarded data control", async () => {
    const help = await cli(["--help"]);
    expect(help).toMatchObject({ code: 0, stderr: "" });
    const positions = ["Product commands:", "Advanced diagnostics:", "Sync:", "Data control:"].map((label) => help.stdout.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(help.stdout).toContain("agencity debug history");
    expect(help.stdout).toContain("legacy: history");
    expect(help.stdout).toContain("agencity.cli-output v1");
    expect(help.stdout).toContain("DESTRUCTIVE: exact confirmation required");
  });
});

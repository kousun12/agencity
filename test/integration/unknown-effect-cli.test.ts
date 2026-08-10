import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Supervisor } from "../../src/runtime/index.ts";
import { resolveWorkspace } from "../../src/product/index.ts";

const root = resolve(new URL("../..", import.meta.url).pathname);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function cli(args: readonly string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "run", join(root, "src/cli.ts"), ...args], { cwd: root, env: { ...process.env, HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

describe("FU-006 no-ID unknown-effect CLI", () => {
  test("inspects and appends an assessment without changing status or retrying", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agencity-unknown-cli-")); directories.push(directory);
    const workspaceRoot = join(directory, "repo"); const home = join(directory, "home");
    await mkdir(join(workspaceRoot, ".git"), { recursive: true }); await mkdir(home);
    const workspace = await resolveWorkspace({ override: workspaceRoot });
    const supervisor = await Supervisor.open({
      databaseUrl: `file:${join(workspace.stateDirectory, "agent.db")}`,
      profileDatabaseUrl: `file:${join(home, ".agencity", "profile.db")}`,
      artifactDirectory: join(workspace.stateDirectory, "artifacts"), workspaceRoot, recover: false,
    });
    const session = await supervisor.createSession({ workspaceId: workspace.workspaceId, model: { provider: "echo", model: "echo-1" }, sessionName: "Unknown effect" });
    const effectId = "cli-unknown-effect";
    await supervisor.storage.appendEvents([{
      sessionId: session.sessionId, branchId: session.branchId, type: "EffectRequested", producer: "supervisor", idempotencyKey: "cli-unknown-request",
      payload: { effectId, executor: "shell", operation: "run", input: { command: "ambiguous" }, origin: { kind: "runtime", requestId: "cli-unknown-logical" }, idempotencyKey: "cli-unknown-logical", idempotent: false },
    }, {
      sessionId: session.sessionId, branchId: session.branchId, type: "EffectOutcomeRecorded", producer: "recovery", idempotencyKey: "cli-unknown-outcome",
      payload: { effectId, attempt: 1, outcome: "unknown", error: "lost owner", observedAt: new Date().toISOString() },
    }]);
    await supervisor.close();

    try {
      const listed = await cli(["unknown", "--workspace", workspaceRoot, "--json"], home);
      expect(listed).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(listed.stdout)).toEqual([
        expect.objectContaining({ effect: expect.objectContaining({ id: effectId, status: "unknown" }), assessments: [], retryAllowed: false }),
      ]);

      const reconciled = await cli([
        "reconcile", "--workspace", workspaceRoot, "--json", "--reconciliation-id", "cli-assessment", "--evidence", '{"audit":"none"}',
        effectId, "no_effect", "Provider audit found no invocation",
      ], home);
      expect(reconciled).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(reconciled.stdout)).toMatchObject({
        reconciliationId: "cli-assessment", effectId, assessment: "no_effect", evidence: { audit: "none" }, durableEffectStatus: "unknown", retried: false,
        effect: { status: "unknown" },
      });

      const inspected = await cli(["unknown", "--workspace", workspaceRoot, "--json", effectId], home);
      expect(JSON.parse(inspected.stdout)).toMatchObject({ effect: { status: "unknown" }, assessments: [expect.objectContaining({ reconciliationId: "cli-assessment" })], retryAllowed: false });
    } finally {
      await cli(["service", "--workspace", workspaceRoot, "shutdown"], home);
    }
  });
});

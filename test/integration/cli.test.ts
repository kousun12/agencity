import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseCliArgs } from "../../src/cli-args.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("CLI option parsing", () => {
  test("does not consume a following value option after a boolean flag", () => {
    const parsed = parseCliArgs([
      "cell", "--restart-console-after-cell", "--session", "s", "--branch=b", "return 1",
    ]);
    expect(parsed.flags.has("restart-console-after-cell")).toBe(true);
    expect(parsed.values.get("session")).toBe("s");
    expect(parsed.values.get("branch")).toBe("b");
    expect(parsed.positionals).toEqual(["return 1"]);
    expect(() => parseCliArgs(["cell", "--session", "--branch", "b"]))
      .toThrow(/session.*requires a value/i);
  });

  test("runs documented create, cell, snapshot, and history commands with mixed options", async () => {
    const temp = await makeTempRuntime("agencity-cli-");
    temps.push(temp);
    const stateDir = join(temp.directory, "state");
    const created = await cli([
      "create", "--state-dir", stateDir, "--restart-console-after-cell", "--workspace", "cli-test",
    ]);
    expect(created).toMatchObject({ code: 0, stderr: "" });
    const ids = JSON.parse(created.stdout) as { sessionId: string; branchId: string };

    const cell = await cli([
      "cell", "--state-dir", stateDir, "--restart-console-after-cell",
      "--session", ids.sessionId, "--branch", ids.branchId,
      `return { ok: true, token: "benign-token", auth: "domain-auth" };`,
    ]);
    expect(cell).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(cell.stdout).result).toEqual({
      ok: true, token: "benign-token", auth: "domain-auth",
    });

    const snapshot = await cli([
      "snapshot", "--state-dir", stateDir, "--session", ids.sessionId, "--branch", ids.branchId,
    ]);
    expect(snapshot).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(snapshot.stdout).state.sessionId).toBe(ids.sessionId);
    const history = await cli([
      "history", "--state-dir", stateDir, "--session", ids.sessionId, "--branch", ids.branchId,
    ]);
    expect(history).toMatchObject({ code: 0, stderr: "" });
    expect(history.stdout).toContain("SessionCreated");

    const deleted=await cli(["delete-data","--state-dir",stateDir,"--workspace","cli-test","--scope","session","--scope-id",ids.sessionId,"--confirmation",`DELETE session ${ids.sessionId}`,"--receipt-dir",join(stateDir,"deletion-receipts")]);
    expect(deleted).toMatchObject({code:0,stderr:""});expect(JSON.parse(deleted.stdout).status).toBe("completed");
    const missing=await cli(["snapshot","--state-dir",stateDir,"--workspace","cli-test","--session",ids.sessionId,"--branch",ids.branchId]);expect(missing.code).not.toBe(0);expect(missing.stderr).toContain("not found");
  });
});

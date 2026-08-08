import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileExecutor,
  ShellExecutor,
  type EffectExecutionRequest,
} from "../../src/index.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function request(
  executor: string,
  operation: string,
  input: EffectExecutionRequest["input"],
): EffectExecutionRequest {
  return {
    effectId: `${executor}-${operation}`,
    sessionId: "session",
    branchId: "main",
    executor,
    operation,
    input,
    idempotencyKey: `${executor}-${operation}`,
    idempotent: false,
    attempt: 1,
  };
}

async function fixture(): Promise<{
  root: string;
  canonicalRoot: string;
  alias: string;
  outside: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agencity-executor-alias-"));
  directories.push(root);
  const workspace = join(root, "workspace");
  const alias = join(root, "workspace-alias");
  const outside = join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  await symlink(workspace, alias, "dir");
  return { root: workspace, canonicalRoot: await realpath(workspace), alias, outside };
}

describe("executor path aliases", () => {
  test("accepts an absolute alias that resolves to the workspace", async () => {
    const value = await fixture();
    const signal = new AbortController().signal;
    const shell = await new ShellExecutor(value.canonicalRoot).execute(
      request("shell", "run", {
        command: 'printf "%s" "$PWD"',
        cwd: value.alias,
      }),
      { signal },
    );
    expect(shell).toMatchObject({
      outcome: "succeeded",
      output: { stdout: value.canonicalRoot },
    });

    const path = join(value.alias, "test.txt");
    const written = await new FileExecutor(value.canonicalRoot).execute(
      request("file", "write", { path, content: "alias accepted\n" }),
      { signal },
    );
    expect(written).toMatchObject({ outcome: "succeeded" });
    expect(await readFile(join(value.root, "test.txt"), "utf8")).toBe("alias accepted\n");
  });

  test("rejects an alias that resolves outside the workspace", async () => {
    const value = await fixture();
    const escape = join(value.root, "escape");
    await symlink(value.outside, escape, "dir");
    const signal = new AbortController().signal;

    await expect(new ShellExecutor(value.canonicalRoot).execute(
      request("shell", "run", { command: "pwd", cwd: escape }),
      { signal },
    )).rejects.toThrow("Shell cwd escapes workspace root");

    const escapedPath = join(escape, "blocked.txt");
    const written = await new FileExecutor(value.canonicalRoot).execute(
      request("file", "write", { path: escapedPath, content: "blocked\n" }),
      { signal },
    );
    expect(written).toMatchObject({
      outcome: "failed",
      error: "File path escapes executor root",
    });
    expect(await Bun.file(join(value.outside, "blocked.txt")).exists()).toBe(false);
  });
});

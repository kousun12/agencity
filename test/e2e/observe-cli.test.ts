import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repositoryRoot = resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function freshWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agencity-observe-cli-"));
  temporaryDirectories.push(root);
  return root;
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 10_000;
  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        Bun.sleep(250).then(() => ({ done: false as const, value: undefined })),
      ]);
      if (result.value) text += decoder.decode(result.value, { stream: true });
      const newline = text.indexOf("\n");
      if (newline >= 0) return text.slice(0, newline);
      if (result.done) break;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`Observer did not print a URL: ${text}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

describe("observe source-checkout command", () => {
  test("binds an ephemeral loopback port, prints a fragment token, and exits cleanly on SIGTERM without state", async () => {
    const workspace = await freshWorkspace();
    const child = Bun.spawn([
      process.execPath,
      resolve(repositoryRoot, "src/cli.ts"),
      "observe",
      "--workspace",
      workspace,
    ], {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const line = await readLine(child.stdout);
    expect(line).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43}$/);
    const origin = line.slice(0, line.indexOf("/#token="));
    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Agencity Observe");
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(await exists(join(workspace, ".agencity"))).toBe(false);
  });

  test("honors an explicit port and fails instead of falling back on conflict", async () => {
    const workspace = await freshWorkspace();
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("reserved"),
    });
    const port = reservation.port!;
    const conflict = Bun.spawn([
      process.execPath,
      resolve(repositoryRoot, "src/cli.ts"),
      "observe",
      "--workspace-root",
      workspace,
      "--port",
      String(port),
    ], {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      conflict.exited,
      new Response(conflict.stderr).text(),
    ]);
    reservation.stop(true);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`Observer port ${port} is unavailable`);
    expect(await exists(join(workspace, ".agencity"))).toBe(false);
  });
});

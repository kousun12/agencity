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
  const timedOut = Symbol("observer-url-timeout");
  try {
    const reading = (async (): Promise<string> => {
      while (true) {
        const result = await reader.read();
        if (result.value) text += decoder.decode(result.value, { stream: true });
        const newline = text.indexOf("\n");
        if (newline >= 0) return text.slice(0, newline);
        if (result.done) throw new Error(`Observer exited before printing a URL: ${text}`);
      }
    })();
    const result = await Promise.race([
      reading,
      Bun.sleep(10_000).then(() => timedOut),
    ]);
    if (typeof result !== "string") {
      await reader.cancel("Observer URL read timed out");
      throw new Error(`Observer did not print a URL: ${text}`);
    }
    return result;
  } finally {
    reader.releaseLock();
  }
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

  test("loads every checked-in asset through an isolated linked executable", async () => {
    const workspace = await freshWorkspace();
    const installation = join(workspace, "bun-install");
    const linked = Bun.spawn([process.execPath, "link", "--cwd", repositoryRoot], {
      env: { ...process.env, BUN_INSTALL: installation },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [linkCode, linkError] = await Promise.all([
      linked.exited,
      new Response(linked.stderr).text(),
    ]);
    expect(linkCode, linkError).toBe(0);
    const child = Bun.spawn([
      join(installation, "bin", "agencity"),
      "observe",
      "--workspace",
      workspace,
    ], {
      cwd: workspace,
      env: { ...process.env, BUN_INSTALL: installation },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let line: string;
      try {
        line = await readLine(child.stdout);
      } catch (error) {
        child.kill("SIGTERM");
        const [, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        throw new Error(`${String(error)}\nlinked observer stderr:\n${stderr}`);
      }
      const origin = line.slice(0, line.indexOf("/#token="));
      for (const [path, contentType] of [
        ["/", "text/html"],
        ["/app.js", "text/javascript"],
        ["/app.css", "text/css"],
      ] as const) {
        const asset = await fetch(`${origin}${path}`);
        expect(asset.status).toBe(200);
        expect(asset.headers.get("content-type")).toContain(contentType);
        expect((await asset.text()).length).toBeGreaterThan(100);
      }
    } finally {
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
    }
    expect(await exists(join(workspace, ".agencity"))).toBe(false);
  }, 30_000);
});

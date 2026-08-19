import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { LocalArtifactStore, OUTPUT_LIMITS, ShellExecutor, registerBrokeredSecret } from "../../src/index.ts";
import { releaseStreamReader } from "../../src/executors/shell.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

async function setup(store: "local" | "none" | "failing" = "local") {
  const temp = await makeTempRuntime("agencity-shell-bounds-");
  temps.push(temp);
  await mkdir(temp.workspaceRoot, { recursive: true });
  const local = new LocalArtifactStore(temp.artifactDirectory);
  await local.cleanupStaging();
  const artifacts = store === "none"
    ? undefined
    : store === "failing"
      ? Object.assign(local, { putStaged: async () => { throw new Error("fixture placement failure"); } })
      : local;
  const executor = new ShellExecutor(temp.workspaceRoot, artifacts);
  const execute = (command: string) => executor.execute({
    effectId: crypto.randomUUID(),
    sessionId: "session",
    branchId: "branch",
    executor: "shell",
    operation: "run",
    input: { command },
    idempotencyKey: crypto.randomUUID(),
    idempotent: true,
    attempt: 1,
  }, { signal: new AbortController().signal });
  return { temp, local, execute };
}

describe("bounded streaming shell output", () => {
  test("accepts Bun child-pipe readers that omit releaseLock", () => {
    expect(() => releaseStreamReader({})).not.toThrow();
    let released = false;
    releaseStreamReader({ releaseLock: () => { released = true; } });
    expect(released).toBe(true);
    let reads = 0;
    let unstableReleased = false;
    releaseStreamReader(Object.defineProperty({}, "releaseLock", {
      get: () => ++reads === 1 ? function(this: unknown) { unstableReleased = true; } : undefined,
    }));
    expect(unstableReleased).toBe(true);
    expect(reads).toBe(1);
    expect(() => releaseStreamReader({
      releaseLock: () => { throw new TypeError("detached Bun pipe reader"); },
    })).not.toThrow();
  });

  test("retains Unicode-safe head/tail previews and a digest-verified complete spill", async () => {
    const { local, execute } = await setup();
    const execution = await execute(
      `bun -e 'process.stdout.write("H".repeat(26000)+"🧪TAIL");process.stderr.write("E".repeat(25000)+"ERRTAIL")'`,
    );
    const output = execution.output as any;
    expect(execution.outcome).toBe("succeeded");
    expect(output.completeness).toBe("spilled");
    expect(execution.artifacts?.[0]?.mediaType).toBe("application/vnd.agencity.shell-output.v1");
    expect(/^H+$/.test(output.preview.stdout.head)).toBe(true);
    expect(output.preview.stdout.tail.endsWith("🧪TAIL")).toBe(true);
    expect(output.preview.stderr.tail.endsWith("ERRTAIL")).toBe(true);
    expect(new TextEncoder().encode(output.preview.stdout.head).byteLength).toBeLessThanOrEqual(12 * 1024);
    expect(new TextEncoder().encode(output.preview.stdout.tail).byteLength).toBeLessThanOrEqual(12 * 1024);
    expect(output.preview.stdout.tail.includes("�")).toBe(false);
    const complete = await local.resolve(output.artifact);
    expect(complete.byteLength).toBe(output.byteLength);
    expect(new TextDecoder().decode(complete.slice(output.layout.stdout.start, output.layout.stdout.end)))
      .toEndWith("🧪TAIL");
    expect(await local.verify(output.artifact)).toBe(true);
  });

  test("scrubs a registered value split across writes and preserves unregistered shapes", async () => {
    const secret = "cross-chunk-secret-91ab";
    const release = registerBrokeredSecret(secret);
    try {
      const { execute } = await setup();
      const execution = await execute(
        `printf 'cross-chunk-'; sleep 0.01; printf 'secret-91ab '; printf 'Bearer abcdef'; sleep 0.01; printf 'ghijklmnop '; printf '%s' '-----BEGIN PRIVATE KEY-----raw'; sleep 0.01; printf '%s' 'material-----END PRIVATE KEY-----'`,
      );
      const serialized = JSON.stringify(execution);
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain("Bearer abcdefghijklmnop");
      expect(serialized).toContain("-----BEGIN PRIVATE KEY-----rawmaterial-----END PRIVATE KEY-----");
      expect(serialized).toContain("[REDACTED]");
    } finally {
      release();
    }
  });

  test("preserves long uninterrupted credential-shaped output", async () => {
    const { local, execute } = await setup();
    const execution = await execute(
      `bun -e 'process.stdout.write("P".repeat(15000)+" Bearer "+"A".repeat(30000)+" "+"Q".repeat(15000))'`,
    );
    const output = execution.output as any;
    expect(output.completeness).toBe("spilled");
    const retained = new TextDecoder().decode(await local.resolve(output.artifact));
    expect(retained).toContain(`Bearer ${"A".repeat(30_000)}`);
    expect(JSON.stringify(output.preview)).not.toContain("[REDACTED]");
  });

  test("reports unavailable, failed, and over-limit spill without false artifact pointers", async () => {
    const unavailable = await (await setup("none")).execute(`bun -e 'process.stdout.write("x".repeat(30000))'`);
    expect(unavailable.output).toMatchObject({ completeness: "truncated", reason: "spill-unavailable" });
    expect(unavailable.output).not.toHaveProperty("artifact");

    const failed = await (await setup("failing")).execute(`bun -e 'process.stdout.write("x".repeat(30000))'`);
    expect(failed.output).toMatchObject({ completeness: "truncated", reason: "spill-failed" });
    expect(failed.output).not.toHaveProperty("artifact");

    const limited = await (await setup()).execute("dd if=/dev/zero bs=1048576 count=33 2>/dev/null");
    expect((limited.output as any).completeness).toBe("truncated");
    expect((limited.output as any).reason).toBe("spill-limit");
    expect(typeof (limited.output as any).byteLength).toBe("number");
    expect((limited.output as any).byteLength > OUTPUT_LIMITS.shellSpillBytes).toBe(true);
    expect(limited.output).not.toHaveProperty("artifact");
    expect(limited.artifacts).toBeUndefined();
  }, 30_000);

  test("does not claim complete output when one stream staging file cannot open", async () => {
    const { local, execute } = await setup();
    const create = local.createStagingPath.bind(local);
    let calls = 0;
    Object.defineProperty(local, "createStagingPath", {
      configurable: true,
      value: async (label: string) => {
        calls++;
        return calls === 2
          ? `${local.stagingRoot}/missing-parent/${label}.stage`
          : create(label);
      },
    });
    const execution = await execute(
      `bun -e 'process.stdout.write("o".repeat(30000));process.stderr.write("e".repeat(30000))'`,
    );
    expect(execution.output).toMatchObject({
      completeness: "truncated",
      reason: "spill-failed",
    });
    expect(execution.output).not.toHaveProperty("artifact");
    expect(execution.artifacts).toBeUndefined();
  });

  test("cleans owner-only stale staging files before recovery", async () => {
    const { local } = await setup();
    const stale = await local.createStagingPath("stale");
    await Bun.write(stale, "scrubbed but unreachable");
    expect(await Bun.file(stale).exists()).toBe(true);
    await local.cleanupStaging();
    expect(await Bun.file(stale).exists()).toBe(false);
  });
});

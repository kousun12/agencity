import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FileExecutor, OUTPUT_LIMITS } from "../../src/index.ts";
import { makeTempRuntime, removeTempRuntime, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

async function fixture(content: string) {
  const temp = await makeTempRuntime("agencity-file-bounds-");
  temps.push(temp);
  await Bun.write(join(temp.workspaceRoot, "source.txt"), content);
  const executor = new FileExecutor(temp.workspaceRoot);
  const execute = (
    input: Record<string, unknown>,
    signal: AbortSignal = new AbortController().signal,
  ) => executor.execute({
    effectId: crypto.randomUUID(),
    sessionId: "session",
    branchId: "branch",
    executor: "file",
    operation: "read",
    input: { path: "source.txt", ...input } as any,
    idempotencyKey: crypto.randomUUID(),
    idempotent: true,
    attempt: 1,
  }, { signal });
  return { temp, execute };
}

describe("bounded file text pages", () => {
  test("returns complete one-based windows with stable continuation metadata", async () => {
    const { execute } = await fixture("alpha\nβeta\ngamma\n");
    const first = await execute({ startLine: 1, endLine: 2 });
    expect(first).toMatchObject({
      outcome: "succeeded",
      output: {
        completeness: "inline",
        value: {
          content: "alpha\nβeta",
          startLine: 1,
          endLine: 2,
          totalLines: 3,
          nextLine: 3,
        },
      },
    });
    const sha256 = (first.output as any).value.sha256;
    const continuation = await execute({ startLine: 3, endLine: 3, expectedSha256: sha256 });
    expect(continuation).toMatchObject({
      outcome: "succeeded",
      output: { completeness: "inline", value: { content: "gamma\n", nextLine: null, sha256 } },
    });
  });

  test("fails a continuation after mutation and refuses declared or discovered page overflow", async () => {
    const { temp, execute } = await fixture("first\nsecond\n");
    const initial = await execute({ startLine: 1, endLine: 1 });
    const sha256 = (initial.output as any).value.sha256;
    await Bun.write(join(temp.workspaceRoot, "source.txt"), "changed\nsecond\n");
    expect(await execute({ startLine: 2, endLine: 2, expectedSha256: sha256 }))
      .toMatchObject({ outcome: "failed", error: expect.stringContaining("digest mismatch") });

    expect(await execute({ startLine: 1, endLine: OUTPUT_LIMITS.filePageLines + 1 }))
      .toMatchObject({ outcome: "succeeded", output: { completeness: "refused" } });
    await Bun.write(join(temp.workspaceRoot, "source.txt"), `${"x".repeat(OUTPUT_LIMITS.fileLineBytes + 1)}\n`);
    expect(await execute({ startLine: 1, endLine: 1 }))
      .toMatchObject({ outcome: "succeeded", output: { completeness: "refused", reason: expect.stringContaining("Line 1") } });
  });

  test("handles empty, trailing-newline, Unicode, and beyond-EOF windows exactly", async () => {
    const empty = await fixture("");
    expect(await empty.execute({ startLine: 1, endLine: 1 })).toMatchObject({
      outcome: "succeeded",
      output: {
        completeness: "inline",
        value: {
          content: "",
          startLine: 1,
          endLine: 0,
          totalLines: 0,
          nextLine: null,
          size: 0,
        },
      },
    });

    const content = `${Array.from({ length: 1_900 }, (_, index) => `line-${index}`).join("\n")}\n🧪é\n`;
    const populated = await fixture(content);
    const final = await populated.execute({ startLine: 1_901, endLine: 1_901 });
    expect(final).toMatchObject({
      outcome: "succeeded",
      output: {
        completeness: "inline",
        value: {
          content: "🧪é\n",
          startLine: 1_901,
          endLine: 1_901,
          totalLines: 1_901,
          nextLine: null,
        },
      },
    });
    const past = await populated.execute({ startLine: 2_500, endLine: 2_600 });
    expect(past).toMatchObject({
      outcome: "succeeded",
      output: {
        completeness: "inline",
        value: {
          content: "",
          startLine: 2_500,
          endLine: 1_901,
          totalLines: 1_901,
          nextLine: null,
        },
      },
    });
    expect(await populated.execute({ expectedSha256: 42 })).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("must be a string"),
    });
  });

  test("stops a large file-page scan promptly when cancelled", async () => {
    const { execute } = await fixture("line\n".repeat(8 * 1024 * 1024));
    const controller = new AbortController();
    const started = performance.now();
    const pending = execute({ startLine: 1, endLine: 1 }, controller.signal);
    const timer = setTimeout(() => controller.abort(), 10);
    const execution = await pending;
    clearTimeout(timer);
    expect(execution).toMatchObject({ outcome: "cancelled" });
    expect(performance.now() - started).toBeLessThan(3_000);
  }, 10_000);
});

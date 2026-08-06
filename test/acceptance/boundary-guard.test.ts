import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const directory = resolve(new URL(".", import.meta.url).pathname);

describe("FU-009 black-box boundary guard", () => {
  test("acceptance sources cannot import runtime internals or supply opaque diagnostic coordinates", async () => {
    const files = (await readdir(directory)).filter(name => name.endsWith(".ts"));
    const forbiddenWords = [
      ["Super", "visor"].join(""),
      ["Agent", "Client"].join(""),
      ["lib", "sql"].join(""),
      ["session", "Id"].join(""),
      ["branch", "Id"].join(""),
      ["cur", "sor"].join(""),
    ];
    const forbiddenOptions = [
      ["--", "session"].join(""),
      ["--", "branch"].join(""),
      ["--", "cur", "sor"].join(""),
    ];
    const violations: string[] = [];
    for (const file of files) {
      if (file === "boundary-guard.test.ts") continue;
      const source = await readFile(join(directory, file), "utf8");
      if (/from\s+["'][^"']*(?:\.\.\/){2,}src\//.test(source)) violations.push(`${file}: direct implementation import`);
      for (const word of forbiddenWords) if (source.includes(word)) violations.push(`${file}: forbidden internal token ${word}`);
      for (const option of forbiddenOptions) if (source.includes(option)) violations.push(`${file}: forbidden diagnostic option ${option}`);
      if (file !== "helpers.ts" && source.includes(["Bun", ".spawn"].join(""))) violations.push(`${file}: process launch bypasses installed-command helper`);
    }
    expect(violations).toEqual([]);
  });
});

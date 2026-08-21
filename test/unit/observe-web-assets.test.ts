import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const webRoot = resolve(import.meta.dir, "../../src/observe/web");

async function readAsset(name: string): Promise<string> {
  const file = Bun.file(resolve(webRoot, name));
  expect(await file.exists()).toBe(true);
  return file.text();
}

describe("observer browser assets", () => {
  test("ships only checked-in external script and style assets", async () => {
    const html = await readAsset("index.html");
    await readAsset("app.js");
    await readAsset("app.css");

    expect(html).toContain('<link rel="stylesheet" href="/app.css">');
    expect(html).toContain('<script src="/app.js" defer></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
  });

  test("uses inert DOM text and excludes executable markup sinks", async () => {
    const javascript = await readAsset("app.js");
    const forbiddenSinks = [
      "inner" + "HTML",
      "outer" + "HTML",
      "insertAdjacent" + "HTML",
      "document." + "write",
      "foreign" + "Object",
    ];

    for (const sink of forbiddenSinks) expect(javascript).not.toContain(sink);
    expect(javascript).toContain("textContent");
    expect(javascript.includes("document.createTextNode") || javascript.includes("document.createElement")).toBe(true);
    expect(javascript).not.toMatch(/\beval\s*\(/);
    expect(javascript).not.toMatch(/\bFunction\s*\(/);
    expect(javascript).not.toMatch(/setAttribute\(\s*["'](?:href|src|style|on[a-z]+)/i);
    expect(javascript).not.toMatch(/createElementNS\([^)]*foreignObject/i);
  });

  test("keeps credentials ephemeral and calls only closed observer routes", async () => {
    const javascript = await readAsset("app.js");
    const literalApiPaths = [...javascript.matchAll(/["'`](\/api\/[^"'`?]*)/g)].map((match) => match[1]);
    const allowedPaths = new Set([
      "/api/session",
      "/api/bootstrap",
      "/api/family/select",
      "/api/family/snapshot",
      "/api/family/detail",
      "/api/family/stream",
    ]);

    expect(new Set(literalApiPaths)).toEqual(allowedPaths);
    expect(javascript).toContain("X-Agencity-Observe-Bootstrap");
    expect(javascript).toContain("window.history.replaceState");
    expect(javascript).toContain('credentials: "same-origin"');
    expect(javascript).not.toContain("local" + "Storage");
    expect(javascript).not.toContain("session" + "Storage");
    expect(javascript).not.toContain("Authorization");
    expect(javascript).not.toMatch(/\bBearer\b/i);
    expect(javascript).not.toMatch(/\/(?:health|capabilities|product|branches|proxy)\b/);
    expect(javascript.replace("http://www.w3.org/2000/svg", "")).not.toMatch(/https?:\/\//i);
  });

  test("allowlists bounded lazy detail sections and browser rails", async () => {
    const javascript = await readAsset("app.js");
    for (const section of [
      "identity",
      "runs",
      "model_attempts",
      "cells",
      "effects",
      "tasks",
      "mailbox",
      "budget",
      "goals",
      "gates",
      "artifacts",
      "terminal_outcomes",
    ]) {
      expect(javascript).toContain(`["${section}",`);
    }

    expect(javascript).toContain("const MAX_ROOTS = 100");
    expect(javascript).toContain("const MAX_ROUTES = 64");
    expect(javascript).toContain("const MAX_DETAIL_ITEMS = 50");
    expect(javascript).toContain("const MAX_RAIL_ITEMS = 200");
    expect(javascript).toContain("const MAX_RAIL_BYTES = 1024 * 1024");
    expect(javascript).toContain('query.set("section", section)');
    expect(javascript).toContain("DETAIL_SECTIONS.some");
  });

  test("renders trusted-local and data-sensitivity guidance", async () => {
    const html = await readAsset("index.html");
    expect(html).toContain("Trusted local observer.");
    expect(html).toContain("can be sensitive");
    expect(html).toContain("not a security sandbox");
  });
});

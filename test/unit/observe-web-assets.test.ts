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

  test("keeps authority, sensitivity, and quiescence guidance visible without a callout", async () => {
    const html = await readAsset("index.html");
    expect(html).toContain("Trusted local · Read-only · Sensitive data");
    expect(html).toContain("Attached viewing can keep the managed service active");
    expect(html).not.toContain('class="trust-notice"');
  });

  test("pretty-prints and syntax-highlights structured detail without markup injection", async () => {
    const javascript = await readAsset("app.js");
    const css = await readAsset("app.css");

    expect(javascript).toContain("function appendHighlightedJson");
    expect(javascript).toContain("JSON.stringify(normalizedStructuredValue(value, 0), null, 2)");
    expect(javascript).toContain('asObject(value).kind === "complete" ? parsedJsonContainer');
    expect(javascript).toContain('token.className = /^\\s*:/.test');
    expect(javascript).toContain('token.textContent = text');
    expect(javascript).toContain('document.createTextNode(source.slice');
    expect(css).toContain(".json-view");
    expect(css).toContain(".json-key");
    expect(css).toContain(".json-string");
    expect(css).toContain(".json-number");
    expect(css).toContain(".json-boolean");
    expect(css).toContain(".json-null");
  });

  test("prioritizes current work and keeps route detail in context", async () => {
    const html = await readAsset("index.html");
    const javascript = await readAsset("app.js");
    const css = await readAsset("app.css");

    expect(html).toContain('id="current-work-title"');
    expect(html).toContain('class="connection-details"');
    expect(html).toContain('class="route-inspector"');
    expect(html).not.toContain('data-depth="inspect"');
    expect(javascript).toContain("groupedActivities");
    expect(javascript).toContain("Model response requested");
    expect(javascript).toContain("TypeScript action completed");
    expect(javascript).toContain("state.inspectorOpen = true");
    expect(javascript).toContain("new ResizeObserver(scheduleGraphLayout)");
    expect(javascript).toContain('firstValue(item, ["sessionTitle"]');
    expect(javascript).toContain('firstValue(source, ["sessionTitle"]');
    expect(javascript).toContain('firstValue(titleSource, ["intentSummary"]');
    expect(javascript).toContain('text(button, node.model, "node-meta")');
    expect(javascript).not.toContain('text(button, node.branchName + " · depth " + node.depth, "node-meta")');
    expect(css).toContain("min-height: clamp(32rem, 68vh, 52rem)");
  });

  test("ships fitted hierarchical graph controls and orthogonal routing", async () => {
    const html = await readAsset("index.html");
    const javascript = await readAsset("app.js");
    const css = await readAsset("app.css");

    expect(html).toContain('id="graph-zoom-out"');
    expect(html).toContain('id="graph-zoom-fit"');
    expect(html).toContain('id="graph-zoom-in"');
    expect(javascript).toContain("function subtreeSpan");
    expect(javascript).toContain("function fittedGraphZoom");
    expect(javascript).toContain("function bindGraphPanning");
    expect(javascript).toContain("function applyGraphPan");
    expect(javascript).toContain('setPointerCapture(event.pointerId)');
    expect(javascript).toContain('event.target.closest(".route-node")');
    expect(javascript).toContain('"A", radius, radius');
    expect(javascript).not.toContain('"Q", middleX');
    expect(javascript).not.toContain('" C "');
    expect(css).toContain("cursor: grabbing");
    expect(css).toContain("vector-effect: non-scaling-stroke");
  });
});

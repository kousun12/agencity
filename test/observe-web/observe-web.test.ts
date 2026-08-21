import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  HOSTILE_DETAIL_TEXT,
  ObserveProtocolFixture,
  freshObserveWorkspace,
  publishFixtureManifest,
} from "./helpers.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");

async function observerUrl(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.value) text += decoder.decode(result.value, { stream: !result.done });
      const newline = text.indexOf("\n");
      if (newline >= 0) return text.slice(0, newline).trim();
      if (result.done) throw new Error(`Observer exited before printing its URL: ${text}`);
    }
  } finally {
    reader.releaseLock();
  }
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(25);
  }
  throw new Error(`${message}${lastError ? `: ${String(lastError)}` : ""}`);
}

test("Chromium observes a live family through the foreground CLI", async () => {
  const workspace = await freshObserveWorkspace();
  const fixtureOne = new ObserveProtocolFixture("instance-one");
  let fixtureTwo: ObserveProtocolFixture | null = null;
  let observer: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let observerStderr: Promise<string> | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    await publishFixtureManifest(workspace, fixtureOne);
    observer = Bun.spawn([
      process.execPath,
      resolve(repositoryRoot, "src/cli.ts"),
      "observe",
      "--workspace",
      workspace,
    ], {
      cwd: repositoryRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    observerStderr = new Response(observer.stderr).text();
    const printedUrl = await observerUrl(observer.stdout);
    expect(printedUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43}$/);
    const parsedUrl = new URL(printedUrl);
    const bootstrapToken = new URLSearchParams(parsedUrl.hash.slice(1)).get("token");
    expect(bootstrapToken).toHaveLength(43);
    const origin = parsedUrl.origin;

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const externalRequests: string[] = [];
    let sessionExchangeCount = 0;
    page.on("console", message => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("request", request => {
      const url = request.url();
      if (url === `${origin}/api/session`) sessionExchangeCount += 1;
      if (!url.startsWith(`${origin}/`)) externalRequests.push(url);
    });
    await page.addInitScript(() => {
      const target = globalThis as typeof globalThis & {
        __agencityCspViolations?: string[];
        __agencityHostile?: boolean;
      };
      target.__agencityCspViolations = [];
      document.addEventListener("securitypolicyviolation", event => {
        target.__agencityCspViolations!.push(
          `${event.violatedDirective}:${event.blockedURI}`,
        );
      });
    });

    await page.goto(printedUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => location.hash === "");
    await page.locator("#root-panel").waitFor({ state: "visible" });
    expect(page.url()).toBe(`${origin}/`);
    expect(sessionExchangeCount).toBe(1);
    const cookies = await context.cookies(`${origin}/api/bootstrap`);
    expect(cookies).toContainEqual(expect.objectContaining({
      name: "agencity_observe_session",
      httpOnly: true,
      sameSite: "Strict",
      path: "/api",
    }));
    const initialStorage = await page.evaluate(() => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }));
    expect(initialStorage).toEqual({ local: [], session: [] });
    expect(JSON.stringify(initialStorage)).not.toContain(bootstrapToken!);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#root-panel").waitFor({ state: "visible" });
    expect(page.url()).toBe(`${origin}/`);
    expect(sessionExchangeCount).toBe(1);
    expect(await page.locator(".root-option").count()).toBe(2);
    expect(await page.evaluate(() => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }))).toEqual({ local: [], session: [] });
    expect(await page.locator("body").textContent()).not.toContain(fixtureOne.bearerToken);
    await page.getByRole("button", { name: /Root Alpha/ }).click();
    await page.locator("#observer-main").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Inspect Root Alpha" }).waitFor();
    expect(await page.locator("#current-work-title").textContent()).toBe("Root Alpha");
    expect(await page.locator(".connection-details").evaluate(element => element.hasAttribute("open"))).toBe(false);
    expect(await page.locator(".surface-note").textContent()).toContain("Trusted local · Read-only · Sensitive data");
    expect(await page.locator(".surface-note").textContent()).toContain("Attached viewing can keep the managed service active");
    expect(await page.locator(".route-node").count()).toBe(1);
    expect(await page.locator("#family-graph").evaluate(element =>
      element.scrollWidth <= element.clientWidth + 1
    )).toBe(true);
    expect(await page.locator("#graph-zoom-level").textContent()).toBe("100%");
    await page.getByRole("button", { name: "Zoom out" }).click();
    expect(await page.locator("#graph-zoom-level").textContent()).not.toBe("100%");
    await page.getByRole("button", { name: "Fit" }).click();
    expect(await page.locator("#graph-zoom-level").textContent()).toBe("100%");
    expect(await page.locator(".graph-panel").evaluate(panel => {
      const graph = panel.querySelector("#family-graph");
      if (!(graph instanceof HTMLElement)) return false;
      const panelBounds = panel.getBoundingClientRect();
      const graphBounds = graph.getBoundingClientRect();
      return graphBounds.height >= 512 && panelBounds.bottom - graphBounds.bottom <= 18;
    })).toBe(true);
    await waitFor(
      () => fixtureOne.activeStreams === 1,
      "Observer did not attach the root branch stream",
    );

    fixtureOne.admitChild();
    await page.getByRole("button", { name: "Inspect Live Child" }).waitFor();
    expect(await page.locator(".route-node").count()).toBe(2);
    expect(await page.locator(".graph-edge").first().getAttribute("d")).not.toContain("C");
    const graph = page.locator("#family-graph");
    const graphBounds = await graph.boundingBox();
    const canvasBeforePan = await page.locator("#graph-canvas").boundingBox();
    expect(graphBounds).not.toBeNull();
    expect(canvasBeforePan).not.toBeNull();
    await page.mouse.move(graphBounds!.x + 32, graphBounds!.y + 32);
    await page.mouse.down();
    await page.mouse.move(graphBounds!.x + 112, graphBounds!.y + 82, { steps: 4 });
    await page.mouse.up();
    const canvasAfterPan = await page.locator("#graph-canvas").boundingBox();
    expect(canvasAfterPan!.x - canvasBeforePan!.x).toBeGreaterThan(70);
    expect(canvasAfterPan!.y - canvasBeforePan!.y).toBeGreaterThan(40);
    expect(await page.locator("#activity-count").textContent()).toContain("update");
    await waitFor(
      () => fixtureOne.activeStreams === 2,
      "Observer did not attach the child branch stream",
    );

    fixtureOne.sendMailboxMessage();
    await waitFor(
      async () => await page!.locator(".graph-edge.message").count() === 1,
      "Committed mailbox message did not render a message edge",
    );
    await page.locator(".activity-group").first().waitFor();
    expect(Number.parseInt((await page.locator("#activity-count").textContent()) || "0", 10)).toBeGreaterThan(0);
    expect(await page.locator("#family-graph").textContent()).toContain("Live Child");

    await page.getByRole("button", { name: "Inspect Root Alpha" }).click();
    await page.locator("#inspect-panel").waitFor({ state: "visible" });
    await page.locator("#overview-panel").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Cells", exact: true }).click();
    await page.locator("#detail-list .detail-card").waitFor();
    const detailText = await page.locator("#detail-list").textContent();
    expect(detailText).toContain(HOSTILE_DETAIL_TEXT);
    expect(await page.locator("#detail-list script").count()).toBe(0);
    expect(await page.locator("#detail-list img").count()).toBe(0);
    expect(await page.locator("#detail-list svg").count()).toBe(0);
    expect(await page.evaluate(() => {
      const target = globalThis as typeof globalThis & { __agencityHostile?: boolean };
      return target.__agencityHostile;
    })).toBeUndefined();
    await page.getByRole("button", { name: "Close route details" }).click();
    await page.locator("#inspect-panel").waitFor({ state: "hidden" });

    const firstGeneration = (await page.locator("#generation-name").textContent())!;
    fixtureTwo = new ObserveProtocolFixture("instance-two", fixtureOne.exportStates());
    await publishFixtureManifest(workspace, fixtureTwo);
    await waitFor(
      async () => await page!.locator("#instance-name").textContent() === "instance-two",
      "Browser did not display the replacement managed instance",
    );
    await waitFor(
      async () => {
        const generation = await page!.locator("#generation-name").textContent();
        return Boolean(generation && generation !== firstGeneration && generation !== "—");
      },
      "Browser did not display a replacement observer generation",
    );
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Inspect Live Child" }).waitFor();
    expect(await page.locator(".graph-edge.message").count()).toBe(1);
    expect(await page.locator("#events-count").textContent()).toBe("0");
    await waitFor(
      () => fixtureOne.activeStreams === 0 && fixtureOne.cancelledStreams >= 2,
      "Replacement did not cancel every old managed branch stream",
    );
    await waitFor(
      () => fixtureTwo!.activeStreams === 2,
      "Replacement did not attach equivalent root and child streams",
    );

    const cspViolations = await page.evaluate(() => {
      const target = globalThis as typeof globalThis & { __agencityCspViolations?: string[] };
      return target.__agencityCspViolations ?? [];
    });
    expect(cspViolations).toEqual([]);
    expect(consoleErrors.filter(message => /content security policy/i.test(message))).toEqual([]);
    expect(externalRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);

    await page.close();
    page = null;
    await context.close();
    context = null;
    await waitFor(
      () => fixtureOne.activeStreams === 0 &&
        fixtureTwo!.activeStreams === 0 &&
        fixtureTwo!.cancelledStreams >= 2,
      "Closing the final browser did not cancel every managed branch stream",
    );

    observer.kill("SIGTERM");
    expect(await observer.exited).toBe(0);
    const observerErrorOutput = await observerStderr;
    expect(observerErrorOutput).toBe("");
    observer = null;
    observerStderr = null;

    const health = await fetch(`${fixtureTwo.url}/health`, {
      headers: { Authorization: `Bearer ${fixtureTwo.bearerToken}` },
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      instanceId: "instance-two",
    });
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (observer) {
      observer.kill("SIGTERM");
      const stopped = await Promise.race([
        observer.exited.then(() => true).catch(() => true),
        Bun.sleep(5_000).then(() => false),
      ]);
      if (!stopped) {
        observer.kill("SIGKILL");
        await observer.exited.catch(() => -1);
      }
      await observerStderr?.catch(() => "");
    }
    fixtureTwo?.stop();
    fixtureOne.stop();
    await rm(workspace, { recursive: true, force: true });
  }
}, 90_000);

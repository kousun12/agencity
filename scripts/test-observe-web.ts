import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const INSTALL_GUIDANCE = "Playwright Chromium is not installed. Run `bunx playwright install chromium`.";
const repositoryRoot = resolve(import.meta.dir, "..");

try {
  await access(chromium.executablePath());
} catch {
  console.error(INSTALL_GUIDANCE);
  process.exit(1);
}

const test = Bun.spawn([
  process.execPath,
  "test",
  "--timeout",
  "90000",
  "test/observe-web/observe-web.test.ts",
], {
  cwd: repositoryRoot,
  env: process.env,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await test.exited);

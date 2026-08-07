import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ModelCredentialStore,
  containsBrokeredSecret,
  inspectModelCredentialStatuses,
  scrubText,
} from "../../src/index.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("owner-only model credential storage", () => {
  test("persists supported keys with mode 0600 and registers them for rejection and redaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agencity-model-auth-"));
    directories.push(directory);
    const path = join(directory, "auth.json");
    const secret = "provider-secret-value-123456";
    const store = await ModelCredentialStore.open(path, {});
    try {
      expect(store.status("anthropic")).toMatchObject({ configured: false, source: "missing" });
      expect(await store.set("anthropic", secret)).toMatchObject({ configured: true, source: "stored" });
      expect((await stat(path)).mode & 0o077).toBe(0);
      expect(containsBrokeredSecret({ value: secret })).toBe(true);
      expect(scrubText(`failure: ${secret}`)).toBe("failure: [REDACTED]");
    } finally { store.close(); }

    const reopened = await ModelCredentialStore.open(path, { ANTHROPIC_API_KEY: "environment-fallback-123" });
    try {
      expect(reopened.resolve("anthropic")).toBe(secret);
      expect(reopened.status("anthropic").source).toBe("stored");
      await reopened.remove("anthropic");
      expect(reopened.resolve("anthropic")).toBe("environment-fallback-123");
      expect(reopened.status("anthropic").source).toBe("environment");
    } finally { reopened.close(); }
  });

  test("rejects unsupported providers and malformed credential values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agencity-model-auth-invalid-"));
    directories.push(directory);
    const store = await ModelCredentialStore.open(join(directory, "auth.json"), {});
    try {
      await expect(store.set("other", "long-enough-secret")).rejects.toThrow("Unsupported model provider");
      await expect(store.set("openai", " short ")).rejects.toThrow("API key");
    } finally { store.close(); }
  });

  test("does not register partially validated credential files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agencity-model-auth-partial-"));
    directories.push(directory);
    const path = join(directory, "auth.json");
    const validSecret = "valid-provider-secret-123456";
    await writeFile(path, JSON.stringify({
      version: 1,
      providers: {
        openai: { apiKey: validSecret },
        anthropic: { apiKey: " short " },
      },
    }), { mode: 0o600 });

    await expect(ModelCredentialStore.open(path, {})).rejects.toThrow("API key");
    expect(containsBrokeredSecret({ value: validSecret })).toBe(false);
  });

  test("reports stored and environment credentials without registering their values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agencity-model-auth-inspect-"));
    directories.push(directory);
    const path = join(directory, "auth.json");
    const storedSecret = "stored-provider-secret-123456";
    const environmentSecret = "environment-provider-secret-123456";
    await writeFile(path, JSON.stringify({
      version: 1,
      providers: { openai: { apiKey: storedSecret } },
    }), { mode: 0o600 });

    expect(await inspectModelCredentialStatuses(path, { ANTHROPIC_API_KEY: environmentSecret })).toEqual([
      expect.objectContaining({ provider: "openai", configured: true, source: "stored" }),
      expect.objectContaining({ provider: "anthropic", configured: true, source: "environment" }),
      expect.objectContaining({ provider: "vercel", configured: false, source: "missing" }),
    ]);
    expect(containsBrokeredSecret({ storedSecret, environmentSecret })).toBe(false);
  });
});

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ValidationError } from "../domain/index.ts";
import { registerBrokeredSecret } from "./scrub.ts";

export const supportedModelProviderNames = ["openai", "anthropic", "vercel"] as const;
export type SupportedModelProviderName = (typeof supportedModelProviderNames)[number];
export type ModelCredentialSource = "stored" | "environment" | "missing";

export interface ModelProviderCredentialStatus {
  readonly provider: SupportedModelProviderName;
  readonly source: ModelCredentialSource;
  readonly configured: boolean;
  readonly environmentVariable: string;
}

const ENVIRONMENT_KEYS: Readonly<Record<SupportedModelProviderName, string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  vercel: "AI_GATEWAY_API_KEY",
};

interface StoredCredentialFile {
  readonly version: 1;
  readonly providers: Partial<Record<SupportedModelProviderName, { readonly apiKey: string }>>;
}

function assertApiKey(apiKey: string): void {
  if (!apiKey || apiKey !== apiKey.trim() || apiKey.length < 8 || apiKey.length > 16_384 || /[\r\n\0]/.test(apiKey)) {
    throw new ValidationError("API key must be a single non-empty credential value");
  }
}

async function readStoredCredentials(path: string): Promise<Map<SupportedModelProviderName, string> | null> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new ValidationError("Model credential file is invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1 ||
      !(parsed as { providers?: unknown }).providers ||
      typeof (parsed as { providers?: unknown }).providers !== "object" ||
      Array.isArray((parsed as { providers?: unknown }).providers)) {
    throw new ValidationError("Model credential file has an unsupported format");
  }
  const records = new Map<SupportedModelProviderName, string>();
  const providers = (parsed as StoredCredentialFile).providers;
  for (const provider of supportedModelProviderNames) {
    const record = providers[provider];
    if (record === undefined) continue;
    if (!record || typeof record !== "object" || typeof record.apiKey !== "string") {
      throw new ValidationError(`Stored ${provider} credential is invalid`);
    }
    assertApiKey(record.apiKey);
    records.set(provider, record.apiKey);
  }
  return records;
}

export function isSupportedModelProvider(value: string): value is SupportedModelProviderName {
  return supportedModelProviderNames.includes(value as SupportedModelProviderName);
}

export function modelCredentialPathForProfile(profileDatabasePath: string): string {
  return join(dirname(profileDatabasePath), "auth.json");
}

/** Read-only status inspection for doctor and other observer-only commands. */
export async function inspectModelCredentialStatuses(
  path: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ModelProviderCredentialStatus[]> {
  const stored = await readStoredCredentials(path);
  return supportedModelProviderNames.map(provider => {
    const source: ModelCredentialSource = stored?.has(provider)
      ? "stored"
      : environment[ENVIRONMENT_KEYS[provider]]?.trim() ? "environment" : "missing";
    return {
      provider,
      source,
      configured: source !== "missing",
      environmentVariable: ENVIRONMENT_KEYS[provider],
    };
  });
}

/**
 * Owner-only local credential storage. Values never enter profile/workspace
 * databases, events, protocol responses, model context, or generated workers.
 */
export class ModelCredentialStore {
  readonly #keys = new Map<SupportedModelProviderName, string>();
  readonly #releases = new Map<SupportedModelProviderName, () => void>();
  #writes: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    readonly path: string,
    readonly environment: NodeJS.ProcessEnv,
  ) {}

  static async open(path: string, environment: NodeJS.ProcessEnv = process.env): Promise<ModelCredentialStore> {
    const store = new ModelCredentialStore(path, environment);
    const stored = await readStoredCredentials(path);
    if (!stored) return store;
    await chmod(path, 0o600);
    for (const [provider, apiKey] of stored) store.#install(provider, apiKey);
    return store;
  }

  resolve(provider: SupportedModelProviderName): string | undefined {
    return this.#keys.get(provider) ?? (this.environment[ENVIRONMENT_KEYS[provider]]?.trim() || undefined);
  }

  status(provider: SupportedModelProviderName): ModelProviderCredentialStatus {
    const source: ModelCredentialSource = this.#keys.has(provider)
      ? "stored"
      : this.environment[ENVIRONMENT_KEYS[provider]]?.trim() ? "environment" : "missing";
    return {
      provider,
      source,
      configured: source !== "missing",
      environmentVariable: ENVIRONMENT_KEYS[provider],
    };
  }

  statuses(): ModelProviderCredentialStatus[] {
    return supportedModelProviderNames.map(provider => this.status(provider));
  }

  async set(provider: string, apiKey: string): Promise<ModelProviderCredentialStatus> {
    this.#assertOpen();
    if (!isSupportedModelProvider(provider)) throw new ValidationError(`Unsupported model provider: ${provider}`);
    this.#assertKey(apiKey);
    await this.#serialize(async () => {
      const next = new Map(this.#keys);
      next.set(provider, apiKey);
      await this.#persist(next);
      this.#install(provider, apiKey);
    });
    return this.status(provider);
  }

  async remove(provider: string): Promise<ModelProviderCredentialStatus> {
    this.#assertOpen();
    if (!isSupportedModelProvider(provider)) throw new ValidationError(`Unsupported model provider: ${provider}`);
    await this.#serialize(async () => {
      const next = new Map(this.#keys);
      next.delete(provider);
      await this.#persist(next);
      this.#releases.get(provider)?.();
      this.#releases.delete(provider);
      this.#keys.delete(provider);
    });
    return this.status(provider);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const release of this.#releases.values()) release();
    this.#releases.clear();
    this.#keys.clear();
  }

  #install(provider: SupportedModelProviderName, apiKey: string): void {
    if (this.#keys.get(provider) === apiKey) return;
    this.#releases.get(provider)?.();
    this.#keys.set(provider, apiKey);
    this.#releases.set(provider, registerBrokeredSecret(apiKey));
  }

  #assertKey(apiKey: string): void {
    assertApiKey(apiKey);
  }

  #assertOpen(): void {
    if (this.#closed) throw new ValidationError("Model credential store is closed");
  }

  async #serialize(operation: () => Promise<void>): Promise<void> {
    const prior = this.#writes;
    let release = (): void => {};
    this.#writes = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { await operation(); }
    finally { release(); }
  }

  async #persist(keys: ReadonlyMap<SupportedModelProviderName, string>): Promise<void> {
    const providers: StoredCredentialFile["providers"] = {};
    for (const [provider, apiKey] of keys) providers[provider] = { apiKey };
    const content = `${JSON.stringify({ version: 1, providers } satisfies StoredCredentialFile, null, 2)}\n`;
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}

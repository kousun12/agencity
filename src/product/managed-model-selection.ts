import type { ParsedCliArgs } from "../cli-args.ts";
import {
  STANDARD_UNVERIFIED_REASONING_LEVELS,
  ValidationError,
  assertReasoningSelection,
  normalizeReasoningEffort,
  validateCanonicalProductModelId,
  type ModelConfiguration,
  type ModelDescriptor,
  type ReasoningEffort,
} from "../domain/index.ts";
import type { ModelProviderDescriptor } from "../executors/index.ts";
import { providerAcceptsCanonicalModel } from "./model-selection.ts";
import { formatModel, parseModel } from "./providers.ts";

const PRODUCT_MODEL_TRANSPORTS = new Set(["openai", "anthropic", "vercel"]);

interface ManagedModelCatalogResult {
  readonly endpointId?: string;
  readonly origin?: string;
  readonly status?: "refreshed" | "cached-fallback" | "unavailable";
  readonly descriptors: readonly ModelDescriptor[];
  readonly error?: string;
}

interface ManagedModelClient {
  readonly modelProviders: () => Promise<readonly ModelProviderDescriptor[]>;
  readonly productConfig: () => Promise<{
    readonly defaultModel: string | null;
    readonly selectedModelEffortPreference: ReasoningEffort | null;
  }>;
  readonly modelCatalog: () => Promise<ManagedModelCatalogResult>;
  readonly agentToolCapability: (model: ModelConfiguration) => Promise<{
    readonly selected?: {
      readonly admission: "allowed" | "rejected";
      readonly reason?: string;
    };
  }>;
  readonly productSetModel: (model: string) => Promise<unknown>;
  readonly productSetProviderKey: (
    provider: string,
    secret: string,
  ) => Promise<unknown>;
}

interface ManagedModelPrompter {
  readonly secret: (question: string) => Promise<string>;
  readonly selectProvider: (
    providers: readonly ModelProviderDescriptor[],
    introduction?: string,
  ) => Promise<ModelProviderDescriptor>;
  readonly selectModel: (
    provider: ModelProviderDescriptor,
    catalogRequest: Promise<ManagedModelCatalogResult>,
  ) => Promise<string>;
  readonly selectCustomModel: (
    provider: ModelProviderDescriptor,
  ) => Promise<string>;
}

class SelectedModelAdmissionRejectedError extends ValidationError {}

export async function chooseManagedModel(
  client: ManagedModelClient,
  parsed: ParsedCliArgs,
  interactive: boolean,
  prompter: ManagedModelPrompter,
): Promise<ModelConfiguration> {
  const explicit = parsed.values.get("model");
  const providers = (await client.modelProviders()).filter(provider => provider.name !== "echo");
  let configPromise: Promise<{
    readonly defaultModel: string | null;
    readonly selectedModelEffortPreference: ReasoningEffort | null;
  }> | null = null;
  let catalogPromise: Promise<ManagedModelCatalogResult> | null = null;
  const productConfig = () => configPromise ??= client.productConfig();
  const modelCatalog = () => catalogPromise ??= client.modelCatalog();
  const finish = async (
    requested: ModelConfiguration,
    persist: boolean,
  ): Promise<ModelConfiguration> => {
    const model = normalizeSelectedManagedModel(requested);
    const productTransport = PRODUCT_MODEL_TRANSPORTS.has(model.provider);
    const explicitEffort = parsed.values.get("effort");
    const config = await productConfig();
    const catalog = productTransport
      ? await modelCatalog().catch(() => ({
          descriptors: Object.freeze([] as ModelDescriptor[]),
        }))
      : { descriptors: Object.freeze([]) };
    let effort: ReasoningEffort = "provider-default";
    let ambient = false;
    if (explicitEffort !== undefined) effort = normalizeReasoningEffort(explicitEffort);
    else if (config.defaultModel === formatModel(model) && typeof config.selectedModelEffortPreference === "string") {
      effort = config.selectedModelEffortPreference;
      ambient = true;
    }
    if (explicitEffort !== undefined || ambient) try {
      const capability = catalog.descriptors.find(descriptor => descriptor.model === model.model)?.reasoning ?? {
        status: "unverified" as const,
        levels: STANDARD_UNVERIFIED_REASONING_LEVELS,
      };
      assertReasoningSelection(effort, capability);
    } catch (error) {
      if (!ambient) throw error;
      process.stderr.write(`Stored reasoning effort is no longer valid; using provider-default. ${error instanceof Error ? error.message : String(error)}\n`);
      effort = "provider-default";
    }
    const normalized = { ...model, reasoningEffort: effort };
    if (productTransport) {
      const selected = (await client.agentToolCapability(normalized)).selected;
      if (!selected) {
        throw new ValidationError(
          "The service did not return selected model capability",
        );
      }
      if (selected.admission === "rejected") {
        throw new SelectedModelAdmissionRejectedError(
          selected.reason ??
            `The selected ${normalized.provider}:${normalized.model} combination cannot run the fixed bun_console and finish contract`,
        );
      }
    }
    if (persist) {
      const persisted = await client.productSetModel(formatModel(normalized));
      const defaultModel = persisted && typeof persisted === "object" &&
          !Array.isArray(persisted) &&
          typeof (persisted as { defaultModel?: unknown }).defaultModel === "string"
        ? (persisted as { defaultModel: string }).defaultModel
        : null;
      if (defaultModel) {
        const stored = parseModel(defaultModel);
        return { ...stored, reasoningEffort: effort };
      }
    }
    return normalized;
  };
  if (explicit) {
    const model = normalizeSelectedManagedModel(parseModel(explicit));
    if (model.provider === "echo") throw new ValidationError("Echo is an internal test fixture and is not available in the product");
    let provider = providers.find(provider => provider.name === model.provider);
    if (!provider) throw new ValidationError(`Model provider is unavailable: ${model.provider}`);
    if (!provider.usable) {
      if (!interactive || !["openai", "anthropic", "vercel"].includes(provider.name)) {
        throw new ValidationError(provider.remediation ?? `Model provider is unavailable: ${model.provider}`);
      }
      const apiKey = await prompter.secret(`API key for ${provider.displayName} (input hidden): `);
      if (!apiKey) throw new ValidationError("Provider API key is required");
      await client.productSetProviderKey(provider.name, apiKey);
      provider = (await client.modelProviders()).find(candidate => candidate.name === model.provider);
      if (!provider?.usable) throw new ValidationError(provider?.remediation ?? `Credential unavailable for ${model.provider}`);
    }
    return finish(model, true);
  }
  const configured = await productConfig();
  if (configured.defaultModel) {
    let model: ModelConfiguration | null = null;
    let invalidDefault: unknown = null;
    try {
      model = normalizeSelectedManagedModel(parseModel(configured.defaultModel));
      if (!providers.some(provider => provider.name === model!.provider)) {
        throw new ValidationError(
          `Model provider is unavailable: ${model.provider}`,
        );
      }
    } catch (error) {
      invalidDefault = error;
    }
    if (invalidDefault !== null) {
      const diagnostic = `Stored workspace model preference is invalid: ${
        invalidDefault instanceof Error ? invalidDefault.message : String(invalidDefault)
      }`;
      if (!interactive) {
        throw new ValidationError(`${diagnostic}. Configure provider credentials and pass --model PROVIDER:MODEL, or run Agencity in an interactive terminal`);
      }
      process.stderr.write(`${diagnostic}. Choose a replacement; the stored value remains available for diagnostics until confirmation.\n`);
    } else if (
      model &&
      providers.some(provider =>
        provider.name === model!.provider && provider.usable
      )
    ) {
      try {
        return await finish(model, false);
      } catch (error) {
        if (!(error instanceof SelectedModelAdmissionRejectedError)) throw error;
        const diagnostic =
          `Stored workspace model preference cannot run the fixed agent tool contract: ${error.message}`;
        if (!interactive) {
          throw new ValidationError(
            `${diagnostic}. Configure a supported model with --model PROVIDER:MODEL, or run Agencity in an interactive terminal`,
          );
        }
        process.stderr.write(
          `${diagnostic}. Choose a replacement; the stored value remains available for diagnostics until confirmation.\n`,
        );
      }
    }
  }
  let usable = providers.filter(provider => provider.usable);
  for (const provider of usable) {
    const model = process.env[`${provider.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_MODEL`];
    if (model?.trim()) {
      return finish({
        provider: provider.name,
        model: model.trim(),
        reasoningEffort: "provider-default",
      }, true);
    }
  }
  if (!interactive) {
    throw new ValidationError("No usable model is selected. Configure provider credentials and pass --model PROVIDER:MODEL, or run Agencity in an interactive terminal");
  }
  if (!usable.length) {
    const candidates = providers.filter(provider => ["openai", "anthropic", "vercel"].includes(provider.name));
    const selected = await prompter.selectProvider(
      candidates,
      "No model provider is configured.\n",
    );
    const apiKey = await prompter.secret(`API key for ${selected.displayName} (input hidden): `);
    if (!apiKey) throw new ValidationError("Provider API key is required");
    await client.productSetProviderKey(selected.name, apiKey);
    const refreshed = (await client.modelProviders()).filter(provider => provider.name !== "echo");
    const configuredProvider = refreshed.find(provider => provider.name === selected.name);
    if (!configuredProvider?.usable) throw new ValidationError(configuredProvider?.remediation ?? `Credential unavailable for ${selected.name}`);
    usable = [configuredProvider];
  }
  const provider = usable.length === 1
    ? usable[0]!
    : await prompter.selectProvider(usable);
  const environmentModel = process.env[`${provider.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_MODEL`]?.trim();
  if (environmentModel) {
    return finish({
      provider: provider.name,
      model: environmentModel,
      reasoningEffort: "provider-default",
    }, true);
  }
  const modelId = PRODUCT_MODEL_TRANSPORTS.has(provider.name)
    ? await prompter.selectModel(provider, modelCatalog())
    : await prompter.selectCustomModel(provider);
  return finish({
    provider: provider.name,
    model: modelId,
    reasoningEffort: "provider-default",
  }, true);
}

export function normalizeSelectedManagedModel(
  model: ModelConfiguration,
): ModelConfiguration {
  const provider = model.provider.trim().toLowerCase();
  const providerModel = model.model.trim();
  if (!providerModel) {
    throw new ValidationError("Model configuration requires provider and model");
  }
  if (!PRODUCT_MODEL_TRANSPORTS.has(provider)) {
    // Embedded providers retain their own model grammar and normalize again at
    // the authoritative service boundary before preference/session writes.
    return { ...model, provider, model: providerModel };
  }
  const canonical = validateCanonicalProductModelId(providerModel);
  if (!providerAcceptsCanonicalModel(provider, canonical)) {
    if (provider === "openai") {
      throw new ValidationError(
        "Direct OpenAI transport requires an openai/... canonical model ID",
      );
    }
    if (provider === "anthropic") {
      throw new ValidationError(
        "Direct Anthropic transport requires an anthropic/... canonical model ID",
      );
    }
    throw new ValidationError(
      `Provider ${provider} cannot select canonical model ${canonical}`,
    );
  }
  return { ...model, provider, model: canonical };
}

import { ValidationError, type ModelConfiguration } from "../domain/index.ts";
import type { Supervisor } from "../runtime/index.ts";
import { workspacePreferenceKey } from "./workspace.ts";

export interface ProviderStatus {
  readonly provider: string;
  readonly displayName: string;
  readonly usable: boolean;
  readonly credentialSource: "stored" | "environment" | "programmatic" | "missing";
  readonly remediation: string | null;
}

export function providerStatuses(supervisor: Supervisor): ProviderStatus[] {
  const descriptors = supervisor.modelProviders;
  const statuses: ProviderStatus[] = descriptors.filter(descriptor => descriptor.name !== "echo").map(descriptor => ({
    provider: descriptor.name,
    displayName: descriptor.displayName,
    usable: descriptor.usable,
    credentialSource: descriptor.credentialSource,
    remediation: descriptor.remediation ?? null,
  } satisfies ProviderStatus));
  const supported = [
    ["openai", "OpenAI", "OPENAI_API_KEY"],
    ["anthropic", "Anthropic", "ANTHROPIC_API_KEY"],
    ["vercel", "Vercel AI Gateway", "AI_GATEWAY_API_KEY"],
  ] as const;
  for (const [provider, displayName, environmentVariable] of supported) {
    if (statuses.some(status => status.provider === provider)) continue;
    statuses.push({
      provider,
      displayName,
      usable: false,
      credentialSource: "missing",
      remediation: `Use /model login ${provider} or set ${environmentVariable}.`,
    });
  }
  return statuses;
}

export function parseModel(value: string): ModelConfiguration {
  const trimmed = value.trim();
  const colon = trimmed.indexOf(":");
  const separator = colon >= 0 ? colon : trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) throw new ValidationError("Model must use PROVIDER:MODEL format");
  const provider = trimmed.slice(0, separator);
  const model = trimmed.slice(separator + 1);
  if (!/^[a-z][a-z0-9-]*$/.test(provider) || /\s/.test(model)) throw new ValidationError("Model must use PROVIDER:MODEL format");
  return { provider, model };
}

export function formatModel(model: ModelConfiguration): string {
  return `${model.provider}:${model.model}`;
}

export async function chooseNewModel(input: {
  readonly supervisor: Supervisor;
  readonly workspaceId: string;
  readonly explicitModel?: string;
  readonly interactive: boolean;
  readonly prompt?: (question: string) => Promise<string>;
  readonly promptSecret?: (question: string) => Promise<string>;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<ModelConfiguration> {
  const statuses = providerStatuses(input.supervisor);
  if (input.explicitModel) {
    const model = input.supervisor.normalizeModelConfiguration(parseModel(input.explicitModel));
    if (model.provider === "echo") throw new ValidationError("Echo is an internal test fixture and is not available in the product");
    let status = statuses.find(candidate => candidate.provider === model.provider);
    if (!status?.usable) {
      if (!input.interactive || !input.promptSecret || !["openai", "anthropic", "vercel"].includes(model.provider)) {
        throw new ValidationError(status?.remediation ?? `Model provider is unavailable: ${model.provider}`);
      }
      const apiKey = (await input.promptSecret(`API key for ${status?.displayName ?? model.provider} (input hidden): `)).trim();
      if (!apiKey) throw new ValidationError("Provider API key is required");
      await input.supervisor.credentials.set(model.provider, apiKey);
      status = providerStatuses(input.supervisor).find(candidate => candidate.provider === model.provider);
      if (!status?.usable) throw new ValidationError(status?.remediation ?? `Credential unavailable for ${model.provider}`);
    }
    await persistModel(input.supervisor, input.workspaceId, model);
    return model;
  }
  const preference = await input.supervisor.profile.getPreference(workspacePreferenceKey(input.workspaceId, "model"));
  if (typeof preference?.value === "string") {
    const model = input.supervisor.normalizeModelConfiguration(parseModel(preference.value));
    if (model.provider !== "echo" && statuses.some(status => status.provider === model.provider && status.usable)) return model;
  }
  const environment = input.environment ?? process.env;
  let usable = statuses.filter(status => status.usable);
  for (const status of usable) {
    const configured = environment[`${status.provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_MODEL`];
    if (configured?.trim()) {
      const model = input.supervisor.normalizeModelConfiguration({ provider: status.provider, model: configured.trim() });
      await persistModel(input.supervisor, input.workspaceId, model);
      return model;
    }
  }
  if (!input.interactive || !input.prompt) {
    throw new ValidationError("No usable model is selected. Configure provider credentials and pass --model PROVIDER:MODEL, or run Agencity in an interactive terminal");
  }
  if (!usable.length) {
    if (!input.promptSecret) throw new ValidationError("No model provider is configured. Add credentials for OpenAI, Anthropic, or Vercel AI Gateway");
    const provider = await chooseProvider(
      statuses.filter(status => ["openai", "anthropic", "vercel"].includes(status.provider)),
      input.prompt,
      "No model provider is configured.\n",
    );
    const apiKey = (await input.promptSecret(`API key for ${provider.displayName} (input hidden): `)).trim();
    if (!apiKey) throw new ValidationError("Provider API key is required");
    await input.supervisor.credentials.set(provider.provider, apiKey);
    usable = providerStatuses(input.supervisor).filter(status => status.usable);
  }
  const provider = usable.length === 1 ? usable[0]! : await chooseProvider(usable, input.prompt);
  const modelId = (await input.prompt(`Model ID for ${provider.displayName}: `)).trim();
  if (!modelId) throw new ValidationError("Model ID is required");
  const model = input.supervisor.normalizeModelConfiguration({ provider: provider.provider, model: modelId });
  await persistModel(input.supervisor, input.workspaceId, model);
  return model;
}

export function modelAvailability(supervisor: Supervisor, model: ModelConfiguration): ProviderStatus {
  const status = providerStatuses(supervisor).find(candidate => candidate.provider === model.provider);
  return status ?? { provider: model.provider, displayName: model.provider, usable: false, credentialSource: "missing", remediation: `Install or configure provider ${model.provider}, then resume without changing this branch's model.` };
}

async function persistModel(supervisor: Supervisor, workspaceId: string, model: ModelConfiguration): Promise<void> {
  await supervisor.profile.setPreference(workspacePreferenceKey(workspaceId, "model"), formatModel(supervisor.normalizeModelConfiguration(model)));
}

async function chooseProvider(
  providers: readonly ProviderStatus[],
  prompt: (question: string) => Promise<string>,
  introduction = "",
): Promise<ProviderStatus> {
  if (!providers.length) throw new ValidationError("No supported model provider is available");
  if (providers.length === 1) return providers[0]!;
  const choices = providers.map((status, index) => `${index + 1}) ${status.displayName} [${status.provider}]`).join("\n");
  const answer = (await prompt(`${introduction}Choose a provider:
${choices}
Provider number or ID: `)).trim();
  const provider = providers[Number(answer) - 1] ?? providers.find(status => status.provider === answer);
  if (!provider) throw new ValidationError(`Unknown provider selection: ${answer}`);
  return provider;
}

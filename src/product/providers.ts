import { ValidationError, type ModelConfiguration } from "../domain/index.ts";
import type { Supervisor } from "../runtime/index.ts";
import { workspacePreferenceKey } from "./workspace.ts";

export interface ProviderStatus {
  readonly provider: string;
  readonly displayName: string;
  readonly usable: boolean;
  readonly demo: boolean;
  readonly credentialSource: "stored" | "environment" | "programmatic" | "missing";
  readonly remediation: string | null;
}

export function providerStatuses(supervisor: Supervisor): ProviderStatus[] {
  const descriptors = supervisor.modelProviders;
  const statuses: ProviderStatus[] = descriptors.map(descriptor => ({
    provider: descriptor.name,
    displayName: descriptor.displayName,
    usable: descriptor.usable,
    demo: descriptor.name === "echo",
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
      demo: false,
      credentialSource: "missing",
      remediation: `Use /model login ${provider} or set ${environmentVariable}.`,
    });
  }
  return statuses.sort((a, b) => Number(a.demo) - Number(b.demo) || a.provider.localeCompare(b.provider));
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
  readonly demo: boolean;
  readonly interactive: boolean;
  readonly prompt?: (question: string) => Promise<string>;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<ModelConfiguration> {
  if (input.demo && input.explicitModel) throw new ValidationError("Use either --demo or --model, not both");
  if (input.demo) return { provider: "echo", model: "echo-1" };
  const statuses = providerStatuses(input.supervisor);
  if (input.explicitModel) {
    const model = input.supervisor.normalizeModelConfiguration(parseModel(input.explicitModel));
    if (model.provider === "echo") throw new ValidationError("Echo is a demo fixture; use --demo so demo behavior is explicit");
    assertUsable(model, statuses);
    await persistModel(input.supervisor, input.workspaceId, model);
    return model;
  }
  const preference = await input.supervisor.profile.getPreference(workspacePreferenceKey(input.workspaceId, "model"));
  if (typeof preference?.value === "string") {
    const model = input.supervisor.normalizeModelConfiguration(parseModel(preference.value));
    if (model.provider !== "echo" && statuses.some(status => status.provider === model.provider && status.usable)) return model;
  }
  const environment = input.environment ?? process.env;
  const usable = statuses.filter(status => status.usable && !status.demo);
  for (const status of usable) {
    const configured = environment[`${status.provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_MODEL`];
    if (configured?.trim()) {
      const model = input.supervisor.normalizeModelConfiguration({ provider: status.provider, model: configured.trim() });
      await persistModel(input.supervisor, input.workspaceId, model);
      return model;
    }
  }
  if (!input.interactive || !input.prompt) {
    throw new ValidationError("No usable model is selected. Pass --model PROVIDER:MODEL after configuring a provider, or use --demo explicitly");
  }
  if (!usable.length) {
    const answer = (await input.prompt("No real provider is usable. Start the visibly labeled Echo demo fixture? [y/N] ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") return { provider: "echo", model: "echo-1" };
    throw new ValidationError("No usable provider. Use /model login openai|anthropic|vercel, set the matching environment variable, or use --demo only for fixture behavior");
  }
  let provider = usable[0]!;
  if (usable.length > 1) {
    const choices = usable.map((status, index) => `${index + 1}) ${status.displayName} [${status.provider}]`).join("\n");
    const answer = (await input.prompt(`Choose a provider:
${choices}
Provider number or ID: `)).trim();
    provider = usable[Number(answer) - 1] ?? usable.find(status => status.provider === answer) ?? (() => { throw new ValidationError(`Unknown provider selection: ${answer}`); })();
  }
  const modelId = (await input.prompt(`Model ID for ${provider.displayName}: `)).trim();
  if (!modelId) throw new ValidationError("Model ID is required");
  const model = input.supervisor.normalizeModelConfiguration({ provider: provider.provider, model: modelId });
  await persistModel(input.supervisor, input.workspaceId, model);
  return model;
}

export function modelAvailability(supervisor: Supervisor, model: ModelConfiguration): ProviderStatus {
  const status = providerStatuses(supervisor).find(candidate => candidate.provider === model.provider);
  return status ?? { provider: model.provider, displayName: model.provider, usable: false, demo: false, credentialSource: "missing", remediation: `Install or configure provider ${model.provider}, then resume without changing this branch's model.` };
}

async function persistModel(supervisor: Supervisor, workspaceId: string, model: ModelConfiguration): Promise<void> {
  await supervisor.profile.setPreference(workspacePreferenceKey(workspaceId, "model"), formatModel(supervisor.normalizeModelConfiguration(model)));
}

function assertUsable(model: ModelConfiguration, statuses: readonly ProviderStatus[]): void {
  const status = statuses.find(candidate => candidate.provider === model.provider);
  if (!status?.usable) throw new ValidationError(status?.remediation ?? `Model provider is unavailable: ${model.provider}`);
}

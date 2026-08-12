import {
  ValidationError,
  assertNoReservedModelDispatchInputFields,
  canonicalJsonStringify,
  type JsonValue,
  type ModelConfiguration,
  type ModelConfigurationInput,
} from "../domain/index.ts";
import type { ModelExecutor } from "../executors/index.ts";
import type { ProfileDatabase } from "../sync/profile.ts";

export type ModelSelectionInput = string | ModelConfigurationInput;

export const DELEGATED_MODEL_ALLOWLIST_PREFERENCE =
  "models:delegated-allowlist:v1" as const;
export const DELEGATED_MODEL_ALLOWLIST_VERSION = 1 as const;
export const MAX_DELEGATED_MODEL_ALLOWLIST_ENTRIES = 64;

export interface DelegatedModelIdentity {
  readonly provider: string;
  readonly model: string;
}

export interface DelegatedModelAllowlist {
  readonly version: typeof DELEGATED_MODEL_ALLOWLIST_VERSION;
  readonly models: readonly DelegatedModelIdentity[];
}

/**
 * Shared authority-preserving model normalization for raw generation and child
 * admission. Omission inherits the exact caller configuration; a canonical
 * model string changes only the canonical model while retaining the caller's
 * provider route and token-relevant options.
 */
export class ModelSelectionService {
  constructor(
    readonly modelExecutor: ModelExecutor,
    readonly profile: Pick<ProfileDatabase, "getPreference" | "setPreference">,
  ) {}

  normalizeIdentity(
    caller: ModelConfiguration,
    selection?: ModelSelectionInput,
  ): ModelConfiguration {
    if (selection === undefined) return freezeConfiguration(caller);
    if (typeof selection === "string") {
      return this.modelExecutor.normalizeConfigurationIdentity({
        ...caller,
        model: canonicalModelId(selection),
      });
    }
    assertModelConfigurationSelection(selection);
    return this.modelExecutor.normalizeConfigurationIdentity(selection);
  }

  async admit(
    caller: ModelConfiguration,
    selection?: ModelSelectionInput,
  ): Promise<ModelConfiguration> {
    let normalized: ModelConfiguration;
    if (selection === undefined) {
      normalized = freezeConfiguration(caller);
    } else if (typeof selection === "string") {
      normalized = this.modelExecutor.normalizeConfiguration({
        ...caller,
        model: canonicalModelId(selection),
      });
    } else {
      assertModelConfigurationSelection(selection);
      normalized = this.modelExecutor.normalizeConfiguration(selection);
    }
    await this.assertDelegatedModelAllowed(caller, normalized);
    this.modelExecutor.resolveExecutionDescriptor(normalized);
    return normalized;
  }

  async assertDelegatedModelAllowed(
    caller: ModelConfiguration,
    candidate: ModelConfiguration,
  ): Promise<void> {
    if (sameModelIdentity(caller, candidate)) return;
    const allowlist = await this.getAllowlist();
    if (!allowlist.models.some((item) => sameModelIdentity(item, candidate))) {
      throw new ValidationError(
        "Selected model route/model is outside the parent model policy and owner-managed delegated-model allowlist",
      );
    }
  }

  async getAllowlist(): Promise<DelegatedModelAllowlist> {
    const preference = await this.profile.getPreference(
      DELEGATED_MODEL_ALLOWLIST_PREFERENCE,
    );
    return validateDelegatedModelAllowlist(preference?.value ?? {
      version: DELEGATED_MODEL_ALLOWLIST_VERSION,
      models: [],
    });
  }

  async setAllowlist(
    models: readonly DelegatedModelIdentity[],
  ): Promise<DelegatedModelAllowlist> {
    const value = validateDelegatedModelAllowlist({
      version: DELEGATED_MODEL_ALLOWLIST_VERSION,
      models: models.map((item) => ({ ...item })),
    });
    await this.profile.setPreference(
      DELEGATED_MODEL_ALLOWLIST_PREFERENCE,
      value as unknown as JsonValue,
    );
    return value;
  }
}

export function validateDelegatedModelAllowlist(
  value: unknown,
): DelegatedModelAllowlist {
  if (!isRecord(value)) {
    throw new ValidationError("Delegated-model allowlist must be an object");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(value, "version") ||
    !Object.hasOwn(value, "models") ||
    value.version !== DELEGATED_MODEL_ALLOWLIST_VERSION ||
    !Array.isArray(value.models) ||
    value.models.length > MAX_DELEGATED_MODEL_ALLOWLIST_ENTRIES
  ) {
    throw new ValidationError(
      "Delegated-model allowlist has an unsupported version or shape",
    );
  }
  const models = value.models.map((item, index): DelegatedModelIdentity => {
    if (
      !isRecord(item) ||
      Object.keys(item).length !== 2 ||
      typeof item.provider !== "string" ||
      typeof item.model !== "string"
    ) {
      throw new ValidationError(
        `Delegated-model allowlist entry ${index} is invalid`,
      );
    }
    const provider = item.provider.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider)) {
      throw new ValidationError(
        `Delegated-model allowlist entry ${index} has an invalid provider route`,
      );
    }
    return {
      provider,
      model: canonicalModelId(item.model),
    };
  });
  const identities = models.map((item) => canonicalJsonStringify(item));
  if (new Set(identities).size !== identities.length) {
    throw new ValidationError("Delegated-model allowlist contains duplicates");
  }
  return deepFreeze({
    version: DELEGATED_MODEL_ALLOWLIST_VERSION,
    models,
  });
}

export function canonicalModelId(value: string): string {
  const normalized = value.trim();
  if (
    byteLength(normalized) > 512 ||
    !/^[a-z0-9][a-z0-9._-]*\/[^\s/]+$/i.test(normalized)
  ) {
    throw new ValidationError(
      "Model selection strings must use canonical creator/model form",
    );
  }
  return normalized;
}

export function sameModelIdentity(
  left: Pick<ModelConfiguration, "provider" | "model">,
  right: Pick<ModelConfiguration, "provider" | "model">,
): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function freezeConfiguration(
  value: ModelConfiguration,
): ModelConfiguration {
  return Object.freeze({ ...value });
}

function assertModelConfigurationSelection(
  value: ModelConfigurationInput,
): void {
  assertNoReservedModelDispatchInputFields(
    value,
    "Public model configuration",
  );
  if (
    !isRecord(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new ValidationError("Model selection configuration must be a plain object");
  }
  const allowed = new Set([
    "provider",
    "model",
    "temperature",
    "maxOutputTokens",
    "reasoningEffort",
  ]);
  const ownNames = Object.getOwnPropertyNames(value);
  if (
    Object.getOwnPropertySymbols(value).length > 0 ||
    ownNames.some((key) => !allowed.has(key)) ||
    ownNames.some((key) =>
      Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true
    )
  ) {
    throw new ValidationError(
      "Model selection configuration contains an unknown or reserved field",
    );
  }
  if (ownNames.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.get !== undefined || descriptor?.set !== undefined;
  })) {
    throw new ValidationError(
      "Model selection configuration cannot contain accessors",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

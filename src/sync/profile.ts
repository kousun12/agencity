import type { JsonValue, TypeScriptSkillDefinition } from "../domain/index.ts";
import type { CredentialReference, DeviceIdentity, ProfileInstalledSkill, ProfilePreference, WorkspaceCatalogEntry } from "./types.ts";

export const profileGlobalSkillAvailabilities = ["enabled", "disabled", "removed"] as const;
export type ProfileGlobalSkillAvailability = (typeof profileGlobalSkillAvailabilities)[number];

export type ProfileGlobalSkillProvenance =
  | { readonly source: "legacy" }
  | { readonly source: "profile-api"; readonly reference: string; readonly installedBy: string }
  | { readonly source: "local-directory"; readonly reference: string; readonly manifestDigest: string; readonly sourceDigest: string; readonly installedBy: string }
  | { readonly source: "harness-version"; readonly entryId: string; readonly versionId: string; readonly digest: string; readonly installedBy: string };

export interface ProfileGlobalSkillTestReport {
  readonly testId: string;
  readonly versionId: string;
  readonly digest: string;
  readonly testedAt: string;
  readonly compiled: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly outcome: "passed" | "failed";
}

export interface ProfileGlobalSkillVersion {
  readonly skillId: string;
  readonly versionId: string;
  readonly name: string;
  /** Legacy rows intentionally retain their original JSON definition. */
  readonly definition: JsonValue;
  readonly definitionFormat: "legacy" | "typescript-v1";
  readonly digest: string;
  readonly provenance: ProfileGlobalSkillProvenance;
  readonly testReport: ProfileGlobalSkillTestReport | null;
  readonly effectRef: string | null;
  readonly createdAt: string;
}

export interface ProfileGlobalSkillRecord extends ProfileGlobalSkillVersion {
  readonly availability: ProfileGlobalSkillAvailability;
  /** Product-facing synonym retained with the availability projection. */
  readonly status: ProfileGlobalSkillAvailability;
  readonly updatedAt: string;
}

export interface ProfileGlobalSkillAction {
  /** Canonical append order within the local profile database. */
  readonly sequence: number;
  readonly actionId: string;
  readonly skillId: string;
  readonly versionId: string;
  readonly digest: string;
  readonly action: "legacy-installed" | "staged" | "status-changed";
  readonly previousAvailability: ProfileGlobalSkillAvailability | null;
  readonly availability: ProfileGlobalSkillAvailability;
  readonly effectRef: string | null;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export interface ProfileGlobalSkillHistory {
  readonly skillId: string;
  readonly current: ProfileGlobalSkillRecord | null;
  readonly versions: readonly ProfileGlobalSkillVersion[];
  readonly actions: readonly ProfileGlobalSkillAction[];
}

export interface StageGlobalSkillInput {
  readonly skillId: string;
  readonly versionId?: string;
  readonly name: string;
  readonly definition: TypeScriptSkillDefinition;
  readonly provenance: Exclude<ProfileGlobalSkillProvenance, { readonly source: "legacy" }>;
  readonly testReport: Omit<ProfileGlobalSkillTestReport, "versionId" | "digest">;
  readonly effectRef?: string | null;
  /** Defaults to enabled after a passing report and disabled after a failed report. */
  readonly availability?: Exclude<ProfileGlobalSkillAvailability, "removed">;
  readonly idempotencyKey?: string;
  readonly expectedCurrentVersionId?: string | null;
  readonly expectedCurrentDigest?: string | null;
}

export interface ProfileGlobalSkillReadOptions { readonly includeUnavailable?: boolean; }

export interface SetGlobalSkillStatusInput {
  readonly skillId: string;
  readonly status: ProfileGlobalSkillAvailability;
  readonly expectedVersionId: string;
  readonly expectedDigest: string;
  readonly expectedAvailability: ProfileGlobalSkillAvailability;
  readonly expectedActionSequence: number;
  readonly idempotencyKey: string;
  readonly effectRef?: string | null;
}

export interface SetGlobalSkillAvailabilityInput extends Omit<SetGlobalSkillStatusInput, "status"> {
  readonly availability: ProfileGlobalSkillAvailability;
}

/** Separate from every workspace database; credential values are never accepted. */
export interface ProfileDatabase {
  readonly url: string;
  migrate(): Promise<void>;
  getOrCreateDeviceIdentity(displayName?: string): Promise<DeviceIdentity>;
  getPreference(key: string): Promise<ProfilePreference | null>;
  setPreference(key: string, value: JsonValue): Promise<ProfilePreference>;
  withPreferenceLock<T>(
    key: string,
    operation: (
      current: ProfilePreference | null,
      setValue: (value: JsonValue) => Promise<ProfilePreference>,
      assertOwner: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
  listPreferences(): Promise<ProfilePreference[]>;
  putCredentialReference(input: Omit<CredentialReference, "createdAt" | "updatedAt">): Promise<CredentialReference>;
  getCredentialReference(reference: string): Promise<CredentialReference | null>;
  listCredentialReferences(): Promise<CredentialReference[]>;
  /** Compatibility surface for pre-catalog definitions. */
  installGlobalSkill(input: Omit<ProfileInstalledSkill,"versionId"|"digest"|"createdAt"> & { readonly versionId?:string }): Promise<ProfileInstalledSkill>;
  /** Compatibility surface; unlike strict catalog reads it does not filter lifecycle state. */
  listGlobalSkills(): Promise<ProfileInstalledSkill[]>;
  stageGlobalSkill(input: StageGlobalSkillInput): Promise<ProfileGlobalSkillRecord>;
  getGlobalSkill(skillId: string, options?: ProfileGlobalSkillReadOptions): Promise<ProfileGlobalSkillRecord | null>;
  getGlobalSkillStatus(skillId: string, options?: ProfileGlobalSkillReadOptions): Promise<ProfileGlobalSkillRecord | null>;
  getGlobalSkillVersion(versionId: string): Promise<ProfileGlobalSkillVersion | null>;
  listGlobalSkillCatalog(options?: ProfileGlobalSkillReadOptions): Promise<ProfileGlobalSkillRecord[]>;
  listGlobalSkillStatuses(options?: ProfileGlobalSkillReadOptions): Promise<ProfileGlobalSkillRecord[]>;
  getGlobalSkillHistory(skillId: string): Promise<ProfileGlobalSkillHistory | null>;
  listGlobalSkillHistory(skillId: string): Promise<ProfileGlobalSkillHistory | null>;
  setGlobalSkillStatus(input: SetGlobalSkillStatusInput): Promise<ProfileGlobalSkillRecord>;
  setGlobalSkillAvailability(input: SetGlobalSkillAvailabilityInput): Promise<ProfileGlobalSkillRecord>;
  putWorkspace(entry: WorkspaceCatalogEntry): Promise<void>;
  getWorkspace(workspaceId: string): Promise<WorkspaceCatalogEntry | null>;
  listWorkspaces(includeDeleted?: boolean): Promise<WorkspaceCatalogEntry[]>;
  markWorkspaceDeleted(workspaceId: string, deletedAt: string): Promise<void>;
  close(): void;
}

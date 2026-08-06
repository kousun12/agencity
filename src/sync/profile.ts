import type { JsonValue } from "../domain/index.ts";
import type { CredentialReference, DeviceIdentity, ProfileInstalledSkill, ProfilePreference, WorkspaceCatalogEntry } from "./types.ts";

/** Separate from every workspace database; credential values are never accepted. */
export interface ProfileDatabase {
  readonly url: string;
  migrate(): Promise<void>;
  getOrCreateDeviceIdentity(displayName?: string): Promise<DeviceIdentity>;
  getPreference(key: string): Promise<ProfilePreference | null>;
  setPreference(key: string, value: JsonValue): Promise<ProfilePreference>;
  listPreferences(): Promise<ProfilePreference[]>;
  putCredentialReference(input: Omit<CredentialReference, "createdAt" | "updatedAt">): Promise<CredentialReference>;
  getCredentialReference(reference: string): Promise<CredentialReference | null>;
  listCredentialReferences(): Promise<CredentialReference[]>;
  installGlobalSkill(input: Omit<ProfileInstalledSkill,"versionId"|"digest"|"createdAt"> & { readonly versionId?:string }): Promise<ProfileInstalledSkill>;
  listGlobalSkills(): Promise<ProfileInstalledSkill[]>;
  putWorkspace(entry: WorkspaceCatalogEntry): Promise<void>;
  getWorkspace(workspaceId: string): Promise<WorkspaceCatalogEntry | null>;
  listWorkspaces(includeDeleted?: boolean): Promise<WorkspaceCatalogEntry[]>;
  markWorkspaceDeleted(workspaceId: string, deletedAt: string): Promise<void>;
  close(): void;
}

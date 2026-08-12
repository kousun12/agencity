/**
 * Immutable, fresh-profile migration inventory.
 *
 * Profile state predating this ledger is outside the pre-release cutover
 * boundary and is rejected by ProfileStore with reset guidance.
 */
export interface ProfileSchemaMigration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export const PROFILE_SCHEMA_MIGRATIONS: readonly ProfileSchemaMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: "fresh-profile-baseline",
    statements: Object.freeze([
      "PRAGMA foreign_keys=ON",
      "CREATE TABLE IF NOT EXISTS profile_identity(profile_id TEXT PRIMARY KEY,created_at TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS devices(device_id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,display_name TEXT NOT NULL,created_at TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS credential_references(reference TEXT PRIMARY KEY,provider TEXT NOT NULL,label TEXT NOT NULL,metadata_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)",
      `CREATE TABLE IF NOT EXISTS profile_skill_versions(
        version_id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        name TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        definition_format TEXT NOT NULL CHECK(definition_format IN ('legacy','typescript-v1')),
        provenance_json TEXT,
        test_report_json TEXT,
        effect_ref TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS profile_skill_versions_skill ON profile_skill_versions(skill_id,created_at,version_id)",
      `CREATE TABLE IF NOT EXISTS profile_skills(
        skill_id TEXT PRIMARY KEY,
        current_version_id TEXT NOT NULL,
        name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        availability TEXT NOT NULL CHECK(availability IN ('enabled','disabled','removed')),
        FOREIGN KEY(current_version_id) REFERENCES profile_skill_versions(version_id)
      )`,
      `CREATE TABLE IF NOT EXISTS profile_skill_actions(
        action_id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('legacy-installed','staged','status-changed')),
        previous_availability TEXT CHECK(previous_availability IS NULL OR previous_availability IN ('enabled','disabled','removed')),
        availability TEXT NOT NULL CHECK(availability IN ('enabled','disabled','removed')),
        effect_ref TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS profile_skill_actions_history ON profile_skill_actions(skill_id,created_at,action_id)",
      "CREATE TABLE IF NOT EXISTS workspace_catalog(workspace_id TEXT PRIMARY KEY,name TEXT NOT NULL,database_url TEXT NOT NULL,replica_url TEXT,sync_url TEXT,credential_reference TEXT,owner_profile_id TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT)",
      "CREATE TRIGGER IF NOT EXISTS profile_skill_versions_no_update BEFORE UPDATE ON profile_skill_versions BEGIN SELECT RAISE(ABORT,'profile skill versions are append-only'); END",
      "CREATE TRIGGER IF NOT EXISTS profile_skill_versions_no_delete BEFORE DELETE ON profile_skill_versions BEGIN SELECT RAISE(ABORT,'profile skill versions are append-only'); END",
      "CREATE TRIGGER IF NOT EXISTS profile_skill_actions_no_update BEFORE UPDATE ON profile_skill_actions BEGIN SELECT RAISE(ABORT,'profile skill actions are append-only'); END",
      "CREATE TRIGGER IF NOT EXISTS profile_skill_actions_no_delete BEFORE DELETE ON profile_skill_actions BEGIN SELECT RAISE(ABORT,'profile skill actions are append-only'); END",
    ]),
  }),
  Object.freeze({
    version: 2,
    name: "model-catalog-cache",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS model_catalog_cache(
        endpoint_id TEXT PRIMARY KEY,
        catalog_origin TEXT NOT NULL,
        descriptors_json TEXT NOT NULL,
        revision_digest TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK(schema_version=1)
      )`,
    ]),
  }),
  Object.freeze({
    version: 3,
    name: "preference-leases",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS preference_leases(
        key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        process_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL
      )`,
    ]),
  }),
]);

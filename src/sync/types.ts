import type { EventType, JsonValue, Producer } from "../domain/index.ts";
import type { SyncConflictRecord, WorkspaceReplicaStatusRecord } from "../storage/index.ts";

export interface DeviceIdentity {
  readonly deviceId: string;
  readonly profileId: string;
  readonly displayName: string;
  readonly createdAt: string;
}
export interface WorkspaceCatalogEntry {
  readonly workspaceId: string;
  readonly name: string;
  readonly databaseUrl: string;
  readonly replicaUrl: string | null;
  readonly syncUrl: string | null;
  readonly credentialReference: string | null;
  readonly ownerProfileId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}
export interface CredentialReference {
  readonly reference: string;
  readonly provider: string;
  readonly label: string;
  readonly metadata: JsonValue;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface ProfilePreference { readonly key: string; readonly value: JsonValue; readonly updatedAt: string; }
export interface ProfileInstalledSkill { readonly skillId:string; readonly versionId:string; readonly name:string; readonly definition:JsonValue; readonly digest:string; readonly createdAt:string; }

export interface ReplicatedEventBody {
  readonly id: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly causationId: string | null;
  readonly correlationId: string | null;
  readonly type: EventType;
  readonly schemaVersion: number;
  readonly committedAt: string;
  readonly producer: Producer;
  readonly idempotencyKey: string | null;
  readonly payload: JsonValue;
  readonly streamParentId: string | null;
}
export interface ReplicatedEnvelope {
  readonly protocolVersion: 1;
  readonly envelopeId: string;
  readonly workspaceId: string;
  readonly originDeviceId: string;
  readonly originSequence: number;
  readonly entityKind: "event";
  readonly entityId: string;
  readonly dependencies: string[];
  readonly body: ReplicatedEventBody;
  readonly digest: string;
  readonly createdAt: string;
}
export interface WorkspaceAnnouncement {
  readonly announcementId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly ownerProfileId: string;
  readonly deviceId: string;
  readonly updatedAt: string;
}

/** Transport-neutral copy of the official local sync-engine statistics. */
export interface SyncTransportStats {
  readonly cdcOperations: number;
  readonly mainWalSize: number;
  readonly revertWalSize: number;
  readonly lastPullUnixTime: number | null;
  readonly lastPushUnixTime: number | null;
  readonly revision: string | null;
  readonly networkSentBytes: number;
  readonly networkReceivedBytes: number;
}
export interface BidirectionalSyncProgress { readonly exchangeVersion: number; readonly envelopeCount: number; }
export interface SyncTransportCapabilities {
  readonly adapter: "turso-sync" | "in-process";
  readonly nativeMethod: "push-pull-checkpoint-stats" | "in-process";
  readonly networkExchange: "directional" | "bidirectional-only";
  readonly offlineEnvelopeWrites: boolean;
  readonly directionalPush: boolean;
  readonly directionalPull: boolean;
  readonly checkpoint: boolean;
  readonly statistics: boolean;
  readonly distributedCoordination: false;
}
export interface SyncTransport {
  readonly id: string;
  readonly capabilities: SyncTransportCapabilities;
  initialize(): Promise<void>;
  /** Identifies this durable local replica so lost/replaced files can be restaged safely. */
  replicaIncarnation(previous?: string): Promise<string>;
  putEnvelopes(envelopes: readonly ReplicatedEnvelope[]): Promise<number>;
  /** Returns new sequences plus the settled boundary sequence for collision checks. */
  listEnvelopes(workspaceId?: string, afterByOrigin?: Readonly<Record<string, number>>): Promise<ReplicatedEnvelope[]>;
  putWorkspaceAnnouncement(announcement: WorkspaceAnnouncement): Promise<void>;
  discoverWorkspaces(): Promise<WorkspaceAnnouncement[]>;
  /** Official directional primitives, present only on a directional transport. */
  push?(): Promise<void>;
  pull?(): Promise<boolean>;
  checkpoint?(): Promise<void>;
  stats?(): Promise<SyncTransportStats>;
  /** Test/in-process hubs may retain their genuinely bidirectional primitive. */
  sync?(): Promise<BidirectionalSyncProgress>;
  reconnect?(): Promise<void>;
  close(): Promise<void>;
}
export type SyncTrigger = "startup" | "reconnect" | "interval" | "manual";
export interface NativeSyncProgress {
  readonly mode: "directional" | "bidirectional";
  readonly pullChanged: boolean | null;
  readonly checkpointed: boolean;
  readonly stats: SyncTransportStats | null;
  readonly bidirectional: BidirectionalSyncProgress | null;
}
export interface SyncCycleResult {
  readonly trigger: SyncTrigger;
  readonly staged: number;
  readonly ingested: number;
  readonly duplicates: number;
  readonly quarantined: number;
  readonly conflicts: number;
  readonly native: NativeSyncProgress;
  readonly status: WorkspaceReplicaStatusRecord;
}
export interface SyncPushResult {
  readonly staged: number;
  readonly stats: SyncTransportStats;
  readonly status: WorkspaceReplicaStatusRecord;
}
export interface SyncPullResult {
  readonly changed: boolean;
  readonly ingested: number;
  readonly duplicates: number;
  readonly quarantined: number;
  readonly conflicts: number;
  readonly stats: SyncTransportStats;
  readonly status: WorkspaceReplicaStatusRecord;
}
export interface SyncCheckpointResult {
  readonly stats: SyncTransportStats;
  readonly status: WorkspaceReplicaStatusRecord;
}
export interface SyncServiceCapabilities {
  readonly configured: boolean;
  readonly localWrites: true;
  readonly offlineFirst: true;
  readonly logicalStage: true;
  readonly logicalIngest: true;
  readonly networkSync: boolean;
  readonly directionalNetworkPush: boolean;
  readonly directionalNetworkPull: boolean;
  readonly networkCheckpoint: boolean;
  readonly networkStats: boolean;
  readonly distributedLeases: false;
  readonly automaticOwnershipFailover: false;
  readonly conflictPolicy: "surface-and-require-explicit-resolution";
  readonly transport: SyncTransportCapabilities | null;
}
export interface ResolveConflictInput {
  readonly action: "keep-branches" | "choose-claim" | "cancel-duplicate" | "acknowledge";
  readonly chosenEventId?: string;
  readonly note?: string;
  readonly resolvedBy: string;
}
export interface SyncStatusView {
  readonly capabilities: SyncServiceCapabilities;
  readonly replica: WorkspaceReplicaStatusRecord;
  readonly conflicts: readonly SyncConflictRecord[];
  readonly quarantineCount: number;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}
export function sha256Text(value: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(value);
  return hash.digest("hex");
}
export function envelopeDigest(envelope: Omit<ReplicatedEnvelope, "digest">): string {
  return sha256Text(stableJson(envelope));
}
export function deterministicId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${sha256Text(stableJson(parts)).slice(0, 32)}`;
}
/** Globally unique physical row identity: origin tuple plus immutable content. */
export function replicatedEnvelopeId(input: Pick<ReplicatedEnvelope, "workspaceId"|"originDeviceId"|"originSequence"|"entityKind"|"entityId"|"dependencies"|"body">): string {
  const contentDigest=sha256Text(stableJson({workspaceId:input.workspaceId,originDeviceId:input.originDeviceId,originSequence:input.originSequence,entityKind:input.entityKind,entityId:input.entityId,dependencies:input.dependencies,body:input.body}));
  return deterministicId("envelope",input.workspaceId,input.originDeviceId,String(input.originSequence),contentDigest);
}

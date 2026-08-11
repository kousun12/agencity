import type {
  ScratchCheckpointCandidate,
  ScratchCheckpointLoadResult,
  ScratchCheckpointSource,
  ScratchScope,
} from "../console/scratch.ts";
import type { ProcessExecutionWriteFence } from "./contract.ts";

export const SCRATCH_STORE_LIMITS = Object.freeze({
  ttlMs: 7 * 24 * 60 * 60 * 1_000,
  maxBranches: 64,
  maxWorkspaceBytes: 16 * 1024 * 1024,
});

export type ScratchStoreWriteResult =
  | { readonly status: "stored"; readonly unchangedPayload: boolean }
  | { readonly status: "cleared" }
  | { readonly status: "stale" };

/**
 * Private file-local operational cache contract. It is intentionally separate
 * from AgentStorage and every remote relational placement contract.
 */
export interface ScratchStore {
  load(
    scope: ScratchScope,
    fence: ProcessExecutionWriteFence,
  ): Promise<ScratchCheckpointLoadResult>;
  write(
    scope: ScratchScope,
    candidate: ScratchCheckpointCandidate,
    source: ScratchCheckpointSource,
    fence: ProcessExecutionWriteFence,
  ): Promise<ScratchStoreWriteResult>;
  clear(
    scope: ScratchScope,
    source: ScratchCheckpointSource,
    fence: ProcessExecutionWriteFence,
  ): Promise<ScratchStoreWriteResult>;
  prune(fence: ProcessExecutionWriteFence): Promise<number>;
  close(): void;
}

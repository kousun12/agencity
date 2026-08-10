export const REPOSITORY_INSTRUCTIONS_PROTOCOL = "agencity.repository-instructions.v1" as const;

export const REPOSITORY_INSTRUCTION_LIMITS = Object.freeze({
  rootFileBytes: 64 * 1024,
  nestedFileBytes: 16 * 1024,
  nestedFilesPerRead: 4,
  ancestorScanFiles: 64,
  digestFileBytes: 256 * 1024,
  omittedPaths: 64,
  discoveriesPerCell: 16,
  activeInlineBytes: 40 * 1024,
  activeRecords: 64,
});

export type RepositoryInstructionCompleteness =
  | "inline"
  | "reference"
  | "unavailable";

export interface RepositoryInstructionRecord {
  readonly protocol: typeof REPOSITORY_INSTRUCTIONS_PROTOCOL;
  /** Workspace-relative POSIX path. */
  readonly path: string;
  /** Workspace-relative directory, or "." for the workspace root. */
  readonly directory: string;
  readonly scope: "workspace" | "directory";
  /** Root is zero; deeper directories have larger values and take precedence. */
  readonly precedence: number;
  readonly sha256: string | null;
  readonly size: number | null;
  readonly completeness: RepositoryInstructionCompleteness;
  readonly content?: string;
  readonly redacted?: boolean;
  readonly reason?: string;
  readonly guidance?: string;
}

export interface RepositoryInstructionDiscovery {
  readonly protocol: typeof REPOSITORY_INSTRUCTIONS_PROTOCOL;
  readonly targetPath: string;
  readonly precedence: "root-to-nearest-directory";
  readonly instructions: readonly RepositoryInstructionRecord[];
  readonly omittedInstructionPaths?: readonly string[];
  readonly omittedInstructionCount?: number;
  readonly unscannedAncestorDirectoryPaths?: readonly string[];
  readonly unscannedAncestorDirectoryCount?: number;
  readonly unidentifiedInstructionOmissionOccurrences?: number;
  readonly unidentifiedAncestorScanOmissionOccurrences?: number;
}

export interface RepositoryInstructionOmission {
  readonly protocol: typeof REPOSITORY_INSTRUCTIONS_PROTOCOL;
  readonly targetPaths: readonly string[];
  readonly instructionPaths: readonly string[];
  readonly omittedInstructionCount: number;
  readonly omittedReadTargetCount: number;
  readonly unidentifiedInstructionOmissionOccurrences?: number;
  readonly unidentifiedReadTargetOmissionOccurrences?: number;
  readonly unidentifiedAncestorScanOmissionOccurrences?: number;
}

export interface RepositoryInstructionContext {
  readonly protocol: typeof REPOSITORY_INSTRUCTIONS_PROTOCOL;
  readonly precedence: "root-to-nearest-directory";
  readonly rule: string;
  readonly root: RepositoryInstructionRecord | null;
  readonly discovered: readonly RepositoryInstructionRecord[];
  readonly omittedDiscoveredCount?: number;
  readonly pendingInstructionPaths?: readonly string[];
  readonly pendingInstructionCount?: number;
  readonly omittedReadTargetPaths?: readonly string[];
  readonly omittedReadTargetCount?: number;
  readonly unscannedAncestorDirectoryPaths?: readonly string[];
  readonly unscannedAncestorDirectoryCount?: number;
  readonly unidentifiedInstructionOmissionOccurrences?: number;
  readonly unidentifiedReadTargetOmissionOccurrences?: number;
  readonly unidentifiedAncestorScanOmissionOccurrences?: number;
}

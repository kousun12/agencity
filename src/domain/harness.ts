import type { BudgetLimits, ModelConfiguration } from "./events.ts";
import type { JsonValue } from "./json.ts";

export const harnessKinds = ["memory", "prompt_note", "skill", "subagent_spec"] as const;
export type HarnessKind = (typeof harnessKinds)[number];
export const harnessScopes = ["local", "workspace", "user", "global"] as const;
export type HarnessScope = (typeof harnessScopes)[number];
export const harnessVersionStatuses = ["candidate", "active", "retired", "rejected", "rolled_back"] as const;
export type HarnessVersionStatus = (typeof harnessVersionStatuses)[number];
export type MemoryKind = "claim" | "preference" | "decision" | "observation" | "constraint";

export interface SkillTestCase {
  readonly name: string;
  readonly input: JsonValue;
  readonly expected?: JsonValue;
  readonly expectedError?: string;
}
export interface TypeScriptSkillDefinition {
  readonly description: string;
  readonly source: string;
  readonly inputSchema?: JsonValue;
  readonly permissions: readonly string[];
  readonly tests: readonly SkillTestCase[];
  readonly runtime: "bun";
  readonly compatibility?: string;
}
export interface SubagentSpecDefinition {
  readonly role: string;
  readonly invocationCriteria: string;
  readonly expectedArtifact: string;
  readonly prompt: string;
  readonly model?: ModelConfiguration;
  readonly budget?: BudgetLimits;
  readonly completionCriteria?: string;
}
export type HarnessContent =
  | { readonly kind: "memory"; readonly memoryKind: MemoryKind; readonly text: string }
  | { readonly kind: "prompt_note"; readonly text: string }
  | ({ readonly kind: "skill" } & TypeScriptSkillDefinition)
  | ({ readonly kind: "subagent_spec" } & SubagentSpecDefinition);

export interface HarnessEntryRecord {
  readonly entryId: string;
  readonly kind: HarnessKind;
  readonly scope: HarnessScope;
  readonly scopeKey: string;
  readonly name: string;
  readonly currentVersionId: string;
  readonly activeVersionId: string | null;
  readonly status: HarnessVersionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface HarnessVersionRecord {
  readonly versionId: string;
  readonly entryId: string;
  readonly version: number;
  readonly kind: HarnessKind;
  readonly scope: HarnessScope;
  readonly scopeKey: string;
  readonly name: string;
  readonly content: HarnessContent;
  readonly tags: string[];
  readonly confidence: number;
  readonly status: HarnessVersionStatus;
  readonly evidenceEventIds: string[];
  readonly conflictEntryIds: string[];
  readonly supersedesVersionId: string | null;
  readonly proposalId: string | null;
  readonly createdBy: string;
  readonly createdEventId: string;
  readonly createdAt: string;
  readonly lastConfirmedAt: string;
}
export interface HarnessRecord extends HarnessEntryRecord { readonly current: HarnessVersionRecord; }

export type HarnessEdit =
  | {
      readonly operation: "create";
      readonly kind: HarnessKind;
      readonly scope: HarnessScope;
      readonly scopeKey?: string;
      readonly name: string;
      readonly content: HarnessContent;
      readonly tags?: readonly string[];
      readonly confidence?: number;
      readonly evidenceEventIds?: readonly string[];
      readonly conflictEntryIds?: readonly string[];
    }
  | {
      readonly operation: "replace";
      readonly entryId: string;
      readonly expectedVersionId: string;
      readonly name?: string;
      readonly content: HarnessContent;
      readonly tags?: readonly string[];
      readonly confidence?: number;
      readonly evidenceEventIds?: readonly string[];
      readonly conflictEntryIds?: readonly string[];
    }
  | {
      readonly operation: "retire";
      readonly entryId: string;
      readonly expectedVersionId: string;
      readonly evidenceEventIds?: readonly string[];
      readonly reason?: string;
    };

export interface ObjectiveEvaluation {
  readonly kind: "objective";
  readonly name: string;
  readonly metric: string;
  readonly target: JsonValue;
  readonly baseline?: JsonValue;
  readonly testCommand?: string;
}
export interface RefinementProposalRecord {
  readonly proposalId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly status: "proposed" | "validated" | "candidate" | "promoted" | "rejected" | "revision_required" | "rolled_back";
  readonly trigger: string;
  readonly predictedEffect: string;
  readonly edits: HarnessEdit[];
  readonly evidenceEventIds: string[];
  readonly evaluation: ObjectiveEvaluation;
  readonly authority: "agent" | "user" | "system";
  readonly sourceReviewId?: string;
  readonly proposalFingerprint?: string;
  readonly validation?: JsonValue;
  readonly candidateId: string | null;
  readonly createdEventId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface CandidateAllocationRecord {
  readonly allocationId: string;
  readonly candidateId: string;
  readonly proposalId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly taskId: string | null;
  readonly ordinal: number;
  readonly exposedAt: string | null;
  readonly createdAt: string;
}
export interface EvaluationObservationRecord {
  readonly observationId: string;
  readonly candidateId: string;
  readonly allocationId: string;
  readonly evaluator: string;
  readonly objective: boolean;
  readonly success: boolean;
  readonly metric: JsonValue;
  readonly baseline?: JsonValue;
  readonly evidenceEventIds: string[];
  readonly notes?: string;
  readonly createdAt: string;
}
export interface RefinementDecisionRecord {
  readonly decisionId: string;
  readonly proposalId: string;
  readonly candidateId: string;
  readonly decision: "promote" | "revise" | "reject";
  readonly rule: string;
  readonly evaluator: string;
  readonly baseline?: JsonValue;
  readonly observationIds: string[];
  readonly createdAt: string;
}

export interface MemorySearchOptions {
  readonly scopes?: readonly HarnessScope[];
  readonly statuses?: readonly HarnessVersionStatus[];
  readonly tags?: readonly string[];
  readonly linkedEntryIds?: readonly string[];
  readonly limit?: number;
  readonly since?: string;
}
export interface MemoryRejection { readonly versionId: string; readonly entryId: string; readonly reasons: string[]; }
export interface MemorySelection { readonly record: HarnessRecord; readonly reason: string; readonly rank: number; }
export interface MemorySearchProvenance {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly index: string;
  readonly filters: JsonValue;
  readonly generatedCandidateVersionIds: string[];
  readonly candidates: Array<{ readonly versionId: string; readonly entryId: string; readonly sources: string[] }>;
  readonly rejections: MemoryRejection[];
  readonly conflicts: Array<{
    readonly leftEntryId: string;
    readonly rightEntryId: string;
    readonly declaredByEntryIds: string[];
    readonly winnerEntryId: string | null;
    readonly suppressedEntryId: string | null;
    readonly reason: string;
  }>;
  readonly selections: Array<{ readonly versionId: string; readonly entryId: string; readonly reason: string; readonly rank: number }>;
}
export interface MemorySearchResult { readonly items: MemorySelection[]; readonly provenance: MemorySearchProvenance; }

export interface SkillInvocationResult {
  readonly effectId: string;
  readonly entryId: string;
  readonly versionId: string;
  readonly outcome: "succeeded" | "failed" | "cancelled" | "unknown";
  readonly output?: JsonValue;
  readonly error?: string;
}
export interface SkillTestReport extends SkillInvocationResult {
  readonly compiled: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly tests: JsonValue[];
}

import { describe, expect, test } from "bun:test";
import {
  MAX_CONTEXT_WINDOW_COMPACTION_ITERATIONS,
  MAX_PROVIDER_CONTEXT_WINDOW_OVERFLOW_RETRIES,
  OLDEST_ELIGIBLE_PREFIX,
  ContextWindowAdmissionBlockedError,
  ContextWindowIterationLimitError,
  ContextWindowConfigurationError,
  ModelContextCapacitySource,
  NoContextWindowProgressError,
  ProtectedOnlyContextWindowError,
  ProviderModelErrorCode,
  admitContextWindow,
  isProviderConfirmedContextWindowOverflow,
  planContextWindowOverflowRetry,
  type ContextWindowCompactionRequest,
  type ModelContextWindowConfiguration,
  type ProviderModelErrorClassification,
} from "../../src/runtime/context-window.ts";

interface Candidate {
  readonly version: number;
  readonly tokens: number;
}

interface TestProvenance {
  readonly compactionId: string;
  readonly sourceEventIds: readonly string[];
}

const capacity = (
  overrides: Partial<ModelContextWindowConfiguration> = {},
): ModelContextWindowConfiguration => ({
  provenance: {
    provider: "test-provider",
    model: "test-model",
    source: ModelContextCapacitySource.ProviderMetadata,
  },
  contextWindowTokens: 1_000,
  maxOutputReserveTokens: 250,
  estimatorId: "fixture-estimator-v1",
  triggerRatio: 0.8,
  targetRatio: 0.5,
  ...overrides,
});

function scriptedController(
  estimates: readonly number[],
  protectedSourceCount: number | null = null,
) {
  let version = 0;
  const compactRequests: ContextWindowCompactionRequest<Candidate>[] = [];
  return {
    compactRequests,
    get version() { return version; },
    callbacks: {
      buildCandidate: () => ({ version, tokens: estimates[version]! }),
      estimate: (candidate: Candidate) => candidate.tokens,
      compact: (request: ContextWindowCompactionRequest<Candidate>) => {
        compactRequests.push(request);
        if (protectedSourceCount !== null) {
          return { outcome: "protected-only" as const, protectedSourceCount };
        }
        version += 1;
        if (estimates[version] === undefined) throw new Error("test estimate script exhausted");
        return {
          outcome: "compacted" as const,
          provenance: {
            compactionId: `compaction-${version}`,
            sourceEventIds: [`event-${version}`],
          },
        };
      },
    },
  };
}

const classification = (
  code: ProviderModelErrorCode,
): ProviderModelErrorClassification => ({
  provider: "test-provider",
  model: "test-model",
  code,
});

describe("FU-019 pure context-window admission", () => {
  test("reserves output capacity and treats the proactive trigger as inclusive", async () => {
    const below = scriptedController([749]);
    const belowResult = await admitContextWindow(capacity(), below.callbacks);
    expect(belowResult.thresholds).toEqual({
      contextWindowTokens: 1_000,
      outputReserveTokens: 250,
      hardInputLimitTokens: 750,
      triggerInputTokens: 750,
      targetInputTokens: 500,
      triggerRatio: 0.8,
      targetRatio: 0.5,
    });
    expect(belowResult.reason).toBe("below-trigger");
    expect(belowResult.compactions).toHaveLength(0);

    const equal = scriptedController([750, 500]);
    const equalResult = await admitContextWindow(capacity(), equal.callbacks);
    expect(equalResult.reason).toBe("target-reached");
    expect(equalResult.estimatedInputTokens).toBe(500);
    expect(equalResult.compactions).toHaveLength(1);

    // 751 is both above the reserve-constrained 750-token hard input limit and
    // above the inclusive trigger, even though the ratio-only trigger is 800.
    const above = scriptedController([751, 499]);
    const aboveResult = await admitContextWindow(capacity(), above.callbacks);
    expect(aboveResult.reason).toBe("target-reached");
    expect(aboveResult.compactions).toHaveLength(1);
    expect(above.compactRequests[0]).toEqual(expect.objectContaining({
      estimatedInputTokens: 751,
      targetInputTokens: 500,
      selection: OLDEST_ELIGIBLE_PREFIX,
      reason: "proactive-threshold",
    }));
  });

  test("compacts oldest eligible prefixes repeatedly, rebuilding and recording provenance", async () => {
    const scripted = scriptedController([850, 700, 600]);
    const result = await admitContextWindow(capacity({
      maxOutputReserveTokens: 100,
      targetRatio: 0.6,
    }), scripted.callbacks);

    expect(result.initialEstimatedInputTokens).toBe(850);
    expect(result.estimatedInputTokens).toBe(600);
    expect(result.compactions).toEqual([
      {
        iteration: 1,
        selection: OLDEST_ELIGIBLE_PREFIX,
        reason: "proactive-threshold",
        estimatorId: "fixture-estimator-v1",
        capacityProvenance: capacity().provenance,
        beforeEstimatedInputTokens: 850,
        afterEstimatedInputTokens: 700,
        reclaimedEstimatedTokens: 150,
        provenance: { compactionId: "compaction-1", sourceEventIds: ["event-1"] },
      },
      {
        iteration: 2,
        selection: OLDEST_ELIGIBLE_PREFIX,
        reason: "proactive-threshold",
        estimatorId: "fixture-estimator-v1",
        capacityProvenance: capacity().provenance,
        beforeEstimatedInputTokens: 700,
        afterEstimatedInputTokens: 600,
        reclaimedEstimatedTokens: 100,
        provenance: { compactionId: "compaction-2", sourceEventIds: ["event-2"] },
      },
    ]);
    expect(scripted.compactRequests.map((request) => request.candidate.version)).toEqual([0, 1]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.compactions)).toBe(true);
    expect(Object.isFrozen(result.compactions[0])).toBe(true);
  });

  test("blocks with typed no-progress state after rebuilding and re-estimating", async () => {
    const scripted = scriptedController([850, 850]);
    try {
      await admitContextWindow(capacity({ maxOutputReserveTokens: 100 }), scripted.callbacks);
      throw new Error("expected admission to be blocked");
    } catch (error) {
      expect(error).toBeInstanceOf(NoContextWindowProgressError);
      expect(error).toBeInstanceOf(ContextWindowAdmissionBlockedError);
      const blocked = error as NoContextWindowProgressError<TestProvenance>;
      expect(blocked.code).toBe("no-progress");
      expect(blocked.priorEstimatedInputTokens).toBe(850);
      expect(blocked.rebuiltEstimatedInputTokens).toBe(850);
      expect(blocked.state.completedCompactions).toHaveLength(1);
      expect(blocked.state.completedCompactions[0]!.provenance).toEqual({
        compactionId: "compaction-1",
        sourceEventIds: ["event-1"],
      });
    }
  });

  test("blocks with a typed protected-only error instead of compacting live durable state", async () => {
    const scripted = scriptedController([850], 7);
    await expect(admitContextWindow(capacity({ maxOutputReserveTokens: 100 }), scripted.callbacks))
      .rejects.toBeInstanceOf(ProtectedOnlyContextWindowError);
    try {
      await admitContextWindow(capacity({ maxOutputReserveTokens: 100 }), scriptedController([850], 7).callbacks);
      throw new Error("expected admission to be blocked");
    } catch (error) {
      const blocked = error as ProtectedOnlyContextWindowError;
      expect(blocked.code).toBe("protected-only");
      expect(blocked.protectedSourceCount).toBe(7);
      expect(blocked.state.completedCompactions).toEqual([]);
    }
  });

  test("bounds repeated shrinking passes with a fixed typed iteration limit", async () => {
    const estimates = Array.from(
      { length: MAX_CONTEXT_WINDOW_COMPACTION_ITERATIONS + 1 },
      (_, index) => 900 - index,
    );
    const scripted = scriptedController(estimates);
    try {
      await admitContextWindow(capacity({ maxOutputReserveTokens: 100 }), scripted.callbacks);
      throw new Error("expected iteration limit");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextWindowIterationLimitError);
      const blocked = error as ContextWindowIterationLimitError<TestProvenance>;
      expect(blocked.code).toBe("iteration-limit");
      expect(blocked.iterationLimit).toBe(MAX_CONTEXT_WINDOW_COMPACTION_ITERATIONS);
      expect(blocked.state.completedCompactions).toHaveLength(MAX_CONTEXT_WINDOW_COMPACTION_ITERATIONS);
      expect(scripted.compactRequests).toHaveLength(MAX_CONTEXT_WINDOW_COMPACTION_ITERATIONS);
    }
  });

  test("unknown capacity skips proactive compaction but supports an explicit pass", async () => {
    const unknown = capacity({
      provenance: {
        provider: "opaque-provider",
        model: "opaque-model",
        source: ModelContextCapacitySource.Unknown,
      },
      contextWindowTokens: null,
      maxOutputReserveTokens: 4_096,
    });
    const proactive = scriptedController([999_999]);
    const skipped = await admitContextWindow(unknown, proactive.callbacks);
    expect(skipped.reason).toBe("unknown-capacity");
    expect(skipped.thresholds).toBeNull();
    expect(skipped.compactions).toEqual([]);
    expect(proactive.compactRequests).toEqual([]);

    const explicit = scriptedController([900, 700]);
    const compacted = await admitContextWindow(unknown, explicit.callbacks, { mode: "explicit" });
    expect(compacted.reason).toBe("explicit-compaction-complete");
    expect(compacted.estimatedInputTokens).toBe(700);
    expect(compacted.compactions).toHaveLength(1);
    expect(explicit.compactRequests[0]).toEqual(expect.objectContaining({
      targetInputTokens: null,
      reason: "explicit-request",
      selection: OLDEST_ELIGIBLE_PREFIX,
    }));
  });

  test("rejects inconsistent capacity and estimator configuration before callbacks", async () => {
    const scripted = scriptedController([1]);
    await expect(admitContextWindow(capacity({ maxOutputReserveTokens: 1_000 }), scripted.callbacks))
      .rejects.toBeInstanceOf(ContextWindowConfigurationError);
    await expect(admitContextWindow(capacity({ estimatorId: "" }), scripted.callbacks))
      .rejects.toThrow(expect.objectContaining({ code: "invalid-context-window-configuration" }));
    expect(scripted.version).toBe(0);
  });
});

describe("FU-019 typed context-overflow retry planning", () => {
  test("retries only a provider-confirmed overflow with a strictly smaller estimate", () => {
    const overflow = classification(ProviderModelErrorCode.ProviderConfirmedContextWindowOverflow);
    expect(isProviderConfirmedContextWindowOverflow(overflow)).toBe(true);
    const plan = planContextWindowOverflowRetry({
      classification: overflow,
      retriesAlreadyAttempted: 0,
      rejectedEstimatedInputTokens: 900,
      nextEstimatedInputTokens: 700,
    });
    expect(plan).toEqual({
      retry: true,
      reason: "provider-overflow-smaller-candidate",
      nextRetryOrdinal: 1,
      retryLimit: MAX_PROVIDER_CONTEXT_WINDOW_OVERFLOW_RETRIES,
      remainingRetriesAfterPlan: MAX_PROVIDER_CONTEXT_WINDOW_OVERFLOW_RETRIES - 1,
      rejectedEstimatedInputTokens: 900,
      nextEstimatedInputTokens: 700,
      classification: overflow,
    });

    expect(planContextWindowOverflowRetry({
      classification: overflow,
      retriesAlreadyAttempted: 0,
      rejectedEstimatedInputTokens: 900,
      nextEstimatedInputTokens: 900,
    })).toEqual(expect.objectContaining({
      retry: false,
      reason: "estimate-not-strictly-smaller",
      nextRetryOrdinal: null,
    }));
  });

  test("enforces the fixed overflow retry cap", () => {
    const result = planContextWindowOverflowRetry({
      classification: classification(ProviderModelErrorCode.ProviderConfirmedContextWindowOverflow),
      retriesAlreadyAttempted: MAX_PROVIDER_CONTEXT_WINDOW_OVERFLOW_RETRIES,
      rejectedEstimatedInputTokens: 700,
      nextEstimatedInputTokens: 600,
    });
    expect(result).toEqual(expect.objectContaining({
      retry: false,
      reason: "retry-limit",
      retryLimit: MAX_PROVIDER_CONTEXT_WINDOW_OVERFLOW_RETRIES,
      remainingRetriesAfterPlan: 0,
    }));
  });

  test("generic and unknown classifications never become overflow retries", () => {
    const generic = classification(ProviderModelErrorCode.Generic);
    const unknown = classification(ProviderModelErrorCode.Unknown);
    expect(isProviderConfirmedContextWindowOverflow(generic)).toBe(false);
    expect(isProviderConfirmedContextWindowOverflow(unknown)).toBe(false);
    expect(planContextWindowOverflowRetry({
      classification: generic,
      retriesAlreadyAttempted: 0,
      rejectedEstimatedInputTokens: 900,
      nextEstimatedInputTokens: 1,
    })).toEqual(expect.objectContaining({ retry: false, reason: "generic-error" }));
    expect(planContextWindowOverflowRetry({
      classification: unknown,
      retriesAlreadyAttempted: 0,
      rejectedEstimatedInputTokens: 900,
      nextEstimatedInputTokens: 1,
    })).toEqual(expect.objectContaining({ retry: false, reason: "unknown-error" }));
  });
});

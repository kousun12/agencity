import { describe, expect, test } from "bun:test";
import {
  ValidationError,
  assertReasoningSelection,
  normalizeReasoningEffort,
  resolveModelDispatch,
  type ModelConfiguration,
  type ModelDescriptor,
} from "../../src/domain/index.ts";

const configuration: ModelConfiguration = {
  provider: "vercel",
  model: "anthropic/claude-sonnet-4.5",
  temperature: 0.2,
  maxOutputTokens: 4_096,
  reasoningEffort: "high",
};

const descriptor: ModelDescriptor = {
  model: configuration.model,
  displayName: "Claude Sonnet 4.5",
  contextWindowTokens: 200_000,
  maxOutputTokens: 64_000,
  pricing: { inputUsdPerToken: 0.000003, outputUsdPerToken: 0.000015 },
  reasoning: { status: "listed", levels: ["low", "medium", "high"] },
  catalogEndpointId: "a".repeat(64),
  catalogDigest: "b".repeat(64),
  stale: false,
};

describe("model reasoning configuration", () => {
  test("normalizes only the supported aliases", () => {
    expect(normalizeReasoningEffort("off")).toBe("none");
    expect(normalizeReasoningEffort("default")).toBe("provider-default");
    expect(normalizeReasoningEffort("xhigh")).toBe("xhigh");
    expect(() => normalizeReasoningEffort("max")).toThrow(ValidationError);
  });

  test("rejects unsupported listed levels", () => {
    expect(() => assertReasoningSelection("minimal", descriptor.reasoning)).toThrow(
      "Reasoning effort minimal is unavailable",
    );
    expect(() =>
      assertReasoningSelection("high", {
        status: "unsupported",
        levels: [],
      }),
    ).toThrow("without reasoning control");
  });

  test("resolves one immutable dispatch record with catalog provenance", () => {
    const dispatch = resolveModelDispatch({
      configuration,
      capability: descriptor.reasoning,
      catalogDigest: descriptor.catalogDigest,
      executionEndpointId: descriptor.catalogEndpointId,
    });
    expect(dispatch).toEqual({
      configuration,
      reasoning: {
        requestedEffort: "high",
        mode: "requested",
        capability: {
          status: "listed",
          levels: ["low", "medium", "high"],
          catalogDigest: descriptor.catalogDigest,
        },
        resolverId: "agencity.reasoning-dispatch.v1",
      },
      executionEndpointId: descriptor.catalogEndpointId,
      dispatchVersion: "agencity.model-dispatch.v1",
    });
    expect(Object.isFrozen(dispatch)).toBe(true);
    expect(Object.isFrozen(dispatch.configuration)).toBe(true);
    expect(Object.isFrozen(dispatch.reasoning)).toBe(true);
  });

  test("retains provider-default without sending a provider override", () => {
    const dispatch = resolveModelDispatch({
      configuration: { ...configuration, reasoningEffort: "provider-default" },
      capability: descriptor.reasoning,
      catalogDigest: descriptor.catalogDigest,
    });
    expect(dispatch.reasoning.requestedEffort).toBe("provider-default");
    expect(dispatch.reasoning.mode).toBe("omitted");
  });
});

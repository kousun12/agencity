import { describe, expect, test } from "bun:test";
import {
  isCanonicalProductModelId,
  validateCanonicalProductModelId,
  type ModelDescriptor,
} from "../../src/domain/index.ts";
import {
  FALLBACK_TERMINAL_COLUMNS,
  MAX_MODEL_QUERY_CODE_POINTS,
  MAX_PROVIDER_QUERY_CODE_POINTS,
  boundModelSelectionQuery,
  boundProviderSelectionQuery,
  defaultSelectedIdentity,
  fitTerminalLine,
  navigateSelectedIdentity,
  providerAcceptsCanonicalModel,
  rankModelOptions,
  rankProviderOptions,
  reconcileSelectedIdentity,
  sanitizeTerminalLine,
  terminalColumns,
  terminalDisplayWidth,
  visibleSelectionWindow,
} from "../../src/product/model-selection.ts";

function descriptor(
  model: string,
  displayName: string,
): ModelDescriptor {
  return {
    model,
    displayName,
    contextWindowTokens: null,
    maxOutputTokens: null,
    pricing: null,
    reasoning: {
      status: "unverified",
      levels: ["none", "minimal", "low", "medium", "high", "xhigh"],
    },
    catalogDigest: "a".repeat(64),
    catalogEndpointId: "b".repeat(64),
    stale: false,
  };
}

describe("product canonical model identity", () => {
  test("accepts the exact product grammar and 512-byte boundary", () => {
    expect(isCanonicalProductModelId("A_1.creator/model")).toBe(true);
    expect(isCanonicalProductModelId("openai/private/model")).toBe(true);
    const exact = `a/${"x".repeat(510)}`;
    expect(new TextEncoder().encode(exact)).toHaveLength(512);
    expect(validateCanonicalProductModelId(exact)).toBe(exact);
    expect(isCanonicalProductModelId(`${exact}x`)).toBe(false);
  });

  test.each([
    "",
    "/model",
    ".creator/model",
    "creator//model",
    "creator/ model",
    "creator/model name",
    "creator/model\nname",
    "creator/model\u0000name",
    "creator/model\u001b[31m",
    "creator/model\u0085name",
    "creator/model\u202ename",
    "creator/model\u2066name",
  ])("rejects malformed or terminal-unsafe identity %j", (model) => {
    expect(isCanonicalProductModelId(model)).toBe(false);
    expect(() => validateCanonicalProductModelId(model)).toThrow(
      "bounded canonical creator/model",
    );
  });

  test("applies direct-provider namespaces without narrowing Gateway", () => {
    expect(providerAcceptsCanonicalModel("openai", "openai/gpt-5")).toBe(true);
    expect(providerAcceptsCanonicalModel("openai", "anthropic/claude")).toBe(
      false,
    );
    expect(
      providerAcceptsCanonicalModel("anthropic", "anthropic/claude"),
    ).toBe(true);
    expect(providerAcceptsCanonicalModel("vercel", "meta/llama")).toBe(true);
    expect(providerAcceptsCanonicalModel("custom", "custom/private")).toBe(
      true,
    );
  });
});

describe("provider option ranking", () => {
  const providers = [
    { name: "vercel", displayName: "Vercel AI Gateway" },
    { name: "openai", displayName: "OpenAI" },
    { name: "anthropic", displayName: "Anthropic" },
  ] as const;

  test("preserves caller order for an empty query", () => {
    expect(rankProviderOptions(providers, "").map((item) => item.name)).toEqual(
      ["vercel", "openai", "anthropic"],
    );
  });

  test("searches stable names and display names with deterministic tiers", () => {
    expect(rankProviderOptions(providers, "openai")[0]).toMatchObject({
      name: "openai",
      identity: "provider:openai",
    });
    expect(rankProviderOptions(providers, "ai gate")[0]?.name).toBe("vercel");
    expect(rankProviderOptions(providers, "vag")[0]?.name).toBe("vercel");
  });

  test("bounds provider queries by Unicode code point", () => {
    const bounded = boundProviderSelectionQuery(
      "🙂".repeat(MAX_PROVIDER_QUERY_CODE_POINTS + 20),
    );
    expect(Array.from(bounded)).toHaveLength(MAX_PROVIDER_QUERY_CODE_POINTS);
  });
});

describe("model option ranking", () => {
  const models = [
    descriptor("openai/gpt-5.6-sol-mini", "GPT 5.6 Sol Mini"),
    descriptor("openai/gpt-5.6-sol", "GPT 5.6 Sol"),
    descriptor("anthropic/claude-sonnet", "Claude Sonnet"),
    descriptor("openai/alpha-solver", "Alpha Solver"),
  ] as const;

  test("uses the specified exact, prefix, token, substring, and subsequence tiers", () => {
    expect(rankModelOptions(models, "vercel", "openai/gpt-5.6-sol")[0])
      .toMatchObject({ model: "openai/gpt-5.6-sol", kind: "catalog" });
    expect(rankModelOptions(models, "vercel", "GPT 5.6 Sol")[0])
      .toMatchObject({ model: "openai/gpt-5.6-sol" });
    expect(rankModelOptions(models, "vercel", "gpt 5")[0])
      .toMatchObject({ model: "openai/gpt-5.6-sol" });
    expect(rankModelOptions(models, "vercel", "sol min")[0])
      .toMatchObject({ model: "openai/gpt-5.6-sol-mini" });
    expect(rankModelOptions(models, "vercel", "pha solv")[0])
      .toMatchObject({ model: "openai/alpha-solver" });
    expect(rankModelOptions(models, "vercel", "asv")[0])
      .toMatchObject({ model: "openai/alpha-solver" });
  });

  test("sorts empty queries by normalized display name then canonical ID", () => {
    const sameName = [
      descriptor("openai/z", "Same"),
      descriptor("openai/a", "Same"),
      ...models,
    ];
    expect(
      rankModelOptions(sameName, "vercel", "").map((item) => item.model),
    ).toEqual([
      "openai/alpha-solver",
      "anthropic/claude-sonnet",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-sol-mini",
      "openai/a",
      "openai/z",
    ]);
  });

  test("uses code-point tie breaking independent of input and locale ordering", () => {
    const candidates = [
      descriptor("openai/umlaut", "Älpha"),
      descriptor("openai/zulu", "Zulu"),
      descriptor("openai/supplementary", "\u{10000}"),
      descriptor("openai/private-use", "\ue000"),
    ];
    const reversed = [...candidates].reverse();
    const expected = [
      "openai/zulu",
      "openai/umlaut",
      "openai/private-use",
      "openai/supplementary",
    ];
    expect(
      rankModelOptions(candidates, "openai", "").map((item) => item.model),
    ).toEqual(expected);
    expect(
      rankModelOptions(reversed, "openai", "").map((item) => item.model),
    ).toEqual(expected);
  });

  test("filters direct-provider namespaces and lets Gateway see all creators", () => {
    expect(
      rankModelOptions(models, "openai", "").map((item) => item.model),
    ).toEqual([
      "openai/alpha-solver",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-sol-mini",
    ]);
    expect(
      rankModelOptions(models, "anthropic", "").map((item) => item.model),
    ).toEqual(["anthropic/claude-sonnet"]);
    expect(rankModelOptions(models, "vercel", "")).toHaveLength(4);
  });

  test("puts a valid unmatched manual identity first even with fuzzy matches", () => {
    const options = rankModelOptions(
      models,
      "openai",
      "openai/gpt-5.6-sol-private",
    );
    expect(options[0]).toEqual({
      kind: "manual",
      identity: "manual:openai/gpt-5.6-sol-private",
      model: "openai/gpt-5.6-sol-private",
      displayName: "Use exact model ID",
    });
    expect(defaultSelectedIdentity(options)).toBe(
      "manual:openai/gpt-5.6-sol-private",
    );
  });

  test("prefers an exact catalog identity and rejects invalid or cross-provider manual rows", () => {
    const exact = rankModelOptions(
      models,
      "openai",
      "OPENAI/GPT-5.6-SOL",
    );
    expect(exact[0]?.kind).toBe("catalog");
    expect(exact.some((option) => option.kind === "manual")).toBe(false);
    expect(
      rankModelOptions([], "openai", "anthropic/claude-private"),
    ).toEqual([]);
    expect(rankModelOptions([], "openai", "not a model")).toEqual([]);
  });

  test("keeps custom provider-specific manual model identities outside product grammar", () => {
    expect(rankModelOptions([], "fixture-custom", "native-v2")).toEqual([{
      kind: "manual",
      identity: "manual:native-v2",
      model: "native-v2",
      displayName: "Use exact model ID",
    }]);
    expect(rankModelOptions([], "fixture-custom", "not a model")).toEqual([]);
  });

  test("bounds model queries and performs one bounded scan over 10,000 candidates", () => {
    const bounded = boundModelSelectionQuery(
      "🙂".repeat(MAX_MODEL_QUERY_CODE_POINTS + 20),
    );
    expect(Array.from(bounded)).toHaveLength(MAX_MODEL_QUERY_CODE_POINTS);
    const maximum = Array.from({ length: 10_000 }, (_, index) =>
      descriptor(`openai/model-${String(index).padStart(5, "0")}`, `Model ${index}`)
    );
    const result = rankModelOptions(maximum, "openai", "model 09999");
    expect(result[0]?.model).toBe("openai/model-09999");
    expect(() =>
      rankModelOptions(
        [...maximum, descriptor("openai/overflow", "Overflow")],
        "openai",
        "",
      )
    ).toThrow("at most 10000");
  });
});

describe("stable selection state", () => {
  const options = Array.from({ length: 12 }, (_, index) => ({
    identity: `catalog:model-${index}`,
  }));

  test("resets on query edits and preserves a surviving identity on refresh", () => {
    expect(
      reconcileSelectedIdentity(
        options,
        "catalog:model-5",
        "query-edit",
      ),
    ).toBe("catalog:model-0");
    expect(
      reconcileSelectedIdentity(
        options,
        "catalog:model-5",
        "data-refresh",
      ),
    ).toBe("catalog:model-5");
    expect(
      reconcileSelectedIdentity(options, "missing", "data-refresh"),
    ).toBe("catalog:model-0");
  });

  test("wraps navigation in both directions", () => {
    expect(
      navigateSelectedIdentity(options, "catalog:model-0", -1),
    ).toBe("catalog:model-11");
    expect(
      navigateSelectedIdentity(options, "catalog:model-11", 1),
    ).toBe("catalog:model-0");
  });

  test("keeps the selected identity inside an eight-row window", () => {
    expect(
      visibleSelectionWindow(options, "catalog:model-0"),
    ).toMatchObject({ start: 0, end: 8 });
    const later = visibleSelectionWindow(options, "catalog:model-10");
    expect(later).toMatchObject({ start: 3, end: 11 });
    expect(later.options.some((item) =>
      item.identity === "catalog:model-10"
    )).toBe(true);
  });
});

describe("terminal-safe bounded presentation", () => {
  test("projects controls, ANSI, newlines, and bidi formatting to one safe line", () => {
    const safe = sanitizeTerminalLine(
      "name\n\u001b[31mred\u001b[0m\u0085\u2028\u202eend",
    );
    expect(safe).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/,
    );
    expect(safe).not.toContain("\n");
    expect(safe).toContain("␛[31m");
  });

  test("clips by display cells across wide and combining characters", () => {
    const fitted = fitTerminalLine("A界e\u0301🙂tail", 7);
    expect(terminalDisplayWidth(fitted)).toBeLessThanOrEqual(7);
    expect(fitted.endsWith("…")).toBe(true);
    expect(fitTerminalLine("short", 7)).toBe("short");
  });

  test("uses an 80-column fallback for missing or invalid width", () => {
    expect(terminalColumns(undefined)).toBe(FALLBACK_TERMINAL_COLUMNS);
    expect(terminalColumns(0)).toBe(FALLBACK_TERMINAL_COLUMNS);
    const fitted = fitTerminalLine("x".repeat(100));
    expect(terminalDisplayWidth(fitted)).toBe(80);
  });
});

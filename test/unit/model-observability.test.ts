import { afterEach, describe, expect, test } from "bun:test";
import {
  AGENT_ACTION_PROTOCOL,
  AGENT_ACTION_VERSION,
  ModelExecutor,
  ScriptedAgentActionProvider,
  Supervisor,
  ValidationError,
  boundedDiagnosticText,
  deriveModelContractDiagnostics,
  describeAgentToolCapabilities,
  projectEvents,
  type AgentState,
  type ModelDescriptor,
  type ModelProvider,
  type ModelProviderRequiredToolSetCapabilities,
} from "../../src/index.ts";
import {
  makeTempRuntime,
  removeTempRuntime,
  type TempRuntime,
} from "../helpers.ts";

const temps: TempRuntime[] = [];
const providerCallCounts = new Map<string, number>();
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
  providerCallCounts.clear();
});

function provider(
  name: string,
  requiredToolSet: ModelProviderRequiredToolSetCapabilities,
  usable = true,
): ModelProvider {
  providerCallCounts.set(name, 0);
  return {
    name,
    displayName: name,
    capabilities: { streaming: false, requiredToolSet },
    availability: () => ({
      usable,
      credentialSource: usable ? "programmatic" as const : "missing" as const,
      ...(usable ? {} : { remediation: `Configure ${name}.` }),
    }),
    async complete() {
      const calls = (providerCallCounts.get(name) ?? 0) + 1;
      providerCallCounts.set(name, calls);
      return {
        text: `unexpected provider call ${calls}`,
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    },
  };
}

const strict = {
  status: "provider-strict",
  requiredChoice: "provider-enforced",
  parallelCalls: "provider-disabled",
  streaming: true,
  adapter: "fixture.strict.v1",
} as const;
const runtimeValidated = {
  status: "runtime-validated",
  requiredChoice: "provider-enforced",
  parallelCalls: "runtime-rejected",
  streaming: true,
  adapter: "fixture.runtime.v1",
} as const;
const unknown = {
  status: "unknown",
  requiredChoice: "provider-enforced",
  parallelCalls: "runtime-rejected",
  streaming: true,
  adapter: "fixture.unknown.v1",
  reason: "Model evidence is unknown; admission uses runtime validation.",
} as const;
const unsupported = {
  status: "unsupported",
  requiredChoice: "unsupported",
  parallelCalls: "unsupported",
  streaming: false,
  adapter: "fixture.text.v1",
  reason: "This adapter only implements text completion.",
} as const;
// Formal statuses require proven streaming at registration, so the only
// admissible transport without bounded tool-input streaming is `unknown`. The
// executor resolves it to `unsupported` for every model.
const unknownWithoutStreaming = {
  status: "unknown",
  requiredChoice: "unknown",
  parallelCalls: "unknown",
  streaming: false,
  adapter: "fixture.unknown-no-stream.v1",
  reason: "Bounded tool-input streaming is not proven on this transport.",
} as const;

describe("formal model observability", () => {
  test("reports all capability states without calling a provider", () => {
    const executor = new ModelExecutor([
      provider("strict", strict),
      provider("runtime", runtimeValidated),
      provider("unknown", unknown),
      provider("unavailable", unsupported),
      provider("unknown-no-stream", unknownWithoutStreaming),
      provider("missing-credential", strict, false),
    ]);

    const view = describeAgentToolCapabilities(executor, {
      provider: "unknown",
      model: "fixture/model",
    });
    expect(view.contract).toMatchObject({
      contractId: "agencity.agent-tools.v1",
      contractVersion: 1,
      tools: ["bun_console", "finish"],
      selection: "exactly-one-of",
      supplementalText: "diagnostic-only",
    });
    expect(view.transports.map(item => [item.provider, item.state])).toEqual([
      ["strict", "provider-strict"],
      ["runtime", "runtime-validated"],
      ["unknown", "unknown"],
      ["unavailable", "unavailable"],
      ["unknown-no-stream", "unavailable"],
      ["missing-credential", "provider-strict"],
    ]);
    expect(view.selected).toMatchObject({
      state: "unknown",
      admission: "allowed",
      canRun: true,
      modelCatalog: { status: "unknown" },
    });
    expect(view.selected?.reason).toContain("unknown");

    expect(describeAgentToolCapabilities(executor, {
      provider: "unavailable",
      model: "fixture/model",
    }).selected).toMatchObject({
      state: "unavailable",
      admission: "rejected",
      canRun: false,
      reason: "This adapter only implements text completion.",
    });
    expect(describeAgentToolCapabilities(executor, {
      provider: "unknown-no-stream",
      model: "fixture/model",
    }).selected).toMatchObject({
      state: "unavailable",
      admission: "rejected",
      canRun: false,
      reason: "Bounded tool-input streaming is not proven on this transport.",
    });
    expect(describeAgentToolCapabilities(executor, {
      provider: "missing-credential",
      model: "fixture/model",
    }).selected).toMatchObject({
      state: "provider-strict",
      admission: "allowed",
      canRun: false,
      reason: "Configure missing-credential.",
    });
    expect(describeAgentToolCapabilities(executor, {
      provider: "not-installed",
      model: "fixture/model",
    }).selected).toMatchObject({
      state: "unavailable",
      admission: "rejected",
      canRun: false,
    });
    expect([...providerCallCounts.values()].reduce(
      (total, count) => total + count,
      0,
    )).toBe(0);
  });

  test("bounded diagnostic text enforces an exact UTF-8 byte cap", () => {
    const bytes = (value: string): number =>
      new TextEncoder().encode(value).byteLength;
    const exact = "a".repeat(64);
    expect(boundedDiagnosticText(exact, 64)).toBe(exact);
    const truncated = boundedDiagnosticText("a".repeat(65), 64);
    expect(truncated.endsWith("…")).toBe(true);
    expect(bytes(truncated)).toBe(64);
    // A 4-byte emoji spans the cut: the boundary retreats to the previous
    // complete code point instead of decoding replacement characters.
    const emojiCut = boundedDiagnosticText(`a${"😀".repeat(4)}`, 7);
    expect(emojiCut).toBe("a…");
    expect(bytes(emojiCut)).toBeLessThanOrEqual(7);
    expect(emojiCut).not.toContain("\uFFFD");
    // A 2-byte sequence at the boundary is dropped, never split.
    const accented = boundedDiagnosticText("é".repeat(40), 10);
    expect(accented).toBe(`${"é".repeat(3)}…`);
    expect(bytes(accented)).toBeLessThanOrEqual(10);
    expect(accented).not.toContain("\uFFFD");
  });

  test("rejects absurd selected query identity and bounds unknown echoes", () => {
    const executor = new ModelExecutor([provider("strict", strict)]);
    for (const identity of [
      { provider: "p".repeat(257), model: "fixture/model" },
      { provider: "strict", model: "m".repeat(513) },
      { provider: "   ", model: "fixture/model" },
      { provider: "strict", model: "" },
    ]) {
      expect(() => describeAgentToolCapabilities(executor, identity))
        .toThrow(ValidationError);
    }
    const bytes = (value: string): number =>
      new TextEncoder().encode(value).byteLength;
    const boundary = describeAgentToolCapabilities(executor, {
      provider: "p".repeat(256),
      model: "m".repeat(512),
    }).selected!;
    expect(boundary).toMatchObject({
      state: "unavailable",
      admission: "rejected",
      canRun: false,
    });
    expect(bytes(boundary.provider)).toBeLessThanOrEqual(256);
    expect(bytes(boundary.model)).toBeLessThanOrEqual(512);
    expect(bytes(boundary.reason ?? "")).toBeLessThanOrEqual(512);
    expect(bytes(boundary.transport.displayName)).toBeLessThanOrEqual(256);
    expect(bytes(boundary.transport.reason ?? "")).toBeLessThanOrEqual(512);
  });

  test("selected capability reflects catalog supported, strict-unsupported, unsupported, and unknown facts", () => {
    const entry = (
      model: string,
      requiredToolSet: NonNullable<ModelDescriptor["requiredToolSet"]>,
    ): ModelDescriptor => Object.freeze({
      model,
      displayName: model,
      contextWindowTokens: 128_000,
      maxOutputTokens: null,
      pricing: null,
      reasoning: Object.freeze({ status: "unverified" as const, levels: [] }),
      requiredToolSet: Object.freeze(requiredToolSet),
      catalogDigest: "c".repeat(64),
      catalogEndpointId: "e".repeat(64),
      stale: false,
    });
    const entries = new Map<string, ModelDescriptor>([
      ["cat/strict", entry("cat/strict", {
        status: "supported", strictSchema: "supported", requiredChoice: "supported",
      })],
      ["cat/runtime", entry("cat/runtime", {
        status: "supported", strictSchema: "unsupported", requiredChoice: "supported",
      })],
      ["cat/unsupported", entry("cat/unsupported", {
        status: "unsupported", strictSchema: "unsupported", requiredChoice: "unsupported",
      })],
      ["cat/unknown", entry("cat/unknown", {
        status: "unknown", strictSchema: "unknown", requiredChoice: "unknown",
      })],
    ]);
    const executor = new ModelExecutor(
      [{ ...provider("gateway", strict), productTransport: true }],
      1,
      {
        endpointId: "e".repeat(64),
        descriptor(model) {
          const found = entries.get(model);
          if (!found) throw new Error(`Unexpected catalog lookup: ${model}`);
          return found;
        },
      },
    );
    const selected = (model: string) =>
      describeAgentToolCapabilities(executor, { provider: "gateway", model }).selected!;
    expect(selected("cat/strict")).toMatchObject({
      state: "provider-strict",
      admission: "allowed",
      canRun: true,
      modelCatalog: { status: "supported", strictSchema: "supported" },
    });
    expect(selected("cat/runtime")).toMatchObject({
      state: "runtime-validated",
      admission: "allowed",
      canRun: true,
      modelCatalog: { status: "supported", strictSchema: "unsupported" },
    });
    expect(selected("cat/unsupported")).toMatchObject({
      state: "unavailable",
      admission: "rejected",
      canRun: false,
      reason: "The authoritative model catalog marks formal required tools unsupported.",
      modelCatalog: { status: "unsupported" },
    });
    expect(selected("cat/unknown")).toMatchObject({
      state: "unknown",
      admission: "allowed",
      canRun: true,
      modelCatalog: { status: "unknown" },
    });
    expect(providerCallCounts.get("gateway")).toBe(0);
  });

  test("derives fixed counters, bounded evidence, and deterministic rebuilds", async () => {
    const temp = await makeTempRuntime("agencity-formal-observability-");
    temps.push(temp);
    const rejectedText = "{\"type\":\"typescript\",\"code\":\"raw rejected arguments\"}";
    const model = new ScriptedAgentActionProvider([
      rejectedText,
      {
        protocol: AGENT_ACTION_PROTOCOL,
        version: AGENT_ACTION_VERSION,
        type: "final",
        content: "completed after correction",
      },
    ], "formal-observability");
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [model],
      recover: false,
    });
    try {
      const session = await supervisor.createSession({
        workspaceId: "observability",
        model: { provider: model.name, model: "fixture/model" },
      });
      const result = await supervisor.runs.start(
        session.sessionId,
        session.branchId,
        "exercise formal diagnostics",
      );
      expect(result.status).toBe("succeeded");

      const events = await supervisor.storage.loadEvents(session.sessionId, {
        branchId: session.branchId,
      });
      const first = deriveModelContractDiagnostics(projectEvents(events));
      const rebuilt = deriveModelContractDiagnostics(projectEvents(events));
      expect(rebuilt).toEqual(first);
      expect(first.counters.submissions).toEqual([
        {
          contractId: "agencity.agent-tools.v1",
          tool: "bun_console",
          count: 0,
        },
        {
          contractId: "agencity.agent-tools.v1",
          tool: "finish",
          count: 1,
        },
        {
          contractId: "agencity.refinement-review.v1",
          tool: "agencity_submit_refinement_review",
          count: 0,
        },
      ]);
      expect(first.counters.violations.find(
        item => item.code === "required-tool-missing",
      )?.count).toBe(1);
      expect(first.recentOutcomes).toEqual([
        expect.objectContaining({
          kind: "contract-violation",
          code: "required-tool-missing",
          message: expect.any(String),
          evidence: expect.objectContaining({
            toolCallCount: 0,
            supplementalTextBytes: rejectedText.length,
          }),
        }),
        expect.objectContaining({
          kind: "formal-submission",
          contractId: "agencity.agent-tools.v1",
          tool: "finish",
        }),
      ]);
      expect(JSON.stringify(first)).not.toContain("raw rejected arguments");

      const state = projectEvents(events);
      const accepted = Object.values(state.modelCalls).find(
        call => call.result?.kind === "tool-submission",
      )!;
      const effect = state.effects[accepted.effectId]!;
      const modelCalls: AgentState["modelCalls"] = {};
      const effects: AgentState["effects"] = {};
      for (let index = 0; index < 40; index++) {
        const callId = `bounded-call-${index}`;
        const effectId = `bounded-effect-${index}`;
        modelCalls[callId] = {
          ...accepted,
          id: callId,
          effectId,
        };
        effects[effectId] = {
          ...effect,
          id: effectId,
        };
      }
      const bounded = deriveModelContractDiagnostics({
        ...state,
        modelCalls,
        effects,
        agentRuns: {},
        recursiveModels: {},
      });
      expect(bounded.recentOutcomes).toHaveLength(32);
      expect(bounded.omittedOutcomeCount).toBe(8);
      expect(bounded.counters.submissions[1]?.count).toBe(40);
      expect(bounded.counters.violations).toHaveLength(9);
    } finally {
      await supervisor.close();
    }
  });
});

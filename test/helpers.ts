import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LibSqlStorage,
  materializeInitialAgentProfile,
  type AgentEvent,
  type AgentStorage,
  type BudgetLimits,
  type ModelConfiguration,
  type NewAgentEvent,
} from "../src/index.ts";

export function fixtureAgentProfile(sessionId: string) {
  return materializeInitialAgentProfile({
    role: "Test agent",
    purpose: "Exercise deterministic runtime behavior.",
    instructions: "- Follow the admitted test scenario.",
  }, {
    profileVersionId: `agent-profile-${sessionId}-v1`,
    agentSessionId: sessionId,
    createdBy: { kind: "system", componentId: "agencity.test-fixture", version: 1 },
    reason: "Deterministic test profile",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

export function fixturePromptProvenance(sessionId: string, invocationId = "test-invocation") {
  const profile = fixtureAgentProfile(sessionId);
  return fixturePromptProvenanceForPin({
    profileVersionId: profile.profileVersionId,
    agentPromptDigest: profile.promptDigest,
  }, invocationId);
}

export const FIXTURE_EFFECTIVE_SYSTEM_PROMPT = "Test effective system prompt.";

export function fixturePromptProvenanceForPin(
  pin: { readonly profileVersionId: string; readonly agentPromptDigest: string },
  invocationId = "test-invocation",
  invocationKind: "agent-run" | "recursive-model" = "recursive-model",
) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(FIXTURE_EFFECTIVE_SYSTEM_PROMPT);
  const effectiveDigest = hasher.digest("hex");
  const componentDigest = "a".repeat(64);
  return {
    invocationKind,
    invocationId,
    profileVersionId: pin.profileVersionId,
    agentPromptDigest: pin.agentPromptDigest,
    effectiveSystemPromptDigest: effectiveDigest,
    systemPromptContractId: "agencity.system-prompt.v1" as const,
    components: {
      basePolicy: { componentId: "agencity-base-policy", version: 2, digest: componentDigest },
      agentProfile: { componentId: pin.profileVersionId, version: 1, digest: pin.agentPromptDigest },
      responseContract: { componentId: "test-response", version: 1, digest: componentDigest },
      executionGuidance: { componentId: "test-guidance", version: 1, digest: componentDigest },
    },
  };
}

export interface TempRuntime {
  readonly directory: string;
  readonly databasePath: string;
  readonly databaseUrl: string;
  readonly artifactDirectory: string;
  readonly workspaceRoot: string;
}

export async function makeTempRuntime(prefix = "agencity-test-"): Promise<TempRuntime> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return {
    directory,
    databasePath: join(directory, "runtime.db"),
    databaseUrl: `file:${join(directory, "runtime.db")}`,
    artifactDirectory: join(directory, "artifacts"),
    workspaceRoot: join(directory, "workspace"),
  };
}

export async function removeTempRuntime(temp: TempRuntime): Promise<void> {
  await rm(temp.directory, { recursive: true, force: true });
}

export async function openTempStorage(temp: TempRuntime): Promise<LibSqlStorage> {
  const storage = new LibSqlStorage(temp.databaseUrl);
  await storage.migrate();
  return storage;
}

export async function seedSession(
  storage: AgentStorage,
  options: {
    sessionId?: string;
    branchId?: string;
    workspaceId?: string;
    model?: ModelConfiguration;
    budget?: BudgetLimits;
  } = {},
): Promise<{ sessionId: string; branchId: string; created: AgentEvent<"SessionCreated"> }> {
  const sessionId = options.sessionId ?? "session-1";
  const branchId = options.branchId ?? "main";
  const [created] = await storage.appendEvents([{
    id: `${sessionId}-created`,
    sessionId,
    branchId,
    type: "SessionCreated",
    producer: "supervisor",
    idempotencyKey: `session:${sessionId}`,
    committedAt: "2026-01-01T00:00:00.000Z",
    payload: {
      workspaceId: options.workspaceId ?? "workspace-1",
      initialBranchId: branchId,
      model: options.model ?? { provider: "echo", model: "echo-1", reasoningEffort: "provider-default" },
      budget: options.budget ?? {},
      agentProfile: fixtureAgentProfile(sessionId),
    },
  }]);
  if (!created) throw new Error("Session seed was not committed");
  return { sessionId, branchId, created: created as AgentEvent<"SessionCreated"> };
}

export async function appendMessage(
  storage: AgentStorage,
  sessionId: string,
  branchId: string,
  suffix: string,
  content = suffix,
): Promise<AgentEvent<"MessageAppended">> {
  const [event] = await storage.appendEvents([{
    id: `event-message-${suffix}`,
    sessionId,
    branchId,
    type: "MessageAppended",
    producer: "client",
    idempotencyKey: `message:${suffix}`,
    committedAt: `2026-01-01T00:00:${suffix.padStart(2, "0")}.000Z`,
    payload: { messageId: `message-${suffix}`, role: "user", content },
  }]);
  if (!event) throw new Error("Message was not committed");
  return event as AgentEvent<"MessageAppended">;
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message = "condition",
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

export function eventInput<T extends NewAgentEvent["type"]>(
  event: NewAgentEvent<T>,
): NewAgentEvent<T> {
  return event;
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

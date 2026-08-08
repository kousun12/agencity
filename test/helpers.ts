import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LibSqlStorage,
  type AgentEvent,
  type AgentStorage,
  type BudgetLimits,
  type ModelConfiguration,
  type NewAgentEvent,
} from "../src/index.ts";

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

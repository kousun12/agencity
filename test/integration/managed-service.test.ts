import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { LibSqlStorage } from "../../src/storage/index.ts";
import { ScriptedAgentActionProvider } from "../../src/executors/index.ts";
import type { ModelProvider, TextModelResponse } from "../../src/executors/model.ts";
import { formalOutputFromAgentAction, formalOutputFromRefinementGovernanceDecision } from "../../src/executors/model-response.ts";
import { Supervisor } from "../../src/runtime/index.ts";
import {
  DEFAULT_MANAGED_SERVICE_IDLE_SHUTDOWN_MS,
  ManagedWorkspaceService,
  connectManagedService,
  decodeManagedServiceConfiguration,
  encodeManagedServiceConfiguration,
  managedServiceConfigurationHash,
  readServiceManifest,
  resolveWorkspace,
  serviceStatePaths,
  type ManagedServiceConfiguration,
  type ServiceManifestV1,
} from "../../src/product/index.ts";
import { TerminalUI } from "../../src/tui/index.ts";
import { REFINEMENT_GOVERNANCE_CONTRACT_ID, type JsonValue, type ModelConfiguration, type ModelDispatch, type ModelEffectOutputV2 } from "../../src/domain/index.ts";
import { makeTempRuntime, removeTempRuntime, waitFor, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
const services: ManagedWorkspaceService[] = [];
const configurations: ManagedServiceConfiguration[] = [];
const ownedWorkspaceRoots = new Set<string>();
let baselineServicePids = new Set<number>();

function serviceChildren(): Array<{ pid: number; command: string }> {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,command="]);
  if (result.exitCode !== 0) return [];
  return result.stdout.toString().split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && match[2]!.includes("__service-child") ? [{ pid: Number(match[1]), command: match[2]! }] : [];
  });
}

function processIsLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsLive(pid)) return true;
    await Bun.sleep(25);
  }
  return !processIsLive(pid);
}

function isOwnedServiceChild(manifest: ServiceManifestV1, workspaceRoot: string): boolean {
  if (manifest.pidHint === process.pid) return false;
  const command = serviceChildren().find(candidate => candidate.pid === manifest.pidHint)?.command;
  return Boolean(command?.includes(`__service-child --workspace ${workspaceRoot}`));
}

async function shutdownDetachedService(config: ManagedServiceConfiguration): Promise<void> {
  const manifest = await readServiceManifest({ workspaceRoot: config.workspace.root, workspaceId: config.workspace.workspaceId }).catch(() => null);
  if (!manifest || manifest.pidHint === process.pid) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  try {
    await fetch(`${manifest.url}/service/shutdown`, {
      method: "POST",
      signal: controller.signal,
      headers: { authorization: `Bearer ${manifest.bearerToken}` },
    });
  } catch {} finally { clearTimeout(timeout); }
  if (await waitForProcessExit(manifest.pidHint)) return;
  // pidHint is only a test fallback after the owner-authenticated shutdown. It
  // is constrained to the service child whose argv names this owned temp root.
  if (!isOwnedServiceChild(manifest, config.workspace.root)) return;
  try { process.kill(manifest.pidHint, "SIGTERM"); } catch { return; }
  if (await waitForProcessExit(manifest.pidHint, 1_000)) return;
  if (!isOwnedServiceChild(manifest, config.workspace.root)) return;
  try { process.kill(manifest.pidHint, "SIGKILL"); } catch {}
  await waitForProcessExit(manifest.pidHint, 1_000);
}

async function teardownFixtures(): Promise<void> {
  await Promise.allSettled(services.splice(0).map(service => service.close()));
  await Promise.allSettled(configurations.splice(0).map(shutdownDetachedService));
  await Promise.all(temps.splice(0).map(removeTempRuntime));
}

beforeAll(() => { baselineServicePids = new Set(serviceChildren().map(child => child.pid)); });
afterEach(teardownFixtures);
afterAll(async () => {
  await teardownFixtures();
  const leaked = serviceChildren().filter(child =>
    !baselineServicePids.has(child.pid) && [...ownedWorkspaceRoots].some(root => child.command.includes(root))
  );
  expect(leaked).toEqual([]);
});

async function configuration(prefix: string): Promise<ManagedServiceConfiguration> {
  const temp = await makeTempRuntime(prefix);
  temps.push(temp);
  ownedWorkspaceRoots.add(temp.directory);
  const workspace = await resolveWorkspace({ override: temp.directory, stateDirectory: join(temp.directory, ".agencity") });
  const config: ManagedServiceConfiguration = {
    workspace,
    databasePath: join(workspace.stateDirectory, "agent.db"),
    artifactDirectory: join(workspace.stateDirectory, "artifacts"),
    profileDatabasePath: join(workspace.stateDirectory, "profile.db"),
  };
  configurations.push(config);
  return config;
}

async function opened(config: ManagedServiceConfiguration, modelProviders?: ModelProvider[]): Promise<ManagedWorkspaceService> {
  const service = await ManagedWorkspaceService.open(config, "0.1.0-test", {
    modelCatalog: {
      fetch: (async () => Response.json({ data: [] })) as unknown as typeof fetch,
    },
    ...(modelProviders === undefined ? {} : { modelProviders }),
  });
  services.push(service);
  return service;
}

class ManagedGovernanceProvider implements ModelProvider {
  readonly name = "managed-governance";
  readonly capabilities = {
    streaming: false,
    requiredToolSet: {
      status: "provider-strict",
      requiredChoice: "provider-enforced",
      parallelCalls: "provider-disabled",
      streaming: true,
      adapter: "agencity.managed-governance-test.v1",
    },
  } as const;
  governanceCalls = 0;
  runCalls = 0;
  async complete(_context: JsonValue, _configuration: ModelConfiguration, _signal: AbortSignal): Promise<TextModelResponse> {
    return { text: "unused", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
  }
  async streamResponse(context: JsonValue, dispatch: ModelDispatch): Promise<ModelEffectOutputV2> {
    if (dispatch.responseContract.kind !== "required-tool-set") {
      throw new Error("Unexpected managed governance test contract");
    }
    if (dispatch.responseContract.contractId !== REFINEMENT_GOVERNANCE_CONTRACT_ID) {
      this.runCalls++;
      return formalOutputFromAgentAction({
        action: { protocol: "agencity.agent-action", version: 1, type: "final", content: "Managed governance run completed." },
        dispatch,
        providerToolCallId: `managed-run-${this.runCalls}`,
        provider: this.name,
        adapter: this.capabilities.requiredToolSet.adapter,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      });
    }
    const proposalId = JSON.stringify(context).match(
      /proposalId[^A-Za-z0-9]+(governed-refinement-proposal-[a-f0-9]{32}|[0-9A-HJKMNP-TV-Z]{26})/,
    )?.[1];
    if (!proposalId) throw new Error("Missing managed governance proposal ID");
    this.governanceCalls++;
    return formalOutputFromRefinementGovernanceDecision({
      decision: {
        decision: "approve",
        proposalId,
        reason: "The bounded managed-service proposal follows the frozen policy.",
        satisfiedCriteria: ["scope", "evidence", "runtime-boundaries"],
        residualRisks: ["Outcome improvement remains unproven."],
      },
      dispatch,
      providerToolCallId: `managed-governance-${this.governanceCalls}`,
      provider: this.name,
      adapter: this.capabilities.requiredToolSet.adapter,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    });
  }
}

describe("managed workspace service", () => {
  test("managed configuration defaults preserve old wire compatibility", async () => {
    const config = await configuration("agencity-managed-config-compatibility-");
    const serialized = JSON.parse(
      Buffer.from(encodeManagedServiceConfiguration(config), "base64url")
        .toString("utf8"),
    ) as Record<string, unknown>;
    delete serialized.maxConsoleResidentProcesses;
    delete serialized.maxConsoleActiveExecutions;
    delete serialized.maxAwaitedAgentDepth;
    const decoded = decodeManagedServiceConfiguration(
      Buffer.from(JSON.stringify(serialized)).toString("base64url"),
    );
    expect(decoded).toMatchObject({
      maxConsoleResidentProcesses: 17,
      maxConsoleActiveExecutions: 4,
      maxAwaitedAgentDepth: 8,
    });
    expect(managedServiceConfigurationHash(decoded))
      .toBe(managedServiceConfigurationHash(config));
  });

  test("brokers stored provider keys and durable model selection through the public client", async () => {
    const config = await configuration("agencity-managed-model-config-");
    const service = await opened(config);
    const client = (await connectManagedService(config, { spawn: false })).client;
    const secret = "managed-provider-secret-123456";
    const session = await service.supervisor.createSession({
      workspaceId: config.workspace.workspaceId,
      model: { provider: "echo", model: "echo-1" },
    });
    let output = "";
    const terminal = new TerminalUI(client, {
      interactive: false,
      output: { write(value: string | Uint8Array) { output += String(value); return true; } },
    });
    await terminal.attach(session.sessionId, session.branchId, false);
    try {
      await terminal.execute("/model login anthropic");
      expect(terminal.pendingSecretInput).toBe(true);
      await terminal.execute(secret);
      expect(terminal.pendingSecretInput).toBe(false);
      expect((await client.productConfig()).providers?.find(provider => provider.name === "anthropic")!).toMatchObject({
        usable: true,
        credentialSource: "stored",
      });
      expect((await stat(join(config.workspace.stateDirectory, "auth.json"))).mode & 0o077).toBe(0);

      await terminal.execute("/model anthropic:anthropic/claude.fable.5");
      expect((await client.snapshot(session.sessionId, session.branchId)).state.model).toEqual({
        provider: "anthropic",
        model: "anthropic/claude.fable.5",
        reasoningEffort: "provider-default",
      });
      expect(output).toContain("Saved API key for anthropic in the owner-only local auth file.");
      expect(output).toContain("Selected branch model: anthropic:anthropic/claude.fable.5.");
      expect(output).not.toContain(secret);
      expect(JSON.stringify(await client.history(session.sessionId, session.branchId))).not.toContain(secret);

      expect((await client.capabilities()).reasoningEffortSelection).toBe(true);
      expect((await client.modelCatalog()).endpointId).toMatch(/^[a-f0-9]{64}$/);
      await terminal.execute("/effort high");
      expect((await client.snapshot(session.sessionId, session.branchId)).state.model.reasoningEffort).toBe("high");
      expect((await client.productConfig("anthropic/claude.fable.5")).selectedModelEffortPreference).toBe("high");
      expect(output).toContain("Selected reasoning effort: high.");
      expect(output).toContain("Capability: unverified");

      await terminal.execute("/model logout anthropic");
      expect((await client.productConfig()).providers?.find(provider => provider.name === "anthropic")!).toMatchObject({
        credentialSource: process.env.ANTHROPIC_API_KEY ? "environment" : "missing",
      });
    } finally {
      await terminal.detach(false);
    }
  });

  test("elects one service, publishes owner-only discovery, and requires bearer auth on every route", async () => {
    const config = await configuration("agencity-managed-election-");
    const outcomes = await Promise.allSettled([
      ManagedWorkspaceService.open(config, "0.1.0-test"),
      ManagedWorkspaceService.open(config, "0.1.0-test"),
    ]);
    const winners = outcomes.filter((outcome): outcome is PromiseFulfilledResult<ManagedWorkspaceService> => outcome.status === "fulfilled");
    expect(winners).toHaveLength(1);
    services.push(winners[0]!.value);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    const service = winners[0]!.value;

    expect((await fetch(`${service.manifest.url}/health`)).status).toBe(401);
    expect((await fetch(`${service.manifest.url}/service/status`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const health = await (await fetch(`${service.manifest.url}/health`, { headers: { authorization: `Bearer ${service.manifest.bearerToken}` } })).json() as any;
    expect(health).toMatchObject({ authenticated: true, workspaceId: config.workspace.workspaceId, instanceId: service.manifest.instanceId, appVersion: "0.1.0-test", protocolMin: 2, protocolMax: 2, configHash: managedServiceConfigurationHash(config) });

    const paths = serviceStatePaths(config.workspace.root);
    expect((await stat(paths.serviceDirectory)).mode & 0o077).toBe(0);
    expect((await stat(paths.manifestPath)).mode & 0o077).toBe(0);
    expect(JSON.stringify(await service.status())).not.toContain(service.manifest.bearerToken);
  });

  test("returns durable accepted runs, continues detached, and reattaches from committed state", async () => {
    const config = await configuration("agencity-managed-detach-");
    const service = await opened(config);
    const client = (await connectManagedService(config, { spawn: false })).client;
    const session = await client.createSession(config.workspace.workspaceId, {
      model: { provider: "echo", model: "echo-1" }, sessionName: "detached", branchName: "main",
    });
    const accepted = await client.startRun(session.sessionId, session.branchId, { task: "keep working after detach", goalMode: "none" }) as any;
    expect(accepted).toMatchObject({ accepted: true, status: "queued", sessionId: session.sessionId, branchId: session.branchId });
    const cursorAtDetach = accepted.cursor;
    await waitFor(async () => (await client.run(session.sessionId, session.branchId, accepted.runId)).status === "succeeded", "detached run terminal", 5_000);
    const reattached = (await connectManagedService(config, { spawn: false })).client;
    const result = await reattached.run(session.sessionId, session.branchId, accepted.runId);
    expect(result).toMatchObject({ status: "succeeded", final: "Echo: keep working after detach" });
    const after = await reattached.history(session.sessionId, session.branchId);
    expect(after.filter(event => BigInt(event.cursor) > BigInt(cursorAtDetach)).length).toBeGreaterThan(0);
    expect(new Set(after.map(event => event.cursor)).size).toBe(after.length);
    const status = await reattached.serviceStatus() as any;
    expect(status.roots[0]).toMatchObject({ worker: "detached" });
    expect(status).toMatchObject({
      attachedClients: 0,
      idleShutdownMs: DEFAULT_MANAGED_SERVICE_IDLE_SHUTDOWN_MS,
    });
    expect(status.keepAliveReasons).not.toContainEqual(expect.objectContaining({ kind: "attached_clients" }));
    const idleRemainingMs = new Date(status.idleShutdownAt).getTime() - Date.now();
    expect(idleRemainingMs).toBeGreaterThan(3_590_000);
    expect(idleRemainingMs).toBeLessThanOrEqual(DEFAULT_MANAGED_SERVICE_IDLE_SHUTDOWN_MS);
  });

  test("detached service child retains the one-hour default", async () => {
    const config = await configuration("agencity-managed-child-default-");
    const connection = await connectManagedService(config, { timeoutMs: 5_000 });
    const status = await connection.client.serviceStatus() as any;
    expect(status.idleShutdownMs).toBe(DEFAULT_MANAGED_SERVICE_IDLE_SHUTDOWN_MS);
    const idleRemainingMs = new Date(status.idleShutdownAt).getTime() - Date.now();
    expect(idleRemainingMs).toBeGreaterThan(3_590_000);
    expect(idleRemainingMs).toBeLessThanOrEqual(DEFAULT_MANAGED_SERVICE_IDLE_SHUTDOWN_MS);
  });

  test("detached governance resumes once across managed-service request and terminal-boundary restarts", async () => {
      const boundary = "request" as const;
      const config = await configuration(`agencity-managed-governance-${boundary}-`);
      const provider = new ManagedGovernanceProvider();
      const first = await opened(config, [provider]);
      const client = (await connectManagedService(config, { spawn: false })).client;
      const session = await client.createSession(config.workspace.workspaceId, {
        model: { provider: provider.name, model: "fixture" },
      });
      const evidence = await client.message(session.sessionId, session.branchId, "Managed governance restart evidence");
      const active = await client.agentProfile(session.sessionId, true);
      const append = LibSqlStorage.prototype.appendEvents;
      const crashType = "RefinementGovernanceReviewRequested";
      let crashed = false;
      LibSqlStorage.prototype.appendEvents = async function(events: any[], fence?: any) {
        const committed = await append.call(this, events, fence);
        if (!crashed && events.some(event => event.sessionId === session.sessionId && event.type === crashType)) {
          crashed = true;
          throw new Error(`simulated managed-service crash after ${boundary}`);
        }
        return committed;
      };
      let admitted;
      try {
        admitted = await client.proposeProfileUpdate(session.sessionId, session.branchId, {
          expectedProfileVersionId: active.profileVersionId,
          replacement: {
            role: active.role,
            purpose: active.purpose,
            instructions: `${(active as any).instructions}\n- Resume detached governance exactly once.`,
          },
          reason: "Exercise managed-service governance recovery.",
          predictedEffect: "One recovered review applies one immutable profile.",
          evidenceEventIds: [evidence.id],
          clientRequestId: `managed-governance-${boundary}`,
          wait: false,
        });
        await waitFor(async () => {
          const history = await client.history(session.sessionId, session.branchId);
          return history.some(event => event.type === crashType);
        }, `managed governance ${boundary} boundary`, 5_000);
      } finally {
        LibSqlStorage.prototype.appendEvents = append;
      }
      expect(crashed).toBe(true);
      await first.close();

      const reopened = await opened(config, [provider]);
      const resumed = (await connectManagedService(config, { spawn: false })).client;
      await waitFor(async () => (await resumed.governedRefinement(admitted!.proposalId)).status === "applied", "managed governance recovery", 5_000);
      await reopened.supervisor.refinementGovernance.recoverIncomplete();
      await reopened.supervisor.refinementGovernance.recoverIncomplete();
      const record = await resumed.governedRefinement(admitted!.proposalId);
      const history = await resumed.history(session.sessionId, session.branchId);
      expect(record).toMatchObject({ status: "applied", noticeDelivered: true });
      expect(history.filter(event => event.type === "GovernedRefinementProposed")).toHaveLength(1);
      expect(history.filter(event => event.type === "RefinementGovernanceReviewRequested")).toHaveLength(1);
      expect(history.filter(event => event.type === "RefinementGovernanceReviewChildLinked")).toHaveLength(1);
      expect(history.filter(event => event.type === "RefinementGovernanceReviewDecided")).toHaveLength(1);
      expect(history.filter(event => event.type === "GovernedRefinementApplied")).toHaveLength(1);
      expect(history.filter(event => event.type === "RefinementProposalTerminalNoticeDelivered")).toHaveLength(1);
      expect((await resumed.agentProfiles(session.sessionId)).items).toHaveLength(2);
      const revisedRun = await resumed.startRun(session.sessionId, session.branchId, {
        task: "Use the approved profile after managed recovery.",
        goalMode: "none",
      });
      await waitFor(async () => (await resumed.run(session.sessionId, session.branchId, revisedRun.runId)).status === "succeeded", "post-revision managed run", 5_000);
      const revisedVersionId = record.appliedVersionIds[0]!;
      const rollback = await resumed.rollbackRefinement(session.sessionId, session.branchId, {
        targetKind: "agent_profile",
        targetId: session.sessionId,
        expectedCurrentVersionId: revisedVersionId,
        restoreVersionId: active.profileVersionId,
        reason: "Verify restoration export provenance.",
        evidenceEventIds: [evidence.id],
      });
      const restoredRun = await resumed.startRun(session.sessionId, session.branchId, {
        task: "Use the restored profile.",
        goalMode: "none",
      });
      await waitFor(async () => (await resumed.run(session.sessionId, session.branchId, restoredRun.runId)).status === "succeeded", "post-restoration managed run", 5_000);

      const destination = join(config.workspace.root, `governance-export-${boundary}`);
      const exported = await resumed.exportData(destination, "workspace", config.workspace.workspaceId, "owner");
      expect(exported.status).toBe("completed");
      const bundleEvents = (await Bun.file(join(destination, "events.jsonl")).text()).trim().split("\n").map(line => JSON.parse(line));
      const bundleTypes = bundleEvents.map(event => event.type);
      for (const requiredType of [
        "SessionCreated", "AgentProfileVersionCreated", "AgentProfileActivated",
        "AgentRunRequested", "RecursiveModelStarted", "ContextMaterialized", "ModelCallRequested", "EffectRequested",
        "GovernedRefinementProposed", "RefinementGovernanceReviewRequested",
        "RefinementGovernanceReviewChildLinked", "RefinementGovernanceReviewDecided",
        "GovernedRefinementApplied", "RefinementProposalTerminalNoticeDelivered",
        "RefinementRollbackApplied",
      ]) expect(bundleTypes).toContain(requiredType);
      expect(bundleEvents.find(event => event.type === "RefinementGovernanceReviewRequested").payload.frozenInput.reviewerDispatch.configuration).toBeTruthy();
      expect(bundleEvents.some(event => event.type === "AgentRunRequested" && event.payload.profilePin.profileVersionId === revisedVersionId)).toBe(true);
      expect(bundleEvents.some(event => event.type === "AgentRunRequested" && event.payload.profilePin.profileVersionId === rollback.restorationVersionId)).toBe(true);
      expect(bundleEvents.some(event => event.type === "ModelCallRequested" && typeof event.payload.promptProvenance.effectiveSystemPromptDigest === "string")).toBe(true);
      expect(bundleEvents.filter(event => event.type === "EffectRequested").every(event =>
        typeof event.payload.origin?.kind === "string")).toBe(true);
      const audit = JSON.parse(await Bun.file(join(destination, "export-audit.json")).text());
      expect(audit).toMatchObject({ complete: true, governedProposalCount: 1, decisionCount: 1 });
      expect(audit.profileVersionCount).toBeGreaterThanOrEqual(4);
      expect(JSON.parse(await Bun.file(join(destination, "manifest.json")).text())).toMatchObject({ status: "completed", resources: { exportAudit: { complete: true } } });
      await reopened.supervisor.storage.rebuildOperationalProjections?.();
      await reopened.supervisor.storage.rebuildOperationalProjections?.();
      expect(await resumed.governedRefinement(admitted!.proposalId)).toMatchObject({ status: "applied", noticeDelivered: true });
      expect((await resumed.agentProfiles(session.sessionId)).items).toHaveLength(3);
      await reopened.close();
      const terminalRestart = await opened(config, [provider]);
      const terminalClient = (await connectManagedService(config, { spawn: false })).client;
      await terminalRestart.supervisor.refinementGovernance.recoverIncomplete();
      const terminalHistory = await terminalClient.history(session.sessionId, session.branchId);
      expect(terminalHistory.filter(event => event.type === "GovernedRefinementProposed")).toHaveLength(1);
      expect(terminalHistory.filter(event => event.type === "RefinementGovernanceReviewChildLinked")).toHaveLength(1);
      expect(terminalHistory.filter(event => event.type === "RefinementGovernanceReviewDecided")).toHaveLength(1);
      expect(terminalHistory.filter(event => event.type === "GovernedRefinementApplied")).toHaveLength(1);
      expect(terminalHistory.filter(event => event.type === "RefinementProposalTerminalNoticeDelivered")).toHaveLength(1);
      expect((await terminalClient.agentProfiles(session.sessionId)).items).toHaveLength(3);
      expect(provider.governanceCalls).toBe(1);
      expect(provider.runCalls).toBe(2);
  });

  test("rejects incompatible client configuration and runs schedule delivery only under the resident owner", async () => {
    const config = await configuration("agencity-managed-config-schedule-");
    await opened(config);
    await expect(connectManagedService({ ...config, artifactDirectory: join(config.workspace.stateDirectory, "other-artifacts") }, { spawn: false })).rejects.toMatchObject({ code: "CONFIG_MISMATCH" });

    const client = (await connectManagedService(config, { spawn: false })).client;
    const session = await client.createSession(config.workspace.workspaceId, { model: { provider: "echo", model: "echo-1" } });
    await client.createSchedule(session.sessionId, session.branchId, { at: new Date(Date.now() + 100).toISOString(), prompt: "scheduled detached wake" });
    await waitFor(async () => (await client.wakes(session.sessionId, session.branchId)).some(wake => wake.status === "delivered"), "managed schedule delivery", 5_000);
    const wakes = await client.wakes(session.sessionId, session.branchId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "delivered" });
    const history = await client.history(session.sessionId, session.branchId);
    expect(history.filter(event => event.type === "WakeClaimed")).toHaveLength(1);
    expect(history.filter(event => event.type === "WakeDelivered")).toHaveLength(1);
  });

  test("treats the former and current omitted defaults as a configuration mismatch", async () => {
    const config = await configuration("agencity-managed-default-mismatch-");
    // A former binary normalized an omitted value to 60 seconds before hashing
    // and serializing it for its child. Supplying that normalized value here
    // reproduces the old owner's wire/discovery configuration.
    const formerDefault = { ...config, idleShutdownMs: 60_000 };
    expect(managedServiceConfigurationHash(formerDefault))
      .not.toBe(managedServiceConfigurationHash(config));

    const oldOwner = await opened(formerDefault);
    const manifestPath = serviceStatePaths(config.workspace.root).manifestPath;
    const discoveryBefore = await Bun.file(manifestPath).text();
    const oldManifest = await readServiceManifest({
      workspaceRoot: config.workspace.root,
      workspaceId: config.workspace.workspaceId,
    });
    await expect(connectManagedService(config)).rejects.toMatchObject({
      code: "CONFIG_MISMATCH",
    });
    expect(oldOwner.ready).toBe(true);
    expect(await Bun.file(manifestPath).text()).toBe(discoveryBefore);
    expect(await readServiceManifest({
      workspaceRoot: config.workspace.root,
      workspaceId: config.workspace.workspaceId,
    })).toMatchObject({ instanceId: oldManifest?.instanceId });

    await oldOwner.close();
    const current = await connectManagedService(config, { timeoutMs: 5_000 });
    expect(current.manifest.instanceId).not.toBe(oldManifest?.instanceId);
    expect(current.manifest.configHash).toBe(managedServiceConfigurationHash(config));
    expect((await current.client.serviceStatus() as any).idleShutdownMs)
      .toBe(DEFAULT_MANAGED_SERVICE_IDLE_SHUTDOWN_MS);
  });

  test("graceful shutdown drains and unpublishes without turning detach into cancellation", async () => {
    const config = await configuration("agencity-managed-shutdown-");
    const service = await opened(config);
    const response = await fetch(`${service.manifest.url}/service/shutdown`, { method: "POST", headers: { authorization: `Bearer ${service.manifest.bearerToken}` } });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, lifecycle: "draining" });
    await service.close();
    expect(await Bun.file(serviceStatePaths(config.workspace.root).manifestPath).exists()).toBe(false);
    expect(service.supervisor.executionLeases?.lost).toBe(false);
  });

  test("graceful shutdown waits for protocol handlers admitted before draining", async () => {
    const config = await configuration("agencity-managed-handler-drain-");
    const service = await opened(config);
    const encoder = new TextEncoder();
    let releaseBody = (): void => {};
    let bodyReleased = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(" "));
        releaseBody = () => {
          if (bodyReleased) return;
          bodyReleased = true;
          controller.enqueue(encoder.encode(JSON.stringify({
            workspaceId: config.workspace.workspaceId,
            model: { provider: "echo", model: "echo-1" },
          })));
          controller.close();
        };
      },
    });
    let requestSettled = false;
    const responsePromise = fetch(`${service.manifest.url}/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${service.manifest.bearerToken}`,
        "content-type": "application/json",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" }).finally(() => { requestSettled = true; });
    try {
      await waitFor(async () => (await service.status()).attachedClients > 0, "admitted slow HTTP request", 2_000);

      let closed = false;
      const closePromise = service.close().then(() => { closed = true; });
      await Bun.sleep(20);
      expect(closed).toBe(false);
      expect(requestSettled).toBe(false);

      releaseBody();
      expect((await responsePromise).status).toBe(200);
      await closePromise;
      expect(closed).toBe(true);
    } finally {
      releaseBody();
      await responsePromise.catch(() => null);
    }
  });


  test("a same-device embedded supervisor may observe but cannot advance a managed root without fences", async () => {
    const config = await configuration("agencity-managed-second-supervisor-");
    const service = await opened(config);
    const client = (await connectManagedService(config, { spawn: false })).client;
    const session = await client.createSession(config.workspace.workspaceId, { model: { provider: "echo", model: "echo-1" } });
    await client.message(session.sessionId, session.branchId, "managed owner established root fence");
    const observer = await Supervisor.open({
      databaseUrl: `file:${config.databasePath}`, artifactDirectory: config.artifactDirectory,
      workspaceRoot: config.workspace.root, profileDatabaseUrl: `file:${config.profileDatabasePath}`,
      recover: false, startWakeSchedulers: false,
      sync: { workspaceId: config.workspace.workspaceId },
    });
    try {
      expect((await observer.resume(session.sessionId, session.branchId)).sessionId).toBe(session.sessionId);
      await expect(observer.runs.start(session.sessionId, session.branchId, { task: "competing advancement" })).rejects.toMatchObject({ code: "EXECUTION_OWNERSHIP_CONFLICT" });
      expect((await service.status()).lifecycle).toBe("running");
    } finally { await observer.close(); }
  });

  test("crash restart fences the dead owner and reconciles lost non-idempotent work to unknown without retry", async () => {
    const config = { ...(await configuration("agencity-managed-crash-")), leaseMs: 500 };
    const first = await connectManagedService(config);
    const session = await first.client.createSession(config.workspace.workspaceId, { model: { provider: "echo", model: "echo-1" } });
    const raw = new LibSqlStorage({ url: `file:${config.databasePath}`, deviceId: first.manifest.deviceId });
    try {
      await first.client.message(session.sessionId, session.branchId, "establish crash-test root ownership");
      const workspaceLease = await raw.getProcessExecutionLease({ kind: "workspace", workspaceId: config.workspace.workspaceId });
      const rootLease = await raw.getProcessExecutionLease({ kind: "root", rootSessionId: session.sessionId });
      if (!workspaceLease || !rootLease) throw new Error("Managed service did not retain both write fences");
      const asProof = (lease: typeof workspaceLease) => ({ scope: lease.scope, ownerDeviceId: lease.ownerDeviceId, ownerProcessId: lease.ownerProcessId, fenceToken: lease.fenceToken, now: new Date().toISOString() });
      const fence = { workspace: asProof(workspaceLease), root: asProof(rootLease) };
      const effectId = "crash-non-idempotent";
      await raw.appendEvents([{
        sessionId: session.sessionId, branchId: session.branchId, type: "EffectRequested", producer: "supervisor", idempotencyKey: "crash:effect",
        payload: { effectId, executor: "shell", operation: "run", input: { command: "printf crash-test" }, origin: { kind: "runtime", requestId: "crash:effect" }, idempotencyKey: "crash:effect", idempotent: false },
      }], fence);
      expect((await raw.claimEffect(effectId, "dead-service", undefined, fence))?.status).toBe("running");
      process.kill(first.manifest.pidHint, "SIGKILL");
      await Bun.sleep(800);
      const restarted = await connectManagedService(config, { timeoutMs: 5_000 });
      expect(restarted.manifest.instanceId).not.toBe(first.manifest.instanceId);
      await waitFor(async () => (await restarted.client.history(session.sessionId, session.branchId)).some(event => event.type === "EffectOutcomeRecorded" && (event.payload as any).effectId === effectId), "unknown crash reconciliation", 5_000);
      const history = await restarted.client.history(session.sessionId, session.branchId);
      const outcomes = history.filter(event => event.type === "EffectOutcomeRecorded" && (event.payload as any).effectId === effectId);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.payload).toMatchObject({ outcome: "unknown", error: "Executor ownership was lost before a durable outcome" });
      expect(history.filter(event => event.type === "EffectAttemptStarted" && (event.payload as any).effectId === effectId)).toHaveLength(0);
      await restarted.client.shutdownService();
    } finally { raw.close(); }
  });


  test("service child startup failure does not orphan the spawned process", async () => {
    const base = await configuration("agencity-managed-startup-failure-");
    const config = { ...base, databasePath: base.workspace.root };
    const before = new Set(serviceChildren().map(child => child.pid));
    await expect(connectManagedService(config, { timeoutMs: 500 })).rejects.toThrow("did not become healthy");
    await Bun.sleep(100);
    const owned = serviceChildren().filter(child => !before.has(child.pid) && child.command.includes(base.workspace.root));
    expect(owned).toEqual([]);
    expect(await Bun.file(serviceStatePaths(base.workspace.root).manifestPath).exists()).toBe(false);
  });

  test("service child startup reports the profile cutover error", async () => {
    const config = await configuration("agencity-managed-profile-cutover-");
    const profile = createClient({ url: `file:${config.profileDatabasePath}` });
    try {
      await profile.execute("CREATE TABLE legacy_profile_state(value TEXT)");
    } finally {
      profile.close();
    }
    await expect(connectManagedService(config, { timeoutMs: 2_000 })).rejects.toThrow(
      "This profile database predates the reasoning/model-capability schema cutover",
    );
    expect(await Bun.file(serviceStatePaths(config.workspace.root).manifestPath).exists()).toBe(false);
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`service child ${signal} drains, unpublishes, and releases its lease`, async () => {
      const config = await configuration(`agencity-managed-${signal.toLowerCase()}-`);
      const connection = await connectManagedService(config, { timeoutMs: 5_000 });
      process.kill(connection.manifest.pidHint, signal);
      expect(await waitForProcessExit(connection.manifest.pidHint, 5_000)).toBe(true);
      expect(await Bun.file(serviceStatePaths(config.workspace.root).manifestPath).exists()).toBe(false);
      const raw = new LibSqlStorage({ url: `file:${config.databasePath}`, deviceId: connection.manifest.deviceId });
      try {
        const lease = await raw.getProcessExecutionLease({ kind: "workspace", workspaceId: config.workspace.workspaceId });
        expect(lease).toMatchObject({ ownerProcessId: connection.manifest.instanceId });
        expect(lease?.releasedAt).not.toBeNull();
      } finally { raw.close(); }
    });
  }

  test("bounded idle shutdown releases discovery and execution ownership", async () => {
    const config = { ...(await configuration("agencity-managed-idle-")), idleShutdownMs: 100 };
    const service = await opened(config);
    const manifestPath = serviceStatePaths(config.workspace.root).manifestPath;
    await waitFor(async () => !(await Bun.file(manifestPath).exists()), "idle service shutdown", 5_000);
    await service.close();
    const raw = new LibSqlStorage({ url: `file:${config.databasePath}`, deviceId: service.manifest.deviceId });
    try {
      const lease = await raw.getProcessExecutionLease({ kind: "workspace", workspaceId: config.workspace.workspaceId });
      expect(lease).toMatchObject({ ownerProcessId: service.manifest.instanceId });
      expect(lease?.releasedAt).not.toBeNull();
    } finally { raw.close(); }
  });

  test("status reports warm workers and idle shutdown retires them before exit", async () => {
    const config = {
      ...(await configuration("agencity-managed-warm-scratch-idle-")),
      idleShutdownMs: 2_000,
    };
    const service = await opened(config);
    const session = await service.supervisor.createSession({
      workspaceId: config.workspace.workspaceId,
      model: { provider: "echo", model: "echo-1" },
    });
    await service.supervisor.executeCell(
      session.sessionId,
      session.branchId,
      "scratch.warmOnly = () => 42; ({ warm: typeof scratch.warmOnly === 'function' })",
    );
    expect(service.supervisor.console.status().running).toBe(true);
    expect(await service.status()).toMatchObject({
      console: {
        residentProcesses: 1,
        activeExecutions: 0,
      },
      keepAliveReasons: [
        expect.objectContaining({ kind: "resident_workers", count: 1 }),
      ],
    });

    await waitFor(
      async () => !(await Bun.file(serviceStatePaths(config.workspace.root).manifestPath).exists()),
      "idle service with warm scratch shutdown",
      7_000,
    );
    await service.close();
    expect(service.ready).toBe(false);
    expect(service.supervisor.console.status().running).toBe(false);
  });

  test("a terminal blocked run does not keep the service process resident", async () => {
    const config = { ...(await configuration("agencity-managed-waiting-input-")), idleShutdownMs: 100 };
    const provider = new ScriptedAgentActionProvider([{
      protocol: "agencity.agent-action",
      version: 1,
      type: "blocked",
      reason: "A required external choice is missing.",
    }], "waiting-input-provider");
    const preparer = await Supervisor.open({
      databaseUrl: `file:${config.databasePath}`,
      artifactDirectory: config.artifactDirectory,
      workspaceRoot: config.workspace.root,
      profileDatabaseUrl: `file:${config.profileDatabasePath}`,
      modelProviders: [provider],
      recover: false,
    });
    try {
      const session = await preparer.createSession({
        workspaceId: config.workspace.workspaceId,
        model: { provider: provider.name, model: "scripted-v1" },
      });
      expect(await preparer.runs.start(session.sessionId, session.branchId, "Ask and stop"))
        .toMatchObject({ status: "blocked" });
    } finally {
      await preparer.close();
    }

    const service = await opened(config);
    const manifestPath = serviceStatePaths(config.workspace.root).manifestPath;
    await waitFor(async () => !(await Bun.file(manifestPath).exists()), "idle shutdown after blocked run", 5_000);
    expect(service.ready).toBe(false);
  });

  test("idle shutdown preserves attached clients and future detached schedules", async () => {
    const config = { ...(await configuration("agencity-managed-idle-safety-")), idleShutdownMs: 250 };
    const service = await opened(config);
    const client = (await connectManagedService(config, { spawn: false })).client;
    const session = await client.createSession(config.workspace.workspaceId, { model: { provider: "echo", model: "echo-1" } });
    const controller = new AbortController();
    const response = await fetch(`${service.manifest.url}/sessions/${session.sessionId}/stream?branch=${session.branchId}&after=0`, {
      signal: controller.signal,
      headers: { authorization: `Bearer ${service.manifest.bearerToken}` },
    });
    expect(response.status).toBe(200);
    await Bun.sleep(300);
    expect(service.ready).toBe(true);
    expect(await service.status()).toMatchObject({
      attachedClients: 1,
      idleShutdownMs: 250,
      keepAliveReasons: [expect.objectContaining({ kind: "attached_clients", count: 1 })],
    });
    controller.abort();
    await response.body?.cancel().catch(() => {});

    const schedule = await client.createSchedule(session.sessionId, session.branchId, {
      at: new Date(Date.now() + 10_000).toISOString(),
      prompt: "future detached schedule",
    });
    expect((await service.supervisor.storage.listSchedules?.(session.sessionId, session.branchId))?.[0]).toMatchObject({ scheduleId: schedule.scheduleId, status: "active" });
    expect((await service.status()).keepAliveReasons).toContainEqual(expect.objectContaining({ kind: "active_schedules", count: 1, summary: "1 active schedule" }));
    await Bun.sleep(700);
    expect(service.ready).toBe(true);
    await client.clearSchedule(schedule.scheduleId, "idle policy test complete");
    await waitFor(async () => !(await Bun.file(serviceStatePaths(config.workspace.root).manifestPath).exists()), "idle shutdown after detach safety clears", 5_000);
  });

  test("a deleted temporary workspace does not leave its detached service child alive", async () => {
    const config = { ...(await configuration("agencity-managed-deleted-workspace-")), idleShutdownMs: 100 };
    const connection = await connectManagedService(config, { timeoutMs: 5_000 });
    expect(connection.manifest.pidHint).not.toBe(process.pid);
    await rm(config.workspace.root, { recursive: true, force: true });
    expect(await waitForProcessExit(connection.manifest.pidHint, 5_000)).toBe(true);
  });

});

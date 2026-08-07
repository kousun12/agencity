import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { LibSqlStorage } from "../../src/storage/index.ts";
import { ScriptedAgentActionProvider } from "../../src/executors/index.ts";
import { Supervisor } from "../../src/runtime/index.ts";
import { ManagedWorkspaceService, connectManagedService, managedServiceConfigurationHash, readServiceManifest, resolveWorkspace, serviceStatePaths, type ManagedServiceConfiguration, type ServiceManifestV1 } from "../../src/product/index.ts";
import { TerminalUI } from "../../src/tui/index.ts";
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

async function opened(config: ManagedServiceConfiguration): Promise<ManagedWorkspaceService> {
  const service = await ManagedWorkspaceService.open(config, "0.1.0-test");
  services.push(service);
  return service;
}

describe("managed workspace service", () => {
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

      await terminal.execute("/model anthropic:fable-5");
      expect((await client.snapshot(session.sessionId, session.branchId)).state.model).toEqual({
        provider: "anthropic",
        model: "claude-fable-5",
      });
      expect(output).toContain("Saved API key for anthropic in the owner-only local auth file.");
      expect(output).toContain("Selected branch model: anthropic:claude-fable-5.");
      expect(output).not.toContain(secret);
      expect(JSON.stringify(await client.history(session.sessionId, session.branchId))).not.toContain(secret);

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
    expect(health).toMatchObject({ authenticated: true, workspaceId: config.workspace.workspaceId, instanceId: service.manifest.instanceId, appVersion: "0.1.0-test", protocolMin: 1, protocolMax: 1, configHash: managedServiceConfigurationHash(config) });

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
    expect(status).toMatchObject({ attachedClients: 0, idleShutdownMs: 60_000 });
    expect(status.keepAliveReasons).not.toContainEqual(expect.objectContaining({ kind: "attached_clients" }));
    expect(new Date(status.idleShutdownAt).getTime()).toBeGreaterThan(Date.now());
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
        payload: { effectId, executor: "model", operation: "complete", input: {}, idempotencyKey: "crash:effect", idempotent: false },
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

  test("a durable run waiting for user input does not keep the service process resident", async () => {
    const config = { ...(await configuration("agencity-managed-waiting-input-")), idleShutdownMs: 100 };
    const provider = new ScriptedAgentActionProvider([{
      protocol: "agencity.agent-action",
      version: 1,
      type: "clarification",
      question: "Which retained choice?",
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
      expect(await preparer.runs.start(session.sessionId, session.branchId, "Ask and wait"))
        .toMatchObject({ status: "waiting_for_user" });
    } finally {
      await preparer.close();
    }

    const service = await opened(config);
    const manifestPath = serviceStatePaths(config.workspace.root).manifestPath;
    await waitFor(async () => !(await Bun.file(manifestPath).exists()), "idle shutdown while waiting for durable input", 5_000);
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

import { afterEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { LibSqlStorage } from "../../src/storage/index.ts";
import { ManagedWorkspaceService, connectManagedService, managedServiceConfigurationHash, resolveWorkspace, serviceStatePaths, type ManagedServiceConfiguration } from "../../src/product/index.ts";
import { makeTempRuntime, removeTempRuntime, waitFor, type TempRuntime } from "../helpers.ts";

const temps: TempRuntime[] = [];
const services: ManagedWorkspaceService[] = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(service => service.close()));
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

async function configuration(prefix: string): Promise<ManagedServiceConfiguration> {
  const temp = await makeTempRuntime(prefix);
  temps.push(temp);
  const workspace = await resolveWorkspace({ override: temp.directory, stateDirectory: join(temp.directory, ".agencity") });
  return {
    workspace,
    databasePath: join(workspace.stateDirectory, "agent.db"),
    artifactDirectory: join(workspace.stateDirectory, "artifacts"),
    profileDatabasePath: join(workspace.stateDirectory, "profile.db"),
  };
}

async function opened(config: ManagedServiceConfiguration): Promise<ManagedWorkspaceService> {
  const service = await ManagedWorkspaceService.open(config, "0.1.0-test");
  services.push(service);
  return service;
}

describe("managed workspace service", () => {
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
    expect((await reattached.serviceStatus() as any).roots[0]).toMatchObject({ worker: "detached" });
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

  test("crash restart fences the dead owner and reconciles lost non-idempotent work to unknown without retry", async () => {
    const config = { ...(await configuration("agencity-managed-crash-")), leaseMs: 500 };
    const first = await connectManagedService(config);
    const session = await first.client.createSession(config.workspace.workspaceId, { model: { provider: "echo", model: "echo-1" } });
    const raw = new LibSqlStorage({ url: `file:${config.databasePath}`, deviceId: first.manifest.deviceId });
    try {
      const effectId = "crash-non-idempotent";
      await raw.appendEvents([{
        sessionId: session.sessionId, branchId: session.branchId, type: "EffectRequested", producer: "supervisor", idempotencyKey: "crash:effect",
        payload: { effectId, executor: "model", operation: "complete", input: {}, idempotencyKey: "crash:effect", idempotent: false },
      }]);
      expect((await raw.claimEffect(effectId, "dead-service"))?.status).toBe("running");
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

});

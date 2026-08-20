import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LibSqlStorage,
  ProfileStore,
  ScriptedAgentActionProvider,
  Supervisor,
  projectEvents,
  registerBrokeredSecret,
} from "../../src/index.ts";
import {
  makeTempRuntime,
  removeTempRuntime,
  seedSession,
  waitFor,
  type TempRuntime,
} from "../helpers.ts";

const temps: TempRuntime[] = [];
const supervisors: Supervisor[] = [];
const secretReleases: Array<() => void> = [];

afterEach(async () => {
  for (const release of secretReleases.splice(0)) release();
  await Promise.allSettled(
    supervisors.splice(0).map((supervisor) => supervisor.close()),
  );
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

class BlockingSecondStepProvider extends ScriptedAgentActionProvider {
  blockingSecondStep = false;

  constructor() {
    super([
      {
        protocol: "agencity.agent-action",
        version: 1,
        type: "typescript",
        code: `
          return sdk.processes.start({
            command: "sleep 30",
            idempotencyKey: "run-owned-process",
          });
        `,
      },
      {
        protocol: "agencity.agent-action",
        version: 1,
        type: "final",
        content: "Background work finished.",
      },
    ], "managed-process-cancellation");
  }

  override async complete(
    context: any,
    configuration: any,
    signal: AbortSignal,
  ) {
    if (context?.run?.stepOrdinal === 2) {
      this.blockingSecondStep = true;
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }
    return super.complete(context, configuration, signal);
  }
}

async function open(
  prefix: string,
  options: { restartConsoleAfterCell?: boolean; recover?: boolean } = {},
): Promise<{
  temp: TempRuntime;
  supervisor: Supervisor;
  sessionId: string;
  branchId: string;
}> {
  const temp = await makeTempRuntime(prefix);
  temps.push(temp);
  const supervisor = await Supervisor.open({
    databaseUrl: temp.databaseUrl,
    artifactDirectory: temp.artifactDirectory,
    workspaceRoot: temp.workspaceRoot,
    restartConsoleAfterCell: options.restartConsoleAfterCell ?? false,
    recover: options.recover ?? false,
  });
  supervisors.push(supervisor);
  const { sessionId, branchId } = await supervisor.createSession({
    workspaceId: "managed-process-test",
  });
  return { temp, supervisor, sessionId, branchId };
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("durable managed background processes", () => {
  test("reconstructs JSON handles across worker recycle and supports inspect, logs, list, and stop", async () => {
    const { supervisor, sessionId, branchId } = await open(
      "agencity-managed-process-api-",
      { restartConsoleAfterCell: true },
    );
    const started = await supervisor.executeCell(
      sessionId,
      branchId,
      `
        const handle = await sdk.processes.start({
          command: "printf managed-stdout; printf managed-stderr >&2; sleep 30",
          idempotencyKey: "managed-api",
        });
        await state.set("managed-handle", JSON.parse(JSON.stringify(handle)));
        return handle;
      `,
    );
    const handle = started.result as Record<string, any>;
    expect(handle).toMatchObject({
      status: "running",
      sessionId,
      branchId,
    });

    const managed = await supervisor.executeCell(
      sessionId,
      branchId,
      `
        const retained = await state.get("managed-handle");
        if (!retained || retained.kind !== "json") throw new Error("missing handle");
        const reconstructed = JSON.parse(JSON.stringify(retained.value));
        const before = await sdk.processes.inspect(reconstructed);
        const logs = await sdk.processes.readLogs(reconstructed);
        const listed = await sdk.processes.list();
        const stopped = await sdk.processes.stop(reconstructed, "test stop");
        return { before, logs, listed, stopped };
      `,
    );
    const result = managed.result as Record<string, any>;
    expect(result.before).toMatchObject({
      processId: handle.processId,
      status: "running",
    });
    expect(result.logs).toMatchObject({
      protocol: "agencity.bounded-output.v1",
      completeness: "inline",
      value: {
        stdout: "managed-stdout",
        stderr: "managed-stderr",
      },
    });
    expect(result.listed).toHaveLength(1);
    expect(result.stopped).toMatchObject({
      processId: handle.processId,
      status: "cancelled",
      error: "test stop",
    });

    const state = projectEvents(
      await supervisor.storage.loadEvents(sessionId, { branchId }),
    );
    expect(state.managedProcesses[handle.processId]).toMatchObject({
      status: "cancelled",
      cellId: started.cellId,
      processGroupId: expect.any(Number),
    });
    expect(state.effects[handle.effectId]).toMatchObject({
      executor: "managed-process",
      status: "cancelled",
      idempotent: false,
    });
  });

  test("retains failed status and spills large exact scrubbed output", async () => {
    const { supervisor, sessionId, branchId } = await open(
      "agencity-managed-process-output-",
    );
    const failed = await supervisor.executeCell(
      sessionId,
      branchId,
      `
        return sdk.processes.start({
          command: "printf false-output; exit 7",
          idempotencyKey: "managed-false",
        });
      `,
    );
    const failedHandle = failed.result as Record<string, any>;
    await waitFor(async () =>
      (await supervisor.processes.inspect(
        sessionId,
        branchId,
        failedHandle.processId,
      )).status === "failed",
    "failed process", 5_000);
    const failedProcess = await supervisor.processes.inspect(
      sessionId,
      branchId,
      failedHandle.processId,
    );
    expect(failedProcess).toMatchObject({
      status: "failed",
      error: "Managed process exited 7",
      output: {
        completeness: "inline",
        value: { stdout: "false-output", stderr: "" },
      },
    });

    const large = await supervisor.executeCell(
      sessionId,
      branchId,
      `
        return sdk.processes.start({
          command: "bun -e 'process.stdout.write(\\"x\\".repeat(30000)); process.stderr.write(\\"tail\\")'",
          idempotencyKey: "managed-large",
        });
      `,
    );
    const largeHandle = large.result as Record<string, any>;
    await waitFor(async () =>
      (await supervisor.processes.inspect(
        sessionId,
        branchId,
        largeHandle.processId,
      )).status === "succeeded",
    "large process", 5_000);
    const logs = await supervisor.processes.readLogs(
      sessionId,
      branchId,
      largeHandle.processId,
    ) as Record<string, any>;
    expect(logs).toMatchObject({
      protocol: "agencity.bounded-output.v1",
      completeness: "spilled",
      byteLength: 30_004,
      preview: {
        stdout: { byteLength: 30_000 },
        stderr: { byteLength: 4 },
      },
      layout: {
        stdout: { start: 0, end: 30_000 },
        stderr: { start: 30_000, end: 30_004 },
      },
    });
    expect(logs.artifact.size).toBe(30_004);
    const state = projectEvents(
      await supervisor.storage.loadEvents(sessionId, { branchId }),
    );
    expect(state.artifacts[logs.artifact.artifactId]).toEqual(logs.artifact);
  });

  test("scrubs exact registered values from retained process output", async () => {
    const { temp, supervisor, sessionId, branchId } = await open(
      "agencity-managed-process-scrub-",
    );
    await mkdir(temp.workspaceRoot, { recursive: true });
    const secret = "managed-process-secret-value";
    await writeFile(join(temp.workspaceRoot, "secret.txt"), secret);
    secretReleases.push(registerBrokeredSecret(secret));
    const started = await supervisor.executeCell(
      sessionId,
      branchId,
      `
        return sdk.processes.start({
          command: "cat secret.txt",
          idempotencyKey: "managed-scrub",
        });
      `,
    );
    const handle = started.result as Record<string, any>;
    await waitFor(async () =>
      (await supervisor.processes.inspect(
        sessionId,
        branchId,
        handle.processId,
      )).status === "succeeded",
    "scrubbed process", 5_000);
    const logs = await supervisor.processes.readLogs(
      sessionId,
      branchId,
      handle.processId,
    );
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(logs).toMatchObject({
      completeness: "inline",
      value: { stdout: "[REDACTED]", stderr: "" },
    });
  });

  test("agent-run cancellation stops its owned managed process", async () => {
    const temp = await makeTempRuntime(
      "agencity-managed-process-run-cancel-",
    );
    temps.push(temp);
    const provider = new BlockingSecondStepProvider();
    const supervisor = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      modelProviders: [provider],
      recover: false,
    });
    supervisors.push(supervisor);
    const session = await supervisor.createSession({
      workspaceId: "managed-process-run-cancel",
      model: { provider: provider.name, model: "fixture" },
    });
    const admitted = await supervisor.runs.admit(
      session.sessionId,
      session.branchId,
      { task: "Start then cancel background work", goalMode: "none" },
    );
    const advancing = supervisor.runs.advance(
      session.sessionId,
      session.branchId,
      admitted.runId,
    );
    await waitFor(async () => {
      const [process] = await supervisor.processes.list(
        session.sessionId,
        session.branchId,
      );
      return provider.blockingSecondStep &&
        process?.runId === admitted.runId &&
        process.status === "running";
    }, "run-owned process", 5_000);
    const cancelled = await supervisor.runs.cancel(
      session.sessionId,
      session.branchId,
      admitted.runId,
      "test run cancellation",
    );
    await advancing.catch(() => {});
    expect(cancelled.status).toBe("cancelled");
    expect(await supervisor.processes.list(
      session.sessionId,
      session.branchId,
    )).toContainEqual(expect.objectContaining({
      runId: admitted.runId,
      status: "cancelled",
    }));
  });

  test("graceful supervisor shutdown terminates owned groups and commits cancellation", async () => {
    const { temp, supervisor, sessionId, branchId } = await open(
      "agencity-managed-process-shutdown-",
    );
    const started = await supervisor.executeCell(
      sessionId,
      branchId,
      `
        return sdk.processes.start({
          command: "sleep 30",
          idempotencyKey: "managed-shutdown",
        });
      `,
    );
    const handle = started.result as Record<string, any>;
    const before = await supervisor.processes.inspect(
      sessionId,
      branchId,
      handle.processId,
    );
    expect(before.processGroupId).toEqual(expect.any(Number));
    expect(processGroupExists(before.processGroupId!)).toBe(true);

    supervisors.splice(supervisors.indexOf(supervisor), 1);
    await supervisor.close();
    expect(processGroupExists(before.processGroupId!)).toBe(false);

    const reopened = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      recover: false,
    });
    supervisors.push(reopened);
    expect(await reopened.processes.inspect(
      sessionId,
      branchId,
      handle.processId,
    )).toMatchObject({ status: "cancelled" });
  });

  test("graceful shutdown finds and stops authenticated descendant process groups", async () => {
    const { supervisor, sessionId, branchId } = await open(
      "agencity-managed-process-descendant-shutdown-",
    );
    const started = await supervisor.executeCell(
      sessionId,
      branchId,
      `
        return sdk.processes.start({
          command: \`python3 -c "import os,time; pid=os.fork(); (os.setsid(), print('descendant:'+str(os.getpid()), flush=True), time.sleep(30)) if pid == 0 else time.sleep(30)"\`,
          idempotencyKey: "managed-descendant-shutdown",
        });
      `,
    );
    const handle = started.result as Record<string, any>;
    let descendantPid = 0;
    await waitFor(async () => {
      const logs = await supervisor.processes.readLogs(
        sessionId,
        branchId,
        handle.processId,
      ) as Record<string, any>;
      const stdout = logs.completeness === "inline"
        ? String(logs.value?.stdout ?? "")
        : String(logs.preview?.stdout?.head ?? "");
      const match = stdout.match(/descendant:(\d+)/);
      descendantPid = match ? Number(match[1]) : 0;
      return descendantPid > 0 && processExists(descendantPid);
    }, "detached authenticated descendant", 5_000);

    supervisors.splice(supervisors.indexOf(supervisor), 1);
    await supervisor.close();
    expect(processExists(descendantPid)).toBe(false);
  });

  test("restart recovery never retries uncertain running work and records unknown", async () => {
    const temp = await makeTempRuntime(
      "agencity-managed-process-recovery-",
    );
    temps.push(temp);
    const profileDatabaseUrl = `file:${join(
      temp.directory,
      "recovery-profile.db",
    )}`;
    const profile = await ProfileStore.open(profileDatabaseUrl);
    const device = await profile.getOrCreateDeviceIdentity(
      "managed-process-recovery-device",
    );
    profile.close();
    const storage = new LibSqlStorage({
      url: temp.databaseUrl,
      deviceId: device.deviceId,
    });
    await storage.migrate();
    const { sessionId, branchId } = await seedSession(storage, {
      workspaceId: "managed-process-recovery",
    });
    const processId = "process-recovery";
    const effectId = "effect-recovery";
    const token = "a".repeat(64);
    await storage.appendEvents([
      {
        sessionId,
        branchId,
        type: "CellProposed",
        producer: "console",
        idempotencyKey: "recovery-cell-proposed",
        payload: {
          cellId: "cell-recovery",
          code: "recovery fixture",
          dependencies: [],
        },
      },
      {
        sessionId,
        branchId,
        type: "CellStarted",
        producer: "console",
        idempotencyKey: "recovery-cell-started",
        payload: { cellId: "cell-recovery", attempt: 1 },
      },
      {
        sessionId,
        branchId,
        type: "EffectRequested",
        producer: "supervisor",
        idempotencyKey: "recovery-effect-requested",
        payload: {
          effectId,
          executor: "managed-process",
          operation: "start",
          input: {
            processId,
            command: "must-not-run",
            identityToken: token,
          },
          origin: { kind: "cell", cellId: "cell-recovery" },
          idempotencyKey: "managed-recovery",
          idempotent: false,
        },
      },
      {
        sessionId,
        branchId,
        type: "ManagedProcessRegistered",
        producer: "supervisor",
        idempotencyKey: "recovery-process-registered",
        payload: {
          processId,
          effectId,
          workspaceId: "managed-process-recovery",
          cellId: "cell-recovery",
          command: "must-not-run",
          identityToken: token,
          requestedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        sessionId,
        branchId,
        type: "EffectAttemptStarted",
        producer: "executor",
        idempotencyKey: "recovery-effect-started",
        payload: { effectId, attempt: 1 },
      },
      {
        sessionId,
        branchId,
        type: "ManagedProcessStarted",
        producer: "executor",
        idempotencyKey: "recovery-process-started",
        payload: {
          processId,
          effectId,
          identityToken: token,
          pid: 2_000_000_000,
          processGroupId: 2_000_000_000,
          startedAt: "2026-01-01T00:00:01.000Z",
        },
      },
    ]);
    await storage.resetOutbox(effectId);
    storage.close();

    const recovered = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      profileDatabaseUrl,
      recover: true,
    });
    supervisors.push(recovered);
    const process = await recovered.processes.inspect(
      sessionId,
      branchId,
      processId,
    );
    expect(process).toMatchObject({
      status: "unknown",
      error: expect.stringContaining("ownership was lost"),
    });
    expect(await recovered.processes.readLogs(
      sessionId,
      branchId,
      processId,
    )).toMatchObject({
      completeness: "refused",
      reason: "managed-process-output-unknown",
    });
    const events = await recovered.storage.loadEvents(sessionId, {
      branchId,
    });
    expect(events.filter((event) =>
      event.type === "EffectAttemptStarted" &&
      (event.payload as any).effectId === effectId
    )).toHaveLength(1);
  });

  test("restart cancels a queued process that never reached spawn", async () => {
    const temp = await makeTempRuntime(
      "agencity-managed-process-queued-recovery-",
    );
    temps.push(temp);
    const profileDatabaseUrl = `file:${join(
      temp.directory,
      "queued-recovery-profile.db",
    )}`;
    const profile = await ProfileStore.open(profileDatabaseUrl);
    const device = await profile.getOrCreateDeviceIdentity(
      "managed-process-queued-recovery-device",
    );
    profile.close();
    const storage = new LibSqlStorage({
      url: temp.databaseUrl,
      deviceId: device.deviceId,
    });
    await storage.migrate();
    const { sessionId, branchId } = await seedSession(storage, {
      workspaceId: "managed-process-queued-recovery",
    });
    const processId = "process-queued-recovery";
    const effectId = "effect-queued-recovery";
    const token = "b".repeat(64);
    await storage.appendEvents([
      {
        sessionId,
        branchId,
        type: "CellProposed",
        producer: "console",
        idempotencyKey: "queued-recovery-cell-proposed",
        payload: {
          cellId: "cell-queued-recovery",
          code: "queued recovery fixture",
          dependencies: [],
        },
      },
      {
        sessionId,
        branchId,
        type: "CellStarted",
        producer: "console",
        idempotencyKey: "queued-recovery-cell-started",
        payload: { cellId: "cell-queued-recovery", attempt: 1 },
      },
      {
        sessionId,
        branchId,
        type: "EffectRequested",
        producer: "supervisor",
        idempotencyKey: "queued-recovery-effect-requested",
        payload: {
          effectId,
          executor: "managed-process",
          operation: "start",
          input: {
            processId,
            command: "must-not-run",
            identityToken: token,
          },
          origin: { kind: "cell", cellId: "cell-queued-recovery" },
          idempotencyKey: "managed-queued-recovery",
          idempotent: false,
        },
      },
      {
        sessionId,
        branchId,
        type: "ManagedProcessRegistered",
        producer: "supervisor",
        idempotencyKey: "queued-recovery-process-registered",
        payload: {
          processId,
          effectId,
          workspaceId: "managed-process-queued-recovery",
          cellId: "cell-queued-recovery",
          command: "must-not-run",
          identityToken: token,
          requestedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);
    storage.close();

    const recovered = await Supervisor.open({
      databaseUrl: temp.databaseUrl,
      artifactDirectory: temp.artifactDirectory,
      workspaceRoot: temp.workspaceRoot,
      profileDatabaseUrl,
      recover: true,
    });
    supervisors.push(recovered);
    expect(await recovered.processes.inspect(
      sessionId,
      branchId,
      processId,
    )).toMatchObject({
      status: "cancelled",
      error: expect.stringContaining("before spawn"),
      pid: null,
      processGroupId: null,
    });
    const events = await recovered.storage.loadEvents(sessionId, {
      branchId,
    });
    expect(events.filter((event) =>
      event.type === "ManagedProcessStarted"
    )).toHaveLength(0);
    expect(events.filter((event) =>
      event.type === "EffectAttemptStarted" &&
      (event.payload as any).effectId === effectId
    )).toHaveLength(1);
  });
});

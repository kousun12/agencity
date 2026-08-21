import { afterEach, describe, expect, test } from "bun:test";
import { AcceptanceWorld, eventually, parseSingleJson } from "./helpers.ts";
import { StrictActionFixture, action } from "./strict-action-fixture.ts";

const worlds: AcceptanceWorld[] = [];
const fixtures: StrictActionFixture[] = [];
const FAST_RECOVERY = {
  AGENCITY_ACCEPTANCE: "1",
  AGENCITY_ACCEPTANCE_LEASE_MS: "250",
} as const;

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const world of worlds.splice(0)) await world.dispose();
});

async function setup(
  label: string,
  extra: Readonly<Record<string, string>> = {},
  base: Readonly<Record<string, string>> = {},
) {
  const fixture = new StrictActionFixture();
  fixtures.push(fixture);
  const world = await AcceptanceWorld.create(label, base);
  worlds.push(world);
  const environment = { ...fixture.environment(), ...extra };
  const configured = await world.command(
    ["config", "set-model", "openai:openai/fixture-v1", "--json"],
    environment,
  );
  expect(configured.code, configured.stderr).toBe(0);
  return { fixture, world, environment };
}

describe("installed explicit AI and typed agent invocations", () => {
  test("executes raw text/object and awaited/detached text/object agents through the real console", async () => {
    const { fixture, world, environment } = await setup("explicit-ai-agents");
    const task = "exercise explicit AI and typed agents";
    const rawTextPrompt = "Summarize these exact failures without inventing causes.";
    const rawObjectPrompt = "Classify this exact evidence.";
    const repositoryInstructionMarker = "AMBIENT_REPOSITORY_GUIDANCE_MUST_NOT_REACH_RAW_AI";
    await Bun.write(
      `${world.repository}/AGENTS.md`,
      `# Fixture guidance\n\n${repositoryInstructionMarker}\n`,
    );

    fixture.script(rawTextPrompt, ["Two exact failures were supplied."]);
    fixture.script(rawObjectPrompt, [{
      name: "agencity_submit_object",
      input: { value: { complete: false, missing: ["integration check"] } },
    }]);
    fixture.script("return a normal text report", [
      action("final", "child text report"),
    ]);
    fixture.script("return a structured readiness result", [{
      name: "finish",
      input: {
        outcome: {
          status: "succeeded",
          message: "structured child complete",
          value: { ready: true, checks: 3 },
        },
      },
    }]);
    fixture.script("finish detached audit", [
      action("final", "detached audit complete"),
    ]);
    fixture.script(task, [
      action("typescript", String.raw`
        const { z } = await import("zod");
        const summary = await ai.generateText({
          prompt: "Summarize these exact failures without inventing causes.",
          context: [{ failures: ["unit", "integration"] }],
          idempotencyKey: "acceptance-raw-text",
        });
        const verdict = await ai.generateObject({
          prompt: "Classify this exact evidence.",
          context: [{ checks: ["unit"] }],
          schema: z.object({
            complete: z.boolean(),
            missing: z.array(z.string()),
          }),
          idempotencyKey: "acceptance-raw-object",
        });
        const textChild = await sdk.agents.run({
          task: "return a normal text report",
          idempotencyKey: "acceptance-text-child",
        });
        const objectChild = await sdk.agents.run({
          task: "return a structured readiness result",
          output: {
            schema: z.object({
              ready: z.boolean(),
              checks: z.number().int().min(0),
            }),
          },
          idempotencyKey: "acceptance-object-child",
        });
        const detached = await sdk.agents.spawn({
          task: "finish detached audit",
          idempotencyKey: "acceptance-detached-child",
        });
        const detachedResult = await detached.result({
          wait: true,
          timeoutMs: 30_000,
        });
        const serializedDetached = JSON.parse(JSON.stringify(detached));
        return {
          rawText: summary.text,
          rawObject: verdict.object,
          textOutput: textChild.status === "succeeded" ? textChild.output : null,
          objectOutput: objectChild.status === "succeeded" ? objectChild.output : null,
          detachedStatus: detachedResult.status,
          detachedTask: detached.taskId,
          detachedHandle: detached,
          detachedResultMethod: typeof detached.result,
          serializedDetachedHasResult: Object.hasOwn(serializedDetached, "result"),
          publicSurface: {
            rlm: typeof globalThis.rlm,
            sdkRlm: typeof sdk.rlm,
          },
        };
      `),
      probe => {
        expect(probe.allMessageText).toContain('"rawText":"Two exact failures were supplied."');
        expect(probe.allMessageText).toContain('"complete":false');
        expect(probe.allMessageText).toContain('"text":"child text report"');
        expect(probe.allMessageText).toContain('"ready":true');
        expect(probe.allMessageText).toContain('"detachedStatus":"succeeded"');
        expect(probe.allMessageText).toContain('"detachedHandle":{"taskId":"task-');
        expect(probe.allMessageText).toContain('"detachedResultMethod":"function"');
        expect(probe.allMessageText).toContain('"serializedDetachedHasResult":false');
        expect(probe.allMessageText).toContain('"rlm":"undefined"');
        expect(probe.allMessageText).toContain('"sdkRlm":"undefined"');
        return action("final", "explicit generation and typed agents completed");
      },
    ]);

    const completed = await world.command(["run", "--json", task], environment);
    expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
    expect(parseSingleJson(completed)).toMatchObject({
      status: "succeeded",
      final: "explicit generation and typed agents completed",
      steps: 2,
    });
    const rawTextRequest = fixture.requests.find(item =>
      item.firstUserText === rawTextPrompt
    );
    const rawObjectRequest = fixture.requests.find(item =>
      item.firstUserText === rawObjectPrompt
    );
    expect(fixture.requests.filter(item =>
      item.firstUserText === rawTextPrompt
    )).toHaveLength(1);
    expect(fixture.requests.filter(item =>
      item.firstUserText === rawObjectPrompt
    )).toHaveLength(1);
    expect(rawTextRequest).toMatchObject({ toolNames: [] });
    expect(rawObjectRequest).toMatchObject({
      toolNames: ["agencity_submit_object"],
      toolChoice: "required",
    });
    expect(rawTextRequest?.messageRoles).toEqual(["system", "user", "user"]);
    expect(rawObjectRequest?.messageRoles).toEqual(["system", "user", "user"]);
    expect(rawTextRequest?.lastUserText).toContain("EXPLICIT CONTEXT");
    for (const request of [rawTextRequest, rawObjectRequest]) {
      expect(request?.allMessageText).not.toContain(task);
      expect(request?.allMessageText).not.toContain(repositoryInstructionMarker);
      expect(request?.allMessageText).not.toContain(
        "Advance user-directed work in this workspace.",
      );
      expect(request?.toolNames).not.toContain("bun_console");
      expect(request?.toolNames).not.toContain("finish");
    }
    const parentRequest = fixture.requests.find(item => item.task === task);
    expect(parentRequest?.allMessageText).toContain(repositoryInstructionMarker);
    expect(parentRequest?.allMessageText).toContain(
      "Advance user-directed work in this workspace.",
    );
    expect(fixture.count("return a normal text report")).toBe(1);
    expect(fixture.count("return a structured readiness result")).toBe(1);
    expect(fixture.count("finish detached audit")).toBe(1);
  }, 120_000);

  test("supports an awaited child that awaits a grandchild", async () => {
    const { fixture, world, environment } = await setup("nested-agents");
    const task = "exercise nested awaited agents";
    fixture.script("nested child", [
      action("typescript", `
        const grandchild = await sdk.agents.run({
          task: "nested grandchild",
          idempotencyKey: "nested-grandchild",
        });
        return { grandchild };
      `),
      action("final", "child observed grandchild completion"),
    ]);
    fixture.script("nested grandchild", [
      action("final", "grandchild completed"),
    ]);
    fixture.script(task, [
      action("typescript", `
        const child = await sdk.agents.run({
          task: "nested child",
          idempotencyKey: "nested-child",
        });
        return { child };
      `),
      action("final", "nested execution completed"),
    ]);

    const completed = await world.command(["run", "--json", task], environment);
    expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
    expect(parseSingleJson(completed)).toMatchObject({
      status: "succeeded",
      final: "nested execution completed",
    });
    expect(fixture.count(task)).toBe(2);
    expect(fixture.count("nested child")).toBe(2);
    expect(fixture.count("nested grandchild")).toBe(1);
  }, 120_000);

  test("recovers detached child admission after parent worker and service loss", async () => {
    const { fixture, world, environment } = await setup(
      "agent-worker-loss",
      { AGENCITY_ACCEPTANCE_FAILPOINT: "cell-committed" },
      FAST_RECOVERY,
    );
    const task = "recover typed child after committed parent cell";
    fixture.script("recovered detached child", [
      action("final", "recovered detached child complete"),
    ]);
    fixture.script(task, [
      action("typescript", `
        const child = await sdk.agents.spawn({
          task: "recovered detached child",
          idempotencyKey: "recovered-detached-child",
        });
        return { detachedTask: child.taskId };
      `),
      action("final", "parent recovered without duplicate child admission"),
    ]);

    const crashed = await world.command(["run", "--json", task], environment);
    expect(crashed.code).not.toBe(0);
    expect(crashed.stderr).toContain("Unable to connect");
    const recoveredEnvironment = fixture.environment();
    const recovered = await eventually(async () => {
      const status = await world.command(
        ["status", "current", "--json"],
        recoveredEnvironment,
      );
      if (status.code !== 0) return undefined;
      const value = parseSingleJson(status);
      return value.status === "succeeded" ? value : undefined;
    }, 30_000);
    expect(recovered.final).toContain("without duplicate child admission");
    expect(fixture.count(task)).toBe(2);
    expect(fixture.count("recovered detached child")).toBe(1);
  }, 120_000);

  test("keeps an awaited child running after the installed client is lost", async () => {
    const { fixture, world, environment } = await setup("agent-client-loss");
    const task = "await child across installed client loss";
    fixture.script("client-loss child", [
      action("final", "client-loss child complete"),
    ]);
    fixture.hold("client-loss child");
    fixture.script(task, [
      action("typescript", `
        const child = await sdk.agents.run({
          task: "client-loss child",
          idempotencyKey: "client-loss-child",
        });
        return { child };
      `),
      action("final", "awaited child survived client loss"),
    ]);

    const running = world.start(["run", "--json", task], environment);
    await fixture.waitFor("client-loss child");
    running.child.kill("SIGKILL");
    const lostClient = await running.collect();
    expect(lostClient.code).not.toBe(0);
    fixture.release("client-loss child");
    const recovered = await eventually(async () => {
      const status = await world.command(["status", "current", "--json"], environment);
      if (status.code !== 0) return undefined;
      const value = parseSingleJson(status);
      return value.status === "succeeded" ? value : undefined;
    }, 30_000);
    expect(recovered.final).toContain("survived client loss");
    expect(fixture.count(task)).toBe(2);
    expect(fixture.count("client-loss child")).toBe(1);
  }, 120_000);

  test("fails an unsatisfiable awaited nested batch before grandchild admission", async () => {
    const { fixture, world, environment } = await setup("agent-capacity");
    const task = "exercise awaited capacity failure";
    const childTasks = Array.from(
      { length: 16 },
      (_, index) => `capacity child ${index}`,
    );
    for (const [index, childTask] of childTasks.entries()) {
      fixture.script(childTask, [
        action("typescript", `
          try {
            return await sdk.agents.run({
              task: "capacity grandchild ${index}",
              idempotencyKey: "capacity-grandchild-${index}",
            });
          } catch (error) {
            return {
              code: error && typeof error === "object" && "code" in error
                ? error.code
                : null,
              message: error instanceof Error ? error.message : String(error),
            };
          }
        `),
        probe => {
          expect(probe.allMessageText).toContain("CONSOLE_CAPACITY_EXCEEDED");
          return action("failed", "nested capacity was refused before admission");
        },
      ]);
    }
    fixture.script(task, [
      action("typescript", `
        const tasks = ${JSON.stringify(childTasks)};
        const results = await sdk.agents.runMany(
          tasks.map((task, index) => ({
            task,
            idempotencyKey: "capacity-child-" + index,
          })),
        );
        return { statuses: results.map(result => result.status) };
      `),
      action("final", "capacity failure remained explicit"),
    ]);

    const completed = await world.command(["run", "--json", task], environment);
    expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
    expect(parseSingleJson(completed)).toMatchObject({
      status: "succeeded",
      final: "capacity failure remained explicit",
    });
    expect(fixture.requests.filter(item =>
      item.task?.startsWith("capacity grandchild")
    )).toHaveLength(0);
    const tree = await world.command(["tree", "--json"], environment);
    expect(tree.code, `${tree.stdout}\n${tree.stderr}`).toBe(0);
    expect(tree.stdout).toContain("capacity child 0");
    expect(tree.stdout).not.toContain("capacity grandchild");
    expect(childTasks.every(childTask => fixture.count(childTask) === 2)).toBe(
      true,
    );
  }, 120_000);
});

import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AcceptanceWorld, eventually, parseSingleJson } from "./helpers.ts";
import { StrictActionFixture, action } from "./strict-action-fixture.ts";

const worlds: AcceptanceWorld[] = [];
const fixtures: StrictActionFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const world of worlds.splice(0)) await world.dispose();
});

describe("FU-009 installed no-ID release transcript", () => {
  test("links outside the checkout and completes coding, gate repair, retained helpers, detach, named head branch, resume, tree, and history", async () => {
    const fixture = new StrictActionFixture(); fixtures.push(fixture);
    const world = await AcceptanceWorld.create("primary"); worlds.push(world);
    const task = "repair answer with durable helpers";
    await writeFile(join(world.repository, "answer.txt"), "0\n");

    fixture.script(task, [
      action("typescript", String.raw`
        const before = await tools.readFile("answer.txt");
        await tools.writeFile("answer.txt", "41\n");
        const check = await tools.shell("test -f answer.txt && grep -q '^41$' answer.txt");
        await state.set("acceptance-first-pass", { before, check });
        return {
          wrote: 41,
          verifiedFirstPass:
            check.completeness === "inline" && check.value.exitCode === 0,
        };
      `),
      action("typescript", String.raw`
        const child = await sdk.agents.spawn({ task: "acceptance child initial", name: "acceptance-child" });
        await state.set("acceptance-child", child);
        return { aiAvailable: typeof ai.generateText === "function", child };
      `),
      action("final", "premature completion should be rejected by the required gate"),
      action("typescript", String.raw`
        const savedChild = await state.get("acceptance-child");
        for (let attempt = 0; attempt < 100; attempt++) {
          const roster = await sdk.agents.list();
          const child = roster.items.find(item => item.name === "acceptance-child");
          if (child?.taskStatus === "completed") break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        const queued = await sdk.agents.send("acceptance-child", "acceptance child queued work", { taskId: savedChild.value.taskId });
        await tools.writeFile("answer.txt", "42\n");
        const verification = await tools.shell("grep -q '^42$' answer.txt && printf verified");
        return { queued, verification };
      `),
      action("final", "answer repaired to 42; retained child queue was exercised"),
    ]);
    fixture.script("acceptance child initial", [action("final", "initial child result")]);
    fixture.script("acceptance child queued work", [action("final", "queued child result")]);

    const missing = await world.command(["run", "--json", "provider must be explicit"]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("No usable model is selected");
    expect(`${missing.stdout}${missing.stderr}`).not.toContain("Echo:");
    await world.command(["service", "shutdown", "--json"]);

    const configured = await world.command(["config", "set-model", "openai:openai/fixture-v1", "--json"], fixture.environment());
    expect(configured.code).toBe(0);
    expect(configured.stdout).toContain("openai:openai/fixture-v1");

    const completed = await world.command([
      "run", "--json",
      "--completion-gate", "grep -q '^42$' answer.txt",
      task,
    ], fixture.environment());
    expect(completed.stderr).toBe("");
    const outcome = parseSingleJson(completed);
    expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
    expect(outcome).toMatchObject({ protocol: "agencity.run-result", version: 1, status: "succeeded", exitCode: 0, steps: 5 });
    expect(outcome.final).toContain("answer repaired to 42");
    expect(await readFile(join(world.repository, "answer.txt"), "utf8")).toBe("42\n");
    expect(fixture.requests.filter(item => item.task === task).every(item => item.streaming)).toBe(true);
    expect(fixture.requests.filter(item => item.task === task).every(item =>
      JSON.stringify(item.toolNames) === JSON.stringify(["bun_console", "finish"]) &&
      item.toolChoice === "required" &&
      item.parallelToolCalls === false)).toBe(true);
    expect(fixture.requests.find(item => item.task === task && item.step === 4)?.allMessageText).toContain("AgentRunGoalCheckRecorded");
    const childInitial = await fixture.waitFor("acceptance child initial");
    expect(fixture.count("acceptance child initial")).toBe(1);
    expect(childInitial).toMatchObject({
      toolNames: ["bun_console", "finish"],
      toolChoice: "required",
      parallelToolCalls: false,
    });
    await fixture.waitFor("acceptance child queued work");
    expect(fixture.count("acceptance child queued work")).toBe(1);

    const tree = await world.command(["tree", "--json"], fixture.environment());
    expect(tree.code).toBe(0);
    expect(tree.stdout).toContain("acceptance-child");
    const status = await world.command(["status", "current", "--json"], fixture.environment());
    expect(status.code).toBe(0);
    expect(parseSingleJson(status)).toMatchObject({ status: "succeeded", exitCode: 0 });
    const history = await world.command(["history", "current", "--json"], fixture.environment());
    expect(history.code).toBe(0);
    expect(history.stdout).toContain("premature completion");
    expect(history.stdout).toContain("CLI completion verification");
    expect(history.stdout).toContain('"aiAvailable": true');

    const branched = await world.command(["branch", "head", "acceptance-repair", "--json"], fixture.environment());
    expect(branched.code).toBe(0);
    expect(branched.stdout).toContain("acceptance-repair");
    const resumed = await world.command(["resume", "acceptance-repair"], fixture.environment());
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain("acceptance-repair");

    const quit = await world.commandWithInput([], "/quit\n", fixture.environment());
    expect(quit).toMatchObject({ code: 0, stderr: "" });
    expect(quit.stdout).toContain("Agencity trusted-local TUI");
    expect(quit.stdout).toContain("Detached. Session identity and durable work remain owned by the service.");
    const afterQuit = await world.command(["status", "current", "--json"], fixture.environment());
    expect(parseSingleJson(afterQuit)).toMatchObject({ status: "succeeded", exitCode: 0 });

    const detachedTask = "detached service continuation";
    fixture.script(detachedTask, [action("final", "detached work completed after the client exited")]);
    fixture.hold(detachedTask);
    const detached = await world.command(["run", "--detach", "--json", detachedTask], fixture.environment());
    expect(detached.code).toBe(0);
    expect(parseSingleJson(detached)).toEqual({ protocol: "agencity.run-accepted", version: 1, accepted: true, detached: true });
    await fixture.waitFor(detachedTask);
    fixture.release(detachedTask);
    await eventually(async () => {
      const observed = await world.command(["status", "current", "--json"], fixture.environment());
      if (observed.code !== 0) return undefined;
      const value = parseSingleJson(observed);
      return value.status === "succeeded" && value.final?.includes("detached work completed") ? value : undefined;
    });
    expect(fixture.count(detachedTask)).toBe(1);
  }, 120_000);

  test("bounds unexpected shell output and completes after focused artifact-range verification", async () => {
    const fixture = new StrictActionFixture(); fixtures.push(fixture);
    const world = await AcceptanceWorld.create("large-shell"); worlds.push(world);
    const task = "verify an unexpected large shell result";

    fixture.script(task, [
      action("typescript", String.raw`
        const output = await tools.shell(
          "awk 'BEGIN { for (i = 0; i < 30000; i++) printf \"x\"; printf \"TAIL-MARKER\\\\n\" }'"
        );
        return output;
      `),
      probe => {
        expect(probe.allMessageText).toContain('"completeness":"spilled"');
        expect(probe.allMessageText).toContain("artifacts.readRange(artifactId, start, end)");
        expect(probe.allMessageText).toContain('"head":"');
        expect(probe.allMessageText).toContain('"tail":"');
        const artifactId = probe.allMessageText.match(
          /"artifact":\{"artifactId":"(sha256:[a-f0-9]{64})"/,
        )?.[1];
        const stdoutEnd = probe.allMessageText.match(
          /"layout":\{"stdout":\{"start":0,"end":([0-9]+)/,
        )?.[1];
        if (!artifactId || !stdoutEnd) {
          throw new Error("bounded shell observation omitted artifact range metadata");
        }
        const end = Number(stdoutEnd);
        return action("typescript", `
          const range = await artifacts.readRange(
            ${JSON.stringify(artifactId)},
            ${Math.max(0, end - 64)},
            ${end}
          );
          const tail = new TextDecoder().decode(range.value.bytes);
          return {
            completeness: range.completeness,
            start: range.value.start,
            end: range.value.end,
            size: range.value.size,
            nextStart: range.value.nextStart,
            recoveredTail: tail.includes("TAIL-MARKER"),
          };
        `);
      },
      probe => {
        expect(probe.allMessageText).toContain('"completeness":"inline"');
        expect(probe.allMessageText).toContain('"recoveredTail":true');
        return action("final", "large shell output was bounded and its exact tail was verified");
      },
    ]);

    const configured = await world.command(
      ["config", "set-model", "openai:openai/fixture-v1", "--json"],
      fixture.environment(),
    );
    expect(configured.code).toBe(0);

    const completed = await world.command(
      ["run", "--json", task],
      fixture.environment(),
    );
    expect(completed.stderr).toBe("");
    expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
    expect(parseSingleJson(completed)).toMatchObject({
      protocol: "agencity.run-result",
      version: 1,
      status: "succeeded",
      exitCode: 0,
      steps: 3,
      final: "large shell output was bounded and its exact tail was verified",
    });
    expect(fixture.count(task)).toBe(3);
  }, 120_000);

  test("keeps a REPL namespace warm across detached cells, isolates forks, and reconstructs from state after service loss", async () => {
    const fixture = new StrictActionFixture(); fixtures.push(fixture);
    const world = await AcceptanceWorld.create("repl-lifecycle"); worlds.push(world);
    const warmTask = "exercise compact warm REPL namespace";
    const isolationTask = "verify isolated fork REPL namespace";
    const coldTask = "reconstruct REPL inputs after service loss";

    fixture.script(warmTask, [
      action("typescript", String.raw`
        const durableInput = { seed: 7, count: 2048 };
        await state.set("repl-rebuild-input", durableInput);
        const replRows = Array.from(
          { length: durableInput.count },
          (_, index) => durableInput.seed + index,
        );
        const replIdentity = { label: "same-worker-object" };
        const replAlias = replIdentity;
        function replTransform(value: number) {
          return value * 2;
        }
        return { retainedRows: replRows.length, durableKeys: 1 };
      `),
      probe => {
        expect(probe.allMessageText).toContain('"retainedRows":2048');
        expect(probe.allMessageText.length).toBeLessThan(100_000);
        return action("typescript", String.raw`
          const warmIdentity = replIdentity === replAlias;
          const transformed = replTransform(replRows[10]);
          return {
            bindingsAvailable: true,
            warmIdentity,
            transformed,
            retainedRows: replRows.length,
          };
        `);
      },
      probe => {
        expect(probe.allMessageText).toContain('"bindingsAvailable":true');
        expect(probe.allMessageText).toContain('"warmIdentity":true');
        expect(probe.allMessageText).toContain('"transformed":34');
        expect(probe.allMessageText).toContain('"retainedRows":2048');
        return action("final", "warm REPL bindings and object identity persisted with compact observations");
      },
    ]);
    fixture.script(isolationTask, [
      action("typescript", String.raw`
        const parentBindingsMissing =
          typeof replRows === "undefined" &&
          typeof replIdentity === "undefined" &&
          typeof replTransform === "undefined";
        const forkInput = { seed: 99, count: 1 };
        function forkTransform(value: number) {
          return value + 1;
        }
        return {
          parentBindingsMissing,
          forkSeed: forkInput.seed,
          forkValue: forkTransform(forkInput.seed),
        };
      `),
      probe => {
        expect(probe.allMessageText).toContain('"parentBindingsMissing":true');
        expect(probe.allMessageText).toContain('"forkSeed":99');
        expect(probe.allMessageText).toContain('"forkValue":100');
        return action("final", "fork REPL namespace remained isolated");
      },
    ]);
    fixture.script(coldTask, [
      action("typescript", String.raw`
        const warmBindingsGone =
          typeof replRows === "undefined" &&
          typeof replIdentity === "undefined" &&
          typeof replTransform === "undefined";
        const durable = await state.get("repl-rebuild-input");
        const stateInventory = await state.list();
        const reconstructedRows = Array.from(
          { length: durable.value.count },
          (_, index) => durable.value.seed + index,
        );
        function reconstructedTransform(value: number) {
          return value * 2;
        }
        return {
          warmBindingsGone,
          reconstructedSeed: durable.value.seed,
          reconstructedRows: reconstructedRows.length,
          rebuiltValue: reconstructedTransform(durable.value.seed),
          durableStateNames: stateInventory.map(item => item.name),
        };
      `),
      probe => {
        expect(probe.allMessageText).toContain('"warmBindingsGone":true');
        expect(probe.allMessageText).toContain('"reconstructedSeed":7');
        expect(probe.allMessageText).toContain('"reconstructedRows":2048');
        expect(probe.allMessageText).toContain('"rebuiltValue":14');
        expect(probe.allMessageText).toContain('"durableStateNames":["repl-rebuild-input"]');
        return action("final", "warm REPL bindings were gone and required input was reconstructed from durable state");
      },
    ]);
    fixture.hold(warmTask, 2);

    expect((await world.command(
      ["config", "set-model", "openai:openai/fixture-v1", "--json"],
      fixture.environment(),
    )).code).toBe(0);
    const humanServiceStatus = await world.command(
      ["service", "status"],
      fixture.environment(),
    );
    expect(humanServiceStatus).toMatchObject({ code: 0, stderr: "" });
    expect(humanServiceStatus.stdout).toContain("(1 hour after activity)");
    expect(JSON.parse((await world.command(
      ["service", "status", "--json"],
      fixture.environment(),
    )).stdout).idleShutdownMs).toBe(3_600_000);

    const detached = await world.command(
      ["run", "--detach", "--json", warmTask],
      fixture.environment(),
    );
    expect(parseSingleJson(detached)).toEqual({
      protocol: "agencity.run-accepted",
      version: 1,
      accepted: true,
      detached: true,
    });
    await fixture.waitFor(warmTask, 2);
    fixture.release(warmTask, 2);
    await eventually(async () => {
      const status = await world.command(["status", "current", "--json"], fixture.environment());
      if (status.code !== 0) return undefined;
      const value = parseSingleJson(status);
      return value.status === "succeeded" ? value : undefined;
    });
    const resumed = await world.command(["resume"], fixture.environment());
    expect(resumed).toMatchObject({ code: 0, stderr: "" });
    expect(resumed.stdout).toContain("Session: exercise compact warm REPL namespace / main");
    expect(resumed.stdout).toContain("Detached. Session identity and durable work remain owned by the service.");

    const warmHistory = JSON.parse((await world.command(
      ["history", "current", "--json"],
      fixture.environment(),
    )).stdout);
    expect(warmHistory.cells).toHaveLength(2);
    expect(warmHistory.cells.every((cell: any) =>
      JSON.stringify(cell.result).length < 1_000)).toBe(true);

    const forked = await world.command(
      ["branch", "head", "repl-isolation", "--json"],
      fixture.environment(),
    );
    expect(JSON.parse(forked.stdout)).toMatchObject({
      created: true,
      branch: "repl-isolation",
      from: "head",
    });
    const isolated = await world.command(["run", "--json", isolationTask], fixture.environment());
    expect(parseSingleJson(isolated)).toMatchObject({
      status: "succeeded",
      final: "fork REPL namespace remained isolated",
    });
    const mainResume = await world.command(
      ["resume", "main"],
      fixture.environment(),
    );
    expect(mainResume).toMatchObject({ code: 0, stderr: "" });
    expect(mainResume.stdout).toContain("Session: verify isolated fork REPL namespace / main");
    const resumedMainHistory = JSON.parse((await world.command(
      ["history", "current", "--json"],
      fixture.environment(),
    )).stdout);
    expect(resumedMainHistory.branch).toBe("main");
    expect(resumedMainHistory.cells).toHaveLength(2);

    const beforeLoss = JSON.parse((await world.command(
      ["service", "status", "--json"],
      fixture.environment(),
    )).stdout);
    const shutdown = await world.command(
      ["service", "shutdown", "--json"],
      fixture.environment(),
    );
    expect(JSON.parse(shutdown.stdout)).toEqual({ accepted: true, lifecycle: "draining" });
    await eventually(async () => {
      const status = await world.command(["service", "status", "--json"], fixture.environment());
      if (status.code !== 0) return undefined;
      const value = JSON.parse(status.stdout);
      return value.lifecycle === "stopped" ? value : undefined;
    });
    await eventually(async () => {
      const sessions = await world.command(["sessions", "--json"], fixture.environment());
      return sessions.code === 0 ? JSON.parse(sessions.stdout) : undefined;
    });
    const afterLoss = JSON.parse((await world.command(
      ["service", "status", "--json"],
      fixture.environment(),
    )).stdout);
    expect(afterLoss.instanceId).not.toBe(beforeLoss.instanceId);

    const recovered = await world.command(["run", "--json", coldTask], fixture.environment());
    expect(recovered.code, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
    expect(parseSingleJson(recovered)).toMatchObject({
      status: "succeeded",
      final: "warm REPL bindings were gone and required input was reconstructed from durable state",
    });
    expect(fixture.count(warmTask)).toBe(3);
    expect(fixture.count(isolationTask)).toBe(2);
    expect(fixture.count(coldTask)).toBe(2);
  }, 120_000);
});

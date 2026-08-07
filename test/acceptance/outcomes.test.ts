import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AcceptanceWorld, eventually, parseSingleJson } from "./helpers.ts";
import { StrictActionFixture, action } from "./strict-action-fixture.ts";

const worlds: AcceptanceWorld[] = [];
const fixtures: StrictActionFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const world of worlds.splice(0)) await world.dispose();
});

async function setup(label: string, extra: Readonly<Record<string, string>> = {}): Promise<{ world: AcceptanceWorld; fixture: StrictActionFixture; environment: Record<string, string> }> {
  const fixture = new StrictActionFixture(); fixtures.push(fixture);
  const world = await AcceptanceWorld.create(label); worlds.push(world);
  const environment = { ...fixture.environment(), ...extra };
  const configured = await world.command(["config", "set-model", "openai:fixture-v1", "--json"], environment);
  expect(configured.code).toBe(0);
  return { world, fixture, environment };
}

describe("FU-009 external outcome and interruption matrix", () => {
  test.each([
    { task: "fixture explicit failure", reply: action("failed", "fixture failure"), status: "failed", code: 1 },
    { task: "fixture explicit block", reply: action("blocked", "fixture block"), status: "blocked", code: 4 },
  ])("reports $status as strict JSON with a distinct process status", async row => {
    const { world, fixture, environment } = await setup(row.status);
    fixture.script(row.task, [row.reply]);
    const result = await world.command(["run", "--json", row.task], environment);
    expect(result.code).toBe(row.code);
    expect(parseSingleJson(result)).toMatchObject({ protocol: "agencity.run-result", version: 1, status: row.status, exitCode: row.code });
  }, 120_000);

  test("reports the bounded-step outcome distinctly", async () => {
    const acceptance = { AGENCITY_ACCEPTANCE: "1", AGENCITY_ACCEPTANCE_MAX_RUN_STEPS: "1" };
    const { world, fixture, environment } = await setup("bounded", acceptance);
    const task = "fixture bounded steps";
    fixture.script(task, [action("typescript", "return { observed: true };")]);
    const result = await world.command(["run", "--json", task], environment);
    expect(result.code).toBe(5);
    expect(parseSingleJson(result)).toMatchObject({ status: "budget_exceeded", exitCode: 5, steps: 1 });
    expect(fixture.count(task)).toBe(1);
  }, 120_000);

  test("a first interrupt durably cancels an in-flight provider request", async () => {
    const { world, fixture, environment } = await setup("cancelled");
    const task = "fixture cancellation";
    fixture.script(task, [action("final", "must not complete")]);
    fixture.hold(task);
    const running = world.start(["run", "--json", task], environment);
    await fixture.waitFor(task);
    running.child.kill("SIGINT");
    const result = await running.collect();
    fixture.release(task);
    expect(result.code).toBe(130);
    expect(parseSingleJson(result)).toMatchObject({ status: "cancelled", exitCode: 130 });
    expect(fixture.count(task)).toBe(1);
  }, 120_000);

  test("killing only the installed client leaves the resident service to finish exactly once", async () => {
    const { world, fixture, environment } = await setup("client-kill");
    const task = "fixture client kill continuation";
    fixture.script(task, [action("final", "service survived client kill")]);
    fixture.hold(task);
    const running = world.start(["run", "--json", task], environment);
    await fixture.waitFor(task);
    running.child.kill("SIGKILL");
    await running.collect();
    fixture.release(task);
    const outcome = await eventually(async () => {
      const observed = await world.command(["status", "current", "--json"], environment);
      if (observed.code !== 0) return undefined;
      const value = parseSingleJson(observed);
      return value.status === "succeeded" ? value : undefined;
    });
    expect(outcome.final).toContain("service survived client kill");
    expect(fixture.count(task)).toBe(1);
  }, 120_000);

  test.each(["agent-action-committed:1", "cell-committed"])("the %s boundary survives service loss without repeating its model step or cell", async failpoint => {
    const acceptance = { AGENCITY_ACCEPTANCE: "1", AGENCITY_ACCEPTANCE_FAILPOINT: failpoint };
    const { world, fixture, environment } = await setup(`action-recovery-${failpoint.replaceAll(":", "-")}`, acceptance);
    const task = "fixture committed action recovery";
    fixture.script(task, [
      action("typescript", `await tools.writeFile("action-recovery.txt", "committed-once"); return { repaired: true };`),
      action("final", "committed action recovered exactly once"),
    ]);
    const crashed = await world.command(["run", "--json", task], environment);
    expect(crashed.code).not.toBe(0);
    const recoveredEnvironment = fixture.environment();
    const recovered = await eventually(async () => {
      const observed = await world.command(["status", "current", "--json"], recoveredEnvironment);
      if (observed.code !== 0) return undefined;
      const value = parseSingleJson(observed);
      return value.status === "succeeded" ? value : undefined;
    }, 30_000);
    expect(recovered.final).toContain("recovered exactly once");
    expect(await Bun.file(join(world.repository, "action-recovery.txt")).text()).toBe("committed-once");
    expect(fixture.requests.filter(item => item.task === task).map(item => item.step)).toEqual([1, 2]);
  }, 120_000);

  test("post-commit model ownership loss becomes unknown and is never sent or retried", async () => {
    const acceptance = { AGENCITY_ACCEPTANCE: "1", AGENCITY_ACCEPTANCE_FAILPOINT: "outbox-started:model" };
    const { world, fixture, environment } = await setup("model-unknown", acceptance);
    const task = "fixture model ownership loss";
    fixture.script(task, [action("final", "must never be requested")]);
    const crashed = await world.command(["run", "--json", task], environment);
    expect(crashed.code).not.toBe(0);
    const recoveredEnvironment = fixture.environment();
    const recovered = await eventually(async () => {
      const observed = await world.command(["status", "current", "--json"], recoveredEnvironment);
      if (observed.code !== 7) return undefined;
      return parseSingleJson(observed);
    }, 30_000);
    expect(recovered).toMatchObject({ status: "unknown", exitCode: 7 });
    expect(fixture.count(task)).toBe(0);
  }, 120_000);

  test("post-commit non-idempotent cell effect ownership loss is unknown, not retried, and accepts evidence-only reconciliation", async () => {
    const acceptance = { AGENCITY_ACCEPTANCE: "1", AGENCITY_ACCEPTANCE_FAILPOINT: "outbox-started:shell" };
    const { world, fixture, environment } = await setup("cell-unknown", acceptance);
    const task = "fixture cell ownership loss";
    fixture.script(task, [action("typescript", `
      await tools.shell("printf should-not-run > acceptance-effect.txt");
      return { impossible: true };
    `)]);
    const crashed = await world.command(["run", "--json", task], environment);
    expect(crashed.code).not.toBe(0);
    const recoveredEnvironment = fixture.environment();
    const recovered = await eventually(async () => {
      const observed = await world.command(["status", "current", "--json"], recoveredEnvironment);
      if (observed.code !== 7) return undefined;
      return parseSingleJson(observed);
    }, 30_000);
    expect(recovered).toMatchObject({ status: "unknown", exitCode: 7 });
    expect(await Bun.file(join(world.repository, "acceptance-effect.txt")).exists()).toBe(false);
    expect(fixture.count(task)).toBe(1);
    const reconciled = await world.command(["reconcile", "latest", "no_effect", "fixture process exited before executor entry", "--json"], recoveredEnvironment);
    expect(reconciled.code).toBe(0);
    expect(reconciled.stdout).toContain('"durableEffectStatus": "unknown"');
    expect(reconciled.stdout).toContain('"retried": false');
    expect(fixture.count(task)).toBe(1);
  }, 120_000);
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AcceptanceWorld, eventually } from "./helpers.ts";
import { StrictActionFixture, action } from "./strict-action-fixture.ts";

const worlds: AcceptanceWorld[] = [];
const fixtures: StrictActionFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const world of worlds.splice(0)) await world.dispose();
});

describe("FU-009 installed satellite product surfaces", () => {
  test("observes SSE use and exercises refinement review listing, skills, compaction, context, and scheduled wake delivery", async () => {
    const fixture = new StrictActionFixture(); fixtures.push(fixture);
    const world = await AcceptanceWorld.create("satellites"); worlds.push(world);
    const environment = fixture.environment();
    expect((await world.command(["config", "set-model", "openai:fixture-v1", "--json"], environment)).code).toBe(0);

    const seedTask = "satellite streaming seed";
    fixture.script(seedTask, [action("final", "streaming seed completed")]);
    const seeded = await world.command(["run", "--json", seedTask], environment);
    expect(seeded.code).toBe(0);
    expect(fixture.requests.find(item => item.task === seedTask)).toMatchObject({ streaming: true, model: "fixture-v1" });

    const context = await world.command(["context", "--json"], environment);
    expect(context.code).toBe(0);
    expect(context.stdout).toContain("capacity");
    const compacted = await world.command(["compact", "retain acceptance evidence", "--strategy", "extractive", "--json"], environment);
    expect(compacted.code).toBe(0);
    expect(compacted.stdout).toContain("deterministic-extractive-v1");
    const reviewed = await world.command(["refine", "review the frozen acceptance trajectory", "--json"], environment);
    expect(reviewed.code).toBe(0);
    expect(reviewed.stdout).toContain('"status": "no_change"');
    const reviews = await world.command(["refine", "status", "--json"], environment);
    expect(reviews.code).toBe(0);
    expect(reviews.stdout).toContain('"reviews"');

    const skillDirectory = join(world.repository, "acceptance-skill");
    await mkdir(skillDirectory);
    await writeFile(join(skillDirectory, "agencity-skill.json"), JSON.stringify({
      schemaVersion: 1,
      name: "double-number",
      description: "Doubles one numeric input",
      entry: "skill.ts",
      runtime: "bun",
      inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },
      permissions: [],
      tests: [{ name: "doubles two", input: { value: 2 }, expected: { doubled: 4 } }],
    }));
    await writeFile(join(skillDirectory, "skill.ts"), "export default (input: { value: number }) => ({ doubled: input.value * 2 });\n");
    const preview = await world.command(["skills", "install", skillDirectory, "--scope", "workspace", "--json"], environment);
    expect(preview.code).not.toBe(0);
    const digest = preview.stderr.match(/Inspected source SHA-256: ([a-f0-9]{64})/)?.[1];
    expect(digest).toBeDefined();
    const installed = await world.command(["skills", "install", skillDirectory, "--scope", "workspace", "--confirmation", digest!, "--json"], environment);
    expect(installed.code).toBe(0);
    expect(installed.stdout).toContain("double-number");
    const skillTest = await world.command(["skills", "test", "double-number", "--json"], environment);
    expect(skillTest.code).toBe(0);
    expect(skillTest.stdout).toContain('"passed": true');

    const scheduledTask = "scheduled acceptance wake";
    fixture.script(scheduledTask, [action("final", "scheduled wake completed")]);
    const at = new Date(Date.now() + 500).toISOString();
    const scheduled = await world.command(["schedules", "once", at, scheduledTask, "--json"], environment);
    expect(scheduled.code).toBe(0);
    await fixture.waitFor(scheduledTask, 1, 15_000);
    await eventually(async () => {
      const history = await world.command(["history", "current", "--json"], environment);
      return history.stdout.includes("scheduled wake completed") ? true : undefined;
    }, 15_000);
    expect(fixture.count(scheduledTask)).toBe(1);
  }, 120_000);
});

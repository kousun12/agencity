import { afterEach, expect, test } from "bun:test";
import { AcceptanceWorld, parseSingleJson } from "./helpers.ts";

const enabled = process.env.AGENCITY_ACCEPTANCE_REAL_PROVIDER === "1";
let world: AcceptanceWorld | undefined;

afterEach(async () => { if (world) await world.dispose(); world = undefined; });

test.skipIf(!enabled)("opt-in real OpenAI Responses-compatible provider smoke uses the installed product path", async () => {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.AGENCITY_ACCEPTANCE_REAL_MODEL;
  if (!key || !model) throw new Error("real smoke requires OPENAI_API_KEY and AGENCITY_ACCEPTANCE_REAL_MODEL");
  world = await AcceptanceWorld.create("real-provider");
  const environment = {
    OPENAI_API_KEY: key,
    OPENAI_MODEL: model,
    ...(process.env.OPENAI_BASE_URL ? { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } : {}),
  };
  const configured = await world.command(["config", "set-model", `openai/${model}`, "--json"], environment);
  expect(configured.code).toBe(0);
  const result = await world.command(["run", "--json", "Reply with a truthful concise final action confirming this provider smoke."], environment);
  expect(result.code).toBe(0);
  expect(parseSingleJson(result)).toMatchObject({ protocol: "agencity.run-result", version: 1, status: "succeeded", exitCode: 0 });
}, 120_000);

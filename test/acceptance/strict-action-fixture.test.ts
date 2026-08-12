import { afterEach, describe, expect, test } from "bun:test";
import {
  FIXTURE_CATALOG_MODELS,
  StrictActionFixture,
} from "./strict-action-fixture.ts";

const fixtures: StrictActionFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function fixture(options?: ConstructorParameters<typeof StrictActionFixture>[0]): StrictActionFixture {
  const value = new StrictActionFixture(options);
  fixtures.push(value);
  return value;
}

describe("strict action fixture catalog", () => {
  test("serves multiple models and records catalog requests separately without authorization", async () => {
    const provider = fixture();
    const catalogResponse = await fetch(`${provider.baseUrl}/v1/models`);
    expect(catalogResponse.status).toBe(200);
    expect(await catalogResponse.json()).toEqual({ data: FIXTURE_CATALOG_MODELS });
    expect(provider.catalogRequests).toHaveLength(1);
    expect(provider.catalogRequests[0]?.authorization).toBeNull();
    expect(provider.requests).toHaveLength(0);

    const inferenceResponse = await fetch(`${provider.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer acceptance-fixture-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "fixture-v1",
        messages: [{ role: "user", content: "fixture request" }],
      }),
    });
    expect(inferenceResponse.status).toBe(200);
    expect(provider.requests).toHaveLength(1);
    expect(provider.catalogRequests).toHaveLength(1);
  });

  test("exposes a first-run environment without provider or model shortcuts", () => {
    const provider = fixture();
    expect(provider.firstRunEnvironment()).toEqual({
      OPENAI_BASE_URL: provider.baseUrl,
      AI_GATEWAY_BASE_URL: provider.baseUrl,
    });
    expect(provider.firstRunEnvironment()).not.toHaveProperty("OPENAI_API_KEY");
    expect(provider.firstRunEnvironment()).not.toHaveProperty("OPENAI_MODEL");
    expect(provider.firstRunEnvironment()).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(provider.firstRunEnvironment()).not.toHaveProperty("ANTHROPIC_MODEL");
    expect(provider.firstRunEnvironment()).not.toHaveProperty("AI_GATEWAY_API_KEY");
    expect(provider.firstRunEnvironment()).not.toHaveProperty("AI_GATEWAY_MODEL");
  });

  test("delays catalog completion until explicitly released", async () => {
    const provider = fixture({ catalogMode: "delayed" });
    let settled = false;
    const responsePromise = fetch(`${provider.baseUrl}/v1/models`).then(response => {
      settled = true;
      return response;
    });

    const request = await provider.waitForCatalog();
    expect(request.authorization).toBeNull();
    expect(settled).toBeFalse();

    provider.releaseCatalog();
    expect((await responsePromise).status).toBe(200);
  });

  test("serves unavailable and hostile catalog modes deterministically", async () => {
    const provider = fixture({ catalogMode: "unavailable" });
    const unavailable = await fetch(`${provider.baseUrl}/v1/models`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: { message: "fixture catalog unavailable", type: "fixture_error" },
    });

    provider.setCatalogMode("hostile");
    const hostile = await fetch(`${provider.baseUrl}/v1/models`);
    expect(hostile.status).toBe(200);
    const body = await hostile.json() as { data: Array<{ id: string; name: string }> };
    expect(body.data.map(model => model.id)).toEqual(
      FIXTURE_CATALOG_MODELS.map(model => model.id),
    );
    expect(body.data.some(model => /[\r\n]/u.test(model.name))).toBeTrue();
    expect(body.data.some(model => model.name.includes("\u001b["))).toBeTrue();
    expect(body.data.some(model => /[\u202e\u2066\u2069]/u.test(model.name))).toBeTrue();
    expect(body.data.some(model => /[模型界試験]/u.test(model.name))).toBeTrue();
  });
});

import { describe, expect, test } from "bun:test";
import {
  AGENT_RUN_EXECUTION_GUIDANCE,
  BASE_POLICY,
  IMMUTABLE_BASE_POLICY,
} from "../../src/index.ts";

describe("persistent TypeScript environment guidance", () => {
  test("versions the immutable recovery policy exactly", () => {
    expect(IMMUTABLE_BASE_POLICY).toEqual({
      id: "agencity-base-policy",
      version: 3,
      text: BASE_POLICY,
    });
    expect(BASE_POLICY).toContain(
      "Top-level TypeScript bindings persist only while the exact-branch console worker remains alive.",
    );
    expect(BASE_POLICY).toContain(
      "Persist every value required after recovery through state or artifacts.",
    );
    expect(BASE_POLICY).not.toContain("scratch");
  });

  test("describes warm bindings and explicit durable state", () => {
    expect(AGENT_RUN_EXECUTION_GUIDANCE).toMatchObject({
      id: "agencity.agent-run.execution-guidance",
      version: 11,
    });
    expect(AGENT_RUN_EXECUTION_GUIDANCE.text).toContain(
      "Cell globals: sdk, sql, session, console, state",
    );
    expect(AGENT_RUN_EXECUTION_GUIDANCE.text).toContain(
      "Top-level TypeScript bindings, functions, classes, imports, and object identity remain available across cells",
    );
    expect(AGENT_RUN_EXECUTION_GUIDANCE.text).toContain(
      "small recovery-critical JSON in state",
    );
    expect(AGENT_RUN_EXECUTION_GUIDANCE.text).toContain(
      "The in-memory TypeScript environment is noncanonical and may disappear",
    );
    expect(AGENT_RUN_EXECUTION_GUIDANCE.text).not.toContain("scratch");
  });
});

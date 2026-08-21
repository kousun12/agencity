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
      version: 4,
      text: BASE_POLICY,
    });
    expect(BASE_POLICY).toContain(
      "run.replNamespace identifies whether the exact-branch console is cold or names its current warm epoch.",
    );
    expect(BASE_POLICY).toContain(
      "Persist every value required after recovery through state or artifacts.",
    );
    expect(BASE_POLICY).toContain(
      "REPL_EPOCH_CHANGED means the submitted cell did not execute",
    );
    expect(BASE_POLICY).not.toContain("scratch");
  });

  test("describes warm bindings and explicit durable state", () => {
    expect(AGENT_RUN_EXECUTION_GUIDANCE).toMatchObject({
      id: "agencity.agent-run.execution-guidance",
      version: 14,
    });
    expect(AGENT_RUN_EXECUTION_GUIDANCE.text).toContain(
      "Cell globals: sdk, sql, session, console, state",
    );
    expect(AGENT_RUN_EXECUTION_GUIDANCE.text).toContain(
      "run.replNamespace reports the exact branch console as cold or as a warm named epoch",
    );
    expect(AGENT_RUN_EXECUTION_GUIDANCE.text).toContain(
      "small recovery-critical JSON in state",
    );
    expect(AGENT_RUN_EXECUTION_GUIDANCE.text).toContain(
      "The in-memory TypeScript environment is noncanonical and may disappear",
    );
    expect(AGENT_RUN_EXECUTION_GUIDANCE.text).toContain(
      "A REPL_EPOCH_CHANGED failure means the submitted cell was not executed",
    );
    expect(AGENT_RUN_EXECUTION_GUIDANCE.text).not.toContain("scratch");
  });
});

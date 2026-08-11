import { describe, expect, test } from "bun:test";
import {
  AGENT_RUN_EXECUTION_GUIDANCE,
  BASE_POLICY,
  IMMUTABLE_BASE_POLICY,
} from "../../src/index.ts";

describe("scratch prompt doctrine", () => {
  test("versions the immutable recovery policy exactly", () => {
    expect(IMMUTABLE_BASE_POLICY).toEqual({
      id: "agencity-base-policy",
      version: 2,
      text: BASE_POLICY,
    });
    expect(BASE_POLICY).toContain(
      "Persist every value required after recovery; scratch and console heap values are replaceable and may disappear.",
    );
    expect(BASE_POLICY).not.toContain("Persist every value needed after a cell boundary.");
  });

  test("activates scratch guidance with the cell runtime surface", () => {
    expect(AGENT_RUN_EXECUTION_GUIDANCE).toMatchObject({
      id: "agencity.agent-run.execution-guidance",
      version: 5,
    });
    expect(AGENT_RUN_EXECUTION_GUIDANCE.text).toContain(
      "Cell globals: sdk, sql, session, console, scratch, state",
    );
    expect(AGENT_RUN_EXECUTION_GUIDANCE.text).toContain(
      "Use scratch for replaceable cross-cell intermediates",
    );
    expect(AGENT_RUN_EXECUTION_GUIDANCE.text).toContain(
      "Each committed state write appends permanent canonical history",
    );
    expect(AGENT_RUN_EXECUTION_GUIDANCE.text).toContain(
      "A bare scratch assignment is an expression",
    );
  });
});

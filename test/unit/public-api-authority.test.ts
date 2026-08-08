import { describe, expect, test } from "bun:test";
import * as root from "../../src/index.ts";
import * as runtime from "../../src/runtime/index.ts";

const INTERNAL_STRUCTURED_CAPABILITY_NAMES = [
  "internalStructuredModelTurn",
  "internalRefinementReviewStarter",
  "registerStructuredModelTurn",
  "registerRefinementReviewStarter",
] as const;

describe("package-root structured authority surface", () => {
  test("structured internal capabilities are absent from the package root and runtime barrel", () => {
    for (const name of INTERNAL_STRUCTURED_CAPABILITY_NAMES) {
      expect(name in root).toBe(false);
      expect(name in runtime).toBe(false);
    }
  });

  test("the public recursive service surface still exists without structured start authority", () => {
    expect(typeof root.RecursiveModelService).toBe("function");
    const publicNames = Object.getOwnPropertyNames(root.RecursiveModelService.prototype);
    expect(publicNames).toContain("start");
    expect(publicNames).toContain("startMany");
    expect(publicNames.some((name) => /refinement|structured/i.test(name))).toBe(false);
  });

  test("public model inputs cannot select response contracts or admissions", () => {
    expect(root.RESERVED_MODEL_DISPATCH_INPUT_FIELDS).toContain("responseContract");
    expect(root.RESERVED_MODEL_DISPATCH_INPUT_FIELDS).toContain("responseAdmission");
    for (const field of ["responseContract", "responseAdmission"]) {
      expect(() =>
        root.assertNoReservedModelDispatchInputFields(
          { prompt: "task", [field]: { kind: "text", version: 1 } },
          "Public recursive input",
        )
      ).toThrow(`reserved dispatch field ${field}`);
    }
  });
});

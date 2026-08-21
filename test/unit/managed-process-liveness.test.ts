import { describe, expect, test } from "bun:test";
import {
  classifyProcessGroupLiveness,
  terminateProcessGroups,
} from "../../src/executors/managed-process.ts";

describe("managed process group liveness", () => {
  test("classifies absent, live, zombie-only, and unknown probes", () => {
    expect(classifyProcessGroupLiveness({
      signal: "absent",
      inspectionAvailable: true,
      memberStates: ["S"],
    })).toBe("absent");
    expect(classifyProcessGroupLiveness({
      signal: "present",
      inspectionAvailable: true,
      memberStates: ["Z", "X"],
    })).toBe("zombie_only");
    expect(classifyProcessGroupLiveness({
      signal: "present",
      inspectionAvailable: true,
      memberStates: ["Z+", "S"],
    })).toBe("live");
    expect(classifyProcessGroupLiveness({
      signal: "present",
      inspectionAvailable: false,
      memberStates: [],
    })).toBe("unknown");
    expect(classifyProcessGroupLiveness({
      signal: "present",
      inspectionAvailable: true,
      memberStates: [],
    })).toBe("unknown");
    expect(classifyProcessGroupLiveness({
      signal: "unknown",
      inspectionAvailable: true,
      memberStates: ["R"],
    })).toBe("live");
  });

  test("attempts every known group and reports exact survivors", async () => {
    const attempted: number[] = [];
    const result = await terminateProcessGroups([11, 22, 11, 33], {
      terminate: async (group) => {
        attempted.push(group);
        if (group === 11) throw new Error("first group resisted");
      },
      isExecuting: (group) => group === 11 || group === 33,
    });
    expect(attempted).toEqual([11, 22, 33]);
    expect(result.attemptedProcessGroupIds).toEqual([11, 22, 33]);
    expect(result.survivingProcessGroupIds).toEqual([11, 33]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.group).toBe(11);
  });
});

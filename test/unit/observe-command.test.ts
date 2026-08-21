import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../../src/cli-args.ts";
import { parseObservePort, validateObserveCli } from "../../src/observe/command.ts";
import { ObserverSseQueue } from "../../src/observe/server.ts";

describe("observe CLI admission", () => {
  test("recognizes observe and preserves its help/version context", () => {
    expect(parseCliArgs(["observe"]).command).toBe("observe");
    const help = parseCliArgs(["observe", "--help"]);
    expect(help.command).toBe("observe");
    expect(help.flags.has("help")).toBe(true);
    const version = parseCliArgs(["observe", "--version"]);
    expect(version.command).toBe("observe");
    expect(version.flags.has("version")).toBe(true);
  });

  test("accepts only observer options and rejects task, execution, storage, sync, and mutation inputs", () => {
    expect(validateObserveCli(parseCliArgs([
      "observe",
      "--workspace",
      "/tmp/example",
      "--port",
      "43127",
    ]))).toEqual({ workspaceOverride: "/tmp/example", port: 43127 });
    for (const argv of [
      ["observe", "task text"],
      ["observe", "--model", "openai/model"],
      ["observe", "--state-dir", "/tmp/state"],
      ["observe", "--sync-url", "https://example.invalid"],
      ["observe", "--detach"],
      ["observe", "--json"],
      ["observe", "--help", "--model", "openai/model"],
    ]) {
      expect(() => validateObserveCli(parseCliArgs(argv))).toThrow();
    }
  });

  test("uses port zero only when omitted and strictly validates explicit decimal ports", () => {
    expect(parseObservePort(undefined)).toBe(0);
    expect(parseObservePort("1")).toBe(1);
    expect(parseObservePort("65535")).toBe(65535);
    for (const value of ["0", "65536", "+1", "01", "1.0", " 1", "1 ", "1e3", ""]) {
      expect(() => parseObservePort(value)).toThrow();
    }
  });
});

describe("observer browser stream queue", () => {
  test("rejects slow-client growth at both envelope and byte bounds", () => {
    const itemBound = new ObserverSseQueue(2, 1_024);
    expect(itemBound.enqueue(new Uint8Array(10))).toBe(true);
    expect(itemBound.enqueue(new Uint8Array(10))).toBe(true);
    expect(itemBound.enqueue(new Uint8Array(10))).toBe(false);
    expect(itemBound.length).toBe(2);
    expect(itemBound.bytes).toBe(20);

    const byteBound = new ObserverSseQueue(10, 20);
    expect(byteBound.enqueue(new Uint8Array(15))).toBe(true);
    expect(byteBound.enqueue(new Uint8Array(6))).toBe(false);
    expect(byteBound.shift()?.byteLength).toBe(15);
    expect(byteBound.bytes).toBe(0);
  });
});

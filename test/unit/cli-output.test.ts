import { describe, expect, test } from "bun:test";
import {
  CLI_ERROR_EXIT_CODES,
  CLI_EXIT_CODES,
  CLI_OUTPUT_PROTOCOL,
  CLI_OUTPUT_VERSION,
  cliErrorEnvelopeFromUnknown,
  createCliErrorEnvelope,
  createCliSuccessEnvelope,
  exitCodeForCliError,
  parseCliOutputEnvelope,
  planCliOutput,
  renderCliEnvelope,
  type CliJsonValue,
  type CliSuccessEnvelope,
  type CliOutputEnvelope,
} from "../../src/cli/output.ts";

describe("CLI output v1 success envelope", () => {
  test("has one exact versioned JSON shape and stable success status", () => {
    const envelope = createCliSuccessEnvelope({
      command: "sync status",
      message: "Sync is ready.",
      data: { configured: true, pending: 0 },
    });
    expect(envelope).toEqual({
      protocol: "agencity.cli-output",
      version: 1,
      ok: true,
      command: "sync status",
      exitCode: 0,
      message: "Sync is ready.",
      data: { configured: true, pending: 0 },
    });
    expect(CLI_OUTPUT_PROTOCOL).toBe("agencity.cli-output");
    expect(CLI_OUTPUT_VERSION).toBe(1);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.data)).toBe(true);
  });

  test("renders strict human and compact JSON output without I/O", () => {
    const envelope = createCliSuccessEnvelope({ command: "debug history", message: "two events", data: [1, 2] });
    expect(renderCliEnvelope(envelope, "human")).toBe("two events");
    expect(renderCliEnvelope(envelope, "json")).toBe(JSON.stringify(envelope));
    expect(planCliOutput(envelope, "human")).toEqual({ exitCode: 0, stdout: "two events", stderr: null });
    expect(planCliOutput(envelope, "json")).toEqual({ exitCode: 0, stdout: JSON.stringify(envelope), stderr: null });
  });

  test("defaults missing data to explicit null rather than omitting a field", () => {
    expect(createCliSuccessEnvelope({ command: "sync now", message: "done" }).data).toBeNull();
  });
});

describe("CLI output v1 error envelope and exit codes", () => {
  test("has one exact versioned error shape and emits human errors only on stderr", () => {
    const envelope = createCliErrorEnvelope({
      command: "data delete",
      code: "VALIDATION_ERROR",
      message: "Exact confirmation is required",
      details: { scopeKind: "session", retryable: false },
    });
    expect(envelope).toEqual({
      protocol: "agencity.cli-output",
      version: 1,
      ok: false,
      command: "data delete",
      exitCode: 2,
      error: {
        code: "VALIDATION_ERROR",
        message: "Exact confirmation is required",
        details: { scopeKind: "session", retryable: false },
      },
    });
    expect(renderCliEnvelope(envelope, "human")).toBe("Agencity error [VALIDATION_ERROR]: Exact confirmation is required");
    expect(planCliOutput(envelope, "human")).toEqual({
      exitCode: 2,
      stdout: null,
      stderr: "Agencity error [VALIDATION_ERROR]: Exact confirmation is required",
    });
    expect(planCliOutput(envelope, "json")).toEqual({
      exitCode: 2,
      stdout: null,
      stderr: JSON.stringify(envelope),
    });
  });

  test("publishes stable distinct exit classes and maps every declared error code", () => {
    expect(CLI_EXIT_CODES).toEqual({
      SUCCESS: 0,
      FAILURE: 1,
      USAGE: 2,
      NOT_FOUND: 3,
      CONFLICT: 4,
      UNAVAILABLE: 5,
      PERMISSION_DENIED: 6,
      CANCELLED: 130,
    });
    expect(new Set(Object.values(CLI_EXIT_CODES)).size).toBe(Object.values(CLI_EXIT_CODES).length);
    for (const [code, exitCode] of Object.entries(CLI_ERROR_EXIT_CODES)) {
      expect(exitCodeForCliError(code)).toBe(exitCode);
      expect(createCliErrorEnvelope({ code, message: code }).exitCode).toBe(exitCode);
    }
    expect(exitCodeForCliError("FUTURE_UNKNOWN_CODE")).toBe(CLI_EXIT_CODES.FAILURE);
  });

  test("does not let callers weaken or drift the stable exit mapping", () => {
    expect(() => createCliErrorEnvelope({
      code: "VALIDATION_ERROR",
      message: "bad input",
      exitCode: CLI_EXIT_CODES.FAILURE,
    })).toThrow("does not match");
    expect(createCliErrorEnvelope({
      code: "VALIDATION_ERROR",
      message: "bad input",
      exitCode: CLI_EXIT_CODES.USAGE,
    }).exitCode).toBe(CLI_EXIT_CODES.USAGE);
  });

  test("normalizes structural runtime errors and unknown thrown values", () => {
    expect(cliErrorEnvelopeFromUnknown({
      code: "NOT_FOUND",
      message: "session not found",
      details: { kind: "session", id: "s" },
    }, "debug snapshot")).toMatchObject({
      ok: false,
      command: "debug snapshot",
      exitCode: 3,
      error: { code: "NOT_FOUND", message: "session not found", details: { kind: "session", id: "s" } },
    });
    expect(cliErrorEnvelopeFromUnknown(new Error("boom"))).toMatchObject({
      ok: false,
      command: null,
      exitCode: 1,
      error: { code: "CLI_ERROR", message: "boom", details: null },
    });
    expect(cliErrorEnvelopeFromUnknown(null)).toMatchObject({
      error: { code: "CLI_ERROR", message: "null" },
    });
    expect(cliErrorEnvelopeFromUnknown({ code: "lowercase", message: "bad code" })).toMatchObject({
      error: { code: "CLI_ERROR", message: "[object Object]" },
    });
    expect(cliErrorEnvelopeFromUnknown(new Error("nul\0message"))).toMatchObject({
      error: { code: "CLI_ERROR", message: "nul�message" },
    });
  });
});

describe("strict CLI envelope admission", () => {
  const success = (): CliSuccessEnvelope => createCliSuccessEnvelope({
    command: "data export",
    message: "exported",
    data: { artifact: "sha256:abc" },
  });

  test("round-trips admitted v1 envelopes", () => {
    const values = [
      success(),
      createCliErrorEnvelope({ code: "CONFLICT", message: "conflict", details: { id: "c1" } }),
    ];
    for (const value of values) {
      expect(parseCliOutputEnvelope(JSON.parse(JSON.stringify(value)))).toEqual(value);
    }
  });

  test("rejects protocol, version, discriminator, exit, and strict-field drift", () => {
    const base = success();
    for (const invalid of [
      { ...base, protocol: "other" },
      { ...base, version: 2 },
      { ...base, ok: "yes" },
      { ...base, exitCode: 1 },
      { ...base, extra: true },
      { protocol: base.protocol, version: base.version, ok: true, command: base.command, exitCode: 0, message: base.message },
      null,
      [],
    ]) {
      expect(() => parseCliOutputEnvelope(invalid)).toThrow();
    }

    const error = createCliErrorEnvelope({ code: "NOT_FOUND", message: "missing" });
    for (const invalid of [
      { ...error, exitCode: 1 },
      { ...error, error: { ...error.error, extra: true } },
      { ...error, error: { code: error.error.code, message: error.error.message } },
      { ...error, error: { ...error.error, details: [] } },
    ]) {
      expect(() => parseCliOutputEnvelope(invalid)).toThrow();
    }
  });

  test("rejects unstable error codes and malformed commands", () => {
    for (const code of ["", "validation_error", "VALIDATION-ERROR", "1_ERROR", "HAS SPACE"]) {
      expect(() => createCliErrorEnvelope({ code, message: "bad" })).toThrow("uppercase snake case");
    }
    for (const command of ["", " padded", "padded ", "two\nlines", "nul\0command"]) {
      expect(() => createCliSuccessEnvelope({ command, message: "ok" })).toThrow();
    }
  });
});

describe("CLI JSON payload properties", () => {
  test("round-trips representative JSON trees and snapshots caller mutation", () => {
    const samples: CliJsonValue[] = [
      null,
      true,
      false,
      0,
      -3.5,
      "",
      "unicode: 🏙️",
      [],
      [null, 1, "two", { nested: [true, false] }],
      { z: 1, a: { b: "c" } },
      JSON.parse('{"__proto__":{"safe":true},"constructor":"value"}') as CliJsonValue,
    ];
    for (const [index, sample] of samples.entries()) {
      const envelope = createCliSuccessEnvelope({ command: "sync stats", message: `sample ${index}`, data: sample });
      expect(JSON.parse(renderCliEnvelope(envelope, "json"))).toEqual(envelope);
      expect(parseCliOutputEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
    }

    const mutable = { nested: { count: 1 }, items: ["first"] };
    const envelope = createCliSuccessEnvelope({ command: "sync stats", message: "snapshot", data: mutable });
    mutable.nested.count = 2;
    mutable.items.push("second");
    expect(envelope.data).toEqual({ nested: { count: 1 }, items: ["first"] });
    expect(Object.isFrozen((envelope.data as { nested: object }).nested)).toBe(true);
  });

  test("rejects non-JSON, non-finite, cyclic, exotic, and over-deep values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    class Exotic { value = 1; }
    const invalid: unknown[] = [undefined, 1n, Symbol("x"), () => 1, NaN, Infinity, -Infinity, new Date(), new Exotic(), cyclic];
    for (const data of invalid) {
      expect(() => createCliSuccessEnvelope({
        command: "sync stats",
        message: "invalid",
        data: data as CliJsonValue,
      })).toThrow();
    }
    let deep: unknown = null;
    for (let index = 0; index < 65; index++) deep = [deep];
    expect(() => createCliSuccessEnvelope({ command: "sync stats", message: "deep", data: deep as CliJsonValue })).toThrow("depth");
  });

  test("is deterministic over many generated JSON values", () => {
    const make = (seed: number, depth: number): CliJsonValue => {
      if (depth === 0) return seed % 3 === 0 ? null : seed % 3 === 1 ? seed : `value-${seed}`;
      if (seed % 2 === 0) return [make(seed + 1, depth - 1), make(seed + 2, depth - 1)];
      return { [`key-${seed}`]: make(seed * 3 + 1, depth - 1), flag: seed % 3 === 0 };
    };
    for (let seed = 0; seed < 200; seed++) {
      const data = make(seed, seed % 5);
      const first = createCliSuccessEnvelope({ command: "sync stats", message: String(seed), data });
      const second = createCliSuccessEnvelope({ command: "sync stats", message: String(seed), data });
      expect(renderCliEnvelope(first, "json")).toBe(renderCliEnvelope(second, "json"));
      expect(parseCliOutputEnvelope(JSON.parse(renderCliEnvelope(first, "json")))).toEqual(first);
    }
  });
});

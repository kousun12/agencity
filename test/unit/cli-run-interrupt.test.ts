import { describe, expect, test } from "bun:test";
import { CliRunInterruptCoordinator } from "../../src/cli/run-interrupt.ts";
import { ProtocolClientError } from "../../src/protocol/index.ts";
import { registerBrokeredSecret } from "../../src/security/index.ts";

async function flush(): Promise<void> { await Bun.sleep(0); }

describe("plain product run interrupt semantics", () => {
  test("interrupt before durable admission truthfully detaches without inventing a cancellation target", async () => {
    const cancelled: string[] = [];
    const output: string[] = [];
    const interrupts = new CliRunInterruptCoordinator(
      (runId) => { cancelled.push(runId); },
      (message) => output.push(message),
    );

    interrupts.interrupt();
    await interrupts.detached;
    expect(interrupts.isDetached).toBe(true);
    expect(cancelled).toEqual([]);
    expect(output).toEqual([expect.stringContaining("before run admission was confirmed")]);
    expect(output[0]).toContain("may already have been durably accepted");
    expect(output[0]).toContain("may outlive this client");
  });

  test("first interrupt after admission requests cancellation and second detaches without claiming completion", async () => {
    const cancelled: string[] = [];
    const output: string[] = [];
    let release!: () => void;
    const cancellation = new Promise<void>((resolve) => { release = resolve; });
    const interrupts = new CliRunInterruptCoordinator(
      async (runId) => { cancelled.push(runId); await cancellation; },
      (message) => output.push(message),
    );
    interrupts.admit("run-known");

    interrupts.interrupt();
    await flush();
    expect(cancelled).toEqual(["run-known"]);
    expect(interrupts.isDetached).toBe(false);

    interrupts.interrupt();
    await interrupts.detached;
    expect(interrupts.isDetached).toBe(true);
    expect(output).toEqual([expect.stringContaining("cancellation is not confirmed")]);
    release();
    await flush();
    expect(output).toContain("Durable cancellation requested for run run-known. Waiting for reconciliation; press Ctrl-C again to detach.");
  });

  test("asynchronous cancellation rejection is scrubbed and observed", async () => {
    const output: string[] = [];
    const secret = "sk-test-DO-NOT-RENDER-1234567890";
    const prior = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = secret;
    const release = registerBrokeredSecret(secret);
    try {
      const interrupts = new CliRunInterruptCoordinator(
        async () => { throw new ProtocolClientError("CANCEL_FAILED", `provider rejected ${secret}`, 503); },
        (message) => output.push(message),
      );
      interrupts.admit("run-rejected");
      interrupts.interrupt();
      await flush();
      expect(output).toEqual([expect.stringContaining("Cancellation request failed [CANCEL_FAILED]")]);
      expect(output[0]).toContain("Cancellation was not confirmed");
      expect(output.join("\n")).not.toContain(secret);
    } finally {
      release();
      if (prior === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prior;
    }
  });
});

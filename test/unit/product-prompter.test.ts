import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  ProductPrompter,
  type ProductCatalogSelectionResult,
} from "../../src/tui/product-prompter.ts";
import type {
  ModelDescriptor,
  ModelReasoningCapability,
} from "../../src/domain/index.ts";
import type { ModelProviderDescriptor } from "../../src/executors/index.ts";

class FakeInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  readonly rawChanges: boolean[] = [];
  setRawMode(value: boolean): this {
    this.isRaw = value;
    this.rawChanges.push(value);
    return this;
  }
}

class FakeOutput extends PassThrough {
  isTTY = true;
  columns = 80;
  text = "";
  readonly writes: string[] = [];
  constructor() {
    super();
    this.on("data", (chunk) => {
      const value = chunk.toString();
      this.text += value;
      this.writes.push(value);
    });
  }
}

function provider(
  name: string,
  displayName: string,
): ModelProviderDescriptor {
  return {
    name,
    displayName,
    usable: true,
    credentialSource: "stored",
    capabilities: {
      streaming: true,
      reasoningControl: "normalized",
      requiredToolSet: {
        status: "unknown",
        requiredChoice: "provider-enforced",
        parallelCalls: "provider-disabled",
        streaming: true,
        adapter: "test",
      },
    },
  };
}

function descriptor(
  model: string,
  displayName: string,
  options: {
    stale?: boolean;
    reasoning?: ModelReasoningCapability;
  } = {},
): ModelDescriptor {
  return {
    model,
    displayName,
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    pricing: null,
    reasoning: options.reasoning ?? {
      status: "listed",
      levels: ["low", "medium", "high"],
    },
    requiredToolSet: {
      status: "unknown",
      strictSchema: "unknown",
      requiredChoice: "unknown",
    },
    catalogDigest: `digest:${model}`,
    catalogEndpointId: "fixture",
    stale: options.stale ?? false,
  };
}

function harness(options: {
  columns?: number;
  manageSignals?: boolean;
} = {}) {
  const input = new FakeInput();
  const output = new FakeOutput();
  if (options.columns !== undefined) output.columns = options.columns;
  const prompter = new ProductPrompter({
    enabled: true,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    manageSignals: options.manageSignals ?? false,
  });
  return { input, output, prompter };
}

async function settles(): Promise<void> {
  await Bun.sleep(0);
}

describe("session-independent product prompter", () => {
  test("filters providers, handles split arrows, wraps, and restores ownership", async () => {
    const { input, output, prompter } = harness();
    input.pause();
    const existingDataListeners = input.listenerCount("data");
    const selection = prompter.selectProvider([
      provider("vercel", "Vercel AI Gateway"),
      provider("openai", "OpenAI"),
      provider("anthropic", "Anthropic"),
    ]);

    input.write("open");
    input.write("\u001b");
    input.write("[B");
    input.write("\u001b[A");
    input.write("\r");

    expect((await selection).name).toBe("openai");
    expect(input.rawChanges).toEqual([true, false]);
    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("data")).toBe(existingDataListeners);
    expect(output.text).toContain("OpenAI");
    expect(output.text).toContain("\u001b[?25h");
  });

  test("restores an initially unpaused input without leaving it paused", async () => {
    const { input, prompter } = harness();
    expect(input.isPaused()).toBe(false);
    const selection = prompter.selectProvider([
      provider("openai", "OpenAI"),
      provider("anthropic", "Anthropic"),
    ]);
    input.write("openai\r");
    expect((await selection).name).toBe("openai");
    expect(input.isPaused()).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
  });

  test("supports backspace, no-result disabled Enter, and query bounds", async () => {
    const { input, prompter } = harness();
    const selection = prompter.selectProvider([
      provider("openai", "OpenAI"),
      provider("anthropic", "Anthropic"),
    ]);
    input.write("no match\r");
    await settles();
    expect(input.listenerCount("data")).toBe(1);
    input.write("\u007f".repeat(8));
    input.write("openai");
    input.write("x".repeat(300));
    input.write("\u007f".repeat(300));
    input.write("\r");
    expect((await selection).name).toBe("openai");
  });

  test("cancels on Ctrl-C and Ctrl-D with complete cleanup", async () => {
    for (const key of ["\u0003", "\u0004"]) {
      const { input, prompter } = harness();
      const selection = prompter.selectProvider([
        provider("openai", "OpenAI"),
        provider("anthropic", "Anthropic"),
      ]);
      input.write(key);
      await expect(selection).rejects.toThrow("cancelled");
      expect(input.listenerCount("data")).toBe(0);
      expect(input.isRaw).toBe(false);
    }
  });

  test("decodes split UTF-8 and selects the exact catalog identity", async () => {
    const { input, prompter } = harness();
    const selection = prompter.selectModel(
      provider("openai", "OpenAI"),
      Promise.resolve({
        status: "refreshed",
        descriptors: [
          descriptor("openai/model-v1", "Mödel Alpha"),
          descriptor("openai/other-v1", "Other"),
        ],
      }),
    );
    await settles();
    const encoded = Buffer.from("mödel");
    input.write(encoded.subarray(0, 2));
    input.write(encoded.subarray(2));
    input.write("\r");
    expect(await selection).toBe("openai/model-v1");
  });

  test("makes bracketed pasted manual IDs explicit without newline submission", async () => {
    const { input, prompter } = harness();
    const selection = prompter.selectModel(
      provider("openai", "OpenAI"),
      Promise.resolve({
        status: "refreshed",
        descriptors: [descriptor("openai/custom-mini", "Custom Mini")],
      }),
    );
    await settles();
    input.write("\u001b[200~openai/custom-preview\n\u001b[201~");
    await settles();
    expect(input.listenerCount("data")).toBe(1);
    input.write("\r");
    expect(await selection).toBe("openai/custom-preview");
  });

  test("accepts bounded single-line provider-specific custom model IDs", async () => {
    const { input, output, prompter } = harness();
    const selection = prompter.selectCustomModel(
      provider("custom", "Embedded Custom"),
    );
    input.write("\r");
    await settles();
    expect(input.listenerCount("data")).toBe(1);
    input.write(`\u001b[200~${"é".repeat(400)}\n\u001b[201~`);
    await settles();
    expect(input.listenerCount("data")).toBe(1);
    input.write("\r");
    expect(await selection).toBe("é".repeat(256));
    expect(output.text).toContain("provider-specific model ID");
    expect(output.text).not.toContain("creator/model");
  });

  test("keeps a navigated row visible beyond the first result window", async () => {
    const { input, output, prompter } = harness({ columns: 48 });
    const descriptors = Array.from({ length: 12 }, (_, index) =>
      descriptor(
        `openai/model-${String(index).padStart(2, "0")}`,
        `Model ${String(index).padStart(2, "0")}`,
      )
    );
    const selection = prompter.selectModel(
      provider("openai", "OpenAI"),
      Promise.resolve({ status: "refreshed", descriptors }),
    );
    await settles();
    for (let index = 0; index < 10; index += 1) input.write("\u001b[B");
    input.write("\r");
    expect(await selection).toBe("openai/model-10");
    expect(output.text).toContain("Model 10");
    for (const write of output.writes) {
      for (const line of write.split("\n")) {
        const visible = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
        expect(Bun.stringWidth(visible)).toBeLessThanOrEqual(48);
      }
    }
  });

  test("uses fallback width and redraws against terminal resize", async () => {
    const { input, output, prompter } = harness();
    output.columns = Number.NaN;
    const selection = prompter.selectProvider([
      provider("openai", "OpenAI with a deliberately long display label"),
      provider("anthropic", "Anthropic"),
    ]);
    output.columns = 24;
    output.emit("resize");
    const resizeWrite = output.writes.at(-1) ?? "";
    input.write("openai\r");
    expect((await selection).name).toBe("openai");
    for (const line of resizeWrite.split("\n")) {
      const visible = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
      expect(Bun.stringWidth(visible)).toBeLessThanOrEqual(24);
    }
  });

  test("owns loading input, discards typing and arrows, then accepts fresh input", async () => {
    const { input, prompter } = harness();
    let resolveCatalog!: (value: ProductCatalogSelectionResult) => void;
    const catalog = new Promise<ProductCatalogSelectionResult>((resolve) => {
      resolveCatalog = resolve;
    });
    const selection = prompter.selectModel(
      provider("openai", "OpenAI"),
      catalog,
    );
    input.write("discarded");
    input.write("\u001b");
    input.write("[B");
    resolveCatalog({
      status: "refreshed",
      descriptors: [descriptor("openai/model-v1", "Model")],
    });
    await settles();
    input.write("openai/model-v1\r");
    expect(await selection).toBe("openai/model-v1");
  });

  test("cancels loading on Escape and ignores a late catalog result", async () => {
    const { input, output, prompter } = harness();
    let resolveCatalog!: (value: ProductCatalogSelectionResult) => void;
    const catalog = new Promise<ProductCatalogSelectionResult>((resolve) => {
      resolveCatalog = resolve;
    });
    const selection = prompter.selectModel(
      provider("openai", "OpenAI"),
      catalog,
    );
    input.write("\u001b");
    await expect(selection).rejects.toThrow("cancelled");
    const outputAtCancellation = output.text;
    resolveCatalog({
      status: "refreshed",
      descriptors: [descriptor("openai/late", "Late")],
    });
    await settles();
    expect(output.text).toBe(outputAtCancellation);
    expect(input.listenerCount("data")).toBe(0);
  });

  test("maps rejected and unavailable catalogs truthfully and sanitizes errors", async () => {
    const { input, output, prompter } = harness({ columns: 40 });
    const selection = prompter.selectModel(
      provider("openai", "OpenAI"),
      Promise.reject(
        new Error("catalog\n\u001b[31mfailed\u001b[0m \u202esecret"),
      ),
    );
    await settles();
    input.write("openai/manual-v1\r");
    expect(await selection).toBe("openai/manual-v1");
    expect(output.text).toContain("Catalog unavailable");
    expect(output.text).not.toContain("\u001b[31m");
    expect(output.text).not.toContain("\u202e");
  });

  test("renders cached fallback and empty provider-filtered states distinctly", async () => {
    const stale = harness();
    const staleSelection = stale.prompter.selectModel(
      provider("openai", "OpenAI"),
      Promise.resolve({
        status: "cached-fallback",
        error: "refresh failed",
        descriptors: [
          descriptor("openai/stale", "Stale Model", { stale: true }),
        ],
      }),
    );
    await settles();
    stale.input.write("\r");
    expect(await staleSelection).toBe("openai/stale");
    expect(stale.output.text).toContain("Using cached catalog");
    expect(stale.output.text).toContain("stale");

    const empty = harness();
    const emptySelection = empty.prompter.selectModel(
      provider("anthropic", "Anthropic"),
      Promise.resolve({
        status: "refreshed",
        descriptors: [descriptor("openai/only", "Only OpenAI")],
      }),
    );
    await settles();
    empty.input.write("anthropic/manual\r");
    expect(await emptySelection).toBe("anthropic/manual");
    expect(empty.output.text).toContain(
      "No catalog models are listed for anthropic",
    );
  });

  test("keeps credentials hidden and cleans up on success or stream failure", async () => {
    const secretHarness = harness();
    const secret = "sk-test-never-render-0123456789";
    const value = secretHarness.prompter.secret("Hidden key: ");
    secretHarness.input.write(`${secret.slice(0, 8)}x\u007f${secret.slice(8)}\r`);
    expect(await value).toBe(secret);
    expect(secretHarness.output.text).not.toContain(secret);
    expect(secretHarness.input.listenerCount("data")).toBe(0);
    expect(secretHarness.input.isRaw).toBe(false);

    const failed = harness();
    const selection = failed.prompter.selectProvider([
      provider("openai", "OpenAI"),
      provider("anthropic", "Anthropic"),
    ]);
    failed.input.emit("error", new Error("input failed"));
    await expect(selection).rejects.toThrow("input failed");
    expect(failed.input.listenerCount("data")).toBe(0);
    expect(failed.input.isRaw).toBe(false);

    const outputFailed = harness();
    const outputSelection = outputFailed.prompter.selectProvider([
      provider("openai", "OpenAI"),
      provider("anthropic", "Anthropic"),
    ]);
    outputFailed.output.emit("error", new Error("output failed"));
    await expect(outputSelection).rejects.toThrow("output failed");
    expect(outputFailed.input.listenerCount("data")).toBe(0);
    expect(outputFailed.input.isRaw).toBe(false);
  });

  test("cleans up temporary signal handlers and renderer failures", async () => {
    const sigintBefore = process.listenerCount("SIGINT");
    const signalled = harness({ manageSignals: true });
    const selected = signalled.prompter.selectProvider([
      provider("openai", "OpenAI"),
      provider("anthropic", "Anthropic"),
    ]);
    signalled.input.write("\r");
    await selected;
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);

    const input = new FakeInput();
    const output = new FakeOutput();
    output.write = (() => {
      throw new Error("renderer failed");
    }) as typeof output.write;
    const failing = new ProductPrompter({
      enabled: true,
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      manageSignals: false,
    });
    await expect(failing.selectProvider([
      provider("openai", "OpenAI"),
      provider("anthropic", "Anthropic"),
    ])).rejects.toThrow("renderer failed");
    expect(input.listenerCount("data")).toBe(0);
    expect(input.isRaw).toBe(false);
  });
});

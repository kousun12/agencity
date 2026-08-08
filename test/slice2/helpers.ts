import type { JsonValue, ModelConfiguration, ModelDispatch, ModelEffectOutputV2, ModelProvider, TextModelResponse } from "../../src/index.ts";
import { formalMissingToolOutput } from "../../src/executors/model-response.ts";

export class RecordingProvider implements ModelProvider {
  readonly capabilities = {
    streaming: false,
    requiredToolSet: {
      status: "runtime-validated",
      requiredChoice: "provider-enforced",
      parallelCalls: "runtime-rejected",
      streaming: true,
      adapter: "agencity.slice2-recording.formal.v1",
    },
  } as const;
  readonly contexts: JsonValue[] = [];
  readonly configurations: ModelConfiguration[] = [];
  calls = 0;
  active = 0;
  peakActive = 0;

  constructor(readonly name: string, readonly onCall?: (context: JsonValue, call: number) => void | Promise<void>) {}

  async complete(context: JsonValue, configuration: ModelConfiguration, signal: AbortSignal): Promise<TextModelResponse> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.calls++;
    this.active++;
    this.peakActive = Math.max(this.peakActive, this.active);
    this.contexts.push(context);
    this.configurations.push(configuration);
    try {
      await this.onCall?.(context, this.calls);
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return {
        text: `response-${this.calls}`,
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      };
    } finally {
      this.active--;
    }
  }
  async streamResponse(context: JsonValue, dispatch: ModelDispatch, signal: AbortSignal): Promise<ModelEffectOutputV2> {
    const observed = await this.complete(context, dispatch.configuration, signal);
    return formalMissingToolOutput({
      dispatch,
      provider: this.name,
      adapter: this.capabilities.requiredToolSet.adapter,
      text: observed.text,
      usage: observed.usage,
    });
  }
}

export class BlockingProvider implements ModelProvider {
  calls = 0;
  active = 0;
  peakActive = 0;
  aborted = 0;
  #blocked = true;
  readonly #waiters = new Set<() => void>();

  constructor(readonly name: string) {}

  unblock(): void {
    this.#blocked = false;
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }

  async complete(_context: JsonValue, _configuration: ModelConfiguration, signal: AbortSignal): Promise<TextModelResponse> {
    this.calls++;
    this.active++;
    this.peakActive = Math.max(this.peakActive, this.active);
    try {
      if (this.#blocked) {
        await new Promise<void>((resolve, reject) => {
          const finish = () => { this.#waiters.delete(finish); resolve(); };
          const abort = () => {
            this.#waiters.delete(finish);
            this.aborted++;
            reject(new DOMException("Aborted", "AbortError"));
          };
          this.#waiters.add(finish);
          signal.addEventListener("abort", abort, { once: true });
        });
      }
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return { text: "released", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    } finally {
      this.active--;
    }
  }
}

export function jsonContains(value: JsonValue, needle: string): boolean {
  return JSON.stringify(value).includes(needle);
}

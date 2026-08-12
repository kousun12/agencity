import { StringDecoder } from "node:string_decoder";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  ValidationError,
  type ModelDescriptor,
} from "../domain/index.ts";
import type { ModelProviderDescriptor } from "../executors/index.ts";
import {
  boundModelSelectionQuery,
  boundProviderSelectionQuery,
  filterCatalogModelsForProvider,
  fitTerminalLine,
  navigateSelectedIdentity,
  rankModelOptions,
  rankProviderOptions,
  reconcileSelectedIdentity,
  terminalColumns,
  visibleSelectionWindow,
  type ModelSelectionOption,
  type ProviderSelectionOption,
} from "../product/model-selection.ts";
import { scrubText } from "../security/index.ts";

const CURSOR_HIDE = "\u001b[?25l";
const CURSOR_SHOW = "\u001b[?25h";
const CLEAR_LINE = "\u001b[2K";
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const ESCAPE_SEQUENCE_DELAY_MS = 25;
const MAX_SECRET_CODE_POINTS = 16_384;
const MAX_CUSTOM_MODEL_ID_BYTES = 512;
const MAX_NOTICE_BYTES = 1_024;
const CATCHABLE_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type CatchableSignal = (typeof CATCHABLE_SIGNALS)[number];

export interface ProductCatalogSelectionResult {
  readonly endpointId?: string;
  readonly origin?: string;
  readonly status?: "refreshed" | "cached-fallback" | "unavailable";
  readonly descriptors: readonly ModelDescriptor[];
  readonly error?: string;
}

export interface ProductPrompterOptions {
  readonly enabled?: boolean;
  readonly input?: NodeJS.ReadStream;
  readonly output?: NodeJS.WriteStream;
  readonly manageSignals?: boolean;
}

interface RawInputOwner {
  readonly write: (value: string) => void;
  readonly finish: (value: unknown) => void;
  readonly fail: (error: unknown) => void;
  readonly setEscapeTimer: (callback: () => void) => void;
  readonly clearEscapeTimer: () => void;
  readonly setRenderer: (callback: () => void) => void;
}

interface PickerState<T extends { readonly identity: string }> {
  query: string;
  options: readonly T[];
  selectedIdentity: string | null;
}

interface CustomModelSelectionOption {
  readonly identity: string;
  readonly model: string;
}

class SetupSignalError extends Error {
  constructor(readonly signal: CatchableSignal) {
    super(`Interactive setup received ${signal}`);
    this.name = "SetupSignalError";
  }
}

/**
 * Session-independent product prompting. Raw operations exclusively own input
 * and restore terminal state before readline or the full-screen TUI resumes.
 */
export class ProductPrompter {
  readonly enabled: boolean;
  readonly #input: NodeJS.ReadStream;
  readonly #output: NodeJS.WriteStream;
  readonly #manageSignals: boolean;
  #readline: ReadlineInterface | null = null;
  #rawOperation = false;

  constructor(options: boolean | ProductPrompterOptions = {}) {
    const normalized = typeof options === "boolean"
      ? { enabled: options }
      : options;
    this.#input = normalized.input ?? stdin;
    this.#output = normalized.output ?? stdout;
    this.enabled = normalized.enabled ??
      (this.#input.isTTY === true && this.#output.isTTY === true);
    this.#manageSignals = normalized.manageSignals ?? true;
  }

  question(question: string): Promise<string> {
    if (!this.enabled) {
      throw new ValidationError("Interactive selection requires a terminal");
    }
    if (this.#rawOperation) {
      throw new ValidationError("Interactive input is already in use");
    }
    this.#readline ??= createInterface({
      input: this.#input,
      output: this.#output,
    });
    return this.#readline.question(question);
  }

  async secret(question: string): Promise<string> {
    if (!this.enabled) {
      throw new ValidationError(
        "Interactive credential entry requires a terminal",
      );
    }
    try {
      return await this.#ownRawInput<string>((owner) => {
        owner.write(fitTerminalLine(question, this.#columns()));
        let answer = "";
        const decoder = new StringDecoder("utf8");
        let pending = "";
        let paste = false;

        const append = (value: string): void => {
          const printable = Array.from(value).filter((character) =>
            isPrintable(character) && character !== "\r" && character !== "\n"
          ).join("");
          answer = codePointPrefix(
            `${answer}${printable}`,
            MAX_SECRET_CODE_POINTS,
          );
        };

        return (chunk) => {
          pending += decodeChunk(decoder, chunk);
          while (pending) {
            if (paste) {
              const end = pending.indexOf(BRACKETED_PASTE_END);
              if (end < 0) {
                const retained = longestSuffixPrefix(
                  pending,
                  BRACKETED_PASTE_END,
                );
                append(pending.slice(0, pending.length - retained));
                pending = pending.slice(pending.length - retained);
                return;
              }
              append(pending.slice(0, end).replace(/[\r\n]/g, ""));
              pending = pending.slice(end + BRACKETED_PASTE_END.length);
              paste = false;
              continue;
            }
            if (pending.startsWith(BRACKETED_PASTE_START)) {
              pending = pending.slice(BRACKETED_PASTE_START.length);
              paste = true;
              continue;
            }
            if (isPrefixOf(pending, BRACKETED_PASTE_START)) return;
            const character = Array.from(pending)[0]!;
            pending = pending.slice(character.length);
            if (character === "\r" || character === "\n") {
              owner.finish(answer.trim());
              return;
            }
            if (isCancellation(character)) {
              owner.fail(
                new ValidationError("Provider credential entry was cancelled"),
              );
              return;
            }
            if (isBackspace(character)) {
              answer = removeLastCodePoint(answer);
              continue;
            }
            if (isPrintable(character)) append(character);
          }
        };
      });
    } finally {
      this.#write("\n");
    }
  }

  async selectProvider(
    providers: readonly ModelProviderDescriptor[],
    introduction = "",
  ): Promise<ModelProviderDescriptor> {
    if (!providers.length) {
      throw new ValidationError("No supported model provider is available");
    }
    if (providers.length === 1) return providers[0]!;
    const byName = new Map(providers.map((provider) => [provider.name, provider]));
    let state: PickerState<ProviderSelectionOption> = {
      query: "",
      options: rankProviderOptions(providers, ""),
      selectedIdentity: null,
    };
    state.selectedIdentity = reconcileSelectedIdentity(
      state.options,
      null,
      "query-edit",
    );
    const render = (): void => {
      const selected = state.selectedIdentity;
      this.#draw([
        ...(introduction ? [introduction.trimEnd()] : []),
        "Choose a provider",
        `› ${state.query}`,
        "",
        ...(state.options.length
          ? state.options.map((option) =>
              `${option.identity === selected ? "›" : " "} ${option.displayName}    ${option.name}`
            )
          : ["  No matching providers"]),
        "",
        "Type to filter · ↑/↓ select · Enter continue · Esc cancel",
      ]);
    };
    const selected = await this.#runPicker(state, {
      boundQuery: boundProviderSelectionQuery,
      rank: (query) => rankProviderOptions(providers, query),
      render,
      cancellationMessage: "Provider selection was cancelled",
    });
    const provider = byName.get(selected.name);
    if (!provider) {
      throw new ValidationError("Selected provider is no longer available");
    }
    return provider;
  }

  async selectModel(
    provider: ModelProviderDescriptor,
    catalogRequest: Promise<ProductCatalogSelectionResult>,
  ): Promise<string> {
    let loading = true;
    let catalog: NormalizedCatalogResult | null = null;
    let state: PickerState<ModelSelectionOption> = {
      query: "",
      options: Object.freeze([]),
      selectedIdentity: null,
    };
    let drawCurrent = (): void => {
      this.#draw([
        `Choose ${indefiniteArticle(provider.displayName)} ${provider.displayName} model`,
        "›",
        "",
        "  Loading configured model catalog…",
        "",
        "Esc cancel",
      ]);
    };

    const selected = await this.#ownRawInput<ModelSelectionOption>(
      (owner) => {
        let parser: ReturnType<typeof createPickerInputParser> | null = null;
        const loadingParser = createLoadingInputParser(
          owner,
          "Model selection was cancelled",
          () => {
            loading = false;
          },
        );
        owner.setRenderer(() => drawCurrent());
        drawCurrent();
        void normalizeCatalogRequest(catalogRequest).then((result) => {
            if (!loading) return;
            owner.clearEscapeTimer();
            loading = false;
            catalog = result;
            state.options = rankModelOptions(
              result.descriptors,
              provider.name,
              state.query,
            );
            state.selectedIdentity = reconcileSelectedIdentity(
              state.options,
              null,
              "data-refresh",
            );
            drawCurrent = () => this.#renderModelPicker(
              provider,
              state,
              catalog!,
            );
            parser = createPickerInputParser({
              state,
              owner,
              boundQuery: boundModelSelectionQuery,
              rank: (query) =>
                rankModelOptions(result.descriptors, provider.name, query),
              render: drawCurrent,
              cancellationMessage: "Model selection was cancelled",
            });
            drawCurrent();
          }).catch((error) => owner.fail(error));
        return (chunk) => {
          if (loading) {
            loadingParser(chunk);
            return;
          }
          parser?.(chunk);
        };
      },
    );
    return selected.model;
  }

  /**
   * Embedded providers own their model grammar. First-run setup therefore uses
   * the same bounded raw single-line editing discipline without applying the
   * product catalog's creator/model rule or fetching an unrelated catalog.
   * The provider and supervisor remain authoritative for normalization.
   */
  async selectCustomModel(
    provider: ModelProviderDescriptor,
  ): Promise<string> {
    let state: PickerState<CustomModelSelectionOption> = {
      query: "",
      options: Object.freeze([]),
      selectedIdentity: null,
    };
    const rank = (query: string): readonly CustomModelSelectionOption[] => {
      const model = query.trim();
      return model
        ? Object.freeze([{ identity: `custom:${model}`, model }])
        : Object.freeze([]);
    };
    const render = (): void => {
      this.#draw([
        `Choose ${indefiniteArticle(provider.displayName)} ${provider.displayName} model`,
        `› ${state.query}`,
        "",
        ...(state.options.length
          ? ["› Use exact provider model ID", `  ${state.options[0]!.model}`]
          : ["  Type the provider-specific model ID."]),
        "",
        "Type model ID · Enter continue · Esc cancel",
      ]);
    };
    const selected = await this.#runPicker(state, {
      boundQuery: boundCustomModelSelectionQuery,
      rank,
      render,
      cancellationMessage: "Model selection was cancelled",
    });
    return selected.model;
  }

  close(): void {
    this.#readline?.close();
    this.#readline = null;
  }

  async #runPicker<T extends { readonly identity: string }>(
    state: PickerState<T>,
    options: {
      readonly boundQuery: (query: string) => string;
      readonly rank: (query: string) => readonly T[];
      readonly render: () => void;
      readonly cancellationMessage: string;
    },
  ): Promise<T> {
    return this.#ownRawInput<T>((owner) => {
      owner.setRenderer(options.render);
      options.render();
      return createPickerInputParser({ state, owner, ...options });
    });
  }

  #renderModelPicker(
    provider: ModelProviderDescriptor,
    state: PickerState<ModelSelectionOption>,
    catalog: NormalizedCatalogResult,
  ): void {
    const notice = catalogNotice(catalog, provider.name);
    const window = visibleSelectionWindow(
      state.options,
      state.selectedIdentity,
    );
    const rows: string[] = [
      `Choose ${indefiniteArticle(provider.displayName)} ${provider.displayName} model`,
      `› ${state.query}`,
      "",
      ...(notice ? [notice, ""] : []),
    ];
    if (!window.options.length) {
      rows.push(
        state.query
          ? "  No selectable result. Enter an exact creator/model ID."
          : "  Type a model name or exact creator/model ID.",
      );
    } else {
      for (const option of window.options) {
        const selected = option.identity === state.selectedIdentity ? "›" : " ";
        rows.push(`${selected} ${option.displayName}`);
        if (option.kind === "manual") {
          rows.push(`  ${option.model} · not listed in catalog`);
        } else {
          const metadata = [
            option.model,
            option.descriptor.contextWindowTokens === null
              ? null
              : `${compactCount(option.descriptor.contextWindowTokens)} context`,
            option.descriptor.reasoning.status === "unsupported"
              ? "no effort"
              : "effort",
            option.descriptor.stale ? "stale" : null,
          ].filter(Boolean).join(" · ");
          rows.push(`  ${metadata}`);
        }
      }
    }
    rows.push(
      "",
      "Type to filter · ↑/↓ select · Enter use model · Esc cancel",
    );
    this.#draw(rows);
  }

  async #ownRawInput<T>(
    configure: (
      owner: RawInputOwner,
    ) => (chunk: Buffer | string) => void,
  ): Promise<T> {
    if (!this.enabled) {
      throw new ValidationError("Interactive selection requires a terminal");
    }
    if (this.#rawOperation) {
      throw new ValidationError("Interactive input is already in use");
    }
    if (typeof this.#input.setRawMode !== "function") {
      throw new ValidationError(
        "This terminal cannot provide exclusive raw input",
      );
    }
    this.close();
    this.#rawOperation = true;
    const wasRaw = this.#input.isRaw === true;
    const wasPaused = this.#input.isPaused();
    let dataListener: ((chunk: Buffer | string) => void) | null = null;
    let escapeTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const signalHandlers = new Map<CatchableSignal, () => void>();
    const onInputError = (error: unknown): void => failResult(error);
    const onOutputError = (error: unknown): void => failResult(error);
    let renderer: (() => void) | null = null;
    const onResize = (): void => {
      try {
        renderer?.();
      } catch (error) {
        failResult(error);
      }
    };
    const onInputEnd = (): void =>
      failResult(
        new ValidationError("Interactive input ended before selection"),
      );
    let failResult: (error: unknown) => void = () => {};
    try {
      // Raw mode must be active before any prompt is rendered. A fast terminal
      // peer may answer as soon as it observes the prompt, so keep the stream
      // paused until the exclusive data listener is attached.
      this.#input.pause();
      this.#input.setRawMode(true);
    } catch (error) {
      this.#rawOperation = false;
      try {
        this.#input.setRawMode(wasRaw);
      } catch {
        // Preserve the original setup error.
      }
      if (wasPaused) this.#input.pause();
      else this.#input.resume();
      throw error;
    }
    const result = new Promise<T>((resolve, reject) => {
      const finish = (value: unknown): void => {
        if (settled) return;
        settled = true;
        resolve(value as T);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      failResult = fail;
      const owner: RawInputOwner = {
        write: (value) => this.#write(value),
        finish,
        fail,
        setEscapeTimer: (callback) => {
          if (escapeTimer !== null) clearTimeout(escapeTimer);
          escapeTimer = setTimeout(callback, ESCAPE_SEQUENCE_DELAY_MS);
        },
        clearEscapeTimer: () => {
          if (escapeTimer !== null) clearTimeout(escapeTimer);
          escapeTimer = null;
        },
        setRenderer: (callback) => {
          renderer = callback;
        },
      };
      try {
        const configured = configure(owner);
        dataListener = (chunk): void => {
          try {
            configured(chunk);
          } catch (error) {
            fail(error);
          }
        };
        this.#input.on("data", dataListener);
        this.#input.once("error", onInputError);
        this.#input.once("end", onInputEnd);
        this.#output.once("error", onOutputError);
        this.#output.on("resize", onResize);
        if (this.#manageSignals) {
          for (const signal of CATCHABLE_SIGNALS) {
            const handler = (): void => fail(new SetupSignalError(signal));
            signalHandlers.set(signal, handler);
            process.once(signal, handler);
          }
        }
      } catch (error) {
        fail(error);
      }
    });
    this.#input.resume();
    try {
      return await result;
    } catch (error) {
      if (error instanceof SetupSignalError) {
        queueMicrotask(() => process.kill(process.pid, error.signal));
      }
      throw error;
    } finally {
      if (escapeTimer !== null) clearTimeout(escapeTimer);
      if (dataListener !== null) this.#input.off("data", dataListener);
      this.#input.off("error", onInputError);
      this.#input.off("end", onInputEnd);
      this.#output.off("error", onOutputError);
      this.#output.off("resize", onResize);
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
      try {
        this.#input.setRawMode(wasRaw);
      } finally {
        if (wasPaused) this.#input.pause();
        else this.#input.resume();
        this.#rawOperation = false;
        const drawnRows = this.#drawnRows;
        this.#drawnRows = 0;
        this.#write(CURSOR_SHOW);
        if (drawnRows > 0) this.#write("\n");
      }
    }
  }

  #drawnRows = 0;

  #draw(lines: readonly string[]): void {
    const columns = this.#columns();
    const safe = lines.map((line) => fitTerminalLine(line, columns));
    const rowCount = Math.max(safe.length, this.#drawnRows);
    const padded = [
      ...safe,
      ...Array.from({ length: rowCount - safe.length }, () => ""),
    ];
    let redraw = "";
    if (this.#drawnRows > 0) {
      redraw += "\r";
      if (this.#drawnRows > 1) redraw += `\u001b[${this.#drawnRows - 1}A`;
    }
    redraw += padded.map((line) => `${CLEAR_LINE}\r${line}`).join("\n");
    this.#write(`${CURSOR_HIDE}${redraw}${CURSOR_SHOW}`);
    this.#drawnRows = rowCount;
  }

  #columns(): number {
    return terminalColumns(this.#output.columns);
  }

  #write(value: string): void {
    this.#output.write(value);
  }
}

interface PickerParserOptions<T extends { readonly identity: string }> {
  readonly state: PickerState<T>;
  readonly owner: RawInputOwner;
  readonly boundQuery: (query: string) => string;
  readonly rank: (query: string) => readonly T[];
  readonly render: () => void;
  readonly cancellationMessage: string;
}

function createPickerInputParser<T extends { readonly identity: string }>(
  options: PickerParserOptions<T>,
): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let paste = false;

  const edit = (value: string): void => {
    const printable = Array.from(value).filter(isPrintable).join("");
    options.state.query = options.boundQuery(
      `${options.state.query}${printable}`,
    );
    options.state.options = options.rank(options.state.query);
    options.state.selectedIdentity = reconcileSelectedIdentity(
      options.state.options,
      options.state.selectedIdentity,
      "query-edit",
    );
    options.render();
  };
  const cancel = (): void =>
    options.owner.fail(new ValidationError(options.cancellationMessage));
  const confirm = (): void => {
    const selected = options.state.options.find((option) =>
      option.identity === options.state.selectedIdentity
    );
    if (selected) options.owner.finish(selected);
  };
  const move = (delta: number): void => {
    options.state.selectedIdentity = navigateSelectedIdentity(
      options.state.options,
      options.state.selectedIdentity,
      delta,
    );
    options.render();
  };

  return (chunk) => {
    pending += decodeChunk(decoder, chunk);
    options.owner.clearEscapeTimer();
    while (pending) {
      if (paste) {
        const end = pending.indexOf(BRACKETED_PASTE_END);
        if (end < 0) {
          const retained = longestSuffixPrefix(pending, BRACKETED_PASTE_END);
          edit(pending.slice(0, pending.length - retained).replace(/[\r\n]/g, ""));
          pending = pending.slice(pending.length - retained);
          return;
        }
        edit(pending.slice(0, end).replace(/[\r\n]/g, ""));
        pending = pending.slice(end + BRACKETED_PASTE_END.length);
        paste = false;
        continue;
      }
      if (pending.startsWith(BRACKETED_PASTE_START)) {
        pending = pending.slice(BRACKETED_PASTE_START.length);
        paste = true;
        continue;
      }
      if (pending === "\u001b") {
        options.owner.setEscapeTimer(cancel);
        return;
      }
      const csi = takeCsiSequence(pending);
      if (csi === "partial") {
        options.owner.setEscapeTimer(cancel);
        return;
      }
      if (csi !== null) {
        pending = pending.slice(csi.length);
        if (csi.sequence === "\u001b[A") move(-1);
        else if (csi.sequence === "\u001b[B") move(1);
        continue;
      }
      const character = Array.from(pending)[0]!;
      pending = pending.slice(character.length);
      if (character === "\u001b" || character === "\u0003" ||
          character === "\u0004") {
        cancel();
        return;
      }
      if (character === "\r" || character === "\n") {
        confirm();
        return;
      }
      if (isBackspace(character)) {
        options.state.query = removeLastCodePoint(options.state.query);
        options.state.options = options.rank(options.state.query);
        options.state.selectedIdentity = reconcileSelectedIdentity(
          options.state.options,
          options.state.selectedIdentity,
          "query-edit",
        );
        options.render();
        continue;
      }
      if (isPrintable(character)) edit(character);
    }
  };
}

function createLoadingInputParser(
  owner: RawInputOwner,
  cancellationMessage: string,
  onCancel: () => void,
): (chunk: Buffer | string) => void {
  let pending = "";
  const cancel = (): void => {
    onCancel();
    owner.fail(new ValidationError(cancellationMessage));
  };
  return (chunk) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    owner.clearEscapeTimer();
    while (pending) {
      if (pending === "\u001b") {
        owner.setEscapeTimer(cancel);
        return;
      }
      const csi = takeCsiSequence(pending);
      if (csi === "partial") {
        owner.setEscapeTimer(cancel);
        return;
      }
      if (csi !== null) {
        pending = pending.slice(csi.length);
        continue;
      }
      const character = Array.from(pending)[0]!;
      pending = pending.slice(character.length);
      if (isCancellation(character)) {
        cancel();
        return;
      }
      // Loading owns input but deliberately discards all non-cancellation data.
    }
  };
}

interface NormalizedCatalogResult {
  readonly status: "refreshed" | "cached-fallback" | "unavailable";
  readonly descriptors: readonly ModelDescriptor[];
  readonly error?: string;
}

async function normalizeCatalogRequest(
  request: Promise<ProductCatalogSelectionResult>,
): Promise<NormalizedCatalogResult> {
  try {
    const result = await request;
    if (!result || !Array.isArray(result.descriptors) ||
        !["refreshed", "cached-fallback", "unavailable"].includes(
          result.status ?? "",
        )) {
      return {
        status: "unavailable",
        descriptors: Object.freeze([]),
        error: "The configured model catalog returned an invalid response.",
      };
    }
    return {
      status: result.status!,
      descriptors: Object.freeze([...result.descriptors]),
      ...(result.error === undefined
        ? {}
        : { error: boundedNotice(result.error) }),
    };
  } catch (error) {
    return {
      status: "unavailable",
      descriptors: Object.freeze([]),
      error: boundedNotice(error instanceof Error ? error.message : String(error)),
    };
  }
}

function catalogNotice(
  catalog: NormalizedCatalogResult,
  provider: string,
): string | null {
  if (catalog.status === "cached-fallback") {
    return `Using cached catalog${catalog.error ? `: ${catalog.error}` : "."}`;
  }
  if (catalog.status === "unavailable") {
    return `Catalog unavailable${catalog.error ? `: ${catalog.error}` : "."} Enter an exact model ID.`;
  }
  if (!filterCatalogModelsForProvider(catalog.descriptors, provider).length) {
    return `No catalog models are listed for ${provider}. Enter an exact model ID.`;
  }
  return null;
}

function boundedNotice(value: string): string {
  const scrubbed = scrubText(value).replace(
    /(?:bearer|api[-_ ]?key|authorization|x-api-key)\s*[:=]\s*\S+/gi,
    "[redacted]",
  );
  const bytes = new TextEncoder().encode(scrubbed);
  return new TextDecoder().decode(bytes.slice(0, MAX_NOTICE_BYTES))
    .replace(/[\r\n]+/g, " ");
}

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function indefiniteArticle(value: string): "a" | "an" {
  return /^[aeiou]/i.test(value.trim()) ? "an" : "a";
}

function decodeChunk(
  decoder: StringDecoder,
  chunk: Buffer | string,
): string {
  return typeof chunk === "string" ? chunk : decoder.write(chunk);
}

function isCancellation(character: string): boolean {
  return character === "\u0003" || character === "\u0004" ||
    character === "\u001b";
}

function isBackspace(character: string): boolean {
  return character === "\b" || character === "\u007f";
}

function isPrintable(character: string): boolean {
  const code = character.codePointAt(0)!;
  return code >= 0x20 && code !== 0x7f &&
    !(code >= 0x80 && code <= 0x9f);
}

function removeLastCodePoint(value: string): string {
  return Array.from(value).slice(0, -1).join("");
}

function codePointPrefix(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function boundCustomModelSelectionQuery(value: string): string {
  const encoder = new TextEncoder();
  let output = "";
  let bytes = 0;
  for (const character of Array.from(value).slice(0, 512)) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > MAX_CUSTOM_MODEL_ID_BYTES) break;
    output += character;
    bytes += size;
  }
  return output;
}

function isPrefixOf(value: string, complete: string): boolean {
  return value.length < complete.length && complete.startsWith(value);
}

function longestSuffixPrefix(value: string, complete: string): number {
  const maximum = Math.min(value.length, complete.length - 1);
  for (let size = maximum; size > 0; size -= 1) {
    if (complete.startsWith(value.slice(-size))) return size;
  }
  return 0;
}

function takeCsiSequence(
  value: string,
): { readonly sequence: string; readonly length: number } | "partial" | null {
  if (!value.startsWith("\u001b[")) return null;
  for (let index = 2; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return {
        sequence: value.slice(0, index + 1),
        length: index + 1,
      };
    }
    if (
      !((code >= 0x20 && code <= 0x2f) ||
        (code >= 0x30 && code <= 0x3f))
    ) {
      return null;
    }
  }
  return "partial";
}

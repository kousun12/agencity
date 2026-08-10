import { open, type FileHandle } from "node:fs/promises";
import { ValidationError } from "../domain/index.ts";
import { StreamingTextScrubber } from "../security/index.ts";

type ObjectState = "key-or-end" | "colon" | "value" | "comma-or-end";
type ArrayState = "value-or-end" | "comma-or-end";
type Frame =
  | { readonly kind: "object"; state: ObjectState }
  | { readonly kind: "array"; state: ArrayState };

const encoder = new TextEncoder();

/**
 * Incrementally validates one JSON value and writes only scrubbed JSON bytes.
 * Memory is bounded by one IPC chunk, parser state, and the streaming scrubber.
 */
export class StreamingJsonStager {
  readonly #handle: FileHandle;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #frames: Frame[] = [];
  #root: "value" | "done" = "value";
  #mode: "normal" | "string" | "number" | "literal" = "normal";
  #token = "";
  #stringIsKey = false;
  #escape = false;
  #unicode = "";
  #decodedString = "";
  #scrubber: StreamingTextScrubber | null = null;
  #writeBuffer = "";
  #byteLength = 0;
  #closed = false;

  private constructor(handle: FileHandle) {
    this.#handle = handle;
  }

  static async open(path: string): Promise<StreamingJsonStager> {
    return new StreamingJsonStager(await open(path, "wx", 0o600));
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  async push(bytes: Uint8Array): Promise<void> {
    if (this.#closed) throw new ValidationError("JSON staging writer is closed");
    await this.#consume(this.#decoder.decode(bytes, { stream: true }));
  }

  async finish(): Promise<number> {
    if (this.#closed) throw new ValidationError("JSON staging writer is closed");
    try {
      await this.#consume(this.#decoder.decode());
      if (this.#mode === "number" || this.#mode === "literal") await this.#finishToken();
      if (this.#mode !== "normal" || this.#frames.length !== 0 || this.#root !== "done") {
        throw new ValidationError("Oversized cell observation is incomplete JSON");
      }
      await this.#flush();
      await this.#handle.close();
      this.#closed = true;
      return this.#byteLength;
    } catch (error) {
      await this.abort();
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close().catch(() => {});
  }

  async #consume(text: string): Promise<void> {
    for (let index = 0; index < text.length; index++) {
      const character = text[index]!;
      if (this.#mode === "string") {
        await this.#consumeString(character);
        continue;
      }
      if (this.#mode === "number") {
        if (/[0-9eE+.-]/.test(character)) {
          this.#token += character;
          if (this.#token.length > 128) throw new ValidationError("JSON numeric token is too large");
          await this.#write(character);
          continue;
        }
        await this.#finishToken();
        index--;
        continue;
      }
      if (this.#mode === "literal") {
        if (/[a-z]/.test(character)) {
          this.#token += character;
          if (this.#token.length > 5) throw new ValidationError("Invalid JSON literal");
          await this.#write(character);
          continue;
        }
        await this.#finishToken();
        index--;
        continue;
      }
      if (/\s/.test(character)) {
        await this.#write(character);
        continue;
      }
      const expected = this.#expected();
      if (character === "\"") {
        if (expected !== "value" && expected !== "key-or-end" && expected !== "value-or-end") {
          throw new ValidationError("Unexpected JSON string");
        }
        this.#mode = "string";
        this.#stringIsKey = expected === "key-or-end";
        this.#scrubber = new StreamingTextScrubber();
        await this.#write(character);
        continue;
      }
      if (character === "{") {
        this.#requireValue(expected);
        this.#frames.push({ kind: "object", state: "key-or-end" });
        await this.#write(character);
        continue;
      }
      if (character === "[") {
        this.#requireValue(expected);
        this.#frames.push({ kind: "array", state: "value-or-end" });
        await this.#write(character);
        continue;
      }
      if (character === "}") {
        const frame = this.#frames.at(-1);
        if (!frame || frame.kind !== "object" ||
            (frame.state !== "key-or-end" && frame.state !== "comma-or-end")) {
          throw new ValidationError("Unexpected JSON object terminator");
        }
        this.#frames.pop();
        this.#consumeValue();
        await this.#write(character);
        continue;
      }
      if (character === "]") {
        const frame = this.#frames.at(-1);
        if (!frame || frame.kind !== "array" ||
            (frame.state !== "value-or-end" && frame.state !== "comma-or-end")) {
          throw new ValidationError("Unexpected JSON array terminator");
        }
        this.#frames.pop();
        this.#consumeValue();
        await this.#write(character);
        continue;
      }
      if (character === ":") {
        const frame = this.#frames.at(-1);
        if (!frame || frame.kind !== "object" || frame.state !== "colon") {
          throw new ValidationError("Unexpected JSON colon");
        }
        frame.state = "value";
        await this.#write(character);
        continue;
      }
      if (character === ",") {
        const frame = this.#frames.at(-1);
        if (!frame || frame.state !== "comma-or-end") throw new ValidationError("Unexpected JSON comma");
        frame.state = frame.kind === "object" ? "key-or-end" : "value-or-end";
        await this.#write(character);
        continue;
      }
      if (character === "-" || /[0-9]/.test(character)) {
        this.#requireValue(expected);
        this.#mode = "number";
        this.#token = character;
        await this.#write(character);
        continue;
      }
      if (character === "t" || character === "f" || character === "n") {
        this.#requireValue(expected);
        this.#mode = "literal";
        this.#token = character;
        await this.#write(character);
        continue;
      }
      throw new ValidationError("Oversized cell observation contains invalid JSON");
    }
  }

  async #consumeString(character: string): Promise<void> {
    if (this.#unicode) {
      if (!/[a-fA-F0-9]/.test(character)) throw new ValidationError("Invalid JSON Unicode escape");
      this.#unicode += character;
      if (this.#unicode.length === 5) {
        await this.#decoded(String.fromCharCode(Number.parseInt(this.#unicode.slice(1), 16)));
        this.#unicode = "";
        this.#escape = false;
      }
      return;
    }
    if (this.#escape) {
      if (character === "u") {
        this.#unicode = "u";
        return;
      }
      const escaped: Record<string, string> = {
        "\"": "\"",
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      if (escaped[character] === undefined) throw new ValidationError("Invalid JSON string escape");
      await this.#decoded(escaped[character]!);
      this.#escape = false;
      return;
    }
    if (character === "\\") {
      this.#escape = true;
      return;
    }
    if (character === "\"") {
      await this.#flushDecodedString();
      await this.#writeEscaped(this.#scrubber!.finish());
      await this.#write(character);
      const frame = this.#frames.at(-1);
      if (this.#stringIsKey) {
        if (!frame || frame.kind !== "object" || frame.state !== "key-or-end") {
          throw new ValidationError("JSON key is outside an object");
        }
        frame.state = "colon";
      } else {
        this.#consumeValue();
      }
      this.#mode = "normal";
      this.#stringIsKey = false;
      this.#scrubber = null;
      return;
    }
    if (character.charCodeAt(0) < 0x20) throw new ValidationError("JSON strings cannot contain control characters");
    await this.#decoded(character);
  }

  async #decoded(value: string): Promise<void> {
    this.#decodedString += value;
    if (this.#decodedString.length >= 4_096 &&
        !/[\uD800-\uDBFF]$/.test(this.#decodedString)) {
      await this.#flushDecodedString();
    }
  }

  async #flushDecodedString(): Promise<void> {
    if (!this.#decodedString) return;
    const scrubbed = this.#scrubber!.push(encoder.encode(this.#decodedString));
    this.#decodedString = "";
    await this.#writeEscaped(scrubbed);
  }

  async #writeEscaped(value: string): Promise<void> {
    if (value) await this.#write(JSON.stringify(value).slice(1, -1));
  }

  async #finishToken(): Promise<void> {
    if (this.#mode === "number" &&
        !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(this.#token)) {
      throw new ValidationError("Invalid JSON number");
    }
    if (this.#mode === "literal" && !["true", "false", "null"].includes(this.#token)) {
      throw new ValidationError("Invalid JSON literal");
    }
    this.#mode = "normal";
    this.#token = "";
    this.#consumeValue();
  }

  #expected(): ObjectState | ArrayState | "value" | "done" {
    return this.#frames.at(-1)?.state ?? this.#root;
  }

  #requireValue(expected: ObjectState | ArrayState | "value" | "done"): void {
    if (expected !== "value" && expected !== "value-or-end") {
      throw new ValidationError("Unexpected JSON value");
    }
  }

  #consumeValue(): void {
    const frame = this.#frames.at(-1);
    if (!frame) {
      if (this.#root !== "value") throw new ValidationError("JSON contains multiple root values");
      this.#root = "done";
      return;
    }
    if (frame.kind === "object") {
      if (frame.state !== "value") throw new ValidationError("Unexpected JSON object value");
      frame.state = "comma-or-end";
      return;
    }
    if (frame.state !== "value-or-end") throw new ValidationError("Unexpected JSON array value");
    frame.state = "comma-or-end";
  }

  async #write(value: string): Promise<void> {
    this.#writeBuffer += value;
    if (this.#writeBuffer.length >= 32 * 1024) await this.#flush();
  }

  async #flush(): Promise<void> {
    if (!this.#writeBuffer) return;
    const bytes = encoder.encode(this.#writeBuffer);
    this.#writeBuffer = "";
    await this.#handle.write(bytes);
    this.#byteLength += bytes.byteLength;
  }
}

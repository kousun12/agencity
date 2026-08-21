import { OBSERVER_BOUNDS, type ObserverBoundedText } from "./types.ts";

const encoder = new TextEncoder();

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function serializedUtf8Bytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

function utf8Prefix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = utf8Bytes(character);
    if (bytes + size > maximumBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function utf8Suffix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  let bytes = 0;
  const result: string[] = [];
  for (let index = value.length; index > 0;) {
    let start = index - 1;
    const code = value.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff && start > 0) {
      const high = value.charCodeAt(start - 1);
      if (high >= 0xd800 && high <= 0xdbff) start -= 1;
    }
    const character = value.slice(start, index);
    const size = utf8Bytes(character);
    if (bytes + size > maximumBytes) break;
    result.push(character);
    bytes += size;
    index = start;
  }
  return result.reverse().join("");
}

export function boundText(
  value: string,
  options: {
    readonly maximumBytes?: number;
    readonly mode?: "prefix" | "head_tail";
    readonly digest?: string | null;
  } = {},
): ObserverBoundedText {
  const maximumBytes = Math.max(0, Math.floor(options.maximumBytes ?? OBSERVER_BOUNDS.textBytes));
  const originalUtf8Bytes = utf8Bytes(value);
  const digest = options.digest ?? null;
  if (originalUtf8Bytes <= maximumBytes) {
    return {
      kind: "complete",
      text: value,
      originalUtf8Bytes,
      visibleUtf8Bytes: originalUtf8Bytes,
      omittedUtf8Bytes: 0,
      digest,
    };
  }
  if (options.mode !== "head_tail") {
    const prefix = utf8Prefix(value, maximumBytes);
    const visibleUtf8Bytes = utf8Bytes(prefix);
    return {
      kind: "prefix",
      prefix,
      originalUtf8Bytes,
      visibleUtf8Bytes,
      omittedUtf8Bytes: originalUtf8Bytes - visibleUtf8Bytes,
      digest,
    };
  }
  const head = utf8Prefix(value, Math.ceil(maximumBytes / 2));
  const tail = utf8Suffix(value, maximumBytes - utf8Bytes(head));
  const visibleUtf8Bytes = utf8Bytes(head) + utf8Bytes(tail);
  return {
    kind: "head_tail",
    head,
    tail,
    originalUtf8Bytes,
    visibleUtf8Bytes,
    omittedUtf8Bytes: originalUtf8Bytes - visibleUtf8Bytes,
    digest,
  };
}

export function boundedJsonText(
  value: unknown,
  maximumBytes = OBSERVER_BOUNDS.textBytes,
): ObserverBoundedText {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = "[unserializable value]";
  }
  return boundText(serialized ?? "null", { maximumBytes, mode: "head_tail" });
}

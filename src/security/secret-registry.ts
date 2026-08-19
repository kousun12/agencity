const brokeredSecrets = new Map<string, number>();

/** Supervisor-internal snapshot used to preserve exact matching across async boundaries. */
export function brokeredSecretValues(): string[] {
  return [...brokeredSecrets.keys()].sort((left, right) =>
    right.length - left.length || left.localeCompare(right)
  );
}

export function registerBrokeredSecretValue(value: string): () => void {
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (byteLength < 4 || byteLength > 16 * 1024 || value.includes("\0")) {
    throw new Error("Brokered credentials must be NUL-free and contain 4-16384 UTF-8 bytes");
  }
  brokeredSecrets.set(value, (brokeredSecrets.get(value) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (brokeredSecrets.get(value) ?? 1) - 1;
    if (remaining <= 0) brokeredSecrets.delete(value);
    else brokeredSecrets.set(value, remaining);
  };
}

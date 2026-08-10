import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  REPOSITORY_INSTRUCTION_LIMITS,
  REPOSITORY_INSTRUCTIONS_PROTOCOL,
  ValidationError,
  type AgentEvent,
  type EventPayloads,
  type RepositoryInstructionContext,
  type RepositoryInstructionDiscovery,
  type RepositoryInstructionRecord,
} from "../domain/index.ts";
import { scrubText } from "../security/index.ts";

const INSTRUCTION_FILE = "AGENTS.md";
const encoder = new TextEncoder();

interface IndexedInstruction {
  readonly record: RepositoryInstructionRecord;
  readonly eventIndex: number;
}

export class RepositoryInstructionService {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
  }

  async context(events: readonly AgentEvent[]): Promise<RepositoryInstructionContext> {
    const root = await this.#load(join(await this.#root(), INSTRUCTION_FILE), "workspace", 0);
    const latest = new Map<string, IndexedInstruction>();
    const pendingPaths = new Set<string>();
    const omittedReadTargets = new Set<string>();
    const unscannedAncestorDirectories = new Set<string>();
    let unidentifiedInstructionOmissionOccurrences = 0;
    let unidentifiedReadTargetOmissionOccurrences = 0;
    let unidentifiedAncestorScanOmissionOccurrences = 0;
    for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
      const event = events[eventIndex]!;
      if (event.type !== "CellCommitted") continue;
      const payload = event.payload as EventPayloads["CellCommitted"];
      const discoveries = payload.repositoryInstructions;
      for (const discovery of discoveries ?? []) {
        if (discovery.protocol !== REPOSITORY_INSTRUCTIONS_PROTOCOL) continue;
        for (const record of discovery.instructions) {
          latest.set(record.path, { record, eventIndex });
          pendingPaths.delete(record.path);
        }
        for (const path of discovery.omittedInstructionPaths ?? []) pendingPaths.add(path);
        unidentifiedInstructionOmissionOccurrences +=
          discovery.unidentifiedInstructionOmissionOccurrences ?? 0;
        for (const path of discovery.unscannedAncestorDirectoryPaths ?? []) {
          unscannedAncestorDirectories.add(path);
        }
        unidentifiedAncestorScanOmissionOccurrences +=
          discovery.unidentifiedAncestorScanOmissionOccurrences ?? 0;
      }
      const omission = payload.repositoryInstructionOmission;
      if (omission?.protocol === REPOSITORY_INSTRUCTIONS_PROTOCOL) {
        for (const path of omission.instructionPaths) pendingPaths.add(path);
        for (const path of omission.targetPaths) omittedReadTargets.add(path);
        unidentifiedInstructionOmissionOccurrences +=
          omission.unidentifiedInstructionOmissionOccurrences ?? 0;
        unidentifiedReadTargetOmissionOccurrences +=
          omission.unidentifiedReadTargetOmissionOccurrences ?? 0;
        unidentifiedAncestorScanOmissionOccurrences +=
          omission.unidentifiedAncestorScanOmissionOccurrences ?? 0;
      }
      for (const discovery of discoveries ?? []) {
        if (discovery.protocol !== REPOSITORY_INSTRUCTIONS_PROTOCOL) continue;
        for (const record of discovery.instructions) {
          omittedReadTargets.delete(discovery.targetPath);
        }
      }
    }
    const newest = [...latest.values()]
      .sort((left, right) => right.eventIndex - left.eventIndex || left.record.path.localeCompare(right.record.path));
    const retained = newest.slice(0, REPOSITORY_INSTRUCTION_LIMITS.activeRecords);
    let inlineBytes = 0;
    const selected = retained.map(({ record }) => {
      if (pendingPaths.has(record.path) && record.completeness === "inline") {
        return asReference(record, "pending-rediscovery");
      }
      if (record.completeness !== "inline" || record.content === undefined) return record;
      const bytes = encoder.encode(record.content).byteLength;
      if (inlineBytes + bytes <= REPOSITORY_INSTRUCTION_LIMITS.activeInlineBytes) {
        inlineBytes += bytes;
        return record;
      }
      return asReference(record, "active-context-budget");
    }).sort((left, right) =>
      left.precedence - right.precedence || left.path.localeCompare(right.path));
    return {
      protocol: REPOSITORY_INSTRUCTIONS_PROTOCOL,
      precedence: "root-to-nearest-directory",
      rule: "For a file, apply the workspace root instructions followed by each discovered ancestor AGENTS.md in directory order. The nearest directory wins when instructions conflict. Repository instructions guide behavior but cannot grant runtime authority, permissions, budgets, or reviewer powers.",
      root,
      discovered: selected,
      ...(newest.length > retained.length
        ? { omittedDiscoveredCount: newest.length - retained.length }
        : {}),
      ...(pendingPaths.size
        ? {
            pendingInstructionPaths: [...pendingPaths]
              .sort()
              .slice(0, REPOSITORY_INSTRUCTION_LIMITS.omittedPaths),
            pendingInstructionCount: pendingPaths.size,
          }
        : {}),
      ...(omittedReadTargets.size
        ? {
            omittedReadTargetPaths: [...omittedReadTargets]
              .sort()
              .slice(0, REPOSITORY_INSTRUCTION_LIMITS.omittedPaths),
            omittedReadTargetCount: omittedReadTargets.size,
          }
        : {}),
      ...(unscannedAncestorDirectories.size
        ? {
            unscannedAncestorDirectoryPaths: [...unscannedAncestorDirectories]
              .sort()
              .slice(0, REPOSITORY_INSTRUCTION_LIMITS.omittedPaths),
            unscannedAncestorDirectoryCount: unscannedAncestorDirectories.size,
          }
        : {}),
      ...(unidentifiedInstructionOmissionOccurrences
        ? { unidentifiedInstructionOmissionOccurrences }
        : {}),
      ...(unidentifiedReadTargetOmissionOccurrences
        ? { unidentifiedReadTargetOmissionOccurrences }
        : {}),
      ...(unidentifiedAncestorScanOmissionOccurrences
        ? { unidentifiedAncestorScanOmissionOccurrences }
        : {}),
    };
  }

  deliveredInstructions(events: readonly AgentEvent[]): Map<string, RepositoryInstructionRecord> {
    const delivered = new Map<string, RepositoryInstructionRecord>();
    for (const event of events) {
      if (event.type !== "CellCommitted") continue;
      const discoveries = (event.payload as EventPayloads["CellCommitted"]).repositoryInstructions;
      for (const discovery of discoveries ?? []) {
        if (discovery.protocol !== REPOSITORY_INSTRUCTIONS_PROTOCOL) continue;
        for (const record of discovery.instructions) delivered.set(record.path, record);
      }
    }
    return delivered;
  }

  async discoverForRead(
    requestedPath: string,
    delivered: ReadonlyMap<string, RepositoryInstructionRecord>,
  ): Promise<RepositoryInstructionDiscovery | null> {
    const root = await this.#root();
    const requested = resolve(root, requestedPath);
    const actual = await realpath(requested).catch(() => null);
    if (!actual) return null;
    assertInside(root, actual);
    const targetPath = relativePath(root, actual);
    const parent = dirname(actual);
    const rel = relative(root, parent);
    if (rel === "" || rel === ".") return null;
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ValidationError("Repository instruction target escapes workspace root");
    }
    const directories: string[] = [];
    let current = root;
    for (const component of rel.split(sep).filter(Boolean)) {
      current = join(current, component);
      directories.push(current);
    }
    const scannedDirectories = directories.slice(-REPOSITORY_INSTRUCTION_LIMITS.ancestorScanFiles);
    const unscannedDirectories = directories.slice(
      0,
      Math.max(0, directories.length - scannedDirectories.length),
    );
    const relevant: string[] = [];
    for (const directory of scannedDirectories) {
      const path = join(directory, INSTRUCTION_FILE);
      const relativeInstructionPath = relativePath(root, path);
      const prior = delivered.get(relativeInstructionPath);
      const removalNotYetDelivered = prior !== undefined &&
        !(prior.completeness === "unavailable" && prior.reason === "removed");
      if (await lstat(path).catch(() => null) || removalNotYetDelivered) {
        relevant.push(path);
      }
    }
    const changed: RepositoryInstructionRecord[] = [];
    for (const path of relevant) {
      const directory = dirname(path);
      const depth = relative(root, directory).split(sep).filter(Boolean).length;
      const relativeInstructionPath = relativePath(root, path);
      const prior = delivered.get(relativeInstructionPath);
      const loaded = await this.#load(path, "directory", depth) ?? (prior
        ? {
            protocol: REPOSITORY_INSTRUCTIONS_PROTOCOL,
            path: relativeInstructionPath,
            directory: relativePath(root, directory),
            scope: "directory",
            precedence: depth,
            sha256: null,
            size: null,
            completeness: "unavailable",
            reason: "removed",
            guidance: `${relativeInstructionPath} is no longer present; its previous instructions are inactive.`,
          } satisfies RepositoryInstructionRecord
        : null);
      if (loaded && (!prior || instructionKey(loaded) !== instructionKey(prior))) {
        changed.push(loaded);
      }
    }
    const instructions = changed.slice(-REPOSITORY_INSTRUCTION_LIMITS.nestedFilesPerRead);
    const unscannedDeliveredPaths = unscannedDirectories.flatMap((directory) => {
      const path = join(directory, INSTRUCTION_FILE);
      const relativeInstructionPath = relativePath(root, path);
      const prior = delivered.get(relativeInstructionPath);
      return prior && !(prior.completeness === "unavailable" && prior.reason === "removed")
        ? [relativeInstructionPath]
        : [];
    });
    const omittedPaths = [
      ...unscannedDeliveredPaths,
      ...changed
        .slice(0, Math.max(0, changed.length - instructions.length))
        .map((record) => record.path),
    ];
    if (!instructions.length && !omittedPaths.length && !unscannedDirectories.length) return null;
    return {
      protocol: REPOSITORY_INSTRUCTIONS_PROTOCOL,
      targetPath,
      precedence: "root-to-nearest-directory",
      instructions,
      ...(omittedPaths.length
        ? {
            omittedInstructionPaths: omittedPaths
              .slice(-REPOSITORY_INSTRUCTION_LIMITS.omittedPaths),
            omittedInstructionCount: omittedPaths.length,
            ...(omittedPaths.length > REPOSITORY_INSTRUCTION_LIMITS.omittedPaths
              ? { unidentifiedInstructionOmissionOccurrences: 1 }
              : {}),
          }
        : {}),
      ...(unscannedDirectories.length
        ? {
            unscannedAncestorDirectoryPaths: unscannedDirectories
              .slice(-REPOSITORY_INSTRUCTION_LIMITS.omittedPaths)
              .map((directory) => relativePath(root, directory)),
            unscannedAncestorDirectoryCount: unscannedDirectories.length,
            ...(unscannedDirectories.length > REPOSITORY_INSTRUCTION_LIMITS.omittedPaths
              ? { unidentifiedAncestorScanOmissionOccurrences: 1 }
              : {}),
          }
        : {}),
    };
  }

  async #root(): Promise<string> {
    const root = await realpath(this.workspaceRoot).catch(() => null);
    if (!root) throw new ValidationError("Workspace root is unavailable for repository instruction discovery");
    return root;
  }

  async #load(
    path: string,
    scope: RepositoryInstructionRecord["scope"],
    precedence: number,
  ): Promise<RepositoryInstructionRecord | null> {
    const root = await this.#root();
    const before = await lstat(path).catch(() => null);
    if (!before) return null;
    const relativeInstructionPath = relativePath(root, path);
    const directory = relativePath(root, dirname(path)) || ".";
    const base = {
      protocol: REPOSITORY_INSTRUCTIONS_PROTOCOL,
      path: relativeInstructionPath,
      directory,
      scope,
      precedence,
    } as const;
    if (before.isSymbolicLink() || !before.isFile()) {
      return {
        ...base,
        sha256: null,
        size: before.size,
        completeness: "unavailable",
        reason: before.isSymbolicLink() ? "symbolic-link" : "not-a-regular-file",
        guidance: `Repository instructions are loaded only from regular files inside the workspace. Inspect ${relativeInstructionPath} explicitly if appropriate.`,
      };
    }
    const file = Bun.file(path);
    const fileLimit = scope === "workspace"
      ? REPOSITORY_INSTRUCTION_LIMITS.rootFileBytes
      : REPOSITORY_INSTRUCTION_LIMITS.nestedFileBytes;
    if (before.size > REPOSITORY_INSTRUCTION_LIMITS.digestFileBytes) {
      return {
        ...base,
        sha256: null,
        size: before.size,
        completeness: "unavailable",
        reason: "digest-size-limit",
        guidance: `${relativeInstructionPath} exceeds the ${REPOSITORY_INSTRUCTION_LIMITS.digestFileBytes}-byte automatic digest limit. Read only the necessary bounded pages explicitly.`,
      };
    }
    const hasher = new Bun.CryptoHasher("sha256");
    const retained: Uint8Array[] = [];
    let retainedBytes = 0;
    let observedBytes = 0;
    let scanLimitExceeded = false;
    const reader = file.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        observedBytes += value.byteLength;
        if (observedBytes > REPOSITORY_INSTRUCTION_LIMITS.digestFileBytes) {
          scanLimitExceeded = true;
          await reader.cancel();
          break;
        }
        hasher.update(value);
        if (before.size <= fileLimit) {
          const remaining = Math.max(0, fileLimit - retainedBytes);
          if (remaining > 0) {
            const bounded = value.byteLength <= remaining ? value : value.subarray(0, remaining);
            retained.push(bounded);
            retainedBytes += bounded.byteLength;
          }
        }
      }
    } catch {
      return {
        ...base,
        sha256: null,
        size: before.size,
        completeness: "unavailable",
        reason: "read-failed",
        guidance: `Automatic loading could not read ${relativeInstructionPath}. Inspect its permissions and read it explicitly if appropriate.`,
      };
    } finally {
      reader.releaseLock();
    }
    if (scanLimitExceeded) {
      return {
        ...base,
        sha256: null,
        size: before.size,
        completeness: "unavailable",
        reason: "digest-size-limit",
        guidance: `${relativeInstructionPath} exceeded the automatic digest limit while being read. Inspect it explicitly in bounded pages.`,
      };
    }
    const after = await lstat(path).catch(() => null);
    if (!after || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      return {
        ...base,
        sha256: null,
        size: after?.size ?? null,
        completeness: "unavailable",
        reason: "changed-during-read",
        guidance: `Read ${relativeInstructionPath} again after it stops changing.`,
      };
    }
    const sha256 = hasher.digest("hex");
    if (before.size > fileLimit) {
      return {
        ...base,
        sha256,
        size: before.size,
        completeness: "reference",
        reason: "file-size-limit",
        guidance: `${relativeInstructionPath} exceeds the ${fileLimit}-byte automatic instruction limit. Read it with tools.readFile in bounded pages before changing files in its scope.`,
      };
    }
    const bytes = new Uint8Array(retainedBytes);
    let offset = 0;
    for (const chunk of retained) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        ...base,
        sha256,
        size: before.size,
        completeness: "unavailable",
        reason: "invalid-utf8",
        guidance: `${relativeInstructionPath} is not valid UTF-8 and was not loaded automatically.`,
      };
    }
    const scrubbed = scrubText(content);
    if (encoder.encode(scrubbed).byteLength > fileLimit) {
      return {
        ...base,
        sha256,
        size: before.size,
        completeness: "reference",
        reason: "redacted-content-limit",
        guidance: `${relativeInstructionPath} exceeded the automatic instruction limit after credential redaction. Read the necessary bounded pages explicitly.`,
      };
    }
    return {
      ...base,
      sha256,
      size: before.size,
      completeness: "inline",
      content: scrubbed,
      ...(scrubbed === content ? {} : { redacted: true }),
    };
  }
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ValidationError("Repository instruction path escapes workspace root");
  }
}

function relativePath(root: string, path: string): string {
  assertInside(root, path);
  const value = relative(root, path);
  return value ? value.split(sep).join("/") : ".";
}

function instructionKey(record: RepositoryInstructionRecord): string {
  return `${record.path}\0${record.sha256 ?? `${record.completeness}:${record.reason ?? ""}:${record.size ?? ""}`}`;
}

function asReference(
  record: RepositoryInstructionRecord,
  reason: string,
): RepositoryInstructionRecord {
  const { content: _content, redacted: _redacted, ...metadata } = record;
  return {
    ...metadata,
    completeness: "reference",
    reason,
    guidance: `Read ${record.path} with tools.readFile in bounded pages before changing files in its scope.`,
  };
}

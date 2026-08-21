import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { serviceStatePaths } from "./service-discovery.ts";

export const DEFAULT_PASSIVE_PATH_POLL_INTERVAL_MS = 1_000;
export const MIN_PASSIVE_PATH_POLL_INTERVAL_MS = 10;
export const MAX_PASSIVE_PATH_POLL_INTERVAL_MS = 60_000;
export const MAX_PASSIVE_POLL_PATHS = 16;

export interface PassivePathState {
  readonly path: string;
  readonly status: "missing" | "present" | "unavailable";
  /** Opaque metadata identity used only for change detection. */
  readonly fingerprint: string;
}

export interface PassivePathChange {
  readonly path: string;
  readonly previous: PassivePathState;
  readonly current: PassivePathState;
}

export interface PassivePathPollHandle {
  readonly done: Promise<void>;
  stop(reason?: string): void;
}

export function passiveDiscoveryPaths(workspaceRoot: string): readonly [string, string] {
  const root = resolve(workspaceRoot);
  return Object.freeze([
    join(root, ".agencity", "workspace-id"),
    serviceStatePaths(root).manifestPath,
  ]);
}

/**
 * Polls metadata for a bounded set of exact absolute paths. It never reads file
 * contents, creates state, or performs network requests. The callback runs
 * serially only after a path's lstat identity changes.
 */
export async function startPassivePathPolling(input: {
  readonly paths: readonly string[];
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  readonly onChange: (changes: readonly PassivePathChange[]) => unknown | Promise<unknown>;
}): Promise<PassivePathPollHandle> {
  const intervalMs = input.intervalMs ?? DEFAULT_PASSIVE_PATH_POLL_INTERVAL_MS;
  if (
    !Number.isSafeInteger(intervalMs)
    || intervalMs < MIN_PASSIVE_PATH_POLL_INTERVAL_MS
    || intervalMs > MAX_PASSIVE_PATH_POLL_INTERVAL_MS
  ) {
    throw new TypeError(
      `Passive path poll interval must be from ${MIN_PASSIVE_PATH_POLL_INTERVAL_MS} to ${MAX_PASSIVE_PATH_POLL_INTERVAL_MS}ms`,
    );
  }
  if (input.paths.length < 1 || input.paths.length > MAX_PASSIVE_POLL_PATHS) {
    throw new TypeError(`Passive path polling requires from 1 to ${MAX_PASSIVE_POLL_PATHS} paths`);
  }
  if (input.paths.some(path => !isAbsolute(path)) || new Set(input.paths).size !== input.paths.length) {
    throw new TypeError("Passive path polling requires unique absolute paths");
  }

  const paths = Object.freeze([...input.paths]);
  let previous = await Promise.all(paths.map(inspectPassivePath));
  const controller = new AbortController();
  const abort = (): void => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });

  const done = (async (): Promise<void> => {
    try {
      while (!controller.signal.aborted) {
        await abortableDelay(intervalMs, controller.signal);
        if (controller.signal.aborted) break;
        const current = await Promise.all(paths.map(inspectPassivePath));
        const changes: PassivePathChange[] = [];
        for (let index = 0; index < paths.length; index++) {
          if (current[index]!.fingerprint !== previous[index]!.fingerprint) {
            changes.push({
              path: paths[index]!,
              previous: previous[index]!,
              current: current[index]!,
            });
          }
        }
        previous = current;
        if (changes.length) await input.onChange(Object.freeze(changes));
      }
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
  })();

  return Object.freeze({
    done,
    stop(reason = "Passive path polling stopped"): void {
      controller.abort(new DOMException(reason, "AbortError"));
    },
  });
}

async function inspectPassivePath(path: string): Promise<PassivePathState> {
  try {
    const info = await lstat(path, { bigint: true });
    const type = info.isFile() ? "file"
      : info.isDirectory() ? "directory"
      : info.isSymbolicLink() ? "symlink"
      : "other";
    return Object.freeze({
      path,
      status: "present" as const,
      fingerprint: [
        type,
        info.dev,
        info.ino,
        info.mode,
        info.size,
        info.mtimeNs,
        info.ctimeNs,
      ].join(":"),
    });
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return Object.freeze({ path, status: "missing" as const, fingerprint: "missing" });
    }
    return Object.freeze({
      path,
      status: "unavailable" as const,
      fingerprint: `unavailable:${code ?? "unknown"}`,
    });
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveDelay) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

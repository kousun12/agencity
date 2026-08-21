import { ValidationError } from "../domain/index.ts";
import { observeWorkspace } from "../product/workspace.ts";
import type { ParsedCliArgs } from "../cli-args.ts";
import { ObserverController } from "./controller.ts";
import { agentClientObserverSourceFactory } from "./source-adapter.ts";
import { startObserverServer } from "./server.ts";

const ALLOWED_VALUES = new Set(["workspace", "workspace-root", "port"]);
const ALLOWED_FLAGS = new Set(["help", "version"]);

export function parseObservePort(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ValidationError("observe --port must be a decimal integer from 1 through 65535");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ValidationError("observe --port must be a decimal integer from 1 through 65535");
  }
  return port;
}

export function validateObserveCli(parsed: ParsedCliArgs): {
  readonly workspaceOverride?: string;
  readonly port: number;
} {
  if (parsed.command !== "observe") throw new ValidationError("Expected the observe command");
  if (parsed.positionals.length > 0) {
    throw new ValidationError("observe does not accept task text or positional arguments");
  }
  const unexpectedValue = [...parsed.values.keys()].find(name => !ALLOWED_VALUES.has(name));
  if (unexpectedValue) throw new ValidationError(`observe does not accept --${unexpectedValue}`);
  const unexpectedFlag = [...parsed.flags].find(name => !ALLOWED_FLAGS.has(name));
  if (unexpectedFlag) throw new ValidationError(`observe does not accept --${unexpectedFlag}`);
  if (parsed.flags.has("help") && parsed.flags.has("version")) {
    throw new ValidationError("observe accepts only one of --help or --version");
  }
  const workspace = parsed.values.get("workspace");
  const workspaceRoot = parsed.values.get("workspace-root");
  if (workspace && workspaceRoot) {
    throw new ValidationError("Use either --workspace or --workspace-root, not both");
  }
  const workspaceOverride = workspace ?? workspaceRoot;
  return {
    ...(workspaceOverride === undefined ? {} : { workspaceOverride }),
    port: parseObservePort(parsed.values.get("port")),
  };
}

export async function runObserveCommand(parsed: ParsedCliArgs): Promise<void> {
  const options = validateObserveCli(parsed);
  const workspace = await observeWorkspace({
    ...(options.workspaceOverride === undefined ? {} : { override: options.workspaceOverride }),
  });
  const controller = new ObserverController({
    workspaceRoot: workspace.root,
    sourceFactory: agentClientObserverSourceFactory,
  });
  await controller.start();
  let server;
  try {
    server = await startObserverServer({ controller, port: options.port });
  } catch (error) {
    await controller.stop();
    throw new ValidationError(
      options.port === 0
        ? "Observer loopback server could not bind"
        : `Observer port ${options.port} is unavailable`,
      { cause: error },
    );
  }
  process.stdout.write(`${server.url}\n`);

  await new Promise<void>(resolve => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void server.stop().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

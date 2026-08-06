#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseCliArgs } from "./cli-args.ts";
import { ProtocolServer } from "./protocol/index.ts";
import { Supervisor } from "./runtime/index.ts";
import { TerminalUI } from "./tui/index.ts";

const parsed = parseCliArgs(Bun.argv.slice(2));
const option = (name: string, fallback?: string): string | undefined => parsed.values.get(name) ?? fallback;
const has = (name: string): boolean => parsed.flags.has(name);
const command = parsed.command;

if (command === "help") {
  console.log(`agencity - recoverable Bun/LibSQL agent runtime (trusted local mode)

Commands:
  create [--workspace ID]
  chat --session ID --branch ID TEXT
  cell --session ID --branch ID CODE
  snapshot --session ID --branch ID
  history --session ID --branch ID
  rebuild --session ID --branch ID
  branch --session ID --branch ID --cursor CURSOR [--name NAME]
  tui --session ID --branch ID
  serve [--port 3131]

Global options:
  --state-dir PATH
  --db PATH
  --artifacts PATH
  --workspace-root PATH
  --restart-console-after-cell
  --help

Use -- before positional TEXT/CODE that begins with --.`);
  process.exit(0);
}

const stateDir = resolve(option("state-dir", ".agencity")!);
await mkdir(stateDir, { recursive: true });
const database = resolve(option("db", `${stateDir}/agent.db`)!);
const artifacts = resolve(option("artifacts", `${stateDir}/artifacts`)!);
const workspaceRoot = resolve(option("workspace-root", process.cwd())!);
const supervisor = await Supervisor.open({
  databaseUrl: `file:${database}`,
  artifactDirectory: artifacts,
  workspaceRoot,
  restartConsoleAfterCell: has("restart-console-after-cell"),
});
const sessionId = option("session");
const branchId = option("branch");

try {
  if (command === "create") {
    console.log(JSON.stringify(await supervisor.createSession({ workspaceId: option("workspace", "default")! }), null, 2));
  } else if (command === "chat") {
    required(sessionId, "session");
    required(branchId, "branch");
    await supervisor.appendMessage(sessionId!, branchId!, "user", parsed.positionals.join(" "));
    console.log(JSON.stringify(await supervisor.modelLoop.turn(sessionId!, branchId!), null, 2));
  } else if (command === "cell") {
    required(sessionId, "session");
    required(branchId, "branch");
    console.log(JSON.stringify(await supervisor.executeCell(sessionId!, branchId!, parsed.positionals.join(" ")), null, 2));
  } else if (command === "snapshot") {
    required(sessionId, "session");
    required(branchId, "branch");
    console.log(JSON.stringify(await supervisor.projections.getSnapshot(sessionId!, branchId!), null, 2));
  } else if (command === "history") {
    required(sessionId, "session");
    required(branchId, "branch");
    for (const event of await supervisor.projections.history(sessionId!, branchId!)) console.log(JSON.stringify(event));
  } else if (command === "rebuild") {
    required(sessionId, "session");
    required(branchId, "branch");
    console.log(JSON.stringify(await supervisor.projections.rebuild(sessionId!, branchId!), null, 2));
  } else if (command === "branch") {
    required(sessionId, "session");
    required(branchId, "branch");
    console.log(await supervisor.fork(sessionId!, branchId!, required(option("cursor"), "cursor"), option("name")));
  } else if (command === "tui") {
    required(sessionId, "session");
    required(branchId, "branch");
    await new TerminalUI(supervisor).run(sessionId!, branchId!);
  } else if (command === "serve") {
    const server = new ProtocolServer(supervisor).listen(Number(option("port", "3131")));
    console.log(`Agencity protocol listening on http://${server.hostname}:${server.port} (trusted-local mode)`);
    await new Promise(() => {});
  }
} finally {
  if (command !== "serve") await supervisor.close();
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

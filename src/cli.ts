#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseCliArgs, type ParsedCliArgs } from "./cli-args.ts";
import { AgentRuntimeError, ValidationError, type ModelConfiguration } from "./domain/index.ts";
import { containsCredentialMaterial, scrubText } from "./security/index.ts";
import {
  ProductCatalog,
  chooseNewModel,
  defaultProfilePath,
  deriveDisplayName,
  modelAvailability,
  providerStatuses,
  parseModel,
  resolveWorkspace,
  observeWorkspace,
  workspacePreferenceKey,
  type ProductBranchSummary,
  type ResolvedWorkspace,
  ManagedWorkspaceService,
  decodeManagedServiceConfiguration,
  MANAGED_SERVICE_CONFIG_ENV,
  connectManagedService,
  observeManagedService,
  type ManagedServiceConfiguration,
} from "./product/index.ts";
import { AgentClient, ProtocolServer } from "./protocol/index.ts";
import { Supervisor, type AgentRunResult } from "./runtime/index.ts";
import { TerminalUI } from "./tui/index.ts";

const PRODUCT_COMMANDS = new Set(["product", "new", "resume", "sessions", "run", "goals", "heartbeats", "schedules", "doctor", "config", "service", "agents", "status", "attach", "send", "stop"]);

try {
  if (Bun.argv[2] === "__service-child") await runServiceChild();
  else await main(parseCliArgs(Bun.argv.slice(2)));
} catch (error) {
  const code = error instanceof AgentRuntimeError ? error.code : "CLI_ERROR";
  const message = scrubText(error instanceof Error ? error.message : String(error));
  console.error(`Agencity error [${code}]: ${message}`);
  process.exitCode = 1;
}

async function runServiceChild(): Promise<void> {
  const encoded = process.env[MANAGED_SERVICE_CONFIG_ENV];
  if (!encoded) throw new ValidationError("Managed service child configuration is missing");
  delete process.env[MANAGED_SERVICE_CONFIG_ENV];
  const configuration = decodeManagedServiceConfiguration(encoded);
  const requestedRootIndex = Bun.argv.indexOf("--workspace");
  if (requestedRootIndex >= 0 && resolve(Bun.argv[requestedRootIndex + 1] ?? "") !== resolve(configuration.workspace.root)) {
    throw new ValidationError("Managed service child workspace does not match its configuration");
  }
  const service = await ManagedWorkspaceService.open(configuration, await applicationVersion());
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void service.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await new Promise<void>(() => {});
}

async function main(parsed: ParsedCliArgs): Promise<void> {
  if (parsed.command === "help") { printHelp(); return; }
  if (parsed.command === "version") { await printVersion(); return; }
  assertRuntimeCompatibility();
  const credentialReference = parsed.values.get("credential-ref");
  if (credentialReference && containsCredentialMaterial(credentialReference)) {
    throw new ValidationError("Credential references must be non-secret opaque handles");
  }
  if (PRODUCT_COMMANDS.has(parsed.command)) await runProduct(parsed);
  else await runLegacy(parsed);
}

async function runProduct(parsed: ParsedCliArgs): Promise<void> {
  const option = (name: string): string | undefined => parsed.values.get(name);
  if (option("workspace") && option("workspace-root")) throw new ValidationError("Use either --workspace or --workspace-root, not both");
  const workspaceOverride = option("workspace") ?? option("workspace-root");
  const configuredStateDirectory = option("state-dir");
  const configuredDatabase = option("db");
  if (parsed.command === "doctor") {
    const observed = await observeWorkspace({
      ...(workspaceOverride === undefined ? {} : { override: workspaceOverride }),
      ...(configuredStateDirectory === undefined ? {} : { stateDirectory: configuredStateDirectory }),
    });
    if (observed.workspaceId === null) { await doctorUninitialized(observed, parsed.flags.has("json")); return; }
    const readOnlyWorkspace: ResolvedWorkspace = { ...observed, workspaceId: observed.workspaceId };
    await doctorObserver(managedConfiguration(parsed, readOnlyWorkspace), parsed.flags.has("json"));
    return;
  }
  const workspace = await resolveWorkspace({
    ...(workspaceOverride === undefined ? {} : { override: workspaceOverride }),
    ...(configuredStateDirectory === undefined ? {} : { stateDirectory: configuredStateDirectory }),
    ...(configuredDatabase === undefined ? {} : { legacyDatabasePath: configuredDatabase }),
  });
  const configuration = managedConfiguration(parsed, workspace);
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const prompter = new ProductPrompter(interactive);
  try {
    if (parsed.command === "service") { await serviceCommand(configuration, parsed); return; }

    const connection = await connectManagedService(configuration);
    const client = connection.client;
    if (parsed.command === "config") { await managedConfig(client, parsed); return; }
    if (parsed.command === "sessions") { await managedSessions(client, parsed); return; }
    if (parsed.command === "agents") { printValue(await client.serviceAgents(), parsed.flags.has("json")); return; }
    if (parsed.command === "status") { await managedStatus(client, parsed); return; }
    if (parsed.command === "send") { await managedSend(client, parsed); return; }
    if (parsed.command === "stop") { await managedStop(client, parsed); return; }

    const task = taskFor(parsed);
    const existing = await client.productSessions() as ProductBranchSummary[];
    const forceNew = parsed.command === "new" || parsed.flags.has("new");
    let selection: { sessionId: string; branchId: string };
    let summary: ProductBranchSummary;
    if (forceNew || existing.length === 0) {
      const model = await chooseManagedModel(client, parsed, interactive, prompter);
      const created = await client.createSession(workspace.workspaceId, {
        model,
        sessionName: task ? deriveDisplayName(task) : `New session ${new Date().toISOString().slice(0, 10)}`,
        branchName: "main",
      });
      selection = created;
      await client.productSelect(created.sessionId, created.branchId);
      summary = (await client.productSessions() as ProductBranchSummary[]).find(candidate => candidate.sessionId === created.sessionId && candidate.branchId === created.branchId)!;
    } else {
      if (parsed.flags.has("demo") || option("model")) throw new ValidationError("A resumed branch keeps its original model. Use `agencity new --model ...` or `agencity --new --demo`");
      const target = parsed.command === "resume" || parsed.command === "attach"
        ? parsed.positionals.join(" ").trim() || undefined
        : option("session");
      selection = await client.productSelect(target, option("branch"));
      summary = (await client.productSessions() as ProductBranchSummary[]).find(candidate => candidate.sessionId === selection.sessionId && candidate.branchId === selection.branchId)!;
      await client.resume(selection.sessionId, selection.branchId);
    }

    const providers = await client.modelProviders();
    const available = providers.some(provider => provider.name === summary.model.provider);
    const remediation = available ? null : `Install or configure provider ${summary.model.provider}, then restart the managed service.`;
    printStartup(workspace, summary, available, remediation);
    if (["goals", "heartbeats", "schedules"].includes(parsed.command)) {
      await manageAutonomyClient(client, selection.sessionId, selection.branchId, parsed);
      return;
    }
    if (task) {
      if (!available) throw new ValidationError(`Run blocked: ${remediation}`);
      const goalMode = option("goal") ?? "auto";
      if (!["auto", "current", "create"].includes(goalMode)) throw new ValidationError("--goal must be auto, current, or create");
      const accepted = await client.startRun(selection.sessionId, selection.branchId, { task, goalMode: goalMode as "auto" | "current" | "create" }) as AgentRunResult & { accepted?: boolean };
      if (parsed.flags.has("detach")) {
        console.log(`Run accepted: ${accepted.runId} (detached; the managed service continues after client exit)`);
        return;
      }
      const result = await waitForRun(client, selection.sessionId, selection.branchId, accepted.runId);
      if (result.status === "succeeded") console.log(result.final ?? "");
      else if (result.status === "waiting_for_user") console.log(`[waiting_for_user] ${result.pendingInput?.question ?? result.reason ?? "User input required"}`);
      else console.error(`Run ${result.status}: ${result.reason ?? "no terminal reason recorded"}`);
      if (parsed.command === "run") return;
    }
    if (parsed.command === "attach" || interactive || !task) await attachManagedClient(client, selection.sessionId, selection.branchId);
  } finally {
    // Closing a client is detach-only. The resident service owns durable work.
    prompter.close();
  }
}

function managedConfiguration(parsed: ParsedCliArgs, workspace: ResolvedWorkspace): ManagedServiceConfiguration {
  const option = (name: string): string | undefined => parsed.values.get(name);
  const syncUrl = option("sync-url") ?? process.env.TURSO_DATABASE_URL;
  return {
    workspace,
    databasePath: resolve(option("db") ?? `${workspace.stateDirectory}/agent.db`),
    artifactDirectory: resolve(option("artifacts") ?? `${workspace.stateDirectory}/artifacts`),
    profileDatabasePath: option("profile") ? resolve(option("profile")!) : defaultProfilePath(),
    restartConsoleAfterCell: parsed.flags.has("restart-console-after-cell"),
    sync: {
      ...(syncUrl ? { syncUrl } : {}),
      ...(option("replica") ? { replicaPath: resolve(option("replica")!) } : {}),
      ...(option("credential-ref") ? { credentialReference: option("credential-ref")! } : {}),
      ...(option("sync-interval") ? { intervalMs: Number(option("sync-interval")) } : {}),
    },
  };
}

async function serviceCommand(configuration: ManagedServiceConfiguration, parsed: ParsedCliArgs): Promise<void> {
  const action = parsed.positionals[0] ?? "status";
  if (!["status", "shutdown"].includes(action)) throw new ValidationError("service action must be status or shutdown");
  const observed = await observeManagedService(configuration);
  if (observed.state !== "running" || !observed.manifest) {
    const value = { lifecycle: observed.state === "stopped" ? "stopped" : "conflict", mode: "trusted-local", onDemand: true };
    printValue(value, parsed.flags.has("json"));
    if (action === "shutdown" && observed.state !== "stopped") throw new ValidationError("Service authority is conflicted; refusing unauthenticated shutdown");
    return;
  }
  const client = new AgentClient(observed.manifest.url, observed.manifest.bearerToken);
  printValue(action === "shutdown" ? await client.shutdownService() : await client.serviceStatus(), parsed.flags.has("json"));
}

async function doctorUninitialized(workspace: { root: string; workspaceId: string | null; name: string; stateDirectory: string }, json: boolean): Promise<void> {
  const report = {
    application: await applicationVersion(),
    bun: { version: Bun.version, required: ">=1.2.0", compatible: runtimeCompatible() },
    mode: "trusted-local (not a hostile-code sandbox)",
    observer: "read-only (no workspace initialization, recovery, wake ticks, migrations, or canonical writes)",
    workspace,
    service: { state: "stopped", onDemand: true },
    providers: [{ provider: "echo", usable: true, demo: true }, { provider: "openai", usable: Boolean(process.env.OPENAI_API_KEY), demo: false }],
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log([`Agencity ${report.application} · Bun ${report.bun.version}`, `Workspace: ${workspace.name} (${workspace.root}) [not initialized]`, `Mode: ${report.mode}`, "Service: stopped (started on demand; not an OS boot service)", `Observer: ${report.observer}`].join("\n"));
}

async function doctorObserver(configuration: ManagedServiceConfiguration, json: boolean): Promise<void> {
  const observed = await observeManagedService(configuration);
  const providers = [
    { provider: "echo", usable: true, demo: true },
    { provider: "openai", usable: Boolean(process.env.OPENAI_API_KEY), demo: false },
  ];
  const report = {
    application: await applicationVersion(),
    bun: { version: Bun.version, required: ">=1.2.0", compatible: runtimeCompatible() },
    mode: "trusted-local (not a hostile-code sandbox)",
    observer: "read-only (no recovery, wake ticks, migrations, or canonical writes)",
    workspace: { id: configuration.workspace.workspaceId, name: configuration.workspace.name, root: configuration.workspace.root, stateDirectory: configuration.workspace.stateDirectory },
    service: { state: observed.state, onDemand: true, ...(observed.manifest ? { instanceId: observed.manifest.instanceId, url: observed.manifest.url } : {}) },
    providers,
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log([
    `Agencity ${report.application} · Bun ${report.bun.version} (${report.bun.compatible ? "compatible" : "unsupported"})`,
    `Workspace: ${report.workspace.name} (${report.workspace.root})`,
    `Mode: ${report.mode}`,
    `Service: ${report.service.state} (started on demand; not an OS boot service)`,
    `Observer: ${report.observer}`,
  ].join("\n"));
}

async function managedSessions(client: AgentClient, parsed: ParsedCliArgs): Promise<void> {
  const sessionId = parsed.values.get("session");
  const branchId = parsed.values.get("branch");
  const name = parsed.values.get("name");
  if (name) {
    if (!sessionId) throw new ValidationError("sessions --name requires --session; add --branch to rename only that branch");
    await client.productRename(sessionId, branchId, name);
  }
  const select = parsed.values.get("select");
  if (select) {
    const selected = await client.productSelect(select, branchId);
    if (parsed.flags.has("json")) printValue(selected, true);
    else console.log(`Selected ${selected.sessionId}/${selected.branchId}`);
    return;
  }
  const rows = await client.productSessions() as ProductBranchSummary[];
  if (parsed.flags.has("json")) console.log(JSON.stringify(rows, null, 2));
  else console.log(rows.length ? formatSessions(rows) : "No sessions in this workspace.");
}

async function managedConfig(client: AgentClient, parsed: ParsedCliArgs): Promise<void> {
  const action = parsed.positionals[0];
  if (!action) { printValue(await client.productConfig(), parsed.flags.has("json")); return; }
  if (action === "set-model") {
    const value = parsed.positionals[1];
    if (!value) throw new ValidationError("config set-model requires PROVIDER/MODEL");
    parseModel(value);
    printValue(await client.productSetModel(value), parsed.flags.has("json"));
    return;
  }
  if (action === "clear-model") { printValue(await client.productSetModel(null), parsed.flags.has("json")); return; }
  if (action === "credential-ref") {
    const provider=parsed.positionals[1];const reference=parsed.positionals[2];const label=parsed.positionals.slice(3).join(" ");
    if(!provider||!reference||!label)throw new ValidationError("config credential-ref requires PROVIDER REFERENCE LABEL");
    if(containsCredentialMaterial(reference)||containsCredentialMaterial(label))throw new ValidationError("Credential references and labels must be non-secret opaque identifiers");
    if(!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(reference))throw new ValidationError("Credential references must be opaque handles such as env:OPENAI_API_KEY or keychain:item; raw values are rejected");
    printValue(await client.productCredentialReference(provider,reference,label),parsed.flags.has("json"));return;
  }
  throw new ValidationError(`Unknown config action: ${action}`);
}

async function chooseManagedModel(client: AgentClient, parsed: ParsedCliArgs, interactive: boolean, prompter: ProductPrompter): Promise<ModelConfiguration> {
  const explicit = parsed.values.get("model");
  if (explicit && parsed.flags.has("demo")) throw new ValidationError("Use either --demo or --model, not both");
  if (parsed.flags.has("demo")) return { provider: "echo", model: "echo-1" };
  const providers = await client.modelProviders();
  if (explicit) {
    const model = parseModel(explicit);
    if (model.provider === "echo") throw new ValidationError("Echo is a demo fixture; use --demo so demo behavior is explicit");
    if (!providers.some(provider => provider.name === model.provider)) throw new ValidationError(`Model provider is unavailable: ${model.provider}`);
    await client.productSetModel(explicit);
    return model;
  }
  const configured = await client.productConfig();
  if (configured.defaultModel) {
    const model = parseModel(configured.defaultModel);
    if (model.provider !== "echo" && providers.some(provider => provider.name === model.provider)) return model;
  }
  const real = providers.filter(provider => provider.name !== "echo");
  for (const provider of real) {
    const model = process.env[`${provider.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_MODEL`];
    if (model?.trim()) {
      await client.productSetModel(`${provider.name}/${model.trim()}`);
      return { provider: provider.name, model: model.trim() };
    }
  }
  if (!interactive) throw new ValidationError("No usable model is selected. Pass --model PROVIDER/MODEL after configuring a provider, or use --demo explicitly");
  if (!real.length) {
    const answer = (await prompter.question("No real provider is usable. Start the visibly labeled Echo demo fixture? [y/N] ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") return { provider: "echo", model: "echo-1" };
    throw new ValidationError("No usable provider. Set OPENAI_API_KEY or use --demo only for fixture behavior");
  }
  const modelId = (await prompter.question(`Model ID for ${real[0]!.displayName}: `)).trim();
  if (!modelId) throw new ValidationError("Model ID is required");
  await client.productSetModel(`${real[0]!.name}/${modelId}`);
  return { provider: real[0]!.name, model: modelId };
}

async function managedStatus(client: AgentClient, parsed: ParsedCliArgs): Promise<void> {
  const agents = await client.serviceAgents() as any[];
  const target = parsed.positionals.join(" ").trim();
  const value = target ? resolveAgentTarget(agents, target) : agents;
  printValue(value, parsed.flags.has("json"));
}

async function managedSend(client: AgentClient, parsed: ParsedCliArgs): Promise<void> {
  const [target, ...words] = parsed.positionals;
  const content = words.join(" ").trim();
  if (!target || !content) throw new ValidationError("send requires TARGET MESSAGE");
  const selected = resolveAgentTarget(await client.serviceAgents() as any[], target);
  const event = await client.message(selected.sessionId, selected.branchId, content);
  printValue({ delivered: true, eventId: event.id, sessionId: selected.sessionId, branchId: selected.branchId }, parsed.flags.has("json"));
}

async function managedStop(client: AgentClient, parsed: ParsedCliArgs): Promise<void> {
  const target = parsed.positionals.join(" ").trim();
  if (!target) throw new ValidationError("stop requires TARGET");
  const selected = resolveAgentTarget(await client.serviceAgents() as any[], target);
  printValue(await client.stopSession(selected.sessionId, selected.branchId, "Stopped by user command"), parsed.flags.has("json"));
}

function resolveAgentTarget(rows: any[], target: string): any {
  const matches = rows.filter(row => row.sessionId === target || row.branchId === target || row.name === target);
  if (matches.length !== 1) throw new ValidationError(matches.length ? `Agent target is ambiguous: ${target}` : `Agent target not found: ${target}`);
  return matches[0];
}

async function waitForRun(client: AgentClient, sessionId: string, branchId: string, runId: string): Promise<AgentRunResult> {
  while (true) {
    const result = await client.run(sessionId, branchId, runId);
    if (!["queued", "running"].includes(result.status)) return result;
    await Bun.sleep(50);
  }
}

async function attachManagedClient(client: AgentClient, sessionId: string, branchId: string): Promise<void> {
  const snapshot = await client.snapshot(sessionId, branchId);
  console.log("Agencity trusted-local TUI (managed protocol client)");
  console.log(`Attached at cursor ${snapshot.cursor}. Ctrl-C or /quit detaches; it does not stop durable work.`);
  if (!(process.stdin.isTTY === true && process.stdout.isTTY === true)) {
    await Bun.stdin.text();
    return;
  }
  const controller = new AbortController();
  const detach = (): void => controller.abort();
  process.once("SIGINT", detach);
  try {
    await client.stream(sessionId, branchId, snapshot.cursor, { onEvent: event => console.log(`[${event.type}] ${JSON.stringify(event.payload)}`) }, controller.signal);
  } finally { process.off("SIGINT", detach); }
}

async function manageAutonomyClient(client: AgentClient, sessionId: string, branchId: string, parsed: ParsedCliArgs): Promise<void> {
  const [action, ...rest] = parsed.positionals;
  const print = (value: unknown): void => console.log(JSON.stringify(value, null, 2));
  if (parsed.command === "goals") {
    if (!action) { print(await client.goals(sessionId, branchId)); return; }
    if (action === "create") { const description=rest.join(" ").trim(); if(!description) throw new ValidationError("goals create requires DESCRIPTION"); print(await client.createGoal(sessionId,branchId,description)); return; }
    const current=await client.currentGoal(sessionId,branchId); if(!current) throw new ValidationError("No current goal");
    if(action==="pause") print(await client.pauseGoal(sessionId,branchId,current.goalId)); else if(action==="resume") print(await client.resumeGoal(sessionId,branchId,current.goalId)); else if(action==="clear") print(await client.clearGoal(sessionId,branchId,current.goalId)); else if(action==="complete") print(await client.requestGoalCompletion(sessionId,branchId,current.goalId)); else throw new ValidationError("goals action must be create, pause, resume, clear, or complete"); return;
  }
  if(parsed.command==="heartbeats"){
    const items=await client.heartbeats(sessionId,branchId); if(!action){print(items);return;} if(action==="create"){const intervalMs=Number(rest.shift());if(!Number.isSafeInteger(intervalMs)||intervalMs<1)throw new ValidationError("heartbeats create requires positive INTERVAL_MS");print(await client.createHeartbeat(sessionId,branchId,{intervalMs,...(rest.length?{prompt:rest.join(" ")}:{})}));return;} const item=items[Number(rest[0])-1];if(!item)throw new ValidationError("Heartbeat number not found");if(action==="pause")print(await client.pauseHeartbeat(item.heartbeatId));else if(action==="resume")print(await client.resumeHeartbeat(item.heartbeatId));else if(action==="clear")print(await client.cancelHeartbeat(item.heartbeatId));else throw new ValidationError("heartbeats action must be create, pause, resume, or clear");return;
  }
  const items=await client.schedules(sessionId,branchId);if(!action){print(items);return;}if(action==="once"){const at=rest.shift();const prompt=rest.join(" ").trim();if(!at||!prompt)throw new ValidationError("schedules once requires ISO_TIME PROMPT");print(await client.createSchedule(sessionId,branchId,{at,prompt}));return;}if(action==="every"){const intervalMs=Number(rest.shift());const prompt=rest.join(" ").trim();if(!Number.isSafeInteger(intervalMs)||intervalMs<1||!prompt)throw new ValidationError("schedules every requires INTERVAL_MS PROMPT");print(await client.createSchedule(sessionId,branchId,{intervalMs,prompt}));return;}const item=items[Number(rest[0])-1];if(!item)throw new ValidationError("Schedule number not found");if(action==="pause")print(await client.pauseSchedule(item.scheduleId));else if(action==="resume")print(await client.resumeSchedule(item.scheduleId));else if(action==="clear")print(await client.clearSchedule(item.scheduleId));else throw new ValidationError("schedules action must be once, every, pause, resume, or clear");
}

function printValue(value: unknown, json: boolean): void { console.log(json ? JSON.stringify(value, null, 2) : typeof value === "string" ? value : JSON.stringify(value, null, 2)); }

async function manageAutonomy(supervisor: Supervisor, sessionId: string, branchId: string, parsed: ParsedCliArgs): Promise<void> {
  const [action, ...rest] = parsed.positionals;
  const print = (value: unknown): void => console.log(JSON.stringify(value, null, 2));
  if (parsed.command === "goals") {
    if (!action) { print(await supervisor.goals.list(sessionId, branchId)); return; }
    if (action === "create") { const description = rest.join(" ").trim(); if (!description) throw new ValidationError("goals create requires DESCRIPTION"); print(await supervisor.goals.create(sessionId, branchId, description)); return; }
    const current = await supervisor.goals.current(sessionId, branchId); if (!current) throw new ValidationError("No current goal");
    if (action === "pause") print(await supervisor.goals.pause(sessionId, branchId, current.goalId));
    else if (action === "resume") print(await supervisor.goals.resume(sessionId, branchId, current.goalId));
    else if (action === "clear") print(await supervisor.goals.clear(sessionId, branchId, current.goalId));
    else if (action === "complete") print(await supervisor.goals.requestCompletion(sessionId, branchId, current.goalId));
    else throw new ValidationError("goals action must be create, pause, resume, clear, or complete");
    return;
  }
  if (parsed.command === "heartbeats") {
    const items = await supervisor.heartbeats.list(sessionId, branchId);
    if (!action) { print(items.map((item, index) => ({ number: index + 1, ...item }))); return; }
    if (action === "create") { const intervalMs = Number(rest.shift()); if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new ValidationError("heartbeats create requires positive INTERVAL_MS"); print(await supervisor.heartbeats.create(sessionId, branchId, { intervalMs, ...(rest.length ? { prompt: rest.join(" ") } : {}) })); return; }
    const number = Number(rest[0]); const item = items[number - 1]; if (!item) throw new ValidationError("Heartbeat number not found");
    if (action === "pause") print(await supervisor.heartbeats.pause(item.heartbeatId));
    else if (action === "resume") print(await supervisor.heartbeats.resume(item.heartbeatId));
    else if (action === "clear") print(await supervisor.heartbeats.cancel(item.heartbeatId));
    else throw new ValidationError("heartbeats action must be create, pause, resume, or clear");
    return;
  }
  const items = await supervisor.schedules.list(sessionId, branchId);
  if (!action) { print(items.map((item, index) => ({ number: index + 1, ...item }))); return; }
  if (action === "once") { const at = rest.shift(); const prompt = rest.join(" ").trim(); if (!at || !prompt) throw new ValidationError("schedules once requires ISO_TIME PROMPT"); print(await supervisor.schedules.create(sessionId, branchId, { at, prompt })); return; }
  if (action === "every") { const intervalMs = Number(rest.shift()); const prompt = rest.join(" ").trim(); if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || !prompt) throw new ValidationError("schedules every requires INTERVAL_MS PROMPT"); print(await supervisor.schedules.create(sessionId, branchId, { intervalMs, prompt })); return; }
  const number = Number(rest[0]); const item = items[number - 1]; if (!item) throw new ValidationError("Schedule number not found");
  if (action === "pause") print(await supervisor.schedules.pause(item.scheduleId));
  else if (action === "resume") print(await supervisor.schedules.resume(item.scheduleId));
  else if (action === "clear") print(await supervisor.schedules.clear(item.scheduleId));
  else throw new ValidationError("schedules action must be once, every, pause, resume, or clear");
}

async function selectExisting(
  catalog: ProductCatalog,
  candidates: ProductBranchSummary[],
  target: string | undefined,
  branchId: string | undefined,
  interactive: boolean,
  prompter: ProductPrompter,
): Promise<{ sessionId: string; branchId: string }> {
  try { return await catalog.select(target, branchId); }
  catch (error) {
    const ambiguous = error instanceof ValidationError && /ambiguous|Multiple sessions/.test(error.message);
    if (!interactive || branchId || !ambiguous) throw error;
    const choices = target
      ? candidates.filter(candidate => candidate.sessionId === target || candidate.sessionName === target || candidate.branchId === target || candidate.branchName === target)
      : candidates.filter(candidate => candidate.root && candidate.initialBranch);
    console.log(formatSessions(choices));
    const answer = (await prompter.question("Choose session/branch number, name, or ID: ")).trim();
    const byNumber = choices[Number(answer) - 1];
    return byNumber ? catalog.select(byNumber.sessionId, byNumber.branchId) : catalog.select(answer);
  }
}

async function sessions(catalog: ProductCatalog, parsed: ParsedCliArgs): Promise<void> {
  const sessionId = parsed.values.get("session");
  const branchId = parsed.values.get("branch");
  const name = parsed.values.get("name");
  if (name) {
    if (!sessionId) throw new ValidationError("sessions --name requires --session; add --branch to rename only that branch");
    await catalog.rename(sessionId, branchId, name);
  }
  const select = parsed.values.get("select");
  if (select) {
    const selected = await catalog.select(select, branchId);
    console.log(parsed.flags.has("json") ? JSON.stringify(selected, null, 2) : `Selected ${selected.sessionId}/${selected.branchId}`);
    return;
  }
  const rows = await catalog.list();
  if (parsed.flags.has("json")) console.log(JSON.stringify(rows, null, 2));
  else console.log(rows.length ? formatSessions(rows) : "No sessions in this workspace.");
}

function formatSessions(rows: readonly ProductBranchSummary[]): string {
  return rows.map((row, index) => [
    `${index + 1}) ${row.sessionName} / ${row.branchName}`,
    `   ${row.status} · ${row.model.provider}/${row.model.model} · updated ${row.updatedAt}`,
    `   task: ${row.taskSummary ?? "(none)"} · goals ${row.activeGoals} · unresolved ${row.unresolvedWork}`,
    `   ids: ${row.sessionId}/${row.branchId}`,
  ].join("\n" )).join("\n");
}

async function config(supervisor: Supervisor, workspace: ResolvedWorkspace, parsed: ParsedCliArgs, interactive: boolean, prompter: ProductPrompter): Promise<void> {
  const action = parsed.positionals[0];
  if (!action) {
    const model = await supervisor.profile.getPreference(workspacePreferenceKey(workspace.workspaceId, "model"));
    const references = (await supervisor.profile.listCredentialReferences()).map(({ reference, provider, label, createdAt, updatedAt }) => ({ reference, provider, label, createdAt, updatedAt }));
    const value = { workspaceId: workspace.workspaceId, defaultModel: typeof model?.value === "string" ? model.value : null, credentialReferences: references };
    console.log(parsed.flags.has("json") ? JSON.stringify(value, null, 2) : [
      `Workspace model: ${value.defaultModel ?? "not selected"}`,
      `Credential references: ${references.length ? references.map(item => `${item.provider}:${item.label} (${item.reference})`).join(", ") : "none"}`,
      "Raw credentials are never stored by this command.",
    ].join("\n"));
    return;
  }
  if (action === "set-model") {
    const requested = parsed.positionals[1] ?? parsed.values.get("model");
    if (!requested) throw new ValidationError("config set-model requires PROVIDER/MODEL");
    await chooseNewModel({ supervisor, workspaceId: workspace.workspaceId, explicitModel: requested, demo: false, interactive, prompt: question => prompter.question(question) });
    console.log(`Saved non-secret workspace model preference: ${requested}`);
    return;
  }
  if (action === "clear-model") {
    await supervisor.profile.setPreference(workspacePreferenceKey(workspace.workspaceId, "model"), null);
    console.log("Cleared workspace model preference.");
    return;
  }
  if (action === "credential-ref") {
    const provider = parsed.positionals[1]; const reference = parsed.positionals[2]; const label = parsed.positionals.slice(3).join(" ");
    if (!provider || !reference || !label) throw new ValidationError("config credential-ref requires PROVIDER REFERENCE LABEL");
    if (containsCredentialMaterial(reference) || containsCredentialMaterial(label)) throw new ValidationError("Credential references and labels must be non-secret opaque identifiers");
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(reference)) throw new ValidationError("Credential references must be opaque handles such as env:OPENAI_API_KEY or keychain:item; raw values are rejected");
    await supervisor.profile.putCredentialReference({ reference, provider, label, metadata: { kind: "opaque-handle" } });
    console.log(`Saved opaque credential reference ${reference} for ${provider}; no credential value was stored.`);
    return;
  }
  throw new ValidationError(`Unknown config action: ${action}`);
}

async function doctor(supervisor: Supervisor, workspace: ResolvedWorkspace, json: boolean): Promise<void> {
  const unknown = (await supervisor.storage.listOutbox(["unknown"])).length;
  const pending = (await supervisor.storage.listOutbox(["pending", "running"])).length;
  const sync = await supervisor.sync.status();
  const report = {
    application: await applicationVersion(),
    bun: { version: Bun.version, required: ">=1.2.0", compatible: runtimeCompatible() },
    mode: "trusted-local (not a hostile-code sandbox)",
    workspace: { id: workspace.workspaceId, name: workspace.name, root: workspace.root, stateDirectory: workspace.stateDirectory },
    providers: providerStatuses(supervisor),
    recovery: { pendingEffects: pending, unknownEffects: unknown, state: unknown ? "attention-required" : "ready" },
    placement: { relational: supervisor.storage.name, artifacts: "local-cas", distributedCoordination: supervisor.storage.capabilities.distributedLeases },
    sync: { configured: supervisor.sync.capabilities.configured, lifecycle: sync.replica.lifecycle, lastError: sync.replica.lastError },
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log([
    `Agencity ${report.application} · Bun ${report.bun.version} (${report.bun.compatible ? "compatible" : "unsupported"})`,
    `Workspace: ${workspace.name} (${workspace.root})`,
    `Mode: ${report.mode}`,
    ...report.providers.map(provider => `Provider ${provider.provider}: ${provider.usable ? provider.demo ? "usable demo fixture" : "usable" : `unavailable — ${provider.remediation}`}`),
    `Recovery: ${pending} pending/running, ${unknown} unknown`,
    `Sync: ${report.sync.configured ? report.sync.lifecycle : "local only"}`,
  ].join("\n"));
}

async function runLegacy(parsed: ParsedCliArgs): Promise<void> {
  const option = (name: string, fallback?: string): string | undefined => parsed.values.get(name) ?? fallback;
  const stateDir = resolve(option("state-dir", ".agencity")!);
  await mkdir(stateDir, { recursive: true });
  const workspace: ResolvedWorkspace = { root: resolve(option("workspace-root", process.cwd())!), workspaceId: option("workspace", "default")!, name: option("workspace", "default")!, stateDirectory: stateDir };
  const supervisor = await openSupervisor(parsed, workspace, true);
  const sessionId = option("session"); const branchId = option("branch"); const command = parsed.command;
  try {
    if (command === "create") console.log(JSON.stringify(await supervisor.createSession({ workspaceId: workspace.workspaceId }), null, 2));
    else if (command === "chat") { required(sessionId, "session"); required(branchId, "branch"); await supervisor.appendMessage(sessionId!, branchId!, "user", parsed.positionals.join(" ")); console.log(JSON.stringify(await supervisor.modelLoop.turn(sessionId!, branchId!), null, 2)); }
    else if (command === "cell") { required(sessionId, "session"); required(branchId, "branch"); console.log(JSON.stringify(await supervisor.executeCell(sessionId!, branchId!, parsed.positionals.join(" ")), null, 2)); }
    else if (command === "snapshot") { required(sessionId, "session"); required(branchId, "branch"); console.log(JSON.stringify(await supervisor.projections.getSnapshot(sessionId!, branchId!), null, 2)); }
    else if (command === "history") { required(sessionId, "session"); required(branchId, "branch"); for (const event of await supervisor.projections.history(sessionId!, branchId!)) console.log(JSON.stringify(event)); }
    else if (command === "rebuild") { required(sessionId, "session"); required(branchId, "branch"); console.log(JSON.stringify(await supervisor.projections.rebuild(sessionId!, branchId!), null, 2)); }
    else if (command === "branch") { required(sessionId, "session"); required(branchId, "branch"); console.log(await supervisor.fork(sessionId!, branchId!, required(option("cursor"), "cursor"), option("name"))); }
    else if (command === "sync") console.log(JSON.stringify(await supervisor.sync.sync("manual"), null, 2));
    else if (command === "sync-push") console.log(JSON.stringify(await supervisor.sync.push(), null, 2));
    else if (command === "sync-pull") console.log(JSON.stringify(await supervisor.sync.pull(), null, 2));
    else if (command === "sync-checkpoint") console.log(JSON.stringify(await supervisor.sync.checkpoint(), null, 2));
    else if (command === "sync-stats") console.log(JSON.stringify(await supervisor.sync.stats(), null, 2));
    else if (command === "sync-status") console.log(JSON.stringify(await supervisor.sync.status(), null, 2));
    else if (command === "conflicts") console.log(JSON.stringify(await supervisor.sync.conflicts("unresolved"), null, 2));
    else if (command === "delete-data") { const scope = required(option("scope"), "scope") as "workspace"|"session"|"profile"; const scopeId = required(option("scope-id"), "scope-id"); console.log(JSON.stringify(await supervisor.deleteOwnedData({ scopeKind: scope, scopeId, requestedBy: "cli-owner", confirmation: required(option("confirmation"), "confirmation"), ...(option("receipt-dir") ? { receiptDirectory: resolve(option("receipt-dir")!) } : {}) }), null, 2)); }
    else if (command === "tui") { required(sessionId, "session"); required(branchId, "branch"); await new TerminalUI(supervisor).run(sessionId!, branchId!); }
    else if (command === "serve") { const server = new ProtocolServer(supervisor).listen(Number(option("port", "3131"))); console.log(`Agencity protocol listening on http://${server.hostname}:${server.port} (trusted-local mode)`); await new Promise(() => {}); }
  } finally { if (command !== "serve") await supervisor.close(); }
}

async function openSupervisor(parsed: ParsedCliArgs, workspace: ResolvedWorkspace, legacy: boolean): Promise<Supervisor> {
  const option = (name: string): string | undefined => parsed.values.get(name);
  const stateDir = workspace.stateDirectory;
  const database = resolve(option("db") ?? `${stateDir}/agent.db`);
  const artifacts = resolve(option("artifacts") ?? `${stateDir}/artifacts`);
  const syncUrl = option("sync-url") ?? process.env.TURSO_DATABASE_URL;
  const profile = option("profile") ? resolve(option("profile")!) : legacy ? undefined : defaultProfilePath();
  return Supervisor.open({
    databaseUrl: `file:${database}`,
    artifactDirectory: artifacts,
    artifactDirectoryOwnership: parsed.flags.has("exclusive-artifacts") ? "exclusive" : "shared",
    workspaceRoot: workspace.root,
    restartConsoleAfterCell: parsed.flags.has("restart-console-after-cell"),
    ...(profile ? { profileDatabaseUrl: `file:${profile}` } : {}),
    sync: {
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.name,
      ...(syncUrl ? { syncUrl } : {}),
      ...(option("replica") ? { replicaUrl: `file:${resolve(option("replica")!)}` } : {}),
      ...(process.env.TURSO_AUTH_TOKEN ? { authToken: process.env.TURSO_AUTH_TOKEN } : {}),
      ...(option("credential-ref") ? { credentialReference: option("credential-ref")! } : {}),
      ...(option("sync-interval") ? { intervalMs: Number(option("sync-interval")) } : {}),
    },
  });
}

function taskFor(parsed: ParsedCliArgs): string | undefined {
  if (["resume", "attach", "goals", "heartbeats", "schedules"].includes(parsed.command)) return undefined;
  const task = parsed.positionals.join(" ").trim();
  if (parsed.command === "run" && !task) throw new ValidationError("run requires TASK");
  return task || undefined;
}

function printStartup(workspace: ResolvedWorkspace, session: ProductBranchSummary, providerUsable: boolean, remediation: string | null): void {
  const demoLabel = session.model.provider === "echo" ? " [DEMO FIXTURE]" : "";
  console.log([
    "Agencity product session",
    `Workspace: ${workspace.name} (${workspace.root})`,
    `Session: ${session.sessionName} / ${session.branchName}`,
    `Model: ${session.model.provider}/${session.model.model}${demoLabel}${providerUsable ? "" : " [UNAVAILABLE]"}`,
    `Run state: ${providerUsable ? session.status : "blocked by provider configuration"}`,
    "Mode: trusted-local; generated code has this process's OS authority (not sandboxed)",
    ...(!providerUsable && remediation ? [`Remediation: ${remediation}`] : []),
  ].join("\n"));
}

class ProductPrompter {
  #readline: ReadlineInterface | null = null;
  constructor(readonly enabled: boolean) {}
  question(question: string): Promise<string> {
    if (!this.enabled) throw new ValidationError("Interactive selection requires a terminal");
    this.#readline ??= createInterface({ input, output });
    return this.#readline.question(question);
  }
  close(): void { this.#readline?.close(); this.#readline = null; }
}

function required<T>(value: T | undefined, name: string): T { if (value === undefined) throw new ValidationError(`--${name} is required`); return value; }
function runtimeCompatible(): boolean { const [major = 0, minor = 0] = Bun.version.split(".").map(Number); return major > 1 || major === 1 && minor >= 2; }
function assertRuntimeCompatibility(): void { if (!runtimeCompatible()) throw new ValidationError(`Bun ${Bun.version} is unsupported; Agencity requires Bun >=1.2.0`); }
async function applicationVersion(): Promise<string> { const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json() as { version: string }; return pkg.version; }
async function printVersion(): Promise<void> { console.log(`agencity ${await applicationVersion()}
Bun ${Bun.version} (supported: >=1.2.0)`); }

function printHelp(): void {
  console.log(`agencity - terminal-first durable agent runtime (trusted-local mode)

Product commands:
  agencity [TASK]                 Create/resume and open the product
  agencity --new [TASK]           Create a distinct root session
  agencity new [TASK]             Create a distinct root session
  agencity resume [NAME|ID]       Resume durable work (no IDs required)
  agencity sessions               List named workspace sessions and branches
  agencity goals [ACTION]         List/create/pause/resume/clear/complete the current goal
  agencity heartbeats [ACTION]    List/create or manage a numbered user heartbeat
  agencity schedules [ACTION]     List/create or manage a numbered once/interval schedule
  agencity sessions --select NAME Persist an explicit recent selection
  agencity sessions --session ID --name NAME [--branch ID]
  agencity run TASK               Run through the resident service and wait
  agencity run --detach TASK      Return after durable acceptance; work continues
  agencity agents                List resident root agents and worker state
  agencity status [NAME|ID]       Inspect all or one managed agent
  agencity attach [NAME|ID]       Attach through snapshot/cursor events; Ctrl-C detaches
  agencity send NAME|ID MESSAGE   Commit user steering to a named session
  agencity stop NAME|ID           Durably request run cancellation
  agencity service status        Inspect the on-demand workspace service
  agencity service shutdown      Gracefully drain; sessions remain durable
  --goal auto|current|create      Explicit goal selection (default: auto; never inferred from prose)
  agencity doctor [--json]        Check runtime, providers, recovery, and sync
  agencity config [--json]        Inspect non-secret preferences/references
  agencity config set-model PROVIDER/MODEL
  agencity config credential-ref PROVIDER HANDLE LABEL

Product options:
  --workspace PATH                Override discovered repository root
  --model PROVIDER/MODEL          Select a configured real provider for a new root
  --demo                          Explicitly use the Echo demo/test fixture
  --state-dir PATH --profile PATH --new --detach --json --version --help
  The service starts on demand; it is not installed as an OS boot service.

Advanced compatibility commands:
  create, chat, cell, snapshot, history, rebuild, branch, tui, serve
  sync, sync-push, sync-pull, sync-checkpoint, sync-stats, sync-status, conflicts
  delete-data --scope workspace|session|profile --scope-id ID --confirmation 'DELETE <scope> <id>'

Advanced options retain --session, --branch, --db, --artifacts, --workspace-root,
--sync-url, --replica, --credential-ref, --sync-interval, and recovery flags.
Use agencity -- TASK to force command-like text (for example: -- run tests)
through the product task route. Echo is never selected by the product route unless
--demo or a visibly labeled interactive choice is used. Provider credentials
remain supervisor-side.`);
}

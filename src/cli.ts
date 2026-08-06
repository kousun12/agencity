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
  resolveWorkspace,
  workspacePreferenceKey,
  type ProductBranchSummary,
  type ResolvedWorkspace,
} from "./product/index.ts";
import { ProtocolServer } from "./protocol/index.ts";
import { Supervisor } from "./runtime/index.ts";
import { TerminalUI } from "./tui/index.ts";

const PRODUCT_COMMANDS = new Set(["product", "new", "resume", "sessions", "run", "doctor", "config"]);

try {
  await main(parseCliArgs(Bun.argv.slice(2)));
} catch (error) {
  const code = error instanceof AgentRuntimeError ? error.code : "CLI_ERROR";
  const message = scrubText(error instanceof Error ? error.message : String(error));
  console.error(`Agencity error [${code}]: ${message}`);
  process.exitCode = 1;
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
  const workspace = await resolveWorkspace({
    ...(workspaceOverride === undefined ? {} : { override: workspaceOverride }),
    ...(configuredStateDirectory === undefined ? {} : { stateDirectory: configuredStateDirectory }),
    ...(configuredDatabase === undefined ? {} : { legacyDatabasePath: configuredDatabase }),
  });
  await mkdir(workspace.stateDirectory, { recursive: true });
  const supervisor = await openSupervisor(parsed, workspace, false);
  const catalog = new ProductCatalog(supervisor, workspace.workspaceId);
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const prompter = new ProductPrompter(interactive);
  try {
    if (parsed.command === "doctor") { await doctor(supervisor, workspace, parsed.flags.has("json")); return; }
    if (parsed.command === "config") { await config(supervisor, workspace, parsed, interactive, prompter); return; }
    if (parsed.command === "sessions") { await sessions(catalog, parsed); return; }

    const task = taskFor(parsed);
    const existing = await catalog.list();
    const forceNew = parsed.command === "new" || parsed.flags.has("new");
    let selection: { sessionId: string; branchId: string };
    let summary: ProductBranchSummary;
    if (forceNew || existing.length === 0) {
      const model = await chooseNewModel({
        supervisor,
        workspaceId: workspace.workspaceId,
        ...(option("model") === undefined ? {} : { explicitModel: option("model")! }),
        demo: parsed.flags.has("demo"),
        interactive,
        prompt: question => prompter.question(question),
      });
      const created = await supervisor.createSession({
        workspaceId: workspace.workspaceId,
        model,
        sessionName: task ? deriveDisplayName(task) : `New session ${new Date().toISOString().slice(0, 10)}`,
        branchName: "main",
      });
      selection = created;
      await catalog.remember(created);
      summary = (await catalog.list()).find(candidate => candidate.sessionId === created.sessionId && candidate.branchId === created.branchId)!;
    } else {
      if (parsed.flags.has("demo") || option("model")) {
        throw new ValidationError("A resumed branch keeps its original model. Use `agencity new --model ...` or `agencity --new --demo`");
      }
      const target = parsed.command === "resume" ? parsed.positionals.join(" ").trim() || undefined : option("session");
      selection = await selectExisting(catalog, existing, target, option("branch"), interactive, prompter);
      summary = (await catalog.list()).find(candidate => candidate.sessionId === selection.sessionId && candidate.branchId === selection.branchId)!;
      await supervisor.resume(selection.sessionId, selection.branchId);
    }

    const availability = modelAvailability(supervisor, summary.model);
    printStartup(workspace, summary, availability.usable, availability.remediation);
    if (task) {
      await supervisor.appendMessage(selection.sessionId, selection.branchId, "user", task);
      if (!availability.usable) {
        const reason = availability.remediation ?? `provider ${summary.model.provider} is unavailable`;
        if (parsed.command === "run") throw new ValidationError(`Run blocked: ${reason}`);
        console.error(`Run blocked: ${reason}`);
      } else {
        const result = await supervisor.modelLoop.turn(selection.sessionId, selection.branchId);
        if (result.outcome === "succeeded") console.log(result.message ?? "");
        else console.error(`Run ${result.outcome}: ${result.error ?? "model call did not complete"}`);
      }
    }
    if (parsed.command === "run") return;
    prompter.close();
    await new TerminalUI(supervisor).run(selection.sessionId, selection.branchId);
  } finally {
    prompter.close();
    await supervisor.close();
  }
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
  if (parsed.command === "resume") return undefined;
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
  agencity sessions --select NAME Persist an explicit recent selection
  agencity sessions --session ID --name NAME [--branch ID]
  agencity run TASK               Commit one recoverable model turn and exit
  agencity doctor [--json]        Check runtime, providers, recovery, and sync
  agencity config [--json]        Inspect non-secret preferences/references
  agencity config set-model PROVIDER/MODEL
  agencity config credential-ref PROVIDER HANDLE LABEL

Product options:
  --workspace PATH                Override discovered repository root
  --model PROVIDER/MODEL          Select a configured real provider for a new root
  --demo                          Explicitly use the Echo demo/test fixture
  --state-dir PATH --profile PATH --new --json --version --help

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

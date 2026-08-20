#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseCliArgs, type ParsedCliArgs } from "./cli-args.ts";
import { buildDataDeleteConfirmation, parseAdvancedArgv, type AdvancedCommandPath } from "./cli/advanced.ts";
import { cliHelpColorEnabled, renderCliHelp } from "./cli/help.ts";
import { createCliErrorEnvelope, createCliSuccessEnvelope, formatDuration, planCliOutput, type CliJsonValue } from "./cli/output.ts";
import { CliRunInterruptCoordinator } from "./cli/run-interrupt.ts";
import {
  AgentRuntimeError,
  STANDARD_UNVERIFIED_REASONING_LEVELS,
  ValidationError,
  assertReasoningSelection,
  normalizeReasoningEffort,
  type HarnessKind,
  type HarnessScope,
  type JsonValue,
  type ModelConfiguration,
  type ReasoningEffort,
} from "./domain/index.ts";
import { containsBrokeredSecret, inspectModelCredentialStatuses, modelCredentialPathForProfile, scrubText } from "./security/index.ts";
import {
  ProductCatalog,
  chooseManagedModel,
  chooseNewModel,
  defaultProfilePath,
  deriveDisplayName,
  formatModel,
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
  type ManagedServiceStatus,
} from "./product/index.ts";
import { AgentClient, InProcessProtocolTransport, ProtocolClientError, ProtocolServer } from "./protocol/index.ts";
import {
  Supervisor,
  type AgentRunResult,
  type LearningActivity,
  type LearningHistoryView,
  type LearningStatusView,
  type ModelContractDiagnosticsView,
  type SelectedAgentToolCapabilityView,
} from "./runtime/index.ts";
import { TerminalUI } from "./tui/index.ts";
import { OpenTerminalUI } from "./tui/opentui.ts";
import {
  ProductPrompter,
  ProductPromptCancelledError,
} from "./tui/product-prompter.ts";

const REQUIRED_BUN_VERSION = "1.3.13";
const PRODUCT_COMMANDS = new Set(["product", "new", "resume", "sessions", "run", "branch", "history", "tree", "goals", "heartbeats", "schedules", "doctor", "config", "service", "agents", "status", "attach", "send", "stop", "unknown", "reconcile", "profile", "refine", "skills", "context", "compact"]);

let activeParsed: ParsedCliArgs | null = null;
let canonicalHint: { path: AdvancedCommandPath; json: boolean } | null = null;
try {
  if (Bun.argv[2] === "__service-child") await runServiceChild();
  else {
    const argv = Bun.argv.slice(2);
    const recognized = parseAdvancedArgv(argv);
    if (recognized.kind === "advanced" && recognized.source === "canonical") canonicalHint = { path: recognized.path, json: recognized.args.some((argument) => argument === "--json" || argument.startsWith("--json=")) };
    activeParsed = parseCliArgs(argv);
    await main(activeParsed);
  }
} catch (error) {
  if (error instanceof ProductPromptCancelledError) {
    // The raw picker restores the caller's input ownership. At the process
    // boundary there is no next owner, so release stdin before exiting.
    process.stdin.pause();
    process.exitCode = 0;
  } else {
    const canonical = activeParsed?.advanced?.source === "canonical"
      ? { path: activeParsed.advanced.path, json: activeParsed.flags.has("json") }
      : canonicalHint;
    const code = error instanceof AgentRuntimeError ? error.code : canonical ? "VALIDATION_ERROR" : "CLI_ERROR";
    const message = scrubText(error instanceof Error ? error.message : String(error));
    if (canonical || (activeParsed?.command === "run" && activeParsed.flags.has("json"))) {
      const command = canonical?.path ?? "run";
      const plan = planCliOutput(createCliErrorEnvelope({ command, code, message }), canonical ? (canonical.json ? "json" : "human") : "json");
      if (plan.stdout !== null) process.stdout.write(`${plan.stdout}\n`);
      if (plan.stderr !== null) process.stderr.write(`${plan.stderr}\n`);
      process.exitCode = plan.exitCode;
    } else {
      console.error(`Agencity error [${code}]: ${message}`);
      process.exitCode = 1;
    }
  }
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
  if (credentialReference && containsBrokeredSecret(credentialReference)) {
    throw new ValidationError("Credential references cannot contain a registered credential value");
  }
  if (parsed.advanced) await runAdvanced(parsed);
  else if (PRODUCT_COMMANDS.has(parsed.command)) await runProduct(parsed);
  else throw new ValidationError(`Unknown CLI command: ${parsed.command}`);
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
  const prompter = new ProductPrompter({ enabled: interactive });
  try {
    if (parsed.command === "service") { await serviceCommand(configuration, parsed); return; }

    const connection = await connectManagedService(configuration);
    const client = connection.client;
    if (parsed.command === "config") { await managedConfig(client, parsed); return; }
    if (parsed.command === "sessions") { await managedSessions(client, parsed); return; }
    if (parsed.command === "agents") { await printValue(await client.serviceAgents(), parsed.flags.has("json")); return; }
    if (parsed.command === "tree") {
      const selected = await client.productSelect();
      await printValue(await client.agents(selected.sessionId, selected.branchId), parsed.flags.has("json"));
      return;
    }
    if (parsed.command === "status") { await managedStatus(client, parsed); return; }
    if (parsed.command === "send") { await managedSend(client, parsed); return; }
    if (parsed.command === "stop") { await managedStop(client, parsed); return; }

    const task = taskFor(parsed);
    const existing = await client.productSessions() as ProductBranchSummary[];
    const reconciliationCommand = parsed.command === "unknown" || parsed.command === "reconcile";
    if (reconciliationCommand && existing.length === 0) throw new ValidationError("No retained session is available for effect reconciliation");
    if ((parsed.command === "branch" || parsed.command === "history") && existing.length === 0) throw new ValidationError(`No retained session is available for ${parsed.command}`);
    if ((parsed.command === "profile" || parsed.command === "refine") && existing.length === 0) throw new ValidationError(`No retained session is available for ${parsed.command === "profile" ? "profile management" : "learning activity"}`);
    if (parsed.command === "skills" && existing.length === 0) throw new ValidationError("No retained session is available for skill management");
    if ((parsed.command === "context" || parsed.command === "compact") && existing.length === 0) throw new ValidationError("No retained session is available for context management");
    const forceNew = parsed.command === "new" || parsed.flags.has("new");
    let selection: { sessionId: string; branchId: string };
    let summary: ProductBranchSummary;
    if (forceNew || existing.length === 0) {
      const model = await chooseManagedModel(client, parsed, interactive, prompter);
      let created: { sessionId: string; branchId: string };
      try {
        created = await client.createSession(workspace.workspaceId, {
          model,
          sessionName: task ? deriveDisplayName(task) : `New session ${new Date().toISOString().slice(0, 10)}`,
          branchName: "main",
        });
      } catch (error) {
        if (sessionCreationOutcomeIsUnconfirmed(error)) {
          throw new ValidationError(
            `Root creation is unconfirmed because no authoritative outcome was received. Inspect \`agencity agents\` before retrying. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        throw error;
      }
      selection = created;
      await client.productSelect(created.sessionId, created.branchId);
      summary = (await client.productSessions() as ProductBranchSummary[]).find(candidate => candidate.sessionId === created.sessionId && candidate.branchId === created.branchId)!;
    } else {
      const target = parsed.command === "resume" || parsed.command === "attach"
        ? parsed.positionals.join(" ").trim() || undefined
        : option("session");
      selection = await selectManagedSession(client, existing, target, option("branch"), interactive, prompter);
      summary = (await client.productSessions() as ProductBranchSummary[]).find(candidate => candidate.sessionId === selection.sessionId && candidate.branchId === selection.branchId)!;
      if (summary.model.provider === "echo" && commandRequiresUsableModel(parsed, task)) {
        const model = await chooseManagedModel(client, parsed, interactive, prompter);
        await client.selectModel(selection.sessionId, selection.branchId, model);
        summary = { ...summary, model };
      } else if (option("model") || option("effort")) {
        throw new ValidationError("A resumed branch keeps its original model and effort. Use `agencity new --model ... --effort ...` or change /model or /effort on an idle branch");
      }
      await client.resume(selection.sessionId, selection.branchId);
    }

    const agentTools = (await client.agentToolCapability(summary.model)).selected!;
    const available = agentTools.canRun;
    const remediation = available ? null : agentTools.reason ??
      `The selected ${summary.model.provider}:${summary.model.model} combination cannot run the fixed agent tool contract.`;
    const opensInteractiveTerminal = interactive && ["product", "new", "resume", "attach"].includes(parsed.command);
    if (!parsed.flags.has("json") && !opensInteractiveTerminal) printStartup(workspace, summary, agentTools, remediation);
    if (parsed.command === "branch") {
      const [position, ...nameParts] = parsed.positionals;
      if (position !== "head") throw new ValidationError("branch requires `head [NAME]`; low-level point-in-time forks remain under debug branch");
      const name = nameParts.join(" ").trim() || `branch-${new Date().toISOString().slice(0, 10)}`;
      const snapshot = await client.snapshot(selection.sessionId, selection.branchId);
      const forked = await client.fork(selection.sessionId, selection.branchId, snapshot.cursor, name);
      await client.productSelect(selection.sessionId, forked.branchId);
      await printValue({ created: true, session: summary.sessionName, branch: name, from: "head" }, parsed.flags.has("json"));
      return;
    }
    if (parsed.command === "history") {
      const target = parsed.positionals.join(" ").trim();
      if (target && target !== "current") throw new ValidationError("history accepts only `current`; use `resume NAME` before inspecting another named branch");
      const snapshot = await client.snapshot(selection.sessionId, selection.branchId);
      await printValue({
        session: summary.sessionName,
        branch: summary.branchName,
        status: summary.status,
        messages: snapshot.state.messages,
        cells: Object.values(snapshot.state.cells),
        effects: Object.values(snapshot.state.effects),
        runs: Object.values(snapshot.state.agentRuns),
      }, parsed.flags.has("json"));
      return;
    }
    if (parsed.command === "unknown") {
      const effectId = parsed.positionals.join(" ").trim();
      await printValue(effectId
        ? await client.inspectUnknownEffect(selection.sessionId, selection.branchId, effectId)
        : await client.unknownEffects(selection.sessionId, selection.branchId), parsed.flags.has("json"));
      return;
    }
    if (parsed.command === "reconcile") {
      let [effectId, assessment, ...summaryParts] = parsed.positionals;
      const summaryText = summaryParts.join(" ").trim();
      if (!effectId || !assessment || !summaryText || !["succeeded", "failed", "no_effect", "still_unknown"].includes(assessment)) {
        throw new ValidationError("reconcile requires EFFECT_ID|latest succeeded|failed|no_effect|still_unknown SUMMARY");
      }
      if (effectId === "latest") {
        const unknown = await client.unknownEffects(selection.sessionId, selection.branchId);
        const latest = unknown.at(-1);
        if (!latest) throw new ValidationError("No unknown effect is available to reconcile");
        effectId = latest.effect.id;
      }
      if (!effectId) throw new ValidationError("An unknown effect identity could not be resolved");
      const result = await client.reconcileUnknownEffect(selection.sessionId, selection.branchId, effectId, {
        assessment: assessment as "succeeded" | "failed" | "no_effect" | "still_unknown",
        summary: summaryText,
        recordedBy: option("requested-by") ?? "cli-owner",
        ...(option("reconciliation-id") ? { reconciliationId: option("reconciliation-id")! } : {}),
        ...(option("evidence") ? { evidence: parseJsonValue(option("evidence")!, "reconciliation evidence") } : {}),
      });
      await printValue(result, parsed.flags.has("json"));
      if (!parsed.flags.has("json")) console.log("Assessment appended as evidence; the effect remains unknown and was not retried.");
      return;
    }
    if (["goals", "heartbeats", "schedules"].includes(parsed.command)) {
      await manageAutonomyClient(client, selection.sessionId, selection.branchId, parsed);
      return;
    }
    if (parsed.command === "context") {
      if (parsed.positionals.length) throw new ValidationError("context accepts no positional arguments");
      await printValue(await client.inspectContext(selection.sessionId, selection.branchId), parsed.flags.has("json"));
      return;
    }
    if (parsed.command === "compact") {
      const strategyName = option("strategy") ?? "extractive";
      if (!["extractive", "summary", "deterministic-extractive-v1", "model-summary-v1"].includes(strategyName)) throw new ValidationError("--strategy must be extractive or summary");
      const strategy = strategyName === "summary" || strategyName === "model-summary-v1" ? "model-summary-v1" : "deterministic-extractive-v1";
      const instructions = parsed.positionals.join(" ").trim();
      await printValue(await client.compact(selection.sessionId, selection.branchId, {
        strategy, ...(instructions ? { instructions } : {}),
        ...(option("from-context") ? { rematerializeFromContextId: option("from-context")! } : {}),
      }), parsed.flags.has("json"));
      return;
    }
    if (parsed.command === "profile") {
      await manageProfileClient(client, selection.sessionId, selection.branchId, parsed);
      return;
    }
    if (parsed.command === "refine") {
      const [mode, ...rest] = parsed.positionals;
      if (mode === "status") {
        if (rest.length) throw new ValidationError("refine status accepts no additional arguments");
        const status = await client.learningStatus(selection.sessionId, selection.branchId);
        if (parsed.flags.has("json")) await printValue(status, true);
        else console.log(renderLearningStatus(status));
      } else if (mode === "history") {
        if (rest.length) throw new ValidationError("refine history accepts no additional arguments");
        const history = await client.learningHistory(selection.sessionId, selection.branchId);
        if (parsed.flags.has("json")) await printValue(history, true);
        else console.log(renderLearningHistory(history));
      } else if (mode === "inspect") {
        if (rest.length !== 1) throw new ValidationError("refine inspect requires one activity ID");
        const activity = await client.learningActivity(selection.sessionId, selection.branchId, rest[0]!);
        if (parsed.flags.has("json")) await printValue(activity, true);
        else console.log(renderLearningActivity(activity, true));
      } else if (mode === "pause" || mode === "resume") {
        if (rest.length) throw new ValidationError(`refine ${mode} accepts no additional arguments`);
        const policy = mode === "pause"
          ? await client.pauseAutomaticLearning()
          : await client.resumeAutomaticLearning();
        if (parsed.flags.has("json")) await printValue(policy, true);
        else console.log(`Automatic learning ${policy.automatic ? "enabled" : "paused"}.`);
      } else if (mode === "auto") {
        if (rest.length !== 1 || (rest[0] !== "on" && rest[0] !== "off")) throw new ValidationError("refine auto requires on or off");
        const policy = await client.setAutomaticRefinement(rest[0] === "on");
        if (parsed.flags.has("json")) await printValue(policy, true);
        else console.log(`Automatic learning ${policy.automatic ? "enabled" : "paused"}.`);
      } else if (mode === "rollback") {
        if (rest.length < 2) throw new ValidationError("refine rollback requires PROPOSAL_ID REASON");
        const rollback = await client.rollbackGovernedRefinement(
          selection.sessionId,
          selection.branchId,
          rest[0]!,
          { reason: rest.slice(1).join(" "), evidenceEventIds: [] },
        );
        await printValue(rollback, parsed.flags.has("json"));
      } else if (mode === "propose-json") { const proposed = await client.refine(selection.sessionId, selection.branchId, parseJsonValue(rest.join(" "), "refinement proposal") as any); await printValue(await client.validateRefinement(selection.sessionId, selection.branchId, proposed.proposalId), parsed.flags.has("json")); }
      else {
        if (parsed.flags.has("wait") && parsed.flags.has("detach")) {
          throw new ValidationError("refine accepts --wait or --detach, not both");
        }
        const requestedScope = option("scope") as HarnessScope | undefined;
        const allowedKinds = option("kind")?.split(",").filter(Boolean) as HarnessKind[] | undefined;
        const review = await client.requestRefinement(selection.sessionId, selection.branchId, {
          ...(parsed.positionals.length ? { instructions: parsed.positionals.join(" ") } : {}),
          ...(requestedScope === undefined ? {} : { requestedScope }),
          ...(allowedKinds === undefined ? {} : { allowedKinds }),
          wait: parsed.flags.has("wait"),
        });
        await printValue(review, parsed.flags.has("json"));
        if (!parsed.flags.has("wait") && !parsed.flags.has("json")) {
          console.log("Learning reflection accepted (detached; use `agencity refine status` to inspect activity)");
        }
      }
      return;
    }
    if (parsed.command === "skills") {
      await manageSkillsClient(client,selection.sessionId,selection.branchId,parsed,prompter,interactive);
      return;
    }
    if (task) {
      if (!available) throw new ValidationError(`Run blocked: ${remediation}`);
      const goalMode = option("goal") ?? "auto";
      if (!["auto", "current", "create"].includes(goalMode)) throw new ValidationError("--goal must be auto, current, or create");
      const completionGate = option("completion-gate");
      if (completionGate && goalMode === "current") throw new ValidationError("--completion-gate creates a goal and cannot be combined with --goal current");
      const startedAt = option("started-at");
      const deadlineAt = option("deadline-at");
      if ((startedAt === undefined) !== (deadlineAt === undefined)) {
        throw new ValidationError("--started-at and --deadline-at must be supplied together");
      }
      const deadline = startedAt === undefined || deadlineAt === undefined
        ? undefined
        : normalizedRunDeadline(startedAt, deadlineAt);
      const reviewLimitRaw = option("refinement-review-limit");
      const evidenceRequiredRaw = option("refinement-evidence-required");
      if (evidenceRequiredRaw !== undefined && reviewLimitRaw === undefined) {
        throw new ValidationError("--refinement-evidence-required requires --refinement-review-limit");
      }
      const refinementPolicy = reviewLimitRaw === undefined
        ? undefined
        : {
            manualReviewLimit: boundedRunOption(
              reviewLimitRaw,
              "--refinement-review-limit",
            ),
            requiredEvidenceEventCount: evidenceRequiredRaw === undefined
              ? 0
              : boundedRunOption(
                  evidenceRequiredRaw,
                  "--refinement-evidence-required",
                ),
          };
      const input: ProductRunInput = {
        task,
        goalMode: goalMode as "auto" | "current" | "create",
        ...(deadline === undefined ? {} : { deadline }),
        ...(refinementPolicy === undefined ? {} : { refinementPolicy }),
        ...(completionGate ? { goal: {
          description: task,
          completionCriteria: `Required shell verification: ${completionGate}`,
          gates: [{ name: "CLI completion verification", executor: "shell", operation: "run", input: { command: completionGate }, idempotent: true, required: true }],
        } } : {}),
      };
      if (parsed.flags.has("detach")) {
        await client.startRun(selection.sessionId, selection.branchId, input);
        if (parsed.flags.has("json")) console.log(JSON.stringify({ protocol: "agencity.run-accepted", version: 1, accepted: true, detached: true }));
        else console.log("Run accepted (detached; the managed service continues after client exit)");
        return;
      }
      if (parsed.command === "run") {
        const result = await runToTerminalWithInterrupts(client, selection.sessionId, selection.branchId, input);
        if (result !== null) printProductRunResult(result, parsed.flags.has("json"));
        return;
      }
      if (interactive) {
        await client.startRun(selection.sessionId, selection.branchId, input);
      } else {
        const result = await startAndWaitForRun(client, selection.sessionId, selection.branchId, input);
        if (result.status === "succeeded") console.log(result.final ?? "");
        else console.error(`Run ${result.status}: ${result.reason ?? "no terminal reason recorded"}`);
      }
    }

    if (parsed.command === "attach" || interactive || !task) {
      // Interactive onboarding uses readline, while OpenTUI owns stdin in raw
      // mode. Release the prompt listener before the full-screen renderer
      // enables terminal protocols so the two consumers cannot race.
      prompter.close();
      await attachManagedClient(client, selection.sessionId, selection.branchId, workspace.name);
    }
  } finally {
    // Closing a client is detach-only. The resident service owns durable work.
    prompter.close();
  }
}

async function selectManagedSession(
  client: AgentClient,
  candidates: readonly ProductBranchSummary[],
  target: string | undefined,
  branchId: string | undefined,
  interactive: boolean,
  prompter: ProductPrompter,
): Promise<{ sessionId: string; branchId: string }> {
  try {
    return await client.productSelect(target, branchId);
  } catch (error) {
    const ambiguous = error instanceof Error && /ambiguous|Multiple sessions/i.test(error.message);
    if (!interactive || branchId || !ambiguous) throw error;
    const choices = target
      ? candidates.filter(candidate =>
          candidate.sessionId === target
          || candidate.sessionName === target
          || candidate.branchId === target
          || candidate.branchName === target)
      : candidates.filter(candidate => candidate.root && candidate.initialBranch);
    if (choices.length === 0) throw error;
    console.log(choices.map((candidate, index) => [
      `${index + 1}) ${candidate.sessionName} / ${candidate.branchName}`,
      `   ${candidate.status} · ${candidate.model.provider}:${candidate.model.model} · updated ${candidate.updatedAt}`,
      `   ${candidate.taskSummary ?? "No task yet"} · ${candidate.unresolvedWork} unresolved`,
    ].join("\n")).join("\n"));
    const answer = (await prompter.question("Choose session/branch number or name: ")).trim();
    const byNumber = choices[Number(answer) - 1];
    return byNumber
      ? client.productSelect(byNumber.sessionId, byNumber.branchId)
      : client.productSelect(answer);
  }
}

type ProfileProposalInput = {
  readonly replacement: { readonly role: string; readonly purpose: string; readonly instructions: string };
  readonly reason: string;
  readonly predictedEffect: string;
  readonly evidenceEventIds?: readonly string[];
  readonly wait?: boolean;
};

function profileProposalInput(encoded: string): ProfileProposalInput {
  const value = parseJsonObject(encoded, "profile proposal");
  const replacement = value.replacement;
  if (!replacement || Array.isArray(replacement) || typeof replacement !== "object") {
    throw new ValidationError("profile proposal requires replacement role, purpose, and instructions");
  }
  const fields = replacement as Record<string, unknown>;
  if (![fields.role, fields.purpose, fields.instructions].every(item => typeof item === "string" && item.trim())) {
    throw new ValidationError("profile proposal requires non-empty replacement role, purpose, and instructions");
  }
  if (typeof value.reason !== "string" || !value.reason.trim() || typeof value.predictedEffect !== "string" || !value.predictedEffect.trim()) {
    throw new ValidationError("profile proposal requires non-empty reason and predictedEffect");
  }
  if (value.evidenceEventIds !== undefined && (!Array.isArray(value.evidenceEventIds) || !value.evidenceEventIds.every(item => typeof item === "string"))) {
    throw new ValidationError("profile proposal evidenceEventIds must be an array of event IDs");
  }
  if (value.wait !== undefined && typeof value.wait !== "boolean") throw new ValidationError("profile proposal wait must be boolean");
  return {
    replacement: {
      role: fields.role as string,
      purpose: fields.purpose as string,
      instructions: fields.instructions as string,
    },
    reason: value.reason,
    predictedEffect: value.predictedEffect,
    ...(value.evidenceEventIds === undefined ? {} : { evidenceEventIds: value.evidenceEventIds as string[] }),
    ...(value.wait === undefined ? {} : { wait: value.wait }),
  };
}

async function profileGovernanceRecords(client: AgentClient, sessionId: string) {
  return (await client.governedRefinements({ limit: 100 }))
    .filter(record => record.proposal.target.kind === "agent_profile" &&
      record.proposal.target.agentSessionId === sessionId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) ||
      right.proposalId.localeCompare(left.proposalId));
}

async function manageProfileClient(
  client: AgentClient,
  sessionId: string,
  branchId: string,
  parsed: ParsedCliArgs,
): Promise<void> {
  const [action = "show", selector, ...rest] = parsed.positionals;
  const json = parsed.flags.has("json");
  if (action === "show" || action === "current") {
    if (selector !== undefined) throw new ValidationError(`profile ${action} accepts no additional arguments`);
    await printValue(await client.agentProfile(sessionId, true), json);
    return;
  }
  if (action === "history") {
    if (selector !== undefined) throw new ValidationError("profile history accepts no additional arguments");
    const [profiles, proposals] = await Promise.all([
      client.agentProfiles(sessionId, { includePrompt: true, limit: 100 }),
      profileGovernanceRecords(client, sessionId),
    ]);
    await printValue({ ...profiles, proposals }, json);
    return;
  }
  if (action === "proposals" || action === "notices") {
    if (selector !== undefined) throw new ValidationError(`profile ${action} accepts no additional arguments`);
    await printValue(await profileGovernanceRecords(client, sessionId), json);
    return;
  }
  if (action === "propose") {
    const input = profileProposalInput([selector, ...rest].filter(Boolean).join(" "));
    const current = await client.agentProfile(sessionId);
    await printValue(await client.proposeProfileUpdate(sessionId, branchId, {
      expectedProfileVersionId: current.profileVersionId,
      ...input,
      evidenceEventIds: input.evidenceEventIds ?? [],
      wait: input.wait ?? true,
    }), json);
    return;
  }
  if (action === "repropose") {
    if (!selector) throw new ValidationError("profile repropose requires latest|NUMBER and proposal JSON");
    const proposals = (await profileGovernanceRecords(client, sessionId))
      .filter(record => record.status === "deterministically_rejected" || record.status === "reviewed_rejected");
    const previous = selector === "latest" ? proposals[0] : proposals[Number(selector) - 1];
    if (!previous) throw new ValidationError("Rejected profile proposal selection was not found");
    const input = profileProposalInput(rest.join(" "));
    const current = await client.agentProfile(sessionId);
    await printValue(await client.proposeProfileUpdate(sessionId, branchId, {
      expectedProfileVersionId: current.profileVersionId,
      ...input,
      evidenceEventIds: input.evidenceEventIds ?? [],
      revisesProposalId: previous.proposalId,
      wait: input.wait ?? true,
    }), json);
    return;
  }
  if (action === "rollback") {
    if (!selector) throw new ValidationError("profile rollback requires REVISION and rollback JSON");
    const revision = Number(selector);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new ValidationError("profile rollback REVISION must be a positive integer");
    const input = parseJsonObject(rest.join(" "), "profile rollback");
    if (typeof input.reason !== "string" || !input.reason.trim()) throw new ValidationError("profile rollback requires a non-empty reason");
    if (input.evidenceEventIds !== undefined && (!Array.isArray(input.evidenceEventIds) || !input.evidenceEventIds.every(item => typeof item === "string"))) {
      throw new ValidationError("profile rollback evidenceEventIds must be an array of event IDs");
    }
    const history = await client.agentProfiles(sessionId, { limit: 100 });
    const current = history.items.find(item => item.active);
    const restore = history.items.find(item => item.revision === revision);
    if (!current || !restore) throw new ValidationError(`Profile revision ${revision} was not found`);
    if (restore.active) throw new ValidationError(`Profile revision ${revision} is already active`);
    await printValue(await client.rollbackRefinement(sessionId, branchId, {
      targetKind: "agent_profile",
      targetId: sessionId,
      expectedCurrentVersionId: current.profileVersionId,
      restoreVersionId: restore.profileVersionId,
      reason: input.reason,
      evidenceEventIds: (input.evidenceEventIds as string[] | undefined) ?? [],
    }), json);
    return;
  }
  throw new ValidationError("profile action must be show, history, proposals, propose, repropose, or rollback");
}

async function manageSkillsClient(client:AgentClient,sessionId:string,branchId:string,parsed:ParsedCliArgs,prompter:ProductPrompter,interactive:boolean):Promise<void>{
  const [action="list",reference,...rest]=parsed.positionals;
  if(action==="list"){await printValue(await client.listSkills(sessionId,branchId,true),parsed.flags.has("json"));return;}
  if(action==="show"){if(!reference)throw new ValidationError("skills show requires NAME_OR_ID");await printValue(await client.getSkill(sessionId,branchId,reference),parsed.flags.has("json"));return;}
  if(action==="test"){if(!reference)throw new ValidationError("skills test requires NAME_OR_ID");await printValue(await client.testSkill(sessionId,branchId,reference),parsed.flags.has("json"));return;}
  if(action==="enable"||action==="disable"||action==="remove"){
    if(!reference)throw new ValidationError(`skills ${action} requires NAME_OR_ID`);
    const result=action==="enable"?await client.enableSkill(sessionId,branchId,reference):action==="disable"?await client.disableSkill(sessionId,branchId,reference):await client.removeSkill(sessionId,branchId,reference);
    await printValue(result,parsed.flags.has("json"));return;
  }
  if(action==="propose"){const instructions=[reference,...rest].filter(Boolean).join(" ").trim();if(!instructions)throw new ValidationError("skills propose requires instructions");const scope=parsed.values.get("scope")==="local"?"local":"workspace";await printValue(await client.proposeSkill(sessionId,branchId,instructions,scope),parsed.flags.has("json"));return;}
  if(action==="install"){
    if(!reference||rest.length)throw new ValidationError("skills install requires one local DIRECTORY");const scope=parsed.values.get("scope")??"workspace";if(scope!=="workspace"&&scope!=="profile")throw new ValidationError("skills install --scope must be workspace or profile");
    const preview=await client.previewSkillImport(sessionId,branchId,reference);let confirmation=parsed.values.get("confirmation");
    console.error(preview.bundle.warning.message);console.error(`Inspected source SHA-256: ${preview.confirmationDigest}`);
    if(!confirmation){
      if(!interactive)throw new ValidationError(`Skill installation requires --confirmation ${preview.confirmationDigest}`);
      confirmation=(await prompter.question("Type the complete source digest to confirm trusted-local installation: ")).trim();
    }
    await printValue(await client.installSkill(sessionId,branchId,{directory:reference,scope,confirmationDigest:confirmation,installedBy:"cli-owner"}),parsed.flags.has("json"));return;
  }
  throw new ValidationError("skills action must be list, show, install, propose, test, enable, disable, or remove");
}

function acceptanceLeaseMs(): number | undefined {
  if (process.env.AGENCITY_ACCEPTANCE !== "1") return undefined;
  const raw = process.env.AGENCITY_ACCEPTANCE_LEASE_MS;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 100 || value > 5_000) {
    throw new ValidationError("AGENCITY_ACCEPTANCE_LEASE_MS must be an integer from 100 to 5000");
  }
  return value;
}

function consoleRssRecycleThresholdBytes(
  parsed: ParsedCliArgs,
): number | undefined {
  const raw = parsed.values.get("console-rss-recycle-bytes");
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError(
      "--console-rss-recycle-bytes must be a positive integer",
    );
  }
  return value;
}

function managedConfiguration(parsed: ParsedCliArgs, workspace: ResolvedWorkspace): ManagedServiceConfiguration {
  const option = (name: string): string | undefined => parsed.values.get(name);
  const syncUrl = option("sync-url") ?? process.env.TURSO_DATABASE_URL;
  const leaseMs = acceptanceLeaseMs();
  const consoleRssRecycleBytes = consoleRssRecycleThresholdBytes(parsed);
  return {
    workspace,
    databasePath: resolve(option("db") ?? `${workspace.stateDirectory}/agent.db`),
    artifactDirectory: resolve(option("artifacts") ?? `${workspace.stateDirectory}/artifacts`),
    profileDatabasePath: option("profile") ? resolve(option("profile")!) : defaultProfilePath(),
    restartConsoleAfterCell: parsed.flags.has("restart-console-after-cell"),
    ...(consoleRssRecycleBytes === undefined
      ? {}
      : { consoleRssRecycleThresholdBytes: consoleRssRecycleBytes }),
    ...(leaseMs === undefined ? {} : { leaseMs }),
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
    await printValue(value, parsed.flags.has("json"));
    if (action === "shutdown" && observed.state !== "stopped") throw new ValidationError("Service authority is conflicted; refusing unauthenticated shutdown");
    return;
  }
  const client = new AgentClient(observed.manifest.url, observed.manifest.bearerToken);
  if (action === "shutdown") {
    let before: Partial<ManagedServiceStatus> | null = null;
    const timedOut = Symbol("service-status-timeout");
    const preflight = client.serviceStatus()
      .then(value => value as Partial<ManagedServiceStatus>)
      .catch(() => null);
    const observedStatus = await Promise.race([preflight, Bun.sleep(750).then(() => timedOut)]);
    if (observedStatus === timedOut) client.abortPendingRequests("Shutdown status preflight timed out");
    else before = observedStatus as Partial<ManagedServiceStatus> | null;
    const result = await client.shutdownService();
    if (parsed.flags.has("json")) {
      await printValue(result, true);
    } else {
      const reasons = before?.keepAliveReasons?.map(reason => reason.summary) ?? [];
      console.log([
        "Workspace service shutdown requested; admission has stopped.",
        reasons.length ? `Draining retained work: ${reasons.join("; ")}.` : "No retained background work was reported.",
        "Sessions remain durable; this command does not cancel agent work.",
      ].join("\n"));
    }
    return;
  }
  const status = await client.serviceStatus() as ManagedServiceStatus;
  if (parsed.flags.has("json")) {
    await printValue(status, true);
    return;
  }
  console.log([
    `Workspace service: ${status.lifecycle}`,
    `Recovery: ${status.recovery}${status.recoveryError ? ` — ${status.recoveryError}` : ""}`,
    `Attached clients: ${status.attachedClients ?? "not reported by this service version"}`,
    `Idle shutdown: ${status.idleShutdownAt ?? "not reported by this service version"}${status.idleShutdownMs === undefined ? "" : ` (${formatDuration(status.idleShutdownMs)} after activity)`}`,
    `Keeps alive: ${status.keepAliveReasons === undefined ? "not reported by this service version" : status.keepAliveReasons.length ? status.keepAliveReasons.map(reason => reason.summary).join("; ") : "none"}`,
    `Root sessions: ${status.roots.length}`,
  ].join("\n"));
}

async function doctorProviderStatuses(profileDatabasePath: string): Promise<Array<{
  provider: string;
  usable: boolean;
  credentialSource: "stored" | "environment" | "missing" | "programmatic";
}>> {
  const statuses = await inspectModelCredentialStatuses(modelCredentialPathForProfile(profileDatabasePath));
  return statuses.map(status => ({
    provider: status.provider,
    usable: status.configured,
    credentialSource: status.source,
  }));
}

async function doctorUninitialized(workspace: { root: string; workspaceId: string | null; name: string; stateDirectory: string }, json: boolean): Promise<void> {
  const report = {
    application: await applicationVersion(),
    bun: { version: Bun.version, required: `>=${REQUIRED_BUN_VERSION}`, compatible: runtimeCompatible() },
    mode: "trusted-local (not a hostile-code sandbox)",
    observer: "read-only (no workspace initialization, recovery, wake ticks, migrations, or canonical writes)",
    workspace,
    service: { state: "stopped", onDemand: true },
    providers: await doctorProviderStatuses(defaultProfilePath()),
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log([`Agencity ${report.application} · Bun ${report.bun.version}`, `Workspace: ${workspace.name} (${workspace.root}) [not initialized]`, `Mode: ${report.mode}`, "Service: stopped (started on demand; not an OS boot service)", `Observer: ${report.observer}`].join("\n"));
}

async function doctorObserver(configuration: ManagedServiceConfiguration, json: boolean): Promise<void> {
  const observed = await observeManagedService(configuration);
  const providers = await doctorProviderStatuses(configuration.profileDatabasePath);
  const report = {
    application: await applicationVersion(),
    bun: { version: Bun.version, required: `>=${REQUIRED_BUN_VERSION}`, compatible: runtimeCompatible() },
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
    if (parsed.flags.has("json")) await printValue(selected, true);
    else console.log(`Selected ${selected.sessionId}/${selected.branchId}`);
    return;
  }
  const rows = await client.productSessions() as ProductBranchSummary[];
  if (parsed.flags.has("json")) console.log(JSON.stringify(rows, null, 2));
  else console.log(rows.length ? formatSessions(rows) : "No sessions in this workspace.");
}

async function managedConfig(client: AgentClient, parsed: ParsedCliArgs): Promise<void> {
  const action = parsed.positionals[0];
  if (!action) { await printValue(await client.productConfig(), parsed.flags.has("json")); return; }
  if (action === "set-model") {
    const value = parsed.positionals[1];
    if (!value) throw new ValidationError("config set-model requires PROVIDER:MODEL");
    const model = parseModel(value);
    await printValue(await client.productSetModel(formatModel(model)), parsed.flags.has("json"));
    return;
  }
  if (action === "clear-model") { await printValue(await client.productSetModel(null), parsed.flags.has("json")); return; }
  if (action === "set-effort") {
    const value = parsed.positionals[1];
    if (!value) throw new ValidationError("config set-effort requires LEVEL");
    const model = await configuredEffortModel(client, parsed.values.get("model"));
    await printValue(await client.productSetReasoningEffort(model, normalizeReasoningEffort(value)), parsed.flags.has("json"));
    return;
  }
  if (action === "clear-effort") {
    const model = await configuredEffortModel(client, parsed.values.get("model"));
    await printValue(await client.productSetReasoningEffort(model, null), parsed.flags.has("json"));
    return;
  }
  if (action === "credential-ref") {
    const provider=parsed.positionals[1];const reference=parsed.positionals[2];const label=parsed.positionals.slice(3).join(" ");
    if(!provider||!reference||!label)throw new ValidationError("config credential-ref requires PROVIDER REFERENCE LABEL");
    if(containsBrokeredSecret(reference)||containsBrokeredSecret(label))throw new ValidationError("Credential references and labels cannot contain registered credential values");
    if(!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(reference))throw new ValidationError("Credential references must be opaque handles such as env:OPENAI_API_KEY or keychain:item; raw values are rejected");
    await printValue(await client.productCredentialReference(provider,reference,label),parsed.flags.has("json"));return;
  }
  throw new ValidationError(`Unknown config action: ${action}`);
}

async function configuredEffortModel(client: AgentClient, explicit: string | undefined): Promise<string> {
  const configured = explicit ?? (await client.productConfig()).defaultModel;
  if (!configured) {
    throw new ValidationError("No workspace default model is configured; pass --model CREATOR/MODEL");
  }
  const model = configured.includes(":") ? parseModel(configured).model : configured.trim();
  if (!/^[a-z0-9][a-z0-9._-]*\/[^\s/][^\s]*$/i.test(model)) {
    throw new ValidationError("Effort preferences require a canonical creator/model ID");
  }
  return model;
}

async function managedStatus(client: AgentClient, parsed: ParsedCliArgs): Promise<void> {
  const target = parsed.positionals.join(" ").trim();
  if (target === "current") {
    const selected = await client.productSelect();
    const snapshot = await client.snapshot(selected.sessionId, selected.branchId);
    const latest = Object.values(snapshot.state.agentRuns).at(-1);
    if (!latest) throw new ValidationError("The current branch has no agent run outcome");
    const final = latest.finalMessageId === undefined ? undefined : snapshot.state.messages.find(message => message.id === latest.finalMessageId)?.content;
    const [agentTools, modelContracts] = await Promise.all([
      client.agentToolCapability(snapshot.state.model),
      client.modelContractDiagnostics(selected.sessionId, selected.branchId),
    ]);
    printProductRunResult({
      runId: latest.id,
      sessionId: selected.sessionId,
      branchId: selected.branchId,
      status: latest.status,
      steps: latest.steps.length,
      ...(latest.reason === undefined ? {} : { reason: latest.reason }),
      ...(latest.finalMessageId === undefined ? {} : { finalMessageId: latest.finalMessageId }),
      ...(final === undefined ? {} : { final }),
    }, parsed.flags.has("json"), {
      agentTools: agentTools.selected!,
      modelContracts,
    });
    return;
  }
  const agents = await client.serviceAgents() as any[];
  const value = target ? resolveAgentTarget(agents, target) : agents;
  await printValue(value, parsed.flags.has("json"));
}

async function managedSend(client: AgentClient, parsed: ParsedCliArgs): Promise<void> {
  const [target, ...words] = parsed.positionals;
  const content = words.join(" ").trim();
  if (!target || !content) throw new ValidationError("send requires TARGET MESSAGE");
  const selected = resolveAgentTarget(await client.serviceAgents() as any[], target);
  const event = await client.message(selected.sessionId, selected.branchId, content);
  await printValue({ delivered: true, eventId: event.id, sessionId: selected.sessionId, branchId: selected.branchId }, parsed.flags.has("json"));
}

async function managedStop(client: AgentClient, parsed: ParsedCliArgs): Promise<void> {
  const target = parsed.positionals.join(" ").trim();
  if (!target) throw new ValidationError("stop requires TARGET");
  const selected = resolveAgentTarget(await client.serviceAgents() as any[], target);
  await printValue(await client.stopSession(selected.sessionId, selected.branchId, "Stopped by user command"), parsed.flags.has("json"));
}

function resolveAgentTarget(rows: any[], target: string): any {
  const matches = rows.filter(row => row.sessionId === target || row.branchId === target || row.name === target);
  if (matches.length !== 1) throw new ValidationError(matches.length ? `Agent target is ambiguous: ${target}` : `Agent target not found: ${target}`);
  return matches[0];
}

type ProductRunInput = {
  readonly task: string;
  readonly goalMode: "auto" | "current" | "create";
  readonly goal?: {
    readonly description: string;
    readonly completionCriteria: string;
    readonly gates: readonly { readonly name: string; readonly executor: string; readonly operation: string; readonly input: JsonValue; readonly idempotent: boolean; readonly required: boolean }[];
  };
  readonly deadline?: {
    readonly startedAt: string;
    readonly deadlineAt: string;
  };
  readonly refinementPolicy?: {
    readonly manualReviewLimit: number;
    readonly requiredEvidenceEventCount: number;
  };
};

function normalizedRunDeadline(
  startedAt: string,
  deadlineAt: string,
): { startedAt: string; deadlineAt: string } {
  const startedAtMs = Date.parse(startedAt);
  const deadlineAtMs = Date.parse(deadlineAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(deadlineAtMs) ||
      deadlineAtMs <= startedAtMs) {
    throw new ValidationError(
      "--deadline-at must be a valid timestamp after --started-at",
    );
  }
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    deadlineAt: new Date(deadlineAtMs).toISOString(),
  };
}

function boundedRunOption(value: string, optionName: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ValidationError(`${optionName} must be an integer from 0 to 64`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 64) {
    throw new ValidationError(`${optionName} must be an integer from 0 to 64`);
  }
  return parsed;
}

type RunOperation<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown };

function observeRunOperation<T>(operation: Promise<T>): Promise<RunOperation<T>> {
  return operation.then(
    (value) => ({ kind: "value", value }),
    (error: unknown) => ({ kind: "error", error }),
  );
}

async function startAndWaitForRun(
  client: AgentClient,
  sessionId: string,
  branchId: string,
  input: ProductRunInput,
): Promise<AgentRunResult> {
  const accepted = await client.startRun(sessionId, branchId, input);
  return waitForRun(client, sessionId, branchId, accepted.runId);
}

/** The plain `agencity run` path owns SIGINT only while admitting/waiting. */
async function runToTerminalWithInterrupts(
  client: AgentClient,
  sessionId: string,
  branchId: string,
  input: ProductRunInput,
): Promise<AgentRunResult | null> {
  const polling = new AbortController();
  const interrupts = new CliRunInterruptCoordinator(
    (runId) => client.cancelRun(sessionId, branchId, runId, "User requested cancellation with Ctrl-C"),
    (message) => console.error(message),
  );
  const sigint = (): void => { interrupts.interrupt(); };
  process.on("SIGINT", sigint);
  try {
    const admission = observeRunOperation(client.startRun(sessionId, branchId, input));
    const admitted = await Promise.race([
      admission,
      interrupts.detached.then(() => null),
    ]);
    if (admitted === null) return null;
    if (admitted.kind === "error") throw admitted.error;

    interrupts.admit(admitted.value.runId);
    const terminal = await Promise.race([
      observeRunOperation(waitForRun(client, sessionId, branchId, admitted.value.runId, polling.signal)),
      interrupts.detached.then(() => null),
    ]);
    if (terminal === null) return null;
    if (terminal.kind === "error") throw terminal.error;
    return terminal.value;
  } finally {
    process.off("SIGINT", sigint);
    polling.abort();
  }
}

async function waitForRun(
  client: AgentClient,
  sessionId: string,
  branchId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  while (true) {
    if (signal?.aborted) throw new DOMException("Run wait detached", "AbortError");
    const result = await client.run(sessionId, branchId, runId);
    if (!["queued", "running"].includes(result.status)) return result;
    if (signal?.aborted) throw new DOMException("Run wait detached", "AbortError");
    await Bun.sleep(50);
  }
}

async function attachManagedClient(client: AgentClient, sessionId: string, branchId: string, workspaceLabel: string): Promise<void> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (interactive) {
    await new OpenTerminalUI(client, { workspaceLabel }).run(sessionId, branchId);
    return;
  }
  await new TerminalUI(client, { interactive: false, workspaceLabel }).run(sessionId, branchId);
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

function productRunExitCode(status: AgentRunResult["status"]): number {
  switch (status) {
    case "succeeded": return 0;
    case "failed": return 1;
    case "blocked": return 4;
    case "budget_exceeded": return 5;
    case "unknown": return 7;
    case "queued":
    case "running": return 8;
    case "cancelled": return 130;
  }
}

interface ProductRunObservability {
  readonly agentTools: SelectedAgentToolCapabilityView;
  readonly modelContracts: ModelContractDiagnosticsView;
}

function printProductRunResult(
  result: AgentRunResult,
  json: boolean,
  observability?: ProductRunObservability,
): void {
  const exitCode = productRunExitCode(result.status);
  if (json) {
    console.log(JSON.stringify({
      protocol: "agencity.run-result",
      version: 1,
      status: result.status,
      exitCode,
      steps: result.steps,
      ...(result.final === undefined ? {} : { final: result.final }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(observability === undefined ? {} : {
        agentTools: {
          contract: "agencity.agent-tools.v1",
          tools: ["bun_console", "finish"],
          state: observability.agentTools.state,
          admission: observability.agentTools.admission,
          canRun: observability.agentTools.canRun,
          ...(observability.agentTools.reason === undefined
            ? {}
            : { reason: observability.agentTools.reason }),
        },
        modelContractCounters: observability.modelContracts.counters,
      }),
    }));
  } else {
    if (result.status === "succeeded") console.log(result.final ?? "");
    else console.error(`Run ${result.status}: ${result.reason ?? "no terminal reason recorded"}`);
    if (observability) {
      const accepted = observability.modelContracts.counters.submissions
        .reduce((total, item) => total + item.count, 0);
      const violations = observability.modelContracts.counters.violations
        .reduce((total, item) => total + item.count, 0);
      console.log(
        `Agent tools: bun_console + finish · ${observability.agentTools.state}` +
        `${observability.agentTools.canRun ? "" : " [UNAVAILABLE]"}`,
      );
      console.log(`Formal outcomes: ${accepted} accepted · ${violations} violations`);
      if (observability.agentTools.reason) {
        console.log(`Agent-tool detail: ${observability.agentTools.reason}`);
      }
    }
  }
  process.exitCode = exitCode;
}

function renderLearningStatus(status: LearningStatusView): string {
  const latest = status.latestActivity
    ? renderLearningActivity(status.latestActivity, false)
    : "No retained learning activity.";
  return [
    `Automatic learning: ${status.automaticLearning}`,
    `Scope: ${status.automaticPolicy?.scope ?? "unavailable"}`,
    `Pending activity: ${status.pendingActivityCount}`,
    `Latest: ${latest}`,
  ].join("\n");
}

function renderLearningHistory(history: LearningHistoryView): string {
  return [
    `Automatic learning: ${history.automaticLearning}`,
    `History response: ${history.truncated ? "truncated" : "complete"} · ${history.byteLimit} byte limit`,
    ...(history.activities.length
      ? history.activities.map((activity) => renderLearningActivity(activity, false))
      : ["No retained learning activity."]),
  ].join("\n");
}

function renderLearningActivity(
  activity: LearningActivity,
  detailed: boolean,
): string {
  if (activity.kind === "scan_observation") {
    return detailed
      ? [
          `${activity.createdAt} ${activity.effectiveStatus} ${activity.activityId}`,
          activity.message,
        ].join("\n")
      : `${activity.createdAt} ${activity.effectiveStatus} ${activity.activityId}`;
  }
  const summary = `${activity.updatedAt} ${activity.effectiveStatus} ${activity.activityId} trigger=${activity.review.triggerKind} evidence=${activity.review.evidenceEventIds.length}`;
  if (!detailed) return summary;
  return [
    summary,
    `Result: ${activity.review.reason ?? "pending"}`,
    `Evidence events: ${activity.review.evidenceEventIds.join(", ") || "none"}`,
    `Source events: ${activity.review.sourceEventIds.join(", ")}`,
    activity.governance
      ? `Governance: ${activity.governance.status} proposal=${activity.governance.proposalId} target=${activity.governance.harnessKind ?? activity.governance.targetKind} edits=${activity.governance.editCount} applied=${activity.governance.appliedVersionIds.join(", ") || "none"}`
      : "Governance: none",
    activity.governance?.decision
      ? `Sealed decision: ${activity.governance.decision.decision} — ${activity.governance.decision.reason}`
      : "Sealed decision: none",
    activity.rollback
      ? `Rollback: ${activity.rollback.rollbackId} actions=${activity.rollback.actions.length} reason=${activity.rollback.reason}`
      : "Rollback: none",
  ].join("\n");
}

async function printValue(value: unknown, json: boolean): Promise<void> {
  const rendered = json ? JSON.stringify(value, null, 2) : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(`${rendered}\n`, error => error ? rejectWrite(error) : resolveWrite());
  });
}

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
    `   ${row.status} · ${row.model.provider}:${row.model.model} · updated ${row.updatedAt}`,
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
    if (!requested) throw new ValidationError("config set-model requires PROVIDER:MODEL");
    await chooseNewModel({
      supervisor,
      workspaceId: workspace.workspaceId,
      explicitModel: requested,
      interactive,
      prompt: question => prompter.question(question),
      promptSecret: question => prompter.secret(question),
    });
    console.log(`Saved non-secret workspace model preference: ${formatModel(parseModel(requested))}`);
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
    if (containsBrokeredSecret(reference) || containsBrokeredSecret(label)) throw new ValidationError("Credential references and labels cannot contain registered credential values");
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
    bun: { version: Bun.version, required: `>=${REQUIRED_BUN_VERSION}`, compatible: runtimeCompatible() },
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
    ...report.providers.map(provider => `Provider ${provider.provider}: ${provider.usable ? "usable" : `unavailable — ${provider.remediation}`}`),
    `Recovery: ${pending} pending/running, ${unknown} unknown`,
    `Sync: ${report.sync.configured ? report.sync.lifecycle : "local only"}`,
  ].join("\n"));
}

async function runAdvanced(parsed: ParsedCliArgs): Promise<void> {
  const invocation = parsed.advanced;
  if (!invocation) throw new ValidationError("Advanced command identity is missing");
  const path = invocation.path;
  if (path === "debug tui" && invocation.source === "canonical" && parsed.flags.has("json")) {
    throw new ValidationError("debug tui is interactive and does not support --json");
  }
  const option = (name: string, fallback?: string): string | undefined => parsed.values.get(name) ?? fallback;

  // Validate the destructive phrase before opening or mutating a workspace.
  let guardedDeletion: ReturnType<typeof buildDataDeleteConfirmation> | null = null;
  if (path === "data delete") {
    try {
      guardedDeletion = buildDataDeleteConfirmation(
        required(option("scope"), "scope") as "workspace" | "session" | "profile",
        required(option("scope-id"), "scope-id"),
        required(option("confirmation"), "confirmation"),
      );
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ValidationError(invocation.source === "legacy"
        ? message.replace(/^Data deletion requires/, "Physical deletion requires")
        : message);
    }
  }

  const stateDir = resolve(option("state-dir", ".agencity")!);
  await mkdir(stateDir, { recursive: true });
  const workspace: ResolvedWorkspace = {
    root: resolve(option("workspace-root", process.cwd())!),
    workspaceId: option("workspace", "default")!,
    name: option("workspace", "default")!,
    stateDirectory: stateDir,
  };
  const supervisor = await openSupervisor(parsed, workspace, true);
  const sessionId = option("session");
  const branchId = option("branch");
  const serving = path === "debug protocol-serve";
  try {
    if (path === "debug session-create") {
      emitAdvanced(parsed, path, await supervisor.createSession({ workspaceId: workspace.workspaceId }));
    } else if (path === "debug turn") {
      required(sessionId, "session"); required(branchId, "branch");
      await supervisor.appendMessage(sessionId!, branchId!, "user", parsed.positionals.join(" "));
      emitAdvanced(parsed, path, await supervisor.diagnosticTurn(sessionId!, branchId!));
    } else if (path === "debug cell") {
      required(sessionId, "session"); required(branchId, "branch");
      emitAdvanced(parsed, path, await supervisor.executeCell(sessionId!, branchId!, parsed.positionals.join(" ")));
    } else if (path === "debug snapshot") {
      required(sessionId, "session"); required(branchId, "branch");
      emitAdvanced(parsed, path, await supervisor.projections.getSnapshot(sessionId!, branchId!));
    } else if (path === "debug history") {
      required(sessionId, "session"); required(branchId, "branch");
      const events = await supervisor.projections.history(sessionId!, branchId!);
      emitAdvanced(parsed, path, events, events.map((event) => JSON.stringify(event)).join("\n"));
    } else if (path === "debug rebuild") {
      required(sessionId, "session"); required(branchId, "branch");
      emitAdvanced(parsed, path, await supervisor.projections.rebuild(sessionId!, branchId!));
    } else if (path === "debug branch") {
      required(sessionId, "session"); required(branchId, "branch");
      const strategyName = option("strategy");
      const branchStrategy = strategyName === "summary" || strategyName === "model-summary-v1" ? "model-summary-v1" : strategyName === "extractive" || strategyName === "deterministic-extractive-v1" ? "deterministic-extractive-v1" : undefined;
      if (strategyName && !branchStrategy) throw new ValidationError("--strategy must be extractive or summary");
      const forked = await supervisor.fork(sessionId!, branchId!, required(option("cursor"), "cursor"), option("name"), branchStrategy);
      emitAdvanced(parsed, path, forked, forked);
    } else if (path === "debug tui") {
      required(sessionId, "session"); required(branchId, "branch");
      const protocol = new ProtocolServer(supervisor);
      const client = new AgentClient(new InProcessProtocolTransport(protocol));
      await new TerminalUI(client).run(sessionId!, branchId!);
    } else if (path === "debug protocol-serve") {
      const server = new ProtocolServer(supervisor).listen(Number(option("port", "3131")));
      const message = `Agencity protocol listening on http://${server.hostname}:${server.port} (trusted-local mode)`;
      emitAdvanced(parsed, path, { hostname: server.hostname, port: server.port, mode: "trusted-local" }, message);
      await new Promise(() => {});
    } else if (path === "sync status") emitAdvanced(parsed, path, await supervisor.sync.status());
    else if (path === "sync now") emitAdvanced(parsed, path, await supervisor.sync.sync("manual"));
    else if (path === "sync push") emitAdvanced(parsed, path, await supervisor.sync.push());
    else if (path === "sync pull") emitAdvanced(parsed, path, await supervisor.sync.pull());
    else if (path === "sync checkpoint") emitAdvanced(parsed, path, await supervisor.sync.checkpoint());
    else if (path === "sync stats") emitAdvanced(parsed, path, await supervisor.sync.stats());
    else if (path === "sync conflicts") emitAdvanced(parsed, path, await supervisor.sync.conflicts("unresolved"));
    else if (path === "sync resolve") {
      const conflictId = parsed.positionals[0]; const encoded = parsed.positionals.slice(1).join(" ");
      if (!conflictId || !encoded) throw new ValidationError("sync resolve requires CONFLICT_ID JSON_RESOLUTION");
      emitAdvanced(parsed, path, await supervisor.sync.resolveConflict(conflictId, parseJsonObject(encoded, "sync resolution") as any));
    } else if (path === "data export") {
      const scopeKind = required(option("scope"), "scope") as "workspace" | "session" | "profile";
      const scopeId = required(option("scope-id"), "scope-id");
      const destination = resolve(required(option("destination"), "destination"));
      emitAdvanced(parsed, path, await supervisor.sync.exportBundle(destination, scopeKind, scopeId, option("requested-by", "cli-owner")!));
    } else if (path === "data delete") {
      if (!guardedDeletion) throw new ValidationError("Guarded deletion input is missing");
      emitAdvanced(parsed, path, await supervisor.deleteOwnedData({
        ...guardedDeletion,
        requestedBy: option("requested-by", "cli-owner")!,
        ...(option("receipt-dir") ? { receiptDirectory: resolve(option("receipt-dir")!) } : {}),
      }));
    } else throw new ValidationError(`Unsupported advanced command: ${path}`);
  } finally {
    if (!serving) await supervisor.close();
  }
}

function emitAdvanced(parsed: ParsedCliArgs, path: AdvancedCommandPath, value: unknown, human?: string): void {
  if (parsed.advanced?.source === "canonical" && parsed.flags.has("json")) {
    const envelope = createCliSuccessEnvelope({
      command: path,
      message: `${path} completed`,
      data: cliJson(value),
    });
    const plan = planCliOutput(envelope, "json");
    if (plan.stdout !== null) process.stdout.write(`${plan.stdout}\n`);
    process.exitCode = plan.exitCode;
    return;
  }
  console.log(human ?? (typeof value === "string" ? value : JSON.stringify(value, null, 2)));
}

function cliJson(value: unknown): CliJsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as CliJsonValue;
}

function parseJsonValue(text: string, label: string): JsonValue {
  try { return JSON.parse(text) as JsonValue; }
  catch { throw new ValidationError(`${label} must be valid JSON`); }
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new ValidationError(`${label} must be one JSON object`);
  }
}

async function openSupervisor(parsed: ParsedCliArgs, workspace: ResolvedWorkspace, legacy: boolean): Promise<Supervisor> {
  const option = (name: string): string | undefined => parsed.values.get(name);
  const stateDir = workspace.stateDirectory;
  const database = resolve(option("db") ?? `${stateDir}/agent.db`);
  const artifacts = resolve(option("artifacts") ?? `${stateDir}/artifacts`);
  const syncUrl = option("sync-url") ?? process.env.TURSO_DATABASE_URL;
  const profile = option("profile") ? resolve(option("profile")!) : legacy ? undefined : defaultProfilePath();
  const consoleRssRecycleBytes = consoleRssRecycleThresholdBytes(parsed);
  return Supervisor.open({
    databaseUrl: `file:${database}`,
    artifactDirectory: artifacts,
    artifactDirectoryOwnership: parsed.flags.has("exclusive-artifacts") ? "exclusive" : "shared",
    workspaceRoot: workspace.root,
    restartConsoleAfterCell: parsed.flags.has("restart-console-after-cell"),
    ...(consoleRssRecycleBytes === undefined
      ? {}
      : { consoleRssRecycleThresholdBytes: consoleRssRecycleBytes }),
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
  if (["resume", "attach", "goals", "heartbeats", "schedules", "unknown", "reconcile", "profile", "refine", "skills", "context", "compact"].includes(parsed.command)) return undefined;
  const task = parsed.positionals.join(" ").trim();
  if (parsed.command === "run" && !task) throw new ValidationError("run requires TASK");
  return task || undefined;
}

function commandRequiresUsableModel(parsed: ParsedCliArgs, task: string | undefined): boolean {
  if (task !== undefined || ["product", "resume", "attach", "refine", "compact"].includes(parsed.command)) return true;
  if (parsed.command === "profile") return ["propose", "repropose"].includes(parsed.positionals[0] ?? "show");
  if (parsed.command === "heartbeats") return parsed.positionals[0] === "create";
  if (parsed.command === "schedules") return ["once", "every"].includes(parsed.positionals[0] ?? "");
  return false;
}

function printStartup(
  workspace: ResolvedWorkspace,
  session: ProductBranchSummary,
  agentTools: SelectedAgentToolCapabilityView,
  remediation: string | null,
): void {
  console.log([
    "Agencity product session",
    `Workspace: ${workspace.name} (${workspace.root})`,
    `Session: ${session.sessionName} / ${session.branchName}`,
    `Model: ${session.model.provider}:${session.model.model} · effort ${session.model.reasoningEffort}${agentTools.canRun ? "" : " [UNAVAILABLE]"}`,
    `Agent tools: bun_console + finish · ${agentTools.state}${agentTools.canRun ? "" : " [UNAVAILABLE]"}`,
    `Run state: ${agentTools.canRun
      ? session.status
      : agentTools.admission === "rejected"
        ? "blocked by selected model capability"
        : "blocked by provider credentials"}`,
    "Mode: trusted-local; generated code has this process's OS authority (not sandboxed)",
    ...(!agentTools.canRun && remediation ? [`Remediation: ${remediation}`] : []),
  ].join("\n"));
}

function sessionCreationOutcomeIsUnconfirmed(error: unknown): boolean {
  return !(error instanceof ProtocolClientError) ||
    error.code === "INVALID_RESPONSE" ||
    error.status >= 500;
}

function required<T>(value: T | undefined, name: string): T { if (value === undefined) throw new ValidationError(`--${name} is required`); return value; }
function runtimeCompatible(): boolean {
  const current = Bun.version.split(".").map(Number);
  const required = REQUIRED_BUN_VERSION.split(".").map(Number);
  for (let index = 0; index < required.length; index++) {
    const difference = (current[index] ?? 0) - (required[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}
function assertRuntimeCompatibility(): void { if (!runtimeCompatible()) throw new ValidationError(`Bun ${Bun.version} is unsupported; Agencity requires Bun >=${REQUIRED_BUN_VERSION}`); }
async function applicationVersion(): Promise<string> { const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json() as { version: string }; return pkg.version; }
async function printVersion(): Promise<void> { console.log(`agencity ${await applicationVersion()}
Bun ${Bun.version} (supported: >=${REQUIRED_BUN_VERSION})`); }

function printHelp(): void {
  process.stdout.write(`${renderCliHelp({
    color: cliHelpColorEnabled(),
    width: process.stdout.columns,
  })}\n`);
}

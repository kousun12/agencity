import type { AgentEvent, AgentState, ModelConfiguration } from "../domain/index.ts";
import type { ModelProviderDescriptor } from "../executors/index.ts";
import { scrubText } from "../security/index.ts";

export type TerminalDetailTone = "normal" | "success" | "warning" | "danger" | "muted";

export interface TerminalDetailRow {
  readonly label: string;
  readonly value?: string;
  readonly detail?: string;
  readonly tone?: TerminalDetailTone;
}

export interface TerminalDetailSection {
  readonly title: string;
  readonly rows: readonly TerminalDetailRow[];
}

export interface TerminalInspectionDetail {
  readonly kind: "inspection";
  readonly command: string;
  readonly title: string;
  readonly summary?: string;
  readonly sections: readonly TerminalDetailSection[];
  readonly raw: unknown;
}

export interface TerminalModelProviderDetail {
  readonly name: string;
  readonly displayName: string;
  readonly usable: boolean;
  readonly credentialSource: ModelProviderDescriptor["credentialSource"];
  readonly credentialLabel: string;
  readonly remediation?: string;
  readonly credentialManaged: boolean;
}

export interface TerminalModelDetail {
  readonly kind: "model";
  readonly command: "/model";
  readonly title: "Model";
  readonly current: ModelConfiguration;
  readonly workspaceDefault: string | null;
  readonly providers: readonly TerminalModelProviderDetail[];
  readonly raw: unknown;
}

export interface TerminalRawDetail {
  readonly kind: "raw";
  readonly command: "/raw";
  readonly title: string;
  readonly raw: unknown;
}

export type TerminalDetail = TerminalInspectionDetail | TerminalModelDetail | TerminalRawDetail;

type UnknownRecord = Record<string, unknown>;

const INTERNAL_FIELD = /(?:^|_)(?:id|ids|event|cursor|digest|fingerprint|hash|sequence)(?:_|$)/i;
const RAW_SECRET_FIELD = /^(?:api_?key|access_?token|refresh_?token|auth_?token|token|client_?secret|private_?key|secret|password|passwd|authorization|credential_?value)$/i;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function oneLine(value: unknown, max = 180): string {
  if (value === undefined || value === null || value === "") return "—";
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const normalized = scrubText((serialized ?? String(value)).replace(/\s+/g, " ").trim());
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function sentence(value: unknown, max = 300): string {
  return oneLine(value, max);
}

function displayStatus(value: unknown): string {
  return string(value, "unknown").replaceAll("_", " ");
}

function titleCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function markerTone(status: unknown): TerminalDetailTone {
  const normalized = string(status).toLowerCase();
  if (["succeeded", "completed", "active", "online", "connected", "passed", "validated", "promoted", "enabled"].includes(normalized)) return "success";
  if (["failed", "blocked", "unknown", "error", "quarantined", "rejected"].includes(normalized)) return "danger";
  if (["pending", "running", "waiting_for_user", "completion_requested", "offline", "paused", "revision_required"].includes(normalized)) return "warning";
  return "normal";
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function duration(milliseconds: unknown): string {
  const value = number(milliseconds);
  if (value === null) return "—";
  if (value < 1_000) return `${value} ms`;
  if (value < 60_000) return `${Math.round(value / 1_000)} sec`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)} min`;
  return `${Math.round(value / 3_600_000 * 10) / 10} hr`;
}

function dateTime(value: unknown): string {
  const raw = string(value);
  if (!raw) return "—";
  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf()) ? raw : parsed.toLocaleString();
}

function model(value: unknown): string {
  const item = record(value);
  const provider = string(item.provider);
  const modelId = string(item.model);
  return provider && modelId ? `${provider}:${modelId}` : oneLine(value);
}

function statusRow(label: string, status: unknown, detail?: unknown): TerminalDetailRow {
  return {
    label,
    value: displayStatus(status),
    ...(detail === undefined || detail === null || detail === "" ? {} : { detail: sentence(detail) }),
    tone: markerTone(status),
  };
}

function emptySection(title: string, message: string): TerminalDetailSection {
  return { title, rows: [{ label: message, tone: "muted" }] };
}

function listSections(
  title: string,
  value: unknown,
  map: (item: UnknownRecord, index: number) => TerminalDetailRow,
  emptyMessage: string,
): TerminalDetailSection[] {
  const items = records(value);
  return [items.length
    ? { title: `${title} · ${items.length}`, rows: items.map(map) }
    : emptySection(title, emptyMessage)];
}

function sessionsDetail(value: unknown): TerminalInspectionDetail {
  const items = records(value);
  return {
    kind: "inspection",
    command: "/sessions",
    title: "Sessions",
    summary: items.length ? `${plural(items.length, "retained branch")} in this workspace.` : "No retained work in this workspace.",
    sections: items.length ? [{
      title: "Retained work",
      rows: items.map(item => {
        const session = string(item.sessionName, "Unnamed session");
        const branch = string(item.branchName, "unnamed branch");
        const unresolved = number(item.unresolvedWork) ?? 0;
        return {
          label: `${session} / ${branch}`,
          value: `${displayStatus(item.status)} · ${model(item.model)}`,
          ...(([
            string(item.taskSummary),
            unresolved ? `${plural(unresolved, "unresolved item")} · ${number(item.activeGoals) ?? 0} active goals` : "",
          ].filter(Boolean).join("\n")) ? { detail: [
            string(item.taskSummary),
            unresolved ? `${plural(unresolved, "unresolved item")} · ${number(item.activeGoals) ?? 0} active goals` : "",
          ].filter(Boolean).join("\n") } : {}),
          tone: unresolved ? "warning" : markerTone(item.status),
        };
      }),
    }] : [emptySection("Retained work", "No sessions yet.")],
    raw: value,
  };
}

function snapshotDetail(value: unknown): TerminalInspectionDetail {
  const state = record(value);
  const branch = record(state.branch);
  const effects = records(Object.values(record(state.effects)));
  const runs = records(Object.values(record(state.agentRuns)));
  const activeRuns = runs.filter(item => !["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(string(item.status)));
  const unknownEffects = effects.filter(item => item.status === "unknown");
  return {
    kind: "inspection",
    command: "/snapshot",
    title: "Workspace snapshot",
    summary: "Current projected state. Internal records are available with R.",
    sections: [{
      title: "Branch",
      rows: [
        { label: string(state.sessionName, "Unnamed session"), value: string(branch.name, "unnamed branch") },
        { label: "Model", value: model(state.model) },
        { label: "Session", value: displayStatus(state.status), tone: markerTone(state.status) },
      ],
    }, {
      title: "Retained state",
      rows: [
        { label: "Conversation", value: plural(records(state.messages).length, "message") },
        { label: "Notebook", value: plural(Object.keys(record(state.cells)).length, "cell") },
        { label: "Runs", value: `${runs.length} total · ${activeRuns.length} active` },
        { label: "Effects", value: `${effects.length} total · ${unknownEffects.length} unknown`, tone: unknownEffects.length ? "warning" : "normal" },
        { label: "Agents", value: plural(Object.keys(record(state.tasks)).length, "child task") },
        { label: "Goals", value: plural(Object.keys(record(state.goals)).length, "goal") },
      ],
    }],
    raw: value,
  };
}

function budgetDetail(value: unknown): TerminalInspectionDetail {
  const budget = record(value);
  const limits = record(budget.limits);
  const usage = [
    ["Turns", budget.turns, limits.turnLimit],
    ["Tokens", budget.tokens, limits.tokenLimit],
    ["Cost", budget.costUsd, limits.costLimitUsd],
    ["Wall time", budget.wallTimeMs, limits.wallTimeLimitMs],
  ] as const;
  return {
    kind: "inspection",
    command: "/budget",
    title: "Budget",
    summary: bool(budget.exceeded) ? "A committed budget limit has been exceeded." : "Committed usage remains within configured limits.",
    sections: [{
      title: "Usage",
      rows: usage.map(([label, used, limit]) => ({
        label,
        value: label === "Cost"
          ? `$${number(used)?.toFixed(4) ?? "0.0000"}${number(limit) === null ? "" : ` / $${number(limit)!.toFixed(4)}`}`
          : label === "Wall time"
            ? `${duration(used)}${number(limit) === null ? "" : ` / ${duration(limit)}`}`
            : `${number(used) ?? 0}${number(limit) === null ? "" : ` / ${number(limit)}`}`,
        tone: bool(budget.exceeded) ? "warning" : "normal",
      })),
    }],
    raw: value,
  };
}

function cellsDetail(command: string, value: unknown): TerminalInspectionDetail {
  const items = Array.isArray(value) ? records(value) : [record(value)];
  return {
    kind: "inspection",
    command,
    title: command === "/cells" ? "Notebook cells" : "Cell result",
    summary: command === "/cells" ? `${plural(items.length, "retained cell")}.` : "The diagnostic cell reached a durable boundary.",
    sections: listSections("Cells", items, (item, index) => {
      const code = string(item.code).split("\n").find(line => line.trim())?.trim();
      const status = item.status ?? (item.error ? "failed" : "committed");
      const result = item.result ?? item.output;
      const logs = Array.isArray(item.logs) ? item.logs.length : 0;
      return {
        label: code ? `${index + 1}. ${oneLine(code, 90)}` : `Cell ${index + 1}`,
        value: displayStatus(status),
        detail: item.error ? sentence(item.error) : result === undefined ? `${logs} log lines` : `Result: ${sentence(result)}${logs ? ` · ${logs} log lines` : ""}`,
        tone: markerTone(status),
      };
    }, "No retained cells."),
    raw: value,
  };
}

function tasksRows(value: unknown): TerminalDetailRow[] {
  const items = Array.isArray(value) ? records(value) : Object.keys(record(value)).length ? [record(value)] : [];
  return items.map(item => ({
    label: sentence(item.task, 100),
    value: `${displayStatus(item.status)} · ${model(item.model)}`,
    detail: sentence(item.result ?? item.error ?? item.reason ?? item.completionCriteria, 220),
    tone: bool(item.cancellationRequested) ? "warning" : markerTone(item.status),
  }));
}

function mailboxRows(value: unknown): TerminalDetailRow[] {
  const source = record(value);
  return records(source.items ?? value).map(item => {
    const sender = string(item.senderName, string(item.relationship, "Family member"));
    const recipient = string(item.recipientName, "current agent");
    return {
      label: `${sender} → ${recipient}`,
      value: `${displayStatus(item.receiptStatus)}${bool(item.acknowledged) ? " · acknowledged" : ""}`,
      detail: sentence(item.content, 260),
      tone: item.error ? "danger" : markerTone(item.receiptStatus),
    };
  });
}

function familyDetail(command: string, value: unknown): TerminalInspectionDetail {
  const source = record(value);
  const family = records(record(source.family).items ?? source.items);
  const taskRows = tasksRows(source.tasks ?? (command === "/tasks" || command === "/cancel-task" ? value : []));
  const messages = mailboxRows(source.mailbox ?? (command === "/mailbox" ? value : []));
  const sections: TerminalDetailSection[] = [];
  if (command === "/agents" || command === "/tree") {
    sections.push(family.length ? {
      title: `Family · ${family.length}`,
      rows: family.map(item => {
        const activity = string(item.activity, string(item.taskStatus, string(item.status, "unknown")));
        const detail = [
          item.task ? sentence(item.task, 180) : "",
          item.activityReason ? displayStatus(item.activityReason) : "",
          bool(item.cancellationRequested) ? "Cancellation requested" : "",
        ].filter(Boolean).join("\n");
        return {
          label: string(item.name, titleCase(string(item.relationship, "agent"))),
          value: `${displayStatus(item.relationship)} · ${displayStatus(activity)}`,
          ...(detail ? { detail } : {}),
          tone: ["attention", "unavailable"].includes(activity)
            ? "danger" as const
            : ["working", "waiting"].includes(activity)
              ? "warning" as const
              : activity === "ended"
                ? "muted" as const
                : markerTone(activity),
        };
      }),
    } : emptySection("Family", "No retained family relationships."));
  }
  if (command !== "/mailbox") sections.push(taskRows.length ? { title: `Tasks · ${taskRows.length}`, rows: taskRows } : emptySection("Tasks", "No child tasks."));
  if (command !== "/tasks" && command !== "/cancel-task") sections.push(messages.length ? { title: `Mailbox · ${messages.length}`, rows: messages } : emptySection("Mailbox", "No retained family messages."));
  return {
    kind: "inspection",
    command,
    title: command === "/mailbox" ? "Mailbox" : command === "/tasks" || command === "/cancel-task" ? "Child tasks" : "Agent family",
    summary: "Durable family work and communication for this branch.",
    sections,
    raw: value,
  };
}

function goalsDetail(command: string, value: unknown): TerminalInspectionDetail {
  const items = Array.isArray(value) ? records(value) : [record(value)];
  return {
    kind: "inspection",
    command,
    title: "Goals",
    summary: items.length ? "Autonomous objectives and current completion evidence." : "No goals are retained on this branch.",
    sections: listSections("Goals", items, item => {
      const gates = records(item.gates);
      const attention = gates.filter(gate => ["failed", "unknown", "running"].includes(string(gate.status)));
      return {
        label: sentence(item.description, 120),
        value: displayStatus(item.status),
        detail: [
          item.completionCriteria ? `Completion: ${sentence(item.completionCriteria, 160)}` : "",
          gates.length ? `${gates.length} gates · ${attention.length} need attention` : "No completion gates",
          item.reason ? sentence(item.reason) : "",
        ].filter(Boolean).join("\n"),
        tone: attention.length ? "warning" : markerTone(item.status),
      };
    }, "No retained goals."),
    raw: value,
  };
}

function heartbeatsDetail(command: string, value: unknown): TerminalInspectionDetail {
  const items = Array.isArray(value) ? records(value) : [record(value)];
  return {
    kind: "inspection",
    command,
    title: "Heartbeats",
    summary: items.length ? "Durable interval wakes for this branch." : "No heartbeats are configured.",
    sections: listSections("Heartbeats", items, (item, index) => ({
      label: `${index + 1}. Every ${duration(item.intervalMs)}`,
      value: displayStatus(item.status),
      detail: `Next: ${dateTime(item.nextTickAt)}${item.prompt ? `\nPrompt: ${sentence(item.prompt, 180)}` : ""}`,
      tone: markerTone(item.status),
    }), "No configured heartbeats."),
    raw: value,
  };
}

function schedulesDetail(command: string, value: unknown): TerminalInspectionDetail {
  const items = Array.isArray(value) ? records(value) : [record(value)];
  return {
    kind: "inspection",
    command,
    title: "Schedules",
    summary: items.length ? "Durable one-time and recurring task prompts." : "No schedules are configured.",
    sections: listSections("Schedules", items, (item, index) => ({
      label: `${index + 1}. ${sentence(item.prompt, 120)}`,
      value: displayStatus(item.status),
      detail: `${item.kind === "interval" ? `Every ${duration(item.intervalMs)} · ` : ""}Next: ${dateTime(item.nextTickAt)}`,
      tone: markerTone(item.status),
    }), "No configured schedules."),
    raw: value,
  };
}

function memoryDetail(value: unknown): TerminalInspectionDetail {
  const source = record(value);
  const selections = records(source.items);
  const items = selections.length && record(selections[0]?.record).current
    ? selections.map(item => record(item.record))
    : Array.isArray(value) ? records(value) : selections;
  return {
    kind: "inspection",
    command: "/memory",
    title: "Memory",
    summary: source.provenance ? `${plural(items.length, "selection")} from deterministic retrieval.` : `${plural(items.length, "visible memory entry")}.`,
    sections: listSections("Entries", items, item => {
      const current = record(item.current);
      return {
        label: string(item.name, "Unnamed memory"),
        value: `${displayStatus(item.kind)} · ${displayStatus(item.scope)} · ${displayStatus(current.status)}`,
        detail: sentence(record(current.content).text ?? current.content, 260),
        tone: markerTone(current.status),
      };
    }, "No matching memory."),
    raw: value,
  };
}

function skillsDetail(command: string, value: unknown): TerminalInspectionDetail {
  const items = Array.isArray(value) ? records(value) : [record(value)];
  const first = items[0] ?? {};
  if (command === "/skills-preview") {
    const bundle = record(first.bundle);
    const warning = record(bundle.warning);
    return {
      kind: "inspection",
      command,
      title: "Skill import preview",
      summary: sentence(warning.message, 300),
      sections: [{
        title: "Candidate",
        rows: [
          { label: string(first.name, string(bundle.name, "Unnamed skill")), value: "not installed", tone: "warning" },
          { label: "Confirmation digest", value: string(first.confirmationDigest, "—"), detail: "Required unchanged by /skills install." },
        ],
      }],
      raw: value,
    };
  }
  const isTest = "compiled" in first || "outcome" in first;
  return {
    kind: "inspection",
    command,
    title: isTest ? "Skill result" : "Skills",
    summary: isTest ? "Durable skill execution or test outcome." : `${plural(items.length, "visible skill")}.`,
    sections: listSections(isTest ? "Result" : "Catalog", items, item => {
      if (isTest) {
        return {
          label: item.compiled === undefined ? "Invocation" : `Tests: ${number(item.passed) ?? 0} passed · ${number(item.failed) ?? 0} failed`,
          value: displayStatus(item.outcome),
          detail: sentence(item.output ?? item.error),
          tone: markerTone(item.outcome),
        };
      }
      return {
        label: string(item.name, "Unnamed skill"),
        value: `${displayStatus(item.availability)} · ${displayStatus(item.scope)} · ${displayStatus(item.source)}`,
        detail: `${sentence(item.description, 180)}${Array.isArray(item.permissions) && item.permissions.length ? `\nPermissions: ${item.permissions.join(", ")}` : ""}`,
        tone: markerTone(item.availability),
      };
    }, "No skills are visible."),
    raw: value,
  };
}

function refinementDetail(command: string, value: unknown): TerminalInspectionDetail {
  const source = record(value);
  const reviews = records(source.reviews);
  const proposals = records(source.proposals);
  const items = reviews.length || proposals.length ? [...reviews, ...proposals] : Array.isArray(value) ? records(value) : [source];
  const sections: TerminalDetailSection[] = [];
  if (reviews.length) sections.push({
    title: `Reviews · ${reviews.length}`,
    rows: reviews.map(item => statusRow(
      string(item.instructions, `${displayStatus(item.mode)} review`),
      item.status,
      item.reason ?? `${records(item.sourceEventIds).length || (Array.isArray(item.sourceEventIds) ? item.sourceEventIds.length : 0)} source events`,
    )),
  });
  if (proposals.length) sections.push({
    title: `Proposals · ${proposals.length}`,
    rows: proposals.map(item => statusRow(
      sentence(item.predictedEffect, 140),
      item.status,
      `${Array.isArray(item.edits) ? item.edits.length : 0} edits · authority ${displayStatus(item.authority)}`,
    )),
  });
  if (!sections.length) sections.push({
    title: "Result",
    rows: items.map(item => {
      const policy = typeof item.automatic === "boolean";
      return statusRow(
        policy ? "Automatic refinement" : string(item.predictedEffect, string(item.instructions, string(item.mode, "Refinement"))),
        item.status ?? (policy ? item.automatic ? "enabled" : "disabled" : item.enabled === undefined ? "recorded" : item.enabled ? "enabled" : "disabled"),
        policy
          ? `Scope: ${displayStatus(item.scope)} · effect failures ${bool(record(item.effectFailure).enabled) ? "enabled" : "disabled"} · gate failures ${bool(record(item.completionGateFailure).enabled) ? "enabled" : "disabled"}`
          : item.reason ?? (item.correctionId ? "User correction recorded." : undefined),
      );
    }),
  });
  return {
    kind: "inspection",
    command,
    title: "Refinement",
    summary: "Attributable review, proposal, and policy state.",
    sections,
    raw: value,
  };
}

function contextDetail(command: string, value: unknown): TerminalInspectionDetail {
  const item = record(value);
  const inspection = "canonicalEventCount" in item;
  const effective = record(item.effective);
  const compaction = inspection ? effective : item;
  const rows: TerminalDetailRow[] = inspection ? [
    { label: "Canonical history", value: `${number(item.canonicalEventCount) ?? 0} events · ${number(item.messageCount) ?? 0} messages` },
    { label: "Uncovered narrative", value: `${number(item.uncoveredMessageCount) ?? 0} messages · ~${number(item.estimatedUncompactedNarrativeTokens) ?? 0} tokens` },
    { label: "Capacity", value: oneLine(item.capacity) },
  ] : [];
  if (Object.keys(compaction).length) rows.push(
    statusRow("Effective compaction", compaction.status, `${displayStatus(compaction.strategy)} · through cursor ${string(compaction.throughCursor, "—")}`),
  );
  return {
    kind: "inspection",
    command,
    title: inspection ? "Context" : "Context compaction",
    summary: inspection ? "Current context capacity and source-linked compaction coverage." : "A source-linked context derivation reached a durable state.",
    sections: [{ title: "Context", rows: rows.length ? rows : [{ label: "No effective compaction.", tone: "muted" }] }],
    raw: value,
  };
}

function syncDetail(command: string, value: unknown): TerminalInspectionDetail {
  const source = record(value);
  const conflicts = Array.isArray(value) ? records(value) : records(source.conflicts);
  if (command === "/conflicts" || command === "/resolve-conflict") {
    const items = Array.isArray(value) ? records(value) : [source];
    return {
      kind: "inspection",
      command,
      title: "Sync conflicts",
      summary: items.length ? "Conflicts require an explicit retained resolution." : "No unresolved sync conflicts.",
      sections: listSections("Conflicts", items, (item, index) => ({
        label: `${index + 1}. ${displayStatus(item.kind)}`,
        value: displayStatus(item.status),
        detail: `Conflict ID: ${string(item.conflictId, "—")}\nDetected: ${dateTime(item.detectedAt)}`,
        tone: markerTone(item.status === "unresolved" ? "warning" : item.status),
      }), "No unresolved conflicts."),
      raw: value,
    };
  }
  const status = record(source.status ?? source.replica);
  const capabilities = record(source.capabilities);
  const cycle = "staged" in source || "ingested" in source;
  return {
    kind: "inspection",
    command,
    title: cycle ? "Sync complete" : "Sync status",
    summary: capabilities.configured === false || status.lifecycle === "local_only"
      ? "Local-only operation; no network replica is configured."
      : `Replica is ${displayStatus(status.lifecycle)}.`,
    sections: [{
      title: cycle ? "Cycle" : "Replica",
      rows: cycle ? [
        { label: "Staged", value: String(number(source.staged) ?? 0) },
        { label: "Ingested", value: String(number(source.ingested) ?? 0) },
        { label: "Duplicates", value: String(number(source.duplicates) ?? 0) },
        { label: "Quarantined", value: String(number(source.quarantined) ?? 0), tone: number(source.quarantined) ? "warning" : "normal" },
        { label: "Conflicts", value: String(number(source.conflicts) ?? 0), tone: number(source.conflicts) ? "warning" : "normal" },
      ] : [
        statusRow("Lifecycle", status.lifecycle),
        { label: "Network sync", value: bool(capabilities.networkSync) ? "available" : "unavailable" },
        { label: "Staged envelopes", value: String(number(status.stagedEnvelopes) ?? 0) },
        { label: "Quarantine", value: String(number(source.quarantineCount ?? status.quarantinedEnvelopes) ?? 0), tone: number(source.quarantineCount ?? status.quarantinedEnvelopes) ? "warning" : "normal" },
        { label: "Conflicts", value: String(conflicts.length), tone: conflicts.length ? "warning" : "normal" },
      ],
    }],
    raw: value,
  };
}

function unknownEffectsDetail(command: string, value: unknown): TerminalInspectionDetail {
  const items = Array.isArray(value) ? records(value) : [record(value)];
  return {
    kind: "inspection",
    command,
    title: command === "/reconcile" ? "Unknown-effect assessment" : "Unknown effects",
    summary: items.length ? "Unknown outcomes are retained and never retried automatically." : "No unknown effects require assessment.",
    sections: listSections("Effects", items, item => {
      const effect = record(item.effect);
      const assessments = records(item.assessments);
      return {
        label: `${displayStatus(effect.executor)} · ${displayStatus(effect.operation)}`,
        value: command === "/reconcile" ? displayStatus(item.assessment) : "unknown",
        detail: [
          `Effect ID: ${string(item.effectId, string(effect.id, "—"))}`,
          item.summary ? sentence(item.summary) : "",
          `${assessments.length} retained assessments · retry not allowed`,
        ].filter(Boolean).join("\n"),
        tone: item.assessment === "succeeded" || item.assessment === "no_effect" ? "warning" : "danger",
      };
    }, "No unknown effects."),
    raw: value,
  };
}

function historyDetail(value: unknown): TerminalInspectionDetail {
  const events = Array.isArray(value) ? value as AgentEvent[] : [];
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  return {
    kind: "inspection",
    command: "/history",
    title: "History",
    summary: `${plural(events.length, "canonical event")}. Payloads and internal IDs are available with R.`,
    sections: [{
      title: "Event types",
      rows: [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12)
        .map(([type, count]) => ({ label: titleCase(type), value: String(count) })),
    }, {
      title: "Recent events",
      rows: events.slice(-12).reverse().map(event => ({
        label: titleCase(event.type),
        value: `cursor ${event.cursor}`,
        tone: event.type.includes("Failed") || event.type.includes("Unknown") ? "warning" : "normal",
      })),
    }],
    raw: value,
  };
}

function helpDetail(value: unknown): TerminalInspectionDetail {
  const commands = records(value);
  const categories = ["product", "status", "notebook", "autonomy", "operations"];
  return {
    kind: "inspection",
    command: "/help",
    title: "Commands",
    summary: "Type a command in the composer. Ctrl-P opens searchable command help.",
    sections: categories.map(category => ({
      title: titleCase(category),
      rows: commands.filter(item => item.category === category).map(item => ({
        label: string(item.usage),
        detail: string(item.summary),
      })),
    })),
    raw: value,
  };
}

function infoDetail(value: unknown): TerminalInspectionDetail {
  const source = record(value);
  const state = record(source.state);
  const capabilities = record(source.capabilities);
  const recovery = record(source.recovery);
  const provider = records(capabilities.providers).find(item => item.name === record(state.model).provider);
  const sync = record(capabilities.sync);
  const pending = Array.isArray(recovery.pendingEffectIds) ? recovery.pendingEffectIds.length : 0;
  const unknown = Array.isArray(recovery.unknownEffects) ? recovery.unknownEffects.length : 0;
  const children = Array.isArray(recovery.activeChildTaskIds) ? recovery.activeChildTaskIds.length : 0;
  const gates = Array.isArray(recovery.attentionGoalGateIds) ? recovery.attentionGoalGateIds.length : 0;
  return {
    kind: "inspection",
    command: "/info",
    title: "Workspace status",
    summary: "Protocol-backed trusted-local client. Generated code is not sandboxed.",
    sections: [{
      title: "Session",
      rows: [
        { label: string(state.sessionName, "Unnamed session"), value: string(record(state.branch).name, "unnamed branch") },
        { label: "Model", value: model(state.model), detail: bool(record(provider).capabilities && record(record(provider).capabilities).streaming) ? "Incremental progress" : "Committed responses only" },
        { label: "Connection", value: string(source.connection, "connected"), tone: markerTone(source.connection) },
      ],
    }, {
      title: "Recovery",
      rows: [
        { label: "Pending effects", value: String(pending), tone: pending ? "warning" : "normal" },
        { label: "Unknown effects", value: String(unknown), tone: unknown ? "danger" : "normal" },
        { label: "Active children", value: String(children) },
        { label: "Gate attention", value: String(gates), tone: gates ? "warning" : "normal" },
      ],
    }, {
      title: "Capabilities",
      rows: [
        { label: "Snapshot resume", value: bool(capabilities.snapshotCursorResume) ? "available" : "unavailable" },
        { label: "Sync", value: bool(sync.configured) ? "configured" : "local only" },
        { label: "Authority", value: "TRUSTED-LOCAL · not sandboxed", tone: "warning" },
      ],
    }],
    raw: value,
  };
}

function genericDetail(command: string, value: unknown): TerminalInspectionDetail {
  const source = record(value);
  const rows: TerminalDetailRow[] = [];
  for (const [key, item] of Object.entries(source)) {
    if (INTERNAL_FIELD.test(key) || item === undefined || typeof item === "object") continue;
    rows.push({
      label: titleCase(key),
      value: typeof item === "boolean" ? item ? "yes" : "no" : oneLine(item),
      tone: key.toLowerCase().includes("status") || key.toLowerCase().includes("outcome") ? markerTone(item) : "normal",
    });
  }
  if (!rows.length) {
    const count = Array.isArray(value) ? value.length : Object.keys(source).length;
    rows.push({ label: count ? `${plural(count, "record")}.` : "Command completed.", tone: "muted" });
  }
  return {
    kind: "inspection",
    command,
    title: titleCase(command.replace(/^\//, "") || "Result"),
    summary: "Command result. Advanced fields are available with R.",
    sections: [{ title: "Result", rows: rows.slice(0, 16) }],
    raw: value,
  };
}

export function buildTerminalDetail(command: string, value: unknown): TerminalInspectionDetail {
  if (command === "/sessions") return sessionsDetail(value);
  if (command === "/snapshot" || command === "/history-snapshot") return snapshotDetail(value);
  if (command === "/budget") return budgetDetail(value);
  if (command === "/cells" || command === "/cell") return cellsDetail(command, value);
  if (["/agents", "/tree", "/mailbox", "/tasks", "/cancel-task"].includes(command)) return familyDetail(command, value);
  if (command === "/goal" || command === "/goals") return goalsDetail(command, value);
  if (command === "/heartbeat" || command === "/heartbeats") return heartbeatsDetail(command, value);
  if (command === "/schedule" || command === "/schedules") return schedulesDetail(command, value);
  if (command === "/memory") return memoryDetail(value);
  if (command.startsWith("/skill")) return skillsDetail(command, value);
  if (command === "/refine" || command === "/rollback") return refinementDetail(command, value);
  if (command === "/context" || command === "/compact") return contextDetail(command, value);
  if (["/sync", "/sync-status", "/conflicts", "/resolve-conflict"].includes(command)) return syncDetail(command, value);
  if (command === "/unknown" || command === "/reconcile") return unknownEffectsDetail(command, value);
  if (command === "/history") return historyDetail(value);
  if (command === "/help") return helpDetail(value);
  if (command === "/info") return infoDetail(value);
  return genericDetail(command, value);
}

export function buildTerminalModelDetail(input: {
  readonly current: ModelConfiguration;
  readonly workspaceDefault: string | null;
  readonly providers: readonly ModelProviderDescriptor[];
}): TerminalModelDetail {
  const providers = input.providers.filter(provider => provider.name !== "echo").map(provider => ({
    name: provider.name,
    displayName: provider.displayName,
    usable: provider.usable,
    credentialSource: provider.credentialSource,
    credentialLabel: provider.credentialSource === "stored"
      ? "saved"
      : provider.credentialSource === "environment"
        ? "environment"
        : provider.credentialSource === "programmatic"
          ? "available"
          : "not configured",
    ...(provider.remediation === undefined ? {} : { remediation: provider.remediation }),
    credentialManaged: ["openai", "anthropic", "vercel"].includes(provider.name),
  }));
  return {
    kind: "model",
    command: "/model",
    title: "Model",
    current: input.current,
    workspaceDefault: input.workspaceDefault,
    providers,
    raw: {
      current: `${input.current.provider}:${input.current.model}`,
      workspaceDefault: input.workspaceDefault,
      providers: providers.map(provider => ({
        name: provider.name,
        displayName: provider.displayName,
        usable: provider.usable,
        credentialSource: provider.credentialSource,
        ...(provider.remediation === undefined ? {} : { remediation: provider.remediation }),
      })),
    },
  };
}

function safeRaw(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeRaw);
  if (value === null || typeof value !== "object") return typeof value === "string" ? scrubText(value) : value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as UnknownRecord)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replaceAll("-", "_");
    output[key] = RAW_SECRET_FIELD.test(normalizedKey) ? "[REDACTED]" : safeRaw(item);
  }
  return output;
}

export function formatTerminalRaw(value: unknown): string {
  try {
    return JSON.stringify(safeRaw(value), null, 2) ?? String(value);
  } catch {
    return "[Raw diagnostic value could not be serialized]";
  }
}

function toneMarker(tone: TerminalDetailTone | undefined): string {
  if (tone === "success") return "✓";
  if (tone === "warning") return "!";
  if (tone === "danger") return "×";
  if (tone === "muted") return "○";
  return "•";
}

export function formatTerminalDetail(detail: TerminalDetail, options: { raw?: boolean; footer?: boolean } = {}): string {
  if (detail.kind === "raw" || options.raw) {
    const title = detail.kind === "raw" ? detail.title : `${detail.title} · RAW`;
    return `${title.toUpperCase()}\n\n${formatTerminalRaw(detail.raw)}`;
  }
  if (detail.kind === "model") {
    const currentProvider = detail.providers.find(provider => provider.name === detail.current.provider);
    const lines = [
      "MODEL",
      "",
      "Current",
      `${currentProvider?.usable ? "✓" : "!"} ${currentProvider?.displayName ?? detail.current.provider}`,
      `  ${detail.current.model}`,
      `  Credential: ${currentProvider?.credentialLabel ?? "unavailable"}`,
      "",
      "Workspace default",
      `  ${detail.workspaceDefault ?? "Not set"}`,
      "",
      "Providers",
      ...detail.providers.map(provider => `${provider.usable ? "✓" : "○"} ${provider.displayName} — ${provider.credentialLabel}`),
    ];
    if (options.footer !== false) lines.push("", "Enter choose · L login · X logout · Shift-R raw · Esc close");
    return lines.join("\n");
  }
  const lines = [detail.title.toUpperCase()];
  if (detail.summary) lines.push("", detail.summary);
  for (const section of detail.sections) {
    lines.push("", section.title);
    for (const row of section.rows) {
      lines.push(`${toneMarker(row.tone)} ${row.label}${row.value === undefined ? "" : ` — ${row.value}`}`);
      if (row.detail && row.detail !== "—") {
        for (const detailLine of row.detail.split("\n")) lines.push(`  ${detailLine}`);
      }
    }
  }
  if (options.footer !== false) lines.push("", "Shift-R raw diagnostics · PgUp/PgDn scroll · Esc close");
  return lines.join("\n");
}

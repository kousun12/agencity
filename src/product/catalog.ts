import {
  ValidationError,
  projectEvents,
  type AgentEvent,
  type ModelConfiguration,
  type SessionStatus,
} from "../domain/index.ts";
import type { Supervisor } from "../runtime/index.ts";
import { workspacePreferenceKey } from "./workspace.ts";

export interface ProductBranchSummary {
  readonly sessionId: string;
  readonly branchId: string;
  readonly sessionName: string;
  readonly branchName: string;
  readonly model: ModelConfiguration;
  readonly status: SessionStatus;
  readonly taskSummary: string | null;
  readonly activeGoals: number;
  readonly unresolvedWork: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly root: boolean;
  readonly initialBranch: boolean;
}

export interface ProductSelection { readonly sessionId: string; readonly branchId: string; }

export class ProductCatalog {
  constructor(readonly supervisor: Supervisor, readonly workspaceId: string) {}

  async list(): Promise<ProductBranchSummary[]> {
    const routes = await this.supervisor.storage.listBranches();
    const histories = await Promise.all(routes.map(async route => ({
      route,
      events: await this.supervisor.storage.loadEvents(route.sessionId, { branchId: route.branchId }),
    })));
    const inWorkspace = histories.filter(({ events }) => {
      const created = events.find(event => event.type === "SessionCreated");
      return created && (created.payload as { workspaceId: string }).workspaceId === this.workspaceId;
    });
    const sessionNames = new Map<string, string>();
    for (const { route, events } of inWorkspace) {
      const latestName = latestNamed(events, "SessionNamed");
      const created = events.find(event => event.type === "SessionCreated")!;
      const initial = (created.payload as { sessionName?: string }).sessionName;
      const candidate = latestName ?? initial ?? firstTask(events) ?? `session-${route.sessionId.slice(-6)}`;
      const old = sessionNames.get(route.sessionId);
      // A rename on any branch is a session display-name change. The event order
      // is resolved globally below instead of relying on incidental branch order.
      if (!old) sessionNames.set(route.sessionId, candidate);
    }
    for (const sessionId of new Set(inWorkspace.map(item => item.route.sessionId))) {
      const all = inWorkspace.filter(item => item.route.sessionId === sessionId).flatMap(item => item.events);
      const unique = new Map(all.map(event => [event.id, event]));
      const name = latestNamed([...unique.values()], "SessionNamed");
      if (name) sessionNames.set(sessionId, name);
    }
    const summaries: ProductBranchSummary[] = [];
    for (const { route, events } of inWorkspace) {
      if (!events.length) continue;
      const state = projectEvents(events);
      const created = events.find(event => event.type === "SessionCreated")!;
      const createdPayload = created.payload as { initialBranchId: string; initialBranchName?: string; parentSessionId?: string };
      const branchCreated = [...events].reverse().find(event => event.type === "BranchCreated" && event.branchId === route.branchId);
      const renamed = latestNamed(events.filter(event => event.branchId === route.branchId), "BranchNamed");
      const branchName = renamed
        ?? (branchCreated?.payload as { name?: string } | undefined)?.name
        ?? (createdPayload.initialBranchId === route.branchId ? createdPayload.initialBranchName ?? "main" : undefined)
        ?? `branch-${route.branchId.slice(-6)}`;
      const unresolvedEffects = Object.values(state.effects).filter(effect => ["requested", "started", "failed", "unknown"].includes(effect.status)).length;
      const unresolvedTasks = Object.values(state.tasks).filter(task => !["completed", "cancelled"].includes(task.status)).length;
      const activeGoals = Object.values(state.goals).filter(goal => ["active", "completion_requested", "blocked"].includes(goal.status)).length;
      summaries.push({
        sessionId: route.sessionId,
        branchId: route.branchId,
        sessionName: sessionNames.get(route.sessionId)!,
        branchName,
        model: state.model,
        status: state.status,
        taskSummary: firstTask(events),
        activeGoals,
        unresolvedWork: unresolvedEffects + unresolvedTasks + activeGoals,
        createdAt: created.committedAt,
        updatedAt: events.at(-1)!.committedAt,
        root: createdPayload.parentSessionId === undefined,
        initialBranch: createdPayload.initialBranchId === route.branchId,
      });
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId) || a.branchId.localeCompare(b.branchId));
  }

  async select(target?: string, explicitBranchId?: string): Promise<ProductSelection> {
    const candidates = (await this.list()).filter(candidate => candidate.status !== "archived" && candidate.status !== "failed");
    if (!candidates.length) throw new ValidationError("No resumable sessions exist in this workspace");
    if (target || explicitBranchId) {
      const selected = candidates.filter(candidate =>
        (!target || candidate.sessionId === target || candidate.sessionName === target || candidate.branchId === target || candidate.branchName === target)
        && (!explicitBranchId || candidate.branchId === explicitBranchId));
      if (selected.length !== 1) {
        throw new ValidationError(selected.length ? `Selection is ambiguous: ${target ?? explicitBranchId}` : `Session or branch not found in this workspace: ${target ?? explicitBranchId}`);
      }
      await this.remember(selected[0]!);
      return selected[0]!;
    }
    const recent = await this.supervisor.profile.getPreference(workspacePreferenceKey(this.workspaceId, "recent"));
    if (recent?.value && typeof recent.value === "object" && !Array.isArray(recent.value)) {
      const sessionId = recent.value.sessionId;
      const branchId = recent.value.branchId;
      if (typeof sessionId === "string" && typeof branchId === "string") {
        const selected = candidates.find(candidate => candidate.sessionId === sessionId && candidate.branchId === branchId);
        if (selected) return selected;
      }
    }
    // With no explicit preference, only a sole root's initial branch is safe.
    const roots = candidates.filter(candidate => candidate.root && candidate.initialBranch);
    if (roots.length !== 1) throw new ValidationError("Multiple sessions are plausible; choose one with `agencity sessions` or `agencity resume NAME`");
    await this.remember(roots[0]!);
    return roots[0]!;
  }

  async remember(selection: ProductSelection): Promise<void> {
    await this.supervisor.profile.setPreference(workspacePreferenceKey(this.workspaceId, "recent"), {
      sessionId: selection.sessionId,
      branchId: selection.branchId,
    });
  }

  async rename(sessionId: string, branchId: string | undefined, name: string): Promise<void> {
    if (!name.trim()) throw new ValidationError("Display name cannot be empty");
    const candidates = await this.list();
    const selected = candidates.find(candidate => candidate.sessionId === sessionId && (!branchId || candidate.branchId === branchId));
    if (!selected) throw new ValidationError(`Session or branch not found in this workspace: ${sessionId}${branchId ? `/${branchId}` : ""}`);
    if (branchId) await this.supervisor.nameBranch(sessionId, branchId, name.trim());
    else await this.supervisor.nameSession(sessionId, selected.branchId, name.trim());
  }
}

export function deriveDisplayName(task: string): string {
  const normalized = task.replace(/\s+/g, " ").trim().replace(/^[\s:;,.!?-]+|[\s:;,.!?-]+$/g, "");
  if (!normalized) return "New session";
  const words = normalized.split(" ").slice(0, 8).join(" ");
  return words.length <= 56 ? words : `${words.slice(0, 53).trimEnd()}…`;
}

function firstTask(events: readonly AgentEvent[]): string | null {
  const message = events.find(event => event.type === "MessageAppended" && (event.payload as { role: string }).role === "user");
  if (message) return deriveDisplayName((message.payload as { content: string }).content);
  const childTask = events.find(event => event.type === "TaskCreated");
  return childTask ? deriveDisplayName((childTask.payload as { task: string }).task) : null;
}

function latestNamed(events: readonly AgentEvent[], type: "SessionNamed" | "BranchNamed"): string | undefined {
  const event = events
    .filter(candidate => candidate.type === type)
    .sort((a, b) => a.committedAt.localeCompare(b.committedAt) || Number(a.cursor) - Number(b.cursor))
    .at(-1);
  return (event?.payload as { name?: string } | undefined)?.name;
}

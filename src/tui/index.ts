import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Supervisor } from "../runtime/index.ts";

export class TerminalUI {
  constructor(readonly supervisor: Supervisor) {}
  async run(sessionId: string, branchId: string): Promise<void> {
    const rl = createInterface({ input, output }); let branch = branchId;
    output.write("Agencity trusted-local TUI. /help for commands.\n");
    try {
      while (true) {
        const line = (await rl.question(`${sessionId.slice(-6)}/${branch.slice(-6)}> `)).trim();
        if (!line) continue;
        if (line === "/quit" || line === "/exit") break;
        if (line === "/help") {
          output.write("/history /budget /snapshot /tree /tasks /goals /heartbeats /memory [query] /skills /refine <json> /rollback <proposal> <reason> /skill-test <entry> [version] /skill <entry> <json-input> /sync /sync-status /conflicts /resolve-conflict <id> <json> /cancel-task <id> [reason] /complete-goal <id> /cell <ts> /branch <cursor> [name] /quit\n");
          continue;
        }
        if (line === "/history") { for (const event of await this.supervisor.projections.history(sessionId, branch)) output.write(`${event.cursor} ${event.type} ${JSON.stringify(event.payload)}\n`); continue; }
        if (line === "/budget") { const { state } = await this.supervisor.projections.getSnapshot(sessionId, branch); output.write(`${JSON.stringify(state.budget, null, 2)}\n`); continue; }
        if (line === "/snapshot") { const snapshot = await this.supervisor.projections.getSnapshot(sessionId, branch); output.write(`${JSON.stringify(snapshot.state, null, 2)}\n`); continue; }
        if (line === "/tree") { await this.#writeTree(sessionId, ""); continue; }
        if (line === "/tasks") { output.write(`${JSON.stringify(await this.supervisor.agents.listTasks(sessionId, branch), null, 2)}\n`); continue; }
        if (line === "/goals") { const { state } = await this.supervisor.projections.getSnapshot(sessionId, branch); output.write(`${JSON.stringify(Object.values(state.goals), null, 2)}\n`); continue; }
        if (line === "/heartbeats") { const { state } = await this.supervisor.projections.getSnapshot(sessionId, branch); output.write(`${JSON.stringify(Object.values(state.heartbeats), null, 2)}\n`); continue; }
        if (line === "/memory" || line.startsWith("/memory ")) { const query=line.slice(7).trim(); output.write(`${JSON.stringify(query ? await this.supervisor.memory.search(sessionId,branch,query) : await this.supervisor.memory.list(sessionId,branch),null,2)}\n`); continue; }
        if (line === "/skills") { output.write(`${JSON.stringify(await this.supervisor.harness.list({kind:"skill"}),null,2)}\n`); continue; }
        if (line === "/sync") { output.write(`${JSON.stringify(await this.supervisor.sync.sync("manual"),null,2)}\n`); continue; }
        if (line === "/sync-status") { output.write(`${JSON.stringify(await this.supervisor.sync.status(),null,2)}\n`); continue; }
        if (line === "/conflicts") { output.write(`${JSON.stringify(await this.supervisor.sync.conflicts("unresolved"),null,2)}\n`); continue; }
        if (line.startsWith("/resolve-conflict ")) { const match=line.match(/^\/resolve-conflict\s+(\S+)\s+([\s\S]+)$/);if(match)output.write(`${JSON.stringify(await this.supervisor.sync.resolveConflict(match[1]!,JSON.parse(match[2]!)),null,2)}\n`);continue; }
        if (line.startsWith("/refine ")) { const proposal=await this.supervisor.harness.propose(sessionId,branch,JSON.parse(line.slice(8))); output.write(`${JSON.stringify(await this.supervisor.harness.validate(sessionId,branch,proposal.proposalId),null,2)}\n`); continue; }
        if (line.startsWith("/rollback ")) { const [,proposalId,...reason]=line.split(/\s+/); if(proposalId) output.write(`${JSON.stringify(await this.supervisor.harness.rollback(sessionId,branch,proposalId,reason.join(" ")),null,2)}\n`); continue; }
        if (line.startsWith("/skill-test ")) { const [,entryId,versionId]=line.split(/\s+/); if(entryId) output.write(`${JSON.stringify(await this.supervisor.skills.test(sessionId,branch,entryId,versionId),null,2)}\n`); continue; }
        if (line.startsWith("/skill ")) { const match=line.match(/^\/skill\s+(\S+)\s+([\s\S]+)$/); if(match) output.write(`${JSON.stringify(await this.supervisor.skills.invoke(sessionId,branch,match[1]!,JSON.parse(match[2]!)),null,2)}\n`); continue; }
        if (line.startsWith("/cancel-task ")) { const [, taskId, ...reason] = line.split(/\s+/); if (taskId) output.write(`${JSON.stringify(await this.supervisor.agents.cancel(sessionId, branch, taskId, reason.join(" ") || undefined), null, 2)}\n`); continue; }
        if (line.startsWith("/complete-goal ")) { const goalId = line.slice(15).trim(); if (goalId) output.write(`${JSON.stringify(await this.supervisor.goals.requestCompletion(sessionId, branch, goalId), null, 2)}\n`); continue; }
        if (line.startsWith("/cell ")) { const result = await this.supervisor.executeCell(sessionId, branch, line.slice(6)); output.write(`${JSON.stringify(result, null, 2)}\n`); continue; }
        if (line.startsWith("/branch ")) { const [, cursor, ...name] = line.split(/\s+/); if (!cursor) continue; branch = await this.supervisor.fork(sessionId, branch, cursor, name.join(" ") || undefined); output.write(`switched to branch ${branch}\n`); continue; }
        await this.supervisor.appendMessage(sessionId, branch, "user", line);
        const result = await this.supervisor.modelLoop.turn(sessionId, branch);
        output.write(`${result.message ?? `[${result.outcome}] ${result.error ?? ""}`}\n`);
      }
    } finally { rl.close(); }
  }

  async #writeTree(sessionId: string, indent: string): Promise<void> {
    const session = await this.supervisor.storage.getSession?.(sessionId);
    output.write(`${indent}${sessionId} depth=${session?.depth ?? "?"} status=${session?.status ?? "root"}\n`);
    for (const child of await this.supervisor.agents.listChildren(sessionId)) await this.#writeTree(child.sessionId, `${indent}  `);
  }
}

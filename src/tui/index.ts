import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Supervisor } from "../runtime/index.ts";

export class TerminalUI {
  constructor(readonly supervisor: Supervisor) {}
  async run(sessionId: string, branchId: string): Promise<void> {
    const rl = createInterface({ input, output }); let branch = branchId;
    output.write("Agencity trusted-local TUI. /help for commands.\n");
    const selected = (await this.supervisor.projections.getSnapshot(sessionId, branch)).state.model;
    const provider = this.supervisor.modelExecutor.providers().find((item) => item.name === selected.provider);
    output.write(`Model: ${provider?.displayName ?? selected.provider}/${selected.model}; live output ${provider?.capabilities.streaming ? "enabled" : "unavailable (committed responses only)"}.\n`);
    try {
      while (true) {
        const line = (await rl.question(`${sessionId.slice(-6)}/${branch.slice(-6)}> `)).trim();
        if (!line) continue;
        if (line === "/quit" || line === "/exit") break;
        if (line === "/help") {
          output.write("/history /budget /snapshot /tree /agents /mailbox /tasks /goals /goal [create DESCRIPTION|pause|resume|clear|complete] /heartbeats /heartbeat [create MS PROMPT|pause N|resume N|clear N] /schedules /schedule [once ISO PROMPT|every MS PROMPT|pause N|resume N|clear N] /memory [query] /skills /stop /cell <ts> /branch <cursor> [name] /resume [branch] /compact /quit\n");
          continue;
        }
        if (line === "/history") { for (const event of await this.supervisor.projections.history(sessionId, branch)) output.write(`${event.cursor} ${event.type} ${JSON.stringify(event.payload)}\n`); continue; }
        if (line === "/budget") { const { state } = await this.supervisor.projections.getSnapshot(sessionId, branch); output.write(`${JSON.stringify(state.budget, null, 2)}\n`); continue; }
        if (line === "/snapshot") { const snapshot = await this.supervisor.projections.getSnapshot(sessionId, branch); output.write(`${JSON.stringify(snapshot.state, null, 2)}\n`); continue; }
        if (line === "/tree") { await this.#writeTree(sessionId, ""); continue; }
        if (line === "/agents") { output.write(`${JSON.stringify((await this.supervisor.agents.listFamily(sessionId, branch)).items, null, 2)}\n`); continue; }
        if (line === "/mailbox") { const messages = await this.supervisor.agents.messages(sessionId, branch, { limit: 50 }); for (const message of messages.items) output.write(`${message.sentAt} ${message.relationship} ${message.senderName ?? message.fromSessionId} -> ${message.recipientName ?? message.toSessionId} [${message.receiptStatus}] ${message.content}${message.taskId ? ` task=${message.taskId}` : ""}${message.artifactIds.length ? ` artifacts=${message.artifactIds.join(",")}` : ""}\n`); continue; }
        if (line === "/tasks") { output.write(`${JSON.stringify(await this.supervisor.agents.listTasks(sessionId, branch), null, 2)}\n`); continue; }
        if (line === "/goals" || line === "/goal") { output.write(`${JSON.stringify(await this.supervisor.goals.list(sessionId, branch), null, 2)}\n`); continue; }
        if (line.startsWith("/goal ")) {
          const command = line.slice(6).trim();
          if (command.startsWith("create ")) output.write(`${JSON.stringify(await this.supervisor.goals.create(sessionId, branch, command.slice(7)), null, 2)}\n`);
          else { const current = await this.supervisor.goals.current(sessionId, branch); if (!current) output.write("No current goal.\n"); else if (command === "pause") output.write(`${JSON.stringify(await this.supervisor.goals.pause(sessionId, branch, current.goalId), null, 2)}\n`); else if (command === "resume") output.write(`${JSON.stringify(await this.supervisor.goals.resume(sessionId, branch, current.goalId), null, 2)}\n`); else if (command === "clear") output.write(`${JSON.stringify(await this.supervisor.goals.clear(sessionId, branch, current.goalId), null, 2)}\n`); else if (command === "complete") output.write(`${JSON.stringify(await this.supervisor.goals.requestCompletion(sessionId, branch, current.goalId), null, 2)}\n`); }
          continue;
        }
        if (line === "/heartbeats") { const items = await this.supervisor.heartbeats.list(sessionId, branch); items.forEach((item, index) => output.write(`${index + 1}) ${item.status} every ${item.intervalMs}ms next=${item.nextTickAt} owner=${item.owner} ${item.prompt ?? JSON.stringify(item.payload ?? "")}\n`)); continue; }
        if (line.startsWith("/heartbeat ")) {
          const command = line.slice(11).trim(); const create = /^create\s+(\d+)(?:\s+([\s\S]+))?$/.exec(command); const change = /^(pause|resume|clear)\s+(\d+)$/.exec(command);
          if (create) output.write(`${JSON.stringify(await this.supervisor.heartbeats.create(sessionId, branch, { intervalMs: Number(create[1]), ...(create[2] ? { prompt: create[2] } : {}) }), null, 2)}\n`);
          else if (change) { const item = (await this.supervisor.heartbeats.list(sessionId, branch))[Number(change[2]) - 1]; if (!item) output.write("Heartbeat number not found.\n"); else output.write(`${JSON.stringify(change[1] === "pause" ? await this.supervisor.heartbeats.pause(item.heartbeatId) : change[1] === "resume" ? await this.supervisor.heartbeats.resume(item.heartbeatId) : await this.supervisor.heartbeats.cancel(item.heartbeatId), null, 2)}\n`); }
          continue;
        }
        if (line === "/schedules") { const items = await this.supervisor.schedules.list(sessionId, branch); items.forEach((item, index) => output.write(`${index + 1}) ${item.status} ${item.kind}${item.intervalMs ? ` ${item.intervalMs}ms` : ""} next=${item.nextTickAt} owner=${item.owner} ${item.prompt}\n`)); continue; }
        if (line.startsWith("/schedule ")) {
          const command = line.slice(10).trim(); const once = /^once\s+(\S+)\s+([\s\S]+)$/.exec(command); const every = /^every\s+(\d+)\s+([\s\S]+)$/.exec(command); const change = /^(pause|resume|clear)\s+(\d+)$/.exec(command);
          if (once) output.write(`${JSON.stringify(await this.supervisor.schedules.create(sessionId, branch, { at: once[1]!, prompt: once[2]! }), null, 2)}\n`);
          else if (every) output.write(`${JSON.stringify(await this.supervisor.schedules.create(sessionId, branch, { intervalMs: Number(every[1]), prompt: every[2]! }), null, 2)}\n`);
          else if (change) { const item = (await this.supervisor.schedules.list(sessionId, branch))[Number(change[2]) - 1]; if (!item) output.write("Schedule number not found.\n"); else output.write(`${JSON.stringify(change[1] === "pause" ? await this.supervisor.schedules.pause(item.scheduleId) : change[1] === "resume" ? await this.supervisor.schedules.resume(item.scheduleId) : await this.supervisor.schedules.clear(item.scheduleId), null, 2)}\n`); }
          continue;
        }
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
        if (line === "/stop") {
          const snapshot = await this.supervisor.projections.getSnapshot(sessionId, branch);
          const active = Object.values(snapshot.state.agentRuns).find(run => !["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status));
          if (!active) output.write("No active agent run.\n");
          else output.write(`${JSON.stringify(await this.supervisor.runs.cancel(sessionId, branch, active.id, "User requested /stop"), null, 2)}\n`);
          continue;
        }
        if (line.startsWith("/cell ")) { const result = await this.supervisor.executeCell(sessionId, branch, line.slice(6)); output.write(`${JSON.stringify(result, null, 2)}\n`); continue; }
        if (line.startsWith("/branch ")) { const [, cursor, ...name] = line.split(/\s+/); if (!cursor) continue; branch = await this.supervisor.fork(sessionId, branch, cursor, name.join(" ") || undefined); output.write(`switched to branch ${branch}\n`); continue; }
        if (line === "/resume" || line.startsWith("/resume ")) { const requested=line.slice(7).trim()||branch;try{const resumed=await this.supervisor.resume(sessionId,requested);branch=requested;output.write(`resumed ${sessionId}/${branch} at ${resumed.cursor}\n`);}catch{output.write(`branch not found: ${requested}\n`);}continue; }
        if (line === "/compact") { output.write(`${JSON.stringify(await this.supervisor.compact(sessionId,branch),null,2)}\n`);continue; }
        const snapshot = await this.supervisor.projections.getSnapshot(sessionId, branch);
        const active = Object.values(snapshot.state.agentRuns).find(run => !["succeeded", "blocked", "failed", "cancelled", "budget_exceeded", "unknown"].includes(run.status));
        let result;
        if (active?.status === "waiting_for_user") {
          const request = Object.values(active.inputRequests).find(item => item.response === undefined);
          if (!request) throw new Error("Waiting agent run has no pending input request");
          const approved = request.kind === "permission" ? /^(y|yes|approve|approved)$/i.test(line) : undefined;
          result = await this.supervisor.runs.respond(sessionId, branch, active.id, request.id, {
            response: line,
            ...(approved === undefined ? {} : { approved }),
          });
        } else if (active) {
          output.write(`Run ${active.id} is already ${active.status}; use /stop or wait for its durable boundary.\n`);
          continue;
        } else {
          result = await this.supervisor.runs.start(sessionId, branch, { task: line, goalMode: "auto" });
        }
        if (result.status === "succeeded") output.write(`${result.final ?? ""}\n`);
        else if (result.status === "waiting_for_user") output.write(`[waiting_for_user] ${result.pendingInput?.question ?? result.reason ?? "User input required"}\n`);
        else output.write(`[${result.status}] ${result.reason ?? ""}\n`);
      }
    } finally { rl.close(); }
  }

  async #writeTree(sessionId: string, indent: string): Promise<void> {
    const session = await this.supervisor.storage.getSession?.(sessionId);
    output.write(`${indent}${sessionId} depth=${session?.depth ?? "?"} status=${session?.status ?? "root"}\n`);
    for (const child of await this.supervisor.agents.listChildren(sessionId)) await this.#writeTree(child.sessionId, `${indent}  `);
  }
}

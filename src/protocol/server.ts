import { AgentRuntimeError } from "../domain/index.ts";
import type { Supervisor } from "../runtime/index.ts";

export class ProtocolServer {
  #server: ReturnType<typeof Bun.serve> | null = null;
  constructor(readonly supervisor: Supervisor) {}

  listen(port = 0, hostname = "127.0.0.1"): ReturnType<typeof Bun.serve> {
    if (this.#server) return this.#server;
    this.#server = Bun.serve({ port, hostname, fetch: (request) => this.#fetch(request) });
    return this.#server;
  }
  stop(): void { this.#server?.stop(); this.#server = null; }

  async #fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url); const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, mode: "trusted-local" });
      if (request.method === "POST" && url.pathname === "/sessions") {
        const body = await request.json() as any;
        return Response.json(await this.supervisor.createSession({ workspaceId: String(body.workspaceId ?? "default"), ...(body.model ? { model: body.model } : {}), ...(body.budget ? { budget: body.budget } : {}) }));
      }
      if (parts[0] === "models" && parts[1]) {
        if (request.method === "GET") return Response.json(await this.supervisor.models.get(parts[1]));
        if (request.method === "POST" && parts[2] === "cancel") { const body = await jsonBody(request); return Response.json(await this.supervisor.models.cancel(parts[1], typeof body.reason === "string" ? body.reason : undefined)); }
      }
      if (parts[0] === "heartbeats" && parts[1] && request.method === "POST") {
        const body = await jsonBody(request);
        if (parts[2] === "tick") return Response.json(await this.supervisor.heartbeats.tick(parts[1], typeof body.at === "string" ? body.at : new Date()));
        if (parts[2] === "pause") return Response.json(await this.supervisor.heartbeats.pause(parts[1], typeof body.reason === "string" ? body.reason : undefined));
        if (parts[2] === "cancel") return Response.json(await this.supervisor.heartbeats.cancel(parts[1], typeof body.reason === "string" ? body.reason : undefined));
      }
      if (parts[0] === "harness") {
        if (request.method === "GET" && parts[1] === "refinements") return Response.json(await this.supervisor.harness.proposals(url.searchParams.get("status") as any ?? undefined));
        if (request.method === "GET" && parts[1] && parts[2] === "history") return Response.json(await this.supervisor.harness.history(parts[1]));
        if (request.method === "GET" && parts.length === 1) return Response.json(await this.supervisor.harness.list());
      }
      if (parts[0] === "sessions" && parts[1]) {
        const sessionId = parts[1]; const branchId = url.searchParams.get("branch") ?? parts[3];
        if (request.method === "GET" && parts[2] === "snapshot" && branchId) return Response.json(await this.supervisor.projections.getSnapshot(sessionId, branchId));
        if (request.method === "GET" && parts[2] === "history" && branchId) return Response.json(await this.supervisor.projections.history(sessionId, branchId));
        if (request.method === "GET" && parts[2] === "stream" && branchId) return this.#stream(sessionId, branchId, url.searchParams.get("after") ?? "0", request.signal);
        if (request.method === "POST" && parts[2] === "messages" && branchId) { const body = await jsonBody(request); return Response.json(await this.supervisor.appendMessage(sessionId, branchId, "user", String(body.content ?? ""))); }
        if (request.method === "POST" && parts[2] === "turns" && branchId) return Response.json(await this.supervisor.modelLoop.turn(sessionId, branchId));
        if (request.method === "POST" && parts[2] === "cells" && branchId) { const body = await jsonBody(request); return Response.json(await this.supervisor.executeCell(sessionId, branchId, String(body.code ?? ""))); }
        if (request.method === "POST" && parts[2] === "branches" && branchId) { const body = await jsonBody(request); return Response.json({ branchId: await this.supervisor.fork(sessionId, branchId, String(body.cursor), typeof body.name === "string" ? body.name : undefined) }); }

        // Slice 3 relational memory, measured harness refinement, exact skill
        // versions, and pinned reusable subagent specifications.
        if (parts[2] === "memory" && branchId) {
          if (request.method === "POST") return Response.json(await this.supervisor.memory.create(sessionId, branchId, await jsonBody(request) as any));
          if (request.method === "GET" && parts[3] === "list") return Response.json(await this.supervisor.memory.list(sessionId, branchId));
          if (request.method === "GET") {
            const split = (name: string) => url.searchParams.get(name)?.split(",").filter(Boolean);
            return Response.json(await this.supervisor.memory.search(sessionId, branchId, url.searchParams.get("query") ?? "", { ...(split("scopes") ? { scopes: split("scopes") as any } : {}), ...(split("statuses") ? { statuses: split("statuses") as any } : {}), ...(split("tags") ? { tags: split("tags")! } : {}), ...(split("linkedEntryIds") ? { linkedEntryIds: split("linkedEntryIds")! } : {}), ...(url.searchParams.has("since") ? { since: url.searchParams.get("since")! } : {}), ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}) }));
          }
        }
        if (parts[2] === "refinements" && branchId) {
          if (request.method === "POST" && parts.length === 3) return Response.json(await this.supervisor.harness.propose(sessionId, branchId, await jsonBody(request) as any));
          if (request.method === "POST" && parts[3] && parts[4] === "validate") return Response.json(await this.supervisor.harness.validate(sessionId, branchId, parts[3]));
          if (request.method === "POST" && parts[3] && parts[4] === "activate") return Response.json(await this.supervisor.harness.activate(sessionId, branchId, parts[3], await jsonBody(request) as any));
          if (request.method === "POST" && parts[3] && parts[4] === "allocate") return Response.json(await this.supervisor.harness.allocate(sessionId, branchId, parts[3], await jsonBody(request) as any));
          if (request.method === "POST" && parts[3] && parts[4] === "observations") return Response.json(await this.supervisor.harness.recordObservation(sessionId, branchId, parts[3], await jsonBody(request) as any));
          if (request.method === "POST" && parts[3] && parts[4] === "decide") return Response.json(await this.supervisor.harness.decide(sessionId, branchId, parts[3], await jsonBody(request) as any));
          if (request.method === "POST" && parts[3] && parts[4] === "approve") { const body=await jsonBody(request); return Response.json(await this.supervisor.harness.approve(sessionId,branchId,parts[3],String(body.scope) as any,String(body.approvedBy ?? "user"),typeof body.note === "string" ? body.note : undefined)); }
          if (request.method === "POST" && parts[3] && parts[4] === "approve-rollback") { const body=await jsonBody(request); return Response.json(await this.supervisor.harness.approveRollback(sessionId,branchId,parts[3],{ ...(typeof body.approvedBy === "string" ? { approvedBy: body.approvedBy } : {}), role: body.role === "admin" ? "admin" : "owner", ...(typeof body.note === "string" ? { note: body.note } : {}) })); }
          if (request.method === "POST" && parts[3] && parts[4] === "rollback") { const body=await jsonBody(request); return Response.json(await this.supervisor.harness.rollback(sessionId,branchId,parts[3],String(body.reason ?? ""))); }
        }
        if (parts[2] === "skills" && parts[3] && branchId && request.method === "POST") {
          const body=await jsonBody(request);
          if (parts[4] === "invoke") return Response.json(await this.supervisor.skills.invoke(sessionId,branchId,parts[3],body.input as any,(body.options ?? {}) as any));
          if (parts[4] === "test") return Response.json(await this.supervisor.skills.test(sessionId,branchId,parts[3],typeof body.versionId === "string" ? body.versionId : undefined));
        }
        if (parts[2] === "specs" && parts[3] && parts[4] === "spawn" && branchId && request.method === "POST") return Response.json(await this.supervisor.specs.spawn(sessionId,branchId,parts[3],await jsonBody(request) as any));

        // Slice 2 commands remain branch-scoped and return durable JSON handles.
        if (parts[2] === "agents" && branchId) {
          if (request.method === "GET" && parts.length === 3) return Response.json(await this.supervisor.agents.listChildren(sessionId));
          if (request.method === "POST" && parts[3] === "batch") { const body = await jsonBody(request); return Response.json(await this.supervisor.agents.spawnMany(sessionId, branchId, Array.isArray(body.inputs) ? body.inputs as any[] : [])); }
          if (request.method === "POST" && parts.length === 3) return Response.json(await this.supervisor.agents.spawn(sessionId, branchId, await jsonBody(request) as any));
        }
        if (parts[2] === "tasks" && branchId) {
          if (request.method === "GET" && parts.length === 3) return Response.json(await this.supervisor.agents.listTasks(sessionId, branchId));
          if (request.method === "POST" && parts[3] && parts[4] === "cancel") { const body = await jsonBody(request); return Response.json(await this.supervisor.agents.cancel(sessionId, branchId, parts[3], typeof body.reason === "string" ? body.reason : undefined)); }
        }
        if (parts[2] === "mailbox" && parts[3] && parts[4] === "ack" && branchId && request.method === "POST") return Response.json(await this.supervisor.agents.acknowledgeMessage(sessionId, branchId, parts[3]));
        if (parts[2] === "mailbox" && branchId && request.method === "POST") return Response.json(await this.supervisor.agents.sendMessage(sessionId, branchId, await jsonBody(request) as any));
        if (parts[2] === "documents" && branchId && request.method === "POST") return Response.json(await this.supervisor.documents.import(sessionId, branchId, await jsonBody(request) as any));
        if (parts[2] === "input-sets" && branchId && request.method === "POST") return Response.json(await this.supervisor.documents.createInputSet(sessionId, branchId, await jsonBody(request) as any));
        if (parts[2] === "models" && branchId && request.method === "POST") return Response.json(await this.supervisor.models.start(sessionId, branchId, await jsonBody(request) as any));
        if (parts[2] === "goals" && branchId) {
          if (request.method === "POST" && parts.length === 3) return Response.json(await this.supervisor.goals.create(sessionId, branchId, await jsonBody(request) as any));
          if (request.method === "POST" && parts[3] && parts[4] === "completion") return Response.json(await this.supervisor.goals.requestCompletion(sessionId, branchId, parts[3]));
          if (request.method === "POST" && parts[3] && parts[4] === "continue") return Response.json(await this.supervisor.goals.runContinuation(sessionId, branchId, parts[3], await jsonBody(request) as any));
        }
        if (parts[2] === "heartbeats" && branchId && request.method === "POST") return Response.json(await this.supervisor.heartbeats.create(sessionId, branchId, await jsonBody(request) as any));
      }
      return Response.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, { status: 404 });
    } catch (error) {
      const status = httpStatus(error);
      return Response.json({ error: { code: error instanceof AgentRuntimeError ? error.code : "INTERNAL", message: error instanceof Error ? error.message : String(error) } }, { status });
    }
  }

  #stream(sessionId: string, branchId: string, after: string, signal: AbortSignal): Response {
    const encoder = new TextEncoder(); let unsubscribe = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        unsubscribe = this.supervisor.projections.subscribe(sessionId, branchId, after, (event) => controller.enqueue(encoder.encode(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`)));
        signal.addEventListener("abort", () => { unsubscribe(); try { controller.close(); } catch {} }, { once: true });
      },
      cancel: () => unsubscribe(),
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-length") && !request.headers.get("transfer-encoding")) return {};
  return await request.json() as Record<string, unknown>;
}

function httpStatus(error: unknown): number {
  if (!(error instanceof AgentRuntimeError)) return 500;
  switch (error.code) {
    case "NOT_FOUND": return 404;
    case "CONFLICT":
    case "INVALID_TRANSITION": return 409;
    case "DEPENDENCY_FAILURE": return 424;
    case "CAPABILITY_UNAVAILABLE": return 501;
    case "VALIDATION_ERROR":
    default: return 400;
  }
}

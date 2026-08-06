import { timingSafeEqual } from "node:crypto";
import { AgentRuntimeError } from "../domain/index.ts";
import type { AgentRunResult, StartAgentRunInput } from "../runtime/index.ts";
import { scrubJson, scrubText } from "../security/scrub.ts";
import type { Supervisor } from "../runtime/index.ts";

export interface ProtocolServiceHooks {
  readonly health: {
    readonly workspaceId: string;
    readonly instanceId: string;
    readonly appVersion: string;
    readonly protocolMin: number;
    readonly protocolMax: number;
    readonly configHash: string;
  };
  readonly ready?: () => boolean;
  readonly status: () => Promise<unknown>;
  readonly shutdown: () => Promise<unknown>;
  readonly agents: () => Promise<unknown>;
  readonly startRun: (sessionId: string, branchId: string, input: StartAgentRunInput) => Promise<unknown>;
  readonly stop: (sessionId: string, branchId: string, reason?: string) => Promise<unknown>;
  readonly productSessions?: () => Promise<unknown>;
  readonly productSelect?: (target?: string, branchId?: string) => Promise<unknown>;
  readonly productRename?: (sessionId: string, branchId: string | undefined, name: string) => Promise<unknown>;
  readonly productConfig?: () => Promise<unknown>;
  readonly productSetModel?: (model: string | null) => Promise<unknown>;
  readonly productCredentialReference?: (provider: string, reference: string, label: string) => Promise<unknown>;
}

export interface ProtocolServerOptions {
  /** Owner-only bearer read from discovery state; never accepted in a URL. */
  readonly bearerToken?: string;
  readonly service?: ProtocolServiceHooks;
}

export class ProtocolServer {
  #server: ReturnType<typeof Bun.serve> | null = null;
  constructor(readonly supervisor: Supervisor, readonly options: ProtocolServerOptions = {}) {}

  listen(port = 0, hostname = "127.0.0.1"): ReturnType<typeof Bun.serve> {
    if (this.#server) return this.#server;
    this.#server = Bun.serve({ port, hostname, fetch: (request) => this.handle(request) });
    return this.#server;
  }
  stop(): void { this.#server?.stop(); this.#server = null; }

  /** Public router used identically by HTTP and InProcessProtocolTransport. */
  async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url); const parts = url.pathname.split("/").filter(Boolean);
      if (this.options.bearerToken && !authorized(request, this.options.bearerToken)) {
        return Response.json({ error: { code: "UNAUTHORIZED", message: "Authenticated local service access is required" } }, { status: 401, headers: { "cache-control": "no-store" } });
      }
      if (request.method === "GET" && url.pathname === "/health") return Response.json({
        ok: true, mode: "trusted-local", authenticated: Boolean(this.options.bearerToken),
        ...(this.options.service?.health ?? {}),
        ...(this.options.service ? { ready: this.options.service.ready?.() ?? true } : {}),
      }, { headers: { "cache-control": "no-store" } });
      if (request.method === "GET" && url.pathname === "/capabilities") return Response.json({
        protocol: "agencity.protocol", version: 1, mode: "trusted-local",
        trustedLocal: true, hostileCodeSandbox: false,
        snapshotCursorResume: true, committedEventDeduplication: true,
        cursorlessProgress: true, historicalProjection: true,
        managedService: Boolean(this.options.service),
        productCatalog: Boolean(this.options.service?.productSessions),
        sync: this.supervisor.sync.capabilities,
        providers: this.supervisor.modelExecutor.providers(),
      }, { headers: { "cache-control": "no-store" } });
      if (this.options.service) {
        if (request.method === "GET" && url.pathname === "/service/status") return Response.json(await this.options.service.status());
        if (request.method === "POST" && url.pathname === "/service/shutdown") return Response.json(await this.options.service.shutdown(), { status: 202 });
        if (request.method === "GET" && url.pathname === "/service/agents") return Response.json(await this.options.service.agents());
        if (request.method === "GET" && url.pathname === "/product/sessions" && this.options.service.productSessions) return Response.json(await this.options.service.productSessions());
        if (request.method === "POST" && url.pathname === "/product/select" && this.options.service.productSelect) { const body=await jsonBody(request); return Response.json(await this.options.service.productSelect(typeof body.target === "string" ? body.target : undefined, typeof body.branchId === "string" ? body.branchId : undefined)); }
        if (request.method === "POST" && url.pathname === "/product/rename" && this.options.service.productRename) { const body=await jsonBody(request); return Response.json(await this.options.service.productRename(String(body.sessionId ?? ""), typeof body.branchId === "string" ? body.branchId : undefined, String(body.name ?? ""))); }
        if (request.method === "GET" && url.pathname === "/product/config" && this.options.service.productConfig) return Response.json(await this.options.service.productConfig());
        if (request.method === "POST" && url.pathname === "/product/config/model" && this.options.service.productSetModel) { const body=await jsonBody(request); return Response.json(await this.options.service.productSetModel(body.model === null ? null : String(body.model ?? ""))); }
        if (request.method === "POST" && url.pathname === "/product/config/credential-reference" && this.options.service.productCredentialReference) { const body=await jsonBody(request); return Response.json(await this.options.service.productCredentialReference(String(body.provider ?? ""), String(body.reference ?? ""), String(body.label ?? ""))); }
      }
      if (request.method === "GET" && url.pathname === "/model-providers") return Response.json(this.supervisor.modelExecutor.providers());
      if (parts[0] === "sync") {
        if (request.method === "GET" && parts[1] === "status") return Response.json(await this.supervisor.sync.status());
        if (request.method === "POST" && parts.length === 1) return Response.json(await this.supervisor.sync.sync("manual"));
        if (request.method === "POST" && parts[1] === "reconnect") return Response.json(await this.supervisor.sync.reconnect());
        if (request.method === "POST" && parts[1] === "push") return Response.json(await this.supervisor.sync.push());
        if (request.method === "POST" && parts[1] === "pull") return Response.json(await this.supervisor.sync.pull());
        if (request.method === "POST" && parts[1] === "checkpoint") return Response.json(await this.supervisor.sync.checkpoint());
        if (request.method === "GET" && parts[1] === "stats") return Response.json(await this.supervisor.sync.stats());
        if (request.method === "GET" && parts[1] === "conflicts") return Response.json(await this.supervisor.sync.conflicts(url.searchParams.get("status") as "unresolved"|"resolved"|null ?? undefined));
        if (request.method === "POST" && parts[1] === "conflicts" && parts[2] && parts[3] === "resolve") return Response.json(await this.supervisor.sync.resolveConflict(parts[2], await jsonBody(request) as any));
        if (request.method === "GET" && parts[1] === "workspaces") return Response.json(await this.supervisor.sync.discoverCloudWorkspaces(url.searchParams.get("refresh") === "1"));
        if (request.method === "POST" && parts[1] === "export") { const body=await jsonBody(request); return Response.json(await this.supervisor.sync.exportBundle(String(body.destination??""),String(body.scopeKind) as any,String(body.scopeId??""),String(body.requestedBy??""))); }
        if (request.method === "POST" && parts[1] === "delete") { const body=await jsonBody(request); return Response.json(await this.supervisor.deleteOwnedData({scopeKind:String(body.scopeKind) as any,scopeId:String(body.scopeId??""),requestedBy:String(body.requestedBy??""),confirmation:String(body.confirmation??""),...(body.receiptDirectory===undefined?{}:{receiptDirectory:String(body.receiptDirectory)})})); }
        if (request.method === "POST" && parts[1] === "manifests") { const body=await jsonBody(request); return Response.json(await this.supervisor.sync.createManifest(String(body.operation) as any,String(body.scopeKind) as any,String(body.scopeId??""),String(body.requestedBy??""))); }
      }
      if (request.method === "POST" && url.pathname === "/sessions") {
        const body = await request.json() as any;
        return Response.json(await this.supervisor.createSession({ workspaceId: String(body.workspaceId ?? "default"), ...(body.model ? { model: body.model } : {}), ...(body.budget ? { budget: body.budget } : {}), ...(typeof body.sessionName === "string" ? { sessionName: body.sessionName } : {}), ...(typeof body.branchName === "string" ? { branchName: body.branchName } : {}) }));
      }
      if (parts[0] === "models" && parts[1]) {
        if (request.method === "GET") return Response.json(await this.supervisor.models.get(parts[1]));
        if (request.method === "POST" && parts[2] === "cancel") { const body = await jsonBody(request); return Response.json(await this.supervisor.models.cancel(parts[1], typeof body.reason === "string" ? body.reason : undefined)); }
      }
      if (parts[0] === "heartbeats" && parts[1] && request.method === "POST") {
        const body = await jsonBody(request);
        if (parts[2] === "tick") return Response.json(await this.supervisor.heartbeats.tick(parts[1], typeof body.at === "string" ? body.at : new Date()));
        if (parts[2] === "pause") return Response.json(await this.supervisor.heartbeats.pause(parts[1], typeof body.reason === "string" ? body.reason : undefined));
        if (parts[2] === "resume") return Response.json(await this.supervisor.heartbeats.resume(parts[1], typeof body.nextTickAt === "string" ? body.nextTickAt : undefined));
        if (parts[2] === "clear" || parts[2] === "cancel") return Response.json(await this.supervisor.heartbeats.cancel(parts[1], typeof body.reason === "string" ? body.reason : undefined));
      }
      if (parts[0] === "schedules" && parts[1] && request.method === "POST") {
        const body = await jsonBody(request);
        if (parts[2] === "tick") return Response.json(await this.supervisor.schedules.tick(parts[1], typeof body.at === "string" ? body.at : new Date()));
        if (parts[2] === "pause") return Response.json(await this.supervisor.schedules.pause(parts[1], typeof body.reason === "string" ? body.reason : undefined));
        if (parts[2] === "resume") return Response.json(await this.supervisor.schedules.resume(parts[1], typeof body.nextTickAt === "string" ? body.nextTickAt : undefined));
        if (parts[2] === "clear") return Response.json(await this.supervisor.schedules.clear(parts[1], typeof body.reason === "string" ? body.reason : undefined));
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
        if (request.method === "POST" && parts[2] === "stop" && branchId && this.options.service) { const body=await jsonBody(request); return Response.json(await this.options.service.stop(sessionId, branchId, typeof body.reason === "string" ? body.reason : undefined)); }
        if (parts[2] === "runs" && branchId) {
          if (request.method === "POST" && parts.length === 3) {
            const input = await jsonBody(request) as unknown as StartAgentRunInput;
            return this.options.service
              ? Response.json(await this.options.service.startRun(sessionId, branchId, input), { status: 202 })
              : Response.json(await this.supervisor.runs.start(sessionId, branchId, input));
          }
          if (request.method === "GET" && parts[3] && parts.length === 4) return Response.json(await this.supervisor.runs.get(sessionId, branchId, parts[3]));
          if (request.method === "POST" && parts[3] && parts[4] === "input" && parts[5]) return Response.json(await this.supervisor.runs.respond(sessionId, branchId, parts[3], parts[5], await jsonBody(request) as any));
          if (request.method === "POST" && parts[3] && parts[4] === "cancel") { const body = await jsonBody(request); return Response.json(await this.supervisor.runs.cancel(sessionId, branchId, parts[3], typeof body.reason === "string" ? body.reason : undefined)); }
          if (request.method === "POST" && parts[3] && parts[4] === "resume") return Response.json(await this.supervisor.runs.advance(sessionId, branchId, parts[3]));
        }
        // Retained diagnostic chat route; product tasks use /runs.
        if (request.method === "POST" && parts[2] === "turns" && branchId) return Response.json(await this.supervisor.modelLoop.turn(sessionId, branchId));
        if (request.method === "POST" && parts[2] === "cells" && branchId) { const body = await jsonBody(request); return Response.json(await this.supervisor.executeCell(sessionId, branchId, String(body.code ?? ""))); }
        if (request.method === "POST" && parts[2] === "branches" && branchId) { const body = await jsonBody(request); return Response.json({ branchId: await this.supervisor.fork(sessionId, branchId, String(body.cursor), typeof body.name === "string" ? body.name : undefined) }); }
        if (request.method === "POST" && parts[2] === "resume" && branchId) return Response.json(await this.supervisor.resume(sessionId,branchId));
        if (request.method === "POST" && parts[2] === "compact" && branchId) return Response.json(await this.supervisor.compact(sessionId,branchId));
        if (request.method === "GET" && parts[2] === "recovery-summary" && branchId) return Response.json(await this.supervisor.effectReconciliation.recoverySummary(sessionId, branchId));
        if (parts[2] === "effects" && branchId) {
          if (request.method === "GET" && parts[3] === "unknown") return Response.json(await this.supervisor.effectReconciliation.listUnknown(sessionId, branchId));
          if (parts[3] && request.method === "GET" && parts[4] === "reconciliation") return Response.json(await this.supervisor.effectReconciliation.inspect(sessionId, branchId, decodeURIComponent(parts[3])));
          if (parts[3] && request.method === "POST" && parts[4] === "reconciliation") return Response.json(await this.supervisor.effectReconciliation.record(sessionId, branchId, decodeURIComponent(parts[3]), await jsonBody(request) as any), { status: 201 });
        }

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
          if (request.method === "GET" && parts.length === 3) return Response.json(await this.supervisor.agents.listFamily(sessionId, branchId));
          if (request.method === "POST" && parts[3] === "batch") { const body = await jsonBody(request); return Response.json(await this.supervisor.agents.spawnMany(sessionId, branchId, Array.isArray(body.inputs) ? body.inputs as any[] : [])); }
          if (request.method === "POST" && parts[3] && parts[4] === "follow-up") { const body = await jsonBody(request); return Response.json(await this.supervisor.agents.followUp(sessionId, branchId, decodeURIComponent(parts[3]), String(body.content ?? ""), body as any)); }
          if (request.method === "POST" && parts[3] && parts[4] === "cancel") { const body = await jsonBody(request); return Response.json(await this.supervisor.agents.cancelFamilyTarget(sessionId, branchId, decodeURIComponent(parts[3]), typeof body.reason === "string" ? body.reason : undefined)); }
          if (request.method === "POST" && parts.length === 3) return Response.json(await this.supervisor.agents.spawn(sessionId, branchId, await jsonBody(request) as any));
        }
        if (parts[2] === "tasks" && branchId) {
          if (request.method === "GET" && parts.length === 3) return Response.json(await this.supervisor.agents.listTasks(sessionId, branchId));
          if (request.method === "POST" && parts[3] && parts[4] === "cancel") { const body = await jsonBody(request); return Response.json(await this.supervisor.agents.cancel(sessionId, branchId, parts[3], typeof body.reason === "string" ? body.reason : undefined)); }
        }
        if (parts[2] === "mailbox" && parts[3] && parts[4] === "ack" && branchId && request.method === "POST") return Response.json(await this.supervisor.agents.acknowledgeMessage(sessionId, branchId, parts[3]));
        if (parts[2] === "mailbox" && branchId && request.method === "GET") return Response.json(await this.supervisor.agents.messages(sessionId, branchId, { direction: (url.searchParams.get("direction") ?? "all") as any, ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}), ...(url.searchParams.has("before") ? { before: url.searchParams.get("before")! } : {}), ...(url.searchParams.get("pending") === "1" ? { pendingOnly: true } : {}) }));
        if (parts[2] === "mailbox" && branchId && request.method === "POST") return Response.json(await this.supervisor.agents.sendMessage(sessionId, branchId, await jsonBody(request) as any));
        if (parts[2] === "documents" && branchId && request.method === "POST") return Response.json(await this.supervisor.documents.import(sessionId, branchId, await jsonBody(request) as any));
        if (parts[2] === "input-sets" && branchId && request.method === "POST") return Response.json(await this.supervisor.documents.createInputSet(sessionId, branchId, await jsonBody(request) as any));
        if (parts[2] === "models" && branchId && request.method === "POST") return Response.json(await this.supervisor.models.start(sessionId, branchId, await jsonBody(request) as any));
        if (parts[2] === "goals" && branchId) {
          if (request.method === "GET" && parts.length === 3) return Response.json(await this.supervisor.goals.list(sessionId, branchId));
          if (request.method === "GET" && parts[3] === "current") return Response.json(await this.supervisor.goals.current(sessionId, branchId));
          if (request.method === "GET" && parts[3] && parts[4] === "evaluations") { await this.supervisor.goals.get(sessionId, branchId, parts[3]); return Response.json(await this.supervisor.storage.listGoalGateEvaluations!(parts[3], url.searchParams.get("gate") ?? undefined)); }
          if (request.method === "GET" && parts[3] && parts.length === 4) return Response.json(await this.supervisor.goals.get(sessionId, branchId, parts[3]));
          if (request.method === "POST" && parts.length === 3) return Response.json(await this.supervisor.goals.create(sessionId, branchId, await jsonBody(request) as any));
          if (request.method === "POST" && parts[3] && parts[4] === "completion") return Response.json(await this.supervisor.goals.requestCompletion(sessionId, branchId, parts[3]));
          if (request.method === "POST" && parts[3] && parts[4] === "continue") return Response.json(await this.supervisor.goals.runContinuation(sessionId, branchId, parts[3], await jsonBody(request) as any));
          if (request.method === "POST" && parts[3] && parts[4] === "pause") { const body = await jsonBody(request); return Response.json(await this.supervisor.goals.pause(sessionId, branchId, parts[3], typeof body.reason === "string" ? body.reason : undefined)); }
          if (request.method === "POST" && parts[3] && parts[4] === "resume") { const body = await jsonBody(request); return Response.json(await this.supervisor.goals.resume(sessionId, branchId, parts[3], typeof body.reason === "string" ? body.reason : undefined)); }
          if (request.method === "POST" && parts[3] && parts[4] === "clear") { const body = await jsonBody(request); return Response.json(await this.supervisor.goals.clear(sessionId, branchId, parts[3], typeof body.reason === "string" ? body.reason : undefined)); }
        }
        if (parts[2] === "heartbeats" && branchId) {
          if (request.method === "GET") return Response.json(await this.supervisor.heartbeats.list(sessionId, branchId));
          if (request.method === "POST") return Response.json(await this.supervisor.heartbeats.create(sessionId, branchId, await jsonBody(request) as any));
        }
        if (parts[2] === "schedules" && branchId) {
          if (request.method === "GET" && parts[3] === "wakes") return Response.json(await this.supervisor.schedules.wakes(sessionId, branchId, url.searchParams.get("status")?.split(",") as any));
          if (request.method === "GET") return Response.json(await this.supervisor.schedules.list(sessionId, branchId));
          if (request.method === "POST") return Response.json(await this.supervisor.schedules.create(sessionId, branchId, await jsonBody(request) as any));
        }
      }
      return Response.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, { status: 404 });
    } catch (error) {
      const status = httpStatus(error);
      return Response.json({ error: {
        code: error instanceof AgentRuntimeError ? error.code : "INTERNAL",
        message: scrubText(error instanceof Error ? error.message : String(error)),
        details: protocolErrorDetails(error),
      } }, { status });
    }
  }

  #stream(sessionId: string, branchId: string, after: string, signal: AbortSignal): Response {
    const encoder = new TextEncoder();
    let active = true;
    let unsubscribeEvents = () => {};
    let unsubscribeProgress = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const enqueue = (frame: string): void => {
          if (!active) return;
          try { controller.enqueue(encoder.encode(frame)); } catch { active = false; }
        };
        // Committed events retain their cursor ID and original data shape for
        // backwards compatibility. Progress is explicitly named and has no ID:
        // EventSource reconnect cursors therefore never advance on progress.
        unsubscribeEvents = this.supervisor.projections.subscribe(
          sessionId,
          branchId,
          after,
          (event) => enqueue(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`),
        );
        unsubscribeProgress = this.supervisor.outbox.onProgress((progress) => {
          if (progress.sessionId === sessionId && progress.branchId === branchId) {
            enqueue(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`);
          }
        });
        signal.addEventListener("abort", () => {
          active = false;
          unsubscribeEvents(); unsubscribeProgress();
          try { controller.close(); } catch {}
        }, { once: true });
      },
      cancel: () => {
        active = false;
        unsubscribeEvents(); unsubscribeProgress();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }
}

function authorized(request: Request, expected: string): boolean {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const received = header.slice(7);
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  // Constructed in-process Requests do not receive transport-generated
  // content-length/transfer-encoding headers. Body presence is the shared
  // semantic boundary for both transports.
  if (request.body === null) return {};
  return await request.json() as Record<string, unknown>;
}

function protocolErrorDetails(error: unknown): unknown {
  if (!(error instanceof AgentRuntimeError) || !error.details) return null;
  try { return scrubJson(JSON.parse(JSON.stringify(error.details)) as any); }
  catch { return null; }
}

function httpStatus(error: unknown): number {
  if (!(error instanceof AgentRuntimeError)) return 500;
  switch (error.code) {
    case "NOT_FOUND": return 404;
    case "CONFLICT":
    case "EXECUTION_OWNERSHIP_CONFLICT":
    case "INVALID_TRANSITION": return 409;
    case "DEPENDENCY_FAILURE": return 424;
    case "CAPABILITY_UNAVAILABLE": return 501;
    case "VALIDATION_ERROR":
    default: return 400;
  }
}

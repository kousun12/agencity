import { timingSafeEqual } from "node:crypto";
import { AgentRuntimeError, ValidationError } from "../domain/index.ts";
import type { ModelConfiguration } from "../domain/index.ts";
import {
  deriveModelContractDiagnostics,
  describeAgentToolCapabilities,
  type AgentRunResult,
  type StartAgentRunInput,
} from "../runtime/index.ts";
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
  readonly productConfig?: (model?: string) => Promise<unknown>;
  readonly productSetModel?: (model: string | null) => Promise<unknown>;
  readonly productSetReasoningEffort?: (model: string, effort: string | null) => Promise<unknown>;
  readonly productSetProviderKey?: (provider: string, apiKey: string | null) => Promise<unknown>;
  readonly productCredentialReference?: (provider: string, reference: string, label: string) => Promise<unknown>;
}

export interface ProtocolServerOptions {
  /** Owner-only bearer read from discovery state; never accepted in a URL. */
  readonly bearerToken?: string;
  readonly service?: ProtocolServiceHooks;
  /** Internal/test override for Bun's server-wide HTTP idle timeout. */
  readonly httpIdleTimeoutSeconds?: number;
}

export class ProtocolServer {
  #server: ReturnType<typeof Bun.serve> | null = null;
  #stoppingServer: ReturnType<typeof Bun.serve> | null = null;
  #stopAcceptingResult: Promise<unknown | null> | null = null;
  #activeHandlers = 0;
  readonly #handlerDrainResolvers = new Set<() => void>();
  constructor(readonly supervisor: Supervisor, readonly options: ProtocolServerOptions = {}) {}

  listen(port = 0, hostname = "127.0.0.1"): ReturnType<typeof Bun.serve> {
    if (this.#server) return this.#server;
    this.#server = Bun.serve({
      port,
      hostname,
      ...(this.options.httpIdleTimeoutSeconds === undefined
        ? {}
        : { idleTimeout: this.options.httpIdleTimeoutSeconds }),
      fetch: (request, server) => {
        // Quiet SSE responses otherwise hit Bun's default ten-second idle
        // timeout. Keep only the long-lived branch stream exempt.
        if (isBranchStreamRequest(request)) server.timeout(request, 0);
        return this.handle(request);
      },
    });
    return this.#server;
  }
  async stop(closeActiveConnections = false): Promise<void> {
    this.stopAccepting();
    if (closeActiveConnections) {
      await this.closeActiveConnections();
      return;
    }
    const error = await this.#stopAcceptingResult;
    this.#stoppingServer = null;
    this.#stopAcceptingResult = null;
    if (error !== null) throw error;
  }
  stopAccepting(): void {
    if (this.#stoppingServer) return;
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    this.#stoppingServer = server;
    this.#stopAcceptingResult = server.stop(false).then(() => null, error => error);
  }
  async closeActiveConnections(): Promise<void> {
    const server = this.#stoppingServer;
    const stopAcceptingResult = this.#stopAcceptingResult;
    this.#stoppingServer = null;
    this.#stopAcceptingResult = null;
    let closeError: unknown = null;
    try { await server?.stop(true); }
    catch (error) { closeError = error; }
    const stopError = await stopAcceptingResult;
    if (closeError !== null) throw closeError;
    if (stopError !== null && stopError !== undefined) throw stopError;
  }
  async drainHandlers(): Promise<void> {
    if (this.#activeHandlers === 0) return;
    await new Promise<void>(resolve => { this.#handlerDrainResolvers.add(resolve); });
  }

  /** Public router used identically by HTTP and InProcessProtocolTransport. */
  async handle(request: Request): Promise<Response> {
    this.#activeHandlers++;
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
      if (request.method === "GET" && url.pathname === "/capabilities") {
        const provider = url.searchParams.get("provider");
        const model = url.searchParams.get("model");
        if ((provider === null) !== (model === null)) {
          throw new ValidationError(
            "Selected agent-tool capability requires both provider and model",
          );
        }
        return Response.json({
          protocol: "agencity.protocol", version: 1, mode: "trusted-local",
          trustedLocal: true, hostileCodeSandbox: false,
          snapshotCursorResume: true, committedEventDeduplication: true,
          cursorlessProgress: true, historicalProjection: true,
          managedService: Boolean(this.options.service),
          productCatalog: Boolean(this.options.service?.productSessions),
          reasoningEffortSelection: true,
          sync: this.supervisor.sync.capabilities,
          providers: this.supervisor.modelExecutor.providers(),
          agentTools: describeAgentToolCapabilities(
            this.supervisor.modelExecutor,
            provider === null || model === null ? undefined : { provider, model },
          ),
        }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "GET" && url.pathname === "/model-catalog") {
        const catalog = await this.supervisor.modelCatalog.ensureFresh();
        return Response.json({
          endpointId: this.supervisor.modelCatalog.endpointId,
          origin: this.supervisor.modelCatalog.gatewayOrigin,
          ...catalog,
        });
      }
      if (request.method === "POST" && url.pathname === "/model-catalog/refresh") {
        return Response.json({
          endpointId: this.supervisor.modelCatalog.endpointId,
          origin: this.supervisor.modelCatalog.gatewayOrigin,
          ...await this.supervisor.modelCatalog.refresh(),
        });
      }
      if (this.options.service) {
        if (request.method === "GET" && url.pathname === "/service/status") return Response.json(await this.options.service.status());
        if (request.method === "POST" && url.pathname === "/service/shutdown") return Response.json(await this.options.service.shutdown(), { status: 202 });
        if (request.method === "GET" && url.pathname === "/service/agents") return Response.json(await this.options.service.agents());
        if (request.method === "GET" && url.pathname === "/product/sessions" && this.options.service.productSessions) return Response.json(await this.options.service.productSessions());
        if (request.method === "POST" && url.pathname === "/product/select" && this.options.service.productSelect) { const body=await jsonBody(request); return Response.json(await this.options.service.productSelect(typeof body.target === "string" ? body.target : undefined, typeof body.branchId === "string" ? body.branchId : undefined)); }
        if (request.method === "POST" && url.pathname === "/product/rename" && this.options.service.productRename) { const body=await jsonBody(request); return Response.json(await this.options.service.productRename(String(body.sessionId ?? ""), typeof body.branchId === "string" ? body.branchId : undefined, String(body.name ?? ""))); }
        if (request.method === "GET" && url.pathname === "/product/config" && this.options.service.productConfig) return Response.json(await this.options.service.productConfig(url.searchParams.get("model") ?? undefined));
        if (request.method === "POST" && url.pathname === "/product/config/model" && this.options.service.productSetModel) { const body=await jsonBody(request); return Response.json(await this.options.service.productSetModel(body.model === null ? null : String(body.model ?? ""))); }
        if (request.method === "POST" && url.pathname === "/product/config/reasoning-effort" && this.options.service.productSetReasoningEffort) { const body=await jsonBody(request); return Response.json(await this.options.service.productSetReasoningEffort(String(body.model ?? ""), body.effort === null ? null : String(body.effort ?? ""))); }
        if (request.method === "POST" && url.pathname === "/product/config/provider-key" && this.options.service.productSetProviderKey) { const body=await jsonBody(request); return Response.json(await this.options.service.productSetProviderKey(String(body.provider ?? ""), body.apiKey === null ? null : String(body.apiKey ?? ""))); }
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
        return Response.json(await this.supervisor.createSession({ workspaceId: String(body.workspaceId ?? "default"), ...(body.model ? { model: body.model } : {}), ...(body.budget ? { budget: body.budget } : {}), ...(body.agentProfile ? { agentProfile: body.agentProfile } : {}), ...(typeof body.sessionName === "string" ? { sessionName: body.sessionName } : {}), ...(typeof body.branchName === "string" ? { branchName: body.branchName } : {}) }));
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
      if (parts[0] === "refinement-policy") {
        if (request.method === "GET") return Response.json(await this.supervisor.refiner.automaticPolicy());
        if (request.method === "PUT") { const body = await jsonBody(request); return Response.json(await this.supervisor.refiner.setAutomatic(body.enabled as boolean)); }
      }
      if (parts[0] === "refinement-reviews" && request.method === "GET") return Response.json(await this.supervisor.refiner.list({ ...(url.searchParams.has("status") ? { status: url.searchParams.get("status") as any } : {}) }));
      if (parts[0] === "refinement-capabilities" && request.method === "GET") return Response.json({
        governance: "sealed-automatic-v1",
        targets: ["agent_profile", "memory", "prompt_note", "skill", "subagent_spec"],
        wait: true,
        detach: true,
        rollback: true,
        reviewerSelectableByCaller: false,
      });
      if (parts[0] === "governed-refinements") {
        if (request.method === "GET" && parts[1]) return Response.json(await this.supervisor.refinementGovernance.get(parts[1]));
        if (request.method === "GET") return Response.json(await this.supervisor.refinementGovernance.list({
          ...(url.searchParams.has("status") ? { status: url.searchParams.get("status") as any } : {}),
          ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
        }));
      }
      if (parts[0] === "harness") {
        if (request.method === "GET" && parts[1] === "refinements") return Response.json(await this.supervisor.harness.proposals(url.searchParams.get("status") as any ?? undefined));
        if (request.method === "GET" && parts[1] && parts[2] === "history") return Response.json(await this.supervisor.harness.history(parts[1]));
        if (request.method === "GET" && parts.length === 1) return Response.json(await this.supervisor.harness.list());
      }
      if (parts[0] === "sessions" && parts[1]) {
        const sessionId = parts[1]; const branchId = url.searchParams.get("branch") ?? parts[3];
        if (request.method === "GET" && parts[2] === "agent-profile") return Response.json(await this.supervisor.agentProfiles.get(sessionId, { includePrompt: url.searchParams.get("detail") === "full" }));
        if (request.method === "GET" && parts[2] === "agent-profiles") return Response.json(await this.supervisor.agentProfiles.list(sessionId, { includePrompt: url.searchParams.get("detail") === "full", ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}) }));
        if (parts[2] === "profile-proposals" && branchId) {
          if (request.method === "POST") {
            const body = await jsonBody(request) as any;
            return Response.json(await this.supervisor.refinementGovernance.proposeOwner(
              sessionId,
              branchId,
              {
                target: {
                  kind: "agent_profile",
                  agentSessionId: sessionId,
                  expectedProfileVersionId: String(body.expectedProfileVersionId ?? ""),
                  replacement: body.replacement,
                },
                reason: String(body.reason ?? ""),
                predictedEffect: String(body.predictedEffect ?? ""),
                evidenceEventIds: Array.isArray(body.evidenceEventIds) ? body.evidenceEventIds.map(String) : [],
                ...(typeof body.revisesProposalId === "string" ? { revisesProposalId: body.revisesProposalId } : {}),
                ...(typeof body.clientRequestId === "string" ? { clientRequestId: body.clientRequestId } : {}),
                wait: body.wait !== false,
              },
            ));
          }
        }
        if (parts[2] === "profiles" && parts[3] === "rollback" && branchId && request.method === "POST") {
          return Response.json(await this.supervisor.refinementGovernance.rollbackOwner(
            sessionId,
            branchId,
            await jsonBody(request) as any,
          ));
        }
        if (parts[2] === "governed-refinements" && branchId) {
          if (request.method === "POST" && parts[3] && parts[4] === "rollback") {
            return Response.json(
              await this.supervisor.refinementGovernance
                .rollbackAutomaticProposalOwner(
                  sessionId,
                  branchId,
                  parts[3],
                  await jsonBody(request) as any,
                ),
            );
          }
          if (request.method === "POST") {
            const body = await jsonBody(request) as any;
            return Response.json(await this.supervisor.refinementGovernance.proposeOwner(
              sessionId,
              branchId,
              {
                target: body.target,
                reason: String(body.reason ?? ""),
                predictedEffect: String(body.predictedEffect ?? ""),
                evidenceEventIds: Array.isArray(body.evidenceEventIds)
                  ? body.evidenceEventIds.map(String)
                  : [],
                ...(typeof body.revisesProposalId === "string"
                  ? { revisesProposalId: body.revisesProposalId }
                  : {}),
                ...(typeof body.clientRequestId === "string"
                  ? { clientRequestId: body.clientRequestId }
                  : {}),
                wait: body.wait !== false,
              },
            ));
          }
          if (request.method === "GET") {
            return Response.json(await this.supervisor.refinementGovernance.list({
              sessionId,
              branchId,
              ...(url.searchParams.has("status")
                ? { status: url.searchParams.get("status") as any }
                : {}),
              ...(url.searchParams.has("limit")
                ? { limit: Number(url.searchParams.get("limit")) }
                : {}),
            }));
          }
        }
        if (request.method === "GET" && parts[2] === "snapshot" && branchId) return Response.json(await this.supervisor.projections.getSnapshot(sessionId, branchId));
        if (request.method === "GET" && parts[2] === "model-contract-diagnostics" && branchId) {
          const snapshot = await this.supervisor.projections.getSnapshot(sessionId, branchId);
          return Response.json(deriveModelContractDiagnostics(snapshot.state));
        }
        if (request.method === "GET" && parts[2] === "history" && branchId) return Response.json(await this.supervisor.projections.history(sessionId, branchId));
        if (request.method === "GET" && parts[2] === "stream" && branchId) return this.#stream(sessionId, branchId, url.searchParams.get("after") ?? "0", request.signal);
        if (request.method === "POST" && parts[2] === "messages" && branchId) { const body = await jsonBody(request); return Response.json(await this.supervisor.appendMessage(sessionId, branchId, "user", String(body.content ?? ""))); }
        if (request.method === "POST" && parts[2] === "model" && branchId) {
          const body = await jsonBody(request);
          const model = body.model;
          if (!model || typeof model !== "object" || Array.isArray(model)) {
            throw new ValidationError("Model selection requires provider and model");
          }
          const configuration = model as Record<string, unknown>;
          if (typeof configuration.provider !== "string" || typeof configuration.model !== "string") {
            throw new ValidationError("Model selection requires provider and model");
          }
          return Response.json(await this.supervisor.selectModel(sessionId, branchId, configuration as unknown as ModelConfiguration));
        }
        if (request.method === "POST" && parts[2] === "stop" && branchId && this.options.service) { const body=await jsonBody(request); return Response.json(await this.options.service.stop(sessionId, branchId, typeof body.reason === "string" ? body.reason : undefined)); }
        if (parts[2] === "runs" && branchId) {
          if (request.method === "POST" && parts.length === 3) {
            const input = await jsonBody(request) as unknown as StartAgentRunInput;
            return this.options.service
              ? Response.json(await this.options.service.startRun(sessionId, branchId, input), { status: 202 })
              : Response.json(await this.supervisor.runs.start(sessionId, branchId, input));
          }
          if (request.method === "GET" && parts[3] && parts.length === 4) return Response.json(await this.supervisor.runs.get(sessionId, branchId, parts[3]));
          if (request.method === "POST" && parts[3] && parts[4] === "cancel") { const body = await jsonBody(request); return Response.json(await this.supervisor.runs.cancel(sessionId, branchId, parts[3], typeof body.reason === "string" ? body.reason : undefined)); }
          if (request.method === "POST" && parts[3] && parts[4] === "resume") return Response.json(await this.supervisor.runs.advance(sessionId, branchId, parts[3]));
        }
        // Retained diagnostic compatibility route uses the same canonical
        // AgentRunRequested profile-pin boundary as ordinary product work.
        if (request.method === "POST" && parts[2] === "turns" && branchId) return Response.json(await this.supervisor.diagnosticTurn(sessionId, branchId));
        if (request.method === "POST" && parts[2] === "cells" && branchId) { const body = await jsonBody(request); return Response.json(await this.supervisor.executeCell(sessionId, branchId, String(body.code ?? ""))); }
        if (request.method === "POST" && parts[2] === "branches" && branchId) { const body = await jsonBody(request); const strategy = body.compactionStrategy === "deterministic-extractive-v1" || body.compactionStrategy === "model-summary-v1" ? body.compactionStrategy : undefined; return Response.json({ branchId: await this.supervisor.fork(sessionId, branchId, String(body.cursor), typeof body.name === "string" ? body.name : undefined, strategy) }); }
        if (request.method === "POST" && parts[2] === "resume" && branchId) return Response.json(await this.supervisor.resume(sessionId,branchId));
        if (request.method === "GET" && parts[2] === "context" && branchId) return Response.json(await this.supervisor.inspectContext(sessionId,branchId));
        if (request.method === "POST" && parts[2] === "compact" && branchId) {
          const body = await jsonBody(request);
          return Response.json(await this.supervisor.compact(sessionId,branchId,{ ...(body as any), reason: "user-request", requestedBy: "user" }));
        }
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
        if (parts[2] === "refinement-reviews" && branchId) {
          if (request.method === "POST") return Response.json(await this.supervisor.refiner.request(sessionId, branchId, await jsonBody(request) as any));
          if (request.method === "GET" && parts[3]) return Response.json(await this.supervisor.refiner.getForBranch(sessionId, branchId, parts[3]));
          if (request.method === "GET") return Response.json(await this.supervisor.refiner.list({ sessionId, branchId, ...(url.searchParams.has("status") ? { status: url.searchParams.get("status") as any } : {}) }));
        }
        if (parts[2] === "learning" && branchId && request.method === "GET") {
          if (parts[3] === "status") {
            return Response.json(await this.supervisor.refiner.learningStatus(sessionId, branchId));
          }
          if (parts[3] === "history") {
            return Response.json(await this.supervisor.refiner.learningHistory(
              sessionId,
              branchId,
              url.searchParams.has("limit")
                ? Number(url.searchParams.get("limit"))
                : 50,
            ));
          }
          if (parts[3] === "activities" && parts[4]) {
            return Response.json(await this.supervisor.refiner.learningActivity(
              sessionId,
              branchId,
              parts[4],
            ));
          }
        }
        if (parts[2] === "user-corrections" && branchId && request.method === "POST") { const body = await jsonBody(request); return Response.json({ correctionId: await this.supervisor.refiner.correct(sessionId, branchId, String(body.correction ?? ""), Array.isArray(body.correctedEventIds) ? body.correctedEventIds.map(String) : []) }); }
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
        if (parts[2] === "skills" && branchId) {
          if (request.method === "GET" && !parts[3]) return Response.json(await this.supervisor.skillManagement.list(sessionId,branchId,{includeUnavailable:url.searchParams.get("includeUnavailable")==="true"}));
          if (request.method === "POST" && parts[3] === "import") return Response.json(await this.supervisor.skillManagement.installLocal(sessionId,branchId,await jsonBody(request) as any));
          if (request.method === "POST" && parts[3] === "preview-import") { const body=await jsonBody(request); return Response.json(await this.supervisor.skillManagement.previewImport(String(body.directory ?? ""))); }
          if (request.method === "POST" && parts[3] === "propose") { const body=await jsonBody(request); return Response.json(await this.supervisor.skillManagement.propose(sessionId,branchId,String(body.instructions ?? ""),body.scope === "local" ? "local" : "workspace")); }
          if (parts[3]) {
            const reference=decodeURIComponent(parts[3]);
            if (request.method === "GET" && !parts[4]) return Response.json(await this.supervisor.skillManagement.get(sessionId,branchId,reference));
            if (request.method === "POST") {
              const body=await jsonBody(request);
              if (parts[4] === "invoke") return Response.json(await this.supervisor.skills.invoke(sessionId,branchId,reference,body.input as any,(body.options ?? {}) as any));
              if (parts[4] === "test") return Response.json(await this.supervisor.skillManagement.test(sessionId,branchId,reference));
              if (parts[4] === "enable") return Response.json(await this.supervisor.skillManagement.enable(sessionId,branchId,reference));
              if (parts[4] === "disable") return Response.json(await this.supervisor.skillManagement.disable(sessionId,branchId,reference));
              if (parts[4] === "remove") return Response.json(await this.supervisor.skillManagement.remove(sessionId,branchId,reference));
            }
          }
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
        if (parts[2] === "ai" && parts[3] === "generations" && branchId) {
          if (request.method === "GET" && parts[4] === "by-key") {
            const key = url.searchParams.get("idempotencyKey");
            if (!key) throw new ValidationError("Generation lookup requires idempotencyKey");
            return Response.json(await this.supervisor.ai.find(sessionId, branchId, key));
          }
          if (request.method === "POST" && parts.length === 4) {
            const body = await jsonBody(request) as any;
            if (body.kind !== "text" && body.kind !== "object") {
              throw new ValidationError("Generation admission requires kind text or object");
            }
            const { kind, ...input } = body;
            return Response.json(kind === "object"
              ? await this.supervisor.ai.admitObject(sessionId, branchId, input)
              : await this.supervisor.ai.admitText(sessionId, branchId, input));
          }
          if (parts[4]) {
            const generationId = parts[4];
            if (request.method === "GET" && parts.length === 5) {
              return Response.json(await this.supervisor.ai.getFor(sessionId, branchId, generationId));
            }
            if (request.method === "GET" && parts[5] === "result") {
              return Response.json(await this.supervisor.ai.resultFor(
                sessionId,
                branchId,
                generationId,
                { wait: false },
              ));
            }
            if (request.method === "POST" && parts[5] === "cancel") {
              const body = await jsonBody(request);
              return Response.json(await this.supervisor.ai.cancelFor(
                sessionId,
                branchId,
                generationId,
                typeof body.reason === "string" ? body.reason : undefined,
              ));
            }
          }
        }
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
    } finally {
      this.#activeHandlers--;
      if (this.#activeHandlers === 0) {
        for (const resolve of this.#handlerDrainResolvers) resolve();
        this.#handlerDrainResolvers.clear();
      }
    }
  }

  #stream(sessionId: string, branchId: string, after: string, signal: AbortSignal): Response {
    const encoder = new TextEncoder();
    let active = true;
    let unsubscribeEvents = () => {};
    let unsubscribeProgress = () => {};
    const unsubscribe = (): void => {
      const events = unsubscribeEvents;
      const progress = unsubscribeProgress;
      unsubscribeEvents = () => {};
      unsubscribeProgress = () => {};
      events();
      progress();
    };
    const deactivate = (): void => {
      if (!active) return;
      active = false;
      unsubscribe();
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const enqueue = (frame: string): void => {
          if (!active) return;
          try { controller.enqueue(encoder.encode(frame)); }
          catch { deactivate(); }
        };
        // Flush response headers immediately even when the branch has no new
        // events. SSE comments carry no protocol event or cursor.
        enqueue(": connected\n\n");
        // Committed events retain their cursor ID and original data shape for
        // backwards compatibility. Progress is explicitly named and has no ID:
        // EventSource reconnect cursors therefore never advance on progress.
        const events = this.supervisor.projections.subscribe(
          sessionId,
          branchId,
          after,
          (event) => enqueue(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`),
        );
        unsubscribeEvents = events;
        if (!active) { events(); unsubscribeEvents = () => {}; }
        if (active) {
          const progress = this.supervisor.outbox.onProgress((notification) => {
            if (notification.sessionId === sessionId && notification.branchId === branchId) {
              enqueue(`event: progress\ndata: ${JSON.stringify(notification)}\n\n`);
            }
          });
          unsubscribeProgress = progress;
          if (!active) { progress(); unsubscribeProgress = () => {}; }
        }
        const abort = (): void => {
          deactivate();
          try { controller.close(); } catch {}
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      },
      cancel: deactivate,
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }

}

function isBranchStreamRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  return parts.length === 3 && parts[0] === "sessions" && Boolean(parts[1]) && parts[2] === "stream";
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

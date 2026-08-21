import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  OBSERVER_BOUNDS,
  OBSERVER_PROTOCOL,
  type ObserverRoute,
  type ObserverStreamEnvelope,
} from "./types.ts";
import {
  ObserverController,
  ObserverControllerError,
  type ObserverBrowserSnapshot,
  type ObserverControllerUpdate,
} from "./controller.ts";
import { serializedUtf8Bytes } from "./bounds.ts";

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
const COOKIE_NAME = "agencity_observe_session";
const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const STREAM_QUEUE_ENVELOPES = 256;
const STREAM_QUEUE_BYTES = 1 * 1024 * 1024;
const BROWSER_HEARTBEAT_MS = 12_000;

export class ObserverSseQueue {
  readonly #items: Uint8Array[] = [];
  #bytes = 0;

  constructor(
    readonly maximumItems = STREAM_QUEUE_ENVELOPES,
    readonly maximumBytes = STREAM_QUEUE_BYTES,
  ) {}

  get length(): number {
    return this.#items.length;
  }

  get bytes(): number {
    return this.#bytes;
  }

  enqueue(value: Uint8Array): boolean {
    if (this.#items.length >= this.maximumItems ||
        this.#bytes + value.byteLength > this.maximumBytes) {
      return false;
    }
    this.#items.push(value);
    this.#bytes += value.byteLength;
    return true;
  }

  shift(): Uint8Array | undefined {
    const value = this.#items.shift();
    if (value) this.#bytes -= value.byteLength;
    return value;
  }

  clear(): void {
    this.#items.splice(0);
    this.#bytes = 0;
  }
}

const ASSETS = Object.freeze({
  "/": { url: new URL("./web/index.html", import.meta.url), contentType: "text/html; charset=utf-8", sensitive: true },
  "/app.js": { url: new URL("./web/app.js", import.meta.url), contentType: "text/javascript; charset=utf-8", sensitive: false },
  "/app.css": { url: new URL("./web/app.css", import.meta.url), contentType: "text/css; charset=utf-8", sensitive: false },
});

export interface ObserverServer {
  readonly port: number;
  readonly bootstrapToken: string;
  readonly url: string;
  stop(): Promise<void>;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function equalSecret(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function baseHeaders(contentType?: string, sensitive = false): Headers {
  const headers = new Headers({
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
  });
  if (contentType) headers.set("Content-Type", contentType);
  if (sensitive) {
    headers.set("Cache-Control", "no-store, private");
    headers.set("Pragma", "no-cache");
  } else {
    headers.set("Cache-Control", "no-store");
  }
  return headers;
}

function response(body: BodyInit | null, status: number, contentType: string, sensitive = false): Response {
  return new Response(body, { status, headers: baseHeaders(contentType, sensitive) });
}

function envelope(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = baseHeaders("application/json; charset=utf-8", true);
  if (extraHeaders) {
    for (const [name, value] of new Headers(extraHeaders)) headers.append(name, value);
  }
  return new Response(JSON.stringify({
    version: OBSERVER_PROTOCOL,
    ok: status >= 200 && status < 300,
    ...(status >= 200 && status < 300
      ? { data }
      : { error: data }),
  }), { status, headers });
}

function problem(code: string, message: string, status: number): Response {
  return envelope({ code, message }, status);
}

function cookies(request: Request): string[] {
  const value = request.headers.get("cookie");
  if (!value) return [];
  return value.split(";").map(part => part.trim()).filter(part => part.startsWith(`${COOKIE_NAME}=`))
    .map(part => part.slice(COOKIE_NAME.length + 1));
}

function validSession(request: Request, sessions: ReadonlySet<string>): boolean {
  const candidates = cookies(request);
  if (candidates.length !== 1) return false;
  for (const retained of sessions) {
    if (equalSecret(candidates[0]!, retained)) return true;
  }
  return false;
}

function strictQuery(url: URL, allowed: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || seen.has(key)) {
      throw new ObserverControllerError("INVALID_QUERY", "Observer query is invalid", 400);
    }
    seen.add(key);
  }
}

function boundedInteger(value: string | null, name: string, minimum: number, maximum: number): number {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ObserverControllerError("INVALID_QUERY", `${name} is invalid`, 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ObserverControllerError("INVALID_QUERY", `${name} is invalid`, 400);
  }
  return parsed;
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && boundedInteger(contentLength, "Content-Length", 0, MAX_REQUEST_BODY_BYTES) > MAX_REQUEST_BODY_BYTES) {
    throw new ObserverControllerError("INVALID_BODY", "Observer request body is too large", 413);
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BODY_BYTES) {
    throw new ObserverControllerError("INVALID_BODY", "Observer request body is too large", 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ObserverControllerError("INVALID_BODY", "Observer request body is invalid", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ObserverControllerError("INVALID_BODY", "Observer request body is invalid", 400);
  }
  return parsed as Record<string, unknown>;
}

function exactRoute(value: unknown): ObserverRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ObserverControllerError("INVALID_ROUTE", "Observer route is invalid", 400);
  }
  const route = value as Record<string, unknown>;
  if (Object.keys(route).length !== 2 ||
      typeof route.sessionId !== "string" || route.sessionId.length < 1 || route.sessionId.length > 256 ||
      typeof route.branchId !== "string" || route.branchId.length < 1 || route.branchId.length > 256) {
    throw new ObserverControllerError("INVALID_ROUTE", "Observer route is invalid", 400);
  }
  return { sessionId: route.sessionId, branchId: route.branchId };
}

function apiRequestAllowed(request: Request, origin: string, changing: boolean): boolean {
  if (request.headers.get("sec-fetch-site") !== "same-origin") return false;
  if (changing && request.headers.get("origin") !== origin) return false;
  return true;
}

function snapshotData(snapshot: ObserverBrowserSnapshot): ObserverBrowserSnapshot {
  return snapshot;
}

export async function startObserverServer(input: {
  readonly controller: ObserverController;
  readonly port: number;
}): Promise<ObserverServer> {
  const bootstrapToken = token();
  const sessions = new Set<string>();
  const streamClosers = new Set<() => void>();
  let actualPort = 0;
  let stopping = false;
  let origin = "";
  let expectedHost = "";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port,
    idleTimeout: 0,
    fetch: async request => {
      const host = request.headers.get("host");
      if (host !== expectedHost) return problem("INVALID_HOST", "Observer Host header is invalid", 400);
      const url = new URL(request.url);
      const asset = ASSETS[url.pathname as keyof typeof ASSETS];
      if (asset && request.method === "GET" && url.search === "") {
        const file = Bun.file(asset.url);
        if (!await file.exists()) return problem("ASSET_UNAVAILABLE", "Observer asset is unavailable", 500);
        return response(file, 200, asset.contentType, asset.sensitive);
      }
      if (!url.pathname.startsWith("/api/")) {
        return problem("NOT_FOUND", "Observer route was not found", 404);
      }
      if (!apiRequestAllowed(request, origin, request.method === "POST")) {
        return problem("CROSS_SITE_REJECTED", "Observer request must be same-origin", 403);
      }

      try {
        if (request.method === "POST" && url.pathname === "/api/session") {
          strictQuery(url, new Set());
          const supplied = request.headers.get("x-agencity-observe-bootstrap") ?? "";
          if (!equalSecret(supplied, bootstrapToken)) {
            return problem("UNAUTHORIZED", "Observer bootstrap token is invalid", 401);
          }
          const session = token();
          sessions.add(session);
          return envelope({ established: true }, 200, {
            "Set-Cookie": `${COOKIE_NAME}=${session}; HttpOnly; SameSite=Strict; Path=/api`,
          });
        }
        if (!validSession(request, sessions)) {
          return problem("UNAUTHORIZED", "Observer browser session is required", 401);
        }

        if (request.method === "GET" && url.pathname === "/api/family/stream") {
          strictQuery(url, new Set(["generation", "after"]));
          const generation = url.searchParams.get("generation");
          if (!generation || generation.length > 256) {
            throw new ObserverControllerError("INVALID_QUERY", "Observer generation is invalid", 400);
          }
          const after = boundedInteger(url.searchParams.get("after"), "after", 0, Number.MAX_SAFE_INTEGER);
          const release = await input.controller.attach();
          return createBrowserStream(
            input.controller,
            generation,
            after,
            release,
            streamClosers,
            request.signal,
          );
        }

        const release = await input.controller.attach();
        try {
          if (request.method === "GET" && url.pathname === "/api/bootstrap") {
            strictQuery(url, new Set(["rootsLimit", "rootsCursor"]));
            if (url.searchParams.has("rootsLimit")) {
              boundedInteger(url.searchParams.get("rootsLimit"), "rootsLimit", 1, 100);
            }
            return envelope(snapshotData(input.controller.snapshot(url.searchParams.get("rootsCursor"))));
          }
          if (request.method === "POST" && url.pathname === "/api/family/select") {
            strictQuery(url, new Set());
            const body = await jsonBody(request);
            if (Object.keys(body).some(key => !["version", "generation", "route"].includes(key)) ||
                body.version !== OBSERVER_PROTOCOL || typeof body.generation !== "string") {
              throw new ObserverControllerError("INVALID_BODY", "Observer selection request is invalid", 400);
            }
            return envelope(snapshotData(await input.controller.selectRoot(
              exactRoute(body.route),
              body.generation,
            )));
          }
          if (request.method === "GET" && url.pathname === "/api/family/snapshot") {
            strictQuery(url, new Set());
            return envelope(snapshotData(input.controller.snapshot()));
          }
          if (request.method === "GET" && url.pathname === "/api/family/detail") {
            strictQuery(url, new Set(["section", "sessionId", "branchId", "limit", "cursor", "itemId"]));
            const sessionId = url.searchParams.get("sessionId");
            const branchId = url.searchParams.get("branchId");
            const section = url.searchParams.get("section");
            if (!sessionId || !branchId || !section || sessionId.length > 256 || branchId.length > 256) {
              throw new ObserverControllerError("INVALID_QUERY", "Observer detail route is invalid", 400);
            }
            const limit = url.searchParams.has("limit")
              ? boundedInteger(url.searchParams.get("limit"), "limit", 1, OBSERVER_BOUNDS.detailItems)
              : undefined;
            const itemId = url.searchParams.get("itemId");
            if (itemId !== null && (itemId.length < 1 || itemId.length > 256)) {
              throw new ObserverControllerError("INVALID_QUERY", "Observer detail item identity is invalid", 400);
            }
            return envelope({
              generation: input.controller.snapshot().generation,
              page: input.controller.detail({
                route: { sessionId, branchId },
                section,
                ...(limit === undefined ? {} : { limit }),
                cursor: url.searchParams.get("cursor"),
                itemId,
              }),
            });
          }
          return problem("NOT_FOUND", "Observer API route was not found", 404);
        } finally {
          release();
        }
      } catch (error) {
        if (error instanceof ObserverControllerError) {
          return problem(error.code, error.message, error.status);
        }
        return problem("OBSERVER_UNAVAILABLE", "Observer request could not be completed", 503);
      }
    },
  });

  const boundPort = server.port;
  if (!Number.isSafeInteger(boundPort) || boundPort === undefined || boundPort < 1) {
    server.stop(true);
    throw new Error("Observer server did not report its loopback port");
  }
  actualPort = boundPort;
  expectedHost = `127.0.0.1:${actualPort}`;
  origin = `http://${expectedHost}`;
  return {
    port: actualPort,
    bootstrapToken,
    url: `${origin}/#token=${bootstrapToken}`,
    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      for (const close of [...streamClosers]) close();
      sessions.clear();
      await input.controller.stop();
      server.stop(true);
    },
  };
}

function createBrowserStream(
  controller: ObserverController,
  generation: string,
  after: number,
  releaseAttachment: () => void,
  closers: Set<() => void>,
  requestSignal: AbortSignal,
): Response {
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let unsubscribe = (): void => {};
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const encoder = new TextEncoder();
  const pending = new ObserverSseQueue();
  const requestAborted = (): void => close();

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    requestSignal.removeEventListener("abort", requestAborted);
    closers.delete(close);
    releaseAttachment();
    try { streamController?.close(); } catch {}
  };
  closers.add(close);
  if (requestSignal.aborted) close();
  else requestSignal.addEventListener("abort", requestAborted, { once: true });

  const flush = (): void => {
    if (!streamController || closed) return;
    while (pending.length > 0 && (streamController.desiredSize ?? 1) > 0) {
      const chunk = pending.shift()!;
      streamController.enqueue(chunk);
    }
  };
  const enqueueRaw = (value: string): boolean => {
    const bytes = encoder.encode(value);
    if (!pending.enqueue(bytes)) return false;
    flush();
    return true;
  };
  const enqueueEnvelope = (envelope: ObserverStreamEnvelope): boolean => {
    if (serializedUtf8Bytes(envelope) > OBSERVER_BOUNDS.streamEnvelopeBytes) return false;
    return enqueueRaw(`event: ${envelope.payload.kind}\ndata: ${JSON.stringify(envelope)}\n\n`);
  };
  const resyncAndClose = (
    reason: "replay_overflow" | "generation_mismatch" | "replay_unavailable",
  ): void => {
    pending.clear();
    const snapshot = controller.snapshot();
    const envelope: ObserverStreamEnvelope = {
      version: OBSERVER_PROTOCOL,
      generation: snapshot.generation,
      sequence: snapshot.sequence,
      managedInstanceId: snapshot.managedInstanceId ?? "",
      payload: { kind: "resync_required", reason },
    };
    const bytes = encoder.encode(
      `event: resync_required\ndata: ${JSON.stringify(envelope)}\n\n`,
    );
    if (streamController && !closed) streamController.enqueue(bytes);
    else pending.enqueue(bytes);
    queueMicrotask(close);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(target) {
      streamController = target;
      enqueueRaw(": connected\n\n");
      const replay = controller.replay(generation, after);
      if (replay.kind === "resync_required") {
        resyncAndClose(replay.reason);
        return;
      }
      for (const envelope of replay.envelopes) {
        if (!enqueueEnvelope(envelope)) {
          resyncAndClose("replay_overflow");
          return;
        }
      }
      unsubscribe = controller.subscribe((update: ObserverControllerUpdate) => {
        if (update.kind === "resync") resyncAndClose("generation_mismatch");
        else if (!enqueueEnvelope(update.envelope)) resyncAndClose("replay_overflow");
      });
      heartbeat = setInterval(() => {
        if (!enqueueRaw(": heartbeat\n\n")) resyncAndClose("replay_overflow");
      }, BROWSER_HEARTBEAT_MS);
    },
    pull() {
      flush();
    },
    cancel() {
      close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: baseHeaders("text/event-stream; charset=utf-8", true),
  });
}

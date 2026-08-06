import { DependencyFailureError, ValidationError } from "../domain/index.ts";
import type { MemoryCandidateIndex } from "../runtime/memory.ts";
import { requireCapability, type PlacementDescriptor } from "./capabilities.ts";
import { errorResponse, jsonResponse, normalizedEndpoint, readWireResponse } from "./http-wire.ts";

export interface CandidateIndexCapabilities {
  readonly deterministicMemoryIds: true;
  readonly candidateGenerationOnly: true;
  readonly authoritativePolicyFiltering: false;
  readonly rebuild: boolean;
}
export type CandidateIndexPlacementDescriptor = PlacementDescriptor<CandidateIndexCapabilities> & {
  readonly protocol: "agencity-candidate-index-http-v1" | "in-process";
};

export function localCandidateIndexDescriptor(index: MemoryCandidateIndex): CandidateIndexPlacementDescriptor {
  return {
    name: index.name,
    placement: "local",
    transport: "in-process",
    protocol: "in-process",
    capabilities: {
      deterministicMemoryIds: true,
      candidateGenerationOnly: true,
      authoritativePolicyFiltering: false,
      rebuild: true,
    },
  };
}

export interface CandidateIndexRpcServerOptions { readonly rebuild?: boolean; readonly maximumCandidates?: number }

/** HTTP service boundary for a server-owned FTS/semantic candidate store. */
export function createCandidateIndexRpcHandler(
  index: MemoryCandidateIndex,
  options: CandidateIndexRpcServerOptions = {},
): (request: Request) => Promise<Response> {
  const maximumCandidates = options.maximumCandidates ?? 500;
  const descriptor: CandidateIndexPlacementDescriptor = {
    name: `http-candidate:${index.name}`,
    placement: "remote",
    transport: "http",
    protocol: "agencity-candidate-index-http-v1",
    capabilities: {
      deterministicMemoryIds: true,
      candidateGenerationOnly: true,
      authoritativePolicyFiltering: false,
      rebuild: options.rebuild ?? false,
    },
  };
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/candidate-index/capabilities") return jsonResponse(descriptor);
    try {
      if (request.method === "POST" && url.pathname === "/v1/candidate-index/query") {
        const body = await request.json() as { query?: unknown };
        if (typeof body.query !== "string") throw new ValidationError("Candidate-index query must be a string");
        return jsonResponse({ candidates: (await index.candidates(body.query)).slice(0, maximumCandidates) });
      }
      if (request.method === "POST" && url.pathname === "/v1/candidate-index/rebuild") {
        requireCapability(descriptor.name, "rebuild", descriptor.capabilities.rebuild);
        await index.rebuild();
        return jsonResponse({ rebuilt: true });
      }
      return jsonResponse({ error: { code: "NOT_FOUND", message: "Unknown candidate-index route", details: {} } }, 404);
    } catch (error) { return errorResponse(error); }
  };
}

function isCandidateDescriptor(value: unknown): value is CandidateIndexPlacementDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>, capabilities = item.capabilities;
  if (typeof item.name !== "string" || item.protocol !== "agencity-candidate-index-http-v1" || item.placement !== "remote" || item.transport !== "http" || !capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  const flags = capabilities as Record<string, unknown>;
  return flags.deterministicMemoryIds === true && flags.candidateGenerationOnly === true && flags.authoritativePolicyFiltering === false && typeof flags.rebuild === "boolean";
}

export interface HttpMemoryCandidateIndexOptions {
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>);
  readonly requestTimeoutMs?: number;
}

export class HttpMemoryCandidateIndex implements MemoryCandidateIndex {
  readonly name: string;
  readonly placement: CandidateIndexPlacementDescriptor;
  readonly #endpoint: string;
  readonly #headers?: HttpMemoryCandidateIndexOptions["headers"];
  readonly #timeoutMs: number;

  private constructor(options: HttpMemoryCandidateIndexOptions, descriptor: CandidateIndexPlacementDescriptor) {
    this.#endpoint = normalizedEndpoint(options.endpoint);
    this.#headers = options.headers;
    this.#timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.placement = descriptor;
    this.name = descriptor.name;
  }

  static async connect(options: HttpMemoryCandidateIndexOptions): Promise<HttpMemoryCandidateIndex> {
    const endpoint = normalizedEndpoint(options.endpoint);
    let response: Response;
    try {
      const supplied = typeof options.headers === "function" ? await options.headers() : options.headers;
      response = await fetch(`${endpoint}/v1/candidate-index/capabilities`, {
        ...(supplied === undefined ? {} : { headers: supplied }),
        signal: AbortSignal.timeout(options.requestTimeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new DependencyFailureError("Remote candidate-index capability discovery failed", {
        endpoint, cause: error instanceof Error ? error.message : String(error),
      });
    }
    const descriptor = await readWireResponse(response, "Remote candidate index");
    if (!isCandidateDescriptor(descriptor)) {
      throw new DependencyFailureError("Remote candidate index advertised an incompatible protocol or capabilities", { endpoint });
    }
    return new HttpMemoryCandidateIndex(options, descriptor);
  }

  async #fetch(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      const supplied = typeof this.#headers === "function" ? await this.#headers() : this.#headers;
      response = await fetch(`${this.#endpoint}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...supplied },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new DependencyFailureError("Remote candidate-index transport failed", {
        adapter: this.name,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    return readWireResponse(response, "Remote candidate index");
  }

  async candidates(query: string): Promise<Array<{ versionId: string; entryId: string; rank: number }>> {
    if (typeof query !== "string") throw new ValidationError("Candidate-index query must be a string");
    const body = await this.#fetch("/v1/candidate-index/query", { query });
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as { candidates?: unknown }).candidates)) {
      throw new DependencyFailureError("Remote candidate index returned a malformed candidate set", { adapter: this.name });
    }
    const unique = new Map<string, { versionId: string; entryId: string; rank: number }>();
    for (const raw of (body as { candidates: unknown[] }).candidates) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DependencyFailureError("Remote candidate index returned a malformed candidate", { adapter: this.name });
      const item = raw as Record<string, unknown>;
      if (typeof item.versionId !== "string" || !item.versionId || typeof item.entryId !== "string" || !item.entryId || typeof item.rank !== "number" || !Number.isFinite(item.rank)) {
        throw new DependencyFailureError("Remote candidate index returned an invalid stable ID or rank", { adapter: this.name });
      }
      const prior = unique.get(item.versionId);
      const candidate = { versionId: item.versionId, entryId: item.entryId, rank: item.rank };
      if (!prior || candidate.rank < prior.rank) unique.set(candidate.versionId, candidate);
    }
    return [...unique.values()].sort((left, right) => left.rank - right.rank || left.versionId.localeCompare(right.versionId));
  }

  async rebuild(): Promise<void> {
    requireCapability(this.name, "rebuild", this.placement.capabilities.rebuild);
    await this.#fetch("/v1/candidate-index/rebuild", {});
  }
}

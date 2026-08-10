import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ArtifactPutOptions, ArtifactStore } from "../artifacts/index.ts";
import {
  CapabilityUnavailableError,
  DependencyFailureError,
  OUTPUT_LIMITS,
  ValidationError,
  type ArtifactReference,
} from "../domain/index.ts";
import { type PlacementDescriptor } from "./capabilities.ts";
import { normalizedEndpoint } from "./http-wire.ts";

export interface ObjectCasCapabilities {
  readonly stableSha256Identity: true;
  readonly integrityVerification: true;
  readonly rangeReads: boolean;
  readonly deletion: boolean;
  readonly conditionalCreate: boolean;
}

export type ObjectCasPlacementDescriptor = PlacementDescriptor<ObjectCasCapabilities> & {
  readonly protocol: "local-filesystem-cas-v1" | "s3-compatible-http-v1";
};

export function localObjectCasDescriptor(store: ArtifactStore): ObjectCasPlacementDescriptor {
  return {
    name: store.name,
    placement: "local",
    transport: "in-process",
    protocol: "local-filesystem-cas-v1",
    capabilities: {
      stableSha256Identity: true,
      integrityVerification: true,
      rangeReads: true,
      deletion: true,
      conditionalCreate: true,
    },
  };
}

export interface ObjectRequestAuthorization {
  readonly method: "PUT" | "GET" | "DELETE";
  readonly url: string;
  readonly key: string;
  readonly digest: string;
}

export interface S3CompatibleArtifactStoreOptions {
  /** S3/R2 origin, without bucket. Path-style HTTP is deliberately portable. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly prefix?: string;
  readonly headers?: Readonly<Record<string, string>> | ((request: ObjectRequestAuthorization) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>);
  readonly requestTimeoutMs?: number;
  readonly name?: string;
}

function digestHex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}
function digestBase64(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("base64");
}
function segment(value: string): string { return encodeURIComponent(value).replaceAll("%2F", "/"); }

/** Uses S3/R2 path-style PUT/GET/DELETE, without importing or exposing an SDK type. */
export class S3CompatibleArtifactStore implements ArtifactStore {
  readonly name: string;
  readonly placement: ObjectCasPlacementDescriptor;
  readonly #endpoint: string;
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #headers?: S3CompatibleArtifactStoreOptions["headers"];
  readonly #timeoutMs: number;

  constructor(options: S3CompatibleArtifactStoreOptions) {
    if (!options.bucket.trim() || options.bucket.includes("/")) throw new ValidationError("Object CAS bucket must be a single path segment");
    this.#endpoint = normalizedEndpoint(options.endpoint);
    this.#bucket = options.bucket;
    this.#prefix = (options.prefix ?? "artifacts").replace(/^\/+|\/+$/g, "");
    this.#headers = options.headers;
    this.#timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.name = options.name ?? "s3-compatible-cas";
    this.placement = {
      name: this.name,
      placement: "remote",
      transport: "http",
      protocol: "s3-compatible-http-v1",
      capabilities: {
        stableSha256Identity: true,
        integrityVerification: true,
        rangeReads: true,
        deletion: true,
        conditionalCreate: true,
      },
    };
  }

  #validate(reference: ArtifactReference): void {
    if (!/^[a-f0-9]{64}$/.test(reference.digest)) throw new ValidationError("Invalid artifact digest");
    if (reference.artifactId !== `sha256:${reference.digest}`) {
      throw new DependencyFailureError("Artifact identity does not match digest", {
        artifactId: reference.artifactId,
        digest: reference.digest,
      });
    }
    if (!Number.isSafeInteger(reference.size) || reference.size < 0) throw new ValidationError("Invalid artifact size");
  }
  #key(digest: string): string { return `${this.#prefix ? `${this.#prefix}/` : ""}sha256/${digest.slice(0, 2)}/${digest}`; }
  #url(key: string): string { return `${this.#endpoint}/${encodeURIComponent(this.#bucket)}/${segment(key)}`; }
  async #authorized(method: ObjectRequestAuthorization["method"], key: string, digest: string): Promise<Readonly<Record<string, string>>> {
    const url = this.#url(key);
    return typeof this.#headers === "function" ? this.#headers({ method, url, key, digest }) : this.#headers ?? {};
  }
  async #fetch(method: ObjectRequestAuthorization["method"], key: string, digest: string, init: RequestInit = {}): Promise<Response> {
    try {
      const authorization = await this.#authorized(method, key, digest);
      return await fetch(this.#url(key), {
        ...init,
        method,
        headers: { ...authorization, ...init.headers },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new DependencyFailureError("Remote object CAS transport failed", {
        adapter: this.name,
        method,
        key,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
  async #httpFailure(response: Response, operation: string, reference?: ArtifactReference): Promise<never> {
    const responseText = await response.text().catch(() => "");
    throw new DependencyFailureError(`Remote object CAS ${operation} failed with HTTP ${response.status}`, {
      adapter: this.name,
      status: response.status,
      ...(reference === undefined ? {} : { artifactId: reference.artifactId }),
      ...(responseText ? { response: responseText.slice(0, 512) } : {}),
    });
  }

  async put(content: Uint8Array | string, options: ArtifactPutOptions = {}): Promise<ArtifactReference> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
    const digest = digestHex(bytes), key = this.#key(digest);
    const reference: ArtifactReference = {
      artifactId: `sha256:${digest}`,
      digest,
      mediaType: options.mediaType ?? "application/octet-stream",
      size: bytes.byteLength,
    };
    const response = await this.#fetch("PUT", key, digest, {
      headers: {
        "content-type": reference.mediaType,
        "content-length": String(reference.size),
        "if-none-match": "*",
        "x-amz-checksum-sha256": digestBase64(bytes),
        "x-amz-meta-sha256": digest,
      },
      body: bytes,
    });
    // Existing digest-keyed content is a successful idempotent put. Reads still
    // verify bytes, so a corrupt pre-existing object cannot masquerade as valid.
    if (!response.ok && response.status !== 409 && response.status !== 412) await this.#httpFailure(response, "put", reference);
    // The checksum header asks a compliant object service to reject corruption;
    // resolving here also detects a broken/incompatible service before put is
    // reported as a durable success.
    await this.resolve(reference);
    return reference;
  }

  async resolve(reference: ArtifactReference): Promise<Uint8Array> {
    this.#validate(reference);
    const response = await this.#fetch("GET", this.#key(reference.digest), reference.digest);
    if (!response.ok) await this.#httpFailure(response, response.status === 404 ? "resolve missing content" : "resolve", reference);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== reference.size || digestHex(bytes) !== reference.digest) {
      throw new DependencyFailureError("Artifact integrity check failed", {
        artifactId: reference.artifactId,
        expectedDigest: reference.digest,
        actualDigest: digestHex(bytes),
        expectedSize: reference.size,
        actualSize: bytes.byteLength,
      });
    }
    return bytes;
  }

  async verify(reference: ArtifactReference): Promise<boolean> {
    try { await this.resolve(reference); return true; }
    catch { return false; }
  }

  async readRange(reference: ArtifactReference, start: number, end: number): Promise<Uint8Array> {
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < start) {
      throw new ValidationError("Invalid artifact range");
    }
    this.#validate(reference);
    if (start > reference.size || end > reference.size) throw new ValidationError("Artifact range exceeds immutable content size");
    if (end - start > OUTPUT_LIMITS.artifactRangeBytes) {
      throw new ValidationError(`Artifact range exceeds ${OUTPUT_LIMITS.artifactRangeBytes} bytes`);
    }
    if (end === start) return new Uint8Array();
    if (reference.size <= OUTPUT_LIMITS.artifactRangeBytes) {
      return (await this.resolve(reference)).slice(start, end);
    }
    const response = await this.#fetch("GET", this.#key(reference.digest), reference.digest, {
      headers: { range: `bytes=${start}-${end - 1}` },
    });
    if (response.status !== 206) {
      if (!response.ok) await this.#httpFailure(response, "range read", reference);
      // Never buffer a large whole-object response from a placement that
      // ignored Range. Its advertised capability is not usable.
      await response.body?.cancel().catch(() => {});
      throw new CapabilityUnavailableError(
        "remote artifact range reads",
        `${this.name} did not honor the required HTTP Range request`,
      );
    }
    const expectedContentRange = `bytes ${start}-${end - 1}/${reference.size}`;
    if (response.headers.get("content-range") !== expectedContentRange) {
      await response.body?.cancel().catch(() => {});
      throw new DependencyFailureError("Remote object CAS returned an invalid content range", {
        artifactId: reference.artifactId,
        expectedContentRange,
        actualContentRange: response.headers.get("content-range"),
      });
    }
    const metadataDigest = response.headers.get("x-amz-meta-sha256");
    const checksum = response.headers.get("x-amz-checksum-sha256");
    if (metadataDigest !== reference.digest && checksum !== Buffer.from(reference.digest, "hex").toString("base64")) {
      await response.body?.cancel().catch(() => {});
      throw new DependencyFailureError("Remote object CAS range lacks matching immutable digest metadata", {
        artifactId: reference.artifactId,
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== end - start) {
      throw new DependencyFailureError("Remote object CAS returned an incomplete byte range", {
        artifactId: reference.artifactId,
        expectedSize: end - start,
        actualSize: bytes.byteLength,
      });
    }
    return bytes;
  }

  async export(reference: ArtifactReference, destination: string): Promise<void> {
    const bytes = await this.resolve(reference);
    const target = resolve(destination);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, bytes);
  }

  async delete(reference: ArtifactReference): Promise<void> {
    this.#validate(reference);
    const response = await this.#fetch("DELETE", this.#key(reference.digest), reference.digest);
    if (!response.ok && response.status !== 404) await this.#httpFailure(response, "delete", reference);
  }
}

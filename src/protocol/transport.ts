/** Transport boundary shared by loopback HTTP and contract-identical in-process clients. */
export interface ProtocolTransport {
  readonly kind: "http" | "in-process";
  request(path: string, init?: RequestInit): Promise<Response>;
}

export interface ProtocolRequestHandler {
  handle(request: Request): Promise<Response>;
}

/** Loopback HTTP transport. Authentication stays in headers and never enters URLs. */
export class HttpProtocolTransport implements ProtocolTransport {
  readonly kind = "http" as const;
  readonly baseUrl: string;
  constructor(baseUrl: string, readonly bearerToken?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.bearerToken) headers.set("authorization", `Bearer ${this.bearerToken}`);
    return fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }
}

/**
 * Disposable embedded adapter used by diagnostics and tests. It calls the same
 * public ProtocolServer.handle router as HTTP; it is not a private Supervisor client.
 */
export class InProcessProtocolTransport implements ProtocolTransport {
  readonly kind = "in-process" as const;
  readonly baseUrl = "http://agencity.in-process";
  constructor(readonly handler: ProtocolRequestHandler, readonly bearerToken?: string) {}
  request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.bearerToken) headers.set("authorization", `Bearer ${this.bearerToken}`);
    return this.handler.handle(new Request(`${this.baseUrl}${path}`, { ...init, headers }));
  }
}

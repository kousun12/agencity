import { AgentRuntimeError } from "../domain/index.ts";
import { ProtocolClientError } from "../protocol/index.ts";
import { scrubText } from "../security/index.ts";

export type RunCancellationRequest = (runId: string) => unknown | Promise<unknown>;
export type RunInterruptWriter = (message: string) => void;

/**
 * SIGINT state for the non-interactive product run command.
 *
 * Admission is an uncertainty boundary: without a returned run ID the client
 * cannot safely name a cancellation target, so interruption truthfully detaches.
 * Once admitted, the first interrupt requests durable cancellation and the next
 * detaches without claiming cancellation has completed.
 */
export class CliRunInterruptCoordinator {
  readonly detached: Promise<void>;
  #resolveDetached!: () => void;
  #runId: string | null = null;
  #cancellationStarted = false;
  #isDetached = false;

  constructor(
    readonly requestCancellation: RunCancellationRequest,
    readonly write: RunInterruptWriter,
  ) {
    this.detached = new Promise<void>((resolve) => { this.#resolveDetached = resolve; });
  }

  get isDetached(): boolean { return this.#isDetached; }

  admit(runId: string): void {
    if (!runId) throw new Error("Admitted run ID must be non-empty");
    if (this.#runId !== null && this.#runId !== runId) throw new Error("Run interrupt coordinator cannot change admitted run identity");
    this.#runId = runId;
  }

  interrupt(): void {
    if (this.#isDetached) return;
    if (this.#runId !== null && !this.#cancellationStarted) {
      const runId = this.#runId;
      this.#cancellationStarted = true;
      void Promise.resolve()
        .then(() => this.requestCancellation(runId))
        .then(() => this.write(`Durable cancellation requested for run ${runId}. Waiting for reconciliation; press Ctrl-C again to detach.`))
        .catch((error) => {
          this.write(`${renderCliRunInterruptError(error)} Cancellation was not confirmed; press Ctrl-C again to detach.`);
        });
      return;
    }
    this.#isDetached = true;
    this.write(this.#runId === null
      ? "Detaching before run admission was confirmed. The request may already have been durably accepted; durable/external work may outlive this client. Resume to inspect retained state."
      : "Detaching after a cancellation request. Durable/external work may outlive this client; cancellation is not confirmed.");
    this.#resolveDetached();
  }
}

export function renderCliRunInterruptError(error: unknown): string {
  const code = error instanceof ProtocolClientError
    ? error.code
    : error instanceof AgentRuntimeError
      ? error.code
      : "CLI_ERROR";
  const raw = error instanceof Error ? error.message : String(error);
  const prefix = `[${code}] `;
  return `Cancellation request failed [${code}]: ${scrubText(raw.startsWith(prefix) ? raw.slice(prefix.length) : raw)}.`;
}

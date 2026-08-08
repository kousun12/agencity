# ADR 0007: Managed workspace execution

- **Status:** Accepted
- **Date:** 2026-08-07
- **Scope:** Detached advancement, authenticated loopback access, leases, and process fencing
- **Extends:** [ADR 0001](./0001-durable-local-runtime-foundations.md)

## Context

Ordinary agent work must continue after a terminal client exits, and schedules and recovery need one process to advance a workspace without making the client durable identity. At the same time, two local processes must not both claim and commit the same work. A local service-discovery file or open port alone is not sufficient proof that a process still owns execution.

## Decision

An on-demand `ManagedWorkspaceService` owns product execution for one workspace. It admits and advances runs, resident root families, due wakes, recovery, and detached work. Product clients observe and control the service through the public snapshot, event, and command protocol. Client exit, Ctrl-C after detachment, or connection loss does not cancel durable work; explicit stop or cancellation does.

The service binds an ephemeral `127.0.0.1` port and publishes an owner-only discovery manifest. Every route, including health and event streaming, requires the random bearer token from that manifest. Discovery accepts a service only when authenticated health identity, protocol and configuration compatibility, process liveness, and the matching workspace lease agree. The token is not passed in process arguments or printed.

Execution ownership uses local compare-and-swap leases with monotonically retained fence tokens. The managed service holds a workspace lease and root-family leases under one device and process identity. An active workspace lease excludes root leases in that workspace; separate roots may otherwise be independently owned. Renewal and release require the exact device, process, and fence token.

The current fence proof is checked in the same LibSQL transaction as existing-session canonical appends and outbox claim or reset operations. A process that loses ownership cannot continue committing after another process takes over, even if its code is still running. Lease expiry or explicit release permits same-device process takeover and increments the fence.

The service shuts down admission and drains admitted protocol handlers and resident workers during graceful shutdown. It may exit after its configured quiescent period when no active run, effect, wake, schedule, heartbeat, resident worker, or attached client requires it. Under [ADR 0010](./0010-formal-model-tool-contracts.md), missing information ends the run as blocked; the retained blocked branch does not by itself keep the service alive.

## Consequences

- Detached runs and scheduled work do not depend on an attached terminal.
- Multiple product clients share one public service contract rather than owning session identity.
- Same-device process takeover is explicit and stale processes are fenced at durable commit boundaries.
- The owner-only manifest and bearer protect the loopback product service from accidental unauthenticated local use when filesystem permissions hold.
- Service discovery, lease renewal, recovery, draining, and idle exit add lifecycle complexity.
- The service is started on demand and is not an operating-system login daemon.

## Rejected alternatives and limitations

1. **Make the terminal client own execution.** Rejected because client exit or network loss would become task cancellation or identity loss.
2. **Use a PID file or open port as ownership authority.** Rejected because neither fences a stale process from committing.
3. **Rely on lease checks outside the commit transaction.** Rejected because ownership could change between the check and durable write.
4. **Treat process exit as cancellation.** Rejected because cancellation is a distinct durable user decision.
5. **Expose the managed protocol beyond loopback as implemented.** Rejected because the bearer and manifest are not a multi-tenant network authorization system.

Leases provide same-device process fencing only. The relational HTTP placement does not expose this version of caller-authenticated fencing, and the runtime does not provide distributed leases, task stealing, or automatic cross-device execution-owner failover. The advanced embedded diagnostic server remains a separate unauthenticated loopback surface.

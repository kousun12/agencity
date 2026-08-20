# Agencity Observe PRD and implementation plan

**Status:** Proposed  
**Date:** August 19, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related plans:** [Ergonomic agent-family navigation](./2026-08-07-ergonomic-agent-family-navigation-plan.md) and [Workspace Agents view](./2026-08-08-workspace-agents-view-plan.md)

## Summary

Agencity Observe is a localhost web interface for watching one active agent family:

```sh
agencity observe
```

It renders durable agents, parent-child delegation, mailbox messages, runs, model actions, TypeScript cells, effects, goals, gates, budgets, and unresolved outcomes as current state and live activity.

The command starts an independent observer web server. The observer is a disposable client of Agencity's public managed protocol. It does not own the workspace service, open the database, execute agent work, or become part of durable agent identity.

The first version is intentionally small:

- one workspace and one selected root family at a time;
- current state plus live updates;
- read-only behavior;
- a clean family graph with progressively deeper inspection;
- no full historical replay, durable observer index, or control actions.

## Product decisions

- The audience includes ordinary users, operators, and people viewing a demonstration.
- One interface serves those audiences through progressive disclosure rather than separate applications.
- Current state and live activity are required.
- Full historical replay is deferred before current state or live activity.
- The interface is observational in the first version.
- Steering and cancellation may be added later through an explicit privileged control boundary.
- One observer process follows one active root family at a time.
- `agencity observe` is the product entrypoint.
- The observer web server has an independent process and lifecycle.
- The managed Agencity protocol is the source boundary. Direct LibSQL access is prohibited.

## Goals

- Make the structure and activity of one agent family understandable at a glance.
- Show children appearing as durable delegated work is admitted.
- Show committed mailbox sends, delivery, acknowledgment, and queued work between family members.
- Let a user inspect a session route, run, model attempt, cell, effect, goal, gate, budget, and terminal outcome.
- Distinguish durable committed truth from provisional streaming progress.
- Preserve exact session, branch, task, event, run, cell, effect, and cursor provenance in deeper views.
- Survive observer refresh, observer restart, protocol reconnect, and managed-service restart without inventing or duplicating activity.
- Keep the observer replaceable and isolated from runtime ownership.
- Work through the supported source and linked-executable product entrypoints.

## Non-goals

- Steering, cancellation, message sending, task admission, model changes, or any other Agencity mutation in the first version.
- Full historical playback or arbitrary cursor scrubbing.
- Observing multiple root families or workspaces at once.
- A durable analytics database, event warehouse, or search index.
- Direct reads from canonical or projection tables.
- Replacing the terminal TUI.
- Making the observer a supervisor, service owner, scheduler, recovery process, or keep-alive daemon.
- Exposing the managed service bearer token to browser JavaScript.
- Adding browser-use tools or browser execution to model-generated work.
- Claiming remote, multi-user, or hostile-code-safe operation.

## Terms

- **Observer server:** The disposable localhost Bun process started by `agencity observe`.
- **Observer client:** A browser page connected to the observer server.
- **Route:** One exact `{ sessionId, branchId }` pair.
- **Active family:** One selected root route and the retained descendant routes reachable through durable child tasks.
- **Family graph:** A derived read-only graph of route nodes and retained task, mailbox, and branch relationships.
- **Durable activity:** A canonical event with an exact event ID and cursor.
- **Provisional progress:** Cursorless, process-local effect progress that may be dropped and is never replayed.
- **Observer projection:** Disposable in-memory state derived from protocol snapshots and streams.

## User experience

### Start

`agencity observe`:

1. resolves the workspace using ordinary product workspace discovery;
2. starts an observer server on `127.0.0.1`, using an ephemeral port unless `--port` is supplied;
3. prints the localhost URL;
4. discovers an existing managed Agencity service without starting, stopping, or taking ownership of it;
5. keeps serving if the managed service is unavailable and reconnects when it becomes available.

Stopping the command stops only the observer server. It does not stop sessions, runs, effects, workers, or the managed workspace service.

### Select one family

The observer reads `GET /product/sessions` and lists resumable root routes.

- If exactly one resumable initial root route exists, it is selected.
- Otherwise the browser presents a root-family selector.
- Selection is observer-local and process-local.
- Selection does not call `POST /product/select` and does not change the route resumed by ordinary `agencity`.
- Selecting another root replaces the current family projection and subscriptions.

### Main layout

The first interface has three depths:

1. **Overview** — the default family graph, status, task summaries, and live motion.
2. **Inspect** — details for the selected node, run, message, cell, effect, goal, or gate.
3. **Events** — exact new committed events observed during this observer connection, including cursor and provenance.

The default overview does not show raw prompts, code, tool input, tool output, or message bodies. Those values appear only after deliberate inspection.

The primary layout contains:

- a header with workspace, family, managed-service, and stream status;
- a stable parent-to-child family graph;
- a selected-item inspector;
- a bounded live-activity rail.

### Graph semantics

- Each node is one exact session and branch route.
- A node displays its name, branch when needed, depth, model, task summary, session status, and derived activity.
- A delegation edge comes from a retained task linking the exact parent and child routes.
- A message edge comes from retained mailbox events. The observer does not infer communication from assistant text.
- A branch-fork edge is visually distinct from delegation.
- Failed, blocked, cancelled, budget-exceeded, unknown, stale, unavailable, and cancellation-pending states remain distinct.
- Node positions remain stable while the selected family is unchanged.

Live animation is presentational. The committed snapshot and event cursors determine state.

### Inspectors

The node inspector reads the selected route's projected state and exposes:

- durable identity, parent, root, branch, model, profile summary, and session status;
- active and terminal runs with steps and typed outcomes;
- model attempts and usage;
- cells with bounded source, logs, result, and error;
- effects with executor, operation, origin, attempts, outcome, and uncertainty;
- tasks and mailbox state;
- budget limits and consumption;
- goals, gates, and current evaluations;
- artifacts as metadata only in the first version.

Large or sensitive fields are collapsed by default. Existing bounded and scrubbed protocol values remain authoritative; the observer does not recover omitted bytes through side channels.

## Architecture

```text
Browser
  -> observer HTTP/SSE
  -> observer projection and read-only source interface
  -> authenticated AgentClient adapter
  -> managed Agencity HTTP/SSE protocol
  -> canonical events and deterministic projections
```

### Process boundary

The observer server is a separate Bun process launched by the CLI command. The CLI composes workspace discovery, the observer source adapter, and the server, but the observer package does not import or construct:

- `Supervisor`;
- storage or LibSQL adapters;
- effect executors;
- the console worker pool;
- managed-service ownership or shutdown controls.

The observer may use public protocol types and pure event-reduction functions. Runtime access occurs only through a narrow read-only source interface implemented with `AgentClient`.

### Read-only source

The observer source initially needs:

- managed-service availability and status;
- the product session catalog;
- branch snapshots;
- branch committed-event streams and provisional progress;
- family records, tasks, and bounded mailbox pages when snapshot state is insufficient.

The source interface contains no generic request method and no mutation method. The browser receives a purpose-built observer API rather than a transparent proxy to the managed protocol.

### Family discovery

The observer builds one family breadth-first:

1. load the selected root snapshot;
2. read direct child task references;
3. load each exact child route;
4. repeat with a visited-route set;
5. preserve unavailable referenced children as explicit placeholder nodes.

The first version caps the projection at 64 routes. A larger family is shown as truncated with an exact omitted count when available. The cap is a display and resource bound, not a change to durable family state.

This fan-out avoids adding a runtime-specific visualization endpoint at the start. A general read-only recursive family projection or aggregate stream is considered only after measuring the first implementation.

### Live updates

The observer maintains one snapshot cursor per route and follows the existing snapshot-plus-cursor contract:

- cursors remain decimal strings and are compared as `BigInt`;
- committed events are applied serially;
- duplicate or older cursors are ignored;
- reconnect resumes after the last successfully applied cursor;
- a replacement snapshot may rebuild the disposable projection;
- newly created child tasks trigger bounded family discovery.

Provisional effect progress is held separately from durable state. It is removed on the matching committed outcome, disconnect, reconnect, or family switch.

The observer process does not retain a second durable event log. Its live-activity rail is bounded memory and begins with the current observer connection. Full retained state remains inspectable from branch snapshots.

### Observer web protocol

The initial observer server exposes only:

- static application assets;
- `GET /api/bootstrap`;
- `POST /api/family/select`, which changes only disposable observer selection;
- `GET /api/family/snapshot`;
- `GET /api/family/stream`.

The family stream multiplexes route snapshots, committed events, progress, availability, and projection replacement into one browser connection. Every envelope identifies its route. Durable envelopes retain the original event ID and cursor; observer-local sequence numbers do not replace canonical cursors.

The UI may use native DOM and SVG in the first implementation. No client framework or graph library is required until interaction complexity justifies one.

## Lifecycle and availability

- Starting the observer does not start the managed workspace service.
- Managed-service absence is a visible `unavailable` state, not a reason to open the database or create an embedded runtime.
- The observer watches validated service discovery and reconnects when the managed instance changes.
- A managed-service restart replaces branch subscriptions and rebuilds from fresh snapshots.
- The observer process remains available while the managed service is stopped.
- The observer creates no canonical events, profile preferences, workspace selection changes, or durable observer records.

An actively open branch SSE stream is an attached managed-service client under current service semantics and may keep that service non-quiescent. The observer server alone opens no branch streams until a browser is actively viewing a family. A non-keeping observer subscription would require a separate managed-service capability and is deferred.

## Security

The observer remains trusted-local:

- bind only to `127.0.0.1`;
- reject unexpected `Host` and cross-origin requests;
- emit no permissive CORS headers;
- use a restrictive Content Security Policy;
- keep the managed-service bearer token only in the observer process;
- never place that token in browser code, HTML, URLs, storage, logs, or errors;
- expose only the purpose-built observer routes;
- scrub errors before returning them to the browser;
- avoid caching sensitive API responses;
- show trusted-local authority and data sensitivity in the interface.

The observer issues its own random, process-local read token. The printed URL carries that token in the fragment, which is not sent in HTTP requests. Browser code uses it only in memory to authenticate observer API requests. This token grants access only to the observer's read-only API and is not the managed-service token.

The current managed token still grants broad owner-local authority to the observer process. A protocol-level read-only credential is the preferred later hardening boundary.

## Delivery plan

### 1. Command and independent server

- Add `observe` to product CLI parsing and help.
- Add an observer server module with explicit start and stop.
- Resolve the workspace and observe service discovery without ensuring or owning the managed service.
- Serve a minimal status page and read-only bootstrap response.
- Support an ephemeral port and the existing `--port` option.

### 2. Read-only adapter and projection

- Define the narrow observer source interface.
- Implement it through managed service discovery and `AgentClient`.
- Add observer-local root selection.
- Build the bounded recursive family projection from snapshots and child tasks.
- Preserve unavailable and truncated nodes explicitly.

### 3. Live family stream

- Subscribe to each loaded route using snapshot-plus-cursor semantics.
- Multiplex durable events and provisional progress to the browser.
- Discover newly admitted children.
- Rebuild cleanly across disconnect, service replacement, and family switch.

### 4. Minimal web interface

- Render the stable family graph with native SVG.
- Add Overview, Inspect, and Events depths.
- Add node, run, cell, effect, task, mailbox, budget, goal, and gate inspectors.
- Add bounded live activity and truthful connection state.
- Keep detailed payloads collapsed by default.

### 5. Verification and documentation

- Add unit tests for graph derivation, bounds, event deduplication, progress cleanup, and status rendering.
- Add integration tests for service unavailable, later connection, service restart, child admission, mailbox activity, and observer shutdown.
- Add an installed black-box test that launches only the linked `agencity observe` executable and verifies the localhost API without internal IDs or direct supervisor access.
- Verify that observer shutdown leaves managed sessions and service ownership unchanged.
- Update CLI help, user guide, protocol integration guidance, security documentation, and `AGENTS.md` implementation status when the feature ships.

## Acceptance criteria

The first version is complete when:

1. `agencity observe` prints a usable loopback URL from a source checkout and linked installation.
2. The observer remains open and reports unavailable when no managed service exists.
3. Starting Agencity later causes the observer to connect without restarting the observer.
4. A user can select one root family without changing Agencity's remembered product route.
5. Existing descendants appear as exact route nodes with durable task edges.
6. A newly admitted child appears without refreshing the browser.
7. A committed family message produces attributable edge activity and inspectable mailbox state.
8. Runs, cells, effects, goals, gates, budgets, and terminal outcomes are inspectable from projected state.
9. Provisional progress disappears on outcome or reconnect and is never presented as retained history.
10. Duplicate stream delivery does not duplicate durable activity.
11. Managed-service restart rebuilds the same committed family state.
12. Browser code never receives the managed-service bearer token.
13. No observer action appends a canonical event or executes an effect.
14. Stopping the observer does not stop or cancel Agencity work.

## Deferred work

- full historical replay and cursor scrubbing;
- bounded historical event paging and cross-route timeline reconstruction;
- multi-family and multi-workspace views;
- durable indexing, search, analytics, and exports;
- artifact-byte viewing;
- remote observer hosting;
- shared multi-user authorization;
- steering, cancellation, and other privileged controls;
- a protocol-level read-only managed-service credential;
- an aggregate recursive-family snapshot or stream;
- observer subscriptions that do not affect managed-service quiescence.

## Later control boundary

Steering and cancellation do not enter the existing read-only observer API.

A later control phase must add:

- an explicit capability and credential distinct from observation;
- clear action confirmation and target identity;
- canonical command receipts and resulting event links;
- stale-target and lost-connection handling;
- exact authorization and family-scope enforcement;
- tests proving that observation alone cannot invoke control routes.

The visual interface may reserve space for controls, but the first version does not render disabled controls that imply unavailable authority.

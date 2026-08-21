# Agencity Observe PRD and implementation plan

**Status:** In progress
**Date:** August 19, 2026  
**Corrected and rescoped:** August 20, 2026
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related plans:** [Ergonomic agent-family navigation](./2026-08-07-ergonomic-agent-family-navigation-plan.md) and [Workspace Agents view](./2026-08-08-workspace-agents-view-plan.md)

## Summary

Agencity Observe is a read-only localhost web interface for watching one active agent family:

```sh
agencity observe
```

It presents durable agents, parent-child delegation, mailbox lifecycles, runs, model actions, TypeScript cells, effects, goals, gates, budgets, and unresolved outcomes as bounded current state and live activity.

The foreground `agencity observe` process owns only the observer HTTP server and disposable observer projections. It is a read-only client of the existing managed workspace protocol. It does not initialize an Agencity workspace, start or stop the managed workspace service, open LibSQL, execute work, mutate product selection, or become part of durable agent identity.

The first version provides:

- one workspace and one process-wide selected initial root family;
- bounded current state and live updates;
- read-only behavior;
- a family graph with progressively deeper, lazy inspection;
- exact cursor provenance for newly observed committed events;
- item event IDs and enclosing snapshot cursors for retained projected items;
- no full historical replay, durable observer index, branch-topology view, or control actions.

## Product decisions

- The audience includes ordinary users, operators, and people viewing a demonstration.
- One interface serves those audiences through progressive disclosure.
- Current state and live activity are required.
- Full historical replay is not required for the first version.
- The interface is observational. Steering and cancellation require a later privileged control boundary.
- One observer process follows one selected initial root family at a time.
- Multiple authenticated browser tabs share the process-wide selection. Selecting a family in one tab replaces the family in every tab.
- `agencity observe` is a foreground product command. It does not spawn an observer child or detach.
- Omission of `--port` requests an ephemeral port. An explicit `--port` accepts a decimal integer from 1 through 65,535 and fails on a bind conflict rather than selecting another port.
- The observer uses read-only workspace discovery before ordinary product bootstrap can initialize state or connect the managed service.
- The managed Agencity protocol is the agent-state source boundary. Direct LibSQL or projection-table access is prohibited.
- Service manifest and workspace identity files may be observed as owner-only discovery metadata. They are not agent-state read side channels.
- The observer consumes the existing managed protocol: authenticated health identity, capabilities, the roots listing, full branch snapshots, and per-branch committed-event streams. Version one adds no new managed observation routes.
- Full `AgentState` values stay inside the observer process as disposable projection sources. Browser JavaScript receives only bounded observer DTOs and never a full `AgentState` serialization.
- The one managed-protocol change in version one is a periodic comment heartbeat on the existing branch stream so a dead upstream connection is detectable. Existing stream clients already tolerate comment lines.
- A process-local browser session cookie authenticates the observer web API and SSE stream. The managed-service bearer token never enters the browser.
- Branch-fork topology is deferred. A route node may display its branch name, but version one does not discover or render branch-fork edges.

## Goals

- Make the structure and activity of one agent family understandable at a glance.
- Show children appearing when durable delegated work is admitted.
- Show one coherent lifecycle for each committed family message: queued, delivered, delivered to context, acknowledged, or failed.
- Let a user inspect a route, run, model attempt, cell, effect, task, message, goal, gate, budget, artifact reference, and terminal outcome through bounded pages.
- Distinguish durable committed truth from provisional streaming progress.
- Preserve exact route and durable identity for projected items.
- Preserve exact event ID and cursor for committed events observed after attachment.
- Mark retained item provenance truthfully when only an item event ID and enclosing snapshot cursor are available.
- Survive browser refresh, protocol reconnect, observer restart, and managed-service replacement without mixing generations, inventing activity, or duplicating committed events.
- Release every upstream managed-service subscription when the last browser disconnects.
- Keep the observer replaceable and isolated from runtime ownership.
- Work through the supported source-checkout and linked-executable entrypoints.

## Non-goals

- Steering, cancellation, message sending, task admission, model changes, or any other Agencity mutation.
- Full historical playback, arbitrary cursor scrubbing, or recovery of historical item cursors that are absent from current projections.
- Observing multiple root families or workspaces at once.
- Per-tab independent family selection.
- Displaying branch-fork topology.
- A durable analytics database, event warehouse, or search index.
- Direct reads from canonical or projection tables.
- Forwarding full branch snapshots to browser JavaScript.
- Replacing the terminal TUI.
- Making the observer a supervisor, service owner, scheduler, recovery process, or daemon.
- Keeping the managed workspace service alive when no browser is attached.
- Exposing the managed-service bearer token to browser JavaScript.
- Adding browser-use tools or browser execution to model-generated work.
- Claiming remote, multi-user, or hostile-code-safe operation.

## Terms

- **Observer process:** The foreground Bun process running `agencity observe`.
- **Observer server:** The loopback HTTP server hosted by the observer process.
- **Observer client:** An authenticated browser page connected to the observer server.
- **Browser attachment:** One active authenticated observer API handler or family SSE stream. A retained session cookie without an active request or stream is not an attachment.
- **Route:** One exact `{ sessionId, branchId }` pair.
- **Selected root:** One resumable route whose session is a root session and whose branch is the session's initial branch.
- **Active family:** The selected root route and retained descendant routes reachable through durable child tasks.
- **Family graph:** A disposable read-only graph of route nodes, delegation edges, and message lifecycles.
- **Durable activity:** Metadata for a canonical event with its exact route, event ID, cursor, type, producer, and commit time.
- **Provisional progress:** Cursorless, process-local effect progress that may be dropped and is never replayed as durable history.
- **Observer DTO:** A versioned, bounded, read-only browser-facing response derived inside the observer process. It never contains a full `AgentState`.
- **Observer generation:** A random process-local identifier for one coherent observer state. It changes on family selection, managed-instance replacement, and explicit resync.
- **Observer sequence:** A process-local monotonically increasing SSE sequence within one observer generation. It supports browser catch-up but never replaces canonical route cursors.
- **Observer projection:** Disposable in-memory family state. For each loaded route it holds one full `AgentState` obtained from a branch snapshot and maintained by applying committed stream events with the pure domain reducer, the same pattern `AgentClient.watchBranch()` uses.

## State and availability model

The browser displays these states without collapsing them into generic unavailability:

- `workspace_uninitialized` — no valid owner-only workspace identity marker exists;
- `service_stopped` — no managed-service manifest exists;
- `service_stale` — a manifest exists but no matching live service can be established;
- `service_conflict` — authenticated identity or execution authority is inconsistent;
- `service_incompatible` — the protocol version range or a required capability is unsupported;
- `connecting` — the observer is validating one discovered managed instance;
- `connected` — bounded snapshots and streams belong to one authenticated authoritative instance;
- `resyncing` — the observer discarded one generation and is rebuilding from fresh snapshots;
- `route_unavailable` — a retained task references a route that cannot be loaded;
- `family_truncated` — the 64-route bound stopped discovery before the full descendant closure was loaded.

The observer never deletes stale manifests, repairs authority, starts a service, or opens storage to settle these states.

## User experience

### Start

`agencity observe`:

1. branches in CLI dispatch before `resolveWorkspace()` or `connectManagedService()`;
2. discovers the workspace root with read-only `observeWorkspace()` semantics;
3. starts the observer server in the command process on `127.0.0.1`;
4. generates a 256-bit base64url browser bootstrap token;
5. prints a URL using the actual bound port and a fragment containing that token;
6. serves the interface even when the workspace is uninitialized or the managed service is absent;
7. passively watches the workspace identity marker and managed-service manifest;
8. establishes authenticated managed-protocol access only while at least one browser is attached.

Example:

```text
http://127.0.0.1:43127/#token=<observer-bootstrap-token>
```

The command does not open a browser automatically. Ctrl-C, SIGINT, or SIGTERM closes browser streams, aborts every upstream request and subscription, stops the observer server, and exits. It does not stop sessions, runs, effects, workers, managed processes, or the managed workspace service.

The command accepts only observer-relevant product options:

- `--workspace` or the compatible `--workspace-root` alias;
- `--port`;
- `--help`;
- `--version`.

Task text, model options, execution configuration, storage overrides, sync configuration, and mutation options are rejected for `observe`. Observer discovery does not reconstruct a managed-service execution configuration and does not compare an observer-derived execution configuration hash.

The existing discovery helpers do not satisfy these requirements: `observeManagedService()` compares an execution configuration hash, and `readServiceManifest()` may create missing metadata directories. The observer uses a strictly read-only manifest reader that never creates directories or files, retains the owner-only and `O_NOFOLLOW` validation patterns, and validates the service through the existing authenticated health identity — workspace ID, instance ID, and supported protocol version range — rather than a configuration hash.

### Browser session

The initial HTML and static assets contain no workspace or agent data.

1. Browser JavaScript reads the bootstrap token from the URL fragment.
2. It sends the token once in `X-Agencity-Observe-Bootstrap` to `POST /api/session`.
3. The server compares the token in constant time and returns a random 256-bit process-local session cookie.
4. The cookie is `HttpOnly`, `SameSite=Strict`, and scoped to `Path=/api`. The `Secure` attribute is omitted for cross-browser loopback-HTTP compatibility.
5. After a successful exchange, JavaScript removes the fragment with `history.replaceState`.
6. Browser refresh reuses the HttpOnly session cookie. JavaScript never reads that cookie.

The bootstrap token may establish browser sessions only for the lifetime of the observer process. Observer restart invalidates every browser session and prints a new bootstrap URL.

### Select one family

The observer requests the existing managed roots listing, which already contains only root initial-branch routes with their status. A selectable row is one whose status is neither `failed` nor `archived`.

Behavior:

- If exactly one selectable root exists, the observer selects it.
- If zero or multiple selectable roots exist, the browser presents a selector.
- The upstream roots listing is the existing unbounded managed route; its cost is accepted for the trusted-local first version. The observer sends the browser bounded selector pages of at most 100 rows and 256 KiB with the exact selectable-root count.
- Selection is process-local and shared by authenticated tabs.
- Selection never calls `POST /product/select` and never changes ordinary `agencity` resume selection.
- A selection request carries the expected observer generation. A stale request is rejected.
- Selecting another root aborts the old generation, discards provisional progress, builds a new generation, and broadcasts one projection replacement to all tabs.

### Main layout

The first interface has three depths:

1. **Overview** — family graph, route activity, task summaries, and live motion.
2. **Inspect** — lazy bounded pages for the selected node, run, message, cell, effect, task, goal, gate, budget, or artifact reference.
3. **Events** — exact committed event metadata observed during the current observer process connection.

The overview does not request raw prompts, source code, effect input, effect output, logs, or message bodies. Those values are fetched only when the user opens the corresponding inspector section.

The primary layout contains:

- a header with workspace, selected family, managed-service instance, generation, and stream status;
- a stable parent-to-child family graph;
- a selected-item inspector;
- a bounded live-activity rail.

### Graph semantics

- Each node is one exact route.
- A node displays bounded name, branch name, depth, model, task summary, session status, and runtime-derived family activity.
- A delegation edge comes from one retained task linking exact parent and child routes.
- Branch forks are not graph edges in version one.
- A message edge is keyed by `mailboxMessageId`, not by one event or route.
- Sent, delivered, context-delivered, acknowledged, and delivery-failed events update one message lifecycle.
- Every underlying canonical event remains a distinct item in the event rail.
- Communication is never inferred from assistant text.
- Failed, blocked, cancelled, budget-exceeded, unknown, stale, unavailable, truncated, and cancellation-pending states remain distinct.
- Node positions remain stable within one observer generation.

Live animation is presentational. Retained route states, exact route cursors, and committed events determine state.

### Inspectors and provenance

The observer derives these paged inspector sections from the retained state of one selected route:

- identity, parent, root, branch, model, active profile summary, and session status;
- active and terminal runs with steps and typed outcomes;
- model attempts and usage;
- cells with bounded source, logs, result, and error;
- effects with executor, operation, origin, attempt count, outcome, and uncertainty;
- exact-route tasks and mailbox state;
- budget limits and consumption;
- goals, gates, and current evaluations;
- artifact metadata without artifact bytes.

Each detail page:

- contains at most 50 items;
- is at most 128 KiB serialized;
- carries a version, route, snapshot cursor, pagination cursor, and truncation state;
- carries each item's durable ID and event ID when the current projection retains one;
- does not claim an exact historical event cursor unless that cursor is retained in the projection;
- represents oversized text with a bounded prefix or head/tail view, original UTF-8 byte count, completeness state, and digest when available;
- never resolves omitted bytes through a direct database, artifact, file, or history side channel.

The event rail is the exact-cursor view. Retained detail pages are current projections, not historical event reconstructions.

## Architecture

```text
Browser
  -> authenticated observer HTTP/SSE
  -> bounded observer DTOs
  -> disposable family projection: full route states + pure domain reducer
  -> narrow read-only observer source
  -> authenticated AgentClient read methods
  -> existing managed protocol: health, capabilities, roots listing,
     branch snapshots, per-branch committed-event streams
  -> canonical events and deterministic runtime projections
```

### Process and package boundary

The foreground CLI process hosts the observer server directly. There is no observer child process, daemon, detached mode, pid file, or durable observer manifest.

The observer package does not import or construct:

- `Supervisor`;
- storage or LibSQL adapters;
- effect executors;
- the console worker pool;
- product selection mutation;
- managed-service startup, shutdown, stale cleanup, or execution configuration;
- generic protocol request forwarding.

Only one adapter module may construct `AgentClient`. That adapter implements a narrow read-only interface. Observer server routes and browser DTO builders receive the narrow interface, never an unrestricted `AgentClient`.

Observer modules may import `src/domain/` for types and the pure `reduceAgentState` reducer.

`check:architecture` enforces:

- observer UI and HTTP modules cannot import runtime, storage, LibSQL, executors, or product service ownership;
- within `src/observe/` only, the observer source adapter module may import from `src/protocol/`; existing CLI, TUI, and product-service imports of `AgentClient` remain valid and unchecked by this rule. The rule is module-path based, matching the existing import-specifier checks in `scripts/check-architecture.ts`;
- the adapter exposes only approved read methods;
- checked-in web assets exist and resolve relative to `import.meta.url`;
- observer browser assets contain no managed-service route, bearer-token field, or generic proxy mechanism.

### Managed protocol usage

The observer uses only existing authenticated managed-protocol reads:

- the health route for workspace ID, instance ID, application version, and protocol version range;
- the capabilities route;
- the roots listing for family selection;
- the branch snapshot route, which returns one cursor plus one full `AgentState`;
- the per-branch committed-event stream with after-cursor resume and separate cursorless provisional progress.

For each loaded route the observer holds the snapshot `AgentState` in memory and applies committed stream events with the pure domain reducer, the established `AgentClient.watchBranch()` pattern. Everything the interface needs is derived from that retained state: delegation edges come from each route's durable `tasks` records, which carry exact child session and branch IDs; exact-route mailbox lifecycles come from mailbox records, which carry exact from- and to-branch IDs; runs, cells, effects, goals, gates, budgets, and artifact metadata come from their corresponding state records.

Full `AgentState` values and their event streams are process-internal. The observer serves the browser only bounded DTO pages derived from retained state. Upstream snapshot size is not bounded; the 64-route family bound is the observer's memory control, and this trade is accepted for the trusted-local first version.

Admission requires the existing capability flags — managed service, product catalog, snapshot-plus-cursor resume, committed-event deduplication, and cursorless progress — plus a protocol version range that includes the branch-stream heartbeat revision. An unsupported capability or version produces `service_incompatible`.

The one managed-protocol change is a periodic comment heartbeat on the existing branch stream, emitted at least every 15 seconds. SSE comment lines are already tolerated by existing clients, which receive an initial `: connected` comment today. The observer treats a stream silent for more than three heartbeat intervals as dead and triggers bounded rediscovery.

Version one adds no new relational tables, storage queries, or managed observation routes.

### Bounds

The first version applies these limits to browser-facing responses and observer work:

- browser root-selector page: 100 rows and 256 KiB;
- loaded family: 64 routes;
- concurrent family discovery requests: 4;
- one managed read timeout: 5 seconds;
- detail page: 50 items and 128 KiB;
- observer family snapshot delivered to a browser: 512 KiB;
- one browser SSE envelope: 64 KiB;
- browser SSE pending queue: 256 envelopes or 1 MiB, whichever is reached first;
- live-activity rail: 200 items or 1 MiB;
- observer replay buffer: 512 envelopes or 2 MiB.

Upstream branch snapshots are full `AgentState` values and are not byte-bounded. They are retained only in observer process memory, one per loaded route, so the 64-route family bound is the observer's memory control.

Crossing a page or family bound returns explicit `truncated` metadata. When the 64-route bound stops breadth-first discovery, the total descendant count is unknown unless retained task records already supplied it. The UI says that more routes were not loaded; it does not invent an exact omitted count.

Crossing a stream envelope bound omits the payload, retains event identity and digest metadata, and marks the affected inspector section stale. Crossing a browser queue or replay bound emits `resync_required`, discards provisional progress, and requires a fresh bounded family snapshot.

### Family discovery

The observer builds one family breadth-first:

1. load the selected root's branch snapshot;
2. derive direct-child task edges from that route's durable `tasks` records in canonical order;
3. enqueue exact child routes;
4. load at most four route snapshots concurrently;
5. continue traversal while total loaded routes remain below 64;
6. preserve referenced but unavailable children as placeholder nodes;
7. mark the graph truncated when reachable routes remain unloaded.

A visited-route set prevents cycles and duplicate loading. A task edge remains identified by `taskId`. Family discovery does not scan the product branch catalog for forks.

### Live updates and generations

The observer process owns one per-branch committed-event stream for each loaded route, up to the 64-route bound. Every authenticated browser tab shares these process-owned streams and the projection they maintain; tabs never open their own upstream connections. The observer maintains one managed route cursor per loaded route and one observer sequence per generation.

For the upstream route streams:

- cursors remain decimal strings and are compared as `BigInt`;
- committed events are applied serially per route through the pure domain reducer;
- duplicate or older route cursors are ignored;
- provisional progress remains separate from durable state;
- a committed effect outcome removes matching progress;
- a newly committed child task observed on a parent route schedules bounded family discovery, and each newly loaded route receives its own snapshot and stream;
- a stream silent for more than three managed heartbeat intervals is treated as dead and triggers bounded rediscovery.

Every asynchronous completion is checked against the current observer generation and managed `instanceId`. Results from an older generation are ignored.

Managed-service replacement:

1. aborts every route stream and pending read;
2. discards provisional progress;
3. validates the replacement manifest and authenticated health identity;
4. checks required capabilities and versions;
5. creates a new `AgentClient` inside the source adapter;
6. loads fresh route snapshots;
7. emits one projection replacement with a new observer generation.

`AgentClient.watchBranch()` alone is not replacement recovery because it snapshots only once and reconnects to one prior service. The observer lifecycle owns instance replacement.

The observer sends the browser an SSE heartbeat comment at least every 15 seconds. A disconnected or slow browser never causes an unbounded queue.

### Browser snapshot and stream race

`GET /api/bootstrap` and `GET /api/family/snapshot` return:

- observer protocol version;
- observer generation;
- current observer sequence;
- managed instance ID when connected;
- bounded family projection;
- exact per-route cursor map;
- truncation and availability state.

The browser opens:

```text
GET /api/family/stream?generation=<generation>&after=<observer-sequence>
```

The query carries no credential or managed cursor. The HttpOnly session cookie authenticates the request.

If the requested generation matches and the bounded replay buffer contains every later envelope, the server replays them in observer-sequence order. Otherwise it emits `resync_required` and closes the stream. Browser reconnect obtains a fresh family snapshot before reopening.

Each SSE envelope carries:

- observer protocol version;
- observer generation;
- observer sequence;
- managed instance ID;
- route when applicable;
- exact canonical event ID and route cursor for durable event metadata;
- a typed bounded payload.

Observer sequence supports browser catch-up only. Canonical route cursors remain authoritative for durable activity.

### Activity retention

The observer does not retain a second durable event log.

- The live rail begins with the current observer process.
- Browser refresh can catch up only within the bounded in-memory replay buffer.
- Observer restart reconstructs current committed state from fresh managed views.
- Observer restart resets the live rail and displays a new connection boundary.
- Observer restart forgets the process-local selection. A sole selectable root is selected again automatically; multiple roots require a new browser-local choice.
- Activity that occurred while the observer process was absent is reflected in current state but is not invented as replayed live activity.

## Observer web protocol

The observer server exposes only:

- `GET /` and checked-in static assets;
- `POST /api/session`;
- `GET /api/bootstrap`;
- `POST /api/family/select`;
- `GET /api/family/snapshot`;
- `GET /api/family/detail`;
- `GET /api/family/stream`.

Every `/api` response uses the versioned `agencity.observe.v1` envelope. There is no generic proxy, arbitrary path forwarding, mutation passthrough, SQL route, artifact-byte route, or managed-service URL route.

`POST /api/family/select` changes only process-local observer selection. It requires the current generation and returns the replacement snapshot.

`GET /api/family/detail` accepts only a closed section enum, exact projected item identity, bounded page limit, and opaque pagination cursor. It cannot accept a managed-protocol path or method.

### Static assets

Version one uses checked-in native browser assets:

- `src/observe/web/index.html`;
- `src/observe/web/app.js`;
- `src/observe/web/app.css`.

There is no frontend build step or client framework. Assets are resolved relative to the installed module with `import.meta.url`, never relative to the current working directory. HTML uses external scripts and styles only; no inline executable code is required.

The linked-executable acceptance test loads every initial asset while running from a different repository.

## Lifecycle and availability

- Starting the observer does not create `.agencity`, a workspace marker, a database, or a profile preference.
- Workspace initialization performed later by ordinary Agencity is detected without observer restart.
- Managed-service absence is `service_stopped`.
- An invalid, stale, incompatible, unauthenticated, or non-authoritative service is not treated as connected.
- The observer does not compare the service against an observer-derived execution configuration hash.
- The existing authenticated health and capabilities routes bind workspace ID, instance ID, protocol version range, and capability flags. No new status route is added.
- The observer never opens LibSQL to inspect an execution lease.
- The observer passively watches owner-only marker and manifest files while no browser is attached. Watching uses bounded-interval read-only polling of the exact known paths; it never creates directories or files and never sends an authenticated managed request, because any authenticated request resets the service idle timer.
- No authenticated managed request or branch stream is kept open while the browser attachment count is zero. A session cookie by itself does not keep the count above zero.
- On the first attached browser, the observer validates and connects to the currently discovered instance.
- On the last browser disconnect, the observer immediately aborts family discovery, detail reads, and every upstream route stream.
- While a browser remains attached, a route-stream failure, heartbeat silence, or manifest replacement triggers bounded rediscovery and generation replacement.
- The observer server remains available while the workspace or managed service is stopped.
- The observer creates no canonical events, effects, profile preferences, product selection changes, or durable observer records.

While at least one browser is attached, the observer process holds one committed-event stream per loaded route, up to 64, shared by every tab. Those streams are attached managed-service clients and may keep the service non-quiescent. The UI reports that fact. Closing the final browser releases every stream and permits ordinary quiescence.

## Security

The observer remains trusted-local:

- bind only to `127.0.0.1`;
- allow only the exact `Host` value `127.0.0.1:<actual-port>`;
- reject duplicate, malformed, or unexpected `Host`;
- emit no permissive CORS headers;
- require `Sec-Fetch-Site: same-origin` for browser API requests;
- require the exact observer origin on state-changing requests;
- use constant-time token and session-secret comparison;
- keep the managed-service bearer token only in the observer source adapter;
- never place the managed token in browser code, HTML, URLs, cookies, storage, logs, errors, or child-process data;
- expose only the closed observer routes;
- scrub errors before returning them to the browser;
- use `Cache-Control: no-store, private` and `Pragma: no-cache` for HTML and every API or SSE response;
- render trusted-local authority and data sensitivity in the interface.

Every response emits:

```text
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  style-src 'self';
  connect-src 'self';
  img-src 'self';
  base-uri 'none';
  form-action 'none';
  frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Cross-Origin-Resource-Policy: same-origin
Referrer-Policy: no-referrer
```

Static assets may use a content digest ETag, but responses remain `no-store` in version one.

### Untrusted content rendering

Task text, names, message bodies, model data, source, logs, errors, effect values, artifact names, and repository-authored content are untrusted.

The browser:

- creates text with `textContent` or text nodes;
- does not use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, or HTML Markdown rendering;
- treats code and Markdown as text;
- does not create SVG `foreignObject`;
- does not assign untrusted SVG event attributes, URLs, styles, or markup;
- allowlists any future link scheme and target before creating a link;
- never evaluates agent content as JavaScript, CSS, HTML, or a URL.

Adversarial tests cover HTML tags, SVG event attributes, `javascript:` URLs, bidi controls, CSP-breaking strings, large strings, and token-shaped values.

### Managed credential limitation

The observer source process possesses the existing broad owner-local managed bearer token. The narrow adapter, closed web API, import boundary, and route allowlist reduce accidental exposure but do not turn that token into least privilege.

A protocol-level read-only managed-service credential remains a later hardening boundary.

## Delivery plan

### 1. CLI admission, foreground server, and assets

- Add `observe` to product CLI parsing, dispatch, and help, updating both product command registries in `src/cli-args.ts` and `src/cli.ts`.
- Dispatch `observe` before mutable workspace resolution and managed-service connection, following the existing pre-bootstrap `doctor` dispatch shape.
- Reject task, model, execution, storage, sync, and mutation options.
- Validate omission-versus-explicit `--port` behavior and bind conflicts.
- Host the observer server in the foreground command process.
- Generate the browser bootstrap token only inside that process.
- Add signal-safe stop that aborts observer work without stopping Agencity.
- Add checked-in HTML, JavaScript, and CSS resolved from `import.meta.url`.

### 2. Read-only discovery and managed-service validation

This step is a separately verifiable milestone with its own tests before observer-package work begins.

- Add a strictly read-only manifest reader that never creates directories or files and retains owner-only and `O_NOFOLLOW` validation.
- Add passive bounded-interval workspace-marker and service-manifest polling.
- Validate the discovered service through the existing authenticated health identity and capability flags, without configuration-hash reconstruction.
- Add the periodic comment heartbeat to the existing branch stream, with tests proving existing stream clients are unaffected.
- Classify unsupported protocol versions and missing capabilities as `service_incompatible`.

### 3. Narrow source and disposable family projection

- Define the closed observer source interface over existing `AgentClient` read methods: health, capabilities, roots listing, branch snapshot, and branch stream.
- Confine `AgentClient` construction and `src/protocol/` imports to one adapter module.
- Add architecture checks for imports and allowed calls.
- Build breadth-first family discovery from durable task edges in retained route states.
- Maintain one full `AgentState` per loaded route with the pure domain reducer.
- Enforce route, browser-facing byte, concurrency, item, and timeout bounds.
- Filter exact-route mailbox activity in-process from retained from- and to-branch IDs, aggregated by `mailboxMessageId`.
- Preserve unavailable and truncated nodes explicitly.
- Keep historical item-cursor limitations explicit.

### 4. Generation-safe live updates

- Own one committed-event stream per loaded route in the observer process, shared by every browser tab, and open a snapshot plus stream for each newly discovered route.
- Track one managed cursor per route and one observer sequence per generation.
- Derive bounded browser envelopes from committed events, provisional progress, availability changes, and replacement.
- Add bounded replay, browser heartbeat, upstream heartbeat-silence detection, slow-client overflow, and `resync_required`.
- Abort and rebuild atomically across service replacement, family switch, and last-browser disconnect.
- Ignore every asynchronous completion from an old generation.

### 5. Authenticated observer web API

- Add fragment bootstrap exchange and process-local HttpOnly browser sessions.
- Remove the fragment after successful exchange.
- Enforce exact Host, same-origin browser requests, closed routes, no-store responses, and security headers.
- Add versioned bootstrap, selection, snapshot, detail, and stream envelopes.
- Prove browser code never receives the managed bearer token.

### 6. Minimal web interface

- Render the stable family graph with safe native DOM and SVG construction.
- Add Overview, Inspect, and Events depths.
- Fetch sensitive detail only after deliberate inspection.
- Add node, run, model-attempt, cell, effect, task, mailbox, budget, goal, gate, and artifact-metadata inspectors.
- Add bounded live activity and truthful connection, truncation, incompatibility, and resync state.
- Add shared-selection behavior for multiple tabs.

### 7. Verification and documentation

- Add unit tests for graph derivation, route and byte bounds, mailbox aggregation, generation rejection, event deduplication, progress cleanup, replay overflow, and status rendering.
- Add integration tests for uninitialized workspace, stopped service, stale/conflicting/incompatible service, later initialization, later connection, service replacement, child admission, exact-route mailbox activity, browser attachment accounting, quiescence, and observer shutdown.
- Add adversarial HTTP tests for bootstrap/session auth, token rotation, exact Host, origin and fetch-site rejection, route allowlisting, cache and CSP headers, slow clients, hostile rendered content, and token absence from outputs.
- Add a source-checkout black-box test for ephemeral port, explicit port, bind conflict, signal shutdown, and no managed-service ownership.
- Add a linked-executable black-box test from another repository that loads every static asset without internal IDs or direct supervisor access.
- Add a headless-browser black-box journey covering token exchange, fragment removal, refresh, root selection, graph rendering, child and message live updates, detail inspection, service replacement, and final-browser disconnect.
- Use Playwright Chromium as a test-only development dependency for the deterministic headless-browser journey. The repository has no existing browser tooling, so this is a new test model: the journey lives in its own explicitly invoked script (`test:acceptance:observe-web`), the Chromium version is pinned through the locked Playwright dependency, and setup documentation states the one-time `bunx playwright install chromium` step. The script is opt-in and is not part of `bun run verify` or any required gate, following the repository convention for prerequisite-dependent tests. When invoked without the pinned browser it fails with installation guidance; an unrun journey is reported as unverified, never as passed.
- Keep every non-browser observer requirement — the observer HTTP API, source adapter, projection, bounds, generations, and adversarial HTTP behavior — covered by the deterministic required suites, so the opt-in browser journey verifies rendering and end-to-end interaction rather than correctness that would otherwise go untested.
- Compare canonical history and executor activity before and after observation to prove that observer use creates no event or effect.
- Verify that observer shutdown and final-browser disconnect leave managed sessions unchanged and release every upstream route stream and pending read.
- Update `README.md`, CLI help, `docs/user-guide.md`, `docs/install.md`, `docs/configuration.md`, `docs/operator-guide.md`, `docs/protocol.md`, `docs/capabilities.md`, `docs/architecture.md`, `docs/security.md`, `docs/README.md`, and `AGENTS.md` when the feature ships.

## Acceptance criteria

The first version is complete when:

1. `agencity observe` is recognized as a product command before ordinary product bootstrap.
2. The command prints a usable loopback URL from a source checkout and linked installation.
3. Omitted `--port` binds an ephemeral port; an explicit valid port is honored; malformed values and bind conflicts fail clearly.
4. Starting in a fresh repository creates no `.agencity` directory, workspace marker, database, profile preference, or managed-service child.
5. The browser shows `workspace_uninitialized` until ordinary Agencity initializes the workspace.
6. Starting Agencity later causes the existing observer process to discover and connect without restart.
7. A valid service with non-default execution, sync, console, or idle configuration remains observable without configuration-hash reconstruction.
8. Stale, unauthenticated, incompatible, and non-authoritative services remain distinct and are never used as connected sources.
9. The root selector contains only resumable initial root routes and does not change Agencity's remembered product route.
10. Multiple browser tabs share one explicit process-wide family selection without stale selection races.
11. Existing descendants appear as exact route nodes with durable task edges.
12. A newly admitted child appears without browser refresh.
13. More than 64 reachable routes produces truthful truncation without an invented omitted count.
14. A committed family message produces one attributable message edge lifecycle while each canonical event remains separately visible.
15. Mailbox detail excludes sibling-branch traffic.
16. Runs, model attempts, cells, effects, tasks, goals, gates, budgets, artifact metadata, and terminal outcomes are inspectable through bounded lazy pages.
17. The overview does not receive raw prompts, code, effect payloads, logs, or message bodies before inspection.
18. Retained inspector items show only provenance the projection actually retains; newly observed committed events show exact event IDs and cursors.
19. No browser snapshot, page, queue, replay buffer, or stream envelope exceeds its declared bound without typed truncation or resync.
20. Provisional progress disappears on outcome, disconnect, generation replacement, or resync and is never presented as retained history.
21. Duplicate or older route events do not duplicate durable activity.
22. Managed-service replacement discards the old generation and rebuilds the same committed family state from fresh snapshots.
23. Late work from an old managed instance or family generation cannot change the active projection.
24. Browser refresh succeeds through the process-local HttpOnly session without leaving the bootstrap token in the URL.
25. Browser code never receives the managed-service bearer token or process-local session secret.
26. Hostile Host, cross-site API, invalid session, unknown route, generic proxy, and state-changing observer requests fail closed.
27. Hostile agent or repository strings render only as inert text.
28. One slow browser receives bounded resync behavior rather than causing unbounded memory growth.
29. Closing the final browser aborts every upstream route stream and permits normal managed-service quiescence.
30. Leaving the observer process open without a browser sends no authenticated managed request and does not defer service quiescence.
31. Observer restart reconstructs current committed state after automatic sole-root selection or a new explicit choice, resets the activity rail, and shows a new connection boundary.
32. No observer action appends a canonical event, executes an effect, changes a profile preference, or changes product selection.
33. Ctrl-C or observer process termination stops only the observer and does not stop or cancel Agencity work.
34. No observer web response contains a full `AgentState` serialization.
35. A silently dead upstream stream is detected through heartbeat silence and triggers bounded rediscovery rather than an indefinite `connected` display.
36. The opt-in headless-browser journey verifies the actual web interface; every non-browser observer behavior is covered by the deterministic required suites.

## Deferred work

- full historical replay and cursor scrubbing;
- bounded historical event paging and exact historical cursor lookup for retained projected items;
- branch-fork topology;
- multi-family and multi-workspace views;
- per-tab independent family selection;
- durable indexing, search, analytics, and exports;
- artifact-byte viewing;
- remote observer hosting;
- shared multi-user authorization;
- steering, cancellation, and other privileged controls;
- a protocol-level read-only managed-service credential;
- a versioned bounded managed observation protocol: paged root catalog, bounded route summaries and inspector pages, an exact-route mailbox storage query, and one multiplexed family observation stream with per-route cursors, replacing full-snapshot consumption in the observer process;
- an aggregate recursive-family snapshot that returns descendant state in one managed response;
- observer subscriptions that do not affect managed-service quiescence while a browser is actively attached.

## Later control boundary

Steering and cancellation do not enter the read-only observer source or web API.

A later control phase must add:

- an explicit capability and credential distinct from observation;
- clear action confirmation and exact target identity;
- canonical command receipts and resulting event links;
- stale-target and lost-connection handling;
- exact authorization and family-scope enforcement;
- tests proving that observation credentials and routes cannot invoke controls.

The first version does not render disabled controls that imply unavailable authority.

## Implementation log

### 2026-08-21 — Read-only discovery and stream liveness
- Completed: Added non-creating, owner-validated service-manifest reads; bounded passive polling for the exact workspace marker and service manifest; periodic branch-stream comment heartbeats with cleanup; and optional client comment delivery for liveness detection.
- Validation: `bun test --timeout 30000 test/unit/service-discovery.test.ts test/integration/fu005-fu006-protocol.test.ts test/integration/managed-service.test.ts` passed with 52 tests and 0 failures.
- Plan notes: The heartbeat guarantee advances the managed-service protocol from revision 3 to revision 4. Ordinary revision-4 product clients retain compatibility with revision-2 and revision-3 services, while Observe requires revision 4.
- Remaining: Authenticated health and capability classification, observer source/projection, web server and UI, complete acceptance coverage, documentation, and aggregate verification.

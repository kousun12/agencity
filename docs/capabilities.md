# Current capability matrix

This page distinguishes implemented behavior, behavior that requires external configuration or infrastructure, and behavior the repository does not provide.

Status meanings:

- **Supported**: implemented in the repository and available in the documented local composition.
- **Conditional**: implemented, but usable only with credentials, an external service, an operator-supplied adapter, or explicit opt-in.
- **Unavailable**: no supported implementation or deployment is provided.

“Adapter implemented” means the package contains a client/handler contract and conformance coverage. It does not mean Agencity hosts, provisions, authenticates, or operates the remote endpoint.

## Product and execution

| Capability | Status | Current behavior |
|---|---|---|
| Local terminal product | Supported | `agencity` and `bun run dev` resolve a workspace, create or resume durable work, and enter the same product flow. |
| Full-screen terminal UI | Supported | The OpenTUI client consumes the public snapshot/event protocol and renders committed Markdown plus syntax-aware fenced code and retained TypeScript cells. It interleaves each compact run status after its initiating user task, animates active and queued run markers with braille frames, and groups indented action rows with a dim vertical guide; keeps the latest committed action detailed until the next action opens; exposes expandable full source with the presentation-only `Purpose:` label omitted, stream-colored stdout/stderr, and errors while retaining the exact submitted source canonically; supports latest/all run toggles for active and completed runs; and provides a prompted multiline composer with line-preserving paste and `Shift-Enter`. The responsive layout includes width-prioritized status/action hints, an idle full-width conversation, contextual wide/narrow inspectors, explicit height modes, direct-child browsing, exact parent/child navigation, and a searchable workspace Agents selector for retained root branches. The selector can create and immediately open a new root with Ctrl-N. Native terminal text selection remains available, supported wheel/trackpad input scrolls the active view, family opening and workspace-catalog reads are observational, and historical inspection disables route changes. Exact workspace-root selection and creation update the remembered resume route. Detach/catch-up and a plain non-TTY transcript fallback remain supported. |
| Foreground browser observer | Supported with limits | `agencity observe` serves a loopback-only, authenticated, read-only view of one process-wide selected initial-root family through managed protocol revision 4. It does not initialize state, start or stop the managed service, open LibSQL, recover or wake work, call managed/product mutations, change product selection, or persist observer state. Browser DTOs, family discovery, lazy detail, activity, queues, and replay are bounded; full history, artifact bytes, branch-fork topology, multiple families/workspaces, and per-tab selection are unavailable. Active browser attachments may defer managed-service quiescence; the final disconnect releases all upstream reads. |
| Typed autonomous runs | Supported | Product tasks require exactly one formal `bun_console` or `finish` call. The tools are declaration-only; only a validated and committed console call executes. Supplemental narration is diagnostic-only, and there is no text-JSON or code fallback. Missing information uses blocked `finish`; later user text starts a new run. |
| Durable raw AI generation | Supported | `ai.generateText` and `ai.generateObject` perform exactly one provider generation over explicit prompt/messages and explicit bounded context. They cannot inspect files, call tools, use skills, read ambient branch context, or continue autonomously. They retain exact dispatch, schema, provider input, usage, budget, cancellation, timeout, and recovery provenance without creating agent-family records. Results remain inline; oversized output fails. |
| Typed child-agent invocations | Supported | `sdk.agents.run`/`runMany` await full child autonomy and return retained text or restricted-schema object results. Detached-running `spawn`/`spawnMany` return durable handles; `result` performs lifecycle/result lookup. Awaited capacity is reserved before admission. Schemas constrain shape, not factual correctness, completion, safety, or authority. |
| Exact provider input and admission | Supported | `agencity.provider-input.v2` is the single candidate used by estimation, execution, and recovery. It retains provider-neutral text, assistant tool-call, and tool-result messages; fixed tool schemas and order; selection and parallel-call policy; token-relevant options; cache contract; dispatch/endpoint/capacity provenance; digest; and exact bytes. Unknown capacity remains explicit; a 512 KiB hard ceiling compacts toward 384 KiB or stops before dispatch. |
| Append-only autonomous provider transcript | Supported | Each segment starts with an attributable durable transcript block. Continued steps preserve the prior message list as an exact prefix, then append the native assistant tool call or bounded rejection, its durable result/observation, any changed durable-state delta, and the next-action message. Compaction creates an attributable segment/cache reset; append-only growth then resumes. |
| Bounded automatic observations | Supported | A terminal cell owns successful linked effect presentation, duplicate successful effect payloads are omitted, and failed/cancelled/unknown outcomes remain actionable. The provider view is capped at 56 KiB per item and 64 KiB per step; the complete canonical event-ID ledger is retained. |
| Bounded shell, managed-process, file, artifact, and cell output | Supported | `agencity.bounded-output.v1` distinguishes inline, spilled, truncated, and refused. Shell and managed processes use scrubbed 24 KiB per-stream previews and 32 MiB local spill, file pages are one-based and bounded, artifact ranges are exact and capped at 64 KiB, and cell JSON above 128 KiB uses streamed staging. |
| Durable managed background processes | Supported with limits | `sdk.processes.start/inspect/readLogs/stop/list` returns reconstructable JSON handles and retains queued, running, succeeded, failed, cancelled, or unknown lifecycle under workspace/session/branch/run/cell/effect ownership. Run cancellation and graceful service shutdown own TERM/KILL process-group cleanup; restart authenticates groups with a random retained token rather than PID alone and never retries uncertain commands. This is trusted-local lifecycle management, not sandboxing or resource isolation. |
| Persistent branch REPL | Supported with limits | Each exact session and branch has one persistent Bun TypeScript REPL worker. Top-level bindings, imports, module instances, closures, and object identity persist across cells while it lives. Every worker generation has a random epoch ID and readable name; autonomous provider input and model-attempt history retain cold or exact warm status. A changed pin produces typed `REPL_EPOCH_CHANGED` before source evaluation. Runtime throws retain completed in-memory mutations but not staged state or artifact writes. Imported socket, timer, or event callbacks may outlive the active cell context; console calls from those callbacks become no-ops so they cannot crash the worker or bypass bounded cell logs, while effect-capable SDK bindings remain unavailable. Cancellation, RSS recycling, non-runtime failure, worker/service/process loss, or branch change may discard the namespace. State and artifacts are the only supported recovery persistence; source is never replayed automatically. |
| Repository `AGENTS.md` instructions | Supported | The workspace-root file is loaded into provider input with path, digest, size, and bounded content. Successful typed file reads discover bounded ancestor files in root-to-nearest order and deliver up to four changed records per read. Discoveries are retained in the committing cell, survive restart/branch replay, and are re-recorded only when source state changes. Ancestor, digest, active-context, and per-cell bounds produce explicit pending/omission metadata; oversized, invalid, or symlinked files never become unbounded prompt content. Sealed refinement/governance reviewers exclude repository-authored instructions. |
| Durable per-session agent profiles | Supported | Every new root, delegated child, specification child, and recursive child commits one complete immutable initial profile. Autonomous runs and recursive invocations pin the exact profile and effective-system-prompt provenance; later activation cannot change an admitted invocation. |
| Agent-profile inspection and controls | Supported | Supervisor, HTTP, `AgentClient`, Console SDK, route-relative `agencity profile`, and `/profile` expose active/history/full-prompt inspection, adjacent diffs, proposals/notices, reasons/guidance, bounded reproposal, and exact-revision rollback. |
| Automated behavioral-refinement governance | Supported | Profiles, memories, prompt notes, skills, and subagent specifications use immutable proposals, deterministic validation, one separate sealed current-model reviewer, application-time revalidation, automatic application/rejection, wait/detach terminal delivery, and exact rollback. Profile/non-skill application is atomic; skills activate only after durable compile and declared runtime tests. Approval is policy consistency, not outcome proof. |
| Governance authority and configuration | Supported with limits | Self, direct-child, workspace-owner, and local automatic-refiner authority is enforced. Callers cannot select the reviewer. Product constitution and policy are frozen; workspace-charter and user-constraint configuration is unavailable and pinned as `null`. Every automatic proposal passes deterministic validation and one separate sealed reviewer; skills must also compile and pass declared runtime tests. |
| Default automatic learning | Supported with limits | A device profile with no explicit preference learns automatically. `refine pause` persistently pauses new admissions across that profile's workspaces, and `resume` restarts them; `auto off\|on` remains compatible. Automatic targets remain local memory, prompt notes, tested skills, and subagent specifications. One scan admits at most one trigger. Defaults are 3 matching effect failures, 3 failed cells in one run, 2 distinct-pin gate failures, 1 typed correction, or 5 successful terminal runs in a 2,048-record window, with success refiring after 5 newer qualifying runs. Failed-cell repair includes effect-backed cells and owns their causally linked effect outcomes so the same evidence cannot also produce repeated-effect reflection. The fifth success is considered at the next committed boundary. Success only permits reflection and `no_change` is expected. Status/history/inspect join reflections, governed outcomes, scan failures, and grouped rollback provenance. One proposal-level action atomically reverses automatic create, replace, retire, and multi-edit changes. History is audit activity, not a human review queue. There is no separate learning budget, aggregate rate limit, scheduler, or semantic grouping. Scanning loads full branch history and becomes unavailable when more than 10,000 records are supplied. |
| Installed profile-governance journey | Supported | Isolated `bun link` acceptance covers exact root and child profiles, old/new invocation pins, blocking approval, rejection, bounded reproposal, exact rollback, detached managed-service restart, deduplication, and no-ID profile inspection. Hard process-loss boundaries remain lower-level lifecycle evidence rather than part of this graceful installed restart journey. |
| Durable recovery | Supported | Canonical events, outbox effects, cells, tasks, mailboxes, goals, schedules, raw AI generations, retained internal recursive model handles, profile versions, invocation pins, and effective prompt provenance recover at committed boundaries. Synchronized remote generations remain observational on the receiving device. |
| Unknown-effect reconciliation | Supported | Operators can inspect and append evidence. Unknown status is not rewritten and no retry is authorized automatically. |
| Managed local workspace service | Supported | The product discovers or starts an authenticated loopback service with same-device process fencing, resident run advancement, recovery, schedules, managed-process keep-alive and cleanup, and graceful shutdown after one hour of quiescence by default. Exact milliseconds remain in typed/JSON status. A live REPL namespace and an idle console worker do not keep it alive. |
| Hosted or multi-tenant Agencity service | Unavailable | No hosted control plane, tenant authorization layer, TLS service, or production remote deployment is supplied. |
| Organization control plane | Unavailable | Profiles do not add cross-family assignment, workspace routing, management hierarchy, or automatic cross-device ownership transfer. |
| Demo mode | Unavailable | There is no product demo provider. Echo is an internal deterministic test fixture and is excluded from product selection, onboarding, help, and status. |

## Models and providers

| Capability | Status | Current behavior |
|---|---|---|
| OpenAI | Conditional | Built-in Vercel AI SDK OpenAI Responses API transport with `store: false` and no `previous_response_id`; requires a stored/programmatic key or `OPENAI_API_KEY` and a canonical `openai/...` model ID. Structured autonomous requests use a session/branch-stable deterministic cache key, explicit cache mode, a 30-minute TTL, explicit breakpoints on supported input-text boundaries, fixed required tool schema/order, and disabled parallel calls. The provider may consider up to its 50 most recent breakpoints for reads in a very long segment; prior breakpoints are read-only and only the latest four may write on one request. |
| Anthropic | Conditional | Built-in Vercel AI SDK Anthropic transport; requires a stored/programmatic key or `ANTHROPIC_API_KEY` and a canonical `anthropic/...` model ID. |
| Vercel AI Gateway | Conditional | Built-in Vercel AI SDK Gateway transport; requires a stored/programmatic key or `AI_GATEWAY_API_KEY` and a canonical `creator/model` ID. |
| Configured model catalog | Conditional | The configured Gateway-compatible `/v1/models` catalog is loaded without provider credentials or inference, normalized, and cached by endpoint for capacity, output limits, pricing, reasoning, and display metadata. Refresh returns current rows, a failed refresh may use a visibly stale digest-checked cache, and unavailable or provider-filtered-empty results preserve exact manual canonical-ID entry. The default origin is the public Gateway, but a custom configured origin is not. Catalog presence does not prove credentials, fixed-tool support, provider availability, or successful execution. |
| Reasoning-effort selection | Supported | `--effort`, `/effort`, the product protocol, and `ModelConfiguration` support provider-default, none, minimal, low, medium, high, and xhigh. Explicit unsupported choices fail; unverified catalog choices remain labeled. |
| Custom embedded provider | Conditional | An embedding host can pass `modelProviders` to `Supervisor.open`; the provider must implement the model contract and truthful capabilities. |
| Provider streaming | Conditional | Used only when a provider declares streaming and implements `stream`. Deltas are cursorless temporary progress; the full terminal response remains atomic. |
| Provider/model onboarding | Supported | Without an explicit or valid retained model, interactive startup always shows provider typeahead before model typeahead. OpenAI, Anthropic, and Vercel AI Gateway remain selectable when unauthenticated; rows distinguish stored and environment credentials, and a deterministic authenticated provider is selected by default. Selecting an unauthenticated provider opens hidden credential entry and refreshes status. Model selection then uses fuzzy display-name/canonical-ID search, bounded rows, and explicit exact manual rows. Escape clears any setup prompt and exits without an error. Direct OpenAI and Anthropic enforce matching creator namespaces; Gateway accepts any valid creator. Display names remain presentation while canonical IDs are durable. A newly stored credential may remain after later cancellation, but cancellation writes no model preference or root. |
| Retained model and setup failure boundaries | Supported | Non-Echo resume preserves committed model identity. Retained Echo uses an explicit product-model migration. A malformed retained default warns and reopens selection interactively but fails closed with guidance non-interactively. A confirmed model preference may remain if the later root request fails or becomes unconfirmed after dispatch; `agencity agents` is authoritative for reconciliation. |
| Formal agent-tool transport | Supported | Gateway, direct OpenAI Responses API, and direct Anthropic adapters prove declaration tools, required selection, bounded formal input streaming, runtime cardinality rejection, and direct-transport parallel-call suppression. Autonomous continuation is represented by provider-neutral assistant tool calls and tool results in the next exact candidate; Agencity, not the provider, executes accepted work. |
| Exact-model formal-tool support | Conditional | Exact-model support usually remains `unknown` because configured Gateway-compatible catalogs have no authoritative normalized fields for formal-tool support or strict schema enforcement. Shipped transports can admit an unknown exact model when their primitives are proven; new known-unsupported combinations reject before a model preference, root, branch model change, run, or runnable-child admission. |
| Agent-tool capability states | Supported | `/capabilities`, product setup, model selection, and inspectors report `provider-strict`, `runtime-validated`, `unknown`, or `unavailable`. Credential usability is separate and the capability check makes no provider call. |
| Structured trajectory refinement | Supported | A supervisor-selected durable child must call the sealed `agencity_submit_refinement_review` tool. Its retained response admission and typed message-free result bind recovery to the exact child completion. Recursive-model admission is private to sealed runtime workflows. |
| Real-provider verification in the default suite | Unavailable | The deterministic suite does not prove a live provider. Live verification is an explicit credential-gated test. |

## Local state, sync, and coordination

| Capability | Status | Current behavior |
|---|---|---|
| Local canonical storage | Supported | Local LibSQL event history is canonical. Projections and snapshots are rebuildable; artifact bytes live in a content-addressed store. |
| Offline local writes | Supported | Local execution remains usable without Cloud or while the optional sync endpoint is unavailable. |
| Turso envelope synchronization | Conditional | The pinned Turso Sync adapter exchanges immutable envelopes through a separate replica and exposes directional push, pull, checkpoint, and statistics. It requires an external compatible endpoint. |
| Conflict and quarantine visibility | Supported | Divergent claims, invalid envelopes, dependencies, and explicit conflict resolution remain inspectable. No automatic conflict winner is invented. |
| Artifact replication through sync | Unavailable | Envelope synchronization does not copy referenced artifact bytes. |
| Distributed leases or task stealing | Unavailable | Sync is not a lock service and provides no distributed execution coordination. |
| Automatic cross-device execution-owner failover | Unavailable | Session ownership remains single-device. The product can fence and recover same-device local processes only. |
| PostgreSQL coordination/storage | Unavailable | PostgreSQL is not an implemented storage or coordination prerequisite. |

## Placement

| Capability | Status | Current behavior |
|---|---|---|
| Local relational placement | Supported | `LibSqlStorage` plus `localRelationalState` provide offline writes, analytical SQL, notifications, and same-device process fencing. |
| Remote relational HTTP adapter | Conditional | `HttpRelationalStateStore` and `createRelationalStateRpcHandler` implement a conformance-tested HTTP boundary. The integrator must deploy and secure the server. Remote notifications and same-device fencing are unavailable in this protocol version; migration is operator-enabled. |
| Local content-addressed artifact store | Supported | `LocalArtifactStore` uses stable SHA-256 identity, owner-only staging, and verifies digest and size. Model-facing retrieval is a zero-based half-open range of at most 64 KiB. |
| S3/R2-style remote artifact adapter | Conditional | `S3CompatibleArtifactStore` implements path-style HTTP object operations and bounded range reads, and accepts operator-supplied authorization headers. The integrator supplies the object service. |
| Local FTS5 candidate index | Supported | FTS5 generates deterministic memory candidates; runtime policy remains authoritative. |
| Remote candidate-index HTTP adapter | Conditional | `HttpMemoryCandidateIndex` and its handler are implemented. The integrator supplies the service; rebuild is optional. |
| Embedding-based retrieval | Unavailable | No embedding generator, vector store, or semantic retrieval deployment is provided. |
| Trusted local executors | Supported | File, shell, managed-process, model, and skill execution use typed outbox outcomes under the OS authority of the runtime process. |
| Remote executor transport | Conditional | `RemoteSandboxExecutor` and its handler implement typed HTTP execution semantics. The operator must deploy the handler inside a real sandbox and truthfully advertise policy. Version 1 has no artifact-transfer capability, so remote spilled-artifact output is rejected instead of becoming an unreachable reference. |
| Managed remote sandbox deployment | Unavailable | The repository does not provision a container, microVM, remote host, network policy, resource quotas, or attestation. |
| Automatic remote-to-local fallback | Unavailable | Remote transport failure remains `DEPENDENCY_FAILURE` or executor `unknown`; placement does not change silently. |

## Security and authority

| Capability | Status | Current behavior |
|---|---|---|
| Trusted-local execution | Supported | Generated TypeScript and shell commands have the runtime process's OS authority. |
| Managed loopback bearer authentication | Supported | The managed product service authenticates every loopback route using an owner-only discovery manifest. |
| Observe loopback browser authentication | Supported | A fragment bootstrap token is exchanged once for a process-local `HttpOnly`, `SameSite=Strict`, `/api` cookie. Exact Host, fetch-site, POST Origin, no-CORS, no-store, CSP, and closed-route checks apply. The broad managed bearer remains server-side; browser responses contain bounded observer DTOs rather than full `AgentState` values or artifact bytes. |
| Embedded diagnostic HTTP authentication | Unavailable by default | The diagnostic server is unauthenticated. A custom embedded host can configure a bearer but owns the complete boundary. |
| Hostile-code sandbox | Unavailable | The Bun console worker and skill child processes are crash/protocol boundaries, not security sandboxes. |
| Multi-tenant authorization | Unavailable | Scope filtering governs product behavior and context; it is not protection from hostile local code or shared diagnostic SQL. |
| Network isolation and syscall/resource policy | Unavailable | These must be supplied by an external container, microVM, host, or other sandbox. |
| Dynamic cross-agent callable tools and durable RPC resources | Unavailable | Implemented agents communicate through retained messages, task notices, and artifacts. A future versioned RPC capability must advertise itself explicitly. |
| Credential exposure reduction | Supported | Provider keys remain supervisor-side. Explicit provider, Turso-authentication, and `AGENCITY_*` variables are removed from generated worker/shell/skill environments, and exact supervisor-registered values are rejected or redacted on supported durable paths. Arbitrary names and credential-like string shapes are ordinary data. This is a narrow accidental-leak guard, not secret discovery, DLP, a vault, or a sandbox. |
| Browser execution | Unavailable | The Observe browser interface is a viewing client. It does not add a browser executor, browser-use tool, or model-controlled browser action. |

## Artifacts and data control

| Capability | Status | Current behavior |
|---|---|---|
| Integrity-checked artifact reads/exports | Supported | Local and S3-compatible stores verify content identity and size. Missing or corrupt content is a dependency failure. |
| Automatic artifact garbage collection | Unavailable | Unreferenced CAS bytes can remain after failed staging; no automatic GC is implemented. |
| Owned local session deletion | Conditional | Supported only when the session is independently erasable and retained references permit safe content-addressed artifact removal. |
| Owned local workspace deletion | Conditional | Requires exact confirmation, quiescence, an external receipt directory, and an explicit exclusive artifact-directory ownership assertion. |
| Owned local profile deletion | Conditional | Requires exact confirmation and an external receipt directory; removes profile state and the profile credential file when checks pass. |
| Governance-complete export audit | Supported | `export-audit.json` checks profile pins, proposals, frozen reviews, decisions, notices, restorations, evidence, and artifacts. Missing required provenance makes the export `partial`, not successful. |
| Managed remote workspace deletion | Conditional | Requires an operator-supplied `ManagedReplicaDeletionAdmin` with authenticated administration for every durable managed URL. Data-plane sync credentials are insufficient. |
| Built-in Turso Cloud administrative deletion | Unavailable | The installed Turso data/sync client does not provide the required production administrative control plane. |
| Remote session/profile deletion granularity | Unavailable | Managed remote deletion supports workspace replicas only. |

Deletion is fail-closed. `planned`, `blocked`, or `partial` receipts are not proof of complete erasure.

## Installation and release

| Capability | Status | Current behavior |
|---|---|---|
| Source checkout | Supported | Bun 1.3.13 or newer with `bun install --frozen-lockfile`; `bun run dev` enters the product. |
| Local `bun link` executable | Supported | `bun link` exposes `agencity` from the checkout and is covered by isolated linked-executable acceptance tests. |
| Linked Observe assets | Supported | Checked-in HTML, JavaScript, and CSS resolve relative to the linked source module rather than the caller's current working directory. The isolated linked black-box case loads all initial assets from another repository and passes. |
| Package registry release | Unavailable | The package is private and not published. |
| Standalone binary/download channel | Unavailable | No supported standalone artifact is published or tested. |
| Production-ready product claim | Unavailable | Passing local runtime tests does not establish hosted operations, hostile-code isolation, external integration availability, or production readiness. |

## Verification tiers

Deterministic local tests cover the runtime, protocol, managed product path, and placement contracts. External rows are opt-in and can skip when prerequisites are absent.

| Verification | Status | Command and interpretation |
|---|---|---|
| Deterministic repository checks | Supported | `bun run verify`; reports only the checks actually run. |
| Isolated linked-product acceptance | Supported | `bun run test:acceptance` and `bun run test:acceptance:matrix`. |
| Observe browser journey | Conditional | After `bunx playwright install chromium`, run `bun run test:acceptance:observe-web`. This opt-in Playwright journey is not part of `bun run verify`; missing Chromium fails with setup guidance, and an unrun journey is unverified. The August 21 foreground CLI/browser/server journey passed against a protocol-compatible managed fixture. |
| Real OpenAI Responses-compatible provider smoke | Conditional | `AGENCITY_ACCEPTANCE_REAL_PROVIDER=1 OPENAI_API_KEY=... AGENCITY_ACCEPTANCE_REAL_MODEL=... bun run test:acceptance:external`. A custom `OPENAI_BASE_URL` must implement `/v1/responses`; Chat Completions compatibility alone is insufficient. |
| Official Turso Sync server conformance | Conditional | `TURSO_SYNC_SERVER_BIN=/absolute/path/to/tursodb bun run test:turso-official`. The binary must match the pinned protocol version. |
| Real Turso Cloud smoke | Conditional | `AGENCITY_TURSO_SMOKE=1 TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... bun run test:acceptance:matrix` against a disposable database. |
| Hosted placement/sandbox verification | Unavailable | Loopback placement conformance proves adapter semantics, not a production endpoint or OS sandbox. |

A skipped external test is **unverified**, not passed. Report pass, fail, and skip counts separately.

See [TypeScript integration API](./api.md), [Public client protocol](./protocol.md), [Generated TypeScript console SDK](./console-sdk.md), [Placement adapters](./placement.md), and [Trusted-local security boundary](./security.md).

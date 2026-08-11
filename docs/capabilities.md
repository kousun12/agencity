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
| Full-screen terminal UI | Supported | The OpenTUI client consumes the public snapshot/event protocol and renders committed Markdown plus syntax-aware fenced code and retained TypeScript cells. It interleaves each compact run status after its initiating user task; exposes expandable exact source, stream-colored stdout/stderr, and errors; supports latest/all run toggles; and provides a prompted multiline composer with line-preserving paste and `Shift-Enter`. The responsive layout includes width-prioritized status/action hints, an idle full-width conversation, contextual wide/narrow inspectors, explicit height modes, direct-child browsing, exact parent/child navigation, and a searchable workspace Agents selector for retained root branches. The selector can create and immediately open a new root with Ctrl-N. Native terminal text selection remains available, supported wheel/trackpad input scrolls the active view, family opening and workspace-catalog reads are observational, and historical inspection disables route changes. Exact workspace-root selection and creation update the remembered resume route. Detach/catch-up and a plain non-TTY transcript fallback remain supported. |
| Typed autonomous runs | Supported | Product tasks require exactly one formal `bun_console` or `finish` call. The tools are declaration-only; only a validated and committed console call executes. Supplemental narration is diagnostic-only, and there is no text-JSON or code fallback. Missing information uses blocked `finish`; later user text starts a new run. |
| Exact provider input and admission | Supported | `agencity.provider-input.v1` is the single candidate used by estimation, execution, and recovery. It includes normalized messages, tool schemas/policy, token-relevant options, dispatch/endpoint/capacity provenance, digest, and exact bytes. Unknown capacity remains explicit; a 512 KiB hard ceiling compacts toward 384 KiB or stops before dispatch. |
| Bounded automatic observations | Supported | A terminal cell owns successful linked effect presentation, duplicate successful effect payloads are omitted, and failed/cancelled/unknown outcomes remain actionable. The provider view is capped at 56 KiB per item and 64 KiB per step; the complete canonical event-ID ledger is retained. |
| Bounded shell, file, artifact, and cell output | Supported | `agencity.bounded-output.v1` distinguishes inline, spilled, truncated, and refused. Shell uses 24 KiB per-stream previews and 32 MiB local spill, file pages are one-based and bounded, artifact ranges are exact and capped at 64 KiB, and cell JSON above 128 KiB uses streamed staging. |
| Branch-scoped console scratch | Supported with limits | Cells receive direct exact-session-and-branch `scratch` plus bounded `sdk.scratch.status/clear`. Arbitrary values survive only while the worker scope stays warm. The managed exact-file-local product may restore bounded eligible JSON from a fenced same-device operational cache; diagnostic embedded and remote placements are warm-only. Scratch is not canonical, synchronized, exported, automatic context, gate evidence, or a recovery guarantee. |
| Repository `AGENTS.md` instructions | Supported | The workspace-root file is loaded into provider input with path, digest, size, and bounded content. Successful typed file reads discover bounded ancestor files in root-to-nearest order and deliver up to four changed records per read. Discoveries are retained in the committing cell, survive restart/branch replay, and are re-recorded only when source state changes. Ancestor, digest, active-context, and per-cell bounds produce explicit pending/omission metadata; oversized, invalid, or symlinked files never become unbounded prompt content. Sealed refinement/governance reviewers exclude repository-authored instructions. |
| Durable per-session agent profiles | Supported | Every new root, delegated child, specification child, and recursive child commits one complete immutable initial profile. Autonomous runs and recursive invocations pin the exact profile and effective-system-prompt provenance; later activation cannot change an admitted invocation. |
| Agent-profile inspection and controls | Supported | Supervisor, HTTP, `AgentClient`, Console SDK, route-relative `agencity profile`, and `/profile` expose active/history/full-prompt inspection, adjacent diffs, proposals/notices, reasons/guidance, bounded reproposal, and exact-revision rollback. |
| Automated behavioral-refinement governance | Supported | Profiles, memories, prompt notes, skills, and subagent specifications use immutable proposals, deterministic validation, one separate sealed current-model reviewer, application-time revalidation, automatic application/rejection, wait/detach terminal delivery, and exact rollback. Profile/non-skill application is atomic; skills activate only after durable compile and declared runtime tests. Approval is policy consistency, not outcome proof. |
| Governance authority and configuration | Supported with limits | Self, direct-child, workspace-owner, and local automatic-refiner authority is enforced. Callers cannot select the reviewer. Product constitution and policy are frozen; workspace-charter and user-constraint configuration is unavailable and pinned as `null`. Automatic refinement is off by default, local-only, and implements only repeated effect failure, distinct-pin gate failure, and explicit user-correction triggers. |
| Installed profile-governance journey | Supported | Isolated `bun link` acceptance covers exact root and child profiles, old/new invocation pins, blocking approval, rejection, bounded reproposal, exact rollback, detached managed-service restart, deduplication, and no-ID profile inspection. Hard process-loss boundaries remain lower-level lifecycle evidence rather than part of this graceful installed restart journey. |
| Durable recovery | Supported | Canonical events, outbox effects, cells, tasks, mailboxes, goals, schedules, recursive model handles, profile versions, invocation pins, and effective prompt provenance recover at committed boundaries. |
| Unknown-effect reconciliation | Supported | Operators can inspect and append evidence. Unknown status is not rewritten and no retry is authorized automatically. |
| Managed local workspace service | Supported | The product discovers or starts an authenticated loopback service with same-device process fencing, resident run advancement, recovery, schedules, and graceful shutdown after one hour of quiescence by default. Exact milliseconds remain in typed/JSON status. Warm scratch and an idle console worker do not keep it alive. |
| Hosted or multi-tenant Agencity service | Unavailable | No hosted control plane, tenant authorization layer, TLS service, or production remote deployment is supplied. |
| Organization control plane | Unavailable | Profiles do not add cross-family assignment, workspace routing, management hierarchy, or automatic cross-device ownership transfer. |
| Demo mode | Unavailable | There is no product demo provider. Echo is an internal deterministic test fixture and is excluded from product selection, onboarding, help, and status. |

## Models and providers

| Capability | Status | Current behavior |
|---|---|---|
| OpenAI | Conditional | Built-in Vercel AI SDK OpenAI transport; requires a stored/programmatic key or `OPENAI_API_KEY` and a canonical `openai/...` model ID. |
| Anthropic | Conditional | Built-in Vercel AI SDK Anthropic transport; requires a stored/programmatic key or `ANTHROPIC_API_KEY` and a canonical `anthropic/...` model ID. |
| Vercel AI Gateway | Conditional | Built-in Vercel AI SDK Gateway transport; requires a stored/programmatic key or `AI_GATEWAY_API_KEY` and a canonical `creator/model` ID. |
| Public model catalog | Conditional | The Gateway `/v1/models` catalog is normalized and cached for capacity, output limits, pricing, and reasoning metadata. Offline refresh uses a visibly stale digest-checked cache when available; model execution remains credential-gated. |
| Reasoning-effort selection | Supported | `--effort`, `/effort`, the product protocol, and `ModelConfiguration` support provider-default, none, minimal, low, medium, high, and xhigh. Explicit unsupported choices fail; unverified catalog choices remain labeled. |
| Custom embedded provider | Conditional | An embedding host can pass `modelProviders` to `Supervisor.open`; the provider must implement the model contract and truthful capabilities. |
| Provider streaming | Conditional | Used only when a provider declares streaming and implements `stream`. Deltas are cursorless temporary progress; the full terminal response remains atomic. |
| Provider/model onboarding | Supported | Interactive missing configuration offers OpenAI, Anthropic, or Vercel, hides key input, and asks for the exact model ID. Non-interactive missing configuration fails with setup guidance. |
| Formal agent-tool transport | Supported | Gateway, direct OpenAI, and direct Anthropic adapters prove declaration tools, required selection, bounded formal input streaming, runtime cardinality rejection, and direct-transport parallel-call suppression. They have no execute callbacks, provider execution, or tool-result continuation. |
| Exact-model formal-tool support | Conditional | Exact-model support usually remains `unknown` because the public Gateway catalog has no authoritative normalized fields for formal-tool support or strict schema enforcement. Shipped transports can admit an unknown exact model when their primitives are proven; known unsupported combinations reject before root or runnable-child admission. |
| Agent-tool capability states | Supported | `/capabilities`, product setup, model selection, and inspectors report `provider-strict`, `runtime-validated`, `unknown`, or `unavailable`. Credential usability is separate and the capability check makes no provider call. |
| Structured trajectory refinement | Supported | A supervisor-selected durable child must call the sealed `agencity_submit_refinement_review` tool. Its retained response admission and typed message-free result bind recovery to the exact child completion. Public recursive calls remain text. |
| Real-provider verification in the default suite | Unavailable | The deterministic suite does not prove a live provider. Live verification is an explicit credential-gated test. |

## Local state, sync, and coordination

| Capability | Status | Current behavior |
|---|---|---|
| Local canonical storage | Supported | Local LibSQL event history is canonical. Projections and snapshots are rebuildable; artifact bytes live in a content-addressed store. |
| Local console scratch checkpoint | Supported with limits | The managed exact-file-local product stores bounded same-device exact-branch JSON checkpoints in a private fenced operational table with seven-day expiry, 64-branch, and 16 MiB workspace limits. It is safe to delete and omitted from generated SQL, sync, export, gates, and canonical rebuild. |
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
| Trusted local executors | Supported | File, shell, model, and skill execution use typed outbox outcomes under the OS authority of the runtime process. |
| Remote executor transport | Conditional | `RemoteSandboxExecutor` and its handler implement typed HTTP execution semantics. The operator must deploy the handler inside a real sandbox and truthfully advertise policy. Version 1 has no artifact-transfer capability, so remote spilled-artifact output is rejected instead of becoming an unreachable reference. |
| Managed remote sandbox deployment | Unavailable | The repository does not provision a container, microVM, remote host, network policy, resource quotas, or attestation. |
| Automatic remote-to-local fallback | Unavailable | Remote transport failure remains `DEPENDENCY_FAILURE` or executor `unknown`; placement does not change silently. |

## Security and authority

| Capability | Status | Current behavior |
|---|---|---|
| Trusted-local execution | Supported | Generated TypeScript and shell commands have the runtime process's OS authority. |
| Managed loopback bearer authentication | Supported | The managed product service authenticates every loopback route using an owner-only discovery manifest. |
| Embedded diagnostic HTTP authentication | Unavailable by default | The diagnostic server is unauthenticated. A custom embedded host can configure a bearer but owns the complete boundary. |
| Hostile-code sandbox | Unavailable | The Bun console worker and skill child processes are crash/protocol boundaries, not security sandboxes. |
| Multi-tenant authorization | Unavailable | Scope filtering governs product behavior and context; it is not protection from hostile local code or shared diagnostic SQL. |
| Network isolation and syscall/resource policy | Unavailable | These must be supplied by an external container, microVM, host, or other sandbox. |
| Credential exposure reduction | Supported | Provider keys remain supervisor-side, credential-shaped environment variables are removed from worker/shell environments, and known values are rejected or redacted before durable append. This is defense in depth, not a vault. |
| Browser execution | Unavailable | No browser executor or browser tool is included. |

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
| Package registry release | Unavailable | The package is private and not published. |
| Standalone binary/download channel | Unavailable | No supported standalone artifact is published or tested. |
| Production-ready product claim | Unavailable | Passing local runtime tests does not establish hosted operations, hostile-code isolation, external integration availability, or production readiness. |

## Verification tiers

Deterministic local tests cover the runtime, protocol, managed product path, and placement contracts. External rows are opt-in and can skip when prerequisites are absent.

| Verification | Status | Command and interpretation |
|---|---|---|
| Deterministic repository checks | Supported | `bun run verify`; reports only the checks actually run. |
| Isolated linked-product acceptance | Supported | `bun run test:acceptance` and `bun run test:acceptance:matrix`. |
| Real OpenAI-compatible provider smoke | Conditional | `AGENCITY_ACCEPTANCE_REAL_PROVIDER=1 OPENAI_API_KEY=... AGENCITY_ACCEPTANCE_REAL_MODEL=... bun run test:acceptance:external`. |
| Official Turso Sync server conformance | Conditional | `TURSO_SYNC_SERVER_BIN=/absolute/path/to/tursodb bun run test:turso-official`. The binary must match the pinned protocol version. |
| Real Turso Cloud smoke | Conditional | `AGENCITY_TURSO_SMOKE=1 TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... bun run test:acceptance:matrix` against a disposable database. |
| Hosted placement/sandbox verification | Unavailable | Loopback placement conformance proves adapter semantics, not a production endpoint or OS sandbox. |

A skipped external test is **unverified**, not passed. Report pass, fail, and skip counts separately.

See [TypeScript integration API](./api.md), [Public client protocol](./protocol.md), [Generated TypeScript console SDK](./console-sdk.md), [Placement adapters](./placement.md), and [Trusted-local security boundary](./security.md).

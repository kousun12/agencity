# Trusted-local security boundary

## Supported trust model

The runtime assumes the model-generated program, its workspace, and its operator are trusted to hold the operating-system authority of the Agencity process. The recommended remote deployment places the **entire** runtime inside an independently managed sandbox (container/microVM/host policy) with explicit filesystem, network, resource, and secret controls.

The Bun console worker is a crash/lifecycle boundary only. It is **not** a security sandbox. Generated TypeScript can use ambient Bun/JavaScript capabilities; a shell command can access anything its OS user can access. `workspaceRoot` narrows typed file operations and initial shell cwd but does not confine arbitrary code or a shell command.

Branch-scoped `scratch` is behavioral isolation against accidental supported-API reuse, not a hostile-code boundary. Generated code in the shared trusted-local realm can still use `globalThis`, imported module singletons, ambient files, or deliberate references outside scratch. Scratch never grants file, shell, network, model, budget, publication, or canonical-write authority.

## Explicit non-claims

The current runtime does not provide:

- hostile-code isolation, syscall filtering, a microVM, or network policy;
- network-facing or multi-tenant HTTP authentication/authorization, workspace tenancy, or TLS;
- complete SQL parsing against adversarial language tricks;
- a general credential broker or proof that a credential cannot be found through ambient OS resources;
- resource isolation for CPU, memory, process count, disk, or network;
- remote executor attestation;
- enforcement that generated code uses only the injected SDK.

Do not expose `ProtocolServer` directly to an untrusted network. The product-managed service binds loopback and authenticates requests with a random bearer stored in an owner-only manifest. This protects against accidental cross-process use by other local users when filesystem permissions hold; it is not multi-tenant authorization and does not make generated code hostile-safe. The advanced `agencity debug protocol-serve` command binds loopback but remains unauthenticated; `serve` is only its legacy compatibility alias. Preserve those defaults or add a separately administered authenticated boundary.

## Defense in depth that is implemented

### Formal model responses

`bun_console`, `finish`, and the sealed refinement-review tool are declaration-only response contracts, not sandboxes or provider-hosted executors. Formal input deltas are provisional, private, and non-executable. Agencity executes only a validated `bun_console` action after its canonical commit; the later disposable cell retains the same trusted-local OS authority described above.

Supplemental narration is diagnostic-only. There is no text-JSON or TypeScript fallback. Rejected raw argument bodies are not written to events, logs, artifacts, cursorless progress, or model-contract diagnostics. Those surfaces retain only bounded codes, digests, names, byte counts, and scrubbed summaries.

The built-in product transports validate and scrub normalized output before persistence. A custom provider's complete structured result is scanned across submission input, termination reasons, warnings, supplemental text, violation evidence, and every other retained field for registered brokered secrets or credential-shaped material. A match fails closed before the value is returned or persisted and does not echo the observed credential.

### Raw AI generation

`ai.generateText` and `ai.generateObject` receive only their fixed host instruction, explicit prompt or user/assistant messages, and explicitly selected bounded context. Context values are validated as plain acyclic JSON without invoking getters, and artifact ranges must be valid UTF-8. Known or credential-shaped secrets reject the operation; context is not silently scrubbed into different data. Model output is checked for registered and credential-shaped secrets and the hard inline byte bound inside the model executor before an `EffectOutcomeRecorded` success can persist it.

Generation lookup, result, and cancellation routes require the exact owning session and branch. A guessed generation ID cannot cross that route boundary. This is product scope enforcement inside the trusted-local service, not multi-tenant network authorization. Read-only SQL references retain the shared-database diagnostic boundary described below; generated code already has the same trusted SQL surface.

### Declared output and child agents

Raw object generation and typed child-agent completion accept only the restricted declared-schema profile. Supported Zod and Standard Schema values are converted in the worker, then the supervisor validates and canonicalizes the resulting plain JSON Schema again. Unsupported transforms, refinements, closures, recursion, external references, formats, unsafe patterns, or excessive depth and size fail admission. The caller declares data shape only; it cannot select sealed response contracts, provider tools, tool policy, dispatch, credentials, capabilities, filesystem or network access, publication rights, or runtime authority.

Schema-valid model output is still model-generated data. It is not proof of factual correctness, task completion, safe behavior, or permission to act. A full `sdk.agents.run` child retains the trusted-local tool and operating-system authority already granted to that child session. A raw `ai.generateObject` call has no tools or ambient context, but that narrower input does not make its judgment objective evidence.

Agent-invocation result, contract, lookup, and cancellation routes require the exact parent session and branch that owns the task edge. This is route-scoped product validation, not a multi-tenant authorization boundary. Dynamic cross-agent callable tools are unavailable; implemented agents exchange retained messages and artifacts.

### Generated SQL

The injected `sql` template binds interpolations and accepts only a narrow single-statement read grammar. DDL/DML/transactions, dangerous file/extension functions, mutation-capable pragmas, private operational tables, and SQLite schema/engine tables are rejected. Results are capped at 1,000 rows, statements at 64 KiB, and execution at 2 seconds. A dedicated analytical LibSQL client additionally enables `PRAGMA query_only=ON` and is closed after each query. This protects the intended SDK path from accidental canonical mutation or unbounded reads; it does not turn arbitrary generated TypeScript with OS authority into untrusted code.

Raw SQL is a **trusted diagnostic channel over the shared local database**, not a workspace-confidential model view. It can inspect non-private relational projections across sessions/workspaces, including candidate rows that have not been allocated or exposed. Candidate allocation/exposure guarantees behavioral isolation in materialized context, memory retrieval, and the scope-filtered `sdk.harness.list/history` facades; it is explicitly **not a confidentiality boundary** against raw SQL or other ambient trusted-local process capabilities. Deployments requiring tenant or candidate secrecy must use separate databases/process sandboxes (or remove model SQL) rather than rely on runtime scope filters.

### Credential exposure reduction

- Credential-shaped environment variables are removed from the console worker.
- The shell executor receives an environment with credential-shaped names removed.
- OpenAI, Anthropic, and Vercel AI Gateway providers resolve stored or environment keys in the supervisor.
- Provider execution uses the Vercel AI SDK inside the supervisor; provider keys are not passed to the TypeScript console worker.
- Managed local scratch checkpointing inspects ordinary own descriptors without intentionally invoking getters, `toJSON`, or iterators, rejects registered and credential-shaped secrets, bounds status metadata, and terminates a worker when the checkpoint deadline expires. JavaScript proxies can still run reflective traps, so checkpointing is not a side-effect isolation boundary.
- The private `console_scratch_cache` table is excluded from generated analytical SQL. Cache rows can remain in SQLite free pages, WAL files, raw backups, or recovery media after logical pruning and follow the existing database storage lifecycle.
- Provider tool declarations do not receive credentials and have no execute callback. Provider keys remain supervisor-side for the model request.
- The public Gateway model-catalog request sends no provider credential. Custom provider origins receive execution prompts and authentication and must be treated as trusted network destinations.
- TUI-stored model keys live in a profile-owned `auth.json` written with mode `0600`, separate from canonical events and profile preferences.
- Inputs containing an actual known environment or stored model secret value are rejected before durable append.
- Known secret byte strings are redacted from executor outputs, logs, and errors before they become durable.
- Shell stdout/stderr and oversized JSON string tokens use streaming scrubbing across chunk boundaries before owner-only staging or CAS placement. Raw unsanitized overflow is not intentionally written to events, artifacts, logs, previews, or errors.
- Benign domain fields named `token`, `auth`, `password`, and similar are preserved; key names alone never trigger data mutation.
- Model-visible refinement context and review content are scrubbed of known secret values only. Retained history that merely looks credential-shaped (for example `api_key=...` in a captured error) is not heuristically blocked, so a secret unknown to the supervisor can reach the refinement model through retained trajectory data.

This is best-effort accidental-leak prevention. Names outside the heuristic, short secret values, credentials in other files/agents/keychains, encoded values, or alternate process channels may still be visible to trusted code. Generated code has the same OS-user authority and can read the profile credential file through ambient filesystem APIs. The model credential store is a narrow supervisor broker, not a general secret vault or hostile-code boundary; opaque references remain available for externally managed credentials.

Owner-only artifact staging uses process-specific directories and mode `0700`/`0600` where supported. Startup removes stale staging owned by dead processes. A CAS object can become unreachable if placement succeeds before its canonical registration batch; no general garbage collector currently removes these orphans. This does not expose raw pre-scrubbed content, but operators must include the artifact directory in sensitive-data handling and disk-retention policy.

### Typed file adapter

`FileExecutor` requires paths beneath its root lexically and checks resolved existing ancestors to resist symlink escape. It refuses to overwrite a symlink or delete a directory. Writes use temporary files and rename. These checks apply only to calls through `tools.readFile`/`writeFile`/`request("file", ...)`; they are not a filesystem sandbox for generated code or shell commands.

Typed reads are bounded to one-based pages of at most 2,000 lines, 2 KiB per line, and 48 KiB. Artifact reads exposed to generated cells are zero-based half-open ranges of at most 64 KiB. These limits reduce accidental data amplification; they are not confidentiality boundaries because generated code retains ambient filesystem authority.

### Repository instruction loading

The root `AGENTS.md` and directory files discovered by successful typed reads are sent to the configured model as behavioral guidance. Automatic loading accepts regular UTF-8 files inside the resolved workspace, rejects symlink content, records exact source digests and sizes, scrubs known brokered secret values, and replaces oversized or unavailable content with explicit metadata and bounded recovery guidance. Per-file digest scans stop at 256 KiB, post-redaction content is rechecked against its byte limit, and ancestor/cell omissions remain explicit. This is best-effort leakage reduction, not a confidentiality boundary; repository authors must not put secrets in instruction files.

Repository instructions cannot widen SDK methods, filesystem/network authority, credentials, models, budgets, completion gates, publication rights, or refinement-review authority. Repository fields and dedicated provider messages are removed from trajectory snapshots before sealed refinement, and they are not imported into governance review as workspace-charter or user-constraint policy. Direct Bun or shell reads remain ambient trusted-local access and do not participate in instruction discovery.

### Replica writer trust and cross-device effects

The envelope digest detects corruption; it is not a signature or writer authorization mechanism. A device that can write the shared envelope database is inside the same trusted single-user authority boundary. In particular, a canonical `EffectRequested` authored on one trusted device for a session owned by another is a command to that execution owner: after ingestion, only the owner may materialize and run the outbox row, while every non-owner retains history but must not execute it. Do not grant an untrusted party write access to the envelope database; use a separately authenticated authorization/tenancy layer before treating replica writers as mutually untrusted.

### Durable validation

Event headers/payloads and JSON values are validated before append. Working JSON is finite, plain, acyclic JSON. Immutable-table triggers prevent update/delete even through another database connection. Typed SDK commands, not model-visible SQL, own writes.

### Agent profiles are behavior, not authority

Each runnable session has an immutable initial agent profile containing role, purpose, instructions, and an exact rendered prompt. The profile influences provider-facing behavior only. It cannot select a provider or model, reveal or resolve credentials, widen budgets, add SDK methods, change effect or completion-gate policy, authorize publication, grant filesystem/network access, or alter the runtime's trusted-local OS authority.

Root, child, recursive, and specification-derived profile admission runs through the supervisor. Role, purpose, and instructions are normalized and bounded, and any registered brokered secret value in those fields rejects the entire admission before `SessionCreated` commits. The error does not echo the matched credential. Exact profile text and its digest are retained for provenance, so profile content must never be used as a secret store.

Invocation prompt pins and fixed prompt-component ordering provide attribution and recovery consistency; they are not isolation or authorization controls.

Profile and harness proposals are untrusted data. Deterministic validation checks scope, relationship authority, bounds, known secrets, compatibility, evidence, rendering, and expected-version state before a reviewer call. The separate reviewer receives a sealed profile and response contract plus frozen product constitution, review policy, target, evidence, proposer relationship, runtime boundaries, and current-model dispatch. Proposal text cannot replace those instructions. Workspace-charter and user-constraint configuration is unavailable and pinned as `null`; repository `AGENTS.md` content is not silently imported as reviewer authority. Callers cannot select the reviewer, invoke it directly, edit its proposal, widen authority, or activate content.

Approval is revalidated before application. Profile and non-skill content applies atomically; skills must compile and pass declared tests through the outbox first. Malformed output, rejection, timeout, failure, cancellation, unknown outcome, stale state, or conflict activates nothing. Exact rollback introduces no new content and restores an earlier approved version through a new immutable version. Reviewer approval establishes policy consistency, not empirical improvement or safe code.

### Generated skills

TypeScript skills compile and execute in disposable Bun child processes with credential-shaped environment variables removed and bounded captured output/time. Compile, test, and invocation are durable outbox effects pinned to an immutable version. `Supervisor.open({ skillPermissionAllowlist })` supplies the exact permission-name allowlist (empty by default); validation reports disallowed names and activation plus invocation recheck the configured boundary. Reopening with a narrower allowlist therefore blocks an already-active version from invocation. This is recovery/lifecycle isolation only: skill source retains the OS authority of the trusted-local runtime and may use ambient Bun APIs. Permission declarations are an enforced admission/invocation policy, not an OS capability sandbox, so operators must still sandbox the whole trusted-local runtime.

## Secrets and durable state

Do not intentionally put secrets in prompts, workspace files read into context, artifact content, tool command strings, or user messages. Scrubbing cannot provide erasure guarantees after arbitrary secret transformation. Provider keys belong in the owner-only model credential file, the trusted supervisor environment, or externally managed references—not in model-visible tables.

If a secret is found in retained data, stop the runtime, rotate the secret, determine all database/artifact/log replicas, and apply an ownership-approved deletion/export policy. Data-control manifests enumerate managed local/profile/artifact/replica resources and block unsupported Cloud administrative deletion; operators must complete and verify the physical deletion through the owning Turso administration surface rather than treating a data-client sync call as deletion.

## Operational checklist

1. Run under a dedicated, minimally privileged OS identity or external sandbox.
2. Keep HTTP on `127.0.0.1` unless an authenticated proxy and network policy surround it.
3. Mount only the intended workspace and state/artifact directories in a remote sandbox.
4. Restrict outbound network independently if generated shell/code must not connect freely.
5. Put provider keys only in the owner-only profile credential file, the trusted supervisor environment, or an externally managed secret store; protect the profile directory from other users.
6. Treat shell and dynamic module use as full local code execution.
7. Inspect `unknown` effects before any manual retry.
8. Back up database and referenced artifacts together, and protect both as potentially sensitive trajectory data.

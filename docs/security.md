# Trusted-local security boundary

## Supported trust model

The runtime assumes the model-generated program, its workspace, and its operator are trusted to hold the operating-system authority of the Agencity process. The recommended remote deployment places the **entire** runtime inside an independently managed sandbox (container/microVM/host policy) with explicit filesystem, network, resource, and secret controls.

The Bun console worker is a crash/lifecycle boundary only. It is **not** a security sandbox. Generated TypeScript can use ambient Bun/JavaScript capabilities; a shell command can access anything its OS user can access. `workspaceRoot` narrows typed file operations and initial shell cwd but does not confine arbitrary code or a shell command.

## Explicit non-claims

The current runtime does not provide:

- hostile-code isolation, syscall filtering, a microVM, or network policy;
- authenticated/authorized HTTP, workspace tenancy, or TLS;
- complete SQL parsing against adversarial language tricks;
- a general credential broker or proof that a credential cannot be found through ambient OS resources;
- resource isolation for CPU, memory, process count, disk, or network;
- remote executor attestation;
- enforcement that generated code uses only the injected SDK.

Do not expose `ProtocolServer` directly to an untrusted network. CLI `serve` binds loopback; preserve that default or add a separately administered authenticated boundary.

## Defense in depth that is implemented

### Generated SQL

The injected `sql` template binds interpolations and accepts only a narrow single-statement read grammar. DDL/DML/transactions, dangerous file/extension functions, mutation-capable pragmas, private operational tables, and SQLite schema/engine tables are rejected. Results are capped at 1,000 rows, statements at 64 KiB, and execution at 2 seconds. A dedicated analytical LibSQL client additionally enables `PRAGMA query_only=ON` and is closed after each query. This protects the intended SDK path from accidental canonical mutation or unbounded reads; it does not turn arbitrary generated TypeScript with OS authority into untrusted code.

Raw SQL is a **trusted diagnostic channel over the shared local database**, not a workspace-confidential model view. It can inspect non-private relational projections across sessions/workspaces, including candidate rows that have not been allocated or exposed. Candidate allocation/exposure guarantees behavioral isolation in materialized context, memory retrieval, and the scope-filtered `sdk.harness.list/history` facades; it is explicitly **not a confidentiality boundary** against raw SQL or other ambient trusted-local process capabilities. Deployments requiring tenant or candidate secrecy must use separate databases/process sandboxes (or remove model SQL) rather than rely on Slice 3 scope filters.

### Credential exposure reduction

- Credential-shaped environment variables are removed from the console worker.
- The shell executor receives an environment with credential-shaped names removed.
- The OpenAI-compatible provider resolves its key in the supervisor.
- Inputs containing an actual known environment secret value are rejected before durable append.
- Known secret byte strings are redacted from executor outputs, logs, and errors before they become durable.
- Benign domain fields named `token`, `auth`, `password`, and similar are preserved; key names alone never trigger data mutation.

This is best-effort accidental-leak prevention. Names outside the heuristic, short secret values, credentials in files/agents/keychains, encoded values, or alternate process channels may still be visible to trusted code. Opaque handles are allowed, but a complete credential-broker implementation is deferred.

### Typed file adapter

`FileExecutor` requires paths beneath its root lexically and checks resolved existing ancestors to resist symlink escape. It refuses to overwrite a symlink or delete a directory. Writes use temporary files and rename. These checks apply only to calls through `tools.readFile`/`writeFile`/`request("file", ...)`; they are not a filesystem sandbox for generated code or shell commands.

### Replica writer trust and cross-device effects

The envelope digest detects corruption; it is not a signature or writer authorization mechanism. A device that can write the shared envelope database is inside the same trusted single-user authority boundary. In particular, a canonical `EffectRequested` authored on one trusted device for a session owned by another is a command to that execution owner: after ingestion, only the owner may materialize and run the outbox row, while every non-owner retains history but must not execute it. Do not grant an untrusted party write access to the envelope database; use a separately authenticated authorization/tenancy layer before treating replica writers as mutually untrusted.

### Durable validation

Event headers/payloads and JSON values are validated before append. Working JSON is finite, plain, acyclic JSON. Immutable-table triggers prevent update/delete even through another database connection. Typed SDK commands, not model-visible SQL, own writes.

## Secrets and durable state

Do not intentionally put secrets in prompts, workspace files read into context, artifact content, tool command strings, or user messages. Scrubbing cannot provide erasure guarantees after arbitrary secret transformation. Provider configuration should contain references/closures resolved by trusted supervisor code rather than key strings in model-visible tables.

If a secret is found in retained data, stop the runtime, rotate the secret, determine all database/artifact/log replicas, and apply an ownership-approved deletion/export policy. Slice 4 manifests enumerate managed local/profile/artifact/replica resources and block unsupported Cloud administrative deletion; operators must complete and verify the physical deletion through the owning Turso administration surface rather than treating a data-client sync call as deletion.

## Operational checklist

1. Run under a dedicated, minimally privileged OS identity or external sandbox.
2. Keep HTTP on `127.0.0.1` unless an authenticated proxy and network policy surround it.
3. Mount only the intended workspace and state/artifact directories in a remote sandbox.
4. Restrict outbound network independently if generated shell/code must not connect freely.
5. Put provider keys only in the trusted supervisor environment; avoid credential files in readable mounts.
6. Treat shell and dynamic module use as full local code execution.
7. Inspect `unknown` effects before any manual retry.
8. Back up database and referenced artifacts together, and protect both as potentially sensitive trajectory data.


### Generated skills

Slice 3 TypeScript skills compile and execute in disposable Bun child processes with credential-shaped environment variables removed and bounded captured output/time. Compile, test, and invocation are durable outbox effects pinned to an immutable version. `Supervisor.open({ skillPermissionAllowlist })` supplies the exact permission-name allowlist (empty by default); validation reports disallowed names and activation plus invocation recheck the configured boundary. Reopening with a narrower allowlist therefore blocks an already-active version from invocation. This is recovery/lifecycle isolation only: skill source retains the OS authority of the trusted-local runtime and may use ambient Bun APIs. Permission declarations are an enforced admission/invocation policy, not an OS capability sandbox, so operators must still sandbox the whole trusted-local runtime.

# First-run provider and model typeahead plan

**Status:** Completed
**Date:** August 10, 2026
**Last updated:** August 11, 2026
**Verification:** Deterministic aggregate and installed acceptance matrix passed; external integrations remain gated and unverified
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)
**Related plans:** [Reasoning effort and model capabilities](./2026-08-07-reasoning-effort-and-model-capabilities-plan.md), [Rich terminal rendering and layout](./2026-08-07-rich-terminal-rendering-and-layout-plan.md), and [Formal model tool contracts](./2026-08-07-formal-model-tool-contracts-plan.md)

## Summary

Agencity requires an explicit provider and canonical model before it creates a root session. Interactive setup uses a session-independent inline typeahead. The provider picker searches visible provider names. The model picker loads the configured Gateway-compatible catalog endpoint, searches display names and canonical IDs with deterministic fuzzy ranking, and selects with Up/Down and Enter. Exact canonical model entry remains available when a model is absent from the catalog or catalog retrieval is unavailable.

One pure fuzzy-selection model serves first-run setup and the branch-attached `/model` inspector. Each surface remains responsible for projecting the providers it is allowed to show. Product-transport model validation, safe bounded terminal presentation, and pre-admission rejection of models already known not to support the fixed agent tool contract are implemented without adding a provider list, model list, protocol endpoint, canonical event, table, or placeholder session.

## Implementation status

Implementation and required deterministic verification were completed on August 11, 2026.

- Added shared bounded provider/model ranking, creator filtering, stable selection reconciliation, safe presentation, and explicit manual canonical rows.
- Added the pre-session provider, hidden-credential, catalog-loading, and model-selection TTY flow.
- Converged `/model` on the same matching, filtering, and manual-selection semantics while preserving its branch-attached controls.
- Added product-model grammar enforcement, malformed retained-default handling, known-unsupported admission rejection, and explicit credential/model/root partial-outcome behavior.
- Added deterministic unit, integration, fixture, OpenTUI, and linked pseudo-terminal coverage and updated public documentation.

`bun run verify` passed for this revision: typecheck and architecture passed, the deterministic core reported 1,077 passes and 2 credential-gated Turso skips, linked end-to-end coverage reported 6 passes, and installed acceptance reported 22 passes with the real-provider smoke skipped. `bun run test:acceptance:matrix` also passed its deterministic installed row and skipped the separately gated real-provider, official Turso Sync, and Turso Cloud rows. The skipped external rows remain unverified.

## Architectural decision

First-run selection uses a small inline terminal picker owned by the existing product prompting layer. It runs before the full-screen terminal client and returns a provider or canonical model ID to the existing `chooseManagedModel` policy.

The picker has two layers:

1. **Pure selection model:** provider-to-model filtering, normalized search keys, fuzzy scores, deterministic ordering, selected-row reconciliation, visible-window calculation, and explicit manual-model rows.
2. **TTY driver:** raw key input, bounded query editing, Up/Down/Enter/Escape handling, inline rendering, and terminal restoration on every supported completion, error, cancellation, and catchable-signal path.

The pure layer is shared with the full-screen `/model` inspector. Rendering remains specific to each surface: first-run setup is an inline prompt, while `/model` remains an OpenTUI inspector attached to an existing branch.

This boundary preserves the durable lifecycle. The final selected model is normalized before `SessionCreated`; no temporary session, internal Echo session, or follow-up `SessionModelChanged` is required to initialize the product.

## Goals

- Let a user choose a provider with printable search, Up/Down navigation, and Enter.
- Let a user find a model by its human-readable catalog name without knowing its canonical ID.
- Search model display names and canonical `creator/model` IDs with predictable fuzzy matching.
- Persist the selected descriptor's canonical ID rather than its display name.
- Preserve exact manual canonical-ID entry for unavailable, stale, incomplete, or custom catalogs.
- Make a valid unmatched manual canonical ID the default selection even when fuzzy catalog matches exist.
- Keep direct OpenAI and Anthropic choices within their matching creator namespace while allowing Vercel AI Gateway to show every catalog language model.
- Share matching, provider-to-model filtering, ordering, and selection reconciliation between first-run setup and `/model`.
- Keep first-run and branch-inspector provider visibility policies explicit and separate.
- Reject new product-model selections that are already known not to support Agencity's fixed `bun_console` and `finish` contract before a new preference write, root, or model-change event is committed.
- Render configured-catalog text through a single-line, control-safe, width-bounded terminal projection.
- Keep provider credentials hidden, supervisor-side, and absent from terminal output, profile preferences, workspace history, artifacts, and catalog records.
- Create no session until provider credentials and model selection have completed successfully.
- Preserve explicit options, retained workspace defaults, environment configuration, reasoning-effort resolution, non-interactive failure, non-Echo resumed-branch model identity, and the existing explicit migration of retained internal Echo branches.
- Cover the installed product path through a real pseudo-terminal.

## Non-goals

- Automatically choosing a provider, model, or reasoning level on the user's behalf.
- Changing provider or model precedence for cases that already resolve without an interactive prompt.
- Replacing canonical `creator/model` identity with display names or provider-native IDs.
- Requiring a selected model to appear in the configured Gateway catalog.
- Adding a hand-maintained model allowlist, recommendation list, popularity ranking, or recency ranking.
- Adding model aliases, typo correction that changes the submitted ID, or silent nearest-model selection.
- Changing provider credentials, credential precedence, endpoint overrides, or credential storage.
- Changing formal tool schemas, reasoning semantics, model execution, or the policy that unknown capability remains admissible while known unsupported capability is rejected.
- Changing an existing non-Echo branch's model during resume or removing the existing explicit Echo-branch migration.
- Applying Gateway `creator/model` syntax as a universal invariant to Echo, embedded custom providers, or retained committed branches.
- Adding protocol routes, canonical events, mutable tables, migrations, synchronization fields, or artifact data.
- Turning first-run setup into a session-bearing full-screen terminal client.
- Generalizing every terminal search surface onto one universal picker framework.

## Terms

- **Provider:** The durable model transport selected for a session. Product transports are `vercel`, `openai`, and `anthropic`; internal deterministic providers are excluded from product setup.
- **Canonical model ID:** The configured Gateway catalog contract's `creator/model` identifier retained in `ModelConfiguration.model`.
- **Display name:** Human-readable catalog metadata such as `GPT 5.6 Sol`. It is presentation only and is never persisted as model identity.
- **Catalog result:** A normalized `ModelDescriptor` returned by the existing `/model-catalog` protocol surface for the configured Gateway catalog endpoint. The endpoint may be the public Gateway or an explicit compatible origin.
- **Manual model row:** An explicit selectable row that submits a syntactically valid canonical ID typed by the user even when no catalog descriptor has that exact ID.
- **Fuzzy match:** A deterministic case-insensitive match across normalized display-name and canonical-ID fields. Fuzzy matching affects presentation order only; it never rewrites a model ID.
- **Inline picker:** A bounded pre-session TTY interaction that redraws its own prompt rows without starting the branch-attached OpenTUI application.
- **Echo migration:** The existing pre-release compatibility path that replaces a retained internal Echo branch's model when a command requires a usable product model. This is an explicit mutation of an existing branch, not first-session initialization.

## Pre-implementation baseline

This section records the behavior that the implementation replaced. It is historical context, not the current product contract.

### Product startup

The ordinary product path is:

1. `runProduct` in `src/cli.ts` resolves the workspace and connects to the managed workspace service.
2. New work calls `chooseManagedModel`.
3. `chooseManagedModel` resolves an explicit model, a usable retained workspace default, a provider model environment variable, or interactive setup.
4. Interactive setup calls `chooseManagedProvider`, `ProductPrompter.secret`, and `ProductPrompter.question`.
5. The selected model is stored as the workspace default through `productSetModel`.
6. `finish` applies explicit or retained model-specific reasoning effort.
7. `createSession` normalizes the complete model configuration and commits the initial model in `SessionCreated`.

The interactive provider prompt accepted a number or provider ID. The model prompt accepted an unstructured line. Product-transport normalization required a slash, no whitespace, and the matching direct-provider namespace; it did not enforce the catalog's complete canonical grammar or the 512-byte retained-dispatch bound before every preference or root write.

`ProductPrompter.secret` already closes readline, enters raw mode, bounds the input, restores the previous raw/paused state, and never echoes the credential. Its data listener is removed on recognized Enter or cancellation input rather than unconditionally in `finally`; the new shared driver must harden listener cleanup for aborts, stream errors, and every exceptional exit.

### Former `/model` picker

Before this implementation, the branch-attached terminal provided:

- provider navigation and login/logout in `src/tui/opentui.ts`;
- catalog loading through `TerminalUI.#showModelDetail` in `src/tui/index.ts`;
- catalog display names, canonical IDs, context metadata, reasoning state, stale labels, and model-tool state;
- Up/Down wrapping and Enter selection;
- an exact catalog-ID preference when the query exactly matches a returned descriptor.

Its catalog filter was a case-insensitive substring test in `catalogModelsForProvider`. It did not implement fuzzy ranking. The selected index was not reconciled when a query changed, and the renderer always showed the first eight results even when navigation moved selection beyond that window. A typed unlisted ID was used only when no catalog result remained; when substring matches remained, Enter selected a catalog row instead of the typed ID. Catalog request failures were collapsed to an empty descriptor list by `TerminalUI.#showModelDetail`, so the inspector could not distinguish an unavailable catalog from a valid empty result.

### Catalog and protocol

`ModelCatalog` in `src/runtime/model-catalog.ts`:

- fetches `/v1/models` from the configured Gateway catalog origin without provider authentication;
- retains language models only;
- normalizes display name, canonical ID, context/output limits, pricing, reasoning metadata, required-tool metadata, endpoint identity, digest, and stale state;
- bounds the response to 8 MiB and 10,000 models;
- caches normalized descriptors in a digest-checked endpoint-specific profile record;
- reports `refreshed`, `cached-fallback`, or `unavailable`;
- uses a 24-hour freshness window by default.

`GET /model-catalog` calls `ensureFresh`, and `AgentClient.modelCatalog()` exposes the result. This is sufficient for first-run discovery. A rejected client request is not itself a catalog result and currently requires a UI-side mapping before it can be shown as unavailable. No new server capability is required.

Provider-to-model filtering is already defined by execution:

- `vercel` accepts every canonical creator namespace;
- direct `openai` accepts only `openai/...`;
- direct `anthropic` accepts only `anthropic/...`.

The same rule appears independently in the model inspector and detail model. This plan consolidates it into the shared selection model.

## Product interaction contract

### Existing resolution precedence

Interactive selectors run only when the existing new-session resolver reaches a user choice.

The following behavior remains unchanged:

1. `--model PROVIDER:MODEL` resolves the requested model and prompts only for a missing supported provider credential.
2. A usable workspace-scoped default resolves without a picker.
3. Existing provider model environment-variable resolution runs before a picker.
4. Non-interactive startup without a usable model fails with setup guidance and creates no session.
5. A sole usable provider may be selected without presenting a redundant provider picker.
6. Existing non-Echo branches retain their committed model and effort.
7. A retained Echo branch used for ordinary product work runs the existing explicit migration: `chooseManagedModel` resolves a product model and `selectModel` commits it to that branch before resume.

This work does not redefine the current provider-descriptor ordering used while resolving model environment variables.

The same interactive provider/model picker is used when the Echo migration reaches a user choice. That path does not create a new root or rewrite `SessionCreated`; it commits the existing explicit `SessionModelChanged` through `selectModel`. Tests and user-facing wording must distinguish this compatibility path from first-run initialization.

New product selections use the same pre-admission rule on every resolution path: explicit flag, valid retained default, environment model, first-run picker, Echo migration, and `/model`. A model whose fixed-tool capability is known unsupported is rejected before any new workspace model preference, `SessionCreated`, or `SessionModelChanged` write. An already retained default remains available for diagnostics but cannot admit a new root while known unsupported. Unknown capability remains admissible under the existing policy. Retained non-Echo branches are not reselected or rewritten merely because their committed model predates the stricter product-selection grammar.

### Provider picker

When setup requires a provider choice, render:

```text
Choose a provider
›

  Vercel AI Gateway    vercel
  OpenAI               openai
  Anthropic            anthropic

Type to filter · ↑/↓ select · Enter continue · Esc cancel
```

The exact empty-query order follows the visible provider descriptors supplied by the caller. Echo is removed before options reach either picker. Visibility remains surface-specific:

- first run with no usable provider supplies the supported credential-managed product transports;
- first run with several usable providers supplies only those usable providers;
- `/model` supplies every non-Echo provider it already exposes, including embedded or programmatic providers.

The shared selection model ranks the options it receives; it does not broaden or narrow a surface's provider set.

Interaction:

- Printable text appends to the query.
- Backspace removes one Unicode character.
- Up and Down wrap through visible options, matching the existing `/model` behavior.
- Enter returns the highlighted provider.
- Escape, Ctrl-C, or Ctrl-D cancels setup with a bounded user-facing error.
- A query change selects the first newly ranked option.
- Empty results keep the query editable and disable Enter.

Search covers provider `displayName` and stable provider `name`. Provider search does not inspect credentials, remediation text, or internal capability diagnostics.

When no provider is usable, the picker shows supported credential-managed product transports. After selection, the existing hidden key prompt stores the key through `productSetProviderKey` and refreshes provider status. When several providers are already usable, the picker contains those usable providers and does not request a new key.

### Credential entry

Credential entry preserves the existing behavior:

- input is hidden;
- Escape, Ctrl-C, and Ctrl-D cancel;
- the value is bounded;
- the value goes directly to `/product/config/provider-key`;
- the managed service writes only the owner-only local credential file;
- the provider is re-read after storage and must report usable before model selection continues.

Saving a credential before model selection finishes retains the existing semantics. Cancelling the later model picker creates no session and writes no model preference, but it does not remove a credential the user already submitted.

### Catalog loading

After a provider is resolved and has a usable credential, the model stage calls `AgentClient.modelCatalog()` once and renders a bounded loading state while the request is pending. The TTY driver owns input during that state. Escape, Ctrl-C, or Ctrl-D cancels the selection; other buffered input is discarded rather than replayed into the model query. Cancellation races the catalog request and ignores any late result. The existing service-side timeout remains authoritative even when the client can no longer use the response.

Result handling:

- `refreshed`: show catalog rows normally;
- `cached-fallback`: retain selectable rows and show a stale-catalog warning with the bounded error summary;
- `unavailable`: show a truthful unavailable message and keep manual canonical-ID entry available;
- empty provider-filtered catalog: explain that no catalog rows are available for the provider and keep manual entry available.

A rejected transport, protocol, or capability request maps to a local UI-facing `unavailable` result with a bounded, credential-scrubbed error and no invented origin. Catalog failure never causes provider or model substitution.

### Model picker

Render a searchable list containing the model display name and canonical ID:

```text
Choose an OpenAI model
› gpt sol

  GPT 5.6 Sol
  openai/gpt-5.6-sol · 400k context · effort

  GPT 5.6 Sol Mini
  openai/gpt-5.6-sol-mini · 200k context · effort

Type to filter · ↑/↓ select · Enter use model · Esc cancel
```

Required row content:

- display name;
- canonical `creator/model` ID;
- stale marker when applicable.

When terminal width permits, the secondary line also includes bounded existing metadata such as context size and reasoning capability. Existing model-tool capability labels may remain informational; they do not replace final model admission.

All catalog-originated labels pass through a presentation-only terminal sanitizer before rendering. It removes or visibly escapes line breaks, C0/C1 controls, DEL, ANSI escapes, and bidirectional-formatting controls, then truncates by terminal display cells. Missing or unusable terminal-width metadata uses a conservative 80-column fallback. Every emitted picker line fits its computed width so redraw accounting does not depend on uncontrolled wrapping. Sanitization never changes the selected canonical ID; invalid canonical IDs are rejected during catalog normalization rather than repaired for selection.

Interaction:

- Printable text and paste update the query.
- Backspace edits the query.
- Up and Down wrap through the complete ranked result set.
- The renderer shows a bounded window of at most eight rows that always contains the highlighted row.
- Enter selects the highlighted catalog descriptor and returns its canonical ID.
- A query change selects the exact manual row when the query is a valid unmatched canonical ID; otherwise it selects the first ranked catalog result.
- Escape, Ctrl-C, or Ctrl-D cancels setup.

Catalog names are presentation data. The selected configuration always uses:

```ts
{
  provider: selectedProvider.name,
  model: selectedOption.model,
  reasoningEffort: "provider-default",
}
```

The existing `finish` step remains responsible for explicit and retained reasoning-effort resolution.

### Manual canonical model entry

Manual entry is represented as an explicit row rather than an accidental zero-match fallback.

When the query is a valid bounded canonical ID and no catalog descriptor has that exact ID, include:

```text
  Use exact model ID
  openai/gpt-private-preview · not listed in catalog
```

Rules:

- canonical shape matches the catalog identity rule: an ASCII alphanumeric creator first character, followed by zero or more ASCII letters, digits, `.`, `_`, or `-`, then `/`, then a suffix whose first character is neither whitespace nor `/`;
- the suffix contains no whitespace, C0/C1 control, DEL, ANSI escape, or bidirectional-formatting character;
- the complete ID is at most 512 UTF-8 bytes, matching retained model-dispatch identity bounds;
- direct OpenAI enables the row only for `openai/...`;
- direct Anthropic enables the row only for `anthropic/...`;
- Vercel enables any valid `creator/model`;
- an exact catalog ID selects the catalog row rather than duplicating it;
- fuzzy text that is not a valid canonical ID never becomes a manual model implicitly;
- a valid unmatched manual row uses a distinct stable identity such as `manual:<exact-query>`, appears before fuzzy suggestions, and becomes selected immediately after that query edit;
- Up or Down may move from the selected manual row to a catalog suggestion before confirmation;
- the existing supervisor normalization remains the final authority.

When the catalog is unavailable, this row becomes the only selectable model option after the user types a valid canonical ID.

### Completion and cancellation

After Enter confirms a model:

1. normalize the product model and apply existing model-specific effort resolution;
2. reject known-unsupported fixed-tool capability;
3. call `productSetModel` with the validated `provider:creator/model`;
4. create the root session with the normalized complete model;
5. remember the route;
6. close prompt input ownership;
7. start the ordinary full-screen terminal client.

Cancellation before model confirmation:

- creates no session;
- writes no workspace model preference;
- restores terminal raw mode, pause state, cursor visibility, and input listeners;
- leaves a successfully stored provider credential in place;
- returns a bounded cancellation error without a stack trace in ordinary product output.

## Fuzzy matching contract

### Normalization

Search normalization is pure and locale-independent:

- Unicode lowercase;
- trim leading and trailing whitespace;
- treat whitespace, `/`, `.`, `_`, and `-` as token boundaries;
- collapse repeated boundaries;
- retain both a compact form and token list.
- limit each searchable display-name projection to 512 Unicode code points and 2 KiB UTF-8 after control-safe normalization; canonical IDs retain their complete validated value up to 512 UTF-8 bytes.

The candidate search fields are:

- provider: display name and stable name;
- model: display name and canonical ID.

Model descriptions, prices, capability explanations, and remediation text do not influence ranking.

### Match tiers

Candidates rank by the best matching field:

1. case-insensitive exact stable identity: canonical model ID or provider name;
2. exact normalized display-name match;
3. normalized field prefix;
4. token-prefix match in query-token order;
5. contiguous compact-form substring;
6. ordered character subsequence.

Within a tier, prefer:

1. fewer unmatched characters;
2. earlier first match;
3. display-name match over canonical-ID match only when all score components are otherwise equal outside the exact-stable-identity tier;
4. normalized display name;
5. canonical ID or provider stable name.

String tie-breaking uses Unicode code-point order, not host-locale `localeCompare`. The score must be deterministic and must not depend on original catalog response order. An empty model query sorts by normalized display name and then canonical ID with the same comparator. An empty provider query preserves the caller-projected provider order.

No fuzzy score changes the selected ID. Enter always returns the exact option identity.

### Bounds

- Provider query: at most 128 Unicode characters.
- Model search query: at most 512 Unicode characters.
- Manual canonical ID: at most 512 UTF-8 bytes.
- Candidate count: the catalog's existing 10,000-model bound.
- Rendered rows: at most eight model rows and all caller-supplied provider rows.
- Searchable display-name field: at most 512 Unicode code points and 2 KiB UTF-8 after normalization.
- Matching: one bounded linear scan over each precomputed candidate field for each query update; ordered-subsequence matching must not backtrack or allocate a candidate-by-query matrix.

The implementation adds no fuzzy-search dependency.

Add one shared product-catalog-model validator for picker eligibility, configured-catalog normalization, and product-transport normalization. Its base shape is `^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s/][^\s]*$`, followed by explicit control and bidirectional-formatting rejection and the 512-byte UTF-8 bound. The explicit upper- and lowercase ranges avoid locale or Unicode case-folding changes to identity validation. Product-level selection adds direct-provider namespace rules.

This validator is not a universal `ModelConfiguration` invariant. Echo and embedded custom providers retain provider-specific model normalization, and retained committed branches are not rejected during projection solely because their model predates this boundary. New OpenAI, Anthropic, and Vercel preferences, roots, and branch model changes must pass it. Private and newly released models remain supported without catalog membership when they satisfy the product grammar.

If a retained workspace default does not pass new product selection validation, interactive startup emits a bounded warning, leaves the retained preference unchanged for diagnostics, and continues to provider/model selection. Non-interactive startup fails with the invalid-default diagnostic and ordinary setup guidance. A later confirmed model replaces the invalid default through the normal preference write.

## Component design

### Shared selection model

Add a focused pure module under `src/product/` or `src/tui/` with no terminal, client, storage, or network access. It owns:

- stable option projection for the surface-supplied provider set;
- `providerAcceptsCanonicalModel(provider, model)`;
- catalog filtering by provider;
- normalized searchable fields;
- deterministic fuzzy scoring and ordering;
- explicit manual-model row construction;
- selected-identity reconciliation after query changes and data refresh;
- bounded visible-window calculation.

The API uses stable option identities rather than array indices. Renderers may derive a display index, but query changes and catalog refreshes reconcile through identity. Query edits deliberately reset selection to the valid unmatched manual row or first ranked catalog row. A data-only refresh preserves the selected identity when it remains present and otherwise applies the same default-selection rule.

Provider-to-model namespace filtering is product semantics and must not remain duplicated in `opentui.ts` and `detail-model.ts`. Provider visibility is caller policy because setup and the branch inspector expose different provider universes.

### Inline TTY driver

Move or extend `ProductPrompter` into a focused terminal module so `src/cli.ts` retains orchestration rather than key parsing and ANSI redraw logic.

The driver:

- accepts input/output streams for tests;
- closes readline before entering raw selection;
- has one active input listener;
- preserves prior raw and paused state;
- owns a cancellable catalog-loading state and discards non-cancellation input received before model options are ready;
- hides the cursor only while drawing and restores visibility after each draw and on exit;
- sanitizes untrusted text, clips every line to the current terminal cell width, and redraws a fixed, tracked number of physical rows;
- uses an 80-column fallback when output width is absent or invalid and handles resize before the next draw;
- handles split escape sequences and multi-character input chunks;
- decodes UTF-8 incrementally so a code point split across input chunks is not replaced or counted twice;
- treats ordinary CR/LF as confirmation and strips bracketed-paste framing when a terminal sends it, without allowing pasted line endings to submit more than one value;
- bounds all retained query and error text;
- restores input state and cursor visibility in `finally`;
- installs temporary handlers only for catchable setup-phase signals it explicitly supports, performs idempotent cleanup, removes those handlers, and preserves conventional signal termination; SIGKILL and equivalent uncatchable termination are outside the restoration guarantee;
- exposes separate `selectProvider` and `selectModel` operations over the shared selection model;
- keeps `secret` on the same exclusive input-ownership discipline.

The driver does not know how to persist credentials, defaults, or sessions.

### CLI orchestration

`chooseManagedModel` remains the policy owner for:

- explicit model input;
- retained workspace defaults;
- environment model resolution;
- interactive/non-interactive branching;
- credential persistence and provider re-read;
- model-default persistence;
- reasoning-effort resolution.

Replace `chooseManagedProvider` and the final `ProductPrompter.question("Model ID ...")` call with the typed picker methods. Do not route ordinary first-run setup through the older direct-supervisor `chooseNewModel` helper.

The retained Echo migration continues to call the same resolver and then `selectModel` on its existing route. New-root creation and Echo migration share discovery and validation but retain different durable terminal actions.

Before any newly resolved product model is persisted or committed:

1. validate and normalize the product transport and canonical model ID;
2. resolve and validate the complete reasoning-effort configuration;
3. evaluate the existing fixed-agent-tool capability;
4. reject a known-unsupported selection with bounded remediation while allowing existing unknown-capability policy;
5. persist the user-confirmed workspace default;
6. create the new root, or commit the explicit Echo migration/model change.

The authoritative admission check also runs at the supervisor root/model-change boundary so direct protocol or embedded callers cannot bypass it. The CLI-side check exists for early feedback, not as the sole invariant.

Confirmation authorizes the workspace-default write. If the later session request fails after that write, the valid confirmed default remains. A definite pre-commit rejection reports that no root was created; transport loss after request dispatch reports that root creation is unconfirmed rather than inventing failure or success. The next session listing remains authoritative for reconciliation. No session is created and no new preference is written when validation, effort resolution, or known-unsupported admission fails. Credential persistence retains the separate semantics described above. Tests cover each boundary instead of implying a cross-store transaction that does not exist.

### `/model` convergence

Update the existing OpenTUI model inspector to consume the shared selection model:

- use fuzzy ranking instead of substring filtering;
- replace numeric selection with explicit `{ query, selectedIdentity }` entry state;
- route typing, bounded single-line paste, Backspace, and navigation into that entry state rather than the ordinary multiline draft;
- reconcile selection under the query-edit and data-refresh rules above;
- render the visible window containing the selected row;
- expose the same explicit manual-model row;
- preserve provider navigation, login/logout, model mutation boundaries, and command forms;
- preserve the ordinary composer draft across entry and Escape-back-to-provider navigation;
- carry catalog `status`, bounded credential-scrubbed `error`, and origin into `TerminalModelDetail` instead of collapsing failures to an empty list;
- map rejected catalog requests to a truthful local unavailable result.

This gives setup and later model changes one discovery contract without sharing session-dependent rendering code.

### Protocol and durable state

No protocol change is required. The implementation reuses:

- `GET /model-providers`;
- `GET /model-catalog`;
- `GET /capabilities?provider=...&model=...`;
- `POST /product/config/provider-key`;
- `POST /product/config/model`;
- `POST /sessions`.

No canonical or profile schema change is required. Catalog cache and credential storage retain their existing classifications and ownership.

## Validation, persistence, and security

- Echo is removed before rendering or matching.
- Display names never enter model preferences, events, or model dispatch.
- Catalog descriptors are untrusted bounded network data. Selectable IDs pass the shared product validator, and all catalog text passes the control-safe, single-line, display-width-bounded terminal projection.
- Manual IDs pass through the same product model normalizer as flag, environment, and command input.
- Canonical product-model validation rejects malformed, control-bearing, or over-512-byte IDs before writing a new product model preference, root, or branch model change.
- Echo, embedded custom providers, and retained committed model identities remain governed by their provider-specific and retained-state boundaries.
- Direct-provider namespace validation runs before confirmation where possible and again at supervisor normalization.
- A catalog row does not prove provider credentials, formal tool support, reasoning support, availability, or successful execution.
- Known-unsupported fixed-tool capability rejects admission; unknown capability remains explicit and follows existing admission policy.
- Provider/model selection makes no model-execution or inference request.
- The configured Gateway catalog request contains no provider credential.
- Secret input never enters picker queries, model rows, errors, logs, history, catalog cache, or renderer snapshots.
- Terminal cleanup runs for success, validation failure, protocol failure, recognized raw cancellation input, stream failure, and explicitly handled catchable signals. Uncatchable process termination is outside this guarantee.
- Model selection is disposable client state. The canonical root session begins only after successful confirmation.
- Full configuration and known-unsupported admission validation precede the workspace-default write. A confirmed valid default may remain if a later cross-store session request fails or becomes unconfirmed, and that partial outcome remains explicit.

## Rejected alternatives

### Create a temporary session and reuse `/model`

Rejected because the root's initial durable identity must contain the user-selected model. A placeholder model would require a misleading `SessionCreated`, a follow-up mutation, cleanup on cancellation, and special recovery behavior.

### Start and destroy a full-screen OpenTUI application for setup

Rejected for this scope because the current full-screen application requires an attached session. A second alternate-screen lifecycle before ordinary attachment adds flicker, signal ownership, renderer handoff, and cleanup complexity without improving a two-step selector.

### Keep separate first-run and `/model` matchers

Rejected because provider-to-model filtering, fuzzy ranking, manual entry, and selected-row reconciliation would drift between setup and later model changes. Surface-specific provider visibility remains separate by design.

### Add a prompt or fuzzy-search dependency

Rejected because the repository already owns raw terminal input and OpenTUI rendering, the catalog is bounded, and the required deterministic matcher is small and testable.

### Require a catalog match

Rejected because catalog availability and completeness are not execution authority. Manual canonical IDs are required for offline use, custom endpoints, and newly released or private models.

## Implementation sequence

### Phase A — Freeze selection semantics

- Add pure provider/model option types and provider namespace filtering.
- Add deterministic normalization, fuzzy scoring, tie-breaking, and empty-query ordering.
- Add the product-scoped canonical validator and consume it from configured-catalog normalization, product transport normalization, and manual-row eligibility.
- Add explicit manual canonical-ID rows with default-selection precedence over fuzzy suggestions.
- Add selected-identity reconciliation and visible-window calculation.
- Add control-safe, single-line, display-cell-bounded presentation helpers.
- Prove bounded work over the maximum candidate and query sizes.
- Cover all pure behavior with table-driven unit tests.

### Phase B — Add the first-run inline picker

- Extract or extend `ProductPrompter` with exclusive raw-input ownership.
- Add provider and model picker renderers.
- Wire provider selection, hidden credential entry, cancellable catalog loading, model confirmation, full-configuration validation, and cancellation into `chooseManagedModel`.
- Enforce known-unsupported fixed-tool rejection at the authoritative root/model-change boundary and mirror it before client persistence for early feedback.
- Handle invalid retained product defaults according to the explicit interactive and non-interactive policy.
- Preserve explicit/default/environment/non-interactive paths byte-for-byte where behavior is unrelated to interaction.
- Validate effort and admission before model preference persistence; preserve the documented confirmed-default partial outcome if later root creation fails.

### Phase C — Align `/model`

- Replace `catalogModelsForProvider` substring matching with the shared selection model.
- Add dedicated single-line query and stable selected-identity state without modifying the ordinary composer draft.
- Apply explicit query-edit and data-refresh reconciliation.
- Render the selected result inside the bounded visible window.
- Add the explicit, default-selected manual-ID row.
- Propagate catalog status and bounded errors into `TerminalModelDetail`, including rejected-request mapping.
- Preserve existing model change, credential login/logout, and idle-boundary validation.

### Phase D — Product verification and documentation

- Update deterministic OpenTUI frame/input tests.
- Replace the old first-run line-prompt pseudo-terminal steps with typeahead key input.
- Add catalog unavailable/manual-ID, loading cancellation, signal cleanup, malicious catalog text, and failure-boundary pseudo-terminal paths.
- Verify secrets are absent from output and durable files.
- Update public onboarding, configuration, capability, operator, and verification documentation.
- Update `AGENTS.md` implementation status after the behavior ships.

## Primary implementation surface

Expected source changes:

- `src/cli.ts` — retain resolution policy and invoke typed provider/model selection.
- `src/tui/product-prompter.ts` or a focused equivalent — sessionless inline TTY input, rendering, cleanup, and hidden credential ownership.
- `src/product/model-selection.ts` or a focused equivalent — pure surface-supplied option ranking, provider-to-model filtering, manual rows, reconciliation, visible windows, and bounded safe presentation.
- `src/domain/model.ts` — product-catalog model shape, control, and UTF-8 byte-bound helper without changing the generic retained `ModelConfiguration` invariant.
- `src/runtime/model-catalog.ts` — consume the shared product-catalog validator for fetched and cached selectable descriptors.
- `src/executors/model.ts` — consume shared validation only for product transports and preserve custom-provider normalization.
- `src/runtime/supervisor.ts` and the existing model-admission helper — reject known-unsupported new roots and branch model changes at the authoritative boundary.
- `src/product/service.ts` — validate model defaults through the shared boundary before preference storage.
- `src/tui/opentui.ts` — consume shared model selection state in `/model`.
- `src/tui/detail-model.ts` — carry catalog status/error and consume shared provider filtering.
- `src/tui/index.ts` — preserve catalog result status when building model details.

Expected test changes:

- a new pure model-selection unit suite;
- `test/unit/opentui.test.ts`;
- `test/integration/product-cli.test.ts`;
- `test/integration/managed-service.test.ts`;
- `test/integration/model-catalog.test.ts` — shared grammar, controls, configured origins, stale/unavailable results, and hostile presentation inputs;
- `test/e2e/opentui-pty.test.ts`;
- the strict provider fixture when multiple searchable catalog rows or catalog-failure modes are required.

Expected documentation changes:

- `README.md`;
- `AGENTS.md`;
- `docs/install.md`;
- `docs/user-guide.md`;
- `docs/configuration.md`;
- `docs/operator-guide.md`;
- `docs/capabilities.md`;
- `docs/verification.md`;
- `plans/README.md`.

No changes should be required in:

- domain events or reducers;
- workspace or profile migrations;
- artifact storage;
- synchronization envelopes;
- provider request, response, or streaming behavior;
- formal response contracts;
- outbox semantics;
- context construction;
- placement contracts.

## Verification

### Pure unit coverage

- provider display-name and stable-name matching;
- model display-name and canonical-ID matching;
- case, whitespace, punctuation, token-prefix, substring, and subsequence matches;
- deterministic tie ordering independent of catalog response order;
- deterministic code-point ordering independent of host locale;
- empty-query catalog order;
- query-edit reset and data-refresh identity reconciliation;
- visible windows containing selections beyond the first eight results;
- Up/Down wrapping;
- OpenAI and Anthropic creator filtering;
- Vercel all-creator behavior;
- exact catalog IDs versus manual rows;
- unmatched valid manual IDs default-selected ahead of fuzzy catalog matches;
- invalid and cross-provider manual IDs;
- invalid leading creator punctuation, UTF-8 overflow, C0/C1/DEL, ANSI escape, and bidirectional-formatting rejection;
- product-only validation that leaves Echo and embedded custom-provider model IDs valid;
- input, searchable-field, result, operation-count, and allocation bounds across 10,000 candidates.

### TTY driver coverage

- printable input, paste, Backspace, Up, Down, Enter, Escape, Ctrl-C, and Ctrl-D;
- split ANSI arrow-key sequences;
- split UTF-8 code points and bracketed/ordinary pasted line endings;
- no-match and disabled-Enter behavior;
- slow loading cancellation, late-result suppression, stale fallback, unavailable, rejected-request, and empty-catalog rendering;
- raw mode, pause state, cursor, and listener restoration after every terminal path;
- listener restoration after abort, input-stream error, protocol rejection, renderer failure, and explicitly handled catchable signals;
- bounded redraw without leaking prior query rows under narrow widths, width changes, missing width, wide Unicode, long labels, shrinking result sets, and catalog control characters;
- proof that no catalog-originated ANSI, line break, or bidirectional formatting reaches terminal output;
- hidden credential input and redaction.

### OpenTUI coverage

- fuzzy search through `/model`;
- selected-identity reset after query edits and preservation after data-only refresh;
- navigation beyond the first visible result page;
- default and navigated manual-ID selection while fuzzy catalog matches also exist;
- stale and unavailable catalog notices;
- rejected catalog requests mapped to unavailable notices;
- surface-specific provider projection and Echo exclusion;
- single-line paste/newline handling, query bounds, Escape-back behavior, and ordinary composer-draft preservation;
- model selection persists the canonical ID and retained reasoning preference;
- responsive narrow and minimum layouts keep the selected row and key hints usable.

### Integration coverage

- explicit `--model` bypasses interactive selection;
- a usable retained workspace default bypasses selection;
- model environment variables preserve current resolution behavior;
- one usable provider bypasses only the provider picker;
- several usable providers open the provider picker without requesting another credential;
- no usable provider selects a provider, stores a hidden key, re-reads usability, and opens model discovery;
- cancellation before model confirmation creates no session or model preference;
- a stored credential remains after cancellation following successful key entry;
- catalog fallback and unavailable states propagate truthfully;
- malformed retained product defaults remain inspectable, warn and reopen setup interactively, and fail with guidance non-interactively;
- new product-model writes reject malformed or over-bound IDs while retained non-Echo branches are not silently rewritten;
- Echo and custom embedded provider roots remain valid under provider-specific normalization;
- known-unsupported selections write no new workspace model preference, root, or branch model-change event, while an existing retained default remains inspectable and unknown capability follows existing admission policy;
- validation, effort, and admission failures occur before preference persistence;
- a confirmed valid default remains after later session creation failure; definite rejection reports no root, while post-dispatch transport loss reports an unconfirmed root outcome and relies on session listing for reconciliation;
- managed-service loss after credential persistence and before model confirmation creates no session or model preference;
- non-interactive missing configuration fails and creates no session;
- non-Echo resumed branches ignore new defaults and do not open setup;
- a retained Echo branch uses the picker when needed and commits the selected product model through the existing `SessionModelChanged` migration path.

### Installed pseudo-terminal coverage

The linked-executable pseudo-terminal journey must:

1. start in a fresh repository and profile;
2. search or navigate to a provider and press Enter;
3. submit a hidden fixture credential;
4. load at least two catalog models with human-readable names;
5. type a fuzzy query, move with Up or Down, and press Enter;
6. verify the created branch retains the exact expected canonical model;
7. enter the ordinary full-screen terminal and complete its existing task journey;
8. confirm the credential is absent from captured terminal bytes and durable non-credential files.

The test process sets both `OPENAI_BASE_URL` and `AI_GATEWAY_BASE_URL` to the local strict fixture but deliberately omits `OPENAI_API_KEY`, `OPENAI_MODEL`, and other provider/model environment shortcuts so first-run selection is exercised. The hidden prompt supplies the fixture's accepted key. The fixture serves at least two deterministic language-model catalog rows and records catalog requests, so this path never contacts the public Gateway.

Add a separate fixture mode where local `/v1/models` retrieval fails, an exact canonical model ID is selected through the manual row, and root creation succeeds without claiming catalog verification. Add hostile-label and known-unsupported fixture modes for terminal-safety and pre-admission coverage.

### Required gates

Run focused suites during implementation, followed by:

```sh
bun run typecheck
bun run check:architecture
bun test --timeout 30000
bun run test:acceptance:matrix
```

Real-provider, official Turso, and Turso Cloud checks remain separately gated. Report them as passed, failed, or skipped; deterministic fixture coverage is sufficient for this interaction change.

## Documentation requirements

Public documentation must describe:

- provider and model typeahead behavior;
- Up/Down, Enter, Backspace, Escape, and manual-ID controls;
- display names as catalog presentation and canonical IDs as durable identity;
- direct-provider creator filtering;
- configured Gateway catalog origin and credential-free catalog retrieval;
- cached stale and unavailable catalog behavior;
- exact manual-ID precedence over fuzzy suggestions;
- known-unsupported fixed-tool rejection and explicit unknown capability;
- invalid retained-default behavior and the confirmed-default/session-outcome partial failure boundary;
- hidden credential storage and precedence;
- unchanged non-interactive setup requirements;
- unchanged non-Echo resumed-branch identity and the explicit retained Echo migration.

Do not claim that catalog presence proves model execution or formal-tool support. Do not claim that catalog absence makes a model unavailable. Do not call a configured custom origin the public Gateway or claim that selection makes no network request; it makes a credential-free catalog request but no inference request.

## Completion criteria

This plan is complete when:

1. first interactive setup uses keyboard-driven provider and model selectors instead of numbered/raw line prompts;
2. model discovery searches both catalog display names and canonical IDs with deterministic fuzzy ranking;
3. Up/Down and Enter select from a bounded visible window, and selection remains visible after query edits, refresh, and navigation;
4. exact canonical IDs remain explicitly selectable when missing from the catalog or when the catalog is unavailable, and a valid unmatched manual row is selected ahead of fuzzy suggestions;
5. new OpenAI, Anthropic, and Vercel selections obey the shared product grammar, byte/control bounds, and namespace rules without changing Echo, custom-provider, or retained-branch identity semantics;
6. configured-catalog labels and errors cannot inject controls or unbounded rows into either terminal surface;
7. known-unsupported fixed-tool selections fail before a new model preference, root, or branch model-change event is written, while retained defaults remain inspectable and unknown capability remains explicit and admissible under existing policy;
8. for new roots, the selected canonical model and resolved effort are committed in the initial `SessionCreated`;
9. new-root setup creates no placeholder session or follow-up model correction, while retained Echo migration preserves its explicit `SessionModelChanged` path;
10. flags, valid workspace defaults, valid environment models, non-interactive failure, non-Echo resumed branches, and Echo migration retain their prior semantics, while invalid retained defaults follow the documented warning/failure policy;
11. credential input remains hidden and absent from output and durable non-credential state;
12. `/model` uses the same provider-to-model filtering, fuzzy ranking, manual-entry, safe-presentation, and selection-reconciliation rules while retaining its surface-specific provider set and composer draft;
13. catalog refreshed, stale fallback, rejected, unavailable, and empty states remain truthful and usable;
14. setup restores terminal state on every supported completion, error, cancellation, and catchable-signal path and makes no guarantee for uncatchable termination;
15. cross-store partial outcomes at credential, confirmed-default, and session boundaries are explicit and covered by tests;
16. unit, integration, OpenTUI, pseudo-terminal, architecture, and acceptance gates pass;
17. public documentation, `AGENTS.md`, verification claims, and the plan index match the shipped behavior.

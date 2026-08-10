# First-run provider and model typeahead plan

**Status:** Proposed
**Date:** August 10, 2026
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)
**Related plans:** [Reasoning effort and model capabilities](./2026-08-07-reasoning-effort-and-model-capabilities-plan.md), [Rich terminal rendering and layout](./2026-08-07-rich-terminal-rendering-and-layout-plan.md), and [Formal model tool contracts](./2026-08-07-formal-model-tool-contracts-plan.md)

## Summary

Agencity requires an explicit provider and canonical model before it creates a root session. The first interactive setup path presents a numbered provider prompt, reads a provider key through hidden input, and then asks the user to type an exact `creator/model` identifier. After session creation, the `/model` inspector provides a richer keyboard-driven catalog picker with model display names, Up/Down navigation, and Enter selection.

Replace the first-run provider and model prompts with a session-independent inline typeahead. The provider picker searches visible provider names. The model picker loads the existing public Gateway catalog, searches both display names and canonical IDs with deterministic fuzzy ranking, and selects with Up/Down and Enter. Exact canonical model entry remains available when a model is absent from the catalog or catalog retrieval is unavailable.

The work also extracts one pure provider-filtering and fuzzy-selection model for both first-run setup and the `/model` inspector. It does not add a provider list, model list, protocol endpoint, canonical event, table, or placeholder session.

## Architectural decision

First-run selection uses a small inline terminal picker owned by the existing product prompting layer. It runs before the full-screen terminal client and returns a provider or canonical model ID to the existing `chooseManagedModel` policy.

The picker has two layers:

1. **Pure selection model:** provider filtering, normalized search keys, fuzzy scores, deterministic ordering, selected-row reconciliation, visible-window calculation, and explicit manual-model rows.
2. **TTY driver:** raw key input, bounded query editing, Up/Down/Enter/Escape handling, inline rendering, and unconditional terminal restoration.

The pure layer is shared with the full-screen `/model` inspector. Rendering remains specific to each surface: first-run setup is an inline prompt, while `/model` remains an OpenTUI inspector attached to an existing branch.

This boundary preserves the durable lifecycle. The final selected model is normalized before `SessionCreated`; no temporary session, internal Echo session, or follow-up `SessionModelChanged` is required to initialize the product.

## Goals

- Let a user choose a provider with printable search, Up/Down navigation, and Enter.
- Let a user find a model by its human-readable catalog name without knowing its canonical ID.
- Search model display names and canonical `creator/model` IDs with predictable fuzzy matching.
- Persist the selected descriptor's canonical ID rather than its display name.
- Preserve exact manual canonical-ID entry for unavailable, stale, incomplete, or custom catalogs.
- Keep direct OpenAI and Anthropic choices within their matching creator namespace while allowing Vercel AI Gateway to show every catalog language model.
- Share matching, filtering, ordering, and selection reconciliation between first-run setup and `/model`.
- Keep provider credentials hidden, supervisor-side, and absent from terminal output, profile preferences, workspace history, artifacts, and catalog records.
- Create no session until provider credentials and model selection have completed successfully.
- Preserve explicit options, retained workspace defaults, environment configuration, reasoning-effort resolution, non-interactive failure, non-Echo resumed-branch model identity, and the existing explicit migration of retained internal Echo branches.
- Cover the installed product path through a real pseudo-terminal.

## Non-goals

- Automatically choosing a provider, model, or reasoning level on the user's behalf.
- Changing provider or model precedence for cases that already resolve without an interactive prompt.
- Replacing canonical `creator/model` identity with display names or provider-native IDs.
- Requiring a selected model to appear in the public catalog.
- Adding a hand-maintained model allowlist, recommendation list, popularity ranking, or recency ranking.
- Adding model aliases, typo correction that changes the submitted ID, or silent nearest-model selection.
- Changing provider credentials, credential precedence, endpoint overrides, or credential storage.
- Changing model capability admission, formal tool contracts, reasoning semantics, or model execution.
- Changing an existing non-Echo branch's model during resume or removing the existing explicit Echo-branch migration.
- Adding protocol routes, canonical events, mutable tables, migrations, synchronization fields, or artifact data.
- Turning first-run setup into a session-bearing full-screen terminal client.
- Generalizing every terminal search surface onto one universal picker framework.

## Terms

- **Provider:** The durable model transport selected for a session. Product transports are `vercel`, `openai`, and `anthropic`; internal deterministic providers are excluded from product setup.
- **Canonical model ID:** The public Gateway catalog's `creator/model` identifier retained in `ModelConfiguration.model`.
- **Display name:** Human-readable catalog metadata such as `GPT 5.6 Sol`. It is presentation only and is never persisted as model identity.
- **Catalog result:** A normalized `ModelDescriptor` returned by the existing `/model-catalog` protocol surface.
- **Manual model row:** An explicit selectable row that submits a syntactically valid canonical ID typed by the user even when no catalog descriptor has that exact ID.
- **Fuzzy match:** A deterministic case-insensitive match across normalized display-name and canonical-ID fields. Fuzzy matching affects presentation order only; it never rewrites a model ID.
- **Inline picker:** A bounded pre-session TTY interaction that redraws its own prompt rows without starting the branch-attached OpenTUI application.
- **Echo migration:** The existing pre-release compatibility path that replaces a retained internal Echo branch's model when a command requires a usable product model. This is an explicit mutation of an existing branch, not first-session initialization.

## Verified implementation baseline

### Product startup

The ordinary product path is:

1. `runProduct` in `src/cli.ts` resolves the workspace and connects to the managed workspace service.
2. New work calls `chooseManagedModel`.
3. `chooseManagedModel` resolves an explicit model, a usable retained workspace default, a provider model environment variable, or interactive setup.
4. Interactive setup calls `chooseManagedProvider`, `ProductPrompter.secret`, and `ProductPrompter.question`.
5. The selected model is stored as the workspace default through `productSetModel`.
6. `finish` applies explicit or retained model-specific reasoning effort.
7. `createSession` normalizes the complete model configuration and commits the initial model in `SessionCreated`.

The interactive provider prompt accepts a number or provider ID. The model prompt accepts an unstructured line and relies on the existing model normalization boundary to enforce canonical identity and direct-provider namespace rules.

`ProductPrompter.secret` already closes readline, enters raw mode, bounds the input, restores the previous raw/paused state, and never echoes the credential. Its data listener is removed on recognized Enter or cancellation input rather than unconditionally in `finally`; the new shared driver must harden listener cleanup for aborts, stream errors, and every exceptional exit.

### Existing `/model` picker

The branch-attached terminal already provides:

- provider navigation and login/logout in `src/tui/opentui.ts`;
- catalog loading through `TerminalUI.#showModelDetail` in `src/tui/index.ts`;
- catalog display names, canonical IDs, context metadata, reasoning state, stale labels, and model-tool state;
- Up/Down wrapping and Enter selection;
- exact-ID fallback when no catalog row matches.

Its catalog filter is a case-insensitive substring test in `catalogModelsForProvider`. It does not implement fuzzy ranking. The selected index is not reconciled when a query changes, and the renderer always shows the first eight results even when navigation moves selection beyond that window. Catalog request failures are collapsed to an empty descriptor list by `TerminalUI.#showModelDetail`, so the inspector cannot distinguish an unavailable catalog from a valid empty result.

### Catalog and protocol

`ModelCatalog` in `src/runtime/model-catalog.ts`:

- fetches the public Gateway `/v1/models` endpoint without provider authentication;
- retains language models only;
- normalizes display name, canonical ID, context/output limits, pricing, reasoning metadata, required-tool metadata, endpoint identity, digest, and stale state;
- bounds the response to 8 MiB and 10,000 models;
- caches normalized descriptors in a digest-checked endpoint-specific profile record;
- reports `refreshed`, `cached-fallback`, or `unavailable`;
- uses a 24-hour freshness window by default.

`GET /model-catalog` calls `ensureFresh`, and `AgentClient.modelCatalog()` exposes the result. This is sufficient for first-run discovery. No new server capability is required.

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

The exact order follows the visible provider descriptors supplied by the service. Echo is removed before options reach the picker.

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

After a provider is resolved and has a usable credential, the model stage calls `AgentClient.modelCatalog()` once and renders a bounded loading message while the request is pending.

Result handling:

- `refreshed`: show catalog rows normally;
- `cached-fallback`: retain selectable rows and show a stale-catalog warning with the bounded error summary;
- `unavailable`: show a truthful unavailable message and keep manual canonical-ID entry available;
- empty provider-filtered catalog: explain that no catalog rows are available for the provider and keep manual entry available.

Catalog failure never causes provider or model substitution.

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

Interaction:

- Printable text and paste update the query.
- Backspace edits the query.
- Up and Down wrap through the complete ranked result set.
- The renderer shows a bounded window of at most eight rows that always contains the highlighted row.
- Enter selects the highlighted catalog descriptor and returns its canonical ID.
- A query change reconciles selection to the first ranked result.
- Escape, Ctrl-C, or Ctrl-D cancels setup.

Catalog names are presentation data. The selected configuration always uses:

```ts
{
  provider: selectedProvider.name,
  model: selectedDescriptor.model,
  reasoningEffort: "provider-default",
}
```

The existing `finish` step remains responsible for explicit and retained reasoning-effort resolution.

### Manual canonical model entry

Manual entry is represented as an explicit row rather than an accidental zero-match fallback.

When the query is a valid bounded canonical ID and no catalog descriptor has that exact ID, append:

```text
  Use exact model ID
  openai/gpt-private-preview · not listed in catalog
```

Rules:

- canonical shape matches the catalog identity rule: a nonempty creator segment containing only letters, digits, `.`, `_`, or `-`, followed by `/` and a suffix whose first character is neither whitespace nor `/` and which contains no whitespace;
- the complete ID is at most 512 UTF-8 bytes, matching retained model-dispatch identity bounds;
- direct OpenAI enables the row only for `openai/...`;
- direct Anthropic enables the row only for `anthropic/...`;
- Vercel enables any valid `creator/model`;
- an exact catalog ID selects the catalog row rather than duplicating it;
- fuzzy text that is not a valid canonical ID never becomes a manual model implicitly;
- the existing supervisor normalization remains the final authority.

When the catalog is unavailable, this row becomes the only selectable model option after the user types a valid canonical ID.

### Completion and cancellation

After Enter confirms a model:

1. call `productSetModel` with `provider:creator/model`;
2. apply existing model-specific effort resolution;
3. create the root session with the normalized complete model;
4. remember the route;
5. close prompt input ownership;
6. start the ordinary full-screen terminal client.

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

The candidate search fields are:

- provider: display name and stable name;
- model: display name and canonical ID.

Model descriptions, prices, capability explanations, and remediation text do not influence ranking.

### Match tiers

Candidates rank by the best matching field:

1. exact normalized field match;
2. exact canonical-ID or provider-name match;
3. field prefix;
4. token-prefix match in query-token order;
5. contiguous substring;
6. ordered character subsequence.

Within a tier, prefer:

1. fewer unmatched characters;
2. earlier first match;
3. display-name match over canonical-ID match only when all score components are otherwise equal;
4. normalized display name;
5. canonical ID or provider stable name.

The score must be deterministic and must not depend on original catalog response order. An empty query preserves the catalog's stable display-name/ID order.

No fuzzy score changes the selected ID. Enter always returns the exact option identity.

### Bounds

- Provider query: at most 128 Unicode characters.
- Model search query: at most 512 Unicode characters.
- Manual canonical ID: at most 512 UTF-8 bytes.
- Candidate count: the catalog's existing 10,000-model bound.
- Rendered rows: at most eight model rows and all supported provider rows.
- Matching: linear over precomputed normalized candidate fields for each query update.

The implementation adds no fuzzy-search dependency.

Add one shared canonical-model validator for picker eligibility and product model normalization. It applies the catalog-compatible shape and the 512-byte retained identity limit before a model preference or new root can be committed. Product-level selection adds direct-provider namespace rules. Private and newly released models remain supported without catalog membership when they satisfy this canonical shape. Existing valid canonical IDs do not require a catalog row.

## Component design

### Shared selection model

Add a focused pure module under `src/product/` or `src/tui/` with no terminal, client, storage, or network access. It owns:

- product provider visibility and stable option projection;
- `providerAcceptsCanonicalModel(provider, model)`;
- catalog filtering by provider;
- normalized searchable fields;
- deterministic fuzzy scoring and ordering;
- explicit manual-model row construction;
- selected identity/index reconciliation after query changes;
- bounded visible-window calculation.

The API uses stable option identities rather than array indices. Renderers may derive a display index, but query changes and catalog refreshes reconcile through identity.

Provider/model filtering is product semantics and must not remain duplicated in `opentui.ts` and `detail-model.ts`.

### Inline TTY driver

Move or extend `ProductPrompter` into a focused terminal module so `src/cli.ts` retains orchestration rather than key parsing and ANSI redraw logic.

The driver:

- accepts input/output streams for tests;
- closes readline before entering raw selection;
- has one active input listener;
- preserves prior raw and paused state;
- hides the cursor only while drawing;
- redraws only its bounded prompt region;
- handles split escape sequences and multi-character input chunks;
- decodes UTF-8 incrementally so a code point split across input chunks is not replaced or counted twice;
- treats ordinary CR/LF as confirmation and strips bracketed-paste framing when a terminal sends it, without allowing pasted line endings to submit more than one value;
- bounds all retained query and error text;
- restores input state and cursor visibility in `finally`;
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

### `/model` convergence

Update the existing OpenTUI model inspector to consume the shared selection model:

- use fuzzy ranking instead of substring filtering;
- reconcile selection when the query changes;
- render the visible window containing the selected row;
- expose the same explicit manual-model row;
- preserve provider navigation, login/logout, model mutation boundaries, and command forms;
- carry catalog `status`, `error`, and origin into `TerminalModelDetail` instead of collapsing failures to an empty list.

This gives setup and later model changes one discovery contract without sharing session-dependent rendering code.

### Protocol and durable state

No protocol change is required. The implementation reuses:

- `GET /model-providers`;
- `GET /model-catalog`;
- `POST /product/config/provider-key`;
- `POST /product/config/model`;
- `POST /sessions`.

No canonical or profile schema change is required. Catalog cache and credential storage retain their existing classifications and ownership.

## Validation, persistence, and security

- Echo is removed before rendering or matching.
- Display names never enter model preferences, events, or model dispatch.
- Catalog descriptors are untrusted bounded network data and remain subject to existing normalization and output truncation.
- Manual IDs pass through the same product model normalizer as flag, environment, and command input.
- Canonical model validation rejects IDs over 512 UTF-8 bytes before writing a model preference or committing a new root.
- Direct-provider namespace validation runs before confirmation where possible and again at supervisor normalization.
- A catalog row does not prove provider credentials, formal tool support, reasoning support, availability, or successful execution.
- Provider/model selection does not make a provider API call.
- The public catalog request contains no provider credential.
- Secret input never enters picker queries, model rows, errors, logs, history, catalog cache, or renderer snapshots.
- Terminal cleanup runs for success, validation failure, protocol failure, cancellation, and signal interruption.
- Model selection is disposable client state. The canonical root session begins only after successful confirmation.
- Existing workspace-default persistence and reasoning-effort ordering remain unchanged after confirmation.

## Rejected alternatives

### Create a temporary session and reuse `/model`

Rejected because the root's initial durable identity must contain the user-selected model. A placeholder model would require a misleading `SessionCreated`, a follow-up mutation, cleanup on cancellation, and special recovery behavior.

### Start and destroy a full-screen OpenTUI application for setup

Rejected for this scope because the current full-screen application requires an attached session. A second alternate-screen lifecycle before ordinary attachment adds flicker, signal ownership, renderer handoff, and cleanup complexity without improving a two-step selector.

### Keep separate first-run and `/model` matchers

Rejected because provider filtering, fuzzy ranking, manual entry, and selected-row reconciliation would drift between setup and later model changes.

### Add a prompt or fuzzy-search dependency

Rejected because the repository already owns raw terminal input and OpenTUI rendering, the catalog is bounded, and the required deterministic matcher is small and testable.

### Require a catalog match

Rejected because catalog availability and completeness are not execution authority. Manual canonical IDs are required for offline use, custom endpoints, and newly released or private models.

## Implementation sequence

### Phase A — Freeze selection semantics

- Add pure provider/model option types and provider namespace filtering.
- Add deterministic normalization, fuzzy scoring, tie-breaking, and empty-query ordering.
- Add explicit manual canonical-ID rows.
- Add selected-identity reconciliation and visible-window calculation.
- Cover all pure behavior with table-driven unit tests.

### Phase B — Add the first-run inline picker

- Extract or extend `ProductPrompter` with exclusive raw-input ownership.
- Add provider and model picker renderers.
- Wire provider selection, hidden credential entry, catalog loading, model confirmation, and cancellation into `chooseManagedModel`.
- Preserve explicit/default/environment/non-interactive paths byte-for-byte where behavior is unrelated to interaction.
- Preserve model preference and reasoning-effort ordering after confirmation.

### Phase C — Align `/model`

- Replace `catalogModelsForProvider` substring matching with the shared selection model.
- Reconcile selection on every query change.
- Render the selected result inside the bounded visible window.
- Add the explicit manual-ID row.
- Propagate catalog status and bounded errors into `TerminalModelDetail`.
- Preserve existing model change, credential login/logout, and idle-boundary validation.

### Phase D — Product verification and documentation

- Update deterministic OpenTUI frame/input tests.
- Replace the old first-run line-prompt pseudo-terminal steps with typeahead key input.
- Add catalog unavailable/manual-ID and cancellation pseudo-terminal paths.
- Verify secrets are absent from output and durable files.
- Update public onboarding, configuration, capability, operator, and verification documentation.
- Update `AGENTS.md` implementation status after the behavior ships.

## Primary implementation surface

Expected source changes:

- `src/cli.ts` — retain resolution policy and invoke typed provider/model selection.
- `src/tui/product-prompter.ts` or a focused equivalent — sessionless inline TTY input, rendering, cleanup, and hidden credential ownership.
- `src/product/model-selection.ts` or a focused equivalent — pure provider filtering, fuzzy ranking, manual rows, reconciliation, and visible windows.
- `src/domain/model.ts` — shared canonical shape and UTF-8 byte-bound validation.
- `src/executors/model.ts` — consume shared canonical validation and preserve direct-provider namespace checks before durable creation.
- `src/product/service.ts` — validate model defaults through the shared boundary before preference storage.
- `src/tui/opentui.ts` — consume shared model selection state in `/model`.
- `src/tui/detail-model.ts` — carry catalog status/error and consume shared provider filtering.
- `src/tui/index.ts` — preserve catalog result status when building model details.

Expected test changes:

- a new pure model-selection unit suite;
- `test/unit/opentui.test.ts`;
- `test/integration/product-cli.test.ts`;
- `test/integration/managed-service.test.ts`;
- `test/integration/model-catalog.test.ts` only where result propagation needs additional coverage;
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
- empty-query catalog order;
- query-change selection reconciliation;
- visible windows containing selections beyond the first eight results;
- Up/Down wrapping;
- OpenAI and Anthropic creator filtering;
- Vercel all-creator behavior;
- exact catalog IDs versus manual rows;
- invalid and cross-provider manual IDs;
- input and result bounds.

### TTY driver coverage

- printable input, paste, Backspace, Up, Down, Enter, Escape, Ctrl-C, and Ctrl-D;
- split ANSI arrow-key sequences;
- split UTF-8 code points and bracketed/ordinary pasted line endings;
- no-match and disabled-Enter behavior;
- loading, stale fallback, unavailable, and empty-catalog rendering;
- raw mode, pause state, cursor, and listener restoration after every terminal path;
- listener restoration after abort, input-stream error, protocol rejection, and renderer failure;
- bounded redraw without leaking prior query rows;
- hidden credential input and redaction.

### OpenTUI coverage

- fuzzy search through `/model`;
- selected-row reset after query changes;
- navigation beyond the first visible result page;
- explicit manual-ID selection while catalog matches also exist;
- stale and unavailable catalog notices;
- provider filtering and Echo exclusion;
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

The test process sets both `OPENAI_BASE_URL` and `AI_GATEWAY_BASE_URL` to the local strict fixture. The fixture serves at least two deterministic language-model catalog rows and records catalog requests, so this path never contacts the public Gateway.

Add a separate fixture mode where local `/v1/models` retrieval fails, an exact canonical model ID is selected through the manual row, and root creation succeeds without claiming catalog verification.

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
- cached stale and unavailable catalog behavior;
- hidden credential storage and precedence;
- unchanged non-interactive setup requirements;
- unchanged non-Echo resumed-branch identity and the explicit retained Echo migration.

Do not claim that catalog presence proves model execution or formal-tool support. Do not claim that catalog absence makes a model unavailable.

## Completion criteria

This plan is complete when:

1. first interactive setup uses keyboard-driven provider and model selectors instead of numbered/raw line prompts;
2. model discovery searches both catalog display names and canonical IDs with deterministic fuzzy ranking;
3. Up/Down and Enter select from a bounded visible window, and selection remains visible after query changes and navigation;
4. exact canonical IDs remain explicitly selectable when missing from the catalog or when the catalog is unavailable;
5. OpenAI, Anthropic, and Vercel options obey their existing canonical namespace rules;
6. for new roots, the selected canonical model and resolved effort are committed in the initial `SessionCreated`;
7. new-root setup creates no placeholder session or follow-up model correction, while retained Echo migration preserves its explicit `SessionModelChanged` path;
8. flags, workspace defaults, environment models, non-interactive failure, non-Echo resumed branches, and Echo migration retain their prior semantics;
9. credential input remains hidden and absent from output and durable non-credential state;
10. `/model` uses the same filtering, fuzzy ranking, manual-entry, and selection-reconciliation rules;
11. catalog stale, unavailable, and empty states remain truthful and usable;
12. unit, integration, OpenTUI, pseudo-terminal, architecture, and acceptance gates pass;
13. public documentation, `AGENTS.md`, verification claims, and the plan index match the shipped behavior.

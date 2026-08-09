# Reasoning effort and model capabilities plan

**Status:** Implemented and verified
**Date:** August 7, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related terminal work:** [Rich terminal rendering and layout](./2026-08-07-rich-terminal-rendering-and-layout-plan.md)
**Later provider-contract work:** [Formal model tool contracts](./2026-08-07-formal-model-tool-contracts-plan.md)

The reasoning-effort, shared AI SDK transport, public model-catalog, durable dispatch, and terminal/protocol selection work in this plan is implemented. Problem statements and sequencing below describe the pre-implementation baseline; the later formal model-tool plan extends the resulting model transport and dispatch contracts.

## Summary

Before this work, Agencity let a user select a provider and model, but `ModelConfiguration` had no reasoning setting and the provider adapters did not send reasoning parameters. A user could not choose how much reasoning a supported model performed.

This plan delivered reasoning-effort selection by consolidating model execution onto one implementation:

1. **All product model execution goes through the Vercel AI SDK.** One shared adapter core behind the existing `ModelProvider` contract replaces the three hand-written HTTP adapters (OpenAI-compatible, Anthropic-compatible, and the gateway instantiated through the Anthropic adapter). Three thin transport factories instantiate the core: the Vercel AI Gateway (`@ai-sdk/gateway`, the recommended default), direct OpenAI (`@ai-sdk/openai`), and direct Anthropic (`@ai-sdk/anthropic`).
2. **The gateway's public model catalog is the single source of model and capability metadata for every transport** — model IDs, display names, context windows, output limits, pricing, and per-model reasoning levels. Agencity maintains no hand-written model catalog, no per-provider level maps, and no per-provider discovery adapters.
3. **A durable** `reasoningEffort` **setting** on `ModelConfiguration`, selected through `/effort` (alias `/thinking`), `--effort`, and the public protocol, inherited by child and recursive sessions, and recorded with the complete model configuration in an immutable per-call dispatch before any outbox-backed model effect.

Direct OpenAI and Anthropic access is included rather than deferred because the AI SDK makes each additional transport thin: the call interface, normalized reasoning parameter, warning semantics, catalog identities, dispatch, and recovery machinery are shared, so a direct transport adds only a credential path, a deterministic native-ID derivation, and recorded wire fixtures. Canonical model identity is the gateway's namespaced `creator/model` form for every provider (verified below).

The default effort is `provider-default`: Agencity omits all reasoning controls and the provider behaves exactly as it does today. This is a pre-release schema cutover: pre-feature workspace and profile data are not migrated and must be reset before running the new version.

## Decision and rationale



### Why the AI SDK is the single model interface

An earlier design for this feature kept three hand-written direct provider adapters and added per-provider reasoning dispatch: OpenAI `reasoning_effort`, Anthropic `thinking`/`output_config.effort` with reviewed token-budget maps, and a dedicated surface-aware gateway adapter. That design required a reviewed built-in capability catalog, a catalog validation script, a multi-source capability resolver with field-level provenance merging, and per-provider API-surface compatibility analysis. Those were the most fragile, highest-maintenance parts of the plan.

The AI SDK (version 7 and later) provides a normalized top-level `reasoning` parameter — `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh` — and owns the translation to each provider's native reasoning API, through the gateway and through the direct provider packages alike. The gateway's public model catalog provides model-specific reasoning capability metadata. Together they eliminate the hand-maintained catalog and all hand-written wire code.

The gateway is the recommended default transport because it adds capabilities the direct paths lack: one key for every listed model, optional response cost metadata (making `Usage.costUsd` meaningful), and optional caching. Model calls always require network access; local-first in `AGENTS.md` governs canonical state, storage, and artifacts, all of which remain local. The `ModelProvider` executor contract remains the seam for internal test providers, programmatic providers, and any future transports.

### Why direct transports are included and cheap

Under the AI SDK, a transport is a factory rather than an adapter. Direct OpenAI and Anthropic execution is in scope because every substantial surface is shared and written once:

- **Same call interface.** `generateText`/`streamText`, message shapes, streaming parts, warnings, and usage are identical across `@ai-sdk/gateway`, `@ai-sdk/openai`, and `@ai-sdk/anthropic`. The shared adapter core — options building, stream consumption, reasoning-part discard, warning normalization, error classification — has one implementation.
- **Same reasoning semantics.** The top-level `reasoning` parameter is documented for the direct provider packages with the same coercion-and-warning behavior used through the gateway, so the effort vocabulary, capability tiers, dispatch shape, and provenance are transport-independent.
- **Same model identities.** Canonical `creator/model` IDs drive every transport. The canonical-to-native derivation is deterministic: OpenAI native IDs are the suffix verbatim; Anthropic native IDs replace dots with dashes in the version segment.
- **Same metadata.** The public gateway catalog describes the models themselves, not the transport, so its descriptors, reasoning tiers, capacity, and pricing apply to direct transports without a second catalog or per-provider discovery adapters.

What a direct transport adds: a credential path that already exists in the credential store and environment fallbacks (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), a native-ID derivation, a trusted-local base-URL override used chiefly by test fixtures, and recorded wire fixtures for the pinned provider package. What it does not add: reasoning maps, capability sources, dispatch modes, recovery rules, or event schema changes.

Direct transports return no response cost metadata; their calls record the documented `Usage.costUsd` fallback of `0`, and cost remains best-effort telemetry.



### Rejected alternatives

- **Keep hand-written direct OpenAI/Anthropic adapters with per-provider reasoning dispatch.** Highest maintenance cost; requires a reviewed catalog and budget maps that the gateway catalog now provides.
- **A gateway-only product with direct access deferred.** An intermediate revision of this plan took this shape. Rejected because operating on provider keys without a Vercel account is a supported mode, and the shared-core design reduces direct support to thin factories over the same identities, catalog, and dispatch semantics; the deferral saved almost nothing.
- **Gateway BYOK (bring your own key) as the bridge for users holding only provider keys.** Verified facts: every gateway request still requires Vercel authentication (API key or OIDC), so BYOK does not serve a user without a Vercel key; BYOK requires a paid Vercel team; a failed BYOK request silently retries on Vercel system credentials billed to gateway credits, which is a hidden fallback that conflicts with Agencity's no-hidden-fallback invariant; BYOK spend bypasses gateway budgets. BYOK is a non-goal.
- **Gateway REST endpoints without the AI SDK.** Keeps hand-written request/streaming/SSE code that the SDK already owns, for no capability gain.
- **Strict reject-before-commit capability validation (previous revision).** With one normalized vocabulary and SDK-documented coercion behavior, strictness is retained where the catalog has exact data and relaxed to labeled, warning-recording behavior where it does not. This removes the failure mode where a stale or incomplete catalog makes a working model unusable.

### Sequencing with formal model tool contracts

This plan is implemented first and preserves the current provider-neutral text response contract. The later formal-tool-contract work will extend the model dispatch and response types for required provider tool calls. It must reuse the shared AI SDK adapter core and the durable dispatch boundary introduced here rather than reintroducing hand-written OpenAI or Anthropic transports. Formal tool calling is not an implementation dependency for reasoning-effort selection.



## Verified external facts

The following was verified against live endpoints, the package registry, and current documentation on August 7, 2026. Implementers re-verify package versions and endpoint contracts before pinning dependencies.

### Gateway model catalog

`GET https://ai-gateway.vercel.sh/v1/models` requires **no authentication** and returns, per model:

- `id` in `creator/model` form (for example `openai/gpt-5.2`, `anthropic/claude-opus-5`);
- `name` (display name), `description`, `context_window`, `max_tokens`, `pricing` (per-token input/output USD strings), `modalities`, `knowledge`;
- `type`, with values such as `language`, `embedding`, `image`, `realtime`, `reranking`, `speech`, `transcription`, and `video`;
- `tags` including `reasoning` where applicable;
- `supported_parameters` including `reasoning` where applicable;
- `reasoning_options`: either `null` or an array of structured entries such as `{ "type": "effort", "values": ["low", "medium", "high", "xhigh"] }`, `{ "type": "toggle" }`, and `{ "type": "budget_tokens", "min": …, "max": … }`.

Observed examples:


| Model                       | `reasoning_options`                           |
| --------------------------- | --------------------------------------------- |
| `openai/gpt-5.2`            | effort: `none, low, medium, high, xhigh`      |
| `openai/gpt-5.6-sol`        | effort: `none, low, medium, high, xhigh, max` |
| `anthropic/claude-sonnet-5` | toggle + effort: `low, medium, high, xhigh`   |
| `anthropic/claude-opus-5`   | `null` despite the `reasoning` tag            |


The `anthropic/claude-opus-5` row is load-bearing: **flagship models can have missing reasoning metadata**, so the design must treat `reasoning_options: null` as a normal state, not an error.

### Model identifier alignment

- OpenAI suffixes in the catalog are byte-identical to OpenAI's native API model IDs (`gpt-5.2`, `o3-mini`, `gpt-5.1-codex`).
- Anthropic suffixes use dotted aliases (`claude-opus-4.5`) where Anthropic's native API uses dashed aliases (`claude-opus-4-5`); the transform is deterministic (`.` ↔ `-` in the version segment).

This is why gateway-namespaced IDs are safe as Agencity's canonical durable model identity on every transport: the direct transports derive native IDs from the same stored value. The canonical-to-native direction is deterministic, and version segments without dots (for example `claude-3-haiku`) pass through unchanged.

### AI SDK reasoning normalization

- The AI SDK (v7+) `generateText`/`streamText` accept a top-level `reasoning` value: `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. `provider-default` is the behavior when the option is omitted.
- Effort-based providers receive the level directly. When a model supports fewer levels, **the SDK coerces the value to the nearest supported level and emits a warning**. Budget-based providers receive a token budget derived as a documented percentage of maximum output tokens. Providers without reasoning support ignore the option and emit an `unsupported` warning.
- Reasoning-related settings in `providerOptions` take full precedence over the top-level `reasoning` value.
- The top-level `reasoning` parameter is documented for the direct provider packages, including `@ai-sdk/openai` and `@ai-sdk/anthropic`, with the same coercion and warning semantics as gateway execution.
- The catalog lists `max` as an effort value for some models (for example `openai/gpt-5.6-sol`), but `max` is not in the SDK's documented top-level vocabulary. This release does not send undocumented provider-option escapes: `max` is retained in catalog diagnostics but is not selectable.

### Current SDK and gateway endpoints

- The latest stable package versions verified on August 7, 2026 are `ai@7.0.58` and `@ai-sdk/gateway@4.0.46`. Implementation rechecks the registry, installs the latest stable compatible versions, and pins the resolved versions exactly.
- The direct provider packages `@ai-sdk/openai` and `@ai-sdk/anthropic` expose the same model interface consumed by `generateText`/`streamText`, with per-provider `apiKey` and `baseURL` options. Implementation resolves and pins their latest stable compatible versions alongside `ai` and `@ai-sdk/gateway`.
- The AI SDK `createGateway` model API uses a base URL prefix whose official default is `https://ai-gateway.vercel.sh/v4/ai`.
- Public model discovery uses `https://ai-gateway.vercel.sh/v1/models`.
- `AI_GATEWAY_BASE_URL` remains an origin override, not an AI SDK model-API prefix. Agencity derives the model API and catalog URLs from that normalized origin.
- `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` are origin-only trusted-local execution overrides for the direct transports with the same normalization rules; they never affect the catalog origin.

### Usage and cost reporting

- AI SDK results provide token usage and may provide gateway cost metadata with the completed response.
- Exact generation cost is also available through generation lookup, but that data is asynchronously ingested and may be unavailable immediately after completion.
- This plan does not add generation polling or later cost reconciliation. `Usage.costUsd` uses a finite nonnegative cost returned directly with the completed SDK result when available and otherwise remains `0`. Cost is best-effort telemetry, not a reliable admission or enforcement boundary.
- Direct OpenAI and Anthropic transports return no gateway cost metadata; their calls always record the `0` fallback.



### Gateway authentication and BYOK

- Every gateway **model call** requires Vercel authentication (AI Gateway API key or OIDC token). Only the model catalog endpoint is public.
- BYOK exists in team-level and request-scoped (`providerOptions.gateway.byok`) forms, requires the paid tier, silently falls back to Vercel system credentials on failure by default, and bypasses gateway budgets. It is not used by this plan.



## Verified codebase baseline

As of this writing:

- `ModelConfiguration` (`src/domain/events.ts`) contains only `provider`, `model`, optional `temperature`, and optional `maxOutputTokens`.
- `SessionCreated`, `SessionModelChanged`, `TaskCreated`, and `RecursiveModelStarted` retain that configuration in canonical events. `ModelCallRequested` records provider and model but no reasoning data.
- `src/executors/model.ts` contains two hand-written HTTP adapters: `OpenAICompatibleProvider` (duplicated non-streaming and streaming request builders, hand-rolled SSE parsing, `max_tokens`) and `AnthropicCompatibleProvider` (`/v1/messages`, no `thinking`). The `vercel` provider is instantiated through the Anthropic-compatible adapter against `https://ai-gateway.vercel.sh` (`src/runtime/supervisor.ts`).
- There are four model-effect admission paths: the typed autonomous run (`src/runtime/agent-runs.ts`), the retained diagnostic turn (`src/runtime/model-loop.ts`), model-summary compaction (`src/runtime/context-compaction.ts`), and generic generated `tools.request("model", "complete", …)` access through the console SDK. The first two append `ModelCallRequested`; compaction requests one model effect per summary chunk per hierarchy level; the generic executor path currently bypasses model-call admission and must be reserved by this plan.
- In `agent-runs.ts` a crash window exists between the committed `ModelCallRequested` and the corresponding effect request; recovery semantics below account for it.
- Child spawn uses `input.model ?? parentState.model` and validates with `assertChildPolicy` (same provider/model as parent), but explicit child configurations do **not** pass through `Supervisor.normalizeModelConfiguration`. This validation gap must be closed without widening the child model policy.
- `ProfileStore` (`src/storage/turso.ts`) creates its schema from an inline idempotent SQL string with ad-hoc `PRAGMA table_info` column checks. There is no numbered profile migration ledger; one must be introduced before adding a profile table.
- `ModelExecutor.contextCapacity` resolves context-window capacity from provider-wide `ModelProviderCapabilities`; its source enum already includes `"model-catalog"`, which is used by deterministic internal fixture providers but not by a product transport. Capacity for the `vercel` provider is unknown today unless operator-configured.
- Model usage cost (`Usage.costUsd`) is populated only when the provider response carries a cost field; otherwise it is `0`. Cost-based budget limits are therefore best-effort.
- The current `vercel` provider has no model normalizer, so existing development data may contain either canonical namespaced IDs or bare IDs. This data is outside the supported cutover boundary and is reset rather than migrated.
- The current reducer version is 7 (`src/domain/state.ts`); a snapshot with a mismatched reducer version is discarded and rebuilt from events.
- Existing protocol surfaces used by this plan: `GET /capabilities`, `POST /sessions/:session/model?branch=…`, `GET /product/config`, `POST /product/config/model`, and the `agencity config` CLI family.
- Echo is an internal deterministic test provider implementing the `ModelProvider` contract; it is filtered from product selection.



## Goals

- Let a user inspect and select reasoning effort for the current model, with levels sourced from the gateway catalog.
- Persist the selected effort as part of durable branch model configuration; preserve it across process, worker, terminal, and managed-service restarts.
- Apply the same setting to streaming and non-streaming calls.
- Place the exact resolved complete model dispatch in the outbox input so recovery cannot reinterpret configuration or reasoning.
- Replace the three hand-written provider adapters with one shared AI SDK adapter core and three thin transport factories (gateway, direct OpenAI, direct Anthropic) behind the unchanged `ModelProvider` contract.
- Make the gateway catalog the single model/capability/pricing/capacity metadata source for every transport, cached for offline listing.
- Give direct OpenAI and Anthropic execution the same canonical model identities, capability tiers, dispatch, provenance, and recovery semantics as the gateway, differing only in credential, execution endpoint identity, and native-ID derivation.
- Record provider coercion and unsupported-setting warnings as bounded, attributable call provenance rather than silently accepting or silently dropping a setting.
- Preserve directly returned gateway cost metadata when available and retain the current `0` fallback when it is not.
- Preserve manual model entry and truthful failure when the catalog is unavailable.
- Keep every provider credential supervisor-side, confined to its own transport, and out of events, profile metadata, caches, logs, and protocol output.
- Preserve exact parent configuration when child and recursive work use inherited models.
- Cover the installed product path with black-box tests.



## Non-goals

- Gateway BYOK in any form.
- Displaying hidden chain-of-thought or storing provider reasoning traces.
- A user-specified integer thinking-token budget.
- Automatically choosing an effort from task complexity.
- Allowing a model to mutate its own root-session effort during active work.
- Retrying a failed or unknown model effect with a different effort, model, or provider.
- Automatic transport selection, fallback between transports, or gateway `order`/`only` routing controls; a session's provider is an explicit durable choice.
- Treating scope filtering, the gateway, or the console worker as a hostile-code security boundary.
- Normalizing reasoning-token accounting beyond what the gateway reports.
- Polling generation metadata, reconciling delayed cost, or making cost limits strict when a response does not contain cost.
- Implementing formal provider tool contracts; that later plan extends the dispatch and adapter delivered here.



## Terms

- **Gateway:** the Vercel AI Gateway protocol, hosted by default at `ai-gateway.vercel.sh` and replaceable only through the explicit trusted-local origin override.
- **AI SDK:** the latest stable compatible Vercel AI SDK (`ai` package, version 7 line) plus `@ai-sdk/gateway`, `@ai-sdk/openai`, and `@ai-sdk/anthropic`, resolved at implementation time and pinned exactly.
- **Transport:** the durable `ModelConfiguration.provider` value a session executes through — `vercel` (gateway), `openai` (direct), or `anthropic` (direct) — all implemented by the shared AI SDK adapter core.
- **Canonical model ID:** the gateway catalog's namespaced `creator/model` identifier stored in `ModelConfiguration.model` on every product transport.
- **Requested effort:** the user-facing level retained in `ModelConfiguration.reasoningEffort`.
- **Provider default:** an explicit choice to omit Agencity's reasoning control and let the gateway, provider, and model choose their default behavior.
- **Listed capability:** the catalog's `reasoning_options` enumerates an exact selectable SDK effort set for the model after documented toggle normalization.
- **Unverified capability:** the model carries the catalog `reasoning` tag (or is absent from the catalog entirely) but has no exact level enumeration; standard levels are offered with an unverified label, and execution may coerce, ignore, or reject the requested level.
- **Reasoning dispatch:** the immutable record of the resolved effort decision committed before a model effect.
- **Model dispatch:** the immutable complete model configuration, reasoning dispatch, and execution endpoint identity used by one call or pinned compaction.
- **Catalog cache:** a non-canonical, replaceable profile record of normalized catalog entries used for offline listing and bounded discovery traffic.



## Product semantics



### Canonical effort vocabulary

```ts
type ReasoningEffort =
  | "provider-default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
```

`provider-default` means Agencity omits all reasoning controls. All other levels are sent as the AI SDK's documented top-level `reasoning` value. Catalog-only values outside that vocabulary, including `max`, remain visible in diagnostics but are unavailable for selection.

Input aliases are presentation-only: `default` becomes `provider-default`; `off` becomes `none`. Events, preferences, protocol responses, and SDK values use canonical names only.

### Default behavior

The default is `provider-default`. This avoids an unannounced cost or latency change and keeps new models usable before their metadata is complete. Input boundaries may omit the setting, but normalization always writes an explicit canonical value into new durable model configurations.

### Capability tiers and selection rules

Selection behavior depends on what the catalog knows about the model:

1. **Listed** (`reasoning_options` enumerates an effort set): the selector offers recognized documented SDK levels from the effort set plus `none` when the same entry advertises a reasoning toggle, then adds `provider-default`. An explicit level outside the normalized listed set fails at selection time with the listed alternatives named. No model call is made.
2. **Unverified** (catalog `reasoning` tag present but `reasoning_options` is `null`, or the model is absent from the catalog, as with manual entry): the selector offers the standard SDK levels (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) labeled **unverified**. The SDK or provider may coerce or ignore the level with a warning, or reject the request for that model. Warnings are recorded as call provenance and surfaced once in the run status; a provider rejection is a normal failed model effect. Agencity itself never substitutes a different level.
3. **Unsupported** (catalog entry exists and has no `reasoning` tag): only `provider-default` is selectable. An explicit level fails at selection time with a clear message, because the SDK would silently ignore the parameter on every transport and the stored setting would be a lie. A catalog refresh is offered in the same message since tags can be stale.

This is deliberately less strict than reject-everything-unproven and more honest than accept-everything-silently: exact data gates exactly, missing data degrades to labeled normalized behavior, and explicit contradiction with catalog data fails truthfully.

### Effort is model-specific

Workspace default efforts are keyed by the normalized catalog endpoint identity and canonical model ID, not stored as one global effort. Preferences are transport-independent: the effort stored for `openai/gpt-5.2` applies whether the model runs through the gateway or the direct OpenAI transport, because the capability data is the same catalog entry. Changing models or catalog origins does not carry an old effort implicitly.

Selection order for a new root session:

1. explicit `--effort`;
2. the workspace preference for the selected model;
3. `provider-default`.

There is deliberately no environment-variable effort control in the first release; per-model preferences plus `--effort` cover the automation cases, and an ambient environment variable would apply one level across models with different supported sets.

**Ambient defaults never hard-fail session creation.** If a stored workspace preference is no longer valid for the model (for example, the catalog's listed set changed), the session is created with `provider-default` and a visible notice; the stale preference is left intact for the user to inspect or clear. Explicit `--effort` and explicit interactive selection do fail with guidance when invalid, because the user is present in the decision.

Existing branches ignore changes to defaults. Changing a branch's effort requires an explicit model-configuration change.

### Inheritance

- When `sdk.agents.spawn`, `rlm.start`, or their batch forms omit `model`, the child receives the exact parent `ModelConfiguration`, including effort.
- When a caller supplies explicit model-configuration input, it passes through the same normalization and validation as a root selection (closing the current gap where child configurations skip `normalizeModelConfiguration`), and the existing child policy still requires the parent's provider/model. A missing effort in input means `provider-default`; workspace preferences are never injected into model-generated child or recursive calls.
- Stable child or recursive idempotency retries reuse the already retained complete model configuration byte-for-byte.
- Schedules, heartbeats, resumed runs, and retained follow-up use their session's committed configuration and do not re-read workspace preferences.
- No separate delegated effort ceiling is added. An explicit child configuration may select any validated effort for the same provider/model; this is intentional and is covered by delegation authority and budget tests. Omitted configurations continue to inherit the exact parent effort.



## Domain contracts



### Durable model configuration

```ts
interface ModelConfiguration {
  readonly provider: string;          // transport: "vercel", "openai", or "anthropic"
  readonly model: string;             // canonical creator/model catalog ID on every transport
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort: ReasoningEffort;
}
```

Durable configurations always retain the canonical value explicitly, including `provider-default`. User, protocol, and generated SDK input types may omit the field; `normalizeModelConfiguration` accepts that input shape and returns a complete `ModelConfiguration` with `provider-default` supplied before any model-bearing event is appended.

`normalizeModelConfiguration` must: normalize provider and model identity as today; canonicalize effort aliases at input boundaries; reject unknown effort strings; reject a direct-transport configuration whose model creator prefix disagrees with its provider (`provider: "openai"` requires an `openai/…` model and `provider: "anthropic"` an `anthropic/…` model, while the gateway accepts any creator); validate numeric settings; and leave capability checks to the catalog-backed resolver. The same command-level validation must be injected into `AgentService` and applied to direct/batch spawn, recursive starts, subagent specifications, and refinement-review child creation before any model-bearing event is appended.

### Model descriptor

One normalized descriptor type, populated from the gateway catalog:

```ts
interface ModelDescriptor {
  readonly model: string;                       // canonical creator/model ID
  readonly displayName: string;
  readonly contextWindowTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly pricing: { readonly inputUsdPerToken: number; readonly outputUsdPerToken: number } | null;
  readonly reasoning: {
    readonly status: "listed" | "unverified" | "unsupported";
    readonly levels: readonly Exclude<ReasoningEffort, "provider-default">[]; // exact when listed, standard set when unverified, empty when unsupported
  };
  readonly catalogDigest: string;               // sha256 of the normalized entry; stable across identical fetches
  readonly catalogEndpointId: string;           // digest of the normalized catalog origin
  readonly stale: boolean;                      // cache entry past its freshness window
}
```

There is no multi-source provenance merging: the gateway catalog is the only source, so per-field evidence reduces to the endpoint identity, entry digest, and presentation-time staleness. Descriptors are transport-independent: the same entry informs selection and dispatch on the gateway and on the direct transports. Models absent from the catalog (manual entry) get a synthesized descriptor with `status: "unverified"` and `catalogDigest` of the synthesized entry.

### Immutable model dispatch

Resolved from the committed branch configuration and the current descriptor before any model effect:

```ts
interface ReasoningDispatch {
  readonly requestedEffort: ReasoningEffort;
  readonly mode: "omitted" | "requested";       // omitted ⇔ provider-default
  readonly capability: {
    readonly status: "listed" | "unverified" | "unsupported";
    readonly levels: readonly Exclude<ReasoningEffort, "provider-default">[];
    readonly catalogDigest: string;
  };
  readonly resolverId: "agencity.reasoning-dispatch.v1";
}

interface ModelDispatch {
  readonly configuration: ModelConfiguration;
  readonly reasoning: ReasoningDispatch;
  readonly executionEndpointId?: string;        // required for product transports; digest of the normalized execution origin
  readonly dispatchVersion: "agencity.model-dispatch.v1";
}
```

Rules:

- The dispatch contains **no timestamps, staleness flags, or other volatile fields**. Catalog fetch times and cache staleness remain presentation metadata, so byte-identical dispatch comparison is stable across recovery and retries.
- The complete dispatch is included as a required `modelDispatch` field in `ModelCallRequested` and in `EffectRequested.input`. The executor reads configuration and reasoning only from that dispatch, passes `reasoning: requestedEffort` to the AI SDK when `mode` is `"requested"`, and omits the option when `"omitted"`.
- The model-call admission command validates the relation between `ModelCallRequested` and its eventual `EffectRequested`: `callId`, `effectId`, complete configuration, execution endpoint identity, and reasoning dispatch must agree byte-for-byte. Compaction effects must agree with the pinned dispatch on `ContextCompactionRequested`. A malformed or mismatched relation fails before network access.
- The dispatch is part of idempotency agreement: reusing a model-call, compaction, or effect idempotency key with a different dispatch is a conflict.
- Before a pending product-model effect executes, the executor compares the retained `executionEndpointId` with the current normalized execution origin for the configured transport (the gateway origin for `vercel`; the official or overridden provider origin for a direct transport). Configuration drift produces a typed unavailable outcome instead of sending a request to a different endpoint.
- A model effect without a complete dispatch is malformed and fails before network access.



### Pre-release schema and data cutover

This plan intentionally does not migrate pre-feature workspace events, snapshots, profile rows, cached preferences, subagent specifications, pending effects, or model identifiers. Development installations reset their local Agencity state before running this version. The runtime must detect an incompatible store and return clear reset guidance; it must not silently delete data.

The cutover:

- sets `EVENT_SCHEMA_VERSION` to `2` and accepts only version 2;
- requires `reasoningEffort` in every durable `ModelConfiguration`;
- requires `modelDispatch` in `ModelCallRequested` and in `ContextCompactionRequested` when the strategy is `model-summary-v1`; deterministic compaction requests omit it;
- permits optional bounded `warnings` in `ModelCallCompleted`, because a successful call can have no warnings;
- sets `REDUCER_VERSION` to `8` for the model-call projection change; and
- replaces pre-feature compatibility fixtures with fresh-version replay, rebuild, branch, sync, export, and projection fixtures.

Implementation updates `AGENTS.md`, public data-lifecycle documentation, installation guidance, and verification claims to state this pre-release reset boundary.

## Model catalog service



### Single source, cached

Add a `ModelCatalog` service under the model execution boundary:

- Treats `AI_GATEWAY_BASE_URL` as an origin-only URL. It rejects credentials, query strings, fragments, and non-root paths; removes a trailing slash; derives `${gatewayOrigin}/v1/models` for discovery and `${gatewayOrigin}/v4/ai` for the AI SDK model API.
- Fetches the derived catalog URL with explicit timeout, response-size limit, model-count limit, field-length and numeric bounds, duplicate-ID rejection, and schema validation. Unknown fields are discarded. Errors never expose response bodies.
- Normalizes entries into `ModelDescriptor` values. A `reasoning_options` effort entry contributes only recognized documented SDK values; a toggle adds `none`; catalog-only values such as `max` are retained only in bounded diagnostics. An effort entry with at least one selectable value yields `"listed"`. Toggle-only, budget-only, a `reasoning` tag without selectable effort metadata, or `reasoning_options: null` yields `"unverified"`. No `reasoning` tag yields `"unsupported"`.
- Filters to `type: "language"` models for the product picker.
- The endpoint requires no credential; if a future change puts it behind auth, use the stored gateway key supervisor-side. Catalog responses never carry credentials.

Custom `AI_GATEWAY_BASE_URL` values are trusted-local endpoints. Catalog data fetched from an override is keyed to that exact normalized endpoint identity and is not merged with official-endpoint data.

Catalog metadata is transport-independent, and catalog fetches never send any provider credential. Direct transports execute against their official origins by default; `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` are origin-only trusted-local execution overrides with the same normalization rules, used chiefly by test fixtures. Execution overrides never change the catalog origin, which is controlled only by `AI_GATEWAY_BASE_URL`.

### Profile cache and migration ledger

Add a profile-local `model_catalog_cache` operational table keyed by the normalized endpoint identity digest, storing bounded normalized descriptors, revision metadata, fetch time, expiry, and schema version.

`ProfileStore` currently applies an inline schema string. **Before adding the table, introduce a separate `profile_schema_migrations` ledger** with immutable numbered profile migration sources. Because old profile data is outside the cutover boundary, the baseline targets only a fresh profile: one migration creates the current profile schema and a later migration adds `model_catalog_cache`. Each migration runs under one write transaction and is recorded only after every statement succeeds. Concurrent/repeated opens must either observe the committed migration or serialize behind it; a partial migration is never marked complete.

Extend `scripts/check-architecture.ts` with a profile-migration inventory separate from workspace migrations. Extend `docs/mutable-tables.md` with profile-table classifications for the migration ledger and operational catalog cache.

The cache: contains no credentials or raw responses; is not canonical; is safe to delete and rebuild; is not synchronized through workspace envelopes; is excluded from profile export; is deleted with the owning profile; defaults to a 24-hour freshness window; and supports explicit refresh from the model picker, `/effort refresh`, and the protocol. Stale entries remain usable and visibly labeled. Staleness is not part of the immutable dispatch and never causes Agencity to choose a different level.

### Context-window capacity integration

The catalog's `context_window` and `max_tokens` feed a model-keyed capacity resolver, replacing today's one-static-window-per-provider lookup for all product transports. `ModelCatalog` hydrates a bounded in-memory descriptor snapshot from the profile cache before execution recovery; refresh atomically swaps that snapshot. `ModelExecutor.contextCapacity(configuration)` remains synchronous but delegates product model configurations on any transport to the model-keyed snapshot and returns `"unknown"` when that exact catalog endpoint/model has no descriptor. It never mutates one provider-wide capacity from the last model fetched. Echo and programmatic providers continue using their declared provider capabilities and do not inherit catalog metadata.

This is a **deliberate behavior change**: context-window admission and compaction triggers begin operating on real per-model capacity values for catalog-listed models on every transport. Add tests with two catalog models with different windows in one process (covering both a gateway and a direct-transport session) plus admission and automatic compaction before and after capacity becomes known. Capacity provenance flows through the existing `ContextCapacityProvenance` mechanism unchanged.

## Execution



### The shared AI SDK adapter core and transport factories

Replace `OpenAICompatibleProvider`, `AnthropicCompatibleProvider`, and the Anthropic-instantiated `vercel` provider with one shared `AiSdkModelProvider` core implementing the existing `ModelProvider` contract, instantiated by three thin transport factories:

- **`vercel`** — the pinned SDK's documented `createGateway` API with the derived `${gatewayOrigin}/v4/ai` model API base URL (never the origin-only override directly) and the gateway credential; passes canonical `creator/model` IDs through unchanged and accepts any creator.
- **`openai`** — `createOpenAI` with the OpenAI credential and the official or overridden origin; requires an `openai/…` canonical ID and derives the native ID by stripping the creator prefix.
- **`anthropic`** — `createAnthropic` with the Anthropic credential and the official or overridden origin; requires an `anthropic/…` canonical ID and derives the native ID by stripping the creator prefix and replacing dots with dashes in the version segment.

A factory contributes instantiation only: model construction, credential resolution, execution endpoint identity, and native-ID derivation. Every request behavior lives once in the shared core:
- `complete` uses `generateText`; `stream` uses `streamText`. One shared pure options builder serves both, so model, temperature, maximum output, and reasoning options cannot diverge.
- Streaming consumes the SDK's authoritative full stream. Only text deltas reach the existing provisional `onDelta` callback; reasoning and protocol parts do not. The adapter awaits final text, finish reason, usage, warnings, and gateway metadata. Any stream error, cancellation, malformed terminal data, or incomplete termination fails the effect, and no provisional prefix becomes durable.
- While a high-effort model produces no text, the existing model-working run status remains visible. Reasoning content is never relayed as progress; a dedicated reasoning-progress indicator is deferred.
- The dispatch's `requestedEffort` maps to the SDK's top-level `reasoning` option (`mode: "omitted"` omits it). No reasoning-related `providerOptions` are set, and catalog-only `max` is unavailable.
- **Reasoning content is never persisted.** Reasoning parts in SDK responses and streams are discarded; only final text enters `ModelResponse.text`, committed messages, and cursorless progress. This feature controls effort, not chain-of-thought storage.
- **Warnings are provenance.** SDK warnings are converted at the adapter boundary into a stable internal `ModelWarning` shape with kind (`coerced`, `unsupported`, `provider`, or `truncated`) and bounded scrubbed message. Retain at most eight warnings of at most 1,024 UTF-8 bytes each. They remain in the effect outcome and are copied to optional `ModelCallCompleted.warnings` for ordinary calls, visible in `/raw`, and surfaced once by committed event identity. They never mutate branch configuration.
- **Usage and cost:** token usage maps from the completed SDK result. A directly returned finite nonnegative gateway cost populates `Usage.costUsd`; missing or malformed cost becomes `0`, and direct transports always record `0`. The adapter does not call generation lookup. Provider-reported reasoning tokens are debited once inside total output usage, as today.
- **Errors are bounded and classified.** Convert SDK failures into a closed internal classification without retaining raw response bodies, headers, prompts, or provider payloads. Only a positively identified context-limit error becomes `ModelProviderContextWindowOverflowError`; authentication, rate limit, routing, malformed-response, and generic transport failures never trigger overflow retry.
- Each transport's credential resolves through the existing supervisor-side credential store and environment fallbacks (`AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) and is passed to the SDK per call. A credential is used only by its own transport and never enters events, cache rows, logs, or errors.
- Resolve the latest stable compatible `ai`, `@ai-sdk/gateway`, `@ai-sdk/openai`, and `@ai-sdk/anthropic` packages at implementation start and pin their exact versions in `package.json` and the lockfile. Record the versions in fixture provenance. AI SDK types must not leak through the `ModelProvider` contract or into domain/storage code.

Echo remains unchanged behind the same contract. Extend provider capabilities with an explicit internal reasoning-control declaration (`"none"` or `"normalized"`). Programmatic provider registration remains supported for tests and trusted integrations; absent capability means `"none"` and permits only `provider-default`. All three product transports declare `"normalized"`. Catalog fallback never grants reasoning control to an unrelated custom provider.

### Providers, onboarding, and data cutover

- Product provider selection offers `vercel` (recommended and listed first), `openai`, and `anthropic`. The existing three-provider onboarding, hidden credential entry, and environment fallbacks are retained. What changes: the hand-written wire adapters behind these providers are deleted; model selection and manual entry use canonical `creator/model` IDs on every transport; and the picker filters the catalog to the transport's creator namespace for direct providers while the gateway shows all listed models.
- The credential store's recognized provider keys are unchanged. Credential-file reads and writes preserve unknown or historical records byte-for-byte at their logical field values; this plan deletes no credential. `docs/configuration.md` documents the credential and override environment variables per transport.
- Product state created before this cutover is unsupported and must be reset by the operator. There is no branch, profile-preference, pending-effect, or retained-subagent-spec canonicalization path. New model selections always write canonical `creator/model` IDs.



## Execution paths, attribution, and recovery

Model dispatch resolution happens after context-window admission and before `ModelCallRequested`/`EffectRequested` are appended:

1. **Agent runs and diagnostic turns:** read the retained branch configuration → resolve and validate the complete dispatch → append `ModelCallRequested` with that dispatch → request the outbox effect with the byte-identical dispatch → validate the call/effect relation → execute from the outbox input only → retain normal response, usage, warnings, budget, and terminal outcome events.
2. **Model-summary compaction:** resolve the complete dispatch **once per compaction request** and pin it in `ContextCompactionRequested.modelDispatch`. Every chunk effect across all hierarchy levels uses that exact model configuration, endpoint identity, and reasoning dispatch, even if the branch model or catalog changes while compaction runs. Recovery also uses the pinned dispatch.
3. **Generated console code:** generic `tools.request` may not address the reserved `model` executor. Recursive calls continue through `rlm` and child-session services, which perform normal model admission. A direct generic model request fails before `EffectRequested` is appended.

Recovery does not: query the catalog to reinterpret a committed effect; apply a refreshed catalog to a pending dispatch; downgrade a level; or retry a non-idempotent unknown model effect. Specifically:

- A crash after `ModelCallRequested` but before the effect request: recovery copies that call's retained complete dispatch into the new `EffectRequested` input without re-resolving.
- A pending first-attempt effect drains from its committed input; a started non-idempotent effect with no durable outcome becomes `unknown` under existing outbox rules.
- Context-window overflow retries reuse the exact prior complete dispatch byte-for-byte under a new call/effect identity; only context and context-window provenance change. Compaction cannot change model settings.
- Console-worker restarts do not affect effort; the setting lives in durable state only.

If the gateway or a direct provider rejects a retained request (for example, capabilities changed after selection), that is a normal failed model effect with model/effort context. Agencity does not change the branch configuration, retry at another level, or reroute to another transport.

## Selection, protocol, and SDK



### Supervisor

`Supervisor.createSession` and `Supervisor.selectModel` normalize the complete configuration and apply the capability tier rules against the current descriptor. Changing only effort is a model-configuration change: it uses the same active-work guard as `/model`, and `SessionModelChanged` retains the previous and next complete configurations, so a same-model effort change is explicit and attributable without a new event type.

### Public protocol

Additive changes; `agencity.protocol` stays version 1 with capability negotiation:

- `GET /capabilities` advertises `reasoningEffortSelection: true`;
- `POST /sessions/:session/model?branch=…` accepts `reasoningEffort` in the configuration;
- `GET /model-catalog` returns bounded normalized descriptors plus cache staleness; `POST /model-catalog/refresh` refreshes and returns the cached fallback with a typed refresh status on remote failure;
- `GET /product/config` includes the current catalog endpoint identity, the per-transport execution origins, and the selected model's workspace effort preference; `POST /product/config/reasoning-effort` sets or clears `{ model, effort }` for the server's current catalog endpoint identity.

A client must not send explicit effort to a server whose capabilities omit `reasoningEffortSelection`; it fails with a typed unavailable error instead of letting an older server silently strip the field. Add a shared `AgentClient.requireCapability("reasoningEffortSelection")` guard backed by the validated attach-time capability snapshot and use it in every effort-bearing model/configuration method. TUI and CLI commands call those guarded methods rather than posting raw configurations. Managed and in-process transports return identical types and errors; clients never parse raw catalog responses.

### Console SDK

The `ModelConfiguration` extension flows through `sdk.agents` and `rlm` inputs; generated declarations document the canonical values. The console cannot change the current root session's effort; root selection remains a user/protocol operation.

## Product interfaces



### Terminal commands

- `/effort` — open the effort selector for the current model;
- `/effort LEVEL` — select one canonical level;
- `/effort refresh` — refresh the current endpoint's catalog, then redisplay metadata for the current model;
- `/thinking`, `/thinking LEVEL`, `/thinking refresh` — exact aliases.

The selector shows the current model, current effort, the listed/unverified/unsupported tier with its levels, staleness, and a one-line explanation for unavailable control. `provider-default` is always first. Unavailable levels cannot receive focus. Selecting the current level is a no-op. Historical-projection and active-work guards match `/model`.

The model picker is enriched from the catalog: display names, context window, pricing, and a reasoning badge — `effort` (listed), `effort (unverified)`, or `fixed` (unsupported). Manual model entry remains available when the catalog is unavailable or a model is missing; manual entries behave as unverified.

After selection, the transcript reports model and effort. `/info`, `/model`, the header when width permits, and plain non-TTY output show the effective value. Raw capability data and recorded warnings remain available through `/raw` and protocol diagnostics.

### CLI and configuration

- `--effort LEVEL` for newly created work; on a resumed branch the ordinary entrypoint fails with guidance to use `agencity new --effort …` or `/effort` on an idle branch (matching `--model` behavior);
- `agencity config set-effort LEVEL [--model MODEL]` and `agencity config clear-effort [--model MODEL]`; when `--model` is omitted the current workspace default model is required, and configuration fails clearly when none resolves.

JSON output includes canonical effort, capability tier, levels, staleness, and recorded warnings as typed fields.

## Validation and failure behavior

Reject before a model configuration commits:

- unknown effort strings (after alias canonicalization);
- an explicit level outside a listed set (message names the listed levels);
- an explicit level for a catalog-unsupported model (message offers refresh and `provider-default`).

Never rejected: `provider-default` (always available); any standard level on an unverified model (labeled, warning-recording).

Ambient workspace preferences that fail these rules at session creation degrade to `provider-default` with a visible notice rather than blocking session creation.

Catalog unavailability does not make a retained session disappear or block execution; the UI presents cached data when available and otherwise marks capability unverified. Selection remains possible; execution proceeds with the resolved dispatch.

## Security and data classification

- Provider API keys (gateway, OpenAI, Anthropic) remain in the owner-only credential store or environment; each is passed to the AI SDK per call supervisor-side, is used only by its own transport, and never enters events, cache rows, sync envelopes, logs, protocol output, or error messages.
- Network paths are per transport: with the `vercel` transport, **all model traffic for that session — prompts, context, and generated text — transits Vercel's AI Gateway**; with a direct transport it goes to that provider's API. State this plainly in `docs/security.md`. Note the gateway's prompt-training opt-out setting as operator guidance.
- Catalog responses are bounded, schema-validated, secret-free, and excluded from errors and canonical history.
- `model_catalog_cache` is a mutable operational profile cache; its migration and classification are architecture-checked.
- Selected effort is canonical (it changes model behavior). The complete model dispatch is canonical provenance. Recorded warnings are bounded effect-outcome data.
- Custom `AI_GATEWAY_BASE_URL`, `OPENAI_BASE_URL`, and `ANTHROPIC_BASE_URL` values replace the corresponding official origin as the trusted-local network destination for that transport and receive that transport's credential and model traffic. The public catalog request omits credentials unless a future authenticated-catalog contract is explicitly implemented.

Update `docs/mutable-tables.md` for the cache classification and `docs/security.md` for the transit and credential statements.

## Implementation sequence

### 0. Pin the SDK and wire contract

- Recheck the package registry and official AI SDK 7 documentation; install the latest stable compatible `ai`, `@ai-sdk/gateway`, `@ai-sdk/openai`, and `@ai-sdk/anthropic` versions and pin them exactly.
- Record the resolved package versions and capture the documented `createGateway`/`createOpenAI`/`createAnthropic` APIs, the `/v4/ai` and `/v1/models` gateway endpoints, the native OpenAI and Anthropic wire shapes the pinned packages emit, and the streaming, warning, usage, and provider-metadata shapes in focused fixture tests before replacing the current adapters.
- Keep `max` unavailable and cost best-effort regardless of undocumented or eventually consistent fields.



### 1. Domain vocabulary and schema cutover

- Add `ReasoningEffort`, validators, alias canonicalization at input boundaries, and an `effectiveReasoningEffort` helper.
- Add the complete `ModelDispatch`, stable bounded `ModelWarning`, and call/effect relation validators.
- Extend `ModelConfiguration`, the four model-bearing event schemas, `ModelCallRequested`, `ModelCallCompleted`, `ContextCompactionRequested`, and every embedded model validator (including refinement-review subagent specifications) with the new required configuration and conditionally required dispatch fields.
- Set `EVENT_SCHEMA_VERSION` to `2` and `REDUCER_VERSION` to `8`; extend the model-call projection and diagnostic views with reasoning provenance.
- Add incompatible-store detection with explicit reset guidance, then recreate replay, rebuild, branch, sync, export, and projection fixtures at the new schema version.



### 2. Profile migration ledger and model catalog

- Introduce the transactional `profile_schema_migrations` ledger, fresh-profile baseline/bootstrap, cache migration, concurrent/reopen coverage, and separate profile architecture inventory.
- Implement the `ModelCatalog` fetch/normalize/cache service with the descriptor model, staleness, refresh, endpoint-identity keying, and deletion behavior.
- Wire catalog `context_window`/`max_tokens` through the model-keyed in-memory capacity resolver as the `"model-catalog"` source, with multi-model, before/after admission, and compaction-trigger tests.



### 3. AI SDK adapter core, transport factories, and product model identities

- Implement the shared `AiSdkModelProvider` core with the shared options builder, authoritative stream consumption, reasoning-part discard, warning capture, gateway-cost-or-zero mapping, and bounded typed error mapping; instantiate it through the `vercel`, `openai`, and `anthropic` factories with derived base URLs, per-transport credentials, execution endpoint identities, and native-ID derivation.
- Delete the hand-written OpenAI and Anthropic HTTP adapters and the SSE parser; keep the `ModelProvider` contract, Echo, and programmatic registration.
- Move onboarding, the picker, and manual entry to canonical `creator/model` IDs on every transport.



### 4. Dispatch resolution, recovery, and inheritance

- Add the pure complete-dispatch resolver; wire it into agent runs, diagnostic turns, and compaction.
- Reserve the model executor from generic `tools.request`; retain recursive model access through admitted `rlm` and child-session services.
- Enforce dispatch presence, endpoint identity, and call/effect/compaction relation equality before execution; implement recovery copy semantics and byte-identical overflow-retry reuse.
- Pin the complete model configuration and reasoning decision once per compaction request so every hierarchy chunk and recovery step uses identical settings.
- Route all model-bearing commands (root, select, spawn, batch, recursive, subagent specs, refinement children) through shared normalization and tier validation; verify inheritance and idempotent-retry payload agreement.



### 5. Protocol, TUI, and CLI

- Extend capabilities, model selection, catalog, and product-config routes plus `AgentClient` methods with capability negotiation.
- Add `/effort`, `/thinking`, the selector, refresh, picker enrichment, and status surfaces.
- Add `--effort` and the `config set-effort`/`clear-effort` commands with typed JSON output.



### 6. Documentation and release evidence

- Update public API, console SDK, protocol, configuration, user-guide, architecture, data-lifecycle, installation, security, mutable-table, and verification documents; document the pre-release reset boundary; update `AGENTS.md` status and event-evolution policy (AI SDK-only execution across the gateway and direct transports, canonical model IDs, reasoning effort, and unsupported pre-cutover state) only after the user-visible path is implemented and verified.
- Run the full deterministic suite; report external rows separately as pass, fail, or skip.



## Test strategy



### Fixture strategy

Black-box and integration tests exercise every transport against **local fixture servers** reached through the origin-only overrides: a gateway fixture serving the pinned SDK's derived `/v4/ai` completion/streaming API plus the `/v1/models` catalog API behind `AI_GATEWAY_BASE_URL`; an OpenAI fixture serving the native wire API the pinned `@ai-sdk/openai` emits behind `OPENAI_BASE_URL`; and an Anthropic fixture serving the native wire API the pinned `@ai-sdk/anthropic` emits behind `ANTHROPIC_BASE_URL`. Fixtures assert authentication boundaries plus exact received model IDs and reasoning payloads. The implementer derives each fixture by recording the pinned package's requests against a local listener. Unit-level injected SDK/provider tests cover warning normalization and error classification that a wire fixture cannot reliably induce. Re-record fixtures on any SDK package bump.

### Domain and replay

- Every new-version configuration contains a canonical effort; every canonical effort validates; invalid strings fail.
- Model dispatch provenance round-trips through storage, snapshots, sync envelopes, export, and rebuild; model-summary compaction requires it and deterministic compaction omits it.
- Duplicate events are no-ops; conflicting idempotency payloads and mismatched call/effect/compaction dispatch relations fail.
- Branch forks retain the effort visible at the fork cursor; a same-model effort change retains correct previous/next configurations.
- Pre-cutover stores fail with reset guidance; the runtime never silently deletes them.



### Catalog

- Sanitized fixtures cover valid, missing, malformed, oversized, unknown-field, and `reasoning_options: null` responses (including a flagship-model null case).
- Listed levels come from recognized effort entries, with `toggle` adding `none`; `max` and other undocumented values remain diagnostic-only; toggle-only, budget-only, and tag-without-selectable-options yield unverified; tag-absent yields unsupported.
- Only `type: "language"` descriptors appear in the product picker; other catalog types remain unavailable.
- Cache hit, expiry, refresh failure with cached fallback, stale labeling, endpoint-identity separation, reopen idempotency, and profile-deletion behavior are deterministic.
- Two catalog models with different capacities resolve independently in one process, on gateway and direct transports alike; refresh swaps the in-memory snapshot atomically.
- Custom base-URL catalog data never merges with official-endpoint data.
- No secret appears in cache bytes, events, errors, logs, snapshots, or protocol responses.



### Adapter

- Exact wire payloads are asserted on all three transports for every level and `provider-default`, including the exact native model ID each direct fixture receives; streaming and non-streaming options agree.
- Native-ID derivation covers dotted Anthropic versions, dotless models passing through unchanged, and verbatim OpenAI suffixes; a direct transport rejects a canonical ID whose creator disagrees with its provider before any network request.
- Each transport sends only its own credential to its own origin; direct-transport calls record `Usage.costUsd` of `0`.
- Rejected selections (unlisted level on a listed model; any level on an unsupported model) make zero network requests.
- An unverified selection may reach the provider; provider rejection fails the effect without changing effort, retrying at another level, or rerouting.
- Reasoning parts never enter committed messages or provisional output; warnings are captured, scrubbed, bounded, retained, and surfaced once by committed event identity.
- Directly returned cost populates `Usage.costUsd`; absent or malformed cost records `0`; no generation lookup occurs.
- A stream error after text deltas, malformed terminal data, or cancellation commits no text prefix. True context overflow maps to the typed overflow error; false-positive response text, authentication, rate limit, routing, and generic failures do not.
- Echo and programmatic providers still satisfy the contract; programmatic providers without reasoning support work with `provider-default` only.



### Runtime and recovery

- Agent runs and diagnostic turns produce identical dispatch semantics; compaction pins one complete dispatch per request and all chunks reuse its model, endpoint, and effort across branch-model changes, catalog refresh, and recovery.
- Crash after `ModelCallRequested`/before effect request copies the retained dispatch without re-resolution; pending first attempts drain from committed input; non-idempotent interruption preserves unknown-outcome behavior; endpoint drift blocks rather than reroutes a pending effect.
- A model effect without a complete dispatch fails before network access.
- Generic `tools.request` cannot address the model executor; admitted `rlm` and child paths still work.
- Overflow retries reuse the complete dispatch byte-for-byte; effort changes are refused during active work; console-worker restarts do not affect effort.
- Parent, direct/batch child, recursive, subagent-spec, refinement-child, schedule, heartbeat, and follow-up paths retain intended configurations; explicit same-model child effort changes follow the documented no-ceiling policy.
- Saving or removing any provider credential never removes or rewrites other credential records.



### Protocol and product UI

- HTTP and in-process clients expose identical catalog, selection, and error behavior; clients refuse explicit effort against servers lacking the capability flag.
- `/effort` and `/thinking` are exact aliases; the selector covers listed, unverified, unsupported, and stale states; ambient-preference degradation shows its notice.
- Historical mode, active-run guards, modal ownership, resize, compact height, and non-TTY output are covered; manual entry works without the catalog; JSON output uses stable typed fields.



### Black-box acceptance

The linked-executable matrix must prove:

1. a fresh repository selects the gateway fixture model and an explicit effort without internal IDs;
2. the fixture receives the exact SDK payload including the `reasoning` value;
3. a completed run retains call-level complete model dispatch provenance;
4. detach, service recovery, and resume preserve branch effort;
5. child and recursive work inherit the effort;
6. `/effort` changes an idle branch and a later call uses the new value;
7. an unlisted level and an unsupported model fail truthfully with zero model requests;
8. an unverified model accepts a standard level and retains the recorded coercion warning when the fixture emits one;
9. a pre-cutover database fails with explicit reset guidance and is never silently deleted;
10. a direct-transport session (OpenAI or Anthropic fixture) selects an explicit effort without internal IDs, its native fixture receives the exact derived model ID and reasoning payload, and the run retains the same dispatch provenance as the gateway path.

A credential-gated real-gateway smoke row (real `AI_GATEWAY_API_KEY`, real namespaced model, explicit effort) is additional evidence, explicitly opt-in, and reported as skipped when credentials are absent. Real direct-transport smoke rows are equally opt-in behind `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` and reported as skipped when absent. Cost may be a returned nonnegative value or the documented `0` fallback and is not a pass condition.

## Acceptance criteria

- A user can inspect and change effort through the documented terminal and CLI paths, with levels sourced from the gateway catalog.
- All product model execution flows through the shared AI SDK adapter core and its `vercel`, `openai`, and `anthropic` transport factories; the hand-written wire adapters are removed; Echo and programmatic registration still work.
- Pre-cutover workspace and profile state is unsupported, fails with explicit reset guidance, and is never silently deleted.
- Direct transports exhibit the same effort vocabulary, capability tiers, dispatch, warning, and recovery behavior as the gateway, differing only in credential, execution endpoint, and native model ID.
- Every admitted model call retains its exact immutable complete model dispatch; recovery, compaction, and overflow retries never reinterpret its configuration or reasoning.
- Coercion and unsupported warnings are recorded and visible; Agencity never substitutes a level itself.
- `Usage.costUsd` preserves directly returned gateway cost and otherwise remains `0` (always `0` on direct transports); exact delayed cost accounting is not claimed. Model-keyed catalog capacity feeds context-window admission with tested behavior.
- Unlisted and unsupported selections fail truthfully with no model request; unverified selections are labeled.
- Provider keys and raw catalog responses never enter durable or user-visible state.
- The installed black-box path and the full deterministic suite pass; public docs and `AGENTS.md` describe AI SDK-only execution, the per-transport network boundaries, and remaining limits.



## Explicit deferrals

- Additional AI SDK transports (Google, xAI, Amazon Bedrock, and others) and any transport-fallback or routing policy.
- Gateway BYOK, provider routing controls (`order`/`only`), and gateway automatic caching.
- A user-specified integer thinking-token budget (`reasoning_options` `budget_tokens` entries are ignored in this release).
- Environment-variable effort control.
- Per-task automatic effort selection; a delegated maximum-effort policy.
- Provider reasoning summaries and hidden-reasoning display.
- A normalized cross-provider `reasoningTokens` usage field.
- Embeddings, image, and other non-language gateway model types in the product picker.
- Catalog-only reasoning levels outside the documented AI SDK top-level vocabulary, including `max`.
- Delayed generation lookup, exact cost reconciliation, and strict cost-budget enforcement when the completed response omits cost.
- Migration or compatibility support for pre-cutover workspace, profile, branch, effect, subagent-specification, or event data.
- A dedicated reasoning-progress indicator beyond the existing model-working run status.

# Reasoning effort and model capabilities plan

**Status:** Ready for implementation  
**Date:** August 7, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related terminal work:** [Rich terminal rendering and layout](./2026-08-07-rich-terminal-rendering-and-layout-plan.md)

## Summary

Agencity lets a user select a provider and model, but `ModelConfiguration` has no reasoning setting and the provider adapters never send reasoning parameters. A user cannot choose how much reasoning a supported model performs.

This plan delivers reasoning-effort selection by consolidating model execution onto one path:

1. **All product model execution goes through the Vercel AI Gateway, called through the Vercel AI SDK.** The three hand-written HTTP adapters (OpenAI-compatible, Anthropic-compatible, and the gateway instantiated through the Anthropic adapter) are replaced by one AI SDK-backed provider behind the existing `ModelProvider` contract.
2. **The gateway's public model catalog is the single source of model and capability metadata** — model IDs, display names, context windows, output limits, pricing, and per-model reasoning levels. Agencity maintains no hand-written model catalog, no per-provider level maps, and no per-provider discovery adapters.
3. **A durable `reasoningEffort` setting** on `ModelConfiguration`, selected through `/effort` (alias `/thinking`), `--effort`, and the public protocol, inherited by child and recursive sessions, and recorded as an immutable per-call dispatch before any outbox-backed model effect.

Direct OpenAI and Anthropic API access is removed from the product and listed as an explicit deferral. The gateway's namespaced model identifiers align with the native provider identifiers (verified below), so direct access can be added later as a transport change without a second catalog or a model-identity migration.

The default effort is `provider-default`: Agencity omits all reasoning controls and the provider behaves exactly as it does today. Retained sessions and new sessions without an explicit setting keep current behavior.

## Decision and rationale

### Why gateway-only through the AI SDK

The initial design for this feature (previous revision of this document) kept three direct provider adapters and added per-provider reasoning dispatch: OpenAI `reasoning_effort`, Anthropic `thinking`/`output_config.effort` with reviewed token-budget maps, and a dedicated surface-aware gateway adapter. That design required a reviewed built-in capability catalog, a catalog validation script, a multi-source capability resolver with field-level provenance merging, and per-provider API-surface compatibility analysis. Those were the most fragile, highest-maintenance parts of the plan.

The AI SDK (version 7 and later) provides a normalized top-level `reasoning` parameter — `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh` — and owns the translation to each provider's native reasoning API. The gateway's public model catalog provides exact per-model effort level sets. Together they eliminate the hand-maintained catalog and all per-provider dispatch code.

Restricting the product to the gateway is acceptable because:

- The current product operator uses only a gateway key and holds no direct OpenAI or Anthropic credentials.
- Model calls always require network access; local-first in `AGENTS.md` governs canonical state, storage, and artifacts, all of which remain local. Consolidating on one model-network dependency is a product decision, not an architecture violation.
- The gateway adds capabilities the direct paths lack: one unified catalog, per-request cost reporting (making `Usage.costUsd` real for budget enforcement), and optional caching.
- The `ModelProvider` executor contract is retained as the seam. Adding a direct provider later is a contained adapter addition, not a rewrite, because the AI SDK exposes the same call interface for direct providers and the model identifiers align (see verified facts).

### Rejected alternatives

- **Keep direct OpenAI/Anthropic adapters with per-provider reasoning dispatch.** Highest maintenance cost; requires a reviewed catalog and budget maps that the gateway catalog now provides; supports credential configurations no current user has.
- **Gateway BYOK (bring your own key) as the bridge for users holding only provider keys.** Verified facts: every gateway request still requires Vercel authentication (API key or OIDC), so BYOK does not serve a user without a Vercel key; BYOK requires a paid Vercel team; a failed BYOK request silently retries on Vercel system credentials billed to gateway credits, which is a hidden fallback that conflicts with Agencity's no-hidden-fallback invariant; BYOK spend bypasses gateway budgets. BYOK is a non-goal.
- **Gateway REST endpoints without the AI SDK.** Keeps hand-written request/streaming/SSE code that the SDK already owns, for no capability gain.
- **Strict reject-before-commit capability validation (previous revision).** With one normalized vocabulary and SDK-documented coercion behavior, strictness is retained where the catalog has exact data and relaxed to labeled, warning-recording behavior where it does not. This removes the failure mode where a stale or incomplete catalog makes a working model unusable.

## Verified external facts

The following was verified against live endpoints and current documentation on August 7, 2026. Implementers should re-verify anything marked as a verification item.

### Gateway model catalog

`GET https://ai-gateway.vercel.sh/v1/models` requires **no authentication** and returns, per model:

- `id` in `creator/model` form (for example `openai/gpt-5.2`, `anthropic/claude-opus-5`);
- `name` (display name), `description`, `context_window`, `max_tokens`, `pricing` (per-token input/output USD strings), `modalities`, `knowledge`;
- `tags` including `reasoning` where applicable;
- `supported_parameters` including `reasoning` where applicable;
- `reasoning_options`: either `null` or an array of structured entries such as `{ "type": "effort", "values": ["low", "medium", "high", "xhigh"] }`, `{ "type": "toggle" }`, and `{ "type": "budget_tokens", "min": …, "max": … }`.

Observed examples:

| Model | `reasoning_options` |
| --- | --- |
| `openai/gpt-5.2` | effort: `none, low, medium, high, xhigh` |
| `openai/gpt-5.6-sol` | effort: `none, low, medium, high, xhigh, max` |
| `anthropic/claude-sonnet-5` | toggle + effort: `low, medium, high, xhigh` |
| `anthropic/claude-opus-5` | `null` despite the `reasoning` tag |

The `anthropic/claude-opus-5` row is load-bearing: **flagship models can have missing reasoning metadata**, so the design must treat `reasoning_options: null` as a normal state, not an error.

### Model identifier alignment

- OpenAI suffixes in the catalog are byte-identical to OpenAI's native API model IDs (`gpt-5.2`, `o3-mini`, `gpt-5.1-codex`).
- Anthropic suffixes use dotted aliases (`claude-opus-4.5`) where Anthropic's native API uses dashed aliases (`claude-opus-4-5`); the transform is deterministic (`.` ↔ `-` in the version segment).

This is why gateway-namespaced IDs are safe as Agencity's canonical durable model identity: a future direct-provider transport can derive native IDs from the same stored value.

### AI SDK reasoning normalization

- The AI SDK (v7+) `generateText`/`streamText` accept a top-level `reasoning` value: `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. `provider-default` is the behavior when the option is omitted.
- Effort-based providers receive the level directly. When a model supports fewer levels, **the SDK coerces the value to the nearest supported level and emits a warning**. Budget-based providers receive a token budget derived as a documented percentage of maximum output tokens. Providers without reasoning support ignore the option and emit an `unsupported` warning.
- Reasoning-related settings in `providerOptions` take full precedence over the top-level `reasoning` value.
- The catalog lists `max` as an effort value for some models (for example `openai/gpt-5.6-sol`), but `max` is not in the SDK's documented top-level vocabulary. **Verification item:** confirm whether the pinned AI SDK version accepts `max` as a top-level `reasoning` value; if not, dispatch `max` through the provider-options escape hatch for the gateway, or mark it unavailable with a typed error.

### Gateway authentication and BYOK

- Every gateway **model call** requires Vercel authentication (AI Gateway API key or OIDC token). Only the model catalog endpoint is public.
- BYOK exists in team-level and request-scoped (`providerOptions.gateway.byok`) forms, requires the paid tier, silently falls back to Vercel system credentials on failure by default, and bypasses gateway budgets. It is not used by this plan.

## Verified codebase baseline

As of this writing:

- `ModelConfiguration` (`src/domain/events.ts`) contains only `provider`, `model`, optional `temperature`, and optional `maxOutputTokens`.
- `SessionCreated`, `SessionModelChanged`, `TaskCreated`, and `RecursiveModelStarted` retain that configuration in canonical events. `ModelCallRequested` records provider and model but no reasoning data.
- `src/executors/model.ts` contains two hand-written HTTP adapters: `OpenAICompatibleProvider` (duplicated non-streaming and streaming request builders, hand-rolled SSE parsing, `max_tokens`) and `AnthropicCompatibleProvider` (`/v1/messages`, no `thinking`). The `vercel` provider is instantiated through the Anthropic-compatible adapter against `https://ai-gateway.vercel.sh` (`src/runtime/supervisor.ts`).
- There are three model-effect admission paths: the typed autonomous run (`src/runtime/agent-runs.ts`), the retained diagnostic turn (`src/runtime/model-loop.ts`), and model-summary compaction (`src/runtime/context-compaction.ts`). The first two append `ModelCallRequested` and then request the outbox effect; compaction requests model effects directly through the outbox with no `ModelCallRequested` event, one effect per summary chunk per hierarchy level.
- In `agent-runs.ts` a crash window exists between the committed `ModelCallRequested` and the corresponding effect request; recovery semantics below account for it.
- Child spawn uses `input.model ?? parentState.model` and validates with `assertChildPolicy` (same provider/model as parent), but explicit child configurations do **not** pass through `Supervisor.normalizeModelConfiguration`. This validation gap must be closed without widening the child model policy.
- Idempotent child-spawn retries compare retained task payloads with deep equality (`agents.ts`), so retries against pre-feature events must preserve the retained absent-field payload shape exactly.
- `ProfileStore` (`src/storage/turso.ts`) creates its schema from an inline idempotent SQL string with ad-hoc `PRAGMA table_info` column checks. There is no numbered profile migration ledger; one must be introduced before adding a profile table.
- `ModelExecutor.contextCapacity` resolves context-window capacity from provider-wide `ModelProviderCapabilities`; its source enum already includes `"model-catalog"`, currently unused. Capacity for the `vercel` provider is unknown today unless operator-configured.
- Model usage cost (`Usage.costUsd`) is populated only when the provider response carries a cost field; direct providers return none, so cost-based budget limits are currently ineffective for them.
- The current reducer version is 7 (`src/domain/state.ts`); a snapshot with a mismatched reducer version is discarded and rebuilt from events.
- Existing protocol surfaces used by this plan: `GET /capabilities`, `POST /sessions/:session/model?branch=…`, `GET /product/config`, `POST /product/config/model`, and the `agencity config` CLI family.
- Echo is an internal deterministic test provider implementing the `ModelProvider` contract; it is filtered from product selection.

## Goals

- Let a user inspect and select reasoning effort for the current model, with levels sourced from the gateway catalog.
- Persist the selected effort as part of durable branch model configuration; preserve it across process, worker, terminal, and managed-service restarts.
- Apply the same setting to streaming and non-streaming calls.
- Place the exact resolved reasoning dispatch in the outbox input so recovery cannot reinterpret it.
- Replace the three hand-written provider adapters with one AI SDK gateway adapter behind the unchanged `ModelProvider` contract.
- Make the gateway catalog the single model/capability/pricing/capacity metadata source, cached for offline listing.
- Record provider coercion and unsupported-setting warnings as bounded, attributable call provenance rather than silently accepting or silently dropping a setting.
- Populate real per-call cost from gateway metadata so cost budgets are enforceable.
- Preserve manual model entry and truthful failure when the catalog is unavailable.
- Keep the gateway credential supervisor-side and out of events, profile metadata, caches, logs, and protocol output.
- Preserve exact parent configuration when child and recursive work use inherited models.
- Cover the installed product path with black-box tests.

## Non-goals

- Direct OpenAI or Anthropic API access (explicit deferral; see below).
- Gateway BYOK in any form.
- Displaying hidden chain-of-thought or storing provider reasoning traces.
- A user-specified integer thinking-token budget.
- Automatically choosing an effort from task complexity.
- Allowing a model to mutate its own root-session effort during active work.
- Retrying a failed or unknown model effect with a different effort, model, or provider.
- Multi-provider onboarding, provider fallback, or gateway `order`/`only` routing controls in the first product interface.
- Treating scope filtering, the gateway, or the console worker as a hostile-code security boundary.
- Normalizing reasoning-token accounting beyond what the gateway reports.

## Terms

- **Gateway:** the Vercel AI Gateway (`ai-gateway.vercel.sh`), Agencity's sole product model transport.
- **AI SDK:** the Vercel AI SDK (`ai` package, version 7 line) plus `@ai-sdk/gateway`, pinned exact versions.
- **Canonical model ID:** the gateway's namespaced `creator/model` identifier stored in `ModelConfiguration.model` with `provider: "vercel"`. The durable provider name stays `"vercel"` so retained branches keep working unchanged.
- **Requested effort:** the user-facing level retained in `ModelConfiguration.reasoningEffort`.
- **Provider default:** an explicit choice to omit Agencity's reasoning control and let the gateway, provider, and model choose their default behavior.
- **Listed capability:** the catalog's `reasoning_options` enumerates an exact effort set for the model.
- **Unverified capability:** the model carries the catalog `reasoning` tag (or is absent from the catalog entirely) but has no exact level enumeration; standard levels are offered with an unverified label and SDK/gateway coercion semantics.
- **Reasoning dispatch:** the immutable record of the resolved effort decision committed before a model effect.
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
  | "xhigh"
  | "max";
```

`provider-default` means Agencity omits all reasoning controls. All other levels are sent as the AI SDK's top-level `reasoning` value. `max` is included because the gateway catalog lists it for some models; it is selectable only when listed (see the `max` verification item above).

Input aliases are presentation-only: `default` becomes `provider-default`; `off` becomes `none`. Events, preferences, protocol responses, and SDK values use canonical names only.

### Default behavior

The default is `provider-default`. This preserves existing behavior, avoids an unannounced cost or latency change, and keeps new models usable before their metadata is complete. The absence of `reasoningEffort` in a retained version-1 event has the same effective meaning as `provider-default`; replay never rewrites an old payload to add the field.

### Capability tiers and selection rules

Selection behavior depends on what the catalog knows about the model:

1. **Listed** (`reasoning_options` enumerates an effort set): the selector offers exactly those levels plus `provider-default`. An explicit level outside the listed set fails at selection time with the listed alternatives named. No model call is made.
2. **Unverified** (catalog `reasoning` tag present but `reasoning_options` is `null`, or the model is absent from the catalog, as with manual entry): the selector offers the standard SDK levels (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) labeled **unverified**. The SDK or gateway may coerce the level; any coercion or unsupported warning is recorded as call provenance and surfaced once in the run status. Agencity itself never substitutes a different level.
3. **Unsupported** (catalog entry exists and has no `reasoning` tag): only `provider-default` is selectable. An explicit level fails at selection time with a clear message, because the gateway would silently ignore the parameter and the stored setting would be a lie. A catalog refresh is offered in the same message since tags can be stale.

This is deliberately less strict than reject-everything-unproven and more honest than accept-everything-silently: exact data gates exactly, missing data degrades to labeled normalized behavior, and explicit contradiction with catalog data fails truthfully.

### Effort is model-specific

Workspace default efforts are keyed by the canonical model ID, not stored as one global effort. Changing models does not carry the old model's effort implicitly.

Selection order for a new root session:

1. explicit `--effort`;
2. the workspace preference for the selected model;
3. `provider-default`.

There is deliberately no environment-variable effort control in the first release; per-model preferences plus `--effort` cover the automation cases, and an ambient environment variable would apply one level across models with different supported sets.

**Ambient defaults never hard-fail session creation.** If a stored workspace preference is no longer valid for the model (for example, the catalog's listed set changed), the session is created with `provider-default` and a visible notice; the stale preference is left intact for the user to inspect or clear. Explicit `--effort` and explicit interactive selection do fail with guidance when invalid, because the user is present in the decision.

Existing branches ignore changes to defaults. Changing a branch's effort requires an explicit model-configuration change.

### Inheritance

- When `sdk.agents.spawn`, `rlm.start`, or their batch forms omit `model`, the child receives the exact parent `ModelConfiguration`, including effort.
- When a caller supplies an explicit `ModelConfiguration`, it passes through the same normalization and validation as a root selection (closing the current gap where child configurations skip `normalizeModelConfiguration`), and the existing child policy still requires the parent's provider/model. A missing effort in an explicit configuration means `provider-default`; workspace preferences are never injected into model-generated child or recursive calls.
- Stable child or recursive idempotency retries reuse the already retained model configuration and preserve the retained payload shape exactly. They never add explicit `provider-default` to a pre-feature payload, which would create a false idempotency conflict against the deep-equality comparison in the spawn path.
- Schedules, heartbeats, resumed runs, and retained follow-up use their session's committed configuration and do not re-read workspace preferences.
- No separate delegated effort ceiling is added; model-selection authority and child budgets continue to bound delegation.

## Domain contracts

### Durable model configuration

```ts
interface ModelConfiguration {
  readonly provider: string;          // "vercel" for all product models
  readonly model: string;             // canonical creator/model gateway ID
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: ReasoningEffort;
}
```

The field is optional so retained version-1 events preserve their exact shape. New product selections retain the canonical value explicitly, including `provider-default`.

`normalizeModelConfiguration` must: normalize provider and model identity as today; canonicalize effort aliases at input boundaries; reject unknown effort strings; validate numeric settings; and leave capability checks to the catalog-backed resolver. The same command-level validation must be injected into `AgentService` and applied to direct/batch spawn, recursive starts, subagent specifications, and refinement-review child creation before any model-bearing event is appended.

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
  readonly stale: boolean;                      // cache entry past its freshness window
}
```

There is no multi-source provenance merging: the gateway catalog is the only source, so per-field evidence reduces to the entry digest and staleness. Models absent from the catalog (manual entry) get a synthesized descriptor with `status: "unverified"` and `catalogDigest` of the synthesized entry.

### Immutable reasoning dispatch

Resolved from the committed branch configuration and the current descriptor before any model effect:

```ts
interface ReasoningDispatch {
  readonly requestedEffort: ReasoningEffort;
  readonly mode: "omitted" | "requested";       // omitted ⇔ provider-default
  readonly capability: {
    readonly status: "listed" | "unverified" | "unsupported";
    readonly levels: readonly Exclude<ReasoningEffort, "provider-default">[];
    readonly catalogDigest: string;
    readonly stale: boolean;
  };
  readonly resolverId: "agencity.reasoning-dispatch.v1";
}
```

Rules:

- The dispatch contains **no timestamps or other volatile fields**. Catalog fetch times live in the cache, not the dispatch, so byte-identical dispatch comparison is stable across recovery and retries.
- The complete dispatch is included as an optional `reasoning` field in `ModelCallRequested` and in `EffectRequested.input` beside the model configuration. The executor validates it and passes `reasoning: requestedEffort` to the AI SDK when `mode` is `"requested"`, and omits the option when `"omitted"`.
- The dispatch is part of idempotency agreement: reusing a model-call or effect idempotency key with a different dispatch is a conflict.
- A new effect whose configuration carries `reasoningEffort` but whose input has no dispatch is malformed and fails before any network access. A retained pre-feature effect input (no `reasoningEffort`, no dispatch) executes as omitted/provider-default without discovery or event rewriting.

### Version-1 event compatibility

Compatible optional version-1 fields:

- `ModelConfiguration.reasoningEffort` (appears via `SessionCreated`, `SessionModelChanged`, `TaskCreated`, `RecursiveModelStarted`, and every non-event validator embedding the configuration, including refinement-review subagent specifications);
- `ModelCallRequested.reasoning`;
- `ContextCompactionRequested.reasoning` (see compaction pinning below).

No existing event changes meaning and no retained payload is rewritten. Event validation continues to accept old fixtures without these fields and rejects malformed new fields. Mixed histories must rebuild, branch, synchronize, export, and project deterministically.

The model-call projection shape changes, so increment `REDUCER_VERSION`; a snapshot written by the prior reducer is discarded and rebuilt. Old calls display `provider-default / unrecorded` rather than claiming a level.

**Mixed-version sync note:** the current zod event schemas are non-strict and strip unknown keys on parse. A pre-feature Agencity runtime ingesting sync envelopes whose payloads contain `reasoningEffort` must not silently alter payload bytes or digests. Add a test that ingests a new-field envelope through the pre-feature validation path and asserts the retained envelope bytes are unchanged (or the envelope is quarantined, never mutated).

## Model catalog service

### Single source, cached

Add a `ModelCatalog` service under the model execution boundary:

- Fetches `GET {AI_GATEWAY_BASE_URL|https://ai-gateway.vercel.sh}/v1/models` with explicit timeout, response-size limit, model-count limit, and schema validation. Unknown fields are discarded. Errors never expose response bodies.
- Normalizes entries into `ModelDescriptor` values. `reasoning_options` of type `effort` yields `status: "listed"` with the exact values (validated against the canonical vocabulary; unrecognized values are dropped with a warning in diagnostics, never guessed). A `reasoning` tag without an effort enumeration yields `"unverified"`. No `reasoning` tag yields `"unsupported"`.
- Filters to `type: "language"` models for the product picker.
- The endpoint requires no credential; if a future change puts it behind auth, use the stored gateway key supervisor-side. Catalog responses never carry credentials.

Custom `AI_GATEWAY_BASE_URL` values are trusted-local endpoints. Catalog data fetched from an override is keyed to that exact normalized endpoint identity and is not merged with official-endpoint data.

### Profile cache and migration ledger

Add a profile-local `model_catalog_cache` operational table keyed by the normalized endpoint identity digest, storing bounded normalized descriptors, revision metadata, fetch time, expiry, and schema version.

`ProfileStore` currently applies an inline schema string. **Before adding the table, introduce a numbered, reopen-safe profile migration ledger** (mirroring the workspace `schema_migrations` mechanism), fold the existing inline schema and `PRAGMA`-based column patches into it as the baseline migration, and extend `scripts/check-architecture.ts` plus `docs/mutable-tables.md` so profile tables are classified distinctly from workspace tables.

The cache: contains no credentials or raw responses; is not canonical; is safe to delete and rebuild; is not synchronized through workspace envelopes; is excluded from profile export; is deleted with the owning profile; defaults to a 24-hour freshness window; and supports explicit refresh from the model picker, `/effort refresh`, and the protocol. Stale entries remain usable and visibly labeled; staleness is recorded in the dispatch. Stale data never causes Agencity to choose a different level.

### Context-window capacity integration

The catalog's `context_window` and `max_tokens` feed `ModelExecutor.contextCapacity` as the existing `"model-catalog"` source, replacing today's unknown capacity for gateway models. This is a **deliberate behavior change**: context-window admission and compaction triggers begin operating on real capacity values for gateway models. Add explicit tests covering admission and automatic-compaction behavior before and after capacity becomes known, and cover a retained session that gains capacity data after upgrade. Capacity provenance flows through the existing `ContextCapacityProvenance` mechanism unchanged.

## Execution

### The gateway provider adapter

Replace `OpenAICompatibleProvider`, `AnthropicCompatibleProvider`, and the Anthropic-instantiated `vercel` provider with one `VercelGatewayProvider` implementing the existing `ModelProvider` contract via the AI SDK:

- `complete` uses `generateText`; `stream` uses `streamText` with text deltas forwarded to the existing `onDelta` callback. One shared pure options builder serves both, so streaming and non-streaming requests cannot diverge.
- The dispatch's `requestedEffort` maps to the SDK's top-level `reasoning` option (`mode: "omitted"` omits it). No reasoning-related `providerOptions` are set except the `max` escape hatch if the verification item requires it.
- **Reasoning content is never persisted.** Reasoning parts in SDK responses and streams are discarded; only final text enters `ModelResponse.text`, committed messages, and cursorless progress. This feature controls effort, not chain-of-thought storage.
- **Warnings are provenance.** SDK warnings (coercion, unsupported settings) are captured as a bounded list on `ModelResponse`, retained with the effect outcome, visible in `/raw` diagnostics, and surfaced once in the run status line when present. They never mutate the branch configuration.
- **Usage and cost:** token usage maps from the SDK result; `Usage.costUsd` is populated from the gateway's cost metadata when present (verification item: confirm the exact provider-metadata field in the pinned SDK version). Provider-reported reasoning tokens are debited once inside total output usage, as today.
- **Context-window overflow** detection moves from response-body regex matching to the SDK's typed API error plus message matching inside the adapter, preserving the existing `ModelProviderContextWindowOverflowError` contract.
- The gateway credential resolves through the existing supervisor-side credential store / `AI_GATEWAY_API_KEY` environment fallback and is passed to the SDK per call; it never enters events, cache rows, logs, or errors.
- `ai` and `@ai-sdk/gateway` are pinned exact versions in `package.json`. AI SDK types must not leak through the `ModelProvider` contract or into domain/storage code (same confinement rule as LibSQL SDK types).

Echo remains unchanged behind the same contract. Programmatic provider registration remains supported for tests and trusted integrations; a programmatic provider without reasoning support is usable with `provider-default` only.

### Retiring direct providers

- Remove the OpenAI and Anthropic product providers, their onboarding paths, and their credential prompts. Product provider selection offers only Vercel AI Gateway. `supportedModelProviderNames` reduces to `vercel` (plus internal test providers, which stay filtered from product selection).
- Stored OpenAI/Anthropic credentials in the owner-only store are ignored, not deleted; `docs/configuration.md` documents this.
- **Retained branches on retired providers** (`provider` of `openai` or `anthropic`): interactive resume offers an explicit model migration to the equivalent gateway model (suggested by catalog match on the model name; the ID transforms are deterministic for OpenAI and dot/dash for Anthropic), committed as an ordinary `SessionModelChanged`. Non-interactive work on such a branch fails truthfully with that guidance. This mirrors the established retained-Echo-branch migration pattern. History is never rewritten.
- Retained `vercel` branches continue working with no migration: the durable provider name and gateway model IDs are unchanged; only the wire implementation behind the contract changes. Add an explicit test that a pre-feature `vercel` branch resumes and completes a call through the new adapter with unchanged durable semantics.

## Execution paths, attribution, and recovery

Reasoning dispatch resolution happens after context-window admission and before `ModelCallRequested`/`EffectRequested` are appended, in all three admission paths:

1. **Agent runs and diagnostic turns:** read the retained branch configuration → resolve and validate the dispatch → append `ModelCallRequested` with the dispatch → request the outbox effect with the same dispatch in its input → execute from the outbox input only → retain normal response, usage, budget, and terminal outcome events.
2. **Model-summary compaction:** resolve the dispatch **once per compaction request** and pin it in the optional `reasoning` field of `ContextCompactionRequested`. Every chunk effect across all hierarchy levels copies the pinned dispatch into its `EffectRequested.input`. This prevents a catalog refresh mid-compaction from producing mixed dispatches inside one compaction, and gives recovery a single retained value. Compaction of a retained pre-feature request (no pinned dispatch) executes all chunks as omitted/provider-default.

Recovery does not: query the catalog to reinterpret a committed effect; apply a refreshed catalog to a pending dispatch; downgrade a level; or retry a non-idempotent unknown model effect. Specifically:

- A crash after `ModelCallRequested` but before the effect request: recovery copies that call's retained dispatch into the new `EffectRequested` input without re-resolving.
- A pending first-attempt effect drains from its committed input; a started non-idempotent effect with no durable outcome becomes `unknown` under existing outbox rules.
- Context-window overflow retries reuse the exact prior dispatch byte-for-byte under a new call/effect identity; only context and context-window provenance change. Compaction cannot change effort.
- Console-worker restarts do not affect effort; the setting lives in durable state only.

If the gateway rejects a retained request (for example, capabilities changed after selection), that is a normal failed model effect with model/effort context. Agencity does not change the branch configuration or retry at another level.

## Selection, protocol, and SDK

### Supervisor

`Supervisor.createSession` and `Supervisor.selectModel` normalize the complete configuration and apply the capability tier rules against the current descriptor. Changing only effort is a model-configuration change: it uses the same active-work guard as `/model`, and `SessionModelChanged` retains the previous and next complete configurations, so a same-model effort change is explicit and attributable without a new event type.

### Public protocol

Additive changes; `agencity.protocol` stays version 1 with capability negotiation:

- `GET /capabilities` advertises `reasoningEffortSelection: true`;
- `POST /sessions/:session/model?branch=…` accepts `reasoningEffort` in the configuration;
- `GET /model-catalog` returns bounded normalized descriptors plus cache staleness; `POST /model-catalog/refresh` refreshes and returns the cached fallback with a typed refresh status on remote failure;
- `GET /product/config` includes per-model workspace effort preferences; `POST /product/config/reasoning-effort` sets or clears `{ model, effort }`.

A client must not send explicit effort to a server whose capabilities omit `reasoningEffortSelection`; it fails with a typed unavailable error instead of letting an older server silently strip the field. Managed and in-process transports return identical types and errors. Add corresponding `AgentClient` methods; clients never parse raw catalog responses.

### Console SDK

The `ModelConfiguration` extension flows through `sdk.agents` and `rlm` inputs; generated declarations document the canonical values. The console cannot change the current root session's effort; root selection remains a user/protocol operation.

## Product interfaces

### Terminal commands

- `/effort` — open the effort selector for the current model;
- `/effort LEVEL` — select one canonical level;
- `/effort refresh` — refresh catalog metadata for the current model;
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

- The gateway API key remains in the owner-only credential store or environment; it is passed to the AI SDK per call supervisor-side and never enters events, cache rows, sync envelopes, logs, protocol output, or error messages.
- **All product model traffic — prompts, context, and generated text — transits Vercel's AI Gateway.** State this plainly in `docs/security.md`. Note the gateway's prompt-training opt-out setting as operator guidance.
- Catalog responses are bounded, schema-validated, secret-free, and excluded from errors and canonical history.
- `model_catalog_cache` is a mutable operational profile cache; its migration and classification are architecture-checked.
- Selected effort is canonical (it changes model behavior). Call reasoning dispatch is canonical provenance. Recorded warnings are bounded effect-outcome data.
- A custom `AI_GATEWAY_BASE_URL` is a trusted-local network destination and receives the same credential as completion requests.

Update `docs/mutable-tables.md` for the cache classification and `docs/security.md` for the transit and credential statements.

## Implementation sequence

### 1. Domain vocabulary and compatibility

- Add `ReasoningEffort`, validators, alias canonicalization at input boundaries, and an `effectiveReasoningEffort` helper.
- Extend `ModelConfiguration`, the four model-bearing event schemas, `ModelCallRequested`, `ContextCompactionRequested`, and every embedded model validator (including refinement-review subagent specifications) with compatible optional fields.
- Increment `REDUCER_VERSION`; extend the model-call projection and diagnostic views with optional reasoning provenance; prove prior-reducer snapshots are discarded and rebuilt.
- Add retained old-event, mixed-history, and mixed-version sync-envelope fixtures.

### 2. Profile migration ledger and model catalog

- Introduce the numbered profile migration ledger; fold the existing inline schema into the baseline migration; extend architecture checks and `docs/mutable-tables.md`.
- Implement the `ModelCatalog` fetch/normalize/cache service with the descriptor model, staleness, refresh, endpoint-identity keying, and deletion behavior.
- Wire catalog `context_window`/`max_tokens` into `contextCapacity` as the `"model-catalog"` source, with before/after admission and compaction-trigger tests.

### 3. AI SDK gateway adapter and provider retirement

- Add pinned `ai` and `@ai-sdk/gateway` dependencies.
- Implement `VercelGatewayProvider` (shared options builder, streaming deltas, reasoning-part discard, warning capture, cost mapping, typed overflow mapping).
- Delete the OpenAI and Anthropic HTTP adapters and the SSE parser; keep the `ModelProvider` contract, Echo, and programmatic registration.
- Retire direct providers from onboarding, credential prompts, and product selection; implement retained-branch migration for `openai`/`anthropic` branches; test pre-feature `vercel` branch continuity.
- Resolve the `max`-level and cost-metadata verification items against the pinned SDK version.

### 4. Dispatch resolution, recovery, and inheritance

- Add the pure dispatch resolver; wire it into agent runs, diagnostic turns, and compaction (pinned per compaction request).
- Enforce dispatch presence in the executor; implement recovery copy semantics and byte-identical overflow-retry reuse.
- Route all model-bearing commands (root, select, spawn, batch, recursive, subagent specs, refinement children) through shared normalization and tier validation; verify inheritance and idempotent-retry payload preservation.

### 5. Protocol, TUI, and CLI

- Extend capabilities, model selection, catalog, and product-config routes plus `AgentClient` methods with capability negotiation.
- Add `/effort`, `/thinking`, the selector, refresh, picker enrichment, and status surfaces.
- Add `--effort` and the `config set-effort`/`clear-effort` commands with typed JSON output.

### 6. Documentation and release evidence

- Update public API, console SDK, protocol, configuration, user-guide, architecture, data-lifecycle, security, mutable-table, and verification documents; update `AGENTS.md` status (gateway-only execution, retired direct providers, reasoning effort) only after the user-visible path is implemented and verified.
- Run the full deterministic suite; report external rows separately as pass, fail, or skip.

## Test strategy

### Fixture strategy

Black-box and integration tests exercise the new adapter against a **local gateway fixture server** reached via `AI_GATEWAY_BASE_URL`. The fixture speaks the wire protocol of the pinned `@ai-sdk/gateway` version for completion, streaming, and the models endpoint; the implementer derives it by recording the pinned SDK's requests against a local listener, and the fixture asserts exact received payloads (including presence/absence and value of the `reasoning` option). Unit tests may additionally inject a custom `fetch` into the SDK where black-box fidelity is not required. Re-record fixtures on any SDK version bump.

### Domain and replay

- Old version-1 configurations project as effective `provider-default`; every canonical effort validates; invalid strings fail.
- Optional dispatch provenance round-trips through storage, snapshots, sync envelopes, export, and rebuild; prior-reducer snapshots rebuild.
- Duplicate events are no-ops; conflicting idempotency payloads fail; stable retries of pre-feature root/child/recursive commands preserve retained absent-field payloads without false conflicts.
- Branch forks retain the effort visible at the fork cursor; a same-model effort change retains correct previous/next configurations.
- A pre-feature runtime ingesting a new-field sync envelope never mutates retained envelope bytes.

### Catalog

- Sanitized fixtures cover valid, missing, malformed, oversized, unknown-field, and `reasoning_options: null` responses (including a flagship-model null case).
- Listed levels come only from `effort` entries with recognized values; unrecognized values are dropped, never guessed; tag-without-options yields unverified; tag-absent yields unsupported.
- Cache hit, expiry, refresh failure with cached fallback, stale labeling, endpoint-identity separation, reopen idempotency, and profile-deletion behavior are deterministic.
- Custom base-URL catalog data never merges with official-endpoint data.
- No secret appears in cache bytes, events, errors, logs, snapshots, or protocol responses.

### Adapter

- Exact SDK-bound payloads are asserted for every level and `provider-default`; streaming and non-streaming options agree.
- Rejected selections (unlisted level on a listed model; any level on an unsupported model) make zero network requests.
- Reasoning parts never enter committed messages or provisional output; warnings are captured, bounded, and retained with the effect outcome.
- Cost metadata populates `Usage.costUsd` and debits budgets once; overflow maps to the typed overflow error.
- Echo and programmatic providers still satisfy the contract; programmatic providers without reasoning support work with `provider-default` only.

### Runtime and recovery

- Agent runs and diagnostic turns produce identical dispatch semantics; compaction pins one dispatch per request and all chunks reuse it, including across a catalog refresh mid-compaction and across recovery.
- Crash after `ModelCallRequested`/before effect request copies the retained dispatch without re-resolution; pending first attempts drain from committed input; non-idempotent interruption preserves unknown-outcome behavior.
- A retained pre-feature pending model effect executes as omitted with no discovery; a new explicit-effort effect without a dispatch fails before network access.
- Overflow retries reuse the dispatch byte-for-byte; effort changes are refused during active work; console-worker restarts do not affect effort.
- Parent, direct/batch child, recursive, subagent-spec, refinement-child, schedule, heartbeat, and follow-up paths retain intended configurations.
- Retired-provider branches migrate only through explicit `SessionModelChanged`; non-interactive use fails truthfully; pre-feature `vercel` branches resume and execute unchanged.

### Protocol and product UI

- HTTP and in-process clients expose identical catalog, selection, and error behavior; clients refuse explicit effort against servers lacking the capability flag.
- `/effort` and `/thinking` are exact aliases; the selector covers listed, unverified, unsupported, and stale states; ambient-preference degradation shows its notice.
- Historical mode, active-run guards, modal ownership, resize, compact height, and non-TTY output are covered; manual entry works without the catalog; JSON output uses stable typed fields.

### Black-box acceptance

The linked-executable matrix must prove:

1. a fresh repository selects the gateway fixture model and an explicit effort without internal IDs;
2. the fixture receives the exact SDK payload including the `reasoning` value;
3. a completed run retains call-level reasoning dispatch provenance;
4. detach, service recovery, and resume preserve branch effort;
5. child and recursive work inherit the effort;
6. `/effort` changes an idle branch and a later call uses the new value;
7. an unlisted level and an unsupported model fail truthfully with zero model requests;
8. an unverified model accepts a standard level and retains the recorded coercion warning when the fixture emits one;
9. an old retained database resumes with provider-default behavior, and a retained direct-provider branch requires the explicit migration.

A credential-gated real-gateway smoke row (real `AI_GATEWAY_API_KEY`, real model, explicit effort, cost field present) is additional evidence, explicitly opt-in, and reported as skipped when credentials are absent.

## Acceptance criteria

- A user can inspect and change effort through the documented terminal and CLI paths, with levels sourced from the gateway catalog.
- All product model execution flows through the AI SDK gateway adapter; the direct OpenAI/Anthropic adapters and onboarding paths are removed; Echo and programmatic registration still work.
- Old sessions preserve provider-default behavior without history rewrites; retained `vercel` branches work unchanged; retired-provider branches migrate only explicitly.
- Every admitted model call retains its exact immutable reasoning dispatch; recovery, compaction, and overflow retries never reinterpret it.
- Coercion and unsupported warnings are recorded and visible; Agencity never substitutes a level itself.
- `Usage.costUsd` reflects gateway-reported cost; catalog capacity feeds context-window admission with tested behavior.
- Unlisted and unsupported selections fail truthfully with no model request; unverified selections are labeled.
- The gateway key and raw catalog responses never enter durable or user-visible state.
- The installed black-box path and the full deterministic suite pass; public docs and `AGENTS.md` describe gateway-only execution, the Vercel transit boundary, and remaining limits.

## Explicit deferrals

- **Direct OpenAI and Anthropic access** via `@ai-sdk/openai`/`@ai-sdk/anthropic`, keyed off the same canonical model IDs (OpenAI suffixes are native IDs; Anthropic needs the deterministic dot/dash transform). Requires per-provider credentials, onboarding, fixtures, and a capability story for models the catalog does not cover.
- Gateway BYOK, provider routing controls (`order`/`only`), and gateway automatic caching.
- A user-specified integer thinking-token budget (`reasoning_options` `budget_tokens` entries are ignored in this release).
- Environment-variable effort control.
- Per-task automatic effort selection; a delegated maximum-effort policy.
- Provider reasoning summaries and hidden-reasoning display.
- A normalized cross-provider `reasoningTokens` usage field.
- Embeddings, image, and other non-language gateway model types in the product picker.

# Reasoning effort and model capabilities plan

**Status:** Ready for implementation  
**Date:** August 7, 2026  
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related terminal work:** [Rich terminal rendering and layout](./2026-08-07-rich-terminal-rendering-and-layout-plan.md)

## Summary

Agencity lets a user select a provider and model, but `ModelConfiguration` has no reasoning setting, provider descriptors do not describe model-specific reasoning capabilities, and the provider adapters never send reasoning parameters. A user therefore cannot choose how much reasoning a supported model performs.

This plan adds a durable, attributable reasoning-effort setting with:

1. a provider-neutral effort vocabulary;
2. model-specific capability discovery backed by provider metadata, a versioned built-in catalog, and a bounded profile cache;
3. exact provider request mappings for OpenAI, Anthropic, and Vercel AI Gateway;
4. `/effort` and `/thinking` terminal commands plus non-interactive configuration;
5. inheritance through root, child, and recursive sessions;
6. call-level provenance that records the exact dispatch chosen before an outbox-backed model effect;
7. explicit unsupported, unknown, stale, catalog-mapped, gateway-normalized, and surface-incompatible states.

The default is `provider-default`. Existing retained sessions and new sessions without an explicit setting continue to omit reasoning parameters, preserving current provider behavior. Agencity does not infer support from uncataloged naming patterns, silently clamp a level, silently drop incompatible settings, or retry a failed model call with another effort.

## Verified baseline

The current implementation has the following relevant behavior:

- `ModelConfiguration` contains only `provider`, `model`, optional `temperature`, and optional `maxOutputTokens`.
- `SessionCreated`, `SessionModelChanged`, `TaskCreated`, and `RecursiveModelStarted` retain that configuration in canonical events.
- a child or recursive model call inherits the parent's complete model configuration when no override is supplied;
- `ModelCallRequested` records provider and model but no reasoning configuration or capability provenance;
- `EffectRequested.input.configuration` carries the projected model configuration into the shared model executor;
- `ModelProviderCapabilities` describes only streaming and an optional provider-wide context window;
- OpenAI-compatible requests use `/chat/completions` without `reasoning_effort`;
- Anthropic-compatible requests use `/v1/messages` without `thinking` or `output_config.effort`;
- Vercel AI Gateway is currently instantiated through the Anthropic-compatible adapter;
- the public protocol accepts the existing `ModelConfiguration` through `POST /sessions/:session/model`;
- the OpenTUI `/model` inspector selects a provider and accepts a manually entered model ID;
- the workspace profile retains a default `provider:model` string, while an existing branch retains its own committed model configuration.

The implementation has three model-effect admission paths: the ordinary typed autonomous run in `src/runtime/agent-runs.ts`, the retained diagnostic turn in `src/runtime/model-loop.ts`, and model-summary compaction in `src/runtime/context-compaction.ts`. The first two append `ModelCallRequested`; compaction currently requests a model effect directly. All three must use the same reasoning resolver and put the same immutable dispatch shape in the outbox input.

Model-bearing durable commands also enter through root creation and model selection, direct and batch agent spawn, recursive-model start, pinned subagent specifications, and refinement-review children. Omitted child models currently inherit the complete parent configuration. Explicit child configurations are constrained to the parent's provider/model by `assertChildPolicy`, but they do not all pass through `Supervisor.normalizeModelConfiguration`; this feature must close that validation gap without widening the existing child model policy.

## Provider discovery facts

Provider model-list endpoints are useful but do not expose one uniform capability schema.

### OpenAI

OpenAI's [`GET /v1/models`](https://platform.openai.com/docs/api-reference/models/list) lists model identities and ownership metadata. It does not provide a dependable list of supported reasoning levels or defaults. Agencity must merge the returned IDs with a reviewed, versioned catalog derived from official model documentation.

An OpenAI model returned by `/v1/models` but absent from the catalog remains available for manual selection, with reasoning support marked `unknown`. Only `provider-default` is selectable until exact reasoning metadata is available.

### Anthropic

Anthropic's [`GET /v1/models`](https://docs.anthropic.com/en/api/models-list) provides model metadata and, for current models, structured capabilities including supported effort levels and thinking modes. Agencity should use those fields when present.

The response must still be normalized through a local schema. Missing capability fields mean `unknown`, not `unsupported`. A capability is `unsupported` only when Anthropic states that explicitly or a reviewed catalog entry does.

### Vercel AI Gateway

Vercel's [`GET /v1/models`](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#list-models) exposes available model IDs and capability tags. [`GET /v1/models/{creator}/{model}/endpoints`](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#get-model-endpoints) exposes endpoint-specific `supported_parameters`, including whether `reasoning` is accepted. That parameter flag is coarse: it does not prove an exact level set or that every Gateway API format can carry the requested control to every backing model.

Vercel's [normalized reasoning contract](https://vercel.com/docs/ai-gateway/models-and-providers/reasoning) accepts `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`. The gateway may coerce a level to the closest level supported by the selected backing provider. Agencity must label this behavior `gateway-normalized`; it must not present the requested level as an exact backing-provider level.

### Prime Agent reference

Prime Agent demonstrates the useful product pattern:

- `/effort` with `/thinking` as an alias;
- a model-level `reasoning` capability and `thinkingLevelMap`;
- supported-level selection and clamping;
- session persistence;
- provider-specific reasoning mappings.

The relevant reference is Prime Agent commit [`b817a089`](https://github.com/PrimeIntellect-ai/prime-agent/tree/b817a089b23a2af7061d2ac544df00a4fd888545). Agencity adopts the command and capability concepts, but not silent clamping, process-owned session state, or Prime Agent's generated catalog format.

## Goals

- Let a user inspect and select the reasoning effort for the current model.
- Persist the selected effort as part of durable branch model configuration.
- Preserve the selection across process, worker, terminal, and managed-service restarts.
- Apply the same setting to streaming and non-streaming calls.
- Resolve model-specific capability before a model effect is requested.
- Place the exact resolved reasoning dispatch in the outbox input so recovery cannot reinterpret it.
- Record bounded capability and dispatch provenance with each model call.
- Discover current model IDs and capabilities without making live discovery a correctness dependency.
- Preserve manual model entry and local-first startup when discovery is unavailable.
- Keep provider credentials supervisor-side and out of events, profile metadata, caches, logs, and protocol output.
- Make unsupported, unknown, stale, catalog-mapped, surface-incompatible, and gateway-normalized behavior visible.
- Preserve exact parent configuration when child and recursive work use inherited models.
- Cover the installed product path with black-box tests.

## Non-goals

- Displaying hidden chain-of-thought or storing provider reasoning traces.
- Adding a free-form reasoning-token budget to the first product interface.
- Allowing a model to mutate its own root-session effort during active work.
- Automatically choosing an effort from task complexity.
- Comparing model quality or claiming that a higher effort is always better.
- Normalizing provider-specific reasoning-token accounting when the provider does not expose it.
- Replacing the current budget model or context-window admission algorithm.
- Retrying a failed or unknown model effect with a different effort, model, endpoint, or provider.
- Treating scope filtering, provider metadata, or the console worker as a hostile-code security boundary.
- Copying Prime Agent's catalog or session format.

## Terms

- **Requested effort:** The user-facing level retained in `ModelConfiguration`.
- **Provider default:** An explicit choice to omit Agencity's reasoning control and let the provider and model choose their default.
- **Reasoning capability:** A normalized statement about whether a model accepts an explicit effort and which levels are available.
- **Exact capability:** Provider metadata or a reviewed catalog states the accepted level set for the selected provider/model.
- **Catalog-mapped capability:** Agencity maps a named level to a reviewed, model-specific token budget because the provider exposes budget-based thinking rather than that named level.
- **Gateway-normalized capability:** Vercel accepts a standard effort but may map it to a different backing-provider level.
- **Surface-compatible capability:** The selected provider API format is documented to carry the requested control to the selected model. A provider-level reasoning tag alone is insufficient.
- **Capability evidence:** Field-level provenance identifying the provider metadata, gateway contract, built-in catalog, operator configuration, or stale cache from which each normalized capability field came.
- **Reasoning dispatch:** The immutable provider-facing mode and value resolved before a model effect is appended.
- **Catalog cache:** A non-canonical, replaceable profile record used for offline listing and bounded discovery traffic.

## Chosen product semantics

### Canonical effort vocabulary

The public and durable vocabulary is:

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

`provider-default` means Agencity omits all reasoning controls. `none` is a real provider request to disable reasoning and is available only when the selected provider/model supports it. `max` remains distinct from `xhigh` because Anthropic and future providers may expose both.

Input aliases are presentation-only:

- `default` becomes `provider-default`;
- `off` becomes `none`.

Events, preferences, protocol responses, and SDK values use canonical names only.

### Default behavior

The default is `provider-default`, not `medium` or the highest supported level. This preserves existing behavior, avoids an unannounced cost or latency increase, and gives new models a usable path before their exact capabilities are cataloged.

The absence of `reasoningEffort` in a retained version-1 event has the same effective meaning as `provider-default`. Replay never rewrites that old payload to add the field.

### No silent clamping

For direct OpenAI and Anthropic calls, a non-default level must be listed as supported. Unsupported explicit input fails before a new model configuration is committed.

Vercel is different because normalization and possible coercion are part of the gateway's documented contract. The UI labels a supported model/surface combination `gateway-normalized`, and call provenance records that semantic. Agencity itself does not choose a substitute level or claim which backing level was applied. If the selected Gateway API format is not documented to carry effort to that model, explicit effort is unavailable on that surface rather than being silently accepted.

Catalog-backed token-budget mappings are labeled `catalog-mapped`. They are inspectable product mappings, not claims that a provider natively implements Agencity's named level.

An unknown model exposes only `provider-default`. The user may continue to use the model, but Agencity does not guess from name prefixes or neighboring model versions.

### Effort is model-specific

Workspace defaults are keyed by the normalized `provider:model`, not stored as one global effort. Changing from one model to another does not carry the old model's effort implicitly.

Selection order for a new root session is:

1. explicit `--effort`;
2. the workspace preference for the selected normalized model;
3. the selected provider's effort environment variable;
4. `provider-default`.

Existing branches ignore changes to those defaults. An explicit branch change is required.

Provider environment variables are:

- `OPENAI_REASONING_EFFORT`;
- `ANTHROPIC_REASONING_EFFORT`;
- `VERCEL_REASONING_EFFORT`.

### Inheritance

When `sdk.agents.spawn`, `rlm.start`, or their batch forms omit `model`, the child receives the exact parent `ModelConfiguration`, including effort.

When a caller supplies another `ModelConfiguration`, that configuration passes through the same normalization and capability validation as a root selection. A missing effort means `provider-default`; profile preferences are not injected into model-generated child or recursive calls. The existing child policy still requires the same provider/model as the parent, so an explicit override may change compatible per-call configuration but does not authorize a different model.

Stable child or recursive idempotency retries reuse the already retained model configuration. They do not reinterpret an omitted model or effort against newer profile defaults or capability metadata.

The initial implementation does not add a separate delegated effort ceiling. Existing model-selection authority and child budgets continue to bound generated delegation. A future delegated model policy may restrict model and effort together.

Schedules, heartbeats, resumed runs, and retained follow-up use their session's committed configuration. They do not re-read profile defaults.

## Domain contracts

### Durable model configuration

Extend the existing type compatibly:

```ts
interface ModelConfiguration {
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: ReasoningEffort;
}
```

The field remains optional so retained version-1 events preserve their exact shape. New product selections should retain the canonical value explicitly, including `provider-default`.

`normalizeModelConfiguration` must:

1. normalize provider and model identity as it does today;
2. canonicalize effort aliases at input boundaries;
3. reject unknown effort strings;
4. validate numeric settings;
5. leave capability validation to the model-capability resolver.

### Model capability descriptor

Add a model-specific descriptor separate from provider-wide execution capabilities:

```ts
interface ModelDescriptor {
  readonly provider: string;
  readonly model: string;
  readonly displayName?: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly reasoning: ReasoningCapability;
}

interface ReasoningCapability {
  readonly status: "supported" | "unsupported" | "unknown";
  readonly levels: readonly Exclude<ReasoningEffort, "provider-default">[];
  readonly defaultEffort?: Exclude<ReasoningEffort, "provider-default">;
  readonly semantics: "exact" | "catalog-mapped" | "gateway-normalized" | "unknown";
  readonly surfaceStatus: "compatible" | "incompatible" | "unknown";
  readonly surfaceReason?: string;
  readonly transports: readonly (
    | "none"
    | "openai-effort"
    | "anthropic-adaptive-effort"
    | "anthropic-thinking-budget"
    | "anthropic-thinking-disabled"
    | "vercel-chat-reasoning"
    | "vercel-anthropic-thinking"
  )[];
  readonly apiSurface?: "openai-chat-completions" | "anthropic-messages";
  readonly provenance: {
    readonly status: CapabilityEvidence;
    readonly levels: CapabilityEvidence;
    readonly transports: CapabilityEvidence;
    readonly surface: CapabilityEvidence;
    readonly defaultEffort?: CapabilityEvidence;
  };
  readonly stale: boolean;
}

interface CapabilityEvidence {
  readonly source:
    | "provider-metadata"
    | "gateway-contract"
    | "model-catalog"
    | "operator-configuration"
    | "stale-cache"
    | "unknown";
  readonly sourceRevision?: string;
  readonly observedAt?: string;
  readonly stale: boolean;
}
```

`levels` is empty for `unsupported` and `unknown`. `provider-default` is always a configuration option and is not repeated in capability levels. An explicit level is selectable only when `status` is `supported`, `surfaceStatus` is `compatible`, and the level appears in `levels`. `defaultEffort` is present only when an authoritative source documents it. Field-level provenance is required because live metadata may supply levels while a reviewed catalog supplies a transport or API-surface constraint. Multiple transports are required because one Anthropic model may accept adaptive effort for non-`none` levels and a distinct `thinking: { type: "disabled" }` shape for `none`.

Provider descriptors remain provider-wide. Model-specific descriptors are retrieved through a new catalog contract so a provider with multiple models does not advertise one inaccurate shared level set.

### Immutable reasoning dispatch

Before appending `ModelCallRequested` or `EffectRequested`, resolve the selected configuration into a bounded dispatch:

```ts
interface ReasoningDispatch {
  readonly requestedEffort: ReasoningEffort;
  readonly mode:
    | "omitted"
    | "disabled"
    | "native-effort"
    | "adaptive-effort"
    | "token-budget"
    | "gateway-normalized";
  readonly providerValue?: Exclude<ReasoningEffort, "provider-default">;
  readonly budgetTokens?: number;
  readonly apiSurface?: "openai-chat-completions" | "anthropic-messages";
  readonly reasoningOutput: "provider-default" | "omitted";
  readonly resolverId: "agencity.reasoning-dispatch.v1";
  readonly capabilityFingerprint: `sha256:${string}`;
  readonly capability: ReasoningCapability;
}
```

The complete dispatch is:

- included as optional reasoning provenance in `ModelCallRequested`;
- included in `EffectRequested.input` beside the model configuration;
- validated by the model executor;
- used directly by the provider adapter without another discovery lookup.

For `provider-default`, the dispatch mode is `omitted`, `reasoningOutput` is `provider-default`, no live discovery is required, and the provider receives no reasoning controls. Explicit effort uses `reasoningOutput: "omitted"` so adapters pin `exclude` or `display` behavior instead of returning reasoning text. For Vercel, the mode is `gateway-normalized`; the record describes the requested value and never invents an applied backing-provider value. The fingerprint covers the normalized capability fields, evidence revisions, staleness, chosen transport, API surface, output handling, and any exact budget.

### Version-1 event compatibility

This feature uses compatible optional version-1 fields:

- `ModelConfiguration.reasoningEffort`;
- `ModelCallRequested.reasoning`.

`ModelConfiguration` appears in `SessionCreated`, `SessionModelChanged`, `TaskCreated`, and `RecursiveModelStarted`; all four event schemas and every non-event validator that embeds the configuration, including refinement-review subagent specifications, must accept the optional field. No existing event changes meaning, and no retained payload is rewritten. Event validation must continue to accept old fixtures without these fields and reject malformed new fields. Mixed histories must rebuild, branch, synchronize, export, and project deterministically.

The model-call projection shape changes, so increment `REDUCER_VERSION`; a snapshot written by the prior reducer must be discarded and rebuilt from events. Stable command retries against pre-feature `SessionCreated`, `TaskCreated`, or `RecursiveModelStarted` events must reuse the retained model payload shape before exact idempotency comparison. They must not add explicit `provider-default` to an old payload and create a false conflict.

The model-call projection retains reasoning provenance when present. Old calls display `provider-default / unrecorded` rather than claiming a level.

## Capability resolution

### Catalog layers

Introduce a `ModelCatalog` and `ModelCapabilityResolver` under the model execution boundary. They merge normalized fields rather than treating any one raw response as authoritative for every capability.

Resolution precedence for a field is:

1. explicit operator configuration for a programmatically installed provider;
2. explicit live provider metadata;
3. the versioned built-in catalog;
4. a previously normalized cache entry;
5. `unknown`.

An omitted provider field is not an explicit denial. `unsupported` outranks a lower-layer positive claim only when the higher layer explicitly states unsupported behavior.

The result includes field-level evidence and aggregate staleness for each capability. A catalog refresh cannot mutate a branch's selected effort or a committed outbox request.

Official built-in catalog entries apply only to the documented official endpoint identity. A custom `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, or `AI_GATEWAY_BASE_URL` does not inherit official capability claims merely because it uses the same provider name or a compatible wire format; it needs explicit operator metadata or remains unknown.

### Built-in catalog

Add a reviewed catalog with:

- exact provider and model IDs or documented family rules;
- supported levels and documented defaults;
- reasoning transport;
- adaptive-thinking or budget mapping data where required;
- the provider API surface on which each mapping is valid;
- context and output limits only when the source is authoritative;
- source URLs;
- a catalog revision and review date.

Model-family rules are allowed only when official provider documentation defines behavior for the whole family and fixtures cover positive and negative IDs. Arbitrary prefix inference is prohibited.

The catalog must have a validation script that rejects duplicate keys, unsorted levels, invalid defaults, unrecognized transports or API surfaces, missing source links, and budget maps that violate provider minimums or model output limits.

### Live discovery

Provider discovery adapters normalize and bound remote data:

- OpenAI: authenticated `/v1/models` for IDs and availability; reasoning comes from the built-in catalog.
- Anthropic: authenticated `/v1/models`; use explicit effort and thinking capability fields when present, then merge catalog fallbacks.
- Vercel: unauthenticated `/v1/models` plus the per-model `/endpoints` route; use reasoning tags and `supported_parameters` as coarse evidence, then require a reviewed Gateway API-surface mapping before exposing explicit levels.

Discovery uses fixed built-in endpoints or the user's trusted-local base URL override. Requests have explicit timeouts, response-size limits, model-count limits, and schema validation. Unknown fields are discarded. Errors do not expose response bodies that may contain secrets or infrastructure details. Capability data fetched from an override is keyed to that exact normalized endpoint identity and is not merged with official-endpoint claims unless an operator explicitly configures that relationship.

Manual model IDs remain accepted. Live discovery is an enhancement to selection, not an onboarding dependency.

### Profile cache

Add a profile-local `model_catalog_cache` operational table keyed by provider and a digest of the normalized endpoint identity. Store only bounded normalized descriptors, ETag or equivalent revision metadata, fetch time, expiry, and schema version.

`ProfileStore` currently creates its separate schema from an inline idempotent schema string rather than the workspace migration directory. Before adding the table, introduce a numbered, reopen-safe profile migration ledger. Extend the architecture checker and the registry in `docs/mutable-tables.md` so profile tables are classified without being confused with workspace tables.

The cache:

- contains no credentials or raw provider response;
- is not canonical agent history;
- is safe to delete and rebuild;
- is not synchronized through workspace event envelopes;
- is excluded from profile export unless export support is deliberately added later;
- is deleted with the owning profile;
- defaults to a 24-hour freshness period;
- supports an explicit refresh from the model picker and protocol.

Stale entries remain visible with a stale label. They may support a previously valid explicit selection, but the call records `stale-cache` provenance and a provider rejection remains a normal failed effect. Stale data never causes Agencity to choose another level.

## Provider dispatch

### OpenAI

Use the direct OpenAI Chat Completions request shape already owned by the adapter:

- omit the reasoning field for `provider-default`;
- map an exact explicit level to top-level `reasoning_effort`;
- reject unsupported levels before effect admission;
- validate whether the selected reasoning model permits `temperature`;
- use `max_completion_tokens` for reasoning models, and retain catalog-backed compatibility only where a model still requires another documented Chat Completions field.

Streaming and non-streaming request builders must call one shared pure payload builder. Response usage must continue to count provider-reported reasoning tokens inside total output usage when OpenAI includes them there.

### Anthropic

Choose the transport from the resolved capability:

- adaptive models use `thinking: { type: "adaptive" }` and `output_config: { effort }`;
- budget-only extended-thinking models use `thinking: { type: "enabled", budget_tokens }` with a reviewed, versioned model-specific level map and `catalog-mapped` semantics;
- a budget-mode model receives `output_config.effort` as well only when provider metadata or the reviewed catalog explicitly says that combination is supported, and the complete pair is pinned in the dispatch;
- `none` uses `thinking: { type: "disabled" }` and omits `output_config.effort` only when the selected model explicitly supports disabled thinking under its omitted effort default;
- `provider-default` omits both;
- thinking display is set to `omitted` where supported so reasoning text is not returned.

The resolver validates:

- supported levels;
- any incompatibility with `temperature`;
- integer budgets of at least Anthropic's documented minimum;
- `budget_tokens < max_tokens`;
- enough remaining output capacity for a visible answer.

The exact token budget is retained in the reasoning dispatch. Recovery never recalculates it from a newer catalog.

Thinking blocks are not appended to the conversation or exposed as cursorless progress. The final text blocks remain the model response. This feature controls effort; it does not add chain-of-thought storage.

### Vercel AI Gateway

Replace the current Anthropic-compatible gateway instantiation with a dedicated Vercel adapter that selects a documented API surface per model. OpenAI Chat Completions is preferred only when its `reasoning` object reaches the selected backing model. Current Gateway documentation explicitly says that this surface does not carry adaptive `output_config.effort` to some newer Anthropic models; those models must use the Gateway's Anthropic Messages surface or expose only `provider-default`.

On a surface-compatible OpenAI Chat Completions request, send:

```json
{
  "reasoning": {
    "effort": "high",
    "exclude": true
  }
}
```

`exclude: true` keeps internal reasoning out of the response while retaining final text. On the Anthropic Messages surface, use the resolved `thinking` and `output_config` shape and request omitted thinking display where supported. `provider-default` omits all reasoning controls on either surface.

The adapter accepts the gateway's normalized levels through `xhigh` only for model/surface combinations backed by the reviewed contract; it rejects `max` unless Vercel's contract adds it. Endpoint `supported_parameters` alone does not authorize a level. Provider routing does not authorize Agencity to retry or fall back after an unknown outcome. Gateway routing and any provider-side coercion remain visible through `gateway-normalized` provenance.

### Programmatic providers

Extend the provider contract with optional model discovery and reasoning resolution. A custom provider that implements neither remains usable with `provider-default` only. It cannot inherit reasoning behavior by claiming OpenAI or Anthropic compatibility in its display name.

Operator-supplied exact capability metadata is allowed for trusted-local integrations and is labeled `operator-configuration`.

## Selection, protocol, and SDK

### Supervisor

`Supervisor.createSession` and `Supervisor.selectModel` normalize the complete configuration and validate explicit effort against the resolved model descriptor. The same command-level validator must be injected into `AgentService` and used by direct/batch spawn, recursive starts, subagent specifications, and refinement-review child creation before any model-bearing event is appended.

The existing rule remains: branch model configuration cannot change while model work is active. Changing only effort is a model-configuration change and uses the same guard.

`SessionModelChanged` continues to retain the previous and next complete configuration. A same-model effort change therefore remains explicit and attributable without adding a second overlapping event type.

### Public protocol

Extend existing surfaces:

- `GET /capabilities` advertises `reasoningEffortSelection: true`;
- `POST /sessions/:session/model?branch=:branch` accepts the complete `ModelConfiguration`, including `reasoningEffort`;
- `GET /model-catalog?provider=:provider` returns bounded normalized descriptors;
- `POST /model-catalog/refresh` with `{ provider }` requests a refresh and returns cached fallback plus typed refresh status when the remote request fails;
- `GET /product/config` includes per-model workspace effort preferences;
- `POST /product/config/reasoning-effort` sets or clears `{ model: "provider:model", effort }`.

The managed and in-process transports return the same types and errors. These are additive routes and optional fields, so `agencity.protocol` remains version 1, but explicit effort requires capability negotiation: a new client must refuse to send it when `reasoningEffortSelection` is absent rather than letting an older version-1 server accept and ignore an unknown field. Compatibility tests must prove old snapshots/events without effort still decode and clients connected to an older capability response fail with typed unavailable behavior.

Add corresponding `AgentClient` methods and public API types. Client code does not parse raw provider payloads.

### Console SDK

The existing `ModelConfiguration` extension flows through `sdk.agents` and `rlm` inputs. Documentation and generated declarations show the supported canonical values.

The console cannot change the current root session's effort through a side channel. Root selection remains a user/protocol operation.

## Product interfaces

### Terminal commands

Add:

- `/effort` — open the effort selector for the current model;
- `/effort LEVEL` — select one canonical level;
- `/thinking`, `/thinking LEVEL`, and `/thinking refresh` — exact aliases;
- `/effort refresh` — refresh current-model capability metadata.

The selector shows:

- current provider and model;
- current effort;
- the documented provider/model default when known;
- exact, catalog-mapped, or gateway-normalized levels;
- contributing capability evidence and stale state;
- a concise explanation for unsupported or unknown control.

`provider-default` is always the first option. Unsupported levels cannot receive focus. Selecting the existing level is a no-op. Historical projection and active-work guards match `/model`.

The model picker is enriched with discovered models and a reasoning badge:

- `effort` for exact control;
- `gateway effort` for normalized Vercel control;
- `mapped effort` for catalog-backed token-budget control;
- `fixed` for explicitly unsupported control;
- `unavailable here` when the provider supports reasoning but the selected API surface cannot carry it;
- `unknown` when metadata is insufficient.

Manual model entry remains available when discovery fails or a model is not listed.

After selection, the transcript reports both model and effort. `/info`, `/model`, the header when width permits, and plain non-TTY output show the effective value without exposing capability internals by default. Raw capability provenance remains available through `/raw` and protocol diagnostics.

### CLI and configuration

Add:

- `--effort LEVEL` for newly created work;
- `agencity config set-effort LEVEL [--model PROVIDER:MODEL]`;
- `agencity config clear-effort [--model PROVIDER:MODEL]`.

When `--model` is omitted from the config command, the current workspace default model is required. Configuration fails clearly when no model can be resolved.

`--effort` does not silently mutate or get ignored on a resumed branch. As with the existing `--model` behavior, the ordinary entrypoint fails with guidance to use `agencity new --effort ...` or `/effort` on an idle retained branch.

JSON output includes canonical effort, capability status, field-level evidence, staleness, catalog-mapped semantics, surface compatibility, and gateway-normalized semantics as typed fields rather than presentation strings.

## Execution, attribution, and recovery

For ordinary agent runs and diagnostic turns, reasoning dispatch resolution happens after context-window admission but before `ModelCallRequested` and `EffectRequested` are appended. Model-summary compaction resolves once before each model effect is requested because it has no `ModelCallRequested` event today.

The two `ModelCallRequested` paths follow this order:

1. read the retained branch model configuration;
2. resolve and validate a reasoning dispatch;
3. append `ModelCallRequested` with that dispatch;
4. append or request the outbox model effect with the same dispatch;
5. execute the provider request from the outbox input only;
6. retain normal response, usage, budget, and terminal outcome events.

Model-summary compaction follows the same resolver and outbox rules, retaining its dispatch in `EffectRequested.input` and its existing effect/usage provenance. It must not become a side channel that bypasses effort validation.

The dispatch is part of idempotency agreement. Reusing a model-call or effect idempotency key with another effort, transport, budget, capability fingerprint, or stale state is a conflict.

Recovery does not:

- query discovery to reinterpret a committed effect;
- recalculate an Anthropic thinking budget;
- apply a newly released catalog;
- downgrade an unsupported level;
- retry a non-idempotent unknown model effect.

If a crash occurs after `ModelCallRequested` but before the corresponding effect request, recovery copies that call's retained dispatch into the new `EffectRequested` input rather than resolving again. A pending first-attempt effect is drained from its committed input; a started non-idempotent effect with no durable outcome becomes `unknown` under the existing outbox rules.

For compatibility, a retained pre-feature model effect may have neither `configuration.reasoningEffort` nor a reasoning dispatch. The executor interprets that exact old input as omitted/provider-default without discovery or event rewriting. A new effect with explicit effort but no dispatch is malformed and fails before network access.

Context-window overflow retries keep the exact prior reasoning dispatch, including transport, API surface, token budget, capability fingerprint, and stale state. A retry gets a new call/effect identity and a byte-identical dispatch; only context and context-window provenance change. Compaction cannot change effort.

## Validation and failure behavior

Reject before model configuration commit:

- unknown effort strings;
- a non-default level for an unsupported or unknown model;
- a level outside its declared exact, mapped, or gateway-normalized capability set;
- a level whose selected provider API surface cannot carry it;
- `max` through a gateway contract that supports only through `xhigh`;
- invalid reasoning-budget catalog data;
- incompatible `temperature`, output-token, or thinking-budget combinations.

If provider capabilities change after selection, the provider may reject the retained request. That rejection is a normal failed model effect with provider/model/effort context. Agencity does not change the branch configuration or retry at another level.

Discovery failure does not make a retained session disappear. The UI presents cached or built-in metadata when available and otherwise marks capability unknown.

## Security and data classification

- Provider keys remain in the owner-only credential store or environment.
- Discovery uses supervisor-side credential access and returns only normalized, secret-free descriptors.
- Provider response bodies are bounded, schema-validated, and excluded from errors and canonical history.
- The built-in catalog is source code and contains no credentials.
- `model_catalog_cache` is a mutable operational profile cache, not canonical state; its profile migration and classification are architecture-checked.
- Selected effort is canonical because it changes model behavior.
- Call reasoning dispatch is canonical provenance because it explains the exact requested effect.
- Outbox input contains no credential material.
- Custom base URLs remain trusted-local network destinations and receive the same prompts and credentials as completion requests.

Update `docs/mutable-tables.md` for the cache classification and `docs/security.md` for discovery and credential handling.

## Implementation sequence

### 1. Domain vocabulary and compatibility

- Add `ReasoningEffort`, validators, aliases at input boundaries, and `effectiveReasoningEffort`.
- Extend `ModelConfiguration` and event schemas with compatible optional fields.
- Increment `REDUCER_VERSION`, extend model-call projection and diagnostic views with optional reasoning provenance, and rebuild stale snapshots.
- Add retained old-event and mixed-history fixtures.
- Update every embedded model schema, including refinement-review subagent specifications.

### 2. Catalog and capability resolver

- Add normalized model and reasoning capability contracts.
- Add the reviewed built-in catalog and validation script.
- Implement OpenAI, Anthropic, and Vercel discovery adapters.
- Add a numbered profile migration mechanism, then add the classified cache, reopen idempotency, expiry, refresh, and deletion behavior.
- Merge capabilities by explicit field provenance.

### 3. Provider request mappings

- Add a pure reasoning-dispatch resolver.
- Put the resolved dispatch into model-call events and outbox input.
- Implement OpenAI native effort.
- Implement Anthropic adaptive effort and catalog-backed thinking budgets.
- Replace Vercel's Anthropic-compatible instantiation with a dedicated, surface-aware gateway adapter.
- Share payload builders across streaming and non-streaming requests.
- Route model-summary compaction through the same dispatch resolver.

### 4. Protocol, defaults, and inheritance

- Extend session model selection and product configuration routes.
- Add the model-catalog route and client methods.
- Add per-model profile preferences and provider environment variables.
- Verify root creation, branch changes, direct/batch child inheritance, explicit child overrides under the existing same-provider/model policy, subagent specifications, refinement children, recursive calls, schedules, and resume.

### 5. TUI and CLI

- Add `/effort`, `/thinking`, the effort selector, refresh, and direct command forms.
- Enrich the existing model inspector with discovered model capabilities.
- Add CLI flags and config commands.
- Present current effort in model, info, header, transcript, raw, and plain-output surfaces according to available width.

### 6. Documentation and release evidence

- Update public API, console SDK, protocol, configuration, user guide, architecture, data-lifecycle, security, mutable-table, and verification documents.
- Update `AGENTS.md` current implementation status only after the user-visible product path is implemented and verified.
- Run the deterministic full suite and report external provider rows separately as pass, fail, or skip.

## Test strategy

### Domain and replay

- old version-1 model configurations project as effective `provider-default`;
- every canonical effort validates and invalid strings fail;
- optional call provenance round-trips through storage, snapshots, sync envelopes, export, and rebuild;
- a prior-reducer snapshot is rejected and rebuilt from retained events;
- duplicate events are no-ops and conflicting idempotency payloads fail;
- stable retries of pre-feature root, child, and recursive commands preserve the retained absent-field payload instead of conflicting with explicit `provider-default`;
- branch forks retain the effort visible at the fork cursor;
- a same-model effort change retains correct previous and next configurations.

### Catalog and discovery

- recorded, sanitized fixtures cover valid, missing, malformed, oversized, and unknown-field responses for all three providers;
- OpenAI IDs merge with catalog reasoning metadata without inferring unknown IDs;
- Anthropic explicit capabilities override catalog fallbacks;
- missing Anthropic fields remain unknown;
- Vercel tags and endpoint `supported_parameters` do not invent exact levels or surface compatibility;
- official catalog entries do not leak onto custom base URLs without operator configuration;
- cache hit, expiry, ETag, refresh failure, stale fallback, endpoint separation, reopen, and deletion are deterministic;
- no secret value appears in cache bytes, events, errors, logs, snapshots, or protocol responses.

### Provider adapters

- exact request bodies are asserted for every supported level and `provider-default`;
- unsupported levels make zero network requests;
- streaming and non-streaming bodies agree;
- OpenAI sends the correct native effort and output-token fields;
- Anthropic sends adaptive effort or the exact retained token budget;
- Anthropic `none` sends disabled thinking only for model/effort combinations that support it;
- Anthropic rejects invalid budget/output and temperature combinations;
- Vercel sends the normalized `reasoning` object with `exclude: true` only on compatible Chat Completions mappings and uses the documented Anthropic shape where required;
- a Vercel model with reasoning tags but no proven compatible surface exposes only `provider-default`;
- reasoning/thinking blocks never enter committed messages or provisional text;
- provider-reported usage still debits total reasoning consumption once.

### Runtime and recovery

- ordinary agent runs and diagnostic turns retain identical dispatch semantics;
- a crash after effect request and before execution reuses the exact dispatch;
- a crash after `ModelCallRequested` but before `EffectRequested` copies the retained dispatch without discovery;
- a retained pre-feature pending model effect executes with omitted reasoning and no discovery;
- a new explicit-effort effect without a dispatch makes zero network requests;
- a crash during a non-idempotent model call preserves existing unknown-outcome behavior;
- overflow compaction retries copy the complete prior dispatch byte-for-byte;
- effort changes are refused during active work;
- parent, direct/batch child, recursive, subagent-spec, refinement-child, schedule, heartbeat, follow-up, and model-summary compaction paths retain the intended configuration;
- console-worker restart does not affect effort.

### Protocol and product UI

- HTTP and in-process clients expose identical catalog, selection, and error behavior;
- clients refuse explicit effort when the server does not advertise reasoning-effort selection;
- `/effort` and `/thinking` are exact aliases;
- selectors show exact, mapped, fixed, unknown, stale, surface-incompatible, and gateway-normalized states;
- historical mode, active run, modal ownership, resize, compact height, and non-TTY output are covered;
- manual model entry works when discovery is unavailable;
- hidden credential entry is never rendered as catalog data;
- JSON output uses stable typed fields.

### Black-box acceptance

The linked-executable matrix must prove:

1. a fresh repository selects a real product provider/model fixture and an explicit effort without internal IDs;
2. the fixture endpoint receives the exact provider payload;
3. a completed run retains call-level reasoning provenance;
4. detach, service recovery, and resume preserve the branch effort;
5. a child and recursive model inherit the effort;
6. `/effort` changes an idle branch and a later call uses the new value;
7. unsupported and unknown levels fail truthfully without a model request;
8. Vercel capability output distinguishes gateway-normalized and surface-incompatible models;
9. an old retained database resumes with provider-default behavior.

Credential-gated real-provider tests are additional evidence. They must be explicitly enabled and reported as skipped when credentials or a compatible model are unavailable.

## Acceptance criteria

The feature is complete when:

- a user can inspect and change effort through the documented terminal and CLI paths;
- supported levels come from attributable model capability data;
- old sessions preserve provider-default behavior without history rewrites;
- direct provider adapters send the documented exact request fields;
- Vercel normalization is labeled and never presented as exact backing-provider behavior;
- every admitted model call retains its exact immutable reasoning dispatch;
- recovery and overflow retries do not reinterpret that dispatch;
- child and recursive inheritance is deterministic;
- unsupported, unknown, and surface-incompatible states cause no hidden fallback or network call;
- provider keys and raw discovery responses never enter durable or user-visible state;
- the installed black-box path and the full deterministic verification suite pass;
- public documentation and `AGENTS.md` accurately describe shipped behavior and remaining limits.

## Explicit deferrals

- A user-specified integer thinking-token budget.
- Per-task automatic effort selection.
- A delegated maximum-effort policy separate from model and budget policy.
- Provider reasoning summaries and hidden-reasoning display.
- A normalized cross-provider `reasoningTokens` usage field.
- Automatic catalog updates outside ordinary package releases.
- Model benchmark recommendations or cost/latency forecasts.

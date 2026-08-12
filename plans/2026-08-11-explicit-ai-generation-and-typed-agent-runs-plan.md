# Explicit AI generation and typed agent runs plan

**Status:** In progress
**Date:** August 11, 2026  
**Last revised:** August 11, 2026
**Parent architecture:** [Prime Agent TypeScript/Turso rewrite](./2026-08-05-prime-agent-typescript-turso-rewrite-prd.md)  
**Related planning:** [Prime Agent rewrite follow-up plan](./2026-08-06-prime-agent-typescript-turso-rewrite-follow-up-plan.md), [Formal model-tool contracts](./2026-08-07-formal-model-tool-contracts-plan.md), [Durable tenacious goal orchestration](./2026-08-09-tenacious-goal-orchestration-plan.md), and [Agent environments and service interfaces](./2026-08-11-agent-environments-and-service-interfaces-plan.md)  
**Governing decisions:** [Durable agent relationships](../docs/decisions/0006-durable-agent-relationships.md), [Managed workspace execution](../docs/decisions/0007-managed-workspace-execution.md), [Formal model-tool contracts](../docs/decisions/0010-formal-model-tool-contracts.md), and [Capability-preserving placement](../docs/decisions/0011-capability-preserving-placement-contracts.md)

## Summary

Agencity will separate raw model generation from autonomous delegated work in the TypeScript console.

- `ai.generateText(...)` performs one context-only model generation and returns text.
- `ai.generateObject(...)` performs one context-only model generation constrained by a caller-declared data schema and returns a validated JSON value.
- `sdk.agents.run(...)` starts a complete child agent, waits for its terminal outcome, and returns either the default text result or a schema-constrained object.
- `sdk.agents.spawn(...)` starts the same complete child agent but returns its durable handle immediately for detached work.

The public `rlm` and `sdk.rlm` names will be removed. They currently describe an isolated one-turn model call even though Prime Agent uses `rlm(...)` for a full child agent. The replacement names make lifecycle and capability explicit.

Raw `ai` generation is intentionally narrow. It receives only its explicit prompt, messages, context values, and attributable input references. It does not receive a filesystem, Bun console, skills, memory, agent profile, ambient branch conversation, family messaging, or caller-defined executable tools. It is appropriate for bounded information processing such as extraction, classification, summarization, scoring, and transformation. The agent guidance will present it as a specialized primitive, not the default delegation mechanism.

`agents.run` and `agents.spawn` execute the ordinary autonomous lifecycle. Their child receives the normal `bun_console` and `finish` provider tools and the child-scoped TypeScript SDK, filesystem and shell authority, skills, memory, profile, budgets, retained history, and family relationships. A run may pin a text or object output contract.

Every operation uses the same model-selection input and normalization path. Default inheritance, configured provider routes, capability checks, budget limits, and authority policy remain authoritative.

## Product decisions

### Raw generation is not an agent

`ai.generateText` and `ai.generateObject` each admit exactly one provider generation. They do not run an observe/act loop and cannot call a tool and continue. Object generation may use one host-owned declaration-only provider tool as its formal output channel, but that tool has no executor and grants no runtime capability.

Raw generations belong to the calling session and branch. They are retained model invocations and outbox effects, not child sessions, tasks, subagents, or family members.

### Agent execution is a full child lifecycle

`sdk.agents.run` and `sdk.agents.spawn` both create a normal durable child task, session, branch, profile pin, budget reservation, and autonomous `AgentRun`.

- `run` waits and returns the typed terminal result.
- `spawn` returns after durable admission and scheduling.
- `runMany` waits for a bounded set of independent children and preserves input order.
- `spawnMany` admits and schedules a bounded set and returns their handles.

The child remains retained and addressable after either call. Waiting is an ergonomic behavior, not the source of task identity.

### Text is the default output; object output is explicit

Omitting `output` gives an ordinary text result. Supplying an object schema changes only the successful result shape. It does not change the child’s authority, tools, model, profile, budget, context access, or completion rules.

A schema-constrained agent completes through the ordinary `finish` tool. The successful `finish` branch carries a value that must satisfy the exact pinned schema. Blocked, failed, cancelled, budget-exceeded, and unknown outcomes retain their existing typed meanings and never fabricate an object.

The runtime will not ask a second model to extract JSON from a child’s prose and will not parse assistant text as a structured result.

### Callers declare data shape, not execution authority

Public callers may provide a bounded data schema. They may not provide:

- provider tool names or tool-choice policy;
- response-contract IDs;
- dispatch or capability records;
- enforcement claims;
- sealed refinement, governance, or goal-review contracts; or
- arbitrary executor identities.

The supervisor selects the host-owned generation or agent-action contract, validates the declared schema, computes its digest, and retains the complete resolved contract before execution.

### JSON Schema is durable; Zod is an ergonomic frontend

The durable output contract is a canonical, restricted JSON Schema document with a versioned validator identity and digest.

The Bun API may accept:

- a supported Zod schema;
- a supported Standard Schema value that converts losslessly; or
- a plain restricted JSON Schema document.

The console worker converts ergonomic schemas to plain JSON Schema before RPC. The supervisor independently validates and canonicalizes the result. Transforms, preprocessors, refinements, executable defaults, custom validator closures, external references, and other semantics that cannot be reproduced after restart are rejected.

### Model selection is one shared contract

`ai.generateText`, `ai.generateObject`, `agents.run`, `agents.runMany`, `agents.spawn`, and `agents.spawnMany` accept the same `ModelSelectionInput`.

The accepted forms are:

- a canonical `creator/model` string resolved through the caller’s current provider route; or
- the existing typed model configuration containing provider route, canonical model ID, reasoning effort, temperature, and output limit.

All forms pass through one normalization and capability-admission service. The canonical model name and provider route remain separate: `openai/gpt-5.2` identifies a model, while the retained route identifies direct OpenAI or Vercel Gateway transport.

Omission inherits the caller’s exact model configuration. The default generated-code policy permits only that exact model identity. An owner-managed delegated-model allowlist may authorize additional canonical model names and provider routes for raw generations and child agents. Every API uses the same allowlist. Accepting the same input shape does not by itself broaden model authority.

### Agents communicate through durable relationships and RPC

This plan does not add dynamic functions or callback tools between parent and child agents. Serializing closures would create hidden heap dependencies, while calling back into the live parent worker would execute under the wrong lifecycle and authority.

Children use their ordinary TypeScript SDK, skills, files, artifacts, and family messaging. Reusable callable behavior belongs in versioned agent service procedures and `sdk.agents.rpc` under the separate [agent environments and service interfaces plan](./2026-08-11-agent-environments-and-service-interfaces-plan.md). That capability is not implemented by or required for this refactor. Until it ships, agents use retained messaging and artifacts; model guidance mentions RPC only when capability discovery reports it available.

## Current behavior and gap

Agencity currently exposes:

- `rlm.start/startMany/get/result/cancel` as durable one-turn text-model calls;
- `sdk.agents.spawn/spawnMany` as durable full child-agent admission, with children running by default;
- only text results for public recursive calls;
- supervisor-only structured contracts for refinement review and governance;
- one shared serialized Bun console worker;
- fixed autonomous provider tools named `bun_console` and `finish`; and
- one model configuration shape internally, but inconsistent user-facing naming and lifecycle semantics.

The current `rlm` implementation creates a child task and session, then calls `ModelLoop.turn()` with a direct-response instruction. It is not equivalent to Prime Agent’s `rlm(...)`, which starts a normal child agent with the ordinary runtime and tools.

The current split creates four problems:

1. `rlm` suggests a recursive agent while implementing one model generation.
2. Raw information processing pays for child session, task, mailbox, profile, and family semantics it does not need.
3. Full child agents cannot return a caller-declared object through their formal completion contract.
4. Awaiting a spawned child from the current Bun cell would deadlock: the parent cell holds the shared console worker while the child needs that same worker for `bun_console`.

Generic structured output cannot be added by exposing the sealed contract registry. The current registry intentionally permits only host-owned built-in contracts. Public object generation needs a separate declared-data contract family whose only caller-controlled meaning is a bounded JSON shape.

## Goals

- Make raw model generation and full agent delegation unmistakably different in code and model-facing documentation.
- Provide ergonomic, type-inferred text and object results in generated TypeScript.
- Keep raw generation to one context-only provider call with no executable tools or ambient agent context.
- Let a complete child agent return either text or a validated object without post-hoc JSON parsing or a second extraction call.
- Let parent code use agent results directly in loops, conditions, fan-out, fan-in, and bounded evaluation logic.
- Use one model-selection contract and one normalization/admission path across generation and agent APIs.
- Preserve exact provider input, model dispatch, schema, validator, result, usage, cost, and effect provenance.
- Preserve durable child identity, budgets, cancellation, recovery, terminal notices, and family messaging for agent runs.
- Keep the ordinary provider-facing agent tool set exactly `bun_console` and `finish`.
- Prevent nested awaited agent work from deadlocking the console runtime.
- Teach the autonomous model when raw generation is appropriate and why full agent work should normally use `agents.run` or `agents.spawn`.

## Non-goals

- Giving raw AI generations filesystem, shell, skills, memory, family messaging, or autonomous continuation.
- Letting raw generations execute arbitrary provider tool callbacks.
- Treating raw generation as a durable agent identity.
- Parsing JSON from prose or accepting a best-effort structured fallback.
- Letting generated code choose a sealed reviewer, governance contract, dispatch record, provider tool set, or enforcement level.
- Serializing arbitrary JavaScript closure state.
- Adding dynamic cross-agent function or callback tools.
- Making warm scratch or one worker process part of a callable agent service’s durable identity.
- Broadening child model, credential, budget, data, or effect authority.
- Replacing retained agent relationships with anonymous returned values.
- Adding a third ordinary provider tool.
- Replacing durable tenacious-goal coordination with a long in-memory `for` loop. Agent calls inside a cell are durable, but the parent loop counter and uncommitted control flow are not recovery boundaries.
- Renaming or rewriting retained canonical events merely to improve terminology.

## Terms

### Raw generation

One provider model completion over an explicit, frozen context. It has durable request, effect, result, usage, and provenance records but no child session or autonomous loop.

### Declared data contract

A supervisor-owned response contract whose caller-controlled component is one bounded canonical JSON Schema. It shapes returned data but grants no runtime authority.

### Agent invocation

One request to create and run a complete child agent, optionally waiting for its terminal result. The durable child task and session remain after the waiting caller disconnects or restarts.

### Agent output contract

The immutable text or object result contract pinned to one child `AgentRun`. It controls the successful `finish` payload and terminal result validation.

## TypeScript console API

### Raw generation input

Both raw generation methods accept the same bounded input:

```ts
interface AiGenerationInput {
  model?: ModelSelectionInput;
  prompt?: string;
  messages?: readonly {
    role: "user" | "assistant";
    content: string;
  }[];
  context?: readonly (JsonValue | AiContextReference)[];
  budget?: AiGenerationBudget;
  idempotencyKey?: string;
}
```

`AiGenerationBudget` is a narrowing-only per-call limit over one provider generation. It may cap input tokens, output tokens, cost, wall time, and inline result bytes, but it cannot exceed the owning session or active run’s remaining limits.

Exactly one of `prompt` or `messages` is required. The supervisor supplies the fixed raw-generation system instruction and, for object generation, the host-owned output contract. Callers cannot inject a competing system role.

Messages, context items, materialized reference bytes, schema bytes, output bytes, calls per cell, and concurrent calls per cell have explicit product limits. Every generation debits the active calling run when present, otherwise the calling session. Small bounded fan-out is supported through ordinary promises, subject to the existing provider-concurrency limiter and the per-cell generation cap.

Budget ownership is always the calling session and branch, with cell, run, task, and ancestor attribution when those identities exist. A diagnostic cell outside an `AgentRun` debits the session budget without inventing a run.

Admission atomically reserves one turn plus conservative token, cost, and wall-time bounds before the provider effect is committed. Concurrent calls and active sibling/child reservations participate in the same check. Terminal usage settles the reservation exactly once; unknown usage consumes the unresolved reservation conservatively. A caller-supplied budget may only reduce that reservation.

Context references are authorized against the calling session, branch, and root family before materialization. The exact ordered values, source identities, ranges, digests, completeness, omissions, and byte counts are frozen before provider execution. No ordinary `ContextMaterializer` path may add branch messages, profiles, memories, repository instructions, or retrieval results implicitly.

### `ai.generateText`

```ts
const result = await ai.generateText({
  model: "openai/gpt-5.2",
  prompt: "Summarize the supplied incident report in five bullets.",
  context: [{ kind: "artifact", artifactId }],
  idempotencyKey: "incident-summary-v1",
});

return result.text;
```

The result includes:

- `text`;
- `generationId`;
- terminal `finishReason`;
- normalized usage and cost;
- model and provider route;
- context, provider-input, and result digests; and
- warnings and capability provenance.

The call receives no ambient conversation or agent profile. Every context item is explicit and attributable. Supported durable references retain the current bounded artifact, document-range, event, memory, and read-only SQL-row materialization behavior.

### `ai.generateObject`

```ts
const { z } = await import("zod");

const result = await ai.generateObject({
  model: "openai/gpt-5.2",
  prompt: "Classify whether this verification result is complete.",
  context: [{ task, verification }],
  schema: z.object({
    complete: z.boolean(),
    missingEvidence: z.array(z.string()),
    confidence: z.number().min(0).max(1),
  }),
  idempotencyKey: "verification-classification-v1",
});

if (!result.object.complete) {
  return result.object.missingEvidence;
}
```

The TypeScript return type is inferred from a supported Zod or Standard Schema input. A plain JSON Schema caller may supply an explicit generic result type, but runtime schema validation remains authoritative.

The provider receives one fixed host-owned output declaration such as `agencity_submit_object`. The tool has no `execute` callback. Exactly one completed declaration is required. Text-only completion, multiple calls, incomplete arguments, schema mismatch, secret leakage, and oversized output are typed failures.

Both raw generation methods enforce a documented hard inline output limit so `text` and `object` are always directly usable values. Oversized output is a typed terminal failure. Raw generation does not silently substitute an artifact reference for the declared return type.

### `sdk.agents.run`

Text is the default:

```ts
const result = await sdk.agents.run({
  task: "Inspect the authentication implementation and report concrete risks.",
  budget: { turnLimit: 12 },
  idempotencyKey: "auth-review-v1",
});

if (result.status === "succeeded" && result.output.kind === "text") {
  return result.output.text;
}
```

Object output is explicit:

```ts
const { z } = await import("zod");

const result = await sdk.agents.run({
  task: "Run the relevant checks and decide whether the change is ready.",
  output: {
    schema: z.object({
      ready: z.boolean(),
      checks: z.array(z.object({
        name: z.string(),
        status: z.enum(["passed", "failed", "unavailable"]),
      })),
      remainingWork: z.array(z.string()),
    }),
  },
  idempotencyKey: "release-readiness-v1",
});

if (result.status === "succeeded" && result.output.kind === "object") {
  return result.output.object.ready;
}
```

The returned value is a discriminated result, not an exception-only API. Text and object invocations have separate result types:

```ts
type AgentInvocationFailure = {
  status: "blocked" | "failed" | "cancelled" | "budget_exceeded" | "unknown";
  handle: AgentHandle;
  error?: string;
  provenance: AgentInvocationProvenance;
};

type AgentTextResult =
  | {
      status: "succeeded";
      handle: AgentHandle;
      output: { kind: "text"; text: string };
      provenance: AgentInvocationProvenance;
    }
  | AgentInvocationFailure;

type AgentObjectResult<T> =
  | {
      status: "succeeded";
      handle: AgentHandle;
      output: { kind: "object"; object: T };
      provenance: AgentInvocationProvenance;
    }
  | AgentInvocationFailure;

run(input: AgentTextRunInput): Promise<AgentTextResult>;
run<S extends SupportedSchema>(
  input: AgentObjectRunInput<S>,
): Promise<AgentObjectResult<InferSchema<S>>>;
```

`runMany` accepts the same per-item input, starts a bounded all-or-nothing admission batch, waits independently, and returns results in input order. One child failure does not convert other terminal results into success or failure.

Text and object results have a documented hard inline byte limit so successful values are always directly usable by the calling program. Oversized successful output is rejected as a typed contract violation before run completion; it does not silently change the return type to an artifact reference. Large working material belongs in ordinary child artifacts, while the terminal result remains a compact decision or summary.

### `sdk.agents.spawn`

`spawn` uses the same task, model, budget, profile, and output inputs as `run`, but returns after admission and scheduling:

```ts
const handle = await sdk.agents.spawn({
  task: "Run the slow compatibility audit and send a summary.",
  output: { schema: auditSchema },
  idempotencyKey: "compatibility-audit-v1",
});
```

`handle.result({ wait, timeoutMs })` and `sdk.agents.result(handle, options)` resolve the retained output contract. `sdk.agents.cancel`, messaging, acknowledgement, and follow-up continue to operate on the same retained child.

The current `run` boolean on `spawn` is removed from the model-facing API:

- `spawn` means admit and schedule detached work;
- `run` means admit, schedule, and wait;
- an advanced diagnostic `admit` operation may preserve create-without-scheduling behavior when tests or operators require it.

## Schema contract

The first supported schema profile will define:

- one explicit JSON Schema draft/profile identifier;
- canonical key ordering and number/string encoding;
- maximum schema bytes, depth, nodes, properties, alternatives, enum members, and reference count;
- local `$defs` only;
- no external, dynamic, or recursive references;
- explicit bounds for arrays, strings, and maps;
- supported scalar formats with runtime validators;
- closed objects by default;
- a maximum inline result size with fail-closed oversized output;
- secret rejection for schema descriptions and generated values; and
- one versioned validator implementation retained in provenance.

Schema acceptance must be deterministic across the console worker, supervisor, provider adapter, recovery path, reducer, rebuild, sync ingestion, and result reader. Provider-native schema enforcement is capability evidence, not a substitute for supervisor validation.

## Runtime architecture

### Raw generation service

Add an `AiGenerationService` separate from `RecursiveModelService`.

For each call it:

1. validates the public input and rejects reserved dispatch, contract, capability, and tool fields;
2. resolves the shared model selection and budget authority;
3. materializes only explicit context values and references;
4. resolves the text or declared-object response contract;
5. commits the frozen context, provider-input candidate, generation request, and outbox effect before execution;
6. executes one provider generation through the pinned Vercel AI SDK adapter (`generateText` for text and the AI SDK v7 structured-output equivalent for an object);
7. commits exact terminal output, usage, warnings, schema validation, and provenance; and
8. returns the retained result to the waiting worker.

Raw generation does not create `TaskCreated`, `SessionCreated`, `SubagentAdmitted`, mailbox, profile, or recursive-model-handle records. It also does not append the current profile-bound `ModelCallRequested` events, whose retained meaning requires an agent invocation.

Add canonical events such as:

- `AiGenerationContextFrozen`;
- `AiGenerationRequested`;
- `AiGenerationBudgetDebited`;
- `AiGenerationStatusChanged`; and
- `AiGenerationResultCommitted`.

The generation events retain their own prompt provenance, model dispatch, provider-input candidate, schema contract, usage ownership, and result. Extend the closed effect-origin union with `{ kind: "ai-generation", generationId }`; do not label the effect as an agent model call.

`AiGenerationBudgetDebited` carries the generation ID, owning session/branch/run, normalized usage, cost, turn debit, wall time, and exact source result event. Its reducer applies the same branch and tree budget aggregates as agent model calls while enforcing one debit per generation. Existing `BudgetDebited` retains its current call-ID meaning.

Add a mandatory rebuildable `ai_generations` projection for idempotency, status/result lookup, cancellation, and recovery. Classify it in `docs/mutable-tables.md`.

### Declared-object response contracts

Extend the response-contract model with a parameterized declared-data family. It is distinct from the closed sealed-operation registry.

The resolved contract contains:

- host-owned contract family and version;
- host-owned provider tool name;
- canonical schema and digest;
- fixed envelope schema;
- enforcement capability;
- validator identity;
- output byte limit; and
- full contract digest.

Only the canonical schema is caller-derived. Every other field is supervisor-selected and equality-checked during recovery.

### Agent output contracts

Add an immutable `AgentInvocationContract` pinned atomically with child admission. It contains:

- output kind: `text` or `object`;
- canonical object schema and digest when applicable;
- model configuration;
- profile pin;
- budget;
- result size policy; and
- contract version and digest.

Use additive canonical events rather than changing retained event meaning:

- `AgentInvocationContractPinned`;
- `AgentRunTypedFinishCommitted`;
- `AgentRunTypedActionViolationCommitted`; and
- `AgentRunResultCommitted`.

Old `AgentRunRequested` records without a pinned invocation contract retain the current default text behavior. Existing `TaskStatusChanged.result` and terminal notices carry the validated result reference after `AgentRunResultCommitted`.

For object output, derive a parameterized agent-action contract that keeps exactly `bun_console` and `finish`. The successful `finish` branch requires the declared object. Valid typed finishes use `AgentRunTypedFinishCommitted`; they are not written into the existing text-only `AgentRunActionCommitted.action` schema. Typed contract violations use `AgentRunTypedActionViolationCommitted`, commit before another model step, and consume the ordinary bounded violation/turn budget. A run cannot become successful until the exact result is committed and validated.

Introduce a new versioned agent-action contract rather than changing the retained meaning of the current text contract. Its object-success branch is:

```ts
{
  outcome: "succeeded";
  message: string;
  value: DeclaredObject;
}
```

`message` preserves the child’s human-readable assistant message and mailbox reply. `value` is the compact programmatic result.

One atomic child-branch append applies this exact order:

1. `AgentRunTypedFinishCommitted`;
2. the exact assistant `MessageAppended`;
3. `AgentRunResultCommitted`, bound to the finish event, message ID, schema digest, and value digest; and
4. `AgentRunStatusChanged`, referencing that message ID.

Parent task completion, usage attribution, result reference, and terminal notice then follow through the existing cross-stream delivery transaction. Reducers reject missing, reordered, mismatched, or duplicate typed terminal records. Recovery completes a committed parent-delivery prefix without regenerating either message or value.

### Console execution pool

Replace the single shared serialized console process with branch-scoped execution capacity.

Requirements:

- the parent cell may wait while a child branch executes `bun_console`;
- siblings and descendants cannot observe or reuse one another’s warm scratch;
- each execution remains scoped to exact session and branch identity;
- waiting for an SDK RPC does not consume the execution permit needed by the child that can satisfy it;
- nested awaited work cannot deadlock at the configured worker limit;
- global process and active-execution bounds remain explicit;
- cancellation and service shutdown drain or terminate the correct workers;
- worker loss abandons only the affected in-flight cell and does not lose admitted child identity; and
- quiescence accounting includes resident workers without making warm workers durable identity.

The implementation uses separate resident-process and active-execution permits. A waiting parent retains its resident process and JavaScript stack but releases its active-execution permit. Before `agents.run` or each member of `runMany` commits child admission, the scheduler reserves a resident child slot. A child must reserve another slot before admitting an awaited grandchild. If no slot is available, the nested call returns a typed capacity error before creating that child.

The maximum awaited depth is explicit and no greater than the configured durable child depth. Batch admission reserves all immediate child slots atomically. Detached `spawn` may queue without a waiting dependency, but an awaited chain never relies on unknown future capacity. This policy prevents deadlock without pretending that a suspended JavaScript stack can be serialized.

### Recovery and cancellation

- A raw generation interrupted before its outbox request may be safely re-admitted by stable idempotency.
- A lost non-idempotent provider effect becomes `unknown`; neither text nor object generation retries it blindly.
- A child admitted by `agents.run` continues if the waiting parent cell or client disconnects.
- Parent-tree or explicit child cancellation propagates through child runs, cells, effects, and descendants.
- A restarted caller resolves a child through its retained handle, family listing, terminal notice, or stable idempotency key.
- Structured results are revalidated against the retained schema and validator identity during recovery and projection rebuild.
- Missing or corrupt artifacts referenced by explicit generation context or child work remain dependency failures, not empty values.

## Public protocol and compatibility

Add typed HTTP/client operations for:

- raw generation admission;
- generation lookup and cancellation;
- agent invocation admission and batch admission;
- agent result lookup; and
- invocation-contract inspection.

Use route names that expose lifecycle directly, such as `/sessions/:session/ai/generations` and `/sessions/:session/agent-invocations`.

HTTP admission returns a durable handle immediately. Result waiting uses a lookup endpoint or cursor-resumable SSE; it does not hold one ordinary request open for the duration of an agent run. `AgentClient.generateText`, `generateObject`, and `runAgent` are convenience compositions of admission plus result waiting. Console `ai.generate*` and `sdk.agents.run` use the same durable handle/result protocol over worker RPC. Lookup by parent branch plus stable idempotency key recovers work when a disconnect occurs before handle delivery.

This is a pre-release public API cutover:

- remove `rlm` and `sdk.rlm` from new console workers and generated guidance;
- replace `AgentClient.startModel/model/cancelModel` with explicit generation methods;
- remove or capability-gate obsolete protocol request members and `/models` routes;
- bump the managed protocol schema revision and compatibility map;
- reject old client/new service mismatches with typed upgrade guidance; and
- do not keep a model-facing `rlm` alias that teaches two names for different semantics.

Retained `RecursiveModelStarted`, `RecursiveModelStatusChanged`, `recursive_model_handles`, and related migrations are not rewritten. They remain valid history and may continue to support supervisor-private sealed operations until a separate event-version decision replaces them. Historical handles remain inspectable through advanced diagnostics even after new public admission is removed.

## Model-facing guidance

The generated execution instruction in `src/runtime/agent-runs.ts` must include a concise decision guide and working examples. This guidance is part of the effective system prompt and its exact version/digest remains attributable like other prompt components.

The decision guide must say:

- use ordinary TypeScript when the operation is deterministic;
- use `ai.generateText` only when all required information is already in the explicit prompt/context and one text transformation is sufficient, such as summarization or rewriting;
- use `ai.generateObject` under the same context-only constraint when later TypeScript must branch, loop, filter, aggregate, or validate fields from the result;
- raw `ai` calls cannot inspect files, run commands, use skills, call tools, read ambient branch context, or continue autonomously;
- keep object schemas small and decision-oriented rather than asking for an unbounded report encoded as JSON;
- use `sdk.agents.run` when a child must inspect the workspace, use tools, run commands, iterate, or otherwise complete a full agentic task before the parent can continue;
- give `agents.run` an object schema when the parent needs to use the child’s conclusion as program data; omit it when a normal textual report is sufficient;
- use `sdk.agents.spawn` when the child should work independently and the parent does not need its result before continuing; retain the handle and use messaging, terminal notices, or `handle.result()` later;
- use `runMany` or `spawnMany` only for bounded independent tasks, not for steps that depend on one another;
- model selection uses the same canonical model IDs across all generation and agent operations;
- cross-agent callable behavior uses retained messaging and artifacts, plus durable versioned RPC only when that separately implemented capability is available;
- returned model judgments are data, not objective evidence or expanded authority; and
- a long parent-cell loop is not a durable coordinator across worker loss.

The prompt and `docs/console-sdk.md` must include succinct examples that demonstrate the distinction:

```ts
// One raw text transformation over data already selected by this cell.
const summary = await ai.generateText({
  prompt: "Summarize these failures without inventing causes.",
  context: failures,
});
```

```ts
// One raw judgment whose fields drive ordinary TypeScript control flow.
const { z } = await import("zod");

const verdict = await ai.generateObject({
  prompt: "Decide whether this exact check evidence is complete.",
  context: [{ task, checks }],
  schema: z.object({
    complete: z.boolean(),
    missing: z.array(z.string()),
  }),
});

if (!verdict.object.complete) {
  for (const item of verdict.object.missing) {
    // Handle each missing item in the surrounding program.
  }
}
```

```ts
// A full child agent because it must inspect files and run verification.
const { z } = await import("zod");

const review = await sdk.agents.run({
  task: "Inspect the implementation, run relevant tests, and assess readiness.",
  output: {
    schema: z.object({
      ready: z.boolean(),
      evidence: z.array(z.string()),
      remainingWork: z.array(z.string()),
    }),
  },
});

if (review.status === "succeeded" && review.output.kind === "object") {
  if (!review.output.object.ready) {
    return review.output.object.remainingWork;
  }
}
```

```ts
// Detached child work whose result is not needed in the current cell.
const audit = await sdk.agents.spawn({
  task: "Run the slow compatibility audit and report back to the parent.",
});

return { auditTaskId: audit.taskId };
```

Supporting documentation also covers bounded `runMany`, schema violations, budgets, timeout outcomes, idempotency, retained result lookup, and recovery after worker loss. Prompt tests must assert the decision guide and representative examples so later wording changes do not erase the capability distinctions.

## Documentation changes

Update in the same implementation:

- `AGENTS.md`;
- `README.md`;
- `docs/console-sdk.md`;
- `docs/api.md`;
- `docs/protocol.md`;
- `docs/events.md`;
- `docs/architecture.md`;
- `docs/glossary.md`;
- `docs/capabilities.md`;
- `docs/configuration.md`;
- `docs/security.md`;
- `docs/recovery.md`;
- `docs/mutable-tables.md`;
- `docs/verification.md`;
- ADR 0006 for the raw-generation versus child-agent distinction;
- ADR 0010 for declared-data and parameterized agent-output contracts; and
- `plans/README.md`.

Update historical implementation plans only where they are authoritative for future work or contain current capability claims. Preserve completed delivery evidence as historical evidence rather than rewriting it to imply the new API existed at that time.

Reassess the tenacious-goal plan after this primitive lands. Typed agent calls can simplify bounded orchestration inside one committed cell, but they do not replace cross-run goal episodes, durable continuation state, or supervisor-owned recovery.

## Delivery phases

### Phase 1 — Contract and schema foundation

- Define the restricted canonical JSON Schema profile.
- Add deterministic canonicalization, digesting, validation, bounds, and secret checks.
- Add supported Zod/Standard Schema conversion in the worker.
- Add the declared-data response-contract family without exposing sealed contract selection.
- Add shared `ModelSelectionInput` parsing and normalization.
- Add the owner-managed delegated-model allowlist, defaulting to the caller’s exact model identity.
- Add unit fixtures for accepted and rejected schemas and byte-identical rebuild.

### Phase 2 — Raw `ai` generation

- Implement `AiGenerationService` without child session/task admission.
- Add text and object execution over existing model/outbox primitives.
- Add generation events, the required result projection, generation-owned budget debit, cancellation, recovery, and hard inline result bounds.
- Expose `ai` and `sdk.ai` in the Bun worker.
- Add protocol/client generation operations.
- Remove public console `rlm` admission.

### Phase 3 — Agent invocation contracts and typed results

- Add `AgentInvocationContractPinned`, typed finish/violation events, and `AgentRunResultCommitted`.
- Extend the formal `finish` contract for schema-constrained successful output while retaining `bun_console` and `finish` as the only provider tools.
- Implement result validation, hard inline result bounds, task result propagation, terminal notices, and handle lookup.
- Add `sdk.agents.run`, `runMany`, and `result`.
- Make `spawn` detached-running and remove the model-facing `run` boolean.

### Phase 4 — Deadlock-free nested console execution

- Replace shared serialization with a bounded branch-aware execution pool.
- Prove parent-waits-for-child, sibling concurrency, nested depth, cancellation, restart, scratch isolation, and quiescent shutdown.
- Fail admission visibly when execution capacity cannot satisfy an awaited dependency.

### Phase 5 — Cutover, guidance, and product verification

- Rename public protocol/client/console surfaces.
- Update prompt guidance and all public documentation.
- Add black-box installed-product coverage for text generation, object generation, typed agent runs, detached agents, nested execution, recovery, and truthful unavailable capabilities.
- Update capability and protocol revisions.
- Run deterministic aggregate verification and report external skips separately.

## Verification matrix

### Raw text and object generation

- exact explicit context only; no ambient messages, profile, memory, repository instructions, tools, or filesystem;
- prompt/messages exclusivity, allowed roles, input bounds, reference authorization, and frozen ordering;
- one provider request per admitted generation;
- per-cell call and concurrency bounds plus direct caller-run budget debit;
- shared model normalization and policy across text/object/agent calls;
- valid Zod, Standard Schema, and plain JSON Schema conversion;
- rejection of transforms, refinements, closures, external references, recursion, unsupported formats, excessive depth/size, and secrets;
- provider-strict and runtime-validated object outputs;
- malformed, missing, duplicate, partial, oversized, and secret-bearing object outputs;
- stable idempotency and no duplicate effect;
- cancellation, budget exhaustion, unknown provider effect, restart, rebuild, sync, and artifact loss;
- exact provider-input and schema digest parity between estimate, execution, and recovery.

### Typed agent runs

- default text completion;
- direct schema-constrained completion through `finish`;
- contract violation followed by bounded repair;
- blocked, failed, cancelled, budget-exceeded, and unknown without fabricated output;
- child filesystem, shell, skills, memory, family messaging, and recursive delegation remain available;
- result propagation to task, terminal notice, handle, protocol, and calling cell;
- run, runMany, spawn, spawnMany, result, follow-up, and cancel;
- parent worker loss while waiting;
- supervisor loss before admission, after admission, during provider execution, during child cell execution, after result commit, and before terminal delivery;
- exact-once usage attribution and terminal delivery;
- old runs without invocation contracts retain text semantics.

### Console execution pool

- parent cell awaits a child that executes several Bun cells;
- child awaits a grandchild;
- bounded sibling fan-out;
- no cross-branch scratch or worker state leakage;
- no deadlock at configured limits;
- cancellation releases permits and stops the correct branch;
- service shutdown drains admitted work;
- warm workers do not become identity or completion evidence.

### Product and documentation

- model-facing instructions select `ai` only for raw transformations;
- agentic tasks use `agents.run` or `agents.spawn`;
- examples compile in the real Bun console;
- no public page describes `rlm` as the current API;
- no page claims raw generation has tools or autonomous behavior;
- no page claims typed schemas provide sandboxing or objective correctness;
- installed black-box execution uses only the public CLI/protocol/console path.

## Completion criteria

The refactor is complete when:

1. `rlm` is absent from the current model-facing console and guidance.
2. `ai.generateText` and `ai.generateObject` each perform exactly one explicit-context provider generation with durable provenance and no agentic capabilities.
3. `sdk.agents.run` executes a full child autonomous loop and returns validated text or object output.
4. `sdk.agents.spawn` executes the same child lifecycle without waiting.
5. Every generation and agent API accepts the same model-selection shape and passes through one authority-preserving normalization path.
6. Awaited nested agents cannot deadlock the console runtime.
7. Structured output cannot select sealed contracts, provider tools, dispatch, capabilities, or runtime authority.
8. Restart, cancellation, unknown effects, rebuild, sync, and artifact failures preserve explicit outcomes without duplicate execution.
9. Dynamic cross-agent tools are absent; agents use retained messaging and artifacts, with versioned RPC truthfully capability-gated until its separate plan ships.
10. Public docs, canonical guidance, protocol descriptions, capability claims, and verification evidence match the shipped behavior.

## Known risks

- Dynamic schema support can accidentally become a caller-controlled provider contract. The implementation must keep host-owned semantics separate from caller-declared data shape.
- Zod conversion can imply guarantees that JSON Schema cannot reproduce. Unsupported semantics must fail admission rather than degrade silently.
- A branch-aware console pool changes process lifecycle and scratch behavior. It requires focused stress and shutdown testing before enabling awaited nested agents.
- Typed model output remains model-generated data. Schema validity does not prove factual correctness, task completion, or permission to act.
- Raw generation may be overused because it is cheap to call. Prompt guidance and examples must prefer deterministic TypeScript and full agents for work requiring tools or verification.

## Implementation log

### 2026-08-11 — Contract and schema foundation
- Completed: Added the restricted canonical JSON Schema profile, deterministic runtime validation and digests, lossless supported Zod v4 conversion, host-owned declared-data response contracts, shared model-selection normalization, and an owner-managed delegated-model allowlist used by child admission.
- Validation: `bun test --timeout 30000 test/unit/declared-schema.test.ts test/unit/schema-conversion.test.ts test/unit/declared-response-contract.test.ts test/unit/model-selection.test.ts test/integration/recursive-console.test.ts` (60 passed); `bun run typecheck`; `bun run check:architecture`; `git diff --check`.
- Plan notes: The first schema profile rejects Zod intersections, readonly output mutation, UTF-16 string-length checks, non-Unicode regular-expression flags, non-scalar `const` and `enum` values, unsafe regular-expression shapes, and unknown Standard Schema vendors because their semantics are not reproduced safely by the durable validator.
- Remaining: Raw generation, typed agent invocation/results, branch-aware console execution, public cutover, documentation, and aggregate verification.

### 2026-08-11 — Durable raw AI generation
- Completed: Added the separate one-request `AiGenerationService`, additive canonical generation/context/result/budget events, migration-021 `ai_generations` rebuildable projection, explicit-only context freezing, narrowing budget reservations and exact/conservative one-debit settlement, hard inline bounds, idempotency, cancellation/timeout/unknown recovery, Supervisor lifecycle integration, direct `ai`/`sdk.ai`, route-scoped typed protocol/client lifecycle methods, managed-protocol revision 2, and the public `rlm` console/protocol cutover. Independent phase review hardened atomic generation/effect admission, cross-process reservation checks, child usage attribution, timeout/cancellation races, pre-persistence secret/output rejection, getter-free/depth-bounded context validation, fatal artifact UTF-8 decoding, exact completeness/omission provenance, reducer event ordering and parity checks, and cross-route lookup/cancel authorization. Follow-up review reconciled an authoritative provider outcome that commits at the timeout-unknown boundary and replaced full-cap cost reservation with exact catalog-priced input/output reservation when pricing is available.
- Validation: `bun test --timeout 30000 test/integration/ai-generation.test.ts` (11 passed, 0 failed); `bun run typecheck`; `bun run check:architecture`; `git diff --check`.
- Plan notes: Context, generation reservation, and `EffectRequested` commit in one ordered transaction. Pending cancellation commits a terminal outbox outcome before restart can drain it. Active cancellation and wall-time expiry wait for the authoritative provider outcome; unresolved execution becomes `unknown` with conservative settlement, while a retained terminal race is reconstructed from the canonical effect outcome and a successful race keeps exact provider usage. Known exact catalog prices reserve estimated input plus bounded output cost without exceeding the call cap; unknown pricing reserves the full call cap. Read-only SQL context retains the trusted shared-database diagnostic boundary and is not a family-confidential query surface.
- Remaining: Typed full-agent output contracts and the branch-aware console execution pool remain later phases. Live external-provider behavior remains credential-gated.

### 2026-08-11 — Typed agent invocation contracts and results
- Completed: Added immutable text/object invocation contracts, parameterized two-tool agent dispatch, typed finish/violation/result events, strict reducer and rebuild parity, schema and inline-result validation, goal-gated object completion, durable result references through task completion and terminal notices, scoped protocol lookup, and typed console `agents.run`, `runMany`, detached `spawn`, and `result`. Independent review hardened malformed and reordered event rejection, atomic batch admission, stable retries, terminal-delivery recovery, one-time child usage attribution, strict public input and timeout validation, model-selection typing, and credential-safe refinement evidence.
- Validation: Focused agent-run, family-agent, raw-generation, model-response, recovery, refinement, profile-governance, terminal UI, and OpenTUI tests passed (225 tests total); `bun run typecheck`; `bun run check:architecture`; `git diff --check`.
- Plan notes: Existing unpinned runs retain legacy text semantics. New text runs pin an invocation contract and commit a compact result reference without changing the retained v1 text action event. Object runs use the additive typed finish event and require the exact finish, assistant message, result, and status order; completion goals validate before the successful typed suffix.
- Remaining: Awaited child execution still requires the branch-aware console pool. Broad model guidance, public documentation, installed-product coverage, aggregate verification, and external checks remain later phases.

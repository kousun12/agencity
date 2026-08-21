# Agencity: agents should grow into organizations

An autonomous agent should not have to rebuild its team every time it receives a task.

Today, most agent systems begin with one model, one prompt, and a temporary set of helpers. The model may delegate work, but the resulting organization usually disappears when the task ends. The next task starts again from a general-purpose agent that has to rediscover which specialists it needs, what each specialist should know, and how their work should fit together.

Agencity explores a different long-term model: a workspace could contain a durable organization of agents that learns who should do what. The current product provides durable agent families and governed per-session behavioral profiles, not an organization control plane.

Such an organization could begin with one general operator. As work accumulates, it could retain useful specialists, revise their responsibilities, route recurring tasks to them, split overloaded functions, create successors, and retire roles that no longer help. These changes should not happen because a model confidently declares that a reorganization is a good idea. They should happen through retained evidence, bounded trials where appropriate, explicit authority, and reversible decisions where reversal is possible.

This is the idea behind the name **Agencity**: not a swarm of anonymous model calls, but a long-lived institution of separately identified agents whose purposes, work, relationships, and changes remain inspectable.

## The prior art: agents that program and improve themselves

[Prime Agent](https://www.primeintellect.ai/blog/prime-agent) introduced a compelling combination of two ideas:

- A **Recursive Language Model (RLM)** treats context as data. The model writes programs that inspect and transform that data, call other models, use tools, and combine results.
- A **Continual Harness** lets the agent improve its prompt notes, memories, skills, and reusable subagent definitions from experience.

Together, these ideas move the model beyond a fixed loop in which it chooses one tool at a time. The agent can construct the computation it needs and improve the harness that shapes future work.

Agencity starts from this prior art. It is not a compatibility port of Prime Agent, and it does not preserve Prime Agent's Python modules, file formats, extension APIs, or Python kernel as durable agent identity. It asks a related systems question:

> What would an RLM and continual harness look like if agents, relationships, assignments, evidence, and organizational change all had durable identities?

The answer begins with technical changes to the individual agent runtime. Agencity has implemented that foundation. Extending adaptation from one agent's harness to the structure of an agent organization remains a separate, speculative direction.

## First, make the agent durable

A model can write useful programs without making a live language process the source of its identity.

Agencity gives the model one general generated-execution surface: a Bun TypeScript console. Each autonomous provider turn must choose exactly one formal action: `bun_console` to propose a TypeScript cell or `finish` to return a typed terminal outcome. The runtime validates and commits that action before applying it.

Each exact session branch has a persistent REPL namespace while its worker remains alive, so top-level variables, functions, classes, imports, closures, and object identity can be reused across nearby cells. SQL, files, shell and managed-process effects, artifacts, explicit raw model calls, memory, skills, and subagents are typed APIs inside that environment. They are not additional provider tools. The model can filter data, run concurrent investigations, delegate work, and aggregate results as a program rather than selecting from an ever-growing menu of special-purpose provider actions.

For example:

```ts
const eventCounts = await sql`
  SELECT type, count(*) AS occurrences
  FROM events
  WHERE session_id = ${session.id}
  GROUP BY type
  ORDER BY occurrences DESC
`;

const investigations = await Promise.all(
  eventCounts.slice(0, 4).map((entry) =>
    sdk.agents.spawn({
      task: `Inspect recent ${entry.type} events and return attributable evidence.`,
      idempotencyKey: `event-review-${entry.type}`,
    })
  ),
);

await state.set("eventInvestigations", investigations);
return investigations;
```

The REPL namespace is useful but disposable. Top-level bindings remain available to later cells on the same live branch worker without an explicit cache API, but they do not own the agent. Each worker generation has a random authoritative epoch ID and a readable name. Before every autonomous model call, Agencity reports the exact branch as cold or as that warm named epoch and retains the same status with the model attempt. Before a submitted cell runs, Agencity compares the pin with current worker status. If the namespace changed in between, the source does not run; a typed `REPL_EPOCH_CHANGED` observation tells the next model step to rebuild only the required bindings.

Values required after worker loss are committed as typed state, stored as immutable artifacts, or represented by durable handles. A cell's final expression or explicit return remains a separate bounded observation for the next model decision. If the worker exits, another worker can reconstruct the committed work, not the arbitrary heap. Agencity does not automatically replay old cells because they may have edited files, started commands, or called external services.

This is more than a language change from Python to TypeScript. Agencity separates temporary computation from durable identity:

- agent sessions, branches, tasks, messages, goals, and budgets are retained;
- TypeScript cells and their bounded observations are retained;
- live REPL bindings accelerate nearby work but remain noncanonical and replaceable;
- model and tool requests are recorded before execution;
- subagents are durable sessions rather than anonymous returned strings;
- exact context and harness provenance can be inspected later;
- canonical history is append-only and projections are rebuildable.

Recovery therefore means reconstructing state from committed records, not preserving an arbitrary process heap forever.

## Context becomes institutional memory

A long-running organization can accumulate far more information than any model should receive in one prompt.

Agencity stores conversation, execution, tasks, artifacts, memories, relationships, and harness versions as queryable data. Each model call receives a bounded projection of what matters for the current work. The agent can then use SQL and typed APIs to retrieve more detail deliberately.

Autonomous provider input grows as an append-only transcript segment. Each continued step preserves the prior provider-neutral messages as an exact prefix, then appends the assistant tool call or rejection, its durable observation, changed durable-state facts, and the next-action instruction. Compaction starts an attributable segment reset rather than rewriting canonical history. Repository `AGENTS.md` instructions loaded through the supported path also retain bounded source, digest, size, and completeness provenance.

Compaction remains useful, but it is a derived view rather than a destructive replacement for evidence. Earlier events remain available. A later investigation can ask:

- What did this agent know when it made this decision?
- Which profile and prompt versions governed the run?
- Which observations supported a specialization?
- Which agent produced an artifact?
- Which unresolved effect prevented a safe retry?

This changes the problem from fitting the institution into a prompt to selecting attributable context for one decision.

## Subagents become durable colleagues

Many systems treat a subagent as a function call: send a prompt, wait for text, discard the actor.

Agencity already uses durable sessions for delegated work. A child has a task, model, budget, profile, messages, artifacts, effects, and lifecycle. `sdk.agents.run` and `sdk.agents.runMany` await complete child work, while `sdk.agents.spawn` and `sdk.agents.spawnMany` return durable JSON handles whose results can be resolved after the console worker that created them is gone. A parent can inspect a child, receive its durable result, and later queue more work for the same retained child.

Raw model generation is deliberately different. `ai.generateText` and `ai.generateObject` perform one provider request over an explicit prompt and bounded explicit context. They do not create a child session, task, profile, mailbox, or family relationship, and they cannot continue autonomously. The former public `rlm` console surface is absent; retained recursive-model machinery remains internal for historical recovery and sealed workflows.

The proposed agent-city layer takes the next step. It distinguishes between two kinds of agent:

- A **task agent** exists for one bounded assignment. Its work remains in history, but it leaves active rotation when the assignment is resolved.
- A **standing agent** represents a recurring function. It can receive many assignments over time without pretending that its original creation task defines all future work.

This distinction prevents two common failures. The organization does not fill up with every temporary helper it has ever created, and it does not throw away a specialist that has become repeatedly useful.

Long-lived does not mean continuously running. An idle standing agent is dormant: no process, model connection, or console heap needs to remain alive. It is long-lived because its identity, purpose, history, and route can be reconstructed when new work arrives.

## Every agent has a durable profile

A task says what to do now. It does not fully define who should do it.

Agencity gives every runnable session one immutable, versioned **agent profile**. The profile records:

- the agent's role and purpose;
- its exact agent-specific behavioral instructions and prompt text;
- the source and provenance of that profile version.

Every autonomous or retained recursive invocation pins one exact profile version and the resulting effective system-prompt provenance. An authorized agent, direct parent, or workspace owner may propose a future profile version. Deterministic validation and one separate sealed reviewer decide whether the proposal may activate; the runtime revalidates it at application time. A later activation applies only to future invocations. Historical work continues to resolve the prompt that actually governed it.

Profiles do not replace tasks, memory, skills, goals, gates, or current observations. They give durable behavioral identity to the actor receiving those inputs. A coding agent can keep the same purpose while receiving many different tasks. New work does not silently rewrite its identity, and a profile revision does not reinterpret earlier work.

A future organization layer would need more than the current profile: explicit responsibilities and exclusions, routing eligibility, management relationships, delegation and escalation conventions, and lifecycle state. This essay calls that richer organizational record a **charter**. It is not implemented.

Neither a profile nor a future charter is a security sandbox. It describes expected behavior. Enforceable model, budget, credential, SDK, and effect access remains separate typed runtime policy. An agent cannot grant authority merely by writing broader words into another agent's prompt.

## A future operator could be the stable front door

The ordinary user experience should address the organization, not manage session IDs.

```sh
agencity "find and fix the flaky test"
```

The current product has no distinguished workspace operator. A workspace may contain multiple independent roots, and the remembered product selection determines which root receives ordinary no-ID work. Selecting or opening another root changes that remembered route.

In a future city model, each workspace could instead have one distinguished **operator**. The operator would be a durable agent with its own profile and organizational charter. It would receive ordinary inbound work and consult a bounded directory of the active organization.

For a new request, the operator can:

1. route the task to an existing agent whose charter and evidence fit;
2. coordinate several existing functions;
3. create a bounded task agent for isolated work;
4. propose a standing specialist when recurring demand justifies one;
5. escalate when the decision requires broader user authority.

The operator would not receive every agent's complete history in its prompt. It would see directory summaries and could query exact charters or evidence when needed. Any narrower visibility would require enforceable authorization. In the current trusted-local runtime, scope filtering guides model behavior, while read-only SQL remains a shared diagnostic surface rather than a confidentiality boundary.

The current product resumes the remembered root or presents a human-readable root selector when necessary:

```sh
agencity
```

Maintained session titles and bounded intent summaries make those roots and their family routes easier to identify. A future operator model could separate navigation from the workspace's default inbound route, but that separation does not exist today.

## A future organization would need assignments

Repeated work sent to an existing agent needs more structure than a queued mailbox message.

The current runtime supports durable tasks for child creation and queued or steering messages within one root's creation family. It does not route work across unrelated root families.

A future city could use durable **assignments** for that broader work. An assignment would record:

- who sponsored the work;
- which agent and route received it;
- the task, inputs, and completion criteria;
- reserved token, cost, turn, and time budgets;
- goals and completion gates;
- cancellation and steering;
- usage, artifacts, result delivery, and terminal outcome;
- the routing decision and charter version used at admission.

Assignments would let standing agents perform many units of work while preserving separate accountability for each one. They would also provide a typed route for work across agent families without turning arbitrary cross-agent messaging into an authority mechanism.

If an agent were busy, later assignments could queue deterministically. If the runtime restarted, the queue and its budget reservations would remain. If the target were paused, retired, stale, or owned by an unavailable execution device, admission would fail visibly instead of guessing a substitute.

## The organization should adapt from evidence

A continual harness improves how an agent works. Agencity already governs profile, memory, prompt-note, skill, and subagent-specification changes through immutable proposals, deterministic validation, one separate sealed reviewer, application-time revalidation, automatic activation or rejection, retained evaluation intent, attributable post-activation evidence when gathered, and rollback. Generated skills additionally compile and run their declared tests before activation. Reviewer approval establishes policy consistency, not empirical improvement.

Automatic learning is enabled when the device profile has no explicit preference. Retained failure, correction, gate, and success triggers may open one bounded reflection, but a trigger is only permission to examine the evidence. `no_change` remains a valid result.

A future adaptive city could apply the same evidence and authority principles to how work is divided.

Repeated experience may show that:

- one temporary specialist is recreated for the same kind of work;
- a role has become overloaded;
- two agents have overlapping responsibilities;
- handoffs repeatedly fail;
- standing context has become stale;
- a specialist is rarely useful;
- a task has no suitable existing owner;
- a routing or delegation pattern improves quality, cost, or latency.

These observations can trigger an organization review. A trigger opens a question; it does not prove the answer.

The city could propose changes such as:

- creating a standing agent;
- revising a charter;
- pausing or resuming an agent;
- changing the active management relationship;
- splitting one function into narrower specialists;
- merging functions through a new successor;
- retiring an agent;
- replacing the operator with explicit user approval.

Each organization proposal should retain its trigger, supporting evidence, predicted effect, affected authority and budget, evaluation plan, exposure bounds, required decisions, and rollback or irreversibility statement.

Organization changes may require bounded trials and explicit user authority before activation. Routing changes should be judged by attributable outcomes rather than the router's confidence. Splits should reduce bottlenecks without creating unacceptable duplication. Retirement requires evidence that the function is covered and that active work, children, schedules, artifacts, and unresolved effects have been handled.

The broader or more destructive the change, the stronger the evidence and authority it requires.

This is self-improvement without silent self-redefinition.

## Future organization history should remain attributable

An adaptive organization needs to distinguish several relationships that are easy to blur.

**Creation ancestry** records how an agent came into existence. It never changes.

**Management hierarchy** records who currently manages a function. It can change through a versioned, validated decision.

**Assignments** record who sponsored a particular unit of work.

**Successor lineage** records that a new identity continues, splits, merges, or inherits a prior function.

Changing one relationship does not silently rewrite the others. Reparenting an agent does not change who created it. A successor does not inherit ownership of its predecessor's statements. A manager does not gain access to all descendant history merely because it sits higher in the organization.

City-wide changes would also need a durable home that is independent of any one conversation. A future architecture could add a workspace control stream for operator identity, active charters, management, lifecycle, assignments, and organization decisions. Conversation branches would remain agent histories. A branch should not become the accidental owner of the organization just because an operator happened to discuss a change there.

## Future retirement should preserve what happened

An organization that can create agents must also be able to stop using them.

Pausing is reversible. Retirement is terminal for one agent identity. A retired agent receives no new assignments, schedules, queued messages, or autonomous runs. It leaves normal routing and the active organization view.

Its history remains:

- every charter version and exact prompt;
- creation and management lineage;
- tasks, branches, effects, artifacts, and evaluations;
- the retirement reason and decision authority;
- unresolved external outcomes;
- successor links.

If the function later returns, the city creates a successor with explicit lineage. It does not reactivate the old identity and make the historical meaning of retirement ambiguous.

Retirement is not physical deletion. Deletion is a separate owned-scope operation with dependency, replica, artifact, confirmation, and receipt requirements.

## Uncertainty remains visible

Durability is not only about successful recovery. It is also about preserving what the runtime cannot prove.

External effects can end in four durable states:

- succeeded;
- failed;
- cancelled;
- unknown.

An effect becomes unknown when the process may have performed external work but lost the evidence needed to prove the outcome. Retrying a non-idempotent request could duplicate a publication, deployment, payment, or mutation. Agencity does not convert unknown into failed merely to keep the loop moving.

The same rule should apply during future organizational change. Retiring an agent would not make its unresolved external effect disappear. Requesting cancellation does not prove that the external system stopped. Conflicting offline organization changes should remain explicit rather than being resolved through last-write-wins guesses.

An institution is trustworthy only if it can say what it does not know.

## Local first, without confusing placement and identity

Agencity's canonical workspace state lives in a local LibSQL database, with content-addressed artifacts stored separately. Local operation does not require a hosted service. Optional Turso synchronization exchanges immutable envelopes while preserving identifiers and divergent history.

Placement does not define the agent. A session, profile, future charter, assignment, or relationship should keep the same identity whether its implementation is local or remote. Stronger infrastructure may add isolation, scheduling, or coordination capabilities. Weaker infrastructure must report unavailable behavior rather than silently weaken the contract.

Turso synchronization does not provide distributed scheduling, task stealing, automatic execution-owner failover, or artifact replication. One device owns execution of a session at a time, and divergent offline history is preserved rather than silently merged.

The current runtime is trusted-local. Model-generated TypeScript and shell commands run with the operating-system authority of the Agencity process. The separate Bun worker provides lifecycle and crash isolation, not containment against hostile code. A production multi-tenant city would require authenticated principals, isolated storage, external sandboxing, resource policy, and a separate deployment architecture.

## What exists today, and what comes next

Agencity already provides much of the durable runtime beneath this direction:

- a strict `bun_console` or `finish` autonomous action contract over a persistent TypeScript REPL;
- local relational event history and rebuildable projections;
- durable sessions, branches, tasks, goals, messages, and budgets;
- immutable per-session agent profiles with exact invocation and effective-prompt pins;
- governed profile and harness refinement with automatic learning, sealed review, activation, and rollback;
- outbox-backed model, shell, managed-process, file, and skill effects;
- retained child agents, durable handles, family communication, and separate explicit raw AI generation;
- exact provider-input records, append-only transcript segments, bounded observations, and attributable compaction resets;
- bounded repository-instruction loading with exact source provenance;
- a no-ID terminal entrypoint, maintained session titles, and a protocol-backed TUI;
- an authenticated, foreground, read-only Observe browser client for one process-wide selected initial-root family;
- explicit cancellation, recovery, and unknown-effect semantics.

The adaptive city described in this essay is a speculative future direction, not the committed next architecture or shipped behavior. Rich organizational charters beyond the implemented agent profile, a stable city operator, cross-family assignments to standing agents, a management hierarchy, organization proposals, evidence-based splits and successors, and retirement archives remain unavailable.

That distinction matters. A durable agent runtime is the foundation for an adaptive organization, but it is not evidence that the organization already exists.

## The direction

Prime Agent showed how an agent can program over its own context and improve its harness through experience.

Agencity extends that direction in two ways.

First, it makes computation disposable while retaining agent identity, context provenance, effects, relationships, and uncertainty in durable relational history.

Second, it explores treating the organization itself as adaptable state if retained product evidence justifies that added control plane. In that possible future, roles become explicit charters, repeated work becomes assignments, useful specialists become standing agents, temporary helpers leave active rotation, structural changes require evidence and authority, and retirement preserves history. The user could address one stable operator while the organization behind it becomes more specialized over time.

The goal is not an ever-growing bureaucracy of agents. It is a bounded organization that can learn the right shape for the work.

Programs may be temporary. Agents may come and go. The institution should remember what it learned, why it changed, and who remains responsible.

## References

- Prime Intellect, [“Prime Agent: A self-improving RLM agent”](https://www.primeintellect.ai/blog/prime-agent)
- Prime Intellect, [`PrimeIntellect-ai/prime-agent`](https://github.com/PrimeIntellect-ai/prime-agent)
- Alex L. Zhang, Tim Kraska, and Omar Khattab, [“Recursive Language Models”](https://arxiv.org/abs/2512.24601)
- Seth Karten et al., [“Continual Harness: Online Adaptation for Self-Improving Foundation Agents”](https://arxiv.org/abs/2605.09998)
- Agencity, [“Durable agent profiles and automated refinement review plan”](../../plans/2026-08-08-adaptive-agent-city-plan.md)
- Agencity, [“Agencity Observe plan”](../../plans/2026-08-19-agencity-observe-prd-and-plan.md)

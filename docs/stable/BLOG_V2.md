# Agencity: agents should grow into organizations

An autonomous agent should not have to rebuild its team every time it receives a task.

Today, most agent systems begin with one model, one prompt, and a temporary set of helpers. The model may delegate work, but the resulting organization usually disappears when the task ends. The next task starts again from a general-purpose agent that has to rediscover which specialists it needs, what each specialist should know, and how their work should fit together.

Agencity is being developed toward a different model: a workspace should contain a durable organization of agents that learns who should do what.

That organization can begin with one general operator. As work accumulates, it can retain useful specialists, revise their responsibilities, route recurring tasks to them, split overloaded functions, create successors, and retire roles that no longer help. These changes should not happen because a model confidently declares that a reorganization is a good idea. They should happen through retained evidence, bounded trials, explicit authority, and reversible decisions where reversal is possible.

This is the idea behind the name **Agencity**: not a swarm of anonymous model calls, but a long-lived institution of separately identified agents whose purposes, work, relationships, and changes remain inspectable.

## The prior art: agents that program and improve themselves

[Prime Agent](https://www.primeintellect.ai/blog/prime-agent) introduced a compelling combination of two ideas:

- A **Recursive Language Model (RLM)** treats context as data. The model writes programs that inspect and transform that data, call other models, use tools, and combine results.
- A **Continual Harness** lets the agent improve its prompt notes, memories, skills, and reusable subagent definitions from experience.

Together, these ideas move the model beyond a fixed loop in which it chooses one tool at a time. The agent can construct the computation it needs and improve the harness that shapes future work.

Agencity starts from this prior art. It is not a compatibility port of Prime Agent, and it does not preserve Prime Agent's Python modules, file formats, extension APIs, or persistent-kernel architecture. It asks a related systems question:

> What would an RLM and continual harness look like if agents, relationships, assignments, evidence, and organizational change all had durable identities?

The answer begins with technical changes to the individual agent runtime. It then extends adaptation from one agent's harness to the structure of the agent organization itself.

## First, make the agent durable

A model can write useful programs without making a live language process the source of its identity.

Agencity gives the model one general generated-execution surface: a Bun TypeScript console. SQL, files, shell effects, artifacts, model calls, memory, skills, and subagents are typed APIs inside that environment. The model can filter data, run concurrent investigations, delegate work, and aggregate results as a program rather than selecting from an ever-growing menu of special-purpose tools.

For example:

```ts
const failures = await sql`
  SELECT tool_name, error_code, count(*) AS occurrences
  FROM failed_tool_calls
  GROUP BY tool_name, error_code
`;

const investigations = await rlm.startMany(
  failures.map((failure) => ({
    task: "Investigate this repeated failure and return evidence.",
    input: failure,
  })),
);

await state.set("failureInvestigations", investigations);
return investigations;
```

The TypeScript worker is disposable. Its heap can make a healthy run faster, but it does not own the agent. Values needed later are committed as typed state, stored as immutable artifacts, or represented by durable handles. If the worker exits, another worker can reconstruct the committed work.

This is more than a language change from Python to TypeScript. Agencity separates temporary computation from durable identity:

- agent sessions, branches, tasks, messages, goals, and budgets are retained;
- TypeScript cells and their bounded observations are retained;
- model and tool requests are recorded before execution;
- subagents are durable sessions rather than anonymous returned strings;
- exact context and harness provenance can be inspected later;
- canonical history is append-only and projections are rebuildable.

Recovery therefore means reconstructing state from committed records, not preserving an arbitrary process heap forever.

## Context becomes institutional memory

A long-running organization can accumulate far more information than any model should receive in one prompt.

Agencity stores conversation, execution, tasks, artifacts, memories, relationships, and harness versions as queryable data. Each model call receives a bounded projection of what matters for the current work. The agent can then use SQL and typed APIs to retrieve more detail deliberately.

Compaction remains useful, but it is a derived view rather than a destructive replacement for evidence. Earlier events remain available. A later investigation can ask:

- What did this agent know when it made this decision?
- Which charter and prompt versions governed the run?
- Which observations supported a specialization?
- Which agent produced an artifact?
- Which unresolved effect prevented a safe retry?

This changes the problem from fitting the institution into a prompt to selecting attributable context for one decision.

## Subagents become durable colleagues

Many systems treat a subagent as a function call: send a prompt, wait for text, discard the actor.

Agencity already uses durable sessions for delegated and recursive work. A child has a task, model, budget, messages, artifacts, effects, and lifecycle. A parent can inspect its progress, receive a durable result, and later follow up with the same retained child. Recursive model calls use the same foundation and return handles that survive the console worker that created them.

The proposed agent-city layer takes the next step. It distinguishes between two kinds of agent:

- A **task agent** exists for one bounded assignment. Its work remains in history, but it leaves active rotation when the assignment is resolved.
- A **standing agent** represents a recurring function. It can receive many assignments over time without pretending that its original creation task defines all future work.

This distinction prevents two common failures. The organization does not fill up with every temporary helper it has ever created, and it does not throw away a specialist that has become repeatedly useful.

Long-lived does not mean continuously running. An idle standing agent is dormant: no process, model connection, or console heap needs to remain alive. It is long-lived because its identity, purpose, history, and route can be reconstructed when new work arrives.

## Every agent needs a charter

A task says what to do now. It does not fully define who should do it.

The proposed city architecture gives every runnable agent an immutable, versioned **charter**. A charter records:

- the agent's name, role, and mission;
- its responsibilities and explicit exclusions;
- standing context that should accompany every run;
- operating principles and success criteria;
- delegation and escalation rules;
- its behavioral authority envelope;
- routing information that says when the agent is a suitable target;
- the exact agent-specific system-prompt text supplied to the model.

Every run pins one exact charter version. If a parent later revises a child's charter, the new version applies only to future work. Historical runs continue to resolve the prompt that actually governed them.

Charters do not replace tasks, memory, skills, or current observations. They give durable identity to the actor receiving those inputs. A coding agent can keep the same mission while receiving many different implementation assignments. A new assignment does not silently rewrite its identity, and a charter revision does not reinterpret its earlier work.

A charter is also not a security sandbox. It describes expected behavior. Enforceable model, budget, credential, SDK, and effect access remains separate typed runtime policy. An agent cannot grant authority merely by writing broader words into another agent's prompt.

## The operator is the stable front door

The ordinary user experience should address the organization, not manage session IDs.

```sh
agencity "find and fix the flaky test"
```

In the proposed city model, each workspace has one distinguished **operator**. The operator is a durable agent with its own charter. It receives ordinary inbound work and consults a bounded directory of the active organization.

For a new request, the operator can:

1. route the task to an existing agent whose charter and evidence fit;
2. coordinate several existing functions;
3. create a bounded task agent for isolated work;
4. propose a standing specialist when recurring demand justifies one;
5. escalate when the decision requires broader user authority.

The operator does not receive every agent's complete history in its prompt. It sees directory summaries and can query exact charters or evidence when needed. Visibility does not grant unrestricted access to conversations, artifacts, credentials, or effects.

Returning to the workspace should enter the same institution:

```sh
agencity
```

A user may navigate directly to any retained agent or branch, but opening another route does not silently replace the operator as the default recipient of later work.

## Work moves through assignments, not loose messages

Repeated work sent to an existing agent needs more structure than a follow-up chat message.

The proposed city uses durable **assignments**. An assignment records:

- who sponsored the work;
- which agent and route received it;
- the task, inputs, and completion criteria;
- reserved token, cost, turn, and time budgets;
- goals and completion gates;
- cancellation and steering;
- usage, artifacts, result delivery, and terminal outcome;
- the routing decision and charter version used at admission.

Assignments let standing agents perform many units of work while preserving separate accountability for each one. They also provide a typed route for work across agent families without turning arbitrary cross-agent messaging into an authority mechanism.

If an agent is busy, later assignments can queue deterministically. If the runtime restarts, the queue and its budget reservations remain. If the target is paused, retired, stale, or owned by an unavailable execution device, admission fails visibly instead of guessing a substitute.

## The organization should adapt from evidence

A continual harness improves how an agent works. An adaptive city also improves how work is divided.

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

The city can propose changes such as:

- creating a standing agent;
- revising a charter;
- pausing or resuming an agent;
- changing the active management relationship;
- splitting one function into narrower specialists;
- merging functions through a new successor;
- retiring an agent;
- replacing the operator with explicit user approval.

Each proposal retains its trigger, supporting evidence, predicted effect, affected authority and budget, evaluation plan, exposure bounds, required approvals, and rollback or irreversibility statement.

Behavioral changes run through bounded candidate work before promotion. Routing changes are judged by attributable outcomes rather than the router's confidence. Splits should reduce bottlenecks without creating unacceptable duplication. Retirement requires evidence that the function is covered and that active work, children, schedules, artifacts, and unresolved effects have been handled.

The broader or more destructive the change, the stronger the evidence and authority it requires.

This is self-improvement without silent self-redefinition.

## Organization history is part of agent history

An adaptive organization needs to distinguish several relationships that are easy to blur.

**Creation ancestry** records how an agent came into existence. It never changes.

**Management hierarchy** records who currently manages a function. It can change through a versioned, validated decision.

**Assignments** record who sponsored a particular unit of work.

**Successor lineage** records that a new identity continues, splits, merges, or inherits a prior function.

Changing one relationship does not silently rewrite the others. Reparenting an agent does not change who created it. A successor does not inherit ownership of its predecessor's statements. A manager does not gain access to all descendant history merely because it sits higher in the organization.

City-wide changes also need a durable home that is independent of any one conversation. The proposed architecture adds a workspace control stream for operator identity, active charters, management, lifecycle, assignments, and organization decisions. Conversation branches remain agent histories. A branch cannot become the accidental owner of the organization just because an operator happened to discuss a change there.

## Retirement preserves what happened

An organization that can create agents must also be able to stop using them.

Pausing is reversible. Retirement is terminal for one agent identity. A retired agent receives no new assignments, schedules, follow-ups, or autonomous runs. It leaves normal routing and the active organization view.

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

The same rule applies during organizational change. Retiring an agent does not make its unresolved external effect disappear. Requesting cancellation does not prove that the external system stopped. Conflicting offline organization changes are retained as conflicts rather than resolved through last-write-wins guesses.

An institution is trustworthy only if it can say what it does not know.

## Local first, without confusing placement and identity

Agencity's canonical workspace state lives in a local LibSQL database, with content-addressed artifacts stored separately. Local operation does not require a hosted service. Optional Turso synchronization exchanges immutable envelopes while preserving identifiers and divergent history.

Placement does not define the agent. A session, charter, assignment, or relationship should keep the same identity whether its implementation is local or remote. Stronger infrastructure may add isolation, scheduling, or coordination capabilities. Weaker infrastructure must report unavailable behavior rather than silently weaken the contract.

The current runtime is trusted-local. Model-generated TypeScript and shell commands run with the operating-system authority of the Agencity process. The separate Bun worker provides lifecycle and crash isolation, not containment against hostile code. A production multi-tenant city would require authenticated principals, isolated storage, external sandboxing, resource policy, and a separate deployment architecture.

## What exists today, and what comes next

Agencity already provides much of the durable runtime beneath this direction:

- a TypeScript RLM execution surface;
- local relational event history and rebuildable projections;
- durable sessions, branches, tasks, goals, messages, and budgets;
- outbox-backed model, shell, file, and skill effects;
- retained recursive agents and family communication;
- attributable context, memory, prompt notes, skills, and refinement;
- a no-ID terminal entrypoint and protocol-backed TUI;
- explicit cancellation, recovery, and unknown-effect semantics.

The adaptive city described in this essay is a proposed next architecture, not shipped behavior. Required per-agent charters, the stable city operator, durable assignments to standing agents, a separate management hierarchy, organization proposals, evidence-based splits and successors, and retirement archives remain to be implemented and verified.

That distinction matters. A durable agent runtime is the foundation for an adaptive organization, but it is not evidence that the organization already exists.

## The direction

Prime Agent showed how an agent can program over its own context and improve its harness through experience.

Agencity extends that direction in two ways.

First, it makes computation disposable while retaining agent identity, context provenance, effects, relationships, and uncertainty in durable relational history.

Second, it treats the organization itself as adaptable state. Roles become explicit charters. Repeated work becomes assignments. Useful specialists become standing agents. Temporary helpers leave active rotation. Structural changes require evidence and authority. Retirement preserves history. The user addresses one stable operator while the organization behind it becomes more specialized over time.

The goal is not an ever-growing bureaucracy of agents. It is a bounded organization that can learn the right shape for the work.

Programs may be temporary. Agents may come and go. The institution should remember what it learned, why it changed, and who remains responsible.

## References

- Prime Intellect, [“Prime Agent: A self-improving RLM agent”](https://www.primeintellect.ai/blog/prime-agent)
- Prime Intellect, [`PrimeIntellect-ai/prime-agent`](https://github.com/PrimeIntellect-ai/prime-agent)
- Alex L. Zhang, Tim Kraska, and Omar Khattab, [“Recursive Language Models”](https://arxiv.org/abs/2512.24601)
- Seth Karten et al., [“Continual Harness: Online Adaptation for Self-Improving Foundation Agents”](https://arxiv.org/abs/2605.09998)
- Agencity, [“Adaptive agent city and organizational refactoring plan”](../../plans/2026-08-08-adaptive-agent-city-plan.md)

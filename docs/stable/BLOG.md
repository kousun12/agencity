# Agencity: durable agents that program their own context

Most coding agents are built around a conversational loop: assemble a prompt, ask a model what to do next, execute one tool call, append the result, and repeat. This works well for short tasks. It becomes strained when the work outlives one context window, one terminal, or one process.

Long-running agents need more than a larger transcript. They need a way to inspect and transform their own history, divide work into concurrent programs, retain useful subagents, recover after interruption, and improve their working methods without hiding where those changes came from.

[Prime Agent](https://www.primeintellect.ai/blog/prime-agent) introduced a compelling answer through two ideas:

- A **Recursive Language Model (RLM)** treats context as data and gives the model a programming environment in which model calls and tools are ordinary functions.
- A **Continual Harness** lets the agent revise its prompt notes, memories, skills, and subagent specifications from experience.

Agencity starts from those ideas and takes them in a different systems direction. It uses TypeScript and Bun for programmatic execution, and it moves durable agent identity out of a persistent language kernel and into a relational event history backed by local LibSQL/Turso storage.

The result is an agent whose programs may be temporary, but whose work is not.

## The agent is a program over its own context

In a conventional tool-calling harness, the runtime gives the model a fixed menu of actions. The model selects one action at a time, and the harness owns the control flow.

Agencity gives the model one general programmatic action surface: a TypeScript console. SQL, files, shell commands, artifacts, model calls, subagents, memory, and refinement are typed APIs available inside that console. The model can query data, transform it, launch concurrent work, and combine results using the same language.

For example, an agent investigating repeated failures can write a program shaped like this:

```ts
const failures = await sql`
  SELECT tool_name, error_code, count(*) AS occurrences
  FROM failed_tool_calls
  GROUP BY tool_name, error_code
`;

const investigations = await Promise.all(
  failures.slice(0, 4).map((failure) =>
    sdk.agents.spawn({
      task: `Investigate this repeated failure and return evidence: ${JSON.stringify(failure)}`,
      idempotencyKey: `failure-${failure.tool_name}-${failure.error_code}`,
    })
  ),
);

await state.set("failureInvestigations", investigations);
return investigations;
```

The important part is not TypeScript syntax. It is that the model can construct the orchestration it needs instead of choosing from a hard-coded planning ceremony. Fan-out, filtering, retries, aggregation, and delegation are programs the agent can inspect and change.

The runtime still controls authority. Generated code cannot write directly to canonical tables, widen its own permissions, or declare an effect successful. Typed commands validate mutations, and external work passes through durable effect requests.

## Context is data, not a shrinking transcript

An agent can accumulate far more information than should fit in one model call. Continually replaying everything is expensive and eventually impossible. Repeatedly summarizing everything can hide the evidence needed later.

Agencity stores conversations, cells, tool activity, tasks, messages, memories, and harness versions as queryable records. Large values live in content-addressed artifacts. The model receives a bounded projection of that state, then uses SQL and typed APIs to retrieve the details it needs.

Compaction remains useful, but a compacted summary is a derived view rather than a replacement for history. The original events remain available. Each model call records the exact context records and harness versions it received, so a later investigation can answer not only what the model said, but what it knew when it said it.

This changes long-context work from a prompt-packing problem into a context-selection problem.

## Durable state owns identity

Prime Agent uses persistent sessions and an IPython kernel. Agencity makes a stronger separation between durable state and live computation.

The TypeScript worker is disposable. Its heap may contain convenient variables, open modules, and cached objects, but none of those are part of the agent's identity. A value needed by later work must be committed as typed JSON, stored as an artifact, or represented by a durable handle.

Every meaningful boundary is recorded before dependent work proceeds:

- a user or agent message;
- a proposed and completed TypeScript cell;
- a model or tool request;
- an observed effect result;
- a child task and its messages;
- a memory or skill version;
- a goal, gate, cancellation, or refinement decision.

If the worker disappears, Agencity starts another one. If the supervisor stops, it reconstructs the session from retained state. If the terminal disconnects, the session does not become a different agent when the user returns.

Recovery is reconstruction, not an attempt to preserve an arbitrary JavaScript heap forever.

## Side effects can be uncertain

Agent runtimes often describe failure as a binary choice: an action succeeded or it did not. Real external work has a third possibility. A process can die after sending a request but before recording the response. Retrying may duplicate a payment, publication, deployment, or file mutation.

Agencity gives every external effect one of four durable outcomes:

- succeeded;
- failed;
- cancelled;
- unknown.

Unknown is not converted into failure for convenience. An idempotent action may be reconciled or retried under its contract. A non-idempotent action remains visibly unresolved until the user or agent obtains new evidence and chooses how to continue.

The same rule applies to cancellation. Requesting cancellation is not proof that an external system stopped. The terminal shows the difference between a cancellation request, an observed cancellation, and work whose final outcome is not known.

This is less reassuring than a false success message, and much safer.

## Subagents are retained relationships

Subagents in Agencity are not anonymous model calls whose only durable product is a returned string. Every subagent is a session with a parent, a task, a model configuration, budgets, messages, artifacts, and a lifecycle.

A parent can start several child sessions concurrently, continue its own work, inspect their progress, and receive their results through durable mailboxes. It can later queue more work for the same retained child instead of recreating its context from a summary. A child can reply to its parent, and sibling communication follows explicit family-scoped routing.

Recursive model calls use the same foundation. A call returns a durable handle after admission. That handle can be stored, inspected, cancelled, or resolved from a later cell—even after the worker that created it has gone away.

There is one coordination model for root agents, subagents, recursive calls, the UI, and recovery workers.

Durable relationships also open a longer-term direction. Useful specializations should not have to disappear and be rediscovered for every task; a workspace should be able to retain them and gradually develop a bounded, inspectable organization. Any such evolution must be driven by retained evidence, limited by explicit authority, and reversible where possible. The concrete organization model remains exploratory rather than shipped behavior.

## Autonomy is bounded and inspectable

A session may carry a goal, completion gates, token and cost limits, a turn limit, a timeout, and scheduled heartbeats. The supervisor can continue the run until the goal is complete, a bound is reached, the agent requests help, or an outcome blocks safe continuation.

Completion is not merely the model saying it is done. A coding task may require a test command, a workspace state check, or another durable gate. Failed gate output returns to the session as evidence for another attempt. A gate is evaluated against an attributable workspace version so stale success cannot silently approve later changes.

The terminal is a client of this lifecycle, not its owner. A user can inspect cells, tools, child sessions, budgets, and pending decisions; steer a run; request cancellation; detach; and later reconstruct the committed state.

## A harness that can change, with evidence

Agencity's continual harness contains prompt notes, memories, skills, and reusable subagent specifications. The agent can propose changes when it observes a repeated failure, a useful tactic, a stale belief, or a better delegation pattern.

Self-editing does not make a change correct. Refinement therefore has a staged lifecycle:

1. A trajectory provides the trigger and source evidence.
2. The agent proposes a scoped, versioned change.
3. The runtime validates its shape, authority, and conflicts.
4. The change runs as a bounded candidate.
5. An evaluator records observed outcomes.
6. The candidate is promoted, revised, rejected, or rolled back.

Local memories can use lighter evidence than shared skills. Broader changes require stronger evaluation and, where appropriate, explicit user approval. Executable skills require tests. Permission and safety policy remain outside the authority of the agent they constrain.

The goal is not uncontrolled self-modification. It is attributable adaptation: the system can explain what changed, why it changed, what evidence supported it, and how to reverse it.

## Local first, without making placement part of the agent model

Each workspace has a local database and content-addressed artifact store. Local execution does not require a cloud connection. Optional Turso synchronization can make retained sessions available across devices while preserving the same event, task, and artifact identities.

Offline synchronization does not create coordination guarantees that are not present. One device owns execution of a session at a time. If two devices advance the same history independently, Agencity preserves the work as separate branches instead of silently merging ownership or choosing a winner through last-write-wins storage behavior.

Other placements can implement the same behavioral contracts. A managed artifact store, isolated executor, or later PostgreSQL coordinator may add capabilities, but it must not silently change identifiers, causality, recovery, or model-facing behavior. Unsupported capabilities are reported as unavailable rather than approximated behind the user's back.

## Using Agencity

The ordinary product begins in a repository:

```sh
cd my-project
agencity "find and fix the flaky test"
```

Agencity resolves the workspace, creates or resumes the appropriate session, makes the selected model explicit, commits the task, and opens the terminal interface. The user does not need to create a database record manually or copy session and branch IDs.

The interface shows the conversation alongside the work that produced it: TypeScript cells, bounded observations, tool outcomes, child agents, budgets, goals, and unresolved effects. Internal IDs remain available for diagnostics and automation, but they are not the onboarding experience.

Returning later is the normal case:

```sh
agencity
```

An unambiguous workspace session resumes directly. When several sessions are plausible, Agencity asks the user to select one by name, task, model, status, and recent activity instead of guessing.

The same durable protocol supports non-interactive automation and other clients. A consumer loads a snapshot, remembers its cursor, and resumes the committed event stream after that cursor. Notifications are hints; the database remains the source of truth.

## The trust boundary

Agencity's first execution mode is trusted local. Model-generated TypeScript and shell commands run with the operating-system authority granted to the runtime. The Bun worker provides lifecycle and crash isolation, not a hostile-code sandbox.

That boundary is shown in the product rather than hidden in documentation. Provider credentials remain supervisor-side where supported, and their exact registered values are rejected or redacted on supported durable paths. Agencity does not attempt general secret discovery from names or string shapes, and these narrow checks plus path validation do not turn local execution into containment.

When stronger isolation is required, the complete runtime belongs inside a separately managed sandbox with explicit filesystem, network, resource, and credential policy.

## What we are claiming

Agencity does not claim benchmark improvements simply because it adopts a different harness. No benchmark result can be inferred from an architecture.

The claim is more concrete: an agent can have a programmatic action surface without making a language heap its durable identity; it can retain complete, queryable history without placing that history in every prompt; it can coordinate recursive work through ordinary durable sessions; and it can adapt its harness while preserving evidence, authority, and rollback.

Prime Agent showed why RLMs and continual harnesses are interesting. Agencity explores what those ideas look like when recovery, attribution, uncertainty, and placement are part of the model from the beginning.

The programs are temporary. The work, relationships, and reasons remain.

## References

- Prime Intellect, [“Prime Agent: A self-improving RLM agent”](https://www.primeintellect.ai/blog/prime-agent)
- Prime Intellect, [`PrimeIntellect-ai/prime-agent`](https://github.com/PrimeIntellect-ai/prime-agent)
- Alex L. Zhang, Tim Kraska, and Omar Khattab, [“Recursive Language Models”](https://arxiv.org/abs/2512.24601)
- Seth Karten et al., [“Continual Harness: Online Adaptation for Self-Improving Foundation Agents”](https://arxiv.org/abs/2605.09998)

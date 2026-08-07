# Agencity documentation

This index is the public documentation entrypoint. Start with the user guide for ordinary terminal use. Low-level references and implementation plans are separate so product behavior is not confused with project planning.

## Get started

- [Installation](./install.md) — supported source-checkout and local-link installation.
- [User guide](./user-guide.md) — first run, normal tasks, sessions, branches, and the terminal interface.
- [Configuration](./configuration.md) — paths, command options, providers, environment variables, and precedence.

## Use

- [User guide](./user-guide.md) — no-ID workflows and day-to-day controls.
- [Skills](./skills.md) — inspect, test, install, enable, disable, and remove reusable skills.

## Operate

- [Operator runbook](./operator-guide.md) — health checks, managed-service operation, sync, recovery, and incidents.
- [Data lifecycle](./data-lifecycle.md) — storage, backup, export, restore limits, and deletion.
- [Recovery](./recovery.md) — committed boundaries, crash handling, and unknown effects.
- [Security](./security.md) — the trusted-local boundary and deployment precautions.

## Integrate

- [TypeScript API](./api.md) — public package exports and runtime services.
- [Protocol](./protocol.md) — loopback HTTP, JSON, server-sent events, and client behavior.
- [Console SDK](./console-sdk.md) — model-facing TypeScript execution APIs.
- [Placement](./placement.md) — local and remote adapter contracts.

## Understand

- [Architecture](./architecture.md) — durable state, execution, storage, and capability boundaries.
- [Capabilities](./capabilities.md) — implemented, unavailable, and placement-dependent behavior.
- [Product thesis](./stable/BLOG.md) — why Agencity treats context and agent work as durable data.
- [Repository guide](../AGENTS.md) — canonical product direction, current status, and implementation rules.

## Reference

- [Configuration](./configuration.md) — runtime defaults and overrides.
- [Event schemas](./events.md) — canonical event headers and payloads.
- [Relational table registry](./mutable-tables.md) — authoritative, derived, and operational data.
- [Capabilities](./capabilities.md) — supported behavior and explicit limits.

## Decisions

- [Decision index](./decisions/README.md) — consequential architecture decisions and their status.

## Verification

- [Verification guide](./verification.md) — deterministic checks, external gates, and how to report skips.

## Implementation plans

- [Implementation plan index](../plans/README.md) — planning material. Plan names and internal ticket terms are historical project metadata, not user-facing concepts.

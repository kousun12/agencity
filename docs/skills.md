# Local skills and the unified catalog

**Trust boundary:** trusted-local; executable skills are not an OS sandbox

An Agencity skill is versioned TypeScript behavior that can be tested, activated,
invoked, disabled, and audited. Agencity exposes one catalog spanning
workspace-governed skills and separately
owned profile/global skills. Each product record has a human name, immutable
entry/version identity, canonical definition digest, scope, provenance, latest
test summary, and availability. Removed versions and prior invocations remain
retained and attributable.

## Product commands

```sh
agencity skills list
agencity skills show NAME_OR_ID
agencity skills test NAME_OR_ID
agencity skills disable NAME_OR_ID
agencity skills enable NAME_OR_ID
agencity skills remove NAME_OR_ID
agencity skills propose "package the repeated formatter workflow"
```

The TUI exposes the same catalog with `/skills` and
`/skills show|test|enable|disable|remove|propose`. Console code uses
`sdk.skills.list()`, `get(nameOrId)`, `invoke(nameOrId, input)`, `test(nameOrId)`,
and `propose(instructions, scope)`.

Resolution is deterministic: an exactly exposed candidate wins, followed by
session-local, workspace, user/global harness, and profile/global scope. A tie
at one precedence is a typed ambiguity rather than an incidental row-order
choice. Disabled and removed skills are omitted from normal model context and
name resolution, and exact-ID invocation is rejected too.

## Installing a local directory

A native bundle contains exactly two ordinary, non-symlink files:

```text
my-skill/
├── agencity-skill.json
└── skill.ts
```

Preview the directory and copy the exact source digest printed by the CLI:

```sh
agencity skills install ./my-skill --scope workspace   --confirmation <64-character-source-sha256>
agencity skills install ./my-skill --scope profile   --confirmation <64-character-source-sha256>
```

An interactive CLI prints the trusted-local warning and asks the user to type
the complete digest. Non-interactive installation fails unless
`--confirmation` exactly matches the bytes that were inspected. The parser
re-reads the bundle when installing, so a change after preview changes the
required digest. Directory, manifest, and source provenance plus both byte
digests are retained.

Inspected local-directory installation is an explicit owner management path.
Workspace installation retains the ADR-0002 candidate, test, allocation,
observation, and promotion lifecycle for compatibility. Profile installation
tests the staged immutable definition through the same skill outbox before
`ProfileStore.stageGlobalSkill`; a failed test can only produce a disabled row.

Agent-generated `skills propose` changes use the ordinary ADR-0012 governance
path: a trajectory proposer emits one typed candidate, deterministic validation
runs, one separate sealed reviewer approves or rejects it, and application-time
validation runs again. Approval stages the immutable skill but does not activate
it. Bun compilation and every declared runtime test execute through durable
outbox effects; only a passing retained report permits activation. Rejection,
review failure or unknown, stale state, compile failure, or test failure
activates nothing. Reviewer approval establishes policy consistency, not proof
that the skill improves later outcomes.

## Manifest schema version 1

Unknown fields are errors. A minimal manifest is:

```json
{
  "schemaVersion": 1,
  "name": "double-number",
  "description": "Doubles one numeric input.",
  "entry": "skill.ts",
  "runtime": "bun",
  "inputSchema": {
    "type": "object",
    "properties": { "value": { "type": "number" } },
    "required": ["value"],
    "additionalProperties": false
  },
  "permissions": [],
  "tests": [
    { "name": "doubles two", "input": { "value": 2 }, "expected": { "doubled": 4 } }
  ]
}
```

Names use bounded lower-kebab-case. Source is non-empty UTF-8 up to 512 KiB;
the manifest is at most 64 KiB. There must be 1–64 uniquely named tests. Input
schemas use the bounded subset `type`, `properties`, `required`,
`additionalProperties`, `items`, `enum`, `minLength`, `maxLength`, `pattern`,
`minimum`, and `maximum`. Permissions must be unique members of the runtime's
configured allowlist. Wildcards and authority/policy permissions are always
forbidden.

Absolute/traversing entries, URLs, package metadata, install hooks, assets,
directories, and symlinks are rejected. The format is Agencity-native and is
not compatible with package registries or other skill bundle formats.

## Execution and credentials

Every test and invocation goes through the durable `skill` outbox,
uses the same strict input schema and runtime permission allowlist, and runs
with the secret-stripped executor environment. Known brokered secret values and
recognizable raw credentials are rejected from manifests, source, provenance,
context, profile rows, and events. A credential reference is not permission.

These controls do **not** make skill TypeScript safe against hostile code.
Skills execute as trusted-local code with the OS authority of the Agencity
process. The worker is process/protocol isolation, not an OS sandbox. Inspect
source before confirming its digest, and run the entire runtime in an external
sandbox when hostile-code isolation is required.

## Lifecycle and compatibility

Disable and re-enable can repeat without a cycle limit and change only
availability; identity, version, definition digest, provenance, test evidence,
and invocation history remain unchanged. Each transition compares the exact
prior availability and append sequence, so concurrent retries of one intent
share one action while a stale competing transition fails instead of returning
a misleading post-state. Removal is terminal for that installed version but
does not delete history. Workspace actions are canonical
`SkillAvailabilityChanged` events ordered by canonical event sequence whose
table projection is rebuilt during recovery. Profile actions and versions
remain append-only in profile rowid sequence.

Install and governed proposal requests derive stable identities from the session, scope, inspected
manifest/source digests, and installer. Retrying after a durable boundary
resumes the same proposal, tests, observations, promotion, and import rather
than creating a duplicate governed lifecycle.

The caller cannot select the governance reviewer or supply its charter. The
reviewer uses the proposing route's current model, frozen product constitution
and policy, and `null` workspace-charter/user-constraint components. Skill
permissions remain runtime policy and cannot be widened by either proposer or
reviewer.

Native skill names use bounded lower-kebab-case at the initial harness proposal
boundary and are checked again during validation/activation. Retained harness
rows from older runtimes with invalid skill names stay visible in unavailable
management/history views for removal or rollback, but are quarantined from
context and invocation instead of poisoning catalog materialization.

Retained profile skill rows that predate the native bundle schema remain stored
without rewriting their original JSON. They appear only in management views as
quarantined compatibility records; they do not
enter normal context or invocation. Reinstall them as a native, tested bundle
to make them executable.

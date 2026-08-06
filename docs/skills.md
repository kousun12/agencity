# Local skills and the unified catalog

**Status:** FU-017 product surface implemented
**Trust boundary:** trusted-local; executable skills are not an OS sandbox

Agencity exposes one catalog spanning workspace harness skills and separately
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

Workspace installation uses the ordinary governed harness lifecycle: proposal,
validation, pre-exposure test, bounded allocations, exact-branch exposure,
post-exposure same-version retests, objective observations, and promotion.
Workspace promotion still requires two distinct allocations and distinct
durable evidence. Profile installation tests the staged immutable definition
through the same skill outbox before `ProfileStore.stageGlobalSkill`; a failed
test can only produce a disabled row.

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
not compatible with Prime Agent or package registries.

## Execution and credentials

Every test and invocation goes through the existing durable `skill` outbox,
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

Disable and re-enable change only availability; identity, version, definition
digest, provenance, test evidence, and invocation history remain unchanged.
Removal is terminal for that installed version but does not delete history.
Workspace actions are canonical `SkillAvailabilityChanged` events whose table
projection is rebuilt during recovery. Profile actions and versions remain
append-only in the profile store.

Legacy profile skill rows are migrated without rewriting their original JSON.
They appear only in management views as quarantined legacy records; they do not
enter normal context or invocation. Reinstall them as a native, tested bundle
to make them executable.

# Local skill bundles

**Status:** FU-017 first tranche (parser and import validation only)

**Trust boundary:** trusted-local

Agencity has a native, deliberately small local bundle format for moving one
TypeScript skill into a later installation flow. It is not compatible with
Prime Agent skills or another harness's packages.

This tranche only reads and validates a directory. It does **not** install,
activate, compile, test, import, or execute the TypeScript, and it is not yet
wired to `agencity skills`, the TUI, or the public runtime barrel. Those product
surfaces, explicit confirmation, durable provenance, enable/disable/remove,
and scope selection remain follow-up FU-017 work.

## Directory format

A bundle is a local directory containing exactly two ordinary files:

```text
my-skill/
├── agencity-skill.json
└── skill.ts
```

No other file or directory is accepted. In particular, bundles cannot contain
`package.json`, package-manager metadata, install/postinstall hooks, vendored
dependencies, source maps, or assets. The bundle directory, manifest, and
source cannot be symlinks. The manifest entry must be exactly `skill.ts`; an
absolute path, traversal, alternate filename, URL, npm specifier, or other
remote source is rejected. Resolved manifest and source paths must remain
inside the real bundle directory.

The source is UTF-8, non-empty, and at most 512 KiB. A later skill test/install
flow is responsible for compiling it and checking that it exports the runtime
entrypoint expected by the existing skill executor.

## Manifest schema version 1

Unknown fields are errors at every defined manifest, test-case, and input-schema
level. A minimal example is:

```json
{
  "schemaVersion": 1,
  "name": "double-number",
  "description": "Doubles one numeric input.",
  "entry": "skill.ts",
  "runtime": "bun",
  "inputSchema": {
    "type": "object",
    "properties": {
      "value": { "type": "number" }
    },
    "required": ["value"],
    "additionalProperties": false
  },
  "permissions": [],
  "tests": [
    {
      "name": "doubles two",
      "input": { "value": 2 },
      "expected": { "doubled": 4 }
    }
  ]
}
```

Rules and bounds:

- `schemaVersion` is exactly `1`.
- `name` is a trimmed, lower-kebab name of 1–64 characters.
- `description` is trimmed, non-empty, and at most 2 KiB.
- `entry` is exactly `skill.ts`; `runtime` is exactly `bun`.
- `inputSchema` is required and uses the subset enforced by the current skill
  runtime: `type`, `properties`, `required`, `additionalProperties`, `items`,
  `enum`, `minLength`, `maxLength`, `pattern`, `minimum`, and `maximum`.
  Schema nesting and collection sizes are bounded.
- `permissions` contains at most 32 unique, trimmed strings. The parser accepts
  a permission only when it appears in the caller-supplied runtime allowlist.
  The default allowlist is empty. Wildcard and immutable policy/authority names
  remain forbidden even if a caller mistakenly lists them.
- `tests` contains 1–64 uniquely named cases. Every case has `input` and exactly
  one of `expected` or a non-empty `expectedError`. Inputs and expected values
  must be finite JSON values.
- The manifest is valid UTF-8 and at most 64 KiB.

These constraints are intentionally stricter than, and produce a
`TypeScriptSkillDefinition` compatible with, existing harness validation. An
import cannot weaken the runtime permission allowlist or replace the governed
harness activation and test lifecycle.

## Read-only parser result

`parseSkillImportBundle` is defined in `src/runtime/skill-import.ts`. Its
`SkillImportBundle` result contains:

- schema version, bounded name, and a native `TypeScriptSkillDefinition`;
- canonical local-directory provenance;
- byte lengths and lowercase 64-character SHA-256 values for the exact
  manifest and source bytes read from disk; and
- trusted-local warning metadata with `requiresExplicitConfirmation: true`.

Hashes are computed over original bytes. Whitespace and line-ending changes
therefore change the relevant digest; JSON normalization is not involved. The
parser supplies evidence for a later durable import record, not authenticity
or a signature.

The parser has no subprocess, compiler, package-manager, dynamic import, or
skill invocation path. It performs only bounded filesystem reads, strict
validation, hashing, and construction of the return value.

## Credentials and authority

Both exact currently brokered secret values and recognizable raw credential
material are rejected from the manifest and source by Agencity's existing
security helpers. Credentials must never be embedded in a bundle. A reference
name is not authority, and importing a skill cannot add a permission.

Even after those checks, a skill is executable trusted-local TypeScript, **not
sandboxed code**. When a later product flow executes it, it has the OS authority
of the Agencity process, subject to the existing effect/environment handling.
A UI or CLI must display the returned warning, require explicit user
confirmation, and carry the runtime permission allowlist forward before it
creates any durable proposal or installation record.

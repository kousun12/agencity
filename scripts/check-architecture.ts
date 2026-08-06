import { mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "..");
const src = resolve(root, "src");
const violations: string[] = [];
const unix = (path: string): string => path.replaceAll("\\", "/");
const rel = (path: string, base = src): string => unix(relative(base, path));
const exists = async (path: string): Promise<boolean> => Bun.file(path).exists();

async function walk(directory: string, predicate: (name: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path, predicate));
    else if (predicate(entry.name)) files.push(path);
  }
  return files;
}

const sourceFiles = await walk(src, (name) => name.endsWith(".ts"));
const adapterFiles = new Set(["storage/libsql.ts", "storage/turso.ts"]);
const sdkModule = /^(?:@libsql(?:\/|$)|@turso(?:\/|$)|@tursodatabase(?:\/|$)|libsql(?:\/|$)|turso(?:\/|$))/i;
const modernSyncSdk = /^@tursodatabase\/sync(?:\/|$)/i;
const importSpecifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)["']([^"']+)["']/g;

for (const file of sourceFiles) {
  const source = await Bun.file(file).text();
  const fileRel = rel(file);

  // SDK imports and even side-effect/dynamic imports are legal only in the
  // concrete adapter. The declaration pass below separately catches public
  // signatures inferred from SDK types.
  for (const imported of source.matchAll(importSpecifier)) {
    const specifier = imported[1]!;
    if (sdkModule.test(specifier) && !adapterFiles.has(fileRel)) {
      violations.push(`${fileRel}: ${specifier} is confined to the LibSQL/Turso adapter`);
    }
    if (modernSyncSdk.test(specifier) && fileRel !== "storage/turso.ts") {
      violations.push(`${fileRel}: ${specifier} is confined specifically to storage/turso.ts`);
    }
  }

  // Domain semantics may use external value/schema libraries, but no internal
  // adapter, runtime, protocol, or UI module.
  if (fileRel.startsWith("domain/")) {
    for (const match of source.matchAll(importSpecifier)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) {
        if (specifier === "@prime-agent/runtime" ||
            specifier.startsWith("@prime-agent/runtime/") && specifier !== "@prime-agent/runtime/domain") {
          violations.push(`${fileRel}: domain must not import its package composition/adapters through ${specifier}`);
        }
        continue;
      }
      const target = resolve(dirname(file), specifier);
      const targetRel = rel(target);
      if (!targetRel.startsWith("domain/")) {
        violations.push(`${fileRel}: domain must not import internal non-domain module ${specifier} (${targetRel})`);
      }
    }
  }
}

interface PackageMetadata {
  readonly bin?: Record<string, string>;
  readonly exports?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
}
const packagePath = resolve(root, "package.json");
const packageJson = JSON.parse(await Bun.file(packagePath).text()) as PackageMetadata;
if (packageJson.dependencies?.["@tursodatabase/sync"] !== "0.7.2") {
  violations.push("package.json: @tursodatabase/sync must be pinned exactly to compatible version 0.7.2");
}
const expectedExports: Readonly<Record<string, string>> = {
  ".": "./src/index.ts",
  "./domain": "./src/domain/index.ts",
  "./storage": "./src/storage/index.ts",
  "./artifacts": "./src/artifacts/index.ts",
  "./executors": "./src/executors/index.ts",
  "./console": "./src/console/index.ts",
  "./runtime": "./src/runtime/index.ts",
  "./protocol": "./src/protocol/index.ts",
  "./security": "./src/security/index.ts",
  "./tui": "./src/tui/index.ts",
  "./sync": "./src/sync/index.ts",
  "./placement": "./src/placement/index.ts",
};
for (const [subpath, target] of Object.entries(expectedExports)) {
  if (packageJson.exports?.[subpath] !== target) {
    violations.push(`package.json: export ${subpath} must target ${target}`);
  }
  if (!await exists(resolve(root, target))) violations.push(`package.json: export target does not exist: ${target}`);
}
for (const subpath of Object.keys(packageJson.exports ?? {})) {
  if (!(subpath in expectedExports)) violations.push(`package.json: unclassified public export ${subpath}`);
}

const rootBarrel = await Bun.file(resolve(src, "index.ts")).text();
for (const [subpath, target] of Object.entries(expectedExports)) {
  if (subpath === ".") continue;
  const fromRoot = `./${target.replace(/^\.\/src\//, "")}`;
  if (!rootBarrel.includes(`export * from "${fromRoot}"`) && !rootBarrel.includes(`export * from '${fromRoot}'`)) {
    violations.push(`src/index.ts: missing root barrel export for ${subpath} (${fromRoot})`);
  }
}
const expectedBarrelMembers: Readonly<Record<string, readonly string[]>> = {
  "domain/index.ts": ["errors.ts", "events.ts", "json.ts", "state.ts", "reducer.ts"],
  "storage/index.ts": ["contract.ts", "libsql.ts", "turso.ts"],
  "artifacts/index.ts": ["store.ts"],
  "executors/index.ts": ["contract.ts", "shell.ts", "file.ts", "model.ts"],
  "console/index.ts": ["sdk.ts", "process.ts"],
  "runtime/index.ts": ["supervisor.ts", "projection.ts", "context.ts", "model-loop.ts", "outbox.ts"],
  "protocol/index.ts": ["types.ts", "server.ts", "client.ts"],
  "security/index.ts": ["scrub.ts"],
  "placement/index.ts": ["capabilities.ts", "relational.ts", "object-cas.ts", "candidate-index.ts", "executor.ts"],
};
for (const [barrel, members] of Object.entries(expectedBarrelMembers)) {
  const source = await Bun.file(resolve(src, barrel)).text();
  for (const member of members) {
    if (!source.includes(`export * from "./${member}"`) && !source.includes(`export * from './${member}'`)) {
      violations.push(`src/${barrel}: missing public export for ./${member}`);
    }
  }
}

if (packageJson.bin?.agencity !== "./src/cli.ts") {
  violations.push("package.json: bin.agencity must target ./src/cli.ts");
}
for (const [name, target] of Object.entries(packageJson.bin ?? {})) {
  const path = resolve(root, target);
  if (!await exists(path)) violations.push(`package.json: executable ${name} target does not exist: ${target}`);
  else if (!(await Bun.file(path).text()).startsWith("#!/usr/bin/env bun")) {
    violations.push(`package.json: executable ${name} target must have a Bun shebang: ${target}`);
  }
}
const scripts = packageJson.scripts ?? {};
if (!scripts.typecheck?.includes("tsc") || !scripts.typecheck.includes("--noEmit")) {
  violations.push("package.json: typecheck script must run tsc --noEmit");
}
if (!scripts["check:architecture"]?.includes("scripts/check-architecture.ts")) {
  violations.push("package.json: check:architecture must run scripts/check-architecture.ts");
}
for (const gate of ["typecheck", "check:architecture", "test"]) {
  if (!scripts.verify?.includes(gate)) violations.push(`package.json: verify script must include ${gate}`);
}

const migrationsDirectory = resolve(src, "storage/migrations");
const migrationFiles = (await readdir(migrationsDirectory).catch(() => []))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migrationVersions: number[] = [];
const migrationSources: Array<{ name: string; source: string }> = [];
for (const name of migrationFiles) {
  const match = /^(\d+)_([a-z0-9][a-z0-9_-]*)\.sql$/i.exec(name);
  if (!match) {
    violations.push(`migration: filename must be <number>_<name>.sql: ${name}`);
    continue;
  }
  migrationVersions.push(Number(match[1]));
  migrationSources.push({ name, source: await Bun.file(resolve(migrationsDirectory, name)).text() });
}
if (migrationVersions.length === 0 || migrationVersions[0] !== 1) violations.push("migration: version 1 is required");
if (new Set(migrationVersions).size !== migrationVersions.length) violations.push("migration: duplicate migration version");
for (let index = 0; index < migrationVersions.length; index++) {
  if (migrationVersions[index] !== index + 1) {
    violations.push(`migration: versions must be contiguous from 1 (found ${migrationVersions.join(", ")})`);
    break;
  }
}
const allMigrationSql = migrationSources.map(({ source }) => source).join("\n")
  .replace(/--[^\n]*/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const migratedTables = new Set<string>();
for (const match of allMigrationSql.matchAll(/\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
  migratedTables.add(match[1]!.toLowerCase());
}
if (/\bAUTOINCREMENT\b/i.test(allMigrationSql)) migratedTables.add("sqlite_sequence");

const validClassMutability: Readonly<Record<string, "mutable" | "immutable">> = {
  "canonical-append-only": "immutable",
  "immutable-derived": "immutable",
  "rebuildable-projection": "mutable",
  "operational-projection": "mutable",
  "migration-metadata": "mutable",
  "engine-metadata": "mutable",
};
interface TableClassification { readonly classification: string; readonly mutability: string }
const mutableTableDocument = resolve(root, "docs/mutable-tables.md");
const tableDocumentSource = await Bun.file(mutableTableDocument).text();
const classifications = new Map<string, TableClassification>();
const registryRow = /^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|\s*`([a-z-]+)`\s*\|\s*`(mutable|immutable)`\s*\|/gm;
for (const match of tableDocumentSource.matchAll(registryRow)) {
  const table = match[1]!.toLowerCase();
  if (classifications.has(table)) violations.push(`docs/mutable-tables.md: duplicate registry row for ${table}`);
  classifications.set(table, { classification: match[2]!, mutability: match[3]! });
}
for (const table of migratedTables) {
  const entry = classifications.get(table);
  if (!entry) {
    violations.push(`docs/mutable-tables.md: migration table ${table} has no classification row`);
    continue;
  }
  const expectedMutability = validClassMutability[entry.classification];
  if (!expectedMutability) violations.push(`docs/mutable-tables.md: ${table} has unknown class ${entry.classification}`);
  else if (entry.mutability !== expectedMutability) {
    violations.push(`docs/mutable-tables.md: ${table} class ${entry.classification} must be ${expectedMutability}`);
  }
}
for (const table of classifications.keys()) {
  if (!migratedTables.has(table)) violations.push(`docs/mutable-tables.md: stale/unknown registry table ${table}`);
}
const requiredClassifications: Readonly<Record<string, string>> = {
  events: "canonical-append-only",
  context_records: "immutable-derived",
  sessions: "rebuildable-projection",
  branches: "rebuildable-projection",
  snapshots: "rebuildable-projection",
  outbox: "operational-projection",
  schema_migrations: "migration-metadata",
  sqlite_sequence: "engine-metadata",
};
for (const [table, classification] of Object.entries(requiredClassifications)) {
  if (classifications.get(table)?.classification !== classification) {
    violations.push(`docs/mutable-tables.md: ${table} must be classified ${classification}`);
  }
}

const immutableTables = [...classifications.entries()]
  .filter(([, entry]) => entry.mutability === "immutable")
  .map(([table]) => table);
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
for (const table of immutableTables) {
  const quoted = `["\`\\[]?${escapeRegExp(table)}["\`\\]]?`;
  if (!new RegExp(`\\bBEFORE\\s+UPDATE\\s+ON\\s+${quoted}\\b`, "i").test(allMigrationSql)) {
    violations.push(`migration: immutable table ${table} lacks a BEFORE UPDATE guard`);
  }
  if (!new RegExp(`\\bBEFORE\\s+DELETE\\s+ON\\s+${quoted}\\b`, "i").test(allMigrationSql)) {
    violations.push(`migration: immutable table ${table} lacks a BEFORE DELETE guard`);
  }
  const migrationMutation = new RegExp(
    `\\b(?:UPDATE\\s+${quoted}|DELETE\\s+FROM\\s+${quoted}|` +
    `REPLACE\\s+(?:INTO\\s+)?${quoted}|DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${quoted})\\b`,
    "i",
  );
  if (migrationMutation.test(allMigrationSql)) {
    violations.push(`migration: forbidden destructive statement targets immutable table ${table}`);
  }
}


for (const file of sourceFiles) {
  const source = await Bun.file(file).text();
  const fileRel = rel(file);
  let checkedSource = source;
  if (fileRel === "storage/libsql.ts") {
    const erasureStatement = "DELETE FROM events WHERE session_id=?";
    const requiredGuards = [
      "async eraseIndependentSession", "DROP TRIGGER events_no_delete",
      "CREATE TRIGGER events_no_delete BEFORE DELETE ON events",
      "DROP TRIGGER context_no_delete", "CREATE TRIGGER context_no_delete BEFORE DELETE ON context_records",
    ];
    if (source.split(erasureStatement).length !== 2 || requiredGuards.some((marker) => !source.includes(marker))) {
      violations.push("storage/libsql.ts: scoped erasure must retain its exact audited statement and transactional immutable guards");
    } else checkedSource = source.replace(erasureStatement, "AUDITED_PHYSICAL_SESSION_ERASURE");
  }
  for (const table of immutableTables) {
    const target = `(?:["\`\\[])?(?:main\\s*\\.\\s*)?${escapeRegExp(table)}(?:["\`\\]])?`;
    const destructive = new RegExp(
      `\\b(?:UPDATE\\s+(?:OR\\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)\\s+)?${target}|` +
      `DELETE\\s+FROM\\s+${target}|REPLACE\\s+(?:INTO\\s+)?${target})\\b`,
      "i",
    );
    if (destructive.test(checkedSource)) violations.push(`${fileRel}: forbidden mutation of immutable table ${table}`);
    const insert = new RegExp(
      `\\bINSERT\\s+(?:OR\\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)\\s+)?INTO\\s+${target}\\b`,
      "i",
    );
    if (insert.test(source) && !adapterFiles.has(fileRel)) {
      violations.push(`${fileRel}: immutable table ${table} may be inserted only by its storage adapter`);
    }
    const mutatingUpsert = new RegExp(
      `\\bINSERT[\\s\\S]{0,600}?INTO\\s+${target}[\\s\\S]{0,600}?` +
      "ON\\s+CONFLICT[\\s\\S]{0,300}?DO\\s+UPDATE\\b",
      "i",
    );
    if (mutatingUpsert.test(source)) violations.push(`${fileRel}: forbidden mutating upsert of immutable table ${table}`);
  }
}

// Declaration emission is stronger than source-import grepping: if an adapter
// accidentally exposes Client/Row/etc. in an exported signature, TypeScript
// emits an SDK module reference even though its private implementation import is
// otherwise legal.
const declarationDirectory = await mkdtemp(join(tmpdir(), "agencity-architecture-"));
try {
  const tsc = resolve(root, "node_modules/.bin/tsc");
  if (!await exists(tsc)) {
    violations.push("declarations: node_modules/.bin/tsc is missing; run bun install");
  } else {
    const child = Bun.spawn([
      tsc,
      "--project", resolve(root, "tsconfig.json"),
      "--emitDeclarationOnly",
      "--declaration",
      "--declarationMap", "false",
      "--outDir", declarationDirectory,
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      violations.push(`declarations: TypeScript emission failed\n${[stdout, stderr].filter(Boolean).join("\n").trim()}`);
    } else {
      const declarations = await walk(resolve(declarationDirectory, "src"), (name) => name.endsWith(".d.ts"));
      for (const declaration of declarations) {
        const source = await Bun.file(declaration).text();
        for (const imported of source.matchAll(importSpecifier)) {
          if (sdkModule.test(imported[1]!)) {
            violations.push(`declarations/${rel(declaration, resolve(declarationDirectory, "src"))}: public type leaks ${imported[1]}`);
          }
        }
      }
    }
  }
} finally {
  await rm(declarationDirectory, { recursive: true, force: true });
}

if (violations.length) {
  console.error(`Architecture check failed (${violations.length}):\n${violations.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `Architecture check passed: ${sourceFiles.length} source modules, ` +
  `${Object.keys(expectedExports).length} exports, ${migrationFiles.length} migration(s), ` +
  `${classifications.size} classified tables; adapter/type/canonical boundaries intact.`,
);

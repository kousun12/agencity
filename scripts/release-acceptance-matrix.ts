type Status = "PASS" | "FAIL" | "SKIP";
interface Row { readonly gate: string; readonly status: Status; readonly detail: string }

const rows: Row[] = [];
let failed = false;

async function run(gate: string, command: string[], detail: string): Promise<void> {
  const child = Bun.spawn(command, { cwd: new URL("..", import.meta.url).pathname, stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
  const code = await child.exited;
  const status: Status = code === 0 ? "PASS" : "FAIL";
  rows.push({ gate, status, detail });
  if (status === "FAIL") failed = true;
}

await run("deterministic installed acceptance", ["bun", "run", "test:acceptance"], "isolated bun link, fixture provider, recovery and satellite paths");

if (process.env.AGENCITY_ACCEPTANCE_REAL_PROVIDER === "1") {
  if (process.env.OPENAI_API_KEY && process.env.AGENCITY_ACCEPTANCE_REAL_MODEL) {
    await run("real OpenAI-compatible provider", ["bun", "run", "test:acceptance:external"], "credential-gated live smoke");
  } else {
    rows.push({ gate: "real OpenAI-compatible provider", status: "FAIL", detail: "opted in but OPENAI_API_KEY or AGENCITY_ACCEPTANCE_REAL_MODEL is missing" });
    failed = true;
  }
} else rows.push({ gate: "real OpenAI-compatible provider", status: "SKIP", detail: "set AGENCITY_ACCEPTANCE_REAL_PROVIDER=1 with credentials and model" });

if (process.env.TURSO_SYNC_SERVER_BIN) await run("official Turso Sync server", ["bun", "run", "test:turso-official"], "external version-matched binary");
else rows.push({ gate: "official Turso Sync server", status: "SKIP", detail: "TURSO_SYNC_SERVER_BIN is unset" });

if (process.env.AGENCITY_TURSO_SMOKE === "1") {
  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) await run("real Turso Cloud", ["bun", "test", "test/slice4/cloud-smoke.test.ts"], "disposable credential-gated database");
  else {
    rows.push({ gate: "real Turso Cloud", status: "FAIL", detail: "opted in but TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is missing" });
    failed = true;
  }
} else rows.push({ gate: "real Turso Cloud", status: "SKIP", detail: "set AGENCITY_TURSO_SMOKE=1 with disposable credentials" });

console.log("\nRelease acceptance matrix");
for (const row of rows) console.log(`${row.status.padEnd(4)}  ${row.gate} — ${row.detail}`);
process.exitCode = failed ? 1 : 0;

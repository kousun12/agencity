import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  LibSqlStorage,
  ShellExecutor,
  assertReadonlySql,
  containsBrokeredSecret,
  environmentWithoutSecrets,
  isSensitiveEnvironmentKey,
  scrubJson,
  scrubText,
} from "../../src/index.ts";
import {
  makeTempRuntime,
  openTempStorage,
  removeTempRuntime,
  seedSession,
  type TempRuntime,
} from "../helpers.ts";

const temps: TempRuntime[] = [];
const originalSecret = process.env.AGENCITY_TEST_API_KEY;
const originalHome = process.env.HOME;
afterEach(async () => {
  if (originalSecret === undefined) delete process.env.AGENCITY_TEST_API_KEY;
  else process.env.AGENCITY_TEST_API_KEY = originalSecret;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

describe("read-only analytical SQL", () => {
  test("accepts parameterized reads and a narrow metadata pragma", () => {
    expect(() => assertReadonlySql("SELECT type FROM events WHERE session_id = ?"))
      .not.toThrow();
    expect(() => assertReadonlySql("WITH selected AS (SELECT 1 AS n) SELECT n FROM selected"))
      .not.toThrow();
    expect(() => assertReadonlySql("EXPLAIN SELECT * FROM events"))
      .not.toThrow();
    expect(() => assertReadonlySql("PRAGMA table_info(events)"))
      .not.toThrow();
  });

  test.each([
    "INSERT INTO events(id) VALUES ('x')",
    "UPDATE events SET producer='attacker'",
    "DELETE FROM events",
    "WITH victim AS (SELECT 1) DELETE FROM events",
    "/* innocent */ DROP TABLE events",
    "SELECT 1; UPDATE events SET producer='attacker'",
    "PRAGMA writable_schema=ON",
    "PRAGMA journal_mode=WAL",
    "ATTACH DATABASE '/tmp/stolen.db' AS stolen",
    "VACUUM INTO '/tmp/export.db'",
    "SELECT * FROM outbox",
    "SELECT * FROM snapshots",
    "SELECT * FROM sync_reconciliations",
    "SELECT * FROM workspace_replica_status",
    "SELECT * FROM data_manifests",
    "SELECT * FROM schema_migrations",
    "SELECT sql FROM sqlite_schema",
    "SELECT * FROM sqlite_master",
    "SELECT * FROM sqlite_sequence",
    "PRAGMA table_info(sqlite_schema)",
  ])("rejects mutation, multi-statement, dangerous pragma, or private-table SQL: %s", (sql) => {
    expect(() => assertReadonlySql(sql)).toThrow(/read-only|private/i);
  });

  test("treats interpolation as a value even when it contains executable SQL", async () => {
    const temp = await makeTempRuntime("agencity-sql-");
    temps.push(temp);
    const storage = await openTempStorage(temp);
    const { sessionId } = await seedSession(storage);
    const attack = `${sessionId}' OR 1=1; DELETE FROM events; --`;
    expect(await storage.readonlyQuery({
      sql: "SELECT id FROM events WHERE session_id = ?",
      args: [attack],
    })).toEqual([]);
    expect(await storage.loadEvents(sessionId)).toHaveLength(1);
    storage.close();
  });


  test("bounds analytical result rows", async () => {
    const temp = await makeTempRuntime("agencity-sql-limit-");
    temps.push(temp);
    const storage = await openTempStorage(temp);
    await expect(storage.readonlyQuery({
      sql: `WITH RECURSIVE numbers(n) AS (
        VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 1001
      ) SELECT n FROM numbers`,
      args: [],
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    storage.close();
  });

  test("private operational tables remain inaccessible after they contain data", async () => {
    const temp = await makeTempRuntime("agencity-private-sql-");
    temps.push(temp);
    const storage: LibSqlStorage = await openTempStorage(temp);
    await seedSession(storage);
    for (const table of ["outbox", "snapshots", "sync_quarantine", "sync_reconciliations", "workspace_replica_status", "data_manifests", "schema_migrations"]) {
      await expect(storage.readonlyQuery({ sql: `SELECT * FROM ${table}`, args: [] }))
        .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    storage.close();
  });
});

describe("brokered secret handling", () => {
  test("recognizes, strips, detects, and redacts credential material", () => {
    const secret = "test-secret-material-4bc2";
    process.env.AGENCITY_TEST_API_KEY = secret;
    const safe = environmentWithoutSecrets({
      PATH: "/bin",
      AGENCITY_TEST_API_KEY: secret,
      SERVICE_AUTH_TOKEN: "other",
      ORDINARY_SETTING: "visible",
    });
    expect(safe).toEqual({ PATH: "/bin", ORDINARY_SETTING: "visible" });
    expect(isSensitiveEnvironmentKey("OPENAI_API_KEY")).toBe(true);
    expect(isSensitiveEnvironmentKey("service_password")).toBe(true);
    expect(isSensitiveEnvironmentKey("ordinary_setting")).toBe(false);
    expect(containsBrokeredSecret({ nested: ["prefix", `${secret}:suffix`] })).toBe(true);
    expect(containsBrokeredSecret({ credentialHandle: "opaque://model/default" })).toBe(false);
    expect(scrubText(`before ${secret} after`)).toBe("before [REDACTED] after");
    expect(scrubJson({
      apiKey: "ordinary-provider-label",
      token: "pagination-cursor",
      auth: { mode: "oauth" },
      nested: { note: `contains ${secret}` },
      okay: 1,
    })).toEqual({
      apiKey: "ordinary-provider-label",
      token: "pagination-cursor",
      auth: { mode: "oauth" },
      nested: { note: "contains [REDACTED]" },
      okay: 1,
    });
  });

  test("rejects actual known secret values without corrupting benign key names", async () => {
    const secret = "canonical-secret-value-54ae";
    process.env.AGENCITY_TEST_API_KEY = secret;
    const temp = await makeTempRuntime("agencity-secret-canonical-");
    temps.push(temp);
    const storage = await openTempStorage(temp);
    const { sessionId, branchId } = await seedSession(storage);
    await storage.appendEvents([{
      sessionId, branchId, type: "MessageAppended", producer: "client",
      idempotencyKey: "benign-token-payload",
      payload: { messageId: "benign", role: "user", content: "token and auth are domain words" },
    }]);
    await expect(storage.appendEvents([{
      sessionId, branchId, type: "MessageAppended", producer: "client",
      idempotencyKey: "actual-secret-payload",
      payload: { messageId: "secret", role: "user", content: `leak:${secret}` },
    }])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const durable = JSON.stringify(await storage.loadEvents(sessionId));
    expect(durable).toContain("token and auth are domain words");
    expect(durable).not.toContain(secret);
    storage.close();
  });

});


describe("shell environment", () => {
  test("does not invoke a login shell that can reintroduce stripped secrets", async () => {
    const temp = await makeTempRuntime("agencity-shell-profile-");
    temps.push(temp);
    const home = join(temp.directory, "home");
    await mkdir(home, { recursive: true });
    await mkdir(temp.workspaceRoot, { recursive: true });
    await Bun.write(join(home, ".profile"), "export AGENCITY_PROFILE_API_KEY=reintroduced-by-profile\n");
    process.env.HOME = home;
    delete process.env.AGENCITY_PROFILE_API_KEY;
    const executor = new ShellExecutor(temp.workspaceRoot);
    const execution = await executor.execute({
      effectId: "shell-no-login",
      sessionId: "session",
      branchId: "main",
      executor: "shell",
      operation: "run",
      input: { command: 'printf "${AGENCITY_PROFILE_API_KEY:-absent}"' },
      idempotencyKey: "shell-no-login",
      idempotent: false,
      attempt: 1,
    }, { signal: new AbortController().signal });
    expect(execution).toMatchObject({ outcome: "succeeded", output: { stdout: "absent" } });
  });
});

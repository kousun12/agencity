import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibSqlStorage } from "../../src/storage/index.ts";
import { projectEvents, type AgentEvent } from "../../src/domain/index.ts";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("current event schema cutover", () => {
  test.each([1, 2, 3, 4, 5])("rejects version-%d workspace events before applying migrations or deleting data", async (schemaVersion) => {
    directory = await mkdtemp(join(tmpdir(), "ag-schema-cutover-"));
    const url = `file:${directory}/agent.db`;
    const raw = createClient({ url });
    await raw.execute("CREATE TABLE events(schema_version INTEGER NOT NULL, retained_text TEXT NOT NULL)");
    await raw.execute({
      sql: "INSERT INTO events(schema_version,retained_text) VALUES(?,?)",
      args: [schemaVersion, "retain me"],
    });
    raw.close();

    const storage = new LibSqlStorage({ url });
    await expect(storage.migrate()).rejects.toThrow(`pre-cutover event schema version(s) ${schemaVersion}`);
    storage.close();

    const retained = createClient({ url });
    const data = await retained.execute("SELECT schema_version,retained_text FROM events");
    const tables = await retained.execute(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    expect(data.rows.map(row => ({
      schemaVersion: Number(row.schema_version),
      retainedText: String(row.retained_text),
    }))).toEqual([{ schemaVersion, retainedText: "retain me" }]);
    expect(tables.rows.map(row => String(row.name))).toEqual(["events"]);
    retained.close();
  });

  test.each([1, 2, 3, 4, 5])("rejects version-%d events before payload projection", (schemaVersion) => {
    const event = {
      cursor: "1",
      id: `legacy-${schemaVersion}`,
      sessionId: "legacy-session",
      branchId: "legacy-branch",
      causationId: null,
      correlationId: null,
      type: "SessionCreated",
      schemaVersion,
      committedAt: "2026-08-08T00:00:00.000Z",
      producer: "supervisor",
      idempotencyKey: null,
      payload: {
        workspaceId: "legacy-workspace",
        initialBranchId: "legacy-branch",
        model: { provider: "echo", model: "echo", reasoningEffort: "provider-default" },
        budget: {},
      },
      originDeviceId: "legacy-device",
      originSequence: 1,
      streamParentId: null,
    } as AgentEvent;
    expect(() => projectEvents([event])).toThrow(/Reset local Agencity state/);
  });
});

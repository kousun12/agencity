import { afterEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DependencyFailureError,
  LocalArtifactStore,
  type ArtifactReference,
} from "../../src/index.ts";
import {
  makeTempRuntime,
  removeTempRuntime,
  type TempRuntime,
} from "../helpers.ts";

const temps: TempRuntime[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(removeTempRuntime));
});

async function setup(): Promise<{ temp: TempRuntime; store: LocalArtifactStore }> {
  const temp = await makeTempRuntime("agencity-artifacts-");
  temps.push(temp);
  return { temp, store: new LocalArtifactStore(temp.artifactDirectory) };
}

async function filesBelow(path: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else result.push(child);
    }
  };
  await visit(path);
  return result;
}

describe("local content-addressed artifacts", () => {
  test("deduplicates concurrent identical writes by content rather than source or media type", async () => {
    const { temp, store } = await setup();
    const content = "identical durable bytes\n".repeat(1_000);
    const references = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.put(content, { mediaType: index % 2 ? "text/plain" : "application/x-test" })));
    expect(new Set(references.map((reference) => reference.artifactId)).size).toBe(1);
    expect(new Set(references.map((reference) => reference.digest)).size).toBe(1);
    expect(new Set(references.map((reference) => reference.size)).size).toBe(1);
    expect(await filesBelow(temp.artifactDirectory)).toHaveLength(1);
    expect(new TextDecoder().decode(await store.resolve(references[0]!))).toBe(content);
  });

  test("checks size and digest on every resolve, range-read, and export", async () => {
    const { temp, store } = await setup();
    const reference = await store.put("0123456789", { mediaType: "text/plain" });
    expect(new TextDecoder().decode(await store.readRange(reference, 2, 7))).toBe("23456");
    await store.export(reference, join(temp.directory, "export", "copy.txt"));
    expect(await Bun.file(join(temp.directory, "export", "copy.txt")).text()).toBe("0123456789");

    const objectPath = join(temp.artifactDirectory, reference.digest.slice(0, 2), reference.digest.slice(2));
    await Bun.write(objectPath, "tampered!");
    expect(await store.verify(reference)).toBe(false);
    await expect(store.resolve(reference)).rejects.toBeInstanceOf(DependencyFailureError);
    await expect(store.readRange(reference, 0)).rejects.toBeInstanceOf(DependencyFailureError);
    await expect(store.export(reference, join(temp.directory, "must-not-exist")))
      .rejects.toBeInstanceOf(DependencyFailureError);
  });

  test("requires artifactId to agree with its digest, not merely point at digest-shaped bytes", async () => {
    const { store } = await setup();
    const reference = await store.put("bound identity");
    const forged: ArtifactReference = {
      ...reference,
      artifactId: `sha256:${"0".repeat(64)}`,
    };
    expect(await store.verify(forged)).toBe(false);
    await expect(store.resolve(forged)).rejects.toBeInstanceOf(DependencyFailureError);
  });

  test("delete and missing content surface explicit dependency failure", async () => {
    const { store } = await setup();
    const reference = await store.put("ephemeral physical placement");
    await store.delete(reference);
    expect(await store.verify(reference)).toBe(false);
    await expect(store.resolve(reference)).rejects.toMatchObject({
      code: "DEPENDENCY_FAILURE",
      details: { artifactId: reference.artifactId },
    });
  });
});

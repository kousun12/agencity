import { describe, expect, test } from "bun:test";
import {
  SCRATCH_LIMITS,
  ScratchKeyPolicyError,
  createScratchProxy,
  filterScratchCheckpoint,
  serializeScratch,
  validateScratchCheckpoint,
} from "../../src/index.ts";

describe("bounded console scratch", () => {
  test("provides a null-prototype direct object with bounded safe keys", () => {
    const scope = createScratchProxy();
    expect(Object.getPrototypeOf(scope.object)).toBeNull();
    scope.object.rows = [1, 2];
    expect(scope.object.rows).toEqual([1, 2]);
    delete scope.object.rows;
    expect("rows" in scope.object).toBe(false);
    expect(() => {
      (scope.object as any).__proto__ = {};
    }).toThrow(ScratchKeyPolicyError);
    expect(() => Object.defineProperty(scope.object, "computed", { get: () => 1 }))
      .toThrow(/accessor/i);
    expect(() => Reflect.set(scope.object, Symbol("bad"), 1)).toThrow(/symbol/i);
    expect(() => Reflect.set(scope.object, "x".repeat(SCRATCH_LIMITS.maxKeyBytes + 1), 1))
      .toThrow(/UTF-8 bytes/i);
    scope.object.mutable = 1;
    Object.defineProperty(scope.object, "mutable", { value: 2 });
    expect(scope.object.mutable).toBe(2);
    expect(() => Object.defineProperty(scope.object, "fixed", { value: 1 }))
      .toThrow(/configurable/i);
    expect(() => Object.preventExtensions(scope.object)).toThrow(/extensible/i);
    Object.defineProperty(scope.object, "temporary", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: 1,
    });
    scope.clear();
    expect(Reflect.ownKeys(scope.object)).toEqual([]);
    for (let index = 0; index < SCRATCH_LIMITS.maxKeys; index++) {
      scope.object[`k${index}`] = index;
    }
    expect(() => { scope.object.overflow = true; }).toThrow(/64 properties/i);
    scope.clear();
    expect(Reflect.ownKeys(scope.object)).toEqual([]);
  });

  test("tracks writes and conservatively tracks nested mutable access", () => {
    const scope = createScratchProxy();
    expect(scope.dirty).toBe(false);

    scope.object.count = 1;
    expect(scope.dirty).toBe(true);
    scope.markClean();
    expect(scope.dirty).toBe(false);

    void scope.object.count;
    delete scope.object.missing;
    expect(scope.dirty).toBe(false);

    scope.object.index = { files: ["a.ts"] };
    scope.markClean();
    void scope.object.index;
    expect(scope.dirty).toBe(true);

    scope.markClean();
    Object.getOwnPropertyDescriptor(scope.object, "index");
    expect(scope.dirty).toBe(true);

    scope.markClean();
    scope.clear();
    expect(scope.dirty).toBe(true);
    scope.markClean();
    scope.clear();
    expect(scope.dirty).toBe(false);
  });

  test("serializes eligible siblings independently without invoking hooks", () => {
    let getterCalls = 0;
    let toJsonCalls = 0;
    let iteratorCalls = 0;
    const cyclic: any = { name: "cycle" };
    cyclic.self = cyclic;
    const withGetter = Object.create(null);
    Object.defineProperty(withGetter, "unsafe", {
      enumerable: true,
      get() {
        getterCalls++;
        return "secret";
      },
    });
    const withHooks = {
      value: 1,
      toJSON() {
        toJsonCalls++;
        return "unsafe";
      },
      [Symbol.iterator]() {
        iteratorCalls++;
        return [][Symbol.iterator]();
      },
    };
    const source = Object.create(null);
    source.z = { nested: [1, true, null] };
    source.function = () => 1;
    source.cycle = cyclic;
    source.getter = withGetter;
    source.hooks = withHooks;
    Object.defineProperty(source, "topGetter", {
      enumerable: true,
      get() {
        getterCalls++;
        return 1;
      },
    });

    const checkpoint = serializeScratch(source);
    expect(checkpoint.savedNames).toEqual(["z"]);
    expect(checkpoint.values.z).toEqual({ nested: [1, true, null] });
    expect(checkpoint.skipped).toEqual([
      { name: "cycle", reason: "cyclic" },
      { name: "function", reason: "unsupported_type" },
      { name: "getter", reason: "accessor" },
      { name: "hooks", reason: "unsupported_type" },
      { name: "topGetter", reason: "accessor" },
    ]);
    expect(getterCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
    expect(iteratorCalls).toBe(0);
    expect(validateScratchCheckpoint(checkpoint)).toEqual(checkpoint);
  });

  test("uses deterministic canonical encoding, bounds, and secret filtering", () => {
    const left = Object.create(null);
    left.b = { y: 2, x: 1 };
    left.a = "safe";
    const right = Object.create(null);
    right.a = "safe";
    right.b = { x: 1, y: 2 };
    const first = serializeScratch(left);
    const second = serializeScratch(right);
    expect(first.canonicalJson).toBe(second.canonicalJson);
    expect(first.digest).toBe(second.digest);
    expect(first.byteLength).toBe(new TextEncoder().encode(first.canonicalJson).byteLength);

    const filtered = filterScratchCheckpoint(first, (name) => name === "a");
    expect(filtered.savedNames).toEqual(["b"]);
    expect(filtered.skipped).toContainEqual({ name: "a", reason: "secret_rejected" });

    const deep: any = {};
    let cursor = deep;
    for (let index = 0; index <= SCRATCH_LIMITS.maxDepth; index++) {
      cursor.next = {};
      cursor = cursor.next;
    }
    expect(serializeScratch({ deep }).skipped)
      .toContainEqual({ name: "deep", reason: "depth_limit" });
    expect(serializeScratch({ huge: "x".repeat(SCRATCH_LIMITS.maxValueBytes + 1) }).skipped)
      .toContainEqual({ name: "huge", reason: "value_too_large" });
    const totalBounded = serializeScratch({
      a: "x".repeat(SCRATCH_LIMITS.maxValueBytes - 10),
      b: "y".repeat(SCRATCH_LIMITS.maxValueBytes - 10),
    });
    expect(totalBounded.byteLength).toBeLessThanOrEqual(SCRATCH_LIMITS.maxCheckpointBytes);
    expect(totalBounded.skipped).toContainEqual({
      name: "b",
      reason: "checkpoint_too_large",
    });
  });

  test("applies traversal budgets across the whole checkpoint", () => {
    const nodeBounded = serializeScratch({
      a: Array.from({ length: 6_000 }, () => ({})),
      b: Array.from({ length: 6_000 }, () => ({})),
    });
    expect(nodeBounded.savedNames).toEqual(["a"]);
    expect(nodeBounded.skipped).toContainEqual({
      name: "b",
      reason: "node_limit",
    });

    const makeWideObject = () => Object.fromEntries(
      Array.from({ length: 6_000 }, (_, index) => [`key${index}`, index]),
    );
    const propertyBounded = serializeScratch({
      a: makeWideObject(),
      b: makeWideObject(),
    });
    expect(propertyBounded.savedNames).toEqual(["a"]);
    expect(propertyBounded.skipped).toContainEqual({
      name: "b",
      reason: "property_limit",
    });
  });
});

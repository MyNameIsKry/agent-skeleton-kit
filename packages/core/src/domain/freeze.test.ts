import { describe, expect, it } from "vitest";
import { deepFreeze } from "./freeze.js";

describe("deepFreeze", () => {
  it("freezes nested objects and arrays", () => {
    const value = deepFreeze({ a: { b: [1, { c: 2 }] } });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(Object.isFrozen(value.a.b[1])).toBe(true);
  });

  it("freezes the children of an object that is already shallow-frozen", () => {
    const child = { mutable: true };
    const parent = Object.freeze({ child });
    deepFreeze(parent);
    expect(Object.isFrozen(child)).toBe(true);
  });

  it("handles cyclic objects", () => {
    const a: { self?: unknown; list: unknown[] } = { list: [] };
    a.self = a;
    a.list.push(a);
    expect(() => deepFreeze(a)).not.toThrow();
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.list)).toBe(true);
  });

  it("returns primitives unchanged", () => {
    expect(deepFreeze(3)).toBe(3);
    expect(deepFreeze(null)).toBeNull();
  });
});

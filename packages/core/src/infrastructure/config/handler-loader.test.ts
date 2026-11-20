import path from "node:path";
import { describe, expect, it } from "vitest";
import { isInside } from "./handler-loader.js";

describe("isInside", () => {
  const root = path.resolve("/srv/tenant");

  it("accepts paths strictly inside the root", () => {
    expect(isInside(root, path.join(root, "tools", "a.js"))).toBe(true);
  });

  it("accepts in-tenant names that only start with '..'", () => {
    expect(isInside(root, path.join(root, "..helpers.js"))).toBe(true);
    expect(isInside(root, path.join(root, "tools", "..x", "a.js"))).toBe(true);
  });

  it("rejects the root itself, parents, siblings, and prefix look-alikes", () => {
    expect(isInside(root, root)).toBe(false);
    expect(isInside(root, path.dirname(root))).toBe(false);
    expect(isInside(root, path.resolve("/srv/other/a.js"))).toBe(false);
    expect(isInside(root, path.resolve("/srv/tenant-evil/a.js"))).toBe(false);
  });
});

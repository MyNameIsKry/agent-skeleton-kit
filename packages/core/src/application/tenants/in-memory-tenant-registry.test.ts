import { describe, expect, it } from "vitest";
import { ConfigurationError, TenantNotFoundError } from "../../domain/errors.js";
import type { TenantConfig } from "../../domain/tenant.js";
import { InMemoryTenantRegistry } from "./in-memory-tenant-registry.js";

const config = (id: string, toolNames: string[] = []): TenantConfig => ({
  id,
  displayName: `Tenant ${id}`,
  description: `Description of ${id}`,
  systemPrompt: `Secret prompt of ${id}`,
  retrieval: { topK: 5, minScore: 0.6 },
  chunking: { maxTokens: 400, overlap: 50 },
  tools: toolNames.map((name) => ({
    name,
    description: `Does ${name}`,
    parameters: { type: "object" },
    handlerPath: `/srv/${id}/tools/${name}.js`,
  })),
  rootDir: `/srv/${id}`,
});

describe("InMemoryTenantRegistry", () => {
  it("resolves a known tenant to a frozen context", () => {
    const registry = new InMemoryTenantRegistry([config("tenant-a", ["tool_a"])]);
    const ctx = registry.resolve("tenant-a");

    expect(ctx.tenantId).toBe("tenant-a");
    expect(ctx.config.id).toBe("tenant-a");
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.config.tools[0])).toBe(true);
    expect(() => {
      (ctx as { tenantId: string }).tenantId = "tenant-b";
    }).toThrow(TypeError);
  });

  it("returns the same context object on every resolve", () => {
    const registry = new InMemoryTenantRegistry([config("tenant-a")]);
    expect(registry.resolve("tenant-a")).toBe(registry.resolve("tenant-a"));
  });

  it("throws TenantNotFoundError for unknown ids, including prototype keys", () => {
    const registry = new InMemoryTenantRegistry([config("tenant-a")]);
    for (const id of ["tenant-b", "", "__proto__", "constructor", "TENANT-A"]) {
      expect(() => registry.resolve(id)).toThrow(TenantNotFoundError);
    }
  });

  it("lists public summaries without prompts or paths, sorted by id", () => {
    const registry = new InMemoryTenantRegistry([config("tenant-b", ["tool_b"]), config("tenant-a")]);
    expect(registry.list()).toEqual([
      { id: "tenant-a", displayName: "Tenant tenant-a", description: "Description of tenant-a", tools: [] },
      {
        id: "tenant-b",
        displayName: "Tenant tenant-b",
        description: "Description of tenant-b",
        tools: [{ name: "tool_b", description: "Does tool_b" }],
      },
    ]);
    expect(JSON.stringify(registry.list())).not.toMatch(/Secret prompt|\/srv\//);
  });

  it("rejects duplicate tenant ids", () => {
    expect(() => new InMemoryTenantRegistry([config("tenant-a"), config("tenant-a")])).toThrow(
      ConfigurationError,
    );
  });
});

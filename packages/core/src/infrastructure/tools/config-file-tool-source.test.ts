import { describe, expect, it } from "vitest";
import { InMemoryTenantRegistry } from "../../application/tenants/in-memory-tenant-registry.js";
import type { TenantConfig, ToolDefinition } from "../../domain/tenant.js";
import type { LoadedTenant, LoadedTool, ToolHandler } from "../../domain/tool.js";
import { ConfigFileToolSource } from "./config-file-tool-source.js";

const definition = (name: string): ToolDefinition => ({
  name,
  description: `Does ${name}`,
  parameters: { type: "object", additionalProperties: false },
  handlerPath: `/srv/tenants/secret/${name}.ts`,
});

const config = (id: string, tools: ToolDefinition[]): TenantConfig => ({
  id,
  displayName: id,
  description: id,
  systemPrompt: id,
  retrieval: { topK: 5, minScore: 0.6 },
  chunking: { maxTokens: 400, overlap: 50 },
  tools,
  rootDir: `/srv/${id}`,
});

const loaded = (id: string, names: string[]): LoadedTenant => {
  const tools = new Map<string, LoadedTool>();
  for (const name of names) {
    const handler: ToolHandler = () => Promise.resolve({ from: `${id}/${name}` });
    tools.set(name, { definition: definition(name), handler, validateArgs: () => ({ ok: true }) });
  }
  return { config: config(id, names.map(definition)), tools };
};

const tenants = [loaded("tenant-a", ["lookup", "create"]), loaded("tenant-b", ["refund"])];
const registry = new InMemoryTenantRegistry([...tenants.map((t) => t.config), config("tenant-c", [])]);
const source = new ConfigFileToolSource(tenants);

describe("ConfigFileToolSource", () => {
  it("returns each tenant's own tools with the loader's handler and validator", async () => {
    const a = source.tools(registry.resolve("tenant-a"));
    expect(a.map((t) => t.spec.name)).toEqual(["lookup", "create"]);
    expect(a[0]?.validateArgs({})).toEqual({ ok: true });
    const ctx = {} as Parameters<ToolHandler>[1];
    expect(await a[0]?.run({}, ctx)).toEqual({ from: "tenant-a/lookup" });
    expect(source.tools(registry.resolve("tenant-b")).map((t) => t.spec.name)).toEqual(["refund"]);
  });

  it("returns no tools for a tenant without any, or one it was not built with", () => {
    expect(source.tools(registry.resolve("tenant-c"))).toEqual([]);
  });

  it("sends the model name, description, and parameters only, never the handler path", () => {
    const [lookup] = source.tools(registry.resolve("tenant-a"));
    expect(lookup?.spec).toEqual({
      name: "lookup",
      description: "Does lookup",
      parameters: { type: "object", additionalProperties: false },
    });
    expect(JSON.stringify(lookup?.spec)).not.toContain("/srv/tenants/secret");
  });

  it("returns frozen tools", () => {
    const tools = source.tools(registry.resolve("tenant-a"));
    expect(Object.isFrozen(tools)).toBe(true);
    expect(tools.every((t) => Object.isFrozen(t) && Object.isFrozen(t.spec))).toBe(true);
  });
});

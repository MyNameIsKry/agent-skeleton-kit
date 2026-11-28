import { describe, expect, it } from "vitest";
import { describeTenantDataStoreContract } from "../../test/support/tenant-data-store-contract.js";
import { InMemoryTenantRegistry } from "../application/tenants/in-memory-tenant-registry.js";
import type { TenantConfig } from "../domain/tenant.js";
import { InMemoryTenantDataStoreFactory } from "./in-memory-tenant-data-store.js";

const config = (id: string): TenantConfig => ({
  id,
  displayName: id,
  description: id,
  systemPrompt: id,
  retrieval: { topK: 5, minScore: 0.6 },
  chunking: { maxTokens: 400, overlap: 50 },
  tools: [],
  rootDir: `/srv/${id}`,
});
const registry = new InMemoryTenantRegistry([config("tenant-a"), config("tenant-b")]);
const tenantA = registry.resolve("tenant-a");
const tenantB = registry.resolve("tenant-b");

const factory = new InMemoryTenantDataStoreFactory();
describeTenantDataStoreContract("InMemoryTenantDataStoreFactory", () => ({
  factory,
  alpha: tenantA,
  beta: tenantB,
}));

describe("InMemoryTenantDataStoreFactory", () => {
  it("exposes every tenant's records for assertions, tagged with the tenant", async () => {
    const own = new InMemoryTenantDataStoreFactory();
    await own.forTenant(tenantA).insert("tickets", { ticketId: "IT-1" });
    await own.forTenant(tenantB).insert("tickets", { ticketId: "IT-2" });
    expect(own.records.map((r) => [r.tenantId, r.collection, r.data])).toEqual([
      ["tenant-a", "tickets", { ticketId: "IT-1" }],
      ["tenant-b", "tickets", { ticketId: "IT-2" }],
    ]);
  });

  it("does not let a key named __proto__ change a stored record's prototype", async () => {
    const own = new InMemoryTenantDataStoreFactory();
    const data = own.forTenant(tenantA);
    await data.insert("items", {
      name: "a",
      nested: JSON.parse('{"__proto__": {"polluted": true}}') as unknown,
    });
    const [stored] = own.records;
    expect(Object.getPrototypeOf(stored?.data)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

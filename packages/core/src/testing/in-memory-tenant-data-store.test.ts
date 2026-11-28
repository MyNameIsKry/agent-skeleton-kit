import { describe, expect, it } from "vitest";
import { InMemoryTenantRegistry } from "../application/tenants/in-memory-tenant-registry.js";
import { DataStoreUsageError } from "../domain/tenant-data.js";
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

describe("InMemoryTenantDataStoreFactory", () => {
  it("inserts, finds in insertion order, and updates by data fields", async () => {
    const data = new InMemoryTenantDataStoreFactory().forTenant(tenantA);
    const { id } = await data.insert("tickets", { ticketId: "IT-1", status: "open" });
    await data.insert("tickets", { ticketId: "IT-2", status: "open" });

    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect((await data.find("tickets", { status: "open" })).map((r) => r.ticketId)).toEqual(["IT-1", "IT-2"]);
    expect(await data.find("tickets", {}, 1)).toHaveLength(1);
    expect(await data.update("tickets", { ticketId: "IT-2" }, { status: "closed" })).toBe(1);
    expect(await data.findOne("tickets", { ticketId: "IT-2" })).toEqual({
      ticketId: "IT-2",
      status: "closed",
    });
  });

  it("returns copies, so callers cannot change stored records", async () => {
    const data = new InMemoryTenantDataStoreFactory().forTenant(tenantA);
    const doc = { nested: { n: 1 } };
    await data.insert("things", doc);
    doc.nested.n = 2;
    const found = await data.findOne("things", {});
    (found?.nested as { n: number }).n = 3;
    expect(await data.findOne("things", {})).toEqual({ nested: { n: 1 } });
  });

  it("keeps tenants apart", async () => {
    const factory = new InMemoryTenantDataStoreFactory();
    await factory.forTenant(tenantA).insert("tickets", { ticketId: "IT-1" });
    const beta = factory.forTenant(tenantB);
    expect(await beta.find("tickets")).toEqual([]);
    expect(await beta.update("tickets", { ticketId: "IT-1" }, { stolen: true })).toBe(0);
    expect(await beta.find("tickets", { tenantId: "tenant-a" })).toEqual([]);
  });

  it("matches like MongoDB: arrays contain the value, null matches a missing field", async () => {
    const data = new InMemoryTenantDataStoreFactory().forTenant(tenantA);
    await data.insert("items", { name: "a", tags: ["red", "blue"] });
    await data.insert("items", { name: "b", note: null });
    await data.insert("items", { name: "c" });
    expect((await data.find("items", { tags: "blue" })).map((r) => r.name)).toEqual(["a"]);
    expect((await data.find("items", { note: null })).map((r) => r.name)).toEqual(["a", "b", "c"]);
  });

  it("rejects bad collection names, operator and dotted keys, and non-scalar filter values", async () => {
    const data = new InMemoryTenantDataStoreFactory().forTenant(tenantA);
    await expect(data.insert("Bad Name", {})).rejects.toThrow(DataStoreUsageError);
    await expect(data.find("items", { $where: "true" })).rejects.toThrow(DataStoreUsageError);
    await expect(data.update("items", {}, { "a.b": 1 })).rejects.toThrow(DataStoreUsageError);
    await expect(data.find("items", { tags: ["red"] })).rejects.toThrow(DataStoreUsageError);
    await expect(data.find("items", { n: Number.NaN })).rejects.toThrow(DataStoreUsageError);
    await expect(data.find("items", {}, 0)).rejects.toThrow(DataStoreUsageError);
  });
});

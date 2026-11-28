import { describe, expect, it } from "vitest";
import { createTestToolContext, InMemoryTenantDataStoreFactory } from "../testing.js";

describe("createTestToolContext", () => {
  it("builds a frozen handler context with defaults", async () => {
    const ctx = createTestToolContext();
    expect(ctx).toMatchObject({ tenantId: "test-tenant", sessionId: "test-session" });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(ctx.signal.aborted).toBe(false);
    await ctx.data.insert("tickets", { title: "Printer" });
    expect(await ctx.data.find("tickets")).toEqual([{ title: "Printer" }]);
  });

  it("scopes data to the tenant when contexts share one factory", async () => {
    const dataStores = new InMemoryTenantDataStoreFactory();
    const a = createTestToolContext({ tenantId: "tenant-a", dataStores });
    const b = createTestToolContext({ tenantId: "tenant-b", sessionId: "s-9", dataStores });
    await a.data.insert("tickets", { title: "A" });
    expect(await b.data.find("tickets")).toEqual([]);
    expect(b.sessionId).toBe("s-9");
    expect(dataStores.records.map((r) => r.tenantId)).toEqual(["tenant-a"]);
  });
});

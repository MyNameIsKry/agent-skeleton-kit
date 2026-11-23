import { describe, expect, it, vi } from "vitest";
import { InMemoryTenantRegistry } from "../../application/tenants/in-memory-tenant-registry.js";
import type { Logger } from "../../domain/ports.js";
import type { TenantConfig } from "../../domain/tenant.js";
import type { MongoStore } from "./collections.js";
import { buildSearchPipeline, MongoVectorSearch } from "./vector-search.js";

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

/** A store whose aggregate() returns `rows` regardless of the pipeline, like a broken index. */
function storeReturning(rows: unknown[]) {
  const aggregate = vi.fn(() => ({ toArray: () => Promise.resolve(rows) }));
  const store = { db: { collection: () => ({ aggregate }) } } as unknown as MongoStore;
  return { store, aggregate };
}

const logger = () => {
  const error = vi.fn();
  return { logger: { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger, error };
};

const row = (id: string, tenantId: string, active = true) => ({
  _id: id,
  tenantId,
  active,
  source: `${tenantId}.md`,
  text: `secret text of ${tenantId}`,
  meta: {},
  score: 0.9,
});

describe("buildSearchPipeline", () => {
  it("pre-filters on tenant and active, then re-checks both with the score threshold", () => {
    const pipeline = buildSearchPipeline("tenant-a", [1, 0], { topK: 3, minScore: 0.7 });
    expect(pipeline[0]).toMatchObject({
      $vectorSearch: { limit: 3, filter: { tenantId: "tenant-a", active: true } },
    });
    expect(pipeline.at(-1)).toEqual({ $match: { tenantId: "tenant-a", active: true, score: { $gte: 0.7 } } });
  });
});

describe("MongoVectorSearch guard", () => {
  it("drops results of other tenants and inactive results, and logs ids without text", async () => {
    const { store } = storeReturning([
      row("a1", "tenant-a"),
      row("b1", "tenant-b"),
      row("a2", "tenant-a", false),
    ]);
    const { logger: log, error } = logger();
    const search = new MongoVectorSearch(store, { dimensions: 2, logger: log });

    const results = await search.search(tenantA, [1, 0], { topK: 5, minScore: 0.5 });

    expect(results.map((r) => r.id)).toEqual(["a1"]);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      { tenantId: "tenant-a", chunkId: "b1", chunkTenantId: "tenant-b", active: true },
      "Dropped a vector search result that does not belong to the requesting tenant",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret text");
  });

  it("rejects a query embedding of the wrong dimension before querying", async () => {
    const { store, aggregate } = storeReturning([]);
    const search = new MongoVectorSearch(store, { dimensions: 2, logger: logger().logger });

    await expect(search.search(tenantA, [1, 0, 0], { topK: 5, minScore: 0.5 })).rejects.toThrow(RangeError);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range topK", async () => {
    const { store } = storeReturning([]);
    const search = new MongoVectorSearch(store, { dimensions: 2, logger: logger().logger });
    await expect(search.search(tenantA, [1, 0], { topK: 0, minScore: 0.5 })).rejects.toThrow(RangeError);
    await expect(search.search(tenantA, [1, 0], { topK: 51, minScore: 0.5 })).rejects.toThrow(RangeError);
  });
});

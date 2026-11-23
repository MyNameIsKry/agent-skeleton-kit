import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "../../src/domain/ports.js";
import { MongoChunkRepository } from "../../src/infrastructure/mongo/chunk-repository.js";
import { MongoDocumentRepository } from "../../src/infrastructure/mongo/document-repository.js";
import { MongoVectorSearch } from "../../src/infrastructure/mongo/vector-search.js";
import { newChunk } from "../support/chunks.js";
import { axis, setUpTestMongo, TEST_DIMENSIONS, waitFor, type TestMongo } from "../support/mongo.js";

const logger = { error: () => undefined } as unknown as Logger;

let mongo: TestMongo;
let search: MongoVectorSearch;

beforeAll(async () => {
  mongo = await setUpTestMongo("search");
  const documents = new MongoDocumentRepository(mongo.store, mongo.clock);
  const chunks = new MongoChunkRepository(mongo.store, mongo.clock, { dimensions: TEST_DIMENSIONS });
  search = new MongoVectorSearch(mongo.store, { dimensions: TEST_DIMENSIONS, logger });

  const doc = await documents.upsertPending(mongo.alpha, { source: "handbook.md", contentHash: "h" });
  // Cosine similarity to axis(0): exact for "x", ~0.71 for "xy", 0 for "y".
  const xy = { ...newChunk(doc.id, 1, 1, "xy"), embedding: [1, 1, 0, 0] };
  await chunks.upsertMany(mongo.alpha, [newChunk(doc.id, 1, 0, "x", 0), xy, newChunk(doc.id, 1, 2, "y", 1)]);
  // An inactive, newer version of the same text must never appear.
  await chunks.upsertMany(mongo.alpha, [newChunk(doc.id, 2, 0, "x-inactive", 0)]);
  await chunks.activateVersion(mongo.alpha, doc.id, 1);

  await waitFor(
    async () => (await search.search(mongo.alpha, axis(0), { topK: 10, minScore: 0 })).length >= 3,
    "chunks to be searchable",
  );
});
afterAll(() => mongo.drop());

describe("MongoVectorSearch", () => {
  it("returns active chunks ordered by cosine similarity with source, text, and metadata", async () => {
    const results = await search.search(mongo.alpha, axis(0), { topK: 10, minScore: 0 });
    expect(results.map((r) => r.text)).toEqual(["x", "xy", "y"]);
    expect(results[0]).toMatchObject({
      tenantId: "fixture-alpha",
      source: "doc.md",
      meta: { headingPath: ["Doc"] },
    });
    // Scores are cosine similarity, not Atlas's normalized (1 + cosine) / 2.
    expect(results.map((r) => Number(r.score.toFixed(3)))).toEqual([1, 0.707, 0]);
  });

  it("drops results below minScore", async () => {
    const results = await search.search(mongo.alpha, axis(0), { topK: 10, minScore: 0.8 });
    expect(results.map((r) => r.text)).toEqual(["x"]);
  });

  it("returns at most topK results", async () => {
    expect(await search.search(mongo.alpha, axis(0), { topK: 1, minScore: 0 })).toHaveLength(1);
  });
});

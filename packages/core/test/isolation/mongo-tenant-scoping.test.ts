/**
 * Isolation property P1 (design.md section 8): for any query by tenant T, every returned chunk
 * belongs to T. Also covers repository-level scoping of documents, conversations, and tool
 * records. Needs MongoDB (see docker-compose.test.yml); never skipped.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RetrievedChunk } from "../../src/domain/chunk.js";
import type { Logger } from "../../src/domain/ports.js";
import { MongoChunkRepository } from "../../src/infrastructure/mongo/chunk-repository.js";
import { chunksOf } from "../../src/infrastructure/mongo/collections.js";
import { MongoConversationRepository } from "../../src/infrastructure/mongo/conversation-repository.js";
import { MongoDocumentRepository } from "../../src/infrastructure/mongo/document-repository.js";
import { MongoTenantDataStoreFactory } from "../../src/infrastructure/mongo/tenant-data-store.js";
import { MongoVectorSearch } from "../../src/infrastructure/mongo/vector-search.js";
import { newChunk } from "../support/chunks.js";
import { axis, setUpTestMongo, TEST_DIMENSIONS, waitFor, type TestMongo } from "../support/mongo.js";

const ALPHA_CANARY = 'The alpha canary phrase is "violet-otter-42".';
const BETA_TEXT = 'The beta canary phrase is "amber-falcon-17".';

const errors: unknown[] = [];
const logger = {
  error: (fields: unknown) => errors.push(fields),
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  child: () => logger,
} as unknown as Logger;

let mongo: TestMongo;
let search: MongoVectorSearch;
let alphaDocId: string;
let betaDocId: string;

const query = (ctx: TestMongo["alpha"], minScore = 0.5): Promise<RetrievedChunk[]> =>
  search.search(ctx, axis(0), { topK: 10, minScore });

beforeAll(async () => {
  mongo = await setUpTestMongo("isolation");
  const documents = new MongoDocumentRepository(mongo.store, mongo.clock);
  const chunks = new MongoChunkRepository(mongo.store, mongo.clock, { dimensions: TEST_DIMENSIONS });
  search = new MongoVectorSearch(mongo.store, { dimensions: TEST_DIMENSIONS, logger });

  // Both tenants store a chunk with the identical embedding, so similarity alone cannot separate them.
  const alphaDoc = await documents.upsertPending(mongo.alpha, {
    source: "alpha-handbook.md",
    contentHash: "a",
  });
  const betaDoc = await documents.upsertPending(mongo.beta, { source: "beta-guide.md", contentHash: "b" });
  alphaDocId = alphaDoc.id;
  betaDocId = betaDoc.id;
  await chunks.upsertMany(mongo.alpha, [newChunk(alphaDoc.id, 1, 0, ALPHA_CANARY, 0)]);
  await chunks.upsertMany(mongo.beta, [newChunk(betaDoc.id, 1, 0, BETA_TEXT, 0)]);
  await chunks.activateVersion(mongo.alpha, alphaDoc.id, 1);
  await chunks.activateVersion(mongo.beta, betaDoc.id, 1);

  // Wait until the index has caught up for both tenants, so a missing canary below
  // proves filtering, not indexing lag.
  await waitFor(async () => (await query(mongo.alpha)).length > 0, "alpha chunk to be searchable");
  await waitFor(async () => (await query(mongo.beta)).length > 0, "beta chunk to be searchable");
});
afterAll(() => mongo.drop());

describe("vector search tenant isolation (P1)", () => {
  it("never returns the alpha canary chunk to beta", async () => {
    const results = await query(mongo.beta, 0);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.tenantId === "fixture-beta")).toBe(true);
    expect(results.map((r) => r.text)).not.toContain(ALPHA_CANARY);
    expect(JSON.stringify(results)).not.toContain("violet-otter-42");
  });

  it("returns alpha's own canary to alpha and nothing of beta", async () => {
    const results = await query(mongo.alpha, 0);
    expect(results.map((r) => r.text)).toEqual([ALPHA_CANARY]);
  });

  it("needed no in-code guard: the database filters already isolated the tenants", () => {
    expect(errors).toEqual([]);
  });

  it("stops returning a chunk as soon as it is deactivated, before the index catches up", async () => {
    await chunksOf(mongo.store).updateOne({ docId: betaDocId }, { $set: { active: false } });
    try {
      expect(await query(mongo.beta, 0)).toEqual([]);
    } finally {
      await chunksOf(mongo.store).updateOne({ docId: betaDocId }, { $set: { active: true } });
    }
  });
});

describe("repository tenant isolation", () => {
  it("does not list or find another tenant's documents", async () => {
    const documents = new MongoDocumentRepository(mongo.store, mongo.clock);
    expect((await documents.list(mongo.beta)).map((d) => d.id)).not.toContain(alphaDocId);
    expect(await documents.findBySource(mongo.beta, "alpha-handbook.md")).toBeNull();
  });

  it("returns no history for a session id used under another tenant", async () => {
    const conversations = new MongoConversationRepository(mongo.store, mongo.clock);
    await conversations.append(mongo.alpha, "shared-session", [{ role: "user", content: "alpha secret" }]);
    expect(await conversations.recent(mongo.beta, "shared-session", 20)).toEqual([]);

    await conversations.append(mongo.beta, "shared-session", [{ role: "user", content: "beta message" }]);
    expect(await conversations.recent(mongo.alpha, "shared-session", 20)).toEqual([
      { role: "user", content: "alpha secret" },
    ]);
  });

  it("keeps tool records of each tenant invisible to the other", async () => {
    const factory = new MongoTenantDataStoreFactory(mongo.store, mongo.clock);
    const alpha = factory.forTenant(mongo.alpha);
    const beta = factory.forTenant(mongo.beta);
    await alpha.insert("tickets", { ticketId: "IT-1", owner: "alpha" });

    expect(await beta.find("tickets")).toEqual([]);
    expect(await beta.findOne("tickets", { ticketId: "IT-1" })).toBeNull();
    expect(await beta.update("tickets", { ticketId: "IT-1" }, { owner: "beta" })).toBe(0);
    // A filter on "tenantId" addresses data.tenantId, not the scoping field.
    expect(await beta.find("tickets", { tenantId: "fixture-alpha" })).toEqual([]);
    expect(await alpha.findOne("tickets", { ticketId: "IT-1" })).toEqual({
      ticketId: "IT-1",
      owner: "alpha",
    });
  });
});
